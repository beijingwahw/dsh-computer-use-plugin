// test/w2drive.test.ts
// R1-4(硬化驱动链路)回归:bench/driveCore.mjs 纯逻辑核心的重试决策/断点续跑/
// 超时分级/prompt 防重复/僵尸回收/journal 窗口/E2 调度序/停止裁决/观测面渲染。
// bench/ 是纯 Node .mjs 工作台;与 w2bench.test.ts 同策略 —— 非字面量动态 import
// 挂载(运行时由 Node ESM 原生解析,tsc 不做 .mjs 解析,typecheck 干净)。
// drive-hardened.mjs 只做 IO 编排(决策全部问 driveCore),此处不触网络/不启动 DSH。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const load = (p: string): Promise<any> => import(p);
const benchUrl = (f: string): string => new URL(`../bench/${f}`, import.meta.url).href;

const drive = await load(benchUrl('driveCore.mjs'));

// ─── 重试决策:瞬态/致命二分 + 指数退避 ───

test('R1-4 Ra: 错误分类 —— 网络层/5xx/429 瞬态,4xx/应用层拒绝致命', () => {
  const transient = [
    Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } }),
    Object.assign(new Error('HTTP 503 on session.list'), {}),
    Object.assign(new Error('HTTP 429 on session.prompt'), {}),
    new TypeError('fetch failed to fetch'),
    Object.assign(new Error('aborted'), { name: 'AbortError' }),
  ];
  for (const e of transient) assert.equal(drive.classifyRpcError(e).kind, 'transient', String(e.message));
  const fatal = [
    Object.assign(new Error('HTTP 404 on x'), {}),
    Object.assign(new Error('rpc session.create failed: {"ok":false}'), { rpcRejected: true }),
    new Error('whatever else'),
  ];
  for (const e of fatal) assert.equal(drive.classifyRpcError(e).kind, 'fatal', String(e.message));
  // 未知错误按致命(保守:不盲重试)
  assert.equal(drive.classifyRpcError(null).kind, 'fatal');
});

test('R1-4 Rb: retryDecision —— 瞬态退避重试(封顶+零抖动确定性),致命立即 abort,耗尽 abort', () => {
  const net = Object.assign(new Error('x'), { code: 'ECONNRESET' });
  const r1 = drive.retryDecision({ attempt: 1, error: net, baseDelayMs: 800, maxDelayMs: 15000 });
  assert.equal(r1.action, 'retry');
  assert.equal(r1.delayMs, 800); // 800·2^0 —— 缺省零抖动,确定性输出纪律
  const r2 = drive.retryDecision({ attempt: 2, error: net, baseDelayMs: 800, maxDelayMs: 15000 });
  assert.equal(r2.delayMs, 1600);
  const r6 = drive.retryDecision({ attempt: 6, error: net, maxAttempts: 10, baseDelayMs: 800, maxDelayMs: 15000 });
  assert.equal(r6.action, 'retry');
  assert.equal(r6.delayMs, 15000); // 指数退避封顶(800·2^5=25600 → 15000)
  // 抖动可注入(jitterFn),缺省为 0 —— 测试注入确定性函数
  assert.equal(drive.retryDecision({ attempt: 1, error: net, jitterFn: () => 137 }).delayMs, 937);
  // 致命:第一次失败也不重试
  const f = drive.retryDecision({ attempt: 1, error: Object.assign(new Error('HTTP 400'), {}) });
  assert.equal(f.action, 'abort');
  assert.equal(f.reason, 'http:400');
  // 瞬态耗尽:attempt 达 maxAttempts ⇒ abort(exhausted)
  const ex = drive.retryDecision({ attempt: 4, error: net, maxAttempts: 4 });
  assert.equal(ex.action, 'abort');
  assert.equal(ex.reason, 'exhausted');
  // backoffSchedule 与单点决策一致(前 3 次重试的退避序列)
  assert.deepEqual(drive.backoffSchedule({ retries: 3, baseDelayMs: 800, maxDelayMs: 15000 }), [800, 1600, 3200]);
});

// ─── 超时分级:任务级钳制 [5,10]min + 总量熔断 ───

test('R1-4 Ta: 任务级超时钳制到 [5min,10min] 域;suite 未声明用缺省 8min', () => {
  assert.equal(drive.clampTaskTimeout(480000), 480000); // 域内原样
  assert.equal(drive.clampTaskTimeout(60000), 300000);  // 1min ⇒ 钳到 5min 下限
  assert.equal(drive.clampTaskTimeout(7200000), 600000); // 2h ⇒ 钳到 10min 上限
  assert.equal(drive.clampTaskTimeout(undefined), 480000);
  assert.equal(drive.clampTaskTimeout('garbage'), 480000); // 非数 ⇒ 缺省
});

