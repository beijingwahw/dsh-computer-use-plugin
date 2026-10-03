// test/w3drift.test.ts
// W3-5（H2 活意图与漂移检测）离线确定性测试：
//   · 漂移评分纯函数 —— 对齐态（同文本 ⇒ sem=0）/ 漂移态（零重合语料 ⇒ sem=1）/
//     停滞通道数值手算（0.3 封顶、半预算满格）/ 锚或屏缺席 ⇒ null（降级律）；
//   · 节律与熵触发 —— N 步周期 / 熵严格大于 0.95 才插队（恰等不触发）；
//   · goalState 增量 —— recordDrift 趋势推导（rising/flat/falling/unknown）、
//     量子化、缺席清账、toAnchor 条件 drift 键（从未记录 ⇒ 键缺席零回归）、
//     amendCriterion 写回与防御、七相纯推导铁律不破（漂移落账不改相位）；
//   · 会话 —— 超阈生成结构化选择题（A/B/C + B 自动生成具体修正）、未超阈不生成、
//     无未核判据不生成、节流（M 步内不重题、账照更）、指纹缺席/返回空/抛异常降级；
//   · 应答 —— 单字符解析容错（大小写/全角/数字/汉字）、垃圾重问、A 放行、
//     B 写回判据（状态重置 unverified）、C 记终止阻塞（blocked 收场）；
//   · 工具工厂 —— steer_choice / steer_answer 的 execute 面（JSON 载荷契约）。
// 铁律：零网络、零真屏、零真钟（假时钟注入），一切断言可手算复现。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GoalStateMachine } from '../src/autonomy/goalState.ts';
import { entropyWarrantsDriftCheck, DRIFT_ENTROPY_TRIGGER } from '../src/autonomy/uncertainty.ts';
import {
  DRIFT_ALERT_THRESHOLD,
  DRIFT_CHECK_INTERVAL_STEPS,
  STEER_THROTTLE_STEPS,
  scoreDrift,
  shouldCheckDrift,
  buildSteerChoice,
  parseSteerAnswer,
  createSteerSession,
  createSteerChoiceTool,
  createSteerAnswerTool,
  type SteerSession,
} from '../src/tools/steerTools.ts';

/** 假时钟：测试里没有一毫秒是「真」的 */
function mkClock(t0: number): () => number {
  let t = t0;
  return () => t;
}

/** 测试语料（事实源）：意图侧锚点与屏幕侧语料零词重合 ⇒ cosine=0 ⇒ sem=1 */
const SPEC = {
  goal: 'open notepad and type hello',
  successCriteria: ['notepad window visible', 'hello typed'],
};
const ALIGNED_SCREEN = 'notepad window visible hello typed open notepad and type hello';
const DRIFTED_SCREEN = '购物车 结算 优惠券 立即支付';

/** 目标机便捷铸造（假时钟 + begin） */
function mkGoal(begun = true): GoalStateMachine {
  const m = new GoalStateMachine({ ...SPEC, maxSteps: 24 }, mkClock(1000));
  if (begun) m.begin();
  return m;
}

/** 工具执行面便捷转换（与 w1approval.test.ts 同律） */
type Exec = (args: unknown) => Promise<string>;
function exec(t: unknown): Exec {
  return (t as unknown as { execute: (a: unknown) => Promise<string> }).execute.bind(t);
}

// ─── 漂移评分纯函数：对齐 / 漂移两态 + 数值手算 ───

test('W3-5: 评分·对齐态——屏幕文本与锚点同文 ⇒ sem=0、停滞 0 ⇒ drift 精确 0', () => {
  const d = scoreDrift({
    goalText: SPEC.goal,
    criteria: SPEC.successCriteria,
    screenText: ALIGNED_SCREEN,
    stepsSinceCriterionChange: 0,
    stepsBudget: 24,
  });
  assert.equal(d, 0, 'cosine(v,v)=1 ⇒ sem=0；0.7·0+0.3·0 = 0.000');
});

