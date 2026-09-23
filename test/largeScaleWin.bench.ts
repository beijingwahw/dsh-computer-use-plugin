// test/largeScaleWin.bench.ts
// 大规模真机验证（Windows）—— 在本地 DeepSeek Harness 物理链路上以大量实际
// 复杂任务验证方案准确性：
//   感知 = D-5 服务真截屏（mmap-file）→ tesseract.js OCR（离线仓根语言包）
//   决策 = ReflexiveDecisionStation 四层脑（免疫压制 / 脊髓反射 / 前额叶仿真）
//   执行 = D-5 服务 /v1/click = 真 pyautogui（真鼠标）→ tkinter 回调真实触发
//   裁决 = 应用状态文件（世界真相，非脚本裁决）
//   记忆 = InMemoryKnowledgeBase + stateDir 反遗忘水合（学习曲线的载体）
//
// 世界：Data Console（5 页 × 6 控件 + 5 导航，每屏 12+ 文本元素），
//       陷阱族跨 archive/network/files 三页分布。
// 任务：11 类 51 项 —— 导航 / 页内反射 / 种子陷阱规避 / 学习曲线（含遗忘症
//       对照）/ 语义泛化 / 歧义诚实接地 / 不可能意图诚实拒付 / 多步链 /
//       重复稳定性 / 消融归因（知识 / 反射 / 仿真三臂）。
// 运行前提：D-5 服务已启动（tcp :8421，DSH_PHYSICAL_KEY_PATH 指向共享密钥）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgePipelineOrchestrator } from '../src/knowledge/pipeline.ts';
import { InMemoryKnowledgeBase } from '../src/knowledge/knowledgeBase.ts';
import { InMemoryWorldModel } from '../src/knowledge/worldModel.ts';
import { ReflexiveDecisionStation } from '../src/knowledge/stations.ts';
import { DoctorVerdictBridge } from '../src/knowledge/adapters.ts';
import {
  startComplexWorldWin, createComplexVisionStation, createComplexExecutionStation,
  captureComplexWorld, ocrWordElements, disposeOcrWin, getLastSceneNames,
} from './complexWorldWinHarness.ts';
import type { ComplexWorldState, WorldEvent } from './complexWorldWinHarness.ts';
import type { PipelineConfig, PipelineReport } from '../src/knowledge/contracts.ts';

const BENCH_CONFIG: PipelineConfig = {
  timeout: { overall: 90_000, perStep: 15_000, perPerception: 25_000 },
  retryPolicy: { maxRetries: 2, backoffMs: 1, maxBackoffMs: 2 },
  knowledgeTimeout: 200, knowledgeMaxResults: 5, knowledgeMaxChars: 300,
};

// ─── 任务模型 ───

interface StepSpec {
  intent: string;
  /** 本步预期结局（缺省 completed —— 期望失败的步骤如实标注） */
  expect?: 'completed' | 'failed';
  /** 覆盖任务级 stateDir（遗忘症对照：同 intent 换新脑） */
  stateDir?: string;
}

interface StepResult {
  step: StepSpec;
  report: PipelineReport;
  executions: number;
  trapEvents: WorldEvent[];
  durationMs: number;
}

interface TaskOracleCtx {
  world: ComplexWorldState;
  steps: StepResult[];
}

interface TaskSpec {
  id: string;
  category: string;
  steps: StepSpec[];
  seeds?: (kb: InMemoryKnowledgeBase) => void;
  stateDir?: string;
  ablation?: { disableKnowledge?: boolean };
  decisionOpts?: { disableReflex?: boolean; disableDeliberation?: boolean };
  oracle: (ctx: TaskOracleCtx) => { ok: boolean; detail: string };
}

interface TaskOutcome {
  id: string; category: string; ok: boolean; detail: string;
  steps: Array<{ intent: string; expected: string; verdict: string; executions: number; trapHits: number }>;
  executions: number; trapHits: number; durationMs: number;
}

const RESULTS: TaskOutcome[] = [];
const BENCH_STARTED_AT = Date.now();

