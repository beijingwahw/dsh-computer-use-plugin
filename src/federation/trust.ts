// src/federation/trust.ts
// W9-3（D-F4 拆分·信任分区）：自 federation/index.ts 低风险提取 —— Μ-c 信任账
//（内存 Map 真值源）+ W6-4 持久化缝包（原子写文件存储/防御恢复/突变计数节流）。
// 逐字节搬运（零逻辑变更）；index.ts 原位再导出 —— 导入面不变（消费方零改动）。
// ΑΩ-R6（试用期缓升）：堵"初见全信"的 Sybil 空间 —— 旧律 trust = 1/(1+regressed)
// 对从未见过的 sourceId 立即给 1.0（新端点首掺免费、掺毒首轮无成本）。新律：初见
// 源处于试用期，trust 封顶 PROBATION_TRUST_CAP（0.35），累计 PROBATION_CLEAN_MERGES
//（3）次**干净**合并（合并轮内无检疫折算事件）后解除；试用期内吃检疫票 ⇒ 干净
// 计数回退归零且该污点轮不计干净（试用期重启）。'local' 源不适用试用期（本机
// 摘要不是外源）。既有哲学不变：留忏悔通道（trust 永不归零、毕业永久、票的
// 1/(1+regressed) 折减照咬），试用期只是给"初见"加折扣，不是新增惩罚。
import { existsSync, readFileSync, renameSync, mkdirSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';

// ─── Μ-c 信任账（内存 Map 为真值源；W6-4 增可选原子持久化面，见下节） ───

/**
 * 信任账条目：源 id + 累计掺入/回归/合并计数 + 现行信任度。
 * ΑΩ-R6：merges/cleanMerges 是试用期的原始计数（trust 仍派生不落账面）；
 * probation 是派生布尔（cleanMerges < PROBATION_CLEAN_MERGES 且非豁免源）。
 */
export interface FederationTrustRecord {
  sourceId: string;
  /** 累计掺入条数（applyFederatedEvidence 的 applied 累账） */
  applied: number;
  /** 累计回归次数（消费方在掺入后观察到校准回归时打点） */
  regressed: number;
  /** ΑΩ-R6：累计合并轮数（每次 applied > 0 的记账 = 一轮合并） */
  merges: number;
  /** ΑΩ-R6：累计干净合并轮数（试用期进度；饱和在 PROBATION_CLEAN_MERGES） */
  cleanMerges: number;
  /** ΑΩ-R6：是否仍在试用期（cleanMerges 未达门槛且非豁免源） */
  probation: boolean;
  /** trust = 1/(1+regressed) ∈ (0,1]（试用期另封顶 —— 见 federationTrustOf）；永不归零（留忏悔通道） */
  trust: number;
}

/** ΑΩ-R6：试用期信任封顶 —— 初见源（未毕业）的 trust 上限（Sybil 首掺折扣） */
export const PROBATION_TRUST_CAP = 0.35;

/** ΑΩ-R6：解除试用期所需的累计干净合并轮数（无检疫折算事件的合并） */
export const PROBATION_CLEAN_MERGES = 3;

/** ΑΩ-R6：试用期豁免源 —— robust 聚合里本机摘要的固定标签，本机不是外源 */
export const TRUST_PROBATION_EXEMPT_SOURCE = 'local';

// ─── ΝΩ-19（联邦逐源签名）：指纹粒度信任账键 ───

/** ΝΩ-19：指纹账键分隔符（`endpoint#指纹` —— 与裸 endpoint 键同域共存的字符串约定） */
export const FEDERATION_FINGERPRINT_KEY_SEP = '#';

/**
 * ΝΩ-19：指纹粒度账键（`endpoint#指纹`，纯函数、绝不抛）。R6 试用期/检疫票平移到
 * 正确主体粒度：robust 签名链路（sync.ts）里聚合端回传的每份带签摘要以**签名者
 * 指纹**立账 —— 真实客户端的毒摘要把票记到该客户端自己的账上，端点不再为伪造的
 * "集体"背锅，也不能靠真客户端的干净历史给假源续信用（恶意端自造的无签假源在
 * 验签层已被剔除，到不了账本）。向后兼容：裸 endpoint 键（旧档/掺入侧累计账）
 * 照常恢复与执法 —— sourceId 本就是自由字符串，持久化 schema 不动（v=2，旧档
 * 零迁移，新旧键同档共存）。退化输入（endpoint 或指纹为空）⇒ 返回非空侧原串
 * （等价裸键 —— 不臆造合成键；两皆空 ⇒ '' = 匿名不立账）。
 */
export function federationFingerprintSourceId(endpoint: string, fingerprint: string): string {
  try {
    const ep = typeof endpoint === 'string' ? endpoint : '';
    const fp = typeof fingerprint === 'string' ? fingerprint.trim() : '';
    if (ep === '' || fp === '') return ep;
    return `${ep}${FEDERATION_FINGERPRINT_KEY_SEP}${fp}`;
  } catch {
    return '';
  }
}

/**
 * 信任账本体（模块级内存 Map —— 进程生命周期；dump 面 = federationTrustReport）。
 * ΑΩ-R6：条目新增 merges/cleanMerges（试用期原始计数）与 dirty（检疫污点结算
 * 标记 —— 检疫折算事件之后、下一轮合并之前的未结算污点；持久化面如实带走）。
 */
const trustAccounts = new Map<string, { applied: number; regressed: number; merges: number; cleanMerges: number; dirty: boolean }>();

// ── W6-4（持久化缝包）：信任账落盘簿记（缺省未武装 = 纯内存，行为与旧逐字节一致）──

/**
 * 信任账档 schema 版本（版本错配 ⇒ 整档拒绝恢复；形态见 FederationTrustStoreDoc）。
 * ΑΩ-R6：升 2 —— accounts 条目新增 merges/cleanMerges/dirty（试用期原始计数；
 * trust 仍不落盘）。v=1 旧档被版本闸诚实拒绝（冷启动空账、试用期从零 —— 保守
 * 方向，不静默吞异版；与 mergeDigests 的版本闸同律）。
 */
export const TRUST_STORE_VERSION = 2;

/** 突变计数节流缺省：每 8 次信任突变落盘一次（armFederationTrustPersistence 可覆盖） */
export const DEFAULT_TRUST_FLUSH_EVERY = 8;

/** 已武装的存储端口（armFederationTrustPersistence 注入；null = 纯内存） */
let trustStore: FederationTrustStore | null = null;
/** 节流阈值：每 N 次信任突变触发一次落盘（突变计数制 —— 无时钟依赖，离线可测） */
let trustFlushEvery = DEFAULT_TRUST_FLUSH_EVERY;
/** 自上次成功落盘以来的突变计数（节流钟） */
let trustMutations = 0;

/** W6-4：突变计数推进 + 节流落盘（recordFederationTrust 的旁路尾钩，绝不抛） */
function noteTrustMutation(): void {
  try {
    trustMutations++;
    if (trustStore && trustMutations >= trustFlushEvery) flushFederationTrust();
  } catch {
    /* 绝不抛 */
  }
}

/**
 * 记信任账（绝不抛）：sourceId 非空字符串才立账；applied / regressed 非有限按 0、
 * 负数按 0、取整（计数语义）。消费语义：applyFederatedEvidence 成功掺入时自动记
 * applied；远端证据引发本地校准回归时由守卫方记 regressed（本模块不判回归 ——
 * 回归是本地 calibrator/lineage 的执法事实，信任账只记账不执法）。
 *
 * ΑΩ-R6 试用期记账律（原始计数如实落账，trust 永远派生；同调用内先算 regressed
 * 后算 applied —— 与 wired 序「先检疫后掺入」一致，确定性不受 delta 键序影响）：
 *   · 合并轮 = 本次记账携带 applied > 0（一轮真实掺入）⇒ merges 累计 +1；
 *   · 检疫折算（regressed > 0）⇒ 立污点（dirty）；试用期内（cleanMerges 未达
 *     门槛）同时干净计数回退归零 —— 票有代价，试用期重启；
 *   · 合并轮结算污点：dirty 在场 ⇒ 该轮不计干净（污点消费）；否则 cleanMerges
 *     +1（饱和在门槛值 —— 毕业后不再累加）。带票轮恰好既回退又不计干净。
 * W6-4：记账后走 noteTrustMutation —— 武装了持久化时按突变计数节流落盘
 * （缺省未武装 ⇒ 零磁盘行为，掺入闸语义零变化）。
 */
export function recordFederationTrust(
  sourceId: string,
  delta: { applied?: number; regressed?: number } = {},
): void {
  try {
    if (typeof sourceId !== 'string' || sourceId === '') return; // 匿名摘要无源不立账
    const cur = trustAccounts.get(sourceId) ?? { applied: 0, regressed: 0, merges: 0, cleanMerges: 0, dirty: false };
    const a = typeof delta.applied === 'number' && Number.isFinite(delta.applied) ? Math.max(0, Math.floor(delta.applied)) : 0;
    const r = typeof delta.regressed === 'number' && Number.isFinite(delta.regressed) ? Math.max(0, Math.floor(delta.regressed)) : 0;
    let { merges, cleanMerges, dirty } = cur;
    if (r > 0) {
      dirty = true; // ΑΩ-R6：检疫折算 ⇒ 污点待下轮合并结算
      if (cleanMerges < PROBATION_CLEAN_MERGES) cleanMerges = 0; // ΑΩ-R6：试用期内吃票 ⇒ 回退归零（试用期重启）
    }
    if (a > 0) {
      merges += 1; // ΑΩ-R6：一轮合并入账（原始计数如实）
      if (dirty) dirty = false; // 污点轮不计干净（先检疫后掺入的 wired 序下带票轮被跳过）
      else if (cleanMerges < PROBATION_CLEAN_MERGES) cleanMerges += 1; // 干净轮 +1，饱和在门槛（毕业永久）
    }
    trustAccounts.set(sourceId, { applied: cur.applied + a, regressed: cur.regressed + r, merges, cleanMerges, dirty });
    noteTrustMutation();
  } catch {
    /* 绝不抛 */
  }
}

/**
 * 现行信任度（绝不抛）：raw = 1/(1+regressed)；匿名（''/垃圾 id）⇒ 1（匿名不折减、
 * 也不试用期）。ΑΩ-R6：非豁免源在试用期（未立账即初见、或 cleanMerges 未达门槛）
 * ⇒ trust = min(raw, PROBATION_TRUST_CAP) —— 初见全信的旧病（新端点首掺免费）就此
 * 关闭；毕业（干净合并达门槛）永久解除封顶，此后只剩 1/(1+regressed) 的忏悔通道
 * （永不归零）。'local' 源不适用试用期（豁免标签）。
 */
export function federationTrustOf(sourceId: string): number {
  if (typeof sourceId !== 'string' || sourceId === '') return 1;
  const cur = trustAccounts.get(sourceId);
  const raw = !cur || cur.regressed <= 0 ? 1 : 1 / (1 + cur.regressed);
  if (sourceId === TRUST_PROBATION_EXEMPT_SOURCE) return raw; // ΑΩ-R6：本机豁免
  if ((cur?.cleanMerges ?? 0) < PROBATION_CLEAN_MERGES) return Math.min(raw, PROBATION_TRUST_CAP); // ΑΩ-R6：试用期封顶（初见即试用）
  return raw; // ΑΩ-R6：毕业永久 —— 只剩回归折减律
}

/** ΑΩ-R6：是否在试用期（报告/审计共用的派生判据；豁免源恒 false） */
function isOnProbation(sourceId: string, cleanMerges: number): boolean {
  return sourceId !== TRUST_PROBATION_EXEMPT_SOURCE && cleanMerges < PROBATION_CLEAN_MERGES;
}

/** 信任账全表（dump 面，防御副本，sourceId 字典序） */
export function federationTrustReport(): FederationTrustRecord[] {
  return [...trustAccounts.entries()]
    .map(([sourceId, t]) => ({
      sourceId,
      applied: t.applied,
      regressed: t.regressed,
      merges: t.merges,
      cleanMerges: t.cleanMerges,
      probation: isOnProbation(sourceId, t.cleanMerges),
      trust: federationTrustOf(sourceId),
    }))
    .sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1));
}

