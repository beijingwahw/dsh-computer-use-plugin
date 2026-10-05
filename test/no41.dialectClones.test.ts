// test/no41.dialectClones.test.ts
// ΝΩ-41（方言克隆律）执法册 —— 六处方言副本退役（改 import src/dialects/random.ts）
// 的种子对照断言：每处钉死「同 seed 同序列前后一致」的金样（收口前本地实现口径
// 采集于 2026-10-04，逐字节搬运）：
//   ① semanticHash.embed      —— 本地 FNV-1a 副本退役（桶键不变 ⇒ 稀疏向量不变）
//   ② skillFederation 指纹    —— 本地 FNV-1a→base36 副本退役（fnv1aBase36 承接）
//   ③ sleep/dreamReplayCore   —— fnv1a 单源再导出（policyFingerprintOf 消费不变）
//   ④ vlm/som.layout          —— 染色键 FNV-1a 副本退役（stableColor 不变）
//   ⑤ federation/digest       —— mulberry32（卫兵包装）+ fnv1a32（fnv1aSeeded 续算）
//   ⑥ knowledge/memoryOps.random —— 私有 mulberry32 退役（seededRng 逐位同流）
// 附：环执法（scripts/cycle_lint.mjs）与 BC-5（scripts/bug_class_lint.py）是
// 本工单的机械闸，本册是其随机流/哈希面的金样锚。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { embed, cosine } from '../src/semanticHash.ts';
import { skillFingerprintOf } from '../src/skillFederation.ts';
import { fnv1a as dreamFnv1a, policyFingerprintOf, dreamCfKey } from '../src/sleep/dreamReplayCore.ts';
import { stableColor } from '../src/vlm/som.layout.ts';
import { mulberry32 as digestMulberry32, fnv1a32, mintEvidenceDigest } from '../src/federation/digest.ts';
import { seededRng, betaSample } from '../src/knowledge/memoryOps.random.ts';
import { fnv1a, mulberry32, fnv1aBase36, fnv1aSeeded } from '../src/dialects/random.ts';

const seq = (rng: () => number, n = 4): number[] => Array.from({ length: n }, () => rng());

// ─── ① semanticHash：embed 金样（收口前后逐字节一致） ───

test('ΝΩ-41①: semanticHash.embed 金样 —— FNV-1a 单源化后稀疏向量逐字节不变', () => {
  // ΠΑΝ-46（分词单源化）金样重捕：embed 分词收口到 dialects.tokenizeText
  //（signature 签名系方言）—— '整理数据' 的 token 集从「单字+跨界 bigram」
  // 变为「分段 bigram」（整理/理数/数据），桶集相应缩减；FNV-1a 桶键本身
  //（本测试的执法对象）逐字节不变。金样重捕于 2026-10-04。
  const v = embed('整理数据');
  assert.deepEqual(v.dims, [
    [287907755, 1], [388195953, 0.5], [456439262, 0.5], [474496809, 0.5],
    [557840451, 0.5], [627279557, 0.5], [649014505, 0.5], [905887814, 0.5],
    [2360150179, 0.5], [2394144405, 0.5], [2398754145, 0.5], [2499122128, 0.5],
    [3353438327, 1], [3631407781, 1], [3770399809, 0.5], [3850376976, 0.5],
    [4229623083, 0.5],
  ]);
  assert.equal(v.norm, 2.5495097567963922);
  assert.equal(cosine(v, v), 1, '自身余弦精确为 1（norm 与 dims 同源律）');
  assert.equal(embed('filter the data rows').dims.length, 19,
    '英文侧桶数金样（跨语系桥不变）。ΠΑΝ-46 复盘补律重捕：签名系（embed）是封闭协议方言 —— '
    + '停用词全保留（the 计入，19 桶；旧 17 桶金样误把意图系的滤除律套到签名系，worldModel 的 '
    + "'a@22' 单字母签名因此失明）；意图系（BM25/抗原指纹/反射弧）滤停用词的原设计不动。");
});

// ─── ② skillFederation：技能指纹金样（fnv1aBase36 承接 string 方言） ───

test('ΝΩ-41②: skillFingerprintOf 金样 —— base36 出口编码逐字节不变', () => {
  assert.equal(
    skillFingerprintOf('abc123XYZ', [{ x: 0.049, y: 1.2 }, { x: 0.051, y: 1.2 }]),
    'abc123xy:fyyllf',
    '网格内微漂同桶（LSH locality）+ base36 尾巴金样',
  );
  assert.equal(skillFingerprintOf('', [{ v: -3 }, { v: 3 }]), 'noscene:r8x2qh');
  assert.equal(skillFingerprintOf(undefined, undefined), 'noscene:ztntfp', '空入参的确定性降级键');
});

// ─── ③ dreamReplayCore：fnv1a 单源再导出 + 策略指纹金样 ───

test('ΝΩ-41③: dreamReplayCore.fnv1a 即单源函数 —— 轨迹指纹/策略指纹金样不变', () => {
  assert.equal(dreamFnv1a, fnv1a, '再导出面 = 单源原函数（零卫兵）');
  assert.deepEqual(
    ['', 'a', '梦轨迹', 'w4-4:pcg:derive:123'].map(s => dreamFnv1a(s)),
    [2166136261, 3826002220, 2084592558, 3259273162],
    'FNV 金样（空串 = offset basis）',
  );
  assert.equal(policyFingerprintOf({ a: 0.049, b: 1.0 }), 'hd3c9714d', '策略指纹金样（网格粗化串接哈希）');
  assert.deepEqual(
    [dreamCfKey('click', 'fp123'), dreamCfKey(undefined, 'fp123'), dreamCfKey('  ', '')],
    ['dream.cf:rc:click', 'dream.cf:w:fp123', 'dream.cf:w:void'],
  );
});

