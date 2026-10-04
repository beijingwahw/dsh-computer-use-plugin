// test/doctorCli.smoke.test.ts
// W6R-B6 补强：doctorCli 入口壳（D-4 副通道 npm run doctor）的可离线冒烟。
// 离线策略：doctorCli.ts 是顶层副作用模块（import 即执行 CLI 并 process.exit），
// 不能进程内 import —— 一律子进程真跑；重扫描面用临时小仓（cwd = temp src/ 只放
// 1-2 个手写 .ts）注入小范围，绝不扫真仓、绝不在真仓落盘（报告/记忆只写 temp）。
// 覆盖：
//   ① 装配失败诚实降级：空 cwd（无 src/）⇒ exit 2 + stderr 指名 sourceRoot，
//      且不落任何报告/记忆工件；
//   ② 干净小仓 ⇒ exit 0 + 精确摘要行（score=100 genesis=intact findings=0
//      files=1 + 四级计数 0/0/0/0）+ exemptions 统计行 + doctor-report.json /
//      doctor-memory.json 落盘内容断言；
//   ③ 铁律违规（system.ts 外导入 nut-js ⇒ genesis.io-mutex critical）+ --strict
//      ⇒ exit 1 + genesis=violated + score=50（25×baseWeight 2）+ findings 行 +
//      stderr GENESIS VIOLATED 横幅；
//   ④ 参数解析：--strict 是唯一语义旗标 —— 违规仓无 --strict（带未知旗标噪声）
//      ⇒ exit 0 但 genesis=violated（exit 1 是 strict 专属语义）；
//   ⑤ 入口壳源级锁定：runDoctorCli(argv.slice(2)).then(exit).catch(exit 2) 接线
//     （J 纪元 .catch 修正 —— 意外 reject 不得变成 unhandledRejection）；
//   ⑥ 纯函数面：formatDoctorSummary（CLI 摘要铸造）老报告形状单行不伪造
//      exemptions、新形状双行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatDoctorSummary, type DiagnosisReport } from '../src/qualityDoctor.ts';

const CLI_PATH = fileURLToPath(new URL('../src/doctorCli.ts', import.meta.url));
const REGISTER_URL = new URL('./register.mjs', import.meta.url).href;

