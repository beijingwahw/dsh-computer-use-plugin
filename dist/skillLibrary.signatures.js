// ΠΑΝ-49：canonical 单源消费（canonicalStringify 的实现体 —— 见该函数注释）
import { canonicalJson } from './dialects/index.js';
/** 可重放的工具白名单：click_element 依赖运行时元素缓存，不进技能 */
export const REPLAYABLE = new Set([
    'click_mouse', 'type_text', 'scroll_page', 'press_hotkey',
    'drag_mouse', 'switch_tab', 'switch_window', 'dismiss_popup',
]);
export const stepSignature = (steps) => steps.map(s => `${s.tool}:${JSON.stringify(s.args)}`).join('|');
// ─── E-2 基因组组装（第五维·信息热力学）：OLC 重叠对齐 ───
/** 单步签名（对齐原子）与序列签名（stepSignature 的切片版） */
const stepSig1 = (s) => `${s.tool}:${JSON.stringify(s.args)}`;
const stepsSig = (ss) => ss.map(stepSig1).join('|');
/**
 * OLC（Overlap-Layout-Consensus）最长尾头重叠：求 merged 尾部与 next 头部的
 * 最长精确重叠 k（签名逐字节相等），返回 k。合成律：merged + next[k:] ——
 * 共享子序列只保留一份（基因组组装的 contig 缝合：粘性末端对齐后拼接）。
 * 保底约束：k ≤ next.length - 1（新基因必须贡献 ≥1 步新物质 —— 全包含基因
 * 是强化不是合成，走签名撞车路径）。精确匹配语义：确定性、可审计；
 * 模糊对齐（参数近似 + 场景指纹锚定）是留白。导出仅供测试（_forTest 先例）。
 */
export function olcOverlap(merged, next) {
    const maxK = Math.min(merged.length, next.length - 1);
    for (let k = maxK; k > 0; k--) {
        if (stepsSig(merged.slice(merged.length - k)) === stepsSig(next.slice(0, k)))
            return k;
    }
    return 0;
}
// ─── E-5 贝叶斯可靠度（Beta-Bernoulli 共轭后验）───
/** 后验可靠度：Beta(1,1) 均匀先验 + (s 胜 n 试) ⇒ Beta(s+1, n-s+1)。
 *  mean = (s+1)/(n+2) —— 与既有 Laplace 平滑逐字一致（零回归的结构保证）；
 *  hw = 1.96√(αβ/((α+β)²(α+β+1))) —— 95% 可信区间半宽，随证据量 n 收缩。
 *  导出纯函数：与 riskGate.matchesRiskPatterns 同律（数学原子的测试面）。 */
export function betaReliability(successCount, attemptCount) {
    const alpha = successCount + 1;
    const beta = attemptCount - successCount + 1;
    const mean = alpha / (alpha + beta);
    const hw = 1.96 * Math.sqrt((alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1)));
    return { mean, hw };
}
/**
 * 递归键排序的稳定字符串化：replacer 数组只在顶层过滤键、嵌套对象的键
 * 会被整层丢弃（JSON.stringify({a:{x:1}}, ['a']) → {"a":{}}）——
 * drag_mouse 这类嵌套 args 会全部坍缩成同一符号。排序保证键序无关性。
 * ΠΑΝ-49：实现收编为 dialects/canonical.ts 单源（全库 6 份 canonical 同族
 * 实现自此逐字节同律）。语义对齐两处（均为修复而非漂移）：① undefined 值
 * 自有键与缺键同域（旧形态串成 `"k":null`，与 JSON.stringify 落盘 dropping
 * 键不一致 —— 持久化-恢复往返会得出不同签名）；② 真环/超深 ⇒ 哨兵降级
 *（旧形态栈溢出 —— 运行层铁律「一切方法永不抛」的残余破口）。
 */
export function canonicalStringify(v) {
    return canonicalJson(v);
}
/** F-1 符号化：args → 稳定短哈希（FNV-1a —— semanticHash 同源密码学原语） */
function hashArgs(args) {
    let h = 0x811c9dc5;
    const s = canonicalStringify(args);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}
// ─── G-3 模糊量化文法归纳（第七维·过程感知）───
/** 量化网格：数值参数按 0.05 网格取整（坐标抖动 <0.025 ⇒ 同符号）。
 *  动机：同一工作流重做时坐标总有微差（0.50 vs 0.52）—— 精确签名下 SEQUITUR
 *  看不见重复。量化等价类让「同一个按钮，稍微偏一点」仍归同一符号。
 *  仅用于 mineMotifs（建议性）；OLC 重组合成（E-2）保持精确 ——
 *  建议可模糊，执行必须精确。 */
const MOTIF_QUANT = 0.05;
/** 深层数值量化（递归；数组与嵌套对象同律）—— 模糊符号化的铸造点 */
function quantizeArgs(v) {
    if (typeof v === 'number' && Number.isFinite(v)) {
        return Math.round(v / MOTIF_QUANT) * MOTIF_QUANT;
    }
    if (Array.isArray(v))
        return v.map(quantizeArgs);
    if (v && typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v).sort()) {
            out[k] = quantizeArgs(v[k]);
        }
        return out;
    }
    return v;
}
/** 模糊符号：量化后的 args 哈希（mineMotifs 专用） */
export function hashArgsFuzzy(args) {
    return hashArgs(quantizeArgs(args));
}
/** W4-1：args 的 FNV-1a 数值哈希（hashArgs 的数值形态 —— 摘要的铸造原子） */
export function hashArgsNumeric(args) {
    let h = 0x811c9dc5;
    const s = canonicalStringify(args);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
/** W4-1：休眠段容量（外来技能的隔离登记区上限 —— FIFO 驱逐） */
export const DORMANT_CAPACITY = 32;
