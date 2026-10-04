// test/w9criteria.test.ts
// W9-1（DEBTS D-G9 清偿 · 判据证伪·极性分工红线）执法册 —— runtime 主路径
// checkCriteria 整体换用 criteriaEval.evaluateCriteria 的一次性收口取证：
//   ① 肯定面 fuzzy 命中（runtime 通道）：OCR 距 ≤ ⌈m/6⌉ 的判据词也判 met ——
//      这是 D-G9 立法意图（精确子串命中是 fuzzy 命中的真子集，既有精确用例零回归）；
//   ② 短模式精确护栏（runtime 通道）：<3 字符只走精确匹配（actionGate wholeHit
//      同律）—— 严格例不因 fuzzy 收口而弱化；
//   ③ 否定面精确语义经 execute 通道不变：mustNotAppear:/不得出现： 命中禁词 ⇒
//      violated、在场未命中 ⇒ met、语料缺席 ⇒ 零证据（诚实降级，不自动为真）；
//      violated 经 autoPilot ⑧ 回填 goalState ⇒ failed 终局（证伪面进闭环）；
//   ④ 无方言并存（源级断言）：runtime.ts 不再自持折叠子串匹配实现（foldText
//      退役、无 needle includes），判据核对只经 evaluateCriteria 单一器官；
//   ⑤ 极性分工红线（源级断言）：autoPilot ⑧′ 只消费否定面（肯定面归 execute
//      通道的注释与 polarity 过滤实现逐字一致）—— runtime 为唯一权威器官，
//      环内复核是旁路保险，不是第二方言。
// 全离线确定性：declare 步走感知快照 textDigest（零截屏零键鼠）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createExecute } from '../src/autonomy/runtime.ts';
import { GoalStateMachine, type GoalSpec } from '../src/autonomy/goalState.ts';
import type { RuntimeDeps } from '../src/autonomy/runtime.deps.ts';
import type { PolicyAction } from '../src/autonomy/policyEngine.ts';
import type { WorldSnapshot } from '../src/autonomy/worldSnapshot.ts';

// ─── 假件工坊：全注入零真 IO（declare 步不触截屏/键鼠，桩只为闭包完备） ───

/** 固定 textDigest 的感知快照（declare 判据核对的语料源） */
function snapshotOf(textDigest: string): WorldSnapshot {
  return {
    takenAt: 1, width: 512, height: 384, dhash: 'aaaaaaaaaaaaaaaa',
    elements: [], textDigest, popups: [], focusedRegion: null, sceneLabel: '', degraded: [],
  };
}

/** 观察性 declare 动作（不改世界，但走 runtime 判据核对通道） */
const DECLARE: PolicyAction = {
  kind: 'declare', rationale: 'W9-1 判据核对取证', expectedEffect: '判据置位',
  utility: 0.5, riskTier: 'benign',
};

/** 铸造真 execute（declare 通道直证 checkCriteria 新口径） */
function makeExecute(
  successCriteria: string[],
  textDigest: string,
): (action: PolicyAction) => Promise<import('../src/autonomy/runtime.ts').ExecOutcome> {
  const spec: GoalSpec = { goal: 'W9-1 判据收口取证', successCriteria, maxSteps: 4 };
  const deps: RuntimeDeps & { spec: GoalSpec; width: number; height: number } = {
    capture: async () => Buffer.from([1]),
    imageSize: async () => ({ width: 512, height: 384 }),
    dhashOf: async () => 'aaaaaaaaaaaaaaaa',
    readWords: async () => [],
    now: () => 1_000,
    sleep: async () => { /* 零真睡 */ },
    lastSnapshotRef: { current: snapshotOf(textDigest) },
    spec,
    width: 512,
    height: 384,
  };
  return createExecute(deps);
}

/** 源码读取（④⑤ 源级断言的取证面） */
const testDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeSrc = readFileSync(path.join(testDir, '..', 'src', 'autonomy', 'runtime.ts'), 'utf8');
const autoPilotSrc = readFileSync(path.join(testDir, '..', 'src', 'autonomy', 'autoPilot.ts'), 'utf8');

// ─── ① 肯定面 fuzzy 命中（runtime 通道 · D-G9 立法意图的行为变更面） ───

