// test/w4auction.test.ts
// W4-7（G5）：步数拍卖市场 —— 全局步数池 + 每 K 步重拍卖 + 饿死防护 + 账面透明。
// 全部离线确定性：证据经注入端口（fixture 定数）、分配为纯整数算法、无 RNG 无时钟。
// 手算例均先在注释中给出推导，断言值与之逐位对照。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { journal } from '../src/journal.ts';
import { shrinkRate } from '../src/swarm.ts';
import {
  coordinator,
  marginalProgressScore,
  allocateQuotas,
  AUCTION_EPOCH_K,
  AUCTION_DEMOTE_ROUNDS,
  type StepAuctionPort,
} from '../src/subAgent.ts';

beforeEach(() => {
  journal.reset();
  coordinator.reset();
  coordinator.configure(3, 10);
});

// ─── 纯函数原子：边际进展分（进展分函数 = 晶体收缩率先验 × 自报未完成度） ───

test('W4-7 G5: marginalProgressScore —— 收缩率先验只读消费（与晶体 shrinkRate 等价）', () => {
  // 零证据（端口缺席/无尝试）⇒ 先验回退全局基率（无辜推定，均匀入场）
  assert.equal(marginalProgressScore(null, 1, 0.8), 0.8);
  assert.equal(marginalProgressScore({ successes: 0, attempts: 0 }, 1, 0.8), 0.8);
  assert.equal(marginalProgressScore(undefined, 0.5, 0.8), 0.4);
  // 有证据 ⇒ 先验 = shrinkRate（W4-2 晶体数学只读消费 —— 单源同构，无本地漂移副本）
  assert.equal(marginalProgressScore({ successes: 5, attempts: 5 }, 1, 0.8), shrinkRate(5, 5, 0.8));
  assert.equal(marginalProgressScore({ successes: 5, attempts: 5 }, 1, 0.8), 0.925); // 0.625·1+0.375·0.8
  assert.equal(marginalProgressScore({ successes: 5, attempts: 5 }, 0.4, 0.8), 0.37);
  // 域执法：未完成度钳制 [0,1]（越界钳边、非法按 1）；基率非法回退 0.5；成功数>尝试数钳到尝试数
  assert.equal(marginalProgressScore({ successes: 5, attempts: 5 }, 2, 0.8), 0.925);
  assert.equal(marginalProgressScore({ successes: 5, attempts: 5 }, -1, 0.8), 0);
  assert.equal(marginalProgressScore({ successes: 5, attempts: 5 }, Number.NaN, 0.8), 0.925);
  assert.equal(marginalProgressScore(null, 1, Number.NaN), 0.5);
  assert.equal(marginalProgressScore({ successes: 9, attempts: 4 }, 1, 0.5),
    shrinkRate(4, 4, 0.5), '成功数超界钳到尝试数');
});

// ─── 纯函数原子：配额分配（整数最大余数法 + 保底 + 平手按代理序） ───

test('W4-7 G5: allocateQuotas —— 比例分配手算例（整数最大余数法）', () => {
  // 手算例①（与集成场景同数）：bids [0.925,0.675,0.8]、T=10
  //   保底 1,1,1（rem 7）；mBids [925,675,800]、B=2400；
  //   份额分子 6475/4725/5600 → floor 2/1/2（分配 5，零头 2）；
  //   小数部分 1675/2325/800 → a2、a1 先得零头 → [1+3, 1+2, 1+2] = [4,3,3]
  assert.deepEqual(allocateQuotas([0.925, 0.675, 0.8], 10), [4, 3, 3]);
  // 手算例②（饿死防护）：bids [0.893,0,0]、T=10 → 保底后 7 步全归 a1 → [8,1,1]
  assert.deepEqual(allocateQuotas([0.893, 0, 0], 10), [8, 1, 1]);
  // 手算例③：bids [0.9,0.1]、T=3 → 保底 [1,1]、rem 1 → 分子 900/100 → 零头归 a1 → [2,1]
  assert.deepEqual(allocateQuotas([0.9, 0.1], 3), [2, 1]);
  // 单代理独得；总额不足时代理序保底前 T 个；零总额全零；空输入空输出
  assert.deepEqual(allocateQuotas([1], 7), [7]);
  assert.deepEqual(allocateQuotas([1, 1, 1], 2), [1, 1, 0]);
  assert.deepEqual(allocateQuotas([1, 2], 0), [0, 0]);
  assert.deepEqual(allocateQuotas([], 5), []);
});

