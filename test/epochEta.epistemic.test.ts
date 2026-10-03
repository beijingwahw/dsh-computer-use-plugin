// test/epochEta.epistemic.test.ts
// 纪元 Η（认识论闭环）执法册 —— Φ-7 认识论中枢从「设计在册、运行旁路」转为在环执法。
// 全离线确定性：零网络、零真钟、零真睡；所有期望值按 adviseAction 决策表手算硬编码。
// 执法编号：
//   Η-1 高危低置信 ⇒ ask_human 熔断（escalated + 'epistemic-gate'，先于宪法、零执行零步）
//       —— 变体：高危常规置信 × 云脑在场 × 预算见底 ⇒ ask_vlm 降级 abort（aborted 终局不升级）
//   Η-2 良性高置信 ⇒ 零影响 —— 与开关关闭逐字段同行为（终局/步账/轨迹全等，唯步注记留痕）
//   Η-3 开关关闭 ⇒ 逐字段旧行为 —— enableEpistemicGate=false 栈内字段缺席；环层无 gate
//       依赖时 destructive 低置信照旧执行（纪元 Η 前路径）；默认 true 时红律收窄面在册
//   Η-4 破平确定性 —— 候选并列（得分同 · 元素置信同）⇒ Φ-9 反事实效用分破平
//       （风险惩罚让 benign 让位 destructive 之前的输入序）；三围全并列 ⇒ 带内输入
//       次序兜底；全新引擎同输入 ⇒ 逐字段可复现（同 seed 同输出）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runAutonomousLoop,
  type AutonomyDeps,
  type EpistemicGateOptions,
  type PilotResult,
  type StepRecord,
} from '../src/autonomy/autoPilot.ts';
import { GoalStateMachine, type GoalProgress, type GoalSpec } from '../src/autonomy/goalState.ts';
import {
  PolicyEngine,
  type PolicyContext,
  type PolicyDecision,
} from '../src/autonomy/policyEngine.ts';
import { buildAutonomyStack } from '../src/autonomy/index.ts';
import type { Config } from '../src/config.ts';
import type { SnapshotElement, WorldSnapshot } from '../src/autonomy/worldSnapshot.ts';

// ─── 类型别名与假件工坊（全部字面量，无任何真实感知/网络） ───

type Act = StepRecord['action'];
type Ctx = Parameters<AutonomyDeps['policy']['decide']>[0];

/** 固定世界快照（dhash 恒 'e7a1'） */
const SNAP: WorldSnapshot = {
  takenAt: 1_000, width: 1920, height: 1080, dhash: 'e7a1',
  elements: [], textDigest: '', popups: [], focusedRegion: null,
  sceneLabel: '', degraded: [],
};

/** 破坏性点击动作字面量（utility 即自报置信 —— Η-1 的低置信载体） */
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

/** 良性观察动作字面量 */
function benignAct(kind: Act['kind'], utility: number): Act {
  return {
    kind,
    rationale: '良性观察动作',
    expectedEffect: '收集上下文，不改变世界',
    utility,
    riskTier: 'benign',
  };
}

/** 单决定策略桩（每次 decide 都返回同一决定） */
function monoPolicy(decision: PolicyDecision): AutonomyDeps['policy'] {
  return { decide: async () => decision };
}

/** 全量默认 autonomy 配置（纪元 Η 键齐备，可局部覆盖） */
function makeConfig(over: Partial<Config> = {}): Config {
  return {
    autonomyEnabled: true,
    autonomyMaxSteps: 24,
    autonomyTimeBudgetSec: 300,
    autonomyAllowTiers: 'benign',
    autonomyVlmWhenUncertain: true,
    autonomyForbiddenKeywords: '',
    enableEpistemicGate: true,
    ...over,
  } as Config;
}

