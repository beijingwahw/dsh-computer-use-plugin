// src/planner.ts
// Planner：将复杂需求拆解为原子子任务。
// 保留原版提示词的全部规则（含「单个屏幕内完成」—— 教规划器体谅执行器的极限）。
// 融合修复：原版签名无 ctx 却想调 ctx.llm -> 改为 ChatFn 依赖注入；
//           「需增加容错处理」的 TODO -> 实现围栏剥离 + 区间截取的 JSON 容错解析。
// ── ΠΑΝ-40a（plan-ready chain 臂发射方）──
// 病灶（C2-3 H2-1）：cognition/plan-ready 的唯一生产发射器是 delegate_to_
// pipeline，经 mintIntentPlanReady 只铸 intent 臂（D-6/D-7 方言）；全库无任何
// CognitionChainPayload 铸造点 ⇒ sandbox 侧 `if (!'chain' in payload)` 恒真
// 返回，engine.receivePlan 是死码，「排练→固化→召回→五门重放」闭环第一环断裂。
// 修法：计划就绪时铸造 chain 臂载荷 —— 方言零新造：CognitionChainPayload /
// COGNITION_PLAN_VERSION / emitCognitionPlanReady 全部消费 cognitionEvents
// 既有单源（D-1 主权），动作校验复用 sandbox/actionSchema（半截链是毒证，
// 非法链不发射 = 诚实缺席）。发射经注入钩（emitPlanReady）保持 planner 纯函数
// 零 ctx 依赖；生产一行接线（orchestrator/组合根侧）：
//   planTasks(prompt, chat, { emitPlanReady: p => emitCognitionPlanReady(ctx, p), chain })
import type { CognitionChainPayload, CognitionPlanReadyPayload } from './cognitionEvents';
import { COGNITION_PLAN_VERSION } from './cognitionEvents';
import { validateActionChainInput } from './sandbox/actionSchema';
import type { ActionChain, VirtualWidget } from './sandbox/types';
export const PLANNER_SYSTEM_PROMPT = `
# Role: 任务规划专家 (Task Planner)

## 目标
你是一个高级任务规划器。你的任务是将用户的复杂需求拆解为一系列简单的、可执行的原子任务（Subtasks）。

## 规则
1. 你只能输出合法的 JSON 数组格式，不要包含任何其他解释性文本。
2. 每个子任务必须是一个独立的、可以在单个屏幕内完成的动作。
3. 如果任务需要跨应用，请在子任务中明确说明。
4. 用 "deps" 声明子任务间的依赖（必须先完成的子任务 id 列表）；无依赖用空数组。
   只声明真正的先序关系 —— 编号顺序本身不构成依赖。

## 输出格式
[
  {"id": 1, "action": "打开 Chrome 浏览器并导航到 GitHub 首页", "deps": []},
  {"id": 2, "action": "在搜索框中输入 'DeepSeek Harness' 并点击搜索", "deps": [1]},
  {"id": 3, "action": "点击第一个搜索结果链接", "deps": [2]}
]
`;

export interface SubTask {
  id: number;
  action: string;
  /** Y-9 依赖 DAG：必须先完成的子任务 id（缺省 = 按编号顺序） */
  deps?: number[];
}

// ─── Y-9 拓扑执行序（Epoch Y：从「流水线」到「依赖图」）───
//
// 数学：Kahn 拓扑排序 —— 入度表 + 就绪队列；无前驱的子任务出队执行序。
// 独立子任务（无互相依赖）在序中相邻出现，执行器可视作可并行批（本实现
// 保守串行，但序的语义已声明并行性）。环 ⇒ cycle=true 诚实上报（拒绝执行
// —— 而非静默截断：部分执行一个循环依赖的计划只会制造垃圾状态）。

export interface TopoOrder {
  order: SubTask[];
  /** 依赖图含环（order 只含无环前缀 —— 调用方必须拒绝执行） */
  cycle: boolean;
  cyclicIds: number[];
  /** ΠΑΝ-107：源数据撞号留痕 —— 重复 id 清单（去重保序后 byId 取**首现者**；
   *  旧行为是 Map 后者覆盖前者、前一个子任务无声消失 —— 现在 IMF 留在账面上，
   *  调用方/日志可据此拒绝或人工复核。缺席 = 无撞号） */
  duplicateIds?: number[];
}

