// src/autonomy/autoPilot.ts
// 纪元 Φ（Φ-4 核心闭环驱动器）：识别 → 判断 → 宪法 → 执行 → 验证 → 进化 的自主智能环主脉。
// 本文件只做"环"：世界感子（Φ-2）、策略引擎（Φ-3）、目标机（Φ-1）、宪法（Φ-8）全部经
// AutonomyDeps 注入 —— 时间（now）与睡眠（sleep）同样注入，离线测试零真钟零真睡。
// 铁律：具名导出、绝不抛异常（任何依赖异常都收敛为 error 步，绝不炸环）。
import type { GoalPhase, GoalSpec, GoalStateMachine } from './goalState';
import type { PolicyAction, PolicyContext, PolicyDecision, StepOutcome } from './policyEngine';
import type { WorldSnapshot } from './worldSnapshot';
import type { ConstitutionContext, ConstitutionVerdict, RiskTier } from './autonomyConstitution';

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
  /** 升级归因：'constitution-veto' | 'approval-required' | 'policy-escalate' */
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
  /** 每步入轨迹后的观察者回调（回调自身异常被吞掉，绝不炸环） */
  onStep?: (step: StepRecord) => void;
  /** 注入睡眠（wait 动作沉降用；缺省真睡 setTimeout） */
  sleep?: (ms: number) => Promise<void>;
  /** 注入时钟（缺省 Date.now） */
  now?: () => number;
}

