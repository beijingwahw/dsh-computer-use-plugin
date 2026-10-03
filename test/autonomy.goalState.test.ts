// test/autonomy.goalState.test.ts
// 纪元 Φ（Φ-1）：目标状态机离线全参数测试 —— 构造降级 / goal 超长截断（纪元 Δ：
// 2000 字符上限 + 「goal 截断」blocker + 降级判据取截断后文本）/ begin·tick /
// evaluate 七相全转移 / recordCriterion 越界静默 / toAnchor 数字手算 /
// progress·spec 深拷贝防篡改 / recordAll 终局便捷。
// 铁律：时间全部注入（假时钟 set/adv），零墙钟、零网络、绝不依赖测试顺序。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { GoalStateMachine } = await import('../src/autonomy/goalState.ts');

/** 假时钟：set 定格 / adv 推进 —— 测试里没有一毫秒是「真」的。 */
function mkClock(t0: number): { now: () => number; set: (t: number) => void; adv: (d: number) => void } {
  let t = t0;
  return {
    now: () => t,
    set: (v: number) => { t = v; },
    adv: (d: number) => { t += d; },
  };
}

const SPEC = { goal: '打开记事本并输入 hello', successCriteria: ['记事本窗口出现', 'hello 已录入'] };

// ─── Φ-1 构造降级（绝不抛，非法逐项记 blocker） ───

test('Φ-1: 构造降级——空 successCriteria 化身一条字面 goal 判据并记 blocker', () => {
  const c = mkClock(1000);
  const m = new GoalStateMachine({ goal: '打开记事本', successCriteria: [] }, c.now);
  assert.deepEqual(m.spec.successCriteria, ['打开记事本']); // 空判据降级为目标原文
  const p = m.progress;
  assert.equal(p.criteriaStatus.length, 1); // 机器保证 ≥1 条判据
  assert.equal(p.criteriaStatus[0].criterion, '打开记事本');
  assert.equal(p.criteriaStatus[0].status, 'unverified');
  assert.equal(p.blockers.length, 1); // 降级必记 blocker
  assert.match(p.blockers[0]!, /判据/);
  assert.equal(p.phase, 'planning'); // 未 begin 恒 planning
  m.begin();
  assert.equal(m.evaluate().phase, 'blocked'); // 降级 blocker 使执行立即受阻塞（需人工 clearBlockers 放行）
});

test('Φ-1: 垃圾 spec 与非法预算同样降级不抛（null / maxSteps<1 / timeBudgetSec<1）', () => {
  const c = mkClock(0);
  const m = new GoalStateMachine(null as never, c.now);
  assert.equal(m.spec.goal, '');
  assert.equal(m.progress.criteriaStatus.length, 1); // 无判据也有兜底一条
  assert.ok(m.progress.blockers.length >= 2);        // spec 非对象 + goal 非字符串
  const n = new GoalStateMachine({ goal: 'g', successCriteria: ['c'], maxSteps: 0, timeBudgetSec: 0.5 }, c.now);
  assert.equal(n.spec.maxSteps, 24);       // 非法步数 → 缺省 24
  assert.equal(n.spec.timeBudgetSec, 300); // 非法时长 → 缺省 300
  assert.equal(n.progress.blockers.length, 2);
  assert.doesNotThrow(() => new GoalStateMachine(undefined as never, c.now)); // 任意垃圾绝不抛
});

test('Φ-1: 缺省时钟注入（不传 now 走 Date.now）构造不抛、未 begin 恒 planning', () => {
  const m = new GoalStateMachine({ ...SPEC });
  assert.equal(m.evaluate().phase, 'planning');
  assert.equal(m.progress.startedAt, 0);
});

// ─── Φ-1 goal 超长截断（纪元 Δ：器官层限长） ───

