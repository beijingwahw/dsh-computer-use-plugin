// test/w8.finalwiring.test.ts
// W8-C1（收尾代理 · 终态接线执法册）：第 1/2 批代理备好接线位后的六处收口
// 件的接通且受控证明 ——
//   F-1 pilot 键闭环：runPilotLoop 生产接线 deps.verifyTaskId = `pilot:<token>`
//      （测试零注入 —— 环内 perceive 复核消费真落任务键账本，与起点
//      resetVerifyGateBudget(`pilot:<token>`) use/reset 同键；他任务键与缺省
//      账本不动 —— w3wire W3-B②② 测试侧注入形态的生产面兑现）；
//   F-2 会话键供电：visionAdapters 模块级武装（setVisionSessionIdProvider ——
//      setAccessibilityProvider 同款先例）—— 武装 ⇒ L3 ground 铸 `session:<id>`
//      键；显式入参 > 武装 > 缺席（⇒ 缺省账本旧路径）；供给抛错 ⇒ 诚实缺席；
//      源级断言 index.ts session/event 面的供电接线；
//   F-3 surpriseFeed 生接线冒烟：buildAutonomyStack 铸的栈内 prophecy 失手
//      结算即自动喂惊异消费单例 surpriseEvolution（真 EvolutionEngine ——
//      w8.prophecy G2-3 结构直收的生产面兑现；hit 不喂零掺水）；
//   F-4 run_skill 公证：技能重放完成铸 notary 锚（source='run_skill'）——
//      装配 ⇒ anchored（步指纹序列 + 三态结局 + 整体成败入锚）；公证缺席 ⇒
//      诚实降级标注（回放照常、锚链零增量）；
//   F-5 提示词文档：AUTONOMY_RUN_PROMPT 含 mustNotAppear 判据 DSL 说明
//      （W8-B4 criteriaEval 否定判据的模型可见面）。
// 全离线确定性：sharp 现场生成真 PNG、假 GLM client、monkey-patch 键鼠、
// 本地时间锚零网络。参考 w3wire/w8.replaynotary 注入风格。
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { default as sharp } from 'sharp';
import { system } from '../src/system.ts';
import { journal } from '../src/journal.ts';
import { notary } from '../src/notary/index.ts';
import { stopBackend } from '../src/physicalBackend.ts';
import { skillLibrary } from '../src/skillLibrary.ts';
import type { SkillStep } from '../src/skillLibrary.ts';
import { kernelRegistry } from '../src/kernel/registry.ts';
import { resetVerifyGateBudget, groundElements } from '../src/vlm/grounding.ts';
import type { GlmClient } from '../src/vlm/glmClient.ts';
import type { Config } from '../src/config.ts';
// F-1：跑环脊梁（生产接线的执法对象）
import { runPilotLoop } from '../src/tools/autonomousRun.ts';
import { GoalStateMachine, PilotStore } from '../src/autonomy/index.ts';
// F-2：L3 适配器 + 模块级会话武装面
import {
  createSemanticFromVlm,
  setVisionSessionIdProvider,
} from '../src/orchestration/visionAdapters.ts';
// F-3：栈铸造 + 惊异消费单例（autonomy 桶）+ 世界模型单例（prophecy 桶 —— miss 的预言源）
import { buildAutonomyStack, surpriseEvolution } from '../src/autonomy/index.ts';
import { prophecyWorldModel } from '../src/prophecy/index.ts';
// F-4：run_skill 工具面
import { createRunSkillTool } from '../src/tools/skillTools.ts';

// ─── 假件工坊（w3wire 同款） ───

/** 纯灰 PNG（提示词系 = 编码系 = buffer 系 —— 无缩放干扰） */
async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 96, g: 96, b: 96 } } })
    .png().toBuffer();
}

/** chatJson 假 client（grounding/OCR 消费面）：jsonMode 分派回放 */
function fakeGlmClient(opts: {
  groundingValue: () => unknown;
  ocrValue?: () => unknown;
}): { client: GlmClient } {
  const client = {
    configured: true,
    chatJson: async (req: unknown) => {
      const jsonMode = (req as { jsonMode?: unknown } | null)?.jsonMode === true;
      const value = jsonMode ? opts.groundingValue() : (opts.ocrValue?.() ?? { words: [] });
      return { ok: true, value, raw: '' };
    },
    chat: async () => ({ ok: true, text: '云脑答：正常。' }),
  } as unknown as GlmClient;
  return { client };
}