test('W3-5: 评分·停滞通道数值手算——6 步停滞/预算 24 ⇒ 0.15；12 步（半预算）满格 ⇒ 0.3 封顶', () => {
  const half = scoreDrift({
    goalText: SPEC.goal, criteria: SPEC.successCriteria, screenText: ALIGNED_SCREEN,
    stepsSinceCriterionChange: 6, stepsBudget: 24,
  });
  assert.equal(half, 0.15, 'stag = 6/ceil(24×0.5) = 0.5 ⇒ 0.3×0.5 = 0.150');
  const full = scoreDrift({
    goalText: SPEC.goal, criteria: SPEC.successCriteria, screenText: ALIGNED_SCREEN,
    stepsSinceCriterionChange: 12, stepsBudget: 24,
  });
  assert.equal(full, 0.3, 'stag = 12/12 = 1（饱和）⇒ 0.3 —— 纯停滞永不单独超阈');
  const over = scoreDrift({
    goalText: SPEC.goal, criteria: SPEC.successCriteria, screenText: ALIGNED_SCREEN,
    stepsSinceCriterionChange: 99, stepsBudget: 24,
  });
  assert.equal(over, 0.3, '停滞超饱和线仍封顶 0.3 < 报警线 0.55');
});

test('W3-5: 评分·漂移态——零重合语料 ⇒ sem=1 ⇒ drift 精确 0.7（叠加停滞单调上升）', () => {
  const d0 = scoreDrift({
    goalText: SPEC.goal, criteria: SPEC.successCriteria, screenText: DRIFTED_SCREEN,
    stepsSinceCriterionChange: 0, stepsBudget: 24,
  });
  assert.equal(d0, 0.7, '英文锚点 × 中文屏幕零桶重合 ⇒ cosine=0 ⇒ 0.7·1');
  const d3 = scoreDrift({
    goalText: SPEC.goal, criteria: SPEC.successCriteria, screenText: DRIFTED_SCREEN,
    stepsSinceCriterionChange: 3, stepsBudget: 24,
  });
  assert.equal(d3, 0.775, '0.7 + 0.3×(3/12) = 0.775 > 报警线 0.55');
});

test('W3-5: 评分·降级律——指纹缺席（null/空串/非字符串）或锚缺席 ⇒ null 绝不冒充 0 分', () => {
  for (const bad of [null, '', '   ', undefined, 42]) {
    const d = scoreDrift({
      goalText: SPEC.goal, criteria: SPEC.successCriteria,
      screenText: bad as string | null,
      stepsSinceCriterionChange: 0, stepsBudget: 24,
    });
    assert.equal(d, null, `指纹 ${JSON.stringify(bad)} ⇒ 评分缺席`);
  }
  const noAnchor = scoreDrift({
    goalText: '', criteria: [], screenText: ALIGNED_SCREEN,
    stepsSinceCriterionChange: 0, stepsBudget: 24,
  });
  assert.equal(noAnchor, null, '锚缺席（goal+判据全空）⇒ 不可判 ⇒ null');
});

test('W3-5: 评分·垃圾预算防御——stepsBudget 非法按 24、停滞非法按 0（绝不 NaN）', () => {
  const d = scoreDrift({
    goalText: SPEC.goal, criteria: SPEC.successCriteria, screenText: ALIGNED_SCREEN,
    stepsSinceCriterionChange: Number.NaN, stepsBudget: Number.NaN,
  });
  assert.equal(d, 0, '双脏输入 ⇒ 停滞 0 / 预算 24 ⇒ 0.000');
});

// ─── 节律与熵触发 ───

test('W3-5: 节律——N 步周期触发；非周期步只认熵通道；熵恰等触发线不触发', () => {
  assert.equal(DRIFT_CHECK_INTERVAL_STEPS, 3, '模块常量 N=3（事实源）');
  assert.equal(shouldCheckDrift(3, null), true, '3 是 3 的倍数');
  assert.equal(shouldCheckDrift(6, null), true);
  assert.equal(shouldCheckDrift(4, null), false, '非周期且无熵 ⇒ 不检查');
  assert.equal(shouldCheckDrift(4, 0.96), true, '熵 0.96 > 0.95 ⇒ 即时插队');
  assert.equal(shouldCheckDrift(4, DRIFT_ENTROPY_TRIGGER), false, '恰等 0.95 ⇒ 严格大于才触发');
  assert.equal(shouldCheckDrift(null, 0.99), true, '步序号缺席但熵超阈 ⇒ 检查');
  assert.equal(shouldCheckDrift(null, null), false);
  assert.equal(shouldCheckDrift(-1, null), false, '负步序号 ⇒ 只认熵通道');
});

