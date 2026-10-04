// src/tools/scrollPage.ts
// dirMap 一石二鸟：合法值枚举 + 方向翻译表，!dirMap[direction] 一行完成校验。
// 修复原版「四方向全部 scrollDown」bug；滚动结果不可见 -> 回显自带复查指令。
// B-4：返回值统一走 toolResult 工厂（反幻觉锚点全覆盖）。
//
// Y-3 闭环滚动（Epoch Y）：滚动从「发射后不管」升维为「发射后测量」——
// 前后帧行亮度互相关（motionEstimator）给出实际内容位移（亚行精度）、
// 方向一致性、滚动边界判决。锚点直接回答「滚了吗 / 滚对了没 / 到底了没」。
//
// W7-0（W6-5 接线收尾）：水平滚动的列亮度证据消费 —— judgeScroll 的第三参
// （colEst）在 W6-5 已就位但生产面从未喂食。backend/adapter 无 frameColmeans
// 端点（实读 contracts.ts 确认），故在工具侧以现有帧数据自算：frameStats 的
// 垂直条带（归一化 region）均值序列即列亮度 —— 不改 adapter/，零协议增量。
// 列证据缺席（frameStats 故障/脏形状/纵向滚动）⇒ judgeScroll 回落旧行为，
// 判决逐字节不变（降级红律）。
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from '../config';
import { system } from '../system';
import * as backend from '../physicalBackend';
import { sleep } from '../actionVerifier';
import { estimateRowShift, estimateColShift, judgeScroll, type ColShiftEstimate } from '../motionEstimator';
import { toolOk, toolErr } from '../toolResult';

/** W7-0：列亮度采样条带数（frameRowmeans 的 grid=64 同律的横向对偶；32 条带
 *  对 1080p 全屏 ≈ 每条带 60px 列宽 —— estimateColShift 的 ±16 缺省搜索窗内
 *  分辨率与噪声的平衡） */
export const COLUMN_STRIP_COUNT = 32;

/** ΝΩ-31：单次滚动行数上限 —— 与沙箱 actionSchema 的 ACTION_LIMITS.maxScrollAmount
 *  同值（10_000）。工具面与沙箱面共用同一把尺子，不各自立法。 */
export const MAX_SCROLL_AMOUNT = 10_000;

/**
 * W7-0：帧 → 列亮度序列（backend 无 frameColmeans 的就地补全 —— frameStats
 * 垂直条带自算，导出供测试离线断言）。任一条带均值缺席/脏形状/端口抛错 ⇒
 * null（列证据诚实缺席，消费方按降级路径处理，绝不抛）。
 */
export async function frameColLuminance(
  frameId: number,
  strips: number = COLUMN_STRIP_COUNT,
): Promise<number[] | null> {
  try {
    if (typeof frameId !== 'number' || !Number.isFinite(frameId)) return null;
    const n = Math.floor(strips);
    if (!(n >= 4)) return null; // 过稀条带无相位分辨力 —— 不产弱证据
    const regions = Array.from({ length: n }, (_, i) => ({
      x: i / n, y: 0, width: 1 / n, height: 1, // 归一化垂直条带（intent.ts focusRegionNorm 同坐标系）
    }));
    const stats = await backend.frameStats(frameId, regions);
    if (!Array.isArray(stats) || stats.length !== n) return null;
    const cols: number[] = [];
    for (const s of stats) {
      const m = (s as { mean?: number } | null)?.mean;
      if (typeof m !== 'number' || !Number.isFinite(m)) return null; // 单条带脏 ⇒ 整序列缺席（不零填充伪造平线）
      cols.push(m);
    }
    return cols;
  } catch {
    return null; // 端口故障 = 无列证据（诚实降级）
  }
}

/** W7-0：水平方向的列移证据（前后帧列亮度 → estimateColShift；缺席 ⇒ null） */
async function columnShiftEvidence(
  beforeFrameId: number,
  afterFrameId: number,
): Promise<ColShiftEstimate | null> {
  const [colsA, colsB] = await Promise.all([
    frameColLuminance(beforeFrameId),
    frameColLuminance(afterFrameId),
  ]);
  if (colsA === null || colsB === null) return null;
  return estimateColShift(colsA, colsB);
}

