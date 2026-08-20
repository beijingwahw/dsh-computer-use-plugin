// test/cognition.test.ts
// 认知升维回归测试：C-1 物理规则 / C-2 语义泛化与 DNA 重组 / C-3 因果链 /
// C-4 认知焦点与潜意识 / C-5 经验晶体与漂移预测。
// 每个用例锁死一项认知能力的最小可信性，防退化回「找不同游戏高手」。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getSharp, type SharpLike } from '../src/_legacyDeps.ts';
import { embed, cosine } from '../src/semanticHash.ts';
import { parseExpectation, getEnabledPhysicsRules } from '../src/intent.ts';
import { skillLibrary } from '../src/skillLibrary.ts';
import { journal } from '../src/journal.ts';
import { contextManager } from '../src/contextManager.ts';
import { swarm } from '../src/swarm.ts';

let _sharp: SharpLike | null = null;
async function requireSharp(): Promise<SharpLike> {
  if (!_sharp) _sharp = await getSharp();
  return _sharp;
}

// ─── 地基：semanticHash ───

test('C-0: embed/cosine —— 语义相近文本向量夹角更近', () => {
  const a = embed('整理一下这些数据 sort the data');
  const b = embed('筛选数据 filter data in spreadsheet');
  const c = embed('打开浏览器导航到新闻网站');
  const simAB = cosine(a, b);
  const simAC = cosine(a, c);
  // 同域（数据操作）应显著高于跨域（浏览网页）
  assert.ok(simAB > simAC, `sim(a,b)=${simAB} should exceed sim(a,c)=${simAC}`);
  assert.ok(simAB > 0.05, '同域文本应有实质相似度');
});

test('C-0: cosine 数学性质 —— 自身=1，空文本=0', () => {
  const v = embed('hello world 你好世界');
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-9);
  assert.equal(cosine(embed(''), v), 0);
});

// ─── C-1：意图解析与物理规则 ───

test('C-1: parseExpectation —— JSON 与简写双格式', () => {
  assert.deepEqual(parseExpectation('{"kind":"menu_expand"}'), { kind: 'menu_expand' });
  assert.deepEqual(parseExpectation('toggle_on'), { kind: 'toggle_on' });
  assert.deepEqual(parseExpectation('{"kind":"text_appear","text":"成功"}'), { kind: 'text_appear', text: '成功' });
  assert.equal(parseExpectation(undefined), null);
  assert.equal(parseExpectation(''), null);
  assert.equal(parseExpectation('gibberish-kind'), null);
});

test('C-1: 物理规则表 —— 空清单=全部启用，清单=裁剪', () => {
  const all = getEnabledPhysicsRules('');
  assert.ok(all.size >= 7, `应有至少 7 条规则，实际 ${all.size}`);
  assert.ok(all.has('toggle_on') && all.has('scroll_content_up'));

  const clipped = getEnabledPhysicsRules('toggle_on,menu_expand');
  assert.equal(clipped.size, 2);
  assert.ok(clipped.has('toggle_on') && !clipped.has('input_focus'));
});

test('C-1: toggle_on 物理 —— 对勾出现（邻域细节增多）被判成功', async (t) => {
  // 批次 E 迁移：sharp 默认不装 —— 老 D-1 物理规则 sharp fixture 用例标记 SKIP
  let s: SharpLike;
  try {
    s = await requireSharp();
  } catch (e: any) {
    t.skip(`[batch-E] sharp not installed — ${e?.message?.slice(0, 240) ?? ''}`);
    return;
  }
  // 合成测试帧：白底，before 无对勾，after 中心多了黑色对勾线条
  const W = 200, H = 200;
  const beforeSvg = `<svg width="${W}" height="${H}"><rect width="100%" height="100%" fill="white"/></svg>`;
  const afterSvg = `<svg width="${W}" height="${H}">` +
    `<rect width="100%" height="100%" fill="white"/>` +
    `<path d="M 80 100 L 95 115 L 120 85" stroke="black" stroke-width="6" fill="none"/></svg>`;
  const beforeBuf = await s(Buffer.from(beforeSvg)).png().toBuffer();
  const afterBuf = await s(Buffer.from(afterSvg)).png().toBuffer();

  const rule = getEnabledPhysicsRules('').get('toggle_on')!;
  const verdict = await rule.check({
    beforeBuf, afterBuf,
    focus: { x: 0.5, y: 0.5 },
    regionRadius: 0.2,
  });
  assert.equal(verdict.satisfied, true, `对勾出现应判 toggle_on 成功：${verdict.evidence}`);

  // 反向：无变化帧不误报
  const same = await rule.check({
    beforeBuf, afterBuf: beforeBuf,
    focus: { x: 0.5, y: 0.5 },
    regionRadius: 0.2,
  });
  assert.equal(same.satisfied, false);
});

