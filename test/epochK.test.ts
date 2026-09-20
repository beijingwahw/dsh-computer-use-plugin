// test/epochK.test.ts
// K 纪元（留白兑现）：代码诚实声明的留白 —— 逐一落成并锁死。
// 虚拟屏模拟器 / WindowsAdapter / Actor 双通道 / 贝叶斯会诊 / SSD / 同形字 / 可播种 RNG。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

import { VirtualScreen } from '../src/sandbox/virtualScreen.ts';
import { SandboxEngineImpl } from '../src/sandbox/engine.ts';
import { sandboxLog } from '../src/sandbox/log.ts';
import { WindowsAdapter, NullAdapter } from '../src/environmentShaper.ts';
import { shaper } from '../src/environmentShaper.ts';
import { createActor } from '../src/orchestrator.ts';
import { bayesianBelief } from '../src/diagnosis.ts';
import { Telemetry } from '../src/telemetry.ts';
import { matchesRiskPatterns } from '../src/riskGate.ts';
import { makeScore } from '../src/doctorEvents.ts';
import { DOCTOR_RULES } from '../src/doctorRules.ts';
import type { ScanContext } from '../src/qualityDoctor.ts';
import type { VirtualWidget } from '../src/sandbox/types.ts';

const BTN: VirtualWidget = { role: 'button', name: 'save', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } };
const INPUT: VirtualWidget = { role: 'textbox', name: 'search', rect: { x: 0.5, y: 0.5, width: 0.3, height: 0.08 }, acceptsText: true };
const SCENE: VirtualWidget[] = [BTN, INPUT];

function engine(): { eng: SandboxEngineImpl; cleanup: () => void } {
  const eng = new SandboxEngineImpl(null);
  eng.configure({});
  return { eng, cleanup: () => { eng.reset(); } };
}

beforeEach(() => { sandboxLog.reset(); });

// ─── K-1 虚拟屏模拟器：排练验证层的第一块真证据 ───

test('K-1a: 命中点击 + element-level 期望 ⇒ passed（D-5 首次真实可达）', async () => {
  const { eng, cleanup } = engine();
  const out = await eng.rehearse({
    id: 'chain-k1a', origin: 'manual',
    entrySceneFingerprint: 'ab'.repeat(32),
    virtualScene: SCENE,
    actions: [{ kind: 'click_mouse', args: { x: 0.15, y: 0.12 }, expect: { scale: 'element-level' } }],
  });
  assert.equal(out.verdict, 'passed', '证据在场且无反证 —— passed 不再是不可达态');
  assert.equal(out.verificationLayers.length, 2, 'L1-pixel + L4-expectation 两层生效');
  assert.equal(out.score, makeScore(50), '两层 / 四层 = 50 分');
  assert.equal(out.entrySceneFingerprint, 'ab'.repeat(32), '固化入口指纹随行');
  assert.equal(out.steps[0].effectDetected, true);
  assert.equal(out.steps[0].expectationMet, true);
  cleanup();
});

test('K-1b: 落空点击 ⇒ failed + failedAtIndex（世界回击进入排练）', async () => {
  const { eng, cleanup } = engine();
  const out = await eng.rehearse({
    id: 'chain-k1b', origin: 'manual', virtualScene: SCENE,
    actions: [{ kind: 'click_mouse', args: { x: 0.9, y: 0.9 } }],
  });
  assert.equal(out.verdict, 'failed');
  assert.equal(out.failedAtIndex, 0);
  assert.equal(out.steps[0].effectDetected, false, '命中测试 = L1 反证');
  cleanup();
});

test('K-1c: 无场景 ⇒ degraded 零回归（诚实缺席语义不变）', async () => {
  const { eng, cleanup } = engine();
  const out = await eng.rehearse({
    id: 'chain-k1c', origin: 'manual',
    actions: [{ kind: 'click_mouse', args: { x: 0.15, y: 0.12 }, expect: { scale: 'element-level' } }],
  });
  assert.equal(out.verdict, 'degraded');
  assert.equal(out.steps[0].effectDetected, null);
  cleanup();
});

