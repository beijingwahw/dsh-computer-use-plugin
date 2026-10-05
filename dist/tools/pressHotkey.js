// src/tools/pressHotkey.ts
// 薄委托层：白名单、数量对账、对称时序全部下沉 system.pressHotkey，工具层只做锚点。
// B-4：返回值统一走 toolResult 工厂（反幻觉锚点全覆盖）。
// P1-3：系统级热键黑名单拦截在 system 层执法，工具层按错误类别给出针对性 next_step。
// P1-1：IO 排队超时（[TIMEOUT] 方言）透传 + 专属恢复指引。
//
// ΠΑΝ-12（键盘侧门封堵 · 批判报告 C1-5 H5 的修法面）：press_hotkey 接入
// actionGate 闸门（此前完全在 ActionKind 闭集之外 —— 点击危险按钮后
// press_hotkey(['enter']) 激活确认零审批；敏感焦点上 ctrl+v 把剪贴板粘进
// 凭据框绕过 sensitive-input 闸）。执法三层（判定事实源 = actionGate）：
//   ① 黑名单和弦（config.hotkeyBlacklist 随 config 在场时前置结构化拒绝；
//     缺 config 的调用方保持完全旧路径 —— system 层 P1-3 执法不变，p1-fixes
//     的 FAILED 方言逐字节保持）；
//   ② ctrl/cmd+v × 敏感焦点 ⇒ sensitive-input（凭据粘贴不代劳）；
//   ③ context_description 命中危险词 ⇒ 审批域（enter 激活危险默认钮的主通道，
//     一枚已授予令牌可解 —— 与 click 闸门同律）。
// 危险语义放行后的一次性令牌律：派发成功即消费（无效果验证面的热键不适用
// 验收式消费 —— 与 drag 的旧方言同律；经 consumeApprovalWithHint 统一落点，
// targetHint 随行透传）。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system, isHotkeyBlacklistError } from '../system.js';
import { isIoTimeoutError } from '../ioMutex.js';
import { toolOk, toolErr } from '../toolResult.js';
import { assertActionAllowed } from './actionGate.js';
import { consumeApprovalWithHint } from './clickMouse.js';
/**
 * ΝΩ-31（人体工学）：白名单键集 —— system 层 `_getKey` fallbackMap 的键名镜像
 * （单一执法事实源仍在 system 层：白名单外的键名由 system.pressHotkey 拒绝；
 * 系统级热键黑名单 alt+f4/meta/... 在其上再拦一道）。此处枚举进 schema 的唯一
 * 目的是把合法键集**前置呈现给模型**：协议层即拒（ToolArgsError），模型不必
 * 先错一次才知道键名是否合法。漂移防线：no31 测试对照 system.ts 源码
 * fallbackMap —— system 层改键集而此处未跟 ⇒ 测试红。
 */
export const HOTKEY_WHITELIST_KEYS = [
    'ctrl', 'cmd', 'alt', 'shift',
    'enter', 'tab', 'space', 'backspace', 'delete', 'esc',
    // R2-2: 导航/编辑键补齐（home/end/pageup/pagedown/方向键）—— suite-full 行级
    // 编辑任务的主路径（ctrl+home 回文首 / ctrl+end 跳文末 / shift+end 选整行 /
    // 方向键移动）。python 侧 _KEY_MAP 早已立法同集（"导航与编辑键——滚动/选择/
    // 对话框导航的键盘模态"），本镜像收口使三层（schema/system fallbackMap/python）
    // 收敛到同一生效键集。
    'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right',
    'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
    // R2-2: 全字母表补齐（原 a/c/v/z 四字母子集收口）—— 根因修复 R1-8 冒烟
    // 遗留①：白名单缺 s ⇒ ctrl+s 在协议层（schema 枚举 ToolArgsError）被拒 ⇒
    // 一切"ctrl+s 保存"类套件话术被迫走菜单旁路（R1-8 attempt5-9 的主要成本源）。
    // 立法依据：黑名单的宪法边界是**射向 OS 壳层/会话管理器的逃逸和弦**
    // （alt+f4 / meta 族 / ctrl+alt+delete / ctrl+shift+esc / alt+space），
    // 字母键无论与什么修饰键组合都在应用表面 + 纯视觉闭环内（效果可见可验证、
    // 可 ctrl+z 回滚）；危险和弦由 config.hotkeyBlacklist 独立执法且**不因本
    // 扩员弱化**——cmd+q（归一为 meta+q）仍被黑名单的 meta 单键条目与和弦条目
    // 双重命中。与 python _KEY_MAP 既有立法（"全字母表补齐——ctrl+s/ctrl+o/
    // ctrl+n 等组合的完整覆盖"）双向同步；win/meta/printscreen/insert/capslock
    // 刻意**不**入白名单（OS 壳层域 / 无套件需求面）。
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
];
/**
 * R5-2（T8·选区回执）：选族和弦判定 —— shift + 导航键（home/end/方向键/
 * pageup/pagedown）会改变文本选区。此类和弦的效果（选区高亮）在回执中
 * 不可机检（无光标锚定的验证区域），须明示「未证实」并前置视觉核验。
 * 纯文本增强：锚点形状与非选族和弦回执逐字节不变。
 */
