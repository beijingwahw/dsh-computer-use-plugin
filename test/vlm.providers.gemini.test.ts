// test/vlm.providers.gemini.test.ts
// 纪元 Ψ（Ψ-4 万脑归一）：Gemini 协议适配器契约测试。
// 铁律：绝不真实联网 —— 一切 fetch 经 config.fetchImpl 注入假实现（可控 Response）；
// 覆盖：请求形状（generateContent 拼接 / model 含斜杠 encodeURIComponent /
// x-goog-api-key 头 / inline_data 三字段 / systemInstruction / responseMimeType
// 有无 / undefined 字段不序列化）、parts 多 text 拼接、usageMetadata 映射、
// 错误体提取与密钥卫生（错误串不含 apiKey）、重试律（共享 fetchWithRetry：
// 429/5xx/网络错可重试、超时不重试、4xx 立即失败）、meter 恰一条、
// degraded 零网络、baseUrl 尾斜杠、缺省值注入。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGeminiProvider } from '../src/vlm/providers/gemini.ts';
import type { GeminiProviderConfig } from '../src/vlm/providers/gemini.ts';
import type { ProviderMeterRecord, VisionChatRequest } from '../src/vlm/providers/types.ts';

// ─── 假 fetch 工具：记录调用 + 按序/按次回放可控 Response ───

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

/** Gemini 成功响应 —— candidates[0].content.parts（text 项可多条）+ 可选 usageMetadata */
function geminiOk(
  textParts: string | string[],
  usage?: { promptTokenCount?: number; candidatesTokenCount?: number },
): Response {
  const parts = (Array.isArray(textParts) ? textParts : [textParts]).map(t => ({ text: t }));
  return new Response(
    JSON.stringify({
      candidates: [{ content: { role: 'model', parts } }],
      ...(usage ? { usageMetadata: usage } : {}),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Gemini 错误响应 —— {error:{code,message,status}} */
function httpStatus(
  status: number,
  body = '{"error":{"code":400,"message":"boom","status":"INVALID_ARGUMENT"}}',
): Response {
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

function cfg(overrides: Partial<GeminiProviderConfig> = {}): GeminiProviderConfig {
  return { apiKey: 'sk-test', ...overrides };
}

// ─── Ψ-4a 降级臂：未配置 apiKey ───

test('Ψ-4: 未配置 apiKey ⇒ chat/chatJson 返回 degraded（ok:false + error，零网络）', async () => {
  const { fetchImpl, calls } = recorder(() => geminiOk('never'));
  const p = createGeminiProvider({ fetchImpl });
  assert.equal(p.configured, false);
  assert.equal(p.protocol, 'gemini');
  const r = await p.chat(req());
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.equal(r.text, '');
  assert.match(r.error!, /not configured/);
  assert.equal(r.model, 'gemini-2.0-flash', '模型名缺省 gemini-2.0-flash');
  assert.equal(r.providerId, 'gemini');
  assert.equal(r.latencyMs >= 0, true);
  assert.equal(calls.length, 0, '降级臂绝不发请求');

  const j = await p.chatJson(req());
  assert.equal(j.ok, false);
  assert.match(j.error!, /not configured/);
  assert.equal(j.raw, '');
  assert.equal(calls.length, 0, 'chatJson 降级同样零网络');
});

// ─── Ψ-4b 成功路径 + 请求形状 ───

test('Ψ-4: 成功路径 —— text/usage/latency + URL/鉴权头/body 形态', async () => {
  const { fetchImpl, calls } = recorder(() =>
    geminiOk('屏幕上有一个登录按钮', { promptTokenCount: 11, candidatesTokenCount: 7 }));
  const p = createGeminiProvider(cfg({ fetchImpl }));
  assert.equal(p.configured, true);
  assert.equal(p.id, 'gemini');
  assert.equal(p.model, 'gemini-2.0-flash');
  const r = await p.chat(req({
    system: '你是桌面自动化助手',
    maxTokens: 128,
    temperature: 0.2,
  }));
  assert.equal(r.ok, true);
  assert.equal(r.text, '屏幕上有一个登录按钮');
  assert.deepEqual(r.usage, { promptTokens: 11, completionTokens: 7 });
  assert.equal(r.degraded, undefined);
  assert.equal(calls.length, 1);

  const call = calls[0]!;
  assert.equal(call.init?.method, 'POST');
  assert.equal(
    call.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    '缺省 baseUrl + 缺省 model 的 generateContent 拼接',
  );
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers['x-goog-api-key'], 'sk-test', '密钥走 x-goog-api-key 头');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.ok(call.init?.signal, '必须携带 AbortSignal（超时止损）');

  const body = bodyOf(call);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: '你是桌面自动化助手' }] });
  assert.equal(body.contents.length, 1);
  const contents = body.contents[0];
  assert.equal(contents.role, 'user');
  assert.equal(contents.parts.length, 2, '一图 + 一文');
  // inline_data 三字段形态：part 只含 inline_data，内含 mime_type 与 data
  assert.deepEqual(Object.keys(contents.parts[0]), ['inline_data']);
  assert.deepEqual(Object.keys(contents.parts[0].inline_data).sort(), ['data', 'mime_type']);
  assert.equal(contents.parts[0].inline_data.mime_type, 'image/png');
  assert.equal(contents.parts[0].inline_data.data, 'QUJD');
  assert.deepEqual(contents.parts[1], { text: '描述这张截图' });
  assert.deepEqual(Object.keys(body.generationConfig).sort(), ['maxOutputTokens', 'temperature']);
  assert.equal(body.generationConfig.maxOutputTokens, 128);
  assert.equal(body.generationConfig.temperature, 0.2);
  assert.equal('responseMimeType' in body.generationConfig, false, '非 jsonMode 不下发 responseMimeType');
});

