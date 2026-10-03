// src/federation/aggregate.ts
// 纪元 Μ2（拜占庭鲁棒联邦聚合 —— Μ 的加固续笔）：secure aggregation 的经典弱点是
// 「合并 = 朴素求和」—— 一个恶意/故障宿主灌一格毒，就能把全网校准水位拉开。本模块
// 把合并算子从求和升级为逐格**鲁棒统计量**，并给「离群」装上牙齿：
//   · 逐格中位数（≥3 源）代替求和：k 个坏源 < 一半时，毒被结构性隔离（中位数对
//     <50% 的任意篡改有精确的崩溃点 —— Byzantine-robust aggregation 的教科书律）；
//     偶数源取中间两数均值；=2 源退化为均值（诚实注记：无鲁棒性）；=1 源直通；
//   · 离群检疫：某源在某格与鲁棒值的偏差超阈（缺省阈 = max(3, 2×该 key 16 格鲁棒
//     值的四分位距 —— 格间离散度的自适应尺度，地板 3 容忍 DP 噪声）⇒ 该源该格计
//     1 票 quarantine；票经 applyQuarantineToTrust 折算 regressed 事件喂 Μ 的
//     信任账（每 5 票 1 次）—— 检疫结果有牙齿，不只是注记；
//   · 贡献份额帽（contributionCap）：单源每格贡献封顶 capShare×鲁棒值（先帽后并，
//     防洪泛）—— 与鲁棒合并正交：给 Μ 的旧求和路径（mergeDigests）也提供防洪闸。
// 全部纯函数、确定性（同输入同输出，零随机源）、永不抛（坏源按缺席处理并注记 ——
// 拜占庭容错第一律：一个坏源只能缺席，不能否决全网合并）。
//
// 口径声明（双实现面）：
//   · 本模块对主模块（./index）只有 **import type**（编译期擦除，零运行时环引）；
//     schema 形状字面量（版本 1 / K=8 坨）是主模块常量的本地镜像 —— 与 scripts/
//     federation-server.mjs 的 JS 移植合为三处同律实现，漂移由
//     test/epochMu2.aggregate.test.ts 的行为断言与端到端等价断言把守；
//   · 核心以 TS 测试为准；坏格消毒律（NaN/非数/负数/形状错 ⇒ 缺席）与 mergeDigests
//     同律 —— 聚合器不因单格脏数据丢弃整份贡献，也不假装它是合法值。
// 运行层永不抛异常（鲁棒聚合是联邦旁路的加固件：失败 = 诚实空手，绝不炸宿主）。

import type { EvidenceDigest, EvidenceDigestKeyEntry, MergedEvidenceDigest } from './index';

// ─── schema 形状字面量（主模块 DIGEST_VERSION/DIGEST_BINS 的镜像 —— 见口径声明） ───

/** 与 index.ts 的 DIGEST_VERSION 同值：v≠1 的源按缺席处理（版本错配是源级事件，不是全网事件） */
const AGG_DIGEST_VERSION = 1;

/** 与 index.ts 的 DIGEST_BINS 同值：K=8 坨 × 成败两列 = 每 key 16 格 */
const AGG_DIGEST_BINS = 8;

/** ε 缺省镜像（各源 ε 全部非法/缺席时的保守申报 —— 与 index.ts DEFAULT_FEDERATION_EPSILON 同律） */
const AGG_DEFAULT_EPSILON = 1;

// ─── 检疫与份额帽的算法常量（形状字面量 —— 非旋钮） ───

/** 离群阈地板：|源值−鲁棒值| ≤ 3 恒不检疫（ε=1 的 Laplace 噪声中位 |noise|≈0.69、P(|noise|>3)≈5% —— DP 噪声容限） */
export const OUTLIER_FLOOR = 3;

/** 离群阈的格间尺度：T = max(OUTLIER_FLOOR, OUTLIER_IQR_SCALE × 该 key 16 格鲁棒值的 IQR) */
export const OUTLIER_IQR_SCALE = 2;

/** 检疫票折算律：每 5 票 = 1 次 regressed（喂 Μ 信任账 1/(1+regressed)）—— 单票噪声不立脏账 */
export const QUARANTINE_VOTES_PER_REGRESSED = 5;

/** 贡献份额帽缺省：单源每格 ≤ 2×鲁棒值（「至多是共识的两倍」—— 诚实源坐在共识上永不被削） */
export const DEFAULT_CONTRIBUTION_CAP_SHARE = 2;

