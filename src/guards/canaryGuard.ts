// src/guards/canaryGuard.ts
// ─── W2-7（创新提案 R4）：高风险链前金丝雀试演守卫 ───
//
// 对症失败模式：「认识论闸门放行的高代价动作仍然是错的」。Φ-7 adviseAction 在
// costOfError=high 档给出 proceed 只有两种来源：内核进化把 uncertainty.highProceed
// 阈放宽进校准值域（出厂 0.85 > α=4/β=1 的值域上限 0.8，数学上不可达 —— 放宽
// 是部署/进化的**显式决策**），或部署方注入了更宽的校准常数。R4 的立场：
// **放宽免检线的代价是先试演** —— 物理执行之前，用一次语义同构且可逆的微实验
// （金丝雀）向世界核对反事实预测：
//
//   点击类：探针点击目标后立即回点（幂等切换场景：展开/收起、菜单开合 ——
//           目标标签须命中幂等词汇表 isIdempotentToggleLabel，命中不了就没有
//           可逆探针可言，诚实跳过）；
//   输入类：输入 1 个字符后立即退格（可编辑上下文里字符状态恒复原。ΑΩ-R38
//           副作用先验闸：目标字符串证据带 search/自动补全/即时筛选类信号 ⇒
//           单字符可能已触发 oninput 网络请求等不可逆副作用，该探针降级
//           「不可论证」—— 词表执法在 canaryLogic.classifyCanaryTrigger 第 7 步）。
//
//   预测-验证比对（compareCanaryObservation）：探针的实际视觉响应（三帧区域
//   指纹：基线 h0 → 探针中 h1 → 复位后 h2，经注入的帧哈希端口）与
//   counterfactual.predictedEffects 的「世界会响应」主张比对：
//     · 响应通道：预测「激活元素/输入生效」而探针期间邻域纹丝不动
//       （sim(h0,h1) ≥ noopSimilarityThreshold）⇒ 分歧（分歧度量 = 响应相似度，
//       无响应=1 全矛盾、剧变=0 无矛盾，线性连续，判决按阈值）；
//     · 复位通道：探针复原后 sim(h0,h2) < CANARY_RESTORE_FLOOR ⇒ 探针没能
//       复原 —— 目标不是幂等切换，世界不是我们以为的样子 ⇒ 分歧
//       （分歧度量 = 1 − 复位相似度）。
//   两通道取最大者为总分歧度量；任一越阈 ⇒ 拦截原动作，并经 approval.request
//   （**只读**调用：仅铸造待审批令牌，不消费、不授予 —— 消费与授予仍归
//   grant_approval/click_mouse 既有协议）降级问人；一致 ⇒ 放行并在事件环
//   证据链记录「金丝雀通过」。
//
// 纪律（世界级标准）：
//   · 探针端口缺席 / 派发失败 / 帧通道缺席 / dry-run / 弹窗期 / 后端未孵化 ⇒
//     放行原动作（可用性优先），事件环记 degraded —— 金丝雀是增益，不是依赖；
//     【W6R 收口】唯一的例外：**携带审批令牌的调用**（dangerous 分级、走
//     beginAttempt/consume 的路径 —— 危险词命中的动作在触发分类第 3 步已豁免
//     直审批、已授予令牌的调用在第 2 步已让位，能到达试演的令牌调用只剩
//     「持未授予/悬置令牌的高危动作」这一活口）探针缺席或失败 ⇒ fail-closed
//     拦截该调用，错误信息指明出路（重试 / 开探针 / 显式逃生门
//     allowUnverifiedDangerous=true）。dry-run 豁免同律（无物理世界可探）；
//   · 探针预算封顶：每会话 CANARY_PROBE_BUDGET_DEFAULT 次（试演也要花钱有度，
//     超支 ⇒ 让位放行 + 记注）；
//   · destructive 档豁免：危险词命中 / 显式 destructive 分层 ⇒ 不试演、直接
//     放行给既有审批闸门（actionGate 在同一调用内执法「直接审批」—— 对
//     「发送」这类一次性按钮，试演点击两次比点一次更糟）；
//   · 已持有效已授予审批令牌的调用 ⇒ 金丝雀让位（人已裁决，不再打扰）；
//   · 一切防御式绝不抛：守卫整体 try 兜底，异常的成本是「这一次不试演」，
//     绝不是主路径被吞 / 被延迟；
//   · 出厂零回归：默认内核阈值下 proceed×high 数学上不可达 ⇒ 守卫对所有
//     调用恒为纯旁路（唯一的可观察差异是 destructive-exempt 的一次遥测计数）；
//   · 全离线可测：物理微动作与帧观察全部经 CanaryProbePorts 注入缝（与
//     rootCauseGuard 的 RootCauseProbePorts 同一注入模式）。
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from '../config';
import { onToolPre } from './hooks';
import { similarity } from '../perceptualHash';
import { approval } from '../approval';
import { telemetry } from '../telemetry';
import { focusTracker } from '../focusTracker';
import * as physicalBackend from '../physicalBackend';
// ΝΩ-2（物理探针互斥）：试演探针与用户/其他会话动作在同一 D-1 躯体队列排队
//（ioMutex 只读引入 —— 探针步/复位步/帧通道不再与并发物理派发交错，三帧
// 取证证据 h0→h1→h2 的每次派发原子串行，不再被并发动作污染）
import { serialize } from '../ioMutex';
import { getPopupState } from './popupGuard';
// ΑΩ-R4（审计盲区消除）：物理探针派发的 GUARD_PROBE 存证提交（fail-open ——
// 探针是安全机制本身，审计失败只打点不拦截，立法论证见 probeAudit.ts 文件头）
import { auditGuardProbe, type GuardProbeContext } from './probeAudit';
// W6-1（doctor 债清偿·smell.over-engineering）：契约类型 + 幂等词汇表 + 触发分类 +
// 反事实预测 + 预测-验证比对三个纯函数区逐字节搬至 ./canaryLogic —— 导入面不变
// （本文件原位再导出全部公共面）。
// W8-B4（tools↔autonomy 破环）：canaryLogic 对上游认识论器官的三张面改为端口注入，
// 本文件是生产装配点 —— 模块装载即把真身（adviseAction / costPriorOfCall /
// scoreOptions 包装）注册进 canaryLogic（同一函数、同一调用序，行为零变化；
// 依赖边 guards→上游为单向合法边，canaryLogic 纯逻辑区不再反向牵动器官包）。
import { adviseAction, costPriorOfCall } from '../autonomy/uncertainty';
import { scoreOptions } from '../autonomy/counterfactual';
import type { PolicyAction } from '../autonomy/policyEngine';
import type { WorldSnapshot } from '../autonomy/worldSnapshot';
export {
  CANARY_ACTION_TOOLS, CANARY_PROBE_BUDGET_DEFAULT, CANARY_RESTORE_FLOOR_DEFAULT,
  isIdempotentToggleLabel, isInstantReactionLabel, classifyCanaryTrigger, compareCanaryObservation,
} from './canaryLogic';
export type {
  CanaryProbeKind, CanaryProbePlan, CanaryObservation, CanaryProbePorts, CanaryEvent,
  CanarySkipWhy, CanaryTrigger, CanaryComparison, CanaryProbeOutcome,
  CanaryEpistemicReport, CanaryEpistemicPorts,
} from './canaryLogic';
export { bindCanaryEpistemicPorts, boundCanaryEpistemicPorts } from './canaryLogic';
import {
  CANARY_PROBE_BUDGET_DEFAULT, CANARY_RESTORE_FLOOR_DEFAULT,
  classifyCanaryTrigger, compareCanaryObservation, bindCanaryEpistemicPorts,
} from './canaryLogic';
import type {
  CanaryEvent, CanaryObservation, CanaryProbeOutcome, CanaryProbePlan, CanaryProbePorts,
} from './canaryLogic';

