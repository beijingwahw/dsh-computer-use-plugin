// src/tools/clickElement.ts
// ID 寻址协议：take_screenshot 发 ID，本工具用 ID —— 两工具间的引用机制（语言级指针）。
// 修复原版 ID 漂移缺陷：从 uiExtractor 的短时缓存读取，而非重新提取导致 ID 全变。
// 精华保留：几何中心点击 —— 不信任元素边缘，永远点最稳的质心。
// B-4：返回值统一走 toolResult 工厂（反幻觉锚点全覆盖）。
//
// ΑΩ-R29 老工具方言整治审计：主路径（SUCCESS/FAILED）已走 toolOk/toolErr 工厂
// （B-4 收编在案）；四处 ACTION_REQUIRED 安双方言**不收编** —— 均无顶层 action
// 键且 reason 落位 state_anchor 中部（toolActionRequired 会注入 action 并把
// reason 前置合并，键序漂移）—— clickMouse ΑΩ-R11 同律定谳的方言族；
// epochR.notarization / w2audit / p2b-fixes 按键钉死
// （state_anchor.reason / freshness_probe / notarization / approval_gate），
// 零回归优先，维持 JSON.stringify 现状。
//
// 纪元 Ρ（双钥公证锁·收编入闸）：click_element 不再是安全洼地。
// 审计背景：本工具曾直调 system.clickMouse，完全绕过 actionGate/审批/验证/
// 交互性全链 —— 元素名带「删除/发送」或落点屏读危险文字时无需任何令牌即派发。
// 修法：执行路径必过 assertActionAllowed（与 click_mouse 同一事实源）：
//   · 模型自述通道：元素 label/text（a11y 登记名 —— 白盒自述）；
//   · 公证通道：落点邻域 OCR 实读（与 clickMouse 同一 notaryEvidence 取证面）。
// 命中危险 ⇒ 需已授予令牌（approval_token 参数）；OCR 实读与元素名不符 ⇒
// notary-mismatch（要求按屏幕实读重述）。其余增强（效果验证等）不在本纪元接全，
// 但闸门必须过。
//
// P2b-3（缺陷修复，出处=全库遍历报告·GENESIS 缝隙在册）：审批令牌的验收式
// 消费闭环（V 纪元「一次同意一次世界验证」之法）此前只在 click_mouse 接线 ——
// click_element 拿了令牌过闸却不烧毁：并发双花与重试预算在 ID 寻址通道敞开。
// 修法：与 click_mouse 同律 —— 派发前 approval.beginAttempt 原子预留（在途
// 互斥 + 预算派发前执法），派发后按世界验收：验证关闭 ⇒ 派发即消费（保守
// 旧方言）；验证生效 ⇒ consume 焚毁；验证未生效 ⇒ attemptFailed 续期供
// 同一授权内重试；派发异常 ⇒ attemptFailed 释放预留（B-3 异常重试语义）。
// 无令牌路径零变化（快照/预留/验收全部只挂在 dangerous && approval_token 上）。
//
// ΝΩ-5（W6R 收口对齐）：clickMouse 的两个安全收口移植到 ID 寻址通道 ——
//   · 新鲜度探针缺席/失败 ⇒ 拒绝派发（fail-closed，旧 degraded 放行废除；
//     逃生门 allowUnverifiedDangerous=true 恢复旧方言）；
//   · verifyActions=false 单独关闭 ⇒ dangerous 令牌动作派发前拒绝（旧
//     「派发即消费」只在 dry-run / 双钥匙逃生门下保持）。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system.js';
import { extractInteractiveElements } from '../uiExtractor.js';
import { toolOk, toolErr } from '../toolResult.js';
import { journal } from '../journal.js';
import { assertActionAllowed } from './actionGate.js';
import { notaryEvidence, notaryAnchorOf } from './clickMouse.js';
import { approval } from '../approval.js';
import { captureBefore, settleAndVerify } from '../actionVerifier.js';
import { consumeApprovalAmendment, gateByReversibility, laneAnchorOf } from './clickMouse.js';
import { probeGroundingFreshness } from '../popupDetector.js';
// ── P2b-3：验收取证面（notaryEvidence 同律的模块级可注入缝）──
// 生产路径恒等委托 actionVerifier 的既有导出（captureBefore / settleAndVerify
// 即 click_mouse 验收链的同一对辅助 —— 本文件零重实现，纯 import 复用）；
// 测试注入假件驱动 verified / no-effect 分支（真取证面要拉起 D-5 物理微服务，
// 离线确定性测试不可用 —— 与 clickMouse 的 OCR 假 provider 注入同法）。
export const elementVerify = { captureBefore, settleAndVerify };
export function createClickElementTool(config) {
    return defineTool({
        name: 'click_element',
        description: 'Clicks a UI element by its ID. The ID is obtained from the take_screenshot tool output. ' +
            'Subject to the same approval/notarization gate as click_mouse: irreversible elements ' +
            '(send/delete/pay/submit...) require an approval_token, and the screen text under the click ' +
            'point is independently notarized.',
        parameters: {
            id: {
                type: 'number',
                required: true,
                description: 'The ID of the UI element to click (e.g., 5 for element [5]).',
            },
            approval_token: {
                type: 'string',
                description: 'One-shot token from request_approval. Required when the element (or the screen text ' +
                    'read at its click point) matches an irreversible-action pattern (send/delete/pay/submit order...).',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            // P2b-3：令牌提取与派发预留簿记前置到 try 外 —— catch 路径结算预留时
            // 两者必须在场（try 内声明的局部量对 catch 不可见；clickMouse 同律）。
            const approval_token = typeof args.approval_token === 'string' ? args.approval_token : undefined;
            let attemptReserved = false;
            try {
                // 缓存窗口内命中：ID 与最近一次 take_screenshot 报告的完全一致
                const elements = await extractInteractiveElements();
                const target = elements.find(el => el.id === args.id);
                if (!target) {
                    return toolErr(`Element [${args.id}] click failed.`, 'Element ID not found in the current cache.', "The element cache may be stale. Call 'take_screenshot' to refresh element IDs, then retry.");
                }
                // 几何中心点击：元素 rect 中心即最稳的质心
                const centerX = target.rect.x + target.rect.width / 2;
                const centerY = target.rect.y + target.rect.height / 2;
                // ── W1-2 批注消费接线（W2-2）：闸门之前读 amendment patch 修正计划 ──
                // 修正后的元素描述参与危险判定（批注不得成为绕闸通道）；修正后的坐标
                //（若有）覆盖质心落点。getScreenSize 失败 ⇒ 无批注语义（旁路，不炸派发）。
                let effTargetName = target.name;
                let effCenterX = centerX;
                let effCenterY = centerY;
                let amendmentStamp;
                if (approval_token) {
                    try {
                        const s0 = await system.getScreenSize();
                        const nx0 = Math.min(1, Math.max(0, centerX / s0.width));
                        const ny0 = Math.min(1, Math.max(0, centerY / s0.height));
                        const am = consumeApprovalAmendment(approval_token, { tool: 'click_element', x: nx0, y: ny0, target_description: target.name });
                        if (am.target_description !== undefined)
                            effTargetName = am.target_description;
                        if (typeof am.x === 'number')
                            effCenterX = am.x * s0.width;
                        if (typeof am.y === 'number')
                            effCenterY = am.y * s0.height;
                        amendmentStamp = am.stamp;
                    }
                    catch { /* 批注读取是旁路义务：失败 = 无批注（零行为） */ }
                }
                // ── 纪元 Ρ（收编入闸）：click_element 与 click_mouse 同一事实源 ──
                // 元素 label/text（a11y 登记名）作模型自述通道；落点邻域 OCR 作公证通道
                //（与 clickMouse 共用 notaryEvidence 取证面：通道不可用 ⇒ null 诚实降级，
                // 取证失败绝不阻塞 —— 锁只在「通道在场且见危险/不符」时收紧）。
                let evidence;
                if (config.enableNotarizationLock && !config.dryRun) {
                    const avail = notaryEvidence.channelsAvailable(config);
                    if (avail.ocr || avail.structural) {
                        try {
                            const size = await system.getScreenSize();
                            const nx = Math.min(1, Math.max(0, effCenterX / size.width));
                            const ny = Math.min(1, Math.max(0, effCenterY / size.height));
                            evidence = {
                                ocrLabel: avail.ocr ? await notaryEvidence.readOcrLabel(config, nx, ny) : null,
                                structuralName: avail.structural ? await notaryEvidence.readStructuralName(config, nx, ny) : null,
                            };
                        }
                        catch {
                            evidence = undefined; // 宪法：取证失败 = 通道缺席，不阻塞
                        }
                    }
                }
                const gate = assertActionAllowed('click_mouse', { target_description: effTargetName, approval_token }, config, evidence);
                if (!gate.allowed) {
                    // 审计留痕：闸门拦截入防篡改链（GUARD_BLOCKED 方言，circuitBreaker 同律）
                    void journal.appendMarker({
                        kind: 'GUARD_BLOCKED',
                        guard: 'notary-lock',
                        reason: gate.reason === 'notary-mismatch'
                            ? 'notary-mismatch'
                            : `danger:${gate.dangerSignalChannel ?? 'unknown'}`,
                    }).catch(() => { });
                    if (gate.reason === 'notary-mismatch') {
                        const ocrSnippet = (evidence?.ocrLabel ?? '').slice(0, 60);
                        return JSON.stringify({
                            status: 'ACTION_REQUIRED',
                            state_anchor: {
                                element_id: target.id,
                                target: effTargetName,
                                reason: 'notary-mismatch',
                                notarization: notaryAnchorOf(gate.notarization, evidence, gate.notaryNote),
                                note: 'The text actually READ FROM THE SCREEN at this element does not match its label — ' +
                                    'the element may have changed since the last screenshot.',
                            },
                            next_step: `NOTARY MISMATCH: this point actually reads "${ocrSnippet}". Call 'take_screenshot' to ` +
                                'refresh the element list, then click the element whose label matches the text ACTUALLY ON SCREEN.',
                        }, null, 2);
                    }
                    return JSON.stringify({
                        status: 'ACTION_REQUIRED',
                        state_anchor: {
                            element_id: target.id,
                            target: effTargetName,
                            danger_signal: gate.dangerSignalChannel,
                            reason: gate.reason,
                            notarization: notaryAnchorOf(gate.notarization, evidence, gate.notaryNote),
                            note: approval_token
                                ? 'The token exists but the user has not granted it yet (or it expired).'
                                : 'This element looks irreversible (send/delete/pay/submit...) — the danger signal may come ' +
                                    'from the element label OR from the screen text read at its click point.',
                        },
                        next_step: 'PAUSE: this action needs explicit user approval. Call request_approval with a clear ' +
                            'description, tell the user what you are about to do, wait for their consent, call ' +
                            'grant_approval(token, true), then retry click_element with the returned approval_token ' +
                            "(or use click_mouse with it). Never proceed without consent.",
                    }, null, 2);
                }
                // ── P2b-3：验收式消费闭环（click_mouse V 纪元同律，溯源：clickMouse.ts
                // 「派发预留」与「阶段二·验收式消费」两块；辅助复用 approval.beginAttempt/
                // consume/attemptFailed 与 actionVerifier.captureBefore/settleAndVerify）──
                // 无令牌路径零变化：快照/预留/验收全部只挂在 dangerous && approval_token 上。
                const dangerous = gate.dangerous;
                // ── W5-0（C 接线 · W4-3 S5）：可逆性分道 —— 元素名即描述面 ──
                // 与 click_mouse 同律：三路执法在 beginAttempt 之前（compensable 先铸
                // 预案再预留）。开关关（缺省）⇒ applied:false 零行为。
                const laneGate = await gateByReversibility(config, {
                    tool: 'click_mouse', // ID 寻址的可逆性由元素目标语义决定（TOOL_SEMANTICS 刻意不收 click 工具键 —— 同 click_mouse 通道）
                    description: effTargetName,
                    ...(approval_token !== undefined ? { approvalToken: approval_token } : {}),
                    enforceEscrow: !!(dangerous && approval_token),
                });
                if (laneGate.applied && laneGate.blocked !== null) {
                    return laneGate.blocked;
                }
                // 效果快照（仅危险+令牌+验证开）：动作前帧，与派发之间隔着预留与
                // 物理点击 —— 快照必须先于派发取（clickMouse 同序）。
                let before = null;
                if (dangerous && approval_token && config.verifyActions && !config.dryRun) {
                    const vSize = await system.getScreenSize();
                    const vnx = Math.min(1, Math.max(0, effCenterX / vSize.width));
                    const vny = Math.min(1, Math.max(0, effCenterY / vSize.height));
                    before = await elementVerify.captureBefore({ x: vnx, y: vny }, config.regionVerifyRadius);
                }
                // ── W2-2（S3）：派发前接地新鲜度探针（approval.beginAttempt 之前）──
                // 危险元素点击的落点继承自 take_screenshot 缓存时刻 —— ID 寻址通道的
                // 接地时距比坐标通道更长。漂移 ⇒ 阻断并要求重新截图定位（结构化结果，
                // 令牌未烧）。
                // ΝΩ-5（W6R 收口移植 · clickMouse.ts freshnessStage 同律）：探针缺席/
                // 失败 ⇒ 拒绝派发（fail-closed）—— 旧「degraded 放行」把叠加防御的故障
                // 变成不可逆动作面的默认态。逃生门 allowUnverifiedDangerous=true 恢复
                // 降级放行（降级不静默：degraded 判决随锚点观测）；drifted 是阳性危险
                // 发现，不受逃生门豁免。非令牌动作不进本块（旧行为不变）。
                let freshnessStamp;
                if (dangerous && approval_token && !config.dryRun) {
                    const fresh = await probeGroundingFreshness();
                    freshnessStamp = fresh;
                    if (fresh.verdict === 'drifted') {
                        // 审计留痕：新鲜度拦截入防篡改链（GUARD_BLOCKED 方言，notary-lock 同律）
                        void journal.appendMarker({
                            kind: 'GUARD_BLOCKED',
                            guard: 'freshness-probe',
                            reason: `grounding-drift: similarity ${fresh.similarity_pct}% < threshold ${fresh.threshold_pct}%`,
                        }).catch(() => { });
                        return JSON.stringify({
                            status: 'ACTION_REQUIRED',
                            state_anchor: {
                                element_id: target.id,
                                target: effTargetName,
                                freshness_probe: fresh,
                                reason: 'grounding-stale',
                                note: 'The screen has changed materially since the screenshot this element ID was grounded ' +
                                    'against — the element cache is stale.',
                            },
                            next_step: 'STALE GROUNDING — do NOT retry this element ID. Call take_screenshot to refresh the ' +
                                'element list, RE-LOCATE the target, then click the (possibly renumbered) element. The approval ' +
                                'token is still valid (blocked before dispatch — no attempt was spent).',
                        }, null, 2);
                    }
                    // ΝΩ-5（W6R fail-closed）：探针缺席/失败 ⇒ 拒绝派发（令牌未烧 —— 阻断
                    // 在预留之前）。与 clickMouse.ts 同律：本探针保护的是「需要审批令牌的
                    // 动作」，证据缺席不等于证据无害。
                    if (fresh.verdict === 'degraded' && config.allowUnverifiedDangerous !== true) {
                        // 审计留痕：新鲜度拦截入防篡改链（GUARD_BLOCKED 方言，notary-lock 同律）
                        void journal.appendMarker({
                            kind: 'GUARD_BLOCKED',
                            guard: 'freshness-probe',
                            reason: `probe-unavailable: ${fresh.note ?? 'unknown'}`,
                        }).catch(() => { });
                        return JSON.stringify({
                            status: 'ACTION_REQUIRED',
                            state_anchor: {
                                element_id: target.id,
                                target: effTargetName,
                                freshness_probe: fresh,
                                reason: 'freshness-probe-unavailable',
                                note: 'This irreversible (approval-token) element click MUST be freshness-checked before ' +
                                    'dispatch, but the grounding-freshness probe is absent or failed ' +
                                    `(${fresh.note ?? 'unknown cause'}) — dispatch is refused (fail-closed), NOT silently degraded.`,
                            },
                            next_step: 'FRESHNESS PROBE UNAVAILABLE — the pre-dispatch grounding check could not run. ' +
                                'Ways out: (1) RETRY after taking a fresh screenshot (take_screenshot establishes the ' +
                                'grounding fingerprint the probe compares against); (2) ensure the physical service is ' +
                                'alive and the probe port is wired (production wires it by default; offline/dry-run ' +
                                'environments do not); (3) deployment-level explicit escape hatch: set ' +
                                'allowUnverifiedDangerous=true (accepts unverified dangerous dispatch). ' +
                                'The approval token is still valid (blocked before dispatch — no attempt was spent).',
                        }, null, 2);
                    }
                }
                // ── ΝΩ-5（W6R 验证旁路收口移植 · clickMouse verifyBypassStage 同律）──
                // verifyActions=false 单独关闭 ⇒ dangerous 令牌动作在派发前拒绝：旧
                // 「派发即消费（unverified-dispatch-consumed）」让一个 Token 经济开关
                // 静默旁路整个验收式消费体系。dry-run 豁免（无物理世界可验，令牌消费仅
                // 是模拟账面）；逃生门须两把钥匙齐备（verifyActions=false 且
                // allowUnverifiedDangerous=true）才回到旧方言。非 dangerous 动作维持
                // verifyActions 原语义。令牌未烧（阻断在预留之前，物理零派发）。
                if (dangerous && approval_token && !config.dryRun
                    && config.verifyActions !== true && config.allowUnverifiedDangerous !== true) {
                    return JSON.stringify({
                        status: 'ACTION_REQUIRED',
                        state_anchor: {
                            element_id: target.id,
                            target: effTargetName,
                            approval_gate: config.enableApprovalGate ? 'described' : 'gate-disabled',
                            reason: 'effect-verification-required',
                            note: 'Effect verification is the acceptance basis for approval-token (irreversible) ' +
                                'actions: the token is only consumed on a VERIFIED world effect. verifyActions=false ' +
                                'alone can no longer bypass that (the legacy bypass silently consumed the token on ' +
                                'dispatch, defeating the whole acceptance system).',
                        },
                        next_step: 'EFFECT VERIFICATION REQUIRED for this approval-token action, but verifyActions=false. ' +
                            'Ways out: (1) re-enable verifyActions=true (recommended — dangerous actions then verify ' +
                            'before/after and the token is consumed only on a verified effect); (2) deployment-level ' +
                            'explicit escape hatch: ALSO set allowUnverifiedDangerous=true (two explicit keys — accepts ' +
                            'legacy unverified-dispatch-consumed dialect for dangerous actions). ' +
                            'No physical dispatch happened and the approval token is still valid.',
                    }, null, 2);
                }
                // 派发预留：与 system.clickMouse 之间零 await（并发双花在落到物理
                // 世界之前即被拒）；预算耗尽在派发前焚毁。
                if (dangerous && approval_token) {
                    if (!approval.beginAttempt(approval_token)) {
                        approval.sweep();
                        return JSON.stringify({
                            status: 'ACTION_REQUIRED',
                            state_anchor: {
                                element_id: target.id,
                                target: effTargetName,
                                approval_gate: 'attempt-reservation-denied',
                                reason: 'attempt-in-flight-or-budget-exhausted',
                                note: 'The token is valid, but another attempt under it is still in flight, or its retry budget is exhausted.',
                            },
                            next_step: 'Do NOT re-invoke click_element concurrently with the same token — wait for the in-flight ' +
                                'attempt to settle. If the retry budget is exhausted, call request_approval again and explain to ' +
                                'the user why the action keeps failing.',
                        }, null, 2);
                    }
                    attemptReserved = true;
                }
                await system.clickMouse(Math.round(effCenterX), Math.round(effCenterY), 'left');
                // 世界验收：验证生效 ⇒ consume 焚毁；未生效 ⇒ attemptFailed 续期，
                // 同一授权内重试不再打扰用户（clickElement 无 expected_text/effect
                // 参数，不存在 intent-betrayed/semantic-mismatch 臂 —— 双分支即全谱）。
                // ΝΩ-5：验证关闭（effect=null ⇒ 派发即消费）只在 dry-run 或逃生门
                // （verifyActions=false 且 allowUnverifiedDangerous=true）下可达 ——
                // 派发前拒绝块已在闸上收口（见上方 verifyBypass 块）。
                let effect = null;
                if (before) {
                    effect = await elementVerify.settleAndVerify(before, {
                        adaptive: config.adaptiveSettle,
                        settleMs: config.actionSettleMs,
                        threshold: config.noopSimilarityThreshold,
                        regionRadius: config.regionVerifyRadius,
                        physicsRules: config.physicsRules,
                    });
                }
                let acceptance;
                if (dangerous && approval_token) {
                    if (!effect) {
                        approval.consume(approval_token);
                        acceptance = {
                            verdict: 'unverified-dispatch-consumed',
                            detail: 'Effect verification unavailable (verifyActions off / dry-run); token consumed on dispatch.',
                        };
                    }
                    else if (!effect.detected) {
                        const r = approval.attemptFailed(approval_token, 'no-effect');
                        acceptance = r.valid
                            ? {
                                verdict: 'retry-allowed', reason: 'no-effect', remaining_attempts: r.remainingAttempts,
                                detail: 'No verified world change — the click did NOT take effect (missed target / wrong window). ' +
                                    `Token STILL VALID (${r.remainingAttempts} attempts left): re-locate the element (take_screenshot) ` +
                                    'and RETRY within the SAME approval. Do NOT ask the user again.',
                            }
                            : {
                                verdict: 'budget-exhausted', reason: 'no-effect',
                                detail: 'Retry budget exhausted with no verified effect. The token is void. ' +
                                    'Call request_approval again and explain to the user why the action keeps failing.',
                            };
                    }
                    else {
                        approval.consume(approval_token);
                        acceptance = {
                            verdict: 'verified',
                            detail: 'Verified world change — user consent consumed by this irreversible effect. ' +
                                'Report the acceptance result to the user.',
                        };
                    }
                }
                // 重试指引前置：验收失败且令牌仍有效时，下一步就是纠偏重试（免二次确认）
                let nextStep = "Call 'take_screenshot' to verify the interaction took effect.";
                if (acceptance && acceptance.verdict === 'retry-allowed') {
                    nextStep = acceptance.detail + ' ' + nextStep;
                }
                return toolOk(`Clicked [${target.id}] [${target.role}] "${target.name}".`, {
                    element_id: target.id,
                    role: target.role,
                    name: target.name,
                    clicked_center_px: { x: Math.round(effCenterX), y: Math.round(effCenterY) },
                    // Ρ 纪元：本次点击已过闸（危险时 requiresApproval=true 且令牌已验证）
                    approval_gate: gate.requiresApproval ? 'notarized-approved' : 'described',
                    notarization: notaryAnchorOf(gate.notarization, evidence, gate.notaryNote) || undefined,
                    // P2b-3：验收裁决透明化（verified / unverified-dispatch-consumed /
                    // retry-allowed / budget-exhausted —— 仅危险+令牌路径在场）
                    effect: effect ? { detected: effect.detected, scale: effect.scale } : undefined,
                    acceptance: acceptance || undefined,
                    // W2-2（S3）：接地新鲜度探针判决（dangerous 路径在场；degraded 是
                    // fail-open 的诚实观测面）
                    freshness: freshnessStamp || undefined,
                    // W2-2（W1-2）：批注修正透明化 —— 用户批注把计划修正成了什么
                    amendment: amendmentStamp || undefined,
                    // W5-0（C 接线）：可逆性分道注记（快道/托管道 + 预案 id；未分道缺席）
                    reversibility_lane: laneAnchorOf(laneGate),
                }, nextStep);
            }
            catch (error) {
                // P2b-3：已预留的尝试在此结算（attemptFailed 只释放预留、不重复计数）
                // —— 令牌保留、TTL 续期，B-3 的「异常后同令牌重试」语义与 clickMouse 同律。
                if (attemptReserved && approval_token)
                    approval.attemptFailed(approval_token, 'dispatch-exception');
                return toolErr(`Element [${args.id}] click failed.`, error.message, "Call 'take_screenshot' to refresh the element list and retry, or fall back to 'click_mouse' with visual coordinates." +
                    (approval_token ? ' If an approval_token was used it is still valid for one retry.' : ''));
            }
        },
    });
}
