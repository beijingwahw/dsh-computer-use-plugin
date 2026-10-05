// test/pan120.arbitration.test.ts
// ΠΑΝ-120 执法册：仲裁 0.5 共识阈值的经验基线定标 + 语义锚的长度归一化。
//   ① 定标原子：calibratedConsensusThreshold 确定性、值域、分离性
//      （阈 > 零假设全体、阈 ≤ 备择全体 —— 分布分离不变量）；
//   ② 行为修复：旧阈 0.5 误判冲突的同义改写对（实测余弦 0.30~0.49）今判
//      consensus —— 修复的执法面（不是回归兼容面）；
//   ③ 冲突平票：score 全等 ⇒ taskId 字典序（确定性立法）；
//   ④ 语义锚定：短标签 vs 长文本的遏制度量（长度归一化）——证据臂不再
//      常年降级；EvidenceBackedArbitrator 的硬证据改判端到端可达；
//   ⑤ 无关对仍判 conflict（定标不放水）。
// 全离线确定性：零网络、零时钟、零随机。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConfidenceWeightedArbitrator,
  EvidenceBackedArbitrator,
  semanticAnchorMatch,
  calibratedConsensusThreshold,
  ARBITRATION_CALIBRATION,
} from '../src/subAgent.arbitration.ts';
import type { SubAgentReport } from '../src/subAgent.ts';
import { embed, cosine } from '../src/semanticHash.ts';

