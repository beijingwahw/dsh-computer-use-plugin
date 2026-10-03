// test/vlm.providers.types.test.ts
// 纪元 Ψ（Ψ-1 万脑归一）：统一契约 + 共享原语测试。
// 铁律：绝不真实联网 —— fetchWithRetry 一切 fetch 经注入假实现（可控 Response）；
// 覆盖：导出面契约、类型形状锁（编译期）、JSON 剥壳律矩阵、data URL、
// 密钥卫生律（截断 + 假 key 剔除）、本机基址三态、抖动范围、重试矩阵
// （429 退避成功 / 5xx 耗尽 / 400 不重试 / 超时不重试 / 网络异常耗尽）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  ProviderMeterRecord, ProviderOptions, ProviderProtocol,
  VisionChatRequest, VisionChatResult, VisionImage, VisionProvider,
} from '../src/vlm/providers/types.ts';

// 动态导入被测模块（TS 经 register.mjs 的解析 hook 直跑）
const vpt = await import('../src/vlm/providers/types.ts');

// ─── 编译期形状锁：接口字段一字不差（错字/缺失在此即编译失败，全军团单位的保险栓） ───

const _image: VisionImage = { base64: 'QUJD' };
const _imageMime: VisionImage = { base64: 'QUJD', mime: 'image/png' };
const _req: VisionChatRequest = {
  images: [_image, _imageMime], system: 's', prompt: 'p',
  maxTokens: 1, temperature: 0.1, jsonMode: true, timeoutMs: 1, maxRetries: 0,
};
const _result: VisionChatResult = {
  ok: true, text: 't', json: { a: 1 }, usage: { promptTokens: 1, completionTokens: 2 },
  latencyMs: 3, model: 'm', providerId: 'p', error: undefined, degraded: undefined,
};
const _meter: ProviderMeterRecord = {
  ts: 1, kind: 'provider.chat', providerId: 'p', model: 'm', latencyMs: 1, ok: true,
  promptTokens: 1, completionTokens: 2, error: undefined,
};
const _protocol: ProviderProtocol = 'anthropic';
const _opts: ProviderOptions = {
  id: 'i', apiKey: 'k', baseUrl: 'b', model: 'm',
  fetchImpl: undefined, meter: () => { _meter.ok; }, extraHeaders: { 'X-Extra': '1' },
};
const _provider: VisionProvider = {
  id: 'i', protocol: _protocol, model: 'm', configured: true,
  chat: async (r: VisionChatRequest) => ({ ..._result, text: r.prompt }),
  chatJson: async <T,>(r: VisionChatRequest) => ({ ok: true, value: r.prompt as unknown as T, raw: r.prompt }),
};
void _image; void _imageMime; void _req; void _result; void _meter; void _protocol; void _opts; void _provider;

// ─── 假 fetch 工具：记录调用 + 按序回放可控 Response ───

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

function httpStatus(status: number, body = '{"error":{"message":"boom"}}'): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

const OPTS_TIMEOUT = 500; // 测试统一短超时（假 fetch 立即返回，仅为不挂长定时器）

// ─── Ψ-1a 导出面契约 ───

test('Ψ-1: 导出面契约 —— 六个具名函数、无 default、类型经 import type 可引用', () => {
  assert.deepEqual(
    Object.keys(vpt).sort(),
    ['buildDataUrl', 'extractProviderJson', 'fetchWithRetry', 'isLocalBaseUrl', 'jitterDelayMs', 'sanitizeError'],
  );
  assert.equal((vpt as { default?: unknown }).default, undefined);
});

// ─── Ψ-1b JSON 剥壳律 ───

