// test/w2swarm.test.ts
// W2-4：subAgent 协作包 —— G1 租约黑板 + G4 实证仲裁。
// 全部离线确定性：步数 TTL（无时钟）、注入端口（无网络/无嵌套 LLM）、纯函数锚定。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { journal } from '../src/journal.ts';
import {
  coordinator,
  ConfidenceWeightedArbitrator,
  EvidenceBackedArbitrator,
  mintVerifierMission,
  semanticAnchorMatch,
  geometricAnchorMatch,
  anchorIoU,
  type SubAgentReport,
  type EvidenceAnchorPort,
  type VerifierEvidence,
  type AnchoredRegion,
  type VerifiableClaim,
} from '../src/subAgent.ts';

beforeEach(() => {
  journal.reset();
  coordinator.reset();
  coordinator.configure(3, 10);
});

// ─── G1：租约黑板 ───

test('W2-4 G1: claim 认领 + 黑板只读视图（默认 TTL 5 步）', () => {
  coordinator.spawn([
    { id: 'a1', role: '调研员', objective: 'o', maxSteps: 5 },
    { id: 'a2', role: '调研员', objective: 'o', maxSteps: 5 },
  ]);
  const res = coordinator.claim('a1', '竞品A定价调研');
  assert.deepEqual(res, { ok: true });
  const board = coordinator.blackboard();
  assert.equal(board.length, 1);
  assert.equal(board[0].kind, 'claim');
  assert.equal(board[0].claimant, 'a1');
  assert.equal(board[0].subject, '竞品A定价调研');
  assert.equal(board[0].ttl, 5, '缺省 claim 租约 5 步');
});

test('W2-4 G1: 撞租约即让位换目标（语义重叠 ≥0.5 判撞）', () => {
  coordinator.spawn([
    { id: 'a1', role: 'A', objective: 'o', maxSteps: 5 },
    { id: 'a2', role: 'B', objective: 'o', maxSteps: 5 },
  ]);
  assert.equal(coordinator.claim('a1', '竞品A定价调研').ok, true);
  // a2 撞语义重叠主题（余弦 0.917 ≥ 0.5）⇒ 让位，结果带回持有者供改道
  const hit = coordinator.claim('a2', '竞品B定价调研');
  assert.deepEqual(hit, {
    ok: false, reason: 'lease-conflict', holder: 'a1',
    holderSubject: '竞品A定价调研', holderTtl: 5,
  });
  // 换目标（余弦 0.000）⇒ 认领成功
  assert.equal(coordinator.claim('a2', '整理本地音乐文件夹').ok, true);
  assert.equal(coordinator.blackboard().length, 2);
});

test('W2-4 G1: 步数 TTL 过期 —— 动作步滴答，观察类不滴答', () => {
  coordinator.spawn([{ id: 'w1', role: 'A', objective: 'o', maxSteps: 9 }]);
  assert.equal(coordinator.claim('w1', '任务X', 2).ok, true);
  coordinator.chargeStep('take_screenshot'); // 观察类：步数钟不动
  assert.equal(coordinator.blackboard().length, 1, '观察类调用不消耗租约');
  assert.equal(coordinator.blackboard()[0].ttl, 2);
  coordinator.chargeStep('click_mouse'); // 滴答 1
  assert.equal(coordinator.blackboard()[0].ttl, 1);
  coordinator.chargeStep('type_text'); // 滴答 2 → 过期淘汰
  assert.equal(coordinator.blackboard().length, 0, 'TTL 归零即淘汰');
  // 过期后主题可被他人认领（租约让位语义随 TTL 消亡）
  coordinator.spawn([{ id: 'w2', role: 'B', objective: 'o', maxSteps: 9 }]);
  assert.equal(coordinator.claim('w2', '任务X').ok, true);
});

test('W2-4 G1: chargeStep 把黑板摘要注入当前代理状态视图（空板零影响）', () => {
  const agents = coordinator.spawn([
    { id: 'v1', role: 'A', objective: 'o', maxSteps: 9 },
    { id: 'v2', role: 'B', objective: 'o', maxSteps: 9 },
  ]);
  assert.ok(agents.length === 2);
  coordinator.chargeStep('click_mouse'); // 空板注入：视图无 boardDigest 键（零影响）
  assert.equal('boardDigest' in coordinator.roster()[0].focus, false);
  coordinator.claim('v2', '竞品B定价调研', 9);
  coordinator.post('v2', '竞品B定价调研', '免费版只支持3个项目');
  coordinator.chargeStep('type_text'); // 有板注入：当前代理（v1）的焦点视图携带摘要
  const digest = coordinator.roster().find(a => a.spec.id === 'v1')!.focus.boardDigest;
  assert.ok(digest && digest.includes('竞品B定价调研'), '摘要含认领主题');
  assert.ok(digest!.includes('v2'), '摘要含持有者');
  assert.ok(digest!.includes('免费版只支持3个项目'), '摘要含发现载荷');
  assert.ok(digest!.length <= 256, '摘要有界 ≤256 字符');
});

