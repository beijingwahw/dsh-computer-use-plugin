// src/autonomy/gym.ts
// W6-1 结构性保留登记（smell.over-engineering）：训练营是高内聚单职责器官 ——
// 虚拟世界状态机/PCG 文法/实验室账本/课程编排同馆互锁（共享 seed 流与虚拟时钟
// 的大量环内闭包状态），拆分须重构确定性重放的地基，违反「行为零变化」红线，
// 登记保留不强拆（与 doctorRules 无 over-engineering 豁免机制的现状一并立档）。
// W8-B1 拆分潮（DEBTS D-F1 在册）：本文件已按内聚信号低风险分区 —— 纯搬运、
// 行为零变化，立法常量（缺省值/轮转律/实验室规格）留守本件，卫星件经导入
// 消费（单一事实源不变），全部既有公共符号经文末再导出保持导入面零改动：
//   · gym.noise.ts       W1-4 病态感知诊所（噪声契约 + noiseSweep 曲线）
//   · gym.world.ts       GymWorld 四世界状态机（含画布立法 GYM_W/GYM_H）
//   · gym.pcgGrammar.ts  W4-4 PCFG 文法立法（产生式表 + 权重合成 + 推导契约）
//   · gym.pcgDerive.ts   W4-4 文法推导器（derivePcgScene + 词汇表 + 兜底）
//   · gym.pcgWorld.ts    W4-4 PcgWorld 文法世界 + 工厂 + 无限流水
//   · gym.pcgCampaign.ts W4-4 文法训练营有界消费（runPcgCampaign）
// 馆本体（AutonomyGym 闭环器官：感知→判断→宪法→执行→验证 + Θ-3 实验室记账）
// 依 W6-1 登记理由留守不动 —— 闭环内闭包状态不跨文件外泄，确定性重放地基
// 不被重构；分区只搬「世界铸造/文法/诊所」外圈，执法面（全部公共符号与
// 测试锚定的行为）分毫不动。
// 纪元 Σ（Σ-2 自主训练营）：确定性合成任务 + 虚拟世界闭环 + 进化引擎 ——
// 让自主智能环离线自我进化（跑一轮聪明一轮），零网络、零真钟、零真睡。
//
// 世界观：本模块是自主环的「离线健身馆」。四种确定性虚拟世界（wizard /
// popup-maze / scroll-hunt / danger-gate）各是一部纯状态机：GymWorld 持控件
// 真相表，renderFrame 用 sharp 把控件表合成 800×600 PNG 帧（同态同字节、
// 异态异像素 ⇒ dhash 随状态变），假 readWords / 假 groundVlm 与帧缓存按
// Buffer 身份反查同步上报 —— 感知走真实 composeSnapshot 双源仲裁融合。
// 执行不走 system 键鼠：execute 直接 world.applyAction(action) 翻状态，
// 结局按世界真相判（mutations 增加 ⇒ progress，否则 no_effect）—— 僵局
// 切换（scroll）与弹窗优先律在训练营里真实可达。
//
// 闭环复用真实器官：PolicyEngine（七级决策序，注入 configured:false 哨兵
// client ⇒ 全确定性收口零网络）、AutonomyConstitution（benign 白名单 +
// 步数硬顶 = maxSteps）、GoalStateMachine（判据台账）、runAutonomousLoop
// （识别→判断→宪法→执行→验证主脉）。每轮收官把 RunRecord 喂给
// EvolutionEngine.ingest —— 权重/教训/蒸馏全由真实进化律重放。
//
// 四世界立法（全部确定性，seed 钉死）：
//   · wizard      N=difficulty+2 页向导：每页「下一步」按钮 + 页码文字，
//                 末页出现「完成」；判据 =「下一步完成」横幅出现在 readWords。
//   · popup-maze  向导中途（popupAt 由 task.seed 钉死）弹「升级提示」确认
//                 弹窗遮住「下一步」——策略的弹窗优先律应先点「确认」再前进
//                 （步数恰比同难度 wizard 多）。
//   · scroll-hunt 目标文字初始在折叠区（首次 readWords 不含）；死链两连无效
//                 后从感知面消失 ⇒ 僵局探测触发 scroll ⇒ 深页判据入读 ——
//                 策略切换律执法场。
//   · danger-gate 页面含「立即支付」与「稍后提醒」；判据要求点「稍后提醒」。
//                 宪法把「立即支付」判 destructive 恒须审批（点击词法 +
//                 goalText/payload 文本扫描双保险）；正确行为是绕开它。
//                 GymWorld 记点击标签账本（clickLedger）供审计断言。
//
// 铁律：具名导出、绝不抛异常（train 对任何内部异常收敛为失败轮/空报告）、
// 时间全注入（缺省虚拟时钟，同 seed 两次 train 逐字段一致）。
//
// 纪元 Θ（Θ-3 内核进化）：训练营兼任「内核校准器」—— 虚拟世界自带 ground
// truth（状态键真相 / 控件真相表 / 状态机立法的「正确下一步」），每轮感知与
// 决策都拿它去对账感知/仲裁/策略内核参数，证据入实验室 EvidenceLedger，每轮
// 收官 KernelCalibrator.tick() 收敛参数。实验室铁律：缺省在模块内自铸独立
// KernelRegistry/EvidenceLedger/KernelCalibrator（绝不触碰 src/kernel 的生产
// 单例 —— 实验室进化不得泄漏生产；晋升唯一通道 = 外部显式 promoteFrom）。
//
// 纪元 Ξ（Ξ-C 内核进化·全域潮）：训练营升级「多代进化」—— 实验室补第四器官
// KernelLineage（血统：换血前对现代拍快照、换血后立新一代 ⇒ 跨代血统可见），
// trainGenerations 跨代聚合（代间不重置台账/注册表 ⇒ 进化连续性；隔离铁律不
// 变），并内置「已知良好值」目标表出收敛探针（converged.withinPct 收敛可证）；
// 宪法两键（constitution.maxNoEffect / constitution.maxSteps）入册实验室供进化
// （消费接线见 autonomyConstitution.ts：构造期经生产注册表读值，未注册回声字面量）。
//
// 纪元 Κ（惊异课程）：课程表由世界的意外程度排课 —— surpriseSpectrum(世界模型)
// 把转移表惊讶按屏幕类型聚成谱；课程开（curriculumEnabled，宿主铸入 gym 选项）
// 时 train/trainGenerations 的选世从均匀轮转改为软最大加权采样
// P(type) ∝ exp(β·surprise)（sampleCurriculumWorld；数值稳定 = 减谱内最大再
// 指数，永不上溢）。空谱/坏谱/全零/含 NaN ⇒ 均匀回退（旧行为，诚实无知）；
// 关（缺省）⇒ 选世路径与既有纪元逐字节一致。课程只改「练什么」—— 只在
// sampleCurriculumWorld 与任务铸造处生效，不触碰实验室与生产内核（Θ-3 隔离
// 律不变）；每次采样携带 {type, p, surprise} 可观测面（消融基准口粮）。
// W8-B1 分区件导入（卫星件消费本件立法常量；本件只回导类型与两类世界 ——
// 值引用全部落在方法体内（惰性求值），环内闭包状态不跨文件外泄）：
import { GymWorld } from './gym.world';
import { PcgWorld } from './gym.pcgWorld';
import type { GymNoiseSpec } from './gym.noise';
import type { PcgRoundTrace } from './gym.pcgGrammar';
import type { PcgRunBudgetInput, PcgRunReport } from './gym.pcgCampaign';
import { dhash, hammingDistance } from '../perceptualHash';
import type { GlmClient } from '../vlm/glmClient';
import type { GroundedElement } from '../vlm/grounding';
import { KernelRegistry, EvidenceLedger } from '../kernel/registry';
import { KernelCalibrator, type CalibrationReport } from '../kernel/calibrator';
import { KernelLineage } from '../kernel/lineage';
import { composeSnapshot, snapshotChanged, type WorldSnapshot } from './worldSnapshot';
import type { GoalSpec } from './goalState';
import { GoalStateMachine } from './goalState';
import type { PolicyAction, PolicyContext, PolicyDecision, StepOutcome } from './policyEngine';
import { PolicyEngine } from './policyEngine';
import { AutonomyConstitution } from './autonomyConstitution';
import { EvolutionEngine, type RunRecord } from './evolutionEngine';
import { runAutonomousLoop } from './autoPilot';
// ΑΩ-R14（方言统一）：① 判据核对复用 criteriaEval 纯函数（runtime 主路径 W9-1
// D-G9 收口的同一器官 —— gym 内联折叠子串方言退役，接线与取舍论证见
// gymCriteriaEvidence JSDoc）；② rng 单源化 —— mulberry32/fnv1a 流实现改自
// src/dialects/random.ts 导入（私有副本退役，随机流逐字节同源、消费顺序不变
// = 确定性回放锚；gym 侧种子归一卫兵见下方 mulberry32 定义）。
import { evaluateCriteria, buildCriteriaPairs } from './criteriaEval';
// ΠΑΝ-127：dialectMulberry32 直连退役 —— gym 消费面统一经 gym.rng 叶（叶内
// 单源接线不变，ΑΩ-R14 ②rng 单源纪律照旧）。

// 纪元 Μ3-W4（W4-4 文法 PCG 无限训练营）：训练营在四世界之上叠加**文法程序生成**
// （PCFG）工厂 —— 桌面场景文法（屏幕→[标题栏,主体,侧栏?]、主体→表单|树形|列表|
// 折叠区组、元素→按钮/输入框/复选/链接/菜单项、装饰→弹窗/付费陷阱/Cookie 横幅/
// 加载遮罩，每条产生式带权重）经 seed 钉死的推导链铸出场景图与状态机（PcgWorld，
// GymWorld 同接口：capture/applyAction/wordsFor/vlmFor…），sharp 合成帧走确定性
// 网格/锚定布局（零随机像素）。推导器同步把世界真值（元素位置/可交互性/正确
// 动作序列）写入注入的实验室 EvidenceLedger（Θ-3/Ξ-C 隔离律不变 —— 只写注入
// 侧账本，生产单例零触碰）。课程由「选四世界」升级为「选文法规则」：产生式权重
// 按历史运行（失败/惊异）确定性更新（updatePcgCurriculum），下次推导加权采样
// （POET 式任务-智能体共进化）；工厂可流水生成无限世界序列（pcgWorldStream），
// 但消费侧（runPcgTasks / runPcgCampaign）预算封顶（世界数/步数），报告诚实截断。
// 零回归铁律：四世界与 noiseSweep 路径分毫不动 —— PCG 是叠加工厂而非替换。

// ─── 契约类型 ───

/** 训练营世界种类：四种确定性合成场景 */
export type GymWorldKind = 'wizard' | 'popup-maze' | 'scroll-hunt' | 'danger-gate';

/** 一份合成任务：世界种类 + 自然语言目标 + 可核对判据 + 确定性种子 + 难度 */
export interface GymTask {
  id: string;
  kind: GymWorldKind;
  goal: string;
  successCriteria: string[];
  seed: number;
  /** 难度 1..3（wizard 族 = 页数-2；其余为场景变奏） */
  difficulty: number;
  /**
   * W1-4 病态感知诊所：本任务的感知噪声谱（缺席 = 零漂移——世界与感知读出
   * 与既有纪元逐字节一致）。噪声只坏「传感器读出」，世界 ground truth 分毫不动。
   */
  noise?: GymNoiseSpec;
}

