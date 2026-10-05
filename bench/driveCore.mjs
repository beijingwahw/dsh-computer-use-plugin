// bench/driveCore.mjs — R1-4 硬化驱动的纯逻辑核心(零 IO / 零网络 / 零时钟,可离线自检)
//
// drive-hardened.mjs 的全部决策逻辑抽到此处:重试分类与退避、超时分级(任务级 +
// 总量熔断)、断点续跑清单、prompt 重发防重复、僵尸会话判定、journal 时间窗过滤、
// E2 调度序、停止裁决与状态面渲染。驱动 CLI 只做 IO 编排,决策一律问这里 ——
// 与 sprtCore.mjs/verifyCore.mjs 同律:纯核心受 node:test 全量回归保护
// (test/w2drive.test.ts,w2bench.test.ts 同风格非字面量动态 import)。
//
// 设计原则(与 battery.mjs 的统计诚实同源):
//   1. 瞬态/致命二分:网络层与 HTTP 5xx/429 是瞬态(退避重试);HTTP 4xx 与
//      应用层 ok:false 是致命(重试只会原地撞墙,立即上抛让人看);
//   2. prompt 重发的安全方向:只有「读到历史且确认没送达」才重发 —— 读不到历史时
//      宁可超时也不重发(桌面任务重复执行比一次超时贵得多);
//   3. 确定性:退避默认零抖动(可注入),状态渲染不掺随机;时间一律由调用方注入;
//   4. 串行纪律是类型层事实:核心根本不提供任何并发原语(无并行参数可加错)。

// ─── 常量(全部可被工厂参数/CLI 覆盖) ───
export const RPC_MAX_ATTEMPTS = 4;        // 瞬态失败最大尝试次数(含首发)
export const RPC_BASE_DELAY_MS = 800;     // 退避基时(800ms → 1.6s → 3.2s → 6.4s)
export const RPC_MAX_DELAY_MS = 15000;    // 退避上限
export const TASK_TIMEOUT_MIN_MS = 300000;   // 任务级超时下限(5min,任务书域)
export const TASK_TIMEOUT_MAX_MS = 600000;   // 任务级超时上限(10min,任务书域)
export const TASK_TIMEOUT_DEFAULT_MS = 480000; // suite 未声明 timeoutMs 时的缺省(8min)
export const TOTAL_BUDGET_DEFAULT_MS = 6 * 3600000; // 总量熔断缺省 6h(长夜批量;0=禁用)
export const BUDGET_EXHAUST_FLOOR_MS = 30000;  // 剩余预算 ≤30s 即视为耗尽(不够再开一个任务)
export const WAIT_POLL_MS = 3000;         // 等待空闲的轮询周期
export const WAIT_STARTUP_GRACE_MS = 2000; // 发送后先给会话启动缓冲
export const POLL_ERROR_CIRCUIT = 10;     // 连续轮询失败达此数 ⇒ 熔断该任务的等待

// ─── RPC 错误分类(瞬态/致命二分) ───

/**
 * classifyRpcError —— 错误分类(纯函数):
 *   瞬态(transient):fetch 网络层失败(连接拒绝/重置/超时/DNS)、HTTP 5xx、429;
 *     这些重试有意义 —— DSH 服务重启窗口、端口短暂未就绪、上游抖动。
 *   致命(fatal):HTTP 其余 4xx(请求形状错,重试原样再撞)、应用层 ok:false
 *     (服务明确说了不 —— 会话不存在/参数非法等)。重试只会烧时间,立即上抛。
 * 分类依据错误对象形状(消息/code/status 属性),drive-hardened 的 rpcRetry 在
 * 抛错前会把 HTTP status 与 rpc 拒绝包成带这些属性的错误。
 */
export function classifyRpcError(err) {
  const e = err ?? {};
  const msg = String(e.message ?? e);
  // 网络层:node fetch 失败是 TypeError(code=ECONNREFUSED 等);undici 亦挂 cause.code
  const code = e.code ?? e.cause?.code ?? null;
  if (code && /^(ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN|UND_ERR)/.test(code)) {
    return { kind: 'transient', reason: `net:${code}` };
  }
  if (e.name === 'TypeError' && /fetch|network|failed to fetch/i.test(msg)) {
    return { kind: 'transient', reason: 'fetch-network' };
  }
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return { kind: 'transient', reason: 'request-timeout' };
  const status = typeof e.status === 'number' ? e.status : null;
  if (status !== null) {
    if (status === 429 || status >= 500) return { kind: 'transient', reason: `http:${status}` };
    if (status >= 400) return { kind: 'fatal', reason: `http:${status}` };
  }
  const m = msg.match(/^HTTP (\d{3})\b/); // battery/dsh-drive 风格的 `HTTP 503 on …` 消息
  if (m) {
    const s = Number(m[1]);
    if (s === 429 || s >= 500) return { kind: 'transient', reason: `http:${s}` };
    return { kind: 'fatal', reason: `http:${s}` };
  }
  if (/^rpc\b/.test(msg) || e.rpcRejected === true) return { kind: 'fatal', reason: 'app-rejected' };
  return { kind: 'fatal', reason: 'unclassified-conservative' }; // 未知按致命(保守:不盲重试)
}

/**
 * retryDecision —— 单次失败后的重试裁决(纯函数,驱动循环只服从):
 *   fatal ⇒ 立即 abort;transient 且还有预算 ⇒ retry(delayMs=指数退避封顶,默认零抖动);
 *   尝试次数耗尽 ⇒ abort(reason='exhausted')。attempt 从 1 起数(首发失败 attempt=1)。
 * 抖动:确定性输出纪律,缺省 jitterFn=()=>0;需要打散时由调用方注入。
 */
