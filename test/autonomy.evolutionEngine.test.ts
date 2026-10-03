// test/autonomy.evolutionEngine.test.ts
// 纪元 Φ（自主智能环）·Φ-5 执法册：进化引擎的确定性进化律——权重升降夹取 / 关键词恢复加成 / 教训去重升级 / 蒸馏门 / 建议三分支；
// 纪元 Δ 增律：reset 清账回出厂 / history 环形上限 200（ingest 与构造播种皆保新）/ getter 返回副本防篡改。全离线。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EvolutionEngine, shouldDistillSkill, failureSignature, type RunRecord } from '../src/autonomy/evolutionEngine.ts';

/** 运行记录工厂：只覆写关心的字段 */
const R = (o: Partial<RunRecord> = {}): RunRecord => ({
  goal: '演示目标', success: true, steps: 3, durationMs: 1_000, strategies: ['click'], ...o,
});

test('Φ-5: heuristics 初值——五键全 1.0、表形状恒定、空历史', () => {
  const e = new EvolutionEngine();
  assert.deepEqual(e.heuristics(), { scroll: 1, inspect: 1, ask_vlm: 1, recall_skill: 1, click: 1 });
  assert.equal(Object.keys(e.heuristics()).length, 5);
  assert.equal(e.history.length, 0);
});

test('Φ-5: 成功奖励——出现过的策略去重 +0.1，未知 kind 不入表', () => {
  const e = new EvolutionEngine();
  e.ingest(R({ strategies: ['click', 'scroll', 'click', 'type_text'] }));
  const h = e.heuristics();
  assert.equal(h.click, 1.1, 'click 出现 2 次仍只 +0.1（一次运行的证据量是 1）');
  assert.equal(h.scroll, 1.1);
  assert.equal(h.inspect, 1);
  assert.equal(h.ask_vlm, 1);
  assert.equal(h.recall_skill, 1);
  assert.equal(Object.keys(h).length, 5, '未知 kind（type_text）不产生第六个权重键');
});

test('Φ-5: 权重上夹取——封顶 2.0，触顶后实际 delta 归零', () => {
  const e = new EvolutionEngine();
  for (let i = 0; i < 10; i++) e.ingest(R({ strategies: ['click'] }));
  assert.equal(e.heuristics().click, 2, '十次成功恰好 1.0 + 10×0.1 触顶');
  e.ingest(R({ strategies: ['click'] }));
  assert.equal(e.heuristics().click, 2, '触顶后不再上涨');
  const adj = e.report().weightAdjustments;
  assert.equal(adj.length, 1);
  assert.equal(adj[0].heuristic, 'click');
  assert.equal(adj[0].delta, 0, '触顶轮的夹取对读者可见：实际增量 0');
});

test('Φ-5: 失败惩罚——末两步位置语义（重复叠加）与下限 0.2', () => {
  const e = new EvolutionEngine();
  e.ingest(R({ success: false, strategies: ['scroll', 'click', 'click'], failureRootCause: 'timeout' }));
  const h = e.heuristics();
  assert.equal(h.click, 0.7, '末两步均为 click：两处位置各罚 0.15（叠加）');
  assert.equal(h.scroll, 1, 'scroll 不在末两步，不受罚');
  const e2 = new EvolutionEngine();
  for (let i = 0; i < 6; i++) e2.ingest(R({ success: false, strategies: ['click'] }));
  assert.equal(e2.heuristics().click, 0.2, '六次失败降到下限 0.2');
  e2.ingest(R({ success: false, strategies: ['click'] }));
  assert.equal(e2.heuristics().click, 0.2, '触底后再罚不动');
  assert.equal(e2.report().weightAdjustments[0].delta, 0, '触底轮的实际减量被夹为 0');
});

