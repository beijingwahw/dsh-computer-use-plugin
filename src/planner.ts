// src/planner.ts
// Planner：将复杂需求拆解为原子子任务。
// 保留原版提示词的全部规则（含「单个屏幕内完成」—— 教规划器体谅执行器的极限）。
// 融合修复：原版签名无 ctx 却想调 ctx.llm -> 改为 ChatFn 依赖注入；
//           「需增加容错处理」的 TODO -> 实现围栏剥离 + 区间截取的 JSON 容错解析。
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
}

export function topoSortSubTasks(tasks: SubTask[]): TopoOrder {
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
  return { order, cycle: cyclicIds.length > 0, cyclicIds };
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

export async function planTasks(userPrompt: string, chat?: ChatFn): Promise<SubTask[]> {
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
    return parsed
      .filter((t: any) => t && typeof t.action === 'string')
      .map((t: any, i: number) => ({
        ...t,
        id: typeof t.id === 'number' ? t.id : i + 1,
        // Y-9：deps 归一为数字数组（字符串/缺失容错），未知 id 由 topo 边清洗剔除
        deps: Array.isArray(t.deps)
          ? t.deps.filter((d: unknown) => typeof d === 'number').map((d: number) => d)
          : undefined,
      }));
  } catch (e: any) {
    // 容错解析的失败面也要留痕（与上方 no-array 分支同律）—— LLM 输出畸形的
    // 事实不落日志，降级 [] 就成了不可诊断的静默失败
    console.warn(`[Planner] JSON parse failed: ${String(e?.message ?? e).slice(0, 200)}`);
    return [];
  }
}
