// test/epochKappa.curriculum.test.ts
// 纪元 Κ（惊异课程）执法测试 —— 文件头执法编号：
//   Κ-1 偏向执法：合成谱 {A:8, B:0.5, C:0.5, D:0.5} 固定 seed 采样 2000 次 ⇒
//        高惊异类型 A 显著占优（>70%）且各类型都被采到（探索不为零）；
//        前置核对谱生产者 surpriseSpectrum 的诚实聚合（缺席/空 ⇒ 空对象、
//        出弧观察按次数加权平均、与 surprise() 方法同口径）。
//   Κ-2 均匀回退：空谱/缺席谱/全零谱/含 NaN 谱 ⇒ 四类型近似均匀（25%±5pp），
//        fallback 标记在场、surprise=0（无证据的诚实读数）、p=1/4。
//   Κ-3 确定性：同 seed 同谱 ⇒ 采样序列（含铸成任务）逐项一致；异 seed ⇒ 不同。
//   Κ-4 隔离执法：curriculumEnabled=false ⇒ 既有入口路径不变（KIND_ORDER 轮转
//        指纹 + 报告无课程字段 + 显式 enabled:false 带毒谱仍逐字段同旧路径 +
//        同 seed 复跑一致）；课程开的训练不触碰生产 kernelRegistry（Θ-3 隔离律）；
//        β 数值稳定：极端大谱（1e6 bits）与极端 β 绝不产生 NaN/Infinity。
// 全离线、rng 注入（mulberry32）、确定性。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AutonomyGym,
  generateTasks,
  mulberry32,
  sampleCurriculumWorld,
  type CurriculumSample,
} from '../src/autonomy/gym.ts';
import { InMemoryWorldModel, surpriseSpectrum } from '../src/knowledge/worldModel.ts';
import { kernelRegistry } from '../src/kernel/registry.ts';
import type { ScenePatch, WorldModel } from '../src/knowledge/contracts.ts';

/** 四世界的固定轮转次序（generateTasks 的立法契约 —— Κ-4 旧路径指纹） */
const KIND_ROTATION = ['wizard', 'popup-maze', 'scroll-hunt', 'danger-gate'] as const;

/** 场景夹具：单全屏分区 + 指定元素（worldModel.test.ts 同款方言） */
function scene(els: Array<[string, number, number]>): ScenePatch[] {
  return [{
    region: { id: 'g0x0', x: 0, y: 0, width: 1, height: 1 },
    elements: els.map(([name, x, y]) => ({
      source: 'L1-tree' as const, role: 'button', name,
      rect: { x, y, width: 0.08, height: 0.04 },
    })),
    funnelDepth: 'L1' as const,
    capturedAt: 0,
  }];
}

// ─── Κ-1：偏向执法（含谱生产者前置核对） ───

