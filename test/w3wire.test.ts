// test/w3wire.test.ts
// W3-0（第2批集成接线包）单测：把 W2 九器官的接线面逐条验证「接通且受控」——
//   ① freshness 端口武装（组合根同款表达式 + 缺席/武装/卸载三态 + 诚实降级零网络）；
//   ② recoveryEfficacy 接线生效（restore 无档诚实起步 → setPersistence 武装 →
//      回合闭合自动落盘 → 卸载面 persist+reset → 下次会话 restore 复账）；
//   ③ adjudicate_approval_queue 注册可见（源级断言挂载门 —— tools 桶在 Node strip
//      装载器有已知地雷且 approval.ts 正被并行代理编辑，epochR/vlm.integration
//      源码正则先例；工具本体行为由 w2queue.test.ts 覆盖）；
//   ④ cascade 导出面 + configureVlm 铸造（tiers 入池 / 双钥激活 / 缺省阈值下
//      保守静态因子 ⇒ 弃权零网络 / 空配置摘除幂等）；
//   ⑤ resetVerifyGateBudget 边界挂点（groundElements 复核预算跨调用累积 →
//      runPilotLoop 跑环边界清零 → 下一调用从 0 重新计）。
// 全离线确定性：假截屏（sharp 现场生成真 PNG）、假 GLM client、monkey-patch 键鼠、
// 注入时钟零真睡。参考 w2wire 注入风格。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { default as sharp } from 'sharp';
import { system } from '../src/system.ts';
import { contextManager } from '../src/contextManager.ts';
import { Config as ConfigSchema, type Config } from '../src/config.ts';
import { kernelRegistry } from '../src/kernel/registry.ts';
import {
  setFreshnessPort, defaultFreshnessPort, freshnessPortInstalled,
  resetFreshnessProbe, probeGroundingFreshness,
} from '../src/popupDetector.ts';
import { recoveryEfficacy } from '../src/recoveryEfficacy.ts';
import { resetVerifyGateBudget, groundElements } from '../src/vlm/grounding.ts';
import type { GlmClient } from '../src/vlm/glmClient.ts';
// cascade 全族导出面（经 vlm/index 桶再分发 —— 本测试即其消费证据）
import {
  configureVlm, getProviderPool, getVlmCascade,
  VlmCascade, triageDanger, withinBboxValidator, schemaValidator, ocrTextValidator,
  CASCADE_TRIAGE_WEIGHTS, CASCADE_DANGER_MAX,
} from '../src/vlm/index.ts';
// ⑤ 跑环边界挂点（autonomous_run / autonomy_resume 共用脊梁）
import { runPilotLoop } from '../src/tools/autonomousRun.ts';
import { GoalStateMachine, PilotStore } from '../src/autonomy/index.ts';
import type { RuntimeDeps } from '../src/autonomy/index.ts';

// ─── 假件工坊 ───

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

/** 纯灰 PNG（提示词系 = 编码系 = buffer 系 —— 无缩放干扰） */
async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 96, g: 96, b: 96 } } })
    .png().toBuffer();
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

/** 手写最小 autonomy 配置（与 w2wire 同法 —— 缺字段按 falsy 缺省走零行为臂） */
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
    defaultValue: 1, min: 0, max: 1, note: 'W3-0 测试注册',
  });
}

// 全局隔离：文件级 before/after 清零跨测试单例（上下文窗/内核/复核预算/探针/疗效账）
const tmpDirs: string[] = [];
before(() => {
  contextManager.reset();
  registerVerifyZoomKernel();
  kernelRegistry.set('grounding.verifyZoom', 1);
  resetVerifyGateBudget();
  resetFreshnessProbe();
  recoveryEfficacy.reset();
});
after(() => {
  contextManager.reset();
  kernelRegistry.set('grounding.verifyZoom', 1);
  resetVerifyGateBudget();
  resetFreshnessProbe();
  recoveryEfficacy.reset();
  configureVlm({}); // 级联/池摘除（幂等）—— 不留模块级状态给后续文件
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } }
});

// ─── W3-A①：freshness 端口武装（组合根接线面） ───

