// test/autonomy.integration.test.ts
// 纪元 Φ（集成验证）：autonomous_run 元工具接入真实器官栈 —— 全离线，绝不联网。
// 三件套：sharp 现场生成渐变 PNG 假截屏序列（横渐变/竖渐变 dhash 汉明距离 64 ——
// 变化判决确定性向量）+ 假 readWords/groundVlm（RuntimeDeps 注入）+ 假 system 键鼠
// （monkey-patch system 对象 —— 模块导出的可变字面量，测试恢复原样）。覆盖：
//   Φ-I   happy path：点击 → 屏幕变（dhash 判变）→ 判据 OCR 命中 → achieved
//          锚点 JSON 结构 + 像素/归一化换算链取证（clickMouse 工具同律）+ 零网络
//   Φ-II  宪法审批升级：sensitive 词（发送）⇒ approval-required ⇒ ACTION_REQUIRED，
//          零步零执行
//   Φ-III error 风暴：system.clickMouse 连抛 ⇒ error 步累积 ⇒ 步保险丝 aborted ⇒
//          toolErr + 进化引擎入库
//   Φ-IV  进化读数：同签名失败第二次出现 ⇒ next_step 出现 escalate 建议（重复失败模式）
//   Φ-V   开关门：autonomyEnabled=false ⇒ toolErr；tools/index.ts 源码挂载门 regex
//   Φ-VI  buildAutonomyStack 规则映射：CSV→RiskTier[]、追加危险词、步数硬顶、
//          快照槽就地补挂、perceive 真管线（假截屏→composeSnapshot）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Config } from '../src/config.ts';
import { resetGlmClient } from '../src/vlm/index.ts';
import { system } from '../src/system.ts';
import { createAutonomousRunTool } from '../src/tools/autonomousRun.ts';
import { buildAutonomyStack, AutonomyConstitution, type RuntimeDeps } from '../src/autonomy/index.ts';
import { dhash as dhashFn, hammingDistance } from '../src/perceptualHash.ts';
import { default as sharp } from 'sharp';

// ─── 环境卫兵：GLM 全键清空 + 单例重置（PolicyEngine 咨询臂与 grounding 哨兵零网络） ───

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

// ─── 假件工坊 ───

/** 渐变 PNG：vertical=false 横向渐变（dhash ≈ 全 1），true 纵向渐变（dhash ≈ 全 0）—— 确定性变化向量 */
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

/** 全量默认 autonomy 配置（六字段齐备，可局部覆盖） */
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

/** system 键鼠 monkey-patch（system 是可变对象字面量 —— 恢复器还原原样） */
type SystemPatch = Partial<Record<'clickMouse' | 'typeText' | 'scroll' | 'pressHotkey' | 'getScreenSize', unknown>>;
function patchSystem(over: SystemPatch): () => void {
  const saved: Record<string, unknown> = {};
  const host = system as unknown as Record<string, unknown>;
  for (const key of Object.keys(over)) {
    saved[key] = host[key];
    host[key] = (over as Record<string, unknown>)[key];
  }
  return () => { for (const key of Object.keys(over)) host[key] = saved[key]; };
}

/** 工具执行捷径（execute(args, undefined) 双参面在测试里只需 args） */
type ToolLike = { execute: (a: unknown, e: unknown) => Promise<unknown> };
async function runTool(tool: ToolLike, args: unknown): Promise<any> {
  return JSON.parse(String(await tool.execute(args, undefined)));
}

// ─── 共享假截屏世界（Φ-I/II/III 的舞台） ───

const W = 512;
const H = 384;
const pngA = await gradientPng(W, H, false); // 横渐变 —— 「点击前」
const pngB = await gradientPng(W, H, true);  // 纵渐变 —— 「点击后」

// ─── Φ-I happy path：点击 → 屏幕变 → 判据 OCR 命中 → achieved ───

