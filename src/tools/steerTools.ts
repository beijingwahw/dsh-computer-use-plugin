// src/tools/steerTools.ts
// W3-5（H2 活意图与漂移检测）：意图漂移的结构化单字符应答工具。
//
// 问题：自主环长跑时世界在变，goal 锚点不动 —— agent 可能在错误的方向上
// 高效前进。漂移检测把「我还在干用户要我干的事吗」压缩成一个确定性评分；
// 超阈则生成**结构化选择题**（steer_choice）：不是开放问答，是
// [A 继续 / B 改判据（自动生成具体修正）/ C 终止] 三选一 —— 用户应答成本
// 压到单键。
//
// ── 评分律（纯函数、确定性、零网络零模型） ──
//   语义距离 sem = 1 − cosine(embed(goal+判据), embed(当前屏幕文本+场景标签))
//     —— semanticHash 的 FNV n-gram 稀疏嵌入（src/semanticHash.ts，微秒级）；
//   停滞度   stag = min(1, 判据无进展步数 / ceil(步数预算 × 0.5))
//     —— 判据账 N 步不动：屏幕看似相关也可能是原地打转；
//   融合 drift = 0.7·sem + 0.3·stag（三位小数量子化）。
//   权重设计：停滞是融合放大器而非独立扳机 —— 纯停滞封顶 0.3 < 触发线
//   0.55，永不单独出题；语义漂移是主扳机（sem ≳ 0.79 即可单独触发），
//   两者叠加则更早触警。
//
// ── 降级律（绝不误伤） ──
//   无注入指纹源（screenText 缺席 / 返回空串 / 抛异常）⇒ 漂移评分缺席
//   （不落账、toAnchor 无 drift 键）、绝不生成选择题。
//
// ── 节流律 ──
//   检查每 DRIFT_CHECK_INTERVAL_STEPS 步一次（或熵超阈即时检查，判据在
//   uncertainty.entropyWarrantsDriftCheck）；同一目标（一个会话绑定一台
//   目标机）最多每 STEER_THROTTLE_STEPS 步一题 —— 漂移检测自己不许成为
//   打扰源。
//
// 铁律：绝不抛异常（指纹源/目标机的一切异常吞掉收敛为缺席）；相位推导
// 不动（七相纯推导铁律不破 —— 漂移账与判据修正是数据落账，不是相变指令）。
// 工具工厂导出、注册留给集成（src/tools/index.ts 是 W3-0 领地）。
//
// W5-5（steer/岔路收官闭环）增量 —— 把 W4-0 留白的三缝在本模块闭两缝：
//   · 缝1（B 应答回灌重启通道）：B 应答在既有 amendCriterion 写回之上，增
//     「重启指引」（SteerRestartGuidance：修订后 goal 锚点摘要 + resume 语义）
//     与「会话修订判据账」（drainAmendments 一次性移交）—— runPilotLoop 重入
//     时消费该账，把修订判据 replay 进新 run 的目标机（经会话状态传递，跨
//     goal 匹配防御）。
//   · 缝3（steer(k) 换支消费）：无待答题目且会话持卡（driveLoop 铸卡后经
//     holdBranchCard 注入）时，"2"/"B2" 形应答触发 applyBranchChoice 换支，
//     返回重放指引（支点 + 偏置 + 预算），偏置执法面（SteerBiasStepper）留
//     会话内由 runPilotLoop 经 takeBranchBias 取走注入闭环。待答题目优先于
//     岔路模式（A/B/C 单字符语义逐字节不变）；无卡 ⇒ 原路径逐字节不变。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { cosine, embed } from '../semanticHash';
import type { CriterionStatus, DriftTrend, GoalStateMachine } from '../autonomy/goalState';
import { entropyWarrantsDriftCheck } from '../autonomy/uncertainty';
// W5-5（缝3）：换支重放的纯 API 面（branchCards → counterfactual/diagnosis 均
// 为下游模块，与本文件零回路）；BranchCard/BranchReplayController 只做载荷标注。
import { applyBranchChoice, type BranchCard, type BranchReplayController } from '../branchCards';

// ─── W3-5：模块常量（值即边界，测试的事实源） ───

/** 漂移检查周期（步）：每 N 步做一次评分；熵超阈可即时插队检查 */
export const DRIFT_CHECK_INTERVAL_STEPS = 3;
/** 漂移报警线 [0,1]：融合分严格大于才生成选择题（恰等不触警） */
export const DRIFT_ALERT_THRESHOLD = 0.55;
/** 节流窗（步）：同一目标最多每 M 步一题 */
export const STEER_THROTTLE_STEPS = 8;
/** 融合权重：语义距离 0.7 / 判据停滞 0.3（见文件头评分律） */
const DRIFT_SEMANTIC_WEIGHT = 0.7;
const DRIFT_STAGNATION_WEIGHT = 0.3;
/** 停滞饱和线：判据无进展步数达步数预算的一半即停滞度满格 1 */
const STAGNATION_BUDGET_RATIO = 0.5;

// ─── W3-5：载荷类型（纯数据） ───

/** B 选项的判据修正载荷：自动生成、单字符应答即可写回的具体内容 */
export interface SteerAmendment {
  /** 待修正判据在目标机判据账中的下标 */
  criterion_index: number;
  /** 原判据文本 */
  from: string;
  /** 自动生成的修正文本（含证据数值 —— 具体、可审计） */
  to: string;
}