test('W3-A①: defaultFreshnessPort 武装三态 —— 缺席/武装(诚实降级零网络)/卸载', async () => {
  // 缺席基线（接线前的缺省态）
  resetFreshnessProbe();
  assert.equal(freshnessPortInstalled(), false, '未武装 ⇒ 端口缺席');
  const v0 = await probeGroundingFreshness();
  assert.equal(v0.verdict, 'degraded', '端口缺席 ⇒ degraded 放行（fail-open）');
  assert.match(v0.note ?? '', /probe-port-absent/, '缺席注记点名');

  // 武装（组合根同款表达式 —— src/index.ts apply() 的字面接线）
  setFreshnessPort(defaultFreshnessPort());
  assert.equal(freshnessPortInstalled(), true, '武装 ⇒ 端口在场');
  // 诚实降级路径：contextManager 无最近截图 ⇒ groundingHash null ⇒ 在触碰
  // 当前帧源（physicalBackend metaOnly 快图）之前就以 grounding-fingerprint-absent
  // 收口 —— 本测试全程零后端拨号。
  contextManager.reset();
  const v1 = await probeGroundingFreshness();
  assert.equal(v1.verdict, 'degraded', '指纹缺席 ⇒ degraded 放行');
  assert.match(v1.note ?? '', /grounding-fingerprint-absent/, '指纹缺席注记点名（未触后端）');

  // 卸载面（src/index.ts 卸载清理的字面接线 —— W-1 单例隔离律）
  setFreshnessPort(null);
  assert.equal(freshnessPortInstalled(), false, '卸载 ⇒ 端口归缺席');
});

test('W3-A①附: 组合根源级断言 —— index.ts 含武装/卸载两条字面接线', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(src, /setFreshnessPort\(defaultFreshnessPort\(\)\);/, '启动路径必须武装默认端口');
  assert.match(src, /setFreshnessPort\(null\);/, '卸载路径必须卸下端口');
});

// ─── W3-A②：recoveryEfficacy 接线生效（restore/持久化/复账全链） ───

test('W3-A②: 疗效账本接线全链 —— 无档起步/武装/回合闭合自动落盘/卸载面/复账', () => {
  const dir = mkdtempSync(join(tmpdir(), 'w3wire-eff-'));
  tmpDirs.push(dir);
  const path = join(dir, 'efficacy.json');

  // 启动路径①：restore 无档 ⇒ 诚实 fresh start（ok:false 不抛）
  const r1 = recoveryEfficacy.restore(path);
  assert.equal(r1.ok, false, '无档 ⇒ ok:false');
  assert.equal(r1.restored, 0);

  // 启动路径②：setPersistence 武装（src/index.ts 的字面顺序）
  recoveryEfficacy.setPersistence(path);

  // 喂一个完整恢复回合：失败开回合（target-not-found 症候）→ 感知成功闭回合
  const opened = recoveryEfficacy.ingest({ kind: 'failure', tool: 'click_mouse', symptom: 'target not found' });
  assert.equal(opened, null, '开回合事件不闭合（闭回合由后续事件返回）');
  const closed = recoveryEfficacy.ingest({ kind: 'success', tool: 'take_screenshot' });
  assert.ok(closed, 'take_screenshot 成功 ⇒ 回合以 recovered 闭合');
  assert.equal(closed!.outcome, 'recovered');
  assert.ok(existsSync(path), '回合闭合 ⇒ 自动原子落盘（setPersistence 武装的消费证据）');

  // 卸载面（src/index.ts 卸载清理的字面顺序）：persist 兜底 → reset 归零
  const saved = recoveryEfficacy.persist(path);
  assert.equal(saved.ok, true, '卸载兜底落盘成功');
  recoveryEfficacy.reset();
  const snap0 = recoveryEfficacy.snapshot();
  assert.equal(snap0.cells.length, 0, 'reset ⇒ 回到构造态（W-1 单例隔离律）');

  // 下次会话：restore 复账（防御性逐格校验后的账目在场）
  const r2 = recoveryEfficacy.restore(path);
  assert.equal(r2.ok, true, '有档 ⇒ ok:true');
  assert.equal(r2.restored, 1, '一格账复载');
  const snap1 = recoveryEfficacy.snapshot();
  assert.equal(snap1.cells.length, 1);
  assert.equal(snap1.cells[0]!.action, 're-observe', 'take_screenshot 记名为 re-observe 动作');
  assert.equal(snap1.cells[0]!.successes, 1, '成功观察入账');
  recoveryEfficacy.reset(); // 清理（不留持久化武装）
});

test('W3-A②附: 组合根源级断言 —— index.ts 含 restore/setPersistence/卸载兜底三条字面接线', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(src, /recoveryEfficacy\.restore\(config\.recoveryEfficacyPath\);/, '启动路径必须复载');
  assert.match(src, /recoveryEfficacy\.setPersistence\(config\.recoveryEfficacyPath\);/, '启动路径必须武装自动持久化');
  assert.match(src, /recoveryEfficacy\.persist\(config\.recoveryEfficacyPath\)/, '卸载路径必须兜底落盘');
});