test('Φ-5: 失败关键词恢复加成——popup/focus→inspect、ocr→ask_vlm、大小写不敏感、多关键词叠加', () => {
  const e = new EvolutionEngine();
  e.ingest(R({ success: false, strategies: ['click', 'scroll'], failureRootCause: 'popup overlay blocked the button' }));
  let h = e.heuristics();
  assert.equal(h.click, 0.85, '末两步照常受罚');
  assert.equal(h.scroll, 0.85);
  assert.equal(h.inspect, 1.05, 'popup ⇒ inspect 对症 +0.05');
  assert.equal(h.ask_vlm, 1, 'popup 不加 ask_vlm');
  const e2 = new EvolutionEngine();
  e2.ingest(R({ success: false, strategies: [], failureRootCause: 'Focus lost mid-task' }));
  assert.equal(e2.heuristics().inspect, 1.05, 'focus ⇒ inspect（空策略零惩罚，只剩加成）');
  const e3 = new EvolutionEngine();
  e3.ingest(R({ success: false, strategies: ['click'], failureRootCause: 'OCR engine returned garbage' }));
  assert.equal(e3.heuristics().ask_vlm, 1.05, 'ocr（大小写不敏感）⇒ ask_vlm');
  assert.equal(e3.heuristics().inspect, 1, 'ocr 不加 inspect');
  const e4 = new EvolutionEngine();
  e4.ingest(R({ success: false, strategies: [], failureRootCause: 'popup stole Focus while OCR ran' }));
  h = e4.heuristics();
  assert.equal(h.inspect, 1.1, 'popup+focus 双关键词都映射 inspect：两次 +0.05 叠加');
  assert.equal(h.ask_vlm, 1.05, 'ocr 同时在场：ask_vlm +0.05');
  const adj = e4.report().weightAdjustments;
  const insp = adj.filter(a => a.heuristic === 'inspect');
  assert.equal(insp.length, 2, 'popup 与 focus 各产生一条加成记录');
  assert.ok(insp.every(a => a.delta === 0.05), '每条加成各 +0.05');
  assert.ok(insp.some(a => a.reason.includes('popup')) && insp.some(a => a.reason.includes('focus')), '加成归因写明关键词');
});

test('Φ-5: lessons——失败教训带签名前缀、同签名去重升级、低效路径按 goal 去重', () => {
  const e = new EvolutionEngine();
  e.ingest(R({ goal: '开票', success: false, steps: 4, strategies: ['click', 'scroll'], failureRootCause: 'popup' }));
  let lessons = e.report().lessons;
  assert.equal(lessons.length, 1);
  assert.ok(lessons[0].startsWith('fail|popup|click>scroll'), '教训以 failureSignature 为前缀');
  assert.ok(!lessons[0].includes('重复失败模式'), '首犯不是重复模式');
  e.ingest(R({ goal: '换一个目标', success: false, steps: 6, strategies: ['click', 'scroll'], failureRootCause: 'popup' }));
  lessons = e.report().lessons;
  assert.equal(lessons.length, 1, '同签名去重：仍只占一席（签名不含 goal）');
  assert.ok(lessons[0].includes('重复失败模式') && lessons[0].includes('第 2 次'), '第 2 次升级为更高优先级句式');
  e.ingest(R({ goal: '再换', success: false, steps: 2, strategies: ['click', 'scroll'], failureRootCause: 'popup' }));
  lessons = e.report().lessons;
  assert.equal(lessons.length, 1);
  assert.ok(lessons[0].includes('第 3 次'), '第 3 次句式随次数升级，仍只一席');
  e.ingest(R({ success: false, strategies: ['scroll'], failureRootCause: 'timeout' }));
  assert.equal(e.report().lessons.length, 2, '异签名各占一席');
  // 低效路径：阈值 = distillMaxSteps×2（严格大于才触发），同 goal 去重
  const slow = new EvolutionEngine();
  slow.ingest(R({ goal: '慢任务', success: true, steps: 24, strategies: ['scroll', 'click'] }));
  assert.ok(!slow.report().lessons.some(l => l.includes('低效路径')), '24 步 = 阈值（12×2）：不触发');
  slow.ingest(R({ goal: '慢任务', success: true, steps: 25, strategies: ['scroll'] }));
  slow.ingest(R({ goal: '慢任务', success: true, steps: 30, strategies: ['scroll'] }));
  const slowLessons = slow.report().lessons.filter(l => l.includes('低效路径'));
  assert.equal(slowLessons.length, 1, '同 goal 低效教训只记一次');
  assert.ok(slowLessons[0].includes('25'), '记录首次触发的步数');
  const custom = new EvolutionEngine({ distillMaxSteps: 5 });
  custom.ingest(R({ goal: 'g', success: true, steps: 11, strategies: ['click'] }));
  assert.ok(custom.report().lessons.some(l => l.includes('低效路径')), '自定义 N=5 ⇒ 阈值 10，11 步触发');
});

