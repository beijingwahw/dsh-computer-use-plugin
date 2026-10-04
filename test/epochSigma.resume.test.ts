// test/epochSigma.resume.test.ts
// 纪元 Σ（Σ-3 断点续跑）：autonomous_run 铸档（PilotStore）+ autonomy_resume 复活续跑。
// 全离线注入（与 autonomy.integration.test.ts 同法）：sharp 渐变 PNG 假截屏
// 「前半世界 pngA（含开门标记）/ 后半世界 pngB（含关门标记）」—— 假世界可脚本化
// 「前半步保险丝中止（判据半成）、后半续跑达成」；system 键鼠 monkey-patch；零网络。
// 覆盖：
//   Σ-3① 小 maxSteps 中止 ⇒ 锚点含 resume_token；档案可 load（aborted + 判据半成）
//   Σ-3② autonomy_resume 续跑 ⇒ 后半达成 achieved；已 met 判据不重核（后半世界
//          OCR 永不含开门标记 —— achieved 只可能来自判据回放）
//   Σ-3③ token 不存在 ⇒ toolErr
//   Σ-3④ 已 done 的 token ⇒ toolErr（已完成无需续）
//   Σ-3⑤ tracePath 落盘往返：begin/step/finish 后 new PilotStore(path) load/list 复原
//   Σ-3⑥ autonomyEnabled=false ⇒ 两工具均 toolErr；tools/index.ts 挂载门源码正则
//   Σ-3⑧⑨⑩ ΑΩ-R17 档案有界：超限驱逐最旧已完成（进行中永不驱逐、恰在上限
//          不抖动）、tmp+rename 快照压缩重写可再恢复、缺省 500 端到端 +
//          被驱逐 token 经 autonomy_resume 诚实拒绝（老令牌过期是设计）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.ts';
import { resetGlmClient } from '../src/vlm/index.ts';
import { system } from '../src/system.ts';
import { createAutonomousRunTool, pilotStoreFor } from '../src/tools/autonomousRun.ts';
import { createAutonomyResumeTool } from '../src/tools/autonomyResume.ts';
import { PilotStore, type RuntimeDeps } from '../src/autonomy/index.ts';
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

/** 全量默认 autonomy 配置（Σ 字段齐备，可局部覆盖） */
function makeConfig(over: Partial<Config> = {}): Config {
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

/** 工具执行捷径 */
type ToolLike = { execute: (a: unknown, e: unknown) => Promise<unknown> };
async function runTool(tool: ToolLike, args: unknown): Promise<any> {
  return JSON.parse(String(await tool.execute(args, undefined)));
}

// ─── 脚本化假世界：前半 pngA（开门标牌在场）/ 后半 pngB（关门标牌在场） ───
// W9-1（D-G9 收口适配）：世界标签由「开门标记/关门标记」改为「开门标牌/关门标牌」
// —— 判据「开门标记」对「关门标记」编辑距离 1 ≤ ⌈4/6⌉，runtime 换用
// evaluateCriteria 肯定面 fuzzy 后旧夹具即误命中 met（D-G9 立法意图），「前半
// 双判据缺一 ⇒ 步保险丝中止」的夹具前提被翻转。加区分字后：本世界距 1 仍命中
//（fuzzy 立法面照常取证）、异世界距 2 > 容差严格不命中（严格例保留），且与
// 元素「开门标牌/关门标牌」的 2-gram 候选动态（判据匹配点击）完整保真。

const W = 512;
const H = 384;
const pngA = await gradientPng(W, H, false); // 横渐变 —— 前半世界
const pngB = await gradientPng(W, H, true);  // 纵渐变 —— 后半世界

const wordsA = [
  { label: '开门标牌', bbox: { x0: 100, y0: 100, x1: 200, y1: 140 }, confidence: 0.9 },
  { label: '任务界面', bbox: { x0: 300, y0: 300, x1: 420, y1: 340 }, confidence: 0.8 },
];
const wordsB = [
  { label: '关门标牌', bbox: { x0: 60, y0: 200, x1: 180, y1: 240 }, confidence: 0.95 },
  { label: '任务界面', bbox: { x0: 300, y0: 300, x1: 420, y1: 340 }, confidence: 0.8 },
];
// 判据回放的取证前提：后半世界 OCR 永不含「开门标记」（W9-1：关门标牌与开门
// 标记编辑距离 2 > ⌈4/6⌉ —— fuzzy 亦不命中）—— 续跑的 achieved 只能来自回放
assert.ok(!wordsB.some(w => w.label.includes('开门标记')), '后半世界不得含开门标记（回放取证前提）');

/** 第一半世界的物理键鼠：全 no-op（屏幕由 capture 脚本控制，物理点击不改变世界） */
function patchInertSystem(): () => void {
  return patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async () => { /* 剧本键鼠：点击不落世界 */ },
    scroll: async () => { /* 剧本键鼠：滚动不落世界 */ },
    typeText: async () => { throw new Error('本套用例不得键入'); },
    pressHotkey: async () => { throw new Error('本套用例不得按键'); },
  });
}

