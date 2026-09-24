// src/tools/takeScreenshot.ts
// 皇冠工具：七世地层融合的最终形态。
// 管线：截屏(服务端:叠加/缩放/编码/指纹一体) -> 多屏感知 -> 变化门控 ->
//       滑动窗口 -> 弹窗传感(帧统计+OCR) -> 状态锚点。
// 本轮接线：截图管线整体迁至 D-5 服务端（PIL）—— Node 端零原生图像依赖。
// 门控语义保留：与窗口内最新指纹距离 ≤ stableScreenDistance ⇒ 返回缓存引用。
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from '../config';
import { system } from '../system';
import { normalizeHash } from '../perceptualHash';
import { contextManager } from '../contextManager';
import { detectPopup } from '../popupDetector';
import { updatePopupState, getPopupState } from '../guards/popupGuard';
import { extractInteractiveElements, UIElement } from '../uiExtractor';
import { quantum } from '../quantumSense';
import { journal } from '../journal';
import { trackElements } from '../elementTracker';
import * as backend from '../physicalBackend';
import { saveScreenshotAttachment, imageBlockFromValue } from '../imageDelivery';

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
        description: 'Optional. The specific region to capture (e.g., "full", "active_window"). Defaults to "full".',
      },
      force: {
        type: 'boolean',
        description: 'Bypass change-gating and always capture a fresh image. Default false.',
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
      try {
        const region = args?.region || 'full';
        if (region !== 'full' && region !== 'active_window') {
          return `[Error]: Invalid region. Options: "full", "active_window".`;
        }

        // ── 变化门控参考（与旧管线同语义：与窗口内最新指纹比对）──
        const last = args?.force ? null : contextManager.lastImageRecord();
        const lastHashBits = last?.hash ? normalizeHash(last.hash) : null;

        // 1. 多屏感知 + 准星（并行取，供叠加层与锚点）
        const [display, crosshairPx, size] = await Promise.all([
          system.getActiveDisplay(),
          system.getMousePosition(),
          system.getScreenSize(),
        ]);
        const crosshair = {
          x: crosshairPx.x / size.width,
          y: crosshairPx.y / size.height,
        };

        // 2. 混合模式（可选）：提取元素以启用 ID 寻址；失败则静默降级回纯视觉
        let elements: UIElement[] = [];
        if (config.enableElementIdMode) {
          try {
            elements = await extractInteractiveElements();
          } catch {
            elements = [];
          }
        }

        // R-5：本帧元素先过 IoU 跟踪器铸稳定标签（元素框渲染与模型指令共用）
        const stableLabels = trackElements(elements.map(el => el.rect));
        const quantumOverlays = config.enableQuantumSense && quantum.mode() === 'superposition'
          ? await quantum.overlayNodes(elements.map(el => ({ rect: el.rect })))
          : [];

        // 3. 服务端一次往返：干净帧指纹 + 变化门控 + 中央凹 SoM + 缩放 + JPEG
        // Y-1：auto_foveate —— 服务端熵引擎在干净帧上找热点区，区内网格 2x 加密
        const cap = await system.captureScreenWithOverlay({
          format: 'jpeg',
          quality: config.jpegQuality,
          maxWidth: config.compressWidth,
          gridDivisions: config.gridDivisions,
          autoFoveate: true,
          crosshair,
          boxes: [
            ...elements.map((el, i) => ({
              id: el.id, label: String(stableLabels[i] ?? el.id), rect: el.rect,
            })),
            ...quantumOverlays.map(o => ({ id: o.tag, label: o.label, rect: o.rect })),
          ].map(b => ({
            // UIElement.rect 是原始像素域（uiExtractor 契约）→ 归一化（叠加层契约）
            x: b.rect.x / size.width,
            y: b.rect.y / size.height,
            width: b.rect.width / size.width,
            height: b.rect.height / size.height,
            label: b.label,
          })),
          wantHashes: true,
          keepFrame: true,
          ...(lastHashBits
            ? {
              gate: {
                // hex 位序差异：服务端指纹与旧位串经 normalizeHash 统一后再比
                dhashRef: lastHashBitsToHex(lastHashBits),
                distance: config.stableScreenDistance,
              },
            }
            : {}),
        });

        const rawHash = cap.dhash ? normalizeHash(cap.dhash) : '';
        if (cap.unchanged && last) {
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
        if (!cap.buffer) {
          throw new Error('capture returned no image (gate miss without reference?)');
        }
        // diff_view 的默认对比对：登记本次帧环 id（服务端 frame_diff 消费）
        backend.noteFrameForDiff(cap.frameId);

        // 4. 存入滑动窗口（携带指纹）；驱逐通告原样透传给模型
        const base64Image = `data:image/jpeg;base64,${cap.buffer.toString('base64')}`;
        const { currentId, message } = await contextManager.addScreenshot(base64Image, rawHash);

        // 4.5 图像投递（rc.6 事件面）：附件服务保存 → 工具结果携带 image 块
        const attachment = await saveScreenshotAttachment(cap.buffer, `screenshot-${currentId}.jpg`);

        // 5. 弹窗传感（B-8 双模）：几何（服务端帧统计）+ 语义（OCR）证据融合
        const popup = await detectPopup(cap.buffer, {
          enableOcr: config.enableOcr,
          popupKeywords: config.popupKeywords,
          ocrLang: config.ocrLang,
        }, cap.frameId);
        updatePopupState(popup.popup);

        // 6. C-3 观察登记：截图锚点喂给因果链
        journal.noteObservation(`#${currentId} dHash=${rawHash.slice(0, 8)} popup=${popup.popup}`);

        // 7. 状态锚点：让模型对输入保真度有元认知
        return JSON.stringify({
          status: 'SUCCESS',
          image_attachment: attachment ?? undefined,
          state_anchor: {
            screenshot_id: currentId,
            active_display: {
              name: display.name,
              resolution: `${display.width}x${display.height}`,
              origin: { x: display.x, y: display.y }, // 多屏坐标换算的契约
            },
            popup_detected: popup.popup,
            popup_evidence: popup.semantic
              ? `semantic keywords: ${popup.matchedKeywords.join(', ')}`
              : popup.geometric
                ? 'geometric heuristic: bright uniform center panel'
                : 'none',
            ...(config.enableQuantumSense
              ? { sense: quantum.status() }
              : {}),
            original_resolution: `${size.width}x${size.height}`,
            compressed_resolution: `${cap.width}x${cap.height}`,
            format: `JPEG (quality: ${config.jpegQuality})`,
            region,
            visual_overlay: `${config.gridDivisions}x${config.gridDivisions} SoM Grid + Crosshair` +
              (elements.length ? ' + Element Boxes' : '') +
              (quantumOverlays.length ? ` + ${quantumOverlays.length} Structured-Sense Annotations` : ''),
            // Y-1 中央凹视觉：热点区清单（熵降序）—— 模型优先在热点区内估坐标
            ...(cap.salience && cap.salience.zones.length
              ? {
                foveal_zones: cap.salience.zones.slice(0, 3).map(z =>
                  `bbox=(${z.x.toFixed(2)},${z.y.toFixed(2)})-(${(z.x + z.width).toFixed(2)},${(z.y + z.height).toFixed(2)}) entropy=${z.entropy}`),
                foveal_note: 'These regions have the highest visual information density — targets are most likely INSIDE them; their grid is 2x finer.',
              }
              : {}),
            context_images: `${contextManager.imageCount()}/${config.maxImageCount}`,
            context_image_kb: `${contextManager.imageKb()}/${config.maxContextImageKb}`,
            overlay_legend: [
              `Blue lines: a ${config.gridDivisions}x${config.gridDivisions} grid. Count cells to estimate normalized coordinates (0.0-1.0).`,
              'Green crosshair: the CURRENT mouse position. Use it to judge relative distances to targets.',
              ...(cap.salience && cap.salience.zones.length
                ? ['Denser grid squares: high-information foveal zones (detailed controls/text). Prefer estimating coordinates inside them — their grid is twice as fine.']
                : []),
              elements.length
                ? 'Blue boxes: clickable elements. The number in the blue tag is the element ID usable with click_element.'
                : 'No element boxes in this mode. Rely on grid estimation.',
              ...(quantumOverlays.length
                ? ['Text-labeled boxes: structured-sense annotations (quantum superposition) — whitebox grounding ' +
                   'for blind spots. Use their rect + label for precise targeting; mode auto-reverts to pure vision ' +
                   'after consecutive verified successes.']
                : []),
            ],
          },
          message,
          interactive_elements: elements.map(el => {
            const cx = Math.round(el.rect.x + el.rect.width / 2);
            const cy = Math.round(el.rect.y + el.rect.height / 2);
            return `- [${el.id}] [${el.role}] "${el.name}" (Center@original-res: ${cx}, ${cy})`;
          }),
          next_step: popup.popup
            ? 'WARNING: A popup is detected! You MUST handle it before proceeding.'
            : elements.length
              ? 'Analyze the grid to estimate normalized coordinates (0.0-1.0), or use element IDs with click_element.'
              : 'Analyze the grid to estimate normalized coordinates (0.0-1.0) for the next action.',
        }, null, 2);

      } catch (error: any) {
        return JSON.stringify({
          status: 'FAILED',
          error: error.message,
          next_step: 'Screenshot capture failed. Check the D-5 physical service (python deps: pyautogui/pillow) ' +
            'or system permissions (screen recording / accessibility).',
        }, null, 2);
      }
    },
  });
}

/** 位串 → hex（服务端 gate 比对域）。已是 hex 则透传。 */
function lastHashBitsToHex(bits: string): string {
  if (/^[0-9a-f]+$/i.test(bits) && bits.length === 16) return bits;
  try {
    return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
  } catch {
    return '';
  }
}
