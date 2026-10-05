// test/w0wiring.census.test.ts
// ΠΑΝ-38（装配完备性执法器）测试：锁定 scripts/wiring_census.mjs 纯函数核心的解析/判定
// 契约，并对真实仓现状执法——孤儿全部在册、豁免册无幽灵、无非法条目。
//
// 立法背景（C2-7 主题一 / C2-9 主题 1）：3044 个测试全部从注入端口进，"器官精良、躯体
// 缺位"整类不可见——本闸把组合根接线完整性从口头债务铸成机械执法。r29 豁免册"册不留
// 幽灵条目"同律：修掉一个在册差异 ⇒ 同步删册条目，否则本册测试红。
//
// 加载策略与 w7gate.test.ts 同律：说明符非字面量动态 import ⇒ tsc 对 any 收声（tsconfig
// 无 allowJs 也能 typecheck 干净）；CLI 胶水由 invoked 守卫保证 import 零副作用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const load = (p: string): Promise<any> => import(p);
const census: any = await load(new URL('../scripts/wiring_census.mjs', import.meta.url).href);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ═══ 词法域预处理：正则字面量/模板插值/注释四域感知（cycle_lint 盲区的收口） ═══

test('ΠΑΝ-38 词法域a: preprocess —— 正则内引号不吞代码（本仓 runtime.ts 假孤儿事故的回归锚）', () => {
  const src = [
    "const re = /['\"]/g; // comment with 'quote'",
    "const keep = 'literal';",
    'const tpl = `head ${ { deep: 1 } } tail`;',
    'export function keepMe(x: number) { return x + 1; }',
  ].join('\n');
  const { code, blank, stringSpans } = census.preprocess(src);
  // code 变体：注释/正则抹空、字符串保留
  assert.match(code, /export function keepMe/);
  assert.ok(code.includes("'literal'"), 'code 变体保留字符串原文');
  assert.ok(!code.includes('comment with'), '行注释抹空');
  assert.ok(!code.includes("['\"]"), '正则字面量抹空');
  // blank 变体：字符串/模板文本亦抹空，插值内代码保留
  assert.ok(!blank.includes('literal'), 'blank 变体字符串抹空');
  assert.ok(!blank.includes('head') && !blank.includes('tail'), '模板文本抹空');
  assert.match(blank, /\{ deep: 1 \}/, '${} 插值代码保留（含嵌套花括号）');
  assert.match(blank, /keepMe/, '正则内引号曾让旧解析器吞掉后续代码 —— 现在保住');
  assert.ok(stringSpans.length >= 2, '字符串与模板文本段入 span（伪 import 排除依据）');
});

// ═══ 模块解析：type/value 区分、别名、命名空间、动态解构、多声明符、re-export 桶 ═══

test('ΠΑΝ-38 解析b: parseModule —— 导入面（type/值/别名/命名空间/动态解构）逐类入册', () => {
  const src = [
    "import type { Ghost } from './ghost';",
    "import { armA, type OnlyType, wireB as aliased } from './organ';",
    "import * as ns from './organ2';",
    "const { dynOne } = await import('./organ3');",
    'export const helper = 1;',
    'export function armA2() {}',
    'export const c1 = 1, c2 = 2;',
    'export { helper as helperRenamed };',
    "export { reX } from './reexported';",
  ].join('\n');
  const m = census.parseModule('src/sample.ts', src);
  const ni = (local: string) => m.namedImports.find((x: any) => x.local === local);
  assert.equal(ni('armA')?.typeOnly, false, '裸名 = 值导入');
  assert.equal(ni('OnlyType')?.typeOnly, true, 'type 前缀 specifier = 仅类型（编译后蒸发）');
  assert.equal(ni('aliased')?.imported, 'wireB', 'as 别名保留 imported↔local 映射');
  assert.equal(ni('Ghost')?.typeOnly, true, 'import type 整句标记仅类型（值接线判定不计数）');
  assert.deepEqual(m.nsImports.map((x: any) => x.local), ['ns']);
  assert.equal(ni('dynOne')?.rawSpec, './organ3', '动态解构 import 计值导入');
  const declNames = m.decls.map((d: any) => d.name);
  assert.deepEqual(declNames, ['armA2', 'helper', 'c1', 'c2'], '多声明符 const 逐名入值导出（c2 不漏）');
  const localList = m.exportLists.find((l: any) => l.rawSpec === null);
  const reexport = m.exportLists.find((l: any) => l.rawSpec === './reexported');
  assert.deepEqual(localList?.specs, [{ local: 'helper', exported: 'helperRenamed', typeOnly: false }]);
  assert.deepEqual(reexport?.specs, [{ local: 'reX', exported: 'reX', typeOnly: false }]);
});

