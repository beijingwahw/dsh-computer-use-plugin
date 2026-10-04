// test/vlm.integration.test.ts
// 纪元 Ω（集成验证）：云脑皮层接入宿主血脉 —— 全本地，绝不联网。
// 假 client（chatJson/chat 桩）+ 假截屏（sharp 现场生成）+ 假全局 fetch（configureVlm
// 优先级取证）三件套覆盖：
//   Ω-I   configureVlm 配置优先级（config 覆盖 env；缺席字段回退 env；全空走 env 路径）
//   Ω-II  ask_screen 工具（全链 SUCCESS / 未配置诚实降级 / buildAllTools 挂载门）
//   Ω-III semanticConfirm 第三路径（本地双路径皆败 → VLM 兜底命中/不命中/模糊同律）
//   Ω-III 降级律回归（开关关 / 无 Key / fullBuf 缺席 / 云脑失败 ⇒ 一切照旧，零网络）
//   Ω-IV  createSemanticFromVlm（L3 适配器：归一化映射 / 落区过滤 / 就绪门 / 故障上抛）
// 确定性前提（legacy 失败向量）：90×90 图 + 边缘邻域（cx=cy=0.9975, radius=0.003）——
// legacy 路径 Math.round 换算越界（90+1 > 90）⇒ sharp extract 必抛；VLM 路径
// floor/ceil 换算合法（89..90）。服务端 L2 路径经 _setServerOcrFailedAt_forTest
// 预置负缓存 —— 测试环境绝不触发 D-5 微服务启动。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Config } from '../src/config.ts';
import {
  getGlmClient, isGlmConfigured, resetGlmClient,
  GlmClient, vlmMeter,
  type GlmClient as GlmClientLike,
} from '../src/vlm/index.ts';

const { configureVlm } = await import('../src/vlm/index.ts');
const { createAskScreenTool } = await import('../src/tools/askScreen.ts');
const {
  semanticConfirm, setSemanticVlmOptions, _setServerOcrFailedAt_forTest, disposeOcr,
} = await import('../src/textReader.ts');
const { createSemanticFromVlm } = await import('../src/orchestration/visionAdapters.ts');
const { default: sharp } = await import('sharp');

// semanticConfirm 的 legacy 路径会真实装载 tesseract worker（长活连接池 + socket）：
// 不终止则占住事件循环，node --test 永不退出（src/index.ts 卸载序同律）
after(async () => {
  setSemanticVlmOptions(null);
  await disposeOcr();
});

// ─── 假件工坊 ───

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

/** chatJson 假 client（vlmOcr/grounding 消费面）—— 捕获每次请求，返回固定 value */
function fakeChatJsonClient(value: unknown): { client: GlmClientLike; calls: unknown[] } {
  const calls: unknown[] = [];
  const stub = {
    configured: true,
    chatJson: async (req: unknown) => { calls.push(req); return { ok: true, value, raw: '' }; },
  };
  return { client: stub as unknown as GlmClientLike, calls };
}

/** chatJson 恒败假 client —— 云脑故障臂（降级律执法） */
function fakeChatJsonFailing(error: string): { client: GlmClientLike; calls: unknown[] } {
  const calls: unknown[] = [];
  const stub = {
    configured: true,
    chatJson: async (req: unknown) => { calls.push(req); return { ok: false, error, raw: '' }; },
  };
  return { client: stub as unknown as GlmClientLike, calls };
}

/** chat 假 client（ask_screen 消费面）—— 只实现工具实际调用的 chat */
function fakeChatClient(
  respond: () => { ok: boolean; text: string; latencyMs: number; model: string; error?: string },
): { client: GlmClientLike; calls: Array<{ prompt: string; images: number }> } {
  const calls: Array<{ prompt: string; images: number }> = [];
  const stub = {
    configured: true,
    chat: async (req: { prompt?: unknown; images?: unknown }) => {
      calls.push({
        prompt: typeof req.prompt === 'string' ? req.prompt : '',
        images: Array.isArray(req.images) ? req.images.length : -1,
      });
      return respond();
    },
  };
  return { client: stub as unknown as GlmClientLike, calls };
}

