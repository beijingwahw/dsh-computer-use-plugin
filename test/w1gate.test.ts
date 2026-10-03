// test/w1gate.test.ts
// W1-3（C1 Act-Expectation 免看门控）：autoPilot ② 感知前免看门控的全离线确定性
// 测试 —— 零真钟、零真睡、零网络。假感知（重型感知端口，调用数即断言锚点）+
// 假帧哈希端口（注入 dHash 序列）+ 手写目标机桩（与 autonomy.autoPilot.test.ts
// 同律）。安全红线是设计核心，逐条锁定：
//   W1-3-0   classifyExpectedVisualEffect 纯函数：三档标注全表（种类 × 风险档 × 参数有效性）
//   W1-3-a   该跳时跳：无影响+双层 benign+屏未变 ⇒ 重型感知端口零追加调用，
//            轻量合成快照（sceneLabel 观察文本/degraded 记账/旧账透传）推进循环
//   W1-3-b   弹窗红线：弹窗活跃标志在场 ⇒ 禁止门控（连哈希探测都不发起）
//   W1-3-c   必变动作不跳：sensitive 世界动作 ⇒ 必看
//   W1-3-c2  宪法盖章升级不跳：申报 benign 但盖章 sensitive ⇒ 必看
//   W1-3-d   可能变动作不跳：benign type（大概率变）⇒ 必看
//   W1-3-e   屏变化时唤醒：单探见变 ⇒ 照旧完整感知（最窄类同律）
//   W1-3-f   降级路径：哈希端口缺席 ⇒ 门控整体降级，逐字节照旧感知
//   W1-3-g   总闸：{enabled:false} ⇒ 完全关闭
//   W1-3-h   降级路径：端口抛异常/返回 null/指纹不可比 ⇒ 一律照旧感知
//   W1-3-i   wait 值守：到顶仍未变 ⇒ 轮询有界后跳过重型感知（间隔×上限记账）
//   W1-3-j   wait 值守：变化超阈值 ⇒ 唤醒完整感知
//   W1-3-k   连续跳过上限（缺省 1）：交替「跳过/完整感知」，旧屏账有界保鲜
//   W1-3-l   error 步重置语境：世界状态未知 ⇒ 下轮必看
//   W1-3-m   无指纹基线：感知快照无 dhash ⇒ 无比对基准 ⇒ 必看
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runAutonomousLoop,
  classifyExpectedVisualEffect,
  type AutonomyDeps,
  type StepRecord,
  type PilotResult,
  type PerceptionGateOptions,
} from '../src/autonomy/autoPilot.ts';

// ─── 类型工坊（经 AutonomyDeps 索引取型，与 autonomy.autoPilot.test.ts 同律） ───

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

/** 固定世界快照铸造器（dhash 恒 '9f3a'，可覆盖弹窗/指纹等字段） */
function makeSnap(over: Partial<Snap> = {}): Snap {
  return {
    takenAt: 1_000, width: 800, height: 600, dhash: '9f3a',
    elements: [], textDigest: '桌面文本', popups: [], focusedRegion: null,
    sceneLabel: '', degraded: [],
    ...over,
  } as Snap;
}

/** 目标规格铸造器（缺省两判据，可局部覆盖） */
function makeSpec(over: Partial<Spec> = {}): Spec {
  return { goal: '整理桌面', successCriteria: ['列表可见', '焦点就位'], ...over };
}

/** 手写目标机桩（Φ-1 兄弟契约的面具）：判据台账 + 相位裁决 */
class StubGoal {
  readonly spec: Spec;
  readonly progress: { steps: number; criteria: Array<'met' | 'violated' | 'pending'>; blockers: string[] };
  began = false;
  tickCount = 0;

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
    if (this.progress.blockers.length > 0) return { phase: 'blocked', reason: this.progress.blockers[0] };
    return { phase: this.began ? 'acting' : 'planning', reason: '进行中' };
  }
  toAnchor(): Record<string, unknown> { return { steps: this.tickCount, began: this.began }; }
}

