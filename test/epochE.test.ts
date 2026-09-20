// test/epochE.test.ts
// E 纪元（第五维·信息热力学）回归测试 —— 六个突破各一节，防其借尸还魂：
//   E-1 间隔重复记忆：半衰期随复证增长（FSRS/HLR）—— 复证条目抗遗忘 ≫ 未复证
//   E-2 基因组组装重组：OLC 尾头最长重叠缝合 —— 共享子序列只保留一份
//   E-3 循环谱振荡检测：任意周期 p∈{1..4}（A→B→A→B 旧版不可见）
//   E-4 预测误差驱动注意力：页面级跳变帧获显著度加成 + 钉扎资格
//   E-5 贝叶斯可靠度：Beta(1,1) 后验均值（=Laplace，零回归）+ 95% CI 透明
//   E-6 混淆免疫风险闸门：leet/零宽/标点归一化 —— p@ssw0rd/密 码 不再漏检
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryKnowledgeBase } from '../src/knowledge/knowledgeBase.ts';
import type { ExecutionOutcome } from '../src/knowledge/contracts.ts';
import { skillLibrary, olcOverlap, betaReliability } from '../src/skillLibrary.ts';
import type { SkillStep } from '../src/skillLibrary.ts';
import { oscillationTracker } from '../src/oscillationTracker.ts';
import { contextManager } from '../src/contextManager.ts';
import { matchesRiskPatterns, matchesDangerPatterns, parseRiskPatterns } from '../src/riskGate.ts';

// ─── E-1：间隔重复记忆（半衰期随复证增长）───

function failedOutcome(topic: string): ExecutionOutcome {
  return {
    intent: { id: `i-${topic}`, description: topic },
    action: { kind: 'click_mouse', args: { x: 0.4, y: 0.35 }, rationale: 'e1' },
    result: { status: 'failure', durationMs: 1, failure: { kind: 'host-error', detail: 'trap' } },
    retryCount: 0,
  } as unknown as ExecutionOutcome;
}

const DAY = 24 * 60 * 60 * 1000;

test('E-1 间隔重复：三次复证后 60 天，有效置信度 ≫ 未复证条目（复习让记忆更牢）', () => {
  const reinforced = new InMemoryKnowledgeBase();
  reinforced.learnFromOutcome(failedOutcome('delete the record'));
  reinforced.learnFromOutcome(failedOutcome('delete the record'));
  reinforced.learnFromOutcome(failedOutcome('delete the record'));
  const entry = reinforced.snapshot()[0];
  // 稳定性：30d × 1.6²（首次铸造不带半衰期，两次复证各 ×1.6）≈ 76.8 天
  assert.ok(entry.halfLifeMs && entry.halfLifeMs > 70 * DAY && entry.halfLifeMs < 84 * DAY,
    `复证后半衰期应 ≈77 天，实际 ${entry.halfLifeMs}`);
  // 时间旅行（snapshot 后门 —— 免疫 #1 同律）：退回 60 天
  entry.updatedAt = Date.now() - 60 * DAY;

  const unreinforced = new InMemoryKnowledgeBase();
  unreinforced.learnFromOutcome(failedOutcome('delete the record'));
  const raw = unreinforced.snapshot()[0];
  raw.updatedAt = Date.now() - 60 * DAY; // 同样退回 60 天（30 天基线 ⇒ 两个半衰期）

  // 检索过滤执法：eff = conf × 0.5^(60/halfLife)
  //   复证条目 0.657 × 0.5^(60/76.8) ≈ 0.383 ≥ 0.3 —— 存活
  //   未复证条目 0.3 × 0.5² = 0.075 < 0.3 —— 被遗忘
  const q1 = reinforced.query({ sceneDescription: 'record cleanup', intentDescription: 'delete the record', minConfidence: 0.3 });
  const q2 = unreinforced.query({ sceneDescription: 'record cleanup', intentDescription: 'delete the record', minConfidence: 0.3 });
  assert.ok(q1.ok && q1.value.entries.length === 1, '间隔重复条目 60 天后仍达 0.3 门槛');
  assert.ok(q2.ok && q2.value.entries.length === 0, '未复证条目 60 天后已被遗忘曲线淘汰');
});

