// src/sleep/sleepTypes.ts
// W6-1（doctor 债清偿·smell.over-engineering）：从 sleep/index.ts 提取的依赖注入
// 契约类型区（六幕 deps 面 / 晨报方言 / 梦再导出）—— 逐字节搬运（零逻辑变更）；
// index.ts 原位 `export *` 再导出，导入面不变。
import type { JournalEntry, DecisionPoint } from '../journal';
import type { ConsolidationReport } from '../knowledge/contracts';
import type { CalibrationReport } from '../kernel/calibrator';
import type { StepRecord } from '../autonomy/autoPilot';
import type { SelfAuditReport } from '../autonomy/selfAudit';

// ─── 依赖注入面（结构子集 —— 生产传真实单例，测试传计数 stub） ───

/** 回放幕的 journal 面（ActionJournal 的结构子集 —— 现成 API，不造新轮子） */
export interface SleepJournalLike {
  /** 全量/动作条目（actionOnly=false 含 MARKER 生命周期标记） */
  list(actionOnly?: boolean): JournalEntry[];
  /** 哈希链结算（B-1 存活窗口完整性校验） */
  verify(): { ok: boolean; length: number; brokenAt: number | null };
  /** 决策点分析（C-3 反事实回看 —— 可选面，缺席只影响计数） */
  findDecisionPoints?(query?: { sinceIndex?: number; failedOnly?: boolean }): DecisionPoint[];
  /** 最近任务语境（蒸馏幕的归纳描述源） */
  currentTask?(): string;
}

/** 蒸馏幕的技能库面（induceFromJournal 优先，缺席回退 mineMotifs） */
export interface SleepSkillLibraryLike {
  induceFromJournal?(description: string, entrySceneHash?: string): unknown;
  mineMotifs?(minUsage?: number, minLength?: number, maxMotifs?: number, maxSteps?: number):
    Array<{ steps: unknown[]; usage: number; motifLength: number }>;
  /**
   * W3-2（M2 参数化通用技能）：反统一模板蒸馏面（可选旁挂 —— 缺席 ⇒ 零行为
   * 变化）。返回值的结构子集（真实返回含完整模板对象，此处只消费审计三元组）；
   * 主归纳（induceFromJournal/mineMotifs）先行，新归纳的技能当夜即可参加配对蒸馏。
   */
  distillTemplates?(): {
    created: Array<{ id: number; parents: number[]; holes: number }>;
    rejected: Array<{ a: number; b: number; reason: string; detail?: string }>;
  };
}

/** 免疫幕的知识库面（consolidate 的 Result 方言结构子集） */
export interface SleepKnowledgeBaseLike {
  consolidate(): {
    ok: boolean;
    value?: ConsolidationReport;
    error?: { field?: string; reason?: string };
  };
}

/** 校准幕的编排器面（节流口径优先） */
export interface SleepConductorLike {
  maybeTick(): CalibrationReport[];
}

/** 校准幕的执法者面（conductor 缺席时的直连回退） */
export interface SleepCalibratorLike {
  tick(): CalibrationReport[];
}

/**
 * 校准幕（纪元 Ζ）的延迟尾统计面 —— 生产 Telemetry.tailReport 的结构子集。
 * 只取统计量（ξ + 超额数），不碰原始延迟环：gpdAdCriticalTable 原子的输入
 * 本就是统计形状（Monte-Carlo 自举以真实样本量+真实形状参数重演估计器分布）；
 * tailReport 样本不足 ⇒ null（telemetry 的诚实缺席语义原样传导）。
 */
export interface SleepTelemetryLike {
  /** 全工具延迟池的 GPD 尾拟合统计（xi=形状参数、tailCount=超额样本量） */
  tailReport(): { xi: number; tailCount: number } | null;
}

/**
 * 标定建议书单条（纪元 Ζ）。立法：「睡眠出建议、白天做决定」—— 建议只进晨报，
 * 永不写 kernelRegistry/任何消费方（值的所有权在白天醒着的决定者手里）。
 */
