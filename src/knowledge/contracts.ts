// src/knowledge/contracts.ts
// D-7 隐知识增强中枢 —— 契约层（V1 灵魂 + V2 骨架，绝对满血版）。
// 方言边界声明：本文件是 D-7 主权契约（造物主 D-7 规范原文形态）。
//   与 D-6 契约（orchestration/contracts.ts）冲突的类型按 D-7 方言铸造于此；
//   边界适配（D-1/D-4 事件 → D-7 内部形态）单点收口于 adapters.ts —— 双方言显式翻译器（P0-2）。
//   非冲突类型（ScenePatch / AtomicAction / PipelineVerdict / Result / ConfigError）
//   一律 import D-6，绝不重定义 —— Result 收敛 D-6 单源（P0-2 立法）。
// 《异常诚实分层契约》D-7 修正案：apply = 加载门（throw）；configure = 运行层可重配方法
//   （Result，严禁 throw）；一切运行方法 Result 优雅降级。
import type {
  ScenePatch, AtomicAction, PipelineVerdict, Result, ConfigError,
} from '../orchestration/contracts';

export type { ScenePatch, AtomicAction, PipelineVerdict, Result, ConfigError }; // 透传再导出（单一事实源分发）

// ─── 1. 注意力信封（五工位字面量参数化）───
// D-7 方言：station 为宽联合（新增 doctor / knowledge 两工位），但经字面量参数化
// 收紧（P1-1 对齐 D-6 裁决）：AttentionEnvelope<'vision', T> 的 station 字段类型
// 收窄为 'vision' —— 视觉信封传入 decide() = 编译错误。跨工位投递防护从
// 「构造垄断」升级为「类型即纪律 + 构造垄断」双层执法。
export type D7StationKind = 'vision' | 'decision' | 'execution' | 'doctor' | 'knowledge';

export interface AttentionEnvelope<Station extends D7StationKind, T> {
  station: Station;
  payload: T;
  tokenBudget: number;
}

// ─── 3. V1 灵魂：隐知识分类学 ───
export type KnowledgeCategory =
  | 'ui-pattern' | 'shortcut' | 'system-quirk'
  | 'business-rule' | 'error-pattern' | 'workflow' | 'preference';

// ─── 4. V1 灵魂：隐知识实体 ───
export interface KnowledgeEntry {
  id: string;
  category: KnowledgeCategory;
  /** ≤500 字符（insert 铸造点截断 —— 结构保证） */
  content: string;
  scenario: string;
  /** 0-1 域（insert 铸造点校验） */
  confidence: number;
  source: 'manual' | 'auto-learn' | 'import';
  updatedAt: number;
  usageCount: number;
  intentRef?: string;
  /**
   * 亲证时间戳（核证接地纪元）：本条目最后一次被直接观察证实的时刻。
   * 缺席 = 传闻（hearsay —— 他人转述/手工种子，从未亲证 ⇒ 信任 0）；
   * 在场 = 亲证（信任 = 置信度 × 亲证因子，随时间衰减；复证/探针刷新）。
   * 与 updatedAt 分工：updatedAt 是最后一次「触碰」（强化即刷新），
   * verifiedAt 只被直接观察刷新（学到的成败、探针结果）—— 两个时钟，
   * 两个问题：「记忆还新鲜吗」（updatedAt）vs「我的亲证还有效吗」（verifiedAt）。
   */
  verifiedAt?: number;
}

export interface KnowledgeQuery {
  sceneDescription: string;
  intentDescription: string;
  maxResults?: number;
  minConfidence?: number;
}

export interface KnowledgeResult {
  entries: KnowledgeEntry[];
  latencyMs: number;
  strategy: 'keyword' | 'vector' | 'hybrid';
}

// ─── 5. 隐知识注入（V2 防卡顿蒸馏版）───
export interface KnowledgeInjection {
  /** 严格 ≤300 字符（distillInjection 铸造点截断 —— Token 纪律的结构保证） */
  summary: string;
  categories: KnowledgeCategory[];
  maxConfidence: number;
  sources: Array<{ type: 'manual' | 'auto-learn'; ref: string }>;
  /**
   * 结构化证据片段（神经纪元立法）：与 summary 同源同序（同一轮鸡尾酒旋转的
   * 单一真相）—— summary 供 LLM/Token 预算路径消费，fragments 供前额叶仿真
   * 决策做逐候选证据评估（语义相似度 × 置信度）。可选字段：旧实现缺席时
   * 决策工位诚实降级（无证据 ⇒ 无仿真，绝不解析 summary 反推结构）。
   */
  fragments?: ReadonlyArray<{
    category: KnowledgeCategory;
    content: string;
    confidence: number;
    /**
     * 亲证时间戳（核证接地纪元）：与条目同源透传 —— 信任评估（trustOf）
     * 的输入。缺席 = 传闻（信任 0）；在场 = 亲证（信任 = 置信度 × 衰减）。
     */
    verifiedAt?: number;
  }>;
}

export interface KnowledgeError { field: string; reason: string; }

