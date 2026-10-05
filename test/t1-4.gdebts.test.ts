// test/t1-4.gdebts.test.ts
// ΤΕΛΟΣ 纪元 ΤΕΛ-4 工单执法册：D-G16③ / D-G17① / D-G20 的清偿执法
//（D-G16①② 与 D-G17② 的处置取证见各 test 内注记 —— 分别由 ΤΕΛ-8a 与
// ΠΑΝ-116 顺带闭环，本册只做在册性验证不重复执法）。
// 纪律：合成「违规 / 干净」双面证据 + 真实源码树金丝雀（当前库必须零命中）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { runOrchestrator, type ActorFn } from '../src/orchestrator.ts';
import type { ChatFn, SubTask } from '../src/planner.ts';
import { coordinator } from '../src/subAgent.ts';
import { journal } from '../src/journal.ts';
import { resetApproval } from '../src/approval.ts';
import { DOCTOR_RULES } from '../src/qualityDoctor.ts';
import type { ScanContext } from '../src/qualityDoctor.ts';
import type { Config } from '../src/config.ts';
import { translateFailureKind } from '../src/physicalExecution/d7HostPort.ts';
import type { D7FailureKind } from '../src/knowledge/contracts.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel: string): string => readFileSync(resolve(HERE, '../src', rel), 'utf8');

beforeEach(() => {
  coordinator.reset();
  journal.reset();
  resetApproval();
});

// ══════════════════════════════════════════════════════════════════
// ── D-G16③：plan-ready chain 臂的生产发射消费方（orchestrator 两处 planTasks）──
// ══════════════════════════════════════════════════════════════════

/** 首调返 first、二调（Σ-4 重规划）返 second 的假 chat */
function chatWithReplan(first: unknown, second: unknown): ChatFn {
  let n = 0;
  return async () => { n++; return JSON.stringify(n === 1 ? first : second); };
}

const failFirstActor: ActorFn = async (task: string) =>
  task === 'step-one' ? '[FAILED] boom' : `[SUCCESS] ok:${task}`;

const PLAN_A: SubTask[] = [
  { id: 1, action: 'step-one', deps: [] },
  { id: 2, action: 'step-two', deps: [1] },
];
const PLAN_B: SubTask[] = [{ id: 1, action: 'recovered-path', deps: [] }];

const okActor: ActorFn = async (task: string) => `[SUCCESS] ok:${task}`;

test('ΤΕΛ-4/D-G16③: 首规划发射 —— 链非空即发射（恰一次）；空链 = 空窗诚实缺席零噪声', async () => {
  // 全成功跑（无重规划）：首规划是唯一 planTasks 调用点
  const emitted: unknown[] = [];
  await runOrchestrator('t1-4-g16c-first', okActor, chatWithReplan(PLAN_A, PLAN_B), undefined, {
    planReady: {
      emit: p => { emitted.push(p); },
      chain: () => ({ actions: [{ kind: 'noop', args: {} }] }),
    },
  });
  assert.equal(emitted.length, 1, '首规划链非空 ⇒ 恰一次发射');
  assert.equal((emitted[0] as { chain: { actions: unknown[] } }).chain.actions.length, 1);

  // 空链（生产首规划时刻任务窗恒空的同构）⇒ mint null ⇒ 零发射
  const emitted2: unknown[] = [];
  await runOrchestrator('t1-4-g16c-empty', okActor, chatWithReplan(PLAN_A, PLAN_B), undefined, {
    planReady: {
      emit: p => { emitted2.push(p); },
      chain: () => ({ actions: [] }),
    },
  });
  assert.equal(emitted2.length, 0, '空链不铸造 = 零发射（诚实缺席，不排练空计划）');
});