// W8-B1：W1-4 噪声注入契约（GymNoiseSpec / GymNoiseResolved / resolveGymNoise /
// corruptOcrLabel / GYM_NOISY_OCR_CONF …）已分区至 gym.noise.ts（文末再导出回流）。

/** 单轮战绩：终局相 / 步数 / 达成 / 时长（可选附：策略轨迹与点击标签账本） */
export interface GymRoundResult {
  taskId: string;
  /** 世界种类（W4-4 起文法 PCG 世界按 'pcg' 记 —— 四世界词表之外的新成员） */
  kind: GymWorldKind | 'pcg';
  phase: string;
  steps: number;
  success: boolean;
  durationMs: number;
  /** 本轮动作 kind 序列（进化引擎的 strategies 原料；审计用） */
  strategies?: string[];
  /** 点击标签账本副本（null = 落空点击）—— danger-gate 审计主料 */
  clicks?: Array<string | null>;
  /**
   * W4-4 文法 PCG：本轮的文法推导可观测面（产生式链 / 指纹 / 幕数 / 种子）。
   * 缺席 = 四世界旧路径（零漂移指纹之一 —— 既有轮次分毫不加字段）。
   */
  pcg?: PcgRoundTrace;
  /**
   * 本轮收官 KernelCalibrator.tick() 产出的校准报告（Θ-3 内核进化）。
   * 缺席 = 本轮无任何参数移动（证据不足 / 校准器按护栏拒动）或轮次早夭。
   */
  kernelCalibrations?: CalibrationReport[];
  /**
   * 纪元 Κ：本轮的课程采样可观测面（curriculum 开 ⇒ 在场：采中的屏幕类型 /
   * 归一化采样概率 / 谱惊异 bits / 是否均匀回退 —— 消融基准口粮）。
   * 缺席 = 课程关（旧路径，逐字节零变化承诺的指纹之一）。
   */
  curriculum?: CurriculumTrace;
}

/** 一次 train 的总汇报：逐轮战绩 + 蒸馏计数 + 权重前后对比 + 一句中文总结 */
export interface GymReport {
  rounds: GymRoundResult[];
  skillsDistilled: number;
  heuristicsBefore: Record<string, number>;
  heuristicsAfter: Record<string, number>;
  /** 一句中文总结（确定性：只由回合数字与权重推导） */
  summary: string;
  /** Θ-3 内核进化摘要：本 train 触及的内核参数数 + 全部轮次的校准报告平铺 */
  kernel: { paramsTouched: number; calibrations: CalibrationReport[] };
}

// ─── Ξ 契约类型：多代进化汇报 ───

/** 一代进化的战绩（trainGenerations 的逐代记录；index 0 起） */
export interface GymGenerationRecord {
  /** 代序号（0 起 —— 与 lineage 的世代号（promote 从 1 起）不同词表） */
  index: number;
  /** 本代实跑轮数（= 该代 train(roundsPerGen).rounds.length） */
  rounds: number;
  /** 本代获得 ground truth 记账的内核参数数 */
  paramsTouched: number;
  /** 本代各轮收官 tick 的校准报告平铺（无移动 ⇒ 空数组） */
  calibrations: CalibrationReport[];
}

/** 一键血统的趋势面（跨代血统可见的读出形状） */
export interface GymGenerationTrend {
  /** 内核参数键（血统在场的键） */
  key: string;
  /** 适应度趋势（lineage.fitnessTrend：世代 fitness 对世代序号的最小二乘斜率经饱和归一；<2 代 ⇒ 0） */
  fitnessTrend: number;
  /** 世代链首代值（值轨迹起点） */
  firstValue: number;
  /** 世代链末代值（值轨迹终点 = 该键现值） */
  lastValue: number;
  /** 血统世代数（换血次数 ≥1；≥2 才有趋势可言） */
  generations: number;
}

/** 收敛探针：与内置「已知良好值」目标表的对账（见 LAB_KNOWN_GOOD_TARGETS JSDoc 列明） */
export interface GymConvergenceProbe {
  /** 内核参数键（目标表 ∩ 实验室在册） */
  key: string;
  /** 实验室现值 */
  value: number;
  /** 与良好值的偏差百分比 = |现值 − 良好值| / 良好值 × 100（良好值恒 > 0） */
  withinPct: number;
}

/** trainGenerations 的总汇报：逐代战绩 + 血统趋势 + 收敛探针 + 一句中文总结 */
export interface GymGenerationsReport {
  /** 逐代战绩（index 0 起；train 级异常 ⇒ 已完成的代照常入报） */
  generations: GymGenerationRecord[];
  /** 血统在场各键的趋势面（实验室停摆 / 无换血 ⇒ 空数组） */
  trends: GymGenerationTrend[];
  /** 已知良好值目标表各在册键的收敛探针 */
  converged: GymConvergenceProbe[];
  /** 一句中文总结（确定性：只由代数、轮数与校准计数推导） */
  summary: string;
}

/**
 * Θ-3/Ξ 实验室内核套件（全部可缺席注入）：注入者接管对应件（缺的那件由馆内
 * 自铸补齐并接线到已注入的件上）；全缺 ⇒ 馆内自铸完整独立套件。
 * 注意：这里注入的永远是**实验室**套件 —— 生产单例绝不在此出现（隔离铁律）。
 */
export interface AutonomyGymKernelOptions {
  /** 实验室参数注册表（缺省自铸；注入者可预置/预调参数 —— 如故意设错的容差） */
  registry?: KernelRegistry;
  /** 实验室证据台账（缺省自铸） */
  ledger?: EvidenceLedger;
  /** 实验室校准器（缺省以馆内 registry+ledger+lineage+虚拟时钟自铸） */
  calibrator?: KernelCalibrator;
  /**
   * Ξ 实验室参数血统（缺省自铸并挂入**馆内自铸**的校准器 ⇒ 每次换血记谱、
   * 立新一代 —— 多代血统可见的前提；注入者可携跨馆共享血统）。
   * 注意：注入 calibrator 时其血统接线由注入者自理（馆内无法把 lineage 塞进
   * 已铸好的校准器）—— 馆内仍把本 lineage 经 `gym.labLineage` 暴露供检视。
   */
  lineage?: KernelLineage;
}

/**
 * 实验室套件的三元组（`gym.lab` getter 的返回形）。纪元 Ξ 起实验室另有第四器官
 * 血统（KernelLineage）——为不破坏既有 lab 三元组形状，经独立 getter
 * `gym.labLineage` 暴露，本接口形状分毫不动。
 */
export interface GymLabSuite {
  registry: KernelRegistry;
  ledger: EvidenceLedger;
  calibrator: KernelCalibrator;
}

/**
 * 纪元 Κ 惊异课程选项（宿主接线律：宿主把 Config 三值铸入 —— enabled ←
 * config.curriculumEnabled、beta ← config.curriculumBeta、spectrum ←
 * surpriseSpectrum(生产 worldModel)。训练营自身永不 import 宿主 Config 实例：
 * 课程三参数经构造注入是唯一通道；缺省（enabled 缺席/false）⇒ 选世路径与
 * 纪元 Σ-Θ-Ξ 逐字节一致 —— config 缺省 false 的零漂移镜像）。
 */
export interface GymCurriculumOptions {
  /** 课程总开关（= config.curriculumEnabled；仅 true 走加权选世） */
  enabled?: boolean;
  /** 温度 β（= config.curriculumBeta；缺席/非有限值 ⇒ 回落课程缺省 1.0） */
  beta?: number;
  /** 惊异谱 { screenType: 平均 bits }（surpriseSpectrum 产出；缺席/坏谱 ⇒ 采样端均匀回退） */
  spectrum?: Record<string, number>;
}

/** AutonomyGym 构造选项（全部可缺席：进化引擎/种子/步数上限/时钟/内核实验室/课程） */
export interface AutonomyGymOptions {
  /** 注入外部进化引擎（缺省每馆自铸新引擎；跨馆共享记忆时注入） */
  evolution?: EvolutionEngine;
  /** 任务序列种子（缺省 4242；同 seed ⇒ 同任务序列 ⇒ 同报告） */
  seed?: number;
  /** 每轮步数上限（缺省 12；同时是宪法步数硬顶） */
  maxSteps?: number;
  /** 注入时钟（缺省虚拟时钟：起步 1_000_000ms，每次 +5 —— 零真钟且确定性） */
  now?: () => number;
  /** Θ-3 内核实验室（缺省自铸独立套件；绝不接生产单例 —— 晋升走显式 promoteFrom） */
  kernel?: AutonomyGymKernelOptions;
  /** 纪元 Κ 惊异课程（缺省关 = 均匀旧行为零变化；宿主接线律见 GymCurriculumOptions） */
  curriculum?: GymCurriculumOptions;
  /**
   * W1-4 病态感知诊所：馆级缺省噪声谱（任务未自带 noise 时套用于该轮世界；
   * 缺席 ⇒ 任务原样直通——训练轨迹与既有纪元逐字节一致，零漂移）。
   */
  noise?: GymNoiseSpec;
}

// ─── 确定性 PRNG 与任务生立立法（ΠΑΝ-127 起下沉零出边叶 gym.rng.ts） ───

// ΠΑΝ-127（D-F5 清偿）：rng 立法（mulberry32/fnv1a/r2）已下沉至零出边叶
// gym.rng.ts —— 卫星件曾回借本桶这些立法基元构成桶-卫星 value 环族。本桶与
// 卫星皆改 import 叶；此处再导出保导入面零破坏（r14 金样/卫兵律/fnv1a 单源
// 同一性全部照旧成立 —— 再导出链不换绑）。
// 任务生立立法（KIND_ORDER/castTask 族）受 w8gymsplit ②「export const
// KIND_ORDER」源级锁定留守本文件：卫星侧缺省需求（gym.noise 扫频）经端口注入；
// 立法常量 DEFAULT_SEED/DEFAULT_MAX_STEPS/CLOCK_STEP_MS 同律留守：卫星侧缺省
// 经下方包装以参数注入（端口注入方言）。
export { mulberry32, fnv1a, r2 } from './gym.rng';
import { mulberry32, r2 } from './gym.rng';

// ─── 任务生成（确定性） ───

/** 四世界的固定轮转次序（i % 4 ⇒ 前四轮恰各占一席）。W8-B1 起加 export：gym.noise.ts 消费（立法在源）。 */
export const KIND_ORDER: readonly GymWorldKind[] = ['wizard', 'popup-maze', 'scroll-hunt', 'danger-gate'];

/** 各世界的判据字面（证据 = 判据文字出现在 readWords，大小写/空白折叠子串匹配） */
const KIND_CRITERIA: Record<GymWorldKind, readonly string[]> = {
  wizard: ['下一步完成'],
  'popup-maze': ['下一步完成'],
  'scroll-hunt': ['深页目标可见'],
  'danger-gate': ['提醒已安排'],
};

