// src/orchestration/contracts.ts
// D-6 多智能体协作中枢 —— 通信契约层（三轮评审收敛，唯一事实源）。
// 结构镜像 D-5：本文件 = 全部契约（数据契约 + 工位接口 + 编排器接口）；
//              stations.ts = 工位默认实现；pipeline.ts = 编排器实现；index.ts = 插件入口。
//
// 创世铁律的代码化：
//   绝对专注   → AttentionEnvelope 是工位唯一入参（station 判别式 + 构造权唯一归编排器）：
//                跨工位投递 = 编译错误；越界数据物理上无法进入信封 —— 类型即纪律，不靠自觉。
//   契约驱动   → 工位间只传本文件的强类型结构，绝不传自然语言 Prompt。
//   异常诚实   → 《异常诚实分层契约》D-7 修正案对齐（P0-1）：
//                apply = 加载门（throw —— 拒绝带病上线，收口于插件入口）；
//                configure = 运行层可重配方法（Result 降级，严禁 throw）；
//                run/decide/execute/perceive 运行层永不抛错。
//   Token 纪律 → 字段预算全部注释立法（≤N 字符），构造器结构性截断。
//
// 产权铁律：跨器官类型一律 import，绝不定义 ——
//   D-4 事件契约来自 ../doctorEvents；动作词汇表来自 ../sandbox/types（D-5 主权）。
//   Result 协议收敛 D-6 单源（P0-2 立法）：D-7 经 import 消费，绝不另立方言 ——
//   此前 D-5 sandbox Result（reason/degraded 臂）为 D-5 内部主权方言，不经本文件分发。
import type { DoctorVerdictPayload } from '../doctorEvents';
import type { SandboxAction } from '../sandbox/types';

export type { DoctorVerdictPayload, SandboxAction }; // 透传再导出（分发，非重定义）

// ─── 0. 统一结果协议（P0-2：D-6 单源）───

/** 配置校验错误（Result 错误臂的最小形态 —— field 精确定位，域外拒绝而非截断） */
export interface ConfigError {
  /** 违约字段（点路径定位，如 'retryPolicy.maxRetries'） */
  field: string;
  /** 违约原因 ≤200 字符（Token 纪律） */
  reason: string;
}

/**
 * 统一结果协议 —— 全项目 Result 的唯一事实源（P0-2 立法）。
 * 双臂结构化错误：错误臂携带类型化 E（ConfigError / KnowledgeError / Error …），
 * 与 D-5 sandbox 内部 Result（reason/degraded 方言）分治 —— 那是 D-5 主权，
 * 仅供沙箱内部消费，绝不跨器官分发。
 */
export type Result<T, E = ConfigError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

// ─── 1. 感知域：视觉工位的产出与输入 ───

/** 单个 UI 元素：视觉工位的最小产出单位（收编 uiExtractor 元素 + WhiteboxNode 方言） */
export interface UIElement {
  /** 漏斗层源标注（诚实降级的载体）：L1-tree 无障碍树 | L2-ocr 传统视觉 | L3-vlm 语义兜底；
   *  null = 无证据。伪造元素 = 毒化整个流水线 */
  source: 'L1-tree' | 'L2-ocr' | 'L3-vlm' | null;
  /** 元素角色（开集词汇，白盒源供给：'input' | 'button' | 'link' | …） */
  role: string;
  /** 无障碍名 / OCR 文本摘要（≤20 字符 —— D-3 LABEL_MAX 先例） */
  name: string;
  state?: 'enabled' | 'disabled' | 'masked' | 'checked' | 'unchecked';
  /** 归一化坐标（与宿主工具参数 schema 同域 —— 决策产出可直接执行，零翻译层） */
  rect: { x: number; y: number; width: number; height: number };
}

/** 分区身份方案（唯一铸造权 = 编排器，PerceptionRequest.regions 的唯一合法构造者）：
 *  网格分区 'g{col}x{row}' —— 确定性坐标同一性，跨感知轮稳定
 *    （staleRegionId 反馈回路的功能前提：下轮扫描中 g1x2 仍是 g1x2；
 *     生成式方案每扫必新 ID，过期区域引用将指向死 ID）
 *  自定义分区 'c{n}' —— 每轮单调递增，本轮内唯一（zoom/派生分区；无跨轮稳定性，诚实标注）
 *  唯一性由构造保证（坐标天然不重 + 计数器单调），零生成器状态、零碰撞面。
 *  身份两哲学：持久实体用 IdGenerator（时间唯一性），空间引用用坐标（位置稳定性）—— 混用即错 */
