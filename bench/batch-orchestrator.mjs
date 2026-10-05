#!/usr/bin/env node
// bench/batch-orchestrator.mjs — R2-6 suite-full 实战批跑编排器(CLI,IO 编排)。
//
// 纪律:**本编排器不直接跑 GUI** —— 真实桌面动作一律经 bench/drive-desktop.mjs
// (R1-8 桌面宿主 transport 适配驱动,driveCore 决策核心:重试/超时/续跑/串行锁/
// 僵尸回收全继承);编排器只做梯次调度,供持 GUI 锁的执行工位调用。
//
// 梯次(冒烟 3 → 小批 9 → 全量 14,门槛递进):
//   批1 = full-setup-clean + full-seed-report + full-hotkey-undo-save(冒烟:
//         清场/播种/保存链+热键撤销 —— R1-8 实测的最大风险面),门槛 ≥2/3;
//   批2 = 精确操作+视觉感知+文件创作+浏览器 9 任务(窗口/浏览器族聚合),门槛 ≥6/9;
//   批3 = 拖拽/三窗/元素寻址/审批/宏/技能/自主/编排/观测/终清 14 任务(全部 d4
//         高危族两道门槛后放行),终批无门槛只出报告。
//
// 每任务一次 drive-desktop 调用(单任务套件文件 <suiteDir>/.gen/<suiteName>.json,
// 同名 ⇒ 与整役共享 resume-state/pid 锁/STOP/证据布局);任务前播种检查(prereq
// checkpoint 终态 + 操场文件谓词,纯 fs 零 GUI 冲突);任务后证据四件套在盘核查;
// 批收口固定流 enrich-evidence → analyze-run(R1-7);批间宿主健康巡检(RPC 活性/
// python 8421-8428/磁盘 ≥5GB),异常即写 STOP 停机(stopfile 语义,与 drive 同一路径)。
//
// 用法:
//   node bench/batch-orchestrator.mjs plan [--markdown] [--suite <file>] [--out-file <f>]
//   node bench/batch-orchestrator.mjs run --batch N [--suite <file>] [--root <dir>]
//       [--token <t>] [--task-timeout-ms N] [--total-budget-ms N] [--rpc-attempts N]
//       [--task-reruns N] [--retry-failed] [--journal <p>] [--endpoint <url>]
//       [--no-screenshot] [--no-minimize-all] [--skip-health] [--min-free-gb N]
//       [--ignore-seed] [--no-postprocess] [--refresh-baseline]
//       [--drive-cmd <mjs>] [--enrich-cmd <mjs>] [--analyze-cmd <mjs>] [--quiet]
//   node bench/batch-orchestrator.mjs status [--root <dir>] [--suite <file>]
//
// 退出码:0 完成/门槛过 · 2 用法/梯次纪律/状态不符 · 3 stopfile 停机 · 4 基建中断
//         (drive exit 1/2/4/5/6) · 6 启动时 STOP 已在 · 8 门槛未过待人工 ·
//         9 健康巡检失败(STOP 已写) · 130 SIGINT。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile, rename, readFile, statfs } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { config } from './config.mjs';
import { clampTaskTimeout, loadResumeState } from './driveCore.mjs';
import {
  buildLadderPlan, initCampaign, loadCampaignState, withGates, beginBatch, recordSeed,
  recordAttempt, finishBatch, batchOutcomeSummary, tasksToRun, nextAction, seedVerdict,
  seedCheckFor, healthVerdict, renderStatusText, renderPlanMarkdown,
} from './orchestrCore.mjs';

const BENCH_DIR = fileURLToPath(new URL('./', import.meta.url));
const DEFAULT_SUITE = path.join(BENCH_DIR, 'suite-full.json');
const DEFAULT_DRIVE = path.join(BENCH_DIR, 'drive-desktop.mjs');
const DEFAULT_ENRICH = path.join(BENCH_DIR, 'enrich-evidence.mjs');
const DEFAULT_ANALYZE = path.join(BENCH_DIR, 'analyze-run.mjs');
const PYTHON_PORTS = [8421, 8422, 8423, 8424, 8425, 8426, 8427, 8428]; // R1-6 serviceManager 端口区间
const READ_FILE_CAP = 2 * 1024 * 1024; // 播种内容读取上限(操场产物均远小于此)
const say = (m) => console.log(m);

