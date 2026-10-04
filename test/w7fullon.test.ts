// test/w7fullon.test.ts
// W7-3（全开压力测试）：五纪元的激活开关缺省全关、从未同开过 —— 本册把它们
// 全部点亮跑通，抓出默认关闭所隐藏的集成缺陷。全离线确定性（假钟零真睡、
// sharp 合成帧、注入桩零网络零键鼠）。
//
// ─── 开关盘点矩阵（DEBTS.md B 类 + config.ts 逐一清点；本册全部点亮） ───
//   家族一（自主环）  enableExploration / autonomySteerEnabled / autonomyW1Exec /
//                     autonomyW1FrameGate(perceptionGate) / enableEpistemicGate /
//                     enableSelfModel / enableProphecy / 岔路账(缺省注入) /
//                     visualDiff.incremental 内核键(观察槽)
//   家族二（编排）    orchestratorParallel / enableStepAuction(共享步池市场)
//   家族三（视觉）    somSparseBudget>0(内核键 som.sparseBudget) /
//                     visualDiff.incremental=1 / vlmCascade 双钥
//                     (ProviderPool cheap 档 + attachCascadeFace + 易场景因子)
//   家族四（安全）    enableReversibilityLanes / reversalEscrow.arm(全端口) /
//                     Τ 示范审计(consume ⇒ 注册表证据) / approval 全链
//   （未入本册：enableSleepCycle+dream 注入面、curriculum、kernelEvolution ——
//    D-B4/D-B3/D-B5 已登记为投喂面未接，w5dream/w4pcg 各自单开关执法，此处
//    不重复立法；全开冒烟矩阵以四族为界。）
//
// 纪律：绝不删除/跳过失败的开关组合凑绿；确属互斥的组合以显式互斥断言执法
// （开 A 时断言 B 被保守拒绝），见 D1（审批令牌 × 人道互斥）。
import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '../src/config.ts';
import { default as sharp } from 'sharp';

import { resetGlmClient } from '../src/vlm/index.ts';
import { kernelRegistry } from '../src/kernel/registry.ts';
import { journal } from '../src/journal.ts';
import { resetApproval, approval, setConfirmCodeChannel, type ConfirmCodeDelivery } from '../src/approval.ts';
import { reversalEscrow } from '../src/reversalEscrow.ts';
import { resetRollbackPlanner } from '../src/rollbackPlanner.ts';
import { failureMemory } from '../src/failureMemory.ts';
import { coordinator } from '../src/subAgent.ts';
import { system } from '../src/system.ts';
import {
  buildAutonomyStack, runAutonomousLoop, GoalStateMachine,
  activeSteerSession, lastBranchCard, resetW4PilotWire,
  type AutonomyDeps, type RuntimeDeps, type PolicyAction, type StepRecord,
} from '../src/autonomy/index.ts';
import { branchLedger, generateBranchCard, type BranchCard, type BranchStepMeta } from '../src/branchCards.ts';
// W8-B4 破环装配补线：steer 会话工厂改为晚绑定注册（steerTools 装载即注册）——
// 本文件不经 tools 桶，须显式装载否则 steer 端口点亮也无会话（出题断言会假红）。
import '../src/tools/steerTools.ts';
import type { ScoringContext } from '../src/autonomy/counterfactual.ts';
import { runOrchestrator, type PipelineTeam, type ActorFn } from '../src/orchestrator.ts';
import type { SubTask } from '../src/planner.ts';
import { createSemanticFromVlm, type SomMarkerSeed } from '../src/orchestration/visionAdapters.ts';
import { GlmClient, attachCascadeFace } from '../src/vlm/glmClient.ts';
import { ProviderPool } from '../src/vlm/providers/failover.ts';
import { VlmCascade, schemaValidator } from '../src/vlm/providers/cascade.ts';
import type { VisionProvider, VisionChatRequest, VisionChatResult, ProviderTier } from '../src/vlm/providers/types.ts';
import { createClickMouseTool, gateByReversibility } from '../src/tools/clickMouse.ts';
import { stopBackend } from '../src/physicalBackend.ts';
import type { ReversalPlan } from '../src/reversalEscrow.ts';

// ─── 环境卫兵：GLM 全键清空（PolicyEngine 咨询臂 / cascade 单例零网络） ───

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

// ─── 合成图工坊（sharp：真像素真编码 —— 叠加/差分可像素级断言） ───

/** 纯灰 PNG（确定性底图） */
async function solidPng(width: number, height: number, value = 128): Promise<Buffer> {
  return sharp(Buffer.alloc(width * height * 3, value), {
    raw: { width, height, channels: 3 },
  }).png().toBuffer();
}