const SELECTION_NAV_KEYS = new Set([
    'home', 'end', 'left', 'right', 'up', 'down', 'pageup', 'pagedown',
]);
export function isSelectionChord(keys) {
    if (!Array.isArray(keys) || keys.length < 2)
        return false;
    const lower = keys.map((k) => (typeof k === 'string' ? k.toLowerCase() : ''));
    return lower.includes('shift') && lower.some((k) => SELECTION_NAV_KEYS.has(k));
}
/**
 * ΠΑΝ-12：config 改为可选 —— index.ts 装配面传 config（闸门随之激活）；
 * 零参调用（既有测试/独立装配）保持完全旧路径（闸门对黑名单缺席不重复执法，
 * system 层 P1-3 事实源不变）。
 */
export function createPressHotkeyTool(config) {
    return defineTool({
        name: 'press_hotkey',
        description: 'Presses a combination of keyboard keys simultaneously. ' +
            'Useful for shortcuts (e.g., ctrl+c, ctrl+shift+t). ' +
            'Only whitelisted key names are accepted (see keys enum); ' +
            'system-level hotkeys (alt+f4, meta/win combos, ctrl+alt+delete) are blacklist-rejected. ' +
            'Activation keys (enter/space) acting on a DANGEROUS context (e.g., a delete/pay confirmation ' +
            'dialog) require approval_token — describe the context in context_description. ' +
            'Recovery chords are always safe and NEVER gated: ctrl+z / ctrl+shift+z / ctrl+y (undo/redo) ' +
            'and bare delete/backspace (editor text keys, undoable) — use them freely to roll back a ' +
            'botched edit instead of working around the gate.',
        parameters: {
            keys: {
                type: 'array',
                required: true,
                description: 'An array of key names to press. Examples: ["ctrl", "c"], ["ctrl", "shift", "tab"]. ' +
                    `Allowed key names (whitelist): ${HOTKEY_WHITELIST_KEYS.join(', ')}.`,
                items: { type: 'string', enum: HOTKEY_WHITELIST_KEYS },
            },
            // ΠΑΝ-12：热键作用面的模型自述通道（与 click 的 target_description 同律）——
            // enter/space 激活的是哪个对话框/按钮。命中危险词 ⇒ 审批域。
            context_description: {
                type: 'string',
                description: 'Short description of WHAT this hotkey acts on (e.g., "the 删除订单 confirmation dialog\'s ' +
                    'default button", "the search box"). Feeds the danger/approval gate: an activation key (enter) in a ' +
                    'dangerous context (delete/send/pay/submit dialog) requires approval_token.',
            },
            approval_token: {
                type: 'string',
                description: 'One-shot token from request_approval. Required when this hotkey acts in an irreversible ' +
                    'context (e.g., enter confirming a delete/pay dialog).',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            const { keys, context_description, approval_token } = args;
            // ── ΠΑΝ-12：键盘侧门闸门（结构化拒绝，绝不抛；判定事实源 = actionGate）───
            const gate = assertActionAllowed('press_hotkey', { keys, context_description, approval_token }, config);
            if (!gate.allowed) {
                // 黑名单和弦：OS 壳层逃逸动作令牌不可解 —— 常规途径出口（P1-3 同律）
                if (gate.reason === 'blacklisted-hotkey') {
                    return JSON.stringify({
                        status: 'ACTION_REQUIRED',
                        state_anchor: {
                            keys: Array.isArray(keys) ? keys : [],
                            danger_signal: 'blacklist',
                            reason: gate.reason,
                            note: 'This chord escapes the application surface into the OS shell / session manager — its ' +
                                'effects are outside the visual closed loop (invisible to verification) and mostly irreversible.',
                        },
                        next_step: '系统级热键被闸门拦截：改用常规途径 —— 关闭窗口点其关闭按钮（click_mouse）、' +
                            '切换窗口用 switch_window、打开地址用 open_url。',
                    }, null, 2);
                }
                // 粘贴面：敏感焦点上的 ctrl/cmd+v —— 凭据粘贴不代劳（type 臂的键盘孪生）
                if (gate.reason === 'sensitive-input') {
                    return JSON.stringify({
                        status: 'ACTION_REQUIRED',
                        state_anchor: {
                            keys: Array.isArray(keys) ? keys : [],
                            danger_signal: gate.dangerSignalChannel ?? 'focus',
                            reason: gate.reason,
                            note: 'The current focus is marked as a credentials/input-secret area — pasting the clipboard ' +
                                'into it is credential handling, which the agent must not do on the user\'s behalf.',
                        },
                        next_step: 'STOP: do not paste into this sensitive field yourself. Ask the user to press Ctrl+V ' +
                            'personally (or provide the value explicitly in chat). After the user finishes, continue with ' +
                            'take_screenshot.',
                    }, null, 2);
                }
                // 审批域：危险上下文（enter 激活危险默认钮等）—— 与 click/drag 闸门同律
                return JSON.stringify({
                    status: 'ACTION_REQUIRED',
                    state_anchor: {
                        keys: Array.isArray(keys) ? keys : [],
                        target: context_description ?? '(undescribed context)',
                        danger_signal: gate.dangerSignalChannel ?? 'context_description',
                        reason: gate.reason,
                        note: approval_token
                            ? 'The token exists but the user has not granted it yet (or it expired).'
                            : 'This hotkey acts in an irreversible context (activating a delete/send/pay/submit dialog...).',
                    },
                    next_step: 'PAUSE: this hotkey needs explicit user approval. Call request_approval with a clear ' +
                        'description (what dialog the key acts on and what it triggers), relay the message, wait for ' +
                        'consent, call grant_approval(token, true), then re-invoke press_hotkey with the returned ' +
                        'approval_token. Never proceed without consent. Alternatively use click_mouse on the specific ' +
                        'button — it goes through the same gate.',
                }, null, 2);
            }
            try {
                // 白名单外的键名会被 system 层拒绝 —— 模型无法注入白名单之外的任何键
                await system.pressHotkey(keys);
                // ΠΑΝ-12：一次性令牌律 —— 危险语义放行后随派发消费（热键无效果验证面，
                // 不适用验收式消费；统一落点 + targetHint 接线预留：作用面描述入提示）
                if (gate.dangerous && approval_token) {
                    consumeApprovalWithHint(approval_token, { tool: 'press_hotkey', target_description: context_description });
                }
                return toolOk(`Hotkey ${keys.join(' + ')} pressed.`, {
                    keys,
                    note: 'keys are whitelist-enforced at the system layer',
                    // ΠΑΝ-12：审批域透明化（危险上下文 + 令牌已随派发消费）
                    ...(gate.dangerous ? { approval_gate: { described: true, token_consumed_on_dispatch: true } } : {}),
                }, 
                // R5-2（T8 深因·选区回执）：选族和弦（shift+home/end/方向键/pageup/
                // pagedown）会改变文本选区，但本回执**看不见选区状态**——效果验证面
                // 未接线（接线需光标锚定的区域 dHash，见 R5-2 报告 §T8-2）。T8 双败
                // 链的插件侧主因之一：agent 连发 shift+end 后只能靠 take_screenshot+
                // ask_screen（2-4 VLM 步/次，且 VLM 答案自相矛盾——seq204 判未选中/
                // seq214 判选中）才能核实选区。离线 dHash 实验（R5-2）：选区蓝条在
                // 光标锚定区域强烈可见（sim≈0.80）、全屏 9x8 边际可见（0.9688，2 bit
                // 余量）——但验证区域锚在鼠标兜底位置时恒 100%（T8 实况）。执法（本
                // 批最低风险项）：选族和弦的回执明示「选区未经证实」+ 视觉核验前置 +
                // 无选区盲打的重复插入危害。非选族和弦回执逐字节不变。
                isSelectionChord(keys)
                    ? 'SELECTION UNVERIFIED: this receipt CANNOT see whether a text selection was actually made — the ' +
                        'selection highlight (blue/reversed strip) is the ONLY ground truth that the intended range is ' +
                        'selected. Verify it FIRST (take_screenshot + ask_screen asking specifically about the highlight, ' +
                        'or zoom_inspect for small text) BEFORE typing over the selection: typing with NO active selection ' +
                        'INSERTS at the caret instead of replacing — a duplicate-text hazard.'
                    : "Call 'take_screenshot' to verify the shortcut took effect.");
            }
            catch (error) {
                // P1-3：黑名单拦截 ⇒ 明说被什么拦住 + 常规途径出口（逃逸动作没有合法通道）
                if (isHotkeyBlacklistError(error)) {
                    return toolErr(`Hotkey ${keys.join(' + ')} press failed.`, error.message, '系统级热键被黑名单拦截：改用常规途径 —— 关闭窗口点其关闭按钮（click_mouse）、' +
                        '切换窗口用 switch_window、打开地址用 open_url、复制粘贴用右键菜单（click_mouse button=right）。');
                }
                // P1-1：IO 排队超时 ⇒ [TIMEOUT] 方言专属指引（底层假死的恢复路径）
                if (isIoTimeoutError(error)) {
                    return toolErr(`Hotkey ${keys.join(' + ')} press failed.`, error.message, '物理 IO 队列超时：底层执行器可能假死。稍等后重试一次；仍超时则改用 ' +
                        "take_screenshot 检查屏幕是否已变化（动作可能已生效但回执迟到）。");
                }
                // R2-2: 拒绝指引的键集速记与白名单同步（字母表全集 + 导航键）
                return toolErr(`Hotkey ${keys.join(' + ')} press failed.`, error.message, "Check key names against the whitelist (ctrl/cmd/alt/shift/enter/tab/space/backspace/delete/esc/" +
                    "home/end/pageup/pagedown/up/down/left/right/f1-f12/a-z letters). " +
                    "For unsupported keys, fall back to click_mouse on the target UI control.");
            }
        },
    });
}
