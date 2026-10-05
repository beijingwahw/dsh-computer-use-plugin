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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
// ① 的装配补线（W8-B4 破环）：steer 会话工厂改为晚绑定注册 —— steerTools 装载
// 即注册生产工厂；本文件不经 tools 桶，须显式装载否则 steer 端口点亮也无会话。
import '../src/tools/steerTools.ts';
// ②′（ΑΩ-R23）的被测面：铸栈共享账本的真实类型（exploration 桶不经 autonomy
// 桶转发 —— 同 w7e2e 直指桶文件）。
import { ExplorationLedger } from '../src/autonomy/exploration.ts';
// ⑧（ΝΩ-46 model-based 反事实）的被测面：Φ-9 评分内核的世界模型只读面接线。
import {
  scoreOptions, wireCounterfactualWorldModel, counterfactualWorldModelWired,
} from '../src/autonomy/counterfactual.ts';
import { prophecyWorldModel, quantizedScreenType } from '../src/prophecy/index.ts';

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

// ─── ②′ 接线 C（ΑΩ-R23）：铸栈共享账本的读盘缓存 ───

test('W4-C/ΑΩ-R23: 同路径两次铸栈 ⇒ 全档读盘恰一次（attach 共享实例）+ run 态归零 + 行为不变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'w4explore-r23-'));
  try {
    // 种子档：goal ''（铸栈账本 goal 恒 ''）、region 0 的 click 格 3 试 —— 首铸恢复的目标态
    const fileA = join(dir, 'exploration.json');
    writeFileSync(fileA, JSON.stringify({
      version: 1, goal: '',
      cells: [{ region: 0, modality: 'click', strategy: 'click#甲', tries: 3, successes: 1 }],
      regionTries: [{ region: 0, tries: 3 }], lastModality: null,
    }));
    // 铸栈①：首铸显式恢复一次 ⇒ 读盘发生、种子格在账
    const port1 = buildAutonomyStack(
      makeConfig({ enableExploration: true, explorationPersistPath: fileA }), {},
    ).exploration as ExplorationLedger;
    assert.ok(port1, '端口在场');
    assert.equal(port1.cellFor(0, 'click', 'click#甲')?.tries, 3, '首铸读盘恰一次 ⇒ 种子格在账');
    // 恢复态问路（行为与接线时一致）：no-deterministic-action ⇒ benign 建议 + run 预算 +1
    const advice1 = port1.advise({
      goal: '填表', snapshot: null, history: [], escalateReason: 'no-deterministic-action',
    });
    assert.notEqual(advice1, null, '恢复态 ⇒ 探索建议在场');
    assert.equal(advice1!.action.riskTier, 'benign', '建议一律 benign（不越权）');
    assert.equal(port1.snapshot().advisesThisRun, 1, 'run 预算记账');
    // 磁盘改档（读盘探针 —— 若第二次铸栈再读盘，region 5 的 99 试格会入账顶掉原档）
    writeFileSync(fileA, JSON.stringify({
      version: 1, goal: '',
      cells: [{ region: 5, modality: 'hotkey', strategy: 'hotkey#tab', tries: 99, successes: 0 }],
      regionTries: [{ region: 5, tries: 99 }], lastModality: null,
    }));
    // 铸栈②：同路径 ⇒ attach 共享实例 —— 零读盘（格账仍是首铸恢复的原档），run 态照常归零
    const port2 = buildAutonomyStack(
      makeConfig({ enableExploration: true, explorationPersistPath: fileA }), {},
    ).exploration as ExplorationLedger;
    assert.equal(port2, port1, '同路径两次铸栈 attach 同一共享账本实例');
    assert.equal(port2.snapshot().advisesThisRun, 0, 'run 级预算随每次铸栈归零');
    assert.equal(port2.cellFor(0, 'click', 'click#甲')?.tries, 3, '原档格仍在账（内存延续）');
    assert.equal(port2.cellFor(5, 'hotkey', 'hotkey#tab'), null, '磁盘改档未被读入 ⇒ 第二次铸栈零读盘');
    // 行为不变：attach 后恢复态问路照常在场、预算红线照常执法
    const advice2 = port2.advise({
      goal: '填表', snapshot: null, history: [], escalateReason: 'no-deterministic-action',
    });
    assert.notEqual(advice2, null, 'attach 后恢复态问路照常在场');
    assert.equal(
      port2.advise({ goal: '填表', snapshot: null, history: [], escalateReason: 'budget-low' }),
      null,
      '预算红线照常执法（绝不透支收手保护）',
    );
    // 缓存键含路径：换路 ⇒ 键失效重铸重读（fileB 种子格入账，旧路径格账不携带）
    const fileB = join(dir, 'exploration-b.json');
    writeFileSync(fileB, JSON.stringify({
      version: 1, goal: '',
      cells: [{ region: 7, modality: 'scroll', strategy: 'scroll#down', tries: 7, successes: 2 }],
      regionTries: [{ region: 7, tries: 7 }], lastModality: null,
    }));
    const port3 = buildAutonomyStack(
      makeConfig({ enableExploration: true, explorationPersistPath: fileB }), {},
    ).exploration as ExplorationLedger;
    assert.notEqual(port3, port1, '路径变化 ⇒ 缓存失效重铸新账本');
    assert.equal(port3.cellFor(7, 'scroll', 'scroll#down')?.tries, 7, '新路径首铸重新读盘');
    assert.equal(port3.cellFor(0, 'click', 'click#甲'), null, '新账本不携带旧路径格账');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  // ΤΕΛ-4 行为更新（D-G16③，见 C:\2\.survey\fix\T1-4.md）：start_complex_task 的
  // runOrchestrator opts 由单行字面量扩为多行 —— parallel 透传行之后追加了
  // planReady（沙箱栈链臂发射）条件展开。透传表达式本体分毫未动，锚从
  // 「单行 { parallel: ... }」改为钉透传表达式本身（不再钉排版形状）。
  assert.match(
    src,
    /parallel: config\.orchestratorParallel === true,/,
    'start_complex_task 把 config 透传为 RunOrchestratorOptions.parallel',
  );
});

