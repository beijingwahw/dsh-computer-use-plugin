// test/w6r.doctor.test.ts
// W6R-B9 安全不变量守护的执法测试：每条新规则喂「违规 / 干净」双面合成证据，
// 再以真实源码树作金丝雀（当前代码库必须零命中 —— 回改即报警）。
// 医生对医生的测试：完美的评分若来自未执行的规则，那是谎言，不是健康。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { doctor, DOCTOR_RULES } from '../src/qualityDoctor.ts';
import type { ScanContext, DoctorConfig } from '../src/qualityDoctor.ts';
import type { Config } from '../src/config.ts';

const REAL_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const REAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function makeFixture(): { root: string; cfg: DoctorConfig } {
  const root = mkdtempSync(join(tmpdir(), 'w6rdoc-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  const cfg = { sourceRoot: join(root, 'src'), memoryPath: join(root, 'doctor-memory.json'), strict: false };
  return { root, cfg };
}

function put(root: string, rel: string, content: string): void {
  const full = join(root, 'src', rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function ctxOf(sources: Array<{ path: string; content: string }>,
               warnings: string[] = []): ScanContext {
  return {
    sources,
    chain: { entries: [], chainIntact: true },
    snapshot: null,
    config: {} as Config,
    warn: (m: string) => warnings.push(m),
  };
}

const R = (id: string) => DOCTOR_RULES.find(r => r.id === id)!;

beforeEach(() => {
  doctor.resetMemory();
  doctor.resetConfig();
});

// ─── a1：审批 fail-closed（confirmCodeHash 缺席必须 return 拒绝） ───

const APPROVAL_CLEAN = [
  'const pending = new Map();',
  'export const approval = {',
  '  grantDetailed(token: string, g: boolean): any {',
  '    const pa = pending.get(token);',
  '    if (pa.confirmCodeHash === undefined) {',
  "      return { ok: false, reason: 'confirm-channel-absent' };",
  '    }',
  '    if (g) { pa.granted = true; }',
  '    return { ok: true };',
  '  },',
  '};',
].join('\n');

test('W6R 规则 sec.approval-fail-closed：守卫在场且紧随 return 拒绝 = 干净；缺守卫/穿堂而过 = critical', async () => {
  assert.equal((await R('sec.approval-fail-closed').scan(ctxOf([
    { path: 'approval.ts', content: APPROVAL_CLEAN }]))).length, 0, '现行修复形状必须零命中');

  // 缺守卫：无码降级路径回归（fail-open）
  const noGuard = APPROVAL_CLEAN.replace(/if \(pa\.confirmCodeHash === undefined\) \{\n[^\n]*\n\s*\}\n/, '');
  assert.ok(!/confirmCodeHash === undefined/.test(noGuard), '夹具自检：守卫确已移除');
  const out1 = await R('sec.approval-fail-closed').scan(ctxOf([{ path: 'approval.ts', content: noGuard }]));
  assert.equal(out1.length, 1);
  assert.equal(out1[0].severity, 'critical');
  assert.match(out1[0].evidence, /guard is gone/);

  // 守卫在场但不拒绝（穿堂而过）—— W6R 修复被放松
  const fallThrough = APPROVAL_CLEAN.replace(
    "      return { ok: false, reason: 'confirm-channel-absent' };",
    '      pa.degraded = true;');
  const out2 = await R('sec.approval-fail-closed').scan(ctxOf([{ path: 'approval.ts', content: fallThrough }]));
  assert.equal(out2.length, 1);
  assert.match(out2[0].evidence, /does not immediately return/);
});

// ─── a2：确认码带外纪律（console 不得输出明文 confirmCode） ───

test('W6R 规则 sec.confirm-code-oob-leak：console 明文码 = critical；哈希/注释/事件总线放行', async () => {
  const src = [
    "console.log('your code:', d.confirmCode);",                        // 违规：明文码进 console
    "console.log('token hash:', pa.confirmCodeHash);",                  // 合法：哈希不是明文
    "// console.log('code', d.confirmCode); — 历史记载，非代码",        // 合法：注释行
    "emit('approval/confirm-code', { confirmCode: d.confirmCode });",   // 合法：事件总线是唯一携码通道
    "console.warn('确认码已投递(6位)', { token: d.token });",           // 合法：脱敏回执
  ].join('\n');
  const out = await R('sec.confirm-code-oob-leak').scan(ctxOf([{ path: 'doctorChannel.ts', content: src }]));
  assert.equal(out.length, 1);
  assert.equal(out[0].location.line, 1);
  assert.equal(out[0].severity, 'critical');
});

// ─── b1：shell 启动纪律（system.ts 禁 cmd.exe /c start） ───

test('W6R 规则 sec.shell-launch-cmd：cmd.exe/「/c+start」/spawn 携 cmd = critical；mac 修饰键与 rundll32 放行', async () => {
  const bad = [
    "spawn('cmd.exe', ['/c', 'start', '', url]);",                      // 违规：壳层通道整体回归
    "launch('cmd', ['/c', 'start', url]);",                             // 违规：裸 cmd 同罪（spawn 语义注入）
  ].join('\n');
  const out = await R('sec.shell-launch-cmd').scan(ctxOf([{ path: 'system.ts', content: bad }]));
  assert.equal(out.length, 2);
  assert.ok(out.every(f => f.severity === 'critical'));

  const ok = [
    "const launch = openUrlSpawnOverride ?? (spawn as unknown as SpawnLike);",
    "const child = launch('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' });",
    "const fb = launch('explorer.exe', [url], { detached: true, stdio: 'ignore' });",
    "const modKey = await _getKey(isMac ? 'cmd' : 'ctrl');",            // mac 修饰键：非 shell 上下文
    "// W6R-A8 shell 启动面加固：弃 cmd.exe /c start。",               // 注释里的修复记载
  ].join('\n');
  assert.equal((await R('sec.shell-launch-cmd').scan(ctxOf([{ path: 'system.ts', content: ok }]))).length, 0);
});

// ─── b2：PS 启动纪律（-EncodedCommand 必在，-Command 必不在） ───

test('W6R 规则 sec.ps-encoded-command：-Command 字面量 / 加固整体消失 = critical', async () => {
  const bad = "const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-Command'];\n";
  const out1 = await R('sec.ps-encoded-command').scan(ctxOf([
    { path: 'environmentShaper.ts', content: bad }]));
  assert.equal(out1.length, 1);
  assert.match(out1[0].evidence, /-Command/);

  // 加固整体消失（两者皆无）—— 同样报警
  const gone = "const PS_FLAGS = ['-NoProfile'];\n";
  const out2 = await R('sec.ps-encoded-command').scan(ctxOf([
    { path: 'environmentShaper.ts', content: gone }]));
  assert.equal(out2.length, 1);
  assert.match(out2[0].evidence, /removed entirely/);

  const ok = [
    "// W6R-A8 shell 启动面加固：-Command → -EncodedCommand（历史记载）",
    "const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-EncodedCommand'];",
    'export function psEncodeCommand(script: string): string {',
    "  return Buffer.from(String(script), 'utf16le').toString('base64');",
    '}',
  ].join('\n');
  assert.equal((await R('sec.ps-encoded-command').scan(ctxOf([
    { path: 'environmentShaper.ts', content: ok }]))).length, 0);
});

// ─── c：依赖归类守护（package.json 读 JSON 验证） ───

test('W6R 规则 sec.runtime-deps：sharp/tesseract.js 须在 dependencies；进 dev/缺席 = major', async () => {
  const pkg = (deps: object, dev: object): string =>
    JSON.stringify({ name: 'x', dependencies: deps, devDependencies: dev });
  // 误归类：sharp 滑进 devDependencies、tesseract.js 缺席 ⇒ 两条 finding
  const out = await R('sec.runtime-deps').scan(ctxOf([
    { path: 'package.json', content: pkg({ undici: '^8' }, { sharp: '^0.35' }) }]));
  assert.equal(out.length, 2);
  assert.ok(out.every(f => f.severity === 'major'));
  assert.match(out.find(f => f.location.snippet.includes('sharp'))!.location.snippet, /devDependencies/);
  assert.match(out.find(f => f.location.snippet.includes('tesseract'))!.location.snippet, /absent/);

  assert.equal((await R('sec.runtime-deps').scan(ctxOf([
    { path: 'package.json', content: pkg({ sharp: '^0.35', 'tesseract.js': '^7' }, {}) }]))).length, 0);

  // 磁盘兜底：空 sources ⇒ 回退读真实仓库 package.json（当前归类正确）
  const warn: string[] = [];
  assert.equal((await R('sec.runtime-deps').scan(ctxOf([], warn))).length, 0);
  assert.equal(warn.length, 0, '真实 package.json 必须可读（warn 空）');
});

// ─── d：android 转义纪律（type_text 必经 shlex.quote） ───

const ANDROID_REL = 'python_service/dsh_physical/android.py';

test('W6R 规则 sec.android-shell-escape：shlex.quote 缺席 = critical；docstring 描述不算实现', async () => {
  const clean = [
    'import shlex',
    '',
    'class AndroidController:',
    '    def type_text(self, serial, text, dry_run=False):',
    '        """文本注入 —— 整串经 shlex.quote 单引号包裹。"""',
    '        if text:',
    '            escaped = shlex.quote(text.replace(" ", "%s"))',
    '            self._shell(serial, "text", escaped)',
    '        return {"typed_chars": len(text)}',
    '',
    '    def key(self, serial, keys):',
    '        pass',
  ].join('\n');
  assert.equal((await R('sec.android-shell-escape').scan(ctxOf([
    { path: ANDROID_REL, content: clean }]))).length, 0, '转义在场 = 干净');

  // 实现被删、docstring 还在吹 —— 必须报警（文档不是实现）
  const implGone = clean.replace('            escaped = shlex.quote(text.replace(" ", "%s"))\n', '')
    .replace('            self._shell(serial, "text", escaped)', '            self._shell(serial, "text", text)');
  const out1 = await R('sec.android-shell-escape').scan(ctxOf([{ path: ANDROID_REL, content: implGone }]));
  assert.equal(out1.length, 1);
  assert.equal(out1[0].severity, 'critical');
  assert.match(out1[0].evidence, /shlex\.quote call missing/);

  // import 被删（转义整体退场）
  const noImport = clean.replace('import shlex\n', '');
  const out2 = await R('sec.android-shell-escape').scan(ctxOf([{ path: ANDROID_REL, content: noImport }]));
  assert.equal(out2.length, 1);
  assert.match(out2[0].evidence, /import shlex missing/);

  // 磁盘兜底：空 sources ⇒ 回退读真实 android.py（当前转义在场）
  const warn: string[] = [];
  assert.equal((await R('sec.android-shell-escape').scan(ctxOf([], warn))).length, 0);
  assert.equal(warn.length, 0);
});

// ─── e：审计 WAL 下限守护（MUTATING_TOOL_NAMES ≥18） ───
// ΑΩ-R28 锚点同步：名单已迁 tools/index.ts（单源导出）—— 夹具随之换形换径，
// 检测语义（回缩/消失报警、满额干净）不变。

const auditSrc = (tools: string[]): string =>
  `import type { ToolDefinition } from '@deepseek-ai/dsh-tools';\nexport const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([\n${tools.map(t => `  '${t}',`).join('\n')}\n]);\n`;

test('W6R 规则 sec.audit-wal-floor：名单回缩到下限之下/宣言消失 = major；满额干净', async () => {
  const names = Array.from({ length: 18 }, (_, i): string =>
    ['click_mouse', 'click_element', 'drag_mouse', 'scroll_page', 'type_text', 'press_hotkey',
      'switch_tab', 'switch_window', 'open_url', 'replay_actions', 'run_skill', 'shape_environment',
      'autonomous_run', 'autonomy_resume', 'save_skill', 'save_checkpoint', 'switch_vision_model', 'vlm_wizard'][i]);
  assert.equal(names.length, 18, '夹具自检：满额 18 件');
  assert.equal((await R('sec.audit-wal-floor').scan(ctxOf([
    { path: 'tools/index.ts', content: auditSrc(names) }]))).length, 0);

  const shrunk = await R('sec.audit-wal-floor').scan(ctxOf([
    { path: 'tools/index.ts', content: auditSrc(names.slice(0, 17)) }]));
  assert.equal(shrunk.length, 1);
  assert.equal(shrunk[0].severity, 'major');
  assert.match(shrunk[0].evidence, /17 mutating tools/);

  const gone = await R('sec.audit-wal-floor').scan(ctxOf([
    { path: 'tools/index.ts', content: "export function buildAllTools() { return []; }\n" }]));
  assert.equal(gone.length, 1);
  assert.match(gone[0].evidence, /declaration is gone/);
});

// ─── 注册表形状：新规则入册、计数、severity 立法 ───

test('W6R 注册表：新增安全不变量规则入册（20 条），全部 security 类且不在豁免语法域', () => {
  const ids = ['sec.approval-fail-closed', 'sec.confirm-code-oob-leak', 'sec.shell-launch-cmd',
    'sec.ps-encoded-command', 'sec.runtime-deps', 'sec.android-shell-escape', 'sec.audit-wal-floor'];
  for (const id of ids) {
    const rule = R(id);
    assert.ok(rule, `${id} 必须在册`);
    assert.equal(rule.category, 'security');
    assert.ok(rule.severity === 'critical' || rule.severity === 'major');
  }
  // ΑΝΒ-4 行为更新（D5 缺席披露）：config.silent-tool-absence 增补 —— 计数 21 → 22
  assert.equal(DOCTOR_RULES.length, 22, '13 条既有 + 7 条 W6R 安全不变量 + ΠΑΝ-116 chain.wal-tampered（F2-1 移交项⑤）+ ΑΝΒ-4 config.silent-tool-absence');
  // 豁免语法域立法（W7-1 先例）：critical/major 规则绝不可被 over-engineering 豁免降级
  for (const id of ids) assert.notEqual(R(id).id, 'smell.over-engineering');
});

// ─── 真实源码树金丝雀：W6R 修复在位 ⇒ 七条规则全零命中 ───

test('W6R 金丝雀：真实源码树上七条安全不变量规则零命中（回改即报警）', async () => {
  // W8-B3 拆分同步：grantDetailed 落点已迁至 approval.ledger.ts（approval.ts
  // 降为桶文件）—— 金丝雀源清单随之补入主账本文件，断言零变化。
  // ΑΩ-R28 锚点同步：sec.audit-wal-floor 的名单锚点已随单源迁至 tools/index.ts
//（MUTATING_TOOL_NAMES）—— 清单补入工具装配桶；guards/auditGuard.ts 保留
//（sec.confirm-code-oob-leak 全源扫描面不变）。
  const sources = [
    'approval.ts', 'approval.ledger.ts', 'doctorChannel.ts', 'system.ts', 'environmentShaper.ts', 'config.ts',
    'qualityDoctor.ts', 'guards/auditGuard.ts', 'tools/index.ts',
  ].map(p => ({ path: p, content: readFileSync(join(REAL_SRC, p), 'utf8') }));
  const ctx = ctxOf(sources);
  for (const id of ['sec.approval-fail-closed', 'sec.confirm-code-oob-leak', 'sec.shell-launch-cmd',
    'sec.ps-encoded-command', 'sec.runtime-deps', 'sec.android-shell-escape', 'sec.audit-wal-floor']) {
    assert.equal((await R(id).scan(ctx)).length, 0, `${id} 对当前修复后的源码必须零命中`);
  }
  // c/d 两条的磁盘兜底路径同样指向真实工件（REPO_ROOT 锚点有效性）
  assert.ok(readFileSync(join(REAL_ROOT, 'package.json'), 'utf8').includes('"sharp"'));
});

// ─── 引擎面：安全不变量违规进全量诊断（扣分 + security 类计数 + 报告落盘） ───

test('W6R 引擎：审批 fail-open 回归被全量诊断捕获，security 扣分可观测', async () => {
  const { root, cfg } = makeFixture();
  // fail-open 形状：守卫在场却穿堂而过（degraded 令牌照样 grant）
  put(root, 'approval.ts', [
    'const pending = new Map();',
    'export const approval = {',
    '  grantDetailed(token: string, g: boolean): any {',
    '    const pa = pending.get(token);',
    '    if (pa.confirmCodeHash === undefined) { pa.degraded = true; }',
    '    if (g) { pa.granted = true; }',
    '    return { ok: true };',
    '  },',
    '};',
  ].join('\n'));
  await doctor.configure(cfg);

  const r = await doctor.diagnose();
  const hit = r.findings.find(f => f.ruleId === 'sec.approval-fail-closed')!;
  assert.ok(hit, 'fail-open 回归必须被全量诊断捕获');
  assert.equal(hit.severity, 'critical');
  assert.equal(hit.riskLevel, 'structural', '安全修复只提案不自动手术');
  assert.equal(r.byCategory.security, 1);
  assert.equal(r.genesisVerdict, 'intact', 'security 类违规不动 genesis 一票否决面');
  assert.equal(r.score, 50, 'critical(25) × baseWeight(2) = 50 扣分（无记忆教训时恰为 50）');
  assert.ok(r.findings.every(f => f.exempted === undefined), '安全规则永不受豁免降级');

  rmSync(root, { recursive: true, force: true });
});