// ─── kill-switch(单击优雅:任务间/批间收口后停;双击硬退) ───
let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.error('\n[orchestrator kill-switch] SIGINT —— 当前 drive 子进程自行优雅停(同控制台组),任务间收口后退出(再按一次硬退)');
});
process.on('SIGTERM', () => { interrupted = true; });

// ─── CLI ───

const VALUE_OPTS = new Set(['--suite', '--root', '--token', '--task-timeout-ms', '--total-budget-ms', '--rpc-attempts', '--task-reruns', '--journal', '--endpoint', '--min-free-gb', '--out-file', '--drive-cmd', '--enrich-cmd', '--analyze-cmd', '--batch', '--approval-timeout-ms']);

function parseArgs(argv) {
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : null;
  const opts = {
    cmd, suite: DEFAULT_SUITE, root: config.resultsDir, token: null,
    taskTimeoutMs: null, totalBudgetMs: null, rpcAttempts: null, taskReruns: 0,
    retryFailed: false, journal: null, endpoint: null, minFreeGb: 5, batch: null,
    approvalTimeoutMs: 0, // R5-1:无人值守审批止损(0=关;透传 drive-desktop)
    markdown: false, outFile: null, skipHealth: false, ignoreSeed: false,
    noPostprocess: false, refreshBaseline: false, noScreenshot: false, noMinimizeAll: false,
    driveCmd: DEFAULT_DRIVE, enrichCmd: DEFAULT_ENRICH, analyzeCmd: DEFAULT_ANALYZE,
    quiet: false, help: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = eq > 2 ? a.slice(0, eq) : a;
    const val = eq > 2 ? a.slice(eq + 1) : null;
    if (name === '--retry-failed') opts.retryFailed = true;
    else if (name === '--markdown') opts.markdown = true;
    else if (name === '--skip-health') opts.skipHealth = true;
    else if (name === '--ignore-seed') opts.ignoreSeed = true;
    else if (name === '--no-postprocess') opts.noPostprocess = true;
    else if (name === '--refresh-baseline') opts.refreshBaseline = true;
    else if (name === '--no-screenshot') opts.noScreenshot = true;
    else if (name === '--no-minimize-all') opts.noMinimizeAll = true;
    else if (name === '--quiet' || name === '-q') opts.quiet = true;
    else if (name === '--help' || name === '-h') opts.help = true;
    else if (VALUE_OPTS.has(name)) {
      const v = val ?? argv[++i];
      if (v === undefined || v === '') throw new Error(`${name} 需要非空值(--flag=value 或 --flag value)`);
      applyValueOpt(opts, name, v);
    } else throw new Error(`不识参数:${a}(用 --help 看用法)`);
  }
  return opts;
}

