// test/w5dream.test.ts
// W5-2（M4 优先经验反事实梦回放）执法册：
//   D1 PER 优先级：公式手算（p = ŝ×cost×recency 逐因子对照）/ 排序律 / 惊异
//      证据回落链（轨迹 > 谱键 > 谱均值 > 先验）/ 垃圾输入防御；
//   D2 同构世界选取：同轨迹恒同世界（master/seed/指纹）/ 显式冻结参数生效
//      （master/难度/文法权重）/ 异轨迹异世界 / 流水取样序号界内；
//   D3 冻结输入重放 + 确定性：两次独立编排逐字节同报告；当前策略重决策与
//      历史错路分歧（divergence 定位）；
//   D4 分歧点双写：kernel 证据（现有 lab 记账通道 dream.counterfactual）+
//      evolutionEngine ingest 带 bandit 标注（EXP4 greedy 只读面）；无分歧 ⇒
//      不双写；生产 kernel 注册表隔离（分毫不动）；
//   D5 复合幕 + 晨报：第①幕「回放+梦回放」counts 合并、晨报 dream 摘要与
//      反事实教训在场、trace 行携带梦水位线；dream dep 缺席 ⇒ 零漂移；
//   D6 预算纪律：每条步数上限钳制 / 每周期条数上限（诚实截断）/ 睡眠预算
//      耗尽（宁短勿挂，条间实读）；
//   D7 缺数据诚实跳过：无失败轨迹 / 垃圾轨迹源 / 抛错轨迹源 ⇒ 注记吸收；
//   D8 水位线幂等：主水位线不动 ⇒ 整轮 noop（既有律不破）；主水位线动而
//      失败集不动 ⇒ 梦独立水位线拦下；新失败 ⇒ 再回放；跨进程（trace 尾行
//      恢复梦水位线）同律。
//   D10（ΑΩ-R40 预算现实主义）：条间预算感知选梦 —— 小预算选短梦/零梦诚实
//      收场；大预算长短皆按 PER 序；冷启动保守估计；耗时估计随注入时钟收敛
//      （EMA 账本 + 行为验证）；剩余预算读数面（dep 显式 + overBudget 闭包属性）；
//   D10d/D11（ΝΩ-34 睡眠编排四件）：梦回放移序立法（audit 后迟到演出 —— 小预算
//      下校准/审计先吃预算不再恒 timeout 饿死）；梦水位线策略指纹（策略显著
//      进化 ⇒ 同失败集允许重梦；同策略仍去重）；perWeight = p/mean(p) 批内
//      归一备账；dream.cf:<rootCause|世界指纹桶> 分桶 + divergenceStep 注记
//     （账本 margin 通道退役 —— 步序不是裕量）。
// 全程离线（sharp 合成帧）、注入时钟、确定性（零真钟零网络零睡眠）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runSleepCycle, resetSleepCycle,
  type SleepDeps, type SleepReport,
} from '../src/sleep/index.ts';
import {
  computeDreamPriority, dreamTrajectories, dreamBatchWatermark, pickIsomorphicWorld,
  locateDivergence, resolveDreamBudget, runDreamReplay, PER_WEIGHTS, DREAM_BUDGET_DEFAULTS,
  dreamExpectedSteps, pickDreamByBudget, DREAM_COST_ESTIMATOR, readDreamCostLedger, resetDreamCostLedger,
  // ΝΩ-34：策略指纹与 dream.cf 分桶的纯逻辑面
  dreamCfKey, policyFingerprintOf, POLICY_FINGERPRINT_GRID,
  type DreamFailureTrajectory,
} from '../src/sleep/dreamReplay.ts';
import { EvolutionEngine } from '../src/autonomy/evolutionEngine.ts';
import { kernelRegistry } from '../src/kernel/registry.ts';
import type { FailureRecord } from '../src/failureMemory.ts';

// ─── 测试基建 ───

/** 强制简单文法（近似确定地采 form + none —— 可解性压测用，与 w4pcg 同律） */
const FORCE_SIMPLE: Record<string, number> = {
  'decor:none': 100,
  'decor:popup': 0.01,
  'decor:payTrap': 0.01,
  'decor:cookie': 0.01,
  'decor:loading': 0.01,
  'main:form': 100,
  'main:tree': 0.01,
  'main:list': 0.01,
  'main:collapse': 0.01,
};

/** 固定步进时钟（runSleepCycle 的注入时钟 —— durationMs 与预算判定可精确断言） */
function tickClock(start = 1_000_000, step = 10): { now: () => number } {
  let t = start;
  return { now: () => (t += step) };
}

/** 标准梦轨迹（错路历史 scroll×2 + 冻结简单世界 ⇒ 当前策略必成功、分歧恒 0） */
function traj(over: Partial<DreamFailureTrajectory> = {}): DreamFailureTrajectory {
  return {
    id: 'f1',
    query: '走完向导导出报表',
    approach: 'scroll 后误点折叠区',
    symptom: '无进展',
    at: 1_700_000_000_000,
    surpriseBits: 8,
    stepsWasted: 10,
    riskTier: 'sensitive',
    history: [{ kind: 'scroll' }, { kind: 'scroll' }],
    world: { seed: 4242, difficulty: 1, weights: FORCE_SIMPLE },
    ...over,
  };
}

/** 假 journal（水位线指纹面 —— D5/D8 的主水位线锚） */
interface FakeEntry { ts: number; tool: string; args: Record<string, unknown>; status: string; hash?: string }
function entry(hash: string): FakeEntry {
  return { ts: 1700000000, tool: 'click_mouse', args: {}, status: 'SUCCESS', hash };
}
function fakeJournal(entries: FakeEntry[]) {
  return {
    list(actionOnly = true): FakeEntry[] {
      return actionOnly ? entries.filter(e => e.tool === 'click_mouse') : entries;
    },
    verify() {
      return { ok: true, length: entries.length, brokenAt: null };
    },
  };
}

// ─── D1：PER 优先级公式 ───

