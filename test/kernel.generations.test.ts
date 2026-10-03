// test/kernel.generations.test.ts
// 纪元 Ξ（Ξ-C 训练营多代进化）测试：跨代血统可见、参数收敛可证、宪法两键接上
// 注册表 —— ① 两代训练后 lineage ≥2 代记录、trends 在场（数值或 0）；
// ② 收敛证明：容差故意设 8 + trainGenerations(3,4) ⇒ lastValue 逐代向已知良好
// 值 3 逼近（单调或护栏步长内）、withinPct 收窄、3 代内至少 2 次移动方向正确；
// ③ 宪法接线：两键未注册 ⇒ 行为 = 3/40（既有回归）；注册并 set
// ('constitution.maxNoEffect',5) ⇒ 僵局判定阈值随之变（构造行为直测 + 小数防御）；
// ④ 生产隔离：trainGenerations 前后生产单例 snapshot deepEqual 不变；
// ⑤ GymGenerationsReport 结构与 summary 非空 + 确定性复跑。
// 全离线、确定性；动生产册的用例自带 try/finally 还原（零测试顺序依赖）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AutonomyGym, type GymGenerationsReport } from '../src/autonomy/gym.ts';
import { KernelRegistry, EvidenceLedger, kernelRegistry } from '../src/kernel/registry.ts';
import { KernelCalibrator } from '../src/kernel/calibrator.ts';
import { KernelLineage } from '../src/kernel/lineage.ts';
import { AutonomyConstitution } from '../src/autonomy/autonomyConstitution.ts';
import type { PolicyAction } from '../src/autonomy/policyEngine.ts';

/** 固定训练种子（与既有 Θ 用例同源 ⇒ 世界轨迹已知） */
const SEED = 4242;

/**
 * 铸一座「容差故意设错」的实验室馆：registry/ledger/lineage 注入（校准器由馆内
 * 自铸 ⇒ 血统挂入校准器 + 虚拟时钟 ⇒ 全确定），随后把 world.hammingTolerance
 * 设 8（过松）并注入 60 条历史误报证据（success:false、margin:+3 = 入账当时
 * 容差 8 下、距离 11 的未变帧被误判为变化 —— 台账是历史日志，margin 按入账当时
 * 的容差计；与 Θ-2 的漏报样本（margin −2）互补的另一侧近阈值噪声）。
 * 收敛机理：训练营自身的成功样本 margin 随容差现值走（同帧感知 margin = t、
 * 页变化 margin = d−t ≥ 8），最优分离阈落在「+3 误报带」与「成功样本下沿」
 * 之间 ⇒ 目标恒低于现值 ⇒ 逐代向固定点 3（= 已知良好值）逼近。
 */
function miscalibratedGym(): {
  gym: AutonomyGym;
  registry: KernelRegistry;
  ledger: EvidenceLedger;
  lineage: KernelLineage;
} {
  const registry = new KernelRegistry();
  const ledger = new EvidenceLedger();
  const lineage = new KernelLineage();
  const gym = new AutonomyGym({ seed: SEED, kernel: { registry, ledger, lineage } });
  assert.equal(registry.set('world.hammingTolerance', 8).ok, true, '预调容差 8（过松）');
  for (let i = 0; i < 60; i++) {
    ledger.record({ key: 'world.hammingTolerance', success: false, margin: 3, ts: i });
  }
  return { gym, registry, ledger, lineage };
}

/** 从报告重建 world.hammingTolerance 的逐代末值轨迹（校准报告按序回放） */
function hammingTrajectory(report: GymGenerationsReport, start: number): number[] {
  const ends: number[] = [];
  let v = start;
  for (const gen of report.generations) {
    for (const c of gen.calibrations) {
      if (c.key === 'world.hammingTolerance') v = c.to;
    }
    ends.push(v);
  }
  return ends;
}

/** 最小合法动作（宪法裁决用：观察族 wait ⇒ 恒 benign，裁决只随账目变） */
function waitAction(): PolicyAction {
  return { kind: 'wait', rationale: '测试动作', expectedEffect: '无', utility: 0.5, riskTier: 'benign' };
}

// ─── Ξ-1：跨代血统可见 ───