test('W2-4 G1: 黑板清空即抹除摘要残影（不留过期租约的幽灵视图）', () => {
  coordinator.spawn([{ id: 'g1', role: 'A', objective: 'o', maxSteps: 9 }]);
  coordinator.claim('g1', '短租目标', 2);
  coordinator.chargeStep('click_mouse'); // 滴答 1：租约存活（ttl 1）⇒ 注入
  assert.ok(coordinator.roster()[0].focus.boardDigest !== undefined, '有板注入');
  coordinator.chargeStep('type_text'); // 滴答 2：短租过期 ⇒ 板空
  assert.equal(coordinator.blackboard().length, 0);
  assert.equal(coordinator.roster()[0].focus.boardDigest, undefined, '板空 ⇒ 键抹除');
});

test('W2-4 G1: 有界 FIFO 逐出（≤8 条，最旧先走）', () => {
  coordinator.spawn([{ id: 'p1', role: 'A', objective: 'o', maxSteps: 99 }]);
  for (let i = 1; i <= 9; i++) {
    assert.equal(coordinator.post('p1', `主题${i}号`, `发现${i}`), true);
  }
  const board = coordinator.blackboard();
  assert.equal(board.length, 8, '容量硬顶 8');
  assert.ok(!board.some(e => e.subject === '主题1号'), '最旧条目被逐出');
  assert.equal(board[0].subject, '主题2号');
  assert.equal(board[7].subject, '主题9号');
});

test('W2-4 G1: post 发现 —— 同代理异主题积累，同主题重贴 touch', () => {
  coordinator.spawn([{ id: 'p1', role: 'A', objective: 'o', maxSteps: 99 }]);
  coordinator.post('p1', '主题甲', '发现一');
  coordinator.post('p1', '主题乙', '发现二');
  assert.equal(coordinator.blackboard().length, 2);
  coordinator.post('p1', '主题甲', '发现一更新'); // 同主题重贴：替换而非堆叠
  const board = coordinator.blackboard();
  assert.equal(board.length, 2);
  assert.equal(board.find(e => e.subject === '主题甲')!.body, '发现一更新');
  assert.equal(board[1].subject, '主题甲', '重贴 touch 到 FIFO 尾');
});

test('W2-4 G1: 代理退场（report/abort）释放租约，finding 留存', () => {
  coordinator.spawn([
    { id: 'r1', role: 'A', objective: 'o', maxSteps: 5 },
    { id: 'r2', role: 'B', objective: 'o', maxSteps: 5 },
  ]);
  coordinator.claim('r1', '竞品A定价调研', 50);
  coordinator.post('r1', '竞品A定价调研', '定价 10 美元');
  coordinator.report('r1', '结论', 0.9);
  const board = coordinator.blackboard();
  assert.equal(board.length, 1, 'claim 释放、finding 留存');
  assert.equal(board[0].kind, 'finding');
  // 已退场代理不能再认领（防御）
  assert.deepEqual(coordinator.claim('r1', '新主题'), { ok: false, reason: 'inactive-agent' });
  // abort 同律
  coordinator.claim('r2', '主题Z', 50);
  coordinator.abort('r2', '预算耗尽');
  assert.ok(!coordinator.blackboard().some(e => e.kind === 'claim'));
});

test('W2-4 G1: 同代理换目标换租（一代理一份租约）+ 重认领续租', () => {
  coordinator.spawn([{ id: 's1', role: 'A', objective: 'o', maxSteps: 9 }]);
  coordinator.claim('s1', '主题一');
  coordinator.claim('s1', '主题二'); // 换目标：旧租让位
  let board = coordinator.blackboard();
  assert.equal(board.length, 1);
  assert.equal(board[0].subject, '主题二');
  coordinator.claim('s1', '主题二', 9); // 同主题重认领：续租
  board = coordinator.blackboard();
  assert.equal(board.length, 1);
  assert.equal(board[0].ttl, 9);
});