test('W4-7 G5: allocateQuotas —— 平手按代理序（同分值先者优先）', () => {
  // 等出价 [0.5,0.5,0.5]、T=10：保底后 rem 7，等份额 7/3 → floor 2,2,2 零头 1，
  // 小数部分全等（平手）⇒ 按下标（代理序）先者得 → [4,3,3]
  assert.deepEqual(allocateQuotas([0.5, 0.5, 0.5], 10), [4, 3, 3]);
  // 全零出价（零证据市场）：均分 + 零头按代理序 → 同形
  assert.deepEqual(allocateQuotas([0, 0, 0], 10), [4, 3, 3]);
  assert.deepEqual(allocateQuotas([0, 0, 0], 7), [3, 2, 2]);
});

// ─── 集成：池扣费 / 缺省池推导 / 幂等开启 / 关闭清账 ───

test('W4-7 G5: 池扣费 —— 缺省池 = Σ maxSteps，观察类不扣费，genesis 说明池上限语义', () => {
  // 先开启后组队：空名册 ⇒ 池 0；spawn 即携 endowment 入市
  assert.equal(coordinator.enableStepAuction(), true);
  let st = coordinator.auctionStatus();
  assert.equal(st.enabled, true);
  assert.equal(st.budget, null, '无外注预算');
  assert.equal(st.poolRemaining, 0, '空名册推导池 = 0');
  coordinator.spawn([
    { id: 'a1', role: 'A', objective: 'o', maxSteps: 5 },
    { id: 'a2', role: 'B', objective: 'o', maxSteps: 5 },
  ]);
  assert.equal(coordinator.auctionStatus().poolRemaining, 10, '缺省池 = Σ maxSteps');
  // 观察类调用不扣费（与现状 ACTION_TOOLS 门控一致）
  assert.equal(coordinator.chargeStep('take_screenshot'), false);
  assert.equal(coordinator.auctionStatus().poolCharged, 0);
  assert.equal(coordinator.auctionStatus().poolRemaining, 10);
  // 动作步逐池扣费
  for (let i = 0; i < 3; i++) coordinator.chargeStep('click_mouse');
  st = coordinator.auctionStatus();
  assert.equal(st.poolCharged, 3);
  assert.equal(st.poolRemaining, 7);
  assert.equal(st.epochStep, 3);
  // 账面透明：genesis 条目说明 maxSteps → 池上限语义（兼容律第 5 条）
  const ledger = coordinator.auctionLedger();
  assert.equal(ledger.length, 1, '未到 K 步无拍卖轮');
  assert.equal(ledger[0].round, 0);
  assert.ok(ledger[0].note!.includes('maxSteps'), 'genesis 说明池上限语义');
  assert.ok(ledger[0].note!.includes('K=10'));
  assert.deepEqual(ledger[0].agents, [], '开启时名册为空 ⇒ genesis 无代理账目（spawn 后携 endowment 入市）');
  // 幂等开启：已开启不改账（防误清池）
  assert.equal(coordinator.enableStepAuction({ budget: 999 }), true);
  assert.equal(coordinator.auctionStatus().poolRemaining, 7);
  // 关闭清账：回到缺省关闭（逐字节一致的入口）
  coordinator.disableStepAuction();
  st = coordinator.auctionStatus();
  assert.equal(st.enabled, false);
  assert.equal(st.poolRemaining, 0);
  assert.equal(coordinator.auctionLedger().length, 0);
  assert.equal(coordinator.declareIncompleteness('a1', 0.5), false, '市场未开不收自报');
});

// ─── 集成：K 步触发 + 比例分配手算例 + 配额执法 ───