test('ΤΕΛ-4/D-G16③: 重规划发射 —— Σ-4 时刻供源现取（journal 已含已执行步的生产同构）', async () => {
  const emitted: unknown[] = [];
  // 供源模拟生产语义：首规划时刻任务窗空；重规划时刻已执行步成链
  const windows = [
    [],
    [{ kind: 'click_mouse', args: { x: 0.5, y: 0.5 } }],
  ];
  let call = 0;
  const report = await runOrchestrator('t1-4-g16c', failFirstActor, chatWithReplan(PLAN_A, PLAN_B), undefined, {
    planReady: {
      emit: p => { emitted.push(p); },
      chain: () => ({ actions: windows[call++] }),
    },
  });
  assert.equal(call, 2, '供源两窗各现取一次（每次规划调用独立评估）');
  assert.equal(emitted.length, 1, '恰一次发射（空窗零发射 + 重规划真链发射）');
  const payload = emitted[0] as { chain?: { origin?: string; actions?: unknown[] } };
  assert.ok(payload && 'chain' in payload, '发射的是 chain 臂（联合方言收窄）');
  assert.equal(payload.chain?.origin, 'cognition');
  assert.deepEqual(payload.chain?.actions, [{ kind: 'click_mouse', args: { x: 0.5, y: 0.5 } }],
    '发射的是重规划窗的真链（首规划空窗被 mint 毒证拦截 — 不排练空链）');
  assert.ok(report.includes('[RECOVERED]'), '自愈脊梁照常（发射是旁路义务）');
});

test('ΤΕΛ-4/D-G16③: 零回归 —— planReady 缺席 = 零发射，报告与旧行为一致', async () => {
  const emitted: unknown[] = [];
  const report = await runOrchestrator('t1-4-g16c-compat', failFirstActor, chatWithReplan(PLAN_A, PLAN_B), undefined, {
    planReady: undefined,
  });
  assert.equal(emitted.length, 0);
  assert.ok(report.includes('[RECOVERED]'));
  // 缺省（无 opts 第四参字段）同律 —— 直接不传 planReady 的裸调用
  const bare = await runOrchestrator('t1-4-g16c-bare', failFirstActor, chatWithReplan(PLAN_A, PLAN_B));
  assert.ok(bare.includes('[RECOVERED]'), '裸调用（无 opts）照常 —— 逐字节旧路径');
});

test('ΤΕΛ-4/D-G16③: 供源面故障 = 该次不发射（防御式，绝不毒化计划主流程）', async () => {
  const emitted: unknown[] = [];
  let calls = 0;
  const report = await runOrchestrator('t1-4-g16c-throw', failFirstActor, chatWithReplan(PLAN_A, PLAN_B), undefined, {
    planReady: {
      emit: p => { emitted.push(p); },
      chain: () => { calls++; throw new Error('supplier exploded'); },
    },
  });
  assert.equal(emitted.length, 0, '供源两次抛错 ⇒ 两次都不发射');
  assert.equal(calls, 2, '供源仍被现取（发射与否由供源结果裁决）');
  assert.ok(report.includes('[RECOVERED]'), '计划主流程不受供源故障影响');
});

test('ΤΕΛ-4/D-G16③: 源级金丝雀 —— 组合根生产接线在场（沙箱门控 + journal 供源）+ orchestrator 两处透传', () => {
  const idx = readSrc('index.ts');
  assert.ok(idx.includes('planReady: {'), '组合根注入 planReady（index.ts 生产半边）');
  assert.ok(idx.includes('journal.sinceTaskStart().map'), '供源 = 任务起点以来的 journal 可重放步链');
  assert.ok(idx.includes('(config.enableSandboxStack ?? config.autonomyEnabled) ? {'),
    '发射接线受沙箱栈三态门控（ΤΕΛ-8a 同表达式 —— 排练消费方在环才供源）');
  const orc = readSrc('orchestrator.ts');
  assert.ok(orc.includes('planTasksGuarded(userPrompt, chat, plannerBudgetMs, planOptsOf())'),
    '首规划调用透传发射面');
  assert.ok(orc.includes('planTasksGuarded(replanPrompt, chat, replanLeft, planOptsOf())'),
    'Σ-4 重规划调用透传发射面（D-G16③ 点名的两处）');
});

// ══════════════════════════════════════════════════════════════════
// ── D-G17①：sec.approval-fail-closed 三面锚（grantDetailed + 队列裁决 + 金丝雀裁决）──
// ══════════════════════════════════════════════════════════════════