/** system 键鼠 monkey-patch（system 是可变对象字面量 —— 恢复器还原原样） */
function patchSystem(over: Partial<Record<'clickMouse' | 'typeText' | 'scroll' | 'pressHotkey' | 'getScreenSize', unknown>>): () => void {
  const saved: Record<string, unknown> = {};
  const host = system as unknown as Record<string, unknown>;
  for (const key of Object.keys(over)) {
    saved[key] = host[key];
    host[key] = (over as Record<string, unknown>)[key];
  }
  return () => { for (const key of Object.keys(over)) host[key] = saved[key]; };
}

/** 手写最小 autonomy 配置（w3wire 同法 —— 缺字段按 falsy 缺省走零行为臂） */
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

/** grounding.verifyZoom 内核键的注册/开（测试自管 —— 生产由 src/index.ts 铸入） */
function registerVerifyZoomKernel(): void {
  kernelRegistry.register({
    key: 'grounding.verifyZoom', organ: 'perception',
    defaultValue: 1, min: 0, max: 1, note: 'W8-C1 测试注册',
  });
}

/** 复核预算读数探针：ground 一次（低置信 ⇒ 复核 +1），返回该键账本读数 */
function budgetProbe(png: Buffer, client: GlmClient) {
  return async (taskId?: string): Promise<number> => {
    const r = await groundElements(png, {
      client, verifyClient: client, width: 200, height: 150,
      ...(taskId ? { verifyTaskId: taskId } : {}),
    });
    assert.ok(r.verifyGate, '闸开 ⇒ 复核报告在场');
    return r.verifyGate!.budgetUsed;
  };
}

const originals = {
  getScreenSize: system.getScreenSize.bind(system),
  clickMouse: system.clickMouse.bind(system),
  typeText: system.typeText.bind(system),
};

before(() => {
  registerVerifyZoomKernel();
  kernelRegistry.set('grounding.verifyZoom', 1);
  resetVerifyGateBudget();
  setVisionSessionIdProvider(null); // 武装面归零（单例隔离律 —— 供给缺席基线）
});

after(async () => {
  kernelRegistry.set('grounding.verifyZoom', 1);
  resetVerifyGateBudget();
  setVisionSessionIdProvider(null); // 不留模块级状态给后续文件
  system.getScreenSize = originals.getScreenSize;
  system.clickMouse = originals.clickMouse;
  system.typeText = originals.typeText;
  await stopBackend(); // 测试进程无卸载钩子 —— 显式关停懒拉起的物理微服务
});

// ─── F-1：pilot 键闭环（生产接线执法 —— 测试零注入） ───

test('F-1: runPilotLoop 生产注入任务键 —— 环内复核消费落 `pilot:<token>` 账本；他任务键与缺省账本零污染', async () => {
  const png = await makePng(200, 150);
  // 低置信（0.5 < 0.6）单元素 ⇒ 每次主定位触发一次 Zoom 复核（预算 +1）
  const fakeRun = fakeGlmClient({
    groundingValue: () => ({ elements: [{ id: 'x', label: '稳按钮', role: 'button', bbox: [20, 20, 90, 80], confidence: 0.5 }] }),
    ocrValue: () => ({ words: [] }),
  });
  const deps = {
    capture: async () => png,
    readWords: async () => [{ label: '任务启动', bbox: { x0: 10, y0: 10, x1: 60, y1: 30 }, confidence: 0.9 }],
    client: fakeRun.client,
    now: (() => { let c = 0; return () => (c += 50); })(),
    sleep: async () => { /* 零真睡 */ },
    // 刻意不注入 verifyTaskId —— 生产接线（runPilotLoop 脊梁铸造）的执法前提
  };
  const spec = {
    goal: 'g', successCriteria: ['永不出现的判据字面XYZ'], maxSteps: 2, timeBudgetSec: 5,
  };
  const nowFn = deps.now ?? (() => Date.now());
  const store = new PilotStore();
  const token = store.begin(spec, nowFn());
  const goalMachine = new GoalStateMachine(spec, nowFn);
  const budgetOf = budgetProbe(png, fakeRun.client);

  // 预铸：三个账本各 1（本轮 token 键 / 他任务键 / 缺省账本）
  resetVerifyGateBudget();
  assert.equal(await budgetOf(`pilot:${token}`), 1, '本轮 token 键预铸 1');
  assert.equal(await budgetOf('pilot:other'), 1, '他任务键预铸 1');
  assert.equal(await budgetOf(), 1, '缺省账本预铸 1');

  const restore = patchSystem({
    getScreenSize: async () => ({ width: 200, height: 150 }),
    clickMouse: async () => { /* 测试键鼠哑面 */ },
    typeText: async () => { /* 测试键鼠哑面 */ },
    scroll: async () => { /* 测试键鼠哑面 */ },
    pressHotkey: async () => { /* 测试键鼠哑面 */ },
  });
  let report = '';
  try {
    report = await runPilotLoop({
      toolName: 'autonomous_run', config: makeConfig(), deps, spec, goalMachine, store, token,
    });
  } finally {
    restore();
  }
  assert.equal(typeof report, 'string', '跑环返回锚点字符串（脊梁完整走通）');

  // 终态执法（w3wire W3-B②② 的生产面兑现 —— deps 零注入，键全由脊梁铸造）：
  //  · 本轮 token 键：起点 reset 清零 ⇒ 环内低置信 grounding 的 N 次复核（N≥1）
  //    自 0 记入本键 + 本探针 1 ⇒ ≥2 —— 生产接线真闭环；
  //  · 他任务键：不被本轮边界清零（1 预铸 + 探针 1 = 2）—— 并发任务互不侵占；
  //  · 缺省账本：环内零贡献（1 预铸 + 探针 1 = 2）—— 消费面已迁移任务键。
  const taskProbe = await budgetOf(`pilot:${token}`);
  assert.ok(taskProbe >= 2, `本轮 token 键 ⇒ 环内消费真落任务账本（≥2，实际 ${taskProbe}）`);
  assert.equal(await budgetOf('pilot:other'), 2, '他任务键不被本轮边界清零（隔离不侵占）');
  assert.equal(await budgetOf(), 2, '缺省账本零环内贡献（生产接线后消费面已迁移）');
});

