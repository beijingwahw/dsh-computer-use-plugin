// test/epochMu2.aggregate.test.ts
// 纪元 Μ2（拜占庭鲁棒联邦聚合 —— Μ 的加固续笔）执法册 Μ2-1~Μ2-6：
//   Μ2-1 鲁棒律：5 源中 1 源灌毒（×100）⇒ 中位数聚合值 = 诚实源中位（毒被结构性
//        隔离）；朴素求和对照（毒直通 —— secure-aggregation 弱点在册）；异质诚实
//        值下中位数取真中位；检疫票集中在毒源（诚实源 0 票）；阈地板容噪侧。
//   Μ2-2 小源数诚实：2 源 = 均值 + 无鲁棒性注记；1 源直通（逐字段保真）；0 源
//        null；坏源（版本错配/形状坏/陷阱属性）按缺席处理并注记；逐 key 源数偏差。
//   Μ2-3 检疫有牙齿（端到端）：16 票 ⇒ floor(16/5)=3 次 regressed ⇒ 信任账
//        1/(1+3)=0.25 ⇒ 下次 apply 配额 5→1；不足 5 票的噪声容限不立脏账。
//        （ΑΩ-R6 后初见源另有试用期封顶 0.35 —— raw 低于封顶时封顶不是约束；
//         试用期执法册见 epochMu.federation.test.ts Μ-9。）
//   Μ2-4 贡献帽：单源洪泛格被封顶到 capShare×鲁棒值（先帽后并：Μ 旧求和路径
//        喂帽后源表，洪泛格 100400→600、占比 ≤1/3）；原输入不可变；单源不帽。
//   Μ2-5 集成与回归：federationSync robust:true 走鲁棒合并（假 fetch 回环喂毒源
//        +诚实源；先检疫后掺入 ⇒ 同轮配额折减；端点信任账 1/4）；robust 缺省
//        false = Μ 旧路径逐字节（digest 单件语义不变、digests 数组不被聚合、
//        结果形状无 robust 字段）；aggregate 核心永不抛（垃圾/陷阱属性全消毒）。
//   Μ2-6 参考聚合端：scripts/federation-server.mjs 环回起服（--port 0），POST
//        /aggregate 的 digest/quarantined/method 与 TS 核心 robustMergeDigests
//        **逐字段等价**（双实现口径的漂移把守）；/health、413/400/405/404 协议
//        执法；环境不支持子进程/环回监听 ⇒ 诚实 skip。
//   Μ2-7 聚合端共享密钥认证（W6R-A5）：DSH_FEDERATION_TOKEN 设置 ⇒ /aggregate
//        强制 HMAC-SHA256 请求签名（时间戳 ±5min 防重放）—— 无签名/坏签名/
//        过期时间戳/篡改体（签名对原文、发送体被中间人替换）全部 401 且环不动；
//        客户端 federationSync（authToken 注入 + 真全局 fetch 环回往返）签名
//        被收 ⇒ 鲁棒臂吃 digests 数组照常掺入（认证是旁路：零配置语义不变）；
//        open 模式 /health 明示 UNAUTHENTICATED（诚实声明面）。
//   Μ2-9 逐源签名（ΝΩ-19）：Ed25519 客户端签名链路 —— 密钥/指纹解析（seed 与
//        pkcs8 双形态同指纹）、上行附 {pubkey,sig}、无密钥上行逐字节旧路径；
//        假源验签剔除（中位数不被污染）；指纹粒度试用期独立（毒指纹折减/诚实
//        指纹毕业/端点账不吃指纹票）；无签名旧格式诚实降级全剔除；同毫秒批量
//        剔除；止血限额（已知客户端×2+4 拒超额）；签后改体/剥签名拒收；
//        旧档 endpoint 键与 endpoint#指纹键同档兼容。
//   Μ2-10 参考聚合端签名中继（ΝΩ-19）：带签摘要原样入环回传（pubkey/sig 域
//        不被剥）；回传件验签成立、改体件拒绝；客户端真 fetch 环回端到端
//        （自己的带签摘要入环 ⇒ 验签存活 ⇒ 掺入）。环境不支持 ⇒ 诚实 skip。
// 全程离线（fetch 全假件/仅环回 127.0.0.1）、确定性（钉死字面量摘要 / 注入时钟）、
// 生产单例 try/finally 复位；Μ 既有测试（epochMu.federation）另行回归保绿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHmac, createHash, generateKeyPairSync, sign as ed25519SignTest, type KeyObject } from 'node:crypto';

import { EvidenceLedger } from '../src/kernel/registry.ts';
import {
  mergeDigests,
  applyFederatedEvidence,
  federationSync,
  recordFederationTrust,
  federationTrustOf,
  federationTrustReport,
  lastFederationSync,
  resetFederationRuntime,
  robustMergeDigests,
  applyQuarantineToTrust,
  contributionCap,
  QUARANTINE_VOTES_PER_REGRESSED,
  DEFAULT_CONTRIBUTION_CAP_SHARE,
  federationAuthHeaders,
  FEDERATION_AUTH_TIMESTAMP_HEADER,
  FEDERATION_AUTH_SIGNATURE_HEADER,
  // ΝΩ-19（联邦逐源签名）：客户端签名链路 + 指纹粒度信任账
  FEDERATION_SIGNING_KEY_ENV,
  federationSigningIdentity,
  signEvidenceDigest,
  verifyEvidenceDigestSignature,
  canonicalFederationJson,
  federationSigningKeyHint,
  federationFingerprintSourceId,
  serializeFederationTrust,
  restoreFederationTrust,
  type FederationFetch,
  type EvidenceDigest,
} from '../src/federation/index.ts';
// 核心直连（与再分发面同物 —— 纯函数核心可独立于主模块使用的旁证）
import { robustMergeDigests as robustMergeDigestsCore } from '../src/federation/aggregate.ts';

// ─── 假件工坊（钉死字面量摘要 —— 零随机、确定性） ───

/** 8×[v,v] 的均匀坨（诚实同侪的形状） */
function uniformBins(v: number): number[][] {
  return Array.from({ length: 8 }, () => [v, v]);
}

/** 手铸单 key 摘要（跳过 DP 噪声 —— 中位数/检疫的数学面要钉死的输入） */
function digestOf(key: string, bins: number[][], n: number, mintedAt: number): EvidenceDigest {
  return { v: 1, mintedAt, epsilon: 1, keys: [{ key, n, bins }] };
}

/** 本地账本铸 n 条带 margin 的记录（federationSync 掺入的靶账本） */
function seedLedger(key: string, n: number): EvidenceLedger {
  const ledger = new EvidenceLedger();
  for (let i = 0; i < n; i++) ledger.record({ key, success: i % 2 === 0, margin: 0.1 * i - 0.5, ts: i });
  return ledger;
}

// ─── Μ2-1：鲁棒律（中位数隔离 + 检疫票集中） ───

