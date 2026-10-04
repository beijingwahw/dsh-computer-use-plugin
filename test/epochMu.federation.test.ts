// test/epochMu.federation.test.ts
// 纪元 Μ（万脑联邦进化）执法册 Μ-1~Μ-5：
//   Μ-1 确定性+DP：同 seed 同账本 ⇒ 摘要逐字段一致；异 seed ⇒ 噪声生效（若干格
//        不同）；噪声有界合理（|noise| 中位数远小于典型计数、逐格 |noise| 有界）；
//        ε 越小噪声越大（同 u 流线性放大的单调性抽查）；laplaceNoise 纯函数
//        消毒臂（scale≤0/NaN ⇒ 0）与对称臂（u 与 1-u 严格反号）。
//   Μ-2 合并：两摘要逐格求和正确（n 亦求和）；版本错配 ⇒ null；坏格按 0 计数
//        +skipped 注记；空数组/非数组 ⇒ null。
//   Μ-3 份额上限：本地 n=10、maxRemoteShare=0.5 ⇒ 掺入恰 ≤5；本地零证据 key ⇒
//        零掺入+注记；trust=0.5 再折半（quota=2）；掺入后 kernelRegistry 现值
//        逐字节不变（只有账本动了）；成败/坨中心由坨坐标反演入账。
//   Μ-4 零网络纪律：endpoint='' ⇒ fetch 零调用（spy）且工具 sync 动作 off；
//        endpoint+假 fetch ⇒ POST 发出（方法/头/体=本地摘要）、响应摘要被应用；
//        响应垃圾 JSON ⇒ 不掺不炸；fetch 失败 ⇒ 诚实降级（错误消毒：首行、
//        endpoint 脱敏）；tools/index.ts 挂载门源码取证（两臂条件 + 既有块未动）。
//   Μ-5 信任账：applied 后记一次 regressed ⇒ trust 减半（1/2），下次掺入折减
//        （quota 5→2）；再记 ⇒ 1/3；status 动作可见信任账+上次同步；垃圾入账不抛。
//   Μ-6 工具面 robust 投产（D-B6/W6R-A5）：sync 动作缺省走 Μ2 拜占庭鲁棒臂
//        （本地逐格中位数 + 检疫票折算端点信任 ⇒ 同轮配额折减）；显式
//        robust:false 回退 Μ 旧行为（结果形状无 robust 字段）。
//   Μ-7 信任持久化往返（W6-4 缝包 + W7-0 生产接线）：file store 原子落盘 →
//        跨进程模拟（resetFederationRuntime）→ loadFederationTrust 恢复 →
//        信任/配额续账；生产接线（src/index.ts 的 load/arm/flush）源码取证。
//   Μ-8 客户端 HMAC 签名头（W6R-A5）：env 缺省零头；DSH_FEDERATION_TOKEN
//        在场 ⇒ federationSync 自动附 x-dsh-fed-* 双头（与权威实现逐字段
//        一致）；authToken 显式注入优先；null 显式禁用。
// 全程离线（fetch 全假件/零调用）、rng/时钟全注入、确定性；生产单例 try/finally 复位。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';

import {
  KernelRegistry,
  EvidenceLedger,
  kernelRegistry,
  evidenceLedger,
  resetKernelRuntime,
} from '../src/kernel/registry.ts';
import {
  mintEvidenceDigest,
  mergeDigests,
  applyFederatedEvidence,
  federationSync,
  laplaceNoise,
  recordFederationTrust,
  federationTrustOf,
  federationTrustReport,
  resetFederationRuntime,
  lastFederationSync,
  createFederationTrustFileStore,
  loadFederationTrust,
  armFederationTrustPersistence,
  flushFederationTrust,
  federationTrustPersistenceStatus,
  federationAuthHeaders,
  FEDERATION_AUTH_ENV,
  FEDERATION_AUTH_TIMESTAMP_HEADER,
  FEDERATION_AUTH_SIGNATURE_HEADER,
  DIGEST_BINS,
  type FederationFetch,
} from '../src/federation/index.ts';
import { createFederationSyncTool } from '../src/tools/federationTools.ts';
import type { Config } from '../src/config.ts';

// ─── 假件工坊（全注入、零网络、确定性） ───

/** 铸一个最小联邦配置（工具面用；缺省零网络语义） */
function fedConfig(over: Partial<Config> = {}): Config {
  return {
    kernelEvolutionEnabled: false,
    federationEndpoint: '',
    federationEpsilon: 1,
    federationMaxRemoteShare: 0.5,
    ...over,
  } as unknown as Config;
}

/** 真值直方图镜像（与 mintEvidenceDigest 同律的坨坐标算法 —— 测试侧独立重算） */
function trueCellsOf(entries: ReadonlyArray<{ success: boolean; margin?: number }>): { n: number; cells: number[] } {
  const cells = new Array<number>(DIGEST_BINS * 2).fill(0);
  let n = 0;
  for (const e of entries) {
    if (typeof e.success !== 'boolean') continue;
    n += 1;
    if (e.margin === undefined || !Number.isFinite(e.margin)) continue;
    const m = Math.min(1, Math.max(-1, e.margin));
    const idx = Math.min(DIGEST_BINS - 1, Math.floor((m + 1) / (2 / DIGEST_BINS)));
    cells[idx * 2 + (e.success ? 0 : 1)] += 1;
  }
  return { n, cells };
}

/** 坨中心（掺入 margin 的反演值 —— 与实现同式：b=0 ⇒ -0.875） */
function centerOf(b: number): number {
  return -1 + (b + 0.5) * (2 / DIGEST_BINS);
}

/** 8×[big,big] 的远端大质量坨（洪泛诱饵 —— 靠份额上限闸住） */
function bigBins(v = 100): number[][] {
  return Array.from({ length: DIGEST_BINS }, () => [v, v]);
}

/** 数组中位数（偶数个取低中位 —— 确定性） */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

type ToolLike = { execute: (a: unknown, e: unknown) => Promise<unknown> };
async function runTool(tool: ToolLike, args: unknown): Promise<any> {
  return JSON.parse(String(await tool.execute(args, undefined)));
}

