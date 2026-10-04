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
// 本模块的装载律（与 index.ts「相对导入全部 type-only」律的关系）：
// index.ts 对本模块只做**懒动态 import**（梦 dep 在场才装载）—— 六幕的装载器
// 零耦合律对既有路径逐字节保持；本模块自身是梦的机房，允许运行期导入 gym 的
// PCG 面（pcgWorldStream / AutonomyGym / runPcgWorld —— sharp 懒加载、零网络）。
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
// W6-1（doctor 债清偿·smell.over-engineering）：PER 权重常量、确定性原语（fnv1a）、
// 梦方言契约类型、失败记录→梦轨迹映射、PER 优先级/水位线、同构世界选取逐字节
// 搬至 ./dreamReplayCore —— 本文件保留编排（runDreamReplay）与预算解析，导入面
// 不变（公共面原位再导出）。
export { PER_WEIGHTS, dreamTrajectories, computeDreamPriority, dreamBatchWatermark, pickIsomorphicWorld, } from './dreamReplayCore.js';
import { computeDreamPriority, dreamBatchWatermark, fnv1a, pickIsomorphicWorld, } from './dreamReplayCore.js';
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
// ─── 梦回放编排（永不抛；确定性；预算纪律；分歧点双写） ───
/**
 * W5-2 梦回放编排（async —— sharp 合成帧是唯一的真异步面）：
 *   1. 独立水位线幂等：批次指纹 === priorWatermark ⇒ 全跳过（note 申报，防重复回放）；
 *   2. PER 排序选 top-maxDreams（p 降序、平票 id 升序 —— 确定性法院）；
 *   3. 逐条：预算检查（overBudget —— 实读 sleep 预算机制，条间执法）⇒ 取同构
 *      世界（冻结输入）⇒ 梦训练营 runPcgWorld 重决策（现有 policyEngine 决策面
 *      + 离线哨兵 client + 宪法 + Θ-3 全套记账 —— 全是既有执法面，只读消费）；
 *   4. 分歧点之后双写：(a) kernel 证据 —— runPcgWorld 期间已按现有 lab 记账通道
 *      入账（世界真相对账四键），分歧结局另记 dream.counterfactual 一条（margin =
 *      分歧步序）；(b) evolutionEngine.ingest 带 bandit 标注（arm/prob 取自 EXP4
 *      greedy 的只读面 —— 重放不采样铁律）；
 *   5. 重放成功且历史失败 ⇒ 反事实教训条目（晨报消费面）。
 * 确定性：世界 seed 冻结 + 梦训练营虚拟时钟 + 离线哨兵 client ⇒ 同轨迹同策略
 * 状态逐字节同重放。隔离：梦实验室独立自铸（Θ-3 律），生产 kernel 分毫不动。
 */
export async function runDreamReplay(deps) {
    const empty = {
        report: {
            watermark: '',
            attempted: 0, replayed: 0, successes: 0, divergences: 0,
            lessons: [], entries: [],
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
        const watermark = dreamBatchWatermark(trajectories);
        if (typeof d.priorWatermark === 'string' && d.priorWatermark === watermark) {
            return {
                report: { ...base, watermark, note: '梦回放水位线未动 —— 本轮零回放（同一失败集已梦过，防重复回放）' },
                lab: null,
            };
        }
        if (budget.maxDreams <= 0) {
            return { report: { ...base, watermark, note: '梦回放预算 maxDreams=0 —— 关闭（申报在案）' }, lab: null };
        }
        // PER 打分 + 确定性排序（p 降序；平票 id 升序）
        const now = typeof d.now === 'function' ? d.now() : 0;
        const nowSafe = typeof now === 'number' && Number.isFinite(now) ? now : 0;
        const scored = trajectories.map(t => {
            const { p, factors } = computeDreamPriority(t, { spectrum: d.spectrum, now: nowSafe });
            return { t, p, factors };
        });
        scored.sort((a, b) => b.p - a.p || String(a.t.id).localeCompare(String(b.t.id)));
        const selected = scored.slice(0, budget.maxDreams);
        // 梦训练营：一批一馆（共享隔离实验室 —— 梦证据同本累积；虚拟时钟确定性；
        // runPcgWorld 不 ingest 馆内引擎 ⇒ 馆内进化面零扰动，双写只走显式 evolution dep）
        const gymSeed = typeof d.gymSeed === 'number' && Number.isFinite(d.gymSeed) && d.gymSeed >= 0
            ? Math.floor(d.gymSeed) % 0x80000000
            : fnv1a(`w5-2:dream:gym:${watermark}`) % 0x7fffffff;
        let dreamClock = 2_000_000;
        const gym = new AutonomyGym({ seed: gymSeed, maxSteps: budget.maxStepsPerDream, now: () => (dreamClock += 5) });
        const entries = [];
        const lessons = [];
        let replayed = 0;
        let successes = 0;
        let divergences = 0;
        let truncated = false;
        let reason = 'none';
        for (const s of selected) {
            // 预算纪律：条间实读睡眠预算（safeNow(now) − startedAt > budgetMs 的既有执法面）
            if (d.overBudget()) {
                truncated = true;
                reason = 'time';
                entries.push({
                    id: s.t.id, priority: s.p, factors: s.factors,
                    world: { master: -1, seed: -1, index: -1, difficulty: -1, fingerprint: '' },
                    replayed: false,
                    doubleWrite: { kernel: false, evolution: false },
                    note: '睡眠预算耗尽 —— 本条未回放（宁短勿挂）',
                });
                continue;
            }
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
            // 重放：现有闭环执法面（runPcgWorld 自带防弹壳 —— 内部异常收敛为失败轮）
            const round = await gym.runPcgWorld(picked.world);
            const strategies = Array.isArray(round.strategies) ? round.strategies : [];
            const divergence = locateDivergence(s.t.history, strategies);
            const replayView = {
                success: round.result.success === true,
                steps: Number.isFinite(round.result.steps) ? round.result.steps : 0,
                phase: typeof round.result.phase === 'string' ? round.result.phase : '?',
                strategies,
                divergence,
            };
            const entry = {
                id: s.t.id,
                priority: s.p,
                factors: s.factors,
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
                // (a) kernel 证据：现有 lab 记账通道（runPcgWorld 已记 Θ-3 四键 + pcg.truth.*；
                //     分歧结局补记 dream.counterfactual，margin = 分歧步序）
                try {
                    gym.lab?.ledger.record({
                        key: 'dream.counterfactual',
                        success: replayView.success,
                        margin: divergence,
                        ts: dreamClock,
                    });
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
                if (replayView.success) {
                    const histKind = s.t.history?.[divergence]?.kind ?? '?';
                    const replayKind = strategies[divergence] ?? '?';
                    const lesson = `反事实教训：任务「${s.t.query.slice(0, 60)}」第 ${divergence + 1} 步的决策「${histKind}」在同构世界（指纹 ${entry.world.fingerprint.slice(0, 12)}、seed ${entry.world.seed}）本可被纠正 —— ` +
                        `当前策略改走「${replayKind}」后重放成功（${replayView.steps} 步）；同类场景重试前优先考虑 ${replayKind}，勿原样重试 ${histKind}。`;
                    entry.lesson = lesson;
                    lessons.push(lesson);
                }
            }
            entries.push(entry);
        }
        if (!truncated && selected.length < scored.length) {
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
                attempted: selected.length,
                replayed,
                successes,
                divergences,
                lessons,
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