export interface CalibrationAdvice {
  /** 标定原子名（src/calibration.ts 的导出函数名 —— 可溯源性） */
  atom: string;
  /** 建议服务的算法形状消费方（字面量/内核键属地 —— 白天决定者看这里） */
  consumer: string;
  /** 当前服役值（建议书只对照、不落值） */
  current: string;
  /** 原子产出的建议值域（结构随原子而异 —— 纯函数输出原样入册） */
  values: Record<string, number>;
  /** 标定有效样本量（原子诚实下限过滤后） */
  n: number;
  /** 数据来源与口径申报（先验代用/池化/播种 —— 决定者的事前知情权） */
  source: string;
}

/** 回放幕的可选冲账面（D-7 判决桥的终局冲账 —— 生产无单例则诚实缺席） */
export interface SleepVerdictBridgeLike {
  settleAll(intentId?: string): Array<unknown>;
}

/** 可选用量台账面（vlmMeter.summary 的结构子集） */
export interface SleepMeterLike {
  summary(): { calls: number; failures: number; promptTokens: number; completionTokens: number };
}

// ─── W2-1（H4 暂存式离线批准队列）：晨报的待批清单消费面 ───
//
// 纯注入结构子集（零运行期导入 —— 本模块「相对导入全部 type-only」律不破）：
// 生产由组合根传 approval 单例的 approvalQueue 面投名，测试传假件。
// 晨报是 H4 的「人回来后」接口：待批清单（含过期标注与证据引用）随晨报
// 落盘，用户读晨报后经 adjudicate_approval_queue 批注式批量裁决。
// 队列摘要是晨报幕的**旁路**：dep 缺席/故障 ⇒ 清单缺席（不伪造空清单，
// 不炸晨报）；幂等水位线律不因队列而破 —— 同状态二睡仍全 noop（待批清单
// 随下一次实睡的晨报再出，队列自身另有独立持久化，不依赖晨报行存活）。
//
// W3-2 第二批接线①：approvalQueue 单例类型的只读导入 —— 三个晨报类型不再
// 手写结构子集，而是从 W2-1 的 approval.ts 单例**推导**（import type + typeof，
// 编译期擦除、零运行期耦合）：契约与生产实现不再两处漂移（生产单例改签名
// ⇒ 此处 typecheck 即红）。导出名保持不变 —— 既有消费方零改动。

// W3-2：approvalQueue 单例的只读类型导入（type-only —— 装载器零耦合律不破）
import type { approvalQueue as approvalQueueSingleton } from '../approval';
// W3-2 第二批接线②：MemoryOpsConvergenceReport 的只读类型导入（同律 type-only
// —— W2-6 的 memoryOps.ts 运行期面由组合根经 dep 注入，本模块零值导入）
import type { MemoryOpsConvergenceReport } from '../knowledge/memoryOps';
// W5-2（M4 梦回放）：dreamReplay 的只读类型导入（type-only —— 装载器零耦合律不破；
// 运行期面经第①幕的懒动态 import 装载，梦 dep 在场才付装载成本）
import type { DreamReplayReport, DreamEvolutionLike } from './dreamReplay';
// W5-2：梦方言契约类型的再导出（消费方单源 —— 与 W3-2 approvalQueue 推导导出同律）
export type {
  DreamReplayReport, DreamFailureTrajectory, DreamHistoricalStep, DreamWorldParams,
  DreamReplayEntry, DreamPriorityFactors, DreamReplayHandle, DreamReplayDeps,
} from './dreamReplay';

/** W3-2：晨报消费的队列面（approvalQueue 的只读结构子集 —— 经类型推导铸造） */
export type SleepApprovalQueueLike = Pick<typeof approvalQueueSingleton, 'pendingSummary'>;

/** W3-2（H4）：晨报的待批队列摘要（pendingSummary 返回类型的推导 —— 单源契约） */
export type MorningApprovalQueueSummary = ReturnType<SleepApprovalQueueLike['pendingSummary']>;

