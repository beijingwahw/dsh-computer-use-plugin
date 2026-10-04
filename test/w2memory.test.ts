// test/w2memory.test.ts
// W2-6（M5 分类级记忆操作 Thompson 老虎机）：Beta 更新手算 / 分类别独立记账 /
// n<门限零行为变化 / 阈值夹取 / seed 重放一致 / registry 键注册 + EvidenceLedger
// 记账 / 既有 58 键语义不动（ΝΩ-10 增三键）/ 奖励收割手算 / 防御式绝不抛。
// 全离线纯内存断言，零网络零墙钟依赖（时间戳全部显式注入）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KernelRegistry, EvidenceLedger, resetKernelRuntime, kernelRegistry, evidenceLedger,
} from '../src/kernel/registry.ts';
import { registerProductionKernels } from '../src/kernel/index.ts';
import {
  MEMORY_OP_CATEGORIES, MEMORY_OP_KINDS, MEMORY_OP_FEEDBACK_GATE,
  memoryOpKey, memoryOpSpecs, memoryOpSpecOf, registerMemoryOpKernels,
  seededRng, betaPosterior, betaPosteriorFromStats, betaSample,
  evaluateMemoryOpSuccess, harvestMemoryOpRewards, DEFAULT_REWARD_WINDOW_MS,
  recordMemoryOpFeedback, applyHarvestedRewards, compareHelpedCohorts,
  decideMemoryOpThreshold, thresholdFromSample, convergeMemoryOps,
  type CategoryTrials,
} from '../src/knowledge/memoryOps.ts';
import type { KnowledgeCategory, KnowledgeEntry } from '../src/knowledge/contracts.ts';
import type { RunMetricRecord } from '../src/knowledge/metrics.ts';

/** 测试工厂：知识条目（全部字段显式 —— 零隐式缺省） */
function entry(over: Partial<KnowledgeEntry> & Pick<KnowledgeEntry, 'category' | 'updatedAt' | 'usageCount'>): KnowledgeEntry {
  return {
    id: `e-${Math.random().toString(36).slice(2, 8)}`,
    content: '测试条目', scenario: '测试场景', confidence: 0.6, source: 'auto-learn',
    ...over,
  };
}

/** 测试工厂：run 指标记录 */
function run(over: Partial<RunMetricRecord>): RunMetricRecord {
  return {
    ts: 1_000_000, intentId: 'i-1', verdict: 'completed', rounds: 3, executions: 1,
    durationMs: 500, l3Rounds: 1, knowledgeRounds: 1, knowledgeEntries: 2,
    worldTypes: 1, worldObservations: 3, consolidated: 0,
    ...over,
  };
}

/** 隔离夹具：一对全新 (registry, ledger) —— 本文件绝大多数用例不走生产单例 */
function freshPair(): { registry: KernelRegistry; ledger: EvidenceLedger } {
  return { registry: new KernelRegistry(), ledger: new EvidenceLedger() };
}

// ─── W2-6a registry 键注册：28 臂入册 / 规格区间 / 幂等 / 既有 58 键不动 ───

test('W2-6a registry 注册：28 键（7 类 × 4 操作）入册，区间与缺省 = 现行静态常数', () => {
  const { registry } = freshPair();
  const n = registerMemoryOpKernels(registry);
  assert.equal(n, 28);
  assert.equal(registry.list().length, 28, '全新注册表恰好 28 键');
  // 抽查规格：defaultValue = 消费点现行字面量（零行为变化的锚）
  const boost = registry.list().find(p => p.key === 'memory.op.workflow.boost');
  assert.ok(boost);
  assert.equal(boost.defaultValue, 0.3, 'boost 缺省 = P.REINFORCE_STEP 现行字面量');
  assert.equal(boost.min, 0.2);
  assert.equal(boost.max, 1.0);
  assert.equal(boost.organ, 'knowledge');
  assert.equal(boost.value, 0.3, '首册 value = defaultValue（零行为）');
  const insert = memoryOpSpecOf('memory.op.error-pattern.insert');
  assert.ok(insert);
  assert.equal(insert.defaultValue, 0.3, 'insert 缺省 = AUTO_LEARN_FAILURE_CONFIDENCE');
  assert.deepEqual([insert.min, insert.max], [0.1, 0.6]);
  const noop = memoryOpSpecOf('memory.op.preference.noop');
  assert.ok(noop);
  assert.equal(noop.defaultValue, 0.2, 'noop 缺省 = P.VERIFY_TRUST_FLOOR');
  assert.deepEqual([noop.min, noop.max], [0.2, 0.65]);
  // 键序确定性（重放的轴）：分类学序 × 操作序
  assert.deepEqual(
    memoryOpSpecs().map(s => s.key).slice(0, 4),
    MEMORY_OP_KINDS.map(op => memoryOpKey('ui-pattern', op)),
  );
  assert.equal(memoryOpSpecOf('memory.op.bogus.insert'), null, '词表外键查表 null');
});