export function createScrollPageTool(config: Config) {
  return defineTool({
    name: 'scroll_page',
    description:
      'Scrolls the page up/down/left/right to reveal hidden content — CLOSED-LOOP: the result ' +
      'reports the actual content shift (sub-row precision, via row-brightness cross-correlation), ' +
      'whether it matched the requested direction, and whether the scroll boundary was reached.',
    parameters: {
      direction: {
        type: 'string',
        required: true,
        description: 'The scroll direction. Options: "up", "down", "left", "right".',
      },
      amount: {
        type: 'number',
        description: 'The scroll distance (number of scroll lines). Defaults to 5.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const { direction, amount = 5 } = args;
      const dirMap: Record<string, 'up' | 'down' | 'left' | 'right'> = {
        up: 'up', down: 'down', left: 'left', right: 'right',
      };

      // hasOwnProperty 守卫：纯真值查表会被原型链上的 'toString'/'constructor'
      // 等键绕过（dirMap['toString'] 真值 ⇒ 非法方向混入 system.scroll）
      if (!Object.prototype.hasOwnProperty.call(dirMap, direction)) {
        return toolErr(
          'Scroll validation failed.',
          `Invalid direction "${direction}".`,
          'Retry with one of: up, down, left, right.',
        );
      }
      const dir = dirMap[direction];

      // ΝΩ-31（amount 校验）：NaN/Infinity/负数旧路径直通 system.scroll —— 负数
      // 反向滚（方向被 amount 符号劫持）、NaN 物理层未定义行为。对齐沙箱
      // actionSchema 的更严口径：有限正数 + 上限（同 MAX_SCROLL_AMOUNT）。
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
        return toolErr(
          'Scroll validation failed.',
          `Invalid amount ${JSON.stringify(args.amount ?? null)}: must be a finite positive number (scroll lines).`,
          'Retry with a positive amount (e.g., 3-10 lines). Direction is chosen by the "direction" argument — ' +
          'a negative amount does NOT scroll backwards.',
        );
      }
      if (amount > MAX_SCROLL_AMOUNT) {
        return toolErr(
          'Scroll validation failed.',
          `Amount ${amount} exceeds the limit ${MAX_SCROLL_AMOUNT}.`,
          'Retry in batches with a smaller amount; the page scrolls incrementally.',
        );
      }

      try {
        // 闭环：滚动前帧（入环）→ 滚动 → 稳定 → 滚动后帧（入环）→ 互相关
        const verify = config.verifyActions && !config.dryRun;
        const before = verify
          ? await backend.captureProcessed({ metaOnly: true, keepFrame: true })
          : null;

        await system.scroll(dir, amount);

        if (!before || !before.frameId) {
          return toolOk(
            `Scrolled '${direction}' by ${amount} lines.`,
            { direction, amount },
            "Call 'take_screenshot' to check if the target element is now visible. " +
            "If not, scroll again or check whether the page has its own inner scroll region.",
          );
        }

        await sleep(Math.max(config.actionSettleMs, 250));
        const after = await backend.captureProcessed({ metaOnly: true, keepFrame: true });
        if (!after.frameId) {
          return toolOk(
            `Scrolled '${direction}' by ${amount} lines.`,
            { direction, amount, closed_loop: 'unavailable (frame cache miss)' },
            "Call 'take_screenshot' to verify.",
          );
        }

        const [rowsA, rowsB] = await Promise.all([
          backend.frameRowmeans(before.frameId, 64),
          backend.frameRowmeans(after.frameId, 64),
        ]);
        const est = estimateRowShift(rowsA, rowsB);
        // W7-0（W6-5 接线收尾）：水平方向才求列证据（纵向判决只认行证据 ——
        // judgeScroll 立法；纵向路径零 frameStats 调用，成本与接前一致）。
        // 列证据缺席（端口故障/脏形状）⇒ null ⇒ judgeScroll 走旧行为臂。
        let colEst: ColShiftEstimate | null = null;
        if (dir === 'left' || dir === 'right') {
          colEst = await columnShiftEvidence(before.frameId, after.frameId);
        }
        const verdict = judgeScroll(est, dir, colEst);

        return JSON.stringify({
          status: 'SUCCESS',
          action: `Scrolled '${direction}' by ${amount} lines.`,
          state_anchor: {
            direction,
            amount,
            closed_loop: {
              content_shift_rows: est.shift,          // >0 = 内容下移（物理事实）
              residual: est.residual,                 // 平移假设成立度（越低越可信）
              effective: verdict.effective,           // 内容真的动了吗
              direction_consistent: verdict.directionConsistent, // 位移与请求方向一致吗
              at_boundary: verdict.atBoundary,        // 到达滚动边界了吗
              // W7-0：水平滚动的列证据读数（colEst 在场才有 —— 纵向/降级路径
              // 键缺席，消费方可按缺席判降级；纯增量字段）
              ...(colEst ? { content_shift_cols: colEst.shift, col_residual: colEst.residual } : {}),
            },
          },
          next_step: verdict.atBoundary
            ? 'AT BOUNDARY: the content did not move and the frames are truly static — you have reached the scroll end. ' +
              'Do NOT keep scrolling in this direction; take_screenshot to reassess.'
            : !verdict.effective
              ? 'NO EFFECT: the content barely moved — the scrollable area may not be focused. ' +
                "Click inside the scrollable region first, then retry."
              : verdict.directionConsistent === false
                ? 'DIRECTION MISMATCH: content moved OPPOSITE to the request (natural scrolling may be inverted). ' +
                  "Check with take_screenshot before scrolling again."
                : "Call 'take_screenshot' to check if the target element is now visible. " +
                  'If not, scroll again or check whether the page has its own inner scroll region.',
        }, null, 2);

      } catch (error: any) {
        return toolErr(
          `Scroll '${direction}' failed.`,
          error.message,
          'The scroll target may not be focused. Click inside the scrollable area first, then retry.',
        );
      }
    },
  });
}
