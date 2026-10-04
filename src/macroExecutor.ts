// src/macroExecutor.ts
// W4-1（创新提案 A1）：技能宏重放执行器 —— 把 skillLibrary 的死知识变成
// 可执行的参数化宏。三条世界级铁律的代码化：
//   · 重锚定非盲重放 —— 链内坐标槽绝不按原坐标回放：按元素标签/几何经注入
//     的重锚定端口（elementTracker 风格 IoU 匹配当前帧元素）重解算；重锚定
//     失败 ⇒ 该步降级跳过并记 degraded，绝不盲点原坐标（UI 会漂移，原坐标
//     是归纳时点的遗物，不是当下的真相）；
//   · 链内节奏 —— 跳过逐步 VLM 决策（宏的意义就是免逐步咨询），保留 dhash
//     抽查：每 MACRO_SPOT_PERIOD 步一次（W1-1 verifyAfter 的抽查同律），
//     连续两次「世界纹丝不动」⇒ 诚实中止（盲放无效果的宏是浪费不是坚持）；
//   · 防御式绝不抛 —— 一切失败收敛为判词与 degraded 标签，任何注入物炸裂
//     都不击穿调用方；链执行有步数/时长预算，超支诚实中止。
// 依赖全注入（dispatch/spotCheck/anchors/rehearsal 全是端口）—— 离线测试
// 注入假件；runtime 与 skillTools 是两个生产宿主。
import { skillLibrary, betaReliability, type SkillStep, type TemplateHoleReader } from './skillLibrary';
import { sharedMacroRehearsalGate, type MacroRehearsalGate, type MacroRehearsalSceneInput } from './sandbox/macroRehearsal';

// W6-2（doctor smell.over-engineering 清偿）：W4-1 重锚定（标签 + IoU 双通道）已分区
// 提取至 macroExecutor.reanchor.ts（行为零变化）；导入面不变 —— 再分发。
import { defaultReanchor, type ReanchorPort, type ReanchorHit, type MacroAnchorElement } from './macroExecutor.reanchor';
export { defaultReanchor, REANCHOR_IOU_GATE, REANCHOR_WINDOW_MIN, REANCHOR_WINDOW_MAX } from './macroExecutor.reanchor';
export type { ReanchorPort, ReanchorHit, ReanchorRequest, MacroAnchorElement } from './macroExecutor.reanchor';



// ─── W4-1：宏解析（技能/模板 → 动作链） ───

/** W4-1：宏定位入参（skillId 直取 / templateId 绑洞；args 是参数化宏的实参） */
export interface MacroResolveInput {
  skillId?: number;
  templateId?: number;
  /** 参数化实参：text 覆盖链内 type_text 的文本槽；target 是坐标步的重锚定标签提示 */
  args?: { target?: string; text?: string };
  /** 模板绑洞的世界读取面（缺席 ⇒ 模板路径只能绑常量洞 ⇒ 大概率回退字面量） */
  holeReader?: TemplateHoleReader;
}

/** W4-1：宏解析判词 */
export type MacroResolveResult =
  | {
    ok: true;
    steps: SkillStep[];
    source: { kind: 'skill' | 'template' | 'fallback-skill'; id: number; name: string };
    /** source.kind='fallback-skill' 时的模板失败归因（审计面） */
    fallbackReason?: string;
  }
  | { ok: false; reason: 'library-disabled' | 'not-found' | 'empty-chain' | 'template-bind-failed'; detail: string };

/** W4-1：字面量技能的 Beta 后验均值（排练门禁的可靠度口径 —— recordOutcome 账本的导出值） */
export function skillReliability(skillId: number): number | null {
  const s = skillLibrary.get(skillId);
  if (!s) return null;
  return betaReliability(s.successCount, s.attemptCount).mean;
}

/**
 * W4-1：宏解析（纯编排、绝不抛）：
 *   · skillId 在场 ⇒ 字面量技能直取（库禁用/未找到/空链 ⇒ 诚实失败）；
 *   · templateId 在场 ⇒ bindTemplate 绑洞（holeReader 读取当前世界），
 *     绑定失败 ⇒ 回退模板 parents 中可靠度最高的字面量技能（W3-2 已定义
 *     此语义 —— 零行为损失），回退也无 ⇒ 失败；
 *   · args.text 在场 ⇒ 覆盖链内全部 type_text 步的 text 槽（参数化宏动作：
 *     同一骨架换文本重放）；args.target 记入解析判词（执行期作重锚定提示）。
 */
