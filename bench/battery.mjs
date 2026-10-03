#!/usr/bin/env node
// 任务矩阵执行器:逐任务建会话(隔离上下文)→ 下发 → 等完成 → 抓工具轨迹
// 用法: node battery.mjs <suite-file.json> [--out <dir>] [--compare <report.json>]
//                     [--max-reruns N] [--no-screenshot]
//
// W2-3 改造(bench 可信度包):
//   E2 契约核查器 —— 任务可声明 verify 块(bench/verifyCore.mjs 的谓词 DSL);
//     会话完成后走**独立核查通道**(直查文件系统/tasklist/注册表/窗口,不经 agent、
//     不信自报)终判 pass/fail;证据(截图引用+原始观察)落盘 bench/reports/<runId>/;
//     终判失败的任务自动产出「doctor 规则候选」草稿(结构化 JSON,供人工蒸馏)。
//   E3 方差感知 SPRT 回归门 —— FAIL 触发复跑,Wald SPRT 序贯收口三态
//     deterministic-pass / flaky(p̂+Wilson CI) / deterministic-fail(bench/sprtCore.mjs);
//     复跑上限防预算爆炸;--compare 对比历史版本通过率,输出比例差检验 p 值
//     (两比例 z 检验 + 配对 McNemar 精确检验)。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import {
  createWindowsWorld, runVerification, buildDoctorRuleCandidate,
  validateVerifyBlock, expandPath,
} from './verifyCore.mjs';
import {
  createRegressionGate, twoProportionTest, mcNemarExact,
  SPRT_ALPHA, SPRT_BETA, SPRT_P0, SPRT_P1, MAX_RERUNS,
} from './sprtCore.mjs';

const BASE = 'http://127.0.0.1:3080/api/';
const MODEL = { provider: 'zai-coding-cn', model: 'glm-4.5v' };
const REPORTS_ROOT = fileURLToPath(new URL('./reports/', import.meta.url)); // bench/reports/