/** 结构化选择题载荷（steer_choice）：非开放问答，固定三选项 */
export interface SteerChoice {
  kind: 'steer_choice';
  /** 出题步序号 */
  asked_at_step: number;
  /** 触发本题主因：融合分 + 趋势 + 两通道原始证据 */
  drift: { score: number; trend: DriftTrend };
  evidence: { semantic_distance: number; stagnation_steps: number; stagnation_ratio: number };
  reason: string;
  options: Array<{ key: 'A' | 'B' | 'C'; label: string; description: string }>;
  /** B 选项的具体内容（A/C 无载荷） */
  amendment: SteerAmendment;
  /** 应答格式契约：单字符 */
  answer_format: 'single-char';
}

/** steer 应答的结算结果（纯数据，绝不抛） */
export interface SteerAnswerResult {
  status: 'answered' | 're-ask' | 'no-pending' | 'branch';
  choice?: 'A' | 'B' | 'C';
  /** re-ask / answered 时回显题目（垃圾应答重问的题面） */
  question?: SteerChoice;
  /** B 应答是否已写回目标机 */
  applied?: boolean;
  amendment?: SteerAmendment;
  hint?: string;
  /** W5-5（缝1）：B 应答且写回生效时的重启指引（修订后锚点摘要 + resume 语义） */
  restart?: SteerRestartGuidance;
  /** W5-5（缝3）：换支成功时的重放指引（支点 + 偏置 + 预算；执法面经
   *  takeBranchBias 移交 runPilotLoop 消费） */
  branch?: SteerBranchGuidance;
}

/**
 * W5-5（缝1）B 应答的重启指引（纯数据）：修订判据写回后把「怎么重启」结构化 ——
 * 修订后 goal 锚点摘要（toAnchor 防御拷贝）+ resume 语义建议。工具面 JSON 序列化
 * 直达模型；真正的回灌（把修订判据 replay 进新 run 的目标机）由 runPilotLoop
 * 重入时消费会话的修订判据账（drainAmendments）完成。
 */
export interface SteerRestartGuidance {
  kind: 'steer-restart';
  /** 已写回的修订判据（index/from/to —— 与 SteerAmendment 同源） */
  amended: { index: number; from: string; to: string };
  /** 修订后 goal 锚点摘要（phase/step_index/criteria/… —— toAnchor 防御拷贝） */
  goal_anchor: Record<string, unknown>;
  /** resume 语义建议（一句 —— 重启通道的使用说明） */
  resume: string;
}

/** W5-5（缝1）：B 应答回灌的会话账条目 —— 修订判据 + 出题时 goal 原文（跨 run 匹配防御） */
export interface SteerAmendmentHandoff {
  /** 出题时目标机的 goal 原文（回灌仅对同 goal 的新 run 生效 —— 跨目标陈旧修订绝不回灌） */
  goalText: string;
  amendment: SteerAmendment;
}

/**
 * W5-5（缝3）换支重放指引（纯数据）：steer_answer 岔路模式的返回面 —— 支点 +
 * 偏置载荷 + 预算读数；重放执法面（SteerBiasStepper）留在会话内，由
 * runPilotLoop 重入时经 takeBranchBias 取走注入闭环。
 */
export interface SteerBranchGuidance {
  kind: 'branch-replay';
  /** 选中的候选支号（1..K） */
  k: number;
  /** 选中候选（签名 + 诚实效用 + 名次） */
  chosen: { signature: string; utility: number; rank: number };
  /** 支点引用（checkpoint 步账位置 —— 换支重放的恢复点） */
  pivot: { stepIndex: number; recordedAt: number; anchor: { journalLength: number; chainTip: string } };
  /** 决策偏置载荷（铸入 ScoringContext.preferredActionKeys 注入缝） */
  bias: { preferredActionKeys: string[] };
  /** 重放步数预算（超支诚实终止 —— 不再悄悄续命） */
  budget_steps: number;
  /** 重放指引（一句 —— runPilotLoop 重入的使用说明） */
  note: string;
}

/**
 * W5-5（缝3）：换支重放的偏置步进面 —— runPilotLoop 从在役会话取走、注入
 * AutonomyDeps.steerBias；每步决策既定即 step() 扣重放预算并返回本步偏置键
 * （预算耗尽 ⇒ null = 无偏置原路继续 —— 超支诚实终止）。structural 端口，
 * 会话铸造侧由 BranchReplayController 包装实现。
 */
export interface SteerBiasStepper {
  /** 扣一步重放预算并返回本步偏置键（超支/已完成/故障 ⇒ null） */
  step(): { preferredActionKeys: string[] } | null;
  /** 预算执法的透明读数（审计面） */
  state(): { status: string; stepsUsed: number; budgetSteps: number };
  /** 重放成功收尾（超支后无效 —— 超支是终局事实） */
  complete(): void;
}

/** 会话外部依赖（全部可注入 —— 离线测试零真屏零真钟） */
export interface SteerSessionDeps {
  /** 目标状态机（漂移账 / 判据修正的落账处） */
  goal: GoalStateMachine;
  /** 屏幕语义指纹源：返回当前快照文本（textDigest + 场景标签拼接）；
   *  缺席 / 返回空 / 抛异常 ⇒ 指纹缺席 ⇒ 漂移评分缺席（降级律） */
  screenText?: () => string | null;
  /** 可选诊断信号源：一句话诊断（如 diagnosis.ts 会诊结论）—— 参与 B 选项
   *  修正文本的自动生成；缺席不影响出题 */
  diagnosisNote?: () => string | null;
  /** 漂移报警线覆盖（缺省 DRIFT_ALERT_THRESHOLD；非法值回退缺省） */
  driftThreshold?: number;
  /** 节流窗覆盖（缺省 STEER_THROTTLE_STEPS；非法值回退缺省） */
  throttleSteps?: number;
}

