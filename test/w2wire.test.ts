// test/w2wire.test.ts
// W2-0（第1批集成接线包）单测：把 9 位同事交付的接线面逐条验证「接通且受控」——
//   ① config 字段缺省值正确落位（Schema 缺省 = W1_EXEC_TUNING 原值）；
//   ② buildAutonomyStack 注入后新路径激活（probe 在场 precheckClick 生效 /
//      focus 焦点短路生效 / 免看门控可触发 / 开关关闭即降级）；
//   ③ verifyClient 两处接线（runtime 缺省接地 + orchestration L3 适配器）受
//      grounding.verifyZoom 内核键控制；
//   ④ 点击命中 recordTaskAnchor + 编码侧 suggestFoveaCenter 消费。
// 全离线确定性：假截屏（sharp 现场生成真 PNG）、假 system 键鼠（monkey-patch）、
// 假 GLM client（chatJson 桩）、注入时钟零真睡。参考 w1exec/w1gate/w1zoom 注入风格。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { default as sharp } from 'sharp';
import { system } from '../src/system.ts';
import { Config as ConfigSchema, type Config } from '../src/config.ts';
import {
  buildAutonomyStack,
  createExecute,
  createPerceive,
  runAutonomousLoop,
  GoalStateMachine,
  W1_EXEC_TUNING,
  type RuntimeDeps,
  type PolicyAction,
  type ExecOutcome,
} from '../src/autonomy/index.ts';
import type { ExecWorldProbe } from '../src/physicalExecution/execProbe.ts';
import { focusTracker } from '../src/focusTracker.ts';
import { contextManager } from '../src/contextManager.ts';
import { kernelRegistry } from '../src/kernel/registry.ts';
import { resetVerifyGateBudget } from '../src/vlm/grounding.ts';
import { createSemanticFromVlm } from '../src/orchestration/visionAdapters.ts';
import type { GlmClient } from '../src/vlm/glmClient.ts';

// ─── 假件工坊 ───

/** system 键鼠 monkey-patch（system 是可变对象字面量 —— 恢复器还原原样） */
type SystemPatch = Partial<Record<'clickMouse' | 'typeText' | 'scroll' | 'pressHotkey' | 'getScreenSize' | 'dragMouse', unknown>>;
function patchSystem(over: SystemPatch): () => void {
  const saved: Record<string, unknown> = {};
  const host = system as unknown as Record<string, unknown>;
  for (const key of Object.keys(over)) {
    saved[key] = host[key];
    host[key] = (over as Record<string, unknown>)[key];
  }
  return () => { for (const key of Object.keys(over)) host[key] = saved[key]; };
}

/** 渐变 PNG：vertical=false 横向渐变（dhash ≈ 全 1），true 纵向渐变 —— 确定性变化向量 */
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

/** chatJson 假 client（grounding/OCR 消费面）：jsonMode 分派回放，记录全部请求 */
function fakeGlmClient(opts: {
  groundingValue: () => unknown;
  ocrValue?: () => unknown;
  chatValue?: () => { ok: boolean; text?: string; error?: string };
}): { client: GlmClient; chatJsonCalls: unknown[]; chatCalls: unknown[] } {
  const chatJsonCalls: unknown[] = [];
  const chatCalls: unknown[] = [];
  const client = {
    configured: true,
    chatJson: async (req: unknown) => {
      chatJsonCalls.push(req);
      const jsonMode = (req as { jsonMode?: unknown } | null)?.jsonMode === true;
      const value = jsonMode ? opts.groundingValue() : (opts.ocrValue?.() ?? { words: [] });
      return { ok: true, value, raw: '' };
    },
    chat: async (req: unknown) => {
      chatCalls.push(req);
      const v = opts.chatValue ? opts.chatValue() : { ok: true, text: '云脑答：看起来正常。' };
      return v;
    },
  } as unknown as GlmClient;
  return { client, chatJsonCalls, chatCalls };
}

