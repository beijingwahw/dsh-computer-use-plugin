#!/usr/bin/env node
// scripts/mutation_lint.mjs
// ΝΩ-40 零依赖 AST 变异器 MVP —— 变异分数量化测试执法力。
// 背景：87 处 grep 源码取证断言对等价重构过度杀伤、对行为变异盲区；8 处永真断言
// 零执法力。本工具在目标 .ts 上生成行为变异体，逐个写回磁盘并跑指定测试：
//   exit 0 = 存活（测试对该变异失明 —— 执法力盲区清单）；非 0 / 超时 = 击杀。
// 分数 = 击杀 / 计分变异体总数。纯函数 + 好测试应高分；只断言导出存在的弱测试应低分。
//
// 五算子（typescript 编译 API 定位，字符串切片写回 —— 不经 printer 保字节序）：
//   (a) 条件翻转 neg-flip/neg-del/cond-flip：if/while/do/for/三元条件加 `!(...)`；
//       前缀 `!` 删除；`<`↔`>=`、`>`↔`<=` 关系翻转
//   (b) 边界置换 boundary：`<`↔`<=`、`>`↔`>=`、`<=`→`<`、`>=`→`>`
//   (c) 常量替换 const：整数字面量 ±1（各一 mutant）；true/false 取反
//   (d) 语句删除 stmt：`return <expr>` → `return undefined;`；表达式语句 → `;`
//   (e) 相等替换 eq：`===`↔`!==`
//
// ΠΑΝ-87（C2-6/M-1）：等价变异治理 —— 算子登记册 + 豁免面（显式理由）：
//   · 变异算子登记册 MUTATION_OPERATORS（op → 语义描述），报告面列示 —— 算子
//     面即立法面，新增算子必须登记；
//   · 等价变异豁免面 EQUIV_EXEMPT_CLASSES：对几乎所有测试等价的变异**不计入
//     分母**（此前只滤顶层 const 查表，函数体内/对象字面量查表、时序常量、日志
//     语句删除全部稀释分数），每类带显式理由，报告列示豁免清单（豁免是可见的
//     治理决定，不是静默吞报）：
//       const-data    —— const 数组/对象字面量查表数据（任意作用域；数据非逻辑）
//       timing-const  —— setTimeout/setInterval 时序实参（1000ms→1001 对行为
//                        断言几乎处处等价；断言时序的测试自会击杀非豁免位）
//       log-stmt      —— console.* 表达式语句删除（不捕获日志的测试等价）
//   · 自检默认化：--selfcheck-weak 全程只读写**一次性沙箱探针**
//     （src/.mutation_lint_probe.tmp.ts + 弱测试临时文件，跑完即删、sha 校验），
//     绝不改真实源码 ⇒ 不再需要 MUTATION_LINT_SELFCHECK=1 独占环境变量。
//
// 运行机制：读原文件字节（Buffer 留存）→ utf8 解码 → 字符串切片生成变异源 → 写回 →
//   子进程 `node --test --import ./test/register.mjs <tests>`（cwd=项目根，timeout 120s）
//   → finally 字节级还原（写回原 Buffer）+ sha256 前后核验 + Buffer.compare 逐字节核验。
// 安全护栏：目标白名单（必须在 <root>/src/ 下且 .ts）；测试文件必须在 <root>/test/ 下；
//   SIGINT/SIGTERM/uncaughtException 先还原再退出；基线测试（未变异先跑）不过即中止。
//
// CLI：
//   node scripts/mutation_lint.mjs --target src/dialects/hashing.ts \
//     --tests test/a.test.ts,test/b.test.ts --budget 30 --seed 42 [--dry-run]
//   --tests 逗号分隔多个测试文件；--budget 预算内确定性抽样（mulberry32(seed) 洗牌）；
//   --dry-run 只列将执行的变异体，不写盘不跑测试；
//   --selfcheck-weak 自检（默认安全）：临时生成**沙箱探针目标**（src/.mutation_lint_probe.tmp.ts，
//     跑完即删）+ 只断言「模块导出存在」的假弱测试，用它当唯一测试跑分 ——
//     弱测试应得低分；探针即靶 ⇒ 无需独占环境变量，可与并行测试同跑。
// 治理面接线建议（ΠΑΝ-87：本工具不在 package.json —— 写明建议，不代改）：
//   CI/verify 追加 `node scripts/mutation_lint.mjs --selfcheck-weak`（默认安全自检）；
//   按模块定期跑分 `--target <模块> --tests <该模块测试> --budget 30` 人工审读趋势。
// 零新增依赖：node 内建 + 既有 devDependency typescript。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'src');
const TEST_DIR = path.join(ROOT, 'test');
const TEST_TIMEOUT_MS = 120_000;
const WEAK_TEST_REL = 'test/.mutation_lint_weak.tmp.ts';
// ΠΑΝ-87：自检沙箱探针（一次性目标——只断言导出的弱测试对它几乎全盲 ⇒ 低分；
// 跑完即删 + sha 校验；绝不触碰真实源码 ⇒ 自检无需独占环境变量）
const PROBE_REL = 'src/.mutation_lint_probe.tmp.ts';

