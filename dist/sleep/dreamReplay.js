// src/sleep/dreamReplay.ts
// W5-2（M4 优先经验反事实梦回放）：真实失败轨迹在 PCG 同构世界里获得第二次机会。
//
// 一句话：睡梦里，把「当时败了的那条路」放进一座结构同构、输入冻结的文法世界，
// 让**当前**策略重走一遍 —— 若本可成功，产一条反事实教训进晨报；无论成败，
// 分歧点之后的重放结局作为新证据双写（实验室 kernel 账本 + 进化引擎 EXP4）。
//
// 设计律（与 sleep/index.ts 同源，另有本模块专属三条）：
//   · 永不抛异常 —— 梦是旁路中的旁路：任何故障（轨迹垃圾/世界铸造失败/引擎炸）
//     都收敛为报告里的 note，绝不炸睡眠、绝不炸宿主；
//   · 确定性铁律 —— 同轨迹 + 同策略状态 ⇒ 逐字节同重放：世界 seed 由轨迹指纹
//     冻结派生、梦训练营用虚拟时钟与离线哨兵 client（runPcgWorld 既有执法面）、
//     随机数只在 PCG 推导的种子流里（seed 钉死 ⇒ 推导钉死）；
//   · 隔离铁律 —— 梦训练营自带独立实验室（AutonomyGym 缺省自铸，Θ-3 律），
//     生产 kernel 注册表分毫不动；值进生产的唯一通道仍是外部显式 promoteFrom。
//
// ΑΩ-R40（梦回放的预算现实主义）：每梦最多 8 步 + AutonomyGym + sharp 合成帧，
// 而睡眠总预算缺省仅 2000ms 且逐幕检查 —— 修法是**自适应而非加时**：条间取梦前
// 实读剩余预算（overBudget 闭包携带的 remainingMs 读数面），用「已测单梦耗时」的
// 指数滑动均值（每步均值 × 期望步数；冷启动用保守常量，宁少勿挂）判断装不装得下；
// 队首装不下 ⇒ 选「装得下的最短梦」；全装不下 ⇒ 诚实收场（truncated/time 现状
// 语义）。无预算读数面的旧调用方 ⇒ 纯 PER 序 + overBudget 布尔执法（零漂移）。
//
// 本模块的装载律（与 index.ts「相对导入全部 type-only」律的关系）：
// index.ts 对本模块只做**懒动态 import**（梦 dep 在场才装载）—— 六幕的装载器
// 零耦合律对既有路径逐字节保持；本模块自身是梦的机房，允许运行期导入 gym 的
// PCG 面（pcgWorldStream / AutonomyGym / runPcgWorld —— sharp 懒加载、零网络）。
// ΝΩ-34 豁免注记：另运行期导入 kernel/registry 的生产单例 kernelRegistry ——
// **只读** list() 取 generation 计数（策略指纹的回落读数面；该模块本就在 gym 的
// 传递装载图里，零新增模块边；绝不写，隔离铁律逐字节保持）。
//
// ── PER 优先级（Prioritized Experience Replay，公式可审计）──
//
//   p = ŝ × cost × recency
//
//   ŝ       惊异因子 = surpriseBits / (surpriseBits + SURPRISE_HALF_BITS)
//                     （饱和双曲归一 ∈ [0,1)：单调、有界、surpriseBits=半衰位时
//                      恰 0.5 —— 手算可验）
//   cost    失败代价 = riskFactor[riskTier] × (1 + min(stepsWasted, WASTE_CAP)/WASTE_CAP)
//                     （风险档乘子 × 步数浪费因子 ∈ [1,5]）
//   recency 新近衰减 = 2^(−age/HALF_LIFE_MS)
//                     （age = now − at；半衰期恒 24h —— 昨夜的失败权重减半）
//
//   surpriseBits 的证据优先序（诚实缺席链，逐级回落并申报来源）：
//     轨迹自带累计惊异 > 惊异谱按场景类型命中 > 惊异谱均值 > SURPRISE_PRIOR_BITS。
//   全部因子与权重为模块冻结常量（PER_WEIGHTS —— 审计与测试可读）。
import { AutonomyGym } from '../autonomy/gym.js';
// ΝΩ-34：kernel generation 计数（策略指纹的回落读数面 —— 只读 list()，绝不写：
// 隔离铁律不破；该模块本就在 dreamReplay 的传递装载图里（gym 运行期导入
// kernel/registry），零新增模块边）
import { kernelRegistry } from '../kernel/registry.js';
// W6-1（doctor 债清偿·smell.over-engineering）：PER 权重常量、确定性原语（fnv1a）、
// 梦方言契约类型、失败记录→梦轨迹映射、PER 优先级/水位线、同构世界选取逐字节
// 搬至 ./dreamReplayCore —— 本文件保留编排（runDreamReplay）与预算解析，导入面
// 不变（公共面原位再导出）。
export { PER_WEIGHTS, dreamTrajectories, computeDreamPriority, dreamBatchWatermark, pickIsomorphicWorld, 
// ΑΩ-R40：条间预算感知选梦的纯逻辑面（原位再导出 —— 公共面收口在本模块）
DREAM_COST_ESTIMATOR, dreamExpectedSteps, pickDreamByBudget, 
// ΝΩ-34：策略指纹与 dream.cf 分桶的纯逻辑面（原位再导出 —— 同律收口）
POLICY_FINGERPRINT_GRID, policyFingerprintOf, dreamCfKey, } from './dreamReplayCore.js';
import { computeDreamPriority, dreamBatchWatermark, fnv1a, pickIsomorphicWorld, DREAM_COST_ESTIMATOR, dreamExpectedSteps, pickDreamByBudget, policyFingerprintOf, dreamCfKey, } from './dreamReplayCore.js';
/** 梦回放预算缺省（每睡眠周期最多 3 条、每条步数上限 8 —— 2s 睡眠预算的礼让） */
export const DREAM_BUDGET_DEFAULTS = Object.freeze({
    maxDreams: 3,
    maxStepsPerDream: 8,
    maxDreamsCap: 16,
    maxStepsCap: 40,
});
// ─── 分歧点定位（纯函数） ───
/**
 * 首个分歧点：历史决策序列 vs 当前策略重放动作序的第一个不同 kind 的下标。
 * 无历史对照面（空序列）或前缀完全一致 ⇒ null（「当前策略尚未分歧」—— 双写
 * 的门槛：无分歧 ⇒ 重放与历史同路，结局无新信息，不双写）。比较只到双序列
 * 较短者（重放步数受预算钳制 —— 钳制不是分歧）。
 */