test('Μ2-1: 5 源 1 毒 ⇒ 中位数聚合=诚实中位、毒被隔离、检疫票集中毒源；朴素求和对照毒直通', () => {
  const K = 'fed.rob';

  // (a) 4 诚实（16 格全 10）+ 1 毒（格 (3,0) ×100）
  const honest = (): EvidenceDigest => digestOf(K, uniformBins(10), 100, 1000);
  const poisonBins = uniformBins(10);
  poisonBins[3][0] = 1000; // ×100 灌毒
  const sources = [honest(), honest(), honest(), honest(), digestOf(K, poisonBins, 100, 1000)];
  const ids = ['h1', 'h2', 'h3', 'h4', 'poison'];

  const rr = robustMergeDigests(sources, { sourceIds: ids });
  assert.equal(rr.method, 'median', '5 源 ⇒ 中位数');
  assert.equal(rr.merged!.mergedFrom, 5, 'mergedFrom = 有效源数');
  assert.equal(rr.merged!.skipped, 0, '无坏格');
  assert.equal(rr.merged!.mintedAt, 1000, 'mintedAt 取各源最大');
  assert.equal(rr.merged!.epsilon, 1, 'epsilon 取各源最小（保守账）');
  const m1 = rr.merged!.keys[0];
  assert.equal(m1.key, K, 'key 在册');
  assert.equal(m1.n, 100, 'n 亦取鲁棒值（中位 100 —— 真值注记不被洪泛拉爆）');
  assert.equal(m1.bins[3][0], 10, '毒格被结构性隔离：中位数 = 诚实值 10（非均值 208）');
  for (let b = 0; b < 8; b++) {
    for (let c = 0; c < 2; c++) assert.equal(m1.bins[b][c], 10, `格(${b},${c}) = 诚实中位 10`);
  }
  assert.deepEqual(rr.quarantined, { poison: 1 }, '检疫票集中在毒源（1 格超阈 ⇒ 恰 1 票；诚实源 0 票）');
  assert.deepEqual(rr.excluded, [], '无缺席源');
  assert.deepEqual(robustMergeDigestsCore(sources, { sourceIds: ids }).merged, rr.merged, '核心直连与再分发面同物');

  // (b) 朴素求和对照：mergeDigests（Μ 旧律）同输入 ⇒ 毒格直通（弱点在册）
  const naive = mergeDigests(sources)!;
  assert.equal(naive.keys[0].bins[3][0], 1040, '求和路径毒直通（10×4+1000）—— Μ2 的立意起点');

  // (c) 异质诚实值：[4,5,6,7,1200] ⇒ 真中位 6；毒源 1 票、诚实源 0 票（|4−6|=2 ≤ 地板 3）
  const mk = (v0: number): EvidenceDigest => {
    const bins = uniformBins(10);
    bins[0][0] = v0;
    return digestOf(K, bins, 100, 1000);
  };
  const rr2 = robustMergeDigests([mk(4), mk(5), mk(6), mk(7), mk(1200)], { sourceIds: ['a', 'b', 'c', 'd', 'p'] });
  assert.equal(rr2.merged!.keys[0].bins[0][0], 6, '异质诚实值下取真中位 6（毒 1200 不入中位）');
  assert.deepEqual(rr2.quarantined, { p: 1 }, '检疫票仍只在毒源（诚实偏差 ≤ 阈地板 3）');

  // (d) 阈地板的容噪侧：[48,50,50,52,54] ⇒ 中位 50；偏差 4 计票、偏差 2 容噪
  //     （16 格鲁棒值同匀 ⇒ IQR=0 ⇒ 阈 = 地板 3 —— DP 噪声量级的抖动不立票）
  const near = (v0: number): EvidenceDigest => {
    const bins = uniformBins(50);
    bins[0][0] = v0;
    return digestOf(K, bins, 100, 1000);
  };
  const rr3 = robustMergeDigests([near(48), near(50), near(50), near(52), near(54)], { sourceIds: ['n1', 'n2', 'n3', 'n4', 'n5'] });
  assert.equal(rr3.merged!.keys[0].bins[0][0], 50, '中位 50');
  assert.equal(rr3.quarantined['n5'], 1, '|54−50|=4 > 3 ⇒ 1 票');
  assert.equal(rr3.quarantined['n1'], undefined, '|48−50|=2 ≤ 3 ⇒ 容噪不计票');
  assert.equal(rr3.quarantined['n4'], undefined, '|52−50|=2 ≤ 3 ⇒ 容噪不计票');
});

// ─── Μ2-2：小源数诚实律 ───

test('Μ2-2: 2 源=均值+无鲁棒注记；1 源直通；0 源 null；坏源缺席处理；逐 key 源数偏差', () => {
  const K = 'fed.small';

  // (a) 2 源同值：均值 = 原值、零检疫票、n 取均值
  const r1 = robustMergeDigests([digestOf(K, uniformBins(10), 10, 1), digestOf(K, uniformBins(10), 20, 2)]);
  assert.equal(r1.method, 'mean', '2 源 ⇒ 均值');
  assert.equal(r1.merged!.mergedFrom, 2, 'mergedFrom=2');
  assert.equal(r1.merged!.keys[0].bins[0][0], 10, '同值 ⇒ 均值 = 原值');
  assert.equal(r1.merged!.keys[0].n, 15, 'n = round((10+20)/2) = 15');
  assert.deepEqual(r1.quarantined, {}, '同值零偏差 ⇒ 零票');
  assert.ok(r1.notes.some(n => n.includes('无鲁棒')), `无鲁棒性注记在场（${r1.notes.join('; ')}）`);

  // (b) 2 源异值：均值 = 15；两侧各 16 票（均值臂无鲁棒的诚实代价 —— 折算律容噪）
  const r2 = robustMergeDigests([digestOf(K, uniformBins(10), 10, 1), digestOf(K, uniformBins(20), 20, 2)]);
  assert.equal(r2.merged!.keys[0].bins[0][0], 15, '异值 ⇒ round((10+20)/2) = 15');
  assert.equal(r2.quarantined['0'], 16, '|10−15|=5 > 阈地板 3 ⇒ 16 格各 1 票');
  assert.equal(r2.quarantined['1'], 16, '对侧同律（|20−15|=5）');

  // (c) 1 源直通：逐字段保真
  const single = digestOf(K, uniformBins(7).map(c => [...c]), 33, 5);
  const r3 = robustMergeDigests([single]);
  assert.equal(r3.method, 'single', '1 源 ⇒ 直通');
  assert.equal(r3.merged!.mergedFrom, 1, 'mergedFrom=1');
  assert.deepEqual(r3.merged!.keys[0].bins, single.keys[0].bins, '坨值逐格保真');
  assert.equal(r3.merged!.keys[0].n, 33, 'n 保真');
  assert.deepEqual(r3.quarantined, {}, '无检疫（无比较面）');
  assert.ok(r3.notes.some(n => n.includes('直通')), '直通注记在场');

  // (d) 0 源 / 非数组：诚实空手
  for (const empty of [[], 'junk', null, undefined, 42] as unknown[]) {
    const r = robustMergeDigests(empty);
    assert.equal(r.merged, null, '0 源 ⇒ merged=null');
    assert.equal(r.method, 'none', 'method=none');
    assert.ok(r.notes.length > 0, '注记在场');
  }

  // (e) 坏源缺席：版本错配/形状坏/陷阱属性 ⇒ excluded + 好源照常合并
  const good = digestOf(K, uniformBins(10), 10, 1);
  const trap: unknown = {
    get v(): number {
      throw new Error('boom');
    },
    keys: [],
  };
  const r5 = robustMergeDigests([good, { v: 2, mintedAt: 1, epsilon: 1, keys: [] }, null, 42, trap]);
  assert.deepEqual(r5.excluded, [1, 2, 3, 4], '坏源序号全注记（含陷阱属性）');
  assert.equal(r5.method, 'single', '仅剩 1 有效源 ⇒ 直通');
  assert.deepEqual(r5.merged!.keys[0].bins, uniformBins(10), '好源保真 —— 一个坏源只能缺席，不能否决合并');

  // (f) 逐 key 源数偏差注记：某 key 仅 1 源在场 ⇒ 该 key 直通 + notes 在场
  const second = digestOf(K, uniformBins(10), 10, 1);
  second.keys.push(digestOf('fed.onlyB', uniformBins(3), 3, 1).keys[0]);
  const r6 = robustMergeDigests([digestOf(K, uniformBins(10), 10, 1), second]);
  assert.equal(r6.method, 'mean', '全局 2 源 ⇒ mean');
  assert.equal(r6.merged!.keys.length, 2, '两 key 皆入合并');
  assert.ok(r6.notes.some(n => n.includes('fed.onlyB') && n.includes('直通')), `逐 key 偏差注记（${r6.notes.join('; ')}）`);
});

// ─── Μ2-3：检疫有牙齿（端到端） ───

