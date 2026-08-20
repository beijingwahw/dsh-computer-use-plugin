// src/tools/zoomInspect.ts
// 突破四：二阶段定位（coarse → zoom → precise）。
// SOTA CUA 的抗幻觉关键：全屏估坐标误差大时，裁剪目标邻域放大重绘细网格，
// 让模型在小图上做精细定位，再把「裁剪框内坐标」映射回全屏归一化坐标系。
// 锚点中直接给出映射公式与裁剪框边界 —— 坐标换算的 ground truth 随图附带。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { getSharp } from '../_legacyDeps';
import type { Config } from '../config';
import { system } from '../system';
import { addVisualOverlay } from '../visualOverlay';
import { contextManager } from '../contextManager';

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
        type: 'number', required: false,
        description: 'Half-size of the region as a fraction of screen width/height. Default 0.15.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const { x, y, half_size = 0.15 } = args;

      if (x < 0 || x > 1 || y < 0 || y > 1 || half_size <= 0 || half_size > 0.5) {
        return `[Error]: Invalid arguments. x/y must be 0.0-1.0 and half_size in (0, 0.5].`;
      }

      try {
        const rawBuffer = await system.captureScreen();
        const sharp = await getSharp();
        const meta = await sharp(rawBuffer).metadata();
        const W = meta.width!, H = meta.height!;

        // 裁剪框（像素域，越界夹取）与归一化边界（模型映射用）
        const left = Math.max(0, Math.round((x - half_size) * W));
        const top = Math.max(0, Math.round((y - half_size) * H));
        const right = Math.min(W, Math.round((x + half_size) * W));
        const bottom = Math.min(H, Math.round((y + half_size) * H));

        const crop = await sharp(rawBuffer)
          .extract({ left, top, width: right - left, height: bottom - top })
          .resize(config.compressWidth) // 放大到全宽，小目标变大目标
          .toBuffer();

        // 细网格：相对全屏网格加密一倍，微观定位
        const overlayed = await addVisualOverlay(crop, { gridDivisions: config.gridDivisions * 2 });
        const compressed = await sharp(overlayed)
          .jpeg({ quality: config.jpegQuality })
          .toBuffer();

        const base64 = `data:image/jpeg;base64,${compressed.toString('base64')}`;
        const { currentId } = await contextManager.addScreenshot(base64);

        return JSON.stringify({
          status: 'SUCCESS',
          state_anchor: {
            screenshot_id: currentId,
            zoom: 'REGION_CROP_UPSCALED',
            crop_bounds_normalized: {
              x0: left / W, y0: top / H, x1: right / W, y1: bottom / H,
            },
            fine_grid: `${config.gridDivisions * 2}x${config.gridDivisions * 2}`,
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
