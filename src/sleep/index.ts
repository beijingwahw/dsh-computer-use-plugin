// src/sleep/index.ts
// 纪元 Υ（认知睡眠周期）：会话终了的离线整合编排器 —— 六幕剧 + 幂等水位线。
//
// 六幕（每一幕都消费现成器官，绝不造新轮子）：
//   ① 回放幕 replay    —— journal 冲账/结算：哈希链 verify（B-1 存活窗校验）+
//                         决策点分析（C-3 findDecisionPoints 反事实回看）；可选
//                         verdictBridge.settleAll（D-7 验收等待室的终局冲账）。
//                         W5-2（M4）升级为「回放 + 梦回放」复合幕：高优先失败
//                         轨迹（PER：惊异×代价×新近衰减）在 PCG 同构世界冻结
//                         输入重放，当前策略重决策与历史逐步 diff，分歧点之后
//                         双写（实验室 kernel 账本 + 进化引擎 EXP4 ingest 带
//                         bandit 标注）；重放成功而历史失败 ⇒ 反事实教训入晨报。
//                         梦有独立水位线（失败集身份指纹 —— 防重复回放）；梦
//                         dep 缺席 ⇒ 复合幕退化为既有回放幕（零漂移）。
//   ② 蒸馏幕 distill   —— skillLibrary 归纳：induceFromJournal 在场则归纳任务
//                         切片，否则 mineMotifs（F-1 文法动机挖掘）。W3-2（M2）
//                         旁挂反统一模板蒸馏：distillTemplates 可选面在场则
//                         把同骨架技能对 DTW 对齐反统一为带洞模板（纯增量）。
//   ③ 免疫幕 immune    —— knowledgeBase.consolidate()（海马体→皮层睡眠整合）。
//   ④ 校准幕 calibrate —— 内核校准 tick：conductor.maybeTick 优先（节流口径，
//                         与生产用户消息钩子同一执法面 —— enabled=false 恒空是
//                         诚实空转，睡眠不偷开进化总开关），否则 calibrator.tick。
//                         纪元 Ζ 旁挂「标定建议书」：把 calibration.ts 的标定原子
//                         接上睡眠时才有的离线数据（journal 坐标漂移对、telemetry
//                         延迟尾统计）—— 只建议不落值（立法：「睡眠出建议、白天
//                         做决定」，值仍归 kernelRegistry/消费方所有）；样本不足
//                         ⇒ 建议书诚实缺席（缺席注记在案，绝不伪造标定）。
//                         W3-2 第二批接线②旁挂「记忆操作收敛」：memoryOpsConverger
//                         可选面（W2-6 convergeMemoryOps 的注入缝）调用并并入晨报
//                         ——「睡眠出收敛、白天做决定」的落值版；缺席零行为变化。
//   ⑤ 审计幕 audit     —— selfAudit.auditTrajectory 纯函数面：journal 动作流
//                         投影为 StepRecord 后回看（震荡/浪费/黑箱判决摘要）。
//   ⑥ 晨报幕 report    —— SleepReport 铸造：config.sleepTracePath 非空时 JSONL
//                         追加落盘（行级 append，pilotStore 同律：断尾行容忍）。
//                         W2-1（H4）：经注入的 approvalQueue 面附待批清单 ——
//                         离线暂存队列的人回来接口（批注式批量裁决的消费面）。
//
// 设计律（项目宪章的睡眠版）：
//   · 永不抛异常 —— 睡眠是旁路仪式：任何一幕的任何故障（依赖抛错/落盘失败/
//     时钟畸形）都收敛为报告里的 status:'error'/'skipped'/'timeout' 条目，
//     绝不炸宿主、绝不阻塞卸载；
//   · 全依赖注入 —— journal/skillLibrary/knowledgeBase/conductor/calibrator/
//     verdictBridge/selfAudit/meter 全部经 SleepDeps 注入，缺哪个就诚实跳过
//     （status:'skipped'）；本模块零单例持有、零网络、零真钟（now 可注入）、
//     相对导入全部 type-only（装载器零耦合）—— 唯一豁免见下方纪元 Ζ 注记：
//   · 幂等水位线 —— 「已消化到哪」以 journal 状态指纹（条数:尾哈希）记账：
//     同一状态睡两次，第二次六幕全 noop（零依赖调用、零落盘 ——「零新增」取
//     严格义）；水位线随 sleepTracePath 持久化（trace 尾行携带 watermark），
//     路径空 = 仅内存水位线（跨进程幂等失效 —— 诚实降级）；
//   · 宁短勿挂 —— 逐幕预算检查（budgetMs，缺省 2000ms）：预算耗尽后未演的
//     幕标 'timeout'，半程晨报照铸（卸载路径绝不为一夜好觉等一秒）。
//
// 落盘律（pilotStore 同款）：JSONL 追加式；读方容忍断尾行（截断的半行跳过，
//   不炸）；写方在追加前探测尾换行 —— 断尾后追加先补 '\n' 治疗，新行不被
//   断尾毒化成「半行+整行」的不可解析串。
//
// 同步性不变量：六幕与落盘全部为同步消化（deps 皆为同步面、appendFileSync
//   落盘）—— runSleepCycle 虽为 async 签名，触发即完成主体（供卸载路径在
//   一切 reset 之前安全快照；接线注释见 src/index.ts 纪元 Υ 段）。
import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import type { JournalEntry, DecisionPoint } from '../journal';
import type { ConsolidationReport } from '../knowledge/contracts';
import type { CalibrationReport } from '../kernel/calibrator';
import type { StepRecord } from '../autonomy/autoPilot';
import type { SelfAuditReport } from '../autonomy/selfAudit';
// 纪元 Ζ 运行期导入 ——「相对导入全部 type-only」装载器零耦合律的唯一豁免，
// 豁免理由（三条件同时成立，缺一即回退注入式）：
//   1. calibration.ts 是纯数学器官（四个标定原子，全部纯函数、可播种、确定性）；
//   2. 其唯一相对导入 telemetry.js 同为零依赖叶子（无 fs/cordis/单例，模块顶层
//      零副作用）—— 导入它不把宿主任何重装载面拖进本模块；
//   3. 标定建议书是睡眠的立法产出（非可选装饰），静态导入让纯函数与六幕同匣
//      受审；单例与 IO 面仍然全部走 SleepDeps 注入，零耦合律实质不变。
import { gpdAdCriticalTable, calibrateKalmanQR } from '../calibration';
import type { DriftPair } from '../calibration';

