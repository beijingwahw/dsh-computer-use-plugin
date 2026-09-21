// test/realMachineWin.bench.ts
// Windows 真机基准（O 纪元 #1）—— realMachine.bench.ts 的 Windows 孪生：
//   感知 = D-5 服务真截屏（mmap-file）→ tesseract.js OCR（离线仓根语言包）
//   执行 = D-5 服务 /v1/click = 真 pyautogui（真鼠标）→ tkinter 回调真实触发
//   裁决 = 应用状态文件（世界真相，非脚本裁决）
// 实验（与 Linux 真机/stub 基准一一对应）：
//   W1  服务链路冒烟 —— 真 OCR 读出两按钮（感知层的物理证据）
//   W2  真鼠标点击 e2e —— 真 pyautogui 点活路按钮 ⇒ 世界状态 done=true（#4）
//   W3  E1b-R 陷阱改道 —— 陷阱记忆 ⇒ 免疫压制 + 前额叶改道（认知层在真机上）
//   W4  E3-R 学习曲线 —— Day1 踩坑 → Day2 旧脑水合改道；遗忘症对照仍失败
// 运行前提：D-5 服务已启动（tcp :8421，DSH_PHYSICAL_KEY_PATH 指向共享密钥）。
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
import { MetricsLedger, summarizeRuns } from '../src/knowledge/metrics.ts';
import {
  startRealWorldWin, createRealVisionStationWin, createRealExecutionStationWin,
  disposeOcrWin, windowsRealMachineGate, captureWorldRegion, ocrLines,
} from './realWorldWinHarness.ts';
import type { PipelineConfig, PipelineReport } from '../src/knowledge/contracts.ts';

const BENCH_CONFIG: PipelineConfig = {
  timeout: { overall: 90_000, perStep: 15_000, perPerception: 25_000 },
  retryPolicy: { maxRetries: 2, backoffMs: 1, maxBackoffMs: 2 },
  knowledgeTimeout: 200, knowledgeMaxResults: 5, knowledgeMaxChars: 300,
};

function seedKnowledge(kb: InMemoryKnowledgeBase): void {
  kb.insert({ category: 'error-pattern', content: 'delete item button is broken, clicks fail', scenario: 'record cleanup', confidence: 0.55, source: 'manual' });
  kb.insert({ category: 'workflow', content: 'clear log after erasing records', scenario: 'record cleanup', confidence: 0.6, source: 'manual' });
}

interface Probe { executions: number; trapHits: number; l3Rounds: number }