test('W2-4 G1: 防御式域执法 —— 未知代理/空主题/TTL 钳制', () => {
  coordinator.spawn([{ id: 'd1', role: 'A', objective: 'o', maxSteps: 5 }]);
  assert.deepEqual(coordinator.claim('ghost', '主题'), { ok: false, reason: 'inactive-agent' });
  assert.deepEqual(coordinator.claim('d1', '   '), { ok: false, reason: 'empty-subject' });
  assert.equal(coordinator.post('ghost', '主题', '发现'), false);
  assert.equal(coordinator.post('d1', '', '发现'), false);
  assert.equal(coordinator.post('d1', '主题', ''), false);
  coordinator.claim('d1', '主题甲', NaN); // NaN 租约回退缺省（maxSteps 同律）
  assert.equal(coordinator.blackboard()[0].ttl, 5);
  coordinator.claim('d1', '主题乙', 9999); // 超上限钳到 50
  assert.equal(coordinator.blackboard()[0].ttl, 50);
  coordinator.claim('d1', '主题丙', 0); // 低于下限钳到 1
  assert.equal(coordinator.blackboard()[0].ttl, 1);
});

test('W2-4 G1: reset 清零（黑板 + 铸造序 + 步数钟）', () => {
  coordinator.spawn([{ id: 'z1', role: 'A', objective: 'o', maxSteps: 9 }]);
  coordinator.claim('z1', '主题', 50);
  coordinator.post('z1', '主题2', '发现');
  coordinator.chargeStep('click_mouse');
  assert.equal(coordinator.blackboard().length, 2);
  coordinator.reset();
  assert.equal(coordinator.blackboard().length, 0);
  // 清零后重铸：序号从 1 重新起算（与首铸不可区分 —— 协议确定性）
  coordinator.spawn([{ id: 'z2', role: 'B', objective: 'o', maxSteps: 9 }]);
  coordinator.claim('z2', '主题', 3);
  assert.equal(coordinator.blackboard()[0].seq, 1);
});

// ─── G4：实证仲裁 ───

/** 冲突 fixture：语义余弦 0（域判据实测），基础裁决 winner = f1（置信 0.9 > 0.6） */
function conflictingReports(): SubAgentReport[] {
  return [
    { taskId: 'f1', status: 'completed', findings: '打开浏览器导航到新闻网站浏览头条', confidence: 0.9, stepsUsed: 3 },
    { taskId: 'f2', status: 'completed', findings: '在 Excel 中筛选数据并保存报表', confidence: 0.6, stepsUsed: 3 },
  ];
}

/** 确定性锚定端口：文本含 'excel' ⇒ 0.9（强锚）；含 '浏览器' ⇒ 0.2（弱锚）。
 *  evidence 显式传 null ⇒ runVerifier 返回 null（证据缺席 fixture）。 */
function keywordPort(evidence?: VerifierEvidence | null): EvidenceAnchorPort {
  const defaultEvidence: VerifierEvidence = {
    taskId: 'verifier-1',
    subject: 'excel data filter',
    regions: [{ label: 'excel 筛选数据保存报表', bbox: { x0: 0.1, y0: 0.2, x1: 0.6, y1: 0.5 } }],
    confidence: 0.95,
  };
  return {
    runVerifier: () => (evidence === undefined ? defaultEvidence : evidence),
    matchClaim: (claim: VerifiableClaim) =>
      claim.text.includes('Excel') || claim.text.includes('excel') ? 0.9 : 0.2,
  };
}

test('W2-4 G4: 硬证据改判 —— 证据分压倒置信分', async () => {
  const arb = await new EvidenceBackedArbitrator(keywordPort()).arbitrate(conflictingReports());
  assert.equal(arb.verdict, 'adjudicated');
  assert.equal(arb.winner, 'f2', '硬证据改判：excel 候选胜出，尽管置信 0.6 < 0.9');
  assert.ok(arb.rationale.includes('hard evidence overrides confidence'));
  assert.ok(arb.rationale.includes('f1'), '归因披露被证据推翻的置信胜者');
  assert.ok(arb.crossValidation.length > 0, '交叉验证保留（审计面完整）');
});

test('W2-4 G4: 经协调器热插拔（coordinator.arbitrate(strategy)）', async () => {
  coordinator.spawn([
    { id: 'f1', role: 'A', objective: 'o', maxSteps: 5 },
    { id: 'f2', role: 'B', objective: 'o', maxSteps: 5 },
  ]);
  coordinator.report('f1', '打开浏览器导航到新闻网站浏览头条', 0.9);
  coordinator.report('f2', '在 Excel 中筛选数据并保存报表', 0.6);
  const arb = await coordinator.arbitrate(new EvidenceBackedArbitrator(keywordPort()));
  assert.equal(arb!.verdict, 'adjudicated');
  assert.equal(arb!.winner, 'f2');
});

