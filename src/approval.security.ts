// src/approval.security.ts
// approval 安全原语区（W8-B3 自 approval.ts 拆出 —— 代码逐字保持，零漂移）：
// 令牌铸造、W1-2（S2）带外确认码全套、W1-2（H1）批注铸造、Y-10 同意限流桶。
// ─── W1-2（审批协议升级）：S2 带外人证 + H1 批注式审批 ───
//
// S2（带外确认码）：request_approval 铸造 6 位十进制确认码（CSPRNG、zerosafe），
// 码**只**经带外通道（宿主控制台/宿主事件总线，见 doctorChannel 的挂点）投给
// 人类 —— 绝不出现在返回给模型的任何工具结果文本里（安全核心：模型上下文
// 不可见 ⇒ 模型无法伪造「用户已同意」；grant_approval 必须携带用户读码后
// 交回的 confirmCode 才能置 granted）。防御纵深：
//   · 簿记只存 sha256（明文仅在铸造瞬间流经带外投递，内存驻留面最小化）；
//   · 比较恒定时间（timingSafeEqual 于 32B 摘要 —— 不泄露哪一位错）；
//   · 错误尝试封顶（MAX_CODE_MISMATCHES 次错码即焚毁令牌 —— 暴力枚举封顶）；
//   · W6R fail-closed：带外通道缺席/投递失败 ⇒ 令牌记 degraded（诚实标记），
//     grantDetailed(grant=true) 一律拒绝（reason='confirm-channel-absent'）——
//     旧实现的「无码降级 grant」是 fail-open：屏幕注入文本可驱动 request→grant
//     →click 全链自批不可逆操作。修复后降级方向反转：没有带外人证就没有同意，
//     用户须经宿主 UI（事件总线挂点）完成人工确认。
//   （裁决落点 grantDetailed 在 approval.ledger.ts —— 本文件只持铸造/投递/
//    比较原语与通道状态；W8-B3 拆分后两文件共同构成 S2 执法面。）
//
// H1（批注式审批）：grant_approval 可携 note（用户批注：同意但修正计划），
// 铸为结构化 amendment patch 挂在 PendingApproval 上（至少含目标描述差异 +
// 动作形状修正）；执行侧在派发前读 patch 修正计划（读取 API 见主账本的
// amendmentOf / applyAmendment —— 消费点在工具派发层，接线见 W1-2 报告）。
// 示范事件随之增 amended 标注：用户批注是最强负示范信号（用户不得不亲手
// 纠正计划），批注内容随事件对蒸馏下游可见。
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { CONFIRM_CODE_SPACE, AMENDMENT_NOTE_MAX } from './approval.constants';
import type { ActionShape } from './approval.shapes';
import type { PendingApproval } from './approval.registry';

/** W1-2（H1 批注式审批）：结构化批注 patch —— grant 时的用户批注铸入令牌。
 *  「同意」与「照原计划执行」从此可分离：用户可以批准意图同时修正计划。
 *  至少携带两类修正（执行侧派发前合并进计划）：
 *    · targetDescriptionDelta —— 目标描述差异（模型自述 vs 用户批注修正）；
 *    · actionShapeCorrection  —— 动作形状修正（字段级覆盖 patch）。 */
export interface ApprovalAmendment {
  /** 批注原文（截 200，与 target_description 同预算） */
  note: string;
  /** 目标描述差异：铸造时模型自述 → 用户批注给出的修正表述 */
  targetDescriptionDelta: { original: string; corrected: string };
  /** 动作形状修正（字段级 patch：执行侧按在场字段覆盖计划形状） */
  actionShapeCorrection: Partial<Pick<ActionShape, 'tool' | 'x' | 'y' | 'target_description'>>;
  /** 铸入时刻（grant 落点） */
  amendedAt: number;
}

/** W1-2（S2 带外人证）：确认码带外投递载荷 —— 明文 confirmCode 只在此流经
 *  带外通道（宿主控制台/事件总线），审批簿记与一切模型可见面绝不持有明文。 */
export interface ConfirmCodeDelivery {
  token: string;
  description: string;
  /** 6 位十进制明文码（zerosafe —— 前导零合法保留） */
  confirmCode: string;
  expiresAt: number;
}

/** W1-2（S2）：grant 的完整裁决结果。错误码刻意区分「码错误」与「令牌无效」
 *  （防枚举侧信道：码比较恒定时间、不泄露哪一位错；成因区分让上层能给出
 *  正确的重试指引，而比较本身零信息泄露）。 */