test('W2-6a 幂等：重入册保持现值与证据，只刷规格；set 过的值不被重置', () => {
  const { registry, ledger } = freshPair();
  registerMemoryOpKernels(registry);
  registry.set('memory.op.shortcut.evict', 0.2);
  registry.addEvidence('memory.op.shortcut.evict');
  registerMemoryOpKernels(registry); // 重入
  const p = registry.list().find(x => x.key === 'memory.op.shortcut.evict');
  assert.ok(p);
  assert.equal(p.value, 0.2, '幂等重注册不动现值');
  assert.equal(p.evidence, 1, '证据原样继承');
  assert.equal(ledger.stats('memory.op.shortcut.evict').n, 0, '入册不碰账本');
});

test('W2-6a 既有 58 键语义不动：增量入册后生产键值逐字节不变', () => {
  resetKernelRuntime();
  try {
    registerProductionKernels();
    const before = kernelRegistry.snapshot();
    assert.equal(Object.keys(before).length, 58, '生产单册基线 58 键（55+ΝΩ-10 三键）');
    const count = registerMemoryOpKernels();
    assert.equal(count, 28);
    const after = kernelRegistry.snapshot();
    assert.equal(Object.keys(after).length, 86, '58 + 28 = 86');
    for (const [k, v] of Object.entries(before)) {
      assert.equal(after[k], v, `既有键 ${k} 语义不动`);
    }
    assert.equal(memoryOpSpecOf('world.hammingTolerance'), null, '既有键不在 memory.op 词表');
  } finally {
    resetKernelRuntime();
  }
});

// ─── W2-6b Beta 更新数值（手算例）与奖励函数手算 ───

test('W2-6b Beta 后验手算：Beta(1,1) 先验 + 6 成 4 败 ⇒ Beta(7,5)，均值 7/12、众数 0.6', () => {
  const post = betaPosterior(6, 4);
  assert.equal(post.alpha, 7);
  assert.equal(post.beta, 5);
  assert.ok(Math.abs(post.alpha / (post.alpha + post.beta) - 7 / 12) < 1e-12, '后验均值 = 7/12 ≈ 0.5833');
  assert.ok(Math.abs((post.alpha - 1) / (post.alpha + post.beta - 2) - 0.6) < 1e-12, '后验众数 = 6/10');
  // 零数据 ⇒ 先验本身（均匀）
  assert.deepEqual(betaPosterior(0, 0), { alpha: 1, beta: 1 });
  // 账本统计恢复整数成败：n=10、rate=0.6 ⇒ s=6、f=4 ⇒ Beta(7,5)
  assert.deepEqual(betaPosteriorFromStats(10, 0.6), { alpha: 7, beta: 5 });
  assert.deepEqual(betaPosteriorFromStats(0, 0), { alpha: 1, beta: 1 });
  // 垃圾输入按零数据论（先验 —— 绝不抛、绝不 NaN）
  assert.deepEqual(betaPosteriorFromStats(NaN, NaN), { alpha: 1, beta: 1 });
  assert.deepEqual(betaPosterior(-5, Number.NaN), { alpha: 1, beta: 1 });
});

test('W2-6b 奖励判定真值表：success = 命中 ∧ 助益', () => {
  assert.equal(evaluateMemoryOpSuccess(true, true), true);
  assert.equal(evaluateMemoryOpSuccess(true, false), false, '命中但无助益 ⇒ 败');
  assert.equal(evaluateMemoryOpSuccess(false, true), false, '助益但未命中 ⇒ 败');
  assert.equal(evaluateMemoryOpSuccess(false, false), false);
});

