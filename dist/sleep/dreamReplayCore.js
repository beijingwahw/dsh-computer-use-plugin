// src/sleep/dreamReplayCore.ts
// W6-1（doctor 债清偿·smell.over-engineering）：从 dreamReplay.ts 提取的纯逻辑区 ——
// PER 权重常量、确定性原语（fnv1a）、梦方言契约类型（轨迹/世界参数/因子面）、
// 失败记录→梦轨迹映射、PER 优先级与水位线、同构世界选取。逐字节搬运（零逻辑/
// 零数值变更）；dreamReplay.ts 保留编排（runDreamReplay）与预算解析，导入面不变。
import { pcgWorldStream } from '../autonomy/gym.js';
// ─── W5-2：PER 权重与预算（模块冻结常量 —— 公式可审计的锚） ───
/** PER 公式全部常量（Object.freeze —— 审计面；测试按此手算对照） */
export const PER_WEIGHTS = Object.freeze({
    /** 惊异半饱和位（bits）：surpriseBits = 此值时 ŝ 恰 0.5 */
    surpriseHalfBits: 8,
    /** 无任何惊异证据时的先验位（bits）—— 申报在案的代用，不冒充测量 */
    surprisePriorBits: 2,
    /** 风险档乘子（benign 1.0 / sensitive 1.5 / destructive 2.5） */
    riskFactor: Object.freeze({ benign: 1.0, sensitive: 1.5, destructive: 2.5 }),
    /** 步数浪费饱和上限（步）：stepsWasted = 此值时浪费因子恰 2.0 */
    wasteCap: 20,
    /** 新近衰减半衰期（ms）：24h —— 昨夜失败权重减半 */
    halfLifeMs: 86_400_000,
    /** 失败记录无步数浪费证据时的先验（步）—— 均匀先验只定标不改排序 */
    stepsWastedPrior: 4,
});
/** 同构世界从 pcgWorldStream 取样的搜索窗（index ∈ [0, window)） */
const DREAM_STREAM_WINDOW = 16;
/** 历史决策序列的防御上限（分歧 diff 的对照面；超长截断保新） */
const HISTORY_MAX = 8;
/** 优先级数值网格（1e-6 —— 防浮点尾噪，可重放） */
const PRIORITY_GRID = 1e6;
// ─── 确定性原语（本模块零依赖铁律：哈希自带，与 evolutionEngine 同源不外借） ───
/** FNV-1a 32 位字符串哈希（>>>0 归一）—— 轨迹指纹与世界种子的确定性锚 */
export function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
/** 非负有限数守卫（垃圾计数不进公式） */
export function finiteNonNeg(v) {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}
// ─── 失败记录 → 梦轨迹（防御映射 + 冻结参数派生） ───
/** 历史动作 kind 词表（approach 尽力解析的字面 —— 与 PolicyAction kinds 同源） */
const KNOWN_KINDS = [
    'click', 'scroll', 'type', 'hotkey', 'drag', 'inspect', 'ask_vlm', 'recall_skill', 'wait', 'escalate', 'declare',
    // 旧工具层方言（actionSignature 的 name 面）一并认领
    'click_mouse', 'type_text', 'scroll_wheel', 'press_keys', 'zoom_inspect',
];
/**
 * 从 approach 文本尽力解析历史决策序列（确定性、绝不抛）：贪心最长词匹配 ——
 * 逐位扫描，每位置取词表中最长的命中词（'click_mouse' 不被 'click' 拆成两步），
 * 取前 HISTORY_MAX 步。这是**申报的尽力面**：真实失败记录的 approach 是
 * 「工具+参数摘要」自由文本，解析不全是诚实降级（history 越短，分歧点越晚或
 * 缺席 —— 绝不伪造未发生的决策）。
 */
