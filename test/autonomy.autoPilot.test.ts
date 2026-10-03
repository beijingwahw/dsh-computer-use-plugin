// test/autonomy.autoPilot.test.ts
// 纪元 Φ（Φ-4 闭环驱动器）：核心闭环全离线确定性测试 —— 零真钟、零真睡、零网络。
// 兄弟器官（Φ-1 goalState / Φ-2 worldSnapshot / Φ-3 policyEngine / Φ-8 autonomyConstitution）
// 并行撰写中尚未落地 —— 本文件只从 autoPilot 取运行时入口与类型，其余全部以
// 字面量 + 手写桩履约（StubGoal 只实现闭环消费面，字段全公开便于断言）。覆盖：
//   Φ-4-a 顺利达成：execute 报 criteriaEvidence 双 met ⇒ 目标机 achieved；上下文逐字段
//          取证（history 累积 / budgetRemaining 递减 / goal 引用透传 / snapshot 透传）
//   Φ-4-b 宪法否决终局：allowed=false ⇒ escalated + 'constitution-veto'，零步零执行零通知
//   Φ-4-c 审批终局：requiresApproval=true ⇒ escalated + 'approval-required'，宪法上下文取证
//   Φ-4-d 策略升级终局：action.kind='escalate' ⇒ escalated，升级步入轨迹，execute 不触发
//          （顺带取证缺省宪法全放行 —— 本用例不注入 constitution）
//   Φ-4-e 步数保险丝：opts.maxSteps 覆盖 spec.maxSteps ⇒ 到顶强制 aborted
//   Φ-4-f 感知风暴：perceive 连抛 ⇒ 合成 declare 动作的 error 步收敛不炸环，逐步 tick 入账
//   Φ-4-g 错误累积失败：execute 连报 error ⇒ 目标机 tick 达阈判 failed；onStep 抛异常亦不炸环
//   Φ-4-h onStep 计数：通知条数 = 步数、stepIndex 连续、且与轨迹同物（引用相等）
//   Φ-4-i wait 沉降：走注入 sleep（缺省 300ms；opts.settleMs 覆盖），no_effect 步入轨迹，
//          宪法上下文 consecutiveNoEffect 随 wait 步递增
//   Φ-4-j 保险丝零步角：maxSteps=0 ⇒ 立即 aborted，感知零调用
//   Φ-4-k 预置阻塞零执行（纪元 Δ）：环顶终局相位预判 —— blocked-at-begin 零感知
//          零判断零执行（旧律首次相位判定在 execute 之后会漏发一个真动作）；
//          clearBlockers 康复路径不受误伤
//   Φ-4-l 宪法判决分层盖章（纪元 Δ）：executed 步入轨迹带 effectiveRiskTier
//          （垃圾判决值视为缺席）；申报分层保持原样
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAutonomousLoop } from '../src/autonomy/autoPilot.ts';
import type { AutonomyDeps, StepRecord } from '../src/autonomy/autoPilot.ts';

// ─── 类型工坊：兄弟类型缺席，全部经 AutonomyDeps 索引取型 ───

type Goal = AutonomyDeps['goal'];
type Spec = Goal['spec'];
type Act = StepRecord['action'];
type Ctx = Parameters<AutonomyDeps['policy']['decide']>[0];
type Decision = Awaited<ReturnType<AutonomyDeps['policy']['decide']>>;
type ExecResult = Awaited<ReturnType<AutonomyDeps['execute']>>;
type Snap = Awaited<ReturnType<AutonomyDeps['perceive']>>;
type Constitution = NonNullable<AutonomyDeps['constitution']>;
type StubPhase = 'planning' | 'acting' | 'verifying' | 'blocked' | 'achieved' | 'failed' | 'aborted';

// ─── 假件工坊 ───

/** 固定世界快照（dhash 恒 '9f3a' —— 断言步记录取证的锚点） */
const SNAP: Snap = {
  takenAt: 1_000, width: 1920, height: 1080, dhash: '9f3a',
  elements: [], textDigest: '', popups: [], focusedRegion: null,
  sceneLabel: '测试桌面', degraded: [],
};

/** 目标规格铸造器（缺省两判据，可局部覆盖） */
function makeSpec(over: Partial<Spec> = {}): Spec {
  return { goal: '打开系统设置', successCriteria: ['设置窗口可见', '焦点落在设置页'], ...over };
}

