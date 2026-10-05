// test/w2orchestr.test.ts
// R2-6(suite-full 实战批跑编排)回归:bench/orchestrCore.mjs 纯逻辑核心的梯次划分/
// 门槛判定/checkpoint 状态机/播种清单/健康裁决,以及 batch-orchestrator.mjs CLI 的
// mock-drive 冒烟(整链 spawn:编排器 → mock drive-desktop → mock enrich/analyze;
// 零网络/零 GUI/零真实 DSH)。
// bench/ 是纯 Node .mjs 工作台;与 w2drive.test.ts 同策略 —— 非字面量动态 import
// 挂载(运行时由 Node ESM 原生解析,tsc 不做 .mjs 解析,typecheck 干净)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const load = (p: string): Promise<any> => import(p);
const benchUrl = (f: string): string => new URL(`../bench/${f}`, import.meta.url).href;
const core = await load(benchUrl('orchestrCore.mjs'));

const SUITE_FULL = fileURLToPath(new URL('../bench/suite-full.json', import.meta.url));
const ORCH = fileURLToPath(new URL('../bench/batch-orchestrator.mjs', import.meta.url));
const suiteFullTasks: any[] = JSON.parse(readFileSync(SUITE_FULL, 'utf8')).tasks;
const suiteOrder: string[] = suiteFullTasks.map((t: any) => t.id);

// ─── 梯次计划:3/9/14 · 依赖序保持 · 族分组 · 难度递增 ───

test('R2-6 Oa: 梯次划分 3/9/14 全覆盖不重不漏,执行序保持 suite 序(依赖链)', () => {
  const plan = core.buildLadderPlan(suiteFullTasks);
  assert.equal(plan.schema, 'r26-ladder-plan/1');
  assert.ok(plan.isSuiteFull);
  assert.deepEqual(plan.batches.map((b: any) => b.size), [3, 9, 14]);
  const all = plan.batches.flatMap((b: any) => b.ids);
  assert.equal(new Set(all).size, 26);
  assert.deepEqual([...all].sort(), [...suiteOrder].sort());
  // 每批内部为 suite 序的子序列(R1-3 §2 状态机全序依赖)
  for (const b of plan.batches) {
    let idx = -1;
    for (const id of b.ids) {
      const i = suiteOrder.indexOf(id);
      assert.ok(i > idx, `批${b.no} 内 ${id} 破坏 suite 序`);
      idx = i;
    }
  }
});

test('R2-6 Ob: 冒烟批构成 = 清场+播种+热键保存链;浏览器族聚合批2;审批/d4 全在批3', () => {
  const plan = core.buildLadderPlan(suiteFullTasks);
  assert.deepEqual(plan.batches[0].ids, ['full-setup-clean', 'full-seed-report', 'full-hotkey-undo-save']);
  const b2 = plan.batches[1].ids;
  assert.ok(b2.includes('full-edge-open-form') && b2.includes('full-open-url-nav'), '浏览器族应聚合在批2');
  const b3 = plan.batches[2].ids;
  for (const t of suiteFullTasks.filter((x: any) => x.difficulty === 4)) {
    assert.ok(b3.includes(t.id), `d4 任务 ${t.id} 应在批3`);
  }
  assert.ok(b3.includes('full-approval-delete-file'), '审批类(危险词真实删除)单独后置到批3');
  // 难度均值批粒度单调递增(风险阶梯)
  assert.ok(plan.batches[0].difficultyMean < plan.batches[1].difficultyMean);
  assert.ok(plan.batches[1].difficultyMean < plan.batches[2].difficultyMean);
});

test('R2-6 Oc: 门槛表 批1≥2/3 · 批2≥6/9 · 批3 无;时长模型含开销;确定性', () => {
  const p1 = core.buildLadderPlan(suiteFullTasks);
  const p2 = core.buildLadderPlan(suiteFullTasks);
  assert.equal(JSON.stringify(p1), JSON.stringify(p2), '同输入同输出(确定性)');
  assert.deepEqual(p1.batches.map((b: any) => b.gate.minPass), [2, 6, null]);
  for (const b of p1.batches) {
    assert.ok(b.timeEstimate.worstMs > b.timeEstimate.sumTaskTimeoutMs, 'worst 应含采集+固定流开销');
    assert.ok(b.timeEstimate.nominalMs <= b.timeEstimate.worstMs);
  }
  assert.ok(p1.totals.tasks === 26 && p1.totals.batches === 3);
});

