// test/vlm.providers.probe.test.ts
// 纪元 Ψ（Ψ-7 万脑归一）：探针与模型发现契约测试。
// 铁律：绝不真实联网 —— probeProvider 用假 provider 桩/真工厂+假 fetch；
// discoverModels / probeAllPlatforms 全部注入 fetchImpl（可控 Response）。
// 覆盖：未配置零网络、成功路径请求形状（1x1 JPEG/「回复 ok」/maxTokens 8）、
// visionGuessed 判定（含不支持文案负例）、超时/HTTP 失败 detail 不泄 key（密钥卫生）、
// chat 抛异常收敛、discoverModels 三协议各自形状与解析、未知协议先试 openai 再回退、
// 失败空列表、本地免 Bearer、probeAllPlatforms 的 env 控制法 + includeLocal 分支 +
// 并行计数（peak 并发）；纪元 Δ-2 空缺省模型平台（LM Studio/vLLM）先发现再探
// （发现成功用首模型/发现失败与空表如实报「无可用模型」且零 chat 假探测）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { VisionChatRequest, VisionChatResult, VisionProvider } from '../src/vlm/providers/types.ts';

const { probeProvider, discoverModels, probeAllPlatforms, PLATFORM_PRESETS } = await import('../src/vlm/providers/probe.ts');
const { createOpenAiProvider } = await import('../src/vlm/providers/openai.ts');

// ─── 假 fetch 工具：记录调用 + 按序/按次回放可控 Response（沿 openai.test.ts 先例） ───

interface FetchCall { url: string; init: RequestInit | undefined }

