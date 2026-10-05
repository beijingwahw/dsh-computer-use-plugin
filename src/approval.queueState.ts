// src/approval.queueState.ts
// approval 队列状态核（W8-B3 自 approval.ts 拆出 —— 代码逐字保持，零漂移）。
// 离线待批队列的全部可变簿记（存储/时钟/超时/条目/审计计数）与状态机内脏：
// 惰性装载、恢复面净化、W6-3 已拒保留期清理、落盘、裁决传播、续跑铸造。
// 状态变量的**重赋值只发生在本文件**（arm/ensureQueueLoaded/restore/reset 四点）
// —— API 面（approval.queue.ts）经只读活绑定消费，防御式单写点。
// 公开面绝不抛：存储/时钟/输入垃圾一律收敛为诚实返回值（防御式律）。
import { randomBytes } from 'node:crypto';
import { TTL_MS, MAX_ATTEMPTS, LIFETIME_MULTIPLIER, AMENDMENT_NOTE_MAX, DEFAULT_STAGING_TIMEOUT_MS, DEFAULT_QUEUE_TTL_MS, DEFAULT_DENIED_RETENTION_MS, APPROVAL_QUEUE_VERSION } from './approval.constants';
import { strOrUndef, sanitizeActionShape, type RawActionShape } from './approval.shapes';
import { newToken, castAmendmentFor, bindTokenTarget, boundTargetOf, forgetTokenTarget } from './approval.security';
import { pending } from './approval.registry';
import type { PendingApproval } from './approval.registry';
import type { ApprovalQueueStorage, QueuedActionEvidence, QueuedApprovalDecision, QueuedApprovalEntry } from './approval.queueContracts';

// ── 队列模块态（全部经 armQueueState 注入；缺省 = 内存队列 + 真钟） ──

/** 存储端口（null = 仅内存 —— 跨进程不保，诚实降级）；只读本绑定的面：
 *  stagingAvailability/queueStats 的 persistent/storageArmed。 */
export let queueStorage: ApprovalQueueStorage | null = null;
/** 注入时钟（真钟缺省；qNow 安全包裹） */
let queueNow: () => number = Date.now;
export let queueStagingTimeoutMs: number = DEFAULT_STAGING_TIMEOUT_MS;
export let queueTtlMs: number = DEFAULT_QUEUE_TTL_MS;
/** W6-3：已拒条目保留期（deny 后审计窗口宽度；arm 可注入，负值 = 关闭清理） */
export let queueDeniedRetentionMs: number = DEFAULT_DENIED_RETENTION_MS;
/** W6-3：本模块生命周期内已清理的 denied 条目累计（审计留痕 —— 条目消失，
 *  「曾拒绝过多少」的账面长存；随档落盘为 prunedDeniedTotal，跨进程恢复取
 *  max(内存, 档) 不回退）。 */
export let prunedDeniedTotal = 0;
/** 队列条目（唯一事实源；数组内容的增删由 API 面经此绑定操作 —— 重赋值仅
 *  在本文件的装载/恢复/武装/归零四点）。 */
export let queueEntries: QueuedApprovalEntry[] = [];

// ─── ΠΑΝ-1（裁决人证补全）：条目级确认码证据（**仅内存驻留，绝不落盘**） ───
//
// 条目入队（stageAction）时锚定触发令牌的 confirmCodeHash（sha256 hex —— 与
// approval.registry.PendingApproval.confirmCodeHash 同源同律：铸造时经带外通道
// 投给人类、簿记只留哈希）。裁决 grant 臂必须消费它：调用方携用户读码后交回
// 的明文码，恒定时间比对通过才可置 granted —— 与 grant_approval（grantDetailed）
// 完全同一人证标准，Y-10 限速在码校验**之后**（限速是补充不是替代人证）。
//
// 为什么不落盘：10^6 码空间下哈希离体 = 离线爆破面（线上枚举由 mismatches
// 封顶封堵，离线爆破无此防线）—— 哈希随条目持久化会把「封顶 5 次」的防枚举
// 承诺整体击穿。代价（诚实申报）：跨进程恢复的条目无证据锚 ⇒ grant 臂一律
// 'confirm-channel-absent' 拒绝（须 deny 后重新 request_approval 铸新码重走
// 暂存）—— fail-closed 方向：宁可要求重新人证，不可凭重启抹掉人证要求。
export interface QueueConfirmEvidence {
  /** 入队时锚定的确认码哈希（sha256 hex） */
  hash: string;
  /** 错码尝试计数（防暴力枚举封顶簿记 —— 与 pa.codeMismatches 同律） */
  mismatches: number;
}
const entryConfirmEvidence = new Map<string, QueueConfirmEvidence>();

