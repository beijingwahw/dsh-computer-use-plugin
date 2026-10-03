// test/w3dag.test.ts
// W3-4 执法册：G2 DAG 就绪层预取流水线 + takeGranted 续跑接线。
// 覆盖（全离线确定性：注入假 chat/假 actor/计数互斥/序列观察面/录制团队）：
//   ①  纯函数 —— layerSubTasks（Kahn 就绪层切分/未知边剔除/空输入）与
//      reconcileResumeWindow（no-cursor / empty-ledger / cursor-ahead /
//      replay-window 全分支）；
//   ②  subAgent 增量 —— preseed（有效/空指纹/退场者/幽灵代理）与 retire
//      （退场可回收/在役不可回收/幂等/容量释放）；
//   ③  缺省兼容 —— 无 opts 时报告与旧串行逐字节一致，零团队活动；
//   ④  就绪层并行调度 —— Kahn 层映射 subAgent 团队（spawn 守限 3、claim/post
//      黑板协议、report 退场、retire 容量回收），报告契约行序与串行同构；
//   ⑤  写互斥纪律 —— 计数互斥通道断言并发写为零（峰值在飞写恒 ≤1）、
//      每个写必经通道；
//   ⑥  seed 预注传递 —— 写在飞窗口内的观察重叠拍（下一 pending 代理在写
//      落地前已被预注）+ 写后新屏的权威确注拍（覆盖投机预注）；
//   ⑦  深度退化 —— pipelineDepth=1 ⇒ 零预注纯串行写；
//   ⑧  预算退化 —— timeBudgetMs 耗尽 ⇒ 串行同款 [TIMEOUT] 文案 + 跳过计数
//      + 团队不漏代理（finally 兜底回收）；
//   ⑨  takeGranted 对账续跑 —— 重演窗口正确（cursor 后步骤恰量重演、顺序 =
//      已批动作 → 重演 → 全量计划）、[Resume] 审计行；
//   ⑩  无 journal 保守路径 —— 无 cursor / 空账面 ⇒ 保守全量重规划（零重放，
//      全量计划照跑 = 现状语义）；cursor 越界 ⇒ cursor-ahead 防御；
//   ⑪  黑板防重复 —— 同层语义同构任务撞租约 ⇒ 让位分波，两任务先后完成；
//   ⑫  容量分波 —— 4 独立任务守限 3 ⇒ 两波（3+1）全量完成；
//   ⑬  并行失败退化 —— 波次失败 ⇒ Σ-4 同律自愈，余部由串行脊梁接管；
//   ⑭  autonomousRun 续跑 —— runPilotLoop 重入经注入通道消费 takeGranted，
//      对账结果随行，队列恰一次消费。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  runOrchestrator, layerSubTasks, reconcileResumeWindow,
  type RunOrchestratorOptions, type PipelineTeam, type ActorFn,
} from '../src/orchestrator.ts';
import type { ChatFn, SubTask } from '../src/planner.ts';
import { coordinator } from '../src/subAgent.ts';
import { approvalQueue, resetApproval } from '../src/approval.ts';
import { journal } from '../src/journal.ts';
import type { Config } from '../src/config.ts';
import { system } from '../src/system.ts';
import { resetGlmClient } from '../src/vlm/index.ts';
import { createAutonomousRunTool, type AutonomousRunDeps } from '../src/tools/autonomousRun.ts';
import { default as sharp } from 'sharp';

// ─── 测试基建（隔离 + 假件工坊） ───

beforeEach(() => {
  coordinator.reset();
  journal.reset();
  resetApproval();
});

function chatOf(plan: unknown): ChatFn {
  return async () => JSON.stringify(plan);
}

/** 首调返 first、二调（Σ-4 重规划）返 second 的假 chat */
function chatWithReplan(first: unknown, second: unknown): ChatFn {
  let n = 0;
  return async () => { n++; return JSON.stringify(n === 1 ? first : second); };
}

interface TeamLog {
  spawns: string[][];
  claims: Array<{ id: string; subject: string; ok: boolean; reason?: string }>;
  posts: Array<[string, string]>;
  reports: string[];
  aborts: string[];
  retires: string[];
  preseeds: Array<[string, string]>;
}

function teamLog(): TeamLog {
  return { spawns: [], claims: [], posts: [], reports: [], aborts: [], retires: [], preseeds: [] };
}

