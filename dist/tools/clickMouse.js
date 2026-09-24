// src/tools/clickMouse.ts
// 世界级升级：三坐标换算锚点 + dHash 效果验证（盲点检测）+ 置信度自报 +
// 验证生效自动写入 UI 记忆。模型第一次能「感知自己是否点中了」。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system.js';
import { captureBefore, settleAndVerify } from '../actionVerifier.js';
import { focusTracker } from '../focusTracker.js';
import { semanticConfirm } from '../textReader.js';
import { matchesRiskPatterns, matchesDangerPatterns } from '../riskGate.js';
import { approval } from '../approval.js';
import { uiMemory } from '../uiMemory.js';
import { regionDhash, similarity } from '../perceptualHash.js';
import { parseExpectation } from '../intent.js';
import { quantum } from '../quantumSense.js';
import { probePoints, gateTextClick } from '../interactivityProbe.js';
import { extractUrls } from '../urlSense.js';
import { toolErr } from '../toolResult.js';
export function createClickMouseTool(config) {
    return defineTool({
        name: 'click_mouse',
        description: 'Clicks the mouse at normalized coordinates (0.0 to 1.0). ' +
            'Effect verification is built-in: the result tells you whether the screen actually changed. ' +
            'target_description is REQUIRED (protocol level): every click must name its target — ' +
            'it feeds UI memory and the risk/approval gate; a click that cannot describe its ' +
            'target is a click that cannot be verified.',
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
            const { x, y, button = 'left', confidence, target_description, expected_change, expected_text, from_memory_id, approval_token, expected_effect, reasoning, allow_text_click } = args;
            // 双保险校验（Guard 已在前线，工具自查兜底）
            if (x < 0 || x > 1 || y < 0 || y > 1) {
                return toolErr('Click validation failed.', `Invalid normalized coordinates (${x}, ${y}). X and Y must be between 0.0 and 1.0.`, 'Re-estimate the target center from the latest screenshot; zoom_inspect can refine the estimate.');
            }
            // ── 不可逆操作闸门（第六轮 + B-3 两阶段 + J 纪元授予门）：危险目标必须持
            // **已授予**的有效令牌（grant_approval 落点 approval.grant —— "从未 grant"
            // 与 "grant=true" 不再等价）。
            // J 纪元升级（盲区收窄）：expected_text 作为**第二危险信号** —— 模型即使
            // 不填 target_description，声明"预期出现『发送/支付』字样"（expected_text
            // 本就是模型对该按钮的自述）同样触发闸门。旧的 `!!target_description`
            // 前置条件使"沉默不填描述"成为绕过通道；现在绕过需要同时沉默两条
            // 独立信号通道。
            // 阶段一 validate：只查不烧 —— 点击若抛异常，令牌仍可用于重试；
            // 阶段二 consume 在动作成功返回前调用（见下方 finally 前的成功路径）。
            const dangerSignal = (target_description ? matchesDangerPatterns(target_description, config.dangerPatterns) : false) ||
                (expected_text ? matchesDangerPatterns(expected_text, config.dangerPatterns) : false);
            const dangerous = config.enableApprovalGate && dangerSignal;
            if (dangerous && !(approval_token && approval.validate(approval_token))) {
                approval.sweep();
                return JSON.stringify({
                    status: 'ACTION_REQUIRED',
                    state_anchor: {
                        target: target_description ?? expected_text ?? '(undescribed target)',
                        danger_signal: target_description && matchesDangerPatterns(target_description, config.dangerPatterns)
                            ? 'target_description' : 'expected_text',
                        reason: approval_token ? 'token-not-granted-or-expired' : 'irreversible-action',
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
            // N 纪元（盲区根除）：闸门开启时描述是硬前置 —— 两条信号通道全沉默的点击
            // 不再放行（旧版仅透明化 blind-spot）。合规零成本：补一句描述重发即过。
            if (config.enableApprovalGate && !target_description && !expected_text) {
                return JSON.stringify({
                    status: 'ACTION_REQUIRED',
                    state_anchor: { reason: 'undescribed-click', note: 'approval gate cannot judge an undescribed target' },
                    next_step: 'Re-invoke click_mouse with target_description (what you are clicking) or expected_text ' +
                        '(text you expect to appear) — the approval gate requires one description channel to judge irreversibility.',
                }, null, 2);
            }
            const gateCoverage = config.enableApprovalGate ? 'described' : 'gate-disabled';
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
                //     不能把「无法验收」当成「没生效」而放行无限制重试）；
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
                        // 验证通道关闭：无从验收，维持旧方言（派发即消费，用后即焚）
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
                            scale: effect.scale,
                            screen_similarity_pct: effect.screen.similarity_pct,
                            region_similarity_pct: effect.region ? effect.region.similarity_pct : undefined,
                            // C-1 意图裁决：期望 kind + 物理证据（与 detected 分歧 = 高级幻觉警报）
                            intent: effect.intent ?? undefined,
                        } : 'verification-off',
                        expected_change: expected_change || undefined,
                        sensitive_focus: sensitive || undefined,
                        // J 纪元：审批网覆盖情况透明化（described / blind-spot / gate-disabled）
                        approval_gate: gateCoverage,
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
                return toolErr(`Mouse ${button} click at (${x}, ${y}) failed.`, error.message, 'Analyze the error and try a different approach; if an approval_token was used it is still valid for one retry.');
            }
        },
    });
}
