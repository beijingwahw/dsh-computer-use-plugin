// test/w5cross.test.ts
// W5-3（L3 跨机编排）执法册：一任务 N 手 —— 分布式 barrier + 跨机视觉互证。
// 覆盖（全离线确定性：注入内存传输/时钟/睡眠；真 server 冒烟仅环回 127.0.0.1）：
//   ①  barrier 纯核心 —— 全到达才放行（满员恰在最后一次 allocate 迁移）、
//       放行后名册封顶、重放 allocate 不重复计数、N=1 抵达即满员、
//       半 barrier 永不合并（count-conflict）；
//   ②  两阶段（allocate/commit）防脑裂 —— 放行前 commit ⇒ not-released、
//       非名册 ⇒ not-a-participant、迟到加入 ⇒ missed-release、全 N 确认 ⇒
//       退休（seq 前进）；
//   ③  序号防重放 —— 退休账把守（无在役 generation 也拒旧 seq：stale-seq /
//       unknown-seq / unknown-barrier 三分支）；
//   ④  有界状态 —— maxLive FIFO 驱逐（驱逐先记 tombstone ⇒ 迟到包仍吃
//       stale-seq）、tombstone 账 FIFO 有界（有界内存 ⇒ 有界重放视野）、
//       TTL 清扫（序号前进 + 轮询自愈重建）；
//   ⑤  客户端等待循环 —— 双实例内存 hub 往返（A 拨号 B 接听）、未到齐超时
//       诚实失败、transport 故障、领域拒绝直通、冻结时钟不死循环（maxPolls）；
//   ⑥  跨机互证谓词 —— judgeRemoteChange 纯核心（命中/阈值边界/缺席/无期望/
//       无区域）+ settleAndVerify 集成（视觉阳性门控、port-error 防御、
//       端口缺席 ⇒ golden 逐字节不变）；
//   ⑦  编排注入缝 —— barrier 步先于 actor 执行 + [Barrier] 审计行、超时
//       诚实失败走 Σ-4 脊梁、缺省零回归（含 marker 任务逐字节一致）、
//       barrierOf 覆写 + 并行波内 barrier（写通道之外等待）；
//   ⑧  真 server 冒烟 —— federation-server.mjs 环回起服（W8-A7 单源化后经
//       dist/crossMachine.js 直连核心）：脚本序列与 TS 源核心逐字段对账
//       （把守 src↔dist 构建滞后）、双 HTTP 客户端 barrier 往返、协议执法
//       （405/400/404）、向后兼容（/aggregate 与 /health 旧字段不动）；
//   ⑨  HTTP 壳离线 —— URL/体方言、坏载荷 ⇒ transport 诚实失败；
//   ⑩  立法在源 —— 常量与端口签名源级锁定。
import { test, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

import {
  createBarrierCore,
  arriveAndWaitBarrier,
  createBarrierClient,
  makeHttpBarrierTransport,
  parseBarrierStep,
  BARRIER_MAX_PARTICIPANTS,
  type BarrierCore,
  type BarrierTransport,
  type BarrierRequest,
  type BarrierFetch,
} from '../src/crossMachine.ts';
import * as backend from '../src/physicalBackend.ts';
import { normalizeHash } from '../src/perceptualHash.ts';
import {
  settleAndVerify,
  judgeRemoteChange,
  REMOTE_EVIDENCE_OVERLAP_MIN,
  REMOTE_PEERS_MAX,
  type BeforeState,
  type SettleOptions,
  type CombinedEffect,
  type RemoteChange,
  type RemoteRegion,
} from '../src/actionVerifier.ts';
import { runOrchestrator } from '../src/orchestrator.ts';
import type { ChatFn, SubTask } from '../src/planner.ts';
import { coordinator } from '../src/subAgent.ts';
import { resetApproval } from '../src/approval.ts';
import { journal } from '../src/journal.ts';

// ─── 测试基建 ───

beforeEach(() => {
  coordinator.reset();
  journal.reset();
  resetApproval();
});

/** 内存 hub 传输：两个「机器」共享同一核心 —— 零网络的双实例模拟 */
function hubOf(core: BarrierCore): BarrierTransport {
  return req => Promise.resolve(core.apply(req));
}

/** 注入时钟工坊：t 可读可拨；sleep 推进 t（轮询确定性） */
function fakeClock(start = 0): { now: () => number; sleep: (ms: number) => Promise<void>; t: () => number; set: (v: number) => void } {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    t: () => t,
    set: (v: number) => { t = v; },
  };
}

function chatOf(plan: unknown): ChatFn {
  return async () => JSON.stringify(plan);
}

/** 首调返 first、二调（Σ-4 重规划）返 second 的假 chat */
function chatWithReplan(first: unknown, second: unknown): ChatFn {
  let n = 0;
  return async () => { n++; return JSON.stringify(n === 1 ? first : second); };
}

const PLAN: SubTask[] = [
  { id: 1, action: 'open-dialer', deps: [] },
  { id: 2, action: 'dial-call barrier:dial#2', deps: [1] },
  { id: 3, action: 'log-result', deps: [2] },
];

// ═══ ① barrier 纯核心：全到达才放行 ═══

test('W5-3①a: 全到达才放行 —— N=3 名册恰在最后一次 allocate 迁移 committed；放行后名册封顶', () => {
  const core = createBarrierCore({ now: () => 1000 });
  const v1 = core.apply({ op: 'allocate', name: 'call', peer: 'A', n: 3 });
  assert.deepEqual(
    v1,
    { ok: true, name: 'call', seq: 1, phase: 'collecting', expected: 3, arrived: ['A'], acked: [], releasedAt: null },
    '首到：collecting + 名册 1 票',
  );
  const v2 = core.apply({ op: 'allocate', name: 'call', peer: 'B', n: 3 });
  assert.equal(v2.phase, 'collecting', '2/3 未到齐不放行');
  const v3 = core.apply({ op: 'allocate', name: 'call', peer: 'C', n: 3 });
  assert.equal(v3.phase, 'committed', '满员即放行（单一服务端事实）');
  assert.equal(v3.releasedAt, 1000, '放行时刻 = 注入时钟');
  assert.deepEqual(v3.arrived, ['A', 'B', 'C'], '名册字典序');
  // 放行后：参与者幂等重询拿现行视图；名册封顶（迟到新 peer 在 ②b 验证）
  const again = core.apply({ op: 'allocate', name: 'call', peer: 'A', n: 3 });
  assert.equal(again.ok, true);
  assert.equal(again.phase, 'committed');
  assert.deepEqual(again.arrived, ['A', 'B', 'C'], '重放不重复计数（Set 语义）');
  // 只读 status 与 allocate 视图一致
  const st = core.apply({ op: 'status', name: 'call', peer: 'A' });
  assert.deepEqual(st, again, 'status = 只读镜像');
});

