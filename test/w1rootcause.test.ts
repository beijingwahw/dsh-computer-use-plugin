// test/w1rootcause.test.ts
// W1-6（R1 鉴别试验）：失败根因归因链 —— 鉴别探针序列 / 证据链 / 降级 / 兜底。
//
// 全离线确定性：探针全部经注入端口（RootCauseProbePorts）注入假帧/假光标/
// 假 diff —— 零真实截图、零真实鼠标、零服务孵化。锁死的内容：
//   1. 三类根因（over-strict / blind-spot / stall）各自的鉴别路径与证据链结构
//   2. 排序候选列表（多候选竞争假设的降序）+ unknown 兜底
//   3. 探针缺席/抛错/超时/恶意注入件的降级（绝不抛、绝不悬挂）
//   4. failureMemory 的 rootCause 字段读写 / 按病因检索 / 旧记录（无字段）兼容
//   5. guards 接线：post-execute 失败分支触发归因、结果原样透传、遥测计数
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  differentialDiagnose,
  runDifferentialProbes,
  parseRootCause,
  ROOT_CAUSE_IDS,
  type RootCauseProbePorts,
  type ProbeFrame,
  type DiffObservation,
} from '../src/diagnosis.ts';
import { failureMemory } from '../src/failureMemory.ts';
import { telemetry } from '../src/telemetry.ts';
import type { Config } from '../src/config.ts';
import {
  registerRootCauseGuard,
  recentRootCauseReports,
  resetRootCauseGuard,
} from '../src/guards/rootCauseGuard.ts';

// ─── 测试基建：假帧 / 假光标 / 假 diff / 假 ctx ───

function frame(dhash: string, pixel = 'x'): ProbeFrame {
  return { dhash, buffer: Buffer.from(pixel) };
}

/** 可编程探针端口：每通道可编程返回值 + 调用计数（首中即断的经济学断言面） */
function fakePorts(opts: {
  diff?: DiffObservation | null;
  cursor?: { cursorKind: string | null; verdict: any } | null;
  followupDhashes?: Array<string | null>;
  beforeDhash?: string;
  afterDhash?: string;
  hangCaptureMs?: number;
  portTimeoutMs?: number;
} = {}): RootCauseProbePorts & {
  calls: { before: number; capture: number; diff: number; probe: number };
} {
  const calls = { before: 0, capture: 0, diff: 0, probe: 0 };
  let captures = 0;
  const ports: RootCauseProbePorts & { calls: typeof calls } = {
    calls,
    ...(opts.portTimeoutMs !== undefined ? { portTimeoutMs: opts.portTimeoutMs } : {}),
    getBeforeFrame: async () => {
      calls.before++;
      return opts.beforeDhash === undefined ? frame('aaa', 'before') : frame(opts.beforeDhash, 'before');
    },
    captureFrame: opts.hangCaptureMs
      ? () => new Promise<ProbeFrame>(() => { /* 永不 resolve：超时路径 */ })
      : async () => {
        calls.capture++;
        captures++;
        // 首次 = 失败后帧；后续 = 冻结探针帧
        if (captures === 1) return opts.afterDhash === undefined ? frame('bbb', 'after') : frame(opts.afterDhash, 'after');
        const d = opts.followupDhashes?.[captures - 2];
        return frame(d ?? 'bbb', `f${captures}`);
      },
    diffFrames: async () => {
      calls.diff++;
      return opts.diff === undefined ? null : opts.diff;
    },
    probePoint: async () => {
      calls.probe++;
      return opts.cursor === undefined ? null : opts.cursor;
    },
    freezeSampleGapMs: 0, // 离线：冻结探针零间隔
  };
  return ports;
}

const CFG = { enableInteractivityProbe: false } as unknown as Config;

interface RegisteredHandler {
  event: string;
  handler: (exec: any, result: any, next: () => Promise<any>) => Promise<any>;
}

function fakeCtx() {
  const handlers: RegisteredHandler[] = [];
  return {
    handlers,
    on(event: string, handler: any) { handlers.push({ event, handler }); return () => {}; },
  } as any;
}

function exec(name: string, args: unknown): any {
  return { name, arguments: args, agent: { id: 'w1-6-test' }, token: {}, rootCallId: 'c1' };
}

const FAILED_RESULT = { isError: false, value: '{\n  "status": "FAILED",\n  "state_anchor": {}\n}' };
const OK_RESULT = { isError: false, value: '{\n  "status": "SUCCESS",\n  "state_anchor": {}\n}' };

