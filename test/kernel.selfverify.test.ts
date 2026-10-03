// test/kernel.selfverify.test.ts
// 纪元 Ξ（Ξ-B 生产自监督对账）：runPilotLoop 的 execute 包装器旁路 —— 快路径内核
// 判决（verifyAfter 即时 dhash）与「慢而准」settle-verify 真值对账，落证据账本。
// 全离线注入（与 epochSigma.resume.test.ts 同法）：sharp 渐变 PNG 假截屏（横/纵
// 渐变 dhash 汉明距离 64 —— 确定性变化向量）+ 假 readWords/groundVlm + system 键鼠
// monkey-patch + 注入 kernelEvidence 收集器 / settleOracle 假神谕 + 假时钟零真睡。
//
// 世界剧本说明（offline 真栈的结构性事实）：createExecute.verifyAfter 的 after 帧
// 只带 dhash 不带元素（OCR 仅每 3 步抽查）⇒ snapshotChanged 的元素数突变闸
// （|Δn|×10 > 3×max）对「perceive 有元素的世界」恒判变 ⇒ 经真栈执行的 click 在
// 假世界里恒 progress —— click+no_effect 不可离线构造。instant=false 分支改经
// error 剧本覆盖（clickMouse 连抛 ⇒ outcome 'error'）：实现律里 no_effect/error
// 同走 success ⇔ (outcome === 'progress')，被测分支逐字节相同。
//
// 覆盖（实现律逐条对应）：
//   Ξ-B① 免费证据（恒开）：click progress ⇒ policy.matchConfident success:true
//          记录在场（margin = 决策最佳得分）；error ⇒ success:false；
//          缺省不注入 kernelEvidence ⇒ 直连 evidenceLedger 单例
//   Ξ-B② 门控关：kernelEvolutionEnabled 缺省 / false ⇒ settle 神谕调用计数 = 0、
//          无 world.hammingTolerance 记录（性能铁律：零额外等待）
//   Ξ-B③ 门控开 + 注入假 settleOracle：真值与即时一致 ⇒ success:true、不一致 ⇒
//          false、margin = dhash 距离 − 内核容差（数值断言）
//   Ξ-B④ 主流程零影响：恶意 kernelEvidence / settleOracle 桩抛错 ⇒ 跑环照常出
//          PilotResult（观察式旁路绝不拖垮主流程）
//   Ξ-B⑤ 开闸下 instant=false 世界的对账路径也走：truth=true / instant=false ⇒
//          记 failure；settleOracle 收到的 before 串 = 感知快照指纹（lastSnapshotRef 血脉）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '../src/config.ts';
import { resetGlmClient } from '../src/vlm/index.ts';
import { system } from '../src/system.ts';
import { createAutonomousRunTool } from '../src/tools/autonomousRun.ts';
import { evidenceLedger, kernelRegistry, type KernelOutcome } from '../src/kernel/registry.ts';
import type { RuntimeDeps } from '../src/autonomy/index.ts';
import { dhash as dhashFn } from '../src/perceptualHash.ts';
import { default as sharp } from 'sharp';

// ─── 环境卫兵：GLM 全键清空 + 单例重置（PolicyEngine 咨询臂零网络） ───

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

/** 渐变 PNG：vertical=false 横向 / true 纵向（dhash 汉明距离 64 —— 确定性变化向量） */
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

/**
 * 全量默认 autonomy 配置（kernelEvolutionEnabled 缺席 = 关闸缺省态）。
 * over 收 Record<string, unknown>：字段由基建侧并行在加，缺席/在场两态都合法。
 */
function makeConfig(over: Record<string, unknown> = {}): Config {
  return {
    autonomyEnabled: true,
    autonomyMaxSteps: 24,
    autonomyTimeBudgetSec: 300,
    autonomyAllowTiers: 'benign',
    autonomyVlmWhenUncertain: true,
    autonomyForbiddenKeywords: '',
    autonomyTracePath: '',
    ...over,
  } as Config;
}

/** system 键鼠 monkey-patch（恢复器还原原样） */
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

