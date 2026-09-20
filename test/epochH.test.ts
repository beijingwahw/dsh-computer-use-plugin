// test/epochH.test.ts
// H 纪元（创世纪·场的统一与隐私边界）回归测试 —— 六个引擎各一节：
//   H-1 Wasserstein 空间位移：变化发生在你动作的地方吗（最优传输）
//   H-2 NCD 压缩距离：换述死路召回（零词面共享的同构识别）
//   H-3 Thompson 采样模态仲裁：后验抽样代替贪心（探索按证据成比例）
//   H-4 联合诊断皮层：症候群规则表（信号组合 > 孤立异常）
//   H-5 差分隐私联邦：Laplace 机制的定量噪声（上传面隐私边界）
//   H-6 双格点量化：主键跨界漂移由副键兜底（偿还 G-1 债务）
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  spatialDisplacement, classifyPersistence, noteDiffObserved, resetDiffPersistence,
  regionKeys, type DiffRegion,
} from '../src/visualDiff.ts';
import { ncd, ncdSimilarity, lzCount } from '../src/ncd.ts';
import { failureMemory } from '../src/failureMemory.ts';
import { telemetry } from '../src/telemetry.ts';
import { diagnose } from '../src/diagnosis.ts';
import { swarm } from '../src/swarm.ts';

// ─── H-1：Wasserstein 空间位移 ───

function mkRegion(index: number, x: number, y: number, mass = 10): DiffRegion {
  return {
    index,
    bbox_normalized: { x0: x - 0.05, y0: y - 0.05, x1: x + 0.05, y1: y + 0.05 },
    center: { x, y },
    tiles_changed: mass,
  };
}

test('H-1 W1：变化在动作点 ⇒ ≈0；变化在远处 ⇒ 大；质量加权生效', () => {
  const at = spatialDisplacement({ x: 0.5, y: 0.5 }, [mkRegion(1, 0.5, 0.5)]);
  assert.ok(at.w1 <= 0.02, `变化即在动作点，W1=${at.w1} 应 ≈0`);
  assert.equal(at.nearestIndex, 1);

  const far = spatialDisplacement({ x: 0.1, y: 0.1 }, [mkRegion(1, 0.9, 0.9)]);
  assert.ok(far.w1 > 1.0, `变化在对角，W1=${far.w1} 应 >1（归一化坐标对角 ≈1.13）`);

  // 质量加权：重质量在近处 ⇒ W1 被拉近（推土机按质量搬运）
  const mixed = spatialDisplacement({ x: 0.5, y: 0.5 }, [
    mkRegion(1, 0.52, 0.5, 90), // 90% 质量近处
    mkRegion(2, 0.95, 0.95, 10), // 10% 质量远处
  ]);
  assert.ok(mixed.w1 < 0.1, `质量加权的 W1=${mixed.w1} 应由近处重质量主导`);

  assert.deepEqual(spatialDisplacement({ x: 0.5, y: 0.5 }, []),
    { w1: 0, nearestIndex: null, nearestDistance: 0 }, '零区域诚实缺席');
});

// ─── H-2：NCD 压缩距离 ───

test('H-2 NCD：同串 0；变体共享子串的距离 < 信息无关；短语数单调', () => {
  assert.equal(ncd('abcabcabc', 'abcabcabc'), 0, '同一字符串 ⇒ 0（非理想性特判）');
  // NCD 真实领地：leet/typo 变体与原文共享长子串（'verificat·on'），而 token
  // 化后 'verificati0n' ≠ 'verification' —— 词面通道完全失明的情形
  const variant = ncd('verificati0n c0de过期', 'verification code 已过期，重试无效');
  const unrelated = ncd('verificati0n c0de过期', 'q9zzxvvkj');
  assert.ok(variant < 0.7, `变体对应 ${variant} 应显著低（共享子串可见）`);
  assert.ok(variant < unrelated, `变体对 ${variant} < 无关对 ${unrelated}`);
  // 相似度视图对齐
  assert.equal(ncdSimilarity('abcdef', 'abcdef'), 1);
  // LZ 计数：重复结构压缩好（短语少），随机结构短语多
  assert.ok(lzCount('abababab') < lzCount('qxzjkwlv'));
});