/** 录制团队：包裹真 coordinator（协议保真），调用序全记账（断言事实源） */
function recordingTeam(log: TeamLog): PipelineTeam {
  return {
    spawn: specs => { const acc = coordinator.spawn(specs); log.spawns.push(acc.map(a => a.spec.id)); return acc; },
    claim: (id, subject, ttl) => {
      const r = coordinator.claim(id, subject, ttl);
      log.claims.push({ id, subject, ok: r.ok, ...(r.ok ? {} : { reason: (r as { reason?: string }).reason }) });
      return r;
    },
    post: (id, subject, finding, ttl) => { log.posts.push([id, subject]); return coordinator.post(id, subject, finding, ttl); },
    report: (id, findings, confidence, status) => { log.reports.push(id); return coordinator.report(id, findings, confidence, status); },
    abort: (id, reason) => { log.aborts.push(id); coordinator.abort(id, reason); },
    isActive: () => coordinator.isActive(),
    preseed: (id, hash) => { log.preseeds.push([id, String(hash)]); return coordinator.preseed(id, hash); },
    retire: (...ids) => { log.retires.push(...ids); return coordinator.retire(...ids); },
  };
}

/** 菱形 DAG：root → {left, right} → sink（三就绪层，中间层可并行） */
const DIAMOND: SubTask[] = [
  { id: 1, action: 'open-browser', deps: [] },
  { id: 2, action: 'alpha-x', deps: [1] },
  { id: 3, action: 'beta-y', deps: [1] },
  { id: 4, action: 'merge-result', deps: [2, 3] },
];

function okActor(calls: string[], delayMs = 0): ActorFn {
  return async (task: string) => {
    calls.push(task);
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    return `[SUCCESS] ok:${task}`;
  };
}

// ─── ① 纯函数：layerSubTasks / reconcileResumeWindow ───

test('W3-4①a: layerSubTasks —— Kahn 就绪层切分（菱形三层/未知边剔除/空输入）', () => {
  assert.deepEqual(layerSubTasks(DIAMOND).map(l => l.map(t => t.id)), [[1], [2, 3], [4]],
    '菱形：root 单员层 → {left,right} 并行层 → sink 单员层；层内保持拓扑序');
  const ghost: SubTask[] = [{ id: 1, action: 'a', deps: [99] }];
  assert.deepEqual(layerSubTasks(ghost).map(l => l.map(t => t.id)), [[1]], '幻觉 dep 边剔除（planner 同律防御）');
  assert.deepEqual(layerSubTasks([]), [], '空输入 ⇒ 空层集');
  const chain: SubTask[] = [
    { id: 1, action: 'a', deps: [] },
    { id: 2, action: 'b', deps: [1] },
    { id: 3, action: 'c', deps: [2] },
  ];
  assert.deepEqual(layerSubTasks(chain).map(l => l.map(t => t.id)), [[1], [2], [3]], '链式 ⇒ 全单员层（无并行批）');
});

test('W3-4①b: reconcileResumeWindow —— 对账全分支（防御式纯函数）', () => {
  assert.deepEqual(reconcileResumeWindow(undefined, 5), { mode: 'full-replan', reason: 'no-cursor' });
  assert.deepEqual(reconcileResumeWindow(-1, 5), { mode: 'full-replan', reason: 'no-cursor' });
  assert.deepEqual(reconcileResumeWindow(Number.NaN, 5), { mode: 'full-replan', reason: 'no-cursor' });
  assert.deepEqual(reconcileResumeWindow('2' as unknown, 5), { mode: 'full-replan', reason: 'no-cursor' }, '非数字 ⇒ 无步账');
  assert.deepEqual(reconcileResumeWindow(2, 0), { mode: 'full-replan', reason: 'empty-ledger' }, '无 journal ⇒ 保守全量');
  assert.deepEqual(reconcileResumeWindow(9, 5), { mode: 'full-replan', reason: 'cursor-ahead' }, 'cursor 越界（账已轮转）⇒ 保守');
  assert.deepEqual(reconcileResumeWindow(2, 5), { mode: 'replay-window', cursor: 2, windowSize: 3 }, '窗口 = 账面 − cursor');
  assert.deepEqual(reconcileResumeWindow(5, 5), { mode: 'replay-window', cursor: 5, windowSize: 0 }, '干净续跑点 ⇒ 空窗口');
});

// ─── ② subAgent 增量：preseed / retire ───