test('D1: PER 优先级 —— 手算逐因子对照 + 排序律 + 惊异回落链 + 垃圾防御', () => {
  // 手算：ŝ = 8/(8+8) = 0.5；cost = 1.5×(1+20/20) = 3；recency = 2^(−半衰期/半衰期) = 0.5
  // ⇒ p = 0.5 × 3 × 0.5 = 0.75（PER_WEIGHTS 全部模块常量 —— 公式可审计）
  const now = 1_000_000;
  const t = traj({ surpriseBits: 8, riskTier: 'sensitive', stepsWasted: 20, at: now - PER_WEIGHTS.halfLifeMs });
  const { p, factors } = computeDreamPriority(t, { now });
  assert.equal(p, 0.75, 'p = ŝ(0.5) × cost(3) × recency(0.5) = 0.75 —— 手算对照');
  assert.equal(factors.surpriseBits, 8);
  assert.equal(factors.surpriseSource, 'trajectory');
  assert.equal(factors.cost, 3);
  assert.equal(factors.recency, 0.5);

  // 边界：零惊异 ⇒ p=0（无惊异的世界不进梦）；当刻失败 ⇒ recency=1
  assert.equal(computeDreamPriority(traj({ surpriseBits: 0, stepsWasted: 0, at: now }), { now }).p, 0);
  assert.equal(computeDreamPriority(traj({ stepsWasted: 0, at: now }), { now }).factors.recency, 1);

  // 排序律：更惊异 / 更高风险 / 更新 ⇒ 更高优先级
  const low = computeDreamPriority(traj({ surpriseBits: 2, riskTier: 'benign', at: now - 4 * PER_WEIGHTS.halfLifeMs }), { now }).p;
  const high = computeDreamPriority(traj({ surpriseBits: 16, riskTier: 'destructive', at: now }), { now }).p;
  assert.ok(high > low, `destructive+16bits+新 应压过 benign+2bits+旧（${high} > ${low}）`);
  const pRisky = computeDreamPriority(traj({ riskTier: 'destructive', at: now }), { now }).p;
  const pCalm = computeDreamPriority(traj({ riskTier: 'benign', at: now }), { now }).p;
  assert.ok(pRisky > pCalm, '风险档乘子destructive > benign');

  // 惊异证据回落链：谱键命中 > 谱均值 > 先验（surpriseBits: undefined 关闭轨迹自带通道）
  const spectrum = { 'screen-1': 4, 'screen-2': 12 };
  assert.equal(computeDreamPriority(traj({ sceneType: 'screen-2', at: now, surpriseBits: undefined }), { now, spectrum }).factors.surpriseSource, 'spectrum-key');
  assert.equal(computeDreamPriority(traj({ sceneType: 'screen-2', at: now, surpriseBits: undefined }), { now, spectrum }).factors.surpriseBits, 12);
  const viaMean = computeDreamPriority(traj({ at: now, surpriseBits: undefined }), { now, spectrum }).factors; // 无 sceneType ⇒ 谱均值 8
  assert.equal(viaMean.surpriseSource, 'spectrum-mean');
  assert.equal(viaMean.surpriseBits, 8);
  const viaPrior = computeDreamPriority(traj({ at: now, surpriseBits: undefined }), { now }).factors; // 无谱 ⇒ 先验 2
  assert.equal(viaPrior.surpriseSource, 'prior');
  assert.equal(viaPrior.surpriseBits, PER_WEIGHTS.surprisePriorBits);

  // 垃圾防御：坏数值逐因子回落，结果恒有限非负（绝不 NaN 上晨报）
  const junk = { id: 'j', query: 'q', approach: 'a', symptom: 's', at: Number.NaN, surpriseBits: Number.POSITIVE_INFINITY, stepsWasted: -5 } as unknown as DreamFailureTrajectory;
  const r = computeDreamPriority(junk, { now });
  assert.ok(Number.isFinite(r.p) && r.p >= 0, `垃圾轨迹优先级有限非负（p=${r.p}）`);
});

// ─── D2：同构世界选取 ───

test('D2: 同构世界选取 —— 同轨迹恒同世界；显式冻结参数生效；异轨迹异世界；序号界内', () => {
  const a = pickIsomorphicWorld(traj());
  const b = pickIsomorphicWorld(traj());
  assert.equal(a.world.derivation.fingerprint, b.world.derivation.fingerprint, '同轨迹 ⇒ 同推导指纹');
  assert.equal(a.world.seed, b.world.seed, '同轨迹 ⇒ 同世界种子');
  assert.equal(a.master, b.master, '同轨迹 ⇒ 同流水主种子');
  assert.equal(a.master, 4242, '显式 world.seed 是冻结的流水主种子');
  assert.equal(a.world.derivation.difficulty, 1, '显式难度冻结生效');
  assert.ok(a.index >= 0 && a.index < 16, `流水取样序号界内（${a.index}）`);

  // 文法权重冻结：FORCE_SIMPLE ⇒ 推导链含 main:form 与 decor:none
  assert.ok(a.world.derivation.chain.includes('main:form'), '冻结文法权重生效（main:form）');
  assert.ok(a.world.derivation.chain.includes('decor:none'), '冻结文法权重生效（decor:none）');

  // 异轨迹异世界（不同 sceneHash ⇒ 不同 master —— 大概率不同指纹）
  const diffs = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const w = pickIsomorphicWorld(traj({ id: `f${i}`, sceneHash: `scene-${i}` }));
    diffs.add(w.world.derivation.fingerprint);
  }
  assert.ok(diffs.size >= 2, `六条异轨迹产出 ≥2 个异构世界（实得 ${diffs.size}）`);

  // 显式 seed 缺席 ⇒ 指纹派生（确定性）：同轨迹两次派生一致
  const noSeed = pickIsomorphicWorld(traj({ world: { difficulty: 2 } }));
  const noSeed2 = pickIsomorphicWorld(traj({ world: { difficulty: 2 } }));
  assert.equal(noSeed.world.seed, noSeed2.world.seed, '派生种子确定性');
  assert.ok(Number.isFinite(noSeed.world.seed) && noSeed.world.seed >= 0, '派生种子合法');
});

// ─── D3：冻结输入重放 + 确定性 ───

test('D3: 冻结输入重放 —— 同轨迹同策略状态逐字节同重放；错路历史分歧可定位', async () => {
  const run = (): ReturnType<typeof runDreamReplay> =>
    runDreamReplay({
      trajectories: dreamTrajectories([traj()]),
      now: () => 5000,
      overBudget: () => false,
      budget: { maxDreams: 2, maxStepsPerDream: 10 },
    });
  const a = await run();
  const b = await run();
  assert.deepEqual(b.report, a.report, '两次独立编排逐字节同报告（重放确定性）');

  assert.equal(a.report.replayed, 1);
  const e = a.report.entries[0];
  assert.ok(e.replayed, '预算内轨迹真实重放');
  // 重放的世界恰是从流水取到的那个（冻结输入的执法证据）
  assert.equal(e.world.fingerprint, pickIsomorphicWorld(traj()).world.derivation.fingerprint);
  // 当前策略重决策：简单世界 ⇒ 全 click 推进（历史错路 scroll×2 ⇒ 分歧恒 0）
  assert.equal(e.replay?.divergence, 0, '首个分歧点 = 第 1 步（历史 scroll vs 重放 click）');
  assert.ok(e.replay!.strategies.length > 0 && e.replay!.strategies.every(k => k === 'click'), '当前策略决策面（离线哨兵确定性收口）');

  // 分歧定位纯函数的边界：空历史 / 前缀一致 / 中途分歧
  assert.equal(locateDivergence([], ['click']), null, '无历史对照面 ⇒ 无分歧');
  assert.equal(locateDivergence([{ kind: 'click' }, { kind: 'click' }], ['click', 'click', 'click']), null, '前缀一致 ⇒ 未分歧');
  assert.equal(locateDivergence([{ kind: 'click' }, { kind: 'scroll' }], ['click', 'click']), 1, '第 2 步分歧');

  // 预算解析夹取律
  assert.deepEqual(resolveDreamBudget(undefined), { maxDreams: DREAM_BUDGET_DEFAULTS.maxDreams, maxStepsPerDream: DREAM_BUDGET_DEFAULTS.maxStepsPerDream });
  assert.deepEqual(resolveDreamBudget({ maxDreams: 999, maxStepsPerDream: -3 }), { maxDreams: 16, maxStepsPerDream: 1 }, '越界夹取');
});

// ─── D4：分歧点双写（kernel 记账通道 + evolutionEngine ingest 带 bandit 标注） ───

