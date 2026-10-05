#!/usr/bin/env node
// bench/enrich-evidence.mjs — R1-7 采集增强:R1-4 证据包的优化向信号补齐(后置处理器)。
//
// R1-4 证据包(hist/session-events/journal 切片/receipt+E2)缺四类优化向信号:
//   1. vlmMeter 计量切片(token/延迟/降级计数)—— vlmMeter 活在插件进程内存,事后不可回取;
//      本器从 session-events.jsonl 的 VLM 族调用行**机会主义重建**(调用数/错误/降级/延迟
//      若 ts 在场),落盘 vlm-meter.json(纯核 analyzeCore.vlmMeterFromEvents);
//   2. kernelRegistry/telemetry 快照 —— 同为内存态;若任务历史里有 get_metrics 形态结果则
//      提取,否则诚实记 present:false + 如何点亮的提示(kernel-snapshot.json);
//   3. 失败步的重试链 —— 从 hist 的同名工具连发 + result.isError + turn_error 重建
//      (retry-chain.json;纯核 analyzeCore.retryChainsFromHist);RPC 侧从 receipt.retries 并入;
//   4. 截图留档(每任务首末帧,供人工复盘 grounding 质量)—— 任务时刻的首帧不可追拍
//      (后置处理器的诚实边界);既有截图(E2 screenshots/ + evidence/)按文件序挑首末归档
//      到 frames/,并留 manifest 说明来源;一张都没有 ⇒ frames/manifest.json 如实记 absent。
//
// 纪律:只增不改(证据包原件零触碰,全部新文件旁挂);幂等(已增强的任务跳过,--force 重做);
//       确定性(同输入同输出;文件序排序);密钥脱敏(analyzeCore.redactSecrets)。
//
// 用法: node bench/enrich-evidence.mjs <suiteDir> [--force] [--quiet]
//   <suiteDir> = drive-hardened 的 <out>/<suite>/ 目录(内有 <task-id>/ 子目录)
import { existsSync, readFileSync, readdirSync, copyFileSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  vlmMeterFromEvents, retryChainsFromHist, kernelSnapshotFromHist, journalActionStats,
  rpcRetrySummary, redactSecrets, normalizeHistRow,
} from './analyzeCore.mjs';

// ─── JSONL 读取(坏行不炸:计数后跳过,与 journalWindow 的 dropped 同律) ───

function readJsonl(file) {
  const out = { rows: [], dropped: 0 };
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.rows.push(JSON.parse(t)); } catch { out.dropped++; }
  }
  return out;
}

async function writeAtomicJson(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file + '.tmp', JSON.stringify(obj, null, 1), 'utf8');
  await rename(file + '.tmp', file);
}

// ─── 首末帧留档:既有截图的确定性挑帧(文件名排序,时间戳内嵌于名) ───

function listImages(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
    .sort();
}

function isTaskDir(name, entries) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return false;
  return entries.some((f) => f === 'receipt.json' || f === 'hist.jsonl');
}

// ─── 单任务增强(决策在 analyzeCore,此处只编排 IO) ───