test('W3-4②: preseed seed 预注与 retire 退场回收的执法面', () => {
  const spawned = coordinator.spawn([{ id: 's1', role: 'r', objective: 'o', maxSteps: 2 }]);
  assert.equal(spawned.length, 1);
  assert.equal(coordinator.preseed('s1', 'hash-alpha'), true, '在役代理可预注');
  assert.equal(coordinator.preseed('s1', ''), false, '空指纹不预注（不猜）');
  assert.equal(coordinator.preseed('s1', null), false, 'null 指纹不预注');
  assert.equal(coordinator.preseed('ghost', 'h'), false, '幽灵代理拒绝');
  assert.equal(coordinator.roster()[0]!.focus.seedSceneHash, 'hash-alpha', '预注落点 = focus.seedSceneHash');
  coordinator.report('s1', 'done', 0.9);
  assert.equal(coordinator.preseed('s1', 'hash-beta'), false, '退场代理不可预注');
  assert.equal(coordinator.retire('s1'), 1, 'reported 代理可回收（容量释放）');
  assert.equal(coordinator.retire('s1'), 0, '回收幂等');
  assert.equal(coordinator.roster().length, 0);
  const more = coordinator.spawn([{ id: 's2', role: 'r', objective: 'o', maxSteps: 2 }]);
  assert.equal(more.length, 1, '回收后容量可用于新代理');
  assert.equal(coordinator.retire('s2'), 0, 'pending 在役代理不可回收');
});

// ─── ③ 缺省兼容：无 opts ⇒ 旧串行逐字节一致 ───

test('W3-4③: 缺省兼容 —— parallel 缺席 ⇒ 报告与团队面与旧串行逐字节一致', async () => {
  const plan: SubTask[] = [
    { id: 1, action: 'ind-a', deps: [] },
    { id: 2, action: 'ind-b', deps: [] },
    { id: 3, action: 'tail', deps: [1, 2] },
  ];
  const calls: string[] = [];
  const report = await runOrchestrator('w3-default-compat', okActor(calls), chatOf(plan));
  assert.deepEqual(calls, ['ind-a', 'ind-b', 'tail'], '拓扑序全执行');
  assert.equal(report,
    'Task #1 (ind-a): [SUCCESS] ok:ind-a\nTask #2 (ind-b): [SUCCESS] ok:ind-b\nTask #3 (tail): [SUCCESS] ok:tail',
    '报告契约逐字节一致（join 行序）');
  assert.equal(coordinator.roster().length, 0, '缺省路径零团队活动');
  assert.ok(journal.list(false).every(e => e.tool !== 'AGENT_BEGIN'), '缺省路径零代理标记');
});

// ─── ④ 就绪层并行调度 ───

test('W3-4④: 就绪层并行 —— Kahn 层映射 subAgent 团队（spawn/claim/post/report/retire），报告与串行同构', async () => {
  const log = teamLog();
  const calls: string[] = [];
  const report = await runOrchestrator('w3-parallel', okActor(calls), chatOf(DIAMOND), undefined, {
    parallel: true,
    team: recordingTeam(log),
    observeSeed: () => null,
  });
  assert.deepEqual(calls, ['open-browser', 'alpha-x', 'beta-y', 'merge-result'], '执行序 = 拓扑序');
  assert.equal(report,
    'Task #1 (open-browser): [SUCCESS] ok:open-browser\n' +
    'Task #2 (alpha-x): [SUCCESS] ok:alpha-x\n' +
    'Task #3 (beta-y): [SUCCESS] ok:beta-y\n' +
    'Task #4 (merge-result): [SUCCESS] ok:merge-result',
    '报告契约与串行逐字节同构');
  assert.deepEqual(log.spawns, [['w3-2', 'w3-3']], '唯一多员层恰一波 spawn（守限 3 内全收）');
  assert.deepEqual(log.claims.map(c => [c.id, c.subject, c.ok]), [['w3-2', 'alpha-x', true], ['w3-3', 'beta-y', true]],
    '黑板 claim 防重复协议在位（互异主题各持租约）');
  assert.deepEqual(log.reports, ['w3-2', 'w3-3'], '代理 report 退场');
  assert.equal(log.posts.length, 2, '成功发现共享上黑板（post）');
  assert.equal(coordinator.roster().length, 0, '波次代理全部 retire 回收（不占坑）');
  assert.equal(coordinator.blackboard().length, 2, '黑板留有两条 finding（共享知识）');
});

