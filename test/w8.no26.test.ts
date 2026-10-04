// test/w8.no26.test.ts
// ΝΩ-26（编排调度四修）执法测试 —— 四修各自的回归锁：
//   ① L1 帧缓存：一次全屏 a11y 提取多区共享（提取/尺寸查询计数），TTL 过期诚实刷新；
//   ② 脏区跳过：动作落区重扫、未动分区零请求；dhash 未变 ⇒ 复用旧补丁
//      （对象同一性 = 复用证据，capturedAt 申报陈旧度），内容已变 ⇒ 采纳新补丁；
//   ③ L3 帧共享：全网格 4 区 grounding 共享 1 次截屏（capture 计数 1），
//      VLM 问询仍逐区一次（帧缓存合并不吞并语义问询）；
//   ④ tokenBudget 扣减制：决策余额耗尽 ⇒ 工位不被调用 + need-grounding 降级注记
//      + 零预算授予；视觉余额耗尽 ⇒ L3 批准降格 L2 重扫（降级注记入链）；
//   ⑤ reconcile 内联：盘上报告 verdict 已含 D-4 否决（报告一次成稿 ——
//      旧序 persistReport 先写盘、reconcile 后改内存 ⇒ 盘上停旧）。
// 全离线确定性：假 provider / 假 GLM client / 逻辑桩，零网络。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { default as sharp } from 'sharp';
import { PipelineOrchestratorImpl } from '../src/orchestration/pipeline.ts';
import { gridRegions } from '../src/orchestration/pipeline.helpers.ts';
import { createStructuredFromUiExtractor, createSemanticFromVlm } from '../src/orchestration/visionAdapters.ts';
import { setAccessibilityProvider } from '../src/uiExtractor.ts';
import { kernelRegistry } from '../src/kernel/registry.ts';
import { resetVerifyGateBudget } from '../src/vlm/grounding.ts';
import type { GlmClient } from '../src/vlm/glmClient.ts';
import type {
  DecisionOutput, DecisionStation, ExecutionOrder, ExecutionResult, ExecutionStation,
  IntentPayload, PerceptionRequest, PipelineConfig, ScenePatch, VisionStation,
  AttentionEnvelope,
} from '../src/orchestration/contracts.ts';

// ─── 共用 DSL（对齐 w8.abortSignal 的桩方言）───

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

// ─── ① L1 帧缓存（适配器面：提取计数 / 尺寸查询计数 / TTL 刷新 / 负缓存）───

/** 假无障碍树：A 按钮中心落左上区（g0x0），B 按钮中心落右下区（g1x1）—— 像素系 800×600 */
function no26A11yTree(): unknown {
  return {
    rect: { x: 0, y: 0, width: 800, height: 600 }, role: 'root', name: 'root', children: [
      { rect: { x: 10, y: 10, width: 50, height: 40 }, role: 'Button', name: '甲按钮', children: [] },
      { rect: { x: 500, y: 400, width: 60, height: 45 }, role: 'Button', name: '乙按钮', children: [] },
    ],
  };
}