export function retryDecision({ attempt, error, maxAttempts = RPC_MAX_ATTEMPTS, baseDelayMs = RPC_BASE_DELAY_MS, maxDelayMs = RPC_MAX_DELAY_MS, jitterFn = () => 0 }) {
  const c = classifyRpcError(error);
  const att = Math.max(1, Number(attempt) || 1);
  if (c.kind === 'fatal') return { action: 'abort', classification: c, delayMs: 0, attempt: att, reason: c.reason };
  if (att >= maxAttempts) return { action: 'abort', classification: c, delayMs: 0, attempt: att, reason: 'exhausted' };
  const exp = Math.min(baseDelayMs * 2 ** (att - 1), maxDelayMs);
  return { action: 'retry', classification: c, delayMs: Math.max(0, exp + jitterFn(exp)), attempt: att, reason: c.reason };
}

/** backoffSchedule —— 前 n 次重试的退避序列(文档/测试用;确定性,零抖动) */
export function backoffSchedule({ retries = RPC_MAX_ATTEMPTS - 1, baseDelayMs = RPC_BASE_DELAY_MS, maxDelayMs = RPC_MAX_DELAY_MS } = {}) {
  const out = [];
  for (let a = 1; a <= retries; a++) out.push(Math.min(baseDelayMs * 2 ** (a - 1), maxDelayMs));
  return out;
}

// ─── 超时分级:任务级钳制 + 总量熔断 ───

/** clampTaskTimeout —— suite 的 timeoutMs 钳到任务书域 [5min, 10min];未声明用缺省 8min */
export function clampTaskTimeout(requested, { min = TASK_TIMEOUT_MIN_MS, max = TASK_TIMEOUT_MAX_MS, defaultMs = TASK_TIMEOUT_DEFAULT_MS } = {}) {
  const v = Number.isFinite(requested) ? requested : defaultMs;
  return Math.min(max, Math.max(min, v));
}

/**
 * timeoutPlan —— 一个任务开跑前的超时预算(纯函数):
 *   · 任务级:clampTaskTimeout 钳制后的 taskTimeoutMs;
 *   · 总量:totalBudgetMs>0 时 effectiveTimeoutMs = min(任务级, 剩余预算);
 *     剩余 ≤ BUDGET_EXHAUST_FLOOR_MS(30s)或 ≤0 ⇒ budgetExhausted=true(熔断:
 *     剩的钱不够再开一个任务,长夜跑偏的保险丝);totalBudgetMs=0 ⇒ 禁用熔断。
 *   · 轮询连续失败熔断预算(POLL_ERROR_CIRCUIT)属于等待循环,不在此处。
 */
export function timeoutPlan({ taskTimeoutMs, totalBudgetMs = TOTAL_BUDGET_DEFAULT_MS, totalElapsedMs = 0, now = null, startedAtMs = null } = {}) {
  const taskTimeout = clampTaskTimeout(taskTimeoutMs);
  const elapsed = startedAtMs !== null && now !== null ? Math.max(0, now - startedAtMs) : Math.max(0, totalElapsedMs);
  const disabled = !totalBudgetMs || totalBudgetMs <= 0;
  if (disabled) return { taskTimeoutMs: taskTimeout, effectiveTimeoutMs: taskTimeout, totalBudgetMs: 0, totalRemainingMs: null, budgetExhausted: false, disabled: true };
  const remaining = totalBudgetMs - elapsed;
  const exhausted = remaining <= BUDGET_EXHAUST_FLOOR_MS;
  return {
    taskTimeoutMs: taskTimeout,
    effectiveTimeoutMs: exhausted ? 0 : Math.max(BUDGET_EXHAUST_FLOOR_MS, Math.min(taskTimeout, remaining)),
    totalBudgetMs, totalRemainingMs: remaining, budgetExhausted: exhausted, disabled: false,
  };
}

// ─── 断点续跑清单(崩溃后重入:已完成任务 id 集合,重入跳过) ───

/**
 * loadResumeState —— resume-state.json 的形状校验(纯函数;读文件在 CLI 侧):
 *   { schema:'dsh-drive-resume/1', runId, doneTaskIds:[], liveSessions:{taskId:sessionId} }
 * 容忍字段缺席(老文件/手写);形状不对(非对象/doneTaskIds 非字符串数组/liveSessions
 * 值非字符串)⇒ 抛错 fail-fast —— 半个坏状态静默重跑会把「已完成」重新烧一遍真机预算。
 */
export function loadResumeState(parsed) {
  if (parsed == null) return { runId: null, doneTaskIds: [], liveSessions: {} };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('resume-state 须为对象');
  const runId = parsed.runId ?? null;
  if (runId !== null && typeof runId !== 'string') throw new Error('resume-state.runId 须为字符串');
  if (parsed.doneTaskIds === undefined) return { runId, doneTaskIds: [], liveSessions: {} };
  if (!Array.isArray(parsed.doneTaskIds) || parsed.doneTaskIds.some((x) => typeof x !== 'string')) {
    throw new Error('resume-state.doneTaskIds 须为字符串数组');
  }
  let live = {};
  if (parsed.liveSessions !== undefined) {
    if (typeof parsed.liveSessions !== 'object' || Array.isArray(parsed.liveSessions)) throw new Error('resume-state.liveSessions 须为对象 {taskId:sessionId}');
    for (const [k, v] of Object.entries(parsed.liveSessions)) {
      if (typeof v !== 'string') throw new Error(`resume-state.liveSessions.${k} 须为字符串 sessionId`);
    }
    live = parsed.liveSessions;
  }
  return { runId, doneTaskIds: [...parsed.doneTaskIds], liveSessions: live };
}