export interface RegionSpec {
  id: string;
  /** 归一化边界（与 UIElement.rect 同域） */
  x: number; y: number; width: number; height: number;
}

/** 场景补丁：异步并行的增量单位（视觉工位每产出一区，决策工位即开始消费） */
export interface ScenePatch {
  region: RegionSpec;
  elements: UIElement[];
  /** 本区漏斗降级深度（elements.source 的最深者）——审计用 */
  funnelDepth: 'L1' | 'L2' | 'L3' | 'empty';
  /** 诚实降级归因：扫描失败的 'empty'（fault 在场）≠ 真空无元素（fault 缺席）。
   *  决策工位据此分辨「请求 L3 兜底」与「该区真空，绕行规划」——两种空，两种决策 */
  fault?: { source: 'L1' | 'L2' | 'L3'; detail: string };
  capturedAt: number;
}

/** 中枢 → 视觉工位的感知指令 */
export interface PerceptionRequest {
  /** 关联意图（审计链锚） */
  intentRef: string;
  /** 扫描分区，按优先序（首元素最优先；空数组 = config.regionGrid 默认全屏网格） */
  regions: RegionSpec[];
  /** 漏斗深度授权（授权的最深层）：L1|L2 自动短路；L3 是花钱权 —— 治理归属中枢。
   *  视觉工位拿不到 ceiling='L3' 就物理上无法启动大模型（架构保证，不靠自觉） */
  funnelCeiling: 'L1' | 'L2' | 'L3';
  /** ceiling='L3' 时的授权依据（NeedGrounding.question 的回执）——每笔 L3 开销可审计入链 */
  l3Reason?: string;
  /** 感知截止：超时产出 fault 空补丁（诚实降级，绝不挂死流水线）；缺席 = config 回退 */
  deadlineMs?: number;
}

// ─── 2. 意图域：流水线的唯一入口语义 ───

/** 抽象意图（D-1 认知引擎规划 / 造物主手书）——id 经 IdGenerator 铸造（kind='intent'） */
export interface IntentPayload {
  id: string;
  /** 抽象意图 ≤160 字符（信封构造器截断——结构保证，不靠自觉） */
  goal: string;
  /** 可验证完成判据 ≤200 字符（决策工位的终止判断依据） */
  successCriteria?: string;
  /** 时间预算（步边界检查时钟——现世方言） */
  budgetMs?: number;
  source: 'cognition' | 'user';
  /** D-1 规划器版本（世界模型溯源，对齐 CognitionPlanReadyPayload.planVersion） */
  planVersion?: string;
}

// ─── 3. 注意力信封：绝对专注的物理载体 ───

export type StationKind = 'vision' | 'decision' | 'execution';

/** 工位唯一入参形态：工位只能看见信封内的东西。
 *  构造权唯一归编排器 —— station 判别式使跨工位投递 = 编译错误；
 *  tokenBudget 是 LLM 消耗的结构上限（超限由构造器截断——结构保证，不靠自觉） */
export interface AttentionEnvelope<Station extends StationKind, T> {
  station: Station;
  payload: T;
  /** LLM Token 硬预算：decision = 每轮决策预算；vision = L3 兜底预算（仅 ceiling='L3' 时可动用）；
   *  execution 恒 0 —— 零模型肌肉的类型层执法 */
  tokenBudget: number;
}

/** 决策工位的全部视野：intent + 场景补丁。无截图字节 —— 像素永不进大脑
 *  （L3 兜底时由中枢按需注入单分区，而非整屏） */
export interface DecisionContext {
  intent: IntentPayload;
  scene: ReadonlyArray<ScenePatch>;
}

// ─── 4. 决策域：唯一的大脑，唯一的花钱处 ───

/** 原子动作 = D-5 动作词汇表 + 规划理由（复用 SandboxAction —— 唯一动作词汇表，绝不另立） */
export type AtomicAction = SandboxAction & {
  /** 决策工位的规划理由 ≤120 字符（审计入链；经 ExecutionOrder 剥离后不进执行上下文） */
  rationale: string;
};

/** 决策工位的信息缺口信号（L3 兜底请求权——批准权在编排器，两权分离） */
export interface NeedGrounding {
  /** 判别式：'need-grounding' ∉ SandboxActionKind ⇒ DecisionOutput 判别收窄安全 */
  kind: 'need-grounding';
  /** 缺口分区（缺省 = 整屏语义不足） */
  regionId?: string;
  /** 决策工位要问的语义问题 ≤120 字符 */
  question: string;
}

