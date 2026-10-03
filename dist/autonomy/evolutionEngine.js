// src/autonomy/evolutionEngine.ts
// 纪元 Φ（自主智能环）·Φ-5 自主进化引擎：每次自主运行后蒸馏技能、记教训、调策略权重——跑一次聪明一次。
// ── 算法形状字面量（全部确定性常量） ──
/** 五个内建策略权重键：数组序 = 平票裁决序（先到先胜） */
const HEURISTIC_ORDER = ['scroll', 'inspect', 'ask_vlm', 'recall_skill', 'click'];
const KNOWN = new Set(HEURISTIC_ORDER);
const W_INIT = 1.0; // 初值全 1.0
const W_MAX = 2.0; // 上夹取
const W_MIN = 0.2; // 下夹取
const REWARD = 0.1; // 成功奖励
const PENALTY = 0.15; // 失败惩罚
const RECOVERY = 0.05; // 恢复加成
const RELIABILITY_INIT = 0.5;
const RELIABILITY_MAX = 0.95;
const RELIABILITY_STEP = 0.1;
/** history 环形上限（纪元 Δ）：旧记录挤出保新 —— 长驻进程里进化读数只看最近 200 轮 */
const HISTORY_MAX = 200;
/** 失败根因关键词 → 对症恢复策略（确定性映射；大小写不敏感子串匹配） */
const RECOVERY_MAP = [
    { keyword: 'popup', strategy: 'inspect' }, // 弹窗遮蔽 ⇒ 先看清现场
    { keyword: 'focus', strategy: 'inspect' }, // 焦点丢失 ⇒ 先定位真实可交互面
    { keyword: 'ocr', strategy: 'ask_vlm' }, // 文字读不出 ⇒ 换视觉模型直读
];
// ── 防御访问器（绝不抛异常的根基：坏记录一律诚实降级） ──
const strategiesOf = (run) => Array.isArray(run?.strategies) ? run.strategies : [];
const causeOf = (run) => typeof run?.failureRootCause === 'string' ? run.failureRootCause : '';
const stepsOf = (run) => Number.isFinite(run?.steps) ? run.steps : 0;
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
/**
 * 蒸馏门（纯函数）：成功 && steps ≤ distillMaxSteps && strategies 非空。
 * 三条件缺一不可——失败无经验可沉淀，超步是低效路径不配当宏，空策略无内容可记。
 */
export function shouldDistillSkill(run, distillMaxSteps = 12) {
    if (!run || run.success !== true)
        return false;
    const n = Number.isFinite(run.steps) ? run.steps : Number.POSITIVE_INFINITY;
    return n <= distillMaxSteps && strategiesOf(run).length > 0;
}
/**
 * 失败签名（纯函数）：`成败|根因|前4策略(>连接)`，截 80 字。
 * 同因同策 ⇒ 同签名——教训去重升级与 escalate 建议的锚点。
 * 防御：空记录返回 'fail|unknown|'，绝不抛异常。
 */
export function failureSignature(run) {
    if (!run)
        return 'fail|unknown|';
    const sig = `${run.success ? 'ok' : 'fail'}|${run.failureRootCause ?? 'unknown'}|${strategiesOf(run).slice(0, 4).join('>')}`;
    return sig.length > 80 ? sig.slice(0, 80) : sig;
}
/**
 * 把一轮运行按权重律叠进权重表（就地修改），返回本轮产生的调整记录
 * （delta = 夹取后的**实际**增量——触顶/触底轮的 delta 为 0，夹取对读者可见）。
 */