test('D4: 分歧点双写 —— lab 账本 dream.counterfactual + EXP4 ingest；无分歧不双写；生产 kernel 隔离', async () => {
  const prodBefore = JSON.stringify(kernelRegistry.list());

  const engine = new EvolutionEngine({ seed: 7 });
  const histBefore = engine.history.length;
  const res = await runDreamReplay({
    trajectories: dreamTrajectories([traj()]),
    now: () => 5000,
    overBudget: () => false,
    evolution: engine,
    budget: { maxDreams: 1, maxStepsPerDream: 10 },
  });
  const entry = res.report.entries[0];
  assert.notEqual(entry.replay?.divergence, null, '分歧在场（双写门槛）');

  // (a) kernel 证据：现有 lab 记账通道 —— runPcgWorld 的 Θ-3 记账 + 分歧结局补记。
  //     ΝΩ-34：dream.counterfactual 单键滑窗 ⇒ 分桶 dream.cf:<桶>（traj() 无
  //     rootCause ⇒ 世界指纹桶）；margin 通道不再装分歧步序（步序不是裕量 ——
  //     防 calibrator 学到伪结构），divergenceStep 记梦侧注记 cfLedger
  const lab = res.lab;
  assert.ok(lab, '梦训练营实验室在场（隔离自铸）');
  assert.notEqual(lab!.registry, kernelRegistry as unknown, '实验室注册表绝非遗漏生产单例');
  const cfKey = dreamCfKey(undefined, pickIsomorphicWorld(traj()).world.derivation.fingerprint);
  const cf = lab!.ledger.stats(cfKey);
  assert.equal(cf.n, 1, '分歧结局入账一条（ΝΩ-34 分桶键）');
  assert.deepEqual(cf.margins, [], 'ΝΩ-34：账本 margin 通道不装分歧步序（步序≠裕量）');
  assert.equal(entry.cfLedger?.key, cfKey, '梦侧注记携带分桶键');
  assert.equal(entry.cfLedger?.divergenceStep, 0, 'divergenceStep = 分歧步序（margin 语义改名的落点）');
  assert.ok(res.report.kernelEvidence.some(k => k.key === cfKey), '报告携带 kernel 证据对账面（分桶键）');
  assert.ok(entry.doubleWrite.kernel, 'kernel 双写执法面为真');

  // (b) evolution 双写：ingest 带 bandit 标注（arm = EXP4 greedy 只读面）
  assert.equal(engine.history.length, histBefore + 1, '分歧结局 ingest 一条');
  const rec = engine.history[engine.history.length - 1];
  assert.ok(rec.goal.startsWith('梦回放:'), `goal 带梦回放前缀（${rec.goal}）`);
  assert.equal(rec.success, entry.replay!.success, 'ingest 的成败 = 重放结局');
  const ARMS = ['scroll', 'inspect', 'ask_vlm', 'recall_skill', 'click'];
  assert.ok(ARMS.includes(rec.bandit?.arm ?? ''), `bandit.arm 是五内建臂（${rec.bandit?.arm}）`);
  assert.ok(rec.bandit?.prob !== undefined && rec.bandit.prob > 0 && rec.bandit.prob <= 1, 'bandit.prob ∈ (0,1]');
  assert.equal(rec.bandit?.context?.worldKind, 'pcg', 'bandit 上下文世界种类 = pcg');
  assert.ok(entry.doubleWrite.evolution, 'evolution 双写执法面为真');

  // 生产 kernel 注册表分毫不动（隔离铁律 —— 晋升唯一通道是显式 promoteFrom）
  assert.equal(JSON.stringify(kernelRegistry.list()), prodBefore, '生产 kernel 注册表逐字节不变');

  // 无分歧 ⇒ 不双写：把历史喂成与重放完全同路
  const noDiv = await runDreamReplay({
    trajectories: dreamTrajectories([traj({ history: [{ kind: 'click' }, { kind: 'click' }, { kind: 'click' }] })]),
    now: () => 5000,
    overBudget: () => false,
    evolution: engine,
    budget: { maxDreams: 1, maxStepsPerDream: 10 },
  });
  const e2 = noDiv.report.entries[0];
  assert.equal(e2.replay?.divergence, null, '前缀一致 ⇒ 无分歧');
  assert.equal(e2.doubleWrite.kernel, false, '无分歧 ⇒ kernel 不双写');
  assert.equal(e2.doubleWrite.evolution, false, '无分歧 ⇒ evolution 不双写');
  assert.ok((e2.note ?? '').includes('无分歧'), '不双写的注记在案');
  assert.equal(noDiv.lab!.ledger.stats(cfKey).n, 0, '无分歧批次零 dream.cf 入账（ΝΩ-34 分桶键同桶对照）');
  assert.equal(engine.history.length, histBefore + 1, '无分歧批次零 ingest');
});

// ─── D5：第①幕复合幕 + 晨报 + 反事实教训 ───

