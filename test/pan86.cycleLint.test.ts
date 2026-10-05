// test/pan86.cycleLint.test.ts
// ΠΑΝ-86（C2-6/H-3/M-8）：依赖环执法器的契约回归——cycle_lint 此前不在任何测试
// 面内（全库仅一处注释提及），「防无执法演化的执法器」自己就是无执法演化。
// 三处契约修复的阳/阴性对照（纯函数 + CLI --root fixture 双面）：
//   ① `export type { A } from` 判 TYPE（曾误判 value ⇒ 纯类型再导出环假阳性 exit 1）；
//   ② 模板/计算式动态 import 产「未知边」保守标记（曾静默缺边 ⇒ 运行时环不可见）；
//   ③ 字符串里的伪 import 文本不入图（曾在字符串内容上产伪边）。
// 加载策略：非字面量动态 import（w7audit 先例——.mjs 可被 Node ESM 原生解析）；
// 模块内置直跑守卫（ΠΑΝ-86）：被 import 时不触发扫描。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (p: string): Promise<any> => import(p);
const C = await load(new URL('../scripts/cycle_lint.mjs', import.meta.url).href);

// ─── 纯函数面：clauseKind（边分类契约） ───

test('ΠΑΝ-86 clauseKind：export type re-export 判 TYPE（假阳性封堵）', () => {
  assert.equal(C.clauseKind('export', 'type { A }'), 'type', 'export type {A} from ⇒ TYPE（曾恒 value）');
  assert.equal(C.clauseKind('export', 'type { A as B }'), 'type', '带 as 的 type re-export ⇒ TYPE');
  assert.equal(C.clauseKind('import', 'type X'), 'type', 'import type X ⇒ TYPE（既有契约不回归）');
  assert.equal(C.clauseKind('import', '{ type A, type B }'), 'type', '全 specifier type 前缀 ⇒ TYPE');
  assert.equal(C.clauseKind('import', '{ type A, B }'), 'value', '混裸名 ⇒ value（保守）');
  assert.equal(C.clauseKind('import', 'A'), 'value', 'default ⇒ value');
  assert.equal(C.clauseKind('export', '{ A }'), 'value', '裸 specifier re-export ⇒ value（运行时边）');
  assert.equal(C.clauseKind('import', 'types'), 'value', '名为 types 的标识符不误判 type 前缀');
});

// ─── 纯函数面：edgesOfText（伪边封堵 + 动态 import 盲区标记） ───

