// test/w8.abortSignal.test.ts
// ΝΩ-8（P1）执法测试：AbortSignal 贯穿执行链 —— 消灭「超时后幽灵动作落地」。
// 背景：withAttemptTimeout 旧实现是 Promise.race+fallback，超时后原 execute promise
// 继续无后果飞行 —— 迟到的真实点击仍会落地（computer-use 的不可逆世界污染）。
// 铁律执法面：
//   1. 慢执行器 + 短超时 ⇒ 归因 timeout-aborted + 执行器收到 abort（探针）
//      + 迟到的成功绝不入账（race 已裁决 —— 幽灵动作的账面消灭）；
//   2. signal 缺席 ⇒ 旧路径（快速值透传 / fallback 字节不变 / 违约捕获 / completed 不变）；
//   3. cancelled 路由铁律：kind='cancelled' 直达 aborted 绝不入重试（既有执法保持）；
//      外部取消的回声（abort 后工位无论归因 timeout/host-error）同样直达 aborted；
//      取消后不再烧下一轮感知/决策（round-top 前移执法）；
//   4. 外部信号组合语义（对齐 httpClient microFetch：已 abort 立即 / 在途 abort 联动）；
//   5. D7PhysicalHostPort：已 abort ⇒ cancelled 立即归因（零 Python spawn）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PipelineOrchestratorImpl } from '../src/orchestration/pipeline.ts';
import { withAttemptTimeout } from '../src/orchestration/pipeline.helpers.ts';
import type {
  DecisionOutput, DecisionStation, ExecutionOrder, ExecutionResult, ExecutionStation,
  IntentPayload, PipelineConfig, VisionStation,
} from '../src/orchestration/contracts.ts';

// ─── 共用 DSL（对齐 epochJ.makeStations 的桩方言）───

function cfg(patch: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    maxDecisionRetries: 3,
    regionGrid: { cols: 2, rows: 2 },
    stationTokenBudgets: { vision: 10, decision: 100, execution: 0 },
    rehearseBeforeExecute: false,
    attemptTimeoutMs: 2000,
    perceptionDeadlineMs: 1000,
    consumePlanReady: false,
    ...patch,
  };
}

function intent(id: string): IntentPayload {
  return { id, goal: 'click the save button', source: 'user' };
}

/** 空场景视觉桩 + noop 决策桩（可挂钩执行桩） */
function stations(execution: ExecutionStation, decisionHook?: (n: number) => DecisionOutput) {
  let decideCalls = 0;
  const vision: VisionStation = { async *perceive() { /* 空场景 */ } };
  const decision: DecisionStation = {
    decide: async () => {
      decideCalls += 1;
      return decisionHook
        ? decisionHook(decideCalls)
        : { kind: 'noop', args: {}, rationale: 'stub' };
    },
  };
  return { vision, decision, execution, decideCalls: () => decideCalls };
}

// ─── 1. 核心执法：慢执行器 + 短超时 ⇒ 止损 ───

test('ΝΩ-8: 慢执行器 + 短超时 ⇒ timeout-aborted + 执行器收到 abort + 迟到成功不入账', async () => {
  const probes: Array<AbortSignal | undefined> = [];
  const execution: ExecutionStation = {
    execute: async (env) => new Promise<ExecutionResult>((resolve) => {
      probes.push(env.payload.signal);
      // 慢执行器：挂起直到止损信号 —— abort 后才交出「迟到的成功」
      //（等价于旧路径里超时后仍会落地的真实点击）
      const s = env.payload.signal;
      if (s) {
        s.addEventListener('abort', () => resolve({
          seq: env.payload.seq, effectDetected: true, latencyMs: 99999, rehearsed: false,
        }), { once: true });
      }
    }),
  };
  const o = new PipelineOrchestratorImpl();
  assert.ok(o.configure(cfg({ attemptTimeoutMs: 60, maxDecisionRetries: 0 })).ok);
  o.wire(stations(execution));
  const report = await o.run(intent('no8-ghost'));

  assert.equal(report.attempts.length, 1, '一次尝试即被止损（不烧第二轮）');
  assert.equal(report.attempts[0].result.failure?.kind, 'timeout-aborted', '止损归因（与被动 race 超时分治）');
  assert.equal(probes.length, 1, '执行器恰被调用一次');
  assert.ok(probes[0] instanceof AbortSignal, '指令单携带止损信号');
  assert.equal(probes[0]!.aborted, true, '探针：执行器收到了 abort');
  assert.equal(report.attempts[0].result.effectDetected, null, '迟到的成功绝不入账（race 已裁决）');
  assert.equal(report.verdict, 'failed', 'timeout-aborted 入重试耗尽路径（杀一刀不杀流水线 —— 非 aborted）');
});