/** steer 会话：绑定一台目标机的漂移检查 + 出题 + 应答结算（防御式，绝不抛） */
export interface SteerSession {
  /** 绑定的目标机（集成层回读漂移账用） */
  readonly goal: GoalStateMachine;
  /**
   * 漂移检查 + 按需出题（纯节律入口，绝不抛）：
   * 周期（stepIndex % N === 0）或熵超阈才检查；节流窗内不出题；
   * 指纹缺席 / 未超阈 / 无未核判据 ⇒ null。已有待答题目 ⇒ 幂等重显同题。
   */
  maybeCheckAndAsk(stepIndex: number | null, entropy?: number | null): SteerChoice | null;
  /** 当前待答题目（无则 null；防御副本） */
  pending(): SteerChoice | null;
  /** 应答结算：单字符解析（容错）⇒ A 放行 / B 写回判据 / C 记终止阻塞；垃圾重问。
   *  W5-5（缝3）：无待答题目且持卡时，"2"/"B2" 形应答走岔路换支（status 'branch'）。 */
  answer(raw: unknown): SteerAnswerResult;
  /** 最近一次落账的漂移评分（未落账 ⇒ null） */
  lastDrift(): number | null;
  /** W5-5（缝1，可选面）：取走全部未消费的修订判据（取走即清 —— 一次性移交，
   *  runPilotLoop 重入消费；B 应答写回生效即入账）。转发面/最小桩可不实现
   *  （消费方守卫式调用，缺席 ⇒ 回灌零执行）。 */
  drainAmendments?(): SteerAmendmentHandoff[];
  /** W5-5（缝3，可选面）：持有岔路卡（driveLoop 铸卡后注入；null 清除）—— 防御式绝不抛 */
  holdBranchCard?(card: unknown): void;
  /** W5-5（缝3，可选面）：当前持有的岔路卡（无 ⇒ null；防御浅拷贝） */
  branchCard?(): BranchCard | null;
  /** W5-5（缝3，可选面）：取走在役换支重放的偏置步进面（无 ⇒ null；取走即移交
   *  预算执法权 —— runPilotLoop 注入 AutonomyDeps.steerBias 消费，一次性）。 */
  takeBranchBias?(): SteerBiasStepper | null;
}

// ─── W3-5：纯函数（评分 / 节律 / 出题 / 解析 —— 全部确定性、绝不抛） ───