test('Φ-I: happy path —— 点击推进、屏幕变化判 progress、每 3 步抽查判据命中 ⇒ achieved 锚点', async () => {
  const savedEnv = snapshotEnv();
  const clicks: Array<{ x: number; y: number; button: string }> = [];
  let clicked = false;
  const restoreSystem = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async (x: number, y: number, button = 'left') => { clicks.push({ x, y, button }); clicked = true; },
    typeText: async () => { throw new Error('本用例不得键入'); },
    scroll: async () => { throw new Error('本用例不得滚动'); },
    pressHotkey: async () => { throw new Error('本用例不得按键'); },
  });
  try {
    clearEnvKeys();
    resetGlmClient();

    // 变化向量取证：两张假屏的 dhash 汉明距离必须远超容差 3（确定性判变的前提）
    const [ha, hb] = [await dhashFn(pngA), await dhashFn(pngB)];
    assert.ok(hammingDistance(ha, hb) > 3, `假屏 dhash 距离须 >3（实测 ${hammingDistance(ha, hb)}）`);

    const wordsA = [{ label: '任务启动', bbox: { x0: 100, y0: 100, x1: 200, y1: 140 }, confidence: 0.9 }];
    const wordsB = [{ label: '任务完成', bbox: { x0: 60, y0: 200, x1: 180, y1: 240 }, confidence: 0.95 }];
    let captures = 0;
    let groundings = 0;
    let clock = 1_000;
    const deps: RuntimeDeps = {
      capture: async () => { captures++; return clicked ? pngB : pngA; },
      readWords: async buf => (buf === pngA ? wordsA : wordsB),
      groundVlm: async () => { groundings++; return []; },
      now: () => (clock += 50),
      sleep: async () => { /* 零真睡 */ },
    };

    const tool = createAutonomousRunTool(makeConfig(), deps);
    const out = await runTool(tool, { goal: '完成任务演示', success_criteria: ['任务完成'] });

    // 锚点 JSON 结构四件套
    assert.equal(out.status, 'SUCCESS');
    assert.equal(out.state_anchor.phase, 'achieved');
    assert.equal(out.state_anchor.steps, 3, '三步：progress → no_effect → no_effect+判据');
    assert.equal(out.state_anchor.criteria.met, 1);
    assert.equal(out.state_anchor.criteria.total, 1);
    assert.equal(out.state_anchor.escalated, false);
    assert.equal(out.state_anchor.verdict, 'healthy');
    assert.equal(out.state_anchor.score, 100);
    assert.ok(out.state_anchor.summary.includes('achieved'));
    assert.ok(Array.isArray(out.state_anchor.lessons));
    assert.ok(Array.isArray(out.state_anchor.next_run_advice) && out.state_anchor.next_run_advice.length >= 1);
    // 成功短轨迹 ⇒ 蒸馏技能入进化记忆（3 步 ≤ 12 步蒸馏门）
    assert.ok(out.state_anchor.distilled_skill, '短成功轨迹应蒸馏技能');
    assert.equal(out.state_anchor.distilled_skill.description, '自动技能：完成任务演示');

    // 像素/归一化换算链取证（clickMouse.ts 同律）：
    // 快照中心 (150,120) / 快照宽高 (512,384) = (0.293, 0.3125) → ×屏幕 (1920,1080) = (563, 338)
    assert.equal(clicks.length, 3);
    assert.deepEqual(clicks[0], { x: 563, y: 338, button: 'left' });
    assert.ok(clicks.every(c => c.x >= 0 && c.x <= 1920 && c.y >= 0 && c.y <= 1080));

    // 零网络与感知/验证记账：3 次感知 + 3 次执行后验证 = 6 次截屏；接地只走注入假件
    assert.equal(captures, 6);
    assert.equal(groundings, 3);
  } finally {
    restoreSystem();
    restoreEnv(savedEnv);
    resetGlmClient();
  }
});

// ─── Φ-II 宪法审批升级：sensitive 词 ⇒ ACTION_REQUIRED ───

