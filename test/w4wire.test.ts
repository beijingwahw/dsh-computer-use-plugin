// test/w4wire.test.ts
// W4-0（第3批集成接线包）单测：把第三批器官的接线面逐条验证「接通且受控」——
//   ① steer 工具注册可见（源级断言挂载门 —— tools 桶在 Node strip 装载器有已知
//      地雷且并行批次在途，epochR/vlm.integration/w3wire 源码正则先例；工具本体
//      行为由 w3drift.test.ts 覆盖）+ 环内出题 ⇒ steer-drift 升级提问（行为证明：
//      开关两向 —— 点亮出题升级、缺席零路径逐字节旧路）；
//   ② 探索注入开关（enableExploration 缺省 false ⇒ 端口缺席；true ⇒ 铸
//      ExplorationLedger 入栈且 advise 恢复态门执法 —— budget-low 红线绝不探索）；
//   ③ 岔路账消费（每步决策既定 record + 失败终局相 generateCard + lastBranchCard
//      出口；PilotResult 既有字段不动）；
//   ④ memoryOpsConverger 落位（睡眠第④幕校准旁挂 + 晨报 memoryOps 段 + 水位线
//      种子契约；生产表达式源级断言）；
//   ⑤ journal 实证字段往返（scale/intent/phashCorroborates 顶层入链，链校验
//      verify 仍绿 —— 哈希链语义零变更）；
//   ⑥ request_approval 暂存模式附带 stepCursor（journal 步账；缺省零暂存尝试）；
//   ⑦ 并行开关透传（orchestratorParallel 缺省 false + 生产透传表达式源级断言）。
// 全离线确定性：注入时钟零真睡、假 ctx/假策略/假执行器、无网络。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { journal } from '../src/journal.ts';
import { registerJournalGuard } from '../src/journal.ts';
import { Config as ConfigSchema, type Config } from '../src/config.ts';
// ②⑤⑥⑦ 的被测面
import { buildAutonomyStack, runAutonomousLoop, GoalStateMachine } from '../src/autonomy/index.ts';
import {
  activeSteerSession, lastBranchCard, resetW4PilotWire, type BranchLedgerWirePort,
} from '../src/autonomy/autoPilot.ts';
import type { BranchCard } from '../src/branchCards.ts';
import type { PolicyAction, WorldSnapshot } from '../src/autonomy/index.ts';
// ④ 的被测面（sleep 集成契约 + W2-6 交付 API）
import { runSleepCycle, resetSleepCycle } from '../src/sleep/index.ts';
import { convergeMemoryOps } from '../src/knowledge/memoryOps.ts';
// ⑥ 的被测面
import { createRequestApprovalTool } from '../src/tools/approvalTools.ts';
import { approvalQueue, resetApproval, setConfirmCodeChannel } from '../src/approval.ts';

// ─── 假件工坊 ───

/** 手写最小配置（缺字段按 falsy 缺省走零行为臂 —— w3wire 同法） */
function makeConfig(over: Partial<Config> = {}): Config {
  return {
    autonomyEnabled: true,
    autonomyMaxSteps: 24,
    autonomyAllowTiers: 'benign',
    ...(over as object),
  } as Config;
}

/** 无关语料的世界快照（与中文目标零词面交叠 ⇒ 语义距离 ≈ 1 —— 漂移必超阈） */
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

/** wait 动作（不落世界 —— 控制组跑到步保险丝） */
const WAIT_ACTION: PolicyAction = {
  kind: 'wait',
  rationale: '测试桩：静止一拍',
  expectedEffect: '世界自行变化',
  utility: 0.1,
  riskTier: 'benign',
};

/** 最小闭环依赖（感知恒返无关屏 / 策略恒 wait / 执行 no_effect） */
function loopDeps(goal: GoalStateMachine): Parameters<typeof runAutonomousLoop>[0] {
  return {
    perceive: async () => unrelatedSnapshot(),
    policy: { decide: async () => ({ action: WAIT_ACTION, uncertain: false, degraded: false }) },
    execute: async () => ({ outcome: 'no_effect' as const }),
    goal,
    now: () => 1_700_000_000_000,
    sleep: async () => {},
  };
}

// 全局隔离：文件级 beforeEach/afterEach 清零跨测试单例（日志/审批/睡眠/接线持有者）
beforeEach(() => {
  journal.reset();
  journal.configure(true, '', 1000);
  resetApproval();
  resetSleepCycle();
  resetW4PilotWire();
});
afterEach(() => {
  journal.reset();
  resetApproval();
  setConfirmCodeChannel(null);
  resetSleepCycle();
  resetW4PilotWire();
});

// ─── ① 接线 A + B①：steer 工具挂载门 + 环内出题升级 ───