async function drivePost(ctx: any, e: any, result: any): Promise<any> {
  const h = ctx.handlers.find((r: RegisteredHandler) => r.event === 'tools/post-execute')!;
  return h.handler(e, result, async () => result);
}

beforeEach(() => {
  failureMemory.reset();
  resetRootCauseGuard();
  telemetry.reset();
});

// ─── 1. 纯函数：三类根因的鉴别路径与证据链 ───

test('R1-①: 屏变了但报失败 ⇒ over-strict-verification（证据链含观察值）', () => {
  const r = differentialDiagnose({
    tool: 'click_mouse',
    diff: { changed_fraction_pct: 3.2, identical: false },
  });
  assert.equal(r.rootCause, 'over-strict-verification');
  assert.equal(r.candidates[0].score, 0.9);
  const step = r.candidates[0].chain[0];
  assert.equal(step.probe, 'visual-diff');
  assert.match(step.observation, /changed_fraction_pct=3\.2/);
  assert.ok(step.symptom.length > 0 && step.differential.length > 0, '症状/鉴别非空');
  assert.ok(r.trail.some(s => s.probe === 'visual-diff'), '鉴别轨迹含本步');
});

test('R1-①: 屏没变 ⇒ over-strict 被排除（trail 记录排除步，不进候选）', () => {
  const r = differentialDiagnose({
    tool: 'click_mouse',
    diff: { changed_fraction_pct: 0, identical: true },
  });
  assert.equal(r.rootCause, 'unknown', '无其他证据 ⇒ 兜底');
  assert.ok(!r.candidates.some(c => c.rootCause === 'over-strict-verification'), '被排除者不进候选表');
  assert.ok(r.trail.some(s => s.differential.includes('excluded')), '排除步入轨迹（可审计）');
});

test('R1-②: 屏没变 + ibeam 光标 ⇒ blind-spot-text（I-beam 直证最强）', () => {
  const r = differentialDiagnose({
    tool: 'click_mouse',
    diff: { changed_fraction_pct: 0, identical: true },
    hoverCursorKind: 'ibeam',
    hoverVerdict: 'text',
  });
  assert.equal(r.rootCause, 'blind-spot-text');
  assert.equal(r.candidates[0].score, 0.92);
  assert.equal(r.candidates[0].chain[0].probe, 'hover-cursor');
  assert.match(r.candidates[0].chain[0].observation, /cursor=ibeam/);
});

test('R1-②: hand 光标（可点热区却无效）⇒ blind-spot-text 弱置信（低于 ibeam）', () => {
  const r = differentialDiagnose({
    tool: 'click_mouse',
    diff: { changed_fraction_pct: 0, identical: true },
    hoverCursorKind: 'hand',
    hoverVerdict: 'control',
  });
  assert.equal(r.rootCause, 'blind-spot-text');
  assert.equal(r.candidates[0].score, 0.65);
  const ibeam = differentialDiagnose({ tool: 't', diff: { changed_fraction_pct: 0, identical: true }, hoverCursorKind: 'ibeam' });
  assert.ok(r.candidates[0].score < ibeam.candidates[0].score, 'hand 弱于 ibeam 直证');
});

test('R1-②: UIA 结构层判 text（光标缺席）⇒ blind-spot-text', () => {
  const r = differentialDiagnose({
    tool: 'click_mouse',
    diff: { changed_fraction_pct: 0, identical: true },
    hoverVerdict: 'text',
  });
  assert.equal(r.rootCause, 'blind-spot-text');
  assert.equal(r.candidates[0].score, 0.88);
});

test('R1-③: 连续帧冻结（dhash 全同）⇒ stall（光标弃权后接棒）', () => {
  const r = differentialDiagnose({
    tool: 'click_mouse',
    diff: { changed_fraction_pct: 0, identical: true },
    hoverCursorKind: 'arrow',
    hoverVerdict: 'inconclusive',
    afterFrame: frame('frozen'),
    followupDhashes: ['frozen', 'frozen'],
  });
  assert.equal(r.rootCause, 'stall');
  assert.equal(r.candidates[0].score, 0.85);
  const step = r.candidates[0].chain[0];
  assert.equal(step.probe, 'frame-freeze');
  assert.match(step.observation, /frozen_frames=3/, 'after + 2 后续帧');
});