/**
 * planRun —— 断点续跑的任务清单裁剪(纯函数):
 *   done 中的 id ⇒ skipped(保留原 suite 顺序);suite 里没有的 done id ⇒ staleDoneIds
 *   (如实上报:可能是改了 suite 或手改了状态文件,不瞎猜);返回 run 清单保持原序。
 * 幂等:同一 (tasks, doneIds) 恒得同一计划。
 */
export function planRun(tasks, doneIds) {
  const done = new Set(doneIds ?? []);
  const run = [], skipped = [];
  for (const t of tasks) (done.has(t.id) ? skipped : run).push(t);
  const staleDoneIds = [...done].filter((id) => !tasks.some((t) => t.id === id));
  return { run, skipped, staleDoneIds, doneCount: skipped.length };
}

/**
 * commitTaskDone —— 一个任务收口后合并进续跑状态(纯函数,返回新状态;CLI 落盘)。
 * liveSessions 中该任务若有登记则清除(会话已终局),下次重入不再回收它。
 */
export function commitTaskDone(state, taskId) {
  const done = new Set(state.doneTaskIds);
  done.add(taskId);
  const live = { ...state.liveSessions };
  delete live[taskId];
  return { schema: 'dsh-drive-resume/1', runId: state.runId, doneTaskIds: [...done], liveSessions: live };
}

/**
 * registerLiveSession —— 会话创建后立即登记(崩溃窗口的僵尸线索):
 * 状态文件在「创建会话成功」与「任务收口」之间的任意时刻都可能被 hard-kill,
 * liveSessions 就是重入时回收僵尸(还在 running 的残留会话)的依据。
 */
export function registerLiveSession(state, taskId, sessionId) {
  return { schema: 'dsh-drive-resume/1', runId: state.runId, doneTaskIds: [...state.doneTaskIds], liveSessions: { ...state.liveSessions, [taskId]: sessionId } };
}

// ─── prompt 重发防重复(安全方向:读不到证据 ⇒ 不重发) ───

/**
 * shouldResendPrompt —— prompt 瞬态失败后是否重发(纯函数):
 *   只有「历史可读 且 其中没有该 prompt(前缀匹配) 且 会话未在跑」三证齐 ⇒ resend;
 *   历史读不到(historyAvailable=false)⇒ hold(标记 promptUncertain 继续等):
 *   桌面任务重复执行两遍比一次任务级超时贵得多,不确定时宁可让任务级超时兜底。
 */
export function shouldResendPrompt({ historyAvailable, promptSeen, running }) {
  if (historyAvailable !== true) return { resend: false, mode: 'hold-uncertain', reason: '历史不可读 —— 无送达证据,重发有重复执行风险,由任务级超时兜底' };
  if (promptSeen || running) return { resend: false, mode: 'already-sent', reason: running ? '会话已运行(prompt 已被消费)' : '历史已见该 prompt' };
  return { resend: true, mode: 'resend', reason: '三证齐:历史可读、未见 prompt、会话未跑 —— 确未送达,重发安全' };
}

/** promptSeenInHistory —— 历史事件流里找 user/message 的文本前缀匹配(prompt 送达证据) */
export function promptSeenInHistory(historyValue, text, prefixLen = 80) {
  const needle = String(text ?? '').trim().slice(0, prefixLen);
  if (!needle) return false;
  const events = historyValue?.events ?? [];
  for (const entry of events) {
    const e = entry?.event;
    if (e?.type !== 'user/message') continue;
    const t = (e.data?.content ?? []).map((p) => p?.text ?? '').join('');
    if (t.includes(needle)) return true;
  }
  return false;
}

// ─── 僵尸会话回收(只回收自己的) ───

/**
 * findZombieSessions —— session.list 结果里的僵尸判定(纯函数):
 *   僵尸 = running=true **且** 属于 ownSessionIds(本驱动创建,有案可查)**且**
 *   不是当前活跃会话(activeSessionId —— 它正在干活,不是僵尸)。
 *   不在 ownSessionIds 里的 running 会话一律不动(NOT_OURS):那是操作者/其他工具
 *   的真实桌面会话,自动取消别人的会话是越权 —— 回收纪律以「所有权」为界。
 */
export function findZombieSessions(listItems, { ownSessionIds = [], activeSessionId = null } = {}) {
  const own = new Set(ownSessionIds);
  const active = activeSessionId ?? null;
  const zombies = [], notOurs = [];
  for (const it of listItems ?? []) {
    if (!it?.running) continue;
    const id = it.sessionId;
    if (id === active) continue;
    (own.has(id) ? zombies : notOurs).push(id);
  }
  return { zombies, notOurs, policy: 'own-only(NOT_OURS 不回收 —— 所有权纪律)' };
}

// ─── journal 时间窗过滤(证据采集,纯解析) ───

/**
 * journalWindow —— bench/journal*.jsonl 的任务窗口切片(纯函数):
 *   逐行 JSON.parse,保留 t0 ≤ ts ≤ t1 的行(ts 为 epoch ms;窗口边界用任务的
 *   startedAtMs/finishedAtMs);坏行/空行 dropped 计数上账(证据采集对损坏行
 *   诚实计数,不静默吞)。返回原始行(保序)供直接落盘 journal-lines.jsonl。
 */
export function journalWindow(lines, { t0Ms, t1Ms } = {}) {
  const kept = [];
  let dropped = 0;
  for (const line of lines ?? []) {
    const s = String(line).trim();
    if (!s) { dropped += 1; continue; }
    let j;
    try { j = JSON.parse(s); } catch { dropped += 1; continue; }
    const ts = Number(j?.ts);
    if (!Number.isFinite(ts)) { dropped += 1; continue; } // 合法 JSON 但无 ts —— 对本切片而言同样不可用
    if (ts < t0Ms || ts > t1Ms) continue; // 窗口外:可用行,只是不属于本任务
    kept.push(s);
  }
  return { kept, dropped, window: { t0Ms, t1Ms } };
}