/** 跨用例血脉：Σ-3① 铸出的 token（② 续跑、④ 复跑拒绝共用） */
let tokenA = '';

// ─── Σ-3① 小 maxSteps 中止 ⇒ 锚点含 resume_token；档案可 load ───

test('Σ-3①: maxSteps=3 前半世界步保险丝中止 ⇒ FAILED 携 resume_token；档案步账/判据账落定', async () => {
  const savedEnv = snapshotEnv();
  const restoreSystem = patchInertSystem();
  try {
    clearEnvKeys();
    resetGlmClient();
    const deps: RuntimeDeps = {
      capture: async () => pngA,
      readWords: async buf => (buf === pngA ? wordsA : wordsB),
      groundVlm: async () => [],
      now: (() => { let t = 1_000; return () => (t += 50); })(),
      sleep: async () => { /* 零真睡 */ },
    };

    const tool = createAutonomousRunTool(makeConfig(), deps);
    // W9-1（D-G9 收口适配）：判据保持「开门标记/关门标记」不变，世界标签已改
    // 「开门标牌」—— 判据「关门标记」对「开门标牌 任务界面」编辑距离 2 >
    // ⌈4/6⌉=1，fuzzy 严格不命中（严格例保留）；判据「开门标记」对「开门标牌」
    // 距 1 ≤ 1 ⇒ fuzzy 命中 met（D-G9 立法面照常取证）。
    const out = await runTool(tool, {
      goal: '开关门流程演示',
      success_criteria: ['开门标记', '关门标记'],
      max_steps: 3,
    });

    // 终局 aborted：toolErr（B-4 工厂只透传 error 文本）—— 令牌以 resume_token: <token> 内嵌；
    // 锚点四件套语义在 error/next_step 文本中齐备
    assert.equal(out.status, 'FAILED');
    assert.ok(String(out.state_anchor.error).includes('aborted'));
    assert.ok(String(out.state_anchor.error).includes('3'), '步账随 summary 在场');
    assert.ok(String(out.state_anchor.error).includes('1/2'), '判据账随 summary 在场（前半核得 1/2）');
    assert.equal(out.state_anchor.criteria, undefined, 'FAILED 结果不携带锚点对象（工厂契约）');
    const tokenMatch = String(out.state_anchor.error).match(/resume_token: (AUTO-[0-9a-f]{8})/);
    assert.ok(tokenMatch, 'error 文本携带 resume_token（FAILED 态的可续跑令牌）');
    assert.ok(String(out.next_step).includes('autonomy_resume'), 'next_step 提示可续跑');

    // 档案可 load（缺省内存档 —— autonomyTracePath 空也工作）
    tokenA = tokenMatch![1]!;
    const rec = pilotStoreFor(makeConfig()).load(tokenA);
    assert.ok(rec, '档案在库');
    assert.equal(rec!.status, 'aborted');
    assert.equal(rec!.phase, 'aborted');
    assert.equal(rec!.steps, 3);
    assert.equal(rec!.goal.goal, '开关门流程演示');
    assert.deepEqual(rec!.goal.successCriteria, ['开门标记', '关门标记']);
    assert.equal(rec!.goal.maxSteps, 3);
    assert.equal(rec!.trajectory.length, 3, '轨迹摘要逐步入档');
    assert.ok(
      rec!.trajectory.every(s => s.kind === 'click' && s.label === '开门标牌'),
      '前半世界三步全为点击「开门标牌」（判据匹配候选的确定性选择）',
    );
    const open = rec!.criteriaStatus.find(c => c.criterion === '开门标记');
    const close = rec!.criteriaStatus.find(c => c.criterion === '关门标记');
    assert.equal(open?.status, 'met', '开门标记 已核得（对「开门标牌」fuzzy 距 1 ≤ ⌈4/6⌉）');
    assert.equal(close?.status, 'unverified', '关门标记 未核（对「开门标牌」距 2 > 容差 —— 严格例，留给续跑）');
  } finally {
    restoreSystem();
    restoreEnv(savedEnv);
    resetGlmClient();
  }
});

