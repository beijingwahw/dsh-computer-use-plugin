// src/knowledge/memoryOps.ts
// W2-6（创新提案 M5：分类级记忆操作 Thompson 老虎机）—— 记忆操作即摇臂。
//
// 立法动机：知识库的四类记忆操作（insert / boost / evict / no-op）目前由全库
// 统一的静态常数执法（AUTO_LEARN_FAILURE_CONFIDENCE、P.REINFORCE_STEP 等）——
// 「error-pattern 要激进学习、preference 要保守」这类分类级差异没有表达通道。
// 本模块把「(category × 操作) 的操作阈值」铸成老虎机摇臂：每臂独立
// Beta(s+1, f+1) 后验，Thompson 采样决定该臂阈值（注册表区间内插值），
// 检索命中 × 注入助益作奖励反馈，EvidenceLedger 逐臂记账（200 条 FIFO）。
//
// 三条先例律（与 registry.ts / params.ts 同源，一字不违）：
//   · 统计正确 —— Beta 采样走 Marsaglia–Tsang Gamma 桥（后验均值可手算回验），
//     门限下不采样（Beta(1,1) 先验主导的采样 = 纯噪声）；
//   · seed 可复现 —— RNG 注入（seededRng 种子流），同 seed + 同账本态 ⇒ 逐位重放一致；
//   · 防御式绝不抛 —— 一切公共 API 对垃圾输入静默降级（Result 方言 / 诚实缺席），
//     采样与映射的每条路径都有迭代上限与有限值护栏（NaN 流不悬挂、不传染）。
//
// 与 kernelRegistry 的关系（M5 台账律）：
//   · 每臂一个注册键 `memory.op.<category>.<op>`（28 臂 = 7 类 × 4 操作），
//     带可行区间与证据计数入册 —— registerMemoryOpKernels() 幂等（重复注册
//     保持现值，registry 契约）；**不触碰既有 55 键的语义**（键名空间隔离）；
//   · EvidenceLedger 逐臂记成败（recordMemoryOpFeedback），registry.addEvidence
//     同步累加计数 —— 账本（成败明细）与注册表（计数摘要）双轨，单源双视图；
//   · 反馈不足（n < MEMORY_OP_FEEDBACK_GATE）⇒ 阈值恒为现行静态常数
//     （defaultValue = 各消费点现行字面量 —— 零行为变化的安全带）。
//
// sleep 接线（本模块不 import sleep —— 收敛器独立暴露，接线是宿主的事）：
//   sleep/index.ts 第④幕（校准幕）的 SleepDeps 增加可选面
//   `memoryOpsConverger?: () => MemoryOpsConvergenceReport`，actCalibrate 旁挂调用
//   convergeMemoryOps({ seed: <水位线或确定性种子> })，报告条目并入晨报 ——
//   立法与纪元 Ζ 标定建议书同律：「睡眠出收敛、白天做决定」的落值版。
import { cohensH } from './metrics.js';
import { kernelRegistry, evidenceLedger } from '../kernel/registry.js';
// ─── W2-6：臂空间（分类学 × 操作全集 —— 与 knowledgeBase.ts CATEGORIES 同序同词表）───
/** 记忆操作四类（摇臂的动作词表）：入库 / 强化 / 驱逐 / 弃权 */
export const MEMORY_OP_KINDS = ['insert', 'boost', 'evict', 'noop'];
/** 分类学全集（与 contracts.KnowledgeCategory 同词表、与 knowledgeBase CATEGORIES 同序） */
export const MEMORY_OP_CATEGORIES = [
    'ui-pattern', 'shortcut', 'system-quirk',
    'business-rule', 'error-pattern', 'workflow', 'preference',
];
/**
 * 每臂操作阈值的可行区间与现行静态常数（defaultValue = 消费点现行字面量 ——
 * n < 门限时零行为变化的锚）。区间出处：
 *   · insert [0.1, 0.6] / 缺省 0.3 —— AUTO_LEARN_FAILURE_CONFIDENCE（knowledgeBase.ts：
 *     自体学习失败铸造的初始置信）；区间下界 0.1 = 再低则噪声入库，上界 0.6 =
 *     压制阈值量级（REFLEX_SUPPRESS_CONFIDENCE 上沿）；
 *   · boost [0.2, 1.0] / 缺省 0.3 —— P.REINFORCE_STEP，区间照 params.ts 注记的
 *     可行区间原文（下界由 E3 物理约束定标：3 次复证必须过压制线）；
 *   · evict [0.01, 0.3] / 缺省 0.05 —— 有效置信驱逐地板（新锚：现行容量驱逐
 *     MAX_ENTRIES 不动，本键是「按置信让位」的新通道，0.05 = 极保守起点）；
 *   · noop [0.2, 0.65] / 缺省 0.2 —— P.VERIFY_TRUST_FLOOR 同值同区间（params.ts
 *     注记的可行区间原文）：低于该信任的操作让位 no-op（少干预）。
 */