// ── ΠΑΝ-87 变异算子登记册（算子面即立法面——新增算子必须在此登记并在报告列示） ──
export const MUTATION_OPERATORS = [
  { op: 'neg-flip', desc: '条件整体加 !(...)（if/while/do/for/三元）' },
  { op: 'neg-del', desc: '前缀 ! 删除（operand 加括号保优先级）' },
  { op: 'cond-flip', desc: '关系条件翻转：<↔>=、>↔<=' },
  { op: 'boundary', desc: '边界置换：<↔<=、>↔>=' },
  { op: 'const', desc: '常量替换：整数字面量 ±1；true/false 取反' },
  { op: 'stmt-ret', desc: '语句删除：return <expr> → return undefined;' },
  { op: 'stmt-del', desc: '语句删除：表达式语句 → ;' },
  { op: 'eq', desc: '相等替换：===↔!==' },
];

// ── ΠΑΝ-87 等价变异豁免面（显式理由——不计分母，报告列示；豁免是治理决定） ──
export const EQUIV_EXEMPT_CLASSES = [
  { cls: 'const-data', reason: 'const 数组/对象字面量查表数据（任意作用域）——数据非逻辑，变异对几乎所有测试等价，计入只会稀释分数' },
  { cls: 'timing-const', reason: 'setTimeout/setInterval 时序实参 ±1 —— 行为断言几乎处处不区分 1000/1001；真实时序断言自会击杀非豁免位' },
  { cls: 'log-stmt', reason: 'console.* 表达式语句删除 —— 不捕获日志输出的测试对该删除等价' },
];

// ── CLI ──
function usage(msg) {
  if (msg) console.error(`[mutation_lint] 参数错误：${msg}`);
  console.error(
    '用法：node scripts/mutation_lint.mjs --target src/xxx.ts --tests test/a.test.ts[,test/b.test.ts] ' +
    '[--budget 30] [--seed 42] [--dry-run]\n' +
    '      node scripts/mutation_lint.mjs --selfcheck-weak [--budget 12]（沙箱探针自检——默认安全，无需独占环境变量）',
  );
  process.exit(3);
}
function parseArgs(argv) {
  const out = { budget: 30, seed: 42, dryRun: false, selfcheckWeak: false, target: '', tests: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : usage(`${a} 缺值`));
    if (a === '--target') out.target = next();
    else if (a === '--tests') out.tests = next();
    else if (a === '--budget') out.budget = Number.parseInt(next(), 10);
    else if (a === '--seed') out.seed = Number.parseInt(next(), 10);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--selfcheck-weak') out.selfcheckWeak = true;
    else usage(`未知参数 ${a}`);
  }
  if (!out.target && !out.selfcheckWeak) usage('--target 必填（或用 --selfcheck-weak）');
  if (out.selfcheckWeak && out.target) usage('--selfcheck-weak 自带沙箱目标，不接受 --target');
  if (!out.tests && !out.selfcheckWeak) usage('--tests 必填（或用 --selfcheck-weak）');
  if (!Number.isInteger(out.budget) || out.budget < 1) usage('--budget 须为正整数');
  if (!Number.isInteger(out.seed)) usage('--seed 须为整数');
  return out;
}

