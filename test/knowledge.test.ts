// test/knowledge.test.ts
// D-7 隐知识中枢回归测试：验收修复项三律 + 防卡顿铁律 + 闭环进化 + 异常诚实。
// 每个用例对应 D-7 规范中的一条铁律 —— 防其借尸还魂。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryKnowledgeBase, distillInjection, trustOf,
} from '../src/knowledge/knowledgeBase.ts';
import {
  StubVisionStation, StubDecisionStation, StubExecutionStation,
} from '../src/knowledge/stations.ts';
import { KnowledgePipelineOrchestrator } from '../src/knowledge/pipeline.ts';
import { DoctorVerdictBridge } from '../src/knowledge/adapters.ts';
import { makeScore } from '../src/doctorEvents.ts';
import {
  emitKnowledgeAttempt, emitKnowledgeRunEnd,
} from '../src/knowledge/events.ts';
import type {
  AtomicAction, ExecutionOutcome, ExecutionResult, KnowledgeBase, KnowledgeEntry,
  KnowledgeResult, PipelineConfig, Result,
} from '../src/knowledge/contracts.ts';

// ─── 验收修复项 #1：契约层四类型在场（编译期执法；此处运行期烟测再导出完整性）───

test('D-7 contracts: 纯契约文件零运行时泄漏（类型层执法由 tsc 承担）', async () => {
  const contracts = await import('../src/knowledge/contracts.ts');
  assert.equal(Object.keys(contracts).length, 0); // 全部 export type —— strip 后空模块
  // 类型导入可用性由本文件的类型注解覆盖（tsc --noEmit 执法）
});

// ─── 验收修复项 #3：AttentionEnvelope 强制使用（三工位签名已被信封包裹）───

test('D-7 stations: 信封是工位唯一入参形态（桩实现直收信封）', async () => {
  const vision = new StubVisionStation({ source: null });
  // 桩纪元：无真机源 ⇒ 全分区 fault 补丁（诚实降级，非空数据伪装）
  const patches = await vision.perceive({
    station: 'vision', payload: { grid: { cols: 2, rows: 2 } }, tokenBudget: 0,
  });
  assert.equal(patches.length, 4); // 2x2 网格分区铸造
  assert.ok(patches.every(p => p.funnelDepth === 'empty' && p.fault));

  const decision = new StubDecisionStation({ chat: null });
  const ng = await decision.decide({
    station: 'decision',
    payload: { intent: { id: 'i1', description: 'open settings' }, scene: patches },
    tokenBudget: 2000,
  });
  // 桩纪元：无大模型通道 ⇒ NeedGrounding 诚实回退（D-7 方言：reason/focus）
  assert.equal(typeof (ng as any).reason, 'string');
  assert.equal(typeof (ng as any).focus, 'string');

  const execution = new StubExecutionStation({ host: null });
  const action: AtomicAction = { kind: 'noop', args: {}, rationale: 'test' };
  const result = await execution.execute({ station: 'execution', payload: action, tokenBudget: 0 });
  // 桩纪元：无宿主执行通道 ⇒ host-error 结构化失败，绝不伪造 success
  assert.equal(result.status, 'failure');
  assert.equal(result.failure?.kind, 'host-error');
  assert.equal(result.action.kind, 'noop'); // action 内联回显（D-7 方言）
});

// ─── 隐知识行为引擎：四大核心动作异常诚实 ───

test('D-7 knowledgeBase: insert 域外拒绝（域执法，不 clamp）', () => {
  const kb = new InMemoryKnowledgeBase();
  const bad = kb.insert({ category: 'not-a-category' as any, content: 'x', scenario: 's', confidence: 0.5, source: 'manual' });
  assert.ok(!bad.ok);
  assert.equal(bad.error.field, 'category');

  const oob = kb.insert({ category: 'shortcut', content: 'x', scenario: 's', confidence: 1.5, source: 'manual' });
  assert.ok(!oob.ok);
  assert.equal(oob.error.field, 'confidence'); // 150 分是 bug，clamp 会掩埋它

  const empty = kb.insert({ category: 'shortcut', content: '   ', scenario: 's', confidence: 0.5, source: 'manual' });
  assert.ok(!empty.ok);
  assert.equal(empty.error.field, 'content');

  const ok = kb.insert({ category: 'shortcut', content: 'Ctrl+Shift+T reopens closed tab', scenario: 'browser tab management', confidence: 0.9, source: 'manual' });
  assert.ok(ok.ok && typeof ok.value === 'string');
});

test('D-7 knowledgeBase: content ≤500 铸造点截断 + query keyword 命中 + usageCount 簿记', () => {
  const kb = new InMemoryKnowledgeBase();
  kb.insert({ category: 'ui-pattern', content: 'A'.repeat(600), scenario: 'overflow test', confidence: 0.5, source: 'manual' });
  const snap = kb.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].content.length, 500); // 结构保证，不靠下游自觉

  const r = kb.query({ sceneDescription: '', intentDescription: 'overflow test please' });
  assert.ok(r.ok);
  assert.equal(r.value.entries.length, 1);
  assert.equal(r.value.strategy, 'hybrid'); // 免疫纪元：keyword + 语义双通道
  assert.equal(r.value.entries[0].usageCount, 1); // 检索即使用

  const miss = kb.query({ sceneDescription: 'unrelated', intentDescription: 'different domain entirely' });
  assert.ok(miss.ok);
  assert.equal(miss.value.entries.length, 0); // 语义地板执法：n-gram 噪声不误命中
});