test('E-1 域执法：halfLifeMs 非正数/非数拒绝；快照往返保真（旧档缺席 = 30 天基线）', () => {
  const kb = new InMemoryKnowledgeBase();
  kb.insert({ category: 'workflow', content: 'proven', scenario: 's', confidence: 0.6, source: 'auto-learn' });
  const snap = JSON.parse(JSON.stringify(kb.exportSnapshot()));

  // 保真：带 halfLifeMs 的新档往返无损
  snap.entries[0].halfLifeMs = 12345678;
  const kb2 = new InMemoryKnowledgeBase();
  assert.ok(kb2.restoreSnapshot(snap).ok);
  assert.equal(kb2.snapshot()[0].halfLifeMs, 12345678);

  // 旧档兼容：缺席 = 基线（零迁移成本 —— 间隔重复对历史档案自然降级）
  delete snap.entries[0].halfLifeMs;
  const kb3 = new InMemoryKnowledgeBase();
  assert.ok(kb3.restoreSnapshot(snap).ok);
  assert.equal(kb3.snapshot()[0].halfLifeMs, undefined);

  // 域外拒绝（先验后写，绝不半水合）
  for (const bad of ['yesterday' as unknown as number, 0, -5, Infinity]) {
    const corrupt = JSON.parse(JSON.stringify(kb.exportSnapshot()));
    corrupt.entries[0].halfLifeMs = bad;
    const r = new InMemoryKnowledgeBase().restoreSnapshot(corrupt);
    assert.ok(!r.ok, `halfLifeMs=${bad} 必须域外拒绝`);
  }
});

// ─── E-2：基因组组装式重组（OLC 重叠拼接）───

const a: SkillStep = { tool: 'click_mouse', args: { x: 0.1, y: 0.1 } };
const b: SkillStep = { tool: 'scroll_page', args: { direction: 'down', amount: 3 } };
const c: SkillStep = { tool: 'drag_mouse', args: { startX: 0.2, startY: 0.2, endX: 0.4, endY: 0.4 } };
const d: SkillStep = { tool: 'type_text', args: { text: 'hello' } };

test('E-2 olcOverlap：尾头最长精确重叠（contig 缝合的数学原子）', () => {
  assert.equal(olcOverlap([a, b, c], [b, c, d]), 2, '[a,b,c]+[b,c,d] 共享尾头 2 步');
  assert.equal(olcOverlap([a, b, c], [c, d]), 1, '共享 1 步');
  assert.equal(olcOverlap([a], [d]), 0, '零重叠直通');
  assert.equal(olcOverlap([a, b], [a, b, c]), 2, '保底约束：next 至少贡献 1 步新物质');
  assert.equal(olcOverlap([], [a]), 0, '空载体直通');
});

test('E-2 recombine：共享子序列缝合一份（族谱带 OLC 归因）', () => {
  skillLibrary.reset();
  skillLibrary.configure(true, '', 50);
  skillLibrary.induce('整理数据 clean up spreadsheet', [a, b, c]);
  skillLibrary.induce('发送消息 send message to group', [b, c, d]);
  const { skill, plan } = skillLibrary.recombine('整理数据然后发送消息');
  assert.ok(skill, '应合成新技能');
  assert.equal(skill!.synthesized, true);
  assert.equal(skill!.genes!.length, 2);
  // OLC 缝合：[a,b,c] + [b,c,d] ⇒ [a,b,c,d]（旧盲连接会产出 5 步 + 相邻去重后的 4 步仅限 k=1 特例；
  // 本用例共享 2 步 —— 只有最长重叠对齐能正确缝合）
  assert.deepEqual(skill!.steps, [a, b, c, d]);
  assert.ok(plan[1].reason.includes('OLC spliced 2'), `族谱应带接缝归因，实际 ${plan[1].reason}`);
});

// ─── E-3：循环谱振荡检测（任意周期）───