export function locateDivergence(history, replay) {
    if (!Array.isArray(history) || history.length === 0)
        return null;
    if (!Array.isArray(replay))
        return null;
    const n = Math.min(history.length, replay.length);
    for (let i = 0; i < n; i++) {
        if (history[i]?.kind !== replay[i])
            return i;
    }
    return null;
}
// ─── 预算解析（防御夹取） ───
/** 梦回放预算解析（缺省 DREAM_BUDGET_DEFAULTS；越界/垃圾 ⇒ 夹取，绝不抛） */
export function resolveDreamBudget(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const dRaw = Number(o.maxDreams);
    const maxDreams = Number.isFinite(dRaw)
        ? Math.min(DREAM_BUDGET_DEFAULTS.maxDreamsCap, Math.max(0, Math.floor(dRaw)))
        : DREAM_BUDGET_DEFAULTS.maxDreams;
    const sRaw = Number(o.maxStepsPerDream);
    const maxStepsPerDream = Number.isFinite(sRaw)
        ? Math.min(DREAM_BUDGET_DEFAULTS.maxStepsCap, Math.max(1, Math.floor(sRaw)))
        : DREAM_BUDGET_DEFAULTS.maxStepsPerDream;
    return { maxDreams, maxStepsPerDream };
}
// ─── ΑΩ-R40：单梦耗时滑动估计器（模块内私有账本 —— 进程内有效；绝不抛） ───
/** 梦耗时账本（指数滑动均值：单梦整条 + 每步 —— 条间预算感知选梦的估计源） */
const dreamCostLedger = { dreamMs: null, stepMs: null };
/** ΑΩ-R40：实测入账（EMA；非正耗时 = 恒时钟/无钟的零差样本 ⇒ 不入账不污染） */
function observeDreamCost(elapsedMs, steps) {
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0)
        return;
    const a = DREAM_COST_ESTIMATOR.emaAlpha;
    const safeSteps = Number.isFinite(steps) && steps >= 1 ? steps : 1;
    dreamCostLedger.dreamMs =
        dreamCostLedger.dreamMs === null ? elapsedMs : dreamCostLedger.dreamMs * (1 - a) + elapsedMs * a;
    const stepCost = elapsedMs / safeSteps;
    dreamCostLedger.stepMs =
        dreamCostLedger.stepMs === null ? stepCost : dreamCostLedger.stepMs * (1 - a) + stepCost * a;
}
/** ΑΩ-R40：一条梦的耗时估计（每步滑动均值 × 期望步数；冷启动用保守常量 —— 宁少勿挂） */
function estimateDreamMs(expectedSteps) {
    const per = dreamCostLedger.stepMs !== null && Number.isFinite(dreamCostLedger.stepMs) && dreamCostLedger.stepMs > 0
        ? dreamCostLedger.stepMs
        : DREAM_COST_ESTIMATOR.coldStepMs;
    const steps = Number.isFinite(expectedSteps) && expectedSteps >= 1 ? expectedSteps : 1;
    return Math.max(1, per * steps);
}
/** ΑΩ-R40：账本只读面（审计/测试 —— 进程内滑动估计的收敛观测口） */
export function readDreamCostLedger() {
    return { perDreamMs: dreamCostLedger.dreamMs, perStepMs: dreamCostLedger.stepMs };
}
/** 测试缝：清零梦耗时账本（模拟冷启动 —— 新进程面） */
export function resetDreamCostLedger() {
    dreamCostLedger.dreamMs = null;
    dreamCostLedger.stepMs = null;
}
/** ΑΩ-R40：剩余预算读数（dep 显式优先，overBudget 闭包属性补位；垃圾/故障 ⇒ null 回落布尔执法） */
function readRemainingBudgetMs(d) {
    const explicit = typeof d.remainingBudgetMs === 'function' ? d.remainingBudgetMs : null;
    let prop = null;
    try {
        // 注意：闭包的 typeof 是 'function' —— 防御判型须同时放行 object/function 两形
        const face = d.overBudget;
        if (face && (typeof face === 'object' || typeof face === 'function') && typeof face.remainingMs === 'function') {
            prop = face.remainingMs;
        }
    }
    catch {
        prop = null; // 防御：读数面自身畸形 ⇒ 只走 dep/布尔执法
    }
    const probes = [explicit, prop];
    return () => {
        for (const probe of probes) {
            if (!probe)
                continue;
            try {
                const v = probe();
                if (typeof v === 'number' && Number.isFinite(v))
                    return v;
            }
            catch {
                /* 读数故障 ⇒ 下一通道，最终回落布尔执法 */
            }
        }
        return null;
    };
}
/** ΑΩ-R40：预算饿死条目（未回放的诚实注记面 —— world 全 -1，与既有形状同律） */
function starvedEntry(s, note) {
    return {
        id: s.t.id,
        priority: s.p,
        factors: s.factors,
        world: { master: -1, seed: -1, index: -1, difficulty: -1, fingerprint: '' },
        replayed: false,
        doubleWrite: { kernel: false, evolution: false },
        note,
    };
}
// ─── ΝΩ-34：策略指纹读数（绝不抛 —— 两级回落，读数面故障不炸梦） ───
/**
 * ΝΩ-34：当前策略指纹（梦水位线的策略分量）：
 *   ① 首选 —— evolution 面 heuristics 权重表（EXP4 双轨的旧权重律读数，生产
 *      引擎自带）→ policyFingerprintOf 粗化 fnv1a；
 *   ② 回落 —— kernel generation 计数（evolution 面缺席 / 无 heuristics / 读数
 *      故障时）：生产 kernelRegistry 的代际和（promoteFrom 才 +1 —— 代际和
 *      不变 ⇒ 视为同策略；只读 list()，绝不写，隔离铁律不破）；
 *   ③ 兜底 —— 'void'（连只读都故障 ⇒ 空指纹申报，去重回落失败集身份单独定胜负）。
 */
