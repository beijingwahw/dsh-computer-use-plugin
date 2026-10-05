#!/usr/bin/env node
// bench/drive-desktop.mjs — R1-8 桌面宿主(Electron DSH)transport 适配驱动。
//
// drive-hardened.mjs 面向旧 CLI web 宿主(3080 点号信封、无鉴权);本文件把同一套
// 驱动语义(R1-4 的 driveCore 纯决策核心:重试/超时/续跑/串行锁/僵尸回收全部不变)
// 映射到桌面宿主的真实 RPC 协议(R1-1 runbook 实测):
//
//   · 端点   http://127.0.0.1:19387(端口固定;DSH_BENCH_ENDPOINT/DSH_DESKTOP_ENDPOINT 可覆盖)
//   · 鉴权   启动日志随机 token → GET /?token=<t>(303)→ HttpOnly set-cookie(名随机)
//            → 后续 RPC 带 cookie;401 时自动重换 cookie 再试(宿主重启 token 轮转的自愈)
//   · 信封   POST /api/<ns>/<method>,body {type:'client-request',rpcId,method,payload:{args:{...}}}
//            —— 参数名按 typert.host.js 的 wire 名(_request/request),成功 result:{ok:true,value}
//   · 方法映射(桌面宿主 session-controller 实测面):
//       list        session/list       {_request:{}}
//       create      session/create     {request:{}}                       → value.sessionId
//       selectModel session/selectModel {request:{sessionId,provider,model}} (ModelSelection 平铺)
//       prompt      session/prompt     {request:{requestId,sessionId,mode:'queue',
//                                                 content:[{type:'text',text}],clientTimeZone}}
//       cancel      session/cancel     {request:{sessionId}}
//       history     session/page       {request:{address:{kind:'session',sessionId},throughSeq:<big>}}
//            —— 旧宿主的 session/history 在桌面 controller 无此方法;page 的
//               value.records:[{type:'event',event:{...}}] 适配为 {events:[...]} 同形,
//               compactHistory/promptSeenInHistory/trimEvents 零改动复用。
//
// 其余(evidence 包布局/resume-state/pid 锁/stopfile/status.line/summary.json/退出码)
// 与 drive-hardened.mjs 同形。新增记录 rec.timings(每步延迟)供 R1-8 参数标定。
//
// 用法:
//   node bench/drive-desktop.mjs <suite.json> --token=<t> [--out <dir>] [--resume]
//       [--task-timeout-ms N] [--total-budget-ms N] [--stopfile <path>] [--journal <path>]
//       [--rpc-attempts N] [--no-screenshot] [--list] [--probe]
//   token 亦可经 DSH_DESKTOP_TOKEN / DSH_BENCH_TOKEN 注入;端点 DSH_DESKTOP_ENDPOINT 优先。
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, appendFile, rename, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { config, applySuiteSubstitutions, configSummary } from './config.mjs';
import { loadSuite } from './battery.mjs';
import { createWindowsWorld, runVerification, validateVerifyBlock } from './verifyCore.mjs';
import {
  RPC_MAX_ATTEMPTS, TOTAL_BUDGET_DEFAULT_MS, TASK_TIMEOUT_MIN_MS, TASK_TIMEOUT_MAX_MS,
  WAIT_POLL_MS, POLL_ERROR_CIRCUIT,
  HOST_FOCUS_GUARD_INTERVAL_MS, parseHostMarkersCsv as parseHostMarkersCsvDriver,
  shouldRunHostFocusGuard, buildHostGuardPs, parseHostGuardLine, scanTypingPollution,
  MAX_TURNS_PER_SESSION_DEFAULT, sessionTurnCount, turnCapDecision,
  APPROVAL_SCAN_INTERVAL_MS, approvalWatchInit, approvalFold, approvalDeadlockDecision,
  eventCaptureInit, eventCaptureDelta, eventCaptureMerge,
  retryDecision, timeoutPlan, loadResumeState, planRun, commitTaskDone, registerLiveSession,
  shouldResendPrompt, promptSeenInHistory, findZombieSessions, journalWindow,
  planPostTask, stopDecision, renderStatusLine, buildRunSummary,
} from './driveCore.mjs';

const TASK_TIMEOUT_MIN_MS_LABEL = `${TASK_TIMEOUT_MIN_MS / 60000}min, ${TASK_TIMEOUT_MAX_MS / 60000}min`;

