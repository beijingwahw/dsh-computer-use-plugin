// test/vlm.providers.openai.test.ts
// 纪元 Ψ（Ψ-2 万脑归一）：OpenAI 兼容协议适配器契约测试。
// 铁律：绝不真实联网 —— 一切 fetch 经 fetchImpl 注入假实现（可控 Response）。
// 覆盖：请求形状（URL 拼接/Bearer/body 的 messages 结构与 image_url data URL/
// response_format 有无）、本地 baseUrl 免 key、分段数组 content、usage 映射、
// json 自动提取、重试矩阵（429 重试、400 不重试、超时不重试）、密钥卫生、
// meter 恰一条、degraded 零 fetch、extraHeaders 合并、baseUrl 尾斜杠归一、
// 换脑预设（idPreset/defaultBaseUrl/defaultModel）与 chatJson。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { OpenAiProviderConfig } from '../src/vlm/providers/openai.ts';
import type { ProviderMeterRecord, VisionChatRequest } from '../src/vlm/providers/types.ts';

const { createOpenAiProvider } = await import('../src/vlm/providers/openai.ts');

// ─── 假 fetch 工具：记录调用 + 按序/按次回放可控 Response（沿 glmClient.test.ts 先例） ───

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

/** 按序回放：队列耗尽后重复最后一个（断言重试次数用 calls.length） */
function queue(...resps: Array<() => Response>): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  return recorder((_call, n) => resps[Math.min(n - 1, resps.length - 1)]!());
}

function chatOk(content: unknown, usage?: Record<string, number>): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content } }],
      ...(usage ? { usage } : {}),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function httpStatus(status: number, body = '{"error":{"message":"boom"}}'): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

const REQ_TIMEOUT = 500; // 测试统一短超时（假 fetch 立即返回，仅为不挂长定时器）

/** 最小合法请求体 */
function req(overrides: Partial<VisionChatRequest> = {}): VisionChatRequest {
  return {
    images: [{ base64: 'QUJD', mime: 'image/png' }],
    prompt: '描述这张截图',
    timeoutMs: REQ_TIMEOUT,
    ...overrides,
  };
}

function bodyOf(call: FetchCall): any {
  return JSON.parse(String(call.init?.body));
}

function make(cfg: OpenAiProviderConfig): ReturnType<typeof createOpenAiProvider> {
  return createOpenAiProvider(cfg);
}

// ─── Ψ-2a 成功路径 + 请求形状 ───

test('Ψ-2: 成功路径请求形状 —— URL 拼接/Bearer/messages 结构/image_url data URL/无 response_format', async () => {
  const { fetchImpl, calls } = recorder(() => chatOk('屏幕上有一个登录按钮', { prompt_tokens: 11, completion_tokens: 7 }));
  const p = make({ apiKey: 'sk-test', fetchImpl });
  assert.equal(p.configured, true);
  const r = await p.chat(req({
    system: '你是桌面自动化助手',
    maxTokens: 128,
    temperature: 0.2,
  }));
  assert.equal(r.ok, true);
  assert.equal(r.text, '屏幕上有一个登录按钮');
  assert.deepEqual(r.usage, { promptTokens: 11, completionTokens: 7 });
  assert.equal(r.providerId, 'openai');
  assert.equal(r.model, 'gpt-4o-mini');
  assert.equal(r.degraded, undefined);
  assert.ok(r.latencyMs >= 0);
  assert.equal(calls.length, 1);

  const call = calls[0]!;
  assert.equal(call.init?.method, 'POST');
  assert.equal(call.url, 'https://api.openai.com/v1/chat/completions', '缺省 baseUrl + /chat/completions');
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer sk-test');
  assert.equal(headers['Content-Type'], 'application/json');

  const body = bodyOf(call);
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.max_tokens, 128);
  assert.equal(body.temperature, 0.2);
  assert.equal('response_format' in body, false, '非 jsonMode ⇒ response_format 键压根不出现');
  assert.equal(body.messages.length, 2, 'system + user');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, '你是桌面自动化助手');
  const user = body.messages[1];
  assert.equal(user.role, 'user');
  assert.equal(user.content[0].type, 'text');
  assert.equal(user.content[0].text, '描述这张截图');
  assert.equal(user.content[1].type, 'image_url');
  assert.equal(user.content[1].image_url.url, 'data:image/png;base64,QUJD', 'mime 透传 buildDataUrl');
});

