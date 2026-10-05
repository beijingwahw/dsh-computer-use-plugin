// src/rollbackPlanner.plan.ts
// W6-2（doctor smell.over-engineering 清偿）：自 rollbackPlanner.ts 低风险分区提取
// （>500 行拆分信号）—— ① 良好态定位 / ② 模态逆映射表 / ③ 复合回滚计划铸造
// （全部纯函数）整体搬迁。行为零变化；rollbackPlanner.ts 以再导出保持导入面不变。
import { ltlF, violationsOf, reactTraceProperties, type TraceEntry, type TraceProperty } from './ltlf';
import { similarity } from './perceptualHash';
import { withSteerBias } from './branchCards';
import type { ScoringContext } from './autonomy/counterfactual';
// ΠΑΝ-127（D-F5 清偿）：轨迹契约改从零出边叶 rollbackPlanner.trace.ts 导入
// （原自桶 rollbackPlanner.ts 借 sanitizeTrace/ROLLBACK_BUDGET_STEPS 构成桶-卫星
// value 二环；桶面同名符号仍经再分发可用 —— 导入面零破坏，行为零变化）。
import { sanitizeTrace, ROLLBACK_BUDGET_STEPS } from './rollbackPlanner.trace';
import type { RollbackTraceStep } from './rollbackPlanner.trace';

// ─── ① 良好态定位（纯函数 —— LTLf 只读消费） ───

/** 良好步判据：判据核过（status SUCCESS）且动作验证过（effect_detected === true）。
 *  未验证（undefined）不算良好 —— 「已验证良好」的字面义（验证过 ≠ 没失败），
 *  宁缺毋滥：回滚锚点必须是「世界被确认处于预期态」的时刻。 */
export function isVerifiedGood(step: RollbackTraceStep): boolean {
  return step.status === 'SUCCESS' && step.effect_detected === true;
}

/** 良好态定位结果 */
export interface GoodStateLocation {
  /** 最近的已验证良好步索引（null = 轨迹上无良好态 —— 诚实缺席） */
  index: number | null;
  /** 良好态步自带的场景指纹（复原验证锚点；缺席 ⇒ null 诚实） */
  fingerprint: string | null;
  /** LTLf 审计：ReAct 性质违例（定位面顺带的判决书 —— 调用方可上报） */
  traceAudit: TraceProperty[];
  /** 非良好位数（violationsOf(¬good) 的计数 —— 回滚债务规模的审计面） */
  nonGoodPositions: number;
}

/**
 * 定位最后验证良好态（纯函数）：journal 回放 + LTLf 性质。
 *   · ltlF(good, n) 断言良好步存在性（不存在 ⇒ index:null —— 「没有良好态
 *     可退」是诚实结论，不是错误）；
 *   · 反向扫描取**最近**的良好步（回滚锚点越近，债务越少）；
 *   · violationsOf(¬good) 给出非良好位清单（规模入审计面）；
 *   · reactTraceProperties 顺带产出 ReAct 判决书（blind-start / 观察饥饿 /
 *     盲区连击 —— 回滚报告的审计附页）。绝不抛。
 */
export function locateLastVerifiedGood(steps: readonly RollbackTraceStep[]): GoodStateLocation {
  const clean = sanitizeTrace(steps);
  const n = clean.length;
  const good = (i: number) => isVerifiedGood(clean[i]);
  const audit = reactTraceProperties(clean.map(s => ({
    tool: s.tool,
    observed: true,           // 定位面无观察信息 ⇒ 不冒充盲启动（观察审计归 journal 侧）
    effect: s.effect_detected,
  } as TraceEntry)));
  const nonGood = violationsOf((i: number) => !good(i), n).length;
  if (!ltlF(good, n)) {
    return { index: null, fingerprint: null, traceAudit: audit, nonGoodPositions: nonGood };
  }
  for (let i = n - 1; i >= 0; i--) {
    if (good(i)) {
      return { index: i, fingerprint: clean[i].fingerprint ?? null, traceAudit: audit, nonGoodPositions: nonGood };
    }
  }
  return { index: null, fingerprint: null, traceAudit: audit, nonGoodPositions: nonGood }; // 防御式不可达
}

