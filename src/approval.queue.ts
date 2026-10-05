// src/approval.queue.ts
// approval 队列面（W8-B3 自 approval.ts 拆出 —— 代码逐字保持，零漂移）：
// W2-1（H4 暂存式离线批准队列）的 API 对象（武装/资格透明化/超时入队/批量
// 裁决/续跑消费/晨报摘要/checkpoint 采集恢复/统计）。可变簿记与状态机内脏
// 在 approval.queueState.ts（单写点），类型与存储端口在 approval.queueContracts.ts。
// 架构叙事（触发/通道资格/持久化/晨报/TTL 保守律/续跑/防御式）见
// approval.queueContracts.ts 头注 —— 三文件共同构成「队列面」分区。
import { MAX_QUEUE_ENTRIES, AMENDMENT_NOTE_MAX, MAX_CODE_MISMATCHES } from './approval.constants';
import { strOrUndef, type RawActionShape } from './approval.shapes';
import { grantBucket, castAmendmentFor, confirmChannelArmed, codeMatches } from './approval.security';
import { pending } from './approval.registry';
import type { AdjudicateItemOutcome, ApprovalQueueStorage, QueuedApprovalEntry, StageOutcome } from './approval.queueContracts';
import {
  armQueueState, restoreQueueEntries, resetQueueState,
  ensureQueueLoaded, persistQueue, qNow, newQueueId,
  sanitizeEvidence, cloneEntry, mintResumedToken,
  anchorQueueConfirmEvidence, queueConfirmEvidenceOf, bumpQueueConfirmMismatch, clearQueueConfirmMismatch,
  queueEntries, queueStorage, queueStagingTimeoutMs, queueTtlMs, queueDeniedRetentionMs, prunedDeniedTotal, queuePersistError,
} from './approval.queueState';