test('W3-5: 熵判据（uncertainty 增量）——0.951 触发 / 0.95 与 NaN 不触发', () => {
  assert.equal(entropyWarrantsDriftCheck(0.951), true);
  assert.equal(entropyWarrantsDriftCheck(0.95), false);
  assert.equal(entropyWarrantsDriftCheck(Number.NaN), false);
  assert.equal(entropyWarrantsDriftCheck(1), true);
});

// ─── goalState 增量：漂移账与判据修正 ───

test('W3-5: goalState·recordDrift 趋势推导——rising/flat/falling 三段手算 + 首记 unknown', () => {
  const m = mkGoal();
  m.recordDrift(0.2);
  assert.deepEqual(m.toAnchor().drift, { score: 0.2, trend: 'unknown' }, '首记无前值');
  m.recordDrift(0.8);
  assert.deepEqual(m.toAnchor().drift, { score: 0.8, trend: 'rising' }, '+0.6 > 0.05');
  m.recordDrift(0.78);
  assert.deepEqual(m.toAnchor().drift, { score: 0.78, trend: 'flat' }, '-0.02 ∈ [-0.05,0.05]');
  m.recordDrift(0.5);
  assert.deepEqual(m.toAnchor().drift, { score: 0.5, trend: 'falling' }, '-0.28 < -0.05');
});

test('W3-5: goalState·recordDrift 量子化与缺席清账（null ⇒ drift 键消失）', () => {
  const m = mkGoal();
  m.recordDrift(0.45678);
  assert.deepEqual(m.toAnchor().drift, { score: 0.457, trend: 'unknown' }, '三位小数量子化');
  m.recordDrift(0.9);
  assert.ok((m.toAnchor().drift as { score: number }).score > 0);
  m.recordDrift(null);
  assert.equal(m.toAnchor().drift, undefined, '缺席 ⇒ drift 键诚实缺席（不冒充 0 分）');
  m.recordDrift(Number.NaN);
  assert.equal(m.toAnchor().drift, undefined, '非数同缺席');
});

test('W3-5: goalState·漂移落账绝不改相位（七相纯推导铁律）——acting 落账后仍 acting', () => {
  const m = mkGoal();
  m.tick();
  assert.equal(m.evaluate().phase, 'acting');
  m.recordDrift(0.99);
  m.recordDrift(0.01);
  assert.equal(m.evaluate().phase, 'acting', '漂移账不参与判定律');
  assert.equal(m.evaluate().reason.includes('漂移'), false, '判相理由不含漂移字样');
});

test('W3-5: goalState·amendCriterion 写回——文本替换 + 状态重置 unverified；非法输入静默 false', () => {
  const m = mkGoal();
  m.recordCriterion(0, 'met');
  assert.equal(m.amendCriterion(0, 'notepad window visible（修正：改按当前屏幕实况核验）'), true);
  const cs = m.progress.criteriaStatus[0]!;
  assert.equal(cs.status, 'unverified', '修正即新主张——旧证据清零');
  assert.match(cs.criterion, /修正：改按当前屏幕实况核验/);
  assert.equal(m.amendCriterion(-1, 'x'), false, '越界下标');
  assert.equal(m.amendCriterion(99, 'x'), false, '越界上标');
  assert.equal(m.amendCriterion(1.5, 'x'), false, '非整数下标');
  assert.equal(m.amendCriterion(0, ''), false, '空串拒绝');
  assert.equal(m.amendCriterion(0, '   '), false, '空白串拒绝');
  assert.equal(m.progress.criteriaStatus[0]!.criterion.includes('修正'), true, '非法输入不动已写回的账');
});

test('W3-5: goalState·toAnchor 零回归——从未记录漂移的锚点逐字节旧形状', () => {
  const now = mkClock(100);
  const m = new GoalStateMachine({ ...SPEC, maxSteps: 5, timeBudgetSec: 60 }, now);
  assert.deepEqual(m.toAnchor(), {
    phase: 'planning', step_index: 0, steps_budget: 5,
    elapsed_ms: 0, criteria: { met: 0, total: 2 }, blockers: [],
  }, '无 drift 键（条件落键律）');
});

