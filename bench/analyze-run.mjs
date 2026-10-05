#!/usr/bin/env node
// bench/analyze-run.mjs — R1-7 实战优化回路的分析器 CLI:证据包 → 结构化分析报告(JSON+MD)+ 工单。
//
// 输入(二选一,自动识别):
//   · R1-4 drive-hardened 证据包目录 <out>/<suite>/(含 <task-id>/{hist,session-events,
//     journal-lines}.jsonl + receipt.json;开跑前自动先跑 R1-7 enrich-evidence 采集增强);
//   · battery.mjs 的 report.json(w2bench-report/1;results[].events 为 ev:call|result 形态,
//     无 per-task 目录 —— 增强与 journal 信号按缺席诚实降级)。
//
// 输出(写 <输入目录>/analysis/,--out 可改):
//   report.json   结构化全量(aggregate/patterns/compare/tickets/tasks)
//   report.md     人读版(失败归类表/跨任务模式/任务清单/工单)
//   tickets.json  工单清单(r17-ticket/1:现象/证据路径/疑似模块/优先级)—— 下一波优化的直接输入
//
// 基线固化(对齐 bench/baselines/ 既有机制):
//   首轮(无 <suite>.analysis.json 基线)自动把本轮 aggregate 存为基线;之后轮次自动
//   对比(共有任务同总体口径);--refresh-baseline 覆盖(旧基线归档 baselines/archive/)。
//
// 确定性:同输入 ⇒ report.json/tickets.json 逐字节稳定(唯一例外:顶层 generatedAt 时戳)。
// 退出码:0 正常 · 2 用法错/无可分析任务 · 3 基线文件损坏(不静默丢弃,换 --refresh-baseline 重建)。
//
// 用法: node bench/analyze-run.mjs <suiteDir|report.json> [--out <dir>]
//         [--baseline <file>] [--refresh-baseline] [--no-save-baseline] [--no-enrich] [--quiet]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { writeFile, mkdir, rename, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildTaskView, aggregateViews, crossTaskPatterns, compareWithBaselineReport,
  buildTickets, renderReportMarkdown,
} from './analyzeCore.mjs';
import { enrichSuite } from './enrich-evidence.mjs';

const BENCH_DIR = fileURLToPath(new URL('./', import.meta.url));
const BASELINES_DIR = path.join(BENCH_DIR, 'baselines');
const ARCHIVE_DIR = path.join(BASELINES_DIR, 'archive');
const safeSeg = (id) => String(id).replace(/[^\w.-]/g, '_');

// ─── 装载器:drive 证据包 → raw 视图材料 ───

function readJsonl(file) {
  if (!existsSync(file)) return { rows: [], dropped: 0 };
  const out = { rows: [], dropped: 0 };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.rows.push(JSON.parse(t)); } catch { out.dropped++; }
  }
  return out;
}

function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function loadDriveSuite(suiteDir) {
  const summary = readJson(path.join(suiteDir, 'summary.json'), {});
  const taskIds = readdirSync(suiteDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(suiteDir, d.name, 'receipt.json')))
    .map((d) => d.name)
    .sort();
  const raws = taskIds.map((dirName) => {
    const td = path.join(suiteDir, dirName);
    const receipt = readJson(path.join(td, 'receipt.json'), {});
    return {
      taskId: receipt.taskId ?? dirName,
      category: null, // drive 回执不带 suite 类别;summary.taskRecords 有(对齐之)
      receipt,
      histRows: readJsonl(path.join(td, 'hist.jsonl')).rows,
      events: readJsonl(path.join(td, 'session-events.jsonl')).rows,
      journalRows: readJsonl(path.join(td, 'journal-lines.jsonl')).rows,
      enriched: {
        vlmMeter: readJson(path.join(td, 'vlm-meter.json')),
        retryChain: readJson(path.join(td, 'retry-chain.json')),
        kernelSnapshot: readJson(path.join(td, 'kernel-snapshot.json')),
        journalStats: readJson(path.join(td, 'journal-stats.json')),
        frames: readJson(path.join(td, 'frames', 'manifest.json')),
      },
      evidencePaths: {
        taskDir: dirName,
        receipt: `${dirName}/receipt.json`,
        hist: `${dirName}/hist.jsonl`,
        events: `${dirName}/session-events.jsonl`,
        journal: `${dirName}/journal-lines.jsonl`,
        vlmMeter: `${dirName}/vlm-meter.json`,
        retryChain: `${dirName}/retry-chain.json`,
        frames: `${dirName}/frames/`,
      },
    };
  });
  // category 从 summary.taskRecords 对齐(缺席 ⇒ null,不猜)
  const byId = new Map((summary.taskRecords ?? []).map((r) => [r.id, r]));
  for (const raw of raws) raw.category = byId.get(raw.taskId)?.category ?? null;
  return {
    kind: 'drive',
    runId: summary.runId ?? path.basename(suiteDir),
    suiteName: summary.suiteName ?? path.basename(suiteDir),
    evidenceRoot: path.resolve(suiteDir),
    raws,
  };
}

