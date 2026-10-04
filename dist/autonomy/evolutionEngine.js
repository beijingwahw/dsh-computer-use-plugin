// src/autonomy/evolutionEngine.ts
// 纪元 Φ（自主智能环）·Φ-5 自主进化引擎：每次自主运行后蒸馏技能、记教训、调策略权重——跑一次聪明一次。
// W6-1（doctor 债清偿·smell.over-engineering）：确定性原语区（EXP4 特征/超参常量、
// 哈希与 PRNG、向量数学、防御访问器、蒸馏门/失败签名、权重律纯函数 applyRun/
// deriveLessons/deriveSkills）逐字节搬至 ./evolutionPrimitives —— 纯函数零状态；
// 导入面不变（FEATURE_LAYOUT / EXP4_HYPERPARAMS / contextFeatureVector /
// shouldDistillSkill / failureSignature 原位再导出）。
export { FEATURE_LAYOUT, EXP4_HYPERPARAMS, contextFeatureVector, shouldDistillSkill, failureSignature, } from './evolutionPrimitives.js';
import { DEFAULT_BANDIT_SEED, ETA, ETA_MAX, FEATURE_DIM, HEURISTIC_ORDER, PROB_FLOOR, W_INIT, applyRun, applyThetaUpdate, argmaxIndex, armDistribution, contextFeatureVector, deriveLessons, deriveSkills, mulberry32, r2, rewardOf, } from './evolutionPrimitives.js';
/** history 环形上限（纪元 Δ）：旧记录挤出保新 —— 长驻进程里进化读数只看最近 200 轮 */
const HISTORY_MAX = 200;
/**
 * 自主进化引擎：ingest 记录运行，report/heuristics 即时派生进化读数。
 * 绝不抛异常：坏输入静默拒收或诚实降级；纯离线、零兄弟依赖。
 * history 是有界环形账本（上限 200，旧记录挤出保新——纪元 Δ：长驻进程无上限
 * 累积会让重放与内存双双发散）；reset() 清账回到出厂状态（测试与换场用）。
 * W1-5：双轨进化——旧权重律（heuristics/report，逐字节向后兼容）之外并置
 * EXP4 上下文老虎机（selectAction/armProbabilities/greedyArm/thetaNorms/
 * exportAuditLedger），两轨同一遍 history 重放、互不扰动。
 */
