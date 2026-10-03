// src/approval.ts
// 第六轮创新之一：一次性审批令牌（One-shot Approval Token）。
// 不可逆操作（发送/删除/支付/提交订单…）需要显式授权：模型先 request_approval
// 生成令牌并告知用户，用户在对话中同意后，模型携令牌重试动作。
// 令牌四性质：一次性（用后即焚）、短时效（默认 10min，覆盖整个任务的重试窗口）、
// 带用途（描述随行）、**须授予**（J 纪元：grant_approval(token, true) 是执行的
// 必要条件 —— 旧协议"从未 grant"与"grant=true"对执行层无区别，审批闸门的
// 同意环节形同虚设）。
//
// Y 纪元（Y-10）：审批令牌桶 —— 同意本身也是有限资源。
//
// V 纪元（验收式消费）：用户的同意锚定在**任务意图**上，而非单次点击派发。
// 旧语义在「点击已派发但世界未变」（落错窗口/坐标漂移）时也焚毁令牌 ——
// 一次用户确认只换来一次物理尝试，重试即二次打扰（实测：发一封邮件被问了
// 三次 yes）。新语义：**令牌只在验收通过（世界出现预期变化）时焚毁**；
// 未生效的尝试不消耗同意（no-op 不是不可逆操作），登记后自动续期供重试，
// 直到验收通过、尝试次数超限或生命周期硬顶到期。安全性不降反升：
// 每次「验收通过」的世界变化仍恰好消耗一枚令牌 + 一枚 Y-10 桶令牌。
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, mkdirSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
// W4-3（S5）：可逆性分级随行 + 示范事件喂分级注册表（riskGate 只依赖生成
// 数据表 —— 零环：reversalEscrow → approval → riskGate 单向）。
import { reversibilityRegistry, dispatchLaneFor, type ReversibilityLevel, type DispatchLane } from './riskGate';

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
//   · 兼容降级：带外通道缺席/投递失败 ⇒ 回退旧式无码 grant 并记 degraded
//     （现有宿主流与既有测试零破坏 —— 降级是默认，带码是显式武装后的升档）。
//
// H1（批注式审批）：grant_approval 可携 note（用户批注：同意但修正计划），
// 铸为结构化 amendment patch 挂在 PendingApproval 上（至少含目标描述差异 +
// 动作形状修正）；执行侧在派发前读 patch 修正计划（读取 API 见 amendmentOf /
// applyAmendment —— 消费点在工具派发层，接线见 W1-2 报告）。示范事件随之
// 增 amended 标注：用户批注是最强负示范信号（用户不得不亲手纠正计划），
// 批注内容随事件对蒸馏下游可见。

// ─── Τ 纪元（干预即教育）：示范事件的动作形状（隐私铁律的铸造点） ───
//
// 人机交互研究的经典事实：用户干预（拒绝/手动接管）是最贵的监督信号，业界 agent
// 全部把它扔掉。Τ 把审批事件变成教育事件：
//   验收式消费成功（consume）= 特权正示范 —— 用户亲自背书且世界验证成功的动作模式
//     （这正是「用户同意的动作真的成了」的铁证，双重证据等级高于任何自动归纳）；
//   用户拒绝（grant=false）= 负示范 —— 这条路用户不让走。
// agent 越被纠正越懂这个用户。教育是旁路：观察者异常全吞，绝不炸审批主流程。

/** W3-1（S1）：结算钩子发射（旁路义务 —— 异常全吞，绝不炸审批主流程）。
 *  verified：consume 成功（世界出现预期变化 —— 预案关闭，无需补偿）；
 *  attempt-failed：attemptFailed（验收失败 —— 触发托管补偿）。钩子内部
 *  fire-and-forget，无在途预案时 no-op（普通审批流零参与 —— 正交性）。 */
function fireEscrowSettlement(token: string, verdict: 'verified' | 'attempt-failed', reason?: string): void {
  if (escrowSettlementHook === null) return;
  try {
    escrowSettlementHook(token, verdict, reason);
  } catch {
    /* 旁路义务：托管结算故障绝不炸审批主流程 */
  }
}

/** 文本长度桶：type_text 唯一允许携带的文本元数据（粗粒度等价类，绝无内容） */
export function lengthBucket(len: number): string {
  if (!Number.isFinite(len) || len <= 0) return 'empty';
  if (len <= 16) return 'short';
  if (len <= 64) return 'medium';
  if (len <= 256) return 'long';
  return 'xl';
}

/** 文本输入类工具：示范记录只记工具名与长度桶（隐私铁律 —— 绝不记文本内容） */
const TEXT_INPUT_TOOLS = new Set(['type_text']);

/** 调用方提供的原始动作形状：text 仅用于铸造长度桶，任何情况下不入档 */
export interface RawActionShape {
  tool: string;
  /** 归一化坐标 [0,1]（点击/拖拽类） */
  x?: number;
  y?: number;
  /** 目标描述（type_text 类不记录 —— 最保守脱敏） */
  target_description?: string;
  /** type_text 类的原文：只在此计算长度桶，绝不存储 */
  text?: string;
  /** 直接给定长度桶（无原文时；type_text 专用） */
  text_length_bucket?: string;
}

/** 脱敏后的动作形状（示范事件的载荷类型） */
export interface ActionShape {
  tool: string;
  x?: number;
  y?: number;
  target_description?: string;
  text_length_bucket?: string;
}

/** 归一化坐标：非有限值弃记；[0,1] 钳制；千分位量化（签名匹配的抖动容忍带） */
function normCoord(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000
    : undefined;
}

/** 动作形状脱敏（隐私铁律的执法点）：type_text 类只保留工具名+长度桶；
 *  其余工具保留工具名+归一化坐标+目标描述（截 200 字）。
 *  幂等 —— 已脱敏形状再过一次不变（蒸馏面可作二次防线）。 */