/** 观察动作（预期无影响 × benign —— 门控最窄类的正面样本） */
const INSPECT: Act = {
  kind: 'inspect',
  rationale: '细察当前界面收集线索',
  expectedEffect: '获得更多上下文',
  utility: 0.3,
  riskTier: 'benign',
};

/** 沉降动作（wait 值守模式的触发样本） */
const WAIT: Act = {
  kind: 'wait',
  payload: { note: '等列表加载' },
  rationale: '等待界面沉降',
  expectedEffect: '界面进入稳定态',
  utility: 0.2,
  riskTier: 'benign',
};

/** 敏感世界动作（必变样本：有效落点 + sensitive） */
const CLICK_SENSITIVE: Act = {
  kind: 'click',
  target: { bbox: { x0: 1, y0: 1, x1: 9, y1: 9 }, center: { x: 5, y: 5 }, label: '发送' },
  rationale: '点击发送按钮',
  expectedEffect: '内容被发送',
  utility: 0.8,
  riskTier: 'sensitive',
};

/** 良性键入（可能变样本：非空文本 + benign —— type 后大概率变） */
const TYPE_BENIGN: Act = {
  kind: 'type',
  payload: { text: '你好' },
  rationale: '在输入框键入文本',
  expectedEffect: '文本出现在输入框',
  utility: 0.7,
  riskTier: 'benign',
};

/** 升级动作（终局收口样本） */
const ESCALATE: Act = {
  kind: 'escalate',
  rationale: '目标元素不在屏幕上，移交上游',
  expectedEffect: '上游裁决',
  utility: 0.1,
  riskTier: 'benign',
};

/** 门控测试运行配置 */
interface GateRunConfig {
  decisions: Decision[];
  /** execute 回报序列（缺省恒 no_effect；不足时重复末位） */
  execResults?: ExecResult[];
  /** execute 连抛（error 步路径） */
  execThrows?: boolean;
  /** 感知快照底本（缺省 dhash '9f3a' / 无弹窗） */
  snap?: Snap;
  /** 帧哈希端口返回序列（不足时重复末位） */
  hashes?: Array<string | null>;
  /** 帧哈希端口连抛 */
  hashThrows?: boolean;
  /** false = 不注入哈希端口（降级路径）；缺省 true */
  withPort?: boolean;
  /** 门控配置注入 */
  gateConf?: PerceptionGateOptions;
  /** 宪法注入 */
  constitution?: Constitution;
  /** 注入时钟（缺省步进 +50） */
  now?: () => number;
  settleMs?: number;
  maxSteps?: number;
}

/** 一次门控闭环运行 + 全部计数器取证 */
async function runGateLoop(cfg: GateRunConfig): Promise<{
  res: PilotResult;
  perceiveCalls: number;
  hashCalls: number;
  execCalls: number;
  sleepCalls: number[];
  decideCtxs: Ctx[];
}> {
  const goal = new StubGoal(makeSpec({ maxSteps: cfg.maxSteps ?? 12 }));
  const snap = cfg.snap ?? makeSnap();
  const hashes = cfg.hashes ?? ['9f3a'];
  const execResults = cfg.execResults ?? [{ outcome: 'no_effect' as const }];
  let decideCount = 0;
  let execCount = 0;
  let hashCount = 0;
  let perceiveCalls = 0;
  let clock = 0;
  const sleepCalls: number[] = [];
  const decideCtxs: Ctx[] = [];
  const deps: AutonomyDeps = {
    perceive: async () => { perceiveCalls++; return snap; },
    policy: {
      decide: async ctx => {
        decideCtxs.push(ctx);
        const i = Math.min(decideCount++, cfg.decisions.length - 1);
        return cfg.decisions[i];
      },
    },
    execute: cfg.execThrows
      ? async () => { execCount++; throw new Error('boom: 执行管线故障'); }
      : async () => {
          execCount++;
          const i = Math.min(execCount - 1, execResults.length - 1);
          return execResults[i];
        },
    goal: goal as unknown as Goal,
    sleep: async (ms: number) => { sleepCalls.push(ms); },
    now: cfg.now ?? (() => (clock += 50)),
  };
  if (cfg.withPort !== false) {
    deps.frameHash = cfg.hashThrows
      ? async () => { hashCount++; throw new Error('boom: 哈希端口故障'); }
      : async () => {
          const v = hashes[Math.min(hashCount, hashes.length - 1)];
          hashCount++;
          return v;
        };
  }
  if (cfg.gateConf !== undefined) deps.perceptionGate = cfg.gateConf;
  if (cfg.constitution !== undefined) deps.constitution = cfg.constitution;
  const res = await runAutonomousLoop(
    deps,
    cfg.maxSteps !== undefined || cfg.settleMs !== undefined
      ? {
          ...(cfg.maxSteps !== undefined ? { maxSteps: cfg.maxSteps } : {}),
          ...(cfg.settleMs !== undefined ? { settleMs: cfg.settleMs } : {}),
        }
      : undefined,
  );
  return { res, perceiveCalls, hashCalls: hashCount, execCalls: execCount, sleepCalls, decideCtxs };
}