// ─── 会话：出题 / 不出题 / 降级 / 节流 ───

test('W3-5: 会话·超阈生成结构化选择题——A/B/C 三选项、B 携带自动生成的具体修正', () => {
  const goal = mkGoal();
  const s = createSteerSession({ goal, screenText: () => DRIFTED_SCREEN });
  const q = s.maybeCheckAndAsk(3, null);
  assert.ok(q !== null, '步 3 周期触发 + drift 0.775 > 0.55');
  assert.equal(q.kind, 'steer_choice');
  assert.equal(q.asked_at_step, 3);
  assert.deepEqual(q.options.map(o => o.key), ['A', 'B', 'C']);
  assert.equal(q.answer_format, 'single-char');
  assert.equal(q.drift.score, 0.775);
  assert.equal(q.evidence.semantic_distance, 1);
  // B 选项自动生成：来自 goalState 未 met 判据 + 证据数值
  assert.equal(q.amendment.criterion_index, 0, '第一条未核判据');
  assert.equal(q.amendment.from, SPEC.successCriteria[0]);
  assert.ok(q.amendment.to.startsWith(SPEC.successCriteria[0] + '（修正：'), '修正以原判据开头');
  assert.ok(q.amendment.to.includes('语义距离 1.000'), '修正携带语义距离数值');
  // 落账与锚点
  assert.deepEqual(goal.toAnchor().drift, { score: 0.775, trend: 'unknown' });
  assert.equal(s.lastDrift(), 0.775);
  assert.deepEqual(s.pending(), q, '待答题挂起（防御副本）');
});

test('W3-5: 会话·未超阈不生成——对齐屏幕（drift 0.075 ≤ 0.55）⇒ 无题但账照落', () => {
  const goal = mkGoal();
  const s = createSteerSession({ goal, screenText: () => ALIGNED_SCREEN });
  const q = s.maybeCheckAndAsk(3, null);
  assert.equal(q, null, 'sem=0 + stag=3/12 ⇒ drift 0.075 未超阈不出题');
  assert.deepEqual(goal.toAnchor().drift, { score: 0.075, trend: 'unknown' }, '观察不停：0.075 照常落账');
  assert.equal(s.lastDrift(), 0.075);
});

test('W3-5: 会话·报警线严格大于——恰等阈值不出题、略低阈值出题', () => {
  const a = createSteerSession({
    goal: mkGoal(), screenText: () => DRIFTED_SCREEN, driftThreshold: 0.775,
  });
  assert.equal(a.maybeCheckAndAsk(3, null), null, 'drift 0.775 恰等阈值 ⇒ 不触警');
  const b = createSteerSession({
    goal: mkGoal(), screenText: () => DRIFTED_SCREEN, driftThreshold: 0.774,
  });
  assert.ok(b.maybeCheckAndAsk(3, null) !== null, '0.775 > 0.774 ⇒ 触警');
});

test('W3-5: 会话·无未核判据不出题（全 met ⇒ 无可问，绝不误伤）', () => {
  const goal = mkGoal();
  goal.recordAll('met');
  const s = createSteerSession({ goal, screenText: () => DRIFTED_SCREEN });
  assert.equal(s.maybeCheckAndAsk(3, null), null);
  // 会话构造时判据已全 met（签名定格）⇒ 步 3 停滞 3/12 ⇒ drift 0.775 仍照实落账
  assert.deepEqual(goal.toAnchor().drift, { score: 0.775, trend: 'unknown' }, '漂移照实落账（观察不停）');
});

test('W3-5: 会话·B 目标第二条未核判据——第一条 met 后自动瞄准第二条', () => {
  const goal = mkGoal();
  goal.recordCriterion(0, 'met');
  const s = createSteerSession({ goal, screenText: () => DRIFTED_SCREEN });
  const q = s.maybeCheckAndAsk(3, null);
  assert.ok(q !== null);
  assert.equal(q.amendment.criterion_index, 1);
  assert.equal(q.amendment.from, SPEC.successCriteria[1]);
});