test('Φ-II: 宪法审批升级 —— 目标含「发送」⇒ sensitive 不在白名单 ⇒ approval-required ⇒ ACTION_REQUIRED 零执行', async () => {
  const savedEnv = snapshotEnv();
  const clicks: Array<{ x: number; y: number }> = [];
  const restoreSystem = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async (x: number, y: number) => { clicks.push({ x, y }); },
  });
  try {
    clearEnvKeys();
    resetGlmClient();
    const deps: RuntimeDeps = {
      capture: async () => pngA,
      readWords: async () => [{ label: '发送', bbox: { x0: 100, y0: 100, x1: 180, y1: 140 }, confidence: 0.9 }],
      groundVlm: async () => [],
      now: () => 1_000,
      sleep: async () => { /* 零真睡 */ },
    };
    const tool = createAutonomousRunTool(makeConfig(), deps);
    const out = await runTool(tool, { goal: '发送周报给主管' });

    assert.equal(out.status, 'ACTION_REQUIRED');
    assert.equal(out.state_anchor.reason, 'approval-required');
    assert.equal(out.state_anchor.escalate_reason, 'approval-required');
    assert.equal(out.state_anchor.escalated, true);
    assert.equal(out.state_anchor.steps, 0, '审批升级发生在执行前 —— 零步零执行');
    assert.equal(clicks.length, 0, '审批升级不得触碰键鼠');
    assert.ok(out.next_step.includes('human'));
  } finally {
    restoreSystem();
    restoreEnv(savedEnv);
    resetGlmClient();
  }
});

// ─── Φ-III error 风暴：执行连抛 ⇒ 步保险丝 aborted ⇒ toolErr + 进化入库 ───

test('Φ-III: error 风暴 —— system.clickMouse 连抛 ⇒ error 步累积 ⇒ 步保险丝 aborted ⇒ toolErr（锚点含教训路径）', async () => {
  const savedEnv = snapshotEnv();
  let attempts = 0;
  const restoreSystem = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async () => { attempts++; throw new Error('boom: 模拟键鼠管线故障'); },
  });
  try {
    clearEnvKeys();
    resetGlmClient();
    const deps: RuntimeDeps = {
      capture: async () => pngA,
      readWords: async () => [{ label: '控制面板', bbox: { x0: 80, y0: 80, x1: 240, y1: 130 }, confidence: 0.9 }],
      groundVlm: async () => [],
      now: (() => { let t = 1_000; return () => (t += 50); })(),
      sleep: async () => { /* 零真睡 */ },
    };
    const tool = createAutonomousRunTool(makeConfig(), deps);
    const out = await runTool(tool, { goal: '打开控制面板xyz', max_steps: 3 });

    assert.equal(out.status, 'FAILED');
    assert.ok(String(out.state_anchor.error).includes('aborted'), `error 应含 aborted（实测 ${out.state_anchor.error}）`);
    assert.ok(String(out.state_anchor.error).includes('3'));
    assert.equal(attempts, 3, '三次尝试三次失败');
    assert.ok(/先行建议/.test(out.next_step), '失败路径的 next_step 应携带进化建议');
  } finally {
    restoreSystem();
    restoreEnv(savedEnv);
    resetGlmClient();
  }
});

// ─── Φ-IV 进化读数：同签名失败第二次 ⇒ escalate 建议出现（跑一次聪明一次） ───

test('Φ-IV: 进化引擎二轮 —— 同签名失败第 2 次出现 ⇒ next_step 出现 escalate 建议（重复失败模式）', async () => {
  const savedEnv = snapshotEnv();
  const restoreSystem = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async () => { throw new Error('boom-2'); },
  });
  try {
    clearEnvKeys();
    resetGlmClient();
    const deps: RuntimeDeps = {
      capture: async () => pngA,
      readWords: async () => [{ label: '网络设置', bbox: { x0: 80, y0: 80, x1: 240, y1: 130 }, confidence: 0.9 }],
      groundVlm: async () => [],
      now: (() => { let t = 5_000; return () => (t += 50); })(),
      sleep: async () => { /* 零真睡 */ },
    };
    const tool = createAutonomousRunTool(makeConfig(), deps);

    // 第一次同构失败（Φ-III 用的是另一 goal —— 本用例签名独立，两轮同签名）
    const run1 = await runTool(tool, { goal: '打开网络设置zzz', max_steps: 2 });
    assert.equal(run1.status, 'FAILED');
    assert.ok(!/escalate 建议/.test(run1.next_step), '首败只入教训，不出 escalate 建议');

    const run2 = await runTool(tool, { goal: '打开网络设置zzz', max_steps: 2 });
    assert.equal(run2.status, 'FAILED');
    assert.ok(/escalate 建议/.test(run2.next_step), '同签名第 2 次失败 ⇒ escalate 建议出现（勿原样重试）');
  } finally {
    restoreSystem();
    restoreEnv(savedEnv);
    resetGlmClient();
  }
});