// ─── W6-4（持久化缝包）：信任账落盘 —— 原子写 + 防御恢复 + 突变计数节流 ───
//
// 早期报告的 restore 缝（信任账纯内存不落盘）在此闭合。纪律：
//   · 原子写 —— 文件存储实现走 tmp + fsync + rename（checkpoint.ts / approval.ts
//     同律）：要么完整旧档要么完整新档，绝无半档；fsync 先于 rename（页缓存不算
//     落盘）。写失败 = 诚实 ok:false（信任账继续在内存执法 —— 持久化是旁路义务）。
//   · 防御恢复 —— 垃圾值归先验：条目级垃圾（无 sourceId）跳过计数；字段级垃圾
//     （applied/regressed/merges/cleanMerges 非有限/负数、dirty 非布尔）按 0/false
//     —— regressed 垃圾 ⇒ 0 ⇒ raw 回 1，但 ΑΩ-R6 试用期封顶仍罩着初见账
//     （先验 = 初见试用期，不是全信）；档级垃圾（非 JSON/版本错配/非对象）整档
//     拒绝（schema 演进不静默吞异版 —— 与 mergeDigests 的版本闸同律）。trust 字段
//     不落盘：它是 regressed（及试用期计数）的派生量，恢复时重算 —— 单一真值源，
//     档上没有可投毒的信任值。ΑΩ-R6 试用期状态随原始计数落盘：merges/cleanMerges/
//     dirty（含未结算污点 —— 跨进程崩溃在"票已记、合并未结算"中段的恢复也如实）。
//   · 节流 —— 突变计数制（每 N 次信任突变触发一次落盘）：无时钟依赖（离线可测、
//     重放同判据），写放大有界（每次突变至多一次同步写尝试；失败不清计数 ⇒ 下次
//     突变即重试，成功的恢复路径幂等）。
//   · 缺省未武装 —— arm 之前一切公开面零磁盘行为（与旧行为逐字节一致，掺入闸
//     语义零变化）；resetFederationRuntime 解除武装（测试隔离缝）。

