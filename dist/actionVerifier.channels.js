// ─── W5-3（L3 跨机互证）：判决函数 ───
/** W5-3 防御式净化：归一化矩形形状/值域不合法或退化（x1≤x0 等）⇒ null */
export function sanitizeRemoteRegion(r) {
    try {
        if (!r || typeof r !== 'object')
            return null;
        const o = r;
        if (![o.x0, o.y0, o.x1, o.y1].every(v => typeof v === 'number' && Number.isFinite(v)))
            return null;
        const c = (v) => Math.max(0, Math.min(1, v));
        const x0 = c(o.x0), y0 = c(o.y0), x1 = c(o.x1), y1 = c(o.y1);
        if (!(x1 > x0 && y1 > y0))
            return null; // 退化框：零面积 ⇒ 无判决资格
        return { x0, y0, x1, y1 };
    }
    catch {
        return null;
    }
}
/** W5-3 防御式净化：RemoteChange 载荷形状不合法 ⇒ null（证据缺席）；regions 内坏框静默剔除 */
export function sanitizeRemoteChange(c) {
    try {
        if (!c || typeof c !== 'object' || Array.isArray(c))
            return null;
        const o = c;
        const regions = Array.isArray(o.regions)
            ? o.regions.map(sanitizeRemoteRegion).filter((r) => r !== null)
            : [];
        return {
            screen: typeof o.screen === 'string' ? o.screen : '',
            region: typeof o.region === 'string' ? o.region : null,
            regions,
        };
    }
    catch {
        return null;
    }
}
/**
 * W5-3：跨机互证谓词（纯函数、确定性、绝不抛）——「A 的动作效果必须出现在
 * B 屏」的判决核心：
 *   · 证据缺席（change=null）⇒ unverified 'absent'（peer 离线/超时/载荷坏）；
 *   · 无期望区域（hint=null/非法）⇒ unverified 'no-hint'（严格：说不出该出现
 *     在哪，就无权互证）；
 *   · 无有效变化区域 ⇒ unverified 'no-change-regions'（B 屏没变 —— 诚实
 *     缺席而非反驳：region 证据链断在哪环都不臆造）；
 *   · 判据：max over regions of（区域∩期望）/（期望面积）≥ overlapMin
 *     ⇒ corroborated；否则 unverified 'overlap-below-min'
 *     （overlap 照报最优值 —— 证据保留）。
 * ΠΑΝ-127：阈值经参数注入（公开二参面 = 桶 actionVerifier.ts 的包装，注入
 * 立法常量 REMOTE_EVIDENCE_OVERLAP_MIN —— 立法在源桶，环拆于参数缝）。
 */
export function judgeRemoteChange(hint, change, overlapMin) {
    const un = (reason) => ({ verdict: 'unverified', overlap: 0, reason });
    try {
        if (change === null)
            return un('absent');
        const h = sanitizeRemoteRegion(hint);
        if (h === null)
            return un('no-hint');
        if (change.regions.length === 0)
            return un('no-change-regions');
        const hArea = (h.x1 - h.x0) * (h.y1 - h.y0);
        if (!(hArea > 0))
            return un('no-hint');
        let best = 0;
        for (const r of change.regions) {
            const iw = Math.min(h.x1, r.x1) - Math.max(h.x0, r.x0);
            const ih = Math.min(h.y1, r.y1) - Math.max(h.y0, r.y0);
            if (iw > 0 && ih > 0)
                best = Math.max(best, (iw * ih) / hArea);
        }
        const overlap = Math.round(best * 10000) / 10000;
        return overlap >= overlapMin
            ? { verdict: 'corroborated', overlap }
            : { verdict: 'unverified', overlap, reason: 'overlap-below-min' };
    }
    catch {
        return un('absent');
    }
}
/** W4-8 防御式净化：注入方给的 AudioEvent 形状/值域不合法 ⇒ 视为缺席（null）。
 *  证据通道的垃圾输入绝不进入判决链（防御式绝不抛的外延）。 */
export function sanitizeAudioEvent(ev) {
    if (!ev || typeof ev !== 'object')
        return null;
    const e = ev;
    const kinds = ['notification_ding', 'error_beep', 'success_chime', 'key_click', 'silence'];
    if (typeof e.event !== 'string' || !kinds.includes(e.event))
        return null;
    const confidence = typeof e.confidence === 'number' && Number.isFinite(e.confidence)
        ? Math.max(0, Math.min(1, e.confidence))
        : 0;
    const ts = typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : Date.now();
    return { event: e.event, confidence, ts };
}
