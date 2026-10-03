// test/vlm.providers.anthropic.test.ts
// 纪元 Ψ（Ψ-3 万脑归一）：Anthropic Claude 适配器契约测试。
// 铁律：绝不真实联网 —— 一切 fetch 经 fetchImpl 注入假实现（可控 Response）；
// 覆盖：请求形状（/v1/messages 拼接、x-api-key/anthropic-version 头、image
// source 三字段、system 顶层位置）、jsonMode 提示词追加、content 分段拼接、
// usage 映射、错误体 message 提取、密钥卫生、重试律（429 重试/400 不重试/
// 超时不重试）、meter 恰一条、degraded 零 fetch、baseUrl 尾斜杠、env 优先级。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import type {
  AnthropicProviderConfig,
} from '../src/vlm/providers/anthropic.ts';
import type {
  ProviderMeterRecord, VisionChatRequest,
} from '../src/vlm/providers/types.ts';

// 动态导入被测模块（TS 经 register.mjs 的解析 hook 直跑）
const anth = await import('../src/vlm/providers/anthropic.ts');

// ─── 环境隔离：抹掉可能存在的真实 key/基址/模型，退出时原样恢复 ───
const ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'] as const;
const savedEnv = new Map<string, string | undefined>();
for (const k of ENV_KEYS) {
  savedEnv.set(k, process.env[k]);
  delete process.env[k];
}
after(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

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

/** Messages 成功响应 —— content 块数组 + 可选 usage（input/output_tokens 方言） */
function ok(content: unknown, usage?: Record<string, number>): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_013WzZ',
      type: 'message',
      role: 'assistant',
      content,
      model: 'claude-sonnet-4',
      ...(usage ? { usage } : {}),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Anthropic 错误体 —— {type:'error',error:{type,message}} 方言 */
function httpStatus(status: number, body = '{"type":"error","error":{"type":"api_error","message":"boom"}}'): Response {
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

// ─── Ψ-3a 降级臂：未配置 apiKey ───

test('Ψ-3: 未配置 apiKey ⇒ degraded 零网络（ok:false + error，不触网）', async () => {
  const { fetchImpl, calls } = recorder(() => ok([{ type: 'text', text: 'never' }]));
  const p = anth.createAnthropicProvider({ fetchImpl }); // env 已清空 ⇒ 无 key
  assert.equal(p.configured, false);
  assert.equal(p.id, 'anthropic');
  assert.equal(p.protocol, 'anthropic');
  assert.equal(p.model, 'claude-sonnet-4', '模型名缺省 claude-sonnet-4');
  const r = await p.chat(req());
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.equal(r.text, '');
  assert.match(r.error!, /not configured/);
  assert.equal(r.model, 'claude-sonnet-4');
  assert.equal(r.providerId, 'anthropic');
  assert.equal(r.latencyMs >= 0, true);
  assert.equal(calls.length, 0, '降级臂绝不发请求');
});

// ─── Ψ-3b 成功文本路径 + 请求形状 ───

test('Ψ-3: 成功路径 —— text/usage + /v1/messages 拼接 + 头与 body 全形态', async () => {
  const { fetchImpl, calls } = recorder(() =>
    ok([{ type: 'text', text: '屏幕中央有一个蓝色「登录」按钮' }], { input_tokens: 11, output_tokens: 7 }));
  const p = anth.createAnthropicProvider({ apiKey: 'sk-ant-test', fetchImpl });
  assert.equal(p.configured, true);
  const r = await p.chat(req({
    system: '你是桌面自动化助手',
    maxTokens: 128,
    temperature: 0.2,
    images: [{ base64: 'QUJD', mime: 'image/png' }, { base64: 'REVG' }],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.text, '屏幕中央有一个蓝色「登录」按钮');
  assert.deepEqual(r.usage, { promptTokens: 11, completionTokens: 7 });
  assert.equal(r.degraded, undefined);
  assert.equal(r.providerId, 'anthropic');
  assert.equal(calls.length, 1);

  const call = calls[0]!;
  assert.equal(call.init?.method, 'POST');
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages', '缺省 baseUrl + /v1/messages');
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], 'sk-ant-test', 'x-api-key 鉴权头');
  assert.equal(headers['anthropic-version'], '2023-06-01', 'anthropic-version 缺省');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers.Authorization, undefined, 'Anthropic 用 x-api-key，不用 Bearer');
  assert.ok(call.init?.signal, '必须携带 AbortSignal（fetchWithRetry 注入超时止损）');

  const body = bodyOf(call);
  assert.equal(body.model, 'claude-sonnet-4');
  assert.equal(body.max_tokens, 128);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.response_format, undefined, 'Anthropic 无原生 response_format，绝不下发');
  assert.equal(body.messages.length, 1, '单条 user 消息（system 是顶层字段，不占消息位）');
  const user = body.messages[0];
  assert.equal(user.role, 'user');
  // system 位置：请求体顶层字符串
  assert.equal(body.system, '你是桌面自动化助手');
  // content：图像块在前、文本块殿后；image source 三字段
  assert.equal(user.content.length, 3);
  assert.deepEqual(user.content[0], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
  });
  assert.equal(user.content[1].type, 'image');
  assert.equal(user.content[1].source.type, 'base64');
  assert.equal(user.content[1].source.media_type, 'image/jpeg', 'mime 缺省 image/jpeg');
  assert.equal(user.content[1].source.data, 'REVG');
  assert.equal(user.content[2].type, 'text');
  assert.equal(user.content[2].text, '描述这张截图');
});