test('W2-6b 奖励收割手算：7 天窗口内逐条目伯努利试验，窗口外与垃圾静默跳过', () => {
  const NOW = 10_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;
  const entries = [
    entry({ category: 'workflow', updatedAt: NOW - DAY, usageCount: 3 }),        // 命中
    entry({ category: 'workflow', updatedAt: NOW - 2 * DAY, usageCount: 0 }),    // 未命中
    entry({ category: 'error-pattern', updatedAt: NOW - DAY, usageCount: 1 }),   // 命中
    entry({ category: 'workflow', updatedAt: NOW - 30 * DAY, usageCount: 9 }),   // 窗口外
    entry({ category: 'system-quirk', updatedAt: NOW - DAY, usageCount: 2 }),    // 命中
  ];
  // 助益：窗口内存在 knowledgeRounds>0 且 completed 的 run
  const runs = [
    run({ ts: NOW - DAY, verdict: 'completed', knowledgeRounds: 2 }),
    run({ ts: NOW - 3 * DAY, verdict: 'failed', knowledgeRounds: 1 }),           // 未完成不算助益
    run({ ts: NOW - DAY, verdict: 'degraded', knowledgeRounds: 0 }),             // 注入缺席
  ];
  const t = harvestMemoryOpRewards(entries, runs, { now: NOW });
  assert.deepEqual(t.workflow, { successes: 1, failures: 1, entries: 2 });
  assert.deepEqual(t['error-pattern'], { successes: 1, failures: 0, entries: 1 });
  assert.deepEqual(t['system-quirk'], { successes: 1, failures: 0, entries: 1 });
  assert.deepEqual(t.preference, { successes: 0, failures: 0, entries: 0 }, '无数据类别全零账在场');
  // 无助益 run（全失败）⇒ 命中也记败（产出未变现）
  const t2 = harvestMemoryOpRewards(entries, [run({ ts: NOW - DAY, verdict: 'failed', knowledgeRounds: 3 })], { now: NOW });
  assert.deepEqual(t2.workflow, { successes: 0, failures: 2, entries: 2 });
  // 垃圾输入：不抛、全零账
  const t3 = harvestMemoryOpRewards(null, undefined, { now: NOW });
  assert.equal(t3['ui-pattern'].entries, 0);
  const t4 = harvestMemoryOpRewards([entry({ category: 'workflow', updatedAt: NaN, usageCount: 1 })] as unknown as KnowledgeEntry[], null, { now: NOW });
  assert.equal(t4.workflow.entries, 0, '时间戳畸形条目跳过');
  assert.equal(DEFAULT_REWARD_WINDOW_MS, 7 * DAY, '缺省窗口 = 7 天（M5 规格的 N）');
});

// ─── W2-6c 分类别独立记账：一臂的反馈不渗漏进他臂 ───

test('W2-6c 分类独立：error-pattern 12 胜 vs workflow 12 败，账本/证据/决策三面隔离', () => {
  const { registry, ledger } = freshPair();
  const deps = { registry, ledger };
  for (let i = 0; i < 12; i++) {
    assert.equal(recordMemoryOpFeedback('error-pattern', 'insert', true, deps).ok, true);
    assert.equal(recordMemoryOpFeedback('workflow', 'insert', false, deps).ok, true);
  }
  // 账本面：逐键独立
  const ep = ledger.stats('memory.op.error-pattern.insert');
  const wf = ledger.stats('memory.op.workflow.insert');
  assert.equal(ep.n, 12); assert.equal(ep.successRate, 1);
  assert.equal(wf.n, 12); assert.equal(wf.successRate, 0);
  // 注册表证据面：逐键独立
  const epParam = registry.list().find(p => p.key === 'memory.op.error-pattern.insert');
  const wfParam = registry.list().find(p => p.key === 'memory.op.workflow.insert');
  assert.ok(epParam && wfParam);
  assert.equal(epParam.evidence, 12);
  assert.equal(wfParam.evidence, 12);
  // 决策面：同种子流下高后验臂 ⇒ 高阈值（Beta(13,1) vs Beta(1,13)）
  const dEp = decideMemoryOpThreshold('error-pattern', 'insert', { ...deps, rng: seededRng('arm-a') });
  const dWf = decideMemoryOpThreshold('workflow', 'insert', { ...deps, rng: seededRng('arm-a') });
  assert.ok(dEp && dWf);
  assert.deepEqual([dEp.alpha, dEp.beta], [13, 1], '12 胜 0 败 ⇒ Beta(13,1)');
  assert.deepEqual([dWf.alpha, dWf.beta], [1, 13], '0 胜 12 败 ⇒ Beta(1,13)');
  assert.equal(dEp.source, 'thompson-sample');
  assert.ok(dEp.threshold > dWf.threshold, `高后验臂阈值应更高（${dEp.threshold} > ${dWf.threshold}）`);
  // 他臂零污染：第三类无反馈 ⇒ 先验 + 静态缺省
  const dPf = decideMemoryOpThreshold('preference', 'insert', deps);
  assert.ok(dPf);
  assert.deepEqual([dPf.alpha, dPf.beta], [1, 1]);
  assert.equal(dPf.threshold, 0.3, 'n=0 < 门限 ⇒ 现行静态常数');
});

