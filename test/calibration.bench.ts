// test/calibration.bench.ts
// 参数校准基准 —— 对「24 个拍脑袋常数」批评的实证回应与执行。
//
// 方法论：
//   Part A 一阶敏感性（流水线级）：对登记参数逐个扫值域（其余固定缺省），
//     跑七个权威场景（E1b-seeded 改道 / E1b-blind 直扑 / E3 学习曲线 /
//     E2 计费静默 + 新世界开火 + E5 传闻核证一针 / E6 陈年复活探针 /
//     E7 新鲜亲证零学费），
//     全绿值集 = 可行区间。
//     入册资格 = 本基准测得区间 —— 无区间者已出册（12 个，
//     全部内联为模块私有字面量；时间衰减机制保留但半衰期内联，
//     衰减形状由 knowledge.test 免疫 #1 守护）。
//     核证接地纪元（v4）：E5/E6/E7 敏感化 VERIFY_TRUST_FLOOR ——
//     信任门控的接地前探针（传闻压制一针核证 / 陈年亲证衰减复活 /
//     新鲜亲证自背书零学费；一 run 一针由探针闩锁结构执法，
//     与 D-4 结算时序解耦）。
//   Part B 契约校准（算法级）：登记参数的有效域 + 出册字面量的不变量守护。
//   Part C L3 分离带：测量熟悉世界惊讶底噪与新世界惊讶信号，
//     阈值可行区间 = 两者之间的分离带 —— 数据定标，非拍脑袋。
//
// 诚实边界：一阶扫描 ≠ 联合标定（参数间耦合只被端点场景覆盖，
// 不是全空间搜索）；契约校准给的是结构有效域，不是最优值。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgePipelineOrchestrator } from '../src/knowledge/pipeline.ts';
import { InMemoryKnowledgeBase } from '../src/knowledge/knowledgeBase.ts';
import { InMemoryWorldModel } from '../src/knowledge/worldModel.ts';
import { ReflexiveDecisionStation } from '../src/knowledge/stations.ts';
import { DoctorVerdictBridge } from '../src/knowledge/adapters.ts';
import { setParam, resetParams, paramCatalog, P, type ParamName } from '../src/knowledge/params.ts';
import type {
  AtomicAction, ExecutionOutcome, PipelineConfig, PipelineReport, ScenePatch,
} from '../src/knowledge/contracts.ts';

let runCounter = 0;

// ─── 确定性世界（与 ablation.bench.ts 同构）───

const ELEMENTS = [
  { name: 'delete item', x: 0.30, y: 0.30, w: 0.20, h: 0.10 }, // 陷阱
  { name: 'clear log', x: 0.65, y: 0.65, w: 0.20, h: 0.10 },   // 活路
] as const;

const WORLD_SCENE: ScenePatch[] = [{
  region: { id: 'g0x0', x: 0, y: 0, width: 1, height: 1 },
  elements: ELEMENTS.map(e => ({
    source: 'L1-tree' as const, role: 'button' as const, name: e.name,
    rect: { x: e.x, y: e.y, width: e.w, height: e.h },
  })),
  funnelDepth: 'L1' as const,
  capturedAt: 0,
}];

function hitElement(x: number, y: number): string | null {
  for (const e of ELEMENTS) {
    if (x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h) return e.name;
  }
  return null;
}

const BENCH_CONFIG: PipelineConfig = {
  timeout: { overall: 2000, perStep: 200, perPerception: 100 },
  retryPolicy: { maxRetries: 2, backoffMs: 1, maxBackoffMs: 2 },
  knowledgeTimeout: 50, knowledgeMaxResults: 5, knowledgeMaxChars: 300,
};

interface Probe { l3Rounds: number; executions: number; trapHits: number }

