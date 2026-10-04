// src/tools/clickMouse.ts
// W6-2 结构性保留（doctor smell.over-engineering 登记）：click_mouse 工具面 —— 审批域/公证取证/接地新鲜度/验收消费在同一点击链路上线性串联（W 系列安全层逐环叠加），拆分即拆安全链。
// 世界级升级：三坐标换算锚点 + dHash 效果验证（盲点检测）+ 置信度自报 +
// 验证生效自动写入 UI 记忆。模型第一次能「感知自己是否点中了」。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system.js';
import { captureBefore, settleAndVerify } from '../actionVerifier.js';
import { focusTracker } from '../focusTracker.js';
import { semanticConfirm, readTextAny } from '../textReader.js';
import { matchesRiskPatterns, reversibilityRegistry, dispatchLaneFor } from '../riskGate.js';
import { approval } from '../approval.js';
import { uiMemory } from '../uiMemory.js';
import { regionDhash, similarity } from '../perceptualHash.js';
import { parseExpectation } from '../intent.js';
import { quantum } from '../quantumSense.js';
import { probePoints, gateTextClick } from '../interactivityProbe.js';
import { extractUrls } from '../urlSense.js';
import { toolErr } from '../toolResult.js';
import { journal } from '../journal.js';
import * as physicalBackend from '../physicalBackend.js';
import { encodeForVlm } from '../vlm/codec.js';
import { askRefutation, refuteCourtInSession } from '../vlm/refute.js';
import { probeGroundingFreshness } from '../popupDetector.js';
import { assertActionAllowed } from './actionGate.js';
import { reversalEscrow } from '../reversalEscrow.js';
/** W2-2：派发前消费批注 patch（clickMouse/clickElement/dragMouse 共用原语）。 */
export function consumeApprovalAmendment(token, plan) {
    if (!token)
        return {};
    try {
        const patched = approval.applyAmendment(token, plan);
        const corrected = {};
        const ignored = [];
        let px;
        let py;
        let pd;
        if (typeof patched.x === 'number' && Number.isFinite(patched.x)) {
            if (patched.x < 0 || patched.x > 1)
                ignored.push(`x=${patched.x}`);
            else if (patched.x !== plan.x) {
                px = patched.x;
                corrected.x = patched.x;
            }
        }
        if (typeof patched.y === 'number' && Number.isFinite(patched.y)) {
            if (patched.y < 0 || patched.y > 1)
                ignored.push(`y=${patched.y}`);
            else if (patched.y !== plan.y) {
                py = patched.y;
                corrected.y = patched.y;
            }
        }
        if (typeof patched.target_description === 'string' && patched.target_description
            && patched.target_description !== plan.target_description) {
            pd = patched.target_description;
            corrected.target_description = pd;
        }
        if (px === undefined && py === undefined && pd === undefined)
            return {};
        const am = approval.amendmentOf(token);
        return {
            x: px, y: py, target_description: pd,
            stamp: {
                applied: true,
                note: am?.note ?? '',
                corrected,
                ...(ignored.length > 0 ? { ignored_out_of_range: ignored } : {}),
            },
        };
    }
    catch {
        return {}; // 旁路宪法：批注读取失败 = 无批注（不炸派发主流程）
    }
}
// ─── 纪元 Ρ（双钥公证锁）：公证取证面 ───
//
// 审计背景：危险判定此前只信模型自述 —— 被提示注入的模型谎报目标即可绕过
// dangerPatterns 词表。本取证面在物理派发前对点击落点独立取证：
//   · OCR 实读（ocrLabel）：点击坐标邻域的一次轻量区域读屏（textReader 现成
//     路径：服务端 L2 优先，enableOcr 开启时 legacy tesseract 兜底）；
//   · 白盒控件名（structuralName）：UIA 点查询（physicalBackend.hitTest，
//     与 Z-1 探针同一判决源）—— 仅当 D-5 服务已在场时取（零孵化零新增调用）。
// 取证纪律（诚实降级律）：
//   · 通道不可用 ⇒ null —— 锁只在「通道在场且见危险/不符」时收紧，绝不因
//     公证取证失败而阻塞正常点击；
//   · 通道可用性的判定纯配置/纯在场（零物理调用）：OCR 通道随 enableOcr
//     （OCR 是部署显式开启的感知能力，公证不反向扩大能力面）；白盒通道随
//     enableInteractivityProbe（UIA 点查询属探针子系统，总闸关即视为白盒
//     通道不可用）且要求服务已存活（healthSnapshot 在场 —— 绝不为取证孵化）。
// 本对象是可注入缝（模块级可变属性）：测试注入假 OCR provider 断言闸门执法，
// 生产路径不经任何替换。
export const notaryEvidence = {
    /** 通道可用性（纯配置/在场判定 —— 零物理调用、零孵化、零网络） */
    channelsAvailable(config) {
        return {
            ocr: notaryOcrAvailable(config),
            structural: notaryStructuralAvailable(config),
        };
    },
    /** OCR 实读：点击点邻域区域读屏（失败/缺席 ⇒ null 诚实降级，绝不抛） */
    async readOcrLabel(config, nx, ny) {
        if (!notaryOcrAvailable(config))
            return null;
        try {
            // 邻域窗口：与效果验证的区域半径同源（regionVerifyRadius，缺省 0.15），
            // 夹取 [0.05, 0.25] —— 太小漏标签上下文，太大把整屏正文都读进来
            const r = Math.min(0.25, Math.max(0.05, config.regionVerifyRadius > 0 ? config.regionVerifyRadius : 0.15));
            const left = Math.max(0, nx - r);
            const top = Math.max(0, ny - r);
            const width = Math.min(1 - left, r * 2);
            const height = Math.min(1 - top, r * 2);
            if (width < 0.005 || height < 0.005)
                return null;
            const result = await readTextAny({ x: left, y: top, width, height }, config.ocrLang);
            const text = (result.text ?? '').replace(/\s+/g, ' ').trim();
            // 截断到公证预算：区域可能读回整段正文，词表扫描不需要长文
            return text ? text.slice(0, 200) : null;
        }
        catch {
            return null; // 双路径皆败：通道缺席，不阻塞正常点击
        }
    },
    /** 白盒控件名：UIA 点查询（服务在场才取 —— 零孵化；失败 ⇒ null） */
    async readStructuralName(config, nx, ny) {
        if (!notaryStructuralAvailable(config))
            return null;
        try {
            const hit = await physicalBackend.hitTest(nx, ny);
            if (!hit?.available)
                return null;
            const name = (hit.name ?? '').trim();
            return name ? name.slice(0, 120) : null;
        }
        catch {
            return null; // 端点缺席/COM 失败：通道缺席，不阻塞正常点击
        }
    },
};
function notaryOcrAvailable(config) {
    // OCR 是部署显式开启的感知能力（enableOcr 同时装载 read_text/find_text 与
    // 语义核对）；公证锁不反向扩大感知面 —— enableOcr=false 即视为 OCR 公证
    // 通道不可用（诚实 null），不为取证新增任何网络/孵化调用
    return config.enableOcr === true && !config.dryRun;
}
function notaryStructuralAvailable(config) {
    // UIA 点查询属交互性探针子系统（Z-1 通道 1）：探针总闸关闭即白盒通道不可用；
    // 且仅当 D-5 服务已在场（healthSnapshot 非空）才取 —— 取证绝不触发服务孵化
    return config.enableInteractivityProbe === true
        && !config.dryRun
        && physicalBackend.healthSnapshot() !== null;
}
/** Ρ 纪元：公证锚点（输出透明化用 —— verdict + 各通道在场情况/降级注记；
 *  clickElement 共用，导出为工具层公证方言的单一定义点） */
