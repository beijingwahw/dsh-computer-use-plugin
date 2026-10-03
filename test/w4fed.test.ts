// test/w4fed.test.ts
// W4-2（创新提案 G3：策略联邦）执法册 G3-1~G3-10：
//   G3-1  技能指纹与 LSH：确定性 / 键序无关 / 半网格内抖动碰撞（LSH 的 locality）/
//         跨网格抖动分离 / 场景前 8 位匿名锚 / 防御臂（陷阱输入绝不抛）。
//   G3-2  上传载荷隐私红线：白名单形状穷举（v/指纹/槽统计/reliability/使用计数 ——
//         每槽恰 2 个数值叶子：统计摘要而非坐标序列）；skillId / 原始文本 / 截图
//         引用 / 全场景指纹 / stepsDigest 序列化串一律不出港。
//   G3-3  Laplace 噪声分布：确定性（同 seed 同上传）/ 异 seed 噪声生效 / 分布形状
//         （|noise| 中位 ≈ 0.69·scale、均值对称近 0、有界）/ ε 单调（小 ε 大噪声）/
//         useCount 收紧 reliability 噪声 / laplaceNoise 纯函数（对称 + 线性 + 消毒）。
//   G3-4  中位数聚合 + IQR 检疫：毒源拉不动中位数、逐槽计票、缺席槽不参与检疫、
//         阈基于鲁棒值（毒源拉不动阈）。
//   G3-5  k<3 拒聚：两源指纹进 skipped；三源才聚合；坏源按缺席（excluded）。
//   G3-6  Thompson 注入决策：同流确定性 / 高可靠候选通过率高、低可靠低（分布
//         单调）/ 采样门 0.5 的两侧裁决。
//   G3-7  dormant 两段激活律：接收只登记 dormant（端口零调用）/ 本地命中 1 次仍
//         dormant / 2 次才激活并经 addDormantSkill 登记一次 / 激活幂等（不重复登记）/
//         端口拒绝或抛错 ⇒ 保持 dormant 下次重试。
//   G3-8  端口桩对接（契约形状）：与 W4-1 契约同形状的桩结构性满足 SkillLibraryPort；
//         敌意端口（抛错 / 陷阱属性）⇒ 诚实空手绝不炸。
//   G3-9  packet v2 兼容：schema=2、v1 字段逐字节不变（老 peer 忽略新段）、技能段
//         白名单、提供者故障 ⇒ 无技能段不炸包、report 联邦技能账接线面。
//   G3-10 三道闸 + 独立记账 + 诚实跳过：零本地证据不掺 / 份额帽（quota 截断）/
//         信任折减（信任账 1/(1+regressed) 折没配额）/ 技能联邦不动证据信任账 /
//         peer 缺席与空聚合 ⇒ 诚实跳过。
// 全程离线（零网络）、rng/时钟/端口全注入、确定性；生产单例 beforeEach 复位。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  skillFingerprintOf,
  buildSkillUploads,
  aggregateSkillShares,
  shouldAttemptInjection,
  skillFederation,
  wireSwarmSkillFederation,
  SKILL_LSH_GRID,
  SKILL_MIN_AGGREGATE_SOURCES,
  SKILL_ACTIVATE_LOCAL_HITS,
  type SkillLibraryPort,
  type SkillDigestRecord,
  type DormantSkillDraft,
  type SkillFederationUpload,
  type AggregatedSkillDigest,
} from '../src/skillFederation.ts';
import {
  laplaceNoise,
  mulberry32,
  federationTrustOf,
  recordFederationTrust,
  federationTrustReport,
  resetFederationRuntime,
} from '../src/federation/index.ts';
import { iqrOf } from '../src/federation/aggregate.ts';
import { swarm } from '../src/swarm.ts';

beforeEach(() => {
  skillFederation.reset();
  swarm.reset();
  swarm.configure('', 300_000, 500);
  swarm.attachSkillFederation(null);
  resetFederationRuntime();
});

// ─── 假件工坊（全注入、零网络、确定性） ───

/** 端口桩工坊：记录 addDormantSkill 调用，可编程故障 */
function stubPort(
  records: SkillDigestRecord[],
  opts: { failAdd?: 'throw' | 'refuse' | 'throw-list' } = {},
): SkillLibraryPort & { calls: DormantSkillDraft[] } {
  const calls: DormantSkillDraft[] = [];
  return {
    calls,
    listSkillDigests(): SkillDigestRecord[] {
      if (opts.failAdd === 'throw-list') throw new Error('port boom');
      return records;
    },
    addDormantSkill(draft: DormantSkillDraft): boolean {
      calls.push(draft);
      if (opts.failAdd === 'throw') throw new Error('add boom');
      if (opts.failAdd === 'refuse') return false;
      return true;
    },
  };
}

/** 一条契约形状的技能摘要（携带故意醒目的隐私诱饵字段 —— 端口外的冗余键） */
function digestRecord(over: Partial<SkillDigestRecord> = {}): SkillDigestRecord {
  return {
    skillId: 987654321,
    sceneFingerprint: 'abcdef1234567890CAFEBABE',
    stepsDigest: [
      { dx: 0.12, dy: 0.24, textLen: 35 },
      { dx: 0.34, dy: 0.48, textLen: 41 },
      { dx: 0.36, dy: 0.26, textLen: 38 },
    ],
    reliability: 0.8,
    useCount: 9,
    // 隐私诱饵：端口返回的额外字段（若实现层误读即被 G3-2 抓获）
    rawText: 'TOPSECRET-XYZ-原文坐标簿',
    screenshot: 'data:image/png;base64,AAAAQUJD',
    ...over,
  } as SkillDigestRecord & { rawText: string; screenshot: string };
}