/** 手写全默认 autonomy 配置（可局部覆盖 —— 与 autonomy.integration.test.ts 同法） */
function makeConfig(over: Partial<Config> = {}): Config {
  return {
    autonomyEnabled: true,
    autonomyMaxSteps: 24,
    autonomyTimeBudgetSec: 300,
    autonomyAllowTiers: 'benign',
    autonomyVlmWhenUncertain: true,
    autonomyForbiddenKeywords: '',
    ...over,
  } as Config;
}

/** grounding.verifyZoom 内核键的注册/开/关（测试自管 —— 生产由 src/index.ts 铸入） */
function registerVerifyZoomKernel(): void {
  kernelRegistry.register({
    key: 'grounding.verifyZoom', organ: 'perception',
    defaultValue: 1, min: 0, max: 1, note: 'W2-0 测试注册',
  });
}

// 全局隔离：文件级 before/after 清零跨测试单例（焦点/锚点/内核/复核预算）
before(() => {
  focusTracker.clear();
  contextManager.clearTaskAnchor();
  registerVerifyZoomKernel();
  kernelRegistry.set('grounding.verifyZoom', 1);
  resetVerifyGateBudget();
});
after(() => {
  focusTracker.clear();
  contextManager.clearTaskAnchor();
  kernelRegistry.set('grounding.verifyZoom', 1);
  resetVerifyGateBudget();
});

// ─── W2-A：config 字段缺省值正确落位 ───

test('W2-A①: Schema 缺省 —— autonomyW1 组 16 调参与 W1_EXEC_TUNING 原值逐一同名等值', () => {
  const resolve = ConfigSchema as unknown as (v: unknown) => Config;
  const cfg = resolve({});
  // 调参全集：W1_EXEC_TUNING 的每个键 → autonomyW1<Capitalize> 字段同值
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
  const cfgRec = cfg as unknown as Record<string, unknown>;
  for (const key of Object.keys(W1_EXEC_TUNING) as Array<keyof typeof W1_EXEC_TUNING>) {
    const field = `autonomyW1${cap(key)}`;
    assert.equal(
      cfgRec[field], (W1_EXEC_TUNING as Record<string, number>)[key],
      `缺省 ${field} 应等于 W1_EXEC_TUNING.${key}`,
    );
  }
  // 开关与门控缺省
  assert.equal(cfg.autonomyW1Exec, true, '执行层接线总开关缺省开');
  assert.equal(cfg.autonomyW1FrameGate, true, '免看门控接线缺省开');
  assert.equal(cfg.autonomyW1GateHammingTolerance, 3);
  assert.equal(cfg.autonomyW1GatePollIntervalMs, 250);
  assert.equal(cfg.autonomyW1GatePollMaxMs, 2000);
  assert.equal(cfg.autonomyW1GateMaxConsecutiveSkips, 1);
  assert.equal(cfg.vlmZoomVerify, true, 'Zoom 复核开关缺省开');
  assert.equal(cfg.somSparseBudget, 0, '稀疏 SoM 预算缺省 0 = 关闭（输出面不变）');
});

test('W2-A②: buildAutonomyStack 的 w1 调参映射 —— 覆盖生效、脏值拒收、开关关全缺席', () => {
  const deps1: RuntimeDeps = {};
  buildAutonomyStack(makeConfig({ autonomyW1SteadyPollMs: 77, autonomyW1ClickRetryMax: 3 }), deps1);
  assert.ok(deps1.w1, '有效覆盖 ⇒ deps.w1 在场');
  assert.equal(deps1.w1!.steadyPollMs, 77);
  assert.equal(deps1.w1!.clickRetryMax, 3);
  assert.equal(deps1.w1!.roiRadiusPx, undefined, '未覆盖键不进覆盖表（runtime 回声常量缺省）');

  const deps2: RuntimeDeps = {};
  buildAutonomyStack(makeConfig({ autonomyW1SteadyPollMs: Number.NaN, autonomyW1RoiRadiusPx: -5 } as Partial<Config>), deps2);
  assert.equal(deps2.w1, undefined, '全部脏值（NaN/负数）⇒ 无覆盖表（W1_EXEC_TUNING 缺省生效）');

  const deps3: RuntimeDeps = {};
  buildAutonomyStack(makeConfig({ autonomyW1Exec: false }), deps3);
  assert.equal(deps3.probe, undefined, '总开关关 ⇒ 探针缺席');
  assert.equal(deps3.focus, undefined, '总开关关 ⇒ 焦点源缺席');
  assert.equal(deps3.w1, undefined, '总开关关 ⇒ 调参覆盖缺席');
});

