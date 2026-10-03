// test/epochIota.selfmodel.test.ts
// 纪元 Ι（自我模型）执法册 —— 经验胜任度后验 + 认识论闸门经验置信换源。
// 全离线确定性：零网络、零真钟（全部注入时钟）、零真睡；一切期望值手算硬编码。
// 执法编号：
//   Ι-1 后验数学：同 cell 8 成 2 败 ⇒ Beta(9,3) mean=0.75、CI 正态近似夹 [0,1]；
//       minEvidence=8 ⇒ n=7 时 adviseConfidence=null（冷启动诚实，绝不 0.5 假数据）
//   Ι-2 衰减（懒结算）：8 成 2 败后推进 3 个半衰期 ⇒ 旧证据权重 2⁻³=1/8；
//       再记 1 败全重入场 ⇒ mean 显著拉低；衰减后 n<minEvidence ⇒ 建议诚实退场
//   Ι-3 场景桶分格：同 actionKind 不同 sceneBucket ⇒ 独立格子；dhash 64 位位串
//       量化 16bit 桶（4×4 块均值阈值位图）；指纹缺席/不可量化 ⇒ 诚实降级
//       actionKind 单轴（同一格，绝不伪造场景）
//   Ι-4 闸门接线：destructive 动作 + selfModel 给出低经验置信 ⇒ 闸门用经验置信
//       触发 ask_human（escalateReason='epistemic-gate'，红律按经验置信执法）；
//       selfModel 缺席 vs 返回 null ⇒ 两跑逐字段一致（纪元 Η 零回归红律）
//   Ι-5 永不抛 + 自省面：坏 cell/坏时间戳/坏建议全吸收；topCells/bottomCells
//       确定序；dump/restore 往返；禁用面全 null；get_metrics 新字段在场且
//       旧字段零变化；buildAutonomyStack 三键灌注与开关缺席
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SelfModel,
  selfModel,
  sceneBucketFromFingerprint,
} from '../src/selfmodel/index.ts';
import {
  runAutonomousLoop,
  type AutonomyDeps,
  type StepRecord,
  type SelfModelPort,
} from '../src/autonomy/autoPilot.ts';
import { GoalStateMachine, type GoalSpec } from '../src/autonomy/goalState.ts';
import type { PolicyDecision } from '../src/autonomy/policyEngine.ts';
import { buildAutonomyStack } from '../src/autonomy/index.ts';
import { createGetMetricsTool } from '../src/tools/observabilityTools.ts';
import type { Config } from '../src/config.ts';
import type { WorldSnapshot } from '../src/autonomy/worldSnapshot.ts';

// ─── 假件工坊（全部字面量，零真感知/零网络） ───

type Act = StepRecord['action'];

/** 单决定策略桩（每次 decide 都返回同一决定） */
function monoPolicy(decision: PolicyDecision): AutonomyDeps['policy'] {
  return { decide: async () => decision };
}

/** 破坏性点击动作字面量（utility 即自报置信 —— 纪元 Η 口径的载体） */
function destructiveClick(label: string, utility: number): Act {
  return {
    kind: 'click',
    target: { bbox: { x0: 10, y0: 20, x1: 60, y1: 50 }, center: { x: 35, y: 35 }, label },
    rationale: `点击「${label}」（破坏性动作）`,
    expectedEffect: '目标被不可逆地清除',
    utility,
    riskTier: 'destructive',
  };
}

/** 固定世界快照（dhash = 全 1 的 64 位位串 —— 量化桶恒 'ffff'） */
const SNAP: WorldSnapshot = {
  takenAt: 1_000, width: 1920, height: 1080, dhash: '1'.repeat(64),
  elements: [], textDigest: '', popups: [], focusedRegion: null,
  sceneLabel: '', degraded: [],
};