// ─── 数值消毒（主模块 numOr/cleanCell 同律的本地镜像 —— 零依赖纪律） ───

/** 数值护栏：x 非有限或越界 ⇒ 缺省 */
function numOr(x: number | undefined, dflt: number, min: number, max: number): number {
  return typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max ? x : dflt;
}

/** 单格消毒：有限、非负的数值 ⇒ 四舍五入整数；其余（NaN/±Inf/负数/非数）⇒ null（按缺席计） */
function cleanCell(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

/** 全零坨矩阵（K × [success, fail]）—— 聚合的初始画布 */
function zeroBins(): number[][] {
  return Array.from({ length: AGG_DIGEST_BINS }, () => [0, 0]);
}

// ─── 鲁棒统计原语（纯函数、确定性） ───

/**
 * 中位数：奇数取正中；偶数取中间两数均值再取整（计数语义 —— Math.round 确定性，
 * 0.5 恒向上）。=2 个值时即「均值」（中间两数就是全部）—— 与任务书「=2 ⇒ 均值」
 * 同一实现，方法标签按源数另行区分。
 */
function medianOf(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * 四分位距（线性插值四分位 —— numpy 默认口径）：格间离散度的鲁棒尺度估计，
 * 中位同级 breakdown（50%）—— 用它定检疫阈 ⇒ 毒源拉不动阈（毒已被中位数隔离，
 * 鲁棒值本身干净）。空集 ⇒ 0。
 * W4-2（G3 策略联邦）：导出为统计原子 —— src/skillFederation.ts 的技能参数
 * 分布聚合同律复用（零拷贝同一实现，检疫口径全网一致）。
 */
export function iqrOf(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number): number => {
    const idx = p * (s.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  };
  return q(0.75) - q(0.25);
}

/** 逐格鲁棒值：0 源 ⇒ 0；1 源 ⇒ 直通；≥2 源 ⇒ 中位数（=2 亦即均值，见 medianOf） */
function robustOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];
  return medianOf(values);
}

/** 源数 → 方法标签（k≥3 中位数 / k=2 均值 / k=1 直通 / k=0 无） */
function methodOfCount(k: number): 'median' | 'mean' | 'single' | 'none' {
  return k >= 3 ? 'median' : k === 2 ? 'mean' : k === 1 ? 'single' : 'none';
}

/** 该方法标签的诚实中文注记（mean/single 的无鲁棒性声明是测试面） */
function methodNote(m: 'median' | 'mean' | 'single' | 'none'): string {
  switch (m) {
    case 'mean':
      return '源数=2 ⇒ 逐格均值（诚实注记：无鲁棒性 —— 任一源可拉动半程，毒源未过半时仍是可用的过渡态）';
    case 'single':
      return '源数=1 ⇒ 直通（无聚合 —— 单源即全网）';
    default:
      return '';
  }
}

// ─── Μ2-a 源甄别（拜占庭容错第一律的落点） ───

/** 甄别后的有效源（i = 在输入数组中的原序号 —— 检疫票与缺席注记的坐标） */
interface ValidSource {
  i: number;
  d: EvidenceDigest;
}

/**
 * 源资格甄别（纯函数、永不抛、含单源 try 隔离）：对象形状 + v=1 + keys 是数组。
 * 坏源（含访问即抛的陷阱属性）⇒ 按缺席处理，绝不牵连其余源 —— 与 mergeDigests
 * 的「版本错配整体拒绝」律相对：鲁棒路径里一个坏源只能缺席，不能否决合并。
 */
function validSourcesOf(digests: readonly unknown[]): { valid: ValidSource[]; excluded: number[] } {
  const valid: ValidSource[] = [];
  const excluded: number[] = [];
  digests.forEach((d, i) => {
    try {
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('shape');
      const dd = d as Partial<EvidenceDigest>;
      if (dd.v !== AGG_DIGEST_VERSION || !Array.isArray(dd.keys)) throw new Error('schema');
      valid.push({ i, d: dd as EvidenceDigest });
    } catch {
      excluded.push(i); // 坏源按缺席处理（注记坐标 = 原序号）
    }
  });
  return { valid, excluded };
}

/** 源命名：sourceIds[i] 是非空字符串 ⇒ 用之；否则用序号字符串（信任账键与检疫票键同源） */
function labelOf(sourceIds: readonly unknown[], i: number): string {
  const s = sourceIds[i];
  return typeof s === 'string' && s !== '' ? s : String(i);
}

