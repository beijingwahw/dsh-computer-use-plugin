// test/w2analyze.test.ts
// R1-7(实战优化回路)回归:bench/analyzeCore.mjs 纯逻辑核心的失败归类/聚合/跨任务
// 模式/基线对比/工单生成/VLM 计量切片/重试链提取/密钥脱敏。
// bench/ 是纯 Node .mjs 工作台;与 w2bench/w2drive.test.ts 同策略 —— 非字面量动态
// import 挂载(tsc 不解析 .mjs,typecheck 干净),analyze-run/enrich-evidence 只做 IO
// 编排(决策全部问 analyzeCore),此处零 IO/零网络/零时钟。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const load = (p: string): Promise<any> => import(p);
const benchUrl = (f: string): string => new URL(`../bench/${f}`, import.meta.url).href;

const core = await load(benchUrl('analyzeCore.mjs'));

// ─── 密钥脱敏 ───

test('R1-7 Aa: redactSecrets —— sk 键/键值对/长 blob 三态脱敏,普通文本与路径不动', () => {
  assert.equal(core.redactSecrets('key is sk-abc123def456ghi789 ok'), 'key is [REDACTED:key] ok');
  assert.equal(core.redactSecrets('api_key: "supersecret1234"'), 'api_key: "[REDACTED]"');
  assert.equal(core.redactSecrets('"token" = "abcdef1234567890"'), '"token" = "[REDACTED]"');
  assert.equal(core.redactSecrets('hash a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'), 'hash [REDACTED:blob]');
  assert.equal(core.redactSecrets('C:\\Users\\28646\\normal\\path.txt'), 'C:\\Users\\28646\\normal\\path.txt');
  assert.equal(core.redactSecrets('确认码 482913 已投递'), '确认码 482913 已投递'); // 6 位码不是密钥料
  // 幂等:已脱敏标记不再二次折叠
  assert.equal(core.redactSecrets(core.redactSecrets('x sk-abcdefgh12345678 y')).includes('[REDACTED:key]'), true);
});

// ─── 历史行归一 ───

test('R1-7 Ab: normalizeHistRow —— drive(kind) 与 battery(ev) 双源归一', () => {
  assert.equal(core.normalizeHistRow({ kind: 'call', name: 'click_mouse' }).ev, 'call');
  assert.equal(core.normalizeHistRow({ ev: 'result', name: 'click_mouse', isError: true }).ev, 'result');
  const obj = core.normalizeHistRow({ kind: 'call', name: 'type_text', args: { text: 'hi' } });
  assert.equal(obj.args, '{"text":"hi"}'); // 对象 args → JSON 字符串(与 drive hist 预览同律)
  assert.equal(core.normalizeHistRow(null).ev, null); // 垃圾输入安全透传
});

// ─── 失败归类真假表(判序:驱动>时序>闸门>定位>理解;pass 短路) ───

test('R1-7 Ac: classifyFailure —— 五分类 + pass/unknown 真假表', () => {
  assert.equal(core.classifyFailure({ pass: true }), 'pass');
  assert.equal(core.classifyFailure({ harnessError: 'HTTP 500' }), 'driver');
  assert.equal(core.classifyFailure({ interrupted: true }), 'driver');
  assert.equal(core.classifyFailure({ channelError: true }), 'driver'); // E2 通道自身崩
  assert.equal(core.classifyFailure({ timedOut: true, toolErrors: 9 }), 'timing'); // 时序吞理解
  assert.equal(core.classifyFailure({ waitedMs: 295000, effectiveTimeoutMs: 300000 }), 'timing'); // ≥98% 贴顶
  assert.equal(core.classifyFailure({ waitedMs: 200000, effectiveTimeoutMs: 300000 }), 'unknown'); // 不贴顶且无其他信号
  assert.equal(core.classifyFailure({ waitedMs: 200000, effectiveTimeoutMs: 300000, guardBlocked: 1 }), 'gate-blocked');
  assert.equal(core.classifyFailure({ approvalDeadlock: true }), 'gate-blocked');
  // 定位三信号:VLM 错误率≥50%(calls≥3)/ 同名连发≥3 / noopish≥40%
  assert.equal(core.classifyFailure({ vlm: { calls: 4, failures: 2 } }), 'locating');
  assert.equal(core.classifyFailure({ vlm: { calls: 4, failures: 1 }, maxConsecutiveRepeat: 3 }), 'locating');
  assert.equal(core.classifyFailure({ journal: { noopishRate: 0.5 } }), 'locating');
  assert.equal(core.classifyFailure({ vlm: { calls: 2, failures: 2 } }), 'unknown'); // 样本不足(calls<3)不判定位,亦无其他信号
  assert.equal(core.classifyFailure({ toolErrors: 1 }), 'comprehension');
  assert.equal(core.classifyFailure({ turnErrors: 1 }), 'comprehension');
  assert.equal(core.classifyFailure({ pass: false, toolErrors: 0, turnErrors: 0 }), 'comprehension'); // 证据齐全的执行错
  assert.equal(core.classifyFailure({}), 'unknown');
  assert.equal(core.classifyFailure({ pass: undefined }), 'unknown');
});

