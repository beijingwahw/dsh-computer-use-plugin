// test/vlm.universal.test.ts
// 纪元 Ψ（万脑归一）：glmClient 兼容壳 + 多协议统一层集成验证 —— 全离线，绝不联网。
// 开头 scrub 全部 13 平台的环境变量（保存/恢复法）后控制注入；覆盖：
//   Ψ-U1 显式 platform 委托的请求形状（OpenAI URL/Bearer/缺省模型/meter kind）
//   Ψ-U2 baseUrl 识别自动换脑 + 未识别 URL 保持 glm 路径（缺省兼容）
//   Ψ-U3 仅 OPENAI_API_KEY env ⇒ isGlmConfigured true（不铸造）+ getGlmClient 缺省解析 openai
//   Ψ-U4 仅 ANTHROPIC_API_KEY env ⇒ anthropic 路径（x-api-key 头）；gemini 同理（x-goog-api-key）
//   Ψ-U5 vlmProvider config 显式覆盖 env + Ω 纪元 schema 缺省值在非 glm 平台下视为缺席
//   Ψ-U6 fallback 链 —— ProviderPool 直测（glm 主力 500 ⇒ anthropic 备脑补位）+ configureVlm 铸池
//   Ψ-U7 vlm_platforms 工具锚点（清单/active/池健康/probe 并行体检/挂载谓词源级取证）
//   Ψ-U8 缺省回归 —— 全清 env ⇒ glm 降级臂与 Ω 纪元逐字节一致（错误前缀/meter kind/无 providerId）
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Config } from '../src/config.ts';

const {
  GlmClient, getGlmClient, isGlmConfigured, resetGlmClient, peekGlmPlatform,
} = await import('../src/vlm/glmClient.ts');
const { configureVlm, getProviderPool } = await import('../src/vlm/index.ts');
const { PLATFORM_PRESETS } = await import('../src/vlm/providers/registry.ts');
const { createProviderPool } = await import('../src/vlm/providers/failover.ts');
const { createVlmPlatformsTool } = await import('../src/tools/vlmPlatforms.ts');

// ─── 环境隔离：全部 13 平台 env + GLM/anthropic 特有覆盖变量，保存/恢复法 ───

const SCRUB_ENV = [...new Set([
  ...PLATFORM_PRESETS.flatMap(p => [...p.envKeys]),
  'GLM_BASE_URL', 'GLM_VLM_MODEL', // GLM 专属（基址/模型）—— 语义保持 glm 独占
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', // anthropic 工厂 env 回退链
])];
const savedEnv = SCRUB_ENV.map(k => [k, process.env[k]] as const);
function scrubEnv(): void {
  for (const k of SCRUB_ENV) delete process.env[k];
}
scrubEnv();
after(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetGlmClient();
  configureVlm({});
});

/** 域内 env 控制：注入 overrides 运行 fn，finally 恢复为全 scrub 态并重置单例 */
async function withEnv<T>(
  overrides: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  scrubEnv();
  resetGlmClient();
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  try {
    return await fn();
  } finally {
    scrubEnv();
    resetGlmClient();
  }
}

// ─── 假 fetch 工具：记录调用 + 可控 Response 回放（沿 vlm.glmClient.test.ts 先例） ───

interface FetchCall { url: string; init: RequestInit | undefined }