function parseHistoryFromApproach(approach) {
    const text = typeof approach === 'string' ? approach : '';
    if (text === '')
        return [];
    const sorted = [...KNOWN_KINDS].sort((a, b) => b.length - a.length); // 长词优先
    const steps = [];
    let i = 0;
    while (i < text.length && steps.length < HISTORY_MAX) {
        let matched = false;
        for (const kind of sorted) {
            if (text.startsWith(kind, i)) {
                steps.push({ kind });
                i += kind.length;
                matched = true;
                break;
            }
        }
        if (!matched)
            i += 1;
    }
    return steps;
}
/** 轨迹身份指纹（同构世界种子派生 + 水位线的原料；缺 sceneHash 时用文本三元组） */
function trajectoryFingerprint(t) {
    const scene = typeof t.sceneHash === 'string' && t.sceneHash ? t.sceneHash : '';
    if (scene)
        return scene;
    return `${t.query}|${t.approach}|${t.symptom}`.slice(0, 200);
}
/**
 * 失败记录 → 梦轨迹批次（防御式，绝不抛）：
 *   · 逐条净化（id/query/approach/symptom/at 防守；垃圾条目静默剔除）；
 *   · 冻结世界参数：显式 world 优先（seed/difficulty/noise/weights 原样采用 ——
 *     「场景输入冻结」的强形式）；缺席 ⇒ 由轨迹身份确定性派生（seed 与难度皆
 *     指纹哈希钉死 —— 同轨迹恒同世界，派生过程申报在案）；
 *   · history：显式序列优先；缺席 ⇒ approach 尽力解析；
 *   · 输入既可是 FailureRecord[]（生产：failureMemory.dump().records）也可是
 *     已铸的 DreamFailureTrajectory[]（测试）—— 同一净化律。
 */
export function dreamTrajectories(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    raw.forEach((item, idx) => {
        if (!item || typeof item !== 'object')
            return;
        const r = item;
        const id = typeof r.id === 'number' && Number.isFinite(r.id) ? String(Math.floor(r.id))
            : typeof r.id === 'string' && r.id ? r.id
                : null;
        if (id === null)
            return; // 无身份的轨迹不成梦（防重复回放失去锚）
        const query = typeof r.query === 'string' ? r.query.slice(0, 200) : '';
        const approach = typeof r.approach === 'string' ? r.approach.slice(0, 300) : '';
        const symptom = typeof r.symptom === 'string' ? r.symptom.slice(0, 300) : '';
        const at = typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0;
        const sceneHash = typeof r.sceneHash === 'string' && r.sceneHash ? r.sceneHash.slice(0, 100) : undefined;
        const rootCause = typeof r.rootCause === 'string' && r.rootCause ? r.rootCause.slice(0, 40) : undefined;
        const riskTier = r.riskTier === 'sensitive' || r.riskTier === 'destructive' ? r.riskTier
            : r.riskTier === 'benign' ? 'benign'
                : undefined;
        const stepsWasted = finiteNonNeg(r.stepsWasted) ?? undefined;
        const surpriseBits = finiteNonNeg(r.surpriseBits) ?? undefined;
        const sceneType = typeof r.sceneType === 'string' && r.sceneType ? r.sceneType.slice(0, 64) : undefined;
        // 冻结世界参数：显式优先，否则指纹派生（确定性 —— 同轨迹恒同世界）
        const fp = trajectoryFingerprint({ query, approach, symptom, sceneHash });
        const rawWorld = r.world && typeof r.world === 'object' ? r.world : {};
        const seedOk = typeof rawWorld.seed === 'number' && Number.isFinite(rawWorld.seed) && rawWorld.seed >= 0;
        const diffOk = typeof rawWorld.difficulty === 'number' && Number.isFinite(rawWorld.difficulty)
            ? Math.min(3, Math.max(1, Math.floor(rawWorld.difficulty)))
            : null;
        const world = {
            seed: seedOk ? Math.floor(rawWorld.seed) % 0x80000000 : fnv1a(`w5-2:dream-world:${id}:${fp}`) % 0x7fffffff,
            ...(diffOk !== null ? { difficulty: diffOk } : { difficulty: 1 + (fnv1a(`w5-2:dream-diff:${id}:${fp}`) % 3) }),
            ...(rawWorld.noise && typeof rawWorld.noise === 'object' ? { noise: rawWorld.noise } : {}),
            ...(rawWorld.weights && typeof rawWorld.weights === 'object' && !Array.isArray(rawWorld.weights)
                ? { weights: rawWorld.weights }
                : {}),
        };
        const history = Array.isArray(r.history)
            ? r.history
                .filter((s) => !!s && typeof s === 'object' && typeof s.kind === 'string')
                .slice(0, HISTORY_MAX)
                .map(s => ({
                kind: String(s.kind).slice(0, 24),
                ...(typeof s.label === 'string' && s.label ? { label: s.label.slice(0, 60) } : {}),
            }))
            : parseHistoryFromApproach(approach);
        out.push({
            id,
            query,
            approach,
            symptom,
            ...(sceneHash !== undefined ? { sceneHash } : {}),
            ...(rootCause !== undefined ? { rootCause } : {}),
            at,
            ...(riskTier !== undefined ? { riskTier } : {}),
            ...(stepsWasted !== undefined ? { stepsWasted } : {}),
            ...(surpriseBits !== undefined ? { surpriseBits } : {}),
            ...(sceneType !== undefined ? { sceneType } : {}),
            ...(history.length > 0 ? { history } : {}),
            world,
        });
    });
    return out;
}
// ─── PER 优先级（纯函数、模块常量、手算可验） ───
/**
 * 惊异 bits 的证据回落链（诚实缺席律）：轨迹自带 > 谱按键命中 > 谱均值 > 先验。
 * 返回值连同来源申报（surpriseSource）—— 晨报可回算「这个 0.37 是哪来的」。
 */
