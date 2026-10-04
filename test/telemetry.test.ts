// test/telemetry.test.ts
// 指标引擎：计数正确性 / noop 归因 / 分位数 / 洞见阈值 / dump-restore 往返。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { telemetry, Ring } from '../src/telemetry.ts';

beforeEach(() => telemetry.reset());

test('observe: 成败计数与全局汇总', () => {
  telemetry.observe('click_mouse', 'SUCCESS', 100);
  telemetry.observe('click_mouse', 'SUCCESS', 300);
  telemetry.observe('click_mouse', 'FAILED', 200);
  const snap = telemetry.snapshot();
  assert.equal(snap.global.calls, 3);
  assert.equal(snap.global.successes, 2);
  assert.equal(snap.global.success_rate, 66.7);
  const click = snap.tools.find(t => t.tool === 'click_mouse');
  assert.equal(click?.p50_ms, 200); // 3 样本 [100,200,300] 的中位数
  assert.equal(click?.p95_ms, 300);
});

test('observe: noop 只归因到 SUCCESS 且 detected=false 的调用', () => {
  telemetry.observe('click_mouse', 'SUCCESS', 50, true);
  telemetry.observe('click_mouse', 'FAILED', 50, true); // 失败不计 noop（避免双重惩罚）
  const snap = telemetry.snapshot();
  assert.equal(snap.global.noops, 1);
});

test('note: 命中率计数器', () => {
  telemetry.note('ui_memory', true);
  telemetry.note('ui_memory', true);
  telemetry.note('ui_memory', false);
  const c = telemetry.snapshot().counters.find(x => x.counter === 'ui_memory');
  assert.equal(c?.hit_rate, 66.7);
});

test('insights: noop 率 >= 40% 且样本 >= 5 才点名', () => {
  for (let i = 0; i < 5; i++) telemetry.observe('type_text', 'SUCCESS', 30, /* noop */ i < 4);
  const ins = telemetry.insights();
  assert.ok(ins.some(s => s.includes('HIGH NO-OP') && s.includes('type_text')));

  telemetry.reset();
  for (let i = 0; i < 4; i++) telemetry.observe('type_text', 'SUCCESS', 30, true); // 样本不足
  assert.equal(telemetry.insights().length, 0);
});

test('dump/restore: 计数跨快照保留', () => {
  telemetry.observe('click_mouse', 'SUCCESS', 120);
  telemetry.note('skill', true);
  const dump = telemetry.dump();
  telemetry.reset();
  telemetry.restore(dump);
  const snap = telemetry.snapshot();
  assert.equal(snap.global.calls, 1);
  assert.equal(snap.counters[0]?.hits, 1);
});

// ─── ΝΩ-24：头指针环形数组（定长复用）与旧 push/shift 实现等价 ───

/** 确定性伪随机（LCG —— 逐值对照序列的可复现源） */
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

test('ΝΩ-24: Ring 头指针环形与旧 push/shift 实现逐步逐值等价', () => {
  const ring = new Ring(8);
  const ref: number[] = []; // 旧实现：push + 超容 shift 头删
  const rand = lcg(42);
  for (let i = 0; i < 64; i++) {
    const v = Math.round(rand() * 1000);
    ring.push(v);
    ref.push(v);
    if (ref.length > 8) ref.shift();
    assert.deepEqual(ring.toArray(), ref, `step ${i}: 时间序展开与旧实现一致`);
    assert.equal(ring.length, ref.length, `step ${i}: 长度一致`);
  }
  // 未满员阶段（容量内）与普通数组同构
  const young = new Ring(64);
  for (const v of [3, 1, 2]) young.push(v);
  assert.deepEqual(young.toArray(), [3, 1, 2]);
});

test('ΝΩ-24: 环形延迟分位数值等价 —— 800 样本（>512 容量）对照旧实现', () => {
  const ref: number[] = [];
  const rand = lcg(7);
  for (let i = 0; i < 800; i++) {
    const ms = Math.round(rand() * 500);
    telemetry.observe('ring_tool', 'SUCCESS', ms);
    ref.push(Math.round(ms));
    if (ref.length > 512) ref.shift();
  }
  assert.equal(ref.length, 512, '对照实现恰好保留最近 512 样本');
  const t = telemetry.snapshot().tools.find(x => x.tool === 'ring_tool');
  assert.ok(t, 'tool stats 在场');
  const sorted = [...ref].sort((a, b) => a - b); // snapshot() 的排序语义保持
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  assert.equal(t!.p50_ms, pct(50), 'p50 与旧实现数值等价');
  assert.equal(t!.p95_ms, pct(95), 'p95 与旧实现数值等价');
  assert.equal(t!.p99_ms, pct(99), 'p99 与旧实现数值等价');
});

test('ΝΩ-24: outcomeRing 环形化后 CUSUM 观测流语义保持（时间序结局环）', () => {
  // 100 次确定结局：前 90 成功、后 10 失败 ⇒ 64 容量环只保留最近 64 个
  //（54 成功 + 10 失败）；终身计数器不受环滑动影响（calls=100, failures=10）
  for (let i = 0; i < 100; i++) {
    telemetry.observe('osc_tool', i < 90 ? 'SUCCESS' : 'FAILED', 10);
  }
  const snap = telemetry.snapshot();
  const t = snap.tools.find(x => x.tool === 'osc_tool');
  assert.equal(t!.calls, 100, '终身计数 append-only（环形化不触碰计数器）');
  assert.equal(snap.global.failures, 10);
  // regimeShifts 的环前终身基线依赖环内容正确：环内失败 10/64，环前史
  // (10-10)/(100-64)=0 ⇒ 环滑动后基线仍稳定（旧实现同值）；末段 10 连败
  // ⇒ CUSUM 恶化臂必然告警（时间序环语义的强断言）
  const shifts = telemetry.regimeShifts();
  const osc = shifts.find(s => s.tool === 'osc_tool');
  assert.ok(osc, '末段 10 连败 ⇒ 恶化臂告警（环时间序正确）');
  assert.equal(osc!.baselineSource, 'lifetime', '环前史 36 ≥ 8 ⇒ 终身基线');
  assert.equal(osc!.direction, 'up');
});