const BENCH_DIR = fileURLToPath(new URL('./', import.meta.url));
const JOURNAL_DEFAULT = process.env.DSH_BENCH_JOURNAL ?? path.join(BENCH_DIR, 'journal.jsonl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 桌面宿主端点:缺省 19387(与 config.mjs 的 CLI web 缺省 3080 解耦;
// 显式顺序:DSH_DESKTOP_ENDPOINT > DSH_BENCH_ENDPOINT > 19387)
const ENDPOINT = (process.env.DSH_DESKTOP_ENDPOINT ?? process.env.DSH_BENCH_ENDPOINT ?? 'http://127.0.0.1:19387')
  .replace(/\/+$/, '');
// 模型:桌面宿主 modelCatalog 实测 routable=zai-coding-cn:{glm-4.6v,glm-5.3,glm-5.3-flash,
// glm-5.3-highspeed};glm-5.3 是宿主缺省且确证多模态 —— 截图驱动任务用它
const MODEL_SELECTOR = {
  provider: process.env.DSH_BENCH_PROVIDER ?? 'zai-coding-cn',
  model: process.env.DSH_BENCH_MODEL ?? 'glm-5.3',
};

// ─── kill-switch(与 drive-hardened 同律:双击硬退,单击优雅) ───
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

// ─── 桌面宿主 transport:token → cookie → ns/method ───

class DesktopTransport {
  constructor({ endpoint, token }) {
    this.endpoint = endpoint;
    this.token = token;
    this.cookie = null;       // 'name=value' 原串(HttpOnly,手抓 set-cookie 头)
    this.logins = 0;          // 重换 cookie 次数(观测面引用)
  }

  /** login —— GET /?token=<t> 收 303 的 set-cookie(30 天有效;authority 绑定 Host 头,
   *  必须与后续 RPC 同 host:port —— 本类内统一用 this.endpoint 拼所有 URL,天然一致)。 */
  async login() {
    const r = await fetch(`${this.endpoint}/?token=${encodeURIComponent(this.token)}`, {
      redirect: 'manual', headers: { accept: 'text/html' },
    });
    const setCookie = r.headers.getSetCookie?.() ?? [];
    const auth = setCookie.find((c) => /^\s*dsh-auth[^=]*=/.test(c));
    if (!auth) {
      const err = new Error(`login 失败:HTTP ${r.status} 且无 dsh-auth set-cookie(token 失效/宿主重启?)`);
      err.status = r.status === 401 ? 401 : 503; // 401=token 错(致命),其余按瞬态(服务未就绪)
      throw err;
    }
    this.cookie = auth.split(';')[0];
    this.logins += 1;
    return true;
  }

  /** call —— POST /api/<ns>/<method>,桌面信封 payload:{args}。401 ⇒ 重换 cookie 一次再试。 */
  async call(method, args, { depth = 0 } = {}) {
    if (!this.cookie) await this.login();
    let r;
    try {
      r = await fetch(`${this.endpoint}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: this.cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
      });
    } catch (e) {
      e.code = e.code ?? e.cause?.code ?? null; // undici cause.code 供 classifyRpcError 认瞬态
      throw e;
    }
    if (r.status === 401 && depth < 1) { // cookie 过期/宿主重启 → 重换再试一次
      this.cookie = null;
      return this.call(method, args, { depth: depth + 1 });
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
}

// ─── 方法映射层(桌面 wire 名;history 走 session/page 并适配同形) ───

let T = null; // transport 单例(进程内严格串行;main 里构造)

const api = {
  async list() {
    const v = await T.call('session/list', { _request: {} });
    return v; // { items: SessionSummary[] }
  },
  async create() {
    const v = await T.call('session/create', { request: {} });
    return v; // { sessionId, agentPreset }
  },
  async selectModel(sessionId) {
    const v = await T.call('session/selectModel', { request: { sessionId, ...MODEL_SELECTOR } });
    return v; // { selected: {...} }
  },
  async prompt(sessionId, text) {
    const v = await T.call('session/prompt', {
      request: {
        requestId: crypto.randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: 'Asia/Shanghai',
      },
    });
    return v; // { accepted: true }
  },
  async cancel(sessionId) {
    const v = await T.call('session/cancel', { request: { sessionId } });
    return v; // { accepted: true }
  },
  async history(sessionId) {
    // 桌面 controller 无 session/history;page 的 throughSeq 必须 ≤ 会话游标
    // (1e9 会 bad-request "past cursor N")—— 游标从 session/projections 的 asOfSeq 取。
    const proj = await T.call('session/projections', { request: { sessionId } });
    const throughSeq = proj?.asOfSeq ?? 0;
    const v = await T.call('session/page', {
      request: { address: { kind: 'session', sessionId }, throughSeq },
    });
    return { events: v.records ?? [], asOfSeq: throughSeq }; // records[i] = {type:'event',event:{...}}
  },
};

// rpcRetry —— 瞬态退避重试(决策一律 driveCore.retryDecision;force=SIGINT 后仍执行)
async function rpcRetry(fn, label, { attempts = RPC_MAX_ATTEMPTS, retryLog = [], force = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    if (interrupted && !force) throw new GracefulStop('sigint', 130);
    try {
      return await fn();
    } catch (e) {
      if (e instanceof GracefulStop) throw e;
      const d = retryDecision({ attempt, error: e, maxAttempts: attempts });
      retryLog.push({ method: label, attempt, kind: d.classification.kind, reason: d.reason, action: d.action });
      if (d.action === 'abort') throw e;
      console.error(`    ↻ rpc ${label} 第${attempt}次失败(${d.reason}),${d.delayMs}ms 后重试`);
      await sleep(d.delayMs);
    }
  }
}

async function isRunning(sessionId) {
  const v = await rpcRetry(() => api.list(), 'session/list');
  const s = v.items.find((i) => i.sessionId === sessionId);
  if (!s) throw Object.assign(new Error('session not found: ' + sessionId), { rpcRejected: true });
  return !!s.running;
}

async function cancelSession(sessionId, retryLog) {
  try { await rpcRetry(() => api.cancel(sessionId), 'session/cancel', { attempts: 2, retryLog, force: true }); return true; }
  catch (e) { if (e instanceof GracefulStop) throw e; console.error(`    ! cancel ${sessionId} 失败:${e.message}`); return false; }
}

// ─── 等待空闲:在 hardened 之上加「启动观察」防早判 —— prompt 受理后 running 位翻转
//     有窗口,首 poll 若恰好落在窗口内会被误判完成。观察到 running=true 一次,或
//     (未观察到 ∧ 已过 15s ∧ 连续 3 次空闲 ∧ 历史已见 user/message)才算完成。 ───

const RUN_STARTUP_OBSERVE_MS = 15000;
const IDLE_CONFIRM_POLLS = 3;

async function waitDoneDesktop(sessionId, { effectiveTimeoutMs, stopfile, retryLog, onStopfile, focusGuardIntervalMs = HOST_FOCUS_GUARD_INTERVAL_MS, promptText = '', maxTurnsPerSession = MAX_TURNS_PER_SESSION_DEFAULT, approvalTimeoutMs = 0, eventSink = null }) {
  const t0 = Date.now();
  let consecutiveErrors = 0;
  let sawRunning = false;
  let consecutiveIdle = 0;
  let sawUserMessage = false;
  // R2-3 焦点保卫记账:checks/suppressed/errors + 最近一拍标题(receipt 观测面)
  const focusGuard = { intervalMs: focusGuardIntervalMs, markers: HOST_MARKERS, checks: 0, suppressed: 0, errors: 0, lastTitle: null };
  // R3-1 打字防串窗:同拍增量扫 type_text 污染(与焦点保卫共用节拍与开关)
  focusGuard.typingScans = 0; focusGuard.typingErrors = 0;
  let pollution = null;
  // R3-3(GAP-4 会话轮数护栏)记账:limit/turns/exceeded/checks/errors(receipt 观测面;
  // 判定纯函数在 driveCore.turnCapDecision,--max-turns-per-session 0=关)
  const capOn = Number.isFinite(maxTurnsPerSession) && maxTurnsPerSession > 0;
  const turnCap = { limit: capOn ? Math.floor(maxTurnsPerSession) : 0, turns: null, exceeded: false, checks: 0, errors: 0 };
  // R5-1(无人值守审批止损)记账:--approval-timeout-ms 0=关;纯函数在
  // driveCore.approvalFold/approvalDeadlockDecision。pending 自最早未解请求起算
  // (连环请求不续命);grant_approval 应答或操作员消息解封。
  const approvalOn = Number.isFinite(approvalTimeoutMs) && approvalTimeoutMs > 0;
  const approvalGuard = { timeoutMs: approvalOn ? Math.floor(approvalTimeoutMs) : 0, scanIntervalMs: APPROVAL_SCAN_INTERVAL_MS, checks: 0, errors: 0, requests: 0, responses: 0, pendingSinceIso: null, cancelled: false };
  let approvalState = approvalWatchInit();
  let lastApprovalScanMs = null;
  let lastGuardMs = null;
  let lastScanSeq = 0;
  // R6-1(事件窗口截断):每 tick 增量捕获事件流交 eventSink 持久化 —— 宿主
  // session/page 只保留最近 ~250 事件,收口一次性导出对长任务必然截断早期轨迹
  // (R5-1 §5 条件②);等待环逐 tick 捕获,收口与终局快照合并(main 侧
  // eventCaptureMerge)。拉取失败不阻塞等待环(记 errors,缺口由终局快照部分兜底,
  // gaps 如实上账)。
  let capture = eventSink ? eventCaptureInit() : null;
  const eventCapture = { ticks: 0, captured: 0, gaps: [], errors: 0 };
  while (Date.now() - t0 < effectiveTimeoutMs) {
    if (interrupted) throw new GracefulStop('sigint', 130);
    if (existsSync(stopfile)) { onStopfile?.(); throw new GracefulStop('stopfile', 3); }
    // R6-1:增量捕获(先于其余观测 —— 它们各自的拉取也顺手折叠,不浪费这一拍)
    if (capture) {
      eventCapture.ticks += 1;
      try {
        const h = await rpcRetry(() => api.history(sessionId), 'session/page(capture)', { attempts: 2, retryLog });
        const d = eventCaptureDelta(capture, h.events ?? []);
        capture = d.state;
        eventCapture.captured = capture.captured;
        eventCapture.gaps = capture.gaps;
        if (d.records.length > 0) await eventSink(d.records);
      } catch (e) {
        if (e instanceof GracefulStop) throw e; // kill-switch/stopfile 不被观测面吞掉
        eventCapture.errors += 1;
      }
    }
    let running = null;
    try { running = await isRunning(sessionId); consecutiveErrors = 0; }
    catch (e) {
      if (e instanceof GracefulStop) throw e;
      consecutiveErrors += 1;
      retryLog.push({ method: 'session/list(poll)', attempt: consecutiveErrors, kind: 'transient', reason: e.message.slice(0, 80), action: consecutiveErrors >= POLL_ERROR_CIRCUIT ? 'abort' : 'tolerated' });
      if (consecutiveErrors >= POLL_ERROR_CIRCUIT) throw new Error(`等待熔断:连续 ${POLL_ERROR_CIRCUIT} 次轮询失败(${e.message})`);
    }
    if (running === true) { sawRunning = true; consecutiveIdle = 0; }
    else if (running === false) {
      consecutiveIdle += 1;
      if (sawRunning) return { ok: true, waitedMs: Date.now() - t0, sawRunning, sawUserMessage, focusGuard, pollution, turnCap, approvalGuard, eventCapture };
      // 未见过 running:补一证 —— 历史里是否已见 user/message(prompt 已被消费)
      if (!sawUserMessage && Date.now() - t0 > RUN_STARTUP_OBSERVE_MS) {
        try {
          const h = await rpcRetry(() => api.history(sessionId), 'session/page', { attempts: 2, retryLog });
          sawUserMessage = (h.events ?? []).some((e) => e?.event?.type === 'user/message');
        } catch { /* 取证失败不阻塞:由连续空闲计数兜底 */ }
      }
      if (consecutiveIdle >= IDLE_CONFIRM_POLLS && (sawUserMessage || Date.now() - t0 > RUN_STARTUP_OBSERVE_MS * 2)) {
        return { ok: true, waitedMs: Date.now() - t0, sawRunning, sawUserMessage, focusGuard, pollution, turnCap, approvalGuard, eventCapture };
      }
    }
    // R3-3(GAP-4 会话轮数护栏):running 中每 tick 从事件流取当前轮号,达上限即
    // cancel 止损 —— 宿主(dsh-llm)无会话级轮/token 预算,这是防旁路循环烧宿主
    // token 的驱动器侧唯一闸(R2-8 §3)。事件流拉取失败 ⇒ 无证据不拦(护栏是旁路
    // 义务,绝不炸等待环);idle 态不查(轮号只在 running 中前进)。
    if (running === true && capOn) {
      try {
        const h = await rpcRetry(() => api.history(sessionId), 'session/page(turn-cap)', { attempts: 2, retryLog });
        const d = turnCapDecision({ maxTurnsPerSession: turnCap.limit, turnCount: sessionTurnCount(h.events) });
        turnCap.checks += 1;
        turnCap.turns = d.turnCount;
        if (d.exceeded) {
          turnCap.exceeded = true;
          console.error(`    [turn-cap] 会话轮号 ${d.turnCount} ≥ ${turnCap.limit} —— cancel 止损(防宿主规划脑旁路循环烧 token)`);
          await cancelSession(sessionId, retryLog);
          return { ok: false, turnCapExceeded: true, waitedMs: Date.now() - t0, sawRunning, sawUserMessage, focusGuard, pollution, turnCap, approvalGuard, eventCapture };
        }
      } catch (e) {
        if (e instanceof GracefulStop) throw e; // kill-switch/stopfile 不被护栏吞掉
        turnCap.errors += 1;
      }
    }
    // R2-3:焦点保卫到点一拍(防抖见 driveCore.shouldRunHostFocusGuard;0=关)。
    // 放在 poll 之后、sleep 之前 —— 宿主回合结束自抬的收敛窗口主要在等待期。
    if (shouldRunHostFocusGuard({ nowMs: Date.now(), lastGuardMs, intervalMs: focusGuardIntervalMs })) {
      lastGuardMs = Date.now();
      const g = await hostFocusGuardTick();
      focusGuard.checks += 1;
      if (!g.ok) focusGuard.errors += 1;
      else if (g.action === 'suppressed') {
        focusGuard.suppressed += 1;
        console.error(`    [focus-guard] 宿主窗抢焦已压回(title="${g.title ?? '?'}" 第${focusGuard.suppressed}次)`);
      }
      if (g.title) focusGuard.lastTitle = g.title;
      // R3-1(打字防串窗):同拍拉历史增量,扫 type_text 回执的宿主输入框特征
      // 与「非驱动下发」的 user/message(自我注入)。检出 ⇒ cancel 会话 —— 污染
      // 后的轨迹/自报不可信,后续回合只会烧钱不会出真证据。失败不阻塞(记数)。
      try {
        const h = await rpcRetry(() => api.history(sessionId), 'session/page', { attempts: 2, retryLog });
        const rows = compactHistory(h).filter((r) => Number.isFinite(r?.seq) && r.seq > lastScanSeq);
        if (rows.length > 0) lastScanSeq = Math.max(...rows.map((r) => r.seq));
        const scan = scanTypingPollution(rows, { promptNeedle: promptText });
        focusGuard.typingScans += 1;
        if (scan.polluted) {
          pollution = { at: new Date().toISOString(), findings: scan.findings };
          focusGuard.pollution = pollution;
          console.error(`    [typing-guard] 打字污染检出(${scan.findings.map((f) => f.kind).join(',')})—— 取消会话止损`);
          await cancelSession(sessionId, retryLog);
          return { ok: false, waitedMs: Date.now() - t0, sawRunning, sawUserMessage, focusGuard, pollution, turnCap, approvalGuard, eventCapture };
        }
      } catch (e) {
        if (e instanceof GracefulStop) throw e; // kill-switch/stopfile 不被观测面吞掉
        focusGuard.typingErrors += 1;
      }
    }
    // R5-1(无人值守审批止损):审批看护自有节拍(独立于焦点保卫 —— 后者 0=关时
    // 审批看护仍须在环)。增量游标 lastScanSeq 与 typing 扫描共用(同事件流,
    // 先跑的一方推进游标,不重复消费)。超时 ⇒ cancel 止损:无人值守考核没有
    // 应答者,闸门前绕行烧的真机预算全部是损耗(R4-1 T8 双败主成本源)。
    if (approvalOn && (lastApprovalScanMs === null || Date.now() - lastApprovalScanMs >= APPROVAL_SCAN_INTERVAL_MS)) {
      lastApprovalScanMs = Date.now();
      try {
        const h = await rpcRetry(() => api.history(sessionId), 'session/page', { attempts: 2, retryLog });
        const rows = compactHistory(h).filter((r) => Number.isFinite(r?.seq) && r.seq > lastScanSeq);
        if (rows.length > 0) lastScanSeq = Math.max(...rows.map((r) => r.seq));
        approvalState = approvalFold(approvalState, rows, { promptNeedle: promptText, nowMs: lastApprovalScanMs });
        approvalGuard.checks += 1;
        approvalGuard.requests = approvalState.requests;
        approvalGuard.responses = approvalState.responses;
        approvalGuard.pendingSinceIso = approvalState.pendingSinceMs !== null ? new Date(approvalState.pendingSinceMs).toISOString() : null;
        const d = approvalDeadlockDecision({ timeoutMs: approvalTimeoutMs, pendingSinceMs: approvalState.pendingSinceMs, nowMs: Date.now() });
        if (d.exceeded) {
          approvalGuard.cancelled = true;
          console.error(`    [approval-guard] 审批请求已 ${Math.round(d.pendingMs / 1000)}s 无人应答(≥${Math.round(approvalTimeoutMs / 1000)}s)—— cancel 止损(无人值守快速失败,req=${approvalState.requests}/resp=${approvalState.responses})`);
          await cancelSession(sessionId, retryLog);
          return { ok: false, approvalDeadlock: true, waitedMs: Date.now() - t0, sawRunning, sawUserMessage, focusGuard, pollution, turnCap, approvalGuard, eventCapture };
        }
      } catch (e) {
        if (e instanceof GracefulStop) throw e; // kill-switch/stopfile 不被观测面吞掉
        approvalGuard.errors += 1;
      }
    }
    await sleep(WAIT_POLL_MS);
  }
  return { ok: false, waitedMs: Date.now() - t0, sawRunning, sawUserMessage, focusGuard, pollution, turnCap, approvalGuard, eventCapture };
}

// ─── prompt 安全下发(三证律;历史走 session/page) ───

async function sendPromptSafe(sessionId, text, retryLog) {
  for (let attempt = 1; ; attempt++) {
    if (interrupted) throw new GracefulStop('sigint', 130);
    try {
      return { sent: true, ...(await rpcRetry(() => api.prompt(sessionId, text), 'session/prompt', { retryLog })) };
    } catch (e) {
      if (e instanceof GracefulStop) throw e;
      const d = retryDecision({ attempt, error: e });
      if (d.action === 'abort') throw e;
      let history = null, historyAvailable = false;
      try { history = await rpcRetry(() => api.history(sessionId), 'session/page', { attempts: 2, retryLog }); historyAvailable = true; }
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

const runExecFile = promisify(execFile);

/**
 * minimizeAllWindows —— 任务前屏幕卫生(R1-8 冒烟教训:桌面宿主自己的 UI 窗口
 * (亮色居中面板)会命中插件 popupDetector 的几何启发式「bright uniform center
 * panel」,把一切 GUI 工具顶成 ACTION_REQUIRED。最小化全部窗口给 agent 一张
 * 干净桌面 —— 与 recover-scene.ps1 的焦点回收同手段(Shell COM MinimizeAll,
 * 不触插件热键黑名单)。失败不阻塞(记录后继续 —— 也许桌面本来就干净)。
 */
async function minimizeAllWindows() {
  const ps = `(New-Object -ComObject Shell.Application).MinimizeAll()`;
  const { stdout, stderr } = await runExecFile('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 15000 });
  return { ok: !stderr, stderr: stderr.slice(0, 200) };
}

// ─── R2-3(焦点保卫):等待环内的宿主前台探测 + 只压宿主窗 ───
// 与任务前双 MinimizeAll 互补:那是「开跑前给干净桌面」,这是「跑动中保焦点」。
// 宿主标记(env DSH_HOST_WINDOW_MARKERS 覆盖,CSV);决策/脚本构造在 driveCore(纯)。

const HOST_MARKERS = parseHostMarkersCsvDriver(process.env.DSH_HOST_WINDOW_MARKERS);

/** 单拍:读前台 → 命中宿主标记 ⇒ ShowWindowAsync(SW_MINIMIZE) 只压宿主窗
 *  (不碰目标应用窗 —— MinimizeAll 会把 agent 正在操作的现场一并收起)。
 *  走 -EncodedCommand(UTF-16LE base64):脚本内嵌 P/Invoke 双引号,经
 *  -Command 的命令行解析会被拆坏(环境整形器 W6R-A8 同病灶同修法 ——
 *  编码载荷在命令行上不存在任何 PS 语法解析点)。失败不阻塞等待环
 *  (记 error 后继续 —— 下一拍到点重试)。 */
async function hostFocusGuardTick() {
  try {
    const encoded = Buffer.from(buildHostGuardPs(HOST_MARKERS), 'utf16le').toString('base64');
    const { stdout } = await runExecFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 15000 });
    const parsed = parseHostGuardLine(stdout);
    return { ok: true, ...parsed };
  } catch (e) {
    return { ok: false, action: 'error', title: null, err: String(e.message ?? e).slice(0, 160) };
  }
}

// ─── 历史精简/裁剪(桌面 records[].event;result 双形状) ───

// export 供 test/r61.eventCapture.test.ts 方言兼容回归（合并产物必须被本函数零改动消费）
export function compactHistory(value) {
  const out = [];
  const assistants = [];
  for (const entry of value.events ?? []) {
    const e = entry.event ?? entry; // page 帧 {type:'event',event:{...}};容错直接事件
    if (!e || !e.type) continue;
    if (e.type === 'tool/call') {
      out.push({ kind: 'call', seq: e.seq, name: e.data.name, args: e.data.arguments, turn: e.data.turn, step: e.data.step });
    } else if (e.type === 'tool/result') {
      // 双形状:桌面宿主 message.content=[{type:'text',text}](文本直挂 part);
      // 旧 CLI 宿主 content[0].content=[{text}](双层嵌套)。先直取再回退,两代历史同读。
      const parts = e.data.message?.content ?? [];
      const direct = parts.map((p) => p?.text ?? '').filter((s) => s !== '').join('\n');
      const nested = parts[0]?.content?.map((p) => p?.text ?? '').join('\n') ?? '';
      const text = direct || nested;
      const c = parts[0];
      out.push({
        kind: 'result', seq: e.seq, callId: e.data.message?.toolCallId ?? c?.toolCallId, isError: !!e.data.message?.isError,
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

function trimEvents(value) {
  return (value.events ?? []).map((entry) => {
    const e = entry.event ?? entry ?? {};
    return {
      seq: e.seq, type: e.type,
      turn: e.data?.turn ?? null, step: e.data?.step ?? null,
      name: e.data?.name ?? null,
      data: JSON.stringify(e.data ?? {}).slice(0, 1200),
    };
  });
}

// ─── 落盘件(原子写) ───

async function writeFileAtomic(file, data) {
  const tmp = file + '.tmp';
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, file);
}

const safeSeg = (id) => String(id).replace(/[^\w.-]/g, '_');

async function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ─── CLI ───

const VALUE_OPTS = new Set(['--out', '--task-timeout-ms', '--total-budget-ms', '--stopfile', '--journal', '--rpc-attempts', '--token', '--endpoint', '--focus-guard-interval-ms', '--max-turns-per-session', '--approval-timeout-ms']);

function parseArgs(argv) {
  const opts = {
    suiteFile: null, out: config.resultsDir, resume: false, token: null, endpoint: null,
    taskTimeoutMs: null, totalBudgetMs: TOTAL_BUDGET_DEFAULT_MS,
    stopfile: null, journal: JOURNAL_DEFAULT, rpcAttempts: RPC_MAX_ATTEMPTS,
    screenshot: true, minimizeAll: true, focusGuardIntervalMs: HOST_FOCUS_GUARD_INTERVAL_MS,
    maxTurnsPerSession: MAX_TURNS_PER_SESSION_DEFAULT, // R3-3(GAP-4):会话轮数护栏缺省 60;0=关
    approvalTimeoutMs: 0, // R5-1:无人值守审批止损缺省关;无人值守批显式 60000 起
    list: false, probe: false, help: false, _: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resume') opts.resume = true;
    else if (a === '--no-screenshot') opts.screenshot = false;
    else if (a === '--no-minimize-all') opts.minimizeAll = false;
    else if (a === '--list') opts.list = true;
    else if (a === '--probe') opts.probe = true;
    else if (a === '--help' || a === '-h') opts.help = true;
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
  else if (name === '--token') opts.token = v;
  else if (name === '--endpoint') opts.endpoint = v;
  else {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} 须为非负数,得 ${v}`);
    if (name === '--task-timeout-ms') opts.taskTimeoutMs = n;
    else if (name === '--focus-guard-interval-ms') opts.focusGuardIntervalMs = Math.floor(n); // R2-3:0=关
    else if (name === '--max-turns-per-session') opts.maxTurnsPerSession = Math.floor(n); // R3-3(GAP-4):0=关
    else if (name === '--approval-timeout-ms') opts.approvalTimeoutMs = Math.floor(n); // R5-1:0=关
    else if (name === '--total-budget-ms') opts.totalBudgetMs = n;
    else if (name === '--rpc-attempts') opts.rpcAttempts = Math.max(1, Math.floor(n));
  }
}

function usage() {
  console.log(`用法: node bench/drive-desktop.mjs <suite.json> --token=<t> [options]
  --token=<t>           桌面宿主启动日志里的随机 token(或 env DSH_DESKTOP_TOKEN/DSH_BENCH_TOKEN)
  --endpoint=<url>      缺省 ${ENDPOINT}(或 env DSH_DESKTOP_ENDPOINT;注意不是 CLI web 的 3080)
  --out=<dir>           证据/状态根(缺省 ${config.resultsDir};布局 <out>/<suite>/<task-id>/)
  --resume              断点续跑:读 <out>/<suite>/resume-state.json,已完成任务重入跳过
  --task-timeout-ms=N   任务级超时全局覆盖(仍钳制 [5,10]min;suite 内 timeoutMs 优先)
  --total-budget-ms=N   总量熔断(缺省 ${TOTAL_BUDGET_DEFAULT_MS}ms=6h;0 禁用)
  --stopfile=<path>     停机触发文件(缺省 <out>/<suite>/STOP;出现即取消当前会话并退出)
  --journal=<path>      插件行动日志(缺省 ${JOURNAL_DEFAULT};可 DSH_BENCH_JOURNAL 覆盖)
  --rpc-attempts=N      瞬态 RPC 最大尝试次数(缺省 ${RPC_MAX_ATTEMPTS})
  --no-screenshot       E2 核查不截图
  --no-minimize-all     关闭任务前「最小化全部窗口」屏幕卫生(缺省开 —— DSH 宿主自身
                        UI 的亮色面板会误触插件弹窗启发式,详见文件头注释)
  --focus-guard-interval-ms=N
                        R2-3 焦点保卫:等待环内每 N ms 探测前台窗,命中宿主标记
                        (缺省 DeepSeek Harness;env DSH_HOST_WINDOW_MARKERS 覆盖,CSV)
                        只压宿主窗(不碰目标应用窗)。缺省 ${HOST_FOCUS_GUARD_INTERVAL_MS};0=关
                        R3-1 打字防串窗共用此拍:type_text 回执命中宿主输入框特征
                        或出现非驱动下发的 user/message ⇒ 标记污染并 cancel 会话
  --max-turns-per-session=N
                        R3-3(GAP-4) 会话轮数护栏:等待环每 tick 从事件流取当前轮号
                        (e.data.turn),≥N 即 cancel + 回执记 stoppedBy:'turn-cap' ——
                        防 R1-8 attempt8 型旁路循环烧宿主规划脑 token(宿主自身无
                        会话级轮/预算闸)。缺省 ${MAX_TURNS_PER_SESSION_DEFAULT};0=关
  --approval-timeout-ms=N
                        R5-1 无人值守审批止损:等待环内每 ~9s 增量扫事件流,出现
                        ACTION_REQUIRED/PENDING_USER_CONSENT 且 N ms 内无应答
                        (grant_approval 结果或操作员消息)⇒ cancel 会话快速止损 +
                        回执记 approvalGuard.cancelled —— 无人值守考核没有应答者,
                        闸门前绕行烧的真机预算全部是损耗(AGON 批2 T8 双败教训)。
                        有人值守批保持 0(缺省,关)。
  --list                静态列任务+超时计划+续跑计划(无 RPC、无副作用)
  --probe               仅 RPC 探测(session.list 退避重试),失败登记后 exit 4
协议:POST /api/<ns>/<method>,payload:{args:{...}};鉴权 token→cookie(401 自愈重换);
  模型 ${MODEL_SELECTOR.provider}/${MODEL_SELECTOR.model}(DSH_BENCH_PROVIDER/MODEL 覆盖)。
并发纪律:真实桌面任务严格串行 —— 跨进程 <out>/<suite>/.drive.lock(pid 锁)互斥。`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.suiteFile) { usage(); process.exit(opts.help ? 0 : 2); }

  // ── 静态段(无 RPC) ──
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
    console.log(`-- desktop: endpoint=${ENDPOINT} model=${MODEL_SELECTOR.provider}/${MODEL_SELECTOR.model}`);
    console.log(`-- 计划:    run=${plan.run.length} skip=${plan.skipped.length}${plan.staleDoneIds.length ? ` staleDone=[${plan.staleDoneIds.join(',')}]` : ''}`);
    return;
  }

  await mkdir(suiteDir, { recursive: true });

  // ── token 解析与 transport 构造 ──
  const token = opts.token ?? process.env.DSH_DESKTOP_TOKEN ?? process.env.DSH_BENCH_TOKEN ?? null;
  if (!token && !opts.probe) { console.error('缺少 --token(或 env DSH_DESKTOP_TOKEN)—— 桌面宿主每次启动随机,取启动日志 dsh-web 行'); process.exit(2); }
  T = new DesktopTransport({ endpoint: opts.endpoint ?? ENDPOINT, token: token ?? '' });

  // ── RPC 探测(session.list + 一次真实信封) ──
  const probeRetryLog = [];
  try {
    await rpcRetry(() => api.list(), 'session/list', { attempts: opts.rpcAttempts, retryLog: probeRetryLog });
  } catch (e) {
    await writeFileAtomic(path.join(suiteDir, 'probe-failure.json'), JSON.stringify({
      schema: 'dsh-drive-desktop-probe/1', at: new Date().toISOString(), endpoint: T.endpoint,
      error: e.message, retries: probeRetryLog,
      staticPhase: 'completed(suite 装载/verify 校验/超时计划已完成 —— 见 --list)',
      note: '检查:宿主是否在跑 / token 是否来自本次启动日志 / 端点是否 19387',
    }, null, 1));
    console.error(`PROBE FAILED: ${e.message}(已登记 ${path.join(suiteDir, 'probe-failure.json')};endpoint=${T.endpoint})`);
    process.exit(4);
  }
  if (opts.probe) { console.log(`PROBE OK: ${T.endpoint}(logins=${T.logins},${probeRetryLog.length} 次重试内)`); return; }

  // ── stopfile 启动闸 ──
  if (existsSync(stopfile)) {
    console.error(`STOPFILE 已存在:${stopfile} —— 操作者要求停机,拒绝开跑(确认后删除该文件再启动)`);
    process.exit(6);
  }

  // ── 断点续跑 ──
  let resumeState = { runId: null, doneTaskIds: [], liveSessions: {} };
  if (opts.resume && existsSync(resumeFile)) {
    resumeState = loadResumeState(JSON.parse(readFileSync(resumeFile, 'utf8')));
    console.log(`RESUME: 续跑 ${resumeState.runId ?? '?'},已完成 ${resumeState.doneTaskIds.length} 个,残留活会话 ${Object.keys(resumeState.liveSessions).length} 个待回收`);
  }
  const runId = resumeState.runId ?? `drive-desktop-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 4)}`;
  resumeState = { ...resumeState, runId };

  // ── 串行纪律:pid 锁 ──
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

  // ── 观测面 ──
  const startedAtMs = Date.now();
  const startedAtIso = new Date().toISOString();
  const taskRecords = [];
  const ownSessionIds = new Set(Object.values(resumeState.liveSessions));
  const rpcLedger = [];
  let currentTask = null;
  let stoppedBy = null;
  let lastStopCheck = 0;

  const statusView = (state, extra = {}) => renderStatusLine({
    runId, suiteName,
    total: suite.length,
    done: taskRecords.filter((r) => !r.rerunOf).length,
    state, currentTask: currentTask?.id ?? null,
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
      runId, suiteFile: opts.suiteFile, suiteName, model: MODEL_SELECTOR,
      startedAtIso, updatedAtIso: new Date().toISOString(), elapsedMs: Date.now() - startedAtMs,
      taskRecords, skippedIds: resumeState.doneTaskIds, liveSession: currentTask?.sessionId ?? null,
      stoppedBy, rpcSummary: { retries: rpcLedger.length, logins: T.logins },
    }), null, 1));
  }

  async function flushResumeState() {
    await writeFileAtomic(resumeFile, JSON.stringify({ schema: 'dsh-drive-resume/1', ...resumeState }, null, 1));
  }

  const checkStop = (budgetExhausted) => {
    const now = Date.now();
    if (now - lastStopCheck < 500) return null;
    lastStopCheck = now;
    return stopDecision({ interrupted, stopfileExists: existsSync(stopfile), budgetExhausted });
  };

  // ── 僵尸回收(只回收自己的) ──
  for (const [taskId, sessionId] of Object.entries(resumeState.liveSessions)) {
    try {
      if (await isRunning(sessionId)) {
        console.log(`ZOMBIE: 任务 ${taskId} 的残留会话 ${sessionId} 仍在跑 —— 取消回收`);
        if (await cancelSession(sessionId, rpcLedger)) { /* reclaimed */ }
      }
    } catch (e) { console.error(`ZOMBIE 回收检查失败(${taskId}/${sessionId}):${e.message}`); }
    const live = { ...resumeState.liveSessions };
    delete live[taskId];
    resumeState = { ...resumeState, liveSessions: live };
  }
  await flushResumeState();

  const plan = planRun(suite, resumeState.doneTaskIds);
  if (plan.staleDoneIds.length) console.log(`staleDone(状态文件里有、suite 里没有):${plan.staleDoneIds.join(',')} —— 如实上报不瞎猜`);
  const world = createWindowsWorld();

  console.log(`R1-8 desktop drive runId=${runId}\n  desktop: endpoint=${T.endpoint} model=${MODEL_SELECTOR.provider}/${MODEL_SELECTOR.model}\n  config:  ${configSummary()}\n  root:    ${suiteDir}\n  plan:    run=${plan.run.length} skip=${plan.skipped.length}\n  超时:    任务级=[${TASK_TIMEOUT_MIN_MS_LABEL}] 钳制 总量=${opts.totalBudgetMs > 0 ? Math.round(opts.totalBudgetMs / 3600000) + 'h' : '禁用'} 轮询=${WAIT_POLL_MS}ms\n  轮数:    max-turns-per-session=${opts.maxTurnsPerSession > 0 ? opts.maxTurnsPerSession : '关'}(R3-3 会话轮数护栏)
  审批:    approval-timeout-ms=${opts.approvalTimeoutMs > 0 ? opts.approvalTimeoutMs : '关'}(R5-1 无人值守审批止损)\n  kill:    Ctrl-C=优雅(130) stopfile=${stopfile}(3)\n  串行:    严格单会话循环 + ${lockFile}(pid 锁)`);

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
      // R6-1:taskDir 提前建(等待环的增量事件文件落此;重跑同任务先清零旧增量 ——
      // 旧会话的事件不混入本次证据)
      const taskDir = path.join(suiteDir, safeSeg(t.id));
      await mkdir(taskDir, { recursive: true });
      const incFile = path.join(taskDir, 'session-events-inc.jsonl');
      await writeFile(incFile, '', 'utf8');
      const retryLog = [];
      const rec = { id: t.id, category: t.category, prompt: t.prompt.slice(0, 120), startedAt: new Date().toISOString(), runId };
      const timings = {};
      let sessionEndMs = null;
      const time = async (label, fn) => {
        const s = Date.now();
        const v = await fn();
        timings[label] = Date.now() - s;
        return v;
      };
      try {
        // 0) 屏幕卫生:最小化全部窗口(缺省开)—— 宿主自身 UI 亮面板会误触弹窗启发式
        if (opts.minimizeAll) {
          const s = await time('minimizeMs', () => minimizeAllWindows());
          if (!s.ok) console.error(`    ! MinimizeAll 告警:${s.stderr}`);
        }
        // 1) 建会话(桌面:args.request 信封)→ 登记 liveSessions
        const s = await time('createMs', () => rpcRetry(() => api.create(), 'session/create', { attempts: opts.rpcAttempts, retryLog }));
        rec.sessionId = s.sessionId;
        currentTask.sessionId = s.sessionId;
        ownSessionIds.add(s.sessionId);
        resumeState = registerLiveSession(resumeState, t.id, s.sessionId);
        await flushResumeState();
        // 2) 选模型(桌面:ModelSelection 平铺)
        await time('selectModelMs', () => rpcRetry(() => api.selectModel(s.sessionId), 'session/selectModel', { attempts: opts.rpcAttempts, retryLog }));
        // 2.5) 二次屏幕卫生:建会话/选模型期间宿主 UI 可能自抬窗口(实测会),
        //      发 prompt 前再最小化一次,保证首帧截图落在一干净桌面上
        if (opts.minimizeAll) await time('minimize2Ms', () => minimizeAllWindows());
        // 3) 下发(三证律防重复)
        const send = await time('promptMs', () => sendPromptSafe(s.sessionId, t.prompt, retryLog));
        rec.promptUncertain = !!send.uncertain;
        // 4) 等待空闲(启动观察 + 分级超时;R2-3 焦点保卫在环内到点一拍;
        //    R3-1 打字防串窗同拍扫污染,检出即 cancel 止损;
        //    R3-3 会话轮数护栏每 tick 查轮号,超限即 cancel + stoppedBy:'turn-cap';
        //    R6-1 每 tick 增量捕获事件流 → session-events-inc.jsonl(截断修复))
        const w = await time('waitMs', () => waitDoneDesktop(s.sessionId, {
          effectiveTimeoutMs: tp.effectiveTimeoutMs, stopfile, retryLog,
          focusGuardIntervalMs: opts.focusGuardIntervalMs,
          promptText: t.prompt,
          maxTurnsPerSession: opts.maxTurnsPerSession,
          approvalTimeoutMs: opts.approvalTimeoutMs, // R5-1:无人值守审批止损
          eventSink: async (records) => { // R6-1:增量持久化(等待环内每拍新事件)
            await appendFile(incFile, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
          },
          onStopfile: () => { stoppedBy = 'stopfile'; },
        }));
        sessionEndMs = Date.now();
        rec.timedOut = !w.ok && !w.turnCapExceeded && !w.approvalDeadlock; // R3-3/R5-1:护栏/止损止损不是超时,分开口径
        rec.turnCapExceeded = !!w.turnCapExceeded;
        rec.approvalDeadlock = !!w.approvalDeadlock; // R5-1:审批死锁止损(回执诚实字段)
        rec.waitedMs = w.waitedMs;
        rec.sawRunning = w.sawRunning;
        rec.focusGuard = w.focusGuard; // R2-3:checks/suppressed/errors/lastTitle 观测面
        rec.pollution = w.pollution ?? null; // R3-1:等待环检出的打字污染
        rec.turnCap = w.turnCap ?? null; // R3-3:limit/turns/exceeded/checks/errors 观测面
        rec.approvalGuard = w.approvalGuard ?? null; // R5-1:timeoutMs/checks/requests/responses/cancelled 观测面
        rec.eventCapture = w.eventCapture ?? null; // R6-1:ticks/captured/gaps/errors 观测面
        if (!w.ok && !w.pollution && !w.turnCapExceeded && !w.approvalDeadlock) await cancelSession(s.sessionId, retryLog);
        // 5) 后置动作序列
        const post = planPostTask(t);
        const rawHistory = await time('historyMs', () => rpcRetry(() => api.history(s.sessionId), 'session/page', { attempts: opts.rpcAttempts, retryLog }));
        // R6-1(事件窗口截断修复):等待环增量与终局快照按 seq 去重合并(终局为准)——
        // 长任务的早期轨迹不再被宿主 ~250 事件窗口截断;gaps(两拍间风暴超容量的
        // 空洞)在 rec.eventCapture 如实上账。
        const incRecords = [];
        try {
          const inc = await readFile(incFile, 'utf8');
          for (const line of inc.split('\n')) {
            const txt = line.trim();
            if (!txt) continue;
            try { incRecords.push(JSON.parse(txt)); } catch { /* 坏行跳过(计 noSeq 口径外) */ }
          }
        } catch { /* 增量文件缺席=无增量(等待环零捕获) */ }
        const merged = eventCaptureMerge(incRecords, rawHistory.events ?? []);
        const mergedHistory = { events: merged.records, asOfSeq: rawHistory.asOfSeq };
        rec.eventCapture = { ...(rec.eventCapture ?? {}), merge: merged.stats };
        const rows = compactHistory(mergedHistory);
        if (post.steps.includes('evidence:hist')) {
          await writeFile(path.join(taskDir, 'hist.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
        }
        if (post.steps.includes('evidence:events')) {
          await writeFile(path.join(taskDir, 'session-events.jsonl'), trimEvents(mergedHistory).map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
        }
        if (post.steps.includes('evidence:journal')) {
          let jw = { kept: [], dropped: 0 };
          try {
            const jl = await readFile(opts.journal, 'utf8');
            jw = journalWindow(jl.split('\n'), { t0Ms: taskStartMs - 1500, t1Ms: (sessionEndMs ?? Date.now()) + 1500 });
          } catch (e) { jw.dropped = -1; jw.error = e.message; }
          await writeFile(path.join(taskDir, 'journal-lines.jsonl'), jw.kept.join('\n') + (jw.kept.length ? '\n' : ''), 'utf8');
          rec.journalLines = jw.kept.length;
          rec.journalDropped = jw.dropped;
        }
        rec.events = rows;
        rec.toolCalls = rows.filter((e) => e.kind === 'call').map((e) => e.name);
        rec.toolErrors = rows.filter((e) => e.kind === 'result' && e.isError).length;
        // R3-1(打字防串窗)终扫:全量历史复扫一次(等待环增量扫漏网兜底 —— 会话
        // 终局后证据定格,此时检出只记账:污染轨迹的自报/expect 不可信 ⇒ 判 FAIL。
        if (!rec.pollution) {
          const scan = scanTypingPollution(rows, { promptNeedle: t.prompt });
          if (scan.polluted) rec.pollution = { at: new Date().toISOString(), findings: scan.findings, lateScan: true };
        }
        let trajPass;
        if (t.expect) {
          const hay = JSON.stringify(rows);
          trajPass = t.expect.every((re) => new RegExp(re, 'i').test(hay));
          rec.failedExpectations = t.expect.filter((re) => !new RegExp(re, 'i').test(hay));
        }
        rec.trajectoryPass = trajPass;
        let verifyPass;
        if (post.hasE2) {
          try {
            const v = await time('verifyMs', () => runVerification({ taskId: t.id, verify: t.verify, world, reportDir: taskDir, captureScreenshot: opts.screenshot }));
            rec.verify = v.result;
            verifyPass = v.result.pass;
          } catch (e) {
            rec.verify = { pass: false, channelError: true, checks: [], error: e.message, channel: 'independent-local' };
            verifyPass = false;
          }
        }
        rec.pass = rec.pollution || trajPass === false || verifyPass === false ? false
          : trajPass === true && verifyPass !== false ? true
          : verifyPass === true ? true : undefined;
        rec.retries = retryLog;
        rec.rpcRetries = retryLog.length;
        rec.timeoutPlan = { task: tp.taskTimeoutMs, effective: tp.effectiveTimeoutMs };
        rec.timings = timings;
        await writeFileAtomic(path.join(taskDir, 'receipt.json'), JSON.stringify({
          schema: 'dsh-drive-desktop-receipt/1', runId, taskId: t.id, sessionId: s.sessionId,
          transport: { endpoint: T.endpoint, model: MODEL_SELECTOR, logins: T.logins },
          startedAt: rec.startedAt, finishedAt: new Date().toISOString(),
          pass: rec.pass, trajectoryPass: rec.trajectoryPass,
          e2: t.verify ? { present: true, result: rec.verify } : { present: false, note: '无 verify 块 —— e2=absent(仅自报轨迹)' },
          timedOut: !!rec.timedOut, waitedMs: rec.waitedMs, sawRunning: rec.sawRunning, timeoutPlan: rec.timeoutPlan,
          // R3-3(GAP-4):轮数护栏终态 —— 超限 ⇒ stoppedBy:'turn-cap'(R2-8 §3 语义);
          // R5-1:审批死锁止损 ⇒ stoppedBy:'approval-deadlock';
          // 其余按既有口径(超时/正常)如实记
          stoppedBy: rec.approvalDeadlock ? 'approval-deadlock' : rec.turnCapExceeded ? 'turn-cap' : (rec.timedOut ? 'timeout' : null),
          turnCap: rec.turnCap,
          approvalGuard: rec.approvalGuard ?? null, // R5-1:审批止损记账(timeoutMs/checks/requests/responses/cancelled)
          eventCapture: rec.eventCapture ?? null, // R6-1:增量事件捕获记账(ticks/captured/gaps/errors/merge)
          promptUncertain: !!rec.promptUncertain, timings,
          focusGuard: rec.focusGuard ?? null, // R2-3:宿主抢焦压回记账(checks/suppressed/errors)
          pollution: rec.pollution ?? null, // R3-1:打字防串窗检出(typed-into-host/self-injected-message)
          toolCalls: rec.toolCalls, toolErrors: rec.toolErrors, failedExpectations: rec.failedExpectations ?? null,
          journal: { lines: rec.journalLines ?? null, dropped: rec.journalDropped ?? null },
          retries: retryLog,
          evidence: { hist: 'hist.jsonl', events: 'session-events.jsonl', eventsInc: 'session-events-inc.jsonl', journal: 'journal-lines.jsonl', e2Dir: t.verify ? 'evidence/' : null, screenshots: t.verify ? 'screenshots/' : null },
        }, null, 1));
      } catch (e) {
        if (e instanceof GracefulStop) {
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
      if (!rec.interrupted && !rec.harnessError) {
        resumeState = commitTaskDone(resumeState, t.id);
        await flushResumeState();
      } else if (rec.harnessError && rec.interrupted !== true) {
        resumeState = registerLiveSession(resumeState, t.id, rec.sessionId ?? 'unknown');
        delete resumeState.liveSessions[t.id];
        await flushResumeState();
      }
      currentTask = null;
      await flushObservability('IDLE');
      const status = rec.pass === undefined ? (rec.harnessError ? 'ERR' : '?') : rec.pass ? 'PASS' : 'FAIL';
      const vTag = t.verify ? ` verify=${rec.verify ? (rec.verify.pass ? 'ok' : (rec.verify.channelError ? 'CHANNEL-ERR' : 'violated')) : 'n/a'}` : ' e2=absent(unverifiable)';
      const tm = rec.timings ? ` create=${timings.createMs}ms sel=${timings.selectModelMs}ms prompt=${timings.promptMs}ms wait=${timings.waitedMs}ms hist=${timings.historyMs}ms${timings.verifyMs !== undefined ? ' verify=' + timings.verifyMs + 'ms' : ''}` : '';
      const fg = rec.focusGuard ? ` fg=${rec.focusGuard.suppressed}/${rec.focusGuard.checks}${rec.focusGuard.errors ? 'e' + rec.focusGuard.errors : ''}` : '';
      const pol = rec.pollution ? ` POLLUTED(${rec.pollution.findings.map((f) => f.kind).join(',')})` : '';
      console.log(`[${plan.skipped.length + taskRecords.filter((r) => !r.rerunOf).length}]${status}${rec.timedOut ? '(超时)' : ''}${rec.turnCapExceeded ? '(轮数超限)' : ''}${rec.approvalDeadlock ? '(审批死锁止损)' : ''}${vTag}${fg}${pol} ${t.category}/${t.id} tools=[${rec.toolCalls?.join(',') || '-'}] errors=${rec.toolErrors ?? '-'} retries=${rec.rpcRetries ?? 0}${tm}${rec.harnessError ? ' harness=' + rec.harnessError.slice(0, 80) : ''}`);
      // 任务间僵尸扫荡
      try {
        const v = await rpcRetry(() => api.list(), 'session/list', { attempts: 2, retryLog });
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
    try { await rename(lockFile, lockFile + '.last'); } catch { /* 可能已被接管方移动 */ }
  }

  const summary = buildRunSummary({
    runId, suiteFile: opts.suiteFile, suiteName, model: MODEL_SELECTOR,
    startedAtIso, updatedAtIso: new Date().toISOString(), elapsedMs: Date.now() - startedAtMs,
    taskRecords, skippedIds: resumeState.doneTaskIds, liveSession: null, stoppedBy,
    rpcSummary: { retries: rpcLedger.length, logins: T.logins },
  });
  console.log('\n==== R1-8 DESKTOP SUMMARY ====');
  console.log(JSON.stringify(summary.totals, null, 1));
  console.log(`stoppedBy=${stoppedBy} failures=[${summary.failures.join(',') || '-'}] skip=${summary.skippedIds.length}`);
  console.log(`evidence: ${suiteDir}/  resume: ${resumeFile}`);
  process.exit(exitCode);
}

// CLI 守卫:被 import 时不执行 main
const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked && import.meta.url === invoked) {
  main().catch((e) => { console.error('DRIVE ERROR:', e); process.exit(1); });
}