function recorder(handler: (call: FetchCall, n: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call, calls.length);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** 按序回放：队列耗尽后重复最后一个（断言回退尝试次数用 calls.length） */
function queue(...resps: Array<() => Response>): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  return recorder((_call, n) => resps[Math.min(n - 1, resps.length - 1)]!());
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** openai 方言的成功 chat 响应（choices[0].message.content） */
function chatOk(content: string): Response {
  return jsonResponse(200, { choices: [{ message: { role: 'assistant', content } }] });
}

function headersOf(call: FetchCall): Record<string, string> {
  return (call.init?.headers ?? {}) as Record<string, string>;
}

function bodyOf(call: FetchCall): any {
  return JSON.parse(String(call.init?.body));
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// ─── 假 provider 桩（probeProvider 的最小 VisionProvider） ───

function fakeProvider(overrides: {
  id?: string;
  configured?: boolean;
  chat?: (req: VisionChatRequest) => Promise<VisionChatResult>;
} = {}): { provider: VisionProvider; requests: VisionChatRequest[] } {
  const requests: VisionChatRequest[] = [];
  const chat = overrides.chat ?? (async (req: VisionChatRequest) => {
    requests.push(req);
    return { ok: true, text: 'ok', latencyMs: 1, model: 'fake-model', providerId: 'fake' };
  });
  const provider: VisionProvider = {
    id: overrides.id ?? 'fake',
    protocol: 'openai',
    model: 'fake-model',
    configured: overrides.configured ?? true,
    chat: async (req: VisionChatRequest) => chat(req),
    chatJson: async () => ({ ok: true, raw: 'ok' }),
  };
  return { provider, requests };
}

// ─── env 控制法：清空（并随后恢复）所有平台预设触及的环境变量 ───

function allPresetEnvNames(): string[] {
  const names = new Set<string>();
  for (const p of PLATFORM_PRESETS) {
    for (const n of p.envKeys ?? []) names.add(n);
    if (p.envBase) names.add(p.envBase);
    if (p.envModel) names.add(p.envModel);
  }
  return [...names];
}

async function withClearedEnv<T>(fn: () => Promise<T>): Promise<T> {
  const names = allPresetEnvNames();
  const saved = names.map(n => [n, process.env[n]] as const);
  for (const n of names) delete process.env[n];
  try {
    return await fn();
  } finally {
    for (const [n, v] of saved) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  }
}

// ─── Ψ-7a 预设桩契约 ───

test('Ψ-7: PLATFORM_PRESETS 桩 —— 本地三平台 localAuthOptional，云端各有 env 键', () => {
  const localIds = PLATFORM_PRESETS.filter(p => p.localAuthOptional).map(p => p.id).sort();
  assert.deepEqual(localIds, ['lmstudio', 'ollama', 'vllm']);
  for (const p of PLATFORM_PRESETS) {
    assert.ok(p.label !== '' && p.id !== '' && p.baseUrl !== '', `${p.id} 标签/基址齐全`);
    assert.ok(['openai', 'anthropic', 'gemini'].includes(p.protocol));
    if (!p.localAuthOptional) {
      assert.ok((p.envKeys ?? []).length > 0, `云端平台 ${p.id} 必须声明 envKeys`);
    }
  }
});

// ─── Ψ-7b probeProvider ───

test('Ψ-7: probeProvider 未配置 ⇒ 零网络零延迟，报告「未配置密钥」', async () => {
  const { provider } = fakeProvider({
    configured: false,
    chat: async () => { throw new Error('未配置也触网 —— 契约违约'); },
  });
  const r = await probeProvider(provider);
  assert.deepEqual(r, { id: 'fake', ok: false, latencyMs: 0, detail: '未配置密钥', visionGuessed: false });
});

test('Ψ-7: probeProvider 成功 —— 1x1 白图 JPEG +「回复 ok」+ maxTokens 8，visionGuessed 判视觉', async () => {
  const { fetchImpl, calls } = recorder(() => chatOk('ok'));
  const p = createOpenAiProvider({ apiKey: 'sk-probe-ok', fetchImpl });
  assert.equal(p.configured, true);
  const r = await probeProvider(p, { timeoutMs: 800 });
  assert.equal(r.ok, true);
  assert.equal(r.visionGuessed, true);
  assert.ok(r.detail.includes('通'), `detail 应含「通」：${r.detail}`);
  assert.ok(r.latencyMs >= 0);

  assert.equal(calls.length, 1);
  const body = bodyOf(calls[0]!);
  assert.equal(body.max_tokens, 8);
  const content = body.messages[0].content;
  assert.equal(content[0].type, 'text');
  assert.equal(content[0].text, '回复 ok');
  assert.equal(content[1].type, 'image_url');
  const url: string = content[1].image_url.url;
  assert.ok(url.startsWith('data:image/jpeg;base64,'), '探针发的是 JPEG data URL');
  assert.ok(url.length > 'data:image/jpeg;base64,'.length + 50, '图非空（真 1x1 白图）');
});

test('Ψ-7: probeProvider visionGuessed 负例 —— 回复含不支持文案 / 含 image 字样', async () => {
  for (const text of [
    'This model does not support image input',
    '抱歉，我无法处理 image。',
    '当前模型 unsupported for vision requests',
  ]) {
    const { provider } = fakeProvider({
      chat: async () => ({ ok: true, text, latencyMs: 1, model: 'm', providerId: 'fake' }),
    });
    const r = await probeProvider(provider);
    assert.equal(r.ok, true, text);
    assert.equal(r.visionGuessed, false, `应判非视觉：${text}`);
  }
});

test('Ψ-7: probeProvider 通了但回复为空白 ⇒ ok:false 且 detail 标注为空', async () => {
  const { provider } = fakeProvider({
    chat: async () => ({ ok: true, text: '   ', latencyMs: 1, model: 'm', providerId: 'fake' }),
  });
  const r = await probeProvider(provider);
  assert.equal(r.ok, false);
  assert.equal(r.visionGuessed, false);
  assert.ok(r.detail.includes('空'), `detail 应标注空回复：${r.detail}`);
});

test('Ψ-7: probeProvider 超时 —— detail 标注超时（含超时毫秒）且绝不泄 key', async () => {
  const p = createOpenAiProvider({
    apiKey: 'sk-timeout-secret',
    fetchImpl: (async () => {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError'; // fetchWithRetry 的超时止损形态
      throw e;
    }) as typeof fetch,
  });
  const r = await probeProvider(p, { timeoutMs: 700 });
  assert.equal(r.ok, false);
  assert.equal(r.visionGuessed, false);
  assert.ok(r.detail.includes('超时'), `detail 应标注超时：${r.detail}`);
  assert.ok(r.detail.includes('700ms'), `超时毫秒应透传：${r.detail}`);
  assert.ok(!r.detail.includes('sk-timeout-secret'), '绝不泄 key');
});

test('Ψ-7: probeProvider HTTP 失败 —— detail 含 HTTP 状态且绝不泄 key（密钥卫生）', async () => {
  const key = 'sk-leakme-123456';
  const { fetchImpl, calls } = queue(() => jsonResponse(401, { error: { message: `invalid key ${key}` } }));
  const p = createOpenAiProvider({ apiKey: key, fetchImpl });
  const r = await probeProvider(p, { timeoutMs: 600 });
  assert.equal(r.ok, false);
  assert.equal(r.visionGuessed, false);
  assert.ok(r.detail.includes('HTTP 401'), `detail 应含 HTTP 状态：${r.detail}`);
  assert.ok(!r.detail.includes(key), '绝不泄 key');
  assert.ok(!r.detail.includes('leakme'), 'key 片段也不许漏');
  assert.equal(calls.length, 1, '探针不重试（maxRetries 0）');
});

test('Ψ-7: probeProvider provider.chat 抛异常 ⇒ 收敛为 ok:false 绝不上抛', async () => {
  const { provider } = fakeProvider({
    chat: async () => { throw new Error('boom sk-crash-99999999'); },
  });
  const r = await probeProvider(provider);
  assert.equal(r.ok, false);
  assert.equal(r.visionGuessed, false);
  assert.ok(r.detail.length > 0);
  assert.ok(!r.detail.includes('sk-crash-99999999'), '异常面同样密钥卫生');
});

// ─── Ψ-7c discoverModels ───

test('Ψ-7: discoverModels openai —— GET {base}/models + Bearer + data[].id/owned_by', async () => {
  const { fetchImpl, calls } = recorder(() => jsonResponse(200, {
    data: [
      { id: 'gpt-4o', owned_by: 'openai' },
      { id: 'gpt-4o-mini', owned_by: 'openai' },
      { id: '', owned_by: 'junk' }, // 无 id 的脏条目静默跳过
    ],
  }));
  const r = await discoverModels({ baseUrl: 'https://api.openai.com/v1/', apiKey: 'sk-disc', protocol: 'openai', fetchImpl });
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, [
    { id: 'gpt-4o', ownedBy: 'openai' },
    { id: 'gpt-4o-mini', ownedBy: 'openai' },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://api.openai.com/v1/models');
  assert.equal(calls[0]!.init!.method, 'GET');
  assert.equal(headersOf(calls[0]!)['Authorization'], 'Bearer sk-disc');
});

test('Ψ-7: discoverModels anthropic —— {base}/v1/models + x-api-key + anthropic-version；/v1 结尾不重复追加', async () => {
  const a = recorder(() => jsonResponse(200, { data: [{ id: 'claude-sonnet-4' }, { id: 'claude-opus-4' }] }));
  const r1 = await discoverModels({ baseUrl: 'https://api.anthropic.com', apiKey: 'ak-ant', protocol: 'anthropic', fetchImpl: a.fetchImpl });
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.models, [{ id: 'claude-sonnet-4' }, { id: 'claude-opus-4' }]);
  assert.equal(a.calls[0]!.url, 'https://api.anthropic.com/v1/models');
  const h1 = headersOf(a.calls[0]!);
  assert.equal(h1['x-api-key'], 'ak-ant');
  assert.equal(h1['anthropic-version'], '2023-06-01');
  assert.equal('Authorization' in h1, false, 'anthropic 方言不走 Bearer');

  // 基址已含 /v1（代理形态）⇒ 不拼出 /v1/v1/models
  const b = recorder(() => jsonResponse(200, { data: [{ id: 'claude-sonnet-4' }] }));
  const r2 = await discoverModels({ baseUrl: 'https://my-proxy.example/v1', apiKey: 'ak', protocol: 'anthropic', fetchImpl: b.fetchImpl });
  assert.equal(r2.ok, true);
  assert.equal(b.calls[0]!.url, 'https://my-proxy.example/v1/models');
});

test('Ψ-7: discoverModels gemini —— models[].name 去 models/ 前缀 + x-goog-api-key', async () => {
  const { fetchImpl, calls } = recorder(() => jsonResponse(200, {
    models: [{ name: 'models/gemini-2.0-flash' }, { name: 'models/gemini-1.5-pro' }, { name: '' }],
  }));
  const r = await discoverModels({
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'gk-google',
    protocol: 'gemini',
    fetchImpl,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, [{ id: 'gemini-2.0-flash' }, { id: 'gemini-1.5-pro' }]);
  assert.equal(calls[0]!.url, 'https://generativelanguage.googleapis.com/v1beta/models');
  assert.equal(headersOf(calls[0]!)['x-goog-api-key'], 'gk-google');

  // 裸主机（无 /v1beta）⇒ 补 /v1beta/models
  const b = recorder(() => jsonResponse(200, { models: [{ name: 'models/gemini-2.0-flash' }] }));
  const r2 = await discoverModels({ baseUrl: 'https://gemini-proxy.example', protocol: 'gemini', fetchImpl: b.fetchImpl, apiKey: 'gk' });
  assert.equal(r2.ok, true);
  assert.equal(b.calls[0]!.url, 'https://gemini-proxy.example/v1beta/models');
});

test('Ψ-7: discoverModels 协议未指明 —— 先试 openai 形态，失败尽力回退 anthropic 形态', async () => {
  const seq = queue(
    () => jsonResponse(404, { error: 'no openai-shaped /models here' }),
    () => jsonResponse(200, { data: [{ id: 'claude-sonnet-4' }] }),
  );
  const r = await discoverModels({ baseUrl: 'https://api.anthropic.com', fetchImpl: seq.fetchImpl });
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, [{ id: 'claude-sonnet-4' }]);
  assert.equal(seq.calls.length, 2, '两次尝试：openai 形态失败后回退');
  assert.equal(seq.calls[0]!.url, 'https://api.anthropic.com/models', '第一次必是 openai 形态');
  assert.equal(seq.calls[1]!.url, 'https://api.anthropic.com/v1/models');
});

test('Ψ-7: discoverModels 失败 ⇒ 空列表 + 中文 error 摘要且不泄 key', async () => {
  const key = 'sk-badbadbad-9999';
  const { fetchImpl } = queue(() => jsonResponse(401, { error: { message: `bad key ${key}` } }));
  const r = await discoverModels({ baseUrl: 'https://api.openai.com/v1', apiKey: key, protocol: 'openai', fetchImpl });
  assert.equal(r.ok, false);
  assert.deepEqual(r.models, []);
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
  assert.ok(!r.error!.includes(key), 'error 摘要绝不泄 key');
  assert.ok(r.error!.includes('401'), `error 应含状态：${r.error}`);
});

test('Ψ-7: discoverModels 2xx 但非 JSON / 缺容器字段 ⇒ 解析失败归 ok:false 空列表', async () => {
  const a = queue(() => new Response('<html>not json</html>', { status: 200 }));
  const r1 = await discoverModels({ baseUrl: 'http://127.0.0.1:9999/v1', protocol: 'openai', fetchImpl: a.fetchImpl });
  assert.equal(r1.ok, false);
  assert.deepEqual(r1.models, []);

  const b = queue(() => jsonResponse(200, { object: 'list', nothing: true }));
  const r2 = await discoverModels({ baseUrl: 'http://127.0.0.1:9999/v1', protocol: 'openai', fetchImpl: b.fetchImpl });
  assert.equal(r2.ok, false);
  assert.deepEqual(r2.models, []);
  assert.ok(r2.error!.includes('data'));
});

test('Ψ-7: discoverModels 本地无 key ⇒ 免 Bearer/鉴权头，直连即中', async () => {
  const { fetchImpl, calls } = recorder(() => jsonResponse(200, { data: [{ id: 'llava' }, { id: 'qwen2.5vl:7b' }] }));
  const r = await discoverModels({ baseUrl: 'http://127.0.0.1:11434/v1', fetchImpl }); // 协议未指明：openai 形态首中
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, [{ id: 'llava' }, { id: 'qwen2.5vl:7b' }]);
  assert.equal(calls.length, 1);
  const h = headersOf(calls[0]!);
  assert.equal('Authorization' in h, false, '本地免 Bearer');
  assert.equal('x-api-key' in h, false);
  assert.equal('x-goog-api-key' in h, false);
});

// ─── Ψ-7d probeAllPlatforms ───

/** 本地服务器方言假 fetch（Δ-2 后的写实模型）：GET = 模型列表发现，
 *  POST = chat 探测 —— LM Studio/vLLM 的缺省模型为空，探测前必先发现。 */
function localServerFetch(handler?: (call: FetchCall) => Response | Promise<Response>) {
  return recorder(call => {
    if (String(call.init?.method ?? 'GET').toUpperCase() === 'GET') {
      return jsonResponse(200, { data: [{ id: 'local-discovered-vision' }] });
    }
    return handler ? handler(call) : chatOk('ok');
  });
}

test('Ψ-7: probeAllPlatforms —— env 无 key + includeLocal 缺省 ⇒ 仅本地三平台被探', async () => {
  await withClearedEnv(async () => {
    const { fetchImpl, calls } = localServerFetch();
    const rs = await probeAllPlatforms({ fetchImpl });
    assert.equal(rs.length, 3, '只探本地三平台（云端无 key 全跳过）');
    assert.deepEqual(rs.map(r => r.id).sort(), ['lmstudio', 'ollama', 'vllm']);
    for (const r of rs) {
      assert.equal(r.ok, true, `${r.id}：${r.detail}`);
      assert.equal(r.visionGuessed, true);
      assert.ok(r.label !== '');
      assert.ok(r.baseUrl.startsWith('http://127.0.0.1:'), `${r.id} 基址应为本机：${r.baseUrl}`);
    }
    // Δ-2 后的调用数：ollama 直探 1 + lmstudio/vllm 各自「发现 1 + 探测 1」
    assert.equal(calls.length, 5);
    // 本地平台无 key ⇒ 不下发 Authorization（openai 工厂本地豁免；发现请求同样免鉴权头）
    for (const c of calls) {
      assert.equal('Authorization' in headersOf(c), false);
    }
  });
});

test('Ψ-7: probeAllPlatforms —— includeLocal:false 跳过本地；env 有 key 的云端平台入选', async () => {
  await withClearedEnv(async () => {
    const a = recorder(() => chatOk('ok'));
    const rs0 = await probeAllPlatforms({ fetchImpl: a.fetchImpl, includeLocal: false });
    assert.deepEqual(rs0, [], '无任何云端 key ⇒ 空报告');
    assert.equal(a.calls.length, 0, '零网络');

    process.env.OPENAI_API_KEY = 'sk-env-probe';
    try {
      const b = recorder(() => chatOk('ok'));
      const rs1 = await probeAllPlatforms({ fetchImpl: b.fetchImpl, includeLocal: false });
      assert.equal(rs1.length, 1);
      assert.equal(rs1[0]!.id, 'openai');
      assert.equal(rs1[0]!.label, 'OpenAI 官方云');
      assert.equal(rs1[0]!.baseUrl, 'https://api.openai.com/v1');
      assert.equal(rs1[0]!.ok, true);
      // key 确实从 env 流进铸造的 provider（否则 configured:false 零网络）
      assert.equal(b.calls.length, 1);
      assert.equal(headersOf(b.calls[0]!)['Authorization'], 'Bearer sk-env-probe');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});

test('Ψ-7: probeAllPlatforms 并行 —— 三本地探针同时在飞（peak 并发 = 3）', async () => {
  await withClearedEnv(async () => {
    let active = 0;
    let peak = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    // Δ-2 后发现请求（GET）与探测请求（POST）都经同一 fetch —— 全部过闸计数
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      active++;
      peak = Math.max(peak, active);
      if (active >= 3) release(); // 三平台首个请求（含发现）全部在飞才放行
      await Promise.race([gate, sleep(1000)]); // 串行劣化时 1s 兜底放行（随后断言失败）
      active--;
      if (String(init?.method ?? 'GET').toUpperCase() === 'GET') {
        return jsonResponse(200, { data: [{ id: 'local-discovered-vision' }] });
      }
      return chatOk('ok');
    }) as typeof fetch;
    const rs = await probeAllPlatforms({ fetchImpl });
    assert.equal(rs.length, 3);
    assert.equal(peak, 3, `Promise.all 并行铁证：peak 应为 3，实际 ${peak}`);
    for (const r of rs) assert.equal(r.ok, true, `${r.id}：${r.detail}`);
  });
});

// ─── Δ-2 空缺省模型平台：先发现模型再探（绝不借 FALLBACK_MODEL 硬探） ───

test('Δ-2: 空缺省模型平台（LM Studio/vLLM）⇒ 先 discoverModels 取首模型再探；chat 用发现的模型', async () => {
  await withClearedEnv(async () => {
    const { fetchImpl, calls } = localServerFetch();
    const rs = await probeAllPlatforms({ fetchImpl });
    const lm = rs.find(r => r.id === 'lmstudio')!;
    assert.equal(lm.ok, true, lm.detail);
    assert.ok(lm.detail.includes('通'), `detail 应含「通」：${lm.detail}`);
    // 发现请求形状：GET {base}/models（openai 方言、无鉴权头 —— 本地免 key）
    const discCall = calls.find(c => String(c.url) === 'http://127.0.0.1:1234/v1/models')!;
    assert.ok(discCall !== undefined, 'LM Studio 必先发现模型');
    assert.equal(discCall.init!.method, 'GET');
    assert.equal('Authorization' in headersOf(discCall), false);
    // 探测请求形状：chat 的 model 必须是服务端发现的模型，而非 'gpt-4o-mini' 回退
    const chatCall = calls.find(c => String(c.url) === 'http://127.0.0.1:1234/v1/chat/completions')!;
    assert.ok(chatCall !== undefined);
    assert.equal(bodyOf(chatCall).model, 'local-discovered-vision', 'chat 必须用发现的模型（Δ-2 命门）');
  });
});

test('Δ-2: 模型发现失败 ⇒ 如实报「无可用模型」，绝不发假模型探测（零 chat 请求）', async () => {
  await withClearedEnv(async () => {
    const { fetchImpl, calls } = queue(() => jsonResponse(404, { error: 'no models endpoint' }));
    const rs = await probeAllPlatforms({ fetchImpl });
    assert.equal(rs.length, 3);
    for (const id of ['lmstudio', 'vllm']) {
      const r = rs.find(x => x.id === id)!;
      assert.equal(r.ok, false);
      assert.equal(r.visionGuessed, false);
      assert.ok(r.detail.includes('无可用模型'), `${id} 应如实报无可用模型：${r.detail}`);
      assert.ok(r.detail.includes('404') || r.detail.includes('失败'), `失败摘要可归因：${r.detail}`);
    }
    // 发现失败的平台绝不发出 chat 探测请求（避免拿 'gpt-4o-mini' 撞出假 404）
    assert.equal(
      calls.filter(c => String(c.url).endsWith('/chat/completions') &&
        (String(c.url).includes(':1234') || String(c.url).includes(':8000'))).length,
      0,
      'lmstudio/vllm 发现失败 ⇒ 零 chat 调用',
    );
  });
});

test('Δ-2: 模型发现成功但空表 ⇒ 同律如实报「无可用模型」（服务端合法空列表）', async () => {
  await withClearedEnv(async () => {
    const { fetchImpl, calls } = recorder(() => jsonResponse(200, { data: [] }));
    const rs = await probeAllPlatforms({ fetchImpl });
    const lm = rs.find(r => r.id === 'lmstudio')!;
    assert.equal(lm.ok, false);
    assert.ok(lm.detail.includes('无可用模型'), lm.detail);
    assert.ok(lm.detail.includes('空'), `空表归因：${lm.detail}`);
    assert.equal(
      calls.filter(c => String(c.url).includes(':1234') && String(c.url).endsWith('/chat/completions')).length,
      0,
    );
  });
});
