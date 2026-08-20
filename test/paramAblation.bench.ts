// test/paramAblation.bench.ts
// 参数级消融基准 —— 8 个承重参数逐一「拔掉」（设为失效值），与基准（全缺省）对照。
//
// 与机构级消融（ablation.bench.ts：知识/仿真/反射/计费各层断电）互补：
// 这里的消融单位是参数本身 —— 每个登记参数必须至少被一个失效值击穿至少
// 一个权威场景，否则它不承重（应出册）。「承重」不是主张，是可复现的翻红记录。
//
// 九个权威场景（判据与 ablation/calibration 基准一字不改）：
//   S1 改道  E1b-seeded：陷阱记忆在场 ⇒ 免疫压制 + 前额叶改道（completed + 0 陷阱点击 + 1 次执行）
//   S2 直扑  E1b-blind ：无知识 ⇒ 反射直扑陷阱（failed + ≥3 陷阱点击）
//   S3 学习  E3        ：Day1 踩坑/活路 → Day2 旧脑改道；遗忘症对照仍失败
//   S4 静默  E2        ：熟悉世界 surprise 策略零 L3 开销（计费器不误报）
//   S5 开火  Novelty   ：新世界首遇恰升一次 L3（l3 = 1）
//   S6 反证  契约      ：失败证据经成功反证 ⇒ 置信度严格下降且绝不归零
//   S7 计费带 分离带    ：WM 直驱 —— 熟悉底噪不计费（不误报）且 1/20 稀有信号计费（不漏报）
//   （S7 与 calibration Part C 分离带判据同构：bits 的两个失效方向只有在这里
//     双向可见 —— 流水线场景里误报需多轮转移膨胀、漏报被 novel 直通掩盖）
//   S8 水合  E1-长期   ：无活路证据的学习世界 —— Day1 学费 ⇒ Day2 越线压制 ⇒
//   诚实接地零学费（failed + 0 陷阱点击）。与 calibration Part A 的
//   REINFORCE_STEP 物理约束判据同构（3 次执行内 0.3 必须越过压制阈值）：
//   采纳 fail-heavy 向量（W=6/AUTO_LEARN=1）后，S3 的改道可由托举证据在
//   未压制时达成 —— 步长的承重面只剩「无活路时压制止血」这一条路，S8 守它。
//   S9 核证  E5/E6/E7 ：核证接地三态 —— 传闻压制一针核证（failed+1t）/
//   陈年亲证复活探针（completed）/ 新鲜亲证零学费接地（failed+0t）。
//   与 calibration Part A 的 VERIFY_TRUST_FLOOR 定界判据同构：地板的双向
//   失效（全信 ⇒ 传闻不核证 + 陈年不复活；全疑 ⇒ 亲证不背书）只有在这里
//   双向可见 —— 信任门控的两个失效方向各翻红一态。
//
// 消融方向（失效值的选择 = 把该参数的机制推到失效边界）：
//   REFLEX_SUPPRESS_CONFIDENCE=1.0   免疫失能（置信度够不着顶格阈值 ⇒ 永不压制）
//   DELIB_RELEVANCE_FLOOR=1.0        证据全出局（相关性地板顶格 ⇒ 前额叶无米下锅）
//   DELIB_WORKFLOW_WEIGHT=0          活路无托举（workflow 证据零效用）
//   AUTO_LEARN_SUCCESS_CONFIDENCE=0  成功学习失能（成功经历不立信）
//   REINFORCE_STEP=0                 复证失能（置信度永不增长）
//   DISCONFIRM_DECAY=1 / =0          反证失能·不降 / ·归零（证据销毁）
//   L3_ESCALATION_BITS=0 / =99       计费误报（一切皆意外）/ 漏报（bits 通道永不升级）
//   VERIFY_TRUST_FLOOR=0 / =1        核证失能·全信（传闻自背书，不探针）/
//                                    核证失能·全疑（亲证不背书，逢压制必探针）
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
import { setParam, resetParams, P, type ParamName } from '../src/knowledge/params.ts';
import type {
  AtomicAction, ExecutionOutcome, PipelineConfig, PipelineReport, ScenePatch,
} from '../src/knowledge/contracts.ts';

