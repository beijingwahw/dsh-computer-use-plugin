// test/doctor.test.ts
// D-4 质量医生回归测试：规则抗体 / 加权进化记忆 / 权限真值表 / 基线纪律 / 自检覆盖。
// 医生对医生的测试：完美的评分若来自未执行的规则，那是谎言，不是健康。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { doctor, DOCTOR_RULES, doctorSourceCacheStats, resetDoctorSourceCache } from '../src/qualityDoctor.ts';
import type { ScanContext, DoctorConfig } from '../src/qualityDoctor.ts';
import type { JournalEntry } from '../src/journal.ts';
import type { Config } from '../src/config.ts';

function makeFixture(): { root: string; cfg: DoctorConfig } {
  const root = mkdtempSync(join(tmpdir(), 'doctor-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  const cfg = {
    sourceRoot: join(root, 'src'),
    memoryPath: join(root, 'doctor-memory.json'),
    strict: false,
  };
  return { root, cfg };
}

function put(root: string, rel: string, content: string): void {
  const full = join(root, 'src', rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

const CLEAN = `
export function ok(x: number): boolean {
  try { return x > 0; } catch (e) { /* probe failure is fine */ }
  return false;
}
`;

beforeEach(() => {
  doctor.resetMemory();
  doctor.resetConfig();
  resetDoctorSourceCache(); // ΝΩ-22：源码缓存簿记每用例归零
});

// ─── 规则抗体（单规则单元测试，喂合成证据） ───

function ctxOf(sources: Array<{ path: string; content: string }>,
               entries: JournalEntry[] = [],
               snapshot: any = null): ScanContext {
  return {
    sources,
    chain: { entries, chainIntact: true },
    snapshot,
    config: {} as Config,
    warn: () => {},
  };
}

const R = (id: string) => DOCTOR_RULES.find(r => r.id === id)!;

test('D-4 规则: genesis.io-mutex —— system.ts 外导入 nut-js 即穿孔', async () => {
  const rogue = `import { mouse } from '@nut-tree/nut-js';\nexport const m = mouse;\n`;
  const ok = await R('genesis.io-mutex').scan(ctxOf([
    { path: 'system.ts', content: rogue },
    { path: 'tools/rogue.ts', content: rogue },
  ]));
  assert.equal(ok.length, 1);
  assert.equal(ok[0].location.file, 'tools/rogue.ts');
  assert.equal(ok[0].location.line, 1);
  assert.equal(ok[0].severity, 'critical');
});

test('D-4 规则: smell.empty-catch —— 空块违规，注释豁免，多行空块同样违规', async () => {
  const src = [
    'try { a(); } catch (e) {}',
    'try { b(); } catch (e) { /* deliberate */ }',
    'try { c(); }',
    'catch (err) {',
    '}',
    'try { d(); } catch (e) {',
    '  // documented skip',
    '}',
  ].join('\n');
  const out = await R('smell.empty-catch').scan(ctxOf([{ path: 'x.ts', content: src }]));
  assert.equal(out.length, 2);
  assert.ok(out.every(f => f.riskLevel === 'mechanical'));
  assert.equal(out[0].location.line, 1);
  assert.equal(out[1].location.line, 4);
});

test('D-4 规则: sec.exec-concat —— 未消毒插值违规，Math.round 豁免', async () => {
  const src = [
    "import { execFile } from 'child_process';",
    'execFile("wmctrl", ["-e", `0,${cfg.x},${cfg.y}`]);',
    'execFile("wmctrl", ["-e", `0,${Math.round(cfg.x)},${Math.round(cfg.y)}`]);',
  ].join('\n');
  const out = await R('sec.exec-concat').scan(ctxOf([{ path: 'a.ts', content: src }]));
  assert.equal(out.length, 1);
  assert.equal(out[0].location.line, 2);
});

test('D-4 规则: smell.magic-number —— 两位数比较违规，doctor-exempt 豁免', async () => {
  const src = [
    'if (status === 404) retry();',
    'if (n >= 50) slow(); // doctor-exempt: protocol constant',
    'if (rate > 0.5) ok();',
    'if (x > 5) ok();',
  ].join('\n');
  const out = await R('smell.magic-number').scan(ctxOf([{ path: 'm.ts', content: src }]));
  assert.equal(out.length, 1);
  assert.equal(out[0].location.line, 1);
});

test('D-4 规则: chain.sense-legality —— 无失败证据的降级 = simulated rescue', async () => {
  const shift = (to: string): JournalEntry =>
    ({ ts: 1, tool: 'SENSE_SHIFT', args: { to }, status: 'MARKER' });
  const fail: JournalEntry =
    ({ ts: 2, tool: 'click_mouse', args: {}, status: 'FAILED', effect_detected: false });
  const out = await R('chain.sense-legality').scan(ctxOf([], [
    shift('superposition'),                       // 0 先行失败 → 违规
    fail, fail, fail, shift('superposition'),     // 3 失败后 → 合法
  ]));
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'critical');
});

test('D-4 规则: chain.agent-pairing / shaper-parity / marker-purity', async () => {
  const begin: JournalEntry = { ts: 1, tool: 'AGENT_BEGIN', args: { taskId: 'scout-1' }, status: 'MARKER' };
  const end: JournalEntry = { ts: 2, tool: 'AGENT_END', args: { taskId: 'scout-1' }, status: 'MARKER' };
  const orphan: JournalEntry = { ts: 3, tool: 'AGENT_BEGIN', args: { taskId: 'scout-2' }, status: 'MARKER' };
  assert.equal((await R('chain.agent-pairing').scan(ctxOf([], [begin, end, orphan]))).length, 1);
  assert.equal((await R('chain.agent-pairing').scan(ctxOf([], [begin, end]))).length, 0);

  const snap = { version: 3, shaper: { undoLog: [{ token: 'undo-1', undone: false }] } };
  const shaped: JournalEntry = { ts: 1, tool: 'ENV_SHAPED', args: { action: 'maximize_window' }, status: 'MARKER' };
  assert.equal((await R('chain.shaper-parity').scan(ctxOf([], [shaped], snap))).length, 0);
  assert.equal((await R('chain.shaper-parity').scan(ctxOf([], [], snap))).length, 1);

  const impure: JournalEntry = { ts: 1, tool: 'ENV_SHAPED', args: {}, status: 'SUCCESS' };
  assert.equal((await R('chain.marker-purity').scan(ctxOf([], [impure]))).length, 1);
});

test('D-4 规则: genesis.premature-impl / token-leak / hardcoded-secret / over-engineering', async () => {
  const shaper = 'class WindowsAdapter {\n  constructor() { execFile("powershell", []); }\n}\nexport class NullAdapter {}\n';
  assert.equal((await R('genesis.premature-impl').scan(ctxOf([
    { path: 'environmentShaper.ts', content: shaper }]))).length, 1);

  const leak = 'const s = JSON.stringify({ raw: quantumOverlays });\n';
  assert.equal((await R('genesis.token-leak').scan(ctxOf([
    { path: 'tools/x.ts', content: leak }]))).length, 1);
  const countOnly = 'const s = `overlay count: ${overlays.length}`;\n';
  assert.equal((await R('genesis.token-leak').scan(ctxOf([
    { path: 'tools/x.ts', content: countOnly }]))).length, 0);

  const secret = "const password = 'super-secret-123';\n";
  assert.equal((await R('sec.hardcoded-secret').scan(ctxOf([
    { path: 'auth.ts', content: secret }]))).length, 1);

  const big = Array.from({ length: 502 }, (_, i) => `// line ${i}`).join('\n');
  assert.equal((await R('smell.over-engineering').scan(ctxOf([
    { path: 'big.ts', content: big }]))).length, 1);
});

// ─── 引擎：装配 / 诊断 / 记忆 / 基线 ───

test('D-4 装配: 非法配置 throw（开发时响亮），诊断永不抛错（运行时坚韧）', async () => {
  const { root, cfg } = makeFixture();
  await assert.rejects(() => doctor.configure({ ...cfg, sourceRoot: '/nonexistent-xyz' }));
  await assert.rejects(() => doctor.configure({ ...cfg, rules: ['no.such-rule'] }));
  await assert.rejects(() => doctor.configure({ ...cfg, rules: [], tags: ['nonexistent-tag'] }));
  const report = await doctor.diagnose(); // 未配置 → 空报告 + warning，不抛错
  assert.equal(report.score, 100);
  assert.ok(report.warnings.length > 0);
  assert.equal(report.scannedFiles, 0);

  rmSync(root, { recursive: true, force: true });
});

test('D-4 诊断: 全量出诊发现病灶，铁律一票否决，报告与记忆落盘', async () => {
  const { root, cfg } = makeFixture();
  put(root, 'system.ts', 'export const a = 1;');
  put(root, 'rogue.ts', "import { mouse } from '@nut-tree/nut-js';\n");
  put(root, 'clean.ts', CLEAN);
  await doctor.configure(cfg);

  const r = await doctor.diagnose();
  assert.ok(r.findings.some(f => f.ruleId === 'genesis.io-mutex'));
  assert.equal(r.genesisVerdict, 'violated');
  assert.ok(r.score < 100);
  assert.ok(r.scannedFiles >= 3);
  assert.ok(r.trend === null, '首次诊断无趋势');

  assert.ok(existsSync(doctor.reportPath()!), '报告必须落盘');
  const onDisk = JSON.parse(readFileSync(doctor.reportPath()!, 'utf8'));
  assert.equal(onDisk.genesisVerdict, 'violated');
  const mem = JSON.parse(readFileSync(cfg.memoryPath, 'utf8'));
  assert.equal(mem.totalDiagnoses, 1);
  assert.ok(mem.lastReport.hitRules.includes('genesis.io-mutex'));

  rmSync(root, { recursive: true, force: true });
});

test('D-4 基线纪律: 增量不更新基线、无趋势；全量才有趋势与痊愈清单', async () => {
  const { root, cfg } = makeFixture();
  put(root, 'bad.ts', 'try { a(); } catch (e) {}\n');
  await doctor.configure(cfg);
  await doctor.diagnose();

  // 增量验证另一个文件：不更新基线
  put(root, 'other.ts', CLEAN);
  const inc = await doctor.diagnose({ files: ['other.ts'] });
  assert.equal(inc.incremental, true);
  assert.equal(inc.trend, null);
  assert.equal(inc.findings.length, 0);
  let mem = doctor.memory();
  assert.ok(mem.lastReport!.hitRules.includes('smell.empty-catch'), '基线仍是全量结果');

  // 修复文件后全量诊断：痊愈规则进入 removedRulesHit
  put(root, 'bad.ts', 'try { a(); } catch (e) { /* ok */ }\n');
  const full = await doctor.diagnose();
  assert.equal(full.incremental, false);
  assert.ok(full.trend !== null);
  assert.ok(full.trend.scoreDelta > 0);
  assert.ok(full.trend.removedRulesHit.includes('smell.empty-catch'));

  rmSync(root, { recursive: true, force: true });
});

test('D-4 进化记忆: 教训加权封顶 3x，快照深拷贝防篡改', async () => {
  const { cfg } = makeFixture();
  await doctor.configure(cfg);
  const base = doctor.effectiveWeight('genesis.io-mutex');
  assert.equal(base, 2); // baseWeight，无教训
  for (let i = 0; i < 20; i++) doctor.recordLesson('genesis.io-mutex', `lesson ${i}`);
  assert.equal(doctor.effectiveWeight('genesis.io-mutex'), 6); // 2 × 3 封顶
  const rule = DOCTOR_RULES.find(r => r.id === 'genesis.io-mutex')!;
  assert.equal(rule.baseWeight, 2, '规则注册表永不被记忆反向修改');

  const snap = doctor.memory() as any;
  snap.lessons.push({ ruleId: 'forged' });
  assert.equal((doctor.memory() as any).lessons.length, 1, '快照篡改不触达内部');

  doctor.recordLesson('no.such-rule', 'x'); // 未知规则：忽略不炸
  rmSync(cfg.memoryPath, { force: true });
});

// ─── heal：权限真值表与过期保护 ───

test('D-4 heal 真值表: none=终点；未授权/dryRun=仅提案；授权=机械修复写盘', async () => {
  const { root, cfg } = makeFixture();
  put(root, 'fixme.ts', 'try { load(); } catch (e) {}\n');
  await doctor.configure(cfg);
  const report = await doctor.diagnose();
  const fixId = report.findings.find(f => f.ruleId === 'smell.empty-catch')!.id;

  const none = await doctor.heal(report, { maxRisk: 'none', authorized: true, dryRun: false });
  assert.equal(none.applied.length + none.proposed.length, 0);

  const preview = await doctor.heal(report, { maxRisk: 'mechanical', authorized: true, dryRun: true });
  assert.equal(preview.applied.length, 0);
  assert.ok(preview.proposed.some(p => p.findingId === fixId));
  assert.equal(readFileSync(join(root, 'src', 'fixme.ts'), 'utf8').includes('FIXME'), false);

  const unauth = await doctor.heal(report, { maxRisk: 'mechanical', authorized: false, dryRun: false });
  assert.equal(unauth.applied.length, 0);

  const applied = await doctor.heal(report, { maxRisk: 'mechanical', authorized: true, dryRun: false });
  assert.equal(applied.applied.length, 1);
  const healed = readFileSync(join(root, 'src', 'fixme.ts'), 'utf8');
  assert.ok(healed.includes('FIXME(doctor)'), '空 catch 被注释化');
  assert.equal(doctor.memory().totalFixesApplied, 1, '仅真实写盘计数');

  rmSync(root, { recursive: true, force: true });
});

test('D-4 heal 过期保护: 诊断后文件被改，补丁拒绝而非误改', async () => {
  const { root, cfg } = makeFixture();
  put(root, 'drift.ts', 'try { a(); } catch (e) {}\n');
  await doctor.configure(cfg);
  const report = await doctor.diagnose();

  put(root, 'drift.ts', 'try { changed(); } catch (e) {}\n'); // 行内容漂移
  const res = await doctor.heal(report, { maxRisk: 'mechanical', authorized: true, dryRun: false });
  assert.equal(res.applied.length, 0);
  assert.equal(res.rejected.length, 1);
  assert.match(res.rejected[0].reason, /patch expired/);

  rmSync(root, { recursive: true, force: true });
});

// ─── 自检：免疫盲区探测 ───

test('D-4 auditSelf: 六条铁律全覆盖；过滤过激立即暴露盲区', async () => {
  const { cfg } = makeFixture();
  await doctor.configure(cfg);
  const audit = doctor.auditSelf();
  assert.equal(audit.ruleCount, DOCTOR_RULES.length);
  assert.deepEqual(audit.missingLaws, []);
  assert.equal(audit.configValid, true);

  // 只留一条规则 → 其余铁律失明（auditSelf 诚实暴露）
  await doctor.configure({ ...cfg, rules: ['smell.empty-catch'] });
  const blind = doctor.auditSelf();
  assert.ok(blind.missingLaws.includes('io-serialization'));
  assert.ok(blind.coveredLaws.includes('honest-degradation'));

  rmSync(cfg.memoryPath, { force: true });
});

test('D-4 金丝雀: 手术锁守卫存在于 heal 写盘路径（规则对医生自身生效）', async () => {
  const self = readFileSync(new URL('../src/qualityDoctor.ts', import.meta.url), 'utf8');
  assert.match(self, /riskLevel\s*!==\s*'mechanical'/);
  const out = await R('genesis.zero-intrusion-guard').scan(ctxOf([
    { path: 'qualityDoctor.ts', content: self }]));
  assert.equal(out.length, 0);
});

// ─── ΝΩ-22（热路径 IO 放大④）：walkSource mtime 缓存执法册 ───

test('ΝΩ-22 mtime 缓存：未变文件零重读；变更文件恰重读；缓存键含绝对路径（跨根不串档）', async () => {
  const { root, cfg } = makeFixture();
  put(root, 'a.ts', 'try { a(); } catch (e) {}\n');
  put(root, 'b.ts', CLEAN);
  await doctor.configure(cfg);
  await doctor.diagnose();
  const s1 = doctorSourceCacheStats();
  assert.equal(s1.misses, 2, '首诊全量读（2 文件）');
  // 二诊：文件未变 ⇒ 零重读、命中走缓存
  await doctor.diagnose();
  const s2 = doctorSourceCacheStats();
  assert.equal(s2.misses, s1.misses, '未变文件零重读');
  assert.equal(s2.hits, s1.hits + 2, '两文件全部命中缓存');
  // 变更文件（内容/长度变化 ⇒ mtime+size 键失效）⇒ 恰该文件重读，诊断吃新内容
  put(root, 'a.ts', 'try { changed(); } catch (e) { /* ok */ }\n');
  const r3 = await doctor.diagnose();
  const s3 = doctorSourceCacheStats();
  assert.equal(s3.misses, s1.misses + 1, '恰变更文件重读（b.ts 仍命中）');
  assert.equal(r3.findings.some(f => f.ruleId === 'smell.empty-catch'), false, '缓存不吐旧文（新内容生效）');
  // 另一根目录的同相对路径文件：缓存键含绝对路径 ⇒ 独立读取不串档
  const other = makeFixture();
  put(other.root, 'a.ts', 'try { z(); } catch (e) {}\n');
  await doctor.configure(other.cfg);
  const r4 = await doctor.diagnose();
  assert.equal(r4.findings.some(f => f.location.file === 'a.ts' && f.ruleId === 'smell.empty-catch'), true,
    '另一根的同名文件独立读取（未命中前根缓存）');
  rmSync(root, { recursive: true, force: true });
  rmSync(other.root, { recursive: true, force: true });
});

test('D-4 规则统计: 22 条抗体覆盖四大类目与六条铁律（13 既有 + W6R-B9 七条安全不变量 + ΠΑΝ-116 WAL 篡改检视 + ΑΝΒ-4 缺席披露）', () => {
  // ΠΑΝ-116（F2-1 移交项⑤）：chain.wal-tampered 增补 —— 计数 20 → 21
  // ΑΝΒ-4 行为更新（D5 缺席披露）：config.silent-tool-absence 增补 —— 计数 21 → 22
  assert.equal(DOCTOR_RULES.length, 22);
  const cats = new Set(DOCTOR_RULES.map(r => r.category));
  for (const c of ['genesis', 'smell', 'security', 'chain'] as const) assert.ok(cats.has(c));
  const laws = new Set(DOCTOR_RULES.flatMap(r => r.laws));
  for (const l of ['io-serialization', 'token-discipline', 'architecture-void',
    'config-driven', 'zero-intrusion', 'honest-degradation'] as const) {
    assert.ok(laws.has(l), `铁律 ${l} 必须有抗体`);
  }
});
