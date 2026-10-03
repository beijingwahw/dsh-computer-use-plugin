// test/epochMu2.aggregate.test.ts
// 纪元 Μ2（拜占庭鲁棒联邦聚合 —— Μ 的加固续笔）执法册 Μ2-1~Μ2-6：
//   Μ2-1 鲁棒律：5 源中 1 源灌毒（×100）⇒ 中位数聚合值 = 诚实源中位（毒被结构性
//        隔离）；朴素求和对照（毒直通 —— secure-aggregation 弱点在册）；异质诚实
//        值下中位数取真中位；检疫票集中在毒源（诚实源 0 票）；阈地板容噪侧。
//   Μ2-2 小源数诚实：2 源 = 均值 + 无鲁棒性注记；1 源直通（逐字段保真）；0 源
//        null；坏源（版本错配/形状坏/陷阱属性）按缺席处理并注记；逐 key 源数偏差。
//   Μ2-3 检疫有牙齿（端到端）：16 票 ⇒ floor(16/5)=3 次 regressed ⇒ 信任账
//        1/(1+3)=0.25 ⇒ 下次 apply 配额 5→1；不足 5 票的噪声容限不立脏账。
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
// 全程离线（fetch 全假件/仅环回 127.0.0.1）、确定性（钉死字面量摘要 / 注入时钟）、
// 生产单例 try/finally 复位；Μ 既有测试（epochMu.federation）另行回归保绿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
    assert.equal(federationTrustOf('host-a'), 1, '无票源不受牵连');

    // (b) 不足 5 票的噪声容限：不立脏账
    assert.deepEqual(applyQuarantineToTrust({ 'host-d': 4 }, recordFederationTrust), [], '4 票 < 5 ⇒ 零事件');
    assert.equal(federationTrustOf('host-d'), 1, '噪声不折减信任');

    // (c) 端到端：毒被隔离后的合并面（诚实分布）经 host-c 掺入 —— 信任 0.25 折减配额 5→1
    const ledger = seedLedger(K, 10); // 本地 n=10
    const applied = applyFederatedEvidence(ledger, rr.merged, { maxRemoteShare: 0.5, sourceId: 'host-c', now: () => 999 });
    assert.equal(applied.trust, 0.25, '掺入走信任账 0.25');
    assert.equal(applied.applied, 1, 'quota = floor(floor(0.5×10) × 0.25) = 1 —— 检疫的牙齿');
    assert.equal(ledger.stats(K).n, 11, '账本 10 → 11');

    // (d) 对照：无检疫记录的诚实源同摘要 ⇒ 配额 5
    const ledger2 = seedLedger(K, 10);
    const applied2 = applyFederatedEvidence(ledger2, rr.merged, { maxRemoteShare: 0.5, sourceId: 'host-a', now: () => 999 });
    assert.equal(applied2.applied, 5, '诚实源 quota = floor(5 × 1) = 5');
    assert.equal(applied2.trust, 1, '初见全信');

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
    // 毒隔离的端到端证据：掺入记录的 margin = 坨中心（合并面是均匀 50 的鲁棒摘要 ⇒
    // quota 1 落在最大余数法首格 bin0/success ⇒ margin = -0.875、success、ts=42）
    const tail = target.entries(K).slice(-1)[0];
    assert.equal(tail.success, true, '成败由坨坐标反演（success 列）');
    assert.ok(Math.abs((tail.margin ?? Number.NaN) - -0.875) < 1e-12, `margin 取坨中心 -0.875（实测 ${tail.margin}）`);
    assert.equal(tail.ts, 42, 'ts 走注入时钟');

    // (b) robust 缺省 false = Μ 旧路径逐字节：digest 单件语义 / 结果无 robust 字段
    resetFederationRuntime();
    const EP2 = 'https://legacy.example/fed';
    const K2 = 'fed.legacy';
    const target2 = seedLedger(K2, 10);
    const legacyDigest = digestOf(K2, uniformBins(50), 500, 5);
    const fakeLegacy = (async () => ({ json: async () => ({ digest: legacyDigest }) })) as unknown as FederationFetch;
    const res2 = federationSync({ endpoint: EP2, fetchImpl: fakeLegacy, ledger: target2, maxRemoteShare: 0.5, now: () => 43 });
    await res2.settled;
    assert.equal(res2.applied!.applied, 5, 'legacy：floor(0.5×10) = 5（与 Μ-4 同语义）');
    assert.equal(target2.stats(K2).n, 15, 'legacy：账本 10 → 15');
    assert.equal(federationTrustOf(EP2), 1, 'legacy：端点 applied 立账、trust=1');
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

/** 起参考聚合端（--port 0 ⇒ 随机环回口；8s 监听 + 5s 就绪上界；失败抛错供调用方 skip） */
async function startReferenceServer(): Promise<{ port: number; child: ChildProcess; stop: () => Promise<void> }> {
  const script = fileURLToPath(new URL('../scripts/federation-server.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
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