// ─── W1-3-0 三档标注纯函数全表 ───

test('W1-3-0: classifyExpectedVisualEffect —— 种类×风险档×参数有效性三档全表（垃圾输入保守归必变）', () => {
  const world = (over: Partial<Act>): Act => ({
    kind: 'click',
    target: { bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, center: { x: 5, y: 5 }, label: 'x' },
    rationale: '', expectedEffect: '', utility: 0.5, riskTier: 'benign',
    ...over,
  });
  // click：有效落点按风险档分档；无效坐标（缺 target / NaN 中心）⇒ 无影响
  assert.equal(classifyExpectedVisualEffect(world({})), 'may-change');
  assert.equal(classifyExpectedVisualEffect(world({ riskTier: 'sensitive' })), 'must-change');
  assert.equal(classifyExpectedVisualEffect(world({ riskTier: 'destructive' })), 'must-change');
  assert.equal(classifyExpectedVisualEffect(world({ target: undefined })), 'no-impact');
  assert.equal(
    classifyExpectedVisualEffect(world({ target: { bbox: { x0: 0, y0: 0, x1: 1, y1: 1 }, center: { x: Number.NaN, y: 5 }, label: 'x' } })),
    'no-impact',
  );
  // drag：与 click 同律（有效落点 ⇒ 世界动作）
  assert.equal(classifyExpectedVisualEffect(world({ kind: 'drag' })), 'may-change');
  assert.equal(classifyExpectedVisualEffect(world({ kind: 'drag', target: undefined })), 'no-impact');
  // type：非空文本 ⇒ 可能变（大概率变）；空文本 ⇒ 无影响
  assert.equal(classifyExpectedVisualEffect(world({ kind: 'type', payload: { text: 'hi' } })), 'may-change');
  assert.equal(classifyExpectedVisualEffect(world({ kind: 'type', payload: { text: '' } })), 'no-impact');
  assert.equal(classifyExpectedVisualEffect(world({ kind: 'type' })), 'no-impact');
  assert.equal(classifyExpectedVisualEffect(world({ kind: 'type', payload: { text: 'hi' }, riskTier: 'sensitive' })), 'must-change');
  // scroll：方向缺席/非字符串 ⇒ runtime 按 down 仍滚动（世界动作）；非法字符串 ⇒ 无影响
  assert.equal(classifyExpectedVisualEffect(world({ kind: 'scroll' })), 'may-change');
  assert.equal(classifyExpectedVisualEffect(world({ kind: 'scroll', payload: { direction: 'up' } })), 'may-change');
  assert.equal(classifyExpectedVisualEffect(world({ kind: 'scroll', payload: { direction: 7 } })), 'may-change');
  assert.equal(classifyExpectedVisualEffect(world({ kind: 'scroll', payload: { direction: 'sideways' } })), 'no-impact');
  assert.equal(classifyExpectedVisualEffect(world({ kind: 'scroll', payload: { direction: 'up' }, riskTier: 'destructive' })), 'must-change');
  // hotkey：非空键 ⇒ 可能变；空键/全空白键 ⇒ 无影响
  assert.equal(classifyExpectedVisualEffect(world({ kind: 'hotkey', payload: { keys: ['ctrl', 's'] } })), 'may-change');
  assert.equal(classifyExpectedVisualEffect(world({ kind: 'hotkey', payload: { keys: [] } })), 'no-impact');
  assert.equal(classifyExpectedVisualEffect(world({ kind: 'hotkey', payload: { keys: ['  '] } })), 'no-impact');
  assert.equal(classifyExpectedVisualEffect(world({ kind: 'hotkey' })), 'no-impact');
  // 观察性动作：只看不改世界 ⇒ 无影响
  for (const kind of ['inspect', 'declare', 'ask_vlm', 'recall_skill'] as const) {
    assert.equal(classifyExpectedVisualEffect(world({ kind })), 'no-impact', `${kind} 应为无影响`);
  }
  // wait：等待的语义就是预期变化（值守轮询覆盖）
  assert.equal(classifyExpectedVisualEffect(world({ kind: 'wait' })), 'may-change');
  // escalate / 未知种类 / 垃圾输入：不确定 ⇒ 必看
  assert.equal(classifyExpectedVisualEffect(world({ kind: 'escalate' })), 'must-change');
  assert.equal(classifyExpectedVisualEffect(world({ kind: 'teleport' as Act['kind'] })), 'must-change');
  assert.equal(classifyExpectedVisualEffect(null as unknown as Act), 'must-change');
  assert.equal(classifyExpectedVisualEffect({} as Act), 'must-change');
});