// ── 确定性 PRNG（零依赖 mulberry32；与 src/dialects/random.ts 同族算法，本地重写避免 src 依赖）──
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 白名单 ──
function underRoot(dir, p) {
  const rel = path.relative(dir, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
function guardPaths(args) {
  const targetAbs = path.resolve(ROOT, args.target);
  if (!underRoot(SRC_DIR, targetAbs) || !/\.ts$/.test(targetAbs) || /\.d\.ts$/.test(targetAbs)) {
    usage(`目标白名单拒绝：${args.target}（只允许 src/ 下的 .ts 源文件）`);
  }
  const tests = args.tests
    ? args.tests.split(',').map((s) => s.trim()).filter(Boolean).map((p) => path.resolve(ROOT, p))
    : [];
  for (const t of tests) {
    if (!underRoot(TEST_DIR, t) || !fs.existsSync(t)) {
      usage(`测试文件不在 test/ 白名单或不存在：${t}`);
    }
  }
  if (!fs.existsSync(targetAbs)) usage(`目标文件不存在：${targetAbs}`);
  return { targetAbs, tests };
}

// ── 变异体生成（单遍 AST 行走；parent 链做静态过滤）──
/** ΠΑΝ-87 const-data 豁免定位：字面量位于 **const** 变量声明的数组/对象字面量
 *  初始化子树内（任意作用域——顶层与函数体/闭包内同律：查表数据非逻辑）。 */
function inConstDataInitializer(node) {
  let inContainer = false;
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isArrayLiteralExpression(n) || ts.isObjectLiteralExpression(n)) inContainer = true;
    if (ts.isVariableDeclaration(n)) {
      const list = n.parent;
      return inContainer && ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
    }
  }
  return false;
}
/** ΠΑΝ-87 timing-const 豁免定位：setTimeout/setInterval 的数字实参（时序常量）。 */
function isTimingConstant(node) {
  if (!ts.isNumericLiteral(node)) return false;
  const p = node.parent;
  return ts.isCallExpression(p) && ts.isIdentifier(p.expression) && /^(setTimeout|setInterval)$/.test(p.expression.text);
}
/** ΠΑΝ-87 log-stmt 豁免定位：console.* 表达式语句（日志删除）。 */
function isConsoleStatement(node) {
  if (!ts.isExpressionStatement(node)) return false;
  const e = node.expression;
  return ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) &&
    ts.isIdentifier(e.expression.expression) && e.expression.expression.text === 'console';
}
function inTypePosition(node) {
  for (let n = node.parent; n; n = n.parent) if (ts.isTypeNode(n)) return true;
  return false;
}
function conditionOf(node) {
  if (
    ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) ||
    ts.isConditionalExpression(node)
  ) {
    return node.expression;
  }
  if (ts.isForStatement(node)) return node.condition; // may be undefined
  return undefined;
}
function collectMutants(sf, text) {
  const mutants = [];
  const push = (m) => {
    if (m.replacement !== text.slice(m.start, m.end)) mutants.push(m);
  };
  const pos = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf));
  const at = (n) => {
    const { line, character } = pos(n);
    return `L${line + 1}:C${character + 1}`;
  };
  const snippetOf = (s, e) => {
    const raw = text.slice(s, e).replace(/\s+/g, ' ').trim();
    return raw.length > 48 ? `${raw.slice(0, 45)}...` : raw;
  };
  const visit = (node) => {
    // (a-1) 条件翻转：条件整体加 !
    const cond = conditionOf(node);
    if (cond && cond.kind !== ts.SyntaxKind.PrefixUnaryExpression) {
      const s = cond.getStart(sf);
      const e = cond.end;
      push({
        op: 'neg-flip', start: s, end: e, replacement: `!(${text.slice(s, e)})`,
        line: at(cond), snippet: snippetOf(s, e),
      });
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      // (a-2) 前缀 ! 删除（operand 加括号保优先级）
      const s = node.getStart(sf);
      const e = node.end;
      push({
        op: 'neg-del', start: s, end: e, replacement: `(${node.operand.getText(sf)})`,
        line: at(node), snippet: snippetOf(s, e),
      });
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken;
      const s = op.getStart(sf);
      const e = op.end;
      const kind = op.kind;
      const add = (op2, name) =>
        push({ op: name, start: s, end: e, replacement: op2, line: at(node), snippet: snippetOf(node.getStart(sf), node.end) });
      if (kind === ts.SyntaxKind.EqualsEqualsEqualsToken) add('!==', 'eq');
      else if (kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) add('===', 'eq');
      else if (kind === ts.SyntaxKind.LessThanToken) {
        add('>=', 'cond-flip');
        add('<=', 'boundary');
      } else if (kind === ts.SyntaxKind.GreaterThanToken) {
        add('<=', 'cond-flip');
        add('>=', 'boundary');
      } else if (kind === ts.SyntaxKind.LessThanEqualsToken) add('<', 'boundary');
      else if (kind === ts.SyntaxKind.GreaterThanEqualsToken) add('>', 'boundary');
    }
    if (ts.isNumericLiteral(node) && /^\d+$/.test(node.text) && !inTypePosition(node)) {
      // ΠΑΝ-87：等价变异豁免面（显式理由——const 查表数据 / 时序常量，不计分母）
      const v = Number.parseInt(node.text, 10);
      const s = node.getStart(sf);
      const e = node.end;
      const exemptCls = inConstDataInitializer(node) ? 'const-data'
        : isTimingConstant(node) ? 'timing-const' : undefined;
      for (const nv of [v - 1, v + 1]) {
        push({ op: 'const', start: s, end: e, replacement: String(nv), line: at(node), snippet: snippetOf(s, e), exemptCls });
      }
    }
    if (
      (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) &&
      !inTypePosition(node)
    ) {
      const s = node.getStart(sf);
      const e = node.end;
      push({
        op: 'const', start: s, end: e, replacement: node.kind === ts.SyntaxKind.TrueKeyword ? 'false' : 'true',
        line: at(node), snippet: snippetOf(s, e),
        // ΠΑΝ-87：布尔查表位与数字位同律
        exemptCls: inConstDataInitializer(node) ? 'const-data' : undefined,
      });
    }
    if (ts.isReturnStatement(node) && node.expression) {
      const s = node.getStart(sf);
      const e = node.end;
      push({ op: 'stmt-ret', start: s, end: e, replacement: 'return undefined;', line: at(node), snippet: snippetOf(s, e) });
    }
    if (ts.isExpressionStatement(node) && !ts.isStringLiteral(node.expression)) {
      const s = node.getStart(sf);
      const e = node.end;
      push({
        op: 'stmt-del', start: s, end: e, replacement: ';', line: at(node), snippet: snippetOf(s, e),
        // ΠΑΝ-87：console.* 语句删除 = log-stmt 等价变异（显式理由，不计分母）
        exemptCls: isConsoleStatement(node) ? 'log-stmt' : undefined,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return mutants;
}

// ── 子进程跑测试 ──
function killTree(child) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
}
function runTests(testFiles) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--test', '--import', './test/register.mjs', ...testFiles.map((p) => path.relative(ROOT, p))],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] },
    );
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      killTree(child);
      resolve({ code: null, timedOut: true });
    }, TEST_TIMEOUT_MS);
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: signal ? null : code, timedOut: false });
    });
  });
}