// ─── VLM 计量切片(事件流重建) ───

test('R1-7 Ad: vlmMeterFromEvents —— VLM 族配对/降级分类/延迟(有 ts)与诚实缺席(无 ts)', () => {
  const ev = [
    { seq: 1, type: 'tool/call', name: 'click_element', data: '{"callId":"c1","ts":1700000000000}' },
    { seq: 2, type: 'tool/call', name: 'click_mouse', data: '{"callId":"m1"}' }, // 非 VLM 族:不进表
    { seq: 3, type: 'tool/result', name: 'click_element', data: '{"message":{"content":[{"toolCallId":"c1","isError":true,"text":"HTTP 429 too many requests"}]},"ts":1700000002500}' },
    { seq: 4, type: 'tool/call', name: 'zoom_inspect', data: '{"callId":"c2","ts":1700000003000}' },
    { seq: 5, type: 'tool/result', name: 'zoom_inspect', data: '{"message":{"content":[{"toolCallId":"c2","isError":false,"text":"ok"}]},"ts":1700000003400}' },
  ];
  const m = core.vlmMeterFromEvents(ev);
  assert.equal(m.calls, 2);
  assert.deepEqual(m.byKind, { ground: 2 });
  assert.equal(m.failures, 1);
  assert.deepEqual(m.degrade, { 'rate-limited': 1 });
  assert.equal(m.latency.samples, 2);
  assert.equal(m.latency.p50, 2500); // 最近邻秩法:[400,2500] 的 0.5 分位 → 秩 1
  assert.equal(m.latency.p95, 2500);
  assert.deepEqual(m.tools, ['click_element', 'zoom_inspect']);
  // 无 ts:延迟诚实缺席,计数照常
  const m2 = core.vlmMeterFromEvents([
    { seq: 1, type: 'tool/call', name: 'read_text', data: '{"callId":"x1"}' },
    { seq: 2, type: 'tool/result', name: 'read_text', data: '{"callId":"x1"}' },
  ]);
  assert.equal(m2.calls, 1);
  assert.equal(m2.latency.samples, 0);
  assert.equal(m2.latency.p50, null);
  assert.equal(core.vlmMeterFromEvents([]).present, true); // 空流:present 但零调用
  assert.equal(core.vlmMeterFromEvents(null).calls, 0); // 垃圾输入
});

// ─── 重试链提取 ───