test('R2-6 Od: 非 suite-full 套件回退单批无门槛;id 重复 fail-fast', () => {
  const tiny = [{ id: 'a', timeoutMs: 300000 }, { id: 'b' }];
  const plan = core.buildLadderPlan(tiny as any);
  assert.equal(plan.batches.length, 1);
  assert.equal(plan.batches[0].gate.minPass, null);
  assert.deepEqual(plan.batches[0].ids, ['a', 'b']);
  assert.throws(() => core.buildLadderPlan([{ id: 'a' }, { id: 'a' }] as any), /重复/);
});

// ─── 门槛判定 ───

test('R2-6 Oe: gateDecision 边界 —— 2/3 过 1/3 停;6/9 过 5/9 停;终批恒放行;unknown/blocked 计未过', () => {
  assert.equal(core.gateDecision({ minPass: 2, pass: 2, fail: 1, total: 3 }).proceed, true);
  const g1 = core.gateDecision({ minPass: 2, pass: 1, fail: 1, unknown: 1, total: 3 });
  assert.equal(g1.proceed, false);
  assert.match(g1.verdict, /门槛未过/);
  assert.equal(core.gateDecision({ minPass: 6, pass: 6, fail: 3, total: 9 }).proceed, true);
  assert.equal(core.gateDecision({ minPass: 6, pass: 5, unknown: 4, total: 9 }).proceed, false);
  const term = core.gateDecision({ minPass: null, pass: 0, fail: 14, total: 14 });
  assert.equal(term.proceed, true);
  assert.equal(term.verdict, 'report-only(终批无门槛)');
});

// ─── 播种清单与谓词 ───

test('R2-6 Of: 播种清单自洽 —— prereq 全在套件内且为更早的 suite 序(无环/无前向依赖)', () => {
  for (const t of suiteFullTasks) {
    const sc = core.seedCheckFor(t.id);
    for (const p of sc.prereq) {
      assert.ok(suiteOrder.includes(p), `${t.id} 的前置 ${p} 不在套件`);
      assert.ok(suiteOrder.indexOf(p) < suiteOrder.indexOf(t.id), `${t.id} 的前置 ${p} 不得晚于自身`);
    }
  }
  // 跨批前置存在(批2 吃批1 产物)且合法
  const plan = core.buildLadderPlan(suiteFullTasks);
  const batchOf: Record<string, number> = Object.fromEntries(plan.batches.flatMap((b: any) => b.ids.map((id: string) => [id, b.no])));
  const cross = suiteFullTasks.filter((t: any) => core.seedCheckFor(t.id).prereq.some((p: string) => batchOf[p] !== batchOf[t.id]));
  assert.ok(cross.length >= 2, '应存在跨批前置(编排器播种检查的跨批价值)');
  for (const t of cross) {
    for (const p of core.seedCheckFor(t.id).prereq) assert.ok(batchOf[p] < batchOf[t.id], `跨批前置须更低梯次:${p}→${t.id}`);
  }
});

test('R2-6 Og: 文件谓词真假表 —— contains/containsRegex/anyOf;seedVerdict 硬软二分', () => {
  const maps = { existsMap: { 'a.txt': true, 'b.txt': false }, contentMap: { 'a.txt': 'HELLO-WORLD', 'b.txt': null } };
  assert.equal(core.checkFilePredicate({ rel: 'a.txt', contains: 'HELLO' }, maps).ok, true);
  assert.equal(core.checkFilePredicate({ rel: 'a.txt', contains: 'NOPE' }, maps).ok, false);
  assert.equal(core.checkFilePredicate({ rel: 'b.txt', contains: 'x' }, maps).ok, false);
  assert.equal(core.checkFilePredicate({ rel: 'a.txt', containsRegex: 'WORLD$' }, maps).ok, true);
  assert.equal(core.checkFilePredicate({ rel: 'a.txt', containsRegex: '(' }, maps).ok, false, '非法正则按不成立');
  assert.equal(core.checkFilePredicate({ mode: 'any', anyOf: [{ rel: 'b.txt' }, { rel: 'a.txt', contains: 'HELLO' }] }, maps).ok, true);

  // 硬谓词失败 ⇒ blocked;软谓词失败 ⇒ 仅告警
  const hard = core.seedVerdict('full-hotkey-undo-save', { taskStates: { 'full-seed-report': 'pass' }, existsMap: {}, contentMap: {} });
  assert.equal(hard.ok, false);
  assert.match(hard.blockedBy.join(' '), /full-report\.md/);
  const soft = core.seedVerdict('full-approval-delete-file', { taskStates: { 'full-drag-file-move': 'pass' }, existsMap: {}, contentMap: {} });
  assert.equal(soft.ok, true, '软谓词(trash-me 自愈)不阻断');
  assert.ok(soft.warnings.length >= 1);
  const prereqFail = core.seedVerdict('full-edit-precision', { taskStates: { 'full-hotkey-undo-save': 'fail' }, existsMap: { 'full-report.md': true }, contentMap: { 'full-report.md': 'xHOTKEY-VERIFIED-OKx' } });
  assert.equal(prereqFail.ok, false);
  assert.match(prereqFail.blockedBy.join(' '), /前置任务未过/);
});