test('Φ-5: 蒸馏门——shouldDistillSkill 四象限 + 引擎重复蒸馏 reliability 递增封顶', () => {
  assert.equal(shouldDistillSkill(R({ steps: 12, strategies: ['click'] })), true, '成功 + 12 步 + 非空策略 ⇒ 可蒸馏');
  assert.equal(shouldDistillSkill(R({ steps: 13, strategies: ['click'] })), false, '超步不可');
  assert.equal(shouldDistillSkill(R({ steps: 12, strategies: [] })), false, '空策略不可');
  assert.equal(shouldDistillSkill(R({ steps: 3, strategies: ['click'], success: false })), false, '失败不可');
  assert.equal(shouldDistillSkill(R({ steps: 13, strategies: ['click'] }), 20), true, '自定义上限放宽');
  const e = new EvolutionEngine();
  e.ingest(R({ success: false, strategies: ['click'] }));
  assert.equal(e.report().distilledSkill, undefined, '失败运行不蒸馏');
  e.ingest(R({ goal: '大目标', steps: 20, strategies: ['click'] }));
  assert.equal(e.report().distilledSkill, undefined, '成功但超步（20 > 12）不蒸馏');
  e.ingest(R({ goal: '登录邮箱', steps: 8, strategies: ['click', 'scroll'] }));
  let s = e.report().distilledSkill!;
  assert.equal(s.description, '自动技能：登录邮箱');
  assert.deepEqual(s.steps, ['click → scroll'], '策略序列映射为可读路径串');
  assert.equal(s.reliability, 0.5, '首蒸馏可靠度 0.5');
  for (let i = 0; i < 4; i++) e.ingest(R({ goal: '登录邮箱', steps: 9, strategies: ['click', 'scroll'] }));
  s = e.report().distilledSkill!;
  assert.equal(s.reliability, 0.9, '同 goal 复蒸馏 4 次：0.5 + 4×0.1（不重复建卡）');
  assert.ok(e.report().nextRunAdvice.join(' ').includes('1 个蒸馏技能'), '同 goal 去重：始终只有 1 张技能卡');
  e.ingest(R({ goal: '登录邮箱', steps: 9, strategies: ['click'] }));
  assert.equal(e.report().distilledSkill!.reliability, 0.95, '封顶 0.95');
  e.ingest(R({ goal: '登录邮箱', steps: 9, strategies: ['click'] }));
  assert.equal(e.report().distilledSkill!.reliability, 0.95, '触顶后不再上涨');
  e.ingest(R({ goal: '导出报表', steps: 5, strategies: ['scroll'] }));
  assert.equal(e.report().distilledSkill!.description, '自动技能：导出报表', '多 goal 各建卡，报告展示最近触达的技能');
  assert.ok(e.report().nextRunAdvice.join(' ').includes('2 个蒸馏技能'));
});

test('Φ-5: failureSignature——精确格式 / ok-fail / unknown / 前 4 策略 / 截 80 字 / 防御不抛', () => {
  const r: RunRecord = { goal: 'g', success: false, steps: 3, durationMs: 1, strategies: ['click', 'scroll', 'click', 'type', 'inspect'], failureRootCause: 'popup' };
  assert.equal(failureSignature(r), 'fail|popup|click>scroll>click>type', '只取前 4 个策略，> 连接');
  assert.equal(failureSignature(R({ success: true, strategies: ['click'], failureRootCause: 'timeout' })), 'ok|timeout|click');
  assert.equal(failureSignature(R({ success: false, strategies: ['click'] })), 'fail|unknown|click', '无根因 ⇒ unknown');
  const long = failureSignature(R({ success: false, strategies: ['click'], failureRootCause: 'x'.repeat(100) }));
  assert.equal(long.length, 80, '超长签名截 80 字');
  assert.ok(long.startsWith('fail|x'));
  assert.equal(failureSignature(r), failureSignature({ ...r }), '同输入同输出（纯函数稳定）');
  assert.equal(failureSignature({} as RunRecord), 'fail|unknown|', '空记录不抛：防御降级');
});

test('Φ-5: nextRunAdvice 三分支——先行最高权重 / 重复失败 escalate / 蒸馏技能 recall', () => {
  const fresh = new EvolutionEngine();
  const a0 = fresh.report().nextRunAdvice;
  assert.equal(a0.length, 1, '空历史只有先行建议');
  assert.ok(a0[0].includes('scroll'), '全 1.0 平票按固定序（scroll/inspect/ask_vlm/recall_skill/click）由 scroll 胜出');
  const e = new EvolutionEngine();
  e.ingest(R({ goal: '探索', steps: 5, strategies: ['inspect', 'click'] }));
  e.ingest(R({ goal: '探索', steps: 5, strategies: ['inspect'] }));
  e.ingest(R({ goal: '填表', success: false, steps: 4, strategies: ['click'], failureRootCause: 'popup' }));
  e.ingest(R({ goal: '再填', success: false, steps: 4, strategies: ['click'], failureRootCause: 'popup' }));
  const advice = e.report().nextRunAdvice;
  assert.equal(advice.length, 3, '三分支齐备');
  assert.ok(advice[0].includes('inspect'), 'inspect（1.2 + 0.05×2 = 1.3）权重最高 ⇒ 先行推荐');
  assert.ok(advice[1].includes('escalate') && advice[1].includes('fail|popup|click') && advice[1].includes('2 次'), '重复失败签名 ⇒ 建议 escalate');
  assert.ok(advice[2].includes('recall_skill') && advice[2].includes('1 个'), '有蒸馏技能 ⇒ 优先 recall');
});