test('W3-5: 会话·B 修正可含诊断信号（注入 diagnosisNote 参与自动生成）', () => {
  const goal = mkGoal();
  const s = createSteerSession({
    goal, screenText: () => DRIFTED_SCREEN,
    diagnosisNote: () => 'regime-shift：环境已变，旧坐标失效',
  });
  const q = s.maybeCheckAndAsk(3, null);
  assert.ok(q !== null);
  assert.ok(q.amendment.to.includes('诊断信号：regime-shift'), '诊断信号织入修正文本');
});

test('W3-5: 会话·降级律——指纹源缺席/返回空/返回非字符串/抛异常 ⇒ 不出题不落账', () => {
  const noSource = createSteerSession({ goal: mkGoal() });
  assert.equal(noSource.maybeCheckAndAsk(3, null), null, '无注入指纹源 ⇒ 缺席');
  const emptyRet = createSteerSession({ goal: mkGoal(), screenText: () => '' });
  assert.equal(emptyRet.maybeCheckAndAsk(3, null), null, '返回空串 ⇒ 缺席');
  const garbage = createSteerSession({ goal: mkGoal(), screenText: () => 42 as unknown as string });
  assert.equal(garbage.maybeCheckAndAsk(3, null), null, '返回非字符串 ⇒ 缺席');
  const throwing = createSteerSession({
    goal: mkGoal(),
    screenText: () => { throw new Error('screen source down'); },
  });
  assert.equal(throwing.maybeCheckAndAsk(3, null), null, '指纹源抛异常 ⇒ 吞掉降级');
});

test('W3-5: 会话·节流——M 步窗内不重题但漂移账照更；窗后可再题', () => {
  assert.equal(STEER_THROTTLE_STEPS, 8, '模块常量 M=8（事实源）');
  const goal = mkGoal();
  const s = createSteerSession({ goal, screenText: () => DRIFTED_SCREEN });
  const q1 = s.maybeCheckAndAsk(3, null);
  assert.ok(q1 !== null, '步 3 出题（drift 0.775）');
  const r1 = s.answer('A'); // 放行清待答
  assert.equal(r1.status, 'answered');
  const q3 = s.maybeCheckAndAsk(6, null); // 周期步 6——仍在节流窗内
  assert.equal(q3, null, '步 6 距 3 为 3 < 8 ⇒ 不重题');
  assert.deepEqual(
    goal.toAnchor().drift,
    { score: 0.85, trend: 'rising' },
    '检查照跑：drift = 0.7+0.3×(6/12) = 0.85；0.85-0.775=0.075>0.05 ⇒ rising',
  );
  const q5 = s.maybeCheckAndAsk(11, null);
  assert.equal(q5, null, '步 11 距 3 为 8？非周期步且无熵 ⇒ 节律门先拦（不检查）');
  const q6 = s.maybeCheckAndAsk(12, null);
  assert.ok(q6 !== null, '步 12 距 3 为 9 ≥ 8 且为周期步 ⇒ 窗开可再题');
  assert.equal(q6.asked_at_step, 12);
  assert.deepEqual(
    goal.toAnchor().drift,
    { score: 1, trend: 'rising' },
    'stag = 12/12 饱和 ⇒ drift = 0.7+0.3 = 1；1-0.85=0.15 ⇒ rising',
  );
});

test('W3-5: 会话·熵通道即时出题（非周期步）与步序号兜底（取目标机步账）', () => {
  const goal = mkGoal();
  goal.tick(); goal.tick(); // 目标机步账 = 2
  const s = createSteerSession({ goal, screenText: () => DRIFTED_SCREEN });
  const q = s.maybeCheckAndAsk(null, 0.99);
  assert.ok(q !== null, '熵 0.99 插队 + stepIndex 缺席 ⇒ 兜底取 goal 步账');
  assert.equal(q.asked_at_step, 2, 'asked_at_step 取目标机 stepIndex');
});

test('W3-5: 会话·待答题幂等重显（不叠新题）', () => {
  const s = createSteerSession({ goal: mkGoal(), screenText: () => DRIFTED_SCREEN });
  const q1 = s.maybeCheckAndAsk(3, null);
  const q2 = s.maybeCheckAndAsk(12, null); // 步 12 仍待答 ⇒ 原题重显
  assert.deepEqual(q1, q2);
});

// ─── 单字符解析与应答结算 ───