// ─── 2. signal 缺席 ⇒ 旧路径（零回归）───

test('ΝΩ-8: 快速工位 ⇒ 值透传（旧 race 语义字节不变）', async () => {
  const out = await withAttemptTimeout(() => Promise.resolve({ v: 41 }), 5000, { v: 0 });
  assert.deepEqual(out, { v: 41 }, '无超时 ⇒ 真实值透传');
});

test('ΝΩ-8: 工位挂起 + 超时 ⇒ fallback 字节不变（不吃信号的工位 = 旧路径）', async () => {
  const fallback = { kind: 'need-grounding' as const, question: 'decision attempt timeout after 50ms' };
  const out = await withAttemptTimeout(() => new Promise<never>(() => { /* 永挂 */ }), 50, fallback);
  assert.deepEqual(out, fallback, 'fallback 逐字节返回（语义保持）');
});

test('ΝΩ-8: 工位违约（reject / 同步 throw）⇒ fallback 结构化捕获（纵深防御）', async () => {
  const fb = { tag: 'fb' };
  const rejected = await withAttemptTimeout(() => Promise.reject(new Error('breach')), 5000, fb);
  assert.deepEqual(rejected, fb, '异步违约 ⇒ fallback');
  const thrown = await withAttemptTimeout((): Promise<{ tag: string }> => { throw new Error('sync breach'); }, 5000, fb);
  assert.deepEqual(thrown, fb, '同步违约 ⇒ fallback（工厂化的纵深防御增益）');
});

test('ΝΩ-8: run 无 opts.signal ⇒ 行为与旧路径一致（completed / 挂起信号是无害数据）', async () => {
  const execution: ExecutionStation = {
    execute: async (env) => {
      // 指令单现在携带 signal（止损接线），但不吃信号的工位行为零变化
      assert.ok(env.payload.signal instanceof AbortSignal, '信号在场（授权，不是义务）');
      return { seq: env.payload.seq, effectDetected: true, latencyMs: 1, rehearsed: false };
    },
  };
  const o = new PipelineOrchestratorImpl();
  assert.ok(o.configure(cfg()).ok);
  o.wire(stations(execution));
  const report = await o.run(intent('no8-oldpath')); // 无 opts.signal
  assert.equal(report.verdict, 'completed');
  assert.equal(report.attempts.length, 1);
  assert.equal(report.attempts[0].result.effectDetected, true);
});

// ─── 3. cancelled 路由铁律（既有执法保持 + abort 回声扩展）───

test('ΝΩ-8: kind=cancelled 直达 aborted —— 绝不入重试（既有铁律保持）', async () => {
  let calls = 0;
  const execution: ExecutionStation = {
    execute: async (env) => {
      calls += 1;
      return {
        seq: env.payload.seq, effectDetected: null, latencyMs: 1, rehearsed: false,
        failure: { kind: 'cancelled', detail: 'host shutdown' },
      };
    },
  };
  const o = new PipelineOrchestratorImpl();
  assert.ok(o.configure(cfg({ maxDecisionRetries: 3 })).ok);
  o.wire(stations(execution));
  const report = await o.run(intent('no8-cancelled'));
  assert.equal(report.verdict, 'aborted');
  assert.equal(report.attempts.length, 1, '零重试（给已终止的尝试做重规划是无意义烧钱）');
  assert.equal(calls, 1);
});

test('ΝΩ-8: 外部取消的回声 —— abort 后工位归因 host-error 也直达 aborted（不入重试）', async () => {
  const runCtrl = new AbortController();
  const execution: ExecutionStation = {
    execute: async (env) => new Promise<ExecutionResult>((resolve) => {
      const s = env.payload.signal;
      const giveUp = () => resolve({
        seq: env.payload.seq, effectDetected: null, latencyMs: 25, rehearsed: false,
        // 故意误归因：abort 感知的链路常把断流报成 timeout/host-error ——
        // 路由铁律必须越过字面 kind 认出「终止的回声」
        failure: { kind: 'host-error', detail: 'connection dropped (abort echo)' },
      });
      if (s) s.addEventListener('abort', giveUp, { once: true });
      else setTimeout(giveUp, 10);
    }),
  };
  const o = new PipelineOrchestratorImpl();
  assert.ok(o.configure(cfg({ attemptTimeoutMs: 5000 })).ok); // 内层超时不先响 —— 只测外部取消
  const s = stations(execution);
  o.wire(s);
  setTimeout(() => runCtrl.abort(), 20);
  const report = await o.run(intent('no8-echo'), { signal: runCtrl.signal });
  assert.equal(report.verdict, 'aborted', '外部取消 ⇒ aborted（与 kind 字面归因无关）');
  assert.equal(report.attempts.length, 1, '终止的回声不入重试');
  assert.equal(report.attempts[0].result.failure?.kind, 'host-error', 'attempt 记录保持工位原话（诚实入账）');
});