/** 竞标场景（可重放）：a1 {5,5}、a2 {3,5}、a3 零证据 ⇒ bids [0.925, 0.675, 0.8] */
function proportionalScenario(): { ledger: string; status: string; roster: string } {
  const port: StepAuctionPort = {
    evidence: id =>
      id === 'a1' ? { successes: 5, attempts: 5 } :
      id === 'a2' ? { successes: 3, attempts: 5 } : null,
  };
  coordinator.enableStepAuction({ port });
  coordinator.spawn([
    { id: 'a1', role: '甲', objective: 'o', maxSteps: 20 },
    { id: 'a2', role: '乙', objective: 'o', maxSteps: 20 },
    { id: 'a3', role: '丙', objective: 'o', maxSteps: 20 },
  ]);
  for (let i = 0; i < 10; i++) coordinator.chargeStep('click_mouse');
  return {
    ledger: JSON.stringify(coordinator.auctionLedger()),
    status: JSON.stringify(coordinator.auctionStatus()),
    roster: JSON.stringify(coordinator.roster()),
  };
}

test('W4-7 G5: 每 K 步触发重拍卖 —— 比例分配手算例逐位对照 + 轮内配额执法', () => {
  const port: StepAuctionPort = {
    evidence: id =>
      id === 'a1' ? { successes: 5, attempts: 5 } :
      id === 'a2' ? { successes: 3, attempts: 5 } : null,
  };
  coordinator.enableStepAuction({ port });
  coordinator.spawn([
    { id: 'a1', role: '甲', objective: 'o', maxSteps: 20 },
    { id: 'a2', role: '乙', objective: 'o', maxSteps: 20 },
    { id: 'a3', role: '丙', objective: 'o', maxSteps: 20 },
  ]);
  assert.equal(coordinator.auctionStatus().poolRemaining, 60, '缺省池 = 3×20');
  // K-1 步：不触发（只有 genesis）
  for (let i = 0; i < 9; i++) coordinator.chargeStep('click_mouse');
  assert.equal(coordinator.auctionLedger().length, 1, '第 9 步仍未拍卖');
  // 第 K 步：触发第 1 轮拍卖
  coordinator.chargeStep('click_mouse');
  const ledger = coordinator.auctionLedger();
  assert.equal(ledger.length, 2, `第 ${AUCTION_EPOCH_K} 步触发拍卖`);
  const r1 = ledger[1]!;
  assert.equal(r1.round, 1);
  assert.equal(r1.atStep, 10);
  assert.equal(r1.poolRemaining, 50);
  assert.equal(r1.quotaTotal, 10, '下一配额 = min(K, 池余)');
  // 手算例（见 allocateQuotas 手算例①）：舰队基率 8/10=0.8；
  // 先验 = shrinkRate(5,5,0.8)=0.925 / shrinkRate(3,5,0.8)=0.675 / 零证据=0.8；
  // 出价 = 先验×未完成度(缺省 1)；配额 = [4,3,3]
  assert.deepEqual(r1.agents.map(a => a.agentId), ['a1', 'a2', 'a3'], '账目按名册序');
  assert.deepEqual(r1.agents.map(a => a.prior), [0.925, 0.675, 0.8]);
  assert.deepEqual(r1.agents.map(a => a.bid), [0.925, 0.675, 0.8]);
  assert.deepEqual(r1.agents.map(a => a.quota), [4, 3, 3], '比例分配手算例 [4,3,3]');
  // 轮内配额执法：a1 新一轮配额 4 —— 第 4 步起软提醒（与现状 maxSteps 软执法同型）
  assert.equal(coordinator.auctionStatus().epochStep, 0, '轮内步数随拍卖归零');
  const reminds: boolean[] = [];
  for (let i = 0; i < 4; i++) reminds.push(coordinator.chargeStep('click_mouse'));
  assert.deepEqual(reminds, [false, false, false, true], '配额用尽即提醒收尾');
  assert.equal(coordinator.auctionStatus().poolRemaining, 46);
});

// ─── 集成：平手按代理序（零证据市场等先验） ───

test('W4-7 G5: 平手按代理序 —— 等先验竞标时先出生者得零头步', () => {
  coordinator.enableStepAuction(); // 零证据端口：全员先验 = 基率 0.5（等出价）
  coordinator.spawn([
    { id: 'a1', role: '甲', objective: 'o', maxSteps: 20 },
    { id: 'a2', role: '乙', objective: 'o', maxSteps: 20 },
    { id: 'a3', role: '丙', objective: 'o', maxSteps: 20 },
  ]);
  for (let i = 0; i < 10; i++) coordinator.chargeStep('click_mouse');
  const r1 = coordinator.auctionLedger()[1]!;
  assert.deepEqual(r1.agents.map(a => a.bid), [0.5, 0.5, 0.5], '零证据 ⇒ 等出价（基率×未完成度 1）');
  assert.deepEqual(r1.agents.map(a => a.quota), [4, 3, 3], '平手零头按代理序：a1 先出生者得');
});