test('Φ-1: goal 超长截断 —— 超 2000 字符截取前 2000 并记 blocker（「goal 截断」+ 原文长度）', () => {
  const c = mkClock(0);
  const m = new GoalStateMachine({ goal: 'x'.repeat(2500), successCriteria: ['判据'] }, c.now);
  assert.equal(m.spec.goal.length, 2000, '构造期即截断');
  assert.equal(m.spec.goal, 'x'.repeat(2000));
  assert.equal(m.progress.blockers.length, 1, '截断记一条 blocker');
  assert.match(m.progress.blockers[0]!, /goal 截断/);
  assert.ok(m.progress.blockers[0]!.includes('2500'), 'blocker 携带原文长度供审计');
  assert.equal(m.evaluate().phase, 'planning', '截断不改变未 begin 相位');
});

test('Φ-1: 恰 2000 字符不截断（严格大于才触发）；空判据降级用截断后的 goal 作字面判据', () => {
  const exact = new GoalStateMachine({ goal: 'y'.repeat(2000), successCriteria: ['判据'] });
  assert.equal(exact.spec.goal.length, 2000);
  assert.equal(exact.progress.blockers.length, 0, '恰等上限：合法不记 blocker');
  const m = new GoalStateMachine({ goal: 'z'.repeat(2001), successCriteria: [] });
  assert.equal(m.spec.goal.length, 2000);
  assert.deepEqual(m.spec.successCriteria, ['z'.repeat(2000)], '降级字面判据 = 截断后的 goal（机器内部零超长文本）');
  assert.equal(m.progress.blockers.length, 2, 'goal 截断 + 判据为空 各记一条');
  assert.ok(m.progress.blockers.some(b => /goal 截断/.test(b)));
  assert.ok(m.progress.blockers.some(b => /判据/.test(b)));
});

// ─── Φ-1 begin / tick：执行生命周期与步账 ───

test('Φ-1: begin 记时进 acting、tick 计步且仅 acting 态生效、lastUpdateAt 随动', () => {
  const c = mkClock(1000);
  const m = new GoalStateMachine({ ...SPEC }, c.now);
  assert.equal(m.evaluate().phase, 'planning'); // begin 前恒 planning
  assert.equal(m.progress.startedAt, 0);        // 未开始无起点
  assert.equal(m.progress.lastUpdateAt, 1000);  // 构造即记时
  m.tick(); // planning 态 tick 无效
  assert.equal(m.progress.stepIndex, 0);
  c.adv(500); // t=1500
  m.begin();
  assert.equal(m.progress.startedAt, 1500);
  assert.equal(m.progress.lastUpdateAt, 1500);
  assert.equal(m.evaluate().phase, 'acting');
  c.adv(100); // t=1600
  m.tick(); m.tick(); m.tick();
  const p = m.progress;
  assert.equal(p.stepIndex, 3);
  assert.equal(p.lastUpdateAt, 1600); // 每次有效 tick 刷新
  m.begin(); // 重复 begin 幂等（起点不漂移）
  assert.equal(m.progress.startedAt, 1500);
});

// ─── Φ-1 evaluate() 七相全转移（纯确定判定律，按序短路） ───

test('Φ-1: 相·planning——未 begin 一切未核 ⇒ planning（reason 一句中文）', () => {
  const c = mkClock(42);
  const m = new GoalStateMachine({ ...SPEC }, c.now);
  const e = m.evaluate();
  assert.equal(e.phase, 'planning');
  assert.equal(typeof e.reason, 'string');
  assert.ok(e.reason.length > 0);
  assert.ok(e.reason.endsWith('。')); // 一句中文（句号收尾）
});

test('Φ-1: 相·achieved——全判据 met 即达成（且判据终局压过超步：达上限后仍可翻盘）', () => {
  const c = mkClock(0);
  const m = new GoalStateMachine({ ...SPEC, maxSteps: 2 }, c.now);
  m.begin();
  m.tick(); m.tick();
  assert.equal(m.evaluate().phase, 'aborted'); // 先确认已超步
  m.recordAll('met');                          // 判据终局优先于步数预算
  assert.equal(m.evaluate().phase, 'achieved');
  assert.match(m.evaluate().reason, /达成/);
  assert.equal(m.progress.phase, 'achieved'); // progress 与 evaluate 同律
});