// ─── W1-3-a 该跳时跳（核心正例） ───

test('W1-3-a: 该跳时跳 —— 无影响+双层 benign+屏未变 ⇒ 重型感知零追加调用，轻量合成快照推进循环', async () => {
  const r = await runGateLoop({
    decisions: [
      { action: INSPECT, uncertain: false, degraded: false },
      { action: ESCALATE, uncertain: false, degraded: false, note: '升级注解' },
    ],
  });

  // 核心断言：重型感知端口只在首轮基线时被调用 1 次，第二轮被门控跳过
  assert.equal(r.perceiveCalls, 1, '屏未变 ⇒ 第二轮重型感知（VLM/OCR）不得被调用');
  assert.equal(r.hashCalls, 1, '单探一次');
  assert.equal(r.decideCtxs.length, 2, '门控跳过感知不跳过循环 —— 策略仍被咨询');

  // 轻量合成快照取证：旧账透传 + 轻量文本观察 + 诚实降级记账
  const gated = r.decideCtxs[1].snapshot;
  assert.equal(gated.dhash, '9f3a', '基线指纹透传');
  assert.equal(gated.textDigest, '桌面文本', '旧文本账透传（textDigest 分毫不动）');
  assert.equal(gated.sceneLabel, '免看门控：已执行，屏未变', '轻量文本观察走 sceneLabel 通道');
  assert.ok(gated.degraded.includes('perception-gate-skipped'), '合成快照诚实记降级');
  assert.notEqual(gated.takenAt, r.decideCtxs[0].snapshot.takenAt, 'takenAt 刷新为当刻');
  assert.equal(r.decideCtxs[0].snapshot.dhash, '9f3a', '首轮为真实感知');

  // 记账：门控跳过注记搭车在裁决轮的首个落账步（escalate 步）上
  assert.equal(r.res.trajectory.length, 2);
  assert.equal(
    r.res.trajectory[1].note,
    '升级注解；免看门控：已执行，屏未变，跳过重型感知（门控跳过 1/1）',
    '跳过注记逐字节（既有 note 前置，零破坏）',
  );
  assert.equal(r.res.trajectory[1].snapshotDhash, '9f3a', '步记录指纹不因门控漂移');
  assert.match(r.res.summary, /免看门控：触发 1 次，跳过 1 次，唤醒 0 次。/);
  assert.equal(r.res.escalated, true);
});

// ─── W1-3-b 弹窗红线 ───