// ─── ⑤ 写互斥纪律：并发写为零 ───

test('W3-4⑤: 写互斥纪律 —— 计数互斥通道断言并发写为零，每个写必经通道', async () => {
  const plan: SubTask[] = [
    { id: 1, action: 'cap-a', deps: [] },
    { id: 2, action: 'cap-b', deps: [] },
    { id: 3, action: 'cap-c', deps: [] },
    { id: 4, action: 'cap-d', deps: [] },
    { id: 5, action: 'cap-tail', deps: [1, 2, 3, 4] },
  ];
  let inFlight = 0;
  let peak = 0;
  let writes = 0;
  const serializeWrite = async <T>(fn: () => Promise<T>): Promise<T> => {
    writes++;
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      return await fn();
    } finally {
      inFlight--;
    }
  };
  const calls: string[] = [];
  const report = await runOrchestrator('w3-mutex', okActor(calls, 5), chatOf(plan), undefined, {
    parallel: true,
    serializeWrite,
    observeSeed: () => null,
    team: recordingTeam(teamLog()),
  });
  assert.equal(calls.length, 5, '全量执行');
  assert.equal(writes, 5, '每个写（含单员层）都必经互斥通道');
  assert.equal(peak, 1, `并发写为零（峰值在飞写 = ${peak}，断言 ≤1）`);
  assert.ok(!report.includes('[FAILED]'), '零失败');
});

// ─── ⑥ seed 预注传递 + 观察重叠 ───

test('W3-4⑥: seed 预注 —— 写在飞窗口内的观察重叠拍 + 动作后新屏的权威确注拍', async () => {
  const log = teamLog();
  const seedQueue = ['ov-during-A', 'post-A', 'post-B'];
  const observeSeed = (): string | null => seedQueue.shift() ?? null;
  const events: string[] = [];
  let releaseA!: () => void;
  const gateA = new Promise<void>(r => { releaseA = r; });
  const actor: ActorFn = async (task: string) => {
    events.push(`start:${task}`);
    if (task === 'alpha-x') await gateA; // 首个波次写挂起 —— 重叠窗口的取证钩
    events.push(`end:${task}`);
    return `[SUCCESS] ok:${task}`;
  };
  const runP = runOrchestrator('w3-seed', actor, chatOf(DIAMOND), undefined, {
    parallel: true,
    team: recordingTeam(log),
    observeSeed,
  });
  // 一个 macrotask 后：写 A 仍在飞，但下一 pending 代理（w3-3）已被只读预注 —— 观察重叠兑现
  await new Promise(r => setImmediate(r));
  assert.ok(events.includes('start:alpha-x') && !events.includes('end:alpha-x'), '写 A 仍在飞（门未开）');
  assert.deepEqual(log.preseeds, [['w3-3', 'ov-during-A']],
    '写在飞窗口内，协调器只读观察并预注下一 pending 代理（重叠拍）');
  releaseA();
  const report = await runP;
  assert.ok(report.includes('Task #3 (beta-y)'), '全量完成');
  assert.deepEqual(log.preseeds, [['w3-3', 'ov-during-A'], ['w3-3', 'post-A']],
    '写 A 落地后的新屏（post-A）在下一写派发前覆盖投机预注（权威确注拍）');
  assert.ok(!log.preseeds.some(([id]) => id === 'w3-2'), '波次首代理无预注（无在先动作后的新屏）');
});

// ─── ⑦ 深度退化 ───

test('W3-4⑦: 深度退化 —— pipelineDepth=1 ⇒ 零预注（纯串行写），执行面不变', async () => {
  const log = teamLog();
  const observeCalls: string[] = [];
  const calls: string[] = [];
  const report = await runOrchestrator('w3-depth1', okActor(calls), chatOf(DIAMOND), undefined, {
    parallel: true,
    pipelineDepth: 1,
    team: recordingTeam(log),
    observeSeed: () => { observeCalls.push('obs'); return 'h'; },
  });
  assert.equal(log.preseeds.length, 0, 'depth=1 ⇒ 零预注（流水线退化）');
  assert.equal(observeCalls.length, 0, '深度 1 不做重叠观察（零读开销）');
  assert.deepEqual(calls, ['open-browser', 'alpha-x', 'beta-y', 'merge-result'], '执行面与深度无关');
  assert.ok(!report.includes('[FAILED]'));
});

