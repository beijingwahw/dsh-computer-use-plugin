// src/prophecy/internal.ts
// W6-2（doctor smell.over-engineering 清偿）：自 index.ts 低风险分区提取 —— 内部
// 纯工具（零异常）整体搬迁。行为零变化；仅 index.ts 消费（不进公开面）。
/** 概率夹域下界（算法形状字面量 —— 与 index 同源随迁） */
export const PROB_EPSILON = 1e-9;
// ─── 内部纯工具（零异常） ───
/** 非空字符串守卫 */
export function nonEmptyStr(v) {
    return typeof v === 'string' && v.length > 0;
}
/** 安全时钟读数：注入钟缺席/抛错 ⇒ Date.now；永不抛 */
export function safeNow(injected) {
    try {
        if (typeof injected === 'function') {
            const t = injected();
            if (typeof t === 'number' && Number.isFinite(t))
                return t;
        }
    }
    catch { /* 坏钟 ⇒ 系统钟兜底 */ }
    return Date.now();
}
/** 展示位截断（journal 一行的 Token 纪律：指纹全量留在账本，注记只留锚点） */
export function shortId(s) {
    return s.length > 16 ? `${s.slice(0, 16)}…` : s;
}
/** 结果解析：Result 形状的成功值（坏形状/坏值 ⇒ null —— 防御式读模型） */
export function resultValue(r) {
    if (!r || typeof r !== 'object' || r.ok !== true)
        return null;
    const v = r.value;
    return (v ?? null);
}
/**
 * 结算惊异差值（bits）—— 铸预言的自误定价（纯函数，永不抛）。
 * 优先走世界模型现成的 surprise() 读面（Laplace 平滑惊讶，与 D-7 计费器同一
 * 口径 —— 绝不复制实现，只复用读面）；模型缺席/抛错/坏值 ⇒ 按预言自身定价
 * 回退：miss 为 −log₂(1−p)（预言落空的惊异 —— 越自信错得越响，恒正），
 * hit 为 −log₂(p)（言中残差，≥0）。
 */
export function settleSurpriseBits(record, actualType, outcome, worldModel) {
    try {
        if (worldModel && typeof worldModel.surprise === 'function') {
            const r = worldModel.surprise(record.screenType, record.actionKey, actualType);
            const v = resultValue(r);
            if (v && typeof v.bits === 'number' && Number.isFinite(v.bits) && v.bits >= 0) {
                return Math.round(v.bits * 1e6) / 1e6;
            }
        }
    }
    catch { /* 模型故障 ⇒ 回退自误定价（绝不炸结算） */ }
    try {
        const p = typeof record.predictedProb === 'number' && Number.isFinite(record.predictedProb)
            ? Math.min(1, Math.max(0, record.predictedProb))
            : 0.5; // 无概率读数 ⇒ 中性 0.5（不自夸也不自贬）
        if (outcome === 'hit') {
            const q = Math.min(1, Math.max(PROB_EPSILON, p));
            return Math.round(-Math.log2(q) * 1e6) / 1e6;
        }
        const q = Math.min(1 - PROB_EPSILON, Math.max(PROB_EPSILON, 1 - p));
        return Math.round(-Math.log2(q) * 1e6) / 1e6; // 夹 (0,1) ⇒ 恒正
    }
    catch {
        return undefined; // 数学库故障（理论上不可达）⇒ 惊异缺席，绝不抛
    }
}
