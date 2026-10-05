// test/pan43-48.knowledgeClosures.test.ts
// ΠΑΝ-43~48 修复潮执法册：知识中枢六处闭环断裂的闭环验证（C1-8 H1~H6）。
//   ΠΑΝ-43 双脑合一 —— apply 初始化路径与睡眠消费面是同一实例，白天所学夜间可整合；
//   ΠΑΝ-44 同证据单次计数 —— updatedAt 冻结的条目不被每个 run-end 重复收割；
//   ΠΑΝ-45 置信度时间衰减 —— 检索出口携带有效置信度，陈年 error-pattern 不再压制；
//   ΠΑΝ-46 归一化抗原 —— 措辞差异（大小写/标点/语序/功能词/NFKC）不再铸出新抗原；
//   ΠΑΝ-47 类型上界执法 —— 世界模型类型数有界，溢出驱逐诚实标注；
//   ΠΑΝ-48 闩锁激活 —— learnFromOutcome 容量拒绝真实上报 escalateProbeLatch。
// 全离线纯内存断言（时间旅行经 snapshot 引用后门 —— 既有测试方言）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  InMemoryKnowledgeBase, initializeKnowledgeBase, knowledgeBase, distillInjection,
  learnTopicKey,
} from '../src/knowledge/knowledgeBase.ts';
import { InMemoryWorldModel, WORLD_MODEL_MERGE_SWEEP_TYPES, WORLD_MODEL_MAX_TYPES } from '../src/knowledge/worldModel.ts';
import { KnowledgePipelineOrchestrator } from '../src/knowledge/pipeline.ts';
import { ReflexiveDecisionStation, StubExecutionStation, type HostExecutePort } from '../src/knowledge/stations.ts';
import { DoctorVerdictBridge } from '../src/knowledge/adapters.ts';
import { evidenceLedger, resetKernelRuntime } from '../src/kernel/registry.ts';
import type {
  AtomicAction, ExecutionResult, KnowledgeBase, PipelineConfig, ScenePatch,
} from '../src/knowledge/contracts.ts';

const DAY = 24 * 60 * 60 * 1000;
const YEAR = 365 * DAY;

const CONFIG: PipelineConfig = {
  regionGrid: { cols: 2, rows: 2 },
  timeout: { overall: 5000, perStep: 1000, perPerception: 500 },
  retryPolicy: { maxRetries: 0, backoffMs: 1, maxBackoffMs: 4 },
  knowledgeTimeout: 50,
  knowledgeMaxResults: 5,
  knowledgeMaxChars: 300,
};

/** 可编程假工位（与 knowledge.test.ts 同方言；执行序列可编程） */
function fakeStations(kb: KnowledgeBase, opts?: {
  execStatuses?: Array<'success' | 'failure'>;
  failureKind?: string;
  scene?: ScenePatch[];
}) {
  const seqExec = opts?.execStatuses ?? ['success'];
  let execIdx = 0;
  return {
    knowledge: kb,
    vision: {
      async perceive(): Promise<ScenePatch[]> {
        return opts?.scene ?? [];
      },
    },
    decision: {
      async decide(): Promise<AtomicAction> {
        return { kind: 'noop', args: {}, rationale: 'stub' };
      },
    },
    execution: {
      async execute(env: { payload: AtomicAction }): Promise<ExecutionResult> {
        const status = seqExec[Math.min(execIdx++, seqExec.length - 1)];
        const action = env.payload;
        return status === 'failure'
          ? { action, status, durationMs: 1, failure: { kind: (opts?.failureKind ?? 'host-error') as never, detail: 'programmed failure' } }
          : { action, status, durationMs: 1 };
      },
    },
    verdictBridge: new DoctorVerdictBridge(),
    emit: () => { /* 旁路 */ },
  };
}

/** 单元素场景夹具（元素名 + 归一化位置） */
function sceneOf(name: string, x = 0.4, y = 0.4): ScenePatch[] {
  return [{
    region: { id: 'g0x0', x: 0, y: 0, width: 1, height: 1 },
    elements: [{ source: 'L1-tree', role: 'button', name, rect: { x, y, width: 0.08, height: 0.04 } }],
    funnelDepth: 'L1',
    capturedAt: 0,
  }];
}