// ─── W2-B：buildAutonomyStack 注入后新路径激活 ───

test('W2-B①: 缺省注入 —— probe/focus 就地补挂进 deps、显式注入不被顶掉、frameHash 入栈', async () => {
  const deps: RuntimeDeps = {};
  const stack = buildAutonomyStack(makeConfig(), deps);
  assert.ok(deps.probe, '缺省 ⇒ 探针就地补挂（createExecute 随行消费）');
  assert.ok(deps.focus, '缺省 ⇒ 焦点源就地补挂');
  assert.ok(typeof stack.frameHash === 'function', 'frameHash 随栈入环（runAutonomousLoop 消费面）');

  // 显式注入优先：buildAutonomyStack 绝不顶掉调用方的假件
  const fakeProbe = { sampleFrame: async () => null } as ExecWorldProbe;
  const deps2: RuntimeDeps = { probe: fakeProbe };
  buildAutonomyStack(makeConfig(), deps2);
  assert.equal(deps2.probe, fakeProbe, '显式 probe 原样保留');

  // frameHash 轻实现：真 PNG ⇒ 非空指纹；垃圾 buffer ⇒ null（诚实降级方言）。
  // 纪律：frameHash 的 capture 源必须显式注入（deps.capture）—— 缺省回
  // backend.captureCleanPng 会拉起真实物理服务（测试污染源，绝不允许）。
  const png = await gradientPng(64, 48, false);
  const deps3: RuntimeDeps = { capture: async () => png };
  const stack3 = buildAutonomyStack(makeConfig(), deps3);
  const h1 = await stack3.frameHash!();
  const h2 = await stack3.frameHash!();
  assert.ok(typeof h1 === 'string' && h1.length > 0, '真图 ⇒ 指纹在场');
  assert.equal(h1, h2, '同图同指纹（确定性）');
  const deps4: RuntimeDeps = { capture: async () => Buffer.from('not-an-image') };
  const stack4 = buildAutonomyStack(makeConfig(), deps4);
  assert.equal(await stack4.frameHash!(), null, '垃圾 buffer ⇒ null（门控按不可判降级）');

  // 开关关 ⇒ 端口与配置双双缺席（autoPilot 门控整体降级）
  const stack5 = buildAutonomyStack(makeConfig({ autonomyW1FrameGate: false }), {});
  assert.equal(stack5.frameHash, undefined);
  assert.equal(stack5.perceptionGate, undefined);
});