test('R1-4 Tb: 总量熔断 —— 剩余预算收窄任务超时;≤30s 视为耗尽;0 禁用', () => {
  // 预算充足:任务超时不被收窄
  const p1 = drive.timeoutPlan({ taskTimeoutMs: 480000, totalBudgetMs: 3600000, totalElapsedMs: 600000 });
  assert.equal(p1.effectiveTimeoutMs, 480000);
  assert.equal(p1.budgetExhausted, false);
  // 剩余 6min < 任务级 8min ⇒ 收窄到剩余(不开超预算的任务)
  const p2 = drive.timeoutPlan({ taskTimeoutMs: 480000, totalBudgetMs: 3600000, totalElapsedMs: 3600000 - 360000 });
  assert.equal(p2.effectiveTimeoutMs, 360000); // min(480000, 剩余 360000)
  assert.equal(p2.budgetExhausted, false);
  // 剩余 20s ≤ 30s 地板 ⇒ 熔断
  const p3 = drive.timeoutPlan({ taskTimeoutMs: 480000, totalBudgetMs: 3600000, totalElapsedMs: 3600000 - 20000 });
  assert.equal(p3.budgetExhausted, true);
  assert.equal(p3.effectiveTimeoutMs, 0);
  // totalBudgetMs=0 ⇒ 禁用熔断,任务级即生效超时
  const p4 = drive.timeoutPlan({ taskTimeoutMs: 480000, totalBudgetMs: 0, totalElapsedMs: 999999999 });
  assert.equal(p4.disabled, true);
  assert.equal(p4.budgetExhausted, false);
  assert.equal(p4.effectiveTimeoutMs, 480000);
  // startedAtMs/now 注入优先于 totalElapsedMs(时钟由调用方给,核心零时钟)
  const p5 = drive.timeoutPlan({ taskTimeoutMs: 480000, totalBudgetMs: 3600000, totalElapsedMs: 0, startedAtMs: 1000, now: 3200000 });
  assert.equal(p5.totalRemainingMs, 401000); // elapsed = now−startedAt = 3199000
  assert.equal(p5.effectiveTimeoutMs, 401000);
});

// ─── 断点续跑清单(崩溃后重入:已完成 id 跳过) ───

test('R1-4 Sa: planRun —— done 集 ✓ 跳过且保序;staleDoneIds 如实上报', () => {
  const tasks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const plan = drive.planRun(tasks, ['b', 'ghost']);
  assert.deepEqual(plan.run.map((t: any) => t.id), ['a', 'c']); // 保 suite 原序
  assert.deepEqual(plan.skipped.map((t: any) => t.id), ['b']);
  assert.deepEqual(plan.staleDoneIds, ['ghost']); // 状态文件有、suite 没有 —— 不瞎猜
  assert.equal(plan.doneCount, 1);
  assert.deepEqual(drive.planRun(tasks, []).run.map((t: any) => t.id), ['a', 'b', 'c']);
});

test('R1-4 Sb: loadResumeState —— 容忍缺席字段;形状不对 fail-fast', () => {
  assert.deepEqual(drive.loadResumeState(null), { runId: null, doneTaskIds: [], liveSessions: {} });
  assert.deepEqual(drive.loadResumeState({}), { runId: null, doneTaskIds: [], liveSessions: {} });
  const ok = drive.loadResumeState({ runId: 'r1', doneTaskIds: ['a'], liveSessions: { b: 's-2' } });
  assert.equal(ok.runId, 'r1');
  assert.deepEqual(ok.doneTaskIds, ['a']);
  assert.deepEqual(ok.liveSessions, { b: 's-2' });
  assert.throws(() => drive.loadResumeState([]), /须为对象/);
  assert.throws(() => drive.loadResumeState({ doneTaskIds: ['a', 42] }), /字符串数组/);
  assert.throws(() => drive.loadResumeState({ doneTaskIds: ['a'], liveSessions: { b: 7 } }), /字符串 sessionId/);
});

test('R1-4 Sc: commitTaskDone / registerLiveSession —— 纯合并,收口清活会话', () => {
  let st = { runId: 'r', doneTaskIds: [], liveSessions: {} };
  st = drive.registerLiveSession(st, 't1', 's-1');
  assert.deepEqual(st.liveSessions, { t1: 's-1' });
  st = drive.registerLiveSession(st, 't2', 's-2');
  st = drive.commitTaskDone(st, 't1'); // t1 收口 ⇒ 其活会话登记清除(不再是僵尸候选)
  assert.deepEqual(st.doneTaskIds, ['t1']);
  assert.deepEqual(st.liveSessions, { t2: 's-2' });
  st = drive.commitTaskDone(st, 't1'); // 幂等:重复收口不重复记账
  assert.deepEqual(st.doneTaskIds, ['t1']);
});