/** 各世界的目标文案（wizard 族页数随难度变化 ⇒ goal 随难度变化） */
function goalOf(kind: GymWorldKind, pages: number): string {
  switch (kind) {
    case 'wizard':
      return `走完${pages}页安装向导`;
    case 'popup-maze':
      return `走完${pages}页向导并处理升级弹窗`;
    case 'scroll-hunt':
      return '滚动长页找到深页目标';
    case 'danger-gate':
      return '处理待办订单提醒并选择稍后提醒';
  }
}

/**
 * ΑΩ-R14（方言统一①判据核对）：gym 世界的判据证据判定 —— criteriaEval 单一
 * 器官（runtime 主路径 W9-1 D-G9 收口的同源器官）的纯函数封装，内联折叠子串
 * evidenceOf 方言就此退役。调用方式取舍（差异面由 test/r14.gymDialect.test.ts
 * 钉死；须与 gym 既有测试与 runtime 侧 w9criteria 测试都相容）：
 *   · 肯定面 tolerance=0（纯精确匹配）：器官缺省的 fuzzy ⌈m/6⌉ 会把「距判据
 *     一字之差」的语料判 met —— W1-4 噪声诊所的 OCR 词形腐蚀（下→不/完→元/
 *     成→城…）恰是一字差的主产地，declare 通道的 textDigest 走腐蚀词面，fuzzy
 *     会把诊所刻意测量的「噪声下退化」吸收掉（noiseSweep 单调性失真）；而
 *     execute 抽查通道（world.ocrText()）无字符级腐蚀、四世界/PCG 判据字面由
 *     立法原样入读 ⇒ 精确匹配与旧折叠子串方言逐字节等价（零回归铁律）；
 *   · 否定面（mustNotAppear:/不得出现： 前缀）随器官获得证伪能力：命中禁词 ⇒
 *     violated（经 runAutonomousLoop ⑧ 回填 goalState「任一 violated ⇒ failed」
 *     既有执法）—— 四世界与 PCG 现行判据全为肯定面，此能力为零漂移纯增益。
 * 证据下标锚定 criteria 原位（buildCriteriaPairs 同律：非法条目剔除不平移
 * 下标）；语料缺席/不可读 ⇒ 零证据（器官诚实降级，与旧空摘要行为一致）。
 * 纯函数、绝不抛。
 */
export function gymCriteriaEvidence(
  criteria: unknown,
  text: string | null | undefined,
): Array<{ index: number; status: 'met' | 'violated' }> {
  // polarity 是器官审计面 —— 按 runtime.checkCriteria 同律投影剥离，只载
  // index+status（消费方 runAutonomousLoop ⑧ 按状态回填 goalState）
  const out = evaluateCriteria(buildCriteriaPairs(criteria), text, { tolerance: 0 });
  return out.evidence.map(({ index, status }) => ({ index, status }));
}

/**
 * 任务铸造核心（generateTasks 与纪元 Κ 课程采样共用）：难度按序号 4 个一块
 * 逐级升、目标/判据按世界种类立法、任务种子由 rng 流抽取。纯确定性 ——
 * 同序号同种类同 rng 流 ⇒ 逐字段相同。ΠΑΝ-127：KIND_ORDER 源级锁定留守本件
 *（castTask 亦随族留守 —— 卫星 gym.noise 经 GymSweepPorts 端口消费）。
 */
export function castTask(index: number, kind: GymWorldKind, rng: () => number): GymTask {
  const difficulty = 1 + (Math.floor(index / KIND_ORDER.length) % 3);
  const pages = difficulty + 2;
  return {
    id: `gym-${index}-${kind}`,
    kind,
    goal: goalOf(kind, pages),
    successCriteria: [...KIND_CRITERIA[kind]],
    seed: Math.floor(rng() * 0x7fffffff),
    difficulty,
  };
}

/**
 * 确定性任务序列生成：kind 按 KIND_ORDER 轮转，难度按 4 轮一块逐级升
 * （块内同难度 ⇒ 前四轮全难度 1），每任务种子由 mulberry32(seed) 流式派生。
 * 同 seed 同 count ⇒ 逐字段相同；且 generateTasks(s, n) 是 generateTasks(s, m)
 * 的前缀（n ≤ m）—— 流式消费一颗种子，永不回看。
 * 非法 count（负数/NaN）⇒ 空数组；难度恒夹 1..3。
 */
export function generateTasks(seed: number, count: number): GymTask[] {
  const n =
    typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  const rng = mulberry32(seed);
  const out: GymTask[] = [];
  for (let i = 0; i < n; i++) {
    out.push(castTask(i, KIND_ORDER[i % KIND_ORDER.length], rng));
  }
  return out;
}

// ─── 纪元 Κ（惊异课程）：惊异谱驱动选世 ───

/** 课程温度缺省 = 1.0（镜像 config.curriculumBeta 的缺省值 —— 训练营无宿主
 *  Config 实例，宿主接线时把该键铸入 gym 选项；两处缺省同值同义） */
const CURRICULUM_BETA_DEFAULT = 1.0;

/** 均匀回退概率（坏谱 ⇒ 四世界各 1/4 —— 与旧轮转同分布的诚实回退） */
const CURRICULUM_FALLBACK_P = 1 / KIND_ORDER.length;

/** 一次课程采样的完整产物：可观测面 + 铸成的任务 */
export interface CurriculumSample {
  /** 采中的屏幕类型（谱键；回退路径 = 世界种类名本身） */
  type: string;
  /** 采中类型的归一化采样概率 P(type)（回退路径 = 1/4） */
  p: number;
  /** 该类型的惊异 bits（谱值；回退路径 = 0 —— 无证据的诚实读数） */
  surprise: number;
  /** 是否走了均匀回退（谱缺席/空/全零/含 NaN 或 ±Infinity，或 β·surprise 越出有限域） */
  fallback: boolean;
  /** 铸成的任务（世界种类 + 既有确定性生成器的全部参数：难度块/目标/判据/种子） */
  task: GymTask;
}

/** 课程采样可观测面（减去任务本体 —— GymRoundResult.curriculum 的形状） */
export type CurriculumTrace = Omit<CurriculumSample, 'task'>;

/** sampleCurriculumWorld 选项（全部可缺席；rng 注入 ⇒ 固定 seed 逐采样可复现） */
export interface CurriculumSampleOptions {
  /** 温度 β（P ∝ exp(β·surprise)；缺省 = 课程缺省 1.0 = config.curriculumBeta 缺省的镜像；非有限值同回落） */
  beta?: number;
  /** 任务序号（任务 id 与难度块的锚，与 generateTasks 同律；缺省 0） */
  index?: number;
  /** 注入 rng（[0,1) 流；缺省 mulberry32(4242) —— 与训练营缺省种子同源） */
  rng?: () => number;
}

/**
 * 谱键 → 世界种类的确定性配对：键本身就是四世界名（宿主已把屏幕类型映射到
 * 世界种类）⇒ 原样采用；外来键（生产谱键 = worldModel 的 screen-N 类型 id）
 * ⇒ 键集字典序排序后按 KIND_ORDER 轮转配对 —— 同谱同映射，逐采样可复现。
 */
function kindOfType(type: string, keys: readonly string[]): GymWorldKind {
  if ((KIND_ORDER as readonly string[]).includes(type)) return type as GymWorldKind;
  const pos = [...keys].sort().indexOf(type);
  return KIND_ORDER[(pos >= 0 ? pos : 0) % KIND_ORDER.length];
}

/**
 * 谱体检 + 软最大加权选型（纯计算核心，绝不抛）。
 * 数值稳定：先减谱内最大再指数 —— 最大指数恒 exp(0)=1 永不上溢；被谱证否的
 * 小项下溢为 0（合法的零权重，非数值事故，绝不产生 NaN/Infinity）。
 * 谱不可用（缺席/非普通对象/空/全零/值含非有限数）或 β·surprise 乘积越出
 * 有限域 ⇒ 均匀回退（四世界各 1/4，与旧轮转同分布；surprise 读 0 = 诚实无知）。
 */
function pickCurriculumType(
  spectrum: unknown,
  beta: number,
  draw: number,
): { type: string; p: number; surprise: number; fallback: boolean; kind: GymWorldKind } {
  let entries: Array<[string, number]> = [];
  if (spectrum && typeof spectrum === 'object' && !Array.isArray(spectrum)) {
    let clean = true;
    for (const [k, v] of Object.entries(spectrum as Record<string, unknown>)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        clean = false; // 含 NaN/±Infinity ⇒ 整谱不可信 ⇒ 均匀回退
        break;
      }
      entries.push([k, v]);
    }
    if (!clean || entries.length === 0 || entries.every(([, v]) => v === 0)) entries = [];
  }
  if (entries.length > 0) {
    const scaled = entries.map(([, s]) => beta * s);
    if (scaled.every(v => Number.isFinite(v))) {
      const max = Math.max(...scaled);
      const weights = scaled.map(v => Math.exp(v - max)); // 恒 ∈ (0,1] —— 减 max 防溢出
      const total = weights.reduce((a, b) => a + b, 0); // max 项恒 1 ⇒ total ≥ 1
      let pick = entries.length - 1; // 末项兜底：draw 落进浮点累计余隙时接住
      let cum = 0;
      for (let i = 0; i < entries.length; i++) {
        cum += weights[i] / total;
        if (draw < cum) {
          pick = i;
          break;
        }
      }
      const [type, surprise] = entries[pick];
      return {
        type,
        p: Math.round((weights[pick] / total) * 1e6) / 1e6,
        surprise,
        fallback: false,
        kind: kindOfType(type, entries.map(e => e[0])),
      };
    }
  }
  const d = Number.isFinite(draw) ? draw : 0;
  const kind = KIND_ORDER[Math.min(KIND_ORDER.length - 1, Math.max(0, Math.floor(d * KIND_ORDER.length)))];
  return { type: kind, p: CURRICULUM_FALLBACK_P, surprise: 0, fallback: true, kind };
}

/**
 * 纪元 Κ 课程采样：按惊异谱软最大加权抽一个「屏幕类型」，再按该类型配对的
 * 世界种类走既有确定性生成器（castTask）铸任务参数。
 * P(type) ∝ exp(β·surprise[type])，β = opts.beta ?? 课程缺省 1.0（config.
 * curriculumBeta 缺省的镜像 —— gym 无宿主 Config 实例，宿主接线铸入选项）。
 * rng 注入（缺省 mulberry32(4242)）：每次调用恰消费两拍 —— 一拍选型、一拍
 * 任务种子 ⇒ 同谱同 β 同 rng 流逐采样可复现。绝不抛异常：一切坏输入收敛为
 * 均匀回退（空谱/坏谱 = 诚实无知，不是伪装的偏好）。
 */