test('D-7 knowledgeBase: learnFromOutcome 双蒸馏（failure→error-pattern / success→workflow）', () => {
  const kb = new InMemoryKnowledgeBase();
  const intent = { id: 'i-learn', description: 'open the portal' };
  const action: AtomicAction = { kind: 'click_mouse', args: { x: 0.5, y: 0.5 }, rationale: 'r' };
  const failResult: ExecutionResult = {
    action, status: 'failure', durationMs: 10,
    failure: { kind: 'host-error', detail: 'element not found' },
  };
  assert.ok(kb.learnFromOutcome({ intent, action, result: failResult, retryCount: 1, totalDurationMs: 100 }).ok);
  assert.ok(kb.learnFromOutcome({ intent, action, result: { action, status: 'success', durationMs: 5 }, retryCount: 0, totalDurationMs: 100 }).ok);

  const snap = kb.snapshot();
  assert.equal(snap.filter(e => e.category === 'error-pattern').length, 1);
  assert.equal(snap.filter(e => e.category === 'workflow').length, 1);
  assert.ok(snap.every(e => e.source === 'auto-learn' && e.intentRef === 'i-learn'));

  const malformed = kb.learnFromOutcome({} as ExecutionOutcome);
  assert.ok(!malformed.ok); // 异常诚实：垃圾输入结构化拒绝，不 throw

  assert.ok(kb.dispose().ok);
  assert.equal(kb.snapshot().length, 0); // 归零：零残留
});

test('D-7 distillInjection: 摘要 ≤300 硬预算 + import 不进 sources', () => {
  const mk = (i: number, source: 'manual' | 'auto-learn' | 'import'): KnowledgeResult['entries'][number] => ({
    id: `e${i}`, category: 'shortcut', content: `knowledge fragment number ${i} `.repeat(10),
    scenario: 's', confidence: 0.5 + i * 0.1, source, updatedAt: 0, usageCount: 0,
  });
  const injection = distillInjection({ entries: [mk(1, 'manual'), mk(2, 'import'), mk(3, 'auto-learn')], latencyMs: 1, strategy: 'keyword' }, 300);
  assert.ok(injection);
  assert.ok(injection.summary.length <= 300); // Token 纪律的结构保证
  assert.equal(injection.maxConfidence, 0.8);
  assert.equal(injection.sources.length, 2); // import 是只读档案，不进注入溯源
  assert.ok(injection.sources.every(s => s.type !== ('import' as any)));
  assert.equal(distillInjection({ entries: [], latencyMs: 0, strategy: 'keyword' }, 300), null);
});

// ─── 验收修复项 #2：configure 异常诚实（Result 降级，严禁 throw）───

const VALID_CONFIG: PipelineConfig = {
  regionGrid: { cols: 2, rows: 2 },
  timeout: { overall: 5000, perStep: 1000, perPerception: 500 },
  retryPolicy: { maxRetries: 2, backoffMs: 1, maxBackoffMs: 4 },
  knowledgeTimeout: 50,
  knowledgeMaxResults: 5,
  knowledgeMaxChars: 300,
};

test('D-7 orchestrator: configure 永不 throw —— 域外值返回 ConfigError（field 精确定位）', () => {
  const o = new KnowledgePipelineOrchestrator();
  const cases: Array<[Partial<PipelineConfig>, string]> = [
    [{ timeout: { overall: -1, perStep: 1, perPerception: 1 } as any, retryPolicy: VALID_CONFIG.retryPolicy, knowledgeTimeout: 50, knowledgeMaxResults: 5, knowledgeMaxChars: 300 }, 'timeout.overall'],
    [{ timeout: VALID_CONFIG.timeout, retryPolicy: { maxRetries: -1, backoffMs: 1, maxBackoffMs: 2 } as any, knowledgeTimeout: 50, knowledgeMaxResults: 5, knowledgeMaxChars: 300 }, 'retryPolicy.maxRetries'],
    [{ timeout: VALID_CONFIG.timeout, retryPolicy: VALID_CONFIG.retryPolicy, knowledgeTimeout: 0, knowledgeMaxResults: 5, knowledgeMaxChars: 300 }, 'knowledgeTimeout'],
    [{ timeout: VALID_CONFIG.timeout, retryPolicy: VALID_CONFIG.retryPolicy, knowledgeTimeout: 50, knowledgeMaxResults: 5, knowledgeMaxChars: 500 }, 'knowledgeMaxChars'],
    [null as any, 'config'],
  ];
  for (const [cfg, field] of cases) {
    const r: Result<void, any> = o.configure(cfg as PipelineConfig);
    assert.ok(!r.ok, `${field} should be rejected`);
    assert.equal(r.error.field, field);
  }
  const ok = o.configure(VALID_CONFIG);
  assert.ok(ok.ok); // 合法配置原样通过
});

// ─── 流水线数据流三段论 + 闭环进化 ───