test('E-3 周期 2：A→B→A→B→A→B 双态振荡在第三个完整周期块告警（旧版不可见）', () => {
  oscillationTracker.reset();
  const h1 = '0'.repeat(32) + '1'.repeat(32);
  const h2 = '1'.repeat(32) + '0'.repeat(32);
  let alarm: string | null = null;
  for (let i = 0; i < 6; i++) alarm = oscillationTracker.observe(i % 2 === 0 ? h1 : h2);
  assert.ok(alarm?.includes('OSCILLATION'), '第 6 帧（3 个完整周期）应告警');
  assert.ok(alarm!.includes('2-state'), '告警应标注周期 2');
  // 告警后清环：单帧不再响
  assert.equal(oscillationTracker.observe(h1), null);
});

test('E-3 周期 1 回归：同指纹 ≥3 次仍告警（旧语义保持）', () => {
  oscillationTracker.reset();
  const h = '1'.repeat(64);
  let alarm: string | null = null;
  for (let i = 0; i < 3; i++) alarm = oscillationTracker.observe(h);
  assert.ok(alarm?.includes('OSCILLATION'));
  assert.equal(oscillationTracker.observe(h), null);
});

test('E-3 变化序列不误报：8 帧两两 ≥ 容差距离 ⇒ 零告警（K 纪元：互异语义随容差升级）', () => {
  oscillationTracker.reset();
  // K 纪元：检测升级为 6 位容差后，"互异"必须距离 > 6 —— 位边界 8 位步进
  // （旧 1 位步进的"互异"实为噪声级抖动，新语义下正确地被视为同场景）
  for (let i = 0; i < 8; i++) {
    const distinct = '0'.repeat(i * 8) + '1'.repeat(64 - i * 8);
    assert.equal(oscillationTracker.observe(distinct), null);
  }
});

test('E-3/K 噪声容忍：周期内 3 位抖动不再断尾（容差 6 的兑现）', () => {
  oscillationTracker.reset();
  const A = '0'.repeat(32) + '1'.repeat(32);
  const B = '1'.repeat(32) + '0'.repeat(32);
  const flip = (h: string, n: number): string => { // 翻转前 n 位（确定性噪声注入）
    let out = '';
    for (let i = 0; i < h.length; i++) out += i < n ? (h[i] === '0' ? '1' : '0') : h[i];
    return out;
  };
  // A,B,A',B',A'',B'' —— 双态交替、每帧 ≤3 位抖动（旧精确匹配必断尾）：
  // p=2 判据比较 i↔i+2：A≈A'≈A''、B≈B'≈B'' 全部落在 6 位容差内
  const seq = [A, B, flip(A, 3), flip(B, 3), flip(A, 2), flip(B, 1)];
  let alarm: string | null = null;
  for (const h of seq) alarm = oscillationTracker.observe(h);
  assert.ok(alarm?.includes('2-state'), '噪声内的循环仍被捕获（K 纪元容差兑现）');
});

// ─── E-4：预测误差驱动注意力（惊讶 → 钉扎）───

const fakeImage = (kb = 1) => `data:image/jpeg;base64,${'A'.repeat(kb * 1024)}`;

test('E-4 惊讶钉扎：页面级跳变帧豁免驱逐（旧 FIFO 会把它逐出）', async () => {
  contextManager.reset();
  contextManager.configure(2, 1_000_000, false);
  contextManager.configureFocus(true, 1, 32, 6); // 钉扎名额 1
  // 帧间 3ms：Date.now() 既是 id 又是时间戳 —— 同毫秒加入的帧 id 撞号，判别面失效
  const tick = () => new Promise(r => setTimeout(r, 3));

  const X = await contextManager.addScreenshot(fakeImage(), '0'.repeat(64)); await tick(); // 首帧无残差
  const A = await contextManager.addScreenshot(fakeImage(), '1'.repeat(64)); await tick(); // 残差 64 ⇒ 惊讶帧
  const B = await contextManager.addScreenshot(fakeImage(), '1'.repeat(60) + '0000'); await tick(); // 残差 4 ⇒ 平凡
  const C = await contextManager.addScreenshot(fakeImage(), '1'.repeat(56) + '00000000'); // 残差 4 ⇒ 平凡

  // 窗口 2 的两次驱逐：B 步驱逐 X（平凡池最旧），C 步驱逐 B（A 被钉扎豁免）。
  // 无 E-4 时 A 不被钉扎 ⇒ C 步驱逐的将是 A（FIFO）—— 本断言即为判别面。
  const imgs = contextManager.recentImages(2);
  assert.equal(imgs.length, 2);
  assert.equal(imgs[0].id, A.currentId, '惊讶帧 A 应钉扎存活（比它新的 B 被逐）');
  assert.equal(imgs[1].id, C.currentId, '最新平凡帧在场');
  assert.ok(imgs.every(i => i.id !== B.currentId && i.id !== X.currentId));
});