// ─── E2 调度序(每任务结束后的后置动作次序) ───

/**
 * planPostTask —— 任务收口后的动作序列(纯函数;驱动只按序执行):
 *   固定序:history-export → evidence:hist → evidence:events → evidence:journal →
 *   e2:verify(仅当任务声明 verify 块)→ receipt → status。
 *   纪律:① 全部动作发生在会话终局之后 —— 采集/核查永不打断任务;
 *         ② E2 紧跟证据落盘(世界状态定格后立刻独立核查,不隔夜);
 *         ③ 无 verify 块 ⇒ 无 e2 步骤(不造核查),回执如实记 e2=absent。
 */
export function planPostTask(task) {
  const steps = ['history-export', 'evidence:hist', 'evidence:events', 'evidence:journal'];
  if (task?.verify) steps.push('e2:verify');
  steps.push('receipt', 'status');
  return { steps, hasE2: !!task?.verify, note: '采集与核查全部后置于会话终局;e2 仅在 verify 块存在时调度' };
}

// ─── 停止裁决(kill-switch 优先级) ───

/**
 * stopDecision —— 三路停止信号的优先级仲裁(纯函数):
 *   interrupted(Ctrl-C)> stopfile(文件触发)> budgetExhausted(总量熔断);
 *   全无 ⇒ null 继续。驱动在每轮任务前与等待轮询的每个 tick 都问一次。
 */
export function stopDecision({ interrupted = false, stopfileExists = false, budgetExhausted = false } = {}) {
  if (interrupted) return { stop: true, reason: 'sigint', exitCode: 130 };
  if (stopfileExists) return { stop: true, reason: 'stopfile', exitCode: 3 };
  if (budgetExhausted) return { stop: true, reason: 'total-budget', exitCode: 0 };
  return null;
}

// ─── 观测面:单行状态 + 汇总 JSON(确定性渲染,时间由调用方注入) ───

/** fmtDur —— ms → HH:MM:SS(状态行用的确定性时长形态) */
export function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

/**
 * renderStatusLine —— 运行时仪表的单行状态(纯函数):
 *   `run=<id> suite=<name> tasks=<done>/<total> state=<RUNNING|IDLE|STOPPED> task=<id>
 *    elapsed=<HH:MM:SS> pass/fail/unknown/skip=<n> fails=[a,b] stopfile=<yes|no>`
 * 状态文件每 tick 重写(tmpl+rename 原子替换),供人/脚本 tail 单行读全局。
 */
export function renderStatusLine(state) {
  const s = state ?? {};
  const fails = (s.failures ?? []).join(',');
  return `run=${s.runId ?? '-'} suite=${s.suiteName ?? '-'} tasks=${s.done ?? 0}/${s.total ?? 0} state=${s.state ?? 'IDLE'} task=${s.currentTask ?? '-'} elapsed=${fmtDur(s.elapsedMs ?? 0)} pass=${s.pass ?? 0} fail=${s.fail ?? 0} unknown=${s.unknown ?? 0} skip=${s.skip ?? 0} fails=[${fails}] stopfile=${s.stopfileExists ? 'yes' : 'no'}`;
}

/**
 * buildRunSummary —— 汇总 JSON 的纯构造(落盘 summary.json;时间戳由调用方注入):
 *   totals 与 per-task 明细同源一次计算,失败清单/跳过清单/活会话/停止原因全显性。
 */
export function buildRunSummary({ schema = 'dsh-drive-hardened/1', runId, suiteFile, suiteName, model, startedAtIso, updatedAtIso, elapsedMs, taskRecords = [], skippedIds = [], liveSession = null, stoppedBy = null, rpcSummary = null }) {
  const judged = taskRecords.filter((r) => !r.rerunOf);
  const count = (fn) => judged.filter(fn).length;
  return {
    schema, runId, suiteFile, suiteName, model,
    startedAt: startedAtIso, updatedAt: updatedAtIso, elapsedMs,
    totals: {
      total: judged.length, done: judged.length,
      pass: count((r) => r.pass === true), fail: count((r) => r.pass === false),
      unknown: count((r) => r.pass === undefined),
      timedOut: count((r) => r.timedOut), harnessErrors: count((r) => r.harnessError),
    },
    failures: judged.filter((r) => r.pass === false).map((r) => r.id),
    skippedIds,
    liveSession,
    stoppedBy,
    rpc: rpcSummary,
    tasks: taskRecords,
  };
}

// ─── R2-3(焦点保卫):宿主窗口回合结束自抬抢焦的驱动器侧防线(纯函数,零 IO) ───
//
// 病灶(R1-8 §5.4):DSH 桌面宿主(Electron)在回合结束渲染会话事件时自抬主窗口
// 抢焦 —— 任务进行中菜单/对话框的存活窗口期被盖,插件键鼠动作落错窗口。
// 驱动器对策:等待环内周期性探测前台窗,命中宿主标记 ⇒ 只压宿主窗
// (ShowWindowAsync SW_MINIMIZE=6 —— 不用 MinimizeAll,后者会把目标应用窗
// 一并收起,破坏 agent 正在操作的现场)。与任务前的双 MinimizeAll 互补:
// 那是「开跑前给干净桌面」,这是「跑动中保焦点」。
// 决策与脚本构造全部在本文件(纯函数,受 test/r23.focusGuard.test.ts 离线回归);
// drive-desktop.mjs 只做 spawn 编排。

/** 焦点保卫探测间隔缺省(ms):比轮询周期(3s)宽 —— PS 冷启动 ~300ms/次,
 *  9s 一拍把开销压在 ~3%,且抢焦窗口(回合结束事件渲染)秒级,9s 内必有一次
 *  收敛机会。0 = 关闭。 */
