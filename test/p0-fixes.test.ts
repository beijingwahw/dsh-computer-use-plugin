// test/p0-fixes.test.ts
// P0-1..P0-5 严重缺陷修复回归测试 —— 每条 P0 一节，防其借尸还魂。
// P0-1  D-6 configure → Result<void, ConfigError>（运行层永不 throw）
// P0-2  类型统一：Result 单源 + adapters.ts 显式翻译器（toD7Intent / translateVerdict）
// P0-3  D-1 发射端补全：cognition/plan-ready 单源 + 铸造 + 发射守卫
// P0-4  D-4 判决桥 + D-7 验收门：OutcomeSettlement 双路径（verdict / run-end）+ 发射翻译
// P0-5  D-6 决策通道 chat:null 化（运行层 throw 闭包绝迹）
// P1-3  plan-ready 通道仲裁：consumePlanReady 强类型门控
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COGNITION_PLAN_READY_EVENT, COGNITION_PLAN_VERSION,
  emitCognitionPlanReady, mintIntentPlanReady,
} from '../src/cognitionEvents.ts';
import { COGNITION_PLAN_READY_EVENT as REEXPORTED_FROM_D5 } from '../src/sandbox/events.ts';
import { PipelineOrchestratorImpl } from '../src/orchestration/pipeline.ts';
import { DefaultDecisionStation } from '../src/orchestration/stations.ts';
import type { PipelineConfig } from '../src/orchestration/contracts.ts';
import { toD7Intent, translateVerdict, DoctorVerdictBridge } from '../src/knowledge/adapters.ts';
import { makeScore } from '../src/doctorEvents.ts';
import { translateReportToVerdict } from '../src/doctorChannel.ts';
import type { DiagnosisReport, Finding } from '../src/doctorTypes.ts';
import { KnowledgePipelineOrchestrator } from '../src/knowledge/pipeline.ts';
import { InMemoryKnowledgeBase } from '../src/knowledge/knowledgeBase.ts';
import type {
  AttentionEnvelope, DecisionContext, PerceptionRequest,
  ExecutionOutcome, PipelineConfig as D7PipelineConfig,
} from '../src/knowledge/contracts.ts';
import type { AtomicAction } from '../src/orchestration/contracts.ts';
import { sandboxLog } from '../src/sandbox/log.ts';

// ─── P0-3：D-1 事件契约单源 + 铸造 + 发射守卫 ───

test('P0-3 事件名单源：D-5 再导出与 D-1 主权逐字一致（单一事实源执法）', () => {
  assert.equal(REEXPORTED_FROM_D5, COGNITION_PLAN_READY_EVENT);
  assert.equal(COGNITION_PLAN_READY_EVENT, 'cognition/plan-ready');
});

test('P0-3 mintIntentPlanReady：预算结构保证（goal≤160 / criteria≤200）+ 溯源字段铸造', () => {
  const p = mintIntentPlanReady({
    id: 'intent-d1-x',
    goal: 'G'.repeat(300),
    successCriteria: 'C'.repeat(400),
    budgetMs: 1234,
  });
  assert.equal(p.goal.length, 160); // 结构保证，不靠下游自觉
  assert.equal(p.successCriteria!.length, 200);
  assert.equal(p.source, 'cognition'); // D-1 交班 = cognition 溯源
  assert.equal(p.planVersion, COGNITION_PLAN_VERSION); // 世界模型版本缺省铸造
  assert.equal(p.budgetMs, 1234);
  assert.equal(p.id, 'intent-d1-x');
});

test('P0-3 emitCognitionPlanReady：发射守卫永不抛错（旁路义务）+ 正常路径逐字投递', () => {
  const boom = { emit(): never { throw new Error('bus broken'); } };
  assert.doesNotThrow(() =>
    emitCognitionPlanReady(boom as any, mintIntentPlanReady({ id: 'i', goal: 'g' })));
  const seen: Array<[string, unknown]> = [];
  const ctx = { emit: (ev: string, p: unknown) => { seen.push([ev, p]); } };
  const payload = mintIntentPlanReady({ id: 'i2', goal: 'open the portal' });
  emitCognitionPlanReady(ctx as any, payload);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'cognition/plan-ready');
  assert.deepEqual(seen[0][1], payload);
});

// ─── P0-1 + P1-3：D-6 configure Result 降级（运行层永不 throw）───