// ─── W2-6d n < 门限：零行为变化（静态常数安全带）───

test('W2-6d 反馈不足：决策 = 现行静态常数；收敛 = 28 臂全员按兵不动', () => {
  const { registry, ledger } = freshPair();
  // 门限下（7 < 8）：一切操作臂保持缺省
  for (let i = 0; i < MEMORY_OP_FEEDBACK_GATE - 1; i++) {
    recordMemoryOpFeedback('shortcut', 'boost', true, { registry, ledger });
  }
  const d = decideMemoryOpThreshold('shortcut', 'boost', { registry, ledger });
  assert.ok(d);
  assert.equal(d.source, 'static-default');
  assert.equal(d.n, MEMORY_OP_FEEDBACK_GATE - 1);
  assert.equal(d.threshold, 0.3, 'n<门限 ⇒ P.REINFORCE_STEP 现行字面量');
  // 全库收敛：converged 空、held 28、注册表值全 = defaultValue
  registerMemoryOpKernels(registry);
  const report = convergeMemoryOps({ registry, ledger, seed: 'w2-gate' });
  assert.equal(report.arms, 28);
  assert.equal(report.converged.length, 0);
  assert.equal(report.held.length, 28);
  assert.ok(report.held.every(h => h.reason === 'insufficient-feedback'));
  const defaults = Object.fromEntries(memoryOpSpecs().map(s => [s.key, s.defaultValue]));
  assert.deepEqual(registry.snapshot(), defaults, '零行为变化：全键 = 静态缺省');
  // 漂移值也不读：即便注册表被外力改过，n<门限的决策仍回静态常数（安全带优先）
  registry.set('memory.op.shortcut.boost', 1.0);
  const d2 = decideMemoryOpThreshold('shortcut', 'boost', { registry, ledger });
  assert.ok(d2);
  assert.equal(d2.threshold, 0.3, '门限下不受漂移值牵连');
  // 跨过门限（第 8 条）：翻转为采样
  recordMemoryOpFeedback('shortcut', 'boost', true, { registry, ledger });
  const d3 = decideMemoryOpThreshold('shortcut', 'boost', { registry, ledger, rng: seededRng('flip') });
  assert.ok(d3);
  assert.equal(d3.source, 'thompson-sample');
  assert.ok(typeof d3.sample === 'number' && d3.sample >= 0 && d3.sample <= 1);
});

// ─── W2-6e 阈值夹取：采样 → 区间插值双侧夹取，NaN 不传染 ───

test('W2-6e 夹取手算：θ∈[0,1] 插值、越界夹取、NaN ⇒ 区间中点', () => {
  assert.equal(thresholdFromSample(0, 0.2, 1.0), 0.2);
  assert.equal(thresholdFromSample(1, 0.2, 1.0), 1.0);
  assert.ok(Math.abs(thresholdFromSample(0.5, 0.2, 1.0) - 0.6) < 1e-12, 'θ=0.5 ⇒ 中点 0.6');
  assert.equal(thresholdFromSample(-0.5, 0.2, 1.0), 0.2, 'θ<0 夹下界');
  assert.equal(thresholdFromSample(1.7, 0.2, 1.0), 1.0, 'θ>1 夹上界');
  assert.ok(Math.abs(thresholdFromSample(NaN, 0.2, 1.0) - 0.6) < 1e-12, 'NaN ⇒ 无偏中点');
  assert.ok(Math.abs(thresholdFromSample(Infinity, 0.01, 0.3) - 0.155) < 1e-12, '+∞ 非有限 ⇒ 同走区间中点');
  // 垃圾区间：消毒后仍产出有限值
  const v = thresholdFromSample(0.5, Number.NaN, Number.NaN);
  assert.ok(Number.isFinite(v) && v >= 0 && v <= 1);
  // 端到端：收敛落值恒在各自区间内
  const { registry, ledger } = freshPair();
  for (const op of MEMORY_OP_KINDS) {
    for (let i = 0; i < 20; i++) recordMemoryOpFeedback('business-rule', op, i % 3 !== 0, { registry, ledger });
  }
  const report = convergeMemoryOps({ registry, ledger, seed: 'w2-clamp' });
  assert.equal(report.converged.length, 4, '四操作臂均过门限');
  for (const c of report.converged) {
    const spec = memoryOpSpecOf(c.key);
    assert.ok(spec);
    assert.ok(c.to >= spec.min && c.to <= spec.max, `${c.key} 落值在区间内`);
    assert.equal(registry.get(c.key), c.to, '注册表现值 = 落值');
  }
});