// ─── 集成：饿死防护（保底配额） ───

test('W4-7 G5: 饿死防护 —— 零出价者每轮至少 1 步保底', () => {
  const port: StepAuctionPort = {
    evidence: id =>
      id === 'a1' ? { successes: 4, attempts: 4 } :
      id === 'a2' ? { successes: 2, attempts: 4 } : null,
  };
  coordinator.enableStepAuction({ port });
  coordinator.spawn([
    { id: 'a1', role: '甲', objective: 'o', maxSteps: 20 },
    { id: 'a2', role: '乙', objective: 'o', maxSteps: 20 },
    { id: 'a3', role: '丙', objective: 'o', maxSteps: 20 },
  ]);
  // a2/a3 自报已完成（未完成度 0 ⇒ 出价 0）；a1 缺省全然未完成
  assert.equal(coordinator.declareIncompleteness('a2', 0), true);
  assert.equal(coordinator.declareIncompleteness('a3', 0), true);
  assert.equal(coordinator.declareIncompleteness('ghost', 0.5), false, '未知代理拒绝');
  assert.equal(coordinator.declareIncompleteness('a1', Number.NaN), false, '非法值拒绝');
  for (let i = 0; i < 10; i++) coordinator.chargeStep('click_mouse');
  const r1 = coordinator.auctionLedger()[1]!;
  // 手算：基率 6/8=0.75；先验 a1=shrinkRate(4,4,0.75)=0.893、a2=0.607、a3=0.75；
  // 出价 = [0.893, 0, 0]；保底 1 步后 7 步全归 a1 ⇒ [8,1,1]（见 allocateQuotas 手算例②）
  assert.deepEqual(r1.agents.map(a => a.prior), [0.893, 0.607, 0.75]);
  assert.deepEqual(r1.agents.map(a => a.bid), [0.893, 0, 0]);
  assert.deepEqual(r1.agents.map(a => a.quota), [8, 1, 1], '零出价者保底 1 步（饿死防护）');
  assert.deepEqual(r1.agents.map(a => a.incompleteness), [1, 0, 0], '自报未完成度入账');
});

// ─── 集成：连续低进展退场（部分发现优雅退出 + retire 释放容量 + 释放租约） ───

