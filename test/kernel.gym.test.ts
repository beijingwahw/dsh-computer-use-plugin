// test/kernel.gym.test.ts
// 纪元 Θ（Θ-3 内核进化）测试：训练营用虚拟世界 ground truth 校准感知/仲裁内核
// 参数 —— ① 训练后实验室台账有 world.hammingTolerance 记账；② 容差故意设错
// （8，过松）⇒ 校准器朝正确方向收敛且绝不出 [1,8]、单步不超护栏步长；
// ③ 生产隔离铁证（训练前后生产单例 snapshot 逐字节不变）；④ GymReport.kernel
// 摘要在场且确定；⑤ 显式晋升 API（promoteFrom）可用。全离线、确定性。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AutonomyGym } from '../src/autonomy/gym.ts';
import { KernelRegistry, EvidenceLedger, kernelRegistry } from '../src/kernel/registry.ts';
import { KernelCalibrator } from '../src/kernel/calibrator.ts';

/** 固定训练种子（与既有 G 用例同源 ⇒ 世界轨迹已知） */
const SEED = 4242;

// ─── Θ-1：训练产生 ground truth 记账 ───

test('Θ-1: train 后实验室台账有 world.hammingTolerance 记账（n ≥ 1）且缺省值 = 3', async () => {
  const gym = new AutonomyGym({ seed: SEED });
  assert.ok(gym.lab, '缺省构造 ⇒ 馆内自铸完整实验室套件');
  assert.ok(gym.lab.registry instanceof KernelRegistry);
  assert.ok(gym.lab.ledger instanceof EvidenceLedger);
  assert.ok(gym.lab.calibrator instanceof KernelCalibrator);

  // 首批内核参数已注册：键在册、缺省值与 census 缺省一致（hamming=3 ⇒ 零漂移锚）
  assert.equal(gym.lab.registry.get('world.hammingTolerance'), 3);
  assert.equal(gym.lab.registry.get('arbitration.iouThreshold'), 0.5);
  assert.equal(gym.lab.registry.get('arbitration.agreementBonus'), 0.15);
  assert.equal(gym.lab.registry.get('policy.matchConfident'), 0.55);

  await gym.train(2);

  const stats = gym.lab.ledger.stats('world.hammingTolerance');
  assert.ok(stats.n >= 1, `world.hammingTolerance 应有记账（实测 n=${stats.n}）`);
  assert.equal(stats.n, gym.lab.ledger.stats('world.hammingTolerance').n, '台账统计可重复读取');
  assert.ok(Array.isArray(stats.margins), 'margins 应为数组');
  // 其余首批键同样有对账证据（仲裁键与策略键）
  assert.ok(gym.lab.ledger.stats('arbitration.iouThreshold').n >= 1);
  assert.ok(gym.lab.ledger.stats('policy.matchConfident').n >= 1);
});

// ─── Θ-2：容差故意设错 ⇒ 校准器朝正确方向移动 ───

test('Θ-2: 容差故意设 8（过松）⇒ tick 后朝正确方向（向下）移动、绝不出 [1,8]、单步不超护栏', async () => {
  // 自铸实验室（显式护栏：单步 ≤ maxStepPct —— pct-of-range 0.7 与 pct-of-value 0.8 取宽）
  const registry = new KernelRegistry();
  const ledger = new EvidenceLedger();
  const calibrator = new KernelCalibrator({
    registry,
    ledger,
    guardrails: { minEvidence: 3, maxStepPct: 0.1, rollbackDrop: 0.2, minPostEvidence: 2 },
  });
  const gym = new AutonomyGym({ seed: SEED, kernel: { registry, ledger, calibrator } });
  assert.ok(gym.lab && gym.lab.registry === registry, '注入实验室套件应原样接管');

  // 构造期已注册首批参数 ⇒ 现在故意把容差设错：8 = 过松（真实状态变化在
  // 距离 6 处会被漏判为「没动」）
  registry.set('world.hammingTolerance', 8);
  assert.equal(registry.get('world.hammingTolerance'), 8);

  // 注入诚实的漏报样本：合成帧刻意做到页间距离 ≥16（dhash 分离的物理保障），
  // 靠训练自身无法产生近阈值误判 —— 用台账公开口径补真实世界近阈值噪声：
  // 距离 6 的真实变化在容差 8 下被漏判 ⇒ success:false、margin = 6 - 8 = -2
  // （有符号距离差，负号即「容差过松、应下调」的方向编码）。
  for (let i = 0; i < 60; i++) {
    ledger.record({ key: 'world.hammingTolerance', success: false, margin: -2, ts: i });
  }

  const report = await gym.train(4); // 多轮训练 ⇒ 每轮收官 tick()

  const after = registry.get('world.hammingTolerance');
  assert.ok(after !== null, '校准后键仍在册');
  assert.ok((after as number) < 8, `容差应朝正确方向（向下）移动（8 → ${after}）`);
  assert.ok((after as number) >= 1 && (after as number) <= 8, `绝不出 [1,8]（实测 ${after}）`);

  // 单步护栏：每份 hammingTolerance 校准报告的 |to - from| 不超护栏步长
  // （0.1 × 区间宽 7 = 0.7 与 0.1 × 现值 8 = 0.8 的较宽者）
  const hamReports = report.kernel.calibrations.filter(c => c.key === 'world.hammingTolerance');
  assert.ok(hamReports.length >= 1, '应至少产生一份 hammingTolerance 校准报告');
  for (const c of hamReports) {
    assert.ok(
      Math.abs(c.to - c.from) <= 0.8 + 1e-9,
      `单步不超护栏步长（${c.from} → ${c.to}）`,
    );
  }

  // 训练自身的记账也进了同一本台账（注入样本 + 训练样本同册）
  assert.ok(ledger.stats('world.hammingTolerance').n >= 60);
});