/** 全量默认 autonomy 配置（纪元 Ι 键齐备，可局部覆盖） */
function makeConfig(over: Partial<Config> = {}): Config {
  return {
    autonomyEnabled: true,
    autonomyMaxSteps: 24,
    autonomyTimeBudgetSec: 300,
    autonomyAllowTiers: 'benign',
    autonomyVlmWhenUncertain: true,
    autonomyForbiddenKeywords: '',
    enableEpistemicGate: true,
    enableSelfModel: true,
    ...over,
  } as Config;
}

// ─── Ι-1 后验数学 ───

test('Ι-1: 同 cell 8 成 2 败 ⇒ Beta(9,3) mean=0.75、CI 夹 [0,1]；n=7 < minEvidence=8 ⇒ 建议诚实退场', () => {
  const clock = 1_000; // 注入时钟恒定 ⇒ 零衰减（纯后验数学）
  const sm = new SelfModel();
  sm.configure({ minEvidence: 8, halfLifeH: 168, now: () => clock });
  const cell = { actionKind: 'click_mouse' };
  for (let i = 0; i < 8; i++) sm.recordOutcome(cell, true, clock);
  for (let i = 0; i < 2; i++) sm.recordOutcome(cell, false, clock);

  const c = sm.competence(cell);
  assert.ok(c, '8+2 条战绩 ⇒ 读数在场');
  assert.equal(c.n, 10, '有效证据量 = 10（零衰减）');
  // Beta(α=9, β=3)：mean = 9/12 = 0.75（(s+1)/(n+2)，spec 公式手算值）
  assert.ok(Math.abs(c.mean - 0.75) < 1e-9, `mean=${c.mean}`);
  // 95% CI 正态近似：sd = sqrt(9·3/(12²·13)) ≈ 0.1201 ⇒ [0.5146, 0.9854]，夹 [0,1] 不跨界
  assert.ok(c.ciLow > 0.51 && c.ciLow < c.mean, `ciLow=${c.ciLow}`);
  assert.ok(c.ciHigh < 0.99 && c.ciHigh > c.mean, `ciHigh=${c.ciHigh}`);
  assert.ok(c.ciLow >= 0 && c.ciHigh <= 1, 'CI 恒夹 [0,1]');
  assert.ok(0.8 > c.ciLow && 0.8 < c.ciHigh, '原始频率 8/10 落在可信区间内');
  assert.equal(c.empirical, true, '读数来源 = 经验后验');

  // 冷启动诚实：n=7 < minEvidence=8 ⇒ adviseConfidence null（绝不伪造 0.5）
  const sm7 = new SelfModel();
  sm7.configure({ minEvidence: 8, halfLifeH: 168, now: () => clock });
  for (let i = 0; i < 7; i++) sm7.recordOutcome({ actionKind: 'click_mouse' }, true, clock);
  assert.equal(sm7.adviseConfidence({ kind: 'click_mouse' }), null, 'n=7 < 8 ⇒ null');

  // n=10 ≥ 8 ⇒ 经验置信 = 后验均值，溯源 self-model
  const adv = sm.adviseConfidence({ kind: 'click_mouse' });
  assert.ok(adv, 'n=10 ≥ 8 ⇒ 建议在场');
  assert.equal(adv.source, 'self-model');
  assert.ok(Math.abs(adv.confidence - 0.75) < 1e-9);
  assert.equal(adv.n, 10);

  // 全新格子（无账）⇒ competence null —— 诚实无知，绝不返回 0.5 假数据
  assert.equal(sm.competence({ actionKind: 'never_done' }), null);
});

// ─── Ι-2 衰减（懒结算） ───