test('W4-7 G5: 连续 M 轮低进展 ⇒ 提交部分发现优雅退场，retire 释放容量', () => {
  const port: StepAuctionPort = {
    evidence: id => id === 'a1' ? { successes: 0, attempts: 10 } : { successes: 10, attempts: 10 },
  };
  coordinator.enableStepAuction({ port });
  coordinator.spawn([
    { id: 'a1', role: '甲', objective: 'o', maxSteps: 50 },
    { id: 'a2', role: '乙', objective: 'o', maxSteps: 50 },
  ]);
  // a1 持租约 + 张贴发现（验证退场释放租约、finding 留存 —— W2-4 协同；
  // 显式长 TTL：缺省 finding 存活 10 步，走不完 30 步的降级历程）
  assert.equal(coordinator.claim('a1', '主题甲', 50).ok, true);
  assert.equal(coordinator.post('a1', '主题甲', '阶段性发现X', 50), true);
  // 静态证据端口：基率 10/20=0.5；a1 先验 = shrinkRate(0,10,0.5)=0.115 < 0.5（每轮低进展）；
  // a2 先验 = shrinkRate(10,10,0.5)=0.885 ≥ 0.5（从不低进展）
  // 第 1/2 轮（步 10/20）：streak 1/2 < M —— 只记账不降级；第 3 轮（步 30）：streak 3 = M ⇒ 降级
  for (let i = 0; i < 30; i++) coordinator.chargeStep('click_mouse');
  const ledger = coordinator.auctionLedger();
  assert.equal(ledger.length, 4, 'genesis + 3 轮拍卖');
  const r1 = ledger[1]!;
  assert.equal(r1.agents[0]!.demoted, undefined, 'streak 1 < M 不降级');
  assert.equal(r1.agents[0]!.streak, 1);
  assert.deepEqual(r1.agents.map(a => a.quota), [2, 8], '降级前正常分配：[2,8]');
  assert.deepEqual(r1.agents.map(a => a.bid), [0.115, 0.885]);
  const r3 = ledger[3]!;
  const d = r3.agents[0]!;
  assert.equal(d.agentId, 'a1');
  assert.equal(d.demoted, true, '连续 M 轮低进展 ⇒ 降级退场');
  assert.equal(d.streak, AUCTION_DEMOTE_ROUNDS);
  assert.equal(d.quota, 0, '退场者不分得配额');
  assert.equal(r3.agents[1]!.agentId, 'a2');
  assert.equal(r3.agents[1]!.quota, 10, '幸存者独得下一配额（含退场者让出的机会）');
  // 优雅退场：经现有 report 通道（status 'timeout' 低置信部分发现）+ AGENT_END 入链
  // （journal.list 缺省只出动作条目 —— 生命周期标记需显式 list(false)）
  const ends = journal.list(false).filter(e => e.tool === 'AGENT_END' && e.args?.taskId === 'a1');
  assert.equal(ends.length, 1);
  assert.equal(ends[0]!.args.status, 'timeout', '部分发现退出走 report 的 timeout 语义');
  // retire 释放容量：名册只剩 a2，可再组 2 名新代理（maxAgents=3）
  assert.equal(coordinator.roster().length, 1);
  assert.equal(coordinator.current()?.spec.id, 'a2', '轮转落回幸存者');
  const spawned = coordinator.spawn([
    { id: 'n1', role: '新', objective: 'o', maxSteps: 5 },
    { id: 'n2', role: '新', objective: 'o', maxSteps: 5 },
  ]);
  assert.equal(spawned.length, 2, '退场释放 spawn 容量');
  // W2-4 协同：退场释放黑板租约（claim 消失），finding 留存为共享知识
  const board = coordinator.blackboard();
  assert.ok(!board.some(e => e.kind === 'claim'), 'a1 退场即释放租约');
  assert.ok(board.some(e => e.kind === 'finding' && e.body === '阶段性发现X'), 'finding 留存');
});

// ─── 集成：池耗尽 ⇒ 全体按现有 abort 语义收场 ───

test('W4-7 G5: 池耗尽 —— 外注预算收口，全体 abort 收场（failed 报告 + 释放租约）', () => {
  coordinator.spawn([
    { id: 'a1', role: '甲', objective: 'o', maxSteps: 50 },
    { id: 'a2', role: '乙', objective: 'o', maxSteps: 50 },
  ]);
  assert.equal(coordinator.claim('a1', '目标甲', 50).ok, true);
  // 外注预算压到 4 步（池上限语义：与名册 endowment 无关）
  assert.equal(coordinator.enableStepAuction({ budget: 4 }), true);
  assert.equal(coordinator.auctionStatus().budget, 4);
  assert.equal(coordinator.auctionStatus().poolRemaining, 4);
  let last = false;
  for (let i = 0; i < 4; i++) last = coordinator.chargeStep('click_mouse');
  // 第 4 步池归零 ⇒ 全体按现有 abort 语义收场 + 软提醒
  assert.equal(last, true);
  const roster = coordinator.roster();
  assert.ok(roster.every(a => a.status === 'aborted'), '全体 aborted');
  assert.ok(roster.every(a => a.report?.status === 'failed'), 'abort 语义收场 = failed 报告');
  assert.ok(roster[0]!.report!.findings.includes('pool exhausted'), '收场归因入报告');
  assert.equal(coordinator.current(), null, '收场后无在役代理');
  assert.equal(coordinator.isActive(), false);
  const final = coordinator.auctionLedger().at(-1)!;
  assert.ok(final.note!.includes('pool exhausted'), '池耗尽入账本（账面透明）');
  // W2-4 协同：abort 释放黑板租约
  assert.ok(!coordinator.blackboard().some(e => e.kind === 'claim'), 'abort 释放租约');
  // 池已空再扣费：直接收场不重复记账
  const ledgerLen = coordinator.auctionLedger().length;
  assert.equal(coordinator.chargeStep('click_mouse'), false, '无在役代理直通');
  coordinator.spawn([{ id: 'a3', role: '丙', objective: 'o', maxSteps: 9 }]);
  assert.equal(coordinator.chargeStep('click_mouse'), true, '空池新代理首步即收场提醒');
  assert.equal(coordinator.roster().find(a => a.spec.id === 'a3')?.status, 'aborted',
    '空池不接纳新扣费（外注预算已尽）');
  assert.equal(coordinator.auctionLedger().length, ledgerLen, '收场记账幂等（不刷账本）');
});