const VALID_D6_CONFIG: PipelineConfig = {
  maxDecisionRetries: 3,
  regionGrid: { cols: 2, rows: 2 },
  stationTokenBudgets: { vision: 2000, decision: 8000, execution: 0 },
  rehearseBeforeExecute: true,
  attemptTimeoutMs: 30000,
  perceptionDeadlineMs: 10000,
  consumePlanReady: false, // P1-3 缺省：让渡 D-7 主消费
};

test('P0-1 D-6 configure：域外值 Result 拒绝（field 精确定位，永不 throw）', () => {
  const o = new PipelineOrchestratorImpl();
  const cases: Array<[Partial<PipelineConfig>, string]> = [
    [{ maxDecisionRetries: -1 }, 'maxDecisionRetries'],
    [{ regionGrid: { cols: 0, rows: 2 } }, 'regionGrid'],
    [{ stationTokenBudgets: { vision: 2000, decision: 8000, execution: 100 } }, 'stationTokenBudgets'], // execution 恒 0
    [{ attemptTimeoutMs: 0 }, 'attemptTimeoutMs'],
    [{ perceptionDeadlineMs: -5 }, 'perceptionDeadlineMs'],
    [{ consumePlanReady: 'yes' as any }, 'consumePlanReady'], // P1-3：仲裁开关强类型
  ];
  for (const [patch, field] of cases) {
    let r: ReturnType<PipelineOrchestratorImpl['configure']>;
    assert.doesNotThrow(() => { // 运行层永不 throw（P0-1 铁律）
      r = o.configure({ ...VALID_D6_CONFIG, ...patch } as PipelineConfig);
    });
    assert.ok(!r!.ok, `${field} should be rejected`);
    assert.equal(r!.error.field, field);
  }
  assert.equal(o.configure(null as any).ok, false); // 垃圾输入结构化拒绝
  assert.ok(o.configure(VALID_D6_CONFIG).ok); // 合法配置原样通过
});

// ─── P0-5：D-6 决策通道 chat:null 化（NeedGrounding 回退，绝无 throw 闭包）───

test('P0-5 D-6 决策工位：chat:null ⇒ NeedGrounding 诚实回退（运行层零 throw）', async () => {
  const station = new DefaultDecisionStation({ chat: null }); // 此前是必炸闭包
  const output = await station.decide({
    station: 'decision',
    payload: { intent: { id: 'i', goal: 'open settings', source: 'cognition' }, scene: [] },
    tokenBudget: 2000,
  });
  assert.equal((output as any).kind, 'need-grounding'); // 信息缺口的最广义形态
  assert.equal(typeof (output as any).question, 'string');
  assert.ok((output as any).question.includes('absent')); // 诚实标注通道缺席
});

// ─── P0-2：显式翻译器（双方言单点收口）───

test('P0-2 toD7Intent：D-6 goal 方言 → D-7 description 方言（≤160 + 诚实缺席）', () => {
  const r = toD7Intent({
    id: 'i-t', goal: 'G'.repeat(300), source: 'user',
    successCriteria: 'sc', budgetMs: 99, planVersion: 'v1',
  });
  assert.equal(r.id, 'i-t');
  assert.equal(r.description.length, 160); // 铸造点截断
  assert.equal(r.previousResults, undefined); // D-6 方言无此维 —— 绝不伪造
});

test('P0-2 translateVerdict：D-4 事件方言 → D-7 三态（0-100 → 0-1 域换算）', () => {
  const approved = translateVerdict({ subject: 'i:1', chainTip: 't', verdict: 'approved', score: makeScore(90)! });
  assert.deepEqual(approved, { status: 'approved', confidence: 0.9 });

  const rejectedDefault = translateVerdict({ subject: 'i:2', chainTip: 't', verdict: 'rejected', score: makeScore(20)! });
  assert.equal(rejectedDefault.status, 'rejected');
  assert.equal((rejectedDefault as any).reason, 'rejected by D-4'); // 缺席理由的诚实缺省

  const rejectedLong = translateVerdict({
    subject: 'i:3', chainTip: 't', verdict: 'rejected', score: makeScore(20)!,
    rationale: 'R'.repeat(300),
  });
  assert.equal((rejectedLong as any).reason.length, 200); // Token 纪律铸造点截断

  const review = translateVerdict({ subject: 'i:4', chainTip: 't', verdict: 'needs_review', score: makeScore(60)! });
  assert.deepEqual(review, { status: 'needs_review', flags: ['d-4 needs review'] });
});