export function notaryAnchorOf(verdict, evidence, note) {
    if (verdict === undefined)
        return undefined; // 总开关关：锚点不入场（完全旧路径）
    return {
        verdict,
        ocr_label: evidence?.ocrLabel ? evidence.ocrLabel.slice(0, 80) : '(absent)',
        structural_name: evidence?.structuralName ?? '(absent)',
        note: note || undefined,
    };
}
/** W5-0（C）：分道闸（异步原语 —— escrow 道需 await mintPlan）。绝不抛。 */
export async function gateByReversibility(config, intent) {
    try {
        if (config?.enableReversibilityLanes !== true)
            return { applied: false, reason: 'disabled' };
        const verdict = reversibilityRegistry.classify({
            tool: intent.tool,
            description: intent.description,
        });
        if (verdict.semantics === 'unknown') {
            return { applied: false, reason: 'unknown-semantics' };
        }
        const lane = dispatchLaneFor(verdict.level);
        if (lane.humanExecution) {
            return {
                applied: true, verdict, lane, blocked: JSON.stringify({
                    status: 'ACTION_REQUIRED',
                    state_anchor: {
                        reason: 'reversibility-human-lane',
                        reversibility: {
                            level: verdict.level,
                            semantics: verdict.semantics,
                            source: verdict.source,
                            lane: lane.lane,
                            note: lane.note,
                        },
                    },
                    next_step: 'IRREVERSIBLE by classification: an action whose effect cannot be undone must be performed ' +
                        'by the HUMAN personally. Relay to the user what needs to be done and where; do NOT retry automated ' +
                        'dispatch for this intent while reversibility lanes are enabled.',
                }, null, 2),
            };
        }
        if (lane.requiresEscrowPlan && intent.enforceEscrow) {
            const minted = await reversalEscrow.mintPlan({
                semantics: verdict.semantics,
                ...(intent.description !== undefined ? { description: intent.description } : {}),
                ...(intent.approvalToken !== undefined ? { approvalToken: intent.approvalToken } : {}),
                tool: intent.tool,
            });
            if (!minted.ok) {
                return {
                    applied: true, verdict, lane,
                    blocked: JSON.stringify({
                        status: 'ACTION_REQUIRED',
                        state_anchor: {
                            reason: 'reversibility-escrow-unavailable',
                            reversibility: {
                                level: verdict.level,
                                semantics: verdict.semantics,
                                lane: lane.lane,
                                mint_failure: minted.reason,
                            },
                            note: minted.detail ?? 'no hosted compensation plan could be minted — fail-closed',
                        },
                        next_step: 'COMPENSABLE action without a mintageable reversal plan: dispatch refused (fail-closed). ' +
                            'The HUMAN must perform this action personally, or the deployment must extend the compensation ' +
                            'strategy table for this semantics.',
                    }, null, 2),
                };
            }
            return { applied: true, verdict, lane, escrowPlanId: minted.plan.planId, blocked: null };
        }
        return { applied: true, verdict, lane, blocked: null };
    }
    catch {
        return { applied: false, reason: 'disabled' }; // 防御式：分道故障 = 未分道
    }
}
/** W5-0（C）：分道注记（state_anchor.reversibility_lane 的铸造面；applied:false ⇒ undefined） */
export function laneAnchorOf(gate) {
    if (!gate.applied)
        return undefined;
    return {
        level: gate.verdict.level,
        semantics: gate.verdict.semantics,
        lane: gate.lane.lane,
        ...(gate.escrowPlanId !== undefined ? { escrow_plan: gate.escrowPlanId } : {}),
    };
}
// ─── 纪元 Β（反驳法院）：对抗核验取证面 ───
//
// 截图 + 压缩编码为异构第二脑的呈堂证据：encodeForVlm 优先（长边压缩 + JPEG，
// 与 ask_screen 同一编码纪律）；编码失败（sharp 缺席/残图）回退原图直送。
// 取证失败一律 null（诚实缺席）—— 法院不审无据之案，但绝不因取证失败阻塞
// 点击主流程（askRefutation 收到空证据 ⇒ 缺席审判 uncertain ⇒ 不拦）。
async function captureRefuteEvidence() {
    try {
        const buf = await system.captureScreen();
        if (!Buffer.isBuffer(buf) || buf.length === 0)
            return null;
        try {
            const enc = await encodeForVlm(buf);
            if (enc.ok && enc.value && enc.value.base64) {
                return { base64: enc.value.base64, mime: enc.value.mime };
            }
        }
        catch { /* 编码失败回退原图直送 */ }
        return { base64: buf.toString('base64'), mime: 'image/png' };
    }
    catch {
        return null; // 截屏通道缺席 —— 缺席审判，不阻塞
    }
}
export function createClickMouseTool(config) {
    return defineTool({
        name: 'click_mouse',
        description: 'Clicks the mouse at normalized coordinates (0.0 to 1.0). ' +
            'Effect verification is built-in: the result tells you whether the screen actually changed. ' +
            'target_description is REQUIRED (protocol level): every click must name its target — ' +
            'it feeds UI memory and the risk/approval gate; a click that cannot describe its ' +
            'target is a click that cannot be verified. ' +
            'The click point is independently notarized (OCR screen-read + whitebox control name): ' +
            'describe the target USING THE TEXT ACTUALLY SHOWN ON IT — a description that contradicts ' +
            'the screen is rejected (notary-mismatch).',
        parameters: {
            x: { type: 'number', required: true, description: 'X coordinate (0.0-1.0)' },
            y: { type: 'number', required: true, description: 'Y coordinate (0.0-1.0)' },
            button: { type: 'string', description: 'left, right, or middle' },
            confidence: {
                type: 'number',
                description: 'Your confidence in these coordinates (0.0-1.0). If below 0.6, consider zoom_inspect first.',
            },
            target_description: {
                type: 'string',
                // O 纪元（#18）：协议强制 —— 审批盲区的模型侧根除。schema 必填 ⇒
                // harness 在调用前就拒绝无描述点击（N 纪元的运行时硬前置是第二道闸）。
                required: true,
                description: 'Short description of what you are clicking (e.g., "GitHub 搜索框"). REQUIRED — ' +
                    'used for UI memory and the credential/danger gate.',
            },
            expected_change: {
                type: 'string',
                description: 'What visual change do you EXPECT if the click succeeds? e.g., "a dropdown expands", "input gains focus". Used to verify the effect semantically.',
            },
            expected_text: {
                type: 'string',
                description: 'Text you EXPECT to appear near the click point if it succeeds (requires enableOcr). The system OCR-verifies it automatically.',
            },
            from_memory_id: {
                type: 'number',
                description: 'Landmark ID from recall_ui. When provided, the system PRE-VERIFIES locally that the target still looks like it did when remembered — clicks on moved/changed targets are aborted before execution.',
            },
            approval_token: {
                type: 'string',
                description: 'One-shot token from request_approval. Required for irreversible targets (send/delete/pay/submit order...).',
            },
            // ── C-1 意图感知验证：声明预期，物理规则引擎带着预期找证据 ──
            expected_effect: {
                type: 'string',
                description: 'EXPECTED visual effect if this click succeeds — a kind string or JSON. Kinds: ' +
                    'toggle_on (checkmark appears), toggle_off, menu_expand (dropdown opens), menu_collapse, ' +
                    'input_focus (caret appears), page_navigate. Example: {"kind":"menu_expand"}',
            },
            reasoning: {
                type: 'string',
                description: 'Why you chose this action (one sentence). Recorded into the causal journal for later counterfactual analysis.',
            },
            allow_text_click: {
                type: 'boolean',
                description: 'Set true ONLY when you DELIBERATELY intend to click static text — place a caret in a document, ' +
                    'select a text span. The OS interactivity gate refuses left-clicks on static content by default: ' +
                    'conversation/document text that merely MENTIONS a label ("点击登录按钮" rendered in a chat) is NOT a clickable entry.',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            const { x: rawX, y: rawY, button = 'left', confidence, expected_change, expected_text, from_memory_id, approval_token, expected_effect, reasoning, allow_text_click } = args;
            const rawTarget = typeof args.target_description === 'string' ? args.target_description : undefined;
            // 双保险校验（Guard 已在前线，工具自查兜底）
            if (rawX < 0 || rawX > 1 || rawY < 0 || rawY > 1) {
                return toolErr('Click validation failed.', `Invalid normalized coordinates (${rawX}, ${rawY}). X and Y must be between 0.0 and 1.0.`, 'Re-estimate the target center from the latest screenshot; zoom_inspect can refine the estimate.');
            }
            // ── W1-2 批注消费接线：派发前读 amendment patch 修正计划 ──
            // 位置刻意在 assertActionAllowed **之前**（「beginAttempt 前」的最强形式）：
            // 用户批注修正后的 target_description 参与危险判定 —— 修正出危险语义的
            // 计划同样要过审批闸门，批注不得成为绕闸通道。无令牌/无批注 ⇒ 零行为。
            const amendment = consumeApprovalAmendment(approval_token, { tool: 'click_mouse', x: rawX, y: rawY, target_description: rawTarget });
            const x = amendment.x ?? rawX;
            const y = amendment.y ?? rawY;
            const target_description = amendment.target_description ?? rawTarget;
            // ── 不可逆操作闸门（第六轮 + B-3 两阶段 + J 纪元授予门 + N 纪元硬前置）──
            // 危险目标必须持**已授予**的有效令牌（grant_approval 落点 approval.grant ——
            // "从未 grant" 与 "grant=true" 不再等价）。
            // J 纪元升级（盲区收窄）：expected_text 作为**第二危险信号** —— 模型即使
            // 不填 target_description，声明"预期出现『发送/支付』字样"（expected_text
            // 本就是模型对该按钮的自述）同样触发闸门。旧的 `!!target_description`
            // 前置条件使"沉默不填描述"成为绕过通道；现在绕过需要同时沉默两条
            // 独立信号通道。
            // Δ 纪元（审计#1）：判定抽取至 actionGate.assertActionAllowed —— 工具层与
            // 重放层（replayOne）共用同一事实源；此处语义与原工具内实现逐条等价
            // （危险信号计算 / 拒绝归因 / sweep 副作用 / undescribed-click 硬前置）。
            // 阶段一 validate：只查不烧 —— 点击若抛异常，令牌仍可用于重试；
            // 阶段二 consume 在动作成功返回前调用（见下方 finally 前的成功路径）。
            const gate = assertActionAllowed('click_mouse', { target_description, expected_text, approval_token }, config);
            if (!gate.allowed) {
                if (gate.reason === 'undescribed-click') {
                    return JSON.stringify({
                        status: 'ACTION_REQUIRED',
                        state_anchor: { reason: 'undescribed-click', note: 'approval gate cannot judge an undescribed target' },
                        next_step: 'Re-invoke click_mouse with target_description (what you are clicking) or expected_text ' +
                            '(text you expect to appear) — the approval gate requires one description channel to judge irreversibility.',
                    }, null, 2);
                }
                return JSON.stringify({
                    status: 'ACTION_REQUIRED',
                    state_anchor: {
                        target: target_description ?? expected_text ?? '(undescribed target)',
                        danger_signal: gate.dangerSignalChannel,
                        reason: gate.reason,
                        note: approval_token
                            ? 'The token exists but the user has not granted it yet (or it expired).'
                            : 'This target looks irreversible (send/delete/pay/submit...).',
                    },
                    next_step: 'PAUSE: this action needs explicit user approval. Call request_approval with a clear ' +
                        'description, tell the user what you are about to do, wait for their consent, call ' +
                        'grant_approval(token, true), then re-invoke click_mouse with the returned approval_token. ' +
                        'Never proceed without consent.',
                }, null, 2);
            }
            // ── 纪元 Ρ（双钥公证锁·第二遍）：放行路径上的多通道公证 ──
            // 第一遍（上方）保持 Ρ 之前的全部阻断语义 —— 危险/未授予/未描述的点击
            // 在取证之前就被拒（阻断路径零新增物理/网络副作用，逐字节旧方言）。
            // 只有本来就会派发的点击才付出取证成本：落点邻域 OCR 实读 + 白盒控件名，
            // 携证据重审 —— 任一通道见危险 ⇒ 审批域执法；OCR 实读与模型自述不符 ⇒
            // notary-mismatch（注入谎报目标的根除点）。取证失败一律 null（诚实降级），
            // 绝不因公证取证失败而阻塞正常点击：锁只在「通道在场且见危险/不符」时收紧。
            let gate2 = gate;
            let notarization;
            if (config.enableNotarizationLock && !config.dryRun) {
                const avail = notaryEvidence.channelsAvailable(config);
                if (avail.ocr || avail.structural) {
                    let evidence;
                    try {
                        evidence = {
                            ocrLabel: avail.ocr ? await notaryEvidence.readOcrLabel(config, x, y) : null,
                            structuralName: avail.structural ? await notaryEvidence.readStructuralName(config, x, y) : null,
                        };
                        gate2 = assertActionAllowed('click_mouse', { target_description, expected_text, approval_token }, config, evidence);
                    }
                    catch {
                        // 宪法：运行层永不抛 —— 取证自身失败 = 通道缺席，维持第一遍判决
                        evidence = undefined;
                        gate2 = gate;
                    }
                    notarization = notaryAnchorOf(gate2.notarization, evidence, gate2.notaryNote);
                    if (!gate2.allowed) {
                        // 审计留痕：公证拦截入防篡改链（GUARD_BLOCKED 方言，circuitBreaker 同律）
                        void journal.appendMarker({
                            kind: 'GUARD_BLOCKED',
                            guard: 'notary-lock',
                            reason: gate2.reason === 'notary-mismatch'
                                ? 'notary-mismatch'
                                : `danger:${gate2.dangerSignalChannel ?? 'unknown'}`,
                        }).catch(() => { });
                        if (gate2.reason === 'notary-mismatch') {
                            const ocrSnippet = (evidence?.ocrLabel ?? '').slice(0, 60);
                            return JSON.stringify({
                                status: 'ACTION_REQUIRED',
                                state_anchor: {
                                    target: target_description ?? expected_text ?? '(undescribed target)',
                                    reason: 'notary-mismatch',
                                    notarization,
                                    note: 'The text actually READ FROM THE SCREEN at this point does not match your description ' +
                                        '(semantic handshake failed) — the target may have moved, or the description is wrong.',
                                },
                                next_step: `NOTARY MISMATCH: this point actually reads "${ocrSnippet}". RE-DESCRIBE the target ` +
                                    'using the text ACTUALLY SHOWN ON SCREEN (put it in target_description) and retry the click. ' +
                                    "If the screen has changed, call 'take_screenshot' first and re-locate the target. " +
                                    'Do not reuse the mismatched description.',
                            }, null, 2);
                        }
                        return JSON.stringify({
                            status: 'ACTION_REQUIRED',
                            state_anchor: {
                                target: target_description ?? expected_text ?? '(undescribed target)',
                                danger_signal: gate2.dangerSignalChannel,
                                reason: gate2.reason,
                                notarization,
                                note: approval_token
                                    ? 'The token exists but the user has not granted it yet (or it expired).'
                                    : 'This target looks irreversible (send/delete/pay/submit...) — the danger was NOTARIZED FROM ' +
                                        'THE SCREEN (OCR-read label / whitebox control name), not taken from your description.',
                            },
                            next_step: 'PAUSE: this action needs explicit user approval. Call request_approval with a clear ' +
                                'description (quote the text actually shown on the target), tell the user what you are about to ' +
                                'do, wait for their consent, call grant_approval(token, true), then re-invoke click_mouse with ' +
                                'the returned approval_token. Never proceed without consent.',
                        }, null, 2);
                    }
                }
                else {
                    notarization = notaryAnchorOf('degraded', undefined, 'notary-channels-unavailable');
                }
            }
            const dangerous = gate2.dangerous;
            const gateCoverage = config.enableApprovalGate ? 'described' : 'gate-disabled';
            // ── W5-0（C 接线 · W4-3 S5）：可逆性分道 —— 物理派发前的三路执法 ──
            // 位置在全部既有闸门（危险词/公证/批注）之后、beginAttempt 之前：
            // compensable 的逆转预案必须先于派发预留铸造（dispatchLaneFor 的字面序）。
            // 开关关（缺省）⇒ applied:false 零行为；未知语义交回危险词闸门（保守律 ②）。
            const laneGate = await gateByReversibility(config, {
                tool: 'click_mouse',
                description: target_description ?? expected_text,
                ...(approval_token !== undefined ? { approvalToken: approval_token } : {}),
                enforceEscrow: !!(dangerous && approval_token),
            });
            if (laneGate.applied && laneGate.blocked !== null) {
                return laneGate.blocked;
            }
            // ── 纪元 Β（反驳法院）：不可逆动作派发前的跨模型对抗核验 ──
            // 窄门执法三前置（缺一不开庭，非危险动作零法院调用 —— 性能铁律：法院只审
            // 不可逆）：危险词命中（能走到这里的危险点击必已持有效令牌，即将物理派发）
            // + enableRefuteCourt 开 + 会话内有异构第二脑（refuteCourtInSession 纯配置
            // /在场判定，零网络零拨号）。判决执法（沿 notary-lock 方言）：
            //   refuted   ⇒ 拦截（toolErr + guard:'refute-court' + next_step 人工复核
            //               指引 + journal GUARD_BLOCKED 留痕）；拦截发生在 beginAttempt
            //               之前 —— 令牌不烧、尝试不占，人工复核后可原令牌重试；
            //   upheld    ⇒ 放行 + 锚点注记 refute:'upheld'（认真反驳后维持的可信度
            //               加成，透明化）；
            //   uncertain ⇒ 缺席审判零行为 —— 不拦、不注记，输出与法院关闭时逐字节
            //               同路。法院是旁路增益不是依赖：故障（无第二脑/调用失败/
            //               超时 8s 单次不重试）绝不下沉为点击主流程的阻塞。askRefutation
            //               自身永不抛，本块对主流程的唯一可见副作用是上述两分支。
            let refuteStamp;
            if (dangerous && config.enableRefuteCourt === true && !config.dryRun && refuteCourtInSession()) {
                const evidence = await captureRefuteEvidence();
                // 目标区域聚焦注记：与 notary 邻域窗口同源（regionVerifyRadius 夹取）
                const rr = Math.min(0.25, Math.max(0.05, config.regionVerifyRadius > 0 ? config.regionVerifyRadius : 0.15));
                const rLeft = Math.max(0, x - rr);
                const rTop = Math.max(0, y - rr);
                const verdict = await askRefutation({
                    imageBase64: evidence ? evidence.base64 : '',
                    mime: evidence?.mime,
                    description: target_description ?? expected_text ?? 'the point being clicked',
                    region: {
                        x: rLeft,
                        y: rTop,
                        width: Math.min(1 - rLeft, rr * 2),
                        height: Math.min(1 - rTop, rr * 2),
                    },
                });
                if (verdict.verdict === 'refuted') {
                    // 审计留痕：反驳拦截入防篡改链（GUARD_BLOCKED 方言，notary-lock 同律）
                    void journal.appendMarker({
                        kind: 'GUARD_BLOCKED',
                        guard: 'refute-court',
                        reason: `second-brain-refuted:${verdict.secondOpinionId ?? 'unknown'}`,
                    }).catch(() => { });
                    return toolErr(`Irreversible click on "${target_description ?? 'undescribed target'}" blocked by the refutation court.`, `An independent second brain (${verdict.secondOpinionId ?? 'heterogeneous second opinion'}) examined the ` +
                        'screen and found CONTRADICTING evidence (guard: refute-court): ' +
                        `${verdict.reason ?? 'no reason given'} (confidence ${verdict.confidence.toFixed(2)}).`, 'PAUSE: do NOT retry this click as-is. The target description did not survive adversarial review — ' +
                        'ask the USER to manually verify this target on screen (take_screenshot / zoom_inspect around the point) ' +
                        'and confirm what it actually is before any retry; if the user confirms the target, re-invoke with a ' +
                        'corrected target_description (the approval token is still valid — the court blocked before dispatch).');
                }
                if (verdict.verdict === 'upheld')
                    refuteStamp = 'upheld';
                // uncertain ⇒ 缺席审判零行为（不拦、不注记 —— 见上方法条）
            }
            // W2-2（S3）：派发前接地新鲜度探针的判决（成功路径透明化用）
            let freshnessStamp;
            // Δ 纪元（审计#2）：本回合是否已持有 beginAttempt 的派发预留（catch 路径
            // 需据此结算 —— 见下方异常分支）
            let attemptReserved = false;
            try {
                const size = await system.getScreenSize();
                const px = Math.round(x * size.width);
                const py = Math.round(y * size.height);
                // ── 记忆预验（第六轮）：点击前本地核实目标还在原位 ──
                // recall_ui 给的是历史坐标；屏幕可能已变。取当前屏同位置区域指纹与
                // 记忆时的目标外观对比：不像 ⇒ 目标已移动/消失，点击中止（防 stale-click）
                let preVerified;
                if (typeof from_memory_id === 'number' && !config.dryRun) {
                    const lm = uiMemory.get(from_memory_id);
                    if (!lm) {
                        return toolErr(`Landmark #${from_memory_id} click aborted.`, 'Landmark not found in memory.', "Call 'recall_ui' to refresh landmark IDs, then retry with the correct from_memory_id.");
                    }
                    if (lm.regionHash) {
                        const curBuf = await system.captureScreen();
                        const curRegion = await regionDhash(curBuf, lm.normalized.x, lm.normalized.y, config.regionVerifyRadius);
                        const matchScore = similarity(curRegion, lm.regionHash);
                        if (matchScore < 0.85) {
                            return JSON.stringify({
                                status: 'FAILED',
                                state_anchor: {
                                    pre_verification: {
                                        landmark: from_memory_id,
                                        appearance_similarity_pct: Math.round(matchScore * 1000) / 10,
                                        verdict: 'target-changed',
                                    },
                                },
                                next_step: 'ABORTED BEFORE CLICK: the target region no longer looks like it did when remembered ' +
                                    '(the UI probably changed). Do NOT click stale coordinates — take a fresh screenshot and re-locate.',
                            }, null, 2);
                        }
                        preVerified = true;
                    }
                }
                // ── Z-2 交互性闸门：指针落下之前，先问世界「这是控件还是正文」──
                // 对症失败模式：「模型将输出的正文当作点击的按钮」。Z-1 的判决只标注
                // 在 find_text 结果里（模型可以不看）；此处把同一三通道探针（UIA 结构层
                // > 悬停光标 > 场景记忆）前移到点击执行前 —— 静态正文（Text/Document，
                // 非 Edit 输入框）上的左键点击被结构化否决。右键（正文上的上下文菜单
                // 是合法动作）与 dry-run（无物理世界可问）不适用；模型明知点正文时可
                // 以 allow_text_click 自证（文档放置光标/选中文本）。
                // 顺序：闸门必须在 captureBefore 之前 —— 悬停实验可能触发 hover 高亮，
                // before 帧只能在探针之后取，否则高亮会污染「无变化」基线。
                if (config.enableInteractivityProbe && !config.dryRun && button === 'left') {
                    const [probe] = await probePoints(config, [{ x, y }]);
                    const gate = gateTextClick(probe, { allowTextClick: allow_text_click === true });
                    if (gate.blocked) {
                        console.warn(`[Interactivity Gate] Blocked click on static text: ${gate.evidence}`);
                        // AA-1 跳转出口：被否决的正文里若含 URL，拒绝即改道指引 ——
                        // 「别点，跳」。UIA 的控件名是该点文字内容的官方回执（≤40 字符），
                        // 零成本复用；悬停通道无文本回执，保持原语义。
                        const textContent = probe?.evidence.hit_test?.name;
                        const urls = textContent ? extractUrls(textContent) : [];
                        const jumpHint = urls.length > 0
                            ? ` The static text contains a URL: ${urls[0]} — if your goal is to open it, call 'open_url' with it instead of clicking.`
                            : '';
                        return JSON.stringify({
                            status: 'ACTION_REQUIRED',
                            state_anchor: {
                                target: target_description ?? '(undescribed target)',
                                interactivity_gate: {
                                    verdict: 'text',
                                    reason: gate.reason,
                                    evidence: gate.evidence,
                                    note: probe?.note,
                                },
                            },
                            next_step: 'This point is STATIC CONTENT (chat message / document text), not a clickable control — the text merely ' +
                                'MENTIONS the label you are looking for. Do NOT retry the same coordinates. ' +
                                "Re-locate the real control: call 'find_text' with the label keyword and click ONLY a match with " +
                                'interactivity=control; or take_screenshot and search visually; the entry may need scroll_page or a ' +
                                'menu to be opened first. ' +
                                'If you DELIBERATELY want to click static text (place a caret in a document, select a span), ' +
                                're-invoke click_mouse with allow_text_click: true.' + jumpHint,
                        }, null, 2);
                    }
                }
                // ── 效果验证（双尺度 + C-1 意图感知）：动作前同时取全屏 + 点击点区域指纹 ──
                // 区域指纹放大局部反馈（光标/高亮/展开），弥补全屏 dHash 的局部盲区
                // C-1：声明了 expected_effect 时保留动作前帧 —— 物理规则需要前后两帧对比
                const expectation = config.intentVerify ? parseExpectation(expected_effect) : null;
                const verify = config.verifyActions && !config.dryRun;
                const before = verify
                    ? await captureBefore({ x, y }, config.regionVerifyRadius, !!expectation)
                    : null;
                // ── W2-2（S3）：派发前接地新鲜度探针（approval.beginAttempt 之前）──
                // 危险类点击（dangerous 经闸门判定 —— riskGate 词表的只读调用产物）的
                // 坐标来自接地时刻的截图；审批人机往返分钟级，屏幕可能已相变。派发前
                // 抓一帧低清快图（经注入端口）与接地指纹比对：漂移 ⇒ 阻断本次派发
                // （结构化「需重新截图定位」，供上层重感知；令牌未烧 —— 阻断在预留/派发
                // 之前）。
                // W6R（fail-open ⇒ fail-closed 收口）：本探针保护的恰是「需要审批令牌的
                // 动作」（dangerous 分级、走 beginAttempt/consume 的路径）—— 探针缺席或
                // 失败时降级放行等于把叠加防御的故障变成不可逆动作面的默认态。新法：
                // degraded（端口缺席 / 取帧失败 / 指纹缺席）⇒ 拒绝派发，错误信息指明
                // 原因与三条出路（重试 / 开探针 / 显式逃生门 allowUnverifiedDangerous）。
                // drifted（主动漂移证据）不受逃生门豁免 —— 那是阳性危险发现，不是证据
                // 缺席。非令牌动作不进入本块（叠加防御只挂危险令牌面，旧行为不变）。
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
                                target: target_description ?? expected_text ?? '(undescribed target)',
                                freshness_probe: fresh,
                                reason: 'grounding-stale',
                                note: 'The screen has changed materially since the screenshot these coordinates were ' +
                                    'grounded against — the click would land in a DIFFERENT world state.',
                            },
                            next_step: 'STALE GROUNDING — do NOT retry these coordinates. Call take_screenshot to ' +
                                're-capture the screen, RE-LOCATE the target from the fresh screenshot, then retry with ' +
                                'the new coordinates. The approval token is still valid (blocked before dispatch — no ' +
                                'attempt was spent).',
                        }, null, 2);
                    }
                    if (fresh.verdict === 'degraded' && config.allowUnverifiedDangerous !== true) {
                        // W6R fail-closed：探针缺席/失败 ⇒ 拒绝派发（令牌未烧 —— 阻断在预留之前）
                        void journal.appendMarker({
                            kind: 'GUARD_BLOCKED',
                            guard: 'freshness-probe',
                            reason: `probe-unavailable: ${fresh.note ?? 'unknown'}`,
                        }).catch(() => { });
                        return JSON.stringify({
                            status: 'ACTION_REQUIRED',
                            state_anchor: {
                                target: target_description ?? expected_text ?? '(undescribed target)',
                                freshness_probe: fresh,
                                reason: 'freshness-probe-unavailable',
                                note: 'This irreversible (approval-token) action MUST be freshness-checked before ' +
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
                // ── W6R（验证总开关旁路收口）：dangerous 令牌动作的效果验证不可被
                //    verifyActions 整体关闭（双重显式逃生门） ──
                // 旧缺陷：verifyActions=false ⇒ dangerous+token 走 unverified-dispatch-
                // consumed（令牌派发即焚）—— 整个效果验证体系（V 纪元验收式消费的依据）
                // 被一个 Token 经济开关静默旁路。新法：
                //   · verifyActions=false 且 allowUnverifiedDangerous !== true ⇒ 派发前
                //     拒绝并指明出路（本块）。dry-run 豁免：无物理世界可验，令牌消费仅
                //     是模拟账面；
                //   · verifyActions=false 且 allowUnverifiedDangerous === true ⇒ 旧方言
                //     保持（部署两把钥匙同时显式插入：既关验证又显式接受未验证危险派发）；
                //   · verifyActions=true（缺省）⇒ 零变化。
                // 非 dangerous 分级维持 verifyActions 原语义（benign 动作的验证仍是可关
                // 的 Token 经济开关 —— 本块只挂在 dangerous && approval_token 面上）。
                if (dangerous && approval_token && !config.dryRun
                    && config.verifyActions !== true && config.allowUnverifiedDangerous !== true) {
                    return JSON.stringify({
                        status: 'ACTION_REQUIRED',
                        state_anchor: {
                            target: target_description ?? expected_text ?? '(undescribed target)',
                            approval_gate: gateCoverage,
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
                // ── Δ 纪元（审计#2·双花窗口封堵）：派发预留 ──
                // validate（只查不烧）与验收式消费（consume/attemptFailed，见下方）之间
                // 隔着多个 await —— 并发两次同令牌调用都能过 validate、都派发物理点击。
                // beginAttempt 在物理派发前原子预留一次尝试（attempts +1 且同令牌同时
                // 只允许一个在途回合），与本行到 system.clickMouse 之间零 await ——
                // 并发的第二回合在落到物理世界之前即被拒（恰一次派发）。
                // 计数时序：预留 +1 → 验收通过 consume（焚毁，计数随行）/ 验收失败
                // attemptFailed（释放预留，不再重复 ++）—— 单次点击全链路 attempts 恰 +1；
                // 预算耗尽在派发前焚毁（旧实现第 maxAttempts+1 次点击仍会落到物理世界）。
                if (dangerous && approval_token) {
                    if (!approval.beginAttempt(approval_token)) {
                        approval.sweep();
                        return JSON.stringify({
                            status: 'ACTION_REQUIRED',
                            state_anchor: {
                                target: target_description ?? expected_text ?? '(undescribed target)',
                                approval_gate: 'attempt-reservation-denied',
                                reason: 'attempt-in-flight-or-budget-exhausted',
                                note: 'The token is valid, but another attempt under it is still in flight, or its retry budget is exhausted.',
                            },
                            next_step: 'Do NOT re-invoke click_mouse concurrently with the same token — wait for the in-flight ' +
                                'attempt to settle. If the retry budget is exhausted, call request_approval again and explain to ' +
                                'the user why the action keeps failing.',
                        }, null, 2);
                    }
                    attemptReserved = true;
                }
                await system.clickMouse(px, py, button);
                // 焦点登记：后续 type_text 的区域验证将以此为中心（隐式工具间上下文）。
                // 风险感知：目标描述命中凭据语义 ⇒ 焦点标记为敏感，后续输入将被闸门拦截
                const sensitive = config.enableRiskGate
                    && !!target_description
                    && matchesRiskPatterns(target_description, config.riskPatterns);
                focusTracker.set(x, y, sensitive);
                let effect = null;
                if (before) {
                    effect = await settleAndVerify(before, {
                        adaptive: config.adaptiveSettle,
                        settleMs: config.actionSettleMs,
                        threshold: config.noopSimilarityThreshold,
                        regionRadius: config.regionVerifyRadius,
                        physicsRules: config.physicsRules,
                    }, expectation);
                }
                // D-3 量子感知：验证证据喂给状态机（effect=null ⇒ undefined ⇒ 不计数）
                quantum.recordEffect(effect?.detected);
                // ── 自动记忆：验证生效 + 模型给了描述 ⇒ 写入场景记忆（含当时整屏指纹）──
                // regionHash（点击点邻域指纹）随行入库 —— from_memory_id 的 stale-click
                // 预验依赖它：无 regionHash 的 landmark 只能查存在性，无法比对外观
                let memoryNote = '';
                if (effect?.detected && config.autoRemember && target_description) {
                    const lm = uiMemory.remember(target_description, x, y, undefined, before?.screen, before?.region ?? undefined);
                    memoryNote = ` Landmark #${lm.id} saved.`;
                }
                // ── 语义核对（第四轮）：OCR 检查预期文字是否出现在点击点邻域 ──
                // 像素验证回答「有没有变化」，语义核对回答「变化是不是预期的内容」
                let semantic = null;
                if (expected_text && config.enableOcr && effect?.detected) {
                    semantic = await semanticConfirm(effect.afterBuffer, x, y, Math.max(config.regionVerifyRadius * 1.5, 0.2), expected_text, config.ocrLang) ?? 'ocr-unavailable';
                }
                // ── 自适应下一步指引：双尺度判定 + C-1 意图裁决 + 预期核对 ──
                const noopSuspected = effect && !effect.detected;
                const intentBetrayed = effect?.intent && !effect.intent.satisfied && effect.detected;
                const lowConfidence = typeof confidence === 'number' && confidence < 0.6;
                let nextStep = "MANDATORY: Call 'take_screenshot' to verify the UI state change.";
                if (intentBetrayed) {
                    nextStep = `INTENT MISMATCH: the screen changed but NOT in the expected way (${effect.intent.evidence}). ` +
                        'The click probably landed on the wrong element — treat as partial failure and re-examine.';
                }
                else if (noopSuspected) {
                    nextStep = 'WARNING: Neither the screen nor the clicked region changed — you may have MISSED the target. ' +
                        "Call 'zoom_inspect' around this point to refine coordinates, then retry.";
                }
                else if (lowConfidence) {
                    nextStep = "Low confidence reported. Consider 'zoom_inspect' for finer grounding before the next action.";
                }
                if (!noopSuspected && expected_change) {
                    nextStep += ` Then CONFIRM your expectation: "${expected_change}" — if it did NOT happen, treat this as a partial failure.`;
                }
                if (semantic && semantic !== 'ocr-unavailable' && !semantic.confirmed) {
                    nextStep = `SEMANTIC MISMATCH: expected text "${expected_text}" was NOT found near the click point. ` +
                        `Treat this click as FAILED even though pixels changed — re-examine with diff_view / take_screenshot.`;
                }
                if (sensitive) {
                    nextStep = 'SENSITIVE FIELD: this looks like a credentials/input-secret area. ' +
                        'Do NOT type secrets via type_text here — ask the USER to enter them personally, then continue with take_screenshot.';
                }
                // ── 阶段二（B-3 + V 纪元·验收式消费）：令牌只在验收通过时焚毁 ──
                // 验收判定 —— 世界说「成了」才算成了：
                //   验证关闭/dry-run（effect=null）⇒ 无法验收，退回派发即消费（保守：
                //     不能把「无法验收」当成「没生效」而放行无限制重试）。W6R 收口后该
                //     分支仅剩两条合法入口：dry-run（无物理世界可验）或双重显式逃生门
                //     （verifyActions=false 且 allowUnverifiedDangerous=true）—— 仅
                //     verifyActions=false 已在派发前被拒（effect-verification-required）；
                //   effect.detected=false ⇒ 点击未生效（点空/落错窗口）—— 世界没有发生
                //     不可逆变化，用户的同意未被消耗，令牌保留供同一授权内自动重试；
                //   intentBetrayed / semantic mismatch ⇒ 世界变了但不是预期的 —— 同样
                //     保留令牌让模型纠正后重试。
                // 一次用户确认覆盖整个任务：验收失败 ⇒ attemptFailed 登记（TTL 续期，
                // 次数递减），重试不再打扰用户；预算耗尽/超期 ⇒ 焚毁，重新审批。
                let acceptance;
                if (dangerous && approval_token) {
                    const semanticMismatched = !!(semantic && semantic !== 'ocr-unavailable' && !semantic.confirmed);
                    if (!effect) {
                        // 验证通道关闭（dry-run 或双重逃生门）：无从验收，维持旧方言（派发即消费，用后即焚）
                        approval.consume(approval_token);
                        acceptance = {
                            verdict: 'unverified-dispatch-consumed',
                            detail: 'Effect verification unavailable (dry-run, or verifyActions=false + ' +
                                'allowUnverifiedDangerous=true escape hatch); token consumed on dispatch.',
                        };
                    }
                    else if (!effect.detected) {
                        const r = approval.attemptFailed(approval_token, 'no-effect');
                        acceptance = r.valid
                            ? {
                                verdict: 'retry-allowed', reason: 'no-effect', remaining_attempts: r.remainingAttempts,
                                detail: 'No verified world change — the click did NOT take effect (missed target / wrong window). ' +
                                    `Token STILL VALID (${r.remainingAttempts} attempts left): fix coordinates or focus and RETRY within the SAME approval. ` +
                                    'Do NOT ask the user again — their consent covers this task until a verified effect.',
                            }
                            : {
                                verdict: 'budget-exhausted', reason: 'no-effect',
                                detail: 'Retry budget exhausted with no verified effect. The token is void. ' +
                                    'Call request_approval again and explain to the user why the action keeps failing.',
                            };
                    }
                    else if (intentBetrayed || semanticMismatched) {
                        const reason = semanticMismatched ? 'semantic-mismatch' : 'intent-betrayed';
                        const r = approval.attemptFailed(approval_token, reason);
                        acceptance = r.valid
                            ? {
                                verdict: 'retry-allowed', reason, remaining_attempts: r.remainingAttempts,
                                detail: 'The screen changed but NOT in the expected way — the click probably landed on the wrong element. ' +
                                    `Token STILL VALID (${r.remainingAttempts} attempts left): re-examine and RETRY within the SAME approval. ` +
                                    'Do NOT ask the user again.',
                            }
                            : {
                                verdict: 'budget-exhausted', reason,
                                detail: 'Retry budget exhausted with repeated wrong-element clicks. The token is void. ' +
                                    'Call request_approval again and explain to the user what keeps going wrong.',
                            };
                    }
                    else {
                        // 验收通过：世界出现了变化且与预期一致（或无更严苛的期望可核对）
                        approval.consume(approval_token);
                        acceptance = {
                            verdict: 'verified',
                            detail: 'Verified world change consistent with the expectation — user consent consumed by this irreversible effect. ' +
                                'Report the acceptance result to the user.',
                        };
                    }
                }
                // 重试指引前置：验收失败且令牌仍有效时，下一步就是纠偏重试（免二次确认）
                if (acceptance && acceptance.verdict === 'retry-allowed') {
                    nextStep = acceptance.detail + ' ' + nextStep;
                }
                return JSON.stringify({
                    status: 'SUCCESS',
                    action: `Mouse ${button} clicked.`,
                    state_anchor: {
                        normalized: { x, y },
                        absolute_pixels: { x: px, y: py },
                        screen_resolution: `${size.width}x${size.height}`,
                        effect: effect ? {
                            detected: effect.detected,
                            scale: effect.scale, // page-level / element-level / none
                            screen_similarity_pct: effect.screen.similarity_pct,
                            region_similarity_pct: effect.region ? effect.region.similarity_pct : undefined,
                            // C-1 意图裁决：期望 kind + 物理证据（与 detected 分歧 = 高级幻觉警报）
                            intent: effect.intent ?? undefined,
                        } : 'verification-off',
                        expected_change: expected_change || undefined, // 预期锚定：模型行动前声明的预期
                        sensitive_focus: sensitive || undefined, // 风险闸门：焦点已标记为凭据区
                        // J 纪元：审批网覆盖情况透明化（described / blind-spot / gate-disabled）
                        approval_gate: gateCoverage,
                        // Ρ 纪元：双钥公证参与情况透明化（engaged/degraded + 各通道在场情况；
                        // 总开关关 ⇒ 键不入场 —— 完全旧路径）
                        notarization: notarization || undefined,
                        // Β 纪元：反驳法院参与情况透明化 —— 'upheld' = 异构第二脑认真反驳后
                        // 维持「目标=描述」；uncertain/缺席 ⇒ 键不入场（缺席审判零行为，
                        // 输出与法院关闭时同路）
                        refute: refuteStamp || undefined,
                        // W2-2（S3）：接地新鲜度探针判决（dangerous 令牌路径在场）。W6R 后
                        // degraded 只在逃生门（allowUnverifiedDangerous=true）下才能到达成功
                        // 路径 —— 缺席即拒绝（fail-closed），这里的 degraded 是逃生门下的
                        // 诚实观测面（模型/遥测仍看得见防御缺席）
                        freshness: freshnessStamp || undefined,
                        // W5-0（C 接线）：可逆性分道注记（快道/托管道 + 预案 id；未分道缺席）
                        reversibility_lane: laneAnchorOf(laneGate),
                        // W2-2（W1-2）：批注修正透明化 —— 用户批注把计划修正成了什么
                        amendment: amendment.stamp || undefined,
                        // V 纪元：验收裁决 —— verified（通过，令牌已焚毁）/ retry-allowed
                        // （未生效，令牌保留，重试免确认）/ budget-exhausted（预算耗尽，需重新审批）
                        acceptance: acceptance || undefined,
                        semantic: semantic
                            ? (semantic === 'ocr-unavailable'
                                ? 'ocr-unavailable'
                                : { expected_text: expected_text, confirmed: semantic.confirmed, region_text_snippet: semantic.snippet })
                            : undefined,
                    },
                    memory: memoryNote || undefined,
                    next_step: nextStep,
                    // 预验结果透明化：本次点击是否经过 from_memory_id 外观比对
                    pre_verified: preVerified === undefined ? undefined : { landmark: from_memory_id, appearance_match: true },
                }, null, 2);
            }
            catch (error) {
                // B-3 注：异常路径不烧审批令牌（validate 只查不烧；consume 仅在成功 return 前调用）
                // Δ 纪元（审计#2）：已预留的尝试在此结算（attemptFailed 只释放预留、不重复
                // 计数）—— 令牌保留、TTL 续期，B-3 的「异常后同令牌重试」语义原样保持。
                if (attemptReserved && approval_token)
                    approval.attemptFailed(approval_token, 'dispatch-exception');
                return toolErr(`Mouse ${button} click at (${x}, ${y}) failed.`, error.message, 'Analyze the error and try a different approach; if an approval_token was used it is still valid for one retry.');
            }
        },
    });
}