test('Μ2-3: 16 票 ⇒ 3 次 regressed ⇒ 信任 1/4 ⇒ 下次 apply 配额 5→1；<5 票不立脏账；垃圾不抛', () => {
  resetFederationRuntime();
  try {
    const K = 'fed.teeth';
    // 4 诚实（16 格全 10）+ host-c 全格灌毒 ×100 ⇒ 毒源恰 16 票
    const honest = (): EvidenceDigest => digestOf(K, uniformBins(10), 100, 1000);
    const sources = [honest(), honest(), digestOf(K, uniformBins(1000), 1000, 1000), honest(), honest()];
    const rr = robustMergeDigests(sources, { sourceIds: ['host-a', 'host-b', 'host-c', 'host-d', 'host-e'] });
    assert.equal(rr.quarantined['host-c'], 16, '毒源 16 格全超阈 ⇒ 16 票');
    for (const h of ['host-a', 'host-b', 'host-d', 'host-e']) assert.equal(rr.quarantined[h], undefined, `${h} 零票`);
    for (let b = 0; b < 8; b++) {
      for (let c = 0; c < 2; c++) assert.equal(rr.merged!.keys[0].bins[b][c], 10, '合并面毒被隔离（全格诚实中位）');
    }

    // (a) 折算：16 票 / 5 = 3 次 regressed（每 5 票 1 次）
    assert.equal(QUARANTINE_VOTES_PER_REGRESSED, 5, '折算律常量 = 每 5 票 1 次');
    const report = applyQuarantineToTrust(rr.quarantined, recordFederationTrust);
    assert.deepEqual(report, [{ sourceId: 'host-c', votes: 16, regressed: 3 }], '折算报告：16 票 ⇒ 3 次');
    assert.equal(federationTrustOf('host-c'), 1 / (1 + 3), '信任账 1/(1+3) = 0.25');
    assert.ok(Math.abs(federationTrustOf('host-a') - 0.35) < 1e-12, '无票源不受牵连（初见 ⇒ 试用期封顶 0.35，非检疫所致 —— ΑΩ-R6）');

    // (b) 不足 5 票的噪声容限：不立脏账
    assert.deepEqual(applyQuarantineToTrust({ 'host-d': 4 }, recordFederationTrust), [], '4 票 < 5 ⇒ 零事件');
    assert.ok(Math.abs(federationTrustOf('host-d') - 0.35) < 1e-12, '噪声不立脏账（停在试用期封顶 0.35 —— 非票折减）');

    // (c) 端到端：毒被隔离后的合并面（诚实分布）经 host-c 掺入 —— 信任 0.25 折减配额 5→1
    const ledger = seedLedger(K, 10); // 本地 n=10
    const applied = applyFederatedEvidence(ledger, rr.merged, { maxRemoteShare: 0.5, sourceId: 'host-c', now: () => 999 });
    assert.equal(applied.trust, 0.25, '掺入走信任账 0.25');
    assert.equal(applied.applied, 1, 'quota = floor(floor(0.5×10) × 0.25) = 1 —— 检疫的牙齿');
    assert.equal(ledger.stats(K).n, 11, '账本 10 → 11');

    // (d) 对照：无检疫记录的诚实源同摘要 ⇒ 初见试用期封顶 0.35（ΑΩ-R6 —— 首掺不再免费）
    const ledger2 = seedLedger(K, 10);
    const applied2 = applyFederatedEvidence(ledger2, rr.merged, { maxRemoteShare: 0.5, sourceId: 'host-a', now: () => 999 });
    assert.equal(applied2.applied, 1, '初见源 quota = floor(5 × 0.35) = 1');
    assert.ok(Math.abs(applied2.trust - 0.35) < 1e-12, '初见试用期封顶 0.35（3 次干净合并后解除 —— 见 Μ-9）');

    // (e) 信任账报告可见折算后的账目
    const rec = federationTrustReport().find(r => r.sourceId === 'host-c')!;
    assert.ok(rec, '报告含 host-c');
    assert.equal(rec.regressed, 3, 'regressed = 3');
    assert.equal(rec.applied, 1, 'applied 累账 = 1');
    assert.equal(rec.trust, 0.25, '报告 trust = 0.25');

    // (f) 垃圾入账不抛：非法 quarantined / 非函数记账器 ⇒ 空报告
    assert.deepEqual(applyQuarantineToTrust(null, recordFederationTrust), [], 'null ⇒ []');
    assert.deepEqual(applyQuarantineToTrust(undefined, recordFederationTrust), [], 'undefined ⇒ []');
    assert.deepEqual(
      applyQuarantineToTrust({ x: Number.NaN, y: -5, z: 'junk' } as unknown as Record<string, number>, recordFederationTrust),
      [],
      'NaN/负/非数票 ⇒ 零事件',
    );
    assert.deepEqual(applyQuarantineToTrust({ good: 10 }, null), [], '记账器缺席 ⇒ []');
    assert.deepEqual(applyQuarantineToTrust({ boom: 10 }, (() => { throw new Error('boom'); }) as () => void), [], '单源记账故障 ⇒ 跳过不抛');
  } finally {
    resetFederationRuntime();
  }
});

// ─── Μ2-4：贡献份额帽 ───

test('Μ2-4: 洪泛格封顶 capShare×鲁棒值；先帽后并防泛；单源不帽；输入不可变；坏源缺席', () => {
  const K = 'fed.cap';
  assert.equal(DEFAULT_CONTRIBUTION_CAP_SHARE, 2, '缺省帽 = 2×鲁棒值');

  // 4 诚实（格 100）+ 洪泛源（格 (2,1)=100000，其余 100）
  const honest = (): EvidenceDigest => digestOf(K, uniformBins(100), 100, 1);
  const floodBins = uniformBins(100);
  floodBins[2][1] = 100_000;
  const flood = digestOf(K, floodBins, 100, 1);
  const five = [honest(), honest(), honest(), honest(), flood];

  const cap = contributionCap(five, 2);
  assert.equal(cap.capped, 1, '恰 1 格被封顶');
  assert.deepEqual(cap.excluded, [], '无缺席源');
  const floodOut = cap.digests[4].keys[0].bins;
  assert.equal(floodOut[2][1], 200, '洪泛格封顶到 floor(2 × 鲁棒值 100) = 200');
  assert.equal(floodOut[0][0], 100, '洪泛源的诚实格保真（100 ≤ 帽）');
  for (const h of cap.digests.slice(0, 4)) {
    assert.deepEqual(h.keys[0].bins, uniformBins(100), '诚实源逐格保真 —— 坐在共识上的源永不被削');
  }

  // 先帽后并：Μ 旧求和路径吃帽后源表 ⇒ 洪泛格 100400 → 600（占比 99.9% → 1/3）
  const mergedCapped = mergeDigests(cap.digests)!;
  assert.equal(mergedCapped.keys[0].bins[2][1], 600, '帽后求和 = 4×100 + 200 = 600');
  const mergedRaw = mergeDigests(five)!;
  assert.equal(mergedRaw.keys[0].bins[2][1], 100_400, '不帽的对照 = 100400（洪泛直通）');
  assert.ok(floodOut[2][1] / mergedCapped.keys[0].bins[2][1] <= 1 / 3 + 1e-9, '洪泛源占比 ≤ 1/3');

  // 原输入不可变（纯函数纪律）
  assert.equal(flood.keys[0].bins[2][1], 100_000, '原摘要未被改动（防御副本）');

  // 缺省与消毒：undefined / NaN / <1 ⇒ 缺省 2 同结果（<1 会削平诚实源 —— 抬回缺省）
  assert.equal(contributionCap(five).capped, 1, '缺省 capShare=2');
  assert.equal(contributionCap(five, Number.NaN).capped, 1, 'NaN ⇒ 缺省');
  assert.equal(contributionCap(five, 0.5).capped, 1, '<1 ⇒ 抬回缺省 2');

  // 单源永不封顶（鲁棒值 = 自值 ⇒ 帽 = 2v ≥ v）
  const solo = contributionCap([flood], 2);
  assert.equal(solo.capped, 0, '单源零封顶');
  assert.equal(solo.digests[0].keys[0].bins[2][1], 100_000, '单源洪泛格保真（无共识基准 ⇒ 无帽）');

  // 坏源缺席 + 空输入/垃圾输入不抛
  const withBad = contributionCap([flood, { v: 2, mintedAt: 1, epsilon: 1, keys: [] }, null], 2);
  assert.deepEqual(withBad.excluded, [1, 2], '坏源序号注记');
  assert.equal(withBad.digests.length, 1, '输出只含有效源');
  const empty = contributionCap([]);
  assert.equal(empty.digests.length, 0, '空数组 ⇒ 空源表');
  assert.equal(empty.capped, 0, '空数组 ⇒ 零封顶');
  assert.equal(contributionCap('junk' as unknown).digests.length, 0, '非数组 ⇒ 空结果');
});

// ─── Μ2-5：集成（federationSync robust 臂）与 Μ 旧路径回归 ───