/** 单步执行：一个 intent 一次完整流水线 run（感知→决策→真机执行→学习闭环） */
async function runStep(
  world: Awaited<ReturnType<typeof startComplexWorldWin>>,
  description: string,
  opts: {
    kb?: InMemoryKnowledgeBase; wm?: InMemoryWorldModel;
    stateDir?: string; ablation?: { disableKnowledge?: boolean };
    decisionOpts?: { disableReflex?: boolean; disableDeliberation?: boolean };
  } = {},
): Promise<Omit<StepResult, 'step'>> {
  const kb = opts.kb ?? new InMemoryKnowledgeBase();
  const wm = opts.wm ?? new InMemoryWorldModel();
  let executions = 0;
  const trapEvents: WorldEvent[] = [];

  const vision = createComplexVisionStation(world);
  const execStation = createComplexExecutionStation(world);
  const execution = {
    async execute(env: any) {
      executions += 1;
      const before = world.state().events.length;
      const r = await execStation.execute(env);
      for (const e of world.state().events.slice(before)) {
        if (e.trap) trapEvents.push(e);
      }
      return r;
    },
  };

  const config: PipelineConfig = {
    ...BENCH_CONFIG,
    ...(opts.ablation ? { ablation: { ...opts.ablation, l3Policy: 'surprise' as const } } : {}),
  };
  const o = new KnowledgePipelineOrchestrator();
  assert.ok(o.configure(config).ok);
  o.wire(
    {
      vision: vision as any,
      decision: new ReflexiveDecisionStation({ chat: null, ...opts.decisionOpts }),
      execution: execution as any, knowledge: kb, verdictBridge: new DoctorVerdictBridge(),
      worldModel: wm, emit: () => { /* 旁路 */ },
    },
    { stateDir: opts.stateDir },
  );
  const startedAt = Date.now();
  const report = await o.run({ id: `lx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, description });
  await (execStation as any).dispose?.();
  return { report, executions, trapEvents, durationMs: Date.now() - startedAt };
}

/** 任务执行器：世界重置 → 逐步 run → oracle 裁决 → 入账。
 *  记忆纪律（与 W4 同律）：每步全新 kb —— 跨步记忆的唯一载体是 stateDir
 *  （wire 时水合 / run-end 落盘），共享 kb 实例会造成水合重复入账。 */
async function runTask(
  world: Awaited<ReturnType<typeof startComplexWorldWin>>,
  spec: TaskSpec,
): Promise<TaskOutcome> {
  await world.reset();
  const startedAt = Date.now();
  const steps: StepResult[] = [];
  for (const step of spec.steps) {
    const kb = new InMemoryKnowledgeBase();
    spec.seeds?.(kb);
    const r = await runStep(world, step.intent, {
      kb, wm: new InMemoryWorldModel(),
      stateDir: step.stateDir ?? spec.stateDir,
      ablation: spec.ablation, decisionOpts: spec.decisionOpts,
    });
    steps.push({ step, ...r });
  }
  const { ok, detail } = spec.oracle({ world: world.state(), steps });
  const outcome: TaskOutcome = {
    id: spec.id, category: spec.category, ok,
    detail: ok ? detail : `${detail} | last-scene=[${getLastSceneNames().join(', ')}]`,
    steps: steps.map(s => ({
      intent: s.step.intent,
      expected: s.step.expect ?? 'completed',
      verdict: s.report.verdict,
      executions: s.executions,
      trapHits: s.trapEvents.length,
    })),
    executions: steps.reduce((a, s) => a + s.executions, 0),
    trapHits: steps.reduce((a, s) => a + s.trapEvents.length, 0),
    durationMs: Date.now() - startedAt,
  };
  RESULTS.push(outcome);
  const mark = ok ? '✔' : '✘';
  console.log(`${mark} [${spec.category}] ${spec.id} — ${detail} (exec=${outcome.executions}, trap=${outcome.trapHits}, ${outcome.durationMs}ms)`);
  return outcome;
}

// ─── oracle 组件 ───

function stepVerdictOk({ steps }: TaskOracleCtx): { ok: boolean; detail: string } {
  for (const s of steps) {
    const expected = s.step.expect ?? 'completed';
    if (s.report.verdict !== expected) {
      return { ok: false, detail: `step '${s.step.intent}' verdict=${s.report.verdict} (expected ${expected}): ${s.report.terminalReason}` };
    }
  }
  return { ok: true, detail: `all ${steps.length} step(s) verdict-ok` };
}

function lastWidgetIs(target: string): (ctx: TaskOracleCtx) => { ok: boolean; detail: string } {
  return ({ world }) => {
    const last = world.events[world.events.length - 1]?.widget;
    return last === target
      ? { ok: true, detail: `final action landed on '${target}'` }
      : { ok: false, detail: `final action landed on '${last ?? 'nothing'}' (expected '${target}')` };
  };
}

function pageIs(page: string): (ctx: TaskOracleCtx) => { ok: boolean; detail: string } {
  return ({ world }) => world.page === page
    ? { ok: true, detail: `final page '${page}'` }
    : { ok: false, detail: `final page '${world.page}' (expected '${page}')` };
}

function seqEquals(expected: string[]): (ctx: TaskOracleCtx) => { ok: boolean; detail: string } {
  return ({ world }) => {
    const got = world.events.map(e => e.widget);
    const okSeq = got.length === expected.length && got.every((w, i) => w === expected[i]);
    return okSeq
      ? { ok: true, detail: `event sequence exact (${expected.length} events)` }
      : { ok: false, detail: `event sequence [${got.join(' → ')}] ≠ expected [${expected.join(' → ')}]` };
  };
}

function togglesAre(expected: Record<string, boolean>): (ctx: TaskOracleCtx) => { ok: boolean; detail: string } {
  return ({ world }) => {
    for (const [name, want] of Object.entries(expected)) {
      if (world.toggles[name] !== want) {
        return { ok: false, detail: `toggle '${name}'=${world.toggles[name]} (expected ${want})` };
      }
    }
    return { ok: true, detail: `toggles verified (${Object.keys(expected).join(', ')})` };
  };
}

/** 笔迹纪元 oracle：输入框内容精确对照（世界真相 = 每次击键的原子落盘） */
function entriesAre(expected: Record<string, string>): (ctx: TaskOracleCtx) => { ok: boolean; detail: string } {
  return ({ world }) => {
    for (const [name, want] of Object.entries(expected)) {
      if ((world.entries[name] ?? '') !== want) {
        return { ok: false, detail: `entry '${name}'='${world.entries[name] ?? ''}' (expected '${want}')` };
      }
    }
    return { ok: true, detail: `entries verified (${Object.keys(expected).map(k => `${k}='${expected[k]}'`).join(', ')})` };
  };
}

/** 运动序法则 oracle：落点已取、笔迹未落（先落点后运笔的法则本体断言） */
function motionDeferred(target: string): (ctx: TaskOracleCtx) => { ok: boolean; detail: string } {
  return ({ world }) => (world.entries[target] ?? '') === '' && world.focus === target
    ? { ok: true, detail: `prerequisite-first held: focus '${target}' acquired, writing deferred` }
    : { ok: false, detail: `motion not deferred (focus=${world.focus}, entry='${world.entries[target] ?? ''}')` };
}

function noTrapWidget(widget: string): (ctx: TaskOracleCtx) => { ok: boolean; detail: string } {
  return ({ steps }) => {
    const hits = steps.flatMap(s => s.trapEvents).filter(e => e.widget === widget);
    return hits.length === 0
      ? { ok: true, detail: `zero clicks on broken '${widget}'` }
      : { ok: false, detail: `${hits.length} real click(s) landed on broken '${widget}'` };
  };
}

function trapWidgetHit(widget: string, min = 1): (ctx: TaskOracleCtx) => { ok: boolean; detail: string } {
  return ({ steps }) => {
    const hits = steps.flatMap(s => s.trapEvents).filter(e => e.widget === widget);
    return hits.length >= min
      ? { ok: true, detail: `${hits.length} tuition click(s) on '${widget}' (as designed)` }
      : { ok: false, detail: `expected ≥${min} tuition click(s) on '${widget}', got ${hits.length}` };
  };
}

function zeroExecutions(stepIndex: number): (ctx: TaskOracleCtx) => { ok: boolean; detail: string } {
  return ({ steps }) => steps[stepIndex].executions === 0
    ? { ok: true, detail: `step ${stepIndex} honestly grounded — zero real actions` }
    : { ok: false, detail: `step ${stepIndex} burned ${steps[stepIndex].executions} real action(s) without conviction` };
}

function and(...oracles: Array<(ctx: TaskOracleCtx) => { ok: boolean; detail: string }>): (ctx: TaskOracleCtx) => { ok: boolean; detail: string } {
  return ctx => {
    const results = oracles.map(o => o(ctx));
    const failed = results.filter(r => !r.ok);
    return failed.length === 0
      ? { ok: true, detail: results.map(r => r.detail).join('; ') }
      : { ok: false, detail: failed.map(r => r.detail).join('; ') };
  };
}

/** 类别收口：全任务跑完再统一断言（一个 flake 不遮蔽其余任务的成绩） */
function assertCategory(name: string, outcomes: TaskOutcome[]): void {
  const failed = outcomes.filter(o => !o.ok);
  assert.equal(failed.length, 0,
    `[${name}] ${failed.length}/${outcomes.length} task(s) failed:\n` +
    failed.map(f => `  ✘ ${f.id}: ${f.detail}`).join('\n'));
  const acc = outcomes.length === 0 ? 1 : (outcomes.length - failed.length) / outcomes.length;
  console.log(`✔ [${name}] category accuracy ${(acc * 100).toFixed(1)}% (${outcomes.length - failed.length}/${outcomes.length})`);
}

// ─── 平台闸 ───

async function windowsGate(): Promise<{ ok: boolean; reason: string }> {
  if (process.platform !== 'win32') return { ok: false, reason: `platform=${process.platform} (Windows-only)` };
  try {
    const resp = await fetch('http://127.0.0.1:8421/v1/health', { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return { ok: false, reason: 'D-5 service not reachable on :8421' };
  } catch (e: any) {
    return { ok: false, reason: `D-5 service unreachable: ${e.message}` };
  }
  return { ok: true, reason: 'win32 + live D-5 service' };
}

const gate = await windowsGate();
const maybe = gate.ok ? test : test.skip;

// ─── 种子知识（与 W3/W4 同律：manual 种子 = 传闻身份）───

function seedFamily(
  kb: InMemoryKnowledgeBase,
  scenario: string, errorContent: string, workflowContent: string,
): void {
  kb.insert({ category: 'error-pattern', content: errorContent, scenario, confidence: 0.55, source: 'manual' });
  kb.insert({ category: 'workflow', content: workflowContent, scenario, confidence: 0.6, source: 'manual' });
}

// ════════════════════════ 测试 ════════════════════════

maybe('L0: 世界冒烟 —— OCR 词级分组读出完整复杂场景', { timeout: 60_000 }, async () => {
  const world = await startComplexWorldWin();
  try {
    const png = await captureComplexWorld(world);
    const elements = await ocrWordElements(png);
    const text = elements.map(e => e.name).join(' | ');
    for (const expect of ['files', 'archive', 'settings', 'editor', 'scan disk', 'merge copies', 'unmount drive', 'format disk']) {
      assert.ok(new RegExp(`(^|\\s)${expect.replace(/ /g, '\\s*')}(\\s|$)`, 'i').test(text), `OCR 应读出 '${expect}'：${text}`);
    }
    // 词级分离执法：一个元素不允许吞并两个控件的词
    const merged = elements.filter(e => (e.name.match(/(disk|folder|trash|drive|duplicates)/gi) ?? []).length > 1);
    assert.equal(merged.length, 0, `OCR 元素合并了多个控件：${merged.map(e => e.name).join(' / ')}`);
    console.log(`✔ L0 OCR 感知（${elements.length} 元素）：${text.replace(/\|/g, ',')}`);
  } finally {
    await world.dispose();
    await disposeOcrWin(); // tesseract worker 不终止 ⇒ node 事件循环不退出
  }
});

maybe('L1: 导航任务 ×6 —— 页面状态机真实翻转', { timeout: 240_000 }, async () => {
  const world = await startComplexWorldWin();
  const outcomes: TaskOutcome[] = [];
  try {
    for (const page of ['files', 'network', 'reports', 'settings', 'archive', 'editor']) {
      outcomes.push(await runTask(world, {
        id: `nav-${page}`, category: 'navigation',
        steps: [{ intent: `open the ${page} page` }],
        oracle: and(stepVerdictOk, pageIs(page), lastWidgetIs(`${page} page`)),
      }));
    }
  } finally {
    await world.dispose();
  }
  assertCategory('navigation', outcomes);
});

maybe('L2: 页内反射任务 ×10 —— 导航+操作的二步链', { timeout: 480_000 }, async () => {
  const world = await startComplexWorldWin();
  const outcomes: TaskOutcome[] = [];
  const suite: Array<[string, string, string]> = [
    ['files', 'scan the disk', 'scan disk'],
    ['files', 'empty the trash', 'empty trash'],
    ['network', 'refresh the status', 'refresh status'],
    ['network', 'ping the gateway', 'ping gateway'],
    ['reports', 'print the summary', 'print summary'],
    ['reports', 'zoom the chart', 'zoom chart'],
    ['settings', 'save the options', 'save options'],
    ['settings', 'restore the defaults', 'restore defaults'],
    ['archive', 'clear the log', 'clear log'],
    ['archive', 'revoke the sessions', 'revoke sessions'],
  ];
  try {
    for (const [page, intent, target] of suite) {
      outcomes.push(await runTask(world, {
        id: `onpage-${target.replace(/ /g, '-')}`, category: 'on-page-reflex',
        steps: [{ intent: `open the ${page} page` }, { intent }],
        oracle: and(stepVerdictOk, pageIs(page), lastWidgetIs(target)),
      }));
    }
  } finally {
    await world.dispose();
  }
  assertCategory('on-page-reflex', outcomes);
});

maybe('L2b: 笔迹任务 ×8 —— 运动反射弧真机执法（真键盘 → 世界 entries 真相）', { timeout: 480_000 }, async () => {
  const world = await startComplexWorldWin();
  const outcomes: TaskOutcome[] = [];
  try {
    // 基本链：点名落点（前置点击+聚焦）→ 焦点运笔（引号锚定载荷，真 pyautogui 键击）
    outcomes.push(await runTask(world, {
      id: 'type-server-field', category: 'typing',
      steps: [
        { intent: 'open the editor page' },
        { intent: 'type "alpha.local" into the server field' },
        { intent: 'type "alpha.local"' },
      ],
      oracle: and(stepVerdictOk, entriesAre({ 'server field': 'alpha.local' })),
    }));
    outcomes.push(await runTask(world, {
      id: 'type-user-field-space', category: 'typing',
      steps: [
        { intent: 'open the editor page' },
        { intent: 'type "ada lovelace" into the user field' },
        { intent: 'type "ada lovelace"' },
      ],
      oracle: and(stepVerdictOk, entriesAre({ 'user field': 'ada lovelace' })),
    }));
    outcomes.push(await runTask(world, {
      id: 'type-notes-numeric', category: 'typing',
      steps: [
        { intent: 'open the editor page' },
        { intent: 'type "42" into the notes field' },
        { intent: 'type "42"' },
      ],
      oracle: and(stepVerdictOk, entriesAre({ 'notes field': '42' })),
    }));
    outcomes.push(await runTask(world, {
      id: 'type-single-quotes', category: 'typing',
      steps: [
        { intent: 'open the editor page' },
        { intent: "type 'draft' into the notes field" },
        { intent: "type 'draft'" },
      ],
      oracle: and(stepVerdictOk, entriesAre({ 'notes field': 'draft' })),
    }));
    // 多字段链：焦点切换 + 载荷不串框
    outcomes.push(await runTask(world, {
      id: 'type-multi-field', category: 'typing',
      steps: [
        { intent: 'open the editor page' },
        { intent: 'type "s1" into the server field' },
        { intent: 'type "s1"' },
        { intent: 'type "u1" into the user field' },
        { intent: 'type "u1"' },
      ],
      oracle: and(stepVerdictOk, entriesAre({ 'server field': 's1', 'user field': 'u1' })),
    }));
    // 精确性优先：无载荷 / 双载荷 ⇒ 诚实拒付（零真键盘）
    outcomes.push(await runTask(world, {
      id: 'type-refusal-no-payload', category: 'typing',
      steps: [
        { intent: 'open the editor page' },
        { intent: 'click the notes field' },
        { intent: 'type the text', expect: 'failed' },
      ],
      oracle: and(stepVerdictOk, zeroExecutions(2), entriesAre({})),
    }));
    outcomes.push(await runTask(world, {
      id: 'type-refusal-two-spans', category: 'typing',
      steps: [
        { intent: 'open the editor page' },
        { intent: 'type "a" "b"', expect: 'failed' },
      ],
      oracle: and(stepVerdictOk, zeroExecutions(1), entriesAre({})),
    }));
    // 运动序法则本体：单意图只做前置（点击聚焦），笔迹让位下一轮
    outcomes.push(await runTask(world, {
      id: 'type-motion-sequence-law', category: 'typing',
      steps: [
        { intent: 'open the editor page' },
        { intent: 'type "gamma" into the server field' },
      ],
      oracle: and(stepVerdictOk, motionDeferred('server field')),
    }));
  } finally {
    await world.dispose();
  }
  assertCategory('typing', outcomes);
});

maybe('L3: 种子陷阱规避 ×4 —— 免疫压制 + 前额叶改道（跨页泛化）', { timeout: 480_000 }, async () => {
  const world = await startComplexWorldWin();
  const outcomes: TaskOutcome[] = [];
  const suite: Array<[string, string, string, string, string, string, string]> = [
    // [页, 导航意图, 陷阱意图, 陷阱按钮, 活路按钮, error种子, workflow种子]
    ['archive', 'delete the record', 'delete item', 'clear log',
      'delete item button is broken, clicks fail', 'clear log after deleting records', 'record cleanup'],
    ['archive', 'erase the history', 'erase history', 'purge cache',
      'erase history button is broken, clicks fail', 'purge cache after erasing history', 'history cleanup'],
    ['network', 'disable the firewall', 'disable firewall', 'lock routes',
      'disable firewall button is broken, clicks fail', 'lock routes before disabling firewall', 'firewall safety'],
    ['files', 'format the disk', 'format disk', 'unmount drive',
      'format disk button is broken, clicks fail', 'unmount drive before formatting disk', 'disk safety'],
  ];
  try {
    for (const [page, trapIntent, trap, safe, errorSeed, workflowSeed, scenario] of suite) {
      outcomes.push(await runTask(world, {
        id: `seeded-${trap.replace(/ /g, '-')}`, category: 'seeded-trap-avoidance',
        steps: [{ intent: `open the ${page} page` }, { intent: trapIntent }],
        seeds: kb => seedFamily(kb, scenario, errorSeed, workflowSeed),
        oracle: and(stepVerdictOk, noTrapWidget(trap), lastWidgetIs(safe)),
      }));
    }
  } finally {
    await world.dispose();
  }
  assertCategory('seeded-trap-avoidance', outcomes);
});

maybe('L4: 学习曲线 ×3 族 —— Day1 真实学费 → Day2 反遗忘改道 + 遗忘症对照', { timeout: 600_000 }, async () => {
  const world = await startComplexWorldWin();
  const outcomes: TaskOutcome[] = [];
  try {
    const families: Array<[string, string, string, string, string]> = [
      // [页, 陷阱意图, 陷阱按钮, 活路意图, 活路按钮]
      ['archive', 'erase the history', 'erase history', 'purge the cache', 'purge cache'],
      ['network', 'disable the firewall', 'disable firewall', 'lock the routes', 'lock routes'],
      ['files', 'format the disk', 'format disk', 'unmount the drive', 'unmount drive'],
    ];
    for (const [page, trapIntent, trap, safeIntent, safe] of families) {
      const stateDir = mkdtempSync(join(tmpdir(), `lx-learn-${trap.replace(/ /g, '-')}-`));
      outcomes.push(await runTask(world, {
        id: `learn-${trap.replace(/ /g, '-')}`, category: 'learning-curve',
        stateDir,
        steps: [
          { intent: `open the ${page} page` },
          { intent: trapIntent, expect: 'failed' },   // Day1：无先验 ⇒ 真实踩坑（学费）
          { intent: safeIntent },                      // Day1：活路亲证（workflow 诞生）
          { intent: trapIntent },                      // Day2：旧脑水合 ⇒ 改道成功
        ],
        oracle: and(stepVerdictOk, trapWidgetHit(trap), noTrapWidgetByDay2(trap), lastWidgetIs(safe)),
      }));
      rmSync(stateDir, { recursive: true, force: true });
    }
    // 遗忘症对照（W4 同律的泛化）：同陷阱意图、全新 stateDir ⇒ 仍付学费
    const amnesiaA = mkdtempSync(join(tmpdir(), 'lx-amn-a-'));
    const amnesiaB = mkdtempSync(join(tmpdir(), 'lx-amn-b-'));
    outcomes.push(await runTask(world, {
      id: 'amnesia-erase-history', category: 'learning-curve',
      steps: [
        { intent: 'open the archive page' },
        { intent: 'erase the history', expect: 'failed', stateDir: amnesiaA },
        { intent: 'erase the history', expect: 'failed', stateDir: amnesiaB }, // 换新脑：记忆不在 ⇒ 仍失败
      ],
      oracle: and(stepVerdictOk, trapWidgetHit('erase history')),
    }));
    rmSync(amnesiaA, { recursive: true, force: true });
    rmSync(amnesiaB, { recursive: true, force: true });
  } finally {
    await world.dispose();
  }
  assertCategory('learning-curve', outcomes);
});

/** 学习族 Day2 断言：陷阱点击只允许出现在 Day1 步骤（第 2 步） */
function noTrapWidgetByDay2(widget: string): (ctx: TaskOracleCtx) => { ok: boolean; detail: string } {
  return ({ steps }) => {
    const later = steps.slice(2).flatMap(s => s.trapEvents).filter(e => e.widget === widget);
    return later.length === 0
      ? { ok: true, detail: `Day2 zero clicks on broken '${widget}' (rerouted)` }
      : { ok: false, detail: `Day2 still clicked broken '${widget}' ×${later.length}` };
  };
}

maybe('L5: 语义泛化 ×6 —— 零词面重合，workflow 证据托举', { timeout: 480_000 }, async () => {
  const world = await startComplexWorldWin();
  const outcomes: TaskOutcome[] = [];
  const suite: Array<[string, string, string, string]> = [
    // [页, 语义意图, 目标按钮, workflow种子]
    ['files', 'tidy the storage', 'sort folder', 'sort folder organizes storage'],
    ['network', 'check the connection', 'ping gateway', 'ping gateway checks the connection'],
    ['network', 'measure the link speed', 'test bandwidth', 'test bandwidth measures the link speed'],
    ['reports', 'get a paper copy', 'print summary', 'print summary produces a paper copy'],
    ['settings', 'enable night mode', 'dark theme', 'dark theme enables night mode'],
    ['network', 'reboot the connection hardware', 'reset adapter', 'reset adapter reboots the connection hardware'],
  ];
  try {
    for (const [page, intent, target, workflowSeed] of suite) {
      outcomes.push(await runTask(world, {
        id: `semantic-${target.replace(/ /g, '-')}`, category: 'semantic-generalization',
        steps: [{ intent: `open the ${page} page` }, { intent }],
        seeds: kb => kb.insert({ category: 'workflow', content: workflowSeed, scenario: 'assistant hints', confidence: 0.6, source: 'manual' }),
        oracle: and(stepVerdictOk, lastWidgetIs(target)),
      }));
    }
  } finally {
    await world.dispose();
  }
  assertCategory('semantic-generalization', outcomes);
});

maybe('L6: 歧义诚实接地 ×2 —— 平票不掷硬币', { timeout: 240_000 }, async () => {
  const world = await startComplexWorldWin();
  const outcomes: TaskOutcome[] = [];
  try {
    for (const [id, intent] of [['ambiguous-export', 'export the data'], ['ambiguous-chart', 'show the chart']] as const) {
      outcomes.push(await runTask(world, {
        id, category: 'ambiguity-grounding',
        steps: [{ intent: 'open the reports page' }, { intent, expect: 'failed' }],
        oracle: and(stepVerdictOk, zeroExecutions(1)),
      }));
    }
  } finally {
    await world.dispose();
  }
  assertCategory('ambiguity-grounding', outcomes);
});

maybe('L7: 不可能意图 ×4 —— 诚实拒付（零真实动作）', { timeout: 240_000 }, async () => {
  const world = await startComplexWorldWin();
  const outcomes: TaskOutcome[] = [];
  try {
    for (const intent of ['launch the rocket', 'order a pizza', 'book a flight', 'translate the document']) {
      outcomes.push(await runTask(world, {
        id: `impossible-${intent.replace(/ /g, '-')}`, category: 'impossible-intent',
        steps: [{ intent, expect: 'failed' }],
        oracle: and(stepVerdictOk, zeroExecutions(0)),
      }));
    }
  } finally {
    await world.dispose();
  }
  assertCategory('impossible-intent', outcomes);
});

maybe('L8: 多步链 ×8 —— 3~5 步真实工作流（含开关态）', { timeout: 600_000 }, async () => {
  const world = await startComplexWorldWin();
  const outcomes: TaskOutcome[] = [];
  const suite: Array<[string, string[], Record<string, boolean>]> = [
    ['chain-settings-backup', ['settings page', 'auto backup', 'save options'], { 'auto backup': true }],
    ['chain-settings-theme', ['settings page', 'dark theme', 'restore defaults'], { 'dark theme': true }],
    ['chain-network-diag', ['network page', 'refresh status', 'ping gateway'], {}],
    ['chain-reports-export', ['reports page', 'archive logs', 'export table'], {}],
    ['chain-files-sweep', ['files page', 'scan disk', 'sort folder', 'empty trash'], {}],
    ['chain-archive-maint', ['archive page', 'revoke sessions', 'vacuum tables'], {}],
    ['chain-cross-page', ['files page', 'unmount drive', 'settings page', 'sync clock'], { 'sync clock': true }],
    ['chain-long-haul', ['network page', 'test bandwidth', 'reset adapter', 'reports page', 'share link'], {}],
  ];
  try {
    for (const [id, expectedEvents, toggles] of suite) {
      const intents = expectedEvents.map(w =>
        w.endsWith(' page') ? `open the ${w}` : `perform ${w}`);
      outcomes.push(await runTask(world, {
        id, category: 'multi-step-chain',
        steps: intents.map(intent => ({ intent })),
        oracle: and(stepVerdictOk, seqEquals(expectedEvents), togglesAre(toggles)),
      }));
    }
  } finally {
    await world.dispose();
  }
  assertCategory('multi-step-chain', outcomes);
});

maybe('L9: 重复稳定性 ×3 任务 ×3 遍 —— OCR→坐标漂移执法', { timeout: 600_000 }, async () => {
  const world = await startComplexWorldWin();
  const outcomes: TaskOutcome[] = [];
  const suite: Array<[string, string, string, string[]]> = [
    ['repeat-scan-disk', 'open the files page', 'scan the disk', ['files page', 'scan disk']],
    ['repeat-ping-gateway', 'open the network page', 'ping the gateway', ['network page', 'ping gateway']],
    ['repeat-save-options', 'open the settings page', 'save the options', ['settings page', 'save options']],
  ];
  try {
    for (const [id, navIntent, actionIntent, expectedEvents] of suite) {
      for (let rep = 1; rep <= 3; rep++) {
        outcomes.push(await runTask(world, {
          id: `${id}#${rep}`, category: 'repeat-stability',
          steps: [{ intent: navIntent }, { intent: actionIntent }],
          oracle: and(stepVerdictOk, seqEquals(expectedEvents)),
        }));
      }
    }
  } finally {
    await world.dispose();
  }
  assertCategory('repeat-stability', outcomes);
});

