// src/rollbackPlanner.ts
// W4-3（R3 有界回滚 + 分支重规划）：世界级 CUA 的回滚纪律 —— 不是「再点
// 一次撤销」的赌博，而是一段可审计的复合计划：
//
//   ① 定位最后验证良好态 —— journal 回放 + LTLf 性质（只读消费 ltlf.ts）：
//      「已验证良好」= status SUCCESS 且 effect_detected !== false（判据核过/
//      动作验证过的步）。最近的良好步是回滚的锚点：其后的步才是待回滚债务。
//   ② 复合回滚计划 —— 模态逆映射表（type→全选退格、toggle→再点、scroll→
//      反向、shaper 操作→UndoRecipe 走 undoLog；其余模态如实申报 no-inverse，
//      绝不伪造逆动作）。计划有界（步数预算，与 W3-6 重放预算同量级的半额
//      原则）；超支 ⇒ 截断到最新的预算内步骤 + exceeded 诚实标记（复原验证
//      兜底 —— 不完整回滚骗不过指纹比对）。
//   ③ 破坏性逆动作过 approval 闸 —— type 的全选退格会清掉整个字段（不只
//      本次输入），这类「救一个毁一片」的逆动作绝不静默执行：每步派发前过
//      注入的审批端口，拒绝 ⇒ 立即停在安全态 + 诚实报告（绝不绕闸）。
//   ④ 复原验证 —— 回滚后场景指纹比对（容差内 = 与 W3-1 托管验证同律的
//      dHash similarity ≥ 0.9）。不复原 ⇒ 诚实报告并停在安全态（不再注入
//      替代分支 —— 从未复原的世界重规划是在流沙上盖楼）。
//   ⑤ 替代分支注入 —— 复原确认后，经 counterfactual/W3-6 岔路偏置风格
//      （preferredActionKeys 注入缝 —— 只读消费 branchCards.withSteerBias）
//      注入替代决策；分支重规划有总预算（ReplanBudgetController，超支诚实
//      终止 —— 重规划是第二尝试，不继承原任务全额预算）。
//
// 架构：纯函数核心（定位/逆映射/计划铸造/复原判定 —— 全离线可测）+ 注入
// 端口（执行/感知/审批/偏置全注入 —— 编排面不含任何物理世界触点）。
// 防御式绝不抛：一切公开面（纯函数与编排器）脏输入/端口故障一律收敛为
// 诚实返回值（no-good-state / internal-error / 保守缺省），绝不抛给调用方。
//
// 只读消费面：ltlf.ts（ltlF/violationsOf/reactTraceProperties）、
// perceptualHash.similarity、branchCards.withSteerBias（W3-6 偏置风格）、
// autonomy/counterfactual 的 ScoringContext 类型 —— 均为类型或纯函数依赖，
// 零写触点。
import { ltlF, violationsOf, reactTraceProperties, type TraceEntry, type TraceProperty } from './ltlf';
import { similarity } from './perceptualHash';
import { withSteerBias } from './branchCards';
import type { ScoringContext } from './autonomy/counterfactual';

// ─── 常量（值即边界） ───

/** 分支重规划总预算（替代分支注入后的重规划步数上限 —— 半额原则）。 */
export const REPLAN_BUDGET_STEPS = 8;
/** 复原验证容差：dHash similarity ≥ 0.9（与 reversalEscrow.DEFAULT_VERIFY_THRESHOLD
 *  同律 —— 「回到良好态」的抖动容忍带）。 */
export const RESTORATION_TOLERANCE = 0.9;

// ─── 轨迹输入面（journal 的投影 —— 定位良好态的唯一事实源） ───
// ΠΑΝ-127（D-F5 清偿）：RollbackTraceStep/sanitizeTrace/ROLLBACK_BUDGET_STEPS
// 下沉至零出边叶 rollbackPlanner.trace.ts（桶-卫星 value 二环拆解 —— 桶与卫星
// 皆改 import 叶；此处再分发保导入面兼容，行为零变化）。
export { sanitizeTrace, ROLLBACK_BUDGET_STEPS } from './rollbackPlanner.trace';
export type { RollbackTraceStep } from './rollbackPlanner.trace';
import { sanitizeTrace, type RollbackTraceStep } from './rollbackPlanner.trace';