// ─── Μ-1：确定性 + 差分隐私噪声 ───

test('Μ-1: 同 seed 同账本 ⇒ 摘要逐字段一致；异 seed ⇒ 噪声生效；噪声有界；ε 单调；laplaceNoise 纯函数', () => {
  // 账本：主 key 100 条带 margin（典型格计数 ~3-8，噪声中位数 ~0.69 « 计数），
  // 另 5 条无 margin（只计 n 不入格；合计 105 < 滑窗 200 —— 不触 FIFO 挤出），
  // 副 key 12 条
  const ledger = new EvidenceLedger();
  for (let i = 0; i < 100; i++) {
    ledger.record({
      key: 'fed.alpha',
      success: i % 3 !== 0,
      margin: -0.9 + (i % 16) * 0.12,
      ts: i,
    });
  }
  for (let i = 0; i < 5; i++) ledger.record({ key: 'fed.alpha', success: i % 2 === 0, ts: 1000 + i });
  for (let i = 0; i < 12; i++) ledger.record({ key: 'fed.beta', success: true, margin: 0.5, ts: i });

  // (a) 确定性：同 seed 两次铸造逐字段一致（含 mintedAt —— now 注入）
  const d1 = mintEvidenceDigest(ledger, { seed: 424242, epsilon: 1, now: () => 123456 })!;
  const d2 = mintEvidenceDigest(ledger, { seed: 424242, epsilon: 1, now: () => 123456 })!;
  assert.ok(d1 && d2, '铸造成功');
  assert.deepStrictEqual(d2, d1, '同 seed 同账本 ⇒ 摘要逐字段一致');
  assert.equal(d1.v, 1, '版本字段 v=1');
  assert.equal(d1.mintedAt, 123456, 'mintedAt 走注入时钟');
  assert.equal(d1.epsilon, 1, 'ε 注记在案');

  // (b) 形状：keys 覆盖两 key；n 是真值（margin-less 条目计入 n）；格子非负整数
  const alpha = d1.keys.find(k => k.key === 'fed.alpha')!;
  const beta = d1.keys.find(k => k.key === 'fed.beta')!;
  assert.ok(alpha && beta, '两 key 皆入摘要');
  assert.equal(alpha.n, 105, 'n = 真值窗口条数（含 5 条无 margin）');
  for (const entry of d1.keys) {
    assert.equal(entry.bins.length, DIGEST_BINS, 'K=8 坨');
    for (const cell of entry.bins) {
      assert.equal(cell.length, 2, '成败两列');
      for (const v of cell) {
        assert.ok(Number.isInteger(v) && v >= 0, '后处理取整非负');
      }
    }
  }

  // (c) 真值对账：直方图坐标正确（clamp/坨宽/成败列），噪声 = noisy − true
  const truth = trueCellsOf(ledger.entries('fed.alpha'));
  assert.equal(truth.n, 105, '镜像算法同口径');
  const alphaCells: number[] = [];
  for (let b = 0; b < DIGEST_BINS; b++) for (let c = 0; c < 2; c++) alphaCells.push(alpha.bins[b][c]);
  const noises = alphaCells.map((v, i) => v - truth.cells[i]);
  // 噪声有界：逐格 |noise| ≤ 12（Laplace scale=1 的尾概率 e^-12 ≈ 6e-6 —— 护栏级），
  // 中位数 ≤ 2（理论 |Laplace(0,1)| 中位 ln2 ≈ 0.69 —— 远小于典型格计数 ~8-17）
  for (const nz of noises) assert.ok(Math.abs(nz) <= 12, `逐格噪声有界（实测 ${nz}）`);
  assert.ok(median(noises.map(Math.abs)) <= 2, `|noise| 中位数远小于典型计数（实测 ${median(noises.map(Math.abs))}）`);

  // (d) 异 seed ⇒ 噪声生效（同一真值、不同噪声流 ⇒ 至少若干格不同）
  const d3 = mintEvidenceDigest(ledger, { seed: 424243, epsilon: 1, now: () => 123456 })!;
  let diffs = 0;
  for (const e2 of d3.keys) {
    const e1 = d1.keys.find(k => k.key === e2.key)!;
    for (let b = 0; b < DIGEST_BINS; b++) for (let c = 0; c < 2; c++) if (e1.bins[b][c] !== e2.bins[b][c]) diffs += 1;
  }
  assert.ok(diffs >= 3, `异 seed ⇒ 至少若干格不同（实测 ${diffs} 格）`);

  // (e) ε 单调性抽查：同 seed（同一 u 流）下 ε 越小噪声越大 —— 尺度 1/ε 线性放大
  const dev = (eps: number): number => {
    const d = mintEvidenceDigest(ledger, { seed: 424242, epsilon: eps, now: () => 123456 })!;
    const a = d.keys.find(k => k.key === 'fed.alpha')!;
    let s = 0;
    for (let b = 0; b < DIGEST_BINS; b++) for (let c = 0; c < 2; c++) s += Math.abs(a.bins[b][c] - truth.cells[b * 2 + c]);
    return s;
  };
  assert.ok(dev(0.1) > dev(1), `ε=0.1 的总偏差 > ε=1（实测 ${dev(0.1)} vs ${dev(1)}）`);
  assert.ok(dev(0.01) > dev(0.1), `ε=0.01 的总偏差 > ε=0.1（实测 ${dev(0.01)} vs ${dev(0.1)}）`);

  // (f) laplaceNoise 纯函数：消毒臂 + 对称臂 + 尺度线性
  assert.equal(laplaceNoise(0, 0.3), 0, 'scale=0 ⇒ 无噪声');
  assert.equal(laplaceNoise(-1, 0.3), 0, 'scale<0 ⇒ 0');
  assert.equal(laplaceNoise(Number.NaN, 0.3), 0, 'scale NaN ⇒ 0');
  assert.ok(laplaceNoise(1, 0.5) === 0, 'u=0.5 ⇒ sign(0)=0 ⇒ 噪声 0');
  assert.ok(Math.abs(laplaceNoise(1, 0.25) + laplaceNoise(1, 0.75)) < 1e-9, 'u 与 1-u ⇒ 噪声严格反号');
  assert.equal(laplaceNoise(2, 0.3), 2 * laplaceNoise(1, 0.3), '尺度线性（Laplace 族）');

  // (g) 垃圾账本视图 ⇒ null（诚实跳过，绝不抛）
  assert.equal(mintEvidenceDigest(null), null, 'null 视图 ⇒ null');
  assert.equal(mintEvidenceDigest({} as never), null, '缺方法视图 ⇒ null');
});

