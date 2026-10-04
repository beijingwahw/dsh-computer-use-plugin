// src/autonomy/autoPilot.ts
// W6-1 结构性保留登记（smell.over-engineering）：driveLoop 是单一近 800 行的
// Φ-4 闭环状态机（十段闸门/旁路/记账以环内闭包状态就地织成，其 JSDoc 即流程法），
// 拆分须重构闭包状态与步序语义 —— 属逻辑重构，违反「行为零变化」红线，登记保留。
// ΑΩ-R13（W6-1 债清偿）：上述保留债已拆解 —— driveLoop 循环体按 ⓪-⑩ 相位拆为
// 具名相位函数族（fuseGuard…finalEvaluation，职责与工单号见各相位头注释），
// 循环律编号与相位函数一一对应；纯结构重构，行为逐字节保持（本文件汉明表
// 同步迁往 dialects/hashing 单一事实源）。
// 纪元 Φ（Φ-4 核心闭环驱动器）：识别 → 判断 → 宪法 → 执行 → 验证 → 进化 的自主智能环主脉。
// 本文件只做"环"：世界感子（Φ-2）、策略引擎（Φ-3）、目标机（Φ-1）、宪法（Φ-8）全部经
// AutonomyDeps 注入 —— 时间（now）与睡眠（sleep）同样注入，离线测试零真钟零真睡。
// 纪元 Η（Η-1 认识论闸门接线）：policy.decide 之后、constitution.check 之前长出
// Φ-7 adviseAction 闸门（置信×代价×云脑×预算四维裁决）—— deps.epistemicGate 缺席时
// 整段闸门零执行，与接线前逐字节同路径。
// 纪元 Ι（经验置信换源）：deps.selfModel 在场且对当前动作给出非 null 建议时，
// 闸门置信从动作自报换为经验胜任度后验（(动作类×场景桶) 衰减 Beta 均值）——
// agent 在自己历史上反复失败的格子前面真正知道怕；缺席/null ⇒ 自报链逐字节不变。
// 纪元 Ε（预言引擎接线）：execute 之前 mint（快照屏型指纹 × 动作键），动作后
// 第一次感知到达即 settle（新屏型 = actualType）—— 纯审计旁路三铁律：
// deps.prophecy 缺席 ⇒ 整段零执行（逐字节旧路径）；任何旁路故障只丢预言绝不
// 炸环；PilotResult 既有字段分毫不动（至多一步 journal 注记 prophecy:hit/miss/
// no-model，不扩字段结构）。
// W1-3（C1 Act-Expectation 免看门控）：② 感知步之前的免看裁决 —— 动作下发时
// 按种类×风险档标注预期视觉效应三档（必变/可能变/无影响）；上步属「无影响 +
// 双层 benign」最窄类（或 benign wait 值守）且弹窗活跃标志不在场时，先经注入的
// 本地帧哈希端口（deps.frameHash）比对前后屏 dHash —— 屏未变 ⇒ 跳过重型感知
// （VLM/OCR），以携带轻量文本观察「已执行，屏未变」的合成快照推进循环；变化
// 超阈值 ⇒ 唤醒完整感知；wait 由 dHash 循环值守（间隔 × 上限）。安全红线：门控
// 只允许跳过「确认型」感知，五重与门缺一即照旧感知；弹窗在场禁止门控；哈希
// 端口缺席 ⇒ 门控整体降级（与接线前逐字节同路径，生产接线前零行为变化）；
// {enabled:false} 可完全关闭（测试总闸）。触发/跳过/唤醒次数经 StepRecord.note
// 与 PilotResult.summary 记账（最小侵入挂点，不扩字段结构）。
// 铁律：具名导出、绝不抛异常（任何依赖异常都收敛为 error 步，绝不炸环）。
import type { GoalPhase, GoalSpec, GoalStateMachine } from './goalState';
import type { PolicyAction, PolicyContext, PolicyDecision, StepOutcome } from './policyEngine';
import type { WorldSnapshot } from './worldSnapshot';
import type { ConstitutionContext, ConstitutionVerdict, RiskTier } from './autonomyConstitution';
import { adviseAction, type UncertaintyReport } from './uncertainty';
// W4-0（B 接线）：岔路账/岔路卡的评分上下文与载荷类型（type-only —— 类型擦除后
// autoPilot 的运行时依赖图零变化；branchLedger 单例的注入面在 buildAutonomyStack）。
// ScoringContext 由 counterfactual 直接出（branchCards 只消费不转发 —— 就近事实源）。
// W5-5（缝3）：withSteerBias 升为值导入 —— steer(k) 换支偏置铸入 ③¼ 的评分
// 上下文（branchCards → counterfactual/diagnosis 均下游，与本文件零回路）。
import { withSteerBias, type BranchCard, type BranchStepMeta } from '../branchCards';
import type { ScoringContext } from './counterfactual';
// W4-0（B 接线）：岔路账落账的评分物料 —— 与 policyEngine 并列破平同一方言
//（goalKeywords/triedActionKeys 的单一事实源，不复制分词逻辑）。
import { extractGoalKeywords } from './policyEngine';
import { actionSignature } from './counterfactual';
// W8-B4（判据证伪能力）：终局判据独立评估器官（否定判据 + fuzzy 容错 + OCR 缺席
// 诚实降级 —— 三态判决纪律；⑧′ 处消费）。autonomy 包内模块，零回路。
import { buildCriteriaPairs, evaluateCriteria } from './criteriaEval';
// ΑΩ-R13（W6-1 债清偿 · 汉明方言归一）：W1-3 免看门控的 dHash 汉明距离从本文件
// 私有表（原 gateHexHamming/GATE_NIBBLE_POPCOUNT）迁往跨器官方言单一事实源
//（nibble popcount 查表 + null 不可比语义，逐字节同律）。
import { hammingDistanceHex } from '../dialects/hashing';
// 纪元 Ε：预言端口与注记/动作键方言（路径显式指到桶文件 —— 目录导入在 Node
// strip 装载器是 ERR_UNSUPPORTED_DIR_IMPORT，纪元 Ι 同律）。
import {
  prophecyActionKey,
  prophecyJournalTag,
  type ProphecyPort,
} from '../prophecy/index';
// W3-7（R2 探索前沿策略）：探索端口类型 —— 类型擦除后零运行时耦合（账本本体
// 与独立持久化在 ./exploration，闭环只消费 advise/observe 两个面 + 总闸）。
import type { ExplorationAdvice, ExplorationPort } from './exploration';
// W4-0（B 集成接线）：第三批器官的环内消费 —— ① 活意图漂移（W3-5）：steer 端口
// 点亮时每步 maybeCheckAndAsk，出题 ⇒ steer-drift 升级提问（ask_human 拦截风格，
// 应答经 steer_answer 工具对同一会话结算）；② 岔路账（W3-6）：每步决策既定后
// record（rankTopK 与 scoreOptions 同源内核），goal failed/aborted 时 generateCard
//（lastBranchCard() 出口）。两段均为纯旁路：端口缺席 ⇒ 逐字节旧路径，PilotResult
// 既有字段分毫不动（零回归红律）。

/** 单步执行记录 —— 轨迹最小单元（审计、回放与进化的原料） */
export interface StepRecord {
  /** 步序号（从 0 起，含 error 步与 wait 沉降步） */
  stepIndex: number;
  /** 本步动作（感知/判断阶段异常时为合成 declare 动作） */
  action: PolicyAction;
  /** 世界反馈的结局分类 */
  outcome: StepOutcome;
  /** 本步感知快照的 dhash（感知失败则为 null） */
  snapshotDhash: string | null;
  /** 记录时刻（注入时钟） */
  at: number;
  /** 附注（策略注解 / 异常归因） */
  note?: string;
  /** 宪法判决的风险分层（check 盖章；缺席 = 未过宪法或判决未给出，审计回退 action.riskTier） */
  effectiveRiskTier?: RiskTier;
}

/** 升级归因枚举补章：'epistemic-gate'（纪元 Η —— 认识论闸门 ask_human 熔断） */
export type PilotEscalateReason = 'constitution-veto' | 'approval-required' | 'policy-escalate' | 'epistemic-gate';

/**
 * 自我模型建议（纪元 Ι）：经验校准置信 —— 按（动作类 × 场景桶）衰减 Beta
 * 胜任度后验的均值，附支撑证据量与溯源标记（纯数据）。
 */
export interface SelfModelAdvice {
  /** 经验置信（Beta 后验均值，[0,1]） */
  confidence: number;
  /** 支撑证据量（衰减后有效值） */
  n: number;
  /** 溯源标记：'self-model'（经验后验，区别于模型自报） */
  source: string;
}

/**
 * 自我模型结构端口（纪元 Ι）：闭环只消费 adviseConfidence 这一面（结构性契约，
 * 与 PolicyPort/ConstitutionPort 同律）—— 真实 SelfModel 单例
 * （src/selfmodel/index.ts）天然满足，测试桩只须实现同名方法。
 * 第二参是场景指纹原文（快照 dhash；桶量化由实现方完成 —— 闭环零方言）；
 * 冷启动/证据不足时实现方返回 null（诚实无知 ⇒ 闭环回落纪元 Η 自报链）。
 */
export interface SelfModelPort {
  /** 经验置信建议：null = 无足够经验（调用方回落自报置信） */
  adviseConfidence(action: unknown, sceneFingerprint?: unknown): SelfModelAdvice | null;
}

/**
 * 认识论闸门配置（纪元 Η-1）：Φ-7 adviseAction 四维裁决的全部入参适配 + 执法红律收窄。
 *
 * · 错误代价：按 action.riskTier 映射 destructive/sensitive ⇒ high、benign ⇒ low
 *   （未知/垃圾分层按 benign ⇒ low，与宪法判决分层收口同向保守）；
 * · 有效置信：动作自报 confidence（payload.confidence 优先，其次 action.utility ——
 *   ② 级点击动作的 utility 即元素置信，是 policyEngine 的既有约定），缺席/非法 ⇒
 *   0.5 保守中值；
 * · vlmAvailable：云脑（VLM）当下是否可咨询（缺省 false —— 离线保守，绝不新增网络调用）；
 * · 预算：步数与时间双轨各折剩余百分比取紧者（无轨 ⇒ 100）。
 *
 * 执法红律（ask_human/abort 熔断的收窄面，缺省全幅 = 任何分层任何置信都熔断）：
 *   · blockOnlyTiers —— 仅表内 riskTier 可熔断（缺省 null = 全部分层）；
 *   · blockOnlyBelowConfidence —— 仅自报置信严格小于此值可熔断（缺省 +∞ = 不设限）。
 *   不满足红律的 ask_human/abort 与 ask_vlm/proceed 同途：注记放行（不新增网络调用）。
 * buildAutonomyStack 默认接线传「仅 destructive 且自报置信 < 0.3」的窄面（红律：良性/
 * 常规置信路径绝不拦截，sensitive 审批流零影响）；测试与显式接线可用全幅缺省。
 */
export interface EpistemicGateOptions {
  /** 云脑（VLM）当下是否可咨询（布尔或零参函数 —— 每次裁决时求值）；缺省 false */
  vlmAvailable?: boolean | (() => boolean);
  /** ask_human/abort 熔断的 riskTier 白名单；缺省不设白名单（全部分层可熔断） */
  blockOnlyTiers?: ReadonlyArray<RiskTier>;
  /** ask_human/abort 熔断的自报置信上限（仅 raw < 此值可熔断）；缺省不设限 */
  blockOnlyBelowConfidence?: number;
}

/**
 * W1-3 免看门控配置（C1 Act-Expectation 免看门控）：全部字段缺省即最窄默认 ——
 * 门控开启，但仅对「预期无影响 × 申报 benign × 宪法盖章 benign」的最窄类别
 * 生效（外加 benign wait 的 dHash 值守）。通过注入端口可完全关闭（测试总闸：
 * {enabled: false}）；哈希端口（deps.frameHash）缺席时门控整体降级为照旧感知
 * （与接线前逐字节同路径）。
 */
export interface PerceptionGateOptions {
  /** 总闸：false ⇒ 门控完全关闭（一切感知照旧）；缺省 true */
  enabled?: boolean;
  /** dHash 汉明容差（仅本门控使用，与 worldSnapshot 缺省 3 同律）；缺省 3 */
  hammingTolerance?: number;
  /** wait 值守轮询间隔毫秒；缺省 250 */
  pollIntervalMs?: number;
  /** wait 值守上限毫秒（到顶仍未变 ⇒ 轻量观察推进循环）；缺省 2000 */
  pollMaxMs?: number;
  /** 连续跳过上限：到顶强制一次完整感知（终局判据 OCR 的有界保鲜 —— 旧账不可无限透支）；缺省 1 */
  maxConsecutiveSkips?: number;
}

