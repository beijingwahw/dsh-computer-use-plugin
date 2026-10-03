// test/w5macro.bench.ts  ——  W5-6 效能基准包 · A1 宏重放决策调用缩减
//
// 被测声明（W4-1 A1，macroExecutor + runtime 'macro' 决策面）：同一任务
// 字面量逐步执行（每步一次 VLM 感知 + 决策）vs 宏链执行（一次决策 +
// 链内 dhash 抽查节奏）。任务书声明口径：步数降 30–50%。
//
// 口径（声明值 vs 实测值，逐项入 console 表）：
//   · 任务字面量：6 步技能链（click Save → type 'a' → click OK → type 'b'
//     → click Done → type 'c'）—— 两臂同一字面量、同一假世界；
//   · 逐步臂 = runAutonomousLoop 逐决策执行 6 个原子动作 + 1 个 escalate
//     收口（7 轮决策）；宏臂 = 1 个 'macro' 决策（payload.skillId 指向同链
//     技能）+ 1 个 escalate 收口（2 轮决策）；
//   · 决策调用（VLM 感知当量）= policy.decide 次数（每轮决策前必有一次
//     重型 perceive —— 两计数同步）；物理派发数两臂必须相等（宏省的是
//     决策不是工作）；宏臂的链内开销（dhash 抽查 = 截屏+dhash 轻端口）
//     单列呈报；
//   · 声明值：决策步缩减 ≥30%（声明档 30–50% 的下沿）；实测值 = (7−2)/7
//     ≈ 71.4% —— 超出声明档上沿，如实呈报（宏一次决策覆盖全链所致）。
//
// 确定性：假感知/假帧哈希缺席（逐步臂逐轮完整感知）、monkey-patch 键鼠
// （finally 复原）、注入时钟零真睡、skillLibrary 每测复位；无随机。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { system } from '../src/system.ts';
import { kernelRegistry } from '../src/kernel/registry.ts';
import { skillLibrary, type SkillStep } from '../src/skillLibrary.ts';
import { runAutonomousLoop, type AutonomyDeps } from '../src/autonomy/autoPilot.ts';
import { createExecute, type MacroPolicyAction, type RuntimeDeps } from '../src/autonomy/runtime.ts';
import { composeSnapshot, type WorldSnapshot } from '../src/autonomy/worldSnapshot.ts';
import type { PolicyAction } from '../src/autonomy/policyEngine.ts';
import { resetMacroRehearsalGate } from '../src/sandbox/macroRehearsal.ts';

// ─── 假件工坊 ───

type SystemPatch = Partial<Record<'clickMouse' | 'typeText' | 'getScreenSize', unknown>>;
function patchSystem(over: SystemPatch): () => void {
  const saved: Record<string, unknown> = {};
  const host = system as unknown as Record<string, unknown>;
  for (const key of Object.keys(over)) {
    saved[key] = host[key];
    host[key] = (over as Record<string, unknown>)[key];
  }
  return () => { for (const key of Object.keys(over)) host[key] = saved[key]; }
}

type Goal = AutonomyDeps['goal'];
type Spec = Goal['spec'];
type Act = Parameters<AutonomyDeps['execute']>[0];
type Decision = Awaited<ReturnType<AutonomyDeps['policy']['decide']>>;

/** 手写目标机桩（w1gate StubGoal 最小拷贝） */
class StubGoal {
  readonly spec: Spec;
  readonly progress = { steps: 0, criteria: ['pending'], blockers: [] as string[] };
  began = false;
  tickCount = 0;
  constructor(s: Spec) { this.spec = s; }
  begin(): void { this.began = true; }
  tick(): void { this.tickCount++; this.progress.steps = this.tickCount; }
  recordCriterion(): void { /* 判据恒 pending */ }
  recordAll(): void { /* 同上 */ }
  addBlocker(reason: string): void { this.progress.blockers.push(reason); }
  clearBlockers(): void { this.progress.blockers = []; }
  evaluate(): { phase: 'acting'; reason: string } { return { phase: 'acting', reason: '进行中' }; }
  toAnchor(): Record<string, unknown> { return { steps: this.tickCount }; }
}

/** 任务字面量：6 步技能链（click×3 + type×3，坐标带 target_description 供重锚定） */
const CHAIN: SkillStep[] = [
  { tool: 'click_mouse', args: { x: 0.25, y: 0.25, target_description: 'Save' } },
  { tool: 'type_text', args: { text: 'alpha' } },
  { tool: 'click_mouse', args: { x: 0.40, y: 0.60, target_description: 'OK' } },
  { tool: 'type_text', args: { text: 'bravo' } },
  { tool: 'click_mouse', args: { x: 0.60, y: 0.40, target_description: 'Done' } },
  { tool: 'type_text', args: { text: 'charlie' } },
];