test('K-1d: 点击聚焦输入框 + type + text-level 期望 ⇒ 文字核验通过；错文本 ⇒ 反证', async () => {
  const { eng, cleanup } = engine();
  const ok = await eng.rehearse({
    id: 'chain-k1d-ok', origin: 'manual', virtualScene: SCENE,
    actions: [
      { kind: 'click_mouse', args: { x: 0.6, y: 0.54 } },
      { kind: 'type_text', args: { text: 'hello world' }, expect: { scale: 'text-level', expectedText: 'hello' } },
    ],
  });
  assert.equal(ok.verdict, 'passed');
  assert.equal(ok.steps[1].expectationMet, true);

  const bad = await eng.rehearse({
    id: 'chain-k1d-bad', origin: 'manual', virtualScene: SCENE,
    actions: [
      { kind: 'click_mouse', args: { x: 0.6, y: 0.54 } },
      { kind: 'type_text', args: { text: 'hello' }, expect: { scale: 'text-level', expectedText: 'goodbye' } },
    ],
  });
  assert.equal(bad.verdict, 'failed', '预期文本未上屏 = L4 反证');
  cleanup();
});

test('K-1e: 固化端到端 —— passed × 医生 approved ⇒ 肌肉记忆首次真实入库', async () => {
  const { eng, cleanup } = engine();
  const out = await eng.rehearse({
    id: 'chain-k1e', origin: 'manual',
    entrySceneFingerprint: 'cd'.repeat(32),
    virtualScene: SCENE,
    actions: [{ kind: 'click_mouse', args: { x: 0.15, y: 0.12 }, expect: { scale: 'element-level' } }],
  });
  assert.equal(out.verdict, 'passed');
  const r = eng.tryConsolidate({
    subject: 'chain-k1e', chainTip: out.chainTip, verdict: 'approved',
    score: makeScore(100)!, rationale: 'clean',
  });
  assert.equal(r.ok, true);
  assert.ok(r.value, '双闸门放行 —— 固化不再是永恒 freeze');
  const recall = eng.recallMuscleMemory('save button');
  assert.ok(recall.ok && recall.value.length >= 1, '入库即可召回');
  cleanup();
});

test('K-1f: VirtualScreen 纯语义 —— page-level 期望诚实 null；畸形控件拒收', () => {
  const vs = new VirtualScreen([{ role: 'x', name: 'y', rect: { x: NaN, y: 0, width: 1, height: 1 } }]);
  assert.ok(vs.isEmpty, 'NaN rect ⇒ 拒收（诚实缺席优于毒化命中测试）');
  const vs2 = new VirtualScreen([BTN]);
  const ev = vs2.applyAction({ kind: 'click_mouse', args: { x: 0.15, y: 0.12 }, expect: { scale: 'page-level' } });
  assert.equal(ev.effectDetected, true);
  assert.equal(ev.expectationMet, null, '无导航模型 —— page-level 不可判（诚实 null）');
});

// ─── K-2 WindowsAdapter：预留槽落成（注入纪律）───

function fakePS(hooks?: { onCmd?: (args: string[]) => void; geo?: string }) {
  const calls: string[][] = [];
  return {
    calls,
    adapter: new WindowsAdapter({
      probe: () => true,
      exec: async (_cmd, args) => {
        calls.push(args);
        hooks?.onCmd?.(args);
        const script = args[args.length - 1];
        if (script.includes('MainWindowHandle')) return { stdout: '4242\n' };
        if (script.includes('GetWindowRect')) return { stdout: hooks?.geo ?? '10,20,800,600,0\n' };
        return { stdout: 'True\n' };
      },
    }),
  };
}