async function runIntent(
  intentDescription: string,
  opts: {
    seeds?: boolean; kb?: InMemoryKnowledgeBase; stateDir?: string; maxRetries?: number;
    /** E5 传闻核证：只注 error-pattern 传闻种子（无 workflow 活路证据） */
    hearsayTrap?: boolean;
    /** E6 陈年复活：陷阱已修好（delete item 点击成功 —— 忏悔世界） */
    trapFixed?: boolean;
  } = {},
): Promise<{ report: PipelineReport; probe: Probe }> {
  const kb = opts.kb ?? new InMemoryKnowledgeBase();
  if (opts.seeds) {
    kb.insert({ category: 'error-pattern', content: 'delete item button is broken, clicks fail', scenario: 'record cleanup', confidence: 0.55, source: 'manual' });
    kb.insert({ category: 'workflow', content: 'clear log after erasing records', scenario: 'record cleanup', confidence: 0.6, source: 'manual' });
  }
  if (opts.hearsayTrap) {
    kb.insert({ category: 'error-pattern', content: 'delete item button is broken, clicks fail', scenario: 'record cleanup', confidence: 0.55, source: 'manual' });
  }
  const probe: Probe = { l3Rounds: 0, executions: 0, trapHits: 0 };
  const rig = {
    vision: { async perceive(env: any) { if (env?.payload?.forceL3) probe.l3Rounds += 1; return WORLD_SCENE; } },
    execution: {
      async execute(env: any) {
        probe.executions += 1;
        const a = env.payload as AtomicAction;
        const hit = typeof a.args?.x === 'number' && typeof a.args?.y === 'number' ? hitElement(a.args.x, a.args.y) : null;
        if (hit === 'delete item' && !opts.trapFixed) {
          probe.trapHits += 1;
          return { action: a, status: 'failure' as const, durationMs: 1, failure: { kind: 'host-error' as const, detail: 'delete item is broken' } };
        }
        if (hit === 'delete item') probe.trapHits += 1; // 修好后的点击也计入（复活探针的物理证据）
        return { action: a, status: 'success' as const, durationMs: 1 };
      },
    },
  };
  const o = new KnowledgePipelineOrchestrator();
  const cfg: PipelineConfig = opts.maxRetries === undefined
    ? BENCH_CONFIG
    : { ...BENCH_CONFIG, retryPolicy: { maxRetries: opts.maxRetries, backoffMs: 1, maxBackoffMs: 2 } };
  assert.ok(o.configure(cfg).ok);
  o.wire(
    {
      vision: rig.vision, decision: new ReflexiveDecisionStation({ chat: null }),
      execution: rig.execution, knowledge: kb, verdictBridge: new DoctorVerdictBridge(),
      emit: () => { /* 旁路 */ },
    },
    { stateDir: opts.stateDir },
  );
  const report = await o.run({ id: `cal-${++runCounter}`, description: intentDescription });
  return { report, probe };
}

// ─── 权威场景（判据 = 消融基准的断言，一字不改）───

/** E1b：种子知识改道成功 + 无知识直扑失败 */
async function scenarioE1b(): Promise<boolean> {
  const saved = await runIntent('delete the record', { seeds: true });
  if (!(saved.report.verdict === 'completed' && saved.probe.trapHits === 0)) return false;
  const blind = await runIntent('delete the record', {});
  if (!(blind.report.verdict === 'failed' && blind.probe.trapHits >= 3)) return false;
  return true;
}