test('Ι-2: 推进 3 个半衰期 ⇒ 旧证据权重 1/8；再记 1 败显著拉低 mean；衰减后证据不足 ⇒ 建议退场', () => {
  const HL = 3_600_000; // halfLifeH=1 ⇒ 半衰期 1 小时（毫秒）
  let clock = 0;
  const sm = new SelfModel();
  sm.configure({ minEvidence: 8, halfLifeH: 1, now: () => clock });
  const cell = { actionKind: 'type_text' };
  for (let i = 0; i < 8; i++) sm.recordOutcome(cell, true, clock);
  for (let i = 0; i < 2; i++) sm.recordOutcome(cell, false, clock);

  // 推进 3 个半衰期：懒结算在首次读取时折算 —— s=8/8=1、f=2/8=0.25
  clock = 3 * HL;
  const c1 = sm.competence(cell);
  assert.ok(c1, '衰减后仍有账（证据尚存）');
  assert.ok(Math.abs(c1.n - 1.25) < 1e-9, `旧证据权重 2⁻³ ⇒ n=${c1.n} ≈ 10/8`);
  assert.ok(Math.abs(c1.mean - 2 / 3.25) < 1e-9, `mean=${c1.mean} = (1+1)/(1.25+2)`);
  assert.equal(sm.adviseConfidence({ kind: 'type_text' }), null, '衰减后 n=1.25 < 8 ⇒ 建议诚实退场');

  // 再记 1 败（在 3HL 处，全重入场）：f = 0.25 + 1 ⇒ mean 2/4.25 ≈ 0.471 显著拉低
  sm.recordOutcome(cell, false, clock);
  const c2 = sm.competence(cell);
  assert.ok(c2);
  assert.ok(Math.abs(c2.n - 2.25) < 1e-9, `n=${c2.n} = 1 + 0.25 + 1`);
  assert.ok(Math.abs(c2.mean - 2 / 4.25) < 1e-9, `mean=${c2.mean}`);
  assert.ok(c2.mean < c1.mean - 0.1, `新败显著拉低 mean：${c1.mean} → ${c2.mean}`);
});

// ─── Ι-3 场景桶分格 ───

test('Ι-3: 同 actionKind 不同 sceneBucket ⇒ 独立格子；指纹缺席 ⇒ 诚实降级 actionKind 单轴', () => {
  const clock = 5;
  const sm = new SelfModel();
  sm.configure({ minEvidence: 5, halfLifeH: 168, now: () => clock });

  // 量化器原子面：64 位位串 → 16bit 桶（4×4 块均值阈值位图，worldModel 同门方言）
  const fpA = '1'.repeat(64);   // 全 1 ⇒ 每块 4/4 ≥ 2 ⇒ 'ffff'
  const fpB = '0'.repeat(64);   // 全 0 ⇒ 每块 0/4 ⇒ '0000'
  assert.equal(sceneBucketFromFingerprint(fpA), 'ffff');
  assert.equal(sceneBucketFromFingerprint(fpB), '0000');
  assert.equal(sceneBucketFromFingerprint(fpA.slice(0, 63) + '0'), 'ffff', '块均值阈值吸收单 bit 微抖');
  assert.equal(sceneBucketFromFingerprint('f3a0'), 'f3a0', '已是桶串 ⇒ 幂等直通');
  assert.equal(sceneBucketFromFingerprint('#3 dHash=10101010 popup=false'), null, '摘要文本不可量化');
  assert.equal(sceneBucketFromFingerprint(undefined), null, '字段缺席 ⇒ null');
  assert.equal(sceneBucketFromFingerprint(42), null, '非串 ⇒ null');

  // 分格：同 actionKind 不同 sceneBucket ⇒ 独立格子
  const cellA = { actionKind: 'click_mouse', sceneBucket: 'ffff' };
  const cellB = { actionKind: 'click_mouse', sceneBucket: '0000' };
  for (let i = 0; i < 10; i++) sm.recordOutcome(cellA, true, clock);
  sm.recordOutcome(cellB, false, clock);
  const cA = sm.competence(cellA);
  const cB = sm.competence(cellB);
  assert.ok(cA && cA.n === 10, '格子 A 独立记账');
  assert.ok(cB && cB.n === 1, '格子 B 独立记账（不与 A 合并）');

  // adviseConfidence 用指纹原文分格（桶量化在实现内，调用方零方言）
  const advA = sm.adviseConfidence({ kind: 'click_mouse' }, fpA);
  assert.ok(advA && advA.n === 10, '指纹 A 命中格子 A（n=10 ≥ 5）');
  assert.equal(sm.adviseConfidence({ kind: 'click_mouse' }, fpB), null, '指纹 B 命中格子 B（n=1 < 5 ⇒ null）');

  // 指纹缺席 ⇒ 诚实降级 actionKind 单轴（同一格，绝不伪造场景）
  for (let i = 0; i < 6; i++) sm.recordOutcome({ actionKind: 'scroll_page' }, true, clock);
  const advNone = sm.adviseConfidence({ kind: 'scroll_page' });
  const advJunk = sm.adviseConfidence({ kind: 'scroll_page' }, '#3 dHash=10101010 popup=false');
  assert.ok(advNone && advNone.n === 6, '无指纹 ⇒ 单轴格（n=6 ≥ 5）');
  assert.ok(advJunk && advJunk.n === 6, '坏指纹 ⇒ 同一单轴格（诚实降级路径在册）');
});