/** ΠΑΝ-1：入队面锚定人证证据（hash 缺席 = 铸造即降级 ⇒ 条目永不可 grant） */
export function anchorQueueConfirmEvidence(entryId: string, hash: string): void {
  try {
    if (!entryId || !hash) return;
    entryConfirmEvidence.set(entryId, { hash, mismatches: 0 });
  } catch { /* 防御式：证据面故障绝不炸入队主流程 */ }
}

/** ΠΑΝ-1：裁决面读取证据锚（无锚 ⇒ grant 臂 fail-closed） */
export function queueConfirmEvidenceOf(entryId: string): QueueConfirmEvidence | undefined {
  return entryConfirmEvidence.get(entryId);
}

/** ΠΑΝ-1：错码计数 +1（返回新计数；封顶判定在调用面 —— 与 ledger 同律） */
export function bumpQueueConfirmMismatch(entryId: string): number {
  const ev = entryConfirmEvidence.get(entryId);
  if (!ev) return 0;
  ev.mismatches += 1;
  return ev.mismatches;
}

/** ΠΑΝ-1：匹配即清零（错误计数是尝试簇，不是终身累计 —— 与 ledger 同律） */
export function clearQueueConfirmMismatch(entryId: string): void {
  const ev = entryConfirmEvidence.get(entryId);
  if (ev) ev.mismatches = 0;
}
/** 惰性装载标志（首次触及队列面前从存储读档） */
let queueLoaded = false;
/** 最近一次持久化错误（queueStats 透明化面） */
export let queuePersistError: string | undefined;

export function newQueueId(): string {
  return 'QA-' + randomBytes(8).toString('hex').toUpperCase();
}

/** 安全时钟读数（注入时钟抛错/回垃圾 ⇒ 0 —— 绝不因计时面炸队列） */
export function qNow(): number {
  try {
    const t = queueNow();
    return typeof t === 'number' && Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

/** 证据链净化：入队面（RawActionShape 即刻脱敏）与恢复面（已脱敏形状直通）共用 */
export function sanitizeEvidence(raw: unknown): QueuedActionEvidence {
  const ev: QueuedActionEvidence = {};
  if (!raw || typeof raw !== 'object') return ev;
  const r = raw as Record<string, unknown>;
  const shot = strOrUndef(r.screenshotRef, 200);
  if (shot !== undefined) ev.screenshotRef = shot;
  const fp = strOrUndef(r.sceneFingerprint, 100);
  if (fp !== undefined) ev.sceneFingerprint = fp;
  const tier = strOrUndef(r.riskTier, 32);
  if (tier !== undefined) ev.riskTier = tier;
  const shape = r.actionShape;
  if (shape && typeof shape === 'object') {
    // 输入面：RawActionShape（含可能的原文 text）⇒ sanitizeActionShape 脱敏；
    // 已脱敏形状（tool + 可选 x/y/target_description/长度桶）再过一次幂等不变。
    const s = shape as RawActionShape;
    if (typeof s.tool === 'string' && s.tool) ev.actionShape = sanitizeActionShape(s);
  }
  return ev;
}

/** 条目深拷贝（JSON 安全面 —— 队列条目全部为可序列化原语） */
export function cloneEntry(e: QueuedApprovalEntry): QueuedApprovalEntry {
  return JSON.parse(JSON.stringify(e)) as QueuedApprovalEntry;
}

/** 恢复面净化：单条目结构校验（垃圾 ⇒ null 弃置 —— 好条目不连坐） */
export function sanitizeQueueEntry(raw: unknown): QueuedApprovalEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = strOrUndef(r.id, 64);
  const token = strOrUndef(r.token, 64);
  const description = strOrUndef(r.description, 200);
  if (id === undefined || token === undefined || description === undefined) return null;
  const enqueuedAt = r.enqueuedAt;
  const ttlMs = r.ttlMs;
  const expiresAt = r.expiresAt;
  if (typeof enqueuedAt !== 'number' || !Number.isFinite(enqueuedAt) || enqueuedAt < 0) return null;
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt < 0) return null;
  const entry: QueuedApprovalEntry = {
    id, token, description,
    evidence: sanitizeEvidence(r.evidence),
    enqueuedAt, ttlMs, expiresAt,
  };
  const cursor = r.stepCursor;
  if (typeof cursor === 'number' && Number.isFinite(cursor) && cursor >= 0) {
    entry.stepCursor = Math.floor(cursor);
  }
  const d = r.decision;
  if (d && typeof d === 'object') {
    const dd = d as Record<string, unknown>;
    // ΠΑΝ-4：'absorbed'（交互兑现终态）与 granted/denied 同为合法词表值 ——
    // 恢复面照常接回（终态不可再 take 的语义由 takeGranted 的 granted 过滤执法）
    if (dd.verdict === 'granted' || dd.verdict === 'denied' || dd.verdict === 'absorbed') {
      const at = dd.at;
      const decision: QueuedApprovalDecision = {
        verdict: dd.verdict,
        at: typeof at === 'number' && Number.isFinite(at) && at >= 0 ? at : qNow(),
      };
      const note = strOrUndef((dd.amendment as Record<string, unknown> | undefined)?.note, AMENDMENT_NOTE_MAX);
      if (note !== undefined) {
        // amendment 结构面净化：note 在场即按 W1-2 协议重铸（original 取条目描述
        // —— 恢复面没有铸造时自述的旁证，重铸保守可复现）
        decision.amendment = castAmendmentFor(description, note, decision.at);
      }
      entry.decision = decision;
    }
    // verdict 垃圾 ⇒ decision 整体弃置（回到待批 —— 保守方向：绝不凭恢复面伪造 grant）
  }
  return entry;
}