// ─── Σ-3② autonomy_resume 续跑 ⇒ 后半达成；已 met 判据不重核 ───

test('Σ-3②: 续跑后半世界（含关门标牌、开门标记 fuzzy 严格不命中）⇒ achieved —— 判据回放 + 原档案累计', async () => {
  const savedEnv = snapshotEnv();
  const restoreSystem = patchInertSystem();
  try {
    clearEnvKeys();
    resetGlmClient();
    const deps: RuntimeDeps = {
      capture: async () => pngB, // 后半世界登场
      readWords: async buf => (buf === pngA ? wordsA : wordsB),
      groundVlm: async () => [],
      now: (() => { let t = 9_000; return () => (t += 50); })(),
      sleep: async () => { /* 零真睡 */ },
    };

    const resume = createAutonomyResumeTool(makeConfig(), deps);
    const out = await runTool(resume, { token: tokenA });

    // achieved：唯一路径 = 开门标记（回放）+ 关门标记（续跑第三次抽查核得）全 met
    assert.equal(out.status, 'SUCCESS');
    assert.equal(out.state_anchor.phase, 'achieved');
    assert.equal(out.state_anchor.criteria.met, 2);
    assert.equal(out.state_anchor.criteria.total, 2);

    // 档案续用原 token：状态翻 done，步账累计，轨迹不断血脉。
    // W2-0（接线修律）：后半 2 步即达成 —— 焦点短路步携带零成本判据核对
    //（declare 同律：W9-1 起感知快照 textDigest 走 evaluateCriteria 单一器官），
    //「关门标记」对「关门标牌」fuzzy 距 1 ≤ ⌈4/6⌉，在第 2 步的短路免截屏路径
    // 即核得，快于旧「第 3 次点击抽查」一拍（旧断言 6 = 3+3）。
    const rec = pilotStoreFor(makeConfig()).load(tokenA);
    assert.ok(rec);
    assert.equal(rec!.status, 'done');
    assert.equal(rec!.phase, 'achieved');
    assert.equal(rec!.steps, 5, '断点前后同档累计：3 + 2（短路步免费判据提前一拍）');
    assert.equal(rec!.trajectory.length, 5);
    assert.ok(
      rec!.trajectory.slice(0, 3).every(s => s.label === '开门标牌'),
      '前半轨迹原样保留（断点前步账不动）',
    );
    assert.ok(
      rec!.trajectory.slice(3).every(s => s.label === '关门标牌'),
      '后半续跑轨迹追加（判据匹配转向唯一未核的关门标记）',
    );
    assert.ok(rec!.criteriaStatus.every(c => c.status === 'met'), '判据账合并：回放的 met + 续跑新核的 met');
  } finally {
    restoreSystem();
    restoreEnv(savedEnv);
    resetGlmClient();
  }
});

// ─── Σ-3③ token 不存在 ⇒ toolErr ───