function dreamPolicyFingerprint(d) {
    const evo = d.evolution;
    if (evo && typeof evo.heuristics === 'function') {
        try {
            const w = evo.heuristics();
            if (w && typeof w === 'object')
                return policyFingerprintOf(w);
        }
        catch {
            /* 读数故障 ⇒ 回落 kernel 代际（诚实方向，绝不炸梦） */
        }
    }
    try {
        const gens = kernelRegistry.list().reduce((acc, p) => acc + (typeof p.generation === 'number' && Number.isFinite(p.generation) ? p.generation : 0), 0);
        return `kg${Math.max(0, Math.floor(gens))}`;
    }
    catch {
        return 'void';
    }
}
// ─── 梦回放编排（永不抛；确定性；预算纪律；分歧点双写） ───
/**
 * W5-2 梦回放编排（async —— sharp 合成帧是唯一的真异步面）：
 *   1. 独立水位线幂等（ΝΩ-34 修订）：批次指纹 = 失败集身份 × 策略指纹 ——
 *      === priorWatermark ⇒ 全跳过（note 申报，防重复回放）；策略显著进化
 *      ⇒ 指纹前移 ⇒ 同失败集允许重梦（梦的前提是当前策略重决策）；
 *   2. PER 排序（p 降序、平票期望步数短者胜、再平票 id 升序 —— 确定性法院）；
 *      ΑΩ-R40 条间预算感知选梦：逐条取梦前实读剩余预算（overBudget 闭包的
 *      remainingMs 读数面 / remainingBudgetMs dep），用单梦耗时的指数滑动均值
 *      （每步均值 × 期望步数；冷启动保守常量）判断装不装得下 —— 队首装不下 ⇒
 *      选装得下的最短梦；全装不下 ⇒ 诚实收场（宁短勿挂，不加时）；
 *   3. 逐条：预算检查（overBudget —— 实读 sleep 预算机制，条间执法）⇒ 取同构
 *      世界（冻结输入）⇒ 梦训练营 runPcgWorld 重决策（现有 policyEngine 决策面
 *      + 离线哨兵 client + 宪法 + Θ-3 全套记账 —— 全是既有执法面，只读消费）；
 *   4. 分歧点之后双写：(a) kernel 证据 —— runPcgWorld 期间已按现有 lab 记账通道
 *      入账（世界真相对账四键），分歧结局另记 dream.cf:<桶> 一条（ΝΩ-34 分桶 +
 *      margin 通道不装步序 —— divergenceStep 记梦侧注记 cfLedger）；(b)
 *      evolutionEngine.ingest 带 bandit 标注（arm/prob 取自 EXP4 greedy 的只读面
 *      —— 重放不采样铁律）；双写条目另注记 perWeight = p/mean(p)（ΝΩ-34 批内
 *      归一的重要性采样权重 —— 为未来加权消费备账，本次不接消费面）；
 *   5. 重放成功且历史失败 ⇒ 反事实教训条目（晨报消费面）。
 * 确定性：世界 seed 冻结 + 梦训练营虚拟时钟 + 离线哨兵 client ⇒ 同轨迹同策略
 * 状态逐字节同重放。隔离：梦实验室独立自铸（Θ-3 律），生产 kernel 分毫不动。
 */