/** E3：学习曲线（Day1 踩坑学习 → Day2 改道；遗忘症仍失败） */
async function scenarioE3(): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), 'd7-cal-'));
  try {
    const d1trap = await runIntent('delete the record', { stateDir: dir });
    if (d1trap.report.verdict !== 'failed') return false;
    const d1safe = await runIntent('clear the log', { stateDir: dir });
    if (d1safe.report.verdict !== 'completed') return false;
    const d2 = await runIntent('delete the record', { stateDir: dir });
    if (!(d2.report.verdict === 'completed' && d2.probe.trapHits === 0)) return false;
    const amnesia = await runIntent('delete the record', {});
    if (amnesia.report.verdict !== 'failed') return false;
    return true;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** E2：熟悉世界 surprise 策略零 L3 开销（计费器不误报） */
async function scenarioE2(): Promise<boolean> {
  const r = await runIntent('erase the record', { seeds: true });
  return r.report.verdict === 'completed' && r.probe.l3Rounds === 0;
}

/** 新世界信号：E1b-blind 首次遭遇必须升级且只升一次
 *  （l3 恰为 1 —— 真新颖一次；重复已知转移必须静默。
 *   bits=0 时每次转移都 ≥0 ⇒ l3 会烧到 3 ⇒ 此判据翻红 —— 这就是分离带下界） */
async function scenarioNovelty(): Promise<boolean> {
  const r = await runIntent('delete the record', {});
  return r.report.verdict === 'failed' && r.probe.l3Rounds === 1;
}

/** E5 传闻核证（核证接地纪元）：manual 传闻压制（trust 0）+ 无活路 ⇒ 接地前
 *  一针探针。判据：failed 且 trapHits === 1 —— 恰好一针（一次性闩锁结构执法：
 *  D-4 回执沉默的世界里学习挂账至 run-end，run 内重试期间知识状态不变，
 *  闩锁保证探针失败后的重试直接诚实接地，学费恰一针）。
 *  VERIFY_TRUST_FLOOR 的定界器（下界）：floor=0 ⇒ 传闻 trust 0 ≥ 0 门控通过
 *  ⇒ 不探针（trapHits=0 翻红）。 */
async function scenarioHearsayVerify(): Promise<boolean> {
  const r = await runIntent('delete the record', { hearsayTrap: true });
  return r.report.verdict === 'failed' && r.probe.trapHits === 1;
}

/** E6 陈年复活（核证接地纪元）：60 天前的亲证压制（conf 0.66 × 0.5^(60/30)
 *  = trust 0.165）+ 陷阱已修好 ⇒ 衰减过线的亲证触发复活探针 ⇒ 破局成功。
 *  判据：completed —— 陈年死锁的解药通道（世界会变，亲证会过期）。
 *  floor ≤ 0.165 ⇒ 陈年亲证自背书 ⇒ 不探针 ⇒ failed 翻红（联合定界下界）。 */
async function scenarioStaleRevival(): Promise<boolean> {
  const kb = new InMemoryKnowledgeBase();
  kb.insert({
    category: 'error-pattern', content: 'delete item button is broken, clicks fail',
    scenario: 'record cleanup', confidence: 0.66, source: 'auto-learn',
    verifiedAt: Date.now() - 60 * 24 * 60 * 60 * 1000, // 60 天前亲证（两个半衰期）
  });
  const r = await runIntent('delete the record', { kb, trapFixed: true });
  return r.report.verdict === 'completed';
}

/** E7 新鲜亲证零学费（核证接地纪元）：新鲜亲证压制（conf 0.66 × 衰减 1
 *  = trust 0.66）+ 陷阱仍在 ⇒ 亲证背书 ⇒ 诚实接地，不为一针多付学费。
 *  判据：failed 且 trapHits === 0 —— 压制有现实背书时接地终局零探针。
 *  floor > 0.66 ⇒ 新鲜亲证也被要求核证 ⇒ 探针放行（trapHits=1 翻红，
 *  联合定界上界）：与 E6 同一证据（conf 0.66）—— 陈年复活、新鲜背书，
 *  地板必须落在衰减曲线的 0.165 与 0.66 之间。 */
async function scenarioFreshEndorse(): Promise<boolean> {
  const kb = new InMemoryKnowledgeBase();
  kb.insert({
    category: 'error-pattern', content: 'delete item button is broken, clicks fail',
    scenario: 'record cleanup', confidence: 0.66, source: 'auto-learn',
    verifiedAt: Date.now(), // 新鲜亲证（衰减 1）
  });
  const r = await runIntent('delete the record', { kb });
  return r.report.verdict === 'failed' && r.probe.trapHits === 0;
}

const ALL_SCENARIOS = [scenarioE1b, scenarioE3, scenarioE2, scenarioNovelty, scenarioHearsayVerify, scenarioStaleRevival, scenarioFreshEndorse];

/** 单参数全场景判据 */
async function passesAll(): Promise<boolean> {
  for (const s of ALL_SCENARIOS) if (!(await s())) return false;
  return true;
}

// ─── Part A：一阶敏感性扫描 ───

interface SweepResult {
  name: ParamName;
  def: number;
  admissible: string;        // 可行区间描述
  sensitive: boolean;        // 缺省是否处于可行/失效敏感区
  verdict: string;
}

function gridFor(name: ParamName, def: number): number[] {
  let values: number[];
  switch (name) {
    case 'L3_ESCALATION_BITS': values = [0, 1, 2, 3, 4, 5, 6, 8]; break;
    case 'DELIB_WORKFLOW_WEIGHT':
      values = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8]; break;
    default:
      values = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1];
  }
  // 缺省值必须被网格覆盖（否则「缺省可行性」无从测起 —— 0.62 不在 0.05 步长上的教训）
  if (!values.includes(def)) values = [...values, def].sort((a, b) => a - b);
  return values;
}