/** 可编程假工位（信封直收 —— 验收修复项 #3 的消费侧证明；
 *  verdictSubject ⇒ 判决桥预载该 subject 的 D-4 回执 —— P0-4 验收结算门） */
function fakeStations(kb: KnowledgeBase, opts?: {
  execStatuses?: Array<'success' | 'failure' | 'degraded'>;
  failureKind?: string;
  onDecision?: (payload: any) => void;
  verdictSubject?: string;
}) {
  const seqExec: Array<'success' | 'failure' | 'degraded'> = opts?.execStatuses ?? ['success'];
  let execIdx = 0;
  const verdictBridge = new DoctorVerdictBridge();
  if (opts?.verdictSubject) {
    verdictBridge.ingest({
      subject: opts.verdictSubject,
      chainTip: 'test-tip',
      verdict: 'approved',
      score: makeScore(90)!,
    });
  }
  return {
    knowledge: kb,
    vision: {
      async perceive(_env: any): Promise<never[]> {
        return []; // 空场景（桩纪元常态 —— 决策据此产出 noop 兜底动作）
      },
    },
    decision: {
      async decide(env: any) {
        opts?.onDecision?.(env.payload);
        const action: AtomicAction = { kind: 'noop', args: {}, rationale: 'stub' };
        return action;
      },
    },
    execution: {
      async execute(env: any) {
        const status = seqExec[Math.min(execIdx++, seqExec.length - 1)];
        const action: AtomicAction = env.payload;
        const result: ExecutionResult = status === 'failure'
          ? { action, status, durationMs: 1, failure: { kind: (opts?.failureKind ?? 'host-error') as any, detail: 'programmed failure' } }
          : { action, status, durationMs: 1 };
        return result;
      },
    },
    verdictBridge,
    emit: (_ev: string, _p: object) => { /* 旁路 */ },
  };
}

test('D-7 pipeline: 未接线 ⇒ 结构化 failed 报告（run 永不 throw）', async () => {
  const o = new KnowledgePipelineOrchestrator();
  o.configure(VALID_CONFIG);
  const report = await o.run({ id: 'i-1', description: 'open settings' });
  assert.equal(report.verdict, 'failed');
  assert.equal(report.terminalReason, 'orchestrator not configured/wired');
  assert.equal(report.reportPath, 'in-memory'); // 无 reportDir ⇒ 句柄降级
});

test('D-7 pipeline: 全链路 —— 并行检索注入决策 + D-4 回执 + 闭环学习 + 落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'd7-knowledge-'));
  try {
    const kb = new InMemoryKnowledgeBase();
    kb.insert({ category: 'system-quirk', content: 'settings gear is top-right', scenario: 'open settings', confidence: 0.9, source: 'manual' });
    let decisionPayload: any = null;
    const o = new KnowledgePipelineOrchestrator();
    o.configure(VALID_CONFIG);
    o.wire(fakeStations(kb, { onDecision: p => { decisionPayload = p; }, verdictSubject: 'i-2:1' }) as any, { reportDir: dir });

    const report = await o.run({ id: 'i-2', description: 'open settings' });
    // 数据流 #3：视觉+隐知识 → 决策 → 动作 → 执行 → 验收
    assert.equal(report.verdict, 'completed');
    assert.equal(report.outcomes.length, 1);
    // 隐知识注入在场（Knowledge-First 铁律）
    assert.ok(report.knowledgeUsed);
    assert.ok(report.knowledgeUsed!.summary.length <= 300);
    assert.equal(decisionPayload.knowledgeContext?.summary, report.knowledgeUsed!.summary);
    // D-4 回执桥（subject=`${intentId}:${seq}` → approved 0.9）
    assert.deepEqual(report.outcomes[0].doctorVerdict, { status: 'approved', confidence: 0.9 });
    // 数据流 #4：闭环进化 —— outcome 已蒸馏为 auto-learn 条目
    assert.equal(kb.snapshot().filter(e => e.source === 'auto-learn').length, 1);
    // 落盘句柄真实存在
    assert.notEqual(report.reportPath, 'in-memory');
    assert.ok(existsSync(report.reportPath));
    // dispose Result 降级
    assert.ok(o.dispose().ok);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D-7 pipeline: 失败重试路由 —— 重试耗尽 ⇒ failed（outcomes 保留全粒度轨迹）', async () => {
  const kb = new InMemoryKnowledgeBase();
  const o = new KnowledgePipelineOrchestrator();
  o.configure(VALID_CONFIG);
  o.wire(fakeStations(kb, { execStatuses: ['failure'], failureKind: 'host-error' as any }) as any);
  const report = await o.run({ id: 'i-3', description: 'open settings' });
  assert.equal(report.verdict, 'failed');
  assert.equal(report.outcomes.length, VALID_CONFIG.retryPolicy.maxRetries + 1); // 1 + 2 重试
  assert.ok(report.terminalReason.includes('retries exhausted'));
  // P0-4 验收门：无 D-4 回执 ⇒ 三笔 outcome 全部挂账 pending，run-end 冲账结算后
  // 逐笔学习。免疫纪元：同场景同失败结论 ⇒ 复证合并为单条强化 error-pattern
  // （抗体滴度升高而非新造抗体 ×3 —— 学习不因沉默而缺席，库不因重复而膨胀）
  const errors = kb.snapshot().filter(e => e.category === 'error-pattern');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].confidence > 0.3, '三次复证 ⇒ 置信度高于单次初值 0.3');
});