test('D5: 复合幕与晨报 —— 梦摘要/反事实教训入晨报；trace 行携带梦水位线；dep 缺席零漂移', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'w5dream-d5-'));
  try {
    const trace = join(dir, 'sleep.jsonl');
    const entries = [entry('d5h-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')];
    const deps = (dream?: SleepDeps['dream']): SleepDeps => ({
      journal: fakeJournal(entries),
      dream,
      log: () => { /* 测试静音 */ },
    });

    // 梦在场：复合幕 counts 合并 + 晨报 dream 摘要 + 反事实教训
    const r1 = await runSleepCycle(
      deps({
        failures: () => [traj()],
        budget: { maxDreams: 1, maxStepsPerDream: 10 },
      }),
      { sleepTracePath: trace, now: tickClock().now },
    );
    const replayAct = r1.acts.find(a => a.name === 'replay');
    assert.equal(replayAct?.status, 'ok', '复合幕 ok');
    assert.equal(replayAct?.counts.dreams, 1, 'counts.dreams 合并进第①幕');
    assert.equal(replayAct?.counts.dreamLessons, 1, 'counts.dreamLessons = 反事实教训数');
    assert.ok(r1.dream, '晨报顶层 dream 摘要在场');
    assert.equal(r1.dream!.lessons.length, 1, '反事实教训一条');
    const lesson = r1.dream!.lessons[0];
    assert.ok(lesson.includes('反事实教训') && lesson.includes('本可被纠正'), `教训文案（${lesson.slice(0, 40)}…）`);
    assert.ok(lesson.includes('scroll') && lesson.includes('click'), '教训点名历史决策与纠正决策');
    assert.ok((replayAct?.detail ?? '').includes('梦回放：1/1'), '复合幕 detail 汇报梦战况');

    // trace 行：dream 段 + 梦水位线（跨进程幂等的锚）
    const line = JSON.parse(readFileSync(trace, 'utf8').trim().split('\n')[0]);
    assert.equal(line.acts.length, 6, '行内六幕齐全');
    assert.ok(line.dream && typeof line.dream.watermark === 'string', '晨报行携带 dream.watermark');
    assert.equal(line.dream.replayed, 1, '行内梦摘要如实');
    assert.ok(typeof line.dream.entries[0].priority === 'number', '行内梦条目带 PER 优先级（可审计）');

    // dep 缺席：零漂移 —— counts 无 dream 键、晨报无 dream 段（诚实缺席）
    resetSleepCycle();
    entries.push(entry('d5h-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'));
    const r2 = await runSleepCycle(deps(undefined), { now: tickClock().now });
    const replay2 = r2.acts.find(a => a.name === 'replay');
    assert.equal(replay2?.status, 'ok');
    assert.equal('dreams' in (replay2?.counts ?? {}), false, 'dep 缺席 ⇒ 无 dream counts（零漂移）');
    assert.equal(r2.dream, undefined, 'dep 缺席 ⇒ 晨报无 dream 段');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── D6：预算纪律 ───

test('D6: 预算钳制 —— 每条步数上限 / 每周期条数上限（诚实截断）/ 睡眠预算耗尽（宁短勿挂）', async () => {
  const three = [traj({ id: 'a' }), traj({ id: 'b' }), traj({ id: 'c' })];

  // 每条步数上限：maxStepsPerDream=2 ⇒ 重放步数 ≤2（世界未走完 ⇒ 失败，诚实入账）
  const capped = await runDreamReplay({
    trajectories: dreamTrajectories([traj()]),
    now: () => 5000,
    overBudget: () => false,
    budget: { maxDreams: 1, maxStepsPerDream: 2 },
  });
  assert.equal(capped.report.entries[0].replay!.steps, 2, '步数钳制在每条上限');
  assert.equal(capped.report.entries[0].replay!.success, false, '钳制下未走完 = 失败（不伪造成功）');

  // 每周期条数上限：3 条轨迹 maxDreams=1 ⇒ 只回放优先级最高 1 条
  const counted = await runDreamReplay({
    trajectories: dreamTrajectories(three),
    now: () => 5000,
    overBudget: () => false,
    budget: { maxDreams: 1, maxStepsPerDream: 6 },
  });
  assert.equal(counted.report.attempted, 1);
  assert.equal(counted.report.entries.length, 1);
  assert.equal(counted.report.budget.truncated, true, '条数触顶诚实截断');
  assert.equal(counted.report.budget.reason, 'count');

  // 睡眠预算耗尽（overBudget 恒真 —— 条间实读 sleep 预算机制）：零回放 + 注记
  const starved = await runDreamReplay({
    trajectories: dreamTrajectories(three),
    now: () => 5000,
    overBudget: () => true,
    budget: { maxDreams: 2, maxStepsPerDream: 6 },
  });
  assert.equal(starved.report.replayed, 0, '预算耗尽 ⇒ 零回放');
  assert.equal(starved.report.budget.reason, 'time');
  assert.ok(starved.report.entries.every(e => !e.replayed && (e.note ?? '').includes('预算耗尽')), '每条带「预算耗尽」注记');
});

// ─── D7：缺数据诚实跳过 + 永不抛 ───

test('D7: 缺数据跳过 —— 无失败轨迹 / 垃圾源 / 抛错源 ⇒ 注记吸收；FailureRecord 映射防御', async () => {
  const mkDeps = (failures: () => unknown): SleepDeps['dream'] => ({ failures });

  const empty = await runSleepCycle(
    { journal: fakeJournal([entry('d7h-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')]), dream: mkDeps(() => []), log: () => {} },
    { now: tickClock().now },
  );
  assert.ok((empty.dream?.note ?? '').includes('无失败轨迹'), '空失败集 ⇒ 诚实跳过注记');
  assert.equal(empty.dream?.replayed, 0);

  const garbage = await runSleepCycle(
    { journal: fakeJournal([entry('d7h-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')]), dream: mkDeps(() => '垃圾' as unknown), log: () => {} },
    { now: tickClock().now },
  );
  assert.ok((garbage.dream?.note ?? '').includes('无失败轨迹'), '垃圾源同律跳过');

  const bomb = await runSleepCycle(
    { journal: fakeJournal([entry('d7h-ccccccccccccccccccccccccccccccc')]), dream: mkDeps(() => { throw new Error('failures 炸'); }), log: () => {} },
    { now: tickClock().now },
  );
  assert.ok((bomb.dream?.note ?? '').includes('失败轨迹源故障'), '抛错源 ⇒ 旁路吸收注记');
  assert.equal(bomb.acts.find(a => a.name === 'replay')?.status, 'ok', '梦故障不毒化回放幕本体');

  // evolution 面缺席 ⇒ 双写缺席注记（分歧在场时）
  const noEvo = await runDreamReplay({
    trajectories: dreamTrajectories([traj()]),
    now: () => 5000,
    overBudget: () => false,
    budget: { maxDreams: 1, maxStepsPerDream: 10 },
  });
  assert.equal(noEvo.report.entries[0].doubleWrite.evolution, false);
  assert.ok((noEvo.report.entries[0].note ?? '').includes('evolution 面缺席'), 'EXP4 双写缺席注记');

  // evolution 面抛错 ⇒ 吸收不炸梦
  const hostile: SleepDeps['dream'] = {
    failures: () => [traj()],
    evolution: {
      greedyArm: () => { throw new Error('greedyArm 炸'); },
      armProbabilities: () => ({ click: 1 }),
      ingest: () => { throw new Error('ingest 炸'); },
    },
  };
  const hostileRun = await runSleepCycle(
    { journal: fakeJournal([entry('d7h-dddddddddddddddddddddddddddddddd')]), dream: hostile, log: () => {} },
    { now: tickClock().now },
  );
  assert.equal(hostileRun.dream?.replayed, 1, 'EXP4 面炸 ⇒ 梦照常回放（旁路吸收）');
  assert.equal(hostileRun.dream?.entries[0].doubleWrite.evolution, false);

  // FailureRecord 映射：id 数字→串、approach 尽力解析历史（最长词匹配）、派生世界合法
  const rec: FailureRecord = {
    id: 7, query: '登录门户', approach: 'click_mouse(提交按钮) 后 scroll_wheel', symptom: '被拦截',
    sceneHash: 'scene-login-001', rootCause: 'stall', at: 123,
  };
  const mapped = dreamTrajectories([rec, null, 'x', { query: '无身份' } as unknown as FailureRecord]);
  assert.equal(mapped.length, 1, '垃圾条目剔除（无 id 不成梦）');
  assert.equal(mapped[0].id, '7');
  assert.deepEqual(mapped[0].history, [{ kind: 'click_mouse' }, { kind: 'scroll_wheel' }], '贪心最长词解析（click 不拆 click_mouse）');
  assert.ok(mapped[0].world && mapped[0].world.seed! >= 0, '派生冻结世界参数合法');
  const pr = computeDreamPriority(mapped[0], { now: 1000 });
  assert.ok(Number.isFinite(pr.p), `映射轨迹优先级有限（${pr.p}）`);
  assert.ok(dreamBatchWatermark(mapped).startsWith('dream-'), '批次水位线铸形');
});

// ─── D8：梦回放独立水位线（幂等律不破） ───

test('D8: 水位线幂等 —— 主水位线不动整轮 noop；失败集不动梦拦下；新失败再回放；跨进程同律', async () => {
  resetSleepCycle(); // 梦水位线是模块级内存账 —— 跨测试隔离（新进程模拟）
  const dir = mkdtempSync(join(tmpdir(), 'w5dream-d8-'));
  try {
    const trace = join(dir, 'sleep.jsonl');
    const entries = [entry('d8h-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')];
    let failures: unknown[] = [traj({ id: 'd8f1' })];
    const deps = (): SleepDeps => ({
      journal: fakeJournal(entries),
      dream: { failures: () => failures, budget: { maxDreams: 1, maxStepsPerDream: 10 } },
      log: () => {},
    });

    // 一睡：梦回放一次，trace 落梦水位线
    const r1 = await runSleepCycle(deps(), { sleepTracePath: trace, now: tickClock().now });
    assert.equal(r1.dream?.replayed, 1, '首轮实梦');

    // 二睡（同 journal 状态）：整轮 noop（既有主水位线律不破 —— 梦也不重跑）
    const r2 = await runSleepCycle(deps(), { sleepTracePath: trace, now: tickClock().now });
    assert.ok(r2.acts.every(a => a.status === 'noop'), '主水位线未动 ⇒ 六幕全 noop');
    assert.equal(r2.dream, undefined, 'noop 轮不带梦摘要（零新增严格义）');

    // 三睡（journal 前进、失败集不动）：实睡但梦被独立水位线拦下（防重复回放）
    entries.push(entry('d8h-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'));
    const r3 = await runSleepCycle(deps(), { sleepTracePath: trace, now: tickClock().now });
    assert.ok(r3.acts.every(a => a.status === 'ok' || a.status === 'skipped'), '主水位线动 ⇒ 实睡（非 noop；缺席 deps 照常 skipped）');
    assert.ok(!r3.acts.every(a => a.status === 'noop'), '绝非 noop 轮');
    assert.equal(r3.dream?.replayed, 0, '失败集未动 ⇒ 梦零回放');
    assert.ok((r3.dream?.note ?? '').includes('水位线未动'), '梦独立水位线注记在案');

    // 四睡（新失败入集）：梦再回放（新失败值得第二次机会）
    failures = [traj({ id: 'd8f1' }), traj({ id: 'd8f2', sceneHash: 'scene-new-002' })];
    entries.push(entry('d8h-ccccccccccccccccccccccccccccccc'));
    const r4 = await runSleepCycle(deps(), { sleepTracePath: trace, now: tickClock().now });
    assert.equal(r4.dream?.replayed, 1, '失败集前移 ⇒ 再梦（maxDreams=1 取最高优先）');
    assert.notEqual(r4.dream?.watermark, r1.dream?.watermark, '梦水位线随失败集前移');

    // 跨进程：内存清零（新进程）+ trace 尾行恢复梦水位线 ⇒ journal 再动仍拦
    resetSleepCycle();
    entries.push(entry('d8h-dddddddddddddddddddddddddddddddd'));
    const r5 = await runSleepCycle(deps(), { sleepTracePath: trace, now: tickClock().now });
    assert.equal(r5.dream?.replayed, 0, 'trace 尾行是有效的跨进程梦水位线');
    assert.ok((r5.dream?.note ?? '').includes('水位线未动'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── D9：睡满复合幕的水位线与既有六幕形状（形状回归卫兵） ───

test('D9: 形状卫兵 —— 梦在场时六幕形状/幕序不变；晨报行可解析；重放不触生产进化单例', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'w5dream-d9-'));
  try {
    const trace = join(dir, 'sleep.jsonl');
    const prodKernel = JSON.stringify(kernelRegistry.list());
    const report: SleepReport = await runSleepCycle(
      {
        journal: fakeJournal([entry('d9h-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')]),
        dream: { failures: () => [traj(), traj({ id: 'x2', sceneHash: 's2' })], budget: { maxDreams: 2, maxStepsPerDream: 6 } },
        log: () => {},
      },
      { sleepTracePath: trace, now: tickClock().now },
    );
    assert.deepEqual(
      report.acts.map(a => a.name),
      ['replay', 'distill', 'immune', 'calibrate', 'audit', 'report'],
      '六幕幕序不因梦在场而变（ΝΩ-34：梦在 audit 与 report 之间迟到演出，不占幕名）',
    );
    assert.ok(report.dream && report.dream.replayed >= 1, '至少一条梦真实回放');
    assert.equal(JSON.stringify(kernelRegistry.list()), prodKernel, '全程生产 kernel 注册表逐字节不变（隔离铁律）');
    const lines = readFileSync(trace, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, '一轮睡眠一行晨报');
    const parsed = JSON.parse(lines[0]);
    assert.ok(parsed.dream.entries.every((e: { priority: number }) => Number.isFinite(e.priority)), '行内梦条目优先级全有限');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── D10（ΑΩ-R40）：条间预算感知选梦 —— 预算现实主义 ───

/** ΑΩ-R40 预算假钟：now 每读一次走 costPerRead()；剩余预算 = cap − 已流时间
 *（读数面直读 elapsed 不额外 tick —— 估计/预算账目可精确断言） */
function budgetedClock(capMs: number, costPerRead: () => number): { now: () => number; overBudget: () => boolean } {
  let elapsed = 0;
  const now = (): number => 5_000_000 + (elapsed += costPerRead());
  const overBudget = (): boolean => elapsed > capMs;
  (overBudget as (() => boolean) & { remainingMs?: () => number }).remainingMs = (): number => capMs - elapsed;
  return { now, overBudget };
}

test('D10: 预算感知选梦 —— 小预算选短梦/零梦诚实收场；大预算 PER 序；期望步数证据链', async () => {
  resetDreamCostLedger(); // 冷启动（模块级账本 —— 跨测试隔离）

  // 长/短两条轨迹：长梦 PER 更高（惊异更大），短梦失败步数更少
  const long = traj({ id: 'long', surpriseBits: 16, stepsWasted: 20, sceneHash: 'd10-long' });
  const short = traj({ id: 'short', surpriseBits: 2, stepsWasted: 2, sceneHash: 'd10-short' });
  const pLong = computeDreamPriority(long, { now: 5000 }).p;
  const pShort = computeDreamPriority(short, { now: 5000 }).p;
  assert.ok(pLong > pShort, `长梦 PER 更高（${pLong} > ${pShort}）—— 选短不是选低分的前提`);

  // 期望步数证据链：stepsWasted 优先 > history 回落 > 先验兜底；钳到步上限
  assert.equal(dreamExpectedSteps(long, 8), 8, 'stepsWasted=20 钳到 maxSteps=8');
  assert.equal(dreamExpectedSteps(short, 8), 2, 'stepsWasted=2 原样');
  assert.equal(
    dreamExpectedSteps(traj({ stepsWasted: undefined, history: [{ kind: 'click' }, { kind: 'click' }, { kind: 'click' }] }), 8),
    3, 'history 回落（无 stepsWasted 时取决策对照面长度）',
  );
  assert.equal(dreamExpectedSteps(traj({ stepsWasted: undefined, history: [] }), 8), PER_WEIGHTS.stepsWastedPrior, '先验兜底');
  assert.equal(dreamExpectedSteps(traj({ stepsWasted: 99 }), 5), 5, '钳到步上限（垃圾大步数不虚增估计）');

  // 选梦纯函数面：无读数 ⇒ 纯 PER 序；队首装不下 ⇒ 装得下的最短者；全装不下 ⇒ -1
  const est = (steps: number): number => steps * DREAM_COST_ESTIMATOR.coldStepMs;
  assert.deepEqual(pickDreamByBudget([{ t: long, p: pLong }, { t: short, p: pShort }], null, est, 8), { index: 0, mode: 'per' }, '无读数面 ⇒ 队首（既有行为）');
  assert.deepEqual(pickDreamByBudget([{ t: long, p: pLong }, { t: short, p: pShort }], 400, est, 8), { index: 0, mode: 'per' }, '队首装得下 ⇒ PER 序');
  assert.deepEqual(pickDreamByBudget([{ t: long, p: pLong }, { t: short, p: pShort }], 160, est, 8), { index: 1, mode: 'short' }, '队首装不下 ⇒ 最短可行者');
  assert.deepEqual(pickDreamByBudget([{ t: long, p: pLong }, { t: short, p: pShort }], 30, est, 8), { index: -1, mode: 'none' }, '全装不下 ⇒ 诚实收场');
  assert.deepEqual(pickDreamByBudget([], 100, est, 8), { index: -1, mode: 'none' }, '空池 ⇒ none');

  // (a) 小预算：冷启动估计下队首（8 步 × 40ms = 320ms）装不下 ⇒ 选短梦（2 步 × 40ms = 80ms ≤ 160ms）
  const clock200 = budgetedClock(200, () => 40);
  const tight = await runDreamReplay({
    trajectories: dreamTrajectories([long, short]),
    now: clock200.now,
    overBudget: clock200.overBudget,
    budget: { maxDreams: 1, maxStepsPerDream: 8 },
  });
  assert.equal(tight.report.replayed, 1, '小预算仍完成一条（短梦让位长梦）');
  assert.equal(tight.report.entries[0].id, 'short', '选中的是短梦而非 PER 更高的长梦');
  assert.equal(tight.report.entries[0].pick, 'short', '预算感知选短标记在案（审计面）');
  assert.equal(tight.report.entries.length, 1, 'maxDreams=1 ⇒ 一条占位');

  // (b) 更小预算：最短梦也装不下 ⇒ 零梦诚实收场（逐条注记 + truncated/time）
  resetDreamCostLedger();
  const clock45 = budgetedClock(45, () => 10);
  const starved = await runDreamReplay({
    trajectories: dreamTrajectories([long, short]),
    now: clock45.now,
    overBudget: clock45.overBudget,
    budget: { maxDreams: 2, maxStepsPerDream: 8 },
  });
  assert.equal(starved.report.replayed, 0, '剩余 35ms < 最短估计 80ms ⇒ 零梦');
  assert.equal(starved.report.entries.length, 2, '每条候选都带诚实注记');
  assert.ok(starved.report.entries.every(e => !e.replayed && (e.note ?? '').includes('不足以完成')), '注记含估计 vs 剩余的量化对照');
  assert.equal(starved.report.budget.truncated, true);
  assert.equal(starved.report.budget.reason, 'time');

  // (c) 大预算：长短皆按 PER 序（预算充裕 ⇒ 零漂移）
  resetDreamCostLedger();
  const clockBig = budgetedClock(100_000, () => 10);
  const ample = await runDreamReplay({
    trajectories: dreamTrajectories([long, short]),
    now: clockBig.now,
    overBudget: clockBig.overBudget,
    budget: { maxDreams: 2, maxStepsPerDream: 8 },
  });
  assert.equal(ample.report.replayed, 2);
  assert.deepEqual(ample.report.entries.map(e => e.id), ['long', 'short'], '大预算 ⇒ PER 序（长在前）');
  assert.ok(ample.report.entries.every(e => e.pick === undefined), '无让位标记（纯 PER 序）');
  assert.equal(ample.report.budget.truncated, false);
  assert.equal(ample.report.budget.reason, 'none');
});

test('D10b: 耗时估计收敛 —— EMA 账本随注入时钟收敛；收敛后冷启动会弃的预算放行；dep 直投读数面', async () => {
  // 批一：微型耗时（每读 1ms ⇒ 单梦实测 1ms）—— 冷启动入账
  resetDreamCostLedger();
  let perRead = 1;
  const clock = budgetedClock(10_000, () => perRead);
  const w1 = await runDreamReplay({
    trajectories: dreamTrajectories([traj({ id: 'w1', sceneHash: 'd10-w1' })]),
    now: clock.now,
    overBudget: clock.overBudget,
    budget: { maxDreams: 1, maxStepsPerDream: 8 },
  });
  assert.equal(w1.report.replayed, 1);
  const n1 = w1.report.entries[0].replay?.steps ?? 1;
  const led1 = readDreamCostLedger();
  assert.equal(led1.perDreamMs, 1, '首梦实测 1ms 入账（零差样本之外的第一手）');
  assert.ok(Math.abs((led1.perStepMs ?? 0) - 1 / n1) < 1e-9, `每步均值 = 1ms/${n1} 步`);

  // 批二：重耗时（每读 60ms）—— EMA（α=0.5）半新半旧走到新水平的一半路程
  perRead = 60;
  const w2 = await runDreamReplay({
    trajectories: dreamTrajectories([traj({ id: 'w2', sceneHash: 'd10-w2' })]),
    now: clock.now,
    overBudget: clock.overBudget,
    budget: { maxDreams: 1, maxStepsPerDream: 8 },
  });
  assert.equal(w2.report.replayed, 1);
  const n2 = w2.report.entries[0].replay?.steps ?? 1;
  const led2 = readDreamCostLedger();
  assert.ok(Math.abs((led2.perDreamMs ?? 0) - 30.5) < 1e-9, `单梦 EMA = 0.5×1 + 0.5×60 = 30.5（实得 ${led2.perDreamMs}）`);
  assert.ok(Math.abs((led2.perStepMs ?? 0) - (0.5 / n1 + 30 / n2)) < 1e-9, '每步 EMA 同律收敛');

  // 行为收敛：收敛后估计（≈8×perStepMs）放行的预算，冷启动估计（8×40=320ms）会拒绝
  const convergedEst = (led2.perStepMs ?? DREAM_COST_ESTIMATOR.coldStepMs) * 8;
  const cap3 = Math.min(300, Math.ceil(convergedEst) + 40);
  assert.ok(DREAM_COST_ESTIMATOR.coldStepMs * 8 > cap3, `冷启动估计 320ms > cap ${cap3}ms（冷启动会弃梦）`);
  const clock3 = budgetedClock(cap3, () => 1);
  const w3 = await runDreamReplay({
    trajectories: dreamTrajectories([traj({ id: 'w3', sceneHash: 'd10-w3', stepsWasted: 20 })]),
    now: clock3.now,
    overBudget: clock3.overBudget,
    budget: { maxDreams: 1, maxStepsPerDream: 8 },
  });
  assert.equal(w3.report.replayed, 1, '估计收敛 ⇒ 冷启动会拒绝的预算现在放行（预算现实主义的收益面）');

  // dep 直投读数面（remainingBudgetMs 显式通道）+ 恒时钟零差样本不入账
  resetDreamCostLedger();
  const longB = traj({ id: 'longB', surpriseBits: 16, stepsWasted: 20, sceneHash: 'd10-longb' });
  const tiny = traj({ id: 'tiny', stepsWasted: 1, sceneHash: 'd10-tiny' });
  const viaDep = await runDreamReplay({
    trajectories: dreamTrajectories([longB, tiny]),
    now: () => 5000,
    overBudget: () => false,
    remainingBudgetMs: () => 50,
    budget: { maxDreams: 1, maxStepsPerDream: 8 },
  });
  assert.equal(viaDep.report.replayed, 1);
  assert.equal(viaDep.report.entries[0].id, 'tiny', 'dep 读数面同律：长梦估 320ms > 50ms ⇒ 选 tiny（估 40ms）');
  assert.equal(viaDep.report.entries[0].pick, 'short');
  assert.equal(readDreamCostLedger().perDreamMs, null, '恒时钟零差样本不入账（不污染估计）');
});

test('D10c: 集成小预算 —— runSleepCycle 预算紧 ⇒ 梦零回放诚实收场（六幕照常）', async () => {
  resetSleepCycle();
  resetDreamCostLedger();
  const dir = mkdtempSync(join(tmpdir(), 'w5dream-d10-'));
  try {
    const trace = join(dir, 'sleep.jsonl');
    const r = await runSleepCycle(
      {
        journal: fakeJournal([entry('d10h-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')]),
        dream: {
          failures: () => [traj(), traj({ id: 't2', stepsWasted: 1, sceneHash: 'd10s' })],
          budget: { maxDreams: 2, maxStepsPerDream: 8 },
        },
        log: () => {},
      },
      { sleepTracePath: trace, now: tickClock().now, budgetMs: 60 },
    );
    assert.ok(r.dream, '梦摘要在场（dep 在场）');
    assert.equal(r.dream!.replayed, 0, '60ms 预算 + 冷启动保守估计 ⇒ 零梦（名存实亡不如诚实缺席）');
    assert.equal(r.dream!.entries.length, 2, '两条候选各带注记');
    // ΝΩ-34 移序立法的账面变化：梦迟到演出（audit 之后）时预算已被维护四幕吃满
    // ⇒ 走 overBudget 的「预算耗尽」臂（本测试 +10 假钟下 d.now 预读已越线）；
    // 「不足以完成（估计 vs 剩余）」的量化臂由 D10 直投 runDreamReplay 面覆盖
    assert.ok(r.dream!.entries.every(e => !e.replayed && (e.note ?? '').includes('预算耗尽')), '未回放注记在案（预算耗尽臂）');
    assert.equal(r.dream!.budget.reason, 'time');
    assert.deepEqual(
      r.acts.map(a => a.name),
      ['replay', 'distill', 'immune', 'calibrate', 'audit', 'report'],
      '六幕幕序不因预算感知选梦而变（ΝΩ-34：梦在 audit 与 report 之间迟到演出，不占幕名）',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── D10d（ΝΩ-34 梦回放移序立法）：小预算下校准/审计先吃预算，不再恒 timeout 饿死 ───

test('D10d（ΝΩ-34）: 小预算 + 梦在场 —— 维护四幕先吃预算（calibrate/audit 实跑）；梦诚实饿死不占幕名', async () => {
  resetSleepCycle();
  resetDreamCostLedger();
  const dir = mkdtempSync(join(tmpdir(), 'w5dream-d10d-'));
  try {
    const trace = join(dir, 'sleep.jsonl');
    let calTicks = 0;
    let audits = 0;
    const fakeAudit: SleepDeps['selfAudit'] = steps => {
      audits++;
      assert.ok(Array.isArray(steps), '审计面收到 StepRecord 轨迹');
      return { verdict: 'healthy', findings: [], score: 100, advice: [] };
    };
    const r = await runSleepCycle(
      {
        journal: fakeJournal([entry('d10dh-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')]),
        calibrator: {
          tick: () => {
            calTicks++;
            return [{ key: 'popup.offThreshold', from: 0.35, to: 0.37, reason: 'optimal-threshold', generation: 2 }];
          },
        },
        selfAudit: fakeAudit,
        dream: {
          failures: () => [traj(), traj({ id: 't2', stepsWasted: 1, sceneHash: 'd10d' })],
          budget: { maxDreams: 2, maxStepsPerDream: 8 },
        },
        log: () => {},
      },
      { sleepTracePath: trace, now: tickClock().now, budgetMs: 60 },
    );
    const byName = Object.fromEntries(r.acts.map(a => [a.name, a]));
    // 立法前（梦寄居第①幕）：60ms 预算被梦吃满 ⇒ calibrate/audit 恒 timeout 饿死；
    // 立法后：维护四幕先吃预算 —— 校准/审计真实演出（假钟 +10/读、预算 60ms 下
    // 五道幕闸共耗 50ms 仍在其内），梦在 audit 后迟到演出、剩余不足 ⇒ 诚实饿死
    assert.equal(byName.calibrate.status, 'ok', '校准幕先吃预算（不再恒 timeout）');
    assert.equal(calTicks, 1, 'calibrator.tick 真被调（不是 skipped/timeout 的空占位）');
    assert.equal(byName.audit.status, 'ok', '审计幕先吃预算（不再恒 timeout）');
    assert.equal(audits, 1, 'selfAudit 真被调');
    assert.ok(r.dream, '梦摘要在场（dep 在场）');
    assert.equal(r.dream!.replayed, 0, '剩余预算不足以装下最短梦 ⇒ 零回放（宁短勿挂）');
    assert.ok(r.dream!.entries.every(e => e.perWeight === undefined && e.cfLedger === undefined),
      '饿死条目不带 perWeight/cfLedger（未双写 —— 备账面零伪造）');
    assert.equal(byName.report.status, 'timeout', '梦后剩余预算耗尽 ⇒ 晨报幕标 timeout（半程报告照铸的既有立法）');
    assert.deepEqual(
      r.acts.map(a => a.name),
      ['replay', 'distill', 'immune', 'calibrate', 'audit', 'report'],
      '六幕幕序不变（梦不占幕名 —— ΝΩ-34 移序只动演出位，不动幕表）',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── D11（ΝΩ-34）：梦水位线策略指纹 + perWeight 批内归一 + dream.cf 分桶键 ───

test('D11（ΝΩ-34）: 策略指纹水位线 —— 显著进化允许重梦；同策略同失败集仍去重；网格内微漂不算变', async () => {
  // 纯函数面：指纹网格（η=0.05 单步恰一格 —— 网格内微漂同指纹，跨格换指纹）
  assert.equal(policyFingerprintOf({ click: 1, scroll: 1 }), policyFingerprintOf({ scroll: 1, click: 1 }), '键序无关');
  assert.equal(policyFingerprintOf({ click: 1 }), policyFingerprintOf({ click: 1 + POLICY_FINGERPRINT_GRID * 0.4 }), '网格内微漂 ⇒ 同指纹');
  assert.notEqual(policyFingerprintOf({ click: 1 }), policyFingerprintOf({ click: 1 + POLICY_FINGERPRINT_GRID }), '跨格 ⇒ 换指纹（策略显著变化）');
  assert.equal(policyFingerprintOf(null), 'void', '垃圾 ⇒ void');
  assert.equal(policyFingerprintOf({ click: Number.NaN }), 'void', '非有限值键跳过 ⇒ 空指纹');

  // 水位线的策略分量：同失败集同指纹同水位线（去重）；异指纹异水位线（重梦资格）
  const batch = [traj({ id: 'd11f' })];
  assert.equal(dreamBatchWatermark(batch, 'h1'), dreamBatchWatermark(batch, 'h1'), '同策略 ⇒ 同水位线');
  assert.notEqual(dreamBatchWatermark(batch, 'h1'), dreamBatchWatermark(batch, 'h2'), '策略变 ⇒ 水位线动');

  // 集成面：恒定策略假件（heuristics 恒 1.0 —— ingest 不动权重表）⇒ 同失败集二梦被拦
  const calmFace = {
    greedyArm: () => 'click',
    armProbabilities: (): Record<string, number> => ({ click: 1 }),
    ingest: () => {},
    heuristics: (): Record<string, number> => ({ scroll: 1, inspect: 1, ask_vlm: 1, recall_skill: 1, click: 1 }),
  };
  const run = (evolution: unknown, priorWatermark?: string): ReturnType<typeof runDreamReplay> =>
    runDreamReplay({
      trajectories: dreamTrajectories([traj({ id: 'd11f', sceneHash: 'd11-s1' })]),
      now: () => 5000,
      overBudget: () => false,
      evolution: evolution as never,
      budget: { maxDreams: 1, maxStepsPerDream: 10 },
      // 直投面：水位线由调用方回灌（集成面经 trace 尾行/内存账自动流转）
      priorWatermark,
    });
  const once = await run(calmFace);
  assert.equal(once.report.replayed, 1, '首轮实梦');
  assert.equal(once.report.entries[0].perWeight, 1, '单条批次 p=mean(p) ⇒ perWeight=1');
  const again = await run(calmFace, once.report.watermark);
  assert.equal(again.report.replayed, 0, '同策略同失败集 ⇒ 去重（水位线拦下）');
  assert.ok((again.report.note ?? '').includes('水位线未动'), '去重注记在案');

  // 策略显著进化（click 1.0 → 1.1：成功奖励 +0.1 跨两格）⇒ 同失败集允许重梦
  const evolvedFace = { ...calmFace, heuristics: (): Record<string, number> => ({ scroll: 1, inspect: 1, ask_vlm: 1, recall_skill: 1, click: 1.1 }) };
  const redream = await run(evolvedFace, once.report.watermark);
  assert.equal(redream.report.replayed, 1, '策略显著变化 ⇒ 同失败集重梦（旧梦结局已过时）');

  // 真引擎对照：一条成功运行入史 ⇒ heuristics 权重跨格 ⇒ 指纹换（策略真的在进化）
  const engine = new EvolutionEngine({ seed: 21 });
  const fpBefore = policyFingerprintOf(engine.heuristics());
  engine.ingest({ goal: '对照', success: true, steps: 2, durationMs: 1, strategies: ['click'] });
  assert.notEqual(policyFingerprintOf(engine.heuristics()), fpBefore, '真引擎 heuristics 进化 ⇒ 指纹换');
});

test('D11b（ΝΩ-34）: perWeight 批内归一（均值 1）+ dream.cf 分桶（病因桶/世界指纹桶）', async () => {
  // 两条皆分歧的轨迹：p_hi ≠ p_lo ⇒ perWeight = p/mean(p)（手算对照 + 批均值 1）
  const hi = traj({ id: 'hi', surpriseBits: 16, stepsWasted: 20, sceneHash: 'd11b-hi' });
  const lo = traj({ id: 'lo', surpriseBits: 2, stepsWasted: 2, sceneHash: 'd11b-lo' });
  const res = await runDreamReplay({
    trajectories: dreamTrajectories([hi, lo]),
    now: () => 5000,
    overBudget: () => false,
    budget: { maxDreams: 2, maxStepsPerDream: 8 },
  });
  assert.equal(res.report.replayed, 2, '两条皆回放');
  assert.ok(res.report.entries.every(e => e.replay?.divergence !== null), '两条皆分歧（perWeight 的注记门槛）');
  const pHi = computeDreamPriority(hi, { now: 5000 }).p;
  const pLo = computeDreamPriority(lo, { now: 5000 }).p;
  assert.ok(pHi > pLo, `高惊异 PER 更高（${pHi} > ${pLo}）—— 权重分化前提`);
  const mean = (pHi + pLo) / 2;
  const eHi = res.report.entries.find(e => e.id === 'hi')!;
  const eLo = res.report.entries.find(e => e.id === 'lo')!;
  assert.ok(eHi.perWeight !== undefined && eLo.perWeight !== undefined, '分歧双写条目携带 perWeight');
  assert.equal(eHi.perWeight, Math.round((pHi / mean) * 1e6) / 1e6, 'w_hi = p_hi/mean(p)（手算对照）');
  assert.equal(eLo.perWeight, Math.round((pLo / mean) * 1e6) / 1e6, 'w_lo = p_lo/mean(p)（手算对照）');
  assert.ok(Math.abs((eHi.perWeight! + eLo.perWeight!) / 2 - 1) < 1e-6, '批内归一：权重均值 = 1');

  // 无 rootCause ⇒ 世界指纹桶；键与梦侧注记一致；margin 通道空
  assert.equal(eHi.cfLedger?.key, dreamCfKey(undefined, eHi.world.fingerprint), 'cfLedger 键 = 世界指纹桶');
  assert.ok((eHi.cfLedger?.key ?? '').startsWith('dream.cf:w:'), '世界桶词头在案');
  assert.deepEqual(res.lab!.ledger.stats(eHi.cfLedger!.key).margins, [], '世界桶 margin 通道空（步序≠裕量）');

  // 有 rootCause ⇒ 病因桶（与 EXP4 failureCluster 同源词表）：异病因异桶
  const rc1 = traj({ id: 'rc1', rootCause: 'stall', sceneHash: 'd11b-rc1' });
  const rc2 = traj({ id: 'rc2', rootCause: 'timeout', sceneHash: 'd11b-rc2' });
  const rcRun = await runDreamReplay({
    trajectories: dreamTrajectories([rc1, rc2]),
    now: () => 5000,
    overBudget: () => false,
    budget: { maxDreams: 2, maxStepsPerDream: 8 },
  });
  const eRc1 = rcRun.report.entries.find(e => e.id === 'rc1')!;
  const eRc2 = rcRun.report.entries.find(e => e.id === 'rc2')!;
  assert.equal(eRc1.cfLedger?.key, 'dream.cf:rc:stall', '病因桶：rootCause 入键');
  assert.equal(eRc2.cfLedger?.key, 'dream.cf:rc:timeout', '异病因异桶（滑窗不再混装）');
  assert.equal(rcRun.lab!.ledger.stats('dream.cf:rc:stall').n, 1, '病因桶各自入账一条');
  assert.equal(rcRun.lab!.ledger.stats('dream.cf:rc:timeout').n, 1, '病因桶各自入账一条（对照）');
  // 分桶纯函数边界：rootCause 空白/超长；世界指纹缺席
  assert.equal(dreamCfKey('   ', 'fp'), 'dream.cf:w:fp', '空白病因 ⇒ 回落世界桶');
  assert.equal(dreamCfKey('x'.repeat(80), ''), 'dream.cf:rc:' + 'x'.repeat(40), '病因截 40');
  assert.equal(dreamCfKey(undefined, ''), 'dream.cf:w:void', '双缺席 ⇒ void 桶（键恒非空）');
});