test('R1-③: 后续帧有变化 ⇒ stall 被排除 ⇒ unknown 兜底（诚实弃权）', () => {
  const r = differentialDiagnose({
    tool: 'click_mouse',
    diff: { changed_fraction_pct: 0, identical: true },
    hoverCursorKind: 'arrow',
    afterFrame: frame('fa'),
    followupDhashes: ['f1', 'f2'],
  });
  assert.equal(r.rootCause, 'unknown');
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].chain[0].probe, 'fallback', '兜底步入链');
});

test('R1-排序: 多候选竞争假设按置信降序（ibeam 0.92 > 微变化 0.55）', () => {
  const r = differentialDiagnose({
    tool: 'click_mouse',
    diff: { changed_fraction_pct: 0.2, identical: false }, // 微弱重绘：over-strict 弱证据
    hoverCursorKind: 'ibeam',
  });
  assert.equal(r.candidates.length, 2, '两个竞争假设都在表');
  assert.equal(r.candidates[0].rootCause, 'blind-spot-text');
  assert.equal(r.candidates[1].rootCause, 'over-strict-verification');
  assert.ok(r.candidates[0].score > r.candidates[1].score, '降序');
  for (const c of r.candidates) {
    assert.ok(c.chain.length >= 1, '每候选附证据链');
    assert.ok(c.hypothesis.length > 0 && c.hypothesis.length <= 200, '细化假设在 Token 纪律内');
    for (const s of c.chain) {
      assert.ok(s.probe && s.symptom && s.differential && s.observation, '证据步四要素齐备');
    }
  }
});

test('R1-①降级: 像素通道缺席 + dhash 指纹分歧 ⇒ over-strict 弱证据（观察源如实标注）', () => {
  const r = differentialDiagnose({
    tool: 'click_mouse',
    dhashSimilarity: 0.7,
  });
  assert.equal(r.rootCause, 'over-strict-verification');
  assert.equal(r.candidates[0].score, 0.55);
  assert.match(r.candidates[0].chain[0].observation, /dhash_similarity=0\.7/);
});

// ─── 2. 编排器：探针序列瀑布（注入端口，离线）───

test('R1-瀑布①: 屏显著变化 ⇒ 首中即断（悬停与冻结探针不被消费）', async () => {
  const ports = fakePorts({ diff: { changed_fraction_pct: 4.1, identical: false } });
  const r = await runDifferentialProbes(ports, { tool: 'click_mouse', point: { x: 0.5, y: 0.5 } });
  assert.equal(r.rootCause, 'over-strict-verification');
  assert.equal(ports.calls.probe, 0, '悬停探针未消费（首中即断）');
  assert.equal(ports.calls.capture, 1, '仅失败后帧一次采帧（无冻结后续帧）');
  assert.equal(r.degraded, false);
});

test('R1-瀑布②: 屏没变 + ibeam ⇒ blind-spot（冻结探针不被消费）', async () => {
  const ports = fakePorts({
    diff: { changed_fraction_pct: 0, identical: true },
    cursor: { cursorKind: 'ibeam', verdict: 'text' },
  });
  const r = await runDifferentialProbes(ports, { tool: 'click_mouse', point: { x: 0.5, y: 0.5 } });
  assert.equal(r.rootCause, 'blind-spot-text');
  assert.equal(ports.calls.probe, 1);
  assert.equal(ports.calls.capture, 1, '决定性光标 ⇒ 不做冻结探针');
});

test('R1-瀑布③: 屏没变 + 光标弃权 + 帧全同 ⇒ stall（after + 2 冻结帧）', async () => {
  const ports = fakePorts({
    diff: { changed_fraction_pct: 0, identical: true },
    cursor: { cursorKind: 'arrow', verdict: 'inconclusive' },
    followupDhashes: ['bbb', 'bbb'],
    afterDhash: 'bbb',
  });
  const r = await runDifferentialProbes(ports, { tool: 'click_mouse', point: { x: 0.5, y: 0.5 } });
  assert.equal(r.rootCause, 'stall');
  assert.equal(ports.calls.capture, 3, '1 失败后帧 + 2 冻结帧');
});

test('R1-瀑布④: 光标弃权 + 后续帧有变化 ⇒ unknown 兜底', async () => {
  const ports = fakePorts({
    diff: { changed_fraction_pct: 0, identical: true },
    cursor: { cursorKind: 'arrow', verdict: 'inconclusive' },
    followupDhashes: ['f1', 'f2'],
    afterDhash: 'fa',
  });
  const r = await runDifferentialProbes(ports, { tool: 'click_mouse', point: { x: 0.5, y: 0.5 } });
  assert.equal(r.rootCause, 'unknown');
  assert.equal(r.candidates.length, 1);
});

