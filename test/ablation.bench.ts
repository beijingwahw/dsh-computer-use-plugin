// test/ablation.bench.ts
// 消融基准（证据先于修辞）：确定性模拟世界 × 消融矩阵 ⇒ 可复现的对比表。
//
// 三个实验：
//   E1 消融矩阵  —— 知识/仿真/反射/陷阱证据各层对成功率与烧钱数的贡献
//   E2 L3 计费   —— always/surprise/never 三策略的成本-成功率对照
//   E3 学习曲线  —— Day1 踩坑学习 → Day2 持久化改道成功（遗忘症对照组仍失败）
//
// v4 核证纪元注记（E1b）：仅陷阱记忆（传闻压制证据，无活路）的行为从
// 「压制 ⇒ 诚实接地 0 陷阱」变为「压制 + 信任门控不过（传闻 trust 0 <
// VERIFY_TRUST_FLOOR）⇒ 一针核证探针学费 ⇒ 闩锁 ⇒ 诚实接地」——
// 不可信的压制证据不许干瞪眼，必须交一针换亲证（trapHits 1 恰是证词）。
//
// 世界设定（确定性 stub，零随机）：
//   屏幕元素 'delete item'（陷阱：点击必失败）与 'clear log'（活路：点击成功）
//   执行工位按命中元素裁决成败 —— 世界有唯一真相，跑一万次结果相同
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
import { MetricsLedger, summarizeRuns, type RunMetricRecord } from '../src/knowledge/metrics.ts';
import type {
  AtomicAction, PipelineConfig, PipelineReport, ScenePatch,
} from '../src/knowledge/contracts.ts';

// ─── 确定性世界 ───

/** 元素矩形（左上角 + 宽高，归一化） */
const ELEMENTS = [
  { name: 'delete item', x: 0.30, y: 0.30, w: 0.20, h: 0.10 }, // 陷阱
  { name: 'clear log', x: 0.65, y: 0.65, w: 0.20, h: 0.10 },   // 活路
] as const;

const WORLD_SCENE: ScenePatch[] = [{
  region: { id: 'g0x0', x: 0, y: 0, width: 1, height: 1 },
  elements: ELEMENTS.map(e => ({
    source: 'L1-tree' as const, role: 'button', name: e.name,
    rect: { x: e.x, y: e.y, width: e.w, height: e.h },
  })),
  funnelDepth: 'L1' as const,
  capturedAt: 0,
}];

/** 命中测试：点落在哪个元素内（世界真相的裁决器） */
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

/** 种子知识：「老员工的笔记」（manual 通道 —— D-7 的经验先验） */
function seedKnowledge(kb: InMemoryKnowledgeBase, variant: 'both' | 'workflow-only' | 'none'): void {
  if (variant === 'both') {
    kb.insert({ category: 'error-pattern', content: 'delete item button is broken, clicks fail', scenario: 'record cleanup', confidence: 0.55, source: 'manual' });
    kb.insert({ category: 'workflow', content: 'clear log after erasing records', scenario: 'record cleanup', confidence: 0.6, source: 'manual' });
  } else if (variant === 'workflow-only') {
    kb.insert({ category: 'workflow', content: 'clear log after erasing records', scenario: 'record cleanup', confidence: 0.6, source: 'manual' });
  }
}

/** 装配一套确定性工位（视觉记录 L3 开火；执行按世界真相裁决） */
function rigStations() {
  const probe = { l3Rounds: 0, executions: 0, trapHits: 0 };
  return {
    probe,
    vision: {
      async perceive(env: any): Promise<ScenePatch[]> {
        if (env?.payload?.forceL3) probe.l3Rounds += 1;
        return WORLD_SCENE;
      },
    },
    decision: null as null | ReflexiveDecisionStation, // 由调用方注入（消融变体）
    execution: {
      async execute(env: any) {
        probe.executions += 1;
        const a = env.payload as AtomicAction;
        const hit = typeof a.args?.x === 'number' && typeof a.args?.y === 'number'
          ? hitElement(a.args.x, a.args.y) : null;
        if (hit === 'delete item') {
          probe.trapHits += 1;
          return {
            action: a, status: 'failure' as const, durationMs: 1,
            failure: { kind: 'host-error' as const, detail: 'delete item is broken' },
          };
        }
        return { action: a, status: 'success' as const, durationMs: 1 };
      },
    },
  };
}