export function sanitizeActionShape(raw: RawActionShape): ActionShape {
  if (TEXT_INPUT_TOOLS.has(raw.tool)) {
    return {
      tool: raw.tool,
      text_length_bucket: raw.text_length_bucket ?? lengthBucket(raw.text?.length ?? 0),
    };
  }
  const shape: ActionShape = { tool: raw.tool };
  const x = normCoord(raw.x);
  const y = normCoord(raw.y);
  if (x !== undefined) shape.x = x;
  if (y !== undefined) shape.y = y;
  if (raw.target_description) shape.target_description = raw.target_description.slice(0, 200);
  return shape;
}

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
      | 'confirm-code-required'    // 带码审批但调用未携码（非错误尝试，不计封顶）
      | 'confirm-code-mismatch'    // 码不匹配（计一次错误尝试）
      | 'code-attempts-exhausted'  // 错码次数封顶：令牌已焚毁（防暴力枚举）
      | 'rate-limited';            // Y-10 同意预算耗尽（令牌保留，冷静期后重试）
    retryInMs?: number;
  };

/** Τ 纪元：示范事件（审批事件的蒸馏载荷） */
export interface DemonstrationEvent {
  kind: 'approval-consumed' | 'approval-denied';
  /** 铸造时快照并脱敏的动作形状；调用方未提供 ⇒ undefined 诚实缺席 */
  actionShape?: ActionShape;
  /** 铸造时快照的屏幕指纹（journal/调用方未提供 ⇒ undefined 诚实缺席） */
  sceneFingerprint?: string;
  /** 令牌的 sha256 前 8 位（隐私铁律：完整令牌不出审批模块） */
  tokenId: string;
  /** W1-2（H1）：本审批携带用户批注（同意但修正计划 / 否决附理由）——
   *  最强负示范信号：用户不得不亲手纠正计划。缺省 undefined 诚实缺席。 */
  amended?: boolean;
  /** W1-2（H1）：批注内容随事件对蒸馏下游可见（skillLibrary 现状忽略额外
   *  字段 ⇒ 零行为；未来蒸馏面可直接消费，无需改发射点）。 */
  amendment?: ApprovalAmendment;
}

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
   *  簿记无明文（内存驻留面最小化：转储/序列化都拿不到码）。缺省 ⇒ 无码
   *  降级审批（旧协议）。 */
  confirmCodeHash?: string;
  /** W1-2（S2）：带外通道缺席或投递失败 ⇒ 降级旧式无码 grant 的诚实标记 */
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

const pending = new Map<string, PendingApproval>();
/** 初始有效期：一次确认覆盖整个任务（重定位目标/切窗重试）的窗口 */
const TTL_MS = 600_000;
/** 单令牌尝试次数上限（物理点击数）—— 超限焚毁，重新审批 */
const MAX_ATTEMPTS = 5;
/** 生命周期硬顶 = 铸造时 TTL 的 3 倍：重试续期的总天花板 */
const LIFETIME_MULTIPLIER = 3;

function newToken(): string {
  // CSPRNG（对齐 capToken.ensureKey 的密钥强度标准）：令牌门禁的是不可逆操作，
  // Math.random 可预测且 8 字符 base36 空间在高频下可碰撞（静默顶掉待审批项）
  return 'APR-' + randomBytes(8).toString('hex').toUpperCase();
}

// ─── W1-2（S2）：确认码安全原语 ───

/** 码空间：6 位十进制（10^6）。zerosafe：前导零合法且必须保留（padStart）。 */
const CONFIRM_CODE_SPACE = 1_000_000;
/** 错码尝试封顶：达到即焚毁令牌。10^6 空间下 5 次命中的概率 5×10⁻⁶ ——
 *  给人类手误留足余量，给暴力枚举判死刑。 */
const MAX_CODE_MISMATCHES = 5;
/** 批注原文预算（与 target_description 同律 —— Token 纪律与隐私截断） */
const AMENDMENT_NOTE_MAX = 200;

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
 *  前缀匹配长度。防御式：任何异常 ⇒ false（绝不抛）。 */
function codeMatches(provided: string, storedHash: string): boolean {
  try {
    return timingSafeEqual(
      createHash('sha256').update(provided).digest(),
      Buffer.from(storedHash, 'hex'),
    );
  } catch {
    return false;
  }
}

// ─── W1-2（S2）：带外投递通道（模块级可注入缝；null = 通道缺席 ⇒ 降级） ───
//
// 契约：sink 收到明文码后投给人类（控制台/弹窗/推送…），返回 false（或抛出）
// 表示投递失败 ⇒ 铸造侧降级无码；返回 true/undefined 视为已投递。
// 投递是旁路义务：sink 异常全吞，绝不炸铸造主流程。

let confirmCodeChannel: ((d: ConfirmCodeDelivery) => boolean | void) | null = null;

/** 挂载/卸载带外确认码通道（fn=null 卸载 ⇒ 恢复无码降级）。
 *  挂点见 doctorChannel.armOutOfBandConfirmChannel（组合根经既有的
 *  wireDoctorVerdictChannel 接线顺带武装 —— 生产默认带码，测试默认降级）。 */
export function setConfirmCodeChannel(fn: ((d: ConfirmCodeDelivery) => boolean | void) | null): void {
  confirmCodeChannel = fn;
}

/** W1-2（S2）：带外投递（旁路）：通道在场且投递成功 ⇒ 返回码的 sha256；
 *  通道缺席/故障 ⇒ undefined（调用方据此降级）。绝不抛。 */
function deliverConfirmCode(pa: PendingApproval): string | undefined {
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
    return undefined; // 带外通道故障 = 通道缺席（诚实降级，绝不炸铸造）
  }
}