// ─── Ι-4 闸门接线 ───

test('Ι-4: destructive + selfModel 低经验置信 ⇒ 闸门用经验置信触发 ask_human（epistemic-gate）；场景指纹透传', async () => {
  const spec: GoalSpec = { goal: '清理磁盘', successCriteria: ['磁盘已清理'] };

  // 真实 SelfModel（非桩）：click × 场景桶 ffff 记 12 败 ⇒ Beta(1,13) mean≈0.071
  const real = new SelfModel();
  real.configure({ minEvidence: 8, halfLifeH: 168, now: () => 1_000 });
  for (let i = 0; i < 12; i++) {
    real.recordOutcome({ actionKind: 'click', sceneBucket: 'ffff' }, false, 1_000);
  }
  // 包装桩：拦截入参取证（动作对象 + 快照 dhash 原文透传），裁决走真模型
  const seenFingerprints: unknown[] = [];
  const seenKinds: unknown[] = [];
  const wrapped: SelfModelPort = {
    adviseConfidence: (action, sceneFingerprint) => {
      seenFingerprints.push(sceneFingerprint);
      seenKinds.push((action as { kind?: unknown } | null)?.kind);
      return real.adviseConfidence(action, sceneFingerprint);
    },
  };

  const goal = new GoalStateMachine(spec);
  let execCalls = 0;
  let constitutionCalls = 0;
  const deps: AutonomyDeps = {
    perceive: async () => SNAP,
    // destructive × 自报置信 0.9 —— 若闸门仍用自报，红律（<0.3）不会放行熔断
    policy: monoPolicy({ action: destructiveClick('格式化磁盘', 0.9), uncertain: false, degraded: false }),
    execute: async () => { execCalls++; return { outcome: 'progress' }; },
    goal,
    constitution: {
      check: () => {
        constitutionCalls++;
        return { allowed: true, riskTier: 'destructive', requiresApproval: false, reason: '不应到达：闸门先于宪法' };
      },
    },
    // 生产红律收窄面：仅 destructive × 置信 < 0.3 可熔断
    epistemicGate: { blockOnlyTiers: ['destructive'], blockOnlyBelowConfidence: 0.3 },
    selfModel: wrapped,
    sleep: async () => { throw new Error('本用例不得睡眠'); },
    now: () => 5,
  };

  const res = await runAutonomousLoop(deps);

  // 溯源取证：闸门把动作对象与快照 dhash 原文喂给了自我模型（桶量化在模型内）
  assert.equal(seenFingerprints.length, 1);
  assert.equal(seenFingerprints[0], SNAP.dhash, '场景指纹 = 感知快照 dhash 原文');
  assert.equal(seenKinds[0], 'click');

  // 熔断裁决：经验置信 1/14 ≈ 0.071 < 0.3 ⇒ 红律放行熔断 ⇒ ask_human
  assert.equal(res.escalated, true);
  assert.equal(res.escalateReason, 'epistemic-gate');
  assert.equal(res.steps, 0, '被熔断动作不入轨迹');
  assert.deepEqual(res.trajectory, []);
  assert.equal(execCalls, 0, '被熔断动作不得执行');
  assert.equal(constitutionCalls, 0, '闸门在 constitution.check 之前执法');
  // adviseAction 的 raw 即经验置信（0.071，非自报 0.9）—— 换源发生了
  assert.match(res.summary, /认识论闸门升级/);
  assert.match(res.summary, /自报置信 0\.071/, '经验置信 1/14≈0.071 进了校准链（不是自报 0.9）');
  assert.match(res.summary, /source:'self-model'（经验置信 n=12）/);
});

