// test/actionVerifier.effect.test.ts
// W6R-B6 补强：actionVerifier.effect 分区（W6-2 自 actionVerifier.ts 提取）的单测 ——
// reportEffect 三态判决（true/false/null）与 Δ-7 指纹退化诚实降级：
//   ① 真判决两态：相同指纹 ⇒ false（sim=100/d=0）；互补指纹 ⇒ true（sim=0/d=64）；
//   ② 阈值语义：effect_detected = sim < noopThreshold 的严格小于（相等 ⇒ 无变化），
//      邻近阈值三点扫（0.98/0.984375/0.99）+ 中程相似度阈值扫；
//   ③ 退化三形态 → null + unverifiable 原因：
//      absent（空串，归一化**前**检查 —— hexToBits 会把 '' 回退成全零位串）、
//      zero（hex 全零 / 位串全零 / 损坏 hex 的回退值；ΝΩ-24 起非 16 位 hex 同律 ——
//        hexToBits 长度校验非法返 null，normalizeHash 防御收敛全零）、
//      length（归一化后长度不等：位串域与 hex 域各一例）；
//   ④ 优先序 absent > zero > length（分支序锁定）；
//   ⑤ 证据保留：退化时 distance/similarity_pct 照报原始测量值（含 absent-both
//      报 100/0 的边界假信号演示），但判决资格已被 null 否决；
//   ⑥ 域等价：hex 输入与等值位串输入产出深度等同报告（normalizeHash 宽容归一）。
// 全离线确定性：reportEffect 是纯函数，零注入零 IO。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reportEffect, type EffectReport } from '../src/actionVerifier.effect.ts';

// ─── 夹具指纹（64 位域；hex 16 位 = 位串 64 位）───
const H_SAME = 'abcd1234abcd1234';
const H_A = '0123456789abcdef';
const H_B = 'fedcba9876543210'; // 与 H_A 逐位互补（hexToBits 后距离 64）
const BITS_A = '01'.repeat(32);                              // 位串域基样
const BITS_FLIP1 = '01'.repeat(31) + '00';                   // 距 BITS_A 恰 1 位
const BITS_FLIP20 = BITS_A.slice(0, 44) +
  BITS_A.slice(44).split('').map(c => (c === '0' ? '1' : '0')).join(''); // 距 20 位

// ═══ ① 真判决两态 ═══

test('W6R-effect①a: 相同指纹 ⇒ 无变化判决 —— sim 100 / 距离 0 / unverifiable 键缺席', () => {
  const r = reportEffect(H_SAME, H_SAME, 0.98);
  assert.deepEqual(r, { effect_detected: false, similarity_pct: 100, distance: 0 });
  assert.equal('unverifiable' in r, false, '健康报告不携带退化原因键');
  assert.deepEqual(Object.keys(r).sort(), ['distance', 'effect_detected', 'similarity_pct'],
    '健康报告键集精确（无幽灵键）');
});

test('W6R-effect①b: 互补指纹 ⇒ 有变化判决 —— sim 0 / 距离 64（hex 域全异边界）', () => {
  const r = reportEffect(H_A, H_B, 0.98);
  assert.deepEqual(r, { effect_detected: true, similarity_pct: 0, distance: 64 });
});

// ═══ ② 阈值语义（严格小于）═══

test('W6R-effect②a: 1 位噪声 = 同帧 —— sim 98.4/距离 1 在 0.98 阈下判 false', () => {
  const r = reportEffect(BITS_A, BITS_FLIP1, 0.98);
  assert.deepEqual(r, { effect_detected: false, similarity_pct: 98.4, distance: 1 },
    'sim = 63/64 = 0.984375 ≥ 0.98 ⇒ 无变化（微扰不误报）');
});

test('W6R-effect②b: 阈值三点扫 —— 相等判 false（严格小于语义）、略高判 true', () => {
  // sim 恰 0.984375：threshold 相等 ⇒ false；0.99 ⇒ true
  assert.equal(reportEffect(BITS_A, BITS_FLIP1, 0.984375).effect_detected, false,
    'sim === threshold ⇒ 不算变化（< 严格语义，闭下界属于无变化）');
  assert.equal(reportEffect(BITS_A, BITS_FLIP1, 0.99).effect_detected, true,
    'sim 0.984375 < 0.99 ⇒ 变化');
});

test('W6R-effect②c: 中程相似度（距 20 ⇒ sim 0.6875）阈值扫 + 一位小数舍入 68.8', () => {
  const r = reportEffect(BITS_A, BITS_FLIP20, 0.7);
  assert.deepEqual(r, { effect_detected: true, similarity_pct: 68.8, distance: 20 },
    'Math.round(0.6875×1000)/10 = 68.8（一位小数锁定）');
  assert.equal(reportEffect(BITS_A, BITS_FLIP20, 0.6875).effect_detected, false,
    '相等阈值 ⇒ false');
  assert.equal(reportEffect(BITS_A, BITS_FLIP20, 0.6).effect_detected, false,
    'sim 0.6875 ≥ 0.6 ⇒ 无变化');
});

// ═══ ③ 退化三形态 → null ═══