/** 一个聚合产物（默认可通过聚合门 k≥3） */
function aggregatedOf(fingerprint: string, over: Partial<AggregatedSkillDigest> = {}): AggregatedSkillDigest {
  return {
    fingerprint,
    aggregatedFrom: SKILL_MIN_AGGREGATE_SOURCES,
    slotStats: { dx: { median: 0.35, iqr: 0.05 }, dy: { median: 0.3, iqr: 0.1 } },
    reliability: 0.85,
    useCount: 12,
    ...over,
  };
}

// ─── G3-1：技能指纹与 LSH ───

test('G3-1: 指纹确定性、键序无关、LSH 半网格内碰撞/跨网格分离、场景 8 位匿名锚', () => {
  const steps = [
    { dx: 0.10, dy: 0.20 },
    { dx: 0.35, dy: 0.45 },
  ];
  const scene = 'AbCdEf1234567890deadbeef';
  // (a) 确定性 + 大小写归一
  const f1 = skillFingerprintOf(scene, steps);
  assert.equal(skillFingerprintOf(scene, steps), f1, '同输入同指纹');
  assert.equal(skillFingerprintOf(scene.toLowerCase(), steps), f1, '场景指纹大小写归一');
  // (b) 匿名锚：指纹以场景前 8 位（小写）开头，全指纹不出现在指纹里
  assert.ok(f1.startsWith('abcdef12:'), `指纹 = 场景前 8 位 + LSH 桶（实际 ${f1}）`);
  assert.ok(!f1.includes('1234567890'), '场景指纹第 9 位起不进指纹');
  // (c) 键序无关：同一步的键插入序不同 ⇒ 同指纹（键字典序枚举）
  assert.equal(
    skillFingerprintOf(scene, [{ dx: 0.1, dy: 0.2 }]),
    skillFingerprintOf(scene, [{ dy: 0.2, dx: 0.1 }]),
    '参数槽键序无关',
  );
  // (d) LSH locality：抖动 < 半网格宽（0.025）⇒ 同桶 ⇒ 同指纹
  const jittered = [
    { dx: 0.10 + 0.02, dy: 0.20 - 0.02 },
    { dx: 0.35 - 0.024, dy: 0.45 + 0.01 },
  ];
  assert.equal(skillFingerprintOf(scene, jittered), f1, '半网格内抖动碰撞（LSH）');
  // (e) 跨网格抖动 ⇒ 分离
  const shifted = [
    { dx: 0.10 + 0.06, dy: 0.20 },
    { dx: 0.35, dy: 0.45 },
  ];
  assert.notEqual(skillFingerprintOf(scene, shifted), f1, '跨网格抖动分离');
  // (f) 场景不同 ⇒ 分离（场景锚参与指纹）
  assert.notEqual(skillFingerprintOf('000000005678', steps), f1, '异场景异指纹');
  // (g) 防御臂：非数/空/陷阱输入绝不抛且确定性
  assert.equal(typeof skillFingerprintOf(undefined, undefined), 'string');
  assert.equal(skillFingerprintOf('', []), skillFingerprintOf('', []));
  assert.ok(skillFingerprintOf('scene', [{ dx: Number.NaN, bad: 'x' as unknown as number }]).startsWith('scene:'));
});

// ─── G3-2：上传载荷隐私红线 ───

test('G3-2: 上传载荷白名单形状 —— 无 skillId/原始文本/截图/全场景指纹/坐标序列', () => {
  const port = stubPort([digestRecord(), digestRecord({ sceneFingerprint: 'ffff0000beef' })]);
  const uploads = buildSkillUploads(port, { epsilon: 1, seed: 7 });
  assert.equal(uploads.length, 2, '每技能一条上传');
  const flat = JSON.stringify(uploads);
  // (a) 白名单形状：顶层键恰为 v/fingerprint/slotStats/reliability/useCount
  for (const u of uploads) {
    assert.deepEqual(
      Object.keys(u).sort(),
      ['fingerprint', 'reliability', 'slotStats', 'useCount', 'v'],
      '上传顶层键白名单',
    );
    // 每槽恰 2 个数值叶子（median/iqr）：统计摘要而非坐标序列
    for (const [slot, stat] of Object.entries(u.slotStats)) {
      assert.deepEqual(Object.keys(stat!).sort(), ['iqr', 'median'], `槽 ${slot} 只含统计量`);
      assert.equal(typeof stat!.median, 'number');
      assert.equal(typeof stat!.iqr, 'number');
    }
    assert.equal(u.v, 1, 'schema 版本在案');
    assert.ok(u.fingerprint.startsWith('abcdef12:') || u.fingerprint.startsWith('ffff0000:'), '指纹 = 匿名前缀 + LSH');
  }
  // (b) 隐私红线：本地身份与原始内容一律不出港
  assert.ok(!flat.includes('987654321'), 'skillId 不出港');
  assert.ok(!flat.includes('TOPSECRET'), '原始文本不出港');
  assert.ok(!flat.includes('data:image'), '截图引用不出港');
  assert.ok(!flat.includes('abcdef1234567890'), '全场景指纹不出港（只允许 8 位匿名前缀）');
  assert.ok(!flat.includes('CAFEBABE'), '场景指纹尾段不出港');
  assert.ok(!flat.includes(JSON.stringify(digestRecord().stepsDigest)), 'stepsDigest 序列（坐标序列）不出港');
  // 槽名是结构元数据（dx/dy/textLen —— 数值槽名，非内容）；顶层键白名单见 (a)
  const slots = Object.keys(uploads[0]!.slotStats);
  assert.deepEqual(slots.sort(), ['dx', 'dy', 'textLen'], '数值槽名在场（长度等统计口径）');
});

