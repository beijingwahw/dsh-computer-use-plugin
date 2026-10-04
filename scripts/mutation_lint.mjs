#!/usr/bin/env node
// scripts/mutation_lint.mjs
// ΝΩ-40 零依赖 AST 变异器 MVP —— 变异分数量化测试执法力。
// 背景：87 处 grep 源码取证断言对等价重构过度杀伤、对行为变异盲区；8 处永真断言
// 零执法力。本工具在目标 .ts 上生成行为变异体，逐个写回磁盘并跑指定测试：
//   exit 0 = 存活（测试对该变异失明 —— 执法力盲区清单）；非 0 / 超时 = 击杀。
// 分数 = 击杀 / 变异体总数。纯函数 + 好测试应高分；只断言导出存在的弱测试应低分。
//
// 五算子（typescript 编译 API 定位，字符串切片写回 —— 不经 printer 保字节序）：
//   (a) 条件翻转 neg-flip/neg-del：if/while/do/for/三元条件加 `!(...)`；前缀 `!` 删除；
//       关系条件翻 `<`↔`>=`、`>`↔`<=`
//   (b) 边界置换 boundary：`<`↔`<=`、`>`↔`>=`、`<=`→`<`、`>=`→`>`
//   (c) 常量替换 const：整数字面量 ±1（各一 mutant）；true/false 取反。
//       静态过滤：顶层 const 数组查表（数据而非逻辑 —— NIBBLE_POPCOUNT 类
//       查表值对几乎所有测试都是等价变异，放进来只会稀释分数噪声）
//   (d) 语句删除 stmt：`return <expr>` → `return undefined;`；表达式语句 → `;`
//   (e) 相等替换 eq：`===`↔`!==`
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
//   --selfcheck-weak 自检模式：临时生成只断言「模块导出存在」的假弱测试（跑完删除），
//     用它当唯一测试跑分 —— 弱测试应得低分。
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

// ── CLI ──
function usage(msg) {
  if (msg) console.error(`[mutation_lint] 参数错误：${msg}`);
  console.error(
    '用法：node scripts/mutation_lint.mjs --target src/xxx.ts --tests test/a.test.ts[,test/b.test.ts] ' +
      '[--budget 30] [--seed 42] [--dry-run] [--selfcheck-weak]',
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
  if (!out.target) usage('--target 必填');
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
function inTopLevelConstArray(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isArrayLiteralExpression(n)) {
      const p = n.parent;
      return (
        ts.isVariableDeclaration(p) &&
        ts.isVariableDeclarationList(p.parent) &&
        ts.isVariableStatement(p.parent.parent) &&
        p.parent.parent.parent.kind === ts.SyntaxKind.SourceFile
      );
    }
  }
  return false;
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
    if (ts.isNumericLiteral(node) && /^\d+$/.test(node.text) && !inTopLevelConstArray(node) && !inTypePosition(node)) {
      const v = Number.parseInt(node.text, 10);
      const s = node.getStart(sf);
      const e = node.end;
      for (const nv of [v - 1, v + 1]) {
        push({ op: 'const', start: s, end: e, replacement: String(nv), line: at(node), snippet: snippetOf(s, e) });
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
      push({ op: 'stmt-del', start: s, end: e, replacement: ';', line: at(node), snippet: snippetOf(s, e) });
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

// ── 主流程 ──
const args = parseArgs(process.argv.slice(2));
const { targetAbs, tests } = guardPaths(args);
const targetRel = path.relative(ROOT, targetAbs).split(path.sep).join('/');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const original = fs.readFileSync(targetAbs);
const originalText = original.toString('utf8');
const shaBefore = sha256(original);

let weakTestAbs = null;
if (args.selfcheckWeak) {
  weakTestAbs = path.join(ROOT, WEAK_TEST_REL);
  fs.writeFileSync(weakTestAbs, weakTestContent(targetRel), 'utf8');
}
const testFiles = args.selfcheckWeak ? [weakTestAbs] : tests;

// 还原护栏：任何退出路径（含信号/异常）都先字节级写回原 Buffer。
let restored = false;
function restoreNow() {
  if (restored) return;
  restored = true;
  fs.writeFileSync(targetAbs, original);
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
  // 确定性抽样：seed 洗牌后取前 budget 个。
  const order = all.map((_, i) => i);
  const rng = mulberry32(args.seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const sampled = order.slice(0, Math.min(args.budget, all.length)).map((i) => all[i]);

  console.log(`[mutation_lint] 目标 ${targetRel}（sha256 ${shaBefore.slice(0, 16)}…）`);
  console.log(`[mutation_lint] 候选变异体 ${all.length} 个，预算 ${args.budget}，seed ${args.seed} ⇒ 抽样 ${sampled.length} 个`);
  console.log(`[mutation_lint] 测试：${testFiles.map((p) => path.relative(ROOT, p)).join(' + ')}`);

  if (args.dryRun) {
    sampled.forEach((m, i) => {
      console.log(`[${String(i + 1).padStart(sampled.length.toString().length)}] ${m.op.padEnd(9)} ${m.line.padEnd(9)} ${m.snippet}`);
    });
    console.log('[mutation_lint] --dry-run：未写盘、未跑测试。');
    process.exit(0);
  }

  // 基线：未变异先跑 —— 测试本身不过则分数无意义，中止且零变异。
  const baseline = await runTests(testFiles);
  if (baseline.timedOut || baseline.code !== 0) {
    console.error(`[mutation_lint] 基线测试未通过（exit=${baseline.code}${baseline.timedOut ? ' TIMEOUT' : ''}）—— 中止，未做任何变异。`);
    process.exit(2);
  }
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
  console.log('── 变异账 ──');
  console.log(`变异体 ${total}｜击杀 ${killed}（含超时击杀 ${timeoutKills}）｜存活 ${survivors.length}`);
  console.log(`执法力分数：${score.toFixed(1)}%（存活即测试盲区）`);
  if (survivors.length) {
    console.log('存活盲区清单：');
    for (const m of survivors) console.log(`  - ${m.op} ${m.line} ${m.snippet}`);
  }
} finally {
  restoreNow();
  const afterBuf = fs.readFileSync(targetAbs);
  const shaAfter = sha256(afterBuf);
  const byteEqual = Buffer.compare(afterBuf, original) === 0;
  console.log(`[mutation_lint] 还原校验：sha256(before)=${shaBefore}`);
  console.log(`[mutation_lint] 还原校验：sha256(after) =${shaAfter} ${shaBefore === shaAfter && byteEqual ? 'RESTORE-OK（字节级一致）' : 'RESTORE-FAIL'}`);
  if (weakTestAbs) {
    console.log(`[mutation_lint] 弱测试临时文件已删除：${fs.existsSync(weakTestAbs) ? '否（FAIL）' : '是'}`);
  }
  if (shaBefore !== shaAfter || !byteEqual) process.exitCode = 4;
}
