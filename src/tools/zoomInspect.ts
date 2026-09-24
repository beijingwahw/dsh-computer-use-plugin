// src/tools/zoomInspect.ts
// 突破四：二阶段定位（coarse → zoom → precise）。
// SOTA CUA 的抗幻觉关键：全屏估坐标误差大时，裁剪目标邻域放大重绘细网格，
// 让模型在小图上做精细定位，再把「裁剪框内坐标」映射回全屏归一化坐标系。
// 锚点中直接给出映射公式与裁剪框边界 —— 坐标换算的 ground truth 随图附带。
// 本轮接线：裁剪/放大/细网格/编码整体迁至 D-5 服务端（PIL）。
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from '../config';
import { system } from '../system';
import * as backend from '../physicalBackend';
import { contextManager } from '../contextManager';
import { saveScreenshotAttachment, imageBlockFromValue } from '../imageDelivery';

// ─── Y-2 金字塔级联的停止法则（纯函数 —— 测试的确定性事实源）───
//
// 数学：贪心信息增益下降 —— 每层裁到当前显著度 argmax 区，熵增益
// ΔH = H(层 k) - H(层 k-1)。停止当 (a) ΔH < ε_rel·H(k-1)（相对增益枯竭：
// 再放大不再买来新信息）或 (b) H(k) < ε_abs（已到低熵均匀区：无目标）或
// (c) 深度上限（预算）。这是零阶逼近的置信引导搜索（confidence-guided
// bisection family），区别于盲目二分：每步的选择由当前证据做出。

export interface PyramidLevel {
  level: number;
  region: { x: number; y: number; width: number; height: number };
  entropy: number;
}

export interface PyramidStopParams {
  maxDepth: number;
  /** 相对熵增益阈值：ΔH < ε_rel · H_prev ⇒ 停 */
  epsilonRel: number;
  /** 绝对熵下限：H < ε_abs ⇒ 停（均匀区无目标） */
  epsilonAbs: number;
}

export const PYRAMID_DEFAULTS: PyramidStopParams = { maxDepth: 3, epsilonRel: 0.12, epsilonAbs: 2.0 };

/** 停止判决：给定前层熵与当前熵，返回是否停止（纯函数）。
 * 增益 = H(k) - H(k-1)（越深越浓）；仅 depth ≥ 1 适用增益规则 ——
 * 首层没有前层基线，只受深度/绝对下限约束（否则永不出发）。 */
export function pyramidShouldStop(prevEntropy: number, curEntropy: number, depth: number, p: PyramidStopParams = PYRAMID_DEFAULTS): boolean {
  if (depth >= p.maxDepth) return true;
  if (curEntropy < p.epsilonAbs) return true;
  if (depth > 0 && prevEntropy > 0 && (curEntropy - prevEntropy) < p.epsilonRel * prevEntropy) return true;
  return false;
}

/** 从显著度图选下一层裁剪框：argmax 熵区与当前 region 的交集（纯函数） */
export function nextPyramidRegion(
  current: { x: number; y: number; width: number; height: number },
  salience: { zones: Array<{ x: number; y: number; width: number; height: number; entropy: number }> },
): { region: { x: number; y: number; width: number; height: number }; entropy: number } | null {
  if (!salience.zones.length) return null;
  const best = salience.zones[0]; // zones 按熵降序（服务端契约）
  // 交集（无交集 ⇒ 熵图异常，退化为不下降）
  const x0 = Math.max(current.x, best.x);
  const y0 = Math.max(current.y, best.y);
  const x1 = Math.min(current.x + current.width, best.x + best.width);
  const y1 = Math.min(current.y + current.height, best.y + best.height);
  if (x1 - x0 < 0.02 || y1 - y0 < 0.02) return null;
  return { region: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, entropy: best.entropy };
}