test('W6R-effect③a: absent —— 前侧/后侧空串 ⇒ null + absent（归一化前检查的证据）', () => {
  const rb = reportEffect('', 'ffffffffffffffff', 0.98);
  assert.equal(rb.effect_detected, null);
  assert.equal(rb.unverifiable, 'absent');
  const ra = reportEffect('ffffffffffffffff', '', 0.98);
  assert.equal(ra.effect_detected, null);
  assert.equal(ra.unverifiable, 'absent');
});

test('W6R-effect③b: zero —— hex 全零归一化后全零 ⇒ null + zero', () => {
  const r = reportEffect('0000000000000000', 'ffffffffffffffff', 0.98);
  assert.equal(r.effect_detected, null);
  assert.equal(r.unverifiable, 'zero', 'hex 全零与损坏 hex 的回退值不可区分 —— 信息量为零');
});

test('W6R-effect③c: zero —— 位串全零同律；损坏 hex 经 hexToBits 回退全零亦同律', () => {
  assert.equal(reportEffect('0'.repeat(64), '1'.repeat(64), 0.98).unverifiable, 'zero');
  const corrupt = reportEffect('zzzz-not-hex', H_A, 0.98);
  assert.equal(corrupt.effect_detected, null);
  assert.equal(corrupt.unverifiable, 'zero', "BigInt('0xzzzz…') 抛错 → '0'.repeat(64) 回退");
});

test('W6R-effect③d: length —— 归一化后位长不等（位串域与 hex 域各一例）⇒ null + length', () => {
  const bits = reportEffect(BITS_A, '01'.repeat(16), 0.98);
  assert.equal(bits.effect_detected, null);
  assert.equal(bits.unverifiable, 'length');
  assert.equal(bits.distance, 64, 'hammingDistance 长度不齐取 max(len) —— 保守最大距离');
  assert.equal(bits.similarity_pct, 0, '旧实现据此虚报 effect_detected=true 的假阳性面，今以 null 否决');
  // ΝΩ-24：非 16 位 hex 不再产出错误长度的位串（旧 '01234567' → 32 位串走
  // length 臂），而是判非法收敛全零（zero 保守臂 —— 判决仍 null，原因码
  // 从 length 迁到 zero，与 Δ-7 保守律同向）；hex 域的长度不等例改由
  // 「位串 vs 合法 16-hex（64 位展开）」承载，判决语义零回归。
  const shortHex = reportEffect(H_A, '01234567', 0.98);
  assert.equal(shortHex.unverifiable, 'zero', 'ΝΩ-24：8 位 hex（截断）⇒ 非法 → 全零哨兵（zero 臂）');
  assert.equal(shortHex.effect_detected, null, '判决仍无法判定（保守律不回归）');
  const hex = reportEffect('01'.repeat(16), 'ffffffffffffffff', 0.98);
  assert.equal(hex.unverifiable, 'length', '32 位位串 vs 64 位（16-hex 展开）⇒ length');
  assert.equal(hex.effect_detected, null);
});

// ═══ ④ 优先序 absent > zero > length ═══

test('W6R-effect④: 退化优先序 —— 双侧退化时 absent 压过 zero（分支序锁定）', () => {
  // before='' 同时 after=hex 全零：absent（空串）与 zero（全零）同场 ⇒ absent 胜出
  assert.equal(reportEffect('', '0000000000000000', 0.98).unverifiable, 'absent');
  assert.equal(reportEffect('0000000000000000', '', 0.98).unverifiable, 'absent');
});

// ═══ ⑤ 证据保留：退化时测量值照报 ═══

test('W6R-effect⑤a: absent 退化仍报原始测量（距 64/sim 0）—— 证据保留、判决资格否决', () => {
  const r: EffectReport = reportEffect('', 'ffffffffffffffff', 0.98);
  assert.deepEqual(
    { effect_detected: r.effect_detected, similarity_pct: r.similarity_pct, distance: r.distance, unverifiable: r.unverifiable },
    { effect_detected: null, similarity_pct: 0, distance: 64, unverifiable: 'absent' },
    '空串经回退成全零后与全 1 位串比对：测量面照报，仅判决被 null 否决');
});

test('W6R-effect⑤b: 边界假信号演示 —— absent-both 报 sim 100/距离 0，却判 null 而非 false', () => {
  const r = reportEffect('', '', 0.98);
  assert.deepEqual(
    { effect_detected: r.effect_detected, similarity_pct: r.similarity_pct, distance: r.distance },
    { effect_detected: null, similarity_pct: 100, distance: 0 },
    '两侧皆空 ⇒ 回退指纹逐位相同（sim=1）：旧实现会当真判「无变化」，Δ-7 以 null 降级');
});

// ═══ ⑥ 域等价（normalizeHash 宽容归一）═══

test('W6R-effect⑥: hex 输入与等值位串输入产出深度等同报告（混合部署宽容性）', () => {
  const viaHex = reportEffect('ffffffffffffffff', 'ffffffffffffffff', 0.98);
  const viaBits = reportEffect('1'.repeat(64), '1'.repeat(64), 0.98);
  assert.deepEqual(viaHex, viaBits);
  assert.deepEqual(viaBits, { effect_detected: false, similarity_pct: 100, distance: 0 });
});
