// test/w8.criteria.test.ts
// W8-B4（任务一：判据证伪能力）执法测试 —— 两层：
//   A. criteriaEval 纯函数层：肯定/否定/容错边界/OCR 缺席诚实降级 四类用例
//      （否定判据 DSL：'mustNotAppear:' / '不得出现：' 前缀；fuzzy 容错沿用
//      fuzzy.ts ⌈m/6⌉ 立法 + <3 字符短模式只走精确匹配的 actionGate 同律护栏；
//      OCR 语料缺席 ⇒ degraded + 零证据 —— 否定判据绝不自动为真）；
//   B. autoPilot ⑧′ 环内接线层（极性分工：环内只执法否定面，肯定面 met 归 execute
//      通道 —— 行为零变化红线）：否定判据命中 ⇒ failed 终局（证伪面本体）、
//      否定判据缺席且肯定判据命中（execute 证据）⇒ achieved、OCR 缺席 ⇒ 判据保持
//      unverified 靠步数保险丝收（aborted）、肯定判据 fuzzy 近邻命中不在环内点火
//      （「关门/开门」距离 1 类近邻不翻转既有终局语义 —— 器官层能力在册）。
// 全离线确定性：假感知（固定 textDigest）/ 假策略 / 假执行 / 注入时钟零真睡。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCriterion, evaluateCriteria, buildCriteriaPairs,
} from '../src/autonomy/criteriaEval.ts';
import {
  runAutonomousLoop, GoalStateMachine,
  type AutonomyDeps, type PolicyAction, type WorldSnapshot,
} from '../src/autonomy/index.ts';

// ─── A1. DSL 解析：否定前缀形态（大小写/空白折叠 + 中英双语 + 全/半角冒号） ───

test('W8-判据①a: parseCriterion —— 否定前缀识别（中英 × 冒号 × 折叠）', () => {
  assert.deepEqual(parseCriterion('mustNotAppear:错误提示'), { polarity: 'must-not-appear', needle: '错误提示' });
  assert.deepEqual(parseCriterion('  MUSTNOTAPPEAR:  Error Banner  '), { polarity: 'must-not-appear', needle: 'error banner' });
  assert.deepEqual(parseCriterion('Must Not Appear: Error'), { polarity: 'must-not-appear', needle: 'error' });
  assert.deepEqual(parseCriterion('mustnotappear：错误'), { polarity: 'must-not-appear', needle: '错误' }, '全角冒号同律');
  assert.deepEqual(parseCriterion('不得出现：删除成功'), { polarity: 'must-not-appear', needle: '删除成功' });
  assert.deepEqual(parseCriterion('不得出现:删除成功'), { polarity: 'must-not-appear', needle: '删除成功' }, '半角冒号同律');
  // 无冒号的自然语句不是 DSL —— 恒为肯定字面判据（防误伤）
  assert.deepEqual(parseCriterion('屏幕不得出现错误'), { polarity: 'must-appear', needle: '屏幕不得出现错误' });
  assert.deepEqual(parseCriterion('Payment Success'), { polarity: 'must-appear', needle: 'payment success' });
  // 非法输入：非字符串/空白 ⇒ 空 needle（评估整条跳过）
  assert.deepEqual(parseCriterion(undefined), { polarity: 'must-appear', needle: '' });
  assert.deepEqual(parseCriterion('   '), { polarity: 'must-appear', needle: '' });
  // 前缀后无内容 ⇒ 非法否定判据（空 needle）
  assert.deepEqual(parseCriterion('mustNotAppear:'), { polarity: 'must-not-appear', needle: '' });
});

// ─── A2. 肯定判据：命中 ⇒ met；未命中 ⇒ 零证据（不证伪） ───