test('F-1附: 源级断言 —— autonomousRun.ts 脊梁铸造任务键（拿掉接线即红）', () => {
  const src = readFileSync(new URL('../src/tools/autonomousRun.ts', import.meta.url), 'utf8');
  assert.match(src, /deps\.verifyTaskId = `pilot:\$\{token\}`;/, 'runPilotLoop 必须就地铸造 `pilot:<token>` 任务键');
});

// ─── F-2：会话键供电（模块级武装三态 + 裁决序 + 源级接线） ───

test('F-2: setVisionSessionIdProvider 武装三态 —— 武装铸 `session:<id>` 键 / 显式入参优先 / 卸下与供给故障 ⇒ 缺省账本', async () => {
  const png = await makePng(200, 150);
  const FULL_REGION = { id: 'g0x0', x: 0, y: 0, width: 1, height: 1 };
  const fake = fakeGlmClient({
    groundingValue: () => ({ elements: [{ id: 'x', label: '低置信按钮', role: 'button', bbox: [20, 20, 90, 80], confidence: 0.5 }] }),
    ocrValue: () => ({ words: [] }),
  });
  const budgetOf = budgetProbe(png, fake.client);
  const mkSrc = (sessionId?: () => string | undefined) => createSemanticFromVlm({
    capture: async () => png,
    screenSize: async () => ({ width: 200, height: 150 }),
    client: fake.client,
    ...(sessionId !== undefined ? { sessionId } : {}),
  });

  // ① 未武装 + 无显式入参 ⇒ 缺省账本旧路径（逐字节基线）
  resetVerifyGateBudget();
  await mkSrc().ground(FULL_REGION, '找按钮');
  assert.equal(await budgetOf(), 2, '缺省账本 = ground 消费 1 + 探针 1（武装前基线）');

  // ② 武装 ⇒ ground 消费落 `session:<id>` 键（与宿主回合边界 reset 同键形）
  resetVerifyGateBudget();
  setVisionSessionIdProvider(() => 'fw-42');
  await mkSrc().ground(FULL_REGION, '找按钮');
  assert.equal(await budgetOf('session:fw-42'), 2, '武装 ⇒ 会话键读数 = ground 消费 1 + 探针 1');
  assert.equal(await budgetOf(), 1, '缺省账本零贡献（L3 消费面已迁移会话键）');

  // ③ 裁决序：显式入参 > 模块级武装
  resetVerifyGateBudget();
  await mkSrc(() => 'fw-explicit').ground(FULL_REGION, '找按钮');
  assert.equal(await budgetOf('session:fw-explicit'), 2, '显式入参胜出');
  assert.equal(await budgetOf('session:fw-42'), 1, '武装键零消费（被显式入参遮蔽）');

  // ④ 武装的供给抛错 / 返回空串 ⇒ 诚实缺席 ⇒ 缺省账本（防御式绝不毒化主管线）
  resetVerifyGateBudget();
  setVisionSessionIdProvider(() => { throw new Error('boom'); });
  await mkSrc().ground(FULL_REGION, '找按钮');
  assert.equal(await budgetOf(), 2, '供给抛错 ⇒ 缺省账本（ground 照常完成）');
  resetVerifyGateBudget();
  setVisionSessionIdProvider(() => '   ');
  await mkSrc().ground(FULL_REGION, '找按钮');
  assert.equal(await budgetOf(), 2, '供给返回空白 ⇒ 键缺席 ⇒ 缺省账本');

  // ⑤ 卸下 ⇒ 回落缺省旧路径（W-1 单例隔离律）
  resetVerifyGateBudget();
  setVisionSessionIdProvider(null);
  await mkSrc().ground(FULL_REGION, '找按钮');
  assert.equal(await budgetOf(), 2, '卸下 ⇒ 供给缺席 ⇒ 缺省账本（逐字节旧路径）');
});