/** 快照元素工厂 —— 缺省可点按钮，center 取几何中心 */
function elem(label: string, o: Partial<SnapshotElement> = {}): SnapshotElement {
  const bbox = o.bbox ?? { x0: 0, y0: 0, x1: 100, y1: 40 };
  return {
    label,
    role: o.role ?? 'button',
    bbox,
    center: o.center ?? { x: (bbox.x0 + bbox.x1) / 2, y: (bbox.y0 + bbox.y1) / 2 },
    confidence: o.confidence ?? 0.8,
    source: o.source ?? 'local',
    interactive: o.interactive === undefined ? true : o.interactive,
  };
}

/** 快照工厂 —— 除覆盖项外全部取安静缺省（无弹窗 / 无聚焦 / 无降级） */
function snap(o: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    takenAt: 1,
    width: o.width ?? 1920,
    height: o.height ?? 1080,
    dhash: o.dhash ?? null,
    elements: o.elements ?? [],
    textDigest: o.textDigest ?? '',
    popups: o.popups ?? [],
    focusedRegion: o.focusedRegion ?? null,
    sceneLabel: o.sceneLabel ?? '',
    degraded: o.degraded ?? [],
  };
}

/** 目标进度工厂 —— 全部判据 unverified */
function prog(criteria: string[]): GoalProgress {
  return {
    phase: 'acting',
    stepIndex: 0,
    criteriaStatus: criteria.map(c => ({ criterion: c, status: 'unverified' as const })),
    startedAt: 1,
    lastUpdateAt: 1,
    blockers: [],
  };
}

// ─── Η-1 高危低置信 ⇒ ask_human 熔断 ───

test('Η-1: 高危低置信 ⇒ ask_human 熔断 —— escalated(epistemic-gate)，先于宪法，零执行零步', async () => {
  const spec: GoalSpec = { goal: '清理临时文件', successCriteria: ['临时文件已清空'] };
  const goal = new GoalStateMachine(spec);
  let execCalls = 0;
  let constitutionCalls = 0;

  const deps: AutonomyDeps = {
    perceive: async () => SNAP,
    // destructive × 自报置信 0.1：校准后 eff = 0.5+0.6×(0.1−0.5) = 0.260 < 云脑阈 0.6
    // ⇒ 决策表第三档「低置信且错误代价高，必须问人」
    policy: monoPolicy({ action: destructiveClick('清空临时文件', 0.1), uncertain: true, degraded: false }),
    execute: async () => { execCalls++; return { outcome: 'progress' }; },
    goal,
    constitution: {
      check: () => {
        constitutionCalls++;
        return { allowed: true, riskTier: 'destructive', requiresApproval: false, reason: '不应到达：闸门先于宪法' };
      },
    },
    epistemicGate: {}, // 全幅缺省：无红律收窄、离线无云脑
    sleep: async () => { throw new Error('本用例不得睡眠'); },
    now: () => 5,
  };

  const res = await runAutonomousLoop(deps);

  assert.equal(res.escalated, true, 'ask_human ⇒ 走既有 escalated 终局');
  assert.equal(res.escalateReason, 'epistemic-gate', '升级归因注明 epistemic-gate');
  assert.equal(res.phase, 'acting', '终局相取 goal.evaluate()（判据 pending ⇒ acting）');
  assert.equal(res.steps, 0, '被熔断动作不入轨迹');
  assert.deepEqual(res.trajectory, []);
  assert.equal(execCalls, 0, '被熔断动作不得执行');
  assert.equal(constitutionCalls, 0, '闸门在 constitution.check 之前执法');
  // 理由标注：校准链 + 代价档 + 问人判决全部入 summary（审计轨迹）
  assert.match(res.summary, /认识论闸门升级/);
  assert.match(res.summary, /自报置信 0\.100/);
  assert.match(res.summary, /有效置信 0\.260/);
  assert.match(res.summary, /错误代价 high/);
  assert.match(res.summary, /必须问人/);
  assert.match(res.summary, /0 步/);
});