function resolveSurpriseBits(t, spectrum) {
    const own = finiteNonNeg(t.surpriseBits);
    if (own !== null)
        return { bits: own, source: 'trajectory' };
    if (spectrum && typeof spectrum === 'object' && !Array.isArray(spectrum)) {
        const key = typeof t.sceneType === 'string' ? t.sceneType : '';
        if (key && finiteNonNeg(spectrum[key]) !== null) {
            return { bits: finiteNonNeg(spectrum[key]), source: 'spectrum-key' };
        }
        const vals = Object.values(spectrum).map(v => finiteNonNeg(v)).filter((v) => v !== null);
        if (vals.length > 0) {
            const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
            if (Number.isFinite(mean))
                return { bits: Math.max(0, mean), source: 'spectrum-mean' };
        }
    }
    return { bits: PER_WEIGHTS.surprisePriorBits, source: 'prior' };
}
/**
 * W5-2 PER 优先级（纯函数、绝不抛）：
 *   p = ŝ × cost × recency
 *   ŝ = bits/(bits+surpriseHalfBits)；cost = riskFactor × (1 + min(waste,wasteCap)/wasteCap)；
 *   recency = 2^(−age/halfLifeMs)，age = max(0, now − at)（at 缺席按 0 —— 「未知
 *   年龄视为新鲜」：宁可多给一次梦，不可静默永不回放）。
 * 网格化 1e-6（防浮点尾噪 —— 同输入同输出，可重放）。垃圾输入逐因子回落申报
 * 先验/缺省，结果恒有限非负。
 */