/** 惰性装载：首次触queue面前从存储读档（垃圾档 ⇒ 空队列归零 —— 绝不抛）。
 *  ΠΑΝ-3：读回内容的完整性可信度经可选透明化面 lastLoadTrusted 判定 ——
 *  不可信（无密钥降级档/旧版明文档/自定义存储未自证）⇒ granted 裁决一律
 *  剥离降回待批（fail-closed：盘面上的「已授予」是预授权凭据，未经完整性
 *  验证不可恢复；pending/denied 照常恢复供晨报 —— 拒绝路径不放大风险）。 */
export function ensureQueueLoaded(): void {
  if (queueLoaded) return;
  queueLoaded = true;
  queueEntries = [];
  if (queueStorage === null) return; // 仅内存（跨进程不保 —— 诚实降级）
  try {
    const text = queueStorage.load();
    if (text === null) return;
    // ΠΑΝ-3：可信度探针（方法缺席/抛错 ⇒ 不可信 —— 防御式缺省 fail-closed）
    let trusted = false;
    try {
      trusted = typeof queueStorage.lastLoadTrusted === 'function'
        ? queueStorage.lastLoadTrusted() === true
        : false;
    } catch {
      trusted = false;
    }
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return; // 垃圾档 ⇒ 归零
    const root = parsed as Record<string, unknown>;
    // W6-3：审计留痕恢复 —— 档中的累计清理数读回（取 max 不回退；垃圾值 ⇒ 忽略）
    const pr = root.prunedDeniedTotal;
    if (typeof pr === 'number' && Number.isFinite(pr) && pr >= 0) {
      prunedDeniedTotal = Math.max(prunedDeniedTotal, Math.floor(pr));
    }
    const entries = root.entries;
    if (!Array.isArray(entries)) return; // 垃圾段 ⇒ 归零
    const seen = new Set<string>();
    for (const raw of entries) {
      const e = sanitizeQueueEntry(raw);
      if (e === null || seen.has(e.id)) continue; // 垃圾条目/重复 id 弃置
      seen.add(e.id);
      // ΠΑΝ-3：不可信盘面 ⇒ granted 决不恢复（裁决剥回待批 —— 「恢复时全部
      // 拒绝 granted 条目」的降级执法点；配合 ΠΑΝ-1 的证据仅内存驻留，重启后
      // 该条目也无法再被批量裁决批准 —— 重走完整审批是唯一出路）
      if (!trusted && e.decision?.verdict === 'granted') delete e.decision;
      queueEntries.push(e);
    }
  } catch {
    queueEntries = []; // 解析故障 ⇒ 归零（防御式：坏档不炸队列，也不冒充恢复）
  }
}