/** W2-1（H4）：暂存式离线批准队列（模块单例 —— 插件卸载随闭包消亡） */
export const approvalQueue = {
  /** 武装（幂等）：注入存储/时钟/超时。缺省 = 内存队列 + 真钟 + 5min/24h。
   *  W6-3：deniedRetentionMs 注入已拒条目保留期（缺省 7 天；负值 = 关闭清理）。
   *  组合根挂点见 doctorChannel.wireDoctorVerdictChannel（W2-1 段）。绝不抛。 */
  arm(opts: {
    storage?: ApprovalQueueStorage | null;
    now?: () => number;
    stagingTimeoutMs?: number;
    ttlMs?: number;
    deniedRetentionMs?: number;
  } = {}): void {
    armQueueState(opts);
  },

  /** 暂存资格透明化（request_approval 工具的超时提示事实源） */
  stagingAvailability(): { available: boolean; stagingTimeoutMs: number; ttlMs: number; persistent: boolean } {
    return {
      available: confirmChannelArmed(), // 通道在场 = 宿主在场 = 暂存资格
      stagingTimeoutMs: queueStagingTimeoutMs,
      ttlMs: queueTtlMs,
      persistent: queueStorage !== null,
    };
  },

  /** 超时入队：审批请求无人应答超过暂存超时 ⇒ 不可逆动作连同证据链入待批队列。
   *  防御式拒绝面：通道缺席（维持阻塞审批）/ 令牌缺席或已消费 / 已授予
   *  （交互路径已恢复）/ 未超时（retryInMs）/ 队列封顶。同令牌重复入队幂等
   *  （返回既有条目 + duplicate 标注）。绝不抛。 */
  stageAction(req: {
    token: string;
    description: string;
    evidence?: {
      screenshotRef?: string;
      actionShape?: RawActionShape;
      sceneFingerprint?: string;
      riskTier?: string;
    };
    ttlMs?: number;
    stagingTimeoutMs?: number;
    stepCursor?: number;
  }): StageOutcome {
    try {
      // 通道资格（H4 安全核心）：暂存是「宿主在场但用户离开」的降级，不是
      // 无人值守的越权 —— 带外通道缺席 ⇒ 拒绝，调用方维持现行阻塞审批。
      if (!confirmChannelArmed()) return { ok: false, reason: 'channel-absent' };
      const pa = pending.get(String(req?.token ?? '').trim());
      if (!pa) return { ok: false, reason: 'invalid-token' };
      if (pa.granted) return { ok: false, reason: 'already-granted' };
      const now = qNow();
      const mintedAt = pa.expiresAt - pa.ttlMs; // 铸造时刻（簿记缺 requestedAt 的推导面）
      const timeout = Math.max(0, (typeof req.stagingTimeoutMs === 'number' && Number.isFinite(req.stagingTimeoutMs))
        ? req.stagingTimeoutMs : queueStagingTimeoutMs);
      const elapsed = now - mintedAt;
      if (elapsed < timeout) {
        return { ok: false, reason: 'not-timed-out-yet', retryInMs: Math.max(0, timeout - elapsed) };
      }
      ensureQueueLoaded();
      const existing = queueEntries.find(e => e.token === pa.token);
      if (existing) return { ok: true, entry: cloneEntry(existing), duplicate: true };
      if (queueEntries.length >= MAX_QUEUE_ENTRIES) return { ok: false, reason: 'queue-full' };
      const ttl = Math.max(1_000, (typeof req.ttlMs === 'number' && Number.isFinite(req.ttlMs))
        ? req.ttlMs : queueTtlMs);
      const entry: QueuedApprovalEntry = {
        id: newQueueId(),
        token: pa.token,
        description: strOrUndef(req.description, 200) ?? pa.description,
        evidence: sanitizeEvidence(req.evidence),
        enqueuedAt: now,
        ttlMs: ttl,
        expiresAt: now + ttl,
      };
      if (typeof req.stepCursor === 'number' && Number.isFinite(req.stepCursor) && req.stepCursor >= 0) {
        entry.stepCursor = Math.floor(req.stepCursor);
      }
      queueEntries.push(entry);
      // ΠΑΝ-1：入队时锚定人证证据 —— 触发令牌的确认码哈希随条目快照（仅内存：
      // 见 approval.queueState.ts 的 ΠΑΝ-1 注记）。裁决 grant 臂消费它，与
      // grant_approval 同一人证标准；降级令牌（无哈希）⇒ 条目永不可批量批准。
      if (pa.confirmCodeHash !== undefined) anchorQueueConfirmEvidence(entry.id, pa.confirmCodeHash);
      persistQueue(); // 失败 ⇒ 内存队列仍有效（跨进程降级诚实记录于 queueStats）
      return { ok: true, entry: cloneEntry(entry) };
    } catch {
      return { ok: false, reason: 'internal' }; // 防御式兜底（正常流不可达）
    }
  },

  /** 批注式批量裁决（晨报消费面）：ids 缺省/空 ⇒ 全部待批条目（一次批注一把抓）。
   *  每项 grant 消耗一枚 Y-10 同意预算（桶空 ⇒ 该项 rate-limited 保持待批）；
   *  deny 恒可（过期条目也可拒 —— 用户清场的出口）；grant 过期条目保守拒绝
   *  （ttl-expired —— 须重走完整审批）。已裁决条目拒绝翻案。绝不抛。
   *
   *  ΠΑΝ-1（裁决人证补全 —— 模型自批链封堵）：grant 臂必须携带**带外确认码**
   *  （入队时锚定的确认码哈希在裁决时被消费 —— 与 grant_approval 的
   *  grantDetailed 完全同一人证标准：码由 request_approval 铸造并只经带外通道
   *  投给人类，模型上下文不可见 ⇒ 模型无法伪造「用户已同意」）。执法序：
   *    ① 无证据锚（铸造即降级 / 跨进程恢复面）⇒ 'confirm-channel-absent'；
   *    ② 未携码 ⇒ 'confirm-code-required'（非错误尝试，不计封顶）；
   *    ③ 码不匹配 ⇒ 'confirm-code-mismatch'（封顶 MAX_CODE_MISMATCHES 次 ⇒
   *       条目焚毁 'code-attempts-exhausted' —— 防暴力枚举，与 ledger 同律）；
   *    ④ 码通过 ⇒ Y-10 tryTake（限速是**补充不是替代**人证 —— 码校验刻意
   *       在桶之前：错码不烧同意预算，与 grantDetailed 同序）。
   *  通道缺席或码不匹配一律 fail-closed 结构化拒绝（绝不抛）。deny 不需要
   *  人证（保守方向：拒绝永远可行）。confirmCode 形态：string = 施于本批全部
   *  条目（单条目裁决的人体工学形态）；Record<条目id, string> = 逐条目各交
   *  各码（批量裁决 —— 每个条目锚定的是各自触发令牌的码）。 */
  adjudicate(ids: unknown, grant: boolean, note?: string, confirmCode?: string | Record<string, string>): {
    results: Array<{ id: string; outcome: AdjudicateItemOutcome; retryInMs?: number }>;
    persisted: boolean;
  } {
    try {
      ensureQueueLoaded();
      const wanted: string[] = (Array.isArray(ids) ? ids : [ids])
        .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        .map(x => x.trim());
      const cleanNote = strOrUndef(note, AMENDMENT_NOTE_MAX);
      // ΠΑΝ-1：码解析（防御式 —— 非法形态一律按未携码处理，绝不抛）
      const codeFor = (id: string): string => {
        if (typeof confirmCode === 'string') return confirmCode.trim();
        if (confirmCode && typeof confirmCode === 'object' && !Array.isArray(confirmCode)) {
          const v = (confirmCode as Record<string, unknown>)[id];
          if (typeof v === 'string') return v.trim();
        }
        return '';
      };
      const targets = wanted.length > 0
        ? wanted
        : queueEntries.filter(e => e.decision === undefined).map(e => e.id);
      const results: Array<{ id: string; outcome: AdjudicateItemOutcome; retryInMs?: number }> = [];
      const seen = new Set<string>();
      let mutated = false;
      for (const id of targets) {
        if (seen.has(id)) continue; // 同 id 重复出现只裁一次（防御式去重）
        seen.add(id);
        const entry = queueEntries.find(e => e.id === id);
        if (!entry) { results.push({ id, outcome: 'unknown-id' }); continue; }
        if (entry.decision !== undefined) { results.push({ id, outcome: 'already-decided' }); continue; }
        const now = qNow();
        if (grant) {
          if (now > entry.expiresAt) {
            // TTL 保守律：过期不自动作废、也不可批 —— 陈年同意不可兑换成不可逆操作
            results.push({ id, outcome: 'ttl-expired' });
            continue;
          }
          // ΠΑΝ-1：人证执法（先于 Y-10 —— 完整语义见方法头注）
          const evidence = queueConfirmEvidenceOf(entry.id);
          if (evidence === undefined) {
            // fail-closed：无带外码锚点就没有同意（通道缺席/降级铸造/跨进程恢复）
            results.push({ id, outcome: 'confirm-channel-absent' });
            continue;
          }
          const provided = codeFor(id);
          if (!provided) {
            results.push({ id, outcome: 'confirm-code-required' });
            continue;
          }
          if (!codeMatches(provided, evidence.hash)) {
            const mismatches = bumpQueueConfirmMismatch(entry.id);
            if (mismatches >= MAX_CODE_MISMATCHES) {
              // 枚举封顶：条目焚毁（与令牌同律 —— 重新走 request_approval 带外铸造）
              const i = queueEntries.indexOf(entry);
              if (i >= 0) queueEntries.splice(i, 1);
              mutated = true; // 焚毁须落盘（证据行随 persistQueue 同步清扫）
              results.push({ id, outcome: 'code-attempts-exhausted' });
              continue;
            }
            results.push({ id, outcome: 'confirm-code-mismatch' });
            continue;
          }
          clearQueueConfirmMismatch(entry.id); // 匹配即清零（尝试簇语义 —— ledger 同律）
          const rate = grantBucket.tryTake();
          if (!rate.ok) {
            results.push({ id, outcome: 'rate-limited', retryInMs: rate.retryInMs });
            continue;
          }
          entry.decision = {
            verdict: 'granted', at: now,
            ...(cleanNote !== undefined ? { amendment: castAmendmentFor(entry.description, cleanNote, now) } : {}),
          };
          results.push({ id, outcome: 'granted' });
        } else {
          entry.decision = {
            verdict: 'denied', at: now,
            ...(cleanNote !== undefined ? { amendment: castAmendmentFor(entry.description, cleanNote, now) } : {}),
          };
          results.push({ id, outcome: 'denied' });
        }
        mutated = true;
      }
      const persisted = mutated ? persistQueue().ok : true;
      return { results, persisted };
    } catch {
      return { results: [], persisted: false }; // 防御式兜底：故障 = 零裁决（保守方向）
    }
  },

  /** 续跑消费：取最早已批未消费条目并铸造已授予执行令牌。
   *  落盘先行 —— 持久化失败 ⇒ 拒绝交出执行权（宁可保守不可双发：崩溃后条目
   *  重现于晨报，用户重裁）。无已批条目 ⇒ null。绝不抛。
   *  ΠΑΝ-2（陈年同意复查）：granted 条目被 take 时以**当前时钟**重验 TTL ——
   *  裁决时刻与消费时刻之间可能隔着持久化/checkpoint 的任意长间隙，第 0 天
   *  的同意不得在任意晚的时刻铸成执行令牌（TTL 保守律的 take 面执法）。
   *  过期 granted 条目即拒绝并清理出队（清理落盘；过期判定单调 —— 持久化
   *  失败也只是下个进程再清一次，绝不复活）。 */
  takeGranted(): { entry: QueuedApprovalEntry; executionToken: string } | null {
    try {
      ensureQueueLoaded();
      // ΠΑΝ-2：过期 granted 清理（倒序 splice 安全；先清理再取 —— 陈年条目
      // 不可越过新鲜条目被 take，也不留在队列里冒充可续跑账面）
      const now = qNow();
      let cleanedStale = false;
      for (let i = queueEntries.length - 1; i >= 0; i--) {
        const e = queueEntries[i];
        if (e.decision !== undefined && e.decision.verdict === 'granted' && now > e.expiresAt) {
          queueEntries.splice(i, 1);
          cleanedStale = true;
        }
      }
      if (cleanedStale) persistQueue();
      const idx = queueEntries.findIndex(e => e.decision !== undefined && e.decision.verdict === 'granted');
      if (idx < 0) return null;
      const entry = queueEntries[idx];
      queueEntries.splice(idx, 1);
      if (!persistQueue().ok) {
        queueEntries.splice(idx, 0, entry); // 回滚内存面（盘面未动 —— 双面一致）
        return null;
      }
      return { entry: cloneEntry(entry), executionToken: mintResumedToken(entry) };
    } catch {
      return null; // 防御式兜底：续跑消费失败 = 不执行（保守方向）
    }
  },

  /** 晨报摘要面（sleep 第⑥幕消费）：待批清单 + 过期标注 + 已批待续跑计数。
   *  items = 全部未裁决条目（含过期 —— 过期也要唠叨，直到用户显式 deny）。
   *  ΠΑΝ-4：absorbedByInteractive = 已被交互式 grant 吸收的终态条目数
   *  （不可再续跑 —— 与 grantedAwaitingResume 分账，晨报不误导「还有可续跑
   *  的已批动作」）。 */
  pendingSummary(): {
    pending: number;
    expired: number;
    grantedAwaitingResume: number;
    /** ΠΑΝ-4 终态分账（可选面 —— 加法字段不增键：外部字面量构造/净化层
     *  缺席合法，真实实现恒携带） */
    absorbedByInteractive?: number;
    deniedAwaitingPrune: number;
    items: Array<{
      id: string;
      description: string;
      enqueuedAt: number;
      expiresAt: number;
      ttlExpired: boolean;
      riskTier?: string;
      actionTool?: string;
      screenshotRef?: string;
      sceneFingerprint?: string;
    }>;
  } {
    ensureQueueLoaded();
    const now = qNow();
    let pending = 0, expired = 0, grantedAwaitingResume = 0, absorbedByInteractive = 0, deniedAwaitingPrune = 0;
    const items: Array<{
      id: string; description: string; enqueuedAt: number; expiresAt: number; ttlExpired: boolean;
      riskTier?: string; actionTool?: string; screenshotRef?: string; sceneFingerprint?: string;
    }> = [];
    for (const e of queueEntries) {
      if (e.decision === undefined) {
        const ttlExpired = now > e.expiresAt;
        if (ttlExpired) expired++; else pending++;
        items.push({
          id: e.id,
          description: e.description,
          enqueuedAt: e.enqueuedAt,
          expiresAt: e.expiresAt,
          ttlExpired,
          ...(e.evidence.riskTier !== undefined ? { riskTier: e.evidence.riskTier } : {}),
          ...(e.evidence.actionShape !== undefined ? { actionTool: e.evidence.actionShape.tool } : {}),
          ...(e.evidence.screenshotRef !== undefined ? { screenshotRef: e.evidence.screenshotRef } : {}),
          ...(e.evidence.sceneFingerprint !== undefined ? { sceneFingerprint: e.evidence.sceneFingerprint } : {}),
        });
      } else if (e.decision.verdict === 'granted') grantedAwaitingResume++;
      else if (e.decision.verdict === 'absorbed') absorbedByInteractive++; // ΠΑΝ-4 终态分账
      else deniedAwaitingPrune++;
    }
    return { pending, expired, grantedAwaitingResume, absorbedByInteractive, deniedAwaitingPrune, items };
  },

  /** checkpoint 采集面：队列快照（深拷贝 —— 采集后队列继续演化互不影响） */
  dumpQueue(): QueuedApprovalEntry[] {
    ensureQueueLoaded();
    return queueEntries.map(cloneEntry);
  },

  /** checkpoint 恢复面（防御性恢复 —— 垃圾值归零）：整段垃圾 ⇒ 空队列；
   *  条目级垃圾 ⇒ 弃置坏条目保住好条目（不连坐）。绝不抛。 */
  restoreQueue(rawEntries: unknown): { kept: number; dropped: number } {
    return restoreQueueEntries(rawEntries);
  },

  /** 透明化（测试/遥测面）：队列规模与最近一次持久化错误。
   *  W6-3：prunedDenied = 本生命周期已清理的 denied 条目累计（审计留痕面 ——
   *  条目从晨报消失，账面长存；0 = 尚无清理）。 */
  queueStats(): {
    entries: number; pending: number; decided: number;
    storageArmed: boolean; stagingTimeoutMs: number; ttlMs: number;
    deniedRetentionMs: number; prunedDenied: number;
    persistError?: string;
  } {
    ensureQueueLoaded();
    return {
      entries: queueEntries.length,
      pending: queueEntries.filter(e => e.decision === undefined).length,
      decided: queueEntries.filter(e => e.decision !== undefined).length,
      storageArmed: queueStorage !== null,
      stagingTimeoutMs: queueStagingTimeoutMs,
      ttlMs: queueTtlMs,
      deniedRetentionMs: queueDeniedRetentionMs,
      prunedDenied: prunedDeniedTotal,
      ...(queuePersistError !== undefined ? { persistError: queuePersistError } : {}),
    };
  },
};

/** W2-1（H4）：队列武装的独立函数面（组合根挂点 —— 与 setConfirmCodeChannel
 *  同风格；doctorChannel.wireDoctorVerdictChannel 顺带调用）。绝不抛。 */
export function armApprovalQueue(opts: {
  storage?: ApprovalQueueStorage | null;
  now?: () => number;
  stagingTimeoutMs?: number;
  ttlMs?: number;
  deniedRetentionMs?: number;
} = {}): void {
  approvalQueue.arm(opts);
}