export function resolveMacroChain(input: MacroResolveInput): MacroResolveResult {
  try {
    const args = input.args && typeof input.args === 'object' ? input.args : {};
    const paramText = typeof args.text === 'string' && args.text !== '' ? args.text : undefined;

    if (typeof input.templateId === 'number' && Number.isFinite(input.templateId)) {
      const bind = skillLibrary.bindTemplate(input.templateId, input.holeReader ?? ((): undefined => undefined));
      if (bind.ok) {
        const tpl = skillLibrary.getTemplate(input.templateId);
        const steps = applyTextParam(bind.steps, paramText);
        if (steps.length === 0) {
          return { ok: false, reason: 'empty-chain', detail: `模板 ${input.templateId} 绑定产物为空链` };
        }
        return {
          ok: true, steps,
          source: { kind: 'template', id: input.templateId, name: tpl?.name ?? `tpl-${input.templateId}` },
        };
      }
      // 绑定失败 ⇒ 回退字面量技能（W3-2 语义：模板不适用 ≠ 任务不可达）
      const tpl = skillLibrary.getTemplate(input.templateId);
      const parents = Array.isArray(tpl?.parents) ? tpl!.parents : [];
      let best: { id: number; name: string; rel: number } | null = null;
      for (const pid of parents) {
        const s = skillLibrary.get(pid);
        if (!s || s.steps.length === 0) continue;
        const rel = betaReliability(s.successCount, s.attemptCount).mean;
        if (!best || rel > best.rel) best = { id: s.id, name: s.name, rel };
      }
      if (best) {
        const s = skillLibrary.get(best.id)!;
        return {
          ok: true, steps: applyTextParam(s.steps, paramText),
          source: { kind: 'fallback-skill', id: best.id, name: best.name },
          fallbackReason: `模板 ${input.templateId} 绑定失败（${bind.reason}）—— 回退母体技能`,
        };
      }
      return {
        ok: false, reason: 'template-bind-failed',
        detail: `模板 ${input.templateId} 绑定失败（${bind.reason}）且无可回退母体技能`,
      };
    }

    if (typeof input.skillId !== 'number' || !Number.isFinite(input.skillId)) {
      return { ok: false, reason: 'not-found', detail: '宏定位缺席（skillId/templateId 均未给出）' };
    }
    const s = skillLibrary.get(input.skillId);
    if (!s) return { ok: false, reason: 'not-found', detail: `技能 #${input.skillId} 不在库` };
    if (!Array.isArray(s.steps) || s.steps.length === 0) {
      return { ok: false, reason: 'empty-chain', detail: `技能 #${input.skillId} 是空链` };
    }
    return {
      ok: true, steps: applyTextParam(s.steps, paramText),
      source: { kind: 'skill', id: s.id, name: s.name },
    };
  } catch (e: any) {
    return { ok: false, reason: 'not-found', detail: `解析内部异常（${e?.message ?? 'unknown'}）—— 防御式失败` };
  }
}

/** W4-1：文本参数覆盖（type_text 步的 text 槽 —— 参数化宏的实参注入点） */
function applyTextParam(steps: SkillStep[], text: string | undefined): SkillStep[] {
  if (text === undefined) return steps.map(s => ({ tool: s.tool, args: { ...s.args } }));
  return steps.map(s => ({
    tool: s.tool,
    args: s.tool === 'type_text' ? { ...s.args, text } : { ...s.args },
  }));
}

// ─── W4-1：宏执行（节奏 / 预算 / 轨迹） ───

/** W4-1：链执行预算（步数 + 时长 —— 超支诚实中止） */
export interface MacroExecutionBudget {
  maxSteps: number;
  timeoutMs: number;
}

export const MACRO_DEFAULT_BUDGET: Readonly<MacroExecutionBudget> = { maxSteps: 24, timeoutMs: 30_000 };
/** W4-1：dhash 抽查周期（每 2 步一次 —— 与 W1-1 判据抽查同哲学：成本克制） */
export const MACRO_SPOT_PERIOD = 2;
/** W4-1：抽查反证中止线（连续 N 次世界纹丝不动 ⇒ 中止宏） */
export const MACRO_SPOT_FLAT_ABORT = 2;