/** 数值卫兵：非有限数取 fallback，否则夹 [min,max]（脏输入收敛） */
function numIn(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** 锚点文本：goal 原文 + 全部判据拼接（漂移比对的「意图侧」语料） */
function anchorTextOf(goalText: unknown, criteria: unknown): string {
  const parts: string[] = [];
  if (typeof goalText === 'string' && goalText.trim() !== '') parts.push(goalText);
  if (Array.isArray(criteria)) {
    for (const c of criteria) if (typeof c === 'string' && c.trim() !== '') parts.push(c);
  }
  return parts.join(' ');
}

/** 语义距离（纯函数）：1 − cosine（非负权重空间 ⇒ 值域 [0,1]；任一侧空 ⇒ null 不可判） */
function semanticDistance(anchorText: string, screenText: string): number | null {
  if (anchorText.trim() === '' || screenText.trim() === '') return null; // 无锚 / 无屏 ⇒ 不可判
  return 1 - cosine(embed(anchorText), embed(screenText));
}

/**
 * W3-5 漂移评分（纯函数、确定性、绝不抛）：
 *
 *   drift = 0.7·(1 − cosine(embed(意图侧), embed(屏幕侧))) + 0.3·min(1, 停滞步数 / ceil(预算×0.5))
 *
 * · screenText 缺席（null/undefined/空串/非字符串）⇒ **null**（评分缺席，
 *   绝不冒充 0 分 —— 降级律）；意图侧（goal+判据）为空同样 null（无锚不可判）；
 * · 停滞通道：stepsSinceCriterionChange 非法按 0；stepsBudget 非法按 24
 *   （与 goalState 构造降级同律）；分母至少 1（除零免疫）；
 * · 返回三位小数量子化值（跨平台确定，测试可手算对照）。
 */
export function scoreDrift(input: {
  goalText: string;
  criteria: readonly string[];
  screenText: string | null;
  stepsSinceCriterionChange: number;
  stepsBudget: number;
}): number | null {
  const screen = typeof input?.screenText === 'string' ? input.screenText.trim() : '';
  const anchor = anchorTextOf(input?.goalText, input?.criteria);
  const sem = semanticDistance(anchor, screen);
  if (sem === null) return null;
  const budget = Math.max(1, numIn(input?.stepsBudget, 1, Number.POSITIVE_INFINITY, 24));
  const denom = Math.max(1, Math.ceil(budget * STAGNATION_BUDGET_RATIO));
  const steps = Math.max(0, numIn(input?.stepsSinceCriterionChange, 0, Number.POSITIVE_INFINITY, 0));
  const stag = Math.min(1, steps / denom);
  return Math.round((DRIFT_SEMANTIC_WEIGHT * sem + DRIFT_STAGNATION_WEIGHT * stag) * 1000) / 1000;
}

/**
 * W3-5 检查节律（纯函数）：stepIndex 是 N 的倍数，或熵超阈
 * （uncertainty.entropyWarrantsDriftCheck —— 认识论中枢的「该慌了」裁决）。
 * stepIndex 非法（null/非数/负数）时只认熵通道。
 */
export function shouldCheckDrift(stepIndex: number | null, entropy?: number | null): boolean {
  if (
    typeof stepIndex === 'number' && Number.isFinite(stepIndex) &&
    Math.floor(stepIndex) >= 0 && Math.floor(stepIndex) % DRIFT_CHECK_INTERVAL_STEPS === 0
  ) {
    return true;
  }
  return typeof entropy === 'number' && entropyWarrantsDriftCheck(entropy);
}

/**
 * W3-5 B 选项修正文本的自动生成（纯函数、确定性）：
 * 未 met 判据原文 + 主导证据（语义距离 / 停滞步数的实际数值）+ 可选诊断信号，
 * 铸成一句具体的修正文本 —— 应答 B 即原样写回目标机（amendCriterion）。
 */
function draftAmendment(
  criterion: string,
  evidence: { semantic_distance: number; stagnation_steps: number; stagnation_ratio: number },
  diagnosisNote: string | null,
): string {
  const sem = numIn(evidence?.semantic_distance, 0, 1, 0);
  const stag = numIn(evidence?.stagnation_ratio, 0, 1, 0);
  const steps = Math.max(0, numIn(evidence?.stagnation_steps, 0, Number.POSITIVE_INFINITY, 0));
  const crit = typeof criterion === 'string' ? criterion : '';
  const cause =
    sem >= stag
      ? `当前屏幕与目标语义距离 ${sem.toFixed(3)}`
      : `判据已 ${steps} 步无进展`;
  const dx =
    diagnosisNote !== null && typeof diagnosisNote === 'string' && diagnosisNote.trim() !== ''
      ? `；诊断信号：${diagnosisNote.trim().slice(0, 60)}`
      : '';
  return `${crit}（修正：${cause}${dx}，改按当前屏幕实况核验）`;
}

/**
 * W3-5 结构化选择题生成（纯函数、确定性、绝不抛）：
 * 漂移超阈且存在未核（unverified）判据 ⇒ 铸题；无未核判据（全 met / 已终局）
 * ⇒ null（无事可问 —— 绝不误伤）。B 选项内容见 draftAmendment。
 */
export function buildSteerChoice(input: {
  criteriaStatus: readonly CriterionStatus[];
  drift: number;
  trend: DriftTrend;
  evidence: { semantic_distance: number; stagnation_steps: number; stagnation_ratio: number };
  stepIndex: number;
  diagnosisNote?: string | null;
}): SteerChoice | null {
  const statuses = Array.isArray(input?.criteriaStatus) ? input.criteriaStatus : [];
  const firstUnverified = statuses.findIndex(c => c && c.status === 'unverified');
  if (firstUnverified < 0) return null; // 无未核判据 ⇒ 无可问
  const criterion = statuses[firstUnverified].criterion;
  const amendment: SteerAmendment = {
    criterion_index: firstUnverified,
    from: criterion,
    to: draftAmendment(
      criterion,
      input.evidence,
      typeof input?.diagnosisNote === 'string' ? input.diagnosisNote : null,
    ),
  };
  return {
    kind: 'steer_choice',
    asked_at_step: input.stepIndex,
    drift: { score: input.drift, trend: input.trend },
    evidence: input.evidence,
    reason: `意图漂移评分 ${input.drift}（趋势 ${input.trend}）超过报警线 ${DRIFT_ALERT_THRESHOLD}，需要一次意图校准`,
    options: [
      { key: 'A', label: '继续', description: '维持原目标原判据继续执行' },
      { key: 'B', label: '改判据', description: `按自动生成的修正改写第 ${firstUnverified + 1} 条判据：${amendment.to}` },
      { key: 'C', label: '终止', description: '终止本次任务（记阻塞收场，不再消耗预算）' },
    ],
    amendment,
    answer_format: 'single-char',
  };
}

/** 单字符别名表（小写化后匹配）：字母 / 数字序号 / 全角字母 / 汉字首字 */
const STEER_ALIASES: Readonly<Record<string, 'A' | 'B' | 'C'>> = {
  a: 'A', b: 'B', c: 'C',
  '1': 'A', '2': 'B', '3': 'C',
  'ａ': 'A', 'ｂ': 'B', 'ｃ': 'C', // 全角小写（toUpperCase 的镜像已由 toLowerCase 归一）
  '继': 'A', '改': 'B', '停': 'C',
};

/**
 * W3-5 单字符应答解析（纯函数、绝不抛）：A/B/C 三选一。
 * 容错：首尾空白剥除、大小写不敏感、全角字母、数字序号 1/2/3、汉字
 * 「继/改/停」。多字符（含「继续吧」「AB」）、空串、非字符串 ⇒ null
 * （垃圾输入走重问通道，绝不猜、绝不默认）。
 */
export function parseSteerAnswer(raw: unknown): 'A' | 'B' | 'C' | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (s.length !== 1) return null;
  return STEER_ALIASES[s] ?? null;
}

