// test/w5steer.test.ts
// W5-5（steer/岔路收官闭环）三缝测试 —— 全离线确定性（假时钟零真睡、sharp
// 渐变假世界 + 剧本键鼠、GLM 环境键清空）：
//   缝1（B 应答回灌重启通道）：B 应答 ⇒ restart 重启指引（锚点摘要 + resume
//      语义）+ 会话修订判据账（drainAmendments 一次性移交）；runPilotLoop 重入
//      消费 —— 修订判据 replay 进新 run 的目标机（同 goal 匹配 / 跨 goal 防御）；
//      C 应答 blocked 收场闭环验证；
//   缝2（岔路账支点锚 journal 面）：branchAnchor 端口供应 → ③¼ 落账锚 →
//      铸卡锚 → applyBranchChoice verifyAnchor 强校验；runPilotLoop 注入真实
//      journal 读数（journalLength/chainTip 与卡锚逐一对应）；
//   缝3（steer(k) 换支消费）：parseBranchAnswer 解析 / 会话持卡换支（偏置 +
//      预算执法面）/ driveLoop ③¼ 经 withSteerBias 注入 / runPilotLoop 重入
//      消费偏置（全链：铸卡注入会话 → 应答换支 → 重入带偏置落账）；
//   三缝缺省零回归：无会话 / 无卡 / 无应答 / 端口缺席 ⇒ 逐字节旧路
//      （no-pending 提示原文、meta 键缺席、PilotResult 分毫不动）；
//   垃圾容错：支号越界 re-ask / 非换支形 no-pending / 待答题目优先（A/B/C
//      单字符语义不被岔路模式劫持）。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '../src/config.ts';
import { resetGlmClient } from '../src/vlm/index.ts';
import { system } from '../src/system.ts';
import { journal } from '../src/journal.ts';
import { resetApproval } from '../src/approval.ts';
import {
  runAutonomousLoop, GoalStateMachine, PilotStore,
  activeSteerSession, lastBranchCard, resetW4PilotWire,
  type GoalSpec, type PolicyAction, type WorldSnapshot, type PilotResult,
  type BranchLedgerWirePort, type AutonomyDeps,
} from '../src/autonomy/index.ts';
import {
  createSteerSession, createSteerAnswerTool, parseBranchAnswer,
  type SteerBiasStepper,
} from '../src/tools/steerTools.ts';
import {
  BranchLedgerBook, generateBranchCard, applyBranchChoice,
  BRANCH_REPLAY_BUDGET_STEPS,
  type BranchCard, type BranchStepMeta,
} from '../src/branchCards.ts';
import { runPilotLoop, type AutonomousRunDeps } from '../src/tools/autonomousRun.ts';
import type { ScoringContext } from '../src/autonomy/counterfactual.ts';
import { default as sharp } from 'sharp';

// ─── 环境卫兵：GLM 全键清空 + 单例重置（PolicyEngine 咨询臂零网络） ───