// ─── P0-4：D-4 判决桥 —— 验收结算门双路径 ───

function mkOutcome(intentId: string): ExecutionOutcome {
  const action: AtomicAction = { kind: 'noop', args: {}, rationale: 'test' };
  return {
    intent: { id: intentId, description: 'open settings' },
    action,
    result: { action, status: 'success', durationMs: 1 },
    retryCount: 0,
    totalDurationMs: 10,
  };
}

test('P0-4 判决桥：回执缺席 ⇒ trySettle=null（学习被验收门拦下，不发生）', () => {
  const bridge = new DoctorVerdictBridge();
  const outcome = mkOutcome('i-a');
  assert.equal(bridge.trySettle(1, outcome), null);
  assert.equal(outcome.doctorVerdict, undefined); // 未结算 = 未附加判决
});

test('P0-4 判决桥：回执在场 ⇒ 即时结算（verdict 路径 + 判决附加）', () => {
  const bridge = new DoctorVerdictBridge();
  bridge.ingest({ subject: 'i-b:1', chainTip: 't', verdict: 'approved', score: makeScore(90)! });
  const outcome = mkOutcome('i-b');
  const settlement = bridge.trySettle(1, outcome);
  assert.ok(settlement);
  assert.equal(settlement!.settledBy, 'verdict');
  assert.equal(settlement!.subject, 'i-b:1'); // subject 逐字约定 `${intentId}:${seq}`
  assert.deepEqual(outcome.doctorVerdict, { status: 'approved', confidence: 0.9 });
});

test('P0-4 判决桥：挂账冲账双臂 —— run-end 诚实降级 / 迟到回执升格 verdict', () => {
  const bridge = new DoctorVerdictBridge();
  const silent = mkOutcome('i-c');
  bridge.defer(1, silent);
  const late = mkOutcome('i-d');
  bridge.defer(1, late);
  bridge.ingest({ subject: 'i-d:1', chainTip: 't', verdict: 'rejected', score: makeScore(10)!, rationale: 'genesis violated' });

  const settled = bridge.settleAll();
  assert.equal(settled.length, 2);
  const bySubject = new Map(settled.map(s => [s.subject, s]));
  assert.equal(bySubject.get('i-c:1')!.settledBy, 'run-end'); // D-4 沉默：结算单如实标注
  assert.equal(bySubject.get('i-c:1')!.outcome.doctorVerdict, undefined);
  assert.equal(bySubject.get('i-d:1')!.settledBy, 'verdict'); // 证据后到不是沉默
  assert.equal(bySubject.get('i-d:1')!.outcome.doctorVerdict!.status, 'rejected');
  assert.deepEqual(bridge.settleAll(), []); // 冲账即清空（幂等）
});

test('P0-4 判决桥：非法载荷拒绝 + reset 零残留', () => {
  const bridge = new DoctorVerdictBridge();
  bridge.ingest({ subject: '', chainTip: 't', verdict: 'approved', score: makeScore(90)! } as any);
  bridge.ingest(null as any);
  assert.equal(bridge.peek(''), undefined); // 非法 subject 拒绝缓存
  bridge.ingest({ subject: 'i-e:1', chainTip: 't', verdict: 'approved', score: makeScore(90)! });
  bridge.defer(1, mkOutcome('i-e'));
  bridge.reset();
  assert.equal(bridge.peek('i-e:1'), undefined);
  assert.deepEqual(bridge.settleAll(), []); // 等待室同步清空
});

// ─── P0-4：D-7 验收门 —— 流水线 run-end 冲账（learning 只认已结算 outcome）───

const D7_CONFIG: D7PipelineConfig = {
  regionGrid: { cols: 2, rows: 2 },
  timeout: { overall: 5000, perStep: 1000, perPerception: 500 },
  retryPolicy: { maxRetries: 1, backoffMs: 1, maxBackoffMs: 4 },
  knowledgeTimeout: 50,
  knowledgeMaxResults: 5,
  knowledgeMaxChars: 300,
};