// ─── Μ-2：合并 ───

test('Μ-2: 逐格求和正确；版本错配 ⇒ null；坏格按 0 + skipped 注记', () => {
  const A = new EvidenceLedger();
  for (let i = 0; i < 20; i++) A.record({ key: 'fed.alpha', success: i % 4 !== 0, margin: -0.8 + i * 0.08, ts: i });
  const B = new EvidenceLedger();
  for (let i = 0; i < 15; i++) B.record({ key: 'fed.alpha', success: false, margin: 0.2, ts: i });
  for (let i = 0; i < 10; i++) B.record({ key: 'fed.beta', success: true, margin: -0.4, ts: i });

  const dA = mintEvidenceDigest(A, { seed: 11, now: () => 1000 })!;
  const dB = mintEvidenceDigest(B, { seed: 22, now: () => 2000 })!;
  assert.ok(dA && dB, '两份摘要铸造成功');

  // (a) 逐格求和 + n 求和 + 注记
  const M = mergeDigests([dA, dB])!;
  assert.ok(M, '合并成功');
  assert.equal(M.mergedFrom, 2, 'mergedFrom = 份数');
  assert.equal(M.skipped, 0, '两份铸造摘要无坏格');
  assert.equal(M.mintedAt, 2000, 'mintedAt 取各源最大');
  const aIn = M.keys.find(k => k.key === 'fed.alpha')!;
  const aA = dA.keys.find(k => k.key === 'fed.alpha')!;
  const aB = dB.keys.find(k => k.key === 'fed.alpha')!;
  assert.equal(aIn.n, aA.n + aB.n, 'n 求和（20+15=35）');
  for (let b = 0; b < DIGEST_BINS; b++) {
    for (let c = 0; c < 2; c++) {
      assert.equal(aIn.bins[b][c], aA.bins[b][c] + aB.bins[b][c], `格(${b},${c}) 逐格求和`);
    }
  }
  assert.deepStrictEqual(M.keys.find(k => k.key === 'fed.beta')!, dB.keys.find(k => k.key === 'fed.beta')!, '单源 key 原样并入');

  // (b) 版本错配 ⇒ 整体拒绝合并返回 null
  assert.equal(mergeDigests([{ ...dA, v: 2 }, dB]), null, 'v=2 ⇒ null');
  assert.equal(mergeDigests([dA, { ...dB, v: 999 }]), null, 'v=999 ⇒ null');
  assert.equal(mergeDigests([dA, { mintedAt: 1, epsilon: 1, keys: [] }]), null, 'v 缺席 ⇒ null');
  assert.equal(mergeDigests([]), null, '空数组 ⇒ null');
  assert.equal(mergeDigests('not-array'), null, '非数组 ⇒ null');

  // (c) 坏格按 0 计数 + skipped 注记（NaN / 非数 / 负数 / null 坨 / ±Infinity）
  const bad = {
    v: 1 as const,
    mintedAt: 5,
    epsilon: 1,
    keys: [
      {
        key: 'fed.gamma',
        n: 7,
        bins: [
          [Number.NaN, 1],
          [2, 'bad'],
          [3.5, 2],
          null,
          [1, -2],
          [0, 0],
          [2, Number.POSITIVE_INFINITY],
          [1, 1],
        ] as unknown as number[][],
      },
    ],
  };
  const M2 = mergeDigests([dA, bad])!;
  assert.ok(M2, '含坏格的输入不拒绝整体合并（按格降级）');
  const g = M2.keys.find(k => k.key === 'fed.gamma')!;
  assert.equal(g.n, 7, '合法 n 照常求和');
  assert.equal(g.bins[0][0], 0, 'NaN 格按 0');
  assert.equal(g.bins[1][1], 0, '字符串格按 0');
  assert.equal(g.bins[1][0], 2, '合法格保留');
  assert.equal(g.bins[2][0], 4, '浮点格取整（3.5 ⇒ 4）');
  assert.deepEqual(g.bins[3], [0, 0], 'null 坨两格皆按 0');
  assert.equal(g.bins[4][1], 0, '负数格按 0');
  assert.equal(g.bins[6][0], 2, '同坨合法列不受牵连');
  assert.equal(g.bins[6][1], 0, '+Infinity 格按 0');
  assert.equal(M2.skipped, 6, '坏格注记数 = 6（NaN/bad/null×2/-2/Inf）');
});

// ─── Μ-3：份额上限 + 值不变式 ───