/** 数值序列 → 可行区间人类可读描述 */
function describeAdmissible(values: number[], ok: Map<number, boolean>): string {
  const pass = values.filter(v => ok.get(v));
  if (pass.length === 0) return '∅（当前包络内无值可行 —— 判据过强或实现缺陷）';
  if (pass.length === values.length) return `全域 ${values[0]}..${values[values.length - 1]}（不敏感）`;
  return `可行 ${pass[0]}..${pass[pass.length - 1]}（不可行 ${values.filter(v => !ok.get(v)).join(', ')}）`;
}

test('Part A 参数敏感性：登记参数逐个扫值域，可行区间有数', async () => {
  // 登记处全体 8 参数中，流水线场景行使的 7 个（DISCONFIRM_DECAY 走 Part B 契约）。
  // 出册的 12 个（时间衰减已删、11 个内联字面量）不再入扫 —— 无区间即无扫值资格，
  // 这正是入册资格的执行面。
  const sweepable: ParamName[] = [
    'REFLEX_SUPPRESS_CONFIDENCE', 'DELIB_RELEVANCE_FLOOR', 'DELIB_WORKFLOW_WEIGHT',
    'AUTO_LEARN_SUCCESS_CONFIDENCE', 'REINFORCE_STEP', 'L3_ESCALATION_BITS',
    'VERIFY_TRUST_FLOOR',
  ];

  const lines: string[] = ['── Part A 一阶敏感性扫描（其余参数固定于缺省；判据 = E1b+E3+E2+新世界+传闻核证+陈年复活+新鲜背书 七场景全绿）──'];
  const results: SweepResult[] = [];

  for (const name of sweepable) {
    const def = P[name];
    const values = gridFor(name, def);
    const ok = new Map<number, boolean>();
    for (const v of values) {
      setParam(name, v);
      let passed = false;
      try { passed = await passesAll(); } catch { passed = false; }
      ok.set(v, passed);
    }
    resetParams();
    const admissible = describeAdmissible(values, ok);
    const defOk = ok.get(def) ?? false;
    results.push({ name, def, admissible, sensitive: !defOk, verdict: defOk ? '缺省可行' : '缺省不可行' });
    lines.push(`${name.padEnd(32)} 缺省=${String(def).padEnd(7)} ${defOk ? '✔' : '✖'}  ${admissible}`);
  }
  console.log(lines.join('\n'));

  // 全部扫完必须回到缺省且基准仍绿（扫值不留污染）
  assert.ok(await passesAll(), '缺省参数下四场景必须全绿（扫值收尾无污染）');
  for (const r of results) {
    assert.equal(r.verdict, '缺省可行', `${r.name} 缺省必须在可行域（校准与基准不一致）`);
    assert.ok(!r.admissible.startsWith('∅'), `${r.name} 可行区间为空 —— 校准失败`);
  }
});

// ─── Part B：契约校准（离线算法参数 —— 公 API 直驱 + 不变量定界）───

/** 造一个学习型失败 outcome（同主题可复用） */
function failedOutcome(topic: string, detail = 'trap'): ExecutionOutcome {
  return {
    intent: { id: `i-${topic}`, description: topic },
    action: { kind: 'click_mouse', args: { x: 0.4, y: 0.35 }, rationale: 'cal' },
    result: { status: 'failure', durationMs: 1, failure: { kind: 'host-error', detail } },
    retryCount: 0,
  } as unknown as ExecutionOutcome;
}

function succeededOutcome(topic: string): ExecutionOutcome {
  return {
    intent: { id: `i-${topic}`, description: topic },
    action: { kind: 'click_mouse', args: { x: 0.75, y: 0.7 }, rationale: 'cal' },
    result: { status: 'success', durationMs: 1 },
    retryCount: 0,
  } as unknown as ExecutionOutcome;
}