/** 缺省睡眠预算：2s（与 src/index.ts 卸载路径的保险丝同值 —— 宁短勿挂） */
export const DEFAULT_SLEEP_BUDGET_MS = 2000;

/** 六幕名（固定演出次序：回放→蒸馏→免疫→校准→审计→晨报） */
const SIX_ACTS = ['replay', 'distill', 'immune', 'calibrate', 'audit', 'report'] as const;

/** 模块级内存水位线（路径空 = 唯一水位线；路径非空时与 trace 尾行互补） */
let inMemoryWatermark: string | null = null;

/** W5-2：梦回放独立水位线（内存面 —— 失败集身份指纹；trace 尾行互补跨进程） */
let inMemoryDreamWatermark: string | null = null;

/** 测试缝：清零内存水位线（模拟新进程 —— 只清水位线账，不动磁盘 trace） */
export function resetSleepCycle(): void {
  inMemoryWatermark = null;
  inMemoryDreamWatermark = null;
}

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
   * W5-2（M4 优先经验反事实梦回放）：第①幕复合幕的梦面 —— 高优先失败轨迹在
   * PCG 同构世界重放。集成契约：组合根投 `dream: { failures: () =>
   * failureMemory.dump().records, evolution: <生产 EXP4 面>, spectrum:
   * surpriseSpectrum(生产 worldModel) }`；测试投假件。缺席 ⇒ 零行为变化
   * （六幕零漂移）；在场但无失败轨迹 ⇒ 诚实跳过并注记。evolution 面只读消费
   * greedyArm/armProbabilities（重放不采样铁律），双写走 ingest 带 bandit 标注。
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

/** 时钟安全读数：注入时钟抛错/回垃圾 ⇒ 0（绝不因计时面炸睡眠） */
function safeNow(clock: () => number): number {
  try {
    const t = clock();
    return typeof t === 'number' && Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

/** 非负有限数净化（垃圾计数不进晨报） */
function numOr0(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

// ─── 水位线 ───

/**
 * journal 状态指纹：`${全量条数}:${尾条哈希前 16}`。
 * 条数与尾哈希双敏感 —— 任何 append（含 MARKER）都前移指纹；journal 缺席/
 * list 抛错 ⇒ null（无法指纹 = 无法去重，每睡皆实睡 —— 诚实方向）。
 */
function computeWatermark(journal?: SleepJournalLike): string | null {
  if (!journal || typeof journal.list !== 'function') return null;
  try {
    const entries = journal.list(false);
    if (!Array.isArray(entries)) return null;
    if (entries.length === 0) return '0:empty';
    const last = entries[entries.length - 1] as JournalEntry | undefined;
    const tip = typeof last?.hash === 'string' && last.hash
      ? last.hash.slice(0, 16)
      : typeof last?.ts === 'number' && Number.isFinite(last.ts)
        ? `t${last.ts}`
        : 'no-tip';
    return `${entries.length}:${tip}`;
  } catch {
    return null;
  }
}

/** trace 尾行探测产物：恢复的水位线 + 断尾治疗标记 */
interface TraceTail {
  watermark: string | null;
  /** W5-2：恢复的梦回放独立水位线（尾行携带 dream.watermark 字段；缺席 ⇒ null） */
  dreamWatermark: string | null;
  /** 文件不以换行收尾 ⇒ 追加前须补 '\n'（断尾治疗） */
  needsNewline: boolean;
}

/**
 * 读 trace 尾行恢复持久化水位线（跨进程幂等）。
 * 断尾行容忍（pilotStore replay 同律）：自尾向首找最后一条可解析且携带
 * watermark 的行；半行/垃圾行跳过不炸；文件不存在（ENOENT）= 首睡。
 * W5-2：同一行若携带 dream.watermark（梦回放独立水位线）则一并恢复 ——
 * 主水位线与梦水位线同行同律（跨进程防重复回放）。
 */
function readTail(filePath: string): TraceTail {
  if (!filePath) return { watermark: null, dreamWatermark: null, needsNewline: false };
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return { watermark: null, dreamWatermark: null, needsNewline: false }; // 读故障（含 ENOENT）⇒ 无持久化水位线
  }
  const needsNewline = !text.endsWith('\n');
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as { watermark?: unknown; dream?: { watermark?: unknown } };
      if (obj && typeof obj.watermark === 'string' && obj.watermark) {
        const dw = obj.dream && typeof obj.dream === 'object' && typeof obj.dream.watermark === 'string'
          ? obj.dream.watermark
          : null;
        return { watermark: obj.watermark, dreamWatermark: dw, needsNewline };
      }
    } catch {
      continue; // 断尾/垃圾行：继续向首找
    }
  }
  return { watermark: null, dreamWatermark: null, needsNewline };
}

/** JSONL 追加（目录一次保证 + 断尾治疗；失败上抛由幕的 catch 收敛为 error） */
function appendLine(filePath: string, line: string, healNewline: boolean): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, (healNewline ? '\n' : '') + line + '\n', 'utf8');
}

// ─── 六幕执法（每幕独立 try/catch —— 单幕故障不毒化他幕） ───

/**
 * W5-2（M4 梦回放旁挂）：第①幕的梦面 —— 失败轨迹源 → dreamTrajectories 净化
 * → runDreamReplay 编排（PER 排序 / 同构世界 / 冻结输入重放 / 分歧点双写 /
 * 反事实教训）。旁路律：梦 dep 缺席 ⇒ 零行为变化（不装载梦模块）；任何故障
 * ⇒ 注记吸收（绝不炸回放幕的既有产出）。同步性不变量的 W5-2 修正案：梦是
 * 第一个异步消化面（sharp 合成帧）—— 仅当梦 dep 在场才发生真实挂起，且
 * 逐梦实读睡眠预算（overBudget 条间执法，宁短勿挂）；全部既有 deps 路径
 * 仍为纯同步（零漂移）。梦摘要经 out 旁车带给晨报顶层（approvalQueue 同律）。
 */
