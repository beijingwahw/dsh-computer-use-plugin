// test/kernel.calibrator.test.ts
// 纪元 Θ（Θ-2）：在线校准器 + 参数血统 —— 全离线注入测试。
// 纪律：手造实例（new KernelRegistry / new EvidenceLedger / new KernelLineage），
// 绝不碰生产单例 kernelRegistry / evidenceLedger；零网络零 IO；数值断言全可手算复现。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KernelLineage } from '../src/kernel/lineage.ts';
import {
  KernelCalibrator,
  optimalThreshold,
  optimalThresholdGpUcb,
  gpRbf1d,
  regressionPosteriorMass,
  DEFAULT_GUARDRAILS,
} from '../src/kernel/calibrator.ts';
import type { CalibrationReport, CalibratorOptions, ThresholdLearner } from '../src/kernel/calibrator.ts';
import { SAFETY_CRITICAL_KERNEL_KEYS } from '../src/kernel/productionSpecs.ts';
import { KernelRegistry, EvidenceLedger } from '../src/kernel/registry.ts';
import type { KernelRegistry as RegistryContract, EvidenceLedger as LedgerContract } from '../src/kernel/registry.ts';

const close = (a: number, b: number, eps = 1e-9): void =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b} (eps ${eps})`);

/** 手造账本：nFail 条 (false, margin=1) + nSucc 条 (true, margin=9) —— margin 排序与成败对齐 */
function feed(ledger: EvidenceLedger, key: string, nFail: number, nSucc: number): void {
  for (let i = 0; i < nFail; i++) ledger.record({ key, success: false, margin: 1, ts: 1 });
  for (let i = 0; i < nSucc; i++) ledger.record({ key, success: true, margin: 9, ts: 1 });
}

/** 标准台架：min=0/max=10（区间 10，maxStepPct 0.1 ⇒ 步长上限 1），时钟定死 */
function makeSetup(key = 'p', defaultValue = 0.5, min = 0, max = 10) {
  const registry = new KernelRegistry();
  registry.register({ key, organ: 'θ-2-test', defaultValue, min, max });
  const ledger = new EvidenceLedger();
  const lineage = new KernelLineage();
  const cal = new KernelCalibrator({ registry, ledger, lineage, now: () => 424242 });
  return { registry, ledger, lineage, cal, key };
}

// ─── Θ-2a：optimalThreshold 纯函数（整数 margin ⇒ 中点全为精确 .5，断言可手算）───

test('Θ-2a: optimalThreshold 完美分隔 —— 唯一最大正确率阈 = 类间中点', () => {
  // margins 1-4 全败、6-9 全胜 ⇒ t=5（(4+6)/2）正确率 8/8
  assert.equal(optimalThreshold([1, 2, 3, 4, 6, 7, 8, 9], [false, false, false, false, true, true, true, true]), 5);
});

test('Θ-2a: optimalThreshold 重叠 + 平票 —— 偶数并列取候选中位数（均值）', () => {
  // margin 4 是成功、7 是失败（不可分）：最大正确率 7/8 由 t=3.5 与 t=7.5 并列 ⇒ 中位数 5.5
  assert.equal(optimalThreshold([1, 2, 3, 7, 4, 8, 9, 10], [false, false, false, false, true, true, true, true]), 5.5);
  // 交错标签：最大正确率 4/8 由 {1, 2.5, 4.5, 6.5} 四候选并列 ⇒ 中位数 (2.5+4.5)/2 = 3.5
  assert.equal(optimalThreshold([1, 2, 3, 4, 5, 6, 7, 8], [true, false, true, false, true, false, true, false]), 3.5);
});

test('Θ-2a: optimalThreshold 诚实下限 —— 样本 <8 / 空数组 / 长度不齐 ⇒ null', () => {
  assert.equal(optimalThreshold([1, 2, 3, 4, 5, 6, 7], [true, true, true, true, false, false, false]), null);
  assert.equal(optimalThreshold([], []), null);
  assert.equal(optimalThreshold([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [true, false]), null); // 按短者截齐 ⇒ 2 对
});

test('Θ-2a: optimalThreshold 全同 label ⇒ null（无判定结构可学）', () => {
  assert.equal(optimalThreshold([1, 2, 3, 4, 5, 6, 7, 8], [true, true, true, true, true, true, true, true]), null);
  assert.equal(optimalThreshold([1, 2, 3, 4, 5, 6, 7, 8], [false, false, false, false, false, false, false, false]), null);
});

test('Θ-2a: optimalThreshold 垃圾静默 —— null 入参不抛、非有限 margin / 非布尔 label 剔队', () => {
  assert.equal(optimalThreshold(null as unknown as number[], null as unknown as boolean[]), null);
  assert.equal(
    optimalThreshold(undefined as unknown as number[], undefined as unknown as boolean[]),
    null,
  );
  // 10 对中 NaN/Infinity margin 与非布尔 label 各 2 条剔队 ⇒ 剩 8 对完美分隔 ⇒ 5
  const t = optimalThreshold(
    [1, 2, 3, 4, 6, 7, 8, 9, Number.NaN, Number.POSITIVE_INFINITY],
    [false, false, false, false, true, true, true, true, true, 1 as unknown as boolean],
  );
  assert.equal(t, 5);
});

// ─── Θ-2b：KernelLineage 血统（promote / record / extinct / fitnessTrend / reset）───

test('Θ-2b: promote 世代链 —— 初代 generation 1，二代 parentValue=前代值', () => {
  const l = new KernelLineage();
  const g1 = l.promote('p', 1, 0.5, 1000);
  assert.equal(g1.generation, 1);
  assert.equal(g1.parentValue, undefined);
  assert.equal(g1.value, 1);
  assert.equal(g1.fitness, 0.5);
  assert.equal(g1.createdAt, 1000);
  const g2 = l.promote('p', 2, 0.6, 2000);
  assert.equal(g2.generation, 2);
  assert.equal(g2.parentValue, 1);
  const gens = l.generations('p');
  assert.equal(gens.length, 2);
  assert.equal(gens[0].createdAt, 1000); // createdAt 升序
  assert.equal(gens[1].createdAt, 2000);
  // 垃圾 promote：不入血统、原样回显描述符
  const junk = l.promote('', 1, 0.5, 1);
  assert.equal(l.generations('').length, 0);
  assert.equal(junk.generation, 1);
  const junk2 = l.promote('q', Number.NaN, 0.5, 1);
  assert.equal(l.generations('q').length, 0);
  assert.ok(Number.isNaN(junk2.value));
});

test('Θ-2b: record —— 同 key 同代覆盖；出防御副本（外改不穿透）', () => {
  const l = new KernelLineage();
  l.record({ key: 'r', generation: 5, value: 1, fitness: 0.5, createdAt: 10 });
  l.record({ key: 'r', generation: 5, value: 2, fitness: 0.6, createdAt: 20 }); // 同代覆盖
  l.record({ key: 'r', generation: 6, value: 3, fitness: 0.7, createdAt: 30 }); // 新代追加
  const gens = l.generations('r');
  assert.equal(gens.length, 2);
  assert.equal(gens[0].value, 2);
  assert.equal(gens[0].fitness, 0.6);
  // 防御副本：改返回值不影响血统
  gens.push({ key: 'r', generation: 9, value: 9, fitness: 9, createdAt: 9 });
  gens[0].value = 99;
  const again = l.generations('r');
  assert.equal(again.length, 2);
  assert.equal(again[0].value, 2);
});

test('Θ-2b: record 垃圾静默 —— 畸形样本一律不抛不入账', () => {
  const l = new KernelLineage();
  l.record(null as unknown as never);
  l.record(undefined as unknown as never);
  l.record({} as never);
  l.record(5 as unknown as never);
  l.record('x' as unknown as never);
  l.record({ key: '', generation: 1, value: 1, fitness: 1, createdAt: 1 });
  l.record({ key: 'g', generation: Number.NaN, value: 1, fitness: 1, createdAt: 1 });
  l.record({ key: 'g', generation: 1.5, value: 1, fitness: 1, createdAt: 1 });
  l.record({ key: 'g', generation: -1, value: 1, fitness: 1, createdAt: 1 });
  l.record({ key: 'g', generation: 1, value: Number.NaN, fitness: 1, createdAt: 1 });
  l.record({ key: 'g', generation: 1, value: 1, fitness: Number.POSITIVE_INFINITY, createdAt: 1 });
  l.record({ key: 'g', generation: 1, value: 1, fitness: 1, createdAt: Number.NaN });
  assert.equal(l.generations('g').length, 0);
});

test('Θ-2b: extinct 灭绝剪枝 —— 缺省留最近 5 代，全局 fitness 冠军例外存活', () => {
  const l = new KernelLineage();
  for (let i = 1; i <= 8; i++) {
    l.record({ key: 'e', generation: i, value: i, fitness: i === 1 ? 0.9 : 0.1, createdAt: i * 100 });
  }
  assert.equal(l.extinct('e'), 2); // 剪 gen2/gen3；gen1（fitness 0.9 冠军）豁免
  const left = l.generations('e');
  assert.equal(left.length, 6);
  assert.deepEqual(left.map(g => g.generation), [1, 4, 5, 6, 7, 8]); // 时间升序
  assert.equal(l.extinct('e'), 0); // 冠军已在豁免位：再剪零剪
  assert.equal(l.generations('e').length, 6);
});

test('Θ-2b: extinct 边界 —— 冠军在幸存区不豁免；keep≥全长⇒0；keep<1⇒至少保 1；未知 key⇒0', () => {
  const l = new KernelLineage();
  for (let i = 1; i <= 8; i++) {
    l.record({ key: 'e2', generation: i, value: i, fitness: i === 8 ? 0.9 : 0.1, createdAt: i * 100 });
  }
  assert.equal(l.extinct('e2'), 3); // 冠军 gen8 在最近 5 代内 ⇒ 无豁免，净剪 3
  assert.equal(l.generations('e2').length, 5);

  for (let i = 1; i <= 3; i++) {
    l.record({ key: 'e3', generation: i, value: i, fitness: 0.5, createdAt: i });
  }
  assert.equal(l.extinct('e3', 10), 0); // keep ≥ 全长 ⇒ 全员存活
  assert.equal(l.extinct('e3', Number.NaN), 0); // keep 非法按缺省 5

  for (let i = 1; i <= 8; i++) {
    l.record({ key: 'e4', generation: i, value: i, fitness: i === 1 ? 0.9 : 0.1, createdAt: i * 100 });
  }
  assert.equal(l.extinct('e4', 0), 6); // keep<1 按 1：留 gen8 + 冠军 gen1 豁免 ⇒ 剪 6
  const e4 = l.generations('e4');
  assert.equal(e4.length, 2);
  assert.deepEqual(e4.map(g => g.generation), [1, 8]);

  assert.equal(l.extinct('no-such-key'), 0);
});

test('Θ-2b: fitnessTrend —— 升/降/平的斜率饱和归一（slope/(1+|slope|)）', () => {
  const seed = (key: string, fitness: number[]): KernelLineage => {
    const l = new KernelLineage();
    fitness.forEach((f, i) => l.record({ key, generation: i + 1, value: i, fitness: f, createdAt: i + 1 }));
    return l;
  };
  close(seed('t', [0.2, 0.4, 0.6, 0.8]).fitnessTrend('t'), 0.2 / 1.2); // 升：斜率 0.2 ⇒ 1/6
  close(seed('t', [0.8, 0.6, 0.4, 0.2]).fitnessTrend('t'), -0.2 / 1.2); // 降
  assert.equal(seed('t', [0.5, 0.5, 0.5, 0.5]).fitnessTrend('t'), 0); // 平
  close(seed('t', [0.5, 0.9]).fitnessTrend('t'), 0.4 / 1.4); // 两代：斜率 0.4 ⇒ 2/7
  close(seed('t', [0, 3, 6, 9]).fitnessTrend('t'), 3 / 4); // 陡坡饱和：斜率 3 ⇒ 0.75 ∈ (−1,1)
  assert.equal(seed('t', [0.5]).fitnessTrend('t'), 0); // 单代 ⇒ 0（诚实下限）
  assert.equal(new KernelLineage().fitnessTrend('t'), 0); // 无血统 ⇒ 0
});

test('Θ-2b: reset 清空血统', () => {
  const l = new KernelLineage();
  l.promote('p', 1, 0.5, 1);
  l.record({ key: 'q', generation: 1, value: 1, fitness: 1, createdAt: 1 });
  l.reset();
  assert.equal(l.generations('p').length, 0);
  assert.equal(l.generations('q').length, 0);
  assert.equal(l.fitnessTrend('p'), 0);
});

// ─── Θ-2c：KernelCalibrator.tick 五律进化（真实 registry/ledger/lineage 手造实例）───

test('Θ-2c: 证据门 —— n=29 不动，n=30 才动（minEvidence 缺省 30）', () => {
  assert.equal(DEFAULT_GUARDRAILS.minEvidence, 30);
  assert.equal(DEFAULT_GUARDRAILS.maxStepPct, 0.1);
  assert.equal(DEFAULT_GUARDRAILS.rollbackDrop, 0.05); // ΝΩ-6：兼容锚保留（判决已由后验接管）
  assert.equal(DEFAULT_GUARDRAILS.minPostEvidence, 20);
  assert.equal(DEFAULT_GUARDRAILS.rollbackPosteriorMass, 0.9); // ΝΩ-6：后验质量门
  const { registry, ledger, cal } = makeSetup();
  feed(ledger, 'p', 3, 26); // n=29
  assert.deepEqual(cal.tick(), []);
  assert.equal(registry.get('p'), 0.5);
  assert.equal(cal.history().length, 0);
  ledger.record({ key: 'p', success: true, margin: 9, ts: 1 }); // n=30、rate 0.9
  const reports = cal.tick();
  assert.equal(reports.length, 1);
  assert.equal(registry.get('p'), 1.5); // 0.5 + 步长 1
});

test('Θ-2c: 步长上限截断 + 换血入血统 —— 0.5 → 1.5（阈 7 被截），快照/promote/报告三账对齐', () => {
  const { registry, ledger, lineage, cal, key } = makeSetup();
  feed(ledger, key, 3, 27); // n=30、rate 0.9、margins [1,1,1,9×27] ⇒ 阈 7（{5,9} 并列中位）∈ [0,10]
  const reports = cal.tick();
  assert.equal(reports.length, 1);
  const r = reports[0];
  assert.equal(r.key, key);
  assert.equal(r.from, 0.5);
  assert.equal(r.to, 1.5); // |5−0.5|=4.5 > 1 ⇒ 截到 0.5+1
  assert.ok(r.reason.includes('optimal-threshold'), `reason 应含 optimal-threshold：${r.reason}`);
  assert.ok(r.reason.includes('step-capped'), `reason 应注明步长截断：${r.reason}`);
  assert.equal(r.generation, 1); // 血统 promote 后世代
  assert.equal(registry.get(key), 1.5);
  // 血统：现代快照（gen0）→ 新一代（gen1，parentValue=快照值）
  const gens = lineage.generations(key);
  assert.equal(gens.length, 2);
  assert.equal(gens[0].generation, 0);
  assert.equal(gens[0].value, 0.5);
  close(gens[0].fitness, 0.9);
  assert.equal(gens[1].generation, 1);
  assert.equal(gens[1].value, 1.5);
  assert.equal(gens[1].parentValue, 0.5);
  close(gens[1].fitness, 0.9); // fitness = successRate（无探索奖励）
  assert.deepEqual(cal.history(), reports); // tick 报告入史
});

test('Θ-2c: 步长边界 |Δ|==limit 不截；已到最优阈再 tick 静默不动', () => {
  const { registry, ledger, cal, key } = makeSetup('p', 6); // 现值 6，阈 7（{5,9} 并列中位），|Δ|=1 == limit
  feed(ledger, key, 3, 27);
  const reports = cal.tick();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].to, 7);
  assert.ok(!reports[0].reason.includes('step-capped'));
  assert.equal(registry.get(key), 7);
  assert.deepEqual(cal.tick(), []); // 阈 7 == 现值 ⇒ 无换血
  assert.equal(registry.get(key), 7);
});

test('Θ-2c: bounds 夹取 —— 候选阈落在 [min,max] 外 ⇒ 本 tick 不动（不硬拉）', () => {
  const { registry, ledger, cal, key } = makeSetup('p', 0.5, 0, 4); // max=4 < 阈 7 ⇒ 越界候选
  feed(ledger, key, 3, 27);
  assert.deepEqual(cal.tick(), []);
  assert.equal(registry.get(key), 0.5);
  assert.equal(cal.history().length, 0);
});

test('Θ-2c: 回归守卫 —— 先优后劣：successRate 跌出上代 fitness−drop ⇒ 回滚到血统倒数第二代', () => {
  const { registry, ledger, lineage, cal, key } = makeSetup('p', 8); // 现值 8
  // 血统：上代（gen2，值 5、fitness 0.9）→ 现代（gen3，值 8）
  lineage.record({ key, generation: 2, value: 5, fitness: 0.9, createdAt: 100 });
  lineage.record({ key, generation: 3, value: 8, fitness: 0.9, createdAt: 200 });
  feed(ledger, key, 16, 24); // n=40、rate 0.6 < 0.9−0.05=0.85 ⇒ 回归
  const reports = cal.tick();
  assert.equal(reports.length, 1);
  const r = reports[0];
  assert.ok(r.reason.includes('regression-rollback'), `reason 应注明回归回滚：${r.reason}`);
  assert.equal(r.from, 8);
  assert.equal(r.to, 5);
  assert.equal(r.generation, 2); // 回滚目标代
  assert.equal(registry.get(key), 5);
  assert.equal(lineage.generations(key).length, 2); // 回滚不重写血统（审计事实）
  // 已回滚到位后的重复 tick：静默（不刷屏、不再变异）
  assert.deepEqual(cal.tick(), []);
  assert.equal(registry.get(key), 5);
  assert.equal(cal.history().length, 1);
});

test('Θ-2c: 回归边界（ΝΩ-6 后验版）—— 后验不足不判回归；证据不足不判', () => {
  const mk = (nFail: number, nSucc: number) => {
    const s = makeSetup('p', 8);
    s.lineage.record({ key: s.key, generation: 2, value: 5, fitness: 0.8, createdAt: 100 });
    s.lineage.record({ key: s.key, generation: 3, value: 8, fitness: 0.8, createdAt: 200 });
    feed(s.ledger, s.key, nFail, nSucc);
    return s;
  };
  // n=32、rate 24/32=0.75 vs 上代 0.8：后验 I_0.8(25,9) = 0.80 < 0.9（二项恒等式
  // P(Y≥25), Y~Bin(33,0.8) 手算可复现）⇒ 噪声与真退化不可分 ⇒ 不回滚，照常进化：
  // 阈 7、|7−8|=1 == limit 不截 ⇒ 到 7（旧频率派规则「恰等 0.8−0.05 不判」同判不回滚）
  const edge = mk(8, 24);
  const reports = edge.cal.tick();
  assert.equal(reports.length, 1);
  assert.ok(reports[0].reason.includes('optimal-threshold'));
  assert.ok(!reports[0].reason.includes('regression'));
  assert.ok(!reports[0].reason.includes('step-capped'));
  assert.equal(edge.registry.get('p'), 7);

  // minPostEvidence 门 + 后验渐进：护栏 {minEvidence:10, minPostEvidence:15} ——
  // n=12 不判回归照常进化（证据不足维持旧行为）；此后上代 = 首次进化前的现代快照
  //（gen0，值 8、fitness = 当时率 0.5）。补到 n=16、k=6：后验 I_0.5(7,11) = 0.8338
  // < 0.9 ⇒ 仍不回滚（旧频率派在 0.375 < 0.5−0.05 会回滚 —— ΝΩ-6 把这类未足
  // 置信的证据划归噪声）；阈 7 == 现值 ⇒ 静默无报告。再补 2 败至 n=18、k=6：
  // I_0.5(7,13) = 0.9165 ≥ 0.9 ⇒ 回滚掉上一次 promote（回快照值 8）。
  const gated = makeSetup('p', 8);
  gated.lineage.record({ key: gated.key, generation: 2, value: 5, fitness: 0.9, createdAt: 100 });
  gated.lineage.record({ key: gated.key, generation: 3, value: 8, fitness: 0.9, createdAt: 200 });
  const cal = new KernelCalibrator({
    registry: gated.registry,
    ledger: gated.ledger,
    lineage: gated.lineage,
    guardrails: { minEvidence: 10, minPostEvidence: 15 },
    now: () => 424242,
  });
  feed(gated.ledger, gated.key, 6, 6); // n=12 ≥10 但 <15
  const first = cal.tick();
  assert.equal(first.length, 1);
  assert.ok(first[0].reason.includes('optimal-threshold'));
  assert.equal(gated.registry.get('p'), 7); // 进化（非回滚）
  feed(gated.ledger, gated.key, 4, 0); // n=16 ≥15、k=6 ⇒ 后验 0.8338 < 0.9
  assert.deepEqual(cal.tick(), []); // 不回滚；阈 7 == 现值 7 ⇒ 静默
  assert.equal(gated.registry.get('p'), 7);
  feed(gated.ledger, gated.key, 2, 0); // n=18、k=6 ⇒ 后验 0.9165 ≥ 0.9
  const second = cal.tick();
  assert.equal(second.length, 1);
  assert.ok(second[0].reason.includes('regression-rollback'));
  assert.equal(second[0].to, 8); // 回滚目标 = 血统倒数第二代（promote 前快照值 8）
  assert.equal(gated.registry.get('p'), 8);
});

test('Θ-2c: rollback() 公开径 —— 倒数第二代值 / 无血统回 defaultValue / 原地与未知 key 皆 false', () => {
  const a = makeSetup('p', 8);
  a.lineage.record({ key: 'p', generation: 2, value: 5, fitness: 0.9, createdAt: 1 });
  a.lineage.record({ key: 'p', generation: 3, value: 8, fitness: 0.9, createdAt: 2 });
  assert.equal(a.cal.rollback('p'), true);
  assert.equal(a.registry.get('p'), 5);
  assert.equal(a.cal.rollback('missing-key'), false);

  const b = makeSetup('p', 6); // 无血统：值 6 == defaultValue ⇒ 原地 ⇒ false
  assert.equal(b.cal.rollback('p'), false);
  b.registry.set('p', 9); // 手动拨到 9（无血统）⇒ 回 defaultValue 6
  assert.equal(b.cal.rollback('p'), true);
  assert.equal(b.registry.get('p'), 6);

  const c = makeSetup('p', 3); // 单代血统：无倒数第二代 ⇒ 亦回 defaultValue
  c.registry.set('p', 8);
  c.lineage.record({ key: 'p', generation: 1, value: 5, fitness: 0.5, createdAt: 1 });
  assert.equal(c.cal.rollback('p'), true);
  assert.equal(c.registry.get('p'), 3);
});

test('Θ-2c: history 累积跨 tick + reset 清史 + 防御副本', () => {
  const registry = new KernelRegistry();
  registry.register({ key: 'a', organ: 'θ-2-test', defaultValue: 0.5, min: 0, max: 10 });
  registry.register({ key: 'b', organ: 'θ-2-test', defaultValue: 0.5, min: 0, max: 10 });
  const ledger = new EvidenceLedger();
  feed(ledger, 'a', 3, 27);
  feed(ledger, 'b', 3, 27);
  const cal = new KernelCalibrator({ registry, ledger, lineage: new KernelLineage(), now: () => 7 });
  assert.equal(cal.tick().length, 2);
  assert.equal(cal.history().length, 2);
  cal.reset();
  assert.equal(cal.history().length, 0);
  assert.equal(cal.tick().length, 2); // reset 后照常执法（a/b 各再进一步 1.5→2.5）
  assert.equal(cal.history().length, 2);
  const h = cal.history();
  (h as CalibrationReport[]).push({ key: 'x', from: 0, to: 0, reason: '', generation: 0 });
  assert.equal(cal.history().length, 2); // 防御副本：改 history 返回值不穿透
});

test('Θ-2c: 确定性 —— 同输入同注入时钟 ⇒ tick 报告逐字段相等', () => {
  const s1 = makeSetup();
  const s2 = makeSetup();
  feed(s1.ledger, 'p', 3, 27);
  feed(s2.ledger, 'p', 3, 27);
  assert.deepEqual(s1.cal.tick(), s2.cal.tick());
});

test('Θ-2c: 无 lineage 注入 —— 照常换血，report.generation 回落 registry 现行世代', () => {
  const registry = new KernelRegistry();
  registry.register({ key: 'n', organ: 'θ-2-test', defaultValue: 0.5, min: 0, max: 10 });
  const ledger = new EvidenceLedger();
  feed(ledger, 'n', 3, 27);
  const cal = new KernelCalibrator({ registry, ledger, now: () => 1 });
  const reports = cal.tick();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].to, 1.5);
  assert.equal(reports[0].generation, 0); // registry 出厂世代（set 不动 generation）
  assert.equal(registry.get('n'), 1.5);
});

test('Θ-2c: 垃圾静默 —— 缺器官 / 抛异常器官 / 垃圾参数条目 / set 被拒，皆不抛不产报告', () => {
  // 构造器零参 / 空对象：诚实空转
  assert.deepEqual(new KernelCalibrator().tick(), []);
  assert.deepEqual(new KernelCalibrator({} as unknown as CalibratorOptions).tick(), []);

  // ledger.stats 抛异常：静默
  const regOk = new KernelRegistry();
  regOk.register({ key: 'p', organ: 'θ-2-test', defaultValue: 0.5, min: 0, max: 10 });
  const boomLedger = { stats: () => { throw new Error('boom'); } } as unknown as LedgerContract;
  assert.deepEqual(new KernelCalibrator({ registry: regOk, ledger: boomLedger }).tick(), []);

  // registry.list 抛异常：静默
  const boomRegistry = { list: () => { throw new Error('boom'); } } as unknown as RegistryContract;
  assert.deepEqual(new KernelCalibrator({ registry: boomRegistry, ledger: new EvidenceLedger() }).tick(), []);

  // list 内垃圾条目跳过、合法条目照常执法
  const margins = [1, 1, 1, ...Array<number>(27).fill(9)];
  const stubLedger = { stats: () => ({ n: 40, successRate: 0.9, margins }) } as unknown as LedgerContract;
  const stubRegistry = {
    list: () => [
      null,
      42,
      { key: 'bad', value: Number.NaN, min: 0, max: 1, defaultValue: 0, generation: 0 },
      { key: 'good', value: 0.5, min: 0, max: 10, defaultValue: 0.5, generation: 0 },
    ],
    set: (k: string, v: number) => ({ ok: true, applied: [k, v] }),
  } as unknown as RegistryContract;
  const reports = new KernelCalibrator({ registry: stubRegistry, ledger: stubLedger }).tick();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].key, 'good');
  assert.equal(reports[0].to, 1.5);

  // registry.set 被拒：快照无害留存、不 promote、不立报告
  const frozenRegistry = {
    list: () => [{ key: 'frozen', value: 0.5, min: 0, max: 10, defaultValue: 0.5, generation: 0 }],
    set: () => ({ ok: false, reason: 'frozen' }),
  } as unknown as RegistryContract;
  const lineage = new KernelLineage();
  const frozen = new KernelCalibrator({ registry: frozenRegistry, ledger: stubLedger, lineage, now: () => 1 });
  assert.deepEqual(frozen.tick(), []);
  assert.equal(lineage.generations('frozen').length, 1); // 只有变更前快照，无新世代
  assert.equal(frozen.history().length, 0);
});

// ─── ΑΩ-R39：真标签优先（records）与重建先验回退（reconstructed）的对照与守卫 ───

test('ΑΩ-R39: 真标签生效 —— 反相关证据上真标签阈 1，与重建先验阈 7 给出不同落值', () => {
  // 反相关账面：15 败 margin=9、15 胜 margin=1（margin 高反而败 —— 重建先验的
  // 「margin 单调有益」在此说反话）。真标签（records 路径）：候选 {1,5,9} 上
  // t=1 唯一最大正确率 15/30 ⇒ 阈 1；重建先验（reconstructed）会把 top-50%
  // margins（全 9）伪造为胜 ⇒ 完美分隔 {5,9} 并列 ⇒ 阈 7（见下一用例实测）。
  const s = makeSetup('p', 0.5); // n=30 过证据门；区间 [0,10]、步长上限 1
  for (let i = 0; i < 15; i++) s.ledger.record({ key: 'p', success: false, margin: 9, ts: 1 });
  for (let i = 0; i < 15; i++) s.ledger.record({ key: 'p', success: true, margin: 1, ts: 1 });
  const reports = s.cal.tick();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].labelSource, 'records'); // 真标签在用，如实申报
  assert.ok(reports[0].reason.includes('labels=records'), `reason 应注明标签源：${reports[0].reason}`);
  assert.ok(reports[0].reason.includes('t=1'), `reason 应含真阈 1：${reports[0].reason}`);
  assert.equal(reports[0].to, 1); // 阈 1、|1−0.5|=0.5 不截 ⇒ 落 1（重建先验会落 1.5）
  assert.equal(s.registry.get('p'), 1);
});

test('ΑΩ-R39: 同账面无逐记录口径（历史档 stub）⇒ 回退重建先验，labelSource=reconstructed', () => {
  // 与上一用例同一账面（n=30、rate=0.5、margins 15×1+15×9），但 ledger 只有
  // stats 汇总（历史档 / 旧接口 —— 无 entries 方法）⇒ 回退 reconstructLabels：
  // top-15 margins（全 9）伪造为胜 ⇒ 阈 7 ⇒ 步长截到 1.5 —— 与真标签路径的
  // to=1 构成数字对照面，证明标签源切换真实生效且口径如实申报。
  const registry = new KernelRegistry();
  registry.register({ key: 'p', organ: 'θ-2-test', defaultValue: 0.5, min: 0, max: 10 });
  const margins = [...Array<number>(15).fill(1), ...Array<number>(15).fill(9)];
  const stub = { stats: () => ({ n: 30, successRate: 0.5, margins }) } as unknown as LedgerContract;
  const cal = new KernelCalibrator({ registry, ledger: stub, now: () => 1 });
  const reports = cal.tick();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].labelSource, 'reconstructed');
  assert.ok(reports[0].reason.includes('labels=reconstructed'), `reason 应注明回退：${reports[0].reason}`);
  assert.ok(reports[0].reason.includes('t=7'), `reason 应含重建阈 7：${reports[0].reason}`);
  assert.ok(reports[0].reason.includes('step-capped'));
  assert.equal(reports[0].to, 1.5); // 0.5 + 步长 1 —— 重建先验的指纹
  assert.equal(registry.get('p'), 1.5);
});

test('ΑΩ-R39: 残缺记录 ⇒ 整键回退重建先验（缺 success / entries 抛异常 / 全无 margin）', () => {
  const mk = (entries: () => unknown): { registry: KernelRegistry; cal: KernelCalibrator } => {
    const registry = new KernelRegistry();
    registry.register({ key: 'p', organ: 'θ-2-test', defaultValue: 0.5, min: 0, max: 10 });
    const margins = [...Array<number>(15).fill(1), ...Array<number>(15).fill(9)];
    const ledger = {
      stats: () => ({ n: 30, successRate: 0.5, margins }),
      entries,
    } as unknown as LedgerContract;
    return { registry, cal: new KernelCalibrator({ registry, ledger, now: () => 1 }) };
  };

  // ① 防御恢复残缺：一条带 margin 的记录丢了 success 字段 ⇒ 真标签不完整 ⇒ 整键回退
  const broken = mk(() => [
    { margin: 9 }, // 缺 success：残缺记录
    ...Array.from({ length: 14 }, () => ({ success: false, margin: 9, ts: 1 })),
    ...Array.from({ length: 15 }, () => ({ success: true, margin: 1, ts: 1 })),
  ]);
  const r1 = broken.cal.tick();
  assert.equal(r1.length, 1);
  assert.equal(r1[0].labelSource, 'reconstructed'); // 回退 + 诚实申报
  assert.equal(broken.registry.get('p'), 1.5); // 重建阈 7 ⇒ 截 1.5（若误用残缺真标签会落别处）

  // ② entries 抛异常：静默回退（绝不抛）
  const boom = mk(() => {
    throw new Error('boom');
  });
  const r2 = boom.cal.tick();
  assert.equal(r2.length, 1);
  assert.equal(r2[0].labelSource, 'reconstructed');
  assert.equal(boom.registry.get('p'), 1.5);

  // ③ entries 全无 margin（与 stats 口径对不上账的退化账）⇒ 回退
  const degenerate = mk(() => Array.from({ length: 30 }, () => ({ success: true, ts: 1 })));
  const r3 = degenerate.cal.tick();
  assert.equal(r3.length, 1);
  assert.equal(r3[0].labelSource, 'reconstructed');
  assert.equal(degenerate.registry.get('p'), 1.5);
});

test('ΑΩ-R39: records 路径的诚实下限保持 —— 真标签全同 / 带 margin 样本 <8 ⇒ null 不动', () => {
  // 全同真标签（30 全胜、margin 杂散）：无判定结构可学 ⇒ 无报告、参数不动
  const a = makeSetup('p', 0.5);
  for (let i = 0; i < 30; i++) a.ledger.record({ key: 'p', success: true, margin: (i % 9) + 1, ts: 1 });
  assert.deepEqual(a.cal.tick(), []);
  assert.equal(a.registry.get('p'), 0.5);

  // n=30 过证据门，但带 margin 的记录仅 5 条（<8 诚实下限）⇒ 无报告、参数不动
  const b = makeSetup('p', 0.5);
  for (let i = 0; i < 25; i++) b.ledger.record({ key: 'p', success: true, ts: 1 }); // 无 margin 记录
  for (let i = 0; i < 5; i++) b.ledger.record({ key: 'p', success: i % 2 === 0, margin: i + 1, ts: 1 });
  assert.deepEqual(b.cal.tick(), []);
  assert.equal(b.registry.get('p'), 0.5);
  assert.equal(b.cal.history().length, 0);
});

test('ΑΩ-R39: labelSource 只申报阈学习路径 —— 回归回滚报告无此字段', () => {
  const s = makeSetup('p', 8);
  s.lineage.record({ key: 'p', generation: 2, value: 5, fitness: 0.9, createdAt: 100 });
  s.lineage.record({ key: 'p', generation: 3, value: 8, fitness: 0.9, createdAt: 200 });
  feed(s.ledger, 'p', 16, 24); // n=40、rate 0.6 < 0.9−0.05 ⇒ 回归成立
  const reports = s.cal.tick();
  assert.equal(reports.length, 1);
  assert.ok(reports[0].reason.includes('regression-rollback'));
  assert.equal(reports[0].labelSource, undefined); // 回滚不学阈：无标签源可申报
});

// ─── ΝΩ-6（P1×2）：回归守卫贝叶斯化 + 安全参数分池 + K-4 report-only ───

test('ΝΩ-6: regressionPosteriorMass 闭式手算 —— Beta CDF 的三个解析形 + 垃圾静默', () => {
  // k=0、n=4 ⇒ Beta(1,5)：I_t = 1−(1−t)^5；t=0.3 ⇒ 1−0.7^5 = 1−0.16807 = 0.83193 → 0.8319
  assert.equal(regressionPosteriorMass(0, 4, 0.3), 0.8319);
  // k=4、n=4 ⇒ Beta(5,1)：I_t = t^5；t=0.9 ⇒ 0.9^5 = 0.59049 → 0.5905
  assert.equal(regressionPosteriorMass(4, 4, 0.9), 0.5905);
  // k=2、n=4 ⇒ Beta(3,3) 对称：I_0.5 = 0.5 精确
  assert.equal(regressionPosteriorMass(2, 4, 0.5), 0.5);
  // 二项恒等式（独立于 Lentz 连分式的第二推导径）：整数参数下
  // I_t(k+1, n−k+1) = P(Y ≥ k+1)，Y ~ Bin(n+1, t)。
  // 噪声窗 k=8、n=20、t=0.5：P(Y≥9) = 1 − Σ_{i=0..8} C(21,i)/2^21
  //   = 1 − 401930/2097152 = 0.80831… → 0.8083
  assert.equal(regressionPosteriorMass(8, 20, 0.5), 0.8083);
  // 真回归窗 k=16、n=20、t=0.9：P(Y≥17), Y ~ Bin(21, 0.9) → 0.9478
  assert.equal(regressionPosteriorMass(16, 20, 0.9), 0.9478);
  // 恒等式的在测试内复算（逐项二项概率和，p=0.5 时 term(i+1)/term(i) = (N−i)/(i+1)，
  // 与 Lentz 连分式数值对照 —— 两条独立推导径给出同一位小数）
  {
    const N = 21;
    let cdf = 0;
    let term = 0.5 ** N; // C(N,0)·0.5^N
    for (let i = 0; i <= 8; i++) {
      cdf += term;
      term = (term * (N - i)) / (i + 1);
    }
    close(regressionPosteriorMass(8, 20, 0.5), Math.round((1 - cdf) * 10000) / 10000, 1e-12);
  }
  // 垃圾静默：n ≤ 0 ⇒ 0（无证据零质量）；successes 非有限按 0；越界 k 夹取进 [0,n]
  assert.equal(regressionPosteriorMass(5, 0, 0.9), 0);
  assert.equal(regressionPosteriorMass(Number.NaN, 20, 0.5), regressionPosteriorMass(0, 20, 0.5));
  assert.equal(regressionPosteriorMass(99, 4, 0.9), regressionPosteriorMass(4, 4, 0.9));
  // threshold 收口：≥1 ⇒ 满质量 1（上代 fitness 越界时的护栏语义与旧规则一致）
  assert.equal(regressionPosteriorMass(8, 20, 1), 1);
});

test('ΝΩ-6: 噪声窗不再回滚 —— prev fitness 0.5、窗 n=20 率 0.4（1σ 内波动）照常进化', () => {
  // 同质两窗（真 p≈0.5）：上代 fitness 0.5，本窗 n=20 观察 0.4 —— 二项 σ≈0.11，
  // 这是 −1σ 内的寻常波动。旧频率派规则必回滚（0.4 < 0.5−0.05 = 0.45 ⇒ 代际
  // 振荡回滚、血统账被噪声填满）；新规则后验 P(rate_true<0.5) = 0.8083 < 0.9
  // ⇒ 噪声与真退化不可分 ⇒ 不回滚，照常走阈学习。
  const s = makeSetup('p', 0.5);
  s.lineage.record({ key: 'p', generation: 2, value: 5, fitness: 0.5, createdAt: 100 });
  s.lineage.record({ key: 'p', generation: 3, value: 0.5, fitness: 0.5, createdAt: 200 });
  const cal = new KernelCalibrator({
    registry: s.registry,
    ledger: s.ledger,
    lineage: s.lineage,
    guardrails: { minEvidence: 20, minPostEvidence: 20 },
    now: () => 424242,
  });
  feed(s.ledger, 'p', 12, 8); // n=20、率 0.4、margins [1×12 败, 9×8 胜] ⇒ 阈 5
  const reports = cal.tick();
  assert.equal(reports.length, 1);
  assert.ok(reports[0].reason.includes('optimal-threshold'), `噪声窗应照常进化：${reports[0].reason}`);
  assert.ok(!reports[0].reason.includes('regression'));
  assert.equal(reports[0].to, 1.5); // 0.5 + 步长 1（阈 5 被截）—— 进化而非回滚到 5
  assert.equal(s.registry.get('p'), 1.5);
  // 对照：同证据下的后验手算值（0.8083 < 0.9 —— 判决依据可独立复算）
  assert.ok(regressionPosteriorMass(8, 20, 0.5) < 0.9);
});

test('ΝΩ-6: 真回归窗仍回滚 —— prev 0.9、n=20 率 0.8（后验 0.9478 ≥ 0.9）且报告注明后验', () => {
  const s = makeSetup('p', 8);
  s.lineage.record({ key: 'p', generation: 2, value: 5, fitness: 0.9, createdAt: 100 });
  s.lineage.record({ key: 'p', generation: 3, value: 8, fitness: 0.9, createdAt: 200 });
  const cal = new KernelCalibrator({
    registry: s.registry,
    ledger: s.ledger,
    lineage: s.lineage,
    guardrails: { minEvidence: 20, minPostEvidence: 20 },
    now: () => 424242,
  });
  feed(s.ledger, 'p', 4, 16); // n=20、率 0.8、k=16 ⇒ Beta(17,5) 下尾 I_0.9 = 0.9478
  const reports = cal.tick();
  assert.equal(reports.length, 1);
  assert.ok(reports[0].reason.includes('regression-rollback'), `真回归应回滚：${reports[0].reason}`);
  assert.ok(reports[0].reason.includes('0.948'), `reason 应注明后验质量 0.948：${reports[0].reason}`);
  assert.equal(reports[0].from, 8);
  assert.equal(reports[0].to, 5); // 回滚目标 = 血统倒数第二代值
  assert.equal(s.registry.get('p'), 5);
});

test('ΝΩ-6: 后验门可注入 —— 同窗证据在 rollbackPosteriorMass 0.99 下不回滚（0.9478 < 0.99）', () => {
  const s = makeSetup('p', 8);
  s.lineage.record({ key: 'p', generation: 2, value: 5, fitness: 0.9, createdAt: 100 });
  s.lineage.record({ key: 'p', generation: 3, value: 8, fitness: 0.9, createdAt: 200 });
  const cal = new KernelCalibrator({
    registry: s.registry,
    ledger: s.ledger,
    lineage: s.lineage,
    guardrails: { minEvidence: 20, minPostEvidence: 20, rollbackPosteriorMass: 0.99 },
    now: () => 424242,
  });
  feed(s.ledger, 'p', 4, 16); // 同上一用例的账面：后验 0.9478 < 0.99
  const reports = cal.tick();
  assert.equal(reports.length, 1);
  assert.ok(reports[0].reason.includes('optimal-threshold'), `更严后验门下应照常进化：${reports[0].reason}`);
  assert.equal(reports[0].to, 7); // 阈 5、|5−8|=3 > 步长 1 ⇒ 截到 8−1 = 7
  assert.equal(s.registry.get('p'), 7);
});

test('ΝΩ-6: safetyCritical 键 tick 不动值、报告如实标注 skipped-safety-critical（缺省即生产安全池）', () => {
  const mk = (): { registry: KernelRegistry; ledger: EvidenceLedger; lineage: KernelLineage } => {
    const registry = new KernelRegistry();
    registry.register({ key: 'uncertainty.highProceed', organ: 'uncertainty', defaultValue: 0.85, min: 0.7, max: 1 });
    return { registry, ledger: new EvidenceLedger(), lineage: new KernelLineage() };
  };
  // 证据本会把普通键推向 0.855：3 败 margin 0.72 + 27 胜 margin 0.9 ⇒ 候选
  // {0.72, 0.81, 0.9}，t=0.81 与 t=0.9 并列 30/30（上端相等命中）⇒ 并列中位
  // (0.81+0.9)/2 = 0.855，|0.855−0.85| = 0.005 < 步长上限 0.03（0.1×区间 0.3）
  // 不截 ⇒ 落 0.855（见下一用例实测）
  const feedEvidence = (ledger: EvidenceLedger): void => {
    for (let i = 0; i < 3; i++) ledger.record({ key: 'uncertainty.highProceed', success: false, margin: 0.72, ts: 1 });
    for (let i = 0; i < 27; i++) ledger.record({ key: 'uncertainty.highProceed', success: true, margin: 0.9, ts: 1 });
  };

  // 满证据 + 血统两代（若误入回归/变异径都有落笔处）：跳过须发生在一切执法之前
  const a = mk();
  a.lineage.record({ key: 'uncertainty.highProceed', generation: 2, value: 0.95, fitness: 0.9, createdAt: 100 });
  a.lineage.record({ key: 'uncertainty.highProceed', generation: 3, value: 0.85, fitness: 0.9, createdAt: 200 });
  feedEvidence(a.ledger);
  const calA = new KernelCalibrator({ ...a, now: () => 424242 });
  const reportsA = calA.tick();
  assert.equal(reportsA.length, 1);
  assert.equal(reportsA[0].key, 'uncertainty.highProceed');
  assert.ok(reportsA[0].reason.startsWith('skipped-safety-critical'), `报告应标注 skipped-safety-critical：${reportsA[0].reason}`);
  assert.equal(reportsA[0].from, 0.85);
  assert.equal(reportsA[0].to, 0.85); // 不动值（from == to 零副作用）
  assert.equal(a.registry.get('uncertainty.highProceed'), 0.85); // 金丝雀守卫设计前提未被静默放宽
  assert.equal(a.lineage.generations('uncertainty.highProceed').length, 2); // 不入血统（跳过不是换血）
  assert.deepEqual(calA.history(), reportsA); // 如实入史

  // 零证据也照跳（安全分池先于证据门 —— 围栏不依赖账面状态）
  const b = mk();
  const calB = new KernelCalibrator({ ...b, now: () => 424242 });
  const reportsB = calB.tick();
  assert.equal(reportsB.length, 1);
  assert.ok(reportsB[0].reason.startsWith('skipped-safety-critical'));
  assert.equal(b.registry.get('uncertainty.highProceed'), 0.85);
});

test('ΝΩ-6: 注入空集解除分池（实验室通道）—— 同证据照常校准到 0.855；普通键行为不变', () => {
  const registry = new KernelRegistry();
  registry.register({ key: 'uncertainty.highProceed', organ: 'uncertainty', defaultValue: 0.85, min: 0.7, max: 1 });
  const ledger = new EvidenceLedger();
  for (let i = 0; i < 3; i++) ledger.record({ key: 'uncertainty.highProceed', success: false, margin: 0.72, ts: 1 });
  for (let i = 0; i < 27; i++) ledger.record({ key: 'uncertainty.highProceed', success: true, margin: 0.9, ts: 1 });
  const cal = new KernelCalibrator({
    registry,
    ledger,
    lineage: new KernelLineage(),
    safetyCriticalKeys: [], // 显式解除（实验室恢复进化用；生产路径绝不注入）
    now: () => 424242,
  });
  const reports = cal.tick();
  assert.equal(reports.length, 1);
  assert.ok(reports[0].reason.includes('optimal-threshold'), `解除分池后应照常学阈：${reports[0].reason}`);
  close(reports[0].to, 0.855, 1e-9); // 并列中位阈 (0.81+0.9)/2 = 0.855，不截直接落
  close(registry.get('uncertainty.highProceed') ?? -1, 0.855, 1e-9);
  // 垃圾注入（非数组非集合）fail-safe 回落生产安全池：同账面回到跳过
  const calJunk = new KernelCalibrator({
    registry,
    ledger,
    safetyCriticalKeys: 'garbage' as unknown as readonly string[],
    now: () => 424242,
  });
  assert.ok(calJunk.tick().every(r => r.reason.startsWith('skipped-safety-critical')));
});

test('ΝΩ-6: 缺省安全池 = 生产册 safetyCritical 八键（单一事实源派生）', () => {
  assert.deepEqual([...SAFETY_CRITICAL_KERNEL_KEYS].sort(), [
    'constitution.maxNoEffect',
    'constitution.maxSteps',
    'popup.evidenceClean',
    'popup.evidenceGeo',
    'popup.evidenceSem',
    'popup.offThreshold',
    'popup.onThreshold',
    'uncertainty.highProceed',
  ]);
  // 普通键不在池内（对照锚：同前缀的 uncertainty.highVlm 可校准）
  assert.equal(SAFETY_CRITICAL_KERNEL_KEYS.has('uncertainty.highVlm'), false);
  assert.equal(SAFETY_CRITICAL_KERNEL_KEYS.has('popup.priorWeight'), false);
  assert.equal(SAFETY_CRITICAL_KERNEL_KEYS.has('popup.geoLow'), false);
});

test('K-4(ΝΩ-6): registry.evidence 是 report-only 计数 —— 虚增不改变 tick 判决（双账不串门）', () => {
  // 普查结论（见 calibrator.ts 头注）：evidence 字段无判决消费方（写径
  // memoryOps.addEvidence / store 回放；读径仅 store 持久化与 drift() 报表）⇒
  // 降级 report-only 注记。本测试锁定该不变式：虚增 evidence 计数 9999，
  // tick 的判决与报告须逐字段不变 —— 未来谁把 evidence 接进判决径，这里先红。
  const mk = (inflate: boolean): CalibrationReport[] => {
    const { registry, ledger, lineage, cal } = makeSetup('p', 8);
    lineage.record({ key: 'p', generation: 2, value: 5, fitness: 0.9, createdAt: 100 });
    lineage.record({ key: 'p', generation: 3, value: 8, fitness: 0.9, createdAt: 200 });
    feed(ledger, 'p', 16, 24); // n=40、率 0.6 ⇒ 真回归窗（后验 ≈1 ≥ 0.9）
    if (inflate) registry.addEvidence('p', 9999);
    return cal.tick();
  };
  const plain = mk(false);
  const inflated = mk(true);
  assert.equal(plain.length, 1);
  assert.ok(plain[0].reason.includes('regression-rollback')); // 判决照常：真回归仍回滚
  assert.deepEqual(inflated, plain); // 虚增计数零影响（report-only 的行为学铁证）
});

// ─── ΝΩ-33：GP-UCB 阈学习（闭式对照 / 过拟合抑制 / 安全约束 / 开关与护栏叠加）───

/** ΝΩ-33 反过拟合人工例：F 密簇 0..7 + 孤立噪声 T @10（稀疏区）+ T 密簇 20..27（n=17） */
function e1Window(): { m: number[]; l: boolean[] } {
  const m: number[] = [];
  const l: boolean[] = [];
  for (let i = 0; i <= 7; i++) { m.push(i); l.push(false); }
  m.push(10); l.push(true); // 孤立噪声点：唯一混进分离带的 success
  for (let i = 20; i <= 27; i++) { m.push(i); l.push(true); }
  return { m, l };
}

/** e1 窗喂进真账本（records 路径：逐记录 margin/success） */
function feedE1(ledger: EvidenceLedger, key: string): void {
  const { m, l } = e1Window();
  for (let i = 0; i < m.length; i++) ledger.record({ key, success: l[i], margin: m[i], ts: 1 });
}

test('ΝΩ-33: gpRbf1d 闭式对照 —— 3 点 GP 后验与伴随矩阵独立求逆逐位一致（教科书式）', () => {
  // R&W 式 2.22–2.26 的噪声版：μ*(x) = m + k*ᵀ(K+s²I)⁻¹(y−m)、
  // σ*²(x) = σ_k² − k*ᵀ(K+s²I)⁻¹k*。测试内用伴随矩阵法独立求 3×3 逆 ——
  // 与实现的 Cholesky 三角解构成两条独立推导径（与 Βeta 件的二项恒等式同律）。
  const xs = [0, 1, 2];
  const ys = [0, 0, 1];
  const ls = 1, pv = 1, nv = 0.1, mv = 0.25;
  const k = (a: number, b: number): number => pv * Math.exp(-((a - b) ** 2) / (2 * ls * ls));
  const K = [
    [k(0, 0) + nv, k(0, 1), k(0, 2)],
    [k(1, 0), k(1, 1) + nv, k(1, 2)],
    [k(2, 0), k(2, 1), k(2, 2) + nv],
  ];
  const det =
    K[0][0] * (K[1][1] * K[2][2] - K[1][2] * K[2][1]) -
    K[0][1] * (K[1][0] * K[2][2] - K[1][2] * K[2][0]) +
    K[0][2] * (K[1][0] * K[2][1] - K[1][1] * K[2][0]);
  const cof = (r: number, c: number): number => {
    const rows = [0, 1, 2].filter(i => i !== r);
    const cols = [0, 1, 2].filter(j => j !== c);
    const minor = K[rows[0]][cols[0]] * K[rows[1]][cols[1]] - K[rows[0]][cols[1]] * K[rows[1]][cols[0]];
    return (r + c) % 2 === 0 ? minor : -minor;
  };
  const inv = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) inv[c][r] = cof(r, c) / det; // adj(K)/det
  const expectedMu = (x: number): number => {
    const kv = [k(x, 0), k(x, 1), k(x, 2)];
    let s = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s += kv[i] * inv[i][j] * (ys[j] - mv);
    return mv + s;
  };
  const expectedSigma = (x: number): number => {
    const kv = [k(x, 0), k(x, 1), k(x, 2)];
    let q = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) q += kv[i] * inv[i][j] * kv[j];
    return Math.sqrt(Math.max(0, pv - q));
  };
  const gp = gpRbf1d(xs, ys, { lengthScale: ls, priorVar: pv, noiseVar: nv, meanValue: mv });
  assert.ok(gp, '合法 3 点输入应拟合成功');
  assert.equal(gp.trainedPoints, 3);
  close(gp.mu(1.5), expectedMu(1.5), 1e-12);
  close(gp.sigma(1.5), expectedSigma(1.5), 1e-12);
  close(gp.mu(0), expectedMu(0), 1e-12); // 训练点上同样逐位一致
  close(gp.sigma(2), expectedSigma(2), 1e-12);
  // 教科书极限：远点 k→0 ⇒ μ→均值函数、σ→先验标准差；训练点 σ 严格收缩
  close(gp.mu(50), mv, 1e-9);
  close(gp.sigma(50), 1, 1e-9);
  assert.ok(gp.sigma(1) < 1);
  // 单点闭式：μ = m + k²/(k²+s²)·(y−m)、σ² = σ_k² − k⁴/(k²+s²)（k=σ_k²=1、s²=0.1）
  const single = gpRbf1d([1], [1], { lengthScale: 1, priorVar: 1, noiseVar: 0.1, meanValue: 0.25 });
  assert.ok(single && single.trainedPoints === 1);
  close(single.mu(1), 0.25 + 0.75 / 1.1, 1e-12);
  close(single.sigma(1), Math.sqrt(1 - 1 / 1.1), 1e-12);
  // 垃圾静默：空集 / 全非有限 ⇒ null；超参数垃圾回落缺省（有限输出，绝不抛）
  assert.equal(gpRbf1d([], []), null);
  assert.equal(gpRbf1d([Number.NaN, 1], [0, Number.NaN]), null);
  const junkHyper = gpRbf1d([0, 1], [0, 1], { lengthScale: Number.NaN, priorVar: -1, noiseVar: 0 });
  assert.ok(junkHyper && Number.isFinite(junkHyper.mu(0.5)) && Number.isFinite(junkHyper.sigma(0.5)));
});

test('ΝΩ-33: 过拟合抑制对照 —— 网格法贴噪声峰 8.5，GP-UCB 选平滑分离带中点 15', () => {
  // 网格法：t=8.5（紧贴孤立噪声点 @10 的下沿）唯一最大经验正确率 17/17 —— 把
  // 噪声 success 划进预测侧，贴峰选择；GP 把 @10 的软标签向 F 密簇收缩 ⇒
  // 平滑正确率 A(15)（分离带中点：两簇间的 max-margin 位）反超 A(8.5)。
  const { m, l } = e1Window();
  assert.equal(optimalThreshold(m, l), 8.5); // 对照锚：网格法的贴峰落点
  const gp = optimalThresholdGpUcb(m, l, 0.5);
  assert.ok(gp, '现值 0.5（劣位）应产生候选');
  assert.equal(gp.threshold, 15); // 分离带 (10,20) 的中点 —— 唯一候选即平滑区
  assert.ok(gp.lowerBound >= gp.baseline - 0.02, `入选者的安全下界须过线：lb=${gp.lowerBound} base=${gp.baseline}`);
  assert.ok(gp.aggregateSigma > 0);
  // 确定性：纯线性代数无随机，两次求解逐字段相等
  assert.deepEqual(optimalThresholdGpUcb(m, l, 0.5), gp);
});

test('ΝΩ-33: 安全约束拒绝劣下界 —— 结构混杂窗全候选出局 ⇒ null（保守保持）；网格法仍敢在噪声上取 5.5', () => {
  // 每 margin 一败一胜（n=20、完全混杂、无判定结构可言）：网格法在全体平票 0.5 上
  // 取中位 5.5 —— 纯噪声上也敢动；GP 的聚合 σ̄ ≈ 0.065 ⇒ 一切候选的
  // A − 2σ̄ 都够不着 baseline − ε ⇒ 全出局 ⇒ null（本代不换，保守保持）。
  const m: number[] = [];
  const l: boolean[] = [];
  for (let i = 1; i <= 10; i++) { m.push(i, i); l.push(false, true); }
  assert.equal(optimalThreshold(m, l), 5.5);
  assert.equal(optimalThresholdGpUcb(m, l, 0.5), null);
  // 横向换血同样被拒：现值 14 与候选 15 同预测（A 相等、无悲观改进）⇒ 2σ̄ > ε
  // ⇒ 保守保持（反 churn：证据不足于「至少不变差」就不动）
  const e1 = e1Window();
  assert.equal(optimalThresholdGpUcb(e1.m, e1.l, 14), null);
});

test('ΝΩ-33: gp-ucb 走全执法链 —— 换血/血统/步长截断/报告审计面，且到位后安全门保守保持', () => {
  // e1 窗 + 现值 0.5（劣位）+ 宽步长（maxStepPct 0.5 ⇒ 上限 15）：GP 阈 15 直落
  const registry = new KernelRegistry();
  registry.register({ key: 'p', organ: 'θ-2-test', defaultValue: 0.5, min: 0, max: 30 });
  const ledger = new EvidenceLedger();
  const lineage = new KernelLineage();
  feedE1(ledger, 'p');
  const cal = new KernelCalibrator({
    registry, ledger, lineage,
    guardrails: { minEvidence: 10, maxStepPct: 0.5 },
    thresholdLearner: 'gp-ucb',
    now: () => 424242,
  });
  const reports = cal.tick();
  assert.equal(reports.length, 1);
  const r = reports[0];
  assert.equal(r.labelSource, 'records'); // ΑΩ-R39 真标签口径在学习器之上保持
  assert.ok(r.reason.startsWith('optimal-threshold[gp-ucb]'), `reason 应带 gp-ucb 标：${r.reason}`);
  assert.ok(r.reason.includes('t=15'), `reason 应含阈 15：${r.reason}`);
  assert.ok(r.reason.includes('lb='), `reason 应含安全下界审计：${r.reason}`);
  assert.ok(r.reason.includes('base='), `reason 应含基线审计：${r.reason}`);
  assert.ok(!r.reason.includes('step-capped')); // |15−0.5| = 14.5 ≤ 上限 15 ⇒ 不截
  assert.equal(r.to, 15);
  assert.equal(registry.get('p'), 15);
  const gens = lineage.generations('p');
  assert.equal(gens.length, 2); // 快照 + 新世代（换血入血统照旧）
  assert.equal(gens[1].value, 15);
  // 第二 tick：现值 15 已在等价平台 ⇒ 安全门保守保持（无报告、值不动）
  assert.deepEqual(cal.tick(), []);
  assert.equal(registry.get('p'), 15);

  // 同窗 grid 对照：阈 8.5 直落（同为宽步长）—— 两学习器给出可区分的落值
  const gridRegistry = new KernelRegistry();
  gridRegistry.register({ key: 'p', organ: 'θ-2-test', defaultValue: 0.5, min: 0, max: 30 });
  const gridLedger = new EvidenceLedger();
  feedE1(gridLedger, 'p');
  const gridCal = new KernelCalibrator({
    registry: gridRegistry, ledger: gridLedger,
    guardrails: { minEvidence: 10, maxStepPct: 0.5 },
    now: () => 424242,
  });
  const gridReports = gridCal.tick();
  assert.equal(gridReports[0].to, 8.5);
  assert.equal(gridRegistry.get('p'), 8.5);
});

test('ΝΩ-33: 标准窗步长截断 + 抽稀路径 —— 30 点窗截到 1.5；200 点窗确定性抽稀落 49', () => {
  // 经典 feed 窗（margins {1×3 败, 9×27 胜}、n=30、缺省证据门）：GP 阈 5（{1,5,9}
  // 中数据稀疏侧的分离中点）、|5−0.5| = 4.5 > 步长 1 ⇒ 截到 1.5（与 grid 的
  // 阈 7→1.5 殊途同归：两阈在同一无数据间隙内，预测行为等价）
  const s = makeSetup(); // min=0/max=10、maxStepPct 0.1 ⇒ 上限 1、minEvidence 30
  feed(s.ledger, 'p', 3, 27);
  const cal = new KernelCalibrator({
    registry: s.registry, ledger: s.ledger, lineage: s.lineage,
    thresholdLearner: 'gp-ucb', now: () => 424242,
  });
  const reports = cal.tick();
  assert.equal(reports.length, 1);
  assert.ok(reports[0].reason.includes('[gp-ucb]'));
  assert.ok(reports[0].reason.includes('t=5'), `reason 应含阈 5：${reports[0].reason}`);
  assert.ok(reports[0].reason.includes('step-capped'));
  assert.equal(reports[0].to, 1.5); // 0.5 + 步长 1（步长律对 gp-ucb 同一执法）
  assert.equal(s.registry.get('p'), 1.5);

  // 抽稀路径：200 训练点（>64 ⇒ margin 排序等距抽稀）—— F 密集 0..49、T 密集
  // 50..99，真分界 49.5；抽稀后确定落 49（mid(48,50)，训练集完美分隔壁内）
  const m2: number[] = [];
  const l2: boolean[] = [];
  for (let i = 0; i < 100; i++) { m2.push(i % 50); l2.push(false); }
  for (let i = 0; i < 100; i++) { m2.push(50 + (i % 50)); l2.push(true); }
  const thinned = optimalThresholdGpUcb(m2, l2, 25);
  assert.ok(thinned);
  assert.equal(thinned.threshold, 49);
  assert.deepEqual(optimalThresholdGpUcb(m2, l2, 25), thinned); // 抽稀确定性
});

test('ΝΩ-33: 缺省 grid 零回归 —— 缺省 / 显式 grid / 垃圾注入三者报告逐字节相等', () => {
  const mk = (learner?: ThresholdLearner | number): CalibrationReport[] => {
    const registry = new KernelRegistry();
    registry.register({ key: 'p', organ: 'θ-2-test', defaultValue: 0.5, min: 0, max: 30 });
    const ledger = new EvidenceLedger();
    feedE1(ledger, 'p');
    const cal = new KernelCalibrator({
      registry, ledger, lineage: new KernelLineage(),
      guardrails: { minEvidence: 10, maxStepPct: 0.5 },
      ...(learner === undefined ? {} : { thresholdLearner: learner as ThresholdLearner }),
      now: () => 424242,
    });
    return cal.tick();
  };
  const dflt = mk(undefined);
  const grid = mk('grid');
  const junk = mk(42); // 垃圾注入：fail-safe 回落 grid（旧行为侧）
  const junkStr = mk('GP-UCB' as ThresholdLearner); // 大小写变体同样回落
  assert.equal(dflt.length, 1);
  assert.deepEqual(grid, dflt);
  assert.deepEqual(junk, dflt);
  assert.deepEqual(junkStr, dflt);
  assert.ok(dflt[0].reason.startsWith('optimal-threshold t='), `grid 路径 reason 须与 ΝΩ-33 前逐字节一致（无学习器标）：${dflt[0].reason}`);
  assert.equal(dflt[0].to, 8.5);
});

test('ΝΩ-33: gp-ucb 与 ΝΩ-6 Beta 回归守卫叠加 —— 回滚先于学习器、labelSource 缺席', () => {
  // 真回归窗（n=20、k=16 ⇒ 后验 0.9478 ≥ 0.9）：回归守卫在 ⑤ 短路变异路径 ——
  // gp-ucb 学习器根本不被咨询（学习器只住在 ②），回滚照旧到血统倒数第二代。
  const s = makeSetup('p', 8);
  s.lineage.record({ key: 'p', generation: 2, value: 5, fitness: 0.9, createdAt: 100 });
  s.lineage.record({ key: 'p', generation: 3, value: 8, fitness: 0.9, createdAt: 200 });
  const cal = new KernelCalibrator({
    registry: s.registry, ledger: s.ledger, lineage: s.lineage,
    guardrails: { minEvidence: 20, minPostEvidence: 20 },
    thresholdLearner: 'gp-ucb',
    now: () => 424242,
  });
  feed(s.ledger, 'p', 4, 16);
  const reports = cal.tick();
  assert.equal(reports.length, 1);
  assert.ok(reports[0].reason.includes('regression-rollback'), `真回归应回滚：${reports[0].reason}`);
  assert.ok(!reports[0].reason.includes('gp-ucb')); // 回滚报告不带学习器标（不学阈）
  assert.equal(reports[0].labelSource, undefined);
  assert.equal(reports[0].from, 8);
  assert.equal(reports[0].to, 5);
  assert.equal(s.registry.get('p'), 5);
});

test('ΝΩ-33: gp-ucb 与 safetyCritical 分池叠加 —— 跳过先于一切执法', () => {
  const registry = new KernelRegistry();
  registry.register({ key: 'uncertainty.highProceed', organ: 'uncertainty', defaultValue: 0.85, min: 0.7, max: 1 });
  const ledger = new EvidenceLedger();
  for (let i = 0; i < 3; i++) ledger.record({ key: 'uncertainty.highProceed', success: false, margin: 0.72, ts: 1 });
  for (let i = 0; i < 27; i++) ledger.record({ key: 'uncertainty.highProceed', success: true, margin: 0.9, ts: 1 });
  const cal = new KernelCalibrator({ registry, ledger, thresholdLearner: 'gp-ucb', now: () => 424242 });
  const reports = cal.tick();
  assert.equal(reports.length, 1);
  assert.ok(reports[0].reason.startsWith('skipped-safety-critical')); // ⓪ 先于 ①-⑤ 与学习器
  assert.equal(reports[0].from, 0.85);
  assert.equal(reports[0].to, 0.85);
  assert.equal(registry.get('uncertainty.highProceed'), 0.85);
});

test('ΝΩ-33: gp-ucb 诚实下限与垃圾静默 —— <8 / 全同 label / 现值非有限 ⇒ null 不抛', () => {
  const { m, l } = e1Window();
  assert.equal(optimalThresholdGpUcb(null as unknown as number[], null as unknown as boolean[], 1), null);
  assert.equal(optimalThresholdGpUcb(undefined as unknown as number[], undefined as unknown as boolean[], 1), null);
  assert.equal(optimalThresholdGpUcb([1, 2, 3, 4, 5, 6, 7], [true, false, true, false, true, false, true], 1), null); // <8
  assert.equal(optimalThresholdGpUcb([1, 2, 3, 4, 5, 6, 7, 8], Array<boolean>(8).fill(true), 1), null); // 全同 label
  assert.equal(optimalThresholdGpUcb(m, l, Number.NaN), null); // 现值非有限
  // 非有限 margin / 非布尔 label 剔队后仍 8 对完美分隔 ⇒ 非空且阈在界内（不抛）
  const cleaned = optimalThresholdGpUcb(
    [1, 2, 3, 4, 6, 7, 8, 9, Number.NaN, Number.POSITIVE_INFINITY],
    [false, false, false, false, true, true, true, true, true, 1 as unknown as boolean],
    0.5,
  );
  assert.ok(cleaned && Number.isFinite(cleaned.threshold));
  assert.ok(cleaned!.threshold >= 4 && cleaned!.threshold <= 9);
});