test('R1-7 Ae: retryChainsFromHist —— 同名连发成链/单发带错成链/轮错误独立入账', () => {
  const rows = [
    { ev: 'call', name: 'click_element', turn: 1, step: 1 },
    { ev: 'result', name: 'click_element', isError: false, turn: 1, step: 1 },
    { ev: 'call', name: 'click_element', turn: 1, step: 2 },
    { ev: 'result', name: 'click_element', isError: true, text: 'target not found', turn: 1, step: 2 },
    { ev: 'call', name: 'click_element', turn: 1, step: 3 },
    { ev: 'result', name: 'click_element', isError: false, turn: 1, step: 3 },
    { ev: 'turn_error', error: '{"reason":"x"}' },
    { ev: 'call', name: 'type_text', turn: 2, step: 1 },
    { ev: 'result', name: 'type_text', isError: true, text: 'sk-forbidden000999', turn: 2, step: 1 },
  ];
  const c = core.retryChainsFromHist(rows);
  assert.equal(c.chainCount, 2); // click_element×3 连发 + type_text 单发带错
  const click = c.chains.find((x: any) => x.tool === 'click_element');
  assert.equal(click.attempts, 3);
  assert.equal(click.family, 'vlm:ground');
  assert.equal(click.endedInError, false); // 链尾找到的最近 result 是第 3 次的 success
  const type = c.chains.find((x: any) => x.tool === 'type_text');
  assert.equal(type.attempts, 1);
  assert.equal(type.endedInError, true);
  assert.ok(!type.lastError.includes('sk-forbidden')); // 错误文本先脱敏再入链
  assert.equal(c.turnErrors, 1);
  // kind 字段(drive hist)同律
  const c2 = core.retryChainsFromHist([
    { kind: 'call', name: 'zoom_inspect' }, { kind: 'call', name: 'zoom_inspect' },
    { kind: 'result', name: 'zoom_inspect', isError: true, text: 'timeout' },
  ]);
  assert.equal(c2.chains[0].attempts, 2);
  assert.equal(c2.chains[0].family, 'vlm:ground');
  // drive 真实形态:result 行带 callId 无 name —— FIFO 配对照样吃错误态
  const c3 = core.retryChainsFromHist([
    { kind: 'call', name: 'click_element' },
    { kind: 'result', callId: 'c2', isError: true, text: '429' },
    { kind: 'call', name: 'zoom_inspect' },
    { kind: 'result', callId: 'c3', isError: true, text: 'not found' },
    { kind: 'call', name: 'click_element' },
    { kind: 'result', callId: 'c4', isError: false },
    { kind: 'call', name: 'click_element' },
    { kind: 'result', callId: 'c5', isError: false },
  ]);
  assert.equal(c3.chainCount, 3); // click×1(带错) + zoom×1(带错) + click×2(连发)
  const clickRuns = c3.chains.filter((x: any) => x.tool === 'click_element');
  assert.deepEqual(clickRuns.map((x: any) => x.attempts).sort(), [1, 2]);
  assert.equal(clickRuns.find((x: any) => x.attempts === 1).endedInError, true); // FIFO 把 429 配给首发
});

// ─── journal 行动统计 ───

test('R1-7 Af: journalActionStats —— 步间隔/无效动作/守卫拦截/FAILED 计数', () => {
  const rows = [
    { ts: 1000, tool: 'click_mouse', args: {}, status: 'SUCCESS', effect_detected: true },
    { ts: 4000, tool: 'click_mouse', args: {}, status: 'SUCCESS', effect_detected: false }, // noopish
    { ts: 9000, tool: 'type_text', args: {}, status: 'FAILED' },
    { ts: 9500, tool: 'GUARD_BLOCKED', args: { guard: 'riskGate' }, status: 'MARKER' },
    { ts: 9600, tool: 'AGENT_BEGIN', args: {}, status: 'MARKER' }, // 非 ACTION_TOOLS 不计
  ];
  const st = core.journalActionStats(rows);
  assert.equal(st.actionCalls, 3);
  assert.equal(st.failed, 1);
  assert.equal(st.noopish, 1);
  assert.equal(st.noopishRate, 0.333);
  assert.equal(st.guardBlocked, 1);
  assert.deepEqual(Object.keys(st.perTool), ['click_mouse', 'type_text']);
  assert.equal(st.perTool['click_mouse'].calls, 2);
  assert.equal(st.perTool['click_mouse'].gapSamples, 2); // 两段间隔(第二段跨到 type_text)
  assert.equal(st.perTool['click_mouse'].stepGapMean, 4000); // (3000+5000)/2
  assert.equal(st.perTool['type_text'].calls, 1); // 尾行动:计数在场
  assert.equal(st.perTool['type_text'].stepGapMean, null); // 无下一行 ⇒ 无间隔(诚实 null,不冒充 0)
  assert.equal(core.journalActionStats([]).present, false);
});

// ─── 任务视图构建(IO 材料的纯变换) ───