/**
 * W1-3：动作的预期视觉效应三档（C1 规格第一项）—— 纯函数、绝不抛、对垃圾
 * 输入保守归「必变」（不确定 ⇒ 必看）。从 PolicyAction 动作种类 × 风险档推导：
 *  · 'must-change'（必变）—— sensitive/destructive 的有效参数世界动作：后果
 *    必须目击验证，感知一步不可省；escalate 与未知种类同律归此；
 *  · 'may-change'（可能变）—— benign 的有效参数世界动作（有效落点 click/drag、
 *    非空文本 type、方向合法 scroll、非空键 hotkey —— 如 type 后大概率变）；
 *    wait 的语义就是预期变化，亦归此（由 dHash 值守轮询覆盖，⑥ 不经 execute）；
 *  · 'no-impact'（无影响）—— 观察性动作（inspect/declare/ask_vlm/recall_skill
 *    只看不改世界）与参数无效不会落地的世界动作（无效坐标点击、空文本键入、
 *    空键热键、非法方向滚动 —— 执行面直接记 no_effect 不动作）。
 */
export type ExpectedVisualEffect = 'must-change' | 'may-change' | 'no-impact';

// ─── W4-0（B 接线）：第三批器官的环内消费端口（全部可选 —— 缺席 = 逐字节旧路径） ───

/**
 * W4-0（B）：活意图漂移端口（W3-5 createSteerSession 的环内消费面配置）。
 * 会话本体由 driveLoop 在环起铸造（须绑定当轮 goal —— buildAutonomyStack 铸栈时
 * goal 尚未出生，铸造点只能在环内）；本端口只携带开关与可选覆盖。
 * enabled !== true ⇒ 整段漂移检查零执行（缺省关闭零回归红律 —— 指纹源在场时
 * 语义距离天然偏高，不设开关会在每第 3 步误伤常规跑环）。
 */
export interface SteerWireOptions {
  /** 总闸：仅 enabled === true 时 driveLoop 铸会话并逐步出题 */
  enabled?: boolean;
  /** 漂移报警线覆盖（透传 createSteerSession；缺省 DRIFT_ALERT_THRESHOLD） */
  driftThreshold?: number;
  /** 节流窗覆盖（透传 createSteerSession；缺省 STEER_THROTTLE_STEPS） */
  throttleSteps?: number;
  /** 可选诊断信号源（透传 createSteerSession —— B 选项修正文本的自动生成素材） */
  diagnosisNote?: () => string | null;
}

/**
 * W4-0（B）：岔路账端口（W3-6 BranchLedgerBook/generateBranchCard 的环内结构窄面）。
 * 真实实现 = buildAutonomyStack 注入的单例适配（record 内部经 rankTopK 与
 * scoreOptions 同一评分内核落账）；测试桩实现同名两法即可注入。
 */
export interface BranchLedgerWirePort {
  /** 每步决策既定后落账（Top-K 候选 + 诚实预测效用 + 支点引用） */
  record(options: PolicyAction[], ctx: ScoringContext, meta?: BranchStepMeta): unknown;
  /** goal failed/aborted 终局相铸岔路卡（三候选 + 失败归因 + 支点） */
  generateCard(failure: { phase: unknown; reason?: unknown; now?: () => number }): BranchCard | null;
}

// ─── W8-B4（tools↔autonomy 破环）：steer 会话结构端口 + 晚绑定注册器 ───
// 本文件不再 import 具名的 steer 会话实现（tools 桶）—— 会话真身（漂移检查/
// 出题/应答结算/换支重放）在 tools 侧铸造，经 bindSteerSessionFactory 注册器
// 喂入本环（装配方向：tools → autonomy 单向；autonomy 对 tools 零 import）。
// 以下端口类型是**结构镜像**（structural port）：只声明闭环与工具转发面实际
// 消费的字段；真身在 tools 侧实现，bindSteerSessionFactory 的注入点即类型
// 相容性的执法点（结构不满足 ⇒ 装配期编译失败）。

/** W8-B4：steer 出题载荷的结构面（driveLoop 只读 drift/reason/amendment.to） */
export interface PilotSteerChoice {
  /** 触发本题主因：融合分 + 趋势 */
  drift: { score: number; trend: string };
  /** 一句中文出题理由 */
  reason: string;
  /** B 选项（改判据）的修正载荷 —— 升级题面回显用 */
  amendment: { to: string };
}

/** W8-B4：换支重放偏置步进面的结构面（③¼ withSteerBias 消费 + 收尾记账） */
export interface PilotSteerBiasStepper {
  /** 扣一步重放预算并返回本步偏置键（超支/已完成/故障 ⇒ null） */
  step(): { preferredActionKeys: string[] } | null;
  /** 预算执法的透明读数（审计面） */
  state(): { status: string; stepsUsed: number; budgetSteps: number };
  /** 重放成功收尾 */
  complete(): void;
}

/**
 * W8-B4：在役 steer 会话的结构面 —— driveLoop 铸造/出题/持卡消费的最小面 +
 * 工具转发与续跑脊梁（经 activeSteerSession）消费的扩展面（answer/pending/
 * drainAmendments/branchCard —— 结构兼容真身，防御式可选）。
 */
export interface PilotSteerSession {
  /** 漂移检查 + 按需出题（纯节律入口，绝不抛） */
  maybeCheckAndAsk(stepIndex: number | null, entropy?: number | null): PilotSteerChoice | null;
  /** 当前待答题目（无则 null） */
  pending(): { drift: { score: number }; answer_format: string } | null;
  /** 应答结算：单字符解析（容错）⇒ A 放行 / B 写回判据 / C 记终止阻塞；垃圾重问 */
  answer(raw: unknown): {
    status: string;
    choice?: string;
    applied?: boolean;
    hint?: string;
    amendment?: { to: string };
    restart?: { kind: string };
    /** W5-5（缝3）：换支成功时的重放指引（偏置载荷 —— 重入脊梁消费） */
    branch?: { bias: { preferredActionKeys: string[] } };
  };
  /** W5-5（缝1，可选面）：取走全部未消费的修订判据（一次性移交） */
  drainAmendments?(): Array<{ goalText: string; amendment: { criterion_index: number; to: string } }>;
  /** W5-5（缝3，可选面）：持有岔路卡（driveLoop 铸卡后注入） */
  holdBranchCard?(card: unknown): void;
  /** W5-5（缝3，可选面）：当前持有的岔路卡（无 ⇒ null） */
  branchCard?(): unknown | null;
  /** W5-5（缝3，可选面）：取走在役换支重放的偏置步进面（一次性移交） */
  takeBranchBias?(): PilotSteerBiasStepper | null;
}

/**
 * W8-B4：steer 会话工厂端口 —— driveLoop 环起铸造会话的唯一通道。
 * 参数面与真身工厂的会话依赖（goal + screenText 指纹源 + 可选覆盖）同构。
 */
export type PilotSteerSessionFactory = (deps: {
  goal: GoalStateMachine;
  screenText?: () => string | null;
  diagnosisNote?: () => string | null;
  driftThreshold?: number;
  throttleSteps?: number;
}) => PilotSteerSession;

/**
 * W8-B4：晚绑定注册器（破环装配面）—— 组合根在装载 tools 侧会话实现时喂入。
 * 未注册即点亮 steer 端口 ⇒ 会话缺席（漂移检查整段零执行 —— 与端口缺席同降级，
 * 绝不炸环绝不伪造会话）；重复注册以后注册者为准，null 可注销（测试隔离缝）。
 */
const w8SteerFactory: { factory: PilotSteerSessionFactory | null } = { factory: null };

/** W8-B4：注册/注销 steer 会话工厂（tools 侧装配点调用；线程化单注册位） */
export function bindSteerSessionFactory(factory: PilotSteerSessionFactory | null): void {
  w8SteerFactory.factory = typeof factory === 'function' ? factory : null;
}

/** W8-B4：当前注册的 steer 会话工厂只读出口（缺省 null —— 审计/测试观察面） */
export function boundSteerSessionFactory(): PilotSteerSessionFactory | null {
  return w8SteerFactory.factory;
}

/** W4-0（B）：在役 steer 会话（driveLoop 铸、跨环存续至下一环替换 —— 出题升级后
 *  用户的单字符应答经 steer_choice/steer_answer 工具对**同一会话**结算，环终清账
 *  会把「升级提问」变成死信；持有者只暴露只读出口，绝不炸） */
const w4ActiveSteer: { session: PilotSteerSession | null } = { session: null };

/** W4-0（B）：当前/最近一次 steer 会话（无 ⇒ null；工具转发面消费） */
export function activeSteerSession(): PilotSteerSession | null {
  return w4ActiveSteer.session;
}

/** W4-0（B）：最近一张岔路卡（goal failed/aborted 时铸造；供换支重放/审计消费） */
const w4LastCard: { card: BranchCard | null } = { card: null };

/** W4-0（B）：最近一张岔路卡的只读出口（未铸 ⇒ null） */
export function lastBranchCard(): BranchCard | null {
  return w4LastCard.card;
}

/** W4-0（B）：接线持有者归零（测试隔离缝 —— 会话/卡片跨 run 存续是设计语义，
 *  生产代码不需要调用） */
export function resetW4PilotWire(): void {
  w4ActiveSteer.session = null;
  w4LastCard.card = null;
}

/** 闭环一次性运行的总汇报 */
export interface PilotResult {
  /** 终局相（取自目标机 evaluate；步保险丝熔断时强制 'aborted'） */
  phase: GoalPhase;
  /** 实际入轨迹的步数（含 error 步与 wait 步） */
  steps: number;
  /** 运行时长毫秒（注入时钟差值，下限 0） */
  durationMs: number;
  /** 全程轨迹 */
  trajectory: StepRecord[];
  /** 一句中文总结：终局相 + 步数 + 达成判据数（必要时含宪法理由） */
  summary: string;
  /** 是否以"升级移交"收场（宪法否决 / 需审批 / 策略主动升级） */
  escalated: boolean;
  /** 升级归因：'constitution-veto' | 'approval-required' | 'policy-escalate' | 'epistemic-gate'（纪元 Η） */
  escalateReason?: string;
}

/**
 * 策略引擎结构端口 —— 闭环只消费 decide 这一面（结构性契约）：
 * 真实 PolicyEngine 实例天然满足（鸭子型），离线测试桩只须实现同名方法即可注入。
 */
export interface PolicyPort {
  /** 消费上下文，产出下一步动作（契约详见 PolicyEngine.decide 的 JSDoc） */
  decide(ctx: PolicyContext): Promise<PolicyDecision>;
}

/**
 * 宪法结构端口 —— 闭环只消费 check 这一面（结构性契约）：
 * 真实 AutonomyConstitution 实例天然满足，测试用判决书桩只须实现同名方法。
 */
export interface ConstitutionPort {
  /** 对待执行动作 + 现场账目出具判决书（契约详见 AutonomyConstitution.check 的 JSDoc） */
  check(action: PolicyAction, ctx: ConstitutionContext): ConstitutionVerdict;
}