test('F-2附: 源级断言 —— index.ts session/event 面供电接线（setVisionSessionIdProvider 同源键）', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(src, /setVisionSessionIdProvider\(sid === null \? null : \(\) => sid\);/, 'session/event 面必须以当前会话 id 武装 L3 供给');
  assert.match(src, /resetVerifyGateBudget\(sid === null \? undefined : `session:\$\{sid\}`\);/, '边界清零与供电必须同源同键（use/reset 闭环）');
});

// ─── F-3：surpriseFeed 生接线冒烟（栈内 prophecy → 惊异消费单例） ───

test('F-3: buildAutonomyStack 生接线 —— 栈内 prophecy 失手结算自动喂 surpriseEvolution（真引擎直收；hit 零掺水）', () => {
  // 世界模型单例预铸转移（miss 的预言源）：(fw-s1 × fw-k1) → fw-r1 概率极高
  prophecyWorldModel.observe('fw-s1', 'fw-k1', 'fw-r1', true);
  const stack = buildAutonomyStack(makeConfig(), {});
  assert.ok(stack.prophecy, 'enableProphecy 缺省 ⇒ 栈内预言引擎在场');
  assert.equal(typeof stack.prophecy!.mint, 'function', 'ProphecyPort 铸造面在场');
  assert.equal(typeof stack.prophecy!.settle, 'function', 'ProphecyPort 结算面在场');

  const before = surpriseEvolution.history.length;
  // miss：预言 fw-r1（世界模型高置信）、实际 fw-r2 ⇒ 失手入账即自动喂
  stack.prophecy!.mint('fw-s1', 'fw-k1');
  const settled = stack.prophecy!.settle('fw-r2', true);
  assert.ok(settled, '结算记录在场');
  assert.equal(settled!.outcome, 'miss', '世界模型有预言而不符 ⇒ miss');
  assert.equal(surpriseEvolution.history.length, before + 1, '失手自动喂惊异消费单例（生接线推面）');
  assert.equal(surpriseEvolution.history.at(-1)!.success, false, '喂养记录 success=false（教训语义）');

  // hit 零掺水：预言命中 ⇒ 不喂（水位线只喂失手）
  stack.prophecy!.mint('fw-s1', 'fw-k1');
  stack.prophecy!.settle('fw-r1', true);
  assert.equal(surpriseEvolution.history.length, before + 1, '命中不喂（surpriseRunRecord 只喂失手）');
});

test('F-3附: 源级断言 —— autonomy/index.ts 栈铸造接 surpriseFeed（拿掉接线即红）', () => {
  const src = readFileSync(new URL('../src/autonomy/index.ts', import.meta.url), 'utf8');
  assert.match(src, /surpriseFeed: surpriseEvolution,/, 'ProphecyEngine 构造必须接惊异消费单例');
  assert.match(src, /const surpriseEvolution = new EvolutionEngine\(\);/, '惊异消费单例必须模块级铸造（跨栈跨 run 存活）');
});

// ─── F-4：run_skill 公证捕获 ───

/** run_skill 测试配置（w4macro toolCfg 同法 —— 闸门关、排练门禁走可靠度直放） */
const toolCfg = {
  enableApprovalGate: false, dangerPatterns: '', enableRiskGate: false, riskPatterns: '',
  maxTextLength: 1000, verifyActions: false, dryRun: false, replayMaxSteps: 100,
  enableJournal: true, enableSkillLibrary: true, enableRecombination: false,
} as unknown as Config;

type Executable = { execute: (a: unknown) => Promise<string> };
async function runJson(tool: unknown, args: unknown): Promise<any> {
  const out = await (tool as Executable).execute(args);
  return JSON.parse(out);
}