function applyRun(weights, run) {
    const adj = [];
    if (!run)
        return adj;
    if (run.success === true) {
        // 律 1：成功奖励——出现过的策略去重后各 +0.1（封顶 2.0）
        const seen = new Set();
        for (const kind of strategiesOf(run)) {
            if (!KNOWN.has(kind) || seen.has(kind))
                continue;
            seen.add(kind);
            const before = weights[kind];
            const after = Math.min(W_MAX, r3(before + REWARD));
            weights[kind] = after;
            adj.push({ heuristic: kind, delta: r3(after - before), reason: `成功轨迹验证：${kind} 出现在成功运行中（+0.1，封顶 2.0）` });
        }
        return adj;
    }
    // 律 2：失败惩罚——末两步各 -0.15（位置语义：重复策略叠加计罚；下限 0.2）
    for (const kind of strategiesOf(run).slice(-2)) {
        if (!KNOWN.has(kind))
            continue;
        const before = weights[kind];
        const after = Math.max(W_MIN, r3(before - PENALTY));
        weights[kind] = after;
        adj.push({ heuristic: kind, delta: r3(after - before), reason: `失败归因：${kind} 是末两步之一（-0.15，下限 0.2）` });
    }
    // 律 3：恢复加成——根因关键词 ⇒ 对症策略 +0.05（封顶 2.0；多关键词叠加）
    const cause = causeOf(run).toLowerCase();
    for (const { keyword, strategy } of RECOVERY_MAP) {
        if (!cause.includes(keyword))
            continue;
        const before = weights[strategy];
        const after = Math.min(W_MAX, r3(before + RECOVERY));
        weights[strategy] = after;
        adj.push({ heuristic: strategy, delta: r3(after - before), reason: `恢复加成：根因含「${keyword}」⇒ ${strategy} 对症（+0.05，封顶 2.0）` });
    }
    return adj;
}
/**
 * 教训派生（纯函数）：一遍扫描 history。
 * 返回 lessons（插入序 = 首见序，同签名/同 goal 去重升级）与失败签名计数
 * （escalate 建议的依据——≥2 次才算重复失败模式）。
 */
function deriveLessons(history, distillMaxSteps) {
    const lessons = new Map();
    const failCounts = new Map();
    for (const run of history) {
        if (run?.success === true) {
            // 律 3：成功但超 distillMaxSteps×2 步 ⇒ 低效路径教训（同 goal 去重）
            if (stepsOf(run) > distillMaxSteps * 2) {
                const goal = run.goal ?? '?';
                const key = `低效:${goal}`;
                if (!lessons.has(key)) {
                    lessons.set(key, `目标「${goal}」成功但用了 ${stepsOf(run)} 步（> ${distillMaxSteps * 2} 上限）——低效路径：优先蒸馏更短的宏，或换先验策略直达。`);
                }
            }
            continue;
        }
        const sig = failureSignature(run ?? {});
        const n = (failCounts.get(sig) ?? 0) + 1;
        failCounts.set(sig, n);
        if (n >= 2) {
            // 律 2：同签名第 2 次起升级为重复失败模式（去重：只占一席，句式随次数升级）
            lessons.set(sig, `${sig}｜重复失败模式（第 ${n} 次出现）：同一签名反复失败——升级处理优先级：该场景直接换策略或求助（escalate），勿原样重试。`);
        }
        else {
            const cause = causeOf(run) ? `（根因：${causeOf(run)}）` : '';
            lessons.set(sig, `${sig}｜教训：目标「${run?.goal ?? '?'}」失败${cause}——末段策略嫌疑最大已降权；重试前先看清现场（inspect / ask_vlm）。`);
        }
    }
    return { lessons: [...lessons.values()], failCounts };
}
/**
 * 蒸馏派生（纯函数）：按蒸馏门扫 history，同 goal 只建一卡、复蒸馏只涨可靠度。
 * lastKey = 最近一次可蒸馏运行触达的 goal（report 的 distilledSkill 取它；
 * null = 无可蒸馏历史 ⇒ 字段缺省）。
 */
function deriveSkills(history, distillMaxSteps) {
    const skills = new Map();
    let lastKey = null;
    for (const run of history) {
        if (!shouldDistillSkill(run ?? {}, distillMaxSteps))
            continue;
        const goal = run.goal ?? '';
        const existing = skills.get(goal);
        if (!existing) {
            skills.set(goal, {
                description: `自动技能：${goal}`,
                steps: [strategiesOf(run).join(' → ')],
                reliability: RELIABILITY_INIT,
            });
        }
        else {
            existing.reliability = Math.min(RELIABILITY_MAX, r2(existing.reliability + RELIABILITY_STEP));
        }
        lastKey = goal;
    }
    return { skills, lastKey };
}
/**
 * 自主进化引擎：ingest 记录运行，report/heuristics 即时派生进化读数。
 * 绝不抛异常：坏输入静默拒收或诚实降级；纯离线、零兄弟依赖。
 * history 是有界环形账本（上限 200，旧记录挤出保新——纪元 Δ：长驻进程无上限
 * 累积会让重放与内存双双发散）；reset() 清账回到出厂状态（测试与换场用）。
 */