test('Μ-3: 本地 n=10 × share 0.5 ⇒ 掺入 ≤5；零证据 key 零掺入+注记；trust 0.5 折半；registry 逐字节不变；坨反演入账', () => {
  resetKernelRuntime();
  try {
    // 生产注册表登记一颗参数（apply 绝不碰它 —— 值不变式的观测对象）
    kernelRegistry.register({ key: 'fed.share', organ: 'test', defaultValue: 0.5, min: 0, max: 1 });
    const before = kernelRegistry.list();
    const snapBefore = kernelRegistry.snapshot();

    const ledger = new EvidenceLedger();
    for (let i = 0; i < 10; i++) ledger.record({ key: 'fed.share', success: i % 2 === 0, margin: 0.1 * (i - 5), ts: i });

    const merged = {
      v: 1 as const,
      mintedAt: 1,
      epsilon: 1,
      keys: [
        { key: 'fed.share', n: 999, bins: bigBins() }, // 远端洪泛诱饵：16 格 × 100
        { key: 'fed.unseen', n: 50, bins: bigBins() }, // 本地零证据 key
      ],
    };

    // (a) 份额上限：floor(0.5 × 10) = 5 ⇒ 恰 5 条，账本 10 → 15
    const rep = applyFederatedEvidence(ledger, merged, { maxRemoteShare: 0.5, now: () => 777 });
    assert.equal(rep.ok, true, '合法输入 ok');
    assert.equal(rep.applied, 5, '掺入恰 = floor(0.5×10) = 5（远端洪泛滥洪不破闸）');
    assert.equal(ledger.stats('fed.share').n, 15, '本地账本 10 → 15');

    // (b) 零本地证据 key：零掺入 + 诚实注记
    assert.equal(ledger.stats('fed.unseen').n, 0, '本地没见过的 key 零掺入');
    assert.ok(rep.notes.some(nt => nt.includes('fed.unseen') && nt.includes('零证据')), `注记在场（${rep.notes.join('; ')}）`);
    const unseenRow = rep.perKey.find(r => r.key === 'fed.unseen')!;
    assert.equal(unseenRow.reason, 'local-empty', 'reason = local-empty');

    // (c) kernelRegistry 现值逐字节不变（只有账本动了 —— 安全设计：联邦无直达值的写径）
    assert.deepStrictEqual(kernelRegistry.list(), before, 'list() 逐字节不变');
    assert.deepStrictEqual(kernelRegistry.snapshot(), snapBefore, 'snapshot() 逐字节不变');

    // (d) trust = 0.5 再折半：floor(floor(0.5×10) × 0.5) = 2
    const ledger2 = new EvidenceLedger();
    for (let i = 0; i < 10; i++) ledger2.record({ key: 'fed.share', success: true, margin: 0, ts: i });
    const rep2 = applyFederatedEvidence(ledger2, merged, { maxRemoteShare: 0.5, trust: 0.5, now: () => 778 });
    assert.equal(rep2.applied, 2, 'trust=0.5 ⇒ quota 5 → 2');
    assert.equal(rep2.trust, 0.5, '报告回带信任权重');

    // (e) 坨反演：全部质量在 bin0 success 列 ⇒ 掺入 5 条 success=true、margin=-0.875
    const bins0 = Array.from({ length: DIGEST_BINS }, () => [0, 0]);
    bins0[0] = [40, 0];
    const ledger3 = new EvidenceLedger();
    for (let i = 0; i < 10; i++) ledger3.record({ key: 'fed.share', success: false, margin: 0, ts: i });
    const rep3 = applyFederatedEvidence(ledger3, { v: 1, mintedAt: 1, epsilon: 1, keys: [{ key: 'fed.share', n: 40, bins: bins0 }] }, { maxRemoteShare: 0.5, now: () => 779 });
    assert.equal(rep3.applied, 5, 'bin0 success 列全质量 ⇒ 5 条');
    const tail3 = ledger3.entries('fed.share').slice(-5);
    for (const e of tail3) {
      assert.equal(e.success, true, '成败由坨坐标反演（success 列）');
      assert.ok(Math.abs((e.margin ?? Number.NaN) - centerOf(0)) < 1e-12, `margin 取坨中心 ${centerOf(0)}`);
      assert.equal(e.ts, 779, 'ts 走注入时钟');
    }
    // bin7 fail 列 ⇒ success=false、margin=+0.875
    const bins7 = Array.from({ length: DIGEST_BINS }, () => [0, 0]);
    bins7[7] = [0, 40];
    const ledger4 = new EvidenceLedger();
    for (let i = 0; i < 10; i++) ledger4.record({ key: 'fed.share', success: true, margin: 0, ts: i });
    const rep4 = applyFederatedEvidence(ledger4, { v: 1, mintedAt: 1, epsilon: 1, keys: [{ key: 'fed.share', n: 40, bins: bins7 }] }, { maxRemoteShare: 0.5, now: () => 780 });
    assert.equal(rep4.applied, 5, 'bin7 fail 列全质量 ⇒ 5 条');
    for (const e of ledger4.entries('fed.share').slice(-5)) {
      assert.equal(e.success, false, 'fail 列反演为败');
      assert.ok(Math.abs((e.margin ?? Number.NaN) - centerOf(7)) < 1e-12, `margin 取坨中心 ${centerOf(7)}`);
    }

    // (f) 非法输入的诚实拒绝臂：版本错 / 形状坏 / 目标账本坏 ⇒ ok:false 零掺入（不抛）
    assert.equal(applyFederatedEvidence(ledger, { v: 2, mintedAt: 1, epsilon: 1, keys: [] }, {}).ok, false, '版本错 ⇒ 拒绝');
    assert.equal(applyFederatedEvidence(ledger, null, {}).ok, false, 'null 摘要 ⇒ 拒绝');
    assert.equal(applyFederatedEvidence(null, merged, {}).ok, false, 'null 账本 ⇒ 拒绝');
    // 非法 share/trust 回落缺省（0.5 / 信任账）而不抛
    const rep5 = applyFederatedEvidence(new EvidenceLedger(), merged, { maxRemoteShare: Number.NaN, trust: -1, now: () => 781 });
    assert.equal(rep5.ok, true, '非法参数消毒后照常运行（本地零证据 ⇒ 全部零掺入注记）');
    assert.equal(rep5.applied, 0, '空账本 ⇒ 闸① 全拦');
  } finally {
    resetKernelRuntime();
  }
});

// ─── Μ-4：零网络纪律 ───