beforeEach(() => {
  notary.reset(); // 未装配缺省态（公证缺席面）；装配用例就地 configure
  journal.reset();
  skillLibrary.reset();
});

test('F-4a: 公证缺席 ⇒ run_skill 诚实降级标注（重放照常、锚链零增量）', async () => {
  let clicks = 0;
  const restore = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async () => { clicks++; },
    typeText: async () => { /* noop */ },
  });
  try {
    const steps: SkillStep[] = [{ tool: 'click_mouse', args: { x: 0.25, y: 0.25 } }];
    const s = skillLibrary.induce('打开设置', steps)!; // 1/1 ⇒ 0.667 过闸直放
    const out = await runJson(createRunSkillTool(toolCfg), { id: s.id, confirm: true });
    assert.equal(clicks, 1, '重放不受公证缺席影响（物理派发照常）');
    assert.equal(out.state_anchor.notarization.status, 'degraded', '公证缺席 ⇒ 降级标注在场');
    assert.match(out.state_anchor.notarization.reason, /notary-not-configured/, '降级归因申报（不伪造 anchored）');
    assert.equal(notary.anchorCount, 0, '锚链零增量（未装配绝不铸锚）');
  } finally {
    restore();
  }
});

test('F-4b: 装配 ⇒ 技能重放完成铸锚 —— 见证 source=run_skill、步指纹 + 三态结局 + 整体成败', async () => {
  notary.configure({ endpoint: '', tracePath: '' }); // endpoint 空 = 本地时间锚零网络
  // 两步派发面各异（replayOne 分派律）：click_mouse → system.clickMouse、
  // press_hotkey → system.pressHotkey —— 计数合流到同一派发计数（两步真实
  // 派发的断言强度不变；pressHotkey 一并 patch 亦杜绝测试真按键）。
  let dispatched = 0;
  const restore = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async () => { dispatched++; },
    pressHotkey: async () => { dispatched++; },
    typeText: async () => { /* noop */ },
  });
  try {
    const steps: SkillStep[] = [
      { tool: 'click_mouse', args: { x: 0.25, y: 0.25 } },
      { tool: 'press_hotkey', args: { keys: ['esc'] } },
    ];
    const s = skillLibrary.induce('打开设置', steps)!;
    const out = await runJson(createRunSkillTool(toolCfg), { id: s.id, confirm: true });
    assert.equal(dispatched, 2, '两步真实派发');
    assert.equal(out.state_anchor.notarization.status, 'anchored', '装配 ⇒ 铸证成功');
    assert.equal(out.state_anchor.notarization.timestampSource, 'local', '本地时间锚零网络');
    const anchor = notary.lastAnchor();
    assert.ok(anchor?.witness, '见证随锚入册');
    const w = anchor!.witness!;
    assert.equal(w.kind, 'replay-trajectory');
    assert.equal(w.version, 1);
    assert.equal(w.source, 'run_skill', '证据源 = run_skill（与 replay_actions 区分）');
    assert.equal(w.totalSteps, 2);
    assert.equal(w.replayedSteps, 2, '两步皆 executed=true');
    assert.equal(w.success, true, 'failed=0 ⇒ 整体成败 = true（run_skill 自身语义）');
    assert.equal(w.halt, null, '本工具循环恒走完 —— 见证如实携 null（不伪造中止）');
    assert.equal(w.steps.length, 2);
    assert.equal(w.steps[0].tool, 'click_mouse');
    assert.equal(w.steps[0].executed, true);
    assert.equal(w.steps[1].tool, 'press_hotkey');
    assert.equal(w.steps[1].executed, true);
    assert.equal(
      out.state_anchor.notarization.anchorHash, anchor!.hash,
      '回执锚哈希与锚链一致（复核入口）',
    );
  } finally {
    restore();
  }
});

// ─── F-5：提示词文档（mustNotAppear 判据 DSL 的模型可见面） ───

test('F-5: AUTONOMY_RUN_PROMPT 含 mustNotAppear 否定判据 DSL 说明（W8-B4 organs 的文档面）', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const m = src.match(/const AUTONOMY_RUN_PROMPT = `([\s\S]*?)`;/);
  assert.ok(m, 'AUTONOMY_RUN_PROMPT 字面量在场');
  const prompt = m[1];
  assert.match(prompt, /mustNotAppear:/, '提示词须点名 mustNotAppear: 前缀（英文形态）');
  assert.match(prompt, /不得出现/, '提示词须点名中文形态（不得出现：）');
  assert.match(prompt, /violated/, '提示词须说明命中禁词 ⇒ violated ⇒ 终局 failed 的后果链');
});