// ─── W2-6f seed 重放一致：同种子 + 同账本态 ⇒ 报告与落值逐位一致 ───

test('W2-6f 重放一致：双隔离环境同反馈同种子 ⇒ 收敛报告与注册表快照逐位相等', () => {
  const seedFeedback = (fx: { registry: KernelRegistry; ledger: EvidenceLedger }) => {
    for (let i = 0; i < 14; i++) recordMemoryOpFeedback('error-pattern', 'insert', i < 10, fx);   // 10 胜 4 败
    for (let i = 0; i < 9; i++) recordMemoryOpFeedback('workflow', 'evict', i < 3, fx);           // 3 胜 6 败
    for (let i = 0; i < 8; i++) recordMemoryOpFeedback('ui-pattern', 'noop', true, fx);           // 8 胜 0 败
  };
  const A = freshPair(); const B = freshPair();
  seedFeedback(A); seedFeedback(B);
  const rA = convergeMemoryOps({ ...A, seed: 'w2-replay' });
  const rB = convergeMemoryOps({ ...B, seed: 'w2-replay' });
  assert.equal(rA.seed, 'w2-replay');
  assert.equal(rA.converged.length, 3);
  assert.deepEqual(rA.converged, rB.converged, '收敛报告逐位一致（含 from/to/θ）');
  assert.deepEqual(rA.held, rB.held);
  assert.deepEqual(A.registry.snapshot(), B.registry.snapshot(), '落值快照逐位一致');
  // 同态重复收敛（rng 每次重铸）：幂等重放
  const rA2 = convergeMemoryOps({ ...A, seed: 'w2-replay' });
  assert.deepEqual(rA2.converged.map(c => c.to), rA.converged.map(c => c.to));
  // 异种子 ⇒ 采样流不同（重放的钥匙真的在种子上）：28 臂同态至少一支落值不同
  const rA3 = convergeMemoryOps({ ...A, seed: 'w2-replay-other' });
  const to3 = new Map(rA3.converged.map(c => [c.key, c.to]));
  const differs = rA.converged.some(c => to3.get(c.key) !== c.to);
  assert.ok(differs, '不同种子应产出不同采样流');
});

test('W2-6f 种子流确定性：同种子同流、数值种子与字符串种子皆可复现', () => {
  const a = seededRng('w2'); const b = seededRng('w2');
  const seqA = [a(), a(), a()]; const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  assert.ok(seqA.every(v => v >= 0 && v < 1), '流值域 [0,1)');
  const c = seededRng(12345); const d = seededRng(12345);
  assert.deepEqual([c(), c()], [d(), d()]);
  assert.deepEqual([seededRng(NaN)(), seededRng(NaN)()], [seededRng(NaN)(), seededRng(NaN)()], '垃圾种子消毒后仍确定');
  // betaSample 决定论：同 (α,β,流) ⇒ 同值
  const r1 = betaSample(7, 5, seededRng('beta')); const r2 = betaSample(7, 5, seededRng('beta'));
  assert.equal(r1, r2);
  assert.ok(r1 > 0 && r1 < 1);
});

// ─── W2-6g 统计正确：Beta 采样的分布形状（固定种子下的确定性断言）───

