// test/w7gate.test.ts —— W7-6 性能回归门核心（TAP 解析/指标提取/比较器/环境戳）回归。
// scripts/bench_gate.mjs 是纯 Node CLI + 纯函数核心；此处以非字面量动态 import 挂载
// （w2bench.test.ts 同律：说明符非字面量 ⇒ tsc 对 any 收声，运行时由 Node ESM
// 原生解析 —— tsconfig 无 allowJs 也能 typecheck 干净，这是刻意的加载策略）。
// CLI 胶水（子进程跑基准/写基线文件）不在此测——其自证由 --update→--check 全流程
// 实跑完成（见 W7-6 报告）。固定样本取自 w5*.bench.ts 实际 TAP 输出的 console 表，
// 锁定指标提取契约不被无意漂移。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const load = (p: string): Promise<any> => import(p);
const gate: any = await load(new URL('../scripts/bench_gate.mjs', import.meta.url).href);

// ─── 固定 TAP 样本（实采自 w5 基准输出形状：注释先于 Subtest 行、YAML 时长、尾总账） ───

const TAP_SAMPLE = [
  'TAP version 13',
  '# (node:20720) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time',
  '# (Use `node --trace-warnings ...` to show where the warning was created)',
  '# ── W5-6/C2 级联路由节省率（N=20 次定位，主力 1/便宜 0.25）──',
  '# 队列: eligible=15 cheapHit=12 escalated=3 高危直行=5',
  '# 命中率 hitRate = 0.8000（预期 0.8）',
  '# Subtest: W5-6/C2: 级联路由 —— 混合负载省钱命中率与节省率',
  'ok 1 - W5-6/C2: 级联路由 —— 混合负载省钱命中率与节省率',
  '  ---',
  '  duration_ms: 4.5173',
  '  ...',
  '# ── W5-6/C2b 反事实对照: 全主力 15 单位 vs 级联 6.75 单位 ⇒ 省 55.0% ──',
  '# Subtest: W5-6/C2b: 反事实对照 —— 同负载全主力直行的花费',
  'not ok 2 - W5-6/C2b: 反事实对照 —— 同负载全主力直行的花费',
  '  ---',
  '  duration_ms: 0.3047',
  '  ...',
  '# Subtest: W5-6/C1: 免看门控（被跳过的样本）',
  'ok 3 - W5-6/C1: 免看门控（被跳过的样本） # SKIP',
  '1..3',
  '# tests 3',
  '# pass 1',
  '# fail 1',
  '# skipped 1',
  '# duration_ms 850.9341',
].join('\n');

// ─── parseTap：结构/通过位/时长/注释归属/总账 ───

test('W7-6 门a: parseTap —— 测试名、通过位、时长与尾部总账', () => {
  const p = gate.parseTap(TAP_SAMPLE);
  assert.equal(p.tests.length, 3);
  assert.equal(p.tests[0].name, 'W5-6/C2: 级联路由 —— 混合负载省钱命中率与节省率');
  assert.equal(p.tests[0].ok, true);
  assert.equal(p.tests[0].durationMs, 4.5173);
  assert.equal(p.tests[1].ok, false, 'not ok ⇒ 未通过');
  assert.equal(p.tests[1].durationMs, 0.3047);
  assert.deepEqual(p.summary, { tests: 3, pass: 1, fail: 1, skipped: 1, durationMs: 850.9341 });
});

test('W7-6 门b: parseTap —— 注释归属下一测试、噪声注释剔除、SKIP 指令按未通过计', () => {
  const p = gate.parseTap(TAP_SAMPLE);
  // 指标注释先于 Subtest 行出现 ⇒ 归属其后的测试
  assert.ok(p.tests[0].comments.some((c: string) => c.includes('eligible=15')));
  assert.ok(p.tests[0].comments.some((c: string) => c.includes('hitRate')));
  // ExperimentalWarning / Use `node` 噪声注释不进任何指标区
  assert.ok(p.tests.every((t: any) => t.comments.every((c: string) => !c.includes('ExperimentalWarning') && !c.startsWith('(Use `node'))));
  // SKIP 指令 = 未真实跑过 ⇒ 门控口径按未通过计，并留 directive 取证
  assert.equal(p.tests[2].ok, false);
  assert.equal(p.tests[2].directive, 'SKIP');
});