// ─── checkpoint 状态机 ───

function freshCampaign() {
  const plan = core.buildLadderPlan(suiteFullTasks);
  return core.withGates(core.initCampaign({ plan, campaignId: 'r26-test', suiteFile: SUITE_FULL, startedAtIso: '2026-10-05T00:00:00Z' }), plan);
}

test('R2-6 Oh: 状态机主路径 —— 全过批1 → done → nextAction 指批2;campaign 走到头 → campaign-done', () => {
  let st = core.beginBatch(freshCampaign(), 1, 't1');
  for (const id of ['full-setup-clean', 'full-seed-report', 'full-hotkey-undo-save']) {
    st = core.recordAttempt(st, id, { n: 1, exitCode: 0, pass: true, evidence: { receipt: true, hist: true, events: true } }, 't2');
  }
  st = core.finishBatch(st, 1, { nowIso: 't3' });
  assert.equal(st.batches[0].state, 'done');
  assert.match(st.batches[0].gate.verdict, /门槛过:3\/3/);
  let na = core.nextAction(st);
  assert.equal(na.cmd, 'run-batch');
  assert.equal(na.batch, 2);
  // 批2/批3 快进:批2 gate 由 finishBatch 用 withGates 注入的 minPass 判
  st = core.beginBatch(st, 2, 't4');
  for (const b of st.batches[1] ? Object.keys(st.tasks).filter((id) => st.tasks[id].batch === 2) : []) {
    st = core.recordAttempt(st, b, { n: 1, exitCode: 0, pass: true }, 't5');
  }
  st = core.finishBatch(st, 2, { nowIso: 't6' });
  assert.equal(st.batches[1].state, 'done');
  na = core.nextAction(st);
  assert.equal(na.batch, 3);
});

test('R2-6 Oi: 冒烟门槛 1/3 → gate-failed → await-human;--retry-failed 后重评通过', () => {
  let st = core.beginBatch(freshCampaign(), 1, 't1');
  st = core.recordAttempt(st, 'full-setup-clean', { n: 1, exitCode: 0, pass: true }, 't');
  st = core.recordAttempt(st, 'full-seed-report', { n: 1, exitCode: 0, pass: false }, 't');
  st = core.recordAttempt(st, 'full-hotkey-undo-save', { n: 1, exitCode: 0, pass: false }, 't');
  st = core.finishBatch(st, 1, { nowIso: 't' });
  assert.equal(st.batches[0].state, 'gate-failed');
  let na = core.nextAction(st);
  assert.equal(na.cmd, 'await-human');
  assert.match(na.reason, /--retry-failed/);
  assert.deepEqual(core.tasksToRun(st, 1, { retryFailed: true }), ['full-seed-report', 'full-hotkey-undo-save']);
  // 重跑双双转 pass ⇒ 重评门槛放行
  st = core.recordAttempt(st, 'full-seed-report', { n: 2, exitCode: 0, pass: true }, 't');
  st = core.recordAttempt(st, 'full-hotkey-undo-save', { n: 2, exitCode: 0, pass: true }, 't');
  st = core.finishBatch(st, 1, { nowIso: 't' });
  assert.equal(st.batches[0].state, 'done');
  assert.equal(core.nextAction(st).cmd, 'run-batch');
});

