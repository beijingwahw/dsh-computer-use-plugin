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
import { matchesDangerPatterns } from '../riskGate.js';
import { approval } from '../approval.js';
import { consumeApprovalAmendment, gateByReversibility, laneAnchorOf } from './clickMouse.js';
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
            // Δ 纪元（安全外围#6）：拖拽安检的可判定语义面 —— 描述**目的地**（拖到哪）。
            // 可选通道（拖滑块/调窗口无危险语义，不设 click 式硬前置）。
            target_description: {
                type: 'string',
                description: 'What you are dragging and WHERE you drop it (e.g., "report.doc onto the 删除/回收站 zone"). ' +
                    'Feeds the danger/approval gate: a drag into a delete/send/pay zone is as irreversible as the click ' +
                    'that triggers it — supply approval_token for such targets.',
            },
            approval_token: {
                type: 'string',
                description: 'One-shot token from request_approval. Required for irreversible drag destinations ' +
                    '(delete/recycle bin/send/pay...).',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            const { startX, startY, endX, endY, target_description, approval_token } = args;
            // NaN 卫兵：NaN 与任何比较皆为 false，会穿过四重 bounds 检查直达
            // Math.round(NaN * size) —— 物理层收到 NaN 像素
            if (!Number.isFinite(startX) || !Number.isFinite(startY) ||
                !Number.isFinite(endX) || !Number.isFinite(endY) ||
                startX < 0 || startX > 1 || startY < 0 || startY > 1 ||
                endX < 0 || endX > 1 || endY < 0 || endY > 1) {
                return `[Error]: Invalid drag coordinates. All four values must be between 0.0 and 1.0.`;
            }
            // ── W1-2 批注消费接线（W2-2）：危险判定之前读 amendment patch 修正计划 ──
            // 抓取点（start）与目标描述参与修正（RawActionShape 是单点形状 —— 拖拽的
            // 抓取点先行；目的地语义修正走 target_description）。修正后的描述参与
            // 危险判定（用户批注把拖拽改述为「拖进删除区」⇒ 按危险处理 —— 批注不得
            // 成为绕闸通道）。无令牌/无批注 ⇒ 零行为（旧路径逐字节不变）。
            const amendment = consumeApprovalAmendment(approval_token, { tool: 'drag_mouse', x: startX, y: startY, target_description });
            const effStartX = amendment.x ?? startX;
            const effStartY = amendment.y ?? startY;
            const effTarget = amendment.target_description ?? target_description;
            // ── Δ 纪元（安全外围#6）：拖拽安检 —— 旧实现的零安检盲区 ──
            // 「拖进回收站/删除区」与「点击删除按钮」同属不可逆操作，但 drag 既无
            // target_description 也不查危险词 —— 审批闸门对整个 drag 动作面失明。
            // 语义对齐 clickMouse 的闸门形态（判定事实源同律：riskGate 的
            // matchesDangerPatterns + approval.validate；阻断路径顺手 sweep 过期令牌；
            // 拒绝归因 token 在场 'token-not-granted-or-expired' / 缺席
            // 'irreversible-action'）。与 click 臂的两点有意差异：描述是**可选**通道
            // （无危险语义的拖拽 —— 滑块/窗口 —— 不设 undescribed 硬前置）；消费走
            // 派发即焚（一次性令牌律；验收式消费是 click 的 V 纪元机制，drag 的运输
            // 验证证据形状不同，不在此冒进复刻）。四坐标的 bounds 校验已在上方存在
            // （另有 boundsGuard 前置），不重复。
            const dangerous = config.enableApprovalGate
                && !!effTarget
                && matchesDangerPatterns(effTarget, config.dangerPatterns);
            if (dangerous && !(approval_token && approval.validate(approval_token))) {
                approval.sweep(); // 顺手清理过期令牌（与 click 闸门同律）
                return JSON.stringify({
                    status: 'ACTION_REQUIRED',
                    state_anchor: {
                        target: effTarget ?? '(undescribed drag)',
                        danger_signal: 'target_description',
                        reason: approval_token ? 'token-not-granted-or-expired' : 'irreversible-action',
                        normalized: { start: { x: effStartX, y: effStartY }, end: { x: endX, y: endY } },
                        note: approval_token
                            ? 'The token exists but the user has not granted it yet (or it expired).'
                            : 'This drag destination looks irreversible (delete/recycle bin/send/pay...).',
                    },
                    next_step: 'PAUSE: this drag needs explicit user approval. Call request_approval with a clear ' +
                        'description (what is being dragged and where it lands), relay the message, wait for consent, ' +
                        'call grant_approval(token, true), then re-invoke drag_mouse with the returned approval_token. ' +
                        'Never proceed without consent.',
                }, null, 2);
            }
            // ── W5-0（C 接线 · W4-3 S5）：可逆性分道 —— 目的地语义即描述面 ──
            // 「拖进回收站」与「点删除按钮」同属可补偿/不可逆族 —— 与 click 同律
            // 三路执法（drag 的消费走派发即焚，escrow 道铸预案先行同样成立）。开关
            // 关（缺省）⇒ applied:false 零行为。
            const laneGate = await gateByReversibility(config, {
                tool: 'drag_mouse',
                ...(effTarget !== undefined ? { description: effTarget } : {}),
                ...(approval_token !== undefined ? { approvalToken: approval_token } : {}),
                enforceEscrow: !!(dangerous && approval_token),
            });
            if (laneGate.applied && laneGate.blocked !== null) {
                return laneGate.blocked;
            }
            try {
                const size = await system.getScreenSize();
                const startPixel = { x: Math.round(effStartX * size.width), y: Math.round(effStartY * size.height) };
                const endPixel = { x: Math.round(endX * size.width), y: Math.round(endY * size.height) };
                // 效果验证（双尺度）：起点区域是「被抓取物」原来的位置，拖拽后必然剧变；
                // 终点登记为新焦点，供后续输入类动作的区域验证使用
                const verify = config.verifyActions && !config.dryRun;
                const before = verify
                    ? await captureBefore({ x: effStartX, y: effStartY }, config.regionVerifyRadius)
                    : null;
                await system.dragMouse(startPixel, endPixel);
                focusTracker.set(endX, endY);
                // Δ#6 一次性令牌律：危险拖拽的物理派发已落地（世界可能已发生不可逆变化）
                // ⇒ 派发即消费（与 click 的验证关闭方言同律）。异常路径不烧令牌（B-3 语义：
                // 抛异常的回合在下方 catch 返回，令牌保留供同授权内重试）。
                if (dangerous && approval_token)
                    approval.consume(approval_token);
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
                            wantRegionHash: { x: effStartX, y: effStartY, r },
                        });
                        transport = judgeTransport(before?.region ?? null, atEnd.regionDhash ?? null, atStart.regionDhash ?? null);
                    }
                    catch { /* 运输验证是旁路义务：失败不毒化主判决 */ }
                }
                return JSON.stringify({
                    status: 'SUCCESS',
                    action: 'Mouse dragged.',
                    state_anchor: {
                        normalized: { start: { x: effStartX, y: effStartY }, end: { x: endX, y: endY } },
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
                        // Δ#6 安检透明化：本次拖拽是否经审批令牌放行（危险目的地上的一发令牌
                        // 已随派发消费）
                        approval_gate: dangerous ? { described: true, token_consumed_on_dispatch: true } : undefined,
                        // W2-2（W1-2）：批注修正透明化 —— 用户批注把计划修正成了什么
                        amendment: amendment.stamp || undefined,
                        // W5-0（C 接线）：可逆性分道注记（快道/托管道 + 预案 id；未分道缺席）
                        reversibility_lane: laneAnchorOf(laneGate),
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