/** 最小工位束：单步成功 + 事件捕获（settlement 语义断言的观测面） */
function miniStations(kb: InMemoryKnowledgeBase, bridge: DoctorVerdictBridge, events: Array<[string, any]>) {
  return {
    knowledge: kb,
    vision: { async perceive(): Promise<never[]> { return []; } },
    decision: {
      async decide() {
        return { kind: 'noop', args: {}, rationale: 'stub' } as AtomicAction;
      },
    },
    execution: {
      async execute(env: any) {
        return { action: env.payload, status: 'success', durationMs: 1 } as any;
      },
    },
    verdictBridge: bridge,
    emit: (ev: string, p: object) => { events.push([ev, p]); },
  };
}

test('P0-4 验收门：D-4 沉默 ⇒ run-end 冲账结算（学习照常，结算单如实标注）', async () => {
  const kb = new InMemoryKnowledgeBase();
  const bridge = new DoctorVerdictBridge(); // 零回执：D-4 沉默场景
  const events: Array<[string, any]> = [];
  const o = new KnowledgePipelineOrchestrator();
  o.configure(D7_CONFIG);
  o.wire(miniStations(kb, bridge, events) as any);

  const report = await o.run({ id: 'i-run-end', description: 'open settings' });
  assert.equal(report.verdict, 'completed');
  assert.equal(report.outcomes.length, 1);
  assert.equal(report.outcomes[0].doctorVerdict, undefined); // 未结算不附加判决
  // 学习发生且只发生在结算之后（run-end 冲账路径）
  assert.equal(kb.snapshot().filter(e => e.source === 'auto-learn').length, 1);
  const learned = events.filter(([ev]) => ev === 'knowledge/learned');
  assert.equal(learned.length, 1);
  assert.equal(learned[0][1].settledBy, 'run-end'); // 结算路径可审计
});

test('P0-4 验收门：D-4 回执在场 ⇒ 即时结算（verdict 路径，判决附加后学习）', async () => {
  const kb = new InMemoryKnowledgeBase();
  const bridge = new DoctorVerdictBridge();
  bridge.ingest({ subject: 'i-verdict:1', chainTip: 't', verdict: 'approved', score: makeScore(95)! });
  const events: Array<[string, any]> = [];
  const o = new KnowledgePipelineOrchestrator();
  o.configure(D7_CONFIG);
  o.wire(miniStations(kb, bridge, events) as any);

  const report = await o.run({ id: 'i-verdict', description: 'open settings' });
  assert.equal(report.verdict, 'completed');
  assert.deepEqual(report.outcomes[0].doctorVerdict, { status: 'approved', confidence: 0.95 });
  const learned = events.filter(([ev]) => ev === 'knowledge/learned');
  assert.equal(learned.length, 1);
  assert.equal(learned[0][1].settledBy, 'verdict'); // 黄金路径
  // 即时结算 = 冲账等待室已空（无重复学习）
  assert.deepEqual(bridge.settleAll(), []);
});

// ─── P0-4：D-4 发射端翻译（DiagnosisReport → doctor/verdict 三态）───

function mkFinding(severity: Finding['severity']): Finding {
  return {
    id: 'f1', ruleId: 'rule-x', severity, riskLevel: 'mechanical',
    location: { file: 'src/x.ts', line: 1, snippet: 's' },
    evidence: 'E'.repeat(300), recommendation: 'fix it',
  };
}

function mkReport(over: Partial<DiagnosisReport>): DiagnosisReport {
  return {
    timestamp: 0, incremental: false, score: 90, genesisVerdict: 'intact',
    findings: [], byCategory: { genesis: 0, smell: 0, security: 0, chain: 0 },
    effectiveWeights: {}, trend: null, warnings: [], scannedFiles: 1, chainAudited: true,
    ...over,
  };
}