// ─── ⑧ 接线 H（ΝΩ-46 model-based 反事实）：世界模型只读面进 Φ-9 评分内核 ───

test('ΝΩ-46: buildAutonomyStack 注入世界模型只读面 —— 开关同门两向、同源 prophecy 单例、行为证明', () => {
  try {
    // 关臂：enableProphecy=false ⇒ 不注入且清除旧接线（逐字节旧路径 —— 零回归红律）
    wireCounterfactualWorldModel(null); // 隔离前置（前面测试可能已接线）
    const off = buildAutonomyStack(makeConfig({ enableProphecy: false }), {});
    assert.equal(off.prophecy, undefined, '开关关闭 ⇒ prophecy 字段缺席');
    assert.equal(counterfactualWorldModelWired(), false, '开关关闭 ⇒ 只读面未接线');

    // 开臂（缺省 true）：注入；随后再铸 off 栈 ⇒ 清除（最新铸栈胜出）
    const on = buildAutonomyStack(makeConfig({}), {});
    assert.ok(on.prophecy, '缺省开 ⇒ 预言引擎在场');
    assert.equal(counterfactualWorldModelWired(), true, '缺省开 ⇒ 只读面接线在册');
    buildAutonomyStack(makeConfig({ enableProphecy: false }), {});
    assert.equal(counterfactualWorldModelWired(), false, 'off 栈后铸 ⇒ 清除旧接线（最新铸栈胜出）');

    // 行为证明：同一 (量化屏型 × click@00 格) 的转移分布经 prophecy 同源单例
    // observe 入表、经评分内核 predict 读出 —— progress 乘 (0.5 + 0.5·top.prob)。
    buildAutonomyStack(makeConfig({}), {}); // 最终态：接线在场
    const dhash = 'feedface00112233'; // 16 hex 闭环方言（量化 ⇒ feedface00110000）
    const fromType = quantizedScreenType(dhash);
    assert.equal(
      prophecyWorldModel.observe(fromType, 'click@00', 'screen-a', true).ok, true, '种子转移①入表',
    );
    assert.equal(
      prophecyWorldModel.observe(fromType, 'click@00', 'screen-b', true).ok, true, '种子转移②入表',
    );
    // 满重合 click（先验 1.0），落点 (240,135)/1920×1080 ⇒ click@00（量化格方言同 prophecy）
    const click: PolicyAction = {
      kind: 'click',
      target: {
        bbox: { x0: 230, y0: 125, x1: 250, y1: 145 },
        center: { x: 240, y: 135 },
        label: '甲乙丙丁',
      },
      rationale: 'ΝΩ-46 接线测试：满重合点击',
      expectedEffect: '甲乙丙丁被激活',
      utility: 0.5,
      riskTier: 'benign',
    };
    const s: WorldSnapshot = {
      ...unrelatedSnapshot(),
      dhash,
      elements: [{
        label: '甲乙丙丁', role: 'button',
        bbox: { x0: 230, y0: 125, x1: 250, y1: 145 },
        center: { x: 240, y: 135 }, confidence: 0.9, source: 'vlm', interactive: true,
      }],
    };
    const kw = ['甲乙', '丙丁']; // 2-gram 关键词（分词方言：中文连续段按 2-gram 切分 ⇒ 与标签满重合）
    // 接线在场（不带 ctx.worldModel —— 决策面调用点的真实形态）：top.prob=0.5 ⇒ ×0.75
    const wired = scoreOptions([click], { goalKeywords: kw, snapshot: s });
    assert.ok(wired);
    assert.ok(Math.abs(wired.chosen.progressProbability - 0.75) <= 1e-9, `接线 ⇒ progress 0.75（实得 ${wired.chosen.progressProbability}）`);
    // 对照：解线后同输入 ⇒ 中性 ×1.0（逐字节旧路）
    wireCounterfactualWorldModel(null);
    const unwired = scoreOptions([click], { goalKeywords: kw, snapshot: s });
    assert.ok(unwired);
    assert.equal(unwired.chosen.progressProbability, 1, '解线 ⇒ 中性旧值（零回归）');
  } finally {
    // 清场：模块默认解线 + prophecy 同源单例回空档（跨测试隔离）。restoreSnapshot
    // 是 InMemoryWorldModel 的面（WorldModel 契约接口无此法）—— 结构子集收窄读取。
    wireCounterfactualWorldModel(null);
    const restore = (prophecyWorldModel as unknown as { restoreSnapshot(s: unknown): { ok?: boolean } })
      .restoreSnapshot({ version: 1, types: [], transitions: [], typeCounter: 0, aliases: [] });
    assert.equal(restore.ok, true, '世界模型单例清档');
  }
});