// ─── Φ-V 开关门：关 ⇒ toolErr；tools/index.ts 挂载门 regex ───

test('Φ-V: autonomyEnabled=false ⇒ toolErr；tools/index.ts 以 config.autonomyEnabled 守卫挂载', async () => {
  const savedEnv = snapshotEnv();
  try {
    clearEnvKeys();
    resetGlmClient();
    const tool = createAutonomousRunTool(makeConfig({ autonomyEnabled: false }));
    const out = await runTool(tool, { goal: '任何目标' });
    assert.equal(out.status, 'FAILED');
    assert.ok(String(out.state_anchor.error).includes('disabled'));

    // 挂载门源码取证（与 vlm 挂载门测试同法）
    const toolsSrc = readFileSync(new URL('../src/tools/index.ts', import.meta.url), 'utf8');
    assert.match(
      toolsSrc,
      /if\s*\(config\.autonomyEnabled\)\s*\{\s*[^}]*createAutonomousRunTool/s,
      'autonomous_run 必须以 autonomyEnabled 条件挂载',
    );
    // 提示词注入门（src/index.ts order 14 段）同律在场
    const entrySrc = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    assert.match(entrySrc, /autonomy-run-rules', order: 14/, 'autonomy 提示词段须以 order 14 条件注入');
  } finally {
    restoreEnv(savedEnv);
    resetGlmClient();
  }
});

// ─── Φ-VI buildAutonomyStack 规则映射与快照槽 ───

test('Φ-VI: buildAutonomyStack —— CSV→RiskTier[]、追加危险词、步数硬顶、快照槽就地补挂、perceive 真管线', async () => {
  const savedEnv = snapshotEnv();
  try {
    clearEnvKeys();
    resetGlmClient();
    const config = makeConfig({
      autonomyAllowTiers: 'sensitive, benign, garbage',
      autonomyForbiddenKeywords: '机密文档, 机密文档',
      autonomyMaxSteps: 7,
    });
    const deps: RuntimeDeps = {
      capture: async () => pngA,
      readWords: async () => [{ label: '任务启动', bbox: { x0: 100, y0: 100, x1: 200, y1: 140 }, confidence: 0.9 }],
      groundVlm: async () => [],
      now: () => 42,
      sleep: async () => { /* 零真睡 */ },
    };
    const stack = buildAutonomyStack(config, deps);

    // 快照槽补挂回传（ΑΩ-R44 定谳最小变异面）：同一 deps 对象上出现（后续 createExecute({...deps}) 共享）
    assert.ok(deps.lastSnapshotRef, 'buildAutonomyStack 应补挂回传 lastSnapshotRef');
    assert.equal(deps.lastSnapshotRef!.current, null);

    // 规则映射：非法词剔除（保序）、危险词去重、步数硬顶透传
    const rules = (stack.constitution as AutonomyConstitution).rules;
    assert.deepEqual(rules.allowAutonomousTiers, ['sensitive', 'benign']);
    assert.deepEqual(rules.forbiddenKeywords, ['机密文档']);
    assert.equal(rules.maxTotalSteps, 7);

    // perceive 真管线：假截屏 → composeSnapshot（dhash/宽高/OCR 全息入账）
    const snap = await stack.perceive();
    assert.equal(snap.width, W);
    assert.equal(snap.height, H);
    assert.ok(typeof snap.dhash === 'string' && snap.dhash.length > 0);
    assert.equal(snap.textDigest, '任务启动');
    assert.equal(snap.elements.length, 1);
    assert.equal(snap.elements[0].source, 'local');
    assert.deepEqual(snap.elements[0].center, { x: 150, y: 120 });
    assert.equal(deps.lastSnapshotRef!.current, snap, '感知快照应写入共享槽');
  } finally {
    restoreEnv(savedEnv);
    resetGlmClient();
  }
});

// ─── ΑΩ-R44：buildAutonomyStack 入参纯化（浅拷贝铸栈 + 定谳最小变异面回写） ───

test('ΑΩ-R44①: 铸栈变异面钉死 —— 原 deps 恰新增定谳补挂键（不多不少）、已注入字段零覆盖', async () => {
  const savedEnv = snapshotEnv();
  try {
    clearEnvKeys();
    resetGlmClient();
    // 全注入向：六个可补挂位全部由调用方自带 ⇒ 铸栈后原对象零新增键、引用零覆盖
    const ownSlot: NonNullable<RuntimeDeps['lastSnapshotRef']> = { current: null };
    const ownObserver: NonNullable<RuntimeDeps['incrementalObserver']> = { current: null };
    const ownDrag: NonNullable<RuntimeDeps['drag']> = async () => ({ ok: true });
    const ownProbe: NonNullable<RuntimeDeps['probe']> = {
      hitTestPoint: async () => null, cursorKind: async () => null,
      sampleFrame: async () => null, frameDiff: async () => null, frameRowMeans: async () => null,
    };
    const ownFocus: NonNullable<RuntimeDeps['focus']> = {
      predicted: () => ({ x: 1, y: 1, extrapolated: true }),
      set: () => { /* 假件无操作 */ },
    };
    const ownW1: NonNullable<RuntimeDeps['w1']> = { steadyPollMs: 55 };
    const full: RuntimeDeps = {
      capture: async () => pngA,
      readWords: async () => [],
      groundVlm: async () => [],
      now: () => 42,
      sleep: async () => { /* 零真睡 */ },
      lastSnapshotRef: ownSlot,
      incrementalObserver: ownObserver,
      drag: ownDrag,
      probe: ownProbe,
      focus: ownFocus,
      w1: ownW1,
    };
    const keysFull = Object.keys(full).sort();
    buildAutonomyStack(makeConfig({ autonomyW1SteadyPollMs: 77 }), full);
    assert.deepEqual(Object.keys(full).sort(), keysFull, '全注入 ⇒ 原对象零新增键（副本承载、无补挂可回写）');
    assert.equal(full.lastSnapshotRef, ownSlot, '已注入快照槽零覆盖');
    assert.equal(full.incrementalObserver, ownObserver, '已注入观察槽零覆盖');
    assert.equal(full.drag, ownDrag, '已注入 drag 零覆盖');
    assert.equal(full.probe, ownProbe, '已注入 probe 零覆盖');
    assert.equal(full.focus, ownFocus, '已注入 focus 零覆盖');
    assert.equal(full.w1, ownW1, '已注入 w1 零覆盖（显式调参优先于 config 映射）');

    // 缺省向：裸 deps ⇒ 恰补挂回传四键（w1 无调参覆盖不挂；incrementalObserver
    // 总闸关不挂 —— 两向另由 w5wire 专证）
    const bare: RuntimeDeps = { capture: async () => pngA };
    const keysBare = new Set(Object.keys(bare));
    buildAutonomyStack(makeConfig(), bare);
    assert.deepEqual(
      Object.keys(bare).filter(k => !keysBare.has(k)).sort(),
      ['drag', 'focus', 'lastSnapshotRef', 'probe'],
      '缺省铸栈 ⇒ 变异面恰为定谳四键（不多不少）',
    );

    // 调参向：config 带有效 W1 键 ⇒ w1 亦进回传面
    const tuned: RuntimeDeps = { capture: async () => pngA };
    buildAutonomyStack(makeConfig({ autonomyW1SteadyPollMs: 77 }), tuned);
    assert.equal(tuned.w1?.steadyPollMs, 77, '调参键在场 ⇒ w1 补挂回传');

    // 总闸关向：autonomyW1Exec=false ⇒ probe/focus/w1 三缺席（仅剩无条件两键）
    const off: RuntimeDeps = { capture: async () => pngA };
    const keysOff = new Set(Object.keys(off));
    buildAutonomyStack(makeConfig({ autonomyW1Exec: false }), off);
    assert.deepEqual(
      Object.keys(off).filter(k => !keysOff.has(k)).sort(),
      ['drag', 'lastSnapshotRef'],
      'W1 总闸关 ⇒ 执行层三键缺席（零回归红律）',
    );
  } finally {
    restoreEnv(savedEnv);
    resetGlmClient();
  }
});

test('ΑΩ-R44②: 同一 deps 两次铸栈 —— 补挂槽跨铸复用不重铸（互不污染）、两次产物行为等价', async () => {
  const savedEnv = snapshotEnv();
  try {
    clearEnvKeys();
    resetGlmClient();
    const deps: RuntimeDeps = {
      capture: async () => pngA,
      readWords: async () => [{ label: '任务启动', bbox: { x0: 100, y0: 100, x1: 200, y1: 140 }, confidence: 0.9 }],
      groundVlm: async () => [],
      now: () => 42,
      sleep: async () => { /* 零真睡 */ },
    };
    // 首铸：补挂回传在场，真感知管线产快照并写入共享槽
    const stack1 = buildAutonomyStack(makeConfig(), deps);
    const slot1 = deps.lastSnapshotRef;
    const drag1 = deps.drag;
    const probe1 = deps.probe;
    const focus1 = deps.focus;
    assert.ok(slot1 && drag1 && probe1 && focus1, '首铸补挂回传在场');
    const snap1 = await stack1.perceive();
    assert.equal(slot1.current, snap1, '首铸感知写入共享槽');

    // 二铸（同一 deps）：只填缺席位 ⇒ 首铸补挂的槽/端口原样复用（引用恒等、
    // 不被重铸顶掉 ⇒ 两栈共享同一只快照槽，零新增键 —— 互不污染）
    const keysBefore2nd = new Set(Object.keys(deps));
    const stack2 = buildAutonomyStack(makeConfig(), deps);
    assert.equal(deps.lastSnapshotRef, slot1, '二铸复用首铸快照槽（不重铸）');
    assert.equal(deps.drag, drag1, '二铸复用首铸 drag 端口');
    assert.equal(deps.probe, probe1, '二铸复用首铸 probe 端口');
    assert.equal(deps.focus, focus1, '二铸复用首铸 focus 端口');
    assert.deepEqual(
      Object.keys(deps).filter(k => !keysBefore2nd.has(k)),
      [],
      '二铸零新增键（首铸补挂面即稳态变异面）',
    );

    // 两次产物行为等价：宪法规则逐键同、感知同像同指纹同摘要、共享槽同步、
    // 免看门控端口同图同指纹
    const rules1 = (stack1.constitution as AutonomyConstitution).rules;
    const rules2 = (stack2.constitution as AutonomyConstitution).rules;
    assert.deepEqual(rules2, rules1, '两次铸栈的宪法规则逐键等价');
    const snap2 = await stack2.perceive();
    assert.equal(snap2.dhash, snap1.dhash, '同像 ⇒ 同指纹');
    assert.equal(snap2.textDigest, snap1.textDigest, '同像 ⇒ 同文本摘要');
    assert.equal(deps.lastSnapshotRef!.current, snap2, '二铸感知写同一只共享槽');
    assert.equal(slot1.current, snap2, '首铸槽视角亦见（跨栈共享单例语义）');
    assert.equal(await stack1.frameHash!(), await stack2.frameHash!(), '两栈 frameHash 同图同指纹（行为等价）');
  } finally {
    restoreEnv(savedEnv);
    resetGlmClient();
  }
});