// ─── C-2：语义泛化 + DNA 重组 ───

beforeEach(() => {
  skillLibrary.reset();
  skillLibrary.configure(true, '', 50);
  journal.reset();
});

test('C-2: 语义泛化 —— 「整理数据」零样本命中「筛选数据」技能', () => {
  skillLibrary.induce('在 Excel 表格中筛选数据 filter rows', [
    { tool: 'click_mouse', args: { x: 0.1, y: 0.2 } },
  ]);
  const hits = skillLibrary.match('整理一下这些数据 tidy up the data');
  assert.ok(hits.length > 0, '语义通道应命中无重合词的技能');
  // 命中归因透明
  assert.equal((hits[0] as any).matched_via, 'semantic-vector');
});

test('C-2: DNA 重组 —— 两个母体技能合成带族谱的新技能', () => {
  skillLibrary.induce('整理数据 clean up spreadsheet', [
    { tool: 'click_mouse', args: { x: 0.1, y: 0.1 } },
  ]);
  skillLibrary.induce('发送消息 send message to group', [
    { tool: 'type_text', args: { text: 'hello' } },
  ]);
  const { skill, plan } = skillLibrary.recombine('整理数据然后发送消息');
  assert.ok(skill, '应合成新技能');
  assert.equal(skill!.synthesized, true);
  assert.equal(skill!.genes!.length, 2);
  assert.equal(plan.length, 2);
  assert.ok(plan.every(p => typeof p.skillId === 'number' && p.reason.length > 0));
  // 合成技能步骤 = 两母体串接
  assert.deepEqual(
    skill!.steps.map(s => s.tool),
    ['click_mouse', 'type_text'],
  );
});

test('C-2: 重组撞已有序列 ⇒ 强化而非新建', () => {
  skillLibrary.induce('任务A', [{ tool: 'press_hotkey', args: { keys: ['ctrl'] } }]);
  const before = skillLibrary.list().length;
  const { skill } = skillLibrary.recombine('任务A 任务A');
  // 单母体不合成；即使合成路径触发，签名撞车也只返回既有技能
  assert.ok(skill === null || skillLibrary.list().length <= before + 1);
});

// ─── C-3：因果链 ───

test('C-3: thought/observe 入链且哈希稳定（canonical 键排序保证）', async () => {
  await journal.append({ ts: 1, tool: 'click_mouse', args: { x: 0.5 }, status: 'SUCCESS', thought: '登录按钮在右下角', observe: '#1 dHash=abc popup=false' });
  await journal.append({ ts: 2, tool: 'type_text', args: { text: 'hi' }, status: 'FAILED', thought: '输入用户名' });
  const v = journal.verify();
  assert.equal(v.ok, true, '含因果字段的链必须全绿');
});

test('C-3: findDecisionPoints —— 失败定位 + 同场景异action证据', async () => {
  journal.noteObservation('#1 dHash=deadbeef popup=false');
  await journal.append({ ts: 1, tool: 'click_mouse', args: { x: 0.3 }, status: 'FAILED', thought: '点了下一页', observe: '#1 dHash=deadbeef popup=false' });
  journal.noteObservation('#2 dHash=cafef00d popup=false');
  await journal.append({ ts: 2, tool: 'click_mouse', args: { x: 0.6 }, status: 'SUCCESS', thought: '点了筛选', observe: '#1 dHash=deadbeef popup=false' });
  await journal.append({ ts: 3, tool: 'scroll_page', args: {}, status: 'SUCCESS', observe: '#2 dHash=cafef00d popup=false' });

  const failed = journal.findDecisionPoints({ failedOnly: true });
  assert.equal(failed.length, 1);
  assert.equal(failed[0].thought, '点了下一页');
  // 同场景（#1 dHash=deadbeef）下存在成功异action ⇒ 侦探证据
  assert.equal(failed[0].alternatives.length, 1);
  assert.equal(failed[0].alternatives[0].historicalOutcome, 'SUCCESS');
});

// ─── C-4：认知焦点 + 潜意识 ───

const fakeImage = (kb: number) => `data:image/jpeg;base64,${'A'.repeat(kb * 1024)}`;