test('ΝΩ-8: 取消后不烧下一轮 —— round-top 前移执法（感知/决策零追加调用）', async () => {
  const runCtrl = new AbortController();
  const execution: ExecutionStation = {
    execute: async (env) => {
      await new Promise((r) => setTimeout(r, 40)); // 第一刀执行中取消到达
      return { seq: env.payload.seq, effectDetected: false, latencyMs: 40, rehearsed: false };
    },
  };
  const o = new PipelineOrchestratorImpl();
  assert.ok(o.configure(cfg({ maxDecisionRetries: 3 })).ok);
  const s = stations(execution);
  o.wire(s);
  setTimeout(() => runCtrl.abort(), 15); // 在第一刀执行期间（40ms 窗口内）取消
  const report = await o.run(intent('no8-roundtop'), { signal: runCtrl.signal });
  assert.equal(report.attempts.length, 1);
  assert.equal(report.verdict, 'aborted', 'effectDetected=false 本应入重试 —— 外部取消优先直达 aborted');
  assert.equal(s.decideCalls(), 1, '取消后决策工位零追加调用（不烧重规划）');
});

// ─── 4. 外部信号组合语义（httpClient microFetch 方言对齐）───

test('ΝΩ-8: 外部在途 abort ⇒ 联动尝试 signal（abort 感知工位快速归宿）', async () => {
  const runCtrl = new AbortController();
  let observed: AbortSignal | undefined;
  const p = withAttemptTimeout((signal) => new Promise<string>((resolve) => {
    observed = signal;
    signal.addEventListener('abort', () => resolve('aborted-fast'), { once: true });
  }), 5000, 'fallback', runCtrl.signal);
  setTimeout(() => runCtrl.abort(), 20);
  assert.equal(await p, 'aborted-fast', 'abort 感知工位自报归宿（abort 是信号不是竞速裁决）');
  assert.equal(observed!.aborted, true, '外部 abort 已联动到尝试 signal');
});

test('ΝΩ-8: 外部信号已 abort（run 前取消）⇒ 工厂即刻看到 aborted', async () => {
  const runCtrl = new AbortController();
  runCtrl.abort();
  let seenAborted = false;
  const out = await withAttemptTimeout((signal) => {
    seenAborted = signal.aborted;
    return Promise.resolve('ok');
  }, 5000, 'fallback', runCtrl.signal);
  assert.equal(out, 'ok');
  assert.equal(seenAborted, true, '已 abort ⇒ 立即触发（不待监听）');
});

test('ΝΩ-8: 超时竞速确定性 —— 直接监听 signal 的工位也输给 fallback（归因恒定）', async () => {
  // 工厂不经 async 包裹、abort 监听器同步 resolve 真实值 —— 旧顺序（先 abort）
  // 会让工位值抢跑 fallback；fallback 先落定 ⇒ 超时归因恒为 fallback
  const out = await withAttemptTimeout((signal) => new Promise<string>((resolve) => {
    signal.addEventListener('abort', () => resolve('ghost-success'), { once: true });
  }), 50, 'fallback');
  assert.equal(out, 'fallback', '超时 ⇒ fallback 恒定（工位迟到归宿被 race 忽略）');
});

// ─── 5. D7PhysicalHostPort：execute 止损入口 ───

test('ΝΩ-8: D7PhysicalHostPort.execute —— 已 abort 信号 ⇒ cancelled 立即归因（零 Python spawn）', async () => {
  const { D7PhysicalHostPort } = await import('../src/physicalExecution/d7HostPort.ts');
  const host = new D7PhysicalHostPort();
  try {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await host.execute(
      { kind: 'noop', args: {}, rationale: 'stop before dispatch' },
      ctrl.signal,
    );
    assert.equal(r.status, 'failure');
    assert.equal(r.failure?.kind, 'cancelled', '取消先于派发 ⇒ cancelled 归因（不入重试的方言）');
    assert.equal(host.initialized, false, '不为已取消的动作懒启动 Python');
  } finally {
    await host.dispose();
  }
});