function recorder(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** openai 方言成功 chat 响应（choices[0].message.content） */
const chatOk = (content: string): Response =>
  jsonResponse(200, { choices: [{ message: { role: 'assistant', content } }] });

/** anthropic 方言成功响应（content 数组 text 块拼接） */
const anthOk = (text: string): Response =>
  jsonResponse(200, { content: [{ type: 'text', text }] });

/** gemini 方言成功响应（candidates[0].content.parts） */
const gemOk = (text: string): Response =>
  jsonResponse(200, { candidates: [{ content: { parts: [{ text }] } }] });

function headersOf(call: FetchCall): Record<string, string> {
  return (call.init?.headers ?? {}) as Record<string, string>;
}

function bodyOf(call: FetchCall): any {
  return JSON.parse(String(call.init?.body));
}

/** 单张图最小请求（maxRetries 0 —— 池/失败臂无重试等待） */
const req = (o: { prompt?: string; images?: Array<{ base64: string; mime?: string }> } = {}) => ({
  images: [{ base64: 'QUJD', mime: 'image/png' }],
  prompt: '看图说话',
  maxRetries: 0,
  timeoutMs: 500,
  ...o,
});

// ─── Ψ-U1 显式 platform 委托：请求形状走 OpenAI ───

test('Ψ-U1: platform=openai 显式委托 —— URL/Bearer/缺省模型/meter kind 全走 OpenAI 方言', async () => {
  await withEnv({}, async () => {
    const { fetchImpl, calls } = recorder(() => chatOk('openai 回复'));
    const client = new GlmClient({ platform: 'openai', apiKey: 'sk-oai', fetchImpl });
    assert.equal(client.platform, 'openai');
    assert.equal(client.configured, true);
    const r = await client.chat(req());
    assert.equal(r.ok, true);
    assert.equal(r.text, 'openai 回复');
    assert.equal(r.providerId, 'openai', '委托路径附 providerId 归因');
    assert.equal(r.model, 'gpt-4o-mini', '模型缺省取 openai 预设');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(headersOf(calls[0]!).Authorization, 'Bearer sk-oai');
    const body = bodyOf(calls[0]!);
    assert.equal(body.model, 'gpt-4o-mini');
    assert.equal(body.messages[0].content[1].image_url.url, 'data:image/png;base64,QUJD');

    // meter kind：他平台 `${platform}.chat`（glm 路径保持 'glm.chat' 见 Ψ-U8）
    const kinds: string[] = [];
    const m = new GlmClient({
      platform: 'openai', apiKey: 'k',
      fetchImpl: recorder(() => chatOk('x')).fetchImpl,
      meter: rec => kinds.push(rec.kind),
    });
    await m.chat(req());
    assert.deepEqual(kinds, ['openai.chat']);

    // 委托 chatJson：适配器串 error + jsonMode 提取
    const j = await client.chatJson<{ v: number }>(req());
    assert.equal(j.ok, false, 'chatOk 回复无 JSON ⇒ 提取失败');
    assert.match(j.error!, /openai json extraction failed/);
  });
});

// ─── Ψ-U2 baseUrl 识别自动换脑 + 未识别保持 glm ───

test('Ψ-U2: baseUrl 识别命中非 glm 预设 ⇒ 自动换脑；未识别 URL ⇒ glm 路径逐字节保持', async () => {
  await withEnv({}, async () => {
    const { fetchImpl, calls } = recorder(() => anthOk('baseUrl 识别的 claude'));
    const client = new GlmClient({ baseUrl: 'https://api.anthropic.com', apiKey: 'ak', fetchImpl });
    assert.equal(client.platform, 'anthropic', 'baseUrl 命中 anthropic 预设 ⇒ 自动委托');
    const r = await client.chat(req());
    assert.equal(r.ok, true);
    assert.equal(calls[0]!.url, 'https://api.anthropic.com/v1/messages');

    // 未识别的自定义 URL（vlm.integration Ω-I 同款）⇒ glm 路径（缺省兼容）
    const { fetchImpl: g, calls: gc } = recorder(() => chatOk('glm 照旧'));
    const glmClient = new GlmClient({ baseUrl: 'https://cfg.example/api', apiKey: 'k', fetchImpl: g });
    assert.equal(glmClient.platform, 'glm');
    const r2 = await glmClient.chat(req());
    assert.equal(r2.ok, true);
    assert.equal(gc[0]!.url, 'https://cfg.example/api/chat/completions');
    assert.equal(r2.providerId, undefined, 'glm 路径不附 providerId（Ω 纪元形状不动）');
  });
});

// ─── Ψ-U3 仅 OPENAI_API_KEY env ⇒ 缺省解析 openai ───

test('Ψ-U3: 仅 OPENAI_API_KEY env ⇒ isGlmConfigured true（不铸造单例）+ getGlmClient 缺省解析 openai', async () => {
  await withEnv({ OPENAI_API_KEY: 'sk-env-oai' }, async () => {
    // 探测只读律：isGlmConfigured true 但绝不落地单例
    assert.equal(isGlmConfigured(), true);
    const peek = peekGlmPlatform();
    assert.equal(peek.platform, 'openai');
    assert.equal(peek.minted, false, '探测不铸造单例');
    // 占位反证：探测后带显式 options 取用，options 仍生效（未被空单例占位）
    const { fetchImpl, calls } = recorder(() => chatOk('x'));
    const explicit = getGlmClient({ apiKey: 'explicit-key', baseUrl: 'https://cfg.example/api', fetchImpl });
    await explicit.chat(req());
    assert.equal(headersOf(calls[0]!).Authorization, 'Bearer explicit-key');
    resetGlmClient();

    // 缺省解析：getGlmClient() 无 options ⇒ 以 openai 平台铸造（走全局 fetch）
    const client = getGlmClient();
    assert.equal(client.platform, 'openai');
    assert.equal(client.configured, true);
    const savedFetch = globalThis.fetch;
    const rec = recorder(() => chatOk('env-openai-ok'));
    globalThis.fetch = rec.fetchImpl;
    try {
      const r = await client.chat(req());
      assert.equal(r.ok, true);
      assert.equal(rec.calls[0]!.url, 'https://api.openai.com/v1/chat/completions');
      assert.equal(headersOf(rec.calls[0]!).Authorization, 'Bearer sk-env-oai', 'apiKey 经平台 envKeys 解析');
    } finally {
      globalThis.fetch = savedFetch;
    }

    // GLM envs 优先律：GLM 与 OPENAI 双设 ⇒ 缺省解析回 glm（Ω 纪元宿主兼容）
    process.env.GLM_API_KEY = 'glm-k';
    resetGlmClient();
    try {
      assert.equal(peekGlmPlatform().platform, 'glm');
      assert.equal(getGlmClient().platform, 'glm');
    } finally {
      delete process.env.GLM_API_KEY;
      resetGlmClient();
    }
  });
});

// ─── Ψ-U4 anthropic / gemini 的 env 自动识别 ───

test('Ψ-U4: 仅 ANTHROPIC_API_KEY ⇒ anthropic 路径（x-api-key 头）；仅 GEMINI_API_KEY ⇒ gemini 路径', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-env' }, async () => {
    assert.equal(isGlmConfigured(), true);
    const client = getGlmClient();
    assert.equal(client.platform, 'anthropic');
    const savedFetch = globalThis.fetch;
    const rec = recorder(() => anthOk('claude 看图回复'));
    globalThis.fetch = rec.fetchImpl;
    try {
      const r = await client.chat(req());
      assert.equal(r.ok, true);
      assert.equal(r.text, 'claude 看图回复');
      assert.equal(r.providerId, 'anthropic');
      assert.equal(rec.calls[0]!.url, 'https://api.anthropic.com/v1/messages');
      const h = headersOf(rec.calls[0]!);
      assert.equal(h['x-api-key'], 'sk-ant-env');
      assert.equal(h['anthropic-version'], '2023-06-01');
      assert.equal('Authorization' in h, false, 'anthropic 方言不走 Bearer');
      const body = bodyOf(rec.calls[0]!);
      assert.equal(body.model, 'claude-sonnet-4');
      assert.equal(body.messages[0].content[0].type, 'image', '图像 content 块在前');
      assert.equal(body.messages[0].content[1].type, 'text');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  await withEnv({ GEMINI_API_KEY: 'gk-env' }, async () => {
    assert.equal(isGlmConfigured(), true);
    const client = getGlmClient();
    assert.equal(client.platform, 'gemini');
    const savedFetch = globalThis.fetch;
    const rec = recorder(() => gemOk('gemini 看图回复'));
    globalThis.fetch = rec.fetchImpl;
    try {
      const r = await client.chat(req());
      assert.equal(r.ok, true);
      assert.equal(r.text, 'gemini 看图回复');
      assert.equal(r.providerId, 'gemini');
      assert.equal(
        rec.calls[0]!.url,
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      );
      assert.equal(headersOf(rec.calls[0]!)['x-goog-api-key'], 'gk-env');
      assert.equal('Authorization' in headersOf(rec.calls[0]!), false, 'gemini 方言不走 Bearer');
      const body = bodyOf(rec.calls[0]!);
      assert.equal(body.contents[0].parts[0].inline_data.mime_type, 'image/png');
      assert.equal(body.contents[0].parts[1].text, '看图说话');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  // 委托降级臂：platform 显式但无钥 ⇒ 适配器 degraded 语义（零网络）
  await withEnv({}, async () => {
    const bare = new GlmClient({ platform: 'anthropic' });
    assert.equal(bare.configured, false);
    const r = await bare.chat(req());
    assert.equal(r.ok, false);
    assert.equal(r.degraded, true);
    assert.match(r.error!, /anthropic api key not configured/);
  });
});

// ─── Ψ-U5 vlmProvider config 显式覆盖 env ───

test('Ψ-U5: vlmProvider config 显式覆盖 env；Ω 纪元 schema 缺省值在非 glm 平台下视为缺席', async () => {
  await withEnv({ OPENAI_API_KEY: 'sk-env-oai' }, async () => {
    // config 说 anthropic —— 压过 env 的 openai
    configureVlm({ vlmProvider: 'anthropic', vlmApiKey: 'cfg-ant' });
    const client = getGlmClient();
    assert.equal(client.platform, 'anthropic');
    assert.equal(client.configured, true);
    const savedFetch = globalThis.fetch;
    const rec = recorder(() => anthOk('config 指定的 claude'));
    globalThis.fetch = rec.fetchImpl;
    try {
      const r = await client.chat(req());
      assert.equal(r.ok, true);
      assert.equal(headersOf(rec.calls[0]!)['x-api-key'], 'cfg-ant', 'config apiKey 压过 env 解析');
    } finally {
      globalThis.fetch = savedFetch;
    }

    // 宿主把 Ω 纪元 schema 缺省（GLM 基址/模型名）填进 config —— 非 glm 平台下
    // 必须视为缺席（否则 vlmProvider='openai' 拿 GLM 基址指错脑）
    resetGlmClient();
    configureVlm({
      vlmProvider: 'openai',
      vlmApiKey: 'k',
      vlmBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      vlmModel: 'glm-5.3-flash',
    });
    const oai = getGlmClient();
    assert.equal(oai.platform, 'openai');
    const rec2 = recorder(() => chatOk('x'));
    globalThis.fetch = rec2.fetchImpl;
    try {
      await oai.chat(req());
      assert.equal(rec2.calls[0]!.url, 'https://api.openai.com/v1/chat/completions', '平台预设基址胜出');
      assert.equal(bodyOf(rec2.calls[0]!).model, 'gpt-4o-mini', '平台预设模型胜出');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

// ─── Ψ-U6 fallback 链：ProviderPool 直测 + configureVlm 铸池 ───

test('Ψ-U6: fallback 链 —— glm 主力假 fetch 500 ⇒ anthropic 备脑经池补位；configureVlm 铸池双轨', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-fb' }, async () => {
    // a) ProviderPool 直测：URL 分派假 fetch —— GLM 云恒 500，anthropic 云回成功形状
    const dispatch = (async (url: unknown) => {
      if (String(url).includes('open.bigmodel.cn')) {
        return jsonResponse(500, '{"error":{"message":"glm down"}}');
      }
      if (String(url).includes('api.anthropic.com')) {
        return anthOk('anthropic 备脑回复');
      }
      return jsonResponse(500, 'unreachable');
    }) as typeof fetch;
    const meterRecs: Array<{ providerId: string }> = [];
    const pool = createProviderPool({
      provider: 'glm', apiKey: 'glm-k',
      fallbacks: ['anthropic'],
      fetchImpl: dispatch,
      meter: rec => meterRecs.push(rec),
    });
    assert.deepEqual(pool.ids, ['glm', 'anthropic']);
    const r = await pool.chat(req());
    assert.equal(r.ok, true, `备脑应补位（detail: ${pool.notes.join(' | ')}）`);
    assert.equal(r.providerId, 'anthropic');
    assert.equal(r.text, 'anthropic 备脑回复');
    assert.ok(pool.notes.some(n => n.includes('切换')), 'note 记了切换决策');
    assert.deepEqual(meterRecs.map(m => m.providerId), ['glm', 'anthropic'], '两脑各一条遥测');

    // b) configureVlm 铸池（双轨）：vlmFallbackProviders CSV ⇒ 模块级 ProviderPool
    configureVlm({ vlmApiKey: 'glm-k', vlmFallbackProviders: 'anthropic' });
    const minted = getProviderPool();
    assert.ok(minted !== null, 'configureVlm 应铸出模块级池');
    assert.deepEqual(minted!.ids, ['glm', 'anthropic']);
    assert.ok(minted!.health().every(h => h.configured));
    // 池补位实战（经全局假 fetch；单例 glm 不受池影响 —— 双轨互不感知）
    assert.equal(getGlmClient().platform, 'glm', '单例仍按 Ω 纪元 glm 铸造');
    const savedFetch = globalThis.fetch;
    globalThis.fetch = dispatch;
    try {
      const r2 = await minted!.chat(req());
      assert.equal(r2.ok, true);
      assert.equal(r2.providerId, 'anthropic', 'glm 500 ⇒ 池序补位');
    } finally {
      globalThis.fetch = savedFetch;
    }
    // 清场：全空 configureVlm ⇒ 池置 null（幂等；缺省回归不残留池）
    configureVlm({});
    assert.equal(getProviderPool(), null);
  });
});

// ─── Ψ-U7 vlm_platforms 工具锚点 ───

test('Ψ-U7: vlm_platforms —— 清单/active/池健康/probe 并行体检；挂载谓词源级取证', async () => {
  await withEnv({}, async () => {
    type ToolLike = { execute: (a: unknown, e: unknown) => Promise<unknown> };
    const run = async (tool: ToolLike, args: unknown): Promise<any> =>
      JSON.parse(String(await tool.execute(args, undefined)));

    // 无参清单：13 平台、configured 仅本地三家（env 全清）、active=glm 未配置未铸造、无池
    const tool = createVlmPlatformsTool({} as Config);
    const out = await run(tool, {});
    assert.equal(out.status, 'SUCCESS');
    assert.equal(out.state_anchor.platform_count, 13);
    assert.deepEqual(
      out.state_anchor.platforms.map((p: any) => p.id),
      PLATFORM_PRESETS.map(p => p.id),
      '清单与 registry 花名册同序同员',
    );
    assert.equal(out.state_anchor.platforms.filter((p: any) => p.configured).length, 3, '本地三家免钥恒 configured');
    assert.deepEqual(
      out.state_anchor.active_platform,
      { platform: 'glm', configured: false, minted: false },
      '全清 env ⇒ active 推演 glm 未配置（绝不铸造单例）',
    );
    assert.equal('fallback_pool' in out.state_anchor, false, '未铸池 ⇒ 无 fallback_pool 字段');
    assert.ok(typeof out.action === 'string' && out.action.length > 0);
    assert.ok(typeof out.next_step === 'string' && out.next_step.length > 0, '锚点四件套齐全');

    // probe=true：注入假 fetch ⇒ 本地三家并行探测全通（sharp 现场铸 1x1 白图，离线）。
    // Δ-2 后 LM Studio/vLLM 缺省模型为空 ⇒ 探测前先 GET /models 发现模型：
    // GET = 模型列表方言，POST = chat 探测（写实本地服务器形状）
    const rec = recorder(call =>
      String(call.init?.method ?? 'GET').toUpperCase() === 'GET'
        ? jsonResponse(200, { data: [{ id: 'local-discovered-vision' }] })
        : chatOk('ok'));
    const tool2 = createVlmPlatformsTool({} as Config, { fetchImpl: rec.fetchImpl });
    const out2 = await run(tool2, { probe: true });
    assert.equal(out2.status, 'SUCCESS');
    assert.equal(out2.state_anchor.probe.length, 3, '云端无 key 全跳 ⇒ 只探本地三家');
    assert.ok(out2.state_anchor.probe.every((p: any) => p.ok === true));
    // ollama 直探 1 + lmstudio/vllm 各自「发现 1 + 探测 1」
    assert.equal(rec.calls.length, 5);
    for (const p of out2.state_anchor.probe as any[]) {
      assert.ok(p.detail.includes('通'), `${p.id}：${p.detail}`);
    }

    // 铸池后的报告面：fallback_pool 附 ids 与 health
    try {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-fb';
      configureVlm({ vlmApiKey: 'k', vlmFallbackProviders: 'anthropic' });
      const out3 = await run(tool, {});
      assert.equal(out3.status, 'SUCCESS');
      assert.deepEqual(out3.state_anchor.fallback_pool.ids, ['glm', 'anthropic']);
      assert.equal(out3.state_anchor.fallback_pool.health.length, 2);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      configureVlm({});
    }

    // 挂载谓词源级取证（与 vlm.integration 的 ask_screen 门同法）：
    // vlm_platforms 必须与 ask_screen 同谓词挂载；ask_screen 的 Ω 纪元原行保持原样
    const toolsSrc = readFileSync(new URL('../src/tools/index.ts', import.meta.url), 'utf8');
    assert.match(
      toolsSrc,
      /if\s*\(config\.vlmApiKey\s*\|\|\s*isGlmConfigured\(\)\)\s*\{\s*[^}]*createVlmPlatformsTool/s,
      'vlm_platforms 必须以 vlmApiKey || isGlmConfigured() 谓词挂载',
    );
    assert.match(
      toolsSrc,
      /if\s*\(config\.vlmApiKey\s*\|\|\s*isGlmConfigured\(\)\)\s*\{\s*[^}]*createAskScreenTool/s,
      'ask_screen 挂载门原行必须原样保留（源级断言不破）',
    );
  });
});

// ─── Ψ-U8 缺省回归：全清 env ⇒ 与 Ω 纪元逐字节一致 ───

test('Ψ-U8: 缺省回归 —— 全清 env ⇒ glm 降级臂/错误前缀/meter kind 与 Ω 纪元一致', async () => {
  await withEnv({}, async () => {
    assert.equal(isGlmConfigured(), false);
    assert.equal(peekGlmPlatform().platform, 'glm');
    const client = getGlmClient();
    assert.equal(client.platform, 'glm');
    assert.equal(client.configured, false);
    const r = await client.chat(req());
    assert.equal(r.ok, false);
    assert.equal(r.degraded, true);
    assert.equal(r.text, '');
    assert.equal(r.model, 'glm-5.3-flash');
    assert.match(r.error!, /^glm api key not configured/, '错误前缀 glm 保持（命门 3）');
    assert.equal(r.providerId, undefined, 'glm 路径不附 providerId');

    // meter kind 'glm.chat' 保持；GLM env 三别名回退链照旧
    const kinds: string[] = [];
    const m = new GlmClient({ meter: rec => kinds.push(rec.kind) });
    await m.chat(req());
    assert.deepEqual(kinds, ['glm.chat']);

    process.env.ZHIPUAI_API_KEY = 'alias-zhipu';
    resetGlmClient();
    try {
      const alias = new GlmClient();
      assert.equal(alias.configured, true, 'ZHIPUAI_API_KEY 别名回退照旧');
      assert.equal(getGlmClient().platform, 'glm');
    } finally {
      delete process.env.ZHIPUAI_API_KEY;
      resetGlmClient();
    }

    // configureVlm 三字段法（Ω 纪元）原样：全空不动单例
    const before = getGlmClient({ apiKey: 'kept' });
    configureVlm({ vlmApiKey: '', vlmBaseUrl: '', vlmModel: '', vlmProvider: '', vlmFallbackProviders: '' });
    assert.equal(getGlmClient(), before, '全空 ⇒ 单例不动');
  });
});