test('ΝΩ-26①: L1 适配器 TTL 帧缓存 —— 4 分区一次提取（尺寸查询 1 次），TTL 过期刷新 + 故障负缓存', async () => {
  let providerCalls = 0;
  let sizeCalls = 0;
  let sizeThrows = false;
  setAccessibilityProvider(async () => {
    providerCalls += 1;
    return no26A11yTree();
  });
  try {
    const src = createStructuredFromUiExtractor({
      screenSize: async () => {
        sizeCalls += 1;
        if (sizeThrows) throw new Error('screen size port exploded');
        return { width: 800, height: 600 };
      },
      cacheTtlMs: 80, // 测试压缩窗口（缺省 1500 —— 与 L2 OCR 缓存同源）
    });
    const regions = gridRegions({ cols: 2, rows: 2 }); // [g0x0, g0x1, g1x0, g1x1]
    const perRegion = await Promise.all(regions.map(r => src.extract(r)));
    // 2×2 网格一次全屏提取多区过滤（旧实现：每区各一次提取 + 各一次尺寸查询）
    assert.equal(sizeCalls, 1, '帧缓存命中：尺寸查询 1 次（旧实现 4 次 —— 每区重复查询)');
    assert.ok(providerCalls >= 1, 'provider 被调用过（提取真实发生）');
    // 中心落区分派不因缓存漂移：甲 → g0x0，乙 → g1x1
    assert.equal(perRegion[0]!.length, 1);
    assert.equal(perRegion[0]![0]!.name, '甲按钮');
    assert.equal(perRegion[3]!.length, 1);
    assert.equal(perRegion[3]![0]!.name, '乙按钮');
    assert.deepEqual(perRegion[1]!.map(e => e.name), [], '右上区真空（诚实空集）');
    // 全屏口径（region 缺省）同帧共享，不触发第二次提取
    const full1 = await src.extract();
    assert.equal(sizeCalls, 1, '全屏口径复用同一帧');
    assert.equal(full1.length, 2, '全屏 = 两元素');
    // TTL 过期 ⇒ 诚实刷新（缓存不是永久占位符）
    await new Promise(r => setTimeout(r, 90));
    await src.extract(regions[0]!);
    assert.equal(sizeCalls, 2, '窗口过期 ⇒ 重新取帧（有界缓存）');
    // 故障负缓存：尺寸口故障 ⇒ 向上抛（J 纪元契约保持）；同窗内不重复打故障口
    sizeThrows = true;
    await new Promise(r => setTimeout(r, 90)); // 先让旧帧过期
    await assert.rejects(() => src.extract(regions[0]!), /screen size port exploded/);
    await assert.rejects(() => src.extract(regions[1]!), /screen size port exploded/);
    assert.equal(sizeCalls, 3, '负缓存命中：第二次故障不重打尺寸口（只多 1 次调用）');
  } finally {
    setAccessibilityProvider(null as never); // 还原全局 provider，不泄漏给后续用例
  }
});

// ─── ② 脏区跳过（管线面：请求裁剪 + dhash 复用/采纳）───

/** 记录型视觉桩：逐区产出补丁；contentFor 可按轮次变内容（脏区采纳断言的原料） */
interface VisionRequestLog {
  regions: string[];
  ceiling: string;
  budget: number;
  l3Reason?: string;
}