// ── 临时弱测试（自检轮 b：只断言导出存在 —— 零行为执法的假测试样本）──
function weakTestContent(targetRelFromRoot) {
  const rel = `../${targetRelFromRoot}`; // 弱测试落位于 test/ 下 ⇒ 上一级即项目根
  return [
    '// .mutation_lint 临时弱测试（跑完即删）：只断言模块导出存在 —— 零行为执法。',
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    `import * as mod from '${rel}';`,
    "test('weak: exports exist', () => {",
    "  assert.ok(mod && typeof mod === 'object' && Object.keys(mod).length > 0, '模块可加载且有导出');",
    '});',
    '',
  ].join('\n');
}

// ── ΠΑΝ-87 自检沙箱探针（一次性目标：真实源码零接触 ⇒ 自检无需独占环境变量）──
// 内容覆盖全部 8 算子 + 三类等价豁免位（const-data/timing-const/log-stmt）——
// 弱测试对它几乎全盲 ⇒ 期望低分；确定性内容（无时钟无随机）。
const PROBE_CONTENT = [
  '// ΠΑΝ-87 变异器自检沙箱探针（一次性——跑完即删；不属于源码面，勿 import）。',
  'export const PEG_TABLE = [3, 5, 8]; // const-data 豁免位（查表数据非逻辑）',
  'export function clamp(v: number, lo: number, hi: number): number {',
  '  if (v < lo) return lo;',
  '  if (v > hi) return hi;',
  '  return v;',
  '}',
  'export function isDone(steps: number): boolean {',
  '  return steps === 4;',
  '}',
  'export function label(n: number): string {',
  "  const t = n >= 2 ? 'multi' : 'single';",
  "  console.log('probe-label', t); // log-stmt 豁免位（日志删除）",
  '  return t;',
  '}',
  'export function retryDelay(): number {',
  '  return 500;',
  '}',
  'export function scheduleTick(): void {',
  "  setTimeout(() => void 0, 1000); // timing-const 豁免位（时序常量）",
  '}',
  '',
].join('\n');

// ── 主流程 ──
const args = parseArgs(process.argv.slice(2));