test('Σ-3③: token 不存在 ⇒ toolErr（错误信息携带 token 与落盘指引）', async () => {
  const resume = createAutonomyResumeTool(makeConfig());
  const out = await runTool(resume, { token: 'AUTO-0badc0de' });
  assert.equal(out.status, 'FAILED');
  assert.match(String(out.state_anchor.error), /AUTO-0badc0de/, '错误信息携带 token');
  assert.match(String(out.next_step), /autonomyTracePath|autonomous_run/, '指引回 autonomous_run / 落盘配置');
});

// ─── Σ-3④ 已 done 的 token ⇒ toolErr ───

test('Σ-3④: 已 done 的 token ⇒ toolErr（已完成无需续跑）', async () => {
  const resume = createAutonomyResumeTool(makeConfig());
  const out = await runTool(resume, { token: tokenA });
  assert.equal(out.status, 'FAILED');
  assert.match(String(out.state_anchor.error), /already done/, '明确拒绝已完成档案');
  assert.match(String(out.next_step), /autonomous_run/, '指引开新跑');
});

// ─── Σ-3⑤ tracePath 落盘往返 ───

test('Σ-3⑤: PilotStore(path) 落盘往返 —— begin/step/finish 后 new PilotStore(path) load/list 复原；追加续脉不断', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sigma3-pilot-'));
  const file = join(dir, 'pilots.jsonl');

  const s1 = new PilotStore(file);
  const t1 = s1.begin(
    { goal: '落盘演示', successCriteria: ['判据甲', '判据乙'], maxSteps: 5, timeBudgetSec: 60 },
    1_000,
  );
  s1.recordStep(
    t1,
    { stepIndex: 0, action: { kind: 'click', target: { label: '按钮甲' } }, outcome: 'progress', at: 1_100 },
    [
      { criterion: '判据甲', status: 'met' },
      { criterion: '判据乙', status: 'unverified' },
    ],
  );
  const t2 = s1.begin({ goal: '未完之旅', successCriteria: ['判据丙'] }, 2_000); // 故意不 finish ⇒ running
  s1.finish(
    t1,
    'aborted',
    '步数保险丝熔断（上限 5 步）',
    1_200,
    [
      { criterion: '判据甲', status: 'met' },
      { criterion: '判据乙', status: 'unverified' },
    ],
  );

  // JSONL 行型取证：追加序即行序（begin → step → begin → finish）
  const lines = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { type: string });
  assert.deepEqual(lines.map(l => l.type), ['begin', 'step', 'begin', 'finish']);

  // 重载复原：new PilotStore(path) 构造即重放铸态
  const s2 = new PilotStore(file);
  const r1 = s2.load(t1);
  assert.ok(r1, '终局档案复原');
  assert.equal(r1!.status, 'aborted');
  assert.equal(r1!.phase, 'aborted');
  assert.equal(r1!.steps, 1);
  assert.equal(r1!.startedAt, 1_000);
  assert.equal(r1!.summary, '步数保险丝熔断（上限 5 步）');
  assert.equal(r1!.goal.maxSteps, 5);
  assert.deepEqual(
    r1!.trajectory,
    [{ stepIndex: 0, kind: 'click', label: '按钮甲', outcome: 'progress', at: 1_100 }],
  );
  assert.deepEqual(r1!.criteriaStatus, [
    { criterion: '判据甲', status: 'met' },
    { criterion: '判据乙', status: 'unverified' },
  ]);

  const r2 = s2.load(t2);
  assert.ok(r2);
  assert.equal(r2!.status, 'running', '未 finish 的档案重载后仍 running（可续跑态）');

  // list：startedAt 倒序（新者先）
  const all = s2.list();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map(r => r.token), [t2, t1]);
  assert.equal(s2.load('AUTO-00000000'), null);

  // 重载档案继续追加 —— 跨进程续跑的落盘血脉不断
  s2.recordStep(
    t1,
    { stepIndex: 1, action: { kind: 'scroll' }, outcome: 'no_effect', at: 3_000 },
    [
      { criterion: '判据甲', status: 'met' },
      { criterion: '判据乙', status: 'met' },
    ],
  );
  s2.finish(t1, 'achieved', '续跑达成', 3_100);
  const s3 = new PilotStore(file);
  const r1b = s3.load(t1);
  assert.ok(r1b);
  assert.equal(r1b!.status, 'done');
  assert.equal(r1b!.phase, 'achieved');
  assert.equal(r1b!.steps, 2, '续跑步账在落盘脉络上继续累计');
  assert.ok(r1b!.criteriaStatus.every(c => c.status === 'met'));

  // 缺省构造 = 纯内存（不落盘）：token 生死随进程
  const mem = new PilotStore();
  const mt = mem.begin({ goal: '内存档', successCriteria: ['m1'] });
  assert.ok(mem.load(mt));
  assert.equal(mem.list().length, 1);
});