// ─── G3-3：Laplace 噪声分布 ───

test('G3-3: 上传噪声 —— 确定性、异 seed 生效、分布形状、ε 单调、useCount 收紧、纯函数律', () => {
  const rec = digestRecord({ stepsDigest: [{ dx: 0.35, dy: 0.35, textLen: 30 }] });
  const port = stubPort([rec]);
  const scale = SKILL_LSH_GRID / 1; // ε=1 ⇒ 槽统计噪声尺度 = 桶宽/ε

  // (a) 同 seed 同上传（逐字段）；异 seed ⇒ 噪声生效（中位数或 IQR 漂移）
  const a = buildSkillUploads(port, { epsilon: 1, seed: 42 });
  const b = buildSkillUploads(port, { epsilon: 1, seed: 42 });
  assert.deepEqual(a, b, '同 seed 同上传（确定性）');
  const c = buildSkillUploads(port, { epsilon: 1, seed: 43 });
  assert.ok(
    JSON.stringify(a) !== JSON.stringify(c),
    '异 seed ⇒ 噪声生效',
  );

  // (b) 分布形状：真值 = 量化后中位数（0.35 网格对齐）；噪声 = 上传值 − 真值
  const truth = 0.35;
  const noises: number[] = [];
  for (let seed = 1; seed <= 300; seed++) {
    const u = buildSkillUploads(port, { epsilon: 1, seed })[0]!;
    noises.push(u.slotStats.dx!.median - truth);
  }
  const meanAbs = noises.reduce((s, x) => s + Math.abs(x), 0) / noises.length;
  const mean = noises.reduce((s, x) => s + x, 0) / noises.length;
  // Laplace(0,b)：E|noise| = b ≈ 0.69·… 此处 b=scale；0.69 是 b=1 的中位绝对值 —— 期望 |x| 恰为 b
  assert.ok(
    meanAbs > 0.4 * scale && meanAbs < 1.15 * scale,
    `E|noise| ≈ scale（Laplace 期望绝对差 = b），实际 ${meanAbs.toFixed(4)} vs scale=${scale}`,
  );
  assert.ok(Math.abs(mean) <= 0.4 * scale, `噪声对称（均值近 0），实际 ${mean.toFixed(4)}`);
  assert.ok(Math.max(...noises.map(Math.abs)) <= 12 * scale, '噪声有界（≤12σ，Laplace 尾概率 e^-12 ≈ 6e-6）');
  assert.ok(noises.every(Number.isFinite), '噪声恒有限');

  // (c) ε 单调：ε=0.25 的散布（4×尺度）显著大于 ε=4
  const spreadOf = (eps: number): number => {
    const xs: number[] = [];
    for (let seed = 1; seed <= 200; seed++) {
      const u = buildSkillUploads(port, { epsilon: eps, seed })[0]!;
      xs.push(u.slotStats.dx!.median - truth);
    }
    return xs.reduce((s, x) => s + Math.abs(x), 0) / xs.length;
  };
  const small = spreadOf(0.25);
  const large = spreadOf(4);
  assert.ok(small > 2 * large, `ε 单调（小 ε 大噪声）：${small.toFixed(4)} > 2×${large.toFixed(4)}`);

  // (d) useCount 收紧 reliability 噪声（swarm 同律：尺度 1/(ε·useCount)）
  const relSpread = (useCount: number): number => {
    const p = stubPort([digestRecord({ useCount, reliability: 0.5 })]);
    const xs: number[] = [];
    for (let seed = 1; seed <= 150; seed++) {
      xs.push(buildSkillUploads(p, { epsilon: 1, seed })[0]!.reliability - 0.5);
    }
    return xs.reduce((s, x) => s + Math.abs(x), 0) / xs.length;
  };
  assert.ok(
    relSpread(2) > 1.5 * relSpread(200),
    'useCount 大 ⇒ reliability 噪声显著收紧（敏感度 1/useCount）',
  );
  // useCount 明文上报（swarm attempts 同律）
  assert.equal(buildSkillUploads(stubPort([digestRecord({ useCount: 9 })]), { seed: 1 })[0]!.useCount, 9);
  assert.equal(buildSkillUploads(stubPort([digestRecord({ useCount: undefined })]), { seed: 1 })[0]!.useCount, 1, 'useCount 缺席 ⇒ 保守 1');

  // (e) laplaceNoise 纯函数律（沿用联邦原语的复核）：对称 + 尺度线性 + 消毒
  for (const u of [0.1, 0.3, 0.7, 0.9]) {
    assert.ok(
      Math.abs(laplaceNoise(0.5, u) + laplaceNoise(0.5, 1 - u)) < 1e-12,
      `u 与 1-u 严格反号（u=${u}）`,
    );
    assert.ok(
      Math.abs(laplaceNoise(1, u) - 2 * laplaceNoise(0.5, u)) < 1e-12,
      '尺度线性（scale 翻倍噪声翻倍）',
    );
  }
  assert.equal(laplaceNoise(0, 0.5), 0, 'scale≤0 ⇒ 无噪声（消毒）');
  assert.ok(laplaceNoise(1, Number.NaN) === 0, '非有限 u ⇒ 0（确定性降级，−0 亦为无噪声）');
});

