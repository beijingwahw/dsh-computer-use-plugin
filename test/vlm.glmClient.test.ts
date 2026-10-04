// test/vlm.glmClient.test.ts
// 纪元 Ω（Ω-1 云脑皮层）：GLM-5.3-Flash 客户端契约测试。
// 铁律：绝不真实联网 —— 一切 fetch 经 fetchImpl 注入假实现（可控 Response）；
// 覆盖：degraded 降级、成功文本路径、请求形态、JSON 围栏/杂文提取、
// 429 退避重试、超时不重试、meter 遥测、单例 reset 与配置优先级。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import type {
  GlmClientOptions, GlmMeterRecord, GlmVisionRequest,
} from '../src/vlm/glmClient.ts';

// 动态导入被测模块（TS 经 register.mjs 的解析 hook 直跑）
const glm = await import('../src/vlm/glmClient.ts');

// ─── 环境隔离：抹掉可能存在的真实 key，退出时原样恢复 ───
// Ψ 纪元：isGlmConfigured / getGlmClient 缺省铸造会经 detectPresetFromEnv 探测
// 全平台 env —— 宿主环境里任一他平台 key 都会翻转 isGlmConfigured 断言，
// 故隔离面须覆盖全部平台 envKeys（与 registry 声明同步），而非仅 GLM 三别名。
const ENV_KEYS = [
  'GLM_API_KEY', 'ZHIPUAI_API_KEY', 'ZAI_API_KEY', 'GLM_BASE_URL', 'GLM_VLM_MODEL',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'DASHSCOPE_API_KEY', 'ALIYUN_API_KEY', 'MOONSHOT_API_KEY', 'ARK_API_KEY',
  'VOLCENGINE_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY', 'SILICONFLOW_API_KEY',
  'OPENROUTER_API_KEY',
] as const;
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
  glm.resetGlmClient();
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
function req(overrides: Partial<GlmVisionRequest> = {}): GlmVisionRequest {
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

// ─── Ω-1a 降级臂：未配置 apiKey ───

test('Ω-1: 未配置 apiKey ⇒ chat 返回 degraded（ok:false + error，不触网）', async () => {
  const { fetchImpl, calls } = recorder(() => chatOk('never'));
  const client = new glm.GlmClient({ fetchImpl }); // env 已清空 ⇒ 无 key
  assert.equal(client.configured, false);
  const r = await client.chat(req());
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.equal(r.text, '');
  assert.match(r.error!, /not configured/);
  assert.equal(r.model, 'glm-5.3-flash', '模型名缺省 glm-5.3-flash');
  assert.equal(r.latencyMs >= 0, true);
  assert.equal(calls.length, 0, '降级臂绝不发请求');
});

// ─── Ω-1b 成功文本路径 + 请求形态 ───

test('Ω-1: 成功文本路径 —— content/usage/latency + URL/鉴权/body 形态', async () => {
  const { fetchImpl, calls } = recorder(() => chatOk('屏幕上有一个登录按钮', { prompt_tokens: 11, completion_tokens: 7 }));
  const client = new glm.GlmClient({ apiKey: 'sk-test', fetchImpl });
  assert.equal(client.configured, true);
  const r = await client.chat(req({
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
  assert.ok(call.url.endsWith('/chat/completions'), `url 应指向 chat/completions：${call.url}`);
  assert.ok(call.url.startsWith('https://open.bigmodel.cn/api/paas/v4'), '缺省 baseUrl');
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer sk-test');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.ok(call.init?.signal, '必须携带 AbortSignal（超时止损）');

  const body = bodyOf(call);
  assert.equal(body.model, 'glm-5.3-flash');
  assert.equal(body.max_tokens, 128);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.response_format, undefined, '非 jsonMode 不下发 response_format');
  assert.equal(body.messages.length, 2, 'system + user');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, '你是桌面自动化助手');
  const user = body.messages[1];
  assert.equal(user.role, 'user');
  assert.equal(user.content[0].type, 'text');
  assert.equal(user.content[0].text, '描述这张截图');
  assert.equal(user.content[1].type, 'image_url');
  assert.equal(user.content[1].image_url.url, 'data:image/png;base64,QUJD');
});

test('Ω-1: mime 缺省 image/jpeg；无 system 则只有 user 消息；空图片数组 = 纯文本', async () => {
  const { fetchImpl, calls } = recorder(() => chatOk('ok'));
  const client = new glm.GlmClient({ apiKey: 'k', fetchImpl });
  await client.chat(req({ images: [{ base64: 'AAAA' }] }));
  let body = bodyOf(calls[0]!);
  assert.equal(body.messages.length, 1, '无 system ⇒ 仅 user');
  assert.equal(body.messages[0].content[1].image_url.url, 'data:image/jpeg;base64,AAAA', 'mime 缺省 image/jpeg');
  assert.equal(body.messages[0].content.length, 2);

  await client.chat(req({ images: [] }));
  body = bodyOf(calls[1]!);
  assert.equal(body.messages[0].content.length, 1, '空图片 ⇒ 仅 text part');
});

// ─── Ω-1c JSON 提取（jsonMode / chatJson） ───

test('Ω-1: jsonMode —— response_format 下发 + ```json 围栏解析', async () => {
  const { fetchImpl, calls } = recorder(() => chatOk('```json\n{"verdict": "click", "x": 0.5, "y": 0.25}\n```'));
  const client = new glm.GlmClient({ apiKey: 'k', fetchImpl });
  const r = await client.chat(req({ jsonMode: true }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.json, { verdict: 'click', x: 0.5, y: 0.25 });
  assert.equal(bodyOf(calls[0]!).response_format.type, 'json_object');
});

test('Ω-1: chatJson 围栏 + 前后杂文 —— 剥围栏后取首个平衡 {...}', async () => {
  const reply = '好的，分析结果如下：```json\n{"target": "关闭", "labels": ["确", "定"], "s": "含\\"引号}的文本"}\n``` 请据此执行。';
  const { fetchImpl, calls } = recorder(() => chatOk(reply));
  const client = new glm.GlmClient({ apiKey: 'k', fetchImpl });
  const r = await client.chatJson<{ target: string; labels: string[] }>(req());
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { target: '关闭', labels: ['确', '定'], s: '含"引号}的文本' });
  assert.equal(r.raw, reply, 'raw 恒为回复原文');
  assert.equal(calls.length, 1);
  assert.equal(bodyOf(calls[0]!).response_format.type, 'json_object', 'chatJson 强制 jsonMode');
});

test('Ω-1: chatJson 前后杂文无围栏 —— 首个平衡数组也认', async () => {
  const { fetchImpl } = recorder(() => chatOk('候选按钮：[{"name": "登录"}, {"name": "注册"}] 以上。'));
  const client = new glm.GlmClient({ apiKey: 'k', fetchImpl });
  const r = await client.chatJson<{ name: string }[]>(req());
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, [{ name: '登录' }, { name: '注册' }]);
});

test('Ω-1: chatJson 提取失败 ⇒ ok:false + raw=原文', async () => {
  const reply = '抱歉，当前截图信息不足，无法给出结构化结论。';
  const { fetchImpl } = recorder(() => chatOk(reply));
  const client = new glm.GlmClient({ apiKey: 'k', fetchImpl });
  const r = await client.chatJson(req());
  assert.equal(r.ok, false);
  assert.equal(r.value, undefined);
  assert.equal(r.raw, reply);
  assert.match(r.error!, /extraction failed/);
});

test('Ω-1: chatJson 传输失败 ⇒ ok:false + error 透传 + raw 空串', async () => {
  const { fetchImpl } = queue(() => httpStatus(400, '{"error":"bad request"}'));
  const client = new glm.GlmClient({ apiKey: 'k', fetchImpl });
  const r = await client.chatJson(req());
  assert.equal(r.ok, false);
  assert.match(r.error!, /HTTP 400/);
  assert.equal(r.raw, '');
});

// ─── Ω-1d 重试矩阵 ───

test('Ω-1: 429 两次后第三次 200 —— 全抖动退避重试成功', async () => {
  const { fetchImpl, calls } = queue(
    () => httpStatus(429, '{"error":{"message":"rate limited"}}'),
    () => httpStatus(429),
    () => chatOk('第二次重试成功', { prompt_tokens: 3, completion_tokens: 5 }),
  );
  const client = new glm.GlmClient({ apiKey: 'k', fetchImpl });
  const r = await client.chat(req());
  assert.equal(r.ok, true);
  assert.equal(r.text, '第二次重试成功');
  assert.deepEqual(r.usage, { promptTokens: 3, completionTokens: 5 });
  assert.equal(calls.length, 3, '1 次首发 + 2 次重试');
});

test('Ω-1: 5xx 可重试；重试耗尽 ⇒ ok:false 且 error 标注尝试次数', async () => {
  const { fetchImpl, calls } = queue(() => httpStatus(503, 'service unavailable'));
  const client = new glm.GlmClient({ apiKey: 'k', fetchImpl });
  const r = await client.chat(req());
  assert.equal(r.ok, false);
  assert.match(r.error!, /HTTP 503 after 3 attempts/);
  assert.equal(calls.length, 3, 'maxRetries=2 ⇒ 至多 3 次');
});

test('Ω-1: 400 不可重试 —— 请求有病重试无义，立即失败', async () => {
  const { fetchImpl, calls } = queue(() => httpStatus(400));
  const client = new glm.GlmClient({ apiKey: 'k', fetchImpl });
  const r = await client.chat(req());
  assert.equal(r.ok, false);
  assert.match(r.error!, /HTTP 400/);
  assert.doesNotMatch(r.error!, /after 3 attempts/);
  assert.equal(calls.length, 1);
});

test('Ω-1: 超时（AbortError）不重试 —— 调用方主动止损', async () => {
  const timeoutErr = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
  const { fetchImpl, calls } = recorder(() => Promise.reject(timeoutErr));
  const client = new glm.GlmClient({ apiKey: 'k', fetchImpl });
  const r = await client.chat(req({ maxRetries: 5 }));
  assert.equal(r.ok, false);
  assert.match(r.error!, /aborted after 500ms/);
  assert.equal(calls.length, 1, '超时不进重试环');
});

test('Ω-1: 网络错误可重试 —— 抖动后恢复成功', async () => {
  let n = 0;
  const { fetchImpl, calls } = recorder(() => {
    n++;
    if (n === 1) return Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }));
    return Promise.resolve(chatOk('网络恢复了'));
  });
  const client = new glm.GlmClient({ apiKey: 'k', fetchImpl });
  const r = await client.chat(req());
  assert.equal(r.ok, true);
  assert.equal(r.text, '网络恢复了');
  assert.equal(calls.length, 2);
});