// W6-2（doctor smell.over-engineering 清偿）：①良好态定位/②模态逆映射/③计划铸造（纯函数）
// 已分区提取至 rollbackPlanner.plan.ts（行为零变化）；导入面不变 —— 再分发。
export { isVerifiedGood, locateLastVerifiedGood, inverseForStep, buildRollbackPlan } from './rollbackPlanner.plan';
export type { GoodStateLocation, InverseModality, RollbackStep, RollbackPlan } from './rollbackPlanner.plan';
import { isVerifiedGood, locateLastVerifiedGood, inverseForStep, buildRollbackPlan } from './rollbackPlanner.plan';
import type { GoodStateLocation, RollbackStep, RollbackPlan } from './rollbackPlanner.plan';



// ─── ④ 复原验证（纯函数） ───

export type RestorationVerdict = 'verified' | 'not-restored' | 'unverified';

/** 复原验证（纯函数）：当前指纹 vs 良好态指纹，容差内即复原。
 *  任一侧缺席 ⇒ unverified（无通道 ≠ 复原 —— 诚实降级，与 escrow 同律）。 */
export function verifyRestoration(
  current: string | null | undefined,
  checkpoint: string | null | undefined,
  tolerance: number = RESTORATION_TOLERANCE,
): { verdict: RestorationVerdict; similarity?: number } {
  if (typeof checkpoint !== 'string' || checkpoint === '' || typeof current !== 'string' || current === '') {
    return { verdict: 'unverified' };
  }
  const tol = typeof tolerance === 'number' && Number.isFinite(tolerance) ? tolerance : RESTORATION_TOLERANCE;
  const sim = similarity(current, checkpoint);
  return { verdict: sim >= tol ? 'verified' : 'not-restored', similarity: Math.round(sim * 1000) / 1000 };
}

// ─── ⑤ 分支重规划预算 + 偏置注入 ───

/** 分支重规划预算状态 */
export interface ReplanBudgetState {
  status: 'armed' | 'stepping' | 'exhausted' | 'completed';
  stepsUsed: number;
  budgetSteps: number;
}

/**
 * 分支重规划预算控制器（W3-6 BranchReplayController 的镜像语义 —— 重规划
 * 是第二尝试，不继承原任务全额预算）：每步前 spend()；超支 ⇒ proceed=false
 * 诚实终止；complete() 收尾；exhausted 是终局（超支后再 complete 不改判）。
 */
export class ReplanBudgetController {
  private stepsUsed = 0;
  private status: ReplanBudgetState['status'] = 'armed';
  private readonly budgetSteps: number;
  constructor(budgetSteps: number | undefined) {
    this.budgetSteps = typeof budgetSteps === 'number' && Number.isFinite(budgetSteps)
      ? Math.max(1, Math.floor(budgetSteps)) : REPLAN_BUDGET_STEPS;
  }
  get state(): ReplanBudgetState {
    return { status: this.status, stepsUsed: this.stepsUsed, budgetSteps: this.budgetSteps };
  }
  spend(): { proceed: boolean; state: ReplanBudgetState } {
    if (this.status === 'completed') {
      return { proceed: false, state: this.state };
    }
    if (this.stepsUsed >= this.budgetSteps) {
      this.status = 'exhausted';
      return { proceed: false, state: this.state };
    }
    this.stepsUsed += 1;
    this.status = 'stepping';
    return { proceed: true, state: this.state };
  }
  complete(): void {
    if (this.status !== 'exhausted') this.status = 'completed';
  }
}

/** 替代分支注入载荷 */
export interface BranchInjection {
  /** 偏置键（counterfactual preferredActionKeys 风格 —— 命中签名的候选在
   *  择优中获得决定性加成：偏置只改选择不改预测） */
  preferredActionKeys: string[];
  /** 注入理由（审计面） */
  reason: string;
  /** 是否成功注入（端口拒绝/无键 ⇒ false 诚实） */
  injected: boolean;
  detail?: string;
  /** 重规划预算（注入后的第二尝试步账 —— 超支诚实终止） */
  replan: ReplanBudgetState;
}

/**
 * 缺省替代键推导（纯函数）：复原锚点之前**成功过**且未陷入失败尾部的模态 ——
 * 「重选此前验证有效、未参与本次失败的路线」（W3-6 岔路偏置的自带推导面：
 * 调用方未显式提供 alternativeKeys 时的保守缺省）。无可用键 ⇒ 空数组（诚实）。
 */
export function defaultAlternativeKeys(steps: readonly RollbackTraceStep[], checkpointIndex: number): string[] {
  const clean = sanitizeTrace(steps);
  const cp = Math.max(0, Math.floor(checkpointIndex));
  const goodTools = new Set<string>();
  for (let i = 0; i <= cp && i < clean.length; i++) {
    if (isVerifiedGood(clean[i])) goodTools.add(clean[i].tool);
  }
  const failedTail = new Set(clean.slice(cp + 1).map(s => s.tool));
  return [...goodTools].filter(t => !failedTail.has(t)).slice(0, 8);
}

