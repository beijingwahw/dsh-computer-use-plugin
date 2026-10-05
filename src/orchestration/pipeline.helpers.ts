// src/orchestration/pipeline.helpers.ts
// W6-2（doctor smell.over-engineering 清偿）：自 pipeline.ts 低风险分区提取
// （>500 行拆分信号）—— 事件常量 / 工位接口 / 网格分区铸造 / 尝试超时包裹 /
// 沙箱链入账 / grounding 预算常量整体搬迁。行为零变化；pipeline.ts 导入消费，
// 导入面不变（PipelineStations 等公开类型经 pipeline.ts 再分发）。
// ΝΩ-8：withAttemptTimeout 重铸为止损型（自建 AbortController + 外部信号组合）——
// 其余分区行为零变化。
import type { RegionSpec, ScenePatch, VisionStation, DecisionStation, ExecutionStation } from './contracts';
import { sandboxLog } from '../sandbox/log';

/** D-6 事件面（events.ts 浇筑时收口；编排器先经 log + 事件常量占位，零直接调用） */
export const EVT_PIPELINE_RUN_END = 'pipeline/run-end';
export const EVT_PIPELINE_ATTEMPT = 'pipeline/attempt';
export const EVT_PIPELINE_GROUNDING = 'pipeline/grounding-request';

export interface PipelineStations {
  vision: VisionStation;
  decision: DecisionStation;
  execution: ExecutionStation;
  /** 事件发射面（index.ts 注入 ctx；null = 无宿主事件面 —— 开发者预览） */
  emit?: (event: string, payload: Record<string, unknown>) => void;
  /**
   * O 纪元（#8）：工位消耗计量探针 —— 谁计量？**工位自报**（只有工位知道
   * 自己烧了什么）。接线方（index.ts）包装工位通道铸造探针；finalReport 读取。
   * 探针缺席 ⇒ 该工位报告 0（未计量 ≠ 未消耗 —— 报告字段命名 Reported 如实）。
   * 决策工位缺省探针：chat 包装器累计 (prompt+response chars)/4 的估计。
   */
  usageMeter?: {
    vision?: () => number;
    decision?: () => number;
    execution?: () => number;
  };
}

/** 网格分区铸造（'g{col}x{row}' —— 坐标同一性，跨轮稳定） */
// exempt(ΝΩ-41 BC-5)：与 knowledge/stations.ts 同体有意双份（orchestration 与 knowledge 互不 import 的器官边界律，行为由 D-6 同一性测试锁定）—— 知情申报
export function gridRegions(grid: { cols: number; rows: number }): RegionSpec[] {
  const regions: RegionSpec[] = [];
  for (let col = 0; col < grid.cols; col++) {
    for (let row = 0; row < grid.rows; row++) {
      regions.push({
        id: `g${col}x${row}`,
        x: col / grid.cols, y: row / grid.rows,
        width: 1 / grid.cols, height: 1 / grid.rows,
      });
    }
  }
  return regions;
}

/** 尝试超时包裹（ΝΩ-8 重铸）：attemptTimeoutMs 越限 ⇒ fallback（杀一刀，不杀流水线）。
 *  与旧 Promise.race+fallback 的唯一差别在「止损」：超时/外部取消时主动 abort ——
 *  旧实现超时后原工位 promise 继续无后果飞行，迟到的真实点击仍会落地
 *  （computer-use 的不可逆世界污染）；现在 abort 沿 ExecutionOrder.signal 直达
 *  HTTP 层断流。工位不消费 signal 时行为与旧路径一致（abort 无监听者 = no-op），
 *  race/fallback/违约捕获语义逐字节保持。
 *  工厂化签名（make 而非既成 promise）是止损的前提：signal 必须在工位调用铸造时
 *  就在手 —— promise 既成之后再给信号，链接已无从注入。
 *  泛型无约束 —— 同时包裹 DecisionOutput 与 ExecutionResult 两形态。
 * @param make 工位调用铸造器（signal = 本尝试止损信号，编排器注入 ExecutionOrder）
 * @param external 外部终止信号（run 级取消）：与内部超时组合 —— 任一触发即 abort
 *  （组合语义对齐 httpClient.ts microFetch：已 abort ⇒ 立即触发；监听 once + finally 拆除，
 *   长命外部 signal 上不留残听）。abort 只发信号不解决竞速 —— 工位 promise 的归宿
 *   仍由竞速裁决（abort 感知的工位快速失败，无感的等内层超时兜底） */