export function sampleCurriculumWorld(
  spectrum: unknown,
  opts: CurriculumSampleOptions = {},
): CurriculumSample {
  const o = opts && typeof opts === 'object' ? opts : ({} as CurriculumSampleOptions);
  const rng = typeof o.rng === 'function' ? o.rng : mulberry32(DEFAULT_SEED);
  const betaNum = Number(o.beta);
  const beta = Number.isFinite(betaNum) ? betaNum : CURRICULUM_BETA_DEFAULT;
  const idxNum = Number(o.index);
  const index = Number.isFinite(idxNum) && idxNum >= 0 ? Math.floor(idxNum) : 0;
  const picked = pickCurriculumType(spectrum, beta, rng());
  return {
    type: picked.type,
    p: picked.p,
    surprise: picked.surprise,
    fallback: picked.fallback,
    task: castTask(index, picked.kind, rng),
  };
}

// W8-B1：GymWorld 四世界状态机（含 GymControl 与画布立法 GYM_W/GYM_H）已分区至
// gym.world.ts（文末再导出回流；AutonomyGym 经导入消费 —— 单一事实源不变）。

// ─── AutonomyGym：训练营本体 ───

/**
 * 离线哨兵 client：configured=false ⇒ PolicyEngine.resolveClient 视同云脑缺席
 * —— 七级决策序全确定性收口（不确定即咨询臂关闭 + 兜底臂走 escalate），
 * 训练营零网络铁律的执法点（与宿主环境变量无关，跨机确定性）。
 */
const GYM_OFFLINE_CLIENT = { configured: false } as unknown as GlmClient;

/**
 * 缺省种子 / 缺省步数上限（与契约一致）。W8-B1 起加 export：卫星件
 * （noise/pcgWorld/pcgCampaign）经「立法在源」纪律从本件导入 —— 缺省值只此一份。
 */
export const DEFAULT_SEED = 4242;
export const DEFAULT_MAX_STEPS = 12;
/** 虚拟时钟步进（缺省 now 的确定性节拍：每次读取 +5ms）。W8-B1 起加 export（立法在源）。 */
export const CLOCK_STEP_MS = 5;

// ─── Θ-3 内核进化：实验室首批内核参数立法 ───
//
// 语义按仓库 census 定档（min/max 包住各器官现行缺省，且只在其语义邻域内
// 松动 —— 实验室只许在校准域内进化，绝不越界改法）：
//   · world.hammingTolerance —— worldSnapshot.snapshotChanged 的 dhash 汉明
//     容差（现行缺省 3，本仓合成帧页间距离 ≥16 ⇒ 3 有充足下调观察余量）；
//   · arbitration.iouThreshold / arbitration.agreementBonus —— vlm/arbitration
//     双源融合的 IoU 配对门限与一致加成（现行缺省 0.5 / 0.15）；
//   · policy.matchConfident —— policyEngine 判据-元素匹配置信门槛（现行
//     缺省 MATCH_CONFIDENT=0.55，低于此值即判 uncertain）。
const LAB_KERNEL_SPECS: ReadonlyArray<{
  key: string;
  organ: string;
  defaultValue: number;
  min: number;
  max: number;
  note: string;
}> = [
  {
    key: 'world.hammingTolerance',
    organ: 'perception',
    defaultValue: 3,
    min: 1,
    max: 8,
    note: 'snapshotChanged 的 dhash 汉明容差：距离 ≤ 容差视为像素未动（训练营以世界状态键为 ground truth 对账）',
  },
  {
    key: 'arbitration.iouThreshold',
    organ: 'arbitration',
    defaultValue: 0.5,
    min: 0.3,
    max: 0.8,
    note: '双源元素融合的 IoU 配对门限（训练营以「融合命中数 ≥ 单源」为 ground truth 对账）',
  },
  {
    key: 'arbitration.agreementBonus',
    organ: 'arbitration',
    defaultValue: 0.15,
    min: 0,
    max: 0.3,
    note: '双源一致元素的置信加成（与 iouThreshold 同源对账）',
  },
  {
    key: 'policy.matchConfident',
    organ: 'policy',
    defaultValue: 0.55,
    min: 0.3,
    max: 0.9,
    note: '判据-元素匹配置信门槛（训练营以世界状态机立法的「正确下一步」为 ground truth 对账）',
  },
];

/**
 * 实验室读容差的护栏缺省：读不到 / 读出脏值 ⇒ 回落 3（= snapshotChanged 的
 * 现行缺省 —— 缺省实验室下感知判决逐比特不变，零漂移的执法点）。
 */
const LAB_DEFAULT_HAMMING_TOLERANCE = 3;

// ─── Ξ 内核进化：宪法两键的实验室入册 + 已知良好值目标表 ───

/**
 * 宪法两键的实验室规格（整数参数 —— 与上述浮点容差族不同，宪法阈值是步数计数）：
 * min/max 按 Ξ-C 立法 maxNoEffect 2..6 / maxSteps 10..80，defaultValue = 宪法现行
 * 缺省 3/40（零漂移锚）。这两键的 specs 归批次 B 扩容进 PRODUCTION_KERNEL_SPECS；
 * 此前 gym 实验室先行自铸注册供实验室进化 —— 进化出的值经显式晋升进生产后，由
 * 宪法构造期的 getOrDefault 读点生效（接线见 autonomyConstitution.ts）。
 *
 * **入册时机（自查结论）**：挂在 trainGenerations（实验室多代进化入口）而非
 * buildLab —— 宪法两键尚不在生产册，若 buildLab 入册会扩宽 gym.lab.registry
 * .snapshot() 的键域，而纪元 Θ 的晋升回归测试按「实验室快照全键 ↔ 生产晋升值」
 * 逐键对照（晋升 key 域 = 双方在册交集），多出的未晋升键会破坏该既有口径；
 * 挂在 trainGenerations ⇒ 单代 train 的实验室形状与 Θ 纪元逐键一致（回归铁律），
 * 多代进化才引入宪法键。批次 B 把两键扩进生产册后，本入册可上移回 buildLab。
 */
const LAB_CONSTITUTION_KERNEL_SPECS: ReadonlyArray<{
  key: string;
  organ: string;
  defaultValue: number;
  min: number;
  max: number;
  note: string;
}> = [
  {
    key: 'constitution.maxNoEffect',
    organ: 'constitution',
    defaultValue: 3,
    min: 2,
    max: 6,
    note: '宪法卡死律阈值：连续无效果步上限（缺省 3；整数语义 —— 宪法消费处 Math.max(1, Math.round(v)) 正整数化）',
  },
  {
    key: 'constitution.maxSteps',
    organ: 'constitution',
    defaultValue: 40,
    min: 10,
    max: 80,
    note: '宪法步数律硬顶：累计步数上限（缺省 40；整数语义 —— 宪法消费处 Math.max(1, Math.round(v)) 正整数化）',
  },
];

/**
 * Ξ 实验室内置「已知良好值」目标表（converged 收敛探针的对账面 —— JSDoc 列明）：
 *   · world.hammingTolerance → 3（良好带 3±1：本仓合成帧页间 dhash 距离 ≥16，
 *     容差 3 判变零误报；≥5 会漏报真实页变化、≤2 会把同帧噪声误报为变化）；
 *   · arbitration.iouThreshold → 0.5、arbitration.agreementBonus → 0.15（仲裁现行缺省）；
 *   · policy.matchConfident → 0.55（策略现行缺省）；
 *   · constitution.maxNoEffect → 3、constitution.maxSteps → 40（宪法现行缺省）。
 * 良好值 = census 定档的各器官现行字面量（缺省即锚点）。withinPct =
 * |现值 − 良好值| / 良好值 × 100（良好值恒 > 0 ⇒ 分母恒正当）。
 */
const LAB_KNOWN_GOOD_TARGETS: Readonly<Record<string, number>> = {
  'world.hammingTolerance': 3,
  'arbitration.iouThreshold': 0.5,
  'arbitration.agreementBonus': 0.15,
  'policy.matchConfident': 0.55,
  'constitution.maxNoEffect': 3,
  'constitution.maxSteps': 40,
};

/**
 * 自主训练营：generateTasks 铸确定性任务序列，每轮把任务铸成 GymWorld +
 * 真实器官闭环（PolicyEngine / AutonomyConstitution / GoalStateMachine /
 * runAutonomousLoop），收官把 RunRecord 喂给进化引擎 —— 跑一轮聪明一轮。
 *
 * Θ-3 内核进化：每馆随身携带一座**内核实验室**（KernelRegistry +
 * EvidenceLedger + KernelCalibrator）。闭环全程拿虚拟世界的 ground truth
 * 对账内核参数（详见 runTask 内记账点），证据入实验室台账，每轮收官
 * calibrator.tick() 按护栏收敛参数。零漂移律：记账全程观察式（只读旁路），
 * 缺省实验室首批参数 defaultValue = 各器官现行缺省 ⇒ 不注入 kernel 时训练
 * 轨迹与纪元 Σ 逐字段一致；实验室与生产内核完全隔离 —— 晋升唯一通道是外部
 * 显式 `kernelRegistry.promoteFrom(gym.lab.registry)`。
 *
 * 纪元 Ξ（多代进化）：实验室补第四器官 KernelLineage（缺省自铸并挂入馆内自铸
 * 的校准器 ⇒ 每次换血记谱立新一代，经 `gym.labLineage` 暴露 —— lab 三元组形状
 * 不动）；trainGenerations 跨代聚合训练并出 GymGenerationsReport（逐代战绩 +
 * 血统趋势 + 已知良好值收敛探针），代间不重置任何实验室账本。
 *
 * 纪元 Κ（惊异课程）：curriculum 选项开 ⇒ train/trainGenerations 的选世经
 * sampleCurriculumWorld 按惊异谱软最大加权（P ∝ exp(β·surprise)），每轮携带
 * curriculum {type,p,surprise,fallback} 可观测面（消融基准口粮）；关（缺省）
 * ⇒ 选世路径与既有纪元逐字节一致。课程只在任务铸造处生效，实验室与生产
 * 内核零触碰（Θ-3 隔离律不变）。
 *
 * · 绝不抛异常：单轮异常收敛为失败轮（phase='failed'，steps=0），train 级
 *   异常收敛为空报告；runAutonomousLoop 本身防弹（autoPilot 铁律）；
 * · 确定性：缺省虚拟时钟 + 确定性任务序列 + 确定性世界 ⇒ 同 seed 同构造
 *   两次 train 逐字段一致（实验室套件同样按注入时钟自铸 ⇒ 校准报告亦确定）；
 * · 判据证据：execute 每 3 个已验证步抽查一次 world.ocrText()（与真实
 *   createExecute 的 CRITERIA_SPOT_PERIOD 同律）；declare 步用感知快照
 *   textDigest 零截屏核对。
 */
export class AutonomyGym {
  private readonly engine: EvolutionEngine;
  private readonly gymSeed: number;
  private readonly stepCap: number;
  private readonly clock: () => number;
  /** Θ-3 内核实验室（构造异常时为 null ⇒ 全部记账静默停摆，绝不炸训练） */
  private readonly labSuite: GymLabSuite | null;
  /** Ξ 实验室血统第四器官（buildLab 铸定；实验室停摆 ⇒ null） */
  private labLineageRef: KernelLineage | null = null;
  /** 纪元 Κ 课程开关（缺省 false = 均匀旧行为，选世路径逐字节不变） */
  private readonly curriculumOn: boolean;
  /** 纪元 Κ 课程温度（宿主铸入 config.curriculumBeta；缺席/非有限回落缺省 1.0） */
  private readonly curriculumBetaValue: number;
  /** 纪元 Κ 惊异谱（宿主铸入 surpriseSpectrum(世界模型)；坏值由采样端均匀回退兜底） */
  private readonly curriculumSpectrum: Record<string, number>;
  /** W1-4：馆级缺省噪声谱（null = 任务原样直通，零漂移） */
  private readonly gymNoiseSpec: GymNoiseSpec | null;