// ─── extractMetrics：实采行样本锁定提取契约 ───

test('W7-6 门c: extractMetrics —— 键值对/百分数归一/臂名限定键（同键不同臂不互吞）', () => {
  const m = gate.extractMetrics([
    '队列: eligible=15 cheapHit=12 escalated=3 高危直行=5',
    '命中率 hitRate = 0.8000（预期 0.8）',
    '净节省 saved=8.25（预期 8.25）⇒ 节省率 savingsRate=0.5500（闭式 0.5500 = 命中率×价差比 − 升级罚）',
    '缺省(上限1)     perceive=6/12  probe=6  skipRate=50.0%',
    '上限3           perceive=3/12  probe=9  skipRate=75.0%',
    '总闸关(对照)    perceive=12/12  probe=0  skipRate=0.0%',
  ]);
  assert.equal(m['队列.eligible'].value, 15);
  assert.equal(m['队列.cheapHit'].value, 12);
  assert.equal(m['队列.高危直行'].value, 5);
  assert.equal(m['命中率.hitRate'].value, 0.8);
  assert.equal(m['净节省.saved'].value, 8.25);
  assert.equal(m['净节省.savingsRate'].value, 0.55);
  assert.equal(m['缺省(上限1).perceive'].value, 6, '/分母截断取分子');
  assert.equal(m['缺省(上限1).probe'].value, 6, '同行后续百分数不得覆写前键（回溯含百分数自身的 =）');
  assert.equal(m['缺省(上限1).skipRate'].value, 0.5, '百分数归一 [0,1]');
  assert.equal(m['缺省(上限1).skipRate'].unit, 'percent');
  assert.equal(m['上限3.probe'].value, 9);
  assert.equal(m['上限3.skipRate'].value, 0.75, '臂名限定 ⇒ 不被后面的臂覆写');
  assert.equal(m['总闸关(对照).probe'].value, 0);
  assert.equal(m['总闸关(对照).skipRate'].value, 0);
});

test('W7-6 门c2: extractMetrics —— 表头负载常量键规整（（N=12 ⇒ .N 后缀）', () => {
  const m = gate.extractMetrics([
    '── W5-6/C2 级联路由节省率（N=20 次定位，主力 1/便宜 0.25）──',
    '── W5-6/C1 免看门控跳过率（N=12 步 inspect × 屏未变 × 双层 benign）──',
    '── W5-6/P2C3 增量编码 token 当量（K=18 帧混合负载，800x600 源图原生坐标）──',
  ]);
  assert.equal(m['级联路由节省率.N'].value, 20, '表头负载规模常量入档（N 变即口径变）');
  assert.equal(m['免看门控跳过率.N'].value, 12);
  assert.equal(m['当量.K'].value, 18, '空格截断键（增量编码 token 当量（K ⇒ 当量.K）');
});

test('W7-6 门d: extractMetrics —— 公式链取行末百分数（1 − a/b = 74.6% ⇒ 0.746）', () => {
  const m = gate.extractMetrics([
    '缩减率 = 1 − 2924/11520 = 74.6%（声明 >30% —— GENESIS 无数值声明，锚定任务书下限）',
    '字节当量缩减 = 1 − 3/6 = 50.0%；调用次数比 = 1.20（容差 ≤1.5）',
    '决策调用缩减 = 1 − 2/7 = 71.4%（声明档 30–50%，断言 ≥30% 下沿）',
    '感知调用缩减 = 71.4%；物理派发两臂等量（宏省决策不省工作）',
  ]);
  assert.equal(m['缩减率'].value, 0.746, '公式首数 1 被行末百分数覆写');
  assert.equal(m['字节当量缩减'].value, 0.5);
  assert.equal(m['调用次数比'].value, 1.2);
  assert.ok(Math.abs(m['决策调用缩减'].value - 0.714) < 1e-12);
  assert.ok(Math.abs(m['感知调用缩减'].value - 0.714) < 1e-12);
});