test('W9-1①a: 肯定判据 OCR 距 1 ≤ ⌈m/6⌉ ⇒ runtime 通道判 met（fuzzy 收口立法意图）', async () => {
  // '支付成功清单' 6 字符 ⇒ 容差 ⌈6/6⌉=1；'支付成巧清单' 距 1 —— 旧子串方言必漏判
  const out = await makeExecute(['支付成功清单'], '支付成巧清单 待办事项')(DECLARE);
  assert.deepEqual(
    out.criteriaEvidence,
    [{ index: 0, status: 'met' }],
    'OCR 距 1 的判据词也判 met —— D-G9：fuzzy 肯定面收口（旧折叠子串匹配必不命中）',
  );
  assert.notEqual(out.note, 'declare：感知文本未命中判据字面（宁缺毋错，不置位）');
});

test('W9-1①b: 既有精确子串命中仍命中（fuzzy 是超集 —— 零回归对照）', async () => {
  const out = await makeExecute(['支付成功清单', '任务完结'], '首页banner 支付成功清单 已刷新')(DECLARE);
  assert.deepEqual(
    out.criteriaEvidence,
    [{ index: 0, status: 'met' }],
    '精确命中照旧 met；未命中判据（任务完结）零证据 —— 宁缺毋错不证伪',
  );
});

test('W9-1①c: 距离越界不命中（容差即边界，不放水）', async () => {
  // '支付成功清单' 6 字符容差 1；最优窗口「支付成巧清酷」距 2（功→巧 + 单→酷）> 1 ⇒ 不命中
  const out = await makeExecute(['支付成功清单'], '支付成巧清酷啦 待办')(DECLARE);
  assert.equal(out.criteriaEvidence, undefined, '距离 2 > ⌈6/6⌉=1 ⇒ 零证据');
});

// ─── ② 短模式精确护栏（<3 字符只走精确 —— 严格例保留） ───

test('W9-1②: 短模式（<3 字符）只走精确匹配 —— 护栏在 runtime 通道同律生效', async () => {
  // 'ab' 对 '0k' 编辑距离 1 ≤ ⌈2/6⌉=1 —— fuzzy 会误命中，护栏必须拦下（肯定面严格例）
  const guard = await makeExecute(['ab'], '0k')(DECLARE);
  assert.equal(guard.criteriaEvidence, undefined, '短模式不走 fuzzy：肯定判据零证据（严格例不弱化）');
  // 精确通道不受护栏影响：恰好出现 ⇒ 正常命中
  const exact = await makeExecute(['ab'], 'xx ab yy')(DECLARE);
  assert.deepEqual(exact.criteriaEvidence, [{ index: 0, status: 'met' }], '短模式精确出现 ⇒ met');
});

// ─── ③ 否定面经 execute 通道：精确语义不变 + violated 进闭环 ⇒ failed ───

test('W9-1③a: 否定判据命中禁词 ⇒ runtime 通道产出 violated（中英前缀同律）', async () => {
  const en = await makeExecute(['mustNotAppear:删除失败'], '清理完成 删除失败 重试')(DECLARE);
  assert.deepEqual(en.criteriaEvidence, [{ index: 0, status: 'violated' }], '英文前缀：命中禁词 ⇒ violated');
  const zh = await makeExecute(['不得出现：错误弹窗'], '结算页 错误弹窗 已弹出')(DECLARE);
  assert.deepEqual(zh.criteriaEvidence, [{ index: 0, status: 'violated' }], '中文前缀：同律证伪');
});

test('W9-1③b: 否定判据在场未命中 ⇒ met；语料缺席 ⇒ 零证据（不自动为真）', async () => {
  const clean = await makeExecute(['mustNotAppear:删除失败'], '清理完成 文件保留')(DECLARE);
  assert.deepEqual(clean.criteriaEvidence, [{ index: 0, status: 'met' }], '语料在场且无禁词 ⇒ met');
  // 感知快照缺席（lastSnapshotRef null 面由 declare 的 ?? '' 收敛为空语料）
  const spec: GoalSpec = { goal: 'g', successCriteria: ['mustNotAppear:删除失败'], maxSteps: 4 };
  const deps: RuntimeDeps & { spec: GoalSpec; width: number; height: number } = {
    capture: async () => Buffer.from([1]),
    imageSize: async () => ({ width: 512, height: 384 }),
    dhashOf: async () => 'aaaaaaaaaaaaaaaa',
    readWords: async () => [],
    now: () => 1_000,
    sleep: async () => {},
    lastSnapshotRef: { current: snapshotOf('   ') },
    spec,
    width: 512,
    height: 384,
  };
  const out = await createExecute(deps)(DECLARE);
  assert.equal(out.criteriaEvidence, undefined, '语料空白 ⇒ 诚实降级零证据（否定判据绝不自动为真）');
  assert.match(out.note ?? '', /宁缺毋错/, 'declare 注记如实申报未命中');
});

