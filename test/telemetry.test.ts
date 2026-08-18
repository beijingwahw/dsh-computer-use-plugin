// test/telemetry.test.ts
// 指标引擎：计数正确性 / noop 归因 / 分位数 / 洞见阈值 / dump-restore 往返。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { telemetry } from '../src/telemetry.ts';

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