function recordingVision(
  requests: VisionRequestLog[],
  contentFor?: (call: number, regionId: string) => string,
): VisionStation {
  let call = 0;
  return {
    async *perceive(env: AttentionEnvelope<'vision', PerceptionRequest>): AsyncIterable<ScenePatch> {
      const n = call;
      call += 1;
      const log: VisionRequestLog = {
        regions: env.payload.regions.map(r => r.id),
        ceiling: env.payload.funnelCeiling,
        budget: env.tokenBudget,
      };
      if (env.payload.l3Reason !== undefined) log.l3Reason = env.payload.l3Reason;
      requests.push(log);
      for (const region of env.payload.regions) {
        const name = contentFor ? contentFor(n, region.id) : `el-${region.id}`;
        yield {
          region,
          elements: [{
            source: 'L1-tree', role: 'button', name,
            rect: { x: region.x + 0.01, y: region.y + 0.01, width: 0.05, height: 0.05 },
          }],
          funnelDepth: 'L1',
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

test('ΝΩ-26②a: 脏区跳过 —— 动作落区重扫，未动分区零请求；dhash 未变 ⇒ 复用旧补丁（capturedAt 不谎报新鲜）', async () => {
  const requests: VisionRequestLog[] = [];
  const scenes: Array<ReadonlyArray<ScenePatch>> = [];
  const o = new PipelineOrchestratorImpl();
  assert.ok(o.configure(cfg({ maxDecisionRetries: 3 })).ok);
  o.wire({
    vision: recordingVision(requests),
    decision: scriptedDecision([
      { kind: 'click_mouse', args: { x: 0.75, y: 0.75 }, rationale: 'r1' }, // 落区 g1x1
      { kind: 'click_mouse', args: { x: 0.75, y: 0.75 }, rationale: 'r2' },
    ], scenes),
    execution: scriptedExecution([false, true]), // 第一刀世界回击 ⇒ 重试
  });
  const report = await o.run(intent('no26-dirty-a'));
  assert.equal(report.verdict, 'completed', '两刀完成（重试路径走通）');
  // 首轮全网格；次轮只重扫落区 g1x1（其余分区复用 ⇒ 零请求零提取）
  assert.equal(requests.length, 2, '视觉恰被调用两次（两轮各一次）');
  assert.deepEqual(requests[0]!.regions, ['g0x0', 'g0x1', 'g1x0', 'g1x1'], '首轮 = 全屏网格');
  assert.deepEqual(requests[1]!.regions, ['g1x1'], '次轮 = 仅动作落区（未动分区跳过）');
  // dhash 复用：次轮重扫的 g1x1 内容未变 ⇒ 决策拿到的是**旧补丁对象**
  //（同一性 === 即复用证据；capturedAt 停在首轮 —— 陈旧度如实申报）
  const scene1 = scenes[0]!, scene2 = scenes[1]!;
  assert.equal(scene2.length, 4, '次轮场景仍是完整 4 分区（复用补丁在场）');
  const g1x1R1 = scene1.find(p => p.region.id === 'g1x1')!;
  const g1x1R2 = scene2.find(p => p.region.id === 'g1x1')!;
  assert.ok(g1x1R1 === g1x1R2, 'dhash 未变 ⇒ 复用旧补丁（对象同一性）');
  for (const id of ['g0x0', 'g0x1', 'g1x0']) {
    assert.ok(scene1.find(p => p.region.id === id) === scene2.find(p => p.region.id === id),
      `未动分区 ${id} 复用旧补丁（零重扫）`);
  }
});

test('ΝΩ-26②b: 落区内容已变 ⇒ dhash 不同 ⇒ 采纳新补丁（新对象 + 新内容）', async () => {
  const requests: VisionRequestLog[] = [];
  const scenes: Array<ReadonlyArray<ScenePatch>> = [];
  const o = new PipelineOrchestratorImpl();
  assert.ok(o.configure(cfg({ maxDecisionRetries: 3 })).ok);
  o.wire({
    // 第二次感知起，g1x1 的元素名变化（世界真的动了）
    vision: recordingVision(requests, (call, regionId) =>
      call >= 1 && regionId === 'g1x1' ? 'el-g1x1-v2' : `el-${regionId}`),
    decision: scriptedDecision([
      { kind: 'click_mouse', args: { x: 0.75, y: 0.75 }, rationale: 'r1' },
      { kind: 'click_mouse', args: { x: 0.75, y: 0.75 }, rationale: 'r2' },
    ], scenes),
    execution: scriptedExecution([false, true]),
  });
  const report = await o.run(intent('no26-dirty-b'));
  assert.equal(report.verdict, 'completed');
  assert.deepEqual(requests[1]!.regions, ['g1x1'], '落区重扫');
  const g1x1R1 = scenes[0]!.find(p => p.region.id === 'g1x1')!;
  const g1x1R2 = scenes[1]!.find(p => p.region.id === 'g1x1')!;
  assert.ok(g1x1R1 !== g1x1R2, '内容已变 ⇒ 新补丁对象（不复用旧补丁）');
  assert.equal(g1x1R2.elements[0]!.name, 'el-g1x1-v2', '新内容入场景');
  // 未动分区照常复用（与 ②a 同律 —— 脏区判定不扩散）
  assert.ok(scenes[0]!.find(p => p.region.id === 'g0x0') === scenes[1]!.find(p => p.region.id === 'g0x0'));
});

// ─── ③ L3 帧共享（适配器面：capture 计数）───

/** chatJson 假 client（w8.organwiring 同款方言）：记录全部请求 */
function fakeVlm(value: () => unknown): { client: GlmClient; calls: any[] } {
  const calls: any[] = [];
  const client = {
    configured: true,
    chatJson: async (req: any) => {
      calls.push(req);
      return { ok: true, value: value(), raw: '' };
    },
    chat: async () => ({ ok: true, text: '' }),
  } as unknown as GlmClient;
  return { client, calls };
}

test('ΝΩ-26③: L3 帧缓存 —— 全网格 4 区 grounding 共享 1 次截屏；VLM 问询仍逐区一次；TTL 过期重新取帧', async () => {
  const png = await sharp(Buffer.alloc(200 * 150 * 3, 128), { raw: { width: 200, height: 150, channels: 3 } })
    .png().toBuffer();
  let captures = 0;
  const fake = fakeVlm(() => ({
    elements: [{ id: 'x1', label: '设置', role: 'button', bbox: [100, 50, 300, 150], confidence: 0.9 }],
  }));
  const src = createSemanticFromVlm({
    capture: async () => {
      captures += 1;
      return png;
    },
    screenSize: async () => ({ width: 200, height: 150 }),
    client: fake.client,
    frameCacheTtlMs: 80, // 测试压缩窗口（缺省 1500 —— 与 L1/L2 同 TTL）
  });
  const regions = gridRegions({ cols: 2, rows: 2 });
  // 批准全网格的 L3 重扫形态：4 区依次 ground（管线 for-await 逐区同律）
  for (const r of regions) await src.ground(r, '打开设置');
  assert.equal(captures, 1, '4 区共享 1 次截屏（旧实现 4 次 —— 同一帧拍 4 遍）');
  assert.equal(fake.calls.length, 4, 'VLM 问询仍逐区一次（帧缓存只合帧，不吞并语义问询）');
  // 元素面照常：中心 (200,100)px → 归一化 (1.0, 0.667) → 落 g1x1 区
  const els = await src.ground(regions[3]!, '打开设置');
  assert.equal(els.length, 1, 'g1x1 区产出该元素（同帧复用不损结果）');
  assert.equal(els[0]!.name, '设置');
  // TTL 过期 ⇒ 重新取帧（有界缓存）
  await new Promise(r => setTimeout(r, 90));
  await src.ground(regions[0]!, '打开设置');
  assert.equal(captures, 2, '窗口过期 ⇒ 重新截屏');
});

// ─── ④ tokenBudget 扣减制（预算耗尽强制降级）───

test('ΝΩ-26④a: 决策自报消耗回扣余额 —— 首轮后余额归零 ⇒ 工位不再被调用 + need-grounding 降级注记 + 零追加授予 + escalated 终局', async () => {
  // 扣减制方言：探针是**累计读数**，余额 = 预算 − 本 run 自报增量 —— 工位首轮
  // 自报消耗 5000（≥ 预算 100）⇒ 次轮起余额恒 0，决策工位被预算制拦下。
  let decideCalls = 0;
  let decisionUsed = 0;
  const requests: VisionRequestLog[] = [];
  const scenes: Array<ReadonlyArray<ScenePatch>> = [];
  const o = new PipelineOrchestratorImpl();
  assert.ok(o.configure(cfg({ stationTokenBudgets: { vision: 2000, decision: 100, execution: 0 } })).ok);
  o.wire({
    vision: recordingVision(requests),
    decision: {
      decide: async (): Promise<DecisionOutput> => {
        decideCalls += 1;
        decisionUsed += 5000; // 工位自报：一轮烧掉 50 倍预算
        return { kind: 'need-grounding', regionId: 'g0x0', question: 'where is save?' };
      },
    },
    execution: scriptedExecution([true]),
    usageMeter: { decision: () => decisionUsed },
  });
  const report = await o.run(intent('no26-budget-decision'));
  assert.equal(decideCalls, 1, '首轮全额授予（余额未知不猜测）；自报后余额归零 ⇒ 此后零调用');
  assert.equal(report.verdict, 'escalated', '强制 need-grounding 走批准预算熔断 ⇒ 诚实上交（非谎称失败）');
  assert.match(report.terminalReason, /grounding budget exhausted/, '终局归因诚实');
  assert.equal(report.tokenBudgetsGranted.decision, 100, '只授予过首轮的 100（此后余额 0 = 零授予）');
  assert.equal(report.attempts.length, 0);
});

test('ΝΩ-26④b: 视觉自报消耗回扣余额 —— 余额归零 ⇒ L3 批准降格 L2 重扫（ceiling/l3Reason 注记诚实）+ 信封预算归零', async () => {
  const requests: VisionRequestLog[] = [];
  const scenes: Array<ReadonlyArray<ScenePatch>> = [];
  let visionUsed = 0;
  const o = new PipelineOrchestratorImpl();
  assert.ok(o.configure(cfg()).ok);
  o.wire({
    // 首轮感知时工位自报消耗 9999（≥ 预算 2000）⇒ 批准裁决时余额已归零
    vision: {
      async *perceive(env: AttentionEnvelope<'vision', PerceptionRequest>): AsyncIterable<ScenePatch> {
        if (requests.length === 0) visionUsed += 9999;
        yield* recordingVision(requests).perceive(env);
      },
    },
    decision: scriptedDecision([
      { kind: 'need-grounding', regionId: 'g0x0', question: 'where is save?' },
      { kind: 'click_mouse', args: { x: 0.25, y: 0.25 }, rationale: 'save' },
    ], scenes),
    execution: scriptedExecution([true]),
    usageMeter: { vision: () => visionUsed },
  });
  const report = await o.run(intent('no26-budget-vision'));
  assert.equal(report.verdict, 'completed', 'L2 重扫后照常完成（降级不阻断）');
  const rescan = requests.find(r => r.l3Reason !== undefined)!;
  assert.equal(rescan.ceiling, 'L2', 'L3 批准降格 L2（vision 降 L1/L2 —— 本地肌肉层）');
  assert.match(rescan.l3Reason!, /degraded: vision token budget exhausted/, '降格注记随授权依据入链');
  assert.ok(requests.slice(1).every(r => r.budget === 0), '扣减制：自报后视觉信封预算全部归零');
  assert.equal(report.tokenBudgetsGranted.vision, 2000, '只授予过首轮 2000（此后余额 0 = 零授予）');
});

// ─── ⑤ reconcile 内联（盘上/内存同一副面孔）───

test('ΝΩ-26⑤: reconcile 内联于落盘之前 —— 盘上报告 verdict 已含 D-4 rejected（一次成稿）', async () => {
  const { reconcileVerdicts } = await import('../src/orchestration/index.ts');
  const dir = mkdtempSync(join(tmpdir(), 'no26-report-'));
  const scenes: Array<ReadonlyArray<ScenePatch>> = [];
  const execution: ExecutionStation = {
    execute: async (env): Promise<ExecutionResult> => ({
      seq: env.payload.seq, effectDetected: true, latencyMs: 1, rehearsed: false,
      rehearsalChainId: `chain-exec-${env.payload.intentRef}-${env.payload.seq}`,
    }),
  };
  const o = new PipelineOrchestratorImpl();
  assert.ok(o.configure(cfg()).ok);
  // 判决索引：末次尝试被 D-4 否决（rejected）—— 旧序下这个否决只改内存，盘上停旧
  const verdictIndex = new Map([
    ['chain-exec-i-no26-5-1', {
      subject: 'chain-exec-i-no26-5-1', chainTip: 'tip-1', verdict: 'rejected', score: 40,
      rationale: 'genesis violated',
    } as never],
  ]);
  o.wire(
    {
      vision: recordingVision([]),
      decision: scriptedDecision([{ kind: 'click_mouse', args: { x: 0.25, y: 0.25 }, rationale: 'r' }], scenes),
      execution,
    },
    {
      reportDir: dir,
      reconcileReport: (report) => reconcileVerdicts(report, verdictIndex),
    },
  );
  try {
    const report = await o.run(intent('i-no26-5'));
    assert.equal(report.verdict, 'rejected', '内存报告被 D-4 否决权改写');
    assert.notEqual(report.reportPath, 'in-memory');
    const onDisk = JSON.parse(readFileSync(report.reportPath, 'utf8'));
    assert.equal(onDisk.verdict, 'rejected', '盘上 verdict 已更新（旧序：先落盘后 reconcile ⇒ 盘上停旧）');
    assert.match(onDisk.terminalReason, /rejected by D-4 doctor verdict/, '盘上终局归因同刻');
    assert.equal(onDisk.attempts[0].doctorVerdict.verdict, 'rejected', '盘上尝试轨迹含判决补写');
    assert.equal(onDisk.intentId, 'i-no26-5', '盘上审计锚（intentId）保持');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 内核键测试自管（w8.organwiring 同款先例：隔离复核流量，VLM 调用数可断言）───

before(() => {
  kernelRegistry.register({
    key: 'grounding.verifyZoom', organ: 'perception', defaultValue: 1, min: 0, max: 1,
    note: 'ΝΩ-26 测试注册（隔离 Zoom 复核流量）',
  });
  kernelRegistry.set('grounding.verifyZoom', 0);
  resetVerifyGateBudget();
});

after(() => {
  kernelRegistry.set('grounding.verifyZoom', 1);
  resetVerifyGateBudget();
});