test('W2-B②: probe 在场 ⇒ precheckClick 生效 —— hitTest 判纯文本 + 光标无 hand ⇒ 免截屏短路', async () => {
  const pngA = await gradientPng(512, 384, false);
  const pngB = await gradientPng(512, 384, true);
  let clicked = false;
  let captures = 0;
  const clicks: Array<{ x: number; y: number }> = [];
  const restore = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async (x: number, y: number) => { clicks.push({ x, y }); clicked = true; },
  });
  try {
    // 探针：结构层判 text（非 Edit）、光标 ibeam —— A3①③ 的否决证据链
    const probe: ExecWorldProbe = {
      hitTestPoint: async () => ({ available: true, classification: 'text', controlType: 'Static' }),
      cursorKind: async () => 'ibeam',
      sampleFrame: async () => null,
    };
    const deps: RuntimeDeps = {
      capture: async () => { captures++; return clicked ? pngB : pngA; },
      readWords: async () => [],
      groundVlm: async () => [],
      probe,
      now: () => 1_000,
      sleep: async () => { /* 零真睡 */ },
    };
    const execute = createExecute({ ...deps, spec: { goal: 'g', successCriteria: [] } });
    const action: PolicyAction = {
      kind: 'click',
      target: { bbox: { x0: 100, y0: 100, x1: 200, y1: 140 }, center: { x: 150, y: 120 }, label: '静态文本' },
      rationale: 'r', expectedEffect: 'e', utility: 0.5, riskTier: 'benign',
    };
    const out = await execute(action);
    assert.equal(out.outcome, 'no_effect', '预检否决 ⇒ 免截屏短路');
    assert.ok(out.note?.includes('预检否决'), `附注应含预检归因（实际 ${out.note}）`);
    assert.equal(clicks.length, 0, '判死目标绝不派发');
    assert.equal(captures, 0, '免截屏 —— 预检短路零截屏');

    // 反证：探针缺席（同一动作）⇒ 照旧派发（接线前行为）
    const depsBare: RuntimeDeps = {
      capture: deps.capture, readWords: deps.readWords, groundVlm: deps.groundVlm,
      now: deps.now, sleep: deps.sleep,
    };
    const executeBare = createExecute({ ...depsBare, spec: { goal: 'g', successCriteria: [] } });
    const out2 = await executeBare(action);
    assert.equal(out2.outcome, 'progress', '无探针 ⇒ 派发且屏幕判变（旧路径）');
    assert.equal(clicks.length, 1);
  } finally {
    restore();
  }
});

test('W2-B③: focus 注入 ⇒ 焦点短路生效 —— 同目标二次点击免重复派发；未接线则照旧派发', async () => {
  const pngA = await gradientPng(512, 384, false);
  const pngB = await gradientPng(512, 384, true);
  let clicked = false;
  const clicks: Array<{ x: number; y: number }> = [];
  const restore = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async (x: number, y: number) => { clicks.push({ x, y }); clicked = true; },
  });
  try {
    focusTracker.clear();
    contextManager.clearTaskAnchor();
    const mkDeps = (): RuntimeDeps => ({
      capture: async () => (clicked ? pngB : pngA),
      readWords: async () => [],
      groundVlm: async () => [],
      now: () => 1_000,
      sleep: async () => { /* 零真睡 */ },
    });
    const action: PolicyAction = {
      kind: 'click',
      target: { bbox: { x0: 100, y0: 100, x1: 200, y1: 140 }, center: { x: 150, y: 120 }, label: '按钮' },
      rationale: 'r', expectedEffect: 'e', utility: 0.5, riskTier: 'benign',
    };

    // 接线路径：buildAutonomyStack 就地补挂 focus ⇒ createExecute 随行消费
    const deps = mkDeps();
    buildAutonomyStack(makeConfig(), deps);
    const execute = createExecute({ ...deps, spec: { goal: 'g', successCriteria: [] } });
    const out1 = await execute(action);
    assert.equal(out1.outcome, 'progress', '首发点击：屏幕判变');
    assert.equal(clicks.length, 1);
    const out2 = await execute(action);
    assert.equal(out2.outcome, 'no_effect', '同目标二次点击：焦点短路');
    assert.ok(out2.note?.includes('焦点短路'), `附注应含短路归因（实际 ${out2.note}）`);
    assert.equal(clicks.length, 1, '短路 ⇒ 零派发');
    // W2-D 联动取证：命中点击已登记任务锚点（bbox+viewport → normalized 在场）
    const anchor = contextManager.getTaskAnchor();
    assert.ok(anchor, '点击命中 ⇒ 任务锚点登记');
    assert.ok(anchor.normalized, '带视口 ⇒ normalized 在场');
    assert.ok(Math.abs(anchor.normalized!.x - 150 / 1920) < 1e-9);
    assert.ok(Math.abs(anchor.normalized!.y - 120 / 1080) < 1e-9);
    const gaze = contextManager.suggestFoveaCenter();
    assert.equal(gaze.route, 'grounding', '锚点路胜出（先验 0.9 × 相关度）');
    assert.ok(Math.abs(gaze.center.x - 150 / 1920) < 1e-9, '编码侧消费面：注视中心 = 锚点归一化中心');

    // 反证：未经 buildAutonomyStack 接线（focus 缺席）⇒ 同目标照旧派发
    focusTracker.clear();
    contextManager.clearTaskAnchor();
    clicked = false;
    clicks.length = 0;
    const depsBare = mkDeps();
    const executeBare = createExecute({ ...depsBare, spec: { goal: 'g', successCriteria: [] } });
    await executeBare(action);
    await executeBare(action);
    assert.equal(clicks.length, 2, '焦点源缺席 ⇒ 二次点击照旧派发（接线前行为）');
  } finally {
    restore();
    focusTracker.clear();
    contextManager.clearTaskAnchor();
  }
});