test('Μ-4: endpoint 空 ⇒ fetch 零调用；endpoint+假 fetch ⇒ POST 发出、响应摘要被应用；失败 ⇒ 消毒降级；挂载门源码取证', async () => {
  resetFederationRuntime();
  try {
    // (a) endpoint='' ⇒ 零网络（spy 必须零调用 —— 连 fetch 引用都不取）
    let calls = 0;
    const spy = (() => {
      calls += 1;
      return Promise.resolve({ json: async () => null });
    }) as unknown as FederationFetch;
    const local = new EvidenceLedger();
    for (let i = 0; i < 5; i++) local.record({ key: 'fed.net', success: true, margin: 0.2, ts: i });
    const res0 = federationSync({ endpoint: '', fetchImpl: spy, ledger: local, now: () => 42 });
    assert.equal(calls, 0, 'endpoint 空 ⇒ fetch 零调用');
    assert.equal(res0.network, 'off', 'network=off');
    assert.equal(res0.ok, true, '本地摘要铸造成功');
    assert.equal(res0.digest?.keys.length, 1, '摘要覆盖 1 key');
    await res0.settled; // resolve 不抛
    assert.equal(lastFederationSync()?.network, 'off', '上次同步记忆 = off');

    // (b) endpoint 设置 + 假 fetch ⇒ POST 发出（方法/头/体=本地摘要）、响应摘要被应用
    resetFederationRuntime();
    const EP = 'https://agg.example/fed';
    const target = new EvidenceLedger();
    for (let i = 0; i < 10; i++) target.record({ key: 'fed.net', success: i % 2 === 0, margin: 0.1 * i - 0.5, ts: i });
    const resp = { v: 1 as const, mintedAt: 2, epsilon: 1, keys: [{ key: 'fed.net', n: 500, bins: bigBins(50) }] };
    const captured: { value: { url: string; method?: string; headers?: Record<string, string>; body?: string } | null } = { value: null };
    const fake = (async (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => {
      captured.value = { url, method: init.method, headers: init.headers, body: init.body };
      return { json: async () => ({ digest: resp }) };
    }) as unknown as FederationFetch;
    const res1 = federationSync({ endpoint: EP, fetchImpl: fake, ledger: target, maxRemoteShare: 0.5, now: () => 42 });
    assert.equal(res1.network, 'fired', 'network=fired');
    await res1.settled;
    assert.ok(captured.value, 'POST 已发出');
    assert.equal(captured.value.url, EP, 'POST 目标 = endpoint');
    assert.equal(captured.value.method, 'POST', '方法 POST');
    assert.equal(captured.value.headers?.['content-type'], 'application/json', 'JSON 头在场');
    assert.equal(captured.value.body, JSON.stringify(res1.digest), '上行载荷 = 本地摘要（摘要外零信息）');
    assert.equal(res1.applied?.applied, 5, '响应合并摘要被应用（floor(0.5×10)=5）');
    assert.equal(target.stats('fed.net').n, 15, '目标账本 10 → 15');
    assert.ok(Math.abs(federationTrustOf(EP) - 1) < 1e-12, '端点即源自动立信任账（初见 trust=1）');

    // (c) 响应垃圾 JSON ⇒ 只上传不掺入，不炸
    const fakeGarbage = (async () => ({ json: async () => ({ hello: 1 }) })) as unknown as FederationFetch;
    const res2 = federationSync({ endpoint: EP, fetchImpl: fakeGarbage, ledger: new EvidenceLedger(), now: () => 43 });
    await res2.settled;
    assert.equal(res2.ok, true, '本地铸造不受响应影响');
    assert.equal(res2.applied, null, '无可用合并摘要 ⇒ 未掺入');

    // (d) fetch 失败 ⇒ 诚实降级不炸；错误消毒（首行、endpoint 脱敏）
    const t3 = new EvidenceLedger();
    for (let i = 0; i < 10; i++) t3.record({ key: 'fed.net', success: true, margin: 0.3, ts: i });
    const boom = new Error(`connect failed at ${EP} upstream\nsecond line should vanish`);
    const fakeFail = (() => Promise.reject(boom)) as unknown as FederationFetch;
    const res3 = federationSync({ endpoint: EP, fetchImpl: fakeFail, ledger: t3, now: () => 44 });
    await res3.settled; // settled 永不 reject
    assert.equal(res3.ok, true, '网络失败不减损本地荣誉（摘要已铸）');
    assert.equal(res3.network, 'failed', 'network=failed');
    assert.equal(res3.digest !== null, true, '本地摘要仍在');
    assert.ok(res3.error?.includes('connect failed'), '消毒后保留首行事实');
    assert.ok(!res3.error?.includes(EP), 'endpoint 原文已脱敏为 <endpoint>');
    assert.ok(!res3.error?.includes('\n'), '只留首行');
    assert.equal(t3.stats('fed.net').n, 10, '账本零污染');

    // (e) 工具面：缺省零网络配置 ⇒ sync 动作诚实 off（用全局账本铸空摘要也可）
    const tool = createFederationSyncTool(fedConfig());
    const out = await runTool(tool, { action: 'sync' });
    assert.equal(out.status, 'SUCCESS', 'sync 在零网络配置下诚实成功');
    assert.equal(out.state_anchor.network, 'off', '锚点 network=off');
    const outDigest = await runTool(tool, { action: 'digest' });
    assert.equal(outDigest.state_anchor.network, 'off', 'digest 动作恒零网络');
    assert.equal(outDigest.state_anchor.digest.v, 1, '预览摘要 v=1');
    const outBad = await runTool(tool, { action: 'explode' });
    assert.equal(outBad.status, 'FAILED', '非法动作 ⇒ 结构化 toolErr（绝不抛）');

    // (f) tools/index.ts 挂载门源码取证（Φ-V / Σ-7⑤ 同法）：两臂条件挂载 + 既有块未动
    const src = readFileSync(new URL('../src/tools/index.ts', import.meta.url), 'utf8');
    assert.match(src, /import \{ createFederationSyncTool \} from '\.\/federationTools';/, '导入行在场');
    assert.match(
      src,
      /if\s*\(config\.kernelEvolutionEnabled \|\| config\.federationEndpoint !== ''\)\s*\{\s*tools\.push\(createFederationSyncTool\(config\)\);/,
      '挂载门 = kernelEvolutionEnabled || federationEndpoint 非空',
    );
    const dashIdx = src.indexOf('tools.push(createMetricsDashboardTool());');
    const fedIdx = src.indexOf('tools.push(createFederationSyncTool(config));');
    const cpIdx = src.indexOf('createSaveCheckpointTool(config)');
    assert.ok(cpIdx >= 0 && cpIdx < dashIdx, '既有 checkpoint → dashboard 顺序未动');
    assert.ok(dashIdx >= 0 && dashIdx < fedIdx, '联邦块在既有 dashboard 块之后另起');
  } finally {
    resetFederationRuntime();
    resetKernelRuntime();
  }
});

// ─── Μ-5：信任账 ───

test('Μ-5: applied 后记一次 regressed ⇒ trust 减半且下次掺入折减；status 动作可见；垃圾入账不抛', async () => {
  resetFederationRuntime();
  try {
    // (a) 初见全信；applied 立账
    recordFederationTrust('peer-a', { applied: 5 });
    assert.equal(federationTrustOf('peer-a'), 1, '初见 trust=1');
    assert.equal(federationTrustOf('stranger'), 1, '未立账源 trust=1');
    assert.equal(federationTrustOf(''), 1, '垃圾 id ⇒ 1（匿名不折减）');

    // (b) 一次 regressed ⇒ 1/(1+1) = 0.5；下次掺入折减 quota 5 → 2
    recordFederationTrust('peer-a', { regressed: 1 });
    assert.equal(federationTrustOf('peer-a'), 0.5, 'trust = 1/(1+regressed) = 1/2');
    const ledger = new EvidenceLedger();
    for (let i = 0; i < 10; i++) ledger.record({ key: 'fed.trust', success: true, margin: 0.1, ts: i });
    const merged = { v: 1 as const, mintedAt: 1, epsilon: 1, keys: [{ key: 'fed.trust', n: 99, bins: bigBins() }] };
    const rep = applyFederatedEvidence(ledger, merged, { maxRemoteShare: 0.5, sourceId: 'peer-a', now: () => 555 });
    assert.equal(rep.trust, 0.5, '默认信任走信任账');
    assert.equal(rep.applied, 2, 'quota floor(5 × 0.5) = 2 —— 信任折减生效');
    const rec = federationTrustReport().find(r => r.sourceId === 'peer-a')!;
    assert.ok(rec, '信任报告含 peer-a');
    assert.equal(rec.applied, 7, 'applied 累账 5 + 2');
    assert.equal(rec.regressed, 1, 'regressed = 1');
    assert.equal(rec.trust, 0.5, '报告 trust = 0.5');

    // (c) 再记一次 ⇒ 1/3（永不归零 —— 留忏悔通道）
    recordFederationTrust('peer-a', { regressed: 1 });
    assert.ok(Math.abs(federationTrustOf('peer-a') - 1 / 3) < 1e-12, 'trust = 1/3');

    // (d) 垃圾入账不抛、不立脏账
    recordFederationTrust('', { applied: 1 });
    recordFederationTrust('junk', { applied: Number.NaN, regressed: -5 });
    assert.equal(federationTrustOf('junk'), 1, 'NaN/-5 增量按 0 ⇒ trust 仍 1');
    assert.equal(federationReportHas(''), false, '空 id 不立账');

    // (e) status 动作可见信任账 + 上次同步结果
    federationSync({ endpoint: '', ledger: new EvidenceLedger(), now: () => 556 }); // 铸一次 off 同步供 status 观察
    const tool = createFederationSyncTool(fedConfig({ kernelEvolutionEnabled: true }));
    const out = await runTool(tool, { action: 'status' });
    assert.equal(out.status, 'SUCCESS', 'status 成功');
    const peer = (out.state_anchor.trust as Array<{ sourceId: string; trust: number }>).find(r => r.sourceId === 'peer-a');
    assert.ok(peer, 'status 可见 peer-a 信任账');
    assert.equal(peer.trust, 1 / 3, 'status 回带最新 trust');
    assert.equal(out.state_anchor.last_sync.network, 'off', 'status 可见上次同步（off）');
    assert.equal(out.state_anchor.config.endpoint, '', '配置镜像在场');
  } finally {
    resetFederationRuntime();
  }
});

/** 报告里是否存在某 sourceId（Μ-5 的空 id 不立账断言） */
function federationReportHas(sourceId: string): boolean {
  return federationTrustReport().some(r => r.sourceId === sourceId);
}

// ─── Μ-6：工具面 robust 投产（D-B6/W6R-A5）── sync 缺省走 Μ2 拜占庭鲁棒臂 ───

test('Μ-6: 工具 sync 缺省 robust（中位数聚合+检疫票折端点信任）；显式 robust:false 回退 Μ 旧行为', async () => {
  resetFederationRuntime();
  resetKernelRuntime();
  const savedFetch = globalThis.fetch;
  try {
    const EP = 'https://agg.example/fed';
    const K = 'fed.tool';
    // 全局账本播种 10 条（工具面用生产单例 evidenceLedger 铸摘要 + 掺入；闸① 需本地有证据）
    for (let i = 0; i < 10; i++) {
      evidenceLedger.record({ key: K, success: i % 2 === 0, margin: 0.1 * i - 0.5, ts: i });
    }
    // 假 fetch（替换全局 fetch —— vlm.integration 同法）：回毒源+诚实源+诚实源
    const poison = { v: 1 as const, mintedAt: 10, epsilon: 1, keys: [{ key: K, n: 1000, bins: bigBins(1000) }] };
    const honest = (): typeof poison => ({ v: 1, mintedAt: 20, epsilon: 1, keys: [{ key: K, n: 50, bins: bigBins(50) }] });
    const captured: { body: string } = { body: '' };
    globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
      captured.body = init.body;
      return { json: async () => ({ digests: [poison, honest(), honest()] }) };
    }) as unknown as typeof fetch;

    // (a) sync 缺省 ⇒ robust:true（D-B6 投产落点）：本地+3 远端 = 4 源偶中位
    const tool = createFederationSyncTool(fedConfig({ kernelEvolutionEnabled: true, federationEndpoint: EP }));
    const out = await runTool(tool, { action: 'sync' });
    assert.equal(out.status, 'SUCCESS', 'sync 成功');
    assert.equal(out.state_anchor.network, 'fired', '网络臂已发');
    assert.equal(captured.body, JSON.stringify(out.state_anchor.digest), '上行载荷 = 本地摘要');
    const rb = out.state_anchor.robust as { method: string; mergedFrom: number; quarantined: Record<string, number> };
    assert.equal(rb.method, 'median', '缺省走鲁棒中位数（生产默认不再是预合并求和）');
    assert.equal(rb.mergedFrom, 4, 'mergedFrom = 本地 + 3 远端');
    assert.equal(rb.quarantined['remote-0'], 16, '毒远端 16 票');
    assert.equal(rb.quarantined['remote-1'], undefined, '诚实远端零票');
    assert.equal(out.state_anchor.applied.trust, 0.25, '检疫票折算端点信任 ⇒ 同轮按 1/4 折减');
    assert.equal(out.state_anchor.applied.applied, 1, 'quota = floor(floor(0.5×10) × 0.25) = 1');
    assert.ok(Math.abs(federationTrustOf(EP) - 0.25) < 1e-12, '端点信任账 1/4（先检疫后掺入）');
    assert.equal(evidenceLedger.stats(K).n, 11, '全局账本 10 → 11');

    // (b) 显式 robust:false ⇒ 回退 Μ 旧行为：预合并 digest 单件直接掺入、结果无 robust 字段
    const EP2 = 'https://legacy.example/fed';
    const K2 = 'fed.tool.legacy';
    for (let i = 0; i < 10; i++) evidenceLedger.record({ key: K2, success: true, margin: 0.2, ts: i });
    const legacyDigest = { v: 1 as const, mintedAt: 5, epsilon: 1, keys: [{ key: K2, n: 500, bins: bigBins(50) }] };
    globalThis.fetch = (async () => ({ json: async () => ({ digest: legacyDigest }) })) as unknown as typeof fetch;
    const tool2 = createFederationSyncTool(fedConfig({ kernelEvolutionEnabled: true, federationEndpoint: EP2 }));
    const out2 = await runTool(tool2, { action: 'sync', robust: false });
    assert.equal(out2.status, 'SUCCESS', 'legacy 回退成功');
    assert.equal(out2.state_anchor.applied.applied, 5, 'legacy：floor(0.5×10)=5（Μ 旧语义）');
    assert.equal(out2.state_anchor.robust, undefined, 'legacy 结果形状无 robust 字段（Μ 旧行为逐字节）');

    // (c) 源码取证（Φ-V 同法）：工具面 robust 缺省投产在源（防回归锁）
    const src = readFileSync(new URL('../src/tools/federationTools.ts', import.meta.url), 'utf8');
    assert.match(src, /robust = robustRaw === false \? false : true/, 'robust 消毒：仅显式 false 才回退（缺省 robust）');
    assert.match(src, /maxRemoteShare: config\.federationMaxRemoteShare,\s*robust,/, 'federationSync 调用实传 robust');
  } finally {
    globalThis.fetch = savedFetch;
    resetFederationRuntime();
    resetKernelRuntime();
  }
});