test('Ψ-4: model 含斜杠 ⇒ encodeURIComponent 进 URL，body 不受影响', async () => {
  const { fetchImpl, calls } = recorder(() => geminiOk('ok'));
  const p = createGeminiProvider(cfg({ model: 'tunedModels/my-tune', fetchImpl }));
  const r = await p.chat(req());
  assert.equal(r.ok, true);
  assert.equal(r.model, 'tunedModels/my-tune');
  assert.equal(
    calls[0]!.url,
    'https://generativelanguage.googleapis.com/v1beta/models/tunedModels%2Fmy-tune:generateContent',
  );
  assert.equal(bodyOf(calls[0]!).contents.length, 1);
});

test('Ψ-4: mime 缺省 image/jpeg；无/空 system ⇒ systemInstruction 键不序列化；空图片 = 纯文本', async () => {
  const { fetchImpl, calls } = recorder(() => geminiOk('ok'));
  const p = createGeminiProvider(cfg({ fetchImpl }));

  await p.chat(req({ images: [{ base64: 'AAAA' }], system: undefined }));
  let body = bodyOf(calls[0]!);
  assert.equal('systemInstruction' in body, false, '无 system ⇒ 键不存在（而非 undefined）');
  assert.equal(body.contents[0].parts[0].inline_data.mime_type, 'image/jpeg', 'mime 缺省 image/jpeg');
  assert.equal(body.contents[0].parts[0].inline_data.data, 'AAAA');
  assert.equal(body.contents[0].parts.length, 2);

  await p.chat(req({ system: '' })); // 空 system 等同无 system
  body = bodyOf(calls[1]!);
  assert.equal('systemInstruction' in body, false, '空 system ⇒ 键不存在');

  await p.chat(req({ images: [] }));
  body = bodyOf(calls[2]!);
  assert.deepEqual(body.contents[0].parts, [{ text: '描述这张截图' }], '空图片 ⇒ 仅 text part');
});