// ─── ② 模态逆映射表（纯函数） ───

/** 逆动作模态 */
export type InverseModality =
  | 'select-all-backspace'  // type_text → 全选退格（破坏性 —— 过审批闸）
  | 're-click-toggle'       // toggle 点击 → 再点一次（精确逆）
  | 'reverse-scroll'        // scroll → 反向滚动同量（精确逆）
  | 'shaper-undo'           // 环境重塑 → UndoRecipe 走 undoLog
  | 'no-inverse';           // 无已知逆模态 —— 如实申报，绝不伪造

/** 复合回滚计划的单步（可序列化 —— 端口载荷自包含） */
export interface RollbackStep {
  /** 被回滚的原始步（审计面） */
  origin: { tool: string; args?: Record<string, unknown> };
  modality: InverseModality;
  /** 破坏性逆动作（派发前必过 approval 闸 —— 绝不静默执行） */
  destructive: boolean;
  /** 执行载荷（经端口落到物理世界；label 供审计/报告） */
  payload: {
    label: string;
    /** select-all-backspace 的键序 */
    keys?: string[][];
    /** re-click-toggle 的归一化坐标 */
    x?: number; y?: number;
    /** reverse-scroll 的反向量 */
    dx?: number; dy?: number;
    /** shaper-undo 的撤销令牌（shaper undoLog 寻址） */
    undoToken?: string;
  };
}

/** toggle 判别：显式标记或目标描述命中开关语义（checkbox/toggle/开关/复选） */
function isToggleClick(args: Record<string, unknown>): boolean {
  if (args.toggle === true || args.is_toggle === true || args.isToggle === true) return true;
  const desc = args.target_description ?? args.targetDescription;
  return typeof desc === 'string' && /toggle|checkbox|switch|开关|复选/i.test(desc);
}

function finiteNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 模态逆映射（纯函数）：一步 → 其逆动作描述。无逆模态 ⇒ no-inverse 如实申报。 */
export function inverseForStep(step: RollbackTraceStep): RollbackStep {
  const tool = typeof step.tool === 'string' ? step.tool : '';
  const args = (step.args && typeof step.args === 'object' && !Array.isArray(step.args)
    ? step.args : {}) as Record<string, unknown>;
  const origin = { tool, ...(Object.keys(args).length > 0 ? { args } : {}) };
  if (tool === 'type_text') {
    return {
      origin, modality: 'select-all-backspace', destructive: true,
      payload: {
        label: 'select-all + backspace to clear the typed text',
        keys: [['ctrl', 'a'], ['backspace']],
      },
    };
  }
  if (tool === 'click_mouse' || tool === 'click_element') {
    if (isToggleClick(args)) {
      const x = finiteNum(args.x); const y = finiteNum(args.y);
      return {
        origin, modality: 're-click-toggle', destructive: false,
        payload: {
          label: 're-click the toggle to flip it back (exact inverse)',
          ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}),
        },
      };
    }
    return {
      origin, modality: 'no-inverse', destructive: false,
      payload: { label: `generic "${tool}" has no automatic inverse — flagged for manual compensation` },
    };
  }
  if (tool === 'scroll_page') {
    const dy = finiteNum(args.dy) ?? finiteNum(args.amount);
    const dx = finiteNum(args.dx);
    return {
      origin, modality: 'reverse-scroll', destructive: false,
      payload: {
        label: 'scroll the opposite amount (exact inverse)',
        ...(dy !== undefined ? { dy: -dy } : {}), ...(dx !== undefined ? { dx: -dx } : {}),
      },
    };
  }
  if (tool === 'shaper' || tool === 'shape_environment') {
    const token = typeof args.undoToken === 'string' ? args.undoToken : undefined;
    return {
      origin, modality: 'shaper-undo', destructive: false,
      payload: {
        label: token
          ? `restore shaper change via undoLog record "${token}"`
          : 'restore shaper changes via undoLog (full LIFO fallback)',
        ...(token !== undefined ? { undoToken: token } : {}),
      },
    };
  }
  return {
    origin, modality: 'no-inverse', destructive: false,
    payload: { label: `"${tool}" has no registered inverse modality` },
  };
}