export const HOST_FOCUS_GUARD_INTERVAL_MS = 9000;

/** 宿主窗口标记缺省(子串匹配,大小写不敏感):本机实测宿主进程名与
 *  主窗口标题均为 "DeepSeek Harness"(Get-Process 枚举)。 */
export const HOST_WINDOW_MARKERS_DEFAULT = ['DeepSeek Harness'];

/** R2-3:标记 CSV → 去空白数组(空项丢弃;全空 ⇒ 缺省表)。纯函数。 */
export function parseHostMarkersCsv(csv, fallback = HOST_WINDOW_MARKERS_DEFAULT) {
  const items = String(csv ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  return items.length > 0 ? items : [...fallback];
}

/**
 * R2-3:是否到点跑一拍焦点保卫(纯函数;时间由调用方注入)。
 * intervalMs<=0 ⇒ 恒 false(关闭);从未跑过(lastGuardMs==null)⇒ 立即 true;
 * 否则距上拍 ≥ intervalMs 才 true —— 防抖:PS 冷启动不便宜,不做每 poll 一拍。
 */
export function shouldRunHostFocusGuard({ nowMs, lastGuardMs = null, intervalMs = HOST_FOCUS_GUARD_INTERVAL_MS }) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return false;
  if (lastGuardMs === null || lastGuardMs === undefined) return true;
  return Number(nowMs) - Number(lastGuardMs) >= intervalMs;
}

/**
 * R2-3:前台标题判决 —— 命中任一宿主标记(大小写不敏感子串)⇒ hostForeground。
 * null/空标题(探测失败/桌面焦点)⇒ false:证据缺失不算抢焦(拦截面只认正证据)。
 * 纯函数。
 */
export function hostGuardVerdict(foregroundTitle, markers) {
  const t = typeof foregroundTitle === 'string' ? foregroundTitle.trim().toLowerCase() : '';
  if (t === '') return { hostForeground: false };
  const list = Array.isArray(markers) ? markers : [];
  return { hostForeground: list.some((m) => typeof m === 'string' && m.trim() !== '' && t.includes(m.trim().toLowerCase())) };
}

/** R2-3:PS 单引号字面量转义(单引号加倍)—— 标记进 PS 数组的注入闸(纵深防御:
 *  标记来自操作者 env/CLI,非模型输入,仍按数据不按语法对待)。纯函数。 */
export function psQuote(s) {
  return `'${String(s ?? '').replace(/'/g, "''")}'`;
}

/**
 * R2-3:焦点保卫单拍 PS 脚本(纯字符串构造)。
 * 单次往返完成「读前台标题 → 判定 → (命中才)最小化宿主窗」:
 *   Add-Type P/Invoke GetForegroundWindow/GetWindowText/ShowWindowAsync 一次编译;
 *   输出唯一标记行 `HOSTGUARD|suppressed|<title>` / `HOSTGUARD|pass|<title>`
 *  (JS 侧 parseHostGuardLine 消费;标题内换行已在 PS 侧折叠为空格)。
 */
export function buildHostGuardPs(markers) {
  const arr = (Array.isArray(markers) && markers.length > 0 ? markers : HOST_WINDOW_MARKERS_DEFAULT)
    .map((m) => psQuote(String(m))).join(',');
  return (
    "Add-Type -Name FG -Namespace Win -MemberDefinition '"
    + '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); '
    + '[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n); '
    + '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c); '
    + "'; "
    + `$sb = New-Object System.Text.StringBuilder 512; `
    + `$h = [Win.FG]::GetForegroundWindow(); `
    + `[void][Win.FG]::GetWindowText($h, $sb, 512); `
    + `$t = $sb.ToString().Replace([char]13, ' ').Replace([char]10, ' ').Trim(); `
    + `$hit = $false; foreach ($m in @(${arr})) { if ($t -ne '' -and $t.ToLower().Contains($m.ToLower())) { $hit = $true } }; `
    + `if ($hit) { [Win.FG]::ShowWindowAsync($h, 6) | Out-Null; Write-Output ('HOSTGUARD|suppressed|' + $t) } `
    + `else { Write-Output ('HOSTGUARD|pass|' + $t) }`
  );
}

/** R2-3:HOSTGUARD 标记行解析(纯函数)。无标记行(PS 报错/方言漂移)⇒
 *  {action:'unknown'} —— 驱动只记数不动窗口(诚实降级,不猜)。 */
export function parseHostGuardLine(stdout) {
  for (const raw of String(stdout ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('HOSTGUARD|')) continue;
    const parts = line.split('|');
    if (parts.length >= 3 && (parts[1] === 'suppressed' || parts[1] === 'pass')) {
      return { action: parts[1], title: parts.slice(2).join('|') };
    }
    return { action: 'unknown', title: null };
  }
  return { action: 'unknown', title: null };
}

// ─── R3-1(打字防串窗):type_text 回执污染扫描(纯函数,零 IO) ───
//
// 补完 R2-3 遗留的驱动器侧事后防线:插件侧 typeFocusGuard 在键入**前**拦宿主
// 前台,但通道缺席(python 后端不在)时是 unchecked 放行 —— 字可能已落进宿主
// 聊天输入框(文本混入下一回合 user prompt,自我注入面,R2-3 §1 最危险危害)。
// 驱动器在等待环内周期拉历史增量,扫两类「宿主输入框特征」:
//   ① typed-into-host:type_text 的回执文本命中宿主标记(focus_guard 注记的
//      foreground_title / FAILED 方言)——字进了宿主窗;
//   ② self-injected-message:出现**不是驱动下发 prompt** 的 user/message
//      (输入框内容被提交 = 注入已成事实)。
// 检出 ⇒ 驱动 cancel 会话并记 rec.polluted(污染后的轨迹/自报不可信)。
// 拦截面纪律同 R2-3:只认正证据;插件焦点保卫已拦下的 FAILED(blocked)
// 记 nearMiss 不算污染(字没打出去)。