test('Ι-4: selfModel 缺席 vs 返回 null ⇒ 两跑逐字段一致（纪元 Η 零回归红律）', async () => {
  const run = async (sm: SelfModelPort | undefined) => {
    const goal = new GoalStateMachine({ goal: '清理磁盘', successCriteria: ['磁盘已清理'] });
    let execCalls = 0;
    const deps: AutonomyDeps = {
      perceive: async () => SNAP,
      // 自报置信 0.9：走自报链时 eff=0.740 ⇒ ask_human 但红律（0.9 ≥ 0.3）收窄放行
      policy: monoPolicy({ action: destructiveClick('格式化磁盘', 0.9), uncertain: false, degraded: false }),
      execute: async () => { execCalls++; return { outcome: 'progress', criteriaEvidence: [{ index: 0, status: 'met' }] }; },
      goal,
      epistemicGate: { blockOnlyTiers: ['destructive'], blockOnlyBelowConfidence: 0.3 },
      sleep: async () => {},
      now: () => 5,
    };
    if (sm !== undefined) deps.selfModel = sm;
    const res = await runAutonomousLoop(deps);
    return { res, execCalls };
  };

  const legacy = await run(undefined);                              // 纪元 Η 形态（无 selfModel 字段）
  const cold = await run({ adviseConfidence: () => null });         // 冷启动诚实 null

  // 旧行为：自报 0.9 过红律 ⇒ 放行执行并达成，注记红律收窄留痕
  assert.equal(legacy.res.phase, 'achieved');
  assert.equal(legacy.res.steps, 1);
  assert.equal(legacy.execCalls, 1);
  assert.match(String(legacy.res.trajectory[0].note), /认识论闸门 ask_human（有效置信 0\.740，红律收窄放行）/);

  // null 建议路径与缺席路径逐字段一致（含 summary/trajectory/note —— 零 self-model 痕迹）
  assert.deepEqual(cold.res, legacy.res);
  assert.equal(cold.execCalls, legacy.execCalls);
  assert.ok(!String(cold.res.trajectory[0].note).includes('self-model'), '自报链注记零 self-model 痕迹');
});

test('Ι-4: 良性动作 + selfModel 高经验置信 ⇒ proceed 放行且步注记带 source:\'self-model\'（journal 留痕）', async () => {
  const goal = new GoalStateMachine({ goal: '打开设置', successCriteria: ['设置可见'] });
  const deps: AutonomyDeps = {
    perceive: async () => SNAP,
    policy: monoPolicy({
      // benign × 自报 0.4（低）：若走自报链 eff=0.5+0.6×(−0.1)=0.440 < proceed 0.5
      // ⇒ 低置信但代价可控 ⇒ ask_vlm（无云脑则问人）—— 注记会不同；
      // 经验置信 0.95 ⇒ eff=0.770 ≥ 0.5 ⇒ proceed —— 注记差异即换源证据
      action: {
        kind: 'click',
        rationale: '良性点击',
        expectedEffect: '设置打开',
        utility: 0.4,
        riskTier: 'benign',
      },
      uncertain: false,
      degraded: false,
    }),
    execute: async () => ({ outcome: 'progress', criteriaEvidence: [{ index: 0, status: 'met' }] }),
    goal,
    epistemicGate: {}, // 全幅缺省：无红律收窄
    selfModel: { adviseConfidence: () => ({ confidence: 0.95, n: 40, source: 'self-model' }) },
    sleep: async () => {},
    now: () => 1,
  };

  const res = await runAutonomousLoop(deps);

  assert.equal(res.phase, 'achieved');
  assert.equal(res.steps, 1);
  // 步注记：经验置信参与了裁决且 journal 留痕（source:'self-model' + 证据量）
  assert.match(
    String(res.trajectory[0].note),
    /认识论闸门 proceed（有效置信 0\.770，source:'self-model'（经验置信 n=40））/,
    'proceed 注记带 self-model 溯源（自报链旧格式零污染）',
  );
});

