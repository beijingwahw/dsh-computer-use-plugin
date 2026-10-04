// src/federation/apply.ts
// W9-3（D-F4 拆分·掺入分区）：自 federation/index.ts 低风险提取 —— Μ-d 掺入
// applyFederatedEvidence（三道闸配额决算：本地非空/份额上限/信任折减；绝不写
// kernelRegistry 值）。逐字节搬运（零逻辑变更）；index.ts 原位再导出 —— 导入面
// 不变（消费方零改动）。
// ΝΩ-20（掺入统计修正）：掺入条目的 margin 不再取坨中心常量（旧律把远端 DP
// 噪声后的量化中心当真值灌进本地校准 —— 分布形状被坍缩成 8 个原子点），改在坨宽
// 内均匀抖动恢复分布形状；ts 不再全批共享同一时钟，改按源摘要 mintedAt 邻域
// （±APPLY_TS_SCATTER_MS）散布；抖动 rng 用确定性种子派生自记录坐标（源
// mintedAt + key + 坨 + 列 + 记录序号）。配额决算三道闸与信任账语义零变化。
import {
  DIGEST_VERSION, DIGEST_BINS, DIGEST_MARGIN_CLIP, DEFAULT_MAX_REMOTE_SHARE,
  numOr, binCenter, cleanCell, mulberry32, fnv1a32,
  type EvidenceDigest, type EvidenceDigestKeyEntry,
} from './digest';
import { federationTrustOf, recordFederationTrust } from './trust';

/**
 * ΝΩ-20：掺入记录 ts 的散布半径（源摘要 mintedAt ± 5 分钟 —— 常量冻结）。
 * 旧律全批共享同一 ts，把「远端一段时间的活动」坍缩成账本里的同时脉冲；散布回
 * mintedAt 邻域恢复时间分布形状（掺入证据本就代表源端铸造时刻前后的活动）。
 */
export const APPLY_TS_SCATTER_MS = 5 * 60_000;

// ─── Μ-d 掺入：applyFederatedEvidence ───

/**
 * 掺入目标账本（结构化最小面 —— EvidenceLedger 结构性满足）。origin 是
 * ΑΩ-R41 的 provenance 缝：掺入路径逐条打 'federation'（缺省缺席 = local 既有
 * 语义）；来源纪要（sourceId 计数汇总）不进记录 —— 只打布尔级来源，避免膨胀
 * （来源明细在 FederatedApplyReport.perKey 与信任账的既有审计面）。
 */
export interface FederationLedgerTarget {
  record(outcome: { key: string; success: boolean; margin?: number; ts: number; origin?: 'local' | 'federation' }): void;
  stats(key: string): { n: number };
}

/** 掺入选项 */
export interface ApplyFederatedEvidenceOptions {
  /** 远端份额上限 ∈ [0,1]（非法回落 0.5）：每 key 掺入条数 ≤ floor(share × 本地 n) */
  maxRemoteShare?: number;
  /** 信任权重 ∈ (0,1]（非法 ⇒ 回落 sourceId 信任账 / 1）—— 再折减掺入条数 */
  trust?: number;
  /** 摘要来源 id（缺省匿名：不查信任账、不记 applied；federationSync 缺省用 endpoint） */
  sourceId?: string;
  /** 时钟注入（ΝΩ-20 后仅作 ts 散布邻域的降级源：源摘要 mintedAt 非法时用；缺省 Date.now） */
  now?: () => number;
}

/** 掺入报告：诚实全量注记（每 key 的配额决算 + 跳过原因） */
export interface FederatedApplyReport {
  /** false 仅当输入摘要/目标账本非法；「合法但零掺入」是 ok:true + notes 注记 */
  ok: boolean;
  /** 实际入账条数（≤ Σ quota ≤ Σ cap —— 份额上限的全局面） */
  applied: number;
  /** 本轮使用的信任权重（审计面） */
  trust: number;
  perKey: Array<{ key: string; localN: number; cap: number; quota: number; injected: number; reason: string }>;
  /** 跳过注记（零本地证据 / 零份额 / 零坨质量 / 信任折没 …） */
  notes: string[];
}