async function runIntent(
  world: Awaited<ReturnType<typeof startRealWorldWin>>,
  intentDescription: string,
  opts: {
    seeds?: boolean;
    kb?: InMemoryKnowledgeBase;
    wm?: InMemoryWorldModel;
    stateDir?: string;
    metricsPath?: string;
  } = {},
): Promise<{ report: PipelineReport; probe: Probe }> {
  await world.reset();
  const kb = opts.kb ?? new InMemoryKnowledgeBase();
  if (opts.seeds) seedKnowledge(kb);
  const wm = opts.wm ?? new InMemoryWorldModel();
  const probe: Probe = { executions: 0, trapHits: 0, l3Rounds: 0 };

  const vision = createRealVisionStationWin(world);
  const visionProbe = {
    async perceive(env: any) {
      if (env?.payload?.forceL3) probe.l3Rounds += 1;
      return await vision.perceive(env);
    },
  };
  const execStation = createRealExecutionStationWin(world);
  const execution = {
    async execute(env: any) {
      probe.executions += 1;
      const r = await execStation.execute(env);
      if (r.status === 'failure' && r.failure?.detail?.includes("'delete item'")) probe.trapHits += 1;
      return r;
    },
  };

  const o = new KnowledgePipelineOrchestrator();
  assert.ok(o.configure(BENCH_CONFIG).ok);
  o.wire(
    {
      vision: visionProbe as any, decision: new ReflexiveDecisionStation({ chat: null }),
      execution: execution as any, knowledge: kb, verdictBridge: new DoctorVerdictBridge(),
      emit: () => { /* 旁路 */ },
    },
    { stateDir: opts.stateDir, metricsPath: opts.metricsPath },
  );
  const report = await o.run({ id: `real-win-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, description: intentDescription });
  if (report.verdict !== 'completed') {
    console.error(`[real-win] ${intentDescription} → ${report.verdict}: ${report.terminalReason}`);
  }
  await (execStation as any).dispose?.();
  return { report, probe };
}

const gate = await windowsRealMachineGate();
const maybeTestWin = gate.ok ? test : test.skip;

maybeTestWin('W1+W2: Windows 真机链路 —— 真 OCR 读世界 + 真鼠标点击闭环', async () => {
  const world = await startRealWorldWin();
  try {
    // W1：服务真截屏 → OCR 读出两个按钮（感知层的物理证据）
    const png = await captureWorldRegion(world);
    const lines = await ocrLines(png);
    const text = lines.map((l: { text: string }) => l.text).join(' | ');
    assert.ok(/delete\s*item/i.test(text), `OCR 应读出陷阱按钮：${text}`);
    assert.ok(/clear\s*log/i.test(text), `OCR 应读出活路按钮：${text}`);
    console.log(`✔ W1 真 OCR 感知：${text.replace(/\|/g, ',')}`);

    // W2：真 pyautogui 点击活路按钮（OCR bbox 定位）⇒ 世界 done=true
    const safe = lines.find((l: { text: string }) => /clear\s*item|clear\s*log/i.test(l.text))!;
    const cx = (safe.bbox.x0 + safe.bbox.x1) / 2 / 800;
    const cy = (safe.bbox.y0 + safe.bbox.y1) / 2 / 600;
    const execStation = createRealExecutionStationWin(world);
    const r = await execStation.execute({ payload: { kind: 'click_mouse', args: { x: cx, y: cy }, rationale: 'W2 real click' } });
    await (execStation as any).dispose?.();
    assert.equal(r.status, 'success', `真鼠标点击活路应成功（OCR 中心 (${cx.toFixed(3)},${cy.toFixed(3)})）`);
    assert.equal(world.state().done, true, '世界状态 done=true —— 真实点击真实到达');
    console.log('✔ W2 真鼠标 e2e：pyautogui 物理点击 → tkinter 回调 → 世界状态翻转');
  } finally {
    await world.dispose();
  }
});

maybeTestWin('W3: E1b-R 陷阱改道（Windows 真机认知层）', async () => {
  const world = await startRealWorldWin();
  const stateDir = mkdtempSync(join(tmpdir(), 'd7-win-w3-'));
  const metricsPath = join(stateDir, 'metrics.jsonl');
  try {
    const saved = await runIntent(world, 'delete the record', { seeds: true, stateDir, metricsPath });
    const blind = await runIntent(world, 'delete the record', { stateDir });
    assert.equal(saved.report.verdict, 'completed', `种子记忆应改道成功: ${saved.report.terminalReason}`);
    assert.equal(saved.probe.trapHits, 0, '陷阱记忆完全避开真实陷阱按钮');
    assert.ok(saved.probe.executions >= 1, '至少一次真实执行');
    // 无先验侧如实申报（硬件或有）：blind 可能付学费（踩陷阱）、可能重试内学
    // 改道、也可能首瞄活路直通 —— 三者都是无先验合法结局。确定性的主张在
    // 免疫侧：有种子知识 ⇒ 0 陷阱点击 + 改道成功（上方两条硬断言）。
    console.log(`[W3-blind] verdict=${blind.report.verdict} trapHits=${blind.probe.trapHits} exec=${blind.probe.executions}（无先验结局如实入账）`);
    console.log(`✔ W3 陷阱改道（win）：saved trapHits=0/exec=${saved.probe.executions}，blind trapHits=${blind.probe.trapHits}`);
  } finally {
    await world.dispose();
    await disposeOcrWin();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

maybeTestWin('W4: E3-R 学习曲线（Windows 真机：学费 = 真实陷阱点击）', async () => {
  const world = await startRealWorldWin();
  const stateDir = mkdtempSync(join(tmpdir(), 'd7-win-w4-'));
  const amnesiaDir = mkdtempSync(join(tmpdir(), 'd7-win-w4-amn-'));
  const metricsPath = join(stateDir, 'metrics.jsonl');
  try {
    const d1trap = await runIntent(world, 'delete the record', { stateDir, metricsPath });
    const d1safe = await runIntent(world, 'clear the log', { stateDir, metricsPath });
    const d2 = await runIntent(world, 'delete the record', { stateDir, metricsPath });
    const d2amnesia = await runIntent(world, 'delete the record', { stateDir: amnesiaDir });

    const ledger = new MetricsLedger(metricsPath);
    const { records } = ledger.readAll();
    const curve = { first: summarizeRuns(records.slice(0, 2)), second: summarizeRuns(records.slice(2)) };
    console.log(`仪表盘: runs=${records.length} Day1(success=${curve.first.successRate}) → Day2(success=${curve.second.successRate})`);

    assert.equal(d1trap.report.verdict, 'failed', 'Day1 陷阱意图失败（无先验）');
    assert.ok(d1trap.probe.trapHits >= 1, `Day1 真实踩坑（${d1trap.probe.trapHits}）`);
    assert.equal(d1safe.report.verdict, 'completed', `Day1 活路意图成功: ${d1safe.report.terminalReason}`);
    assert.equal(d2.report.verdict, 'completed', `Day2 旧脑改道成功: ${d2.report.terminalReason}`);
    assert.equal(d2.probe.trapHits, 0, 'Day2 零陷阱点击');
    assert.equal(d2amnesia.report.verdict, 'failed', '遗忘症对照仍失败');
    console.log('✔ W4 学习曲线（win）：Day1 踩坑 → Day2 旧脑水合改道；遗忘症对照仍失败');
  } finally {
    await world.dispose();
    await disposeOcrWin();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(amnesiaDir, { recursive: true, force: true });
  }
});

// 环境缺席时的诚实申报（非 win32 / 服务未起 ⇒ skip 理由可审计）
test('W0: Windows 真机闸 —— 环境缺席诚实申报', () => {
  if (gate.ok) {
    assert.ok(process.platform === 'win32', 'gate 放行 ⇒ 必在 win32');
  } else {
    console.log(`[W0] Windows 真机基准跳过：${gate.reason}`);
  }
});