test('Κ-1: 偏向执法 —— 高惊异类型显著占优且探索不为零（前置：surpriseSpectrum 诚实聚合）', () => {
  // ── 前置：谱生产者 surpriseSpectrum 的异常诚实铁律 ──
  assert.deepEqual(surpriseSpectrum(null), {}, 'model 缺席 ⇒ 空对象（诚实无知）');
  assert.deepEqual(surpriseSpectrum(undefined), {}, 'model 缺席 ⇒ 空对象（诚实无知）');
  assert.deepEqual(surpriseSpectrum(new InMemoryWorldModel()), {}, '空模型（无类型无转移）⇒ 空谱');
  assert.deepEqual(
    surpriseSpectrum({} as unknown as WorldModel),
    {},
    '非 InMemoryWorldModel ⇒ 空谱（无转移表可枚举的面，绝不越权猜谱）',
  );

  // 有证据的模型：A --act--> B×2、A --act--> C×1（同一动作键，total=3、distinct=2）
  const wm = new InMemoryWorldModel();
  const tA = wm.typeOf(scene([['OK', 0.4, 0.7], ['Cancel', 0.6, 0.7]]));
  const tB = wm.typeOf(scene([['File', 0.1, 0.05], ['Edit', 0.25, 0.05]]));
  const tC = wm.typeOf(scene([['Share', 0.9, 0.05], ['Print', 0.95, 0.05]]));
  assert.ok(tA && tB && tC, '三场景应铸出三个类型');
  assert.equal(wm.observe(tA, 'click_mouse@22', tB, true).ok, true);
  assert.equal(wm.observe(tA, 'click_mouse@22', tB, true).ok, true);
  assert.equal(wm.observe(tA, 'click_mouse@22', tC, true).ok, true);

  // 手工拉普拉斯账（与实现独立重算 —— 口径对账，不是复读）：
  //   p(B) = (2+0.5)/(3+0.5·3) = 2.5/4.5；p(C) = (1+0.5)/4.5 = 1.5/4.5
  //   A 的谱值 = (2·bits(B) + 1·bits(C)) / 3（出弧观察按次数加权平均）
  const bitsB = -Math.log2(2.5 / 4.5);
  const bitsC = -Math.log2(1.5 / 4.5);
  const spectrum = surpriseSpectrum(wm);
  assert.equal(spectrum[tA], Math.round(((2 * bitsB + bitsC) / 3) * 1000) / 1000);
  assert.equal(spectrum[tB], 0, '只有入弧无出弧 ⇒ 0（「见过这屏、没见过它去哪」）');
  assert.equal(spectrum[tC], 0);
  assert.deepEqual(Object.keys(spectrum).sort(), [tA, tB, tC].sort(), '谱域 = 在册类型全集');
  // 口径复用铁证：surprise() 方法与谱聚合共享唯一实现（逐毫同账）
  const resB = wm.surprise(tA, 'click_mouse@22', tB);
  const resC = wm.surprise(tA, 'click_mouse@22', tC);
  assert.ok(resB.ok && resC.ok, 'surprise 应成功');
  assert.equal(resB.value.bits, Math.round(bitsB * 1000) / 1000);
  assert.equal(resC.value.bits, Math.round(bitsC * 1000) / 1000);

  // ── 主体：谱加权偏向采样 ──
  const spec: Record<string, number> = { A: 8, B: 0.5, C: 0.5, D: 0.5 };
  // β=0.5（温和温度）：P(A) = e^4/(e^4+3·e^0.25) ≈ 93.4% > 70%；P(B/C/D) ≈ 2.2%
  // ⇒ 2000 采样期望各 ~44 次，探索下限可见且稳。（纯 β=1 时 P(B)≈0.055%，
  // 2000 采样「各类型都被采到」将靠运气 —— 故测试显式注入温和 β，种子钉死。）
  const rng = mulberry32(20261003);
  const samples = Array.from({ length: 2000 }, () => sampleCurriculumWorld(spec, { beta: 0.5, rng }));
  const counts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const s of samples) counts[s.type] += 1;
  assert.ok(
    counts.A > 0.7 * 2000,
    `A 应显著占优（>70%），实测 ${(counts.A / 20).toFixed(1)}%`,
  );
  for (const t of ['A', 'B', 'C', 'D'] as const) {
    assert.ok(counts[t] >= 1, `类型 ${t} 应被采到（探索不为零），实测 ${counts[t]} 次`);
  }
  // 可观测面：p 回声软最大理论值、surprise 回声谱值、未走回退
  const pA = Math.exp(4) / (Math.exp(4) + 3 * Math.exp(0.25));
  const aSample = samples.find(s => s.type === 'A');
  assert.ok(aSample, 'A 必在采样中（>70% 占优的必要前提）');
  assert.ok(
    Math.abs(aSample.p - pA) < 1e-3,
    `A 的采样概率 ≈ 软最大理论值 ${pA.toFixed(4)}，实测 ${aSample.p}`,
  );
  assert.equal(aSample.surprise, 8, 'surprise 回声谱值');
  assert.equal(aSample.fallback, false, '可用谱 ⇒ 不走回退');
  // 谱键 → 世界种类的确定性配对：排序位轮转 A→wizard、B→popup-maze、C→scroll-hunt、D→danger-gate
  const kindMap = new Map(samples.map(s => [s.type, s.task.kind]));
  assert.deepEqual(
    [...kindMap.entries()].sort((x, y) => x[0].localeCompare(y[0])),
    [
      ['A', 'wizard'], ['B', 'popup-maze'], ['C', 'scroll-hunt'], ['D', 'danger-gate'],
    ],
    '外来谱键按字典序轮转配对四世界（同谱同映射）',
  );
  // 铸成任务满足既有生成器立法（判据在册、难度夹 1..3、id 方言）
  assert.ok(samples.every(s =>
    s.task.successCriteria.length >= 1 &&
    s.task.difficulty >= 1 && s.task.difficulty <= 3 &&
    s.task.id.startsWith('gym-'),
  ));
});