function ctxOf(sources: Array<{ path: string; content: string }>,
               warnings: string[] = []): ScanContext {
  return {
    sources,
    chain: { entries: [], chainIntact: true },
    snapshot: null,
    config: {} as Config,
    warn: (m: string) => warnings.push(m),
  };
}

const R = (id: string) => DOCTOR_RULES.find(r => r.id === id)!;

const APPROVAL_CLEAN = [
  'const pending = new Map();',
  'export const approval = {',
  '  grantDetailed(token: string, g: boolean): any {',
  '    const pa = pending.get(token);',
  '    if (pa.confirmCodeHash === undefined) {',
  "      return { ok: false, reason: 'confirm-channel-absent' };",
  '    }',
  '    if (g) { pa.granted = true; }',
  '    return { ok: true };',
  '  },',
  '};',
].join('\n');

/** 队列裁决面干净夹具：ΠΑΝ-1 四结局字面量在代码行在场（注释行不计） */
const QUEUE_CLEAN = [
  'export const approvalQueue = {',
  '  adjudicate(ids: string[], grant: boolean): any {',
  '    if (grant) {',
  "      results.push({ id, outcome: 'confirm-channel-absent' });",
  "      results.push({ id, outcome: 'confirm-code-required' });",
  "      results.push({ id, outcome: 'confirm-code-mismatch' });",
  "      results.push({ id, outcome: 'code-attempts-exhausted' });",
  '    }',
  '    return results;',
  '  },',
  '};',
].join('\n');

/** 金丝雀裁决面干净夹具：ΠΑΝ-80 锚（谓词 + 工具名）在代码行在场 */
const CANARY_CLEAN = [
  'function adjudicateCarriesConfirmEvidence(args: Record<string, any>): boolean {',
  '  return typeof args?.confirm_code === "string" && args.confirm_code.trim() !== "";',
  '}',
  'export function registerCanaryGuard(ctx: any): void {',
  "  if (call.name === 'adjudicate_approval_queue' && call.args?.grant === true) {",
  '    if (!adjudicateCarriesConfirmEvidence(call.args)) return blocked();',
  '  }',
  '}',
].join('\n');

test('ΤΕΛ-4/D-G17①: 三面锚干净面零命中；单 approval.ts 旧夹具形状兼容（only-if-present）', async () => {
  const rule = R('sec.approval-fail-closed');
  assert.deepEqual(await rule.scan(ctxOf([
    { path: 'approval.ts', content: APPROVAL_CLEAN },
    { path: 'approval.queue.ts', content: QUEUE_CLEAN },
    { path: 'guards/canaryGuard.ts', content: CANARY_CLEAN },
  ])), [], '三面全干净 ⇒ 零命中');
  // 旧夹具形状（只有 approval.ts —— scope 过滤掉另两面）不误报
  assert.deepEqual(await rule.scan(ctxOf([{ path: 'approval.ts', content: APPROVAL_CLEAN }])), [],
    'only-if-present：文件缺席不虚报（scope 过滤兼容）');
});

test('ΤΕΛ-4/D-G17①: 队列裁决面结局字面量被删 ⇒ critical（模型自批链第二入口复活）', async () => {
  const rule = R('sec.approval-fail-closed');
  const noEvidence = QUEUE_CLEAN.replace("      results.push({ id, outcome: 'confirm-channel-absent' });\n", '');
  assert.ok(!/'confirm-channel-absent'/.test(noEvidence), '夹具自检：无锚结局确已移除');
  const out = await rule.scan(ctxOf([
    { path: 'approval.ts', content: APPROVAL_CLEAN },
    { path: 'approval.queue.ts', content: noEvidence },
    { path: 'guards/canaryGuard.ts', content: CANARY_CLEAN },
  ]));
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'critical');
  assert.match(out[0].evidence, /queue adjudication no longer carries/);
  assert.match(out[0].location.snippet, /confirm-channel-absent/);
});