test('R1-7 Ag: buildTaskView —— enriched 缺席时实时重建,在场时直用;归类落点随行', () => {
  const raw = {
    taskId: 't1', category: 'window',
    receipt: {
      pass: false, trajectoryPass: true, timedOut: false, waitedMs: 120000,
      timeoutPlan: { effective: 300000 }, harnessError: null,
      failedExpectations: null, retries: [{ method: 'session.prompt', kind: 'transient', action: 'resend' }],
      e2: { present: true, result: { pass: false, channelError: false } },
    },
    histRows: [
      { kind: 'call', name: 'click_element' }, { kind: 'result', name: 'click_element', isError: true, text: 'not found' },
      { kind: 'call', name: 'click_element' }, { kind: 'result', name: 'click_element', isError: true, text: 'not found' },
      { kind: 'call', name: 'click_element' }, { kind: 'result', name: 'click_element', isError: true, text: 'not found' },
    ],
    events: [], journalRows: [], enriched: null, evidencePaths: { hist: 't1/hist.jsonl' },
  };
  const v = core.buildTaskView(raw);
  // vlm 计量取自 events(空 ⇒ 0 —— hist 的 VLM 族调用进 steps/retryChain,不进计量)
  assert.equal(v.vlm.calls, 0);
  assert.equal(v.steps, 3);
  assert.equal(v.retryChain.chains.length, 1); // 连发 3 次带错
  assert.equal(v.failureCategory, 'locating'); // maxConsecutiveRepeat=3
  assert.equal(v.rpc.total, 1);
  assert.equal(v.rpc.transient, 1);
  // enriched 在场:直用(不再从 events 重建)
  const v2 = core.buildTaskView({ ...raw, enriched: { vlmMeter: { calls: 9, failures: 9, byKind: { ground: 9 }, degrade: {}, latency: { samples: 0 } } } });
  assert.equal(v2.vlm.calls, 9);
});

// ─── 聚合 ───

test('R1-7 Ah: aggregateViews —— 通过率/归类直方图/步数分位/rerun 剔除/确定性排序', () => {
  const mk = (id: string, pass: any, cat: string, steps: number, extra: any = {}) => ({
    taskId: id, category: cat, pass, failureCategory: extra.fc ?? 'comprehension',
    steps, vlm: extra.vlm ?? { calls: 0, failures: 0, byKind: {}, degrade: {}, latency: { samples: 0 } },
    journal: extra.journal ?? { present: false, perTool: {}, noopishRate: null },
    timedOut: extra.timedOut ?? false, rpc: { total: 0 },
    isRerun: extra.rerun ?? false,
  });
  const agg = core.aggregateViews([
    mk('b', true, 'win', 10),
    mk('a', true, 'win', 20),
    mk('c', false, 'file', 30, { fc: 'timing', timedOut: true }),
    mk('c', false, 'file', 5, { rerun: true }), // 复跑剔除
  ]);
  assert.equal(agg.tasks, 3);
  assert.equal(agg.pass, 2);
  assert.equal(agg.passRate, 0.667); // r3 舍入
  assert.deepEqual(agg.failuresByCategory, { timing: 1 });
  assert.deepEqual(agg.byCategory.win, { total: 2, pass: 2, fail: 0, unknown: 0 });
  assert.equal(agg.steps.min, 10);
  assert.equal(agg.steps.p50, 20);
  assert.equal(agg.steps.max, 30);
  assert.deepEqual(agg.tasksSummary.map((t: any) => t.taskId), ['a', 'b', 'c']); // 排序确定性
  // 稳定性:同输入再跑逐字节同形
  const agg2 = core.aggregateViews([
    mk('b', true, 'win', 10), mk('a', true, 'win', 20),
    mk('c', false, 'file', 30, { fc: 'timing', timedOut: true }), mk('c', false, 'file', 5, { rerun: true }),
  ]);
  assert.equal(JSON.stringify(agg), JSON.stringify(agg2));
});

// ─── 跨任务模式 ───