test('W8-判据①b: 肯定判据 —— 精确命中（折叠）⇒ met；未命中 ⇒ 零证据', () => {
  const hit = evaluateCriteria([{ text: 'Payment  SUCCESS', index: 0 }], 'banner: payment success (done)');
  assert.deepEqual(hit.evidence, [{ index: 0, status: 'met', polarity: 'must-appear' }], '大小写+空白折叠后命中');
  assert.equal(hit.degraded, false);
  const miss = evaluateCriteria([{ text: '订单已提交', index: 3 }], '购物车 结算 优惠券');
  assert.deepEqual(miss.evidence, [], '未命中不产 violated —— 「没找到」不是「被证伪」（宁缺毋错）');
});

// ─── A3. 否定判据：命中禁词 ⇒ violated；语料在场未命中 ⇒ met ───

test('W8-判据②: 否定判据 —— 命中 ⇒ violated（证伪面）；在场未命中 ⇒ met', () => {
  const hit = evaluateCriteria([{ text: 'mustNotAppear:错误提示', index: 1 }], '操作完成 错误提示 重新加载');
  assert.deepEqual(hit.evidence, [{ index: 1, status: 'violated', polarity: 'must-not-appear' }], 'OCR 命中否定词 ⇒ 判据为假');
  const clean = evaluateCriteria([{ text: '不得出现：删除成功', index: 1 }], '操作完成 文件保留 重新加载');
  assert.deepEqual(clean.evidence, [{ index: 1, status: 'met', polarity: 'must-not-appear' }], '语料在场且无禁词 ⇒ 本次观察支持判据为真');
  // 混合判据账：肯定未命中（零证据）+ 否定命中（violated）并存
  const mixed = evaluateCriteria(
    [{ text: '订单已提交', index: 0 }, { text: 'mustNotAppear:error', index: 1 }],
    'system error occurred',
  );
  assert.deepEqual(mixed.evidence, [{ index: 1, status: 'violated', polarity: 'must-not-appear' }]);
});

// ─── A4. fuzzy 容错边界：⌈m/6⌉ 立法 + 短模式护栏 ───

test('W8-判据③a: fuzzy 容错 —— 距离在 ⌈m/6⌉ 内命中、越界不命中（沿用 fuzzy.ts 立法）', () => {
  // 'payment success' 15 字符 ⇒ 容差 ⌈15/6⌉ = 3
  const near = evaluateCriteria([{ text: 'Payment Success', index: 0 }], 'payrnnt success banner');
  assert.deepEqual(near.evidence, [{ index: 0, status: 'met', polarity: 'must-appear' }], 'OCR 噪声距离 2 ≤ 3 ⇒ 容错命中（补精确匹配之漏）');
  const far = evaluateCriteria([{ text: 'Payment Success', index: 0 }], 'payxxxx success banner');
  assert.deepEqual(far.evidence, [], '距离 4 > 3 ⇒ 不命中（容差即边界，不放水）');
  // 否定判据同律吃容错：禁词带 OCR 噪声也算命中（证伪面宁可敏感）
  const negNear = evaluateCriteria([{ text: 'mustNotAppear:删除成功', index: 0 }], '操作完成 删陟成功 重新加载');
  assert.deepEqual(negNear.evidence, [{ index: 0, status: 'violated', polarity: 'must-not-appear' }], '禁词距离 1 ≤ ⌈4/6⌉=1 ⇒ violated');
});

test('W8-判据③b: 短模式护栏 —— <3 字符只走精确匹配（actionGate wholeHit 同律）', () => {
  // 'ab' 对 '0k' 的编辑距离 1 ≤ ⌈2/6⌉=1 —— fuzzy 会误命中，护栏必须拦下
  const pos = evaluateCriteria([{ text: 'ab', index: 0 }], '0k');
  assert.deepEqual(pos.evidence, [], '短模式不走 fuzzy：肯定判据零证据');
  const neg = evaluateCriteria([{ text: 'mustNotAppear:ab', index: 0 }], '0k');
  assert.deepEqual(neg.evidence, [{ index: 0, status: 'met', polarity: 'must-not-appear' }], '短模式不走 fuzzy：否定判据不因近似而 violated');
  // 精确通道不受护栏影响：恰好出现 ⇒ 正常命中
  const exact = evaluateCriteria([{ text: 'ab', index: 0 }], 'xx ab yy');
  assert.deepEqual(exact.evidence, [{ index: 0, status: 'met', polarity: 'must-appear' }]);
});