test('Ξ-1: 两代训练后 lineage ≥2 代记录、trends 在场（数值或 0）；默认馆自带血统且 lab 三元组形状不变', async () => {
  // 默认馆：血统第四器官经独立 getter 暴露；lab 三元组（registry/ledger/calibrator）形状不动
  const plain = new AutonomyGym({ seed: SEED });
  assert.ok(plain.labLineage instanceof KernelLineage, '缺省构造 ⇒ 馆内自铸血统');
  assert.ok(plain.lab, 'lab 三元组仍在场');
  assert.ok(plain.lab!.registry instanceof KernelRegistry);
  assert.ok(plain.lab!.ledger instanceof EvidenceLedger);
  assert.ok(plain.lab!.calibrator instanceof KernelCalibrator);

  // 注入血统被原样接管（跨馆共享血统的口径）
  const { gym, lineage } = miscalibratedGym();
  assert.ok(gym.labLineage === lineage, '注入 lineage 应原样接管');

  // 两代训练：换血经馆内自铸校准器记谱立代（血统接线的行为验证 —— 校准器不外露血统字段）
  const report = await gym.trainGenerations(2, 4);
  const gens = lineage.generations('world.hammingTolerance');
  assert.ok(gens.length >= 2, `两代训练后血统应有 ≥2 代记录（实测 ${gens.length}）`);
  assert.ok(gens.every(g => Number.isFinite(g.value) && Number.isFinite(g.fitness)), '世代档案数值完整');

  // trends 在场：fitnessTrend 为数值（<2 代 ⇒ 0 的诚实下限），首末值与血统链一致
  const trend = report.trends.find(t => t.key === 'world.hammingTolerance');
  assert.ok(trend, `trends 应含 world.hammingTolerance（实测 ${JSON.stringify(report.trends)}）`);
  assert.ok(Number.isFinite(trend!.fitnessTrend), 'fitnessTrend 应为数值');
  assert.equal(trend!.generations, gens.length, 'trend.generations = 血统世代数');
  assert.equal(trend!.firstValue, gens[0].value, 'firstValue = 血统链首代值');
  assert.equal(trend!.lastValue, gens[gens.length - 1].value, 'lastValue = 血统链末代值');
});

// ─── Ξ-2：收敛证明 ───

test('Ξ-2: 收敛证明 —— 容差故意设 8 + trainGenerations(3,4) ⇒ 逐代向 3 逼近、withinPct 收窄、≥2 代方向正确', async () => {
  const { gym, registry } = miscalibratedGym();
  const report = await gym.trainGenerations(3, 4);
  assert.equal(report.generations.length, 3);
  assert.ok(report.generations.every(g => g.rounds === 4), '每代恰 4 轮');

  // 单步护栏回归：每份 hamming 换血 |to−from| ≤ 0.1×区间宽 7 = 0.7（+ε）
  const moves = report.generations.flatMap(g =>
    g.calibrations.filter(c => c.key === 'world.hammingTolerance'),
  );
  assert.ok(moves.length >= 1, '应至少一次换血');
  for (const m of moves) {
    assert.ok(Math.abs(m.to - m.from) <= 0.7 + 1e-9, `单步不超护栏步长（${m.from} → ${m.to}）`);
  }

  // 逐代末值轨迹：恒在护栏区间内、每代至多 4 次换血×单步、向 3 逼近且 ≥2 代方向正确
  const traj = hammingTrajectory(report, 8);
  assert.equal(traj.length, 3);
  let v = 8;
  let correct = 0;
  for (const end of traj) {
    assert.ok(end >= 1 && end <= 8, `值恒在护栏区间 [1,8]（实测 ${end}）`);
    assert.ok(Math.abs(end - v) <= 4 * 0.7 + 1e-9, `每代至多 4 次换血 × 单步 0.7（${v} → ${end}）`);
    if (Math.abs(end - 3) < Math.abs(v - 3) - 1e-9) correct += 1;
    v = end;
  }
  assert.ok(
    correct >= 2,
    `3 代内至少 2 次移动方向正确（实测 ${correct}，轨迹 ${JSON.stringify(traj)}）`,
  );
  const last = traj[traj.length - 1];
  assert.ok(Math.abs(last - 3) < Math.abs(8 - 3), `末值比 8 更靠近 3（8 → ${last}）`);

  // withinPct 收窄：收敛探针末值偏差远小于初值偏差（166.7%）
  const conv = report.converged.find(c => c.key === 'world.hammingTolerance');
  assert.ok(conv, 'converged 应含 world.hammingTolerance');
  const initialPct = (Math.abs(8 - 3) / 3) * 100;
  assert.ok(
    conv!.withinPct < initialPct,
    `withinPct 收窄（${initialPct.toFixed(1)}% → ${conv!.withinPct.toFixed(1)}%）`,
  );
  assert.equal(registry.get('world.hammingTolerance'), conv!.value, '注册表现值 = 探针值（同一事实源）');

  // 收敛终点落在已知良好带 3±1 内（实测确定性轨迹：8 → 5.9 → 4.075 → 3.538）
  assert.ok(Math.abs(conv!.value - 3) <= 1, `末值落在 3±1 良好带（实测 ${conv!.value}）`);

  // 血统同步在场（收敛的每一跳都是一次立代）
  assert.ok(gym.labLineage !== null && gym.labLineage.generations('world.hammingTolerance').length >= 2);
});