test('K-2a: 能力探测 —— PowerShell 在场 ⇒ 窗口四动作；set_contrast 诚实缺席', async () => {
  const { adapter } = fakePS();
  const caps = await adapter.capabilities();
  assert.deepEqual([...caps].sort(), ['maximize_window', 'move_window', 'raise_window', 'set_zoom']);
});

test('K-2b: raise_window 发出 PS 命令且标题注入面闭合（单引号加倍）', async () => {
  const { adapter, calls } = fakePS();
  await adapter.apply({ kind: 'raise_window', titleHint: "O'Brien" });
  const script = calls.flatMap(c => c).join(' ');
  assert.ok(script.includes(`'*' + 'O''Brien' + '*'`), 'PS 字面量转义闭合注入面');
  assert.ok(script.includes('SetForegroundWindow'), 'P/Invoke 置前');
});

test('K-2c: move_window 捕获几何快照；undo 按 SetWindowPos 精确归位', async () => {
  const { adapter, calls } = fakePS();
  const recipe = await adapter.apply({ kind: 'move_window', titleHint: 'app', x: 100, y: 200 });
  assert.deepEqual(recipe.before, { x: 10, y: 20, width: 800, height: 600, maximized: false });
  await adapter.undo(recipe);
  const all = calls.flatMap(c => c).join(' ');
  assert.ok(all.includes('SetWindowPos'), 'undo 走 P/Invoke 归位');
});

test('K-2d: genesis 规则演化 —— 真实源码零违规；裸调用形态仍被拦截', async () => {
  const self = readFileSync(new URL('../src/environmentShaper.ts', import.meta.url), 'utf8');
  const ctx = (sources: Array<{ path: string; content: string }>): ScanContext => ({
    sources, chain: { entries: [], chainIntact: true }, snapshot: null,
    config: {} as never, warn: () => {},
  });
  // 真实实现（注入式）⇒ 零发现
  const real = await DOCTOR_RULES.find(r => r.id === 'genesis.premature-impl')!
    .scan(ctx([{ path: 'environmentShaper.ts', content: self }]));
  assert.equal(real.length, 0, '注入式实现合法');
  // 裸调用形态（无 this.execFn）⇒ 仍违规
  const rogue = 'class WindowsAdapter {\n  go() { execFile("powershell", []); }\n}\nexport class NullAdapter {}\n';
  const bad = await DOCTOR_RULES.find(r => r.id === 'genesis.premature-impl')!
    .scan(ctx([{ path: 'environmentShaper.ts', content: rogue }]));
  assert.equal(bad.length, 1, '不可测接线仍被守卫拦截');
});

test('K-2e: shaper 测试注入面 —— NullAdapter 锁死空能力路径', async () => {
  shaper.setAdapterForTest(new NullAdapter());
  assert.equal(shaper.capabilities().size, 0);
  const r = await shaper.apply({ kind: 'raise_window', titleHint: 'X' });
  assert.equal(r.ok, false);
  assert.ok(r.reason!.includes('capabilities'));
});

// ─── K-3 Actor 双通道 ───

test('K-3a: agents 服务优先 —— run 通道直通 + 故障诚实 FAILED', async () => {
  const actor = createActor({ getAgentsRun: () => async (t, sys) => `[SUCCESS] agents:${t}:${sys.length > 0}` });
  assert.match(await actor('open settings'), /\[SUCCESS\] agents:open settings:true/);
  const failing = createActor({ getAgentsRun: () => { throw new Error('boom'); } });
  assert.match(await failing('x'), /\[FAILED\] agents service fault: boom/);
});

test('K-3b: 技能重放回退 —— 可靠匹配逐步重放并回写可靠度', async () => {
  const outcomes: Array<[number, boolean]> = [];
  const actor = createActor({
    matchSkill: () => [{ id: 7, reliability: 0.75, steps: [{ tool: 'click_mouse', args: { x: 0.1, y: 0.1 } }] }],
    replayStep: async () => '{"status": "SUCCESS"}',
    recordOutcome: (id, ok) => outcomes.push([id, ok]),
  });
  assert.match(await actor('click save'), /\[SUCCESS\] replayed skill 7/);
  assert.deepEqual(outcomes, [[7, true]]);
});