/** W4-1：单步派发结果（物理宿主的回执） */
export interface MacroDispatchResult {
  ok: boolean;
  note: string;
}

/** W4-1：宏执行的全部注入端口（离线测试的生命线） */
export interface MacroRunnerDeps {
  /** 单步物理派发（宿主接线：runtime 的 system 键鼠 / skillTools 的 replayOne） */
  dispatch: (step: SkillStep) => Promise<MacroDispatchResult>;
  /**
   * dhash 抽查（每 MACRO_SPOT_PERIOD 步一次）：true = 世界动了 / false =
   * 纹丝不动（反证）/ null = 证据缺席（不反证）。缺席 ⇒ 不抽查（诚实降级，
   * 绝不因此中止链）。
   */
  spotCheck?: () => Promise<boolean | null>;
  /** 当前帧锚点证据（重锚定 + 排练场景的共同证据源）；缺席 ⇒ 坐标步全降级 */
  anchors?: () => ReadonlyArray<MacroAnchorElement>;
  /** 重锚定端口（缺省 defaultReanchor） */
  reanchor?: ReanchorPort;
  /** 排练门禁（缺省共享单例 —— reliable < 0.5 / 模板产物必排练） */
  rehearsal?: MacroRehearsalGate;
  /** 排练场景供给（缺省用 anchors 铸造 —— 同一证据源） */
  rehearsalScene?: () => ReadonlyArray<MacroRehearsalSceneInput> | undefined;
  /** 注入时钟（缺省 Date.now —— 预算测试确定性） */
  now?: () => number;
  /** 预算覆盖 */
  budget?: Partial<MacroExecutionBudget>;
}

/** W4-1：单步轨迹 */
export interface MacroStepTrace {
  index: number;
  tool: string;
  status: 'executed' | 'degraded-skip' | 'dispatch-failed' | 'unresolved';
  /** 重锚定归因（坐标步必有；失败时 via 缺席） */
  reanchor?: { via: 'label' | 'iou' | 'contain'; label: string; to: { x: number; y: number } };
  note: string;
}

/** W4-1：宏执行轨迹（工具结果与 ExecOutcome note 的共同原料） */
export interface MacroTrace {
  ok: boolean;
  source: { kind: 'skill' | 'template' | 'fallback-skill'; id: number; name: string };
  steps: MacroStepTrace[];
  spotChecks: Array<{ afterStep: number; changed: boolean | null }>;
  degraded: string[];
  aborted: string | null;
  rehearsalGate: {
    required: boolean;
    verdict: 'not-required' | 'passed' | 'failed' | 'degraded';
    allowed: boolean;
    muscleEntryId?: string;
    note: string;
  };
  reliability: number;
  elapsedMs: number;
  budget: MacroExecutionBudget;
  resolveNote: string;
}

/** W4-1：需要重锚定的工具集（args 携带数值坐标槽的步 —— click/drag 族） */
const COORD_TOOLS = new Set(['click_mouse', 'drag_mouse']);

/**
 * W4-1：宏执行主入口（绝不抛 —— 一切失败收敛为轨迹判词）。
 * 流程：解析 → 排练门禁 → 逐步「重锚定 → 派发 →（每 2 步）抽查」→ 预算执法。
 * 判 ok 律：≥1 步 executed 且未被门禁拒绝且未因抽查反证中止。
 */