// ── ΠΑΝ-107（重复 id 结构化执法）：LLM 重规划语境下常见「两个子任务同号」──
// 旧病灶（C1-2 M10）：`new Map(tasks.map(t => [t.id, t]))` 后者覆盖前者 ——
// 前一个子任务从 byId/order 中**无声消失**，依赖它的下游任务照跑，世界状态
// 与计划脱节。修法（绝不抛 —— planner 的失败方言是诚实空计划/结构化留痕）：
//   · dedupeSubTasks：首现者占据原 id（与「编号顺序即缺省依赖序」的直觉
//     一致 —— 先申报的先占号），后续撞号者重编号到首个空闲 id（max+1 起顺延），
//     一切保序；重复清单留在 duplicateIds 供调用方拒绝/复核；
//   · topoSortSubTasks 内部同样去重（外部直投路径的防御）；
//   · planTasks 在 LLM 解析后去重并 console.warn 留痕（自动去重留痕方言：
//     修得动就不拒绝执行，但绝不静默 —— 病灶与修复都进日志）。
function dedupeSubTasks(tasks: SubTask[]): { tasks: SubTask[]; duplicateIds: number[] } {
  const seen = new Set<number>();
  const duplicateIds = new Set<number>();
  const used = new Set<number>(tasks.map(t => t.id));
  const out: SubTask[] = [];
  let nextId = tasks.reduce((m, t) => Math.max(m, Number.isFinite(t.id) ? t.id : m), 0) + 1;
  for (const t of tasks) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      out.push(t);
      continue;
    }
    duplicateIds.add(t.id);
    // 撞号者重编号到首个空闲 id（deps 不迁移 —— 对旧 id 的依赖语义本就
    // 因撞号而含混，保持指向首现者；重编号者作为无依赖新节点进入图）
    while (used.has(nextId)) nextId++;
    used.add(nextId);
    out.push({ ...t, id: nextId, deps: [] });
  }
  return { tasks: out, duplicateIds: [...duplicateIds].sort((a, b) => a - b) };
}

export function topoSortSubTasks(tasks: SubTask[]): TopoOrder {
  // ΠΑΝ-107：源数据撞号先去重（首现者占号，留痕 duplicateIds）—— 旧实现
  // Map 后者覆盖前者，前一个子任务无声消失
  const { tasks: deduped, duplicateIds } = dedupeSubTasks(Array.isArray(tasks) ? tasks : []);
  tasks = deduped;
  const byId = new Map(tasks.map(t => [t.id, t]));
  // 依赖清洗：指向不存在 id 的边剔除（Planner 幻觉防御）
  const depsOf = new Map<number, number[]>();
  for (const t of tasks) {
    depsOf.set(t.id, (t.deps ?? []).filter(d => byId.has(d) && d !== t.id));
  }
  const indegree = new Map<number, number>();
  for (const t of tasks) indegree.set(t.id, (depsOf.get(t.id) ?? []).length);

  const ready = tasks.filter(t => (indegree.get(t.id) ?? 0) === 0).map(t => t.id);
  // 稳定性：同入度层按原编号排序（确定性输出 —— 测试可断言）
  ready.sort((a, b) => a - b);
  const order: SubTask[] = [];
  const done = new Set<number>();
  while (ready.length) {
    const id = ready.shift()!;
    if (done.has(id)) continue; // 幻觉重复 id：同号任务不得在执行序中出现两次
    const t = byId.get(id)!;
    order.push(t);
    done.add(id);
    for (const u of tasks) {
      const du = depsOf.get(u.id) ?? [];
      if (du.includes(id) && !done.has(u.id)) {
        const remaining = du.filter(d => !done.has(d));
        indegree.set(u.id, remaining.length);
        if (remaining.length === 0) {
          ready.push(u.id);
          ready.sort((a, b) => a - b);
        }
      }
    }
  }
  const cyclicIds = tasks.filter(t => !done.has(t.id)).map(t => t.id);
  return {
    order, cycle: cyclicIds.length > 0, cyclicIds,
    // ΠΑΝ-107：撞号留痕（缺席 = 无撞号 —— 既有消费面零漂移）
    ...(duplicateIds.length > 0 ? { duplicateIds } : {}),
  };
}

/** 对话函数抽象：屏蔽 DSH llm 服务的具体签名，测试时可注入桩函数 */
export type ChatFn = (system: string, user: string) => Promise<string>;