// ─── Σ-3⑥ autonomyEnabled=false ⇒ 两工具均 toolErr；挂载门源码正则 ───

test('Σ-3⑥: autonomyEnabled=false ⇒ autonomous_run 与 autonomy_resume 均 toolErr；resume 挂载门在 autonomousRun 块之后另块注册', async () => {
  const savedEnv = snapshotEnv();
  try {
    clearEnvKeys();
    resetGlmClient();
    const cfg = makeConfig({ autonomyEnabled: false });

    const run = await runTool(createAutonomousRunTool(cfg), { goal: '任何目标' });
    assert.equal(run.status, 'FAILED');
    assert.match(String(run.state_anchor.error), /disabled/);

    const resume = await runTool(createAutonomyResumeTool(cfg), { token: 'AUTO-00000000' });
    assert.equal(resume.status, 'FAILED');
    assert.match(String(resume.state_anchor.error), /disabled/);

    // 挂载门源码取证（Φ-V 同法）：两工具各自以 autonomyEnabled 条件挂载，resume 块在后
    const src = readFileSync(new URL('../src/tools/index.ts', import.meta.url), 'utf8');
    const runBlock = src.match(/if\s*\(config\.autonomyEnabled\)\s*\{\s*[^}]*createAutonomousRunTool/s);
    const resumeBlock = src.match(/if\s*\(config\.autonomyEnabled\)\s*\{\s*[^}]*createAutonomyResumeTool/s);
    assert.ok(runBlock, 'autonomous_run 挂载门保持原样');
    assert.ok(resumeBlock, 'autonomy_resume 挂载门在场');
    assert.ok(
      src.indexOf(runBlock![0]) < src.indexOf(resumeBlock![0]),
      'autonomy_resume 注册块须在既有 autonomousRun 注册块之后',
    );
  } finally {
    restoreEnv(savedEnv);
    resetGlmClient();
  }
});

// ─── Σ-3⑦ 锚点字段取证：ACTION_REQUIRED 终局（审批中断）的 state_anchor 携带 resume_token ───

test('Σ-3⑦: 宪法审批中断 ⇒ ACTION_REQUIRED 锚点携带 resume_token 字段；档案留 running 态可续跑', async () => {
  const savedEnv = snapshotEnv();
  let clicks = 0;
  const restoreSystem = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async () => { clicks++; },
  });
  try {
    clearEnvKeys();
    resetGlmClient();
    const deps: RuntimeDeps = {
      capture: async () => pngA,
      readWords: async buf => (buf === pngA ? wordsA : wordsB),
      groundVlm: async () => [],
      now: () => 1_000,
      sleep: async () => { /* 零真睡 */ },
    };

    const tool = createAutonomousRunTool(makeConfig(), deps);
    const out = await runTool(tool, { goal: '发送周报给主管' }); // 「发送」⇒ sensitive ⇒ approval-required

    assert.equal(out.status, 'ACTION_REQUIRED');
    assert.equal(out.state_anchor.reason, 'approval-required');
    assert.match(String(out.state_anchor.resume_token), /^AUTO-[0-9a-f]{8}$/, '锚点 resume_token 字段在场（非 achieved 终局）');
    assert.ok(String(out.next_step).includes('autonomy_resume'), 'next_step 指引人工裁决后续跑');
    assert.equal(clicks, 0, '审批升级零执行');

    // 审批中断的档案保持 running —— 人工裁决后 autonomy_resume 正是出口
    const rec = pilotStoreFor(makeConfig()).load(String(out.state_anchor.resume_token));
    assert.ok(rec);
    assert.equal(rec!.status, 'running');
    assert.equal(rec!.steps, 0);
  } finally {
    restoreSystem();
    restoreEnv(savedEnv);
    resetGlmClient();
  }
});