/** 与感知快照（512×384 像素系）配套的锚点元素 —— 三个落点各得其控件 */
function anchoredSnapshot(): WorldSnapshot {
  return composeSnapshot({
    width: 512,
    height: 384,
    dhash: 'aaaaaaaaaaaaaaaa',
    localElements: [
      { label: 'Save', bbox: { x0: 96, y0: 76, x1: 160, y1: 124 }, confidence: 0.9 },
      { label: 'OK', bbox: { x0: 166, y0: 208, x1: 246, y1: 272 }, confidence: 0.9 },
      { label: 'Done', bbox: { x0: 280, y0: 132, x1: 336, y1: 180 }, confidence: 0.9 },
    ],
    ocrText: 'Save OK Done',
  });
}

/** 逐步臂的原子动作剧本（与 CHAIN 逐字面量等价） */
const stepwiseActions: PolicyAction[] = [
  { kind: 'click', target: { bbox: { x0: 96, y0: 76, x1: 160, y1: 124 }, center: { x: 128, y: 100 }, label: 'Save' }, rationale: 'r', expectedEffect: 'e', utility: 0.5, riskTier: 'benign' },
  { kind: 'type', payload: { text: 'alpha' }, rationale: 'r', expectedEffect: 'e', utility: 0.5, riskTier: 'benign' },
  { kind: 'click', target: { bbox: { x0: 166, y0: 208, x1: 246, y1: 272 }, center: { x: 206, y: 240 }, label: 'OK' }, rationale: 'r', expectedEffect: 'e', utility: 0.5, riskTier: 'benign' },
  { kind: 'type', payload: { text: 'bravo' }, rationale: 'r', expectedEffect: 'e', utility: 0.5, riskTier: 'benign' },
  { kind: 'click', target: { bbox: { x0: 280, y0: 132, x1: 336, y1: 180 }, center: { x: 308, y: 156 }, label: 'Done' }, rationale: 'r', expectedEffect: 'e', utility: 0.5, riskTier: 'benign' },
  { kind: 'type', payload: { text: 'charlie' }, rationale: 'r', expectedEffect: 'e', utility: 0.5, riskTier: 'benign' },
];

const ESCALATE: Act = {
  kind: 'escalate', rationale: '任务完成移交上游', expectedEffect: '上游裁决', utility: 0.1, riskTier: 'benign',
};

/** 一次跑环 + 决策/感知/物理全计数（全离线注入） */
async function runPilot(decisions: Decision[], opts: { maxSteps?: number } = {}): Promise<{
  decideCalls: number;
  perceiveCalls: number;
  execCalls: number;
  physical: { clicks: number; types: string[] };
  captures: number;
  dhashes: number;
  escalated: boolean;
}> {
  const snap = anchoredSnapshot();
  const physical = { clicks: 0, types: [] as string[] };
  let decideCount = 0;
  let execCount = 0;
  let perceiveCalls = 0;
  let captures = 0;
  let dhashes = 0;
  let clock = 0;

  // runtime 执行面：注入 capture/dhashOf/readWords（dhash 与基线差 16 > 容差 3
  // ⇒ 链内抽查恒判「世界动了」，不触发反证中止）
  const runtimeDeps: RuntimeDeps & { spec: Spec; width: number; height: number } = {
    capture: async () => { captures++; return Buffer.from([captures]); },
    imageSize: async () => ({ width: 512, height: 384 }),
    dhashOf: async () => { dhashes++; return 'cccccccccccccccc'; },
    readWords: async (): Promise<never[]> => [],
    now: () => (clock += 50),
    sleep: async () => { /* 零真睡 */ },
    lastSnapshotRef: { current: snap },
    spec: { goal: 'W5-6 宏重放基准', successCriteria: ['完成'] },
    width: 512,
    height: 384,
  };
  const execute = createExecute(runtimeDeps);

  const deps: AutonomyDeps = {
    perceive: async () => { perceiveCalls++; return snap; },
    policy: {
      decide: async () => {
        const i = Math.min(decideCount++, decisions.length - 1);
        return decisions[i]!;
      },
    },
    execute: async (action) => {
      execCount++;
      const out = await execute(action as Parameters<typeof execute>[0]);
      if (out.outcome !== 'progress' && out.outcome !== 'no_effect' && out.outcome !== 'error') {
        throw new Error(`意外结局 ${JSON.stringify(out)}`);
      }
      return out;
    },
    goal: new StubGoal({ goal: '任务', successCriteria: ['完成'], maxSteps: opts.maxSteps ?? 12 }) as unknown as Goal,
    sleep: async () => { /* 零真睡 */ },
    now: () => (clock += 50),
  };
  const res = await runAutonomousLoop(deps, { maxSteps: opts.maxSteps });
  return {
    decideCalls: decideCount, perceiveCalls, execCalls: execCount, physical, captures, dhashes,
    escalated: res.escalated,
  };
}