// ─── 装载器:battery report.json → raw 视图材料(rec 转写为 receipt 形) ───

function loadBatteryReport(reportFile) {
  const report = readJson(reportFile, null);
  if (!report || !Array.isArray(report.results)) return null;
  const raws = report.results.map((rec) => ({
    taskId: rec.id,
    category: rec.category ?? null,
    isRerun: !!rec.rerunOf,
    receipt: {
      pass: rec.pass,
      trajectoryPass: rec.trajectoryPass ?? null,
      failedExpectations: rec.failedExpectations ?? null,
      timedOut: rec.timedOut === true,
      waitedMs: rec.waitedMs ?? null,
      timeoutPlan: null,
      harnessError: rec.harnessError ?? null,
      interrupted: false,
      promptUncertain: false,
      retries: [],
      e2: rec.verify ? { present: true, result: rec.verify } : { present: false },
    },
    histRows: rec.events ?? [],
    events: [],
    journalRows: [],
    enriched: null,
    evidencePaths: { report: path.basename(reportFile) },
  }));
  return {
    kind: 'battery',
    runId: report.runId ?? path.basename(reportFile),
    suiteName: report.suiteFile ? path.basename(report.suiteFile).replace(/\.json$/, '') : 'battery',
    evidenceRoot: path.dirname(path.resolve(reportFile)),
    raws,
  };
}

// ─── 基线(既有 bench/baselines/ 机制对齐:suite 维度单文件 + archive 归档) ───

async function saveBaseline(file, { schema, runId, suiteName, aggregate }) {
  await mkdir(path.dirname(file), { recursive: true });
  if (existsSync(file)) {
    // 覆盖前归档(时间戳前缀,与 baselines/archive/ 既有形态一致)
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    try {
      await mkdir(ARCHIVE_DIR, { recursive: true });
      await copyFile(file, path.join(ARCHIVE_DIR, `${stamp}-${path.basename(file)}`));
    } catch { /* 归档失败不阻断 */ }
  }
  const body = { schema, runId, suiteName, savedAt: new Date().toISOString(), aggregate };
  await writeFile(file + '.tmp', JSON.stringify(body, null, 1), 'utf8');
  await rename(file + '.tmp', file);
  return file;
}

// ─── CLI ───

function usage() {
  console.log(`用法: node bench/analyze-run.mjs <suiteDir|report.json> [options]
  --out=<dir>             输出目录(缺省 <输入目录>/analysis/)
  --baseline=<file>       显式基线文件(缺省 bench/baselines/<suite>.analysis.json)
  --refresh-baseline      覆盖基线(旧档归档 baselines/archive/)
  --no-save-baseline      不固化基线(只分析)
  --no-enrich             跳过采集增强(drive 布局默认前置 enrich-evidence)
  --quiet                 少打印
退出码 0/2/3(3=基线损坏 —— --refresh-baseline 重建)`);
}