test('D-7 pipeline: cancelled 直达 aborted —— 绝不入重试循环', async () => {
  const kb = new InMemoryKnowledgeBase();
  const o = new KnowledgePipelineOrchestrator();
  o.configure(VALID_CONFIG);
  o.wire(fakeStations(kb, { execStatuses: ['failure'], failureKind: 'cancelled' as any }) as any);
  const report = await o.run({ id: 'i-4', description: 'open settings' });
  assert.equal(report.verdict, 'aborted');
  assert.equal(report.outcomes.length, 1); // 零重试（给已终止的尝试重规划是无意义烧钱）
});

test('D-7 pipeline: 防卡顿铁律 —— 检索越 50ms ⇒ 无隐知识模式降级', async () => {
  /** 同步阻塞型 KB（60ms 墙钟）：race 无法抢占事件循环 —— 事后墙钟守卫执法 */
  class SlowKnowledgeBase extends InMemoryKnowledgeBase {
    query(q: any): Result<KnowledgeResult, any> {
      const t0 = Date.now();
      while (Date.now() - t0 < 60) { /* busy-wait：模拟慢检索 */ }
      return super.query(q);
    }
  }
  const kb = new SlowKnowledgeBase();
  kb.insert({ category: 'shortcut', content: 'slow but relevant knowledge', scenario: 'open settings', confidence: 0.9, source: 'manual' });
  let decisionPayload: any = null;
  const o = new KnowledgePipelineOrchestrator();
  o.configure(VALID_CONFIG); // knowledgeTimeout = 50ms
  o.wire(fakeStations(kb, { onDecision: p => { decisionPayload = p; } }) as any);
  const report = await o.run({ id: 'i-5', description: 'open settings' });
  assert.equal(report.verdict, 'completed');
  assert.equal(report.knowledgeUsed, null); // 降级：无隐知识模式
  assert.equal(decisionPayload.knowledgeContext, undefined); // 决策上下文零污染
});

// ─── 事件表面：发射守卫（旁路义务）───

test('D-7 events: 发射函数永不抛错（throwing emit 被吞 —— 旁路义务）', () => {
  const boom = (): never => { throw new Error('emit channel broken'); };
  assert.doesNotThrow(() => emitKnowledgeAttempt(boom, {
    intentId: 'i', seq: 1, actionKind: 'noop', status: 'success', failureKind: null,
  }));
  assert.doesNotThrow(() => emitKnowledgeRunEnd(boom, {
    intentId: 'i', verdict: 'completed', outcomes: 1, knowledgeUsed: true, reportPath: 'p', endedAt: 0,
  }));
  const seen: Array<[string, object]> = [];
  const emit = (ev: string, p: object) => { seen.push([ev, p]); };
  emitKnowledgeAttempt(emit, { intentId: 'i', seq: 1, actionKind: 'noop', status: 'failure', failureKind: 'host-error' });
  assert.equal(seen[0][0], 'knowledge/attempt');
  assert.deepEqual(seen[0][1], { intentId: 'i', seq: 1, actionKind: 'noop', status: 'failure', failureKind: 'host-error' });
});

// ─── 知识免疫系统（Knowledge Immune System）───
// 与 D-4 QualityDoctor 的架构对仗：D-4 免疫代码缺陷，D-7 免疫经验腐烂。
// 四机制各有独立执法点测试 —— 防其借尸还魂。

test('免疫 #1 遗忘曲线：老知识置信度衰减 ⇒ minConfidence 过滤 + 排序让位', () => {
  const kb = new InMemoryKnowledgeBase();
  // 控制变量：同文本同置信度 ⇒ keyword/语义双通道严格同分，唯一差量是时间
  kb.insert({ category: 'shortcut', content: 'freeze header row first', scenario: 'browser tabs', confidence: 0.8, source: 'manual' });
  kb.insert({ category: 'shortcut', content: 'freeze header row first', scenario: 'browser tabs', confidence: 0.8, source: 'manual' });
  // 时间旅行（snapshot 外泄引用是测试后门）：首条退回 10 个半衰期 ⇒ 有效置信度 ~0.0008
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const [stale, fresh] = kb.snapshot();
  stale.updatedAt = Date.now() - 10 * THIRTY_DAYS_MS;

  // 过滤执法：老条目有效置信度跌破门槛 ⇒ 只剩新条目
  const filtered = kb.query({ sceneDescription: 'browser tabs', intentDescription: 'tabs', minConfidence: 0.5 });
  assert.ok(filtered.ok);
  assert.equal(filtered.value.entries.length, 1);
  assert.equal(filtered.value.entries[0].id, fresh.id, '老知识被遗忘曲线过滤');

  // 排序执法：无门槛时老条目仍可命中（留痕），但同分下排在新知识之后
  const both = kb.query({ sceneDescription: 'browser tabs', intentDescription: 'tabs' });
  assert.ok(both.ok);
  assert.equal(both.value.entries[0].id, fresh.id, '同分 ⇒ 有效置信度定序：新的在前');
  assert.equal(both.value.entries[1].id, stale.id, '老知识留痕但让位');
});

