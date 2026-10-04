// test/w7audit.test.ts
// W7-2 创世审计器（scripts/genesis_audit.mjs）单元测试——纯函数与纯文本审计面。
// 实跑/CLI/端到端执法探针由 `node scripts/genesis_audit.mjs --selftest` 承担
// （--selftest 的 TAP 面自含真实实跑与「篡改副本 ⇒ --check exit 1」探针）。
// 加载策略：非字面量动态 import（仓库先例 test/w2bench.test.ts——说明符非字面量
// ⇒ tsc 对 any 收声，tsconfig 无 allowJs 也能 typecheck 干净；运行时 Node ESM
// 原生解析 .mjs）。模块内置直跑守卫：被 import 时不触发 CLI main。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const load = (p: string): Promise<any> => import(p);
const auditUrl = new URL('../scripts/genesis_audit.mjs', import.meta.url).href;
const A = await load(auditUrl);

const genesisMd = await readFile(new URL('../GENESIS.md', import.meta.url), 'utf8');
const debtsMd = await readFile(new URL('../DEBTS.md', import.meta.url), 'utf8');

// ─── 审判列解析 ───

test('W7-A parseJudgment：口径段（；/（ 前）', () => {
  assert.deepEqual(A.parseJudgment('37/0'), { total: 37, fail: 0, kind: 'slash' });
  assert.deepEqual(A.parseJudgment('0/0（Python 自测 58 断言）'), { total: 0, fail: 0, kind: 'slash' });
  assert.deepEqual(A.parseJudgment('9 冒烟（作者环境 9/0；本机复核 8/9）'), { total: 9, fail: 0, kind: 'count' });
  assert.deepEqual(A.parseJudgment('7 bench 全绿；声明 vs 实测：C1 50.0%'), { total: 7, fail: 0, kind: 'count' });
  assert.equal(A.parseJudgment('—'), null);
  assert.equal(A.parseJudgment(''), null);
});

test('W7-A parseJudgmentSegments：双面账（作者环境/本机复核）', () => {
  assert.deepEqual(
    A.parseJudgmentSegments('9 冒烟（作者环境 9/0；本机复核 8/9）'),
    [{ total: 9, fail: 0, tag: '账面' }, { total: 9, fail: 1, tag: '本机复核' }],
  );
  assert.deepEqual(A.parseJudgmentSegments('37/0'), [{ total: 37, fail: 0, tag: '账面' }]);
  assert.deepEqual(A.parseJudgmentSegments('—'), []);
  // 日期式大数（2026/10）不构成审判段
  assert.deepEqual(A.parseJudgmentSegments('12/0（复核 2026/10/03）'), [{ total: 12, fail: 0, tag: '账面' }]);
});

// ─── 执法列解析 ───

test('W7-A extractStems / extractLawId', () => {
  assert.deepEqual(A.extractStems('W1-1'), []);
  assert.equal(A.extractLawId('W1-1'), 'W1-1');
  assert.deepEqual(
    A.extractStems('w5cascade/w5gate/w5ledger/w5roi/w5macro/w5settle（六文件）'),
    ['w5cascade', 'w5gate', 'w5ledger', 'w5roi', 'w5macro', 'w5settle'],
  );
  assert.deepEqual(A.extractStems('python --selftest'), []);
  assert.equal(A.extractLawId('python --selftest'), null);
});

test('W7-A ID_MAP 全部值合规（Wn-m 册号 → 文件 stem）', () => {
  for (const stem of Object.values(A.ID_MAP as Record<string, string>)) {
    assert.match(stem, /^w\d[a-z0-9]*$/);
  }
});

// ─── 判定 ───

test('W7-A classify 四象限', () => {
  assert.equal(A.classify(37, 0, 37, 0), '一致');
  assert.equal(A.classify(37, 0, 35, 0), '虚报');
  assert.equal(A.classify(9, 0, 9, 1), '虚报');
  assert.equal(A.classify(10, 0, 12, 0), '滞后');
});