// ─── ⑧ 预算退化 ───

test('W3-4⑧: 预算退化 —— timeBudgetMs 耗尽 ⇒ 串行同款 [TIMEOUT] 收场 + 团队零泄漏', async () => {
  const plan: SubTask[] = [
    { id: 1, action: 'b-first', deps: [] },
    { id: 2, action: 'b-second', deps: [] },
    { id: 3, action: 'b-tail', deps: [1, 2] },
  ];
  const calls: string[] = [];
  const report = await runOrchestrator('w3-budget', okActor(calls, 40), chatOf(plan), 25, {
    parallel: true,
    observeSeed: () => null,
    team: recordingTeam(teamLog()),
  });
  assert.deepEqual(calls, ['b-first'], '首写落地后预算熔断 —— 余部不再派发');
  assert.ok(report.includes('Task #1 (b-first): [SUCCESS] ok:b-first'), '已落地部分留痕');
  assert.ok(report.includes('[TIMEOUT] Time budget of 0s exhausted after 0s. 2 task(s) skipped.'),
    '串行同款 [TIMEOUT] 文案 + 跳过计数（现状语义）');
  assert.ok(!report.includes('b-tail'), '未派发者零执行');
  assert.equal(coordinator.roster().length, 0, '熔断路径代理全部回收（finally 兜底）');
});

// ─── ⑨ takeGranted 对账续跑：重演窗口正确 ───

test('W3-4⑨: takeGranted 续跑 —— 已批动作先行、cursor 后步骤恰量重演、全量计划随后', async () => {
  const events: string[] = [];
  const replayCalls: Array<[string, Record<string, unknown>]> = [];
  const actor: ActorFn = async (task: string) => {
    events.push(`actor:${task}`);
    return '[SUCCESS] ok';
  };
  const plan: SubTask[] = [
    { id: 1, action: 'p-one', deps: [] },
    { id: 2, action: 'p-two', deps: [1] },
  ];
  let sliceFrom = -1;
  const opts: RunOrchestratorOptions = {
    takeGranted: () => ({
      entry: { id: 'QA-1', description: 'click 发送 to submit', stepCursor: 2 },
      executionToken: 'APR-RESUME-1',
    }),
    ledgerCount: () => 5,
    ledgerSlice: (from: number) => {
      sliceFrom = from;
      return [
        { tool: 'click_mouse', args: { x: 1 } },
        { tool: 'type_text', args: { text: 're' } },
        { tool: 'scroll_page', args: { direction: 'down' } },
      ];
    },
    replayStep: async (tool, args) => {
      replayCalls.push([tool, args]);
      events.push(`replay:${tool}`);
      return 'replayed';
    },
  };
  const report = await runOrchestrator('w3-resume', actor, chatOf(plan), undefined, opts);
  assert.equal(sliceFrom, 2, '重演窗口从 stepCursor 起（其前步骤 = 已暂存的可逆部分，不重演）');
  assert.deepEqual(events, [
    'actor:执行已批准动作：click 发送 to submit（审批执行令牌 APR-RESUME-1 已授予，验收通过即焚毁）',
    'replay:click_mouse',
    'replay:type_text',
    'replay:scroll_page',
    'actor:p-one',
    'actor:p-two',
  ], '顺序铁律：已批动作 → 重演窗口（恰 3 步）→ 全量计划');
  assert.deepEqual(replayCalls, [
    ['click_mouse', { x: 1 }],
    ['type_text', { text: 're' }],
    ['scroll_page', { direction: 'down' }],
  ], '重放通道收到 cursor 后的全部步骤');
  assert.ok(report.includes('[Resume] 已批队列条目 QA-1 续跑接入（对账：replay-window，cursor=2，账面=5，重演窗口 3 步）'),
    '[Resume] 审计行（对账事实）');
  assert.ok(report.includes('Task #3 (执行已批准动作：click 发送 to submit): [SUCCESS] ok'),
    '已批动作以续跑子任务入账（id 从既有最大 2 续编为 3）');
  assert.ok(report.includes('[Resume] replay click_mouse: replayed'), '重演行留痕');
  assert.ok(report.includes('Task #1 (p-one): [SUCCESS] ok') && report.includes('Task #2 (p-two): [SUCCESS] ok'),
    '全量计划随后执行');
});

// ─── ⑩ 无 journal 保守路径 + cursor 越界防御 ───

