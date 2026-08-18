// src/guards/popupGuard.ts
// 弹窗联动守卫（融合 v2 完成版）。
// 单一事实源 isPopupActive + 唯一写入口 updatePopupState：
// 传感器（take_screenshot）与执行器（本守卫）通过共享状态解耦，互不 import 对方。
// 白名单永远给自己的传感器和处理器留生命通道；拦截话术与 dismiss_popup 工具逐字一致，
// 保证模型在任何路径下收到统一的战术暂停指令。
import type { Context } from '@deepseek-ai/cordis';
import { onToolPre } from './hooks';

let isPopupActive = false;

/** 供 take_screenshot（或本地视觉模型）更新弹窗状态 */
export function updatePopupState(state: boolean): void {
  isPopupActive = state;
}

export function getPopupState(): boolean {
  return isPopupActive;
}

// 战术暂停指令：单一事实源，popupGuard 与 dismiss_popup 工具共享 —— 保证统一话术
export const TACTICAL_PAUSE = JSON.stringify({
  status: 'GUARD_BLOCKED',
  state_anchor: {
    current_state: 'Screen is blocked by an unexpected popup or modal.',
    required_action: 'Re-analyze the current screenshot.',
  },
  next_step: "MANDATORY: Look closely at the screenshot. Locate the popup's close button " +
    "(e.g., 'X', 'Close', 'Cancel', or 'Accept') and call 'click_mouse' with its normalized coordinates.",
}, null, 2);

export function registerPopupGuard(ctx: Context): void {
  onToolPre(ctx, async (toolCall, next) => {
    // 1. 传感器放行：截图必须工作，它负责更新弹窗状态
    if (toolCall.name === 'take_screenshot') return next();

    // 2. 处理器放行：dismiss_popup 是官方指定的处理路径
    if (toolCall.name === 'dismiss_popup') return next();

    // 3. 核心联动：弹窗活跃时拦截一切其他操作 —— 不调 next() 即短路
    if (isPopupActive) {
      console.warn(`[Popup Guard] Blocked action: ${toolCall.name}. Popup is active!`);
      return TACTICAL_PAUSE;
    }

    // 4. 安全放行
    return next();
  });
}