test('ΤΕΛ-4/D-G17①: 金丝雀裁决锚被拆（谓词消失）⇒ critical；注释里的记载不算实现', async () => {
  const rule = R('sec.approval-fail-closed');
  // 谓词实现与调用点整体被删、只剩注释记载（doc 还在吹 —— 实现没了必须报警）
  const gutted = CANARY_CLEAN
    .replace('function adjudicateCarriesConfirmEvidence(args: Record<string, any>): boolean {\n  return typeof args?.confirm_code === "string" && args.confirm_code.trim() !== "";\n}\n',
      '// ΠΑΝ-80: adjudicateCarriesConfirmEvidence 曾在此（历史记载，非实现）\n')
    .replace('    if (!adjudicateCarriesConfirmEvidence(call.args)) return blocked();\n', '');
  assert.ok(!/adjudicateCarriesConfirmEvidence/.test(gutted.replace(/^\/\/.*$/gm, '')),
    '夹具自检：代码行里谓词确已整体移除');
  const out = await rule.scan(ctxOf([
    { path: 'approval.ts', content: APPROVAL_CLEAN },
    { path: 'approval.queue.ts', content: QUEUE_CLEAN },
    { path: 'guards/canaryGuard.ts', content: gutted },
  ]));
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'critical');
  assert.match(out[0].evidence, /canary adjudication anchor incomplete/);
  // 工具名锚消失同律
  const noToolAnchor = CANARY_CLEAN.replace("'adjudicate_approval_queue'", "'some_other_tool'");
  const out2 = await rule.scan(ctxOf([
    { path: 'approval.ts', content: APPROVAL_CLEAN },
    { path: 'approval.queue.ts', content: QUEUE_CLEAN },
    { path: 'guards/canaryGuard.ts', content: noToolAnchor },
  ]));
  assert.equal(out2.length, 1);
  assert.match(out2[0].evidence, /adjudicate_approval_queue pre-hook anchor missing/);
});

test('ΤΕΛ-4/D-G17①: 真实源码树金丝雀 —— 扩锚后当前库零命中（回改即红）', async () => {
  const rule = R('sec.approval-fail-closed');
  const sources = [
    { path: 'approval.ledger.ts', content: readSrc('approval.ledger.ts') },
    { path: 'approval.queue.ts', content: readSrc('approval.queue.ts') },
    { path: 'guards/canaryGuard.ts', content: readSrc('guards/canaryGuard.ts') },
  ];
  assert.deepEqual(await rule.scan(ctxOf(sources)), [], '真实三面全在场且形状合法');
});

// ── D-G17② 在册性验证（执法本体由 pan114-119.fix.test.ts ΠΑΝ-116 真篡改档 e2e 覆盖）──

test('ΤΕΛ-4/D-G17② 在册取证: chain.wal-tampered 规则消费 stats().walTamperedLines（ΠΑΝ-116 已闭）', () => {
  const rule = R('chain.wal-tampered');
  assert.ok(rule, '规则在册');
  assert.equal(rule.severity, 'critical', '档完整性被触碰 = 红action 档');
  const core = readSrc('doctorRules.core.ts');
  assert.ok(core.includes('reversalEscrow.stats()') && core.includes('walTamperedLines'),
    '检视消费方在场：doctor 规则实读 escrow stats 的篡改计数（持续非零 ⇒ 报告红行）');
});

// ══════════════════════════════════════════════════════════════════
// ── D-G20：knowledge failure 词表扩容 + translateFailureKind 恒等直通 ──
// ══════════════════════════════════════════════════════════════════

/** D-6 ExecutionFailureKind 全量（编译期常量镜像 —— 编译不过 = 词表漂移即红） */
const ORCHESTRATION_KINDS = [
  'gate-rejected', 'host-error', 'timeout', 'timeout-aborted', 'sandbox-degraded', 'cancelled',
  'invalid-args', 'out-of-bounds', 'unknown-button', 'unknown-key', 'element-not-found',
  'screen-capture-failed', 'ocr-unavailable', 'vlm-unavailable', 'window-unavailable',
  'unauthorized', 'internal-error', 'transport-error',
] as const;