test('W5-3①b: 重放 allocate 不重复计数；N=1 抵达即满员；坏请求不动状态', () => {
  const core = createBarrierCore({ now: () => 0 });
  for (let i = 0; i < 3; i++) {
    const v = core.apply({ op: 'allocate', name: 'call', peer: 'A', n: 2 });
    assert.equal(v.phase, 'collecting', `第 ${i + 1} 次重放仍是 1 票（不提前放行）`);
    assert.deepEqual(v.arrived, ['A']);
  }
  const one = createBarrierCore({ now: () => 5 });
  const v1 = one.apply({ op: 'allocate', name: 'solo', peer: 'A', n: 1 });
  assert.equal(v1.phase, 'committed', 'N=1：单参与者 barrier 抵达即满员');
  assert.equal(v1.releasedAt, 5);
  // 坏请求：形状/值域（不触状态）
  assert.equal(core.apply({ op: 'allocate', name: '', peer: 'A', n: 2 }).reason, 'bad-request');
  assert.equal(core.apply({ op: 'allocate', name: 'x', peer: 'A', n: 0 }).reason, 'bad-request');
  assert.equal(core.apply({ op: 'allocate', name: 'x', peer: 'A', n: BARRIER_MAX_PARTICIPANTS + 1 }).reason, 'bad-request');
  assert.equal(core.apply({ op: 'allocate', name: 'x', peer: 'A', n: 1.5 }).reason, 'bad-request');
  assert.equal(core.apply({ op: 'allocate', name: 'x'.repeat(129), peer: 'A', n: 2 }).reason, 'bad-request');
  assert.equal(core.apply({ op: 'allocate', name: 'x', peer: 'p'.repeat(129), n: 2 }).reason, 'bad-request');
  assert.equal(core.apply({ op: 'status', name: 'nope', peer: 'A' }).reason, 'unknown-barrier');
  assert.equal(core.liveCount(), 1, '坏请求不改变在役面');
});

test('W5-3①c: 两个半 barrier 永不合并 —— expected 钉死于创建（count-conflict）', () => {
  const core = createBarrierCore({ now: () => 0 });
  core.apply({ op: 'allocate', name: 'call', peer: 'A', n: 2 });
  const v = core.apply({ op: 'allocate', name: 'call', peer: 'B', n: 3 });
  assert.equal(v.ok, false, 'N 声明冲突 ⇒ 拒绝');
  assert.equal(v.reason, 'count-conflict');
  assert.equal(v.expected, 2, '携带对端钉死的 expected（诊断面）');
  const st = core.apply({ op: 'status', name: 'call', peer: 'A' });
  assert.equal(st.phase, 'collecting', '冲突请求不并入（名册仍 1 票）');
  assert.deepEqual(st.arrived, ['A']);
});

// ═══ ② 两阶段（allocate/commit）防脑裂 ═══

test('W5-3②a: commit 阶段纪律 —— 放行前 not-released；非名册 not-a-participant；全 N 确认退休', () => {
  const core = createBarrierCore({ now: () => 0 });
  core.apply({ op: 'allocate', name: 'call', peer: 'A', n: 2 });
  assert.equal(core.apply({ op: 'commit', name: 'call', peer: 'A', seq: 1 }).reason, 'not-released',
    '放行前确认 = 阶段倒置（两阶段纪律）');
  core.apply({ op: 'allocate', name: 'call', peer: 'B', n: 2 }); // committed
  assert.equal(core.apply({ op: 'commit', name: 'call', peer: 'C', seq: 1 }).reason, 'not-a-participant',
    '名册外无票可确认');
  const c1 = core.apply({ op: 'commit', name: 'call', peer: 'A', seq: 1 });
  assert.equal(c1.ok, true, '参与者放行后确认 ⇒ ok');
  assert.notEqual(c1.retired, true, '1/2 确认 ⇒ generation 驻留（防脑裂：晚见者仍可取视图）');
  const st = core.apply({ op: 'status', name: 'call', peer: 'A' });
  assert.equal(st.phase, 'committed');
  assert.deepEqual(st.acked, ['A']);
  const c2 = core.apply({ op: 'commit', name: 'call', peer: 'B', seq: 1 });
  assert.equal(c2.retired, true, '全 N 确认 ⇒ 退休');
  assert.equal(core.apply({ op: 'status', name: 'call', peer: 'A' }).reason, 'unknown-barrier',
    '退休后无在役视图');
  const next = core.apply({ op: 'allocate', name: 'call', peer: 'A', n: 2 });
  assert.equal(next.seq, 2, '下一 generation 序号前进（1 → 2）');
  assert.equal(next.phase, 'collecting');
});

test('W5-3②b: 防脑裂 —— 放行后迟到加入 ⇒ missed-release（不悄悄混入已放行轮次）', () => {
  const core = createBarrierCore({ now: () => 0 });
  core.apply({ op: 'allocate', name: 'call', peer: 'A', n: 2 });
  core.apply({ op: 'allocate', name: 'call', peer: 'B', n: 2 }); // committed（未退休）
  const late = core.apply({ op: 'allocate', name: 'call', peer: 'C', n: 2 });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'missed-release', '放行点已过：迟到者拿诚实拒绝，不是放行也不是静默排队');
});

// ═══ ③ 序号防重放（退休账把守）═══