/** W6-3（W2-1 遗留清偿）：已拒条目保留期清理 —— deny 后条目进入保留期
 *  （缺省 7 天），到期在下次队列落盘时清除。执法点置于 persistQueue 开头：
 *  一切落盘路径（stageAction/adjudicate/recordTokenDecision/takeGranted）统一
 *  经过，无需调用方各自记得清理；仅内存队列（存储缺席）也在落盘尝试时清理
 *  ——语义统一，队列缓慢增长在两面同律闭合。
 *  审计留痕（不静默消失）：每清一条 prunedDeniedTotal 累计 +1，随档落盘为
 *  prunedDeniedTotal 字段、经 queueStats().prunedDenied 暴露 —— 条目从晨报
 *  消失，但「曾拒绝过多少」的账面长存（跨进程恢复取 max 不回退）。
 *  防御式绝不抛：时钟垃圾（qNow=0）⇒ now−at ≤ 0 < 保留期 ⇒ 一条不清
 *  （保守方向：宁可留着挡晨报，不可误删审计面）；负保留期 = 部署显式关闭。 */
function pruneDeniedEntries(): void {
  try {
    if (queueDeniedRetentionMs < 0) return; // 部署显式关闭清理（保留期 = ∞）
    const now = qNow();
    if (now <= 0) return; // 时钟面垃圾 ⇒ 不清（保守）
    let pruned = 0;
    for (let i = queueEntries.length - 1; i >= 0; i--) {
      const d = queueEntries[i].decision;
      if (d?.verdict === 'denied' && (now - d.at) >= queueDeniedRetentionMs) {
        queueEntries.splice(i, 1);
        pruned++;
      }
    }
    if (pruned > 0) prunedDeniedTotal += pruned; // 审计计数（save 失败 ⇒ 内存面已一致，下次落盘补写）
  } catch {
    /* 防御式兜底：清理故障绝不炸落盘主流程（条目多留一轮 = 保守方向） */
  }
}

/** 队列落盘（存储缺席 = 仅内存恒 ok；失败记 queuePersistError —— 绝不抛）。
 *  W6-3：落盘前先执法 denied 保留期清理（见 pruneDeniedEntries）。
 *  ΠΑΝ-1：落盘前同步清扫已消失条目的人证证据行（内存驻留面不随队列收缩
 *  泄漏增长 —— 一切移除条目的路径必经本函数）。 */
export function persistQueue(): { ok: boolean; error?: string } {
  pruneDeniedEntries(); // W6-3：到期清理的统一执法点（一切落盘路径必经）
  try {
    if (entryConfirmEvidence.size > 0) {
      const live = new Set(queueEntries.map(e => e.id));
      for (const id of entryConfirmEvidence.keys()) {
        if (!live.has(id)) entryConfirmEvidence.delete(id);
      }
    }
  } catch {
    /* 防御式：证据清扫故障绝不炸落盘主流程（残留行无安全语义 —— 条目已不在） */
  }
  if (queueStorage === null) return { ok: true };
  try {
    const r = queueStorage.save(JSON.stringify({
      version: APPROVAL_QUEUE_VERSION,
      savedAt: qNow(),
      // W6-3 审计留痕：累计清理数随档长存（恢复面读回取 max —— 绝不回退）
      prunedDeniedTotal,
      entries: queueEntries,
    }));
    if (!r.ok) queuePersistError = r.error ?? 'unknown storage error';
    else queuePersistError = undefined;
    return r;
  } catch (e: unknown) {
    queuePersistError = e instanceof Error ? e.message : String(e);
    return { ok: false, error: queuePersistError };
  }
}

/** W2-1（H4）：grantDetailed 的裁决传播（旁路义务 —— 队列故障绝不炸审批主流程）。
 *  令牌在暂存后又被交互式 grant/deny ⇒ 在途条目同步裁决（amendment 同律铸入；
 *  Y-10 预算已在 grantDetailed 计费，此处不重复扣）。
 *  ΠΑΝ-4（双通道双花封堵）：交互式 grant 的传播裁决为 'absorbed' 终态 ——
 *  该份同意的执行载体就是交互令牌本尊（granted、TTL 内、beginAttempt→consume
 *  验收式消费），队列条目进入不可再 takeGranted 的终态。旧实现传播为 granted
 *  使同一份同意可经「交互令牌 + takeGranted 续跑令牌」两条通道各铸一枚执行
 *  令牌 = 一次 Y-10 兑付两次不可逆派发，违反「一次同意恰一次兑现」的量化
 *  承诺（C1-1 H3）。deny 传播不变（denied 本就是终态）。
 *  ΠΑΝ-37（veto 撤销已批条目）：deny 传播的匹配域扩至 **granted** 在途条目 ——
 *  用户对「已被 adjudicate 批准、正等续跑」的动作交互式喊停（grantDetailed
 *  false）时，条目的 granted 裁决就地撤销改判 denied（F1-2 移交的残余窗口：
 *  旧实现只传播 undecided 条目 ⇒ 已批条目在用户明确否决后仍可被 takeGranted
 *  兑现）。grant 传播的匹配域不变（仅 undecided —— granted 条目是队列通道的
 *  在途同意，不得被交互 grant 改写为 absorbed）。 */