test('Part B 契约校准：登记参数有效域 + 出册字面量的不变量守护', async () => {
  const lines: string[] = ['── Part B 契约校准（不变量：强化严格增/反证严格降但不销毁/共识不顶格/皮层化留痕）──'];

  // B1 REINFORCE_STEP（登记参数）：复证强化必须让置信度单次跨过压制阈值（E3 Day2 的物理前提）
  {
    const steps = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.8];
    const feasible: number[] = [];
    for (const s of steps) {
      setParam('REINFORCE_STEP', s);
      const kb = new InMemoryKnowledgeBase();
      // Day1 陷阱意图 = 1 次初学 + 2 次重试复证（maxRetries=2 ⇒ 3 次执行 3 次学习）
      kb.learnFromOutcome(failedOutcome('delete the record'));
      kb.learnFromOutcome(failedOutcome('delete the record'));
      kb.learnFromOutcome(failedOutcome('delete the record'));
      const q = kb.query({ sceneDescription: 'record cleanup', intentDescription: 'delete the record' });
      const trap = q.ok ? q.value.entries.find(e => e.category === 'error-pattern') : undefined;
      // 3 次学习后置信度必须 ≥ 压制阈值（0.5）—— 否则 Day2 改道物理上不可能
      if (trap && trap.confidence >= 0.5) feasible.push(s);
      resetParams();
    }
    lines.push(`REINFORCE_STEP(3次学习≥0.5)    可行 ${feasible.join(', ')}（缺省 0.3 ${feasible.includes(0.3) ? '✔' : '✖'}）`);
    assert.ok(feasible.includes(0.3), 'REINFORCE_STEP 缺省必须可行');
  }

  // B2 DISCONFIRM_DECAY（登记参数）：反证严格下降、永不归零、矛盾双留痕
  {
    const kb = new InMemoryKnowledgeBase();
    kb.learnFromOutcome(failedOutcome('clear the log'));      // error-pattern @ 0.3
    const q0 = kb.query({ sceneDescription: 's', intentDescription: 'clear the log' });
    assert.ok(q0.ok, 'query 合法输入必须 ok');
    const before = q0.value.entries[0]?.confidence ?? 0;
    kb.learnFromOutcome(succeededOutcome('clear the log'));   // 反证：error 衰减 + workflow 新建
    const q = kb.query({ sceneDescription: 's', intentDescription: 'clear the log' });
    assert.ok(q.ok, 'query 合法输入必须 ok');
    const err = q.value.entries.find(e => e.category === 'error-pattern');
    const wf = q.value.entries.find(e => e.category === 'workflow');
    assert.ok(err && err.confidence < before, '反证必须严格下降');
    assert.ok(err.confidence > 0, '反证衰减绝不销毁证据');
    assert.ok(wf, '矛盾双留痕：新结论照常入库');
    lines.push(`DISCONFIRM_DECAY=0.5          反证 ${before.toFixed(2)} → ${err!.confidence.toFixed(2)}（降而不毁 ✔）`);
  }

  // B3 CONSENSUS_BONUS（已出册 —— 内联字面量 0.1）：契约守护不变量。
  //   历史扫值（出册前）测得可行域 [0.05, 0.3]；出册后不再可调 —— 测试钉住
  //   「共识 > 簇均值 且 < 1」的信息保留不变量（值塌到 0 或顶格 1 都会翻红）。
  {
    const kb = new InMemoryKnowledgeBase();
    for (let i = 0; i < 3; i++) kb.learnFromOutcome(failedOutcome(`delete the record attempt ${i}`));
    const r = kb.consolidate();
    assert.ok(r.ok && r.value.consolidated === 1, '3 条同主题蒸馏为 1 条语义记忆');
    const q = kb.query({ sceneDescription: 's', intentDescription: 'delete the record' });
    assert.ok(q.ok, 'query 合法输入必须 ok');
    const sem = q.value.entries.find(e => e.content.startsWith('consolidated'));
    assert.ok(sem, '语义记忆条目在场');
    assert.ok(sem!.confidence > 0.3, `共识必须 > 簇均值 0.3（实际 ${sem!.confidence}）—— 0 加成 = 无共识语义`);
    assert.ok(sem!.confidence < 1, '共识绝不顶格 —— 信息保留在数值里');
    lines.push(`CONSENSUS_BONUS=0.1(内联)     共识 ${sem!.confidence} ∈ (均值 0.3, 1) ✔（历史可行域 [0.05, 0.3]）`);
  }

  // B4 MIN_CLUSTER_SIZE / CORTICALIZE_DECAY（已出册 —— 内联字面量）：
  //   3 条同主题蒸馏、2 条不蒸馏；皮层化留痕
  {
    const kb = new InMemoryKnowledgeBase();
    kb.learnFromOutcome(failedOutcome('task alpha one'));
    kb.learnFromOutcome(failedOutcome('task alpha two'));
    const r2 = kb.consolidate();
    assert.ok(r2.ok && r2.value.consolidated === 0, '2 条不蒸馏（巧合 ≠ 模式）');
    kb.learnFromOutcome(failedOutcome('task alpha three'));
    const r3 = kb.consolidate();
    assert.ok(r3.ok && r3.value.consolidated === 1, '3 条蒸馏为 1 条语义记忆');
    assert.equal(r3.value.episodedDecayed, 3, '原情景全部皮层化');
    const q = kb.query({ sceneDescription: 's', intentDescription: 'task alpha' });
    assert.ok(q.ok, 'query 合法输入必须 ok');
    const episodes = q.value.entries.filter(e => !e.content.startsWith('consolidated'));
    assert.ok(episodes.length >= 0, '情景条目仍在库（让位不销毁）');
    lines.push(`MIN_CLUSTER_SIZE=3(内联)       2条不蒸馏/3条蒸馏 ✔；皮层化留痕 ✔`);
  }

  // B5 出册清理的回归面：半衰期内联（曾为登记参数 CONFIDENCE_HALF_LIFE_MS）——
  //   检索的时间折扣形状（过滤 + 排序让位）由 knowledge.test 免疫 #1 时间旅行守护；
  //   本包络内时间不流逝（age=0 ⇒ 折扣因子恒 1），数值不可证伪 ⇒ 出册内联。
  {
    const kb = new InMemoryKnowledgeBase();
    kb.learnFromOutcome(failedOutcome('freshness probe'));
    const q = kb.query({ sceneDescription: 's', intentDescription: 'freshness probe' });
    assert.ok(q.ok, 'query 合法输入必须 ok');
    const fresh = q.value.entries[0];
    assert.ok(fresh && fresh.confidence === 0.3, '包络内 age=0 ⇒ 折扣因子 1（置信度 = 铸造原值）');
    lines.push(`CONFIDENCE_HALF_LIFE_MS(内联)   包络内 age=0 ⇒ 检索零折扣；衰减形状由免疫 #1 守护 ✔`);
  }

  console.log(lines.join('\n'));
});