const OP_THRESHOLDS = {
    insert: {
        min: 0.1, max: 0.6, defaultValue: 0.3,
        note: 'auto-learn 入库置信门槛：低于此值的新学条目不入库（缺省 0.3 = AUTO_LEARN_FAILURE_CONFIDENCE 现行字面量）',
    },
    boost: {
        min: 0.2, max: 1.0, defaultValue: 0.3,
        note: '该类条目复证强化步长：confidence += (1-confidence)×此值（缺省 0.3 = P.REINFORCE_STEP 现行字面量；区间照 params.ts）',
    },
    evict: {
        min: 0.01, max: 0.3, defaultValue: 0.05,
        note: '有效置信驱逐地板：衰减后有效置信低于此值的 auto-learn 条目可被让位（缺省 0.05 极保守；现行容量驱逐路径不受此键影响）',
    },
    noop: {
        min: 0.2, max: 0.65, defaultValue: 0.2,
        note: '弃权门槛：该类条目信任低于此值时记忆操作让位 no-op（缺省 0.2 = P.VERIFY_TRUST_FLOOR 现行字面量；区间照 params.ts）',
    },
};
/** 注册键铸造：`memory.op.<category>.<op>`（点分词表与既有 55 键同风格） */
export function memoryOpKey(category, op) {
    return `memory.op.${category}.${op}`;
}
/** 全部 28 臂的注册规格（分类学序 × 操作序 —— 确定性枚举序，重放的轴之一） */
export function memoryOpSpecs() {
    const specs = [];
    for (const category of MEMORY_OP_CATEGORIES) {
        for (const op of MEMORY_OP_KINDS) {
            const t = OP_THRESHOLDS[op];
            specs.push({
                key: memoryOpKey(category, op),
                organ: 'knowledge',
                defaultValue: t.defaultValue,
                min: t.min,
                max: t.max,
                note: `W2-6 ${t.note} [category=${category}]`,
            });
        }
    }
    return specs;
}
/** 臂规格查表（词表内臂 ⇒ 必中；垃圾输入 ⇒ null —— 纯查表绝不抛） */
export function memoryOpSpecOf(key) {
    for (const s of memoryOpSpecs())
        if (s.key === key)
            return s;
    return null;
}
/**
 * 幂等入册（M5 台账律）：把 28 个 memory.op.* 阈值键注册进注册表。
 * 首次 ⇒ value = defaultValue（零行为变化）；重入 ⇒ 保持现值只刷规格
 * （registry.register 幂等契约）。返回入册键数（审计面）。
 */
export function registerMemoryOpKernels(registry = kernelRegistry) {
    let n = 0;
    for (const spec of memoryOpSpecs()) {
        registry.register(spec);
        n += 1;
    }
    return n;
}
// W6-2（doctor smell.over-engineering 清偿）：确定性 RNG 与 Beta 采样已分区提取至
// memoryOps.random.ts（纯数学，行为零变化）；导入面不变 —— 再分发。
import { seededRng, betaSample, betaPosteriorFromStats } from './memoryOps.random.js';
export { seededRng, betaSample, betaPosterior, betaPosteriorFromStats } from './memoryOps.random.js';
// ─── W2-6：奖励函数（M5 规格：奖励 = 该条目 N 天内被检索命中 + 注入后助益）───
// ΝΩ-28 任务3（奖励归因去噪·第一阶段）：helped 判定从「窗口级全局布尔」升级为
// 两队列对照 —— 详见 compareHelpedCohorts 与 harvestMemoryOpRewards 的归因注记。
/** 奖励窗口缺省：7 天（M5 规格的 N —— 一周的自然任务周期量级） */
export const DEFAULT_REWARD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * 逐条目二元奖励判定（纯函数，手算可回验）：
 *   success := 命中(hit) ∧ 助益(helped)
 *   · hit = 该条目被检索过（usageCount > 0 —— query 的使用度簿记）；
 *   · helped 的语义由收割方（harvestMemoryOpRewards）铸造：两队列对照充足时 =
 *     注入在场组完成率显著占优；样本不足时回退「∃ 注入在场且完成的 run」。
 * 未命中或未助益 ⇒ failure（占库不产出 / 产出未变现，都是操作的机会成本）。
 */