export function computeDreamPriority(t, ctx = {}) {
    const { bits, source } = resolveSurpriseBits(t, ctx.spectrum);
    const denom = bits + PER_WEIGHTS.surpriseHalfBits;
    const surpriseFactor = denom > 0 && Number.isFinite(denom) ? bits / denom : 0;
    const tier = t.riskTier === 'sensitive' || t.riskTier === 'destructive' ? t.riskTier : 'benign';
    const wasteRaw = finiteNonNeg(t.stepsWasted) ?? PER_WEIGHTS.stepsWastedPrior;
    const wasteFactor = 1 + Math.min(wasteRaw, PER_WEIGHTS.wasteCap) / PER_WEIGHTS.wasteCap;
    const cost = PER_WEIGHTS.riskFactor[tier] * wasteFactor;
    const now = typeof ctx.now === 'number' && Number.isFinite(ctx.now) ? ctx.now : 0;
    const age = Math.max(0, now - (typeof t.at === 'number' && Number.isFinite(t.at) ? t.at : 0));
    const recency = Math.pow(2, -age / PER_WEIGHTS.halfLifeMs);
    const p = surpriseFactor * cost * (Number.isFinite(recency) ? recency : 0);
    return {
        p: Number.isFinite(p) ? Math.round(p * PRIORITY_GRID) / PRIORITY_GRID : 0,
        factors: {
            surpriseBits: Math.round(bits * PRIORITY_GRID) / PRIORITY_GRID,
            surpriseSource: source,
            cost: Math.round(cost * PRIORITY_GRID) / PRIORITY_GRID,
            recency: Math.round(recency * PRIORITY_GRID) / PRIORITY_GRID,
        },
    };
}
/**
 * 梦回放批次水位线（纯函数）：输入失败集的**身份指纹**（id/at/sceneHash/文本
 * 三元组/冻结世界参数的规范形，按 id 排序 —— 与 now 与优先级无关：年龄增长
 * 不改变「这批失败已梦过」的事实，防重复回放的锚是身份不是分数）。
 */
export function dreamBatchWatermark(trajectories) {
    const canon = trajectories
        .map(t => [
        t.id,
        typeof t.at === 'number' && Number.isFinite(t.at) ? t.at : 0,
        t.sceneHash ?? '',
        t.query,
        t.approach,
        t.symptom,
        t.world?.seed ?? -1,
        t.world?.difficulty ?? -1,
    ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        .map(row => JSON.stringify(row));
    return `dream-${fnv1a(canon.join('')).toString(16)}`;
}
// ─── 同构世界选取（从 pcgWorldStream 取 —— seed 与世界参数来自原轨迹） ───
/**
 * W5-2 同构世界选取（确定性纯函数，绝不抛）：
 *   master = fnv1a('w5-2:dream:master:<id>:<指纹>') —— 轨迹身份钉死的流水主种子；
 *   index  = fnv1a('w5-2:dream:index:<id>:<指纹>') % DREAM_STREAM_WINDOW；
 *   world  = pcgWorldStream(master, 冻结语法制量).nth(index)。
 * 「同构」的落地：失败记录只携场景指纹与文本，同构世界按指纹确定性映射到文法
 * 世界 —— 同轨迹恒同世界（重放确定性的地基）；显式 world 参数（seed/难度/
 * 噪声/课程权重）原样入语法量（「冻结场景输入」的强形式：当时的课程偏置也冻结）。
 */
export function pickIsomorphicWorld(t) {
    const fp = trajectoryFingerprint(t);
    const index = fnv1a(`w5-2:dream:index:${t.id}:${fp}`) % DREAM_STREAM_WINDOW;
    const w = t.world ?? {};
    const grammar = {
        ...(typeof w.difficulty === 'number' && Number.isFinite(w.difficulty)
            ? { difficulty: Math.min(3, Math.max(1, Math.floor(w.difficulty))) }
            : {}),
        ...(w.noise && typeof w.noise === 'object' ? { noise: w.noise } : {}),
        ...(w.weights && typeof w.weights === 'object' && !Array.isArray(w.weights) ? { weights: w.weights } : {}),
    };
    // 冻结的流水主种子：显式 world.seed 优先，否则由轨迹身份确定性派生（同律
    // dreamTrajectories 的派生口径 —— master 即「场景输入冻结」的种子锚）
    const master = typeof w.seed === 'number' && Number.isFinite(w.seed) && w.seed >= 0
        ? Math.floor(w.seed) % 0x80000000
        : fnv1a(`w5-2:dream-world:${t.id}:${fp}`) % 0x7fffffff;
    // 从流水取第 index 个世界（构造即推导 —— 零渲染开销，直到 capture 才碰 sharp）
    const stream = pcgWorldStream(master, grammar);
    let picked = stream.next().value;
    for (let i = 0; i < index; i++)
        picked = stream.next().value;
    return { world: picked, index, master };
}
