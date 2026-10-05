// src/approval.ledger.ts
// approval 主账本（W8-B3 自 approval.ts 拆出 —— 代码逐字保持，零漂移）：
// `approval` 对象全方法 —— 铸造（request）、用户裁决（grant/grantDetailed，
// W6R fail-closed 与 S2 码校验的执法点）、状态/校验/验收式消费（consume/
// beginAttempt/attemptFailed）、批注读取（amendmentOf/applyAmendment）、
// 分级随行查询（reversibilityOf/dispatchLaneOf）与清扫（sweep）。
// 安全语义总注记见 src/approval.ts 桶文件头；本簇分区索引亦在彼处。
import { TTL_MS, MAX_ATTEMPTS, LIFETIME_MULTIPLIER, MAX_CODE_MISMATCHES } from './approval.constants';
import { sanitizeActionShape, strOrUndef, normalizeToken, type RawActionShape } from './approval.shapes';
import { newToken, deliverConfirmCode, codeMatches, castAmendment, grantBucket } from './approval.security';
import {
  computeTargetDigest, digestsEqual, bindTokenTarget, boundTargetOf, forgetTokenTarget,
  recordTargetRejection, sweepApprovalSecurityState,
} from './approval.security';
import type { GrantOutcome, ApprovalAmendment, TargetHint } from './approval.security';
import { emitDemonstration, fireEscrowSettlement, escrowBlockedByGate } from './approval.bypass';
import type { BeginAttemptOpts } from './approval.bypass';
import { recordTokenDecision, queueEntries, ensureQueueLoaded } from './approval.queueState';
import { pending } from './approval.registry';
import type { PendingApproval, ReversibilityCarry } from './approval.registry';
import { dispatchLaneFor } from './riskGate';
import type { ReversibilityLevel, DispatchLane } from './riskGate';

/** ΠΑΝ-5：目标绑定闸门 —— 携带绑定的令牌在兑换时点（validate/beginAttempt/
 *  consume）强制比对 targetHint（macaroon 式 caveat：铸造时嵌入目标摘要，兑换时
 *  摘要比对）。返回 null = 放行（令牌未携带绑定 ⇒ 兼容律零行为；或绑定匹配）；
 *  否则结构化拒绝理由。拒绝先于一切簿记变异（与 escrow 前置闸门同律），并记
 *  targetRejectionOf 透明化（派发层组装拒绝指引的事实源）。
 *  不匹配不焚毁令牌：合法持有者携正确提示可再来；能通过比对的唯一方式是
 *  实际派发与用户批准的目标在规范化域内一致 —— 这正是绑定要 guarantee 的命题。 */
function targetBindingCheck(token: string, hint?: TargetHint): 'target-hint-required' | 'target-mismatch' | null {
  const bound = boundTargetOf(token);
  if (bound === undefined) return null; // ΠΑΝ-5 兼容律：未携带绑定 ⇒ 一切既有行为不变
  const received = hint === undefined ? undefined : computeTargetDigest(hint);
  if (hint === undefined || received === undefined || !digestsEqual(bound, received)) {
    const reason = hint === undefined ? 'target-hint-required' : 'target-mismatch';
    recordTargetRejection({
      token,
      reason,
      expectedPrefix: bound.slice(0, 8),
      receivedPrefix: received === undefined ? 'n/a' : received.slice(0, 8),
      at: Date.now(),
    });
    return reason;
  }
  return null;
}

/** ΠΑΝ-6：队列在途条目只读探针（防御式 —— 队列面故障 = 探针缺席 = 走既有
 *  兼容语义，绝不因探针炸裁决主流程）。词表与队列契约面对齐：undecided /
 *  granted / denied / absorbed（ΠΑΝ-4 终态：已被交互式 grant 兑现）。绝不抛。 */
function queueEntryStateOf(token: string): 'undecided' | 'granted' | 'denied' | 'absorbed' | 'absent' {
  try {
    ensureQueueLoaded();
    const entry = queueEntries.find(e => e.token === token);
    if (entry === undefined) return 'absent';
    if (entry.decision === undefined) return 'undecided';
    return entry.decision.verdict;
  } catch {
    return 'absent'; // 防御式：队列故障 = 无在途条目（与 recordTokenDecision 的旁路吞错同律）
  }
}