test('免疫 #2 复证强化：同场景同结论再现 ⇒ 单条目滴度升高（不新建）', () => {
  const kb = new InMemoryKnowledgeBase();
  const intent = { id: 'i-r', description: 'close the dialog' };
  const action: AtomicAction = { kind: 'click_mouse', args: { x: 0.9, y: 0.1 }, rationale: 'r' };
  const fail: ExecutionResult = { action, status: 'failure', durationMs: 5, failure: { kind: 'host-error', detail: 'button moved' } };
  assert.ok(kb.learnFromOutcome({ intent, action, result: fail, retryCount: 0, totalDurationMs: 10 }).ok);
  assert.ok(kb.learnFromOutcome({ intent, action, result: fail, retryCount: 1, totalDurationMs: 20 }).ok);

  const errors = kb.snapshot().filter(e => e.category === 'error-pattern');
  assert.equal(errors.length, 1, '复证 = 抗体滴度升高，绝不新造重复抗体');
  assert.ok(errors[0].confidence > 0.3, `强化后 > 初值 0.3，实际 ${errors[0].confidence}`);
  assert.ok(errors[0].confidence < 1, '渐近 1 绝不越界');
});

test('免疫 #2 反证衰减：同场景结论反转 ⇒ 旧条目减半下沉 + 新结论在场（双留痕）', () => {
  const kb = new InMemoryKnowledgeBase();
  const intent = { id: 'i-c', description: 'open the portal' };
  const action: AtomicAction = { kind: 'click_mouse', args: { x: 0.5, y: 0.5 }, rationale: 'r' };
  const fail: ExecutionResult = { action, status: 'failure', durationMs: 5, failure: { kind: 'host-error', detail: 'not found' } };
  const win: ExecutionResult = { action, status: 'success', durationMs: 5 };
  assert.ok(kb.learnFromOutcome({ intent, action, result: fail, retryCount: 0, totalDurationMs: 10 }).ok);
  assert.ok(kb.learnFromOutcome({ intent, action, result: win, retryCount: 0, totalDurationMs: 10 }).ok);

  const errors = kb.snapshot().filter(e => e.category === 'error-pattern');
  const workflows = kb.snapshot().filter(e => e.category === 'workflow');
  assert.equal(errors.length, 1, '旧结论留痕（证据绝不销毁）');
  assert.equal(workflows.length, 1, '新结论在场（代表当前世界）');
  assert.ok(Math.abs(errors[0].confidence - 0.15) < 1e-9, `反证 ⇒ 0.3×0.5=0.15，实际 ${errors[0].confidence}`);
});

// ─── 核证接地（verified grounding 纪元）：信任生命周期 ───
// 亲证铸造三律：复证 ⇒ verifiedAt 刷新 / 反证 ⇒ 不动（证伪不是证实）/
// 新铸 ⇒ 生而亲证。信任 = 置信度 × 0.5^(age/30天)（trustOf 纯函数）。

test('核证接地 信任生命周期：传闻=0 / 亲证=now / 强化刷新 / 反证不刷新', () => {
  const kb = new InMemoryKnowledgeBase();
  const DAY = 24 * 60 * 60 * 1000;

  // ① 传闻：manual 种子（verifiedAt 缺席）⇒ 信任 0 —— 没被亲证过的证据不配压制到死
  assert.ok(kb.insert({
    category: 'error-pattern', content: 'delete item broken', scenario: 'record cleanup',
    confidence: 0.55, source: 'manual',
  }).ok);
  assert.equal(trustOf(0.55, undefined, Date.now()), 0, '传闻 ⇒ 信任 0');
  assert.equal(trustOf(0, Date.now(), Date.now()), 0, '零置信亲证 ⇒ 信任 0（置信度仍是要素）');

  // ② 新铸亲证：learnFromOutcome 失败 ⇒ auto-learn 条目生而亲证（verifiedAt 在场）
  const intent = { id: 'i-v', description: 'record cleanup' };
  const action: AtomicAction = { kind: 'click_mouse', args: { x: 0.4, y: 0.4 }, rationale: 'r' };
  const fail: ExecutionResult = { action, status: 'failure', durationMs: 5, failure: { kind: 'host-error', detail: 'broken' } };
  const before = Date.now();
  assert.ok(kb.learnFromOutcome({ intent, action, result: fail, retryCount: 0, totalDurationMs: 10 }).ok);
  let errors = kb.snapshot().filter(e => e.category === 'error-pattern');
  assert.equal(errors.length, 2, 'manual 传闻种子 + auto-learn 亲证条目并存（双留痕）');
  const learned = errors.find(e => e.source === 'auto-learn')!;
  assert.ok(learned, '失败学习条目在场');
  assert.ok(learned.verifiedAt !== undefined, '自体学习生而亲证（verifiedAt 在场）');
  assert.ok(learned.verifiedAt! >= before && learned.verifiedAt! <= Date.now(), '亲证时间 = 学习时刻');
  const freshTrust = trustOf(learned.confidence, learned.verifiedAt, Date.now());
  assert.ok(Math.abs(freshTrust - learned.confidence) < 1e-9, '新鲜亲证 ⇒ 信任 = 置信度');

  // ③ 衰减形状（纯函数时间旅行）：30 天一个半衰期，45 天 = conf × 0.5^1.5
  assert.ok(Math.abs(trustOf(0.7, 0, 30 * DAY) - 0.35) < 1e-9, '30 天 ⇒ 信任减半');
  assert.ok(Math.abs(trustOf(0.7, 0, 45 * DAY) - 0.7 * Math.pow(0.5, 1.5)) < 1e-9, '45 天 ⇒ conf×0.5^1.5');
  assert.ok(Math.abs(trustOf(0.7, Date.now(), Date.now() - DAY) - 0.7) < 1e-9, '未来时间戳 ⇒ age 钳 0，信任不超发');

  // ④ 复证刷新：再次失败 ⇒ verifiedAt 前移（又一次直接观察证实 —— 亲证保鲜）
  const vBefore = learned.verifiedAt!;
  assert.ok(kb.learnFromOutcome({ intent, action, result: fail, retryCount: 1, totalDurationMs: 10 }).ok);
  errors = kb.snapshot().filter(e => e.category === 'error-pattern');
  const refreshed = errors.find(e => e.source === 'auto-learn')!;
  assert.ok(refreshed.verifiedAt !== undefined && refreshed.verifiedAt! >= vBefore, '复证 ⇒ 亲证刷新（信任时钟重置）');

  // ⑤ 反证不刷新：成功 outcome ⇒ confidence 下沉，verifiedAt 不动（证伪不是证实）
  const win: ExecutionResult = { action, status: 'success', durationMs: 5 };
  const confBefore = refreshed.confidence;
  const vStable = refreshed.verifiedAt!;
  assert.ok(kb.learnFromOutcome({ intent, action, result: win, retryCount: 0, totalDurationMs: 10 }).ok);
  errors = kb.snapshot().filter(e => e.category === 'error-pattern');
  const disconfirmed = errors.find(e => e.source === 'auto-learn')!;
  assert.ok(disconfirmed.confidence < confBefore, '反证 ⇒ 置信度下沉');
  assert.equal(disconfirmed.verifiedAt, vStable, '证伪不是证实 ⇒ 亲证不刷新');
});