// 键鼠世界 patched（记录物理派发 —— 两臂工作等量的对账锚）
let clicks = 0;
let typed: string[] = [];
let restoreSystem: () => void;

beforeEach(() => {
  skillLibrary.configure(true, '', 50);
  skillLibrary.reset();
  resetMacroRehearsalGate();
  kernelRegistry.reset();
  clicks = 0;
  typed = [];
  restoreSystem = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async () => { clicks++; },
    typeText: async (t: string) => { typed.push(t); },
  });
});

afterEach(() => {
  restoreSystem();
  kernelRegistry.reset();
});

// ─── A1 基准 ───

test('W5-6/A1: 宏重放 —— 同一任务字面量的决策调用缩减（声明 ≥30%，实测 ~71%）', async () => {
  // 技能入库 + 一次成功回报（可靠度 2/3 ≥ 0.5 ⇒ 排练门禁免验直放）
  const skill = skillLibrary.induce('W5-6 基准任务', CHAIN)!;
  skillLibrary.recordOutcome(skill.id, true);

  // 逐步臂：7 轮决策（6 原子动作 + escalate）
  const stepwise = await runPilot([
    ...stepwiseActions.map((action): Decision => ({ action, uncertain: false, degraded: false })),
    { action: ESCALATE, uncertain: false, degraded: false },
  ]);
  const stepwisePhysical = { clicks, types: [...typed] };

  // 宏臂：2 轮决策（1 macro + escalate）
  clicks = 0;
  typed = [];
  const macroAction = {
    kind: 'macro',
    payload: { skillId: skill.id },
    rationale: '整链一次决策重放',
    expectedEffect: '六步流程完成',
    utility: 0.8,
    riskTier: 'benign',
  } as unknown as Act; // MacroPolicyAction 是 runtime 面合法扩展字（policyEngine 闭集零触碰）
  const macro = await runPilot([
    { action: macroAction, uncertain: false, degraded: false },
    { action: ESCALATE, uncertain: false, degraded: false },
  ]);
  const macroPhysical = { clicks, types: [...typed] };

  const decideReduction = 1 - macro.decideCalls / stepwise.decideCalls;
  const perceiveReduction = 1 - macro.perceiveCalls / stepwise.perceiveCalls;

  console.log([
    '── W5-6/A1 宏重放决策调用（同一 6 步任务字面量，两臂同假世界）──',
    `逐步臂: decide=${stepwise.decideCalls} perceive=${stepwise.perceiveCalls} exec=${stepwise.execCalls} 物理 clicks=${stepwisePhysical.clicks} types=${stepwisePhysical.types.length} 截屏=${stepwise.captures}`,
    `宏臂:   decide=${macro.decideCalls} perceive=${macro.perceiveCalls} exec=${macro.execCalls} 物理 clicks=${macroPhysical.clicks} types=${macroPhysical.types.length} 截屏=${macro.captures}（链内 dhash 抽查=${macro.dhashes}）`,
    `决策调用缩减 = 1 − ${macro.decideCalls}/${stepwise.decideCalls} = ${(decideReduction * 100).toFixed(1)}%（声明档 30–50%，断言 ≥30% 下沿）`,
    `感知调用缩减 = ${(perceiveReduction * 100).toFixed(1)}%；物理派发两臂等量（宏省决策不省工作）`,
  ].join('\n'));

  // 断言（声明值 vs 实测值）
  assert.ok(decideReduction >= 0.30, `决策调用缩减应 ≥30%（实测 ${(decideReduction * 100).toFixed(1)}%）`);
  assert.equal(stepwise.decideCalls, 7, '逐步臂 7 轮决策（6 动作 + escalate）');
  assert.equal(macro.decideCalls, 2, '宏臂 2 轮决策（macro + escalate）');
  assert.equal(macro.perceiveCalls, stepwise.decideCalls - 5, '宏臂感知与决策同轮同步');
  assert.deepEqual(macroPhysical, stepwisePhysical, '物理派发两臂逐项等量（同一任务真被做完）');
  assert.equal(macroPhysical.clicks, 3, '三次点击全部派发');
  assert.deepEqual(macroPhysical.types, ['alpha', 'bravo', 'charlie'], '三次键入逐字面量回放');
  assert.ok(macro.dhashes >= 3, `链内抽查在岗（每 2 步一次，实测 ${macro.dhashes} 次）`);
  assert.ok(macro.captures < stepwise.captures, '宏臂重型截屏亦不多于逐步臂');
  assert.equal(macro.escalated, true, '宏臂正常 escalate 收口');
});