// ─── Μ-7：信任持久化往返（W6-4 缝包）+ 生产接线取证（W7-0 已闭合 —— 防回归锁） ───

test('Μ-7: 信任账文件往返 —— 记账→原子落盘→跨进程归零→恢复续账→配额执法；生产接线在源', () => {
  resetFederationRuntime();
  const dir = mkdtempSync(path.join(tmpdir(), 'fed-trust-roundtrip-'));
  try {
    const file = path.join(dir, 'federation-trust.json');
    const store = createFederationTrustFileStore(file);

    // (a) 记账 + 武装 + 冲刷（原子写：无 .tmp 残留）
    recordFederationTrust('peer-x', { applied: 7 });
    recordFederationTrust('peer-x', { regressed: 2 });
    assert.equal(armFederationTrustPersistence(store, { flushEvery: 1 }), true, '武装成功');
    assert.equal(federationTrustPersistenceStatus().armed, true, '状态面 armed=true');
    const flushed = flushFederationTrust();
    assert.equal(flushed.ok, true, '落盘 ok');
    assert.equal(flushed.written, 1, '写入 1 条账');
    assert.ok(!existsSync(file + '.tmp'), '原子写无 tmp 残留（tmp+fsync+rename）');
    assert.ok(existsSync(file), '档在场');

    // (b) 跨进程模拟：内存归零（旧世界的信任账在进程退出时蒸发 —— 持久化的立意）
    resetFederationRuntime();
    assert.equal(federationTrustOf('peer-x'), 1, '未恢复前初见全信（跨进程信任归零的旧病）');

    // (c) 恢复：loadFederationTrust 防御读档 ⇒ 信任续账（1/(1+2)=1/3）
    const restored = loadFederationTrust(store);
    assert.equal(restored.restored, 1, '恢复 1 条');
    assert.equal(federationTrustOf('peer-x'), 1 / 3, '恢复后 trust = 1/3（信任跨进程存活）');
    const rec = federationTrustReport().find(r => r.sourceId === 'peer-x')!;
    assert.ok(rec, '报告在场');
    assert.equal(rec.applied, 7, 'applied 续账');
    assert.equal(rec.regressed, 2, 'regressed 续账');

    // (d) 恢复的账在掺入闸执法（regressed=2 ⇒ 配额 5→1）
    const ledger = new EvidenceLedger();
    for (let i = 0; i < 10; i++) ledger.record({ key: 'fed.persist', success: true, margin: 0.2, ts: i });
    const merged = { v: 1 as const, mintedAt: 1, epsilon: 1, keys: [{ key: 'fed.persist', n: 99, bins: bigBins() }] };
    const rep = applyFederatedEvidence(ledger, merged, { maxRemoteShare: 0.5, sourceId: 'peer-x', now: () => 1 });
    assert.equal(rep.trust, 1 / 3, '掺入走恢复账的信任');
    assert.equal(rep.applied, 1, 'quota = floor(5 × 1/3) = 1 —— 恢复的账有牙齿');

    // (e) 生产接线取证（W7-0 在 src/index.ts 的生命周期接线 —— 锁进测试防回归）：
    //     启动恢复 + 武装在初始化，卸载冲账在生命周期收尾
    const entry = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    assert.match(entry, /loadFederationTrust\(trustStore\)/, '启动时防御恢复接线在源');
    assert.match(entry, /armFederationTrustPersistence\(trustStore\)/, '启动时武装原子落盘接线在源');
    assert.match(entry, /flushFederationTrust\(\)/, '卸载时最后冲账接线在源');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetFederationRuntime();
  }
});