/** 假全局 fetch —— 捕获 url/鉴权/模型名（configureVlm 优先级取证），绝不联网 */
interface CapturedHttp { url: string; auth: string; model: string }
function fakeHttpCapture(content = 'pong'): { calls: CapturedHttp[]; fetch: typeof fetch } {
  const calls: CapturedHttp[] = [];
  const fake = (async (url: unknown, init: { headers?: Record<string, string>; body?: string } | undefined) => {
    let model = '';
    try { model = String(JSON.parse(String(init?.body ?? '{}')).model ?? ''); } catch { /* 假 body 防御 */ }
    calls.push({
      url: String(url),
      auth: String(init?.headers?.Authorization ?? ''),
      model,
    });
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { calls, fetch: fake };
}

/** sharp 现场生成纯色测试 PNG（内容不重要 —— 假 client 不看像素，只走真实编码管线） */
async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer();
}

/** 工具执行捷径（ToolDefinition.execute 的 (args, exec) 双参面在测试里只需 args —— exec 传 undefined） */
type ToolLike = { execute: (a: unknown, e: unknown) => Promise<unknown> };
async function runTool(tool: ToolLike, args: unknown): Promise<any> {
  return JSON.parse(String(await tool.execute(args, undefined)));
}

/** semanticConfirm 边缘邻域参数 —— legacy 路径换算必越界（确定性失败向量，见文件头） */
const EDGE = { cx: 0.9975, cy: 0.9975, radius: 0.003 } as const;

// ─── Ω-I configureVlm 配置优先级 ───

test('Ω-I: configureVlm 配置优先级 —— config 覆盖 env，缺席字段回退 env，全空走 env 路径', async () => {
  const saved = snapshotEnv();
  const savedFetch = globalThis.fetch;
  const { calls, fetch } = fakeHttpCapture();
  globalThis.fetch = fetch;
  try {
    clearEnvKeys();

    // a) 三字段齐发：单例以 config 铸造（url/鉴权/模型全取 config 值）
    resetGlmClient();
    configureVlm({ vlmApiKey: 'cfg-key', vlmBaseUrl: 'https://cfg.example/api', vlmModel: 'cfg-model' });
    assert.equal(isGlmConfigured(), true);
    assert.equal((await getGlmClient().chat({ images: [], prompt: 'ping' })).ok, true);
    assert.equal(calls[0].url, 'https://cfg.example/api/chat/completions');
    assert.equal(calls[0].auth, 'Bearer cfg-key');
    assert.equal(calls[0].model, 'cfg-model');

    // b) config key 覆盖 env key；config 缺席的 model 回退 env 值
    process.env.GLM_API_KEY = 'env-key';
    process.env.GLM_VLM_MODEL = 'env-model';
    configureVlm({ vlmApiKey: 'cfg-key-2' });
    await getGlmClient().chat({ images: [], prompt: 'ping' });
    assert.equal(calls[1].auth, 'Bearer cfg-key-2', 'config apiKey 必须覆盖 env');
    assert.equal(calls[1].model, 'env-model', 'config 缺席的 model 应回退 env');

    // c) 全空不动单例：reset 后 configureVlm({}) 零铸造 ⇒ getGlmClient 读 env
    resetGlmClient();
    configureVlm({});
    await getGlmClient().chat({ images: [], prompt: 'ping' });
    assert.equal(calls[2].auth, 'Bearer env-key');
    assert.equal(calls[2].model, 'env-model');

    // c2) baseUrl 同律：config 只发 key，baseUrl 回退 env GLM_BASE_URL
    process.env.GLM_BASE_URL = 'https://env.example/api';
    resetGlmClient();
    configureVlm({ vlmApiKey: 'k' });
    await getGlmClient().chat({ images: [], prompt: 'ping' });
    assert.equal(calls[3].url, 'https://env.example/api/chat/completions');

    // d) 无 env 无 config ⇒ 未配置（零请求 —— degraded 臂不触 fetch）
    clearEnvKeys();
    resetGlmClient();
    configureVlm({ vlmApiKey: '', vlmBaseUrl: '', vlmModel: '' });
    assert.equal(isGlmConfigured(), false);
    assert.equal(calls.length, 4, '未配置臂不得发出任何网络请求');
  } finally {
    globalThis.fetch = savedFetch;
    restoreEnv(saved);
    resetGlmClient();
  }
});

// ─── Δ-6 configureVlm 计量接线：vlmMeter 单例零消费者修正 ───

test('Δ-6: configureVlm 铸造的单例缺省接入 vlmMeter —— 假 fetch 一次调用后 summary().calls ≥ 1', async () => {
  const saved = snapshotEnv();
  const savedFetch = globalThis.fetch;
  const { calls, fetch } = fakeHttpCapture();
  globalThis.fetch = fetch;
  try {
    clearEnvKeys();
    resetGlmClient();
    vlmMeter.reset();

    // a) 三字段法铸造：chat 一次 ⇒ vlmMeter 台账至少一条，kind/model 字段对齐
    configureVlm({ vlmApiKey: 'meter-key', vlmModel: 'meter-model' });
    const r = await getGlmClient().chat({ images: [], prompt: 'ping' });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1, '恰好一次假 fetch');
    const s1 = vlmMeter.summary();
    assert.ok(s1.calls >= 1, `云脑心跳必须落进 vlmMeter 台账（实测 ${s1.calls} 条）`);
    assert.equal(s1.byKind['glm.chat'], s1.calls, 'kind = glm.chat（Ω 纪元 meter kind 保持）');
    assert.ok(vlmMeter.exportJsonl().includes('"model":"meter-model"'), 'GlmMeterRecord 字段与 VlmCallRecord 同名直落');

    // b) 显式平台铸造路同样接线（委托路径 kind = `${platform}.chat`）
    resetGlmClient();
    vlmMeter.reset();
    configureVlm({ vlmProvider: 'openai', vlmApiKey: 'k' });
    await getGlmClient().chat({ images: [], prompt: 'ping' });
    assert.ok(vlmMeter.summary().calls >= 1, '平台铸造路心跳同账本');
    assert.equal(vlmMeter.summary().byKind['openai.chat'], vlmMeter.summary().calls, 'kind 随平台');

    // c) 用户显式 meter 优先：直连构造 GlmClient 给自己的 meter ⇒ 不走缺省接线
    const before = vlmMeter.summary().calls;
    const kinds: string[] = [];
    const direct = new GlmClient({ apiKey: 'k', meter: rec => kinds.push(rec.kind) });
    const dr = await direct.chat({ images: [], prompt: 'ping' });
    assert.equal(dr.ok, true);
    assert.deepEqual(kinds, ['glm.chat'], '显式 meter 如期收到自己的记录');
    assert.equal(vlmMeter.summary().calls, before, '直连构造不挂缺省接线（Δ-6 只在 configureVlm 铸造路径）');
  } finally {
    globalThis.fetch = savedFetch;
    vlmMeter.reset();
    restoreEnv(saved);
    resetGlmClient();
    configureVlm({});
  }
});