// ─── ΝΩ-3（P1×2 · Planner 通道流式看门狗）───
//
// 病灶：resolvePlannerChat 的 `for await (chunk of llm.stream)` 无 AbortSignal
// 无墙钟上限 —— 一条挂起的流（连一个 chunk 都不吐）把 await 永久钉死；而
// orchestrator 的 timeBudget 检查点全部在 planTasks 之后，冻结的计划相位永远
// 轮不到预算检查，start_complex_task 整体冻结。
// 修法（前沿法则：无进展检测优于总时长）：
//   · idle 看门狗：上一 chunk 起静默超 idleTimeoutMs（缺省 30s）⇒ break，诚实
//     失败归因 'stream-idle' —— 慢而活的流（每 29s 一个 chunk）不误杀，死流
//     30s 必判；
//   · 总预算：totalBudgetMs 在场时（编排器按 timeBudget 的 10% 派生）超限 ⇒
//     归因 'planner-budget'（流层兜底；生产主执法面在 orchestrator 的计划相位
//     预算包裹 —— 那里才知道 timeBudget）；
//   · 时钟/计时器全注入（now / armTimer）—— 测试假钟零真实等待。

/** 流静默看门狗窗（ms）：可配置常量 —— collectStreamWithWatchdog 的 opts.idleTimeoutMs 覆写 */
export const PLANNER_STREAM_IDLE_MS = 30_000;

/** ΝΩ-3（c）：llm.listModels 目录路由的单次调用超时（ms）—— 目录面挂死不拖死路由解析 */
export const PLANNER_LIST_MODELS_TIMEOUT_MS = 5_000;

/** 看门狗计时器面（缺省真 setTimeout；测试注入假钟） */
export interface WatchdogTimer {
  /** ms 后落定为 undefined（哨兵值 —— 合法迭代器结果永不为 undefined，无二义性） */
  promise: Promise<undefined>;
  cancel(): void;
}
export type ArmWatchdogTimer = (ms: number) => WatchdogTimer;

function armRealTimer(ms: number): WatchdogTimer {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<undefined>(resolve => {
    handle = setTimeout(() => resolve(undefined), ms);
    (handle as unknown as { unref?: () => void } | undefined)?.unref?.(); // 看门狗计时器不阻进程退出
  });
  return { promise, cancel: () => { if (handle !== undefined) clearTimeout(handle); } };
}

/** 看门狗失败归因（诚实失败的两分名） */
export type PlannerStreamFailureReason = 'stream-idle' | 'planner-budget';

/** collectStreamWithWatchdog 的产出：成功带聚合文本；失败带归因与可诊断细节 */
export interface StreamCollectOutcome {
  ok: boolean;
  /** ok=true：text-delta 聚合文本；ok=false：空串 */
  text: string;
  /** ok=true：reasoning-delta 尾部 4KB（thinkingFormat 网关兜底用）；ok=false：空串 */
  reasoningTail: string;
  failure: PlannerStreamFailureReason | null;
  detail: string;
}

/**
 * ΝΩ-3（a/b）：流式 Planner 响应的看门狗驱动消费 —— 手动驱动迭代器，每次
 * next() 与「min(剩余 idle 窗, 剩余总预算)」计时器竞速：
 *   · chunk 到达 ⇒ 记账 lastChunkAt（无进展检测的事实源）、按 text-delta /
 *     reasoning-delta 聚合（语义与旧 for-await 循环逐字节一致）；
 *   · 计时器先响 ⇒ break，按武装时判定的先到窗口归因 stream-idle /
 *     planner-budget，best-effort 收尾迭代器（return 挂起不阻塞）；
 *   · 迭代器自身抛错 ⇒ 原样上抛（与 for-await 同路 —— 调用方路由级 catch
 *     收编换下一路由重试的既有语义不变）；在飞 next() 的迟到拒绝在收尾时
 *     静音（绝不升级 unhandledRejection）。
 * 绝不因看门狗自身抛错（计时器面异常视为流故障上抛，路由级 catch 兜底）。
 */