async function dreamSidecar(
  deps: SleepDeps,
  cfg: { now: () => number; overBudget: () => boolean; priorDreamWatermark: string | null },
  out: { dream?: DreamReplayReport },
): Promise<void> {
  const dream = deps.dream;
  if (!dream || typeof dream.failures !== 'function') return; // dep 缺席 ⇒ 零行为变化
  const mod = await import('./dreamReplay'); // 懒装载：梦机房只在梦在场时进厂
  let trajectories;
  try {
    trajectories = mod.dreamTrajectories(dream.failures());
  } catch (e) {
    out.dream = {
      watermark: '', attempted: 0, replayed: 0, successes: 0, divergences: 0, lessons: [], entries: [],
      budget: { maxDreams: 0, maxStepsPerDream: 0, truncated: false, reason: 'none' },
      kernelEvidence: [],
      note: `失败轨迹源故障（旁路吸收）：${errText(e)}`,
    };
    return;
  }
  const handle = await mod.runDreamReplay({
    trajectories,
    spectrum: dream.spectrum,
    now: cfg.now,
    overBudget: cfg.overBudget,
    evolution: dream.evolution,
    budget: dream.budget,
    priorWatermark: cfg.priorDreamWatermark,
  });
  out.dream = handle.report;
}

/** ① 回放幕（W5-2 复合幕：回放 + 梦回放）：journal 冲账/结算（链校验 + 决策点
 * 分析 + 可选验收冲账）+ 高优先失败轨迹的 PCG 同构世界梦回放 */
async function actReplay(
  deps: SleepDeps,
  cfg: { now: () => number; overBudget: () => boolean; priorDreamWatermark: string | null },
  out: { dream?: DreamReplayReport },
): Promise<SleepActReport> {
  const j = deps.journal;
  if (!j || typeof j.list !== 'function' || typeof j.verify !== 'function') {
    // journal 缺席：回放本体 skipped —— 但梦回放不依赖 journal（失败记忆是独立源），
    // 照常演出（梦旁挂的诚实独立面；journal 缺席只跳过冲账本体）
    const counts: Record<string, number> = {};
    const notes: string[] = ['journal 缺席 —— 回放幕本体跳过'];
    await dreamSidecar(deps, cfg, out).catch(() => { notes.push('梦回放旁挂故障（旁路吸收）'); });
    if (out.dream) mergeDreamCounts(out.dream, counts);
    return { name: 'replay', status: 'skipped', counts, detail: notes.join('；') };
  }
  const counts: Record<string, number> = {};
  const notes: string[] = [];
  const chain = j.verify(); // B-1 现成面：存活窗口哈希链结算
  counts.entries = numOr0(chain?.length);
  counts.chainOk = chain?.ok === true ? 1 : 0;
  if (chain && chain.ok !== true) notes.push(`链断于第 ${String(chain.brokenAt)} 条`);
  if (typeof j.findDecisionPoints === 'function') { // C-3 现成面：反事实决策点回看
    const dps = j.findDecisionPoints();
    counts.decisionPoints = Array.isArray(dps) ? dps.length : 0;
  }
  const bridge = deps.verdictBridge;
  if (bridge && typeof bridge.settleAll === 'function') { // 可选：D-7 等待室终局冲账
    const settled = bridge.settleAll();
    counts.settled = Array.isArray(settled) ? settled.length : 0;
  }
  // W5-2：梦回放旁挂（复合幕的第二半）—— 故障只注记，不毒化冲账本体产出
  try {
    await dreamSidecar(deps, cfg, out);
    if (out.dream) {
      mergeDreamCounts(out.dream, counts);
      const d = out.dream;
      const head = `梦回放：${d.replayed}/${d.attempted} 条重放（分歧 ${d.divergences}、成功 ${d.successes}、反事实教训 ${d.lessons.length}）`;
      const tail: string[] = [];
      if (d.note) tail.push(d.note);
      if (!d.note && d.budget.truncated) tail.push(`预算截断（${d.budget.reason}）`);
      notes.push(tail.length > 0 ? `${head} —— ${tail.join('；')}` : head);
    }
  } catch (e) {
    notes.push(`梦回放旁挂故障（旁路吸收）：${errText(e)}`);
  }
  return { name: 'replay', status: 'ok', counts, detail: notes.join('；') || undefined };
}

/** W5-2：梦摘要 → 回放幕 counts 的投影（复合幕的量化面） */
function mergeDreamCounts(d: DreamReplayReport, counts: Record<string, number>): void {
  counts.dreams = d.replayed;
  counts.dreamAttempted = d.attempted;
  counts.dreamSuccesses = d.successes;
  counts.dreamDivergences = d.divergences;
  counts.dreamLessons = d.lessons.length;
}

/** ② 蒸馏幕：技能归纳（induceFromJournal 优先；缺席回退 mineMotifs 动机挖掘）
 * + W3-2 反统一模板蒸馏旁挂（distillTemplates 可选面 —— 纯增量，缺席零行为变化） */