/** 手写目标机桩（Φ-1 兄弟契约的面具）：判据台账 + tick 达阈失败 + 相位裁决 */
class StubGoal {
  readonly spec: Spec;
  readonly progress: { steps: number; criteria: Array<'met' | 'violated' | 'pending'>; blockers: string[] };
  began = false;
  tickCount = 0;
  /** tick 次数达到该阈值 ⇒ evaluate 判 failed（错误累积失败路径的开关） */
  failAfterNTicks: number | null = null;

  constructor(s: Spec) {
    this.spec = s;
    this.progress = {
      steps: 0,
      criteria: s.successCriteria.map(() => 'pending' as const),
      blockers: [],
    };
  }
  begin(): void { this.began = true; }
  tick(): void { this.tickCount++; this.progress.steps = this.tickCount; }
  recordCriterion(index: number, status: 'met' | 'violated'): void {
    this.progress.criteria[index] = status;
  }
  recordAll(status: 'met' | 'violated'): void {
    this.progress.criteria = this.progress.criteria.map(() => status);
  }
  addBlocker(reason: string): void { this.progress.blockers.push(reason); }
  clearBlockers(): void { this.progress.blockers = []; }
  evaluate(): { phase: StubPhase; reason: string } {
    const c = this.progress.criteria;
    if (c.length > 0 && c.every(s => s === 'met')) return { phase: 'achieved', reason: '全部成功判据已满足' };
    if (c.some(s => s === 'violated')) return { phase: 'failed', reason: '命中失败判据' };
    if (this.failAfterNTicks !== null && this.tickCount >= this.failAfterNTicks) {
      return { phase: 'failed', reason: '连续错误累积失败' };
    }
    if (this.progress.blockers.length > 0) return { phase: 'blocked', reason: this.progress.blockers[0] };
    return { phase: this.began ? 'acting' : 'planning', reason: '进行中' };
  }
  toAnchor(): Record<string, unknown> { return { steps: this.tickCount, began: this.began }; }
}

/** 点击动作字面量 */
function clickAction(label: string): Act {
  return {
    kind: 'click',
    target: { bbox: { x0: 10, y0: 20, x1: 60, y1: 50 }, center: { x: 35, y: 35 }, label },
    rationale: `点击「${label}」`,
    expectedEffect: '目标界面出现',
    utility: 0.8,
    riskTier: 'benign',
  };
}

/** 观察动作字面量（永不改变世界 —— 保险丝用例的 filler） */
const INSPECT_ACTION: Act = {
  kind: 'inspect',
  rationale: '观察当前界面收集线索',
  expectedEffect: '获得更多上下文',
  utility: 0.3,
  riskTier: 'benign',
};

/** 沉降动作字面量（wait 专用） */
const WAIT_ACTION: Act = {
  kind: 'wait',
  payload: { note: '等列表加载' },
  rationale: '等待界面沉降',
  expectedEffect: '界面进入稳定态',
  utility: 0.2,
  riskTier: 'benign',
};

/** 升级动作字面量（策略主动移交） */
const ESCALATE_ACTION: Act = {
  kind: 'escalate',
  rationale: '目标元素在屏幕上不存在',
  expectedEffect: '移交上级决策',
  utility: 0.1,
  riskTier: 'benign',
};

// ─── Φ-4-a 顺利达成 ───