test('H-2 failureMemory 变体召回：leet 变体的死路症状被 NCD 通道兜底', () => {
  failureMemory.reset();
  failureMemory.record('登录流程', 'type_text(text=843201)', 'verification code 已过期，重试无效');
  // 查询用 leet 变体拼写 —— token 化后与原文零共享（'verificati0n'≠'verification'），
  // 词面主通道在拉丁部分完全失明，NCD 子串通道兜底
  const hits = failureMemory.match('verificati0n c0de 过期');
  assert.ok(hits.length >= 1, '变体拼写死路应经 NCD 通道召回');
  assert.ok(hits[0].approach.includes('type_text'));
});

// ─── H-3：Thompson 采样模态仲裁 ───

/** 播种 LCG（确定性 uniform 流） */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (1103515245 * s + 12345) % 2147483648;
    return (s >>> 0) / 2147483648;
  };
}

test('H-3 Thompson：9/9 工具在多数抽样中胜过 0/5（证据按强度成比例）', () => {
  telemetry.reset();
  telemetry.configure(true);
  for (let i = 0; i < 9; i++) telemetry.observe('find_text', 'SUCCESS', 40);
  for (let i = 0; i < 5; i++) telemetry.observe('click_mouse', 'FAILED', 40);
  let wins = 0;
  for (let trial = 1; trial <= 200; trial++) {
    const s = telemetry.suggestModality(3, seeded(trial));
    if (s && s.tool === 'find_text') wins++;
  }
  assert.ok(wins >= 160, `9/9 工具应在 ≥80% 抽样中胜出（200 次中 ${wins}）`);
  // 无候选（调用不足）⇒ null
  telemetry.reset();
  assert.equal(telemetry.suggestModality(3, seeded(1)), null);
});

test('H-3 sampleBeta 数学面：均值域 [0,1]；对称参数均值 ≈ 0.5', () => {
  telemetry.reset();
  let acc = 0;
  const n = 2000;
  for (let t = 1; t <= n; t++) acc += telemetry.sampleBeta(5, 5, seeded(t));
  const mean = acc / n;
  assert.ok(mean > 0.45 && mean < 0.55, `Beta(5,5) 抽样均值 ${mean} 应 ≈0.5`);
  // 退化输入诚实降级
  assert.equal(telemetry.sampleBeta(0, 0, seeded(1)), 0.5);
});

// ─── H-4：联合诊断皮层 ───

test('H-4 症候群规则：六症候各就各位 + 优先序（具体 > 一般）+ 健康缺席', () => {
  // 1. shift-and-cluster（最高优先：压过 loop 与 clustering）
  const top = diagnose({
    regimeShiftTools: ['click_mouse'],
    hurst: 0.75,
    behavior: { normalized: 0.1, phrases: 4, length: 30 },
  });
  assert.equal(top!.syndrome, 'shift-and-cluster');
  assert.ok(top!.evidence.length >= 2, '证据链归因');
  // 2. regime-shift 单独
  assert.equal(diagnose({ regimeShiftTools: ['type_text'] })!.syndrome, 'regime-shift');
  // 3. deterministic-loop（双臂判据）
  assert.equal(diagnose({ behavior: { normalized: 0.2, phrases: 5, length: 30 } })!.syndrome, 'deterministic-loop');
  assert.equal(diagnose({ behavior: { normalized: null, phrases: 5, length: 25 } })!.syndrome, 'deterministic-loop');
  // 4. failure-clustering
  assert.equal(diagnose({ hurst: 0.7 })!.syndrome, 'failure-clustering');
  // 5. blind-clicking
  assert.equal(diagnose({ highNoopTools: ['click_mouse'] })!.syndrome, 'blind-clicking');
  // 6. stall-regime
  assert.equal(diagnose({ heavyLatencyTail: true })!.syndrome, 'stall-regime');
  // 健康：全部正常/缺席 ⇒ null
  assert.equal(diagnose({ hurst: 0.5, behavior: { normalized: 0.8, phrases: 40, length: 60 } }), null);
  assert.equal(diagnose({}), null);
  // 边界不触发：Hurst 恰 0.6 不算聚集（> 严格）
  assert.equal(diagnose({ hurst: 0.6 }), null);
});