test('ΠΑΝ-38 解析c: resolveSpecPath —— .js 后缀剥离 / .ts 直通 / index 回退 / 包导入拒绝', () => {
  const known = new Set(['src/a/x.ts', 'src/a/mod/index.ts', 'src/a/y.mjs', 'src/other.ts']);
  assert.equal(census.resolveSpecPath('src/a/b.ts', './x.js', known), 'src/a/x.ts');
  assert.equal(census.resolveSpecPath('src/a/b.ts', './x', known), 'src/a/x.ts');
  assert.equal(census.resolveSpecPath('src/a/b.ts', './mod', known), 'src/a/mod/index.ts');
  assert.equal(census.resolveSpecPath('src/a/b.ts', '../other', known), 'src/other.ts');
  assert.equal(census.resolveSpecPath('src/a/b.ts', './y.mjs', known), 'src/a/y.mjs');
  assert.equal(census.resolveSpecPath('src/b.ts', 'node:fs', known), null, '包导入不入图');
  assert.equal(census.resolveSpecPath('src/b.ts', './missing', known), null, '解析失败不入图');
});

// ═══ 合成树端到端：注入孤儿被检出 → 登记豁免 → 接线后成幽灵（册不留幽灵执法路径） ═══

function syntheticTree(wireArm: boolean): Map<string, string> {
  return new Map<string, string>([
    // ΠΑΝ-38: 故意注入的孤儿——armMagic 只有测试消费，组合根不调
    ['src/organ.ts', 'export function armMagic(): void { return; }\nexport function usedHelper(): void { return; }\n'],
    ['src/comp.ts', "import { usedHelper } from './organ';\nfunction run() { usedHelper(); }\n"],
    ['src/index.ts', wireArm
      ? "import { armMagic } from './organ';\nexport const name = 'plugin';\narmMagic();\n"
      : "export const name = 'plugin';\n"],
    ['test/organ.test.ts', "import { armMagic } from '../src/organ';\nimport assert from 'node:assert/strict';\nassert.ok(armMagic);\n"],
    ['scripts/probe.mjs', "const { usedHelper } = await import('../src/organ');\nusedHelper();\n"],
  ]);
}

test('ΠΑΝ-38 判定d: 合成树 —— 孤儿检出 / 接线判定 / 宿主入口自动豁免', () => {
  const r = census.runCensus(syntheticTree(false), null);
  const byName = new Map<string, any>(r.entries.map((e: any) => [e.name, e]));
  assert.equal(byName.get('armMagic')?.status, 'orphan');
  assert.equal(byName.get('armMagic')?.subcategory, 'test-only', '仅测试消费 ⇒ test-only 证据类');
  assert.equal(byName.get('usedHelper')?.status, 'wired', '跨文件值导入+调用 ⇒ wired');
  assert.equal(byName.get('name')?.status, 'host-entry', 'src/index.ts 直定义 = 宿主入口面（规则豁免，不入册）');
  const un = r.unregistered.map((e: any) => e.name);
  assert.deepEqual(un, ['armMagic'], '未登记孤儿恰为注入的 armMagic');
});

test('ΠΑΝ-38 判定e: 豁免册对账 —— 登记后全绿；接线后变幽灵（册不留幽灵）；非法条目即红', () => {
  const ledger = {
    entries: [{
      file: 'src/organ.ts', name: 'armMagic', kind: 'function', category: 'test-only',
      reason: '合成树：测试专用注入面（ΠΑΝ-38 测试自证）',
    }],
  };
  const green = census.runCensus(syntheticTree(false), ledger);
  assert.equal(green.summary.unregisteredCount, 0);
  assert.equal(green.summary.ghostCount, 0);
  assert.equal(green.summary.exemptedCount, 1);
  // 同一册 + 已接线 ⇒ 幽灵（wired）——接线落地必须同步删册
  const ghost = census.runCensus(syntheticTree(true), ledger);
  assert.equal(ghost.summary.ghostCount, 1);
  assert.equal(ghost.ghosts[0]?.id, 'src/organ.ts::armMagic');
  assert.equal(ghost.ghosts[0]?.now, 'wired');
  // 非法条目：类别不在枚举 / 理由缺失 —— 结构非法即红
  const bad = census.runCensus(syntheticTree(false), {
    entries: [
      { file: 'src/organ.ts', name: 'armMagic', kind: 'function', category: 'made-up', reason: 'x' },
      { file: 'src/organ.ts', name: 'armMagic2', kind: 'function', category: 'dead-code', reason: '  ' },
    ],
  });
  assert.equal(bad.summary.invalidCount, 2);
  assert.equal(bad.summary.unregisteredCount, 1, '非法条目不豁免任何孤儿');
});

test('ΠΑΝ-38 判定f: 方法级动词面 —— 类方法孤儿被点名（promoteFrom 同族形态）', () => {
  const tree = new Map<string, string>([
    ['src/kernel.ts', 'export class Kernel {\n  promoteFrom(lab: unknown): Array<{ k: string }> {\n    return [];\n  }\n}\n'],
    ['src/other.ts', 'export function useNothing(): void { return; }\n'],
  ]);
  const r = census.runCensus(tree, null);
  const m = r.entries.find((e: any) => e.kind === 'method' && e.name === 'promoteFrom');
  assert.ok(m, '动词前缀类方法入方法级普查宇宙');
  assert.equal(m.status, 'orphan');
  assert.deepEqual(m.definers, ['src/kernel.ts']);
});