export async function runDreamReplay(deps) {
    const empty = {
        report: {
            watermark: '',
            attempted: 0, replayed: 0, successes: 0, divergences: 0,
            lessons: [], lessonMeta: [],
            entries: [],
            budget: { ...resolveDreamBudget(deps?.budget), truncated: false, reason: 'none' },
            kernelEvidence: [],
        },
        lab: null,
    };
    try {
        const d = deps && typeof deps === 'object' ? deps : {};
        const trajectories = Array.isArray(d.trajectories) ? d.trajectories.filter(t => t && typeof t === 'object') : [];
        const budget = resolveDreamBudget(d.budget);
        const base = {
            ...empty.report,
            budget: { ...budget, truncated: false, reason: 'none' },
        };
        if (trajectories.length === 0) {
            return { report: { ...base, note: '梦回放跳过：无失败轨迹（失败记忆为空或全部垃圾 —— 诚实缺席）' }, lab: null };
        }
        // ΝΩ-34：水位线 = 失败集身份 × 策略指纹（策略显著进化 ⇒ 同失败集允许重梦；
        // 同策略同失败集仍去重 —— 防重复回放的锚从「身份」升级为「身份×策略」）
        const policyFp = dreamPolicyFingerprint(d);
        const watermark = dreamBatchWatermark(trajectories, policyFp);
        if (typeof d.priorWatermark === 'string' && d.priorWatermark === watermark) {
            return {
                report: { ...base, watermark, note: '梦回放水位线未动 —— 本轮零回放（同一失败集×同一策略已梦过，防重复回放）' },
                lab: null,
            };
        }
        if (budget.maxDreams <= 0) {
            return { report: { ...base, watermark, note: '梦回放预算 maxDreams=0 —— 关闭（申报在案）' }, lab: null };
        }
        // PER 打分 + 确定性排序（p 降序；ΑΩ-R40 平票时期望步数升者胜（同分短者胜）；
        // 再平票 id 升序）
        const now = typeof d.now === 'function' ? d.now() : 0;
        const nowSafe = typeof now === 'number' && Number.isFinite(now) ? now : 0;
        const scored = trajectories.map(t => {
            const { p, factors } = computeDreamPriority(t, { spectrum: d.spectrum, now: nowSafe });
            return { t, p, factors };
        });
        scored.sort((a, b) => b.p - a.p
            || dreamExpectedSteps(a.t, budget.maxStepsPerDream) - dreamExpectedSteps(b.t, budget.maxStepsPerDream)
            || String(a.t.id).localeCompare(String(b.t.id)));
        // ΝΩ-34：PER 重要性采样权重（批内归一 w = p/mean(p)，网格化 1e-6 与 p 同律 ——
        // 批均值 1；全零批 ⇒ 均匀 1 的诚实退化）。为未来加权消费备账：本次只随分歧
        // 双写注记（entry.perWeight），不接任何消费面。
        const meanP = scored.reduce((acc, s) => acc + s.p, 0) / scored.length;
        const perWeightOf = (p) => {
            if (!Number.isFinite(meanP) || meanP <= 0 || !Number.isFinite(p))
                return 1;
            return Math.round((p / meanP) * 1e6) / 1e6;
        };
        // ΑΩ-R40：剩余预算读数面（dep 显式优先，overBudget 闭包属性补位 —— sleep 集成
        // 零改线）；无面 ⇒ null ⇒ 选梦回落纯 PER 序 + 布尔执法（既有行为逐字节保持）
        const remainingBudgetMs = readRemainingBudgetMs(d);
        const clockRead = () => {
            if (typeof d.now !== 'function')
                return null;
            try {
                const v = d.now();
                return typeof v === 'number' && Number.isFinite(v) ? v : null;
            }
            catch {
                return null;
            }
        };
        // 梦训练营：一批一馆（共享隔离实验室 —— 梦证据同本累积；虚拟时钟确定性；
        // runPcgWorld 不 ingest 馆内引擎 ⇒ 馆内进化面零扰动，双写只走显式 evolution dep）
        const gymSeed = typeof d.gymSeed === 'number' && Number.isFinite(d.gymSeed) && d.gymSeed >= 0
            ? Math.floor(d.gymSeed) % 0x80000000
            : fnv1a(`w5-2:dream:gym:${watermark}`) % 0x7fffffff;
        let dreamClock = 2_000_000;
        const gym = new AutonomyGym({ seed: gymSeed, maxSteps: budget.maxStepsPerDream, now: () => (dreamClock += 5) });
        const entries = [];
        const lessons = [];
        // ΠΑΝ-113：教训元数据（与 lessons 平行 —— 恒 heuristic：单条轨迹 × 单座
        // 同构世界 × 单次重放的证据等级）
        const lessonMeta = [];
        let replayed = 0;
        let successes = 0;
        let divergences = 0;
        let truncated = false;
        let reason = 'none';
        // ΑΩ-R40：预算停旗 —— 截断归因时 time 优先呈报，纯条数触顶才报 count
        let budgetStopped = false;
        // ΑΩ-R40：条间预算感知选梦 —— 候选池按 PER 序候场，逐条取梦前实读剩余预算：
        // 队首装不下（按滑动估计）⇒ 选「装得下的最短梦」（一条短梦好过零条长梦）；
        // 全装不下 ⇒ 诚实收场（现状语义：条目注记 + truncated/time）。取满 maxDreams 条止。
        const pool = [...scored];
        while (entries.length < budget.maxDreams && pool.length > 0) {
            // 预算纪律：条间实读睡眠预算（safeNow(now) − startedAt > budgetMs 的既有执法面）
            if (d.overBudget()) {
                truncated = true;
                reason = 'time';
                budgetStopped = true;
                const head = pool.shift();
                if (!head)
                    break;
                entries.push(starvedEntry(head, '睡眠预算耗尽 —— 本条未回放（宁短勿挂）'));
                continue;
            }
            const rem = remainingBudgetMs();
            const chosen = pickDreamByBudget(pool, rem, estimateDreamMs, budget.maxStepsPerDream);
            if (rem !== null && chosen.index < 0) {
                // 诚实收场：最短梦也装不下（估计 > 剩余）—— 逐条注记后收兵（宁短勿挂）
                truncated = true;
                reason = 'time';
                budgetStopped = true;
                const head = pool.shift();
                if (!head)
                    break;
                const est = Math.round(estimateDreamMs(dreamExpectedSteps(head.t, budget.maxStepsPerDream)));
                entries.push(starvedEntry(head, `睡眠剩余预算不足以完成本条（估计 ${est}ms > 剩余 ${Math.round(rem)}ms）—— 未回放（宁短勿挂）`));
                continue;
            }
            const s = pool.splice(Math.max(0, chosen.index), 1)[0];
            if (!s)
                break;
            let picked;
            try {
                picked = pickIsomorphicWorld(s.t);
            }
            catch (e) {
                entries.push({
                    id: s.t.id, priority: s.p, factors: s.factors,
                    world: { master: -1, seed: -1, index: -1, difficulty: -1, fingerprint: '' },
                    replayed: false, doubleWrite: { kernel: false, evolution: false },
                    note: `同构世界铸造故障（旁路吸收）：${e instanceof Error ? e.message : String(e)}`,
                });
                continue;
            }
            // 重放：现有闭环执法面（runPcgWorld 自带防弹壳 —— 内部异常收敛为失败轮；
            // ΑΩ-R40：前后实读注入时钟 —— 实测单梦耗时入滑动账本，恒时钟零差不入账）
            const t0 = clockRead();
            const round = await gym.runPcgWorld(picked.world);
            const t1 = clockRead();
            const strategies = Array.isArray(round.strategies) ? round.strategies : [];
            const divergence = locateDivergence(s.t.history, strategies);
            const replayView = {
                success: round.result.success === true,
                steps: Number.isFinite(round.result.steps) ? round.result.steps : 0,
                phase: typeof round.result.phase === 'string' ? round.result.phase : '?',
                strategies,
                divergence,
            };
            // ΑΩ-R40：本梦实测耗时入账（供下一条梦的选梦估计 —— 每步均值随用随收敛）
            if (t0 !== null && t1 !== null && t1 >= t0)
                observeDreamCost(t1 - t0, replayView.steps);
            const entry = {
                id: s.t.id,
                priority: s.p,
                factors: s.factors,
                ...(chosen.mode === 'short' ? { pick: 'short' } : {}),
                world: {
                    master: picked.master,
                    seed: picked.world.seed,
                    index: picked.index,
                    difficulty: picked.world.derivation.difficulty,
                    fingerprint: picked.world.derivation.fingerprint,
                },
                replayed: true,
                replay: replayView,
                doubleWrite: { kernel: false, evolution: false },
            };
            replayed += 1;
            if (replayView.success)
                successes += 1;
            if (divergence !== null)
                divergences += 1;
            // ── 分歧点双写（首个分歧点之后才有新信息；无分歧 ⇒ 双缺席 + 注记） ──
            if (divergence === null) {
                entry.note = '无分歧点（当前策略与历史前缀一致或无历史对照面）—— 不双写（重放结局无新信息）';
            }
            else {
                // ΝΩ-34：重要性采样权重入记录注记（与 bandit prob 同位 —— 备账不接消费面）
                entry.perWeight = perWeightOf(s.p);
                // (a) kernel 证据：现有 lab 记账通道（runPcgWorld 已记 Θ-3 四键 + pcg.truth.*；
                //     分歧结局补记 dream.cf:<桶>）。ΝΩ-34 修法：① 单键 'dream.counterfactual'
                //     滑窗混装所有参数场景 ⇒ 分桶（rootCause 病因桶优先，缺席回落世界指纹桶）；
                //     ② margin 语义改名 divergenceStep —— 步序不是裕量，账本 margin 通道不再
                //     装步序（防 calibrator 学到伪结构），步序记梦侧注记 cfLedger 备查
                const cfKey = dreamCfKey(s.t.rootCause, entry.world.fingerprint);
                try {
                    gym.lab?.ledger.record({
                        key: cfKey,
                        success: replayView.success,
                        ts: dreamClock,
                    });
                    entry.cfLedger = { key: cfKey, divergenceStep: divergence };
                    entry.doubleWrite.kernel = true;
                }
                catch {
                    entry.doubleWrite.kernel = false; // 记账绝不炸梦
                }
                // (b) evolution 双写：ingest 带 bandit 标注（EXP4 greedy 只读面 —— 重放不采样）
                const evo = d.evolution;
                if (evo && typeof evo.greedyArm === 'function' && typeof evo.armProbabilities === 'function' && typeof evo.ingest === 'function') {
                    try {
                        const ctx = {
                            scene: entry.world.fingerprint.slice(0, 32),
                            failureCluster: typeof s.t.rootCause === 'string' && s.t.rootCause ? s.t.rootCause : 'unknown',
                            worldKind: 'pcg',
                            stepsRemaining: Math.max(0, budget.maxStepsPerDream - replayView.steps),
                            budget: budget.maxStepsPerDream,
                        };
                        const arm = evo.greedyArm(ctx);
                        const dist = evo.armProbabilities(ctx);
                        const prob = typeof dist?.[arm] === 'number' && Number.isFinite(dist[arm]) && dist[arm] > 0
                            ? Math.min(1, dist[arm])
                            : 1;
                        const record = {
                            goal: `梦回放:${s.t.query}`.slice(0, 120),
                            success: replayView.success,
                            steps: replayView.steps,
                            durationMs: round.result.durationMs,
                            strategies,
                            ...(replayView.success ? {} : { failureRootCause: `dream-replay:phase=${replayView.phase}` }),
                            bandit: { context: ctx, arm, prob },
                        };
                        evo.ingest(record);
                        entry.doubleWrite.evolution = true;
                    }
                    catch {
                        entry.doubleWrite.evolution = false; // 进化双写绝不炸梦
                    }
                }
                else {
                    entry.note = 'evolution 面缺席 —— EXP4 双写缺席（诚实注记）';
                }
                // 反事实教训：重放成功而历史失败（失败轨迹恒历史失败 —— 梦的全部前提）
                // ΠΑΝ-113（语义降格）：教训文案与证据强度对齐 —— 同构世界单次重放
                // （n=1、PCG 合成世界、输入冻结）产出的只是**提示性启发**，不是
                // 「重试前优先/勿原样重试」的规定性规则（旧文案的强度超出证据等级，
                // 消费方会当硬规则执行）。lessonKind='heuristic' 结构化标注 + 文案
                // 降格双面执法。
                if (replayView.success) {
                    const histKind = s.t.history?.[divergence]?.kind ?? '?';
                    const replayKind = strategies[divergence] ?? '?';
                    const lesson = `反事实教训（heuristic —— 提示性参考，非硬规则）：任务「${s.t.query.slice(0, 60)}」第 ${divergence + 1} 步的决策「${histKind}」在同构世界（指纹 ${entry.world.fingerprint.slice(0, 12)}、seed ${entry.world.seed}）本可被纠正 —— ` +
                        `当前策略改走「${replayKind}」后重放成功（${replayView.steps} 步）。同类场景可考虑尝试 ${replayKind}（证据强度：单次同构世界重放，样本 n=1 —— 仅供参考，请结合现场判断，勿机械套用）。`;
                    entry.lesson = lesson;
                    entry.lessonKind = 'heuristic';
                    lessons.push(lesson);
                    lessonMeta.push({ kind: 'heuristic', evidence: 'isomorphic-world-replay', sample: 1 });
                }
            }
            entries.push(entry);
        }
        // ΑΩ-R40：截断归因 —— 预算停（time）优先呈报；纯条数触顶（取满 maxDreams 而池
        // 未空）才报 count；池自然取空 ⇒ 未截断
        if (!budgetStopped && entries.length < scored.length) {
            truncated = true;
            reason = 'count';
        }
        // kernel 证据对账面（现有 lab 记账通道的产出盘点）
        const kernelEvidence = [];
        try {
            const ledger = gym.lab?.ledger;
            if (ledger) {
                for (const key of ledger.keys()) {
                    const st = ledger.stats(key);
                    kernelEvidence.push({ key, n: st.n });
                }
            }
        }
        catch {
            /* 对账面故障 ⇒ 缺席（记账本身已成功） */
        }
        return {
            report: {
                watermark,
                attempted: entries.length,
                replayed,
                successes,
                divergences,
                lessons,
                lessonMeta,
                entries,
                budget: { ...budget, truncated, reason },
                kernelEvidence,
            },
            lab: gym.lab,
        };
    }
    catch (e) {
        // 永不抛铁律：编排器自身的意外故障也收敛为诚实报告
        return {
            report: {
                ...empty.report,
                note: `梦回放编排意外故障（已吞，绝不炸睡眠）：${e instanceof Error ? e.message : String(e)}`,
            },
            lab: null,
        };
    }
}