test('W1-3-b: 弹窗在场禁止门控 —— popups 非空 ⇒ 连哈希探测都不发起，照旧完整感知', async () => {
  const r = await runGateLoop({
    snap: makeSnap({ popups: ['系统更新提示'] }),
    decisions: [
      { action: INSPECT, uncertain: false, degraded: false },
      { action: ESCALATE, uncertain: false, degraded: false, note: '升级注解' },
    ],
  });
  assert.equal(r.perceiveCalls, 2, '弹窗活跃标志在场 ⇒ 每轮完整感知（弹窗检测输入绝不可跳）');
  assert.equal(r.hashCalls, 0, '门控连探测都不发起');
  assert.equal(r.res.trajectory[1].note, '升级注解', '无门控注记');
  assert.doesNotMatch(r.res.summary, /免看门控/);
});

// ─── W1-3-c 必变动作（高风险世界动作） ───

test('W1-3-c: 必变动作不跳 —— sensitive 有效落点点击 ⇒ 分类必变 ⇒ 照旧感知', async () => {
  const r = await runGateLoop({
    decisions: [
      { action: CLICK_SENSITIVE, uncertain: false, degraded: false },
      { action: ESCALATE, uncertain: false, degraded: false, note: '升级注解' },
    ],
  });
  assert.equal(r.perceiveCalls, 2, '必变动作后果必须目击验证');
  assert.equal(r.hashCalls, 0, '非最窄类 ⇒ 门控零探测');
  assert.equal(r.res.trajectory[1].note, '升级注解');
});

// ─── W1-3-c2 宪法盖章升级 ───

test('W1-3-c2: 宪法盖章升级不跳 —— 申报 benign 但判决盖章 sensitive ⇒ 双层 benign 红线拦下', async () => {
  const stampSensitive: Constitution = {
    check: action => ({
      allowed: true,
      riskTier: action.riskTier === 'benign' ? 'sensitive' : action.riskTier,
      requiresApproval: false,
      reason: '词法扫描升级盖章',
    }),
  };
  const r = await runGateLoop({
    constitution: stampSensitive,
    decisions: [
      { action: INSPECT, uncertain: false, degraded: false },
      { action: ESCALATE, uncertain: false, degraded: false, note: '升级注解' },
    ],
  });
  assert.equal(r.res.trajectory[0].effectiveRiskTier, 'sensitive', '宪法盖章入账');
  assert.equal(r.perceiveCalls, 2, '被盖章升级者必看 —— 双层 benign 缺一不可');
  assert.equal(r.hashCalls, 0);
});

// ─── W1-3-d 可能变动作 ───

test('W1-3-d: 可能变动作不跳 —— benign type（大概率变）⇒ 非最窄类 ⇒ 照旧感知', async () => {
  const r = await runGateLoop({
    decisions: [
      { action: TYPE_BENIGN, uncertain: false, degraded: false },
      { action: ESCALATE, uncertain: false, degraded: false, note: '升级注解' },
    ],
  });
  assert.equal(r.perceiveCalls, 2, 'type 后大概率变 —— 不在免看白名单');
  assert.equal(r.hashCalls, 0);
});

// ─── W1-3-e 屏变化时唤醒（最窄类单探见变） ───

test('W1-3-e: 屏变化时唤醒 —— 帧哈希超容差 ⇒ 放行完整感知（误判未变的反面锁定）', async () => {
  // '9f3a' vs '0000'：汉明距离 = 2+4+2+2 = 10 > 容差 3
  const r = await runGateLoop({
    hashes: ['0000'],
    decisions: [
      { action: INSPECT, uncertain: false, degraded: false },
      { action: ESCALATE, uncertain: false, degraded: false, note: '升级注解' },
    ],
  });
  assert.equal(r.hashCalls, 1, '单探一次即见变');
  assert.equal(r.perceiveCalls, 2, '变化 ⇒ 唤醒完整感知');
  assert.equal(r.res.trajectory[1].note, '升级注解', '无跳过注记');
  assert.match(r.res.summary, /免看门控：触发 1 次，跳过 0 次，唤醒 0 次。/, '触发次数仍入总账');
});

// ─── W1-3-f 降级路径：端口缺席 ───

