// test/pan124.auctionOrgan.test.ts
// ΠΑΝ-124 执法册：
//   ① subAgent.auction 平票与先占规则的确定性立法锁（P1 池不足先占律 /
//      P2 余数平票律 / P3 全零均分平票律 / P4 零出价保底律 / P5 确定性总律）
//      —— allocateQuotas 是纯函数，本册以手算例 + 重放全等锁定全部裁决点；
//   ② organCensus 漂移检测：干净进程零漂移（基线锁定）+ diffOrganCensus
//      四类事件（added/removed/layer-changed/probe-flip）的确定性执法。
// 全离线确定性。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateQuotas } from '../src/subAgent.auction.ts';
import {
  organCensus, organCensusDrift, diffOrganCensus, ORGAN_CENSUS,
  type OrganCensusShape,
} from '../src/organCensus.ts';

// ─── ① 拍卖平票/先占立法锁（纯函数手算例） ───

test('ΠΑΝ-124 P1: 池不足先占律 —— T < n 时下标升序保底前 T 个（出生序偏爱成文）', () => {
  // T=2 < n=4：保底给下标 0/1 —— 与出价无关（任何分配都是偏爱，出生序是唯一
  // 无 RNG/无时钟的偏爱源 —— 立法注释见 allocateQuotas 头注）
  assert.deepEqual(allocateQuotas([0.9, 0.1, 0.1, 0.9], 2), [1, 1, 0, 0],
    '高出价的后出生者（下标 3）不越位 —— 先占律按序不按分');
  assert.deepEqual(allocateQuotas([0, 0, 0, 0], 1), [1, 0, 0, 0]);
  assert.deepEqual(allocateQuotas([1, 1, 1], 0), [0, 0, 0], '零池全零');
});

test('ΠΑΝ-124 P2: 余数平票律 —— 小数部分全等 ⇒ 下标升序先得零头', () => {
  // bids [0.5,0.5]、T=5：保底 [1,1]、rem 3；mBids [500,500]、B=1000；
  // 份额分子 1500/1500 → floor 1/1（余 1）；小数部分 500/500 全等（平票）
  // ⇒ 下标 0 先得零头 → [3,2]
  assert.deepEqual(allocateQuotas([0.5, 0.5], 5), [3, 2]);
  // 三家全等 [0.6,0.6,0.6]、T=10：保底后 rem 7；份额 7/3 → floor 2,2,2 零头 1
  // ⇒ 平手下标 0 得 → [4,3,3]
  assert.deepEqual(allocateQuotas([0.6, 0.6, 0.6], 10), [4, 3, 3]);
});

test('ΠΑΝ-124 P3: 全零均分平票律 —— 零证据市场均分 + 零头按下标', () => {
  assert.deepEqual(allocateQuotas([0, 0, 0], 10), [4, 3, 3]);
  assert.deepEqual(allocateQuotas([0, 0, 0], 7), [3, 2, 2]);
  assert.deepEqual(allocateQuotas([0, 0], 5), [3, 2]);
});

test('ΠΑΝ-124 P4: 零出价保底律 —— 自报完成者（bid=0）每轮仍得保底 1 步', () => {
  // 保底是确认退场/收尾的机会成本（有意立法）—— 完成者不窃取比例份额
  assert.deepEqual(allocateQuotas([0.9, 0, 0], 10), [8, 1, 1]);
  assert.deepEqual(allocateQuotas([0, 0.9, 0], 10), [1, 8, 1], '保底与比例的位置无关性');
});

test('ΠΑΝ-124 P5: 确定性总律 —— 全部裁决点同输入重放全等', () => {
  const cases: Array<[number[], number]> = [
    [[0.925, 0.675, 0.8], 10],
    [[0.5, 0.5], 5], [[0.6, 0.6, 0.6], 10],
    [[0, 0, 0], 10], [[0.9, 0, 0], 10],
    [[0.9, 0.1, 0.1, 0.9], 2], [[1, 1, 1], 0], [[], 5],
    [[0.333, 0.333, 0.333, 0.333], 7],   // 四家全等：余数平票重灾区
    [[0.125, 0.375, 0.5, 0.25], 3],      // 池不足 + 非平凡出价
  ];
  for (const [bids, total] of cases) {
    const a1 = allocateQuotas([...bids], total);
    const a2 = allocateQuotas([...bids], total);
    assert.deepEqual(a1, a2, `重放全等（${JSON.stringify(bids)} @ T=${total}）`);
    // 守恒律：n>0 时 Σ配额 = floor(max(0,T))（T≥n 全额分完；T<n 保底前 T 个）；
    // n=0 时空输出。
    const sum = a1.reduce((s, x) => s + x, 0);
    const expectedSum = bids.length > 0 ? Math.max(0, Math.floor(total)) : 0;
    assert.equal(sum, expectedSum, `分配总额守恒（Σ=${sum}，期望 ${expectedSum}）`);
  }
});

// ─── ② organCensus 漂移检测 ───

test('ΠΑΝ-124: 干净进程零漂移 —— 基线 = 模块装载时的册面形状', () => {
  assert.deepEqual(organCensusDrift(), [], '册面未被运行时改动 ⇒ 零事件');
});

test('ΠΑΝ-124: diffOrganCensus 四类事件 + 确定性输出序', () => {
  const prev: OrganCensusShape[] = [
    { id: 'alpha', layer: '感知', static: false },
    { id: 'beta', layer: '决策', static: true },
    { id: 'gamma', layer: '记忆', static: true },
  ];
  const cur: OrganCensusShape[] = [
    { id: 'alpha', layer: '运动', static: false },          // layer-changed
    { id: 'beta', layer: '决策', static: false },           // probe-flip（static→探针）
    { id: 'delta', layer: '知识', static: true },           // added
    // gamma 被裁撤 ⇒ removed
  ];
  const events = diffOrganCensus(prev, cur);
  assert.deepEqual(events.map(e => `${e.kind}:${e.id}`).sort(), [
    'layer-changed:alpha', 'probe-flip:beta', 'organ-added:delta', 'organ-removed:gamma',
  ].sort(), '四类事件各就位');
  assert.deepEqual(events, diffOrganCensus(prev, cur), '确定性（重放全等）');
  for (const e of events) assert.ok(e.detail.length > 0, `事件归因非空（${e.kind}）`);
  // 空输入与完全相同输入的边界
  assert.deepEqual(diffOrganCensus([], []), []);
  assert.deepEqual(diffOrganCensus(prev, prev), []);
});

test('ΠΑΝ-124: organCensus 快照口径一致（total = 册长；healthy + degraded = total）', () => {
  const snap = organCensus();
  assert.equal(snap.total, ORGAN_CENSUS.length);
  assert.equal(snap.healthy + snap.degraded.length, snap.total, '账面守恒');
});