test('P0-4 translateReportToVerdict：三态映射 + 闸三（未执行的验证层之上无完美分）', () => {
  // 黄金路径：intact + 零发现 + score≥80 + 链已审计 ⇒ approved
  const ok = translateReportToVerdict(mkReport({ score: 90 }), 'chain-1', 'tip-1');
  assert.equal(ok.verdict, 'approved');
  assert.equal(ok.score, 90);
  assert.equal(ok.subject, 'chain-1');
  assert.equal(ok.chainTip, 'tip-1');

  // 创世铁律否决权：violated ⇒ rejected（即便高分）
  assert.equal(translateReportToVerdict(mkReport({ score: 95, genesisVerdict: 'violated' }), 'c', 't').verdict, 'rejected');
  // critical 发现 ⇒ rejected
  assert.equal(translateReportToVerdict(mkReport({ findings: [mkFinding('critical')] }), 'c', 't').verdict, 'rejected');
  // major 发现 ⇒ needs_review（即便 score 达标）
  assert.equal(translateReportToVerdict(mkReport({ findings: [mkFinding('major')] }), 'c', 't').verdict, 'needs_review');
  // 闸三：链未审计 ⇒ needs_review（score 95 也不给 approved）
  const unaudited = translateReportToVerdict(mkReport({ score: 95, chainAudited: false }), 'c', 't');
  assert.equal(unaudited.verdict, 'needs_review');
  // 分数域外 ⇒ needs_review + 重铸 0（域外拒绝，绝不 clamp 掩埋）
  const oob = translateReportToVerdict(mkReport({ score: 150 }), 'c', 't');
  assert.equal(oob.verdict, 'needs_review');
  assert.equal(oob.score, 0);
  // rationale ≤200（Token 纪律铸造点）
  const rejected = translateReportToVerdict(
    mkReport({ score: 10, genesisVerdict: 'violated', findings: [mkFinding('critical')] }), 'c', 't');
  assert.equal(rejected.verdict, 'rejected');
  assert.ok(rejected.rationale!.length <= 200);
});

test('P0-4 makeScore 单源：D-4 发射翻译只认铸造分数（150 拒绝，90 通过）', () => {
  assert.equal(makeScore(150), null);
  assert.equal(makeScore(-1), null);
  assert.equal(makeScore(90), 90 as any);
  assert.equal(makeScore(0), 0 as any);
});

// ─── 风险加固回归（R1-R10）：内存纪律 / 域执法 / 并发越权 / 失控熔断 ───

test('风险加固：判决桥 score 域外拒绝缓存 + translateVerdict 域外降级 needs_review', () => {
  const bridge = new DoctorVerdictBridge();
  // score 域外（150 / -5 / NaN）一律拒绝缓存 —— 回执缺席走 run-end 冲账，绝不毒化结算
  bridge.ingest({ subject: 'i-dom:1', chainTip: 't', verdict: 'approved', score: 150 as any });
  bridge.ingest({ subject: 'i-dom:2', chainTip: 't', verdict: 'approved', score: -5 as any });
  bridge.ingest({ subject: 'i-dom:3', chainTip: 't', verdict: 'approved', score: NaN as any });
  assert.equal(bridge.peek('i-dom:1'), undefined);
  assert.equal(bridge.peek('i-dom:2'), undefined);
  assert.equal(bridge.peek('i-dom:3'), undefined);
  assert.equal(bridge.trySettle(1, mkOutcome('i-dom')), null); // 缓存空 ⇒ 挂账语义不变
  // 纯翻译函数纵深防御：域外分数绝不换算出域外 confidence
  const v = translateVerdict({ subject: 'i', chainTip: 't', verdict: 'approved', score: 150 as any });
  assert.equal(v.status, 'needs_review');
  assert.ok((v as any).flags[0].includes('out of 0-100 domain'));
});

test('风险加固：回执消费即销毁（trySettle / settleAll 结算后缓存零滞留）', () => {
  const bridge = new DoctorVerdictBridge();
  bridge.ingest({ subject: 'i-consume:1', chainTip: 't', verdict: 'approved', score: makeScore(90)! });
  assert.ok(bridge.trySettle(1, mkOutcome('i-consume')));
  assert.equal(bridge.peek('i-consume:1'), undefined); // 已结算 = 死证据，不滞留

  bridge.ingest({ subject: 'i-consume2:1', chainTip: 't', verdict: 'approved', score: makeScore(90)! });
  bridge.defer(1, mkOutcome('i-consume2'));
  bridge.settleAll();
  assert.equal(bridge.peek('i-consume2:1'), undefined); // 冲账路径同律
});

test('风险加固：回执缓存 FIFO 上限（最老死证据淘汰，最新存活）', () => {
  const bridge = new DoctorVerdictBridge();
  for (let i = 0; i < 502; i++) {
    bridge.ingest({ subject: `i-cap:${i}`, chainTip: 't', verdict: 'approved', score: makeScore(90)! });
  }
  assert.equal(bridge.peek('i-cap:0'), undefined); // 超限最老淘汰
  assert.equal(bridge.peek('i-cap:1'), undefined);
  assert.notEqual(bridge.peek('i-cap:2'), undefined); // 上限内存活
  assert.notEqual(bridge.peek('i-cap:501'), undefined); // 最新存活
});