export type GrantOutcome =
  | { ok: true }
  | {
    ok: false;
    reason:
      | 'invalid-token'            // 缺席 / 过期（焚毁僵尸）
      | 'confirm-channel-absent'   // W6R fail-closed：带外通道缺席/投递失败（degraded
                                   // 令牌不可 grant —— 无码同意已废除，用户须经宿主 UI）
      | 'confirm-code-required'    // 带码审批但调用未携码（非错误尝试，不计封顶）
      | 'confirm-code-mismatch'    // 码不匹配（计一次错误尝试）
      | 'code-attempts-exhausted'  // 错码次数封顶：令牌已焚毁（防暴力枚举）
      | 'rate-limited';            // Y-10 同意预算耗尽（令牌保留，冷静期后重试）
    retryInMs?: number;
  };

export function newToken(): string {
  // CSPRNG（对齐 capToken.ensureKey 的密钥强度标准）：令牌门禁的是不可逆操作，
  // Math.random 可预测且 8 字符 base36 空间在高频下可碰撞（静默顶掉待审批项）
  return 'APR-' + randomBytes(8).toString('hex').toUpperCase();
}

// ─── W1-2（S2）：确认码安全原语 ───

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** W1-2（S2）：铸造 6 位确认码。CSPRNG + 拒绝采样（32bit 均匀源无偏映射到
 *  [0, 10^6)——直接 modulo 会引入 2.3×10⁻⁸ 的低位偏置，拒绝采样根除）；
 *  zerosafe：前导零以 padStart 保留（"012345" 是合法码）。绝不抛。 */
function mintConfirmCode(): string {
  // 2^32 中丢弃尾部不足以整除码空间的余数（96 个值）⇒ 映射均匀
  const rejectAbove = 0x1_0000_0000 - (0x1_0000_0000 % CONFIRM_CODE_SPACE);
  for (let i = 0; i < 64; i++) {
    const n = randomBytes(4).readUInt32BE(0);
    if (n < rejectAbove) return String(n % CONFIRM_CODE_SPACE).padStart(6, '0');
  }
  // 理论不可达（单轮拒绝概率 ≈ 2.2×10⁻⁸）：64 轮全拒后接受极微偏置，
  // 绝不无限循环（防御式 —— 铸造路径无死循环出口）
  return String(randomBytes(4).readUInt32BE(0) % CONFIRM_CODE_SPACE).padStart(6, '0');
}

/** W1-2（S2）：恒定时间码比较。两侧均为 32B sha256 摘要（长度恒等 ⇒
 *  timingSafeEqual 不抛），比较时长与内容无关 —— 不泄露哪一位错、也不泄露
 *  前缀匹配长度。防御式：任何异常 ⇒ false（绝不抛）。
 *  （W8-B3 拆分：消费点在主账本的裁决通道 —— 导出供兄弟文件，实现零变化。） */
export function codeMatches(provided: string, storedHash: string): boolean {
  try {
    return timingSafeEqual(
      createHash('sha256').update(provided).digest(),
      Buffer.from(storedHash, 'hex'),
    );
  } catch {
    return false;
  }
}

// ─── W1-2（S2）：带外投递通道（模块级可注入缝；null = 通道缺席 ⇒ fail-closed） ───
//
// 契约：sink 收到明文码后投给人类（事件总线/弹窗/推送…），返回 false（或抛出）
// 表示投递失败 ⇒ 铸造侧记 degraded（W6R：该令牌不可被 grant —— fail-closed）；
// 返回 true/undefined 视为已投递。投递是旁路义务：sink 异常全吞，绝不炸铸造
// 主流程。

let confirmCodeChannel: ((d: ConfirmCodeDelivery) => boolean | void) | null = null;

/** 挂载/卸载带外确认码通道（fn=null 卸载 ⇒ 恢复通道缺席的 fail-closed 默认）。
 *  挂点见 doctorChannel.armOutOfBandConfirmChannel（组合根经既有的
 *  wireDoctorVerdictChannel 接线顺带武装 —— 生产默认带码，测试默认 fail-closed）。 */
export function setConfirmCodeChannel(fn: ((d: ConfirmCodeDelivery) => boolean | void) | null): void {
  confirmCodeChannel = fn;
}

/** 通道在场与否的只读探针（W8-B3 拆分缝：队列面的暂存资格/通道闸门与
 *  approvalBudget 同律读此状态 —— 原为同文件内直接判 null，行为零变化）。 */
export function confirmChannelArmed(): boolean {
  return confirmCodeChannel !== null;
}