/** 信任账存储端口（注入面 —— 离线可测；生产用文件原子写实现） */
export interface FederationTrustStore {
  /** 读持久化档原文（缺席/不可读 ⇒ null）；绝不抛 */
  load(): string | null;
  /** 原子落盘（tmp + fsync + rename 项目惯例）；返回 ok/error，绝不抛 */
  save(text: string): { ok: boolean; error?: string };
}

/** W6-4：文件存储实现（原子写：tmp + fsync + rename —— checkpoint.ts 同律，绝不抛） */
export function createFederationTrustFileStore(filePath: string): FederationTrustStore {
  return {
    load(): string | null {
      try {
        if (!filePath || !existsSync(filePath)) return null;
        const text = readFileSync(filePath, 'utf8');
        return typeof text === 'string' && text.trim() !== '' ? text : null;
      } catch {
        return null; // 读故障（含 ENOENT 竞态）= 无持久化账（诚实方向）
      }
    },
    save(text: string): { ok: boolean; error?: string } {
      if (!filePath) return { ok: false, error: 'trust-store path is empty' };
      const tmp = filePath + '.tmp';
      try {
        mkdirSync(path.dirname(filePath), { recursive: true });
        // fsync 落盘后再换名：rename 可先于数据块持久化 —— 崩溃后可能读到空/截断档
        const fd = openSync(tmp, 'w');
        try {
          writeSync(fd, Buffer.from(text, 'utf8'));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmp, filePath); // 原子换名：要么完整旧档要么完整新档，绝无半档
        return { ok: true };
      } catch (e: unknown) {
        try { unlinkSync(tmp); } catch { /* tmp 可能未创建 */ }
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

/**
 * W6-4：信任账档形态（serializeFederationTrust 的输出 / restore 的输入域）。
 * ΑΩ-R6：accounts 条目新增试用期原始计数（merges/cleanMerges/dirty）—— trust
 * 仍是派生量不落盘（立法不变：档上没有可投毒的信任值，也没有可投毒的"毕业证"，
 * 毕业由 cleanMerges 原始计数派生）。
 */
export interface FederationTrustStoreDoc {
  v: typeof TRUST_STORE_VERSION;
  savedAt: number;
  /** 逐源计数（sourceId 字典序 —— 落盘字节确定，diff 友好）；trust 不落盘（派生量） */
  accounts: Array<{ sourceId: string; applied: number; regressed: number; merges: number; cleanMerges: number; dirty: boolean }>;
}

/** W6-4：信任账序列化（dump 面的落盘形态；sourceId 字典序 ⇒ 同账本态同字节） */
export function serializeFederationTrust(now?: () => number): string {
  let savedAt = Date.now();
  if (typeof now === 'function') {
    try {
      const t = now();
      if (Number.isFinite(t)) savedAt = t;
    } catch {
      /* 时钟故障保持 Date.now —— 绝不抛 */
    }
  }
  const doc: FederationTrustStoreDoc = {
    v: TRUST_STORE_VERSION,
    savedAt,
    accounts: [...trustAccounts.entries()]
      .map(([sourceId, t]) => ({ sourceId, applied: t.applied, regressed: t.regressed, merges: t.merges, cleanMerges: t.cleanMerges, dirty: t.dirty }))
      .sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1)),
  };
  return JSON.stringify(doc);
}

/** W6-4：单计数字段消毒（垃圾归先验臂）：有限非负 ⇒ 取整封顶；其余 ⇒ 0 */
function sanitizeTrustCount(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  return Math.min(Math.floor(v), Number.MAX_SAFE_INTEGER);
}

/** W6-4：恢复报告（诚实面：恢复几条、跳几条、为什么） */
export interface FederationTrustRestoreReport {
  restored: number;
  skipped: number;
  note?: string;
}

/**
 * W6-4：防御恢复（垃圾归先验、绝不抛）—— 档**整体替换**内存账（restore 是权威
 * 语义：恢复后的账 = 档上的账，不与内存残账合并）。档级垃圾（非对象/版本错配/
 * accounts 非数组）⇒ 整档拒绝（restored:0 + note，内存账不动）；条目级垃圾
 * （sourceId 非非空字符串）⇒ skipped++；字段级垃圾 ⇒ 该字段归先验（applied/
 * regressed/merges 垃圾 ⇒ 0；cleanMerges 垃圾 ⇒ 0 并封顶在门槛；dirty 非真布尔
 * ⇒ false）。ΑΩ-R6：试用期状态随原始计数恢复（cleanMerges/dirty），trust 由
 * 派生律重算（含试用期封顶）。恢复幂等：同档恢复两次结果一致；恢复后突变计数归零。
 */
export function restoreFederationTrust(payload: unknown): FederationTrustRestoreReport {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { restored: 0, skipped: 0, note: '信任档非对象：整档拒绝（内存账不动）' };
    }
    const doc = payload as Partial<FederationTrustStoreDoc>;
    if (doc.v !== TRUST_STORE_VERSION) {
      return { restored: 0, skipped: 0, note: `信任档版本不符（期望 v=${TRUST_STORE_VERSION}）：整档拒绝` };
    }
    if (!Array.isArray(doc.accounts)) {
      return { restored: 0, skipped: 0, note: '信任档 accounts 非数组：整档拒绝' };
    }
    const next = new Map<string, { applied: number; regressed: number; merges: number; cleanMerges: number; dirty: boolean }>();
    let skipped = 0;
    for (const raw of doc.accounts) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { skipped++; continue; }
      const e = raw as Partial<{ sourceId: unknown; applied: unknown; regressed: unknown; merges: unknown; cleanMerges: unknown; dirty: unknown }>;
      if (typeof e.sourceId !== 'string' || e.sourceId === '') { skipped++; continue; } // 无主条目不立账
      next.set(e.sourceId, {
        applied: sanitizeTrustCount(e.applied),
        regressed: sanitizeTrustCount(e.regressed), // 垃圾 ⇒ 0 ⇒ raw 回 1（ΑΩ-R6：初见账仍罩试用期封顶）
        merges: sanitizeTrustCount(e.merges), // ΑΩ-R6：合并计数垃圾 ⇒ 0（原始计数如实，不臆造）
        cleanMerges: Math.min(sanitizeTrustCount(e.cleanMerges), PROBATION_CLEAN_MERGES), // ΑΩ-R6：试用期进度垃圾 ⇒ 0、合法值封顶门槛
        dirty: e.dirty === true, // ΑΩ-R6：污点垃圾 ⇒ false（先验 = 无未结算污点）
      });
    }
    trustAccounts.clear();
    for (const [k, v] of next) trustAccounts.set(k, v);
    trustMutations = 0; // 恢复即权威：突变计数与节流钟一并归零
    return { restored: next.size, skipped };
  } catch {
    return { restored: 0, skipped: 0, note: '恢复过程异常：整档拒绝（防御式兜底）' };
  }
}