test('Φ-4-a: 顺利达成 —— criteriaEvidence 双 met ⇒ achieved；上下文逐字段取证', async () => {
  const goal = new StubGoal(makeSpec({ maxSteps: 10 }));
  const decisions: Decision[] = [
    { action: clickAction('设置'), uncertain: false, degraded: false },
    { action: clickAction('搜索框'), uncertain: false, degraded: false, note: '第二步注解' },
  ];
  const execResults: ExecResult[] = [
    { outcome: 'progress' },
    { outcome: 'progress', criteriaEvidence: [{ index: 0, status: 'met' }, { index: 1, status: 'met' }] },
  ];
  const decideCtxs: Ctx[] = [];
  const onStepRecords: StepRecord[] = [];
  let execCalls = 0;
  let clock = 0;

  const deps: AutonomyDeps = {
    perceive: async () => SNAP,
    policy: {
      decide: async ctx => {
        decideCtxs.push(ctx);
        return decisions[decideCtxs.length - 1];
      },
    },
    execute: async () => { return execResults[execCalls++]; },
    goal: goal as unknown as Goal,
    onStep: rec => { onStepRecords.push(rec); },
    sleep: async () => { throw new Error('本用例不得睡眠'); },
    now: () => (clock += 100),
  };

  const res = await runAutonomousLoop(deps);

  // 终局：achieved、两步、未升级
  assert.equal(res.phase, 'achieved');
  assert.equal(res.steps, 2);
  assert.equal(res.escalated, false);
  assert.equal(res.escalateReason, undefined);
  assert.equal(goal.began, true, '开环必须 begin');
  assert.deepEqual(goal.progress.criteria, ['met', 'met'], '判据证据逐条回填目标机');
  assert.ok(res.durationMs > 0, '注入时钟推算时长');

  // 上下文取证：history 累积 / budgetRemaining 递减 / spec·goal·snapshot 透传
  assert.equal(decideCtxs.length, 2);
  assert.equal(decideCtxs[0].history.length, 0);
  assert.equal(decideCtxs[1].history.length, 1);
  assert.equal(decideCtxs[1].history[0].action.kind, 'click');
  assert.equal(decideCtxs[1].history[0].outcome, 'progress');
  assert.equal(decideCtxs[0].budgetRemaining?.steps, 10);
  assert.equal(decideCtxs[1].budgetRemaining?.steps, 9);
  assert.equal(decideCtxs[0].spec.goal, '打开系统设置');
  assert.equal(decideCtxs[0].snapshot.dhash, '9f3a');
  assert.equal(decideCtxs[0].goal, goal.progress, 'goal.progress 必须引用透传');

  // 轨迹与 onStep
  assert.equal(onStepRecords.length, 2);
  assert.deepEqual(onStepRecords, res.trajectory);
  assert.equal(res.trajectory[0].stepIndex, 0);
  assert.equal(res.trajectory[1].stepIndex, 1);
  assert.equal(res.trajectory[0].outcome, 'progress');
  assert.equal(res.trajectory[0].snapshotDhash, '9f3a');
  assert.equal(res.trajectory[1].note, '第二步注解');
  assert.match(res.summary, /achieved/);
  assert.match(res.summary, /2\/2/);
});

// ─── Φ-4-b 宪法否决终局 ───

test('Φ-4-b: 宪法否决终局 —— allowed=false ⇒ escalated，零步零执行零通知', async () => {
  const goal = new StubGoal(makeSpec());
  let execCalls = 0;
  let onStepCalls = 0;

  const deps: AutonomyDeps = {
    perceive: async () => SNAP,
    policy: {
      decide: async () => ({ action: clickAction('清空回收站'), uncertain: false, degraded: false }),
    },
    execute: async () => { execCalls++; return { outcome: 'progress' }; },
    goal: goal as unknown as Goal,
    constitution: {
      check: () => ({
        allowed: false, riskTier: 'destructive', requiresApproval: false,
        reason: '删除类操作禁止自主执行',
      }),
    },
    onStep: () => { onStepCalls++; },
    sleep: async () => {},
    now: () => 42,
  };

  const res = await runAutonomousLoop(deps);

  assert.equal(res.escalated, true);
  assert.equal(res.escalateReason, 'constitution-veto');
  assert.equal(res.phase, 'acting', '否决终局相取 goal.evaluate()（未执行 ⇒ acting）');
  assert.equal(res.steps, 0, '被否决动作不入轨迹');
  assert.deepEqual(res.trajectory, []);
  assert.equal(execCalls, 0);
  assert.equal(onStepCalls, 0);
  assert.equal(goal.tickCount, 0, '被否决不算一步世界推进');
  assert.equal(res.durationMs, 0);
  assert.match(res.summary, /宪法否决/);
  assert.match(res.summary, /删除类操作禁止自主执行/);
});

// ─── Φ-4-c 审批终局 ───

