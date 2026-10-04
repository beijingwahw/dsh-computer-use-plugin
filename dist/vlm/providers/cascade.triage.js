// ─── 三因子分诊（模块常量 + 注入可调） ───
/** 缺省权重：置信 0.4 / 风险 0.4 / 新颖 0.2（三因子齐权偏保守，风险与置信并重） */
export const CASCADE_TRIAGE_WEIGHTS = {
    confidence: 0.4,
    risk: 0.4,
    novelty: 0.2,
};
/** 风险档危险分：low=0 / medium=0.5 / high=1 */
export const CASCADE_RISK_SCORE = {
    low: 0,
    medium: 0.5,
    high: 1,
};
/** 便宜臂准入阈值：danger ≤ 此值才走便宜档（边界含等号 —— 阈值注入可调） */
export const CASCADE_DANGER_MAX = 0.35;
/** 夹 [0,1]；非有限数归 fallback（不抛铁律） */
export function clamp01(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(1, Math.max(0, n));
}
/** 权重消毒：三值取非负有限、和 ≤ 0 时回退缺省权重（除零防线） */
export function normalizeWeights(w) {
    if (!w || typeof w !== 'object')
        return { ...CASCADE_TRIAGE_WEIGHTS };
    const c = clamp01(w.confidence, 0);
    const r = clamp01(w.risk, 0);
    const n = clamp01(w.novelty, 0);
    if (c + r + n <= 0)
        return { ...CASCADE_TRIAGE_WEIGHTS };
    return { confidence: c, risk: r, novelty: n };
}
/**
 * 三因子危险度打分（纯函数，绝不抛）：
 *   danger = wc·(1−confidence) + wr·riskScore + wn·novelty，夹 [0,1]。
 * 低分 = 置信高 + 低危 + 旧场景（便宜可试）；高分 = 不确定/高危/新场景（主力直行）。
 */
export function triageDanger(factors, weights) {
    const f = factors && typeof factors === 'object' ? factors : {};
    const w = normalizeWeights(weights);
    const conf = clamp01(f.confidence, 0.5); // 缺席中性：不褒不贬
    const riskScore = f.risk === 'low' || f.risk === 'medium' || f.risk === 'high'
        ? CASCADE_RISK_SCORE[f.risk]
        : CASCADE_RISK_SCORE.medium; // 脏风险档按中危保守
    const novelty = f.sceneFamiliar === true ? 0 : 1; // 缺席按新场景保守
    return clamp01(w.confidence * (1 - conf) + w.risk * riskScore + w.novelty * novelty, 0);
}
/** 便宜臂准入判定：danger ≤ dangerMax（边界含等号）；阈值缺省 CASCADE_DANGER_MAX */
export function triageCheapEligible(factors, opts) {
    const max = Number(opts?.dangerMax);
    const ceiling = Number.isFinite(max) ? max : CASCADE_DANGER_MAX;
    return triageDanger(factors, opts?.weights) <= ceiling;
}