test('W2-4 G4: 证据归因结构（verifier/mission/perCandidate/regions）', async () => {
  const arb = await new EvidenceBackedArbitrator(keywordPort()).arbitrate(conflictingReports());
  const ev = arb.evidence!;
  assert.equal(ev.verifier, 'verifier-1');
  assert.ok(ev.mission.includes('在当前屏寻找'), '使命书入归因（铸造即存证）');
  assert.deepEqual(ev.perCandidate, [
    { taskId: 'f1', match: 0.2 },
    { taskId: 'f2', match: 0.9 },
  ]);
  assert.deepEqual(ev.regions, [{
    label: 'excel 筛选数据保存报表',
    bbox: { x0: 0.1, y0: 0.2, x1: 0.6, y1: 0.5 },
  }] satisfies AnchoredRegion[]);
});

test('W2-4 G4: 无证据回退 —— 判决与胜者保持缺省行为，归因注明诚实降级', async () => {
  const reports = conflictingReports();
  const base = await new ConfidenceWeightedArbitrator().arbitrate(reports);
  const arb = await new EvidenceBackedArbitrator(keywordPort(null)).arbitrate(reports);
  assert.equal(arb.verdict, 'conflict');
  assert.equal(arb.winner, base.winner, '回退后胜者与缺省策略一致');
  assert.equal(arb.evidence, undefined, '无证据不产生归因');
  assert.ok(arb.rationale.includes('confidence-weighted fallback'), '诚实降级入归因');
  // 证据为空区域数组同样视为缺席
  const emptyRegions = await new EvidenceBackedArbitrator(keywordPort({
    taskId: 'v', subject: 's', regions: [], confidence: 0.5,
  })).arbitrate(reports);
  assert.equal(emptyRegions.verdict, 'conflict');
});

test('W2-4 G4: 端口缺席 ⇒ 逐字节回退 ConfidenceWeightedArbitrator', async () => {
  const reports = conflictingReports();
  const expected = await new ConfidenceWeightedArbitrator().arbitrate(reports);
  const noPort = await new EvidenceBackedArbitrator().arbitrate(reports);
  assert.deepEqual(noPort, expected);
  // 有 matchClaim 无 runVerifier：同样整体回退（无证据来源即无从铸证）
  const partial = await new EvidenceBackedArbitrator({
    matchClaim: () => 0.99,
  }).arbitrate(reports);
  assert.deepEqual(partial, expected);
});

test('W2-4 G4: 端口抛异常 ⇒ 防御式绝不抛，按证据缺席降级', async () => {
  const boom: EvidenceAnchorPort = {
    runVerifier: () => { throw new Error('verifier crashed'); },
    matchClaim: () => { throw new Error('anchor crashed'); },
  };
  const arb = await new EvidenceBackedArbitrator(boom).arbitrate(conflictingReports());
  assert.equal(arb.verdict, 'conflict', '端口炸了不拖垮裁决');
});

test('W2-4 G4: 证据不锚定任何候选（全低于阈 0.5）⇒ 降级回 conflict', async () => {
  const weak: EvidenceAnchorPort = {
    runVerifier: () => ({
      taskId: 'v', subject: 's',
      regions: [{ label: '无关区域', bbox: { x0: 0, y0: 0, x1: 0.1, y1: 0.1 } }],
      confidence: 0.5,
    }),
    matchClaim: () => 0.1,
  };
  const arb = await new EvidenceBackedArbitrator(weak).arbitrate(conflictingReports());
  assert.equal(arb.verdict, 'conflict');
  assert.ok(arb.rationale.includes('no candidate anchored'));
});

test('W2-4 G4: 非冲突路径不受证据影响（consensus 原样透传）', async () => {
  const reports: SubAgentReport[] = [
    { taskId: 'c1', status: 'completed', findings: '竞品 A 定价 10 美元每月，功能包含数据筛选', confidence: 0.9, stepsUsed: 3 },
    { taskId: 'c2', status: 'completed', findings: '竞品 A 定价 10 美元每月，支持筛选和导出数据', confidence: 0.8, stepsUsed: 3 },
  ];
  const expected = await new ConfidenceWeightedArbitrator().arbitrate(reports);
  const arb = await new EvidenceBackedArbitrator(keywordPort()).arbitrate(reports);
  assert.deepEqual(arb, expected, 'consensus 无需实证 —— 与缺省策略逐字节一致');
});