test('Ψ-4: jsonMode ⇒ generationConfig.responseMimeType=application/json；chat 成功附 json', async () => {
  const { fetchImpl, calls } = recorder(() =>
    geminiOk('```json\n{"verdict": "click", "x": 0.5, "y": 0.25}\n```'));
  const p = createGeminiProvider(cfg({ fetchImpl }));
  const r = await p.chat(req({ jsonMode: true }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.json, { verdict: 'click', x: 0.5, y: 0.25 });
  assert.equal(bodyOf(calls[0]!).generationConfig.responseMimeType, 'application/json');
});

test('Ψ-4: extraHeaders 并入请求头；鉴权头不受影响', async () => {
  const { fetchImpl, calls } = recorder(() => geminiOk('ok'));
  const p = createGeminiProvider(cfg({
    fetchImpl,
    extraHeaders: { 'X-Tenant': 'dsh', 'X-Trace': 'trace-1' },
  }));
  await p.chat(req());
  const headers = calls[0]!.init?.headers as Record<string, string>;
  assert.equal(headers['X-Tenant'], 'dsh');
  assert.equal(headers['X-Trace'], 'trace-1');
  assert.equal(headers['x-goog-api-key'], 'sk-test');
});

test('Ψ-4: baseUrl 尾斜杠剥离 —— 多重尾斜杠也不产生双斜杠', async () => {
  const { fetchImpl, calls } = recorder(() => geminiOk('ok'));
  const p = createGeminiProvider(cfg({ baseUrl: 'http://localhost:9/v1beta//', fetchImpl }));
  await p.chat(req());
  assert.equal(
    calls[0]!.url,
    'http://localhost:9/v1beta/models/gemini-2.0-flash:generateContent',
  );
});

test('Ψ-4: 缺省值注入 —— defaultBaseUrl/defaultModel/idPreset；显式字段压过缺省字段', async () => {
  const { fetchImpl: f1, calls: c1 } = recorder(() => geminiOk('ok'));
  const records1: ProviderMeterRecord[] = [];
  const p1 = createGeminiProvider(cfg({
    defaultBaseUrl: 'http://proxy/v1beta', defaultModel: 'gemini-1.5-pro', idPreset: 'gproxy',
    fetchImpl: f1, meter: rec => records1.push(rec),
  }));
  assert.equal(p1.id, 'gproxy');
  assert.equal(p1.model, 'gemini-1.5-pro');
  await p1.chat(req());
  assert.equal(c1[0]!.url, 'http://proxy/v1beta/models/gemini-1.5-pro:generateContent');
  assert.equal(records1[0]!.kind, 'gproxy.chat', 'meter kind 随 providerId');
  assert.equal(records1[0]!.providerId, 'gproxy');

  // 显式 id/baseUrl/model 压过 idPreset/defaultBaseUrl/defaultModel
  const { fetchImpl: f2, calls: c2 } = recorder(() => geminiOk('ok'));
  const records2: ProviderMeterRecord[] = [];
  const p2 = createGeminiProvider(cfg({
    defaultBaseUrl: 'http://proxy/v1beta', defaultModel: 'gemini-1.5-pro', idPreset: 'gproxy',
    id: 'gemini-direct', baseUrl: 'http://direct/v1beta', model: 'gemini-2.5-flash',
    fetchImpl: f2, meter: rec => records2.push(rec),
  }));
  assert.equal(p2.id, 'gemini-direct');
  await p2.chat(req());
  assert.equal(c2[0]!.url, 'http://direct/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(records2[0]!.kind, 'gemini-direct.chat');
});

// ─── Ψ-4c 响应解析 ───

test('Ψ-4: parts 多 text 项按序拼接；非 text 项跳过', async () => {
  const parts = [
    { text: '分析结论：' },
    { functionCall: { name: 'noop' } }, // 非 text part 防御兼容
    { text: '点击「登录」按钮' },
  ];
  const { fetchImpl } = recorder(() => new Response(
    JSON.stringify({ candidates: [{ content: { role: 'model', parts } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ));
  const p = createGeminiProvider(cfg({ fetchImpl }));
  const r = await p.chat(req());
  assert.equal(r.ok, true);
  assert.equal(r.text, '分析结论：点击「登录」按钮');
});

test('Ψ-4: usageMetadata 半边缺省只上报给定字段；无 usageMetadata ⇒ usage 缺省', async () => {
  const { fetchImpl: f1 } = recorder(() => geminiOk('ok', { promptTokenCount: 5 }));
  const p1 = createGeminiProvider(cfg({ fetchImpl: f1 }));
  const r1 = await p1.chat(req());
  assert.deepEqual(r1.usage, { promptTokens: 5 });

  const { fetchImpl: f2 } = recorder(() => geminiOk('ok'));
  const p2 = createGeminiProvider(cfg({ fetchImpl: f2 }));
  const r2 = await p2.chat(req());
  assert.equal(r2.usage, undefined, '无 usageMetadata ⇒ 不产空壳');
});

test('Ψ-4: 响应缺 candidates/parts ⇒ 诚实失败不抛；200 非 JSON ⇒ 解析失败归因', async () => {
  const { fetchImpl: f1 } = recorder(() => new Response('{"id":"x"}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const p1 = createGeminiProvider(cfg({ fetchImpl: f1 }));
  const r1 = await p1.chat(req());
  assert.equal(r1.ok, false);
  assert.match(r1.error!, /missing candidates/);

  const { fetchImpl: f2 } = recorder(() => new Response('not json at all', { status: 200 }));
  const p2 = createGeminiProvider(cfg({ fetchImpl: f2 }));
  const r2 = await p2.chat(req());
  assert.equal(r2.ok, false);
  assert.match(r2.error!, /JSON parse failed/);
});

// ─── Ψ-4d 错误体与密钥卫生 ───

test('Ψ-4: 非 2xx 错误体 {error:{message}} ⇒ error 优先取 message', async () => {
  const { fetchImpl } = queue(() => httpStatus(400, '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}'));
  const p = createGeminiProvider(cfg({ fetchImpl }));
  const r = await p.chat(req());
  assert.equal(r.ok, false);
  assert.equal(r.text, '');
  assert.match(r.error!, /API key not valid/);
  assert.match(r.error!, /^gemini /, 'sanitizeError 的 providerId 前缀');
});

test('Ψ-4: 非 JSON 错误体 / 空 body ⇒ HTTP 状态 fallback 归因，仍不抛', async () => {
  const { fetchImpl: f1 } = queue(() => httpStatus(502, '<html>Bad Gateway</html>'));
  const p1 = createGeminiProvider(cfg({ fetchImpl: f1 }));
  const r1 = await p1.chat(req());
  assert.equal(r1.ok, false);
  assert.match(r1.error!, /502/);
  assert.match(r1.error!, /Bad Gateway/, '非 JSON 错误体原文兜底');

  const { fetchImpl: f2 } = queue(() => new Response('', { status: 500 }));
  const p2 = createGeminiProvider(cfg({ fetchImpl: f2 }));
  const r2 = await p2.chat(req({ maxRetries: 0 }));
  assert.equal(r2.ok, false);
  assert.match(r2.error!, /500/);
});

test('Ψ-4: 密钥卫生 —— 错误串绝不包含 apiKey（HTTP 臂与网络臂）', async () => {
  const SECRET = 'gem-SUPER-SECRET-k3y';
  const { fetchImpl: f1 } = queue(() => httpStatus(403, '{"error":{"code":403,"message":"permission denied","status":"PERMISSION_DENIED"}}'));
  const p1 = createGeminiProvider(cfg({ apiKey: SECRET, fetchImpl: f1 }));
  const r1 = await p1.chat(req());
  assert.equal(r1.ok, false);
  assert.ok(!r1.error!.includes(SECRET), `HTTP 错误串不得回显密钥：${r1.error}`);

  // 网络错误臂同样不回显密钥
  const { fetchImpl: f2 } = recorder(() => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })));
  const p2 = createGeminiProvider(cfg({ apiKey: SECRET, fetchImpl: f2 }));
  const r2 = await p2.chat(req({ maxRetries: 0 }));
  assert.equal(r2.ok, false);
  assert.ok(!r2.error!.includes(SECRET), `网络错误串不得回显密钥：${r2.error}`);
});

// ─── Ψ-4e 重试律（共享 fetchWithRetry —— 唯一定义点） ───

test('Ψ-4: 429 两次后第三次 200 —— 退避重试成功', async () => {
  const { fetchImpl, calls } = queue(
    () => httpStatus(429, '{"error":{"code":429,"message":"rate limited","status":"RESOURCE_EXHAUSTED"}}'),
    () => httpStatus(429),
    () => geminiOk('第二次重试成功', { promptTokenCount: 3, candidatesTokenCount: 5 }),
  );
  const p = createGeminiProvider(cfg({ fetchImpl }));
  const r = await p.chat(req());
  assert.equal(r.ok, true);
  assert.equal(r.text, '第二次重试成功');
  assert.deepEqual(r.usage, { promptTokens: 3, completionTokens: 5 });
  assert.equal(calls.length, 3, '1 次首发 + 2 次重试');
});

test('Ψ-4: 5xx 可重试，耗尽 ⇒ ok:false；400 不可重试立即失败', async () => {
  const { fetchImpl: f1, calls: c1 } = queue(() => httpStatus(503, 'unavailable'));
  const p1 = createGeminiProvider(cfg({ fetchImpl: f1 }));
  const r1 = await p1.chat(req());
  assert.equal(r1.ok, false);
  assert.equal(c1.length, 3, 'maxRetries=2 ⇒ 至多 3 次');
  assert.match(r1.error!, /503/);

  const { fetchImpl: f2, calls: c2 } = queue(() => httpStatus(400));
  const p2 = createGeminiProvider(cfg({ fetchImpl: f2 }));
  const r2 = await p2.chat(req());
  assert.equal(r2.ok, false);
  assert.equal(c2.length, 1, '400 请求有病重试无义');
});

test('Ψ-4: 网络错误可重试 —— 抖动后恢复成功', async () => {
  let n = 0;
  const { fetchImpl, calls } = recorder(() => {
    n++;
    if (n === 1) return Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }));
    return Promise.resolve(geminiOk('网络恢复了'));
  });
  const p = createGeminiProvider(cfg({ fetchImpl }));
  const r = await p.chat(req());
  assert.equal(r.ok, true);
  assert.equal(r.text, '网络恢复了');
  assert.equal(calls.length, 2);
});

test('Ψ-4: 超时（TimeoutError）不重试 —— 调用方主动止损', async () => {
  const timeoutErr = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
  const { fetchImpl, calls } = recorder(() => Promise.reject(timeoutErr));
  const p = createGeminiProvider(cfg({ fetchImpl }));
  const r = await p.chat(req({ maxRetries: 5 }));
  assert.equal(r.ok, false);
  assert.match(r.error!, /aborted/);
  assert.equal(calls.length, 1, '超时不进重试环');
});

// ─── Ψ-4f chatJson ───

test('Ψ-4: chatJson 强制 jsonMode；围栏 + 前后杂文提取；失败臂 raw 恒原文', async () => {
  const reply = '好的，结果如下：```json\n{"target": "关闭", "labels": ["确", "定"]}\n``` 请据此执行。';
  const { fetchImpl, calls } = recorder(() => geminiOk(reply));
  const p = createGeminiProvider(cfg({ fetchImpl }));
  const r = await p.chatJson<{ target: string; labels: string[] }>(req());
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { target: '关闭', labels: ['确', '定'] });
  assert.equal(r.raw, reply, 'raw 恒为回复原文');
  assert.equal(bodyOf(calls[0]!).generationConfig.responseMimeType, 'application/json', 'chatJson 强制 jsonMode');

  // 提取失败 ⇒ ok:false + raw=原文
  const { fetchImpl: f2 } = recorder(() => geminiOk('抱歉，当前截图信息不足。'));
  const p2 = createGeminiProvider(cfg({ fetchImpl: f2 }));
  const r2 = await p2.chatJson(req());
  assert.equal(r2.ok, false);
  assert.equal(r2.value, undefined);
  assert.equal(r2.raw, '抱歉，当前截图信息不足。');
  assert.match(r2.error!, /extraction failed/);

  // 传输失败 ⇒ error 透传 + raw 空串
  const { fetchImpl: f3 } = queue(() => httpStatus(400, '{"error":{"code":400,"message":"bad request","status":"INVALID_ARGUMENT"}}'));
  const p3 = createGeminiProvider(cfg({ fetchImpl: f3 }));
  const r3 = await p3.chatJson(req());
  assert.equal(r3.ok, false);
  assert.match(r3.error!, /bad request/);
  assert.equal(r3.raw, '');
});

// ─── Ψ-4g meter 遥测 ───

test('Ψ-4: meter 恰好每次调用一条（kind=gemini.chat）—— 成功带 usage、失败带 error、重试只计一条', async () => {
  const records: ProviderMeterRecord[] = [];
  const okP = createGeminiProvider(cfg({
    fetchImpl: (async () => geminiOk('hi', { promptTokenCount: 9, candidatesTokenCount: 2 })) as typeof fetch,
    meter: rec => records.push(rec),
  }));
  await okP.chat(req());

  const badP = createGeminiProvider({ meter: rec => records.push(rec) });
  await badP.chat(req());

  const retryP = createGeminiProvider(cfg({
    fetchImpl: queue(() => httpStatus(429), () => httpStatus(429), () => geminiOk('ok')).fetchImpl,
    meter: rec => records.push(rec),
  }));
  await retryP.chat(req());

  assert.equal(records.length, 3, '一次 chat 一条记录（重试不重复计）');
  const [okRec, badRec, retryRec] = records;
  assert.equal(okRec.kind, 'gemini.chat');
  assert.equal(okRec.providerId, 'gemini');
  assert.equal(okRec.ok, true);
  assert.equal(okRec.model, 'gemini-2.0-flash');
  assert.equal(okRec.promptTokens, 9);
  assert.equal(okRec.completionTokens, 2);
  assert.ok(okRec.latencyMs >= 0 && okRec.ts > 0);
  assert.equal(okRec.error, undefined);

  assert.equal(badRec.ok, false);
  assert.match(badRec.error!, /not configured/);
  assert.equal(badRec.promptTokens, undefined);

  assert.equal(retryRec.ok, true, '重试后成功只计一条且为最终结果');
});

test('Ψ-4: meter 自身抛错不影响主路径（不抛铁律）', async () => {
  const { fetchImpl } = recorder(() => geminiOk('still works'));
  const p = createGeminiProvider(cfg({ fetchImpl, meter: () => { throw new Error('meter broken'); } }));
  const r = await p.chat(req());
  assert.equal(r.ok, true);
  assert.equal(r.text, 'still works');
});

// ─── Δ-3/Δ-4 密钥兜底擦除 + 脏请求防御 ───

test('Δ-3: 错误面回显 exact-key ⇒ finish 兜底擦除（sanitizeError 模式表外的自定义密钥）', async () => {
  // 刻意选不带 sk-/gsk- 前缀、无键值对形态的密钥 —— 证明 exact-key 兜底独立于模式表
  const key = 'gemExactEcho74213abcdef';
  const { fetchImpl } = queue(() => httpStatus(401,
    `{"error":{"code":401,"message":"authentication failed for ${key}","status":"UNAUTHENTICATED"}}`));
  const p = createGeminiProvider(cfg({ apiKey: key, fetchImpl }));
  const r = await p.chat(req());
  assert.equal(r.ok, false);
  assert.ok(!r.error!.includes(key), `error 不得回显 exact-key，实测：${r.error}`);
  assert.ok(r.error!.includes('***redacted***'), 'exact-key 由 scrubSecret 就地擦除');
  assert.match(r.error!, /HTTP 401/);
});

test('Δ-4: 脏请求（images 缺失/非数组）doesNotReject —— 收敛为 ok:false 绝不上抛 TypeError', async () => {
  const { fetchImpl, calls } = recorder(() => geminiOk('never'));
  const p = createGeminiProvider(cfg({ fetchImpl }));
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