test('W5-3③: 序号防重放 —— 退休账跨 generation 把守旧 seq 包', () => {
  const core = createBarrierCore({ now: () => 0 });
  // 完成一轮（gen seq=1 退休）
  core.apply({ op: 'allocate', name: 'r', peer: 'A', n: 2 });
  core.apply({ op: 'allocate', name: 'r', peer: 'B', n: 2 });
  core.apply({ op: 'commit', name: 'r', peer: 'A', seq: 1 });
  core.apply({ op: 'commit', name: 'r', peer: 'B', seq: 1 });
  // 无在役 generation：旧 seq ⇒ stale-seq；超前 ⇒ unknown-barrier
  assert.equal(core.apply({ op: 'commit', name: 'r', peer: 'A', seq: 1 }).reason, 'stale-seq',
    '退休账拒第 1 轮重放包');
  assert.equal(core.apply({ op: 'commit', name: 'r', peer: 'A', seq: 99 }).reason, 'unknown-barrier',
    '无在役时超前 seq = 无此 barrier（不猜）');
  // 新 generation（seq=2）在役：旧/超前 seq 三分支
  core.apply({ op: 'allocate', name: 'r', peer: 'A', n: 2 });
  assert.equal(core.apply({ op: 'commit', name: 'r', peer: 'A', seq: 1 }).reason, 'stale-seq');
  assert.equal(core.apply({ op: 'commit', name: 'r', peer: 'A', seq: 3 }).reason, 'unknown-seq');
  assert.equal(core.apply({ op: 'commit', name: 'r', peer: 'A', seq: 2 }).reason, 'not-released',
    'seq 正确 ⇒ 进入阶段纪律（未放行）');
});

// ═══ ④ 有界状态 ═══

test('W5-3④a: maxLive FIFO 驱逐 —— 驱逐先记 tombstone（迟到包 ⇒ stale-seq 而非误收）', () => {
  const core = createBarrierCore({ now: () => 0, maxLive: 3, maxTombstones: 8, ttlMs: 10_000 });
  for (const n of ['b1', 'b2', 'b3']) core.apply({ op: 'allocate', name: n, peer: 'A', n: 2 });
  assert.equal(core.liveCount(), 3, '容量上限内');
  core.apply({ op: 'allocate', name: 'b4', peer: 'A', n: 2 });
  assert.equal(core.liveCount(), 3, '超额 ⇒ FIFO 驱逐最旧');
  assert.equal(core.apply({ op: 'status', name: 'b1', peer: 'A' }).reason, 'unknown-barrier');
  assert.equal(core.apply({ op: 'commit', name: 'b1', peer: 'A', seq: 1 }).reason, 'stale-seq',
    '被驱逐轮次的迟到 commit 仍吃退休账（驱逐不豁免重放）');
  assert.equal(core.tombstoneCount(), 1);
});

test('W5-3④b: tombstone 账 FIFO 有界 —— 超界驱逐后旧 name 迟到包 ⇒ unknown-barrier（诚实折衷）', () => {
  const core = createBarrierCore({ now: () => 0, maxTombstones: 2, ttlMs: 10_000 });
  for (const n of ['x1', 'x2', 'x3']) {
    core.apply({ op: 'allocate', name: n, peer: 'A', n: 1 });   // N=1 即放行
    core.apply({ op: 'commit', name: n, peer: 'A', seq: 1 });   // 即退休
  }
  assert.equal(core.tombstoneCount(), 2, '退休账 FIFO 封顶');
  assert.equal(core.apply({ op: 'commit', name: 'x1', peer: 'A', seq: 1 }).reason, 'unknown-barrier',
    '有界内存 ⇒ 有界重放视野：账面淘汰后的旧包按「无此 barrier」处理（不臆造）');
});

test('W5-3④c: TTL 清扫 —— 驻留超时 ⇒ 驱逐 + 序号前进；轮询者自愈重建新 generation', () => {
  const clk = fakeClock(0);
  const core = createBarrierCore({ now: clk.now, ttlMs: 1000, maxTombstones: 8 });
  core.apply({ op: 'allocate', name: 'call', peer: 'A', n: 2 });
  clk.set(2000); // 越过 TTL
  const v = core.apply({ op: 'allocate', name: 'call', peer: 'B', n: 2 });
  assert.equal(v.seq, 2, 'TTL 驱逐后重建 ⇒ generation 序号前进（1 → 2）');
  assert.deepEqual(v.arrived, ['B'], '新 generation 重新收客（B 首票）');
  assert.equal(v.phase, 'collecting', 'A 的旧抵达随旧 generation 结清 —— 双方继续轮询自愈');
  assert.equal(core.apply({ op: 'commit', name: 'call', peer: 'A', seq: 1 }).reason, 'stale-seq',
    '旧轮次包被退休账把守');
});

// ═══ ⑤ 客户端等待循环（注入传输 —— 离线确定性）═══

test('W5-3⑤a: 双实例往返（内存 hub）—— A 拨号 B 接听：全到达双双放行，两阶段确认后退休', async () => {
  const core = createBarrierCore({ now: () => 0 });
  const hub = hubOf(core);
  const clk = fakeClock(0);
  const opts = { transport: hub, now: clk.now, sleep: clk.sleep, pollMs: 10, timeoutMs: 5000 };
  // A 先抵达并等待（拨号方），B 后抵达（接听方）—— B 的抵达使名册满员
  const pa = arriveAndWaitBarrier('call', 2, { peer: 'A', ...opts });
  const rb = await arriveAndWaitBarrier('call', 2, { peer: 'B', ...opts });
  const ra = await pa;
  assert.equal(rb.ok, true, 'B：抵达即放行');
  assert.equal(rb.seq, 1);
  assert.deepEqual(rb.peers, ['A', 'B']);
  assert.equal(ra.ok, true, 'A：轮询见到放行（同一服务端事实，无分叉视图）');
  assert.equal(ra.seq, 1, 'A/B 同 generation');
  assert.deepEqual(ra.peers, ['A', 'B']);
  assert.equal(ra.ack?.ok, true, '阶段二确认成功');
  assert.equal(ra.ack?.retired, true, '后确认方（A）的 ack 恰好退休 generation');
  assert.equal(core.liveCount(), 0, '全 N 确认 ⇒ 零驻留（有界状态闭环）');
  assert.deepEqual(core.snapshot(), []);
});

