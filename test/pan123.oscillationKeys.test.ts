// test/pan123.oscillationKeys.test.ts
// ΠΑΝ-123 执法册：oscillationTracker 有界化 —— 键域 LRU + 上界。
//   ① 缺省键 '' 旧行为逐字节兼容（单环语义 —— 既有消费方 actionVerifier 零改动）；
//   ② 键域隔离：任务 A 的振荡环不与任务 B 串扰（C1-2 L7 的病灶面）；
//   ③ 键数上界 MAX_RINGS：任意多键 ⇒ 在册键数恒 ≤ 上界（内存 = 键数×环容，
//      常量级上界）；
//   ④ 真 LRU（非 FIFO）：活跃键的位序刷新 ⇒ 挤出的是最久未用键；
//   ⑤ reset(key) 定点清 / reset() 全清（插件卸载语义不变）。
// 全离线确定性：64 位指纹字面量、零内核注册（缺省常量路径）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { oscillationTracker } from '../src/oscillationTracker.ts';

const H1 = '0'.repeat(32) + '1'.repeat(32);
const H2 = '1'.repeat(32) + '0'.repeat(32);
/** 与 H1/H2 汉明距离 ≥24 的互异指纹（场景切换级差异 —— 不参与任何环匹配） */
const distinct = (i: number): string =>
  ((i * 0x9E3779B97F4A7C15 >>> 0).toString(2).padStart(32, '0') +
   (i * 0x85EBCA6B779B9101 >>> 0).toString(2).padStart(32, '0')).slice(0, 64);

beforeEach(() => { oscillationTracker.reset(); });

test('ΠΑΝ-123: 缺省键（""）旧行为逐字节兼容 —— 单环语义零回归', () => {
  // 同指纹 3 次 ⇒ 第 3 次告警（既有 safetySystems 语义）
  let alarm: string | null = null;
  for (let i = 0; i < 3; i++) alarm = oscillationTracker.observe(H1);
  assert.ok(alarm, '同指纹第 3 次观测告警（旧判据 p=1）');
  // 告警后清环：同指纹再观测不告警
  assert.equal(oscillationTracker.observe(H1), null);
  // 双态振荡（A→B→A→B…）：第三个完整周期块告警（既有 E-3 语义）
  alarm = null;
  for (let i = 0; i < 6; i++) alarm = oscillationTracker.observe(i % 2 === 0 ? H1 : H2);
  assert.ok(alarm && /2-state/.test(alarm), '双态振荡告警（键域化不改判据）');
  assert.equal(oscillationTracker.ringCount(), 1, '缺省键在册（单键）');
});

test('ΠΑΝ-123: 键域隔离 —— 任务 A 的环不与任务 B 串扰', () => {
  // 任务 A：双态振荡进行到一半（3 帧）
  for (let i = 0; i < 3; i++) oscillationTracker.observe(i % 2 === 0 ? H1 : H2, 'taskA');
  // 任务 B：完全无关的互异指纹 —— 不吃 A 的环、不告警
  for (let i = 0; i < 5; i++) {
    assert.equal(oscillationTracker.observe(distinct(i + 100), 'taskB'), null,
      `B 的第 ${i + 1} 帧不因 A 的振荡史误报（旧单环会跨任务比对）`);
  }
  assert.equal(oscillationTracker.ringCount(), 2);
  // 任务 A 继续：第 6 帧（A1 B1 A1 B1 A1 B1 ⇒ 3 完整周期）告警 —— B 的观测不稀释 A 的环
  let alarm: string | null = null;
  for (let i = 3; i < 6; i++) alarm = oscillationTracker.observe(i % 2 === 0 ? H1 : H2, 'taskA');
  assert.ok(alarm, 'A 环独立判振荡（不被 B 的帧挤掉窗口）');
});

test('ΠΑΝ-123: 键数上界 —— 任意多键在册恒 ≤ MAX_RINGS（8）', () => {
  for (let i = 0; i < 40; i++) oscillationTracker.observe(distinct(i), `k${i}`);
  assert.ok(oscillationTracker.ringCount() <= 8,
    `在册键数有上界（实测 ${oscillationTracker.ringCount()} ≤ 8 —— 内存上界 = 键数×环容）`);
});

test('ΠΑΝ-123: 真 LRU —— 挤出最久未用键，活跃键存活（非 FIFO 插入序逐出）', () => {
  // k0 环蓄双态序列 2 帧（无告警）→ 7 个他键入册（共 8，未超界）→ k0 再观测
  // 刷新位序（3 帧交替，仍无告警）→ 新键入册超界 ⇒ 逐出最久未用的 k1（非 k0）
  // → k0 环带历史存活：补满 3 个完整周期（6 帧）告警。FIFO 实现会在超界时
  // 逐出 k0（插入最早），其环历史丢失 ⇒ 6 帧判据永不满足 ⇒ 本断言红。
  oscillationTracker.observe(H1, 'k0');
  oscillationTracker.observe(H2, 'k0');
  for (let i = 1; i <= 7; i++) oscillationTracker.observe(distinct(i), `k${i}`);
  assert.equal(oscillationTracker.ringCount(), 8);
  assert.equal(oscillationTracker.observe(H1, 'k0'), null, '3 帧交替不告警（周期 2 需 6 帧）');
  oscillationTracker.observe(distinct(99), 'k-new');           // 超界 ⇒ 逐出 k1（最久未用）
  assert.equal(oscillationTracker.ringCount(), 8, '上界维持');
  let alarm: string | null = null;
  alarm = oscillationTracker.observe(H2, 'k0');                // k0 环 4 帧
  assert.equal(alarm, null);
  alarm = oscillationTracker.observe(H1, 'k0');                // 5 帧
  assert.equal(alarm, null);
  alarm = oscillationTracker.observe(H2, 'k0');                // 6 帧 = 3 完整周期 ⇒ 告警
  assert.ok(alarm && /2-state/.test(alarm),
    '活跃键的环不被逐出（LRU 位序刷新执法 —— FIFO 下此环已被清）');
});

test('ΠΑΝ-123: LRU 逐出证据 —— 被逐出的键以全新环重启（历史不复活）', () => {
  oscillationTracker.observe(H1, 'victim');
  oscillationTracker.observe(H1, 'victim');                    // victim 环 2 帧在册
  for (let i = 0; i < 8; i++) oscillationTracker.observe(distinct(i + 50), `push${i}`); // victim 被逐出
  // victim 重新观测：环是全新的（1 帧）⇒ 不告警。若环未被逐出（3 帧齐）会告警。
  assert.equal(oscillationTracker.observe(H1, 'victim'), null,
    '被逐出键的观测史不复活（键域有界化的正确语义）');
});

test('ΠΑΝ-123: reset(key) 定点清 / reset() 全清', () => {
  for (let i = 0; i < 3; i++) oscillationTracker.observe(H1, 'a');
  assert.equal(oscillationTracker.ringCount() >= 1, true);
  oscillationTracker.reset('a');                               // 定点清
  assert.equal(oscillationTracker.observe(H1, 'a'), null, '清后重判（环归零）');
  oscillationTracker.observe(H1, 'b');
  oscillationTracker.reset();                                  // 全清
  assert.equal(oscillationTracker.ringCount(), 0, '全清（插件卸载语义）');
});