/** 打字类工具名(仅这些工具的回执参与特征 ①) */
export const TYPING_TOOLS = ['type_text'];

/** R3-1:宿主自身注入的 user/message 前缀白名单 —— 既非驱动下发也非污染,是宿主
 * 回合机制(runtime context 快照 / skill 提示)的合法 user-role 事件。形态依据:
 * 2026-10-05 全量历史证据(R1-8 九轮 + R3-1 冒烟)枚举,宿主注入 user 行仅此两种。
 * R5-1 补登(AGON 批2 T8 round5 实证 seq184):宿主对「重复同参工具调用」的
 * 纠偏提示也是 user-role 注入 —— 形态固定开头 "You are repeating the exact
 * same tool call with identical arguments" —— 误判 self-injected-message 会把
 * traj+e2 双绿的任务错杀为 POLLUTED(本轮实证),按 R3-1 枚举法收编。 */
export const HOST_INJECTED_USER_PREFIXES = [
  'current runtime context.',
  '<system-reminder>',
  'You are repeating the exact same tool call with identical arguments',
];

/** R3-1:type_text 类回执 + user/message 的污染扫描(纯函数)。
 *  rows 用 drive-desktop.compactHistory 的形状(call/result/user 混排按 seq 升序);
 *  promptNeedle = 驱动下发 prompt 的前缀(≤80 字符,user/message 含它 ⇒ 合法)。
 *  返回 { polluted, findings:[{seq,kind,tool?,snippet}] } —— findings 为空 ⇒ 无污染。 */
export function scanTypingPollution(rows, { promptNeedle = '', markers = HOST_WINDOW_MARKERS_DEFAULT } = {}) {
  const mk = (Array.isArray(markers) ? markers : [])
    .filter((m) => typeof m === 'string' && m.trim() !== '')
    .map((m) => m.trim().toLowerCase());
  const needle = String(promptNeedle ?? '').trim().slice(0, 80);
  const isHostInjected = (text) => HOST_INJECTED_USER_PREFIXES.some((p) => text.toLowerCase().startsWith(p));
  const findings = [];
  let pendingTool = null; // 最近一个 call 的工具名 —— result 按 seq 紧随其 call
  for (const r of rows ?? []) {
    if (!r || typeof r !== 'object') continue;
    if (r.kind === 'call') {
      pendingTool = typeof r.name === 'string' ? r.name : null;
      continue;
    }
    if (r.kind === 'result') {
      const text = String(r.text ?? '');
      if (pendingTool && TYPING_TOOLS.includes(pendingTool) && text !== '') {
        const blocked = /Focus guard: typing was blocked/i.test(text); // R2-3 插件闸拦下:字没打出去
        const hostHit = mk.some((m) => text.toLowerCase().includes(m));
        if (hostHit && !blocked) {
          findings.push({ seq: r.seq ?? null, kind: 'typed-into-host', tool: pendingTool, snippet: text.slice(0, 160) });
        }
      }
      pendingTool = null;
      continue;
    }
    if (r.kind === 'user') {
      if (needle === '') continue; // 无 prompt 判据 ⇒ user/message 判定不激活(缺判据不猜)
      const text = String(r.text ?? '').trim();
      if (text === '') continue;
      if (isHostInjected(text)) continue; // 宿主回合机制的合法 user-role 注入(runtime context/skill 提示)
      if (text.includes(needle)) continue; // 驱动下发的任务 prompt 本体
      findings.push({ seq: r.seq ?? null, kind: 'self-injected-message', snippet: text.slice(0, 160) });
    }
  }
  return { polluted: findings.length > 0, findings };
}

// ─── R3-3(GAP-4 会话轮数护栏):宿主规划脑消耗的驱动器侧防线(纯函数,零 IO) ───
//
// 病灶(R2-8 §3/GAP-4):DSH 宿主(dsh-llm)只有 per-request maxTokens,无会话级
// 轮/token 预算 —— 单任务若陷入旁路循环(R1-8 attempt8 型:49 调用零 GUI 存盘),
// 宿主 token 只被任务超时(5-10min)钳制,长夜批量下这是最贵的烧钱面。驱动器在
// 等待环内从会话事件流取当前轮号(e.data.turn),达上限即 cancel + 回执记
// 'turn-cap'。判定与提取全部在此(纯函数,受 test/r33.maxturns.test.ts 离线回归);
// drive-desktop.mjs 只做轮询编排。

/** R3-3:会话轮数上限缺省 —— 60(R2-8 §2.3/§3 标定:每任务 10-50 轮是常态上界,
 *  60 在常态之上、失控循环之下;CLI --max-turns-per-session 覆盖,0=关闭)。 */
export const MAX_TURNS_PER_SESSION_DEFAULT = 60;

/**
 * R3-3:session-events 轮数提取(纯函数)—— 事件流里 data.turn 的最大有限非负值
 * 即「当前轮号」(turn 单调前进,max 即现在第几轮;兼容桌面 page 帧
 * {type:'event',event:{data:{turn}}} 与直接事件两种形状,compactHistory 同方言)。
 * 无任何 turn 证据 ⇒ null(等待环据此判「证据缺失,不拦」)。
 */
export function sessionTurnCount(events) {
  let max = null;
  for (const entry of events ?? []) {
    const e = entry?.event ?? entry;
    const raw = e?.data?.turn ?? e?.turn ?? null;
    // null/undefined 是「无 turn 字段」不是第 0 轮(Number(null)===0 的坑)——跳过
    const n = raw === null || raw === undefined ? Number.NaN : Number(raw);
    if (Number.isFinite(n) && n >= 0 && (max === null || n > max)) max = n;
  }
  return max;
}