test('风险加固：settleAll(intentId) 限定冲账 —— 并发 run 零越权', () => {
  const bridge = new DoctorVerdictBridge();
  bridge.defer(1, mkOutcome('ia'));
  bridge.defer(2, mkOutcome('ia'));
  bridge.defer(1, mkOutcome('ib'));
  const settled = bridge.settleAll('ia');
  assert.equal(settled.length, 2);
  assert.ok(settled.every(s => s.subject.startsWith('ia:'))); // 只冲自己的挂账
  // B 的等待室原封不动（A 的终局不劫持 B 的验收门）
  const later = bridge.settleAll('ib');
  assert.equal(later.length, 1);
  assert.equal(later[0].subject, 'ib:1');
  assert.deepEqual(bridge.settleAll(), []); // 全部冲净（幂等）
});

test('风险加固：流水线终局冲账按 intent 限定（他人挂账不被劫持结算）', async () => {
  const kb = new InMemoryKnowledgeBase();
  const bridge = new DoctorVerdictBridge();
  const events: Array<[string, any]> = [];
  const o = new KnowledgePipelineOrchestrator();
  o.configure(D7_CONFIG);
  o.wire(miniStations(kb, bridge, events) as any);

  // 预置他者挂账（模拟并发 run B 的等待室）
  bridge.defer(1, mkOutcome('i-other'));
  const report = await o.run({ id: 'i-scope', description: 'open settings' });
  assert.equal(report.verdict, 'completed');
  // 只学到自己的 1 笔（他者挂账未被劫持结算学习）
  assert.equal(events.filter(([ev]) => ev === 'knowledge/learned').length, 1);
  // 他者等待室完好：A 终局后仍可被 B 自己的终局结算
  const drained = bridge.settleAll('i-other');
  assert.equal(drained.length, 1);
  assert.equal(drained[0].subject, 'i-other:1');
});

test('风险加固：mintIntentPlanReady budgetMs 域外诚实缺席（负/NaN/Infinity 不入时间治理）', () => {
  assert.equal(mintIntentPlanReady({ id: 'i', goal: 'g', budgetMs: -100 }).budgetMs, undefined);
  assert.equal(mintIntentPlanReady({ id: 'i', goal: 'g', budgetMs: NaN }).budgetMs, undefined);
  assert.equal(mintIntentPlanReady({ id: 'i', goal: 'g', budgetMs: Infinity }).budgetMs, undefined);
  assert.equal(mintIntentPlanReady({ id: 'i', goal: 'g', budgetMs: 1000 }).budgetMs, 1000); // 域内直通
});

test('风险加固：知识库容量守卫 —— 全 manual 满库时诚实拒绝（不静默越限膨胀）', () => {
  const kb = new InMemoryKnowledgeBase();
  for (let i = 0; i < 1000; i++) {
    const r = kb.insert({ category: 'workflow', content: `c${i}`, scenario: `s${i}`, confidence: 0.5, source: 'manual' });
    assert.ok(r.ok);
  }
  const rejected = kb.insert({ category: 'workflow', content: 'overflow', scenario: 's', confidence: 0.5, source: 'manual' });
  assert.ok(!rejected.ok);
  assert.equal((rejected as any).error.field, 'capacity');
});

test('风险加固：D-6 L3 批准预算熔断（grounding 失控循环保险丝）', async () => {
  const o = new PipelineOrchestratorImpl();
  o.configure(VALID_D6_CONFIG);
  let groundingDemands = 0;
  o.wire({
    vision: { async *perceive(): AsyncGenerator<never, void, unknown> { /* 空场景流 */ } },
    decision: {
      async decide() {
        groundingDemands += 1;
        return { kind: 'need-grounding', question: 'need zoom on tiny text' } as any;
      },
    },
    execution: {
      async execute(env: any) {
        return { seq: env.payload.seq, effectDetected: true, latencyMs: 1, rehearsed: false } as any;
      },
    },
  } as any);
  const report = await o.run({ id: 'i-grounding', goal: 'inspect tiny text', source: 'user' });
  assert.equal(report.verdict, 'failed'); // 预算熔断 ⇒ 诚实终局（不是千轮空转）
  // 决策工位被叫停于批准预算 + 熔断轮（3 次批准 + 第 4 次要价被拒）
  assert.equal(groundingDemands, 4);
});

// ─── P1-1：D-7 信封字面量参数化 —— 跨工位投递 = 编译错误（类型即纪律）───