test('Φ-4-c: 审批终局 —— requiresApproval=true ⇒ approval-required，宪法上下文取证', async () => {
  const goal = new StubGoal(makeSpec());
  let execCalls = 0;
  const checks: Array<{ goalText?: string; consecutiveNoEffect: number; stepsTaken: number }> = [];

  const deps: AutonomyDeps = {
    perceive: async () => SNAP,
    policy: {
      decide: async () => ({
        action: {
          kind: 'hotkey', payload: { keys: 'Ctrl+S' },
          rationale: '保存文档', expectedEffect: '文件落盘', utility: 0.6, riskTier: 'sensitive',
        },
        uncertain: false, degraded: false,
      }),
    },
    execute: async () => { execCalls++; return { outcome: 'progress' }; },
    goal: goal as unknown as Goal,
    constitution: {
      check: (a, ctx) => {
        checks.push({ goalText: ctx.goalText, consecutiveNoEffect: ctx.consecutiveNoEffect, stepsTaken: ctx.stepsTaken });
        return { allowed: true, riskTier: a.riskTier, requiresApproval: true, reason: '写盘动作需人工放行' };
      },
    },
    sleep: async () => {},
    now: () => 7,
  };

  const res = await runAutonomousLoop(deps);

  assert.equal(res.escalated, true);
  assert.equal(res.escalateReason, 'approval-required');
  assert.equal(res.phase, 'acting');
  assert.equal(res.steps, 0);
  assert.equal(execCalls, 0, '审批未落地前不得执行');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].goalText, '打开系统设置');
  assert.equal(checks[0].stepsTaken, 0);
  assert.equal(checks[0].consecutiveNoEffect, 0);
  assert.match(res.summary, /审批/);
  assert.match(res.summary, /写盘动作需人工放行/);
});

// ─── Φ-4-d 策略升级终局 ───

test('Φ-4-d: 策略升级终局 —— escalate 动作 ⇒ escalated，升级步入轨迹，零执行（缺省宪法全放行）', async () => {
  const goal = new StubGoal(makeSpec());
  let execCalls = 0;
  const onStepRecords: StepRecord[] = [];

  // 不注入 constitution —— 缺省全放行铸造器必须放行 escalate 动作
  const deps: AutonomyDeps = {
    perceive: async () => SNAP,
    policy: {
      decide: async () => ({ action: ESCALATE_ACTION, uncertain: true, degraded: false, note: '找不到目标' }),
    },
    execute: async () => { execCalls++; return { outcome: 'progress' }; },
    goal: goal as unknown as Goal,
    onStep: rec => { onStepRecords.push(rec); },
    sleep: async () => {},
    now: () => 5,
  };

  const res = await runAutonomousLoop(deps);

  assert.equal(res.escalated, true);
  assert.equal(res.escalateReason, 'policy-escalate');
  assert.equal(res.phase, 'acting');
  assert.equal(res.steps, 1, '升级动作本身入轨迹一步');
  assert.equal(execCalls, 0, '升级动作不执行');
  assert.equal(onStepRecords.length, 1);
  assert.equal(res.trajectory[0].action.kind, 'escalate');
  assert.equal(res.trajectory[0].outcome, 'no_effect');
  assert.match(res.summary, /目标元素在屏幕上不存在/);
});

// ─── Φ-4-e 步数保险丝 ───

test('Φ-4-e: 步数保险丝 —— opts.maxSteps 覆盖 spec.maxSteps ⇒ 到顶强制 aborted', async () => {
  const goal = new StubGoal(makeSpec({ maxSteps: 99 })); // 判据永远 pending ⇒ 目标机永不终局
  let decideCalls = 0;

  const deps: AutonomyDeps = {
    perceive: async () => SNAP,
    policy: {
      decide: async () => { decideCalls++; return { action: INSPECT_ACTION, uncertain: false, degraded: false }; },
    },
    execute: async () => ({ outcome: 'progress' }),
    goal: goal as unknown as Goal,
    sleep: async () => {},
    now: () => 1,
  };

  const res = await runAutonomousLoop(deps, { maxSteps: 3 });

  assert.equal(res.phase, 'aborted');
  assert.equal(res.steps, 3);
  assert.equal(res.escalated, false);
  assert.equal(decideCalls, 3, '恰好感知-判断-执行三轮，第四轮在保险丝处熔断');
  assert.equal(res.trajectory.length, 3);
  assert.equal(goal.tickCount, 3);
  assert.match(res.summary, /aborted/);
  assert.match(res.summary, /保险丝/);
});

// ─── Φ-4-f 感知风暴 ───