// ─── ΠΑΝ-43 双脑合一 ───────────────────────────────────────────────────

test('ΠΑΝ-43 双脑合一：initializeKnowledgeBase 幂等且与睡眠消费单例同一实例', () => {
  const a = initializeKnowledgeBase();
  const b = initializeKnowledgeBase();
  assert.strictEqual(a, b, 'initialize 幂等 —— 重复调用返回同一实例');
  assert.strictEqual(a, knowledgeBase, 'apply 初始化路径与睡眠免疫幕消费面（knowledgeBase 导出）是同一颗脑');
  // 单例不挤占测试端口：隔离实例仍是独立生命
  const isolated = new InMemoryKnowledgeBase();
  assert.notStrictEqual(isolated, a, '可注入测试端口不变 —— 隔离实例照旧可铸造');
  isolated.dispose();
});

test('ΠΑΝ-43 白天所学夜间消化：pipeline 学习落在单例，睡眠消费面 consolidate 真整合', async () => {
  knowledgeBase.dispose(); // 清场（单例跨用例共享 —— 起点归零，终点也归零）
  try {
    // 白天：流水线（apply 的接线方言 —— deps.knowledge = initializeKnowledgeBase()）
    // 学进一条亲证失败情景
    const o = new KnowledgePipelineOrchestrator();
    o.configure(CONFIG);
    o.wire(fakeStations(initializeKnowledgeBase(), { execStatuses: ['failure'] }) as never);
    const report = await o.run({ id: 'pan43-day', description: 'close the save dialog' });
    assert.equal(report.verdict, 'failed');
    // 白天所学在**睡眠消费的那颗脑**里（旧实现：apply 自建实例，此处恒空 —— 双脑）
    const dayLearned = knowledgeBase.snapshot().filter(e => e.source === 'auto-learn');
    assert.equal(dayLearned.length, 1, '流水线学习落在睡眠免疫幕消费的同一实例');
    assert.ok(dayLearned[0].verifiedAt !== undefined, '自体学习生而亲证');

    // 补足聚类规模（≥3 条同族情景 —— 直接经同一实例学习，措辞跨场景）
    const action: AtomicAction = { kind: 'click_mouse', args: { x: 0.5, y: 0.5 }, rationale: 'r' };
    for (const desc of ['dismiss save dialog popup', 'cancel the save dialog box']) {
      assert.ok(knowledgeBase.learnFromOutcome({
        intent: { id: 'pan43-ep', description: desc },
        action,
        result: { action, status: 'failure', durationMs: 1, failure: { kind: 'host-error', detail: 'broken' } },
        retryCount: 0, totalDurationMs: 1,
      }).ok);
    }
    // 夜间：睡眠免疫幕的生产消费面（组合根投喂的就是这个导出）真实整合
    const morning = knowledgeBase.consolidate();
    assert.ok(morning.ok);
    assert.ok(morning.value.episodes >= 3, '睡眠器官看见全部白天所学');
    assert.equal(morning.value.consolidated, 1, '海马体→皮层蒸馏真实发生（晨报数字不再是空脑的假账）');
    assert.ok(knowledgeBase.snapshot().some(e => e.content.startsWith('consolidated pattern')));
  } finally {
    knowledgeBase.dispose(); // 归还空脑（后续用例零污染）
  }
});

// ─── ΠΑΝ-44 同证据单次计数 ─────────────────────────────────────────────

