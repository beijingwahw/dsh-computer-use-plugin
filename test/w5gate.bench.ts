// test/w5gate.bench.ts  ——  W5-6 效能基准包 · C1 免看门控跳过率
//
// 被测声明（W1-3，autonomy/autoPilot C1）：动作期望三档标注 × 五重与门 ⇒
// dHash 未变时跳过重型感知（VLM/OCR）。GENESIS 声明的量化档位为跳过率
// 15–30%（本基准取区间上沿 30% 作断言阈值——比取下沿更强）。
//
// 口径（声明值 vs 实测值，逐项入 console 表）：
//   · 世界：N 步「inspect（预期无影响）× 申报 benign × 宪法 benign ×
//     execute 回报 no_effect × 帧哈希恒 '9f3a'（屏未变）」循环 —— 门控
//     最窄类的正面工作负载；
//   · 重型感知端口调用 = deps.perceive 调用次数（每次 = 一次完整 VLM/OCR
//     感知）；轻量探测 = deps.frameHash 调用次数；
//   · 跳过率 = (N − perceiveCalls) / N（被跳过的重型感知占全部感知机会比；
//     首轮基线感知是必要成本，计入分母——保守口径）；
//   · 声明值：跳过率 > 15–30%；实测值：缺省连续跳过上限 1 ⇒ 50%，
//     上限 3 ⇒ 75%（保鲜上限放开后的机构上限），总闸关 ⇒ 0（对照组）。
//
// 确定性：零随机零真钟（注入步进时钟）、假目标机、假帧哈希端口；同机
// 两次运行逐计数一致（基准内复跑一次互证）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runAutonomousLoop,
  type AutonomyDeps,
  type PerceptionGateOptions,
} from '../src/autonomy/autoPilot.ts';

// ─── 类型工坊（经 AutonomyDeps 索引取型，与 w1gate.test.ts 同律） ───

type Goal = AutonomyDeps['goal'];
type Spec = Goal['spec'];
type Act = Parameters<AutonomyDeps['execute']>[0];
type Snap = Awaited<ReturnType<AutonomyDeps['perceive']>>;

/** 观察动作（预期无影响 × benign —— 门控最窄类的正面样本，w1gate 同款） */
const INSPECT: Act = {
  kind: 'inspect',
  rationale: '细察当前界面收集线索',
  expectedEffect: '获得更多上下文',
  utility: 0.3,
  riskTier: 'benign',
};

/** 手写目标机桩（w1gate StubGoal 的最小拷贝 —— 判据台账 + 相位裁决） */
class StubGoal {
  readonly spec: Spec;
  readonly progress = { steps: 0, criteria: ['pending'], blockers: [] as string[] };
  began = false;
  tickCount = 0;
  constructor(s: Spec) { this.spec = s; }
  begin(): void { this.began = true; }
  tick(): void { this.tickCount++; this.progress.steps = this.tickCount; }
  recordCriterion(): void { /* 基准世界判据恒 pending */ }
  recordAll(): void { /* 同上 */ }
  addBlocker(reason: string): void { this.progress.blockers.push(reason); }
  clearBlockers(): void { this.progress.blockers = []; }
  evaluate(): { phase: 'acting' | 'aborted'; reason: string } {
    return this.began ? { phase: 'acting', reason: '进行中' } : { phase: 'acting', reason: '起步' };
  }
  toAnchor(): Record<string, unknown> { return { steps: this.tickCount }; }
}

/** 一次 N 步门控闭环 + 全部计数器取证（全离线注入） */
async function runGatedLoop(cfg: {
  steps: number;
  gate?: PerceptionGateOptions;
  gateEnabled?: boolean;
}): Promise<{ perceiveCalls: number; hashCalls: number; execCalls: number; summary: string }> {
  const goal = new StubGoal({ goal: '整理桌面', successCriteria: ['列表可见'], maxSteps: cfg.steps });
  const snap = {
    takenAt: 1_000, width: 800, height: 600, dhash: '9f3a',
    elements: [], textDigest: '桌面文本', popups: [], focusedRegion: null,
    sceneLabel: '', degraded: [],
  } as Snap;
  let decideCount = 0;
  let execCount = 0;
  let hashCount = 0;
  let perceiveCalls = 0;
  let clock = 0;
  const deps: AutonomyDeps = {
    perceive: async () => { perceiveCalls++; return snap; },
    policy: {
      decide: async () => {
        decideCount++;
        return { action: INSPECT, uncertain: false, degraded: false };
      },
    },
    execute: async () => {
      execCount++;
      return { outcome: 'no_effect' as const };
    },
    goal: goal as unknown as Goal,
    sleep: async () => { /* 零真睡 */ },
    now: () => (clock += 50),
    frameHash: async () => { hashCount++; return '9f3a'; },
  };
  if (cfg.gate !== undefined) deps.perceptionGate = cfg.gate;
  if (cfg.gateEnabled === false) deps.perceptionGate = { enabled: false };
  const res = await runAutonomousLoop(deps, { maxSteps: cfg.steps });
  void decideCount;
  return { perceiveCalls, hashCalls: hashCount, execCalls: execCount, summary: res.summary };
}

