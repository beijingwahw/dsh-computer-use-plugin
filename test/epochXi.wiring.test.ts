// test/epochXi.wiring.test.ts
// 纪元 Ξ（Ξ-D 二梯队内核全接线）执法册：
//   Ξ-D① 未注册时读点行为逐字节等同现状 —— 五个数值断言：
//        verdict 融合加成 +0.1（0.45+0.1=0.55）/ failureMemory score2Floor 0.2 过滤 /
//        orchestrator EMA α=0.15（首败 0.5−0.15×0.5=0.425）/ VlmApiBreaker 缺省
//        5 次·60000ms / encodeForVlm 缺省长边 1568·质量 80（sharp 真图）；
//   Ξ-D② 注册后 set 生效 —— conservativeCap=0.9（分歧帽抬升）/ score2Floor=0.9
//        （召回收紧）/ breakerFailures=2（两败即熔断）/ codec.maxDim=1000（长边
//        1000）/ osc.fuzzTol=12（距 11 判同环）/ orch.emaAlpha=0.9（首败 0.05）；
//   Ξ-D③ 结构序守护 —— set(popup.offThreshold, 0.8) 越序 ⇒ set 夹回 specs 上限
//        0.5，消费处 Math.min(off, on) 再兜一层；重叠 specs（off 0.1..0.9）下
//        消费处兜序仍保施密特迟滞（单清洁帧不放行）；evidenceSem 越序被
//        Math.max(sem, geo) 抬正（语义帧 belief 0.955 而非 0.514）；
//   Ξ-D④ registerProductionKernels 后 list() 键数 = 58（Θ 18 + Ξ-D 37 + ΝΩ 3）且
//        drift() 空（入册值全为缺省 —— 零行为变化的锚）；
//   Ξ-D⑤ 幂等：两次入册长度 / 现值 / 快照逐字节不变。
// 全程 try/finally resetKernelRuntime（生产单例不带走测试残迹）；全离线、
// 零网络（sharp 缺席时 codec 断言按仓库先例 SKIP）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fuseWithPixelEvidence, type VlmEffectVerdict } from '../src/vlm/verdict.ts';
import { VlmApiBreaker } from '../src/vlm/metering.ts';
import { encodeForVlm } from '../src/vlm/codec.ts';
import { failureMemory } from '../src/failureMemory.ts';
import { oscillationTracker } from '../src/oscillationTracker.ts';
import { SchmittPopupFilter } from '../src/popupDetector.ts';
import { createActor, actorChannelWeights, resetChannelArbitration } from '../src/orchestrator.ts';
import { kernelRegistry, resetKernelRuntime } from '../src/kernel/registry.ts';
import { registerProductionKernels } from '../src/kernel/index.ts';
import { getSharp, type SharpLike } from '../src/_legacyDeps.ts';

// ─── 假件工厂 ───

/** 云判决最小合法载荷（除 verdict/confidence 外均安静缺省） */
function cloudVerdict(verdict: VlmEffectVerdict['verdict'], confidence: number): VlmEffectVerdict {
  return { ok: true, verdict, scale: 'page', explanation: '', confidence, degraded: false, latencyMs: 1 };
}