test('W5-3⑤b: 未到齐等待 + 超时诚实失败 —— 绝不臆造放行，附最后在役面', async () => {
  const core = createBarrierCore({ now: () => 0 });
  const hub = hubOf(core);
  const clk = fakeClock(0);
  const r = await arriveAndWaitBarrier('call', 2, {
    peer: 'A', transport: hub, now: clk.now, sleep: clk.sleep, pollMs: 10, timeoutMs: 100,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timeout', '到齐前预算耗尽 ⇒ 诚实 timeout');
  assert.equal(r.waitedMs, 100, '等待时长 = 超时预算（注入时钟确定性）');
  assert.equal(r.expected, 2);
  assert.deepEqual(r.arrived, ['A'], '诊断面：超时时已见名册');
  const st = core.apply({ op: 'status', name: 'call', peer: 'A' });
  assert.equal(st.phase, 'collecting', '服务端不受超时牵连（名册驻留待自愈重建）');
});

test('W5-3⑤c: transport 全程故障 ⇒ transport；领域拒绝直通（count-conflict 不硬磨）', async () => {
  const clk = fakeClock(0);
  const dead: BarrierTransport = async () => { throw new Error('net down'); };
  const rDead = await arriveAndWaitBarrier('call', 2, {
    peer: 'A', transport: dead, now: clk.now, sleep: clk.sleep, pollMs: 10, timeoutMs: 50,
  });
  assert.equal(rDead.ok, false);
  assert.equal(rDead.reason, 'transport', '全程零成功往返 ⇒ transport（非 timeout —— 语义分野）');

  const core = createBarrierCore({ now: () => 0 });
  core.apply({ op: 'allocate', name: 'call', peer: 'X', n: 3 }); // 对端先立 n=3
  const rConflict = await arriveAndWaitBarrier('call', 2, {
    peer: 'B', transport: hubOf(core), now: clk.now, sleep: clk.sleep, pollMs: 10, timeoutMs: 5000,
  });
  assert.equal(rConflict.ok, false);
  assert.equal(rConflict.reason, 'count-conflict', '语义性拒绝立即直通（轮询磨不掉）');
  assert.equal(rConflict.expected, 3);
});

test('W5-3⑤d: 冻结时钟不死循环 —— maxPolls 护栏 ⇒ 诚实超时（确定性上界）', async () => {
  const core = createBarrierCore({ now: () => 0 });
  let calls = 0;
  const hub: BarrierTransport = req => { calls++; return Promise.resolve(core.apply(req)); };
  const frozen = { now: (): number => 5000, sleep: async (): Promise<void> => { /* 冻结 */ } };
  const r = await arriveAndWaitBarrier('call', 2, {
    peer: 'A', transport: hub, now: frozen.now, sleep: frozen.sleep, pollMs: 10, timeoutMs: 100,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timeout');
  assert.equal(calls, 13, '迭代护栏 ceil(100/10)+3 = 13 次封顶（时钟冻结也不死循环）');
});

// ═══ ⑥ 跨机互证谓词 ═══

/** 期望区域：归一化 [0.1,0.5]×[0.1,0.5]（面积 0.16） */
const HINT: RemoteRegion = { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.5 };

function changeOf(...regions: RemoteRegion[]): RemoteChange {
  return { screen: 'feedfacefeedface', region: '0123abcd0123abcd', regions };
}

test('W5-3⑥a: judgeRemoteChange —— 命中/阈值边界/不达阈/缺席/无期望/无区域', () => {
  assert.equal(REMOTE_EVIDENCE_OVERLAP_MIN, 0.25, '立法常量：交叠覆盖率下限 0.25');
  // 命中：区域几乎覆盖期望区域（0.38²/0.16 = 0.9025）
  const hit = judgeRemoteChange(HINT, changeOf({ x0: 0.12, y0: 0.12, x1: 0.5, y1: 0.5 }));
  assert.deepEqual(hit, { verdict: 'corroborated', overlap: 0.9025 });
  // 阈值边界：交叠恰 0.04/0.16 = 0.25 ⇒ ≥ 下限 ⇒ 命中（闭下限）
  const edge = judgeRemoteChange(HINT, changeOf({ x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3 }));
  assert.equal(edge.verdict, 'corroborated');
  assert.equal(edge.overlap, 0.25);
  // 不达阈：小交叠 + 不相交
  const low = judgeRemoteChange(HINT, changeOf({ x0: 0.1, y0: 0.1, x1: 0.16, y1: 0.16 }));
  assert.deepEqual(low, { verdict: 'unverified', overlap: 0.0225, reason: 'overlap-below-min' });
  const away = judgeRemoteChange(HINT, changeOf({ x0: 0.6, y0: 0.6, x1: 0.9, y1: 0.9 }));
  assert.deepEqual(away, { verdict: 'unverified', overlap: 0, reason: 'overlap-below-min' });
  // 证据缺席 / 无期望（严格）/ 无变化区域
  assert.deepEqual(judgeRemoteChange(HINT, null), { verdict: 'unverified', overlap: 0, reason: 'absent' });
  assert.deepEqual(judgeRemoteChange(null, changeOf({ x0: 0, y0: 0, x1: 1, y1: 1 })),
    { verdict: 'unverified', overlap: 0, reason: 'no-hint' }, '说不出该出现在哪 ⇒ 无权互证（谓词严格）');
  assert.deepEqual(judgeRemoteChange(HINT, changeOf()), { verdict: 'unverified', overlap: 0, reason: 'no-change-regions' });
});

// settleAndVerify 离线基建（w4audio 同律：假 adapter 经 _setAdapterForTests 注入）

function fakeAdapter(afterDhash: string): never {
  return {
    async takeScreenshot() {
      return {
        ok: true as const,
        value: {
          transport: 'none' as const, name: '', size: 0,
          shape: [1, 1, 3] as [number, number, number], dtype: 'uint8', stride: 3,
          format: 'META', width: 1, height: 1, captured_at: 1,
          image_base64: '', dhash: afterDhash,
          region_dhash: null, unchanged: true, frame_id: null, frame_count: 0,
        },
      };
    },
  } as never;
}

const BASE_OPTS: SettleOptions = {
  adaptive: false, settleMs: 1, threshold: 0.98, regionRadius: 0,
};

function makeBefore(hash: string): BeforeState {
  return { screen: hash, phash: null, region: null, focus: null };
}

async function verify(beforeHash: string, afterHash: string, extra?: Partial<SettleOptions>): Promise<CombinedEffect> {
  backend._setAdapterForTests(fakeAdapter(afterHash));
  return settleAndVerify(makeBefore(beforeHash), { ...BASE_OPTS, ...extra });
}

// unique 哈希对（视觉阳性：sim < 0.98；避开振荡检测器跨测试耦合）
const P_BEFORE1 = '0123456789abcdef';
const P_AFTER1 = 'fedcba9876543210';  // 与前者逐位全异（互补指纹）⇒ 汉明 64/64、sim 0
const P_BEFORE2 = 'a1b2c3d4e5f60718';
const P_AFTER2 = '5e4d3c2b1a09f8e7';
const P_BEFORE3 = '13579bdf2468ace0';
const P_AFTER3 = 'eca86420fdb97531';
const H_GOLDEN = 'abcd1234abcd1234';
const H_NEG = 'deadbeefcafe1234';

test('W5-3⑥b: settleAndVerify 集成 —— 视觉阳性 + 命中 ⇒ corroborated；below ⇒ unverified', async () => {
  const calls: string[] = [];
  const mk = (change: RemoteChange | null) => async (peer: string, hint: RemoteRegion | null): Promise<RemoteChange | null> => {
    calls.push(`${peer}:${hint ? 'hint' : 'no-hint'}`);
    return change;
  };
  const rHit = await verify(P_BEFORE1, P_AFTER1, {
    remotePeers: ['peerB'],
    remoteRegionHint: HINT,
    remoteEvidence: mk(changeOf({ x0: 0.12, y0: 0.12, x1: 0.5, y1: 0.5 })),
  });
  assert.equal(rHit.detected, true, '视觉阳性（page-level）');
  assert.deepEqual(calls, ['peerB:hint'], '端口按 (peer, hint) 被询问');
  assert.ok(rHit.remote, 'remote 键在场（门控命中）');
  assert.deepEqual(rHit.remote!.hint, HINT);
  assert.deepEqual(rHit.remote!.perPeer, [{ peer: 'peerB', verdict: 'corroborated', overlap: 0.9025 }]);
  assert.equal(rHit.remote!.corroborated, 1);
  assert.equal(rHit.remote!.unverified, 0);

  const rMiss = await verify(P_BEFORE2, P_AFTER2, {
    remotePeers: ['peerB', 'peerC'],
    remoteRegionHint: HINT,
    remoteEvidence: mk(changeOf({ x0: 0.6, y0: 0.6, x1: 0.9, y1: 0.9 })),
  });
  assert.ok(rMiss.remote);
  assert.equal(rMiss.remote!.corroborated, 0, 'B/C 屏期望区域无变化 ⇒ 双双不达阈');
  assert.equal(rMiss.remote!.unverified, 2);
  assert.equal(rMiss.remote!.perPeer[0]!.reason, 'overlap-below-min');
});

test('W5-3⑥c: 门控与防御 —— 视觉阴性/退化不取证；端口抛错 ⇒ port-error；peers 上界', async () => {
  // 视觉阴性：无本屏效果 ⇒ 无互证题（键缺席）
  const rNeg = await verify(H_NEG, H_NEG, {
    remotePeers: ['peerB'],
    remoteRegionHint: HINT,
    remoteEvidence: async () => { throw new Error('should not be asked'); },
  });
  assert.equal(rNeg.detected, false);
  assert.equal('remote' in rNeg, false, '视觉阴性 ⇒ 端口不被询问（对称门控：音频问阴性，远程问阳性）');

  // 视觉未验证（指纹退化）：Δ-7 同律 —— 证据不可用 ≠ 无变化，不得互证
  const rUnv = await verify('0000000000000000', P_AFTER1, {
    remotePeers: ['peerB'],
    remoteRegionHint: HINT,
    remoteEvidence: async () => { throw new Error('should not be asked'); },
  });
  assert.equal(rUnv.unverifiable, 'screen:zero');
  assert.equal('remote' in rUnv, false);

  // 端口抛错 ⇒ 诚实 port-error（防御式不毒化主链）
  const rErr = await verify(P_BEFORE3, P_AFTER3, {
    remotePeers: ['peerB'],
    remoteRegionHint: HINT,
    remoteEvidence: async () => { throw new Error('peer offline'); },
  });
  assert.equal(rErr.detected, true);
  assert.ok(rErr.remote);
  assert.deepEqual(rErr.remote!.perPeer, [{ peer: 'peerB', verdict: 'unverified', overlap: 0, reason: 'port-error' }]);
  assert.equal(rErr.remote!.unverified, 1);

  // 端口在场但 peers 空 ⇒ 不取证；peer 数上界 REMOTE_PEERS_MAX
  const rNoPeers = await verify(P_BEFORE1, P_AFTER1, {
    remoteRegionHint: HINT,
    remoteEvidence: async () => changeOf({ x0: 0.12, y0: 0.12, x1: 0.5, y1: 0.5 }),
  });
  assert.equal('remote' in rNoPeers, false, '无 peers ⇒ 端口不被询问');
  let asked = 0;
  const rMany = await verify(P_BEFORE2, P_AFTER2, {
    remotePeers: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'bad'],
    remoteRegionHint: HINT,
    remoteEvidence: async () => { asked++; return changeOf({ x0: 0.12, y0: 0.12, x1: 0.5, y1: 0.5 }); },
  });
  assert.equal(asked, REMOTE_PEERS_MAX, `取证 peer 数封顶 ${REMOTE_PEERS_MAX}（旁路不透支）`);
  assert.equal(rMany.remote!.perPeer.length, REMOTE_PEERS_MAX);
  assert.equal(rMany.remote!.corroborated, REMOTE_PEERS_MAX);

  // 非法 hint（退化框）= 未声明 ⇒ 严格 no-hint
  const rBadHint = await verify(P_BEFORE1, P_AFTER1, {
    remotePeers: ['peerB'],
    remoteRegionHint: { x0: 0.5, y0: 0.5, x1: 0.5, y1: 0.5 },
    remoteEvidence: async () => changeOf({ x0: 0.12, y0: 0.12, x1: 0.5, y1: 0.5 }),
  });
  assert.deepEqual(rBadHint.remote!.perPeer[0], { peer: 'peerB', verdict: 'unverified', overlap: 0, reason: 'no-hint' });
  assert.equal(rBadHint.remote!.hint, null, '退化 hint 净化为未声明');
});

test('W5-3⑥d: 端口缺席 ⇒ 返回体逐字节不变（兼容铁律，golden 对比）', async () => {
  const r = await verify(H_GOLDEN, H_GOLDEN);
  assert.equal('remote' in r, false, '端口缺席 ⇒ remote 键整体缺席');
  const golden = {
    detected: false,
    screen: { effect_detected: false, similarity_pct: 100, distance: 0 },
    region: null,
    scale: 'none' as const,
    afterBuffer: Buffer.alloc(0),
    afterHash: normalizeHash(H_GOLDEN),
    oscillation: null,
    intent: undefined,
    phashCorroborates: undefined,
    unverifiable: undefined,
    afterFrameId: null,
  };
  assert.deepStrictEqual(r, golden, '返回体与 W4-8 后现状 golden 深度等同');
  assert.equal(JSON.stringify(r), JSON.stringify(golden), '序列化字节等同（逐字节铁律）');
});

// ═══ ⑦ 编排注入缝 ═══

test('W5-3⑦a: barrier 步 —— 到达即 arrive 等待（先于 actor）+ [Barrier] 审计行', async () => {
  const order: string[] = [];
  const actor = async (task: string): Promise<string> => {
    order.push(`act:${task}`);
    return `[SUCCESS] ok:${task}`;
  };
  const crossMachine = {
    arriveAndWait: async (name: string, n: number) => {
      order.push(`bar:${name}#${n}`);
      return { ok: true as const, name, seq: 1, peers: ['A', 'B'], waitedMs: 3 };
    },
  };
  const report = await runOrchestrator('拨打电话并记录', actor, chatOf(PLAN), undefined, { crossMachine });
  assert.deepEqual(order, ['act:open-dialer', 'bar:dial#2', 'act:dial-call barrier:dial#2', 'act:log-result'],
    'barrier 等待先于该步物理执行（前置依赖语义）');
  const lines = report.split('\n');
  assert.deepEqual(lines, [
    'Task #1 (open-dialer): [SUCCESS] ok:open-dialer',
    '[Barrier] dial#2 passed (seq 1, peers A,B, 3ms)',
    'Task #2 (dial-call barrier:dial#2): [SUCCESS] ok:dial-call barrier:dial#2',
    'Task #3 (log-result): [SUCCESS] ok:log-result',
  ], '审计行先于任务行，其余契约行与串行脊梁同构');
});

test('W5-3⑦b: barrier 超时诚实失败 ⇒ [FAILED] 行走 Σ-4 自愈脊梁（一次重规划后再败即止）', async () => {
  const order: string[] = [];
  const actor = async (task: string): Promise<string> => {
    order.push(`act:${task}`);
    return `[SUCCESS] ok:${task}`;
  };
  let barCalls = 0;
  const crossMachine = {
    arriveAndWait: async (name: string, n: number) => {
      barCalls++;
      order.push(`bar:${name}#${n}`);
      return { ok: false as const, name, reason: 'timeout' as const, waitedMs: 30, arrived: ['A'], expected: n };
    },
  };
  const report = await runOrchestrator('拨打电话并记录', actor, chatWithReplan(PLAN, PLAN), undefined, { crossMachine });
  assert.equal(barCalls, 2, '失败一次 → Σ-4 重规划一次 → 再败即止');
  assert.ok(report.includes('[FAILED] cross-barrier dial#2 timeout (expected 2) after 30ms, peers seen: A'),
    '诚实失败行携带 reason + expected + 已见名册');
  assert.ok(report.includes('[Replan]'), 'Σ-4 自愈脊梁接管（与既有失败方言同律）');
  assert.ok(!report.includes('act:dial-call'), 'barrier 未放行 ⇒ 该步物理部分不执行（前提未成立）');
  assert.equal(order.filter(o => o.startsWith('act:')).length, order.filter(o => o === 'act:open-dialer').length,
    'actor 只执行过非 barrier 步');
});

test('W5-3⑦c: 缺省零回归 —— crossMachine 缺席 ⇒ 报告与无 opts 基线逐字节一致（marker 任务同判）', async () => {
  const mkActor = (log: string[]): ReturnType<typeof okActor> => okActor(log);
  const PLAN_NO_MARKER: SubTask[] = [
    { id: 1, action: 'open-dialer', deps: [] },
    { id: 2, action: 'dial-call', deps: [1] },
    { id: 3, action: 'log-result', deps: [2] },
  ];
  const a = await runOrchestrator('p', mkActor([]), chatOf(PLAN)); // 无 opts（旧签名）
  const b = await runOrchestrator('p', mkActor([]), chatOf(PLAN), undefined, {}); // 空 opts
  assert.equal(a, b, '空 opts = 无 opts');
  // crossMachine 在场但任务无 marker 声明 ⇒ 方言不激活（arriveAndWait 零调用）
  let asked = 0;
  const d = await runOrchestrator('p', mkActor([]), chatOf(PLAN_NO_MARKER), undefined, {
    crossMachine: {
      arriveAndWait: async () => { asked++; return { ok: false as const, name: 'x', reason: 'timeout' as const, waitedMs: 0 }; },
    },
  });
  const e = await runOrchestrator('p', mkActor([]), chatOf(PLAN_NO_MARKER));
  assert.equal(asked, 0, 'arriveAndWait 零调用');
  assert.equal(d, e, '无 marker ⇒ 注入在场也逐字节等于基线');
  assert.ok(a.includes('Task #2 (dial-call barrier:dial#2)'), 'crossMachine 缺席时 marker 文本只是普通 action（现状语义）');
});

function okActor(log: string[]) {
  return async (task: string): Promise<string> => {
    log.push(task);
    return `[SUCCESS] ok:${task}`;
  };
}

test('W5-3⑦d: barrierOf 注入覆写 + 并行波内 barrier（写通道之外等待）', async () => {
  const DIAL: SubTask[] = [
    { id: 1, action: 'open-app', deps: [] },
    { id: 2, action: 'dial', deps: [1] },          // 无 marker —— 由 barrierOf 覆写声明
    { id: 3, action: 'watch-screen', deps: [1] },
    { id: 4, action: 'report', deps: [2, 3] },
  ];
  const order: string[] = [];
  const actor = async (task: string): Promise<string> => {
    order.push(`act:${task}`);
    return `[SUCCESS] ok:${task}`;
  };
  let barCalls = 0;
  const report = await runOrchestrator('双机协同', actor, chatOf(DIAL), undefined, {
    parallel: true,
    crossMachine: {
      arriveAndWait: async (name: string, n: number) => {
        barCalls++;
        order.push(`bar:${name}#${n}`);
        return { ok: true as const, name, seq: 1, peers: ['A', 'B'], waitedMs: 2 };
      },
      barrierOf: t => (t.action === 'dial' ? { name: 'sync', n: 2 } : null),
    },
  });
  assert.equal(barCalls, 1, '覆写声明：仅 dial 步是 barrier 点');
  assert.ok(report.includes('[Barrier] sync#2 passed (seq 1, peers A,B, 2ms)'), '波内 barrier 审计行');
  const bi = report.split('\n').findIndex(l => l.startsWith('[Barrier]'));
  const ti = report.split('\n').findIndex(l => l.startsWith('Task #2 (dial)'));
  assert.ok(bi !== -1 && ti !== -1 && bi < ti, '[Barrier] 行先于 Task #2 行');
  assert.equal(report.includes('[FAILED]'), false, '全部完成（波次路径 + barrier 放行）');
  assert.deepEqual(order.filter(o => o.startsWith('act:')).length, 4, '四步全执行');
});

// ═══ ⑧ 真 server 冒烟（环回 127.0.0.1；环境不支持 ⇒ 诚实 skip）═══

/** 起联邦服务器（--port 0 ⇒ 随机环回口；8s 监听 + 5s 就绪上界；失败抛错供 skip） */
async function startFederationServer(): Promise<{ port: number; child: ChildProcess; stop: () => Promise<void> }> {
  const script = fileURLToPath(new URL('../scripts/federation-server.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    let settledFlag = false;
    const done = (v: number | null): void => {
      if (settledFlag) return;
      settledFlag = true;
      clearTimeout(timer);
      if (v === null) reject(new Error('联邦服务器未在 8s 内报出监听口'));
      else resolve(v);
    };
    const timer = setTimeout(() => done(null), 8_000);
    child.stdout!.on('data', (d: Buffer) => {
      buf += String(d);
      if (/"event":"listening"/.test(buf)) {
        const m = buf.match(/"port":(\d+)/);
        if (m) done(Number(m[1]));
      }
    });
    child.on('error', () => done(null));
    child.on('exit', () => done(null));
  });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
      if (r.ok) break;
    } catch {
      /* 未就绪：继续轮询 */
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('联邦服务器 /health 5s 未就绪');
    }
    await new Promise(r => setTimeout(r, 100));
  }
  child.stdout!.resume();
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    const exited = new Promise<void>(resolve => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    child.kill();
    await exited;
  };
  return { port, child, stop };
}

test('W5-3⑧: 真 server 冒烟 —— 等价/往返/协议执法/向后兼容', { timeout: 60_000 }, async t => {
  let srv: Awaited<ReturnType<typeof startFederationServer>>;
  try {
    srv = await startFederationServer();
  } catch (e) {
    return t.skip(`环境不支持子进程/环回监听：server 冒烟诚实跳过（${(e as Error).message}）`);
  }
  const base = `http://127.0.0.1:${srv.port}`;
  const httpT = makeHttpBarrierTransport({ endpoint: base });
  try {
    // (a) /health：旧字段不动 + barrier 水位增量字段（向后兼容）
    const h = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(h.status, 200);
    const hj = (await h.json()) as { ok: boolean; epoch: string; buffered: number; bufferCap: number; barriers: number; barrierCap: number };
    assert.equal(hj.ok, true);
    assert.equal(hj.epoch, 'Mu2', '旧纪元字段不动');
    assert.equal(hj.buffered, 0);
    assert.equal(hj.barriers, 0, '初起零在役 barrier');
    assert.equal(hj.barrierCap, 64);

    // (b) 协议执法：GET allocate ⇒ 405；坏 JSON ⇒ 400；未知路径 ⇒ 404（新路由进清单）
    const rGet = await fetch(`${base}/barrier/allocate`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(rGet.status, 405);
    const rBad = await fetch(`${base}/barrier/allocate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"broken', signal: AbortSignal.timeout(2_000),
    });
    assert.equal(rBad.status, 400);
    const r404 = await fetch(`${base}/nope`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(r404.status, 404);
    const j404 = (await r404.json()) as { error?: string };
    assert.match(String(j404.error), /barrier/, '404 清单提及 barrier 路由');
    const rStatusGet = await fetch(`${base}/barrier/status?name=nope`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(rStatusGet.status, 200);
    assert.equal(((await rStatusGet.json()) as { ok: boolean; reason: string }).reason, 'unknown-barrier', 'GET status 只读面');

    // (c) 单源对账闸（W8-A7：server 经 dist 直连 TS 核心）：脚本序列 → TS 源核心
    //（本测试直连 src/*.ts）vs HTTP server（经 dist 构建产物），视图逐字段一致
    //（releasedAt 除外 —— 时钟源不同；dist 构建滞后于 src ⇒ 此闸红 —— 重建即绿）。
    // 脚本覆盖幂等/冲突/两阶段/退休/重放全分支
    const script: BarrierRequest[] = [
      { op: 'allocate', name: 'eq', peer: 'A', n: 2 },
      { op: 'allocate', name: 'eq', peer: 'A', n: 2 },
      { op: 'allocate', name: 'eq', peer: 'C', n: 3 },
      { op: 'allocate', name: 'eq', peer: 'B', n: 2 },
      { op: 'commit', name: 'eq', peer: 'C', seq: 1 },
      { op: 'commit', name: 'eq', peer: 'A', seq: 1 },
      { op: 'status', name: 'eq', peer: 'A' },
      { op: 'commit', name: 'eq', peer: 'B', seq: 1 },
      { op: 'commit', name: 'eq', peer: 'B', seq: 1 },
      { op: 'allocate', name: 'eq', peer: 'A', n: 2 },
    ];
    const tsCore = createBarrierCore({ now: () => 7 });
    const strip = (v: unknown): unknown => {
      const o = { ...(v as object) };
      delete (o as { releasedAt?: unknown }).releasedAt;
      return o;
    };
    for (const req of script) {
      const fromTs = strip(tsCore.apply(req));
      const fromHttp = strip(await httpT(req));
      assert.deepStrictEqual(fromHttp, fromTs, `脚本步 ${req.op}:${req.peer} src↔dist 视图漂移（构建滞后？npm run build）`);
    }

    // (d) 双 HTTP 客户端 barrier 往返（真 fetch —— A 拨号 B 接听）
    const cA = createBarrierClient({ peer: 'A', transport: httpT, pollMs: 25, timeoutMs: 8_000 });
    const cB = createBarrierClient({ peer: 'B', transport: httpT, pollMs: 25, timeoutMs: 8_000 });
    const pa = cA.arriveAndWait('e2e-dial', 2);
    const rb = await cB.arriveAndWait('e2e-dial', 2);
    const ra = await pa;
    assert.equal(rb.ok, true, 'B 抵达即放行');
    assert.equal(ra.ok, true, 'A 轮询见放行');
    if (ra.ok && rb.ok) {
      assert.equal(ra.seq, rb.seq, '同 generation');
      assert.deepEqual([...ra.peers].sort(), ['A', 'B']);
      assert.equal(ra.ack?.ok, true);
    }
    const after = await fetch(`${base}/barrier/status?name=e2e-dial`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(((await after.json()) as { ok: boolean; reason?: string }).reason, 'unknown-barrier',
      '双端两阶段确认 ⇒ generation 退休（零驻留）');

    // (e) 向后兼容：/aggregate 旧协议逐字节照旧（旧 peer 不受 barrier 增量影响）
    const digest = { v: 1, mintedAt: 1, epsilon: 1, keys: [{ key: 'w5.srv', n: 1, bins: Array.from({ length: 8 }, () => [1, 0]) }] };
    const rAgg = await fetch(`${base}/aggregate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(digest), signal: AbortSignal.timeout(5_000),
    });
    assert.equal(rAgg.status, 200);
    const aj = (await rAgg.json()) as { ok: boolean; method: string; sources: number; digest: unknown };
    assert.equal(aj.ok, true, '聚合端行为不变');
    assert.equal(aj.method, 'single');
    assert.equal(aj.sources, 1);
    assert.ok(aj.digest, '合并摘要照旧产出');
    const h2 = (await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) })).json()) as { buffered: number; barriers: number };
    assert.equal(h2.buffered, 1, '摘要环照旧入环');
    assert.equal(h2.barriers, 1, 'eq barrier 在役（未全确认 —— 与 e2e 退休分野）');
  } finally {
    await srv.stop();
  }
});

