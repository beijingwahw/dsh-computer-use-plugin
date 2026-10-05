// ─── 宿主窗口标记（纯数据 + 纯函数） ───
/**
 * R2-3：缺省宿主窗口标记（小写子串匹配）。
 * 实测（本机 Get-Process）：宿主进程名与主窗口标题均为 "DeepSeek Harness"；
 * 'dsh' 是日志/文档里的通用简称 —— 双标记降低标题方言漂移的漏判面。
 * 可经 config.hostWindowMarkersCsv 覆盖（换宿主发行版/改窗口标题时）。
 */
export const HOST_WINDOW_MARKERS_DEFAULT = ['dsh', 'deepseek harness'];
/** R2-3：标记 CSV → 小写标记表（空串/空白项丢弃；全空 ⇒ 缺省表兜底）。纯函数。 */
export function parseHostMarkersCsv(csv, fallback = HOST_WINDOW_MARKERS_DEFAULT) {
    const raw = typeof csv === 'string' ? csv : '';
    const items = raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s !== '');
    return items.length > 0 ? items : [...fallback];
}
/**
 * R2-3：前台标题是否命中宿主窗口标记（小写子串）。纯函数、永不抛。
 * null/空标题（无前台窗口可读、桌面焦点）⇒ false —— 诚实方向：证据缺失
 * 不算宿主抢焦（拦截面只认正证据）。
 */
export function isHostWindowTitle(title, markers) {
    const t = typeof title === 'string' ? title.trim().toLowerCase() : '';
    if (t === '')
        return false;
    try {
        return markers.some((m) => typeof m === 'string' && m.trim() !== '' && t.includes(m.trim().toLowerCase()));
    }
    catch {
        return false; // 防御式：markers 非法输入按无标记处理
    }
}
/** R2-3：config 视图的标记表（缺省 true 开关的伴生数据源）。纯函数。 */
export function markersOfConfig(config) {
    return parseHostMarkersCsv(config?.hostWindowMarkersCsv);
}
let targetWindow = null;
/** R2-3：记录目标窗（switch_window / raise_window 成功路径调用）。空关键词不入账。 */
export function recordTargetWindow(rec) {
    const kw = typeof rec?.keyword === 'string' ? rec.keyword.trim() : '';
    if (kw === '')
        return; // 复焦依据必须是可重放的寻址词 —— 空词无复焦价值
    const title = typeof rec.matchedTitle === 'string' ? rec.matchedTitle.trim() : '';
    targetWindow = { keyword: kw, matchedTitle: title, at: Date.now() };
}
/** R2-3：读取当前目标窗记账（无 ⇒ null）。只读视图，调用方不得篡改。 */
export function peekTargetWindow() {
    return targetWindow ? { ...targetWindow } : null;
}
/** R2-3：清空目标窗记账（测试隔离 / 显式弃账）。 */
export function clearTargetWindow() {
    targetWindow = null;
}
/** R2-3：测试隔离入口 —— 全态复位（生产代码不得调用）。 */
export function _resetWindowFocusGuardForTest() {
    targetWindow = null;
}
/**
 * R2-3：打字防串窗校验（编排函数，绝不抛）。
 *
 * 判决阶梯（只拦「正证据的宿主抢焦」，不拦其余 —— 应用自身的对话框换焦
 * （如另存为对话框）是正常流，泛化拦截会打断合法输入）：
 *   probe ⇒ null            → unchecked 放行（通道缺席，诚实降级）
 *   标题不命中宿主标记      → ok 放行
 *   命中宿主 ∧ 无目标记账   → blocked（无复焦依据，诚实失败优于盲打）
 *   命中宿主 ∧ 有记账       → 尝试 refocus(keyword) 后复测：
 *                              复测脱离宿主 → refocused 放行（自愈）
 *                              复测仍宿主 / refocus 抛错 / 无 refocus 端口 → blocked
 */
export async function guardTypingFocus(markers, ports) {
    let title = null;
    try {
        title = await ports.probeForeground();
    }
    catch {
        return { blocked: false, status: 'unchecked', reason: 'foreground probe threw (channel unavailable)' };
    }
    if (title === null || title === undefined) {
        return { blocked: false, status: 'unchecked', reason: 'foreground title unavailable (no window backend)' };
    }
    if (!isHostWindowTitle(title, markers)) {
        return { blocked: false, status: 'ok', foreground_title: title };
    }
    const target = peekTargetWindow();
    if (!target) {
        return {
            blocked: true, foreground_title: title,
            reason: 'foreground window is the agent host itself and no refocus target is recorded',
        };
    }
    if (typeof ports.refocus !== 'function') {
        return {
            blocked: true, foreground_title: title,
            reason: 'foreground window is the agent host itself and refocus channel is unavailable',
        };
    }
    try {
        await ports.refocus(target.keyword);
    }
    catch (e) {
        return {
            blocked: true, foreground_title: title,
            reason: `refocus via "${target.keyword}" failed: ${e instanceof Error ? e.message : String(e)}`,
        };
    }
    let after = null;
    try {
        after = await ports.probeForeground();
    }
    catch {
        after = null; // 复测通道抖动按未脱离处理（保守：拦错方向优于打错窗口）
    }
    if (after !== null && after !== undefined && !isHostWindowTitle(after, markers)) {
        return {
            blocked: false, status: 'refocused', foreground_title: after, was_host_title: title, refocus_keyword: target.keyword,
        };
    }
    return {
        blocked: true, foreground_title: after ?? title,
        reason: `refocus via "${target.keyword}" did not move the foreground off the host window`,
    };
}