/**
 * W5-5（缝3）岔路换支应答解析（纯函数、绝不抛）："2" / "B2"（b/B 前缀可选 ——
 * 大小写与全角归一，后随 1-2 位数字）⇒ k；其余（空串 / 纯字母 / 多字符 /
 * 非数字 / 0）⇒ null —— 垃圾输入绝不猜。k 的值域执法在 applyBranchChoice
 * （合法域 1..candidates.length，越界 ⇒ 诚实拒绝走 re-ask 提示）。
 */
export function parseBranchAnswer(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  const m = /^([bｂ])?([0-9]{1,2})$/.exec(s);
  if (m === null) return null;
  const k = Number.parseInt(m[2], 10);
  return k >= 1 ? k : null;
}

// ─── W5-5（缝1/缝3）：会话扩展面的模块级辅助（纯防御，零异常） ───

/** W5-5（缝3）：BranchReplayController → SteerBiasStepper 的防御包装
 *  （spend/state/complete 一切故障 ⇒ null / 空读数 / 吞掉 —— 绝不炸会话） */
function wrapReplayStepper(ctrl: BranchReplayController, keys: readonly string[]): SteerBiasStepper {
  const safeKeys = keys.filter(k => typeof k === 'string' && k !== '');
  return {
    step(): { preferredActionKeys: string[] } | null {
      try {
        const r = ctrl.spend();
        return r.proceed === true ? { preferredActionKeys: [...safeKeys] } : null;
      } catch {
        return null; // 预算执法故障 ⇒ 无偏置（诚实降级，绝不炸环）
      }
    },
    state(): { status: string; stepsUsed: number; budgetSteps: number } {
      try {
        const s = ctrl.state;
        return { status: s.status, stepsUsed: s.stepsUsed, budgetSteps: s.budgetSteps };
      } catch {
        return { status: 'armed', stepsUsed: 0, budgetSteps: 0 };
      }
    },
    complete(): void {
      try { ctrl.complete(); } catch { /* 收尾故障吞掉 */ }
    },
  };
}

/** W5-5（缝3）：卡内候选数（防御读 —— 越界重问提示面的值域文案） */
function cardCandidateCount(card: BranchCard | null): number {
  return card !== null && Array.isArray(card.candidates) ? card.candidates.length : 0;
}

// ─── W3-5：会话（节律 + 节流 + 出题 + 应答结算；防御式，绝不抛） ───

/** 判据账签名：状态序列的稳定串（签变 ⇒ 停滞计时归零） */
function criteriaSignature(statuses: readonly CriterionStatus[]): string {
  return statuses.map(c => `${c?.status ?? '?'}`).join(',');
}

/**
 * 铸造 steer 会话（W3-5）：绑定一台目标机，持有出题 / 节流 / 停滞计时状态。
 * deps.goal 缺席或非对象 ⇒ 铸出「永不出题」的空转会话（防御式：调用面
 * （工具）拿到的永远是合法会话，绝不抛）。
 */