// ─── G3-4 + G3-5：中位数聚合 + IQR 检疫 / k<3 拒聚 ───

function shareOf(fingerprint: string, dxMedian: number, over: Partial<SkillFederationUpload> = {}): SkillFederationUpload {
  return {
    v: 1,
    fingerprint,
    slotStats: { dx: { median: dxMedian, iqr: 0.1 }, dy: { median: 0.3, iqr: 0.05 } },
    reliability: 0.8,
    useCount: 10,
    ...over,
  };
}

test('G3-4: 逐槽中位数聚合隔离毒源 + IQR 检疫计票（阈基于鲁棒值）', () => {
  const fp = 'abcdef12:xyz';
  const shares = [
    shareOf(fp, 0.5),
    shareOf(fp, 0.5),
    shareOf(fp, 0.5),
    shareOf(fp, 5.0), // 毒源：把 dx 中位数抬高一个量级
  ];
  const rr = aggregateSkillShares(shares, { sourceIds: ['a', 'b', 'c', 'poison'] });
  assert.equal(rr.aggregated.length, 1, '同指纹聚合为一份');
  const agg = rr.aggregated[0]!;
  assert.equal(agg.fingerprint, fp);
  assert.equal(agg.aggregatedFrom, 4, 'k=4 在案');
  // 毒源拉不动中位数：median([0.5,0.5,0.5,5.0]) = 0.5（偶数取中间两数均值）
  assert.equal(agg.slotStats.dx!.median, 0.5, '毒源被逐槽中位数结构性隔离');
  assert.equal(agg.slotStats.dy!.median, 0.3);
  // 检疫有牙齿：毒源在 dx 槽得票（|5.0−0.5| > max(3×桶宽, 2×IQR)）
  assert.equal(rr.quarantined['poison'], 1, '毒源逐槽计票 1 票');
  assert.equal(rr.quarantined['a'], undefined, '诚实源零票');
  // 阈基于鲁棒值：IQR([0.5,0.5,0.5,5.0]) ≈ 1.125 ⇒ T = max(0.15, 2.25) = 2.25 < 4.5
  const t = Math.max(3 * SKILL_LSH_GRID, 2 * iqrOf([0.5, 0.5, 0.5, 5.0]));
  assert.ok(Math.abs(5.0 - 0.5) > t, '毒源偏差过阈（阈被鲁棒值锚定）');
  // 槽缺席不参与检疫：毒源缺 dy 槽 ⇒ dy 槽聚合仍 3 源且零票
  const shares2 = [
    shareOf(fp, 0.2),
    shareOf(fp, 0.25),
    shareOf(fp, 0.3),
    { ...shareOf(fp, 9.9), slotStats: { dx: { median: 9.9, iqr: 0 } } }, // 只有 dx
  ];
  const rr2 = aggregateSkillShares(shares2, { sourceIds: ['a', 'b', 'c', 'poison2'] });
  assert.equal(rr2.aggregated[0]!.slotStats.dy!.median, 0.3, '缺席槽由在场 3 源聚合（毒源无 dy 槽）');
  assert.equal(rr2.quarantined['poison2'], 1, '在场槽照常检疫');
  // 聚合产物不可执行：结构上只有指纹 + 槽统计 + 标量账
  assert.deepEqual(
    Object.keys(rr.aggregated[0]!).sort(),
    ['aggregatedFrom', 'fingerprint', 'reliability', 'slotStats', 'useCount'],
    '聚合产物 = 参数分布摘要（无步骤无文本）',
  );
});

test('G3-5: k<3 拒聚（诚实跳过）；坏源按缺席；空输入诚实空手', () => {
  const fp = 'ffff0000:abc';
  // 两源：无鲁棒性的「共识」不冒充 ⇒ 拒聚
  const rr2 = aggregateSkillShares([shareOf(fp, 0.5), shareOf(fp, 0.6)]);
  assert.equal(rr2.aggregated.length, 0, 'k=2 拒聚');
  assert.deepEqual(rr2.skipped, [fp], '拒聚指纹进 skipped（诚实注记）');
  assert.ok(rr2.notes.some(n => n.includes('拒聚')), '拒聚原因入注记');
  // 三源：聚合门开
  const rr3 = aggregateSkillShares([shareOf(fp, 0.5), shareOf(fp, 0.5), shareOf(fp, 0.52)]);
  assert.equal(rr3.aggregated.length, 1, 'k=3 聚合');
  assert.equal(rr3.skipped.length, 0);
  // 坏源按缺席（null / 数字 / 版本错配 / 陷阱属性）—— 不否决其余源
  const trap = {
    get v() { throw new Error('trap'); },
  };
  const rrBad = aggregateSkillShares(
    [null, 42, 'x', trap, { v: 99, fingerprint: fp }, shareOf(fp, 0.5), shareOf(fp, 0.5), shareOf(fp, 0.5)],
    { sourceIds: ['n0', 'n1', 'n2', 'trap', 'ver', 'g1', 'g2', 'g3'] },
  );
  assert.deepEqual(rrBad.excluded, [0, 1, 2, 3, 4], '坏源序号全数注记');
  assert.equal(rrBad.aggregated.length, 1, '三诚实源照常聚合');
  // 空输入/非数组 ⇒ 诚实空手
  assert.equal(aggregateSkillShares([]).aggregated.length, 0);
  assert.equal(aggregateSkillShares(undefined).aggregated.length, 0);
  assert.ok(aggregateSkillShares([]).notes.length > 0, '空手有注记');
});