/** 从总账摘要提取「免看门控：触发 a 次，跳过 b 次，唤醒 c 次。」三元组 */
function parseGateAccount(summary: string): { fired: number; skipped: number; woken: number } | null {
  const m = /免看门控：触发 (\d+) 次，跳过 (\d+) 次，唤醒 (\d+) 次。/.exec(summary);
  return m ? { fired: Number(m[1]), skipped: Number(m[2]), woken: Number(m[3]) } : null;
}

// ─── C1 基准：跳过率（声明 15–30% 档 → 断言 > 30% 上沿） ───

test('W5-6/C1: 免看门控 —— N 步无影响循环的重型感知跳过率（声明 >15–30%，实测缺省 50%）', async () => {
  const N = 12;

  // 缺省门控（连续跳过上限 1 —— 生产缺省）
  const def = await runGatedLoop({ steps: N });
  const skipRateDefault = (N - def.perceiveCalls) / N;

  // 保鲜上限放开到 3（机构上限演示 —— 旧屏账有界保鲜的代价曲线）
  const wide = await runGatedLoop({ steps: N, gate: { maxConsecutiveSkips: 3 } });
  const skipRateWide = (N - wide.perceiveCalls) / N;

  // 对照组：总闸关闭 ⇒ 门控零贡献（基准的反事实基线）
  const off = await runGatedLoop({ steps: N, gateEnabled: false });
  const skipRateOff = (N - off.perceiveCalls) / N;

  // 确定性互证：同配置复跑一次，逐计数一致
  const again = await runGatedLoop({ steps: N });
  assert.deepEqual(
    { p: again.perceiveCalls, h: again.hashCalls, e: again.execCalls },
    { p: def.perceiveCalls, h: def.hashCalls, e: def.execCalls },
    '同机两次运行结论必须一致（确定性铁律）',
  );

  console.log([
    '── W5-6/C1 免看门控跳过率（N=12 步 inspect × 屏未变 × 双层 benign）──',
    `缺省(上限1)     perceive=${def.perceiveCalls}/${N}  probe=${def.hashCalls}  skipRate=${(skipRateDefault * 100).toFixed(1)}%`,
    `上限3           perceive=${wide.perceiveCalls}/${N}  probe=${wide.hashCalls}  skipRate=${(skipRateWide * 100).toFixed(1)}%`,
    `总闸关(对照)    perceive=${off.perceiveCalls}/${N}  probe=${off.hashCalls}  skipRate=${(skipRateOff * 100).toFixed(1)}%`,
    `口径: 跳过率 = (N − perceiveCalls)/N；声明值 >15–30%；实测缺省 ${(skipRateDefault * 100).toFixed(1)}%`,
  ].join('\n'));

  // 断言（声明值 vs 实测值 —— 声明档位 15–30%，断言取上沿 30%）
  assert.ok(skipRateDefault > 0.30, `缺省跳过率应 >30%（实测 ${(skipRateDefault * 100).toFixed(1)}%）`);
  assert.ok(skipRateWide > skipRateDefault, '保鲜上限放宽 ⇒ 跳过率单调不降');
  assert.equal(skipRateOff, 0, '总闸关 ⇒ 零跳过（反事实对照）');
  assert.equal(off.hashCalls, 0, '总闸关 ⇒ 连轻量探测都不发起');

  // 台账对账：摘要计数与端口计数互证（跳过一次 = 一次轻量探测顶替一次重型感知）
  const acct = parseGateAccount(def.summary);
  assert.ok(acct, `总账摘要应含门控三元组（${def.summary}）`);
  assert.equal(acct!.skipped, N - def.perceiveCalls, '总账跳过数 = 端口跳过数');
  assert.equal(acct!.fired, def.hashCalls, '总账触发数 = 轻量探测数');
  assert.equal(acct!.woken, 0, '屏未变 ⇒ 零唤醒');

  // 环未断：策略每步仍被咨询（门控跳感知不跳循环）
  assert.equal(def.execCalls, N, 'N 步全部执行（跳过的是感知，不是决策循环）');
});