test('W3-4⑩a: 无步账（无 cursor）⇒ 保守全量重规划：零重放、全量计划照跑、已批动作仍被执行', async () => {
  const events: string[] = [];
  let replayed = 0;
  const plan: SubTask[] = [{ id: 1, action: 'c-one', deps: [] }];
  const report = await runOrchestrator('w3-noledger-a', async t => { events.push(t); return '[SUCCESS] ok'; }, chatOf(plan), undefined, {
    takeGranted: () => ({ entry: { id: 'QA-2', description: '删除记录' }, executionToken: 'APR-R2' }),
    ledgerCount: () => 0,
    replayStep: async () => { replayed++; return 'x'; },
  });
  assert.equal(replayed, 0, '保守路径零重放');
  assert.deepEqual(events, ['执行已批准动作：删除记录（审批执行令牌 APR-R2 已授予，验收通过即焚毁）', 'c-one'],
    '用户同意不可白烧：已批动作仍执行；计划全量重跑 = 现状语义');
  assert.ok(report.includes('保守全量重规划）') && report.includes('成因 no-cursor'), '审计行说明降级成因');
});

test('W3-4⑩b: 空账面（有 cursor 无 journal）⇒ empty-ledger 保守路径', async () => {
  let replayed = 0;
  const calls: string[] = [];
  const plan: SubTask[] = [{ id: 1, action: 'd-one', deps: [] }];
  const report = await runOrchestrator('w3-noledger-b', okActor(calls), chatOf(plan), undefined, {
    takeGranted: () => ({ entry: { id: 'QA-3', description: '发送日报', stepCursor: 2 }, executionToken: 'APR-R3' }),
    ledgerCount: () => 0,
    replayStep: async () => { replayed++; return 'x'; },
  });
  assert.equal(replayed, 0);
  assert.ok(report.includes('成因 empty-ledger'), '空账面 ⇒ 保守全量（无 journal 不猜）');
  assert.equal(calls.length, 2, '已批动作 + 全量计划');
});

test('W3-4⑩c: cursor 越界（账已轮转/换会话）⇒ cursor-ahead 防御，零重放', async () => {
  let replayed = 0;
  const calls: string[] = [];
  const plan: SubTask[] = [{ id: 1, action: 'e-one', deps: [] }];
  const report = await runOrchestrator('w3-cursor-ahead', okActor(calls), chatOf(plan), undefined, {
    takeGranted: () => ({ entry: { id: 'QA-4', description: '支付订单', stepCursor: 9 }, executionToken: 'APR-R4' }),
    ledgerCount: () => 5,
    replayStep: async () => { replayed++; return 'x'; },
  });
  assert.equal(replayed, 0, '越界 cursor 的窗口不可信 ⇒ 零重放');
  assert.ok(report.includes('成因 cursor-ahead'), '审计行说明越界防御');
  assert.equal(calls.length, 2);
});

// ─── ⑪ 黑板防重复：撞租约让位分波 ───

test('W3-4⑪: 黑板防重复 —— 同层语义同构任务撞租约 ⇒ 让位分波，两任务先后完成', async () => {
  const plan: SubTask[] = [
    { id: 1, action: 'setup-stage', deps: [] },
    { id: 2, action: 'dup-item', deps: [1] },
    { id: 3, action: 'dup-item', deps: [1] },
  ];
  const log = teamLog();
  const calls: string[] = [];
  const report = await runOrchestrator('w3-dedup', okActor(calls), chatOf(plan), undefined, {
    parallel: true,
    team: recordingTeam(log),
    observeSeed: () => null,
  });
  assert.deepEqual(calls, ['setup-stage', 'dup-item', 'dup-item'], '让位不丢弃：两任务先后完成（顺序无重复并发）');
  assert.deepEqual(log.spawns, [['w3-2', 'w3-3'], ['w3-3']], '撞租约者让位到第二波（容量已回收）');
  const conflict = log.claims.find(c => c.id === 'w3-3' && !c.ok);
  assert.ok(conflict && conflict.reason === 'lease-conflict', 'W2-4 租约冲突被观测（防重复执法）');
  assert.equal(coordinator.roster().length, 0, '两波代理全部回收');
  assert.ok(report.includes('Task #2 (dup-item): [SUCCESS] ok:dup-item\nTask #3 (dup-item): [SUCCESS] ok:dup-item'),
    '报告契约完整');
});

// ─── ⑫ 容量分波：守限 3 ───