// ─── Θ-3：生产隔离铁证 ───

test('Θ-3: 生产隔离 —— 训练前后生产单例 snapshot 逐字节不变（实验室进化不泄漏生产）', async () => {
  const before = kernelRegistry.snapshot();

  const gym = new AutonomyGym({ seed: SEED });
  await gym.train(4); // 实验室全程记账 + tick 演化

  // 铁证：生产单例逐字节不变（deepEqual 全量对照）
  assert.deepEqual(kernelRegistry.snapshot(), before, '生产内核 snapshot 必须逐字节不变');

  // 对照面：实验室确实在演化（有参数、有台账），却丝毫未进生产 —— 隔离非空转
  const labSnap = gym.lab?.registry.snapshot() ?? {};
  assert.ok(Object.keys(labSnap).length >= 4, `实验室应持有首批内核参数（实测 ${JSON.stringify(labSnap)}）`);
  assert.ok((gym.lab?.ledger.stats('world.hammingTolerance').n ?? 0) >= 1, '实验室台账非空');
});

// ─── Θ-4：GymReport.kernel 摘要 ───

test('Θ-4: GymReport.kernel 摘要在场（paramsTouched / calibrations）且报告确定性不破坏', async () => {
  const gym = new AutonomyGym({ seed: 77 });
  const report = await gym.train(2);

  assert.ok(report.kernel, 'kernel 摘要字段应在场');
  assert.equal(typeof report.kernel.paramsTouched, 'number');
  assert.ok(report.kernel.paramsTouched >= 1, `至少一个内核参数被对账（实测 ${report.kernel.paramsTouched}）`);
  assert.ok(Array.isArray(report.kernel.calibrations), 'calibrations 应为数组');
  for (const c of report.kernel.calibrations) {
    assert.equal(typeof c.key, 'string');
    assert.equal(typeof c.from, 'number');
    assert.equal(typeof c.to, 'number');
  }
  // 逐轮摘要与平铺一致
  const flat = report.rounds.flatMap(r => r.kernelCalibrations ?? []);
  assert.deepEqual(report.kernel.calibrations, flat, 'kernel.calibrations = 各轮校准平铺');

  // 确定性不因内核字段破坏：同 seed 同构造两次 train 逐字段一致（含 kernel 摘要）
  const again = await new AutonomyGym({ seed: 77 }).train(2);
  assert.deepEqual(report, again, '同 seed 复跑 ⇒ 报告（含 kernel 摘要）逐字段一致');
});

// ─── Θ-5：显式晋升通路 ───

test('Θ-5: 显式晋升 —— kernelRegistry.promoteFrom(gym.lab.registry) 后生产侧拿到实验室值', async () => {
  const before = kernelRegistry.snapshot(); // 演示毕还原，不留生产痕迹

  // 晋升的 key 域 = 双方在册交集 ⇒ 生产侧须先在册同域参数（生产自己的规格）
  for (const spec of [
    { key: 'world.hammingTolerance', organ: 'perception', defaultValue: 3, min: 1, max: 8 },
    { key: 'arbitration.iouThreshold', organ: 'arbitration', defaultValue: 0.5, min: 0.3, max: 0.8 },
    { key: 'arbitration.agreementBonus', organ: 'arbitration', defaultValue: 0.15, min: 0, max: 0.3 },
    { key: 'policy.matchConfident', organ: 'policy', defaultValue: 0.55, min: 0.3, max: 0.9 },
  ]) {
    kernelRegistry.register(spec);
  }

  const gym = new AutonomyGym({ seed: SEED });
  await gym.train(2);
  // 给实验室一个醒目的演示值（晋升应原样搬运实验室现值）
  gym.lab?.registry.set('world.hammingTolerance', 5);

  const labSnap = gym.lab?.registry.snapshot() ?? {};
  const promoted = kernelRegistry.promoteFrom(gym.lab!.registry);
  assert.ok(promoted.length >= 1, `晋升清单非空（实测 ${JSON.stringify(promoted)}）`);

  const after = kernelRegistry.snapshot();
  // 生产侧逐键拿到实验室现值（首批四键全量对照）
  for (const [key, value] of Object.entries(labSnap)) {
    assert.equal(
      after[key],
      value,
      `晋升后生产侧 ${key} 应为实验室值 ${value}（实测 ${after[key]}）`,
    );
  }
  assert.equal(kernelRegistry.get('world.hammingTolerance'), 5, '演示值 5 经显式晋升进生产');

  // 还原生产单例（演示不留痕：清册后回放演示前快照 ⇒ 回到 pristine）
  kernelRegistry.reset();
  kernelRegistry.restore(before);
  assert.deepEqual(kernelRegistry.snapshot(), before, '还原后生产 snapshot 复原');
});