test('Ω-1: 响应缺 choices/message.content ⇒ 诚实失败不抛', async () => {
  const { fetchImpl } = recorder(() => new Response('{"id":"x"}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const client = new glm.GlmClient({ apiKey: 'k', fetchImpl });
  const r = await client.chat(req());
  assert.equal(r.ok, false);
  assert.match(r.error!, /missing choices/);
});

// ─── Ω-1e meter 遥测 ───

test('Ω-1: meter 恰好每次调用一条 —— 成功带 usage、失败带 error', async () => {
  const records: GlmMeterRecord[] = [];
  const opts = (fetchImpl: typeof fetch): GlmClientOptions => ({
    apiKey: 'k', fetchImpl, meter: rec => records.push(rec),
  });
  const okClient = new glm.GlmClient(opts((async () => chatOk('hi', { prompt_tokens: 9, completion_tokens: 2 })) as typeof fetch));
  await okClient.chat(req());

  const degradedClient = new glm.GlmClient({ meter: rec => records.push(rec) });
  await degradedClient.chat(req());

  assert.equal(records.length, 2, '一次 chat 一条记录（重试不重复计）');
  const [okRec, badRec] = records;
  assert.equal(okRec.kind, 'glm.chat');
  assert.equal(okRec.ok, true);
  assert.equal(okRec.model, 'glm-5.3-flash');
  assert.equal(okRec.promptTokens, 9);
  assert.equal(okRec.completionTokens, 2);
  assert.ok(okRec.latencyMs >= 0 && okRec.ts > 0);
  assert.equal(okRec.error, undefined);

  assert.equal(badRec.ok, false);
  assert.match(badRec.error!, /not configured/);
  assert.equal(badRec.promptTokens, undefined);
});

test('Ω-1: meter 自身抛错不影响主路径（不抛铁律）', async () => {
  const { fetchImpl } = recorder(() => chatOk('still works'));
  const client = new glm.GlmClient({ apiKey: 'k', fetchImpl, meter: () => { throw new Error('meter broken'); } });
  const r = await client.chat(req());
  assert.equal(r.ok, true);
  assert.equal(r.text, 'still works');
});

// ─── Ω-1f 单例与配置解析 ───

test('Ω-1: 单例 —— options 仅首次生效，reset 后重建，isGlmConfigured 正确探测', () => {
  glm.resetGlmClient();
  const a = glm.getGlmClient({ apiKey: 'first' });
  const b = glm.getGlmClient({ apiKey: 'second' });
  assert.equal(a, b, '单例：二次 options 被忽略');
  assert.equal(b.configured, true);

  glm.resetGlmClient();
  assert.equal(glm.isGlmConfigured(), false, 'env 已清空 + 已 reset ⇒ 未配置');
  const c = glm.getGlmClient({ apiKey: 'third' });
  assert.notEqual(c, a);
  assert.equal(glm.isGlmConfigured(), true);
  glm.resetGlmClient();
});

test('Ω-1: 配置优先级 options > 环境变量；env 键三别名与 baseUrl/model 变量', async () => {
  process.env.ZHIPUAI_API_KEY = 'env-zhipu';
  process.env.GLM_BASE_URL = 'http://localhost:9/api/paas/v4/';
  process.env.GLM_VLM_MODEL = 'glm-env-model';
  try {
    // env 生效（带尾斜杠的 baseUrl 也要正确拼接）
    const { fetchImpl, calls } = recorder(() => chatOk('env-ok'));
    const envClient = new glm.GlmClient({ fetchImpl });
    assert.equal(envClient.configured, true);
    const r = await envClient.chat(req());
    assert.equal(r.ok, true);
    assert.equal(r.model, 'glm-env-model');
    assert.equal(calls[0]!.url, 'http://localhost:9/api/paas/v4/chat/completions');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer env-zhipu');

    // options 覆盖 env
    const { fetchImpl: f2, calls: c2 } = recorder(() => chatOk('opt-ok'));
    const optClient = new glm.GlmClient({ apiKey: 'opt-key', model: 'glm-opt', baseUrl: 'http://localhost:8/v4', fetchImpl: f2 });
    await optClient.chat(req());
    assert.equal(c2[0]!.url, 'http://localhost:8/v4/chat/completions');
    const h2 = c2[0]!.init?.headers as Record<string, string>;
    assert.equal(h2.Authorization, 'Bearer opt-key');
    assert.equal(bodyOf(c2[0]!).model, 'glm-opt');
  } finally {
    delete process.env.ZHIPUAI_API_KEY;
    delete process.env.GLM_BASE_URL;
    delete process.env.GLM_VLM_MODEL;
    glm.resetGlmClient();
  }
});

test('Ω-1: extractGlmJson —— 围栏/杂文/字符串内括号/无 JSON 的提取矩阵', () => {
  assert.deepEqual(glm.extractGlmJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(glm.extractGlmJson('前置 {"a":{"b":[1,2]}} 后置'), { a: { b: [1, 2] } });
  assert.deepEqual(glm.extractGlmJson('{"s":"引号内的 } 与 [ 不破坏平衡"}'), { s: '引号内的 } 与 [ 不破坏平衡' });
  assert.deepEqual(glm.extractGlmJson('```json\n[{"x":1},{"x":2}]\n```'), [{ x: 1 }, { x: 2 }]);
  assert.equal(glm.extractGlmJson('完全不是 JSON'), undefined);
  assert.equal(glm.extractGlmJson('{"unclosed": 1'), undefined, '不平衡 ⇒ 失败');
  // W6R-A4（工具去重）：统一 internalUtils.extractBalancedJson 的不抛铁律 ——
  // 脏值（null/undefined/非字符串）安静返回 undefined（原实现此处会抛 TypeError）
  assert.equal(glm.extractGlmJson(null as unknown as string), undefined, '脏值安静返回 undefined（不抛铁律）');
  assert.equal(glm.extractGlmJson(undefined as unknown as string), undefined);
});