// ─── H-5：差分隐私联邦 ───

test('H-5 Laplace 机制：噪声有界（≤3σ 内）、率域钳制、ε 声明、匿名性保持', async () => {
  swarm.reset();
  swarm.configure('', 300_000, 500);
  const { journal } = await import('../src/journal.ts');
  journal.reset();
  const scene = '#1 dHash=beefcafe popup=false';
  journal.noteObservation(scene);
  for (let i = 0; i < 4; i++) {
    await journal.append({ ts: i, tool: 'click_mouse', args: {}, status: i < 3 ? 'SUCCESS' : 'FAILED', effect_detected: i < 3 ? true : undefined, observe: scene });
  }
  // ε=1, attempts=4 ⇒ scale = 1/4；确定性 rng 下噪声值固定且 ≤3σ
  swarm.crystalize(); // 晶体先行结晶（buildPacket 只读不结晶 —— fireUpload 语义）
  const packet = swarm.buildPacket(1, seeded(42)) as any;
  assert.equal(packet.dp_epsilon, 1, '隐私预算声明');
  const crystal = packet.crystals[0];
  assert.equal(crystal.attempts, 4, '计数不加噪（统计量真值）');
  const rawRate = 3 / 4;
  assert.ok(Math.abs(crystal.successRate - rawRate) <= 3 * (1 / 4),
    `Laplace 噪声应 ≤3σ（σ=1/4），实际偏移 ${Math.abs(crystal.successRate - rawRate)}`);
  assert.ok(crystal.successRate >= 0 && crystal.successRate <= 1, '率域钳制 [0,1]');
  // 匿名性保持：零截图零原始文本
  const flat = JSON.stringify(packet);
  assert.ok(!flat.includes('data:image') && !flat.includes('popup=false'), '隐私边界不泄原始观测');
});

// ─── H-6：双格点量化（G-1 漂移债务偿还）───

test('H-6 主键跨界的漂移：副键兜底 ⇒ 持续性存活（G-1 时代必误判 transient）', () => {
  resetDiffPersistence();
  // 构造主格点边界的漂移序列：中心从 0.540 → 0.545 → 0.550
  // （格宽 1/12≈0.0833，边界在 0.5417 附近 —— 三帧跨主键 '6'→'7'）
  const drifting = [
    mkRegion(1, 0.540, 0.500),
    mkRegion(1, 0.545, 0.501),
    mkRegion(1, 0.550, 0.502),
  ];
  // 证据：主键确实跨界（单键时代会断链）
  const keys = drifting.map(r => regionKeys(r)[0]);
  assert.ok(new Set(keys).size >= 2, `测试前提：主键跨界（${keys.join(' | ')}）`);
  // 三帧依次入史：第三帧判定时，前两帧在窗口内 —— 任一键链存活 ⇒ persistent
  classifyPersistence([drifting[0]]);
  noteDiffObserved([drifting[0]]);
  classifyPersistence([drifting[1]]);
  noteDiffObserved([drifting[1]]);
  const verdict = classifyPersistence([drifting[2]]);
  assert.equal(verdict.get(1), 'persistent', '双格点：主键跨界由副键兜底，漂移的持续变化存活');
  resetDiffPersistence();
});