test('Ψ-3: 无 system ⇒ body 无 system 字段；空图片 ⇒ content 仅 text 块；usage 缺省 ⇒ 不产出空壳', async () => {
  const { fetchImpl, calls } = recorder(() => ok([{ type: 'text', text: 'ok' }]));
  const p = anth.createAnthropicProvider({ apiKey: 'k', fetchImpl });
  const r = await p.chat(req({ images: [] }));
  assert.equal(r.ok, true);
  assert.equal(r.usage, undefined, '服务端未上报 usage ⇒ 缺省');
  let body = bodyOf(calls[0]!);
  assert.equal(body.system, undefined);
  assert.equal(body.messages[0].content.length, 1, '空图片 ⇒ 仅 text 块');
  assert.equal(body.messages[0].content[0].type, 'text');

  await p.chat(req({ system: '' }));
  body = bodyOf(calls[1]!);
  assert.equal(body.system, undefined, '空串 system 视同缺席');
});

test('Ψ-3: baseUrl 尾斜杠剥离 + defaultBaseUrl/defaultModel/apiVersion/idPreset 预设', async () => {
  const { fetchImpl, calls } = recorder(() => ok([{ type: 'text', text: 'ok' }]));
  const p = anth.createAnthropicProvider({
    apiKey: 'k',
    defaultBaseUrl: 'https://proxy.example/anth',
    defaultModel: 'claude-opus-4',
    apiVersion: '2023-01-01',
    idPreset: 'claude',
    fetchImpl,
  });
  assert.equal(p.id, 'claude', 'idPreset 在 options.id 缺席时生效');
  assert.equal(p.model, 'claude-opus-4');
  await p.chat(req());
  const call = calls[0]!;
  assert.equal(call.url, 'https://proxy.example/anth/v1/messages');
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers['anthropic-version'], '2023-01-01');
  assert.equal(headers['x-api-key'], 'k');
  assert.equal(bodyOf(call).model, 'claude-opus-4');
  assert.equal((await p.chat(req())).providerId, 'claude');
});

test('Ψ-3: baseUrl 尾斜杠（含多层）不产生双斜杠', async () => {
  const { fetchImpl, calls } = recorder(() => ok([{ type: 'text', text: 'ok' }]));
  const p = anth.createAnthropicProvider({ apiKey: 'k', baseUrl: 'https://an.example/anthropic//', fetchImpl });
  await p.chat(req());
  assert.equal(calls[0]!.url, 'https://an.example/anthropic/v1/messages');
});

test('Ψ-3: extraHeaders 追加 + 同名覆盖缺省头', async () => {
  const { fetchImpl, calls } = recorder(() => ok([{ type: 'text', text: 'ok' }]));
  const p = anth.createAnthropicProvider({
    apiKey: 'k',
    extraHeaders: { 'X-Workspace': 'ws-1', 'anthropic-version': '2023-01-01' },
    fetchImpl,
  });
  await p.chat(req());
  const headers = calls[0]!.init?.headers as Record<string, string>;
  assert.equal(headers['X-Workspace'], 'ws-1');
  assert.equal(headers['anthropic-version'], '2023-01-01', 'extraHeaders 同名覆盖缺省');
  assert.equal(headers['x-api-key'], 'k', '未被覆盖的缺省头保持');
});