/**
 * 整数配额按坨质量成比例分配（最大余数法，纯函数、确定性）：quota 条按 16 格的
 * 质量占比分摊，整数化余数按「小数部分大者优先、平票按格序（坨↑、success 先于
 * fail）」逐格补 1 —— 掺入样本保形于远端分布，不因取整偏聚某坨。
 */
function allocateQuota(quota: number, cells: readonly number[]): number[] {
  const total = cells.reduce((s, c) => s + c, 0);
  if (total <= 0) return cells.map(() => 0);
  const exact = cells.map(c => (quota * c) / total);
  const base = exact.map(v => Math.floor(v));
  let left = quota - base.reduce((s, v) => s + v, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    base[o.i] += 1;
    left -= 1;
  }
  return base;
}

/**
 * ΝΩ-20：掺入记录的确定性抖动种子 —— 派生自记录坐标（源 mintedAt、key、坨 b、
 * 列 col、批内记录序号 i）。同摘要同坐标 ⇒ 同抖动（确定性可测）；不同记录坐标
 * 天然异种（坨内不恒等的分布形状恢复基础）。纯函数。
 */
function jitterSeed(srcMintedAt: number, key: string, b: number, col: number, i: number): number {
  return fnv1a32(0x4e095a2d, `${srcMintedAt}|${key}|${b}|${col}|${i}`);
}

/**
 * ΝΩ-20：掺入 margin —— 坨中心 + 坨宽内均匀抖动（恢复分布形状）。坨 b 的覆盖
 * 区间是 [左缘, 左缘+坨宽]，均匀抖动使同坨的掺入条目不再坍缩成坨中心一个原子值
 * —— 远端摘要只保留到坨分辨率，抖动是该分辨率内的诚实再散布（不发明坨外信息，
 * 抖动恒夹在坨缘内）。rng 异常 ⇒ 回落坨中心（确定性降级点，绝不抛）。
 */
function jitteredMargin(b: number, rng: () => number): number {
  const width = (2 * DIGEST_MARGIN_CLIP) / DIGEST_BINS;
  const u = rng();
  const m = binCenter(b) + (Number.isFinite(u) ? u : 0.5) * width - width / 2;
  if (!Number.isFinite(m)) return binCenter(b);
  return Math.min(DIGEST_MARGIN_CLIP, Math.max(-DIGEST_MARGIN_CLIP, m));
}

/**
 * ΝΩ-20：掺入 ts —— 源 mintedAt 邻域均匀散布 ±APPLY_TS_SCATTER_MS（取整毫秒、
 * 非负）。rng 异常 ⇒ 取邻域中心（mintedAt 本身 —— 确定性降级点，绝不抛）。
 */
function jitteredTs(srcMintedAt: number, rng: () => number): number {
  const u = rng();
  const t = srcMintedAt + (Number.isFinite(u) ? u - 0.5 : 0) * 2 * APPLY_TS_SCATTER_MS;
  if (!Number.isFinite(t)) return Math.max(0, Math.round(srcMintedAt));
  return Math.max(0, Math.round(t));
}