/** 执行器回报的本地别名（避免重复内联结构） */
type ExecResult = Awaited<ReturnType<AutonomyDeps['execute']>>;

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
 *  ② perceive() 感知 —— 异常 ⇒ 合成 declare 动作记 error 步并推进目标机评估；
 *  ③ 组装 PolicyContext（history 逐步步累积；budgetRemaining 由 spec 与已耗步/毫秒推算）
 *     → policy.decide —— 异常或缺 action ⇒ error 步收敛；
 *  ④ constitution.check(action, { goalText, consecutiveNoEffect, stepsTaken }) ——
 *     allowed=false ⇒ escalated 终局（escalateReason='constitution-veto'，终局相取
 *     goal.evaluate()，summary 写明宪法理由，被否决动作不入轨迹不执行）；
 *     requiresApproval ⇒ escalated 终局（escalateReason='approval-required'）；
 *  ⑤ 动作 kind='escalate' ⇒ 记 no_effect 升级步后 escalated 终局（不执行）；
 *  ⑥ 动作 kind='wait' ⇒ sleep(opts.settleMs ?? 300) 沉降后记 no_effect 步继续（不执行）；
 *  ⑦ execute(action) —— 异常或缺 outcome ⇒ error 步收敛；正常则 StepRecord 入轨迹
 *     （effectiveRiskTier = 宪法判决分层盖章，垃圾判决值视为缺席）；
 *  ⑧ criteriaEvidence 逐条 goal.recordCriterion（回填异常吞掉）；
 *  ⑨ goal.tick() → goal.evaluate()：achieved/failed/aborted/blocked 任一终局相即熔断；
 *  ⑩ 每步入轨迹即触发 onStep（回调异常吞掉）。
 * 任何依赖异常都不炸环；所有时间取注入时钟。
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
  // maxSteps 同律防御（与 goalState 构造器「非法 ⇒ 降级 24」一致）：stub 依赖给出
  // NaN/0/非数会把 stepCap 变 NaN（保险丝永不熔断 ⇒ 挂死）或 0（秒中止）
  const specMaxSteps = typeof spec.maxSteps === 'number' && Number.isFinite(spec.maxSteps) && spec.maxSteps >= 1
    ? spec.maxSteps
    : undefined;
  const stepCap = opts?.maxSteps ?? specMaxSteps ?? DEFAULT_MAX_STEPS;
  const timeBudgetMs = typeof spec.timeBudgetSec === 'number' ? spec.timeBudgetSec * 1000 : null;

  let lastPhase: GoalPhase = 'planning';
  let lastReason = '';
  let escalated = false;
  let escalateReason: string | undefined;
  let summaryCore = '';
  let lastDhash: string | null = null;

  /** 步落账：入轨迹 + 计步 + 通知观察者（观察者异常吞掉）；宪法判决分层可选盖章 */
  const recordStep = (
    action: PolicyAction,
    outcome: StepOutcome,
    snapshotDhash: string | null,
    note?: string,
    effectiveRiskTier?: RiskTier,
  ): void => {
    const rec: StepRecord = { stepIndex: stepsTaken, action, outcome, snapshotDhash, at: now() };
    if (note !== undefined) rec.note = note;
    if (effectiveRiskTier !== undefined) rec.effectiveRiskTier = effectiveRiskTier;
    trajectory.push(rec);
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

  while (true) {
    // ① 步保险丝：到顶强制 aborted（优先于一切依赖调用，防依赖失控拖死环）
    if (stepsTaken >= stepCap) {
      lastPhase = 'aborted';
      summaryCore = `步数保险丝熔断（上限 ${stepCap} 步）`;
      break;
    }

    // ①′ 环顶终局相位预判：每轮 perceive 前先问目标机（纪元 Δ 修律——
    //    首次相位判定原本在 execute 之后，blocked-at-begin 仍会漏发一个真动作；
    //    预置 blocker / 判据已全 met 的目标机在此零感知零判断零执行直接收场）
    if (evaluateGoal()) break;

    // ② 感知（异常 ⇒ error 步收敛，不炸环）
    let snapshot: WorldSnapshot;
    try {
      snapshot = await deps.perceive();
      lastDhash = snapshot && typeof snapshot.dhash === 'string' ? snapshot.dhash : null;
    } catch (err) {
      recordStep(syntheticDeclareAction('perceive'), 'error', null, `perceive: ${errText(err)}`);
      if (advanceGoal()) break;
      continue;
    }

    // ③ 判断：组装上下文（history 累积 / 预算推算）→ policy.decide
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
      if (advanceGoal()) break;
      continue;
    }
    const action: PolicyAction | null = decision && decision.action ? decision.action : null;
    if (!action) {
      recordStep(syntheticDeclareAction('policy'), 'error', lastDhash, 'policy: decide 返回缺少 action 的决定');
      if (advanceGoal()) break;
      continue;
    }

    // ④ 宪法裁决（异常/空裁决 ⇒ error 步收敛）
    let consecutiveNoEffect = 0;
    for (let i = trajectory.length - 1; i >= 0 && trajectory[i].outcome === 'no_effect'; i--) {
      consecutiveNoEffect++;
    }
    let verdict: ConstitutionVerdict;
    try {
      verdict = constitution.check(action, { goalText: spec.goal, consecutiveNoEffect, stepsTaken });
    } catch (err) {
      recordStep(action, 'error', lastDhash, `constitution: ${errText(err)}`);
      if (advanceGoal()) break;
      continue;
    }
    if (!verdict) {
      recordStep(action, 'error', lastDhash, 'constitution: check 返回空裁决');
      if (advanceGoal()) break;
      continue;
    }
    if (verdict.allowed === false) {
      // 否决终局：终局相取目标机；被否决动作不算一步世界推进（不 tick 不入轨迹）
      escalated = true;
      escalateReason = 'constitution-veto';
      evaluateGoal();
      summaryCore = `宪法否决：${verdict.reason}`;
      break;
    }
    if (verdict.requiresApproval === true) {
      // 审批终局：动作放行但必须人工确认 ⇒ 升级移交
      escalated = true;
      escalateReason = 'approval-required';
      evaluateGoal();
      summaryCore = `动作需人工审批：${verdict.reason}`;
      break;
    }

    // ⑤ 策略主动升级 ⇒ 记 no_effect 升级步后终局（不执行）
    if (action.kind === 'escalate') {
      recordStep(action, 'no_effect', lastDhash, decision.note);
      escalated = true;
      escalateReason = 'policy-escalate';
      evaluateGoal();
      summaryCore = `策略主动升级：${action.rationale}`;
      break;
    }

    // ⑥ wait 动作 ⇒ 注入式沉降后继续（不执行，记 no_effect 步）
    if (action.kind === 'wait') {
      try { await sleep(opts?.settleMs ?? DEFAULT_SETTLE_MS); } catch { /* 睡眠异常吞掉 */ }
      recordStep(action, 'no_effect', lastDhash, decision.note);
      if (advanceGoal()) break;
      continue;
    }

    // ⑦ 执行（异常/缺 outcome ⇒ error 步收敛）
    let exec: ExecResult | null = null;
    try {
      exec = await deps.execute(action);
    } catch (err) {
      recordStep(action, 'error', lastDhash, `execute: ${errText(err)}`);
      if (advanceGoal()) break;
      continue;
    }
    if (!exec || !exec.outcome) {
      recordStep(action, 'error', lastDhash, 'execute: 返回值缺少 outcome');
      if (advanceGoal()) break;
      continue;
    }

    // ⑧ 验证：步入轨迹（宪法判决分层盖章）+ 判据证据逐条回填目标机（回填异常吞掉）
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

    // ⑨ 进化位：tick 后终局评估（achieved/failed/aborted/blocked 任一即熔断）
    if (advanceGoal()) break;
  }

  if (!summaryCore) summaryCore = lastReason ? `目标机判定：${lastReason}` : '循环收敛退出';

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
