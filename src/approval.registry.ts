// src/approval.registry.ts
// approval 共享簿记注册表（W8-B3 自 approval.ts 拆出 —— 代码逐字保持，零漂移）。
// 只拥有一件事：在途待审批令牌的 Map（pending）与它的值类型。独立成文件的
// 原因是防御式的：主账本（approval.ledger —— 写/焚毁）与离线队列
// （approval.queue* —— 暂存资格查验/续跑铸造）双向消费同一份簿记，若把
// Map 放进任一侧都会造成运行时循环依赖 —— 注册表是两侧共同的下层，
// 让依赖图保持无环（安全核心拒绝「碰巧能跑」的环）。
import type { ActionShape } from './approval.shapes';
import type { ApprovalAmendment } from './approval.security';
import type { ReversibilityLevel } from './riskGate';

export interface PendingApproval {
  token: string;
  description: string;
  expiresAt: number;
  /** J 纪元：用户是否已通过 grant_approval 授予（缺省 false —— 请求≠同意） */
  granted: boolean;
  /** Y-10：速率闸门拒绝时附带的冷静期毫秒数（锚点透明化） */
  rateLimitedForMs?: number;
  /** V 纪元：已派发的物理尝试次数（验收失败递增；验收通过即焚毁） */
  attempts: number;
  /** V 纪元：尝试次数上限 —— 一次同意覆盖的自动重试预算 */
  maxAttempts: number;
  /** V 纪元：生命周期硬顶：重试续期不可越过的天花板（铸造时锚定） */
  lifetimeCapAt: number;
  /** V 纪元：铸造时的初始有效期（重试续期复用同一宽度） */
  ttlMs: number;
  /** Δ 纪元（审计#2）：在途预留数 —— beginAttempt 已计数、尚未经 consume/
   *  attemptFailed 结算的物理回合（并发双花封堵的簿记；缺省 0，不参与任何
   *  既有 status/consume 语义 —— 只约束 beginAttempt 的并发准入） */
  inFlight?: number;
  /** Τ 纪元（干预即教育）：铸造时快照并脱敏的动作形状（教育旁路的载荷；
   *  调用方未提供 ⇒ 缺席 —— 不伪造形状） */
  actionShape?: ActionShape;
  /** Τ 纪元：铸造时快照的屏幕指纹（调用方/journal 未提供 ⇒ 诚实缺席） */
  sceneFingerprint?: string;
  /** W1-2（S2）：确认码的 sha256（hex）。明文只在铸造瞬间经带外通道投出 ——
   *  簿记无明文（内存驻留面最小化：转储/序列化都拿不到码）。缺省 ⇒ 带外
   *  通道缺席/投递失败（W6R fail-closed：grantDetailed 一律拒绝）。 */
  confirmCodeHash?: string;
  /** W1-2（S2）：带外通道缺席或投递失败的诚实标记（W6R：仅簿记透明化 ——
   *  该令牌已不可被 grant，见 grantDetailed 的 confirm-channel-absent 拒绝） */
  degraded?: boolean;
  /** W1-2（S2）：确认码错误尝试计数（防暴力枚举的封顶簿记；匹配成功即清零） */
  codeMismatches?: number;
  /** W1-2（H1）：grant 时铸入的用户批注 patch（执行侧派发前读取修正计划） */
  amendment?: ApprovalAmendment;
  /** W2-1（H4）：本令牌由队列已批条目续跑铸造（值 = 条目 id —— 审计可回溯；
   *  缺省 undefined = 常规交互式审批，语义零参与） */
  resumedFromQueue?: string;
  /** W4-3（S5）：可逆性分级随行（request 携带 —— 审批/示范生命周期全程在场；
   *  缺省 undefined ⇒ 分级面诚实缺席，既有审批语义零变化。级别是叠加维度：
   *  危险词闸门照常独立执法，分级只回答「派发走哪条道、坏了怎么救」）。 */
  reversibility?: ReversibilityCarry;
}

/** W4-3（S5）：request 携带的分级载荷（reversibilityRegistry.classify 的产出面） */
export interface ReversibilityCarry {
  level: ReversibilityLevel;
  /** 注册表语义键（校准证据落账的锚点） */
  semantics?: string;
  /** 判定来源（builtin/extension/calibrated/unknown-default —— 审计面） */
  source?: string;
}

/** 在途待审批令牌的簿记（主账本与离线队列共享的唯一事实源） */
export const pending = new Map<string, PendingApproval>();