// ΠΑΝ-87：selfcheck-weak ⇒ 沙箱探针即靶（写一次性探针 + 弱测试；restore = 删除）
const selfcheckProbe = args.selfcheckWeak;
const probeAbs = path.join(ROOT, PROBE_REL);
if (selfcheckProbe) {
  fs.writeFileSync(probeAbs, PROBE_CONTENT, 'utf8');
}
const args2 = selfcheckProbe ? { ...args, target: PROBE_REL, tests: '' } : args;
const { targetAbs, tests } = guardPaths(args2);
const targetRel = path.relative(ROOT, targetAbs).split(path.sep).join('/');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const original = fs.readFileSync(targetAbs);
const originalText = original.toString('utf8');
const shaBefore = sha256(original);

let weakTestAbs = null;
if (selfcheckProbe) {
  weakTestAbs = path.join(ROOT, WEAK_TEST_REL);
  fs.writeFileSync(weakTestAbs, weakTestContent(targetRel), 'utf8');
}
const testFiles = selfcheckProbe ? [weakTestAbs] : tests;

// 还原护栏：任何退出路径（含信号/异常）都先落净 —— 沙箱探针删除、真实目标字节级写回。
let restored = false;
function restoreNow() {
  if (restored) return;
  restored = true;
  if (selfcheckProbe) {
    try { fs.unlinkSync(targetAbs); } catch { /* 不存在即已净 */ }
  } else {
    fs.writeFileSync(targetAbs, original);
  }
  if (weakTestAbs) { try { fs.unlinkSync(weakTestAbs); } catch { /* 不存在即已净 */ } }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    restoreNow();
    console.error(`[mutation_lint] 收到 ${sig} —— 已字节级还原 ${targetRel}`);
    process.exit(130);
  });
}
process.on('uncaughtException', (err) => {
  restoreNow();
  console.error('[mutation_lint] 未捕获异常 —— 已字节级还原：', err);
  process.exit(1);
});