// ─── G3-6：Thompson 注入决策 ───

test('G3-6: Thompson/Beta 采样决策 —— 确定性、门 0.5 两侧裁决、可靠度单调', () => {
  // (a) 同均匀流 ⇒ 同判词（确定性）
  for (const seed of [1, 7, 99]) {
    const r1 = shouldAttemptInjection(0.8, 20, mulberry32(seed));
    const r2 = shouldAttemptInjection(0.8, 20, mulberry32(seed));
    assert.equal(r1, r2, `seed=${seed} 确定性`);
  }
  // (b) 门 0.5 两侧：极有利流 ⇒ 高可靠候选通过；极不利流 ⇒ 低可靠候选拒绝
  assert.equal(shouldAttemptInjection(0.95, 30, () => 0.99), true, '高可靠 + 有利流 ⇒ 注入尝试');
  assert.equal(shouldAttemptInjection(0.02, 2, () => 0.01), false, '低可靠 + 不利流 ⇒ 拒绝');
  // (c) 分布单调：高可靠候选的通过率显著高于低可靠（Thompson 采样的真值主导面）
  const rateOf = (rel: number, use: number): number => {
    let pass = 0;
    const trials = 200;
    for (let i = 0; i < trials; i++) {
      if (shouldAttemptInjection(rel, use, mulberry32(10_000 + i))) pass++;
    }
    return pass / trials;
  };
  const hi = rateOf(0.9, 30);
  const lo = rateOf(0.05, 2);
  assert.ok(hi >= 0.7, `高可靠通过率 ≥0.7（实际 ${hi}）`);
  assert.ok(lo <= 0.35, `低可靠通过率 ≤0.35（实际 ${lo}）`);
  assert.ok(hi > lo, 'Thompson 决策随可靠度单调');
  // (d) 防御臂：采样器故障（uniform 抛错）⇒ 保守 false；垃圾入参被消毒成中性
  //     后验（r=0.5,n=1 ⇒ Beta(1.5,1.5)）—— 不抛、判词恒为布尔（保守消毒语义）
  assert.equal(shouldAttemptInjection(0.9, 10, (() => { throw new Error('rng boom'); }) as () => number), false);
  const garbageVerdict = shouldAttemptInjection(Number.NaN, -5, mulberry32(1));
  assert.equal(typeof garbageVerdict, 'boolean', '垃圾入参消毒后仍产合法判词（绝不抛）');
});

// ─── G3-7：dormant 两段激活律 ───

test('G3-7: 接收只登记 dormant；本地命中 2 次才激活并经 addDormantSkill 登记一次（幂等）', () => {
  const port = stubPort([digestRecord()]);
  skillFederation.configure(port);
  const fp = 'abcdef12:seed';
  const rr = skillFederation.receive([aggregatedOf(fp)], {
    localSkillCount: 4,
    trust: 1,
    maxRemoteShare: 0.5,
    now: () => 1000,
    rng: mulberry32(5),
  });
  assert.ok(rr.injected >= 0, '接收绝不抛');
  // Thompson 采样拒绝也是合法路径 —— 用多个指纹保证至少一个通过配额注入
  const fps = Array.from({ length: 8 }, (_, i) => `abcdef12:cand${i}`);
  const rr2 = skillFederation.receive(fps.map(f => aggregatedOf(f, { reliability: 0.95, useCount: 40 })), {
    localSkillCount: 20,
    trust: 1,
    maxRemoteShare: 1,
    now: () => 2000,
    rng: mulberry32(3),
  });
  assert.ok(rr2.injected >= 1, `高可靠候选至少一个通过 Thompson（实际 ${rr2.injected}）`);
  // 律②：登记的候选一律 dormant，端口零调用
  assert.equal(port.calls.length, 0, '接收阶段 addDormantSkill 零调用（默认 dormant 只登记）');
  const cands = skillFederation.candidatesSnapshot();
  assert.ok(cands.length >= 1);
  assert.ok(cands.every(c => c.state === 'dormant'), '候选默认 dormant —— 绝不进匹配池');
  const target = cands[0]!;
  // 律③：本地命中 1 次仍 dormant；2 次才激活
  const h1 = skillFederation.noteLocalHit(target.fingerprint, () => 3000);
  assert.equal(h1.state, 'dormant', '命中 1 次仍 dormant');
  assert.equal(h1.localHits, 1);
  assert.equal(port.calls.length, 0, '未过激活门不触端口');
  const h2 = skillFederation.noteLocalHit(target.fingerprint, () => 4000);
  assert.equal(h2.activated, true, `命中 ${SKILL_ACTIVATE_LOCAL_HITS} 次激活`);
  assert.equal(h2.registered, true);
  assert.equal(h2.state, 'active');
  assert.equal(port.calls.length, 1, '激活经端口登记恰好一次');
  // 登记草案：指纹 + 匿名场景前缀 + 分布摘要 + 溯源（不可执行件）
  const draft = port.calls[0]!;
  assert.equal(draft.fingerprint, target.fingerprint);
  assert.equal(draft.sceneFingerprint, 'abcdef12', '草案场景 = 匿名前缀（全指纹从未离开本机）');
  assert.equal(draft.provenance, 'federated');
  assert.equal(draft.aggregatedFrom, SKILL_MIN_AGGREGATE_SOURCES);
  assert.deepEqual(draft.slotStats, target.slotStats);
  // 幂等：激活后再命中只记账不重复登记
  const h3 = skillFederation.noteLocalHit(target.fingerprint, () => 5000);
  assert.equal(h3.activated, false);
  assert.equal(port.calls.length, 1, '激活幂等（不重复登记）');
  assert.equal(skillFederation.ledgerStats().activations, 1);
  assert.equal(skillFederation.ledgerStats().localHits, 3);
  // 未知指纹：本地巧合不臆造联邦候选
  const unknown = skillFederation.noteLocalHit('nope:unknown');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'unknown-fingerprint');
});