test('Φ-4-f: 感知风暴 —— perceive 连抛 ⇒ 合成 declare 的 error 步收敛不炸环', async () => {
  const goal = new StubGoal(makeSpec());
  let perceiveCalls = 0;
  let decideCalls = 0;

  const deps: AutonomyDeps = {
    perceive: async () => { perceiveCalls++; throw new Error(`截屏通道崩溃 #${perceiveCalls}`); },
    policy: {
      decide: async () => { decideCalls++; return { action: clickAction('任意'), uncertain: false, degraded: false }; },
    },
    execute: async () => ({ outcome: 'progress' }),
    goal: goal as unknown as Goal,
    sleep: async () => {},
    now: () => 3,
  };

  const res = await runAutonomousLoop(deps, { maxSteps: 2 });

  assert.equal(res.phase, 'aborted', '两步 error 后由保险丝收场');
  assert.equal(res.steps, 2);
  assert.equal(perceiveCalls, 2);
  assert.equal(decideCalls, 0, '感知失败不得触达策略');
  assert.equal(res.trajectory.length, 2);
  for (const rec of res.trajectory) {
    assert.equal(rec.outcome, 'error');
    assert.equal(rec.action.kind, 'declare', '前置阶段异常必须合成 declare 动作');
    assert.equal(rec.snapshotDhash, null);
    assert.match(String(rec.note), /截屏通道崩溃/);
  }
  assert.equal(goal.tickCount, 2, 'error 步同样推进目标机 tick');
});

// ─── Φ-4-g 错误累积失败 ───

test('Φ-4-g: 错误累积失败 —— execute 连报 error，目标机达阈判 failed；onStep 抛异常不炸环', async () => {
  const goal = new StubGoal(makeSpec());
  goal.failAfterNTicks = 2;
  let execCalls = 0;
  let onStepCalls = 0;

  const deps: AutonomyDeps = {
    perceive: async () => SNAP,
    policy: {
      decide: async () => ({ action: clickAction('不稳定按钮'), uncertain: false, degraded: false }),
    },
    execute: async () => { execCalls++; return { outcome: 'error' }; },
    goal: goal as unknown as Goal,
    onStep: () => { onStepCalls++; throw new Error('观察者自身崩溃'); },
    sleep: async () => {},
    now: () => 11,
  };

  const res = await runAutonomousLoop(deps);

  assert.equal(res.phase, 'failed');
  assert.equal(res.steps, 2);
  assert.equal(execCalls, 2);
  assert.equal(onStepCalls, 2, '观察者每步都被通知且其异常被吞');
  assert.deepEqual(res.trajectory.map(r => r.outcome), ['error', 'error']);
  assert.equal(res.escalated, false);
  assert.match(res.summary, /failed/);
  assert.match(res.summary, /连续错误累积失败/);
});

// ─── Φ-4-h onStep 计数 ───

test('Φ-4-h: onStep 计数 —— 条数 = 步数、stepIndex 连续、与轨迹同物（引用相等）', async () => {
  const goal = new StubGoal(makeSpec({ successCriteria: ['完成标志可见'] }));
  const onStepRecords: StepRecord[] = [];
  const outcomes: ExecResult[] = [
    { outcome: 'progress' },
    { outcome: 'progress', criteriaEvidence: [{ index: 0, status: 'met' }] },
  ];
  let decideCalls = 0;
  let execCalls = 0;

  const deps: AutonomyDeps = {
    perceive: async () => SNAP,
    policy: {
      decide: async () => {
        decideCalls++;
        return {
          action: decideCalls === 1 ? INSPECT_ACTION : clickAction('完成'),
          uncertain: false, degraded: false,
        };
      },
    },
    execute: async () => { return outcomes[execCalls++]; },
    goal: goal as unknown as Goal,
    onStep: rec => { onStepRecords.push(rec); },
    sleep: async () => {},
    now: () => 2,
  };

  const res = await runAutonomousLoop(deps);

  assert.equal(res.phase, 'achieved');
  assert.equal(res.steps, 2);
  assert.equal(onStepRecords.length, res.steps);
  assert.deepEqual(onStepRecords.map(r => r.stepIndex), [0, 1]);
  assert.equal(onStepRecords[0], res.trajectory[0], '通知的必须是轨迹里的同一个对象');
  assert.equal(onStepRecords[1], res.trajectory[1]);
  assert.equal(res.trajectory[1].action.kind, 'click');
});

// ─── Φ-4-i wait 沉降 ───