test('W3-5: 解析·容错——大小写/全角/数字序号/汉字别名全收', () => {
  assert.equal(parseSteerAnswer('A'), 'A');
  assert.equal(parseSteerAnswer('a'), 'A');
  assert.equal(parseSteerAnswer(' B '), 'B', '首尾空白剥除');
  assert.equal(parseSteerAnswer('c'), 'C');
  assert.equal(parseSteerAnswer('Ｂ'), 'B', '全角大写');
  assert.equal(parseSteerAnswer('ｂ'), 'B', '全角小写');
  assert.equal(parseSteerAnswer('1'), 'A');
  assert.equal(parseSteerAnswer('2'), 'B');
  assert.equal(parseSteerAnswer('3'), 'C');
  assert.equal(parseSteerAnswer('继'), 'A');
  assert.equal(parseSteerAnswer('改'), 'B');
  assert.equal(parseSteerAnswer('停'), 'C');
});

test('W3-5: 解析·垃圾输入一律 null（绝不猜、绝不默认）', () => {
  for (const bad of ['', '  ', 'AB', '继续', '继续吧', 'x', 'yes', '0', '4', 'ＡＢ', null, undefined, 42, { k: 'A' }]) {
    assert.equal(parseSteerAnswer(bad), null, `垃圾应答 ${JSON.stringify(bad)} ⇒ 不解析`);
  }
});

test('W3-5: 应答·垃圾重问——status re-ask + 原题回显 + 单字符提示；待答题不清', () => {
  const s = createSteerSession({ goal: mkGoal(), screenText: () => DRIFTED_SCREEN });
  const q = s.maybeCheckAndAsk(3, null);
  assert.ok(q !== null);
  const r = s.answer('继续吧');
  assert.equal(r.status, 're-ask');
  assert.deepEqual(r.question, q, '原题重显');
  assert.match(r.hint!, /单个字符/);
  assert.ok(s.pending() !== null, '待答题仍在');
  // 之后合法应答照常结算
  assert.equal(s.answer('A').status, 'answered');
});

test('W3-5: 应答·B 写回判据——目标机判据文本替换 + 状态重置 unverified + spec 同步', () => {
  const goal = mkGoal();
  const s = createSteerSession({ goal, screenText: () => DRIFTED_SCREEN });
  const q = s.maybeCheckAndAsk(3, null);
  assert.ok(q !== null);
  const r = s.answer('b'); // 小写容错
  assert.equal(r.status, 'answered');
  assert.equal(r.choice, 'B');
  assert.equal(r.applied, true);
  assert.equal(r.amendment!.to, q.amendment.to, '回显自动生成的修正');
  const cs = goal.progress.criteriaStatus[0]!;
  assert.equal(cs.criterion, q.amendment.to, '判据文本已写回');
  assert.equal(cs.status, 'unverified', '修正即新主张');
  assert.equal(goal.spec.successCriteria[0], q.amendment.to, 'spec 出口同步');
  assert.equal(s.pending(), null, '待答题已清');
  assert.equal(s.answer('B').status, 'no-pending', '再答无题 ⇒ no-pending');
});

test('W3-5: 应答·A 放行——零副作用（判据账不动、无阻塞）', () => {
  const goal = mkGoal();
  const s = createSteerSession({ goal, screenText: () => DRIFTED_SCREEN });
  assert.ok(s.maybeCheckAndAsk(3, null) !== null);
  const r = s.answer('A');
  assert.equal(r.status, 'answered');
  assert.equal(r.choice, 'A');
  assert.equal(goal.progress.criteriaStatus[0]!.status, 'unverified', '判据不动');
  assert.equal(goal.progress.blockers.length, 0, '无阻塞');
  assert.equal(goal.evaluate().phase, 'acting', '相位不动');
});

test('W3-5: 应答·C 终止——经目标机现有 API 记阻塞 ⇒ blocked 终局相', () => {
  const goal = mkGoal();
  const s = createSteerSession({ goal, screenText: () => DRIFTED_SCREEN });
  assert.ok(s.maybeCheckAndAsk(3, null) !== null);
  const r = s.answer('C');
  assert.equal(r.status, 'answered');
  assert.equal(r.choice, 'C');
  assert.equal(goal.progress.blockers.length, 1, '记一条终止阻塞');
  assert.match(goal.progress.blockers[0]!, /终止/);
  assert.equal(goal.evaluate().phase, 'blocked', 'blocked 是自主环的终局相 —— 收场语义');
});