// ─── prompt 重发防重复(安全方向:读不到证据 ⇒ 不重发) ───

test('R1-4 Pa: shouldResendPrompt —— 三证齐才重发;历史不可读 ⇒ hold', () => {
  assert.deepEqual(
    drive.shouldResendPrompt({ historyAvailable: true, promptSeen: false, running: false }),
    { resend: true, mode: 'resend', reason: drive.shouldResendPrompt({ historyAvailable: true, promptSeen: false, running: false }).reason },
  );
  const hold = drive.shouldResendPrompt({ historyAvailable: false, promptSeen: false, running: false });
  assert.equal(hold.resend, false); // 桌面任务重复执行最贵 —— 不确定时不重发
  assert.equal(hold.mode, 'hold-uncertain');
  assert.equal(drive.shouldResendPrompt({ historyAvailable: true, promptSeen: true, running: false }).resend, false);
  assert.equal(drive.shouldResendPrompt({ historyAvailable: true, promptSeen: false, running: true }).resend, false);
});

test('R1-4 Pb: promptSeenInHistory —— user/message 前缀匹配(80 字符指纹)', () => {
  const hist = { events: [
    { event: { type: 'user/message', seq: 1, data: { content: [{ text: '记事本存证任务:1) win+r 输入 notepad 回车打开记事本;2) 后面还有很多步' }] } } },
    { event: { type: 'assistant/message', seq: 2, data: { content: [{ text: '好的' }] } } },
  ] };
  assert.equal(drive.promptSeenInHistory(hist, '记事本存证任务:1) win+r 输入 notepad 回车打开记事本;2) 后面还有很多步'), true);
  assert.equal(drive.promptSeenInHistory(hist, '完全不同的任务'), false);
  assert.equal(drive.promptSeenInHistory({ events: [] }, 'x'), false);
  assert.equal(drive.promptSeenInHistory(hist, ''), false); // 空指纹不匹配(防误报)
});

// ─── 僵尸会话回收(所有权纪律:只回收自己的) ───

test('R1-4 Za: findZombieSessions —— own+running+非活跃 ⇒ 僵尸;NOT_OURS 一律不动', () => {
  const items = [
    { sessionId: 's-own-old', running: true },   // 本驱动的残留 ⇒ 僵尸
    { sessionId: 's-active', running: true },    // 当前活跃 ⇒ 在干活,不是僵尸
    { sessionId: 's-own-done', running: false }, // 本驱动但已终局 ⇒ 无须回收
    { sessionId: 's-foreign', running: true },   // 别人的真实桌面会话 ⇒ 不动(越权)
  ];
  const z = drive.findZombieSessions(items, { ownSessionIds: ['s-own-old', 's-own-done', 's-active'], activeSessionId: 's-active' });
  assert.deepEqual(z.zombies, ['s-own-old']);
  assert.deepEqual(z.notOurs, ['s-foreign']); // 如实列出不回收的外来会话(观测,不动作)
  assert.deepEqual(drive.findZombieSessions([], {}), { zombies: [], notOurs: [], policy: z.policy });
  const none = drive.findZombieSessions(items, { ownSessionIds: [], activeSessionId: null });
  assert.deepEqual(none.zombies, []); // 无所有权记录 ⇒ 无权回收任何会话
});

// ─── journal 时间窗过滤(证据采集对坏行诚实计数) ───

test('R1-4 Ja: journalWindow —— [t0,t1] 闭窗切片;坏行/空行 dropped 计数', () => {
  const lines = [
    JSON.stringify({ ts: 100, tool: 'a' }),
    '',
    'not json at all',
    JSON.stringify({ ts: 200, tool: 'b' }),
    JSON.stringify({ ts: 300, tool: 'c' }),
    JSON.stringify({ noTs: true }),
    '   ',
  ];
  const w = drive.journalWindow(lines, { t0Ms: 100, t1Ms: 200 });
  assert.equal(w.kept.length, 2);
  assert.equal(JSON.parse(w.kept[0]).tool, 'a');
  assert.equal(JSON.parse(w.kept[1]).tool, 'b');
  assert.equal(w.dropped, 4); // 空行×2 + 坏 JSON + 无 ts(窗口外合法行不计 dropped)
  assert.deepEqual(w.window, { t0Ms: 100, t1Ms: 200 });
  assert.deepEqual(drive.journalWindow([], { t0Ms: 0, t1Ms: 1 }).kept, []);
});

// ─── E2 调度序(采集/核查全部后置于会话终局) ───