export function createSteerSession(deps: SteerSessionDeps): SteerSession {
  const d = deps !== null && typeof deps === 'object' ? deps : ({} as SteerSessionDeps);
  const goal: GoalStateMachine | null =
    d.goal !== null && typeof d.goal === 'object' ? d.goal : null;
  const threshold = numIn(d.driftThreshold, 0, 1, DRIFT_ALERT_THRESHOLD);
  const throttle = Math.max(1, Math.round(numIn(d.throttleSteps, 1, Number.POSITIVE_INFINITY, STEER_THROTTLE_STEPS)));
  const screenTextFn = typeof d.screenText === 'function' ? d.screenText : null;
  const diagnosisFn = typeof d.diagnosisNote === 'function' ? d.diagnosisNote : null;

  /** 防御读取目标机进度（一切异常 ⇒ 空账） */
  const readStatuses = (): CriterionStatus[] => {
    try {
      const p = goal?.progress;
      return Array.isArray(p?.criteriaStatus) ? p.criteriaStatus : [];
    } catch {
      return [];
    }
  };
  /** 防御读取目标机规格 */
  const readSpec = (): { goalText: string; stepsBudget: number } => {
    try {
      const s = goal?.spec;
      return {
        goalText: typeof s?.goal === 'string' ? s.goal : '',
        stepsBudget: numIn(s?.maxSteps, 1, Number.POSITIVE_INFINITY, 24),
      };
    } catch {
      return { goalText: '', stepsBudget: 24 };
    }
  };
  /** 防御读取漂移趋势（recordDrift 之后从锚点回读 —— toAnchor 的 drift 键） */
  const readTrend = (): DriftTrend => {
    try {
      const anchor = goal?.toAnchor() as { drift?: { trend?: unknown } } | undefined;
      const t = anchor?.drift?.trend;
      return t === 'rising' || t === 'falling' || t === 'flat' || t === 'unknown' ? t : 'unknown';
    } catch {
      return 'unknown';
    }
  };
  /** 防御文本读取：源缺席 / 抛异常 / 非字符串 / 空白 ⇒ null（缺席） */
  const safeText = (fn: (() => unknown) | null): string | null => {
    if (fn === null) return null;
    try {
      const v = fn();
      if (typeof v !== 'string' || v.trim() === '') return null;
      return v;
    } catch {
      return null; // 指纹源/诊断源故障 ⇒ 缺席（绝不炸会话）
    }
  };

  // 停滞计时：判据账签名一旦变化（有判据被核 / 被修正）⇈ 归零重计
  let lastCriteriaSig = criteriaSignature(readStatuses());
  let lastCriteriaSigStep = 0;
  // 节流账：上次出题步（null = 从未出题）
  let lastAskedStep: number | null = null;
  // 待答题目（出题后挂起，应答即清）
  let pendingChoice: SteerChoice | null = null;
  // 最近落账评分（lastDrift 出口；null = 从未落账）
  let lastDriftScore: number | null = null;
  // W5-5（缝1/缝3）会话状态增量：B 应答回灌账、岔路卡持有面、在役换支重放。
  let w5Amendments: SteerAmendmentHandoff[] = [];
  let w5Card: BranchCard | null = null;
  let w5Bias: SteerBiasStepper | null = null;

  /** W5-5（缝1）：防御读取 goal 锚点（restart 指引的回显面 —— 修订后摘要） */
  const readGoalAnchor = (): Record<string, unknown> => {
    try {
      const a = goal?.toAnchor();
      return a !== null && typeof a === 'object' ? { ...(a as Record<string, unknown>) } : {};
    } catch {
      return {};
    }
  };

  const session: SteerSession = {
    get goal(): GoalStateMachine {
      return goal as GoalStateMachine; // 铸造面已保证非空（防御面在 readStatuses 等处）
    },
    maybeCheckAndAsk(stepIndex: number | null, entropy?: number | null): SteerChoice | null {
      // 幂等重显：已有待答题目 ⇒ 原题再展示（不叠新题）
      if (pendingChoice !== null) return pendingChoice;
      if (!shouldCheckDrift(stepIndex, entropy)) return null;
      // 步序号兜底：熵通道触发而 stepIndex 缺席 ⇒ 取目标机自己的步账
      const idx =
        typeof stepIndex === 'number' && Number.isFinite(stepIndex) && stepIndex >= 0
          ? Math.floor(stepIndex)
          : Math.max(0, Math.floor(safeProgressStep()));
      // 指纹源缺席 / 返回空 / 返回非字符串 / 抛异常 ⇒ 漂移评分缺席（不落账不出题 —— 降级律）
      const screenText = safeText(screenTextFn);
      if (screenText === null) return null;
      // 停滞计时刷新：判据账签名变化 ⇒ 归零
      const sig = criteriaSignature(readStatuses());
      if (sig !== lastCriteriaSig) {
        lastCriteriaSig = sig;
        lastCriteriaSigStep = idx;
      }
      const stagnationSteps = Math.max(0, idx - lastCriteriaSigStep);
      const spec = readSpec();
      const statuses = readStatuses();
      const anchor = anchorTextOf(spec.goalText, statuses.map(c => c.criterion));
      const sem = semanticDistance(anchor, screenText);
      if (sem === null) return null; // 锚缺席（垃圾 goal）⇒ 不可判不出题
      const denom = Math.max(1, Math.ceil(spec.stepsBudget * STAGNATION_BUDGET_RATIO));
      const stagnationRatio = Math.min(1, stagnationSteps / denom);
      const drift = scoreDrift({
        goalText: spec.goalText,
        criteria: statuses.map(c => c.criterion),
        screenText,
        stepsSinceCriterionChange: stagnationSteps,
        stepsBudget: spec.stepsBudget,
      });
      if (drift === null) return null;
      // 落账（趋势由此更新；漂移账绝不参与相位推导）
      try {
        goal?.recordDrift(drift);
      } catch {
        /* 落账异常吞掉 —— 漂移是旁路观察，绝不炸会话 */
      }
      lastDriftScore = drift;
      if (drift <= threshold) return null; // 未超阈不出题（严格大于才触警）
      // 节流：同一目标最多每 throttle 步一题（漂移账照常更新 —— 节流只限打扰，
      // 不限观察）
      if (lastAskedStep !== null && idx - lastAskedStep < throttle) return null;
      const choice = buildSteerChoice({
        criteriaStatus: statuses,
        drift,
        trend: readTrend(),
        evidence: {
          semantic_distance: Math.round(sem * 1000) / 1000,
          stagnation_steps: stagnationSteps,
          stagnation_ratio: Math.round(stagnationRatio * 1000) / 1000,
        },
        stepIndex: idx,
        diagnosisNote: safeText(diagnosisFn),
      });
      if (choice === null) return null; // 无未核判据 ⇒ 无可问（绝不误伤）
      lastAskedStep = idx;
      pendingChoice = choice;
      return choice;
    },
    pending(): SteerChoice | null {
      return pendingChoice === null ? null : { ...pendingChoice };
    },
    answer(raw: unknown): SteerAnswerResult {
      const question = pendingChoice;
      if (question === null) {
        // W5-5（缝3）：岔路换支模式 —— 无待答 steer 题且会话持卡时，"2"/"B2" 形
        // 应答触发 applyBranchChoice 换支（偏置 + 预算执法面留会话，runPilotLoop
        // 重入消费）；无卡 / 非换支形应答 ⇒ 原 no-pending 路径逐字节不变
        //（零回归红律 —— 无卡时行为与 W3-5/W4-0 逐字节一致）。
        if (w5Card !== null) {
          const k = parseBranchAnswer(raw);
          if (k !== null) {
            let choice: ReturnType<typeof applyBranchChoice> | null = null;
            try {
              choice = applyBranchChoice(w5Card, k); // 纯函数绝不抛 —— 双保险
            } catch {
              choice = null;
            }
            if (choice !== null && choice.ok === true && choice.choice && choice.bias && choice.replay) {
              const budget = choice.replay.state.budgetSteps;
              w5Bias = wrapReplayStepper(choice.replay, choice.bias.preferredActionKeys);
              const guidance: SteerBranchGuidance = {
                kind: 'branch-replay',
                k,
                chosen: {
                  signature: choice.choice.signature,
                  utility: choice.choice.utility,
                  rank: choice.choice.rank,
                },
                pivot: choice.pivot ??
                  { stepIndex: -1, recordedAt: 0, anchor: { journalLength: 0, chainTip: '' } },
                bias: { preferredActionKeys: [...choice.bias.preferredActionKeys] },
                budget_steps: budget,
                note:
                  '已换支：重放偏置与预算执法面就绪 —— 重入 autonomous_run（同 goal）即从支点带偏置续跑，' +
                  `预算 ${budget} 步，超支诚实终止（不悄悄续命）`,
              };
              return {
                status: 'branch',
                branch: guidance,
                hint: `已按应答换支至第 ${k} 候选（签名 ${choice.choice.signature}）；重放指引见 branch 字段`,
              };
            }
            return {
              status: 're-ask',
              hint:
                `岔路换支未生效：${choice?.error ?? '未知原因'} —— ` +
                `请回复 1..${cardCandidateCount(w5Card)} 的支号（单数字或 B+数字）`,
            };
          }
          // 持卡但非换支形应答：诚实申报当前可用的两种通道（有卡语境 —— 缝3 在场）
          return {
            status: 'no-pending',
            hint: '当前没有待答的 steer 问题；会话持有岔路卡，可回复支号（如 2 或 B2）换支重放',
          };
        }
        return { status: 'no-pending', hint: '当前没有待答的 steer 问题（未超阈 / 节流中 / 指纹缺席）' };
      }
      const letter = parseSteerAnswer(raw);
      if (letter === null) {
        return {
          status: 're-ask',
          question,
          hint: `无法识别应答「${String(raw).slice(0, 20)}」——请回复单个字符：A 继续 / B 改判据 / C 终止`,
        };
      }
      pendingChoice = null;
      if (letter === 'A') {
        return { status: 'answered', choice: 'A', question };
      }
      if (letter === 'B') {
        // 写回判据修正（goalState 现有 API 风格：amendCriterion 防御式绝不抛）
        let applied = false;
        try {
          applied = goal?.amendCriterion(question.amendment.criterion_index, question.amendment.to) === true;
        } catch {
          applied = false;
        }
        // W5-5（缝1）回灌通道：写回生效即入会话账（runPilotLoop 重入时 drain 消费，
        // 把修订判据 replay 进新 run 的目标机 —— 经会话状态传递）；同时铸结构化
        // 重启指引（修订后 goal 锚点摘要 + resume 语义）供工具面直达模型。
        let restart: SteerRestartGuidance | undefined;
        if (applied) {
          w5Amendments.push({
            goalText: readSpec().goalText,
            amendment: question.amendment,
          });
          restart = {
            kind: 'steer-restart',
            amended: {
              index: question.amendment.criterion_index,
              from: question.amendment.from,
              to: question.amendment.to,
            },
            goal_anchor: readGoalAnchor(),
            resume:
              '判据已修订 —— 重入 autonomous_run（同 goal）或 autonomy_resume（原 token）：' +
              '修订判据经在役 steer 会话自动回灌进新 run 的目标机（修正即新主张，状态重置未核）',
          };
        }
        return {
          status: 'answered',
          choice: 'B',
          applied,
          amendment: question.amendment,
          question,
          ...(restart !== undefined ? { restart } : {}),
          hint: applied ? '判据已按修正写回（状态重置为未核 —— 修正即新主张）；重启指引见 restart 字段' : '判据写回未生效（判据账已变化），如仍需修正请重新出题',
        };
      }
      // C：终止 —— 经目标机现有 API 记阻塞（blocked 相即环的终局相，收场语义）
      try {
        goal?.addBlocker(`W3-5 steer：用户在漂移评分 ${question.drift.score} 的抉择中选择终止（C）`);
      } catch {
        /* 阻塞落账异常吞掉 */
      }
      return { status: 'answered', choice: 'C', question, hint: '已记终止阻塞：目标机转入 blocked，自主环将收场' };
    },
    lastDrift(): number | null {
      return lastDriftScore;
    },
    // ── W5-5（缝1/缝3）：会话扩展面实现（接口可选 —— 转发面/最小桩可不实现） ──
    drainAmendments(): SteerAmendmentHandoff[] {
      const out = w5Amendments;
      w5Amendments = []; // 取走即清（一次性移交 —— 重复 drain 不重放）
      return out;
    },
    holdBranchCard(card: unknown): void {
      w5Card = card !== null && typeof card === 'object' ? (card as BranchCard) : null;
    },
    branchCard(): BranchCard | null {
      return w5Card === null ? null : ({ ...w5Card } as BranchCard);
    },
    takeBranchBias(): SteerBiasStepper | null {
      const s = w5Bias;
      w5Bias = null; // 取走即移交（一次性 —— 预算执法权归 runPilotLoop）
      return s;
    },
  };

  /** 步账兜底读取（goal.progress.stepIndex） */
  function safeProgressStep(): number {
    try {
      const p = goal?.progress;
      return typeof p?.stepIndex === 'number' && Number.isFinite(p.stepIndex) ? p.stepIndex : 0;
    } catch {
      return 0;
    }
  }

  return session;
}