test('W2-B④: frameHash 接线后免看门控可触发 —— no-impact 步后屏未变 ⇒ 跳过重型感知', async () => {
  const png = await gradientPng(512, 384, false); // 全程同一张屏（未变）
  const words = [{ label: '任务启动', bbox: { x0: 100, y0: 100, x1: 200, y1: 140 }, confidence: 0.9 }];
  const mkDeps = (): RuntimeDeps => ({
    capture: async () => png,
    readWords: async () => words,
    groundVlm: async () => [],
    now: (() => { let c = 0; return () => (c += 50); })(),
    sleep: async () => { /* 零真睡 */ },
  });
  const declareAction: PolicyAction = {
    kind: 'declare', rationale: '接线测试', expectedEffect: '', utility: 0.5, riskTier: 'benign',
  };
  // PolicyDecision 全字段桩（uncertain/degraded 为必填面 —— 测试桩诚实置缺省）
  const stubPolicy = {
    decide: async () => ({ action: declareAction, uncertain: false, degraded: false }),
  };
  // 非空且永不命中的判据：空判据会被目标机 blocked-at-begin 熔断（零步收场）
  const neverMet = { goal: 'g', successCriteria: ['永不出现的判据字面XYZ'], maxSteps: 4 };

  // 接线路径：buildAutonomyStack 缺省注入 frameHash + perceptionGate
  const deps = mkDeps();
  const stack = buildAutonomyStack(makeConfig(), deps);
  let perceiveCalls = 0;
  const perceive = async () => { perceiveCalls++; return stack.perceive(); };
  const goal = new GoalStateMachine(neverMet, deps.now);
  const res = await runAutonomousLoop({
    ...stack, perceive, policy: stubPolicy,
    execute: async (): Promise<ExecOutcome> => ({ outcome: 'no_effect' }),
    goal,
  });
  assert.ok(res.summary.includes('免看门控：触发'), `总汇报应含门控记账（实际 ${res.summary}）`);
  assert.ok(
    res.trajectory.some(r => (r.note ?? '').includes('免看门控')),
    '跳过步的 journal 应留痕',
  );
  assert.equal(res.steps, 3, '3 步（目标机 no_effect 熔断先于步保险丝）');
  assert.equal(perceiveCalls, 2, '跳-看节律：3 轮仅 2 次重型感知（连续跳过上限 1）');

  // 反证：开关关 ⇒ 门控整体降级（每轮照旧感知，与接线前逐字节同路径）
  const depsOff = mkDeps();
  const stackOff = buildAutonomyStack(makeConfig({ autonomyW1FrameGate: false }), depsOff);
  let perceiveCallsOff = 0;
  const perceiveOff = async () => { perceiveCallsOff++; return stackOff.perceive(); };
  const goalOff = new GoalStateMachine(neverMet, depsOff.now);
  const resOff = await runAutonomousLoop({
    ...stackOff, perceive: perceiveOff, policy: stubPolicy,
    execute: async (): Promise<ExecOutcome> => ({ outcome: 'no_effect' }),
    goal: goalOff,
  });
  assert.ok(!resOff.summary.includes('免看门控'), '关闸 ⇒ 零门控记账');
  assert.equal(resOff.steps, 3, '关闸同律 3 步');
  assert.equal(perceiveCallsOff, 4, '关闸 ⇒ 每轮完整感知（含被宪法否决前的第 4 轮）');
});