test('Μ2-5: robust:true 走鲁棒合并+先检疫后掺入；缺省 false = Μ 旧路径逐字节；核心永不抛', async () => {
  resetFederationRuntime();
  try {
    const EP = 'https://agg.example/fed';

    // (a) robust:true —— 假 fetch 回环喂毒源+诚实源（3 远端 + 本地 = 4 源 ⇒ 偶中位）
    const K = 'fed.rob';
    const target = seedLedger(K, 10); // 本地真值格计数 0-2（与远端共识 50 天然异位 —— 本地是诚实的少数派）
    const poisonRemote = digestOf(K, uniformBins(1000), 1000, 10);
    const honestRemote = (): EvidenceDigest => digestOf(K, uniformBins(50), 50, 20);
    const captured: { url: string; method?: string; body?: string } = { url: '' };
    const fake = (async (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => {
      captured.url = url;
      captured.method = init.method;
      captured.body = init.body;
      return { json: async () => ({ digests: [poisonRemote, honestRemote(), honestRemote()] }) };
    }) as unknown as FederationFetch;
    const res = federationSync({ endpoint: EP, fetchImpl: fake, ledger: target, maxRemoteShare: 0.5, robust: true, now: () => 42 });
    assert.equal(res.network, 'fired', '网络臂已发');
    await res.settled;
    assert.equal(captured.url, EP, 'POST 目标 = endpoint');
    assert.equal(captured.method, 'POST', '方法 POST');
    assert.equal(captured.body, JSON.stringify(res.digest), '上行载荷 = 本地摘要（摘要外零信息 —— robust 模式不变）');
    assert.equal(res.robust!.method, 'median', '4 源 ⇒ 中位数（偶数取中间均值）');
    assert.equal(res.robust!.mergedFrom, 4, 'mergedFrom = 本地 + 3 远端');
    assert.equal(res.robust!.quarantined['remote-0'], 16, '毒远端 16 票');
    assert.equal(res.robust!.quarantined['remote-1'], undefined, '诚实远端零票');
    assert.equal(res.robust!.quarantined['local'], 16, '本地偏离共识（真值 0-2 vs 50）⇒ 注记在案（不喂端点账）');
    assert.deepEqual(res.robust!.excluded, [], '无缺席源');
    assert.equal(res.applied!.perKey[0].cap, 5, 'cap = floor(0.5×10)');
    assert.equal(res.applied!.perKey[0].quota, 1, 'quota = floor(5 × 0.25)');
    assert.equal(federationTrustOf(EP), 0.25, '远端 16 票折算 3 次 regressed 记到端点账 ⇒ trust 1/4');
    assert.equal(res.applied!.trust, 0.25, '先检疫后掺入：同轮即按 0.25 折减');
    assert.equal(res.applied!.applied, 1, '掺入恰 1 条');
    assert.equal(target.stats(K).n, 11, '账本 10 → 11');
    assert.equal(lastFederationSync()!.applied, 1, '上次同步记忆 applied=1');
    // 毒隔离的端到端证据：掺入记录的 margin 落坨覆盖区间（ΝΩ-20：合并面是均匀 50
    // 的鲁棒摘要 ⇒ quota 1 落在最大余数法首格 bin0/success ⇒ margin ∈ [-1,-0.75]
    // 坨宽抖动、success、ts 落合并摘要 mintedAt=42 邻域 ±5 分钟）
    const tail = target.entries(K).slice(-1)[0];
    assert.equal(tail.success, true, '成败由坨坐标反演（success 列）');
    const tailM = tail.margin ?? Number.NaN;
    assert.ok(Number.isFinite(tailM) && tailM >= -1 - 1e-9 && tailM <= -0.75 + 1e-9, `margin 落 bin0 覆盖区间 [-1,-0.75]（ΝΩ-20 坨宽抖动，实测 ${tailM}）`);
    assert.ok(tail.ts >= 42 - 5 * 60_000 && tail.ts <= 42 + 5 * 60_000, `ts 落源 mintedAt=42 邻域（ΝΩ-20 散布，实测 ${tail.ts}）`);

    // (b) robust 缺省 false = Μ 旧路径逐字节：digest 单件语义 / 结果无 robust 字段
    resetFederationRuntime();
    const EP2 = 'https://legacy.example/fed';
    const K2 = 'fed.legacy';
    const target2 = seedLedger(K2, 10);
    const legacyDigest = digestOf(K2, uniformBins(50), 500, 5);
    const fakeLegacy = (async () => ({ json: async () => ({ digest: legacyDigest }) })) as unknown as FederationFetch;
    const res2 = federationSync({ endpoint: EP2, fetchImpl: fakeLegacy, ledger: target2, maxRemoteShare: 0.5, now: () => 43 });
    await res2.settled;
    assert.equal(res2.applied!.applied, 1, 'legacy：新端点试用期 ⇒ floor(5 × 0.35) = 1（ΑΩ-R6 对两臂同律）');
    assert.equal(target2.stats(K2).n, 11, 'legacy：账本 10 → 11');
    assert.ok(Math.abs(federationTrustOf(EP2) - 0.35) < 1e-12, 'legacy：端点 applied 立账、试用期封顶 0.35');
    assert.equal(res2.robust, undefined, 'legacy 结果形状无 robust 字段（Μ 旧行为逐字节）');

    // (c) legacy 臂不聚合 digests 数组（多源响应在旧路径 = 不可用载荷）
    const target3 = seedLedger(K2, 10);
    const fakeMulti = (async () => ({ json: async () => ({ digests: [legacyDigest] }) })) as unknown as FederationFetch;
    const res3 = federationSync({ endpoint: EP2, fetchImpl: fakeMulti, ledger: target3, now: () => 44 });
    await res3.settled;
    assert.equal(res3.applied, null, 'legacy 不认多源载荷 ⇒ 未掺入');
    assert.equal(target3.stats(K2).n, 10, '账本零污染');
    assert.ok(lastFederationSync()!.note?.includes('响应不含可用的合并摘要'), `legacy 注记（${lastFederationSync()!.note}）`);

    // (d) robust:true 响应无多源 ⇒ 只上传未掺入（不炸）
    const fakeGarbage = (async () => ({ json: async () => ({ hello: 1 }) })) as unknown as FederationFetch;
    const res4 = federationSync({ endpoint: EP, fetchImpl: fakeGarbage, ledger: seedLedger(K, 10), robust: true, now: () => 45 });
    await res4.settled;
    assert.equal(res4.ok, true, '本地铸造不受响应影响');
    assert.equal(res4.applied, null, '无多源 ⇒ 未掺入');
    assert.ok(lastFederationSync()!.note?.includes('多源'), `robust 注记（${lastFederationSync()!.note}）`);

    // (e) aggregate 核心永不抛：垃圾全家桶（null/标量/陷阱属性/深畸形）喂三个入口
    const junk: unknown[] = [
      null, undefined, 42, 'x', true, {}, [[]],
      [{ v: 1 }], [{ v: 1, keys: 'no' }],
      [{ v: 1, mintedAt: 1, epsilon: 1, keys: [{ key: 'k', n: Number.NaN, bins: [[Number.NaN, 'x'], null] }] }],
      [{ get v(): number { throw new Error('boom'); }, keys: [] }],
      [Promise.resolve(1)],
    ];
    for (const j of junk) {
      assert.doesNotThrow(() => robustMergeDigests(j), '鲁棒合并不抛');
      assert.doesNotThrow(() => contributionCap(j, 2), '份额帽不抛');
      assert.doesNotThrow(() => applyQuarantineToTrust(j as Record<string, number>, recordFederationTrust), '折算不抛');
      const r = robustMergeDigests(j);
      assert.ok(r !== null && typeof r === 'object', '结果恒为结构化对象');
      assert.ok(r.merged === null || (r.merged.v === 1 && Array.isArray(r.merged.keys)), 'merged 要么 null 要么 v=1 合法形状');
      const c = contributionCap(j, 2);
      assert.ok(Array.isArray(c.digests), '帽输出恒为数组');
    }
  } finally {
    resetFederationRuntime();
  }
});

// ─── Μ2-6：参考聚合端（scripts/federation-server.mjs）── 双实现口径等价性 ───

/** 起参考聚合端（--port 0 ⇒ 随机环回口；env 可注入（W6R-A5 认证测试的 token 面）；8s 监听 + 5s 就绪上界；失败抛错供调用方 skip） */
async function startReferenceServer(
  env: Record<string, string> = {},
): Promise<{ port: number; child: ChildProcess; stop: () => Promise<void> }> {
  const script = fileURLToPath(new URL('../scripts/federation-server.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
  });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    let settledFlag = false;
    const done = (v: number | null): void => {
      if (settledFlag) return;
      settledFlag = true;
      clearTimeout(timer);
      if (v === null) reject(new Error('参考端未在 8s 内报出监听口'));
      else resolve(v);
    };
    const timer = setTimeout(() => done(null), 8_000);
    child.stdout!.on('data', (d: Buffer) => {
      buf += String(d);
      if (/"event":"listening"/.test(buf)) {
        const m = buf.match(/"port":(\d+)/);
        if (m) done(Number(m[1]));
      }
    });
    child.on('error', () => done(null));
    child.on('exit', () => done(null));
  });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
      if (r.ok) break;
    } catch {
      /* 未就绪：继续轮询 */
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('参考端 /health 5s 未就绪');
    }
    await new Promise(r => setTimeout(r, 100));
  }
  child.stdout!.resume(); // 排空（防管道反压挂住测试进程）
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    const exited = new Promise<void>(resolve => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    child.kill();
    await exited;
  };
  return { port, child, stop };
}

