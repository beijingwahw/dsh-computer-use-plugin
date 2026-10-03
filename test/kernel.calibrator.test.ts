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
  DEFAULT_GUARDRAILS,
} from '../src/kernel/calibrator.ts';
import type { CalibrationReport, CalibratorOptions } from '../src/kernel/calibrator.ts';
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
  assert.equal(DEFAULT_GUARDRAILS.rollbackDrop, 0.05);
  assert.equal(DEFAULT_GUARDRAILS.minPostEvidence, 20);
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

test('Θ-2c: 回归边界 —— rate 恰等 上代fitness−drop 不判回归（严格小于）；证据不足不判', () => {
  const mk = (nFail: number, nSucc: number) => {
    const s = makeSetup('p', 8);
    s.lineage.record({ key: s.key, generation: 2, value: 5, fitness: 0.8, createdAt: 100 });
    s.lineage.record({ key: s.key, generation: 3, value: 8, fitness: 0.8, createdAt: 200 });
    feed(s.ledger, s.key, nFail, nSucc);
    return s;
  };
  // n=32、rate 24/32=0.75 == 0.8−0.05 ⇒ 未跌出容忍带（严格小于才判）⇒ 不回滚，
  // 照常进化：阈 7、|7−8|=1 == limit 不截 ⇒ 到 7
  const edge = mk(8, 24);
  const reports = edge.cal.tick();
  assert.equal(reports.length, 1);
  assert.ok(reports[0].reason.includes('optimal-threshold'));
  assert.ok(!reports[0].reason.includes('regression'));
  assert.ok(!reports[0].reason.includes('step-capped'));
  assert.equal(edge.registry.get('p'), 7);

  // minPostEvidence 门：护栏 {minEvidence:10, minPostEvidence:15} —— n=12 不判回归照常进化；
  // 补到 n=16、率跌至 0.375 < 快照 fitness 0.5−0.05 ⇒ 回滚掉上一次 promote（回到快照值 8）
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
  feed(gated.ledger, gated.key, 4, 0); // n=16 ≥15、rate 6/16=0.375
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