// ─── Σ-3⑧ ΑΩ-R17 档案有界：超限驱逐最旧已完成 + 原子压缩重写可再恢复 ───

test('Σ-3⑧: ΑΩ-R17 超限 ⇒ 最旧已完成被驱逐且新档可查；恰在上限不抖动；快照重写后文件可再恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sigma3-bound-'));
  const file = join(dir, 'pilots.jsonl');
  const lineTypes = (p: string) =>
    readFileSync(p, 'utf8').trim().split('\n').map(l => (JSON.parse(l) as { type: string }).type);

  const s = new PilotStore(file, { maxRuns: 4 });
  const tk: string[] = [];
  for (let i = 0; i < 4; i++) {
    const t = s.begin({ goal: `目标${i}`, successCriteria: [`判据${i}`] }, 1_000 + i * 100);
    tk.push(t);
    s.finish(t, 'achieved', `完成${i}`, 1_050 + i * 100);
  }

  // 恰在上限：不驱逐、不重写（文件仍纯追加行型 —— 无抖动）
  assert.equal(s.list().length, 4);
  assert.equal(s.dump().evicted, 0);
  assert.equal(s.dump().total, 4);
  assert.ok(
    lineTypes(file).every(t => t === 'begin' || t === 'finish'),
    '上限内纯追加，未触发压缩重写',
  );

  // 第 5 档：驱逐最旧已完成 tk[0]；新档在库可查；其余幸存
  const t5 = s.begin({ goal: '新跑', successCriteria: ['n1'] }, 9_000);
  assert.equal(s.dump().evicted, 1, '驱逐留痕（审计可见）');
  assert.equal(s.dump().total, 4, '在库数守恒于上限');
  assert.equal(s.load(tk[0]), null, '最旧已完成被驱逐 —— 老 token 失效（设计而非事故）');
  assert.ok(s.load(t5), '新档在库可查（驱逐不伤新人）');
  assert.ok(tk.slice(1).every(t => s.load(t)), '较新的已完成档幸存');

  // 压缩阈值 = max(1, ⌊4/10⌋) = 1 ⇒ 已原子重写：文件只含幸存快照行
  assert.deepEqual(lineTypes(file), ['snapshot', 'snapshot', 'snapshot', 'snapshot']);
  assert.equal(s.dump().compactions, 1);
  assert.equal(s.dump().persistent, true);

  // 重写后文件可再恢复：new PilotStore(path) 重放快照行铸态，死档不复活
  const s2 = new PilotStore(file, { maxRuns: 4 });
  assert.equal(s2.load(tk[0]), null, '盘上死行已随重写消失');
  assert.equal(s2.list().length, 4);
  assert.equal(s2.dump().evicted, 0, '压缩后的档案重放不再触发驱逐');
  const r2 = s2.load(tk[1]!);
  assert.ok(r2, '幸存终局档复原');
  assert.equal(r2!.status, 'done');
  assert.equal(r2!.phase, 'achieved');
  assert.equal(r2!.summary, '完成1');
  assert.equal(r2!.goal.successCriteria[0], '判据1');
  const r5 = s2.load(t5);
  assert.ok(r5, '进行中档随快照复原');
  assert.equal(r5!.status, 'running');

  // 恢复后续脉不断：快照行 + 追加行混合文件照常重放
  s2.recordStep(
    t5,
    { stepIndex: 0, action: { kind: 'click', target: { label: '按钮N' } }, outcome: 'progress', at: 9_100 },
    [{ criterion: 'n1', status: 'met' }],
  );
  s2.finish(t5, 'achieved', '续跑达成', 9_200);
  const s3 = new PilotStore(file, { maxRuns: 4 });
  const r5b = s3.load(t5);
  assert.ok(r5b);
  assert.equal(r5b!.status, 'done');
  assert.equal(r5b!.steps, 1, '快照后的追加步账照常累计');
  assert.equal(r5b!.trajectory[0]!.label, '按钮N');
  assert.ok(r5b!.criteriaStatus.every(c => c.status === 'met'));
});