test('G3-7b: 端口拒绝/抛错 ⇒ 保持 dormant 下次命中重试（防御式绝不抛）', () => {
  const refusing = stubPort([digestRecord()], { failAdd: 'refuse' });
  skillFederation.configure(refusing);
  const fp = 'abcdef12:retry';
  skillFederation.receive([aggregatedOf(fp, { reliability: 0.95, useCount: 40 })], {
    localSkillCount: 10, trust: 1, maxRemoteShare: 1, rng: mulberry32(3), now: () => 1,
  });
  assert.equal(skillFederation.noteLocalHit(fp).state, 'dormant');
  const h2 = skillFederation.noteLocalHit(fp);
  assert.equal(h2.activated, false, '端口拒绝 ⇒ 不激活');
  assert.equal(h2.reason, 'addDormantSkill-refused');
  assert.equal(skillFederation.candidatesSnapshot()[0]!.state, 'dormant', '保持 dormant');
  // 抛错端口：同样降级不炸
  const throwing = stubPort([digestRecord()], { failAdd: 'throw' });
  skillFederation.configure(throwing);
  const fp2 = 'abcdef12:boom';
  skillFederation.receive([aggregatedOf(fp2, { reliability: 0.95, useCount: 40 })], {
    localSkillCount: 10, trust: 1, maxRemoteShare: 1, rng: mulberry32(3), now: () => 2,
  });
  assert.doesNotThrow(() => skillFederation.noteLocalHit(fp2));
  assert.doesNotThrow(() => skillFederation.noteLocalHit(fp2));
  assert.equal(skillFederation.candidatesSnapshot()[0]!.state, 'dormant', '端口抛错 ⇒ 保持 dormant');
  // 未接线端口：激活永远差最后一步（诚实 reason）
  skillFederation.configure(null);
  const fp3 = 'abcdef12:unwired';
  skillFederation.receive([aggregatedOf(fp3, { reliability: 0.95, useCount: 40 })], {
    localSkillCount: 10, trust: 1, maxRemoteShare: 1, rng: mulberry32(3), now: () => 3,
  });
  skillFederation.noteLocalHit(fp3);
  const r3 = skillFederation.noteLocalHit(fp3);
  assert.equal(r3.reason, 'port-not-wired');
});

// ─── G3-8：端口桩对接（契约形状） ───

test('G3-8: 与 W4-1 契约同形状的桩结构性满足端口；敌意端口诚实空手', () => {
  // 契约原形状（W4-1 的 listSkillDigests 返回形）—— 编译期结构核验 + 运行时消费
  const contractShaped = {
    listSkillDigests(): Array<{
      skillId: number;
      sceneFingerprint: string;
      stepsDigest: Array<Record<string, number>>;
      reliability: number;
    }> {
      return [
        {
          skillId: 1,
          sceneFingerprint: '1234abcd5678',
          stepsDigest: [{ dx: 0.3, dy: 0.4 }],
          reliability: 0.7,
        },
      ];
    },
    addDormantSkill(d: { fingerprint: string }): boolean {
      return typeof d.fingerprint === 'string';
    },
  };
  const port: SkillLibraryPort = contractShaped; // 结构性满足（缺 useCount ⇒ 保守 1）
  const uploads = buildSkillUploads(port, { epsilon: 1, seed: 11 });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]!.useCount, 1, '契约无 useCount ⇒ 保守 1');
  assert.ok(uploads[0]!.fingerprint.startsWith('1234abcd:'));
  assert.ok(contractShaped.addDormantSkill({ fingerprint: uploads[0]!.fingerprint }), '登记草案可被契约方消费');

  // 敌意端口：listSkillDigests 抛错 ⇒ 诚实空数组（绝不炸宿主）
  assert.deepEqual(buildSkillUploads(stubPort([], { failAdd: 'throw-list' }), { seed: 1 }), []);
  // 陷阱记录：单条故障 ⇒ 该条缺席，其余照常
  const trapRec: SkillDigestRecord = {
    skillId: 0,
    get sceneFingerprint(): string { throw new Error('trap'); },
    stepsDigest: [{ dx: 1 }],
    reliability: 0.5,
  };
  const mixed = buildSkillUploads(
    { listSkillDigests: () => [trapRec, digestRecord()], addDormantSkill: () => true },
    { seed: 2 },
  );
  assert.equal(mixed.length, 1, '陷阱记录缺席，诚实记录照常上传');
  // 端口形状坏/缺席 ⇒ 空手
  assert.deepEqual(buildSkillUploads(null), []);
  assert.deepEqual(buildSkillUploads({} as SkillLibraryPort), []);
  assert.deepEqual(buildSkillUploads({ listSkillDigests: () => 'junk', addDormantSkill: () => true } as unknown as SkillLibraryPort, { seed: 3 }), []);
});