// ─── A5. OCR 缺席诚实降级：否定判据不得自动为真（三态判决纪律） ───

test('W8-判据④: OCR 缺席/不可读 ⇒ degraded + 零证据 —— 否定判据绝不自动为真', () => {
  for (const corpus of [null, undefined, '', '   \t\n  ']) {
    const out = evaluateCriteria(
      [{ text: 'mustNotAppear:错误', index: 0 }, { text: '任务完成', index: 1 }],
      corpus as string | null | undefined,
    );
    assert.deepEqual(out.evidence, [], `语料 ${JSON.stringify(corpus)} ⇒ 零证据`);
    assert.equal(out.degraded, true, '诚实申报降级');
    assert.ok(out.notes.length >= 1 && out.notes[0]!.includes('缺席'), '注记如实在案');
  }
});

// ─── A6. 防御式：垃圾输入绝不抛 ───

test('W8-判据⑤: 防御式 —— 非法判据对/垃圾下标整条跳过，绝不抛', () => {
  const out = evaluateCriteria(
    [
      null, { text: 123, index: 1 }, { text: '  ', index: 2 }, { text: 'ok', index: -1 },
      { text: 'ok', index: 1.5 }, { text: 'mustNotAppear:', index: 3 }, { text: 'ok done', index: 4 },
    ] as Array<{ text: unknown; index: number }>,
    'all ok done here',
  );
  assert.deepEqual(out.evidence, [{ index: 4, status: 'met', polarity: 'must-appear' }], '唯一合法条目按原下标产出');
  assert.equal(out.degraded, false);
  assert.deepEqual(buildCriteriaPairs('garbage'), [], '非数组判据账 ⇒ 空账');
  assert.deepEqual(
    buildCriteriaPairs(['ok', 42, '  ', 'done']),
    [{ text: 'ok', index: 0 }, { text: 'done', index: 3 }],
    '非法剔除但下标不平移（锚定 spec 原位）',
  );
});

// ─── B. autoPilot ⑧′ 环内接线（全离线轻量环） ───

/** 固定 OCR 语料的世界快照（textDigest 即 ⑧′ 的语料源） */
function snapshotOf(textDigest: string): WorldSnapshot {
  return {
    takenAt: 1, width: 1920, height: 1080, dhash: 'ff00ff00ff00ff00',
    elements: [], textDigest, popups: [], focusedRegion: null, sceneLabel: '', degraded: [],
  };
}

/** 观察性动作（declare —— 不改世界但走完整 ②→⑦→⑧ 链，⑧′ 随行） */
const OBSERVE_ACTION: PolicyAction = {
  kind: 'declare',
  rationale: '测试桩：观察一拍',
  expectedEffect: '不改变世界',
  utility: 0.5,
  riskTier: 'benign',
};

/** 轻量环依赖：感知恒返固定语料屏 / 策略恒 declare / 执行 progress（零判据证据） */
function loopDeps(goal: GoalStateMachine, textDigest: string): AutonomyDeps {
  return {
    perceive: async () => snapshotOf(textDigest),
    policy: { decide: async () => ({ action: OBSERVE_ACTION, uncertain: false, degraded: false }) },
    execute: async () => ({ outcome: 'progress' as const }),
    goal,
    now: () => 1_700_000_000_000,
    sleep: async () => {},
  };
}

test('W8-环①: 否定判据命中 ⇒ failed 终局（证伪面进闭环 —— 第一个执行步即熔断）', async () => {
  const goal = new GoalStateMachine({
    goal: '清理临时文件',
    successCriteria: ['mustNotAppear:删除失败'],
    maxSteps: 4,
  });
  const r = await runAutonomousLoop(loopDeps(goal, '清理完成 删除失败 重试'), { maxSteps: 4 });
  assert.equal(r.phase, 'failed', 'OCR 命中否定词 ⇒ goalState 判定律第 1 条 failed');
  assert.equal(r.steps, 1, '第一个执行步 ⑧′ 回填 violated ⇒ ⑨ 即熔断');
  assert.equal(goal.progress.criteriaStatus[0]!.status, 'violated');
});