/** W7 审计：安全数值强制（Symbol 等毒值使 Number() 自身抛 TypeError——绝不抛纪律的兜底） */
function safeToNumber(x) {
    try {
        return Number(x);
    }
    catch {
        return NaN;
    }
}
export class EvolutionEngine {
    runs = [];
    distillMaxSteps;
    /** W1-5：采样流（同 seed ⇒ 同序列；重放/读数绝不消费——铁律的随机隔离） */
    rng;
    /** W1-5：学习率 η（构造处夹取 [0, ETA_MAX]；η=0 ⇒ 关学习只记账） */
    eta;
    /**
     * @param opts.history         播种历史（等同逐条 ingest——权重/教训/蒸馏/θ 同律重放；
     *                             超 200 条按环形律截尾保新）
     * @param opts.distillMaxSteps 蒸馏步数上限，默认 12（≤0 或非有限数 ⇒ 回落 12）
     * @param opts.seed            W1-5 采样流种子（缺省 0x9e3779b9；非有限数 ⇒ 缺省）
     * @param opts.eta             W1-5 学习率 η，缺省 0.05（夹取 [0, 0.5]）
     */
    constructor(opts) {
        const o = opts && typeof opts === 'object' ? opts : {};
        const n = safeToNumber(o.distillMaxSteps);
        this.distillMaxSteps = Number.isFinite(n) && n > 0 ? n : 12;
        // W1-5：种子流与学习率的防御初始化（坏值回落缺省，绝不抛）
        // W7 审计补：Symbol 等毒值使 Number() 本身抛 TypeError——安全强制转换兜底
        const sd = safeToNumber(o.seed);
        this.rng = mulberry32(Number.isFinite(sd) ? sd : DEFAULT_BANDIT_SEED);
        const et = safeToNumber(o.eta);
        this.eta = Number.isFinite(et) ? Math.min(ETA_MAX, Math.max(0, et)) : ETA;
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
    // ─── W1-5：EXP4 上下文老虎机读数（全部纯重放派生，零缓存错位） ───
    /**
     * W1-5：按当前分布采样选臂（在线探索入口；每次调用恰消耗一个随机数）。
     * 返回臂、选中概率 P(a)、全分布，与可直接回灌 RunRecord.bandit 的 annotation
     * （闭环契约：selectAction → 执行 → ingest({...run, bandit: sample.annotation})）。
     * 兜底均匀臂（数学防御，正常不可达）——绝不抛异常。
     */
    selectAction(ctx) {
        try {
            const { theta, weights } = this.replay();
            const dist = armDistribution(theta, weights, contextFeatureVector(ctx));
            const u = this.rng();
            let acc = 0;
            let pick = dist.length - 1; // 浮点累计尾差兜底：越界落最后一臂
            for (let i = 0; i < dist.length; i++) {
                acc += dist[i];
                if (u < acc) {
                    pick = i;
                    break;
                }
            }
            const probabilities = {};
            HEURISTIC_ORDER.forEach((k, i) => {
                probabilities[k] = dist[i];
            });
            const arm = HEURISTIC_ORDER[pick];
            const prob = dist[pick];
            return { arm, prob, probabilities, annotation: { arm, prob, context: ctx ?? {} } };
        }
        catch {
            const p = 1 / HEURISTIC_ORDER.length;
            const probabilities = {};
            for (const k of HEURISTIC_ORDER)
                probabilities[k] = p;
            return { arm: HEURISTIC_ORDER[0], prob: p, probabilities, annotation: { arm: HEURISTIC_ORDER[0], prob: p, context: {} } };
        }
    }
    /**
     * W1-5：当前重放态的选臂分布（纯读数，零随机消费——与 selectAction 的区别只在
     * 采样那一步）。θ=0 时恰为旧权重表的比例分布 softmax(ln w_rule)——「θ=0 退化为
     * 旧固定规则行为」的兼容锚点。键序恒 HEURISTIC_ORDER，值和为 1。
     */
    armProbabilities(ctx) {
        try {
            const { theta, weights } = this.replay();
            const dist = armDistribution(theta, weights, contextFeatureVector(ctx));
            const out = {};
            HEURISTIC_ORDER.forEach((k, i) => {
                out[k] = dist[i];
            });
            return out;
        }
        catch {
            const p = 1 / HEURISTIC_ORDER.length;
            const out = {};
            for (const k of HEURISTIC_ORDER)
                out[k] = p;
            return out;
        }
    }
    /**
     * W1-5：贪心臂（argmax，平票按 HEURISTIC_ORDER 固定序）——重放推导用的正是
     * 这一裁决（铁律：重放不采样）。θ=0 时与旧建议分支一（最高权重先行）同裁。
     */
    greedyArm(ctx) {
        try {
            const { theta, weights } = this.replay();
            const dist = armDistribution(theta, weights, contextFeatureVector(ctx));
            return HEURISTIC_ORDER[argmaxIndex(dist)];
        }
        catch {
            return HEURISTIC_ORDER[0];
        }
    }
    /** W1-5：各臂 θ 的 L2 范数（有界性读数——恒 ≤ thetaMax；零学习 ⇒ 全 0） */
    thetaNorms() {
        const { theta } = this.replay();
        const out = {};
        for (const k of HEURISTIC_ORDER) {
            let n2 = 0;
            for (const v of theta[k])
                n2 += v * v;
            out[k] = Number.isFinite(n2) ? Math.sqrt(n2) : 0;
        }
        return out;
    }
    /**
     * W1-5：审计账本导出——逐轮重放产生的 (x, a, P(a), r, G) 全量（无 bandit 标注的
     * 历史轮次不进账本；每次调用重放重建，外部改动不透内部）。
     */
    exportAuditLedger() {
        return this.replay().ledger;
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
    /**
     * W1-5 双轨重放：旧权重律（applyRun）与 EXP4 θ（重要性加权）在**同一遍** history
     * 上推导。逐轮次序 = 在线时序：先按当前态推导 (a, P(a))（记录值合法则用记录值，
     * 否则贪心 argmax + 当期分布——铁律：重放不采样），再做 θ 更新，最后叠旧律——
     * 本轮自己的结局绝不进入自己的选中概率（在线无泄漏语义）。
     */
    replay() {
        const weights = {};
        for (const k of HEURISTIC_ORDER)
            weights[k] = W_INIT;
        // W1-5：θ 出厂全零（零向量 ⇒ 分布退化为旧权重比例——旧律兼容锚点）
        const theta = {};
        for (const k of HEURISTIC_ORDER)
            theta[k] = new Array(FEATURE_DIM).fill(0);
        const ledger = [];
        let lastAdjustments = [];
        let step = 0;
        for (const run of this.runs) {
            step += 1;
            const bandit = run?.bandit;
            if (bandit !== null && bandit !== undefined && typeof bandit === 'object') {
                try {
                    const rec = bandit;
                    const ctx = rec.context !== null && rec.context !== undefined && typeof rec.context === 'object'
                        ? rec.context
                        : {};
                    const x = contextFeatureVector(ctx);
                    const dist = armDistribution(theta, weights, x);
                    // 缺省臂 ⇒ 贪心 argmax（平票固定序）；非法臂名（不在五内建）同律回退
                    let ai = HEURISTIC_ORDER.indexOf(typeof rec.arm === 'string' ? rec.arm : '');
                    if (ai < 0)
                        ai = argmaxIndex(dist);
                    // P(a)：记录值合法（有限、(0,1]）则原样（在线真值），否则当期分布回填
                    let prob = dist[ai];
                    if (typeof rec.prob === 'number' && Number.isFinite(rec.prob) && rec.prob > 0 && rec.prob <= 1) {
                        prob = rec.prob;
                    }
                    const reward = rewardOf(ctx, run, this.distillMaxSteps * 2);
                    // 重要性加权：G = r / max(P(a), ε)——分母下限防小概率爆炸
                    const gRaw = reward / Math.max(prob, PROB_FLOOR);
                    const importance = Number.isFinite(gRaw) ? gRaw : 0;
                    applyThetaUpdate(theta, HEURISTIC_ORDER[ai], x, importance, this.eta);
                    ledger.push({ step, arm: HEURISTIC_ORDER[ai], prob, reward, importance, x });
                }
                catch {
                    // W1-5：坏标注绝不炸重放——跳过该轮 θ 学习，旧律照常推进
                }
            }
            lastAdjustments = applyRun(weights, run);
        }
        return { weights, lastAdjustments, theta, ledger };
    }
}