test('Φ-1: 相·failed——任一 violated 即终局（压过 met 与其余一切）', () => {
  const c = mkClock(0);
  const m = new GoalStateMachine({ ...SPEC }, c.now);
  m.begin();
  m.recordCriterion(0, 'met');
  m.recordCriterion(1, 'violated');
  const e = m.evaluate();
  assert.equal(e.phase, 'failed');
  assert.match(e.reason, /违反/);
  m.recordCriterion(0, 'violated'); // 首条也翻违规后仍 failed
  assert.equal(m.evaluate().phase, 'failed');
});

test('Φ-1: 相·blocked——acting 且有阻塞；blocked 态 tick 无效；clearBlockers 后回归 acting 恢复计步', () => {
  const c = mkClock(0);
  const m = new GoalStateMachine({ ...SPEC }, c.now);
  m.begin();
  m.addBlocker('窗口被对话框遮挡');
  assert.equal(m.evaluate().phase, 'blocked');
  assert.match(m.evaluate().reason, /阻塞/);
  m.tick(); // blocked 态 tick 不生效
  assert.equal(m.progress.stepIndex, 0);
  m.clearBlockers();
  assert.equal(m.evaluate().phase, 'acting'); // 纯推导自动回归，无需显式转相
  m.tick();
  assert.equal(m.progress.stepIndex, 1);
});

test('Φ-1: 相·aborted（超步）——stepIndex 达 maxSteps 即中止，此后 tick 冻结', () => {
  const c = mkClock(0);
  const m = new GoalStateMachine({ ...SPEC, maxSteps: 2 }, c.now);
  m.begin();
  m.tick();
  assert.equal(m.evaluate().phase, 'acting'); // 1 < 2 仍在执行
  m.tick();
  const e = m.evaluate();
  assert.equal(e.phase, 'aborted'); // 2 ≥ 2
  assert.match(e.reason, /步/);
  m.tick(); // 终局相 tick 无效
  assert.equal(m.progress.stepIndex, 2);
});

test('Φ-1: 相·aborted（超时）——严格大于才判超（恰等预算仍 acting）', () => {
  const c = mkClock(5000);
  const m = new GoalStateMachine({ ...SPEC, timeBudgetSec: 10 }, c.now);
  m.begin(); // startedAt=5000，预算 10000ms
  c.set(15000);
  assert.equal(m.evaluate().phase, 'acting'); // elapsed=10000 不大于 10000
  c.set(15001);
  const e = m.evaluate();
  assert.equal(e.phase, 'aborted'); // elapsed=10001 > 10000
  assert.match(e.reason, /超/);
});

test('Φ-1: 相·acting——begin 后判据未核/无阻塞/预算内 ⇒ acting（reason 携带步账）', () => {
  const c = mkClock(0);
  const m = new GoalStateMachine({ ...SPEC }, c.now);
  m.begin();
  m.tick();
  const e = m.evaluate();
  assert.equal(e.phase, 'acting');
  assert.match(e.reason, /1\/24/); // 已用 1 步 / 缺省上限 24
});

// ─── Φ-1 recordCriterion：越界与非法输入静默 ───

test('Φ-1: recordCriterion 越界/非法输入静默忽略（-1、99、1.5、垃圾状态），合法路径不受影响', () => {
  const c = mkClock(0);
  const m = new GoalStateMachine({ ...SPEC }, c.now);
  m.begin();
  m.recordCriterion(-1, 'met');
  m.recordCriterion(99, 'met');
  m.recordCriterion(1.5, 'met'); // 非整数索引
  m.recordCriterion(0, 'nonsense' as never); // 非法状态
  for (const cs of m.progress.criteriaStatus) assert.equal(cs.status, 'unverified');
  m.recordCriterion(0, 'met'); // 合法写入照常
  assert.equal(m.progress.criteriaStatus[0]!.status, 'met');
});

// ─── Φ-1 toAnchor：扁平锚点数字全手算 ───

