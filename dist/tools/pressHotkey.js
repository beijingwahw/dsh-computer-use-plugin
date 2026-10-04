// src/tools/pressHotkey.ts
// 薄委托层：白名单、数量对账、对称时序全部下沉 system.pressHotkey，工具层只做锚点。
// B-4：返回值统一走 toolResult 工厂（反幻觉锚点全覆盖）。
// P1-3：系统级热键黑名单拦截在 system 层执法，工具层按错误类别给出针对性 next_step。
// P1-1：IO 排队超时（[TIMEOUT] 方言）透传 + 专属恢复指引。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system, isHotkeyBlacklistError } from '../system.js';
import { isIoTimeoutError } from '../ioMutex.js';
import { toolOk, toolErr } from '../toolResult.js';
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
    'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
    'a', 'c', 'v', 'z',
];
export function createPressHotkeyTool() {
    return defineTool({
        name: 'press_hotkey',
        description: 'Presses a combination of keyboard keys simultaneously. ' +
            'Useful for shortcuts (e.g., ctrl+c, ctrl+shift+t). ' +
            'Only whitelisted key names are accepted (see keys enum); ' +
            'system-level hotkeys (alt+f4, meta/win combos, ctrl+alt+delete) are blacklist-rejected.',
        parameters: {
            keys: {
                type: 'array',
                required: true,
                description: 'An array of key names to press. Examples: ["ctrl", "c"], ["ctrl", "shift", "tab"]. ' +
                    `Allowed key names (whitelist): ${HOTKEY_WHITELIST_KEYS.join(', ')}.`,
                items: { type: 'string', enum: HOTKEY_WHITELIST_KEYS },
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            const { keys } = args;
            try {
                // 白名单外的键名会被 system 层拒绝 —— 模型无法注入白名单之外的任何键
                await system.pressHotkey(keys);
                return toolOk(`Hotkey ${keys.join(' + ')} pressed.`, { keys, note: 'keys are whitelist-enforced at the system layer' }, "Call 'take_screenshot' to verify the shortcut took effect.");
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
                return toolErr(`Hotkey ${keys.join(' + ')} press failed.`, error.message, "Check key names against the whitelist (ctrl/cmd/alt/shift/enter/tab/space/backspace/delete/esc/f1-f12/a/c/v/z). " +
                    "For unsupported keys, fall back to click_mouse on the target UI control.");
            }
        },
    });
}