test('Ι-4/栈: buildAutonomyStack —— enableSelfModel 缺省 true ⇒ 单例铸进栈并灌注两键；false ⇒ 字段缺席', () => {
  const on = buildAutonomyStack(makeConfig(), {});
  assert.ok(on.selfModel, '缺省 true ⇒ 自我模型铸进栈');
  assert.equal(typeof on.selfModel!.adviseConfidence, 'function', '栈内消费面 = adviseConfidence');
  const off = buildAutonomyStack(makeConfig({ enableSelfModel: false }), {});
  assert.equal(off.selfModel, undefined, '开关关闭 ⇒ 字段缺席（闸门走纪元 Η 自报置信路径）');

  // 配置键灌注：selfModelMinEvidence=3 ⇒ 单例门槛 3（经行为验证，不窥私）
  buildAutonomyStack(makeConfig({ selfModelMinEvidence: 3, selfModelHalfLifeH: 24 }), {});
  selfModel.reset();
  selfModel.configure({ enabled: true, now: () => 1 }); // 不覆盖 minEvidence —— 栈已灌 3
  selfModel.recordOutcome({ actionKind: 'k' }, true, 1);
  selfModel.recordOutcome({ actionKind: 'k' }, true, 1);
  assert.equal(selfModel.adviseConfidence({ kind: 'k' }), null, 'n=2 < 3（栈灌注的门槛在执法）');
  selfModel.recordOutcome({ actionKind: 'k' }, true, 1);
  const adv = selfModel.adviseConfidence({ kind: 'k' });
  assert.ok(adv && adv.n === 3 && adv.source === 'self-model', 'n=3 ⇒ 建议在场');
  selfModel.reset();
});

// ─── Ι-5 永不抛 + 自省面 + get_metrics ───