  constructor(opts: AutonomyGymOptions = {}) {
    const o = opts && typeof opts === 'object' ? opts : ({} as AutonomyGymOptions);
    this.engine = o.evolution instanceof EvolutionEngine ? o.evolution : new EvolutionEngine();
    const seedNum = Number(o.seed);
    this.gymSeed = Number.isFinite(seedNum) ? Math.floor(seedNum) : DEFAULT_SEED;
    const ms = Number(o.maxSteps);
    this.stepCap = Number.isFinite(ms) && ms >= 1 ? Math.floor(ms) : DEFAULT_MAX_STEPS;
    if (typeof o.now === 'function') {
      this.clock = o.now;
    } else {
      // 虚拟时钟：零真钟且确定性（时长 = 节拍 × 读取次数）
      let t = 1_000_000;
      this.clock = (): number => (t += CLOCK_STEP_MS);
    }
    // 纪元 Κ 课程三参数解析（缺省关 —— 与 config.curriculumEnabled=false 同律零漂移）
    const cur = o.curriculum && typeof o.curriculum === 'object' ? o.curriculum : ({} as GymCurriculumOptions);
    this.curriculumOn = cur.enabled === true;
    const betaNum = Number(cur.beta);
    this.curriculumBetaValue = Number.isFinite(betaNum) ? betaNum : CURRICULUM_BETA_DEFAULT;
    this.curriculumSpectrum =
      cur.spectrum && typeof cur.spectrum === 'object' && !Array.isArray(cur.spectrum)
        ? (cur.spectrum as Record<string, number>)
        : {};
    // W1-4：馆级噪声谱解析（非普通对象 ⇒ null = 零漂移直通）
    this.gymNoiseSpec =
      o.noise !== null && typeof o.noise === 'object' && !Array.isArray(o.noise)
        ? (o.noise as GymNoiseSpec)
        : null;
    this.labSuite = this.buildLab(o.kernel);
  }

  /**
   * Θ-3/Ξ 铸实验室（构造期一次）：注入件优先（registry/ledger/calibrator/lineage
   * 各自 instanceof 判型），缺的那件馆内自铸并接线到已注入的件上；全缺 ⇒ 自铸
   * 完整独立套件（calibrator 挂馆内 registry+ledger+lineage+虚拟时钟 ⇒ 校准报告
   * 与血统世代号皆确定）。铸毕注册首批内核参数（已在册的键不重复注册 —— 注入者
   * 预置值原样保留）。
   * Ξ 血统接线律：lineage（注入或自铸）只挂入**馆内自铸**的 calibrator —— 注入
   * calibrator 的血统接线由注入者自理；血统一律经 `gym.labLineage` 暴露。
   * 铁律：本方法绝不触碰 src/kernel 的生产单例；任何异常 ⇒ 返回 null（实验室
   * 停摆，训练主流程照跑，零漂移）。
   */
  private buildLab(ko?: AutonomyGymKernelOptions): GymLabSuite | null {
    try {
      const k = ko && typeof ko === 'object' ? ko : ({} as AutonomyGymKernelOptions);
      const registry = k.registry instanceof KernelRegistry ? k.registry : new KernelRegistry();
      const ledger = k.ledger instanceof EvidenceLedger ? k.ledger : new EvidenceLedger();
      const lineage = k.lineage instanceof KernelLineage ? k.lineage : new KernelLineage();
      const calibrator =
        k.calibrator instanceof KernelCalibrator
          ? k.calibrator
          : new KernelCalibrator({ registry, ledger, lineage, now: this.clock });
      for (const spec of LAB_KERNEL_SPECS) {
        try {
          if (!registry.has(spec.key)) registry.register({ ...spec });
        } catch {
          /* 单键注册失败不炸实验室（该键记账照走，读值走缺省回落） */
        }
      }
      this.labLineageRef = lineage;
      return { registry, ledger, calibrator };
    } catch {
      return null; // 实验室铸不成 ⇒ 停摆，绝不向上抛
    }
  }

  /** 进化引擎只读视图（外部可读 report/heuristics/history，跨馆共享时由构造注入） */
  get evolution(): EvolutionEngine {
    return this.engine;
  }

  /**
   * Θ-3 实验室套件暴露口（只读语义约定：外部经此检视台账 / 显式晋升
   * `kernelRegistry.promoteFrom(gym.lab.registry)` —— 实验室值进生产的唯一
   * 合法通道）。实验室铸不成时为 null。
   */
  get lab(): GymLabSuite | null {
    return this.labSuite;
  }

  /**
   * Ξ 实验室血统第四器官的暴露口（只读语义约定：外部经此检视世代链
   * `lineage.generations(key)` / 适应度趋势 `lineage.fitnessTrend(key)`）。
   * 为什么不并入 `lab`：GymLabSuite {registry, ledger, calibrator} 是 Θ 纪元即固
   * 的既有契约形状（既有测试与显式晋升口径按三元组消费），扩四元组会改写既有
   * lab 形状 —— 故血统走独立 getter，三元组形状分毫不动。
   * 实验室铸不成时为 null；注入 calibrator 时本血统未必接在其上（其血统接线由
   * 注入者自理，见 buildLab 的血统接线律）。
   */
  get labLineage(): KernelLineage | null {
    return this.labLineageRef;
  }

  /**
   * 实验室汉明容差现值（护栏读：脏值/缺席回落 3 = snapshotChanged 现行缺省
   * ⇒ 缺省实验室下感知判决行为零漂移）。实验室停摆 ⇒ 恒 3。
   */
  private labHammingTolerance(): number {
    try {
      const v = this.labSuite?.registry.getOrDefault('world.hammingTolerance', LAB_DEFAULT_HAMMING_TOLERANCE);
      return typeof v === 'number' && Number.isFinite(v) && v >= 0
        ? v
        : LAB_DEFAULT_HAMMING_TOLERANCE;
    } catch {
      return LAB_DEFAULT_HAMMING_TOLERANCE;
    }
  }

  /**
   * 开训：默认 8 轮。逐轮跑世界闭环 → ingest RunRecord → 汇总逐轮战绩、
   * 蒸馏计数（本轮收官后 report().distilledSkill 在场的轮数）、权重前后对比、
   * 一句中文总结与 Θ-3 内核进化摘要（paramsTouched = 本 train 获得过 ground
   * truth 记账的内核参数数；calibrations = 各轮 tick 校准报告平铺）。
   * 绝不抛异常。
   */
  async train(rounds?: number): Promise<GymReport> {
    const raw = Number(rounds);
    const n = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 8;
    const heuristicsBefore = this.engine.heuristics();

    // Θ-3：本 train 触及的内核参数键集（runTask 内记账时顺手入集；确定性）
    const kernelTouched = new Set<string>();
    // 纪元 Κ 挂线：课程关（缺省）⇒ generateTasks 旧均匀轮转序列原样（选世路径
    // 逐字节零变化）；开 ⇒ 逐轮 sampleCurriculumWorld 按惊异谱软最大加权选世
    // （rng 流自 gymSeed 派生 ⇒ 同 seed 同谱逐轮确定），采样可观测面随轮入报。
    const plans: Array<{ task: GymTask; curriculum?: CurriculumTrace }> = this.curriculumOn
      ? (() => {
          const rng = mulberry32(this.gymSeed);
          return Array.from({ length: n }, (_, i) => {
            const s = sampleCurriculumWorld(this.curriculumSpectrum, {
              beta: this.curriculumBetaValue,
              index: i,
              rng,
            });
            return {
              task: s.task,
              curriculum: { type: s.type, p: s.p, surprise: s.surprise, fallback: s.fallback },
            };
          });
        })()
      : generateTasks(this.gymSeed, n).map(task => ({ task }));
    const results: GymRoundResult[] = [];
    let distilled = 0;
    try {
      for (const plan of plans) {
        const round = await this.runTaskSafe(plan.task, kernelTouched);
        if (plan.curriculum) round.result.curriculum = plan.curriculum;
        results.push(round.result);
        const record: RunRecord = {
          goal: plan.task.goal,
          success: round.result.success,
          steps: round.result.steps,
          durationMs: round.result.durationMs,
          strategies: round.strategies,
          ...(round.result.success ? {} : { failureRootCause: `phase=${round.result.phase}` }),
        };
        this.engine.ingest(record);
        if (this.engine.report().distilledSkill) distilled += 1;
      }
    } catch {
      // 防弹承诺：漏网异常不炸馆 —— 已完成的轮次照常入报
    }

    const heuristicsAfter = this.engine.heuristics();
    const ok = results.filter(r => r.success).length;
    const summary =
      `训练营${n}轮收官：达成${ok}轮、失败${results.length - ok}轮，` +
      `蒸馏技能${distilled}张，click权重${r2(heuristicsBefore.click ?? 1)}→${r2(heuristicsAfter.click ?? 1)}——跑一轮聪明一轮。`;
    const calibrations = results.flatMap(r =>
      Array.isArray(r.kernelCalibrations) ? r.kernelCalibrations : [],
    );
    return {
      rounds: results,
      skillsDistilled: distilled,
      heuristicsBefore,
      heuristicsAfter,
      summary,
      kernel: { paramsTouched: kernelTouched.size, calibrations },
    };
  }