test('W4-A: steer_choice/steer_answer 挂载门 —— autonomyEnabled 同门注册（源级断言）', () => {
  const src = readFileSync(new URL('../src/tools/index.ts', import.meta.url), 'utf8');
  // 桶文件引入 W3-5 工厂 + 在役会话转发面
  assert.match(src, /createSteerChoiceTool, createSteerAnswerTool/, '桶文件引入 steer 工厂');
  assert.match(src, /activeSteerSession/, '桶文件引入在役会话转发面');
  // W4-0 新块：与 autonomous_run 同门（autonomyEnabled）条件挂载
  assert.match(
    src,
    /if \(config\.autonomyEnabled\) \{\s*\r?\n\s*const w4SteerSession = w4ForwardingSteerSession\(\);\s*\r?\n\s*tools\.push\(createSteerChoiceTool\(w4SteerSession\), createSteerAnswerTool\(w4SteerSession\)\);/,
    'steer 工具必须与 autonomous_run 同门挂载（config.autonomyEnabled）',
  );
});

test('W4-B①: 环内漂移出题 ⇒ steer-drift 升级提问；端口缺席 ⇒ 零路径（开关两向）', async () => {
  // 点亮向：无关屏 + 未核判据 ⇒ 语义距离 ≈ 1 ⇒ drift 0.7 > 0.55 ⇒ 第 0 步出题升级
  const on = await runAutonomousLoop(
    { ...loopDeps(new GoalStateMachine({
      goal: '打开记事本并输入会议纪要',
      successCriteria: ['会议纪要已输入'],
      maxSteps: 6,
    })), steer: { enabled: true } },
    { maxSteps: 6 },
  );
  assert.equal(on.escalated, true, '出题 ⇒ 升级移交');
  assert.equal(on.escalateReason, 'steer-drift', '升级归因 = steer-drift（沿 escalate 拦截风格）');
  assert.equal(on.steps, 0, '被拦动作不入轨迹（第 0 步即升级）');
  assert.match(on.summary, /活意图漂移出题/, '题面进总汇报供模型转述');
  const session = activeSteerSession();
  assert.notEqual(session, null, '在役会话登记（steer_answer 工具对同一会话结算）');
  assert.notEqual(session?.pending(), null, '升级后题目挂起待答（跨环存续律）');

  // 关闭向：同依赖去掉 steer ⇒ 零路径 —— 跑到步保险丝 aborted，无升级
  resetW4PilotWire();
  const off = await runAutonomousLoop(
    loopDeps(new GoalStateMachine({
      goal: '打开记事本并输入会议纪要',
      successCriteria: ['会议纪要已输入'],
      maxSteps: 2,
    })),
    { maxSteps: 2 },
  );
  assert.equal(off.escalated, false, '端口缺席 ⇒ 无 steer 升级（零回归方向）');
  assert.equal(off.phase, 'aborted', '控制组跑到步保险丝');
  assert.equal(off.steps, 2, '控制组步数不受接线影响');
});

// ─── ② 接线 C：探索注入开关 ───

test('W4-C: enableExploration 缺省缺席零路径；true ⇒ 铸 ExplorationLedger 入栈 + 恢复态门执法', () => {
  const off = buildAutonomyStack(makeConfig({ enableExploration: false }), {});
  assert.equal(off.exploration, undefined, '缺省 false ⇒ 端口缺席（升级路径逐字节旧路）');

  const stack = buildAutonomyStack(makeConfig({ enableExploration: true }), {});
  const port = stack.exploration;
  assert.ok(port && typeof port.advise === 'function' && typeof port.observe === 'function', '端口两面齐备');
  assert.equal((port as { enabled?: boolean }).enabled, true, '总闸点亮');

  // 恢复态门执法：no-deterministic-action（所有已知路失败）⇒ 有建议（全局轮换候选）
  const advice = port.advise({
    goal: '填表',
    snapshot: null,
    history: [],
    escalateReason: 'no-deterministic-action',
  });
  assert.notEqual(advice, null, '恢复态 ⇒ 探索建议在场');
  assert.equal(advice!.action.riskTier, 'benign', '建议一律 benign（不越权）');
  // 红线：budget-low（收手时刻）绝不探索
  assert.equal(
    port.advise({ goal: '填表', snapshot: null, history: [], escalateReason: 'budget-low' }),
    null,
    '预算红线 ⇒ 绝不透支收手保护',
  );
  // 常态零触发：非恢复态不出手
  assert.equal(
    port.advise({ goal: '填表', snapshot: null, history: [], escalateReason: '?' }),
    null,
    '常态零触发红律',
  );
});

// ─── ③ 接线 B②：岔路账消费 ───

test('W4-B②: 岔路账消费 —— 每步决策既定 record、失败终局相 generateCard、卡片出口在册', async () => {
  const recCalls: Array<{ options: PolicyAction[]; stepIndex?: number; goalKeywords: unknown }> = [];
  let cardCalls = 0;
  const sentinel = { cardVersion: 1, createdAt: 1, goalPhase: 'aborted', goalReason: '', pivot: { stepIndex: 1, recordedAt: 1, anchor: { journalLength: 0, chainTip: '' } }, candidates: [] } as BranchCard;
  const port: BranchLedgerWirePort = {
    record: (options, ctx, meta) => {
      recCalls.push({ options, stepIndex: meta?.stepIndex, goalKeywords: ctx.goalKeywords });
      return null;
    },
    generateCard: failure => {
      cardCalls += 1;
      assert.equal(failure.phase, 'aborted', '只在失败终局相铸卡');
      return sentinel;
    },
  };

  const result = await runAutonomousLoop(
    { ...loopDeps(new GoalStateMachine({
      goal: '打开记事本',
      successCriteria: ['记事本出现'],
      maxSteps: 2,
    })), branchLedger: port },
    { maxSteps: 2 },
  );

  assert.equal(result.phase, 'aborted', '步保险丝收场');
  assert.equal(recCalls.length, 2, '每步决策既定各落一笔岔路账');
  assert.ok(recCalls.every(r => r.options.length === 1 && r.options[0].kind === 'wait'), '落账的是当步既定动作');
  assert.deepEqual(recCalls.map(r => r.stepIndex), [0, 1], '步号随账（meta.stepIndex）');
  assert.ok(Array.isArray(recCalls[0].goalKeywords) && recCalls[0].goalKeywords.length > 0, '评分上下文与 policyEngine 同方言（goalKeywords）');
  assert.equal(cardCalls, 1, '失败终局相恰铸一卡');
  assert.equal(lastBranchCard(), sentinel, '卡片经 lastBranchCard() 出口在册');
});

// ─── ④ 接线 D：memoryOpsConverger 落位 ───

test('W4-D: memoryOpsConverger 落位 —— 校准幕旁挂 + 晨报 memoryOps 段 + 种子契约', async () => {
  // 生产表达式源级断言（index.ts 卸载路径的接线证据 —— sleep 集成契约的落位面）
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(
    src,
    /memoryOpsConverger: \(\) => convergeMemoryOps\(\{ seed: journalWatermarkSeed\(\) \}\)/,
    '组合根按 sleep 集成契约投 convergeMemoryOps({ seed: <journal 水位线> })',
  );
  assert.match(src, /function journalWatermarkSeed/, '水位线种子源（条数:链尖前16）在册');

  // 行为证明：dep 在场 ⇒ 校准幕旁挂执行、晨报带 memoryOps 段、种子如实申报
  await journal.append({ ts: 1, tool: 'click_mouse', args: { x: 0.5 }, status: 'SUCCESS', effect_detected: true });
  const report = await runSleepCycle(
    {
      journal,
      conductor: { maybeTick: () => [] },
      memoryOpsConverger: () => convergeMemoryOps({ seed: 'w4-wire-seed' }),
      log: () => {},
    },
    { budgetMs: 1000, now: () => 1_700_000_000_000 },
  );
  const calibrate = report.acts.find(a => a.name === 'calibrate');
  assert.equal(calibrate?.status, 'ok', '校准幕照常完成（旁挂不炸幕）');
  assert.ok(report.memoryOps, '晨报顶层 memoryOps 段在场');
  assert.equal(report.memoryOps!.arms, 28, '28 臂（7 类 × 4 操作 —— 结构对账面）');
  assert.equal(report.memoryOps!.seed, 'w4-wire-seed', '种子如实申报（跨夜重放的钥匙）');
  assert.equal(report.memoryOps!.converged + report.memoryOps!.held, 28, '落值 + 按兵不动 = 全臂（无一臂既不落值也不持有）');
});

// ─── ⑤ 接线 E：journal 实证字段往返 ───

test('W4-E: scale/intent/phashCorroborates 顶层入链往返 —— 链校验仍绿（哈希语义零变更）', async () => {
  type PostHook = (exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>;
  let hook: PostHook | undefined; // 无初始化器 —— 跨闭包赋值不被 TS 收窄为 null
  const fakeCtx = {
    on: (ev: string, cb: PostHook) => {
      if (ev === 'tools/post-execute') hook = cb;
    },
  };
  registerJournalGuard(fakeCtx as never, makeConfig({ enableJournal: true }) as never);
  assert.ok(hook, '观察者挂载成功（假 ctx 捕获）');

  // 带 effect 锚点的动作行：三实证字段顶层直录
  await hook(
    { name: 'click_mouse', arguments: { x: 0.5, y: 0.5 } },
    { value: JSON.stringify({
      status: 'SUCCESS',
      state_anchor: { effect: {
        detected: true,
        scale: 'page-level',
        intent: { expected: 'toggle_on', satisfied: true, evidence: '物理规则命中：开关闭合' },
        phashCorroborates: true,
      } },
    }) },
    async () => 'passthrough',
  );
  let entries = journal.list(false);
  let e = entries[entries.length - 1];
  assert.equal(e.tool, 'click_mouse');
  assert.equal(e.effect_detected, true, '既有字段照旧');
  assert.equal(e.scale, 'page-level', 'W4-0：scale 顶层入链');
  assert.deepEqual(e.intent, { expected: 'toggle_on', satisfied: true, evidence: '物理规则命中：开关闭合' }, 'W4-0：intent 顶层入链');
  assert.equal(e.phashCorroborates, true, 'W4-0：phashCorroborates 顶层入链');
  assert.ok(typeof e.hash === 'string' && e.hash !== '', '链哈希在场');
  assert.equal(journal.verify().ok, true, '链校验仍绿（新字段在 canonical 载荷域内）');

  // 无 effect 锚点的动作行：三键不落（旧工具/验证关闭面零污染），链继续延伸
  await hook(
    { name: 'type_text', arguments: { text: 'hi' } },
    { value: JSON.stringify({ status: 'SUCCESS', state_anchor: { effect: 'verification-off' } }) },
    async () => 'passthrough',
  );
  entries = journal.list(false);
  e = entries[entries.length - 1];
  assert.equal(e.tool, 'type_text');
  assert.equal(e.scale, undefined, '无锚点 ⇒ 三键诚实缺席');
  assert.equal(e.intent, undefined);
  assert.equal(e.phashCorroborates, undefined);
  assert.equal(journal.verify().ok, true, '混合行链校验仍绿（哈希链语义零变更）');
});

// ─── ⑥ 接线 F：request_approval 暂存模式附带 stepCursor ───

test('W4-F: stage=true ⇒ 入暂存队列且携带 stepCursor = journal 步账；缺省零暂存尝试', async () => {
  setConfirmCodeChannel(() => true); // 带外通道在场（暂存资格的宿主信号）
  await journal.append({ ts: 1, tool: 'click_mouse', args: { x: 0.5 }, status: 'SUCCESS', effect_detected: true });
  const before = journal.list(false).length;
  assert.equal(before, 1, '前置：步账 1 条');

  const tool = createRequestApprovalTool(makeConfig({
    enableApprovalGate: true,
    approvalTokenTtlMs: 60_000,
    approvalMaxAttempts: 3,
  }));
  const exec = (tool as unknown as { execute: (a: unknown) => Promise<string> }).execute.bind(tool);

  // stage=true：立即入队 + stepCursor 附带（入队时步账 —— 续跑只重演此后的步骤）
  const out = JSON.parse(await exec({ description: 'click 发送 to submit the report', stage: true })) as {
    status: string;
    state_anchor: { staged?: { id?: string; step_cursor?: number; declined?: string } };
  };
  assert.equal(out.status, 'PENDING_USER_CONSENT', '铸造照常先行（暂存不跳过实时同意通道）');
  assert.equal(out.state_anchor.staged?.step_cursor, 1, 'stepCursor = journal.list(false).length 附带');
  const queue = approvalQueue.dumpQueue();
  assert.equal(queue.length, 1, '暂存队列恰一条');
  assert.equal(queue[0].stepCursor, 1, '队列条目携带 stepCursor（stageAction 签名字段）');
  assert.equal(queue[0].decision, undefined, '条目待批（裁决走晨报/adjudicate）');

  // 缺省（不携 stage）：零暂存尝试 —— 与接线前逐字节一致
  const out2 = JSON.parse(await exec({ description: 'click 保存 to archive the file' })) as {
    state_anchor: { staged?: unknown };
  };
  assert.equal(out2.state_anchor.staged, undefined, '缺省不暂存');
  assert.equal(approvalQueue.dumpQueue().length, 1, '队列不增（零暂存尝试）');
});

// ─── ⑦ 接线 G：并行开关透传 + 四新字段缺省 ───

test('W4-G: orchestratorParallel 缺省 false + 生产透传表达式；四新配置字段缺省落位', () => {
  const resolved = (ConfigSchema as unknown as (o: unknown) => Record<string, unknown>)({});
  assert.equal(resolved.orchestratorParallel, false, '并行开关缺省关（串行脊梁逐字节旧路）');
  assert.equal(resolved.enableExploration, false, '探索开关缺省关');
  assert.equal(resolved.explorationPersistPath, '', '探索持久化缺省空（纯内存）');
  assert.equal(resolved.autonomySteerEnabled, false, '环内漂移消费缺省关（零回归红律）');

  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(
    src,
    /\{ parallel: config\.orchestratorParallel === true \}/,
    'start_complex_task 把 config 透传为 RunOrchestratorOptions.parallel',
  );
});