test('Ψ-2: 缺省参数与消息缺省 —— max_tokens/temperature 缺省、无 system 仅 user、空图片仅 text', async () => {
  const { fetchImpl, calls } = recorder(() => chatOk('ok'));
  const p = make({ apiKey: 'k', fetchImpl });
  await p.chat({ images: [{ base64: 'AAAA' }], prompt: '纯文本', timeoutMs: REQ_TIMEOUT });
  let body = bodyOf(calls[0]!);
  assert.equal(body.max_tokens, 2048, 'max_tokens 缺省 2048（types.ts 契约 —— 纪元 Δ-1 与 anthropic/gemini/glmClient 同调）');
  assert.equal(body.temperature, 0.1, 'temperature 缺省 0.1');
  assert.equal(body.messages.length, 1, '无 system ⇒ 仅 user');
  assert.match(body.messages[0].content[1].image_url.url, /^data:image\/[a-z+.-]+;base64,AAAA$/, 'mime 缺省走 buildDataUrl');

  await p.chat({ images: [], prompt: '无图', system: '', timeoutMs: REQ_TIMEOUT });
  body = bodyOf(calls[1]!);
  assert.equal(body.messages.length, 1, '空 system ⇒ 不发 system 消息');
  assert.equal(body.messages[0].content.length, 1, '空图片 ⇒ 仅 text part');
});

// ─── Ψ-2b 本地免 key（Ollama/vLLM/LM Studio 家族） ───

test('Ψ-2: 本地 baseUrl 无 key 也 configured —— 不下发 Authorization 头', async () => {
  const { fetchImpl, calls } = recorder(() => chatOk('本地脑'));
  const p = make({ baseUrl: 'http://localhost:11434/v1', fetchImpl });
  assert.equal(p.configured, true, 'isLocalBaseUrl 豁免 apiKey 要求');
  const r = await p.chat(req());
  assert.equal(r.ok, true);
  assert.equal(r.text, '本地脑');
  assert.equal(calls[0]!.url, 'http://localhost:11434/v1/chat/completions');
  const headers = calls[0]!.init?.headers as Record<string, string>;
  assert.equal('Authorization' in headers, false, '无 key ⇒ 无 Authorization 头');
  assert.equal(headers['Content-Type'], 'application/json');
});

// ─── Ψ-2c 响应解析矩阵 ───

test('Ψ-2: 分段数组 content —— 拼接 text 项；无 usage ⇒ 字段缺省', async () => {
  const { fetchImpl } = recorder(() => chatOk([
    { type: 'text', text: '分片-' },
    { type: 'text', text: '1' },
  ]));
  const p = make({ apiKey: 'k', fetchImpl });
  const r = await p.chat(req());
  assert.equal(r.ok, true);
  assert.equal(r.text, '分片-1');
  assert.equal(r.usage, undefined, '服务端未上报 usage ⇒ 不下发空壳');
});

test('Ψ-2: json 自动提取 —— 非 jsonMode 也提；jsonMode ⇒ response_format=json_object', async () => {
  const { fetchImpl, calls } = recorder(() => chatOk('结论：```json\n{"verdict": "click", "x": 0.5}\n``` 以上'));
  const p = make({ apiKey: 'k', fetchImpl });
  const r = await p.chat(req());
  assert.equal(r.ok, true);
  assert.deepEqual(r.json, { verdict: 'click', x: 0.5 }, 'json 字段恒做健壮提取');
  assert.equal('response_format' in bodyOf(calls[0]!), false);

  const { fetchImpl: f2, calls: c2 } = recorder(() => chatOk('{"only": true}'));
  const p2 = make({ apiKey: 'k', fetchImpl: f2 });
  const r2 = await p2.chat(req({ jsonMode: true }));
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.json, { only: true });
  assert.equal(bodyOf(c2[0]!).response_format.type, 'json_object');
});