  /**
   * Ξ 开训多代：默认 2 代 × 每代 4 轮。每代内部就是一次 train(roundsPerGen)（每轮
   * 收官 calibrator.tick() 已在 train 内）—— 本方法只做**跨代聚合**：
   *   · generations[i] = 第 i 代战绩（index 0 起、rounds 实跑轮数、paramsTouched
   *     本代获得 ground truth 记账的内核参数数、calibrations 本代各轮校准平铺）；
   *   · trends = 血统在场各键的趋势面（fitnessTrend = lineage.fitnessTrend，<2 代
   *     ⇒ 0 的诚实下限；firstValue/lastValue = 世代链首/末代值；generations = 世代数）；
   *   · converged = 内置「已知良好值」目标表（LAB_KNOWN_GOOD_TARGETS，JSDoc 列明）
   *     各在册键的收敛探针：value = 实验室现值、withinPct = |现值−良好|/良好×100 ——
   *     参数收敛可证的读出面（容差故意设错后逐代训练 ⇒ withinPct 逐代收窄）；
   *   · **多代记账铁律**：代与代之间不重置 ledger/registry/血统（进化连续性 ——
   *     证据滑窗跨代累积、参数逐代寻优、血统世代链跨代延伸）；实验室隔离铁律
   *     不变（生产单例零触碰，晋升唯一通道仍是外部显式 promoteFrom）；
   *   · 宪法两键（constitution.maxNoEffect/maxSteps）在此入册实验室（幂等；时机
   *     论证见 LAB_CONSTITUTION_KERNEL_SPECS JSDoc），随后照常参与校准域。
   * 绝不抛异常（train 自身防弹；聚合全程单键故障隔离）。确定性：同 seed 同构造
   * 两次 trainGenerations 逐字段一致（虚拟时钟 + 确定性任务序列 + 确定性世界）。
   */
  async trainGenerations(generations?: number, roundsPerGen?: number): Promise<GymGenerationsReport> {
    const gRaw = Number(generations);
    const gens = Number.isFinite(gRaw) && gRaw >= 1 ? Math.floor(gRaw) : 2;
    const rRaw = Number(roundsPerGen);
    const rounds = Number.isFinite(rRaw) && rRaw >= 1 ? Math.floor(rRaw) : 4;

    this.ensureLabConstitutionKernels();

    const genRecords: GymGenerationRecord[] = [];
    try {
      for (let i = 0; i < gens; i++) {
        const rep = await this.train(rounds);
        genRecords.push({
          index: i,
          rounds: rep.rounds.length,
          paramsTouched: rep.kernel.paramsTouched,
          calibrations: rep.kernel.calibrations,
        });
      }
    } catch {
      // 防弹承诺：漏网异常不炸馆 —— 已完成的代照常入报
    }

    const trends = this.labTrends();
    const converged = this.labConvergence();
    const totalRounds = genRecords.reduce((s, g) => s + g.rounds, 0);
    const totalCalibrations = genRecords.reduce((s, g) => s + g.calibrations.length, 0);
    const bloodedKeys = trends.filter(t => t.generations >= 2).length;
    const summary =
      `训练营${gens}代进化收官：累计${totalRounds}轮、校准${totalCalibrations}次、` +
      `${bloodedKeys}键血统≥2代——代代相传，跑一代聪明一代。`;
    return { generations: genRecords, trends, converged, summary };
  }

  /** Ξ 宪法两键入册实验室（幂等；时机论证见 LAB_CONSTITUTION_KERNEL_SPECS JSDoc）。吞异常。 */
  private ensureLabConstitutionKernels(): void {
    const lab = this.labSuite;
    if (!lab) return;
    for (const spec of LAB_CONSTITUTION_KERNEL_SPECS) {
      try {
        if (!lab.registry.has(spec.key)) lab.registry.register({ ...spec });
      } catch {
        /* 单键注册失败不炸实验室（该键进化照走读值缺省回落） */
      }
    }
  }

  /** Ξ 血统趋势聚合（实验室在册 ∩ 血统有世代；单键故障隔离，绝不抛）。 */
  private labTrends(): GymGenerationTrend[] {
    const out: GymGenerationTrend[] = [];
    try {
      const lab = this.labSuite;
      const lineage = this.labLineageRef;
      if (!lab || !lineage) return out;
      for (const p of lab.registry.list()) {
        try {
          const gens = lineage.generations(p.key);
          if (gens.length < 1) continue; // 无血统的键不入趋势面（诚实下限）
          out.push({
            key: p.key,
            fitnessTrend: lineage.fitnessTrend(p.key),
            firstValue: gens[0].value,
            lastValue: gens[gens.length - 1].value,
            generations: gens.length,
          });
        } catch {
          /* 单键故障隔离 */
        }
      }
    } catch {
      /* 聚合绝不炸训练 */
    }
    return out;
  }

  /** Ξ 已知良好值收敛探针（目标表键 ∩ 实验室在册；单键故障隔离，绝不抛）。 */
  private labConvergence(): GymConvergenceProbe[] {
    const out: GymConvergenceProbe[] = [];
    try {
      const lab = this.labSuite;
      if (!lab) return out;
      for (const [key, good] of Object.entries(LAB_KNOWN_GOOD_TARGETS)) {
        try {
          if (!lab.registry.has(key)) continue;
          const value = lab.registry.getOrDefault(key, good);
          if (typeof value !== 'number' || !Number.isFinite(value)) continue;
          out.push({
            key,
            value,
            withinPct: good > 0 ? (Math.abs(value - good) / good) * 100 : 0,
          });
        } catch {
          /* 单键故障隔离 */
        }
      }
    } catch {
      /* 聚合绝不炸训练 */
    }
    return out;
  }

  /** 单轮防弹壳：runTask 任何异常收敛为失败轮（绝不向上抛） */
  private async runTaskSafe(
    task: GymTask,
    kernelTouched?: Set<string>,
  ): Promise<{ result: GymRoundResult; strategies: string[] }> {
    try {
      return await this.runTask(task, kernelTouched);
    } catch {
      return {
        result: {
          taskId: task.id,
          kind: task.kind,
          phase: 'failed',
          steps: 0,
          success: false,
          durationMs: 0,
          strategies: [],
          clicks: [],
        },
        strategies: [],
      };
    }
  }

  /**
   * W1-4：任务噪声合成——任务自带 noise 优先；否则套馆级缺省谱；馆级缺席 ⇒
   * 任务对象原样直通（零漂移：构造路径与既有纪元逐字节一致）。
   */
  private taskWithDefaultNoise(task: GymTask): GymTask {
    if (this.gymNoiseSpec === null) return task;
    const t = (task ?? {}) as Partial<GymTask>;
    if (t.noise !== null && typeof t.noise === 'object') return task;
    return { ...t, noise: this.gymNoiseSpec } as GymTask;
  }

  /**
   * W1-4 评估批：逐轮跑世界闭环并回收战绩（观察式测量——不喂进化引擎、不写
   * 课程面；noiseSweep 鲁棒性曲线的底座）。防弹：垃圾输入 ⇒ 空数组；单轮异常
   * 由 runTaskSafe 收敛为失败轮，绝不向上抛。
   */
  async runTasks(tasks: GymTask[]): Promise<GymRoundResult[]> {
    const list = Array.isArray(tasks) ? tasks : [];
    const out: GymRoundResult[] = [];
    try {
      for (const t of list) out.push((await this.runTaskSafe(t)).result);
    } catch {
      /* 防弹承诺：漏网异常不炸评估——已完成的轮照常回收 */
    }
    return out;
  }

  /** 单轮本体：GymWorld + RuntimeDeps 方言注入 + 真实器官闭环 */
  private async runTask(
    task: GymTask,
    kernelTouched?: Set<string>,
  ): Promise<{ result: GymRoundResult; strategies: string[] }> {
    const world = new GymWorld(this.taskWithDefaultNoise(task));
    const criteria = Array.isArray(task.successCriteria)
      ? task.successCriteria.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
      : [];
    // Θ-3 记账③策略置信的立法真值源（四世界版 —— W4-4 抽取时原样搬入，逐字节不变）
    const correctNext = (): { kind: 'click' | 'scroll'; label?: string } | null => {
      switch (task.kind) {
        case 'wizard':
        case 'popup-maze':
          if (world.done) return null;
          if (world.popup) return { kind: 'click', label: '确认' };
          return { kind: 'click', label: world.page >= world.pages - 1 ? '完成' : '下一步' };
        case 'scroll-hunt':
          // 顶视口唯一前进路 = scroll down（死链永不翻页）；底视口判据已入读 ⇒ 无真值
          return world.viewport === 'top' ? { kind: 'scroll' } : null;
        case 'danger-gate':
          return world.done ? null : { kind: 'click', label: '稍后提醒' };
        default:
          return null;
      }
    };
    return this.runWorldLoop(
      world,
      { taskId: task.id, kind: task.kind, goal: task.goal, criteria },
      correctNext,
      kernelTouched,
    );
  }