test('核证接地 fragments 透传：distillInjection 携带 verifiedAt（信任评估的证据面）', () => {
  const kb = new InMemoryKnowledgeBase();
  // 传闻（manual 无 verifiedAt）与亲证（auto-learn 带 verifiedAt）并存
  kb.insert({
    category: 'error-pattern', content: 'delete item broken', scenario: 'record cleanup',
    confidence: 0.55, source: 'manual',
  });
  kb.insert({
    category: 'workflow', content: 'clear log after erasing records', scenario: 'record cleanup',
    confidence: 0.8, source: 'auto-learn', verifiedAt: 12345,
  });
  const r = kb.query({ sceneDescription: 'record cleanup', intentDescription: 'erase records' });
  assert.ok(r.ok);
  const inj = distillInjection(r.value, 300);
  assert.ok(inj && inj.fragments, '蒸馏产物携带结构化 fragments');
  const hearsay = inj!.fragments!.find(f => f.content.includes('delete item'));
  const proven = inj!.fragments!.find(f => f.content.includes('clear log'));
  assert.ok(hearsay, '传闻 fragment 在场');
  assert.ok(proven, '亲证 fragment 在场');
  assert.equal(hearsay!.verifiedAt, undefined, '传闻缺席透传（缺席即语义）');
  assert.equal(proven!.verifiedAt, 12345, '亲证时间戳透传到 fragments');
});

test('核证接地 快照往返：verifiedAt 持久化保真 + 域外拒绝 + 旧快照自然降级', () => {
  const kb = new InMemoryKnowledgeBase();
  kb.insert({
    category: 'workflow', content: 'proven path', scenario: 's',
    confidence: 0.8, source: 'auto-learn', verifiedAt: 777,
  });
  const snap = JSON.parse(JSON.stringify(kb.exportSnapshot())); // 序列化往返（真落盘语义）

  // 保真：新实例水合 ⇒ verifiedAt 原样在场
  const kb2 = new InMemoryKnowledgeBase();
  assert.ok(kb2.restoreSnapshot(snap).ok);
  const restored = kb2.snapshot().find(e => e.content === 'proven path');
  assert.equal(restored?.verifiedAt, 777, '亲证时间戳跨进程保真');

  // 旧快照兼容：verifiedAt 缺席 ⇒ 传闻身份（缺席本身就是语义，不是错误）
  const legacy = JSON.parse(JSON.stringify(snap));
  delete legacy.entries[0].verifiedAt;
  const kb3 = new InMemoryKnowledgeBase();
  assert.ok(kb3.restoreSnapshot(legacy).ok, '旧纪元快照（无 verifiedAt）自然降级为传闻');
  assert.equal(kb3.snapshot()[0].verifiedAt, undefined);

  // 域外拒绝：verifiedAt 非法类型 ⇒ 整体拒绝（绝不半水合）
  const bad = JSON.parse(JSON.stringify(snap));
  bad.entries[0].verifiedAt = 'yesterday';
  const kb4 = new InMemoryKnowledgeBase();
  const r = kb4.restoreSnapshot(bad);
  assert.ok(!r.ok, 'verifiedAt 非数字 ⇒ 快照整体拒绝');
  assert.equal((r as { error: { field: string } }).error.field, 'snapshot.entries');
});