test('Ψ-2: 2xx 但 body 非 JSON / 缺 choices ⇒ 诚实失败不抛', async () => {
  const { fetchImpl } = recorder(() => new Response('<html>网关抽风</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
  const p = make({ apiKey: 'k', fetchImpl });
  const r = await p.chat(req());
  assert.equal(r.ok, false);
  assert.equal(r.text, '');
  assert.ok(r.error!.length > 0);

  const { fetchImpl: f2 } = recorder(() => new Response('{"id":"x"}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const p2 = make({ apiKey: 'k', fetchImpl: f2 });
  const r2 = await p2.chat(req());
  assert.equal(r2.ok, false);
  assert.match(r2.error!, /choices|message|content|missing/i, '缺 choices 须可归因');
});

// ─── Ψ-2d 重试矩阵（经 fetchWithRetry 统一实施） ───

test('Ψ-2: 429 两次后第三次 200 —— 退避重试成功（fetch 计数 3 次）', async () => {
  const { fetchImpl, calls } = queue(
    () => httpStatus(429, '{"error":{"message":"rate limited"}}'),
    () => httpStatus(429),
    () => chatOk('重试成功', { prompt_tokens: 3, completion_tokens: 5 }),
  );
  const p = make({ apiKey: 'k', fetchImpl });
  const r = await p.chat(req());
  assert.equal(r.ok, true);
  assert.equal(r.text, '重试成功');
  assert.deepEqual(r.usage, { promptTokens: 3, completionTokens: 5 });
  assert.equal(calls.length, 3, '1 次首发 + 2 次重试');
});

test('Ψ-2: 400 不重试 —— 请求本身有病，重试无义', async () => {
  const { fetchImpl, calls } = queue(() => httpStatus(400, '{"error":{"message":"bad request"}}'));
  const p = make({ apiKey: 'k', fetchImpl });
  const r = await p.chat(req());
  assert.equal(r.ok, false);
  assert.equal(r.text, '');
  assert.ok(r.error!.length > 0);
  assert.equal(calls.length, 1);
});

test('Ψ-2: 超时不重试 —— 调用方主动止损（maxRetries 再大也不进重试环）', async () => {
  const timeoutErr = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
  const { fetchImpl, calls } = recorder(() => Promise.reject(timeoutErr));
  const p = make({ apiKey: 'k', fetchImpl });
  const r = await p.chat(req({ maxRetries: 5 }));
  assert.equal(r.ok, false);
  assert.match(r.error!, /abort|timeout|timed/i);
  assert.equal(calls.length, 1, '超时不进重试环');
});

test('Ψ-2: 非 Error 的网络异常（抛裸字符串） ⇒ 归并为失败不上抛', async () => {
  const { fetchImpl, calls } = recorder(() => Promise.reject('裸字符串故障'));
  const p = make({ apiKey: 'k', fetchImpl });
  const r = await p.chat(req({ maxRetries: 0 }));
  assert.equal(r.ok, false);
  assert.ok(r.error!.length > 0);
  assert.equal(calls.length, 1);
});

// ─── Ψ-2e 密钥卫生 ───

test('Ψ-2: 密钥卫生 —— 非 2xx 的 error 串绝不含 apiKey（网关回显也被兜底擦除）', async () => {
  const key = 'sk-leak-me-123';
  const { fetchImpl } = queue(() => httpStatus(401, JSON.stringify({ error: { message: `Invalid API key ${key} provided` } })));
  const p = make({ apiKey: key, fetchImpl });
  const r = await p.chat(req());
  assert.equal(r.ok, false);
  assert.ok(r.error!.length > 0);
  assert.ok(!r.error!.includes(key), `error 不得含密钥，实测：${r.error}`);
});

// ─── Ψ-2f meter 遥测 ───

test('Ψ-2: meter 每次调用恰好一条 —— 成功带 usage、degraded 带 error、重试后也只一条', async () => {
  const records: ProviderMeterRecord[] = [];
  const okP = make({
    apiKey: 'k',
    fetchImpl: (async () => chatOk('hi', { prompt_tokens: 9, completion_tokens: 2 })) as typeof fetch,
    meter: rec => records.push(rec),
  });
  await okP.chat(req());

  const badP = make({
    fetchImpl: (async () => chatOk('never')) as typeof fetch, // 无 key + 远端缺省 baseUrl
    meter: rec => records.push(rec),
  });
  await badP.chat(req());

  const retryP = make({
    apiKey: 'k',
    fetchImpl: queue(() => httpStatus(500), () => httpStatus(429), () => chatOk('第三次')).fetchImpl,
    meter: rec => records.push(rec),
  });
  await retryP.chat(req());

  assert.equal(records.length, 3, '一次 chat 一条记录（重试不重复计）');
  const [okRec, badRec, retryRec] = records;
  assert.equal(okRec.kind, 'openai.chat');
  assert.equal(okRec.providerId, 'openai');
  assert.equal(okRec.model, 'gpt-4o-mini');
  assert.equal(okRec.ok, true);
  assert.equal(okRec.promptTokens, 9);
  assert.equal(okRec.completionTokens, 2);
  assert.ok(okRec.ts > 0 && okRec.latencyMs >= 0);
  assert.equal(okRec.error, undefined);

  assert.equal(badRec.ok, false);
  assert.match(badRec.error!, /not configured/);
  assert.equal(badRec.promptTokens, undefined);

  assert.equal(retryRec.ok, true, '两次重试后成功 ⇒ 仍恰一条遥测');
});

test('Ψ-2: meter 自身抛错静默吞掉（不抛铁律）', async () => {
  const { fetchImpl } = recorder(() => chatOk('still works'));
  const p = make({ apiKey: 'k', fetchImpl, meter: () => { throw new Error('meter broken'); } });
  const r = await p.chat(req());
  assert.equal(r.ok, true);
  assert.equal(r.text, 'still works');
});

// ─── Ψ-2g 降级臂 ───

test('Ψ-2: degraded —— 无 key 且非本地 baseUrl ⇒ ok:false + degraded + 零 fetch', async () => {
  const { fetchImpl, calls } = recorder(() => chatOk('never'));
  const p = make({ fetchImpl });
  assert.equal(p.configured, false);
  const r = await p.chat(req());
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.equal(r.text, '');
  assert.match(r.error!, /openai api key not configured/);
  assert.equal(r.model, 'gpt-4o-mini');
  assert.equal(r.providerId, 'openai');
  assert.ok(r.latencyMs >= 0);
  assert.equal(calls.length, 0, '降级臂绝不发请求');
});

// ─── Ψ-2h 头合并与 baseUrl 归一 ───

test('Ψ-2: extraHeaders 合并 —— 展开进请求头，同名可覆盖内置头', async () => {
  const { fetchImpl, calls } = recorder(() => chatOk('ok'));
  const p = make({
    apiKey: 'k',
    fetchImpl,
    extraHeaders: { 'X-Custom-Trace': 'psi-2', 'HTTP-Referer': 'https://example.com' },
  });
  await p.chat(req());
  const headers = calls[0]!.init?.headers as Record<string, string>;
  assert.equal(headers['X-Custom-Trace'], 'psi-2');
  assert.equal(headers['HTTP-Referer'], 'https://example.com');
  assert.equal(headers.Authorization, 'Bearer k');
  assert.equal(headers['Content-Type'], 'application/json');

  const { fetchImpl: f2, calls: c2 } = recorder(() => chatOk('ok'));
  const p2 = make({ apiKey: 'k', fetchImpl: f2, extraHeaders: { 'Content-Type': 'text/plain' } });
  await p2.chat(req());
  const h2 = c2[0]!.init?.headers as Record<string, string>;
  assert.equal(h2['Content-Type'], 'text/plain', 'extraHeaders 同名覆盖内置');
});

test('Ψ-2: baseUrl 尾斜杠归一 —— 单/双尾斜杠皆拼出干净 URL', async () => {
  const { fetchImpl, calls } = recorder(() => chatOk('ok'));
  const p = make({ apiKey: 'k', baseUrl: 'http://localhost:1234/v1//', fetchImpl });
  await p.chat(req());
  assert.equal(calls[0]!.url, 'http://localhost:1234/v1/chat/completions');
});

// ─── Ψ-2i 换脑预设 ───

test('Ψ-2: 换脑预设 —— idPreset/defaultBaseUrl/defaultModel（智谱例）+ id 覆盖 idPreset', async () => {
  const records: ProviderMeterRecord[] = [];
  const { fetchImpl, calls } = recorder(() => chatOk('ok'));
  const p = make({
    idPreset: 'zhipu',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
    defaultModel: 'glm-4v-flash',
    apiKey: 'k',
    fetchImpl,
    meter: rec => records.push(rec),
  });
  const r = await p.chat(req());
  assert.equal(r.ok, true);
  assert.equal(r.providerId, 'zhipu');
  assert.equal(r.model, 'glm-4v-flash');
  assert.equal(calls[0]!.url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions', '预设 baseUrl 尾斜杠也归一');
  assert.equal(bodyOf(calls[0]!).model, 'glm-4v-flash');
  assert.equal(records[0]!.kind, 'zhipu.chat', 'meter kind 随 providerId');

  const { fetchImpl: f2 } = recorder(() => chatOk('ok'));
  const p2 = make({ id: 'explicit-id', idPreset: 'zhipu', defaultBaseUrl: 'http://localhost:9/v1', apiKey: 'k', fetchImpl: f2 });
  const r2 = await p2.chat(req());
  assert.equal(r2.providerId, 'explicit-id', '显式 id 优先于 idPreset');
});

// ─── Ψ-2j chatJson ───

test('Ψ-2: chatJson —— 强制 jsonMode、提取 value、raw 恒为回复原文', async () => {
  const reply = '分析结果：```json\n{"target": "关闭", "labels": ["确", "定"]}\n``` 请据此执行。';
  const { fetchImpl, calls } = recorder(() => chatOk(reply));
  const p = make({ apiKey: 'k', fetchImpl });
  const r = await p.chatJson<{ target: string; labels: string[] }>(req());
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { target: '关闭', labels: ['确', '定'] });
  assert.equal(r.raw, reply, 'raw 恒为回复原文');
  assert.equal(bodyOf(calls[0]!).response_format.type, 'json_object', 'chatJson 强制 jsonMode');
});

test('Ψ-2: chatJson 失败双臂 —— 传输失败 raw 空串；提取失败 raw 原文 + error 可归因', async () => {
  const { fetchImpl } = queue(() => httpStatus(400, '{"error":"bad"}'));
  const p = make({ apiKey: 'k', fetchImpl });
  const r = await p.chatJson(req());
  assert.equal(r.ok, false);
  assert.equal(r.value, undefined);
  assert.equal(r.raw, '');
  assert.ok(r.error!.length > 0);

  const reply = '抱歉，当前截图信息不足，无法给出结构化结论。';
  const { fetchImpl: f2 } = recorder(() => chatOk(reply));
  const p2 = make({ apiKey: 'k', fetchImpl: f2 });
  const r2 = await p2.chatJson(req());
  assert.equal(r2.ok, false);
  assert.equal(r2.value, undefined);
  assert.equal(r2.raw, reply);
  assert.match(r2.error!, /extraction failed/);
});

// ─── Δ-4 脏请求防御（不抛铁律） ───

test('Δ-4: 脏请求（images 缺失/非数组）doesNotReject —— 收敛为 ok:false 绝不上抛 TypeError', async () => {
  const { fetchImpl, calls } = recorder(() => chatOk('never'));
  const p = make({ apiKey: 'k', fetchImpl });
  // images 缺失：req.images.map 在消息构造面即抛 TypeError —— 必须被收敛
  let r1: Awaited<ReturnType<typeof p.chat>> | undefined;
  await assert.doesNotReject(async () => {
    r1 = await p.chat({ prompt: '脏请求', timeoutMs: REQ_TIMEOUT } as unknown as VisionChatRequest);
  });
  assert.ok(r1 !== undefined);
  assert.equal(r1!.ok, false);
  assert.equal(r1!.text, '');
  assert.ok(r1!.error!.length > 0, '脏请求须可归因');
  // images 非数组（垃圾 payload）：.map 不是函数 —— 同律收敛
  let r2: Awaited<ReturnType<typeof p.chat>> | undefined;
  await assert.doesNotReject(async () => {
    r2 = await p.chat({ images: 'garbage', prompt: '脏请求', timeoutMs: REQ_TIMEOUT } as unknown as VisionChatRequest);
  });
  assert.equal(r2!.ok, false);
  assert.ok(r2!.error!.length > 0);
  // 脏请求在消息构造面即失败 ⇒ 零网络
  assert.equal(calls.length, 0, '构造面故障绝不发出请求');
});