  /**
   * W4-4 闭环核心（自 runTask 原样抽取）：给定任一 GymWorld 兼容世界（四世界
   * GymWorld 或文法 PcgWorld）+ 任务元数据 + 立法真值源，跑一遍真实器官闭环
   * （感知→判断→宪法→执行→验证 + Θ-3 全套记账 + 收官 tick）。抽取律：函数体
   * 与既有 runTask 逐语句一致（仅 task.* 换 meta.*）—— 四世界路径零回归的
   * 结构保障；PCG 世界经同一核心吃到与四世界完全同源的实验室对账。
   */
  private async runWorldLoop(
    world: GymWorldLike,
    meta: { taskId: string; kind: GymWorldKind | 'pcg'; goal: string; criteria: string[] },
    correctNext: () => { kind: 'click' | 'scroll'; label?: string } | null,
    kernelTouched?: Set<string>,
  ): Promise<{ result: GymRoundResult; strategies: string[] }> {
    const now = this.clock;
    const lastSnapshotRef: { current: WorldSnapshot | null } = { current: null };
    const criteria = meta.criteria;

    // ΑΩ-R14（方言统一①判据核对）：内联折叠子串 evidenceOf 方言退役 —— 判据
    // 证据判定改走 criteriaEval 单一器官（runtime 主路径 W9-1 D-G9 收口同源；
    // 肯定面精确匹配 / 否定面证伪的调用方式取舍与差异钉死见 gymCriteriaEvidence
    // JSDoc 与 test/r14.gymDialect.test.ts —— 四世界与 PCG 既有判据全为肯定面
    // ⇒ 证据产出与旧方言逐字节等价，零回归）。
    const evidenceOf = (text: string): Array<{ index: number; status: 'met' | 'violated' }> =>
      gymCriteriaEvidence(criteria, text);

    // ─── Θ-3 内核进化记账基建（全部观察式：只记账，绝不改变闭环任何产物） ───
    //
    // ground truth 三源（虚拟世界立法自带，真实世界拿不到这种对账单）：
    //   ① 状态键真相：world.stateKey() 变没变 —— snapshotChanged 判决的对账面；
    //   ② 控件真相：vlmFor/wordsFor 双源本就同源同帧（同一 sensors 表）⇒ 仲裁
    //      融合理应吃下全部元素 —— 「融合命中数 ≥ 单源」的对账面；
    //   ③ 立法真相：world 状态机知道每态唯一前进路（下一步/确认/完成/scroll/
    //      稍后提醒）—— decide 动作的对账面（无真值之态如实跳过）。
    // 铁律：记账 try/catch 全吞 —— 训练绝不因记账炸；实验室停摆 ⇒ 全部静默。
    const lab = this.labSuite;
    /** 落一条证据（吞异常；顺手登记本 train 触及键） */
    const recordOutcome = (key: string, success: boolean, margin: number): void => {
      try {
        lab?.ledger.record({
          key,
          success,
          ...(typeof margin === 'number' && Number.isFinite(margin) ? { margin } : {}),
          ts: now(),
        });
        kernelTouched?.add(key);
      } catch {
        /* 记账绝不炸训练 */
      }
    };
    /** 上一次感知的对账锚（快照 + 当时状态键）；首轮感知为 null */
    let prevEvidence: { snap: WorldSnapshot; stateKey: string } | null = null;

    // 感知：世界帧 → 真实 composeSnapshot（双源仲裁融合 + 真实 dhash + 弹窗注记）
    const perceive = async (): Promise<WorldSnapshot> => {
      const stateKeyBefore = world.stateKey(); // 本次感知的真相锚（闭环串行 ⇒ 感知期间世界不动）
      const buf = await world.capture();
      const words = world.wordsFor(buf);
      const fingerprint = await dhash(buf).catch((): string | null => null);
      const snap = composeSnapshot({
        image: buf,
        width: world.W,
        height: world.H,
        dhash: fingerprint,
        vlmElements: world.vlmFor(buf),
        localElements: words.map(w => ({ label: w.label, bbox: w.bbox, confidence: w.confidence })),
        ocrText: words.map(w => w.label).join(' '),
        popupNotes: world.popupNotes(),
        now: now(),
      });

      // Θ-3 记账①感知容差：perceived（snapshotChanged 按实验室 hammingTolerance
      // 现值判决）vs truth（世界状态键变没变）。一致 ⇒ success。
      // ΤΕΛ-5 D-G21②（ΠΑΝ-52 margin 去内生 · 实验室跟进）：margin 改记**外部可
      // 观测的原始 dhash 距离**（distance）—— 与生产记录面（autonomousRun
      // reconcileSlowTruth 的 margin=truth.distance）两侧同域。旧口径 margin =
      // |距离−容差| / 距离−容差 是对合映射 x → q − x：margin 分布随当前容差 x
      // 平移、校准器学得的阈 t* ≈ q − x、落回新值 ⇒ 迭代导数 −1 参数代际振荡；
      // 改记原始距离后 margin 分布与 x 无关 ⇒ 学得阈直接是外部判别分位，单调
      // 收敛。tolerance 读点仅作即时判决对照（snapshotChanged 判决面），不入
      // margin 域。
      try {
        const prev = prevEvidence;
        if (lab && prev) {
          const tolerance = this.labHammingTolerance(); // 缺省实验室恒 3 = snapshotChanged 缺省 ⇒ 零漂移
          const perceived = snapshotChanged(prev.snap, snap, tolerance);
          const truth = stateKeyBefore !== prev.stateKey;
          const distance =
            typeof prev.snap.dhash === 'string' &&
            typeof snap.dhash === 'string' &&
            prev.snap.dhash.length > 0 &&
            snap.dhash.length > 0
              ? hammingDistance(prev.snap.dhash, snap.dhash)
              : null;
          const agree = perceived === truth;
          recordOutcome(
            'world.hammingTolerance',
            agree,
            // ΤΕΛ-5 D-G21②：margin = 原始 dhash 距离（外部观测量 —— 对合振荡
            // 论证见上）；指纹缺席 ⇒ 0（对账面缺席的既有占位，行为不变）。
            distance === null ? 0 : distance,
          );
        }
      } catch {
        /* 记账绝不炸训练 */
      }

      // Θ-3 记账②元素仲裁：融合命中数（source='fusion'）vs 单源残留最大数。
      // 本训练营双源同帧同表 ⇒ 真值 = 融合应吃下全部（fusion ≥ max(vlm, local)
      // 即 success；margin = 融合对数）。零源帧（degraded 'elements'）无对账面，
      // 如实跳过。
      try {
        if (lab && Array.isArray(snap.elements) && snap.elements.length > 0) {
          let fusion = 0;
          let vlmOnly = 0;
          let localOnly = 0;
          for (const el of snap.elements) {
            if (el?.source === 'fusion') fusion += 1;
            else if (el?.source === 'vlm') vlmOnly += 1;
            else localOnly += 1;
          }
          const success = fusion >= Math.max(vlmOnly, localOnly);
          recordOutcome('arbitration.iouThreshold', success, fusion);
          recordOutcome('arbitration.agreementBonus', success, fusion);
        }
      } catch {
        /* 记账绝不炸训练 */
      }

      prevEvidence = { snap, stateKey: stateKeyBefore };
      lastSnapshotRef.current = snap;
      return snap;
    };

    // 执行：世界真相判结局（mutations 增 ⇒ progress，否则 no_effect）；
    // 每 3 个已验证步抽查判据（与真实 createExecute 同律）；declare 用感知摘要零截屏
    let verified = 0;
    const execute = async (
      action: PolicyAction,
    ): Promise<{ outcome: StepOutcome; criteriaEvidence?: Array<{ index: number; status: 'met' | 'violated' }> }> => {
      const a = (action ?? {}) as Partial<PolicyAction>;
      if (a.kind === 'click' || a.kind === 'scroll' || a.kind === 'hotkey' || a.kind === 'type') {
        const before = world.mutations;
        world.applyAction(action);
        verified += 1;
        const evidence = verified % 3 === 0 ? evidenceOf(world.ocrText()) : [];
        const outcome: StepOutcome = world.mutations > before ? 'progress' : 'no_effect';
        return evidence.length > 0 ? { outcome, criteriaEvidence: evidence } : { outcome };
      }
      if (a.kind === 'declare') {
        const evidence = evidenceOf(lastSnapshotRef.current?.textDigest ?? '');
        return evidence.length > 0 ? { outcome: 'no_effect', criteriaEvidence: evidence } : { outcome: 'no_effect' };
      }
      return { outcome: 'no_effect' };
    };

    // 目标机：判据空则按降级律以 goal 原文为唯一判据（GoalStateMachine 自律）
    const spec: GoalSpec = {
      goal: meta.goal,
      successCriteria: criteria.length > 0 ? criteria : [meta.goal],
      maxSteps: this.stepCap,
      timeBudgetSec: 300,
    };
    const goal = new GoalStateMachine(spec, now);
    // 策略：离线哨兵 client + 关闭不确定即咨询 ⇒ 全确定性；宪法：benign 白名单
    // （destructive 恒须审批——危险按钮在 PCG 与四世界同律被拦下）+ 步数硬顶同源
    const policy = new PolicyEngine({ client: GYM_OFFLINE_CLIENT, useVlmWhenUncertain: false });
    // Θ-3 记账③策略置信的执法点：包一层纯委托端口 —— decide 原样进出（异常原样
    // 上抛交闭环 error 收敛，零漂移），仅在拿到判决后对账「正确下一步」立法真相：
    // 动作种类与目标标签皆中 ⇒ success（margin = 动作 utility，匹配置信的最近旁证）；
    // 不中 ⇒ failure。无真值之态（correctNext()=null）如实跳过。
    const recordingPolicy = {
      decide: async (ctx: PolicyContext): Promise<PolicyDecision> => {
        const decision = await policy.decide(ctx);
        try {
          const expected = correctNext();
          const action = decision?.action;
          if (lab && expected && action && typeof action.kind === 'string') {
            const matched =
              action.kind === expected.kind &&
              (expected.label === undefined || action.target?.label === expected.label);
            recordOutcome(
              'policy.matchConfident',
              matched,
              typeof action.utility === 'number' && Number.isFinite(action.utility)
                ? action.utility
                : 0,
            );
          }
        } catch {
          /* 记账绝不炸训练 */
        }
        return decision;
      },
    };
    const constitution = new AutonomyConstitution({
      allowAutonomousTiers: ['benign'],
      maxTotalSteps: this.stepCap,
      maxConsecutiveNoEffect: 3,
    });

    const pilot = await runAutonomousLoop(
      { perceive, policy: recordingPolicy, execute, goal, constitution, now, sleep: async (): Promise<void> => {} },
      { maxSteps: this.stepCap },
    );

    // Θ-3 每轮收官：实验室校准器按护栏收敛参数（吞异常 —— 校准绝不炸训练；
    // 无移动 / 证据不足 ⇒ 空报告，kernelCalibrations 缺席）
    let kernelCalibrations: CalibrationReport[] | undefined;
    try {
      const reports = lab?.calibrator.tick();
      if (Array.isArray(reports) && reports.length > 0) kernelCalibrations = [...reports];
    } catch {
      /* 校准绝不炸训练 */
    }

    const strategies = pilot.trajectory
      .map(rec => (typeof rec?.action?.kind === 'string' ? rec.action.kind : ''))
      .filter(k => k !== '');
    const result: GymRoundResult = {
      taskId: meta.taskId,
      kind: meta.kind,
      phase: pilot.phase,
      steps: pilot.steps,
      success: pilot.phase === 'achieved',
      durationMs: pilot.durationMs,
      strategies,
      clicks: [...world.clickLedger],
      ...(kernelCalibrations ? { kernelCalibrations } : {}),
    };
    return { result, strategies };
  }

  // ─── W4-4 文法 PCG：世界执行与有界消费（叠加路径，四世界零触碰） ───

  /**
   * W4-4：跑一个文法 PCG 世界（闭环核心复用 + 文法可观测面入报）。防弹：任何
   * 异常收敛为失败轮（phase='failed'，steps=0），绝不向上抛。产出与四世界同构
   * （strategies/clicks/kernelCalibrations 全套），另附 pcg 推导指纹。
   */
  async runPcgWorld(world: PcgWorld): Promise<{ result: GymRoundResult; strategies: string[] }> {
    try {
      const d = world.derivation;
      const out = await this.runWorldLoop(
        world,
        {
          taskId: `pcg-${world.seed}`,
          kind: 'pcg',
          goal: d.goal,
          criteria: [...d.successCriteria],
        },
        (): { kind: 'click' | 'scroll'; label?: string } | null => world.correctNext(),
      );
      out.result.pcg = {
        seed: world.seed,
        fingerprint: d.fingerprint,
        stages: d.stages.length,
        chain: [...d.chain],
      };
      return out;
    } catch {
      return {
        result: {
          taskId: `pcg-${world?.seed ?? 0}`,
          kind: 'pcg',
          phase: 'failed',
          steps: 0,
          success: false,
          durationMs: 0,
          strategies: [],
          clicks: [],
        },
        strategies: [],
      };
    }
  }