test('W1-3-f: 哈希端口缺席 ⇒ 门控整体降级 —— 照旧感知，零门控痕迹（生产接线前的缺省态）', async () => {
  const r = await runGateLoop({
    withPort: false,
    decisions: [
      { action: INSPECT, uncertain: false, degraded: false },
      { action: ESCALATE, uncertain: false, degraded: false, note: '升级注解' },
    ],
  });
  assert.equal(r.perceiveCalls, 2, '端口缺席 ⇒ 逐字节照旧感知');
  assert.equal(r.hashCalls, 0);
  assert.equal(r.res.trajectory[1].note, '升级注解');
  assert.doesNotMatch(r.res.summary, /免看门控/);
});

// ─── W1-3-g 总闸 ───

test('W1-3-g: {enabled:false} ⇒ 门控完全关闭（注入端口可关 —— 测试总闸）', async () => {
  const r = await runGateLoop({
    gateConf: { enabled: false },
    decisions: [
      { action: INSPECT, uncertain: false, degraded: false },
      { action: ESCALATE, uncertain: false, degraded: false, note: '升级注解' },
    ],
  });
  assert.equal(r.perceiveCalls, 2, '总闸关闭 ⇒ 一切感知照旧');
  assert.equal(r.hashCalls, 0, '连探测都不发起');
  assert.doesNotMatch(r.res.summary, /免看门控/);
});

// ─── W1-3-h 降级路径：端口故障三态 ───

test('W1-3-h: 端口故障降级 —— 抛异常/返回 null/指纹不可比 ⇒ 一律照旧感知，绝不炸环', async () => {
  // 抛异常
  const t = await runGateLoop({
    hashThrows: true,
    decisions: [
      { action: INSPECT, uncertain: false, degraded: false },
      { action: ESCALATE, uncertain: false, degraded: false, note: '升级注解' },
    ],
  });
  assert.equal(t.perceiveCalls, 2, '端口抛异常 ⇒ 不可判 ⇒ 照旧感知');
  assert.equal(t.hashCalls, 1);
  assert.match(t.res.summary, /免看门控：触发 1 次，跳过 0 次，唤醒 0 次。/, '触发记账可观测（降级也留痕）');

  // 返回 null（截屏失败等）
  const n = await runGateLoop({
    hashes: [null],
    decisions: [
      { action: INSPECT, uncertain: false, degraded: false },
      { action: ESCALATE, uncertain: false, degraded: false, note: '升级注解' },
    ],
  });
  assert.equal(n.perceiveCalls, 2, '端口返回 null ⇒ 照旧感知');

  // 指纹不可比（长度不一）
  const c = await runGateLoop({
    hashes: ['ff'],
    decisions: [
      { action: INSPECT, uncertain: false, degraded: false },
      { action: ESCALATE, uncertain: false, degraded: false, note: '升级注解' },
    ],
  });
  assert.equal(c.perceiveCalls, 2, '指纹不可比 ⇒ 保守判不可判 ⇒ 照旧感知');
  assert.equal(c.res.trajectory.length, 2, '三条降级路径均不炸环、正常收口');
});

// ─── W1-3-i wait 值守：到顶仍未变 ⇒ 跳过 ───

test('W1-3-i: wait 值守 —— dHash 循环值守（间隔×上限）到顶屏未变 ⇒ 跳过重型感知', async () => {
  // 恒定时钟（值守时长恒 0）+ 间隔 10ms / 上限 25ms ⇒ 探测上限 3 次、睡眠 2 次 —— 全确定
  const r = await runGateLoop({
    decisions: [
      { action: WAIT, uncertain: false, degraded: false },
      { action: ESCALATE, uncertain: false, degraded: false, note: '升级注解' },
    ],
    gateConf: { pollIntervalMs: 10, pollMaxMs: 25 },
    now: () => 1_000,
  });
  assert.equal(r.perceiveCalls, 1, '值守到顶屏未变 ⇒ 重型感知被跳过');
  assert.equal(r.hashCalls, 3, '探测次数 = floor(25/10)+1 = 3（有界）');
  assert.deepEqual(r.sleepCalls, [300, 10, 10], '先 wait 沉降 300ms，值守再睡 2 次间隔');
  assert.equal(
    r.res.trajectory[1].note,
    '升级注解；免看门控：已等待 0ms 屏未变，跳过重型感知（门控跳过 1/1）',
    '值守跳过注记（含值守时长）',
  );
  assert.match(r.res.summary, /免看门控：触发 1 次，跳过 1 次，唤醒 0 次。/);
});