// ─── Ω-II ask_screen 工具 ───

test('Ω-II: ask_screen 全链 SUCCESS —— 假截屏 + 假 client；锚点含 answer/latency_ms/model', async () => {
  const saved = snapshotEnv();
  try {
    clearEnvKeys();
    resetGlmClient();
    const png = await makePng(320, 240);

    let captured = 0;
    const vlm = fakeChatClient(() => ({
      ok: true, text: '  当前是登录页，用户名已填，密码框为空。  ', latencyMs: 42, model: 'fake-model',
    }));
    const tool = createAskScreenTool({} as Config, {
      capture: async () => { captured++; return png; },
      client: vlm.client,
    });

    const out = await runTool(tool, { question: '这是什么页面？' });
    assert.equal(out.status, 'SUCCESS');
    assert.equal(out.state_anchor.answer, '当前是登录页，用户名已填，密码框为空。');
    assert.equal(out.state_anchor.latency_ms, 42);
    assert.equal(out.state_anchor.model, 'fake-model');
    assert.equal(captured, 1, '恰好一次干净截屏');
    assert.equal(vlm.calls.length, 1, '恰好一次云脑问答');
    assert.ok(vlm.calls[0].prompt.includes('这是什么页面'), '问题应透传给云脑');
    assert.equal(vlm.calls[0].images, 1, '云脑应收到单张截图');

    // VLM 失败臂：chat ok:false ⇒ toolErr 诚实（绝不伪答）
    const failing = fakeChatClient(() => ({
      ok: false, text: '', latencyMs: 3, model: 'fake-model', error: 'mock glm outage',
    }));
    const bad = createAskScreenTool({} as Config, { capture: async () => png, client: failing.client });
    const badOut = await runTool(bad, { question: '屏幕上有什么？' });
    assert.equal(badOut.status, 'FAILED');
    assert.match(badOut.state_anchor.error, /mock glm outage/);

    // 空问题臂：结构化拒绝
    const emptyOut = await runTool(tool, { question: '   ' });
    assert.equal(emptyOut.status, 'FAILED');
  } finally {
    restoreEnv(saved);
    resetGlmClient();
  }
});