async function rpc(method, payload) {
  const r = await fetch(BASE + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${method}`);
  const j = await r.json();
  if (!j.result?.ok) throw new Error(`rpc ${method}: ${JSON.stringify(j.result).slice(0, 300)}`);
  return j.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 参数预览:对象走 JSON —— String({}) 只会得到 "[object Object]",轨迹即失明 */
const argsPreview = (v) =>
  (typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)).slice(0, 300);

async function waitDone(sessionId, timeoutMs = 420000) {
  await sleep(2000);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await rpc('session.list', {});
      const s = v.items.find((i) => i.sessionId === sessionId);
      if (s && !s.running) return { ok: true, waitedMs: Date.now() - t0 };
    } catch { /* transient */ }
    await sleep(3000);
  }
  await rpc('session.cancel', { sessionId }).catch(() => {});
  return { ok: false, waitedMs: Date.now() - t0 };
}

function compact(history) {
  const calls = new Map();
  const out = [];
  for (const entry of history.events) {
    const e = entry.event;
    if (!e?.type) continue;
    if (e.type === 'tool/call') {
      calls.set(e.data.callId, { name: e.data.name, args: e.data.arguments });
      out.push({ ev: 'call', name: e.data.name, args: argsPreview(e.data.arguments) });
    } else if (e.type === 'tool/result') {
      const c = e.data.message?.content?.[0];
      const text = c?.content?.map((p) => p.text || '').join('\n') ?? '';
      out.push({
        ev: 'result', name: calls.get(c?.toolCallId)?.name ?? '?',
        isError: !!c?.isError,
        text: text.length > 1600 ? text.slice(0, 1600) + '…' : text,
      });
    } else if (e.type === 'assistant/message') {
      const text = (e.data?.content ?? []).map((p) => p.text || '').join('');
      if (text.trim()) out.push({ ev: 'assistant', text: text.slice(0, 1200) });
    } else if (e.type === 'turn/end' && e.data?.reason?.kind === 'error') {
      out.push({ ev: 'turn_error', error: JSON.stringify(e.data.reason.error).slice(0, 300) });
    }
  }
  return out;
}

async function runTask(t, idx, results, opts = {}) {
  const rec = { id: t.id, category: t.category, prompt: t.prompt.slice(0, 120), startedAt: new Date().toISOString() };
  if (opts.rerunOf) { rec.rerunOf = opts.rerunOf; rec.rerunIndex = opts.rerunIndex ?? null; }
  try {
    const s = await rpc('session.create', {});
    rec.sessionId = s.sessionId;
    await rpc('session.selectModel', { sessionId: s.sessionId, ...MODEL });
    await rpc('session.prompt', { sessionId: s.sessionId, mode: 'queue', content: [{ type: 'text', text: t.prompt }], clientTimeZone: 'Asia/Shanghai' });
    const w = await waitDone(s.sessionId, t.timeoutMs ?? 420000);
    rec.timedOut = !w.ok;
    rec.waitedMs = w.waitedMs;
    const h = await rpc('session.history', { sessionId: s.sessionId });
    rec.events = compact(h);
    rec.toolCalls = rec.events.filter((e) => e.ev === 'call').map((e) => e.name);
    rec.toolErrors = rec.events.filter((e) => e.ev === 'result' && e.isError).length;
    rec.turnErrors = rec.events.filter((e) => e.ev === 'turn_error').length;
    // 旧通道:任务定义的 pass 条件(对工具轨迹/回复的正则)—— 仅轨迹证据
    let trajPass;
    if (t.expect) {
      const hay = JSON.stringify(rec.events);
      trajPass = t.expect.every((re) => new RegExp(re, 'i').test(hay));
      rec.failedExpectations = t.expect.filter((re) => !new RegExp(re, 'i').test(hay));
    }
    rec.trajectoryPass = trajPass;
    // W2-3 E2:独立核查通道终判(直查世界,不经 agent、不信自报)
    let verifyPass;
    if (t.verify) {
      try {
        const v = await runVerification({
          taskId: t.id, verify: t.verify, world: opts.world, reportDir: opts.reportDir,
          captureScreenshot: opts.captureScreenshot !== false,
        });
        rec.verify = v.result; // 含 checks[] 原始观察 + 截图引用
        rec.verifyEvidenceDir = v.evidence.evidenceDir;
        verifyPass = v.result.pass;
      } catch (e) {
        // 核查通道自身崩溃:诚实降级 —— 判 false + channelError,绝不静默放行
        rec.verify = { pass: false, channelError: true, checks: [], error: e.message, channel: 'independent-local' };
        verifyPass = false;
      }
    }
    // 终判 = 轨迹 ∧ 核查(缺席的一侧不否决;两侧都缺席 ⇒ unknown,维持旧语义)
    rec.pass = trajPass === false || verifyPass === false ? false
      : trajPass === true && verifyPass !== false ? true
      : verifyPass === true ? true : undefined;
  } catch (e) {
    rec.harnessError = e.message;
    // 中途失败时会话可能仍在运行(如 prompt 已下发)—— 尽力取消,不泄漏运行中的会话
    if (rec.sessionId) await rpc('session.cancel', { sessionId: rec.sessionId }).catch(() => {});
  }
  rec.finishedAt = new Date().toISOString();
  results.push(rec);
  const status = rec.pass === undefined ? '?' : rec.pass ? 'PASS' : 'FAIL';
  const vTag = t.verify ? ` verify=${rec.verify ? (rec.verify.pass ? 'ok' : (rec.verify.channelError ? 'CHANNEL-ERR' : 'violated')) : 'n/a'}` : '';
  console.log(`[${idx + 1}]${opts.rerunOf ? '(复跑' + (opts.rerunIndex ?? '?') + ')' : ''} ${status}${vTag} ${t.category}/${t.id} tools=[${rec.toolCalls?.join(',') || '-'}] errors=${rec.toolErrors ?? '-'}/${rec.turnErrors ?? '-'}`);
  return rec;
}

// ─── 跨版本对比:两比例 z 检验(比例差 p 值)+ 配对 McNemar(同任务集时的诚实补充) ───
export function compareWithBaseline(current, baselinePath) {
  const prev = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const prevResults = prev.results ?? prev?.report?.results ?? [];
  const prevPass = new Map(prevResults.map((r) => [r.id, r.pass === true]));
  const curTasks = current.map((r) => ({ id: r.id, pass: r.gate?.verdict === 'deterministic-pass' }));
  const x1 = curTasks.filter((t) => t.pass).length, n1 = curTasks.length;
  const ids = new Set([...prevPass.keys(), ...curTasks.map((t) => t.id)]);
  const shared = [...ids].filter((id) => prevPass.has(id) && curTasks.some((t) => t.id === id));
  const x2 = shared.filter((id) => prevPass.get(id)).length, n2 = shared.length;
  // b = 旧过新不过, c = 旧不过新过(配对不一致对)
  const b = curTasks.filter((t) => shared.includes(t.id) && prevPass.get(t.id) === true && t.pass === false).length;
  const c = curTasks.filter((t) => shared.includes(t.id) && prevPass.get(t.id) === false && t.pass === true).length;
  const twoProp = twoProportionTest(x1, n1, x2, n2);
  const mc = mcNemarExact(b, c);
  return {
    baseline: { file: baselinePath, tasks: n2, pass: x2, source: prev.schema ?? 'legacy-battery-final' },
    current: { tasks: n1, pass: x1, passBasis: 'gate 最终判定 deterministic-pass(复跑收口后)' },
    twoProportionZ: { ...twoProp, note: 'H0: 两版本通过率相同(合并方差双侧 z 检验)' },
    mcNemar: { ...mc, note: '仅同任务集配对;b=旧过新败,c=旧败新过' },
    verdictHint: twoProp.p < 0.05
      ? `比例差显著(p=${twoProp.p}) —— ${x1}/${n1} vs ${x2}/${n2}${mc.p !== null && mc.p < 0.05 ? ';McNemar 亦显著' : ''}`
      : `比例差不显著(p=${twoProp.p}) —— 无法断言版本间通过率有真实差异(统计诚实:不把噪声当回归)`,
  };
}

function parseArgs(argv) {
  const opts = { suiteFile: null, out: 'D:/dsh3/test-runs/results', compare: null, maxReruns: MAX_RERUNS, screenshot: true, _: [] };
  for (const a of argv) {
    if (a === '--no-screenshot') opts.screenshot = false;
    else if (a.startsWith('--out=')) opts.out = a.slice(6);
    else if (a.startsWith('--compare=')) opts.compare = expandPath(a.slice(10));
    else if (a.startsWith('--max-reruns=')) opts.maxReruns = Number(a.slice(13));
    else if (a === '--help' || a === '-h') opts.help = true;
    else opts._.push(a);
  }
  opts.suiteFile = opts._[0] ?? null;
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.suiteFile) {
    console.log('用法: node bench/battery.mjs <suite.json> [--out <dir>] [--compare <prev-report.json>] [--max-reruns N] [--no-screenshot]');
    process.exit(opts.help ? 0 : 2);
  }
  const suite = JSON.parse(readFileSync(opts.suiteFile, 'utf8'));
  // W2-3:suite 的 verify 块先过结构校验(fail-fast,不烧真机预算)
  for (const t of suite) {
    if (t.verify) {
      const v = validateVerifyBlock(t.verify);
      if (!v.ok) throw new Error(`任务 ${t.id} 的 verify 块非法:\n  - ${v.errors.join('\n  - ')}`);
    }
  }

  const runId = `battery-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 4)}`;
  const reportDir = path.join(REPORTS_ROOT, runId);
  const candidateDir = path.join(reportDir, 'doctor-rule-candidates');
  await mkdir(candidateDir, { recursive: true });
  await mkdir(path.join(reportDir, 'screenshots'), { recursive: true });
  mkdirSync(opts.out, { recursive: true });
  const world = createWindowsWorld(); // E2 独立观察通道(与 DSH 会话物理隔离)

  const startedAt = new Date().toISOString();
  console.log(`W2-3 runId=${runId}\n  report:  ${reportDir}\n  legacy:  ${opts.out}\n  SPRT:    α=${SPRT_ALPHA} β=${SPRT_BETA} H0:p≤${SPRT_P0} H1:p≥${SPRT_P1} maxReruns=${opts.maxReruns}`);

  const results = [];
  const gateRecords = [];
  for (let i = 0; i < suite.length; i++) {
    const t = suite[i];
    const rec = await runTask(t, i, results, { world, reportDir, captureScreenshot: opts.screenshot });
    writeFileSync(`${opts.out}/battery-partial.json`, JSON.stringify(results, null, 1));

    // W2-3 E3:FAIL 触发复跑,Wald SPRT 序贯收口三态(预算上限内)
    if (rec.pass === false) {
      const gate = createRegressionGate({ maxReruns: opts.maxReruns });
      let st = gate.push(false); // 首发失败入序列
      let rerunIdx = 0;
      while (st.action === 'continue') {
        rerunIdx += 1;
        console.log(`    ↻ E3 复跑 ${rerunIdx}/${opts.maxReruns}(${t.id}) LLR=${gate.sprtState().logLikelihoodRatio} ∈ [${gate.sprtState().bounds.reject}, ${gate.sprtState().bounds.accept}]`);
        const r2 = await runTask(t, i, results, { world, reportDir, captureScreenshot: opts.screenshot, rerunOf: t.id, rerunIndex: rerunIdx });
        st = gate.push(r2.pass === true); // 复跑 unknown(如 harnessError)按失败计 —— 统计诚实
      }
      const verdict = st.verdict ?? gate.settle();
      rec.gate = verdict;
      gateRecords.push({ taskId: t.id, verdict });
      console.log(`    ⚖ E3 收口: ${verdict.verdict}${verdict.flavor ? '(' + verdict.flavor + ')' : ''} p̂=${verdict.pHat} CI=[${verdict.ci?.low}, ${verdict.ci?.high}] runs=${verdict.runs}`);

      // W2-3 E2:终判非 deterministic-pass ⇒ 自动产出 doctor 规则候选草稿
      const cand = buildDoctorRuleCandidate({ suiteFile: opts.suiteFile, task: t, runRecord: rec, verifyResult: rec.verify, gateVerdict: verdict });
      const candFile = path.join(candidateDir, `${t.id}.json`);
      await writeFile(candFile, JSON.stringify(cand, null, 1), 'utf8');
      rec.doctorRuleCandidate = path.relative(reportDir, candFile);
      console.log(`    ✎ doctor 规则候选: ${candFile}`);
    } else if (rec.pass === true) {
      rec.gate = { verdict: 'deterministic-pass', flavor: 'zero-failure-not-triggered', runs: 1, passes: 1, failures: 0, pHat: 1, note: '首发通过,未触发复跑门(零失败观测)' };
      gateRecords.push({ taskId: t.id, verdict: rec.gate });
    }
    await sleep(1500);
  }

  // ─── 汇总(旧格式兼容)+ W2-3 报告(gate/compare/证据索引) ───
  const summary = {
    total: results.filter((r) => !r.rerunOf).length,
    pass: results.filter((r) => !r.rerunOf && r.pass === true).length,
    fail: results.filter((r) => !r.rerunOf && r.pass === false).length,
    unknown: results.filter((r) => !r.rerunOf && r.pass === undefined).length,
    byCategory: {},
  };
  for (const r of results.filter((x) => !x.rerunOf)) {
    summary.byCategory[r.category] = summary.byCategory[r.category] || { total: 0, pass: 0, fail: 0 };
    summary.byCategory[r.category].total++;
    if (r.pass === true) summary.byCategory[r.category].pass++;
    if (r.pass === false) summary.byCategory[r.category].fail++;
  }
  writeFileSync(`${opts.out}/battery-final.json`, JSON.stringify({ summary, results }, null, 1));

  const byVerdict = {};
  for (const g of gateRecords) byVerdict[g.verdict.verdict] = (byVerdict[g.verdict.verdict] ?? 0) + 1;
  let compare = null;
  if (opts.compare) {
    try { compare = compareWithBaseline(gateRecords.map((g) => ({ id: g.taskId, gate: g.verdict })), opts.compare); }
    catch (e) { compare = { error: `对比失败:${e.message}` }; }
  }
  const report = {
    schema: 'w2bench-report/1',
    generatedBy: 'W2-3 bench 可信度包(E2 契约核查 + E3 SPRT 回归门)',
    runId, suiteFile: opts.suiteFile, model: MODEL, startedAt, finishedAt: new Date().toISOString(),
    summary,
    gate: {
      sprt: { alpha: SPRT_ALPHA, beta: SPRT_BETA, p0: SPRT_P0, p1: SPRT_P1, maxReruns: opts.maxReruns, bounds: { accept: Math.log((1 - SPRT_BETA) / SPRT_ALPHA), reject: Math.log(SPRT_BETA / (1 - SPRT_ALPHA)) } },
      byVerdict,
      verdicts: gateRecords,
    },
    verify: { channel: 'independent-local', evidenceRoot: reportDir, tasksWithVerify: results.filter((r) => !r.rerunOf && r.verify).length },
    doctorRuleCandidates: results.filter((r) => r.doctorRuleCandidate).map((r) => r.doctorRuleCandidate),
    compare,
    results,
  };
  await writeFile(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 1), 'utf8');

  console.log('\n==== SUMMARY ====');
  console.log(JSON.stringify(summary, null, 1));
  console.log('==== W2-3 GATE ====');
  console.log(JSON.stringify(byVerdict, null, 1));
  if (compare) { console.log('==== W2-3 COMPARE ====', JSON.stringify(compare, null, 1)); }
  console.log(`report: ${path.join(reportDir, 'report.json')}`);
}

// CLI 守卫:被 import(bench 内其他脚本/测试)时不执行 main
const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked && import.meta.url === invoked) {
  main().catch((e) => { console.error('BATTERY ERROR:', e); process.exit(1); });
}