function actDistill(deps: SleepDeps): SleepActReport {
  const lib = deps.skillLibrary;
  if (!lib) {
    return { name: 'distill', status: 'skipped', counts: {}, detail: 'skillLibrary 缺席 —— 蒸馏幕跳过' };
  }
  let report: SleepActReport;
  if (typeof lib.induceFromJournal === 'function') {
    // 描述源：最近任务语境（journal.currentTask）；缺席/抛错退缺省描述
    let task = 'sleep:distill';
    try {
      const t = deps.journal?.currentTask?.();
      if (typeof t === 'string' && t.trim()) task = t.slice(0, 120);
    } catch { /* 任务语境是旁路 —— 缺席退缺省 */ }
    const skill = lib.induceFromJournal(task);
    report = {
      name: 'distill', status: 'ok',
      counts: { skills: skill ? 1 : 0 },
      detail: skill ? `归纳技能（${task.slice(0, 40)}）` : '任务切片无可归纳轨迹 —— 零归纳',
    };
  } else if (typeof lib.mineMotifs === 'function') {
    const motifs = lib.mineMotifs();
    const arr = Array.isArray(motifs) ? motifs : [];
    report = { name: 'distill', status: 'ok', counts: { motifs: arr.length } };
  } else {
    return {
      name: 'distill', status: 'skipped', counts: {},
      detail: 'skillLibrary 无归纳面（induceFromJournal/mineMotifs 皆缺席）',
    };
  }
  // W3-2（M2）：反统一模板蒸馏旁挂 —— 主归纳先行（新技能当夜即入配对池），
  // 旁挂失败只注记不回滚主归纳产出（蒸馏是旁路仪式，绝不为一夜好觉失眠）。
  if (typeof lib.distillTemplates === 'function') {
    try {
      const res = lib.distillTemplates();
      const arr = Array.isArray(res) ? res : Array.isArray((res as { created?: unknown })?.created)
        ? (res as { created: unknown[] }).created : [];
      report = { ...report, counts: { ...report.counts, templates: arr.length } };
    } catch (e) {
      const note = `模板蒸馏故障（旁路吸收）：${errText(e)}`;
      report = {
        ...report,
        detail: report.detail ? `${report.detail}；${note}` : note,
      };
    }
  }
  return report;
}

/** ③ 免疫幕：知识库睡眠整合（海马体→皮层） */
function actImmune(deps: SleepDeps): SleepActReport {
  const kb = deps.knowledgeBase;
  if (!kb || typeof kb.consolidate !== 'function') {
    return { name: 'immune', status: 'skipped', counts: {}, detail: 'knowledgeBase 缺席 —— 免疫幕跳过' };
  }
  const r = kb.consolidate();
  if (!r || r.ok !== true) {
    const reason = r?.error && typeof r.error.reason === 'string' ? r.error.reason : '未知原因';
    return { name: 'immune', status: 'error', counts: {}, detail: `consolidate 拒绝：${reason}` };
  }
  const v = r.value;
  return {
    name: 'immune', status: 'ok',
    counts: {
      episodes: numOr0(v?.episodes),
      clusters: numOr0(v?.clusters),
      consolidated: numOr0(v?.consolidated),
      decayed: numOr0(v?.episodedDecayed),
    },
  };
}

// ─── 校准幕（纪元 Ζ 旁挂）：标定建议书 —— 睡眠时才有的离线数据 → 标定原子 ───

/** MC 自举规模（确定性常数：800 次模拟 × ~50 超额 ≪ 睡眠预算，建议书可复现） */
const SLEEP_CALIB_N_SIMS = 800;
/** 自举播种（纪元 Ζ 纪元常数 —— 建议书跨夜跨进程可复现可审计） */
const SLEEP_CALIB_SEED = 20261003;
/** GPD 临界表建议的诚实下限：与 telemetry.GPD_MIN_TAIL 同值（PWM 估计器最小样本） */
const GPD_MIN_TAIL_FOR_ADVICE = 20;
/** Kalman Q/R 建议的诚实下限：与 calibrateKalmanQR 的 8 对下限同源 */
const KALMAN_MIN_PAIRS = 8;

/**
 * journal 同目标坐标序列 → (模型先验, 观测) 漂移对（纯统计投影，绝不抛 ——
 * journal 面故障 ⇒ 空对集，缺席方向诚实；水印线/审计幕各自的 list 故障
 * 报告不因本旁挂重复上报）。
 *
 * 口径申报（诚实边界，advice.source 原样转述）：swarm 的 Kalman 滤波器内部
 * 状态不入 journal —— 无法重演其滤波先验，代用先验 = 该目标该轴**前史漂移
 * 均值**（无状态史的诚实统计量）。序列构造：同 (tool, target) 的连续坐标
 * 剧集 → 漂移 d_t = coord_t − coord_{t−1} → 对 (mean(d_..<t), d_t)；x/y 双轴
 * 与多目标池化（calibrateKalmanQR 本身即各向同性标量滤波口径，池化同律）。
 * 只有带有限 x/y 与非空 target_description 的动作条入序列（无身份的坐标
 * 不构成「同一元素的重定位」证据）。
 */
function kalmanPairsFromJournal(journal?: SleepJournalLike): DriftPair[] {
  if (!journal || typeof journal.list !== 'function') return [];
  let entries: unknown[];
  try {
    const list = journal.list(true); // 动作条（与审计幕同口径）
    entries = Array.isArray(list) ? list : [];
  } catch {
    return []; // 数据面故障 ⇒ 空对集（缺席是诚实方向，不冒充零漂移）
  }
  const series = new Map<string, { xs: number[]; ys: number[] }>();
  for (const raw of entries) {
    const entry = (raw ?? {}) as JournalEntry;
    if (typeof entry.tool !== 'string') continue;
    const args = entry.args && typeof entry.args === 'object' ? entry.args as Record<string, unknown> : {};
    const target = typeof args.target_description === 'string' ? args.target_description.trim() : '';
    if (target === '') continue;
    const x = args.x, y = args.y;
    if (typeof x !== 'number' || !Number.isFinite(x)) continue;
    if (typeof y !== 'number' || !Number.isFinite(y)) continue;
    const key = `${entry.tool}|${target}`;
    let s = series.get(key);
    if (!s) { s = { xs: [], ys: [] }; series.set(key, s); }
    s.xs.push(x); s.ys.push(y);
  }
  const pairs: DriftPair[] = [];
  for (const s of series.values()) {
    for (const coords of [s.xs, s.ys]) {
      if (coords.length < 3) continue; // <3 剧集 ⇒ ≤1 漂移 ⇒ 无先验可均
      const drifts: number[] = [];
      for (let i = 1; i < coords.length; i++) drifts.push(coords[i] - coords[i - 1]);
      for (let t = 1; t < drifts.length; t++) {
        const prior = drifts.slice(0, t).reduce((a, b) => a + b, 0) / t;
        if (Number.isFinite(prior)) pairs.push({ predicted: prior, observed: drifts[t] });
      }
    }
  }
  return pairs;
}