test('P1-1 信封字面量参数化：视觉信封传入决策工位位 = 编译错误（@ts-expect-error 执法）', () => {
  const visionEnv = {
    station: 'vision' as const,
    payload: { grid: { cols: 1, rows: 1 } },
    tokenBudget: 0,
  };
  // 跨工位投递：'vision' 字面量不可赋给 'decision' 信封 —— 编译期拦截
  // @ts-expect-error P1-1: station 'vision' not assignable to 'decision'（跨工位投递）
  const bad: AttentionEnvelope<'decision', DecisionContext> = visionEnv;
  void bad;
  // 同工位合法路径不受影响：类型直通
  const good: AttentionEnvelope<'vision', PerceptionRequest> = visionEnv;
  void good;
  // 构造垄断不变：信封仍是工位唯一入参形态（station 判别式在场）
  assert.equal(good.station, 'vision');
});

// ─── P1-2：工位 Token 预算 config-driven —— 域外拒绝 + 信封传播可观测 ───

test('P1-2 stationTokenBudgets：execution 域外拒绝（零模型肌肉恒 0）+ 负数拒绝', () => {
  const o = new KnowledgePipelineOrchestrator();
  const r1 = o.configure({ ...D7_CONFIG, stationTokenBudgets: { vision: 0, decision: 2000, execution: 100 } });
  assert.ok(!r1.ok);
  assert.equal((r1 as { error: { field: string } }).error.field, 'stationTokenBudgets.execution');
  const r2 = o.configure({ ...D7_CONFIG, stationTokenBudgets: { vision: -1, decision: 2000, execution: 0 } });
  assert.ok(!r2.ok);
  assert.equal((r2 as { error: { field: string } }).error.field, 'stationTokenBudgets');
});

test('P1-2 stationTokenBudgets：域内自定义预算 → 信封传播可观测（配置直达工位）', async () => {
  const seen: number[] = [];
  const stations = {
    ...miniStations(new InMemoryKnowledgeBase(), new DoctorVerdictBridge(), []),
    vision: { async perceive(env: any) { seen.push(env.tokenBudget); return []; } },
    decision: {
      async decide(env: any) {
        seen.push(env.tokenBudget);
        return { kind: 'noop', args: {}, rationale: 'stub' } as AtomicAction;
      },
    },
  };
  const o = new KnowledgePipelineOrchestrator();
  const ok = o.configure({ ...D7_CONFIG, stationTokenBudgets: { vision: 11, decision: 22, execution: 0 } });
  assert.ok(ok.ok);
  o.wire(stations as any);
  await o.run({ id: 'i-budget', description: 'verify budget propagation' });
  assert.ok(seen.includes(11), 'vision 信封携带配置预算');
  assert.ok(seen.includes(22), 'decision 信封携带配置预算');
});

// ─── P1-5：D-7 可观测性入链 —— knowledge-* 链段 + 哈希链完整性 + chainTip 锚点 ───

test('P1-5 可观测性入链：attempt/learned/retrieval/run-end 皆入账 + verify 完整 + 报告锚点', async () => {
  sandboxLog.reset();
  const events: Array<[string, any]> = [];
  const o = new KnowledgePipelineOrchestrator();
  o.configure(D7_CONFIG);
  o.wire(miniStations(new InMemoryKnowledgeBase(), new DoctorVerdictBridge(), events) as any);

  const report = await o.run({ id: 'i-chain', description: 'open settings' });

  const kinds = sandboxLog.list().map(e => e.kind);
  assert.ok(kinds.includes('knowledge-attempt'), 'attempt 入链');
  assert.ok(kinds.includes('knowledge-learned'), '学习历史入链（防篡改账本）');
  assert.ok(kinds.includes('knowledge-retrieval'), '检索历史入链');
  assert.ok(kinds.includes('knowledge-run-end'), 'run 终局入链');
  assert.equal(sandboxLog.verify().ok, true); // append-only 哈希链完整性
  assert.equal(typeof report.chainTip, 'string');
  assert.ok((report.chainTip ?? '').length > 0, '报告锚定链尖端（D-4 审计定位）');
  // 账本条目与 run 关联（intentId 审计锚）
  const attemptEntry = sandboxLog.list().find(e => e.kind === 'knowledge-attempt');
  assert.equal(attemptEntry?.data.intentId, 'i-chain');
});