test('W2-6g 统计正确：Beta(1,1)≈均匀、Beta(31,1) 趋 1、Beta(1,31) 趋 0、Beta(5,5)≈0.5', () => {
  const rng = seededRng('stat');
  let sum = 0; const N = 3000;
  for (let i = 0; i < N; i++) sum += betaSample(1, 1, rng);
  const mean = sum / N;
  assert.ok(Math.abs(mean - 0.5) < 0.04, `Beta(1,1) 样本均值 ≈ 0.5（实测 ${mean.toFixed(4)}）`);
  // Beta(31,1)：P(X<0.5) = 0.5^31 ≈ 4.7e-10 —— 200 样本全数 >0.5
  const rng2 = seededRng('stat-31-1');
  let low = 0;
  for (let i = 0; i < 200; i++) if (betaSample(31, 1, rng2) <= 0.5) low += 1;
  assert.equal(low, 0, 'Beta(31,1) 样本应全数 > 0.5');
  const rng3 = seededRng('stat-1-31');
  let high = 0;
  for (let i = 0; i < 200; i++) if (betaSample(1, 31, rng3) >= 0.5) high += 1;
  assert.equal(high, 0, 'Beta(1,31) 样本应全数 < 0.5');
  // Beta(5,5) 对称分布：均值 ≈ 0.5（宽容带）
  const rng4 = seededRng('stat-5-5');
  let sum4 = 0;
  for (let i = 0; i < 2000; i++) sum4 += betaSample(5, 5, rng4);
  assert.ok(Math.abs(sum4 / 2000 - 0.5) < 0.05, 'Beta(5,5) 样本均值 ≈ 0.5');
  // 域外形状参数：无偏中点回退（绝不抛）
  assert.equal(betaSample(0, 0, rng), 0.5);
  assert.equal(betaSample(NaN, 5, rng), 0.5);
  // 坏流（恒 NaN）：Gamma 桥走均值回退 ⇒ 后验均值，有限且在 [0,1]
  const bad = betaSample(7, 5, () => NaN);
  assert.ok(Number.isFinite(bad) && bad >= 0 && bad <= 1, `坏流回退有限（${bad}）`);
  const bad0 = betaSample(7, 5, () => 0);
  assert.ok(Number.isFinite(bad0) && bad0 >= 0 && bad0 <= 1, '恒 0 流不悬挂');
});

// ─── W2-6h EvidenceLedger 记账：成败原子 / 证据计数 / 收割回灌 ───

test('W2-6h 账本记账：6 成 4 败 ⇒ stats(n=10, rate=0.6)；registry 证据同步 10', () => {
  const { registry, ledger } = freshPair();
  const deps = { registry, ledger };
  for (let i = 0; i < 6; i++) assert.equal(recordMemoryOpFeedback('system-quirk', 'evict', true, deps).ok, true);
  for (let i = 0; i < 4; i++) assert.equal(recordMemoryOpFeedback('system-quirk', 'evict', false, deps).ok, true);
  const key = 'memory.op.system-quirk.evict';
  assert.deepEqual(ledger.stats(key), { n: 10, successRate: 0.6, margins: [] });
  assert.deepEqual(ledger.entries(key).filter(e => e.success).length, 6, '逐条成败原子在场');
  const p = registry.list().find(x => x.key === key);
  assert.ok(p && p.evidence === 10, '注册表证据计数 = 记账次数');
  // 手算闭环：账本统计 → Beta(7,5)（W2-6b 手算例的端到端回验）
  const d = decideMemoryOpThreshold('system-quirk', 'evict', deps);
  assert.ok(d);
  assert.deepEqual([d.alpha, d.beta], [7, 5]);
  assert.deepEqual([d.successes, d.failures], [6, 4]);
});

test('W2-6h 收割回灌：trials → 指定臂记账（缺省 insert）；垃圾 trials 零记账', () => {
  const { registry, ledger } = freshPair();
  const trials: Partial<Record<KnowledgeCategory, CategoryTrials>> = {
    workflow: { successes: 3, failures: 2, entries: 5 },
    'error-pattern': { successes: 0, failures: 4, entries: 4 },
  };
  const n = applyHarvestedRewards(trials, 'insert', { registry, ledger });
  assert.equal(n, 9, '3+2+4 = 9 条原子');
  assert.deepEqual(
    ledger.stats('memory.op.workflow.insert'),
    { n: 5, successRate: 0.6, margins: [] },
  );
  assert.deepEqual(
    ledger.stats('memory.op.error-pattern.insert'),
    { n: 4, successRate: 0, margins: [] },
  );
  // 归因到别的操作臂：boost 臂独立接收同一份试验
  const n2 = applyHarvestedRewards(trials, 'boost', { registry, ledger });
  assert.equal(n2, 9);
  assert.equal(ledger.stats('memory.op.workflow.boost').n, 5);
  assert.equal(ledger.stats('memory.op.workflow.insert').n, 5, 'insert 臂不受 boost 回灌影响');
  assert.equal(applyHarvestedRewards(null, 'insert', { registry, ledger }), 0);
  assert.equal(applyHarvestedRewards({}, 'insert', { registry, ledger }), 0);
});