/**
 * 标定建议书铸造（纪元 Ζ）：睡眠时才有的离线数据 → calibration.ts 标定原子
 * → 只建议不落值。接通原子按数据可得性执法，接不上的诚实注记缺什么数据：
 *   · gpdAdCriticalTable ← telemetry.tailReport 统计量（xi + 超额数）：
 *     Monte-Carlo 自举给「本估计器本样本量」的 A² 临界值表，对照 tailReport
 *     的拒绝阈字面量 3.0（fit:'poor' 判定）—— 数据到位 = 换值一行；
 *   · calibrateKalmanQR ← journal 同目标坐标漂移对：对照 swarm 的 KF_Q=1/
 *     KF_R=1（遗忘速率形状）；
 *   · calibrateSchmittEvidence / calibrateNcdThreshold：缺数据在册 ——
 *     弹窗帧 (semantic,geometric,isPopup) 三元组与带标签 (相似度,相关) 检索
 *     回访不入任何台账（先落账后接线，诚实缺席不伪造）。
 * 本函数自身不抛（数据面故障已就地吸收为缺席注记）；原子调用为纯函数 ——
 * 万一抛出由 actCalibrate 的旁挂 catch 收敛为 error 注记。
 */
function buildCalibrationBooklet(deps: SleepDeps): { advice: CalibrationAdvice[]; notes: string[] } {
  const advice: CalibrationAdvice[] = [];
  const notes: string[] = [];

  // 原子① GPD A² 临界值表 ← telemetry 延迟尾统计
  const tel = deps.telemetry;
  let tail: { xi: number; tailCount: number } | null = null;
  if (tel && typeof tel.tailReport === 'function') tail = tel.tailReport();
  if (!tel || typeof tel.tailReport !== 'function') {
    notes.push('gpdAdCriticalTable 缺席：telemetry 统计面不在睡眠依赖（延迟尾数据不可得）');
  } else if (!tail || typeof tail.xi !== 'number' || !Number.isFinite(tail.xi)
    || typeof tail.tailCount !== 'number' || !Number.isFinite(tail.tailCount)
    || tail.tailCount < GPD_MIN_TAIL_FOR_ADVICE) {
    notes.push(`gpdAdCriticalTable 缺席：延迟尾超额不足（需 ≥${GPD_MIN_TAIL_FOR_ADVICE}，诚实不标定）`);
  } else {
    const table = gpdAdCriticalTable({ xi: tail.xi, nSample: tail.tailCount, nSims: SLEEP_CALIB_N_SIMS, seed: SLEEP_CALIB_SEED });
    advice.push({
      atom: 'gpdAdCriticalTable',
      consumer: 'telemetry.tailReport 的 A² 拒绝阈字面量 3.0（fit:"poor" 判定）',
      current: '3.0',
      values: { alpha10: table.alpha10, alpha05: table.alpha05, alpha01: table.alpha01 },
      n: table.nSample,
      source: `telemetry 延迟尾统计（xi=${tail.xi}）Monte-Carlo 自举 nSims=${SLEEP_CALIB_N_SIMS} 播种 ${SLEEP_CALIB_SEED}`,
    });
  }

  // 原子② Kalman Q/R ← journal 同目标坐标漂移对
  const pairs = kalmanPairsFromJournal(deps.journal);
  if (pairs.length < KALMAN_MIN_PAIRS) {
    notes.push(`calibrateKalmanQR 缺席：坐标漂移对不足（${pairs.length}/${KALMAN_MIN_PAIRS}，诚实不标定）`);
  } else {
    const fit = calibrateKalmanQR(pairs);
    if (fit) {
      advice.push({
        atom: 'calibrateKalmanQR',
        consumer: 'swarm 漂移滤波 KF_Q=1/KF_R=1（各向同性标量 Kalman 的遗忘速率形状）',
        current: 'Q/R=1',
        values: { q: fit.q, r: fit.r, ratio: fit.ratio, mse: fit.mse },
        n: fit.n,
        source: `journal 同 (tool,target) 坐标漂移对 ${pairs.length} 对池化（x/y 双轴）；模型先验 = 前史漂移均值（滤波器状态史不入日志的代用统计量）`,
      });
    } else {
      notes.push('calibrateKalmanQR 缺席：净化后有效漂移对不足 8（原子诚实下限拒绝）');
    }
  }

  // 原子③④ 缺数据在册（缝隙登记 —— 先落账后接线，绝不伪造标签喂原子）
  notes.push('calibrateSchmittEvidence 缺席：弹窗帧 (semantic,geometric,isPopup) 三元组不入任何台账');
  notes.push('calibrateNcdThreshold 缺席：带标签 (相似度,是否相关) 检索回访不入任何台账');
  return { advice, notes };
}

/** ④ 校准幕：内核校准 tick（conductor 节流口径优先；缺则 calibrator 直连）
 * + 标定建议书旁挂（纪元 Ζ）+ 记忆操作收敛旁挂（W3-2 第二批接线②）。
 * 两个旁挂共用一条铁律：其故障不回滚 tick 的执法产出（counts 保留），但如实
 * 注记 error/absorb —— 睡眠照常完成，绝不炸宿主。收敛摘要经 out 旁车带给
 * 晨报顶层（SleepReport.memoryOps —— 与 approvalQueue 同一旁车律）。 */