// ─── W2-C：verifyClient 两处接线（grounding.verifyZoom 内核键控制） ───

/** 200x150 纯灰 PNG：提示词系 = 编码系 = buffer 系（无缩放干扰） */
async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 96, g: 96, b: 96 } } })
    .png().toBuffer();
}

test('W2-C①: visionAdapters L3 接线 —— verifyClient 注入后低置信元素触发 Zoom 复核；内核键关 ⇒ 端口缺席', async () => {
  const png = await makePng(200, 150);
  const FULL_REGION = { id: 'g0x0', x: 0, y: 0, width: 1, height: 1 };
  // 低置信（0.5 < 0.6）单元素：文本身份清晰 ⇒ 复核可走 agree/adopted 全链
  const fake = fakeGlmClient({
    groundingValue: () => ({ elements: [{ id: 'x', label: '低置信按钮', role: 'button', bbox: [20, 20, 90, 80], confidence: 0.5 }] }),
    ocrValue: () => ({ words: [{ text: '低置信按钮', confidence: 0.9, bbox: [20, 20, 90, 80] }] }),
  });
  const src = createSemanticFromVlm({
    capture: async () => png,
    screenSize: async () => ({ width: 200, height: 150 }),
    client: fake.client,
  });

  // 开（内核缺省/未设 ⇒ 1）：主定位 + 复核重grounding + 复核 OCR —— chatJson ≥ 2 次
  resetVerifyGateBudget();
  kernelRegistry.set('grounding.verifyZoom', 1);
  const els1 = await src.ground(FULL_REGION, '找按钮');
  assert.equal(els1.length, 1, '元素照常归一化产出');
  assert.ok(fake.chatJsonCalls.length >= 2, `复核流量应在场（实际 ${fake.chatJsonCalls.length} 次调用）`);

  // 关：verifyClient 缺席 ⇒ 触发事件 port-absent 放行，主 client 零复核流量
  resetVerifyGateBudget();
  fake.chatJsonCalls.length = 0;
  kernelRegistry.set('grounding.verifyZoom', 0);
  const els2 = await src.ground(FULL_REGION, '找按钮');
  assert.equal(els2.length, 1);
  assert.equal(fake.chatJsonCalls.length, 1, '关闸 ⇒ 仅主定位一次（复核端口缺席）');
  kernelRegistry.set('grounding.verifyZoom', 1);
});