test('W3-4⑫: 容量分波 —— 4 独立任务守限 3 ⇒ 两波（3+1）全量完成', async () => {
  const plan: SubTask[] = [
    { id: 1, action: 'wave-a', deps: [] },
    { id: 2, action: 'wave-b', deps: [] },
    { id: 3, action: 'wave-c', deps: [] },
    { id: 4, action: 'wave-d', deps: [] },
  ];
  const log = teamLog();
  const calls: string[] = [];
  const report = await runOrchestrator('w3-capacity', okActor(calls), chatOf(plan), undefined, {
    parallel: true,
    team: recordingTeam(log),
    observeSeed: () => null,
  });
  assert.deepEqual(log.spawns, [['w3-1', 'w3-2', 'w3-3'], ['w3-4']], 'spawn 守限 3：超额者第二波（retire 已释放容量）');
  assert.deepEqual(calls, ['wave-a', 'wave-b', 'wave-c', 'wave-d'], '全量完成（拓扑序）');
  assert.equal(coordinator.roster().length, 0);
  assert.ok(!report.includes('[FAILED]'));
});

// ─── ⑬ 并行失败退化：Σ-4 同律自愈，余部串行脊梁接管 ───

test('W3-4⑬: 并行失败退化 —— 波次失败 ⇒ Σ-4 同律重规划接管，新计划由串行脊梁执行', async () => {
  const replan: SubTask[] = [
    { id: 1, action: 'fix-one', deps: [] },
    { id: 2, action: 'fix-two', deps: [1] },
  ];
  const calls: string[] = [];
  let failOnce = true;
  const actor: ActorFn = async (task: string) => {
    calls.push(task);
    if (task === 'alpha-x' && failOnce) {
      failOnce = false;
      return '[FAILED] popup blocked';
    }
    return `[SUCCESS] ok:${task}`;
  };
  const report = await runOrchestrator('w3-pfail', actor, chatWithReplan(DIAMOND, replan), undefined, {
    parallel: true,
    observeSeed: () => null,
    team: recordingTeam(teamLog()),
  });
  assert.deepEqual(calls, ['open-browser', 'alpha-x', 'fix-one', 'fix-two'],
    '失败波停止派发（beta-y 未执行）；新计划由串行脊梁执行');
  assert.ok(report.includes('[RECOVERED] popup blocked'), '失败轨迹改写 [RECOVERED]（Σ-4 同律）');
  assert.ok(report.includes('[Replan] 子任务失败，已重规划（剩余 2 步）'), '[Replan] 审计行（Σ-4 同律）');
  assert.ok(report.includes('Task #5 (fix-one): [SUCCESS] ok:fix-one'), '新计划 id 从既有最大 4 续编');
  assert.ok(report.includes('Task #6 (fix-two): [SUCCESS] ok:fix-two'));
  assert.ok(!report.includes('beta-y') && !report.includes('merge-result'), '旧队列余部零执行');
  assert.equal(coordinator.roster().length, 0, '失败波代理（未派发者 abort）全部回收');
  assert.ok(!report.includes('[FAILED]'), '终局无未解决失败');
});

// ─── ⑭ autonomousRun 续跑：runPilotLoop 重入消费 takeGranted ───