function actCalibrate(deps: SleepDeps, out: { memoryOps?: SleepMemoryOpsSummary } = {}): SleepActReport {
  const viaConductor = deps.conductor && typeof deps.conductor.maybeTick === 'function'
    ? () => (deps.conductor as SleepConductorLike).maybeTick()
    : null;
  const viaCalibrator = deps.calibrator && typeof deps.calibrator.tick === 'function'
    ? () => (deps.calibrator as SleepCalibratorLike).tick()
    : null;
  const tick = viaConductor ?? viaCalibrator;
  if (!tick) {
    return { name: 'calibrate', status: 'skipped', counts: {}, detail: 'conductor/calibrator 缺席 —— 校准幕跳过' };
  }
  const reports = tick();
  const arr = Array.isArray(reports) ? reports : [];
  const counts: Record<string, number> = { calibrations: arr.length };
  try {
    const { advice, notes } = buildCalibrationBooklet(deps);
    counts.recommendations = advice.length;
    const head = advice.length > 0
      ? `标定建议书 ${advice.length} 项在场（睡眠出建议、白天做决定 —— 值不落注册表）`
      : '标定建议书 0 项（数据不足，诚实缺席）';
    const detail = [head, ...notes].join('；');
    const withBooklet: SleepActReport = advice.length > 0
      ? { name: 'calibrate', status: 'ok', counts, detail, calibrationAdvice: advice }
      : { name: 'calibrate', status: 'ok', counts, detail };
    // W3-2 第二批接线②：记忆操作收敛旁挂 —— converger 缺席 ⇒ 零行为变化；
    // 故障 ⇒ 注记吸收（不毒化建议书与 tick 产出）；成功 ⇒ 摘要入 counts +
    // 旁车（晨报顶层 memoryOps 段）。种子契约：集成面投 convergeMemoryOps
    // ({ seed: <journal 水位线> }) —— 同账本态跨夜重放一致。
    const converger = deps.memoryOpsConverger;
    if (typeof converger !== 'function') return withBooklet;
    try {
      const summary = sanitizeMemoryOpsReport(converger());
      if (summary) {
        counts.memoryOpsArms = summary.arms;
        counts.memoryOpsConverged = summary.converged;
        counts.memoryOpsHeld = summary.held;
        out.memoryOps = summary;
        return {
          ...withBooklet,
          detail: `${withBooklet.detail}；记忆操作收敛：${summary.converged}/${summary.arms} 臂落值（${summary.held} 臂反馈不足按兵不动，seed=${summary.seed}）`,
        };
      }
      return { ...withBooklet, detail: `${withBooklet.detail}；记忆操作收敛：报告不可解析（旁路注记）` };
    } catch (e) {
      return { ...withBooklet, detail: `${withBooklet.detail}；记忆操作收敛故障（旁路吸收）：${errText(e)}` };
    }
  } catch (e) {
    return {
      name: 'calibrate', status: 'error', counts,
      detail: `标定建议书故障（旁路吸收，校准 tick 已完成）：${errText(e)}`,
    };
  }
}

/**
 * W3-2 第二批接线②：记忆操作收敛报告净化（防御式 —— 说谎的 dep 不毒化晨报）：
 * 数值走 numOr0、seed 只保字符串（截 100）、明细条目只保结构合法者
 * （key 必须是非空字符串，from/to 有限数值，setOk 布尔，source 截 32）。
 * 整体垃圾 ⇒ undefined（缺席是诚实方向，不伪造零收敛）。
 */
function sanitizeMemoryOpsReport(raw: unknown): SleepMemoryOpsSummary | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<MemoryOpsConvergenceReport>;
  const rawConverged = Array.isArray(r.converged) ? r.converged : [];
  const entries: SleepMemoryOpsSummary['entries'] = [];
  for (const c of rawConverged) {
    if (!c || typeof c !== 'object') continue;
    const key = typeof c.key === 'string' && c.key ? c.key : undefined;
    if (key === undefined) continue;
    entries.push({
      key,
      from: numOr0(c.from),
      to: numOr0(c.to),
      setOk: c.setOk === true,
      source: typeof c.source === 'string' && c.source ? c.source.slice(0, 32) : '',
    });
  }
  const held = Array.isArray(r.held) ? r.held.length : 0;
  return {
    arms: numOr0(r.arms),
    converged: rawConverged.length,
    held,
    seed: typeof r.seed === 'string' && r.seed ? r.seed.slice(0, 100) : '',
    entries,
  };
}

/**
 * 结局分类投影（journal 方言 → StepOutcome 方言）：
 * FAILED ⇒ error；SUCCESS 且 effect_detected===false ⇒ no_effect；SUCCESS ⇒ progress；
 * 其余（UNKNOWN 等无证据结局）保守记 no_effect —— 睡眠审计不把未知诬告成 error。
 */
function outcomeOf(entry: JournalEntry): StepRecord['outcome'] {
  if (entry.status === 'FAILED') return 'error';
  if (entry.status === 'SUCCESS') return entry.effect_detected === false ? 'no_effect' : 'progress';
  return 'no_effect';
}

/**
 * journal 动作流 → 审计轨迹投影（Φ-10 纯函数面的喂食面）。
 * 诚实缺席原则：thought 缺席记空串（OPQ-1 黑箱判据如常生效 —— 不伪造思考）；
 * 日志无风险分层证据 ⇒ riskTier 按良性（睡眠审计不诬告鲁莽）；observe 场景
 * 锚点兼任 snapshotDhash（ABA 往返探测的代理信号 —— 同场景复现即环）。
 * journal 缺席/list 抛错 ⇒ 空轨迹（auditTrajectory 空轨迹免检语义接管）。
 */