/** 睡眠整合战报（海马体→皮层：情景记忆 → 语义记忆的蒸馏报告） */
export interface ConsolidationReport {
  /** 参与聚类的 auto-learn 条目数 */
  episodes: number;
  /** 形成的语义簇数（≥ MIN_CLUSTER_SIZE 的簇才蒸馏） */
  clusters: number;
  /** 蒸馏出的语义条目数（已入库，source='auto-learn'） */
  consolidated: number;
  /** 被皮层化后衰减的原始情景条目数（情景让位语义 —— 证据不销毁，只降温） */
  episodedDecayed: number;
  /** 整合耗时（ms）—— 睡眠预算的可观测面 */
  durationMs: number;
}

// ─── 6. V1 灵魂：隐知识行为引擎（四大核心动作，异常诚实）───
export interface KnowledgeBase {
  query(query: KnowledgeQuery): Result<KnowledgeResult, KnowledgeError>;
  insert(entry: Omit<KnowledgeEntry, 'id' | 'updatedAt' | 'usageCount'>): Result<string, KnowledgeError>;
  learnFromOutcome(outcome: ExecutionOutcome): Result<void, KnowledgeError>;
  /**
   * 睡眠整合（神经纪元可选能力）：情景记忆（逐条 outcome 学习）聚类蒸馏为
   * 语义记忆（跨场景泛化模式）。可选方法 —— 实现者缺席时调用方诚实降级
   * （无睡眠 ≠ 无记忆，只是无泛化）。
   */
  consolidate?(): Result<ConsolidationReport, KnowledgeError>;
  dispose(): Result<void, Error>;
}

// ─── 7. 核心载荷（D-7 方言）───
export interface IntentPayload {
  id: string;
  description: string;
  previousResults?: ExecutionResult[];
}

export interface NeedGrounding {
  reason: string;
  focus: string;
}

export interface PerceptionRequest {
  grid: { cols: number; rows: number };
  forceL3?: boolean;
  snapshotId?: string;
}

export type DoctorVerdictPayload =
  | { status: 'approved'; confidence: number }
  | { status: 'rejected'; reason: string }
  | { status: 'needs_review'; flags: string[] };

// ─── 8. 执行结果（D-7 方言：action 内联回显）───
export interface ExecutionResult {
  action: AtomicAction;
  status: 'success' | 'failure' | 'degraded';
  durationMs: number;
  failure?: {
    kind: 'gate-rejected' | 'host-error' | 'timeout' | 'sandbox-degraded' | 'cancelled' | 'timed-out';
    detail: string;
  };
}

// ─── 9. V1 灵魂：反馈学习的燃料（闭环进化核心）───
export interface ExecutionOutcome {
  intent: IntentPayload;
  action: AtomicAction;
  result: ExecutionResult;
  doctorVerdict?: DoctorVerdictPayload;
  retryCount: number;
  totalDurationMs: number;
}

// ─── 10. V1 灵魂：决策工位的完整上下文 ───
export interface DecisionContext {
  intent: IntentPayload;
  scene: ScenePatch[];
  knowledgeContext?: KnowledgeInjection;
  previousResults?: ExecutionResult[];
}

// ─── 11. 工位接口（D-7 最小方言，桩纪元；信封字面量参数化 —— 跨工位投递 = 编译错误）───
export interface VisionStation {
  perceive(env: AttentionEnvelope<'vision', PerceptionRequest>): Promise<ScenePatch[]>;
}

export interface DecisionStation {
  decide(
    env: AttentionEnvelope<'decision', DecisionContext>,
    retryCtx?: FailureFeedback,
  ): Promise<AtomicAction | NeedGrounding>;
}

export interface ExecutionStation {
  execute(env: AttentionEnvelope<'execution', AtomicAction>): Promise<ExecutionResult>;
}

/** 决策重规划语境（D-7 最小形态） */
export interface FailureFeedback {
  reason: string;
  retryCount: number;
}

// ─── 12. 流水线报告（D-7 桩形态 —— 全粒度轨迹由 ExecutionOutcome[] 承载）───
export interface PipelineReport {
  intentId: string;
  verdict: PipelineVerdict;
  outcomes: ExecutionOutcome[];
  knowledgeUsed: KnowledgeInjection | null;
  terminalReason: string;
  reportPath: string;
  /** 可观测性锚点（P1-5）：本 run 在 append-only 哈希链（sandboxLog 'knowledge-*' 段）
   *  的链尖端 —— 与 D-6 报告 chainTip 同方言，D-4 审计定位用 */
  chainTip?: string;
}

// ─── 12.5 验收结算单（P0-4：D-7 验收门 —— 学习只认已结算的 outcome）───

/** 一次 outcome 的结算记录：D-4 判决回执（黄金路径）或流水线终局冲账（诚实降级） */
export interface OutcomeSettlement {
  /** 尝试主体（`${intentId}:${seq}` —— D-4 判决回执的关联锚，逐字约定） */
  subject: string;
  /** 结算时的 outcome 快照（判决在场则已附加 doctorVerdict） */
  outcome: ExecutionOutcome;
  /** 结算路径：'verdict' = D-4 回执到达；'run-end' = 流水线终局冲账（D-4 沉默的诚实降级） */
  settledBy: 'verdict' | 'run-end';
  settledAt: number;
}