/** 剧本键鼠：点击不落世界（世界由 capture 脚本控制）；boom=true 时连抛造 error 步 */
function patchScriptedSystem(opts: { onClick?: () => void; boom?: boolean } = {}): () => void {
  return patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async () => {
      if (opts.boom) throw new Error('剧本键鼠故障');
      opts.onClick?.();
    },
    scroll: async () => { /* 剧本键鼠：滚动不落世界 */ },
    typeText: async () => { throw new Error('本套用例不得键入'); },
    pressHotkey: async () => { throw new Error('本套用例不得按键'); },
  });
}

/** 工具执行捷径 */
type ToolLike = { execute: (a: unknown, e: unknown) => Promise<unknown> };
async function runTool(tool: ToolLike, args: unknown): Promise<any> {
  return JSON.parse(String(await tool.execute(args, undefined)));
}

/** 证据收集器（kernelEvidence 注入缝的测试假件） */
function collector(): { sink: { record(o: KernelOutcome): void }; rows: KernelOutcome[] } {
  const rows: KernelOutcome[] = [];
  return { sink: { record: (o: KernelOutcome): void => { rows.push(o); } }, rows };
}

/** 假时钟（步进 50ms，起点 1000 —— ts 断言可确定） */
function fakeClock(): () => number {
  let t = 1_000;
  return () => (t += 50);
}

// ─── 脚本化假世界：pngA（开门标记在场）/ pngB（关门标记在场） ───

const W = 512;
const H = 384;
const pngA = await gradientPng(W, H, false); // 横渐变 —— 「点击前」
const pngB = await gradientPng(W, H, true);  // 纵渐变 —— 「点击后」

const wordsA = [
  { label: '开门标记', bbox: { x0: 100, y0: 100, x1: 200, y1: 140 }, confidence: 0.9 },
  { label: '任务界面', bbox: { x0: 300, y0: 300, x1: 420, y1: 340 }, confidence: 0.8 },
];
const wordsB = [
  { label: '关门标记', bbox: { x0: 60, y0: 200, x1: 180, y1: 240 }, confidence: 0.95 },
];

/** 目标判据只认「开门标记」⇒ 决策族恒为判据匹配点击（payload.matchScore = 1） */
const GOAL_ARGS = {
  goal: '开关门流程演示',
  success_criteria: ['开门标记'],
};

/**
 * 跑一轮 autonomous_run（环境卫兵 + 剧本键鼠全包）。
 *  · progress 剧本：首次物理点击后 capture 翻到 pngB ⇒ 该步 progress；
 *  · error 剧本：clickMouse 连抛 ⇒ 该步 error（instant=false —— 见文件头说明）。
 */
async function runOnce(
  cfg: Config,
  depsOver: Record<string, unknown>,
  opts: { mode: 'progress' | 'error'; maxSteps: number },
): Promise<any> {
  const savedEnv = snapshotEnv();
  let flipped = false;
  const restoreSystem = patchScriptedSystem(
    opts.mode === 'progress'
      ? { onClick: () => { flipped = true; } }
      : { boom: true },
  );
  try {
    clearEnvKeys();
    resetGlmClient();
    const deps = {
      capture: async () => (flipped ? pngB : pngA),
      readWords: async (buf: Buffer) => (buf === pngA ? wordsA : wordsB),
      groundVlm: async () => [],
      now: fakeClock(),
      sleep: async () => { /* 零真睡 */ },
      ...depsOver,
    } as RuntimeDeps;
    const tool = createAutonomousRunTool(cfg, deps);
    return await runTool(tool, { ...GOAL_ARGS, max_steps: opts.maxSteps });
  } finally {
    restoreSystem();
    restoreEnv(savedEnv);
    resetGlmClient();
  }
}

// ─── Ξ-B① 免费证据（恒开，零额外成本） ───