// ─── G3-9：packet v2 兼容 + swarm 接线 ───

test('G3-9: buildPacket schema v2 —— v1 字段逐字节不变、技能段白名单、老 peer 忽略新段', () => {
  swarm.observeDrift('a'.repeat(64), 0.1, 0.2);
  const seeded = mulberry32(77);
  // (a) 未接线：schema 升 2 但无技能段，v1 字段照常
  const bare = swarm.buildPacket(1, seeded);
  assert.equal(bare.schema, 2, 'schema 升级 v2');
  assert.equal(bare.skills, undefined, '未接线 ⇒ 无技能段（老 peer 零感知）');
  assert.equal(typeof bare.instanceId, 'string');
  assert.ok(Array.isArray(bare.crystals) && Array.isArray(bare.driftEvents));
  assert.equal((bare as { dp_epsilon?: number }).dp_epsilon, 1);
  // (b) 接线：技能段在场且为白名单形状；v1 字段形状不变
  const fixedUpload: SkillFederationUpload = {
    v: 1, fingerprint: 'abcdef12:k1', slotStats: { dx: { median: 0.3, iqr: 0.05 } }, reliability: 0.8, useCount: 5,
  };
  swarm.attachSkillFederation({
    uploads: (eps, rng) => {
      assert.equal(eps, 2, 'dpEpsilon 透传（同一 DP 纪律）');
      assert.equal(typeof rng, 'function', '随机流透传（确定性缝统一）');
      return [fixedUpload];
    },
    ledgerStats: () => ({
      wired: true, candidates: 1, dormant: 1, active: 0, localHits: 2, activations: 0, thompsonAttempts: 1, lastReceivedAt: 42,
    }),
  });
  const p = swarm.buildPacket(2, seeded) as {
    schema: number; instanceId: string; crystals: unknown[]; driftEvents: unknown[];
    dp_epsilon: number; skills?: { v: number; dpEpsilon: number; uploads: SkillFederationUpload[] };
  };
  assert.equal(p.schema, 2);
  assert.equal(p.skills!.v, 1);
  assert.equal(p.skills!.dpEpsilon, 2);
  assert.deepEqual(p.skills!.uploads, [fixedUpload]);
  // 老 peer 视角：忽略未知段后，v1 消费面逐字段可用（向后兼容律）
  const legacyView = { instanceId: p.instanceId, crystals: p.crystals, driftEvents: p.driftEvents };
  assert.ok(legacyView.instanceId.startsWith('inst-'));
  assert.ok(legacyView.driftEvents.length <= 20);
  assert.deepEqual(
    JSON.parse(JSON.stringify({ ...p, skills: undefined, schema: 1 })).crystals,
    p.crystals,
    '剥新段降 v1：v1 字段语义不变',
  );
  // (c) 提供者故障：吞掉成无技能段，绝不炸包
  swarm.attachSkillFederation({
    uploads: () => { throw new Error('provider boom'); },
    ledgerStats: () => { throw new Error('stats boom'); },
  });
  const degraded = swarm.buildPacket(1, seeded) as { skills?: unknown };
  assert.equal(degraded.skills, undefined, '提供者故障 ⇒ 无技能段（诚实降级）');
  // (d) report：联邦技能账（接线面 + 防御面）
  swarm.attachSkillFederation({
    uploads: () => [fixedUpload],
    ledgerStats: () => ({ wired: true, candidates: 3, dormant: 2, active: 1, localHits: 5, activations: 1, thompsonAttempts: 3, lastReceivedAt: 9 }),
  });
  const wired = swarm.report().federatedSkills;
  assert.equal(wired.wired, true);
  assert.equal(wired.candidates, 3);
  assert.equal(wired.dormant, 2);
  assert.equal(wired.active, 1);
  assert.equal(wired.localHits, 5);
  assert.equal(wired.activations, 1);
  swarm.attachSkillFederation(null);
  const off = swarm.report().federatedSkills;
  assert.equal(off.wired, false);
  assert.equal(off.candidates, 0, '摘线 ⇒ 联邦技能账诚实归零');
  // 形状坏的提供者按未接线处理
  swarm.attachSkillFederation({ wrong: true } as unknown as Parameters<typeof swarm.attachSkillFederation>[0]);
  assert.equal(swarm.report().federatedSkills.wired, false);
});

test('G3-9b: wireSwarmSkillFederation 一行接线 —— packet 携带真端口上传、report 见账、摘线还原', () => {
  const port = stubPort([digestRecord(), digestRecord({ sceneFingerprint: 'ffff0000beef' })]);
  assert.equal(wireSwarmSkillFederation(port), true, '接线成功');
  assert.equal(swarm.report().federatedSkills.wired, true);
  const p = swarm.buildPacket(1, mulberry32(9)) as { skills?: { uploads: SkillFederationUpload[] } };
  assert.equal(p.skills!.uploads.length, 2, 'packet 技能段由真端口铸造');
  assert.ok(p.skills!.uploads.every(u => u.v === 1));
  // 摘线：显式 null 也是成功语义，行为还原
  assert.equal(wireSwarmSkillFederation(null), true);
  assert.equal(swarm.report().federatedSkills.wired, false);
  const bare = swarm.buildPacket(1, mulberry32(9)) as { skills?: unknown };
  assert.equal(bare.skills, undefined);
  // 形状坏端口：接线拒绝（false），swarm 保持未接线行为
  assert.equal(wireSwarmSkillFederation({} as SkillLibraryPort), false);
  assert.equal(swarm.buildPacket(1, mulberry32(9)).skills, undefined);
});

