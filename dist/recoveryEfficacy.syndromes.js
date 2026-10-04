/** W2-5：运行时枚举面（防御解析的合法值域） */
export const RECOVERY_SYNDROME_IDS = [
    'guard-blocked', 'target-not-found', 'no-world-effect',
    'verification-mismatch', 'stall-timeout', 'generic-failure',
];
/** W2-5：防御解析 —— 任意值 → 合法症候签名（垃圾值 ⇒ generic-failure 兜底桶） */
export function parseRecoverySyndrome(v) {
    return typeof v === 'string' && RECOVERY_SYNDROME_IDS.includes(v)
        ? v
        : 'generic-failure';
}
/**
 * W2-5：症候签名分类器（纯函数、确定性、首中即断 —— 与规则表同哲学）。
 * 判据序：熔断前缀 → 症状关键词（找不到 / 无变化 / 核对不符 / 卡顿）→
 * 工具族先验（感知类工具的失败模式是本职失败：找不到）→ 兜底粗桶。
 */
export function classifySyndromeSignature(symptom, tool) {
    const s = typeof symptom === 'string' ? symptom.toLowerCase() : '';
    const t = typeof tool === 'string' ? tool.toLowerCase() : '';
    if (s.startsWith('circuit-breaker:'))
        return 'guard-blocked';
    if (/not found|no match|cannot find|can't find|not located|unrecognized|not detected|no .*located/.test(s)) {
        return 'target-not-found';
    }
    if (/no change|unchanged|no effect|nothing happen|did not change|didn't change|no visible/.test(s)) {
        return 'no-world-effect';
    }
    if (/mismatch|differ|expected|verify|incorrect|wrong text/.test(s)) {
        return 'verification-mismatch';
    }
    if (/timeout|timed out|stall|freez|hang|unresponsive/.test(s)) {
        return 'stall-timeout';
    }
    // 症状词缺席 ⇒ 工具族先验（感知/识别类工具的失败即「找不到」）
    if (t === 'find_text' || t === 'read_text' || t === 'zoom_inspect' || t === 'extract_ui_vision') {
        return 'target-not-found';
    }
    return 'generic-failure';
}
/**
 * W2-5：恢复动作分类器（纯函数）—— 工具名 → 规范动作（diagnosis 的动作词汇）。
 * 不在表内的工具 ⇒ null：该事件仍消耗回合窗口（是一次真实尝试），但不产生
 * 疗效观察（无法记名的动作不入账 —— 与 unknown 根因不写库同律）。
 */
const ACTION_TOOL_FAMILY = [
    ['zoom-refine', ['zoom_inspect']],
    ['switch-modality', ['press_hotkey', 'type_text', 'scroll_page', 'recall_ui', 'switch_tab', 'switch_window', 'open_url']],
    ['re-observe', ['take_screenshot', 'diff_view', 'ask_screen']],
    ['ground-target', ['find_text', 'probe_interactivity', 'read_text', 'extract_ui_vision']],
];
export function classifyRecoveryAction(tool) {
    if (typeof tool !== 'string')
        return null;
    for (const [action, tools] of ACTION_TOOL_FAMILY) {
        if (tools.includes(tool))
            return action;
    }
    return null;
}