/** 子进程真跑入口壳：temp cwd（小仓注入）+ register hook（TS 无扩展名解析） */
function runDoctorCli(cwd: string, args: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath,
    ['--experimental-strip-types', '--import', REGISTER_URL, CLI_PATH, ...args],
    { cwd, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'w6r-docsmoke-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

// ═══ ① 装配失败诚实降级 ═══

test('W6R-cli①: 无 src/ 的 cwd ⇒ exit 2 + stderr 指名 sourceRoot；零工件落盘', () => {
  const dir = tempRepo({ 'README.md': 'not a source tree\n' }); // 有文件但无 src/
  try {
    const r = runDoctorCli(dir);
    assert.equal(r.status, 2, '退出码 2 = 装配失败（契约注释锁定）');
    assert.match(r.stderr, /sourceRoot does not exist or is not a directory/,
      'stderr 指名装配失败原因（诚实降级输出）');
    assert.equal(existsSync(join(dir, 'doctor-report.json')), false, '装配失败不产报告');
    assert.equal(existsSync(join(dir, 'doctor-memory.json')), false, '装配失败不产记忆');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ═══ ② 干净小仓 ⇒ exit 0 ═══

test('W6R-cli②: 干净小仓 ⇒ exit 0 + 精确摘要行 + 报告/记忆落 temp', () => {
  const dir = tempRepo({ 'src/clean.ts': '// 干净小件：无铁律违规、无 smell\nexport const ok = 1;\n' });
  try {
    const r = runDoctorCli(dir);
    assert.equal(r.status, 0);
    const lines = r.stdout.split('\n').filter(l => l !== '');
    assert.equal(lines[0],
      '[Doctor] score=100 genesis=intact findings=0 files=1 (critical/major/minor/info = 0/0/0/0)',
      '摘要行逐字节（score/genesis/findings/files/四级计数）');
    assert.match(lines[1]!, /^\[Doctor\] exemptions: 0\/24 over-engineering structural retentions/,
      'exemptions 统计行（登记 24、本次命中 0；W9-3 新增三件）');
    assert.match(r.stdout, /\[Doctor\] full report: /, '全量报告路径提示行');
    // 落盘工件写进 temp cwd（隔离铁律）
    const report = JSON.parse(readFileSync(join(dir, 'doctor-report.json'), 'utf8')) as DiagnosisReport;
    assert.equal(report.score, 100);
    assert.equal(report.genesisVerdict, 'intact');
    assert.equal(report.scannedFiles, 1, '只扫注入的小仓（不跑全仓重扫描）');
    assert.deepEqual(report.findings, []);
    assert.equal(report.incremental, false);
    const mem = JSON.parse(readFileSync(join(dir, 'doctor-memory.json'), 'utf8')) as { totalDiagnoses: number };
    assert.equal(mem.totalDiagnoses, 1, '全量诊断计数入记忆');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ═══ ③ 铁律违规 + --strict ⇒ exit 1 ═══

test('W6R-cli③: 铁律违规 + --strict ⇒ exit 1 + genesis=violated + score=50 + findings 行', () => {
  const dir = tempRepo({
    'src/violating.ts': "import { mouse } from '@nut-tree/nut-js';\nexport const m = mouse;\n",
  });
  try {
    const r = runDoctorCli(dir, ['--strict']);
    assert.equal(r.status, 1, 'strict 模式铁律违规 ⇒ exit 1（pre-commit/CI 消费）');
    assert.match(r.stdout, /genesis=violated findings=1 files=1 \(critical\/major\/minor\/info = 1\/0\/0\/0\)/);
    assert.match(r.stdout, /critical genesis\.io-mutex violating\.ts:1/, 'findings 明细行（规则/文件/行号）');
    assert.match(r.stdout, /score=50 /, 'critical 25 × baseWeight 2 = 50（新鲜记忆零加权）');
    assert.match(r.stderr, /GENESIS VIOLATED/, 'strict 横幅走 stderr');
    const report = JSON.parse(readFileSync(join(dir, 'doctor-report.json'), 'utf8')) as DiagnosisReport;
    assert.equal(report.findings[0]!.ruleId, 'genesis.io-mutex');
    assert.equal(report.findings[0]!.severity, 'critical');
    assert.equal(report.findings[0]!.location.file, 'violating.ts');
    assert.equal(report.findings[0]!.location.line, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ═══ ④ 参数解析：--strict 专属语义、未知旗标容忍 ═══

test('W6R-cli④: 同一违规仓无 --strict（带未知旗标噪声）⇒ exit 0 但 genesis=violated', () => {
  const dir = tempRepo({
    'src/violating.ts': "import { keyboard } from '@nut-tree/nut-js';\nexport const k = keyboard;\n",
  });
  try {
    const r = runDoctorCli(dir, ['--frobnicate']); // 未知旗标：被忽略不炸
    assert.equal(r.status, 0, 'exit 1 是 --strict 专属 —— 缺席时违规只报告不拦截');
    assert.match(r.stdout, /genesis=violated/);
    assert.match(r.stdout, /genesis\.io-mutex/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ═══ ⑤ 入口壳源级锁定 ═══

test('W6R-cli⑤: 入口壳接线源级锁定 —— argv 透传 + .then(exit) + .catch(exit 2)', () => {
  const src = readFileSync(CLI_PATH, 'utf8');
  assert.match(src, /runDoctorCli\(process\.argv\.slice\(2\)\)/, 'argv 剥进程名后透传');
  assert.match(src, /\.then\(code => process\.exit\(code\)\)/, '退出码直通');
  assert.match(src, /\.catch/, 'J 纪元修正：意外 reject 必须被捕获');
  assert.match(src, /process\.exit\(2\)/, '意外失败语义化为 exit 2（不崩成 unhandledRejection）');
});

// ═══ ⑥ 纯函数面：摘要铸造 ═══

test('W6R-cli⑥: formatDoctorSummary —— 新形状双行；老报告形状不伪造 exemptions 行', () => {
  const base = {
    timestamp: 1, incremental: false, score: 87.5, genesisVerdict: 'intact' as const,
    findings: [
      { severity: 'critical' as const }, { severity: 'minor' as const }, { severity: 'minor' as const },
    ],
    byCategory: { genesis: 0, smell: 2, security: 1, chain: 0 },
    effectiveWeights: {}, trend: null, warnings: [], scannedFiles: 42, chainAudited: true,
  };
  const withEx = formatDoctorSummary({ ...base, exemptions: { registered: 21, applied: 3 } } as unknown as DiagnosisReport);
  assert.equal(withEx.split('\n').length, 2, '有豁免统计 ⇒ 双行');
  assert.equal(withEx.split('\n')[0],
    '[Doctor] score=87.5 genesis=intact findings=3 files=42 (critical/major/minor/info = 1/0/2/0)',
    '四级计数按 severity 分桶');
  assert.match(withEx.split('\n')[1]!, /^\[Doctor\] exemptions: 3\/21 /);
  const legacy = formatDoctorSummary(base as unknown as DiagnosisReport);
  assert.equal(legacy, withEx.split('\n')[0], '老报告形状（无 exemptions 键）⇒ 单行首行，不伪造统计');
});