/** 跑一个意图并回传报告 + 探针 */
async function runIntent(
  label: string,
  intentDescription: string,
  opts: {
    seeds?: 'both' | 'workflow-only' | 'none';
    stationOpts?: { disableReflex?: boolean; disableDeliberation?: boolean };
    ablation?: PipelineConfig['ablation'];
    kb?: InMemoryKnowledgeBase;       // 注入既有脑（跨会话）
    wm?: InMemoryWorldModel;
    stateDir?: string;                 // 持久化目录
    metricsPath?: string;
  } = {},
): Promise<{ report: PipelineReport; probe: { l3Rounds: number; executions: number; trapHits: number } }> {
  const kb = opts.kb ?? new InMemoryKnowledgeBase();
  if (opts.seeds) seedKnowledge(kb, opts.seeds);
  const wm = opts.wm ?? new InMemoryWorldModel();
  const rig = rigStations();
  const decision = new ReflexiveDecisionStation({ chat: null, ...opts.stationOpts });
  const o = new KnowledgePipelineOrchestrator();
  const cfg: PipelineConfig = { ...BENCH_CONFIG, ablation: opts.ablation };
  assert.ok(o.configure(cfg).ok);
  o.wire(
    {
      vision: rig.vision, decision, execution: rig.execution,
      knowledge: kb, verdictBridge: new DoctorVerdictBridge(), emit: () => { /* 旁路 */ },
    },
    { stateDir: opts.stateDir, metricsPath: opts.metricsPath },
  );
  const report = await o.run({ id: label, description: intentDescription });
  return { report, probe: rig.probe };
}

/** 表格行（仪表盘的视觉面） */
function row(label: string, report: PipelineReport, probe: { l3Rounds: number; executions: number; trapHits: number }): string {
  return `${label.padEnd(26)} ${report.verdict.padEnd(10)} executions=${String(probe.executions).padEnd(2)} trapHits=${probe.trapHits} l3=${probe.l3Rounds}`;
}

// ─── E1：消融矩阵（知识/仿真/反射/陷阱证据的贡献）───

test('E1 消融矩阵：每层的贡献都有数字（确定性世界，可复现）', async () => {
  const INTENT = 'erase the record'; // 零词汇重合 ⇒ 强制走慢路径裁决
  const results: string[] = ['── E1 消融矩阵（intent: "erase the record", 种子=老员工笔记）──'];

  const full = await runIntent('full', INTENT, { seeds: 'both' });
  results.push(row('full（全层开）', full.report, full.probe));

  const noKnowledge = await runIntent('no-knowledge', INTENT, { seeds: 'both', ablation: { disableKnowledge: true } });
  results.push(row('no-knowledge（检索/学习断电）', noKnowledge.report, noKnowledge.probe));

  const noDelib = await runIntent('no-deliberation', INTENT, { seeds: 'both', stationOpts: { disableDeliberation: true } });
  results.push(row('no-deliberation（前额叶断电）', noDelib.report, noDelib.probe));

  const noReflex = await runIntent('no-reflex', INTENT, { seeds: 'both', stationOpts: { disableReflex: true } });
  results.push(row('no-reflex（脊髓断电）', noReflex.report, noReflex.probe));

  const noErrorEv = await runIntent('workflow-only-seed', INTENT, { seeds: 'workflow-only' });
  results.push(row('无陷阱证据（仅 workflow）', noErrorEv.report, noErrorEv.probe));

  console.log(results.join('\n'));

  // 断言（证据即测试）：全层 ⇒ 仿真借 workflow 证据零样本命中活路
  assert.equal(full.report.verdict, 'completed', `full 应成功: ${full.report.terminalReason}`);
  assert.equal(full.probe.executions, 1, '活路一次命中（零浪费）');
  // 知识断电 ⇒ 仿真无米下锅 ⇒ 诚实接地（无隐知识模式失败）
  assert.equal(noKnowledge.report.verdict, 'failed');
  assert.match(noKnowledge.report.terminalReason, /need-grounding/);
  // 仿真断电 ⇒ 反射无弧直接接地
  assert.equal(noDelib.report.verdict, 'failed');
  // 反射断电 ⇒ 仿真兜住（本世界零重合意图不需要反射 —— 层级冗余的诚实测量）
  assert.equal(noReflex.report.verdict, 'completed');
  // 陷阱证据缺席 ⇒ workflow 单证据仍够用（本世界冗余 —— 换世界未必）
  assert.equal(noErrorEv.report.verdict, 'completed');
});

