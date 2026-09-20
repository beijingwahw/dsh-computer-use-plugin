// src/ncd.ts
// H 纪元（创世纪·场的统一）：NCD —— 标准化压缩距离（Normalized Compression Distance）。
//
// 理论根基（Cilibrasi & Vitányi 2004「Clustering by Compression」）：
//   NCD(x,y) = [C(xy) − min(C(x),C(y))] / max(C(x),C(y)) ∈ [0, ≈1]
// 其中 C 是 Kolmogorov 复杂度 K(s) 的可计算上界（此处：LZ76 短语数 × 字母表
// 信息量的代理）。数学性质：同一字符串 ⇒ 0；信息无关 ⇒ →1；**两串无需共享任何
// 词面 token** —— 只要拼接后比各自单独更可压缩（共享结构），距离就低。
//
// 与既有相似度通道的正交性：token overlap（词面重合）与 subword 嵌入（语义簇）
// 都依赖「字/词」级共享；NCD 在**任意子结构**层捕获共享 —— 换述/换语言/换拼写的
// 同义死路（「点击无反应」vs「点了没动静」：零共享词，但压缩器看得见同构）。
//
// 诚实边界：短语数是 K(s) 的粗糙上界（比值仍单调反映共享结构）；生产级 NCD 用
// gzip/zstd 级压缩器（熵编码阶段更接近 K）—— 零依赖哲学下的留白，形状由测试守护。
/** 字符串 LZ76 短语数（Kolmogorov 复杂度的上界代理 —— journal.lempelZivComplexity
 *  的字符域孪生；独立实现避免 symbol→char 的转译歧义） */
export function lzCount(s) {
    if (s.length === 0)
        return 0;
    let phrases = 1;
    let i = 1;
    while (i < s.length) {
        let l = 0;
        for (let len = 1; i + len <= s.length; len++) {
            if (s.slice(0, i).includes(s.slice(i, i + len)))
                l = len;
            else
                break;
        }
        phrases++;
        i += l + 1;
    }
    return phrases;
}
/**
 * 标准化压缩距离（纯函数）：0 ⇒ 结构同一；→1 ⇒ 信息无关。
 * 空串守卫：任一空 ⇒ 双空 0 / 单空 1（空串与任何串无共享结构）。
 */
export function ncd(a, b) {
    if (a.length === 0 && b.length === 0)
        return 0;
    if (a.length === 0 || b.length === 0)
        return 1;
    // 压缩器非理想性特判（NCD 原论文同律）：短语代理下 C(xx) > C(x)（第二份
    // 拷贝仍贡献短语）—— 同一字符串在信息论上距离恒 0，特判归还定义
    if (a === b)
        return 0;
    const ca = lzCount(a);
    const cb = lzCount(b);
    const cab = lzCount(a + b);
    const cmin = Math.min(ca, cb);
    const cmax = Math.max(ca, cb);
    if (cmax === 0)
        return 0;
    const d = (cab - cmin) / cmax;
    // 压缩器的非理想性可能产生轻微负值（C(xy) < C(x)）—— 钳到 [0,1]（NCD 论文同律）
    return Math.round(Math.min(1, Math.max(0, d)) * 1000) / 1000;
}
/** 相似度视图：1 − NCD（与 overlapCoefficient 的取值域对齐，便于加权融合） */
export function ncdSimilarity(a, b) {
    return Math.round((1 - ncd(a, b)) * 1000) / 1000;
}