// ─── Σ-3⑨ ΑΩ-R17 驱逐政策：进行中永不驱逐；全在进行中诚实跳过 ───

test('Σ-3⑨: ΑΩ-R17 进行中档案永不驱逐（超限诚实跳过）；完成即参与驱逐 —— 最旧者优先', () => {
  const s = new PilotStore(undefined, { maxRuns: 2 }); // 纯内存小上限
  const t1 = s.begin({ goal: '长跑一', successCriteria: ['a'] }, 100);
  const t2 = s.begin({ goal: '长跑二', successCriteria: ['b'] }, 200);
  const t3 = s.begin({ goal: '长跑三', successCriteria: ['c'] }, 300); // 超限但全在进行中
  assert.equal(s.dump().total, 3, '全在进行中 ⇒ 诚实跳过（不驱逐活跃血脉来凑数）');
  assert.equal(s.dump().evicted, 0);
  assert.ok([t1, t2, t3].every(t => s.load(t)), '三档全在（running 不驱逐）');

  // t1 完成 ⇒ 成为「最旧已完成」候选，finish 补驱
  s.finish(t1, 'failed', '终局失败', 400);
  assert.equal(s.dump().total, 2);
  assert.equal(s.dump().evicted, 1);
  assert.equal(s.load(t1), null, '完成后即遭驱逐（最旧已完成优先于较新进行中）');
  assert.ok(s.load(t2) && s.load(t3), '进行中两档幸存');
  assert.equal(s.dump().maxRuns, 2, '审计面携带上限配置');
});

// ─── Σ-3⑩ ΑΩ-R17 端到端：缺省上限 500；被驱逐 token 经 autonomy_resume 诚实拒绝 ───

test('Σ-3⑩: ΑΩ-R17 缺省上限 500 —— 第 501 档驱逐最旧；盘上死行未达阈值不重写；老令牌 resume ⇒ toolErr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sigma3-cap500-'));
  const file = join(dir, 'pilots.jsonl');
  const cfg = makeConfig({ autonomyTracePath: file });
  const store = pilotStoreFor(cfg); // 与工具同源的缓存实例（pilotStoreFor 同路径同实例）

  let oldest = '';
  for (let i = 0; i < 501; i++) {
    const t = store.begin({ goal: `高频运行${i}`, successCriteria: ['c'] }, 1_000 + i);
    if (i === 0) oldest = t;
    store.finish(t, 'achieved', `done ${i}`, 1_100 + i);
  }
  assert.equal(store.dump().total, 500, '缺省上限 500 守恒');
  assert.equal(store.dump().evicted, 1, '恰第 501 档驱逐最旧一份');
  assert.equal(store.load(oldest), null, '最老令牌失效');
  assert.equal(store.dump().compactions, 0, '驱逐 1 < 阈值 50 ⇒ 未重写（追加为主，防抖动）');

  // 纯追加文件（1002 行）重放：盘上死行铸态后再驱逐 —— 死档不复活、计数守恒
  const re = new PilotStore(file);
  assert.equal(re.dump().total, 500, '重放守恒于上限（list 另有 50 条展示帽，计数走 dump）');
  assert.equal(re.list().length, 50, 'list 展示帽照常');
  assert.equal(re.load(oldest), null);
  assert.equal(re.dump().evicted, 1, '重放后补驱留痕');
  assert.equal(re.dump().persistent, true);

  // 老令牌过期诚实：autonomy_resume 走既有「No pilot run found」拒绝路径
  const resume = createAutonomyResumeTool(cfg);
  const out = await runTool(resume, { token: oldest });
  assert.equal(out.status, 'FAILED');
  assert.match(String(out.state_anchor.error), /No pilot run found/, '失效 token 明确拒绝而非谎报可续');
});