test('R1-瀑布②无坐标: type_text 等无点动作 ⇒ 跳过悬停直达冻结探针', async () => {
  const ports = fakePorts({
    diff: { changed_fraction_pct: 0, identical: true },
    followupDhashes: ['bbb'],
    afterDhash: 'bbb',
  });
  const r = await runDifferentialProbes(ports, { tool: 'type_text' });
  assert.equal(ports.calls.probe, 0, '无目标点 ⇒ 悬停探针不执行');
  assert.equal(r.rootCause, 'stall');
});

// ─── 3. 探针缺席降级（绝不抛、绝不悬挂）───

test('R1-降级: ports 未注入（null/undefined）⇒ unknown + 降级记注，不抛', async () => {
  const rNull = await runDifferentialProbes(null, { tool: 't' });
  assert.equal(rNull.rootCause, 'unknown');
  assert.equal(rNull.degraded, true);
  assert.ok(rNull.degradedNotes.some(n => n.includes('no probe ports')));
  const rUndef = await runDifferentialProbes(undefined, { tool: 't' });
  assert.equal(rUndef.rootCause, 'unknown');
});

test('R1-降级: 空端口对象 ⇒ 无任何探针可用 ⇒ unknown（无承诺则无降级）', async () => {
  const r = await runDifferentialProbes({}, { tool: 't' });
  assert.equal(r.rootCause, 'unknown');
  assert.equal(r.degraded, false, '未注入的端口不算降级 —— 缺席是诚实的');
});

test('R1-降级: 端口抛错 ⇒ 该步跳过 + 记注，序列继续不抛', async () => {
  const r = await runDifferentialProbes({
    getBeforeFrame: async () => { throw new Error('boom-before'); },
    captureFrame: async () => { throw new Error('boom-after'); },
    freezeSampleGapMs: 0,
  }, { tool: 't', point: { x: 0.1, y: 0.1 } });
  assert.equal(r.rootCause, 'unknown');
  assert.equal(r.degraded, true);
  assert.ok(r.degradedNotes.some(n => n.includes('threw')), '抛错被记注');
});

test('R1-降级: 端口悬挂 ⇒ 墙钟超时收口（不悬挂主流程）', async () => {
  const t0 = Date.now();
  const r = await runDifferentialProbes(
    fakePorts({ hangCaptureMs: 10_000, portTimeoutMs: 100 }),
    { tool: 't', point: { x: 0.1, y: 0.1 } },
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1000, `超时收口（实际 ${elapsed}ms）`);
  assert.equal(r.rootCause, 'unknown');
  assert.equal(r.degraded, true);
  assert.ok(r.degradedNotes.some(n => n.startsWith('captureFrame:')), '采帧缺席被记注');
});

test('R1-降级: 恶意注入件（属性读取即抛）⇒ 绝对不抛保证', async () => {
  const hostile: any = {};
  Object.defineProperty(hostile, 'getBeforeFrame', {
    get() { throw new Error('hostile getter'); },
  });
  const r = await runDifferentialProbes(hostile, { tool: 't' });
  assert.equal(r.rootCause, 'unknown');
  assert.equal(r.degraded, true);
  assert.ok(r.degradedNotes.some(n => n.includes('defensive fallback')));
});

test('R1-降级: 参考帧无像素（contextManager 已降级）⇒ dhash 粗判兜底', async () => {
  const r = await runDifferentialProbes({
    getBeforeFrame: async () => ({ dhash: '1111', buffer: null }),
    captureFrame: async () => ({ dhash: '0000', buffer: Buffer.from('after') }),
    // 无 diffFrames：像素引擎缺席
  }, { tool: 't', point: { x: 0.1, y: 0.1 }, });
  assert.equal(r.rootCause, 'over-strict-verification');
  assert.equal(r.candidates[0].score, 0.55, '降级引擎给弱置信');
  assert.ok(r.degraded, '降级如实申报');
  assert.ok(r.degradedNotes.some(n => n.includes('dhash fallback')));
});

// ─── 4. failureMemory：rootCause 字段读写与旧记录兼容 ───

