import { onToolPre } from './hooks.js';
let isPopupActive = false;
/** 供 take_screenshot（或本地视觉模型）更新弹窗状态 */
export function updatePopupState(state) {
    isPopupActive = state;
}
export function getPopupState() {
    return isPopupActive;
}
// 战术暂停指令：单一事实源，popupGuard 与 dismiss_popup 工具共享 —— 保证统一话术
// B-4：status 对齐锚点协议枚举（ACTION_REQUIRED = 需模型重新介入，非失败非成功，
// 熔断/遥测不计入失败统计 —— 语义正确的拦截态）
export const TACTICAL_PAUSE = JSON.stringify({
    status: 'ACTION_REQUIRED',
    state_anchor: {
        current_state: 'Screen is blocked by an unexpected popup or modal.',
        required_action: 'Re-analyze the current screenshot.',
    },
    next_step: "MANDATORY: Look closely at the screenshot. Locate the popup's close button " +
        "(e.g., 'X', 'Close', 'Cancel', or 'Accept') and call 'click_mouse' with its normalized coordinates.",
}, null, 2);
export function registerPopupGuard(ctx) {
    onToolPre(ctx, async (toolCall, next) => {
        // 1. 传感器放行：截图必须工作，它负责更新弹窗状态
        if (toolCall.name === 'take_screenshot')
            return next();
        // 2. 处理器放行：dismiss_popup 是官方指定的处理路径
        if (toolCall.name === 'dismiss_popup')
            return next();
        // 3. 核心联动：弹窗活跃时拦截一切其他操作 —— 不调 next() 即短路
        if (isPopupActive) {
            console.warn(`[Popup Guard] Blocked action: ${toolCall.name}. Popup is active!`);
            return TACTICAL_PAUSE;
        }
        // 4. 安全放行
        return next();
    });
}