// ─── Ψ-3c jsonMode：提示词追加（无原生 response_format） ───

test('Ψ-3: jsonMode —— prompt 尾部追加约定行，围栏回复剥壳提取', async () => {
  const { fetchImpl, calls } = recorder(() =>
    ok([{ type: 'text', text: '```json\n{"verdict": "click", "x": 0.5, "y": 0.25}\n```' }]));
  const p = anth.createAnthropicProvider({ apiKey: 'k', fetchImpl });
  const r = await p.chat(req({ jsonMode: true, prompt: '给出判决' }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.json, { verdict: 'click', x: 0.5, y: 0.25 });
  const body = bodyOf(calls[0]!);
  assert.equal(body.response_format, undefined, 'Anthropic 无原生 response_format');
  assert.equal(
    body.messages[0].content[body.messages[0].content.length - 1].text,
    '给出判决\n\n只输出严格 JSON，不要围栏。',
    'jsonMode ⇒ prompt 尾部追加约定行',
  );
});

test('Ψ-3: 非 jsonMode ⇒ prompt 原样发送（无追加行），结果不带 json 字段', async () => {
  const { fetchImpl, calls } = recorder(() => ok([{ type: 'text', text: '好的' }]));
  const p = anth.createAnthropicProvider({ apiKey: 'k', fetchImpl });
  const r = await p.chat(req({ prompt: '给出判决', images: [] }));
  assert.equal(r.ok, true);
  assert.equal(r.json, undefined, '非 jsonMode 不做提取');
  const body = bodyOf(calls[0]!);
  assert.equal(body.messages[0].content.length, 1, '空图片 ⇒ 仅 text 块');
  assert.equal(body.messages[0].content[0].text, '给出判决', 'prompt 原样、无追加行');
  assert.ok(!String(body.messages[0].content[0].text).includes('只输出严格 JSON'));
});

// ─── Ψ-3d content 分段拼接与脏体防御 ───

test('Ψ-3: content 分段 —— 仅 type:text 块按序拼接，thinking 等块跳过', async () => {
  const { fetchImpl } = recorder(() => ok([
    { type: 'text', text: '第一段，' },
    { type: 'thinking', thinking: '内部推理不得泄漏' },
    { type: 'tool_use', id: 't1', name: 'click' },
    { type: 'text', text: '第二段' },
  ]));
  const p = anth.createAnthropicProvider({ apiKey: 'k', fetchImpl });
  const r = await p.chat(req());
  assert.equal(r.ok, true);
  assert.equal(r.text, '第一段，第二段');
});

test('Ψ-3: 响应缺 content 数组 ⇒ 诚实失败不抛', async () => {
  const { fetchImpl } = recorder(() => new Response('{"id":"msg_x","type":"message"}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const p = anth.createAnthropicProvider({ apiKey: 'k', fetchImpl });
  const r = await p.chat(req());
  assert.equal(r.ok, false);
  assert.equal(r.text, '');
  assert.match(r.error!, /missing content/);
});

test('Ψ-3: 2xx 非 JSON 体 ⇒ parse 失败诚实归因', async () => {
  const { fetchImpl } = recorder(() => new Response('<html>gateway</html>', { status: 200 }));
  const p = anth.createAnthropicProvider({ apiKey: 'k', fetchImpl });
  const r = await p.chat(req());
  assert.equal(r.ok, false);
  assert.match(r.error!, /JSON parse failed/);
});

// ─── Ψ-3e 错误体 message 提取 + 密钥卫生 ───

test('Ψ-3: 非 2xx 错误体 —— 优先提取 error.message 并标注 HTTP 状态', async () => {
  const { fetchImpl, calls } = recorder(() =>
    httpStatus(400, '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: Field required"}}'));
  const p = anth.createAnthropicProvider({ apiKey: 'k', fetchImpl });
  const r = await p.chat(req());
  assert.equal(r.ok, false);
  assert.equal(r.text, '');
  assert.match(r.error!, /HTTP 400/);
  assert.match(r.error!, /max_tokens: Field required/);
  assert.doesNotMatch(r.error!, /after \d+ attempts/, '400 不重试 ⇒ 不标注尝试次数');
  assert.equal(calls.length, 1);
});

test('Ψ-3: 非 JSON 错误体 —— 原文片段兜底', async () => {
  const { fetchImpl } = recorder(() => httpStatus(404, 'route not found'));
  const p = anth.createAnthropicProvider({ apiKey: 'k', fetchImpl });
  const r = await p.chat(req());
  assert.equal(r.ok, false);
  assert.match(r.error!, /HTTP 404/);
  assert.match(r.error!, /route not found/);
});

test('Ψ-3: 密钥卫生 —— 错误串绝不含 apiKey 值（回显密钥被 [REDACTED] 剔除）', async () => {
  const apiKey = 'sk-ant-api03-ZmFrvEDvJK0v2aTQ5abcde';
  const { fetchImpl } = recorder(() =>
    httpStatus(401, `{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key provided: ${apiKey}"}}`));
  const p = anth.createAnthropicProvider({ apiKey, fetchImpl });
  const r = await p.chat(req());
  assert.equal(r.ok, false);
  assert.ok(!r.error!.includes(apiKey), '错误串不得回显 apiKey 值');
  assert.ok(r.error!.includes('[REDACTED]'), '被识别的凭据片段统一替换为 [REDACTED]');
  assert.match(r.error!, /^anthropic /, 'sanitizeError 前缀形态');
});

test('Δ-3: 401 回显 exact-key ⇒ finish 兜底擦除（sanitizeError 模式表外的自定义密钥）', async () => {
  // 刻意选不带 sk-/gsk- 前缀、无键值对形态的密钥 —— 证明 exact-key 兜底独立于模式表
  const apiKey = 'antExactEcho987654321abcdef';
  const { fetchImpl } = recorder(() =>
    httpStatus(401, `{"type":"error","error":{"type":"authentication_error","message":"authentication failed for ${apiKey}"}}`));
  const p = anth.createAnthropicProvider({ apiKey, fetchImpl });
  const r = await p.chat(req());
  assert.equal(r.ok, false);
  assert.ok(!r.error!.includes(apiKey), `error 不得回显 exact-key，实测：${r.error}`);
  assert.ok(r.error!.includes('***redacted***'), 'exact-key 由 scrubSecret 就地擦除');
  assert.match(r.error!, /HTTP 401/);
});

// ─── Ψ-3f 重试矩阵（fetchWithRetry 律） ───

test('Ψ-3: 429 两次后第三次 200 —— 全抖动退避重试成功', async () => {
  const { fetchImpl, calls } = queue(
    () => httpStatus(429, '{"type":"error","error":{"message":"rate limited"}}'),
    () => httpStatus(429),
    () => ok([{ type: 'text', text: '重试成功' }], { input_tokens: 3, output_tokens: 5 }),
  );
  const p = anth.createAnthropicProvider({ apiKey: 'k', fetchImpl });
  const r = await p.chat(req());
  assert.equal(r.ok, true);
  assert.equal(r.text, '重试成功');
  assert.deepEqual(r.usage, { promptTokens: 3, completionTokens: 5 });
  assert.equal(calls.length, 3, '1 次首发 + 2 次重试');
});

test('Ψ-3: 5xx 可重试；重试耗尽 ⇒ ok:false 且 error 标注尝试次数', async () => {
  const { fetchImpl, calls } = queue(() =>
    httpStatus(503, '{"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}'));
  const p = anth.createAnthropicProvider({ apiKey: 'k', fetchImpl });
  const r = await p.chat(req());
  assert.equal(r.ok, false);
  assert.match(r.error!, /HTTP 503 after 3 attempts/);
  assert.match(r.error!, /overloaded/);
  assert.equal(calls.length, 3, 'maxRetries=2 ⇒ 至多 3 次');
});

test('Ψ-3: 400 不可重试 —— 请求有病重试无义，立即失败', async () => {
  const { fetchImpl, calls } = queue(() => httpStatus(400));
  const p = anth.createAnthropicProvider({ apiKey: 'k', fetchImpl });
  const r = await p.chat(req());
  assert.equal(r.ok, false);
  assert.match(r.error!, /HTTP 400/);
  assert.equal(calls.length, 1);
});

test('Ψ-3: 超时（TimeoutError）不重试 —— 调用方主动止损', async () => {
  const timeoutErr = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
  const { fetchImpl, calls } = recorder(() => Promise.reject(timeoutErr));
  const p = anth.createAnthropicProvider({ apiKey: 'k', fetchImpl });
  const r = await p.chat(req({ maxRetries: 5 }));
  assert.equal(r.ok, false);
  assert.match(r.error!, /aborted after 500ms/);
  assert.equal(calls.length, 1, '超时不进重试环');
});

test('Ψ-3: 网络错误可重试 —— 抖动后恢复成功；耗尽归因带尝试次数', async () => {
  let n = 0;
  const okRec = recorder(() => {
    n++;
    if (n === 1) return Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }));
    return Promise.resolve(ok([{ type: 'text', text: '网络恢复了' }]));
  });
  const p1 = anth.createAnthropicProvider({ apiKey: 'k', fetchImpl: okRec.fetchImpl });
  const r1 = await p1.chat(req());
  assert.equal(r1.ok, true);
  assert.equal(r1.text, '网络恢复了');
  assert.equal(okRec.calls.length, 2);

  const dead = recorder(() => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })));
  const p2 = anth.createAnthropicProvider({ apiKey: 'k', fetchImpl: dead.fetchImpl });
  const r2 = await p2.chat(req());
  assert.equal(r2.ok, false);
  assert.match(r2.error!, /fetch failed after 3 attempts/);
  assert.equal(dead.calls.length, 3);
});