/**
 * W6-4：从存储端口读档并恢复（生产接线的一步调用：启动时 arm 前先 load）。
 * 档缺席/不可读/坏 JSON ⇒ restored:0 + note（冷启动空账 —— 诚实方向，绝不抛）。
 */
export function loadFederationTrust(store: FederationTrustStore | null | undefined): FederationTrustRestoreReport {
  try {
    if (!store || typeof store.load !== 'function') {
      return { restored: 0, skipped: 0, note: '存储端口缺席：无持久化账可恢复' };
    }
    const text = store.load();
    if (text === null || text === '') {
      return { restored: 0, skipped: 0, note: '无持久化档：冷启动空账' };
    }
    try {
      return restoreFederationTrust(JSON.parse(text));
    } catch {
      return { restored: 0, skipped: 0, note: '信任档坏 JSON：整档拒绝（冷启动空账）' };
    }
  } catch {
    return { restored: 0, skipped: 0, note: '读档异常：整档拒绝（防御式兜底）' };
  }
}

/** W6-4：武装参数（节流阈值可注入 —— 离线确定性测试的完整缝） */
export interface ArmTrustPersistenceOptions {
  /** 突变计数节流阈值（正有限整数；非法回落缺省 8） */
  flushEvery?: number;
}

/**
 * W6-4：武装信任账持久化（幂等：重复武装以后一次为准）。store 结构非法 ⇒ false
 * （诚实拒绝，保持纯内存）。武装后 recordFederationTrust 每 flushEvery 次突变
 * 触发一次原子落盘；flushFederationTrust 随时可强制冲刷。绝不抛。
 */
