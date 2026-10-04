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
//      runPilotLoop 跑环边界作用域清零 `pilot:<token>` → 本任务键从 0 重新计、
//      他任务键与缺省账本不动 —— W6R-B2 预算按任务隔离的接线断言）+ W8-B2
//      消费面终态（runtime 缺省接地经 RuntimeDeps.verifyTaskId 落任务键账本、
//      orchestration L3 适配器经 sessionId 供给铸 `session:<id>` 键与宿主回合
//      边界同键闭环 —— 缺省账本自此零消费面续账）。
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
// cascade 全族导出面（经 vlm/index 桶再分发 —— 本测试即其消费证据）
// ΑΩ-R2：另引入桶面接线件 —— GlmClient/attachCascadeFace（级联咨询桥的 E2E）
// 与请求级动态因子面（cascadeRequestFactors/resetCascadeTriageFamiliarity）。
import {
  configureVlm, getProviderPool, getVlmCascade,
  VlmCascade, triageDanger, withinBboxValidator, schemaValidator, ocrTextValidator,
  CASCADE_TRIAGE_WEIGHTS, CASCADE_DANGER_MAX,
  attachCascadeFace, GlmClient,
  cascadeRequestFactors, resetCascadeTriageFamiliarity,
  classifyCascadeRequest, cascadeSemanticValidators, wireCascadeConsultFace,
  attachVlmRateLimiter, getGlmClient, resetGlmClient,
} from '../src/vlm/index.ts';
import type { CascadePoolFace, CascadeValidator, ProviderTier } from '../src/vlm/index.ts';
// ⑤ 跑环边界挂点（autonomous_run / autonomy_resume 共用脊梁）+ W8-B2 消费面终态
import { runPilotLoop } from '../src/tools/autonomousRun.ts';
import { GoalStateMachine, PilotStore, createPerceive } from '../src/autonomy/index.ts';
import type { RuntimeDeps } from '../src/autonomy/index.ts';
import { createSemanticFromVlm } from '../src/orchestration/visionAdapters.ts';

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

// ─── ΑΩ-R2（级联因子源点亮）：请求级动态因子执法 ───
//
// 病灶：原接线 factors 恒静态保守（danger 恒 0.6 > 0.35）⇒ 配了便宜档也永不
// 触发。执法三面：① 低危 + 同 prompt 复现 ⇒ 命中便宜臂（真实省钱事件）；
// ② 危险词 ⇒ 恒主力（复现/高置信也压不进便宜臂）；③ factors 缺席 ⇒ 旧行为
// （静态保守源 danger 0.6 ⇒ 弃权）。全离线：假级联池 + 假 fetch，零网络。

/** 假级联池（w2cascade 手写桩同律）：cheap/primary 双档 + 调用计数 */
function fakeCascadePool(cheapText: string): {
  pool: CascadePoolFace;
  cheapCalls: () => number;
  primaryCalls: () => number;
} {
  let cheap = 0;
  let primary = 0;
  const pool: CascadePoolFace = {
    size: 2,
    tierRoster: () => [
      { id: 'cheap-1', tier: 'cheap' as ProviderTier },
      { id: 'main-1', tier: 'primary' as ProviderTier },
    ],
    async chatTier(_req, tier) {
      if (tier === 'cheap') {
        cheap++;
        return { ok: true, text: cheapText, latencyMs: 5, model: 'm-cheap', providerId: 'cheap-1' };
      }
      primary++;
      return { ok: true, text: '{"from":"primary"}', latencyMs: 9, model: 'm-main', providerId: 'main-1' };
    },
  };
  return { pool, cheapCalls: () => cheap, primaryCalls: () => primary };
}