// ─── W2-6i 防御式绝不抛：垃圾输入全家福（含抛错的依赖面）───

test('W2-6i 防御带：垃圾类别/操作/成败全 {ok:false}，不抛不记；决策垃圾臂 null', () => {
  const { registry, ledger } = freshPair();
  const deps = { registry, ledger };
  assert.deepEqual(recordMemoryOpFeedback('bogus', 'insert', true, deps), { ok: false, reason: 'unknown category "bogus"' });
  assert.deepEqual(recordMemoryOpFeedback('workflow', 'fly', true, deps), { ok: false, reason: 'unknown op "fly"' });
  assert.equal(recordMemoryOpFeedback('workflow', 'insert', 'yes', deps).ok, false);
  assert.equal(recordMemoryOpFeedback(null, undefined, null, deps).ok, false);
  assert.equal(ledger.keys().length, 0, '垃圾不入账');
  assert.equal(registry.list().length, 0);
  assert.equal(decideMemoryOpThreshold('bogus', 'insert', deps), null);
  assert.equal(decideMemoryOpThreshold('workflow', 'fly', deps), null);
  assert.equal(decideMemoryOpThreshold(undefined, 42, deps), null);
  resetKernelRuntime();
  try {
    // null deps（非 undefined）：有效臂 ⇒ 生产单例缺省回退，返回决策而非抛（防御带）
    const dn = decideMemoryOpThreshold('workflow', 'insert', null);
    assert.ok(dn !== null && dn.source === 'static-default', 'null deps 走生产单例缺省，绝不抛');
    assert.equal(decideMemoryOpThreshold('bogus', 'insert', null), null, '垃圾臂 + null deps 仍 null');
  } finally {
    resetKernelRuntime();
  }
});

test('W2-6i 防御带：抛错/坏流依赖面下收敛器永不抛，落值恒有限恒在区间', () => {
  const { registry, ledger } = freshPair();
  for (let i = 0; i < 20; i++) recordMemoryOpFeedback('preference', 'boost', i % 4 !== 0, { registry, ledger });
  // 坏流：恒 NaN ⇒ Gamma 桥均值回退 ⇒ 后验均值落值（有限、区间内）
  const r1 = convergeMemoryOps({ registry, ledger, rng: () => NaN });
  assert.ok(r1.converged.length >= 1);
  for (const c of r1.converged) {
    const spec = memoryOpSpecOf(c.key);
    assert.ok(spec);
    assert.ok(Number.isFinite(c.to) && c.to >= spec.min && c.to <= spec.max, '坏流落值仍有限在区间');
    assert.ok(Number.isFinite(c.sample));
  }
  // 抛错账本：单臂故障被吞，收敛器照常返回报告
  const boomLedger = {
    stats: () => { throw new Error('boom'); },
    record: () => { throw new Error('boom'); },
  } as unknown as EvidenceLedger;
  const r2 = convergeMemoryOps({ registry, ledger: boomLedger, seed: 'w2-boom' });
  assert.equal(r2.arms, 28);
  assert.equal(r2.converged.length, 0);
  assert.equal(r2.held.length, 0, '决策全缺席（诚实空报告，不抛）');
  // 生产单例缺省路径：空态收敛 = 28 held、全静态缺省（顺手验证单例接线面）
  resetKernelRuntime();
  try {
    const r3 = convergeMemoryOps({ seed: 'w2-prod-empty' });
    assert.equal(r3.held.length, 28);
    assert.equal(r3.converged.length, 0);
    assert.equal(kernelRegistry.list().length, 28, '收敛路径完成幂等入册');
    assert.equal(evidenceLedger.keys().length, 0);
    const r4 = convergeMemoryOps({ seed: 'w2-prod-empty' });
    assert.deepEqual(r3.held, r4.held, '同种子空态重放一致');
  } finally {
    resetKernelRuntime();
  }
});

// ─── W2-6e（ΝΩ-28 任务3）：奖励归因去噪 —— helped 从窗口级全局布尔升两队列对照 ───