test('Ι-5: 坏 cell/坏时间戳/坏建议全吸收（永不抛）；topCells/bottomCells 确定序；dump/restore 往返；禁用面全 null', () => {
  const sm = new SelfModel();
  sm.configure({ minEvidence: 1, halfLifeH: 168, now: () => 42 });

  // 坏输入全吸收：任何一路都不抛（运行层铁律）
  assert.doesNotThrow(() => sm.recordOutcome(null as never, true, 42));
  assert.doesNotThrow(() => sm.recordOutcome(undefined as never, true, 42));
  assert.doesNotThrow(() => sm.recordOutcome({} as never, true, 42));
  assert.doesNotThrow(() => sm.recordOutcome({ actionKind: '' }, true, 42));
  assert.doesNotThrow(() => sm.recordOutcome({ actionKind: 'x' }, 'yes' as never, 42)); // 非布尔结局
  assert.doesNotThrow(() => sm.recordOutcome({ actionKind: 'x' }, true, Number.NaN));   // 坏 ts ⇒ 注入钟兜底
  assert.doesNotThrow(() => sm.recordOutcome({ actionKind: 'x' }, true, Number.POSITIVE_INFINITY));
  assert.doesNotThrow(() => sm.competence(null as never));
  assert.doesNotThrow(() => sm.adviseConfidence(null));
  assert.doesNotThrow(() => sm.adviseConfidence({}));
  assert.doesNotThrow(() => sm.adviseConfidence({ kind: 42 }));
  assert.equal(sm.competence(null as never), null);
  assert.equal(sm.adviseConfidence(null), null);
  // 坏 cell/坏结局零入账；坏 ts 两次回落注入钟（42）⇒ 'x' 格 2 成 —— 兜底语义在册
  assert.equal(sm.stats().cells, 1);
  const cx = sm.competence({ actionKind: 'x' });
  assert.ok(cx && cx.n === 2, '坏时间戳 ⇒ 注入钟兜底入账（ts 缺席不丢战绩）');

  // topCells/bottomCells 确定序：A 9成1败 mean=10/12；B 5成5败 mean=6/12；C 1成9败 mean=2/12
  const t = new SelfModel();
  t.configure({ minEvidence: 1, halfLifeH: 168, now: () => 100 });
  for (let i = 0; i < 9; i++) t.recordOutcome({ actionKind: 'A' }, true, 100);
  t.recordOutcome({ actionKind: 'A' }, false, 100);
  for (let i = 0; i < 5; i++) t.recordOutcome({ actionKind: 'B' }, true, 100);
  for (let i = 0; i < 5; i++) t.recordOutcome({ actionKind: 'B' }, false, 100);
  t.recordOutcome({ actionKind: 'C' }, true, 100);
  for (let i = 0; i < 9; i++) t.recordOutcome({ actionKind: 'C' }, false, 100);
  const top = t.topCells(3);
  const bottom = t.bottomCells(3);
  assert.deepEqual(top.map(r => r.cell.actionKind), ['A', 'B', 'C'], '最擅长：均值降序');
  assert.deepEqual(bottom.map(r => r.cell.actionKind), ['C', 'B', 'A'], '最不擅长：均值升序');
  assert.ok(Math.abs(top[0].mean - 10 / 12) < 1e-9 && top[0].n === 10);
  assert.ok(Math.abs(bottom[0].mean - 2 / 12) < 1e-9 && bottom[0].n === 10);
  assert.deepEqual(t.topCells(2).map(r => r.cell.actionKind), ['A', 'B'], 'k 截断');
  assert.deepEqual(t.topCells(0), [], '坏 k（0）⇒ 空榜');
  assert.deepEqual(t.topCells(Number.NaN), [], '坏 k（NaN）⇒ 空榜');
  assert.equal(t.stats().cells, 3);
  assert.ok(Math.abs(t.stats().evidence - 30) < 1e-9, '总证据量 = 30');

  // dump/restore 往返：同钟恢复 ⇒ 榜单逐字段复现（纯数据面，checkpoint 消费）
  const snap = t.dump();
  assert.equal(snap.version, 1);
  assert.equal(snap.cells.length, 3);
  const t2 = new SelfModel();
  t2.configure({ minEvidence: 1, halfLifeH: 168, now: () => 100 });
  t2.restore(snap);
  assert.deepEqual(t2.topCells(3), top, '快照往返：榜单逐字段复现');
  assert.ok(Math.abs(t2.competence({ actionKind: 'A' })!.mean - 10 / 12) < 1e-9);
  // 水合防御：坏行跳过、好行入账（半水合诚实，绝不因一行脏数据丢整本账）
  t2.restore({
    version: 1,
    cells: [
      { key: 'A', s: 9, f: 1, lastTs: 100 },
      { key: '', s: 5, f: 5, lastTs: 100 },      // 坏行：空键
      { key: 'X', s: -1, f: 0, lastTs: 100 },    // 坏行：负计数
      { key: 'Y', s: 1, f: 'a', lastTs: 100 },   // 坏行：非数
    ],
  });
  assert.equal(t2.stats().cells, 1, '只有好行入账');
  assert.ok(t2.competence({ actionKind: 'A' }));
  assert.equal(t2.competence({ actionKind: 'X' }), null);
  assert.doesNotThrow(() => t2.restore({ garbage: true }));
  assert.doesNotThrow(() => t2.restore(null));

  // 禁用面：记录 no-op、读取恒 null、内省 null（诚实熄灯）
  const off = new SelfModel();
  off.configure({ enabled: false });
  assert.doesNotThrow(() => off.recordOutcome({ actionKind: 'z' }, true, 1));
  assert.equal(off.competence({ actionKind: 'z' }), null);
  assert.equal(off.adviseConfidence('z'), null);
  assert.equal(off.introspect(), null);
  assert.equal(off.stats().cells, 0);
  assert.deepEqual(off.topCells(3), []);
});

