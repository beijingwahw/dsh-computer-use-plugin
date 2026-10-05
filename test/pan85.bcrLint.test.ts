// test/pan85.bcrLint.test.ts
// ΠΑΝ-85（C2-6/H-2/M-8）：Bug 类注册表的**阳性对照夹具**——检测器腐化（正则漂移/
// TS 语法演进）在库保持干净时不可见；此前 test/epochP.test.ts 只断言「全库零命中」
// （阴性），从未验证「对已知坏样本必须报警」。本件用批判报告实证过的规避样本
// 铸成阳性回归：BC-3 类型注解/泛注释豁免、BC-4 单行多参数/行首锚、BC-1 pwsh/
// 分行书写——三处绕过面封堵后必须照报；合法形态（阴性）不得误报；精确格式豁免
// 必须登记可见。走 --root 注入 fixture 目录（不碰真实 src/）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

/** 造 fixture 扫描根并跑 lint（--strict）→ { code, out } */
function runLint(files: Record<string, string>): { code: number; out: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'pan85-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  try {
    const out = execFileSync('python', ['scripts/bug_class_lint.py', '--root', dir, '--strict'], {
      encoding: 'utf8',
      cwd: root,
      timeout: 60_000,
    });
    return { code: 0, out, dir };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? 1, out: err.stdout ?? '', dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('ΠΑΝ-85 阳性：批判报告的三类规避样本全部照报（检测器灵敏度回归）', () => {
  const r = runLint({
    // BC-3 规避样本 ①：加类型注解（原正则 `(\w*(?:id|…)\w*)\s*=` 对注解形式失配）
    'src/a.ts': [
      'export function f() {',
      '  const requestId: number = Date.now(); // 规避样本：类型注解',
      '  const evSeq = Date.now(); // 名含 seq',
      '  const id4 = Date.now(); // monotonic（ΠΑΝ-85：泛注释不再免报）',
      '  const t0 = Date.now(); // 非 id/seq 名——合法测量（阴性内嵌）',
      '  const id2 = Math.max(Date.now(), last + 1); // 混合逻辑时钟（阴性内嵌）',
      '}',
    ].join('\n'),
    // BC-4 规避样本：单行多参数中段修饰符（原正则锚定行首失配）
    'src/b.ts': 'export class C { constructor(a: string, private b: number) {} }\n',
    // BC-1 规避样本：pwsh 上下文 + \\" 分行书写（原：不认 pwsh / 须同行）
    'src/c.ts': [
      "const cmd = \"Add-Type -MemberDefinition \\\"[DllImport(\\\"user32.dll\\\")]\\\"\";",
      "execFile('pwsh', ['-NoProfile', cmd]);",
    ].join('\n'),
    // BC-2 阳性：嵌套函数先读后赋（UnboundLocalError 形状）
    'python_service/x.py': 'def outer():\n    v = 1\n    def inner():\n        print(v)\n        v = 2\n    return inner\n',
  });
  assert.equal(r.code, 1, `--strict 有命中必须 exit 1：\n${r.out}`);
  assert.match(r.out, /\[BC-3\] .*a\.ts:2/);
  assert.match(r.out, /\[BC-3\] .*a\.ts:3/);
  assert.match(r.out, /\[BC-3\] .*a\.ts:4/, '泛 `// monotonic` 注释不再灭活 BC-3');
  assert.ok(!/\[BC-3\].*a\.ts:5/.test(r.out), '非 id/seq 名不误报');
  assert.ok(!/\[BC-3\].*a\.ts:6/.test(r.out), 'Math.max( 混合时钟不误报');
  assert.match(r.out, /\[BC-4\] .*b\.ts:1/, '单行多参数中段修饰符照报');
  assert.match(r.out, /\[BC-1\] .*c\.ts:1/, 'pwsh 上下文 + 分行 \\\\\" 照报');
  assert.match(r.out, /\[BC-2\] .*x\.py:3/);
});

test('ΠΑΝ-85 阴性：合法形态零误报（检测器特异性回归）', () => {
  const r = runLint({
    'src/clean.ts': [
      'export class D {',
      '  constructor(cb = "(") {} // 默认值含括号字符串——不得错切参数段',
      '  method(private x: number): void {} // 非构造器的修饰符——不报',
      '  constructor2(_: string) {}',
      '}',
      'export function g() {',
      '  const stamp = Date.now(); // 非 id/seq 名',
      '  const s = "x \\\\\" y"; // 无 PS 上下文的文件——不报',
      '}',
    ].join('\n'),
    'python_service/clean.py': 'def outer():\n    v = 1\n    def inner():\n        return v\n    return inner\n',
  });
  assert.equal(r.code, 0, `干净 fixture 须零命中：\n${r.out}`);
  assert.match(r.out, /零命中/);
  assert.ok(!r.out.includes('豁免登记'), '无豁免时不列豁免面');
});

test('ΠΑΝ-85 豁免登记制：精确格式 bcr-exempt 豁免且登记可见；静默吞报被消灭', () => {
  const r = runLint({
    'src/ex.ts': 'export function f() {\n  const id3: number = Date.now(); // bcr-exempt: BC-3: 已用单调混合时钟（探针）\n}\n',
  });
  assert.equal(r.code, 0, `豁免后零命中：\n${r.out}`);
  assert.match(r.out, /零命中/);
  assert.match(r.out, /豁免登记 1 处/, '豁免必须登记可见（不是静默吞报）');
  assert.match(r.out, /bcr-exempt.*已用单调混合时钟/, '登记带显式理由');
});

test('ΠΑΝ-85 BC-5 阳性：≥10 行逐字克隆照报；exempt 行注释申报后豁免', () => {
  const cloneBody = Array.from({ length: 12 }, (_, i) => `  const v${i} = ${i} * 3;`).join('\n');
  const mk = (name: string) => `export function ${name}() {\n${cloneBody}\n}\n`;
  const hit = runLint({ 'src/x1.ts': mk('fa'), 'src/x2.ts': mk('fb') });
  assert.equal(hit.code, 1);
  assert.match(hit.out, /\[BC-5\]/);
  const exempt = runLint({ 'src/x1.ts': mk('fa'), 'src/x2.ts': `// exempt: 知情的残余克隆（探针）\n${mk('fb')}` });
  assert.equal(exempt.code, 0, `exempt 申报后零命中：\n${exempt.out}`);
});