// ─── 13. 编排器契约（configure Result —— D-7 修正案）───

export interface PipelineConfig {
  regionGrid?: { cols: number; rows: number };
  timeout: { overall: number; perStep: number; perPerception: number };
  retryPolicy: { maxRetries: number; backoffMs: number; maxBackoffMs: number };
  /** 隐知识检索守卫：越限 ⇒ 无隐知识模式降级（防卡顿铁律，默认 50ms） */
  knowledgeTimeout: number;
  knowledgeMaxResults: number;
  /** 注入摘要字符预算（≤300 —— distillInjection 铸造点执法） */
  knowledgeMaxChars: number;
  /** 工位 Token 预算（P1-2 config-driven 铁律：预算治理入配置域，缺省见插件 DEFAULT_CONFIG；
   *  桩纪元语义：vision 无 L3 通道恒不消耗；execution 零模型肌肉恒 0 —— 域外拒绝） */
  stationTokenBudgets?: { vision: number; decision: number; execution: number };
  /**
   * 消融开关（科学义务）：每层可独立关闭 —— 主张要有数字，数字要能复现。
   * 流水线侧执法（检索/学习/L3 计费）；决策工位内部层级（反射/仿真）由
   * ReflexiveDecisionOpts 的同名额舌执法 —— 消融矩阵由基准组合两侧。
   */
  ablation?: AblationConfig;
}

/**
 * 消融配置（证据先于修辞的执法面）：
 *   disableKnowledge — 关隐知识（检索 + 学习 + 睡眠整合全停）：证明「经验」的贡献
 *   l3Policy         — L3 计费策略：'surprise'（惊讶计费器，缺省）| 'always'（恒开：
 *                      成本上限对照组）| 'never'（恒关：成本下限对照组）
 * （决策工位的 disableReflex / disableDeliberation 见 stations.ts —— 工位内主权）
 */
export interface AblationConfig {
  disableKnowledge?: boolean;
  l3Policy?: 'surprise' | 'always' | 'never';
}

export interface PipelineOrchestrator {
  /** 运行层可重配方法（D-7 修正案）：Result 降级，严禁 throw；加载门在 apply 收口 */
  configure(config: PipelineConfig): Result<void, ConfigError>;
  /** 运行层：永不 throw —— 任何工位故障结构化捕获入报告 */
  run(intent: IntentPayload): Promise<PipelineReport>;
  dispose(): Result<void, Error>;
}

// ─── 14. 预测编码基底：世界模型（预测式智能体纪元）───
// 理论根基：预测处理理论（Predictive Processing）—— 皮层是预测机器；
// 感知 = 预测误差最小化；行动 = 主动推理；学习 = 预测误差更新模型。
// 世界模型把 GUI 当作可预测的动力系统：屏幕有类型（类型学），
// 动作有后果（动力学），意外可度量（预测误差 = 惊讶，单位比特）。

/** 状态转移预测（世界模型的前向输出：给定类型与动作 ⇒ 未来分布） */
export interface TransitionPrediction {
  /** 下一屏幕类型分布（概率降序） */
  nextTypes: Array<{ typeId: string; prob: number }>;
  /** 该转移的历史成功率 */
  successProb: number;
  /** 支撑本预测的观察数（证据经济学：无证据的预测不值钱） */
  evidence: number;
}

/**
 * 预测误差报告（惊讶 —— 一切认知预算的定价依据）。
 * bits = -log2 P(actual | model)：预期概率越低，惊讶越大。
 * novel = 模型从未见过此转移（真新颖 ≠ 意料之外的熟悉 —— 前者升注意，
 * 后者只是小概率事件重演）。
 */
export interface SurpriseReport {
  bits: number;
  novel: boolean;
  evidence: number;
}

/**
 * 世界模型（屏幕类型学 + 接口动力学 + 预测误差）。
 * 类型指认即注册（typeOf 有副作用 —— 会员计数增长）；场景不可见 ⇒ null
 * （「看不见」是 fault 不是真空，绝不铸造幽灵类型）。
 */
export interface WorldModel {
  /** 屏幕定型：元素签名与既有类型匹配（语义相似 ≥ 阈值）或铸造新类型 */
  typeOf(scene: ScenePatch[]): string | null;
  /** 观察一次状态转移（先 surprise 后 observe —— 误差是学习信号，顺序即语义） */
  observe(
    fromTypeId: string, actionKey: string, toTypeId: string, success: boolean,
  ): Result<void, KnowledgeError>;
  /** 前向预测：无历史 ⇒ null（诚实的无知，不是均匀分布的伪装） */
  predict(fromTypeId: string, actionKey: string): Result<TransitionPrediction | null, KnowledgeError>;
  /** 预测误差（Laplace 平滑；无历史 ⇒ novel=true） */
  surprise(
    fromTypeId: string, actionKey: string, actualTypeId: string,
  ): Result<SurpriseReport, KnowledgeError>;
}