export function recordTokenDecision(token: string, granted: boolean, note?: string): void {
  try {
    ensureQueueLoaded();
    // ΠΑΝ-37：deny 匹配 undecided ∪ granted（veto 撤销）；grant 匹配 undecided（ΠΑΝ-4）
    const entry = queueEntries.find(e =>
      e.token === token && (granted
        ? e.decision === undefined
        : (e.decision === undefined || e.decision.verdict === 'granted')));
    if (!entry) return;
    const now = qNow();
    entry.decision = {
      verdict: granted ? 'absorbed' : 'denied',
      at: now,
      ...(note ? { amendment: castAmendmentFor(entry.description, note, now) } : {}),
    };
    persistQueue();
  } catch {
    /* 队列是审批的旁路：传播失败 = 条目留待批量裁决（保守方向） */
  }
}

/**
 * ΠΑΝ-37：撤销已批条目（adjudicate veto 面的执法原语）—— 把目标 id（缺省全部）
 * 中 verdict='granted' 的条目改判 denied 并落盘。调用方：adjudicate 工具的
 * grant=false 臂（用户在晨报/队列面上明确喊停 ⇒ 已批未续跑的条目不得再被
 * takeGranted 兑现）。'absorbed' 条目不撤（交互通道已物理执行，撤销无意义）；
 * denied/undecided 不动（undecided 由随后的 adjudicate 正常裁决）。绝不抛。
 */
export function revokeGrantedEntries(ids: string[]): { revoked: number } {
  try {
    ensureQueueLoaded();
    const wanted = new Set(ids.filter(x => typeof x === 'string' && x.trim() !== ''));
    const now = qNow();
    let revoked = 0;
    for (const e of queueEntries) {
      if (e.decision?.verdict !== 'granted') continue;
      if (wanted.size > 0 && !wanted.has(e.id)) continue;
      e.decision = { verdict: 'denied', at: now };
      revoked++;
    }
    if (revoked > 0) persistQueue();
    return { revoked };
  } catch {
    return { revoked: 0 }; // 防御式：撤销面故障 = 撤销数为 0（保守申报，绝不炸调用方）
  }
}

/** 续跑执行令牌铸造：已授予（不扣 Y-10 —— 批量裁决时已扣）、amendment 随行、
 *  生命周期同常规铸造（V 纪元验收式消费照常执法）。
 *  ΠΑΝ-36（F1-2 接线点③收尾）：续跑令牌继承原令牌的目标绑定 —— 原请求携带
 *  macaroon 式 targetDigest 时（approval.request/mintBoundToken 铸入），续跑
 *  令牌绑定**同一摘要**（不是重算：暂存语境的 actionShape.tool 可能是
 *  'described-action'（非派发工具名），按它重算绑定会在续跑派发面制造确定性
 *  target-mismatch；只有原令牌真携带的绑定才可继承 —— 无绑定 ⇒ 诚实缺席）。
 *  ΠΑΝ-37（残余双花窗口闭合 · F1-2 移交）：续跑令牌铸造 = 原交互令牌的执行权
 *  转移 —— 原令牌（entry.token）就地焚毁（pending 删除 + 绑定账离场），窄窗
 *  内用户再交码交互式 grant 也不得武装第二条兑现通道（一次同意恰一次兑现）。 */
export function mintResumedToken(entry: QueuedApprovalEntry): string {
  const now = qNow();
  // ΠΑΝ-36：先读原绑定再焚毁（焚毁会 forget 绑定账 —— 顺序即正确性）
  const inheritedBinding = boundTargetOf(entry.token);
  const pa: PendingApproval = {
    token: newToken(),
    description: entry.description,
    expiresAt: now + TTL_MS,
    granted: true,
    attempts: 0,
    maxAttempts: MAX_ATTEMPTS,
    ttlMs: TTL_MS,
    lifetimeCapAt: now + TTL_MS * LIFETIME_MULTIPLIER,
    ...(entry.evidence.actionShape !== undefined ? { actionShape: entry.evidence.actionShape } : {}),
    ...(entry.evidence.sceneFingerprint !== undefined ? { sceneFingerprint: entry.evidence.sceneFingerprint } : {}),
    ...(entry.decision?.amendment !== undefined ? { amendment: entry.decision.amendment } : {}),
    resumedFromQueue: entry.id,
  };
  if (inheritedBinding !== undefined) bindTokenTarget(pa.token, inheritedBinding);
  pending.set(pa.token, pa);
  // ΠΑΝ-37：原交互令牌焚毁（执行权已转移给续跑令牌 —— 双通道双花的 take 面闭合）
  pending.delete(entry.token);
  forgetTokenTarget(entry.token);
  return pa.token;
}