// ─── Μ2-b 鲁棒合并：robustMergeDigests ───

/** 鲁棒合并选项（阈值/源命名可注入 —— 确定性测试的完整缝） */
export interface RobustMergeOptions {
  /**
   * 逐格离群检疫阈：|源值−鲁棒值| > T ⇒ 该源该格计 1 票。缺席/非法（非有限或 <0）
   * ⇒ 自适应 T = max(OUTLIER_FLOOR, OUTLIER_IQR_SCALE × 该 key 16 格鲁棒值的 IQR)。
   */
  outlierThreshold?: number;
  /** 源命名表（与 digests 平行；缺席 ⇒ 用源序号字符串）—— quarantine 票键与信任账键同源 */
  sourceIds?: string[];
}

/** 鲁棒合并结果：merged（可直接喂 applyFederatedEvidence）+ 检疫票 + 方法 + 缺席注记 */
export interface RobustMergeResult {
  /** 合并摘要（v=1 形状；0 有效源 ⇒ null —— 诚实空手，绝不抛） */
  merged: MergedEvidenceDigest | null;
  /** 源标签 → 该源的 quarantine 票数（逐格计票：一格一票） */
  quarantined: Record<string, number>;
  /** 全局方法（按有效源数；逐 key 源数不同的偏差在 notes 里注记） */
  method: 'median' | 'mean' | 'single' | 'none';
  /** 坏源（形状坏/版本错配/陷阱属性）按缺席处理的原序号表 */
  excluded: number[];
  /** 诚实注记（方法声明 / 逐 key 方法偏差 / 检疫概览） */
  notes: string[];
}

/**
 * 拜占庭鲁棒合并（纯函数、确定性、绝不抛）：
 *   · 源甄别：坏源按缺席处理并注记（excluded）—— 不否决全网合并；
 *   · 逐 key 收集（首现序）：每源每格消毒后的值进入该格的贡献表（坏格缺席 + skipped）；
 *   · 逐格聚合：k≥3 中位数（偶数取中间均值）、k=2 均值、k=1 直通 —— 毒源 < 一半时
 *     被结构性隔离（中位数的 50% 崩溃点）；
 *   · 逐格检疫：|源值−鲁棒值| > T ⇒ 该源该格 1 票（T 见 RobustMergeOptions）；
 *   · n 亦按同律取鲁棒值（真值规模的诚实注记，非求和 —— 求和会被洪泛拉爆）；
 *   · mintedAt 取各源最大、epsilon 取各源最小（与 mergeDigests 同律的保守账）。
 */