function applyValueOpt(opts, name, raw) {
  if (name === '--suite') opts.suite = raw;
  else if (name === '--root') opts.root = raw;
  else if (name === '--token') opts.token = raw;
  else if (name === '--journal') opts.journal = raw;
  else if (name === '--endpoint') opts.endpoint = raw;
  else if (name === '--out-file') opts.outFile = raw;
  else if (name === '--drive-cmd') opts.driveCmd = raw;
  else if (name === '--enrich-cmd') opts.enrichCmd = raw;
  else if (name === '--analyze-cmd') opts.analyzeCmd = raw;
  else {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} 须为非负数,得 ${raw}`);
    if (name === '--task-timeout-ms') opts.taskTimeoutMs = n;
    else if (name === '--approval-timeout-ms') opts.approvalTimeoutMs = Math.floor(n); // R5-1:0=关
    else if (name === '--total-budget-ms') opts.totalBudgetMs = n;
    else if (name === '--rpc-attempts') opts.rpcAttempts = Math.max(1, Math.floor(n));
    else if (name === '--task-reruns') opts.taskReruns = Math.floor(n);
    else if (name === '--min-free-gb') opts.minFreeGb = n;
    else if (name === '--batch') opts.batch = Math.floor(n);
  }
}

function usage() {
  console.log(`用法:
  node bench/batch-orchestrator.mjs plan [--markdown] [--suite <file>] [--out-file <f>]
      梯次计划:JSON(确定性,无时间戳)或 --markdown 人读文档
  node bench/batch-orchestrator.mjs run --batch N [options]
      跑指定批(1|2|3):每任务 ①播种检查 ②drive-desktop 单任务调用 ③证据在盘核查;
      批收口固定流 enrich-evidence→analyze-run;门槛判定;批状态 checkpoint 落盘
  node bench/batch-orchestrator.mjs status
      断点状态:批次/任务终态/门槛/下一步动作(纯读)
选项:
  --suite <file>        缺省 bench/suite-full.json
  --root <dir>          战役根(缺省 config.resultsDir=${config.resultsDir};
                        证据布局 <root>/suite-full/<task-id>/,与整役共享)
  --token <t>           桌面宿主 token(或 env DSH_DESKTOP_TOKEN/DSH_BENCH_TOKEN)
  --task-timeout-ms N   透传 drive(钳制 [5,10]min;suite 内 timeoutMs 优先)
  --total-budget-ms N   透传 drive 的总量熔断(缺省按单任务预算=任务超时+5min)
  --rpc-attempts N      透传 drive 瞬态 RPC 重试上限(缺省 driveCore 4)
  --task-reruns N       任务 FAIL 后编排器级真机重跑次数(缺省 0;先摘 resume-state)
  --approval-timeout-ms N  R5-1 无人值守审批止损,透传 drive:审批请求 N ms 无应答
                        (grant_approval 结果/操作员消息均算应答)⇒ cancel 会话快速
                        止损 + 回执记 approvalGuard(0=关,缺省;无人值守批建议 60000)
  --retry-failed        批 gate-failed/stopped 后只重跑 fail/unknown/blocked 并重评门槛
  --journal/--endpoint/--no-screenshot/--no-minimize-all  透传 drive
  --skip-health         跳过批前健康巡检(RPC/python/磁盘)
  --min-free-gb N       磁盘水位线(缺省 5GB;root 与 playground 双查)
  --ignore-seed         跳过播种检查(排障用;正常批跑禁用)
  --no-postprocess      跳过批后 enrich+analyze 固定流
  --refresh-baseline    analyze 传 --refresh-baseline(重固化基线,旧档归档)
  --drive-cmd/--enrich-cmd/--analyze-cmd <mjs>  子命令钩子(自测 mock 用)
  --quiet               子进程输出丢弃(编排器自身行保留)
环境:DSH_BENCH_TEST_RUNS(R1-2,必 export,否则缺省 D: 盘 fail-fast)、
      DSH_DESKTOP_ENDPOINT(缺省 19387,非 CLI web 3080)。`);
}

// ─── 小件 ───

async function writeAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, file);
}

function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }

function loadSuiteRaw(suiteFile) {
  const raw = readJson(suiteFile);
  const tasks = Array.isArray(raw) ? raw : raw.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('套件无任务');
  return { raw, tasks };
}

function campaignPaths(opts) {
  const suiteName = path.basename(opts.suite).replace(/\.json$/, '');
  const suiteDir = path.join(opts.root, suiteName);
  return {
    suiteName, suiteDir,
    genFile: path.join(suiteDir, '.gen', `${suiteName}.json`), // basename 与套件同名 ⇒ drive 落同一 suiteDir
    stateFile: path.join(suiteDir, 'orchestrator-state.json'),
    resumeFile: path.join(suiteDir, 'resume-state.json'),
    stopfile: path.join(suiteDir, 'STOP'),
  };
}

/** runNode —— 串行子进程(node 脚本);返回 exit code(null=启动失败)。 */
function runNode(script, args, { quiet = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: quiet ? 'ignore' : 'inherit',
    });
    child.on('error', (e) => { console.error(`! 子进程启动失败(${script}):${e.message}`); resolve(null); });
    child.on('close', (code) => resolve(code));
  });
}

/** stripDoneId —— 从 drive 的 resume-state 摘除任务 id(编排器级重跑的前置;
 *  drive 只在跑前读取,串行间隙内改写安全;形状校验沿 driveCore.loadResumeState)。 */
async function stripDoneId(resumeFile, taskId) {
  if (!existsSync(resumeFile)) return;
  const st = loadResumeState(readJson(resumeFile));
  if (!st.doneTaskIds.includes(taskId)) return;
  await writeAtomic(resumeFile, JSON.stringify({
    schema: 'dsh-drive-resume/1', runId: st.runId,
    doneTaskIds: st.doneTaskIds.filter((id) => id !== taskId),
    liveSessions: st.liveSessions,
  }, null, 1));
}

/** tcpAlive —— 端口活性(TCP connect 即断,零影响)。 */
function tcpAlive(port, host = '127.0.0.1', timeoutMs = 900) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

/** diskFreeGb —— statfs 自由空间(GB;两路径取小)。 */
async function diskFreeGb(paths) {
  let min = Infinity;
  for (const p of paths) {
    try {
      const st = await statfs(p);
      min = Math.min(min, (st.bavail * st.bsize) / 2 ** 30);
    } catch {
      return null; // 路径不在 ⇒ 观察失败,交 verdict 记失败
    }
  }
  return Number.isFinite(min) ? min : null;
}

/** healthCheck —— 批前巡检(RPC 活性/python/磁盘);观察 + 纯核裁决。 */
async function healthCheck(opts, paths) {
  const token = opts.token ?? process.env.DSH_DESKTOP_TOKEN ?? process.env.DSH_BENCH_TOKEN ?? null;
  const useDefaultDrive = opts.driveCmd === DEFAULT_DRIVE;
  const rpc = useDefaultDrive
    ? (token ? (await runNode(DEFAULT_DRIVE, [opts.suite, '--probe', `--token=${token}`, '--out', opts.root, ...(opts.endpoint ? ['--endpoint', opts.endpoint] : [])], { quiet: opts.quiet })) === 0 : undefined)
    : undefined; // mock/自定义驱动下 RPC 语义不成立,跳过
  let python = false;
  for (const p of PYTHON_PORTS) { if (await tcpAlive(p)) { python = true; break; } }
  const free = await diskFreeGb([opts.root, config.playground]);
  return healthVerdict({
    rpc, python,
    diskFreeGb: free, minFreeGb: opts.minFreeGb,
  });
}

/** seedIO —— 任务播种谓词的观察(existsMap/contentMap,纯 fs,≤2MB 读)。 */
async function seedIO(taskId) {
  const plan = seedCheckFor(taskId);
  const rels = [...new Set(plan.files.flatMap((f) => (f.mode === 'any' ? (f.anyOf ?? []) : [f])).map((x) => x.rel).filter((r) => r !== 'absent'))];
  const existsMap = {}, contentMap = {};
  for (const rel of rels) {
    const abs = path.join(config.playground, rel);
    existsMap[rel] = existsSync(abs);
    if (existsMap[rel]) {
      const st = statSync(abs);
      contentMap[rel] = st.size > READ_FILE_CAP ? '' : readFileSync(abs, 'utf8');
    } else contentMap[rel] = null;
  }
  return { existsMap, contentMap };
}

/** readReceipt —— 任务回执(exit 0 时)与证据在盘核查。 */
function collectReceipt(paths, taskId) {
  const taskDir = path.join(paths.suiteDir, taskId);
  const receiptFile = path.join(taskDir, 'receipt.json');
  const receipt = existsSync(receiptFile) ? readJson(receiptFile) : null;
  const evidence = {
    receipt: !!receipt,
    hist: existsSync(path.join(taskDir, 'hist.jsonl')),
    events: existsSync(path.join(taskDir, 'session-events.jsonl')),
  };
  return { receipt, evidence };
}

/** buildDriveArgs —— 单任务 drive-desktop 调用参数。 */
function buildDriveArgs(opts, paths, task) {
  const args = [paths.genFile, '--out', opts.root, '--stopfile', paths.stopfile];
  if (opts.taskTimeoutMs != null) args.push('--task-timeout-ms', String(opts.taskTimeoutMs));
  const budget = opts.totalBudgetMs ?? (clampTaskTimeout(opts.taskTimeoutMs ?? task.timeoutMs) + 300000);
  args.push('--total-budget-ms', String(budget));
  if (opts.rpcAttempts != null) args.push('--rpc-attempts', String(opts.rpcAttempts));
  if (opts.approvalTimeoutMs > 0) args.push('--approval-timeout-ms', String(opts.approvalTimeoutMs)); // R5-1:无人值守审批止损(0=关不透传)
  const token = opts.token ?? process.env.DSH_DESKTOP_TOKEN ?? process.env.DSH_BENCH_TOKEN ?? null;
  if (token) args.push(`--token=${token}`);
  if (opts.journal) args.push('--journal', opts.journal);
  if (opts.endpoint) args.push('--endpoint', opts.endpoint);
  if (opts.noScreenshot) args.push('--no-screenshot');
  if (opts.noMinimizeAll) args.push('--no-minimize-all');
  return args;
}

/** postprocess —— 批收口固定流:enrich-evidence → analyze-run(R1-7 产物)。 */
async function postprocess(opts, paths, state, batchNo) {
  const results = {};
  results.enrich = await runNode(opts.enrichCmd, [paths.suiteDir, '--quiet'], { quiet: opts.quiet });
  const aArgs = [paths.suiteDir, '--quiet'];
  if (opts.refreshBaseline) aArgs.push('--refresh-baseline');
  results.analyze = await runNode(opts.analyzeCmd, aArgs, { quiet: opts.quiet });
  const b = state.batches.find((x) => x.no === batchNo);
  if (b) b.postprocess = { enrich: results.enrich, analyze: results.analyze, at: new Date().toISOString() };
  for (const [k, v] of Object.entries(results)) {
    if (v !== 0) console.error(`! 固定流 ${k} 退出码 ${v}(非致命:证据分析缺席已记账;exit 3=基线损坏可用 --refresh-baseline 重建)`);
  }
  return results;
}

// ─── 子命令:plan ───

async function cmdPlan(opts) {
  const { tasks } = loadSuiteRaw(opts.suite);
  const plan = buildLadderPlan(tasks, { playground: config.playground });
  const out = opts.markdown ? renderPlanMarkdown(plan) : JSON.stringify(plan, null, 1);
  if (opts.outFile) { await writeAtomic(opts.outFile, out + '\n'); say(`plan 已写入 ${opts.outFile}`); }
  else say(out);
}

// ─── 子命令:status ───

async function cmdStatus(opts) {
  const paths = campaignPaths(opts);
  if (!existsSync(paths.stateFile)) {
    console.error(`无战役状态:${paths.stateFile} —— 先跑 run --batch 1(或检查 --root/--suite)`);
    process.exit(2);
  }
  say(renderStatusText(loadCampaignState(readJson(paths.stateFile))));
}

// ─── 子命令:run ───

async function cmdRun(opts, paths, plan) {
  const nowIso = () => new Date().toISOString();

  // 启动闸:stopfile 已在 ⇒ 拒绝开跑(与 drive exit 6 同语义,防"删了又跑"循环)
  if (existsSync(paths.stopfile)) {
    console.error(`STOP 已存在:${paths.stopfile} —— 人工确认后删除该文件再启动(健康巡检异常/操作者 touch 都会落此文件)`);
    process.exit(6);
  }

  // 战役状态:装载或初始化;与计划核对(同役不得换套件形状)
  let state = existsSync(paths.stateFile)
    ? loadCampaignState(readJson(paths.stateFile))
    : withGates(initCampaign({ plan, campaignId: `r26-${nowIso().replace(/[^0-9]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 4)}`, suiteFile: path.resolve(opts.suite), startedAt: nowIso() }), plan);
  const planIds = plan.batches.flatMap((b) => b.ids).sort().join(',');
  const stateIds = Object.keys(state.tasks).sort().join(',');
  if (planIds !== stateIds) {
    console.error(`战役状态与套件不符(${paths.stateFile})—— 换套件请换 --root 或清状态文件`);
    process.exit(2);
  }
  const persist = () => writeAtomic(paths.stateFile, JSON.stringify(state, null, 1) + '\n');

  const batchNo = opts.batch;
  const batchDef = plan.batches.find((b) => b.no === batchNo);
  if (!batchDef) { console.error(`批 ${batchNo} 不在梯次计划(1..${plan.batches.length})`); process.exit(2); }

  // 梯次纪律:前序批必须全部 done(冒烟→小批→全量的执行阶梯)
  const prior = state.batches.filter((b) => b.no < batchNo && b.state !== 'done');
  if (prior.length) {
    const na = nextAction(state);
    console.error(`梯次纪律:批 ${prior.map((b) => b.no).join(',')} 状态非 done(${prior.map((b) => b.state).join(',')})\n  下一步: ${na.cmd}${na.batch ? ' --batch ' + na.batch : ''} —— ${na.reason}`);
    process.exit(2);
  }
  const batchState = state.batches.find((b) => b.no === batchNo).state;
  if (batchState === 'done' && !opts.retryFailed) {
    say(`批 ${batchNo} 已 done(门槛已过)—— 无事可做;status 看全貌`);
    process.exit(0);
  }
  if (batchState === 'gate-failed' && !opts.retryFailed) {
    console.error(`批 ${batchNo} 门槛未过(gate-failed)—— 修复后用 run --batch ${batchNo} --retry-failed 重评,或人工裁决放弃`);
    process.exit(2);
  }

  let runList = tasksToRun(state, batchNo, { retryFailed: opts.retryFailed });
  if (runList.length === 0) {
    // 无待跑任务:直接重收批(重评门槛)
    state = finishBatch(state, batchNo, { nowIso: nowIso() });
    await persist();
    await afterBatch(opts, paths, state, batchNo);
    return;
  }
  say(`[orchestrator] 批 ${batchNo}(${batchDef.size} 任务,门槛 ${batchDef.gate.minPass == null ? '无' : `≥${batchDef.gate.minPass}/${batchDef.size}`})本轮调度 ${runList.length} 个:${runList.join(' → ')}`);

  // 健康巡检(批前;异常即写 STOP 停机 —— stopfile 语义)
  if (!opts.skipHealth) {
    say('[health] 批前巡检:RPC 活性 / python 8421-8428 / 磁盘水位 …');
    const hv = await healthCheck(opts, paths);
    for (const c of hv.checks) say(`  ${c.ok ? 'ok' : 'FAIL'} ${c.name}: ${c.detail}`);
    if (!hv.ok) {
      await writeFile(paths.stopfile, JSON.stringify({ schema: 'r26-health-stop/1', at: nowIso(), failures: hv.failures }, null, 1) + '\n', 'utf8');
      state = finishBatch(state, batchNo, { nowIso: nowIso(), stopReason: 'health' });
      state.batches.find((b) => b.no === batchNo).postprocess = { skipped: true, reason: 'health-stopped(证据固定流仍可手动跑 enrich/analyze)' };
      await persist();
      console.error(`HEALTH STOP: ${hv.failures.map((f) => f.name).join(',')} 失败 —— 已写 ${paths.stopfile};处置后删除该文件再续跑`);
      process.exit(9);
    }
  }

  // playground 预检(R1-2:漏 export 时缺省 D: 盘,真跑必炸 —— 提前显式失败)
  if (opts.driveCmd === DEFAULT_DRIVE && !opts.ignoreSeed && !existsSync(config.playground)) {
    console.error(`操场目录不存在:${config.playground} —— 先 export DSH_BENCH_TEST_RUNS(R1-2 迁移纪律),或 --ignore-seed 排障`);
    process.exit(2);
  }

  state = beginBatch(state, batchNo, nowIso());
  await persist();

  let stopReason = null; // 'stopfile' | 'sigint' | 'infra'
  let exitCode = 0;

  for (const taskId of runList) {
    if (existsSync(paths.stopfile)) { stopReason = 'stopfile'; break; }
    if (interrupted) { stopReason = 'sigint'; break; }

    // ① 播种检查(prereq 终态 + 操场文件谓词;blocked 计未过但不阻断后续无依赖任务)
    if (!opts.ignoreSeed) {
      const io = await seedIO(taskId);
      const verdict = seedVerdict(taskId, { taskStates: Object.fromEntries(Object.entries(state.tasks).map(([id, t]) => [id, t.state])), ...io });
      state = recordSeed(state, taskId, verdict, nowIso());
      await persist();
      for (const w of verdict.warnings) say(`  [seed-warn] ${taskId}: ${w}`);
      if (!verdict.ok) {
        console.error(`  [seed-BLOCKED] ${taskId}: ${verdict.blockedBy.join(' ; ')}`);
        continue;
      }
    }

    const task = batchDef.tasks.find((t) => t.id === taskId);
    // ② drive-desktop 单任务调用(重跑前先摘 resume-state,保证真机重跑而非跳过)
    const maxAttempts = 1 + opts.taskReruns;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (existsSync(paths.stopfile)) { stopReason = 'stopfile'; break; }
      if (interrupted) { stopReason = 'sigint'; break; }
      await stripDoneId(paths.resumeFile, taskId);
      const rawSuite = loadSuiteRaw(opts.suite); // 单任务套件:与整役同名文件 ⇒ 共享 suiteDir/resume/锁/STOP
      await writeAtomic(paths.genFile, JSON.stringify({
        ...(plan.isSuiteFull && rawSuite.raw.sprt ? { sprt: rawSuite.raw.sprt } : {}),
        tasks: [rawSuite.tasks.find((x) => x.id === taskId)],
      }, null, 1) + '\n');
      say(`[orchestrator] (${attempt}/${maxAttempts}) ${taskId} → drive-desktop(超时 ${Math.round(clampTaskTimeout(opts.taskTimeoutMs ?? task.timeoutMs) / 60000)}min)`);
      const code = await runNode(opts.driveCmd, buildDriveArgs(opts, paths, task), { quiet: opts.quiet });
      if (code === null) { stopReason = 'infra'; break; }
      const { receipt, evidence } = collectReceipt(paths, taskId);
      state = recordAttempt(state, taskId, {
        n: state.tasks[taskId].attempts.length + 1, exitCode: code,
        pass: receipt ? receipt.pass === true ? true : receipt.pass === false ? false : null : null,
        trajectoryPass: receipt?.trajectoryPass ?? null,
        timedOut: receipt?.timedOut ?? null,
        waitedMs: receipt?.waitedMs ?? null,
        toolCalls: Array.isArray(receipt?.toolCalls) ? receipt.toolCalls.length : null,
        harnessError: receipt ? null : (code === 0 ? 'receipt-missing' : `drive-exit-${code}`),
        evidence,
      }, nowIso());
      await persist();
      const t = state.tasks[taskId];
      const last = t.attempts[t.attempts.length - 1];
      say(`  → ${taskId} ${last.outcome}${last.pass === true ? '' : last.pass === false ? '(receipt pass=false)' : ''} exit=${code} 证据(receipt/hist/events)=${evidence.receipt}/${evidence.hist}/${evidence.events}`);
      if (!evidence.receipt && code === 0) console.error(`  ! exit 0 但回执缺席(${taskId})—— 按 unknown 记账(harnessError=receipt-missing)`);
      if (code === 3) { stopReason = 'stopfile'; break; }
      if (code === 130) { stopReason = 'sigint'; break; }
      if (code !== 0) { stopReason = 'infra'; break; }
      if (last.outcome !== 'fail') break; // pass/unknown 不吃重跑预算
      if (attempt < maxAttempts) say(`  ↻ ${taskId} FAIL —— 真机重跑(剩余 ${maxAttempts - attempt} 次)`);
    }
    if (stopReason) break;
  }

  // ③ 批收口(门槛判定或中断记账)+ 固定流 + 状态落盘
  state = stopReason === 'infra'
    ? finishBatch(state, batchNo, { nowIso: nowIso(), stopReason: 'infra' })
    : stopReason === 'stopfile' || stopReason === 'sigint'
      ? finishBatch(state, batchNo, { nowIso: nowIso(), stopReason: 'stopfile' })
      : finishBatch(state, batchNo, { nowIso: nowIso() });
  await persist();
  if (!opts.noPostprocess) { await postprocess(opts, paths, state, batchNo); await persist(); }

  const sum = batchOutcomeSummary(state, batchNo);
  const gate = state.batches.find((b) => b.no === batchNo).gate;
  say(`[orchestrator] 批 ${batchNo} 收口:pass=${sum.pass} fail=${sum.fail} unknown=${sum.unknown} blocked=${sum.blocked}(调度 ${sum.scheduled})`);
  if (gate?.verdict) say(`  门槛: ${gate.verdict}`);
  const na = nextAction(state);
  say(`  下一步: ${na.cmd}${na.batch ? ` --batch ${na.batch}` : ''} —— ${na.reason}`);
  exitCode = stopReason === 'stopfile' ? 3 : stopReason === 'sigint' ? 130 : stopReason === 'infra' ? 4
    : state.batches.find((b) => b.no === batchNo).state === 'gate-failed' ? 8 : 0;
  process.exit(exitCode);
}

async function afterBatch(opts, paths, state, batchNo) {
  if (!opts.noPostprocess) { await postprocess(opts, paths, state, batchNo); await writeAtomic(paths.stateFile, JSON.stringify(state, null, 1) + '\n'); }
  const na = nextAction(state);
  say(`  下一步: ${na.cmd}${na.batch ? ` --batch ${na.batch}` : ''} —— ${na.reason}`);
  process.exit(state.batches.find((b) => b.no === batchNo).state === 'gate-failed' ? 8 : 0);
}

// ─── main ───

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.cmd || !['plan', 'run', 'status'].includes(opts.cmd)) { usage(); process.exit(opts.help ? 0 : 2); }

  if (opts.cmd === 'plan') return cmdPlan(opts);
  if (opts.cmd === 'status') return cmdStatus(opts);

  // run
  if (opts.batch === null) { console.error('run 需要 --batch N'); process.exit(2); }
  const token = opts.token ?? process.env.DSH_DESKTOP_TOKEN ?? process.env.DSH_BENCH_TOKEN ?? null;
  if (opts.driveCmd === DEFAULT_DRIVE && !token) {
    console.error('缺 token:--token 或 env DSH_DESKTOP_TOKEN/DSH_BENCH_TOKEN(桌面宿主每次启动随机,取启动日志 dsh-web 行 —— R1-1 纪律)');
    process.exit(2);
  }
  const paths = campaignPaths(opts);
  const { tasks } = loadSuiteRaw(opts.suite);
  const plan = buildLadderPlan(tasks, { playground: config.playground });
  try {
    await mkdir(paths.suiteDir, { recursive: true });
  } catch (e) {
    console.error(`战役根不可创建:${paths.suiteDir}(${e.message})—— 多半是漏 export DSH_BENCH_TEST_RUNS(缺省指 D: 盘,R1-2 迁移纪律)`);
    process.exit(2);
  }
  return cmdRun(opts, paths, plan);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked && import.meta.url === invoked) {
  main().catch((e) => { console.error('ORCHESTRATOR ERROR:', e); process.exit(1); });
}