// ─── W8-B4：认识论端口的生产面（自 canaryLogic 回迁的三件套，逐字节同逻辑） ───

/** 零证据空快照（上游 scoreOptions 同律：零证据不伪造 —— deriveEffects 只需动作形状） */
const ZERO_SNAPSHOT: WorldSnapshot = {
  takenAt: 0, width: 0, height: 0, dhash: null, elements: [], textDigest: '',
  popups: [], focusedRegion: null, sceneLabel: '', degraded: [],
};

/** 从工具参数提取字符串（与 canaryLogic 同律的类型收口：非字符串真值一律按缺席） */
function strArg(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** 工具调用 → 合成 PolicyAction（上游器官的词汇面；只用于推导 predictedEffects） */
function syntheticActionFor(tool: string, a: Record<string, unknown>): PolicyAction | null {
  const expectedEffect = strArg(a.expected_change) ?? strArg(a.expected_text) ?? '';
  if (tool === 'click_mouse') {
    const x = a.x;
    const y = a.y;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const label = strArg(a.target_description) ?? '';
    return {
      kind: 'click',
      target: { bbox: { x0: x, y0: y, x1: x, y1: y }, center: { x, y }, label },
      payload: {},
      rationale: 'W2-7 金丝雀合成动作（只读消费）',
      expectedEffect,
      utility: 0.5,
      riskTier: 'benign',
    };
  }
  if (tool === 'type_text') {
    return {
      kind: 'type',
      payload: { text: typeof a.text === 'string' ? a.text : '' },
      rationale: 'W2-7 金丝雀合成动作（只读消费）',
      expectedEffect,
      utility: 0.5,
      riskTier: 'benign',
    };
  }
  return null;
}

/** 经 scoreOptions 推导 predictedEffects（null = 推导不出）—— predictEffects 端口真身 */
function predictedEffectsOf(tool: string, a: Record<string, unknown>): string[] | null {
  const action = syntheticActionFor(tool, a);
  if (action === null) return null;
  const plan = scoreOptions([action], { goalKeywords: [], snapshot: ZERO_SNAPSHOT });
  if (plan === null || !Array.isArray(plan.chosen?.predictedEffects)) return null;
  const effects = plan.chosen.predictedEffects.filter((e): e is string => typeof e === 'string');
  return effects.length > 0 ? effects : null;
}

// W8-B4：生产装配 —— 模块装载即注册（本文件的任何导入方都带上生产面；与
// canaryLogic 破环前的直接调用同一真身同一调用序，行为零变化）。
bindCanaryEpistemicPorts({
  adviseAction,
  costPriorOfCall,
  predictEffects: predictedEffectsOf,
});

// ─── 探针编排（防御式：一切端口异常收敛为状态，绝不抛、绝不悬挂） ───

/** 端口调用包装：异常 / 非真值 ⇒ false（世界侧是否被触碰由调用序保证）。
 *  ΑΩ-R4：每次物理派发（探针步 + 复位重试步）结算后立即补 GUARD_PROBE 审计
 *  行入防篡改链 —— 此前这些绕过宿主管线的微动作链上无痕。审计 fail-open：
 *  auditGuardProbe 绝不抛，探针行为与既有三帧取证零变化。 */
async function tryStep(
  name: string,
  fn: () => Promise<boolean>,
  steps: string[],
  auditCtx: GuardProbeContext,
): Promise<boolean> {
  try {
    const ok = (await fn()) === true;
    steps.push(`${name}: ${ok ? 'ok' : 'dispatch-failed'}`);
    await auditGuardProbe('canary', name, ok ? 'ok' : 'failed', auditCtx);
    return ok;
  } catch (e: any) {
    steps.push(`${name}: threw(${e?.message ?? 'unknown'})`);
    await auditGuardProbe('canary', name, 'threw', auditCtx);
    return false;
  }
}

/** 帧哈希端口包装：异常/非串/空串 ⇒ null（帧通道缺席）。
 *  ΑΩ-R4：帧通道也是物理派发（captureProcessed）—— 同律入链（结果三态
 *  ok=指纹在手 / failed=通道缺席 / threw=端口抛错）；端口未注入属未派发，
 *  无审计行。 */
async function tryHash(
  ports: CanaryProbePorts,
  point: { x: number; y: number } | null,
  radius: number,
): Promise<string | null> {
  try {
    if (typeof ports.regionHash !== 'function') return null; // 未派发 ⇒ 无审计行
    const h = await ports.regionHash(point, radius);
    const usable = typeof h === 'string' && h.length > 0;
    await auditGuardProbe('canary', 'region-hash', usable ? 'ok' : 'failed', { point, radius });
    return usable ? h : null;
  } catch {
    await auditGuardProbe('canary', 'region-hash', 'threw', { point, radius });
    return null;
  }
}

/**
 * 可逆微探针编排（W2-7 核心）：点击回点 / 单字符退格，三帧区域指纹取证。
 *
 * 可逆性编排律：
 *   · 首步派发失败 ⇒ 世界未被触碰，整体 unavailable（无副作用失败）；
 *   · 复位步派发失败 ⇒ 立即尽力重试一次；仍失败 ⇒ failed（世界可能被触碰，
 *     调用方按纪律降级放行并诚实记注 —— 绝不假装复原成功）；
 *   · 全步派发成功 ⇒ observed，三帧相似度即响应/复位两通道的原始证据。
 */
export async function attemptCanaryProbe(
  plan: CanaryProbePlan,
  ports: CanaryProbePorts | null | undefined,
  opts: { regionRadius?: number } = {},
): Promise<CanaryProbeOutcome> {
  if (ports === null || ports === undefined || typeof ports !== 'object') {
    return { status: 'unavailable', notes: ['探针端口缺席（生产后端未孵化或测试未注入）'] };
  }
  const radius = typeof opts.regionRadius === 'number' && Number.isFinite(opts.regionRadius) && opts.regionRadius > 0
    ? opts.regionRadius
    : 0.06;
  const steps: string[] = [];
  const degradedNotes: string[] = [];

  if (plan.kind === 'click-toggle') {
    if (typeof ports.click !== 'function') {
      return { status: 'unavailable', notes: ['点击物理端口缺席'] };
    }
    const p = plan.point;
    if (p === null) return { status: 'unavailable', notes: ['点击探针无目标点'] };
    const h0 = await tryHash(ports, p, radius);
    if (h0 === null) return { status: 'unavailable', notes: ['基线帧通道缺席（无 h0 不可比）'] };
    const ok1 = await tryStep('probe-click', () => ports.click!(p), steps, { point: p });
    if (!ok1) return { status: 'unavailable', notes: [...steps, '首步点击派发失败 —— 世界未被触碰'] };
    const h1 = await tryHash(ports, p, radius);
    const ok2 = await tryStep('probe-click-back', () => ports.click!(p), steps, { point: p }) ||
      await tryStep('probe-click-back-retry', () => ports.click!(p), steps, { point: p });
    if (!ok2) degradedNotes.push('回点派发失败（已尽力重试）—— 世界可能停留在展开态');
    const h2 = await tryHash(ports, p, radius);
    if (!ok2) return { status: 'failed', notes: [...steps, ...degradedNotes] };
    return {
      status: 'observed',
      observation: {
        responseSimilarity: h1 !== null ? similarity(h0, h1) : null,
        restoreSimilarity: h2 !== null ? similarity(h0, h2) : null,
        steps,
        degradedNotes,
      },
    };
  }

  // type-char：输入 1 字符 → 立即退格（任何可编辑上下文状态恒复原）。
  // ΑΩ-R38：能到达编排层的 type 探针已在 classifyCanaryTrigger 第 7 步过即时
  // 反应词表闸（带 search/自动补全信号的目标在分类层已降级不可论证）—— 此处
  // 不重复判词表（单一事实源，canaryLogic.isInstantReactionLabel）。
  if (typeof ports.typeChar !== 'function' || typeof ports.backspace !== 'function') {
    return { status: 'unavailable', notes: ['输入/退格物理端口缺席'] };
  }
  const h0 = await tryHash(ports, null, radius);
  if (h0 === null) return { status: 'unavailable', notes: ['基线帧通道缺席（无 h0 不可比）'] };
  const ch = typeof plan.char === 'string' && plan.char.length > 0 ? plan.char : 'x';
  // ΑΩ-R4 脱敏纪律：type 探针的审计行只记 charCount（单字符事实），字符内容零明文
  const ok1 = await tryStep('probe-type-char', () => ports.typeChar!(ch), steps, { charCount: ch.length });
  if (!ok1) return { status: 'unavailable', notes: [...steps, '首步输入派发失败 —— 世界未被触碰'] };
  const h1 = await tryHash(ports, null, radius);
  const ok2 = await tryStep('probe-backspace', () => ports.backspace!(), steps, {}) ||
    await tryStep('probe-backspace-retry', () => ports.backspace!(), steps, {});
  if (!ok2) degradedNotes.push('退格派发失败（已尽力重试）—— 焦点元素可能残留 1 个探针字符');
  const h2 = await tryHash(ports, null, radius);
  if (!ok2) return { status: 'failed', notes: [...steps, ...degradedNotes] };
  return {
    status: 'observed',
    observation: {
      responseSimilarity: h1 !== null ? similarity(h0, h1) : null,
      restoreSimilarity: h2 !== null ? similarity(h0, h2) : null,
      steps,
      degradedNotes,
    },
  };
}

// ─── 生产端口（零孵化 + dry-run 纪律，与 interactivityProbe/rootCauseGuard 同律） ───

/**
 * ΝΩ-2：试演探针的物理 IO 缝 —— 缺省 D-1 全局互斥队列（ioMutex.serialize，
 * 与 system.ts 的用户动作同一队列），测试注入假件计数（时序断言的观察面）。
 */
export type CanaryProbeIo = { serialize: typeof serialize };

/**
 * 生产探针端口：physicalBackend 的薄包装。
 *   · 派发闸：healthSnapshot() 在场（绝不因试演孵化服务）且非 dry-run；
 *   · 帧通道：click 用目标邻域 wantRegionHash；type 用焦点槽
 *     （focusTracker，过期即缺席）—— 焦点缺席退全屏 dhash。
 * ΝΩ-2（物理探针互斥）：四个端口的**整个派发体**（含零孵化/dry-run 门控）
 * 经 io.serialize 入队 —— 探针步（点击/单字符/退格）与帧通道（采帧）和用户/
 * 其他会话的物理动作（system.ts 同队列）原子串行：三帧取证（h0→h1→h2）的
 * 每次派发不再被并发点击/输入交错污染。门控在临界区内裁决 —— 拒绝派发也占
 * 一次队列轮转（诚实：探针是否触世界由队列序保证）；排队超时走 ioMutex 的
 * IoTimeoutError → tryStep 收口为 'threw' → 既有降级语义（可用性优先不变）。
 * 原子性边界（诚实声明）：互斥粒度是**单次派发**，不是整个试演序列 —— 探针
 * 两步之间的队列空隙理论上可插入并发动作；彻底的序列级互斥需把编排整体
 * 入队，但 rootCause 冻结探针（300ms 帧间隔）证明「长持锁」会饿死全部用户
 * IO，故按派发粒度立法（与 system.ts 用户的动作粒度对等 —— 不越权插队）。
 */
export function productionCanaryPorts(config: Config, io: CanaryProbeIo = { serialize }): CanaryProbePorts {
  const dispatchOk = (): boolean => physicalBackend.healthSnapshot() !== null && config.dryRun !== true;
  return {
    click: async p => io.serialize(async () => {
      if (!dispatchOk()) return false;
      await physicalBackend.clickMouse(p.x, p.y, 'left', false);
      return true;
    }),
    typeChar: async ch => io.serialize(async () => {
      if (!dispatchOk()) return false;
      await physicalBackend.typeText(ch, false, false);
      return true;
    }),
    backspace: async () => io.serialize(async () => {
      if (!dispatchOk()) return false;
      await physicalBackend.pressHotkey(['backspace'], false);
      return true;
    }),
    regionHash: async (p, r) => io.serialize(async () => {
      if (physicalBackend.healthSnapshot() === null) return null; // 零孵化：帧通道诚实缺席
      const focus = p ?? focusTracker.get(config.focusMaxAgeMs);
      const cap = await physicalBackend.captureProcessed({
        metaOnly: true,
        ...(focus !== null
          ? { wantRegionHash: { x: focus.x, y: focus.y, r } }
          : { wantHashes: true }),
      });
      return (focus !== null ? cap.regionDhash : cap.dhash) ?? null;
    }),
  };
}

// ─── 观察面：事件环 + 预算账本（模块级单例，reset 供测试隔离/插件卸载） ───

const RECENT_LIMIT = 16;
const recentEvents: CanaryEvent[] = [];
/** 探针预算账本：会话键 → 已试演次数（有界 128 会话，防缓慢泄漏） */
const probeBudget = new Map<string, number>();
const BUDGET_SESSIONS_MAX = 128;

function recordEvent(ev: CanaryEvent): void {
  recentEvents.unshift(ev);
  if (recentEvents.length > RECENT_LIMIT) recentEvents.length = RECENT_LIMIT;
}

function chargeBudget(sessionKey: string): void {
  probeBudget.set(sessionKey, (probeBudget.get(sessionKey) ?? 0) + 1);
  if (probeBudget.size > BUDGET_SESSIONS_MAX) {
    const first = probeBudget.keys().next().value; // 插入序淘汰最旧会话
    if (first !== undefined) probeBudget.delete(first);
  }
}

/** W2-7：最近的试演事件（时间降序；诊断面板/测试观察面） */
export function recentCanaryEvents(): readonly CanaryEvent[] {
  return [...recentEvents];
}

/** W2-7：探针预算账本只读快照（会话键 → 已用次数；可观测面） */
export function canaryBudgetSnapshot(): ReadonlyMap<string, number> {
  return new Map(probeBudget);
}

/** W2-7：生命周期归零（插件卸载 / 测试隔离） */
export function resetCanaryGuard(): void {
  recentEvents.length = 0;
  probeBudget.clear();
}

// ─── 守卫注册 ───

/**
 * 注册金丝雀试演守卫（W2-7）。ports 参数是注入缝 —— 测试注入假物理端口/
 * 假帧哈希（离线确定性）；缺省用生产端口（后端不在场时自动全降级，行为
 * 等价于纯旁路放行）。W6R 例外：携带审批令牌的调用（审批域活口）在探针
 * 缺席/失败时 fail-closed 拦截，除非逃生门 allowUnverifiedDangerous=true。
 */
export function registerCanaryGuard(ctx: Context, config: Config, ports?: CanaryProbePorts): void {
  onToolPre(ctx, async (call, next) => {
    // 防御式铁律：守卫的一切都在 try 内；任何异常的成本是「这一次不试演」，
    // 绝不是工具调用被吞 / 被拦截 / 被延迟到异常路径。
    try {
      const sessionKey = typeof call.sessionId === 'string' && call.sessionId !== ''
        ? call.sessionId
        : '_anon';
      const trigger = classifyCanaryTrigger(call.name, call.args, {
        dangerPatterns: config.dangerPatterns,
        probeBudgetUsed: probeBudget.get(sessionKey) ?? 0,
        probeBudgetCap: CANARY_PROBE_BUDGET_DEFAULT,
      });

      if (trigger.kind === 'skip') {
        // 噪声纪律：not-action-tool 每次无关调用都发生，不打点；其余让位
        // （预算/令牌/不可逆等）以 miss 计数入遥测 —— 让位可观测但不拦截。
        if (trigger.why !== 'not-action-tool') telemetry.note(`canary:skip-${trigger.why}`, false);
        return next();
      }

      if (trigger.kind === 'exempt-destructive') {
        // destructive 豁免直审批：不试演，放行给既有审批闸门（actionGate 在
        // 同一调用内执法 —— 对一次性按钮，试演点击两次比点一次更糟）。
        recordEvent({ at: Date.now(), tool: call.name, action: 'exempt-destructive', why: trigger.note });
        telemetry.note('canary:destructive-exempt', true);
        return next();
      }

      // ── rehearse：金丝雀试演 ──
      chargeBudget(sessionKey); // 计数先于探针（并发/失败皆不超支）
      const epistemics = `advise=${trigger.report.advise} 有效置信=${trigger.report.confidence.toFixed(3)}`;
      recordEvent({
        at: Date.now(),
        tool: call.name,
        action: 'triggered',
        why: 'proceed×high：认识论放行的高代价动作，物理执行前先试演',
        probe: trigger.probe.kind,
        point: trigger.probe.point,
        predictedEffects: trigger.predictedEffects,
        epistemics,
      });
      telemetry.note('canary:triggered', true);

      // W6R（fail-closed 收口）：本调用是否走在审批令牌协议上（携带
      // approval_token —— dangerous 分级动作走 beginAttempt/consume 的前件）。
      // 触发分类上，危险词命中的动作已在第 3 步豁免直审批、已授予令牌的调用
      // 已在第 2 步让位 —— 能进入试演的令牌调用只剩「持未授予/悬置令牌的高危
      // 动作」；对这一活口，探针缺席/失败不再降级放行（见 degraded 分支执法）。
      const tokenPath = typeof call.args?.approval_token === 'string' && call.args.approval_token !== '';
      // 逃生门：部署显式接受未验证危险派发（与 clickMouse 的两处 fail-closed
      // 同一把钥匙）；dry-run 豁免（无物理世界可探，拦截只会误杀模拟）。
      const failClosed = tokenPath && config.dryRun !== true && config.allowUnverifiedDangerous !== true;

      const degraded = (why: string, notes: string[]): any => {
        recordEvent({
          at: Date.now(), tool: call.name,
          action: failClosed ? 'blocked' : 'degraded',
          why: failClosed ? `${why} —— 审批令牌路径 fail-closed（W6R）：拒绝派发` : why,
          probe: trigger.probe.kind, point: trigger.probe.point,
          predictedEffects: trigger.predictedEffects, epistemics,
          degradedNotes: notes,
        });
        telemetry.note(failClosed ? 'canary:blocked' : 'canary:degraded', failClosed);
        if (failClosed) {
          // W6R：探针缺席/失败 + 令牌路径 ⇒ 拦截（不调 next 即短路）。不铸造
          // 审批令牌 —— 这是机器故障（防御栈缺席），不是需要人裁决的预测分歧。
          return (
            `[Guard Blocked][Canary]: 高风险动作的试演探针缺席/失败，且本调用携带审批令牌` +
            `（不可逆动作的 beginAttempt/consume 路径）—— fail-closed 拒绝派发。\n` +
            `  action: ${call.name} ${why}\n` +
            `  notes: ${notes.join('；')}\n` +
            `  出路：① 重试（物理服务/探针端口可能稍后可用）；② 开探针 —— 确保物理服务已存活、` +
            `探针端口已接线（生产组合根默认注入，测试经 CanaryProbePorts 注入缝）；` +
            `③ 部署显式逃生门：配置 allowUnverifiedDangerous=true（明确接受未验证危险派发）。`
          );
        }
        return next(); // 可用性优先：非令牌动作探针缺席/失败 ⇒ 放行原动作（旧行为不变）
      };

      // 弹窗期不试演（与 interactivityProbe 的 hoverGuardSkip 同律：隔着对话框动指针不安全）
      if (getPopupState()) return degraded('弹窗活跃期不试演', ['popup active']);

      const outcome = await attemptCanaryProbe(
        trigger.probe,
        ports ?? productionCanaryPorts(config),
        { regionRadius: config.probeRegionRadius },
      );
      if (outcome.status !== 'observed') {
        return degraded(`探针${outcome.status === 'unavailable' ? '不可用' : '失败'}（可用性优先放行）`, outcome.notes);
      }

      const cmp = compareCanaryObservation(trigger.predictedEffects, outcome.observation, {
        responseCeiling: config.noopSimilarityThreshold,
        restoreFloor: CANARY_RESTORE_FLOOR_DEFAULT,
      });
      if (cmp.diverged === null || cmp.divergence === null) {
        return degraded('两通道皆缺席，无法比对（诚实弃权放行）', cmp.notes);
      }

      if (cmp.diverged) {
        // 分歧 ⇒ 拦截 + 降级问人：只读调用 approval.request（铸造待审批令牌；
        // 不消费、不授予 —— 同意与否仍归用户 grant_approval 的既有协议）。
        const pointText = trigger.probe.point !== null
          ? `(${trigger.probe.point.x.toFixed(3)},${trigger.probe.point.y.toFixed(3)})`
          : '焦点槽';
        let token: string | null = null;
        try {
          const pa = approval.request(
            `[金丝雀试演分歧] ${call.name} ${pointText}` +
            ` 预测「${trigger.predictedEffects.join('；')}」` +
            ` 观察 响应相似度=${cmp.responseSimilarity?.toFixed(3) ?? 'n/a'}` +
            ` 复位相似度=${cmp.restoreSimilarity?.toFixed(3) ?? 'n/a'}` +
            ` 分歧度量=${cmp.divergence.toFixed(3)} —— 请人工裁决是否放行原动作`,
            {
              actionShape: {
                tool: call.name,
                ...(trigger.probe.point !== null ? { x: trigger.probe.point.x, y: trigger.probe.point.y } : {}),
                ...(typeof call.args?.text === 'string' ? { text: call.args.text } : {}),
                ...(typeof call.args?.target_description === 'string'
                  ? { target_description: call.args.target_description }
                  : {}),
              },
            },
          );
          token = pa.token;
        } catch {
          token = null; // 审批通道异常：拦截仍生效，令牌缺席如实记注
        }
        recordEvent({
          at: Date.now(), tool: call.name, action: 'blocked',
          why: `预测-验证分歧（${cmp.notes.join('；')}）—— 拦截原动作，降级问人`,
          probe: trigger.probe.kind, point: trigger.probe.point,
          divergence: cmp.divergence,
          responseSimilarity: cmp.responseSimilarity,
          restoreSimilarity: cmp.restoreSimilarity,
          predictedEffects: trigger.predictedEffects,
          approvalToken: token,
          epistemics,
        });
        telemetry.note('canary:blocked', true);
        return (
          `[Guard Blocked][Canary]: 高风险动作试演与预测分歧 —— 世界没有按反事实预测响应，` +
          `原动作已被拦截并降级为人工审批。\n` +
          `  action: ${call.name} ${pointText}` +
          `${typeof call.args?.target_description === 'string' ? ` target "${call.args.target_description}"` : ''}\n` +
          `  predicted: ${trigger.predictedEffects.join('；')}\n` +
          `  observed: 响应相似度=${cmp.responseSimilarity?.toFixed(3) ?? 'n/a'}` +
          ` 复位相似度=${cmp.restoreSimilarity?.toFixed(3) ?? 'n/a'} 分歧度量=${cmp.divergence.toFixed(3)}\n` +
          (token !== null
            ? `  approval token minted: ${token} — 请用户经 grant_approval 裁决后携 approval_token 重试；` +
              `若目标定位错了，请重新定位（如 find_text）而非强行点击。`
            : `  审批通道铸造失败 —— 请直接向用户说明分歧并等待人工指示，勿强行执行。`)
        );
      }

      // 一致 ⇒ 放行，证据链记「金丝雀通过」
      recordEvent({
        at: Date.now(), tool: call.name, action: 'passed',
        why: `金丝雀通过：${cmp.notes.join('；')}`,
        probe: trigger.probe.kind, point: trigger.probe.point,
        divergence: cmp.divergence,
        responseSimilarity: cmp.responseSimilarity,
        restoreSimilarity: cmp.restoreSimilarity,
        predictedEffects: trigger.predictedEffects,
        epistemics,
      });
      telemetry.note('canary:passed', true);
      return next();
    } catch {
      try { telemetry.note('canary:degraded', false); } catch { /* 遥测也炸：到此为止，绝不抛 */ }
      return next(); // 主路径零感知
    }
  });
}