// ─── 注入端口（一切物理/感知/审批/偏置面经注入 —— 离线可测） ───

export interface RollbackPorts {
  /** 执行端口：逆动作落到物理世界的唯一出口 */
  execute(step: RollbackStep): Promise<{ ok: boolean; detail?: string }>;
  /** 感知端口：当前场景指纹（复原验证通道；缺席/故障 ⇒ unverified 降级） */
  fingerprint(): Promise<string | null>;
  /** 审批端口：破坏性逆动作闸（缺席/抛错 ⇒ 拒绝 —— fail-closed，绝不静默） */
  requestApproval(req: { step: RollbackStep; reason: string }): Promise<{ approved: boolean; detail?: string }>;
  /** 分支偏置注入端口（缺席 ⇒ 自带偏置注入缝 —— pendingBiasOf 可读） */
  injectBias?(bias: { preferredActionKeys: string[]; reason: string }): Promise<{ ok: boolean; detail?: string }>;
}

/** 自带偏置注入缝的最近一次记录（缺省端口的落点 —— 测试/宿主可读） */
let lastBias: BranchInjection | null = null;

/** 最近一次经缺省缝注入的替代分支（无 ⇒ null；深拷贝） */
export function pendingBiasOf(): BranchInjection | null {
  return lastBias === null ? null : JSON.parse(JSON.stringify(lastBias)) as BranchInjection;
}

/**
 * W3-6 岔路偏置风格的注入端口适配器（只读消费 branchCards.withSteerBias）：
 * 把 R3 的替代分支偏置铸进 counterfactual 的 ScoringContext.preferredActionKeys
 * 注入缝（偏置只改选择不改预测 —— 与 W3-6 换支重放同一偏置协议）。biased()
 * 取出已偏置的评分上下文供重规划决策消费。
 */
export function createSteerBiasPort(initial: ScoringContext): {
  injectBias: NonNullable<RollbackPorts['injectBias']>;
  biased(): ScoringContext | null;
} {
  let biased: ScoringContext | null = null;
  return {
    injectBias: async (bias) => {
      try {
        biased = withSteerBias(initial, bias.preferredActionKeys);
        const merged = biased?.preferredActionKeys ?? [];
        const ok = bias.preferredActionKeys.every(k => merged.includes(k));
        return ok
          ? { ok: true }
          : { ok: false, detail: 'steer bias merge lost keys (empty/invalid signatures rejected by withSteerBias)' };
      } catch (e: unknown) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    },
    biased: () => biased,
  };
}

// ─── 编排器（R3 主入口 —— 纯核心 + 注入端口的唯一编织点） ───

/** 回滚结局（判别联合 —— 每条路径都有诚实的 phase 与报告） */
export type RollbackOutcome =
  | { phase: 'no-good-state'; report: string; traceAudit: TraceProperty[]; safeStop: true }
  | { phase: 'nothing-to-rollback'; checkpointIndex: number; report: string; safeStop: false }
  | {
    phase: 'approval-denied';
    /** 被拒的破坏性逆步骤 */
    denied: RollbackStep; denialDetail?: string;
    /** 已执行的逆步骤标签（LIFO 序 —— 部分回滚的事实面） */
    executedSteps: string[];
    report: string; safeStop: true;
  }
  | {
    phase: 'execution-failed';
    failed: RollbackStep; failureDetail: string;
    executedSteps: string[];
    report: string; safeStop: true;
  }
  | {
    phase: 'completed';
    checkpointIndex: number;
    plan: RollbackPlan;
    executedSteps: string[];
    skippedNoInverse: string[];
    restoration: RestorationVerdict;
    restorationDetail: string;
    restorationSimilarity?: number;
    /** 替代分支注入（仅复原 verified 时非 null —— 不复原不重规划） */
    branch: BranchInjection | null;
    /** 安全态停车：restoration !== 'verified' 时恒 true（诚实报告后不再动世界） */
    safeStop: boolean;
    report: string;
  }
  | { phase: 'internal-error'; report: string; safeStop: true };