/** 决策工位产出：动作 | 语义兜底请求（按 kind 判别收窄） */
export type DecisionOutput = AtomicAction | NeedGrounding;

// ─── 5. 执行域：零模型肌肉 ───

/** 执行指令单：编排器铸造，seq 是流水线序号的唯一诞生地 */
export interface ExecutionOrder {
  /** 流水线序号（单调递增；ExecutionResult.seq 与 AttemptRecord.seq 皆引用此值 ——
   *  同一事实，唯一名字，双名即漂移温床） */
  seq: number;
  /** rationale 已在信封构造时剥离（入审计链）——执行工位物理上看不见规划理由
   *  （注意力隔离的类型层执法：不是「不许看」，是类型上没有这个字段） */
  action: SandboxAction;
}

/** 执行失败分类（执行工位产出域） */
export type ExecutionFailureKind =
  | 'gate-rejected'      // D-5 四重门禁拒绝
  | 'host-error'         // 宿主管线执行错误
  | 'timeout'            // attemptTimeoutMs 越限（单尝试墙钟）
  | 'sandbox-degraded'   // D-5 预演降级且不可放行
  | 'cancelled';         // 外部终止（造物主取消/宿主关停）——不入重试循环（路由铁律见 §9）

/** 执行工位产出（硬证据哲学对齐 D-3：只有验证器的 effect_detected 是世界回击） */
export interface ExecutionResult {
  /** 引用 ExecutionOrder.seq（同一事实，唯一名字） */
  seq: number;
  /** null = 验证层不可用（诚实降级，非 false） */
  effectDetected: boolean | null;
  latencyMs: number;
  /** 经 D-5 沙箱预演的动作标记（DRILL, THEN DELIVER 的流水线证据） */
  rehearsed: boolean;
  failure?: { kind: ExecutionFailureKind; detail: string };
}

// ─── 6. 反馈域：失败的结构化捕获 ───

/** 失败反馈分类 = 执行失败 ∪ 医生否决（反馈可源自 D-4 verdict，故为超集） */
export type FeedbackKind = ExecutionFailureKind | 'doctor-rejected';

/** 决策工位的重规划语境：上一次为什么失败、哪里可能过时了 */
export interface FailureFeedback {
  /** 失败动作的流水线序号 */
  seq: number;
  kind: FeedbackKind;
  /** 失败摘要 ≤120 字符（Token 纪律：决策工位只读归因，不读全量日志） */
  detail: string;
  /** 疑似过时分区（点击落空 = 视觉过时的典型信号 ⇒ 决策可请求重扫该区；
   *  region.id 坐标同一性保证下轮引用仍有效） */
  staleRegionId?: string;
}

// ─── 7. 报告域：全粒度可回放的战报 ───

/** 一次尝试的完整轨迹（重试与逐次验收不被抹平） */
export interface AttemptRecord {
  seq: number;
  /** 同一决策轮内的第几次尝试（1 起；>1 时 feedback 必有值） */
  attempt: number;
  /** 全量动作（含 rationale —— 审计面；执行面只见 ExecutionOrder.action） */
  action: AtomicAction;
  result: ExecutionResult;
  /** 触发本次重试的前序失败（attempt=1 时缺席） */
  feedback?: FailureFeedback;
  /** 本次尝试的 D-4 验收回执（异步经事件到达；缺席 = 未触发验收 —— 诚实标注。
   *  终局验收 = 最后一条 attempt 的 doctorVerdict（单一事实源，报告级聚合字段已废除） */
  doctorVerdict?: DoctorVerdictPayload;
}

/** 流水线终局七态 —— 每态一条独立终止路径，零交叉 */
export type PipelineVerdict =
  | 'completed'   // 意图达成（successCriteria 满足）
  | 'failed'      // 重试耗尽 / 执行失败（内生失败）
  | 'degraded'    // 完成但验证层缺席（effectDetected=null 的诚实降级）
  | 'escalated'   // D-4 needs_review —— 裁决权上交造物主
  | 'rejected'    // D-4 rejected —— 流水线被否决（与 failed 严格分治）
  | 'timeout'     // intent.budgetMs 耗尽（预算时钟；部分轨迹保留）
  | 'aborted';    // 外部终止（造物主取消/宿主关停）——与 timeout = 预算时钟 严格分治

export interface PipelineReport {
  intentRef: string;
  verdict: PipelineVerdict;
  /** 终局归因 ≤120 字符（对话流只进这一行；全量证据在 attempts + reportPath —— Token 纪律） */
  terminalReason: string;
  attempts: AttemptRecord[];
  /** 工位级计量（信封预算的实际消耗） */
  tokenUsage: { vision: number; decision: number; execution: number };
  /** 沙箱因果链锚（Trajectory 回放） */
  chainTip: string;
  reportPath: string;
}