/** 灰底 + 一个实心亮块（与底灰差 > 像素阈 ⇒ 增量账本可检的「小变化」） */
async function blockPng(
  width: number, height: number, base: number,
  block: { x: number; y: number; w: number; h: number; v: number },
): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3, base);
  for (let y = block.y; y < Math.min(height, block.y + block.h); y++) {
    for (let x = block.x; x < Math.min(width, block.x + block.w); x++) {
      const i = (y * width + x) * 3;
      raw[i] = block.v; raw[i + 1] = block.v; raw[i + 2] = block.v;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

// ─── 全开配置铸造器：一切缺省关的行为面开关全部点亮 ───

function makeAllOnConfig(over: Partial<Config> = {}): Config {
  return {
    // 自主环族
    autonomyEnabled: true,
    autonomyMaxSteps: 24,
    autonomyTimeBudgetSec: 300,
    autonomyAllowTiers: 'benign',
    autonomyVlmWhenUncertain: true,
    autonomyForbiddenKeywords: '',
    autonomyTracePath: '',
    enableEpistemicGate: true,
    enableSelfModel: true,
    selfModelMinEvidence: 8,
    selfModelHalfLifeH: 168,
    enableProphecy: true,
    autonomyW1Exec: true,
    autonomyW1FrameGate: true,
    autonomyW1GatePollIntervalMs: 1,
    autonomyW1GatePollMaxMs: 5,
    autonomyW1GateMaxConsecutiveSkips: 1,
    enableExploration: true,
    explorationPersistPath: '',
    autonomySteerEnabled: true,
    // 视觉族
    vlmZoomVerify: false,
    somSparseBudget: 2,
    // 安全族
    enableApprovalGate: true,
    dangerPatterns: 'send,发送,delete,删除,pay,支付',
    enableRiskGate: true,
    riskPatterns: '',
    enableNotarizationLock: true,
    notarySemanticHandshake: true,
    enableReversibilityLanes: true,
    enableStepAuction: true,
    orchestratorParallel: true,
    ...over,
  } as Config;
}

// ─── 全局隔离：跨测试单例逐用例归零 ───

/** W6R fail-closed：带外码采集 + 携码授予（无码 grant 已废除 —— 授予面一律走此助手） */
const oobSink: ConfirmCodeDelivery[] = [];
function armOob(): void {
  setConfirmCodeChannel(d => { oobSink.push({ ...d }); });
}
function grantOob(token: string): boolean {
  const hit = oobSink.find(d => d.token === token);
  return approval.grantDetailed(token, true, hit ? { confirmCode: hit.confirmCode } : {}).ok;
}

beforeEach(() => {
  journal.reset();
  journal.configure(true, '', 1000);
  resetApproval();
  reversalEscrow.reset();
  resetRollbackPlanner();
  resetW4PilotWire();
  failureMemory.reset();
  coordinator.reset();
  coordinator.configure(3, 10);
  kernelRegistry.reset();
});

afterEach(() => {
  attachCascadeFace(null);
  kernelRegistry.reset();
});

// 物理后端若被任何路径拉起（生产设计：服务存活到卸载），测试收尾显式关停，
// 免子进程占住事件循环（epochDelta.safety 同律）
after(async () => {
  await stopBackend();
});

// ═════════════════════════ 家族一：自主环 ═════════════════════════

/** 漂移语料（w5steer 同源事实）：英文锚点 × 中文屏幕零词重合 ⇒ sem≈1 ⇒ 漂移必超阈 */
const DRIFT_SPEC = { goal: 'open notepad and type hello', successCriteria: ['notepad window visible', 'hello typed'] };
const DRIFT_WORD = { label: '购物车 结算 优惠券 立即支付', bbox: { x0: 10, y0: 10, x1: 300, y1: 40 }, confidence: 0.9 };

/** 假时钟（恒定 —— 时间预算永不耗尽，durationMs 恒 0） */
const fixedClock = (): () => number => {
  let t = 1_000_000;
  return () => t;
};

/** 升级决策字面量（policy ⑦「所有已知路失败」方言 —— 探索拦截的触发面） */
function escalateDecision(): { action: PolicyAction; uncertain: boolean; degraded: boolean } {
  return {
    action: {
      kind: 'escalate',
      payload: { reason: 'no-deterministic-action' },
      rationale: '本地规则未命中且云脑未配置，升级上游',
      expectedEffect: '控制权移交上游',
      utility: 0.3,
      riskTier: 'benign',
    },
    uncertain: true,
    degraded: true,
  };
}

const WAIT_ACTION: PolicyAction = {
  kind: 'wait',
  rationale: '等待界面沉降',
  expectedEffect: '界面进入稳定态',
  utility: 0.2,
  riskTier: 'benign',
};

/** 记账桩：包裹真岔路账单例（协议保真），调用序全记账（断言事实源） */
function recordingBranch(): {
  port: AutonomyDeps['branchLedger'];
  records: Array<{ options: PolicyAction[]; ctx: ScoringContext; meta?: BranchStepMeta }>;
} {
  const records: Array<{ options: PolicyAction[]; ctx: ScoringContext; meta?: BranchStepMeta }> = [];
  return {
    records,
    port: {
      record: (options, ctx, meta) => {
        records.push({ options, ctx, meta });
        return branchLedger.record(options, ctx, meta);
      },
      generateCard: failure => generateBranchCard(branchLedger, failure),
    },
  };
}

test('W7-A1 铸栈冒烟: 全开配置 → buildAutonomyStack 端口清单逐一在场（增量观察槽随内核键点亮）', () => {
  const savedEnv = snapshotEnv();
  try {
    clearEnvKeys();
    resetGlmClient();
    kernelRegistry.register({
      key: 'visualDiff.incremental', organ: 'perception', defaultValue: 1, min: 0, max: 1,
      note: 'W7-3 测试注册（生产由宿主铸入）',
    });
    const deps: RuntimeDeps = { now: fixedClock(), sleep: async () => { /* 零真睡 */ } };
    const stack = buildAutonomyStack(makeAllOnConfig(), deps);
    // 家族一端口逐一断言（全开 ⇒ 无一缺席）
    assert.ok(typeof stack.perceive === 'function', 'perceive 在场');
    assert.ok(stack.policy && typeof stack.policy.decide === 'function', 'policy 在场');
    assert.ok(stack.constitution, 'constitution 在场');
    assert.ok(stack.epistemicGate, 'enableEpistemicGate=true ⇒ 认识论闸门在场');
    assert.ok(stack.selfModel, 'enableSelfModel=true ⇒ 自我模型在场');
    assert.ok(stack.prophecy, 'enableProphecy=true ⇒ 预言引擎在场');
    assert.ok(stack.exploration, 'enableExploration=true ⇒ 探索账本端口在场');
    assert.ok(stack.exploration?.enabled === true, '探索端口点亮');
    assert.ok(typeof stack.exploration?.advise === 'function', '探索 advise 面在场');
    assert.deepEqual(stack.steer, { enabled: true }, 'autonomySteerEnabled=true ⇒ steer 端口点亮');
    assert.ok(typeof stack.frameHash === 'function', 'autonomyW1FrameGate=true ⇒ 免看门控帧哈希端口在场');
    assert.ok(stack.perceptionGate, '门控配置随栈入环');
    assert.ok(stack.branchLedger && typeof stack.branchLedger.record === 'function', '岔路账缺省注入在场');
    assert.ok(deps.incrementalObserver, 'visualDiff.incremental=1 ⇒ 增量观察槽就地补挂');
    // 对照：内核键回 0 ⇒ 观察槽不补挂（总闸单向）
    kernelRegistry.set('visualDiff.incremental', 0);
    const deps2: RuntimeDeps = { now: fixedClock() };
    buildAutonomyStack(makeAllOnConfig(), deps2);
    assert.equal(deps2.incrementalObserver, undefined, '总闸回 0 ⇒ 观察槽缺席（零回归红律）');
  } finally {
    restoreEnv(savedEnv);
    resetGlmClient();
  }
});

test('W7-A2 全开闭环 I: 探索拦截 × steer 出题 × 岔路账同开 —— 漂移题在第 3 步插队，前三步已被探索接管', async () => {
  const savedEnv = snapshotEnv();
  try {
    clearEnvKeys();
    resetGlmClient();
    const PNG = await solidPng(320, 240);
    // readWords 剧本：前 3 次感知无文本（steer 指纹缺席不出题），第 4 次漂移文本进场
    let perceiveCalls = 0;
    const deps: RuntimeDeps & Partial<AutonomyDeps> = {
      capture: async () => PNG,
      readWords: async () => {
        perceiveCalls++;
        return perceiveCalls <= 3 ? [] : [DRIFT_WORD];
      },
      groundVlm: async () => [],
      now: fixedClock(),
      sleep: async () => { /* 零真睡 */ },
    };
    const stack = buildAutonomyStack(makeAllOnConfig(), deps);
    const branch = recordingBranch();
    const goal = new GoalStateMachine({ ...DRIFT_SPEC, maxSteps: 24 }, fixedClock());
    const result = await runAutonomousLoop({
      perceive: stack.perceive,
      policy: { decide: async () => escalateDecision() },
      constitution: stack.constitution,
      execute: async () => ({ outcome: 'no_effect' as const }),
      goal,
      exploration: stack.exploration,
      steer: stack.steer,
      branchLedger: branch.port,
      branchAnchor: () => ({ journalLength: journal.list(false).length, chainTip: journal.tip }),
      epistemicGate: stack.epistemicGate,
      selfModel: stack.selfModel,
      prophecy: stack.prophecy,
      frameHash: stack.frameHash,
      perceptionGate: stack.perceptionGate,
      now: deps.now,
      sleep: deps.sleep,
    }, { maxSteps: 12 });

    // steer 出题升级（第 3 步：3 % DRIFT_CHECK_INTERVAL_STEPS === 0 且漂移语料进场）
    assert.equal(result.escalated, true, '漂移出题 ⇒ 升级收场');
    assert.equal(result.escalateReason, 'steer-drift', '升级归因 = 活意图漂移');
    assert.equal(result.steps, 3, '第 3 步出题插队（前 3 步已被探索接管）');
    assert.ok(result.summary.includes('活意图漂移出题'), `总汇报须含题面（实得 ${result.summary}）`);
    assert.ok(result.summary.includes('W3-7 探索拦截：替代升级 3 次。'), '探索记账随行（3 次替代）');
    // 探索接管：前 3 步均为世界动作（非 escalate），journal 注记在案
    const kinds = result.trajectory.map(rec => rec.action.kind);
    assert.ok(kinds.slice(0, 3).every(k => k !== 'escalate'), `前 3 步须为探索动作（实得 ${kinds.join(',')}）`);
    for (let i = 0; i < 3; i++) {
      assert.ok(result.trajectory[i].note?.includes('W3-7 探索建议'), `第 ${i} 步须带探索注记`);
      assert.equal(result.trajectory[i].action.riskTier, 'benign', '探索建议一律 benign');
    }
    // 岔路账：3 个已决步全落账（含支点锚 journal 面）
    assert.equal(branch.records.length, 3, '每个既定决策一步落账');
    for (const r of branch.records) {
      assert.equal(r.meta?.journalLength, journal.list(false).length, '锚 = 真实 journal 条数');
      assert.equal(typeof r.meta?.chainTip, 'string', '锚 = 真实链尖');
    }
    // 在役 steer 会话跨环存续（应答经 steer_answer 对同一会话结算）
    const session = activeSteerSession();
    assert.ok(session, '会话登记进模块持有者');
    const pending = session!.pending();
    assert.ok(pending, '待答题目挂起');
    assert.ok(pending!.drift.score > 0.55, `漂移分超阈（实得 ${pending!.drift.score}）`);
    // B 应答闭环：修订判据写回目标机（全开下 steer 会话与真目标机的握手不因探索/岔路账同开而断）
    const ans = session!.answer('B');
    assert.equal(ans.status, 'answered');
    assert.equal(ans.applied, true, 'B 写回判据账');
  } finally {
    restoreEnv(savedEnv);
    resetGlmClient();
    resetW4PilotWire();
    failureMemory.reset();
  }
});

test('W7-A3 全开闭环 II: 门控值守 × 步保险丝铸卡 × 会话持卡 × 探索预算耗尽回归升级', async () => {
  const savedEnv = snapshotEnv();
  try {
    clearEnvKeys();
    resetGlmClient();
    kernelRegistry.register({
      key: 'visualDiff.incremental', organ: 'perception', defaultValue: 1, min: 0, max: 1,
      note: 'W7-3 测试注册（生产由宿主铸入）',
    });
    // W7-3 修复（测试自身错）：宪法卡死律（constitution.maxNoEffect 缺省 3）是先于
    // 本册两把被测保险丝的第三把 —— 第 1 段 4 步探索替换步、第 2 段 4 步 wait 步
    // 全为 no_effect，缺省阈值下卡死律在第 4 步抢先终局（escalateReason=
    // 'constitution-veto'，实跑复现），探索预算（4）与步保险丝（maxSteps=4）永远
    // 轮不到执法。经生产内核键（productionSpecs.ts 同键同区间 2..6）抬到上限 6，
    // 隔离出被测变量：预算耗尽回归 policy-escalate / 步保险丝熔断 aborted。卡死律
    // 自身由 autonomy.autonomyConstitution.test.ts 律⑤ 独立执法，此处不重复立法。
    kernelRegistry.register({
      key: 'constitution.maxNoEffect', organ: 'constitution', defaultValue: 6, min: 2, max: 6,
      note: 'W7-3 测试注册：抬到生产区间上限，隔离探索预算/步保险丝两把被测保险丝',
    });
    const PNG = await solidPng(320, 240);
    const deps: RuntimeDeps & Partial<AutonomyDeps> = {
      capture: async () => PNG, // 屏恒不变 ⇒ 值守门控可跳过重型感知
      readWords: async () => [], // 无文本 ⇒ steer 指纹缺席不出题（隔离变量）
      groundVlm: async () => [],
      now: fixedClock(),
      sleep: async () => { /* 零真睡 */ },
    };
    const stack = buildAutonomyStack(makeAllOnConfig(), deps);
    const branch = recordingBranch();

    // 第 1 段：policy 恒升级 ⇒ 探索预算 4 发全用完后回归 policy-escalate 终局
    const goal1 = new GoalStateMachine({ ...DRIFT_SPEC, maxSteps: 24 }, fixedClock());
    const r1 = await runAutonomousLoop({
      perceive: stack.perceive,
      policy: { decide: async () => escalateDecision() },
      constitution: stack.constitution,
      execute: async () => ({ outcome: 'no_effect' as const }),
      goal: goal1,
      exploration: stack.exploration,
      steer: stack.steer,
      branchLedger: branch.port,
      frameHash: stack.frameHash,
      perceptionGate: stack.perceptionGate,
      now: deps.now,
      sleep: deps.sleep,
    }, { maxSteps: 12 });
    assert.equal(r1.escalateReason, 'policy-escalate', '探索预算耗尽 ⇒ 回归升级终局');
    assert.equal(r1.steps, 5, '4 步探索 + 1 步升级');
    assert.ok(r1.summary.includes('W3-7 探索拦截：替代升级 4 次。'), '本 run 预算 4 发全用完（铸栈归零 run 预算）');
    const kinds1 = r1.trajectory.map(rec => rec.action.kind);
    assert.equal(kinds1[4], 'escalate', '第 5 步为升级步');
    assert.ok(kinds1.slice(0, 4).every(k => k !== 'escalate'), '前 4 步为探索动作');
    // 交替律在环内同样成立（连打防线）
    assert.ok(kinds1[0] !== kinds1[1] && kinds1[1] !== kinds1[2] && kinds1[2] !== kinds1[3],
      `模态序列 ${kinds1.slice(0, 4).join('→')} 出现连打`);

    // 第 2 段：policy 恒 wait（benign）⇒ 门控值守跳过重型感知；步保险丝 aborted ⇒ 铸卡注入会话
    resetW4PilotWire();
    const branch2 = recordingBranch();
    const goal2 = new GoalStateMachine({ ...DRIFT_SPEC, maxSteps: 24 }, fixedClock());
    const r2 = await runAutonomousLoop({
      perceive: stack.perceive,
      policy: { decide: async () => ({ action: WAIT_ACTION, uncertain: false, degraded: false }) },
      constitution: stack.constitution,
      execute: async () => { throw new Error('wait 不落世界'); },
      goal: goal2,
      exploration: stack.exploration,
      steer: stack.steer,
      branchLedger: branch2.port,
      branchAnchor: () => ({ journalLength: journal.list(false).length, chainTip: journal.tip }),
      frameHash: stack.frameHash,
      perceptionGate: stack.perceptionGate,
      now: deps.now,
      sleep: deps.sleep,
    }, { maxSteps: 4 });
    assert.equal(r2.phase, 'aborted', '步保险丝熔断');
    assert.ok(r2.summary.includes('免看门控：触发'), `门控值守记账须入总汇报（实得 ${r2.summary}）`);
    assert.ok(r2.trajectory.some(rec => rec.note?.includes('免看门控')), '步注记含门控跳过留痕');
    // 增量观察面：感知帧已入账（总闸开的观察槽被 perceive 写过）
    assert.ok(deps.incrementalObserver, '观察槽在场');
    assert.ok(deps.incrementalObserver!.current, '屏恒不变 ⇒ silent 判决仍入观察槽');
    assert.equal(deps.incrementalObserver!.current!.verdict.kind, 'silent', '同帧 ⇒ silent（无投递）');
    // 铸卡 + 会话持卡（岔路账 × steer 会话的 W5-5 缝3 在全开下闭环）
    const card: BranchCard | null = lastBranchCard();
    assert.ok(card, 'aborted 终局相铸岔路卡');
    assert.ok(card!.candidates.length >= 1, '候选来自真实落账（wait 步在册）');
    const session = activeSteerSession();
    assert.ok(session, 'steer 点亮 ⇒ 会话在场（卡的持有面）');
    assert.ok(session!.branchCard?.() != null, 'W5-5 缝3：卡已同步注入在役会话（换支通道不断头）');
  } finally {
    restoreEnv(savedEnv);
    resetGlmClient();
    resetW4PilotWire();
    failureMemory.reset();
  }
});

// ═════════════════════════ 家族二：编排 ═════════════════════════

/** 录制团队：包裹真 coordinator（协议保真），调用序全记账 */
interface TeamLog {
  spawns: string[][];
  claims: Array<{ id: string; ok: boolean }>;
  reports: string[];
  retires: string[];
}
function recordingTeam(log: TeamLog): PipelineTeam {
  return {
    spawn: specs => { const acc = coordinator.spawn(specs); log.spawns.push(acc.map(a => a.spec.id)); return acc; },
    claim: (id, subject, ttl) => { const r = coordinator.claim(id, subject, ttl); log.claims.push({ id, ok: r.ok }); return r; },
    post: (id, subject, finding, ttl) => coordinator.post(id, subject, finding, ttl),
    report: (id, findings, confidence, status) => { log.reports.push(id); return coordinator.report(id, findings, confidence, status); },
    abort: (id, reason) => coordinator.abort(id, reason),
    isActive: () => coordinator.isActive(),
    preseed: (id, hash) => coordinator.preseed(id, hash),
    retire: (...ids) => { log.retires.push(...ids); return coordinator.retire(...ids); },
  };
}

function chatOf(plan: unknown): () => Promise<string> {
  return async () => JSON.stringify(plan);
}

test('W7-B1 编排全开: parallel × stepAuction 同跑 —— 三宽波次 + 共享步池恰两轮拍卖（手算逐位对照）', async () => {
  // DAG：root → {x,y,z}（三宽就绪层，守限 3 恰一波全收）→ sink
  const PLAN: SubTask[] = [
    { id: 1, action: 'open-browser', deps: [] },
    { id: 2, action: 'alpha-x', deps: [1] },
    { id: 3, action: 'beta-y', deps: [1] },
    { id: 4, action: 'gamma-z', deps: [1] },
    { id: 5, action: 'merge-result', deps: [2, 3, 4] },
  ];
  // 拍卖证据端口（静态注入 —— 出生场景指纹冷启动在生产回退零证据，此处定数供手算）：
  // w3-2 {5,5}、w3-3 {3,5}、w3-4 零证据
  coordinator.enableStepAuction({
    port: {
      evidence: id =>
        id === 'w3-2' ? { successes: 5, attempts: 5 } :
        id === 'w3-3' ? { successes: 3, attempts: 5 } : null,
    },
  });
  const log: TeamLog = { spawns: [], claims: [], reports: [], retires: [] };
  let inFlight = 0;
  let peak = 0;
  const chargesByTask: Record<string, number> = { 'alpha-x': 10, 'beta-y': 10, 'gamma-z': 8 };
  const actor: ActorFn = async (task: string) => {
    // 生产接线（index.ts 5.5 onToolPost）的动作步扣费在此剧本化：波内代理在役时逐池扣费
    const n = chargesByTask[task] ?? 0;
    for (let i = 0; i < n; i++) coordinator.chargeStep('click_mouse');
    inFlight++;
    peak = Math.max(peak, inFlight);
    inFlight--;
    return `[SUCCESS] ok:${task}`;
  };
  const report = await runOrchestrator('w7-b1-parallel-auction', actor, chatOf(PLAN), undefined, {
    parallel: true,
    team: recordingTeam(log),
    observeSeed: () => null,
    serializeWrite: async fn => fn(),
  });
  // 报告契约与串行同构（拓扑序行序）
  assert.equal(report,
    'Task #1 (open-browser): [SUCCESS] ok:open-browser\n' +
    'Task #2 (alpha-x): [SUCCESS] ok:alpha-x\n' +
    'Task #3 (beta-y): [SUCCESS] ok:beta-y\n' +
    'Task #4 (gamma-z): [SUCCESS] ok:gamma-z\n' +
    'Task #5 (merge-result): [SUCCESS] ok:merge-result',
    '报告契约与串行逐字节同构');
  assert.deepEqual(log.spawns, [['w3-2', 'w3-3', 'w3-4']], '唯一多员层恰一波 spawn（守限 3 全收）');
  assert.deepEqual(log.claims.map(c => c.id), ['w3-2', 'w3-3', 'w3-4'], '黑板 claim 防重复协议');
  assert.deepEqual(log.reports, ['w3-2', 'w3-3', 'w3-4'], '代理 report 退场');
  assert.equal(peak, 1, '写互斥纪律：并发写为零');
  assert.equal(coordinator.roster().length, 0, '波次代理全部 retire 回收');
  // 拍卖池账面：spawn 携 3×10 入市；波内扣费 10+10+8=28（单员层无在役代理 ⇒ 直通不扣）
  const st = coordinator.auctionStatus();
  assert.equal(st.enabled, true);
  assert.equal(st.poolCharged, 28, '波内动作步全量入池扣费');
  assert.equal(st.poolRemaining, 2, '30 − 28 = 2（单员层直通不扣费）');
  const ledgerAuc = coordinator.auctionLedger();
  assert.equal(ledgerAuc.length, 3, 'genesis + 恰两轮拍卖（第 10/20 扣费步触发）');
  // 第 1 轮（第 10 扣费步 = w3-2 的第 10 步，三代理全在役）：
  //   基率 (5+3)/10 = 0.8；先验 = shrinkRate ⇒ [0.925, 0.675, 0.8]；出价同先验；
  //   quotaTotal = min(K=10, 池余 20) = 10 ⇒ 整数最大余数法 [4,3,3]（w4auction 手算例①）
  const r1 = ledgerAuc[1]!;
  assert.equal(r1.round, 1);
  assert.equal(r1.atStep, 10);
  assert.deepEqual(r1.agents.map(a => a.agentId), ['w3-2', 'w3-3', 'w3-4']);
  assert.deepEqual(r1.agents.map(a => a.prior), [0.925, 0.675, 0.8]);
  assert.deepEqual(r1.agents.map(a => a.quota), [4, 3, 3], '比例分配手算例 [4,3,3]');
  // 第 2 轮（第 20 扣费步 = w3-3 的第 10 步，w3-2 已 report 退役在册不在场）：
  //   基率 3/5 = 0.6；先验 [0.6, 0.6]；等出价 ⇒ [5,5]
  const r2 = ledgerAuc[2]!;
  assert.equal(r2.round, 2);
  assert.equal(r2.atStep, 20);
  assert.deepEqual(r2.agents.map(a => a.agentId), ['w3-3', 'w3-4'], '已 report 者不入下一轮（在役者竞标）');
  assert.deepEqual(r2.agents.map(a => a.bid), [0.6, 0.6]);
  assert.deepEqual(r2.agents.map(a => a.quota), [5, 5], '等出价平手按代理序分零头 ⇒ [5,5]');
});

test('W7-B2 编排全开: 容量分波 × 拍卖池跨波续账 —— 4 独立任务两波全量完成，池不漏不重', async () => {
  const PLAN: SubTask[] = [
    { id: 1, action: 'ind-a', deps: [] },
    { id: 2, action: 'ind-b', deps: [] },
    { id: 2.5 as unknown as number, action: 'ind-c', deps: [] },
    { id: 3, action: 'ind-d', deps: [] },
    { id: 4, action: 'tail', deps: [1, 2, 2.5 as unknown as number, 3] },
  ].map(t => ({ ...t, id: t.id })) as SubTask[];
  coordinator.enableStepAuction();
  const log: TeamLog = { spawns: [], claims: [], reports: [], retires: [] };
  const actor: ActorFn = async (task: string) => {
    if (task.startsWith('ind-')) {
      coordinator.chargeStep('click_mouse');
      coordinator.chargeStep('click_mouse');
    }
    return `[SUCCESS] ok:${task}`;
  };
  const report = await runOrchestrator('w7-b2-waves', actor, chatOf(PLAN), undefined, {
    parallel: true,
    team: recordingTeam(log),
    observeSeed: () => null,
  });
  assert.ok(!report.includes('[FAILED]'), '零失败');
  assert.equal((report.match(/Task #/g) ?? []).length, 5, '五任务全部完成（含 tail）');
  assert.deepEqual(log.spawns.map(s => s.length), [3, 1], '守限 3 ⇒ 两波（3+1）');
  // 池账：波一 3×10 + 波二 1×10 = 40 入市；波内扣费 4×2 = 8 ⇒ 余 32
  const st = coordinator.auctionStatus();
  assert.equal(st.poolCharged, 8, '每独立任务 2 步扣费');
  assert.equal(st.poolRemaining, 32, '跨波 spawn 续入池，已扣不重');
  assert.equal(coordinator.roster().length, 0, '两波代理全部回收');
  assert.equal(coordinator.auctionLedger().length, 1, '8 扣费未到 K=10 ⇒ 仅 genesis（无拍卖轮）');
});

// ═════════════════════════ 家族三：视觉 ═════════════════════════

/** 假脑（w2cascade 同款）：调用计数 + 可控回复 */
function fakeBrain(id: string, replyText: string, o: { tier?: ProviderTier } = {}) {
  let calls = 0;
  const model = `m-${id}`;
  const self: VisionProvider = {
    id,
    protocol: 'openai',
    model,
    configured: true,
    ...(o.tier !== undefined ? { tier: o.tier } : {}),
    get calls(): number { return calls; },
    async chat(_r: VisionChatRequest): Promise<VisionChatResult> {
      calls++;
      return { ok: true, text: replyText, latencyMs: 7, model, providerId: id };
    },
    async chatJson<T>(r: VisionChatRequest): Promise<{ ok: boolean; value?: T; error?: string; raw: string }> {
      const res = await self.chat(r);
      return { ok: true, value: res.text as T, raw: res.text };
    },
  } as unknown as VisionProvider & { calls: number };
  return self;
}

/** 假 fetch：计数并回成功响应（级联承接时永不抵达） */
function fakeFetch(): { fetchImpl: typeof fetch; calls: () => number } {
  let n = 0;
  const fetchImpl = (async (): Promise<Response> => {
    n++;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => n };
}

test('W7-C1 视觉全开: incremental × sparseSoM × vlmCascade 同跑感知管线 —— 帧入账/稀疏叠加进便宜臂/坐标闭环', async () => {
  const savedEnv = snapshotEnv();
  try {
    clearEnvKeys();
    resetGlmClient();
    // 三开关全开：增量总闸 + 稀疏 SoM 预算（内核键）+ Zoom 复核隔离关闭
    kernelRegistry.register({ key: 'visualDiff.incremental', organ: 'perception', defaultValue: 1, min: 0, max: 1, note: 'W7-3 测试注册' });
    kernelRegistry.register({ key: 'som.sparseBudget', organ: 'perception', defaultValue: 2, min: 0, max: 64, note: 'W7-3 测试注册' });
    kernelRegistry.register({ key: 'grounding.verifyZoom', organ: 'perception', defaultValue: 0, min: 0, max: 1, note: 'W7-3 测试注册' });

    const W = 240, H = 160;
    const frame1 = await solidPng(W, H);
    // W7-3 修复（测试自身错）：补丁分诊阈值是单帧脏面积 < patchDirtyPct（缺省 5%，
    // visualDiff「too big to patch」律）—— 遗产块 60×50/240×160 ≈ 7.8% ≥ 5% 必判
    // keyframe（非整帧重置的断言永远到不了）。缩到 40×25 = 1000/38400 ≈ 2.6%，
    // 落进补丁区间（0 < changedPct < 5）。
    const frame2 = await blockPng(W, H, 128, { x: 20, y: 20, w: 40, h: 25, v: 255 });
    const frames = [frame1, frame2];

    // ① 增量面：真 createPerceive（buildAutonomyStack 铸）逐帧入账 → 观察槽可读
    const deps: RuntimeDeps & Partial<AutonomyDeps> = {
      capture: async () => frames.shift() ?? frame2,
      readWords: async () => [],
      groundVlm: async () => [],
      now: fixedClock(),
      sleep: async () => {},
    };
    const stack = buildAutonomyStack(makeAllOnConfig(), deps);
    await stack.perceive();
    const v1 = deps.incrementalObserver!.current!;
    assert.equal(v1.verdict.kind, 'keyframe', '冷启动 ⇒ 关键帧');
    // W7-3 修复（测试自身错）：账本代数在收养关键帧时先自增再上报 —— 冷启动关键帧
    // 报 generation 1（w3incremental W3-2 同律契约 `assert.equal(v1.generation, 1)`；
    // visualDiff.adoptKeyframe 的 `this.generation += 1` 先行），遗产期望 0 记错起点。
    assert.equal(v1.verdict.generation, 1);
    await stack.perceive();
    const v2 = deps.incrementalObserver!.current!;
    assert.equal(v2.verdict.kind, 'patch', '局部亮块 ⇒ 脏矩形补丁（非整帧重置）');
    assert.ok(v2.verdict.patches.length >= 1, '补丁矩形在案');
    assert.ok(v2.verdict.changedPct > 0 && v2.verdict.changedPct < 5, `小变化占比落在补丁区间（实得 ${v2.verdict.changedPct}）`);
    assert.equal(v2.verdict.generation, 1, '补丁不升代（与关键帧同代）');
    assert.equal(v2.delivery, null, '附件服务缺席 ⇒ 投递诚实降级 null');

    // ② 级联面：真 ProviderPool（主力+cheap 档）+ 真 VlmCascade 经 attachCascadeFace 接进真 GlmClient
    const { fetchImpl, calls: fetchCalls } = fakeFetch();
    const client = new GlmClient({ apiKey: 'k', model: 'm', fetchImpl });
    const primary = fakeBrain('glm-pro', JSON.stringify({
      elements: [{ id: 'p1', label: 'primary-answer', role: 'button', bbox: [10, 10, 60, 60], confidence: 0.9 }],
    }));
    const cheap = fakeBrain('glm-flash', JSON.stringify({
      elements: [
        { id: 'x1', label: '设置', role: 'button', bbox: [20, 20, 90, 80], confidence: 0.9 },
        { id: 'x2', label: '取消', role: 'button', bbox: [120, 30, 180, 90], confidence: 0.9 },
      ],
    }), { tier: 'cheap' });
    const cascade = new VlmCascade(new ProviderPool([primary, cheap]), {
      validators: [schemaValidator({ elements: 'array' })],
      factors: () => ({ confidence: 0.95, risk: 'low' as const, sceneFamiliar: true }),
    });
    attachCascadeFace({ consultJson: r => cascade.runJson(r) });

    // ③ 稀疏 SoM 面：4 种子（预算 2 ⇒ Top-2）进 L3 适配器 —— 叠加图替换原图进编码
    const seeds: SomMarkerSeed[] = [
      { bbox: { x0: 10, y0: 10, x1: 50, y1: 40 }, text: '甲', probeConfidence: 0.9 },
      { bbox: { x0: 60, y0: 10, x1: 100, y1: 40 }, text: '乙', probeConfidence: 0.5 },
      { bbox: { x0: 110, y0: 10, x1: 150, y1: 40 }, text: '丙', probeConfidence: 0.3 },
      { bbox: { x0: 160, y0: 10, x1: 200, y1: 40 }, text: '丁', probeConfidence: 0.1 },
    ];
    const src = createSemanticFromVlm({
      capture: async () => frame2,
      screenSize: async () => ({ width: W, height: H }),
      client,
      somMarkers: async () => seeds,
    });
    const els = await src.ground({ id: 'g0x0', x: 0, y: 0, width: 1, height: 1 }, '打开设置');
    assert.equal(els.length, 2, 'grounding 照常产出（叠加不改变元素面）');
    // 坐标闭环：元素矩形 = 假脑 bbox ÷ 屏幕尺寸（原图系基准，叠加零平移）
    const e0 = els[0]!;
    assert.ok(Math.abs(e0.rect.x - 20 / W) < 1e-9 && Math.abs(e0.rect.y - 20 / H) < 1e-9, '归一化坐标闭环（x0/y0）');
    assert.ok(Math.abs(e0.rect.width - 70 / W) < 1e-9, '归一化坐标闭环（宽）');
    // 级联承接：便宜臂过 schema 校验直采，主力零调用，单例零 fetch
    assert.equal((cheap as unknown as { calls: number }).calls, 1, '便宜脑恰一调');
    assert.equal((primary as unknown as { calls: number }).calls, 0, '主力零调用（省钱事件）');
    assert.equal(fetchCalls(), 0, '单例自身零 fetch');
    assert.equal(cascade.stats.cheapHit, 1);
    assert.equal(cascade.stats.escalated, 0);
    // 稀疏叠加事件：预算 2 生效、Top-2 选中（高置信者）
    const somLog = src.somEventLog();
    assert.equal(somLog.length, 1);
    assert.equal(somLog[0]!.applied, true);
    assert.equal(somLog[0]!.budget, 2, '内核键 som.sparseBudget=2 生效');
    assert.equal(somLog[0]!.elementsIn, 4, '4 种子参与分派');
    assert.equal(somLog[0]!.selected?.length, 2, 'Top-2 稀疏选中');
    assert.notEqual(somLog[0]!.sparseFallback, true, '双通道证据在场 ⇒ 不回退全量');
    // 叠加图真的进了便宜脑（decode 请求图 → Top-1 标签芯片像素非背景灰）
    const sent = (cheap as unknown as { chat(r: VisionChatRequest): Promise<VisionChatResult> });
    void sent;
    // （像素级取证：经 cascade 池的请求携带 base64 —— 由 cheap brain 侧记录）
    // —— 以事件账 + 级联台账 + 坐标闭环为断言面（w5somcall ② 已像素级执法叠加本身）
  } finally {
    attachCascadeFace(null);
    restoreEnv(savedEnv);
    resetGlmClient();
  }
});

// ═════════════════════════ 家族四：安全 ═════════════════════════

/** 假 system（epochDelta 同款）：物理派发计数器 = 断言事实源 */
const systemOriginals = {
  getScreenSize: system.getScreenSize.bind(system),
  clickMouse: system.clickMouse.bind(system),
  captureScreen: (system as unknown as { captureScreen?: unknown }).captureScreen,
};
let clickCount = 0;
function installFakeSystem(): void {
  clickCount = 0;
  system.getScreenSize = async () => ({ width: 1920, height: 1080 });
  system.clickMouse = async () => { clickCount++; };
}
function restoreSystem(): void {
  system.getScreenSize = systemOriginals.getScreenSize;
  system.clickMouse = systemOriginals.clickMouse;
}

/** 全开安全配置（闸门全开 + 验证可控）。
 *  W6R：verifyActions=false 已不再单独构成危险令牌旁路 —— 本家族聚焦分道/
 *  托管/补偿链路，显式插入逃生门（两把钥匙齐备）保持「派发即消费」旧方言；
 *  W7-D3 以 verifyActions=true 覆盖，同时锁定「单钥匙（仅逃生门）不关验证」
 *  的双钥匙语义（验证照跑、retry-allowed 方言不变）。 */
function safetyConfig(over: Partial<Config> = {}): Config {
  return makeAllOnConfig({
    verifyActions: false,
    allowUnverifiedDangerous: true,
    dryRun: false,
    enableInteractivityProbe: false,
    intentVerify: false,
    enableOcr: false,
    autoRemember: false,
    adaptiveSettle: false,
    actionSettleMs: 1,
    noopSimilarityThreshold: 0.97,
    regionVerifyRadius: 0.15,
    physicsRules: '',
    maxTextLength: 1000,
    focusMaxAgeMs: 60_000,
    ...over,
  });
}

type Executable = { execute: (a: unknown) => Promise<string> };
async function runJson(tool: unknown, args: unknown): Promise<any> {
  return JSON.parse(String(await (tool as Executable).execute(args)));
}

test('W7-D1 互斥执法: irreversible × 已授予令牌 × 分道开 ⇒ 人道保守拒绝（审批同意不构成自动派发权）', async () => {
  installFakeSystem();
  try {
    // 开 A（enableReversibilityLanes）时断言 B（已授予的审批令牌派发）被保守拒绝 ——
    // 这是 W4-3 S5 的立法互斥：「不可逆 ⇒ 人类亲办」，不是缺陷。
    const tool = createClickMouseTool(safetyConfig());
    armOob(); // W6R：授予须带外码
    const pa = approval.request('click 发送 to submit the report');
    assert.equal(grantOob(pa.token), true, '用户已授予令牌');
    const out = await runJson(tool, { x: 0.5, y: 0.5, target_description: '发送按钮', approval_token: pa.token });
    assert.equal(out.status, 'ACTION_REQUIRED', '人道拦截');
    assert.equal(out.state_anchor.reason, 'reversibility-human-lane');
    assert.equal(out.state_anchor.reversibility.level, 'irreversible');
    assert.equal(out.state_anchor.reversibility.semantics, 'send-message');
    assert.equal(out.state_anchor.reversibility.lane, 'human');
    assert.match(out.next_step, /do NOT retry automated dispatch/);
    assert.equal(clickCount, 0, '物理点击零派发');
    // 令牌未被烧（拦截在 beginAttempt 之前）：同令牌在分道关闭时可派发 —— 互斥只源于分道开关
    assert.equal(approval.validate(pa.token), true, '拦截在预留之前 ⇒ 令牌保留');

    // 对照组：同一令牌、分道关闭 ⇒ 照常派发（V 纪元验收式消费方言）
    const toolOff = createClickMouseTool(safetyConfig({ enableReversibilityLanes: false }));
    const ok = await runJson(toolOff, { x: 0.5, y: 0.5, target_description: '发送按钮', approval_token: pa.token });
    assert.equal(ok.status, 'SUCCESS', '分道关 ⇒ 已授予令牌照常派发');
    assert.equal(clickCount, 1, '物理点击恰一次');
    assert.equal(ok.state_anchor.reversibility_lane, undefined, '分道关 ⇒ 无分道注记（逐字节旧路）');
    assert.equal(approval.validate(pa.token), false, '派发即消费（用后即焚）');
  } finally {
    restoreSystem();
  }
});

/** escrow 标准武装（全端口 + 注入钟 —— 生产组合根应在 index.ts 铸入，见本册报告 F1） */
function armEscrow(o: { now: () => number; hashNow: () => string | null }): {
  execLog: Array<{ label: string; method: string }>;
} {
  const execLog: Array<{ label: string; method: string }> = [];
  reversalEscrow.arm({
    now: o.now,
    hashPort: { capture: async () => o.hashNow() },
    focusPort: { current: async () => 'Window - Drafts' },
    clipboardPort: { backup: async () => 'clip-handle-1', restore: async () => true },
    executorPort: {
      execute: async (step: { method: string; label: string }): Promise<{ ok: boolean }> => {
        execLog.push({ label: step.label, method: step.method });
        return { ok: true };
      },
    },
  });
  return { execLog };
}

test('W7-D2 补偿全链: compensable × 托管武装 × 审计同开 —— mint→派发→验收消费→预案 verified + Τ 证据入册', async () => {
  installFakeSystem();
  try {
    let hash: string | null = 'a'.repeat(64);
    const clock = fixedClock();
    const { execLog } = armEscrow({ now: clock, hashNow: () => hash });
    const tool = createClickMouseTool(safetyConfig());
    // 令牌铸造携带可逆性分级载荷（request_approval 工具面的立法方言）
    armOob(); // W6R：授予须带外码（码在铸造时刻投递）
    const pa = approval.request('click 删除 to remove report.docx', {
      actionShape: { tool: 'click_mouse', x: 0.5, y: 0.5 },
      reversibility: { level: 'compensable', semantics: 'file-delete', source: 'builtin' },
    });
    assert.equal(grantOob(pa.token), true);
    const out = await runJson(tool, { x: 0.5, y: 0.5, target_description: '删除 report.docx', approval_token: pa.token });
    assert.equal(out.status, 'SUCCESS', '托管道放行（预案铸成）');
    assert.deepEqual({
      level: out.state_anchor.reversibility_lane.level,
      semantics: out.state_anchor.reversibility_lane.semantics,
      lane: out.state_anchor.reversibility_lane.lane,
    }, { level: 'compensable', semantics: 'file-delete', lane: 'escrow' }, '分道注记 = 托管道');
    assert.ok(typeof out.state_anchor.reversibility_lane.escrow_plan === 'string', '预案 id 随行（补偿在途审计锚点）');
    assert.equal(clickCount, 1, '物理点击恰一次');
    assert.equal(out.state_anchor.acceptance.verdict, 'unverified-dispatch-consumed', '验证关闭方言保持');
    // 结算：consume 钩子 ⇒ 预案关闭为 verified（补偿零执行）
    await reversalEscrow.idle();
    const ledger = reversalEscrow.dumpLedger();
    assert.equal(ledger.length, 1, '恰一预案入册');
    assert.equal(ledger[0]!.outcome, 'verified', '验收消费 ⇒ verified（无补偿义务）');
    assert.equal(ledger[0]!.semantics, 'file-delete');
    assert.equal(reversalEscrow.dumpInFlight().length, 0, '在途清空（无泄漏）');
    assert.equal(execLog.length, 0, 'verified 结算不跑补偿');
    // Τ 审计：consume 成功 ⇒ 注册表 supportive 证据入册（干预即教育闭环）
    const ev = (await import('../src/riskGate.ts')).reversibilityRegistry.dumpEvidence()
      .find(e => e.semantics === 'file-delete');
    // W7-3 修复（测试自身错）：posterior 是 adverse 向 Beta(1,1) 后验均值 ——
    // (adverse+1)/(adverse+supportive+2) = 1/3 ≈ 0.333（w4reverse S5-3a 同律契约：
    // 1 次 denied ⇒ posterior 0.667）。遗产期望 0.5 把方向记反（那是 supportive 向
    // 2/4），gateLevel 的升档判据（p 高 ⇒ 升不可逆级）以 adverse 概率为轴。
    assert.deepEqual(ev, { semantics: 'file-delete', adverse: 0, supportive: 1, posterior: 0.333 },
      'consume ⇒ supportive+1（adverse 向 Beta 后验 (0+1)/(0+1+2) = 1/3）');
  } finally {
    restoreSystem();
  }
});

test('W7-D3 补偿真跑: 验收失败(no-effect) ⇒ 托管补偿两步执行 + 屏幕哈希校验 ⇒ compensated-verified + 令牌保留重试', async () => {
  installFakeSystem();
  const savedCapture = (system as unknown as { captureScreen?: unknown }).captureScreen;
  try {
    // 屏恒不变（同一 PNG）+ verifyActions 开 ⇒ effect.detected=false ⇒ attemptFailed(no-effect)
    const stillPng = await solidPng(320, 240);
    (system as unknown as { captureScreen: unknown }).captureScreen = async () => stillPng;
    let hash: string | null = 'a'.repeat(64);
    const clock = fixedClock();
    const { execLog } = armEscrow({ now: clock, hashNow: () => hash });
    const tool = createClickMouseTool(safetyConfig({ verifyActions: true, actionSettleMs: 1 }));
    armOob(); // W6R：授予须带外码（码在铸造时刻投递）
    const pa = approval.request('click 删除 to remove temp.docx', {
      actionShape: { tool: 'click_mouse', x: 0.5, y: 0.5 },
      reversibility: { level: 'compensable', semantics: 'file-delete', source: 'builtin' },
    });
    assert.equal(grantOob(pa.token), true);
    const out = await runJson(tool, { x: 0.5, y: 0.5, target_description: '删除 temp.docx', approval_token: pa.token });
    assert.equal(out.status, 'SUCCESS', '派发照常（失败验收不是派发失败）');
    assert.equal(clickCount, 1);
    assert.equal(out.state_anchor.acceptance.verdict, 'retry-allowed', '未生效 ⇒ 令牌保留（同一授权内重试）');
    assert.equal(out.state_anchor.acceptance.reason, 'no-effect');
    // 托管补偿：attemptFailed 钩子 ⇒ 内置 file-delete 策略两步（回收站恢复 + Ctrl+Z）
    await reversalEscrow.idle();
    assert.deepEqual(execLog.map(s => s.label),
      ['restore from recycle bin', 'Ctrl+Z undo the delete'],
      '补偿步骤按策略表序执行（经注入 executor 端口）');
    const ledger = reversalEscrow.dumpLedger();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.outcome, 'compensated-verified', '补偿后屏幕哈希回到动作前 ⇒ verified（hashPort 校验）');
    assert.deepEqual(ledger[0]!.executedSteps, ['restore from recycle bin', 'Ctrl+Z undo the delete']);
    assert.equal(reversalEscrow.dumpInFlight().length, 0, '在途清空');
    // 令牌仍有效（未生效尝试不消耗同意）
    assert.equal(approval.validate(pa.token), true, '同令牌重试通道保持');
    // Τ 审计：失败验收不是用户裁决 —— 不发示范事件（只有 grant/consume 才是教育时刻）
    const ev = (await import('../src/riskGate.ts')).reversibilityRegistry.dumpEvidence()
      .find(e => e.semantics === 'file-delete');
    assert.equal(ev, undefined, 'attemptFailed 不入示范账（机械重试不是人类裁决）');
  } finally {
    restoreSystem();
    (system as unknown as { captureScreen: unknown }).captureScreen = savedCapture;
  }
});

test('W7-D4 分道原语: gateByReversibility 全开面 —— text-input(W6-3 扩表) 铸预案 / 未知语义不分道（保守律②）', async () => {
  const cfg = safetyConfig();
  // text-input：W6-3 增补的补偿键 —— 与 riskGate 分级表对齐（S5-5d 键对齐律）
  const textLane = await gateByReversibility(cfg, {
    tool: 'type_text', description: '在备注框输入文字', approvalToken: 'APR-W7-D4', enforceEscrow: true,
  });
  assert.equal(textLane.applied, true);
  assert.equal(textLane.verdict.semantics, 'text-input');
  assert.equal(textLane.lane.lane, 'escrow');
  assert.ok(typeof textLane.escrowPlanId === 'string', 'text-input 预案铸成（Ctrl+Z 补偿路径）');
  // 未知语义：分级知识缺席不是分道判决 —— 交回危险词闸门
  const unknown = await gateByReversibility(cfg, {
    tool: 'click_mouse', description: 'frobnicate the quux widget', enforceEscrow: true,
  });
  assert.equal(unknown.applied, false);
  assert.equal(unknown.reason, 'unknown-semantics');
  // 非执法路径（非危险/无令牌）⇒ 只注记不铸造
  const noteOnly = await gateByReversibility(cfg, { tool: 'type_text', description: '普通输入' });
  assert.equal(noteOnly.applied, true);
  assert.equal(noteOnly.escrowPlanId, undefined, '无结算语义的铸造 = 泄漏面 ⇒ 不铸');
  // 清场：D4 铸的在途预案由隔离缝收走
  reversalEscrow.reset();
});