/** W1-2（S2）：带外投递（旁路）：通道在场且投递成功 ⇒ 返回码的 sha256；
 *  通道缺席/故障 ⇒ undefined（调用方记 degraded —— W6R fail-closed：该令牌
 *  不可被 grant）。绝不抛。 */
export function deliverConfirmCode(pa: PendingApproval): string | undefined {
  if (confirmCodeChannel === null) return undefined;
  const code = mintConfirmCode();
  try {
    const delivered = confirmCodeChannel({
      token: pa.token,
      description: pa.description,
      confirmCode: code,
      expiresAt: pa.expiresAt,
    }) !== false;
    return delivered ? sha256Hex(code) : undefined;
  } catch {
    return undefined; // 带外通道故障 = 通道缺席语义（记 degraded ⇒ grant 被拒 —— W6R fail-closed；铸造主流程绝不炸）
  }
}

/** W1-2（H1）：批注铸入 —— 用户批注结构化为 amendment patch。
 *  目标描述差异 = 铸造时自述 vs 批注修正；动作形状修正 = 以批注为
 *  target_description 的字段级 patch（执行侧合并进计划）。 */
export function castAmendment(pa: PendingApproval, note: string): ApprovalAmendment {
  return castAmendmentFor(pa.description, note, Date.now());
}

/** W2-1（H4）：批注铸造的描述参数化面 —— 队列条目没有 PendingApproval 宿主，
 *  以条目自身的 description 为「铸造时自述」。协议与 W1-2 完全同律
 *  （note 截 200 / 差异双面 / 字段级形状 patch），一次批注对多项裁决时
 *  每个条目各铸一份（original = 各自的条目描述）。 */
export function castAmendmentFor(originalDescription: string, note: string, now: number): ApprovalAmendment {
  const clamped = note.slice(0, AMENDMENT_NOTE_MAX);
  return {
    note: clamped,
    targetDescriptionDelta: { original: originalDescription, corrected: clamped },
    actionShapeCorrection: { target_description: clamped },
    amendedAt: now,
  };
}

// ─── Y-10 审批令牌桶（Epoch Y：不可逆操作的同意也有速率上限）───
//
// 数学：令牌桶限流 —— 容量 C=3、回填周期 R=10min（每 10 分钟回填 1 枚，
// 桶满不累积）。grant=true 消费一枚令牌；桶空 ⇒ 拒绝授予并进入冷静期。
// 威胁模型：被劫持/被诱导的模型可以在短时间内对用户施压获取一连串「同意」
// （click-fatigue 攻击）—— 速率上限把单会话的最大不可逆操作数压到常数，
// 且强制两次危险操作之间至少间隔一个回填周期，给人类留出反悔的时间窗。

export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;
  private now: () => number;
  // P 纪元律：构造器参数属性是 transform 语法 —— Node strip-only 拒载。显式字段。
  readonly capacity: number;
  readonly refillIntervalMs: number;

  constructor(
    capacity: number = 3,
    refillIntervalMs: number = 10 * 60 * 1000,
    initialTokens?: number,
    now: () => number = Date.now,
  ) {
    this.capacity = capacity;
    this.refillIntervalMs = refillIntervalMs;
    this.tokens = initialTokens ?? capacity;
    this.lastRefillAt = now();
    this.now = now;
  }

  private refill(): void {
    const elapsed = this.now() - this.lastRefillAt;
    const accrued = Math.floor(elapsed / this.refillIntervalMs);
    if (accrued > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + accrued);
      this.lastRefillAt += accrued * this.refillIntervalMs;
    }
  }

  /** 取一枚令牌；桶空返回冷静期毫秒数（拒绝提示的事实源） */
  tryTake(): { ok: true } | { ok: false; retryInMs: number } {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryInMs: this.refillIntervalMs - (this.now() - this.lastRefillAt) };
  }

  /** 余量（遥测/锚点透明化） */
  available(): number {
    this.refill();
    return this.tokens;
  }

  reset(): void {
    this.tokens = this.capacity;
    this.lastRefillAt = this.now();
  }
}

/** 审批同意的速率闸门（模块单例 —— 插件卸载随闭包消亡） */
export const grantBucket = new TokenBucket();

/** 令牌桶余量（锚点透明化 —— 模型/用户可见的「同意预算」） */
export function approvalBudget(): number {
  return grantBucket.available();
}

// 注：TTL_MS / MAX_ATTEMPTS / LIFETIME_MULTIPLIER / MAX_CODE_MISMATCHES 的消费点
// 在 approval.ledger.ts（裁决与验收式消费面）；立法常量区 = approval.constants.ts。