// ─── 8. 工位接口（编排器只认接口，不认实现——策略可热插拔）───

export interface VisionStation {
  /**
   * Never-reject 契约（《异常诚实分层契约》第二条的流域立法）：本异步流永不 reject ——
   * 一切故障化作 fault 标记的空补丁（ScenePatch.fault）；末分区或 deadline 后流正常终结。
   * 错误通道是架构死代码，消费侧零 try/catch。
   * 类型系统无法表达「永不 reject」（AsyncIterable 天然可拒绝）——故编排器消费侧保留
   * 最后防线：实现违约时将意外拒绝转为 fault 补丁 + 违约记录入链（纵深防御，不靠自觉）。
   */
  perceive(env: AttentionEnvelope<'vision', PerceptionRequest>): AsyncIterable<ScenePatch>;
}

export interface DecisionStation {
  /** 流水线中唯一的大模型调用点（ChatFn 依赖注入——对齐 planner 方言）。
   *  运行层方法：永不抛错 —— 内部故障以 NeedGrounding 或降级动作诚实表达 */
  decide(
    env: AttentionEnvelope<'decision', DecisionContext>,
    retryCtx?: FailureFeedback,
  ): Promise<DecisionOutput>;
}

export interface ExecutionStation {
  /** 零模型执行：D-5 沙箱预演优先 → 宿主管线（四重门禁复用）。
   *  运行层方法：永不抛错 —— 失败入 ExecutionResult.failure 结构化上报 */
  execute(env: AttentionEnvelope<'execution', ExecutionOrder>): Promise<ExecutionResult>;
}

// ─── 9. 编排器契约 ───

/** D-6 配置消费接口 —— 字段来源分层对齐 SandboxConfig 哲学：
 *  cordis.yml → Schema → apply(ctx, config)；魔法数字一律不落代码常量（config-driven 铁律） */
export interface PipelineConfig {
  /** 失败反馈重规划上限（防无限烧钱） */
  maxDecisionRetries: number;
  /** 视觉分区网格（并行粒度；region.id 网格方案的物理基础） */
  regionGrid: { cols: number; rows: number };
  /** 工位 Token 预算（信封 tokenBudget 的铸造源；execution 恒 0） */
  stationTokenBudgets: { vision: number; decision: number; execution: number };
  /** D-5 咬合开关：执行前沙箱预演（DRILL, THEN DELIVER） */
  rehearseBeforeExecute: boolean;
  /** 单尝试墙钟上限（决策调用 + 执行总和）：卡死工位越此线 ⇒ 本尝试 kind='timeout'
   *  入重试循环 —— 比 intent.budgetMs 更细的手术刀（整体超时杀流水线，尝试超时只杀一刀） */
  attemptTimeoutMs: number;
  /** 感知截止缺省值（PerceptionRequest.deadlineMs 缺席时的回退） */
  perceptionDeadlineMs: number;
  /** plan-ready 通道消费仲裁（P1-3 立法）：false = 让渡 D-7 主消费（缺省 —— 同通道
   *  双流水线执行 = 物理级事故）；true = 显式夺回消费权（仅 D-7 缺席部署时合法） */
  consumePlanReady: boolean;
}

export interface PipelineOrchestrator {
  /** 运行层可重配方法（《异常诚实分层契约》D-7 修正案对齐 / P0-1）：
   *  Result 降级，严禁 throw —— 首个违约 field 精确定位；
   *  加载门（Result !ok ⇒ throw 拒绝带病上线）收口于插件入口 apply */
  configure(config: PipelineConfig): Result<void, ConfigError>;

  /** 运行层方法（《异常诚实分层契约》第二条）：永不抛错 ——
   *  任何工位失败结构化捕获入 PipelineReport，交 D-4 裁决；
   *  cancelled 不入重试循环（给已终止的尝试做重规划是无意义烧钱）——直达 'aborted' 终局 */
  run(intent: IntentPayload, opts?: { snapshotId?: string }): Promise<PipelineReport>;

  /** 运行层方法：Result 降级（账本审计语义对齐 D-5 verifyLog） */
  verifyLog(): Result<{ ok: boolean; length: number; brokenAt: number | null }>;

  /** 生命周期归零（持久化资产已在 ctx.effect 清理函数先行落盘） */
  reset(): void;
}