// ─── Μ-8：客户端 HMAC 签名头（W6R-A5）── federationSync 的 env 缺省/显式注入面 ───

test('Μ-8: env 缺省零签名头；DSH_FEDERATION_TOKEN 在场自动附双头；authToken 注入优先；null 显式禁用', async () => {
  resetFederationRuntime();
  const prevEnv = process.env[FEDERATION_AUTH_ENV];
  try {
    const EP = 'https://auth.example/fed';
    let capturedHeaders: Record<string, string> | null = null;
    let capturedBody = '';
    const fake = (async (_u: string, init: { headers: Record<string, string>; body: string }) => {
      capturedHeaders = init.headers;
      capturedBody = init.body;
      return { json: async () => ({}) };
    }) as unknown as FederationFetch;

    // (a) env 缺省 ⇒ 零签名头（open 客户端不惊扰 open 服务端 —— 零配置语义）
    delete process.env[FEDERATION_AUTH_ENV];
    const r0 = federationSync({ endpoint: EP, fetchImpl: fake, ledger: new EvidenceLedger(), now: () => 1 });
    await r0.settled;
    assert.equal(capturedHeaders![FEDERATION_AUTH_TIMESTAMP_HEADER], undefined, 'env 缺省 ⇒ 无时间戳头');
    assert.equal(capturedHeaders![FEDERATION_AUTH_SIGNATURE_HEADER], undefined, 'env 缺省 ⇒ 无签名头');
    assert.equal(capturedHeaders!['content-type'], 'application/json', 'JSON 头照常');

    // (b) env 设置 ⇒ 自动读 env 附双头（与权威实现 federationAuthHeaders 逐字段一致）
    process.env[FEDERATION_AUTH_ENV] = 'env-secret';
    const r1 = federationSync({ endpoint: EP, fetchImpl: fake, ledger: new EvidenceLedger(), now: () => 2 });
    await r1.settled;
    assert.deepEqual(
      capturedHeaders,
      { 'content-type': 'application/json', ...federationAuthHeaders(capturedBody, 'env-secret', 2) },
      'env 模式双头与权威实现一致（ts=注入时钟、签名覆盖正文）',
    );

    // (c) authToken 显式注入 ⇒ 优先于 env
    const r2 = federationSync({ endpoint: EP, fetchImpl: fake, ledger: new EvidenceLedger(), authToken: 'injected-secret', now: () => 3 });
    await r2.settled;
    assert.equal(capturedHeaders![FEDERATION_AUTH_TIMESTAMP_HEADER], '3', '注入面：ts = 3');
    assert.equal(
      capturedHeaders![FEDERATION_AUTH_SIGNATURE_HEADER],
      createHmac('sha256', 'injected-secret').update(`3.${capturedBody}`).digest('hex'),
      '注入面：签名 = 权威公式重算一致',
    );

    // (d) authToken:null ⇒ 显式禁用（env 在场也不签 —— 测试/诊断缝）
    const r3 = federationSync({ endpoint: EP, fetchImpl: fake, ledger: new EvidenceLedger(), authToken: null, now: () => 4 });
    await r3.settled;
    assert.equal(capturedHeaders![FEDERATION_AUTH_SIGNATURE_HEADER], undefined, 'null ⇒ 显式不签');
    assert.equal(capturedHeaders!['content-type'], 'application/json', 'JSON 头仍常');

    // (e) 密钥卫生：签名头是派生量 —— 密钥原文绝不进任何头值
    assert.ok(!JSON.stringify(capturedHeaders).includes('env-secret'), 'env 密钥不入头');
    assert.ok(!JSON.stringify(capturedHeaders).includes('injected-secret'), '注入密钥不入头');
  } finally {
    if (prevEnv === undefined) delete process.env[FEDERATION_AUTH_ENV];
    else process.env[FEDERATION_AUTH_ENV] = prevEnv;
    resetFederationRuntime();
  }
});