// ─── 确定性世界（与 ablation.bench.ts 同构：跑一万次结果相同）───

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

let runCounter = 0;

/** 跑一个意图（注意：station 在此构造 —— REFLEX_SUPPRESS_CONFIDENCE 是构造时快照，
 *  消融必须在 runIntent 之前 setParam 才生效） */
async function runIntent(
  intentDescription: string,
  opts: {
    seeds?: boolean; kb?: InMemoryKnowledgeBase; stateDir?: string;
    /** S9a 传闻核证：只注 error-pattern 传闻种子（无 workflow 活路证据） */
    hearsayTrap?: boolean;
    /** S9b 陈年复活：陷阱已修好（delete item 点击成功 —— 忏悔世界） */
    trapFixed?: boolean;
  } = {},
): Promise<{ report: PipelineReport; probe: { l3Rounds: number; executions: number; trapHits: number } }> {
  const kb = opts.kb ?? new InMemoryKnowledgeBase();
  if (opts.seeds) {
    kb.insert({ category: 'error-pattern', content: 'delete item button is broken, clicks fail', scenario: 'record cleanup', confidence: 0.55, source: 'manual' });
    kb.insert({ category: 'workflow', content: 'clear log after erasing records', scenario: 'record cleanup', confidence: 0.6, source: 'manual' });
  }
  if (opts.hearsayTrap) {
    kb.insert({ category: 'error-pattern', content: 'delete item button is broken, clicks fail', scenario: 'record cleanup', confidence: 0.55, source: 'manual' });
  }
  const probe = { l3Rounds: 0, executions: 0, trapHits: 0 };
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
        return { action: a, status: 'success' as const, durationMs: 1 };
      },
    },
  };
  const o = new KnowledgePipelineOrchestrator();
  assert.ok(o.configure(BENCH_CONFIG).ok);
  o.wire(
    {
      vision: rig.vision, decision: new ReflexiveDecisionStation({ chat: null }),
      execution: rig.execution, knowledge: kb, verdictBridge: new DoctorVerdictBridge(),
      emit: () => { /* 旁路 */ },
    },
    { stateDir: opts.stateDir },
  );
  const report = await o.run({ id: `pab-${++runCounter}`, description: intentDescription });
  return { report, probe };
}

/** 造一个学习型失败 outcome（S6 契约场景直驱知识库） */
function failedOutcome(topic: string): ExecutionOutcome {
  return {
    intent: { id: `i-${topic}`, description: topic },
    action: { kind: 'click_mouse', args: { x: 0.4, y: 0.35 }, rationale: 'pab' },
    result: { status: 'failure', durationMs: 1, failure: { kind: 'host-error', detail: 'trap' } },
    retryCount: 0,
  } as unknown as ExecutionOutcome;
}

function succeededOutcome(topic: string): ExecutionOutcome {
  return {
    intent: { id: `i-${topic}`, description: topic },
    action: { kind: 'click_mouse', args: { x: 0.75, y: 0.7 }, rationale: 'pab' },
    result: { status: 'success', durationMs: 1 },
    retryCount: 0,
  } as unknown as ExecutionOutcome;
}

// ─── 六个权威场景（判据一字不改；返回结构化结果供报告）───

interface SceneOutcome { pass: boolean; detail: string }