test('W3-4⑭: autonomousRun 续跑 —— 注入执行通道时 takeGranted 恰一次消费，对账随行，锚点留 [Resume] 注记', async () => {
  // 与 autonomy.integration Φ-I 同源的离线假世界（渐变 PNG + 假 OCR + 惰性键鼠）
  const gradientPng = async (width: number, height: number, vertical: boolean): Promise<Buffer> => {
    const data = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = vertical ? Math.round((y * 255) / (height - 1)) : Math.round((x * 255) / (width - 1));
        const i = (y * width + x) * 3;
        data[i] = v; data[i + 1] = v; data[i + 2] = v;
      }
    }
    return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
  };
  const pngA = await gradientPng(512, 384, false);
  const pngB = await gradientPng(512, 384, true);
  const wordsA = [{ label: '任务启动', bbox: { x0: 100, y0: 100, x1: 200, y1: 140 }, confidence: 0.9 }];
  const wordsB = [{ label: '任务完成', bbox: { x0: 60, y0: 200, x1: 180, y1: 240 }, confidence: 0.95 }];

  // 已批队列条目（经 restoreQueue 注入真实 approvalQueue —— takeGranted 消费面为真）
  approvalQueue.arm({ now: () => 1_000_000 });
  approvalQueue.restoreQueue([{
    id: 'QA-T1', token: 'APR-T1', description: 'click 发送 to submit',
    evidence: {}, enqueuedAt: 900_000, ttlMs: 3_600_000, expiresAt: 900_000 + 3_600_000,
    stepCursor: 0,
    decision: { verdict: 'granted', at: 950_000 },
  }]);
  // 步账 1 条 ⇒ 对账 = replay-window(cursor=0, window=1)
  await journal.append({ ts: 1, tool: 'click_mouse', args: { x: 1 }, status: 'SUCCESS' });

  const envKeys = ['GLM_API_KEY', 'ZHIPUAI_API_KEY', 'ZAI_API_KEY', 'GLM_BASE_URL', 'GLM_VLM_MODEL'] as const;
  const savedEnv = envKeys.map(k => [k, process.env[k]] as const);
  for (const k of envKeys) delete process.env[k];
  const host = system as unknown as Record<string, unknown>;
  const savedSys: Record<string, unknown> = {};
  let clicked = false;
  const patch = (key: string, fn: unknown) => { savedSys[key] = host[key]; host[key] = fn; };
  patch('getScreenSize', async () => ({ width: 1920, height: 1080 }));
  patch('clickMouse', async () => { clicked = true; });
  patch('typeText', async () => { throw new Error('本用例不得键入'); });
  patch('scroll', async () => { throw new Error('本用例不得滚动'); });
  patch('pressHotkey', async () => { throw new Error('本用例不得按键'); });

  let clock = 1_000;
  /** 执行通道捕获面（数组收集 —— 闭包赋值的 let 会被 CFA 收窄成 never） */
  interface ResumeCapture {
    entry: { id?: string };
    executionToken: string;
    reconciliation: { mode: string; cursor?: number; windowSize?: number; reason?: string };
  }
  const captures: ResumeCapture[] = [];
  try {
    resetGlmClient();
    const deps: AutonomousRunDeps = {
      capture: async () => (clicked ? pngB : pngA),
      readWords: async (buf: Buffer) => (buf === pngA ? wordsA : wordsB),
      groundVlm: async () => [],
      now: () => (clock += 50),
      sleep: async () => { /* 零真睡 */ },
      resumeGranted: async g => {
        captures.push(g);
        return '已批动作已派发（令牌随行）';
      },
    };
    const config = {
      autonomyEnabled: true,
      autonomyMaxSteps: 24,
      autonomyTimeBudgetSec: 300,
      autonomyAllowTiers: 'benign',
      autonomyVlmWhenUncertain: true,
      autonomyForbiddenKeywords: '',
      autonomyTracePath: '',
    } as Config;
    // 工具执行捷径（execute(args, undefined) 双参面 —— 与既有 autonomy 测试同律的类型窄面）
    type ToolLike = { execute: (a: unknown, e: unknown) => Promise<unknown> };
    const tool = createAutonomousRunTool(config, deps) as unknown as ToolLike;
    const out = JSON.parse(String(await tool.execute({ goal: '完成任务演示', success_criteria: ['任务完成'] }, undefined)));

    assert.equal(out.status, 'SUCCESS', '跑环正常终局（续跑是旁路，绝不炸环）');
    assert.equal(out.state_anchor.phase, 'achieved');
    const notes: string[] = out.state_anchor.execution_notes ?? [];
    assert.ok(notes.some(n => n.includes('[Resume]') && n.includes('QA-T1') && n.includes('replay-window')),
      `[Resume] 审计注记随锚点（实测 ${JSON.stringify(notes)}）`);
    assert.equal(captures.length, 1, '执行通道收到已批条目（恰一次）');
    assert.equal(captures[0]!.entry.id, 'QA-T1');
    assert.ok(captures[0]!.executionToken.startsWith('APR-'), '执行令牌已铸造（APR- 前缀）');
    assert.deepEqual(captures[0]!.reconciliation, { mode: 'replay-window', cursor: 0, windowSize: 1 },
      '对账结果随行（journal 步账 1 条，cursor 0）');
    assert.equal(approvalQueue.dumpQueue().length, 0, '条目恰一次消费（队列已清）');
  } finally {
    for (const [key, fn] of Object.entries(savedSys)) host[key] = fn;
    for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    resetGlmClient();
  }
});
