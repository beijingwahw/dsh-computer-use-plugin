// src/tools/takeScreenshot.ts
// 皇冠工具：七世地层融合的最终形态。
// 管线：截屏 -> 多屏感知 -> SoM 网格+准星(+元素框) -> 压缩 -> 滑动窗口 -> 弹窗传感 -> 状态锚点。
// 修复：screenshot_id 契约误用、updatePopupState 导入断裂、detectPopupHeuristic 未定义。
import { defineTool } from '@deepseek-ai/dsh-tools';
import sharp from 'sharp';
import type { Config } from '../config';
import { system } from '../system';
import { addVisualOverlay } from '../visualOverlay';
import { contextManager } from '../contextManager';
import { detectPopupHeuristic } from '../popupDetector';
import { updatePopupState, getPopupState } from '../guards/popupGuard';
import { extractInteractiveElements, UIElement } from '../uiExtractor';
import { dhash, hammingDistance } from '../perceptualHash';

export function createTakeScreenshotTool(config: Config) {
  return defineTool({
    name: 'take_screenshot',
    description:
      'Captures the current screen with a SoM grid and mouse crosshair overlay. ' +
      'Use this to observe the UI, read text, and estimate normalized coordinates (0.0-1.0) before acting.',
    parameters: {
      // 接口先行，实现后补（来自「模拟纪元」地层的第一版远见）：
      // 'active_window' 暂以全屏实现，锚点中如实标注
      region: {
        type: 'string',
        required: false,
        description: 'Optional. The specific region to capture (e.g., "full", "active_window"). Defaults to "full".',
      },
      force: {
        type: 'boolean', required: false,
        description: 'Bypass change-gating and always capture a fresh image. Default false.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        const region = args?.region || 'full';
        if (region !== 'full' && region !== 'active_window') {
          return `[Error]: Invalid region. Options: "full", "active_window".`;
        }
        // 1. 捕获原始屏幕
        const rawBuffer = await system.captureScreen();
        const rawMeta = await sharp(rawBuffer).metadata();

        // ── 变化门控（change-gated screenshots）：指纹与窗口内最新一张几乎相同
        //    ⇒ 屏幕未变，跳过整条压缩/入窗管线，返回缓存引用锚点。
        //    省 Token（不占窗口图片位）、省 CPU（不做管线）；弹窗状态沿用上次传感。
        const rawHash = await dhash(rawBuffer);
        if (!args?.force) {
          const last = contextManager.lastImageRecord();
          if (last?.hash && hammingDistance(last.hash, rawHash) <= config.stableScreenDistance) {
            return JSON.stringify({
              status: 'SUCCESS',
              unchanged: true,
              state_anchor: {
                same_as_screenshot: last.id,
                popup_detected: getPopupState(),
                context_images: `${contextManager.imageCount()}/${config.maxImageCount}`,
                change_gate: `screen identical to #${last.id} (dHash distance <= ${config.stableScreenDistance})`,
              },
              next_step: 'Screen is UNCHANGED since the referenced screenshot. Reuse it for grounding; ' +
                'do NOT re-capture. If you expected a change, the previous action had no effect — see its effect report.',
            }, null, 2);
          }
        }
        // 门控未命中：rawHash 随记录入库，供下次门控与场景记忆使用

        // 2. 多屏感知：当前操作的是哪块屏、其坐标系原点在哪
        const display = await system.getActiveDisplay();
        const crosshair = await system.getMousePosition();

        // 3. 混合模式（可选）：提取元素以启用 ID 寻址；失败则静默降级回纯视觉
        let elements: UIElement[] = [];
        if (config.enableElementIdMode) {
          try {
            elements = await extractInteractiveElements();
          } catch {
            elements = [];
          }
        }

        // 4. SoM 视觉辅助：网格 + 准星（+ 元素框）
        const overlayedBuffer = await addVisualOverlay(rawBuffer, {
          gridDivisions: config.gridDivisions,
          crosshair,
          elements: elements.map(el => ({ id: el.id, label: el.id, rect: el.rect })),
        });

        // 5. Token 杀手：resize + jpeg。参数来自「纯视觉定型纪元」——
        //    截图是唯一信息源时，压缩让步于保真（1440/q75），且全部由 Config 决定
        const compressedBuffer = await sharp(overlayedBuffer)
          .resize({ width: config.compressWidth })
          .jpeg({ quality: config.jpegQuality })
          .toBuffer();
        const compressedMeta = await sharp(compressedBuffer).metadata();

        // 6. 存入滑动窗口（携带指纹）；驱逐通告原样透传给模型（上下文收缩全透明）
        const base64Image = `data:image/jpeg;base64,${compressedBuffer.toString('base64')}`;
        const { currentId, message } = contextManager.addScreenshot(base64Image, rawHash);

        // 7. 弹窗传感：每次观察顺便更新全局弹窗状态，popupGuard 据此拦截盲操作
        const hasPopup = await detectPopupHeuristic(compressedBuffer);
        updatePopupState(hasPopup);

        // 8. 状态锚点：让模型对输入保真度有元认知，next_step 依据世界状态分支
        return JSON.stringify({
          status: 'SUCCESS',
          state_anchor: {
            screenshot_id: currentId,
            active_display: {
              name: display.name,
              resolution: `${display.width}x${display.height}`,
              origin: { x: display.x, y: display.y }, // 多屏坐标换算的契约
            },
            popup_detected: hasPopup,
            original_resolution: `${rawMeta.width}x${rawMeta.height}`,
            compressed_resolution: `${compressedMeta.width}x${compressedMeta.height}`,
            format: `JPEG (quality: ${config.jpegQuality})`,
            region,
            visual_overlay: `${config.gridDivisions}x${config.gridDivisions} SoM Grid + Crosshair` +
              (elements.length ? ' + Element Boxes' : ''),
            // Token 仪表盘：模型随时知道上下文图片预算的余量
            context_images: `${contextManager.imageCount()}/${config.maxImageCount}`,
            // 图层图例（来自「视觉纪元」的图文双通道教学）：教模型「怎么读」这张图
            overlay_legend: [
              `Blue lines: a ${config.gridDivisions}x${config.gridDivisions} grid. Count cells to estimate normalized coordinates (0.0-1.0).`,
              'Green crosshair: the CURRENT mouse position. Use it to judge relative distances to targets.',
              elements.length
                ? 'Blue boxes: clickable elements. The number in the blue tag is the element ID usable with click_element.'
                : 'No element boxes in this mode. Rely on grid estimation.',
            ],
          },
          message,
          interactive_elements: elements.map(el => {
            const cx = Math.round(el.rect.x + el.rect.width / 2);
            const cy = Math.round(el.rect.y + el.rect.height / 2);
            return `- [${el.id}] [${el.role}] "${el.name}" (Center@original-res: ${cx}, ${cy})`;
          }),
          next_step: hasPopup
            ? 'WARNING: A popup is detected! You MUST handle it before proceeding.'
            : elements.length
              ? 'Analyze the grid to estimate normalized coordinates (0.0-1.0), or use element IDs with click_element.'
              : 'Analyze the grid to estimate normalized coordinates (0.0-1.0) for the next action.',
        }, null, 2);

      } catch (error: any) {
        return JSON.stringify({
          status: 'FAILED',
          error: error.message,
          next_step: 'Screenshot capture failed. Check system permissions (screen recording / accessibility) or try again.',
        }, null, 2);
      }
    },
  });
}
