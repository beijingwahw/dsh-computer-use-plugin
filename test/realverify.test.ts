// test/realverify.test.ts
// ΤΕΛ-9 真机验证债基建（scripts/realverify/）的离线测试册——**只测缺席语义
// 与编排纯函数**（工单口径）：无硬件环境下的确定性路径。
//   ① 登记册契约：9 探针文件全在场、8 条未闭需真机债恰与台账 A 区口径一致、
//      每个探针带 ΤΕΛ-9 工程纪律标记（源码取证——仓库既有测试方言）；
//   ② 编排纯函数：parseProbeLine / buildSummary / aggregateExit / forceAbsent /
//      reportLine（缺席不红语义的数学面）；
//   ③ 缺席语义端到端：逐探针 --force-absent ⇒ exit 2 + 末行 REALVERIFY JSON
//      verdict=absent（python 探针缺席 python ⇒ 诚实 skip——w5pyreg 先例）；
//   ④ 一键编排：run-all --force-absent ⇒ exit 0（全部缺席=通过态）、SUMMARY
//      行与报告落盘对账、--list 登记册面。
// 真机在场路径（pass/degraded/fail 判定）由探针自身收割（docs/realverify.md），
// 不入本册——硬件巧合不得成为测试的隐藏前提。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 加载策略：非字面量动态 import ⇒ tsc 对 any 收声（test/w0wiring.census.test.ts
// 同律——tsconfig 无 allowJs 也能 typecheck 干净）；common.mjs 内置直跑守卫语义
// （纯函数模块，无 CLI main）。
const load = (p: string): Promise<any> => import(p);
const C: any = await load(new URL('../scripts/realverify/common.mjs', import.meta.url).href);

const HERE = dirname(fileURLToPath(import.meta.url));
const RV_DIR = resolve(HERE, '../scripts/realverify');

// ═══ ① 登记册契约 ═══

test('ΤΕΛ-9①a 登记册恰 9 探针（8 未闭需真机债 + D-A1 已闭债残余），文件全在场', () => {
  assert.equal(C.PROBE_REGISTRY.length, 9, '登记册条数漂移须同步 run-all 与 docs/realverify.md');
  for (const entry of C.PROBE_REGISTRY) {
    assert.ok(existsSync(join(RV_DIR, entry.file)), `探针文件缺席：${entry.file}`);
    assert.ok(['py', 'mjs'].includes(entry.kind), `runner 种类非法：${entry.kind}`);
  }
  assert.deepEqual(
    C.PROBE_REGISTRY.map((e: any) => e.debt),
    ['D-A1', 'D-A2', 'D-A3', 'D-A4', 'D-A6', 'D-A7', 'D-A8', 'D-B1', 'D-G4'],
    '登记册顺序/债号漂移（改动须连带更新文档与台账回填模板）',
  );
});

test('ΤΕΛ-9①b 未闭需真机债 8 条口径锁定（DEBTS A 区 + D-B1/D-G4 跨区在册）', () => {
  assert.deepEqual(C.OPEN_REAL_DEBTS, ['D-A2', 'D-A3', 'D-A4', 'D-A6', 'D-A7', 'D-A8', 'D-B1', 'D-G4']);
  // 台账 A 区八行 + D-B1/D-G4 行仍在册（行号无关的行首锚取证——防误删台账行）
  const debts = readFileSync(join(RV_DIR, '../../DEBTS.md'), 'utf8');
  for (const id of ['D-A2', 'D-A3', 'D-A4', 'D-A6', 'D-A7', 'D-A8', 'D-B1', 'D-G4']) {
    assert.ok(new RegExp(`^\\| ${id} `, 'm').test(debts), `DEBTS.md 缺 ${id} 行`);
  }
});

test('ΤΕΛ-9①c 工程纪律：每个探针源码带 ΤΕΛ-9 标记注释', () => {
  for (const entry of C.PROBE_REGISTRY) {
    const src = readFileSync(join(RV_DIR, entry.file), 'utf8');
    assert.ok(src.includes('ΤΕΛ-9'), `${entry.file} 缺 ΤΕΛ-9 标记注释（工程纪律）`);
  }
  // 公共层与编排器同律
  for (const f of ['common.mjs', 'probe_common.py', 'run-all.mjs']) {
    assert.ok(readFileSync(join(RV_DIR, f), 'utf8').includes('ΤΕΛ-9'), `${f} 缺 ΤΕΛ-9 标记`);
  }
});

// ═══ ② 编排纯函数（缺席不红语义的数学面） ═══

test('ΤΕΛ-9②a 退出码立法：四值枚举 ↔ 退出码双射、缺席 2 不在红集合', () => {
  assert.deepEqual(C.VERDICT_EXIT, { pass: 0, fail: 1, absent: 2, degraded: 3 });
  assert.deepEqual(C.EXIT, { PASS: 0, FAIL: 1, ABSENT: 2, DEGRADED: 3 });
  assert.equal(C.EXIT_VERDICT[2], 'absent');
});