export async function executeMacro(
  input: MacroResolveInput,
  deps: MacroRunnerDeps,
): Promise<MacroTrace> {
  const now = deps.now ?? ((): number => Date.now());
  const budget: MacroExecutionBudget = {
    maxSteps: Math.max(1, Math.floor(deps.budget?.maxSteps ?? MACRO_DEFAULT_BUDGET.maxSteps)),
    timeoutMs: Math.max(1, deps.budget?.timeoutMs ?? MACRO_DEFAULT_BUDGET.timeoutMs),
  };
  const t0 = now();
  const emptyGate = { required: false, verdict: 'not-required' as const, allowed: true, note: '' };
  const base = (over: Partial<MacroTrace>): MacroTrace => ({
    ok: false,
    source: { kind: 'skill', id: -1, name: '(unresolved)' },
    steps: [],
    spotChecks: [],
    degraded: [],
    aborted: null,
    rehearsalGate: emptyGate,
    reliability: 0,
    elapsedMs: 0,
    budget,
    resolveNote: '',
    ...over,
  });

  // ① 解析
  const resolved = resolveMacroChain(input);
  if (!resolved.ok) {
    return base({
      degraded: ['resolve-failed'],
      resolveNote: `宏解析失败（${resolved.reason}）：${resolved.detail}`,
      elapsedMs: now() - t0,
    });
  }
  const resolveNote = resolved.source.kind === 'fallback-skill' && resolved.fallbackReason
    ? `${resolved.fallbackReason}` : `宏源自 ${resolved.source.kind} #${resolved.source.id}「${resolved.source.name}」`;

  // ② 可靠度 + 排练门禁（模板产物恒必排练 —— 年轻证据零账本，数值闸无意义）
  const reliability = resolved.source.kind === 'template'
    ? (skillLibrary.getTemplate(resolved.source.id)
      ? betaReliability(skillLibrary.getTemplate(resolved.source.id)!.successCount,
        skillLibrary.getTemplate(resolved.source.id)!.attemptCount).mean
      : 0.5)
    : (skillReliability(resolved.source.id) ?? 0);
  const gate = deps.rehearsal ?? sharedMacroRehearsalGate;
  const scene = deps.rehearsalScene
    ? deps.rehearsalScene()
    : ((): ReadonlyArray<MacroRehearsalSceneInput> | undefined => {
      const anchors = deps.anchors?.() ?? [];
      return anchors.length > 0
        ? anchors.map(a => ({ label: a.label, bbox: a.bbox }))
        : undefined;
    })();
  const gateVerdict = gate.gate({
    reliability,
    steps: resolved.steps,
    scene,
    forceRehearsal: resolved.source.kind === 'template',
    trigger: `macro ${resolved.source.kind}#${resolved.source.id}`,
  });
  const gateBlock: MacroTrace | null = gateVerdict.allowed
    ? null
    : base({
      degraded: ['gate-rejected'],
      aborted: 'rehearsal-gate',
      source: resolved.source,
      reliability,
      resolveNote,
      rehearsalGate: gateVerdict,
      elapsedMs: now() - t0,
    });
  if (gateBlock) return gateBlock;

  // ③ 逐步执行（重锚定 → 派发 → 抽查节奏 → 预算执法）
  const reanchor = deps.reanchor ?? defaultReanchor;
  const paramTarget = typeof input.args?.target === 'string' && input.args.target !== ''
    ? input.args.target : undefined;
  const steps: MacroStepTrace[] = [];
  const spotChecks: MacroTrace['spotChecks'] = [];
  const degraded = new Set<string>();
  let executed = 0;
  let flatRun = 0;
  let aborted: string | null = null;

  for (let i = 0; i < resolved.steps.length; i++) {
    if (i >= budget.maxSteps) {
      aborted = `budget-steps(${budget.maxSteps})`;
      degraded.add('budget-steps');
      break;
    }
    if (now() - t0 > budget.timeoutMs) {
      aborted = `budget-ms(${budget.timeoutMs})`;
      degraded.add('budget-ms');
      break;
    }
    const raw = resolved.steps[i];
    let step: SkillStep = { tool: raw.tool, args: { ...raw.args } };

    // 重锚定：坐标槽绝不按原坐标回放（红律）
    if (COORD_TOOLS.has(step.tool)) {
      const x = typeof step.args.x === 'number' && Number.isFinite(step.args.x) ? step.args.x : null;
      const y = typeof step.args.y === 'number' && Number.isFinite(step.args.y) ? step.args.y : null;
      const labelHint = typeof step.args.target_description === 'string' && step.args.target_description !== ''
        ? step.args.target_description : paramTarget;
      if (x === null || y === null) {
        steps.push({
          index: i, tool: step.tool, status: 'degraded-skip',
          note: '坐标槽缺席/脏值 —— 无法重锚定，降级跳过（绝不盲点）',
        });
        degraded.add('reanchor-failed');
        continue;
      }
      const anchors = (() => { try { return deps.anchors?.() ?? []; } catch { return []; } })();
      let hit: ReanchorHit | null = null;
      try {
        hit = reanchor({ x, y, ...(labelHint ? { label: labelHint } : {}) }, anchors);
      } catch {
        hit = null; // 注入物炸裂 ⇒ 重锚定失败（防御式）
      }
      if (!hit) {
        steps.push({
          index: i, tool: step.tool, status: 'degraded-skip',
          note: `重锚定失败（原坐标 ${x.toFixed(3)},${y.toFixed(3)} 无当前帧元素证据）—— 降级跳过，绝不盲点原坐标`,
        });
        degraded.add('reanchor-failed');
        continue;
      }
      step = { ...step, args: { ...step.args, x: hit.x, y: hit.y } };
      steps.push({
        index: i, tool: step.tool, status: 'executed',
        reanchor: { via: hit.via, label: hit.label, to: { x: hit.x, y: hit.y } },
        note: `重锚定(${hit.via})→「${hit.label}」@${hit.x.toFixed(3)},${hit.y.toFixed(3)}`,
      });
    } else {
      steps.push({ index: i, tool: step.tool, status: 'executed', note: '' });
    }

    // 派发（状态先行记录 executed，派发失败回写 dispatch-failed —— 轨迹诚实）
    let dispatch: MacroDispatchResult;
    try {
      dispatch = await deps.dispatch(step);
    } catch (e: any) {
      dispatch = { ok: false, note: `派发异常（${e?.message ?? 'unknown'}）` };
    }
    const trace = steps[steps.length - 1];
    if (!dispatch.ok) {
      trace.status = 'dispatch-failed';
      trace.note = `${trace.note}${trace.note ? '；' : ''}${dispatch.note}`;
      degraded.add('dispatch-failed');
      continue;
    }
    executed++;

    // dhash 抽查节奏（每 2 步一次 —— 链内跳过 VLM 决策，抽查是世界反馈的最小证）
    if ((i + 1) % MACRO_SPOT_PERIOD === 0 && typeof deps.spotCheck === 'function') {
      let changed: boolean | null = null;
      try {
        changed = await deps.spotCheck();
      } catch {
        changed = null; // 抽查端口炸裂 ⇒ 证据缺席（不反证、不中止）
      }
      spotChecks.push({ afterStep: i, changed });
      if (changed === false) {
        flatRun++;
        if (flatRun >= MACRO_SPOT_FLAT_ABORT) {
          aborted = 'spot-flat';
          degraded.add('spot-flat');
          break;
        }
      } else {
        flatRun = 0;
      }
    }
  }

  return {
    ok: executed > 0 && !degraded.has('spot-flat'),
    source: resolved.source,
    steps,
    spotChecks,
    degraded: [...degraded],
    aborted,
    rehearsalGate: gateVerdict,
    reliability: Math.round(reliability * 1000) / 1000,
    elapsedMs: now() - t0,
    budget,
    resolveNote,
  };
}