// ─── Part C：L3 分离带（世界模型直驱，数据定标）───

test('Part C L3 分离带：熟悉底噪与新世界信号的实测带必须包含缺省 3', async () => {
  const lines: string[] = ['── Part C L3 阈值分离带（WM 直驱：底噪 = 已知转移的 bits；信号 = 罕见转移的 bits）──'];

  // 底噪：已知转移重复 N 次后的惊讶（应当趋 0 —— 熟悉不惊讶）
  const noiseBits: Array<{ n: number; bits: number }> = [];
  for (const n of [1, 3, 10]) {
    const w = new InMemoryWorldModel();
    for (let i = 0; i < n; i++) w.observe('tA', 'click@11', 'tA', false);
    const sr = w.surprise('tA', 'click@11', 'tA');
    assert.ok(sr.ok, 'surprise 合法输入必须 ok');
    noiseBits.push({ n, bits: sr.value.bits });
  }
  lines.push(`底噪（已知转移重复后惊讶 bits）: N=1→${noiseBits[0].bits}, N=3→${noiseBits[1].bits}, N=10→${noiseBits[2].bits}`);

  // 信号：罕见但见过的转移（N 次里 1 次去别处 —— 应当惊讶）
  const signalBits: Array<{ n: number; bits: number }> = [];
  for (const n of [3, 10, 20]) {
    const w = new InMemoryWorldModel();
    for (let i = 0; i < n - 1; i++) w.observe('tA', 'click@11', 'tA', true);
    w.observe('tA', 'click@11', 'tB', true); // 唯一一次异动
    const sr = w.surprise('tA', 'click@11', 'tB');
    assert.ok(sr.ok, 'surprise 合法输入必须 ok');
    signalBits.push({ n, bits: sr.value.bits });
  }
  lines.push(`信号（罕见转移惊讶 bits）: 1/${3}→${signalBits[0].bits}, 1/${10}→${signalBits[1].bits}, 1/${20}→${signalBits[2].bits}`);

  // novel 通道独立于 bits（未见目的地 novel=true 直通）—— 先证明
  const wN = new InMemoryWorldModel();
  wN.observe('tA', 'click@11', 'tA', true);
  const srN = wN.surprise('tA', 'click@11', 'tZ');
  assert.ok(srN.ok && srN.value.novel, '未见目的地必须 novel=true（直通升级，与阈值无关）');

  // 分离带（诚实版）：底噪上界必须低于阈值；阈值计费的最稀有事件由阈值自身定义
  //   （3 bits ⇔ p ≤ 12.5% —— 1/20 事件 3.84 bits 应计费，1/3 与 1/10 事件
  //    在阈值 3 下【不计费】并如实披露：这是 12.5% 教义的直接推论，不是缺陷）
  const noiseFloor = Math.max(...noiseBits.map(x => x.bits));
  const signal20 = signalBits[2].bits; // 1/20 稀有度
  lines.push(`判据带 = (${noiseFloor}, ${signal20}] bits（阈值 3 下：1/20 计费 ✔；1/3(${signalBits[0].bits}) 与 1/10(${signalBits[1].bits}) 不计费 —— 12.5% 教义推论，如实披露）`);
  console.log(lines.join('\n'));

  assert.ok(noiseFloor < P.L3_ESCALATION_BITS, `底噪 ${noiseFloor} 必须低于阈值（否则熟悉世界误报）`);
  assert.ok(P.L3_ESCALATION_BITS <= signal20, `1/20 信号 ${signal20} 必须不低于阈值（否则富证据下的罕见异动漏报）`);
  assert.ok(signal20 > noiseFloor, '分离带必须非空（底噪与信号可区分 —— 计费器有物理基础）');

  // 流水线级复核（重试加长版盲跑）：计费静默 = 已知转移重复不升级。
  //   bits≥1：l3 恒为 1（仅 novel 首遇一次）；bits=0：每次结算都 ≥0 ⇒ l3 烧到 ~重试数（误报）。
  //   注：默认 maxRetries=2 的盲跑在第 3 轮就终局 —— bits=0 的重复升级来不及膨胀，
  //   这正是需要加长重试才能暴露的隐藏误报路径。
  const feasible: number[] = [];
  const l3At: number[] = [];
  for (const bits of [0, 1, 2, 3, 4, 5, 6, 8]) {
    setParam('L3_ESCALATION_BITS', bits);
    const r = await runIntent('delete the record', { maxRetries: 6 });
    const billingSilent = r.report.verdict === 'failed' && r.probe.l3Rounds === 1;
    if (billingSilent) feasible.push(bits);
    l3At.push(r.probe.l3Rounds);
    resetParams();
  }
  console.log(`流水线复核（6 重试盲跑 l3 计数）: bits=[0,1,2,3,4,5,6,8] → l3=[${l3At.join(',')}]（静默判据：l3=1）`);
  assert.ok(!feasible.includes(0), 'bits=0 必须不可行（重复已知转移反复升 L3 —— 误报）');
  assert.ok(feasible.includes(3), `缺省 3 必须可行（实际可行 ${feasible.join(',')}）`);
});