try {
  const sf = ts.createSourceFile(targetAbs, originalText, ts.ScriptTarget.Latest, true);
  const all = collectMutants(sf, originalText);
  // ΠΑΝ-87：等价变异豁免面——豁免位不计分母（显式理由），预算只花在计分位。
  const exempted = all.filter((m) => m.exemptCls);
  const scoredPool = all.filter((m) => !m.exemptCls);
  const exemptByCls = {};
  for (const m of exempted) exemptByCls[m.exemptCls] = (exemptByCls[m.exemptCls] ?? 0) + 1;

  // 确定性抽样：seed 洗牌后取前 budget 个（计分池内）。
  const order = scoredPool.map((_, i) => i);
  const rng = mulberry32(args.seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const sampled = order.slice(0, Math.min(args.budget, scoredPool.length)).map((i) => scoredPool[i]);

  console.log(`[mutation_lint] 目标 ${targetRel}${selfcheckProbe ? '（自检沙箱探针——跑完即删）' : `（sha256 ${shaBefore.slice(0, 16)}…）`}`);
  console.log(`[mutation_lint] 候选变异体 ${all.length} 个 = 计分 ${scoredPool.length} + 等价豁免 ${exempted.length}，预算 ${args.budget}，seed ${args.seed} ⇒ 抽样 ${sampled.length} 个`);
  console.log(`[mutation_lint] 测试：${testFiles.map((p) => path.relative(ROOT, p)).join(' + ')}`);
  // ΠΑΝ-87 治理面：算子登记册 + 豁免登记面（报告可见——豁免是治理决定不是静默吞报）
  console.log(`[mutation_lint] 变异算子登记册 ${MUTATION_OPERATORS.length} 算子：${MUTATION_OPERATORS.map((o) => o.op).join('/')}`);

  if (args.dryRun) {
    sampled.forEach((m, i) => {
      console.log(`[${String(i + 1).padStart(sampled.length.toString().length)}] ${m.op.padEnd(9)} ${m.line.padEnd(9)} ${m.snippet}`);
    });
    if (exempted.length) {
      console.log(`── 等价变异豁免 ${exempted.length} 处（不计分母；逐类理由）──`);
      for (const c of EQUIV_EXEMPT_CLASSES) {
        const n = exemptByCls[c.cls] ?? 0;
        if (n > 0) console.log(`  [${c.cls}] ×${n} —— ${c.reason}`);
      }
    }
    console.log('[mutation_lint] --dry-run：未写盘、未跑测试。');
    // ΠΑΝ-87：不在此 process.exit —— finally 的清理面（探针/弱测试删除）必须执行
  } else {
    // 基线：未变异先跑 —— 测试本身不过则分数无意义，中止且零变异。
    const baseline = await runTests(testFiles);
    if (baseline.timedOut || baseline.code !== 0) {
      console.error(`[mutation_lint] 基线测试未通过（exit=${baseline.code}${baseline.timedOut ? ' TIMEOUT' : ''}）—— 中止，未做任何变异。`);
      process.exitCode = 2; // 不 process.exit：finally 清理面必须执行（ΠΑΝ-87）
    } else {
      console.log('[mutation_lint] 基线通过（exit=0），开始逐变异体执法。');

    const survivors = [];
    let killed = 0;
    let timeoutKills = 0;
    const idxWidth = String(sampled.length).length;
    for (let i = 0; i < sampled.length; i++) {
      const m = sampled[i];
      const mutated =
        originalText.slice(0, m.start) + m.replacement + originalText.slice(m.end);
      fs.writeFileSync(targetAbs, Buffer.from(mutated, 'utf8'));
      const r = await runTests(testFiles);
      const dead = r.timedOut || r.code !== 0;
      if (dead) {
        killed++;
        if (r.timedOut) timeoutKills++;
      } else {
        survivors.push(m);
      }
      const verdict = r.timedOut ? 'KILL(超时)' : dead ? 'KILL' : 'SURVIVE';
      console.log(
        `[${String(i + 1).padStart(idxWidth)}/${sampled.length}] ${verdict.padEnd(10)} ${m.op.padEnd(9)} ${m.line.padEnd(9)} ${m.snippet}`,
      );
    }

    const total = sampled.length;
    const score = total === 0 ? 0 : (killed / total) * 100;
    console.log('── 变异账（ΠΑΝ-87：豁免位不计分母）──');
    console.log(`变异体 ${total}（计分池 ${scoredPool.length}，等价豁免 ${exempted.length}）｜击杀 ${killed}（含超时击杀 ${timeoutKills}）｜存活 ${survivors.length}`);
    for (const c of EQUIV_EXEMPT_CLASSES) {
      const n = exemptByCls[c.cls] ?? 0;
      if (n > 0) console.log(`  豁免 [${c.cls}] ×${n} —— ${c.reason}`);
    }
    console.log(`执法力分数：${score.toFixed(1)}%（存活即测试盲区）`);
    if (selfcheckProbe) {
      // 自检断言语义（弱测试应低分）：分数 > 40 ⇒ 弱测试竟能杀变异 —— 机制异常
      console.log(`自检判定：弱测试分数 ${score.toFixed(1)}%（期望 ≤ 40 —— 只断言导出的测试应近乎全盲）${score > 40 ? ' ✗ 自检异常' : ' ✓'}`);
      if (score > 40) process.exitCode = 5;
    }
    if (survivors.length) {
      console.log('存活盲区清单：');
      for (const m of survivors) console.log(`  - ${m.op} ${m.line} ${m.snippet}`);
    }
    // ΠΑΝ-87 治理面：CLI 接线建议写明（本工具不在 package.json——不代改，只建议）
    console.log('治理面：不在 package.json。接线建议 —— CI/verify 追加 `node scripts/mutation_lint.mjs --selfcheck-weak`（默认安全）；按模块定期 `--target <模块> --tests <测试> --budget 30` 审读分数趋势。');
    }
  }
} finally {
  restoreNow();
  if (selfcheckProbe) {
    const gone = !fs.existsSync(probeAbs);
    console.log(`[mutation_lint] 沙箱探针清理：${gone ? 'REMOVED（一次性探针已删）' : 'FAIL（探针仍在盘上）'}`);
    if (!gone) process.exitCode = 4;
  } else {
    const afterBuf = fs.readFileSync(targetAbs);
    const shaAfter = sha256(afterBuf);
    const byteEqual = Buffer.compare(afterBuf, original) === 0;
    console.log(`[mutation_lint] 还原校验：sha256(before)=${shaBefore}`);
    console.log(`[mutation_lint] 还原校验：sha256(after) =${shaAfter} ${shaBefore === shaAfter && byteEqual ? 'RESTORE-OK（字节级一致）' : 'RESTORE-FAIL'}`);
    if (shaBefore !== shaAfter || !byteEqual) process.exitCode = 4;
  }
  if (weakTestAbs) {
    console.log(`[mutation_lint] 弱测试临时文件已删除：${fs.existsSync(weakTestAbs) ? '否（FAIL）' : '是'}`);
  }
}