test('Φ-1: toAnchor 数字手算对照（phase/step_index/steps_budget/elapsed_ms/criteria/blockers）', () => {
  const c = mkClock(100);
  const m = new GoalStateMachine({ ...SPEC, maxSteps: 5, timeBudgetSec: 60 }, c.now);
  assert.deepEqual(m.toAnchor(), {
    phase: 'planning', step_index: 0, steps_budget: 5,
    elapsed_ms: 0, criteria: { met: 0, total: 2 }, blockers: [],
  }); // 未 begin：elapsed_ms 恒 0
  c.set(300);
  m.begin(); // startedAt=300
  c.set(500);
  m.tick(); m.tick();
  m.recordCriterion(0, 'met');
  const a = m.toAnchor();
  assert.equal(a.phase, 'acting');
  assert.equal(a.step_index, 2);
  assert.equal(a.steps_budget, 5);
  assert.equal(a.elapsed_ms, 200); // 500-300 手算
  assert.deepEqual(a.criteria, { met: 1, total: 2 });
  assert.deepEqual(a.blockers, []);
  (a.blockers as string[]).push('篡改'); // 锚点是副本，篡改不透内部
  assert.equal(m.progress.blockers.length, 0);
});

// ─── Φ-1 progress / spec：防御性深拷贝防篡改 ───

test('Φ-1: progress 深拷贝防篡改——外部改副本（相/步/判据/阻塞）不影响内部', () => {
  const c = mkClock(0);
  const m = new GoalStateMachine({ ...SPEC }, c.now);
  m.begin();
  m.addBlocker('b1');
  const p1 = m.progress;
  p1.phase = 'achieved';
  p1.stepIndex = 99;
  p1.criteriaStatus[0]!.status = 'met';
  p1.criteriaStatus.push({ criterion: '伪判据', status: 'met' });
  p1.blockers.push('b2');
  const p2 = m.progress;
  assert.equal(p2.phase, 'blocked'); // 真相：有 b1 阻塞 ⇒ blocked（副本被改成 achieved 也不透）
  assert.equal(p2.stepIndex, 0);
  assert.equal(p2.criteriaStatus.length, 2);
  assert.equal(p2.criteriaStatus[0]!.status, 'unverified');
  assert.equal(p2.blockers.length, 1);
});

test('Φ-1: spec 亦为防御性副本——篡改返回值不透内部', () => {
  const c = mkClock(0);
  const m = new GoalStateMachine({ ...SPEC }, c.now);
  const s1 = m.spec;
  s1.goal = '篡改';
  s1.successCriteria.push('伪判据');
  s1.maxSteps = 1;
  const s2 = m.spec;
  assert.equal(s2.goal, SPEC.goal);
  assert.deepEqual(s2.successCriteria, SPEC.successCriteria);
  assert.equal(s2.maxSteps, 24);
});

// ─── Φ-1 recordAll：终局便捷通道 ───

test('Φ-1: recordAll 一齐置位（met ⇒ achieved / violated ⇒ failed / 垃圾静默 / 未 begin 亦可记账）', () => {
  const c = mkClock(0);
  const a = new GoalStateMachine({ ...SPEC }, c.now);
  a.begin();
  a.recordAll('met');
  assert.equal(a.evaluate().phase, 'achieved');
  for (const cs of a.progress.criteriaStatus) assert.equal(cs.status, 'met');
  const b = new GoalStateMachine({ ...SPEC }, c.now);
  b.begin();
  b.recordAll('violated');
  assert.equal(b.evaluate().phase, 'failed');
  for (const cs of b.progress.criteriaStatus) assert.equal(cs.status, 'violated');
  const d = new GoalStateMachine({ ...SPEC }, c.now);
  d.recordAll('garbage' as never); // 垃圾状态静默忽略
  for (const cs of d.progress.criteriaStatus) assert.equal(cs.status, 'unverified');
  assert.equal(d.evaluate().phase, 'planning'); // 未 begin
});