test('W2-6e 两队列对照：注入在场组 vs 缺席组完成率定 helped；样本不足回退现行布尔', () => {
  const NOW = 10_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;
  const hit = entry({ category: 'workflow', updatedAt: NOW - DAY, usageCount: 3 });

  // (a) 去噪主案例：在场组完成率 0.5 < 缺席组 1.0 ⇒ helped=false。旧全局布尔
  //     只看「∃ 注入在场且 completed 的 run」⇒ 此处会误记 success —— 恰有
  //     完成的知识 run ≠ 注入有助益（注入普遍在场而完成率反而更差的库，
  //     不该全员记 success）。Cohen's h(0.5, 1.0) = −1.571 < 0 定号。
  const denoised = harvestMemoryOpRewards([hit], [
    run({ ts: NOW - DAY, verdict: 'completed', knowledgeRounds: 2 }),
    run({ ts: NOW - 2 * DAY, verdict: 'failed', knowledgeRounds: 1 }),
    run({ ts: NOW - DAY, verdict: 'completed', knowledgeRounds: 0 }),
    run({ ts: NOW - 2 * DAY, verdict: 'completed', knowledgeRounds: 0 }),
  ], { now: NOW });
  assert.deepEqual(denoised.workflow, { successes: 0, failures: 1, entries: 1 }, '在场组完成率劣势 ⇒ 记败（旧布尔误记 success 的场景）');

  // (b) 在场组占优（1.0 vs 0.5）⇒ helped=true（真助益照常记账）
  const helpedCase = harvestMemoryOpRewards([hit], [
    run({ ts: NOW - DAY, verdict: 'completed', knowledgeRounds: 2 }),
    run({ ts: NOW - 2 * DAY, verdict: 'completed', knowledgeRounds: 1 }),
    run({ ts: NOW - DAY, verdict: 'completed', knowledgeRounds: 0 }),
    run({ ts: NOW - 2 * DAY, verdict: 'failed', knowledgeRounds: 0 }),
  ], { now: NOW });
  assert.deepEqual(helpedCase.workflow, { successes: 1, failures: 0, entries: 1 });

  // (c) 并列（1.0 vs 1.0 ⇒ h=0）⇒ helped=false：无差异证据不是助益证据
  const tie = harvestMemoryOpRewards([hit], [
    run({ ts: NOW - DAY, verdict: 'completed', knowledgeRounds: 2 }),
    run({ ts: NOW - 2 * DAY, verdict: 'completed', knowledgeRounds: 1 }),
    run({ ts: NOW - DAY, verdict: 'completed', knowledgeRounds: 0 }),
    run({ ts: NOW - 2 * DAY, verdict: 'completed', knowledgeRounds: 0 }),
  ], { now: NOW });
  assert.deepEqual(tie.workflow, { successes: 0, failures: 1, entries: 1 }, 'h=0 ⇒ 不记助益');

  // (d) 样本不足（缺席组仅 1 条）⇒ 回退现行窗口级布尔（present completed 在场 ⇒ true）
  const fallback = harvestMemoryOpRewards([hit], [
    run({ ts: NOW - DAY, verdict: 'completed', knowledgeRounds: 2 }),
    run({ ts: NOW - 2 * DAY, verdict: 'completed', knowledgeRounds: 0 }),
  ], { now: NOW });
  assert.deepEqual(fallback.workflow, { successes: 1, failures: 0, entries: 1 }, '任一侧 <2 ⇒ 布尔回退（零漂移安全带）');

  // (e) compareHelpedCohorts 纯函数面：不足/垃圾 ⇒ null；充足 ⇒ h 定号
  assert.equal(compareHelpedCohorts({ present: 1, presentCompleted: 1, absent: 5, absentCompleted: 5 }), null, 'present<2');
  assert.equal(compareHelpedCohorts({ present: 5, presentCompleted: 1, absent: 1, absentCompleted: 1 }), null, 'absent<2');
  assert.equal(compareHelpedCohorts({ present: 2, presentCompleted: 2, absent: 2, absentCompleted: 0 }), true);
  assert.equal(compareHelpedCohorts({ present: 2, presentCompleted: 0, absent: 2, absentCompleted: 2 }), false);
  assert.equal(compareHelpedCohorts(null), null);
  assert.equal(compareHelpedCohorts({}), null, '字段缺席 ⇒ null（绝不抛）');
  assert.equal(compareHelpedCohorts({ present: -1, presentCompleted: 0, absent: 2, absentCompleted: 0 }), null, '负计数 = 垃圾');
});