// ═══ ⑨ HTTP 壳离线（注入 fetch —— 零网络）═══

test('W5-3⑨: makeHttpBarrierTransport —— URL/体方言；坏载荷 ⇒ transport 诚实失败', async () => {
  const calls: string[] = [];
  const fake: BarrierFetch = async (url, init) => {
    calls.push(`${init.method} ${url} ${init.body}`);
    return {
      json: async () => ({
        ok: true, name: 'x', seq: 1, phase: 'collecting', expected: 2, arrived: ['x'], acked: [], releasedAt: null,
      }),
    };
  };
  const t = makeHttpBarrierTransport({ endpoint: 'http://127.0.0.1:1/', fetchImpl: fake });
  const v = await t({ op: 'allocate', name: 'x', peer: 'p', n: 2 });
  assert.equal(v.ok, true);
  assert.deepEqual(calls, ['POST http://127.0.0.1:1/barrier/allocate {"name":"x","peer":"p","n":2}'],
    '尾斜杠容忍 + 路由/体方言钉死（name/peer/n;status 不带 peer）');
  await t({ op: 'status', name: 'x', peer: '' });
  assert.match(calls[1]!, /\/barrier\/status \{"name":"x"\}$/, 'status 体不含 peer');
  const bad = makeHttpBarrierTransport({
    endpoint: 'http://x', fetchImpl: (async () => ({ json: async () => 'nope' })) as never as BarrierFetch,
  });
  await assert.rejects(() => bad({ op: 'status', name: 'x', peer: '' }), /unparsable/,
    '坏载荷上抛 ⇒ 等待循环吸收为 transport 诚实失败');
});

