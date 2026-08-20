// test/realMachine.bench.ts
// 真机消融基准 —— 同一基准语义（ablation.bench.ts），但世界是真的：
//   感知 = X11 截屏像素 → tesseract OCR（无 mock 元素表）
//   执行 = xdotool 真实点击 → tkinter 回调真实触发
//   裁决 = 应用状态文件（世界真相，非脚本裁决）
//
// 实验（与 stub 基准一一对应）：
//   E1b-R 陷阱改道    —— 字面诱惑 intent + 陷阱记忆 ⇒ 免疫压制 + 前额叶改道
//   E3-R  学习曲线    —— Day1 踩坑学习 → Day2 旧脑水合改道成功（遗忘症对照仍失败）
//
// 运行前提（环境准备，一次性）：
//   apt-get install xvfb xdotool imagemagick && Xvfb :77 -screen 0 800x600x24
//   npm install tesseract.js sharp --no-save（感知引擎：截屏 OCR）
//   harness 自管应用生命周期（spawn/reset/dispose tkinter 世界）。
// 备注：metrics.jsonl 的 l3Rounds 在真机里是「L3 授权计数」（惊讶计费器开火）——
//   真机纪元无 L3 VLM 后端，授权被诚实记录而不被消费。
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
  startRealWorld, createRealVisionStation, createRealExecutionStation, disposeOcr,
} from './realWorldHarness.ts';
import type { PipelineConfig, PipelineReport } from '../src/knowledge/contracts.ts';

// 真机纪元预算：OCR ~1-2s/轮（像素→文字的物理成本，桩纪元的 0ms 是幻觉）
const BENCH_CONFIG: PipelineConfig = {
  timeout: { overall: 60_000, perStep: 10_000, perPerception: 15_000 },
  retryPolicy: { maxRetries: 2, backoffMs: 1, maxBackoffMs: 2 },
  knowledgeTimeout: 200, knowledgeMaxResults: 5, knowledgeMaxChars: 300,
};

/** 种子知识（与 stub 基准同文 —— 公平对照的前提） */
function seedKnowledge(kb: InMemoryKnowledgeBase): void {
  kb.insert({ category: 'error-pattern', content: 'delete item button is broken, clicks fail', scenario: 'record cleanup', confidence: 0.55, source: 'manual' });
  kb.insert({ category: 'workflow', content: 'clear log after erasing records', scenario: 'record cleanup', confidence: 0.6, source: 'manual' });
}

interface Probe { executions: number; trapHits: number; l3Rounds: number }

