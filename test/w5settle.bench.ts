// test/w5settle.bench.ts  ——  W5-6 效能基准包 · A5 稳态门等待当量缩减
//
// 被测声明（W1-1 A5，autonomy/runtime settleGate）：动作后不固定等待，
// 连续两帧（间隔 steadyPollMs=150）全屏 dhash 汉明 ≤2 即稳态放行。
// 任务书声明口径：时延降约 40%。
//
// 口径（声明值 vs 实测值，逐项入 console 表）：
//   · 稳态门臂 = 生产缺省调参（steadyPollMs 150 / steadyHamming 2），世界
//     「两帧即稳态」（首对轮询帧汉明 2 ≤ 2 ⇒ 一轮判稳）—— 每动作等待
//     当量 = 1 × 150ms；
//   · 固定等待臂 = 同一 settleGate 代码注入固定等待语义（steadyPollMs 300
//     且判稳容差放到恒稳 —— 等价于「固定睡 300ms 再放行」，与 autoPilot
//     wait 动作 DEFAULT_SETTLE_MS=300 的固定沉降语义同档）—— 每动作 300ms；
//   · 等待调用当量 = deps.sleep 的毫秒总和（注入零真睡，只记账）；
//   · 声明值：缩减 ≥40%；实测值：两帧即稳世界 50%（150 vs 300）。
//     附慢世界边界档（需 2 轮判稳）：33.3% < 40% —— 如实呈报不作断言
//     （慢世界上稳态门与固定等待打平，是声明的诚实边界，见报告）。
//
// 确定性：假探针（脚本化帧样本 + 假哈希串）、monkey-patch 键鼠（finally
// 复原）、注入时钟零真睡；两次运行逐毫秒一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { system } from '../src/system.ts';
import { createExecute, W1_EXEC_TUNING, type RuntimeDeps, type W1ExecTuning } from '../src/autonomy/runtime.ts';
import { composeSnapshot, type WorldSnapshot } from '../src/autonomy/worldSnapshot.ts';
import type { GoalSpec, PolicyAction } from '../src/autonomy/index.ts';
import type { ExecWorldProbe, FrameSample } from '../src/physicalExecution/execProbe.ts';

// ─── 假件工坊（与 w1exec.test.ts 同律） ───

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

/** 指纹串工厂：B(n) 与 B(m) 汉明距离恰为 |n−m| */
const B = (n: number): string => '1'.repeat(n) + '0'.repeat(64 - n);
const H0 = B(0);

const S = (dh: string | null, rdh: string | null, id: number): FrameSample => ({
  dhash: dh, regionDhash: rdh, frameId: id, width: 1920, height: 1080,
});

/** 假探针：脚本化样本队列（耗尽 ⇒ null）+ 调用计数 */
function makeProbe(samples: FrameSample[]): { probe: ExecWorldProbe; calls: { samples: number } } {
  const calls = { samples: 0 };
  const queue = [...samples];
  return {
    calls,
    probe: {
      sampleFrame: async () => { calls.samples++; return queue.length > 0 ? queue.shift()! : null; },
      frameDiff: async () => null,
      frameRowMeans: async () => null,
      hitTestPoint: async () => null,
      cursorKind: async () => null,
    },
  };
}

interface ExecOpts { probe?: ExecWorldProbe; w1?: Partial<W1ExecTuning>; snapshot?: WorldSnapshot | null }

/** 铸造被测 execute + 观测账本（全注入零真 IO；sleep 只记账） */
function makeExecute(o: ExecOpts = {}): {
  execute: (action: PolicyAction) => Promise<{ outcome: string; verification?: { steady: boolean | null; steadyPolls: number } }>;
  sleeps: number[];
} {
  const sleeps: number[] = [];
  let clock = 1_000;
  const snap: WorldSnapshot = o.snapshot ?? composeSnapshot({ width: 512, height: 384, dhash: H0 });
  const deps: RuntimeDeps & { spec: GoalSpec; width: number; height: number } = {
    capture: async () => Buffer.from([1]),
    imageSize: async () => ({ width: 512, height: 384 }),
    dhashOf: async () => 'aaaaaaaaaaaaaaaa',
    readWords: async (): Promise<never[]> => [],
    now: () => (clock += 50),
    sleep: async (ms: number) => { sleeps.push(ms); },
    lastSnapshotRef: { current: snap },
    ...(o.probe ? { probe: o.probe } : {}),
    ...(o.w1 ? { w1: o.w1 } : {}),
    spec: { goal: 'W5-6 稳态门基准', successCriteria: ['完成'] },
    width: 512,
    height: 384,
  };
  return { execute: createExecute(deps), sleeps };
}

/** 标准点击目标：中心 (256,192) → 屏幕像素 (960,540) */
function clickAction(): PolicyAction {
  return {
    kind: 'click',
    target: { bbox: { x0: 200, y0: 160, x1: 312, y1: 224 }, center: { x: 256, y: 192 }, label: '目标' },
    rationale: 'W5-6 基准', expectedEffect: 'W5-6 基准', utility: 0.5, riskTier: 'benign',
  };
}