test('Μ2-6: 参考聚合端与 TS 核心逐字段等价；协议执法（health/413/400/405/404）；环境不支持 ⇒ 诚实 skip', async t => {
  let srv: Awaited<ReturnType<typeof startReferenceServer>>;
  try {
    srv = await startReferenceServer();
  } catch (e) {
    return t.skip(`环境不支持子进程/环回监听：参考端测试诚实跳过（${(e as Error).message}）`);
  }
  const base = `http://127.0.0.1:${srv.port}`;
  const post = (body: string) =>
    fetch(`${base}/aggregate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(8_000) });
  try {
    // (a) /health：存活 + 纪元 + 缓冲水位
    const h = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(h.status, 200, 'health 200');
    const hj = (await h.json()) as { ok: boolean; epoch: string; buffered: number };
    assert.equal(hj.ok, true, 'health ok');
    assert.equal(hj.epoch, 'Mu2', 'health 报纪元');
    assert.equal(hj.buffered, 0, '初起缓冲空');

    // (b) POST 5 源（4 诚实 + 毒）⇒ 与 TS 核心逐字段等价（双实现漂移把守）
    const K = 'fed.srv';
    const mkRemote = (v: number, n: number, mintedAt: number): EvidenceDigest => digestOf(K, uniformBins(v), n, mintedAt);
    const five = [mkRemote(1000, 1000, 10), mkRemote(10, 100, 20), mkRemote(10, 100, 30), mkRemote(10, 100, 40), mkRemote(10, 100, 50)];
    const r1 = await post(JSON.stringify(five));
    assert.equal(r1.status, 200, 'aggregate 200');
    const j1 = (await r1.json()) as {
      ok: boolean;
      digest: { keys: Array<{ bins: number[][] }> } | null;
      digests: unknown;
      quarantined: Record<string, number>;
      method: string;
      sources: number;
      rejected: number;
    };
    assert.equal(j1.ok, true, 'ok');
    const ts1 = robustMergeDigests(five);
    assert.deepStrictEqual(j1.digest, ts1.merged, 'JS 移植与 TS 核心的合并摘要逐字段一致（双实现口径）');
    assert.deepStrictEqual(j1.quarantined, ts1.quarantined, '检疫票一致');
    assert.equal(j1.method, ts1.method, '方法标签一致');
    assert.equal(j1.sources, 5, '环内 5 源');
    assert.equal(j1.rejected, 0, '零坏件');
    assert.deepStrictEqual(j1.digests, five, '响应回带原始摘要数组（供 robust 客户端本地再聚合）');
    assert.equal(j1.digest!.keys[0].bins[0][0], 10, '毒被隔离（中位 = 诚实 10）');

    // (c) 再 POST 单件（30）⇒ 环 6 源 ⇒ 仍与 TS 核心等价（FIFO 环序一致）
    const extra = mkRemote(30, 30, 60);
    const r2 = await post(JSON.stringify(extra));
    const j2 = (await r2.json()) as { digest: unknown; quarantined: Record<string, number>; method: string; sources: number };
    const ts2 = robustMergeDigests([...five, extra]);
    assert.deepStrictEqual(j2.digest, ts2.merged, '第二回合等价（FIFO 环序一致）');
    assert.deepStrictEqual(j2.quarantined, ts2.quarantined, '第二回合检疫一致');
    assert.equal(j2.method, ts2.method, '第二回合方法一致');
    assert.equal(j2.sources, 6, '环内 6 源');
    assert.equal(j2.quarantined['5'], 16, '新源偏离共识（30 vs 10）⇒ 16 票（折算律面前一律平等）');

    // (d) 协议执法：坏 JSON ⇒ 400；非对象 JSON ⇒ 400；非摘要对象 ⇒ 坏件不入环（rejected）；>1MB ⇒ 413；GET ⇒ 405；未知路径 ⇒ 404
    const rBad = await post('{"broken');
    assert.equal(rBad.status, 400, '坏 JSON ⇒ 400');
    const rNonObj = await post('123');
    assert.equal(rNonObj.status, 400, '非对象 JSON ⇒ 400');
    const rJunkObj = await post('{"hello":1}');
    assert.equal(rJunkObj.status, 200, '非摘要对象：按坏件缺席（不崩、环不动）');
    const jj = (await rJunkObj.json()) as { rejected: number; sources: number };
    assert.equal(jj.rejected, 1, '坏件计数在案');
    assert.equal(jj.sources, 6, '环内源数不变（坏件不入环）');
    const rHuge = await post('[' + '"pad",'.repeat(600_000) + '"pad"]');
    assert.equal(rHuge.status, 413, '>1MB ⇒ 413');
    const rGet = await fetch(`${base}/aggregate`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(rGet.status, 405, 'GET /aggregate ⇒ 405');
    const rNope = await fetch(`${base}/nope`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(rNope.status, 404, '未知路径 ⇒ 404');

    // (e) 服务在全部协议执法后仍存活（单请求故障不崩服务）且环内摘要仍在（内存单实例语义）
    const h2 = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(h2.status, 200, '服务仍存活');
    assert.equal(((await h2.json()) as { buffered: number }).buffered, 6, '环内 6 份摘要仍在（不落盘、单实例内存）');
  } finally {
    await srv.stop();
  }
});

// ─── Μ2-7：聚合端共享密钥认证（W6R-A5）── HMAC-SHA256 + 时间戳防重放 ───

test('Μ2-7: token 模式强制验签（无签/坏签/过期/篡改体 ⇒ 401 且环不动）；客户端签名往返 200；open 模式明示未认证', async t => {
  const SECRET = 'w6r-a5-test-shared-secret';
  let srv: Awaited<ReturnType<typeof startReferenceServer>>;
  try {
    srv = await startReferenceServer({ DSH_FEDERATION_TOKEN: SECRET });
  } catch (e) {
    return t.skip(`环境不支持子进程/环回监听：认证测试诚实跳过（${(e as Error).message}）`);
  }
  const base = `http://127.0.0.1:${srv.port}`;
  const health = async (): Promise<{ authMode: string; authNotice: string; buffered: number }> =>
    (await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) })).json()) as never;
  try {
    // (a) /health 明示 token 模式（认证已上膛 —— 不假装 open）
    const h0 = await health();
    assert.equal(h0.authMode, 'token', 'health 报 token 模式');
    assert.ok(h0.authNotice.includes('HMAC'), `认证指引在场（${h0.authNotice}）`);
    assert.equal(h0.buffered, 0, '初起缓冲空');

    // (b) 无签名 ⇒ 401 missing-signature-headers（环不动 —— 拒绝在解体之前）
    const rNoSig = await fetch(`${base}/aggregate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(digestOf('fed.auth', uniformBins(10), 10, 1)), signal: AbortSignal.timeout(5_000),
    });
    assert.equal(rNoSig.status, 401, '无签名 ⇒ 401');
    const jNoSig = (await rNoSig.json()) as { reason: string };
    assert.equal(jNoSig.reason, 'missing-signature-headers', 'reason = 缺签名头');
    assert.equal((await health()).buffered, 0, '401 不入环');

    // (c) 坏签名（异密钥）⇒ 401 signature-mismatch
    const body1 = JSON.stringify(digestOf('fed.auth', uniformBins(10), 10, 1));
    const badSig = federationAuthHeaders(body1, 'wrong-secret', Date.now());
    const rBadSig = await fetch(`${base}/aggregate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...badSig },
      body: body1, signal: AbortSignal.timeout(5_000),
    });
    assert.equal(rBadSig.status, 401, '异密钥签名 ⇒ 401');
    assert.equal(((await rBadSig.json()) as { reason: string }).reason, 'signature-mismatch', 'reason = 签名失配');

    // (d) 过期时间戳（签名对 ts 自身有效，但 ts 超 ±5min 窗口）⇒ 401 stale-timestamp（防重放）
    const staleSig = federationAuthHeaders(body1, SECRET, Date.now() - 10 * 60_000);
    const rStale = await fetch(`${base}/aggregate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...staleSig },
      body: body1, signal: AbortSignal.timeout(5_000),
    });
    assert.equal(rStale.status, 401, '过期时间戳 ⇒ 401（重放窗口外）');
    assert.equal(((await rStale.json()) as { reason: string }).reason, 'stale-timestamp', 'reason = 时间戳过期');

    // (e) 篡改体（中间人换体）：签名对原文、发送体不同 ⇒ 401（摘要替换攻击的正面粉碎）
    const tampered = JSON.stringify(digestOf('fed.auth', uniformBins(999), 999, 1));
    const sigForOriginal = federationAuthHeaders(body1, SECRET, Date.now());
    const rTamper = await fetch(`${base}/aggregate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...sigForOriginal },
      body: tampered, signal: AbortSignal.timeout(5_000),
    });
    assert.equal(rTamper.status, 401, '换体签名失配 ⇒ 401（毒摘要进不了环）');
    assert.equal((await health()).buffered, 0, '全部 401 后环仍空');

    // (f) 客户端端到端：federationSync（authToken 注入 + 真全局 fetch 环回）—— 签名被收、
    //     响应 digests 回环、鲁棒臂掺入照常（认证是旁路：合法客户端语义零变化）
    resetFederationRuntime();
    try {
      const K = 'fed.authsync';
      const ledger = new EvidenceLedger();
      for (let i = 0; i < 10; i++) ledger.record({ key: K, success: i % 2 === 0, margin: 0.1 * i - 0.5, ts: i });
      const res = federationSync({
        endpoint: `${base}/aggregate`,
        ledger,
        maxRemoteShare: 0.5,
        robust: true,
        authToken: SECRET,
      });
      assert.equal(res.network, 'fired', '签名请求已发');
      await res.settled;
      assert.equal(res.applied !== null, true, '验签通过 ⇒ 响应被消费（未掺入才是异常）');
      assert.equal(res.applied!.applied, 1, '环内唯一源 = 自己的摘要 ⇒ 鲁棒 2 源均值；新端点试用期 0.35 ⇒ quota = floor(5×0.35) = 1');
      assert.equal(res.robust!.method, 'mean', 'local + 环内 1 份（自己）⇒ 2 源均值');
      assert.equal(res.robust!.mergedFrom, 2, 'mergedFrom = 2');
      assert.equal(ledger.stats(K).n, 11, '账本 10 → 11');
      assert.equal((await health()).buffered, 1, '合法签名 ⇒ 入环');
    } finally {
      resetFederationRuntime();
    }

    // (g) open 模式（env 未设置）：零配置语义不变 + /health 明示 UNAUTHENTICATED（诚实声明）
    let open: Awaited<ReturnType<typeof startReferenceServer>>;
    try {
      open = await startReferenceServer(); // 不注入 token ⇒ open
    } catch (e) {
      return t.skip(`open 参考端未就绪：诚实跳过（${(e as Error).message}）`);
    }
    try {
      const oh = await (await fetch(`http://127.0.0.1:${open.port}/health`, { signal: AbortSignal.timeout(2_000) })).json() as
        { authMode: string; authNotice: string };
      assert.equal(oh.authMode, 'open', 'open 模式照旧可用');
      assert.ok(oh.authNotice.includes('UNAUTHENTICATED'), `未认证明示在场（${oh.authNotice}）`);
      assert.ok(oh.authNotice.includes('DSH_FEDERATION_TOKEN'), '指路 env 名');
      const rOpen = await fetch(`http://127.0.0.1:${open.port}/aggregate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: body1, signal: AbortSignal.timeout(5_000),
      });
      assert.equal(rOpen.status, 200, 'open 端点无签名照收（零配置环回现状保持）');
    } finally {
      await open.stop();
    }
  } finally {
    await srv.stop();
  }
});

// ─── Μ2-8：客户端签名头权威面（federationAuthHeaders）── 与服务端同协议的字面量契约 ───

test('Μ2-8: federationAuthHeaders 纯函数 —— 空 token 零头/双头字面量/覆盖正文/密钥不入头', () => {
  const body = JSON.stringify({ v: 1, mintedAt: 1, epsilon: 1, keys: [] });
  // (a) 消毒臂：空/非字符串 token ⇒ 零头（open 客户端不惊扰 open 服务端）
  assert.deepEqual(federationAuthHeaders(body, '', 1000), {}, '空串 ⇒ 零头');
  assert.deepEqual(federationAuthHeaders(body, null, 1000), {}, 'null ⇒ 零头');
  assert.deepEqual(federationAuthHeaders(body, undefined, 1000), {}, 'undefined ⇒ 零头');
  assert.deepEqual(federationAuthHeaders(body, 42 as unknown, 1000), {}, '非字符串 ⇒ 零头（防御式消毒）');

  // (b) 双头字面量：ts = 注入时钟（epoch ms）；sig = HMAC-SHA256(`${ts}.${body}`, token) hex
  const h = federationAuthHeaders(body, 'k'.repeat(32), 42_000);
  assert.equal(h[FEDERATION_AUTH_TIMESTAMP_HEADER], '42000', '时间戳头 = 注入时钟');
  const expected = createHmac('sha256', 'k'.repeat(32)).update(`42000.${body}`).digest('hex');
  assert.equal(h[FEDERATION_AUTH_SIGNATURE_HEADER], expected, '签名头 = 权威公式重算一致（双端口径）');
  assert.ok(!JSON.stringify(h).includes('k'.repeat(32)), '密钥绝不进头值（密钥卫生）');

  // (c) 正文覆盖：body 一字之差 / 异密钥 / 异时间戳 ⇒ 签名全部失配
  assert.notEqual(
    federationAuthHeaders(body + ' ', 'k'.repeat(32), 42_000)[FEDERATION_AUTH_SIGNATURE_HEADER],
    expected, '正文变 ⇒ 签名变（中间人换体被拒）',
  );
  assert.notEqual(
    federationAuthHeaders(body, 'j'.repeat(32), 42_000)[FEDERATION_AUTH_SIGNATURE_HEADER],
    expected, '密钥变 ⇒ 签名变',
  );
  assert.notEqual(
    federationAuthHeaders(body, 'k'.repeat(32), 42_001)[FEDERATION_AUTH_SIGNATURE_HEADER],
    expected, '时间戳变 ⇒ 签名变（ts 在 MAC 输入里 —— 防重放的时间面）',
  );

  // (d) 容差常量与协议字面量锁定（服务端同值 —— 双实现漂移的测试把守）
  assert.equal(FEDERATION_AUTH_TIMESTAMP_HEADER, 'x-dsh-fed-timestamp', '时间戳头名锁定');
  assert.equal(FEDERATION_AUTH_SIGNATURE_HEADER, 'x-dsh-fed-signature', '签名头名锁定');
});

// ─── Μ2-9（ΝΩ-19 联邦逐源签名）：假源验签剔除 + 指纹粒度信任 + 止血兜底 + 旧档兼容 ───

/** 生成一个 Ed25519 测试客户端（pkcs8/base64 与 seed 两种密钥原料 + 签名/指纹假件） */
function edClient(): {
  material: string;
  seedMaterial: string;
  publicKeyB64: string;
  fingerprint: string;
  sign: (d: EvidenceDigest) => EvidenceDigest & { pubkey: string; sig: string };
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const material = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const seedMaterial = Buffer.from((privateKey.export({ format: 'jwk' }) as { d?: string }).d ?? '', 'base64url').toString('base64');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const fingerprint = createHash('sha256').update(spki).digest('hex').slice(0, 16);
  const publicKeyB64 = spki.toString('base64');
  const sign = (d: EvidenceDigest): EvidenceDigest & { pubkey: string; sig: string } => {
    // 与 signEvidenceDigest 同签名域：核心四域 canonical 字节（pubkey/sig 不入域）
    const domain = canonicalFederationJson({ v: d.v, mintedAt: d.mintedAt, epsilon: d.epsilon, keys: d.keys });
    const sig = ed25519SignTest(null, Buffer.from(domain, 'utf8'), privateKey as KeyObject).toString('base64');
    return { ...d, pubkey: publicKeyB64, sig };
  };
  return { material, seedMaterial, publicKeyB64, fingerprint, sign };
}

test('Μ2-9: 假源验签剔除（中位数不被污染）；指纹试用期独立；无签名降级；同毫秒批量；止血限额；旧档兼容', async () => {
  resetFederationRuntime();
  try {
    const K = 'fed.sig';
    const self = edClient();
    const honest = (mintedAt: number): EvidenceDigest => digestOf(K, uniformBins(50), 50, mintedAt);
    const poison = (mintedAt: number): EvidenceDigest => digestOf(K, uniformBins(1000), 1000, mintedAt);

    // (a) 密钥解析与指纹：seed 与 pkcs8 双形态同指纹；垃圾/空 ⇒ null；生成命令指路 env
    assert.equal(FEDERATION_SIGNING_KEY_ENV, 'DSH_FED_SIGNING_KEY', 'env 名锁定（协议契约）');
    const idPkcs8 = federationSigningIdentity(self.material);
    assert.ok(idPkcs8, 'pkcs8/base64 形态可解析');
    assert.equal(idPkcs8!.fingerprint, self.fingerprint, '指纹 = sha256(SPKI) 前 16 hex');
    assert.equal(idPkcs8!.publicKey, self.publicKeyB64, '公钥 = base64 SPKI');
    assert.equal(federationSigningIdentity(self.seedMaterial)?.fingerprint, self.fingerprint, '32 字节 seed 形态同指纹（PKCS8 前缀包装）');
    assert.equal(federationSigningIdentity('definitely-not-a-key'), null, '垃圾密钥 ⇒ null（绝不抛）');
    assert.equal(federationSigningIdentity(''), null, '空 ⇒ null（未配置）');
    assert.equal(federationSigningIdentity(null), null, 'null ⇒ 显式禁用');
    assert.ok(federationSigningKeyHint().includes('DSH_FED_SIGNING_KEY'), '一次性生成命令指路 env 名');

    // (b) 无密钥 ⇒ 上行逐字节旧路径；有密钥 ⇒ 附 {pubkey,sig} 且往返验签成立
    const EPB = 'https://agg-b.example/fed';
    let bodyNoKey = '';
    const fakeNoKey = (async (_u: string, init: { body: string }) => {
      bodyNoKey = init.body;
      return { json: async () => ({ digests: [honest(20)] }) };
    }) as unknown as FederationFetch;
    const resNoKey = federationSync({ endpoint: EPB, fetchImpl: fakeNoKey, ledger: seedLedger(K, 10), robust: true, now: () => 50, signingKey: null });
    await resNoKey.settled;
    assert.equal(bodyNoKey, JSON.stringify(resNoKey.digest), '无密钥 ⇒ 上行载荷逐字节 = 本地摘要（零回归律）');
    assert.equal(verifyEvidenceDigestSignature(JSON.parse(bodyNoKey)).ok, false, '未签件验签不成立（无身份源）');

    let bodySigned = '';
    const fakeSigned = (async (_u: string, init: { body: string }) => {
      bodySigned = init.body;
      return { json: async () => ({ digests: [honest(20)] }) }; // 无签远端 ⇒ 全剔除（见 (e) 同律）
    }) as unknown as FederationFetch;
    const resSigned = federationSync({ endpoint: EPB, fetchImpl: fakeSigned, ledger: seedLedger(K, 10), robust: true, now: () => 51, signingKey: self.material });
    await resSigned.settled;
    const uplink = JSON.parse(bodySigned) as { pubkey?: string; sig?: string };
    assert.equal(uplink.pubkey, self.publicKeyB64, '上行附公钥');
    assert.ok(typeof uplink.sig === 'string' && uplink.sig !== '', '上行附签名');
    const vUp = verifyEvidenceDigestSignature(uplink);
    assert.equal(vUp.ok, true, '上行件验签成立（往返口径）');
    assert.equal(vUp.fingerprint, self.fingerprint, '验签回指同一指纹');
    assert.equal(signEvidenceDigest(honest(1), null), null, 'signEvidenceDigest 无密钥 ⇒ null（诚实空手）');
    assert.ok(lastFederationSync()!.note?.includes('验签不过 1'), `无签远端全剔除注记（${lastFederationSync()!.note}）`);

    // (c) 假源剔除：本地 + 2 签名诚实源 + 5 无签假源 ⇒ 假源绝不混入中位数（= 诚实 50）
    const EPC = 'https://agg-c.example/fed';
    const peerA = edClient();
    const peerB = edClient();
    const fakeMix = (async () => ({
      json: async () => ({
        digests: [
          peerA.sign(honest(11)), peerB.sign(honest(12)),
          poison(13), poison(14), poison(15), poison(16), poison(17), // 恶意端自造 5 份（无签）
        ],
      }),
    })) as unknown as FederationFetch;
    const targetC = seedLedger(K, 10);
    const resC = federationSync({ endpoint: EPC, fetchImpl: fakeMix, ledger: targetC, robust: true, now: () => 52, signingKey: self.material, maxRemoteShare: 0.5 });
    await resC.settled;
    assert.equal(resC.robust!.unverifiableSources, 5, '5 份无签假源剔除并计数');
    assert.equal(resC.robust!.mergedFrom, 3, '本地 + 2 签名源 = 3 源');
    assert.equal(resC.robust!.method, 'median', '3 源中位数');
    assert.equal(resC.robust!.excessiveSources ?? 0, 0, '未触止血限额');
    assert.equal(resC.robust!.batchedSources ?? 0, 0, '未触批量护栏');
    assert.deepEqual(Object.keys(resC.robust!.quarantined), ['local'], '检疫票键只剩 local（签名源零票；票键域 = endpoint#指纹）');
    assert.equal(resC.robust!.quarantined['local'], 16, '本地偏离共识 16 票（不喂账）');
    assert.equal(resC.applied!.applied, 1, '合并面 = 诚实 50 ⇒ 新端点试用期 quota = floor(5×0.35) = 1');
    assert.equal(targetC.stats(K).n, 11, '账本 10 → 11（中位数未被 5 假源污染）');
    const tailC = targetC.entries(K).slice(-1)[0];
    const tailCm = tailC.margin ?? Number.NaN;
    assert.ok(Number.isFinite(tailCm) && tailCm >= -1 - 1e-9 && tailCm <= -0.75 + 1e-9, `掺入 margin 落 bin0（均匀 50 合并面 ⇒ quota 1 落首格；实测 ${tailCm} —— 5 份 1000 假源未入中位）`);

    // (d) 指纹粒度试用期独立：毒指纹 16 票 ⇒ 0.25 记 endpoint#指纹；诚实指纹 3 干净轮毕业；端点账不吃指纹票
    const EPD = 'https://agg-d.example/fed';
    const peerP = edClient(); // 毒客户端（真实持钥 —— 验签过、但摘要灌毒）
    const peerH = edClient(); // 诚实客户端
    const acctP = federationFingerprintSourceId(EPD, peerP.fingerprint);
    const acctH = federationFingerprintSourceId(EPD, peerH.fingerprint);
    assert.equal(acctP, `${EPD}#${peerP.fingerprint}`, '账键 = endpoint#指纹');
    const round = (resp: unknown[], nowT: number, ledger: EvidenceLedger) => {
      const fake = (async () => ({ json: async () => ({ digests: resp }) })) as unknown as FederationFetch;
      return federationSync({ endpoint: EPD, fetchImpl: fake, ledger, robust: true, now: () => nowT, signingKey: self.material, maxRemoteShare: 0.5 });
    };
    const ledgerD = seedLedger(K, 10);
    await round([peerP.sign(poison(21)), peerH.sign(honest(22))], 70, ledgerD).settled; // 轮 1：毒+诚实
    assert.equal(federationTrustOf(acctP), 0.25, '毒指纹 16 票 ⇒ 3 regressed ⇒ 1/(1+3) = 0.25（记指纹账）');
    assert.ok(Math.abs(federationTrustOf(acctH) - 0.35) < 1e-12, '诚实指纹试用期封顶 0.35（cleanMerges=1 < 3）');
    const recP = federationTrustReport().find(r => r.sourceId === acctP)!;
    const recH = federationTrustReport().find(r => r.sourceId === acctH)!;
    assert.equal(recP.regressed, 3, '毒指纹 regressed=3');
    assert.equal(recP.cleanMerges, 0, '带票轮不计干净（R6 同律）');
    assert.equal(recH.regressed, 0, '诚实指纹零票');
    assert.equal(recH.cleanMerges, 1, '诚实指纹干净轮 +1（毕业通道平移到指纹主体）');
    const recEP = federationTrustReport().find(r => r.sourceId === EPD)!;
    assert.equal(recEP.regressed, 0, '端点账不吃指纹票（ΑΩ-R6 平移到正确主体粒度）');
    assert.ok(Math.abs(federationTrustOf(EPD) - 0.35) < 1e-12, '端点账停在掺入侧试用期（未被毒源连坐）');
    await round([peerH.sign(honest(23)), self.sign(honest(24))], 71, ledgerD).settled; // 轮 2：3 源（本地+2 签名）
    await round([peerH.sign(honest(25)), self.sign(honest(26))], 72, ledgerD).settled; // 轮 3
    assert.equal(federationTrustOf(acctH), 1, '诚实指纹 3 干净轮 ⇒ 毕业（trust=1，ΑΩ-R6 毕业永久）');
    assert.equal(federationTrustOf(acctP), 0.25, '毒指纹仍 0.25（两账独立 —— Sybil 无法搭邻居信用）');

    // (e) 无签名旧格式 ⇒ 诚实降级全剔除：绝不混入中位数、零掺入、账本零污染
    const EPE = 'https://agg-e.example/fed';
    const fakeUnsigned = (async () => ({ json: async () => ({ digests: [honest(31), honest(32)] }) })) as unknown as FederationFetch;
    const targetE = seedLedger(K, 10);
    const resE = federationSync({ endpoint: EPE, fetchImpl: fakeUnsigned, ledger: targetE, robust: true, now: () => 60, signingKey: self.material });
    await resE.settled;
    assert.equal(resE.applied, null, '全剔除 ⇒ 不掺入（恶意端点不得经本地回环掺入赚干净轮）');
    assert.equal(targetE.stats(K).n, 10, '账本零污染');
    assert.ok(lastFederationSync()!.note?.includes('验签不过 2'), `降级注记（${lastFederationSync()!.note}）`);

    // (f) mintedAt 同毫秒批量特征：不同指纹但同毫秒铸造 ⇒ 整组剔除并计数
    const EPF = 'https://agg-f.example/fed';
    const batchA = edClient();
    const batchB = edClient();
    const good = edClient();
    const fakeBatch = (async () => ({
      json: async () => ({
        digests: [
          batchA.sign(digestOf(K, uniformBins(1000), 1000, 777)),
          batchB.sign(digestOf(K, uniformBins(1000), 1000, 777)), // 同毫秒（不同指纹）⇒ 批量特征
          good.sign(honest(778)),
        ],
      }),
    })) as unknown as FederationFetch;
    const resF = federationSync({ endpoint: EPF, fetchImpl: fakeBatch, ledger: seedLedger(K, 10), robust: true, now: () => 61, signingKey: self.material });
    await resF.settled;
    assert.equal(resF.robust!.batchedSources, 2, '同毫秒两源整组剔除');
    assert.equal(resF.robust!.unverifiableSources, 0, '验签全过（剔除发生在护栏层）');
    assert.equal(resF.robust!.mergedFrom, 2, '本地 + 1 存活源');
    assert.equal(resF.robust!.method, 'mean', '2 源均值（诚实注记：无鲁棒性）');

    // (g) 止血限额：响应源数 > 本地已知客户端数×2+4 ⇒ 超额拒绝（首轮已知 = 仅本机 ⇒ 上限 6）
    resetFederationRuntime(); // 名册清零 ⇒ 已知 = 仅 self ⇒ 1×2+4 = 6
    const EPG = 'https://agg-g.example/fed';
    const flood = Array.from({ length: 8 }, () => edClient()); // 8 个互异持钥源（全过验签）
    const fakeFlood = (async () => ({
      json: async () => ({ digests: flood.map((p, i) => p.sign(honest(100 + i))) }), // mintedAt 互异（避开批量护栏）
    })) as unknown as FederationFetch;
    const resG = federationSync({ endpoint: EPG, fetchImpl: fakeFlood, ledger: seedLedger(K, 10), robust: true, now: () => 62, signingKey: self.material });
    await resG.settled;
    assert.equal(resG.robust!.unverifiableSources, 0, '验签全过');
    assert.equal(resG.robust!.excessiveSources, 2, '8 源 > 6 ⇒ 超额 2 拒绝');
    assert.equal(resG.robust!.mergedFrom, 7, '本地 + 6 存活源');
    assert.equal(resG.robust!.method, 'median', '7 源中位数');

    // (h) 签后改体 / 剥签名 ⇒ 拒收（签名域覆盖 canonical 四域）
    const evil = edClient();
    const tampered = evil.sign(honest(41));
    tampered.keys[0].bins[0][0] = 9999; // 签名后改体
    assert.equal(verifyEvidenceDigestSignature(tampered).ok, false, '签后改体 ⇒ 验签不成立');
    assert.equal(verifyEvidenceDigestSignature(tampered).reason, 'bad-signature', '归因 = 签名失配');
    const stripped = { ...evil.sign(honest(42)) } as Record<string, unknown>;
    delete stripped.sig;
    assert.equal(verifyEvidenceDigestSignature(stripped).ok, false, '剥签名 ⇒ unverifiable（missing-signature）');
    assert.equal(verifyEvidenceDigestSignature(stripped).reason, 'missing-signature', '归因 = 缺签名');
    assert.equal(verifyEvidenceDigestSignature(42).ok, false, '垃圾入参不抛');
    assert.equal(verifyEvidenceDigestSignature({ get pubkey(): string { throw new Error('boom'); } }).ok, false, '陷阱属性不抛');

    // (i) 旧档兼容：v=2 档混裸 endpoint 键与 endpoint#指纹键 ⇒ 照常恢复与执法（键域自由字符串）
    const restored = restoreFederationTrust({
      v: 2,
      savedAt: 1,
      accounts: [
        { sourceId: 'https://old.example/fed', applied: 9, regressed: 0, merges: 3, cleanMerges: 3, dirty: false },
        { sourceId: 'https://old.example/fed#ab12cd34ef56ab12', applied: 1, regressed: 0, merges: 1, cleanMerges: 1, dirty: false },
      ],
    });
    assert.equal(restored.restored, 2, '新旧键同档恢复');
    assert.equal(federationTrustOf('https://old.example/fed'), 1, '毕业裸端点键照常执法');
    assert.ok(Math.abs(federationTrustOf('https://old.example/fed#ab12cd34ef56ab12') - 0.35) < 1e-12, '指纹键试用期照常执法');
    const doc = JSON.parse(serializeFederationTrust(() => 99)) as { v: number; accounts: Array<{ sourceId: string }> };
    assert.equal(doc.v, 2, 'schema 版本不动（旧档零迁移）');
    assert.ok(doc.accounts.some(a => a.sourceId === 'https://old.example/fed#ab12cd34ef56ab12'), '序列化保持指纹键');
  } finally {
    resetFederationRuntime();
  }
});