// ═══ 真实仓现状执法（读盘只读，~1s） ═══

const realVfs = census.collectVfs(ROOT);
const realLedger = JSON.parse(readFileSync(new URL('../scripts/wiring-census.exemptions.json', import.meta.url), 'utf8'));
const real = census.runCensus(realVfs, realLedger);

test('ΠΑΝ-38 现状g: 真实仓 —— 孤儿全部在册、豁免册无幽灵、无非法条目（执法全绿）', () => {
  assert.equal(real.summary.unregisteredCount, 0, '存在未豁免孤儿：接线，或在豁免册登记理由');
  assert.equal(real.summary.ghostCount, 0, '豁免册存在幽灵条目：接线已落地/符号已消失，须同步删册');
  assert.equal(real.summary.invalidCount, 0, '豁免册存在非法条目（类别/理由/结构）');
  assert.equal(real.summary.exemptionRate, 1);
});

test('ΠΑΝ-38 现状h: 豁免册 schema —— 类别枚举、理由非空、键唯一、只收 src/ 面', () => {
  const entries: any[] = realLedger.entries;
  assert.ok(entries.length >= 300, `在册条目 ${entries.length} 应与普查孤儿同量级`);
  const seen = new Set<string>();
  for (const e of entries) {
    const id = `${e.file}::${e.name}`;
    assert.ok(!seen.has(id), `重复条目: ${id}`);
    seen.add(id);
    assert.ok(census.CATEGORIES.includes(e.category), `类别非法: ${id} → ${e.category}`);
    assert.ok(typeof e.reason === 'string' && e.reason.trim().length >= 6, `理由缺失/过短: ${id}`);
    assert.ok(e.file.startsWith('src/'), `普查对象只应是 src/ 生产面: ${id}`);
    assert.ok(['function', 'const', 'let', 'var', 'class', 'enum', 'method'].includes(e.kind), `kind 非法: ${id}`);
  }
});

test('ΠΑΝ-38 现状i: 普查宇宙规模与批判基线同量级（C2-9：942 导出函数 / 233 零引用）', () => {
  const s = real.summary;
  assert.ok(s.symbolsTotal >= 1400, `普查宇宙 ${s.symbolsTotal} 应 ≥1400（批判基线 942 函数 + const/class/方法面）`);
  assert.ok(s.orphanCount >= 300 && s.orphanCount <= 800, `孤儿 ${s.orphanCount} 应在批判基线（函数口径 233）的合理推广区间`);
  assert.ok(s.wiredCount > s.orphanCount, '生产接线面应大于孤儿面（否则普查口径可疑）');
  assert.ok(real.entries.some((e: any) => e.id === 'src/index.ts::apply' && e.status === 'host-entry'),
    '插件入口 apply 应在册且判宿主入口面（dsh.plugin.json entry → dist/index.js）');
});

test('ΠΑΝ-38 现状j: 已知接线锚 —— 批判点名的 arm* 家族当前接线状态被如实记录', () => {
  const byId = new Map<string, any>(real.entries.map((e: any) => [e.id, e]));
  // C2-7 §1.4 的对照锚：armFederationTrustPersistence 在 index.ts 组合根接线（应恒 wired）
  assert.equal(byId.get('src/federation/trust.ts::armFederationTrustPersistence')?.status, 'wired');
  // ΠΑΝ-38 施工期间接线潮已落地的四件 A 级器官（本测试不锁 wired——只锁"接线或在册"，
  // 防未来拆线后假绿：拆线 ⇒ 变孤儿 ⇒ 未登记即红）
  for (const id of ['src/reversalEscrow.ts::armReversalEscrow', 'src/kernel/registry.ts::promoteFrom']) {
    const e = byId.get(id);
    assert.ok(e, `${id} 应在普查宇宙`);
    assert.ok(e.status === 'wired' || e.status === 'orphan', '状态二值合法');
    if (e.status === 'orphan') {
      assert.ok(real.exempted.some((x: any) => x.id === id), `${id} 拆线成孤儿时必须在册（批判点名条目）`);
    }
  }
});

test('ΠΑΝ-38 现状k: 确定性 —— 同树两跑逐字节同报告（build_manifest 同律，无时间戳）', () => {
  const again = census.runCensus(census.collectVfs(ROOT), realLedger);
  assert.equal(census.renderReport(real), census.renderReport(again));
  assert.ok(!/\d{4}-\d{2}-\d{2}T|\d{2}:\d{2}:\d{2}/.test(census.renderReport(real)), '报告不得携带时间戳');
});