/**
 * 一次点击的脚本化世界：settlePollsToSteady = 判稳所需轮询数（1 = 两帧即稳）。
 * 每次点击消耗 1 before 样本 + (1 + settlePollsToSteady) 个门内样本。
 */
function worldSamples(clickIdx: number, pollsToSteady: number): FrameSample[] {
  const id = clickIdx * 10;
  const before = S(H0, H0, id + 1);
  if (pollsToSteady <= 1) {
    // 门内：g1=B(10) → 睡 150 → g2=B(12)（距离 2 ≤ 2 ⇒ 一轮判稳）
    return [before, S(B(10), B(10), id + 2), S(B(12), B(12), id + 3)];
  }
  // 两轮判稳：(B2,B8) 距离 6 > 2 续等；(B8,B10) 距离 2 ⇒ 稳
  return [before, S(B(2), B(2), id + 2), S(B(8), B(8), id + 3), S(B(10), B(10), id + 4)];
}

// ─── A5 基准 ───

test('W5-6/A5: 稳态门 —— 两帧即稳世界的等待当量相对固定等待缩减（声明 ≥40%，实测 50%）', async () => {
  const M = 6; // 点击数
  const restore = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async () => { /* 剧本键鼠 */ },
  });
  try {
    // 稳态门臂：生产缺省调参（150ms 轮询 × 汉明 ≤2 判稳）
    const gateSamples = Array.from({ length: M }, (_, i) => worldSamples(i, 1)).flat();
    const gateProbe = makeProbe(gateSamples);
    const gate = makeExecute({ probe: gateProbe.probe });
    const gateVerdicts = [];
    for (let i = 0; i < M; i++) gateVerdicts.push(await gate.execute(clickAction()));

    // 固定等待臂：同一代码注入固定等待语义（300ms 恒稳放行）
    const fixedSamples = Array.from({ length: M }, (_, i) => worldSamples(i, 1)).flat();
    const fixedProbe = makeProbe(fixedSamples);
    const fixed = makeExecute({
      probe: fixedProbe.probe,
      w1: { steadyPollMs: 300, steadyHamming: 64 }, // 容差放到恒稳 = 睡满 300ms 即放行
    });
    for (let i = 0; i < M; i++) await fixed.execute(clickAction());

    const gateWait = gate.sleeps.reduce((a, b) => a + b, 0);
    const fixedWait = fixed.sleeps.reduce((a, b) => a + b, 0);
    const reduction = 1 - gateWait / fixedWait;

    // 慢世界边界档（两轮判稳 ×2 次 + 一轮 ×4 次）—— 只呈报不断言（诚实边界）
    const slowMix = [1, 1, 1, 1, 2, 2];
    const slowSamples = slowMix.flatMap((p, i) => worldSamples(i, p));
    const slowProbe = makeProbe(slowSamples);
    const slow = makeExecute({ probe: slowProbe.probe });
    for (let i = 0; i < M; i++) await slow.execute(clickAction());
    const slowWait = slow.sleeps.reduce((a, b) => a + b, 0);
    const slowReduction = 1 - slowWait / fixedWait;

    console.log([
      `── W5-6/A5 稳态门等待当量（M=${M} 次点击，W1_EXEC_TUNING 缺省 poll=${W1_EXEC_TUNING.steadyPollMs}ms/hamming≤${W1_EXEC_TUNING.steadyHamming}）──`,
      `稳态门臂（两帧即稳）: 等待 ${gateWait}ms（${gate.sleeps.join('+')}）⇒ ${(gateWait / M).toFixed(0)}ms/动作`,
      `固定等待臂（300ms 档）: 等待 ${fixedWait}ms ⇒ ${fixedWait / M}ms/动作`,
      `缩减率 = 1 − ${gateWait}/${fixedWait} = ${(reduction * 100).toFixed(1)}%（声明 ≥40%）`,
      `边界档（混 2 个两轮判稳慢世界）: 等待 ${slowWait}ms ⇒ 缩减 ${(slowReduction * 100).toFixed(1)}%（< 40%，如实呈报）`,
    ].join('\n'));

    // 断言（声明值 vs 实测值）
    assert.ok(reduction >= 0.40, `两帧即稳世界等待缩减应 ≥40%（实测 ${(reduction * 100).toFixed(1)}%）`);
    assert.deepEqual(gate.sleeps, [150, 150, 150, 150, 150, 150], '门臂每动作恰一轮 150ms 轮询');
    assert.deepEqual(fixed.sleeps, [300, 300, 300, 300, 300, 300], '固定臂每动作恰 300ms');
    for (const v of gateVerdicts) {
      assert.equal(v.verification?.steady, true, '门臂全部判稳');
      assert.equal(v.verification?.steadyPolls, 1, '两帧即稳 ⇒ 一轮判稳');
      assert.equal(v.outcome, 'progress', '判稳放行后验证照常 progress');
    }
    assert.equal(gateProbe.calls.samples, 3 * M, '每动作 3 次 meta 采样（before + 门内两帧）');
    assert.ok(slowReduction < reduction, '慢世界边界档缩减率低于快世界档（单调性 sanity）');
  } finally {
    restore();
  }
});
