#!/usr/bin/env node
// bench/drive-hardened.mjs — R1-4 硬化驱动:dsh-drive.mjs → RPC → 会话 的长夜批量链路。
//
// 在 battery.mjs 的任务语义(建会话→下发→等完成→抓轨迹→E2 终判)之上,把「跑一整夜」
// 需要的驱动件补齐(决策逻辑全部在 bench/driveCore.mjs,此处只做 IO 编排):
//
//   1. 驱动健壮性 —— 全链路 RPC 退避重试(瞬态/致命二分:网络层与 5xx/429 重试,
//      4xx 与应用层 ok:false 立即上抛);等待空闲的超时分级(任务级钳制 [5,10]min +
//      总量熔断 6h 可调);超时/中断即取消(session.cancel,尽力重试);僵尸会话回收
//      (崩溃残留的本驱动会话,依 resume-state 的 liveSessions 认领,只回收自己的);
//      崩溃后断点续跑(resume-state.json 记录已完成任务 id,--resume 重入跳过)。
//   2. 证据采集 —— 每任务证据包 <out>/<suite>/<task-id>/:hist.jsonl(精简历史)/
//      session-events.jsonl(原始事件流裁剪)/ journal-lines.jsonl(插件行动日志时间窗
//      切片)/ receipt.json(最终回执)/ evidence/(E2 逐谓词观察)。采集全部后置于
//      会话终局 —— 永不打断任务。
//   3. 观测面 —— status.line(单行仪表:当前任务/进度/失败清单,每 tick 原子重写)+
//      summary.json(每任务后更新);E2 verify 在每任务结束后立即执行并写入回执。
//   4. 并发纪律 —— 真实桌面任务严格串行(一台机器一套鼠标键盘):进程内单会话循环,
//      跨进程 <suiteDir>/.drive.lock(pid 锁,活进程持锁即拒绝启动)。本驱动**不提供**
//      任何并发参数 —— 这不是缺省值,是不存在的旋钮。
//   5. kill-switch —— Ctrl-C 优雅退出(取消当前会话 + 落盘已完成部分,exit 130);
//      stopfile(<suiteDir>/STOP 出现即取消并退出,exit 3;启动时已存在则拒绝开跑 exit 6,
//      避免删了又跑的循环)。
//
// 退出码:0 完成/总量熔断 2 用法错 3 stopfile 停机 4 RPC 探测失败(静态登记,不启动 DSH)
//         5 锁被活进程持有 6 启动时 stopfile 已在 130 Ctrl-C 1 未预期错误
//
// 用法:
//   node bench/drive-hardened.mjs <suite.json> [--out <dir>] [--resume]
//       [--task-timeout-ms N] [--total-budget-ms N] [--stopfile <path>]
//       [--journal <path>] [--rpc-attempts N] [--no-screenshot] [--list] [--probe]
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { config, applySuiteSubstitutions, configSummary } from './config.mjs';
import { loadSuite } from './battery.mjs';
import { createWindowsWorld, runVerification, validateVerifyBlock } from './verifyCore.mjs';
import {
  RPC_MAX_ATTEMPTS, TOTAL_BUDGET_DEFAULT_MS, TASK_TIMEOUT_MIN_MS, TASK_TIMEOUT_MAX_MS,
  WAIT_POLL_MS, WAIT_STARTUP_GRACE_MS, POLL_ERROR_CIRCUIT,
  retryDecision, timeoutPlan, loadResumeState, planRun, commitTaskDone, registerLiveSession,
  shouldResendPrompt, promptSeenInHistory, findZombieSessions, journalWindow,
  planPostTask, stopDecision, renderStatusLine, buildRunSummary,
} from './driveCore.mjs';

const TASK_TIMEOUT_MIN_MS_LABEL = `${TASK_TIMEOUT_MIN_MS / 60000}min, ${TASK_TIMEOUT_MAX_MS / 60000}min`;

const BASE = config.apiBase; // ΑΩ-R30:端点读 bench/config.mjs(DSH_BENCH_ENDPOINT 可覆盖)
const BENCH_DIR = fileURLToPath(new URL('./', import.meta.url));
const JOURNAL_DEFAULT = process.env.DSH_BENCH_JOURNAL ?? path.join(BENCH_DIR, 'journal.jsonl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── kill-switch 全局态(Ctrl-C 双击 = 立即硬退;单击 = 优雅收束) ───
let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.error('\n[kill-switch] SIGINT —— 取消当前会话并落盘已完成部分(再按一次立即强制退出)');
});
process.on('SIGTERM', () => { interrupted = true; });

class GracefulStop extends Error {
  constructor(reason, exitCode) { super(`graceful-stop:${reason}`); this.reason = reason; this.exitCode = exitCode; }
}