test('FM-1: record 带 rootCause ⇒ dump/restore 往返保真；按病因检索命中', () => {
  failureMemory.record('open settings', 'click_mouse(x=0.9)', 'no change', undefined, 'blind-spot-text');
  const dumped = failureMemory.dump();
  assert.equal(dumped.records[0].rootCause, 'blind-spot-text');
  failureMemory.reset();
  failureMemory.restore(JSON.parse(JSON.stringify(dumped))); // 序列化往返
  assert.equal(failureMemory.matchByRootCause('blind-spot-text').length, 1);
  assert.equal(failureMemory.matchByRootCause('stall').length, 0);
});

test('FM-2: 旧记录（无 rootCause 字段）⇒ 视为 unknown 桶（向后兼容）', () => {
  failureMemory.record('legacy query', 'legacy approach', 'legacy symptom'); // 旧 4 参签名
  assert.equal(failureMemory.dump().records[0].rootCause, undefined);
  assert.equal(failureMemory.matchByRootCause('unknown').length, 1, '无字段 ⇒ unknown 桶');
  assert.equal(failureMemory.matchByRootCause('stall').length, 0);
  // 旧 checkpoint 形状直接 restore（无字段的对象字面量）
  failureMemory.reset();
  failureMemory.restore({ records: [{ id: 1, query: 'q', approach: 'a', symptom: 's', at: 1 }], nextId: 2 });
  assert.equal(failureMemory.matchByRootCause('unknown').length, 1);
});

test('FM-3: match 的病因过滤与文本通道并存（缺省不过滤 = 零回归）', () => {
  failureMemory.record('login flow', 'click_mouse(x=0.5)', 'no change', undefined, 'blind-spot-text');
  failureMemory.record('login flow', 'click_mouse(x=0.9)', 'no change', undefined, 'stall');
  // 无过滤：文本通道照常召回两条
  assert.equal(failureMemory.match('login flow no change').length, 2);
  // 病因过滤：只召回 blind-spot 一条（文本排序律不变）
  const only = failureMemory.match('login flow no change', undefined, 3, { rootCause: 'blind-spot-text' });
  assert.equal(only.length, 1);
  assert.equal(only[0].rootCause, 'blind-spot-text');
  // unknown 过滤 ⇒ 两者皆无（皆有明确病因）
  assert.equal(failureMemory.match('login flow no change', undefined, 3, { rootCause: 'unknown' }).length, 0);
});

test('FM-4: 近重复刷新病因（同查询+同路径 5 分钟内更新而非新建）', () => {
  const first = failureMemory.record('q', 'approach-A', 'symptom-1');
  assert.equal(first.rootCause, undefined);
  const second = failureMemory.record('q', 'approach-A', 'symptom-2', undefined, 'stall');
  assert.equal(second.id, first.id, '命中同一条记录');
  assert.equal(failureMemory.size, 1);
  assert.equal(failureMemory.dump().records[0].rootCause, 'stall');
});

test('FM-5: 垃圾病因值防御收口（parseRootCause / restore / record）', () => {
  assert.equal(parseRootCause('garbage'), 'unknown');
  assert.equal(parseRootCause(undefined), 'unknown');
  assert.equal(parseRootCause(42), 'unknown');
  for (const id of ROOT_CAUSE_IDS) assert.equal(parseRootCause(id), id);
  // record 入库防御：垃圾值归一为 unknown（不冒充知识）
  const rec = failureMemory.record('q', 'a', 's', undefined, 'not-a-cause' as any);
  assert.equal(rec.rootCause, 'unknown');
  // restore 对被篡改字段的归一：字面值不复存在，检索统一落 unknown 桶
  failureMemory.reset();
  failureMemory.restore({ records: [{ id: 1, query: 'q', approach: 'a', symptom: 's', at: 1, rootCause: 'hacked' } as any] });
  assert.equal(failureMemory.dump().records[0].rootCause, 'unknown', '篡改值被归一');
  assert.equal(failureMemory.matchByRootCause('unknown').length, 1, '归一后可按 unknown 检索');
  assert.equal(failureMemory.matchByRootCause('hacked' as any).length, 1, '垃圾查询键也落 unknown 桶（同一律）');
});

// ─── 5. guards 接线：post-execute 失败分支 ───