test('W8-环②: 否定判据缺席 + 肯定判据命中（execute 通道）⇒ achieved（两通道合流）', async () => {
  const goal = new GoalStateMachine({
    goal: '提交订单',
    successCriteria: ['订单已提交', 'mustNotAppear:错误提示'],
    maxSteps: 4,
  });
  // 极性分工：肯定面 met 归 execute 侧判据证据（runtime 既定管辖）；否定面归 ⑧′
  const deps = loopDeps(goal, '订单已提交 感谢您的购买');
  deps.execute = async () => ({
    outcome: 'progress' as const,
    criteriaEvidence: [{ index: 0, status: 'met' as const }],
  });
  const r = await runAutonomousLoop(deps, { maxSteps: 4 });
  assert.equal(r.phase, 'achieved', '肯定命中（execute 通道）+ 否定在场未命中（⑧′ met）⇒ 全 met');
  assert.equal(r.steps, 1);
  const cs = goal.progress.criteriaStatus;
  assert.equal(cs[0]!.status, 'met');
  assert.equal(cs[1]!.status, 'met');
});

test('W8-环③: OCR 缺席（textDigest 空）⇒ 否定判据保持 unverified，靠步数保险丝收', async () => {
  const goal = new GoalStateMachine({
    goal: '清理临时文件',
    successCriteria: ['mustNotAppear:删除失败'],
    maxSteps: 2,
  });
  const r = await runAutonomousLoop(loopDeps(goal, ''), { maxSteps: 2 });
  assert.equal(r.phase, 'aborted', '看不见 ⇒ 不判（否定判据不自动为真）⇒ 保险丝收场');
  assert.equal(r.steps, 2);
  assert.equal(goal.progress.criteriaStatus[0]!.status, 'unverified', '诚实：从未被证真也从未被证伪');
});

test('W8-环④: 肯定判据的 fuzzy 近邻命中不在环内点火 —— 既有终局语义零回归', async () => {
  // 「关门标记」对「开门标记」编辑距离 1 ≤ ⌈4/6⌉=1 —— 器官层 fuzzy 会命中，但
  // 环内 ⑧′ 只执法否定面（肯定面 met 归 execute 通道），短判据的近邻误命中绝不
  // 翻转既有终局语义（w5steer 全链换支场景的行为契约）。
  const goal = new GoalStateMachine({
    goal: '开关门流程演示',
    successCriteria: ['开门标记', '关门标记'],
    maxSteps: 2,
  });
  const r = await runAutonomousLoop(loopDeps(goal, '开门标记 任务界面'), { maxSteps: 2 });
  assert.equal(r.phase, 'aborted', '肯定判据缺一 ⇒ 照旧步保险丝中止（零回归）');
  assert.equal(goal.progress.criteriaStatus[1]!.status, 'unverified');
  // 器官层对照：同一输入下 fuzzy 肯定面确实命中（能力在册，环内不消费 —— 分工纪律）
  const organ = evaluateCriteria([{ text: '关门标记', index: 1 }], '开门标记 任务界面');
  assert.deepEqual(organ.evidence, [{ index: 1, status: 'met', polarity: 'must-appear' }]);
});

test('W8-环⑤: 既有语义零回归 —— 无否定判据且未命中 ⇒ 照旧跑到保险丝（aborted）', async () => {
  const goal = new GoalStateMachine({
    goal: '打开记事本',
    successCriteria: ['会议纪要已输入'],
    maxSteps: 2,
  });
  const r = await runAutonomousLoop(
    loopDeps(goal, 'quarterly fruit basket invoice redux newsletter'),
    { maxSteps: 2 },
  );
  assert.equal(r.phase, 'aborted', '判据从未命中 ⇒ 旧语义不变（步数保险丝）');
  assert.equal(goal.progress.criteriaStatus[0]!.status, 'unverified');
});