// ─── Η-1 变体：高危常规置信 × 云脑在场 × 预算见底 ⇒ abort ───

test('Η-1: 高危常规置信 × 云脑在场 × 预算见底 ⇒ ask_vlm 降级 abort —— aborted 终局不升级', async () => {
  const spec: GoalSpec = { goal: '整理磁盘', successCriteria: ['磁盘整理完成'], timeBudgetSec: 10 };
  const goal = new GoalStateMachine(spec);
  let clock = 0;
  let decideCalls = 0;
  let execCalls = 0;

  const deps: AutonomyDeps = {
    perceive: async () => SNAP,
    policy: {
      decide: async () => {
        decideCalls++;
        if (decideCalls === 1) return { action: benignAct('inspect', 0.8), uncertain: false, degraded: false };
        clock += 9_600; // 第二次裁决前把时间预算烧到 4%（< 预算红线 10%）
        // destructive × 自报置信 0.9：eff = 0.5+0.6×(0.9−0.5) = 0.740 ≥ 云脑阈 0.6
        // 且云脑在场 ⇒ ask_vlm ⇒ 预算 4% < 10% ⇒ 降级 abort（「预算不足以承担云脑咨询」）
        return { action: destructiveClick('格式化磁盘', 0.9), uncertain: false, degraded: false };
      },
    },
    execute: async () => { execCalls++; return { outcome: 'progress' }; },
    goal,
    epistemicGate: { vlmAvailable: true }, // 全幅执法 + 云脑在场（第四维入参取证）
    sleep: async () => {},
    now: () => clock,
  };

  const res = await runAutonomousLoop(deps);

  assert.equal(res.phase, 'aborted', 'abort ⇒ aborted 终局');
  assert.equal(res.escalated, false, '收手不是移交 —— 不升级');
  assert.equal(res.escalateReason, undefined);
  assert.equal(res.steps, 1, '第一步良性已执行，第二步被闸门收手');
  assert.equal(decideCalls, 2);
  assert.equal(execCalls, 1);
  assert.match(res.summary, /认识论闸门收手/);
  assert.match(res.summary, /预算不足以承担云脑咨询/);
  // 良性步（eff 0.680 ≥ proceed 阈 0.5）按裁决注记放行 —— journal 留痕
  assert.equal(res.trajectory.length, 1);
  assert.equal(res.trajectory[0].action.kind, 'inspect');
  assert.match(String(res.trajectory[0].note), /认识论闸门 proceed（有效置信 0\.680）/);
});

// ─── Η-2 良性高置信 ⇒ 零影响 ───

test('Η-2: 良性高置信 ⇒ 零影响 —— 与开关关闭逐字段同行为，唯一步注记留痕', async () => {
  const run = async (gate: EpistemicGateOptions | undefined): Promise<PilotResult> => {
    const goal = new GoalStateMachine({ goal: '打开设置', successCriteria: ['设置可见'] });
    const deps: AutonomyDeps = {
      perceive: async () => SNAP,
      // benign × 自报置信 0.9 ⇒ eff 0.740 ≥ low 档 proceed 阈 0.5 ⇒ proceed 放行
      policy: monoPolicy({ action: benignAct('click', 0.9), uncertain: false, degraded: false }),
      execute: async () => ({ outcome: 'progress', criteriaEvidence: [{ index: 0, status: 'met' }] }),
      goal,
      sleep: async () => {},
      now: () => 1,
    };
    if (gate !== undefined) deps.epistemicGate = gate;
    return runAutonomousLoop(deps);
  };

  const withGate = await run({});            // 全幅闸门在场
  const withoutGate = await run(undefined);  // 闸门缺席 = 纪元 Η 前旧路径

  // 终局逐字段一致：零影响
  assert.equal(withGate.phase, 'achieved');
  assert.equal(withGate.phase, withoutGate.phase);
  assert.equal(withGate.steps, withoutGate.steps);
  assert.equal(withGate.escalated, withoutGate.escalated);
  assert.equal(withGate.escalateReason, withoutGate.escalateReason);
  assert.equal(withGate.summary, withoutGate.summary, 'proceed 放行不改写终局总结');
  assert.equal(withGate.durationMs, withoutGate.durationMs);
  // 轨迹逐字段一致（投影掉 note —— 注记是唯一允许的留痕差量）
  const project = (r: StepRecord): unknown => ({
    i: r.stepIndex, k: r.action.kind, tier: r.action.riskTier,
    o: r.outcome, d: r.snapshotDhash, at: r.at,
    eff: r.effectiveRiskTier,
  });
  assert.deepEqual(withGate.trajectory.map(project), withoutGate.trajectory.map(project));
  // 唯一差量：闸门注记（journal），旧路径 note 缺席
  assert.equal(withoutGate.trajectory[0].note, undefined);
  assert.match(String(withGate.trajectory[0].note), /认识论闸门 proceed/);
});