export function armFederationTrustPersistence(
  store: FederationTrustStore | null | undefined,
  opts?: ArmTrustPersistenceOptions,
): boolean {
  try {
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') return false;
    trustStore = store;
    const raw = opts?.flushEvery;
    trustFlushEvery = typeof raw === 'number' && Number.isFinite(raw) && raw >= 1
      ? Math.floor(raw)
      : DEFAULT_TRUST_FLUSH_EVERY;
    trustMutations = 0;
    return true;
  } catch {
    return false; // 防御式兜底：武装失败保持纯内存
  }
}

/** W6-4：立即冲刷报告（flushFederationTrust 的返回面） */
export interface FederationTrustFlushReport {
  /** true = 已落盘 或 无需落盘（未武装/账空幂等跳过） */
  ok: boolean;
  /** 本次实际写入的账目条数 */
  written: number;
  error?: string;
}

/**
 * W6-4：立即落盘（强制冲刷，绝不抛、幂等）。未武装 ⇒ ok:true + written:0
 * （纯内存是合法配置态，不是故障）。写失败 ⇒ ok:false + error（突变计数保留
 * ⇒ 下次突变即重试；内存账不受影响 —— 持久化失败绝不反噬信任执法）。
 */
export function flushFederationTrust(): FederationTrustFlushReport {
  try {
    if (!trustStore) return { ok: true, written: 0 };
    const text = serializeFederationTrust();
    const res = trustStore.save(text);
    if (res.ok) {
      trustMutations = 0;
      let written = 0;
      try { written = (JSON.parse(text) as FederationTrustStoreDoc).accounts.length; } catch { written = 0; }
      return { ok: true, written };
    }
    return { ok: false, written: 0, error: res.error ?? 'save failed' };
  } catch (e: unknown) {
    return { ok: false, written: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** W6-4：持久化簿记状态（审计面：armed/阈值/未冲刷突变/上次错误，防御副本） */
export function federationTrustPersistenceStatus(): {
  armed: boolean;
  flushEvery: number;
  pendingMutations: number;
  accounts: number;
} {
  return {
    armed: trustStore !== null,
    flushEvery: trustFlushEvery,
    pendingMutations: trustMutations,
    accounts: trustAccounts.size,
  };
}

// W9-3：联邦运行时复位的信任侧（index.resetFederationRuntime 调用；模块内账本私有，
// 复位须经此门 —— 与原文件内联语义逐字节一致）。
export function resetTrustRuntime(): void {
  trustAccounts.clear();
  trustStore = null;
  trustFlushEvery = DEFAULT_TRUST_FLUSH_EVERY;
  trustMutations = 0;
  revokedSources.clear(); // ΠΑΝ-74：撤销表一并复位（测试隔离缝；生产代码无理由调用）
  revocationStore = null;
}

// ─── ΠΑΝ-74（新鲜度与撤销）：联邦源撤销表（revocation list —— 本地文件） ───
//
// 立法背景：Ed25519 验签只证「签名者持钥」，不证「该源仍被信任」—— 被检疫源
// （连续吃票的指纹）与已知被 compromise 的客户端指纹需要一个**本地撤销通道**
// （信任账的 1/(1+regressed) 是缓慢折减，撤销是立即出局）。设计：
//   · 账面是模块级 Set（进程内即时生效）；持久化走可选的文件存储端口
//     （armFederationRevocationList 武装 —— 原子写 tmp+fsync+rename，信任账
//     createFederationTrustFileStore 同律）；缺省不武装 = 纯内存（重启即空，
//     与信任账持久化同款纪律）。
//   · 撤销键域 = 信任账同域的自由字符串：签名链路的 `endpoint#指纹`、裸
//     endpoint、或纯指纹（调用方按自己的账键口径撤销；sync 侧对两者都查）。
//   · 消费点在 sync.ts：验签后的指纹（或裸 endpoint）命中撤销表 ⇒ 该源按缺席
//     剔除并计数 revokedSources —— 被撤销的源连中位数都进不了（比检疫票硬一档）。
//   · 绝不抛：一切面防御式；撤销/恢复/落盘失败 = 诚实 false / 状态不变。

/** ΠΑΝ-74：撤销档 schema 版本（版本错配 ⇒ 整档拒绝恢复） */
export const FEDERATION_REVOCATION_STORE_VERSION = 1;

/** 撤销表真值源（模块级 Set —— 进程生命周期；持久化可选武装） */
const revokedSources = new Set<string>();

/** 已武装的撤销表存储端口（armFederationRevocationList 注入；null = 纯内存） */
let revocationStore: FederationRevocationStore | null = null;

/** ΠΑΝ-74：撤销表存储端口（注入面 —— 离线可测；生产用文件原子写实现） */
export interface FederationRevocationStore {
  /** 读撤销档原文（缺席/不可读 ⇒ null）；绝不抛 */
  load(): string | null;
  /** 原子落盘（tmp + fsync + rename）；返回 ok/error，绝不抛 */
  save(text: string): { ok: boolean; error?: string };
}

/** ΠΑΝ-74：撤销档形态（序列化方言） */
export interface FederationRevocationStoreDoc {
  v: typeof FEDERATION_REVOCATION_STORE_VERSION;
  savedAt: number;
  /** 撤销键字典序（同账本态同字节 —— diff 友好） */
  revoked: string[];
}

/** ΠΑΝ-74：文件存储实现（原子写：tmp + fsync + rename —— 信任账同律，绝不抛） */
export function createFederationRevocationFileStore(filePath: string): FederationRevocationStore {
  return {
    load(): string | null {
      try {
        if (!filePath || !existsSync(filePath)) return null;
        const text = readFileSync(filePath, 'utf8');
        return typeof text === 'string' && text.trim() !== '' ? text : null;
      } catch {
        return null; // 读故障（含 ENOENT 竞态）= 无撤销档（诚实方向）
      }
    },
    save(text: string): { ok: boolean; error?: string } {
      if (!filePath) return { ok: false, error: 'revocation-store path is empty' };
      const tmp = filePath + '.tmp';
      try {
        mkdirSync(path.dirname(filePath), { recursive: true });
        const fd = openSync(tmp, 'w');
        try {
          writeSync(fd, Buffer.from(text, 'utf8'));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmp, filePath); // 原子换名：要么完整旧档要么完整新档，绝无半档
        return { ok: true };
      } catch (e: unknown) {
        try { unlinkSync(tmp); } catch { /* tmp 可能未创建 */ }
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

/** ΠΑΝ-74：撤销一个联邦源（账键口径自由字符串：endpoint#指纹 / 裸 endpoint / 指纹）。
 *  幂等；武装了持久化则立即落盘（撤销是安全事件，不走节流）。绝不抛。 */
export function revokeFederationSource(sourceId: string): boolean {
  try {
    if (typeof sourceId !== 'string' || sourceId === '') return false;
    revokedSources.add(sourceId);
    if (revocationStore) flushFederationRevocations();
    return true;
  } catch {
    return false;
  }
}

/** ΠΑΝ-74：恢复一个被撤销的源（误撤销的补救通道；撤销面在内存立即可逆） */
export function unrevokeFederationSource(sourceId: string): boolean {
  try {
    if (typeof sourceId !== 'string' || sourceId === '') return false;
    revokedSources.delete(sourceId);
    if (revocationStore) flushFederationRevocations();
    return true;
  } catch {
    return false;
  }
}

/** ΠΑΝ-74：源是否被撤销（缺省 false；绝不抛） */
export function isFederationSourceRevoked(sourceId: string): boolean {
  try {
    return typeof sourceId === 'string' && revokedSources.has(sourceId);
  } catch {
    return false;
  }
}

/** ΠΑΝ-74：撤销表快照（字典序防御副本 —— 观测面） */
export function federationRevocationList(): string[] {
  try {
    return [...revokedSources].sort();
  } catch {
    return [];
  }
}

/** ΠΑΝ-74：撤销表序列化（落盘形态；字典序 ⇒ 同态同字节） */
export function serializeFederationRevocations(now?: () => number): string {
  let savedAt = Date.now();
  if (typeof now === 'function') {
    try {
      const t = now();
      if (Number.isFinite(t)) savedAt = t;
    } catch { /* 时钟故障保持 Date.now —— 绝不抛 */ }
  }
  const doc: FederationRevocationStoreDoc = {
    v: FEDERATION_REVOCATION_STORE_VERSION,
    savedAt,
    revoked: federationRevocationList(),
  };
  return JSON.stringify(doc);
}

/** ΠΑΝ-74：防御恢复（垃圾归先验、绝不抛）—— 档整体替换内存撤销表；档级垃圾
 *  （非对象/版本错配/revoked 非数组）⇒ 整档拒绝（内存表不动）。 */
export function restoreFederationRevocations(payload: unknown): { restored: number; skipped: number; note?: string } {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { restored: 0, skipped: 0, note: '撤销档非对象：整档拒绝（内存表不动）' };
    }
    const doc = payload as Partial<FederationRevocationStoreDoc>;
    if (doc.v !== FEDERATION_REVOCATION_STORE_VERSION) {
      return { restored: 0, skipped: 0, note: `撤销档版本不符（期望 v=${FEDERATION_REVOCATION_STORE_VERSION}）：整档拒绝` };
    }
    if (!Array.isArray(doc.revoked)) {
      return { restored: 0, skipped: 0, note: '撤销档 revoked 非数组：整档拒绝' };
    }
    let skipped = 0;
    const next = new Set<string>();
    for (const raw of doc.revoked) {
      if (typeof raw !== 'string' || raw === '') { skipped++; continue; } // 垃圾键跳过
      next.add(raw);
    }
    revokedSources.clear();
    for (const k of next) revokedSources.add(k);
    return { restored: next.size, skipped };
  } catch {
    return { restored: 0, skipped: 0, note: '恢复过程异常：整档拒绝（防御式兜底）' };
  }
}

/** ΠΑΝ-74：武装撤销表持久化（幂等）。store 结构非法 ⇒ false（保持纯内存）。 */
export function armFederationRevocationList(store: FederationRevocationStore | null | undefined): boolean {
  try {
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') return false;
    revocationStore = store;
    return true;
  } catch {
    return false;
  }
}

/** ΠΑΝ-74：立即落盘撤销表（未武装 ⇒ ok:true + written:0 —— 纯内存是合法配置态） */
export function flushFederationRevocations(): { ok: boolean; written: number; error?: string } {
  try {
    if (!revocationStore) return { ok: true, written: 0 };
    const text = serializeFederationRevocations();
    const res = revocationStore.save(text);
    if (res.ok) return { ok: true, written: revokedSources.size };
    return { ok: false, written: 0, error: res.error ?? 'save failed' };
  } catch (e: unknown) {
    return { ok: false, written: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** ΠΑΝ-74：从存储端口读档并恢复（生产接线的一步调用；档缺席/坏 JSON ⇒ 冷启动空表） */
export function loadFederationRevocations(store: FederationRevocationStore | null | undefined): { restored: number; skipped: number; note?: string } {
  try {
    if (!store || typeof store.load !== 'function') {
      return { restored: 0, skipped: 0, note: '存储端口缺席：无持久化撤销表可恢复' };
    }
    const text = store.load();
    if (text === null || text === '') {
      return { restored: 0, skipped: 0, note: '无持久化档：冷启动空撤销表' };
    }
    try {
      return restoreFederationRevocations(JSON.parse(text));
    } catch {
      return { restored: 0, skipped: 0, note: '撤销档坏 JSON：整档拒绝（冷启动空表）' };
    }
  } catch {
    return { restored: 0, skipped: 0, note: '读档异常：整档拒绝（防御式兜底）' };
  }
}