// ─── 兼容：拍卖关闭 ⇒ 与现状逐字节一致 ───

/** 关闭态下的协议轨迹（chargeStep 返回序列 + 逐步 roster/黑板快照） */
function offTrace(): string[] {
  const trace: string[] = [];
  const snap = () => JSON.stringify(coordinator.roster()) + '|' + JSON.stringify(coordinator.blackboard());
  coordinator.spawn([
    { id: 'a1', role: 'A', objective: 'o', maxSteps: 2 },
    { id: 'a2', role: 'B', objective: 'o', maxSteps: 3 },
  ]);
  trace.push(String(coordinator.chargeStep('click_mouse')));   // a1 步 1 → false
  trace.push(String(coordinator.chargeStep('click_mouse')));   // a1 步 2 = maxSteps → true
  trace.push(String(coordinator.chargeStep('click_mouse')));   // a1 步 3 超预算 → true（软执法）
  trace.push(String(coordinator.chargeStep('take_screenshot'))); // 观察类 → false
  coordinator.claim('a1', '目标一', 5);
  trace.push(String(coordinator.chargeStep('type_text')));     // a1 步 4（步数钟滴答）
  coordinator.report('a1', '结论甲', 0.9);
  trace.push(String(coordinator.current()?.spec.id));          // 轮转 a2
  trace.push(String(coordinator.chargeStep('scroll_page')));   // a2 步 1 → false
  coordinator.abort('a2', '测试中止');
  trace.push(snap());
  return trace;
}

test('W4-7 G5: 开关关闭逐字节一致 —— 从未开启 vs 开启后关闭，轨迹全等', () => {
  // 轨迹一：拍卖从未开启（缺省现状）
  const plain = offTrace();
  // 断言现状语义：maxSteps 各代理独立软执法（超线后每次动作步都提醒 —— 与 B/C 世代一致）
  assert.deepEqual(plain.slice(0, 5), ['false', 'true', 'true', 'false', 'true']);
  assert.equal(plain[5], 'a2');
  assert.equal(plain[6], 'false');
  // 轨迹二：开启后立即关闭 —— disable 必须把状态机还原到逐字节等价
  coordinator.reset();
  journal.reset();
  coordinator.configure(3, 10);
  assert.equal(coordinator.enableStepAuction(), true);
  coordinator.disableStepAuction();
  const toggled = offTrace();
  assert.deepEqual(toggled, plain, '开关往返后协议轨迹逐字节一致');
  assert.equal(coordinator.auctionStatus().enabled, false);
  assert.deepEqual(coordinator.auctionLedger(), []);
});

// ─── 拍卖确定性：同输入同输出（无 RNG / 无时钟 / 重放全等） ───

test('W4-7 G5: 拍卖确定性 —— 同输入重放两次，账本/状态/名册全等', () => {
  const first = proportionalScenario();
  coordinator.reset();
  journal.reset();
  coordinator.configure(3, 10);
  const second = proportionalScenario();
  assert.equal(first.ledger, second.ledger, '账本全等（含出价/配额/池余）');
  assert.equal(first.status, second.status, '市场状态全等');
  assert.equal(first.roster, second.roster, '名册全等');
  // 纯函数稳定性：同参两次调用逐位相等
  assert.deepEqual(allocateQuotas([0.925, 0.675, 0.8], 10), allocateQuotas([0.925, 0.675, 0.8], 10));
  assert.equal(
    marginalProgressScore({ successes: 3, attempts: 5 }, 0.7, 0.8),
    marginalProgressScore({ successes: 3, attempts: 5 }, 0.7, 0.8));
});