// ─── G3-10：三道闸 + 独立记账 + 诚实跳过 ───

test('G3-10: 三道闸（零证据/份额帽/信任折减）+ 技能联邦独立记账 + 诚实跳过', () => {
  const port = stubPort([digestRecord()]);
  skillFederation.configure(port);
  const cands = Array.from({ length: 8 }, (_, i) => aggregatedOf(`abcdef12:g${i}`, { reliability: 0.95, useCount: 40 }));
  const goodRng = mulberry32(3); // 与 G3-7 同流：高可靠候选可通过 Thompson

  // 闸①：本地零证据不掺（端口实读 localSkillCount=1 但显式注入 0 —— 两臂同律）
  const g1 = skillFederation.receive(cands, { localSkillCount: 0, trust: 1, maxRemoteShare: 1, rng: goodRng, now: () => 1 });
  assert.equal(g1.injected, 0);
  assert.ok(g1.notes.some(n => n.includes('闸①')), '零本地证据注记在案');
  // 未接线且未注入 localSkillCount ⇒ 端口缺席按 0：同闸
  skillFederation.configure(null);
  const g1b = skillFederation.receive(cands, { rng: goodRng, now: () => 2 });
  assert.equal(g1b.injected, 0);
  skillFederation.configure(port);

  // 闸②：份额帽 —— share=0.5 × 本地 2 技 ⇒ cap=1：配额内只注入 1 个
  const g2 = skillFederation.receive(cands, { localSkillCount: 2, trust: 1, maxRemoteShare: 0.5, rng: mulberry32(3), now: () => 3 });
  assert.equal(g2.cap, 1, 'cap = floor(0.5 × 2)');
  assert.equal(g2.injected, 1, '份额帽截断：只注入 cap 个');
  assert.ok(
    g2.perFingerprint.filter(f => f.decision === 'quota-exhausted').length >= 1,
    '配额用尽的候选诚实出局（quota-exhausted）',
  );

  // 闸③：信任折减 —— trust=0.4 × cap=1 ⇒ quota=0 ⇒ 全跳
  const g3 = skillFederation.receive(cands, { localSkillCount: 2, trust: 0.4, maxRemoteShare: 0.5, rng: mulberry32(3), now: () => 4 });
  assert.equal(g3.quota, 0);
  assert.equal(g3.injected, 0);
  assert.ok(g3.notes.some(n => n.includes('闸③')), '信任折没注记在案');
  // 信任账路径：sourceId 的 1/(1+regressed) 折没配额（沿用联邦信任函数）
  recordFederationTrust('fed-src', { regressed: 5 });
  assert.equal(federationTrustOf('fed-src'), 1 / 6);
  const g3b = skillFederation.receive(cands, { localSkillCount: 1, sourceId: 'fed-src', maxRemoteShare: 1, rng: mulberry32(3), now: () => 5 });
  assert.equal(g3b.trust, 1 / 6, '信任函数 1/(1+regressed) 入闸');
  assert.equal(g3b.injected, 0, 'quota = floor(1 × 1/6) = 0');
  // 初见源全信：trust=1（与联邦初见全信同律）
  const g3c = skillFederation.receive(cands.slice(0, 1), { localSkillCount: 4, sourceId: 'fresh-src', maxRemoteShare: 0.5, rng: mulberry32(3), now: () => 6 });
  assert.equal(g3c.trust, 1);

  // 独立记账：技能联邦的接收不写联邦证据信任账（applied/regressed 零变化）
  const before = JSON.stringify(federationTrustReport());
  skillFederation.receive(cands.slice(0, 1), { localSkillCount: 4, trust: 1, maxRemoteShare: 1, rng: mulberry32(3), now: () => 7 });
  assert.equal(JSON.stringify(federationTrustReport()), before, '技能联邦掺入独立记账（不动证据信任账）');
  assert.ok(skillFederation.ledgerStats().thompsonAttempts >= 1, '技能侧自有计数器在账');

  // k<3 防御复审：聚合门在接收端再执法一次
  const g4 = skillFederation.receive([aggregatedOf('abcdef12:lowk', { aggregatedFrom: 2 })], {
    localSkillCount: 4, trust: 1, maxRemoteShare: 1, rng: mulberry32(3), now: () => 8,
  });
  assert.equal(g4.injected, 0);
  assert.deepEqual(g4.perFingerprint, [{ fingerprint: 'abcdef12:lowk', decision: 'reject-k-lt-3' }]);

  // 诚实跳过：peer 缺席 / 空聚合 / 垃圾载荷 ⇒ 零注入零异常
  for (const empty of [[], null, 'junk', { not: 'array' }]) {
    const r = skillFederation.receive(empty as unknown, { localSkillCount: 4, trust: 1, maxRemoteShare: 1, rng: mulberry32(3), now: () => 9 });
    assert.equal(r.injected, 0);
    assert.equal(r.ok, true);
  }
  assert.ok(skillFederation.receive([], { localSkillCount: 4 }).notes[0]!.includes('诚实空手'));
});