// ─── W1-3-j wait 值守：变化唤醒 ───

test('W1-3-j: wait 值守 —— 变化超阈值 ⇒ 唤醒完整感知', async () => {
  const r = await runGateLoop({
    decisions: [
      { action: WAIT, uncertain: false, degraded: false },
      { action: ESCALATE, uncertain: false, degraded: false, note: '升级注解' },
    ],
    hashes: ['9f3a', '0000'], // 第二次探测见变（距离 10 > 3）
    gateConf: { pollIntervalMs: 10, pollMaxMs: 25 },
    now: () => 1_000,
  });
  assert.equal(r.hashCalls, 2, '第二次探测见变即止');
  assert.equal(r.perceiveCalls, 2, '变化 ⇒ 唤醒完整感知');
  assert.deepEqual(r.sleepCalls, [300, 10]);
  assert.equal(
    r.res.trajectory[1].note,
    '升级注解；免看门控：值守 0ms 发现屏幕变化，唤醒完整感知（唤醒 1）',
    '唤醒注记入账',
  );
  assert.match(r.res.summary, /免看门控：触发 1 次，跳过 0 次，唤醒 1 次。/);
});

// ─── W1-3-k 连续跳过上限 ───

test('W1-3-k: 连续跳过上限（缺省 1）—— 跳过/完整感知交替，旧屏账有界保鲜', async () => {
  const r = await runGateLoop({
    decisions: [{ action: INSPECT, uncertain: false, degraded: false }],
    maxSteps: 4,
  });
  // 四个 inspect 步：it1 感知(1) → it2 跳过 → it3 感知(2) → it4 跳过 → 保险丝
  assert.equal(r.execCalls, 4);
  assert.equal(r.perceiveCalls, 2, '交替：完整感知仅 2 次（it1 基线 + it3 保鲜）');
  assert.equal(r.hashCalls, 2);
  const gated = r.res.trajectory.filter(s => s.note !== undefined && s.note.includes('免看门控'));
  assert.equal(gated.length, 2, '两轮跳过注记（step1 与 step3）');
  assert.match(r.res.summary, /免看门控：触发 2 次，跳过 2 次，唤醒 0 次。/);
  assert.equal(r.res.phase, 'aborted', '步保险丝收口');
});

// ─── W1-3-l error 步重置语境 ───

test('W1-3-l: error 步重置语境 —— 执行失败 ⇒ 世界状态未知 ⇒ 下轮必看', async () => {
  const r = await runGateLoop({
    decisions: [
      { action: INSPECT, uncertain: false, degraded: false },
      { action: ESCALATE, uncertain: false, degraded: false, note: '升级注解' },
    ],
    execThrows: true,
  });
  assert.equal(r.res.trajectory[0].outcome, 'error', '首轮 execute 抛 ⇒ error 步');
  assert.equal(r.perceiveCalls, 2, 'error 步 ⇒ 门控语境归零 ⇒ 下轮完整感知');
  assert.equal(r.hashCalls, 0);
});

// ─── W1-3-m 无指纹基线 ───

test('W1-3-m: 无指纹基线 —— 感知快照无 dhash ⇒ 无比对基准 ⇒ 必看', async () => {
  const r = await runGateLoop({
    snap: makeSnap({ dhash: null }),
    decisions: [
      { action: INSPECT, uncertain: false, degraded: false },
      { action: ESCALATE, uncertain: false, degraded: false, note: '升级注解' },
    ],
  });
  assert.equal(r.perceiveCalls, 2, '基线指纹缺席 ⇒ 门控不可判 ⇒ 照旧感知');
  assert.equal(r.hashCalls, 0);
  assert.equal(r.res.trajectory[1].note, '升级注解');
});