test('R2-6 Oj: 中断/基建 —— exit 3/130 任务回 pending 可续跑;exit 4/5/6 记 infra;播种 blocked 级联', () => {
  let st = core.beginBatch(freshCampaign(), 1, 't1');
  st = core.recordAttempt(st, 'full-setup-clean', { n: 1, exitCode: 0, pass: true }, 't');
  st = core.recordAttempt(st, 'full-seed-report', { n: 1, exitCode: 3 }, 't');
  st = core.finishBatch(st, 1, { nowIso: 't', stopReason: 'stopfile' });
  assert.equal(st.batches[0].state, 'stopped');
  assert.equal(st.tasks['full-seed-report'].state, 'pending');
  assert.deepEqual(core.tasksToRun(st, 1), ['full-seed-report', 'full-hotkey-undo-save'], '续跑只补未收口任务');
  assert.equal(core.nextAction(st).cmd, 'resume-batch');
  // 基建
  let st2 = core.beginBatch(freshCampaign(), 1, 't1');
  st2 = core.recordAttempt(st2, 'full-setup-clean', { n: 1, exitCode: 4 }, 't');
  st2 = core.finishBatch(st2, 1, { nowIso: 't', stopReason: 'infra' });
  assert.equal(st2.batches[0].state, 'infra-stopped');
  assert.equal(st2.tasks['full-setup-clean'].state, 'pending', '基建错不是任务错');
  // 播种 blocked:前置 fail 级联拦后继
  let st3 = freshCampaign();
  st3 = core.recordAttempt(st3, 'full-seed-report', { n: 1, exitCode: 0, pass: false }, 't');
  const v = core.seedVerdict('full-hotkey-undo-save', { taskStates: Object.fromEntries(Object.entries(st3.tasks).map(([id, t]: any) => [id, t.state])), existsMap: {}, contentMap: {} });
  st3 = core.recordSeed(st3, 'full-hotkey-undo-save', v, 't');
  assert.equal(st3.tasks['full-hotkey-undo-save'].state, 'blocked');
});

test('R2-6 Ok: 状态文件校验 fail-fast;outcome 映射含 receipt 缺席', () => {
  assert.throws(() => core.loadCampaignState({ schema: 'other/1' }), /schema/);
  assert.throws(() => core.loadCampaignState({ schema: 'r26-orchestr-state/1', batches: [{ no: 1, state: 'wat' }], tasks: {} }), /batches/);
  assert.throws(() => core.loadCampaignState({ schema: 'r26-orchestr-state/1', batches: [], tasks: { a: { state: 'nope', attempts: [] } } }), /state/);
  assert.equal(core.taskOutcomeFromAttempt({ exitCode: 0, receipt: { pass: true } }), 'pass');
  assert.equal(core.taskOutcomeFromAttempt({ exitCode: 0, receipt: { pass: false } }), 'fail');
  assert.equal(core.taskOutcomeFromAttempt({ exitCode: 0, receipt: { pass: undefined } }), 'unknown');
  assert.equal(core.taskOutcomeFromAttempt({ exitCode: 0, receipt: null }), 'unknown');
  assert.equal(core.taskOutcomeFromAttempt({ exitCode: 3, receipt: null }), 'stopped');
  assert.equal(core.taskOutcomeFromAttempt({ exitCode: 130, receipt: null }), 'stopped');
  assert.equal(core.taskOutcomeFromAttempt({ exitCode: 5, receipt: null }), 'infra');
});

test('R2-6 Ol: 健康裁决 —— 任一 fail 即停(stopfile 语义);全过放行', () => {
  const bad = core.healthVerdict({ rpc: true, python: false, diskFreeGb: 100, minFreeGb: 5 });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.failures.map((f: any) => f.name), ['python']);
  assert.equal(bad.action, 'write-stopfile-and-halt');
  const disk = core.healthVerdict({ rpc: true, python: true, diskFreeGb: 4.9, minFreeGb: 5 });
  assert.equal(disk.ok, false);
  assert.ok(core.healthVerdict({ rpc: true, python: true, diskFreeGb: 5.0, minFreeGb: 5 }).ok);
});

