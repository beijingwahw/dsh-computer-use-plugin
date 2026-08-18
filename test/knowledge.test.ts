// test/knowledge.test.ts
// D-7 隐知识中枢回归测试：验收修复项三律 + 防卡顿铁律 + 闭环进化 + 异常诚实。
// 每个用例对应 D-7 规范中的一条铁律 —— 防其借尸还魂。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryKnowledgeBase, distillInjection,
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
  AtomicAction, ExecutionOutcome, ExecutionResult, KnowledgeBase, KnowledgeResult,
  PipelineConfig, Result,
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
  assert.equal(r.value.strategy, 'keyword');
  assert.equal(r.value.entries[0].usageCount, 1); // 检索即使用

  const miss = kb.query({ sceneDescription: 'unrelated', intentDescription: 'different domain entirely' });
  assert.ok(miss.ok);
  assert.equal(miss.value.entries.length, 0);
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
  // 逐笔学习（error-pattern ×3，settledBy='run-end' —— 学习不因沉默而缺席）
  assert.equal(kb.snapshot().filter(e => e.category === 'error-pattern').length, 3);
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
