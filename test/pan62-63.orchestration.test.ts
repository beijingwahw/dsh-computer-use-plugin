// test/pan62-63.orchestration.test.ts
// ΠΑΝ 修复潮执法测试（orchestration 面）：
//   ΠΑΝ-62：L3 证据位阶合并 —— 批准重扫的 L3 补丁存活到决策工位
//     （旧缺陷：批准区被标脏后下一轮 L2 重扫覆写 L3 补丁，决策永远看不到
//      花钱买的答案 ⇒ 再次 need-grounding ⇒ 烧完熔断预算只交付账单）；
//   ΠΑΝ-63：烧钱循环修复 —— 决策预算耗尽的强制 need-grounding 不带 region
//     ⇒ 拒绝新批准（不再 3 轮 × 全网格 L3 重扫无人消费）；
//   ΠΑΝ-67：dirtyRegions 用后清除 —— 疑脏标记被感知消费后清空（多步任务
//     不再退化为「每轮全量重扫」）；
//   ΠΑΝ-64：DefaultExecutionStation 接收并传播 ExecutionOrder.signal 到
//     HostExecutor（止损链接线执法）；pipeline 级：attempt 超时 ⇒ 宿主收到 abort。
// 全离线确定性：脚本化工位，零网络零 Python。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PipelineOrchestratorImpl } from '../src/orchestration/pipeline.ts';
import { DefaultExecutionStation, type HostExecutor } from '../src/orchestration/stations.ts';
import type {
  DecisionOutput, DecisionStation, ExecutionResult, ExecutionStation, IntentPayload,
  PerceptionRequest, PipelineConfig, ScenePatch, VisionStation, AttentionEnvelope,
} from '../src/orchestration/contracts.ts';

// ─── 共用 DSL（对齐 w8.no26 / w8.abortSignal 的桩方言）───