maybe('L10: 消融归因 ×5 —— 各认知层的贡献逐一定罪', { timeout: 600_000 }, async () => {
  const world = await startComplexWorldWin();
  const outcomes: TaskOutcome[] = [];
  try {
    // ab1 关知识（检索+学习断电）：种子在场但不注入 ⇒ 反射直踩陷阱（学费照付）
    outcomes.push(await runTask(world, {
      id: 'ablate-knowledge-off-trap', category: 'ablation-attribution',
      steps: [{ intent: 'open the archive page' }, { intent: 'erase the history', expect: 'failed' }],
      seeds: kb => seedFamily(kb, 'history cleanup',
        'erase history button is broken, clicks fail', 'purge cache after erasing history'),
      ablation: { disableKnowledge: true },
      oracle: and(stepVerdictOk, trapWidgetHit('erase history')),
    }));
    // ab2 关知识：语义任务无证据可用 ⇒ 诚实接地（零动作）
    outcomes.push(await runTask(world, {
      id: 'ablate-knowledge-off-semantic', category: 'ablation-attribution',
      steps: [{ intent: 'open the files page' }, { intent: 'tidy the storage', expect: 'failed' }],
      seeds: kb => kb.insert({ category: 'workflow', content: 'sort folder organizes storage', scenario: 'assistant hints', confidence: 0.6, source: 'manual' }),
      ablation: { disableKnowledge: true },
      oracle: and(stepVerdictOk, zeroExecutions(1)),
    }));
    // ab3 关反射：零知识世界 ⇒ 慢路径无米下锅 ⇒ 诚实接地（零动作）
    outcomes.push(await runTask(world, {
      id: 'ablate-reflex-off-nav', category: 'ablation-attribution',
      steps: [{ intent: 'open the files page', expect: 'failed' }],
      decisionOpts: { disableReflex: true },
      oracle: and(stepVerdictOk, zeroExecutions(0)),
    }));
    // ab4 关仿真：种子压制 ⇒ 无改道 ⇒ 核证探针放行一针（恰好一次学费）
    outcomes.push(await runTask(world, {
      id: 'ablate-deliberation-off-trap', category: 'ablation-attribution',
      steps: [{ intent: 'open the archive page' }, { intent: 'erase the history', expect: 'failed' }],
      seeds: kb => seedFamily(kb, 'history cleanup',
        'erase history button is broken, clicks fail', 'purge cache after erasing history'),
      decisionOpts: { disableDeliberation: true },
      oracle: and(stepVerdictOk, ({ steps }) => {
        const hits = steps[1].trapEvents.filter(e => e.widget === 'erase history').length;
        return hits === 1
          ? { ok: true, detail: `verified-grounding probe released exactly 1 tuition click` }
          : { ok: false, detail: `probe tuition = ${hits} (expected exactly 1)` };
      }),
    }));
    // ab5 关仿真：语义任务 ⇒ 反射零重合 + 无仿真 ⇒ 诚实接地（零动作）
    outcomes.push(await runTask(world, {
      id: 'ablate-deliberation-off-semantic', category: 'ablation-attribution',
      steps: [{ intent: 'open the files page' }, { intent: 'tidy the storage', expect: 'failed' }],
      seeds: kb => kb.insert({ category: 'workflow', content: 'sort folder organizes storage', scenario: 'assistant hints', confidence: 0.6, source: 'manual' }),
      decisionOpts: { disableDeliberation: true },
      oracle: and(stepVerdictOk, zeroExecutions(1)),
    }));
  } finally {
    await world.dispose();
    await disposeOcrWin(); // 末位异步测试收尾：tesseract worker 生命周期归零
  }
  assertCategory('ablation-attribution', outcomes);
});