export async function withAttemptTimeout<T>(
  make: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  fallback: T,
  external?: AbortSignal,
): Promise<T> {
  const ctrl = new AbortController();
  let onExternal: (() => void) | undefined;
  if (external) {
    if (external.aborted) ctrl.abort();
    else {
      onExternal = () => ctrl.abort();
      external.addEventListener('abort', onExternal, { once: true });
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      make(ctrl.signal),
      new Promise<T>(resolve => {
        // 顺序即裁决确定性：先 resolve(fallback) 再 abort —— abort 监听器同步派发，
        // 直接监听 signal 的工位 promise 可能同刻交出真实值；fallback 先落定 ⇒
        // 超时归因恒定（工位的迟到归宿被 race 忽略，abort 只负责链路断流）
        timer = setTimeout(() => { resolve(fallback); ctrl.abort(); }, timeoutMs);
      }),
    ]);
  } catch {
    return fallback; // 工位违约抛错（含工厂同步抛）⇒ 结构化捕获（纵深防御）
  } finally {
    if (timer) clearTimeout(timer);
    if (external && onExternal) external.removeEventListener('abort', onExternal);
  }
}

/** 沙箱链入账（复用 D-5 账本，D-6 链段 kind 前缀 'pipeline-' —— 与宿主账本分链）。
 *  P1-5：'pipeline-*' 已收编入 SandboxLogKind 显式契约 —— 类型逃逸（as any）消灭。 */
export async function logPipeline(kind: 'pipeline-attempt' | 'pipeline-retry' | 'pipeline-grounding' |
  'pipeline-grounding-denied' | 'pipeline-grounding-review' | 'pipeline-vision-breach' |
  'pipeline-internal-fault' | 'pipeline-run-end', data: Record<string, unknown>): Promise<void> {
  await sandboxLog.append(kind, data);
}

/** 每 run 的 L3 花钱批准预算（风险加固）：决策工位可反复要 grounding（桩纪元
 *  无记账），恒批准 = L3 失控循环的绿色通道 —— 超预算即诚实拒绝终局） */
export const MAX_GROUNDING_APPROVALS_PER_RUN = 3;

// ─── ΝΩ-26（编排调度四修）：帧复用 / 脏区判定 / 消耗探针的共用面 ───

/** ΝΩ-26：分区补丁复用窗口（ms）。超过此窗龄的缓存补丁一律疑脏重扫 ——
 *  复用是有界信任而非无限信任（世界可以自己动，capturedAt 只申报陈旧度，
 *  窗口保证陈旧度有上界）。缺省值与 L1/L2 适配器帧缓存 TTL（1500ms）同源：
 *  适配器帧还在 ⇒ 补丁复用零成本；帧过期 ⇒ 重扫恰好拿到新帧。 */
export const SCENE_REUSE_TTL_MS = 1500;

// ─── ΠΑΝ-62（L3 结果覆写修复）：证据位阶合并语义的共用面 ───

/** ΠΑΝ-62：漏斗深度位阶（证据贵贱序）—— L3 是花钱买的语义证据，位阶高于
 *  本地肌肉层的 L1/L2；empty 无证据位阶最低。mergePatch 的位阶规则据此
 *  判定「同区缓存补丁是否优先于新扫补丁」。 */
export const FUNNEL_RANK: Record<ScenePatch['funnelDepth'], number> = {
  L1: 1,
  L2: 2,
  L3: 3,
  empty: 0,
};

/** ΠΑΝ-62：L3 证据时效窗（ms）。批准重扫产出的 L3 补丁在此窗内不被后续
 *  L1/L2 重扫覆写（决策工位先消费花钱买的答案）；窗外世界的新鲜 L1/L2
 *  数据如实接管（L3 答案会陈旧 —— capturedAt 全程如实申报数据年龄）。
 *  取 10s：覆盖一整轮感知延迟（perceptionDeadlineMs 缺省 10s）+ 决策消费，
 *  保证「批准 → 内联重扫 → 下轮感知 → 决策」链路上 L3 恒可达决策工位。 */
export const L3_EVIDENCE_TTL_MS = 10_000;

/** ΝΩ-26：分区内容指纹（dhash 方言）。管线层无像素字节（注意力隔离 ——
 *  像素永不进编排），指纹以 ScenePatch 元素面为源：role/name/state + rect
 *  定点 3 位（≈0.1% 屏宽，坐标微抖不敏感）的确定性摘要。与 perceptualHash
 *  的图像 dhash 同职同语义：内容未变 ⇒ 指纹未变 ⇒ 复用旧补丁（capturedAt
 *  如实申报数据年龄 —— 诚实方言）。 */
export function sceneDhash(patch: ScenePatch): string {
  const els = patch.elements
    .map(e => `${e.role}|${e.name}|${e.state ?? ''}` +
      `|${e.rect.x.toFixed(3)},${e.rect.y.toFixed(3)},${e.rect.width.toFixed(3)},${e.rect.height.toFixed(3)}`)
    .join(';');
  return `${patch.funnelDepth}#${patch.elements.length}#${els}`;
}

/** ΝΩ-26：工位消耗探针的安全读数（O 纪元 #8 方言，自 finalReport 下沉共用）：
 *  探针缺席 / 抛错 / 域外 ⇒ 0（未计量 ≠ 未消耗 —— 扣减制只认自报数，
 *  绝不猜测）。 */
export function readUsageProbe(p?: () => number): number {
  try {
    const v = p?.();
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
  } catch { return 0; }
}