// ─── Ξ-3：生产隔离 ───

test('Ξ-3: 生产隔离 —— trainGenerations 前后生产单例 snapshot deepEqual 不变；宪法两键只入实验室册', async () => {
  const before = kernelRegistry.snapshot();

  const gym = new AutonomyGym({ seed: SEED });
  const report = await gym.trainGenerations(2, 2);
  assert.equal(report.generations.length, 2);

  // 铁证：生产单例逐字节不变（多代进化不泄漏生产）
  assert.deepEqual(kernelRegistry.snapshot(), before, '生产内核 snapshot 必须逐字节不变');

  // 对照面：实验室确实在动 —— 宪法两键已入实验室册（供实验室进化），生产册查无此键
  assert.ok(gym.lab && gym.lab.registry.has('constitution.maxNoEffect'), '宪法卡死键入实验室册');
  assert.ok(gym.lab!.registry.has('constitution.maxSteps'), '宪法步数键入实验室册');
  assert.equal(gym.lab!.registry.get('constitution.maxNoEffect'), 3, '实验室缺省 = 宪法现行缺省（零漂移锚）');
  assert.equal(gym.lab!.registry.get('constitution.maxSteps'), 40);
  assert.equal(kernelRegistry.has('constitution.maxNoEffect'), false, '生产册查无此键（批次 B 前不入生产）');
  assert.ok(Object.keys(gym.lab!.registry.snapshot()).length >= 6, '实验室键域 = Θ 四键 + Ξ 宪法两键');
});

// ─── Ξ-4：报告结构与确定性 ───

test('Ξ-4: GymGenerationsReport 结构（默认 2 代×4 轮）与 summary 非空；同 seed 复跑逐字段一致', async () => {
  const report = await new AutonomyGym({ seed: 77 }).trainGenerations();

  assert.equal(report.generations.length, 2, '缺省 2 代');
  for (let i = 0; i < report.generations.length; i++) {
    const gen = report.generations[i];
    assert.equal(gen.index, i, 'index 0 起');
    assert.equal(gen.rounds, 4, '缺省每代 4 轮');
    assert.equal(typeof gen.paramsTouched, 'number');
    assert.ok(gen.paramsTouched >= 1, `每代至少一个内核参数被对账（实测 ${gen.paramsTouched}）`);
    assert.ok(Array.isArray(gen.calibrations), 'calibrations 应为数组');
  }
  assert.ok(Array.isArray(report.trends), 'trends 应为数组');
  assert.ok(report.converged.length >= 1, 'converged 非空（目标表 ∩ 实验室在册）');
  const ham = report.converged.find(c => c.key === 'world.hammingTolerance');
  assert.ok(ham, 'converged 应含 world.hammingTolerance');
  assert.ok(Number.isFinite(ham!.value) && ham!.value >= 1 && ham!.value <= 8, '探针值在护栏区间');
  assert.ok(typeof ham!.withinPct === 'number' && ham!.withinPct >= 0, 'withinPct 为非负数');
  assert.ok(typeof report.summary === 'string' && report.summary.length > 0, 'summary 非空');

  // 确定性：同 seed 同构造两次 trainGenerations 逐字段一致（含血统趋势与探针）
  const again = await new AutonomyGym({ seed: 77 }).trainGenerations();
  assert.deepEqual(report, again, '同 seed 复跑 ⇒ 多代报告逐字段一致');
});

// ─── Ξ-5/Ξ-6：宪法两键接线（未注册回归 / 注册生效） ───