// ─── Η-3 开关关闭 ⇒ 逐字段旧行为 ───

test('Η-3: enableEpistemicGate=false ⇒ 栈内字段缺席 + 环层 destructive 低置信照旧执行（纪元 Η 前路径）', async () => {
  // 栈层：总开关 false ⇒ buildAutonomyStack 不接线（闭环走逐字节旧路径）；
  //       缺省 true ⇒ 接线在场且红律收窄面在册（仅 destructive × 自报置信 < 0.3 可熔断）
  const stackOff = buildAutonomyStack(makeConfig({ enableEpistemicGate: false }), {});
  assert.equal(stackOff.epistemicGate, undefined, '开关关闭 ⇒ epistemicGate 字段缺席');
  const stackOn = buildAutonomyStack(makeConfig({}), {});
  assert.ok(stackOn.epistemicGate, '缺省 true（Schema 默认语义）⇒ 闸门接线在场');
  assert.deepEqual(stackOn.epistemicGate!.blockOnlyTiers, ['destructive'], '红律收窄：仅 destructive 可熔断');
  assert.equal(stackOn.epistemicGate!.blockOnlyBelowConfidence, 0.3, '红律收窄：自报置信 < 0.3 才可熔断');
  assert.equal(typeof stackOn.epistemicGate!.vlmAvailable, 'function');

  // 环层：同一 destructive 低置信输入，无 gate 依赖 ⇒ 旧行为（执行、达成、零升级、零注记）
  const goal = new GoalStateMachine({ goal: '清空回收站', successCriteria: ['回收站已清空'] });
  let execCalls = 0;
  const deps: AutonomyDeps = {
    perceive: async () => SNAP,
    policy: monoPolicy({ action: destructiveClick('清空回收站', 0.1), uncertain: true, degraded: false }),
    execute: async () => { execCalls++; return { outcome: 'progress', criteriaEvidence: [{ index: 0, status: 'met' }] }; },
    goal,
    sleep: async () => {},
    now: () => 7,
    // deps.epistemicGate 故意缺席 —— 开关关闭的环层形态
  };
  const res = await runAutonomousLoop(deps);

  assert.equal(res.phase, 'achieved', '旧行为：无宪法注入时 destructive 动作照常执行并达成');
  assert.equal(res.steps, 1);
  assert.equal(res.escalated, false);
  assert.equal(res.escalateReason, undefined);
  assert.equal(execCalls, 1);
  assert.equal(res.trajectory[0].note, undefined, '旧路径零注记');
});

// ─── Η-4 破平确定性 ───