export function evaluateMemoryOpSuccess(hit, helped) {
    return hit === true && helped === true;
}
/**
 * 两队列完成率对照（纯函数，ΝΩ-28 任务3）：
 *   · helped := 在场组完成率 > 缺席组完成率，以 Cohen's h 定号（h > 0 ⇔ 在场组
 *     更高；二元 0/1 结局下秩检验与比例差完全同序，h 在比例近 0/1 域不虚胀 ——
 *     复用 metrics.ts 的既有效应量面，不新铸统计）；
 *   · 两队列各 ≥ 2（样本充足下限）⇒ 对照成立；任一侧 < 2 ⇒ null —— 诚实交给
 *     调用方回退窗口级全局布尔（1v1 的完成率对照是掷硬币，不是证据）。
 * 垃圾计数（负数 / 非有限 / 分母 0 已被 <2 守卫排除）⇒ null，绝不抛。
 */
export function compareHelpedCohorts(c) {
    if (!c || typeof c !== 'object')
        return null;
    const { present, presentCompleted, absent, absentCompleted } = c;
    if (present === undefined || presentCompleted === undefined || absent === undefined || absentCompleted === undefined) {
        return null;
    }
    if (![present, presentCompleted, absent, absentCompleted].every(v => Number.isFinite(v) && v >= 0)) {
        return null;
    }
    if (present < 2 || absent < 2)
        return null;
    const h = cohensH(presentCompleted / present, absentCompleted / absent);
    return (h ?? 0) > 0;
}
/**
 * 奖励收割（metrics 反馈源 → 逐类别试验账）：
 *   · 窗口 W = [now − windowMs, now]；runs 取 ts ∈ W，条目取 updatedAt ∈ W
 *     （usageCount 无逐次时间戳 —— updatedAt 是最后一次触碰的诚实代理，文档在案）；
 *   · helped 归因（ΝΩ-28 任务3 两队列对照）：窗口内 run 按知识注入在场性分
 *     两队列 —— 在场组（knowledgeRounds > 0，经验被消费）/ 缺席组（对照组），
 *     比较完成率（Cohen's h 定号）。任一侧 < 2 ⇒ 回退现行窗口级全局布尔
 *     （∃ 注入在场且 completed 的 run）：样本不足时完成率对照无统计力，
 *     旧布尔是它诚实（且零漂移）的退化形。去噪收益：知识全速注射但完成率
 *     反而更差的库不再全员记 success —— 全局布尔把「恰好有完成的 run」
 *     归因为「注入有助益」，两队列对照拆穿这个混杂。
 * 垃圾输入（非数组 / 字段缺失 / 时间戳畸形）静默跳过 —— 绝不抛。返回恒为全分类学
 * 键的完整映射（无数据类别 = 全零账，不缺席 —— 消费方可直索引）。
 */
export function harvestMemoryOpRewards(entries, runs, opts) {
    const out = {};
    for (const c of MEMORY_OP_CATEGORIES)
        out[c] = { successes: 0, failures: 0, entries: 0 };
    const windowMs = Number.isFinite(opts?.windowMs) && opts?.windowMs > 0
        ? opts?.windowMs : DEFAULT_REWARD_WINDOW_MS;
    const now = Number.isFinite(opts?.now) ? opts?.now : Date.now();
    // 助益归因：两队列完成账 + 现行布尔（样本不足的回退臂）
    const cohorts = { present: 0, presentCompleted: 0, absent: 0, absentCompleted: 0 };
    let fallbackHelped = false;
    if (Array.isArray(runs)) {
        for (const r of runs) {
            if (!r || typeof r !== 'object')
                continue;
            const ts = r.ts;
            const kr = r.knowledgeRounds;
            if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < now - windowMs || ts > now)
                continue;
            if (typeof kr !== 'number' || !Number.isFinite(kr))
                continue;
            if (kr > 0) {
                cohorts.present += 1;
                if (r.verdict === 'completed') {
                    cohorts.presentCompleted += 1;
                    fallbackHelped = true;
                }
            }
            else {
                cohorts.absent += 1;
                if (r.verdict === 'completed')
                    cohorts.absentCompleted += 1;
            }
        }
    }
    const helped = compareHelpedCohorts(cohorts) ?? fallbackHelped;
    if (!Array.isArray(entries))
        return out;
    // isArray 守卫把 readonly KnowledgeEntry[] 窄化成与 any[] 的交集（元素被 any
    // 传染 —— TS 已知行为），显式还原元素类型；运行时垃圾防御靠下方逐字段守卫
    const list = entries;
    for (const e of list) {
        if (!e || typeof e !== 'object')
            continue;
        if (!MEMORY_OP_CATEGORIES.includes(e.category))
            continue;
        if (typeof e.updatedAt !== 'number' || !Number.isFinite(e.updatedAt))
            continue;
        if (e.updatedAt < now - windowMs || e.updatedAt > now)
            continue;
        const hit = typeof e.usageCount === 'number' && e.usageCount > 0;
        const success = evaluateMemoryOpSuccess(hit, helped);
        const t = out[e.category];
        t.entries += 1;
        if (success)
            t.successes += 1;
        else
            t.failures += 1;
    }
    return out;
}
/**
 * 记一次 (category × op) 臂成败：EvidenceLedger 记原子（200 FIFO 滑窗由账本保证），
 * registry.addEvidence 同步 +1（计数摘要轨）。幂等入册先行（键必须在册才可记账 ——
 * 台账律）。垃圾输入 {ok:false} 绝不抛；诚实记账恒 {ok:true}。
 */