/**
 * R3-3:轮数护栏判定(纯函数)——
 *   · maxTurnsPerSession ≤0/非有限 ⇒ {enabled:false} 恒不拦(关闭);
 *   · turnCount null(事件流无 turn 证据)⇒ 不拦 —— 证据缺失不算超限(与
 *     hostGuardVerdict 的「只认正证据」同律,老宿主事件流无 turn 字段不误伤);
 *   · 当前轮号 ≥ 上限 ⇒ exceeded:true(第 N 轮已在跑,不再放行第 N+1 轮 ——
 *     护栏语义是成本闸,宁早半轮不晚半轮)。
 */
export function turnCapDecision({ maxTurnsPerSession = MAX_TURNS_PER_SESSION_DEFAULT, turnCount = null } = {}) {
  const capRaw = Number(maxTurnsPerSession);
  const enabled = Number.isFinite(capRaw) && capRaw > 0;
  const cap = enabled ? Math.floor(capRaw) : 0;
  // turnCount null/undefined = 事件流无 turn 证据(Number(null)===0 的坑须避开)
  const tc = turnCount === null || turnCount === undefined ? Number.NaN : Number(turnCount);
  const turns = Number.isFinite(tc) && tc >= 0 ? tc : null;
  const exceeded = enabled && turns !== null && turns >= cap;
  return { enabled, limit: cap, turnCount: turns, exceeded };
}

// ─── R5-1(无人值守审批止损):审批闸死锁看护(纯函数,零 IO) ───
//
// 病灶(AGON 批2 T8 双败):任务触发 ACTION_REQUESTED 审批后无人应答 —— agent
// 在闸门前反复绕行烧真机预算,最终以 PENDING_USER_CONSENT 收尾或干等任务级
// 超时(两轮合计 ~7.3min 大半耗在闸门绕行)。无人值守考核没有应答者,等待即
// 纯损耗:驱动器在等待环内观测审批请求,超时即 cancel 止损并如实记回执。
// 缺省 0=关(零回归;有人值守批不启),无人值守批由 CLI/orchestrator 显式开
//(R4-1 修复建议 C 的驱动器侧落地)。

/** 审批待应答标记(结果文本方言):闸门拦截(ACTION_REQUIRED)或令牌铸造
 *  (PENDING_USER_CONSENT)任一命中即「审批已请求、尚未应答」。 */
export const APPROVAL_PENDING_MARKERS = ['ACTION_REQUIRED', 'PENDING_USER_CONSENT'];

/** R5-1:审批看护的增量扫描节拍(ms)—— 与焦点保卫缺省节拍同量级(9s):
 *  60s 级超时窗内 ~6 个观测点,RPC 开销与 typing 扫描同拍量级。 */
export const APPROVAL_SCAN_INTERVAL_MS = 9000;

/** R5-1:审批看护状态的空态(纯函数)。 */
export function approvalWatchInit() {
  return { pendingSinceMs: null, pendingSeq: null, requests: 0, responses: 0, lastResolution: null };
}

/**
 * R5-1:增量行折叠审批看护状态(纯函数;rows 用 compactHistory 形状,seq 升序):
 *   · result 行文本命中审批标记 ⇒ 立起 pending(已有未解 pending ⇒ 不重置时钟
 *     —— 连环请求不续命,止损从最早未解请求起算);
 *   · grant_approval 的 result 行(任何结果,含 code-attempts-exhausted)⇒ 视为
 *     一次应答尝试,清 pending(模型若再发 request 会重新立起,时钟重启 ——
 *     这是合法的二次请求语义,不是续命);
 *   · user 行(非驱动 prompt、非宿主机制注入)⇒ 操作员在场面,清 pending ——
 *     有人值守时看护自动失活,直到下一次无人应答的请求。
 * nowMs 由调用方注入(确定性);返回新状态(不可变更新)。
 */
export function approvalFold(state, rows, { promptNeedle = '', nowMs = 0 } = {}) {
  const s = { ...(state ?? approvalWatchInit()) };
  const needle = String(promptNeedle ?? '').trim().slice(0, 80);
  let pendingTool = null; // 最近一个 call 的工具名 —— result 按 seq 紧随其 call
  for (const r of rows ?? []) {
    if (!r || typeof r !== 'object') continue;
    if (r.kind === 'call') {
      pendingTool = typeof r.name === 'string' ? r.name : null;
      continue;
    }
    if (r.kind === 'result') {
      const text = String(r.text ?? '');
      if (pendingTool === 'grant_approval') {
        s.responses += 1;
        if (s.pendingSinceMs !== null) { s.lastResolution = 'grant_approval'; s.pendingSinceMs = null; s.pendingSeq = null; }
      } else if (APPROVAL_PENDING_MARKERS.some((m) => text.includes(m))) {
        s.requests += 1;
        if (s.pendingSinceMs === null) { s.pendingSinceMs = nowMs; s.pendingSeq = Number.isFinite(r?.seq) ? r.seq : null; }
      }
      pendingTool = null;
      continue;
    }
    if (r.kind === 'user') {
      if (needle === '') continue;
      const text = String(r.text ?? '').trim();
      if (text === '') continue;
      if (HOST_INJECTED_USER_PREFIXES.some((p) => text.toLowerCase().startsWith(p))) continue;
      if (text.includes(needle)) continue; // 驱动下发的任务 prompt 本体
      if (s.pendingSinceMs !== null) { s.responses += 1; s.lastResolution = 'operator-message'; s.pendingSinceMs = null; s.pendingSeq = null; }
    }
  }
  return s;
}