test('Ξ-B①: click progress ⇒ policy.matchConfident success:true（margin=决策得分）；error ⇒ false；缺省直连 evidenceLedger 单例', async () => {
  // 进步世界：一步点击翻屏 ⇒ progress ⇒ success:true、margin = matchScore(1)
  const prog = collector();
  const outProg = await runOnce(makeConfig(), { kernelEvidence: prog.sink }, { mode: 'progress', maxSteps: 1 });
  assert.equal(outProg.status, 'FAILED', '单步保险丝中止（aborted）—— 与证据断言无交集');
  const confident = prog.rows.filter(r => r.key === 'policy.matchConfident');
  assert.ok(confident.length >= 1, `policy.matchConfident 应有记账（实测 ${JSON.stringify(prog.rows)}）`);
  for (const r of confident) {
    assert.equal(r.success, true, 'progress ⇒ success:true');
    assert.equal(r.margin, 1, 'margin = 决策最佳得分（开门标记 判据匹配得分 1）');
    assert.ok(typeof r.ts === 'number' && r.ts > 0, 'ts 走注入时钟（>0）');
  }
  assert.ok(
    prog.rows.every(r => r.key !== 'world.hammingTolerance'),
    '门控关 ⇒ 不得有慢真值对账记录',
  );

  // 故障世界：键鼠连抛 ⇒ 全 error 步（instant=false —— no_effect/error 同走 success:false）
  const stuck = collector();
  const outStuck = await runOnce(makeConfig(), { kernelEvidence: stuck.sink }, { mode: 'error', maxSteps: 3 });
  assert.equal(outStuck.status, 'FAILED', 'error 步累积至步保险丝中止（aborted）');
  const stuckConfident = stuck.rows.filter(r => r.key === 'policy.matchConfident');
  assert.ok(stuckConfident.length >= 3, `error 点击逐步记账（实测 ${stuckConfident.length} 条）`);
  assert.ok(stuckConfident.every(r => r.success === false), 'error ⇒ success:false（非 progress 一律 false）');
  assert.ok(stuckConfident.every(r => r.margin === 1), 'margin 恒为决策得分');

  // 缺省血脉：不注入 kernelEvidence ⇒ 直连 evidenceLedger 单例（测试隔离 reset）
  evidenceLedger.reset();
  try {
    await runOnce(makeConfig(), {}, { mode: 'progress', maxSteps: 1 });
    const stats = evidenceLedger.stats('policy.matchConfident');
    assert.ok(stats.n >= 1, `缺省直连单例应记账（实测 n=${stats.n}）`);
    assert.ok(stats.margins.includes(1), 'margin = 决策得分入单例台账');
  } finally {
    evidenceLedger.reset();
  }
});

// ─── Ξ-B② 门控关 ⇒ 零 settle 等待、零对账记录 ───

test('Ξ-B②: kernelEvolutionEnabled 缺省/false ⇒ settleOracle 调用计数=0、无 world.hammingTolerance 记录', async () => {
  let settleCalls = 0;
  const oracle = async (): Promise<{ detected: boolean; distance: number } | null> => {
    settleCalls++;
    return { detected: true, distance: 10 };
  };

  // 缺省态（字段缺席）
  const c1 = collector();
  await runOnce(makeConfig(), { kernelEvidence: c1.sink, settleOracle: oracle }, { mode: 'error', maxSteps: 2 });
  assert.ok(
    c1.rows.some(r => r.key === 'policy.matchConfident'),
    '免费证据照常在场（execute 路径确实跑了 —— 反证非零调用面）',
  );
  assert.equal(settleCalls, 0, '字段缺席 ⇒ 慢真值神谕零调用（零额外等待）');
  assert.ok(c1.rows.every(r => r.key !== 'world.hammingTolerance'), '无对账记录');

  // 显式 false
  const c2 = collector();
  await runOnce(
    makeConfig({ kernelEvolutionEnabled: false }),
    { kernelEvidence: c2.sink, settleOracle: oracle },
    { mode: 'error', maxSteps: 2 },
  );
  assert.equal(settleCalls, 0, '显式 false ⇒ 慢真值神谕零调用');
  assert.ok(c2.rows.some(r => r.key === 'policy.matchConfident'), '免费证据照常在场');
  assert.ok(c2.rows.every(r => r.key !== 'world.hammingTolerance'), '无对账记录');
});

// ─── Ξ-B③ 门控开 + 假神谕：对账一致/不一致与 margin 数值 ───