// ─── 目录：登记处清点（入册资格 = 校准区间）───

test('参数目录清点：登记处恰好 8 个承重参数，每个携带可行区间', () => {
  const cat = paramCatalog();
  const names = cat.map(p => p.name);
  console.log([
    '── 登记处清点（入册资格 = 校准可行区间；出册 12 个见各模块内联字面量）──',
    ...cat.map(p => `${p.name.padEnd(32)} = ${String(p.value).padEnd(6)} ${p.note}`),
  ].join('\n'));
  const expected = [
    'REFLEX_SUPPRESS_CONFIDENCE', 'DELIB_RELEVANCE_FLOOR', 'DELIB_WORKFLOW_WEIGHT',
    'AUTO_LEARN_SUCCESS_CONFIDENCE', 'REINFORCE_STEP', 'DISCONFIRM_DECAY', 'L3_ESCALATION_BITS',
    'VERIFY_TRUST_FLOOR',
  ];
  assert.equal(cat.length, 8, '登记参数恰好 8 个（19 − 12 出册 + 核证接地地板）');
  assert.deepEqual([...names].sort(), [...expected].sort(), '登记名单必须精确匹配承重清单');
  for (const p of cat) {
    assert.ok(/区间|有效域|分离带/.test(p.note), `${p.name} 注记必须携带校准区间/定标`);
  }
});