/** 跑一个意图（每次都世界复位 —— 应用重启，状态清零，零跨 run 污染） */
async function runIntent(
  world: Awaited<ReturnType<typeof startRealWorld>>,
  intentDescription: string,
  opts: {
    seeds?: boolean;
    kb?: InMemoryKnowledgeBase;
    wm?: InMemoryWorldModel;
    stateDir?: string;
    metricsPath?: string;
  } = {},
): Promise<{ report: PipelineReport; probe: Probe }> {
  await world.reset(); // 世界复位：同一意图每次面对同一初始屏幕
  const kb = opts.kb ?? new InMemoryKnowledgeBase();
  if (opts.seeds) seedKnowledge(kb);
  const wm = opts.wm ?? new InMemoryWorldModel();
  const probe: Probe = { executions: 0, trapHits: 0, l3Rounds: 0 };

  const vision = createRealVisionStation();
  const visionProbe = {
    async perceive(env: any) {
      if (env?.payload?.forceL3) probe.l3Rounds += 1; // L3 授权记录（真机纪元无 L3 后端，诚实计数不伪造视觉）
      const t0 = Date.now();
      try {
        return await vision.perceive(env);
      } catch (e: any) {
        console.error(`[real-vision] perceive fault after ${Date.now() - t0}ms: ${e.message}`);
        throw e;
      }
    },
  };
  const execution = {
    async execute(env: any) {
      probe.executions += 1;
      const r = await createRealExecutionStation(world).execute(env);
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
  const report = await o.run({ id: `real-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, description: intentDescription });
  if (report.verdict !== 'completed') {
    console.error(`[real-run] ${intentDescription} → ${report.verdict}: ${report.terminalReason}`);
  }
  return { report, probe };
}

function row(label: string, report: PipelineReport, probe: Probe): string {
  return `${label.padEnd(30)} ${report.verdict.padEnd(10)} executions=${String(probe.executions).padEnd(2)} trapHits=${probe.trapHits} l3=${probe.l3Rounds}`;
}

test('真机基准（Xvfb+tkinter+OCR+xdotool —— 感知/执行/裁决全真实）', async () => {
  // 结构注：不使用嵌套 t.test() —— node 24 的 await t.test() 在子测试注册后即
  // resolve（不等完成），finally 会与子测试并发执行（实测杀掉运行中的世界）。
  // 两个实验用普通 async 阶段函数顺序 await，finally 才有真实的「结束」语义。
  const world = await startRealWorld();
  const stateDir = mkdtempSync(join(tmpdir(), 'd7-real-learn-'));
  const amnesiaDir = mkdtempSync(join(tmpdir(), 'd7-real-amnesia-'));
  const metricsPath = join(stateDir, 'metrics.jsonl');
  const lines: string[] = ['── 真机基准：世界 = X11 真实窗口（截图OCR感知 / xdotool点击 / 状态文件裁决）──'];

  try {
    // ── E1b-R：陷阱改道（种子知识 = 老员工笔记）──
    {
      const saved = await runIntent(world, 'delete the record', { seeds: true });
      lines.push(row('E1b-R 种子知识+诱惑intent', saved.report, saved.probe));

      const blind = await runIntent(world, 'delete the record', {});
      lines.push(row('E1b-R 无知识（直扑陷阱）', blind.report, blind.probe));

      console.log(lines.slice(0, 3).join('\n'));

      assert.equal(saved.report.verdict, 'completed', `应改道成功: ${saved.report.terminalReason}`);
      assert.equal(saved.probe.trapHits, 0, '陷阱记忆应完全避开真实陷阱按钮');
      assert.ok(saved.probe.executions >= 1, '至少一次真实执行');
      assert.equal(blind.report.verdict, 'failed', '无知识应失败');
      assert.ok(blind.probe.trapHits >= 2, `无知识应反复踩真实陷阱（实际 ${blind.probe.trapHits} 次）`);
      console.log('✔ E1b-R 真机陷阱改道：免疫压制 + 前额叶改道活路');
    }

    // ── E3-R：学习曲线（无种子，一切靠真实踩坑经历）──
    {
      const curveLines: string[] = ['── E3-R 真机学习曲线（无种子知识，学费 = 真实陷阱点击）──'];

      // Day1：陷阱意图直扑（反射+重试烧钱后失败 —— 学习陷阱记忆）
      const d1trap = await runIntent(world, 'delete the record', { stateDir, metricsPath });
      curveLines.push(row('Day1 "delete the record"', d1trap.report, d1trap.probe));

      // Day1：活路意图反射命中（成功 —— 学习 workflow 记忆）
      const d1safe = await runIntent(world, 'clear the log', { stateDir, metricsPath });
      curveLines.push(row('Day1 "clear the log"', d1safe.report, d1safe.probe));

      // Day2：同陷阱意图，新编排器（新会话），旧脑从 stateDir 水合
      const d2 = await runIntent(world, 'delete the record', { stateDir, metricsPath });
      curveLines.push(row('Day2 "delete the record"（旧脑）', d2.report, d2.probe));

      // 遗忘症对照：同配置，无旧脑
      const d2amnesia = await runIntent(world, 'delete the record', { stateDir: amnesiaDir });
      curveLines.push(row('Day2 遗忘症对照（无旧脑）', d2amnesia.report, d2amnesia.probe));

      // 仪表盘聚合
      const ledger = new MetricsLedger(metricsPath);
      const { records } = ledger.readAll();
      const curve = { first: summarizeRuns(records.slice(0, 2)), second: summarizeRuns(records.slice(2)) };
      curveLines.push(`仪表盘: runs=${records.length} Day1(success=${curve.first.successRate}, avgExec=${curve.first.avgExecutions}) → Day2(success=${curve.second.successRate}, avgExec=${curve.second.avgExecutions})`);
      console.log(curveLines.join('\n'));

      assert.equal(d1trap.report.verdict, 'failed', 'Day1 陷阱意图失败（无先验）');
      assert.ok(d1trap.probe.trapHits >= 2, 'Day1 真实踩坑（学费交了）');
      assert.equal(d1safe.report.verdict, 'completed', 'Day1 活路意图成功');
      assert.equal(d2.report.verdict, 'completed', `Day2 应凭旧脑改道成功: ${d2.report.terminalReason}`);
      assert.equal(d2.probe.trapHits, 0, 'Day2 零陷阱点击');
      assert.ok(d2.probe.executions >= 1, 'Day2 命中活路（真机 OCR bbox 可能引发一次 miss 重试）');
      assert.equal(d2amnesia.report.verdict, 'failed', '遗忘症对照必须仍失败');
      assert.ok(d2amnesia.probe.trapHits >= 2, '遗忘症照旧踩坑');
      assert.equal(records.length, 3);
      assert.equal(curve.second.successRate, 1);
      assert.equal(curve.first.successRate, 0.5);
      console.log('✔ E3-R 真机学习曲线：Day1 踩坑 → Day2 旧脑水合改道；遗忘症对照仍失败');
    }
  } finally {
    console.error('[bench] finally: disposing world...');
    await world.dispose();
    console.error('[bench] world disposed, disposing ocr...');
    await disposeOcr();
    console.error('[bench] ocr disposed, cleanup tmp...');
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(amnesiaDir, { recursive: true, force: true });
    console.error('[bench] finally complete');
  }
});