export async function collectStreamWithWatchdog(
  stream: unknown,
  opts: {
    /** 墙钟（缺省 Date.now —— 注入假钟供测试） */
    now?: () => number;
    /** 流静默上限（缺省 PLANNER_STREAM_IDLE_MS） */
    idleTimeoutMs?: number;
    /** 总预算上限（缺省无总限 —— 仅 idle 看门狗执法） */
    totalBudgetMs?: number;
    /** 计时器武装面（缺省真 setTimeout） */
    armTimer?: ArmWatchdogTimer;
  } = {},
): Promise<StreamCollectOutcome> {
  const now = opts.now ?? Date.now;
  const idleMs = typeof opts.idleTimeoutMs === 'number' && Number.isFinite(opts.idleTimeoutMs) && opts.idleTimeoutMs > 0
    ? opts.idleTimeoutMs : PLANNER_STREAM_IDLE_MS;
  const totalMs = typeof opts.totalBudgetMs === 'number' && Number.isFinite(opts.totalBudgetMs) && opts.totalBudgetMs > 0
    ? opts.totalBudgetMs : undefined;
  const arm = opts.armTimer ?? armRealTimer;

  const iter = (stream as { [Symbol.asyncIterator]?: () => AsyncIterator<any> } | null | undefined)
    ?.[Symbol.asyncIterator]?.();
  if (!iter || typeof iter.next !== 'function') {
    // 与 for-await 的 TypeError 同路：由调用方的路由级 catch 收编（换路由重试）
    throw new Error('planner stream is not async-iterable');
  }

  const startAt = now();
  let lastChunkAt = startAt;
  let text = '';
  let reasoningTail = '';
  let failure: PlannerStreamFailureReason | null = null;
  let detail = '';
  let pendingNext: Promise<unknown> | null = null;

  try {
    for (;;) {
      const t = now();
      const idleLeft = idleMs - (t - lastChunkAt);
      const budgetLeft = totalMs !== undefined ? totalMs - (t - startAt) : Number.POSITIVE_INFINITY;
      if (idleLeft <= 0) {
        failure = 'stream-idle';
        detail = `no chunk for ${Math.round(t - lastChunkAt)}ms (idle limit ${Math.round(idleMs)}ms)`;
        break;
      }
      if (budgetLeft <= 0) {
        failure = 'planner-budget';
        detail = `planner stream ran ${Math.round(t - startAt)}ms (budget ${Math.round(totalMs ?? 0)}ms)`;
        break;
      }
      const idleFirst = idleLeft <= budgetLeft;
      const timer = arm(Math.max(0, Math.min(idleLeft, budgetLeft)));
      try {
        pendingNext = iter.next();
        const raced = await Promise.race([pendingNext, timer.promise]) as
          | { done?: boolean; value?: any }
          | undefined;
        if (raced === undefined) {
          // 看门狗先响：按武装时判定的先到窗口归因（双窗取小者武装）
          const t2 = now();
          failure = idleFirst ? 'stream-idle' : 'planner-budget';
          detail = idleFirst
            ? `no chunk for ${Math.round(t2 - lastChunkAt)}ms (idle limit ${Math.round(idleMs)}ms)`
            : `planner stream ran ${Math.round(t2 - startAt)}ms (budget ${Math.round(totalMs ?? 0)}ms)`;
          break;
        }
        if (raced.done) break;
        lastChunkAt = now(); // 无进展记账：本 chunk 即最近进展时刻
        const chunk = raced.value;
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
        if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
          reasoningTail = (reasoningTail + chunk.text).slice(-4000);
        }
      } finally {
        timer.cancel();
      }
    }
  } finally {
    // 在飞 next() 的迟到拒绝静音（看门狗先离场后流才报错 ⇒ 不得 unhandledRejection）；
    // 迭代器尽力收尾（return 挂起不阻塞 —— fire-and-forget，清理是旁路义务）
    if (pendingNext !== null) void pendingNext.catch(() => {});
    try {
      void Promise.resolve(iter.return?.(undefined)).catch(() => {});
    } catch { /* 防御式：收尾失败不影响判决 */ }
  }

  if (failure !== null) {
    console.warn(`[Planner] stream watchdog tripped: ${failure} — ${detail}`);
    return { ok: false, text: '', reasoningTail: '', failure, detail };
  }
  return { ok: true, text, reasoningTail, failure: null, detail: '' };
}

/**
 * ΝΩ-3（c）：单次 await 的总超时包裹 —— 超时/异常/缺席值都落 null（诚实降级
 * 值，绝不抛；调用方 `?? 缺省` 收口）。非 thenable 直通（可选调用 `?.` 产出
 * undefined 的面零开销通过）。
 */