test('Ξ-B③: 开闸 + 注入 settleOracle —— 真值与即时一致 ⇒ success:true、不一致 ⇒ false、margin = 距离 − 容差', async () => {
  // 容差取值取证：world.hammingTolerance 未注册 ⇒ 回声缺省 3（margin = distance − 3）
  assert.equal(kernelRegistry.get('world.hammingTolerance'), null, '本套不注册内核参数 ⇒ margin 按缺省容差 3 计算');

  // 一致：progress 世界（instant=true）+ 真值 detected=true ⇒ agree ⇒ success:true、margin 10−3=7
  const agree = collector();
  await runOnce(
    makeConfig({ kernelEvolutionEnabled: true }),
    {
      kernelEvidence: agree.sink,
      settleOracle: async () => ({ detected: true, distance: 10 }),
    },
    { mode: 'progress', maxSteps: 1 },
  );
  const agreeRows = agree.rows.filter(r => r.key === 'world.hammingTolerance');
  assert.equal(agreeRows.length, 1, '单步 ⇒ 恰一条对账记录');
  assert.equal(agreeRows[0].success, true, 'instant(true) === truth(true) ⇒ success:true');
  assert.equal(agreeRows[0].margin, 7, 'margin = dhash 距离 10 − 内核容差 3 = 7');
  assert.ok(
    agree.rows.some(r => r.key === 'policy.matchConfident' && r.success === true),
    '开闸不关免费证据（两本账并行）',
  );

  // 不一致：error 世界（instant=false）+ 真值 detected=true ⇒ 分歧 ⇒ success:false、margin 6−3=3
  const disagree = collector();
  await runOnce(
    makeConfig({ kernelEvolutionEnabled: true }),
    {
      kernelEvidence: disagree.sink,
      settleOracle: async () => ({ detected: true, distance: 6 }),
    },
    { mode: 'error', maxSteps: 1 },
  );
  const disagreeRows = disagree.rows.filter(r => r.key === 'world.hammingTolerance');
  assert.equal(disagreeRows.length, 1, '单步 ⇒ 恰一条对账记录');
  assert.equal(disagreeRows[0].success, false, 'instant(false) !== truth(true) ⇒ success:false');
  assert.equal(disagreeRows[0].margin, 3, 'margin = dhash 距离 6 − 内核容差 3 = 3（有符号距离差，与训练营同口径）');
});

// ─── Ξ-B④ 主流程零影响：恶意桩抛错不炸跑环 ───

test('Ξ-B④: kernelEvidence/settleOracle 恶意桩抛错 ⇒ PilotResult 照常（观察式旁路绝不拖垮主流程）', async () => {
  const out = await runOnce(
    makeConfig({ kernelEvolutionEnabled: true }),
    {
      kernelEvidence: { record: (): void => { throw new Error('恶意记账桩'); } },
      settleOracle: (): Promise<{ detected: boolean; distance: number } | null> =>
        Promise.reject(new Error('恶意神谕桩')),
    },
    { mode: 'error', maxSteps: 2 },
  );
  assert.ok(
    out && typeof out.status === 'string' && ['SUCCESS', 'FAILED', 'ACTION_REQUIRED'].includes(out.status),
    `跑环照常出结果（实测 status=${out?.status}）`,
  );
  assert.equal(typeof out.state_anchor, 'object', '锚点结构完好');
});

// ─── Ξ-B⑤ 开闸下 instant=false 世界的对账路径也走 ───

test('Ξ-B⑤: 开闸 error 世界 ⇒ 对账路径照走（truth=true / instant=false 记 failure）；before 串 = 感知快照指纹', async () => {
  let settleCalls = 0;
  const seenBefore: string[] = [];
  const c = collector();
  await runOnce(
    makeConfig({ kernelEvolutionEnabled: true }),
    {
      kernelEvidence: c.sink,
      settleOracle: async (beforeHash: string) => {
        settleCalls++;
        seenBefore.push(beforeHash);
        return { detected: true, distance: 6 };
      },
    },
    { mode: 'error', maxSteps: 2 },
  );
  assert.equal(settleCalls, 2, '两个 click 步各对账一次（instant=false 世界的对账路径也走）');
  const rows = c.rows.filter(r => r.key === 'world.hammingTolerance');
  assert.equal(rows.length, 2, '两步各落一条 failure 账');
  assert.ok(rows.every(r => r.success === false), 'truth=true / instant=false ⇒ 记 failure');
  assert.ok(rows.every(r => r.margin === 3), 'margin = 6 − 3（数值口径一致）');

  // before 串血脉取证：settleOracle 收到的就是感知快照指纹（lastSnapshotRef 机制复用）
  const expected = await dhashFn(pngA);
  assert.ok(
    seenBefore.every(h => h === expected),
    `before 串应为感知快照 dhash（期望 ${expected.slice(0, 8)}…，实测 ${seenBefore.map(h => h.slice(0, 8)).join(',')}…）`,
  );
});