test('Η-4: 候选并列（得分同 · 元素置信同）⇒ 反事实效用分破平 —— 风险惩罚让 benign 胜出输入序在前的 destructive', async () => {
  // 判据「移动文件后删除文件」的 2-gram 全覆盖两个标签 ⇒ 双候选得分 1.0 并列；
  // 元素置信同为 0.8 ⇒ 旧确定性排序按输入序取「删除文件」。
  // Φ-9 效用分（goal 词 ∩ 标签词 同为 3/9、info 同 0.3）唯一分岔是风险：
  //   U(删除文件) = 0.5×(1/3) + 0.3×0.3 − 0.2×1   ≈ 0.057
  //   U(移动文件) = 0.5×(1/3) + 0.3×0.3 − 0.2×0.05 ≈ 0.192 ⇒ 破平胜出
  const ctx: PolicyContext = {
    snapshot: snap({
      elements: [
        elem('删除文件', { confidence: 0.8, bbox: { x0: 0, y0: 0, x1: 100, y1: 40 } }),
        elem('移动文件', { confidence: 0.8, bbox: { x0: 200, y0: 0, x1: 300, y1: 40 } }),
      ],
    }),
    spec: { goal: '清理磁盘', successCriteria: ['移动文件后删除文件'] },
    goal: prog(['移动文件后删除文件']),
    history: [],
  };
  const engine = new PolicyEngine({ useVlmWhenUncertain: false }); // 关咨询 ⇒ 纯确定性破平可断言
  const dec = await engine.decide(ctx);

  assert.equal(dec.action.kind, 'click');
  assert.equal(dec.action.target?.label, '移动文件', '并列带内反事实效用分破平：benign 压过 destructive');
  assert.equal(dec.action.riskTier, 'benign');
  assert.equal(dec.uncertain, true, '得分并列 ⇒ uncertain 保持（破平不改判不确定标注）');
  assert.equal(dec.degraded, false);

  // 同 seed 可复现：全新引擎、同输入 ⇒ 逐字段同输出（确定性稳定序）
  const dec2 = await new PolicyEngine({ useVlmWhenUncertain: false }).decide(ctx);
  assert.deepEqual(dec2.action, dec.action);
  assert.equal(dec2.uncertain, dec.uncertain);

  // 反证（破平的必要性）：把 destructive 放输入序首位时旧排序本会选它 —— 新律不再选
  const flipped = await new PolicyEngine({ useVlmWhenUncertain: false }).decide({
    ...ctx,
    snapshot: snap({
      elements: [
        elem('删除文件', { confidence: 0.8, bbox: { x0: 0, y0: 0, x1: 100, y1: 40 } }),
        elem('移动文件', { confidence: 0.8, bbox: { x0: 200, y0: 0, x1: 300, y1: 40 } }),
      ],
    }),
  });
  assert.equal(flipped.action.target?.label, '移动文件');
});

test('Η-4: 三围全并列（同名同险同置信）⇒ 带内输入次序兜底 —— 首个候选胜出且可复现', async () => {
  // 两个「移动文件」元素：得分 / 置信 / 效用 / 信息增益 / 风险全并列 ⇒ scoreOptions
  // 保序律取输入次序在前者 —— 破平退化为稳定序，绝不掷硬币。
  const ctx: PolicyContext = {
    snapshot: snap({
      elements: [
        elem('移动文件', { confidence: 0.8, bbox: { x0: 0, y0: 0, x1: 100, y1: 40 } }),
        elem('移动文件', { confidence: 0.8, bbox: { x0: 200, y0: 0, x1: 300, y1: 40 } }),
      ],
    }),
    spec: { goal: '清理磁盘', successCriteria: ['移动文件后删除文件'] },
    goal: prog(['移动文件后删除文件']),
    history: [],
  };
  const dec = await new PolicyEngine({ useVlmWhenUncertain: false }).decide(ctx);
  assert.equal(dec.action.kind, 'click');
  assert.equal(dec.action.target?.label, '移动文件');
  assert.deepEqual(dec.action.target?.center, { x: 50, y: 20 }, '首个候选（输入序兜底）的几何');

  // 同 seed 可复现
  const dec2 = await new PolicyEngine({ useVlmWhenUncertain: false }).decide(ctx);
  assert.deepEqual(dec2.action, dec.action);
});