test('R1-7 Ai: crossTaskPatterns —— 慢工具排序/grounding 差屏幕/降级热点/重试热点', () => {
  const views = [
    {
      taskId: 't1', category: 'x', failureCategory: 'locating',
      vlm: { calls: 6, failures: 5, byKind: { ground: 6 }, degrade: { 'rate-limited': 2 }, latency: {} },
      journal: { present: true, perTool: { click_mouse: { calls: 5, stepGapMean: 9000, stepGapP95: 12000, totalTimeMs: 45000 } }, noopishRate: 0.5 },
      maxConsecutiveRepeat: 4, timedOut: false,
      retryChain: { chains: [{ tool: 'click_element', family: 'vlm:ground', attempts: 4, endedInError: true, lastError: null }] },
    },
    {
      taskId: 't2', category: 'x', failureCategory: 'comprehension',
      vlm: { calls: 2, failures: 0, byKind: { ground: 2 }, degrade: {}, latency: {} },
      journal: { present: true, perTool: { type_text: { calls: 4, stepGapMean: 2000, stepGapP95: 3000, totalTimeMs: 8000 } }, noopishRate: 0 },
      maxConsecutiveRepeat: 1, timedOut: false, retryChain: { chains: [] },
    },
  ];
  const p = core.crossTaskPatterns(views);
  assert.deepEqual(p.slowTools.map((s: any) => s.tool), ['click_mouse', 'type_text']); // calls≥3 门槛后按均值降序
  assert.ok(p.slowTools[0].stepGapMean >= (p.slowTools[1]?.stepGapMean ?? 0));
  assert.deepEqual(p.groundingPoor.map((g: any) => g.taskId), ['t1']); // ground≥3 且错误率≥50%
  assert.deepEqual(p.degradeHotspots, [{ taskId: 't1', degrade: { 'rate-limited': 2 }, total: 2 }]);
  assert.deepEqual(p.repeatHotspots, [{ tool: 'vlm:ground:click_element', maxAttempts: 4 }]);
});

// ─── 基线对比 ───

test('R1-7 Aj: compareWithBaselineReport —— 共有任务同总体/翻转清单/步数差/缺席诚实 null', () => {
  const cur = { tasksSummary: [
    { taskId: 'a', pass: false, steps: 12 }, { taskId: 'b', pass: true, steps: 8 }, { taskId: 'new', pass: true, steps: 5 },
  ], failuresByCategory: { comprehension: 1 } };
  const base = { aggregate: { tasksSummary: [
    { taskId: 'a', pass: true, steps: 10 }, { taskId: 'b', pass: false, steps: 14 }, { taskId: 'old', pass: true, steps: 3 },
  ], failuresByCategory: { timing: 1 } } };
  const c = core.compareWithBaselineReport(cur, base as any);
  assert.equal(c.sharedTasks, 2);
  assert.deepEqual(c.regressed, ['a']);
  assert.deepEqual(c.improved, ['b']);
  assert.deepEqual(c.currentOnly, ['new']);
  assert.deepEqual(c.baselineOnly, ['old']);
  assert.equal(c.passRateDelta, 0); // 1/2 vs 1/2
  assert.equal(c.stepsDelta, -2); // mean(12,8)=10 vs mean(10,14)=12
  assert.equal(core.compareWithBaselineReport(cur, null), null); // 首轮无基线
});

// ─── 工单生成 ───