/** 武装（幂等）：注入存储/时钟/超时（W8-B3 拆分缝 —— 原为 approvalQueue.arm
 *  体内实现，逐字提取；缺省 = 内存队列 + 真钟 + 5min/24h。
 *  W6-3：deniedRetentionMs 注入已拒条目保留期（缺省 7 天；负值 = 关闭清理）。
 *  组合根挂点见 doctorChannel.wireDoctorVerdictChannel（W2-1 段）。绝不抛。） */
export function armQueueState(opts: {
  storage?: ApprovalQueueStorage | null;
  now?: () => number;
  stagingTimeoutMs?: number;
  ttlMs?: number;
  deniedRetentionMs?: number;
} = {}): void {
  try {
    if ('storage' in opts) queueStorage = opts.storage ?? null;
    if (typeof opts.now === 'function') queueNow = opts.now;
    if (typeof opts.stagingTimeoutMs === 'number' && Number.isFinite(opts.stagingTimeoutMs)) {
      queueStagingTimeoutMs = Math.max(0, opts.stagingTimeoutMs);
    }
    if (typeof opts.ttlMs === 'number' && Number.isFinite(opts.ttlMs)) {
      queueTtlMs = Math.max(1_000, opts.ttlMs);
    }
    // W6-3：负值原样保留（= 关闭清理的部署语义）；NaN/Infinity 已被 isFinite 拒
    if (typeof opts.deniedRetentionMs === 'number' && Number.isFinite(opts.deniedRetentionMs)) {
      queueDeniedRetentionMs = opts.deniedRetentionMs;
    }
    queueEntries = [];
    queueLoaded = false;
    queuePersistError = undefined;
    // W6-3：重新武装 = 新队列生命周期，累计清理数归零（跨进程续账由读档恢复）
    prunedDeniedTotal = 0;
    // ΠΑΝ-1：人证证据随新生命周期归零（重新锚定须重新入队 —— 与条目账同律）
    entryConfirmEvidence.clear();
  } catch {
    /* 武装失败 = 保持现状（阻塞审批原样 —— 诚实降级） */
  }
}

/** checkpoint 恢复面（防御性恢复 —— 垃圾值归零；W8-B3 拆分缝 —— 原为
 *  approvalQueue.restoreQueue 体内实现，逐字提取）：整段垃圾 ⇒ 空队列；
 *  条目级垃圾 ⇒ 弃置坏条目保住好条目（不连坐）。绝不抛。 */
export function restoreQueueEntries(rawEntries: unknown): { kept: number; dropped: number } {
  queueEntries = [];
  queueLoaded = true;
  if (!Array.isArray(rawEntries)) return { kept: 0, dropped: 0 }; // 整段垃圾 ⇒ 归零
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of rawEntries) {
    const e = sanitizeQueueEntry(raw);
    if (e === null || seen.has(e.id)) { dropped++; continue; }
    seen.add(e.id);
    queueEntries.push(e);
  }
  return { kept: queueEntries.length, dropped };
}

/** W-1 隔离缝的队列面归零（resetApproval 组合面调用 —— 内存条目清空、存储/
 *  时钟注入卸载回缺省；测试不得读到上一用例的持久化队列，生产由下一次组合根
 *  武装重接）。 */
export function resetQueueState(): void {
  queueStorage = null;
  queueNow = Date.now;
  queueStagingTimeoutMs = DEFAULT_STAGING_TIMEOUT_MS;
  queueTtlMs = DEFAULT_QUEUE_TTL_MS;
  queueDeniedRetentionMs = DEFAULT_DENIED_RETENTION_MS; // W6-3：保留期回缺省 7 天
  prunedDeniedTotal = 0;                                // W6-3：审计计数归零
  queueEntries = [];
  queueLoaded = false;
  queuePersistError = undefined;
  entryConfirmEvidence.clear();                          // ΠΑΝ-1：人证证据归零
}