export function robustMergeDigests(digests: unknown, opts?: RobustMergeOptions): RobustMergeResult {
  try {
    if (!Array.isArray(digests) || digests.length === 0) {
      return { merged: null, quarantined: {}, method: 'none', excluded: [], notes: ['输入非数组或为空：无可合并源（诚实空手）'] };
    }
    const { valid, excluded } = validSourcesOf(digests);
    if (valid.length === 0) {
      return { merged: null, quarantined: {}, method: 'none', excluded, notes: ['零有效源：坏源全部按缺席处理后无可合并者'] };
    }
    const sourceIds = Array.isArray(opts?.sourceIds) ? (opts?.sourceIds as unknown[]) : [];

    // 逐 key 收集：cells[bin][col] = 该格的贡献表（源序号 + 消毒值；坏格缺席）
    interface KeyAgg {
      sources: Set<number>;
      nValues: number[];
      cells: Array<Array<Array<{ i: number; v: number }>>>;
    }
    const keyMap = new Map<string, KeyAgg>();
    let skipped = 0;
    let mintedAt = 0;
    let minEps: number | null = null;
    for (const { i, d } of valid) {
      if (typeof d.mintedAt === 'number' && Number.isFinite(d.mintedAt) && d.mintedAt > mintedAt) mintedAt = d.mintedAt;
      if (typeof d.epsilon === 'number' && Number.isFinite(d.epsilon) && d.epsilon > 0) {
        minEps = minEps === null ? d.epsilon : Math.min(minEps, d.epsilon);
      }
      for (const rawEntry of d.keys) {
        try {
          if (!rawEntry || typeof rawEntry !== 'object') {
            skipped += AGG_DIGEST_BINS * 2; // 整条坏：按全格坏注记（粒度与 mergeDigests 统一为格）
            continue;
          }
          const e = rawEntry as Partial<EvidenceDigestKeyEntry>;
          if (typeof e.key !== 'string' || e.key === '') {
            skipped += AGG_DIGEST_BINS * 2; // 无主条目：同上按全格坏注记
            continue;
          }
          let agg = keyMap.get(e.key);
          if (!agg) {
            agg = {
              sources: new Set<number>(),
              nValues: [],
              cells: Array.from({ length: AGG_DIGEST_BINS }, () => [[], []]),
            };
            keyMap.set(e.key, agg);
          }
          agg.sources.add(i);
          const nClean = cleanCell(e.n);
          if (nClean !== null) agg.nValues.push(nClean);
          else skipped += 1; // 坏 n 按缺席计注记
          const bins = Array.isArray(e.bins) ? e.bins : [];
          for (let b = 0; b < AGG_DIGEST_BINS; b++) {
            const cell = bins[b];
            for (let col = 0; col < 2; col++) {
              const v = cleanCell(Array.isArray(cell) ? cell[col] : undefined);
              if (v !== null) agg.cells[b][col].push({ i, v });
              else skipped += 1; // 坏格按缺席（不参与中位数、不参与检疫 —— 垃圾没有离群资格）
            }
          }
        } catch {
          skipped += AGG_DIGEST_BINS * 2; // 单条读取故障（陷阱属性等）：按整条坏注记，其余条目不受牵连
        }
      }
    }

    const method = methodOfCount(valid.length);
    const notes: string[] = [];
    const mn = methodNote(method);
    if (mn !== '') notes.push(mn);

    const explicitT =
      typeof opts?.outlierThreshold === 'number' && Number.isFinite(opts.outlierThreshold) && opts.outlierThreshold >= 0
        ? opts.outlierThreshold
        : null;
    const quarantined: Record<string, number> = {};
    const outKeys: Array<{ key: string; n: number; bins: number[][] }> = [];

    for (const [key, agg] of keyMap) {
      // 先算该 key 的 16 格鲁棒值（聚合与检疫阈共用 —— 阈基于鲁棒值 ⇒ 毒源拉不动阈）
      const robustCells: number[] = [];
      for (let b = 0; b < AGG_DIGEST_BINS; b++) {
        for (let col = 0; col < 2; col++) robustCells.push(robustOf(agg.cells[b][col].map(c => c.v)));
      }
      const T = explicitT !== null ? explicitT : Math.max(OUTLIER_FLOOR, OUTLIER_IQR_SCALE * iqrOf(robustCells));
      // 逐 key 方法与全局不同 ⇒ 诚实注记（该 key 只有 fewer 源在场）
      const kMethod = methodOfCount(agg.sources.size);
      if (kMethod !== method) {
        notes.push(`key「${key}」仅 ${agg.sources.size} 源在场 ⇒ 该 key 用 ${kMethod === 'mean' ? '均值（无鲁棒性）' : kMethod === 'single' ? '直通' : kMethod}`);
      }
      const bins = zeroBins();
      for (let b = 0; b < AGG_DIGEST_BINS; b++) {
        for (let col = 0; col < 2; col++) {
          const r = robustCells[b * 2 + col];
          bins[b][col] = r;
          for (const { i, v } of agg.cells[b][col]) {
            if (Math.abs(v - r) > T) {
              const label = labelOf(sourceIds, i);
              quarantined[label] = (quarantined[label] ?? 0) + 1;
            }
          }
        }
      }
      outKeys.push({ key, n: robustOf(agg.nValues), bins });
    }
    const voteTotal = Object.values(quarantined).reduce((s, v) => s + v, 0);
    if (voteTotal > 0) {
      notes.push(`离群检疫共 ${voteTotal} 票（每 ${QUARANTINE_VOTES_PER_REGRESSED} 票经 applyQuarantineToTrust 折算 1 次 regressed —— 检疫有牙齿）`);
    }

    const merged: MergedEvidenceDigest = {
      v: AGG_DIGEST_VERSION,
      mintedAt,
      epsilon: minEps ?? AGG_DEFAULT_EPSILON,
      keys: outKeys,
      mergedFrom: valid.length, // 实际参与者数（坏源已缺席 —— excluded 另记）
      skipped,
    };
    return { merged, quarantined, method, excluded, notes };
  } catch {
    return { merged: null, quarantined: {}, method: 'none', excluded: [], notes: ['鲁棒合并过程异常：诚实空手（绝不炸宿主）'] };
  }
}

// ─── Μ2-c 检疫折算：applyQuarantineToTrust ───