function cfg(patch: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    maxDecisionRetries: 3,
    regionGrid: { cols: 2, rows: 2 },
    stationTokenBudgets: { vision: 2000, decision: 8000, execution: 0 },
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

interface VisionRequestLog {
  regions: string[];
  ceiling: string;
  l3Reason?: string;
}

/** 漏斗感知桩：ceiling='L3' ⇒ 产出付费语义证据（paid-*），否则廉价 L1 证据（cheap-*） */
function funnelVision(requests: VisionRequestLog[]): VisionStation {
  return {
    async *perceive(env: AttentionEnvelope<'vision', PerceptionRequest>): AsyncIterable<ScenePatch> {
      const l3 = env.payload.funnelCeiling === 'L3';
      requests.push({
        regions: env.payload.regions.map(r => r.id),
        ceiling: env.payload.funnelCeiling,
        ...(env.payload.l3Reason !== undefined ? { l3Reason: env.payload.l3Reason } : {}),
      });
      for (const region of env.payload.regions) {
        yield {
          region,
          elements: [{
            source: l3 ? 'L3-vlm' : 'L1-tree', role: 'button',
            name: l3 ? `paid-${region.id}` : `cheap-${region.id}`,
            rect: { x: region.x + 0.01, y: region.y + 0.01, width: 0.05, height: 0.05 },
          }],
          funnelDepth: l3 ? 'L3' : 'L1',
          capturedAt: Date.now(),
        };
      }
    },
  };
}

function scriptedDecision(script: DecisionOutput[], scenes: Array<ReadonlyArray<ScenePatch>>): DecisionStation {
  let i = 0;
  return {
    decide: async (env) => {
      scenes.push(env.payload.scene);
      return script[Math.min(i++, script.length - 1)]!;
    },
  };
}

function scriptedExecution(effects: Array<boolean | null>): ExecutionStation {
  const rest = [...effects];
  return {
    execute: async (env): Promise<ExecutionResult> => ({
      seq: env.payload.seq,
      effectDetected: rest.length > 0 ? rest.shift()! : true,
      latencyMs: 1, rehearsed: false,
    }),
  };
}

// ─── ΠΑΝ-62：L3 补丁存活到决策工位 ───

test('ΠΑΝ-62: 批准重扫的 L3 证据不被下轮 L2 重扫覆写 —— 决策工位看到花钱买的答案', async () => {
  const requests: VisionRequestLog[] = [];
  const scenes: Array<ReadonlyArray<ScenePatch>> = [];
  const o = new PipelineOrchestratorImpl();
  assert.ok(o.configure(cfg()).ok);
  o.wire({
    vision: funnelVision(requests),
    decision: scriptedDecision([
      { kind: 'need-grounding', regionId: 'g0x0', question: 'where is the save button?' },
      { kind: 'click_mouse', args: { x: 0.25, y: 0.25 }, rationale: 'click save (from L3 evidence)' },
    ], scenes),
    execution: scriptedExecution([true]),
  });
  const report = await o.run(intent('pan62-l3-survival'));
  assert.equal(report.verdict, 'completed', 'L3 证据被消费后照常完成');

  // 请求轨迹：① 首轮全网格 L2 → ② 批准区内联 L3 重扫（带 l3Reason）→
  // ③ 下轮 g0x0 的 L2 重扫确实发生了（批准区被标脏）—— 修复不靠跳过重扫，
  // 而靠证据位阶：L3 补丁在合并中胜出。
  assert.equal(requests.length, 3, '恰三次感知请求');
  assert.deepEqual(requests[0]!.regions, ['g0x0', 'g0x1', 'g1x0', 'g1x1']);
  assert.equal(requests[0]!.ceiling, 'L2');
  assert.deepEqual(requests[1]!.regions, ['g0x0']);
  assert.equal(requests[1]!.ceiling, 'L3', '批准重扫以 L3 顶棚执行');
  assert.match(requests[1]!.l3Reason ?? '', /where is the save button\?/, '授权依据随单下发');
  assert.deepEqual(requests[2]!.regions, ['g0x0']);
  assert.equal(requests[2]!.ceiling, 'L2', '下轮重扫确实发生（脏区标记在岗）');

  // 核心执法：决策第二轮看到的 g0x0 补丁 = L3 付费证据（旧缺陷：被 L2 覆写）
  const scene2 = scenes[1]!;
  assert.equal(scene2.length, 4, '决策视野仍是完整 4 分区');
  const g0x0 = scene2.find(p => p.region.id === 'g0x0')!;
  assert.equal(g0x0.funnelDepth, 'L3', 'g0x0 补丁漏斗深度 = L3（未被 L2 重扫覆写）');
  assert.equal(g0x0.elements[0]!.name, 'paid-g0x0', '决策看到的是花钱买的语义答案');
  assert.equal(g0x0.elements[0]!.source, 'L3-vlm', '溯源标签如实（L3-vlm）');
  // 其余分区照常廉价证据（位阶提升不扩散）
  for (const id of ['g0x1', 'g1x0', 'g1x1']) {
    assert.equal(scene2.find(p => p.region.id === id)!.funnelDepth, 'L1', `${id} 不受位阶影响`);
  }
});

test('ΠΑΝ-62: L3 证据时效窗外 —— 世界的新鲜 L1/L2 如实接管（位阶不是永久特权）', async () => {
  // 10s 时效窗用真实时钟等待不可行 —— 视觉桩把内联 L3 补丁的 capturedAt
  // 回拨 11s（伪造「付费证据已老」）：下轮合并时已过时效 ⇒ 新鲜 L1 采纳。
  // capturedAt 是补丁自申报的数据年龄，回拨即合法的老证据形态。
  const requests: VisionRequestLog[] = [];
  const scenes: Array<ReadonlyArray<ScenePatch>> = [];
  const vision: VisionStation = {
    async *perceive(env: AttentionEnvelope<'vision', PerceptionRequest>): AsyncIterable<ScenePatch> {
      const l3 = env.payload.funnelCeiling === 'L3';
      requests.push({
        regions: env.payload.regions.map(r => r.id),
        ceiling: env.payload.funnelCeiling,
      });
      for (const region of env.payload.regions) {
        yield {
          region,
          elements: [{
            source: l3 ? 'L3-vlm' : 'L1-tree', role: 'button',
            name: l3 ? `paid-${region.id}` : `cheap-${region.id}`,
            rect: { x: region.x + 0.01, y: region.y + 0.01, width: 0.05, height: 0.05 },
          }],
          funnelDepth: l3 ? 'L3' : 'L1',
          // L3 证据声明为 11s 前（超过 L3_EVIDENCE_TTL_MS=10s ⇒ 时效已过）
          capturedAt: l3 ? Date.now() - 11_000 : Date.now(),
        };
      }
    },
  };
  const o = new PipelineOrchestratorImpl();
  assert.ok(o.configure(cfg()).ok);
  o.wire({
    vision,
    decision: scriptedDecision([
      { kind: 'need-grounding', regionId: 'g0x0', question: 'where is save?' },
      { kind: 'click_mouse', args: { x: 0.25, y: 0.25 }, rationale: 'r' },
    ], scenes),
    execution: scriptedExecution([true]),
  });
  const report = await o.run(intent('pan62-l3-expired'));
  assert.equal(report.verdict, 'completed');
  const g0x0 = scenes[1]!.find(p => p.region.id === 'g0x0')!;
  assert.equal(g0x0.funnelDepth, 'L1', '时效已过的 L3 证据被新鲜 L1 接管（世界的新鲜度优先）');
  assert.equal(g0x0.elements[0]!.name, 'cheap-g0x0');
});

// ─── ΠΑΝ-63：熔断后不再批准（烧钱循环修复）───

test('ΠΑΝ-63: 决策预算耗尽的强制 need-grounding 无 region ⇒ 拒绝新批准直达 escalated（不再 3 轮全网格 L3）', async () => {
  let decideCalls = 0;
  let decisionUsed = 0;
  const requests: VisionRequestLog[] = [];
  const o = new PipelineOrchestratorImpl();
  assert.ok(o.configure(cfg({ stationTokenBudgets: { vision: 2000, decision: 100, execution: 0 } })).ok);
  o.wire({
    vision: funnelVision(requests),
    decision: {
      decide: async (): Promise<DecisionOutput> => {
        decideCalls += 1;
        decisionUsed += 5000; // 工位自报：一轮烧掉 50 倍预算
        // 整屏语义不足（无 regionId）—— 真实决策工位的合法请求形态
        return { kind: 'need-grounding', question: 'whole screen semantics insufficient' };
      },
    },
    execution: scriptedExecution([true]),
    usageMeter: { decision: () => decisionUsed },
  });
  const report = await o.run(intent('pan63-burn-guard'));
  assert.equal(decideCalls, 1, '首轮全额授予；自报后余额归零 ⇒ 此后零调用');
  assert.equal(report.verdict, 'escalated', '预算耗尽 + 无 region ⇒ 直接诚实上交（非谎称失败）');
  assert.match(report.terminalReason, /grounding budget exhausted|escalated/, '终局归因诚实');
  assert.equal(report.attempts.length, 0);
  // 核心执法：恰一次 L3 批准（首轮真实请求）；旧缺陷：强制降级也走全网格批准
  // ⇒ 3 轮 × 4 区 = 12 次 VLM grounding 全部无人消费。
  const l3Approvals = requests.filter(r => r.ceiling === 'L3');
  assert.equal(l3Approvals.length, 1, 'L3 顶棚请求恰一次（真实请求获批，强制降级不再获批）');
  assert.equal(l3Approvals[0]!.regions.length, 4, '首轮获批全网格（整屏语义不足的合法裁决）');
});

// ─── ΠΑΝ-67：dirtyRegions 用后清除 ───

test('ΠΑΝ-67: 脏区标记被感知消费后清除 —— 历史落区不再每轮重扫', async () => {
  const requests: VisionRequestLog[] = [];
  const o = new PipelineOrchestratorImpl();
  assert.ok(o.configure(cfg({ maxDecisionRetries: 3 })).ok);
  o.wire({
    vision: funnelVision(requests),
    decision: scriptedDecision([
      { kind: 'click_mouse', args: { x: 0.75, y: 0.75 }, rationale: 'r1' }, // 落区 g1x1
      { kind: 'click_mouse', args: { x: 0.25, y: 0.25 }, rationale: 'r2' }, // 落区 g0x0
    ], []),
    // effectDetected=null ⇒ 重试反馈（不入终局），四轮耗尽重试预算后 degraded
    execution: scriptedExecution([null, null, null, null]),
  });
  const report = await o.run(intent('pan67-dirty-clear'));
  assert.equal(report.verdict, 'degraded', '验证层缺席的诚实降级终局');
  assert.equal(requests.length, 4, '四轮各一次感知请求（第 4 轮熔断）');
  assert.deepEqual(requests[0]!.regions, ['g0x0', 'g0x1', 'g1x0', 'g1x1'], '首轮 = 全屏网格');
  assert.deepEqual(requests[1]!.regions, ['g1x1'], '次轮 = 仅动作 1 落区');
  // 核心执法：第三轮只重扫动作 2 落区 g0x0 —— g1x1 的疑脏已被次轮感知消费清除
  //（旧缺陷：dirtyRegions 永不清 ⇒ 第三轮请求 ['g0x0','g1x1']，多步任务退化为全量重扫）
  assert.deepEqual(requests[2]!.regions, ['g0x0'], '历史落区疑脏已清除（只扫新落区）');
});

// ─── ΠΑΝ-64：执行工位接收并传播 AbortSignal ───

test('ΠΑΝ-64: DefaultExecutionStation 接收 ExecutionOrder.signal 并传播给 HostExecutor', async () => {
  const seen: Array<AbortSignal | undefined> = [];
  const host: HostExecutor = {
    execute: async (action, signal) => {
      seen.push(signal);
      return { effectDetected: true, latencyMs: 1 };
    },
  };
  const station = new DefaultExecutionStation({ sandbox: null, host, rehearseBeforeExecute: false });
  const ctrl = new AbortController();
  const result = await station.execute({
    station: 'execution',
    payload: { seq: 7, intentRef: 'i-pan64', action: { kind: 'click_mouse', args: { x: 0.5, y: 0.5 } }, signal: ctrl.signal },
    tokenBudget: 0,
  });
  assert.equal(result.effectDetected, true);
  assert.equal(seen.length, 1, '宿主执行通道恰被调用一次');
  assert.equal(seen[0], ctrl.signal, '宿主收到的是指令单上的同一 signal 实例（旧缺陷：解构丢弃）');
  // signal 缺席 ⇒ 旧路径（宿主收到 undefined，零行为变化）
  await station.execute({
    station: 'execution',
    payload: { seq: 8, intentRef: 'i-pan64', action: { kind: 'noop', args: {} } },
    tokenBudget: 0,
  });
  assert.equal(seen[1], undefined, 'signal 缺席 ⇒ 旧路径逐字节保持');
});

test('ΠΑΝ-64: pipeline 级止损链 —— attempt 超时 ⇒ DefaultExecutionStation 下发的 signal 在宿主侧 abort', async () => {
  const seen: Array<AbortSignal | undefined> = [];
  const host: HostExecutor = {
    execute: (action, signal) => new Promise((resolve) => {
      seen.push(signal);
      // 挂起宿主：仅响应止损信号（等价于在途 HTTP 断流）
      if (signal) {
        signal.addEventListener('abort', () => resolve({
          effectDetected: null,
          latencyMs: 99999,
          failure: { kind: 'cancelled', detail: 'in-flight abort reached host transport' },
        }), { once: true });
      }
    }),
  };
  const vision: VisionStation = { async *perceive() { /* 空场景 */ } };
  const decision: DecisionStation = {
    decide: async () => ({ kind: 'click_mouse', args: { x: 0.25, y: 0.25 }, rationale: 'r' }),
  };
  const o = new PipelineOrchestratorImpl();
  assert.ok(o.configure(cfg({ attemptTimeoutMs: 60, maxDecisionRetries: 0 })).ok);
  o.wire({
    vision,
    decision,
    execution: new DefaultExecutionStation({ sandbox: null, host, rehearseBeforeExecute: false }),
  });
  const report = await o.run(intent('pan64-pipeline-chain'));
  assert.equal(seen.length, 1, '宿主恰被调用一次');
  assert.ok(seen[0] instanceof AbortSignal, '止损信号到达宿主（全链贯通）');
  assert.equal(seen[0]!.aborted, true, 'attempt 超时 ⇒ 信号已 abort（在途动作断流，非无后果飞行）');
  assert.equal(report.attempts[0].result.failure?.kind, 'timeout-aborted', 'fallback 归因恒定（止损型超时）');
  assert.equal(report.verdict, 'failed', 'timeout-aborted 入重试耗尽路径（杀一刀不杀流水线）');
});