test('W9-1③c: runtime 通道的 violated 经 ⑧ 回填 goalState ⇒ failed（证伪面进闭环）', async () => {
  const goal = new GoalStateMachine({
    goal: '安全清理', successCriteria: ['清理完成', 'mustNotAppear:误删系统文件'], maxSteps: 4,
  }, () => 1_000);
  goal.begin();
  const out = await makeExecute(['清理完成', 'mustNotAppear:误删系统文件'], '清理完成 误删系统文件 已发生')(DECLARE);
  assert.equal(out.criteriaEvidence?.length, 2, '肯定 met + 否定 violated 并存');
  for (const e of out.criteriaEvidence ?? []) goal.recordCriterion(e.index, e.status);
  assert.equal(goal.evaluate().phase, 'failed', '任一 violated ⇒ failed（goalState 判定律第 1 条）');
});

// ─── ④ 无方言并存（源级断言：runtime 不再自持子串匹配实现） ───

test('W9-1④a: runtime.ts 源级 —— 折叠子串匹配方言退役，判据核对只经 evaluateCriteria', () => {
  // 旧方言三件套全数缺席：foldText 折叠、includes(needle) 子串、自持 evidence 铸造
  assert.doesNotMatch(runtimeSrc, /foldText/, '旧方言的折叠前置律已随整体换用退役（foldText 不再进 runtime）');
  assert.doesNotMatch(runtimeSrc, /\.includes\(needle\)/, 'needle 子串匹配实现必须绝迹');
  assert.doesNotMatch(runtimeSrc, /folded\.includes\(/, '折叠语料子串匹配必须绝迹');
  // 新口径单一器官：判据核对 = evaluateCriteria 调用（非注释行）
  const calls = runtimeSrc.split('\n').filter(l =>
    !l.trim().startsWith('//') && !l.trim().startsWith('*') && /evaluateCriteria\(/.test(l));
  assert.ok(calls.length >= 1, `runtime 判据核对必须经 evaluateCriteria（实际命中 ${calls.length} 行）`);
  assert.match(runtimeSrc, /import \{ evaluateCriteria, buildCriteriaPairs \} from '\.\/criteriaEval'/,
    '器官导入面在册（解析/肯定面/否定面全走单一器官）');
});

test('W9-1④b: runtime.ts 源级 —— 判据对铸造同走器官（buildCriteriaPairs，下标不平移）', () => {
  assert.match(runtimeSrc, /buildCriteriaPairs\(spec\.successCriteria\)/,
    '判据对铸造不得内联自持（防第二套下标方言）');
});

// ─── ⑤ 极性分工红线（源级断言：autoPilot 否定面注释与实现一致） ───

test('W9-1⑤: autoPilot ⑧′ 只消费否定面 —— 注释与 polarity 过滤实现逐字一致', () => {
  // 实现面：肯定面证据在环内被过滤（polarity !== 'must-not-appear' ⇒ continue）
  assert.match(autoPilotSrc, /if \(evidence\.polarity !== 'must-not-appear'\) continue;/,
    '⑧′ 的 polarity 过滤实现必须在册');
  // 注释面：红线注释（肯定面归 execute 通道）与实现同在 —— 注释不撒谎
  assert.match(autoPilotSrc, /肯定面归 execute 通道/, '红线注释在册');
  assert.match(autoPilotSrc, /evaluateCriteria\(w8CriteriaPairs, w8Corpus\)/, '环内复核同走单一器官（无第二方言）');
  // runtime 是唯一权威器官：环内复核用同一 evaluateCriteria，而非自有匹配
  assert.doesNotMatch(autoPilotSrc, /\.includes\(parsed\.needle\)|\.includes\(w8Needle\)/,
    'autoPilot 不得自持判据匹配实现');
});