// ─── RPC 底座:fetch + 分类标记 + 退避重试(决策问 driveCore) ───

async function rpc(method, payload) {
  let r;
  try {
    r = await fetch(BASE + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
    });
  } catch (e) {
    // 网络层失败:挂上 undici 的 cause.code 供 classifyRpcError 认瞬态
    e.code = e.code ?? e.cause?.code ?? null;
    throw e;
  }
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status} on ${method}`);
    err.status = r.status;
    throw err;
  }
  const j = await r.json();
  if (!j.result?.ok) {
    const err = new Error(`rpc ${method} failed: ${JSON.stringify(j.result).slice(0, 300)}`);
    err.rpcRejected = true;
    throw err;
  }
  return j.result.value;
}

/**
 * rpcRetry —— 瞬态退避重试(fatal 立即上抛;重试日志入账供回执/汇总引用)。
 * force=true:SIGINT 后仍执行(kill-switch 的取消/收尾 RPC 自身不能被 kill-switch 卡死)。
 */
async function rpcRetry(method, payload, { attempts = RPC_MAX_ATTEMPTS, retryLog = [], force = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    if (interrupted && !force) throw new GracefulStop('sigint', 130);
    try {
      return await rpc(method, payload);
    } catch (e) {
      if (e instanceof GracefulStop) throw e;
      const d = retryDecision({ attempt, error: e, maxAttempts: attempts });
      retryLog.push({ method, attempt, kind: d.classification.kind, reason: d.reason, action: d.action });
      if (d.action === 'abort') throw e;
      console.error(`    ↻ rpc ${method} 第${attempt}次失败(${d.reason}),${d.delayMs}ms 后重试`);
      await sleep(d.delayMs);
    }
  }
}

async function isRunning(sessionId) {
  const v = await rpcRetry('session.list', {});
  const s = v.items.find((i) => i.sessionId === sessionId);
  if (!s) throw Object.assign(new Error('session not found: ' + sessionId), { rpcRejected: true });
  return !!s.running;
}

async function cancelSession(sessionId, retryLog) {
  // force:即使已收到 SIGINT 也要把取消发出去(kill-switch 的分内事就是取消当前会话)
  try { await rpcRetry('session.cancel', { sessionId }, { attempts: 2, retryLog, force: true }); return true; }
  catch (e) { if (e instanceof GracefulStop) throw e; console.error(`    ! cancel ${sessionId} 失败:${e.message}`); return false; }
}

// ─── 等待空闲:分级超时 + 轮询错误熔断 + 每 tick 停机检查 ───

/**
 * waitDoneHard —— 等会话转空闲:
 *   · effectiveTimeoutMs 由 timeoutPlan 预先算好(任务级钳制 ∧ 总量预算);
 *   · 轮询 RPC 失败容忍(瞬态抖动不计),但连续 POLL_ERROR_CIRCUIT 次 ⇒ 熔断该等待;
 *   · 每个 tick 检查 stopfile 与 SIGINT —— kill-switch 的响应粒度 = 轮询周期(3s)。
 */
async function waitDoneHard(sessionId, { effectiveTimeoutMs, stopfile, retryLog, onStopfile }) {
  await sleep(WAIT_STARTUP_GRACE_MS);
  const t0 = Date.now();
  let consecutiveErrors = 0;
  while (Date.now() - t0 < effectiveTimeoutMs) {
    if (interrupted) throw new GracefulStop('sigint', 130);
    if (existsSync(stopfile)) { onStopfile?.(); throw new GracefulStop('stopfile', 3); }
    let running = true;
    try { running = await isRunning(sessionId); consecutiveErrors = 0; }
    catch (e) {
      if (e instanceof GracefulStop) throw e;
      consecutiveErrors += 1;
      retryLog.push({ method: 'session.list(poll)', attempt: consecutiveErrors, kind: 'transient', reason: e.message.slice(0, 80), action: consecutiveErrors >= POLL_ERROR_CIRCUIT ? 'abort' : 'tolerated' });
      if (consecutiveErrors >= POLL_ERROR_CIRCUIT) throw new Error(`等待熔断:连续 ${POLL_ERROR_CIRCUIT} 次轮询失败(${e.message})`);
    }
    if (!running) return { ok: true, waitedMs: Date.now() - t0 };
    await sleep(WAIT_POLL_MS);
  }
  return { ok: false, waitedMs: Date.now() - t0 };
}

// ─── prompt 安全下发:瞬态重试 + 防重复(证据不足 ⇒ 不重发,driveCore 定方向) ───

async function sendPromptSafe(sessionId, text, retryLog) {
  for (let attempt = 1; ; attempt++) {
    if (interrupted) throw new GracefulStop('sigint', 130);
    try {
      return { sent: true, ...(await rpcRetry('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' }, { retryLog })) };
    } catch (e) {
      if (e instanceof GracefulStop) throw e;
      const d = retryDecision({ attempt, error: e });
      if (d.action === 'abort') throw e;
      // 重发前先取证:历史里已见该 prompt / 会话已在跑 ⇒ 绝不重发(桌面任务重复执行最贵)
      let history = null, historyAvailable = false;
      try { history = await rpcRetry('session.history', { sessionId }, { attempts: 2, retryLog }); historyAvailable = true; }
      catch (e2) { if (e2 instanceof GracefulStop) throw e2; }
      let running = false;
      try { running = await isRunning(sessionId); } catch (e2) { if (e2 instanceof GracefulStop) throw e2; }
      const verdict = shouldResendPrompt({
        historyAvailable,
        promptSeen: historyAvailable && promptSeenInHistory(history, text),
        running,
      });
      retryLog.push({ method: 'session.prompt', attempt, kind: d.classification.kind, reason: d.reason, action: verdict.resend ? 'resend' : `no-resend(${verdict.mode})` });
      if (!verdict.resend) return { sent: false, uncertain: !historyAvailable, mode: verdict.mode, reason: verdict.reason };
      await sleep(d.delayMs);
    }
  }
}

// ─── 历史精简(dsh-drive.mjs compactHistory 同形;新文件内复刻,不动旧文件) ───

function compactHistory(value) {
  const out = [];
  const assistants = [];
  for (const entry of value.events ?? []) {
    const e = entry.event;
    if (!e || !e.type) continue;
    if (e.type === 'tool/call') {
      out.push({ kind: 'call', seq: e.seq, name: e.data.name, args: e.data.arguments, turn: e.data.turn, step: e.data.step });
    } else if (e.type === 'tool/result') {
      const c = e.data.message?.content?.[0];
      const text = c?.content?.map((p) => p.text || '').join('\n') ?? '';
      out.push({
        kind: 'result', seq: e.seq, callId: c?.toolCallId, isError: !!c?.isError,
        text: text.length > 6000 ? text.slice(0, 6000) + '…[truncated]' : text,
        turn: e.data.turn, step: e.data.step,
      });
    } else if (e.type === 'assistant/message') {
      const text = (e.data?.content ?? []).map((p) => p.text || '').join('');
      if (text.trim()) assistants.push({ kind: 'assistant', seq: e.seq, text: text.slice(0, 4000) });
    } else if (e.type === 'user/message') {
      const text = (e.data?.content ?? []).map((p) => p.text || '').join('');
      out.push({ kind: 'user', seq: e.seq, text: text.slice(0, 500) });
    }
  }
  return [...out, ...assistants].sort((a, b) => a.seq - b.seq);
}

/** 原始事件流裁剪(会话事件流证据:保 type/seq/turn/step/工具名,数据 1200 字符封顶) */
function trimEvents(value) {
  return (value.events ?? []).map((entry) => {
    const e = entry.event ?? {};
    return {
      seq: e.seq, type: e.type,
      turn: e.data?.turn ?? null, step: e.data?.step ?? null,
      name: e.data?.name ?? null,
      data: JSON.stringify(e.data ?? {}).slice(0, 1200),
    };
  });
}

// ─── 落盘件(原子写:tmp + rename;崩溃窗口不留半文件) ───

async function writeFileAtomic(file, data) {
  const tmp = file + '.tmp';
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, file);
}

const safeSeg = (id) => String(id).replace(/[^\w.-]/g, '_');

async function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } // Windows 上活着但无权限也算活
}

// ─── CLI ───

const VALUE_OPTS = new Set(['--out', '--task-timeout-ms', '--total-budget-ms', '--stopfile', '--journal', '--rpc-attempts']);

function parseArgs(argv) {
  const opts = {
    suiteFile: null, out: config.resultsDir, resume: false,
    taskTimeoutMs: null, totalBudgetMs: TOTAL_BUDGET_DEFAULT_MS,
    stopfile: null, journal: JOURNAL_DEFAULT, rpcAttempts: RPC_MAX_ATTEMPTS,
    screenshot: true, list: false, probe: false, help: false, _: [],
  };
  // 同时接受 --flag=value 与 --flag value 两种形态(长夜批量的操作者两种都会敲)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resume') opts.resume = true;
    else if (a === '--no-screenshot') opts.screenshot = false;
    else if (a === '--list') opts.list = true;
    else if (a === '--probe') opts.probe = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--out=')) opts.out = a.slice(6);
    else if (VALUE_OPTS.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 需要值(--flag=value 或 --flag value)`);
      applyValueOpt(opts, a, v);
    } else {
      const eq = a.indexOf('=');
      const name = eq > 2 ? a.slice(0, eq) : null;
      if (name && VALUE_OPTS.has(name)) applyValueOpt(opts, name, a.slice(eq + 1));
      else opts._.push(a);
    }
  }
  opts.suiteFile = opts._[0] ?? null;
  return opts;
}