// ─── 附：KernelRegistry/EvidenceLedger 增量导出的既有语义零回归（纯增量立法的旁证） ───

test('Μ-0 附: EvidenceLedger.entries 防御副本 + KernelRegistry 结构性满足联邦视图（纯增量导出不触既有路径）', () => {
  const ledger = new EvidenceLedger();
  ledger.record({ key: 'k', success: true, margin: 0.25, ts: 1 });
  ledger.record({ key: 'k', success: false, ts: 2 });
  const es = ledger.entries('k');
  assert.equal(es.length, 2, '窗口两条');
  assert.equal(es[0].success, true, '旧 → 新保序');
  assert.deepEqual(es.map(e => e.margin), [0.25, undefined], '无 margin 条目保持 undefined');
  es[0].success = false; // 篡改副本
  assert.equal(ledger.entries('k')[0].success, true, '防御副本：篡改不穿透账本');
  assert.deepEqual(ledger.entries('nope'), [], '未知 key ⇒ 空数组');
  // 联邦视图的结构性满足（TS 层由 tsc 执法；此处运行时再证一次）
  const view: { keys(): string[]; entries(k: string): ReadonlyArray<{ success: boolean; margin?: number }> } = ledger;
  assert.deepEqual(view.keys(), ['k'], 'keys() 同源');
  const registry = new KernelRegistry();
  registry.register({ key: 'k', organ: 't', defaultValue: 1, min: 0, max: 2 });
  assert.equal(registry.get('k'), 1, 'KernelRegistry 既有路径如常');
});