/** 闭环全部外部依赖（测试全离线注入的生命线） */
export interface AutonomyDeps {
  /** 世界感知：截屏并结构化为 WorldSnapshot（异常 ⇒ error 步收敛） */
  perceive(): Promise<WorldSnapshot>;
  /** 策略引擎：消费上下文，产出下一步动作（结构性端口 PolicyPort） */
  policy: PolicyPort;
  /** 世界执行：落动作并回报结局与判据证据（异常 ⇒ error 步收敛） */
  execute(action: PolicyAction): Promise<{
    outcome: StepOutcome;
    criteriaEvidence?: Array<{ index: number; status: 'met' | 'violated' }>;
  }>;
  /** 目标状态机（Φ-1）：判据台账 + 相位裁决 */
  goal: GoalStateMachine;
  /** 宪法（Φ-8，结构性端口 ConstitutionPort）：缺省 = 内置全放行铸造器（一律 benign 盖章） */
  constitution?: ConstitutionPort;
  /** 认识论闸门（纪元 Η-1，Φ-7 adviseAction）：decide 之后、宪法之前的置信×代价裁决；
   *  缺席 = 整段闸门零执行（与纪元 Η 前逐字节同路径） */
  epistemicGate?: EpistemicGateOptions;
  /** 自我模型（纪元 Ι，经验胜任度后验）：在场且对当前动作给出非 null 建议时，
   *  认识论闸门的置信源从动作自报换为经验校准置信（步注记 source:'self-model'）；
   *  缺席/返回 null ⇒ 纪元 Η 自报链逐字节不变（零回归红律）。结构性端口
   *  SelfModelPort —— 单例或最小桩皆可注入。 */
  selfModel?: SelfModelPort;
  /** 预言引擎（纪元 Ε，纯审计旁路）：在场 ⇒ execute 前按（屏型指纹 × 动作键）
   *  铸预言、动作后第一次感知到达时结算（hit/miss/no-model 三态入账，错题本
   *  自动生成）；缺席 ⇒ 整段旁路零执行（逐字节旧路径）。结构性端口
   *  ProphecyPort —— 真实 ProphecyEngine 单例或最小桩皆可注入。预言绝不阻断
   *  动作、绝不改写 PilotResult 既有字段（至多一步 journal 注记）。 */
  prophecy?: ProphecyPort;
  /** W1-3 免看门控本地帧哈希端口（轻量截屏 + dHash，重型感知的廉价替身）：
   *  返回十六进制指纹串；null/抛异常 ⇒ 不可判 ⇒ 门控按「照旧感知」降级收敛。
   *  端口缺席 ⇒ 门控整体降级（与接线前逐字节同路径 —— 生产接线前零行为变化，
   *  接上线即生效，无需改本文件）。 */
  frameHash?: () => Promise<string | null>;
  /** W1-3 免看门控配置：缺省 = 开启但仅「无影响 + 双层 benign」最窄类（外加
   *  benign wait 值守）；{enabled:false} ⇒ 完全关闭（测试总闸）。细则见
   *  PerceptionGateOptions。 */
  perceptionGate?: PerceptionGateOptions;
  /** W3-7（R2 探索前沿策略端口）：恢复态下（所有已知路失败的升级分支）消费
   *  UCB 探索建议 —— 区域未探测不确定度 + 新颖度 + UCB 探索项 − riskGate 代价 −
   *  failureMemory 负先验降权，模态按交替律轮换。缺席或 {enabled:false} ⇒
   *  整段零执行（与接线前逐字节同路径 —— 开关默认 off，现有测试零回归）；
   *  开启条件由集成/内核键控（ExplorationLedger 侧另有 exploration.enabledGate
   *  内核双闸）。账本持久化独立落盘（不碰 checkpoint.ts）。 */
  exploration?: ExplorationPort;
  /** W4-0（B）：活意图漂移端口（W3-5 H2 的环内消费面）：enabled === true 时
   *  driveLoop 环起铸 createSteerSession（绑定当轮 goal + 屏幕指纹源），每步以
   *  stepIndex + 最近校准熵 maybeCheckAndAsk 出题 —— 出题 ⇒ steer-drift 升级提问
   *  （沿认识论闸门 ask_human 的升级拦截风格：被拦动作不入轨迹不执行）。
   *  缺席 / enabled !== true ⇒ 整段零执行（逐字节旧路径 —— 零回归红律）。 */
  steer?: SteerWireOptions;
  /** W4-0（B）：岔路账端口（W3-6 H3 的环内簿记面）：每步决策既定后 record
   *  （rankTopK 与 scoreOptions 同一评分内核）、goal failed/aborted 终局相
   *  generateCard（卡片经 lastBranchCard() 出口供换支重放消费）。纯旁路簿记 ——
   *  PilotResult 既有字段分毫不动；缺席 ⇒ 两段零执行。 */
  branchLedger?: BranchLedgerWirePort;
  /** W5-5（缝2）：岔路账支点锚端口 —— 每步落账时的 checkpoint 步账位置供应面
   *  （journalLength = journal 条数、chainTip = 行动日志链尖；autonomousRun 侧
   *  注入真实 journal 读数，测试用桩）。在场时随 ③¼ 落账铸进 BranchStepRecord
   *  的 anchor（铸卡的锚由此真实可校验 —— applyBranchChoice 的 verifyAnchor 对
   *  journalLength+chainTip 强校验）；缺席 / 故障 / 垃圾返回 ⇒ 锚键缺席
   *  （meta 与 W4-0 接线时逐字节同路 —— 零回归红律）。 */
  branchAnchor?: () => { journalLength: number; chainTip: string } | null;
  /** W5-5（缝3）：steer(k) 换支偏置端口 —— runPilotLoop 从在役 steer 会话取走
   *  的换支重放步进面（W8-B4 破环后为结构端口 PilotSteerBiasStepper —— 真身
   *  由会话铸造侧实现，结构兼容）：在场时 ③¼ 岔路账评分上下文经 withSteerBias
   *  铸入 preferredActionKeys（改选偏置只改选择不改预测），每步决策既定即 step()
   *  扣重放预算（超支 ⇒ null 无偏置原路继续 —— 诚实终止）。缺席 ⇒ 逐字节
   *  旧路径（零回归红律）。 */
  steerBias?: PilotSteerBiasStepper;
  /** 每步入轨迹后的观察者回调（回调自身异常被吞掉，绝不炸环） */
  onStep?: (step: StepRecord) => void;
  /** 注入睡眠（wait 动作沉降用；缺省真睡 setTimeout） */
  sleep?: (ms: number) => Promise<void>;
  /** 注入时钟（缺省 Date.now） */
  now?: () => number;
}

/** 执行器回报的本地别名（避免重复内联结构） */
type ExecResult = Awaited<ReturnType<AutonomyDeps['execute']>>;

/**
 * ΑΩ-R13（W6-1 债拆）：相位族控制流方言 —— 'break' 终局熔断收场 / 'continue'
 * 本步作废推进下一轮 / 'proceed' 相位通过继续推进（无载荷相位的返回值）。
 */
type PhaseSignal = 'break' | 'continue' | 'proceed';

/**
 * ΑΩ-R13（W6-1 债拆）：带载荷相位的结果方言 —— proceed 携带载荷（相位间数据
 * 显式传递，不经闭包暗道），break/continue 同 PhaseSignal。
 */
type PhaseOutcome<T> = { flow: 'proceed'; value: T } | { flow: 'break' } | { flow: 'continue' };

/** 终局相集合 —— goal.evaluate() 落入即熔断循环 */
const TERMINAL_PHASES: ReadonlySet<GoalPhase> = new Set<GoalPhase>([
  'achieved', 'failed', 'aborted', 'blocked',
]);

/** 步数上限末级回退（opts.maxSteps → spec.maxSteps → 此值） */
const DEFAULT_MAX_STEPS = 24;

/** wait 动作默认沉降毫秒（opts.settleMs 可覆盖） */
const DEFAULT_SETTLE_MS = 300;

/**
 * 内置极简宪法（deps.constitution 缺省时的全放行铸造器）：
 * 一律放行、零审批；风险档透传校验 —— 合法值原样盖章，缺席或非法一律按 benign。
 * 闭环不因宪法缺席而卡死，宪法上线之日即无缝接管。
 */
const PERMISSIVE_CONSTITUTION: ConstitutionPort = {
  check(action) {
    const tier = action.riskTier;
    return {
      allowed: true,
      riskTier: tier === 'sensitive' || tier === 'destructive' ? tier : 'benign',
      requiresApproval: false,
      reason: '未注入宪法：内置全放行铸造器（benign 盖章）',
    };
  },
};

/** 异常归因为安全字符串（绝不二次抛出） */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    const text = String(err);
    return text === '' ? '未知异常' : text;
  } catch {
    return '未知异常';
  }
}

/** 宪法判决分层的合法性收口：Stub/垃圾判决给出的非三值一律视为缺席（不盖章） */
function validRiskTier(v: unknown): RiskTier | undefined {
  return v === 'benign' || v === 'sensitive' || v === 'destructive' ? v : undefined;
}

/**
 * 动作自报置信（纪元 Η-1 口径，纯函数）：payload.confidence（有限数，夹 [0,1]）优先，
 * 其次 action.utility（policyEngine ② 级点击动作的 utility 即元素置信 —— 既有约定），
 * 双双缺席/非法 ⇒ 0.5 保守中值（不自夸也不自贬）。
 */
function epistemicConfidenceOf(action: PolicyAction): number {
  const payload =
    action && typeof action.payload === 'object' ? (action.payload as Record<string, unknown>) : null;
  const pc = payload ? payload.confidence : undefined;
  if (typeof pc === 'number' && Number.isFinite(pc)) return Math.min(1, Math.max(0, pc));
  const u = action ? action.utility : undefined;
  if (typeof u === 'number' && Number.isFinite(u)) return Math.min(1, Math.max(0, u));
  return 0.5;
}

/** 错误代价档映射（纪元 Η-1）：destructive/sensitive ⇒ high，其余（含垃圾分层）⇒ low */
function epistemicCostOfError(tier: unknown): 'low' | 'high' {
  return tier === 'destructive' || tier === 'sensitive' ? 'high' : 'low';
}

/** 预算余量百分比轨道（纯函数）：used/total 折剩余百分比；非法轨 ⇒ null（不计入） */
function budgetTrackPct(used: number, total: number): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return 100 * (1 - used / total);
}

// ─── W1-3 免看门控：常量与纯工具（零副作用、零异常） ───

/** 免看门控缺省汉明容差（与 worldSnapshot.snapshotChanged 缺省 3 同律） */
const GATE_DEFAULT_TOLERANCE = 3;
/** wait 值守缺省轮询间隔毫秒 */
const GATE_DEFAULT_POLL_INTERVAL_MS = 250;
/** wait 值守缺省上限毫秒 */
const GATE_DEFAULT_POLL_MAX_MS = 2_000;
/** 连续跳过缺省上限（到顶强制一次完整感知 —— 终局判据 OCR 的有界保鲜） */
const GATE_DEFAULT_MAX_CONSECUTIVE_SKIPS = 1;
/** 值守探测次数硬顶（时钟故障/零间隔配置下的最后防线，值守绝不失控轮询） */
const GATE_WATCH_PROBE_HARD_CAP = 128;
/** 门控跳过时合成快照的降级记号（旧元素/文本非当刻取证，诚实记账） */
const GATE_SNAPSHOT_DEGRADED_MARKER = 'perception-gate-skipped';
/** 门控跳过注入的轻量文本观察（规格原文；走 sceneLabel 通道 —— 该字段无判据匹配消费者，绝不污染 textDigest） */
const GATE_OBSERVATION_TEXT = '免看门控：已执行，屏未变';

// ΑΩ-R13（W6-1 债清偿）：原私有 GATE_NIBBLE_POPCOUNT 表与 gateHexHamming 已迁往
// ../dialects/hashing（hammingDistanceHex —— nibble popcount 查表 + null 不可比
// 语义，逐字节同律），本文件不再持本地副本。