// ─── W3-A③ + B①：adjudicate 注册可见 + 睡眠队列源级断言 ───

test('W3-B①: adjudicate_approval_queue 挂载门 —— enableApprovalGate 同门注册（源级断言）', () => {
  const src = readFileSync(new URL('../src/tools/index.ts', import.meta.url), 'utf8');
  // 既有挂载门原行不动（ask_screen 立法文本正则锁定区之外）
  assert.match(src, /tools\.push\(createRequestApprovalTool\(config\), createGrantApprovalTool\(config\)\);/, 'request/grant 挂载门原行保持');
  // W3-0 新块：adjudicate 与 request/grant 同门（enableApprovalGate）
  assert.match(
    src,
    /if\s*\(config\.enableApprovalGate\)\s*\{\s*tools\.push\(createAdjudicateApprovalQueueTool\(config\)\);/s,
    'adjudicate 必须条件挂载（enableApprovalGate）',
  );
  // import 面在场
  assert.match(src, /createAdjudicateApprovalQueueTool/, '桶文件引入 adjudicate 工厂');
});

test('W3-A③: 睡眠晨报待批清单源 —— runSleepCycle deps 注入 approvalQueue（源级断言）', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const m = src.match(/runSleepCycle\(([\s\S]{0,2400}?)sleepTracePath/s);
  assert.ok(m, '应找到 runSleepCycle 调用体（至 sleepTracePath 配置段）');
  assert.match(m[1], /approvalQueue,/, 'deps 必须注入 approvalQueue（W2-1 H4 晨报待批清单源）');
});

// ─── W3-C：cascade 导出面 + configureVlm 铸造 ───

test('W3-C①: config 三新字段缺省 —— tiers 空 / dangerMax 0.35 / efficacyPath 空（零行为变化）', () => {
  const resolve = ConfigSchema as unknown as (v: unknown) => Config;
  const cfg = resolve({});
  assert.equal(cfg.vlmProviderTiers, '', 'tier 表缺省空 ⇒ 池内无 cheap 档 ⇒ 级联恒弃权');
  assert.equal(cfg.vlmCascadeDangerMax, 0.35, '级联阈值缺省 0.35（保守静态因子 danger 0.6 ⇒ 弃权）');
  assert.equal(cfg.recoveryEfficacyPath, '', '疗效账本路径缺省空 ⇒ 纯内存');
});

test('W3-C②: cascade 全族导出面 —— vlm/index 桶再分发在场可用', () => {
  assert.equal(typeof VlmCascade, 'function', 'VlmCascade 执行体');
  assert.equal(typeof triageDanger, 'function', '三因子打分');
  assert.equal(typeof withinBboxValidator, 'function', 'bbox 谓词');
  assert.equal(typeof schemaValidator, 'function', 'schema 谓词');
  assert.equal(typeof ocrTextValidator, 'function', 'OCR 文字谓词');
  assert.equal(typeof CASCADE_TRIAGE_WEIGHTS, 'object', '缺省权重常量');
  assert.equal(typeof CASCADE_DANGER_MAX, 'number', '缺省阈值常量');
  // 谓词族离线可复算（导出面的行为证据；浮点容差 —— 0.4×(1−0.9)=0.04 的
  // 二进制尾数噪声不是打分语义的一部分）
  assert.ok(Math.abs(triageDanger({ confidence: 0.9, risk: 'low', sceneFamiliar: true }) - 0.04) < 1e-9, '高置信低危旧场景 ⇒ danger ≈ 0.04');
  const v = withinBboxValidator({ x0: 0, y0: 0, x1: 10, y1: 10 });
  assert.equal(v.check({ point: { x: 5, y: 5 } }), true, '框内点过检');
  assert.equal(v.check({ point: { x: 50, y: 5 } }), false, '框外点不过（升级方向）');
});

test('W3-C③: configureVlm 铸造 —— tiers 入池/双钥激活/缺省阈值弃权零网络/摘除幂等', async () => {
  // 未标 cheap：池在场但级联不铸（第一钥缺席）
  configureVlm({ vlmFallbackProviders: 'ollama' });
  assert.ok(getProviderPool(), 'fallbacks 非空 ⇒ 池铸造');
  assert.ok(getProviderPool()!.tierRoster().every(e => e.tier === 'primary'), '未标 tier ⇒ 全 primary');
  assert.equal(getVlmCascade(), null, '无 cheap 档 ⇒ 级联不铸（零行为变化律）');

  // 双钥齐备：tiers 标 cheap + 池在场 ⇒ 铸级联 + roster 标注入池
  configureVlm({ vlmFallbackProviders: 'ollama', vlmProviderTiers: 'ollama=cheap' });
  const cascade = getVlmCascade();
  assert.ok(cascade instanceof VlmCascade, 'cheap 档标注 ⇒ 级联铸造');
  const roster = getProviderPool()!.tierRoster();
  assert.ok(
    roster.some(e => e.id === 'ollama' && e.tier === 'cheap'),
    `tier 标注入池（实际 ${JSON.stringify(roster)}）`,
  );
  // 缺省阈值下的失败安全：保守静态因子（中危/新场景/中性置信 ⇒ danger 0.6）>
  // 0.35 ⇒ 高危直行主力（弃权）—— 零网络零拨号（primaryDirect 记账可观测）。
  const before = cascade!.stats.primaryDirect;
  const r = await cascade!.runJson({ images: [], prompt: 'p' });
  assert.equal(r, null, '缺省阈值 ⇒ 弃权（主路径照走）');
  assert.equal(cascade!.stats.primaryDirect, before + 1, 'primaryDirect 记账（接线态因子源的消费证据）');

  // 空配置摘除（幂等）：池与级联双双归 null
  configureVlm({});
  assert.equal(getProviderPool(), null, '空 fallbacks ⇒ 池置 null');
  assert.equal(getVlmCascade(), null, '级联摘除');
});

// ─── W3-B②：resetVerifyGateBudget 边界挂点（runPilotLoop 跑环边界） ───

test('W3-B②: 跑环边界清零 —— 复核预算跨调用累积 → runPilotLoop 后从 0 重新计', async () => {
  const png = await makePng(200, 150);
  // 低置信（0.5 < 0.6）单元素 ⇒ 每次主定位触发一次 Zoom 复核（预算 +1）
  const fake = fakeGlmClient({
    groundingValue: () => ({ elements: [{ id: 'x', label: '低置信按钮', role: 'button', bbox: [20, 20, 90, 80], confidence: 0.5 }] }),
    ocrValue: () => ({ words: [{ text: '低置信按钮', confidence: 0.9, bbox: [20, 20, 90, 80] }] }),
  });
  const budgetOf = async (): Promise<number> => {
    const r = await groundElements(png, {
      client: fake.client, verifyClient: fake.client, width: 200, height: 150,
    });
    assert.ok(r.verifyGate, '闸开 ⇒ 复核报告在场');
    return r.verifyGate!.budgetUsed;
  };

  // 已知取舍的行为基线：未过跑环边界 ⇒ 预算跨调用累积（1 → 2）
  resetVerifyGateBudget();
  assert.equal(await budgetOf(), 1, '首次主定位 ⇒ 预算 1');
  assert.equal(await budgetOf(), 2, '同任务二次调用 ⇒ 累积到 2（边界清零前的共享行为）');

  // 跑环边界：runPilotLoop 起点 resetVerifyGateBudget（autonomous_run 与
  // autonomy_resume 共用脊梁 ⇒ 双工具同律）。环内 grounding 用高置信元素
  //（0.95 > 0.6、短边 60 ≥ 24、密度 1 ≤ 5）⇒ 环内零复核消耗。
  const fakeRun = fakeGlmClient({
    groundingValue: () => ({ elements: [{ id: 'x', label: '稳按钮', role: 'button', bbox: [20, 20, 90, 80], confidence: 0.95 }] }),
    ocrValue: () => ({ words: [] }),
  });
  const deps: RuntimeDeps = {
    capture: async () => png,
    readWords: async () => [{ label: '任务启动', bbox: { x0: 10, y0: 10, x1: 60, y1: 30 }, confidence: 0.9 }],
    client: fakeRun.client,
    now: (() => { let c = 0; return () => (c += 50); })(),
    sleep: async () => { /* 零真睡 */ },
  };
  const spec = {
    goal: 'g', successCriteria: ['永不出现的判据字面XYZ'], maxSteps: 2, timeBudgetSec: 5,
  };
  const nowFn = deps.now ?? (() => Date.now());
  const store = new PilotStore();
  const token = store.begin(spec, nowFn());
  const goalMachine = new GoalStateMachine(spec, nowFn);
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

  // 边界清零的行为证据：跑环后下一次主定位从 0 重新计（若无清零则应为 3）
  assert.equal(await budgetOf(), 1, '跑环边界 ⇒ 预算清零后从 1 重新计');
});