test('W2-C②: runtime 缺省接地接线 —— createPerceive 的 groundVlm 路径带 verifyClient；内核键关 ⇒ 缺席', async () => {
  const png = await makePng(200, 150);
  const fake = fakeGlmClient({
    groundingValue: () => ({ elements: [{ id: 'x', label: '低置信按钮', role: 'button', bbox: [20, 20, 90, 80], confidence: 0.5 }] }),
    ocrValue: () => ({ words: [{ text: '低置信按钮', confidence: 0.9, bbox: [20, 20, 90, 80] }] }),
  });
  const mkDeps = (): RuntimeDeps => ({
    capture: async () => png,
    readWords: async () => [],
    dhashOf: async () => null, // 指纹缺席 ⇒ 场景语义缓存跳过（隔离观察面）
    client: fake.client,
  });

  // 开：perceive → makeDefaultGroundVlm → groundElements({client, verifyClient}) ⇒ 复核流量在场
  resetVerifyGateBudget();
  kernelRegistry.set('grounding.verifyZoom', 1);
  const snap1 = await createPerceive(mkDeps())();
  assert.ok(snap1.elements.length >= 1, 'VLM 元素照常入快照');
  assert.ok(fake.chatJsonCalls.length >= 2, `复核流量应在场（实际 ${fake.chatJsonCalls.length}）`);

  // 关：verifyClient 缺席 ⇒ 仅主定位一次
  resetVerifyGateBudget();
  fake.chatJsonCalls.length = 0;
  kernelRegistry.set('grounding.verifyZoom', 0);
  await createPerceive(mkDeps())();
  assert.equal(fake.chatJsonCalls.length, 1, '关闸 ⇒ 缺省接地仅主定位一次');
  kernelRegistry.set('grounding.verifyZoom', 1);
});

// ─── W2-D：编码侧消费（ask_vlm 的 foveaCenter 注视 + 建议性 requote 不破缺省档） ───

test('W2-D①: ask_vlm 编码消费 suggestFoveaCenter —— 中央凹开启时锚点改写出图（接线在场的端到端证据）', async () => {
  // 高频噪声图（确定性 LCG）：线性渐变对 blur 中央凹是不变量（模糊渐变 ≈ 渐变
  // 本身），注视位置不可观测 —— 必须用高频细节图才能让凹窗位置改写出图字节。
  const W = 512, H = 384;
  const noise = Buffer.alloc(W * H * 3);
  let seed = 0x2f6e2b1;
  for (let i = 0; i < noise.length; i += 3) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    noise[i] = seed & 0xff; noise[i + 1] = (seed >>> 8) & 0xff; noise[i + 2] = (seed >>> 16) & 0xff;
  }
  const png = await sharp(noise, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const restore = patchSystem({ getScreenSize: async () => ({ width: 1920, height: 1080 }) });
  // 中央凹开启（内核注册表 —— 生产由 config.foveatedEncoding 铸入，测试就地入册）
  kernelRegistry.register({ key: 'codec.foveated', organ: 'perception', defaultValue: 1, min: 0, max: 1, note: 'W2-0 测试注册' });
  kernelRegistry.set('codec.foveated', 1);
  try {
    const shoot = async (withAnchor: boolean): Promise<string> => {
      if (withAnchor) {
        // 锚点钉在左上角 —— 注视中心远偏几何中心（出图必然不同）
        assert.ok(contextManager.recordTaskAnchor({
          bbox: { x0: 10, y0: 10, x1: 60, y1: 60 },
          viewport: { width: 512, height: 384 },
        }));
      } else {
        contextManager.clearTaskAnchor();
      }      const fake = fakeGlmClient({ groundingValue: () => ({ elements: [] }) });
      const deps: RuntimeDeps = { capture: async () => png, client: fake.client, now: () => 1_000, sleep: async () => {} };
      const execute = createExecute({ ...deps, spec: { goal: 'g', successCriteria: [] } });
      const out = await execute({ kind: 'ask_vlm', rationale: 'r', expectedEffect: '', utility: 0.5, riskTier: 'benign', payload: { question: '看到了什么？' } });
      assert.ok(out.note?.includes('云脑答'), '云脑答入 note（问答链路完好）');
      assert.equal(fake.chatCalls.length, 1, '云脑问答一次');
      const req = fake.chatCalls[0] as { images?: Array<{ base64?: string }> };
      return req.images?.[0]?.base64 ?? '';
    };
    resetVerifyGateBudget();
    const withAnchor = await shoot(true);
    resetVerifyGateBudget();
    const noAnchor = await shoot(false);
    assert.notEqual(withAnchor, noAnchor, '锚点在场 ⇒ 注视中心改写中央凹位置 ⇒ 出图字节不同');
    assert.ok(withAnchor.length > 0 && noAnchor.length > 0);
  } finally {
    kernelRegistry.set('codec.foveated', 0);
    contextManager.clearTaskAnchor();
    restore();
  }
});

