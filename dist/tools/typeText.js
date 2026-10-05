// src/tools/typeText.ts
// 三层融合：长度防御（迭代中曾丢失，此处找回）+ 平台抽象（全部委托 system）+ 输入状态锚点。
// input_state 的二值语义（Replaced / Appended）让模型在验证截图前就知道该预期什么。
//
// ΑΩ-R29 老工具方言整治：SUCCESS 回执收编 toolOk 工厂 —— 手拼对象的键序
//（status/action/state_anchor/next_step）与缩进（null,2）与工厂产出逐字节相同，
// 消除手拼零形状变化。不收编清单（差异键 + 为什么）：
//   · 超长拒绝 `[Error]: Text too long...` 前缀方言 —— 工厂只产 JSON 四件套，
//     无法复现前缀串；epochDelta.safety.test.ts 以 /^\[Error\]: Text too long\./
//     正则钉死该形状。
//   · 敏感输入 ACTION_REQUIRED：无顶层 action 键、无 reason 键
//    （toolActionRequired 会注入 action 并把 reason 前置合并进 state_anchor，
//     键序漂移）；epochDelta.safety.test.ts 钉死 state_anchor.typed_content
//     ='[REDACTED]' 的锚点结构。
//   · catch FAILED：{status, error, next_step} —— error 在顶层、无 action/
//     state_anchor（toolErr 产 state_anchor.error），键位差异保持零回归。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system.js';
import { captureBefore, settleAndVerify } from '../actionVerifier.js';
import { quantum } from '../quantumSense.js';
import { focusTracker } from '../focusTracker.js';
import { semanticConfirm } from '../textReader.js';
import { matchesRiskPatterns } from '../riskGate.js';
import { toolOk } from '../toolResult.js';
import { assertActionAllowed } from './actionGate.js';
import { gateByReversibility, laneAnchorOf } from './clickMouse.js';
import { guardTypingFocus, markersOfConfig } from '../windowFocusGuard.js';
// ─── ΠΑΝ-19（脱敏旁路封堵）：OCR 回读片段的脱敏回显 ───
//
// typed_content 命中风险词时无论闸门开关一律 [REDACTED]（J 纪元防御纵深），
// 但 typed_semantic.region_text_snippet 原样回显 semanticConfirm 的焦点邻域
// OCR 片段 —— 该片段正是「刚输入文本」的 OCR 回读（对账面），是敏感明文的
// 第二条回显路径：enableRiskGate=false 的组合配置下明文密码经此回流
// state_anchor（进 journal/公证/遥测）。两级执法：
//   ① snippet 或 typed 任一命中风险词 ⇒ 整段 [REDACTED]（与 typed_content
//     同一脱敏器同一判词 —— typed 侧命中即视为敏感回声：OCR 噪声可能打散
//     词面使 snippet 侧漏判，防御纵深不信任单通道）；
//   ② 脱敏器无法覆盖（双侧都不命中）⇒ 截断到 50 字符（与 typed_content 的
//     回显预算同尺）并加红action标注 —— 语义对账只需片段头部的存在性证据，
//     词面脱敏器的覆盖缺口以截断兜底、以标注申报。
const SNIPPET_ECHO_MAX_CHARS = 50;
function maskOcrSnippet(snippet, typed, riskPatterns) {
    const s = typeof snippet === 'string' ? snippet : '';
    if (s === '')
        return { text: '', redacted: false };
    if (matchesRiskPatterns(s, riskPatterns) || matchesRiskPatterns(typed, riskPatterns)) {
        return { text: '[REDACTED — sensitive content]', redacted: true };
    }
    return {
        text: s.length > SNIPPET_ECHO_MAX_CHARS
            ? `${s.slice(0, SNIPPET_ECHO_MAX_CHARS)}…[truncated — unredacted OCR echo, verify visually]`
            : s,
        redacted: false,
    };
}
export function createTypeTextTool(config) {
    return defineTool({
        name: 'type_text',
        description: 'Types text into the currently focused UI element. Use this after clicking on an input field. ' +
            // R5-2（D5）：多行语义立法 —— 换行归一为真回车键事件（python 物理层
            // _newline_plan），模型可直接一次成型多行文本，不再需要「逐行+enter」绕行
            //（批1 seed-report 9 浪费步的教训：旧语义下 \n 被编辑控件静默吞掉）。
            'Multi-line text is fully supported: \\n and \\r\\n are typed as real Enter keypresses.',
        parameters: {
            text: {
                type: 'string',
                required: true,
                description: 'The exact text string to type into the focused element.',
            },
            clearFirst: {
                type: 'boolean',
                description: 'Set to true to select all and clear existing text before typing. Default is false.',
            },
            expected_change: {
                type: 'string',
                description: 'What should appear if typing succeeds? e.g., "the typed text shows in the input field".',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            const { text, clearFirst = false, expected_change } = args;
            // R5-2（D5）：换行计数 —— \r\n 记一次回车（与物理层 _newline_plan 同律）。
            // 只统计不改动：归一发生在 python SendInput 边界，TS 全链透传原字节。
            const newlineCount = (text.match(/\r\n|[\r\n]/g) ?? []).length;
            // ── 前哨闸门（Δ 纪元·审计#1：判定抽取至 actionGate.assertActionAllowed ——
            // 工具层与重放层共用同一事实源；语义与原工具内实现逐条等价）──
            // ① 长度防御：工具参数是被模型控制的输入面，防注入恶意长文本；
            // ② 风险闸门（第五轮）：凭据类输入不代劳 —— 两级判定：焦点被标记为
            //    敏感区（点击密码框后），或文本自身命中风险语义（如 "验证码 123456"）。
            //    拦截且绝不回显待输入内容。
            const gate = assertActionAllowed('type_text', { text }, config);
            if (!gate.allowed) {
                if (gate.reason === 'text-too-long') {
                    return `[Error]: Text too long. Maximum length is ${config.maxTextLength} characters.`;
                }
                return JSON.stringify({
                    status: 'ACTION_REQUIRED',
                    state_anchor: {
                        current_state: 'Sensitive input detected (credentials / verification code).',
                        typed_content: '[REDACTED]', // 绝不回显敏感内容
                    },
                    next_step: 'STOP: do not type secrets yourself. Ask the user to enter this value personally ' +
                        '(or provide it explicitly in chat). After the user finishes, continue with take_screenshot.',
                }, null, 2);
            }
            // ── R2-3（焦点保卫）：打字防串窗 —— 宿主窗口回合结束自抬抢焦后，
            // type_text 会把字打进宿主自己的聊天输入框，文本成为下一回合 user
            // prompt 的一部分（自我注入面，R1-8 §5.4 实战遗留的最危险危害）。
            // 阶梯：前台命中宿主标记 ⇒ 先按最近一次 switch_window 的目标自动复焦；
            // 复焦失败 / 无记账 / 复测仍宿主 ⇒ 诚实失败（FAILED，与 catch 臂同款
            // 方言），绝不盲打。通道缺席（标题不可读）⇒ 放行并注记 unchecked ——
            // 校验能力不可用时不得拦死正常输入。开关关（typeFocusGuard!==true，
            // 含测试部分配置的 undefined）⇒ 完全旧路径（零形状漂移）。
            let focusGuard = null;
            if (config.typeFocusGuard === true && !config.dryRun) {
                focusGuard = await guardTypingFocus(markersOfConfig(config), {
                    probeForeground: () => system.getForegroundWindowTitle(),
                    refocus: (kw) => system.switchWindowByTitle(kw),
                });
                if (focusGuard.blocked) {
                    return JSON.stringify({
                        status: 'FAILED',
                        error: `Focus guard: typing was blocked — the foreground window is the agent host itself. ${focusGuard.reason}`,
                        next_step: 'The host window stole focus mid-task. Call switch_window with the target window title ' +
                            '(e.g. the app you were typing into), then take_screenshot to confirm, then retype. ' +
                            'Do NOT retype while the host window is in the foreground.',
                    }, null, 2);
                }
            }
            try {
                // ── W5-0（C 接线 · W4-3 S5）：可逆性分道 —— text-input 恒落 compensable ──
                // type_text 无审批令牌面（危险输入已被上方敏感闸拦截）⇒ 非执法路径：
                // 只分道注记不铸预案（无 beginAttempt/consume 结算语义的铸造 = 无结算
                // 的在途预案，诚实注记更安全 —— 见 gateByReversibility 法条）。开关关
                //（缺省）⇒ applied:false，输出锚点逐字节旧路。
                const laneGate = await gateByReversibility(config, {
                    tool: 'type_text',
                    enforceEscrow: false,
                });
                // 效果验证（焦点区域放大）：输入的变化几乎总发生在「最近点击的位置」——
                // 焦点追踪器把上次点击坐标隐式传给本工具，文字出现这类局部变化
                // 在全屏指纹里撑不动距离，但在焦点区域指纹里是巨变。
                // 无跟踪焦点时（如 win+r 打开的运行框、启动即聚焦的编辑器）退化为
                // 全屏指纹 —— 小文本在全屏 9x8 下采样中不可见，误报「无焦点」。
                // 兜底：以当前鼠标位置为区域中心（最近交互的强先验），保留区域放大器。
                const verify = config.verifyActions && !config.dryRun;
                let focus = focusTracker.get(config.focusMaxAgeMs);
                let focusSource = 'none';
                if (focus) {
                    focusSource = 'click-tracked';
                }
                else if (verify) {
                    try {
                        const [cursor, size] = await Promise.all([system.getMousePosition(), system.getScreenSize()]);
                        if (cursor.x >= 0 && cursor.y >= 0) {
                            focus = { x: Math.min(1, cursor.x / size.width), y: Math.min(1, cursor.y / size.height) };
                            focusSource = 'mouse-position';
                        }
                    }
                    catch { /* 鼠标位置不可得：保持全屏验证 */ }
                }
                const before = verify ? await captureBefore(focus, config.regionVerifyRadius) : null;
                await system.typeText(text, clearFirst);
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
                // ── 语义自证（第四轮）：OCR 核对「输入的文字真的上屏了」──
                // 无需模型传参：把 typed 内容的前 40 字符作为预期文本，在焦点邻域核对。
                // 「打字进了错误的输入框 / 输入法吞字 / 焦点丢失」三类事故在此现形。
                // 不再以 effect.detected 为前提 —— dHash 对小文本天生迟钝（这正是
                // 需要语义通道的原因）；OCR 独立取证，像素盲区由文字层补判。
                let typedConfirmed = null;
                if (config.enableOcr && focus && text.trim().length >= 2) {
                    typedConfirmed = await semanticConfirm(effect?.afterBuffer ?? null, focus.x, focus.y, Math.max(config.regionVerifyRadius * 1.5, 0.2), text.slice(0, 40), config.ocrLang) ?? 'ocr-unavailable';
                }
                // 语义命中可推翻像素误报：文字上屏是比 dHash 更强的证据
                const semanticLanded = typedConfirmed && typedConfirmed !== 'ocr-unavailable' && typedConfirmed.confirmed;
                if (semanticLanded && noopSuspected) {
                    effect = effect && { ...effect, detected: true, scale: effect.scale === 'none' ? 'element-level' : effect.scale };
                }
                // ΑΩ-R29：SUCCESS 收编 toolOk（工厂产出与旧手拼逐字节相同 —— 键序/缩进一致）。
                // R4-3（b4，证据：R1-8 a6/a7/a9）：SUCCESS 头 + typed_content 回执被读成
                // 「已输入到正确位置」，effect.detected:false 与尾部 WARNING 在锚点尾部
                // 被头部淹没（a9 seq88-99 三次无视直接 enter，路径进了文档正文）。两执法：
                //   ① SUCCESS 语义限定内嵌 action 行 —— 读回执第一眼即知 SUCCESS 只代表
                //      按键已发出；
                //   ② noop WARNING 从 next_step 提级到 action 字段 —— 未验证上屏的输入
                //      在头部就判停，掐断 click→盲 type→enter 链。均为加法式，顶层四键
                //      序与锚点形状不动（r29.dialectCensus 键序铁律）。
                const noopUnconfirmed = !!(noopSuspected && !semanticLanded);
                // R5-2（T8 深因）：焦点代理降级注记 —— effect 未检出且验证区域是
                // 「鼠标位置兜底」（非点击记账焦点）时，回执不得把「区域没变」断言成
                // 「无焦点」。T8 双败链（R4-1 §4）：agent 经 switch_window + 键盘导航
                // （ctrl+home/down）到达编辑位，focusTracker 无光标概念 ⇒ 兜底取鼠标位
                //（停在任务栏/资源管理器）⇒ 区域恒 100% 相似 ⇒ WARNING「may have NO
                // focus, retype」诱导盲重打 ⇒ 三段拼接畸形行。执法：兜底场景的 WARNING
                // 附代理降级披露 + 禁止盲重打（重打即重复插入）。
                const mouseProxyBlind = focusSource === 'mouse-position' && noopUnconfirmed;
                return toolOk(noopUnconfirmed
                    ? 'WARNING: keystrokes dispatched but NO screen/focus-region change was verified — the text may have gone ' +
                        'NOWHERE (no focus, wrong window, or swallowed by IME). Do NOT chain the next action on this input.' +
                        (mouseProxyBlind
                            ? ' CAVEAT: the verified region was centered on the CURRENT MOUSE POSITION (no click-tracked focus) — ' +
                                'if the target field is keyboard-focused elsewhere (switch_window + arrow-key navigation), the text ' +
                                'may have landed correctly but OUTSIDE the verified region; verify visually BEFORE retyping.'
                            : '')
                    : 'Text typed successfully (SUCCESS = keystrokes dispatched, not that the intended field received them).', {
                    // 回显也做 Token 预算：截断到 50 字符。
                    // J 纪元（防御纵深）：文本自身命中风险词时无论闸门开关一律脱敏 ——
                    // 旧实现仅在 enableRiskGate=true 的拦截路径不回显，闸门关闭的
                    // 组合配置下明文密码会进锚点（锚点可能进入日志/遥测）。
                    typed_content: matchesRiskPatterns(text, config.riskPatterns)
                        ? '[REDACTED — sensitive content]'
                        : text.substring(0, 50) + (text.length > 50 ? '...' : ''),
                    char_count: text.length,
                    // R5-2（D5）：多行换行回执 —— 模型可从回执直接确证换行已按真回车
                    // 键事件注入（勿再退回「逐行+enter」绕行）。单行文本键缺席（锚点
                    // 形状与旧路逐字节一致）。
                    ...(newlineCount > 0
                        ? {
                            newline_count: newlineCount,
                            newline_semantics: 'each newline (\\n or \\r\\n) was sent as a real Enter keypress — multi-line text lands as separate lines',
                        }
                        : {}),
                    cleared_existing: clearFirst,
                    input_state: clearFirst ? 'Replaced all previous content' : 'Appended to existing content',
                    // W5-0（C 接线）：可逆性分道注记（compensable 快照；未分道缺席）
                    reversibility_lane: laneAnchorOf(laneGate),
                    // R2-3（焦点保卫）：前置校验注记 —— ok/refocused/unchecked（开关关
                    // 或 dry-run ⇒ 键缺席，锚点形状与旧路逐字节一致）
                    ...(focusGuard && !focusGuard.blocked
                        ? { focus_guard: { status: focusGuard.status, ...(focusGuard.status === 'unchecked' ? { reason: focusGuard.reason } : { foreground_title: focusGuard.foreground_title }) } }
                        : {}),
                    effect: effect ? {
                        detected: effect.detected,
                        scale: effect.scale,
                        screen_similarity_pct: effect.screen.similarity_pct,
                        region_similarity_pct: effect.region ? effect.region.similarity_pct : undefined,
                        verified_around_focus: effect.region ? true : false,
                        focus_source: focusSource,
                    } : 'verification-off',
                    expected_change: expected_change || undefined,
                    typed_semantic: typedConfirmed
                        ? (typedConfirmed === 'ocr-unavailable'
                            ? 'ocr-unavailable'
                            // ΠΑΝ-19：snippet 过与 typed_content 相同的脱敏器（绝不原样回显
                            // 刚输入的敏感文本）；redacted 标记诚实申报脱敏发生
                            : (() => {
                                const masked = maskOcrSnippet(typedConfirmed.snippet, text, config.riskPatterns);
                                return {
                                    confirmed: typedConfirmed.confirmed,
                                    region_text_snippet: masked.text,
                                    ...(masked.redacted ? { snippet_redacted: true } : {}),
                                };
                            })())
                        : undefined,
                }, (noopSuspected && !semanticLanded)
                    ? 'WARNING: Neither the screen nor the focus region changed — the input may have NO focus. Click the input field first, then retype.' +
                        // R5-2（T8）：兜底代理下禁盲重打 —— 键盘导航到达的字段里首打已落
                        // 屏，盲重打 = 重复插入（T8 三段拼接的直建成因）。
                        (mouseProxyBlind
                            ? ' If the field was reached by keyboard navigation (no recent click), the first text may ALREADY be there: ' +
                                "verify with take_screenshot BEFORE retyping — blind retyping duplicates the inserted text (prefer backspace/undo over retype)."
                            : '')
                    : (typedConfirmed && typedConfirmed !== 'ocr-unavailable' && !typedConfirmed.confirmed
                        ? 'SEMANTIC MISMATCH: the typed text was NOT found in the focus region — it may have gone to the WRONG field or been swallowed by an IME. Verify with take_screenshot and retype if needed.'
                        : "MANDATORY: Call 'take_screenshot' immediately to verify that the text appears correctly in the input field." +
                            (expected_change ? ` Confirm: "${expected_change}".` : '')));
            }
            catch (error) {
                return JSON.stringify({
                    status: 'FAILED',
                    error: error.message,
                    next_step: 'The text input failed. Check if an input field is currently focused. Call take_screenshot to verify the UI state.',
                }, null, 2);
            }
        },
    });
}