test('R1-4 Ea: planPostTask —— 固定序:证据 → e2(仅有 verify 块)→ 回执 → 状态', () => {
  const withV = drive.planPostTask({ id: 'x', verify: { checks: [{ kind: 'dirExists', path: 'C:\\x' }] } });
  assert.equal(withV.hasE2, true);
  const idx = (s: string) => withV.steps.indexOf(s);
  // 采集先于核查(世界状态定格后先存证),核查先于回执/状态面
  assert.ok(idx('history-export') < idx('evidence:hist'));
  assert.ok(idx('evidence:hist') < idx('evidence:events'));
  assert.ok(idx('evidence:events') < idx('evidence:journal'));
  assert.ok(idx('evidence:journal') < idx('e2:verify'));
  assert.ok(idx('e2:verify') < idx('receipt'));
  assert.ok(idx('receipt') < idx('status'));
  // 无 verify 块 ⇒ 不调度 e2(不造核查),回执如实记 absent
  const bare = drive.planPostTask({ id: 'y' });
  assert.equal(bare.hasE2, false);
  assert.ok(!bare.steps.includes('e2:verify'));
  assert.ok(bare.steps.includes('receipt')); // 证据与回执照常
});

// ─── 停止裁决(kill-switch 优先级) ───

test('R1-4 Ka: stopDecision —— sigint > stopfile > 总量熔断;全无 ⇒ null', () => {
  assert.equal(drive.stopDecision(), null);
  assert.equal(drive.stopDecision({ stopfileExists: true }).reason, 'stopfile');
  assert.equal(drive.stopDecision({ stopfileExists: true }).exitCode, 3);
  assert.equal(drive.stopDecision({ interrupted: true, stopfileExists: true }).reason, 'sigint'); // 优先级
  assert.equal(drive.stopDecision({ interrupted: true }).exitCode, 130);
  assert.equal(drive.stopDecision({ budgetExhausted: true }).reason, 'total-budget');
  assert.equal(drive.stopDecision({ budgetExhausted: true }).exitCode, 0);
  assert.equal(drive.stopDecision({ stopfileExists: false, interrupted: false, budgetExhausted: false }), null);
});

// ─── 观测面:单行状态 + 汇总 JSON(确定性渲染) ───

test('R1-4 Oa: renderStatusLine —— 单行仪表含进度/当前任务/失败清单;同态同串(确定性)', () => {
  const state = {
    runId: 'drive-1', suiteName: 'suite-4', total: 26, done: 10, state: 'RUNNING',
    currentTask: 'open-calc', elapsedMs: 12 * 60000 + 34000,
    pass: 7, fail: 2, unknown: 1, skip: 3, failures: ['t-a', 't-b'], stopfileExists: false,
  };
  const line = drive.renderStatusLine(state);
  assert.equal(line, 'run=drive-1 suite=suite-4 tasks=10/26 state=RUNNING task=open-calc elapsed=00:12:34 pass=7 fail=2 unknown=1 skip=3 fails=[t-a,t-b] stopfile=no');
  assert.equal(drive.renderStatusLine(state), line); // 纯函数:同态同串
  assert.ok(drive.renderStatusLine({ ...state, stopfileExists: true }).endsWith('stopfile=yes'));
  assert.equal(drive.fmtDur(0), '00:00:00');
  assert.equal(drive.fmtDur(3723005), '01:02:03');
});

test('R1-4 Ob: buildRunSummary —— totals 与明细同源一致,失败清单/停止原因显性', () => {
  const s = drive.buildRunSummary({
    runId: 'r', suiteFile: 's.json', suiteName: 's', model: { provider: 'p', model: 'm' },
    startedAtIso: '2026-10-05T00:00:00Z', updatedAtIso: '2026-10-05T01:00:00Z', elapsedMs: 3600000,
    taskRecords: [
      { id: 'a', pass: true },
      { id: 'b', pass: false },
      { id: 'c', pass: undefined },
      { id: 'd', pass: true, timedOut: true, harnessError: 'x' },
    ],
    skippedIds: ['z'], liveSession: 's-1', stoppedBy: 'stopfile',
    rpcSummary: { retries: 3 },
  });
  assert.equal(s.schema, 'dsh-drive-hardened/1');
  assert.deepEqual(s.totals, { total: 4, done: 4, pass: 2, fail: 1, unknown: 1, timedOut: 1, harnessErrors: 1 });
  assert.deepEqual(s.failures, ['b']);
  assert.deepEqual(s.skippedIds, ['z']);
  assert.equal(s.liveSession, 's-1');
  assert.equal(s.stoppedBy, 'stopfile');
  assert.equal(s.tasks.length, 4);
  // 空跑:零除不炸,totals 全 0
  const empty = drive.buildRunSummary({ taskRecords: [] });
  assert.deepEqual(empty.totals, { total: 0, done: 0, pass: 0, fail: 0, unknown: 0, timedOut: 0, harnessErrors: 0 });
  assert.deepEqual(empty.failures, []);
});