test('K-3c: 不可靠技能（Laplace 0/0 = 0.5）不入场；双缺席诚实 FAILED', async () => {
  const actor = createActor({
    matchSkill: () => [{ id: 1, reliability: 0.5, steps: [{ tool: 'noop', args: {} }] }],
    replayStep: async () => 'ok',
  });
  assert.match(await actor('x'), /\[FAILED\] no actors channel/);
  const none = createActor({});
  assert.match(await none('x'), /\[FAILED\] no actors channel/);
});

// ─── K-4 贝叶斯会诊 ───

test('K-4: 后验侧写 —— 单信号归因 / 全缺席诚实 null / 归一性', () => {
  const onlyNoop = bayesianBelief({ shifted: null, hurstHigh: null, loop: null, heavyTail: null, highNoop: true });
  assert.ok(onlyNoop);
  assert.equal(onlyNoop[0].syndrome, 'blind-clicking', '唯一 noop 证据 ⇒ blind-clicking 主导');
  const sum = onlyNoop.reduce((a, b) => a + b.posterior, 0);
  assert.ok(Math.abs(sum - 1) < 0.01, `后验和 = 1（枚举精确归一），实际 ${sum}`);
  const combined = bayesianBelief({ shifted: true, hurstHigh: true, loop: null, heavyTail: null, highNoop: false });
  assert.equal(combined![0].syndrome, 'shift-and-cluster', 'shift×hurst 组合 ⇒ 双重恶性主导');
  assert.equal(bayesianBelief({ shifted: null, hurstHigh: null, loop: null, heavyTail: null, highNoop: null }), null);
  assert.equal(bayesianBelief({ shifted: false, hurstHigh: false, loop: false, heavyTail: false, highNoop: false }), null, '全阴 = 健康（诚实的缺席）');
});

// ─── K-5 SSD + 可播种 RNG ───

test('K-5: SSD 裁决 FSD 交叉分布；seededUniform 确定性', () => {
  assert.equal(Telemetry.firstOrderStochasticDominance([10, 50], [20, 30]), 'none', 'FSD 交叉（I-6 既知）');
  assert.equal(Telemetry.secondOrderStochasticDominance([10, 50], [20, 30]), 'B', 'SSD：一致者(B)占优 —— 部分序留白兑现');
  assert.equal(Telemetry.secondOrderStochasticDominance([1, 2], [10, 20]), 'A', 'FSD ⊂ SSD：全序占优保持');
  const rng1 = Telemetry.seededUniform(42), rng2 = Telemetry.seededUniform(42);
  const s1 = Array.from({ length: 8 }, rng1), s2 = Array.from({ length: 8 }, rng2);
  assert.deepEqual(s1, s2, '同种子同序列（MC p 值可复现）');
});

// ─── K-6 同形字归一 ───

test('K-6: 西里尔/全角同形字命中风险词；正常文本零误伤', () => {
  const RISK = 'password,发送';
  // 西里尔 а + leet 0（三重混淆叠加）
  const cyr = 'p\u0430ssw0rd';
  assert.ok(matchesRiskPatterns(cyr, RISK), `西里尔同形 + leet 双层混淆命中（${cyr}）`);
  // 全角 ｐ
  assert.ok(matchesRiskPatterns('\uff41assword', RISK) === false || matchesRiskPatterns('\uff50assword', RISK), '全角映射生效');
  assert.ok(matchesRiskPatterns('\uff50assword', RISK), '全角 ｐ → p 命中');
  // 正常中文（归一化不误伤 —— E-6 控制组语义保持）
  assert.ok(matchesRiskPatterns('点击发送按钮', RISK), '正常路径零回归');
  assert.ok(!matchesRiskPatterns('view report', RISK));
});