test('ΤΕΛ-9②b parseProbeLine：末行 REALVERIFY JSON 提取 + 坏形状诚实 null', () => {
  const line = 'REALVERIFY ' + JSON.stringify({ schema: 'tel9-realverify/1', debt: 'D-A2', verdict: 'absent', summary: 'x', evidence: {}, elapsed_ms: 1 });
  assert.equal(C.parseProbeLine(`噪声行\n${line}\n`).debt, 'D-A2');
  assert.equal(C.parseProbeLine('REALVERIFY {bad json}'), null, '坏 JSON ⇒ null（不猜）');
  assert.equal(C.parseProbeLine('REALVERIFY {"debt":1,"verdict":2}'), null, '形状不对 ⇒ null');
  assert.equal(C.parseProbeLine('无标记行'), null);
  assert.equal(C.parseProbeLine(null), null);
  // 多行 REALVERIFY：取最后一行（探针内部多次打印时以收口行为准）
  const two = `REALVERIFY {"debt":"D-A2","verdict":"pass"}\nREALVERIFY {"debt":"D-A2","verdict":"absent"}`;
  assert.equal(C.parseProbeLine(two).verdict, 'absent');
});

test('ΤΕΛ-9②c buildSummary / aggregateExit：缺席不红、唯 fail 与 probe-error 计红', () => {
  const mk = (debt: string, verdict: string) => ({ debt, verdict });
  const allAbsent = ['D-A2', 'D-A3', 'D-A7'].map(d => mk(d, 'absent'));
  assert.deepEqual(C.buildSummary(allAbsent), { total: 3, pass: 0, fail: 0, absent: 3, degraded: 0, probe_error: 0, devices_present: 0 });
  assert.equal(C.aggregateExit(allAbsent), 0, '全部缺席 = 通过态（工单口径）');

  const mixed = [mk('D-A1', 'pass'), mk('D-A2', 'absent'), mk('D-A4', 'degraded'), mk('D-A8', 'absent')];
  assert.equal(C.aggregateExit(mixed), 0, 'pass/absent/degraded 混合仍不红');
  assert.equal(C.buildSummary(mixed).devices_present, 2, '在场数 = pass+fail+degraded');

  assert.equal(C.aggregateExit([mk('D-A2', 'pass'), mk('D-A3', 'fail')]), 1, 'fail 计红');
  assert.equal(C.aggregateExit([mk('D-A2', 'absent'), mk('D-A6', 'probe-error')]), 1, '探针自身故障计红');
});

test('ΤΕΛ-9②d forceAbsent：env 三态 + CLI 旗标（离线确定性测试钩子）', () => {
  assert.equal(C.forceAbsent([], { DSH_REALVERIFY_FORCE_ABSENT: '1' }), true);
  assert.equal(C.forceAbsent([], { DSH_REALVERIFY_FORCE_ABSENT: 'true' }), true);
  assert.equal(C.forceAbsent([], {}), false, '缺省不强制（生产收割不受影响）');
  assert.equal(C.forceAbsent(['node', 'x', '--force-absent'], {}), true);
});

test('ΤΕΛ-9②e reportLine：单行净化序列化（换行折叠 + REALVERIFY 前缀 + 键序稳定）', () => {
  const line = C.reportLine({ schema: C.SCHEMA, debt: 'D-A4', verdict: 'pass', summary: 'a\nb\rc', evidence: { note: 'x' }, elapsed_ms: 5 });
  assert.ok(line.startsWith('REALVERIFY {'));
  assert.ok(!line.includes('\n'), '证据含换行时折叠为空格（防破行）');
  const back = JSON.parse(line.slice('REALVERIFY '.length));
  assert.equal(back.summary, 'a b c');
  assert.equal(back.debt, 'D-A4');
  // 键序确定性：两次序列化逐字节一致
  assert.equal(line, C.reportLine({ schema: C.SCHEMA, debt: 'D-A4', verdict: 'pass', summary: 'a\nb\rc', evidence: { note: 'x' }, elapsed_ms: 5 }));
});

// ═══ ③ 逐探针缺席语义（exit 2 + 结构化 absent） ═══

interface ProbeRun { rc: number | null; verdict: string | null; summary: string; skipped: boolean }

function runPyAbsent(file: string): ProbeRun {
  const r = spawnSync('python', [join(RV_DIR, file), '--force-absent'], {
    env: { ...process.env, DSH_REALVERIFY_FORCE_ABSENT: '1' }, timeout: 60_000, encoding: 'utf8',
  });
  if (r.error) return { rc: null, verdict: null, summary: r.error.message, skipped: true };
  const parsed = C.parseProbeLine(r.stdout ?? '');
  return { rc: r.status, verdict: parsed?.verdict ?? null, summary: parsed?.summary ?? '', skipped: false };
}