test('W7-6 门e: extractMetrics —— 污染键剔除（数字开头公式残段/比例冒号/对账行）', () => {
  const m = gate.extractMetrics([
    '分诊: keyframe=4 patch=10 scroll=2 silent=2（patch:keyframe = 10:4）',
    '全帧基线臂: 18 × 640 = 11520 tok',
    '对账: cheap 实拨 15 = 台账 15；primary 实拨 8 = 台账 3+直行 5',
    '增量臂:     keyframe 4×640 + patch/条带 364 + silent 0 = 2924 tok',
    'W1_EXEC_TUNING 缺省 poll=150ms/hamming≤2）──',
  ]);
  assert.equal(m['分诊.keyframe'].value, 4, '比例「patch:keyframe = 10:4」不得劫持 keyframe');
  assert.equal(m['分诊.patch'].value, 10);
  assert.ok(!('11520' in m) && !('2924' in m), '纯公式产物数字不立键');
  assert.ok(!('poll' in m), '150ms 值带单位后缀 ⇒ 非裸数，不立键');
  assert.ok(Object.keys(m).every((k) => !k.includes('实拨') && !k.includes('台账')), '对账行的数字残段不立键');
});

// ─── compareBenchmarks：口径分级判定 ───

type TestRec = { name: string; ok: boolean; durationMs: number | null; metrics: Record<string, { value: number; unit: string }> };
const mkTest = (name: string, ok = true, metrics: Record<string, number> = {}, durationMs: number | null = 1): TestRec => ({
  name, ok, durationMs,
  metrics: Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, { value: v, unit: 'plain' }])),
});
const mkRun = (tests: TestRec[]): { tests: TestRec[] } => ({ tests });

test('W7-6 门f: 比较器 —— 基线通过→现跑失败 = 硬红；测试失踪 = 硬红；新失败 = 硬红', () => {
  const base = mkRun([mkTest('A'), mkTest('B')]);
  const r1 = gate.compareBenchmarks(base, mkRun([mkTest('A', false), mkTest('B')]));
  assert.equal(r1.hardRed, true);
  assert.equal(r1.hardFindings[0].kind, 'regression');

  const r2 = gate.compareBenchmarks(base, mkRun([mkTest('A')]));
  assert.equal(r2.hardRed, true);
  assert.equal(r2.hardFindings[0].kind, 'missing-test');

  const r3 = gate.compareBenchmarks(base, mkRun([mkTest('A'), mkTest('B'), mkTest('C', false)]));
  assert.equal(r3.hardRed, true);
  assert.ok(r3.hardFindings.some((f: any) => f.kind === 'new-fail'));
});

test('W7-6 门g: 比较器 —— 新增通过测试 = 信息不红；基线失败→现跑通过 = 恢复信息', () => {
  const base = mkRun([mkTest('A', false)]);
  const r = gate.compareBenchmarks(base, mkRun([mkTest('A'), mkTest('N', true)]));
  assert.equal(r.hardRed, false);
  assert.equal(r.infoFindings.length, 2);
  assert.ok(r.infoFindings.some((f: any) => f.kind === 'recovered'));
  assert.ok(r.infoFindings.some((f: any) => f.kind === 'new-test'));
});

test('W7-6 门h: 比较器 —— 计数类阈值边界：|偏离| 恰好 ±15% 不告警，越线即告警（对称）', () => {
  const base = mkRun([mkTest('A', true, { m: 100 })]);
  const at = gate.compareBenchmarks(base, mkRun([mkTest('A', true, { m: 115 })]));
  assert.equal(at.warnFindings.length, 0, '+15.0% 恰在阈值内（容差含边界）');
  const atDown = gate.compareBenchmarks(base, mkRun([mkTest('A', true, { m: 85 })]));
  assert.equal(atDown.warnFindings.length, 0, '−15.0% 同理');
  const over = gate.compareBenchmarks(base, mkRun([mkTest('A', true, { m: 115.1 })]));
  assert.equal(over.warnFindings.length, 1);
  assert.equal(over.warnFindings[0].kind, 'metric-drift');
  assert.ok(Math.abs(over.warnFindings[0].dev - 0.151) < 1e-9);
  const overDown = gate.compareBenchmarks(base, mkRun([mkTest('A', true, { m: 84.9 })]));
  assert.equal(overDown.warnFindings.length, 1, '−15.1% 同样告警（方向未定，对称容差）');
  assert.equal(over.hardRed, false, '软门越线不判红');
});