test('W2-D②: ask_vlm 缺省路径 —— requote 建议档 original ⇒ 编码参数不被显式覆盖（codec 注册表缺省保持）', async () => {
  const png = await gradientPng(512, 384, false);
  const restore = patchSystem({ getScreenSize: async () => ({ width: 1920, height: 1080 }) });
  try {
    contextManager.clearTaskAnchor();
    const fake = fakeGlmClient({ groundingValue: () => ({ elements: [] }) });
    const deps: RuntimeDeps = { capture: async () => png, client: fake.client, now: () => 1_000, sleep: async () => {} };
    const execute = createExecute({ ...deps, spec: { goal: 'g', successCriteria: [], maxSteps: 24 } });
    const out = await execute({ kind: 'ask_vlm', rationale: 'r', expectedEffect: '', utility: 0.5, riskTier: 'benign' });
    assert.ok(out.note?.includes('云脑答'), '问答照常入账');
    // 配额充裕（缺省 512MB/24 步）⇒ requote=original ⇒ 不显式传 quality/maxDimension
    // ⇒ 长边钉 codec 缺省 1568（512 宽源图不触发 resize，但质量/尺寸档未被压低 ——
    // 以出图可解码 + 问答链路完好为缺省不回归的取证）
    const req = fake.chatCalls[0] as { images?: Array<{ base64?: string }> };
    const bytes = Buffer.from(req.images?.[0]?.base64 ?? '', 'base64');
    assert.ok(bytes.length > 0, '出图非空');
  } finally {
    contextManager.clearTaskAnchor();
    restore();
  }
});

// ─── ΑΩ-R12：drag 端口接线（buildAutonomyStack → system.dragMouse 适配） ───

test('ΑΩ-R12: buildAutonomyStack 就地补挂 deps.drag —— system.dragMouse 像素直通、失败收敛不抛', async () => {
  const drags: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }> = [];
  let mode: 'ok' | 'fail' = 'ok';
  const restore = patchSystem({
    dragMouse: async (start: { x: number; y: number }, end: { x: number; y: number }) => {
      drags.push({ start, end });
      if (mode === 'fail') throw new Error('四拍时序失步');
    },
  });
  try {
    // ① 缺席补挂：铸栈后 deps.drag 在场（接线层 import system 破环，器官本体不碰）
    const deps: RuntimeDeps = {};
    buildAutonomyStack(makeConfig(), deps);
    assert.equal(typeof deps.drag, 'function', 'drag 端口就地补挂');

    // ② 像素四元组直通 system.dragMouse（start/end 对象方言），成功 ⇒ {ok:true}
    const okRes = await deps.drag!(11, 22, 333, 444);
    assert.deepEqual(okRes, { ok: true });
    assert.deepEqual(drags, [{ start: { x: 11, y: 22 }, end: { x: 333, y: 444 } }]);

    // ③ 底层抛错 ⇒ 收敛 {ok:false, error}（运行层铁律 —— 绝不抛）
    mode = 'fail';
    const badRes = await deps.drag!(1, 2, 3, 4);
    assert.equal(badRes.ok, false);
    assert.ok(badRes.error?.includes('四拍时序失步'), '错误归因透传');

    // ④ 显式注入优先：调用方自带端口不被顶掉（只填缺席位同律）
    const own = async () => ({ ok: true });
    const deps2: RuntimeDeps = { drag: own };
    buildAutonomyStack(makeConfig(), deps2);
    assert.equal(deps2.drag, own, '显式注入的假件优先');
  } finally {
    restore();
  }
});