test('Φ-4-i: wait 沉降 —— 走注入 sleep（缺省 300 / settleMs 覆盖），no_effect 步入轨迹', async () => {
  /** wait 用例的依赖铸造器：第一步 wait，第二步点击并报判据 met */
  const makeWaitDeps = (collect: {
    sleepArgs: number[];
    checks: Array<{ goalText?: string; consecutiveNoEffect: number; stepsTaken: number }>;
  }): AutonomyDeps => {
    const goal = new StubGoal(makeSpec({ goal: '等待列表加载', successCriteria: ['列表加载完成'] }));
    let decideCalls = 0;
    const deps: AutonomyDeps = {
      perceive: async () => SNAP,
      policy: {
        decide: async () => {
          decideCalls++;
          return {
            action: decideCalls === 1 ? WAIT_ACTION : clickAction('列表第一项'),
            uncertain: false, degraded: false,
          };
        },
      },
      execute: async () => ({ outcome: 'progress', criteriaEvidence: [{ index: 0, status: 'met' }] }),
      goal: goal as unknown as Goal,
      constitution: {
        check: (a, ctx) => {
          collect.checks.push({
            goalText: ctx.goalText,
            consecutiveNoEffect: ctx.consecutiveNoEffect,
            stepsTaken: ctx.stepsTaken,
          });
          return { allowed: true, riskTier: a.riskTier, requiresApproval: false, reason: '测试放行' };
        },
      },
      sleep: async (ms: number) => { collect.sleepArgs.push(ms); },
      now: () => 1,
    };
    return deps;
  };

  // 第一轮：缺省沉降 300ms
  const collect1 = { sleepArgs: [] as number[], checks: [] as Array<{ goalText?: string; consecutiveNoEffect: number; stepsTaken: number }> };
  const res1 = await runAutonomousLoop(makeWaitDeps(collect1));

  assert.equal(res1.phase, 'achieved');
  assert.equal(res1.steps, 2, 'wait 步 + 点击步');
  assert.deepEqual(collect1.sleepArgs, [300], 'wait 走注入 sleep，缺省 300ms，零真睡');
  assert.equal(res1.trajectory[0].action.kind, 'wait');
  assert.equal(res1.trajectory[0].outcome, 'no_effect');
  assert.equal(res1.trajectory[1].action.kind, 'click');
  // 宪法上下文：wait 步之后 consecutiveNoEffect 递增为 1
  assert.equal(collect1.checks.length, 2);
  assert.equal(collect1.checks[0].consecutiveNoEffect, 0);
  assert.equal(collect1.checks[1].consecutiveNoEffect, 1, 'wait 的 no_effect 步必须计入连败计数');
  assert.equal(collect1.checks[1].stepsTaken, 1);
  assert.equal(collect1.checks[1].goalText, '等待列表加载');

  // 第二轮：opts.settleMs=77 覆盖缺省
  const collect2 = { sleepArgs: [] as number[], checks: [] as Array<{ goalText?: string; consecutiveNoEffect: number; stepsTaken: number }> };
  const res2 = await runAutonomousLoop(makeWaitDeps(collect2), { settleMs: 77 });

  assert.deepEqual(collect2.sleepArgs, [77]);
  assert.equal(res2.phase, 'achieved');
  assert.equal(res2.steps, 2);
});

// ─── Φ-4-j 保险丝零步角 ───

test('Φ-4-j: 保险丝零步角 —— maxSteps=0 ⇒ 立即 aborted，感知零调用', async () => {
  const goal = new StubGoal(makeSpec());
  let perceiveCalls = 0;

  const deps: AutonomyDeps = {
    perceive: async () => { perceiveCalls++; return SNAP; },
    policy: { decide: async () => ({ action: INSPECT_ACTION, uncertain: false, degraded: false }) },
    execute: async () => ({ outcome: 'progress' }),
    goal: goal as unknown as Goal,
    sleep: async () => {},
    now: () => 0,
  };

  const res = await runAutonomousLoop(deps, { maxSteps: 0 });

  assert.equal(res.phase, 'aborted');
  assert.equal(res.steps, 0);
  assert.equal(perceiveCalls, 0);
  assert.deepEqual(res.trajectory, []);
  assert.equal(goal.began, true, '开环 begin 先于保险丝');
  assert.match(res.summary, /aborted/);
});

// ─── Φ-4-k 预置阻塞零执行（纪元 Δ：环顶终局相位预判） ───