test('Ψ-1: extractProviderJson —— 围栏/前后杂文/字符串内括号/不平衡/脏值矩阵', () => {
  assert.deepEqual(vpt.extractProviderJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(vpt.extractProviderJson('```json\n[{"x":1},{"x":2}]\n```'), [{ x: 1 }, { x: 2 }]);
  assert.deepEqual(
    vpt.extractProviderJson('好的，分析如下：```json\n{"target":"关闭","labels":["确","定"],"s":"含\\"引号}的文本"}\n``` 请据此执行。'),
    { target: '关闭', labels: ['确', '定'], s: '含"引号}的文本' },
  );
  assert.deepEqual(vpt.extractProviderJson('前置 {"a":{"b":[1,2]}} 后置'), { a: { b: [1, 2] } });
  assert.deepEqual(vpt.extractProviderJson('候选按钮：[{"name":"登录"},{"name":"注册"}] 以上。'), [{ name: '登录' }, { name: '注册' }]);
  assert.deepEqual(vpt.extractProviderJson('{"s":"引号内的 } 与 [ 不破坏平衡"}'), { s: '引号内的 } 与 [ 不破坏平衡' });
  assert.equal(vpt.extractProviderJson('完全不是 JSON'), undefined);
  assert.equal(vpt.extractProviderJson('{"unclosed": 1'), undefined, '不平衡 ⇒ 失败');
  assert.deepEqual(vpt.extractProviderJson('{"json":"伪值"} 残尾 {"real":1}'), { json: '伪值' }, '只取首个平衡片段');
  assert.equal(vpt.extractProviderJson(null as unknown as string), undefined, '脏值安静返回 undefined（不抛铁律）');
});

// ─── Ψ-1c data URL ───

test('Ψ-1: buildDataUrl —— mime 缺省 image/jpeg，显式 mime 透传', () => {
  assert.equal(vpt.buildDataUrl({ base64: 'QUJD' }), 'data:image/jpeg;base64,QUJD');
  assert.equal(vpt.buildDataUrl({ base64: 'QUJD', mime: 'image/png' }), 'data:image/png;base64,QUJD');
  assert.equal(vpt.buildDataUrl({ base64: 'QUJD', mime: '' }), 'data:image/jpeg;base64,QUJD', '空 mime 回退缺省');
  assert.equal(vpt.buildDataUrl({ base64: '' }), 'data:image/jpeg;base64,');
});

// ─── Ψ-1d 密钥卫生律（sanitizeError） ───

test('Ψ-1: sanitizeError —— providerId 前缀 + 正文截 300 字 + 空白折叠', () => {
  const long = '错'.repeat(500);
  const out = vpt.sanitizeError(new Error(long), 'testprov');
  assert.ok(out.startsWith('testprov '), '前缀 `${providerId} ...` 形态');
  assert.equal(out.length, 'testprov '.length + 300, '正文恰截 300 字');
  assert.ok(out.endsWith('错'), '截断保头不保尾');

  const multi = vpt.sanitizeError(new Error('第一行\n\t第二行   有杂空白'), 'p');
  assert.equal(multi, 'p 第一行 第二行 有杂空白');

  assert.equal(vpt.sanitizeError('纯字符串错误', 'p'), 'p 纯字符串错误');
  assert.equal(vpt.sanitizeError(42, 'p'), 'p 42');
  assert.equal(vpt.sanitizeError(null, 'p'), 'p unknown error');
  assert.equal(vpt.sanitizeError(undefined, 'p'), 'p unknown error');
  assert.equal(vpt.sanitizeError(new Error('带码'), 'p'), 'p 带码');
});

test('Ψ-1: sanitizeError —— 密钥卫生律：假 key 无论藏于何处都不出现在输出', () => {
  const FAKE_BEARER_KEY = 'sk-FAKEKEY1234567890xyz';
  const FAKE_QUERY_KEY = 'AIzaSyFAKEQUERYKEY998877665544';
  const FAKE_PROP_KEY = 'ZZZ-PROP-SECRET-9999-8888';
  const FAKE_KV_KEY = 'KV-SECRET-AAAAAAAA';

  // 1) Bearer 头形态（消息内嵌）
  const out1 = vpt.sanitizeError(
    Object.assign(new Error(`401 unauthorized: Bearer ${FAKE_BEARER_KEY} rejected`), { code: 'EPERM' }),
    'openai',
  );
  assert.ok(out1.startsWith('openai '));
  assert.ok(!out1.includes(FAKE_BEARER_KEY), 'Bearer 值必须被剔除');
  assert.ok(!out1.includes('FAKEKEY'), 'key 片段不得残留');
  assert.ok(out1.includes('401'), '非密钥正文保留');
  assert.ok(out1.includes('[REDACTED]'), '剔除处留 [REDACTED] 占位');

  // 2) URL 查询串形态（Gemini ?key= 向量）
  const out2 = vpt.sanitizeError(new Error(`GET https://api.example.com/v1beta?key=${FAKE_QUERY_KEY} failed`), 'gemini');
  assert.ok(!out2.includes(FAKE_QUERY_KEY), '?key= 形态必须被剔除');

  // 3) 无 message 裸对象：属性经 JSON 序列化后仍被剔除
  const out3 = vpt.sanitizeError({ apiKey: FAKE_PROP_KEY }, 'qwen');
  assert.ok(out3.startsWith('qwen '));
  assert.ok(!out3.includes(FAKE_PROP_KEY), '对象属性形态必须被剔除');

  // 4) 有 message 时错误属性根本不进入串化面
  const out4 = vpt.sanitizeError(
    Object.assign(new Error('boom with key inside'), { apiKey: FAKE_KV_KEY }),
    'p',
  );
  assert.ok(!out4.includes(FAKE_KV_KEY));
  assert.ok(out4.includes('boom with key inside'));

  // 5) 键值对明文形态（api_key=...）
  const out5 = vpt.sanitizeError(new Error(`config read: api_key=${FAKE_KV_KEY} loaded`), 'p');
  assert.ok(!out5.includes(FAKE_KV_KEY), '键值对形态必须被剔除');
});

test('Ψ-1: sanitizeError —— 不抛铁律：toString 抛错的毒对象也安静产出', () => {
  const poison = { toString(): string { throw new Error('nope'); } };
  let out = '';
  assert.doesNotThrow(() => { out = vpt.sanitizeError(poison, 'p'); });
  assert.ok(typeof out === 'string' && out.length > 0);
});

// ─── Ψ-1e 本机基址三态 ───

test('Ψ-1: isLocalBaseUrl 三态 —— 回环真 / 远端与仿冒假 / 脏值安静假', () => {
  assert.equal(vpt.isLocalBaseUrl('http://127.0.0.1:8000/v1'), true);
  assert.equal(vpt.isLocalBaseUrl('http://localhost:11434/api'), true);
  assert.equal(vpt.isLocalBaseUrl('http://[::1]:3928/v1'), true);
  assert.equal(vpt.isLocalBaseUrl('https://LOCALHOST:1/'), true, '大小写不敏感');

  assert.equal(vpt.isLocalBaseUrl('https://open.bigmodel.cn/api/paas/v4'), false);
  assert.equal(vpt.isLocalBaseUrl('http://192.168.1.5:8080'), false, '内网非回环不算本机');
  assert.equal(vpt.isLocalBaseUrl('http://localhost.evil.com/'), false, '后缀仿冒不匹配（整 host 比对）');

  assert.equal(vpt.isLocalBaseUrl('not a url at all'), false, '非法串安静 false（不抛）');
  assert.equal(vpt.isLocalBaseUrl(''), false);
});

// ─── Ψ-1f 全抖动退避范围 ───

test('Ψ-1: jitterDelayMs —— uniform(0, min(cap, base·2^attempt)) 范围与钳制', () => {
  const inRange = (got: number, ceiling: number) =>
    Number.isInteger(got) && got >= 0 && got < ceiling;
  for (let i = 0; i < 300; i++) assert.ok(inRange(vpt.jitterDelayMs(0), 500), `attempt 0 ∈ [0,500)`);
  for (let i = 0; i < 300; i++) assert.ok(inRange(vpt.jitterDelayMs(1), 1000), `attempt 1 ∈ [0,1000)`);
  for (let i = 0; i < 300; i++) assert.ok(inRange(vpt.jitterDelayMs(4), 8000), `attempt 4 ∈ [0,8000)（500·2^4 恰触顶）`);
  for (let i = 0; i < 300; i++) assert.ok(inRange(vpt.jitterDelayMs(20), 8000), `attempt 20 封顶 8000`);
  for (let i = 0; i < 300; i++) assert.ok(inRange(vpt.jitterDelayMs(0, 100, 150), 100), `自定义 base ∈ [0,100)`);
  for (let i = 0; i < 300; i++) assert.ok(inRange(vpt.jitterDelayMs(5, 100, 150), 150), `自定义 cap ∈ [0,150)`);
  // 脏值钳制：负 attempt / NaN / 非法 base、cap 回退缺省 —— 均产出安全整数
  for (let i = 0; i < 50; i++) {
    assert.ok(inRange(vpt.jitterDelayMs(-5), 500), '负 attempt 按安全域处理');
    assert.ok(inRange(vpt.jitterDelayMs(Number.NaN), 500), 'NaN attempt 按安全域处理');
    assert.ok(inRange(vpt.jitterDelayMs(1, -1, -1), 1000), '非法 base/cap 回退 500/8000');
  }
});

// ─── Ψ-1g 重试矩阵（fetchWithRetry —— 全适配器共享传输底座） ───

test('Ψ-1: fetchWithRetry —— 429 两次后 200：全抖动退避重试成功 + onRetry 全程播报', async () => {
  const retries: Array<{ attempt: number; reason: string }> = [];
  const { fetchImpl, calls } = queue(
    () => httpStatus(429, '{"error":{"message":"rate limited"}}'),
    () => httpStatus(429),
    () => new Response('recovered', { status: 200 }),
  );
  const r = await vpt.fetchWithRetry({
    doFetch: fetchImpl, url: 'http://local.test/v1/chat',
    init: { method: 'POST', headers: { 'X-Test': '1' } },
    maxRetries: 2, timeoutMs: OPTS_TIMEOUT,
    onRetry: (attempt, reason) => { retries.push({ attempt, reason }); throw new Error('onRetry broken'); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.body, 'recovered');
  assert.equal(r.attempts, 3, '1 次首发 + 2 次重试');
  assert.equal(r.error, undefined);
  assert.equal(calls.length, 3);
  assert.deepEqual(retries, [
    { attempt: 0, reason: 'http 429' },
    { attempt: 1, reason: 'http 429' },
  ], 'onRetry 每次重试前恰好播报一次（回调抛错不影响主路径）');

  // init 透传 + 超时信号注入（timeoutMs 归 fetchWithRetry 管）
  assert.equal(calls[0]!.init?.method, 'POST');
  assert.equal((calls[0]!.init?.headers as Record<string, string>)['X-Test'], '1');
  assert.ok(calls[0]!.init?.signal, '每次尝试注入独立 AbortSignal');
});

test('Ψ-1: fetchWithRetry —— 5xx 可重试；耗尽 ⇒ ok:false + status/body/attempts 汇总', async () => {
  const { fetchImpl, calls } = queue(() => httpStatus(503, 'service unavailable'));
  const r = await vpt.fetchWithRetry({
    doFetch: fetchImpl, url: 'http://local.test/v1', init: {}, maxRetries: 2, timeoutMs: OPTS_TIMEOUT,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.equal(r.body, 'service unavailable');
  assert.match(r.error!, /http 503 after 3 attempts/);
  assert.equal(r.attempts, 3);
  assert.equal(calls.length, 3, 'maxRetries=2 ⇒ 至多 3 次');
});

test('Ψ-1: fetchWithRetry —— 400 不可重试：请求有病重试无义，立即失败', async () => {
  const retries: unknown[] = [];
  const { fetchImpl, calls } = queue(() => httpStatus(400, '{"error":"bad request"}'));
  const r = await vpt.fetchWithRetry({
    doFetch: fetchImpl, url: 'http://local.test/v1', init: {}, maxRetries: 2, timeoutMs: OPTS_TIMEOUT,
    onRetry: (...a) => { retries.push(a); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.body, '{"error":"bad request"}');
  assert.match(r.error!, /http 400 after 1 attempt/);
  assert.equal(r.attempts, 1);
  assert.equal(calls.length, 1, '4xx 不进重试环');
  assert.equal(retries.length, 0, '无重试即无播报');
});

test('Ψ-1: fetchWithRetry —— 超时（TimeoutError）不重试：调用方主动止损', async () => {
  const timeoutErr = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
  const { fetchImpl, calls } = recorder(() => Promise.reject(timeoutErr));
  const r = await vpt.fetchWithRetry({
    doFetch: fetchImpl, url: 'http://local.test/v1', init: {}, maxRetries: 5, timeoutMs: OPTS_TIMEOUT,
  });
  assert.equal(r.ok, false);
  assert.match(r.error!, /aborted after 500ms/);
  assert.equal(r.status, undefined, '传输层失败无 HTTP 状态');
  assert.equal(r.attempts, 1);
  assert.equal(calls.length, 1, '超时不进重试环');
});

test('Ψ-1: fetchWithRetry —— 网络异常可重试；耗尽 ⇒ fetch failed 汇总', async () => {
  const { fetchImpl, calls } = recorder(() =>
    Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })));
  const retries: Array<{ attempt: number; reason: string }> = [];
  const r = await vpt.fetchWithRetry({
    doFetch: fetchImpl, url: 'http://local.test/v1', init: {}, maxRetries: 2, timeoutMs: OPTS_TIMEOUT,
    onRetry: (attempt, reason) => { retries.push({ attempt, reason }); },
  });
  assert.equal(r.ok, false);
  assert.match(r.error!, /fetch failed after 3 attempts/);
  assert.ok(r.error!.includes('ECONNRESET'), '网络错误 code 归因保留');
  assert.equal(r.status, undefined);
  assert.equal(r.attempts, 3);
  assert.equal(calls.length, 3, '网络异常重试至耗尽');
  assert.equal(retries.length, 2);
  assert.match(retries[0]!.reason, /^network:/);
});

test('Ψ-1: fetchWithRetry —— 首发 200 直达；doFetch 缺失安静失败（不抛铁律）', async () => {
  const { fetchImpl, calls } = recorder(() => new Response('first try', { status: 200 }));
  const r = await vpt.fetchWithRetry({
    doFetch: fetchImpl, url: 'http://local.test/v1', init: {}, maxRetries: 3, timeoutMs: OPTS_TIMEOUT,
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.equal(calls.length, 1);

  const bad = await vpt.fetchWithRetry({
    doFetch: undefined as unknown as typeof fetch, url: 'http://local.test/v1', init: {}, maxRetries: 3, timeoutMs: OPTS_TIMEOUT,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.attempts, 0);
  assert.match(bad.error!, /not available/);
});