test('Ω-II: ask_screen 未配置降级 —— 无 Key 零截屏零网络诚实 toolErr；挂载门随 vlmApiKey/isGlmConfigured', async () => {
  const saved = snapshotEnv();
  try {
    clearEnvKeys();
    resetGlmClient();

    // 未配置臂：deps.client 缺席 + 云脑未配置 ⇒ 截屏供给一次也不被调用
    let captured = 0;
    const tool = createAskScreenTool({} as Config, {
      capture: async () => { captured++; return await makePng(40, 30); },
    });
    const out = await runTool(tool, { question: 'anything' });
    assert.equal(out.status, 'FAILED');
    assert.match(out.state_anchor.error, /not configured/i);
    assert.equal(captured, 0, '未配置臂不得截屏');

    // 挂载门（源级断言，epochR 先例 —— 桶文件在 Node strip 模式有 takeScreenshot
    // 的 UIElement 值导入历史地雷，宿主 bundler 正常；此处验证注册条件的立法文本）：
    // buildAllTools 必须以 config.vlmApiKey || isGlmConfigured() 守卫 createAskScreenTool
    const toolsSrc = readFileSync(new URL('../src/tools/index.ts', import.meta.url), 'utf8');
    assert.match(
      toolsSrc,
      /if\s*\(config\.vlmApiKey\s*\|\|\s*isGlmConfigured\(\)\)\s*\{\s*[^}]*createAskScreenTool/s,
      'ask_screen 必须条件挂载（vlmApiKey 非空或云脑已配置）',
    );

    // 挂载门两臂的行为语义（与 tools/index.ts 同一条件式）：
    // 无 config key 且无 env ⇒ 不挂载语义成立（isGlmConfigured 为假）
    assert.equal(isGlmConfigured(), false);
    // env GLM_API_KEY（无 config key）⇒ 挂载语义成立（env 路径同权）
    process.env.GLM_API_KEY = 'env-key';
    assert.equal(isGlmConfigured(), true);
    // config key 铸造单例 ⇒ 挂载语义成立
    clearEnvKeys();
    resetGlmClient();
    configureVlm({ vlmApiKey: 'k' });
    assert.equal(isGlmConfigured(), true);
  } finally {
    restoreEnv(saved);
    resetGlmClient();
  }
});

// ─── ΝΩ-31：ask_screen unchanged 门控（缓存帧复用）───

