import { onToolPre } from './hooks.js';
/** 无会话上下文时的回落键（旧单例键；兼作全局最新读数视图） */
const DEFAULT_SESSION_KEY = 'default';
/** LRU 容量：在册会话键上限（'default' 基础设施键不计入、免逐出） */
const MAX_TRACKED_SESSIONS = 32;
/** 惰性过期阈值：10 分钟无传感器写入 ⇒ 陈旧清除 */
const POPUP_STALE_MS = 10 * 60 * 1000;
const popupBySession = new Map();
/** 键归一：非空字符串 sessionId 原样，缺席回落 'default'（旧单例键） */
function sessionKey(sessionId) {
    return typeof sessionId === 'string' && sessionId !== '' ? sessionId : DEFAULT_SESSION_KEY;
}
/** 陈旧判据：活跃态且超过 TTL 无更新（false 态陈旧与缺席同值，无需特判） */
function isStale(cell, now) {
    return cell.active && now - cell.updatedAt > POPUP_STALE_MS;
}
function writeCell(key, active) {
    const now = Date.now();
    // 先惰性清过期（map 容量 ≤ 33，全扫廉价且永不抛）
    for (const [k, cell] of popupBySession) {
        if (isStale(cell, now))
            popupBySession.delete(k);
    }
    // LRU：新会话键入场且会话键已满 ⇒ 按插入序逐出最旧会话（'default' 免逐）
    if (key !== DEFAULT_SESSION_KEY && !popupBySession.has(key)) {
        let sessions = 0;
        for (const k of popupBySession.keys())
            if (k !== DEFAULT_SESSION_KEY)
                sessions++;
        if (sessions >= MAX_TRACKED_SESSIONS) {
            for (const k of popupBySession.keys()) {
                if (k === DEFAULT_SESSION_KEY)
                    continue;
                popupBySession.delete(k);
                break;
            }
        }
    }
    popupBySession.delete(key); // 重插 = 写入热度刷新（读不刷，与 repeatActionGuard 同取舍）
    popupBySession.set(key, { active, updatedAt: now });
}
/**
 * 供 take_screenshot（或本地视觉模型）更新弹窗状态。
 * ΑΩ-R24：可选 sessionId —— 会话内传感按会话分键；缺席回落 'default'
 * （旧单例键，无会话上下文的旧调用方行为不变）。带会话的写入同时镜像到
 * 'default'：无会话读者（canaryGuard/interactivityProbe）继续看到全局最新
 * 读数 —— 与旧进程级单例逐字节同语义。
 */
export function updatePopupState(state, sessionId) {
    const key = sessionKey(sessionId);
    writeCell(key, state);
    if (key !== DEFAULT_SESSION_KEY)
        writeCell(DEFAULT_SESSION_KEY, state);
}
/** ΑΩ-R24：读态同样按会话分键（缺席回落 'default'）；陈旧活跃态读取时清除 */
export function getPopupState(sessionId) {
    const key = sessionKey(sessionId);
    const cell = popupBySession.get(key);
    if (!cell)
        return false;
    if (isStale(cell, Date.now())) {
        popupBySession.delete(key); // 物理清除：回拨时钟也不复活（防僵尸拦截）
        return false;
    }
    return cell.active;
}
/** ΑΩ-R24 测试观察面：在册键数（LRU/过期断言用；运行层零消费） */
export function popupSessionCount() {
    return popupBySession.size;
}
/** ΑΩ-R24 测试隔离面：清空全部会话键（运行层零消费，resetCanaryGuard 同律） */
export function resetPopupState() {
    popupBySession.clear();
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
        //    ΑΩ-R24：按本会话读态（hooks 归一化的 sessionId；缺席回落 'default'
        //    全局视图）—— 会话 A 的弹窗不再拦会话 B 的动作；拦截话术逐字不变
        if (getPopupState(toolCall.sessionId)) {
            console.warn(`[Popup Guard] Blocked action: ${toolCall.name}. Popup is active!`);
            return TACTICAL_PAUSE;
        }
        // 4. 安全放行
        return next();
    });
}