export async function awaitWithTimeout<T>(value: T | undefined | null, ms: number): Promise<T | null> {
  if (value == null || typeof (value as unknown as Promise<T> | null)?.then !== 'function') {
    return (value ?? null) as T | null;
  }
  const p = value as unknown as Promise<T>;
  return new Promise<T | null>(resolve => {
    let settled = false;
    const finish = (v: T | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const handle = setTimeout(() => finish(null), ms);
    (handle as unknown as { unref?: () => void })?.unref?.();
    p.then(
      v => { clearTimeout(handle); finish(v); },
      () => { clearTimeout(handle); finish(null); }, // 被包调用的失败也是「不可用」：null 诚实降级
    );
  });
}

/**
 * ΝΩ-3（d）：JSON 数组区间的括号深度定位 —— 自首个 '[' 起深度计数，回到 0 的
 * 第一个 ']' 即数组真闭（字符串内括号/转义全程豁免）。旧式 first'['..last']'
 * 在尾部噪声含 ']' 时会把噪声圈进切片令 JSON.parse 必炸；深度计数在真闭处
 * 提前截断尾噪声。未闭（截断输出/纯垃圾）⇒ null —— 调用方走旧 [] 失败路径
 * （行为等价：旧实现这类输入同样解析失败落 []）。纯函数零分配（只扫索引）。
 */
export function extractJsonArraySpan(text: string): { start: number; end: number } | null {
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return { start, end: i };
    }
  }
  return null;
}

/** ΠΑΝ-40a：chain 臂铸造的输入面（计划侧供源 —— 调用方持有已解析的动作链）。
 *  actions 是**未受信**的 unknown（LLM 产出/上游翻译），铸造前过 actionSchema
 *  双闸；entrySceneFingerprint/virtualScene/budgetMs 全部可选诚实缺席。 */
export interface PlanReadyChainInput {
  /** 链 id（缺席 ⇒ plan-<ts36> 铸造 —— 经 IdGenerator 同族方言） */
  id?: string;
  /** 动作链（未受信 —— 校验失败整链拒绝，绝不发射半截链） */
  actions: unknown;
  /** 计划时刻的屏指纹（[01]{32,256}；缺席 ⇒ D-5 按排练时刻宿主观察铸造） */
  entrySceneFingerprint?: string;
  /** 规划期 UI 树提取的控件场景（在场 ⇒ 排练可产 L1/L4 真证据） */
  virtualScene?: VirtualWidget[];
  /** 预算（正有限数 —— 域外值诚实缺席，mintIntentPlanReady 同律） */
  budgetMs?: number;
}

/**
 * ΠΑΝ-40a：plan-ready chain 臂铸造（纯函数、永不抛）。方言零新造 —— 载荷
 * 类型 CognitionChainPayload 与 planVersion 常量全部消费 cognitionEvents 单源
 * （D-1 主权；依赖倒置：ActionChain 是 sandbox/types 的 D-5 主权类型）。
 * 诚实分层：actions 非法（校验器拒绝/空链）⇒ 返回 null —— 诚实缺席而非发射
 * 毒证（半截链排练出的证词会污染肌肉记忆库）；合法 ⇒ 铸 origin='cognition'
 * 的 ActionChain（sandbox.receivePlan 消费面）。测试可对返回值直接断言。
 */
export function mintChainPlanReady(input: PlanReadyChainInput): CognitionChainPayload | null {
  if (!input || typeof input !== 'object') return null;
  const verdict = validateActionChainInput(input.actions);
  if (!verdict.ok) return null; // 毒证拦截：非法链不发射（诚实缺席）
  const budgetOk = typeof input.budgetMs === 'number'
    && Number.isFinite(input.budgetMs) && input.budgetMs > 0;
  return {
    chain: {
      id: typeof input.id === 'string' && input.id !== '' ? input.id : `chain-plan-${Date.now().toString(36)}`,
      actions: verdict.actions,
      origin: 'cognition',
      ...(typeof input.entrySceneFingerprint === 'string' && input.entrySceneFingerprint !== ''
        ? { entrySceneFingerprint: input.entrySceneFingerprint }
        : {}),
      ...(Array.isArray(input.virtualScene) && input.virtualScene.length > 0
        ? { virtualScene: input.virtualScene }
        : {}),
      ...(budgetOk ? { budgetMs: input.budgetMs as number } : {}),
    },
    planVersion: COGNITION_PLAN_VERSION, // 世界模型溯源单源（cognitionEvents）
  };
}