test('W2-4 G4: 缺省语义锚定（semanticAnchorMatch，零依赖离线）', () => {
  const evidence: VerifierEvidence = {
    taskId: 'v', subject: 'excel',
    regions: [{ label: 'excel 筛选数据保存报表', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }],
    confidence: 0.9,
  };
  const excel = semanticAnchorMatch(
    { taskId: 'f2', text: '在 Excel 中筛选数据并保存报表' }, evidence);
  const browser = semanticAnchorMatch(
    { taskId: 'f1', text: '打开浏览器导航到新闻网站浏览头条' }, evidence);
  assert.ok(excel !== null && excel >= 0.5, `excel 声明锚定达标（实测 ${excel}）`);
  assert.ok(browser !== null && browser < 0.5, `浏览器声明不锚定（实测 ${browser}）`);
  assert.ok(excel! > browser!);
  assert.equal(semanticAnchorMatch(
    { taskId: 'x', text: '任意' }, { ...evidence, regions: [] }), null, '无区域 ⇒ null');
});

test('W2-4 G4: 几何锚定（geometricAnchorMatch/anchorIoU，elementTracker 风格）', () => {
  const evidence: VerifierEvidence = {
    taskId: 'v', subject: 's',
    regions: [
      { label: 'r1', bbox: { x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3 } },
      { label: 'r2', bbox: { x0: 0.7, y0: 0.7, x1: 0.9, y1: 0.9 } },
    ],
    confidence: 0.9,
  };
  const hit = geometricAnchorMatch(
    { taskId: 'a', text: 'x', bbox: { x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3 } }, evidence);
  assert.equal(hit, 1, '完全重叠 IoU = 1');
  const miss = geometricAnchorMatch(
    { taskId: 'a', text: 'x', bbox: { x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 } }, evidence);
  assert.equal(miss, 0, '不重叠 IoU = 0');
  assert.equal(geometricAnchorMatch({ taskId: 'a', text: 'x' }, evidence), null,
    '声明无几何锚 ⇒ 诚实 null（证据不适用）');
  // IoU 原子：半重叠 = 1/3
  assert.ok(Math.abs(anchorIoU(
    { x0: 0, y0: 0, x1: 1, y1: 1 },
    { x0: 0.5, y0: 0, x1: 1.5, y1: 1 }) - 1 / 3) < 1e-9);
});

test('W2-4 G4: 使命铸造确定性（同输入恒同输出 + 候序按基础分降序）', async () => {
  const reports = conflictingReports();
  const base = await new ConfidenceWeightedArbitrator().arbitrate(reports);
  const m1 = mintVerifierMission(reports, base);
  const m2 = mintVerifierMission(reports, base);
  assert.deepEqual(m1, m2, '纯函数确定性');
  assert.deepEqual(m1.candidates, ['f1', 'f2'], '候序 = 基础分降序（f1 置信高在前）');
  assert.ok(m1.objective.includes('f1 vs f2'));
  assert.ok(m1.subject.length > 0);
  // 共享词分支：前二 findings 有共享词 ⇒ 主题取自共享词
  const shared: SubAgentReport[] = [
    { taskId: 's1', status: 'completed', findings: '竞品A定价 10 美元', confidence: 0.9, stepsUsed: 1 },
    { taskId: 's2', status: 'completed', findings: '竞品A定价 8 美元', confidence: 0.8, stepsUsed: 1 },
  ];
  const fabricated = {
    verdict: 'conflict' as const, winner: 's1', crossValidation: [], rationale: 'r',
  };
  const m3 = mintVerifierMission(shared, fabricated);
  assert.ok(m3.subject.includes('定价'), `共享词入主题（实测 "${m3.subject}"）`);
});

test('W2-4 兼容: 缺省仲裁器与无黑板行为与现状逐字节一致', async () => {
  // 无黑板操作时：chargeStep 只注入缺席键（视图结构零变化）
  coordinator.spawn([
    { id: 'k1', role: 'A', objective: 'o', maxSteps: 5 },
    { id: 'k2', role: 'B', objective: 'o', maxSteps: 5 },
  ]);
  coordinator.chargeStep('click_mouse');
  for (const a of coordinator.roster()) {
    assert.equal('boardDigest' in a.focus, false, '空黑板不落键');
  }
  // 缺省仲裁：与 ConfidenceWeightedArbitrator 逐字节一致（默认策略未变）
  coordinator.report('k1', '打开浏览器导航到新闻网站浏览头条', 0.9);
  coordinator.report('k2', '在 Excel 中筛选数据并保存报表', 0.6);
  const expected = await new ConfidenceWeightedArbitrator().arbitrate(
    coordinator.roster().map(a => a.report!));
  assert.deepEqual(await coordinator.arbitrate(), expected);
  assert.equal(expected.verdict, 'conflict');
});