// ─── ④ som.layout：稳定染色金样 ───

test('ΝΩ-41④: stableColor 金样 —— 同 key 恒同色（跨帧稳定）逐字节不变', () => {
  assert.deepEqual(
    ['ok', '取消', 'File', '编辑', 'ok'].map(stableColor),
    ['#FF2678', '#E4FF26', '#E4FF26', '#26FFFF', '#FF2678'],
    '染色键金样（首尾同 key 同色 = 稳定性的最小证词）',
  );
});

// ─── ⑤ federation/digest：mulberry32 卫兵包装 + fnv1a32 续算金样 ───

test('ΝΩ-41⑤a: digest.mulberry32 金样 —— 六族种子（含负小数/NaN/无符号高位）逐字节一致', () => {
  assert.deepEqual(seq(digestMulberry32(0)), [0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111]);
  assert.deepEqual(seq(digestMulberry32(4242)), [0.5467061335220933, 0.27860878920182586, 0.9312369171530008, 0.5072224664036185]);
  assert.deepEqual(seq(digestMulberry32(-1.5)), [0.1577923847362399, 0.04910933715291321, 0.7769853791687638, 0.16885358770377934], '负小数沿 floor 律（-1.5→-2，非 ToInt32 截断）');
  assert.deepEqual(seq(digestMulberry32(Number.NaN)), seq(digestMulberry32(0)), 'NaN 种子按 0 记');
  assert.deepEqual(seq(digestMulberry32(2 ** 31 + 5)), [0.5801103678531945, 0.08632027637213469, 0.9113832253497094, 0.7611181102693081], '≥2^31 种子 >>>0 归一后同流');
  assert.deepEqual(seq(digestMulberry32(1.9)), seq(digestMulberry32(1)), '小数种子向下取整');
});

test('ΝΩ-41⑤b: fnv1a32 金样 —— 滚动续算（fnv1aSeeded）+ 消毒卫兵逐字节不变', () => {
  assert.equal(fnv1a32(0x811c9dc5, 'abc'), 440920331, '偏移基起步 = fnv1a');
  let h = 0x811c9dc5;
  for (const s of ['\u0000k\u0000', 's:0.5;', 'f:;']) h = fnv1a32(h, s);
  assert.equal(h, 2437032188, '窗口指纹滚动链金样（mintEvidenceDigest 的真实消费形状）');
  assert.equal(fnv1a32(Number.NaN, 'x'), 4245442695, '非有限 h 回落偏移基');
  assert.equal(fnv1a32(5, 42 as unknown as string), 5, '非字符串 text 按空串记（零迭代原样返回）');
  assert.equal(fnv1aSeeded(0x811c9dc5, 'abc'), fnv1a('abc'), '单源内自洽：续算偏移基特例 = fnv1a');
});

test('ΝΩ-41⑤c: mintEvidenceDigest 端到端金样 —— 同 seed 同摘要（噪声流消费顺序不变）', () => {
  const ledger = { keys: () => ['k1'], entries: () => [{ success: true, margin: 0.4 }, { success: false, margin: -0.2 }] };
  assert.deepEqual(
    mintEvidenceDigest(ledger, { seed: 7, epsilon: 2, now: () => 123456 }),
    { v: 1, mintedAt: 123456, epsilon: 2, keys: [{ key: 'k1', n: 0, bins: [[0, 2], [0, 0], [0, 0], [0, 1], [0, 0], [0, 0], [0, 0], [0, 0]] }] },
    '铸造金样（mulberry32 流 + Laplace 同序）',
  );
});

// ─── ⑥ knowledge/memoryOps.random：seededRng 全入口金样 ───

test('ΝΩ-41⑥: seededRng 金样 —— string/number/负数/空串/Infinity 五入口逐位同流', () => {
  assert.deepEqual(seq(seededRng('k:no7')), [0.5699145407415926, 0.4535970634315163, 0.05914162378758192, 0.14843876706436276], 'string 种子经 xmur3 播种');
  assert.deepEqual(seq(seededRng(42)), [0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693], 'number 直播种');
  assert.deepEqual(seq(seededRng(-7.9)), [0.011704753153026104, 0.06195825757458806, 0.97690763277933, 0.6990287057124078], '负小数 |·|+floor 律');
  assert.deepEqual(seq(seededRng('')), [0.9757088038604707, 0.6221915907226503, 0.6578594758175313, 0.23277555429376662], '空串种子');
  assert.deepEqual(seq(seededRng(Number.POSITIVE_INFINITY)), seq(seededRng(0)), '非有限 number 按 0 记');
  assert.equal(betaSample(3, 5, seededRng(99)), 0.3514897192748941, 'Beta 采样流金样（Gamma 桥消费顺序不变）');
});

// ─── 通用：单源自洽（mulberry32 与 dialects 直呼同流） ───

test('ΝΩ-41⓪: 单源自洽 —— 消费方包装与 dialects 直呼在共同域上同 seed 同序列', () => {
  for (const seed of [0, 1, 4242, 2 ** 31 + 5]) {
    assert.deepEqual(seq(digestMulberry32(seed)), seq(mulberry32(seed)), `seed=${seed}：卫兵包装 = 单源直呼（非负整域恒等）`);
  }
});