function runMjsAbsent(file: string): ProbeRun {
  const r = spawnSync(process.execPath, [join(RV_DIR, file), '--force-absent'], {
    env: { ...process.env, DSH_REALVERIFY_FORCE_ABSENT: '1' }, timeout: 60_000, encoding: 'utf8',
  });
  if (r.error) return { rc: null, verdict: null, summary: r.error.message, skipped: true };
  const parsed = C.parseProbeLine(r.stdout ?? '');
  return { rc: r.status, verdict: parsed?.verdict ?? null, summary: parsed?.summary ?? '', skipped: false };
}

test('ΤΕΛ-9③a 六个 python 探针缺席语义：exit 2 + verdict=absent（python 缺席 ⇒ skip）', { timeout: 120_000 }, (t) => {
  const pyProbes = C.PROBE_REGISTRY.filter((e: any) => e.kind === 'py');
  assert.equal(pyProbes.length, 6);
  for (const entry of pyProbes) {
    const r = runPyAbsent(entry.file);
    if (r.skipped) {
      t.skip(`python 不可用（${r.summary}）——环境信号非代码信号（w5pyreg 先例）`);
      return;
    }
    assert.equal(r.rc, 2, `${entry.debt} 缺席退出码须为 2（got ${r.rc}）`);
    assert.equal(r.verdict, 'absent', `${entry.debt} 缺席判定词须为 absent`);
    assert.ok(r.summary.includes('缺席'), `${entry.debt} 缺席 summary 须含「缺席」`);
  }
});

test('ΤΕΛ-9③b 三个 node 探针缺席语义：exit 2 + verdict=absent', { timeout: 120_000 }, () => {
  const mjsProbes = C.PROBE_REGISTRY.filter((e: any) => e.kind === 'mjs');
  assert.equal(mjsProbes.length, 3);
  for (const entry of mjsProbes) {
    const r = runMjsAbsent(entry.file);
    assert.ok(!r.skipped, `node 自身不可用不应发生：${r.summary}`);
    assert.equal(r.rc, 2, `${entry.debt} 缺席退出码须为 2（got ${r.rc}）`);
    assert.equal(r.verdict, 'absent', `${entry.debt} 缺席判定词须为 absent`);
  }
});

// ═══ ④ 一键编排（run-all） ═══

test('ΤΕΛ-9④a run-all --list：登记册九行 + 未闭债口径行', { timeout: 60_000 }, () => {
  const r = spawnSync(process.execPath, [join(RV_DIR, 'run-all.mjs'), '--list'], { timeout: 60_000, encoding: 'utf8' });
  assert.equal(r.status, 0);
  const out = r.stdout ?? '';
  for (const e of C.PROBE_REGISTRY) assert.ok(out.includes(e.debt), `--list 缺 ${e.debt}`);
  assert.ok(out.includes('未闭需真机债 8 条'), '--list 须申报 8 条未闭口径');
});

test('ΤΕΛ-9④b run-all --force-absent：全部缺席 = exit 0（通过态）+ SUMMARY 对账 + 报告落盘', { timeout: 300_000 }, (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'tel9-realverify-'));
  const reportPath = join(tmp, 'report.json');
  try {
    const r = spawnSync(process.execPath, [join(RV_DIR, 'run-all.mjs'), '--force-absent'], {
      env: { ...process.env, DSH_REALVERIFY_FORCE_ABSENT: '1', DSH_REALVERIFY_REPORT: reportPath },
      timeout: 240_000, encoding: 'utf8',
    });
    if (r.error) return t.skip(`spawn 不可用：${r.error.message}`);
    assert.equal(r.status, 0, `全部缺席须为通过态 exit 0（got ${r.status}）\n${r.stdout}\n${r.stderr}`);
    const m = (r.stdout ?? '').match(/^SUMMARY (\{.*\})$/m);
    assert.ok(m, 'SUMMARY 行在场');
    const summary = JSON.parse(m[1]);
    assert.equal(summary.total, 9);
    assert.equal(summary.absent, 9, '强制缺席模式 ⇒ 九探针全 absent');
    assert.equal(summary.fail, 0);
    assert.equal(summary.probe_error, 0, '缺席路径绝无探针自身故障');
    // 报告落盘对账（DSH_REALVERIFY_REPORT 改道生效）
    assert.ok(existsSync(reportPath), '报告文件落盘');
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.schema, 'tel9-realverify-report/1');
    assert.equal(report.exit_code, 0);
    assert.equal(report.env.forced_absent, true);
    assert.deepEqual(Object.keys(report.probes), C.PROBE_REGISTRY.map((e: any) => e.debt));
    for (const debt of Object.keys(report.probes)) {
      assert.equal(report.probes[debt].verdict, 'absent', `${debt} 报告须为 absent`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