/** 折算报告条目：源 id + 票数 + 实际入账的 regressed 事件数 */
export interface QuarantineTrustReportEntry {
  sourceId: string;
  votes: number;
  regressed: number;
}

/**
 * 检疫票折算信任账（纯函数、绝不抛）：每 QUARANTINE_VOTES_PER_REGRESSED 票折算
 * 1 次 regressed，经注入的记账函数（recordFederationTrust —— 依赖注入以避免对主
 * 模块的运行时环引）喂 Μ 的信任账（trust = 1/(1+regressed)）。
 *   · 票数不足 5（DP 噪声容限）⇒ 不立脏账（0 事件）；
 *   · 记账函数缺席/单源记账故障 ⇒ 跳过该源，其余照记；
 *   · 返回按 sourceId 字典序的折算报告（可观察面）。
 * 消费语义：检疫的牙齿长在信任账上 —— 折算后该源的下次掺入配额按 1/(1+regressed)
 * 折减（applyFederatedEvidence 闸③），本地 calibrator 的值执法不受任何影响。
 */
export function applyQuarantineToTrust(
  quarantined: Record<string, number> | null | undefined,
  recordFederationTrust: ((sourceId: string, delta: { applied?: number; regressed?: number }) => void) | null | undefined,
): QuarantineTrustReportEntry[] {
  try {
    if (!quarantined || typeof quarantined !== 'object' || Array.isArray(quarantined)) return [];
    if (typeof recordFederationTrust !== 'function') return [];
    const report: QuarantineTrustReportEntry[] = [];
    for (const [sourceId, rawVotes] of Object.entries(quarantined)) {
      const votes = typeof rawVotes === 'number' && Number.isFinite(rawVotes) && rawVotes > 0 ? Math.floor(rawVotes) : 0;
      const events = Math.floor(votes / QUARANTINE_VOTES_PER_REGRESSED);
      if (events <= 0) continue; // 不足 5 票：噪声容限 —— 不立脏账
      try {
        recordFederationTrust(sourceId, { regressed: events });
      } catch {
        continue; // 单源记账故障：跳过该源，绝不抛
      }
      report.push({ sourceId, votes, regressed: events });
    }
    report.sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1));
    return report;
  } catch {
    return [];
  }
}

// ─── Μ2-d 贡献份额帽：contributionCap ───

/** 份额帽结果：帽后的防御副本源表 + 被封顶格数 + 缺席注记 */
export interface ContributionCapResult {
  /** 帽后（且坏格消毒为 0）的源摘要防御副本 —— 原输入不可变（纯函数纪律） */
  digests: EvidenceDigest[];
  /** 实际被封顶的格数（防洪泛的可观察面） */
  capped: number;
  /** 坏源（形状坏/版本错配）按缺席处理的原序号表 */
  excluded: number[];
  notes: string[];
}

/**
 * 贡献份额帽（纯函数、确定性、永不抛）：单源每格贡献封顶 capShare×该格鲁棒值
 * （先帽后并 —— 帽后的源表喂给任意合并器：robustMergeDigests 或 Μ 的 mergeDigests
 * 都吃得下）。capShare 消毒到 [1, 1e9]、缺省 2（「至多是共识的两倍」—— 域 <1 会
 * 削平坐在共识上的诚实源，按非法抬回缺省）。鲁棒值口径与 robustMergeDigests 同律
 * （k≥3 中位数 / =2 均值 / =1 直通）⇒ 单源场景永不封顶（v ≤ 2v 恒真）。
 * 坏源按缺席处理（excluded）；坏格消毒为 0 并注记（缺席与 0 在帽面同效，但输出
 * 面必须是干净形状 —— 下游合并器不该再吃垃圾）。
 */