// ─── W3-5：工具工厂（导出给集成层注册 —— src/tools/index.ts 是 W3-0 领地） ───

/**
 * steer_choice 查询工具（W3-5 H2）：按节律做漂移检查，超阈返回结构化选择题；
 * 未超阈 / 节流中 / 指纹缺席 ⇒ NO_PENDING_STEER（诚实缺席，绝不硬造问题）。
 * 会话（绑定目标机与指纹源）由集成层铸造后传入。
 */
export function createSteerChoiceTool(session: SteerSession) {
  return defineTool({
    name: 'steer_choice',
    description:
      'W3-5 (H2 intent-drift check): scores how far the CURRENT screen has drifted from the ' +
      'user goal (semantic cosine distance over FNV n-gram embeddings + criterion-stagnation ' +
      'fusion, fully deterministic and offline). When the score exceeds the alert threshold, ' +
      'returns a STRUCTURED single-key choice: A continue / B amend criterion (concrete ' +
      'auto-drafted fix included) / C terminate. RELAY the question to the user and wait for ' +
      'their SINGLE-CHARACTER reply, then feed it to steer_answer. Below threshold / throttled ' +
      '/ no fingerprint source ⇒ NO_PENDING_STEER (honest absence — never fabricates a question).',
    parameters: {
      step_index: {
        type: 'number',
        description: 'Current autonomous-loop step index (0-based). Drift is checked every ' +
          `${DRIFT_CHECK_INTERVAL_STEPS} steps (multiples of ${DRIFT_CHECK_INTERVAL_STEPS}).`,
      },
      entropy: {
        type: 'number',
        description: `Optional current uncertainty entropy in bits [0,1]; above ${0.95} triggers an immediate drift check.`,
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const a = (args ?? {}) as { step_index?: unknown; entropy?: unknown };
      const stepIndex =
        typeof a.step_index === 'number' && Number.isFinite(a.step_index) ? a.step_index : null;
      const entropy =
        typeof a.entropy === 'number' && Number.isFinite(a.entropy) ? a.entropy : null;
      let q: SteerChoice | null = null;
      try {
        q = session.maybeCheckAndAsk(stepIndex, entropy);
      } catch {
        q = null; // 会话任何故障 ⇒ 缺席（绝不抛给宿主）
      }
      return JSON.stringify(
        q ?? {
          status: 'NO_PENDING_STEER',
          hint: 'No drift question at this step (below threshold / throttled / fingerprint absent).',
        },
        null,
        2,
      );
    },
  });
}

/**
 * steer_answer 应答工具（W3-5 H2 + W5-5 收官闭环）：把用户的应答结算进会话。
 * A 继续（零副作用）；B 把自动生成的判据修正写回目标机（amendCriterion）并返回
 * 结构化重启指引（restart：修订后锚点摘要 + resume 语义 —— 修订判据经在役会话
 * 在 runPilotLoop 重入时自动回灌）；C 终止（经目标机现有 API 记阻塞收场）。
 * 解析容错：大小写 / 全角 / 1-2-3 / 继-改-停；垃圾输入 ⇒ RE-ASK（原题重问，
 * 绝不猜、绝不默认）。
 * W5-5（缝3）岔路模式：无待答题目且会话持卡（goal 失败终局相铸卡后注入）时，
 * "2"/"B2" 形应答换支 —— applyBranchChoice 选第 k 候选，返回重放指引（branch：
 * 支点 + 偏置 + 预算），重入 autonomous_run 即带偏置续跑（超支诚实终止）。
 */
export function createSteerAnswerTool(session: SteerSession) {
  return defineTool({
    name: 'steer_answer',
    description:
      'W3-5 (H2 intent-drift answer): settles the user\'s SINGLE-CHARACTER reply to a pending ' +
      'steer_choice question. Accepted: A/a/1/继 = continue; B/b/2/改 = amend the criterion with ' +
      'the auto-drafted fix (written back into the goal state machine, criterion resets to ' +
      'unverified); C/c/3/停 = terminate (a blocker is recorded and the loop winds down). ' +
      'Anything else (multi-char, empty, garbage) ⇒ RE-ASK: relay the question again and wait ' +
      'for exactly one character. Call ONLY after relaying a steer_choice question to the user. ' +
      'W5-5 (branch switch): when NO question is pending but the session holds a branch card ' +
      '(minted after a failed/aborted run), a reply like "2" or "B2" switches to candidate k — ' +
      'returns a branch-replay guidance (pivot + bias + budget); the replay bias is consumed on ' +
      'the next autonomous_run re-entry (over-budget honestly stops).',
    parameters: {
      answer: {
        type: 'string', required: true,
        description: 'The user\'s reply: A / B / C (case-insensitive; aliases 1/2/3, 继/改/停) for a ' +
          'pending steer question; "2" or "B2" (branch number, optional B prefix) to switch to the ' +
          'k-th candidate of the held branch card.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const a = (args ?? {}) as { answer?: unknown };
      let r: SteerAnswerResult;
      try {
        r = session.answer(a.answer);
      } catch {
        r = { status: 'no-pending', hint: 'steer 会话异常收敛为无待答题目' };
      }
      return JSON.stringify(r, null, 2);
    },
  });
}