// ─── Κ-2：均匀回退 ───

test('Κ-2: 均匀回退 —— 空谱/缺席/全零/含 NaN 谱 ⇒ 四类型近似均匀（25%±5pp）', () => {
  const badSpectra: unknown[] = [
    {},                                   // 空谱
    undefined,                            // 缺席
    { A: 0, B: 0, C: 0, D: 0 },           // 全零谱
    { A: Number.NaN, B: 1, C: 2, D: 3 },  // 含 NaN ⇒ 整谱不可信
    { A: Infinity, B: 1 },                // 含 ±Infinity 同律
  ];
  for (const bad of badSpectra) {
    const rng = mulberry32(4242);
    const samples = Array.from({ length: 2000 }, () => sampleCurriculumWorld(bad, { rng }));
    const counts: Record<string, number> = {};
    for (const s of samples) counts[s.type] = (counts[s.type] ?? 0) + 1;
    assert.deepEqual(
      Object.keys(counts).sort(),
      [...KIND_ROTATION].sort(),
      `坏谱 ⇒ 均匀回退到四世界（谱=${JSON.stringify(bad)}）`,
    );
    for (const k of KIND_ROTATION) {
      const share = (counts[k] ?? 0) / 2000;
      assert.ok(
        Math.abs(share - 0.25) <= 0.05,
        `谱=${JSON.stringify(bad)} 下 ${k} 占比应在 25%±5pp（实测 ${(share * 100).toFixed(1)}%）`,
      );
    }
    // 回退指纹：fallback=true、surprise=0（无证据的诚实读数）、p=1/4、type=世界种类名
    for (const s of samples) {
      assert.equal(s.fallback, true, `谱=${JSON.stringify(bad)} ⇒ fallback 标记在场`);
      assert.equal(s.surprise, 0, '回退路径 surprise=0（诚实无知，不是伪装的偏好）');
      assert.equal(s.p, 0.25);
      assert.equal(s.task.kind, s.type, '回退路径 type 即世界种类名');
    }
  }
});

// ─── Κ-3：确定性 ───

test('Κ-3: 确定性 —— 同 seed 同谱 ⇒ 采样序列逐项一致；异 seed ⇒ 序列不同', () => {
  const spec: Record<string, number> = {
    wizard: 3, 'popup-maze': 0.2, 'scroll-hunt': 1.4, 'danger-gate': 0.9,
  };
  const run = (seed: number): CurriculumSample[] => {
    const rng = mulberry32(seed);
    return Array.from({ length: 64 }, (_, i) =>
      sampleCurriculumWorld(spec, { rng, index: i, beta: 1.3 }));
  };
  const seq1 = run(777);
  const seq2 = run(777);
  assert.deepEqual(seq1, seq2, '同 seed 同谱同 β ⇒ 采样序列（含铸成任务）逐项一致');
  const seq3 = run(778);
  assert.notDeepEqual(seq1, seq3, '异 seed ⇒ 序列不同（种子真实驱动随机流）');
  // 缺省 rng（mulberry32(4242) 内铸）同样可复现：同谱两次直呼逐字段一致
  assert.deepEqual(
    sampleCurriculumWorld(spec, { beta: 1 }),
    sampleCurriculumWorld(spec, { beta: 1 }),
    '缺省 rng ⇒ 可复现',
  );
});

// ─── Κ-4：隔离执法 + β 数值稳定 ───