test('免疫 #3 hybrid 语义通道：零重合词的场景零样本命中（「整理数据」→「筛选数据」）', () => {
  const kb = new InMemoryKnowledgeBase();
  kb.insert({
    category: 'workflow', content: '整理数据前先冻结首行', scenario: 'spreadsheet 整理数据 clean up',
    confidence: 0.9, source: 'manual',
  });
  // 查询词与条目零重合（keyword 通道 0 分）—— 只能靠语义向量通道命中
  const r = kb.query({ sceneDescription: 'spreadsheet', intentDescription: '筛选数据 filter rows' });
  assert.ok(r.ok);
  assert.equal(r.value.strategy, 'hybrid');
  assert.equal(r.value.entries.length, 1, 'n-gram 语义泛化：无重合词仍命中老员工直觉');
  // 反向保证：语义地板拦住真不相关的查询
  const miss = kb.query({ sceneDescription: 'kitchen', intentDescription: 'cooking recipe pasta' });
  assert.ok(miss.ok);
  assert.equal(miss.value.entries.length, 0);
});

// ─── 睡眠整合（海马体→皮层）：情景记忆 → 语义记忆的蒸馏执法 ───
// 生物学对应：海马体快速记录的逐条经历，在睡眠中回放、聚类、抽象为皮层的
// 概括性知识 —— 「这三次点击都失败」变成「此类弹窗的确定按钮是陷阱」。

test('睡眠整合 #1 基础流：≥3 条语义相近情景 ⇒ 蒸馏语义记忆 + 原情景皮层化衰减', () => {
  const kb = new InMemoryKnowledgeBase();
  // 三次经历措辞不同但同一主题（save dialog 陷阱）—— 海马体的三条情景记忆
  kb.insert({ category: 'error-pattern', content: 'confirm button is broken', scenario: 'close the save dialog', confidence: 0.4, source: 'auto-learn' });
  kb.insert({ category: 'error-pattern', content: 'confirm button is broken', scenario: 'close save dialog popup', confidence: 0.4, source: 'auto-learn' });
  kb.insert({ category: 'error-pattern', content: 'confirm button is broken', scenario: 'dismiss the save dialog', confidence: 0.4, source: 'auto-learn' });
  // 一条无关情景（不同主题 —— 语义零相交，不应入簇）
  kb.insert({ category: 'workflow', content: 'sort data ascending', scenario: 'sort spreadsheet by date', confidence: 0.6, source: 'auto-learn' });

  const r = kb.consolidate();
  assert.ok(r.ok);
  assert.equal(r.value.episodes, 4, '全部 4 条 auto-learn 参与聚类资格检查');
  assert.equal(r.value.clusters, 1, '只有 save-dialog 簇成规模');
  assert.equal(r.value.consolidated, 1);
  assert.equal(r.value.episodedDecayed, 3);

  const snap = kb.snapshot();
  const semantic = snap.filter(e => e.content.startsWith('consolidated pattern from 3 episodes'));
  assert.equal(semantic.length, 1, '蒸馏出恰好一条语义记忆');
  assert.equal(semantic[0].category, 'error-pattern', '多数类别获胜');
  // 共识置信度：mean(0.4) + 0.1×√3 ≈ 0.573 —— 多源复证比单源断言更可信
  assert.ok(semantic[0].confidence > 0.4, `共识 ${semantic[0].confidence} 应高于单源 0.4`);

  // 原情景皮层化衰减 ×0.5（让位不销毁：证据留痕，只是不再占据检索前排）
  const decayed = snap.filter(e => e.content === 'confirm button is broken');
  assert.equal(decayed.length, 3);
  assert.ok(decayed.every(e => Math.abs(e.confidence - 0.2) < 1e-9),
    `皮层化衰减到 0.2，实际 ${decayed.map(e => e.confidence).join(',')}`);
  // 簇外旁观情景零影响
  const bystander = snap.find(e => e.content === 'sort data ascending');
  assert.ok(bystander && Math.abs(bystander.confidence - 0.6) < 1e-9, '簇外情景置信度不动');
});

test('睡眠整合 #2 幂等：重复入睡不再增殖（皮层化条目与语义产物双守卫）', () => {
  const kb = new InMemoryKnowledgeBase();
  for (const sc of ['close the save dialog', 'close save dialog popup', 'dismiss the save dialog']) {
    kb.insert({ category: 'error-pattern', content: 'confirm button is broken', scenario: sc, confidence: 0.4, source: 'auto-learn' });
  }
  const first = kb.consolidate();
  assert.ok(first.ok && first.value.consolidated === 1);

  const second = kb.consolidate();
  assert.ok(second.ok);
  assert.equal(second.value.clusters, 0, '已皮层化条目不再参与聚类');
  assert.equal(second.value.consolidated, 0, '二次入睡零蒸馏');
  // 语义记忆总量守恒：仍然只有 1 条（不会滚雪球增殖）
  assert.equal(kb.snapshot().filter(e => e.content.startsWith('consolidated pattern')).length, 1);
});