/**
 * 掺入合并摘要（绝不抛、绝不写 kernelRegistry 值）：
 *
 *   安全设计（本器官的立法核心）：远端证据只经 ledger.record 喂进证据账本 ——
 *   成败由坨坐标反演（success 列 ⇒ true）、margin 取坨内抖动值（ΝΩ-20：坨中心
 *   ± 坨宽内均匀 —— 旧律的坨中心常量把远端 DP 量化值当真值灌账，分布被坍缩成
 *   8 个原子点）；参数**值**的一切变化仍由本地 KernelCalibrator 的证据门
 *   （n ≥ 30）+ 回归守卫 + optimalThreshold 全链执法。联邦没有任何直达
 *   kernelRegistry.set 的写径。
 *
 *   ΑΩ-R41（provenance 标记）：掺入记录逐条带 origin:'federation' —— 与本地
 *   真实观察在账本内**可分离**（本地记录缺省缺席 origin = local），事后审计能
 *   区分「自己试出来的」与「联邦学来的」。只立账不立规：calibrator / 统计 /
 *   摘要铸造等读路径对 origin 零行为区分（掺入证据与本地证据同权入闸 —— 未来
 *   若要按来源加权，账已就绪）；来源纪要（sourceId）不进记录，只打布尔级来源。
 *   ΝΩ-20 锚（calibrator 消费面）：掺入 margin 是 DP 噪声后的坨坐标反演 + 坨宽
 *   内抖动 —— 本地 KernelCalibrator 消费这些 margins 时把它们当真值校准；
 *   **噪声感知加权待后续**（按 origin:'federation' 与远端 ε 降权消费 —— 账已
 *   就绪，本工单只立锚不实现加权）。
 *
 *   逐 key 配额决算（三道闸，缺一不掺）：
 *   ① 本地零证据的 key 不掺 —— 本地没见过的参数不引入外源漂移（诚实注记）；
 *   ② 份额上限：cap = floor(maxRemoteShare × 本地 n)，防远端洪泛主导本地校准；
 *   ③ 信任折减：quota = floor(cap × trust)，trust ∈ (0,1]（信任账 1/(1+regressed)）。
 *
 *   输入摘要版本不符 / 形状坏 ⇒ { ok:false }（诚实拒绝）；目标账本故障 ⇒ 单 key
 *   隔离跳过；掺入记录 ts 按源摘要 mintedAt 邻域散布（ΝΩ-20：mintedAt 非法 ⇒
 *   回落注入时钟邻域）。滑窗 200 FIFO：掺入挤占最旧的本地证据（内存有界纪律由
 *   账本既有契约执法）。
 */