function parseArgs(argv) {
  const opts = { input: null, out: null, baseline: null, refreshBaseline: false, saveBaseline: true, enrich: true, quiet: false, help: false };
  for (const a of argv) {
    if (a === '--refresh-baseline') opts.refreshBaseline = true;
    else if (a === '--no-save-baseline') opts.saveBaseline = false;
    else if (a === '--no-enrich') opts.enrich = false;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--out=')) opts.out = a.slice(6);
    else if (a.startsWith('--baseline=')) opts.baseline = a.slice(11);
    else if (a.startsWith('--')) { usage(); process.exit(2); }
    else opts.input = a;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.input) { usage(); process.exit(opts.help ? 0 : 2); }
  if (!existsSync(opts.input)) { console.error(`输入不存在: ${opts.input}`); process.exit(2); }

  // 输入识别 + 装载
  const isBattery = opts.input.endsWith('.json');
  let loaded = isBattery ? loadBatteryReport(opts.input) : null;
  if (isBattery && !loaded) { console.error(`不是 w2bench-report 形态(缺 results[]): ${opts.input}`); process.exit(2); }
  if (!loaded) {
    // drive 布局:先采集增强(幂等;--no-enrich 跳过 —— 增强件缺席时信号诚实降级)
    if (opts.enrich) await enrichSuite(opts.input, { quiet: opts.quiet });
    loaded = loadDriveSuite(opts.input);
    if (loaded.raws.length === 0) { console.error(`未发现任务目录(需 <task-id>/receipt.json): ${opts.input}`); process.exit(2); }
  }
  if (loaded.raws.length === 0) { console.error('无可分析任务'); process.exit(2); }

  // 视图构建(纯变换;rerun 标记透传到聚合过滤)
  const views = loaded.raws.map((raw) => {
    const v = buildTaskView(raw);
    v.isRerun = !!raw.isRerun;
    return v;
  });
  const aggregate = aggregateViews(views);
  const patterns = crossTaskPatterns(views);

  // 基线:缺省 bench/baselines/<suite>.analysis.json;首轮固化,之后对比
  const baselineFile = opts.baseline ?? path.join(BASELINES_DIR, `${safeSeg(loaded.suiteName)}.analysis.json`);
  const baseline = opts.refreshBaseline ? null : readJson(baselineFile, null);
  if (existsSync(baselineFile) && !opts.refreshBaseline && (!baseline || !baseline.aggregate)) {
    console.error(`基线损坏(无 aggregate 域): ${baselineFile} —— 用 --refresh-baseline 重建,不静默丢弃`);
    process.exit(3);
  }
  const compare = baseline ? compareWithBaselineReport(aggregate, baseline) : null;

  const tickets = buildTickets({ views: views.filter((v) => !v.isRerun), aggregate, patterns, compare, evidenceRoot: '' });
  const analysis = {
    schema: 'r17-analysis-report/1',
    generatedBy: 'R1-7 analyze-run(证据采集→缺陷分析→优化工单 回路)',
    generatedAt: new Date().toISOString(), // 确定性例外:唯一时戳字段
    input: { path: path.resolve(opts.input), kind: loaded.kind, suiteName: loaded.suiteName, runId: loaded.runId },
    evidenceRoot: loaded.evidenceRoot,
    aggregate, patterns,
    baseline: { file: baselineFile, existed: !!baseline, refreshed: opts.refreshBaseline, savedThisRun: false },
    compare,
    tickets,
    taskViews: views.filter((v) => !v.isRerun).map((v) => ({
      taskId: v.taskId, category: v.category, pass: v.pass, failureCategory: v.failureCategory,
      steps: v.steps, toolCalls: v.toolCalls, timedOut: v.timedOut, waitedMs: v.waitedMs,
      effectiveTimeoutMs: v.effectiveTimeoutMs, toolErrors: v.toolErrors, turnErrors: v.turnErrors,
      maxConsecutiveRepeat: v.maxConsecutiveRepeat,
      vlm: v.vlm, journal: v.journal, rpc: v.rpc, retryChain: v.retryChain,
      guardBlocked: v.guardBlocked, approvalDeadlock: v.approvalDeadlock,
      harnessError: v.harnessError, promptUncertain: v.promptUncertain,
      failedExpectations: v.failedExpectations,
      kernel: v.kernel, frames: v.frames, evidencePaths: v.evidencePaths,
    })),
  };

  // 基线固化(首轮 or --refresh-baseline;--no-save-baseline 只读不写)
  if (opts.saveBaseline && (!baseline || opts.refreshBaseline)) {
    await saveBaseline(baselineFile, { schema: 'r17-analysis-baseline/1', runId: loaded.runId, suiteName: loaded.suiteName, aggregate });
    analysis.baseline.savedThisRun = true;
  }

  // 落盘:<输入目录>/analysis/{report.json,report.md,tickets.json}
  const outDir = opts.out ?? (isBattery ? path.join(path.dirname(path.resolve(opts.input)), 'analysis') : path.join(opts.input, 'analysis'));
  await mkdir(outDir, { recursive: true });
  const md = renderReportMarkdown({
    runId: loaded.runId, suiteName: loaded.suiteName, aggregate, patterns, compare, tickets,
    enrichStats: loaded.kind === 'drive' && opts.enrich ? 'vlm-meter/retry-chain/kernel-snapshot/journal-stats/frames 已前置补齐(enrich-evidence)' : 'battery 报告输入 —— journal/VLM 计量信号按缺席降级',
  });
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(analysis, null, 1), 'utf8');
  await writeFile(path.join(outDir, 'report.md'), md, 'utf8');
  await writeFile(path.join(outDir, 'tickets.json'), JSON.stringify({
    schema: 'r17-tickets/1', generatedAt: analysis.generatedAt,
    evidenceRoot: loaded.evidenceRoot, sourceRun: loaded.runId, suite: loaded.suiteName,
    tickets,
  }, null, 1), 'utf8');

  // 控制台摘要
  console.log(`R1-7 analyze: ${loaded.runId}(${loaded.kind}) 任务=${aggregate.tasks} 通过=${aggregate.pass}(${Math.round((aggregate.passRate ?? 0) * 1000) / 10}%)`);
  const fbj = JSON.stringify(aggregate.failuresByCategory);
  console.log(`  失败归类: ${fbj === '{}' ? '无失败' : fbj}`);
  if (compare) console.log(`  基线对比: 共有${compare.sharedTasks} Δ=${compare.passRateDelta} 回归=[${compare.regressed.join(',') || '-'}] 改善=[${compare.improved.join(',') || '-'}]`);
  console.log(`  工单: ${tickets.length} 条(P0=${tickets.filter((t) => t.priority === 'P0').length} P1=${tickets.filter((t) => t.priority === 'P1').length} P2=${tickets.filter((t) => t.priority === 'P2').length})`);
  console.log(`  报告: ${path.join(outDir, 'report.md')}`);
  console.log(`  工单: ${path.join(outDir, 'tickets.json')}`);
  if (analysis.baseline.savedThisRun) console.log(`  基线已固化: ${baselineFile}`);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked && import.meta.url === invoked) {
  main().catch((e) => { console.error('ANALYZE ERROR:', e); process.exit(1); });
}