test('R2-6 Om: 渲染 —— status/markdown 含门槛与回滚;确定性', () => {
  const plan = core.buildLadderPlan(suiteFullTasks);
  const md = core.renderPlanMarkdown(plan);
  assert.equal(md, core.renderPlanMarkdown(plan));
  for (const needle of ['≥ 2/3', '≥ 6/9', '回滚预案', 'emergency-stop', 'DSH_BENCH_TEST_RUNS', '批3']) assert.ok(md.includes(needle), `markdown 缺 ${needle}`);
  let st = freshCampaign();
  st = core.beginBatch(st, 1, 't');
  st = core.recordAttempt(st, 'full-setup-clean', { n: 1, exitCode: 0, pass: true }, 't');
  const txt = core.renderStatusText(st);
  assert.ok(txt.includes('batch-1 running') && txt.includes('full-setup-clean\tpass') && txt.includes('next:'));
});

// ─── mock drive 冒烟(整链 CLI:编排器 → mock drive-desktop → mock enrich/analyze) ───

const MOCK_DRIVE = `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
const suiteFile = argv.find((a) => !a.startsWith('-'));
const out = argv[argv.indexOf('--out') + 1];
const suite = JSON.parse(readFileSync(suiteFile, 'utf8'));
const task = suite.tasks[0];
const suiteDir = path.join(out, path.basename(suiteFile).replace(/\\.json$/, ''));
const taskDir = path.join(suiteDir, task.id);
mkdirSync(taskDir, { recursive: true });
const cntFile = path.join(taskDir, 'mock-attempts.n');
const n = existsSync(cntFile) ? Number(readFileSync(cntFile, 'utf8')) + 1 : 1;
writeFileSync(cntFile, String(n));
const failList = (process.env.R26_MOCK_FAIL ?? '').split(',').filter(Boolean);
const pass = !(failList.includes(task.id) && n === 1);
writeFileSync(path.join(taskDir, 'receipt.json'), JSON.stringify({ schema: 'dsh-drive-desktop-receipt/1', runId: 'mock', taskId: task.id, pass, trajectoryPass: pass, timedOut: false, waitedMs: 1000, toolCalls: ['a', 'b'] }, null, 1));
writeFileSync(path.join(taskDir, 'hist.jsonl'), '{"kind":"call","name":"mock"}\\n');
writeFileSync(path.join(taskDir, 'session-events.jsonl'), '{"type":"event"}\\n');
const rf = path.join(suiteDir, 'resume-state.json');
let done = []; let runId = 'mock';
if (existsSync(rf)) { const j = JSON.parse(readFileSync(rf, 'utf8')); done = j.doneTaskIds ?? []; runId = j.runId ?? runId; }
writeFileSync(rf, JSON.stringify({ schema: 'dsh-drive-resume/1', runId, doneTaskIds: [...new Set([...done, task.id])], liveSessions: {} }, null, 1));
process.exit(0);
`;

const MOCK_POST = `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
mkdirSync(dir, { recursive: true });
appendFileSync(path.join(dir, 'mock-post.ran'), 'x\\n');
process.exit(0);
`;

function runOrchestrator(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ORCH, ...args], {
      env: { ...process.env, ...env },
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code }));
  });
}

function mockEnv(tmp: string) {
  const drive = path.join(tmp, 'mock-drive.mjs');
  const post = path.join(tmp, 'mock-post.mjs');
  writeFileSync(drive, MOCK_DRIVE, 'utf8');
  writeFileSync(post, MOCK_POST, 'utf8');
  return { drive, post };
}

test('R2-6 On[冒烟]: 批1 全过 → exit 0,checkpoint/固定流/resume/gen 全就位', { timeout: 120000 }, async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'r26-smoke-'));
  const { drive, post } = mockEnv(tmp);
  const root = path.join(tmp, 'root');
  const common = ['run', '--suite', SUITE_FULL, '--root', root, '--drive-cmd', drive, '--enrich-cmd', post, '--analyze-cmd', post, '--ignore-seed', '--skip-health', '--quiet'];
  const r = await runOrchestrator([...common, '--batch', '1']);
  assert.equal(r.code, 0, `批1 应门槛过退出 0(得 ${r.code})`);
  const st = JSON.parse(readFileSync(path.join(root, 'suite-full', 'orchestrator-state.json'), 'utf8'));
  assert.equal(st.batches[0].state, 'done');
  assert.equal(st.batches[0].gate.pass, 3);
  for (const id of ['full-setup-clean', 'full-seed-report', 'full-hotkey-undo-save']) {
    assert.equal(st.tasks[id].state, 'pass', `${id} 应 pass`);
  }
  // 固定流:enrich+analyze 各一记(mock-post.ran 两行)
  assert.equal(readFileSync(path.join(root, 'suite-full', 'mock-post.ran'), 'utf8').trim().split('\n').length, 2);
  // drive 侧 resume-state 累积 3 done;编排器逐任务摘/记不误伤
  const resume = JSON.parse(readFileSync(path.join(root, 'suite-full', 'resume-state.json'), 'utf8'));
  assert.equal(resume.doneTaskIds.length, 3);
  // gen 套件文件:单任务 + sprt 保形(与整役同名 ⇒ 共享 suiteDir)
  const gen = JSON.parse(readFileSync(path.join(root, 'suite-full', '.gen', 'suite-full.json'), 'utf8'));
  assert.equal(gen.tasks.length, 1);
  assert.deepEqual(gen.sprt, { p0: 0.6, p1: 0.9 });
});

