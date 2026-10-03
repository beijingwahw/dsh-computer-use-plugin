// test/vlm.onboarding.test.ts
// 纪元 Λ（Λ-2 开箱即亮）：连接向导 HTTP 服务器与页面契约测试。
// 铁律：绝不真实联网 —— /api/test 与 /api/models 的上游全部经 deps.fetchImpl
// 注入假实现；向导服务本身用 node:http 客户端真打环回（路由面真测）。
// 覆盖：页面渲染（标题/13 平台名/当前生效区/纯函数性）、/api/state 形状与
// configured 的 env 控制法、/api/test 成功与非法平台 400（含工厂装配线：URL/
// Bearer/模型缺省与覆盖）、/api/models 成功/失败/400、/api/connect 存档落临时
// 路径 + onConnect 收到 via:'wizard' + 回调抛错 ⇒ ok:false 但存档已写、
// /api/disconnect、密钥永不回显（响应面零明文 key）、端口占用 +1 回退与九口
// 全占 reject、idle 自动关与请求重置、close 幂等与端口释放、405/404/OPTIONS
// 204/坏 JSON 400、32KB 超限 413。每个用例 finally close。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { OnboardingHandle, WizardState } from '../src/vlm/onboarding.ts';
import type { VisionConnection } from '../src/vlm/connection.ts';

const { startOnboarding, renderOnboardingHtml } = await import('../src/vlm/onboarding.ts');
const { ConnectionStore } = await import('../src/vlm/connection.ts');
const { PLATFORM_PRESETS } = await import('../src/vlm/providers/registry.ts');

// ─── HTTP 客户端（node:http 真打环回） ───

interface HttpResult { status: number; body: string; headers: Record<string, string | string[] | undefined> }

function httpReq(port: number, method: string, path: string, body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers:
          body === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function getJson(port: number, path: string): Promise<{ status: number; json: any }> {
  const r = await httpReq(port, 'GET', path);
  return { status: r.status, json: JSON.parse(r.body) };
}

async function postJson(port: number, path: string, payload: unknown): Promise<{ status: number; json: any }> {
  const r = await httpReq(port, 'POST', path, JSON.stringify(payload));
  return { status: r.status, json: JSON.parse(r.body) };
}

/** 兜底关停（每个用例 finally 调；已关/未启动皆安静） */
async function closeHandle(h: OnboardingHandle | null): Promise<void> {
  if (!h) return;
  try {
    await h.close();
  } catch { /* 不抛铁律：关停失败不掩盖主断言 */ }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// ─── 假 fetch（上游出口；记录调用 + 可控 Response，沿 probe.test 先例） ───

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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** openai 方言的成功 chat 响应（choices[0].message.content） */
function chatOk(content: string): Response {
  return jsonResponse(200, { choices: [{ message: { role: 'assistant', content } }] });
}

/** 头表小写化（Authorization/authorization 等大小写归一比对） */
function headersOf(call: FetchCall): Record<string, string> {
  const h = (call.init?.headers ?? {}) as Record<string, string>;
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

function bodyOf(call: FetchCall): any {
  return JSON.parse(String(call.init?.body));
}

// ─── env 控制法（configured 判定注入）：清空并随后恢复全部预设触及的 env ───

function allPresetEnvNames(): string[] {
  const names = new Set<string>();
  for (const p of PLATFORM_PRESETS) for (const n of p.envKeys) names.add(n);
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

// ─── 临时档位 ───

function tempStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'dsh-onboard-')), 'vlm-connection.json');
}

function rmTemp(path: string): void {
  try {
    rmSync(dirname(path), { recursive: true, force: true });
  } catch { /* best-effort */ }
}

// ─── ① 页面：GET / 含标题与 13 平台名；renderOnboardingHtml 纯函数性 ───

