// test/pan6975.fedprivacy.test.ts
// ΠΑΝ 修复潮执法册（联邦数据面 —— 差分隐私与鲁棒聚合的数学真正成立）：
//   ΠΑΝ-69 值域分离（typed channels）—— 哈希通道不再坍缩到常数：hashArgsNumeric
//          型 uint32 值（>4096）走原生域（不裁剪、网格 1、h 族标），指纹随参数
//          分布而变（旧律全裁到 4096 ⇒ 桶号恒 81920、中位数恒 4096、IQR 检疫
//          永不触发）；坐标通道（|v| ≤ 4096）旧律逐字节（金样保持）；两族桶
//          空间不相交；哈希槽的 DP 噪声不吃检疫票（阈地板 3×1）。
//   ΠΑΝ-70 DP 种子密钥派生 —— 种子不可从公开面推出：seed = HMAC(K_fed,
//          digest_id)（digest_id 含进程内序号 —— 同毫秒不同铸）；密钥缺席 ⇒
//          诚实拒绝 mint（fail-closed，绝不退化 nowMs>>>0 旧种子）；ε 越界拒绝
//          （0 / 负 / NaN / 超单次上限）；注入 rng 非有限 ⇒ 整次铸造中止（绝不
//          零噪声真值出境）；config ε 范围校验对接点 validFederationEpsilon。
//   ΠΑΝ-71 预算主体记账 —— 账户键 = 主体 # 键（s:${subject}|k:${key}）：滑窗内容
//          变化不换账（同主体同键的滑窗重叠释放组合累计）；换键/换主体才开新账
//          （键族间并行组合）；账本 Map 有冻结上界（满员拒绝开新账 —— 不逐出）。
//   ΠΑΝ-72 检疫账对齐 —— 签名路径的掺入配额查**参与合并的指纹账**最弱链（min）：
//          毒指纹的 regressed 折减在下一轮真实咬合配额；裸 endpoint 账不再被签名
//          路径开立。
//   ΠΑΝ-73 回声环与稀释 —— 掺入记录不进下一轮摘要（origin 过滤）；掺入上限的
//          本地证据计数排除联邦记录（掺入量不自增配额）。
//   ΠΑΝ-74 新鲜度与撤销 —— 摘要携带 mintedAt + TTL：过期/无时间锚的远端件在
//          聚合前剔除（staleSources 计数）；本地撤销表（可落盘）命中 ⇒ 源立即
//          出局（revokedSources 计数 —— 比检疫票硬一档）；名册饱和律
//          （federationMaxRemotes：已知客户端数封顶，换钥撑名册抬不动限额）。
//   ΠΑΝ-75 swarm 隐私 —— 上行 driftEvents 的 sceneHash 经本地盐 HMAC 私有标签：
//          不等于原 dHash、不可与已知屏幕字典匹配（无钥推不出）、进程内稳定
//          （同场景同标签）、异场景异标签；本地 drifts 保持真值。
// 全程离线（fetch 全假件/零调用）、rng/时钟/密钥全注入、确定性；生产单例复位。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, createHash, sign as edSign, type KeyObject, createHmac } from 'node:crypto';

import { EvidenceLedger } from '../src/kernel/registry.ts';
import {
  mintEvidenceDigest,
  applyFederatedEvidence,
  federationSync,
  validFederationEpsilon,
  federationDpSeed,
  FEDERATION_DP_KEY_ENV,
  federationMaxRemotes,
  KNOWN_CLIENT_ROSTER_SATURATION,
  PRIVACY_BUDGET_MAX_ACCOUNTS,
  PRIVACY_BUDGET_EPSILON_TOTAL,
  isFederationSourceRevoked,
  revokeFederationSource,
  unrevokeFederationSource,
  federationRevocationList,
  createFederationRevocationFileStore,
  armFederationRevocationList,
  loadFederationRevocations,
  flushFederationRevocations,
  restoreFederationTrust,
  resetFederationRuntime,
  federationTrustOf,
  federationTrustReport,
  recordFederationTrust,
  federationFingerprintSourceId,
  canonicalFederationJson,
  signEvidenceDigest,
  verifyEvidenceDigestSignature,
  type EvidenceDigest,
  type FederationFetch,
} from '../src/federation/index.ts';
import { resetPrivacyBudgetRuntime, privacyBudgetReport, privacyBudgetOf } from '../src/federation/digest.ts';
import { FEDERATION_DIGEST_TTL_MS } from '../src/federation/apply.ts';
import {
  skillFingerprintOf,
  buildSkillUploads,
  aggregateSkillShares,
  slotChannelOf,
  SKILL_HASH_DOMAIN_MAX,
  SKILL_LSH_GRID,
  SKILL_SLOT_CLIP,
  type SkillLibraryPort,
  type SkillDigestRecord,
  type SkillFederationUpload,
} from '../src/skillFederation.ts';
import { swarm, privateSceneTag } from '../src/swarm.ts';
import { mulberry32 } from '../src/federation/digest.ts';

beforeEach(() => {
  resetFederationRuntime();
  resetPrivacyBudgetRuntime();
  delete process.env[FEDERATION_DP_KEY_ENV];
});

// ─── 假件工坊 ───

/** 8×[v,v] 均匀坨 */
function uniformBins(v: number): number[][] {
  return Array.from({ length: 8 }, () => [v, v]);
}

/** 手铸单 key 摘要 */
function digestOf(key: string, bins: number[][], n: number, mintedAt: number): EvidenceDigest {
  return { v: 1, mintedAt, epsilon: 1, keys: [{ key, n, bins }] };
}

/** n 条本地证据的账本 */
function seedLedger(key: string, n: number): EvidenceLedger {
  const l = new EvidenceLedger();
  for (let i = 0; i < n; i++) l.record({ key, success: i % 2 === 0, margin: 0.1 * i - 0.5, ts: i });
  return l;
}