/** planTasks 的计划就绪发射钩（ΠΑΝ-40a）：tasks 非空且 chain 铸造合法 ⇒ 发射。
 *  发射是旁路义务 —— 钩子抛错绝不毒化计划主流程（try/catch 收敛）。 */
export interface PlanTasksOptions {
  /** plan-ready 载荷发射面（生产接线：p => emitCognitionPlanReady(ctx, p)） */
  emitPlanReady?: (payload: CognitionPlanReadyPayload) => void;
  /** chain 臂供源（在场且合法 ⇒ 与 tasks 一同发射 —— D-5 排练投喂） */
  chain?: PlanReadyChainInput;
}

export async function planTasks(
  userPrompt: string,
  chat?: ChatFn,
  opts?: PlanTasksOptions,
): Promise<SubTask[]> {
  if (!chat) {
    console.warn('[Planner] LLM 服务不可用，无法拆解任务');
    return [];
  }

  const raw = await chat(PLANNER_SYSTEM_PROMPT, userPrompt);

  // 容错解析：剥离 markdown 代码围栏；数组区间由括号深度计数定位
  //（ΝΩ-3(d)：首 '['..首闭 ']' —— 尾部噪声含 ']' 时旧 lastIndexOf 会把噪声
  // 圈进切片令解析必炸；深度计数在数组真闭处提前截断，字符串内括号豁免）
  const text = raw.replace(/```(json)?/g, '').trim();
  const span = extractJsonArraySpan(text);
  if (!span) {
    console.warn(`[Planner] raw output has no JSON array (len=${raw.length}): ${raw.slice(0, 200)}`);
    return [];
  }

  try {
    const parsed = JSON.parse(text.slice(span.start, span.end + 1));
    if (!Array.isArray(parsed)) return [];
    // J 纪元修正：LLM 漏输出 id 时按序号补齐 —— 旧 filter 不校验 id，
    // orchestrator 会打出 "Task #undefined"（下游 results 格式化失真）。
    const parsedTasks: SubTask[] = parsed
      .filter((t: any) => t && typeof t.action === 'string')
      .map((t: any, i: number) => ({
        ...t,
        id: typeof t.id === 'number' ? t.id : i + 1,
        // Y-9：deps 归一为数字数组（字符串/缺失容错），未知 id 由 topo 边清洗剔除
        deps: Array.isArray(t.deps)
          ? t.deps.filter((d: unknown) => typeof d === 'number').map((d: number) => d)
          : undefined,
      }));
    // ΠΑΝ-107：重复 id 结构化执法 —— LLM 输出两个同号子任务时旧行为是
    // topoSort 的 Map 后者覆盖前者（前一个无声消失）。自动去重留痕方言：
    // 首现者占号、撞号者重编号，绝不静默 —— 病灶与修复都进日志（绝不动
    // 返回形状：SubTask[] 照旧，消费方 orchestrator 零感知）。
    const { tasks, duplicateIds } = dedupeSubTasks(parsedTasks);
    if (duplicateIds.length > 0) {
      console.warn(
        `[Planner] duplicate subtask ids from LLM: [${duplicateIds.join(', ')}] — ` +
        `kept first occurrence at its id, renumbered later duplicates to free ids ` +
        `(deps of renumbered tasks cleared; nothing silently dropped)`,
      );
    }
    // ΠΑΝ-40a：计划就绪 ⇒ 铸造并发射 chain 臂（D-5 排练投喂 —— 闭环第一环）。
    // 诚实分层：空计划/非法动作链 ⇒ 不发射（诚实缺席）；发射钩抛错 ⇒ 旁路
    // 收敛（观察者义务：cognition 事件面故障绝不击穿计划主流程）。
    if (tasks.length > 0 && typeof opts?.emitPlanReady === 'function' && opts.chain) {
      const payload = mintChainPlanReady(opts.chain);
      if (payload !== null) {
        try {
          opts.emitPlanReady(payload);
        } catch (e: any) {
          console.warn(`[Planner] plan-ready chain emission failed (bypass): ${e?.message ?? e}`);
        }
      }
    }
    return tasks;
  } catch (e: any) {
    // 容错解析的失败面也要留痕（与上方 no-array 分支同律）—— LLM 输出畸形的
    // 事实不落日志，降级 [] 就成了不可诊断的静默失败
    console.warn(`[Planner] JSON parse failed: ${String(e?.message ?? e).slice(0, 200)}`);
    return [];
  }
}