/** W3-2（H4）：晨报待批清单单条（证据引用随行 —— 用户裁决的知情面） */
export type MorningQueueItem = MorningApprovalQueueSummary['items'][number];

/** 睡眠依赖（全部可选 —— 缺哪个对应幕诚实 skipped） */
export interface SleepDeps {
  journal?: SleepJournalLike;
  skillLibrary?: SleepSkillLibraryLike;
  knowledgeBase?: SleepKnowledgeBaseLike;
  conductor?: SleepConductorLike;
  calibrator?: SleepCalibratorLike;
  /** 纪元 Ζ：延迟尾统计面（校准幕 GPD 临界表建议的数据源；缺席 ⇒ 该原子缺席注记） */
  telemetry?: SleepTelemetryLike;
  verdictBridge?: SleepVerdictBridgeLike;
  selfAudit?: (steps: StepRecord[]) => SelfAuditReport;
  meter?: SleepMeterLike;
  /** W2-1（H4）：待批队列摘要面（晨报幕消费；缺席 ⇒ 清单缺席 —— 诚实） */
  approvalQueue?: SleepApprovalQueueLike;
  /**
   * W3-2 第二批接线②（M5/W2-6）：记忆操作收敛面 —— 第④幕校准旁挂调用并
   * 并入晨报。集成契约：组合根投 `() => convergeMemoryOps({ seed: <journal
   * 水位线> })`（seed = 本睡水位线 —— 同账本态跨夜重放一致；W2-6 的
   * convergeMemoryOps 只读导入，运行期面经此 dep 注入，本模块零值导入）。
   * 缺席 ⇒ 旁挂跳过，零行为变化；故障 ⇒ 注记吸收，绝不炸校准幕。
   */
  memoryOpsConverger?: () => MemoryOpsConvergenceReport;
  /**
   * W5-2（M4 优先经验反事实梦回放 → ΝΩ-34 移序）：梦面 —— 高优先失败轨迹在
   * PCG 同构世界重放；由 audit 之后 report 之前的**迟到梦幕**演出（维护四幕先
   * 吃预算 —— 移序立法；counts/detail 账面归属第①幕回放条目）。集成契约：
   * 组合根投 `dream: { failures: () => failureMemory.dump().records, evolution:
   * <生产 EXP4 面>, spectrum: surpriseSpectrum(生产 worldModel) }`；测试投假件。
   * 缺席 ⇒ 零行为变化（六幕零漂移）；在场但无失败轨迹 ⇒ 诚实跳过并注记。
   * evolution 面只读消费 greedyArm/armProbabilities（重放不采样铁律），双写走
   * ingest 带 bandit 标注；ΝΩ-34：可选 heuristics 读数作梦水位线的策略指纹
   *（缺席回落 kernel generation 计数 —— 策略显著进化 ⇒ 同失败集允许重梦）。
   */
  dream?: SleepDreamDeps;
  log?: (msg: string) => void;
}

/**
 * W5-2：梦回放依赖面（结构子集 —— failures 必在，其余可缺席）。
 * failures 的返回值既可是 FailureRecord[]（生产：失败记忆单例的 dump）也可是
 * 已铸的 DreamFailureTrajectory[]（测试）—— dreamTrajectories 同一净化律。
 */
export interface SleepDreamDeps {
  /** 失败轨迹源（梦的全部原料；抛错/垃圾 ⇒ 诚实跳过并注记） */
  failures: () => unknown;
  /** EXP4 面（只读消费 greedyArm/armProbabilities + 双写 ingest；缺席 ⇒ 双写缺席注记） */
  evolution?: DreamEvolutionLike;
  /** 惊异谱（surpriseSpectrum 产出 —— PER 惊异因子的谱回落通道） */
  spectrum?: Record<string, number>;
  /** 梦回放预算（maxDreams/maxStepsPerDream；缺省梦模块 DREAM_BUDGET_DEFAULTS） */
  budget?: { maxDreams?: number; maxStepsPerDream?: number };
}