async function enrichTask(taskDir, { force, quiet }) {
  const td = readdirSync(taskDir);
  const eventsFile = path.join(taskDir, 'session-events.jsonl');
  const histFile = path.join(taskDir, 'hist.jsonl');
  const journalFile = path.join(taskDir, 'journal-lines.jsonl');
  const receiptFile = path.join(taskDir, 'receipt.json');

  const already = td.includes('vlm-meter.json') && td.includes('retry-chain.json') && td.includes('kernel-snapshot.json');
  if (already && !force) return { skipped: true };

  // 1) vlm 计量切片
  const ev = readJsonl(eventsFile);
  const meter = { ...vlmMeterFromEvents(ev.rows), source: 'session-events.jsonl', droppedLines: ev.dropped };
  await writeAtomicJson(path.join(taskDir, 'vlm-meter.json'), meter);

  // 2) 重试链(hist 同名连发 + RPC 账并入)
  const hist = readJsonl(histFile);
  const receipt = existsSync(receiptFile) ? JSON.parse(readFileSync(receiptFile, 'utf8')) : {};
  const chain = {
    ...retryChainsFromHist(hist.rows),
    rpc: rpcRetrySummary(receipt.retries ?? []),
    promptUncertain: receipt.promptUncertain === true,
    droppedLines: hist.dropped,
  };
  await writeAtomicJson(path.join(taskDir, 'retry-chain.json'), chain);

  // 3) kernel/telemetry 快照(机会主义)
  await writeAtomicJson(path.join(taskDir, 'kernel-snapshot.json'), kernelSnapshotFromHist(hist.rows));

  // 4) journal 统计(stepGap/noopish/GUARD_BLOCKED —— analyze-run 也实时算,落盘供人工直读)
  const jr = readJsonl(journalFile);
  await writeAtomicJson(path.join(taskDir, 'journal-stats.json'), { ...journalActionStats(jr.rows), droppedLines: jr.dropped });

  // 5) 首末帧留档
  const framesDir = path.join(taskDir, 'frames');
  await mkdir(framesDir, { recursive: true });
  const shots = [
    ...listImages(path.join(taskDir, 'screenshots')).map((f) => path.join(taskDir, 'screenshots', f)),
    ...listImages(path.join(taskDir, 'evidence')).map((f) => path.join(taskDir, 'evidence', f)),
  ];
  const manifest = {
    schema: 'r17-frames/1',
    present: shots.length > 0,
    note: shots.length
      ? '首末帧自既有截图归档(E2 核查时刻;任务时刻首帧不可追拍 —— 后置处理器的诚实边界)'
      : 'absent:本任务无任何截图(E2 未截图或 e2=absent);需要首末帧复盘时给 suite 任务加 verify 块或 --screenshot',
    archivedFrom: shots.map((p) => path.basename(path.dirname(p)) + '/' + path.basename(p)),
  };
  if (shots.length > 0) {
    copyFileSync(shots[0], path.join(framesDir, 'first.png'));
    copyFileSync(shots[shots.length - 1], path.join(framesDir, 'last.png'));
    manifest.first = 'frames/first.png';
    manifest.last = 'frames/last.png';
  }
  await writeAtomicJson(path.join(framesDir, 'manifest.json'), manifest);

  if (!quiet) console.log(`  + ${path.basename(taskDir)}: vlm=${meter.calls}链=${chain.chainCount}帧=${shots.length ? 2 : 0}`);
  return { skipped: false, meter, chain, frames: manifest };
}

// ─── 套件级入口(analyze-run.mjs 自动前置调用;也可 CLI 单独跑) ───

/** 任务子目录识别:名字安全 + 含 receipt.json 或 hist.jsonl */
function listTaskDirs(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && isTaskDir(d.name, readdirSync(path.join(dir, d.name))))
    .map((d) => d.name)
    .sort();
}

export async function enrichSuite(dir, { force = false, quiet = false } = {}) {
  const tasks = listTaskDirs(dir);
  if (!quiet) console.log(`R1-7 enrich: ${dir}(${tasks.length} 任务)`);
  let enriched = 0, skipped = 0;
  for (const t of tasks) {
    const r = await enrichTask(path.join(dir, t), { force, quiet });
    if (r.skipped) skipped++;
    else enriched++;
  }
  console.log(`enrich 完成: 新增 ${enriched} · 跳过(已增强) ${skipped}${force ? '(--force)' : ''}`);
  return { tasks: tasks.length, enriched, skipped };
}

// ─── CLI ───

function usage() {
  console.log(`用法: node bench/enrich-evidence.mjs <suiteDir> [--force] [--quiet]
  <suiteDir>   R1-4 drive-hardened 证据包根(<out>/<suite>/,内含 <task-id>/ 子目录)
  --force      重做已增强的任务(覆盖增强件;证据原件始终不动)
  --quiet      只打印汇总
产物(每任务目录内新增,原件零触碰):
  vlm-meter.json · retry-chain.json · kernel-snapshot.json · journal-stats.json · frames/{first,last,manifest}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = { dir: null, force: false, quiet: false, help: false };
  for (const a of argv) {
    if (a === '--force') opts.force = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) { usage(); process.exit(2); }
    else opts.dir = a;
  }
  if (opts.help || !opts.dir) { usage(); process.exit(opts.help ? 0 : 2); }
  if (!existsSync(opts.dir)) { console.error(`目录不存在: ${opts.dir}`); process.exit(2); }
  const tasks = listTaskDirs(opts.dir);
  if (tasks.length === 0) {
    console.error(`未发现任务子目录(需含 receipt.json/hist.jsonl 之一): ${opts.dir}`);
    process.exit(2);
  }
  await enrichSuite(opts.dir, opts);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked && import.meta.url === invoked) {
  main().catch((e) => { console.error('ENRICH ERROR:', e); process.exit(1); });
}
