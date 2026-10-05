// scripts/realverify/run-all.mjs
// ΤΕΛ-9b 一键编排：串行调度全部真机验证探针，汇总报告（哪些设备在场、
// 各自判定）——确定性输出、缺席不红（诚实 exit 2 语义）。
//
// 用法：
//   node scripts/realverify/run-all.mjs                 # 全部探针（缺席者诚实 exit 2 计数）
//   node scripts/realverify/run-all.mjs --only D-A2,D-A6
//   node scripts/realverify/run-all.mjs --list          # 登记册一览（不跑）
//   node scripts/realverify/run-all.mjs --force-absent  # 全部走缺席路径（离线自检）
//
// 退出码：1 仅当存在 fail（在场但验证失败）或探针自身故障（崩溃/超时/无
// REALVERIFY 行）；全部 absent/degraded/pass ⇒ 0（缺席不红——硬件到位当天
// 重跑同一条命令即收割）。
// 报告落盘：缺省 scripts/realverify/realverify-report.json（DSH_REALVERIFY_REPORT 可改道，
// 测试册指向临时目录）。

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROBE_REGISTRY, OPEN_REAL_DEBTS, EXIT, findPython, runCapture, invoked,
  parseProbeLine, buildSummary, aggregateExit, forceAbsent, probeFilePath, REPO_ROOT,
} from './common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const only = [];
  let list = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only' && argv[i + 1]) { only.push(...argv[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean)); }
    else if (a === '--list') list = true;
  }
  return { only, list };
}

async function runOne(entry, { timeoutMs, forceAbsentFlag }) {
  // ΤΕΛ-9: 单探针调度——python/mjs 分流；缺席语义由探针自身输出（REALVERIFY 行）
  const env = { ...process.env };
  if (forceAbsentFlag) env.DSH_REALVERIFY_FORCE_ABSENT = '1';
  const file = probeFilePath(entry);
  const cmd = entry.kind === 'py' ? findPython() : process.execPath;
  const args = entry.kind === 'py' ? [file, ...(forceAbsentFlag ? ['--force-absent'] : [])] : [file, ...(forceAbsentFlag ? ['--force-absent'] : [])];
  const t0 = Date.now();
  const r = await runCapture(cmd, args, { timeoutMs, env });
  const parsed = parseProbeLine(r.stdout);
  const elapsedMs = Date.now() - t0;
  if (parsed) {
    return {
      debt: entry.debt, title: entry.title, file: entry.file, runner: entry.kind,
      verdict: parsed.verdict, summary: parsed.summary, evidence: parsed.evidence ?? {},
      probe_rc: r.rc, elapsed_ms: parsed.elapsed_ms ?? elapsedMs,
    };
  }
  // ΤΕΛ-9: 探针自身故障（崩溃/超时/缺 REALVERIFY 行）——诚实红（违反输出契约）
  return {
    debt: entry.debt, title: entry.title, file: entry.file, runner: entry.kind,
    verdict: 'probe-error',
    summary: r.timedOut ? '探针超时（无 REALVERIFY 行）' : `探针崩溃/无 REALVERIFY 行（rc=${r.rc}）`,
    evidence: { stdout_tail: (r.stdout || '').slice(-400), stderr_tail: (r.stderr || '').slice(-400) },
    probe_rc: r.rc, elapsed_ms: elapsedMs,
  };
}

async function main() {
  const { only, list } = parseArgs(process.argv);
  if (list) {
    for (const e of PROBE_REGISTRY) {
      process.stdout.write(`${e.debt}\t${e.kind}\t${e.file}\t${e.title}\n`);
    }
    process.stdout.write(`# 未闭需真机债 ${OPEN_REAL_DEBTS.length} 条：${OPEN_REAL_DEBTS.join(' ')}（D-A1 为已闭债唯余采集卡现场标定残余）\n`);
    return EXIT.PASS;
  }

  const wanted = only.length ? PROBE_REGISTRY.filter(e => only.includes(e.debt)) : [...PROBE_REGISTRY];
  if (only.length && wanted.length !== only.length) {
    const known = new Set(PROBE_REGISTRY.map(e => e.debt));
    const unknown = only.filter(d => !known.has(d));
    process.stderr.write(`unknown debt(s): ${unknown.join(', ')}（--list 看登记册）\n`);
    return EXIT.FAIL;
  }

  const timeoutMs = Math.max(30_000, parseInt(process.env.DSH_REALVERIFY_TIMEOUT_MS || '300000', 10) || 300_000);
  const forceAbsentFlag = forceAbsent();
  process.stdout.write(`ΤΕΛ-9 真机验证编排：${wanted.length} 探针${forceAbsentFlag ? '（强制缺席模式——离线自检）' : ''}\n`);
  process.stdout.write('─'.repeat(72) + '\n');

  const results = [];
  for (const entry of wanted) {
    const r = await runOne(entry, { timeoutMs, forceAbsentFlag });
    results.push(r);
    const mark = r.verdict === 'pass' ? 'PASS' : r.verdict === 'fail' ? 'FAIL' : r.verdict === 'absent' ? 'ABSENT' : r.verdict === 'degraded' ? 'DEGRADED' : 'ERROR';
    process.stdout.write(`[${mark.padEnd(7)}] ${r.debt} ${r.title}（${r.elapsed_ms}ms）\n          ${r.summary}\n`);
  }

  const summary = buildSummary(results);
  const exitCode = aggregateExit(results);
  process.stdout.write('─'.repeat(72) + '\n');
  process.stdout.write(`汇总：在场 ${summary.devices_present}/${summary.total}｜pass ${summary.pass}｜degraded ${summary.degraded}｜absent ${summary.absent}｜fail ${summary.fail}｜probe-error ${summary.probe_error}\n`);
  process.stdout.write(`结论：${exitCode === EXIT.PASS ? '无红——缺席是诚实信号，硬件到位当天重跑本命令即收割' : '有红——在场设备的验证面抓到问题（见上方 FAIL 行证据）'}\n`);
  process.stdout.write(`SUMMARY ${JSON.stringify(summary)}\n`);

  // ΤΕΛ-9: 报告落盘（默认本目录；DSH_REALVERIFY_REPORT 改道——测试册用临时目录）
  const reportPath = process.env.DSH_REALVERIFY_REPORT || path.join(here, 'realverify-report.json');
  try {
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify({
      schema: 'tel9-realverify-report/1',
      generated_at: new Date().toISOString(),
      env: { node: process.version, platform: process.platform, forced_absent: forceAbsentFlag },
      summary,
      exit_code: exitCode,
      probes: Object.fromEntries(results.map(r => [r.debt, r])),
    }, null, 2), 'utf8');
    process.stdout.write(`报告：${path.relative(REPO_ROOT, reportPath)}\n`);
  } catch (e) {
    process.stderr.write(`报告落盘失败（不阻断判定）：${e?.message ?? e}\n`);
  }
  return exitCode;
}

// ΤΕΛ-9: 直跑守卫（被 import 时不触发 main——wiring_census/genesis_audit 同律）
if (invoked(import.meta.url)) {
  main().then(
    (code) => { process.exitCode = code; },
    (e) => { process.stderr.write(`编排器异常：${e?.stack ?? e}\n`); process.exitCode = EXIT.FAIL; },
  );
}