// ─── 复合回滚计划（纯函数铸造） ───

/** 复合回滚计划 */
export interface RollbackPlan {
  /** 回滚锚点（最后验证良好步索引） */
  checkpointIndex: number;
  /** 良好态场景指纹（复原验证锚点；null = 无锚点 ⇒ 验证降级 unverified） */
  checkpointFingerprint: string | null;
  /** 逆步骤（LIFO 序：后做的先还原 —— 与 shaper.restoreAll 同律） */
  steps: RollbackStep[];
  /** 破坏性逆步骤（全部须过 approval 闸） */
  destructiveSteps: RollbackStep[];
  /** 无逆模态的原始工具清单（诚实申报面 —— 这些步无法自动回滚） */
  noInverseTools: string[];
  /** 步数预算账 */
  budget: {
    maxSteps: number;
    /** 回到良好态实际需要的可执行逆步数 */
    requiredSteps: number;
    /** 超支 ⇒ 已截断到最新的预算内步骤（诚实标记 —— 复原验证兜底） */
    exceeded: boolean;
  };
}

/** 铸造复合回滚计划（纯函数）：良好态之后的每步 → 逆映射 → LIFO 排序 →
 *  预算执法（可执行逆步 > maxSteps ⇒ 截断保最新 + exceeded 标记）。绝不抛。 */
export function buildRollbackPlan(
  steps: readonly RollbackTraceStep[],
  checkpointIndex: number,
  opts: { maxRollbackSteps?: number; fingerprint?: string | null } = {},
): RollbackPlan {
  const clean = sanitizeTrace(steps);
  const maxSteps = typeof opts.maxRollbackSteps === 'number' && Number.isFinite(opts.maxRollbackSteps)
    ? Math.max(1, Math.floor(opts.maxRollbackSteps)) : ROLLBACK_BUDGET_STEPS;
  const cpFp = (typeof opts.fingerprint === 'string' && opts.fingerprint !== ''
    ? opts.fingerprint : clean[checkpointIndex]?.fingerprint) ?? null;
  const debt = clean.slice(Math.max(0, Math.floor(checkpointIndex) + 1));
  const inverses = debt.map(inverseForStep);
  const lifo = [...inverses].reverse(); // 后做的先还原
  const executable = lifo.filter(s => s.modality !== 'no-inverse');
  const requiredSteps = executable.length;
  let finalSteps = lifo;
  let exceeded = false;
  if (requiredSteps > maxSteps) {
    // 截断保最新（LIFO 序的前 maxSteps 个可执行步 + 其间的 no-inverse 审计步）
    exceeded = true;
    const kept: RollbackStep[] = [];
    let count = 0;
    for (const s of lifo) {
      if (s.modality !== 'no-inverse') {
        if (count >= maxSteps) continue;
        count++;
      }
      kept.push(s);
    }
    finalSteps = kept;
  }
  return {
    checkpointIndex: Math.max(0, Math.floor(checkpointIndex)),
    checkpointFingerprint: cpFp,
    steps: finalSteps,
    destructiveSteps: finalSteps.filter(s => s.destructive),
    noInverseTools: [...new Set(finalSteps.filter(s => s.modality === 'no-inverse').map(s => s.origin.tool))],
    budget: { maxSteps, requiredSteps, exceeded },
  };
}