/** 编排器选项（全可缺席 —— 防御缺省） */
export interface RollbackOptions {
  maxRollbackSteps?: number;
  replanBudgetSteps?: number;
  fingerprintTolerance?: number;
  /** 显式替代分支键（缺省 = defaultAlternativeKeys 推导） */
  alternativeKeys?: string[];
  /** 复原锚点指纹（缺省 = 良好态步自带的 fingerprint） */
  checkpointFingerprint?: string | null;
}

/** 端口防御包装：端口缺席 ⇒ fallback；抛错 ⇒ degraded（绝不炸编排器） */
async function safePort<T>(
  fn: (() => Promise<T>) | undefined,
  fallback: T,
  onThrow: (e: unknown) => T,
): Promise<T> {
  if (typeof fn !== 'function') return fallback;
  try {
    return await fn();
  } catch (e: unknown) {
    return onThrow(e);
  }
}

/**
 * 执行有界回滚 + 分支重规划注入（R3 主入口；绝不抛）：
 *   定位良好态 → 铸造有界计划 → LIFO 逐步执行（破坏性步过审批闸；执行失败
 *   即停）→ 复原验证（指纹比对容差内）→ 仅 verified 注入替代分支偏置 +
 *   交出重规划预算；not-restored / unverified ⇒ 诚实报告停安全态（unverified
 *   不注入分支 —— 「未确认复原」不满足「复原确认后」的注入前提）。
 */