// ─── Ψ-3g meter 遥测 ───

test('Ψ-3: meter 恰好每次调用一条 —— kind 随 providerId，成功带 usage、降级带 error', async () => {
  const records: ProviderMeterRecord[] = [];
  const opts = (extra: Partial<AnthropicProviderConfig>): AnthropicProviderConfig => ({
    ...extra,
    meter: rec => records.push(rec),
  });

  const okP = anth.createAnthropicProvider(opts({
    apiKey: 'k',
    fetchImpl: (async () => ok([{ type: 'text', text: 'hi' }], { input_tokens: 9, output_tokens: 2 })) as typeof fetch,
  }));
  await okP.chat(req());

  const degradedP = anth.createAnthropicProvider(opts({}));
  await degradedP.chat(req());

  const euP = anth.createAnthropicProvider(opts({
    apiKey: 'k', idPreset: 'anthropic-eu',
    fetchImpl: (async () => ok([{ type: 'text', text: 'hi' }])) as typeof fetch,
  }));
  await euP.chat(req());

  assert.equal(records.length, 3, '一次 chat 一条记录（重试不重复计）');
  const [okRec, badRec, euRec] = records;
  assert.equal(okRec.kind, 'anthropic.chat');
  assert.equal(okRec.ok, true);
  assert.equal(okRec.providerId, 'anthropic');
  assert.equal(okRec.model, 'claude-sonnet-4');
  assert.equal(okRec.promptTokens, 9);
  assert.equal(okRec.completionTokens, 2);
  assert.ok(okRec.latencyMs >= 0 && okRec.ts > 0);
  assert.equal(okRec.error, undefined);

  assert.equal(badRec.ok, false);
  assert.equal(badRec.kind, 'anthropic.chat');
  assert.match(badRec.error!, /not configured/);
  assert.equal(badRec.promptTokens, undefined);

  assert.equal(euRec.kind, 'anthropic-eu.chat', 'kind = `${providerId}.chat` 随 id 变化');
  assert.equal(euRec.providerId, 'anthropic-eu');
});