test('E1b 陷阱改道：高置信陷阱记忆 + 字面诱惑 intent ⇒ 免疫压制 + 前额叶改道', async () => {
  // intent "delete the record" 与陷阱元素 'delete item' 有字面吸引力（Tier 1 会点它）
  const INTENT = 'delete the record';
  const lines: string[] = ['── E1b 陷阱改道（intent: "delete the record", 反射有字面诱惑）──'];

  const saved = await runIntent('full-seeded', INTENT, { seeds: 'both' });
  lines.push(row('full（陷阱记忆@0.55+workflow）', saved.report, saved.probe));

  const blind = await runIntent('no-knowledge', INTENT, { seeds: 'none', ablation: { disableKnowledge: true } });
  lines.push(row('无知识（反射直扑陷阱）', blind.report, blind.probe));

  const knowTrapOnly = await runIntent('trap-only', INTENT, { seeds: 'none' });
  // 手工注入：只有陷阱记忆（知道哪错，不知道活路在哪）
  {
    const kb = new InMemoryKnowledgeBase();
    kb.insert({ category: 'error-pattern', content: 'delete item button is broken, clicks fail', scenario: 'record cleanup', confidence: 0.55, source: 'manual' });
    const r = await runIntent('trap-only', INTENT, { kb });
    lines.push(row('仅陷阱记忆（无活路知识）', r.report, r.probe));
    knowTrapOnly.report = r.report; knowTrapOnly.probe = r.probe;
  }

  console.log(lines.join('\n'));

  // 全层：免疫压制字面反射 + 仿真改道活路 ⇒ 成功且零陷阱点击
  assert.equal(saved.report.verdict, 'completed', `应改道成功: ${saved.report.terminalReason}`);
  assert.equal(saved.probe.trapHits, 0, '陷阱记忆应完全避开陷阱');
  // 无知识：反射直扑陷阱，烧满重试后失败
  assert.equal(blind.report.verdict, 'failed');
  assert.ok(blind.probe.trapHits >= 3, `无知识应反复踩坑（实际 ${blind.probe.trapHits} 次）`);
  // 仅陷阱记忆（v4 核证纪元）：压制 + 无活路 + 传闻证据（trust 0 < 地板）⇒
  // 不许干瞪眼接地 —— 放行一针核证探针（学费 1 次踩坑 + 亲证诞生），
  // 闩锁执法后 run 内重试直接诚实接地。知道哪错 ≠ 知道怎么对：探针只买
  // 「陷阱确实坏」的亲证，买不到活路 —— verdict 仍 failed（知识的半truth）。
  assert.equal(knowTrapOnly.report.verdict, 'failed');
  assert.equal(knowTrapOnly.probe.executions, 1, '一 run 一针（探针后闩锁 ⇒ 重试不再放行）');
  assert.equal(knowTrapOnly.probe.trapHits, 1, '传闻压制证据 ⇒ 一针核证学费（非漏报 —— 知情验证）');
});

// ─── E2：L3 计费策略对照 ───