test('ΝΩ-31: ask_screen unchanged 门 —— 复用闸命中 ⇒ 零新截屏复用缓存帧；未命中 ⇒ 全新截屏', async () => {
  const saved = snapshotEnv();
  try {
    clearEnvKeys();
    resetGlmClient();
    const png = await makePng(320, 240);
    const vlm = fakeChatClient(() => ({
      ok: true, text: '缓存的登录页仍在。', latencyMs: 21, model: 'fake-model',
    }));

    // 复用臂：闸说 unchanged ⇒ 截屏供给一次也不被调用，缓存帧直供云脑
    let captured = 0;
    let gateCalls = 0;
    const reuseTool = createAskScreenTool({} as Config, {
      capture: async () => { captured++; return png; },
      reuseGate: async () => {
        gateCalls++;
        return { unchanged: true, buffer: png, sourceId: 42 };
      },
      client: vlm.client,
    });
    for (let i = 0; i < 2; i++) {
      const out = await runTool(reuseTool, { question: '现在是什么页面？' });
      assert.equal(out.status, 'SUCCESS');
      assert.equal(out.state_anchor.answer, '缓存的登录页仍在。');
      assert.match(out.state_anchor.frame_source, /reused cached screenshot #42/, '锚点如实申报缓存帧来源');
    }
    assert.equal(gateCalls, 2, '每次调用都先问复用闸');
    assert.equal(captured, 0, 'unchanged ⇒ 零新截屏（复用计数钉死）');
    assert.equal(vlm.calls.length, 2, '问答照常两回合');
    assert.equal(vlm.calls.every(c => c.images === 1), true, '云脑每回合收到单张截图');

    // 未命中臂：闸说 changed ⇒ 走全新截屏
    let fresh = 0;
    const freshTool = createAskScreenTool({} as Config, {
      capture: async () => { fresh++; return png; },
      reuseGate: async () => ({ unchanged: false }),
      client: vlm.client,
    });
    const out2 = await runTool(freshTool, { question: '页面变了吗？' });
    assert.equal(out2.status, 'SUCCESS');
    assert.equal(fresh, 1, 'changed ⇒ 全新截屏一次');
    assert.equal(out2.state_anchor.frame_source, 'fresh capture');

    // 闸抛错臂：门控故障 ⇒ 诚实退回全新截屏（绝不以缓存冒充新鲜）
    let rescued = 0;
    const failGateTool = createAskScreenTool({} as Config, {
      capture: async () => { rescued++; return png; },
      reuseGate: async () => { throw new Error('gate probe down'); },
      client: vlm.client,
    });
    const out3 = await runTool(failGateTool, { question: '还在吗？' });
    assert.equal(out3.status, 'SUCCESS');
    assert.equal(rescued, 1, '闸故障 ⇒ 全新截屏兜底');
  } finally {
    restoreEnv(saved);
    resetGlmClient();
  }
});

// ─── Ω-III semanticConfirm 第三路径 ───

test('Ω-III: semanticConfirm VLM 兜底 —— 本地双路径皆败后命中/模糊同律/不命中三臂', async () => {
  const saved = snapshotEnv();
  try {
    clearEnvKeys();
    resetGlmClient();
    // 服务端 L2 负缓存预置：readScreenTextServer 即返 null（绝不触发 D-5 微服务）
    _setServerOcrFailedAt_forTest(Date.now());
    // 90×90 图 + 边缘邻域：legacy 路径 sharp extract 必抛（换算越界）⇒ 双路径皆败
    const png = await makePng(90, 90);

    const vlm = fakeChatJsonClient({
      words: [{ text: 'Welcome  Back', confidence: 0.93, bbox: [1, 1, 40, 18] }],
    });
    setSemanticVlmOptions({ assistOcr: true, client: vlm.client });

    // 命中臂：大小写/空白不敏感（与本地路径同律）
    const hit = await semanticConfirm(png, EDGE.cx, EDGE.cy, EDGE.radius, 'welcome BACK');
    assert.ok(hit, '双路径皆败 + 兜底开启 + 假 client ⇒ 第三路径应激活');
    assert.equal(hit.confirmed, true);
    assert.ok(hit.snippet.includes('Welcome'), `snippet 应含云脑读文（实际: ${hit.snippet}）`);

    // 模糊命中臂：l→1 替换 —— fuzzyIncludes 同律（编辑距离容错）
    const fuzzy = await semanticConfirm(png, EDGE.cx, EDGE.cy, EDGE.radius, 'We1come Back');
    assert.ok(fuzzy, '模糊臂也应返回 SemanticConfirm');
    assert.equal(fuzzy.confirmed, true);

    // 不命中臂：确认语义为假，但仍是有效应答（不是 null）
    const miss = await semanticConfirm(png, EDGE.cx, EDGE.cy, EDGE.radius, 'Goodbye Nowhere');
    assert.ok(miss, '不命中 ≠ 不可用');
    assert.equal(miss.confirmed, false);

    assert.equal(vlm.calls.length, 3, '三臂各恰好一次云脑读屏（无重试风暴）');
  } finally {
    setSemanticVlmOptions(null);
    _setServerOcrFailedAt_forTest(0);
    restoreEnv(saved);
    resetGlmClient();
  }
});

test('Ω-III: semanticConfirm 降级律 —— 开关关/无 Key/fullBuf 缺席/云脑失败 ⇒ 一切照旧（null，零网络）', async () => {
  const saved = snapshotEnv();
  try {
    clearEnvKeys();
    resetGlmClient();
    _setServerOcrFailedAt_forTest(Date.now());
    const png = await makePng(90, 90);
    const spy = fakeChatJsonClient({ words: [] });

    // a) vlmAssistOcr=false：假 client 在场也不启用 —— 旧行为 null，零调用
    setSemanticVlmOptions({ assistOcr: false, client: spy.client });
    assert.equal(await semanticConfirm(png, EDGE.cx, EDGE.cy, EDGE.radius, 'welcome'), null);
    assert.equal(spy.calls.length, 0);

    // b) 开启但无注入 client 且无 Key：零网络降级（不建 client、不编码、不请求）
    setSemanticVlmOptions({ assistOcr: true });
    assert.equal(await semanticConfirm(png, EDGE.cx, EDGE.cy, EDGE.radius, 'welcome'), null);

    // c) fullBuf=null（D-5 路径常态）：归一化→像素无从换算 ⇒ null（即便云脑可用）
    setSemanticVlmOptions({ assistOcr: true, client: spy.client });
    assert.equal(await semanticConfirm(null, EDGE.cx, EDGE.cy, EDGE.radius, 'welcome'), null);
    assert.equal(spy.calls.length, 0);

    // d) 云脑读屏失败（chatJson ok:false）⇒ null（绝不抛）
    const failing = fakeChatJsonFailing('mock vlm outage');
    setSemanticVlmOptions({ assistOcr: true, client: failing.client });
    assert.equal(await semanticConfirm(png, EDGE.cx, EDGE.cy, EDGE.radius, 'welcome'), null);
    assert.equal(failing.calls.length, 1);

    // e) 未注入任何配置（宿主未接线）⇒ 与本纪元之前逐字节一致
    setSemanticVlmOptions(null);
    assert.equal(await semanticConfirm(png, EDGE.cx, EDGE.cy, EDGE.radius, 'welcome'), null);
  } finally {
    setSemanticVlmOptions(null);
    _setServerOcrFailedAt_forTest(0);
    restoreEnv(saved);
    resetGlmClient();
  }
});

// ─── Ω-IV L3 语义源适配器 ───

test('Ω-IV: createSemanticFromVlm —— 归一化映射 / 落区过滤 / 就绪门 / 故障上抛（J 纪元契约）', async () => {
  const saved = snapshotEnv();
  try {
    clearEnvKeys();
    resetGlmClient();
    const png = await makePng(200, 150);
    const FULL_REGION = { id: 'g0x0', x: 0, y: 0, width: 1, height: 1 };

    const vlm = fakeChatJsonClient({ elements: [
      { label: '设置', role: 'button', bbox: [100, 50, 300, 150], confidence: 0.9 },
      { label: '帮助中心', role: 'link', bbox: [700, 500, 780, 560], confidence: 0.8 },
    ] });
    const src = createSemanticFromVlm({
      capture: async () => png,
      screenSize: async () => ({ width: 800, height: 600 }),
      client: vlm.client,
    });

    // 就绪门：无 Key（未配置）⇒ false；configureVlm 铸造后 ⇒ true
    assert.equal(src.isReady(), false);
    configureVlm({ vlmApiKey: 'test-key' });
    assert.equal(src.isReady(), true);

    // 全区接地：像素 bbox ÷ 屏幕尺寸 → 归一化 rect；name ≤20 字符
    const full = await src.ground(FULL_REGION, '找到设置入口');
    assert.equal(full.length, 2);
    assert.equal(full[0].role, 'button');
    assert.equal(full[0].name, '设置');
    assert.ok(Math.abs(full[0].rect.x - 100 / 800) < 1e-9);
    assert.ok(Math.abs(full[0].rect.y - 50 / 600) < 1e-9);
    assert.ok(Math.abs(full[0].rect.width - 200 / 800) < 1e-9);
    assert.ok(Math.abs(full[0].rect.height - 100 / 600) < 1e-9);

    // 落区过滤（中心落区即入区）：左上 1/4 区只留「设置」
    const quarter = await src.ground({ id: 'g0x0', x: 0, y: 0, width: 0.5, height: 0.5 }, '找到设置入口');
    assert.equal(quarter.length, 1);
    assert.equal(quarter[0].name, '设置');

    // 故障上抛：云脑失败 ⇒ throw（工位 safeGround 记 fault —— 失败空 ≠ 真空）
    const dead = createSemanticFromVlm({
      capture: async () => png,
      screenSize: async () => ({ width: 800, height: 600 }),
      client: fakeChatJsonFailing('mock glm outage').client,
    });
    await assert.rejects(() => dead.ground(FULL_REGION, 'q'), /mock glm outage/);

    // 屏幕尺寸非法 ⇒ 上抛（诚实归因，不吞错）
    const badSize = createSemanticFromVlm({
      capture: async () => png,
      screenSize: async () => ({ width: 0, height: 0 }),
      client: vlm.client,
    });
    await assert.rejects(() => badSize.ground(FULL_REGION, 'q'), /invalid screen size/);
  } finally {
    restoreEnv(saved);
    resetGlmClient();
  }
});