test('Ψ-3: 重试路径仍只计一条 meter；meter 自身抛错不影响主路径（不抛铁律）', async () => {
  const records: ProviderMeterRecord[] = [];
  const { fetchImpl, calls } = queue(
    () => httpStatus(429),
    () => ok([{ type: 'text', text: 'ok' }]),
  );
  const p = anth.createAnthropicProvider({ apiKey: 'k', fetchImpl, meter: rec => records.push(rec) });
  const r = await p.chat(req());
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(records.length, 1, '重试不重复计条');

  const broken = anth.createAnthropicProvider({
    apiKey: 'k',
    fetchImpl: (async () => ok([{ type: 'text', text: 'still works' }])) as typeof fetch,
    meter: () => { throw new Error('meter broken'); },
  });
  const r2 = await broken.chat(req());
  assert.equal(r2.ok, true);
  assert.equal(r2.text, 'still works');
});

// ─── Ψ-3h chatJson ───

test('Ψ-3: chatJson —— 强制 jsonMode（追加行）+ 围栏/杂文提取 + raw 恒为原文', async () => {
  const reply = '好的，结果：```json\n{"target": "关闭", "labels": ["确", "定"]}\n``` 请据此执行。';
  const { fetchImpl, calls } = recorder(() => ok([{ type: 'text', text: reply }], { input_tokens: 4, output_tokens: 6 }));
  const p = anth.createAnthropicProvider({ apiKey: 'k', fetchImpl });
  const r = await p.chatJson<{ target: string; labels: string[] }>(req({ prompt: '圈出目标' }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { target: '关闭', labels: ['确', '定'] });
  assert.equal(r.raw, reply);
  assert.equal(calls.length, 1);
  const body = bodyOf(calls[0]!);
  assert.equal(
    body.messages[0].content[body.messages[0].content.length - 1].text,
    '圈出目标\n\n只输出严格 JSON，不要围栏。',
    'chatJson 强制 jsonMode ⇒ prompt 追加约定行',
  );
});

test('Ψ-3: chatJson 提取失败 ⇒ ok:false + raw=原文；传输失败 ⇒ raw 空串', async () => {
  const noJson = '抱歉，当前截图信息不足，无法给出结构化结论。';
  const noJsonP = anth.createAnthropicProvider({
    apiKey: 'k',
    fetchImpl: (async () => ok([{ type: 'text', text: noJson }])) as typeof fetch,
  });
  const r1 = await noJsonP.chatJson(req());
  assert.equal(r1.ok, false);
  assert.equal(r1.value, undefined);
  assert.equal(r1.raw, noJson);
  assert.match(r1.error!, /extraction failed/);

  const badHttp = anth.createAnthropicProvider({
    apiKey: 'k',
    fetchImpl: (async () => httpStatus(400, '{"type":"error","error":{"message":"bad request"}}')) as typeof fetch,
  });
  const r2 = await badHttp.chatJson(req());
  assert.equal(r2.ok, false);
  assert.match(r2.error!, /HTTP 400/);
  assert.equal(r2.raw, '');
});

// ─── Ψ-3i 配置优先级：options > 环境变量 > 内置缺省 ───

test('Ψ-3: 配置优先级 —— env ANTHROPIC_* 生效，options 覆盖 env', async () => {
  process.env.ANTHROPIC_API_KEY = 'env-ant-key';
  process.env.ANTHROPIC_BASE_URL = 'http://localhost:9/anthropic/';
  process.env.ANTHROPIC_MODEL = 'claude-env-model';
  try {
    const { fetchImpl, calls } = recorder(() => ok([{ type: 'text', text: 'env-ok' }]));
    const envP = anth.createAnthropicProvider({ fetchImpl });
    assert.equal(envP.configured, true, 'env key ⇒ 已配置');
    const r = await envP.chat(req());
    assert.equal(r.ok, true);
    assert.equal(r.model, 'claude-env-model');
    assert.equal(calls[0]!.url, 'http://localhost:9/anthropic/v1/messages', 'env baseUrl（含尾斜杠）正确拼接');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], 'env-ant-key');

    const { fetchImpl: f2, calls: c2 } = recorder(() => ok([{ type: 'text', text: 'opt-ok' }]));
    const optP = anth.createAnthropicProvider({
      apiKey: 'opt-key', model: 'claude-opt', baseUrl: 'http://localhost:8', fetchImpl: f2,
    });
    await optP.chat(req());
    assert.equal(c2[0]!.url, 'http://localhost:8/v1/messages');
    const h2 = c2[0]!.init?.headers as Record<string, string>;
    assert.equal(h2['x-api-key'], 'opt-key');
    assert.equal(bodyOf(c2[0]!).model, 'claude-opt');
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_MODEL;
  }
});