test('Κ-4: 隔离执法 —— 课程关 ⇒ 既有路径不变；课程开不触生产内核；β 数值稳定', async () => {
  const SEED = 4242;

  // (a) 旧路径指纹：四轮恰按 KIND_ORDER 轮转 + 报告轮不携带课程字段 + 复跑一致
  const rep1 = await new AutonomyGym({ seed: SEED }).train(4);
  const rep2 = await new AutonomyGym({ seed: SEED }).train(4);
  assert.deepEqual(rep1, rep2, '课程缺席（config 缺省 false 的镜像）⇒ 同 seed 复跑逐字段一致');
  assert.deepEqual(
    rep1.rounds.map(r => r.kind),
    [...KIND_ROTATION],
    '旧路径指纹：课程关 ⇒ 选世仍按 KIND_ORDER 轮转（未被课程路径触碰）',
  );
  for (const r of rep1.rounds) {
    assert.equal('curriculum' in r, false, '课程关 ⇒ 报告轮不携带 curriculum 字段');
  }
  assert.deepEqual(
    rep1.rounds.map(r => r.taskId),
    generateTasks(SEED, 4).map(t => t.id),
    '课程关 ⇒ 任务序列与 generateTasks 逐字节同源',
  );

  // (b) 显式 enabled:false + 带毒谱/带毒 β ⇒ 课程数据被完全忽略，仍走旧路径
  const rep3 = await new AutonomyGym({
    seed: SEED,
    curriculum: { enabled: false, beta: 1e9, spectrum: { wizard: 1e9 } },
  }).train(4);
  assert.deepEqual(rep3, rep1, 'enabled=false ⇒ 谱与 β 全然无效，报告与旧路径逐字段一致');

  // (c) 课程开 ⇒ 挂线生效（轮轮带课程可观测面）且不触碰生产内核（Θ-3 隔离律）
  const before = kernelRegistry.snapshot();
  const curOpts = {
    enabled: true,
    beta: 1,
    spectrum: { wizard: 2, 'popup-maze': 2, 'scroll-hunt': 2, 'danger-gate': 2 },
  };
  const repCur1 = await new AutonomyGym({ seed: SEED, curriculum: curOpts }).train(4);
  const repCur2 = await new AutonomyGym({ seed: SEED, curriculum: curOpts }).train(4);
  assert.deepEqual(repCur1, repCur2, '课程开 ⇒ 同 seed 同谱复跑逐字段一致（确定性贯穿课程路径）');
  for (const r of repCur1.rounds) {
    assert.ok(r.curriculum, '课程开 ⇒ 每轮携带 curriculum 可观测面 {type, p, surprise}');
    assert.equal(r.curriculum.fallback, false, '等值非零谱 ⇒ 未走回退');
    assert.equal(r.curriculum.p, 0.25, '等值谱 ⇒ 软最大恰均匀');
    assert.equal(r.curriculum.surprise, 2, 'surprise 回声谱值');
    assert.equal(r.curriculum.type, r.kind, '谱键 = 世界种类名 ⇒ 原样配对');
    assert.ok((KIND_ROTATION as readonly string[]).includes(r.kind), '世界种类合法');
  }
  assert.deepEqual(
    kernelRegistry.snapshot(),
    before,
    '课程训练不触碰生产 kernelRegistry（Θ-3 校准实验室与生产隔离律）',
  );

  // (d) β 数值稳定：极端大谱（1e6 bits）× 极端 β ⇒ 绝无 NaN/Infinity
  const extreme: Record<string, number> = { A: 1e6, B: 999999.5, C: 0.5, D: 0.5 };
  for (const beta of [1, 1000, 1e300, Number.MAX_VALUE]) {
    const rng = mulberry32(99);
    const samples = Array.from({ length: 200 }, () =>
      sampleCurriculumWorld(extreme, { beta, rng }));
    for (const s of samples) {
      assert.ok(Number.isFinite(s.p), `β=${beta} ⇒ p 有限（实测 ${s.p}）`);
      assert.ok(Number.isFinite(s.surprise), `β=${beta} ⇒ surprise 有限`);
      assert.ok(s.p >= 0 && s.p <= 1, `β=${beta} ⇒ p ∈ [0,1]`);
      assert.ok(Number.isFinite(s.task.seed), `β=${beta} ⇒ 任务种子有限`);
    }
  }
});