test('W7-6 门i: 比较器 —— 时间类 duration_ms：±50% 边界、越线仅告警且带 volatile 标注', () => {
  const base = mkRun([mkTest('A', true, {}, 100)]);
  const at = gate.compareBenchmarks(base, mkRun([mkTest('A', true, {}, 150)]));
  assert.equal(at.warnFindings.length, 0, '+50.0% 恰在时间容差内');
  const over = gate.compareBenchmarks(base, mkRun([mkTest('A', true, {}, 151)]));
  assert.equal(over.warnFindings.length, 1);
  const f = over.warnFindings[0];
  assert.equal(f.kind, 'duration-drift');
  assert.equal(f.volatile, true, '时间类波动大 ⇒ 标注仅告警');
  assert.ok(String(f.detail).includes('仅告警'));
  assert.equal(over.hardRed, false, '时长漂移永不判红');
});

test('W7-6 门j: 比较器 —— 指标消失告警；基线为 0 走绝对偏离路径', () => {
  const base = mkRun([mkTest('A', true, { m: 1, z: 0 })]);
  const vanish = gate.compareBenchmarks(base, mkRun([mkTest('A', true, { z: 0 })]));
  assert.equal(vanish.warnFindings.length, 1);
  assert.equal(vanish.warnFindings[0].kind, 'metric-vanished');

  const zeroDrift = gate.compareBenchmarks(base, mkRun([mkTest('A', true, { m: 1, z: 2 })]));
  assert.equal(zeroDrift.warnFindings.length, 1);
  assert.equal(zeroDrift.warnFindings[0].kind, 'metric-drift-abs', '基线 0 ⇒ 相对偏离未定义，绝对偏离告警');

  const zeroStable = gate.compareBenchmarks(base, mkRun([mkTest('A', true, { m: 1, z: 0 })]));
  assert.equal(zeroStable.warnFindings.length, 0);
  assert.equal(gate.deviation(0, 5), null);
  assert.ok(Math.abs(gate.deviation(100, 90) + 0.1) < 1e-12);
});

test('W7-6 门k: 比较器 —— 全同现跑 ⇒ 零发现、门绿', () => {
  const run = mkRun([mkTest('A', true, { x: 1.5 }, 12), mkTest('B', true, { y: 0.75 }, 30)]);
  const r = gate.compareBenchmarks(run, mkRun([mkTest('A', true, { x: 1.5 }, 12), mkTest('B', true, { y: 0.75 }, 30)]));
  assert.equal(r.hardRed, false);
  assert.deepEqual(r.hardFindings, []);
  assert.deepEqual(r.warnFindings, []);
  assert.deepEqual(r.infoFindings, []);
});

// ─── envMatches：环境戳不匹配路径 ───

test('W7-6 门l: envMatches —— node/平台一致为合；差异逐项列出（供 --update 提示）', () => {
  const env = { node: '22.14.0', platform: 'win32-x64' };
  assert.deepEqual(gate.envMatches(env, { node: '22.14.0', platform: 'win32-x64' }), { ok: true, diffs: [] });
  const r1 = gate.envMatches(env, { node: '20.11.0', platform: 'win32-x64' });
  assert.equal(r1.ok, false);
  assert.equal(r1.diffs.length, 1);
  assert.ok(r1.diffs[0].includes('22.14.0') && r1.diffs[0].includes('20.11.0'));
  const r2 = gate.envMatches(env, { node: '22.14.0', platform: 'linux-x64' });
  assert.equal(r2.ok, false);
  assert.equal(r2.diffs[0], 'platform win32-x64 → linux-x64');
});