const SCENES: Array<{ key: string; name: string; run: () => Promise<SceneOutcome> }> = [
  {
    key: 'S1', name: '改道',
    run: async () => {
      const r = await runIntent('delete the record', { seeds: true });
      const pass = r.report.verdict === 'completed' && r.probe.trapHits === 0 && r.probe.executions === 1;
      return { pass, detail: `${r.report.verdict}/exec=${r.probe.executions}/trap=${r.probe.trapHits}` };
    },
  },
  {
    key: 'S2', name: '直扑',
    run: async () => {
      const r = await runIntent('delete the record', {});
      const pass = r.report.verdict === 'failed' && r.probe.trapHits >= 3;
      return { pass, detail: `${r.report.verdict}/trap=${r.probe.trapHits}` };
    },
  },
  {
    key: 'S3', name: '学习',
    run: async () => {
      const dir = mkdtempSync(join(tmpdir(), 'd7-pab-'));
      try {
        const d1t = await runIntent('delete the record', { stateDir: dir });
        const d1s = await runIntent('clear the log', { stateDir: dir });
        const d2 = await runIntent('delete the record', { stateDir: dir });
        const am = await runIntent('delete the record', {});
        const pass = d1t.report.verdict === 'failed' && d1s.report.verdict === 'completed'
          && d2.report.verdict === 'completed' && d2.probe.trapHits === 0 && d2.probe.executions === 1
          && am.report.verdict === 'failed';
        return {
          pass,
          detail: `d1:${d1t.report.verdict}/${d1t.probe.trapHits}t d1s:${d1s.report.verdict} d2:${d2.report.verdict}/${d2.probe.executions}e/${d2.probe.trapHits}t 失忆:${am.report.verdict}`,
        };
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  },
  {
    key: 'S4', name: '静默',
    run: async () => {
      const r = await runIntent('erase the record', { seeds: true });
      const pass = r.report.verdict === 'completed' && r.probe.l3Rounds === 0;
      return { pass, detail: `${r.report.verdict}/l3=${r.probe.l3Rounds}` };
    },
  },
  {
    key: 'S5', name: '开火',
    run: async () => {
      const r = await runIntent('delete the record', {});
      const pass = r.report.verdict === 'failed' && r.probe.l3Rounds === 1;
      return { pass, detail: `${r.report.verdict}/l3=${r.probe.l3Rounds}` };
    },
  },
  {
    key: 'S6', name: '反证',
    run: async () => {
      const kb = new InMemoryKnowledgeBase();
      kb.learnFromOutcome(failedOutcome('clear the log'));
      const q0 = kb.query({ sceneDescription: 's', intentDescription: 'clear the log' });
      const before = q0.ok ? (q0.value.entries.find(e => e.category === 'error-pattern')?.confidence ?? 0) : 0;
      kb.learnFromOutcome(succeededOutcome('clear the log'));
      const q = kb.query({ sceneDescription: 's', intentDescription: 'clear the log' });
      const err = q.ok ? q.value.entries.find(e => e.category === 'error-pattern') : undefined;
      const pass = !!err && err.confidence < before && err.confidence > 0;
      return { pass, detail: err ? `error ${before.toFixed(2)}→${err.confidence.toFixed(2)}` : `error ${before.toFixed(2)}→条目销毁` };
    },
  },
  {
    key: 'S7', name: '计费带',
    run: async () => {
      // 熟悉底噪：tA→tA 重复 10 次（应当趋 0 —— 熟悉不惊讶）
      const wNoise = new InMemoryWorldModel();
      for (let i = 0; i < 10; i++) wNoise.observe('tA', 'click@11', 'tA', false);
      const noise = wNoise.surprise('tA', 'click@11', 'tA');
      // 稀有信号：20 次里恰 1 次去 tB（1/20 稀有度 ≈ 3.84 bits）
      const wSignal = new InMemoryWorldModel();
      for (let i = 0; i < 19; i++) wSignal.observe('tA', 'click@11', 'tA', true);
      wSignal.observe('tA', 'click@11', 'tB', true);
      const signal = wSignal.surprise('tA', 'click@11', 'tB');
      if (!noise.ok || !signal.ok) return { pass: false, detail: 'surprise 域外拒绝（非法输入）' };
      // 计费判定式（与 pipeline.ts 升级判定同构）：novel || bits >= 阈值
      const t = P.L3_ESCALATION_BITS;
      const noiseFires = noise.value.novel || noise.value.bits >= t;
      const signalFires = signal.value.novel || signal.value.bits >= t;
      const pass = !noiseFires && signalFires;
      return {
        pass,
        detail: `底噪${noise.value.bits.toFixed(2)}b${noiseFires ? '误报' : '静默'}/信号${signal.value.bits.toFixed(2)}b${signalFires ? '计费' : '漏报'}（阈值 ${t}）`,
      };
    },
  },
  {
    key: 'S8', name: '水合',
    run: async () => {
      // 无活路证据的学习世界（E1 长期世界的 2 日浓缩）：Day1 交学费铸造错误
      // 记忆（3 次执行内 0.3 必须越过压制阈值 —— calibration Part A 判据）；
      // Day2 压制生效 ⇒ 前额叶无米下锅 ⇒ 诚实接地 —— 学费归零但不再踩坑。
      // step=0（复证失能）⇒ Day2 记忆 0.3 低于阈值 ⇒ 不压制 ⇒ 再交 3 次学费。
      const dir = mkdtempSync(join(tmpdir(), 'd7-pab-hydr'));
      try {
        const d1 = await runIntent('delete the record', { stateDir: dir });
        const d2 = await runIntent('delete the record', { stateDir: dir });
        const pass = d1.report.verdict === 'failed' && d1.probe.trapHits >= 1
          && d2.report.verdict === 'failed' && d2.probe.trapHits === 0;
        return {
          pass,
          detail: `d1:${d1.report.verdict}/${d1.probe.trapHits}t d2:${d2.report.verdict}/${d2.probe.trapHits}t（压制止血）`,
        };
      } finally { rmSync(dir, { recursive: true, force: true }); }
      // 注：d2 判 failed + 0 陷阱 = 「知道哪错但没学过别的路」的诚实接地 ——
      // 这是 REINFORCE_STEP 在无活路世界的全部承重面（越线 ⇒ 止血）。
    },
  },
  {
    key: 'S9', name: '核证',
    run: async () => {
      // 核证接地三态（判据与 calibration E5/E6/E7 一字不改）：
      //   a 传闻压制（trust 0）⇒ 一针核证：探针放行本能弧 → 失败 → 闩锁 → 诚实接地
      //   b 陈年亲证（trust 0.165 < floor）⇒ 复活探针：陷阱已修好 → 破局成功
      //   c 新鲜亲证（trust 0.66 ≥ floor）⇒ 自背书：诚实接地零学费
      const a = await runIntent('delete the record', { hearsayTrap: true });
      const staleKb = new InMemoryKnowledgeBase();
      staleKb.insert({
        category: 'error-pattern', content: 'delete item button is broken, clicks fail',
        scenario: 'record cleanup', confidence: 0.66, source: 'auto-learn',
        verifiedAt: Date.now() - 60 * 24 * 60 * 60 * 1000, // 60 天前亲证（两个半衰期）
      });
      const b = await runIntent('delete the record', { kb: staleKb, trapFixed: true });
      const freshKb = new InMemoryKnowledgeBase();
      freshKb.insert({
        category: 'error-pattern', content: 'delete item button is broken, clicks fail',
        scenario: 'record cleanup', confidence: 0.66, source: 'auto-learn',
        verifiedAt: Date.now(), // 新鲜亲证（衰减 1）
      });
      const c = await runIntent('delete the record', { kb: freshKb });
      const pass = a.report.verdict === 'failed' && a.probe.trapHits === 1
        && b.report.verdict === 'completed'
        && c.report.verdict === 'failed' && c.probe.trapHits === 0;
      return {
        pass,
        detail: `传闻:${a.report.verdict}/${a.probe.trapHits}t 陈年:${b.report.verdict} 新鲜:${c.report.verdict}/${c.probe.trapHits}t`,
      };
    },
  },
];

// ─── 消融变体（8 参数 × 11 个失效方向）───

interface Ablation {
  param: ParamName;
  value: number;
  label: string;
}

const ABLATIONS: Ablation[] = [
  { param: 'REFLEX_SUPPRESS_CONFIDENCE', value: 1.0, label: '免疫失能（阈值 1.0 ⇒ 永不压制）' },
  { param: 'DELIB_RELEVANCE_FLOOR', value: 1.0, label: '证据全出局（地板 1.0 ⇒ 无证据入局）' },
  { param: 'DELIB_WORKFLOW_WEIGHT', value: 0, label: '活路无托举（权重 0）' },
  { param: 'AUTO_LEARN_SUCCESS_CONFIDENCE', value: 0, label: '成功学习失能（铸造 0）' },
  { param: 'REINFORCE_STEP', value: 0, label: '复证失能（步长 0 ⇒ 置信度不增长）' },
  { param: 'DISCONFIRM_DECAY', value: 1, label: '反证失能·不降（因子 1）' },
  { param: 'DISCONFIRM_DECAY', value: 0, label: '反证失能·归零（因子 0 ⇒ 销毁证据）' },
  { param: 'L3_ESCALATION_BITS', value: 0, label: '计费误报（阈值 0 ⇒ 一切皆意外）' },
  { param: 'L3_ESCALATION_BITS', value: 99, label: '计费漏报（阈值 99 ⇒ bits 通道永不升级）' },
  { param: 'VERIFY_TRUST_FLOOR', value: 0, label: '核证失能·全信（地板 0 ⇒ 传闻自背书，不探针）' },
  { param: 'VERIFY_TRUST_FLOOR', value: 1, label: '核证失能·全疑（地板 1 ⇒ 亲证不背书，逢压制必探针）' },
];

test('参数消融矩阵：基准全绿 + 每个承重参数至少击穿一个场景', async () => {
  const lines: string[] = [];
  const header = `变体(${' '.repeat(34)}${SCENES.map(s => s.key).join('  ')}  击穿`;
  lines.push('── 参数消融矩阵（✓=绿 ✗=翻红；判据 = S1改道/S2直扑/S3学习/S4静默/S5开火/S6反证/S7计费带/S8水合/S9核证）──');
  lines.push(`变体${' '.repeat(46)}${SCENES.map(s => `${s.key}${s.name}`).join('  ')}`);

  // 基准行（全缺省）：全部场景必须全绿 —— 消融对照的原点
  resetParams();
  const baseline: SceneOutcome[] = [];
  for (const s of SCENES) baseline.push(await s.run());
  const baseMarks = baseline.map(o => (o.pass ? '✓' : '✗')).join('   ');
  lines.push(`${'baseline（全缺省）'.padEnd(46)}${baseMarks}   0`);
  assert.ok(baseline.every(o => o.pass), `基准必须全绿：${baseline.map(o => o.detail).join(' | ')}`);

  // 消融行：每个失效方向 × 全部场景
  const breached = new Map<ParamName, string[]>();
  const details: string[] = [];
  for (const ab of ABLATIONS) {
    setParam(ab.param, ab.value);
    const outcomes: SceneOutcome[] = [];
    for (const s of SCENES) {
      let o: SceneOutcome;
      try { o = await s.run(); } catch (e) { o = { pass: false, detail: `throw: ${(e as Error).message}` }; }
      outcomes.push(o);
    }
    resetParams();
    const fails = SCENES.filter((_, i) => !outcomes[i].pass).map((s, i) => `${s.key}${s.name}`);
    for (const f of fails) {
      const cur = breached.get(ab.param) ?? [];
      cur.push(`${f}@${ab.value}`);
      breached.set(ab.param, cur);
    }
    const marks = outcomes.map(o => (o.pass ? '✓' : '✗')).join('   ');
    lines.push(`${`${ab.param}=${ab.value}`.padEnd(46)}${marks}   ${fails.length}`);
    // 翻红场景的实测明细（vs 基准）—— 报告的证词
    SCENES.forEach((s, i) => {
      if (!outcomes[i].pass) details.push(`  ✗ ${ab.param}=${ab.value} [${s.key}${s.name}] 实测 ${outcomes[i].detail}（基准 ${baseline[i].detail}）`);
    });
  }

  lines.push('', '── 翻红明细（实测 vs 基准）──');
  lines.push(...details);

  // 承重性总结：每个参数至少一个失效方向击穿至少一个场景
  lines.push('', '── 承重结论（击穿场景清单 = 参数的承重面向）──');
  const params = [...new Set(ABLATIONS.map(a => a.param))];
  for (const p of params) {
    const hits = breached.get(p) ?? [];
    lines.push(`${p.padEnd(32)} ${hits.length > 0 ? `击穿: ${[...new Set(hits.map(h => h.split('@')[0]))].join(', ')}` : '零击穿 —— 不承重，应出册'}`);
  }
  console.log(lines.join('\n'));

  for (const p of params) {
    assert.ok((breached.get(p) ?? []).length > 0,
      `${p} 的所有消融方向均未击穿任何场景 —— 该参数在当前判据下不承重，入册资格存疑（应出册或补场景）`);
  }
  // 收尾无污染：消融扫完回到基准全绿
  const after: SceneOutcome[] = [];
  for (const s of SCENES) after.push(await s.run());
  assert.ok(after.every(o => o.pass), 'resetParams 后必须回到基准全绿（扫值不留污染）');
});