// ─── E-5：贝叶斯可靠度（Beta 后验 + 95% CI）───

test('E-5 betaReliability：后验均值 = Laplace（零回归）；CI 半宽随证据收缩', () => {
  // 与既有平滑逐字一致 —— 既有排序行为不变的结构证明
  for (const [s, n] of [[0, 0], [1, 1], [2, 2], [3, 5], [8, 12]] as const) {
    assert.ok(Math.abs(betaReliability(s, n).mean - (s + 1) / (n + 2)) < 1e-12,
      `mean(${s},${n}) 必须等于 Laplace (s+1)/(n+2)`);
  }
  assert.ok(Math.abs(betaReliability(0, 0).mean - 0.5) < 1e-12, 'Beta(1,1) 均值 0.5');
  // 不确定度收缩：证据越多，区间越窄（8/12 的老技能 比 0/0 的新直觉 可信）
  assert.ok(betaReliability(0, 0).hw > betaReliability(5, 5).hw, '0 样本区间最宽');
  assert.ok(betaReliability(5, 5).hw > betaReliability(20, 20).hw, '区间随 n 单调收缩');
});

test('E-5 match 透明面：命中携带 posterior_mean 与 ci95（不确定性与结论同现）', () => {
  skillLibrary.reset();
  skillLibrary.configure(true, '', 50);
  skillLibrary.induce('整理数据 clean up spreadsheet', [a]);
  const hits = skillLibrary.match('整理数据 tidy up the data');
  assert.ok(hits.length > 0);
  const lo = (hits[0] as any).ci95[0], hi = (hits[0] as any).ci95[1];
  assert.equal(typeof (hits[0] as any).posterior_mean, 'number');
  assert.ok(lo < hi && lo >= 0 && hi <= 1, `ci95 必须是 [0,1] 内的有序对，实际 [${lo}, ${hi}]`);
});

// ─── E-6：混淆免疫风险闸门（归一化匹配）───

test('E-6 混淆免疫：leet/间隔中文/插空英文全部命中（旧引擎漏检）', () => {
  const csv = 'password,密码,otp,verification code';
  // leet 视觉混淆：p@ssw0rd → password
  assert.equal(matchesRiskPatterns('enter p@ssw0rd here', csv), true);
  // 零宽/空白切断中文：密 码 → 密码
  assert.equal(matchesRiskPatterns('密 码 输入框', csv), true);
  // 标点+leet 混合：verificati0n c0de → verificationcode
  assert.equal(matchesRiskPatterns('verificati0n c0de sent', csv), true);
  // 词表同律归一：「verification code」剥空格后与无空格文本对齐
  assert.equal(matchesRiskPatterns('input VerificationCode', csv), true);
});

test('E-6 控制组：正常文本不受归一化误伤（保守方向但有界）', () => {
  const csv = 'password,密码,otp';
  assert.equal(matchesRiskPatterns('search for cats', csv), false);
  assert.equal(matchesRiskPatterns('the captain stopped', csv), false);
  // parseRiskPatterns 契约不变（既有测试钉死的行为）
  assert.deepEqual(parseRiskPatterns(' a , b ,,, c '), ['a', 'b', 'c']);
});

test('E-6 危险词同律：De1ete/de1ete 混淆触发审批', () => {
  assert.equal(matchesDangerPatterns('c1ick the De1ete button', ''), true);
  assert.equal(matchesDangerPatterns('c1ick the Cancel button', ''), false);
  // 既有精确路径零回归
  assert.equal(matchesDangerPatterns('click 发送 button', ''), true);
  assert.equal(matchesDangerPatterns('click Cancel button', ''), false);
});