export async function executeRollback(
  steps: readonly RollbackTraceStep[],
  ports: RollbackPorts,
  opts: RollbackOptions = {},
): Promise<RollbackOutcome> {
  try {
    const clean = sanitizeTrace(steps);
    const loc = locateLastVerifiedGood(clean);
    if (loc.index === null) {
      return {
        phase: 'no-good-state',
        report: 'no verified-good checkpoint found in the trace (no step with SUCCESS status and verified effect) — ' +
          'nowhere safe to roll back to; stopping',
        traceAudit: loc.traceAudit,
        safeStop: true,
      };
    }
    const cp = loc.index;
    if (cp >= clean.length - 1) {
      return {
        phase: 'nothing-to-rollback',
        checkpointIndex: cp,
        report: `last verified-good step (index ${cp}) is the final step — nothing to roll back`,
        safeStop: false,
      };
    }
    const plan = buildRollbackPlan(clean, cp, {
      ...(opts.maxRollbackSteps !== undefined ? { maxRollbackSteps: opts.maxRollbackSteps } : {}),
      ...(opts.checkpointFingerprint !== undefined ? { fingerprint: opts.checkpointFingerprint } : {}),
    });
    const executedSteps: string[] = [];
    const skippedNoInverse: string[] = [];
    let executedCount = 0;
    for (const step of plan.steps) {
      if (step.modality === 'no-inverse') {
        skippedNoInverse.push(step.payload.label);
        continue; // 无逆模态：如实申报跳过（复原验证兜底 —— 骗不过指纹）
      }
      if (executedCount >= plan.budget.maxSteps) break; // 双保险（截断后不可达）
      if (step.destructive) {
        // 破坏性逆动作过 approval 闸 —— 拒绝（含端口故障 fail-closed）⇒ 停安全态
        const verdict = await safePort(
          () => ports.requestApproval({
            step,
            reason: `destructive inverse for "${step.origin.tool}": ${step.payload.label} — this undo itself can destroy data`,
          }),
          { approved: false, detail: 'approval port absent — failing closed (destructive inverse never runs silently)' },
          (e) => ({ approved: false, detail: `approval port threw: ${e instanceof Error ? e.message : String(e)}` }),
        );
        if (!verdict.approved) {
          return {
            phase: 'approval-denied',
            denied: step,
            ...(typeof verdict.detail === 'string' && verdict.detail !== '' ? { denialDetail: verdict.detail } : {}),
            executedSteps: [...executedSteps],
            report: `destructive inverse "${step.payload.label}" was NOT approved (${verdict.detail ?? 'denied'}) — ` +
              `rollback stopped in a safe state after ${executedSteps.length} step(s); ` +
              `${plan.steps.length - executedSteps.length - skippedNoInverse.length} inverse step(s) left unexecuted`,
            safeStop: true,
          };
        }
      }
      const r = await safePort(
        () => ports.execute(step),
        { ok: false, detail: 'executor port absent — cannot perform the inverse' },
        (e) => ({ ok: false, detail: `executor threw: ${e instanceof Error ? e.message : String(e)}` }),
      );
      if (!r.ok) {
        return {
          phase: 'execution-failed',
          failed: step,
          failureDetail: r.detail ?? 'executor reported failure',
          executedSteps: [...executedSteps],
          report: `inverse "${step.payload.label}" FAILED (${r.detail ?? 'unknown'}) — rollback stopped in a safe ` +
            `state after ${executedSteps.length} step(s); the world may be partially rolled back`,
          safeStop: true,
        };
      }
      executedSteps.push(step.payload.label);
      executedCount++;
    }
    // ④ 复原验证（指纹比对 —— 容差内确认复原）
    const currentFp = await safePort(
      () => ports.fingerprint(),
      null,
      () => null, // 感知通道故障 = 无通道（诚实降级 unverified，绝不误报失败）
    );
    const verdict = verifyRestoration(currentFp, plan.checkpointFingerprint, opts.fingerprintTolerance);
    // ⑤ 替代分支注入（仅 verified —— 复原确认后才有资格重规划）
    let branch: BranchInjection | null = null;
    if (verdict.verdict === 'verified') {
      const keys = (Array.isArray(opts.alternativeKeys)
        ? opts.alternativeKeys.filter((k): k is string => typeof k === 'string' && k.trim() !== '').slice(0, 8)
        : defaultAlternativeKeys(clean, cp));
      const replan = new ReplanBudgetController(opts.replanBudgetSteps);
      const reason = `post-rollback replan from verified-good checkpoint (index ${cp}): prefer previously ` +
        `verified-effective modalities not involved in the failed tail${plan.budget.exceeded ? ' (rollback was budget-truncated — restoration verified anyway)' : ''}`;
      if (typeof ports.injectBias === 'function') {
        // 外部偏置端口（counterfactual/W3-6 岔路偏置风格 —— 只读消费方注入）
        const inj = await safePort(
          () => ports.injectBias!({ preferredActionKeys: keys, reason }),
          undefined,
          () => undefined,
        );
        branch = inj !== undefined
          ? {
            preferredActionKeys: keys, reason, injected: inj.ok,
            ...(inj.detail !== undefined ? { detail: inj.detail } : {}),
            replan: replan.state,
          }
          : {
            preferredActionKeys: keys, reason, injected: false,
            detail: 'bias port threw — injection failed honestly (replan budget NOT handed out)',
            replan: replan.state,
          };
      } else {
        // 自带偏置注入缝：无外部端口 ⇒ 记录待消费（宿主/测试经 pendingBiasOf 读）
        lastBias = {
          preferredActionKeys: keys, reason, injected: keys.length > 0,
          ...(keys.length === 0 ? { detail: 'no alternative branch keys derivable — bias recorded empty (honest)' } : {}),
          replan: replan.state,
        };
        branch = JSON.parse(JSON.stringify(lastBias)) as BranchInjection;
      }
    }
    const restorationDetail =
      verdict.verdict === 'verified'
        ? `scene fingerprint returned within tolerance of the checkpoint state (similarity ${verdict.similarity})`
        : verdict.verdict === 'not-restored'
          ? 'scene fingerprint does NOT match the checkpoint state — restoration NOT confirmed; ' +
            'stopping in a safe state (no replan from an unverified world)'
          : 'no verification channel (checkpoint fingerprint or perception absent) — restoration UNVERIFIED (honest degradation)';
    const report = `rollback of ${executedCount} inverse step(s) toward checkpoint ${cp} complete` +
      (skippedNoInverse.length > 0 ? `; ${skippedNoInverse.length} step(s) had no inverse and were skipped (flagged)` : '') +
      (plan.budget.exceeded ? `; budget exceeded (${plan.budget.requiredSteps} required > ${plan.budget.maxSteps} allowed) — plan truncated to the newest steps` : '') +
      `; restoration: ${verdict.verdict}` +
      (branch !== null && branch.injected ? `; alternative branch bias injected (${branch.preferredActionKeys.length} key(s))` : '');
    return {
      phase: 'completed',
      checkpointIndex: cp,
      plan,
      executedSteps,
      skippedNoInverse,
      restoration: verdict.verdict,
      restorationDetail,
      ...(verdict.similarity !== undefined ? { restorationSimilarity: verdict.similarity } : {}),
      branch,
      safeStop: verdict.verdict !== 'verified',
      report,
    };
  } catch (e: unknown) {
    return {
      phase: 'internal-error',
      report: `rollback planner internal error (defensive stop): ${e instanceof Error ? e.message : String(e)}`,
      safeStop: true,
    };
  }
}

/** W4-3（R3）：隔离缝（测试 beforeEach / 插件卸载）—— 自带偏置缝记录归零 */
export function resetRollbackPlanner(): void {
  lastBias = null;
}
