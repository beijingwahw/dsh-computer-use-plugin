let focus = null;
export const focusTracker = {
    /** 记录焦点（点击/拖拽终点后调用）；sensitive 标记凭据类输入区 */
    set(x, y, sensitive = false) {
        focus = { x, y, at: Date.now(), sensitive };
    },
    /** 读取未过期的焦点；过期或不存在返回 null */
    get(maxAgeMs = 30_000) {
        if (!focus)
            return null;
        if (Date.now() - focus.at > maxAgeMs)
            return null;
        return { x: focus.x, y: focus.y };
    },
    /** 焦点是否为敏感区（凭据输入将被人机协同闸门拦截） */
    isSensitive(maxAgeMs = 30_000) {
        if (!focus || !focus.sensitive)
            return false;
        return Date.now() - focus.at <= maxAgeMs;
    },
    clear() {
        focus = null;
    },
};