/** W4-1：轨迹 → 一句话摘要（工具结果与 ExecOutcome note 的 Token 纪律形态） */
export function macroTraceSummary(t: MacroTrace): string {
  const executed = t.steps.filter(s => s.status === 'executed').length;
  const skipped = t.steps.filter(s => s.status === 'degraded-skip').length;
  const failed = t.steps.filter(s => s.status === 'dispatch-failed').length;
  const parts = [
    `${t.resolveNote}`,
    `执行 ${executed}/${t.steps.length} 步（降级跳过 ${skipped}、派发失败 ${failed}）`,
  ];
  if (t.spotChecks.length > 0) {
    parts.push(`dhash 抽查 ${t.spotChecks.length} 次（${t.spotChecks.filter(s => s.changed === true).length} 次见变化）`);
  }
  if (t.rehearsalGate.verdict === 'passed') parts.push(`排练门禁通过（${t.rehearsalGate.muscleEntryId ?? 'muscle'}）`);
  if (t.rehearsalGate.verdict === 'not-required') parts.push('排练门禁免验（可靠度过闸）');
  if (t.rehearsalGate.verdict === 'failed' || t.rehearsalGate.verdict === 'degraded') {
    parts.push(`排练门禁拒绝（${t.rehearsalGate.note}）`);
  }
  if (t.aborted) parts.push(`中止：${t.aborted}`);
  if (t.degraded.length > 0) parts.push(`降级:${t.degraded.join('/')}`);
  return parts.join('；');
}