test('R1-7 Ak: buildTickets —— 规则触发/优先级/证据路径/确定性(同输入同输出)', () => {
  const views = [
    {
      taskId: 'g1', category: 'x', failureCategory: 'gate-blocked', pass: false,
      guardBlocked: 2, approvalDeadlock: true, vlm: { calls: 0, failures: 0, byKind: {}, degrade: {}, latency: {} },
      journal: { present: true, perTool: {}, noopishRate: null }, retryChain: { chains: [] }, rpc: { total: 0 },
      evidencePaths: {},
    },
    {
      taskId: 'l1', category: 'x', failureCategory: 'locating', pass: false,
      vlm: { calls: 5, failures: 4, byKind: { ground: 5 }, degrade: {}, latency: {} },
      journal: { present: true, perTool: {}, noopishRate: 0.5 }, maxConsecutiveRepeat: 4,
      retryChain: { chains: [] }, rpc: { total: 0 }, evidencePaths: {},
    },
    {
      taskId: 'd1', category: 'x', failureCategory: 'driver', pass: undefined,
      harnessError: 'HTTP 503 on session.history', vlm: { calls: 0, failures: 0, byKind: {}, degrade: {}, latency: {} },
      journal: { present: false, perTool: {}, noopishRate: null }, retryChain: { chains: [] }, rpc: { total: 3 },
      evidencePaths: {},
    },
  ];
  const aggregate = core.aggregateViews(views as any);
  const patterns = core.crossTaskPatterns(views as any);
  const compare = { regressed: ['z9'], baselineRunId: 'old-run', passRateDelta: -0.5 };
  const t1 = core.buildTickets({ views, aggregate, patterns, compare: compare as any, evidenceRoot: 'ev' });
  const ids = t1.map((t: any) => t.id);
  // 顺序:驱动簇 → 闸门簇 → 基线回归 → 定位簇 → grounding 屏幕 → journal 缺席(d1)
  assert.deepEqual(ids, ['R17-001', 'R17-002', 'R17-003', 'R17-004', 'R17-005', 'R17-006']);
  assert.equal(t1[0].priority, 'P0'); // 驱动故障簇
  assert.ok(t1[0].evidence.includes('ev/d1/receipt.json'));
  assert.equal(t1[1].priority, 'P0'); // 闸门拦截簇
  assert.ok(t1[1].suspectedModule.includes('riskGate'));
  assert.equal(t1[2].priority, 'P0'); // 基线回归
  assert.equal(t1[3].priority, 'P1'); // 定位失败簇
  assert.ok(t1[4].symptom.includes('groundCalls=5')); // grounding 差屏幕
  assert.equal(t1[5].priority, 'P2'); // journal 切片缺席
  assert.ok(t1[5].evidence.includes('ev/d1/journal-lines.jsonl'));
  // 确定性:再生成一次逐字节同形(序号重置机制)
  const t2 = core.buildTickets({ views, aggregate, patterns, compare: compare as any, evidenceRoot: 'ev' });
  assert.equal(JSON.stringify(t1), JSON.stringify(t2));
  // schema 契约:每条工单四要素齐
  for (const t of t1) {
    assert.equal(t.schema, 'r17-ticket/1');
    assert.ok(t.symptom && t.evidence && t.suspectedModule && ['P0', 'P1', 'P2'].includes(t.priority));
  }
});

// ─── kernel 快照机会主义提取 ───

test('R1-7 Al: kernelSnapshotFromHist —— get_metrics 形态提取/缺席诚实申报', () => {
  const rows = [
    { kind: 'result', name: 'get_metrics', text: '前置噪声 {"uptime_sec":42,"global":{"calls":9},"tools":[{"tool":"click_mouse","calls":9,"success_rate":88.9,"noop_rate":0,"avg_ms":120,"p50_ms":100,"p95_ms":300}]}' },
  ];
  const k = core.kernelSnapshotFromHist(rows as any);
  assert.equal(k.present, true);
  assert.equal(k.uptime_sec, 42);
  assert.equal(k.tools[0].tool, 'click_mouse');
  const k2 = core.kernelSnapshotFromHist([{ kind: 'result', name: 'other', text: '{"foo":1}' }]);
  assert.equal(k2.present, false);
  assert.ok(k2.reason.includes('不可回取'));
});

// ─── markdown 渲染 ───

test('R1-7 Am: renderReportMarkdown —— 四段骨架齐(汇总/归类/模式/工单)', () => {
  const aggregate = { tasks: 1, pass: 0, fail: 1, unknown: 0, passRate: 0, steps: { min: 1, p50: 1, max: 1, mean: 1 }, perTool: {}, vlm: { calls: 0, failures: 0, failureRate: null, degrade: {}, p50Latency: null, p95Latency: null }, failuresByCategory: { timing: 1 }, byCategory: {}, tasksSummary: [{ taskId: 'x', category: 'c', pass: false, failureCategory: 'timing', steps: 1, vlmCalls: 0, timedOut: true, rpcRetries: 0 }] };
  const patterns = { slowTools: [], groundingPoor: [], degradeHotspots: [], repeatHotspots: [], timeoutTasks: ['x'], driverFaults: [], gateBlocks: [] };
  const tickets = core.buildTickets({ views: [{ taskId: 'x', failureCategory: 'timing', pass: false, vlm: {}, journal: {}, retryChain: { chains: [] }, rpc: {}, evidencePaths: {} } as any], aggregate, patterns, compare: null });
  const md = core.renderReportMarkdown({ runId: 'r', suiteName: 's', aggregate, patterns, compare: null, tickets });
  assert.ok(md.includes('# R1-7 跑批分析报告'));
  assert.ok(md.includes('## 失败归类'));
  assert.ok(md.includes('时序失败'));
  assert.ok(md.includes('## 跨任务模式'));
  assert.ok(md.includes('## 工单'));
  assert.ok(md.includes('[P1] R17-001'));
});