test('W7-A classifySegments：任一段命中 ⇒ 一致', () => {
  const segs = [
    { total: 9, fail: 0, tag: '账面' },
    { total: 9, fail: 1, tag: '本机复核' },
  ];
  assert.equal(A.classifySegments(segs, 9, 0).verdict, '一致');
  assert.equal(A.classifySegments(segs, 9, 1).verdict, '一致');
  assert.ok(A.classifySegments(segs, 9, 1).note.includes('本机复核'));
  assert.equal(A.classifySegments(segs, 7, 0).verdict, '虚报');
  assert.equal(A.classifySegments([{ total: 9, fail: 0, tag: '账面' }], 12, 0).verdict, '滞后');
  assert.equal(A.classifySegments([], 5, 0).verdict, 'n/a');
});

// ─── 章节切分 / 散文另立账 / 合计声明 ───

test('W7-A parseGenesisW：仅收「纪元 Wn」章节；散文另立账去重', () => {
  const md = [
    '# 创世总账', '',
    '## 证明与审计', '旧纪元（不入审计面）', '',
    '## 执行与感知韧性（纪元 W1 · 九器官 + W2-0 集成接线）',
    '| 器官 | 根基 | 执法 | 审判 |',
    '| --- | --- | --- | --- |',
    '| 执行层四连改 | 三区判决 | W1-1 | 37/0 |',
    '| 带外确认码 | CSPRNG | W1-2 | 13/0 |',
    '审判口径：九器官合计 50/0；W2-0 集成接线另立 w2wire 10/0', '',
    '## 真机审判（W-2，器官时代后）',
    '| 器官 | 根基 | 执法 | 审判 |',
    '| x | y | z | 4/4 |', '',
    '## 第五批收官潮（纪元 W5 · 七器官）',
    '| 器官 | 根基 | 执法 | 审判 |',
    '| 效能基准 | 七项 | w5a/w5b | 7 bench 全绿；C1 50.0% |',
  ].join('\n');
  const eps = A.parseGenesisW(md);
  assert.deepEqual(eps.map((e: any) => e.epoch), ['W1', 'W5']);
  assert.equal(eps[0].rows.length, 2);
  assert.deepEqual(eps[0].rows[0].claim, { total: 37, fail: 0, kind: 'slash' });
  assert.deepEqual(eps[0].rows[0].segments, [{ total: 37, fail: 0, tag: '账面' }]);
  assert.deepEqual(eps[1].rows[0].claim, { total: 7, fail: 0, kind: 'count' });
  assert.deepEqual(eps[0].proseClaims, [{ stem: 'w2wire', total: 10, fail: 0, source: 'prose' }]);
  assert.deepEqual(A.parseDeclaredTotal('审判口径：九器官合计 169/0'), { total: 169, fail: 0 });
});

// ─── TAP 解析 ───

test('W7-A parseTap 取末次计数（防测试自身打印伪计数）', () => {
  const tap = ['# tests 3', '# pass 3', '# fail 0', '# tests 8', '# pass 8', '# fail 0', '# cancelled 0', '# skipped 0'];
  assert.deepEqual(A.parseTap(tap.join('\n')), { tests: 8, pass: 8, fail: 0, cancelled: 0, skipped: 0 });
  assert.equal(A.parseTap('crash before summary'), null);
});

// ─── DEBTS 解析 ───

test('W7-A statusTokenOf / parseDeclaredEnum（blockquote 折行续接）', () => {
  assert.equal(A.statusTokenOf('需真机（部署后）；部署面见 D-C2'), '需真机');
  assert.equal(A.statusTokenOf('本纪元W6处理（编码管线接线）/部署协同'), '本纪元W6处理');
  assert.equal(A.statusTokenOf('已闭环（立法本身；各开闸…）'), '已闭环');
  const md = [
    '# 台账', '',
    '> 状态枚举（每条恰一）：**已闭环**（债清，留档防复发）｜**本纪元W6处理**（W6 后续',
    '> 包职权内可闭）｜**需真机**（硬件）。',
  ].join('\n');
  assert.deepEqual(A.parseDeclaredEnum(md), ['已闭环', '本纪元W6处理', '需真机']);
});