test('Φ-4-k: 预置 blocker 的目标机 —— 环顶相位预判拦截，零感知零判断零执行（旧律会漏发一个真动作）', async () => {
  const goal = new StubGoal(makeSpec());
  goal.progress.blockers.push('目标机预置阻塞：等待人工放行');
  let perceiveCalls = 0;
  let decideCalls = 0;
  let execCalls = 0;
  let onStepCalls = 0;

  const deps: AutonomyDeps = {
    perceive: async () => { perceiveCalls++; return SNAP; },
    policy: {
      decide: async () => { decideCalls++; return { action: clickAction('任意目标'), uncertain: false, degraded: false }; },
    },
    execute: async () => { execCalls++; return { outcome: 'progress' }; },
    goal: goal as unknown as Goal,
    onStep: () => { onStepCalls++; },
    sleep: async () => {},
    now: () => 1,
  };

  const res = await runAutonomousLoop(deps);

  assert.equal(res.phase, 'blocked', '终局相取目标机 evaluate');
  assert.equal(res.steps, 0, '零步入轨迹');
  assert.deepEqual(res.trajectory, []);
  assert.equal(perceiveCalls, 0, '环顶先判相位：感知不被触碰');
  assert.equal(decideCalls, 0, '策略不被咨询');
  assert.equal(execCalls, 0, '世界动作零执行 —— blocked-at-begin 不再漏发一个真实动作');
  assert.equal(onStepCalls, 0);
  assert.equal(goal.tickCount, 0);
  assert.equal(res.escalated, false, '阻塞是终局不是升级');
  assert.equal(res.escalateReason, undefined);
  assert.match(res.summary, /blocked/);
  assert.match(res.summary, /目标机预置阻塞/);
});

test('Φ-4-k: 反例 —— clearBlockers 后同一目标机照常执行（预判只拦终局相，不误伤康复路径）', async () => {
  const goal = new StubGoal(makeSpec({ successCriteria: ['完成标志可见'] }));
  goal.progress.blockers.push('临时阻塞');
  goal.clearBlockers();

  const deps: AutonomyDeps = {
    perceive: async () => SNAP,
    policy: { decide: async () => ({ action: INSPECT_ACTION, uncertain: false, degraded: false }) },
    execute: async () => ({ outcome: 'progress', criteriaEvidence: [{ index: 0, status: 'met' }] }),
    goal: goal as unknown as Goal,
    sleep: async () => {},
    now: () => 1,
  };

  const res = await runAutonomousLoop(deps);
  assert.equal(res.phase, 'achieved');
  assert.equal(res.steps, 1, '无阻塞时环顶预判放行，正常走一轮执行');
});

// ─── Φ-4-l 宪法判决分层盖章（纪元 Δ：effectiveRiskTier 回写轨迹） ───

test('Φ-4-l: executed 步入轨迹时盖 effectiveRiskTier 章（宪法判决分层）；Stub 判垃圾分层 ⇒ 视为缺席', async () => {
  const goal = new StubGoal(makeSpec({ successCriteria: ['完成标志可见'] }));

  // 宪法判 destructive 但放行不审批（Stub 自定法律）：动作申报却是 benign —— 盖章值必须以判决为准
  const deps: AutonomyDeps = {
    perceive: async () => SNAP,
    policy: { decide: async () => ({ action: clickAction('看起来无害的按钮'), uncertain: false, degraded: false }) },
    execute: async () => ({ outcome: 'progress', criteriaEvidence: [{ index: 0, status: 'met' }] }),
    goal: goal as unknown as Goal,
    constitution: {
      check: a => ({
        allowed: true, riskTier: 'destructive', requiresApproval: false,
        reason: `测试盖章：申报 ${String(a.riskTier)} 判决 destructive`,
      }),
    },
    sleep: async () => {},
    now: () => 1,
  };

  const res = await runAutonomousLoop(deps);
  assert.equal(res.steps, 1);
  assert.equal(res.trajectory[0].action.riskTier, 'benign', '动作申报分层保持原样');
  assert.equal(res.trajectory[0].effectiveRiskTier, 'destructive', '轨迹步带上宪法判决分层');

  // 垃圾判决分层（非三值）⇒ 不盖章（undefined），审计回退 action.riskTier
  const junk = new StubGoal(makeSpec({ successCriteria: ['完成标志可见'] }));
  const junkDeps: AutonomyDeps = {
    ...deps,
    goal: junk as unknown as Goal,
    constitution: {
      check: () => ({
        allowed: true, riskTier: '超高' as never, requiresApproval: false, reason: '垃圾判决',
      }),
    },
  };
  const junkRes = await runAutonomousLoop(junkDeps);
  assert.equal(junkRes.steps, 1);
  assert.equal(junkRes.trajectory[0].effectiveRiskTier, undefined, '非三值判决分层视为缺席');
});