/** ΑΩ-R2 假 fetch（级联弃权时单例主路径才抵达 —— 计数即承接证据）；w7fullon 同款 */
function fakeCascadeFetch(): { fetchImpl: typeof fetch; calls: () => number } {
  let n = 0;
  const fetchImpl = (async (): Promise<Response> => {
    n++;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"from":"singleton"}' } }] }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => n };
}

/** ΑΩ-R2 同款执行器：铸池面静态保守源 + 咨询桥供请求级动态因子（configureVlm 同构） */
function wireR2Cascade(pool: CascadePoolFace): VlmCascade {
  return new VlmCascade(pool, {
    factors: () => ({ risk: 'medium' as const, sceneFamiliar: false, confidence: 0.5 }),
    validators: [{
      name: 'json-structural',
      check: (v: unknown) => v !== null && (Array.isArray(v) || typeof v === 'object'),
    }],
  });
}

test('ΑΩ-R2①: 低风险+配置便宜档 ⇒ 同 prompt 复现命中便宜臂（danger 0.2 < 0.35）', async () => {
  resetCascadeTriageFamiliarity();
  const { pool, cheapCalls, primaryCalls } = fakeCascadePool('{"from":"cheap"}');
  const cascade = wireR2Cascade(pool);
  attachCascadeFace({
    consultJson: req => cascade.runJson(req, { factors: cascadeRequestFactors(req) }),
  });
  const { fetchImpl, calls: fetchCalls } = fakeCascadeFetch();
  const client = new GlmClient({ apiKey: 'k', model: 'm', fetchImpl });
  const PROMPT = '识别图中所有可见文字。只输出严格 JSON。';
  try {
    // 首见：低危但新场景 ⇒ danger = 0.4×0.5 + 0.2×1 = 0.4 > 0.35 ⇒ 弃权走主路径
    const r1 = await client.chatJson<{ from?: string }>({ images: [], prompt: PROMPT, maxRetries: 0 });
    assert.equal(r1.ok, true);
    assert.equal(r1.value?.from, 'singleton', '首见弃权 ⇒ 单例主路径应答（无证据不便宜）');
    assert.equal(fetchCalls(), 1, '弃权 ⇒ 单例拨号恰一次');
    assert.equal(cheapCalls(), 0, '便宜脑零调用');
    // 因子直测：低危分类 + 复现后熟悉 + 置信诚实中性
    const f = cascadeRequestFactors({ prompt: PROMPT });
    assert.equal(f.risk, 'low', '只读观察语义且无危险词 ⇒ low');
    assert.equal(f.sceneFamiliar, true, '同 prompt 复现 ⇒ 场景熟悉（重复度代理）');
    assert.equal(f.confidence, 0.5, '置信不可得 ⇒ 中性 0.5（诚实）');
    assert.ok(triageDanger(f) < CASCADE_DANGER_MAX, `低危+熟悉 ⇒ danger ${triageDanger(f)} < 0.35`);
    // 复现：danger = 0.4×0.5 = 0.2 ≤ 0.35 ⇒ 便宜臂点亮（结构校验过检直采）
    const r2 = await client.chatJson<{ from?: string }>({ images: [], prompt: PROMPT, maxRetries: 0 });
    assert.equal(r2.ok, true);
    assert.equal(r2.value?.from, 'cheap', '复现 ⇒ 便宜臂过检直采（暗功能点亮）');
    assert.equal(fetchCalls(), 1, '承接后单例零新拨号');
    assert.equal(cheapCalls(), 1, '便宜脑恰一调');
    assert.equal(primaryCalls(), 0, '主力零调用（省钱事件）');
    assert.equal(cascade.stats.cheapHit, 1, 'cheap-hit 记账');
  } finally {
    attachCascadeFace(null);
    resetCascadeTriageFamiliarity();
  }
});

test('ΑΩ-R2②: 危险词 ⇒ 恒主力（场景复现/置信拉满也压不进便宜臂）', async () => {
  resetCascadeTriageFamiliarity();
  const { pool, cheapCalls } = fakeCascadePool('{"from":"cheap"}');
  const cascade = wireR2Cascade(pool);
  const DANGER_PROMPT = '把回收站里的旧邮件全部删除，然后发送确认回执';
  try {
    // 因子直测：危险词（删除/发送）⇒ high；与熟悉度正交（复现仍 high）
    const f1 = cascadeRequestFactors({ prompt: DANGER_PROMPT });
    assert.equal(f1.risk, 'high', '危险词 ⇒ high');
    assert.equal(f1.sceneFamiliar, false, '首见 ⇒ 新场景');
    const f2 = cascadeRequestFactors({ prompt: DANGER_PROMPT });
    assert.equal(f2.risk, 'high', '复现仍 high（词法分级与熟悉度正交）');
    assert.equal(f2.sceneFamiliar, true, '复现 ⇒ 熟悉（但压不过 high）');
    assert.ok(triageDanger(f2) > CASCADE_DANGER_MAX, `危险词因子 danger ${triageDanger(f2)} > 0.35`);
    // 数学执法：high 在最好余因子（熟悉+置信拉满）下 danger = 0.4 恒 > 0.35
    assert.ok(
      triageDanger({ risk: 'high', sceneFamiliar: true, confidence: 1 }) > CASCADE_DANGER_MAX,
      'high 上界情形仍 > 0.35 ⇒ 恒主力',
    );
    // 行为执法：三次同 prompt 咨询全部弃权（primaryDirect 记账），便宜脑零调用
    const before = cascade.stats.primaryDirect;
    for (let i = 0; i < 3; i++) {
      const r = await cascade.runJson(
        { images: [], prompt: DANGER_PROMPT },
        { factors: cascadeRequestFactors({ prompt: DANGER_PROMPT }) },
      );
      assert.equal(r, null, `第 ${i + 1} 次咨询 ⇒ 弃权（恒主力）`);
    }
    assert.equal(cascade.stats.primaryDirect, before + 3, '三次全记高危直行');
    assert.equal(cheapCalls(), 0, '便宜脑零调用');
  } finally {
    resetCascadeTriageFamiliarity();
  }
});

test('ΑΩ-R2③: factors 缺席 ⇒ 旧行为（保守静态源 danger 0.6 ⇒ 弃权）', async () => {
  configureVlm({ vlmFallbackProviders: 'ollama', vlmProviderTiers: 'ollama=cheap' });
  const cascade = getVlmCascade();
  assert.ok(cascade instanceof VlmCascade, '双钥 ⇒ 级联铸造');
  // 直接 runJson 无 perCall：请求文本再低危也不进动态因子 —— 实例静态保守源
  // （medium/false/0.5 ⇒ danger 0.6）保持 W3-0 旧行为，弃权且零拨号。
  const before = cascade!.stats.primaryDirect;
  const r = await cascade!.runJson({ images: [], prompt: '识别图中所有可见文字。' });
  assert.equal(r, null, 'factors 缺席 ⇒ danger 0.6 > 0.35 ⇒ 弃权（旧行为）');
  assert.equal(cascade!.stats.primaryDirect, before + 1, 'primaryDirect 记账（旧行为）');
  // 信号不可用的诚实回落：空请求 ⇒ medium/新场景/中性置信（与旧静态源同值）
  const f = cascadeRequestFactors({});
  assert.deepEqual(f, { risk: 'medium', sceneFamiliar: false, confidence: 0.5 }, '信号不可用 ⇒ 保守回落（诚实原则）');
  assert.ok(triageDanger(f) > CASCADE_DANGER_MAX, '回落因子 ⇒ 仍弃权');
  configureVlm({}); // 摘除（幂等）—— 不留模块级状态给后续测试
});

test('ΑΩ-R2④: 组合根源级断言 —— 咨询桥接请求级动态因子 + 实例静态保守源保持', () => {
  const src = readFileSync(new URL('../src/vlm/index.ts', import.meta.url), 'utf8');
  assert.match(src, /factors:\s*cascadeRequestFactors\(req\)/, 'consultJson 桥必须供请求级动态因子（perCall 优先律）');
  assert.match(
    src,
    /factors:\s*\(\)\s*=>\s*\(\{\s*risk:\s*'medium'/,
    '实例因子源保持 W3-0 静态保守值（直接 runJson 旧行为逐字节保持）',
  );
});

// ─── ΝΩ-18（桥面语义谓词）：按请求类型注册的便宜臂法定校验 ───
//
// 病灶：级联桥只验「非空对象/数组」—— grounding 空 elements / verdict 缺字段 /
// OCR 缺 words 都过检直采。执法三面：① 分类面（三器官提示词标记词判型）；
// ② 谓词面（三型语义谓词的过/不过矩阵）；③ 桥面（wireCascadeConsultFace 装配
// 后的端到端：语义不过 ⇒ 走 cascade 升级路径，主力重做）。全离线假池假 fetch。

/** 三器官真实提示词片段（som.ts 构造器同源 —— 分类面的判型材料） */
const GROUNDING_REQ = {
  system: '你是屏幕元素定位器。只输出严格 JSON 数组……',
  prompt: '图像尺寸：800×600 像素……任务：列出图中所有可交互元素与关键文字块……',
};
const VERDICT_REQ = { prompt: '对比前图与后图，判断预期是否达成：打开设置。只输出严格 JSON：{"verdict":"confirmed/refuted/uncertain 之一"……' };
const OCR_REQ = { prompt: '识别图中所有可见文字。只输出严格 JSON：{"words":[{"text":"原文","bbox":[x0,y0,x1,y1]}]}。' };
const GENERIC_REQ = { prompt: '描述这张桌面上正在发生什么' };

test('ΝΩ-18①: 请求类型分类 —— 三器官标记词判型 + 泛化请求归 generic + 脏值防御', () => {
  assert.equal(classifyCascadeRequest(GROUNDING_REQ), 'grounding', 'system 标记词判 grounding');
  assert.equal(classifyCascadeRequest({ prompt: GROUNDING_REQ.prompt }), 'grounding', 'prompt 标记词同律');
  assert.equal(classifyCascadeRequest(VERDICT_REQ), 'verdict');
  assert.equal(classifyCascadeRequest(OCR_REQ), 'ocr');
  assert.equal(classifyCascadeRequest(GENERIC_REQ), 'generic', '泛化请求零语义谓词（零行为变化律）');
  assert.equal(classifyCascadeRequest(null), 'generic');
  assert.equal(classifyCascadeRequest({ prompt: 42, system: undefined }), 'generic', '脏值防御');
});

test('ΝΩ-18②: 三型语义谓词过/不过矩阵 —— 空 elements/缺 bbox/枚举外 verdict/缺 words 全拦截', () => {
  // grounding：elements 非空且首条有 bbox（双形态 bbox + {elements} 方言）
  const g = cascadeSemanticValidators(GROUNDING_REQ);
  assert.equal(g.length, 1);
  assert.equal(g[0]!.name, 'semantic-grounding');
  assert.equal(g[0]!.check({ elements: [{ id: 'e1', label: '确定', role: 'button', bbox: [10, 20, 90, 80], confidence: 0.9 }] }), true, '好载荷过检');
  assert.equal(g[0]!.check([{ bbox: { x0: 1, y0: 2, x1: 3, y1: 4 } }]), true, '裸数组方言 + 对象形 bbox 过检');
  assert.equal(g[0]!.check({ elements: [] }), false, '空 elements 拦截（病灶一）');
  assert.equal(g[0]!.check({ elements: [{ id: 'e1', label: '无框' }] }), false, '首条缺 bbox 拦截');
  assert.equal(g[0]!.check({ elements: [{ bbox: [1, 2, 3, Number.NaN] }] }), false, 'bbox 非有限数拦截');
  assert.equal(g[0]!.check({}), false, '缺 elements 键拦截');
  assert.equal(g[0]!.check('[]'), false, '字符串载荷拦截');

  // verdict：verdict ∈ 枚举
  const v = cascadeSemanticValidators(VERDICT_REQ);
  assert.equal(v.length, 1);
  assert.equal(v[0]!.name, 'semantic-verdict');
  assert.equal(v[0]!.check({ verdict: 'confirmed', scale: 'page', explanation: 'x', confidence: 0.9 }), true);
  assert.equal(v[0]!.check({ verdict: 'uncertain' }), true);
  assert.equal(v[0]!.check({ verdict: 'CONFIRMED' }), false, '大小写漂移拦截（枚举严格同 verdict.ts）');
  assert.equal(v[0]!.check({ verdict: 'maybe' }), false, '枚举外值拦截（病灶二）');
  assert.equal(v[0]!.check({ scale: 'page' }), false, '缺 verdict 字段拦截');
  assert.equal(v[0]!.check([{ verdict: 'confirmed' }]), false, '数组载荷拦截');

  // OCR：words 在场（空数组合法 —— 屏上无字是真实结果）
  const o = cascadeSemanticValidators(OCR_REQ);
  assert.equal(o.length, 1);
  assert.equal(o[0]!.name, 'semantic-ocr');
  assert.equal(o[0]!.check({ words: [{ text: '保存', bbox: [1, 2, 3, 4], confidence: 0.9 }] }), true);
  assert.equal(o[0]!.check({ words: [] }), true, '空 words 数组在场即过（合法空结果）');
  assert.equal(o[0]!.check([{ text: '裸数组方言' }]), true, '裸数组方言 = words 本体');
  assert.equal(o[0]!.check({}), false, '缺 words 键拦截（病灶三）');
  assert.equal(o[0]!.check({ words: 'not-array' }), false, 'words 非数组拦截');

  // 泛化请求零语义谓词（ask_screen 等不受影响）
  assert.deepEqual(cascadeSemanticValidators(GENERIC_REQ), [], 'generic ⇒ 无谓词（结构谓词独守）');
});

/** ΝΩ-18 假级联池：双档可控回复（cheapText 可换弹）+ 调用计数 */
function semanticFakePool(cheapTexts: string[]): {
  pool: CascadePoolFace;
  cheapCalls: () => number;
  primaryCalls: () => number;
} {
  let cheap = 0;
  let primary = 0;
  let i = 0;
  const pool: CascadePoolFace = {
    size: 2,
    tierRoster: () => [
      { id: 'main-1', tier: 'primary' as ProviderTier },
      { id: 'cheap-1', tier: 'cheap' as ProviderTier },
    ],
    async chatTier(_req, tier) {
      if (tier === 'cheap') {
        const text = cheapTexts[Math.min(i, cheapTexts.length - 1)] ?? '';
        i++;
        cheap++;
        return { ok: true, text, latencyMs: 5, model: 'm-cheap', providerId: 'cheap-1' };
      }
      primary++;
      // 主力档回好载荷（升级后的正确答案）
      return {
        ok: true,
        text: JSON.stringify({ elements: [{ id: 'p1', label: '主力答案', role: 'button', bbox: [10, 10, 60, 60], confidence: 0.9 }] }),
        latencyMs: 9, model: 'm-main', providerId: 'main-1',
      };
    },
  };
  return { pool, cheapCalls: () => cheap, primaryCalls: () => primary };
}

test('ΝΩ-18③: wireCascadeConsultFace 端到端 —— 语义不过 ⇒ 升级主力；好载荷 ⇒ 便宜直采；generic 不加谓词', async () => {
  resetCascadeTriageFamiliarity();
  try {
    // ΑΩ-R2 同律：首见 prompt ⇒ 新场景 ⇒ danger 0.4 ⇒ 弃权走单例（ priming 调用），
    // 复现 ⇒ danger 0.2 ⇒ 便宜臂点亮 —— 语义谓词在便宜臂采信前执法。
    const mkCascade = (pool: CascadePoolFace): VlmCascade => new VlmCascade(pool, {
      factors: () => ({ risk: 'medium' as const, sceneFamiliar: false, confidence: 0.5 }),
      validators: [{
        name: 'json-structural',
        check: (v: unknown) => v !== null && (Array.isArray(v) || typeof v === 'object'),
      } as CascadeValidator],
    });

    // ① grounding 请求 + 便宜臂空 elements ⇒ 语义谓词拦截 ⇒ 升级主力（主力好载荷承接）
    const bad = semanticFakePool([JSON.stringify({ elements: [] })]);
    wireCascadeConsultFace(mkCascade(bad.pool));
    const { fetchImpl, calls: fetchCalls } = fakeCascadeFetch();
    const client = new GlmClient({ apiKey: 'k', model: 'm', fetchImpl });
    const groundingCall = () => client.chatJson<{ elements?: Array<{ label?: string }> }>({
      images: [], prompt: GROUNDING_REQ.prompt, system: GROUNDING_REQ.system, maxRetries: 0,
    });
    await groundingCall(); // priming：首见弃权走单例
    const r1 = await groundingCall(); // 复现：便宜臂点亮
    assert.equal(r1.ok, true);
    assert.equal(r1.value?.elements?.[0]?.label, '主力答案', '空 elements 被语义谓词拦截 ⇒ 升级主力重做');
    assert.equal(bad.cheapCalls(), 1, '便宜臂拨过一次（真实事件）');
    assert.equal(bad.primaryCalls(), 1, '主力档重做一次');
    assert.equal(fetchCalls(), 1, '承接 ⇒ 单例仅 priming 一拨');

    // ② 好载荷 ⇒ 便宜直采（语义谓词不误伤）
    const good = semanticFakePool([JSON.stringify({
      elements: [{ id: 'x1', label: '设置', role: 'button', bbox: [20, 20, 90, 80], confidence: 0.9 }],
    })]);
    wireCascadeConsultFace(mkCascade(good.pool));
    const r2 = await client.chatJson<{ elements?: Array<{ label?: string }> }>({
      images: [], prompt: GROUNDING_REQ.prompt, system: GROUNDING_REQ.system, maxRetries: 0,
    });
    assert.equal(r2.value?.elements?.[0]?.label, '设置', '好载荷过语义谓词 ⇒ 便宜直采');
    assert.equal(good.primaryCalls(), 0, '主力零调用（省钱事件）');
    assert.equal(fetchCalls(), 1);

    // ③ generic 请求 ⇒ 无语义谓词，结构谓词独守（旧行为：非空对象即过）
    const generic = semanticFakePool(['{"anything":"结构完整即可"}']);
    wireCascadeConsultFace(mkCascade(generic.pool));
    const genericCall = () => client.chatJson<{ anything?: string }>({
      images: [], prompt: GENERIC_REQ.prompt, maxRetries: 0,
    });
    await genericCall(); // priming
    const r3 = await genericCall();
    assert.equal(r3.value?.anything, '结构完整即可', '泛化请求保持纯结构校验（零行为变化）');
    assert.equal(generic.primaryCalls(), 0);
  } finally {
    attachCascadeFace(null);
    resetCascadeTriageFamiliarity();
  }
});

test('ΝΩ-18④: 组合根源级断言 —— configureVlm 的限流注入与桥面语义谓词字面接线', () => {
  const src = readFileSync(new URL('../src/vlm/index.ts', import.meta.url), 'utf8');
  assert.match(src, /attachVlmRateLimiter\(new VlmRateLimiter\(/, 'configureVlm 必须铸 VlmRateLimiter 注入限流闸（vlm.maxPerMinute > 0）');
  assert.match(src, /kernelRegistry\.getOrDefault\('vlm\.maxPerMinute', 0\)/, '限流参数读内核注册表（Ξ-D 同律）');
  assert.match(src, /wireCascadeConsultFace\(cascadeSingleton\)/, 'configureVlm 铸级联后必须经 wireCascadeConsultFace 装配语义谓词桥');
});

test('ΝΩ-18⑤: configureVlm 限流注入行为 —— vlm.maxPerMinute 供参后 chatJson 第二次前置拒绝（全程零网络）', async () => {
  // 环境控制法：摘掉 OPENAI env（openai 无钥 + 远端 baseUrl ⇒ configured:false，
  // 降级臂零 fetch —— 限流行为可离线观测，绝不真实联网）
  const savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  kernelRegistry.register({
    key: 'vlm.maxPerMinute', organ: 'perception',
    defaultValue: 0, min: 0, max: 100_000, note: 'ΝΩ-18 测试注册',
  });
  try {
    kernelRegistry.set('vlm.maxPerMinute', 1);
    configureVlm({ vlmProvider: 'openai' }); // 无钥单例（降级臂）+ 限流闸注入
    const r1 = await getGlmClient().chatJson({ images: [], prompt: 'p', maxRetries: 0 });
    assert.equal(r1.ok, false);
    assert.match(r1.error!, /not configured/, '首次放行（配额 1 已耗）⇒ 降级臂诚实失败（零网络）');
    const r2 = await getGlmClient().chatJson({ images: [], prompt: 'p', maxRetries: 0 });
    assert.equal(r2.ok, false);
    assert.match(r2.error!, /rate limited \(retry after \d+ms\)/, '第二次前置拒绝（vlm.maxPerMinute=1 生效）');
  } finally {
    kernelRegistry.set('vlm.maxPerMinute', 0);
    configureVlm({}); // 摘除限流闸 + 级联/池（幂等）—— 不留模块级状态
    resetGlmClient(); // 单例归零（下次按 env 缺省解析）
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
  }
});

// ─── W3-B②：resetVerifyGateBudget 边界挂点（runPilotLoop 跑环边界） ───

test('W3-B②: 跑环边界作用域清零 —— 本任务键 `pilot:<token>` 从 0 重新计，他任务键与缺省账不动', async () => {
  const png = await makePng(200, 150);
  // 低置信（0.5 < 0.6）单元素 ⇒ 每次主定位触发一次 Zoom 复核（预算 +1）
  const fake = fakeGlmClient({
    groundingValue: () => ({ elements: [{ id: 'x', label: '低置信按钮', role: 'button', bbox: [20, 20, 90, 80], confidence: 0.5 }] }),
    ocrValue: () => ({ words: [{ text: '低置信按钮', confidence: 0.9, bbox: [20, 20, 90, 80] }] }),
  });
  const budgetOf = async (taskId?: string): Promise<number> => {
    const r = await groundElements(png, {
      client: fake.client, verifyClient: fake.client, width: 200, height: 150,
      ...(taskId ? { verifyTaskId: taskId } : {}),
    });
    assert.ok(r.verifyGate, '闸开 ⇒ 复核报告在场');
    return r.verifyGate!.budgetUsed;
  };

  // 已知取舍的行为基线：未过跑环边界 ⇒ 预算跨调用累积（1 → 2）
  resetVerifyGateBudget();
  assert.equal(await budgetOf(), 1, '首次主定位 ⇒ 预算 1');
  assert.equal(await budgetOf(), 2, '同任务二次调用 ⇒ 累积到 2（边界清零前的共享行为）');

  // 跑环边界：runPilotLoop 起点 resetVerifyGateBudget（autonomous_run 与
  // autonomy_resume 共用脊梁 ⇒ 双工具同律）。W8-B2 终态：环内 grounding 走
  // 低置信元素（0.5 < 0.6 ⇒ 每次 perceive 的云脑接地触发一次复核），且 deps
  // 注入 verifyTaskId: `pilot:<token>` ⇒ 环内消费落任务键账本（消费面自缺省
  // 账本迁移的活体证据）；use/reset 同键闭环由下方三联断言钉死。
  const fakeRun = fakeGlmClient({
    groundingValue: () => ({ elements: [{ id: 'x', label: '稳按钮', role: 'button', bbox: [20, 20, 90, 80], confidence: 0.5 }] }),
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
  // W8-B2 终态接线：任务键注入位就位 —— 环内 perceive 的缺省云脑接地面
  //（makeDefaultGroundVlm）自此把复核预算记到 `pilot:<token>` 账本（与
  // runPilotLoop 起点的 resetVerifyGateBudget(`pilot:<token>`) 同键闭环）。
  deps.verifyTaskId = `pilot:${token}`;
  const goalMachine = new GoalStateMachine(spec, nowFn);
  const restore = patchSystem({
    getScreenSize: async () => ({ width: 200, height: 150 }),
    clickMouse: async () => { /* 测试键鼠哑面 */ },
    typeText: async () => { /* 测试键鼠哑面 */ },
    scroll: async () => { /* 测试键鼠哑面 */ },
    pressHotkey: async () => { /* 测试键鼠哑面 */ },
  });
  let report = '';
  // W6R-B2 接线断言素材：作用域账本预铸 —— 本轮 token 键与他任务键各记 1 次
  // 复核（低置信元素 ⇒ 每调用 +1）。跑环边界的清零语义由下方三联断言钉死。
  assert.equal(await budgetOf(`pilot:${token}`), 1, '本轮 token 键预算 1（边界前预铸）');
  assert.equal(await budgetOf('pilot:other'), 1, '他任务键预算 1（边界前预铸）');
  try {
    report = await runPilotLoop({
      toolName: 'autonomous_run', config: makeConfig(), deps, spec, goalMachine, store, token,
    });
  } finally {
    restore();
  }
  assert.equal(typeof report, 'string', '跑环返回锚点字符串（脊梁完整走通）');

  // 边界清零的行为证据（W6R-B2 作用域化 + W8-B2 消费面迁移后的终态钉义）：
  //  · 本轮 token 键：runPilotLoop 起点 resetVerifyGateBudget(`pilot:<token>`)
  //    定点清零（预铸的 1 被抹）⇒ 环内低置信 grounding 的 N 次复核（N ≥ 1）
  //    自 0 重新记到本键 + 本探针 1 ⇒ 读数 ≥ 2 —— 环内消费真落任务键账本；
  //  · 他任务键：本轮边界不触碰 ⇒ 继续累积（1 → 2）—— 并发任务互不侵占；
  //  · 缺省账本：终态语义（W8-B2 消费面迁移后不再走缺省账本）—— 环内零贡献，
  //    读数恰为「预铸 2 + 本探针 1」= 3（迁移前环内 N 次消费会落在此处 ⇒ ≥ 4）。
  const taskProbe = await budgetOf(`pilot:${token}`);
  assert.ok(taskProbe >= 2, `本轮 token 键 ⇒ 边界清零后环内消费重新计入（≥2，实际 ${taskProbe}）`);
  assert.equal(await budgetOf('pilot:other'), 2, '他任务键不被本轮边界清零（隔离不侵占）');
  assert.equal(await budgetOf(), 3, '缺省账本零环内贡献（终态：runtime 消费面已迁移任务键）');
});

// ─── W8-B2：verifyGate 预算消费面终态接线（两真实消费方迁移的闭环断言） ───

test('W8-B2①: runtime 缺省接地键控 —— RuntimeDeps.verifyTaskId ⇒ 复核预算落任务键账本；缺席 ⇒ 缺省账本（零漂移）', async () => {
  const png = await makePng(200, 150);
  const fake = fakeGlmClient({
    groundingValue: () => ({ elements: [{ id: 'x', label: '低置信按钮', role: 'button', bbox: [20, 20, 90, 80], confidence: 0.5 }] }),
    ocrValue: () => ({ words: [{ text: '低置信按钮', confidence: 0.9, bbox: [20, 20, 90, 80] }] }),
  });
  const budgetOf = async (taskId?: string): Promise<number> => {
    const r = await groundElements(png, {
      client: fake.client, verifyClient: fake.client, width: 200, height: 150,
      ...(taskId ? { verifyTaskId: taskId } : {}),
    });
    assert.ok(r.verifyGate, '闸开 ⇒ 复核报告在场');
    return r.verifyGate!.budgetUsed;
  };
  const mkDeps = (verifyTaskId?: string): RuntimeDeps => ({
    capture: async () => png,
    readWords: async () => [],
    dhashOf: async () => null, // 指纹缺席 ⇒ 场景语义缓存跳过（隔离观察面）
    client: fake.client,
    ...(verifyTaskId !== undefined ? { verifyTaskId } : {}),
  });

  // 键控路径：perceive 的缺省云脑接地（makeDefaultGroundVlm）带键 ⇒ 消费落任务键
  resetVerifyGateBudget();
  await createPerceive(mkDeps('pilot:w8b2-rt'))();
  assert.equal(await budgetOf('pilot:w8b2-rt'), 2, '任务键读数 = perceive 消费 1 + 探针 1（use 键 = 注入键）');
  assert.equal(await budgetOf(), 1, '缺省账本零贡献（消费面已迁移 —— 探针自身 1）');

  // 回归锁：不注入 verifyTaskId（历史调用面）⇒ 缺省账本续账，行为逐字节不变
  await createPerceive(mkDeps())();
  assert.equal(await budgetOf(), 3, '无键 perceive ⇒ 缺省账本 +1（① 探针 1 + perceive 1 + 本探针 1 = 3 —— 零漂移）');
});

test('W8-B2②: visionAdapters L3 会话键控 —— sessionId 供给铸 `session:<id>` 与宿主回合边界同键闭环；缺席/故障 ⇒ 缺省账本', async () => {
  const png = await makePng(200, 150);
  const FULL_REGION = { id: 'g0x0', x: 0, y: 0, width: 1, height: 1 };
  const fake = fakeGlmClient({
    groundingValue: () => ({ elements: [{ id: 'x', label: '低置信按钮', role: 'button', bbox: [20, 20, 90, 80], confidence: 0.5 }] }),
    ocrValue: () => ({ words: [{ text: '低置信按钮', confidence: 0.9, bbox: [20, 20, 90, 80] }] }),
  });
  const budgetOf = async (taskId?: string): Promise<number> => {
    const r = await groundElements(png, {
      client: fake.client, verifyClient: fake.client, width: 200, height: 150,
      ...(taskId ? { verifyTaskId: taskId } : {}),
    });
    assert.ok(r.verifyGate, '闸开 ⇒ 复核报告在场');
    return r.verifyGate!.budgetUsed;
  };
  const mkSrc = (sessionId?: () => string | undefined) => createSemanticFromVlm({
    capture: async () => png,
    screenSize: async () => ({ width: 200, height: 150 }),
    client: fake.client,
    ...(sessionId !== undefined ? { sessionId } : {}),
  });

  // ① 供给在场 ⇒ ground 铸 `session:sess-42` 键（use 键与 reset 键同源同形）
  resetVerifyGateBudget();
  await mkSrc(() => 'sess-42').ground(FULL_REGION, '找按钮');
  assert.equal(await budgetOf('session:sess-42'), 2, '会话键读数 = ground 消费 1 + 探针 1（键形 = 宿主 index.ts:508 同律）');
  assert.equal(await budgetOf(), 1, '缺省账本零贡献（L3 消费面已迁移）');

  // ② use/reset 闭环：宿主回合边界 resetVerifyGateBudget(`session:<id>`) 定点清零
  //    ⇒ 下一次 ground 自 1 重新计（同键 use/reset 的一致性证据）
  resetVerifyGateBudget('session:sess-42');
  await mkSrc(() => 'sess-42').ground(FULL_REGION, '找按钮');
  assert.equal(await budgetOf('session:sess-42'), 2, '回合边界清零后 ⇒ ground 重新自 1 计（+ 探针 1）');
  assert.equal(await budgetOf('session:other'), 1, '他会话键不被本边界清零（探针自身 1 —— 隔离不侵占）');

  // ③ 回归锁：供给缺席（历史调用面）⇒ 缺省账本续账，行为逐字节不变
  await mkSrc().ground(FULL_REGION, '找按钮');
  assert.equal(await budgetOf(), 3, '无供给 ground ⇒ 缺省账本 +1（① 探针 1 + ground 1 + 本探针 1 = 3 —— 零漂移）');

  // ④ 防御式：供给抛错 ⇒ 诚实回落缺省账本（供给故障绝不毒化 ground 主管线）
  await mkSrc(() => { throw new Error('session source exploded'); }).ground(FULL_REGION, '找按钮');
  assert.equal(await budgetOf(), 5, '供给故障 ⇒ 键缺席走缺省账本（③ 后 3 + 故障 ground 1 + 本探针 1 = 5）');
});