test('Λ-2: GET / —— 向导页含标题「连接视觉模型」与全部 13 平台名，text/html 编码 utf-8', async () => {
  let h: OnboardingHandle | null = null;
  const storePath = tempStorePath();
  try {
    h = await startOnboarding({ port: 0, deps: { store: new ConnectionStore(storePath) } });
    const r = await httpReq(h.port, 'GET', '/');
    assert.equal(r.status, 200);
    assert.match(String(r.headers['content-type']), /text\/html/);
    assert.match(String(r.headers['content-type']), /charset=utf-8/i);
    assert.match(r.body, /<!DOCTYPE html>/);
    assert.ok(r.body.includes('连接视觉模型'), '页面标题');
    assert.ok(r.body.includes('尚未连接——选择一个平台开始'), '空连接时的当前生效区文案');
    for (const p of PLATFORM_PRESETS) {
      assert.ok(r.body.includes(p.label), `页面须含平台名：${p.label}`);
    }
    assert.equal(PLATFORM_PRESETS.length, 13, 'registry 须为 13 平台（页面投影基数）');
    // 无外链铁律：纯内嵌单文件
    assert.doesNotMatch(r.body, /src=["']https?:\/\//i, '不得外链脚本');
    assert.doesNotMatch(r.body, /href=["']https?:\/\//i, '不得外链样式');
  } finally {
    await closeHandle(h);
    rmTemp(storePath);
  }
});

test('Λ-2: renderOnboardingHtml 纯函数 —— 已连接态渲染平台名/来源/打码密钥；空态渲染提示语', () => {
  const empty = renderOnboardingHtml({ current: '', connectedVia: null, maskedKey: null, platforms: [] });
  assert.ok(empty.includes('连接视觉模型'));
  assert.ok(empty.includes('尚未连接——选择一个平台开始'));
  const live: WizardState = {
    current: 'glm',
    connectedVia: 'wizard',
    maskedKey: 'sk-w…defg',
    platforms: [{ id: 'glm', label: '智谱 GLM', protocol: 'openai', local: false, configured: true }],
  };
  const html = renderOnboardingHtml(live);
  assert.ok(html.includes('智谱 GLM'));
  assert.ok(html.includes('wizard'));
  assert.ok(html.includes('sk-w…defg'), '打码密钥渲染进当前生效区');
  // 纯函数性：同状态两次渲染字节一致
  assert.equal(renderOnboardingHtml(live), html);
  // 状态嵌入消毒：label 含 </script> 不得逃出脚本沙箱
  const tricky = renderOnboardingHtml({
    current: '', connectedVia: null, maskedKey: null,
    platforms: [{ id: 'x', label: '</script><b>pwn</b>', protocol: 'openai', local: false, configured: false }],
  });
  assert.ok(tricky.includes('&lt;/script&gt;'), '卡片面 HTML 转义');
  assert.ok(!/<\/script><b>pwn/.test(tricky), '嵌入 JSON 不得产生裸 </script>');
});

// ─── ② /api/state 形状 + configured 的 env 控制法 ───

test('Λ-2: /api/state —— 形状契约（current/connectedVia/maskedKey/platforms×13）与 configured 判定', async () => {
  let h: OnboardingHandle | null = null;
  const storePath = tempStorePath();
  try {
    h = await startOnboarding({ port: 0, deps: { store: new ConnectionStore(storePath) } });
    await withClearedEnv(async () => {
      // 清空全部 env：current 空；本地三平台 configured（localAuthOptional），云端全未配置
      const cleared = await getJson(h!.port, '/api/state');
      assert.equal(cleared.status, 200);
      const s = cleared.json;
      assert.equal(s.current, '');
      assert.equal(s.connectedVia, null);
      assert.equal(s.maskedKey, null);
      assert.equal(s.platforms.length, 13);
      assert.deepEqual(
        s.platforms.map((p: any) => p.id),
        PLATFORM_PRESETS.map(p => p.id),
        'platforms 与 registry 声明同序同员',
      );
      for (const p of s.platforms) {
        assert.ok(typeof p.id === 'string' && p.id !== '');
        assert.ok(typeof p.label === 'string' && p.label !== '');
        assert.ok(['openai', 'anthropic', 'gemini'].includes(p.protocol));
        assert.equal(typeof p.local, 'boolean');
        assert.equal(typeof p.configured, 'boolean');
      }
      assert.deepEqual(
        s.platforms.filter((p: any) => p.local).map((p: any) => p.id).sort(),
        ['lmstudio', 'ollama', 'vllm'],
      );
      for (const p of s.platforms) {
        assert.equal(p.configured, p.local, '清空 env 后：本地免密恒就绪，云端恒未配置');
      }
      // 注入 env：仅 GLM 就绪（envKeys 任一非空 ⇒ configured）
      process.env.GLM_API_KEY = 'sk-env-configured-1234567890';
      const after = (await getJson(h!.port, '/api/state')).json;
      const glm = after.platforms.find((p: any) => p.id === 'glm');
      const openai = after.platforms.find((p: any) => p.id === 'openai');
      assert.equal(glm.configured, true, 'GLM_API_KEY 注入 ⇒ glm configured');
      assert.equal(openai.configured, false, '其余云端仍缺 key');
      assert.equal(after.current, '', '未 connect 前 current 仍空（env 就绪 ≠ 已连接）');
    });
  } finally {
    await closeHandle(h);
    rmTemp(storePath);
  }
});

// ─── ③ /api/test：成功（假 fetch）+ 工厂装配线 + 非法平台 400 ───

test('Λ-2: /api/test 成功 —— 预设装配（缺省基址/模型 + Bearer）与探针回执；非法平台 400', async () => {
  let h: OnboardingHandle | null = null;
  try {
    const { fetchImpl, calls } = recorder(() => chatOk('ok'));
    h = await startOnboarding({ port: 0, deps: { fetchImpl } });
    const KEY = 'sk-wizard-probe-1234567890';
    const r = await postJson(h.port, '/api/test', { platform: 'glm', api_key: KEY });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.probe.ok, true);
    assert.equal(r.json.probe.id, 'glm');
    assert.equal(r.json.probe.visionGuessed, true);
    assert.match(r.json.probe.detail, /通了/);
    assert.equal(typeof r.json.probe.latencyMs, 'number');
    // 工厂装配线：glm 预设 openai 方言 ⇒ 缺省基址 /chat/completions + Bearer + 缺省模型
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
    assert.equal(headersOf(calls[0]!).authorization, `Bearer ${KEY}`);
    assert.equal(bodyOf(calls[0]!).model, 'glm-5.3-flash');
    assert.ok(bodyOf(calls[0]!).messages, 'chat 请求形状');
    // 覆盖线：base_url/model 覆盖预设
    const r2 = await postJson(h.port, '/api/test', {
      platform: 'openai', api_key: KEY, base_url: 'http://127.0.0.1:9/v1', model: 'gpt-4o',
    });
    assert.equal(r2.json.probe.ok, true);
    assert.equal(calls[1]!.url, 'http://127.0.0.1:9/v1/chat/completions');
    assert.equal(bodyOf(calls[1]!).model, 'gpt-4o');
    // 非法平台 ⇒ 400
    const bad = await postJson(h.port, '/api/test', { platform: 'nonexistent', api_key: 'x' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.ok, false);
    // 非法平台零上游请求
    assert.equal(calls.length, 2);
  } finally {
    await closeHandle(h);
  }
});

// ─── ④ /api/models：成功（假 fetch）+ 失败空表 + 非法平台 400 ───

test('Λ-2: /api/models —— 发现成功填列表（URL/鉴权头）、失败 {ok:false,models:[]}、非法平台 400', async () => {
  let h: OnboardingHandle | null = null;
  try {
    const { fetchImpl, calls } = recorder((_c, n) =>
      n <= 2
        ? jsonResponse(200, { data: [{ id: 'glm-5.3', owned_by: 'zhipu' }, { id: 'glm-5.3-flash', owned_by: 'zhipu' }] })
        : jsonResponse(500, { error: 'boom' }),
    );
    h = await startOnboarding({ port: 0, deps: { fetchImpl } });
    const KEY = 'sk-wizard-models-123456789';
    // 成功：缺省基址 + Bearer + {base}/models
    const ok = await getJson(h.port, `/api/models?platform=glm&api_key=${encodeURIComponent(KEY)}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.models.length, 2);
    assert.equal(ok.json.models[0].id, 'glm-5.3');
    assert.equal(ok.json.models[0].ownedBy, 'zhipu');
    assert.equal(calls[0]!.url, 'https://open.bigmodel.cn/api/paas/v4/models');
    assert.equal(headersOf(calls[0]!).authorization, `Bearer ${KEY}`);
    // base_url 覆盖线
    const ok2 = await getJson(h.port, `/api/models?platform=ollama&base_url=${encodeURIComponent('http://127.0.0.1:4321/v1')}`);
    assert.equal(ok2.json.ok, true);
    assert.equal(calls[1]!.url, 'http://127.0.0.1:4321/v1/models');
    assert.equal(headersOf(calls[1]!).authorization, undefined, '本地无 key ⇒ 免鉴权头');
    // 失败 ⇒ {ok:false, models:[]}（协议已知 ⇒ 单方言一次尝试，零重试）
    const fail = await getJson(h.port, `/api/models?platform=glm&api_key=${encodeURIComponent(KEY)}`);
    assert.equal(fail.status, 200);
    assert.equal(fail.json.ok, false);
    assert.deepEqual(fail.json.models, []);
    assert.ok(fail.json.error, '失败附原因');
    assert.equal(calls.length, 3, 'glm 协议已知（openai）⇒ 失败不换方言重试');
    // 非法平台 ⇒ 400
    const bad = await getJson(h.port, '/api/models?platform=nope');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.ok, false);
    assert.deepEqual(bad.json.models, []);
  } finally {
    await closeHandle(h);
  }
});

// ─── ⑤ /api/connect：存档落临时路径 + onConnect 收到 via:'wizard'；回调抛错 ⇒ ok:false 但存档在 ───

test('Λ-2: /api/connect 成功 —— 存档（via wizard）+ 热应用回调收到完整连接 + 打码回执', async () => {
  let h: OnboardingHandle | null = null;
  const storePath = tempStorePath();
  const RAW = 'sk-wizard-secret-2468abcdef';
  try {
    const store = new ConnectionStore(storePath);
    const seen: VisionConnection[] = [];
    h = await startOnboarding({ port: 0, deps: { store, onConnect: async c => { seen.push(c); } } });
    const r = await postJson(h.port, '/api/connect', { platform: 'glm', api_key: RAW, model: 'glm-5.3' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.current, 'glm');
    assert.equal(typeof r.json.masked_key, 'string');
    assert.notEqual(r.json.masked_key, RAW);
    assert.ok(!String(r.json.masked_key).includes(RAW), '回执只含打码形态');
    // 热应用回调收到 via:'wizard' 的完整连接
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.platform, 'glm');
    assert.equal(seen[0]!.apiKey, RAW);
    assert.equal(seen[0]!.model, 'glm-5.3');
    assert.equal(seen[0]!.via, 'wizard');
    assert.equal(typeof seen[0]!.updatedAt, 'number');
    assert.equal(seen[0]!.baseUrl, undefined, '未覆盖 baseUrl ⇒ 存档不落基址（消费方按预设解析）');
    // 存档真的落了临时路径（新仓读同一文件；load 的消毒面会显式产出 undefined 物料键）
    const persisted = new ConnectionStore(storePath).load();
    assert.ok(persisted, '档位可读回');
    assert.equal(persisted!.platform, seen[0]!.platform);
    assert.equal(persisted!.apiKey, seen[0]!.apiKey);
    assert.equal(persisted!.model, seen[0]!.model);
    assert.equal(persisted!.via, seen[0]!.via);
    assert.equal(persisted!.updatedAt, seen[0]!.updatedAt);
    assert.equal(persisted!.baseUrl, undefined, '未覆盖 baseUrl ⇒ 读回仍无基址');
  } finally {
    await closeHandle(h);
    rmTemp(storePath);
  }
});

test('Λ-2: /api/connect 回调抛错 ⇒ 200 但 ok:false（热应用失败文案）；存档已写（先存档后回调）', async () => {
  let h: OnboardingHandle | null = null;
  const storePath = tempStorePath();
  const RAW = 'sk-wizard-throw-2468abcdef';
  try {
    const store = new ConnectionStore(storePath);
    let calls = 0;
    h = await startOnboarding({
      port: 0,
      deps: { store, onConnect: async () => { calls++; throw new Error('hot-apply boom'); } },
    });
    const r = await postJson(h.port, '/api/connect', { platform: 'qwen', api_key: RAW });
    assert.equal(r.status, 200, '热应用失败也是 200（存档已成功）');
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /热应用失败/);
    assert.match(r.json.error, /重载插件后生效/);
    assert.equal(calls, 1);
    // 存档在 —— 重载即生效
    const persisted = new ConnectionStore(storePath).load();
    assert.equal(persisted?.platform, 'qwen');
    assert.equal(persisted?.apiKey, RAW);
    assert.equal(persisted?.via, 'wizard');
  } finally {
    await closeHandle(h);
    rmTemp(storePath);
  }
});

// ─── ⑥ /api/disconnect ───

test('Λ-2: /api/disconnect —— 清档 {ok:true}；/api/state 回到未连接态', async () => {
  let h: OnboardingHandle | null = null;
  const storePath = tempStorePath();
  try {
    const store = new ConnectionStore(storePath);
    store.save({ platform: 'glm', apiKey: 'sk-pre-111111111111', updatedAt: 1, via: 'tool' });
    h = await startOnboarding({ port: 0, deps: { store } });
    let s = await getJson(h.port, '/api/state');
    assert.equal(s.json.current, 'glm');
    assert.equal(s.json.connectedVia, 'tool');
    const r = await postJson(h.port, '/api/disconnect', {});
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(new ConnectionStore(storePath).load(), null, '档位已清');
    s = await getJson(h.port, '/api/state');
    assert.equal(s.json.current, '');
    assert.equal(s.json.connectedVia, null);
    assert.equal(s.json.maskedKey, null);
  } finally {
    await closeHandle(h);
    rmTemp(storePath);
  }
});

// ─── ⑦ 密钥不回显：connect 响应、/api/state、GET / 页面均只有打码形态 ───

test('Λ-2: 密钥卫生 —— connect 回执 / /api/state / GET / 页面全部零明文 key', async () => {
  let h: OnboardingHandle | null = null;
  const storePath = tempStorePath();
  const RAW = 'sk-wizard-hygiene-9999xyzKY';
  try {
    const store = new ConnectionStore(storePath);
    h = await startOnboarding({ port: 0, deps: { store, onConnect: async () => {} } });
    const conn = await postJson(h.port, '/api/connect', { platform: 'anthropic', api_key: RAW });
    assert.equal(conn.json.ok, true);
    const state = await httpReq(h.port, 'GET', '/api/state');
    const page = await httpReq(h.port, 'GET', '/');
    for (const [name, body] of [['connect', JSON.stringify(conn.json)], ['state', state.body], ['page', page.body]] as const) {
      assert.ok(!body.includes(RAW), `${name} 响应面不得出现明文密钥`);
    }
    assert.ok(state.body.includes('"maskedKey"') === false || !state.body.includes(RAW), 'maskedKey 非明文');
    const s = JSON.parse(state.body);
    assert.equal(typeof s.maskedKey, 'string');
    assert.ok(s.maskedKey.length < RAW.length, '打码形态短于原值');
    assert.ok(page.body.includes(s.maskedKey), '页面当前生效区渲染打码密钥');
  } finally {
    await closeHandle(h);
    rmTemp(storePath);
  }
});

// ─── ⑧ 端口占用 +1 回退（先占 18432 起假服务，再 startOnboarding ⇒ 18433） ───

test('Λ-2: 端口回退 —— 18432 被占 ⇒ startOnboarding 落 18433；url 与 port 一致', async () => {
  const squatter: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"who":"squatter"}');
  });
  let h: OnboardingHandle | null = null;
  const storePath = tempStorePath();
  try {
    await new Promise<void>((resolve, reject) => {
      squatter.once('error', reject);
      squatter.listen(18432, '127.0.0.1', () => resolve());
    });
    h = await startOnboarding({ deps: { store: new ConnectionStore(storePath) } }); // 缺省口 18432
    assert.equal(h.port, 18433, '被占 +1 回退');
    assert.equal(h.url, `http://127.0.0.1:${h.port}/`);
    assert.equal(h.closed, false);
    // 回退口真活：向导响应标题；占坑者不是向导
    const mine = await httpReq(h.port, 'GET', '/api/state');
    assert.equal(JSON.parse(mine.body).platforms.length, 13);
    const theirs = await httpReq(18432, 'GET', '/');
    assert.equal(theirs.body, '{"who":"squatter"}');
  } finally {
    await closeHandle(h);
    await new Promise<void>(resolve => squatter.close(() => resolve()));
    rmTemp(storePath);
  }
});

// ─── ⑨ 九口全占 ⇒ Promise.reject('port-range-exhausted')（唯一 reject 口） ───

test('Λ-2: 端口段耗尽 —— 18432..18440 全占 ⇒ reject Error(port-range-exhausted)', async () => {
  const squatters: Server[] = [];
  try {
    for (let p = 18432; p <= 18440; p++) {
      const s = createServer();
      await new Promise<void>(resolve => {
        // 外部进程已占的口：EADDRINUSE 视为已占（同样计入耗尽面），不视为本用例故障
        s.once('error', () => resolve());
        s.listen(p, '127.0.0.1', () => resolve());
      });
      squatters.push(s);
    }
    await assert.rejects(
      startOnboarding({ deps: { store: new ConnectionStore(tempStorePath()) } }),
      { message: 'port-range-exhausted' },
      '九口全占 ⇒ 唯一允许的 reject 口',
    );
  } finally {
    await Promise.all(
      squatters.map(s => new Promise<void>(resolve => s.close(() => resolve()))),
    );
  }
});

// ─── ⑩ idle 自动关（真实定时器；任何请求重置） ───

test('Λ-2: idle 自动关 —— idleTimeoutMs:300 无请求 ⇒ 自动 closed；请求重置计时', async () => {
  // 甲：无请求，到期自动关
  let a: OnboardingHandle | null = null;
  try {
    a = await startOnboarding({ port: 0, idleTimeoutMs: 300, deps: { store: new ConnectionStore(tempStorePath()) } });
    assert.equal(a.closed, false);
    await sleep(500);
    assert.equal(a.closed, true, '空闲到期自动熄灯');
    await a.close(); // 已关后 close 幂等不炸
  } finally {
    await closeHandle(a);
  }
  // 乙：有请求 ⇒ 计时重置，原到期点仍亮，新到期点才关
  let b: OnboardingHandle | null = null;
  try {
    b = await startOnboarding({ port: 0, idleTimeoutMs: 600, deps: { store: new ConnectionStore(tempStorePath()) } });
    await sleep(300);
    await httpReq(b.port, 'GET', '/api/state'); // 重置：关停点 300+600=900ms
    await sleep(350); // 650ms 处 —— 无重置则 600ms 已关；有重置 ⇒ 仍亮（距 900ms 尚余 250ms）
    assert.equal(b.closed, false, '请求重置 idle 计时');
    await sleep(900); // 1550ms > 900ms —— 重置点后到期
    assert.equal(b.closed, true);
  } finally {
    await closeHandle(b);
  }
});

// ─── ⑪ close 幂等 + 端口释放 ───

test('Λ-2: close 幂等 —— 二次 close 不炸；closed 置位；端口释放可复用', async () => {
  const storePath = tempStorePath();
  const PORT = 18451; // 本用例私占口（避开缺省段，防兄弟用例互扰）
  let h: OnboardingHandle | null = null;
  try {
    h = await startOnboarding({ port: PORT, deps: { store: new ConnectionStore(storePath) } });
    assert.equal(h.port, PORT);
    await h.close();
    assert.equal(h.closed, true);
    await h.close(); // 幂等：同一 Promise 兑现
    assert.equal(h.closed, true);
    // 关停后连接被拒
    await assert.rejects(httpReq(h.port, 'GET', '/api/state'));
    // 端口已释放：同口可重启
    const h2 = await startOnboarding({ port: PORT, deps: { store: new ConnectionStore(storePath) } });
    try {
      assert.equal(h2.port, PORT);
      const r = await httpReq(h2.port, 'GET', '/api/state');
      assert.equal(r.status, 200);
    } finally {
      await h2.close();
    }
  } finally {
    await closeHandle(h);
    rmTemp(storePath);
  }
});

// ─── ⑪(续) 方法不符 405 / 未知路由 404 / OPTIONS 204 / 坏 JSON 400 ───

test('Λ-2: 405/404/OPTIONS 204/坏 JSON 400 —— 安全律的裁决面', async () => {
  let h: OnboardingHandle | null = null;
  const storePath = tempStorePath();
  try {
    h = await startOnboarding({ port: 0, deps: { store: new ConnectionStore(storePath) } });
    // 405：已知路由方法不符（附 Allow 头）
    const m1 = await httpReq(h.port, 'GET', '/api/test');
    assert.equal(m1.status, 405);
    assert.match(String(m1.headers.allow), /POST/);
    assert.equal(JSON.parse(m1.body).ok, false);
    const m2 = await httpReq(h.port, 'POST', '/api/state', '{}');
    assert.equal(m2.status, 405);
    const m3 = await httpReq(h.port, 'PUT', '/', '');
    assert.equal(m3.status, 405);
    // 404：未知路由
    const nf = await httpReq(h.port, 'GET', '/api/nope');
    assert.equal(nf.status, 404);
    assert.equal(JSON.parse(nf.body).ok, false);
    const nf2 = await httpReq(h.port, 'POST', '/api/unknown', '{}');
    assert.equal(nf2.status, 404);
    // OPTIONS 预检 204 兜底（任意路径）
    for (const p of ['/', '/api/test', '/api/nope']) {
      const o = await httpReq(h.port, 'OPTIONS', p);
      assert.equal(o.status, 204, `OPTIONS ${p} ⇒ 204`);
    }
    // 坏 JSON ⇒ 400
    const bj = await httpReq(h.port, 'POST', '/api/connect', '{not json');
    assert.equal(bj.status, 400);
    assert.equal(JSON.parse(bj.body).ok, false);
    // 空体 ⇒ 400
    const eb = await httpReq(h.port, 'POST', '/api/connect', '');
    assert.equal(eb.status, 400);
    // 非对象 JSON（数组）⇒ 400
    const arr = await httpReq(h.port, 'POST', '/api/connect', '[]');
    assert.equal(arr.status, 400);
  } finally {
    await closeHandle(h);
    rmTemp(storePath);
  }
});

// ─── ⑫ 32KB 体超限 ⇒ 413 ───

test('Λ-2: 请求体限 32KB —— 33KB 体 ⇒ 413（Content-Length 预告短路）', async () => {
  let h: OnboardingHandle | null = null;
  const storePath = tempStorePath();
  try {
    h = await startOnboarding({ port: 0, deps: { store: new ConnectionStore(storePath) } });
    const big = JSON.stringify({ platform: 'glm', api_key: 'x'.repeat(33 * 1024) });
    assert.ok(Buffer.byteLength(big) > 32 * 1024, '前置：体确超 32KB');
    const r = await httpReq(h.port, 'POST', '/api/test', big);
    assert.equal(r.status, 413);
    assert.equal(JSON.parse(r.body).ok, false);
    // 服务仍在（超限不杀伤服务器）
    const alive = await httpReq(h.port, 'GET', '/api/state');
    assert.equal(alive.status, 200);
  } finally {
    await closeHandle(h);
    rmTemp(storePath);
  }
});