export function recordMemoryOpFeedback(category, op, success, deps = {}) {
    if (!MEMORY_OP_CATEGORIES.includes(category)) {
        return { ok: false, reason: `unknown category ${JSON.stringify(category)}` };
    }
    if (!MEMORY_OP_KINDS.includes(op)) {
        return { ok: false, reason: `unknown op ${JSON.stringify(op)}` };
    }
    if (typeof success !== 'boolean') {
        return { ok: false, reason: `success must be boolean, got ${typeof success}` };
    }
    const d = deps ?? {};
    const registry = d.registry ?? kernelRegistry;
    const ledger = d.ledger ?? evidenceLedger;
    const key = memoryOpKey(category, op);
    try {
        registerMemoryOpKernels(registry);
        ledger.record({ key, success, ts: Number.isFinite(d.ts) ? d.ts : Date.now() });
        registry.addEvidence(key, 1);
        return { ok: true };
    }
    catch {
        return { ok: false, reason: 'ledger/registry degraded (never throws)' };
    }
}
/**
 * 收割账 → 逐臂记账（把 harvestMemoryOpRewards 的逐类别试验写进指定操作的臂）。
 * 缺省记入 'insert' 臂（条目在场 = 入库操作的产物 —— 奖励通道的默认语义）；
 * 显式 op 可把同一份试验账归因到 boost/evict/noop 臂。返回记账总数（审计面）。
 */
export function applyHarvestedRewards(trials, op = 'insert', deps = {}) {
    if (!trials || typeof trials !== 'object')
        return 0;
    const d = deps ?? {};
    let recorded = 0;
    for (const c of MEMORY_OP_CATEGORIES) {
        const t = trials[c];
        if (!t || typeof t !== 'object')
            continue;
        const s = Number.isFinite(t.successes) && t.successes > 0 ? Math.round(t.successes) : 0;
        const f = Number.isFinite(t.failures) && t.failures > 0 ? Math.round(t.failures) : 0;
        for (let i = 0; i < s; i++) {
            if (recordMemoryOpFeedback(c, op, true, d).ok)
                recorded += 1;
        }
        for (let i = 0; i < f; i++) {
            if (recordMemoryOpFeedback(c, op, false, d).ok)
                recorded += 1;
        }
    }
    return recorded;
}
// ─── W2-6：阈值决策（采样 → 区间插值 → 夹取 —— 臂的动作参数）───
/** 反馈门限：每臂 n < 8 不采样（Beta(1,1) 先验主导 ⇒ 采样是噪声 —— 用静态常数） */
export const MEMORY_OP_FEEDBACK_GATE = 8;
/**
 * 采样 → 阈值（纯函数，手算可回验）：θ 插值 min + θ×(max−min)，双侧夹取；
 * θ 非有限 ⇒ 区间中点（无偏回退 —— NaN 不许传染进注册表）。
 */
export function thresholdFromSample(sample, min, max) {
    const lo = Number.isFinite(min) ? min : 0;
    const hiRaw = Number.isFinite(max) ? max : 1;
    const hi = hiRaw > lo ? hiRaw : lo + 1;
    if (!Number.isFinite(sample))
        return lo + (hi - lo) / 2;
    const t = Math.min(1, Math.max(0, sample));
    const v = lo + t * (hi - lo);
    return v < lo ? lo : v > hi ? hi : v;
}
/**
 * 单臂决策：查账 → 门限判定 → （过门限）Beta 采样 → 区间插值。垃圾臂返回
 * null（绝不抛）。rng 缺省 = 按臂状态派生的种子流（决策本身可重放）：
 * seed = `<key>#<n>#<alpha>#<beta>` —— 同账本态 ⇒ 同阈值。
 */
