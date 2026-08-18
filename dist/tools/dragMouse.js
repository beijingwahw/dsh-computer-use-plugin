// src/tools/dragMouse.ts
// 四拍时序（移->按->移->放）下沉 system.dragMouse；本层负责校验与换算锚点。
// 修复原版：Button 未导入的编译错误；四个坐标各自独立校验与换算。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system.js';
import { captureBefore, settleAndVerify } from '../actionVerifier.js';
import { quantum } from '../quantumSense.js';
import { focusTracker } from '../focusTracker.js';
export function createDragMouseTool(config) {
    return defineTool({
        name: 'drag_mouse',
        description: 'Clicks and holds the mouse at a starting point, drags to an ending point, and releases. ' +
            'Used for moving files, resizing windows, or dragging sliders.',
        parameters: {
            startX: { type: 'number', required: true, description: 'Start X coordinate (0.0 to 1.0).' },
            startY: { type: 'number', required: true, description: 'Start Y coordinate (0.0 to 1.0).' },
            endX: { type: 'number', required: true, description: 'End X coordinate (0.0 to 1.0).' },
            endY: { type: 'number', required: true, description: 'End Y coordinate (0.0 to 1.0).' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            const { startX, startY, endX, endY } = args;
            if (startX < 0 || startX > 1 || startY < 0 || startY > 1 ||
                endX < 0 || endX > 1 || endY < 0 || endY > 1) {
                return `[Error]: Invalid drag coordinates. All four values must be between 0.0 and 1.0.`;
            }
            try {
                const size = await system.getScreenSize();
                const startPixel = { x: Math.round(startX * size.width), y: Math.round(startY * size.height) };
                const endPixel = { x: Math.round(endX * size.width), y: Math.round(endY * size.height) };
                // 效果验证（双尺度）：起点区域是「被抓取物」原来的位置，拖拽后必然剧变；
                // 终点登记为新焦点，供后续输入类动作的区域验证使用
                const verify = config.verifyActions && !config.dryRun;
                const before = verify
                    ? await captureBefore({ x: startX, y: startY }, config.regionVerifyRadius)
                    : null;
                await system.dragMouse(startPixel, endPixel);
                focusTracker.set(endX, endY);
                let effect = null;
                if (before) {
                    effect = await settleAndVerify(before, {
                        adaptive: config.adaptiveSettle,
                        settleMs: config.actionSettleMs,
                        threshold: config.noopSimilarityThreshold,
                        regionRadius: config.regionVerifyRadius,
                    });
                }
                // D-3 量子感知：验证证据喂给状态机（effect=null ⇒ undefined ⇒ 不计数）
                quantum.recordEffect(effect?.detected);
                const noopSuspected = effect && !effect.detected;
                return JSON.stringify({
                    status: 'SUCCESS',
                    action: 'Mouse dragged.',
                    state_anchor: {
                        normalized: { start: { x: startX, y: startY }, end: { x: endX, y: endY } },
                        absolute_pixels: { start: startPixel, end: endPixel },
                        screen_resolution: `${size.width}x${size.height}`,
                        effect: effect ? {
                            detected: effect.detected,
                            scale: effect.scale,
                            screen_similarity_pct: effect.screen.similarity_pct,
                            region_similarity_pct: effect.region ? effect.region.similarity_pct : undefined,
                        } : 'verification-off',
                    },
                    next_step: noopSuspected
                        ? 'WARNING: Neither the screen nor the start region changed — the drag may not have grabbed the target. Verify with take_screenshot and retry with adjusted start point.'
                        : "MANDATORY: Call 'take_screenshot' to verify the drag result.",
                }, null, 2);
            }
            catch (error) {
                return `[Error]: Drag operation failed. ${error.message}`;
            }
        },
    });
}