function projectJournalToSteps(journal?: SleepJournalLike): StepRecord[] {
  if (!journal || typeof journal.list !== 'function') return [];
  let entries: JournalEntry[];
  try {
    const list = journal.list(true); // 只取动作条 —— MARKER 不参与行为审计
    entries = Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
  return entries.map((raw, i) => {
    const entry = (raw ?? {}) as JournalEntry;
    const args = entry.args && typeof entry.args === 'object'
      ? entry.args as Record<string, unknown> : {};
    const label = typeof args.target_description === 'string' ? args.target_description : undefined;
    // 结构子集铸造：审计只读 kind/target.label/rationale/riskTier 四面（as 收窄）
    const action = {
      kind: (typeof entry.tool === 'string' ? entry.tool : 'unknown') as StepRecord['action']['kind'],
      ...(label !== undefined ? { target: { label } } : {}),
      rationale: typeof entry.thought === 'string' ? entry.thought : '',
      expectedEffect: '',
      utility: 0,
      riskTier: 'benign' as const,
    } as StepRecord['action'];
    return {
      stepIndex: i,
      action,
      outcome: outcomeOf(entry),
      snapshotDhash: typeof entry.observe === 'string' && entry.observe ? entry.observe : null,
      at: typeof entry.ts === 'number' && Number.isFinite(entry.ts) ? entry.ts : 0,
    };
  });
}

/** ⑤ 审计幕：轨迹回看（selfAudit 纯函数面）—— verdict 摘要进晨报 */
function actAudit(deps: SleepDeps): SleepActReport {
  const audit = deps.selfAudit;
  if (typeof audit !== 'function') {
    return { name: 'audit', status: 'skipped', counts: {}, detail: 'selfAudit 缺席 —— 审计幕跳过' };
  }
  const steps = projectJournalToSteps(deps.journal);
  const r = audit(steps);
  const findings = Array.isArray(r?.findings) ? r.findings : [];
  const counts: Record<string, number> = {
    steps: steps.length,
    findings: findings.length,
    critical: findings.filter(f => f?.severity === 'critical').length,
    warn: findings.filter(f => f?.severity === 'warn').length,
  };
  const verdict = r && typeof r.verdict === 'string' ? r.verdict : 'unknown';
  const score = r && typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : 0;
  return { name: 'audit', status: 'ok', counts, detail: `verdict=${verdict} score=${score}` };
}

/** 可用量台账快照（meter 缺席/故障 ⇒ undefined —— 台账是旁路中的旁路） */
function snapshotUsage(meter?: SleepMeterLike): Record<string, number> | undefined {
  if (!meter || typeof meter.summary !== 'function') return undefined;
  try {
    const s = meter.summary();
    if (!s) return undefined;
    return {
      calls: numOr0(s.calls),
      failures: numOr0(s.failures),
      promptTokens: numOr0(s.promptTokens),
      completionTokens: numOr0(s.completionTokens),
    };
  } catch {
    return undefined;
  }
}

/**
 * W2-1（H4）：待批队列摘要净化（防御式 —— 说谎的 dep 不毒化晨报）：
 * 数值走 numOr0、清单条目只保结构合法者（id/description 必须是字符串），
 * 可选证据字段逐个类型校验。dep 故障面（抛错/回垃圾）在调用方收敛为缺席。
 */
function sanitizeQueueSummary(raw: unknown): MorningApprovalQueueSummary | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const rawItems = Array.isArray(r.items) ? r.items : [];
  const items: MorningQueueItem[] = [];
  for (const ri of rawItems) {
    if (!ri || typeof ri !== 'object') continue;
    const it = ri as Record<string, unknown>;
    const id = typeof it.id === 'string' && it.id ? it.id : undefined;
    const description = typeof it.description === 'string' && it.description ? it.description.slice(0, 200) : undefined;
    if (id === undefined || description === undefined) continue;
    items.push({
      id,
      description,
      enqueuedAt: numOr0(it.enqueuedAt),
      expiresAt: numOr0(it.expiresAt),
      ttlExpired: it.ttlExpired === true,
      ...(typeof it.riskTier === 'string' && it.riskTier ? { riskTier: it.riskTier.slice(0, 32) } : {}),
      ...(typeof it.actionTool === 'string' && it.actionTool ? { actionTool: it.actionTool.slice(0, 64) } : {}),
      ...(typeof it.screenshotRef === 'string' && it.screenshotRef ? { screenshotRef: it.screenshotRef.slice(0, 200) } : {}),
      ...(typeof it.sceneFingerprint === 'string' && it.sceneFingerprint ? { sceneFingerprint: it.sceneFingerprint.slice(0, 100) } : {}),
    });
  }
  return {
    pending: numOr0(r.pending),
    expired: numOr0(r.expired),
    grantedAwaitingResume: numOr0(r.grantedAwaitingResume),
    deniedAwaitingPrune: numOr0(r.deniedAwaitingPrune),
    items,
  };
}

// ─── 主编排：runSleepCycle（永不抛铁律） ───

/**
 * 认知睡眠周期（纪元 Υ）：六幕离线整合 + 幂等水位线 + 晨报落盘。
 *
 * 返回 SleepReport，绝不 reject、绝不 throw —— 任何内部故障（含本编排器自身
 * 的意外 bug）都收敛为诚实报告条目。deps/config 全部可选：空 deps 睡出一份
 * 全 skipped 的晨报（睡眠本身永远完成，哪怕无事可做）。
 */