test('Ι-5: get_metrics —— selfModel 新字段在场（top/bottom 各 3 条 + 总格子数 + 总证据量）且旧字段零变化', async () => {
  // 单例自省面（生产同一枚）：注入钟 + 两格战绩（一擅一拙）
  selfModel.reset();
  selfModel.configure({ enabled: true, minEvidence: 1, halfLifeH: 168, now: () => 1_000 });
  for (let i = 0; i < 6; i++) {
    selfModel.recordOutcome({ actionKind: 'click_mouse', sceneBucket: 'ffff' }, true, 1_000);
  }
  for (let i = 0; i < 6; i++) {
    selfModel.recordOutcome({ actionKind: 'press_hotkey', sceneBucket: '0000' }, false, 1_000);
  }

  // 宿主 defineTool 的运行时参数校验要求 args 为对象（类型面 0 参签名与运行时
  // 面的错位以 ToolLike 抹平 —— epochSigma.dashboard/epochMu 同律）
  type ToolLike = { execute: (a: unknown, e: unknown) => Promise<unknown> };
  const tool = createGetMetricsTool() as unknown as ToolLike;
  const j = JSON.parse(String(await tool.execute({}, undefined)));

  // 旧字段零变化（结构与语义均保持）
  assert.equal(j.status, 'SUCCESS');
  assert.ok(j.metrics && typeof j.metrics === 'object' && 'global' in j.metrics, 'metrics 汇总层在场');
  assert.ok(Array.isArray(j.insights) && j.insights.length > 0, 'insights 永在场');
  assert.ok('behavioral_complexity' in j, 'behavioral_complexity 在场');

  // 新字段：topCells/bottomCells 各 3 条（此处只有 2 格）+ 总格子数 + 总证据量
  assert.ok(j.selfModel, 'selfModel 新字段在场（单例缺省启用）');
  assert.equal(j.selfModel.cells, 2, '总格子数');
  assert.ok(Math.abs(j.selfModel.evidence - 12) < 1e-6, '总证据量 = 12');
  assert.equal(j.selfModel.top.length, 2, 'top 条数 = min(3, 格子数)');
  assert.equal(j.selfModel.bottom.length, 2, 'bottom 条数 = min(3, 格子数)');
  assert.equal(j.selfModel.top[0].cell.actionKind, 'click_mouse');
  assert.equal(j.selfModel.top[0].cell.sceneBucket, 'ffff');
  assert.ok(Math.abs(j.selfModel.top[0].mean - 7 / 8) < 1e-9, '6成0败 ⇒ (6+1)/(6+2)=0.875');
  assert.equal(j.selfModel.bottom[0].cell.actionKind, 'press_hotkey');
  assert.ok(Math.abs(j.selfModel.bottom[0].mean - 1 / 8) < 1e-9, '0成6败 ⇒ 1/8');

  // 禁用 ⇒ introspect null ⇒ 字段整体缺席（既有消费者零感知）
  selfModel.configure({ enabled: false });
  const jOff = JSON.parse(String(await tool.execute({}, undefined)));
  assert.ok(!('selfModel' in jOff), '禁用 ⇒ selfModel 字段缺席');
  assert.equal(jOff.status, 'SUCCESS');

  selfModel.configure({ enabled: true });
  selfModel.reset();
});