test('W7-A parseDebts：行/枚举违例/统计段折行', () => {
  const md = [
    '# 台账', '',
    '> 状态枚举（每条恰一）：**已闭环**｜**需真机**',
    '',
    '## A. 真机验证清单',
    '| # | 来源 | 描述 | 状态 | 证据 |',
    '| --- | --- | --- | --- | --- |',
    '| D-A1 | W4-6 | UVC | 需真机 | uvc.py |',
    '| D-A2 | W4-6 | HID | 需真机（部署后） | hid.py |',
    '',
    '## B. 激活开关清单',
    '| # | 来源 | 描述 | 状态 | 证据 |',
    '| D-B1 | W1-7 | som | 已知取舍 | som.ts |',
    '',
    '## 统计与复核记录',
    '条数（含已闭环留档）：A 真机 2 ｜ B 激活开关 1',
    ' —— 合计 3 条。',
    '未闭债主分类：需真机 2｜已知取舍留档',
    ' 1。',
  ].join('\n');
  const d = A.parseDebts(md);
  assert.equal(d.rows.length, 3);
  assert.deepEqual(d.declaredEnum, ['已闭环', '需真机']);
  assert.deepEqual(d.declaredCounts, { A: 2, B: 1 });
  assert.equal(d.declaredTotal, 3);
  assert.equal(d.declaredMain['需真机'], 2);
  assert.equal(d.declaredMain['已知取舍'], 1);
  const viol = d.rows.filter((r: any) => !new Set(d.declaredEnum).has(r.statusToken));
  assert.deepEqual(viol.map((v: any) => v.id), ['D-B1']);
});

// ─── 真实账册（只读）解析确定性与审计宇宙 ───

test('W7-B 真实 GENESIS/DEBTS 两次解析逐字段一致（确定性）', () => {
  assert.deepEqual(A.parseGenesisW(genesisMd), A.parseGenesisW(genesisMd));
  assert.deepEqual(A.parseDebts(debtsMd), A.parseDebts(debtsMd));
});

test('W7-B 真实 GENESIS 命中 W1-W5 五纪元，DEBTS ≥30 条', () => {
  const eps = A.parseGenesisW(genesisMd);
  assert.deepEqual(eps.map((e: any) => e.epoch), ['W1', 'W2', 'W3', 'W4', 'W5']);
  const rows = eps.reduce((a: number, e: any) => a + e.rows.length, 0);
  assert.ok(rows >= 40, `rows=${rows}`);
  const d = A.parseDebts(debtsMd);
  assert.ok(d.declaredEnum.length >= 5);
  assert.ok(d.rows.length >= 30, `rows=${d.rows.length}`);
});

test('W7-B audit 纯文本面确定性 + 盘存面限定 W1-W6 + 合计自洽', async () => {
  const a1 = await A.audit({ run: false });
  const a2 = await A.audit({ run: false });
  assert.deepEqual(a1, a2);
  assert.ok(a1.unledgered.length >= 1, `unledgered=${a1.unledgered.length}`);
  assert.ok(a1.unledgered.every((u: any) => /^test\/w[1-6]/.test(u.file)));
  const bad = a1.epochSums.filter((s: any) => s.ok === '不自洽');
  assert.deepEqual(bad, []);
  assert.equal(a1.epochSums.find((s: any) => s.epoch === 'W2').ok, '自洽(含另立)');
  const n = Object.values(a1.tallyByEpoch).reduce((x: number, e: any) => x + e.条目, 0);
  assert.equal(n, a1.claimVerdicts.length);
});

test('W7-B 抽样护栏（纯函数）：sample=1 ⇒ 每纪元恰 1 条可实跑账目', () => {
  const mk = (epoch: string, runnable: boolean): any => ({
    epoch, files: runnable ? ['test/x.test.ts'] : [],
    claim: { total: 1, fail: 0 }, segments: [],
  });
  const claims = [mk('W1', true), mk('W1', true), mk('W1', false), mk('W2', true), mk('W2', true)];
  const out = A.sampleClaims(claims, 1);
  assert.equal(out.length, 3); // W1 首条 + W1 的 n/a + W2 首条
  assert.equal(out.filter((c: any) => c.epoch === 'W1' && c.files.length).length, 1);
  assert.ok(out.includes(claims[2]), 'n/a 账保留');
  assert.deepEqual(A.sampleClaims(claims, null), claims);
  assert.equal(A.sampleClaims(claims, 0).length, 1); // 0 ⇒ 仅 n/a（CLI 层把 0 归一为 null=全部）
});