test('Φ-5: 构造器播种同律重放 + report 纯派生幂等 + 坏输入绝不抛', () => {
  const seeded = [
    R({ goal: 'a', success: false, strategies: ['click'], failureRootCause: 'popup' }),
    R({ goal: 'b', steps: 4, strategies: ['scroll'] }),
  ];
  const e = new EvolutionEngine({ history: seeded });
  assert.equal(e.history.length, 2, '播种历史直接在场');
  assert.equal(e.heuristics().inspect, 1.05, '播种历史同律重放（popup ⇒ inspect +0.05）');
  const adj = e.report().weightAdjustments;
  assert.equal(adj.length, 1, 'weightAdjustments = 末轮（成功 scroll +0.1）');
  assert.equal(adj[0].heuristic, 'scroll');
  assert.equal(adj[0].delta, 0.1);
  assert.deepEqual(e.report(), e.report(), 'report 纯派生：两次调用逐字相等（无缓存错位）');
  // 坏输入：绝不抛异常
  const e2 = new EvolutionEngine();
  e2.ingest(undefined as unknown as RunRecord);
  e2.ingest(null as unknown as RunRecord);
  e2.ingest({} as RunRecord);
  assert.equal(e2.history.length, 1, 'null/undefined 静默拒收，空对象计入');
  let report: ReturnType<EvolutionEngine['report']> | null = null;
  assert.doesNotThrow(() => { report = e2.report(); e2.heuristics(); });
  assert.equal(report!.lessons.length, 1, '空对象按无策略失败诚实降级记账');
  const e3 = new EvolutionEngine({ distillMaxSteps: 0 });
  e3.ingest(R({ steps: 12, strategies: ['click'] }));
  assert.ok(e3.report().distilledSkill, 'distillMaxSteps=0 非法 ⇒ 回落默认 12，12 步仍可蒸馏');
});

// ─── 纪元 Δ：reset / history 环形上限 200 / getter 副本 ───

test('Φ-5: reset —— 清账回到出厂（history 空、权重全 1.0、零教训零技能）', () => {
  const e = new EvolutionEngine();
  e.ingest(R({ goal: '可蒸馏任务', steps: 3, strategies: ['click'] }));
  e.ingest(R({ goal: '失败任务', success: false, strategies: ['click'], failureRootCause: 'popup' }));
  assert.equal(e.history.length, 2);
  const before = e.report();
  assert.ok(before.distilledSkill, '前置：已有蒸馏技能');
  assert.equal(before.lessons.length, 1, '前置：已有教训');

  e.reset();
  assert.equal(e.history.length, 0, 'history 归零');
  assert.deepEqual(e.heuristics(), { scroll: 1, inspect: 1, ask_vlm: 1, recall_skill: 1, click: 1 }, '权重回出厂');
  const after = e.report();
  assert.equal(after.distilledSkill, undefined, '蒸馏记忆清空');
  assert.equal(after.lessons.length, 0, '教训清空');
  assert.equal(after.weightAdjustments.length, 0, '末轮调整清空');
  // reset 后可重新积累（换场不报废引擎）
  e.ingest(R({ steps: 3, strategies: ['scroll'] }));
  assert.equal(e.history.length, 1);
  assert.equal(e.heuristics().scroll, 1.1);
});

test('Φ-5: history 环形上限 200 —— 第 201 条起最旧记录被挤出（保新），构造播种同律', () => {
  const e = new EvolutionEngine();
  for (let i = 0; i < 205; i++) e.ingest(R({ goal: `任务${i}`, steps: 3, strategies: ['click'] }));
  assert.equal(e.history.length, 200, '上限恒 200');
  assert.equal(e.history[0]!.goal, '任务5', '最旧 5 条被挤出：账本从任务5 起');
  assert.equal(e.history[199]!.goal, '任务204', '最新一条在场');
  // 构造播种超限同律截尾保新
  const seeded = Array.from({ length: 203 }, (_, i) => R({ goal: `种子${i}` }));
  const e2 = new EvolutionEngine({ history: seeded });
  assert.equal(e2.history.length, 200);
  assert.equal(e2.history[0]!.goal, '种子3', '播种截尾：最旧 3 条被挤出');
  assert.equal(e2.history[199]!.goal, '种子202');
});

test('Φ-5: history getter 返回副本 —— 外部增删改返回值不透内部账本', () => {
  const e = new EvolutionEngine();
  e.ingest(R({ goal: '唯一记录', steps: 3, strategies: ['click'] }));
  const view = e.history;
  assert.equal(view.length, 1);
  (view as unknown as RunRecord[]).push(R({ goal: '混入' }));
  (view as unknown as RunRecord[]).pop(); // 恢复视图长度，再验证底层不受影响
  const hostile = e.history as unknown as RunRecord[];
  hostile.push(R({ goal: '恶意混入' }));
  hostile.splice(0, 1);
  assert.equal(e.history.length, 1, '内部账本不受返回值增删影响');
  assert.equal(e.history[0]!.goal, '唯一记录');
});