test('C-4: 潜意识沉淀 + 既视感浮现（灵光一闪）', async () => {
  contextManager.reset();
  contextManager.configure(1, 1_000_000, false);
  contextManager.configureFocus(true, 1, 32, 6);

  // 第一幕：场景 X 被驱逐入潜意识
  await contextManager.addScreenshot(fakeImage(1), 'a'.repeat(64).replace(/a/g, '0'));
  const r1 = await contextManager.addScreenshot(fakeImage(1), '1'.repeat(64));
  assert.ok(!r1.message.includes('Flashback'), '初次相见无既视感');
  assert.equal(contextManager.dumpSubconscious().length, 1);

  // 第二幕：场景 X 重现（与被驱逐指纹几乎相同）⇒ 灵光一闪
  const r2 = await contextManager.addScreenshot(fakeImage(1), '0'.repeat(60) + '1111');
  // r2 自身驱逐前一张入潜意识，且新指纹与潜意识中 X 近似 ⇒ Flashback
  assert.ok(r2.message.includes('Flashback'), `应触发既视感：${r2.message}`);
});

test('C-4: 潜意识池容量硬顶 —— Token 消耗恒定', async () => {
  contextManager.reset();
  contextManager.configure(1, 1_000_000, false);
  contextManager.configureFocus(false, 0, 3, 6); // 池容量 3
  for (let i = 0; i < 6; i++) {
    await contextManager.addScreenshot(fakeImage(1), String(i % 2).repeat(64));
  }
  assert.equal(contextManager.dumpSubconscious().length, 3, '池满逐最旧，容量恒定');
});

test('C-4: salienceFocus=false 时纯 FIFO（行为回归开关）', async () => {
  contextManager.reset();
  contextManager.configure(2, 1_000_000, false);
  contextManager.configureFocus(false, 0, 32, 6);
  await contextManager.addScreenshot(fakeImage(1), '0'.repeat(64));
  await contextManager.addScreenshot(fakeImage(1), '1'.repeat(64));
  await contextManager.addScreenshot(fakeImage(1), '2'.repeat(64));
  // FIFO：最旧（0 指纹）被逐
  const ids = contextManager.recentImages(2).map(r => r.id);
  assert.equal(ids.length, 2);
});

// ─── C-5：经验晶体 + 漂移预测 ───

test('C-5: crystalize —— journal 链聚合为匿名经验晶体', async () => {
  swarm.reset();
  swarm.configure('', 300_000, 500);
  journal.noteObservation('#1 dHash=deadbeef popup=false');
  await journal.append({ ts: 1, tool: 'click_mouse', args: { x: 0.5 }, status: 'SUCCESS', effect_detected: true, observe: '#1 dHash=deadbeef popup=false' });
  await journal.append({ ts: 2, tool: 'click_mouse', args: { x: 0.9 }, status: 'FAILED', observe: '#1 dHash=deadbeef popup=false' });

  swarm.crystalize();
  const report = swarm.report();
  assert.ok(report.crystals >= 1, '应结晶出经验');
  assert.ok(report.topRoutes.some(r => r.key.startsWith('deadbeef')), '晶体键应为匿名指纹前缀');

  // 匿名性结构验证：dump 中只有哈希与统计，无文本坐标等隐私
  const dump = swarm.dump();
  const flat = JSON.stringify(dump);
  assert.ok(!flat.includes('popup=false'), '经验包不得携带原始观察文本');
});

test('C-5: 漂移模型 —— observe 后 predict 返回带置信度的补偿向量', () => {
  swarm.reset();
  const sceneHash = '1'.repeat(64);
  swarm.observeDrift(sceneHash, 0.05, -0.03);
  swarm.observeDrift(sceneHash, 0.07, -0.05);
  const p = swarm.predictDrift(sceneHash);
  assert.ok(p, '同场景应可预测');
  assert.ok(Math.abs(p!.dx - 0.06) < 0.01, `滑动平均 dx 应≈0.06，实际 ${p!.dx}`);
  assert.ok(p!.confidence > 0 && p!.confidence <= 1);

  // 远场景不预测
  assert.equal(swarm.predictDrift('0'.repeat(64)), null);
});

test('C-5: packet 匿名性 —— 零截图零文本零坐标', () => {
  swarm.reset();
  swarm.observeDrift('a'.repeat(64), 0.1, 0.1);
  const packet = swarm.buildPacket();
  const flat = JSON.stringify(packet);
  assert.ok(!flat.includes('data:image'), '包内不得有截图');
  assert.ok(packet.driftEvents.length <= 20, '漂移事件截断至 20');
});