test('E2 L3 计费：熟悉世界三策略成功率等价，成本 surprise=0 << always', async () => {
  const lines: string[] = ['── E2 L3 计费策略（L1 全可见的熟悉世界 × 3 runs）──'];
  const INTENT = 'erase the record';
  const RUNS = 3;

  const policies = ['always', 'surprise', 'never'] as const;
  const l3Total: Record<string, number> = {};
  for (const p of policies) {
    const stateDir = mkdtempSync(join(tmpdir(), `d7-l3-${p}-`));
    try {
      let l3 = 0;
      let completed = 0;
      for (let i = 0; i < RUNS; i++) {
        const r = await runIntent(`${p}-${i}`, INTENT, { seeds: 'both', ablation: { l3Policy: p }, stateDir });
        l3 += r.probe.l3Rounds;
        if (r.report.verdict === 'completed') completed += 1;
      }
      l3Total[p] = l3;
      lines.push(`${p.padEnd(9)} success=${completed}/${RUNS} l3Rounds=${l3} (${(l3 / RUNS).toFixed(2)}/run)`);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }
  console.log(lines.join('\n'));

  // 熟悉世界（L1 全可见）：三策略成功率等价 —— 成本是唯一差
  assert.equal(l3Total.always, RUNS, 'always 每轮都开（成本上限）');
  assert.equal(l3Total.surprise, 0, 'surprise：熟悉世界零 L3 开销（惊讶计费器的价值）');
  assert.equal(l3Total.never, 0, 'never 恒关');
});

// ─── E3：学习曲线 + 遗忘症对照组（旗舰）───

test('E3 学习曲线：Day1 踩坑 → Day2 持久化改道成功；遗忘症对照组仍失败', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'd7-learn-'));
  const amnesiaDir = mkdtempSync(join(tmpdir(), 'd7-amnesia-'));
  const metricsPath = join(stateDir, 'metrics.jsonl');
  const lines: string[] = ['── E3 学习曲线（无种子知识，一切靠自体经历）──'];
  try {
    // Day 1-1：字面诱惑 intent 直扑陷阱（反射+重试烧钱后失败，学习陷阱记忆）
    const d1trap = await runIntent('d1-trap', 'delete the record', { stateDir, metricsPath });
    lines.push(row('Day1 "delete the record"', d1trap.report, d1trap.probe));

    // Day 1-2：活路 intent 反射命中（成功，学习 workflow 记忆）
    const d1safe = await runIntent('d1-safe', 'clear the log', { stateDir, metricsPath });
    lines.push(row('Day1 "clear the log"', d1safe.report, d1safe.probe));

    // Day 2：同陷阱 intent —— 新编排器实例（新会话语义），旧脑从 stateDir 水合
    const d2 = await runIntent('d2-trap', 'delete the record', { stateDir, metricsPath });
    lines.push(row('Day2 "delete the record"（旧脑水合）', d2.report, d2.probe));

    // Day 2 遗忘症对照：同配置、无旧脑（每次重启都失忆的世界）
    const d2amnesia = await runIntent('d2-amnesia', 'delete the record', { stateDir: amnesiaDir });
    lines.push(row('Day2 遗忘症对照（无旧脑）', d2amnesia.report, d2amnesia.probe));

    // 仪表盘：账本读回 + 学习曲线聚合
    const ledger = new MetricsLedger(metricsPath);
    const { records } = ledger.readAll();
    const curve = { first: summarizeRuns(records.slice(0, 2)), second: summarizeRuns(records.slice(2)) };
    lines.push(`仪表盘: runs=${records.length} Day1(success=${curve.first.successRate}, avgExec=${curve.first.avgExecutions}) → Day2(success=${curve.second.successRate}, avgExec=${curve.second.avgExecutions})`);
    console.log(lines.join('\n'));

    // 断言：学习闭环成立
    assert.equal(d1trap.report.verdict, 'failed', 'Day1 陷阱意图失败（无先验知识）');
    assert.ok(d1trap.probe.trapHits >= 3, 'Day1 反复踩坑（学费）');
    assert.equal(d1safe.report.verdict, 'completed', 'Day1 活路意图成功');
    // 旗舰断言：Day2 同意图从 failed → completed（经验活过了会话边界）
    assert.equal(d2.report.verdict, 'completed', `Day2 应凭旧脑改道成功: ${d2.report.terminalReason}`);
    assert.equal(d2.probe.trapHits, 0, 'Day2 零陷阱点击（免疫记忆生效）');
    assert.equal(d2.probe.executions, 1, 'Day2 一次命中活路');
    // 遗忘症对照：无旧脑 ⇒ 同意图仍失败 —— 证明是持久化（不是运气/缓存）带来改善
    assert.equal(d2amnesia.report.verdict, 'failed', '遗忘症对照组必须仍失败（反事实证据）');
    assert.ok(d2amnesia.probe.trapHits >= 3, '遗忘症照旧踩坑');
    // 仪表盘：Day2 success 1.0 vs Day1 0.5；账本忠实
    assert.equal(records.length, 3);
    assert.equal(curve.second.successRate, 1);
    assert.equal(curve.first.successRate, 0.5);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(amnesiaDir, { recursive: true, force: true });
  }
});