export const approval = {
  /** 发起审批：返回待确认的令牌（未生效 —— granted=false 直到 grant）。
   *  V 纪元：ttlMs/maxAttempts 可由部署配置注入（config.approvalTokenTtlMs /
   *  approvalMaxAttempts），缺省用本模块常量。
   *  Τ 纪元：opts.actionShape/sceneFingerprint 在铸造时快照（形状即刻脱敏 ——
   *  type_text 只记工具名+长度桶；未提供 ⇒ 字段诚实缺席，教育旁路零参与）。
   *  ΠΑΝ-5（能力限缩令牌）：opts.target 在场 ⇒ 铸造即绑定目标摘要
   *  （tool + 归一化坐标 + 目标描述的规范化 sha256）——此后 validate/
   *  beginAttempt/consume 携带不匹配 targetHint 即被拒（macaroon 式 caveat）。
   *  兼容律：target 缺席（既有全部调用方）⇒ 令牌不携带绑定 ⇒ 行为逐位不变；
   *  target 为垃圾输入（无可规范化身份）⇒ 绑定诚实缺席（同兼容面 —— 需要
   *  强制绑定的调用方用 mintBoundToken，垃圾输入结构化拒绝）。
   *  ΠΑΝ-7：description 非字符串防御式字符串化（模型可调面的类型收口，绝不抛）。 */
  request(description: string, opts?: {
    ttlMs?: number; maxAttempts?: number;
    actionShape?: RawActionShape; sceneFingerprint?: string;
    /** W4-3（S5）：可逆性分级随行（reversibilityRegistry.classify 的产出；
     *  脏级别（不在三级域）⇒ 诚实弃置不携带 —— 绝不伪造分级）。 */
    reversibility?: ReversibilityCarry;
    /** ΠΑΝ-5：目标绑定（能力限缩）—— {tool, x?, y?, target_description?}；
     *  type_text 类 text 仅瞬态参与长度桶计算，绝不驻留。 */
    target?: RawActionShape;
  }): PendingApproval {
    const ttl = Math.max(1_000, opts?.ttlMs ?? TTL_MS);
    const pa: PendingApproval = {
      token: newToken(),
      description: typeof description === 'string' ? description : String(description ?? ''), // ΠΑΝ-7 防御
      expiresAt: Date.now() + ttl,
      granted: false,
      attempts: 0,
      maxAttempts: Math.max(1, opts?.maxAttempts ?? MAX_ATTEMPTS),
      ttlMs: ttl,
      lifetimeCapAt: Date.now() + ttl * LIFETIME_MULTIPLIER,
      actionShape: opts?.actionShape ? sanitizeActionShape(opts.actionShape) : undefined,
      sceneFingerprint: opts?.sceneFingerprint,
    };
    // W4-3（S5）：分级载荷防御性携带（级别域校验 + 截断；缺席 ⇒ 零行为）
    if (opts?.reversibility && typeof opts.reversibility === 'object') {
      const lv = opts.reversibility.level;
      if (lv === 'reversible' || lv === 'compensable' || lv === 'irreversible') {
        const semantics = strOrUndef(opts.reversibility.semantics, 64);
        const source = strOrUndef(opts.reversibility.source, 32);
        pa.reversibility = { level: lv, ...(semantics !== undefined ? { semantics } : {}), ...(source !== undefined ? { source } : {}) };
      }
    }
    // ΠΑΝ-5：绑定信息只在新的铸造路径写入（兼容律的执法点）
    if (opts?.target !== undefined) {
      const digest = computeTargetDigest(opts.target);
      if (digest !== undefined) bindTokenTarget(pa.token, digest);
    }
    // W1-2（S2）：带外确认码铸造 —— 通道在场且投递成功 ⇒ 簿记只留 sha256
    // （明文已随投递离开模块）；通道缺席/投递失败 ⇒ 记 degraded（诚实标记）——
    // W6R fail-closed：该令牌不可被 grant（grantDetailed 返回
    // confirm-channel-absent；无码同意通道已废除，屏幕注入文本无法自批）。
    const confirmCodeHash = deliverConfirmCode(pa);
    if (confirmCodeHash !== undefined) pa.confirmCodeHash = confirmCodeHash;
    else pa.degraded = true;
    pending.set(pa.token, pa);
    return pa;
  },

  /** ΠΑΝ-5：能力限缩铸造的严格面 —— target 必须携带可用身份（tool 为非空字符串），
   *  否则结构化拒绝（绝不静默铸造一枚无绑定的全能力令牌：限缩请求被垃圾输入
   *  降级为放行是 fail-open）。其余语义与 request 完全同律。绝不抛。 */
  mintBoundToken(description: string, opts: {
    ttlMs?: number; maxAttempts?: number;
    actionShape?: RawActionShape; sceneFingerprint?: string;
    reversibility?: ReversibilityCarry;
    target: RawActionShape;
  }): { ok: true; pa: PendingApproval } | { ok: false; reason: 'invalid-target' } {
    const digest = computeTargetDigest(opts?.target);
    if (digest === undefined) return { ok: false, reason: 'invalid-target' };
    const pa = approval.request(description, opts);
    bindTokenTarget(pa.token, digest); // request 内已绑定同一摘要；此处显式复执防御式对齐
    return { ok: true, pa };
  },

  /** 用户裁决（grant_approval 工具的落点）：
   *  grant=true ⇒ 令牌激活（在 TTL 内可被动作消费）；
   *  grant=false ⇒ 立即作废（等价 revoke）。返回令牌是否在场。
   *  Y-10：grant=true 须同时通过令牌桶 —— 同意的速率上限。
   *  W1-2：布尔投影保持旧签名/旧语义零变化（直调调用方与既有测试原样通过）；
   *  S2 码校验与 H1 批注的丰富裁决面在 grantDetailed。
   *  W6R fail-closed：degraded 令牌（带外通道缺席/投递失败铸造）的 grant=true
   *  投影为 false —— 布尔面同样不再有「无码成功」。 */
  grant(token: string, g: boolean): boolean {
    return approval.grantDetailed(token, g).ok;
  },

  /** W1-2（S2+H1）：完整裁决通道（grant_approval 工具的新落点）。
   *  S2：带码审批（confirmCodeHash 在场）必须携匹配 confirmCode 才置
   *  granted —— 恒定时间比较（不泄露哪一位错）、错码封顶焚毁（防枚举）、
   *  「码错误」与「令牌无效」错误码刻意区分（上层可给正确的重试指引，
   *  比较本身零信息泄露）。
   *  W6R fail-closed：degraded 令牌（无 confirmCodeHash —— 带外通道缺席/
   *  投递失败时铸造）的 grant=true 一律拒绝（reason='confirm-channel-absent'，
   *  令牌保留 —— 通道恢复后不可补投：人证缺席期间的「同意」无法追认，
   *  须重新 request_approval 铸造新码）。旧实现降级为无码 grant 是 fail-open
   *  （grant_approval 是模型可调工具，屏幕注入文本可驱动 request→grant→click
   *  全链自批不可逆操作）—— 本分支是那次安全修复的执法点。
   *  H1：note（用户批注）铸为结构化 amendment patch 挂上令牌 ——
   *  同意与「照原计划执行」从此可分离；拒绝路径同样可携批注（否决理由
   *  随负示范事件蒸馏）。 */
  grantDetailed(token: string, g: boolean, opts?: { confirmCode?: string; note?: string }): GrantOutcome {
    // ΠΑΝ-7：非字符串 token（模型输出的任意 JSON）⇒ '' ⇒ 簿记必然缺席 ⇒
    // 结构化拒绝（旧实现 (token||'').trim() 对非字符串真值抛 TypeError —— 违宪）。
    const pa = pending.get(normalizeToken(token));
    if (!pa) return { ok: false, reason: 'invalid-token' };
    if (!g) {
      // H1：否决附批注 —— 先铸入，负示范事件随后携带（最强负示范）。
      // 否决不需要人证（保守方向：拒绝永远可行 —— 任何时刻喊停都是合法的）。
      // ΠΑΝ-7：note 非字符串由 castAmendment 防御式字符串化（绝不抛）。
      if (opts?.note) pa.amendment = castAmendment(pa, opts.note);
      pending.delete(pa.token);
      recordTokenDecision(pa.token, false, opts?.note); // W2-1（H4）：在途队列条目同步裁决
      emitDemonstration(pa, 'approval-denied'); // Τ：用户否决 = 负示范（旁路）
      return { ok: true };
    }
    if (Date.now() > pa.expiresAt) {
      pending.delete(pa.token);
      return { ok: false, reason: 'invalid-token' };
    }
    // W6R fail-closed：带外通道缺席/投递失败铸造的令牌（degraded，无
    // confirmCodeHash）不可被 grant —— 没有带外人证就没有同意。置于码校验与
    // 令牌桶之前（拒绝不烧任何预算；令牌保留在簿上供 status 透明化检视，
    // 但直至过期都不可授予）。用户出路：经宿主 UI（带外事件挂点）完成人工
    // 确认，或等宿主武装通道后重新 request_approval。
    if (pa.confirmCodeHash === undefined) {
      return { ok: false, reason: 'confirm-channel-absent' };
    }
    // ΠΑΝ-6（双通道双花封堵 · ledger 侧 / 窗口乙）：该同意已由队列裁决面兑付在途
    //（条目已被 adjudicate(grant=true) 置 granted —— Y-10 已在裁决时计费）⇒ 交互面
    // 不得再武装第二条兑现通道，否则一次同意可经「交互令牌 + 续跑铸造令牌」两次
    // 物理兑现（C1-1 H3）。拒绝置于码校验与令牌桶之前（不烧码封顶、不烧 Y-10 ——
    // 与 W6R 同律：结构性拒绝不烧任何预算）。用户出路：动作将随后续跑通道执行
    //（takeGranted），无需再次同意。
    //（反向窗口甲 —— 暂存令牌被交互式 grant —— 由队列面 ΠΑΝ-4 以 'absorbed'
    //  终态封堵：传播裁决不再是 granted，交互令牌本尊是该份同意的唯一执行载体。
    //  两侧合璧 = 无论裁决先落在哪一面，同一份同意永远只有一条兑现通道。）
    if (queueEntryStateOf(pa.token) === 'granted') {
      return { ok: false, reason: 'queue-granted-already' };
    }
    // S2：带外人证 —— 码不匹配不得授予（顺序刻意在令牌桶之前：错码不该
    // 烧掉 Y-10 同意预算；枚举封顶兜住暴力面）
    if (pa.confirmCodeHash !== undefined) {
      const provided = typeof opts?.confirmCode === 'string' ? opts.confirmCode.trim() : '';
      if (!provided) return { ok: false, reason: 'confirm-code-required' };
      if (!codeMatches(provided, pa.confirmCodeHash)) {
        pa.codeMismatches = (pa.codeMismatches ?? 0) + 1;
        if (pa.codeMismatches >= MAX_CODE_MISMATCHES) {
          pending.delete(pa.token); // 枚举封顶：焚毁，重新走带外铸造
          return { ok: false, reason: 'code-attempts-exhausted' };
        }
        return { ok: false, reason: 'confirm-code-mismatch' };
      }
      pa.codeMismatches = 0; // 匹配即清零（错误计数是尝试簇，不是终身累计）
    }
    const rate = grantBucket.tryTake();
    if (!rate.ok) {
      pa.rateLimitedForMs = rate.retryInMs;
      return { ok: false, reason: 'rate-limited', retryInMs: rate.retryInMs };
    }
    // H1：同意但修正计划 —— 批注在置 granted 前铸入（amendment 随后的
    // validate/beginAttempt/consume 生命周期全程在场）
    if (opts?.note) pa.amendment = castAmendment(pa, opts.note);
    pa.granted = true;
    recordTokenDecision(pa.token, true, opts?.note); // W2-1（H4）+ ΠΑΝ-4：在途条目同步裁决为 'absorbed' 终态（Y-10 已在此计费，不重复扣；队列面实现）
    return { ok: true };
  },

  /** 令牌状态（未消费）：granted 且未过期才有效。
   *  W1-2 透明化附加面（仅在场令牌）：confirmCodeRequired（S2 带码审批）、
   *  degraded（带外通道缺席/投递失败 —— W6R：该令牌不可被 grant）、
   *  amended（H1 批注在场）。
   *  ΠΑΝ-5 透明化（键仅在场时出现 —— 既有 deepEqual 断言零破坏）：
   *  targetBound（令牌携带目标绑定 —— 兑换时强制比对 targetHint）。 */
  status(token: string): { present: boolean; granted: boolean; expired: boolean; attempts?: number; remainingAttempts?: number; confirmCodeRequired?: boolean; degraded?: boolean; amended?: boolean; reversibilityLevel?: ReversibilityLevel; reversibilitySemantics?: string; targetBound?: boolean } {
    const pa = pending.get(normalizeToken(token));
    if (!pa) return { present: false, granted: false, expired: false };
    return {
      present: true,
      granted: pa.granted,
      expired: Date.now() > pa.expiresAt,
      attempts: pa.attempts,
      remainingAttempts: Math.max(0, pa.maxAttempts - pa.attempts),
      confirmCodeRequired: pa.confirmCodeHash !== undefined,
      degraded: pa.degraded === true,
      amended: pa.amendment !== undefined,
      // W4-3（S5）：分级随行透明化（缺席令牌面不增键 —— 既有 deepEqual 断言零破坏）
      ...(pa.reversibility !== undefined ? { reversibilityLevel: pa.reversibility.level } : {}),
      ...(pa.reversibility?.semantics !== undefined ? { reversibilitySemantics: pa.reversibility.semantics } : {}),
      // ΠΑΝ-5：绑定透明化（未绑定 ⇒ 键缺席 —— 兼容面零变化）
      ...(boundTargetOf(pa.token) !== undefined ? { targetBound: true } : {}),
    };
  },

  /** W4-3（S5）：分级读取面（派发层按级分道的事实源 —— dispatchLaneOf 的
   *  伴生查询）。令牌缺席 / 未携带分级 ⇒ null（诚实缺席，绝不伪造）。 */
  reversibilityOf(token: string): ReversibilityCarry | null {
    const pa = pending.get(normalizeToken(token));
    return pa?.reversibility ? { ...pa.reversibility } : null;
  },

  /** W4-3（S5）：分道查询（reversibilityOf × dispatchLaneFor 的组合面 ——
   *  派发层单点消费：级别 → 派发要求）。未携带分级 ⇒ null（不替调用方默认 ——
   *  分级必须显式携带或显式放弃，保守律在 classify 面执法）。 */
  dispatchLaneOf(token: string): DispatchLane | null {
    const rev = approval.reversibilityOf(token);
    return rev === null ? null : dispatchLaneFor(rev.level);
  },

  /** 非消费校验（阶段一 validate）：granted 且未过期才有效，令牌保留可重试。
   *  ΠΑΝ-5：可选 targetHint —— 令牌携带绑定时强制比对（缺席/不匹配 ⇒ false，
   *  结构化理由见 validateDetailed / targetRejectionOf）；未携带绑定的令牌
   *  ⇒ hint 缺席与否都不影响（兼容律）。ΠΑΝ-7：非字符串 token ⇒ false（绝不抛）。 */
  validate(token: string, targetHint?: TargetHint): boolean {
    return approval.validateDetailed(token, targetHint).ok;
  },

  /** ΠΑΝ-5：validate 的结构化面 —— 派发层/工具层组装拒绝指引的事实源
   *  （错误码刻意区分成因，与 GrantOutcome 同律）。绝不抛、无簿记副作用。 */
  validateDetailed(token: string, targetHint?: TargetHint): { ok: true } | {
    ok: false;
    reason: 'invalid-token' | 'not-granted' | 'expired' | 'target-hint-required' | 'target-mismatch';
  } {
    const pa = pending.get(normalizeToken(token));
    if (!pa) return { ok: false, reason: 'invalid-token' };
    if (!pa.granted) return { ok: false, reason: 'not-granted' };
    if (Date.now() > pa.expiresAt) return { ok: false, reason: 'expired' };
    const binding = targetBindingCheck(pa.token, targetHint);
    if (binding !== null) return { ok: false, reason: binding };
    return { ok: true };
  },

  /** 消费令牌（验收通过路径调用）：granted 且未过期才放行，用后即焚。
   *  V 纪元：这是「验收通过」的落点 —— 世界出现了预期变化，用户的这一份
   *  同意已被兑现为一次不可逆操作，用后即焚。
   *  Τ 纪元：仅在消费**成功**时发射正示范事件（用户背书+世界验证的双重证据）；
   *  无效/过期/未授予的消费拒绝不发射（世界没变，教育无从谈起）。
   *  ΠΑΝ-5：可选 targetHint —— 携带绑定的令牌强制比对；不匹配 ⇒ false 且
   *  **不焚毁**（不匹配 ≠ 验收通过；合法持有者携正确提示可再来 —— 拒绝先于
   *  焚毁，与 beginAttempt 的「拒绝先于簿记变异」同律）。
   *  ΠΑΝ-7：非字符串 token ⇒ false（绝不抛）。 */
  consume(token: string, targetHint?: TargetHint): boolean {
    const pa = pending.get(normalizeToken(token));
    if (!pa) return false;
    const binding = targetBindingCheck(pa.token, targetHint); // ΠΑΝ-5
    if (binding !== null) return false;
    pending.delete(pa.token); // 用后即焚：即使校验失败也不留第二次机会
    forgetTokenTarget(pa.token); // ΠΑΝ-5：伴随绑定账随焚毁离场（内存卫生）
    const consumed = pa.granted && Date.now() <= pa.expiresAt;
    if (consumed) emitDemonstration(pa, 'approval-consumed'); // Τ：特权正示范（旁路）
    // W3-1（S1）：验收通过 = 世界出现预期变化 —— 托管预案关闭（无需补偿）。
    // 仅 consumed 路径发射（无效消费 ≠ 验收通过）；旁路义务，异常全吞。
    if (consumed) fireEscrowSettlement(pa.token, 'verified');
    return consumed;
  },

  /** Δ 纪元（审计#2·双花窗口封堵）：派发预留 —— 必须在物理动作派发**之前**、
   *  与派发调用之间零 await 地调用（clickMouse 已按此接线）。
   *  时序背景：validate（只查不烧）与验收式消费（consume/attemptFailed）之间
   *  隔着多个 await —— 并发两次同令牌调用都能通过 validate 并各自派发物理
   *  点击，预算计数事后才补，双花窗口敞开。
   *  语义：
   *    · 无效/过期/未授予 ⇒ false（顺手焚毁僵尸令牌，与 attemptFailed 同律）；
   *    · 已有在途预留（inFlight>0）⇒ false —— 一次同意同时只担保一个在途物理
   *      回合，并发的第二次派发在落到物理世界之前即被拒（恰一次派发）；
   *    · attempts+1 后越过 maxAttempts ⇒ 焚毁并 false（重试预算在**派发前**
   *      执法 —— 旧实现先派发后计数，第 maxAttempts+1 次点击仍会落到物理世界）。
   *  计数时序（单次点击全链路 attempts 恰 +1）：
   *    beginAttempt 预留 +1 → 验收通过 ⇒ consume（焚毁，计数随行）；
   *    验收失败/派发异常 ⇒ attemptFailed（释放预留，**不再重复 ++**）。
   *  maxAttempts 语义保留：未走 beginAttempt 的直接 attemptFailed 调用维持
   *  既有自增语义（测试与旧路径的事实源不变）。
   *  W3-1（S1 逆转托管）：可选 opts.escrow —— 派发层携托管预案调用时，前置
   *  闸门先行校验（无预案/无效/错配/TTL 过 ⇒ false，fail-closed 且**不烧任何
   *  预算与令牌** —— 拒绝置于一切簿记变异之前）；缺省不带 opts ⇒ 零行为。
   *  ΠΑΝ-5：opts.target —— 令牌携带绑定时强制比对（缺席/不匹配 ⇒ false，
   *  拒绝先于一切簿记变异：不烧 attempts、不占 inFlight；透明化见
   *  targetRejectionOf）；未携带绑定 ⇒ 零行为（兼容律）。
   *  ΠΑΝ-8：托管闸门已武装 + 令牌携带 irreversible 分级 + 裸派发（不携
   *  opts.escrow）⇒ false（plan-required —— M6 死闸门复活：配置承诺了托管
   *  保护的部署里，不可逆动作绝无「跳过铸造直接派发」）。 */
  beginAttempt(token: string, opts?: BeginAttemptOpts): boolean {
    // W3-1：托管前置闸门 —— 「没有逆转预案就绝无派发预留」的执法点。
    // 策略表查不到补偿路径的拒绝发生在铸造面（reversalEscrow.mintPlan
    // fail-closed），此处兜底的是「跳过铸造直接派发」的路径。
    // （W8-B3 拆分：守卫块逐字移入 approval.bypass.escrowBlockedByGate ——
    //  语义零变化：钩子未注册/不携预案 ⇒ 零行为；拦截 ⇒ 记 lastEscrowBlock
    //  并 false，拒绝先于一切簿记变异。ΠΑΝ-7：token 先经类型收口再进门。）
    const tok = normalizeToken(token);
    if (escrowBlockedByGate(tok, opts?.escrow)) {
      return false;
    }
    const pa = pending.get(tok);
    if (!pa || !pa.granted || Date.now() > pa.expiresAt) {
      if (pa) pending.delete(pa.token); // 过期/无效即焚，不留僵尸
      return false;
    }
    // ΠΑΝ-5：目标绑定闸门（拒绝先于 inFlight/attempts 一切簿记变异 —— 与
    // escrow 闸门同律；被拒的派发不产生任何物理世界副作用）
    if (targetBindingCheck(pa.token, opts?.target) !== null) {
      return false;
    }
    // ΠΑΝ-8：反向验证 —— 闸门已武装（reversalEscrow.arm 已注册 hook）且令牌
    // 携带 irreversible 分级时，裸派发（不携 escrow opts）即拦（plan-required）。
    // 仅在 escrow===undefined 分支调闸门（携预案的路径已在函数首经 hook 校验，
    // 不重复调用）。缺省部署（hook 未注册）与非 irreversible 携带 ⇒ 零行为。
    if (opts?.escrow === undefined
      && escrowBlockedByGate(pa.token, undefined, pa.reversibility?.level === 'irreversible')) {
      return false;
    }
    if ((pa.inFlight ?? 0) > 0) return false; // 在途回合未结算：并发双花在此闭合
    pa.attempts += 1;
    if (pa.attempts > pa.maxAttempts) {
      pending.delete(pa.token); // 重试预算耗尽：派发前焚毁
      return false;
    }
    pa.inFlight = (pa.inFlight ?? 0) + 1;
    return true;
  },

  /** V 纪元·验收失败登记：物理点击已派发但世界未出现预期变化（点空/落错窗口/
   *  变化不是预期的）。未生效的尝试没有消耗用户的同意 —— 令牌保留，TTL 续期
   *  （不越生命周期硬顶），模型在同一份授权内自动重试，**不得再打扰用户**。
   *  尝试次数超限 ⇒ 焚毁令牌并要求重新审批（反复失败本身就该让人看一眼）。 */
  attemptFailed(token: string, reason?: string): { valid: boolean; remainingAttempts: number; reArmedMs: number; reason?: string } {
    // W3-1（S1）：验收失败登记 = 托管补偿触发（no-effect/落错窗口 —— 世界可能
    // 已被意外改变）。置于函数顶（钩子独立于本函数的簿记，无在途预案 ⇒ no-op；
    // 令牌已过期的调用路径同样触发 —— saga in-doubt 语义见 reversalEscrow）。
    // ΠΑΝ-7：非字符串 token 经类型收口（旧实现 String(token ?? '') 不抛但
    // (token||'').trim() 对非字符串真值抛 —— 现统一走 normalizeToken 绝不抛）。
    const tok = normalizeToken(token);
    fireEscrowSettlement(tok, 'attempt-failed', reason);
    const pa = pending.get(tok);
    if (!pa || !pa.granted || Date.now() > pa.expiresAt) {
      if (pa) pending.delete(pa.token); // 过期/无效即焚，不留僵尸
      return { valid: false, remainingAttempts: 0, reArmedMs: 0, reason };
    }
    // Δ 纪元（计数时序）：beginAttempt 已预留计数的回合在此**结算** —— 只释放
    // 预留（inFlight-1），不再重复 ++（否则单次点击 attempts +2）。
    // 未经 beginAttempt 的直接调用（测试/旧路径）维持原自增语义不变。
    if ((pa.inFlight ?? 0) > 0) {
      pa.inFlight = (pa.inFlight ?? 0) - 1;
    } else {
      pa.attempts += 1;
      if (pa.attempts > pa.maxAttempts) {
        pending.delete(pa.token); // 重试预算耗尽：重新审批（新描述应说明为何屡试不中）
        return { valid: false, remainingAttempts: 0, reArmedMs: 0, reason };
      }
    }
    // 续期：给重试留出与初始等宽的窗口，但不越过铸造时锚定的生命周期硬顶
    const now = Date.now();
    pa.expiresAt = Math.min(now + pa.ttlMs, pa.lifetimeCapAt);
    return { valid: true, remainingAttempts: pa.maxAttempts - pa.attempts, reArmedMs: pa.expiresAt - now, reason };
  },

  /** 作废令牌：用户拒绝（grant=false）时立即调用，防止误用。
   *  ΠΑΝ-5：伴随绑定账一并离场；ΠΑΝ-7：非字符串绝不抛。 */
  revoke(token: string): void {
    const tok = normalizeToken(token);
    pending.delete(tok);
    forgetTokenTarget(tok);
  },

  /** W1-2（H1）：执行侧读取面 —— 派发前读批注 patch 修正计划。
   *  消费点在工具派发层（click_mouse / click_element / drag_mouse 在
   *  beginAttempt 之前读 patch 修正 target_description / 坐标 / 工具形状）；
   *  该层不在本簇领地 ⇒ 在此暴露读取 API，接线见 W1-2 报告。
   *  ΠΑΝ-8 同族修复（C1-1 L3）：返回深拷贝 —— 旧实现直接返回内部可变引用，
   *  外部原地改写会毒化挂在 pending 上的账本。ΠΑΝ-7：非字符串 ⇒ null。 */
  amendmentOf(token: string): ApprovalAmendment | null {
    const pa = pending.get(normalizeToken(token));
    if (pa?.amendment === undefined) return null;
    const am = pa.amendment;
    return {
      ...am,
      targetDescriptionDelta: { ...am.targetDescriptionDelta },
      actionShapeCorrection: { ...am.actionShapeCorrection },
    };
  },

  /** W1-2（H1）：批注合并 —— amendment.actionShapeCorrection 按在场字段
   *  覆盖计划形状（RawActionShape 面；随后的 sanitizeActionShape 照常脱敏）。
   *  无批注 / 令牌缺席 ⇒ 原样返回（幂等、纯函数、绝不抛）。 */
  applyAmendment(token: string, plan: RawActionShape): RawActionShape {
    const am = approval.amendmentOf(token);
    if (!am) return plan;
    const merged: RawActionShape = { ...plan };
    const c = am.actionShapeCorrection;
    if (typeof c.tool === 'string' && c.tool) merged.tool = c.tool;
    if (typeof c.x === 'number' && Number.isFinite(c.x)) merged.x = c.x;
    if (typeof c.y === 'number' && Number.isFinite(c.y)) merged.y = c.y;
    if (typeof c.target_description === 'string' && c.target_description) {
      merged.target_description = c.target_description;
    }
    return merged;
  },

  /** 清理过期令牌（防内存缓慢泄漏）。
   *  ΠΑΝ-5/6：安全原语区的伴随账（目标绑定 / 兑换权标记 / 最近绑定拒绝）随
   *  pending 的过期清扫一并离场（token 已不在场 ⇒ 记录无消费方，纯内存卫生；
   *  查找面本就由 pending 在场性前置兜底，清扫不改变任何行为语义）。 */
  sweep(): void {
    const now = Date.now();
    for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
    sweepApprovalSecurityState(pending.keys());
  },
};