export function decideMemoryOpThreshold(category, op, deps = {}) {
    if (!MEMORY_OP_CATEGORIES.includes(category))
        return null;
    if (!MEMORY_OP_KINDS.includes(op))
        return null;
    const key = memoryOpKey(category, op);
    const spec = memoryOpSpecOf(key);
    if (!spec)
        return null; // 防御带（词表同源 ⇒ 实际不可达）
    try {
        const d = deps ?? {}; // null deps 走生产单例缺省（绝不抛）
        const registry = d.registry ?? kernelRegistry;
        const ledger = d.ledger ?? evidenceLedger;
        registerMemoryOpKernels(registry);
        const stats = ledger.stats(key);
        const { alpha, beta } = betaPosteriorFromStats(stats.n, stats.successRate);
        const n = Number.isFinite(stats.n) ? stats.n : 0;
        const successes = alpha - 1;
        const failures = beta - 1;
        const gate = Number.isFinite(d.gate) && d.gate >= 0
            ? d.gate : MEMORY_OP_FEEDBACK_GATE;
        if (n < gate) {
            // 安全带：反馈不足 ⇒ 现行静态常数（零行为变化 —— 不采样、不受漂移值牵连）
            return {
                key, category: category, op: op,
                threshold: spec.defaultValue, source: 'static-default',
                n, successes, failures, alpha, beta,
            };
        }
        const rng = d.rng ?? seededRng(`${key}#${n}#${alpha}#${beta}`);
        const sample = betaSample(alpha, beta, rng);
        return {
            key, category: category, op: op,
            threshold: thresholdFromSample(sample, spec.min, spec.max),
            source: 'thompson-sample',
            n, successes, failures, alpha, beta, sample,
        };
    }
    catch {
        return null; // 依赖面意外故障：诚实缺席（绝不抛）
    }
}
/**
 * 收敛晋升（校准幕的落值面）：28 臂依确定性序逐臂决策 ——
 *   · n ≥ 门限 ⇒ Thompson 采样阈值 → registry.set（registry 写径自夹取，
 *     本侧 thresholdFromSample 先夹 —— 双侧安全带）；
 *   · n < 门限 ⇒ 按兵不动（held —— 值保持 defaultValue，零行为变化）。
 * 种子律：opts.rng ?? seededRng(opts.seed ?? `memory-ops@${Date.now()}`) ——
 * 同种子 + 同账本态 ⇒ 报告与落值逐位重放一致（测试即以此验收）。
 * 永不抛：单臂依赖故障收敛为该臂缺席 / setOk:false，不连坐其余臂
 * （sleep 旁路仪式同律 —— 睡眠绝不为一臂的故障失眠）。
 */
export function convergeMemoryOps(opts = {}) {
    const o = opts ?? {}; // null opts 走生产单例 + 派生种子（绝不抛）
    const registry = o.registry ?? kernelRegistry;
    const ledger = o.ledger ?? evidenceLedger;
    const seedStr = o.rng ? '<injected-rng>' : o.seed !== undefined ? String(o.seed) : `memory-ops@${Date.now()}`;
    const rng = o.rng ?? seededRng(seedStr);
    const report = {
        arms: MEMORY_OP_CATEGORIES.length * MEMORY_OP_KINDS.length,
        converged: [], held: [], seed: seedStr,
    };
    for (const category of MEMORY_OP_CATEGORIES) {
        for (const op of MEMORY_OP_KINDS) {
            try {
                const decision = decideMemoryOpThreshold(category, op, { registry, ledger, rng, gate: o.gate });
                if (decision === null)
                    continue; // 词表内臂的决策不会 null —— 防御带
                if (decision.source === 'static-default') {
                    report.held.push({ key: decision.key, category, op, n: decision.n, reason: 'insufficient-feedback' });
                    continue;
                }
                const from = registry.getOrDefault(decision.key, decision.threshold);
                const setRes = registry.set(decision.key, decision.threshold);
                report.converged.push({ ...decision, from, to: decision.threshold, setOk: setRes.ok });
            }
            catch {
                // 单臂意外故障：跳过（收敛是旁路仪式 —— 一臂的故障不连坐其余 27 臂）
            }
        }
    }
    return report;
}