test('W5-3⑩: parseBarrierStep 方言 —— 匹配/钳制/无匹配', () => {
  assert.deepEqual(parseBarrierStep('拨打 barrier:dial#2 后等待'), { name: 'dial', n: 2 });
  assert.deepEqual(parseBarrierStep('barrier:sync.handshake#1'), { name: 'sync.handshake', n: 1 });
  assert.deepEqual(parseBarrierStep('barrier:big#999'), { name: 'big', n: BARRIER_MAX_PARTICIPANTS }, 'n 钳到上界');
  assert.equal(parseBarrierStep('no marker here'), null);
  assert.equal(parseBarrierStep(42), null);
  assert.equal(parseBarrierStep('barrier:#2'), null);
});

// ═══ ⑩ 立法在源 ═══

test('W5-3⑩: 立法在源 —— 常量与端口签名源级锁定', () => {
  const cm = readFileSync(new URL('../src/crossMachine.ts', import.meta.url), 'utf8');
  assert.match(cm, /BARRIER_MAX_LIVE = 64/, '在役上界立法常量');
  assert.match(cm, /BARRIER_MAX_TOMBSTONES = 256/, '退休账上界立法常量');
  assert.match(cm, /BARRIER_TTL_MS = 120_000/, 'TTL 立法常量');
  assert.match(cm, /全到达才放行/, '一致性论证在源');
  const av = readFileSync(new URL('../src/actionVerifier.ts', import.meta.url), 'utf8');
  assert.match(av, /REMOTE_EVIDENCE_OVERLAP_MIN = 0\.25 as const/, '互证谓词阈值立法常量（改值 = 修法）');
  assert.match(av, /remoteEvidence\?: \(peer: string, expectedRegionHint: RemoteRegion \| null\) => Promise<RemoteChange \| null>/,
    '远程谓词端口签名锁定');
  const orch = readFileSync(new URL('../src/orchestrator.ts', import.meta.url), 'utf8');
  assert.match(orch, /crossMachine\?: CrossMachineSeam/, '编排注入缝字段锁定');
  const srv = readFileSync(new URL('../scripts/federation-server.mjs', import.meta.url), 'utf8');
  // W8-A7（D-F3 闭）单源口径：server 直连 dist 的 createBarrierCore —— 第二份
  // 状态机（手工移植）不得复活（单源化前由等价断言把守漂移，现由结构断言锁死）
  assert.match(srv, /from '\.\.\/dist\/crossMachine\.js'/, '服务器单源消费 dist 的 crossMachine（W8-A7 双实现退役）');
  assert.match(srv, /createBarrierCore\(\)/, '服务器持有 dist 核心的模块级单例（单一 barrier 世界）');
  assert.doesNotMatch(srv, /function barrierApplyJS/, 'barrier JS 手工移植不得复活（单源铁律）');
});