/**
 * R5-1:审批死锁判决(纯函数)——
 *   timeoutMs ≤0/非有限 ⇒ {enabled:false} 恒不触发(关闭);
 *   无未解 pending ⇒ 不触发;pending 持续 ≥ timeoutMs ⇒ exceeded:true。
 * 时间由调用方注入;pendingSinceMs 亦是驱动器观测时刻(非行产生时刻,增量拉取
 * 分辨率 ≈ 焦点保卫节拍)。
 */
export function approvalDeadlockDecision({ timeoutMs = 0, pendingSinceMs = null, nowMs = 0 } = {}) {
  const t = Number(timeoutMs);
  const enabled = Number.isFinite(t) && t > 0;
  if (!enabled) return { enabled: false, exceeded: false };
  if (pendingSinceMs === null || pendingSinceMs === undefined || !Number.isFinite(Number(pendingSinceMs))) {
    return { enabled: true, exceeded: false };
  }
  const pendingMs = Math.max(0, Number(nowMs) - Number(pendingSinceMs));
  return { enabled: true, exceeded: pendingMs >= t, pendingMs };
}

// ─── R6-1(事件窗口截断):增量事件捕获(纯函数,零 IO) ───
//
// 病灶(R5-1 §5 条件②,批2 双实证):宿主 session/page 只保留最近 ~250 事件 ——
// 长任务(T8 六轮/d4 族 T19/T22/T23)收口时的一次性历史导出必然截断早期轨迹,
// traj 判据(expect 匹配整个轨迹 JSON)与证据包完整性受累(prompt 行=read_text
// 回声源在截断面上下漂移)。驱动器对策:等待环每 tick 增量拉取事件流,seq 新于
// 已捕获游标的记录立即交调用方持久化(append 本地证据文件);任务收口时增量与
// 终局快照按 seq 去重合并(终局为准)——证据不再受宿主窗口截断。两 tick 间事件
// 风暴超过窗口容量时仍会有空洞:gaps 如实上账(证据缺失不伪装)。

/** R6-1:捕获状态空态。maxSeq=已见最大事件序号(null=尚未见过任何事件)。 */
export function eventCaptureInit() {
  return { maxSeq: null, captured: 0, gaps: [] };
}

/**
 * R6-1:增量折叠(纯)——records 为 session/page 的原始帧({type:'event',event:{seq}}
 * 或直接事件,compactHistory 同方言)。返回 { state, records, skippedNoSeq }:
 *   · records=本次新增(seq > state.maxSeq,升序)——调用方立即持久化;
 *   · 窗口空洞如实入 gaps:首拉未从 seq 0 起(afterSeq:null)或跳段
 *     (minNew > maxSeq+1)——两 tick 间事件风暴超窗口容量的痕迹;
 *   · 无 seq 的记录跳过并计数(诚实:不进 records 不静默吞)。
 * 幂等:同 records 二次折叠 ⇒ 空 records(state 不变)。
 */
export function eventCaptureDelta(state, records) {
  const s = state ?? eventCaptureInit();
  const gaps = [...(s.gaps ?? [])];
  const withSeq = [];
  let skippedNoSeq = 0;
  for (const entry of records ?? []) {
    const e = entry?.event ?? entry;
    const seq = Number(e?.seq);
    if (Number.isFinite(seq)) withSeq.push({ seq, entry });
    else skippedNoSeq += 1;
  }
  withSeq.sort((a, b) => a.seq - b.seq);
  const fresh = withSeq.filter((x) => s.maxSeq === null || x.seq > s.maxSeq);
  if (fresh.length > 0) {
    const minNew = fresh[0].seq;
    if (s.maxSeq === null) {
      if (minNew > 0) gaps.push({ afterSeq: null, fromSeq: minNew, missing: minNew }); // 宿主 seq 自 0 起(批2 实证)
    } else if (minNew > s.maxSeq + 1) {
      gaps.push({ afterSeq: s.maxSeq, fromSeq: minNew, missing: minNew - s.maxSeq - 1 });
    }
  }
  return {
    state: fresh.length > 0
      ? { maxSeq: fresh[fresh.length - 1].seq, captured: (s.captured ?? 0) + fresh.length, gaps }
      : { maxSeq: s.maxSeq, captured: s.captured ?? 0, gaps },
    records: fresh.map((x) => x.entry),
    skippedNoSeq,
  };
}

/**
 * R6-1:增量与终局快照合并(纯)——同 seq 以终局快照为准(同事件的更晚状态),
 * 输出按 seq 升序(保持 session/page 帧形状,compactHistory/trimEvents 零改动消费)。
 * incRecords=增量文件逐行 JSON 的原始帧;finalRecords=收口 session/page 的
 * records。返回 { records, stats } 供回执记账(inc/fin/unique/noSeq)。
 */
export function eventCaptureMerge(incRecords, finalRecords) {
  const bySeq = new Map();
  let inc = 0, fin = 0, noSeq = 0;
  for (const entry of incRecords ?? []) {
    const seq = Number((entry?.event ?? entry)?.seq);
    if (!Number.isFinite(seq)) { noSeq += 1; continue; }
    bySeq.set(seq, entry); inc += 1;
  }
  for (const entry of finalRecords ?? []) {
    const seq = Number((entry?.event ?? entry)?.seq);
    if (!Number.isFinite(seq)) { noSeq += 1; continue; }
    bySeq.set(seq, entry); fin += 1; // 终局覆盖同 seq 增量
  }
  const records = [...bySeq.entries()].sort((a, b) => a[0] - b[0]).map((kv) => kv[1]);
  return { records, stats: { incremental: inc, final: fin, unique: records.length, noSeq } };
}