test('R2-6 Oo[冒烟]: 批1 1/3 → exit 8 gate-failed;批2 被梯次纪律拦(exit 2);--retry-failed 转过;批2 放行', { timeout: 180000 }, async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'r26-gate-'));
  const { drive, post } = mockEnv(tmp);
  const root = path.join(tmp, 'root');
  const common = ['run', '--suite', SUITE_FULL, '--root', root, '--drive-cmd', drive, '--enrich-cmd', post, '--analyze-cmd', post, '--ignore-seed', '--skip-health', '--quiet'];
  const failEnv = { R26_MOCK_FAIL: 'full-seed-report,full-hotkey-undo-save' };
  assert.equal((await runOrchestrator([...common, '--batch', '1'], failEnv)).code, 8, '1/3 < 2 应 gate-failed exit 8');
  let st = JSON.parse(readFileSync(path.join(root, 'suite-full', 'orchestrator-state.json'), 'utf8'));
  assert.equal(st.batches[0].state, 'gate-failed');
  assert.equal(st.batches[0].gate.pass, 1);
  assert.equal((await runOrchestrator([...common, '--batch', '2'])).code, 2, '前序批非 done 应被梯次纪律拦');
  assert.equal((await runOrchestrator([...common, '--batch', '1'])).code, 2, 'gate-failed 无 --retry-failed 应拒绝');
  assert.equal((await runOrchestrator([...common, '--batch', '1', '--retry-failed'])).code, 0, '重跑双过 ⇒ 重评门槛放行');
  st = JSON.parse(readFileSync(path.join(root, 'suite-full', 'orchestrator-state.json'), 'utf8'));
  assert.equal(st.batches[0].state, 'done');
  assert.equal(st.tasks['full-seed-report'].attempts.length, 2, '重跑任务应有两次尝试记账');
  assert.equal((await runOrchestrator([...common, '--batch', '2'])).code, 0, '批2 9/9 过门槛');
  st = JSON.parse(readFileSync(path.join(root, 'suite-full', 'orchestrator-state.json'), 'utf8'));
  assert.equal(st.batches[1].state, 'done');
  assert.equal(st.batches[1].gate.pass, 9);
  const statusOut = await new Promise<string>((resolve) => {
    let buf = '';
    const child = spawn(process.execPath, [ORCH, 'status', '--root', root, '--suite', SUITE_FULL], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (d) => { buf += d; });
    child.on('close', () => resolve(buf));
  });
  assert.ok(statusOut.includes('batch-1 done') && statusOut.includes('next: run-batch --batch 3'));
});

test('R2-6 Op[冒烟]: 启动闸 —— STOP 已存在拒绝开跑(exit 6,stopfile 语义)', { timeout: 60000 }, async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'r26-stop-'));
  const { drive, post } = mockEnv(tmp);
  const root = path.join(tmp, 'root');
  mkdirSync(path.join(root, 'suite-full'), { recursive: true });
  writeFileSync(path.join(root, 'suite-full', 'STOP'), 'manual-stop\n', 'utf8');
  const r = await runOrchestrator(['run', '--suite', SUITE_FULL, '--root', root, '--drive-cmd', drive, '--enrich-cmd', post, '--analyze-cmd', post, '--ignore-seed', '--skip-health', '--quiet', '--batch', '1']);
  assert.equal(r.code, 6);
  assert.ok(!existsSync(path.join(root, 'suite-full', 'orchestrator-state.json')), '启动闸拒绝时不得开役');
});