const ENV_KEYS = ['GLM_API_KEY', 'ZHIPUAI_API_KEY', 'ZAI_API_KEY', 'GLM_BASE_URL', 'GLM_VLM_MODEL'] as const;
type EnvSnapshot = Array<readonly [string, string | undefined]>;
function snapshotEnv(): EnvSnapshot {
  return ENV_KEYS.map(k => [k, process.env[k]] as const);
}
function clearEnvKeys(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}
function restoreEnv(snap: EnvSnapshot): void {
  for (const [k, v] of snap) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

// ─── 假件工坊（轻量环 + 会话语料） ───

/** 假时钟：测试里没有一毫秒是「真」的 */
function mkClock(t0: number): () => number {
  let t = t0;
  return () => t;
}
/** 步进假时钟（runPilotLoop 级 —— 与 kernel.selfverify 同法） */
function fakeClock(): () => number {
  let t = 1_000;
  return () => (t += 50);
}

/** 会话级语料（w3drift 同源事实）：英文锚点 × 中文屏幕零词重合 ⇒ sem≈1 */
const DRIFT_SPEC = {
  goal: 'open notepad and type hello',
  successCriteria: ['notepad window visible', 'hello typed'],
};
const DRIFTED_SCREEN = '购物车 结算 优惠券 立即支付';

/** 会话级目标机便捷铸造 */
function mkGoal(): GoalStateMachine {
  const m = new GoalStateMachine({ ...DRIFT_SPEC, maxSteps: 24 }, mkClock(1000));
  m.begin();
  return m;
}

/** 无关语料的世界快照（轻量环 —— 与中文目标零词面交叠 ⇒ 漂移必超阈） */
function unrelatedSnapshot(): WorldSnapshot {
  return {
    takenAt: 1,
    width: 1920,
    height: 1080,
    dhash: 'ff00ff00ff00ff00',
    elements: [],
    textDigest: 'quarterly fruit basket invoice redux newsletter signup modal',
    popups: [],
    focusedRegion: null,
    sceneLabel: '',
    degraded: [],
  };
}

/** wait 动作（不落世界 —— 轻量环控制组跑到步保险丝） */
const WAIT_ACTION: PolicyAction = {
  kind: 'wait',
  rationale: '测试桩：静止一拍',
  expectedEffect: '世界自行变化',
  utility: 0.1,
  riskTier: 'benign',
};

/** 轻量闭环依赖（感知恒返无关屏 / 策略恒 wait / 执行 no_effect） */
function lightDeps(goal: GoalStateMachine): AutonomyDeps {
  return {
    perceive: async () => unrelatedSnapshot(),
    policy: { decide: async () => ({ action: WAIT_ACTION, uncertain: false, degraded: false }) },
    execute: async () => ({ outcome: 'no_effect' as const }),
    goal,
    now: () => 1_700_000_000_000,
    sleep: async () => {},
  };
}

/** 岔路卡测试桩：三候选（签名可定制）+ 支点锚（journal 面） */
function mkCard(sig1 = 'click:确认', sig2 = 'scroll:', sig3 = 'type:备注'): BranchCard {
  const cand = (rank: number, signature: string): BranchCard['candidates'][number] =>
    ({
      rank,
      signature,
      action: {
        kind: 'wait', rationale: `测试桩候选 ${rank}`, expectedEffect: '世界自行变化',
        utility: 0.5 - rank * 0.1, riskTier: 'benign',
      },
      predictedEffects: ['测试桩效果'],
      progressProbability: 0.5, informationGain: 0.3, risk: 0.05,
      utility: 0.4 - rank * 0.1, steered: false, wasChosen: rank === 1,
      attribution: { rootCause: 'unknown', hypothesis: '', recoveryLadder: [], probeTrail: [], degraded: false },
    });
  return {
    cardVersion: 1,
    createdAt: 42,
    goalPhase: 'aborted',
    goalReason: '测试桩：步数保险丝',
    pivot: { stepIndex: 2, recordedAt: 41, anchor: { journalLength: 5, chainTip: 'tip-w5' } },
    candidates: [cand(1, sig1), cand(2, sig2), cand(3, sig3)],
  };
}

/** 工具执行面便捷转换（与 w3drift 同律） */
type Exec = (args: unknown) => Promise<string>;
function exec(t: unknown): Exec {
  return (t as unknown as { execute: (a: unknown) => Promise<string> }).execute.bind(t);
}

/** 记账桩：捕获 record 的三参（options / ctx / meta） */
interface RecCall { options: PolicyAction[]; ctx: ScoringContext; meta?: BranchStepMeta }
function recStub(): { port: BranchLedgerWirePort; calls: RecCall[] } {
  const calls: RecCall[] = [];
  return {
    calls,
    port: {
      record: (options, ctx, meta) => {
        calls.push({ options, ctx, meta });
        return null;
      },
      generateCard: () => null,
    },
  };
}

// 全局隔离：文件级 beforeEach/afterEach 清零跨测试单例（日志/审批/接线持有者）
beforeEach(() => {
  journal.reset();
  journal.configure(true, '', 1000);
  resetApproval();
  resetW4PilotWire();
});
afterEach(() => {
  journal.reset();
  resetApproval();
  resetW4PilotWire();
});

// ─── 缝3（解析）：parseBranchAnswer 纯函数 ───

test('W5-5 解析: "2"/"B2"/"b3"/全角前缀/首尾空白 ⇒ k；垃圾一律 null（绝不猜）', () => {
  assert.equal(parseBranchAnswer('2'), 2);
  assert.equal(parseBranchAnswer('B2'), 2);
  assert.equal(parseBranchAnswer('b3'), 3);
  assert.equal(parseBranchAnswer('Ｂ1'), 1, '全角大写 B 归一');
  assert.equal(parseBranchAnswer('  2  '), 2, '首尾空白剥除');
  assert.equal(parseBranchAnswer('12'), 12, '两位支号照收（值域执法在 applyBranchChoice）');
  for (const bad of ['', '   ', 'B', 'b', '继续吧', 'B2x', 'xB2', '0', '00', '2.5', 42, null, undefined]) {
    assert.equal(parseBranchAnswer(bad), null, `垃圾应答 ${JSON.stringify(bad)} ⇒ null`);
  }
});

// ─── 缝3（会话级）：持卡换支 / 越界重问 / 垃圾容错 / 待答优先 / 无卡零回归 ───

test('W5-5 缝3: 无卡零回归 —— 无待答题且无卡时应答走原 no-pending 路径（提示原文逐字节一致）', () => {
  const s = createSteerSession({ goal: mkGoal(), screenText: () => DRIFTED_SCREEN });
  const expected = '当前没有待答的 steer 问题（未超阈 / 节流中 / 指纹缺席）';
  for (const raw of ['2', 'B2', '继续吧', 'A']) {
    const r = s.answer(raw);
    assert.equal(r.status, 'no-pending', `无卡时 ${JSON.stringify(raw)} ⇒ 原 no-pending`);
    assert.equal(r.hint, expected, '提示原文与 W3-5 逐字节一致（零回归红律）');
  }
});

test('W5-5 缝3: 持卡换支 —— "2" ⇒ status branch + 重放指引（支点/偏置/预算）+ 偏置执法面就绪', () => {
  const s = createSteerSession({ goal: mkGoal(), screenText: () => DRIFTED_SCREEN });
  const card = mkCard('click:确认', 'scroll:', 'type:备注');
  s.holdBranchCard!(card);
  assert.notEqual(s.branchCard!(), null, '持有面可回读');
  const r = s.answer('2');
  assert.equal(r.status, 'branch');
  assert.equal(r.branch!.kind, 'branch-replay');
  assert.equal(r.branch!.k, 2);
  assert.equal(r.branch!.chosen.signature, 'scroll:', '选中第 2 候选');
  assert.deepEqual(r.branch!.bias.preferredActionKeys, ['scroll:']);
  assert.equal(r.branch!.pivot.anchor.journalLength, 5, '支点锚随指引');
  assert.equal(r.branch!.budget_steps, BRANCH_REPLAY_BUDGET_STEPS, '预算 = 重放缺省 12 步');
  assert.match(r.branch!.note, /autonomous_run/, '指引建议重入通道');
  assert.match(r.hint!, /换支/, 'hint 如实申报');

  // 偏置执法面：takeBranchBias 一次性移交；预算 12 步执法、超支诚实终止
  const stepper = s.takeBranchBias!();
  assert.notEqual(stepper, null);
  assert.equal(stepper!.state().status, 'armed', '武装未动');
  for (let i = 0; i < BRANCH_REPLAY_BUDGET_STEPS; i++) {
    const b = stepper!.step();
    assert.notEqual(b, null, `第 ${i + 1} 步预算内放行`);
    assert.deepEqual(b!.preferredActionKeys, ['scroll:']);
  }
  assert.equal(stepper!.step(), null, '第 13 步超支 ⇒ null（不悄悄续命）');
  assert.equal(stepper!.state().status, 'exhausted', '超支是终局事实');
  stepper!.complete();
  assert.equal(stepper!.state().status, 'exhausted', '超支后 complete 不改判');
  assert.equal(s.takeBranchBias!(), null, 'takeBranchBias 一次性（再取 ⇒ null）');

  // 换支后可再换（重新武装合法）：应答 B3 换到第 3 候选
  const r2 = s.answer('B3');
  assert.equal(r2.status, 'branch');
  assert.equal(r2.branch!.k, 3);
  assert.deepEqual(r2.branch!.bias.preferredActionKeys, ['type:备注']);
});

test('W5-5 缝3: 越界支号 re-ask（合法域提示）/ 非换支形垃圾 no-pending（持卡语境引导）', () => {
  const s = createSteerSession({ goal: mkGoal(), screenText: () => DRIFTED_SCREEN });
  s.holdBranchCard!(mkCard());
  const out = s.answer('9');
  assert.equal(out.status, 're-ask', '越界支号 ⇒ 重问');
  assert.match(out.hint!, /岔路换支未生效/);
  assert.match(out.hint!, /1\.\.3/, '合法域如实提示');
  const garbage = s.answer('继续吧');
  assert.equal(garbage.status, 'no-pending', '非换支形应答不误入岔路模式');
  assert.match(garbage.hint!, /岔路卡/, '持卡语境提示可用通道');
  // 坏卡防御：holdBranchCard(null) 清除 ⇒ 回到无卡原路径
  s.holdBranchCard!(null);
  assert.equal(s.branchCard!(), null);
  const cleared = s.answer('2');
  assert.equal(cleared.status, 'no-pending');
  assert.equal(cleared.hint, '当前没有待答的 steer 问题（未超阈 / 节流中 / 指纹缺席）');
});

test('W5-5 缺省: 待答题目优先于岔路模式 —— "B2" 在有题时按原垃圾重问路径（A/B/C 语义不被劫持）', () => {
  const s = createSteerSession({ goal: mkGoal(), screenText: () => DRIFTED_SCREEN });
  const q = s.maybeCheckAndAsk(3, null);
  assert.notEqual(q, null, '漂移超阈出题');
  s.holdBranchCard!(mkCard()); // 有题同时持卡
  const r = s.answer('B2');
  assert.equal(r.status, 're-ask', '待答题 ⇒ parseSteerAnswer 原路径（B2 非单字符）');
  assert.deepEqual(r.question, q, '原题回显');
  assert.match(r.hint!, /单个字符/);
  assert.notEqual(s.pending(), null, '待答题不清');
  // "2" 在有题时是 B 的别名（既有语义）—— 写回判据而非换支
  const b = s.answer('2');
  assert.equal(b.status, 'answered');
  assert.equal(b.choice, 'B', '有题时 "2" ⇒ B（W3-5 别名表优先）');
  assert.equal(b.applied, true);
});

// ─── 缝1（会话/工具级）：B 应答 restart 指引 + 修订判据账 ───

test('W5-5 缝1: B 应答 ⇒ restart 重启指引（锚点摘要 + resume 语义）+ drainAmendments 一次性账', () => {
  const goal = mkGoal();
  const s = createSteerSession({ goal, screenText: () => DRIFTED_SCREEN });
  const q = s.maybeCheckAndAsk(3, null)!;
  const r = s.answer('B');
  assert.equal(r.applied, true);
  assert.equal(r.restart!.kind, 'steer-restart');
  assert.equal(r.restart!.amended.index, q.amendment.criterion_index);
  assert.equal(r.restart!.amended.to, q.amendment.to, '指引携带修订后判据');
  const anchor = r.restart!.goal_anchor as { criteria?: { met: number; total: number } };
  assert.equal(anchor.criteria?.total, 2, '修订后锚点摘要（判据总数）');
  assert.equal(anchor.criteria?.met, 0, '修正即新主张 —— 全部未核');
  assert.match(r.restart!.resume, /autonomous_run/, 'resume 语义建议重入通道');
  assert.match(r.restart!.resume, /autonomy_resume/);

  const h1 = s.drainAmendments!();
  assert.equal(h1.length, 1, '写回生效即入会话账');
  assert.equal(h1[0]!.goalText, DRIFT_SPEC.goal, '账携带出题时 goal 原文（跨 run 匹配防御）');
  assert.equal(h1[0]!.amendment.to, q.amendment.to);
  assert.deepEqual(s.drainAmendments!(), [], 'drain 一次性（再取为空）');
});

test('W5-5 缝1: steer_answer 工具返回链 —— B 应答 JSON 载荷携带结构化 restart 字段', async () => {
  const s = createSteerSession({ goal: mkGoal(), screenText: () => DRIFTED_SCREEN });
  assert.notEqual(s.maybeCheckAndAsk(3, null), null, '漂移超阈出题（应答有题可结算）');
  const raw = await exec(createSteerAnswerTool(s))({ answer: 'B' });
  const parsed = JSON.parse(raw) as {
    status: string; applied: boolean;
    amendment: { to: string };
    restart?: { kind: string; amended: { to: string }; goal_anchor: Record<string, unknown>; resume: string };
  };
  assert.equal(parsed.status, 'answered');
  assert.equal(parsed.applied, true);
  assert.equal(parsed.restart!.kind, 'steer-restart', '工具面结构化直达模型');
  assert.equal(parsed.restart!.amended.to, parsed.amendment.to);
  assert.match(parsed.restart!.resume, /autonomous_run/);
});

// ─── 缝2（driveLoop 级）：支点锚 journal 面供应 + 铸卡锚强校验 ───

test('W5-5 缝2: branchAnchor 端口 ⇒ ③¼ 落账锚（journalLength/chainTip）；缺席/故障/垃圾 ⇒ 键缺席（零回归）', async () => {
  const base = lightDeps(new GoalStateMachine({
    goal: '打开记事本并输入会议纪要', successCriteria: ['会议纪要已输入'], maxSteps: 2,
  }));
  // 在场向：桩端口供应的步账位置原样落锚
  const stub = recStub();
  await runAutonomousLoop(
    { ...base, branchLedger: stub.port, branchAnchor: () => ({ journalLength: 7, chainTip: 'tip-w5' }) },
    { maxSteps: 2 },
  );
  assert.equal(stub.calls.length, 2);
  for (const c of stub.calls) {
    assert.equal(c.meta?.journalLength, 7, 'journalLength 随账落锚');
    assert.equal(c.meta?.chainTip, 'tip-w5', 'chainTip 随账落锚');
  }
  assert.deepEqual(stub.calls.map(c => c.meta?.stepIndex), [0, 1], '既有 stepIndex 语义不动');

  // 缺席向：无端口 ⇒ 键缺席（与 W4-0 接线时逐字节同 meta 形状）
  const absent = recStub();
  await runAutonomousLoop({ ...lightDeps(new GoalStateMachine({
    goal: '打开记事本并输入会议纪要', successCriteria: ['会议纪要已输入'], maxSteps: 2,
  })), branchLedger: absent.port }, { maxSteps: 2 });
  for (const c of absent.calls) {
    assert.equal('journalLength' in (c.meta ?? {}), false, '端口缺席 ⇒ 锚键缺席');
    assert.equal('chainTip' in (c.meta ?? {}), false, '端口缺席 ⇒ 锚键缺席');
    assert.equal(c.meta?.stepIndex !== undefined, true, 'stepIndex 照旧在场');
  }

  // 故障向：端口抛异常 ⇒ 键缺席不炸环
  const boom = recStub();
  const r1 = await runAutonomousLoop({ ...lightDeps(new GoalStateMachine({
    goal: '打开记事本并输入会议纪要', successCriteria: ['会议纪要已输入'], maxSteps: 2,
  })), branchLedger: boom.port, branchAnchor: (): never => { throw new Error('anchor port boom'); } }, { maxSteps: 2 });
  assert.equal(r1.phase, 'aborted', '端口故障绝不炸环（照常跑完）');
  for (const c of boom.calls) assert.equal('journalLength' in (c.meta ?? {}), false);

  // 垃圾向：非数 journalLength / 非串 chainTip ⇒ 逐项过滤键缺席
  const dirty = recStub();
  await runAutonomousLoop({ ...lightDeps(new GoalStateMachine({
    goal: '打开记事本并输入会议纪要', successCriteria: ['会议纪要已输入'], maxSteps: 2,
  })), branchLedger: dirty.port, branchAnchor: () => ({ journalLength: 'x' as unknown as number, chainTip: 42 as unknown as string }) }, { maxSteps: 2 });
  for (const c of dirty.calls) {
    assert.equal('journalLength' in (c.meta ?? {}), false, '脏值不落锚');
    assert.equal('chainTip' in (c.meta ?? {}), false);
  }
});

test('W5-5 缝2: 铸卡锚真实可校验 —— 账锚 ⇒ 卡锚 ⇒ applyBranchChoice verifyAnchor 强校验两向', () => {
  // 纯账面链：record 落锚（journal 面）→ generateBranchCard 支点携带同一锚
  const book = new BranchLedgerBook({ now: () => 1234 });
  const ctx: ScoringContext = { goalKeywords: ['打开'], snapshot: unrelatedSnapshot(), triedActionKeys: [] };
  book.record([WAIT_ACTION], ctx, { stepIndex: 4, journalLength: 9, chainTip: 'tip-abc' });
  const card = generateBranchCard(book, { phase: 'failed', reason: '判据违反', now: () => 2000 });
  assert.notEqual(card, null);
  assert.equal(card!.pivot.stepIndex, 4);
  assert.equal(card!.pivot.anchor.journalLength, 9, '卡锚 = 落账锚（journal 面）');
  assert.equal(card!.pivot.anchor.chainTip, 'tip-abc');
  // 强校验通过向：与卡锚一致的当前步账 ⇒ 换支放行
  const ok = applyBranchChoice(card, 1, { verifyAnchor: { journalLength: 9, chainTip: 'tip-abc' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.restore!.note, '支点锚校验通过（checkpoint 步账一致）');
  // 强校验拒绝向：世界已漂移（链尖前移）⇒ 诚实拒绝换支
  const drift = applyBranchChoice(card, 1, { verifyAnchor: { journalLength: 10, chainTip: 'tip-next' } });
  assert.equal(drift.ok, false);
  assert.match(drift.error!, /anchor mismatch/);
});

// ─── 缝3（driveLoop 级）：换支偏置注入 withSteerBias + 预算执法 ───

test('W5-5 缝3: steerBias 步进面 ⇒ ③¼ 评分上下文带 preferredActionKeys（预算内注入/超支摘除/缺席零回归）', async () => {
  const mkBias = (budget: number, calls: { n: number }): SteerBiasStepper => ({
    step: () => (calls.n++ < budget ? { preferredActionKeys: ['wait:'] } : null),
    state: () => ({ status: 'stepping', stepsUsed: Math.min(calls.n, budget), budgetSteps: budget }),
    complete: () => { /* 测试桩 */ },
  });

  // 预算 1：首步带偏置、次步超支摘除
  const one = recStub();
  const calls1 = { n: 0 };
  await runAutonomousLoop({ ...lightDeps(new GoalStateMachine({
    goal: '打开记事本并输入会议纪要', successCriteria: ['会议纪要已输入'], maxSteps: 2,
  })), branchLedger: one.port, steerBias: mkBias(1, calls1) }, { maxSteps: 2 });
  assert.equal(one.calls.length, 2);
  assert.deepEqual(one.calls[0]!.ctx.preferredActionKeys, ['wait:'], '预算内：偏置铸入评分上下文');
  assert.equal(one.calls[1]!.ctx.preferredActionKeys, undefined, '超支：偏置摘除（原路继续）');

  // 缺席向：无 steerBias ⇒ ctx 无 preferredActionKeys 键（逐字节旧路）
  const none = recStub();
  await runAutonomousLoop({ ...lightDeps(new GoalStateMachine({
    goal: '打开记事本并输入会议纪要', successCriteria: ['会议纪要已输入'], maxSteps: 2,
  })), branchLedger: none.port }, { maxSteps: 2 });
  for (const c of none.calls) assert.equal('preferredActionKeys' in c.ctx, false);

  // 故障向：step() 抛异常 ⇒ 无偏置不炸环
  const boom = recStub();
  const r = await runAutonomousLoop({ ...lightDeps(new GoalStateMachine({
    goal: '打开记事本并输入会议纪要', successCriteria: ['会议纪要已输入'], maxSteps: 2,
  })), branchLedger: boom.port, steerBias: {
    step: (): never => { throw new Error('bias boom'); },
    state: () => ({ status: 'armed', stepsUsed: 0, budgetSteps: 1 }),
    complete: () => { /* 测试桩 */ },
  } }, { maxSteps: 2 });
  assert.equal(r.phase, 'aborted', '偏置步进故障绝不炸环');
  for (const c of boom.calls) assert.equal('preferredActionKeys' in c.ctx, false);
});

test('W5-5 缺省: 换支偏置不改 PilotResult —— 有偏置与无偏置两跑的核心字段逐字节一致', async () => {
  const runOnce = async (bias?: SteerBiasStepper): Promise<PilotResult> => {
    const stub = recStub();
    const r = await runAutonomousLoop({ ...lightDeps(new GoalStateMachine({
      goal: '打开记事本并输入会议纪要', successCriteria: ['会议纪要已输入'], maxSteps: 2,
    })), branchLedger: stub.port, ...(bias ? { steerBias: bias } : {}) }, { maxSteps: 2 });
    return r;
  };
  const plain = await runOnce();
  const biased = await runOnce({
    step: () => ({ preferredActionKeys: ['wait:'] }),
    state: () => ({ status: 'stepping', stepsUsed: 1, budgetSteps: 12 }),
    complete: () => { /* 测试桩 */ },
  });
  assert.equal(biased.phase, plain.phase);
  assert.equal(biased.steps, plain.steps);
  assert.equal(biased.escalated, plain.escalated);
  assert.equal(biased.summary, plain.summary, 'PilotResult 分毫不动（偏置只进岔路账评分面）');
  assert.equal(biased.trajectory.length, plain.trajectory.length);
});

// ─── runPilotLoop 级（全栈离线）：缝1 回灌消费 / 缝2 journal 面 / 缝3 全链 ───

// 渐变 PNG（kernel.selfverify 同法）
async function gradientPng(width: number, height: number, vertical: boolean): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = vertical ? Math.round((y * 255) / (height - 1)) : Math.round((x * 255) / (width - 1));
      const i = (y * width + x) * 3;
      data[i] = v; data[i + 1] = v; data[i + 2] = v;
    }
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

const PNG = await gradientPng(512, 384, false);
const WORDS_ALIGNED = [
  { label: '开门标记', bbox: { x0: 100, y0: 100, x1: 200, y1: 140 }, confidence: 0.9 },
  { label: '任务界面', bbox: { x0: 300, y0: 300, x1: 420, y1: 340 }, confidence: 0.8 },
];

/** 手写最小配置（enableEpistemicGate 关 —— 熵通道确定性关闭，steer 只走周期） */
function makeConfig(over: Partial<Config> = {}): Config {
  return {
    autonomyEnabled: true,
    autonomyMaxSteps: 24,
    autonomyTimeBudgetSec: 300,
    autonomyAllowTiers: 'benign',
    autonomyVlmWhenUncertain: false,
    autonomyForbiddenKeywords: '',
    autonomyTracePath: '',
    enableEpistemicGate: false,
    ...over,
  } as Config;
}

/** system 键鼠 monkey-patch（剧本键鼠：点击不落世界） */
function patchInertSystem(): () => void {
  const saved: Record<string, unknown> = {};
  const host = system as unknown as Record<string, unknown>;
  const over: Record<string, unknown> = {
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async () => { /* 剧本键鼠：点击不落世界 */ },
    scroll: async () => { /* 剧本键鼠：滚动不落世界 */ },
    typeText: async () => { throw new Error('本套用例不得键入'); },
    pressHotkey: async () => { throw new Error('本套用例不得按键'); },
  };
  for (const key of Object.keys(over)) {
    saved[key] = host[key];
    host[key] = over[key];
  }
  return () => { for (const key of Object.keys(over)) host[key] = saved[key]; };
}

/**
 * 直接驱动 runPilotLoop（绕过工具参数解析 —— goalMachine 引用留在测试手里，
 * 回灌断言可直接读判据账）。全栈离线：sharp 假截屏 + 剧本键鼠 + GLM 环境键清空。
 */
async function runPilot(args: {
  goal: string;
  criteria: string[];
  maxSteps?: number;
  configOver?: Partial<Config>;
  depsOver?: Record<string, unknown>;
}): Promise<{ goalMachine: GoalStateMachine; out: string }> {
  const savedEnv = snapshotEnv();
  const restoreSystem = patchInertSystem();
  try {
    clearEnvKeys();
    resetGlmClient();
    const spec: GoalSpec = {
      goal: args.goal,
      successCriteria: args.criteria,
      maxSteps: args.maxSteps ?? 2,
      timeBudgetSec: 300,
    };
    const now = fakeClock();
    const deps = {
      capture: async () => PNG,
      readWords: async () => WORDS_ALIGNED,
      groundVlm: async () => [],
      now,
      sleep: async () => { /* 零真睡 */ },
      ...(args.depsOver ?? {}),
    } as unknown as AutonomousRunDeps;
    const goalMachine = new GoalStateMachine(spec, now);
    const store = new PilotStore();
    const token = store.begin(spec, now());
    const out = await runPilotLoop({
      toolName: 'autonomous_run',
      config: makeConfig(args.configOver ?? {}),
      deps,
      spec,
      goalMachine,
      store,
      token,
    });
    return { goalMachine, out };
  } finally {
    restoreSystem();
    restoreEnv(savedEnv);
    resetGlmClient();
  }
}

const STEER_GOAL = '打开记事本并输入会议纪要';
const STEER_CRIT = '会议纪要已输入';

test('W5-5 缝1: 全链回灌 —— 出题升级 → B 应答（restart 指引）→ runPilotLoop 重入消费修订判据', async () => {
  // 第 1 环（轻量）：漂移出题 ⇒ steer-drift 升级，会话跨环存续
  const goal1 = new GoalStateMachine({ goal: STEER_GOAL, successCriteria: [STEER_CRIT], maxSteps: 6 }, mkClock(1000));
  const r1 = await runAutonomousLoop({ ...lightDeps(goal1), steer: { enabled: true } }, { maxSteps: 6 });
  assert.equal(r1.escalated, true);
  assert.equal(r1.escalateReason, 'steer-drift');
  const session = activeSteerSession();
  assert.notEqual(session, null, '在役会话登记（应答经工具对同一会话结算）');
  const ans = session!.answer('B');
  assert.equal(ans.applied, true, 'B 写回旧目标机（W3-5 既有面）');
  assert.equal(ans.restart!.kind, 'steer-restart', '重启指引随应答回流');

  // 第 2 环（全栈 runPilotLoop）：重入即消费 —— 修订判据 replay 进新目标机
  const { goalMachine: goal2 } = await runPilot({ goal: STEER_GOAL, criteria: [STEER_CRIT], maxSteps: 2 });
  const cs = goal2.progress.criteriaStatus[0]!;
  assert.equal(cs.criterion, ans.amendment!.to, '修订判据已回灌进本轮目标机（会话状态传递闭环）');
  assert.equal(cs.status, 'unverified', '修正即新主张');
  assert.equal(session!.drainAmendments!().length, 0, '账已被 runPilotLoop 一次性消费');
});

test('W5-5 缝1: 跨 goal 防御 —— 陈旧修订只属于出题时的目标，异 goal 重入不回灌（账仍消费）', async () => {
  const goal1 = new GoalStateMachine({ goal: STEER_GOAL, successCriteria: [STEER_CRIT], maxSteps: 6 }, mkClock(1000));
  await runAutonomousLoop({ ...lightDeps(goal1), steer: { enabled: true } }, { maxSteps: 6 });
  const session = activeSteerSession()!;
  const ans = session.answer('B');
  assert.equal(ans.applied, true);

  // 异 goal 重入：修订判据属于旧目标 —— 新目标判据保持原文
  const { goalMachine: other } = await runPilot({
    goal: '整理桌面文件夹', criteria: ['桌面已整理'], maxSteps: 2,
  });
  assert.equal(other.progress.criteriaStatus[0]!.criterion, '桌面已整理', '跨 goal ⇒ 不回灌（防御）');
  assert.equal(session.drainAmendments!().length, 0, '账一次性消费（陈旧修订不再滞留）');
});

test('W5-5 缝1: C 应答收场闭环 —— 出题升级 → C ⇒ 目标机 blocked（终局相收场语义）', async () => {
  const goal1 = new GoalStateMachine({ goal: STEER_GOAL, successCriteria: [STEER_CRIT], maxSteps: 6 }, mkClock(1000));
  await runAutonomousLoop({ ...lightDeps(goal1), steer: { enabled: true } }, { maxSteps: 6 });
  const session = activeSteerSession()!;
  const r = session.answer('C');
  assert.equal(r.status, 'answered');
  assert.equal(r.choice, 'C');
  assert.equal(goal1.evaluate().phase, 'blocked', 'C ⇒ blocked 终局相（收场路径闭环验证）');
  assert.match(r.hint!, /阻塞/);
});

test('W5-5 缝2: runPilotLoop 注入真实 journal 面 —— 落账锚 = journal.list(false).length + journal.tip', async () => {
  await journal.append({ ts: 1, tool: 'click_mouse', args: { x: 0.5 }, status: 'SUCCESS', effect_detected: true });
  await journal.append({ ts: 2, tool: 'scroll_page', args: { direction: 'down' }, status: 'SUCCESS', effect_detected: true });
  const expectedLen = journal.list(false).length;
  const expectedTip = journal.tip;

  const stub = recStub();
  await runPilot({
    goal: '开关门流程演示', criteria: ['开门标记', '关门标记'], maxSteps: 2,
    depsOver: { branchLedger: stub.port },
  });
  assert.ok(stub.calls.length >= 1, '岔路账照常落账（buildAutonomyStack 尊重 deps 显式注入）');
  for (const c of stub.calls) {
    assert.equal(c.meta?.journalLength, expectedLen, '锚 = 真实 journal 条数');
    assert.equal(c.meta?.chainTip, expectedTip, '锚 = 真实行动日志链尖');
  }
});

test('W5-5 缺省: 无会话无卡时 runPilotLoop 零 steer 注记 —— 达成锚点不带 [Steer] 段', async () => {
  resetW4PilotWire(); // 无在役会话：缝1/缝3 消费面全部空转
  const { out } = await runPilot({ goal: '开关门演示', criteria: ['开门标记'], maxSteps: 3 });
  const parsed = JSON.parse(out) as { status: string; state_anchor: Record<string, unknown> };
  assert.equal(parsed.status, 'SUCCESS', '单判据在场世界 ⇒ 达成（控制组）');
  const notes = (parsed.state_anchor.execution_notes as string[] | undefined) ?? [];
  assert.ok(
    notes.every(n => !n.startsWith('[Steer]')),
    `无会话/无卡 ⇒ 零 steer 注记（执行器自有注记照旧 —— 零回归）`,
  );
  assert.equal(parsed.state_anchor.escalate_reason, undefined);
});

test('W5-5 缝3: 全链换支 —— 失败铸卡注入会话 → 应答换支 → runPilotLoop 重入带偏置落账', async () => {
  // 真实岔路账 + 铸卡（journal 面锚）
  await journal.append({ ts: 1, tool: 'click_mouse', args: { x: 0.5 }, status: 'SUCCESS', effect_detected: true });
  const book = new BranchLedgerBook({ now: () => 1234 });
  const port: BranchLedgerWirePort = {
    record: (o, c, m) => book.record(o, c, m),
    generateCard: f => generateBranchCard(book, f),
  };

  // 第 1 环：steer 点亮（对齐世界不出题）+ 岔路账在场 → 步保险丝 aborted ⇒ 铸卡注入会话
  const run1 = await runPilot({
    goal: '开关门流程演示', criteria: ['开门标记', '关门标记'], maxSteps: 2,
    configOver: { autonomySteerEnabled: true },
    depsOver: { branchLedger: port },
  });
  assert.match(run1.out, /aborted/, '双判据缺一 ⇒ 步保险丝中止（失败终局相铸卡）');
  const session = activeSteerSession();
  assert.notEqual(session, null, 'steer 点亮 ⇒ 会话在场（卡的持有面）');
  const card = lastBranchCard();
  assert.notEqual(card, null, '失败终局相铸卡（W4-0 既有面）');
  assert.notEqual(session!.branchCard!(), null, 'W5-5：卡已同步注入在役会话（持有面）');
  // 卡锚 = 真实 journal 面（铸卡的锚真实可校验）
  assert.equal(card!.pivot.anchor.journalLength, journal.list(false).length, '卡锚 journalLength 对账');
  assert.equal(card!.pivot.anchor.chainTip, journal.tip, '卡锚 chainTip 对账');
  // 强校验：一致锚放行 / 漂移锚拒绝
  assert.equal(
    applyBranchChoice(card, 1, { verifyAnchor: { journalLength: card!.pivot.anchor.journalLength, chainTip: card!.pivot.anchor.chainTip } }).ok,
    true,
  );
  assert.equal(
    applyBranchChoice(card, 1, { verifyAnchor: { journalLength: 999, chainTip: 'drifted' } }).ok,
    false,
  );

  // 应答换支（单候选卡 ⇒ k=1 合法）：偏置执法面在会话武装
  const chosen = card!.candidates[0]!;
  const ans = session!.answer('1');
  assert.equal(ans.status, 'branch', '单键换支成立');
  assert.deepEqual(ans.branch!.bias.preferredActionKeys, [chosen.signature]);

  // 第 2 环：runPilotLoop 重入消费偏置 —— ③¼ 落账 ctx 带 preferredActionKeys
  const stub = recStub();
  await runPilot({
    goal: '开关门流程演示', criteria: ['开门标记', '关门标记'], maxSteps: 2,
    depsOver: { branchLedger: stub.port },
  });
  assert.ok(stub.calls.length >= 1, '重入环照常落账');
  assert.ok(
    stub.calls.every(c => Array.isArray(c.ctx.preferredActionKeys) &&
      c.ctx.preferredActionKeys.includes(chosen.signature)),
    '每步落账 ctx 均带换支偏置（withSteerBias 注入 —— 预算 12 步内）',
  );
  assert.equal(session!.takeBranchBias!(), null, '偏置已被 runPilotLoop 一次性取走消费');
});