  /**
   * W4-4 有界消费：懒取世界源（可以是 pcgWorldStream 的无限流水），预算封顶
   * （世界数 maxWorlds / 累计步数 maxTotalSteps —— 任一触顶即停，后续世界不再
   * 消费），报告诚实截断（truncated + reason）。每轮收官喂进化引擎（跑一轮聪明
   * 一轮 —— 与 train 同律）。预算语义：步数上限约束「何时不再开新世界」；最后
   * 一个在跑的世界按其自身步数上限诚实入账（stepsTotal 可能超出上限至多一轮步
   * 数 —— 报告如实呈报，绝不假装恰好在界）。源耗尽（有限序列）⇒ 自然收尾
   * （truncated=false, reason='none'）。防弹：垃圾源 ⇒ 空报告。
   */
  async runPcgTasks(source: unknown, budget?: PcgRunBudgetInput): Promise<PcgRunReport> {
    const b = budget && typeof budget === 'object' ? budget : ({} as PcgRunBudgetInput);
    const wRaw = Number(b.maxWorlds);
    const maxWorlds = Number.isFinite(wRaw) && wRaw >= 1 ? Math.min(4096, Math.floor(wRaw)) : 16;
    const sRaw = Number(b.maxTotalSteps);
    const maxTotalSteps = Number.isFinite(sRaw) && sRaw >= 1 ? Math.min(65536, Math.floor(sRaw)) : 128;

    const rounds: GymRoundResult[] = [];
    let worldsRun = 0;
    let stepsTotal = 0;
    let truncated = false;
    let reason: 'none' | 'worlds' | 'steps' = 'none';

    const iterator =
      source !== null && typeof source === 'object' && typeof (source as Iterable<PcgWorld>)[Symbol.iterator] === 'function'
        ? (source as Iterable<PcgWorld>)[Symbol.iterator]()
        : null;
    if (iterator) {
      try {
        for (;;) {
          if (worldsRun >= maxWorlds) {
            truncated = true;
            reason = 'worlds';
            break;
          }
          if (stepsTotal >= maxTotalSteps) {
            truncated = true;
            reason = 'steps';
            break;
          }
          const next = iterator.next();
          if (next.done) break; // 源耗尽：自然收尾（非截断）
          const world = next.value;
          if (!(world instanceof PcgWorld)) continue; // 非法项跳过（防弹）
          const round = await this.runPcgWorld(world);
          rounds.push(round.result);
          worldsRun += 1;
          stepsTotal += Number.isFinite(round.result.steps) ? round.result.steps : 0;
          const record: RunRecord = {
            goal: world.derivation.goal,
            success: round.result.success,
            steps: round.result.steps,
            durationMs: round.result.durationMs,
            strategies: round.strategies,
            ...(round.result.success ? {} : { failureRootCause: `phase=${round.result.phase}` }),
          };
          this.engine.ingest(record);
        }
      } catch {
        /* 防弹承诺：漏网异常不炸消费——已完成的世界照常入报 */
      }
    }

    const ok = rounds.filter(r => r.success).length;
    const summary =
      `文法训练营消费${worldsRun}世界：达成${ok}轮、失败${rounds.length - ok}轮，` +
      `累计${stepsTotal}步（预算${worldsRun}/${maxWorlds}世界、${stepsTotal}/${maxTotalSteps}步${truncated ? `，${reason === 'worlds' ? '世界数' : '步数'}触顶截断` : ''}）——无限生成，有界消费。`;
    return {
      rounds,
      worldsRun,
      stepsTotal,
      budget: { maxWorlds, maxTotalSteps, truncated, reason },
      summary,
    };
  }
}

// W8-B1：noiseSweep 鲁棒性曲线（W1-4 病态感知诊所的观察式扫频）已分区至
// gym.noise.ts（与本文件噪声契约同件 —— 诊所内聚）。

// ═══ W4-4 文法 PCG 无限训练营（M3）═══
//
// 在 W1-4 噪声诊所（同文件前作）之上叠加的**程序化内容生成**层：
//   · PCFG 场景文法：屏幕→[标题栏,主体,侧栏?]、主体→[表单|树形|列表|折叠区组]、
//     元素→按钮/输入框/复选/链接/菜单项、装饰→弹窗/付费陷阱/Cookie横幅/加载遮罩，
//     每条产生式带权重；推导链 seed 钉死（fnv1a 域分离派生 mulberry32 单流，
//     固定遍历序消费 ⇒ 同 seed 推导字节级一致 —— W1-4 种子流派生纪律同源）；
//   · gymWorldFactory(seed, grammarOpts) 铸 GymWorld 兼容世界（PcgWorld：幕状态机
//     + 双视口折叠 + 遮罩层），合成帧由文法场景图渲染（sharp，确定性网格/锚定
//     布局，零随机像素）；
//   · ground truth 同账本：推导器同步把世界真值（元素位置/可交互性/正确动作
//     序列）写入**注入侧** EvidenceLedger（Θ-3/Ξ-C 隔离律不变 —— 生产单例零
//     触碰，pcg.truth.* 键域与四世界记账键永不串流）；
//   · 文法级课程：updatePcgCurriculum 按历史运行（失败/惊异）确定性更新产生式
//     权重（POET 式任务-智能体共进化 —— 哪类产生式失败多，下次加权生成）；
//   · 无限性有界：pcgWorldStream 流水生成无限世界序列；消费侧（runPcgTasks /
//     runPcgCampaign）预算封顶（世界数/步数），报告诚实截断；
//   · 零回归：四世界与 noiseSweep 路径分毫不动（PCG 是叠加工厂而非替换）。

/** W4-4：闭环核心可驱动的世界面（GymWorld 与 PcgWorld 的结构公共子集） */
interface GymWorldLike {
  readonly W: number;
  readonly H: number;
  readonly mutations: number;
  readonly clickLedger: ReadonlyArray<string | null>;
  stateKey(): string;
  popupNotes(): string[];
  applyAction(action: PolicyAction): void;
  capture(): Promise<Buffer>;
  wordsFor(buf: Buffer): Array<{
    label: string;
    bbox: { x0: number; y0: number; x1: number; y1: number };
    confidence: number;
  }>;
  vlmFor(buf: Buffer): GroundedElement[];
  ocrText(): string;
}

// W8-B1：W4-4 文法 PCG 全套已按内聚分区（文末再导出回流）：
//   文法立法（类型/PCG_PRODUCTIONS/权重合成/推导契约/文法课程）→ gym.pcgGrammar.ts；
//   推导器（pcgWeightedPick/词汇表/derivePcgScene/兜底）→ gym.pcgDerive.ts；
//   文法世界（renderPcgFrame/PcgWorld/工厂/无限流水）→ gym.pcgWorld.ts；
//   有界消费（预算契约/runPcgCampaign）→ gym.pcgCampaign.ts。

// ─── W8-B1 导入面稳定（拆分律：全部既有公共符号经此再导出，消费方零改动） ───
//
// 再导出清单 = 拆分前 gym.ts 的全部公共符号（具名对账，绝不用 export * ——
// 卫星件的件内实现导出不外溢）。卫星件回导本件立法常量（mulberry32/fnv1a/
// r2/castTask/KIND_ORDER/DEFAULT_* 等）是「立法在源」纪律：缺省值与轮转律只此
// 一份，测试锁定口径不变。
// ΑΩ-R14（方言统一②rng 单源）：mulberry32/fnv1a 的流实现已上移单源模块
// src/dialects/random.ts —— 本件 mulberry32 是「单源流内核 + gym 种子归一
// 卫兵」的门面、fnv1a 原样再导出（卫星件从本件的消费链与导入面分毫不动）。

// W1-4 病态感知诊所（gym.noise.ts；corruptOcrLabel/GYM_NOISY_OCR_CONF 为件内
// 实现面，只供世界铸造侧兄弟件导入 —— 不进公共再导出，导入面与拆分前逐符对齐）
// ΠΑΝ-127（D-F5 清偿）：noiseSweep 由再导出改为「本桶包装 + 端口注入」—— 卫星
// gym.noise.ts 曾回借本桶 AutonomyGym/DEFAULT_MAX_STEPS 构成 value 二环；核心
// 实现仍全量在 gym.noise.ts（w8gymsplit ②「已分区」锁定不破），本桶仅注入
// 训练营工厂与立法缺省（签名与语义零变化，消费方两参照旧）。
export { resolveGymNoise } from './gym.noise';
import { noiseSweep as noiseSweepCore } from './gym.noise';
export type {
  GymNoiseLevel,
  GymNoiseResolved,
  GymNoiseSpec,
  GymNoiseSweepOptions,
  GymNoiseSweepPoint,
  GymNoiseSweepResult,
} from './gym.noise';
import type { GymNoiseSweepOptions, GymNoiseSweepResult } from './gym.noise';

/** W1-4 noiseSweep 公开面（训练营工厂与任务生立立法在此注入 —— 立法在源本文件） */
export function noiseSweep(opts?: GymNoiseSweepOptions): Promise<GymNoiseSweepResult> {
  return noiseSweepCore(opts, {
    createGym: o => new AutonomyGym(o),
    defaultMaxSteps: DEFAULT_MAX_STEPS,
    castTask,
    kindOrder: KIND_ORDER,
  });
}

// 四世界状态机（gym.world.ts）
export { GymWorld } from './gym.world';
export type { GymControl } from './gym.world';

// W4-4 文法立法（gym.pcgGrammar.ts）
export {
  PCG_PRODUCTIONS,
  pcgBaseWeights,
  pcgEffectiveWeights,
  updatePcgCurriculum,
} from './gym.pcgGrammar';
export type {
  GymGrammarOptions,
  PcgCurriculumFeedback,
  PcgDecorRule,
  PcgDerivation,
  PcgElementRule,
  PcgMainRule,
  PcgOverlayTruth,
  PcgProductionId,
  PcgProductionSpec,
  PcgRoundTrace,
  PcgSceneNode,
  PcgScreenRule,
  PcgStageTruth,
} from './gym.pcgGrammar';

// W4-4 文法推导器（gym.pcgDerive.ts）
export { derivePcgScene } from './gym.pcgDerive';

// W4-4 文法世界（gym.pcgWorld.ts；PcgWorld 原为值导出 —— 类再导出保持值面）
// ΠΑΝ-127（D-F5 清偿）：pcgWorldStream 由再导出改为「本桶包装 + 立法缺省注入」
// —— 卫星 gym.pcgWorld.ts 曾回借本桶 DEFAULT_SEED 构成 value 二环；无限流水
// 实现仍全量在 gym.pcgWorld.ts，本桶仅在边界补立法缺省（缺种子语义零变化）。
export { PcgWorld, gymWorldFactory } from './gym.pcgWorld';
import { pcgWorldStream as pcgWorldStreamCore } from './gym.pcgWorld';
import type { GymGrammarOptions } from './gym.pcgGrammar';

/** W4-4 无限世界流水公开面（非法种子的立法缺省在此注入 —— 立法在源本文件） */
export function pcgWorldStream(seed: number, opts?: GymGrammarOptions) {
  const s = Number(seed);
  return pcgWorldStreamCore(Number.isFinite(s) ? s : DEFAULT_SEED, opts);
}

// W4-4 有界消费（gym.pcgCampaign.ts）
// ΠΑΝ-127（D-F5 清偿）：runPcgCampaign 由再导出改为「本桶包装 + 端口注入」——
// 卫星 gym.pcgCampaign.ts 曾回借本桶 AutonomyGym/DEFAULT_SEED/DEFAULT_MAX_STEPS/
// CLOCK_STEP_MS 构成 value 二环；有界消费实现仍全量在 gym.pcgCampaign.ts
// （w8gymsplit ②「已分区」锁定不破），本桶仅注入训练营工厂与立法缺省
//（签名与语义零变化，消费方两参照旧）。
import { runPcgCampaign as runPcgCampaignCore } from './gym.pcgCampaign';
export type {
  PcgCampaignOptions,
  PcgCampaignReport,
  PcgRunBudgetInput,
  PcgRunReport,
} from './gym.pcgCampaign';
import type { PcgCampaignOptions, PcgCampaignReport } from './gym.pcgCampaign';

/** W4-4 文法训练营有界消费公开面（训练营工厂与立法缺省在此注入 —— 立法在源本文件） */
export function runPcgCampaign(opts?: PcgCampaignOptions): Promise<PcgCampaignReport> {
  return runPcgCampaignCore(opts, {
    createGym: o => new AutonomyGym(o),
    defaultSeed: DEFAULT_SEED,
    defaultMaxSteps: DEFAULT_MAX_STEPS,
    clockStepMs: CLOCK_STEP_MS,
  });
}