export class EvolutionEngine {
    runs = [];
    distillMaxSteps;
    /**
     * @param opts.history         播种历史（等同逐条 ingest——权重/教训/蒸馏同律重放；
     *                             超 200 条按环形律截尾保新）
     * @param opts.distillMaxSteps 蒸馏步数上限，默认 12（≤0 或非有限数 ⇒ 回落 12）
     */
    constructor(opts) {
        const o = opts && typeof opts === 'object' ? opts : {};
        const n = Number(o.distillMaxSteps);
        this.distillMaxSteps = Number.isFinite(n) && n > 0 ? n : 12;
        if (Array.isArray(o.history)) {
            for (const r of o.history) {
                if (r && typeof r === 'object')
                    this.runs.push(r);
            }
            if (this.runs.length > HISTORY_MAX)
                this.runs.splice(0, this.runs.length - HISTORY_MAX);
        }
    }
    /** 收官一轮运行。坏记录（null/undefined/非对象）静默拒收，绝不抛异常；
     *  超 200 条时最旧记录被挤出（环形账本只看最近 200 轮）。 */
    ingest(run) {
        if (!run || typeof run !== 'object')
            return;
        this.runs.push(run);
        if (this.runs.length > HISTORY_MAX)
            this.runs.shift();
    }
    /** 唯一事实源（只读副本：外部改返回值不透内部；派生读数全部由它重放得出） */
    get history() {
        return [...this.runs];
    }
    /** 清账重置：history 归零、权重/教训/蒸馏回到出厂（单例跨场复用时的换场闸） */
    reset() {
        this.runs.length = 0;
    }
    /** 当前权重表：scroll/inspect/ask_vlm/recall_skill/click，初值全 1.0（每次调用重放，返回新对象） */
    heuristics() {
        return this.replay().weights;
    }
    /**
     * 进化读数（每次调用基于当前 history 即时计算——纯派生，无缓存错位）：
     * distilledSkill = 最近触达的蒸馏技能；lessons = 教训去重升级后的清单；
     * weightAdjustments = **末轮** ingest 产生的调整（delta 为夹取后实际增量）；
     * nextRunAdvice = 先行/escalate/recall 三分支建议。
     */
    report() {
        const { weights, lastAdjustments } = this.replay();
        const { lessons, failCounts } = deriveLessons(this.runs, this.distillMaxSteps);
        const { skills, lastKey } = deriveSkills(this.runs, this.distillMaxSteps);
        const advice = [];
        // 分支一（恒在）：最高权重者先行——严格大于才夺位 ⇒ 平票由固定序裁决
        let top = HEURISTIC_ORDER[0];
        for (const k of HEURISTIC_ORDER) {
            if (weights[k] > weights[top])
                top = k;
        }
        advice.push(`先行建议：优先尝试「${top}」（当前权重 ${r2(weights[top])}，五策略中最高）。`);
        // 分支二：重复失败签名（≥2 次）⇒ 直接 escalate 该场景
        for (const [sig, n] of failCounts) {
            if (n < 2)
                continue;
            advice.push(`escalate 建议：签名 ${sig} 已失败 ${n} 次（重复失败模式）——该场景直接升级处理：换路径或求助，勿原样重试。`);
        }
        // 分支三：有蒸馏技能 ⇒ 下一轮优先 recall
        if (skills.size > 0) {
            let maxRel = 0;
            for (const s of skills.values())
                maxRel = Math.max(maxRel, s.reliability);
            advice.push(`记忆中有 ${skills.size} 个蒸馏技能（最高可靠度 ${r2(maxRel)}）——下一轮优先 recall_skill 复用已验证路径。`);
        }
        const skill = lastKey !== null ? skills.get(lastKey) : undefined;
        return skill
            ? { distilledSkill: skill, lessons, weightAdjustments: lastAdjustments, nextRunAdvice: advice }
            : { lessons, weightAdjustments: lastAdjustments, nextRunAdvice: advice };
    }
    /** 权重重放：从全 1.0 出发逐轮叠律；lastAdjustments 始终保持末轮的调整记录 */
    replay() {
        const weights = {};
        for (const k of HEURISTIC_ORDER)
            weights[k] = W_INIT;
        let lastAdjustments = [];
        for (const run of this.runs) {
            lastAdjustments = applyRun(weights, run);
        }
        return { weights, lastAdjustments };
    }
}