/** W1-2（H1）：批注铸入 —— 用户批注结构化为 amendment patch。
 *  目标描述差异 = 铸造时自述 vs 批注修正；动作形状修正 = 以批注为
 *  target_description 的字段级 patch（执行侧合并进计划）。 */
function castAmendment(pa: PendingApproval, note: string): ApprovalAmendment {
  return castAmendmentFor(pa.description, note, Date.now());
}

/** W2-1（H4）：批注铸造的描述参数化面 —— 队列条目没有 PendingApproval 宿主，
 *  以条目自身的 description 为「铸造时自述」。协议与 W1-2 完全同律
 *  （note 截 200 / 差异双面 / 字段级形状 patch），一次批注对多项裁决时
 *  每个条目各铸一份（original = 各自的条目描述）。 */
function castAmendmentFor(originalDescription: string, note: string, now: number): ApprovalAmendment {
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
const grantBucket = new TokenBucket();

// ─── Τ 纪元（干预即教育）：审批事件的观察者面（纯旁路） ───
//
// 既有审批语义零变化：观察者缺席 / enableDemonstrations 关 ⇒ 零行为；
// 回调异常全吞（旁路义务 —— 教育失败绝不炸审批主流程）。事件的两个且仅两个
// 发射点：consume 成功（验收通过 = 特权正示范）与 grant(false)（用户否决 =
// 负示范）。revoke 是机械作废而非用户裁决，不发射（拒绝的语义主体在用户）。

/** 示范观察者（null = 缺席 ⇒ 零行为） */
let demoObserver: ((ev: DemonstrationEvent) => void) | null = null;
/** 示范总开关：默认 true；由 config.enableDemonstrations 经
 *  configureDemonstrations 铸入（approvalTools 装配时） */
let demonstrationsEnabled = true;

/** 挂载/卸载示范观察者（fn=null 卸载）。回调异常在发射点全吞。 */
export function setDemonstrationObserver(fn: ((ev: DemonstrationEvent) => void) | null): void {
  demoObserver = fn;
}

/** 示范总开关（config.enableDemonstrations 的模块级铸入面） */
export function configureDemonstrations(enabled: boolean): void {
  demonstrationsEnabled = enabled;
}

/** 教育事件发射（旁路）：tokenId 只出 sha256 前 8 位；观察者异常全吞。
 *  W1-2（H1）：批注在场 ⇒ amended 标注 + 批注内容随行（最强负示范对蒸馏
 *  下游可见）。
 *  W4-3（S5）：示范事件同步喂可逆性分级注册表（旁路的旁路 —— 注册表异常
 *  全吞，且只受 demonstrationsEnabled 总闸约束、不依赖观察者在场：注册表是
 *  内部分级知识，不是外部观察通道）。denial = 用户视此为不可逆的最强证据
 *  （adverse++，Beta 证据门防单事件翻级）；consumed = 特权正示范
 *  （supportive++，后验分母）。 */
function emitDemonstration(pa: PendingApproval, kind: DemonstrationEvent['kind']): void {
  if (demonstrationsEnabled) {
    try {
      reversibilityRegistry.observeDemonstration({
        kind,
        ...(pa.reversibility?.semantics !== undefined ? { semantics: pa.reversibility.semantics } : {}),
        ...(pa.actionShape?.tool !== undefined ? { tool: pa.actionShape.tool } : {}),
        ...(pa.description !== undefined ? { description: pa.description } : {}),
      });
    } catch {
      /* 旁路义务：分级注册表故障绝不炸审批主流程 */
    }
  }
  if (!demonstrationsEnabled || !demoObserver) return;
  try {
    demoObserver({
      kind,
      actionShape: pa.actionShape,
      sceneFingerprint: pa.sceneFingerprint,
      tokenId: createHash('sha256').update(pa.token).digest('hex').slice(0, 8),
      amended: pa.amendment ? true : undefined,
      amendment: pa.amendment,
    });
  } catch {
    /* 旁路义务：教育失败=跳过（此处无下游注记消费方，静默即诚实） */
  }
}

/** 令牌桶余量（锚点透明化 —— 模型/用户可见的「同意预算」） */
export function approvalBudget(): number {
  return grantBucket.available();
}

export const approval = {
  /** 发起审批：返回待确认的令牌（未生效 —— granted=false 直到 grant）。
   *  V 纪元：ttlMs/maxAttempts 可由部署配置注入（config.approvalTokenTtlMs /
   *  approvalMaxAttempts），缺省用本模块常量。
   *  Τ 纪元：opts.actionShape/sceneFingerprint 在铸造时快照（形状即刻脱敏 ——
   *  type_text 只记工具名+长度桶；未提供 ⇒ 字段诚实缺席，教育旁路零参与）。 */
  request(description: string, opts?: {
    ttlMs?: number; maxAttempts?: number;
    actionShape?: RawActionShape; sceneFingerprint?: string;
    /** W4-3（S5）：可逆性分级随行（reversibilityRegistry.classify 的产出；
     *  脏级别（不在三级域）⇒ 诚实弃置不携带 —— 绝不伪造分级）。 */
    reversibility?: ReversibilityCarry;
  }): PendingApproval {
    const ttl = Math.max(1_000, opts?.ttlMs ?? TTL_MS);
    const pa: PendingApproval = {
      token: newToken(),
      description,
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
    // W1-2（S2）：带外确认码铸造 —— 通道在场且投递成功 ⇒ 簿记只留 sha256
    // （明文已随投递离开模块）；通道缺席/投递失败 ⇒ 降级旧式无码 grant
    // （degraded 诚实标记：现有宿主流与既有测试零破坏 —— 降级是默认）。
    const confirmCodeHash = deliverConfirmCode(pa);
    if (confirmCodeHash !== undefined) pa.confirmCodeHash = confirmCodeHash;
    else pa.degraded = true;
    pending.set(pa.token, pa);
    return pa;
  },

  /** 用户裁决（grant_approval 工具的落点）：
   *  grant=true ⇒ 令牌激活（在 TTL 内可被动作消费）；
   *  grant=false ⇒ 立即作废（等价 revoke）。返回令牌是否在场。
   *  Y-10：grant=true 须同时通过令牌桶 —— 同意的速率上限。
   *  W1-2：布尔投影保持旧签名/旧语义零变化（直调调用方与既有测试原样通过）；
   *  S2 码校验与 H1 批注的丰富裁决面在 grantDetailed。 */
  grant(token: string, g: boolean): boolean {
    return approval.grantDetailed(token, g).ok;
  },

  /** W1-2（S2+H1）：完整裁决通道（grant_approval 工具的新落点）。
   *  S2：带码审批（confirmCodeHash 在场）必须携匹配 confirmCode 才置
   *  granted —— 恒定时间比较（不泄露哪一位错）、错码封顶焚毁（防枚举）、
   *  「码错误」与「令牌无效」错误码刻意区分（上层可给正确的重试指引，
   *  比较本身零信息泄露）。无码降级审批（degraded）走旧语义。
   *  H1：note（用户批注）铸为结构化 amendment patch 挂上令牌 ——
   *  同意与「照原计划执行」从此可分离；拒绝路径同样可携批注（否决理由
   *  随负示范事件蒸馏）。 */
  grantDetailed(token: string, g: boolean, opts?: { confirmCode?: string; note?: string }): GrantOutcome {
    const pa = pending.get((token || '').trim());
    if (!pa) return { ok: false, reason: 'invalid-token' };
    if (!g) {
      // H1：否决附批注 —— 先铸入，负示范事件随后携带（最强负示范）
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
    recordTokenDecision(pa.token, true, opts?.note); // W2-1（H4）：在途队列条目同步裁决（Y-10 已在此计费，不重复扣）
    return { ok: true };
  },

  /** 令牌状态（未消费）：granted 且未过期才有效。
   *  W1-2 透明化附加面（仅在场令牌）：confirmCodeRequired（S2 带码审批）、
   *  degraded（带外通道缺席的降级标记）、amended（H1 批注在场）。 */
  status(token: string): { present: boolean; granted: boolean; expired: boolean; attempts?: number; remainingAttempts?: number; confirmCodeRequired?: boolean; degraded?: boolean; amended?: boolean; reversibilityLevel?: ReversibilityLevel; reversibilitySemantics?: string } {
    const pa = pending.get((token || '').trim());
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
    };
  },

  /** W4-3（S5）：分级读取面（派发层按级分道的事实源 —— dispatchLaneOf 的
   *  伴生查询）。令牌缺席 / 未携带分级 ⇒ null（诚实缺席，绝不伪造）。 */
  reversibilityOf(token: string): ReversibilityCarry | null {
    const pa = pending.get((token || '').trim());
    return pa?.reversibility ? { ...pa.reversibility } : null;
  },

  /** W4-3（S5）：分道查询（reversibilityOf × dispatchLaneFor 的组合面 ——
   *  派发层单点消费：级别 → 派发要求）。未携带分级 ⇒ null（不替调用方默认 ——
   *  分级必须显式携带或显式放弃，保守律在 classify 面执法）。 */
  dispatchLaneOf(token: string): DispatchLane | null {
    const rev = approval.reversibilityOf(token);
    return rev === null ? null : dispatchLaneFor(rev.level);
  },

  /** 非消费校验（阶段一 validate）：granted 且未过期才有效，令牌保留可重试。 */
  validate(token: string): boolean {
    const pa = pending.get((token || '').trim());
    return !!pa && pa.granted && Date.now() <= pa.expiresAt;
  },

  /** 消费令牌（验收通过路径调用）：granted 且未过期才放行，用后即焚。
   *  V 纪元：这是「验收通过」的落点 —— 世界出现了预期变化，用户的这一份
   *  同意已被兑现为一次不可逆操作，用后即焚。
   *  Τ 纪元：仅在消费**成功**时发射正示范事件（用户背书+世界验证的双重证据）；
   *  无效/过期/未授予的消费拒绝不发射（世界没变，教育无从谈起）。 */
  consume(token: string): boolean {
    const pa = pending.get((token || '').trim());
    if (!pa) return false;
    pending.delete(pa.token); // 用后即焚：即使校验失败也不留第二次机会
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
   *  预算与令牌** —— 拒绝置于一切簿记变异之前）；缺省不带 opts ⇒ 零行为。 */
  beginAttempt(token: string, opts?: BeginAttemptOpts): boolean {
    // W3-1：托管前置闸门 —— 「没有逆转预案就绝无派发预留」的执法点。
    // 策略表查不到补偿路径的拒绝发生在铸造面（reversalEscrow.mintPlan
    // fail-closed），此处兜底的是「跳过铸造直接派发」的路径。
    if (dispatchEscrowHook !== null && opts?.escrow !== undefined) {
      let verdict: DispatchEscrowVerdict;
      try {
        verdict = dispatchEscrowHook({
          token: String(token ?? ''),
          planId: opts.escrow.planId,
          semantics: opts.escrow.semantics,
        });
      } catch {
        verdict = { ok: false, reason: 'plan-invalid', detail: 'escrow gate threw — failing closed' };
      }
      if (!verdict.ok) {
        lastEscrowBlock = {
          token: String(token ?? ''),
          planId: opts.escrow.planId,
          semantics: opts.escrow.semantics,
          reason: verdict.reason,
          ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}),
          at: Date.now(),
        };
        return false;
      }
    }
    const pa = pending.get((token || '').trim());
    if (!pa || !pa.granted || Date.now() > pa.expiresAt) {
      if (pa) pending.delete(pa.token); // 过期/无效即焚，不留僵尸
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
    fireEscrowSettlement(String(token ?? ''), 'attempt-failed', reason);
    const pa = pending.get((token || '').trim());
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

  /** 作废令牌：用户拒绝（grant=false）时立即调用，防止误用 */
  revoke(token: string): void {
    pending.delete((token || '').trim());
  },

  /** W1-2（H1）：执行侧读取面 —— 派发前读批注 patch 修正计划。
   *  消费点在工具派发层（click_mouse / click_element / drag_mouse 在
   *  beginAttempt 之前读 patch 修正 target_description / 坐标 / 工具形状）；
   *  该层不在本簇领地 ⇒ 在此暴露读取 API，接线见 W1-2 报告。 */
  amendmentOf(token: string): ApprovalAmendment | null {
    const pa = pending.get((token || '').trim());
    return pa?.amendment ?? null;
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

  /** 清理过期令牌（防内存缓慢泄漏） */
  sweep(): void {
    const now = Date.now();
    for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
  },
};

// ─── W3-1（旗舰 S1 逆转托管）：派发托管钩子 —— beginAttempt 前后，别无他处 ───
//
// S1 把 saga 补偿语义移植到 GUI 物理操作：危险动作派发前必须铸造逆转预案
// （reversalEscrow.mintPlan —— 焦点窗口/前态哈希/剪贴板备份/补偿路径，WAL 先行
// 落盘）；验收失败或用户喊停 ⇒ 按预案自动补偿；补偿失败 ⇒ 升级人工介入报告。
// 本模块只加两个**旁路钩子**，令牌/批注/队列语义零变化：
//   · 派发前置闸门（setDispatchEscrowHook）—— beginAttempt(token, {escrow:{planId}})
//     携托管预案调用时同步校验：无预案/预案无效/令牌错配/TTL 已过 ⇒ false
//     （fail-closed：没有预案就绝无派发预留；不烧预算、不动令牌 —— 拒绝发生在
//     一切簿记变异之前）。缺省不携带 escrow opts 或钩子未注册 ⇒ 零行为
//     （既有调用方与既有测试原样通过）。
//   · 结算钩子（setEscrowSettlementHook）—— consume 成功 ⇒ 'verified'（预案
//     关闭，无需补偿）；attemptFailed ⇒ 'attempt-failed'（触发补偿）。
//     fire-and-forget + 异常全吞（旁路义务：托管故障绝不炸审批主流程）。

/** W3-1（S1）：派发前置闸门的校验请求（beginAttempt 的 opts.escrow 投影） */
export interface DispatchEscrowCheck {
  token: string;
  /** 派发层铸造所得的预案 id（缺席 ⇒ plan-required —— 预案先行铸造的执法点） */
  planId?: string;
  semantics?: string;
}

/** W3-1（S1）：闸门裁决（reason 供派发层组装结构化「人类亲办」指引） */
export type DispatchEscrowVerdict =
  | { ok: true }
  | {
    ok: false;
    reason:
    | 'plan-required'      // 未携带预案 —— 必须先 mintPlan（fail-closed）
    | 'plan-invalid'       // 预案不在场（未知/已结算/内部故障）
    | 'plan-expired'       // 预案 TTL 已过（重铸后再派发）
    | 'plan-token-mismatch'; // 预案为另一令牌铸造
    detail?: string;
  };

/** beginAttempt 的托管 opts（缺省 undefined ⇒ 零行为 —— 正交性的执法面） */
export interface BeginAttemptOpts {
  escrow?: { planId?: string; semantics?: string };
}

/** 派发前置闸门（null = 未注册 ⇒ beginAttempt 的托管面缺席，零行为） */
let dispatchEscrowHook: ((check: DispatchEscrowCheck) => DispatchEscrowVerdict) | null = null;
/** 结算钩子（null = 未注册） */
let escrowSettlementHook: ((token: string, verdict: 'verified' | 'attempt-failed', reason?: string) => void) | null = null;
/** 最近一次托管拦截（透明化面 —— 派发层组装拒绝指引的事实源） */
let lastEscrowBlock: EscrowBlockInfo | null = null;

/** 挂载/卸载派发前置闸门（fn=null 卸载）。钩子由 reversalEscrow.arm 单点注册。 */
export function setDispatchEscrowHook(fn: ((check: DispatchEscrowCheck) => DispatchEscrowVerdict) | null): void {
  dispatchEscrowHook = fn;
}

/** 挂载/卸载结算钩子（fn=null 卸载）。钩子内的一切异常由发射点全吞。 */
export function setEscrowSettlementHook(fn: ((token: string, verdict: 'verified' | 'attempt-failed', reason?: string) => void) | null): void {
  escrowSettlementHook = fn;
}

/** 最近一次托管拦截的透明化（派发层把 reason 组装进 ACTION_REQUIRED 指引） */
export interface EscrowBlockInfo {
  token: string;
  planId?: string;
  semantics?: string;
  reason: 'plan-required' | 'plan-invalid' | 'plan-expired' | 'plan-token-mismatch';
  detail?: string;
  at: number;
}

/** 最近一次托管拦截（无拦截 ⇒ null；仅最近一条 —— 透明化面，非审计面） */
export function escrowBlockOf(): EscrowBlockInfo | null {
  return lastEscrowBlock;
}

// ─── W2-1（H4 暂存式离线批准队列）：审批请求超时无人应答 ⇒ 降级暂存模式 ───
//
// 提案 H4 的场景：用户离开（下班/睡觉），agent 的不可逆动作卡在阻塞审批上
// 一无所获。降级暂存（staging）把「人在场的实时同意」换成「人回来后的一次
// 批量裁决」：
//   · 触发 —— request_approval 铸造的请求超过暂存超时（X 分钟）仍无人 grant
//     ⇒ stageAction 把该动作连同证据链（截图引用/动作形状/场景指纹/风险档）
//     入待批队列，agent 继续执行一切**可逆**部分；
//   · 通道资格 —— 暂存是降级而非越权：只在带外通道在场（宿主已接
//     wireDoctorVerdictChannel ⇒ confirmCodeChannel 武装）时可用；通道/宿主
//     缺席 ⇒ stageAction 拒绝（channel-absent），维持现行阻塞审批（诚实降级
//     的方向是更保守，不是更自动）；
//   · 持久化 —— 队列经注入存储端口落盘（tmp + rename 原子写 + fsync，与
//     checkpoint.ts 同律：要么完整旧档要么完整新档，绝无半档）；存储缺席 =
//     仅内存（跨进程不保 —— 诚实降级）。checkpoint 另有 approval-queue 段
//     （会话恢复主源，见 checkpoint.ts W2-1 注记）；
//   · 晨报消费 —— sleep 第⑥幕经注入 dep 读 pendingSummary，待批清单进晨报
//     （见 src/sleep/index.ts W2-1 段）；
//   · 批量裁决 —— adjudicate(ids, grant, note) 复用 W1-2 批注协议：一次批注
//     可携带对多项的裁决，每个条目按自身描述各铸一份 amendment（透传给续跑
//     执行令牌）。每项 grant 消耗一枚 Y-10 同意预算令牌（批量裁决不是 click-
//     fatigue 的后门：一夜批 100 个不可逆操作仍然被桶封顶）；deny 不计费；
//   · TTL 保守律 —— 条目过期**不自动作废**：grant 过期条目被拒绝
//     （ttl-expired，须重走完整审批 —— 带外码人证重新铸造），条目留在队列
//     里持续出现在晨报中直到用户显式 deny（宁可唠叨，不可静默蒸发）；
//   · 续跑 —— takeGranted() 落盘先行（持久化失败 ⇒ 拒绝交出执行权 —— 宁可
//     保守不可双发），然后铸造一枚**已授予**的执行令牌（amendment 随行，
//     执行侧 applyAmendment 照常消费；不重复扣 Y-10 —— 批量裁决时已扣）。
//     条目的 stepCursor（入队时 journal 条数）是续跑步账：恢复后只重演此后
//     的步骤，已暂存的可逆部分不重复执行；
//   · 防御式 —— 本段一切公开面绝不抛：存储/时钟/输入垃圾一律收敛为诚实
//     返回值（ok:false + reason / 归零恢复），错误细节记入 queueStats()。

/** W2-1（H4）：队列条目的证据链 —— 入队时快照（动作形状即刻脱敏，同 Τ 纪元） */
export interface QueuedActionEvidence {
  /** 截图引用（journal/感知侧的锚点字符串；截 200） */
  screenshotRef?: string;
  /** 铸造时快照并脱敏的动作形状（type_text 只记工具名+长度桶） */
  actionShape?: ActionShape;
  /** 场景指纹（截 100） */
  sceneFingerprint?: string;
  /** 风险档（截 32 —— riskGate 的档位标签） */
  riskTier?: string;
}

/** W2-1（H4）：裁决结果（amended 批注透传） */
export interface QueuedApprovalDecision {
  verdict: 'granted' | 'denied';
  at: number;
  /** 批注式裁决铸出的 amendment patch（W1-2 协议；续跑令牌原样携带） */
  amendment?: ApprovalAmendment;
}

/** W2-1（H4）：待批队列条目 */
export interface QueuedApprovalEntry {
  /** 条目 id（QA- 前缀 CSPRNG —— 批量裁决的寻址面） */
  id: string;
  /** 触发本条目的审批令牌（追溯面；令牌自身可随后续期/焚毁，条目独立存活） */
  token: string;
  /** 待批动作描述（截 200，与批注预算同律） */
  description: string;
  /** 证据链（入队时快照） */
  evidence: QueuedActionEvidence;
  /** 入队时间（注入时钟） */
  enqueuedAt: number;
  /** TTL 宽度（ms） */
  ttlMs: number;
  /** TTL 到期（过期 ⇒ 须重走完整审批，不自动作废 —— 安全保守） */
  expiresAt: number;
  /** 续跑步账：入队时的 journal 条数（恢复后只重演此后的步骤 —— 可逆部分
   *  已在账上，不重复执行）；缺省 = 未提供（调用方无 journal 面时的诚实缺席） */
  stepCursor?: number;
  /** 裁决结果（缺省 = 待批） */
  decision?: QueuedApprovalDecision;
}

/** stageAction 的失败成因（'internal' = 防御式兜底，正常流不可达） */
export type StageFailureReason =
  | 'channel-absent'      // 带外通道缺席 —— 暂存不可用，维持阻塞审批（诚实降级）
  | 'invalid-token'       // 令牌缺席/已消费（须先 request_approval 铸造）
  | 'already-granted'     // 令牌已授予 —— 交互路径已恢复，无需暂存
  | 'not-timed-out-yet'   // 未到暂存超时（retryInMs = 剩余等待）
  | 'queue-full'          // 队列封顶（须先裁决/清理 —— 逼一次人工介入）
  | 'internal';

export type StageOutcome =
  | { ok: true; entry: QueuedApprovalEntry; duplicate?: boolean }
  | { ok: false; reason: StageFailureReason; retryInMs?: number };

/** 批量裁决的单项产出 */
export type AdjudicateItemOutcome =
  | 'granted'           // 已批（amendment 已铸，等待续跑消费）
  | 'denied'            // 已拒（amendment 已铸 —— 否决理由随行）
  | 'rate-limited'      // Y-10 同意预算耗尽（条目保持待批，冷静期后重试）
  | 'ttl-expired'       // 条目过期 —— 保守拒绝，须重走完整审批
  | 'unknown-id'        // 无此条目（或已被续跑消费）
  | 'already-decided';  // 已裁决过（双重裁决封堵 —— 决不翻案）

/** W2-1（H4）：存储端口（注入面 —— 离线可测；生产用文件原子写实现） */
export interface ApprovalQueueStorage {
  /** 读持久化队列原文（缺席/不可读 ⇒ null）；绝不抛 */
  load(): string | null;
  /** 原子落盘（tmp + rename 项目惯例）；返回 ok/error，绝不抛 */
  save(text: string): { ok: boolean; error?: string };
}

/** 暂存超时缺省：5 分钟（X 分钟无人应答 ⇒ 降级暂存；可用 armApprovalQueue 覆盖） */
const DEFAULT_STAGING_TIMEOUT_MS = 300_000;
/** 队列 TTL 缺省：24h（覆盖一夜 —— 晨报裁决的窗口；过期须重走完整审批） */
const DEFAULT_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
/** 队列条目封顶：64（无界队列 = 无界晨报 —— 封顶逼人工介入） */
const MAX_QUEUE_ENTRIES = 64;
/** 持久化档版本 */
const APPROVAL_QUEUE_VERSION = 1;

/** W2-1（H4）：文件存储实现（原子写：tmp + fsync + rename —— checkpoint.ts 同律） */
export function createApprovalQueueFileStorage(filePath: string): ApprovalQueueStorage {
  return {
    load(): string | null {
      try {
        if (!filePath || !existsSync(filePath)) return null;
        const text = readFileSync(filePath, 'utf8');
        return typeof text === 'string' && text.trim() !== '' ? text : null;
      } catch {
        return null; // 读故障（含 ENOENT 竞态）= 无持久化队列（诚实方向）
      }
    },
    save(text: string): { ok: boolean; error?: string } {
      if (!filePath) return { ok: false, error: 'approval-queue path is empty' };
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

// ── 队列模块态（全部经 armApprovalQueue 注入；缺省 = 内存队列 + 真钟） ──

let queueStorage: ApprovalQueueStorage | null = null;
let queueNow: () => number = Date.now;
let queueStagingTimeoutMs = DEFAULT_STAGING_TIMEOUT_MS;
let queueTtlMs = DEFAULT_QUEUE_TTL_MS;
let queueEntries: QueuedApprovalEntry[] = [];
let queueLoaded = false;
let queuePersistError: string | undefined;

function newQueueId(): string {
  return 'QA-' + randomBytes(8).toString('hex').toUpperCase();
}

/** 安全时钟读数（注入时钟抛错/回垃圾 ⇒ 0 —— 绝不因计时面炸队列） */
function qNow(): number {
  try {
    const t = queueNow();
    return typeof t === 'number' && Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

/** 字符串净化：非字符串/空 ⇒ undefined；否则截断（Token 纪律与隐私截断） */
function strOrUndef(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.slice(0, max) : undefined;
}

/** 证据链净化：入队面（RawActionShape 即刻脱敏）与恢复面（已脱敏形状直通）共用 */
function sanitizeEvidence(raw: unknown): QueuedActionEvidence {
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
function cloneEntry(e: QueuedApprovalEntry): QueuedApprovalEntry {
  return JSON.parse(JSON.stringify(e)) as QueuedApprovalEntry;
}

/** 恢复面净化：单条目结构校验（垃圾 ⇒ null 弃置 —— 好条目不连坐） */
function sanitizeQueueEntry(raw: unknown): QueuedApprovalEntry | null {
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
    if (dd.verdict === 'granted' || dd.verdict === 'denied') {
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

/** 惰性装载：首次触queue面前从存储读档（垃圾档 ⇒ 空队列归零 —— 绝不抛） */
function ensureQueueLoaded(): void {
  if (queueLoaded) return;
  queueLoaded = true;
  queueEntries = [];
  if (queueStorage === null) return; // 仅内存（跨进程不保 —— 诚实降级）
  try {
    const text = queueStorage.load();
    if (text === null) return;
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return; // 垃圾档 ⇒ 归零
    const entries = (parsed as Record<string, unknown>).entries;
    if (!Array.isArray(entries)) return; // 垃圾段 ⇒ 归零
    const seen = new Set<string>();
    for (const raw of entries) {
      const e = sanitizeQueueEntry(raw);
      if (e === null || seen.has(e.id)) continue; // 垃圾条目/重复 id 弃置
      seen.add(e.id);
      queueEntries.push(e);
    }
  } catch {
    queueEntries = []; // 解析故障 ⇒ 归零（防御式：坏档不炸队列，也不冒充恢复）
  }
}

/** 队列落盘（存储缺席 = 仅内存恒 ok；失败记 queuePersistError —— 绝不抛） */
function persistQueue(): { ok: boolean; error?: string } {
  if (queueStorage === null) return { ok: true };
  try {
    const r = queueStorage.save(JSON.stringify({
      version: APPROVAL_QUEUE_VERSION,
      savedAt: qNow(),
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
 *  Y-10 预算已在 grantDetailed 计费，此处不重复扣）。 */
function recordTokenDecision(token: string, granted: boolean, note?: string): void {
  try {
    ensureQueueLoaded();
    const entry = queueEntries.find(e => e.token === token && e.decision === undefined);
    if (!entry) return;
    const now = qNow();
    entry.decision = {
      verdict: granted ? 'granted' : 'denied',
      at: now,
      ...(note ? { amendment: castAmendmentFor(entry.description, note, now) } : {}),
    };
    persistQueue();
  } catch {
    /* 队列是审批的旁路：传播失败 = 条目留待批量裁决（保守方向） */
  }
}

/** 续跑执行令牌铸造：已授予（不扣 Y-10 —— 批量裁决时已扣）、amendment 随行、
 *  生命周期同常规铸造（V 纪元验收式消费照常执法）。 */
function mintResumedToken(entry: QueuedApprovalEntry): string {
  const now = qNow();
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
  pending.set(pa.token, pa);
  return pa.token;
}

/** W2-1（H4）：暂存式离线批准队列（模块单例 —— 插件卸载随闭包消亡） */
export const approvalQueue = {
  /** 武装（幂等）：注入存储/时钟/超时。缺省 = 内存队列 + 真钟 + 5min/24h。
   *  组合根挂点见 doctorChannel.wireDoctorVerdictChannel（W2-1 段）。绝不抛。 */
  arm(opts: {
    storage?: ApprovalQueueStorage | null;
    now?: () => number;
    stagingTimeoutMs?: number;
    ttlMs?: number;
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
      queueEntries = [];
      queueLoaded = false;
      queuePersistError = undefined;
    } catch {
      /* 武装失败 = 保持现状（阻塞审批原样 —— 诚实降级） */
    }
  },

  /** 暂存资格透明化（request_approval 工具的超时提示事实源） */
  stagingAvailability(): { available: boolean; stagingTimeoutMs: number; ttlMs: number; persistent: boolean } {
    return {
      available: confirmCodeChannel !== null, // 通道在场 = 宿主在场 = 暂存资格
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
      if (confirmCodeChannel === null) return { ok: false, reason: 'channel-absent' };
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
      persistQueue(); // 失败 ⇒ 内存队列仍有效（跨进程降级诚实记录于 queueStats）
      return { ok: true, entry: cloneEntry(entry) };
    } catch {
      return { ok: false, reason: 'internal' }; // 防御式兜底（正常流不可达）
    }
  },

  /** 批注式批量裁决（晨报消费面）：ids 缺省/空 ⇒ 全部待批条目（一次批注一把抓）。
   *  每项 grant 消耗一枚 Y-10 同意预算（桶空 ⇒ 该项 rate-limited 保持待批）；
   *  deny 恒可（过期条目也可拒 —— 用户清场的出口）；grant 过期条目保守拒绝
   *  （ttl-expired —— 须重走完整审批）。已裁决条目拒绝翻案。绝不抛。 */
  adjudicate(ids: unknown, grant: boolean, note?: string): {
    results: Array<{ id: string; outcome: AdjudicateItemOutcome; retryInMs?: number }>;
    persisted: boolean;
  } {
    try {
      ensureQueueLoaded();
      const wanted: string[] = (Array.isArray(ids) ? ids : [ids])
        .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        .map(x => x.trim());
      const cleanNote = strOrUndef(note, AMENDMENT_NOTE_MAX);
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
   *  重现于晨报，用户重裁）。无已批条目 ⇒ null。绝不抛。 */
  takeGranted(): { entry: QueuedApprovalEntry; executionToken: string } | null {
    try {
      ensureQueueLoaded();
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
   *  items = 全部未裁决条目（含过期 —— 过期也要唠叨，直到用户显式 deny）。 */
  pendingSummary(): {
    pending: number;
    expired: number;
    grantedAwaitingResume: number;
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
    let pending = 0, expired = 0, grantedAwaitingResume = 0, deniedAwaitingPrune = 0;
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
      else deniedAwaitingPrune++;
    }
    return { pending, expired, grantedAwaitingResume, deniedAwaitingPrune, items };
  },

  /** checkpoint 采集面：队列快照（深拷贝 —— 采集后队列继续演化互不影响） */
  dumpQueue(): QueuedApprovalEntry[] {
    ensureQueueLoaded();
    return queueEntries.map(cloneEntry);
  },

  /** checkpoint 恢复面（防御性恢复 —— 垃圾值归零）：整段垃圾 ⇒ 空队列；
   *  条目级垃圾 ⇒ 弃置坏条目保住好条目（不连坐）。绝不抛。 */
  restoreQueue(rawEntries: unknown): { kept: number; dropped: number } {
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
  },

  /** 透明化（测试/遥测面）：队列规模与最近一次持久化错误 */
  queueStats(): {
    entries: number; pending: number; decided: number;
    storageArmed: boolean; stagingTimeoutMs: number; ttlMs: number;
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
} = {}): void {
  approvalQueue.arm(opts);
}

/** W 纪元（W-1 隔离缝）：审批簿记归零 —— 测试隔离与插件卸载共用。
 *  Τ 纪元：观察者面随簿记一并归零（observer=null、开关回默认 true ——
 *  config 的铸入由下一次装配重做），隔离缝不漏教育旁路的全局态。
 *  W1-2（S2）：带外确认码通道一并卸载（恢复无码降级默认 —— 测试的
 *  确定性基线；生产由组合根的下一次 wireDoctorVerdictChannel 重新武装）。
 *  W2-1（H4）：暂存队列一并归零（内存条目清空、存储/时钟注入卸载回缺省 ——
 *  测试不得读到上一用例的持久化队列；生产由下一次组合根武装重接）。
 *  W3-1（S1）：托管钩子/拦截簿记一并卸载（gate=null、settlement=null、
 *  block=null —— 托管面回「未武装」默认；生产由 reversalEscrow.arm 重接）。
 *  W4-3（S5）：可逆性分级注册表的证据账一并归零（approval 现在直接喂
 *  注册表 —— 隔离缝不漏旁路的全局态，与 Τ 观察者面同律）。 */
export function resetApproval(): void {
  pending.clear();
  grantBucket.reset();
  demoObserver = null;
  demonstrationsEnabled = true;
  confirmCodeChannel = null;
  dispatchEscrowHook = null;
  escrowSettlementHook = null;
  lastEscrowBlock = null;
  queueStorage = null;
  queueNow = Date.now;
  queueStagingTimeoutMs = DEFAULT_STAGING_TIMEOUT_MS;
  queueTtlMs = DEFAULT_QUEUE_TTL_MS;
  queueEntries = [];
  queueLoaded = false;
  queuePersistError = undefined;
  try { reversibilityRegistry.reset(); } catch { /* 隔离缝防御：注册表故障不炸审批归零 */ }
}