export function contributionCap(digests: unknown, capShare?: number): ContributionCapResult {
  try {
    const cap = numOr(capShare, DEFAULT_CONTRIBUTION_CAP_SHARE, 1, 1e9);
    if (!Array.isArray(digests) || digests.length === 0) {
      return { digests: [], capped: 0, excluded: [], notes: ['输入非数组或为空：无源可帽（诚实空手）'] };
    }
    const { valid, excluded } = validSourcesOf(digests);
    const notes: string[] = [];
    if (valid.length === 0) {
      return { digests: [], capped: 0, excluded, notes: ['零有效源：坏源全部按缺席处理后无源可帽'] };
    }

    // 逐 key 收集（与 robustMergeDigests 同构 —— 帽的基准是同一鲁棒值）
    interface KeyCells {
      cells: Array<Array<Array<{ i: number; v: number }>>>;
    }
    const keyMap = new Map<string, KeyCells>();
    let sanitizedCells = 0;
    for (const { i, d } of valid) {
      for (const rawEntry of d.keys) {
        try {
          if (!rawEntry || typeof rawEntry !== 'object') continue; // 整条坏：缺席（不进帽基准也不进输出）
          const e = rawEntry as Partial<EvidenceDigestKeyEntry>;
          if (typeof e.key !== 'string' || e.key === '') continue;
          let kc = keyMap.get(e.key);
          if (!kc) {
            kc = { cells: Array.from({ length: AGG_DIGEST_BINS }, () => [[], []]) };
            keyMap.set(e.key, kc);
          }
          const bins = Array.isArray(e.bins) ? e.bins : [];
          for (let b = 0; b < AGG_DIGEST_BINS; b++) {
            const cell = bins[b];
            for (let col = 0; col < 2; col++) {
              const v = cleanCell(Array.isArray(cell) ? cell[col] : undefined);
              if (v !== null) kc.cells[b][col].push({ i, v });
              else sanitizedCells += 1; // 坏格：缺席于帽基准，输出面消毒为 0
            }
          }
        } catch {
          continue; // 单条读取故障：该条缺席，其余不受牵连
        }
      }
    }

    // 逐 key 逐格：帽 = floor(capShare × 鲁棒值)；v > 帽 ⇒ 削到帽（floor 保证削后不越帽）
    const capOf = new Map<string, number[]>(); // key → 16 格帽值
    for (const [key, kc] of keyMap) {
      const caps: number[] = [];
      for (let b = 0; b < AGG_DIGEST_BINS; b++) {
        for (let col = 0; col < 2; col++) {
          caps.push(Math.floor(cap * robustOf(kc.cells[b][col].map(c => c.v))));
        }
      }
      capOf.set(key, caps);
    }

    // 输出防御副本：原值 ≤ 帽 ⇒ 保真；> 帽 ⇒ 封顶；坏格 ⇒ 0（消毒注记）
    let capped = 0;
    const out: EvidenceDigest[] = valid.map(({ d }) => {
      const keys = d.keys
        .filter((rawEntry): rawEntry is EvidenceDigestKeyEntry => {
          try {
            return !!rawEntry && typeof rawEntry === 'object' && typeof (rawEntry as Partial<EvidenceDigestKeyEntry>).key === 'string' &&
              (rawEntry as Partial<EvidenceDigestKeyEntry>).key !== '';
          } catch {
            return false;
          }
        })
        .map(e => {
          const caps = capOf.get(e.key);
          const bins = zeroBins();
          const inBins = Array.isArray(e.bins) ? e.bins : [];
          for (let b = 0; b < AGG_DIGEST_BINS; b++) {
            const cell = inBins[b];
            for (let col = 0; col < 2; col++) {
              const v = cleanCell(Array.isArray(cell) ? cell[col] : undefined);
              const capV = caps ? caps[b * 2 + col] : Number.POSITIVE_INFINITY; // 帽基准缺席（防御臂）：不帽
              const clamped = v === null ? 0 : Math.min(v, capV);
              if (v !== null && clamped < v) capped += 1;
              bins[b][col] = clamped;
            }
          }
          const nClean = cleanCell(e.n);
          return { key: e.key, n: nClean ?? 0, bins };
        });
      return {
        v: AGG_DIGEST_VERSION,
        mintedAt: typeof d.mintedAt === 'number' && Number.isFinite(d.mintedAt) ? d.mintedAt : 0,
        epsilon: typeof d.epsilon === 'number' && Number.isFinite(d.epsilon) && d.epsilon > 0 ? d.epsilon : AGG_DEFAULT_EPSILON,
        keys,
      };
    });
    if (sanitizedCells > 0) notes.push(`坏格消毒为 0 共 ${sanitizedCells} 格（缺席于帽基准，输出面消毒）`);
    if (excluded.length > 0) notes.push(`坏源按缺席处理：${excluded.join(', ')}（序号）`);
    if (capped > 0) notes.push(`贡献份额帽：${capped} 格被封顶到 ≤ ${cap}×鲁棒值（先帽后并 —— 防洪泛）`);
    return { digests: out, capped, excluded, notes };
  } catch {
    return { digests: [], capped: 0, excluded: [], notes: ['份额帽过程异常：诚实空手（绝不炸宿主）'] };
  }
}