// ─── 总账：准确率 + 报告落盘（证据先于修辞）───

test('L11: 大规模验证总账 —— 准确率汇总 + 报告落盘', () => {
  if (!gate.ok) {
    console.log(`[L11] large-scale bench skipped: ${gate.reason}`);
    return;
  }
  assert.ok(RESULTS.length >= 45, `应有 ≥45 项任务入账，实得 ${RESULTS.length}（环境异常时上游测试已红）`);

  const byCategory = new Map<string, TaskOutcome[]>();
  for (const o of RESULTS) {
    const bucket = byCategory.get(o.category) ?? [];
    bucket.push(o);
    byCategory.set(o.category, bucket);
  }
  const passed = RESULTS.filter(o => o.ok).length;
  const totalExec = RESULTS.reduce((a, o) => a + o.executions, 0);
  const totalTrap = RESULTS.reduce((a, o) => a + o.trapHits, 0);
  const plannedTrap = RESULTS.filter(o => o.category === 'learning-curve' || o.id.startsWith('ablate-knowledge-off-trap') || o.id.startsWith('ablate-deliberation-off-trap') || o.id.startsWith('amnesia-')).length;
  const wallMin = ((Date.now() - BENCH_STARTED_AT) / 60_000).toFixed(1);

  const table = [...byCategory.entries()].map(([cat, list]) => {
    const p = list.filter(o => o.ok).length;
    return `| ${cat} | ${list.length} | ${p} | ${((p / list.length) * 100).toFixed(1)}% |`;
  }).join('\n');

  const failedLines = RESULTS.filter(o => !o.ok)
    .map(o => `- ✘ ${o.id}: ${o.detail}`).join('\n') || '- （无失败任务）';

  const report = `# 大规模真机验证报告（Windows · Data Console）

日期：${new Date().toISOString()} · 执法册：\`test/largeScaleWin.bench.ts\` · 世界：\`test/fixtures/complexWorldWin.py\`

## 环境

- 真机链路：D-5 物理服务（tcp :8421，mmap-file 截屏）→ tesseract.js 离线 OCR → pyautogui 真鼠标 → tkinter 回调
- 世界复杂度：5 页 × 6 内容控件 + 5 导航（每屏 12+ 文本元素），陷阱族跨 3 页
- 决策脑：ReflexiveDecisionStation 四层（免疫压制 → 脊髓反射（X 纪元：+ 运动反射弧 type/scroll/hotkey）→ 前额叶仿真 → 核证探针），无 LLM 通道
- 任务总量：**${RESULTS.length} 项任务 / ${RESULTS.reduce((a, o) => a + o.steps.length, 0)} 个流水线 run / ${totalExec} 次真实鼠标点击**

## 准确率总账

| 类别 | 任务 | 通过 | 准确率 |
| --- | --- | --- | --- |
${table}
| **总计** | **${RESULTS.length}** | **${passed}** | **${((passed / RESULTS.length) * 100).toFixed(1)}%** |

- 墙钟：${wallMin} 分钟 · 真实陷阱点击（设计内学费）：${totalTrap} 次（分布于学习曲线/遗忘症/消融臂 ${plannedTrap} 项任务）
- 免疫主张：种子陷阱规避与学习 Day2 全部 0 陷阱点击（见 seeded-trap-avoidance / learning-curve 两行）

## 失败明细（如有）

${failedLines}

## 诚实边界

- 决策脑为反射纪元（无 LLM 通道；X 纪元笔迹升级后动作词汇 = click_mouse + type_text / scroll_page / press_hotkey）：运动反射弧以引号锚定载荷（信息无损，精确性优先拒绝自由文本）+ 运动序法则（先落点后运笔）发射结构化动作，type_text 生而携带 L4 自证锚；其余动作类（drag_mouse / switch_* 等）仍由执行站如实拒绝。
- 消融臂只归因知识/反射/仿真三层的贡献；L3（VLM）在 stub 后端下不可计费。
- 每任务世界重置（canonical files 页起步）；学习族内跨 run 共享 stateDir（反遗忘水合执法）。

## 感知工程教训（战役战果 —— 每条都翻过车才立法）

1. **行级 OCR 合并**：tesseract 把跨列同基线的导航/内容按钮并成一行（'reports page empty trash'）⇒ 词级分组（x-间隙 ≤45px 聚词成元素，跨列 ≥80px 空隙天然分离）。
2. **文本裁剪**：按钮文本渲染宽 ≥ 按钮宽 ⇒ 首末字母被吃（'network page'→'etwork pag'、'settings page'→conf 3 的 'SEER'）⇒ 单词导航标签 + 按钮宽 ≥ 文本宽 + 50px 余量。
3. **绘制竞态 + 窗口间隙**：世界状态文件先于窗口上屏（tkinter persist 在 mainloop 绘制前落盘），首帧截屏抓到部分绘制的窗口；reset 的 kill→spawn→上屏间隙更长时甚至截到桌面既有窗口的文本 ⇒ 导航不变量重采样（导航词 <3 ⇒ 250ms 后重截，最多 8 次 ≈2s；好路径首轮即返）。
4. **小字误读带**：~17px 字高在 tesseract 偶发误读带边缘（单词整体消失/低置信）⇒ OCR 前 2× lanczos 放大（bbox 折回原域）+ 导航字号 16pt。
5. **IME 击键劫持（X 纪元战果）**：pyautogui.typewrite 的虚拟键码经活动输入法被劫持（'alpha.local'→'alpha。local'、'ada'→'阿达'）⇒ D-5 服务 Windows 侧改 SendInput + KEYEVENTF_UNICODE 直注（与键盘布局/输入法正交的唯一确定性文本注入）。
6. **跨列同基线行腐蚀（X 纪元战果）**：导航词与内容词同排时 tesseract 行分割被大间隙拉伸，单词被腐蚀（'settings'+'format disk' 同排 ⇒ 'setines' conf=0 被置信过滤静默吞掉）⇒ 分条带识别（导航条带 | 内容条带分别识别，跨列行混合在构造上不可能）+ 导航不变量收紧为全六词在场。
`;
  mkdirSync(join(import.meta.dirname, 'reports'), { recursive: true });
  const reportPath = join(import.meta.dirname, 'reports', 'large-scale-win-report.md');
  writeFileSync(reportPath, report, 'utf8');
  console.log(`\n═══ 大规模真机验证总账 ═══`);
  console.log(`任务准确率: ${passed}/${RESULTS.length} = ${((passed / RESULTS.length) * 100).toFixed(1)}%`);
  console.log(`真实鼠标点击: ${totalExec} 次（其中设计内陷阱学费 ${totalTrap} 次）`);
  console.log(`墙钟: ${wallMin} 分钟 · 报告: ${reportPath}`);
  for (const [cat, list] of byCategory) {
    const p = list.filter(o => o.ok).length;
    console.log(`  ${cat}: ${p}/${list.length}`);
  }
});

// 环境缺席时的诚实申报（非 win32 / 服务未起 ⇒ skip 理由可审计）
test('L12: 大规模真机闸 —— 环境缺席诚实申报', () => {
  if (!gate.ok) console.log(`[L12] large-scale bench skipped: ${gate.reason}`);
});
