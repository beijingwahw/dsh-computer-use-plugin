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

  // (a) kernel 证据：现有 lab 记账通道 —— runPcgWorld 的 Θ-3 记账 + 分歧结局补记
  const lab = res.lab;
  assert.ok(lab, '梦训练营实验室在场（隔离自铸）');
  assert.notEqual(lab!.registry, kernelRegistry as unknown, '实验室注册表绝非遗漏生产单例');
  const cf = lab!.ledger.stats('dream.counterfactual');
  assert.equal(cf.n, 1, '分歧结局入账一条');
  assert.deepEqual(cf.margins, [0], 'margin = 分歧步序');
  assert.ok(res.report.kernelEvidence.some(k => k.key === 'dream.counterfactual'), '报告携带 kernel 证据对账面');
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
  assert.equal(noDiv.lab!.ledger.stats('dream.counterfactual').n, 0, '无分歧批次零 dream.counterfactual 入账');
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
      '六幕幕序不因梦在场而变',
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