/** 合成纯色 PNG（真图走 sharp 解码主路径，与 vlm.codec.test.ts 同款工厂） */
let sharpCache: SharpLike | null = null;
async function solidPng(w: number, h: number): Promise<Buffer> {
  if (!sharpCache) sharpCache = await getSharp();
  const s = sharpCache;
  const row = Buffer.concat(Array.from({ length: w }, () => Buffer.from([200, 40, 40])));
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return s(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/** 64 位二进制指纹对：汉明距离 = flips 的位 数 */
function hashPair(flips: number[]): [string, string] {
  const a = '0'.repeat(64);
  const b = [...a].map((c, i) => (flips.includes(i) ? '1' : c)).join('');
  return [a, b];
}

// ─── Ξ-D①：未注册 ⇒ 读点缺省 = 现行字面量（五个数值断言） ───

test('Ξ-D①: 未注册缺省回归 —— 融合 +0.1 / score2Floor 0.2 / EMA α=0.15 / 熔断 5·60000 / 编码 1568·80', async (t) => {
  resetKernelRuntime();
  resetChannelArbitration();
  const savedMemory = failureMemory.dump();
  try {
    assert.equal(kernelRegistry.list().length, 0, '前置：生产注册表未入册');

    // (a) verdict 融合加成缺省 +0.1：mean=(0.7+0.2)/2=0.45 ⇒ confirmed 置信 0.55
    const fused = fuseWithPixelEvidence(cloudVerdict('confirmed', 0.7), { detected: true, similarityPct: 80 });
    assert.equal(fused.verdict, 'confirmed');
    assert.ok(Math.abs(fused.confidence - 0.55) < 1e-9, `融合置信 = 0.45+0.1（实测 ${fused.confidence}）`);
    // 分歧缺省保守帽 0.6：min(0.7, 0.6)
    const disagree = fuseWithPixelEvidence(cloudVerdict('refuted', 0.7), { detected: true, similarityPct: 50 });
    assert.equal(disagree.verdict, 'uncertain');
    assert.ok(Math.abs(disagree.confidence - 0.6) < 1e-9, `分歧帽 = 0.6（实测 ${disagree.confidence}）`);

    // (b) failureMemory 缺省 score2Floor 0.2：半相关记录召回、无关记录滤除
    failureMemory.restore({ records: [], nextId: 1 });
    const rel = failureMemory.record('打开设置面板后重启应用', 'click-button-x88-y42', 'screen did not change at all');
    failureMemory.record('完全无关的备选路径', 'type-keys-none', 'nothing found here');
    const hits = failureMemory.match('打开设置面板并保存配置文件');
    assert.equal(hits.length, 1, `半相关记录过闸、无关记录滤除（实测 ${hits.length} 条）`);
    assert.equal(hits[0].id, rel.id, '召回的是半相关记录本体');

    // (c) EMA 缺省 α=0.15：首败 0.5 − 0.15×0.5 = 0.425（双通道在场才更新被选通道；
    //     getter 本身不抛 —— 抛的是 agentsRun 调用，才走 hedgeUpdate 分支）
    const actor = createActor({
      getAgentsRun: () => async () => { throw new Error('down'); },
      matchSkill: () => [{ id: 9, reliability: 0.9, score: 0.9, steps: [{ tool: 't', args: {} }] }],
      replayStep: async () => 'ok',
      recordOutcome: () => { /* 旁路 */ },
    });
    await actor('any task');
    const w = actorChannelWeights();
    assert.ok(Math.abs(w.agents - 0.425) < 1e-9, `EMA α=0.15 ⇒ 首败 0.425（实测 ${w.agents}）`);

    // (d) VlmApiBreaker 缺省 5 次熔断 / 60000ms 冷却（时间轴全注入，零睡眠）
    const br = new VlmApiBreaker();
    for (let i = 0; i < 4; i++) br.onFailure(1000 + i);
    assert.equal(br.state(5000), 'closed', '4 < 缺省 5 ⇒ 未熔断');
    br.onFailure(5000);
    assert.equal(br.state(5000), 'open', '第 5 败 ⇒ 熔断');
    assert.equal(br.retryAt(5000), 65000, '冷却缺省 60000：5000 + 60000');
    assert.equal(br.state(64999), 'open', '差 1ms 仍熔断');
    assert.equal(br.state(65000), 'closed', '期满惰性回 closed（半开语义）');

    // (e) encodeForVlm 缺省长边 1568 / 质量 80（sharp 真图；缺席按仓库先例 SKIP）
    try {
      if (!sharpCache) sharpCache = await getSharp();
    } catch (e: any) {
      t.skip(`sharp not installed — ${e?.message?.slice(0, 240) ?? ''}`);
      return;
    }
    const big = await encodeForVlm(await solidPng(3200, 1600));
    assert.equal(big.ok, true);
    assert.equal(big.value!.width, 1568, '缺省长边 1568');
    assert.equal(big.value!.height, 784, '2:1 等比 ⇒ 784');
    assert.equal(big.value!.strategy, 'resize-1568');
    const explicit = await encodeForVlm(await solidPng(3200, 1600), { quality: 80 });
    assert.equal(explicit.value!.width, 1568);
    assert.ok(
      Buffer.from(big.value!.base64, 'base64').equals(Buffer.from(explicit.value!.base64, 'base64')),
      '缺省输出与显式 quality:80 逐字节相同 ⇒ 缺省质量确为 80',
    );
  } finally {
    failureMemory.restore(savedMemory);
    resetChannelArbitration();
    resetKernelRuntime();
  }
});

// ─── Ξ-D②：注册后 set 生效 ⇒ 读点判决随内核翻转 ───

test('Ξ-D②: set 生效 —— conservativeCap 0.9 / score2Floor 0.9 / breakerFailures 2 / maxDim 1000 / fuzzTol 12 / emaAlpha 0.9', async (t) => {
  resetKernelRuntime();
  resetChannelArbitration();
  const savedMemory = failureMemory.dump();
  try {
    registerProductionKernels();

    // (a) verdict.conservativeCap=0.9 ⇒ 分歧降级置信帽从 0.6 抬到 min(0.7,0.9)=0.7
    assert.equal(kernelRegistry.set('verdict.conservativeCap', 0.9).ok, true);
    const disagree = fuseWithPixelEvidence(cloudVerdict('refuted', 0.7), { detected: true, similarityPct: 50 });
    assert.equal(disagree.verdict, 'uncertain');
    assert.ok(Math.abs(disagree.confidence - 0.7) < 1e-9, `帽 0.9 ⇒ 0.7（实测 ${disagree.confidence}）`);

    // (b) failure.score2Floor=0.9 ⇒ 召回收紧：原可召回的半相关记录也被滤除
    failureMemory.restore({ records: [], nextId: 1 });
    failureMemory.record('打开设置面板后重启应用', 'click-button-x88-y42', 'screen did not change at all');
    assert.equal(failureMemory.match('打开设置面板并保存配置文件').length, 1, '前置：缺省 0.2 下可召回');
    kernelRegistry.set('failure.score2Floor', 0.9);
    assert.equal(failureMemory.match('打开设置面板并保存配置文件').length, 0, 'score2Floor 0.9 ⇒ 全滤除');

    // (c) vlm.breakerFailures=2 ⇒ 缺省参构造的新实例两败即熔断（读点在构造器缺省参）
    kernelRegistry.set('vlm.breakerFailures', 2);
    const br = new VlmApiBreaker();
    br.onFailure(100);
    assert.equal(br.state(150), 'closed', '1 < 2 未熔断');
    br.onFailure(200);
    assert.equal(br.state(250), 'open', '第 2 败 ⇒ 熔断（set 后新实例即时生效）');

    // (d) codec.maxDim=1000 ⇒ 缺省长边 1000（sharp 真图）
    try {
      if (!sharpCache) sharpCache = await getSharp();
    } catch (e: any) {
      t.skip(`sharp not installed — ${e?.message?.slice(0, 240) ?? ''}`);
      return;
    }
    kernelRegistry.set('codec.maxDim', 1000);
    const big = await encodeForVlm(await solidPng(3200, 1600));
    assert.equal(big.ok, true);
    assert.equal(big.value!.width, 1000, '内核长边 1000');
    assert.equal(big.value!.height, 500, '2:1 等比 ⇒ 500');
    assert.equal(big.value!.strategy, 'resize-1000');
    kernelRegistry.set('codec.maxDim', 1568); // 复位：不影响本测试后续（隔离习惯）

    // (e) osc.fuzzTol=12 ⇒ 汉明距 11 判同环（缺省 6 判异）
    const [a, b] = hashPair([3, 7, 11, 15, 19, 23, 27, 31, 35, 39, 43]); // 距 11
    oscillationTracker.reset();
    let d1: string | null = null;
    for (const h of [a, b, a, b]) d1 = oscillationTracker.observe(h);
    assert.equal(d1, null, '前置：缺省容差 6 ⇒ 距 11 判异，无告警');
    kernelRegistry.set('osc.fuzzTol', 12);
    oscillationTracker.reset();
    let d2: string | null = null;
    for (const h of [a, b, a]) d2 = oscillationTracker.observe(h);
    assert.ok(d2 !== null && d2.includes('OSCILLATION DETECTED'), '容差 12 ⇒ 距 11 判同环，第三帧即告警');

    // (f) orch.emaAlpha=0.9 ⇒ 首败 0.5 − 0.9×0.5 = 0.05
    resetChannelArbitration();
    kernelRegistry.set('orch.emaAlpha', 0.9);
    const actor = createActor({
      getAgentsRun: () => async () => { throw new Error('down'); },
      matchSkill: () => [{ id: 9, reliability: 0.9, score: 0.9, steps: [{ tool: 't', args: {} }] }],
      replayStep: async () => 'ok',
      recordOutcome: () => { /* 旁路 */ },
    });
    await actor('any task');
    assert.ok(Math.abs(actorChannelWeights().agents - 0.05) < 1e-9, 'EMA α=0.9 ⇒ 首败 0.05');
  } finally {
    oscillationTracker.reset();
    failureMemory.restore(savedMemory);
    resetChannelArbitration();
    resetKernelRuntime();
  }
});

// ─── Ξ-D③：结构序守护 —— 越序值在 set 层夹回、消费层再兜序 ───

test('Ξ-D③: set(popup.offThreshold,0.8) 越序 ⇒ specs 夹回 0.5；消费处 Math.min/Math.max 兜序保施密特迟滞', () => {
  resetKernelRuntime();
  try {
    registerProductionKernels();

    // (a) set 层：off=0.8 越出 specs 区间 [0.1,0.5] ⇒ 夹回 0.5（< on 下限 0.55）
    const r = kernelRegistry.set('popup.offThreshold', 0.8);
    assert.deepEqual(r, { ok: true, reason: 'clamped', clampedTo: 0.5 }, 'set 0.8 ⇒ 夹到 specs 上限 0.5');
    assert.equal(kernelRegistry.get('popup.offThreshold'), 0.5);

    // (b) 行为层：语义帧 ON 后，单清洁帧把信念拉到 ≈0.635 —— 迟滞带 (0.5,0.6) 内
    //     保持 ON（若 off 越序压过 on，0.635 ≤ off 会立即翻 false —— 逐帧抖动）
    kernelRegistry.set('popup.offThreshold', 0.5); // 显式踩到上限（与夹取同值）
    const f1 = new SchmittPopupFilter();
    const on = f1.update({ geometric: false, semantic: true });
    assert.equal(on.active, true, `单帧语义 ⇒ 立即 ON（belief ${on.belief}）`);
    const hold = f1.update({ geometric: false, semantic: false });
    assert.equal(hold.active, true, `单清洁帧 belief ${hold.belief} ∈ 迟滞带 ⇒ 保持 ON（不抖动）`);
    // 连续清洁帧累积过 OFF 线（0.35）才真放行 —— 迟滞双向语义完好
    let off = hold;
    for (let i = 0; i < 4 && off.active; i++) off = f1.update({ geometric: false, semantic: false });
    assert.equal(off.active, false, '清洁证据累积 ⇒ 越缺省 OFF 线 0.35 放行');

    // (c) 消费层兜序的本体证明：注册一张重叠 specs（off 上限 0.9 > on 下限），
    //     set 后 off=0.8 真越序 —— 消费处 Math.min(off, on) 仍保迟滞
    resetKernelRuntime();
    kernelRegistry.register({ key: 'popup.offThreshold', organ: 'popup', defaultValue: 0.35, min: 0.1, max: 0.9, note: '测试用重叠 specs：刻意允许越序' });
    kernelRegistry.register({ key: 'popup.onThreshold', organ: 'popup', defaultValue: 0.6, min: 0.55, max: 0.9, note: '同上' });
    assert.equal(kernelRegistry.set('popup.offThreshold', 0.8).ok, true);
    assert.equal(kernelRegistry.get('popup.offThreshold'), 0.8, '重叠 specs 下 0.8 落在区间 ⇒ set 不夹');
    const f2 = new SchmittPopupFilter();
    const on2 = f2.update({ geometric: false, semantic: true });
    assert.equal(on2.active, true, '语义帧 ON（belief 0.886 ≥ on 0.6）');
    const hold2 = f2.update({ geometric: false, semantic: false });
    assert.equal(hold2.active, true, `兜序 off=min(0.8,0.6)=0.6：belief ${hold2.belief} > 0.6 ⇒ 保持 ON（无兜序则 ≤0.8 翻 false）`);

    // (d) 证据强度序兜底：sem 越序低于 geo ⇒ 消费处 Math.max(sem, geo) 抬正
    resetKernelRuntime();
    kernelRegistry.register({ key: 'popup.evidenceGeo', organ: 'popup', defaultValue: 4.0, min: 1, max: 6, note: '同缺省' });
    kernelRegistry.register({ key: 'popup.evidenceSem', organ: 'popup', defaultValue: 5.0, min: 1, max: 10, note: '测试用放宽下限' });
    kernelRegistry.set('popup.evidenceGeo', 6);
    kernelRegistry.set('popup.evidenceSem', 3);
    const f3 = new SchmittPopupFilter();
    const sem = f3.update({ geometric: false, semantic: true });
    assert.equal(sem.belief, 0.955, '有效 sem=max(6,3)=6 ⇒ belief=sigmoid(logit(0.05)+6)≈0.955（无兜序则 0.514）');
  } finally {
    resetKernelRuntime();
  }
});

// ─── Ξ-D④：册容量与零漂移 ───

test('Ξ-D④: registerProductionKernels ⇒ 58 键在册（Θ 18 + Ξ-D 37 + ΝΩ-10 三键）且 drift() 空', () => {
  resetKernelRuntime();
  try {
    registerProductionKernels();
    const all = kernelRegistry.list();
    assert.equal(all.length, 58, `入册键数 = 18+37+3（ΝΩ-10 policy 权重三键，实测 ${all.length}）`);

    // Ξ-D 新键抽查：六族代表全在册
    const xiKeys = [
      'policy.budgetStepsLow', 'policy.budgetMsLow',
      'verdict.fuseBonus', 'verdict.conservativeCap',
      'verify.phashGate', 'verify.stableGap', 'verify.pollMs', 'verify.settleFactor',
      'osc.ringSize', 'osc.maxPeriod', 'osc.fuzzTol',
      'skill.scoreFloor', 'skill.reliabilityWeight', 'skill.ciDiscount', 'skill.recencyHalfLifeH',
      'orch.skillReliability', 'orch.skillScore', 'orch.emaAlpha',
      'failure.score2Floor', 'failure.rrfK', 'failure.sceneBonus',
      'ctx.flashbackSim',
      'popup.priorWeight', 'popup.evidenceGeo', 'popup.evidenceSem', 'popup.evidenceClean',
      'popup.onThreshold', 'popup.offThreshold', 'popup.geoLow', 'popup.geoHigh',
      'vlm.breakerFailures', 'vlm.breakerCooldownMs',
      'quantum.iou',
      'codec.maxDim', 'codec.quality',
      'constitution.maxNoEffect', 'constitution.maxSteps',
    ];
    assert.equal(xiKeys.length, 37, '抽查清单自身 = 37 键');
    for (const key of xiKeys) {
      assert.ok(kernelRegistry.has(key), `Ξ-D 键在册：${key}`);
    }

    // 全值 = 缺省（零行为变化的锚）+ 缺省锚点抽查
    assert.deepEqual(kernelRegistry.drift(), [], '入册值全为缺省 ⇒ drift 报表为空');
    assert.equal(kernelRegistry.getOrDefault('verdict.fuseBonus', -1), 0.1);
    assert.equal(kernelRegistry.getOrDefault('failure.score2Floor', -1), 0.2);
    assert.equal(kernelRegistry.getOrDefault('orch.emaAlpha', -1), 0.15);
    assert.equal(kernelRegistry.getOrDefault('vlm.breakerFailures', -1), 5);
    assert.equal(kernelRegistry.getOrDefault('vlm.breakerCooldownMs', -1), 60000);
    assert.equal(kernelRegistry.getOrDefault('codec.maxDim', -1), 1568);
    assert.equal(kernelRegistry.getOrDefault('codec.quality', -1), 80);
    assert.equal(kernelRegistry.getOrDefault('constitution.maxNoEffect', -1), 3);
    assert.equal(kernelRegistry.getOrDefault('constitution.maxSteps', -1), 40);
  } finally {
    resetKernelRuntime();
  }
});

// ─── Ξ-D⑤：幂等 —— 重入册不产生重复行、不动现值 ───

test('Ξ-D⑤: registerProductionKernels 幂等 —— 两次入册长度 / 快照逐字节不变，set 值在重入册后原样保留', () => {
  resetKernelRuntime();
  try {
    registerProductionKernels();
    const snap1 = kernelRegistry.snapshot();
    assert.equal(Object.keys(snap1).length, 58);

    // 人为漂移一枚：重入册须保持现值（register 幂等契约：只刷规格不动值）
    kernelRegistry.set('osc.fuzzTol', 9);
    registerProductionKernels();
    const snap2 = kernelRegistry.snapshot();
    assert.equal(kernelRegistry.list().length, 58, '两次入册长度不变（幂等）');
    assert.equal(snap2['osc.fuzzTol'], 9, '重入册保持 set 后的现值');
    snap2['osc.fuzzTol'] = snap1['osc.fuzzTol']!;
    assert.deepEqual(snap2, snap1, '除人为漂移外快照逐字节相同');
    assert.equal(kernelRegistry.drift().length, 1, '唯一漂移即人为那枚');
  } finally {
    resetKernelRuntime();
  }
});
