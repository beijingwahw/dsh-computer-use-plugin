// src/fuzzy.ts
// R 纪元（模糊层）：近似子串搜索 —— OCR 世界的容错匹配器官。
//
// 理论根基：子串编辑距离 = min over j 的 D(m, j)（模式全长 vs 以 j 结尾的
// 任意子串），经典 Wagner–Fischer DP 的行进形态，O(mn) 时间 / O(m) 空间。
// 已知更快的 Myers 1999 位向量法是 O(⌈m/w⌉·n) —— 本器官**有意选经典 DP**：
// ① 实用域（OCR 词/短语 m ≤ 64、行文本 n ≤ 数百）下 mn ≤ 10⁵，两位字运算
//    与 DP 的常数差在此域不可感；② DP 逐格可审计（每一分判据都能画表回放），
//    位并行的差分编码是审计黑盒 —— 本仓「证据先于修辞」律优先。
// 若未来 m 进入千字符域（文档级模糊对齐），再立 Myers 器官（推导已备案）。
//
// 为什么这个器官存在：OCR 把 'l' 读成 '1'、'O' 读成 '0'、吞空格 ——
// expected_text 的**逐字节 includes 对照**在真机上必然漏判（"找到了但判
// 没找到"）。容错 ≤ ⌈m/6⌉ 的近似匹配把 OCR 噪声从判据中滤掉。
// 纯函数、零依赖、确定性。
/**
 * 近似子串搜索：模式 pattern 在 text 中的最小编辑距离（Levenshtein：
 * 插入/删除/替换）与命中终点。空模式返回 null（语义交调用方）。
 */
export function approximateSubstring(pattern, text) {
    const m = pattern.length;
    const n = text.length;
    if (m === 0)
        return null;
    let prev = Array.from({ length: m + 1 }, (_, i) => i);
    let best = { distance: m, endAt: -1 };
    for (let j = 1; j <= n; j++) {
        const cur = new Array(m + 1);
        cur[0] = 0; // 子串语义：任意起点免费起跑（与全序列编辑距离的分野）
        for (let i = 1; i <= m; i++) {
            const cost = pattern[i - 1] === text[j - 1] ? 0 : 1;
            cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + cost);
        }
        if (cur[m] < best.distance)
            best = { distance: cur[m], endAt: j - 1 };
        prev = cur;
    }
    return best;
}
/** 容错命中判决：编辑距离 ≤ ⌈m/6⌉（OCR 每六字符容一错的经验律；可显式覆写） */
export function fuzzyIncludes(pattern, text, tolerance) {
    if (pattern.length === 0)
        return true;
    const hit = approximateSubstring(pattern, text);
    if (!hit)
        return true;
    const k = tolerance ?? Math.ceil(pattern.length / 6);
    return hit.distance <= k;
}