test('ΤΕΛ-4/D-G20①: 词表单源 —— knowledge D7FailureKind 接纳 D-6 全量十八值 + timed-out（漂移即编译红）', () => {
  // 编译期执法：每值都可赋给 D7FailureKind（联合不覆盖任一值 = 编译失败）
  const all: D7FailureKind[] = [...ORCHESTRATION_KINDS, 'timed-out'];
  assert.equal(all.length, 19, '十八 D-6 值 + D-7 自有 timed-out');
  // 运行期执法：全部已知值恒等直通（折叠回归即红）
  for (const k of ORCHESTRATION_KINDS) {
    assert.equal(translateFailureKind(k), k, `'${k}' 恒等直通（D-G20：细分不折叠）`);
  }
  assert.equal(translateFailureKind('timed-out'), 'timed-out');
  // 版本漂移未知值：保守可重试兜底（防御纵深第二层）
  assert.equal(translateFailureKind('kind-from-future-python'), 'host-error');
});

test('ΤΕΛ-4/D-G20②: 源级单源锁 —— contracts import D-6 不再镜像；d7HostPort 不持第二份词表', () => {
  const contracts = readSrc('knowledge/contracts.ts');
  // 断言取单行子串（源文件 CRLF/LF 无关）
  assert.ok(contracts.includes('ConfigError, ExecutionFailureKind,'),
    'knowledge/contracts import D-6 的 ExecutionFailureKind（单一事实源，不重定义）');
  assert.ok(contracts.includes("export type D7FailureKind = ExecutionFailureKind | 'timed-out';"),
    'D7FailureKind = D-6 全量 ∪ {timed-out}（扩容后的目标态立法面）');
  const d7 = readSrc('physicalExecution/d7HostPort.ts');
  assert.ok(!/type D7FailureKind =\s*'gate-rejected'/.test(d7.replace(/\r/g, '')),
    'd7HostPort 不再持有第二份 6 值镜像方言（静默漂移面根除）');
  assert.ok(d7.includes('D7FailureKind,'),
    'd7HostPort 经 import 消费 knowledge 单源词表');
});

// ══════════════════════════════════════════════════════════════════
// ── D-G18 / D-G19 在册性取证（两债由并行工位顺带闭环，本册登记验证面）──
// ══════════════════════════════════════════════════════════════════

test('ΤΕΛ-4/D-G19 在册取证: TS↔Python 能力位已镜像（ΠΑΝ-128）—— serviceManager/adapter 铸造点无显式列举', () => {
  const contracts = readSrc('physicalExecution/contracts.ts');
  assert.ok(contracts.includes("| 'admin' | 'observe';"), 'Capability 联合含管理面两位');
  assert.ok(readSrc('physicalExecution/serviceManager.ts').includes('mintToken(key, process.pid, ALL_CAPS, 60)'),
    'serviceManager 铸全权 token（ALL_CAPS 自动含新位 —— 无显式列举漂移面）');
  assert.ok(readSrc('physicalExecution/adapter.ts').includes('this.state.config.defaultCaps ?? ALL_CAPS'),
    'adapter 铸造点同律（缺省全权，配置覆写仍走闭集类型）');
  // 程序化对账执法本体在 test/pan128.capContract.test.ts（本册不重复执法）
});

test('ΤΕΛ-4/D-G18 在册取证: BC-5 信封镜像已由共享件收口（hmacKeyFile 双导入）', () => {
  const shared = readSrc('hmacKeyFile.ts');
  assert.ok(shared.includes('readHexKeyFile') && shared.includes('loadOrCreateHexKeyFile'),
    '共享件在场（F2-9 对接点② 的兑现）');
  assert.ok(readSrc('approval.queueContracts.ts').includes('hmacKeyFile'),
    'queueContracts 经共享件（不再持镜像实现）');
  assert.ok(readSrc('checkpoint.ts').includes('hmacKeyFile'),
    'checkpoint 经共享件（同律）');
  // bug_class_lint --strict 全库零命中 + 册面收尾由 wiring:census 执法（工单实测见报告）
});