export async function runSleepCycle(deps: SleepDeps = {}, config: SleepConfig = {}): Promise<SleepReport> {
  const now = typeof config.now === 'function' ? config.now : () => Date.now();
  const rawBudget = config.budgetMs;
  const budgetMs = typeof rawBudget === 'number' && Number.isFinite(rawBudget) && rawBudget >= 0
    ? rawBudget : DEFAULT_SLEEP_BUDGET_MS;
  const log = typeof deps.log === 'function' ? deps.log : ((m: string) => { console.log(m); });
  const startedAt = safeNow(now);

  try {
    const tracePath = typeof config.sleepTracePath === 'string' ? config.sleepTracePath : '';
    const tail = readTail(tracePath);
    const persisted = inMemoryWatermark ?? tail.watermark; // 内存优先，trace 尾行补跨进程
    const current = computeWatermark(deps.journal);

    // 幂等水位线：同一状态二睡 ⇒ 六幕全 noop（零依赖调用、零落盘 —— 零新增严格义）
    if (current !== null && current === persisted) {
      log('[Sleep] 水位线未前移 —— 本轮睡眠零新增（六幕 noop）。');
      return {
        startedAt,
        durationMs: Math.max(0, safeNow(now) - startedAt),
        watermark: current,
        timeout: false,
        acts: SIX_ACTS.map(name => ({ name, status: 'noop' as const, counts: {} })),
      };
    }

    const acts: SleepActReport[] = [];
    // W3-2 第二批接线②的旁车：校准幕收敛摘要带给晨报顶层（approvalQueue 同律）；
    // W5-2 的旁车：梦回放摘要（第①幕复合幕产出）同律带给晨报顶层
    const sidecars: { memoryOps?: SleepMemoryOpsSummary; dream?: DreamReplayReport } = {};
    const overBudget = (): boolean => safeNow(now) - startedAt > budgetMs;
    // W5-2：幕体可为异步（梦回放的 sharp 面）—— 逐幕顺序 await（幕序不变、
    // 半程检查不变）；全同步 deps 下 await 只是微任务直落，「触发即完成主体」
    // 的同步性不变量对既有路径逐字节保持（梦是唯一申报的异步消化面）。
    const step = async (name: string, fn: () => SleepActReport | Promise<SleepActReport>): Promise<void> => {
      if (overBudget()) { // 宁短勿挂：预算耗尽的幕不再演，标记后继续铸半程报告
        acts.push({ name, status: 'timeout', counts: {}, detail: `睡眠预算 ${budgetMs}ms 耗尽 —— 半程报告（宁短勿挂）` });
        return;
      }
      try {
        acts.push(await fn());
      } catch (e) {
        acts.push({ name, status: 'error', counts: {}, detail: errText(e) });
      }
    };

    // W5-2：梦回放独立水位线（内存优先，trace 尾行补跨进程）—— 防重复回放的锚
    const priorDreamWatermark = inMemoryDreamWatermark ?? tail.dreamWatermark;
    await step('replay', () => actReplay(deps, { now, overBudget, priorDreamWatermark }, sidecars));
    await step('distill', () => actDistill(deps));
    await step('immune', () => actImmune(deps));
    await step('calibrate', () => actCalibrate(deps, sidecars));
    await step('audit', () => actAudit(deps));

    // ⑥ 晨报幕：用量快照 + W2-1 待批清单 + JSONL 落盘 + 水位线前滚
    let usage: Record<string, number> | undefined;
    let approvalQueueSummary: MorningApprovalQueueSummary | undefined;
    await step('report', () => {
      usage = snapshotUsage(deps.meter);
      const counts: Record<string, number> = {};
      const notes: string[] = [];
      // W2-1（H4）：待批队列清单 —— 晨报的核心新增消费面。旁路律：dep 缺席 ⇒
      // 清单缺席（诚实，不伪造空清单）；摘要故障 ⇒ 注记吸收，绝不炸晨报落盘。
      const q = deps.approvalQueue;
      if (q && typeof q.pendingSummary === 'function') {
        try {
          const summary = sanitizeQueueSummary(q.pendingSummary());
          if (summary !== undefined) {
            approvalQueueSummary = summary;
            counts.queuePending = summary.pending;
            counts.queueExpired = summary.expired;
            counts.queueGrantedAwaiting = summary.grantedAwaitingResume;
            notes.push(`待批队列：${summary.pending} 项待批（另 ${summary.expired} 项已过期须重走完整审批）、` +
              `${summary.grantedAwaitingResume} 项已批待续跑 —— 批注式批量裁决见 adjudicate_approval_queue`);
          }
        } catch (e) {
          notes.push(`待批队列摘要故障（旁路吸收）：${errText(e)}`);
        }
      }
      if (!tracePath) {
        return {
          name: 'report', status: 'ok', counts,
          detail: ['sleepTracePath 空 —— 仅内存水位线', ...notes].join('；') || undefined,
        };
      }
      // 行内六幕齐全：晨报幕以乐观条目入行（appendFileSync 失败 ⇒ 行未写成，
      // 返回报告由 step 的 catch 纠正为 error；半写断行由读方容忍）
      const optimistic: SleepActReport = {
        name: 'report', status: 'ok',
        counts: { ...counts, appended: 1 },
        ...(notes.length > 0 ? { detail: notes.join('；') } : {}),
      };
      const line = JSON.stringify({
        type: 'sleep',
        startedAt,
        watermark: current,
        timeout: acts.some(a => a.status === 'timeout'),
        acts: [...acts, optimistic],
        ...(usage ? { usage } : {}),
        ...(approvalQueueSummary !== undefined ? { approvalQueue: approvalQueueSummary } : {}),
        // W3-2 第二批接线②：收敛摘要随晨报行落盘（重放的钥匙 seed 在场）
        ...(sidecars.memoryOps !== undefined ? { memoryOps: sidecars.memoryOps } : {}),
        // W5-2：梦回放摘要随晨报行落盘（dream.watermark 是跨进程梦水位线的锚）
        ...(sidecars.dream !== undefined ? { dream: sidecars.dream } : {}),
      });
      try {
        appendLine(tracePath, line, tail.needsNewline);
      } catch (e) {
        throw new Error(`晨报落盘失败：${errText(e)}`);
      }
      return optimistic;
    });

    // 水位线前滚（内存面无条件；磁盘面已随行 —— append 失败时下次进程重睡，
    // 宁可重复归纳（签名去重只强化可靠度）不可漏睡）
    inMemoryWatermark = current;
    // W5-2：梦回放独立水位线前滚（只在梦摘要真实在场时 —— noop/缺席/故障不动账；
    // 磁盘面随晨报行 —— 下次进程经 readTail 恢复，同一失败集不再重复回放）
    if (sidecars.dream !== undefined && sidecars.dream.watermark) {
      inMemoryDreamWatermark = sidecars.dream.watermark;
    }

    const durationMs = Math.max(0, safeNow(now) - startedAt);
    const timedOut = acts.some(a => a.status === 'timeout');
    log(`[Sleep] 晨报（${durationMs}ms）：${acts.map(a => `${a.name}=${a.status}`).join(' ')}`);
    return {
      startedAt, durationMs, watermark: current, timeout: timedOut, acts,
      ...(usage ? { usage } : {}),
      ...(approvalQueueSummary !== undefined ? { approvalQueue: approvalQueueSummary } : {}),
      ...(sidecars.memoryOps !== undefined ? { memoryOps: sidecars.memoryOps } : {}),
      ...(sidecars.dream !== undefined ? { dream: sidecars.dream } : {}),
    };
  } catch (e) {
    // 永不抛铁律的最后一道闸：编排器自身的意外故障也收敛为诚实报告
    log(`[Sleep] 睡眠周期意外故障（已吞，绝不炸宿主）：${errText(e)}`);
    return {
      startedAt,
      durationMs: Math.max(0, safeNow(now) - startedAt),
      watermark: null,
      timeout: false,
      acts: [{ name: 'sleep', status: 'error', counts: {}, detail: errText(e) }],
    };
  }
}