/** W1-3：数值卫兵 —— 非有限数取 fallback，否则夹 [min,max]（门控配置的脏值收敛） */
function gateNumIn(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** W1-3：合法滚动方向集（与 runtime.createExecute 的 scroll 方向白名单同律；方向缺席按 down 仍会滚动） */
const GATE_SCROLL_DIRECTIONS: ReadonlySet<string> = new Set(['up', 'down', 'left', 'right']);

/**
 * W3-7：escalate 动作的理由提取（payload.reason 的防御字符串化；缺席/垃圾 ⇒ '?'）。
 * 消费面是探索账本的恢复态判据（'no-deterministic-action' = 所有已知路失败）。
 */
function extractEscalateReason(action: PolicyAction): string {
  const p =
    action && typeof action.payload === 'object' ? (action.payload as Record<string, unknown>) : null;
  const r = p ? p.reason : undefined;
  return typeof r === 'string' && r !== '' ? r : '?';
}

/**
 * ΝΩ-11（岔路账接候选）：decision.candidates 的防御读取 —— ΝΩ-10 工单在
 * PolicyDecision 上铸 candidates 字段（Top-K 候选），本侧按「字段在场则用、
 * 缺席回 [action]」编码（两工单独立合流，谁先在场谁生效）：合法非空
 * PolicyAction 数组 ⇒ 过滤出 kind 在场的动作原样入账（岔路卡多支候选，
 * 不再退化为单支）；缺席/垃圾/全脏 ⇒ [action]（与旧路径逐字节同律——
 * 零回归红律）。纯函数、绝不抛。
 */
function w4DecisionCandidates(decision: PolicyDecision, action: PolicyAction): PolicyAction[] {
  try {
    const c = (decision && typeof decision === 'object'
      ? (decision as { candidates?: unknown }).candidates
      : undefined);
    if (!Array.isArray(c) || c.length === 0) return [action];
    const valid = c.filter(
      (a): a is PolicyAction =>
        a !== null && typeof a === 'object' &&
        typeof (a as { kind?: unknown }).kind === 'string' && (a as { kind?: unknown }).kind !== '',
    );
    return valid.length > 0 ? valid : [action];
  } catch {
    return [action]; // 防御读取绝不抛（岔路账是旁路簿记）
  }
}

/**
 * W1-3：动作的预期视觉效应三档标注（C1 规格第一项，纯函数、绝不抛）。
 * 从动作种类 × 风险档推导（详见 ExpectedVisualEffect 的 JSDoc）：高风险世界
 * 动作 ⇒ 必变（后果必须目击）；良性有效世界动作 ⇒ 可能变（如 type 后大概率变）；
 * 观察性动作与参数无效不会落地的动作（如无效坐标点击）⇒ 无影响；未知种类 ⇒
 * 必变（保守红律：不确定 ⇒ 必看）。
 */
export function classifyExpectedVisualEffect(action: PolicyAction): ExpectedVisualEffect {
  const a = (action ?? {}) as Partial<PolicyAction>;
  const payload =
    a.payload && typeof a.payload === 'object' ? (a.payload as Record<string, unknown>) : null;
  const center = (a.target as { center?: { x?: unknown; y?: unknown } } | undefined)?.center;
  const hasFiniteCenter =
    center !== null && center !== undefined && typeof center === 'object' &&
    typeof center.x === 'number' && Number.isFinite(center.x) &&
    typeof center.y === 'number' && Number.isFinite(center.y);
  const heavy = a.riskTier === 'sensitive' || a.riskTier === 'destructive';
  switch (a.kind) {
    case 'click':
    case 'drag':
      // 有效落点 ⇒ 世界动作（风险档分档）；无效坐标 ⇒ 执行面不动作 ⇒ 无影响
      return hasFiniteCenter ? (heavy ? 'must-change' : 'may-change') : 'no-impact';
    case 'type': {
      const text = payload ? payload.text : undefined;
      return typeof text === 'string' && text.length > 0
        ? (heavy ? 'must-change' : 'may-change')
        : 'no-impact';
    }
    case 'scroll': {
      // 方向缺席/非字符串 ⇒ runtime 按 down 滚动（仍是世界动作）；字符串非法 ⇒ 不动作
      const dir = payload ? payload.direction : undefined;
      const valid = typeof dir !== 'string' || GATE_SCROLL_DIRECTIONS.has(dir);
      return valid ? (heavy ? 'must-change' : 'may-change') : 'no-impact';
    }
    case 'hotkey': {
      const keys = payload ? payload.keys : undefined;
      const valid =
        Array.isArray(keys) && keys.some(k => typeof k === 'string' && k.trim() !== '');
      return valid ? (heavy ? 'must-change' : 'may-change') : 'no-impact';
    }
    case 'inspect':
    case 'declare':
    case 'ask_vlm':
    case 'recall_skill':
      return 'no-impact'; // 观察性动作：只看不改世界
    case 'wait':
      return 'may-change'; // 等待的语义就是预期变化 —— dHash 值守轮询覆盖（⑥ 不经 execute）
    default:
      return 'must-change'; // escalate / 未知种类：不确定 ⇒ 必看
  }
}

/**
 * W1-3：门控跳过时的轻量合成快照（纯函数、绝不抛）—— 以最近完整感知快照为
 * 底本透传旧账（屏未变 ⇒ 旧元素/文本账仍真），takenAt 刷新为当刻；degraded
 * 诚实追加 'perception-gate-skipped'（本次元素/文本非当刻取证）；轻量文本观察
 * 走 sceneLabel 通道（该字段无判据匹配消费者 —— textDigest 分毫不动，终局判据
 * OCR 红线不破）。
 */
function synthesizeGateSnapshot(
  base: WorldSnapshot,
  takenAt: number,
  observation: string,
): WorldSnapshot {
  const b = (base ?? {}) as Partial<WorldSnapshot>;
  const degraded = Array.isArray(b.degraded) ? [...b.degraded] : [];
  if (!degraded.includes(GATE_SNAPSHOT_DEGRADED_MARKER)) degraded.push(GATE_SNAPSHOT_DEGRADED_MARKER);
  const prevScene = typeof b.sceneLabel === 'string' ? b.sceneLabel : '';
  return {
    takenAt,
    width: typeof b.width === 'number' && Number.isFinite(b.width) ? b.width : 0,
    height: typeof b.height === 'number' && Number.isFinite(b.height) ? b.height : 0,
    dhash: b.dhash ?? null,
    elements: Array.isArray(b.elements) ? b.elements : [],
    textDigest: typeof b.textDigest === 'string' ? b.textDigest : '',
    popups: Array.isArray(b.popups) ? b.popups : [],
    focusedRegion: b.focusedRegion ?? null,
    sceneLabel: prevScene === '' ? observation : `${prevScene}｜${observation}`,
    degraded,
  };
}

/** 感知/判断等前置阶段异常时合成的占位动作（不入世界，仅入轨迹） */
function syntheticDeclareAction(stage: string): PolicyAction {
  return {
    kind: 'declare',
    rationale: `${stage} 阶段异常，收敛为 error 步`,
    expectedEffect: '不改变世界，仅把异常写进轨迹供审计',
    utility: 0,
    riskTier: 'benign',
  };
}

/**
 * 闭环主脉（内部实现；对外入口是 runAutonomousLoop 的防弹壳）。
 *
 * 循环律（与测试逐一对应）：
 *  ⓪ goal.begin() 开环（begin 异常 ⇒ 记 error 步，环照常进入感知）；
 *  ① 步保险丝：steps ≥ (opts.maxSteps ?? spec.maxSteps ?? 24) ⇒ 强制 aborted 收场；
 *  ①′ 环顶终局相位预判：每轮 perceive 前先 evaluate —— 目标机已终局（预置 blocker
 *     ⇒ blocked、判据已全 met ⇒ achieved 等）即熔断收场，零感知零判断零执行
 *     （纪元 Δ 修律：旧律首次相位判定在 execute 之后，blocked-at-begin 仍执行一个
 *     真动作）；
 *  ①″ W1-3 免看门控（C1 Act-Expectation 免看门控）：② 感知前的免看裁决 ——
 *     上步动作属「预期无影响 × 申报 benign × 宪法盖章 benign」最窄类（或 benign
 *     wait 值守）且弹窗活跃标志不在场时，先经注入的本地帧哈希端口比对前后屏
 *     dHash：未变 ⇒ 跳过重型感知（VLM/OCR），以携带轻量文本观察「已执行，屏
 *     未变」的合成快照推进循环；变化超阈值 ⇒ 唤醒完整感知；wait 步由 dHash
 *     循环值守（间隔 × 上限）。安全红线：门控只允许跳过「确认型」感知，五重
 *     与门缺一即照旧感知（详见 ② 处注释）；端口缺席 ⇒ 整体降级（逐字节旧路径）；
 *  ② perceive() 感知 —— 异常 ⇒ 合成 declare 动作记 error 步并推进目标机评估；
 *     感知成功 ⇒ 先结算上一动作的预言（新屏型指纹即 actualType —— D-7 预测编码
 *     回路的 pendingTransition 同律：下一轮到达场景结算上一动作的转移；取不到
 *     真实指纹 ⇒ 引擎内挂起 60s 后诚实作废，绝不伪造 actualType；结算注记回写
 *     预言归属步的 journal —— 纪元 Ε 纯审计旁路，绝不炸环绝不改判据）；
 *  ③ 组装 PolicyContext（history 逐步步累积；budgetRemaining 由 spec 与已耗步/毫秒推算）
 *     → policy.decide —— 异常或缺 action ⇒ error 步收敛；
 *  ③″ W3-7 探索拦截（R2 探索前沿策略）：decide 给出 escalate（所有已知路失败
 *     的恢复分支）且 deps.exploration 端口点亮（enabled === true）时，问一次
 *     探索账本（区域×模态×策略 UCB 择路）—— 有建议 ⇒ 用探索动作替换本步
 *     （照旧走 ③′ 闸门与 ④ 宪法全流程），无建议/常态/故障 ⇒ escalate 原路径
 *     逐字节不变；世界动作落账时经端口 observe 回报探索账（Beta 计数）；端口
 *     缺席 ⇒ 两段零执行（逐字节旧路径 —— 开关默认 off）；
 *  ③′ 认识论闸门（纪元 Η-1，仅 deps.epistemicGate 在场时执行）：adviseAction 四维
 *     裁决（代价档按 riskTier 映射 / 置信取动作自报 / 云脑在否 / 预算余量换算）——
 *     ask_human 且过红律 ⇒ escalated 终局（escalateReason='epistemic-gate'）；abort
 *     且过红律 ⇒ aborted 终局；ask_vlm/proceed（及红律收窄降级者）⇒ 步注记放行；
 *     纪元 Ι：deps.selfModel 给出非 null 建议时置信源换为经验校准置信
 *     （注记/理由带 source:'self-model'），缺席/null ⇒ 自报链逐字节旧路径；
 *  ④ constitution.check(action, { goalText, consecutiveNoEffect, stepsTaken }) ——
 *     allowed=false ⇒ escalated 终局（escalateReason='constitution-veto'，终局相取
 *     goal.evaluate()，summary 写明宪法理由，被否决动作不入轨迹不执行）；
 *     requiresApproval ⇒ escalated 终局（escalateReason='approval-required'）；
 *  ⑤ 动作 kind='escalate' ⇒ 记 no_effect 升级步后 escalated 终局（不执行）；
 *  ⑥ 动作 kind='wait' ⇒ sleep(opts.settleMs ?? 300) 沉降后记 no_effect 步继续（不执行）；
 *  ⑥′ 预言铸造（纪元 Ε，仅 deps.prophecy 在场时执行）：execute 之前按（当前屏型
 *     指纹 × 动作键）铸预言 —— 盲屏（无 dhash）不铸；ΝΩ-11：预期零视觉影响的
 *     动作（W1-3 classifyExpectedVisualEffect 判 no-impact——inspect/declare/
 *     ask_vlm/recall_skill 及参数无效不落地者）不铸（自环转移污染 predict 首名）；
 *     预言归属即将入账的这一步；
 *  ⑦ execute(action) —— 异常或缺 outcome ⇒ error 步收敛；正常则 StepRecord 入轨迹
 *     （effectiveRiskTier = 宪法判决分层盖章，垃圾判决值视为缺席）；
 *  ⑧ criteriaEvidence 逐条 goal.recordCriterion（回填异常吞掉）；
 *  ⑧′ W8-B4 判据证伪面：以最近完整感知的 OCR 语料独立复核**否定判据**（mustNotAppear:/
 *     不得出现： 前缀）—— 命中禁词（精确∪fuzzy）⇒ violated（failed 终局）、语料在场
 *     未命中 ⇒ met、OCR 缺席 ⇒ 零证据（诚实降级，否定判据不自动为真）；
 *  ⑨ goal.tick() → goal.evaluate()：achieved/failed/aborted/blocked 任一终局相即熔断；
 *  ⑩ 每步入轨迹即触发 onStep（回调异常吞掉）。
 * 任何依赖异常都不炸环；所有时间取注入时钟。
 * ΑΩ-R13（W6-1 债清偿）：循环律 ⓪-⑩ 已拆为环前具名相位函数族（fuseGuard /
 * preVerdict / perceptionGate / perceiveAndSettle / steerDriftCheck / policyDecide /
 * explorationIntercept / branchLedgerStep / epistemicGate / constitutionVerdict /
 * escalateAndWait / prophecyMint / executeStep / criteriaRecord /
 * negativeCriteriaReview / finalEvaluation），while 循环只剩相位编排；闭包状态
 * 保留在 driveLoop 内，相位间数据经参数/载荷显式传递 —— 纯结构重构，行为逐字节不变。
 */
async function driveLoop(
  deps: AutonomyDeps,
  opts?: { maxSteps?: number; settleMs?: number },
): Promise<PilotResult> {
  const now = deps.now ?? ((): number => Date.now());
  const sleep = deps.sleep ?? (async (ms: number): Promise<void> => {
    await new Promise<void>(resolve => { setTimeout(resolve, ms); });
  });
  const constitution: ConstitutionPort = deps.constitution ?? PERMISSIVE_CONSTITUTION;
  const startAt = now();

  const trajectory: StepRecord[] = [];
  const criteriaStatus = new Map<number, 'met' | 'violated'>();
  let stepsTaken = 0;

  // 目标规格防御式读取：读不到按空目标继续（空判据 ⇒ 目标机永不因判据终局，靠保险丝收）
  let spec: GoalSpec = { goal: '', successCriteria: [] };
  try { spec = deps.goal.spec; } catch { /* 防御：spec 读取失败绝不炸环 */ }
  const criteriaTotal = Array.isArray(spec.successCriteria) ? spec.successCriteria.length : 0;
  // W8-B4（判据证伪面）：判据对（原文 + 原始下标锚定 —— 非法条目剔除但不下标平移，
  // 与 execute 侧判据对铸造同律）。⑧′ 独立评估的物料；空判据账 ⇒ ⑧′ 整段零执行。
  const w8CriteriaPairs = buildCriteriaPairs(spec.successCriteria);
  // maxSteps 同律防御（与 goalState 构造器「非法 ⇒ 降级 24」一致）：stub 依赖给出
  // NaN/0/非数会把 stepCap 变 NaN（保险丝永不熔断 ⇒ 挂死）或 0（秒中止）
  const specMaxSteps = typeof spec.maxSteps === 'number' && Number.isFinite(spec.maxSteps) && spec.maxSteps >= 1
    ? spec.maxSteps
    : undefined;
  const stepCap = opts?.maxSteps ?? specMaxSteps ?? DEFAULT_MAX_STEPS;
  const timeBudgetMs = typeof spec.timeBudgetSec === 'number' ? spec.timeBudgetSec * 1000 : null;

  // 纪元 Η（Η-1）认识论闸门解析：deps.epistemicGate 缺席 ⇒ gate === undefined，
  // 主循环内闸门段整体零执行（与纪元 Η 接线前逐字节同路径）
  const gate: EpistemicGateOptions | undefined =
    deps.epistemicGate && typeof deps.epistemicGate === 'object' ? deps.epistemicGate : undefined;
  // 纪元 Ε（预言引擎）解析：deps.prophecy 缺席或双面（mint/settle）不齐 ⇒
  // prophecy === undefined，主循环内铸造/结算两段整体零执行（逐字节旧路径）
  const prophecyRaw = deps.prophecy;
  const prophecy: ProphecyPort | undefined =
    prophecyRaw && typeof prophecyRaw === 'object' &&
    typeof prophecyRaw.mint === 'function' && typeof prophecyRaw.settle === 'function'
      ? prophecyRaw
      : undefined;
  const gateVlmAvailable = (): boolean => {
    if (!gate) return false;
    const v = gate.vlmAvailable;
    if (typeof v === 'function') {
      try { return v() === true; } catch { return false; }
    }
    return v === true;
  };
  /** 红律白名单：blockOnlyTiers 合法三值集合；缺席/空 ⇒ null（全部分层可熔断） */
  const gateBlockTiers: ReadonlySet<RiskTier> | null =
    gate && Array.isArray(gate.blockOnlyTiers) && gate.blockOnlyTiers.length > 0
      ? new Set(gate.blockOnlyTiers.filter(t => t === 'benign' || t === 'sensitive' || t === 'destructive'))
      : null;
  /** 红律置信上限：自报置信仅严格小于此值才可熔断；缺省 +∞（不设限） */
  const gateBlockBelow =
    gate && typeof gate.blockOnlyBelowConfidence === 'number' && Number.isFinite(gate.blockOnlyBelowConfidence)
      ? gate.blockOnlyBelowConfidence
      : Number.POSITIVE_INFINITY;
  /** 闸门预算换算：步数/时间双轨各折剩余百分比取紧者（无轨 ⇒ 100，夹 [0,100]） */
  const gateBudgetPct = (): number => {
    const stepPct = budgetTrackPct(stepsTaken, stepCap);
    const timePct = timeBudgetMs === null ? null : budgetTrackPct(now() - startAt, timeBudgetMs);
    let pct = 100;
    if (stepPct !== null && stepPct < pct) pct = stepPct;
    if (timePct !== null && timePct < pct) pct = timePct;
    return Math.min(100, Math.max(0, pct));
  };

  // W1-3（C1 免看门控）解析：deps.perceptionGate 缺席 ⇒ 全缺省（门控开、仅最窄
  // 类）；{enabled:false} ⇒ 完全关闭（测试总闸）。哈希端口 deps.frameHash 缺席或
  // 非函数 ⇒ frameHashFn === null，② 处门控整体降级为照旧感知（与接线前逐字节
  // 同路径 —— 生产接线前零行为变化，接上线即生效）。全部配置脏值就地收敛。
  const w1GateConfRaw = deps.perceptionGate;
  const w1GateConf =
    w1GateConfRaw && typeof w1GateConfRaw === 'object' ? w1GateConfRaw : null;
  const w1GateEnabled = w1GateConf === null ? true : w1GateConf.enabled !== false;
  const w1GateFrameHash = typeof deps.frameHash === 'function' ? deps.frameHash : null;
  const w1GateTolerance = gateNumIn(
    w1GateConf?.hammingTolerance, 0, 64, GATE_DEFAULT_TOLERANCE);
  const w1GatePollIntervalMs = gateNumIn(
    w1GateConf?.pollIntervalMs, 0, 60_000, GATE_DEFAULT_POLL_INTERVAL_MS);
  const w1GatePollMaxMs = gateNumIn(
    w1GateConf?.pollMaxMs, 0, 600_000, GATE_DEFAULT_POLL_MAX_MS);
  const w1GateMaxConsecutiveSkips = Math.round(gateNumIn(
    w1GateConf?.maxConsecutiveSkips, 0, 1_000, GATE_DEFAULT_MAX_CONSECUTIVE_SKIPS));
  // 值守探测次数上限：上限毫秒 ÷ 间隔 + 1，再夹硬顶 —— 时钟故障/零间隔配置下
  // 值守也绝不失控轮询（有界性不依赖注入时钟的善意）
  const w1GateWatchMaxProbes = Math.min(
    GATE_WATCH_PROBE_HARD_CAP,
    Math.max(1, Math.floor(w1GatePollMaxMs / Math.max(1, w1GatePollIntervalMs)) + 1),
  );

  // W3-7（R2 探索前沿策略）解析：deps.exploration 缺席 / enabled !== true ⇒
  // 端口未点亮（exploration === undefined），③″ 拦截段与观察回报段整体零执行
  //（与接线前逐字节同路径 —— 开关默认 off）。advise/observe 面的运行时防御：
  // 非函数 ⇒ 对应面禁用（结构端口契约的兜底，绝不因桩残缺而炸环）。
  const w3ExploreRaw = deps.exploration;
  const w3Explore =
    w3ExploreRaw && typeof w3ExploreRaw === 'object' && w3ExploreRaw.enabled === true
      ? w3ExploreRaw
      : undefined;
  const w3ExploreAdvise =
    w3Explore !== undefined && typeof w3Explore.advise === 'function' ? w3Explore.advise.bind(w3Explore) : null;
  const w3ExploreObserve =
    w3Explore !== undefined && typeof w3Explore.observe === 'function' ? w3Explore.observe.bind(w3Explore) : null;

  // W4-0（B 接线）解析：steer 端口缺席 / enabled !== true ⇒ w4Steer === null
  //（环内漂移检查整段零执行 —— 逐字节旧路径，零回归红律）；branchLedger 端口
  // 只认结构合法的 record 面（桩残缺 ⇒ 簿记面禁用，绝不炸环）。
  const w4SteerRaw = deps.steer;
  const w4Steer =
    w4SteerRaw && typeof w4SteerRaw === 'object' && w4SteerRaw.enabled === true ? w4SteerRaw : null;
  const w4BranchRaw = deps.branchLedger;
  const w4Branch =
    w4BranchRaw && typeof w4BranchRaw === 'object' && typeof w4BranchRaw.record === 'function'
      ? w4BranchRaw
      : null;
  // W4-0（B）：最近一次认识论闸门的校准熵（steer 会话的即时检查通道 —— 熵超阈
  // 可插队出题；闸门缺席 ⇒ null 只走周期通道）
  let w4LastEntropy: number | null = null;

  // W5-5（缝2/缝3）解析：岔路账支点锚端口与换支偏置端口 —— 结构不合法 ⇒
  // null（对应段零执行，逐字节旧路径）；一切脏值/故障在消费点防御收敛。
  const w5AnchorRaw = deps.branchAnchor;
  const w5AnchorFn = typeof w5AnchorRaw === 'function' ? w5AnchorRaw : null;
  const w5BiasRaw = deps.steerBias;
  const w5Bias =
    w5BiasRaw !== null && typeof w5BiasRaw === 'object' && typeof w5BiasRaw.step === 'function'
      ? w5BiasRaw
      : null;
  /** W5-5（缝2）：支点锚的防御读取（端口缺席/故障/垃圾 ⇒ 空对象 = 锚键缺席） */
  const w5AnchorMeta = (): { journalLength?: number; chainTip?: string } => {
    if (w5AnchorFn === null) return {};
    try {
      const a = w5AnchorFn();
      if (a === null || a === undefined || typeof a !== 'object') return {};
      const r = a as { journalLength?: unknown; chainTip?: unknown };
      const out: { journalLength?: number; chainTip?: string } = {};
      if (typeof r.journalLength === 'number' && Number.isFinite(r.journalLength)) {
        out.journalLength = Math.max(0, Math.floor(r.journalLength));
      }
      if (typeof r.chainTip === 'string' && r.chainTip !== '') out.chainTip = r.chainTip;
      return out;
    } catch {
      return {}; // 端口故障 ⇒ 锚缺席（诚实降级，绝不炸环）
    }
  };

  let lastPhase: GoalPhase = 'planning';
  let lastReason = '';
  let escalated = false;
  let escalateReason: string | undefined;
  let summaryCore = '';
  let lastDhash: string | null = null;
  // 纪元 Ε（预言）状态：armed = 已铸预言待归属（recordStep 落账时捕获）；
  // stepIndex = 预言归属步（结算注记的回写锚点）；success = 归属步执行结局
  // （'progress' ⇒ true —— settle 回灌 observe 的成败口径）。
  let prophecyArmed = false;
  let prophecyStepIndex: number | null = null;
  let prophecyStepSuccess = false;
  // W1-3（C1 免看门控）状态：基线快照（最近一次完整感知 —— 弹窗标志与旧元素/
  // 文本的出处）、上步门控语境（null = 世界状态未知或非最窄类 ⇒ 必看）、四本
  // 记账（触发/跳过/唤醒/连续跳过）与待搭车的步注记。
  let lastFullSnapshot: WorldSnapshot | null = null;
  let lastGateEligibility: 'no-impact' | 'wait' | null = null;
  let gateProbes = 0;
  let gateSkips = 0;
  let gateWakes = 0;
  let gateConsecutiveSkips = 0;
  let pendingGateNote: string | null = null;
  // W3-7（R2 探索前沿策略）记账：本 run 探索建议替代升级步的次数（>0 才追加
  // 总汇报 —— 未触发 ⇒ summary 逐字节不变，零回归红律）
  let w3ExploreSubs = 0;

  /**
   * W1-3：单次哈希探测（三态）：true = 屏未变（距离 ≤ 容差）、false = 屏已变、
   * null = 不可判（端口缺席/抛异常/垃圾返回/指纹不可比）—— null 一律按「照旧
   * 感知」保守收敛，绝不炸环。
   */
  const gateProbeHash = async (): Promise<boolean | null> => {
    if (w1GateFrameHash === null) return null;
    try {
      const fresh = await w1GateFrameHash();
      if (typeof fresh !== 'string' || fresh === '') return null;
      const baseline = lastDhash;
      if (typeof baseline !== 'string' || baseline === '') return null;
      const distance = hammingDistanceHex(baseline, fresh); // ΑΩ-R13：方言迁移（原 gateHexHamming）
      if (distance === null) return null;
      return distance <= w1GateTolerance;
    } catch {
      return null; // 端口故障吞掉 —— 门控降级，绝不炸环
    }
  };

  /** 步落账：入轨迹 + 计步 + 通知观察者（观察者异常吞掉）；宪法判决分层可选盖章 */
  const recordStep = (
    action: PolicyAction,
    outcome: StepOutcome,
    snapshotDhash: string | null,
    note?: string,
    effectiveRiskTier?: RiskTier,
  ): void => {
    // W1-3：免看门控注记搭车 —— 门控裁决发生的那一轮，其首个落账步 journal 留痕
    //（跳过/唤醒都记；无裁决 ⇒ 既有 note 逐字节不变 —— 零回归红律）
    let effNote = note;
    if (pendingGateNote !== null) {
      effNote = effNote !== undefined ? `${effNote}；${pendingGateNote}` : pendingGateNote;
      pendingGateNote = null;
    }
    const rec: StepRecord = { stepIndex: stepsTaken, action, outcome, snapshotDhash, at: now() };
    if (effNote !== undefined) rec.note = effNote;
    if (effectiveRiskTier !== undefined) rec.effectiveRiskTier = effectiveRiskTier;
    trajectory.push(rec);
    // W1-3 免看门控语境记账（单点挂载 —— 一切落账路径共用，纯推导零副作用）：
    // error 步 ⇒ 世界状态未知 ⇒ 下轮必看；wait 步 ⇒ 值守模式（等待的语义就是
    // 预期变化，仅 benign 可入 —— 敏感等待照旧感知）；其余已执行步 ⇒ 唯
    // 「分类无影响 × 申报 benign × 宪法盖章 benign（缺席章按申报）」三元与才入
    // 最窄门控类（may/must-change、sensitive/destructive、被盖章升级者一律必看）。
    lastGateEligibility =
      outcome === 'error'
        ? null
        : action && action.kind === 'wait'
          ? (action.riskTier === 'benign' ? 'wait' : null)
          : action &&
              classifyExpectedVisualEffect(action) === 'no-impact' &&
              action.riskTier === 'benign' &&
              (effectiveRiskTier === undefined || effectiveRiskTier === 'benign')
            ? 'no-impact'
            : null;
    // 纪元 Ε：armed 的预言归属本步（mint 在 execute 前、recordStep 在 execute 后 ——
    // 之间的 recordStep 只会是本动作的结局步，捕获即对号）
    if (prophecyArmed) {
      prophecyArmed = false;
      prophecyStepIndex = rec.stepIndex;
      prophecyStepSuccess = outcome === 'progress';
    }
    // W3-7 探索账回报：世界动作步入账即回报探索账本（每格尝试与成败的 Beta
    // 计数；账本对全动作流记账 —— 策略自选动作同样计入已探索集，不只记探索
    // 建议自己）。视口取最近完整感知快照（量化网格的消费面）。账本故障吞掉
    // —— 绝不炸环。
    if (w3ExploreObserve !== null) {
      try {
        w3ExploreObserve(
          rec.action,
          rec.outcome,
          lastFullSnapshot !== null && typeof lastFullSnapshot.width === 'number'
            ? { width: lastFullSnapshot.width, height: lastFullSnapshot.height }
            : undefined,
        );
      } catch { /* 账本故障吞掉 —— 探索是恢复增益不是依赖 */ }
    }
    stepsTaken++;
    if (deps.onStep) {
      try { deps.onStep(rec); } catch { /* 观察者异常吞掉 —— 闭环不为旁路观察者停摆 */ }
    }
  };

  /** 相位刷新：返回是否落入终局相（evaluate 异常 ⇒ 按非终局继续，靠保险丝兜底） */
  const evaluateGoal = (): boolean => {
    try {
      const ev = deps.goal.evaluate();
      lastPhase = ev.phase;
      lastReason = ev.reason;
      return TERMINAL_PHASES.has(ev.phase);
    } catch {
      return false;
    }
  };

  /** 推进目标机（tick 异常吞掉）并刷新相位 */
  const advanceGoal = (): boolean => {
    try { deps.goal.tick(); } catch { /* tick 异常吞掉 */ }
    return evaluateGoal();
  };

  // ⓪ 开环：目标机就位（异常 ⇒ error 步入账，环照常进入感知）
  try { deps.goal.begin(); } catch (err) {
    recordStep(syntheticDeclareAction('begin'), 'error', null, `begin: ${errText(err)}`);
  }

  // W4-0（B 接线）：活意图漂移会话铸造 —— 仅 steer 端口点亮时（goal 在环内才出生，
  // 铸造点只能在 driveLoop）。指纹源 = 最近完整感知快照的 textDigest + sceneLabel
  // 拼接（会话实现侧的既定方言）；会话铸造防御式（goal 垃圾 ⇒ 永不出题的空转
  // 会话）。会话登记进模块持有者（跨环存续到下一环替换 —— 出题升级后用户的
  // 单字符应答经 steer_answer 对同一会话结算，环终清账会把升级提问变成死信）。
  // W8-B4（破环）：会话工厂经晚绑定注册器喂入（tools 侧装配时注册）；未注册 ⇒
  // 会话缺席（漂移检查整段零执行 —— 与端口缺席同降级，绝不炸环绝不伪造会话）。
  let w4SteerSession: PilotSteerSession | null = null;
  if (w4Steer !== null && w8SteerFactory.factory !== null) {
    try {
      const conf = w4Steer;
      w4SteerSession = w8SteerFactory.factory({
        goal: deps.goal,
        screenText: (): string | null => {
          const s = lastFullSnapshot;
          if (s === null || typeof s !== 'object') return null;
          const t = typeof s.textDigest === 'string' ? s.textDigest : '';
          const l = typeof s.sceneLabel === 'string' ? s.sceneLabel : '';
          const joined = `${t} ${l}`.trim();
          return joined !== '' ? joined : null;
        },
        ...(typeof conf.diagnosisNote === 'function' ? { diagnosisNote: conf.diagnosisNote } : {}),
        ...(typeof conf.driftThreshold === 'number' && Number.isFinite(conf.driftThreshold)
          ? { driftThreshold: conf.driftThreshold }
          : {}),
        ...(typeof conf.throttleSteps === 'number' && Number.isFinite(conf.throttleSteps)
          ? { throttleSteps: conf.throttleSteps }
          : {}),
      });
    } catch {
      w4SteerSession = null; // 铸造故障吞掉 —— 漂移检查是旁路，绝不炸环
    }
    if (w4SteerSession !== null) w4ActiveSteer.session = w4SteerSession;
  }

  // ─── ΑΩ-R13（W6-1 债清偿）：环体相位函数族 —— 循环律 ⓪-⑩ 各段拆出的具名局部
  // 函数（定义序即执行序）；闭包状态保留在 driveLoop 内就地读写，相位间数据经
  // 参数与 PhaseOutcome 载荷显式传递，返回值只表控制流（true/'break' ⇒ 终局熔断、
  // 'continue' ⇒ 本步作废推进下一轮）。行为与拆解前逐字节一致。 ───

  /**
   * ΑΩ-R13 相位 ①：步数保险丝 —— stepsTaken 到顶即强制 aborted 收场（优先于
   * 一切依赖调用，防依赖失控拖死环）。true ⇒ 熔断收场。
   */
  const fuseGuard = (): boolean => {
    if (stepsTaken >= stepCap) {
      lastPhase = 'aborted';
      summaryCore = `步数保险丝熔断（上限 ${stepCap} 步）`;
      return true;
    }
    return false;
  };

  /**
   * ΑΩ-R13 相位 ①′：环顶终局相位预判（纪元 Δ 修律）—— 每轮 perceive 前先问
   * 目标机，已终局（预置 blocker ⇒ blocked、判据已全 met ⇒ achieved 等）即熔断
   * 收场，零感知零判断零执行。true ⇒ 熔断收场。
   */
  const preVerdict = (): boolean => evaluateGoal();

  /**
   * ΑΩ-R13 相位 ①″：W1-3（C1 Act-Expectation 免看门控）—— ② 感知步之前的免看
   * 裁决：最窄类（无影响 + 双层 benign / benign wait 值守）屏未变 ⇒ 返回合成轻量
   * 快照跳过重型感知；null ⇒ 照旧感知。
   */
  const perceptionGate = async (): Promise<WorldSnapshot | null> => {
    // 门控安全红线（五重与门，缺一即照旧感知 —— 门控决策必须保守，不确定时一律照旧感知）：
    // ① 总闸：perceptionGate.enabled === false ⇒ 完全关闭（测试用）；
    // ② 端口：deps.frameHash 缺席/非函数 ⇒ 门控整体降级（与接线前逐字节同路径）；
    // ③ 基线：首轮完整感知未发生或基线无 dhash 指纹 ⇒ 无可比对 ⇒ 照旧感知；
    // ④ 弹窗：最近完整感知快照 popups 非空（弹窗活跃标志在场）⇒ 禁止门控
    //    —— 弹窗检测输入绝不可跳（宪法的危险词扫描、策略①级弹窗优先都以
    //    完整感知为输入，跳过即致盲）；
    // ⑤ 语境：上步非「无影响 + 双层 benign」最窄类亦非 benign wait（error 步
    //    世界状态未知 ⇒ null），或连续跳过已达上限（终局判据 OCR 的有界保鲜
    //    —— 旧屏账不可无限透支）⇒ 照旧感知。
    // 通过 ⇒ 「无影响」类单探比对、「wait」类循环值守（间隔 × 上限，探测次数
    // 双重有界）比对 dHash 汉明距离；未变 ⇒ 合成轻量快照推进循环 —— 透传旧
    // 元素/文本（屏未变 ⇒ 账仍真）、degraded 诚实记 'perception-gate-skipped'、
    // sceneLabel 注入轻量文本观察「已执行，屏未变」（该字段无判据匹配消费者，
    // 绝不污染 textDigest —— 终局判据 OCR 红线）；变化 ⇒ 唤醒完整感知；任何
    // 端口故障（抛异常/垃圾返回/指纹不可比）一律按「不可判 ⇒ 照旧感知」收敛。
    // 预言结算只发生在真实感知路径（跳过 = 无新屏型证据，预言挂起等下一帧
    // —— 纯旁路语义不变）。
    let snapshot: WorldSnapshot | null = null;
    if (
      w1GateEnabled &&
      w1GateFrameHash !== null &&
      lastFullSnapshot !== null &&
      typeof lastDhash === 'string' && lastDhash !== '' &&
      Array.isArray(lastFullSnapshot.popups) && lastFullSnapshot.popups.length === 0 &&
      lastGateEligibility !== null &&
      gateConsecutiveSkips < w1GateMaxConsecutiveSkips
    ) {
      gateProbes++; // 触发记账：门控裁决程序每运行一次记一笔
      if (lastGateEligibility === 'wait') {
        // 等待/轮询值守（C1 规格第四项）：本地 dHash 循环值守，带间隔与上限 ——
        // 变化超阈值才唤醒完整感知；到顶仍未变 ⇒ 轻量观察推进循环。
        const watchStart = now();
        let woke = false;
        let indecisive = false;
        let probes = 0;
        while (probes < w1GateWatchMaxProbes) {
          const unchanged = await gateProbeHash();
          probes++;
          if (unchanged === null) { indecisive = true; break; }
          if (unchanged === false) { woke = true; break; }
          if (probes >= w1GateWatchMaxProbes) break;
          if (now() - watchStart >= w1GatePollMaxMs) break;
          try { await sleep(w1GatePollIntervalMs); } catch { break; /* 睡眠异常 ⇒ 提前收哨 */ }
        }
        const waitedMs = Math.max(0, now() - watchStart);
        if (woke) {
          gateWakes++;
          pendingGateNote = `免看门控：值守 ${waitedMs}ms 发现屏幕变化，唤醒完整感知（唤醒 ${gateWakes}）`;
        } else if (!indecisive) {
          snapshot = synthesizeGateSnapshot(lastFullSnapshot, now(), `免看门控：已等待 ${waitedMs}ms 屏未变`);
          gateSkips++;
          gateConsecutiveSkips++;
          pendingGateNote =
            `免看门控：已等待 ${waitedMs}ms 屏未变，跳过重型感知（门控跳过 ${gateSkips}/${gateProbes}）`;
        }
      } else {
        // 「无影响 + 低风险」最窄类：单探比对 —— 屏未变才跳，其余一律照旧感知
        const unchanged = await gateProbeHash();
        if (unchanged === true) {
          snapshot = synthesizeGateSnapshot(lastFullSnapshot, now(), GATE_OBSERVATION_TEXT);
          gateSkips++;
          gateConsecutiveSkips++;
          pendingGateNote =
            `免看门控：已执行，屏未变，跳过重型感知（门控跳过 ${gateSkips}/${gateProbes}）`;
        }
      }
    }
    return snapshot;
  };

  /**
   * ΑΩ-R13 相位 ②：重型感知 + 纪元 Ε 预言结算 —— deps.perceive 感知世界（异常 ⇒
   * error 步收敛不炸环）；感知到达即结算上一动作的预言并刷新门控基线快照。
   * 成功 ⇒ proceed（快照经载荷带出）；失败 ⇒ advanceGoal 定 break/continue。
   */
  const perceiveAndSettle = async (): Promise<PhaseOutcome<WorldSnapshot>> => {
    try {
      const snapshot = await deps.perceive();
      // 纪元 Ε（预言结算）：动作后的第一次感知即「对账时刻」—— 新屏型指纹就是
      // actualType（D-7 pendingTransition 同律）。取不到真实指纹 ⇒ 引擎内挂起
      // （60s 后诚实作废，绝不伪造 actualType）；结算注记回写预言归属步的
      // journal（一行，不扩字段结构）。旁路任何故障吞掉 —— 绝不炸环。
      if (prophecy !== undefined) {
        try {
          const nextType =
            snapshot && typeof snapshot.dhash === 'string' && snapshot.dhash !== ''
              ? snapshot.dhash
              : null;
          const settled = prophecy.settle(
            nextType,
            prophecyStepIndex === null ? undefined : prophecyStepSuccess,
          );
          if (settled !== null) {
            const rec = trajectory.length > 0 ? trajectory[trajectory.length - 1] : null;
            if (rec !== null && rec.stepIndex === prophecyStepIndex) {
              const tag = prophecyJournalTag(settled);
              rec.note = rec.note !== undefined ? `${rec.note}；${tag}` : tag;
            }
            prophecyStepIndex = null; // 结算即清（一次性 —— 错号注记只丢不补）
          }
        } catch { /* 预言结算故障吞掉 —— 旁路绝不炸环 */ }
      }
      lastDhash = snapshot && typeof snapshot.dhash === 'string' ? snapshot.dhash : null;
      lastFullSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : null;
      gateConsecutiveSkips = 0; // 完整感知发生 ⇒ 连续跳过保鲜账清零
      return { flow: 'proceed', value: snapshot };
    } catch (err) {
      recordStep(syntheticDeclareAction('perceive'), 'error', null, `perceive: ${errText(err)}`);
      return advanceGoal() ? { flow: 'break' } : { flow: 'continue' };
    }
  };

  /**
   * ΑΩ-R13 相位 ③-pre：W4-0（B 接线）活意图漂移检查 —— 每步（stepIndex 周期
   * 通道 + 最近校准熵即时通道）经 steer 会话 maybeCheckAndAsk：出题 ⇒ steer-drift
   * 升级提问终局（沿 ask_human 拦截风格，被拦动作不入轨迹不执行不 tick）；
   * 未超阈/节流中/会话故障 ⇒ false 原路径继续。
   */
  const steerDriftCheck = (): boolean => {
    if (w4SteerSession === null) return false;
    let w4Question: PilotSteerChoice | null = null;
    try {
      w4Question = w4SteerSession.maybeCheckAndAsk(stepsTaken, w4LastEntropy);
    } catch {
      w4Question = null; // 会话故障吞掉 —— 漂移检查是旁路，绝不炸环
    }
    if (w4Question === null) return false;
    escalated = true;
    escalateReason = 'steer-drift';
    evaluateGoal();
    summaryCore =
      `活意图漂移出题（drift ${w4Question.drift.score}，趋势 ${w4Question.drift.trend}）：` +
      `${w4Question.reason}。请向用户转述三选一（A 继续 / B 改判据：${w4Question.amendment.to} / ` +
      `C 终止）并等待单字符应答，经 steer_answer 结算`;
    return true;
  };

  /**
   * ΑΩ-R13 相位 ③：策略决策 —— 组装 PolicyContext（history 逐步累积、预算由
   * spec 与已耗步/毫秒推算）→ policy.decide；异常或缺 action ⇒ error 步收敛。
   */
  const policyDecide = async (
    snapshot: WorldSnapshot,
  ): Promise<PhaseOutcome<{ decision: PolicyDecision; action: PolicyAction }>> => {
    let decision: PolicyDecision;
    try {
      const history = trajectory.map(rec => ({ action: rec.action, outcome: rec.outcome }));
      const ctx: PolicyContext = {
        snapshot,
        spec,
        goal: deps.goal.progress,
        history,
        budgetRemaining: {
          steps: Math.max(0, stepCap - stepsTaken),
          ms: timeBudgetMs === null ? Number.POSITIVE_INFINITY : timeBudgetMs - (now() - startAt),
        },
      };
      decision = await deps.policy.decide(ctx);
    } catch (err) {
      recordStep(syntheticDeclareAction('policy'), 'error', lastDhash, `policy: ${errText(err)}`);
      return advanceGoal() ? { flow: 'break' } : { flow: 'continue' };
    }
    const action: PolicyAction | null = decision && decision.action ? decision.action : null;
    if (!action) {
      recordStep(syntheticDeclareAction('policy'), 'error', lastDhash, 'policy: decide 返回缺少 action 的决定');
      return advanceGoal() ? { flow: 'break' } : { flow: 'continue' };
    }
    return { flow: 'proceed', value: { decision, action } };
  };

  /**
   * ΑΩ-R13 相位 ③″：W3-7（R2 探索前沿策略）探索拦截 —— decide 给出 escalate
   * （所有已知路失败的恢复分支）且端口点亮时，问一次探索账本：有建议 ⇒ 用探索
   * 动作替换本步（照旧走 ③′ 闸门与 ④ 宪法全流程，不越权）；无建议/常态/端口
   * 故障 ⇒ escalate 原路径逐字节不变（建议注记随 decision.note 入本步 journal）。
   */
  const explorationIntercept = (
    decision: PolicyDecision,
    action: PolicyAction,
    snapshot: WorldSnapshot | null,
  ): { decision: PolicyDecision; action: PolicyAction } => {
    if (action.kind === 'escalate' && w3ExploreAdvise !== null) {
      let advice: ExplorationAdvice | null = null;
      try {
        advice = w3ExploreAdvise({
          goal: spec.goal,
          snapshot,
          history: trajectory.map(r => ({ action: r.action, outcome: r.outcome })),
          escalateReason: extractEscalateReason(action),
        });
      } catch {
        advice = null; // 端口故障吞掉 —— 绝不炸环
      }
      if (advice !== null && advice.action && typeof advice.action.kind === 'string') {
        const tag = typeof advice.note === 'string' && advice.note !== '' ? advice.note : 'W3-7 探索建议';
        decision = {
          ...decision,
          action: advice.action,
          note: decision.note !== undefined ? `${decision.note}；${tag}` : tag,
        };
        action = advice.action;
        w3ExploreSubs++;
      }
    }
    return { decision, action };
  };

  /**
   * ΑΩ-R13 相位 ③¼：W4-0（B 接线）岔路账落账（W5-5 缝2/缝3）—— 决策既定
   * （探索替换后、闸门/宪法裁决前）即按 W3-6 评分内核记 Top-K 候选账：支点锚
   * （journalLength + chainTip）随账落锚、换支偏置经 withSteerBias 铸入评分
   * 上下文（改选偏置只改选择不改预测）。ΝΩ-11：落账候选改取
   * decision.candidates（ΝΩ-10 在场则多支入账，岔路卡不再退化为单支；缺席 ⇒
   * [action] 旧路径）。纯旁路簿记，故障吞掉绝不炸环。
   */
  const branchLedgerStep = (
    decision: PolicyDecision,
    action: PolicyAction,
    snapshot: WorldSnapshot | null,
  ): void => {
    if (w4Branch === null) return;
    try {
      let w5RecordCtx: ScoringContext = {
        goalKeywords: extractGoalKeywords(spec),
        snapshot: (snapshot ?? { takenAt: 0, width: 0, height: 0, dhash: null, elements: [], textDigest: '', popups: [], focusedRegion: null, sceneLabel: '', degraded: [] }) as WorldSnapshot,
        triedActionKeys: trajectory.map(r => actionSignature(r.action)),
      };
      if (w5Bias !== null) {
        try {
          const b = w5Bias.step();
          if (b !== null && typeof b === 'object' && Array.isArray(b.preferredActionKeys)) {
            const keys = b.preferredActionKeys.filter(
              (k): k is string => typeof k === 'string' && k !== '',
            );
            if (keys.length > 0) w5RecordCtx = withSteerBias(w5RecordCtx, keys);
          }
        } catch {
          /* 偏置步进故障吞掉 —— 原路无偏置（绝不炸环） */
        }
      }
      // ΝΩ-11：候选面 = decision.candidates ?? [action]（防御读取 —— 字段在场
      // 则用、缺席回单支旧路径；探索替换不改候选账——账记的是决策时的备选面）
      w4Branch.record(w4DecisionCandidates(decision, action), w5RecordCtx, { stepIndex: stepsTaken, ...w5AnchorMeta() });
    } catch { /* 岔路账是旁路簿记 —— 故障绝不炸环 */ }
  };

  /**
   * ΑΩ-R13 相位 ③′：纪元 Η-1 认识论闸门（纪元 Ι 经验置信换源）—— Φ-7
   * adviseAction 四维裁决（错误代价 × 校准置信 × 云脑在否 × 预算余量）：ask_human
   * 且过红律 ⇒ epistemic-gate 升级终局；abort 且过红律 ⇒ aborted 收手终局；
   * ask_vlm/proceed（及红律收窄降级者）⇒ 步注记放行；gate 缺席 ⇒ 原决策透传
   * （整段零执行）。本相位永不 continue。
   */
  const epistemicGate = (
    decision: PolicyDecision,
    action: PolicyAction,
  ): { flow: 'proceed'; value: PolicyDecision } | { flow: 'break' } => {
    if (gate === undefined) return { flow: 'proceed', value: decision };
    let report: UncertaintyReport | null = null;
    let rawConfidence = 0.5;
    /** 纪元 Ι：经验置信的支撑证据量（null = 本步走自报链，注记零变化） */
    let selfModelN: number | null = null;
    try {
      rawConfidence = epistemicConfidenceOf(action);
      if (deps.selfModel && typeof deps.selfModel.adviseConfidence === 'function') {
        let advice: SelfModelAdvice | null = null;
        try {
          advice = deps.selfModel.adviseConfidence(action, lastDhash === null ? undefined : lastDhash);
        } catch {
          advice = null; // 模型故障吞掉 —— 绝不炸环，回落纪元 Η 自报链
        }
        if (
          advice !== null && advice !== undefined &&
          typeof advice.confidence === 'number' && Number.isFinite(advice.confidence)
        ) {
          rawConfidence = Math.min(1, Math.max(0, advice.confidence));
          selfModelN =
            typeof advice.n === 'number' && Number.isFinite(advice.n) ? advice.n : null;
        }
      }
      report = adviseAction({
        confidence: rawConfidence,
        costOfError: epistemicCostOfError(action.riskTier),
        vlmAvailable: gateVlmAvailable(),
        budgetRemainingPct: gateBudgetPct(),
      });
    } catch {
      report = null; // 纯函数理论上不抛 —— 闸门自身异常也不炸环（按无裁决放行）
    }
    // W4-0（B）：校准熵随步刷新（steer 会话的即时检查通道 —— 下一步的
    // maybeCheckAndAsk 消费；闸门缺席/报告缺席 ⇒ null 只走周期通道）
    w4LastEntropy =
      report !== null && typeof report.entropy === 'number' && Number.isFinite(report.entropy)
        ? report.entropy
        : null;
    if (report === null) return { flow: 'proceed', value: decision };
    const blocking = report.advise === 'ask_human' || report.advise === 'abort';
    const redLineOk =
      (gateBlockTiers === null || gateBlockTiers.has(action.riskTier)) &&
      rawConfidence < gateBlockBelow;
    // 纪元 Ι 溯源后缀：仅经验置信换源时附加（自报链逐字节旧格式 —— 零回归红律）
    const smSuffix = selfModelN !== null
      ? `，source:'self-model'（经验置信 n=${Math.round(selfModelN * 1000) / 1000}）`
      : '';
    if (blocking && redLineOk) {
      if (report.advise === 'ask_human') {
        // 认识论升级终局：镜像宪法否决式收场（被拦动作不入轨迹不执行不 tick）
        escalated = true;
        escalateReason = 'epistemic-gate';
        evaluateGoal();
        summaryCore = `认识论闸门升级（${report.reasons.join('；')}${smSuffix}）`;
        return { flow: 'break' };
      }
      // 认识论收手终局：镜像步保险丝式 aborted 收场（不升级 —— 收手不是移交）
      lastPhase = 'aborted';
      summaryCore = `认识论闸门收手（${report.reasons.join('；')}${smSuffix}）`;
      return { flow: 'break' };
    }
    // ask_vlm / proceed / 红律收窄降级 ⇒ 注记放行：该步 journal（note）留痕
    const effText = Number.isFinite(report.confidence) ? report.confidence.toFixed(3) : '?';
    const tag = `认识论闸门 ${report.advise}（有效置信 ${effText}${smSuffix}${blocking ? '，红律收窄放行' : ''}）`;
    return {
      flow: 'proceed',
      value: { ...decision, note: decision.note !== undefined ? `${decision.note}；${tag}` : tag },
    };
  };

  /**
   * ΑΩ-R13 相位 ④：宪法裁决 —— consecutiveNoEffect 现场账目 + constitution.check：
   * 异常/空裁决 ⇒ error 步收敛；allowed=false ⇒ constitution-veto 否决终局；
   * requiresApproval ⇒ approval-required 审批终局（被拦动作不入轨迹不执行不 tick）。
   */
  const constitutionVerdict = (action: PolicyAction): PhaseOutcome<ConstitutionVerdict> => {
    let consecutiveNoEffect = 0;
    for (let i = trajectory.length - 1; i >= 0 && trajectory[i].outcome === 'no_effect'; i--) {
      consecutiveNoEffect++;
    }
    let verdict: ConstitutionVerdict;
    try {
      verdict = constitution.check(action, { goalText: spec.goal, consecutiveNoEffect, stepsTaken });
    } catch (err) {
      recordStep(action, 'error', lastDhash, `constitution: ${errText(err)}`);
      return advanceGoal() ? { flow: 'break' } : { flow: 'continue' };
    }
    if (!verdict) {
      recordStep(action, 'error', lastDhash, 'constitution: check 返回空裁决');
      return advanceGoal() ? { flow: 'break' } : { flow: 'continue' };
    }
    if (verdict.allowed === false) {
      // 否决终局：终局相取目标机；被否决动作不算一步世界推进（不 tick 不入轨迹）
      escalated = true;
      escalateReason = 'constitution-veto';
      evaluateGoal();
      summaryCore = `宪法否决：${verdict.reason}`;
      return { flow: 'break' };
    }
    if (verdict.requiresApproval === true) {
      // 审批终局：动作放行但必须人工确认 ⇒ 升级移交
      escalated = true;
      escalateReason = 'approval-required';
      evaluateGoal();
      summaryCore = `动作需人工审批：${verdict.reason}`;
      return { flow: 'break' };
    }
    return { flow: 'proceed', value: verdict };
  };

  /**
   * ΑΩ-R13 相位 ⑤⑥：策略升级拦截与 wait 沉降 —— escalate ⇒ 记 no_effect 升级步
   * 后 policy-escalate 终局（不执行）；wait ⇒ 注入式沉降后记 no_effect 步继续
   * （不执行）；其余动作 ⇒ 'proceed' 交执行相位。
   */
  const escalateAndWait = async (
    action: PolicyAction,
    decision: PolicyDecision,
  ): Promise<PhaseSignal> => {
    // ⑤ 策略主动升级 ⇒ 记 no_effect 升级步后终局（不执行）
    if (action.kind === 'escalate') {
      recordStep(action, 'no_effect', lastDhash, decision.note);
      escalated = true;
      escalateReason = 'policy-escalate';
      evaluateGoal();
      summaryCore = `策略主动升级：${action.rationale}`;
      return 'break';
    }

    // ⑥ wait 动作 ⇒ 注入式沉降后继续（不执行，记 no_effect 步）
    if (action.kind === 'wait') {
      try { await sleep(opts?.settleMs ?? DEFAULT_SETTLE_MS); } catch { /* 睡眠异常吞掉 */ }
      recordStep(action, 'no_effect', lastDhash, decision.note);
      return advanceGoal() ? 'break' : 'continue';
    }
    return 'proceed';
  };

  /**
   * ΑΩ-R13 相位 ⑥′：纪元 Ε 预言铸造（纯审计旁路）—— 动作落世界之前按（当前
   * 屏型指纹 × 动作键）铸一次预言；盲屏（无 dhash）不铸，铸造任何故障只丢
   * 预言绝不炸环。
   * ΝΩ-11（no-impact 闸）：零视觉影响动作（inspect/declare/ask_vlm/recall_skill
   * 与参数无效不会落地的世界动作 —— W1-3 classifyExpectedVisualEffect 同律三档
   * 标注）不铸：其结算见证恒为自环，observe 回灌会把 (屏型,动作)→同屏型 的
   * 平凡转移灌进世界模型、挤占真实转移的证据位（predict 首名被「什么都不发
   * 生」污染）。must/may-change（有影响）照铸——预言考试只考会动世界的手。
   */
  const prophecyMint = (action: PolicyAction, snapshot: WorldSnapshot | null): void => {
    if (prophecy === undefined) return;
    if (typeof lastDhash !== 'string' || lastDhash === '') return;
    if (classifyExpectedVisualEffect(action) === 'no-impact') return;
    try {
      prophecy.mint(lastDhash, prophecyActionKey(action, snapshot?.width, snapshot?.height));
      prophecyArmed = true;
    } catch { /* 铸造故障吞掉 —— 预言是旁路，绝不炸环 */ }
  };

  /**
   * ΑΩ-R13 相位 ⑦：执行 —— deps.execute 落动作并回报结局与判据证据（异常或缺
   * outcome ⇒ error 步收敛，不炸环）；成功 ⇒ 执行回报经载荷带出。
   */
  const executeStep = async (action: PolicyAction): Promise<PhaseOutcome<ExecResult>> => {
    let exec: ExecResult | null = null;
    try {
      exec = await deps.execute(action);
    } catch (err) {
      recordStep(action, 'error', lastDhash, `execute: ${errText(err)}`);
      return advanceGoal() ? { flow: 'break' } : { flow: 'continue' };
    }
    if (!exec || !exec.outcome) {
      recordStep(action, 'error', lastDhash, 'execute: 返回值缺少 outcome');
      return advanceGoal() ? { flow: 'break' } : { flow: 'continue' };
    }
    return { flow: 'proceed', value: exec };
  };

  /**
   * ΑΩ-R13 相位 ⑧：判据回填 —— 步入轨迹（宪法判决分层盖章 effectiveRiskTier）
   * + execute 回报的 criteriaEvidence 逐条 goal.recordCriterion（回填异常吞掉）。
   * ⑩ 观察者通知在 recordStep 内单点挂载。
   */
  const criteriaRecord = (
    action: PolicyAction,
    exec: ExecResult,
    decision: PolicyDecision,
    verdict: ConstitutionVerdict,
  ): void => {
    recordStep(action, exec.outcome, lastDhash, decision.note, validRiskTier(verdict.riskTier));
    if (Array.isArray(exec.criteriaEvidence)) {
      for (const evidence of exec.criteriaEvidence) {
        if (evidence === null || typeof evidence !== 'object') continue;
        if (typeof evidence.index !== 'number') continue;
        if (evidence.status !== 'met' && evidence.status !== 'violated') continue;
        try { deps.goal.recordCriterion(evidence.index, evidence.status); } catch { /* 回填异常吞掉 */ }
        criteriaStatus.set(evidence.index, evidence.status);
      }
    }
  };

  /**
   * ΑΩ-R13 相位 ⑧′：W8-B4（判据证伪面）—— 以最近完整感知的 OCR 语料（textDigest，
   * 本轮环顶感知的产物）对否定判据（mustNotAppear:/不得出现： 前缀）独立复核：
   * 命中禁词（精确∪fuzzy）⇒ violated、语料在场未命中 ⇒ met、OCR 缺席 ⇒ 零证据
   * （诚实降级，否定判据不自动为真）；肯定面归 execute 侧判据抽查通道。
   */
  const negativeCriteriaReview = (): void => {
    if (w8CriteriaPairs.length === 0) return;
    const w8Corpus =
      lastFullSnapshot !== null && typeof lastFullSnapshot === 'object' &&
      typeof lastFullSnapshot.textDigest === 'string'
        ? lastFullSnapshot.textDigest
        : null;
    const w8Eval = evaluateCriteria(w8CriteriaPairs, w8Corpus);
    for (const evidence of w8Eval.evidence) {
      if (evidence.polarity !== 'must-not-appear') continue; // 肯定面归 execute 通道
      try { deps.goal.recordCriterion(evidence.index, evidence.status); } catch { /* 回填异常吞掉 */ }
      criteriaStatus.set(evidence.index, evidence.status);
    }
  };

  /**
   * ΑΩ-R13 相位 ⑨：终局熔断 —— goal.tick 后终局评估（achieved/failed/aborted/
   * blocked 任一终局相即熔断收场）。true ⇒ 熔断收场。
   */
  const finalEvaluation = (): boolean => advanceGoal();

  // ΑΩ-R13（W6-1 债清偿）：环体相位编排 —— ⓪ 开环/相位函数族铸造在前，本循环
  // 只按 ⓪-⑩ 顺序调度相位并处置控制流；各相位职责与工单号见其头注释。
  while (true) {
    // ① 步数保险丝：到顶强制 aborted（优先于一切依赖调用，防依赖失控拖死环）
    if (fuseGuard()) break;

    // ①′ 环顶终局相位预判：每轮 perceive 前先问目标机
    if (preVerdict()) break;

    // ①″ W1-3 免看门控先行，随后（未跳过时）② 重型感知 + 预言结算
    let snapshot: WorldSnapshot | null = await perceptionGate();
    if (snapshot === null) {
      const perceived = await perceiveAndSettle();
      if (perceived.flow === 'break') break;
      if (perceived.flow === 'continue') continue;
      snapshot = perceived.value;
    }

    // ③-pre W4-0 活意图漂移检查：出题 ⇒ steer-drift 升级提问终局
    if (steerDriftCheck()) break;

    // ③ 判断：组装上下文（history 累积 / 预算推算）→ policy.decide
    const decided = await policyDecide(snapshot);
    if (decided.flow === 'break') break;
    if (decided.flow === 'continue') continue;
    let decision = decided.value.decision;
    let action = decided.value.action;

    // ③″ W3-7 探索拦截：escalate 且端口点亮 ⇒ 探索建议可替换本步
    const intercepted = explorationIntercept(decision, action, snapshot);
    decision = intercepted.decision;
    action = intercepted.action;

    // ③¼ W4-0/W5-5 岔路账落账（评分上下文铸偏置 + 支点锚；ΝΩ-11 候选面接 decision）
    branchLedgerStep(decision, action, snapshot);

    // ③′ 纪元 Η-1/Ι 认识论闸门：四维裁决（置信×代价×云脑×预算）
    const gated = epistemicGate(decision, action);
    if (gated.flow === 'break') break;
    decision = gated.value;

    // ④ 宪法裁决（异常/空裁决 ⇒ error 步收敛）
    const checked = constitutionVerdict(action);
    if (checked.flow === 'break') break;
    if (checked.flow === 'continue') continue;
    const verdict = checked.value;

    // ⑤⑥ escalate 升级终局 / wait 沉降继续（均不执行）
    const settledFlow = await escalateAndWait(action, decision);
    if (settledFlow === 'break') break;
    if (settledFlow === 'continue') continue;

    // ⑥′ 纪元 Ε 预言铸造（execute 之前，盲屏不铸）
    prophecyMint(action, snapshot);

    // ⑦ 执行（异常/缺 outcome ⇒ error 步收敛）
    const executed = await executeStep(action);
    if (executed.flow === 'break') break;
    if (executed.flow === 'continue') continue;

    // ⑧ 验证：步入轨迹（分层盖章）+ 判据证据逐条回填目标机
    criteriaRecord(action, executed.value, decision, verdict);

    // ⑧′ W8-B4 否定判据独立复核（OCR 语料三态判决）
    negativeCriteriaReview();

    // ⑨ 进化位：tick 后终局评估（终局相即熔断）
    if (finalEvaluation()) break;
  }

  if (!summaryCore) summaryCore = lastReason ? `目标机判定：${lastReason}` : '循环收敛退出';

  // W4-0（B 接线）：失败终局相铸岔路卡（W3-6）—— goal 落入 failed/aborted 且
  // 岔路账端口在场时，取失败前最近的可岔步铸三候选卡（归因报告缺席 ⇒ unknown
  // 诚实兜底），卡片经 lastBranchCard() 出口供换支重放（applyBranchChoice）与
  // 审计消费。纯旁路 —— PilotResult 既有字段分毫不动；故障吞掉绝不炸环。
  //（finalPhase 的宽化拷贝：lastPhase 经闭包赋值，TS 控制流不知道 —— as 还原
  //  GoalPhase 全域让 failed 比较合法。）
  const w4FinalPhase = lastPhase as GoalPhase;
  if (w4Branch !== null && typeof w4Branch.generateCard === 'function' &&
      (w4FinalPhase === 'failed' || w4FinalPhase === 'aborted')) {
    try {
      w4LastCard.card = w4Branch.generateCard({ phase: w4FinalPhase, reason: lastReason, now });
    } catch {
      w4LastCard.card = null; // 铸卡故障吞掉 —— 无卡不伪造（诚实降级）
    }
    // W5-5（缝3）：铸卡同步注入在役 steer 会话（steer_answer 岔路模式的持有面 ——
    // 无持有面则 W4-0 的卡只能经 lastBranchCard() 出口审计，用户单键换支的通道
    // 断头）。会话在场且持有面可用才注入；注入是旁路（换支是增益不是依赖），
    // 故障吞掉绝不炸环。steer 未点亮 ⇒ 无会话 ⇒ 卡仍在册（审计面不受影响）。
    if (w4LastCard.card !== null && w4SteerSession !== null &&
        typeof w4SteerSession.holdBranchCard === 'function') {
      try {
        w4SteerSession.holdBranchCard(w4LastCard.card);
      } catch {
        /* 持有面故障吞掉 —— 卡仍在 lastBranchCard() 出口在册 */
      }
    }
  }

  let metCount = 0;
  for (const status of criteriaStatus.values()) {
    if (status === 'met') metCount++;
  }

  const result: PilotResult = {
    phase: lastPhase,
    steps: stepsTaken,
    durationMs: Math.max(0, now() - startAt),
    trajectory,
    summary: `终局 ${lastPhase}：${summaryCore}，共执行 ${stepsTaken} 步，达成判据 ${metCount}/${criteriaTotal}。`,
    escalated,
  };
  if (escalated) result.escalateReason = escalateReason;
  // W1-3 记账出口：门控触发过（触发/跳过/唤醒三本账）即追加总汇报；未触发 ⇒
  // summary 逐字节不变 —— 零回归红律（端口缺席的生产路径恒零触发）
  if (gateProbes > 0) {
    result.summary += `免看门控：触发 ${gateProbes} 次，跳过 ${gateSkips} 次，唤醒 ${gateWakes} 次。`;
  }
  // W3-7 记账出口：探索拦截发生过才追加总汇报；未触发 ⇒ summary 逐字节不变
  // —— 零回归红律（端口缺席/关闭的生产路径恒零触发）
  if (w3ExploreSubs > 0) {
    result.summary += `W3-7 探索拦截：替代升级 ${w3ExploreSubs} 次。`;
  }
  return result;
}

/**
 * 自主闭环入口（识别→判断→宪法→执行→验证→进化的主脉，循环律详见 driveLoop 注释）。
 * 防弹承诺：本函数对任何依赖异常都绝不向外抛 —— 漏网异常也收敛为 failed 的 PilotResult。
 * @param deps 全部外部依赖（感知/策略/执行/目标机/宪法/观察者/睡眠/时钟）
 * @param opts.maxSteps 步数上限（覆盖 spec.maxSteps，末级回退 24）
 * @param opts.settleMs wait 动作沉降毫秒（缺省 300）
 * @returns PilotResult —— phase/steps/durationMs/trajectory/summary/escalated(+/escalateReason)
 */
export async function runAutonomousLoop(
  deps: AutonomyDeps,
  opts?: { maxSteps?: number; settleMs?: number },
): Promise<PilotResult> {
  try {
    return await driveLoop(deps, opts);
  } catch (err) {
    // 最后防线：任何漏网异常收敛为 failed 结果 —— 本模块对外绝不抛
    return {
      phase: 'failed',
      steps: 0,
      durationMs: 0,
      trajectory: [],
      summary: `终局 failed：闭环遭遇未预期异常（${errText(err)}），共执行 0 步，达成判据 0/0。`,
      escalated: false,
    };
  }
}