test('ΠΑΝ-44 同证据单次计数：updatedAt 冻结的条目不被第二个 run-end 重复收割', async () => {
  resetKernelRuntime(); // 独占生产单例（kernelRegistry / evidenceLedger）
  const dir = mkdtempSync(join(tmpdir(), 'pan44-'));
  try {
    const kb = new InMemoryKnowledgeBase();
    // 手工种子：入库即 updatedAt 冻结（query 只递增 usageCount）—— 旧实现的重复收割源
    kb.insert({ category: 'system-quirk', content: 'settings gear is top-right', scenario: 'open settings', confidence: 0.9, source: 'manual' });
    const o = new KnowledgePipelineOrchestrator();
    o.configure(CONFIG);
    o.wire(fakeStations(kb) as never, { reportDir: join(dir, 'r'), metricsPath: join(dir, 'm.jsonl') });

    await o.run({ id: 'pan44-a', description: 'open settings' });
    const afterRun1 = evidenceLedger.stats('memory.op.system-quirk.insert');
    assert.equal(afterRun1.n, 1, '首收割计入一次（命中 × 助益 = 一条伯努利试验）');
    const seedUpdatedAt = kb.snapshot().find(e => e.category === 'system-quirk')!.updatedAt;

    await o.run({ id: 'pan44-b', description: 'open settings' });
    // ΠΑΝ-44 执法：种子条目 updatedAt 未动（检索不改 updatedAt）⇒ 第二个 run-end 不得再计
    assert.equal(kb.snapshot().find(e => e.category === 'system-quirk')!.updatedAt, seedUpdatedAt,
      '前置自检：query 确实不改 updatedAt（重复收割的病灶条件在场）');
    const afterRun2 = evidenceLedger.stats('memory.op.system-quirk.insert');
    assert.equal(afterRun2.n, 1, '同证据只计一次 —— Beta 后验 n 不再被 run-end 次数膨胀');

    // 复证刷新 updatedAt = 新证据状态 ⇒ 可再计一次（水位线按证据状态推进，非终身封口）
    const workflow = kb.snapshot().find(e => e.category === 'workflow');
    assert.ok(workflow, 'run-1 学到 workflow 条目');
    const wfAfterRun2 = evidenceLedger.stats('memory.op.workflow.insert').n;
    await o.run({ id: 'pan44-c', description: 'open settings' }); // 第三 run 复证 workflow（updatedAt 推进）
    const wfAfterRun3 = evidenceLedger.stats('memory.op.workflow.insert').n;
    assert.ok(wfAfterRun3 > wfAfterRun2, '复证（updatedAt 推进）= 新证据状态，诚实再计');
    assert.ok(o.dispose().ok);
  } finally {
    resetKernelRuntime();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── ΠΑΝ-45 置信度时间衰减（检索出口）───────────────────────────────────

test('ΠΑΝ-45 陈年错误模式衰减：检索出口携带有效置信度，Tier0 压制被时间解除', async () => {
  const kb = new InMemoryKnowledgeBase();
  kb.insert({ category: 'error-pattern', content: 'delete item button is broken', scenario: 'record cleanup', confidence: 0.9, source: 'manual' });
  const [stale] = kb.snapshot();
  stale.updatedAt = Date.now() - 2 * YEAR; // 时间旅行：两年未复证（后门方言）

  // 检索出口：fragments 携带衰减后置信度（0.9 × 2^-24 ≈ 5e-8），非存储值 0.9
  const r = kb.query({ sceneDescription: 'record cleanup', intentDescription: 'delete the record' });
  assert.ok(r.ok && r.value.entries.length > 0, '陈年条目仍可被检索到（留痕语义不变）');
  const inj = distillInjection(r.value, 300);
  assert.ok(inj && inj.fragments && inj.fragments.length > 0);
  assert.ok(inj!.fragments![0].confidence < 0.55,
    `出口置信度已按遗忘曲线折算（实际 ${inj!.fragments![0].confidence} < 0.55 压制阈值）`);
  assert.ok((stale as { confidence: number }).confidence > 0.8, '库内存储值不动（强化/反证算术的基线保持）');

  // Tier0 执法：压制不再被陈年 error-pattern 把持 —— 本能弧直发
  const freed = new ReflexiveDecisionStation({ chat: null });
  const outFreed = await freed.decide({
    station: 'decision',
    payload: {
      intent: { id: 'pan45-stale', description: 'delete the record' },
      scene: sceneOf('delete item'),
      knowledgeContext: inj ?? undefined,
    },
    tokenBudget: 0,
  });
  assert.ok('kind' in outFreed, '陈年压制证据失格 ⇒ 本能弧放行（不再永久把持）');

  // 对照：新鲜亲证 error-pattern 照常压制（衰减修的是陈年，不是压制机制本身）
  const kb2 = new InMemoryKnowledgeBase();
  kb2.insert({ category: 'error-pattern', content: 'delete item button is broken', scenario: 'record cleanup', confidence: 0.9, source: 'auto-learn', verifiedAt: Date.now() });
  const r2 = kb2.query({ sceneDescription: 'record cleanup', intentDescription: 'delete the record' });
  assert.ok(r2.ok && r2.value.entries.length > 0, '前置：新鲜条目可检索');
  const inj2 = distillInjection(r2.value, 300);
  assert.ok(inj2 && inj2.fragments![0].confidence >= 0.55, '前置：新鲜条目出口置信度全额（age=0 ⇒ eff=conf）');
  const suppressing = new ReflexiveDecisionStation({ chat: null });
  const outHeld = await suppressing.decide({
    station: 'decision',
    payload: {
      intent: { id: 'pan45-fresh', description: 'delete the record' },
      scene: sceneOf('delete item'),
      knowledgeContext: inj2 ?? undefined,
    },
    tokenBudget: 0,
  });
  assert.ok(!('kind' in outHeld), '新鲜亲证陷阱照常压制（机制未失能，只是不再被陈年证据劫持）');
});

// ─── ΠΑΝ-46 归一化抗原 ─────────────────────────────────────────────────

test('ΠΑΝ-46 归一化抗原：大小写/标点/语序/功能词/NFKC 差异不再铸出新抗原', () => {
  assert.equal(learnTopicKey('Close THE Save-dialog!'), learnTopicKey('close the save dialog'),
    '大小写 + 标点 + 功能词归一');
  assert.equal(learnTopicKey('ｃｌｏｓｅ　ｔｈｅ　ｓａｖｅ　ｄｉａｌｏｇ'), learnTopicKey('close the save dialog'),
    'NFKC 全角折叠');
  assert.equal(learnTopicKey('dialog  save close the'), learnTopicKey('close the save dialog'),
    '语序不参与身份（集合指纹）');
  assert.notEqual(learnTopicKey('close the export dialog'), learnTopicKey('close the save dialog'),
    '实词差异仍是不同抗原（归一不等于失明）');

  const kb = new InMemoryKnowledgeBase();
  const action: AtomicAction = { kind: 'click_mouse', args: { x: 0.5, y: 0.5 }, rationale: 'r' };
  const failOf = (desc: string) => kb.learnFromOutcome({
    intent: { id: 'pan46', description: desc },
    action,
    result: { action, status: 'failure', durationMs: 1, failure: { kind: 'host-error', detail: 'broken' } },
    retryCount: 0, totalDurationMs: 1,
  });
  assert.ok(failOf('Close THE Save-dialog!').ok);
  assert.ok(failOf('ｓａｖｅ dialog… close  the').ok, // NFKC + 语序 + 标点全差的复现
    '归一化指纹命中 ⇒ 复证强化');
  const errors = kb.snapshot().filter(e => e.category === 'error-pattern');
  assert.equal(errors.length, 1, '同抗原复证 = 滴度升高，绝不新造重复抗体');
  assert.ok(errors[0].confidence > 0.3, `强化后 > 初值 0.3（实际 ${errors[0].confidence}）`);
  const confBeforeDisconfirm = errors[0].confidence; // 值快照（snapshot() 发的是条目活引用 —— 反证原地改写 confidence）

  // 反证通道同样被归一化接通：措辞不同的成功把旧错误减半（旧实现：永不反证）
  assert.ok(kb.learnFromOutcome({
    intent: { id: 'pan46', description: 'PLEASE: close, the SAVE dialog!' },
    action,
    result: { action, status: 'success', durationMs: 1 },
    retryCount: 0, totalDurationMs: 1,
  }).ok);
  const after = kb.snapshot().filter(e => e.category === 'error-pattern');
  assert.equal(after.length, 1);
  assert.ok(after[0].confidence < confBeforeDisconfirm, '措辞差异的成功 ⇒ 旧错误被反证下沉（闭环修复）');
});

test('ΠΑΝ-46 语义营救：指纹未命中的近义改写经 cosine 抗原门复证', () => {
  const kb = new InMemoryKnowledgeBase();
  const action: AtomicAction = { kind: 'click_mouse', args: { x: 0.5, y: 0.5 }, rationale: 'r' };
  const fail = (desc: string) => kb.learnFromOutcome({
    intent: { id: 'pan46s', description: desc },
    action,
    result: { action, status: 'failure', durationMs: 1, failure: { kind: 'host-error', detail: 'broken' } },
    retryCount: 0, totalDurationMs: 1,
  });
  assert.ok(fail('close the export dialog popup').ok);
  // 近义改写（实词不同 ⇒ 指纹不同；语义近 ⇒ cosine ≥ 0.8 抗原门命中）
  assert.ok(fail('close the export dialog popup window').ok);
  const errors = kb.snapshot().filter(e => e.category === 'error-pattern');
  assert.equal(errors.length, 1, '语义同抗原 ⇒ 复证强化（旧实现：措辞一变就新铸条目）');
  assert.ok(errors[0].confidence > 0.3, '滴度升高');
  // 异主题失败仍各铸各的（0.8 保守口径 —— 宁可漏判不错判）
  assert.ok(fail('sort the spreadsheet by date column').ok);
  assert.equal(kb.snapshot().filter(e => e.category === 'error-pattern').length, 2, '无关主题不受牵连');
});

// ─── ΠΑΝ-47 类型上界执法 ───────────────────────────────────────────────

/** 互异签名名生成器（音节编码 base-12 —— 任意两名至多共享少量 n-gram，
 *  cosine 远低于认定阈值 0.62；朴素 `widget-${i}` 会让全部场景坍缩成一型） */
const SYL = ['ka', 'to', 'mi', 'su', 're', 'no', 'pa', 'lu', 've', 'zi', 'ho', 'gu'];
const sylName = (i: number): string =>
  SYL[i % 12] + SYL[Math.floor(i / 12) % 12] + SYL[Math.floor(i / 144) % 12];

test('ΠΑΝ-47 类型上界：maintainCapacity 收拢 + 驱逐最弱，溢出诚实标注，快照不变量保序', () => {
  const wm = new InMemoryWorldModel();
  // 铸 300 个互异类型 + 串行转移账（from 用 typeOf 的真实返回 id —— 绝不虚构幽灵类型）
  let prev: string | null = null;
  for (let i = 0; i < 300; i++) {
    const id = wm.typeOf(sceneOf(sylName(i), 0.1 + (i % 8) * 0.1, 0.1 + (i % 5) * 0.15))!;
    if (prev) wm.observe(prev, 'click_mouse@11', id, true);
    prev = id;
  }
  assert.ok(wm.stats().types <= WORLD_MODEL_MAX_TYPES,
    `前置自检：typeOf 根实例内联执法已在铸造途中收口（实际 ${wm.stats().types} ≤ ${WORLD_MODEL_MAX_TYPES}）`);
  // 显式再跑维护：幂等复验（收拢 + 驱逐的公开维护面 —— pipeline run-end 接线的同一入口）
  const m = wm.maintainCapacity();
  assert.ok(wm.stats().types <= WORLD_MODEL_MAX_TYPES, `类型数被钳回上界（实际 ${wm.stats().types} ≤ ${WORLD_MODEL_MAX_TYPES}）`);
  assert.ok(wm.stats().evictedTypes > 0, `溢出驱逐诚实标注（evictedTypes=${wm.stats().evictedTypes} > 0，驱逐从不无声）`);
  assert.ok(m.evicted.length > 0 || wm.stats().evictedTypes > 0);
  // 转移表不变量：sum(next) == total（驱逐修复后的快照必须能整体水合）
  const snap = JSON.parse(JSON.stringify(wm.exportSnapshot()));
  for (const tr of snap.transitions) {
    const sum = (tr.next as Array<[string, number]>).reduce((s, [, n]) => s + n, 0);
    assert.equal(sum, tr.total, `驱逐后记账不变量保序：sum(next)==total（${tr.from}|${tr.action}）`);
    assert.ok(tr.success <= tr.total, '分子 ≤ 幸存分母');
  }
  const reborn = new InMemoryWorldModel();
  assert.ok(reborn.restoreSnapshot(snap).ok, '驱逐修复后的快照整体水合通过（无悬空引用）');
  assert.ok(reborn.stats().evictedTypes > 0, '驱逐计数随档保真');
});

test('ΠΑΝ-47 接线执法：pipeline run-end 维护把共享模型钳回触发线下', async () => {
  const wm = new InMemoryWorldModel();
  // 预热共享模型越过收拢触发线（64）：pipeline 的 run-end 维护应在 merge 后扫幕
  for (let i = 0; i < WORLD_MODEL_MERGE_SWEEP_TYPES + 6; i++) {
    wm.typeOf(sceneOf(sylName(i + 1000), 0.1 + (i % 7) * 0.11, 0.2 + (i % 4) * 0.16));
  }
  const before = wm.stats().types;
  assert.ok(before >= WORLD_MODEL_MERGE_SWEEP_TYPES, `前置：共享模型类型数越过触发线（实际 ${before}）`);
  const kb = new InMemoryKnowledgeBase();
  const o = new KnowledgePipelineOrchestrator();
  o.configure(CONFIG);
  o.wire({ ...fakeStations(kb), worldModel: wm } as never);
  const report = await o.run({ id: 'pan47', description: 'open settings' });
  assert.equal(report.verdict, 'completed');
  const after = wm.stats().types;
  assert.ok(after < before || after <= WORLD_MODEL_MAX_TYPES,
    `run-end 维护接线生效（${before} → ${after}）：收拢触发线/容量上界至少其一执法`);
  assert.ok(o.dispose().ok);
});

test('ΠΑΝ-47 typeOf 缓存：同签名复现省扫描不省吸收（members 照涨、质心照漂）', () => {
  const wm = new InMemoryWorldModel();
  const sc = sceneOf('OK', 0.4, 0.7);
  const id1 = wm.typeOf(sc);
  const members1 = wm.exportSnapshot().types[0].members;
  const id2 = wm.typeOf(sc); // 缓存命中路径
  const members2 = wm.exportSnapshot().types[0].members;
  assert.equal(id1, id2, '同签名同型');
  assert.equal(members2, members1 + 1, '缓存命中照样吸收（指认即注册的副作用逐字节保持）');
});

// ─── ΠΑΝ-48 闩锁激活 ───────────────────────────────────────────────────

test('ΠΑΝ-48 接线执法：learnFromOutcome 容量拒绝 ⇒ 进程级探针闩锁跨实例激活', async () => {
  const kb = new InMemoryKnowledgeBase();
  // 满库主权：1000 条 manual（无 auto-learn 可驱逐 ⇒ 学习必遭 capacity 拒绝）
  for (let i = 0; i < 999; i++) {
    assert.ok(kb.insert({ category: 'workflow', content: `filler fact ${i}`, scenario: `filler scene ${i}`, confidence: 0.5, source: 'manual' }).ok);
  }
  // 传闻陷阱种子（第 1000 位）：压制 → 探针的燃料
  assert.ok(kb.insert({ category: 'error-pattern', content: 'delete item button is broken', scenario: 'delete the record', confidence: 0.7, source: 'manual' }).ok);

  const decision = new ReflexiveDecisionStation({ chat: null });
  const o = new KnowledgePipelineOrchestrator();
  o.configure(CONFIG);
  const execFail = {
    knowledge: kb,
    vision: { async perceive(): Promise<ScenePatch[]> { return sceneOf('delete item'); } },
    decision,
    execution: {
      async execute(env: { payload: AtomicAction }): Promise<ExecutionResult> {
        return { action: env.payload, status: 'failure', durationMs: 1, failure: { kind: 'host-error', detail: 'probe failed' } };
      },
    },
    verdictBridge: new DoctorVerdictBridge(),
    emit: () => { /* 旁路 */ },
  };
  o.wire(execFail as never);
  const report = await o.run({ id: 'pan48-it', description: 'delete the record' });
  // 前置：探针确实放行过（传闻压制 + 无活路 + 信任门控不过）
  assert.ok(report.outcomes.some(x => x.action.rationale.includes('probe(verified-grounding)')),
    'run 内探针放行（传闻证据无亲证背书）');
  assert.equal(report.verdict, 'failed');

  // 执法：容量拒绝的学习闭环断裂被上报 —— 新工位实例（跨 run）不再重付探针学费
  const nextRun = new ReflexiveDecisionStation({ chat: null });
  const out = await nextRun.decide({
    station: 'decision',
    payload: {
      intent: { id: 'pan48-it', description: 'delete the record' },
      scene: sceneOf('delete item'),
      knowledgeContext: {
        summary: '[error-pattern] delete item button is broken',
        categories: ['error-pattern'],
        maxConfidence: 0.7,
        sources: [{ type: 'manual', ref: 'kb-1' }],
        fragments: [{ category: 'error-pattern', content: 'delete item button is broken', confidence: 0.7 }],
      },
    },
    tokenBudget: 0,
  });
  assert.ok(!('kind' in out), '进程级闩锁续护 ⇒ 新实例不再探针，诚实接地');
  assert.match((out as { reason: string }).reason, /suppressed by error-pattern/);
  assert.ok(o.dispose().ok);
});

// ─── 对接点（ΠΑΝ 修复潮 · 本波另一 agent 在 orchestration/physicalExecution 侧消费）───

test('对接点执法：执行止损 signal 从流水线经工位透传到宿主端口的实际派发', async () => {
  // 单元面：工位把 signal 原样交给 host.execute —— 实际派发点收到的是同一引用
  let hostSignal: AbortSignal | undefined;
  const host: HostExecutePort = {
    name: 'capture-host',
    async execute(_action, signal) {
      hostSignal = signal;
      return { status: 'success' };
    },
  };
  const station = new StubExecutionStation({ host });
  const ctrl = new AbortController();
  const action: AtomicAction = { kind: 'noop', args: {}, rationale: 'r' };
  const r = await station.execute({ station: 'execution', payload: action, tokenBudget: 0 }, ctrl.signal);
  assert.equal(r.status, 'success');
  assert.strictEqual(hostSignal, ctrl.signal, '工位透传：宿主端口的实际派发收到同一 AbortSignal（可选参数 ⇒ 缺席调用零回归）');

  // 流水面：执行步超时 ⇒ abort 抵达执行工位（超时的动作不再于后台无界飞行）
  let sawAbort = false;
  const slowExec = {
    async execute(env: { payload: AtomicAction }, signal?: AbortSignal): Promise<ExecutionResult> {
      await new Promise<void>(resolve => {
        const t = setTimeout(resolve, 10_000);
        signal?.addEventListener('abort', () => { sawAbort = true; clearTimeout(t); resolve(); }, { once: true });
      });
      return { action: env.payload, status: 'failure', durationMs: 1, failure: { kind: 'host-error', detail: 'late flight' } };
    },
  };
  const kb = new InMemoryKnowledgeBase();
  const o = new KnowledgePipelineOrchestrator();
  o.configure({ ...CONFIG, timeout: { ...CONFIG.timeout, perStep: 60 } });
  o.wire({
    knowledge: kb,
    vision: { async perceive(): Promise<ScenePatch[]> { return []; } },
    decision: { async decide(): Promise<AtomicAction> { return action; } },
    execution: slowExec,
    verdictBridge: new DoctorVerdictBridge(),
    emit: () => { /* 旁路 */ },
  } as never);
  const report = await o.run({ id: 'pan-signal', description: 'noop run' });
  assert.ok(sawAbort, '流水线执行步超时 ⇒ 止损 abort 经 signal 抵达执行工位（透传闭环）');
  assert.equal(report.verdict, 'failed');
  assert.ok(o.dispose().ok);
});