test('睡眠整合 #3 低于阈值：两条重合是巧合不是模式（<3 不蒸馏）', () => {
  const kb = new InMemoryKnowledgeBase();
  kb.insert({ category: 'error-pattern', content: 'confirm button is broken', scenario: 'close the save dialog', confidence: 0.4, source: 'auto-learn' });
  kb.insert({ category: 'error-pattern', content: 'confirm button is broken', scenario: 'close save dialog popup', confidence: 0.4, source: 'auto-learn' });

  const r = kb.consolidate();
  assert.ok(r.ok);
  assert.equal(r.value.episodes, 2);
  assert.equal(r.value.consolidated, 0);
  // 情景保持原置信度（不成熟的模式不折损原始证据）
  assert.ok(kb.snapshot().every(e => Math.abs(e.confidence - 0.4) < 1e-9));
});

test('睡眠整合 #4 跨场景泛化：三个不同 app 的同类陷阱 ⇒ 一条泛化语义记忆', () => {
  const kb = new InMemoryKnowledgeBase();
  // 三个不同场景（word/excel/ppt）经历同一陷阱 —— 语义向量跨场景聚拢，
  // 零样本把「三个 app 的三次事故」抽象为「save dialog 的 ok 按钮陷阱」
  kb.insert({ category: 'error-pattern', content: 'ok button overlaps cancel', scenario: 'word app save dialog', confidence: 0.5, source: 'auto-learn' });
  kb.insert({ category: 'error-pattern', content: 'ok button overlaps cancel', scenario: 'excel app save dialog', confidence: 0.5, source: 'auto-learn' });
  kb.insert({ category: 'error-pattern', content: 'ok button overlaps cancel', scenario: 'ppt app save dialog', confidence: 0.5, source: 'auto-learn' });

  const r = kb.consolidate();
  assert.ok(r.ok);
  assert.equal(r.value.consolidated, 1, '跨场景三情景蒸馏为一条泛化记忆');
  const semantic = kb.snapshot().find(e => e.content.startsWith('consolidated pattern from 3 episodes'));
  assert.ok(semantic, '语义记忆在场');
  // 共识：mean(0.5) + 0.1×√3 ≈ 0.673
  assert.ok(Math.abs(semantic.confidence - 0.673) < 0.001, `实际 ${semantic.confidence}`);
  // 蒸馏后的语义记忆可被零样本检索命中（泛化知识进入工作记忆）
  const q = kb.query({ sceneDescription: 'save dialog', intentDescription: 'ok button overlaps cancel' });
  assert.ok(q.ok);
  assert.ok(q.value.entries.some(e => e.content.startsWith('consolidated pattern')),
    '语义记忆应可检索');
});

test('睡眠整合 #5 类别冲突消解：混合簇（2×error-pattern + 1×workflow）⇒ 多数票定类别', () => {
  const kb = new InMemoryKnowledgeBase();
  // 同一语义簇内类别分歧：两次失败 + 一次成功 —— 冲突由多数票消解
  kb.insert({ category: 'error-pattern', content: 'confirm button is broken', scenario: 'close the save dialog', confidence: 0.4, source: 'auto-learn' });
  kb.insert({ category: 'error-pattern', content: 'confirm button is broken', scenario: 'close save dialog popup', confidence: 0.4, source: 'auto-learn' });
  kb.insert({ category: 'workflow', content: 'confirm button is broken', scenario: 'dismiss the save dialog', confidence: 0.6, source: 'auto-learn' });

  const r = kb.consolidate();
  assert.ok(r.ok && r.value.consolidated === 1);
  const semantic = kb.snapshot().find(e => e.content.startsWith('consolidated pattern'))!;
  assert.equal(semantic.category, 'error-pattern', '2:1 多数票 ⇒ error-pattern 获胜');
  // 共识：mean(0.4667) + 0.1×√3 ≈ 0.64
  assert.ok(Math.abs(semantic.confidence - 0.64) < 0.001, `实际 ${semantic.confidence}`);
});

test('免疫 #4 类别鸡尾酒：同类扎堆的检索结果 ⇒ 蒸馏摘要按类别轮转（组合推理）', () => {
  const mk = (i: number, category: KnowledgeEntry['category']): KnowledgeEntry => ({
    id: `e${i}`, category, content: `fragment-${i}`, scenario: 's',
    confidence: 0.9, source: 'manual' as const, updatedAt: 0, usageCount: 0,
  });
  // 排序结果同类扎堆：3×ui-pattern 打头，system-quirk / error-pattern 垫底
  const injection = distillInjection({
    entries: [mk(1, 'ui-pattern'), mk(2, 'ui-pattern'), mk(3, 'ui-pattern'), mk(4, 'system-quirk'), mk(5, 'error-pattern')],
    latencyMs: 1, strategy: 'hybrid',
  }, 300);
  assert.ok(injection);
  // 轮转序：ui-pattern → system-quirk → error-pattern → ui-pattern → ui-pattern
  const order = injection.summary.match(/\[(\w[\w-]*)\]/g) ?? [];
  assert.deepEqual(order, ['[ui-pattern]', '[system-quirk]', '[error-pattern]', '[ui-pattern]', '[ui-pattern]'],
    '注入摘要先铺满类别多样性，再回填同类 —— 组合推理优于复读');
  assert.equal(injection.categories.length, 3);
});