test('ΠΑΝ-86 edgesOfText：字符串伪边不入图；动态 import 三态各得其所', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pan86e-'));
  try {
    const host = path.join(dir, 'host.ts');
    writeFileSync(path.join(dir, 'lit.ts'), 'export const a = 1;\n', 'utf8');
    writeFileSync(path.join(dir, 'tpl.ts'), 'export const b = 2;\n', 'utf8');
    const src = [
      "import { x } from './lit';",
      'export const fake1 = "import { y } from \'./lit\';"; // 字符串伪边（不得入图）',
      'export const fake2 = `export * from \'./lit\';`;    // 模板字符串伪边（同上）',
      "export const d1 = import('./lit');                   // 字面量动态 ⇒ value 边",
      'export const d2 = import(`./tpl${s}.ts`);            // 模板 ⇒ 前缀保守入图 + 标记',
      'export const d3 = import(`./tpl`);                   // 无插值模板 ⇒ 事实字面量边',
      "export const d4 = import('./' + name);               // 计算式 ⇒ 盲区标记（不静默）",
      'declare const s: string, name: string;',
    ].join('\n');
    const { edges, unknownDynamic } = C.edgesOfText(host, src);
    const tos = edges.map((e: any) => path.basename(e.to));
    // lit.ts 三条真实边（静态 + 动态字面量）+ tpl.ts 两条（前缀 + 无插值模板）
    assert.equal(tos.filter((f: string) => f === 'lit.ts').length, 2, `静态+动态字面量各一：${tos}`);
    assert.equal(tos.filter((f: string) => f === 'tpl.ts').length, 2, `模板前缀+无插值模板：${tos}`);
    const kinds = unknownDynamic.map((u: any) => u.kind).sort();
    assert.deepEqual(kinds, ['dynamic-prefix', 'dynamic-unresolved'], '模板有洞⇒prefix 标记；计算式⇒unresolved 标记（绝不静默缺边）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── ΤΕΛ-7a：正则字面量词法域感知（F4-1 附记登记盲区的收口） ───

test('ΤΕΛ-7a edgesOfText：正则字面量不再吞动态 import（som.ts 盲区形态）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tel7a-'));
  try {
    const host = path.join(dir, 'host.ts');
    writeFileSync(path.join(dir, 'esc.ts'), 'export const esc = 1;\n', 'utf8');
    writeFileSync(path.join(dir, 'reader.ts'), 'export const read = 2;\n', 'utf8');
    // som.ts:100 同形态：字符类内引号（/[<>&"']/g）曾把旧状态机踢进字符串态，
    // 吞掉其后的全部真实代码 —— 两处动态 import（'../uiExtractor'/'../textReader'
    // 同位形态）不产边（图缺边）。修后正则整体抹空，两边必须入图。
    const src = [
      'export function escapeXml(s: string): string {',
      "  return s.replace(/[<>&\"']/g, ch => ch);",
      '}',
      'export async function go(): Promise<void> {',
      "  const esc = await import('./esc');",
      "  const { read } = await import('./reader');",
      '  void esc; void read;',
      '}',
    ].join('\n');
    const { edges } = C.edgesOfText(host, src);
    const tos = edges.map((e: any) => path.basename(e.to));
    assert.ok(tos.includes('esc.ts'), `正则后的动态 import('./esc') 必须出边：${tos}`);
    assert.ok(tos.includes('reader.ts'), `正则后的动态 import('./reader') 必须出边：${tos}`);
    // 边种必须是 value（动态 import = 运行时边）
    for (const e of edges) assert.equal(e.kind, 'value', `动态 import 边须 value：${JSON.stringify(e)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ΤΕΛ-7a edgesOfText：正则字面量内伪 import 不产边；除法不吞码', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tel7b-'));
  try {
    const host = path.join(dir, 'host.ts');
    writeFileSync(path.join(dir, 'real.ts'), 'export const r = 1;\n', 'utf8');
    const src = [
      // 阴性：正则字面量内的 from './ghost' 文本（整体抹空 —— 旧版会把 '/ghost' 后的
      // 引号当闭界、其后再误入字符串态；新版正则域内无引号语义，不产伪边）
      "const ghostRe = /import x from '.\\/ghost';/;",
      // 除法启发式：`a / b` 的 / 是除法（前一显著字符为标识符），不得当正则抹掉后续行
      'export function ratio(a: number, b: number): number { return a / b; }',
      "import { r } from './real';",
      'export const use = r + ghostRe.source.length;',
    ].join('\n');
    const { edges, unknownDynamic } = C.edgesOfText(host, src);
    const tos = edges.map((e: any) => path.basename(e.to));
    assert.ok(tos.includes('real.ts'), `除法后的静态 import 必须出边（不得误吞）：${tos}`);
    assert.equal(tos.filter((f: string) => f === 'ghost.ts').length, 0, `正则内伪 import 不产边：${tos}`);
    assert.equal(unknownDynamic.length, 0, '本样不含动态 import，不得有盲区标记');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 图分析面：value 环红 / type 环豁免 ───

test('ΠΑΝ-86 analyzeGraph：type-only re-export 环 ⇒ 豁免；value 环 ⇒ 红', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pan86g-'));
  try {
    writeFileSync(path.join(dir, 't1.ts'), "export type { T2 } from './t2';\nexport interface T1 { x: number }\n", 'utf8');
    writeFileSync(path.join(dir, 't2.ts'), "import type { T1 } from './t1';\nexport interface T2 { y: T1 }\n", 'utf8');
    writeFileSync(path.join(dir, 'a.ts'), "import { bGo } from './b';\nexport function aGo(): number { return bGo(); }\n", 'utf8');
    writeFileSync(path.join(dir, 'b.ts'), "import { aGo } from './a';\nexport function bGo(): number { return aGo(); }\n", 'utf8');
    const files = ['t1', 't2', 'a', 'b'].map((f) => path.join(dir, `${f}.ts`)).sort();
    const edgesByFile = new Map(files.map((f: string) => [f, C.edgesOf(f)]));
    const r = C.analyzeGraph(files, edgesByFile);
    assert.equal(r.valueCycles.length, 1, 'a↔b 运行时真环 ⇒ 红');
    assert.equal(r.typeOnlySccs.length, 1, 't1↔t2 纯 type re-export 环 ⇒ 豁免（不红）');
    assert.ok(r.valueCycles[0].scc.every((f: string) => /[ab]\.ts$/.test(f)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── CLI 面：--root fixture 的退出码契约 ───

/** 造 fixture 根并跑 CLI（--root 注入）→ { status, out } */
function runCli(files: Record<string, string>): { status: number | null; out: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'pan86c-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  try {
    const r = spawnSync(
      process.execPath,
      [path.join(root, 'scripts', 'cycle_lint.mjs'), '--root', dir],
      { encoding: 'utf8', timeout: 60_000 },
    );
    return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('ΠΑΝ-86 CLI：type-only re-export 环 exit 0（旧契约下此处是假阳性 exit 1）', () => {
  const r = runCli({
    't1.ts': "export type { T2 } from './t2';\nexport interface T1 { x: number }\n",
    't2.ts': "import type { T1 } from './t1';\nexport interface T2 { y: T1 }\n",
    'fake.ts': 'export const s = "import x from \'./t1\';";\n',
  });
  assert.equal(r.status, 0, `纯 type 环必须豁免：\n${r.out}`);
  assert.match(r.out, /type-only 环 1 ⇒ 豁免/);
  assert.match(r.out, /✔ 零 value-only 依赖环/);
});

test('ΠΑΝ-86 CLI：value 环 exit 1 + 动态 import 盲区标记在输出可见', () => {
  const r = runCli({
    'a.ts': "import { bGo } from './b';\nexport function aGo(): number { return bGo(); }\n",
    'b.ts': "import { aGo } from './a';\nexport function bGo(): number { return aGo(); }\n",
    'd.ts': "export const c = import('./' + name);\ndeclare const name: string;\n",
  });
  assert.equal(r.status, 1, '运行时真环必须红');
  assert.match(r.out, /\[value-cycle\]/);
  assert.match(r.out, /\[dynamic-unresolved\]/, '计算式动态 import 不再静默缺边');
  assert.match(r.out, /动态 import 盲区标记 1 处/);
});