export function applyFederatedEvidence(
  target: FederationLedgerTarget | null | undefined,
  merged: unknown,
  opts?: ApplyFederatedEvidenceOptions,
): FederatedApplyReport {
  const reject = (note: string): FederatedApplyReport => ({
    ok: false,
    applied: 0,
    trust: 1,
    perKey: [],
    notes: [note],
  });
  try {
    if (!target || typeof target.record !== 'function' || typeof target.stats !== 'function') {
      return reject('掺入目标账本非法：诚实跳过（绝不炸宿主）');
    }
    if (!merged || typeof merged !== 'object' || Array.isArray(merged)) {
      return reject('合并摘要形状非法：拒绝掺入');
    }
    const mm = merged as Partial<EvidenceDigest>;
    if (mm.v !== DIGEST_VERSION) {
      return reject(`摘要版本不符（期望 v=${DIGEST_VERSION}）：拒绝掺入`);
    }
    if (!Array.isArray(mm.keys)) {
      return reject('摘要 keys 非数组：拒绝掺入');
    }
    const share = numOr(opts?.maxRemoteShare, DEFAULT_MAX_REMOTE_SHARE, 0, 1);
    // 信任解析：显式 trust 优先（消毒到 (0,1]）；否则查 sourceId 信任账；再否则 1（初见全信）
    let trust = 1;
    if (typeof opts?.trust === 'number' && Number.isFinite(opts.trust) && opts.trust > 0) {
      trust = Math.min(1, opts.trust);
    } else if (typeof opts?.sourceId === 'string' && opts.sourceId !== '') {
      trust = federationTrustOf(opts.sourceId);
    }
    let nowMs = Date.now();
    if (typeof opts?.now === 'function') {
      try {
        const t = opts.now();
        if (Number.isFinite(t)) nowMs = t;
      } catch {
        /* 时钟故障保持 Date.now */
      }
    }
    // ΝΩ-20：掺入 ts 散布的邻域中心 = 源摘要 mintedAt（掺入证据代表源端铸造时刻
    // 前后的活动）；mintedAt 非法/缺席 ⇒ 回落注入时钟（旧律 ts = nowMs 只作降级臂）
    const srcMintedAt =
      typeof mm.mintedAt === 'number' && Number.isFinite(mm.mintedAt) && mm.mintedAt >= 0 ? mm.mintedAt : nowMs;
    const notes: string[] = [];
    const perKey: FederatedApplyReport['perKey'] = [];
    let applied = 0;
    for (const raw of mm.keys) {
      if (!raw || typeof raw !== 'object' || typeof (raw as Partial<EvidenceDigestKeyEntry>).key !== 'string' ||
        (raw as Partial<EvidenceDigestKeyEntry>).key === '') {
        notes.push('（无名 key 条目）：形状坏，跳过');
        continue;
      }
      const entry = raw as Partial<EvidenceDigestKeyEntry>;
      const key = entry.key as string;
      let localN = 0;
      try {
        const s = target.stats(key);
        localN = Number.isFinite(s?.n) ? s.n : 0;
      } catch {
        localN = 0; // stats 故障按零证据 ⇒ 走「不掺」臂（安全方向）
      }
      // 闸①：本地零证据不掺（本地没见过的参数不引入外源漂移）
      if (localN <= 0) {
        notes.push(`${key}: 本地零证据不掺入（防外源漂移）`);
        perKey.push({ key, localN: 0, cap: 0, quota: 0, injected: 0, reason: 'local-empty' });
        continue;
      }
      const cap = Math.floor(share * localN);
      // 闸②：份额上限（share 折没 / 本地 n 太小 ⇒ 零配额）
      if (cap <= 0) {
        notes.push(`${key}: 份额上限折没（share=${share} × n=${localN} ⇒ cap=0）`);
        perKey.push({ key, localN, cap: 0, quota: 0, injected: 0, reason: 'cap-zero' });
        continue;
      }
      const bins = Array.isArray(entry.bins) ? entry.bins : [];
      const cells: number[] = [];
      for (let b = 0; b < DIGEST_BINS; b++) {
        const cell = bins[b];
        for (let col = 0; col < 2; col++) {
          const v = cleanCell(Array.isArray(cell) ? cell[col] : undefined);
          cells.push(v ?? 0); // 坏格按 0（与 mergeDigests 同律 —— 掺入面不吃脏数据）
        }
      }
      const total = cells.reduce((s, c) => s + c, 0);
      if (total <= 0) {
        notes.push(`${key}: 远端摘要零质量（全格 0），无从掺入`);
        perKey.push({ key, localN, cap, quota: 0, injected: 0, reason: 'remote-empty-mass' });
        continue;
      }
      const quota = Math.floor(cap * trust);
      // 闸③：信任折减（trust × cap < 1 ⇒ 零配额 —— 回归源的诚实出局）
      if (quota <= 0) {
        notes.push(`${key}: 信任折没（trust=${trust} × cap=${cap} ⇒ quota=0）`);
        perKey.push({ key, localN, cap, quota: 0, injected: 0, reason: 'trust-zero' });
        continue;
      }
      const take = allocateQuota(quota, cells);
      let injected = 0;
      for (let b = 0; b < DIGEST_BINS; b++) {
        for (let col = 0; col < 2; col++) {
          const count = take[b * 2 + col];
          for (let i = 0; i < count; i++) {
            try {
              // 掺入记录：成败由坨坐标反演（col 0 = success 列）；margin 坨宽内
              // 均匀抖动、ts 源 mintedAt 邻域散布（ΝΩ-20 —— rng 种子确定性派生自
              // 记录坐标：源 mintedAt + key + 坨 + 列 + 记录序号 i，同摘要同坐标
              // 同抖动）；origin:'federation' 打 provenance 标（ΑΩ-R41 —— 只打
              // 布尔级来源，sourceId 计数汇总不进记录避免膨胀）；只喂账本 —— 值
              // 变化仍由本地 calibrator 全链执法（见 JSDoc 安全设计与噪声感知
              // 加权锚）
              const rng = mulberry32(jitterSeed(srcMintedAt, key, b, col, i));
              target.record({
                key,
                success: col === 0,
                margin: jitteredMargin(b, rng),
                ts: jitteredTs(srcMintedAt, rng),
                origin: 'federation',
              });
              injected += 1;
            } catch {
              /* 单条入账故障：跳过该条，其余照掺 */
            }
          }
        }
      }
      applied += injected;
      perKey.push({ key, localN, cap, quota, injected, reason: 'blended' });
    }
    if (applied === 0 && notes.length === 0) notes.push('摘要 keys 为空：无 key 完成掺入');
    // 信任账：真实掺入量入账（sourceId 在场才记 —— 匿名摘要无源不立账）
    if (typeof opts?.sourceId === 'string' && opts.sourceId !== '' && applied > 0) {
      recordFederationTrust(opts.sourceId, { applied });
    }
    return { ok: true, applied, trust, perKey, notes };
  } catch {
    return reject('掺入过程异常：诚实全跳（绝不炸宿主）');
  }
}