// ─── Μ2-10（ΝΩ-19）：参考聚合端签名中继 —— 转发保留签名域 + 端到端验签存活 ───

test('Μ2-10: 带签摘要原样入环回传（pubkey/sig 不被剥）；回传件验签成立、改体拒绝；客户端环回端到端', async t => {
  let srv: Awaited<ReturnType<typeof startReferenceServer>>;
  try {
    srv = await startReferenceServer();
  } catch (e) {
    return t.skip(`环境不支持子进程/环回监听：签名中继测试诚实跳过（${(e as Error).message}）`);
  }
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    const K = 'fed.sigsrv';
    const client = edClient();

    // (a) 端到端：federationSync（signingKey 注入 + 真全局 fetch）⇒ 自己的带签摘要入环
    //     回传、验签存活（fp = 自己）⇒ 2 源均值掺入（迁移期哨兵不触发 —— 本机已配钥）
    resetFederationRuntime();
    try {
      const ledger = new EvidenceLedger();
      for (let i = 0; i < 10; i++) ledger.record({ key: K, success: i % 2 === 0, margin: 0.1 * i - 0.5, ts: i });
      const res = federationSync({
        endpoint: `${base}/aggregate`,
        ledger,
        robust: true,
        signingKey: client.material,
        maxRemoteShare: 0.5,
      });
      assert.equal(res.network, 'fired', '带签请求已发');
      await res.settled;
      assert.equal(res.applied !== null, true, '环内唯一源 = 自己的带签摘要 ⇒ 验签存活 ⇒ 掺入');
      assert.equal(res.applied!.applied, 1, '2 源均值 + 新端点试用期 0.35 ⇒ quota = floor(5×0.35) = 1');
      assert.equal(res.robust!.mergedFrom, 2, 'mergedFrom = local + 环内自己 1 份');
      assert.equal(res.robust!.method, 'mean', 'local + 自己回环 = 2 源均值');
      assert.equal(res.robust!.unverifiableSources, 0, '验签零剔除');
      assert.equal(ledger.stats(K).n, 11, '账本 10 → 11');
    } finally {
      resetFederationRuntime();
    }

    // (b) 手工 POST 带签摘要 ⇒ 响应 digests 原样回传（pubkey/sig 域不被剥 —— 中继不签证）
    const signed = client.sign(digestOf(K, uniformBins(10), 10, 1));
    const r = await fetch(`${base}/aggregate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signed), signal: AbortSignal.timeout(8_000),
    });
    assert.equal(r.status, 200, 'aggregate 200');
    const j = (await r.json()) as { digests: Array<Record<string, unknown>> };
    assert.equal(j.digests.length, 2, '环内 2 份（端到端自己的 + 手工这份）');
    const relayed = j.digests[j.digests.length - 1];
    assert.deepEqual(relayed, signed as unknown as Record<string, unknown>, '聚合端转发保留签名域（ΝΩ-19）');
    assert.equal(verifyEvidenceDigestSignature(relayed).ok, true, '回传件验签成立（指纹可续账）');

    // (c) 恶意聚合端改体模拟：回传件被改 ⇒ 客户端验签拒绝（毒摘要进不了中位数）
    const tampered = JSON.parse(JSON.stringify(relayed)) as { keys: Array<{ n: number }> };
    tampered.keys[0].n = 999;
    assert.equal(verifyEvidenceDigestSignature(tampered).ok, false, '改体 ⇒ 验签拒（bad-signature）');
  } finally {
    await srv.stop();
  }
});
