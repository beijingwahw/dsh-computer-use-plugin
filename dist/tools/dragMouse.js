// src/tools/dragMouse.ts
// 四拍时序（移->按->移->放）下沉 system.dragMouse；本层负责校验与换算锚点。
// 修复原版：Button 未导入的编译错误；四个坐标各自独立校验与换算。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system.js';
import * as backend from '../physicalBackend.js';
import { captureBefore, settleAndVerify } from '../actionVerifier.js';
import { normalizeHash, similarity } from '../perceptualHash.js';
import { quantum } from '../quantumSense.js';
import { focusTracker } from '../focusTracker.js';
export function judgeTransport(beforeStartHash, afterEndHash, afterStartHash, thresholds = { transported: 0.75, vacated: 0.85 }) {
    if (!beforeStartHash || !afterEndHash)
        return null;
    const atDestination = similarity(normalizeHash(beforeStartHash), normalizeHash(afterEndHash));
    const stillAtSource = afterStartHash
        ? similarity(normalizeHash(beforeStartHash), normalizeHash(afterStartHash))
        : null;
    const transported = atDestination >= thresholds.transported;
    const vacated = stillAtSource === null ? false : stillAtSource < thresholds.vacated;
    return {
        transported,
        vacated,
        copyLike: transported && stillAtSource !== null && stillAtSource >= thresholds.vacated,
    };
}
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
                // ── Y-4 运输验证：被抓取物真的从起点运动到终点了吗 ──
                let transport = null;
                if (verify) {
                    try {
                        const r = Math.max(config.regionVerifyRadius, 0.08);
                        const atEnd = await backend.captureProcessed({
                            metaOnly: true,
                            wantRegionHash: { x: endX, y: endY, r },
                        });
                        const atStart = await backend.captureProcessed({
                            metaOnly: true,
                            wantRegionHash: { x: startX, y: startY, r },
                        });
                        transport = judgeTransport(before?.region ?? null, atEnd.regionDhash ?? null, atStart.regionDhash ?? null);
                    }
                    catch { /* 运输验证是旁路义务：失败不毒化主判决 */ }
                }
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
                        // Y-4 运输三元组：内容级证据（比像素变化更强的「物走了」判决）
                        transport: transport
                            ? {
                                transported: transport.transported,
                                vacated: transport.vacated,
                                ...(transport.copyLike ? { semantics: 'copy-like (content now at BOTH source and destination)' } : {}),
                            }
                            : undefined,
                    },
                    next_step: transport && !transport.transported && effect?.detected
                        ? 'PIXELS CHANGED BUT NO TRANSPORT: something moved, yet the content you grabbed is NOT at the destination — ' +
                            'you may have dragged the wrong object or dropped it midway. take_screenshot to see where it went.'
                        : transport && transport.transported
                            ? `TRANSPORT VERIFIED: the grabbed content now sits at the destination${transport.vacated ? ' and its old position is empty' : ''}. ` +
                                "MANDATORY: take_screenshot to confirm the final layout."
                            : noopSuspected
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