function applyValueOpt(opts, name, rawValue) {
  const v = String(rawValue);
  if (v === '') throw new Error(`${name} 需要非空值`);
  if (name === '--out') opts.out = v;
  else if (name === '--stopfile') opts.stopfile = v;
  else if (name === '--journal') opts.journal = v;
  else {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} 须为非负数,得 ${v}`);
    if (name === '--task-timeout-ms') opts.taskTimeoutMs = n;
    else if (name === '--total-budget-ms') opts.totalBudgetMs = n;
    else if (name === '--rpc-attempts') opts.rpcAttempts = Math.max(1, Math.floor(n));
  }
}

function usage() {
  console.log(`用法: node bench/drive-hardened.mjs <suite.json> [options]
  --out=<dir>           证据/状态根(缺省 ${config.resultsDir};布局 <out>/<suite>/<task-id>/)
  --resume              断点续跑:读 <out>/<suite>/resume-state.json,已完成任务重入跳过
  --task-timeout-ms=N   任务级超时全局覆盖(仍钳制 [5,10]min;suite 内 timeoutMs 优先)
  --total-budget-ms=N   总量熔断(缺省 ${TOTAL_BUDGET_DEFAULT_MS}ms=6h;0 禁用)
  --stopfile=<path>     停机触发文件(缺省 <out>/<suite>/STOP;出现即取消当前会话并退出)
  --journal=<path>      插件行动日志(缺省 ${JOURNAL_DEFAULT};可 DSH_BENCH_JOURNAL 覆盖)
  --rpc-attempts=N      瞬态 RPC 最大尝试次数(缺省 ${RPC_MAX_ATTEMPTS})
  --no-screenshot       E2 核查不截图
  --list                静态列任务+超时计划+续跑计划(无 RPC、无副作用)
  --probe               仅 RPC 探测(session.list 退避重试),失败登记后 exit 4
并发纪律:真实桌面任务严格串行 —— 本驱动没有并发参数(这不是缺省值,是不存在的旋钮);
  跨进程由 <out>/<suite>/.drive.lock(pid 锁)互斥,同刻至多一个驱动实例。`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.suiteFile) { usage(); process.exit(opts.help ? 0 : 2); }

  // ── 静态段(无 RPC:RPC 探测失败时这部分已完成并登记,不阻塞、不启动 DSH) ──
  const { tasks: suite } = loadSuite(applySuiteSubstitutions(JSON.parse(readFileSync(opts.suiteFile, 'utf8'))));
  for (const t of suite) {
    if (t.verify) {
      const v = validateVerifyBlock(t.verify);
      if (!v.ok) throw new Error(`任务 ${t.id} 的 verify 块非法:\n  - ${v.errors.join('\n  - ')}`);
    }
  }
  const suiteName = path.basename(opts.suiteFile).replace(/\.json$/, '');
  const suiteDir = path.join(opts.out, suiteName);
  const stopfile = opts.stopfile ?? path.join(suiteDir, 'STOP');
  const resumeFile = path.join(suiteDir, 'resume-state.json');
  const lockFile = path.join(suiteDir, '.drive.lock');

  if (opts.list) {
    let doneIds = [];
    if (opts.resume && existsSync(resumeFile)) doneIds = loadResumeState(JSON.parse(readFileSync(resumeFile, 'utf8'))).doneTaskIds;
    const plan = planRun(suite, doneIds);
    for (const t of suite) {
      const tp = timeoutPlan({ taskTimeoutMs: opts.taskTimeoutMs ?? t.timeoutMs, totalBudgetMs: opts.totalBudgetMs });
      console.log(`${t.id}\t${t.category}\ttimeout=${Math.round(tp.taskTimeoutMs / 60000)}min${t.verify ? '\tverify' : '\te2=absent'}${doneIds.includes(t.id) ? '\t[done-跳过]' : ''}`);
    }
    console.log(`-- config:  ${configSummary()}`);
    console.log(`-- 计划:    run=${plan.run.length} skip=${plan.skipped.length}${plan.staleDoneIds.length ? ` staleDone=[${plan.staleDoneIds.join(',')}]` : ''}`);
    console.log(`-- 熔断:    totalBudget=${opts.totalBudgetMs > 0 ? Math.round(opts.totalBudgetMs / 3600000) + 'h' : '禁用'};任务级超时钳制 [${TASK_TIMEOUT_MIN_MS_LABEL}](缺省 8min)`)
    return;
  }

  await mkdir(suiteDir, { recursive: true });

  // ── RPC 探测:失败 ⇒ 静态登记后退出(exit 4;启动 DSH 是 R1-1 的职责,这里不越权) ──
  const probeRetryLog = [];
  try {
    await rpcRetry('session.list', {}, { attempts: opts.rpcAttempts, retryLog: probeRetryLog });
  } catch (e) {
    await writeFileAtomic(path.join(suiteDir, 'probe-failure.json'), JSON.stringify({
      schema: 'dsh-drive-probe/1', at: new Date().toISOString(), endpoint: BASE,
      error: e.message, retries: probeRetryLog,
      staticPhase: 'completed(suite 装载/verify 校验/超时计划已完成 —— 见 --list)',
      note: '驱动不负责启动 DSH 应用(R1-1);修复端点后重跑本命令,--resume 可续',
    }, null, 1));
    console.error(`PROBE FAILED: ${e.message}(已登记 ${path.join(suiteDir, 'probe-failure.json')};DSH_BENCH_ENDPOINT=${config.endpoint})`);
    process.exit(4);
  }
  if (opts.probe) { console.log(`PROBE OK: ${config.endpoint}(${probeRetryLog.length} 次重试内)`); return; }

  // ── stopfile 启动闸:已在 ⇒ 拒跑(exit 6)。避免「删了又跑」的循环。 ──
  if (existsSync(stopfile)) {
    console.error(`STOPFILE 已存在:${stopfile} —— 操作者要求停机,拒绝开跑(确认后删除该文件再启动)`);
    process.exit(6);
  }

  // ── 断点续跑:--resume 装载已完成清单 + 认领崩溃残留的活会话(僵尸) ──
  let resumeState = { runId: null, doneTaskIds: [], liveSessions: {} };
  if (opts.resume && existsSync(resumeFile)) {
    resumeState = loadResumeState(JSON.parse(readFileSync(resumeFile, 'utf8')));
    console.log(`RESUME: 续跑 ${resumeState.runId ?? '?'},已完成 ${resumeState.doneTaskIds.length} 个,残留活会话 ${Object.keys(resumeState.liveSessions).length} 个待回收`);
  }
  const runId = resumeState.runId ?? `drive-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 4)}`;
  resumeState = { ...resumeState, runId };

  // ── 串行纪律(跨进程):pid 锁。活进程持锁 ⇒ 拒绝启动;陈锁 ⇒ 接管。 ──
  if (existsSync(lockFile)) {
    try {
      const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
      if (await pidAlive(lock.pid) && lock.pid !== process.pid) {
        console.error(`LOCK BUSY: ${suiteDir} 正被 pid=${lock.pid}(run=${lock.runId})持有 —— 同刻只允许一个驱动实例(一套鼠标键盘)`);
        process.exit(5);
      }
      console.log(`接管陈锁: pid=${lock.pid} 已不在(上个驱动崩溃/被杀)`);
    } catch { console.log('锁文件不可读,按陈锁接管'); }
  }
  await writeFileAtomic(lockFile, JSON.stringify({ pid: process.pid, runId, startedAt: new Date().toISOString() }, null, 1));

  // ── 观测面状态(单行仪表 + 汇总;每任务后/停机时落盘) ──
  const startedAtMs = Date.now();
  const startedAtIso = new Date().toISOString();
  const taskRecords = [];
  const ownSessionIds = new Set(Object.values(resumeState.liveSessions));
  const rpcLedger = []; // 全程 RPC 重试账本(汇总引用)
  let currentTask = null;
  let stoppedBy = null;
  let lastStopCheck = 0;

  const statusView = (state, extra = {}) => renderStatusLine({
    runId, suiteName,
    total: suite.length,
    done: taskRecords.filter((r) => !r.rerunOf).length,
    state, currentTask,
    elapsedMs: Date.now() - startedAtMs,
    pass: taskRecords.filter((r) => r.pass === true).length,
    fail: taskRecords.filter((r) => r.pass === false).length,
    unknown: taskRecords.filter((r) => !r.rerunOf && r.pass === undefined).length,
    skip: resumeState.doneTaskIds.length,
    failures: taskRecords.filter((r) => r.pass === false).map((r) => r.id),
    stopfileExists: existsSync(stopfile),
    ...extra,
  });

  async function flushObservability(state) {
    await writeFileAtomic(path.join(suiteDir, 'status.line'), statusView(state) + '\n');
    await writeFileAtomic(path.join(suiteDir, 'summary.json'), JSON.stringify(buildRunSummary({
      runId, suiteFile: opts.suiteFile, suiteName, model: config.modelSelector,
      startedAtIso, updatedAtIso: new Date().toISOString(), elapsedMs: Date.now() - startedAtMs,
      taskRecords, skippedIds: resumeState.doneTaskIds, liveSession: currentTask?.sessionId ?? null,
      stoppedBy, rpcSummary: { retries: rpcLedger.length, byMethod: rpcLedger.reduce((m, r) => ((m[r.method] = (m[r.method] ?? 0) + 1), m), {}) },
    }), null, 1));
  }

  async function flushResumeState() {
    await writeFileAtomic(resumeFile, JSON.stringify({ schema: 'dsh-drive-resume/1', ...resumeState }, null, 1));
  }

  const checkStop = (budgetExhausted) => {
    const now = Date.now();
    if (now - lastStopCheck < 500) return null; // 高频调用节流(existsSync 也不白刷)
    lastStopCheck = now;
    return stopDecision({ interrupted, stopfileExists: existsSync(stopfile), budgetExhausted });
  };

  // ── 僵尸回收:崩溃残留的本驱动会话(只回收自己的;NOT_OURS 一律不动) ──
  const reclaimed = [];
  for (const [taskId, sessionId] of Object.entries(resumeState.liveSessions)) {
    try {
      if (await isRunning(sessionId)) {
        console.log(`ZOMBIE: 任务 ${taskId} 的残留会话 ${sessionId} 仍在跑 —— 取消回收`);
        if (await cancelSession(sessionId, rpcLedger)) reclaimed.push({ taskId, sessionId });
      }
    } catch (e) { console.error(`ZOMBIE 回收检查失败(${taskId}/${sessionId}):${e.message}`); }
    const live = { ...resumeState.liveSessions };
    delete live[taskId]; // 已终局(回收/自然结束)—— 重入不再认领
    resumeState = { ...resumeState, liveSessions: live };
  }
  await flushResumeState();

  const plan = planRun(suite, resumeState.doneTaskIds);
  if (plan.staleDoneIds.length) console.log(`staleDone(状态文件里有、suite 里没有):${plan.staleDoneIds.join(',')} —— 如实上报不瞎猜`);
  const world = createWindowsWorld(); // E2 独立观察通道(与 DSH 会话物理隔离)

  console.log(`R1-4 hardened drive runId=${runId}\n  config:  ${configSummary()}\n  root:    ${suiteDir}\n  plan:    run=${plan.run.length} skip=${plan.skipped.length}\n  超时:    任务级=[5,10]min 钳制 总量=${opts.totalBudgetMs > 0 ? Math.round(opts.totalBudgetMs / 3600000) + 'h' : '禁用'} 轮询=${WAIT_POLL_MS}ms\n  kill:    Ctrl-C=优雅(130) stopfile=${stopfile}(3)\n  串行:    严格单会话循环 + ${lockFile}(pid 锁)`);

  let exitCode = 0;
  try {
    for (let i = 0; i < plan.run.length; i++) {
      const t = plan.run[i];
      const tp = timeoutPlan({ taskTimeoutMs: opts.taskTimeoutMs ?? t.timeoutMs, totalBudgetMs: opts.totalBudgetMs, startedAtMs, now: Date.now() });
      if (tp.budgetExhausted) {
        console.error(`CIRCUIT-BREAK: 总量预算耗尽(remaining=${tp.totalRemainingMs}ms)—— 剩余 ${plan.run.length - i} 个任务不再调度`);
        stoppedBy = 'total-budget';
        break;
      }
      const sd = checkStop(tp.budgetExhausted);
      if (sd) { stoppedBy = sd.reason; exitCode = sd.exitCode; break; }

      currentTask = { id: t.id, sessionId: null };
      await flushObservability('RUNNING');
      const taskStartMs = Date.now();
      const retryLog = []; // 本任务重试账(回执引用)
      const rec = { id: t.id, category: t.category, prompt: t.prompt.slice(0, 120), startedAt: new Date().toISOString(), runId };
      let sessionEndMs = null;
      try {
        // 1) 建会话(重试)→ 立即登记 liveSessions(崩溃窗口的僵尸线索)
        const s = await rpcRetry('session.create', {}, { attempts: opts.rpcAttempts, retryLog });
        rec.sessionId = s.sessionId;
        currentTask.sessionId = s.sessionId;
        ownSessionIds.add(s.sessionId);
        resumeState = registerLiveSession(resumeState, t.id, s.sessionId);
        await flushResumeState();
        // 2) 选模型(重试)
        await rpcRetry('session.selectModel', { sessionId: s.sessionId, ...config.modelSelector }, { attempts: opts.rpcAttempts, retryLog });
        // 3) 下发(瞬态重试 + 防重复;读不到证据 ⇒ 不重发)
        const send = await sendPromptSafe(s.sessionId, t.prompt, retryLog);
        rec.promptUncertain = !!send.uncertain;
        // 4) 等待空闲(分级超时 + 每 tick kill-switch;超时 ⇒ 取消)
        const w = await waitDoneHard(s.sessionId, {
          effectiveTimeoutMs: tp.effectiveTimeoutMs, stopfile, retryLog,
          onStopfile: () => { stoppedBy = 'stopfile'; },
        });
        sessionEndMs = Date.now();
        rec.timedOut = !w.ok;
        rec.waitedMs = w.waitedMs;
        if (!w.ok) await cancelSession(s.sessionId, retryLog);
        // 5) 后置动作序列(planPostTask 定序:证据采集 → E2 → 回执 → 状态面)
        const post = planPostTask(t);
        const taskDir = path.join(suiteDir, safeSeg(t.id));
        await mkdir(taskDir, { recursive: true });
        const rawHistory = await rpcRetry('session.history', { sessionId: s.sessionId }, { attempts: opts.rpcAttempts, retryLog });
        const rows = compactHistory(rawHistory);
        if (post.steps.includes('evidence:hist')) {
          await writeFile(path.join(taskDir, 'hist.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
        }
        if (post.steps.includes('evidence:events')) {
          await writeFile(path.join(taskDir, 'session-events.jsonl'), trimEvents(rawHistory).map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
        }
        if (post.steps.includes('evidence:journal')) {
          let jw = { kept: [], dropped: 0 };
          try {
            const jl = await readFile(opts.journal, 'utf8');
            jw = journalWindow(jl.split('\n'), { t0Ms: taskStartMs - 1500, t1Ms: (sessionEndMs ?? Date.now()) + 1500 });
          } catch (e) { jw.dropped = -1; jw.error = e.message; } // 日志缺席/不可读:如实记,不算任务失败
          await writeFile(path.join(taskDir, 'journal-lines.jsonl'), jw.kept.join('\n') + (jw.kept.length ? '\n' : ''), 'utf8');
          rec.journalLines = jw.kept.length;
          rec.journalDropped = jw.dropped;
        }
        rec.events = rows;
        rec.toolCalls = rows.filter((e) => e.kind === 'call').map((e) => e.name);
        rec.toolErrors = rows.filter((e) => e.kind === 'result' && e.isError).length;
        // 轨迹侧(expect 正则对精简历史,与 battery 同律)
        let trajPass;
        if (t.expect) {
          const hay = JSON.stringify(rows);
          trajPass = t.expect.every((re) => new RegExp(re, 'i').test(hay));
          rec.failedExpectations = t.expect.filter((re) => !new RegExp(re, 'i').test(hay));
        }
        rec.trajectoryPass = trajPass;
        // E2 独立核查(任务终局后立即执行;通道崩溃 ⇒ 诚实降级 false+channelError)
        let verifyPass;
        if (post.hasE2) {
          try {
            const v = await runVerification({ taskId: t.id, verify: t.verify, world, reportDir: taskDir, captureScreenshot: opts.screenshot });
            rec.verify = v.result;
            verifyPass = v.result.pass;
          } catch (e) {
            rec.verify = { pass: false, channelError: true, checks: [], error: e.message, channel: 'independent-local' };
            verifyPass = false;
          }
        }
        rec.pass = trajPass === false || verifyPass === false ? false
          : trajPass === true && verifyPass !== false ? true
          : verifyPass === true ? true : undefined;
        rec.retries = retryLog;
        rec.rpcRetries = retryLog.length;
        rec.timeoutPlan = { task: tp.taskTimeoutMs, effective: tp.effectiveTimeoutMs };
        await writeFileAtomic(path.join(taskDir, 'receipt.json'), JSON.stringify({
          schema: 'dsh-drive-receipt/1', runId, taskId: t.id, sessionId: s.sessionId,
          startedAt: rec.startedAt, finishedAt: new Date().toISOString(),
          pass: rec.pass, trajectoryPass: rec.trajectoryPass,
          e2: t.verify ? { present: true, result: rec.verify } : { present: false, note: '无 verify 块 —— e2=absent(仅自报轨迹)' },
          timedOut: !!rec.timedOut, waitedMs: rec.waitedMs, timeoutPlan: rec.timeoutPlan,
          promptUncertain: !!rec.promptUncertain,
          toolCalls: rec.toolCalls, toolErrors: rec.toolErrors, failedExpectations: rec.failedExpectations ?? null,
          journal: { lines: rec.journalLines ?? null, dropped: rec.journalDropped ?? null },
          retries: retryLog,
          evidence: { hist: 'hist.jsonl', events: 'session-events.jsonl', journal: 'journal-lines.jsonl', e2Dir: t.verify ? 'evidence/' : null, screenshots: t.verify ? 'screenshots/' : null },
        }, null, 1));
      } catch (e) {
        if (e instanceof GracefulStop) {
          // kill-switch:当前任务不算完成(重入续跑),尽力取消会话后落盘退出
          if (rec.sessionId) await cancelSession(rec.sessionId, retryLog).catch(() => {});
          rec.interrupted = true;
          rec.harnessError = `graceful-stop:${e.reason}`;
          stoppedBy = stoppedBy ?? e.reason;
          exitCode = e.exitCode;
          rec.finishedAt = new Date().toISOString();
          taskRecords.push(rec);
          console.error(`[kill-switch] ${e.reason} —— 任务 ${t.id} 未完成(重入 --resume 会重跑),已完成部分已落盘`);
          break;
        }
        rec.harnessError = e.message;
        if (rec.sessionId) await cancelSession(rec.sessionId, retryLog).catch(() => {});
      }
      rec.finishedAt = new Date().toISOString();
      if (!rec.interrupted) taskRecords.push(rec);
      // 收口:任务完成 ⇒ 合并续跑状态(原子);状态面立即刷新
      if (!rec.interrupted && !rec.harnessError) {
        resumeState = commitTaskDone(resumeState, t.id);
        await flushResumeState();
      } else if (rec.harnessError && rec.interrupted !== true) {
        // harnessError 的任务不记 done(重入会重跑)—— 但活会话登记要清掉(已取消)
        resumeState = registerLiveSession(resumeState, t.id, rec.sessionId ?? 'unknown');
        delete resumeState.liveSessions[t.id];
        await flushResumeState();
      }
      currentTask = null;
      await flushObservability('IDLE');
      const status = rec.pass === undefined ? (rec.harnessError ? 'ERR' : '?') : rec.pass ? 'PASS' : 'FAIL';
      const vTag = t.verify ? ` verify=${rec.verify ? (rec.verify.pass ? 'ok' : (rec.verify.channelError ? 'CHANNEL-ERR' : 'violated')) : 'n/a'}` : ' e2=absent(unverifiable)';
      console.log(`[${plan.skipped.length + taskRecords.filter((r) => !r.rerunOf).length}]${status}${rec.timedOut ? '(超时)' : ''}${vTag} ${t.category}/${t.id} tools=[${rec.toolCalls?.join(',') || '-'}] errors=${rec.toolErrors ?? '-'} retries=${rec.rpcRetries ?? 0}${rec.harnessError ? ' harness=' + rec.harnessError.slice(0, 80) : ''}`);
      // 任务间僵尸扫荡:本驱动创建、非活跃、仍在跑 ⇒ 回收(自己人只此一家)
      try {
        const v = await rpcRetry('session.list', {}, { attempts: 2, retryLog });
        const z = findZombieSessions(v.items, { ownSessionIds: [...ownSessionIds], activeSessionId: null });
        for (const zid of z.zombies) {
          console.log(`ZOMBIE: 本驱动残留会话 ${zid} 仍在跑 —— 取消回收`);
          await cancelSession(zid, rpcLedger);
        }
      } catch { /* 扫荡失败不阻塞主循环 */ }
      if (!interrupted) await sleep(1500);
    }
  } finally {
    stoppedBy = stoppedBy ?? (interrupted ? 'sigint' : 'completed');
    if (stoppedBy === 'sigint') exitCode = exitCode || 130;
    await flushObservability('STOPPED');
    await flushResumeState();
    // 锁释放:改名归档为 .drive.lock.last(留 last 供事后排查谁跑过;下次启动按陈锁接管)
    try { await rename(lockFile, lockFile + '.last'); } catch { /* 锁文件可能已被接管方移动 */ }
  }

  const summary = buildRunSummary({
    runId, suiteFile: opts.suiteFile, suiteName, model: config.modelSelector,
    startedAtIso, updatedAtIso: new Date().toISOString(), elapsedMs: Date.now() - startedAtMs,
    taskRecords, skippedIds: resumeState.doneTaskIds, liveSession: null, stoppedBy,
    rpcSummary: { retries: rpcLedger.length },
  });
  console.log('\n==== R1-4 SUMMARY ====');
  console.log(JSON.stringify(summary.totals, null, 1));
  console.log(`stoppedBy=${stoppedBy} failures=[${summary.failures.join(',') || '-'}] skip=${summary.skippedIds.length}`);
  console.log(`evidence: ${suiteDir}/  resume: ${resumeFile}`);
  process.exit(exitCode);
}

// CLI 守卫:被 import(test/bench 内其他脚本)时不执行 main(battery.mjs 同律)
const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked && import.meta.url === invoked) {
  main().catch((e) => { console.error('DRIVE ERROR:', e); process.exit(1); });
}