/** 睡眠配置（Config 的结构子集 —— 生产直接传插件 Config，测试传最小面） */
export interface SleepConfig {
  /** 晨报/水位线 JSONL 落盘路径；空/缺席 = 仅内存（跨进程幂等失效） */
  sleepTracePath?: string;
  /** 睡眠预算 ms（逐幕检查；缺省 2000 —— 宁短勿挂） */
  budgetMs?: number;
  /** 时钟注入（确定性测试；缺省 Date.now） */
  now?: () => number;
}

/** 单幕报告条目 */
export interface SleepActReport {
  /** 幕名（SIX_ACTS 之一） */
  name: string;
  /** ok=正常完成；noop=水位线未动零新增；skipped=依赖缺席诚实跳过；
   *  error=幕内故障被吞；timeout=预算耗尽被掐 */
  status: 'ok' | 'noop' | 'skipped' | 'error' | 'timeout';
  /** 幕的量化产出（键集随幕而异；noop/skipped/timeout 恒空对象） */
  counts: Record<string, number>;
  /** 幕附注（跳过原因 / 错误摘要 / 审计 verdict 一行） */
  detail?: string;
  /** 标定建议书（纪元 Ζ，仅校准幕携带；0 项建议 ⇒ 字段缺席 —— 不伪造空册） */
  calibrationAdvice?: CalibrationAdvice[];
}

/** 晨报：一次认知睡眠周期的总汇报 */
export interface SleepReport {
  startedAt: number;
  durationMs: number;
  /** 本次睡眠的状态指纹（journal 条数:尾哈希；journal 缺席/故障 ⇒ null —— 无法去重） */
  watermark: string | null;
  /** 任一幕被预算掐断（半程报告的标志位） */
  timeout: boolean;
  acts: SleepActReport[];
  /** 可选用量台账快照（meter 缺席/故障 ⇒ 缺席 —— 诚实，不伪造零） */
  usage?: Record<string, number>;
  /** W2-1（H4）：待批队列清单（approvalQueue dep 缺席/故障 ⇒ 缺席 —— 诚实，
   *  不伪造空清单；noop 睡眠不携带 —— 水位线律优先，清单随实睡晨报再出） */
  approvalQueue?: MorningApprovalQueueSummary;
  /** W3-2 第二批接线②：记忆操作收敛摘要（memoryOpsConverger dep 缺席/故障 ⇒
   *  缺席 —— 诚实；noop 睡眠不携带 —— 水位线律优先）。收敛是「落值版标定
   *  建议书」：值已由 converger 写入注册表，晨报只报账（白天决定者可回看）。 */
  memoryOps?: SleepMemoryOpsSummary;
  /** W5-2（M4）：梦回放摘要（dream dep 缺席/故障 ⇒ 缺席 —— 诚实；noop 睡眠
   *  不携带 —— 水位线律优先）。反事实教训清单 = report.dream.lessons ——
   *  「重放成功而历史失败」的决策纠错面，白天醒着的决定者读这里。 */
  dream?: DreamReplayReport;
}

/** W3-2 第二批接线②：晨报的记忆操作收敛摘要（sanitize 后的审计面 —— 一切
 *  字段确定性可重放；entries 只保结构合法者，说谎的 dep 不毒化晨报） */
export interface SleepMemoryOpsSummary {
  /** 总臂数（28 = 7 类 × 4 操作 —— 结构常量的对账面） */
  arms: number;
  /** 过门限并落值的臂数 */
  converged: number;
  /** 反馈不足按兵不动的臂数（零行为变化的安全带审计面） */
  held: number;
  /** 收敛种子（重放的钥匙 —— 集成契约里应为 journal 水位线） */
  seed: string;
  /** 收敛明细（每臂一行：key/from/to/setOk + 决策来源） */
  entries: Array<{ key: string; from: number; to: number; setOk: boolean; source: string }>;
}