test('Ξ-5: 宪法接线 —— 两键未注册时行为与接线前逐字节一致（3/40 缺省 + 判决边界 + partial 覆写优先）', () => {
  const c = new AutonomyConstitution();
  assert.equal(c.rules.maxConsecutiveNoEffect, 3, '未注册 ⇒ getOrDefault 回声字面量 3');
  assert.equal(c.rules.maxTotalSteps, 40, '未注册 ⇒ getOrDefault 回声字面量 40');
  // 判决行为回归：卡死 3 拦 / 2 放；超步 40 拦 / 39 放
  assert.equal(c.check(waitAction(), { consecutiveNoEffect: 3, stepsTaken: 0 }).allowed, false);
  assert.equal(c.check(waitAction(), { consecutiveNoEffect: 2, stepsTaken: 0 }).allowed, true);
  assert.equal(c.check(waitAction(), { consecutiveNoEffect: 0, stepsTaken: 40 }).allowed, false);
  assert.equal(c.check(waitAction(), { consecutiveNoEffect: 0, stepsTaken: 39 }).allowed, true);
  // partial 显式覆写照旧优先（构造期 merge 律：传了才覆写）
  const p = new AutonomyConstitution({ maxConsecutiveNoEffect: 2, maxTotalSteps: 10 });
  assert.equal(p.rules.maxConsecutiveNoEffect, 2);
  assert.equal(p.rules.maxTotalSteps, 10);
});

test('Ξ-6: 注册并 set ⇒ 僵局/步数阈值随注册表变（构造期读表直测）+ 小数进化防御 + 还原不留痕', () => {
  const before = kernelRegistry.snapshot();
  try {
    // 实验室同款规格入生产册（批次 B 前的测试自行入册； defaultValue = 现行缺省）
    kernelRegistry.register({
      key: 'constitution.maxNoEffect',
      organ: 'constitution',
      defaultValue: 3,
      min: 2,
      max: 6,
      note: 'Ξ-6 测试入册',
    });
    kernelRegistry.register({
      key: 'constitution.maxSteps',
      organ: 'constitution',
      defaultValue: 40,
      min: 10,
      max: 80,
      note: 'Ξ-6 测试入册',
    });
    assert.equal(kernelRegistry.set('constitution.maxNoEffect', 5).ok, true);
    assert.equal(kernelRegistry.set('constitution.maxSteps', 25).ok, true);

    const c = new AutonomyConstitution();
    assert.equal(c.rules.maxConsecutiveNoEffect, 5, '构造期读表 ⇒ 僵局阈值 = 注册表现值 5');
    assert.equal(c.rules.maxTotalSteps, 25, '构造期读表 ⇒ 步数硬顶 = 注册表现值 25');
    // 阈值上移的可观察差异：4 仍放行（缺省 3 时 4 早已拦）、5 才拦
    assert.equal(c.check(waitAction(), { consecutiveNoEffect: 5, stepsTaken: 0 }).allowed, false, '5 才拦');
    assert.equal(c.check(waitAction(), { consecutiveNoEffect: 4, stepsTaken: 0 }).allowed, true, '4 仍放行 —— 阈值确为 5');
    assert.equal(c.check(waitAction(), { consecutiveNoEffect: 0, stepsTaken: 25 }).allowed, false);
    assert.equal(c.check(waitAction(), { consecutiveNoEffect: 0, stepsTaken: 24 }).allowed, true);

    // 小数进化防御：registry 值可能被进化成小数 ⇒ 消费处 Math.max(1, Math.round(v))
    kernelRegistry.set('constitution.maxNoEffect', 4.6);
    assert.equal(new AutonomyConstitution().rules.maxConsecutiveNoEffect, 5, 'Math.round(4.6) = 5');
    kernelRegistry.set('constitution.maxNoEffect', 4.4);
    assert.equal(new AutonomyConstitution().rules.maxConsecutiveNoEffect, 4, 'Math.round(4.4) = 4');

    // partial 显式覆写压过注册表；未传字段回落注册表缺省（构造期 merge 律）
    const explicit = new AutonomyConstitution({ maxConsecutiveNoEffect: 2 });
    assert.equal(explicit.rules.maxConsecutiveNoEffect, 2);
    assert.equal(explicit.rules.maxTotalSteps, 25, '未传字段回落注册表现值');
  } finally {
    // 还原生产单例（测试不留痕）
    kernelRegistry.reset();
    kernelRegistry.restore(before);
    assert.deepEqual(kernelRegistry.snapshot(), before, '还原后生产 snapshot 复原');
  }
});