/** 与实现独立的分位数复算（线性插值 —— 测试侧对照实现） */
function quantileT(sorted: number[], q: number): number {
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

test('ΠΑΝ-120: 定标阈值 —— 确定性、值域夹取、与语料分布的分离不变量', () => {
  const t1 = calibratedConsensusThreshold();
  const t2 = calibratedConsensusThreshold();
  assert.equal(t1, t2, '同语料同引擎 ⇒ 恒同输出（记忆化 + FNV 确定性）');
  assert.ok(t1 >= 0.2 && t1 <= 0.5, `阈值夹在 [0.2, 0.5]（实测 ${t1}）`);

  // 分离不变量：阈在零假设分布上尾之上、备择分布下尾之下（或重合带内取中点）
  const nulls = ARBITRATION_CALIBRATION.nullPairs
    .map(([a, b]) => cosine(embed(a), embed(b))).sort((x, y) => x - y);
  const positives = ARBITRATION_CALIBRATION.positivePairs
    .map(([a, b]) => cosine(embed(a), embed(b))).sort((x, y) => x - y);
  const expected = Math.max(0.2, Math.min(0.5,
    (quantileT(nulls, 0.9) + quantileT(positives, 0.1)) / 2));
  assert.ok(Math.abs(t1 - Math.round(expected * 1000) / 1000) < 1e-9,
    `阈值 = (q90(null)+q10(pos))/2 夹取（独立复算 ${expected.toFixed(4)}，实测 ${t1}）`);
  assert.ok(t1 > nulls[nulls.length - 1]!,
    `阈值必须高于零假设最大值 ${nulls[nulls.length - 1]!.toFixed(3)}（语料编辑破坏分离性 ⇒ 测试红）`);
  assert.ok(t1 < positives[0]!,
    `阈值必须低于备择最小值 ${positives[0]!.toFixed(3)}（真共识不漏判的地板）`);
});

test('ΠΑΝ-120: 旧阈 0.5 误判冲突的同义改写对（余弦 0.30~0.49）今判 consensus', async () => {
  // 语料中实测余弦最低的备择对：0.304 —— 旧阈 0.5 判 conflict，定标后过阈
  const reports: SubAgentReport[] = [
    { taskId: 'p1', status: 'completed', findings: 'the page finished loading and shows logged in', confidence: 0.8, stepsUsed: 3 },
    { taskId: 'p2', status: 'completed', findings: 'login succeeded and the page load completed', confidence: 0.8, stepsUsed: 3 },
  ];
  const arb = await new ConfidenceWeightedArbitrator().arbitrate(reports);
  const agreement = arb.crossValidation[0]!.agreement;
  assert.ok(agreement < 0.5, `fixture 必须是旧阈的漏判形态（实测 ${agreement} < 0.5）`);
  assert.equal(arb.verdict, 'consensus', `定标阈 ${calibratedConsensusThreshold()} 下真共识不再误判`);
  assert.ok(arb.rationale.includes('calibrated'), '裁决归因披露定标阈（透明面）');
});

test('ΠΑΝ-120: 无关对仍判 conflict（定标不放水）+ 归因保留', async () => {
  const reports: SubAgentReport[] = [
    { taskId: 'f1', status: 'completed', findings: '打开浏览器导航到新闻网站浏览头条', confidence: 0.9, stepsUsed: 3 },
    { taskId: 'f2', status: 'completed', findings: '在 Excel 中筛选数据并保存报表', confidence: 0.6, stepsUsed: 3 },
  ];
  const arb = await new ConfidenceWeightedArbitrator().arbitrate(reports);
  assert.equal(arb.verdict, 'conflict');
  assert.equal(arb.winner, 'f1', '置信 0.9 胜出（同侪一致性同低 ⇒ 置信定胜负）');
  assert.ok(arb.crossValidation[0]!.agreement < calibratedConsensusThreshold());
});

test('ΠΑΝ-120: 冲突评分平票 ⇒ taskId 字典序（确定性立法，不依赖排序稳定性）', async () => {
  // 两报告同置信、findings 互不相关（meanPeer 同为低值）⇒ score 完全相等
  const mk = (taskId: string, findings: string): SubAgentReport =>
    ({ taskId, status: 'completed', findings, confidence: 0.5, stepsUsed: 1 });
  const a = await new ConfidenceWeightedArbitrator().arbitrate([
    mk('b-task', '检查系统托盘的更新通知'), mk('a-task', '搜索最近的意大利餐厅'),
  ]);
  assert.equal(a.verdict, 'conflict');
  assert.equal(a.winner, 'a-task', 'score 平票 ⇒ taskId 字典序先者（立法面）');
  // 同输入重放全等（确定性）
  const b = await new ConfidenceWeightedArbitrator().arbitrate([
    mk('b-task', '检查系统托盘的更新通知'), mk('a-task', '搜索最近的意大利餐厅'),
  ]);
  assert.deepEqual(a, b);
});

test('ΠΑΝ-120: 语义锚定长度归一化 —— 短标签对长文本不再被余弦压低', () => {
  const claim = 'We examined the competitor landing page carefully; the pricing table lists ' +
    'three tiers and the enterprise plan requires contacting sales, while the footer links ' +
    'to a separate comparison page.';
  const evidence = {
    taskId: 'v', subject: 'pricing',
    regions: [
      { label: 'pricing-table', bbox: { x0: 0.1, y0: 0.1, x1: 0.6, y1: 0.4 } },
      { label: 'login-form', bbox: { x0: 0.7, y0: 0.7, x1: 0.9, y1: 0.9 } },
    ],
    confidence: 0.9,
  };
  const m = semanticAnchorMatch({ taskId: 'c1', text: claim }, evidence);
  assert.ok(m !== null && m >= 0.5,
    `证据臂达标（实测 ${m}；对称余弦实测 0.338 —— 旧实现常年 <0.5 降级）`);
  // 阴性：无关标签（遏制 0.278）仍低于采信阈 —— 长度归一化不是放水
  const neg = semanticAnchorMatch(
    { taskId: 'c2', text: '打开浏览器导航到新闻网站浏览头条' }, evidence);
  assert.ok(neg !== null && neg < 0.5, `无关标签不采信（实测 ${neg}）`);
  // 无区域 ⇒ null（证据不适用 —— 旧语义保持）
  assert.equal(semanticAnchorMatch({ taskId: 'c3', text: claim }, { ...evidence, regions: [] }), null);
});

test('ΠΑΝ-120: EvidenceBackedArbitrator 硬证据改判端到端可达（缺省锚定面）', async () => {
  // 冲突 fixture：中英无关对（agreement ≈ 0 ⇒ conflict）；基础胜者 = t1（置信高）。
  // 验证代理引用 'pricing-table' 区域 —— 缺省 semanticAnchorMatch（含遏制度量）
  // 对 t2 的长声明锚定达标、对 t1 不锚定 ⇒ adjudicated 改判 t2。
  const reports: SubAgentReport[] = [
    { taskId: 't1', status: 'completed', findings: '打开浏览器导航到新闻网站浏览头条', confidence: 0.9, stepsUsed: 3 },
    { taskId: 't2', status: 'completed', findings: 'We examined the competitor landing page; ' +
      'the pricing table lists three tiers and the enterprise plan requires contacting sales.', confidence: 0.6, stepsUsed: 3 },
  ];
  const arb = await new EvidenceBackedArbitrator({
    runVerifier: () => ({
      taskId: 'verifier-1', subject: 'pricing',
      regions: [{ label: 'pricing-table', bbox: { x0: 0.1, y0: 0.1, x1: 0.6, y1: 0.4 } }],
      confidence: 0.95,
    }),
  }).arbitrate(reports);
  assert.equal(arb.verdict, 'adjudicated', `证据臂触发（旧对称余弦 0.338 < 0.5 ⇒ 恒降级）`);
  assert.equal(arb.winner, 't2', '硬证据压倒置信分：锚定候选胜出');
  assert.ok(arb.evidence!.perCandidate.some(p => p.taskId === 't1' && (p.match ?? 0) < 0.5),
    '非锚定候选的 match 低于采信阈（归因完整）');
});