export function createZoomInspectTool(config: Config) {
  return defineTool({
    name: 'zoom_inspect',
    description:
      'Crops and upscales a region around a point, overlaying a fine grid for precise grounding. ' +
      'Use this when you are unsure about a target location from the full screenshot, ' +
      'or after a click that produced no visible effect.',
    parameters: {
      x: { type: 'number', required: true, description: 'Center X of the region (0.0-1.0).' },
      y: { type: 'number', required: true, description: 'Center Y of the region (0.0-1.0).' },
      half_size: {
        type: 'number',
        description: 'Half-size of the region as a fraction of screen width/height. Default 0.15.',
      },
      auto_descend: {
        type: 'boolean',
        description: 'Entropy-guided pyramid: automatically zoom into the highest-information sub-region ' +
          'until the information gain dries up (default true). The anchor records the descent path with per-level entropy.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [
        { type: 'text', text: value },
        ...imageBlockFromValue(value),
      ] as any,
    },
    async execute(args) {
      const { x, y, half_size = 0.15, auto_descend = true } = args;

      if (x < 0 || x > 1 || y < 0 || y > 1 || half_size <= 0 || half_size > 0.5) {
        return `[Error]: Invalid arguments. x/y must be 0.0-1.0 and half_size in (0, 0.5].`;
      }

      try {
        // 裁剪框（归一化域，双侧夹取 —— 与坐标映射公式严格一致）
        const x0 = Math.max(0, x - half_size);
        const y0 = Math.max(0, y - half_size);
        const x1 = Math.min(1, x + half_size);
        const y1 = Math.min(1, y + half_size);
        let region = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };

        // ── Y-2 熵引导金字塔：逐层下降到信息最密的子区，停止法则见纯函数 ──
        const descent: Array<{ level: number; region: { x: number; y: number; width: number; height: number }; entropy: number }> = [];
        function curEntropyPlaceholder(): number { return 0; }
        if (auto_descend) {
          let depth = 0;
          let prevEntropy = curEntropyPlaceholder();
          for (;;) {
            const probe = await backend.captureProcessed({ metaOnly: true, wantSalience: true, region });
            const sal = probe.salience;
            const curEntropy = sal?.stats?.max ?? 0;
            descent.push({ level: depth, region: { ...region }, entropy: Math.round(curEntropy * 100) / 100 });
            if (pyramidShouldStop(prevEntropy, curEntropy, depth)) break;
            const next = sal ? nextPyramidRegion(region, sal) : null;
            if (!next || next.region.width >= region.width * 0.95) break; // 无更小热点：到位
            region = next.region;
            prevEntropy = curEntropy;
            depth++;
          }
        }

        // 服务端：裁剪 → 放大（目标全宽）→ 细网格 → JPEG（最终层）
        const cap = await system.captureScreenWithOverlay({
          format: 'jpeg',
          quality: config.jpegQuality,
          region,
          gridDivisions: config.gridDivisions * 2, // 细网格：相对全屏网格加密一倍
          maxWidth: config.compressWidth,
        });
        if (!cap.buffer) {
          throw new Error('zoom capture returned no image');
        }

        const base64 = `data:image/jpeg;base64,${cap.buffer.toString('base64')}`;
        const { currentId } = await contextManager.addScreenshot(base64);
        const attachment = await saveScreenshotAttachment(cap.buffer, `zoom-${currentId}.jpg`);

        return JSON.stringify({
          status: 'SUCCESS',
          image_attachment: attachment ?? undefined,
          state_anchor: {
            screenshot_id: currentId,
            zoom: 'REGION_CROP_UPSCALED',
            crop_bounds_normalized: { x0: region.x, y0: region.y, x1: region.x + region.width, y1: region.y + region.height },
            requested_bounds_normalized: { x0, y0, x1, y1 },
            fine_grid: `${config.gridDivisions * 2}x${config.gridDivisions * 2}`,
            ...(descent.length
              ? {
                pyramid_descent: descent.map(l =>
                  `L${l.level}: bbox=(${l.region.x.toFixed(2)},${l.region.y.toFixed(2)})-(${(l.region.x + l.region.width).toFixed(2)},${(l.region.y + l.region.height).toFixed(2)}) H=${l.entropy}`),
                pyramid_note: 'The crop center was refined level-by-level toward the highest-information sub-region (entropy-guided).',
              }
              : {}),
            // 坐标映射公式：把裁剪图内的位置换算回全屏归一化坐标
            mapping_formula: 'full_x = x0 + fx * (x1 - x0); full_y = y0 + fy * (y1 - y0)',
            mapping_hint: 'where (fx, fy) is the target position estimated INSIDE this zoomed image (0.0-1.0).',
          },
          next_step: 'Locate the target inside this zoomed image, estimate (fx, fy), ' +
            'map back with the formula above, then call click_mouse with the FULL-screen normalized coordinates.',
        }, null, 2);

      } catch (error: any) {
        return JSON.stringify({
          status: 'FAILED',
          error: error.message,
          next_step: 'Zoom inspection failed. Fallback to full take_screenshot.',
        }, null, 2);
      }
    },
  });
}