test('W3-5: 应答·无题时应答 ⇒ no-pending（绝不误结算）', () => {
  const s = createSteerSession({ goal: mkGoal(), screenText: () => DRIFTED_SCREEN });
  assert.equal(s.answer('A').status, 'no-pending');
  assert.equal(s.answer('garbage').status, 'no-pending');
});

// ─── 工具工厂（execute 面的 JSON 载荷契约） ───

test('W3-5: 工具·steer_choice——超阈返回 steer_choice 载荷；未超阈/指纹缺席 ⇒ NO_PENDING_STEER', async () => {
  const drifting = createSteerSession({ goal: mkGoal(), screenText: () => DRIFTED_SCREEN });
  const tool = createSteerChoiceTool(drifting);
  const raw = await exec(tool)({ step_index: 3 });
  const parsed = JSON.parse(raw);
  assert.equal(parsed.kind, 'steer_choice');
  assert.deepEqual(parsed.options.map((o: { key: string }) => o.key), ['A', 'B', 'C']);
  assert.equal(parsed.answer_format, 'single-char');

  const aligned = createSteerChoiceTool(
    createSteerSession({ goal: mkGoal(), screenText: () => ALIGNED_SCREEN }));
  assert.equal(JSON.parse(await exec(aligned)({ step_index: 3 })).status, 'NO_PENDING_STEER');
  const absent = createSteerChoiceTool(createSteerSession({ goal: mkGoal() }));
  assert.equal(JSON.parse(await exec(absent)({ step_index: 3 })).status, 'NO_PENDING_STEER');
  // 参数缺席防御：step_index/entropy 均缺 ⇒ 无周期无熵 ⇒ 不检查
  // （类型脏值由工具框架的参数校验先拦——ToolArgsError，不入 execute）
  assert.equal(JSON.parse(await exec(absent)({})).status, 'NO_PENDING_STEER');
});

test('W3-5: 工具·steer_answer——垃圾应答 re-ask、B 应答写回 applied=true', async () => {
  const goal = mkGoal();
  const s = createSteerSession({ goal, screenText: () => DRIFTED_SCREEN });
  const askTool = createSteerChoiceTool(s);
  const ansTool = createSteerAnswerTool(s);
  const q = JSON.parse(await exec(askTool)({ step_index: 3 }));
  assert.equal(q.kind, 'steer_choice');
  const bad = JSON.parse(await exec(ansTool)({ answer: '继续吧' }));
  assert.equal(bad.status, 're-ask');
  assert.equal(bad.question.kind, 'steer_choice');
  const ok = JSON.parse(await exec(ansTool)({ answer: 'B' }));
  assert.equal(ok.status, 'answered');
  assert.equal(ok.choice, 'B');
  assert.equal(ok.applied, true);
  assert.equal(goal.progress.criteriaStatus[0]!.criterion, ok.amendment.to);
});

// ─── buildSteerChoice 纯函数边界 ───

test('W3-5: 出题·纯函数——无未核判据 ⇒ null；判据账防串（垃圾数组按空处理）', () => {
  const base = {
    drift: 0.9,
    trend: 'rising' as const,
    evidence: { semantic_distance: 0.9, stagnation_steps: 5, stagnation_ratio: 0.4 },
    stepIndex: 9,
  };
  assert.equal(buildSteerChoice({ ...base, criteriaStatus: [] }), null);
  assert.equal(buildSteerChoice({
    ...base,
    criteriaStatus: [
      { criterion: 'a', status: 'met' },
      { criterion: 'b', status: 'violated' },
    ],
  }), null, 'met+violated 无未核 ⇒ 无可问');
  const q = buildSteerChoice({
    ...base,
    criteriaStatus: [{ criterion: 'a', status: 'met' }, { criterion: 'b', status: 'unverified' }],
  });
  assert.ok(q !== null);
  assert.equal(q.amendment.criterion_index, 1);
  assert.ok(q.reason.includes('0.9'), '出题理由携带评分');
});