test('G-1: 失败分支触发归因 ⇒ 结果原样透传 + 病因入库 + 遥测计数 + 报告环', async () => {
  const ctx = fakeCtx();
  const ports = fakePorts({ diff: { changed_fraction_pct: 2.8, identical: false } });
  registerRootCauseGuard(ctx, CFG, ports);

  const out = await drivePost(ctx, exec('click_mouse', { x: 0.4, y: 0.4 }), FAILED_RESULT);
  // 结果不改写：经 hooks 链原样透传（观察者纪律 —— 守卫的返回 = 平台 next 的返回）
  assert.deepEqual(out, FAILED_RESULT);

  // 报告环 + 遥测
  const reports = recentRootCauseReports();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].rootCause, 'over-strict-verification');
  assert.equal(reports[0].tool, 'click_mouse');
  const counters = telemetry.snapshot().counters;
  assert.ok(counters.some(c => c.counter === 'rootcause:over-strict-verification' && c.hits === 1), '遥测计数在册');

  // 病因入库（与熔断器共享 rememberFailure 推导 ⇒ 同一签名）
  const hit = failureMemory.match('click_mouse', undefined, 5, { rootCause: 'over-strict-verification' });
  assert.equal(hit.length, 1);
  assert.match(hit[0].approach, /click_mouse/);
});

test('G-2: 成功分支不触发归因（探针零消费）', async () => {
  const ctx = fakeCtx();
  const ports = fakePorts({ diff: { changed_fraction_pct: 2.8, identical: false } });
  registerRootCauseGuard(ctx, CFG, ports);
  const out = await drivePost(ctx, exec('click_mouse', { x: 0.4, y: 0.4 }), OK_RESULT);
  assert.deepEqual(out, OK_RESULT);
  assert.equal(ports.calls.capture, 0, '成功 ⇒ 探针零消费');
  assert.equal(recentRootCauseReports().length, 0);
  assert.equal(failureMemory.size, 0);
});

test('G-3: 探针全缺席 ⇒ unknown 兜底不写库（兜底不冒充知识）', async () => {
  const ctx = fakeCtx();
  registerRootCauseGuard(ctx, CFG, {});
  const out = await drivePost(ctx, exec('click_mouse', { x: 0.4, y: 0.4 }), FAILED_RESULT);
  assert.deepEqual(out, FAILED_RESULT, '降级不拦截、不改写');
  const reports = recentRootCauseReports();
  assert.equal(reports[0].rootCause, 'unknown');
  assert.equal(failureMemory.size, 0, 'unknown 不入库');
  assert.ok(telemetry.snapshot().counters.some(c => c.counter === 'rootcause:unknown'));
});

test('G-4: 恶意注入件 ⇒ 守卫整体 try 兜底，主流程零感知', async () => {
  const ctx = fakeCtx();
  const hostile: any = { freezeSampleGapMs: 0 };
  Object.defineProperty(hostile, 'captureFrame', { get() { throw new Error('boom'); } });
  registerRootCauseGuard(ctx, CFG, hostile);
  const out = await drivePost(ctx, exec('click_mouse', { x: 0.4, y: 0.4 }), FAILED_RESULT);
  assert.deepEqual(out, FAILED_RESULT, '异常吞掉，结果原样');
  // 绝对不抛 ⇒ 防御兜底也产出合法报告（unknown + 降级记注），而非无报告
  const reports = recentRootCauseReports();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].rootCause, 'unknown');
  assert.equal(reports[0].degraded, true);
  assert.equal(failureMemory.size, 0, 'unknown 不入库');
});

test('G-5: blind-spot 全链（失败 + ibeam 假光标）⇒ 病因 blind-spot-text 入库', async () => {
  const ctx = fakeCtx();
  const ports = fakePorts({
    diff: { changed_fraction_pct: 0, identical: true },
    cursor: { cursorKind: 'ibeam', verdict: 'text' },
  });
  registerRootCauseGuard(ctx, CFG, ports);
  await drivePost(ctx, exec('click_mouse', { x: 0.5, y: 0.6 }), FAILED_RESULT);
  assert.equal(recentRootCauseReports()[0].rootCause, 'blind-spot-text');
  assert.equal(failureMemory.matchByRootCause('blind-spot-text').length, 1);
  const rec = failureMemory.matchByRootCause('blind-spot-text')[0];
  assert.ok(rec.rootCause === 'blind-spot-text' && rec.at > 0);
});

test('G-6: 报告环有界（8 条环形淘汰）', async () => {
  const ctx = fakeCtx();
  registerRootCauseGuard(ctx, CFG, {});
  for (let i = 0; i < 10; i++) {
    await drivePost(ctx, exec('click_mouse', { x: 0.1 * (i % 9 + 1), y: 0.2 }), FAILED_RESULT);
  }
  assert.equal(recentRootCauseReports().length, 8);
});