/** hashArgsNumeric 的测试侧复刻（skillLibrary.signatures.ts 同律 —— FNV-1a 数值哈希） */
function hashArgsNumericLike(seedStr: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Ed25519 测试客户端（签名/指纹假件 —— epochMu2 同律） */
function edClient(): {
  material: string;
  fingerprint: string;
  sign: (d: EvidenceDigest) => EvidenceDigest & { pubkey: string; sig: string };
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const material = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const fingerprint = createHash('sha256').update(spki).digest('hex').slice(0, 16);
  const publicKeyB64 = spki.toString('base64');
  const sign = (d: EvidenceDigest): EvidenceDigest & { pubkey: string; sig: string } => {
    const domain = canonicalFederationJson({ v: d.v, mintedAt: d.mintedAt, epsilon: d.epsilon, keys: d.keys });
    const sig = edSign(null, Buffer.from(domain, 'utf8'), privateKey as KeyObject).toString('base64');
    return { ...d, pubkey: publicKeyB64, sig };
  };
  return { material, fingerprint, sign };
}

/** 技能端口桩 */
function stubPort(records: SkillDigestRecord[]): SkillLibraryPort {
  return {
    listSkillDigests: () => records,
    addDormantSkill: () => true,
  };
}

// ─── ΠΑΝ-69：哈希通道不坍缩 ───

test('ΠΑΝ-69: 哈希通道不坍缩到常数 —— 指纹/槽统计/检疫随参数分布而变；坐标通道旧律保持；两族分族', () => {
  // (a) 分类律：uint32 哈希值 ⇒ 'hash'；坐标/归一化值 ⇒ 'coord'；非有限 ⇒ 缺席
  assert.equal(slotChannelOf(3_500_000_000), 'hash', 'uint32 哈希 ⇒ 哈希通道');
  assert.equal(slotChannelOf(4_294_967_295), 'hash', 'uint32 上界 ⇒ 哈希通道');
  assert.equal(slotChannelOf(SKILL_SLOT_CLIP), 'coord', '4096 恰在坐标域（含界）');
  assert.equal(slotChannelOf(4096.5), 'hash', '刚越界 ⇒ 哈希通道');
  assert.equal(slotChannelOf(0.12), 'coord', '归一化坐标 ⇒ 坐标通道');
  assert.equal(slotChannelOf(-3512), 'coord', '负坐标 ⇒ 坐标通道');
  assert.equal(slotChannelOf(Number.NaN), null, '非有限 ⇒ 缺席');

  // (b) 指纹不再坍缩：三个参数互异的工作流（同场景同键位）⇒ 三个互异指纹
  //（旧律：三个 uint32 全裁到 4096 ⇒ 同桶 81920 ⇒ 同指纹）
  const scene = 'aabbccdddeadbeef';
  const fpOf = (hash: number): string => skillFingerprintOf(scene, [{ click_mouse: hash }]);
  const h1 = hashArgsNumericLike('{x:0.31,y:0.52}');
  const h2 = hashArgsNumericLike('{x:0.31,y:0.53}');
  const h3 = hashArgsNumericLike('{x:0.99,y:0.11}');
  assert.ok(h1 > SKILL_SLOT_CLIP && h2 > SKILL_SLOT_CLIP && h3 > SKILL_SLOT_CLIP, '测试前提：哈希值 > 4096');
  const fps = new Set([fpOf(h1), fpOf(h2), fpOf(h3)]);
  assert.equal(fps.size, 3, '参数互异的工作流 ⇒ 指纹互异（旧律全坍缩成同指纹）');

  // (c) 槽统计不再坍缩：中位数跟踪真值哈希（≠ 4096 常量）；域标注随摘要上行
  const rec = (hash: number): SkillDigestRecord => ({
    skillId: 's1',
    sceneFingerprint: scene,
    stepsDigest: [{ click_mouse: hash }],
    reliability: 0.8,
    useCount: 9,
  });
  const uploads = buildSkillUploads(stubPort([rec(h1)]), { epsilon: 1, seed: 7 });
  const slot = uploads[0]!.slotStats['click_mouse']!;
  assert.ok(slot, '哈希槽在统计中');
  assert.equal(slot.domain, 'hash', '值域标注随摘要上行（typed channel）');
  assert.ok(
    Math.abs(slot.median - h1) <= 6, // Laplace(1/ε) 尺度 1 ⇒ |noise| 有界
    `哈希槽中位数 ≈ 真值 ${h1}（实测 ${slot.median} —— 不再是 4096 常量）`,
  );
  assert.notEqual(slot.median, SKILL_SLOT_CLIP, '中位数 ≠ 裁剪边界 4096（坍缩已修复）');

  // (d) 两族分族：坐标桶号与哈希值不相交（token 域隔离 —— h 族标）
  //（构造对拍：坐标值 5000? 不 —— 5000 > 4096 是哈希域。取坐标 4000（桶 80000）
  //   与哈希 4000 不可能同域 —— 改为验证同数值两通道判定唯一，及指纹随通道不同）
  const fpCoord = skillFingerprintOf(scene, [{ dx: 0.35 }]); // 坐标通道（旧律金样路径）
  const fpHash = skillFingerprintOf(scene, [{ dx: 3_500_000_000 }]); // 哈希通道
  assert.notEqual(fpCoord, fpHash, '坐标槽与哈希槽指纹分离（族标隔离）');
  // 坐标通道旧律保持：0.05 网格内抖动碰撞（既有 LSH 金样律 —— 零回归）
  assert.equal(skillFingerprintOf(scene, [{ dx: 0.35 }]), skillFingerprintOf(scene, [{ dx: 0.36 }]), '坐标通道半网格内碰撞（旧律）');
  assert.notEqual(skillFingerprintOf(scene, [{ dx: 0.35 }]), skillFingerprintOf(scene, [{ dx: 0.42 }]), '坐标通道跨网格分离（旧律）');

  // (e) 哈希槽检疫不吃 DP 噪声票：4 源同指纹同哈希（身份一致），DP 噪声 |noise|
  //     中位 ≈0.69 < 阈地板 3 ⇒ 零票（旧律 0.15 的坐标地板会把噪声逐槽计票）。
  //     攻击模型：源**自称同指纹**（fingerprint 声明域）而中位数报异值 —— 指纹
  //     真随值变（fpOf(h+5000)）的源会另立 k=1 组被 k≥3 门拒聚，到不了检疫面
  const shareWith = (median: number): SkillFederationUpload => ({
    v: 1,
    fingerprint: fpOf(h1),
    slotStats: { click_mouse: { median, iqr: 0, domain: 'hash' as const } },
    reliability: 0.8,
    useCount: 10,
  });
  const rr = aggregateSkillShares([shareWith(h1), shareWith(h1 + 1), shareWith(h1 + 2), shareWith(h1 + 3)], {
    sourceIds: ['a', 'b', 'c', 'd'],
  });
  assert.equal(rr.aggregated.length, 1, '同指纹聚合');
  assert.deepEqual(rr.quarantined, {}, '哈希槽 DP 噪声级差异零票（阈地板 3×1 —— 不再误伤诚实源）');
  // 毒哈希（自称同指纹、中位数报异值）⇒ 过阈计票（检疫有牙）。4 诚实源 + 1 毒源：
  // 离散臂由诚实簇决定（MAD=1 ⇒ 2×MAD=2 ⇒ T=4），毒偏差 4998 远过阈 —— 源数
  // 不足（≤3 诚实 + 1 毒）时旧 2×IQR 律的插值四分位会把毒隙半程混进 q3（T 被
  // 拉爆吞掉离群）——该保守面已由 ΤΕΛ-5 D-G25③ 闭合（离散臂换 MAD 口径的 IQR
  // 等价换算：少源毒值拉不动尺度；执法例见 test/tel5.fixes.test.ts ③b/c）
  const rr2 = aggregateSkillShares(
    [shareWith(h1), shareWith(h1 + 1), shareWith(h1 + 2), shareWith(h1 + 3), shareWith(h1 + 5_000)],
    { sourceIds: ['a', 'b', 'c', 'd', 'poison'] },
  );
  assert.ok((rr2.quarantined['poison'] ?? 0) >= 1, '身份级偏差（异哈希值）过阈计票');
  assert.deepEqual(
    { a: rr2.quarantined['a'] ?? 0, b: rr2.quarantined['b'] ?? 0, c: rr2.quarantined['c'] ?? 0, d: rr2.quarantined['d'] ?? 0 },
    { a: 0, b: 0, c: 0, d: 0 },
    '诚实源零票（阈不被毒源拉爆 —— 4 诚实源域）',
  );
  // ΤΕΛ-5 D-G25③：旧「≥4 诚实源可用域」外的吞没域闭合 —— 2 诚实 + 1 毒（k=3
  // 过拒聚门）毒源照常计票、诚实源零票（MAD 离散臂不被单条毒值拉爆）
  const rr3 = aggregateSkillShares(
    [shareWith(h1), shareWith(h1 + 1), shareWith(h1 + 5_000)],
    { sourceIds: ['a', 'b', 'poison'] },
  );
  assert.ok((rr3.quarantined['poison'] ?? 0) >= 1, 'k=3 组毒源过阈计票（旧律 2×IQR≈毒隙吞没 —— 已闭合）');
  assert.deepEqual(
    { a: rr3.quarantined['a'] ?? 0, b: rr3.quarantined['b'] ?? 0 },
    { a: 0, b: 0 },
    'k=3 组诚实源零票',
  );

  // (f) 域防御钳制：超大值夹回 uint32 上界（非语义裁剪）
  const big = buildSkillUploads(stubPort([rec(Number.MAX_SAFE_INTEGER)]), { epsilon: 1, seed: 3 });
  assert.ok(big[0]!.slotStats['click_mouse']!.median <= SKILL_HASH_DOMAIN_MAX, '超大值防御钳制到 uint32 上界');
});

// ─── ΠΑΝ-70：种子不可从公开面推出 + 参数非法 fail-closed ───

test('ΠΑΝ-70: HMAC 种子 —— 同刻不同铸、公开面暴力推不出、密钥缺席诚实拒绝', async () => {
  const EP = 'https://pan70.example/fed';
  const K = 'fed.pan70';
  let body1 = '';
  let body2 = '';
  const fake = (async (_u: string, init: { body: string }) => {
    if (body1 === '') body1 = init.body;
    else body2 = init.body;
    return { json: async () => ({ digests: [] }) };
  }) as unknown as FederationFetch;
  const ledger = seedLedger(K, 20);

  // (a) 同 nowMs 同密钥同账本 ⇒ 两次 sync 摘要**不同**（digest_id 的进程内序号段
  //     —— 公开面（mintedAt 相同）推不出种子；旧律同毫秒 ⇒ 同种子同噪声流）
  const r1 = federationSync({ endpoint: EP, fetchImpl: fake, ledger, dpKey: 'k-pan70', now: () => 777 });
  await r1.settled;
  const r2 = federationSync({ endpoint: EP, fetchImpl: fake, ledger, dpKey: 'k-pan70', now: () => 777 });
  await r2.settled;
  assert.ok(r1.digest && r2.digest, '两轮铸造成功');
  assert.equal(r1.digest!.mintedAt, r2.digest!.mintedAt, '公开域 mintedAt 相同（攻击者的全部公开面）');
  assert.notEqual(body1, body2, '同刻不同铸 ⇒ 种子/噪声流互异（mintedAt 不再泄种）');

  // (b) 公开面暴力反推不可行：以 mintedAt 为中心的旧派生族（nowMs>>>0 及邻域）+ 无钥
  //     HMAC 全部无法复现上行摘要（种子 = HMAC(K_fed, `${now}|${seq}|${endpoint}`)，
  //     seq 是模块私有状态）
  const mintedAt = r1.digest!.mintedAt;
  const uplink = JSON.parse(body1) as EvidenceDigest;
  const candidateSeeds: number[] = [];
  for (let d = -5; d <= 5; d++) candidateSeeds.push((mintedAt + d) >>> 0);
  candidateSeeds.push(mintedAt % 0xFFFFFFFF);
  // 无法枚举 seq —— 连「知道密钥但不知道 seq」的强攻击者也要试遍序号空间；测试
  // 至少锁：旧派生（nowMs>>>0）与错密钥 HMAC 都不命中
  const wrongKeySeed = federationDpSeed('wrong-key', `${mintedAt}|1|${EP}`);
  assert.ok(typeof wrongKeySeed === 'number', '错密钥也产出确定种子（HMAC 性质）');
  let anyMatch = false;
  for (const seed of [...candidateSeeds, wrongKeySeed!]) {
    const replay = mintEvidenceDigest(ledger, { seed, epsilon: 1, now: () => mintedAt });
    if (replay !== null && JSON.stringify(replay) === JSON.stringify(uplink)) anyMatch = true;
  }
  assert.equal(anyMatch, false, '公开面派生族（mintedAt 邻域 / 错钥 HMAC）无一复现上行摘要');

  // (c) 密钥缺席（无 env / 无 dpKey / 无显式 seed）⇒ 诚实拒绝 mint：零网络零应用
  //     （绝不退化为 nowMs>>>0 公开可推种子 —— 那等于真值明文出境）
  let spyCalls = 0;
  const spy = (() => { spyCalls += 1; return Promise.resolve({ json: async () => null }); }) as unknown as FederationFetch;
  const r3 = federationSync({ endpoint: EP, fetchImpl: spy, ledger });
  assert.equal(r3.ok, false, '密钥缺席 ⇒ ok:false（fail-closed）');
  assert.equal(r3.digest, null, '零摘要');
  assert.equal(r3.network, 'off', '零网络');
  assert.equal(spyCalls, 0, 'fetch 零调用');
  assert.ok(
    (await import('../src/federation/index.ts')).lastFederationSync()?.note?.includes(FEDERATION_DP_KEY_ENV),
    `拒绝注记指路 env（${(await import('../src/federation/index.ts')).lastFederationSync()?.note}）`,
  );
  // env 在场 ⇒ 缺省读 env 照常铸造（生产接线面）。注：先复位预算账本 —— (b) 的
  // 反推重放簇每次成功 mint 都是真 release（各 +1ε 记 s:local|k:… 账，早已耗尽），
  // 那是 (b) 自己的预算脚印，不该让 (c) 的「env 密钥路径」检查吃 budget-exhausted
  resetPrivacyBudgetRuntime();
  process.env[FEDERATION_DP_KEY_ENV] = 'k-env-pan70';
  const r4 = federationSync({ endpoint: '', ledger, now: () => 778 });
  assert.equal(r4.ok, true, 'env 密钥 ⇒ 离线铸造照常');
  delete process.env[FEDERATION_DP_KEY_ENV];

  // (d) federationDpSeed 纯函数律：空钥 ⇒ null；同钥同 id 确定性；异 id 异种
  assert.equal(federationDpSeed('', 'x'), null, '空钥 ⇒ null');
  assert.equal(federationDpSeed('k', 'x'), federationDpSeed('k', 'x'), '同钥同 id 确定性');
  assert.notEqual(federationDpSeed('k', 'x'), federationDpSeed('k', 'y'), '异 id 异种');
});

test('ΠΑΝ-70: ε 越界拒绝（0/负/NaN/超单次上限）+ rng 非有限 ⇒ 整次铸造中止（fail-closed）', async () => {
  const ledger = seedLedger('fed.eps', 10);
  // (a) validFederationEpsilon 纯函数律（config ε 范围校验对接点）
  for (const good of [0.1, 1, 5, 10]) assert.equal(validFederationEpsilon(good), true, `ε=${good} 合法`);
  for (const bad of [0, -1, -0.001, Number.NaN, Number.POSITIVE_INFINITY, 10.0001, 100]) {
    assert.equal(validFederationEpsilon(bad), false, `ε=${bad} 越界`);
  }
  assert.equal(validFederationEpsilon(undefined), false, '非数 ⇒ 越界');
  // (b) mint 层：显式 ε=0/负/NaN ⇒ null（不静默回落缺省 —— 旧律「配置错当没配」废除）
  for (const bad of [0, -2, Number.NaN]) {
    assert.equal(mintEvidenceDigest(ledger, { epsilon: bad, seed: 1, now: () => 1 }), null, `显式 ε=${bad} ⇒ 拒绝铸造`);
  }
  // ε 缺席 ⇒ 缺省 1 照常（「没配」与「配错」是两件事）
  assert.ok(mintEvidenceDigest(ledger, { seed: 2, now: () => 2 }) !== null, 'ε 缺席 ⇒ 缺省 1 照常');
  // (c) sync 层：ε 越界（含超单次上限 10）⇒ 拒绝同步（零网络零应用 + 如实注记）
  for (const bad of [0, -1, Number.NaN, 11, 1000]) {
    const r = federationSync({ endpoint: 'https://pan70e.example/fed', ledger, epsilon: bad, dpKey: 'k' });
    assert.equal(r.ok, false, `sync ε=${bad} ⇒ 拒绝`);
    assert.equal(r.network, 'off', '零网络');
  }
  const rOk = federationSync({ endpoint: '', ledger, epsilon: 1, dpKey: 'k' });
  assert.equal(rOk.ok, true, '合法 ε=1 照常');
  // (d) 注入 rng 产出非有限抽头 ⇒ 整次铸造中止（绝不以零噪声真值出境 —— 旧律
  //     laplaceNoise 对 NaN u 返回 0，真值取整后原样出境）
  const midBoom = (): (() => number) => {
    let draws = 0;
    return () => (draws++ < 3 ? 0.42 : Number.NaN); // 前 3 抽健康、第 4 抽起炸
  };
  const boom: Array<() => number> = [
    () => Number.NaN,
    () => Number.POSITIVE_INFINITY,
    midBoom(),
    midBoom(),
  ];
  for (const rng of boom) {
    assert.equal(mintEvidenceDigest(ledger, { seed: 1, rng, now: () => 3 }), null, 'rng 非有限抽头 ⇒ 整次中止');
  }
  // 对照：健康注入流照常（全部有限）
  assert.ok(mintEvidenceDigest(ledger, { seed: 1, rng: mulberry32(9), now: () => 4 }) !== null, '健康注入流照常');
});

// ─── ΠΑΝ-71：预算按主体记账（滑窗组合 + 键族并行 + 账本上界） ───

test('ΠΑΝ-71: 滑窗损失组合（内容变不换账）；键族/主体并行开新账；账本满员拒绝开新账', () => {
  // (a) 滑窗组合：同主体同键 10 次 release 耗尽；窗口滑动（新增 1 条）后仍拒绝
  //     （相邻窗共享 19/20 条记录的重叠释放按朴素序列组合累计 —— 旧律换指纹换账）
  const K = 'fed.pan71';
  const ledger = seedLedger(K, 20);
  for (let i = 1; i <= PRIVACY_BUDGET_EPSILON_TOTAL; i++) {
    assert.ok(mintEvidenceDigest(ledger, { seed: i, now: () => 100 + i }) !== null, `第 ${i} 次放行`);
  }
  ledger.record({ key: K, success: true, margin: 0.4, ts: 999 }); // 滑窗滑动一条
  assert.equal(mintEvidenceDigest(ledger, { seed: 99, now: () => 500 }), null, '滑窗滑动 ⇒ 同账 ⇒ 仍拒绝（组合记账）');
  assert.equal(privacyBudgetReport().length, 1, '不开新账户');
  assert.equal(privacyBudgetOf('s:local|k:' + K)!.exhausted, true, '账户键 = s:local|k:fed.pan71 且已耗尽');

  // (b) 键族并行：同一 release 里两个 key ⇒ 两个账户各记 ε（disjoint 个体不叠加）
  resetPrivacyBudgetRuntime();
  const two = new EvidenceLedger();
  for (let i = 0; i < 6; i++) two.record({ key: 'fed.a', success: true, margin: 0.2, ts: i });
  for (let i = 0; i < 6; i++) two.record({ key: 'fed.b', success: true, margin: -0.2, ts: i });
  assert.ok(mintEvidenceDigest(two, { seed: 5, now: () => 600 }) !== null, '双 key 铸造');
  const accounts = privacyBudgetReport();
  assert.equal(accounts.length, 2, '两键两账（并行组合）');
  assert.ok(accounts.every(a => Math.abs(a.totalEpsilon - 1) < 1e-12), '各账 ε=1（不互相叠加）');

  // (c) 账本上界：满员（PRIVACY_BUDGET_MAX_ACCOUNTS）后再需开新账 ⇒ 拒绝铸造
  //     （fail-closed —— 逐出旧账 = 洗预算，不可取）
  resetPrivacyBudgetRuntime();
  const one = new EvidenceLedger();
  for (let i = 0; i < 4; i++) one.record({ key: 'fed.fill', success: true, margin: 0.1, ts: i });
  for (let i = 0; i < PRIVACY_BUDGET_MAX_ACCOUNTS; i++) {
    // 每次铸造用独立主体#键（合法消耗 —— 每账 ε=1 ≤ 10）
    const ok = mintEvidenceDigest(one, { seed: i, subject: `fill-${i}`, now: () => 700 + i });
    if (ok === null && i < 5) assert.fail(`第 ${i} 次不应拒绝`);
  }
  assert.equal(privacyBudgetReport().length, PRIVACY_BUDGET_MAX_ACCOUNTS, `账本恰满 ${PRIVACY_BUDGET_MAX_ACCOUNTS} 账`);
  assert.equal(mintEvidenceDigest(one, { seed: 1, subject: 'overflow-subject', now: () => 999 }), null, '满员再开新账 ⇒ 拒绝（不逐出）');
  assert.equal(privacyBudgetReport().length, PRIVACY_BUDGET_MAX_ACCOUNTS, '拒绝不开账（账本规模冻结在上界）');
  // 已有账户（未耗尽）在满员账本上照常记账
  assert.ok(mintEvidenceDigest(one, { seed: 2, subject: 'fill-0', now: () => 1000 }) !== null, '既有账户继续组合记账（ε=2 ≤ 10）');
});

// ─── ΠΑΝ-72：检疫账对齐（票账与配额闸同键咬合） ───

test('ΠΑΝ-72: 签名路径毒指纹的折减在下一轮真实咬合配额；裸 endpoint 账不被签名路径开立', async () => {
  const EP = 'https://pan72.example/fed';
  const K = 'fed.pan72';
  const self = edClient();
  const peerP = edClient(); // 毒客户端（持钥 ⇒ 验签过、摘要灌毒）
  const peerH = edClient(); // 诚实客户端
  const acctP = federationFingerprintSourceId(EP, peerP.fingerprint);
  const acctH = federationFingerprintSourceId(EP, peerH.fingerprint);
  const honest = (t: number): EvidenceDigest => digestOf(K, uniformBins(50), 50, t);
  const poison = (t: number): EvidenceDigest => digestOf(K, uniformBins(1000), 1000, t);

  const round = async (resp: unknown[], nowT: number): Promise<void> => {
    const fake = (async () => ({ json: async () => ({ digests: resp }) })) as unknown as FederationFetch;
    const r = federationSync({ endpoint: EP, fetchImpl: fake, ledger: seedLedger(K, 10), robust: true, now: () => nowT, signingKey: self.material, maxRemoteShare: 0.5, dpKey: 'k-pan72' });
    await r.settled;
  };

  // 轮 1：毒 + 诚实 ⇒ 毒指纹 16 票 ⇒ 3 regressed（1/(1+3) = 0.25）
  await round([peerP.sign(poison(10)), peerH.sign(honest(11))], 100);
  assert.equal(federationTrustOf(acctP), 0.25, '毒指纹票折减 0.25（endpoint#指纹账）');
  // ΠΑΝ-72 核心：掺入配额查**参与合并的指纹账**最弱链 —— 裸 endpoint 账从未被
  // 签名路径开立（旧律查裸账：掺入侧 applied 立账毕业恒 1.0，票账的折减无闸消费）
  assert.equal(federationTrustReport().find(r => r.sourceId === EP), undefined, '裸 endpoint 账不被签名路径开立');

  // 轮 2：毒客户端本轮**收敛**（发诚实值 —— 本轮零新票），同批诚实源再同步 ⇒
  // 配额闸吃到毒指纹上一轮攒下的 0.25（blend = min(0.25, 0.35)）—— ΠΑΝ-72 的
  // 跨轮咬合隔离测量（若毒源继续发毒，先检疫后掺入的 wired 序会让本轮 16 票
  // 先落账（regressed 3→6、trust 1/7），咬得更快但测不准「上一轮的票」）
  const fake2 = (async () => ({ json: async () => ({ digests: [peerP.sign(honest(20)), peerH.sign(honest(21))] }) })) as unknown as FederationFetch;
  const ledger2 = seedLedger(K, 10);
  const r2 = federationSync({ endpoint: EP, fetchImpl: fake2, ledger: ledger2, robust: true, now: () => 200, signingKey: self.material, maxRemoteShare: 0.5, dpKey: 'k-pan72' });
  await r2.settled;
  assert.ok(r2.applied, '轮 2 掺入发生');
  assert.ok(Math.abs(r2.applied!.trust - 0.25) < 1e-12, `配额信任 = 指纹账最弱链 0.25（实测 ${r2.applied!.trust} —— ΠΑΝ-72 咬合）`);
  assert.equal(r2.applied!.applied, 1, 'quota = floor(5 × 0.25) = 1（毒指纹的牙齿长在配额闸上）');
  // 附加咬合面：毒源若继续发毒，同轮票先落账 ⇒ trust 折到 1/7（先检疫后掺入的
  // wired 序 —— 与未签名臂的既有纪律同律，同轮就咬）。只发毒源：诚实指纹不
  // 参与本次合并 ⇒ 不攒第 3 次干净轮（保持试用期 0.35 供轮 3 隔离测量）
  const fake2p = (async () => ({ json: async () => ({ digests: [peerP.sign(poison(22))] }) })) as unknown as FederationFetch;
  const r2p = federationSync({ endpoint: EP, fetchImpl: fake2p, ledger: seedLedger(K, 10), robust: true, now: () => 250, signingKey: self.material, maxRemoteShare: 0.5, dpKey: 'k-pan72' });
  await r2p.settled;
  assert.ok(Math.abs(federationTrustOf(acctP) - 1 / 7) < 1e-12, '继续发毒 ⇒ 同轮 16 票先落账（regressed 6 ⇒ trust 1/7 —— 更快咬合）');

  // 轮 3：撤销毒指纹后只剩诚实源 ⇒ blend 回试用期 0.35（无 0.25 弱链）。加第三
  // 诚实客户端：k=3 中位数下诚实源零票（仅 local+1 源的均值臂会把远端对本地
  // 小计数的偏差逐格计票 —— 中位数需要 ≥3 源才成立，与本测试的意图一致）
  const peerC = edClient();
  revokeFederationSource(acctP);
  const fake3 = (async () => ({ json: async () => ({ digests: [peerP.sign(poison(30)), peerH.sign(honest(31)), peerC.sign(honest(32))] }) })) as unknown as FederationFetch;
  const r3 = federationSync({ endpoint: EP, fetchImpl: fake3, ledger: seedLedger(K, 10), robust: true, now: () => 300, signingKey: self.material, maxRemoteShare: 0.5, dpKey: 'k-pan72' });
  await r3.settled;
  assert.equal(r3.robust!.revokedSources, 1, '毒指纹被撤销剔除（ΠΑΝ-74 联动）');
  assert.ok(Math.abs(r3.applied!.trust - 0.35) < 1e-12, '剔除毒源后 blend = 诚实指纹试用期 0.35');
  unrevokeFederationSource(acctP);
});

// ─── ΠΑΝ-73：回声环闭合 + 掺入上限按本地证据 ───

test('ΠΑΝ-73: 掺入记录不进下一轮摘要；掺入上限只数本地证据（掺入量不自增配额）', () => {
  const K = 'fed.pan73';
  const merged = { v: 1 as const, mintedAt: 50, epsilon: 1, keys: [{ key: K, n: 999, bins: uniformBins(100) }] };

  // (a) 回声环闭合：掺入 5 条后，本地铸造的摘要只消费本地 10 条（联邦 5 条被
  //     origin 过滤 —— 掺入的远端证据不再被重新铸成摘要重新上传）
  const ledger = seedLedger(K, 10);
  const rep = applyFederatedEvidence(ledger, merged, { maxRemoteShare: 0.5, trust: 1, now: () => 60 });
  assert.equal(rep.applied, 5, '首轮掺入 5 条');
  assert.equal(ledger.stats(K).n, 15, '账本 15 条（10 本地 + 5 联邦）');
  resetPrivacyBudgetRuntime();
  const d = mintEvidenceDigest(ledger, { seed: 3, now: () => 70 })!;
  const entry = d.keys.find(k => k.key === K)!;
  assert.ok(Math.abs(entry.n - 10) <= 8, `摘要 n ≈ 本地 10（实测 ${entry.n} —— 联邦 5 条不进摘要，回声环断）`);
  // 预算也只按本地证据主体记账：掺入不烧本地隐私预算
  const acc = privacyBudgetOf(`s:local|k:${K}`);
  assert.ok(acc && acc.releases.length === 1, '掺入动作零预算消耗（只 mint 记账）');

  // (b) 稀释封顶：第二轮掺入的上限仍按本地 10 条计（cap = floor(0.5×10) = 5），
  //     不按 stats 的 15 条（旧律 cap 随掺入量自增：本地纯度每轮 ×0.5）
  const rep2 = applyFederatedEvidence(ledger, merged, { maxRemoteShare: 0.5, trust: 1, now: () => 80 });
  assert.equal(rep2.applied, 5, `第二轮仍掺 5（cap 按本地 10 计 —— 实测 ${rep2.applied}）`);
  assert.equal(rep2.perKey[0].localN, 10, 'perKey.localN = 本地证据计数（不含联邦记录）');
  // 对照：纯本地账本（无 entries 端口的最小面）回落 stats().n —— 能力降级不改方向
  const minimal: { record(o: { key: string; success: boolean; margin?: number; ts: number }): void; stats(k: string): { n: number } } = {
    record: () => {},
    stats: () => ({ n: 10 }),
  };
  const rep3 = applyFederatedEvidence(minimal, merged, { maxRemoteShare: 0.5, trust: 1, now: () => 90 });
  assert.equal(rep3.applied, 5, '最小面（无 entries）回落 stats.n=10 ⇒ 同 cap');
});

// ─── ΠΑΝ-74：新鲜度 + 撤销 + 名册饱和 ───

test('ΠΑΝ-74: 过期/无锚远端件聚合前剔除（staleSources）；撤销表本地文件往返；名册饱和律', async () => {
  const EP = 'https://pan74.example/fed';
  const K = 'fed.pan74';
  const self = edClient();
  const peer = edClient();
  const acctPeer = federationFingerprintSourceId(EP, peer.fingerprint);
  const honest = (t: number): EvidenceDigest => digestOf(K, uniformBins(50), 50, t);

  // (a) 新鲜度：混合响应（1 鲜活 + 1 过期 + 1 无锚 + 1 远未来锚）⇒ 只有鲜活的入中位数
  //     （未来锚：now−t 为负会使 TTL 恒过 —— 远未来 mintedAt = 永不过期的重放件，
  //     超容差即拒，fail-closed）
  const NOW = 10_000_000;
  const fakeMix = (async () => ({
    json: async () => ({
      digests: [
        peer.sign(honest(NOW)), // 鲜活
        peer.sign(honest(NOW - FEDERATION_DIGEST_TTL_MS - 1)), // 过期（> 1h）
        peer.sign({ ...honest(Number.NaN) }), // 无时间锚（mintedAt 非法 ⇒ 同毫秒护栏前已被新鲜度闸剔除）
        peer.sign(honest(NOW + FEDERATION_DIGEST_TTL_MS * 10)), // 远未来锚（超 ±5min 容差）
      ],
    }),
  })) as unknown as FederationFetch;
  const r1 = federationSync({ endpoint: EP, fetchImpl: fakeMix, ledger: seedLedger(K, 10), robust: true, now: () => NOW, signingKey: self.material, dpKey: 'k-pan74' });
  await r1.settled;
  assert.equal(r1.robust!.staleSources, 3, '过期 + 无锚 + 未来锚 ⇒ 3 件聚合前剔除（计数在案）');
  assert.equal(r1.robust!.mergedFrom, 2, '本地 + 1 鲜活源 = 2 源');

  // (a') apply 侧新鲜度闸直测：过期件与未来件整份拒绝掺入（fail-closed ——
  // 未来的 now−t < 0 会使 TTL 检查恒过，容差闸是唯一的执法点）
  const mk = (t: number): { v: 1; mintedAt: number; epsilon: number; keys: Array<{ key: string; n: number; bins: number[][] }> } => ({
    v: 1, mintedAt: t, epsilon: 1, keys: [{ key: K, n: 50, bins: uniformBins(50) }],
  });
  assert.equal(applyFederatedEvidence(seedLedger(K, 10), mk(NOW - FEDERATION_DIGEST_TTL_MS - 1), { trust: 1, now: () => NOW }).ok, false, 'apply：过期摘要拒绝掺入');
  assert.equal(applyFederatedEvidence(seedLedger(K, 10), mk(NOW + FEDERATION_DIGEST_TTL_MS * 10), { trust: 1, now: () => NOW }).ok, false, 'apply：远未来锚拒绝掺入（负 age 不再绕过 TTL）');
  assert.equal(applyFederatedEvidence(seedLedger(K, 10), { ...mk(NOW), mintedAt: Number.NaN }, { trust: 1, now: () => NOW }).ok, false, 'apply：无时间锚拒绝掺入');
  assert.ok(applyFederatedEvidence(seedLedger(K, 10), mk(NOW), { trust: 1, now: () => NOW }).applied > 0, 'apply：鲜活摘要照常掺入（对照臂）');

  // (b) 撤销闸：验签过的源命中撤销表 ⇒ 剔除计数（连中位数都进不了）
  revokeFederationSource(acctPeer);
  const fakeRevoked = (async () => ({ json: async () => ({ digests: [peer.sign(honest(NOW + 10))] }) })) as unknown as FederationFetch;
  const r2 = federationSync({ endpoint: EP, fetchImpl: fakeRevoked, ledger: seedLedger(K, 10), robust: true, now: () => NOW + 20, signingKey: self.material, dpKey: 'k-pan74' });
  await r2.settled;
  assert.equal(r2.robust!.revokedSources, 1, '被撤销源剔除计数');
  assert.equal(r2.robust!.method, 'none', '全剔除 ⇒ 整轮不聚合（本地摘要不回环掺入自己 —— ΠΑΝ-73 回声律的撤销侧同律）');
  assert.equal(r2.robust!.mergedFrom, 0, '零源合并（单源直通不发生：本地件不经联邦管道回自家账本）');
  assert.equal(r2.applied, null, '零掺入（全剔除 ⇒ 不给任何账赚干净轮）');
  assert.deepEqual(federationRevocationList(), [acctPeer], '撤销表快照在案');

  // (c) 撤销表本地文件往返：落盘 → 跨进程归零 → 复载 ⇒ 撤销存活
  const dir = mkdtempSync(path.join(tmpdir(), 'pan74-rev-'));
  try {
    const file = path.join(dir, 'federation-revocations.json');
    const store = createFederationRevocationFileStore(file);
    assert.equal(armFederationRevocationList(store), true, '武装撤销表持久化');
    assert.equal(flushFederationRevocations().ok, true, '立即落盘');
    assert.ok(existsSync(file) && !existsSync(file + '.tmp'), '原子写无 tmp 残留');
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { v: number; revoked: string[] };
    assert.equal(doc.v, 1, '撤销档 v=1');
    assert.deepEqual(doc.revoked, [acctPeer], '撤销键落盘');
    resetFederationRuntime(); // 跨进程模拟（撤销表一并复位）
    assert.equal(isFederationSourceRevoked(acctPeer), false, '复位后内存表空');
    const loaded = loadFederationRevocations(store);
    assert.equal(loaded.restored, 1, '复载 1 条');
    assert.equal(isFederationSourceRevoked(acctPeer), true, '撤销跨进程存活');
    // 恢复通道 + 坏档防御
    assert.equal(unrevokeFederationSource(acctPeer), true, '误撤销可补救');
    assert.equal(isFederationSourceRevoked(acctPeer), false, '解除在案');
    assert.ok(restoreFederationTrust({ v: 1 }).restored === 0, '（无关面）信任档版本闸照常');
    const badLoad = loadFederationRevocations({ load: () => '{broken', save: () => ({ ok: true }) });
    assert.equal(badLoad.restored, 0, '坏 JSON ⇒ 整档拒绝');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetFederationRuntime();
  }

  // (d) 名册饱和律：已知客户端数封顶 KNOWN_CLIENT_ROSTER_SATURATION ⇒ maxRemotes
  //     不随名册增长（攻击者批量换钥撑大名册不再放松止血限额①）
  assert.equal(KNOWN_CLIENT_ROSTER_SATURATION, 32, '饱和常量 = 32（冻结）');
  assert.equal(federationMaxRemotes(1), 6, '1 已知 ⇒ 6（旧律基准）');
  assert.equal(federationMaxRemotes(4), 12, '4 已知 ⇒ 12');
  assert.equal(federationMaxRemotes(32), 68, '32 已知 ⇒ 68（饱和点）');
  assert.equal(federationMaxRemotes(33), 68, '33 已知 ⇒ 仍 68（饱和 —— 不再放松）');
  assert.equal(federationMaxRemotes(10_000), 68, '万名册 ⇒ 仍 68（换钥撑名册抬不动限额）');
  assert.equal(federationMaxRemotes(0), 4, '0 已知 ⇒ 4');
  assert.equal(federationMaxRemotes(Number.NaN), 4, '垃圾 ⇒ 0 口径');
});

// ─── ΠΑΝ-75：swarm 上行 sceneHash 加盐 ───

test('ΠΑΝ-75: 上行 driftEvents 的 sceneHash 经本地盐 HMAC —— 不裸出境、不可字典匹配、进程内稳定', () => {
  swarm.reset();
  swarm.configure('', 300_000, 500);
  const rawA = 'a'.repeat(64);
  const rawB = '0123456789abcdef'.repeat(4);
  swarm.observeDrift(rawA, 0.05, -0.03);
  swarm.observeDrift(rawB, 0.1, 0.2);

  // (a) 标签纯函数律：确定性（进程内稳定 —— 同场景同标签可聚合）、雪崩（异场景异标签）
  assert.equal(privateSceneTag(rawA), privateSceneTag(rawA), '同输入恒同输出（进程内稳定）');
  assert.notEqual(privateSceneTag(rawA), privateSceneTag(rawB), '异输入异输出（雪崩）');
  assert.match(privateSceneTag(rawA), /^[0-9a-f]{16}$/, '标签 = 16 hex');
  assert.equal(privateSceneTag(''), 'salted-void', '空输入 ⇒ 确定性占位（绝不裸回）');

  // (b) 上行不裸：packet 的 driftEvents 不含原 dHash；本地 dump 保持真值
  const packet = swarm.buildPacket(1, mulberry32(11));
  const flat = JSON.stringify(packet);
  assert.equal(packet.driftEvents.length, 2, '两条漂移事件');
  for (const ev of packet.driftEvents) {
    assert.notEqual(ev.sceneHash, rawA, '标签 ≠ 原场景指纹 A');
    assert.notEqual(ev.sceneHash, rawB, '标签 ≠ 原场景指纹 B');
    assert.equal(ev.sceneHash.length, 16, '标签为 HMAC 短形态（非 64 位 dHash）');
  }
  assert.ok(!flat.includes(rawA) && !flat.includes(rawB), 'packet 全文不含裸 dHash（不再裸出境）');
  const dump = swarm.dump();
  assert.ok(dump.drifts.some(d => d.sceneHash === rawA), '本地 drifts 保持真值（盐只划在上行面）');

  // (c) 不可字典匹配：无钥攻击者以任何常见变换（截断/无盐哈希）都无法从已知屏幕
  //     dHash 推出标签（HMAC 的键控性 —— 与联邦 DP 种子同方言）
  const knownScreenDict = [rawA, rawB, 'f'.repeat(64), 'deadbeef'.repeat(8)];
  const tagSet = new Set(packet.driftEvents.map(e => e.sceneHash));
  for (const known of knownScreenDict) {
    assert.ok(!tagSet.has(known), '原值不入标签集');
    assert.ok(!tagSet.has(known.slice(0, 16)), '截断不入标签集');
    assert.ok(!tagSet.has(createHmac('sha256', 'wrong-key').update(known).digest('hex').slice(0, 16)), '错钥 HMAC 推不出标签');
    assert.ok(!tagSet.has(createHash('sha256').update(known).digest('hex').slice(0, 16)), '无盐哈希推不出标签');
  }
  swarm.reset();
});
