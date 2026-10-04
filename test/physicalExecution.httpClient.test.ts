// test/physicalExecution.httpClient.test.ts
// W6R-A6 定向单测：microFetch 统一请求入口的两项防御加固 ——
//   1. 防重放配套：每个请求必带 X-Request-Id（缺席注入 randomUUID、在场不覆盖）
//   2. 401 识别：Python 端认证失败自 HTTP 200 改 401（错误信封 JSON 结构不变）
//      ⇒ kind='unauthorized' + 密钥/时钟偏移类清晰提示；非 401 的非 2xx 仍走
//      transport_error（原语义回归守护）
//
// ΑΩ-R3 追加：UDS（http+unix://）传输全兑现 —— 可注入 fake fetch/dispatcher
// 离线验证（不依赖真 socket）：(a) UDS 基址走 undici 路径且 socketPath 正确；
// (b) 宿主桥最优先；(c) undici 不可用 ⇒ 诚实 transport_error（undici-unavailable）。
//
// 测试形态：node:http 本地 mock 服务（127.0.0.1:0 临时端口）—— 不依赖真实
// Python 服务（那由 physicalExecution.adapter.http.test.ts 按 skip 闸门负责），
// 本文件只测 TS 客户端自身的协议行为。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { microFetch, setUndiciBridge, type HttpClientConfig } from '../src/physicalExecution/httpClient.ts';
import { PhysicalErrorKind } from '../src/physicalExecution/contracts.ts';

/** mock 服务：可编程响应 + 请求头录像（每请求一条，含 X-Request-Id） */
interface Recorded {
  method: string;
  path: string;
  requestId: string | undefined;
}

async function startMock(
  respond: (req: Recorded, body: string) => { status: number; body: string },
): Promise<{ server: Server; recorded: Recorded[]; config: HttpClientConfig }> {
  const recorded: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      recorded.push({
        method: req.method ?? '?',
        path: req.url ?? '?',
        requestId: req.headers['x-request-id'] as string | undefined,
      });
      const r = respond(
        recorded[recorded.length - 1],
        Buffer.concat(chunks).toString('utf-8'),
      );
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(r.body);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, recorded, config: { baseUrl: `http://127.0.0.1:${port}/v1`, defaultTimeoutMs: 3000 } };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test('microFetch: X-Request-Id 缺席自动注入（randomUUID 格式，逐请求唯一）', async () => {
  const { server, recorded, config } = await startMock(() => ({
    status: 200, body: JSON.stringify({ status: 'success', data: {} }),
  }));
  try {
    // 无 headers 回调（enableAuth=false 的诊断路径同形态）—— 注入必须兜底
    const r1 = await microFetch(config, '/health', { method: 'GET' });
    const r2 = await microFetch(config, '/click_mouse', { method: 'POST', body: { x: 1, y: 2 } });
    assert.ok(r1.ok && r2.ok, 'mock 200 success 信封必须通过');
    assert.equal(recorded.length, 2, '两个请求都被录像');
    assert.ok(recorded[0].requestId, 'GET /health 请求带 X-Request-Id');
    assert.ok(recorded[1].requestId, 'POST 业务请求带 X-Request-Id');
    assert.match(recorded[0].requestId!, UUID_RE, 'randomUUID 规范格式');
    assert.match(recorded[1].requestId!, UUID_RE, 'randomUUID 规范格式');
    assert.notEqual(recorded[0].requestId, recorded[1].requestId, '逐请求唯一（防重放 nonce 语义）');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('microFetch: X-Request-Id 在场不覆盖（adapter 鉴权回调 / extraHeaders 优先）', async () => {
  const { server, recorded, config } = await startMock(() => ({
    status: 200, body: JSON.stringify({ status: 'success', data: {} }),
  }));
  try {
    // 1. headers 回调提供（adapter buildAuthHeadersSync 的 mintNonce 形态）
    const withCallback: HttpClientConfig = {
      ...config, headers: () => ({ 'X-Cap-Token': 'tok', 'X-Request-Id': 'nonce-from-adapter' }),
    };
    await microFetch(withCallback, '/cursor', { method: 'GET' });
    assert.equal(recorded[0].requestId, 'nonce-from-adapter', '回调值优先，不被 randomUUID 覆盖');

    // 2. extraHeaders 提供（调用点显式指定）
    await microFetch(config, '/displays', { method: 'GET', extraHeaders: { 'X-Request-Id': 'nonce-from-extra' } });
    assert.equal(recorded[1].requestId, 'nonce-from-extra', 'extraHeaders 值优先');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('microFetch: HTTP 401（JSON 错误信封）→ unauthorized + 密钥/时钟偏移类提示', async () => {
  const { server, config } = await startMock(() => ({
    status: 401,
    body: JSON.stringify({
      status: 'failure',
      error: { kind: 'unauthorized', detail: 'token invalid: invalid signature' },
    }),
  }));
  try {
    const r = await microFetch(config, '/take_screenshot', { method: 'POST', body: {} });
    assert.ok(!r.ok, '401 必须落失败臂');
    if (r.ok) return;
    assert.equal(r.error.kind, PhysicalErrorKind.UNAUTHORIZED, '401 归因 unauthorized（非 transport_error）');
    assert.ok(r.error.detail.includes('401'), 'detail 含状态码 401');
    assert.ok(r.error.detail.includes('invalid signature'), '透传 Python 端信封 detail');
    // 区分性提示：密钥/时钟偏移问题 vs 服务内部错误
    assert.ok(r.error.detail.includes('密钥'), '提示密钥类成因');
    assert.ok(r.error.detail.includes('时钟偏移'), '提示时钟偏移类成因');
    assert.ok(r.error.detail.includes('不是服务内部错误'), '明确与内部错误区分');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('microFetch: HTTP 401（非 JSON 包体）→ 仍 unauthorized，退回原文截断', async () => {
  const { server, config } = await startMock(() => ({ status: 401, body: 'proxy says no' }));
  try {
    const r = await microFetch(config, '/get_ui_tree', { method: 'POST', body: {} });
    assert.ok(!r.ok);
    if (r.ok) return;
    assert.equal(r.error.kind, PhysicalErrorKind.UNAUTHORIZED);
    assert.ok(r.error.detail.includes('proxy says no'), '非 JSON 信封时透传原文');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('microFetch: 非 401 的非 2xx（如 500）→ transport_error（原语义回归守护）', async () => {
  const { server, config } = await startMock(() => ({
    status: 500, body: JSON.stringify({ status: 'failure', error: { kind: 'internal_error', detail: 'boom' } }),
  }));
  try {
    const r = await microFetch(config, '/switch_window', { method: 'POST', body: {} });
    assert.ok(!r.ok);
    if (r.ok) return;
    assert.equal(r.error.kind, PhysicalErrorKind.TRANSPORT_ERROR, '5xx 仍按传输层异常归因');
    assert.ok(r.error.detail.includes('500'), 'detail 含原始状态码');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('microFetch: 200 + failure 信封（旧形态 unauthorized）→ 信封透传路径不变', async () => {
  // Python 端改版过渡期/旧版本：认证失败仍可能以 200+failure 表达 ——
  // 该路径必须继续工作（信封解析在 resp.ok 之后，不受 401 分支影响）
  const { server, config } = await startMock(() => ({
    status: 200,
    body: JSON.stringify({
      status: 'failure',
      error: { kind: 'unauthorized', detail: 'missing X-Cap-Token header' },
    }),
  }));
  try {
    const r = await microFetch(config, '/health', { method: 'GET' });
    assert.ok(r.ok, '200 + failure 信封在 microFetch 层是 ok 臂（信封由调用方裁决）');
    if (!r.ok) return;
    assert.equal(r.response.status, 'failure');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

// ─── ΑΩ-R3：UDS（http+unix://）传输全兑现 —— 可注入 fake fetch/dispatcher 离线验证 ───

/** ΑΩ-R3 fake undici 载面：Agent 录构造 opts + 实例（含 closed 位）；
 *  fetch 录每次调用（url/init）并回放固定 200 success 信封。 */
function makeFakeUndici(respond: () => Response) {
  const agentOpts: { connections?: number; connect?: { socketPath?: string } }[] = [];
  const agents: { closed: boolean }[] = [];
  const fetchCalls: { url: string; init: Record<string, any> }[] = [];
  class FakeAgent {
    closed = false;
    constructor(opts: { connections?: number; connect?: { socketPath?: string } }) {
      agentOpts.push(opts);
      agents.push(this);
    }
    close(): Promise<void> {
      this.closed = true;
      return Promise.resolve();
    }
  }
  const fetchImpl = (url: string, init: Record<string, any>): Promise<Response> => {
    fetchCalls.push({ url, init });
    return Promise.resolve(respond());
  };
  return { agentOpts, agents, fetchCalls, carrier: { Agent: FakeAgent, fetch: fetchImpl } };
}

const okEnvelope = (): Response =>
  new Response(JSON.stringify({ status: 'success', data: {} }), { status: 200 });

test('ΑΩ-R3 microFetch UDS: 走 undici 路径 —— Agent 按 socketPath 建池（带 connections 上限），dispatcher 注入，同 socket 复用不重建', async () => {
  const fake = makeFakeUndici(okEnvelope);
  setUndiciBridge(fake.carrier);
  try {
    const config: HttpClientConfig = {
      baseUrl: 'http+unix:///tmp/aor3-fake.sock/v1',
      defaultTimeoutMs: 3000,
      headers: () => ({ 'X-Cap-Token': 'tok-aor3' }), // 头处理与 TCP 路径同律（X-Cap-Token 透传）
    };
    const r = await microFetch(config, '/health', { method: 'GET' });
    assert.ok(r.ok, 'fake undici fetch 200 success 信封照常通过');
    if (!r.ok) return;
    assert.equal(r.response.status, 'success');
    // (a) 走 undici 路径：请求进的是注入的 fetch（若误走全局 fetch，fake 不会被调）
    assert.equal(fake.fetchCalls.length, 1, '请求经 undici 方言 fetch 传输');
    assert.equal(fake.fetchCalls[0].url, 'http://localhost/v1/health', 'UDS 方言 URL 翻译 + path 拼接同律');
    assert.equal(fake.agentOpts.length, 1, 'Agent 懒建一次');
    assert.equal(fake.agentOpts[0].connect?.socketPath, '/tmp/aor3-fake.sock', 'Agent 经 connect.socketPath 拨 UDS（关键断言）');
    assert.equal(typeof fake.agentOpts[0].connections, 'number', '连接池显式封顶');
    assert.ok(fake.fetchCalls[0].init.dispatcher instanceof fake.carrier.Agent, 'dispatcher 即该 Agent 实例');
    const h = fake.fetchCalls[0].init.headers as Record<string, string>;
    assert.match(h['X-Request-Id'], UUID_RE, 'UDS 路径同样必带 X-Request-Id');
    assert.equal(h['X-Cap-Token'], 'tok-aor3', 'headers 回调（X-Cap-Token）透传不丢');
    // 池复用（生命周期）：同 socket 第二次请求不重建 Agent
    const r2 = await microFetch(config, '/click_mouse', { method: 'POST', body: { x: 1, y: 2 } });
    assert.ok(r2.ok);
    assert.equal(fake.agentOpts.length, 1, '同 socket 复用连接池（不每请求新建）');
    assert.equal(fake.fetchCalls.length, 2);
    // 异 socket ⇒ 另建一池
    await microFetch({ ...config, baseUrl: 'http+unix:///tmp/aor3-other.sock/v1' }, '/health', { method: 'GET' });
    assert.equal(fake.agentOpts.length, 2, '不同 socketPath 各一池');
    assert.equal(fake.agentOpts[1].connect?.socketPath, '/tmp/aor3-other.sock');
  } finally {
    setUndiciBridge(null);
  }
});

test('ΑΩ-R3 microFetch UDS: 宿主桥最优先 —— 桥的 fetch/Agent 压过缺省 undici；半桥缺失半边自动补齐', async () => {
  // 缺省路径（无桥）懒加载 npm undici 本仓在装 —— 若实现误让缺省抢跑，fake
  // 不会被调且请求将真拨不存在的 socket ⇒ 失败。断言 fake 被调 + 成功即证桥优先。
  const fake = makeFakeUndici(okEnvelope);
  setUndiciBridge(fake.carrier);
  try {
    const r = await microFetch(
      { baseUrl: 'http+unix:///tmp/aor3-bridge.sock/v1', defaultTimeoutMs: 3000 }, '/health', { method: 'GET' },
    );
    assert.ok(r.ok, '桥在场 ⇒ 桥 fetch 接管并成功（桥最优先）');
    assert.equal(fake.fetchCalls.length, 1, '被调的是桥 fetch（非缺省 undici.fetch）');
    assert.ok(fake.fetchCalls[0].init.dispatcher instanceof fake.carrier.Agent, 'dispatcher 是桥 Agent（非缺省 undici Agent）');
  } finally {
    setUndiciBridge(null);
  }
  // 半桥（只注入 fetch）：Agent 由缺省 undici 补齐 —— 字段级覆盖语义（epochO 的只注 Agent 形态对偶）
  const fakeFetchOnly = makeFakeUndici(okEnvelope);
  setUndiciBridge({ fetch: fakeFetchOnly.carrier.fetch });
  try {
    const half = await microFetch(
      { baseUrl: 'http+unix:///tmp/aor3-half.sock/v1', defaultTimeoutMs: 3000 }, '/health', { method: 'GET' },
    );
    assert.ok(half.ok, '半桥（仅 fetch）成立：Agent 由缺省 undici 补齐');
    assert.equal(fakeFetchOnly.fetchCalls.length, 1, '桥 fetch 仍最优先');
    assert.ok(!!fakeFetchOnly.fetchCalls[0].init.dispatcher, '补齐的 Agent 实例作为 dispatcher 注入');
  } finally {
    setUndiciBridge(null);
  }
});

test('ΑΩ-R3 microFetch UDS: undici 不可用 ⇒ 诚实 transport_error（undici-unavailable 归因），绝不静默走 TCP', async () => {
  setUndiciBridge(false); // 宿主明示不可用 —— 与 import('undici') 失败判决同一条诚实降级路径
  try {
    const r = await microFetch(
      { baseUrl: 'http+unix:///tmp/aor3-never.sock/v1', defaultTimeoutMs: 3000 }, '/health', { method: 'GET' },
    );
    assert.ok(!r.ok, '不可用 ⇒ 失败臂');
    if (r.ok) return;
    assert.equal(r.error.kind, PhysicalErrorKind.TRANSPORT_ERROR, '归类 transport_error');
    assert.ok(r.error.detail.includes('undici-unavailable'), 'detail 归因 undici-unavailable');
    assert.ok(r.error.detail.includes('/tmp/aor3-never.sock'), 'detail 指名 socket 路径');
    assert.ok(r.error.detail.includes('127.0.0.1'), '给出 TCP 替代指引（提示而非自动回退）');
  } finally {
    setUndiciBridge(null);
  }
});

test('ΑΩ-R3 microFetch UDS 生命周期: 清桥/换桥 ⇒ 旧桥连接池 best-effort 关闭（防句柄泄漏）', async () => {
  const fake1 = makeFakeUndici(okEnvelope);
  setUndiciBridge(fake1.carrier);
  const cfg: HttpClientConfig = { baseUrl: 'http+unix:///tmp/aor3-lc.sock/v1', defaultTimeoutMs: 3000 };
  await microFetch(cfg, '/health', { method: 'GET' });
  assert.equal(fake1.agents.length, 1);
  assert.ok(fake1.agents.every(a => !a.closed), '在役池未被误关');
  setUndiciBridge(null); // 清桥 ⇒ 关池
  assert.equal(fake1.agents.length, 1);
  assert.ok(fake1.agents.every(a => a.closed), '清桥 ⇒ 旧池 close（不泄漏）');
  // 清桥后旧缓存不残留 ⇒ 新桥重新建池、dispatcher 来自新桥
  const fake2 = makeFakeUndici(okEnvelope);
  setUndiciBridge(fake2.carrier);
  try {
    await microFetch(cfg, '/health', { method: 'GET' });
    assert.equal(fake2.agents.length, 1, '新桥新池（旧池不残留复用）');
    assert.ok(fake2.fetchCalls[0].init.dispatcher instanceof fake2.carrier.Agent, 'dispatcher 来自新桥 Agent');
  } finally {
    setUndiciBridge(null);
  }
});

// ─── ΝΩ-27：UDS Agent 池 TTL 回收与失效重建（假计时器）───

test('ΝΩ-27 UDS 池 TTL 回收: 60s 无请求 ⇒ close+逐出；请求时刷新；回收后重拨新建池', async () => {
  const fake = makeFakeUndici(okEnvelope);
  setUndiciBridge(fake.carrier);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const cfg: HttpClientConfig = { baseUrl: 'http+unix:///tmp/no27-ttl.sock/v1', defaultTimeoutMs: 3000 };
    await microFetch(cfg, '/health', { method: 'GET' });
    assert.equal(fake.agents.length, 1, '首请求建池');
    assert.ok(!fake.agents[0]!.closed, '在役池未被误关');

    mock.timers.tick(59_999);
    assert.ok(!fake.agents[0]!.closed, 'TTL 内（59.999s）不回收');

    // 请求时刷新：再来一请求 ⇒ 空闲时钟从该请求重计
    await microFetch(cfg, '/click_mouse', { method: 'POST', body: { x: 1, y: 2 } });
    mock.timers.tick(30_000);
    assert.ok(!fake.agents[0]!.closed, '刷新后 30s：距最近请求未满 60s，不回收');
    mock.timers.tick(30_001);
    assert.ok(fake.agents[0]!.closed, '距最近请求满 60s ⇒ 池 close（服务换路径重启时旧池不再泄漏）');

    // 回收后同 socketPath 再请求 ⇒ 重建新 Agent（失效重建语义）
    const before = fake.agents.length;
    await microFetch(cfg, '/health', { method: 'GET' });
    assert.equal(fake.agents.length, before + 1, 'TTL 逐出后重拨新建池');
    assert.ok(!fake.agents[before]!.closed, '新池在役');
  } finally {
    mock.timers.reset();
    setUndiciBridge(null);
  }
});

test('ΝΩ-27 UDS 池 TTL 回收: 在飞请求保护 —— 到期时 inFlight>0 顺延不回收', async () => {
  const fake = makeFakeUndici(okEnvelope);
  setUndiciBridge(fake.carrier);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const cfg: HttpClientConfig = { baseUrl: 'http+unix:///tmp/no27-busy.sock/v1', defaultTimeoutMs: 3000 };
    // 第一请求在飞（慢响应 —— fake fetch 挂起，请求未 settle ⇒ inFlight=1）
    let releaseFetch!: () => void;
    fake.carrier.fetch = (url: string, init: Record<string, any>) => {
      fake.fetchCalls.push({ url, init });
      return new Promise<Response>(resolve => { releaseFetch = () => resolve(okEnvelope()); });
    };
    const pending = microFetch(cfg, '/health', { method: 'GET' });
    // 等足够多的微任务轮次：microFetch 内部多跳 await（resolveUndici/udsTransport）
    // 后才抵达挂起的 fetchFn —— setImmediate 轮转保证微任务队列排空
    await new Promise<void>(r => setImmediate(r));
    assert.equal(fake.agents.length, 1);

    mock.timers.tick(60_000); // 在飞中 TTL 到期
    assert.ok(!fake.agents[0]!.closed, '在飞 ⇒ 顺延不回收（不能关在役池）');

    releaseFetch();
    const r = await pending;
    assert.ok(r.ok, '在飞请求正常完成');
    mock.timers.tick(59_999);
    assert.ok(!fake.agents[0]!.closed, '请求结束但未满新 TTL：不回收');
    mock.timers.tick(1);
    assert.ok(fake.agents[0]!.closed, 'settle 后满 60s ⇒ 回收');
  } finally {
    mock.timers.reset();
    setUndiciBridge(null);
  }
});

test('ΝΩ-27 transport_error 失效重建: fetch 网络级抛错 ⇒ 该 socketPath 池立即 close+逐出，下次请求重拨', async () => {
  // 可编程 fake：首请求网络级失败（ECONNREFUSED 形态），其后恢复 200
  let failNext = true;
  const fake = makeFakeUndici(() => {
    if (failNext) {
      failNext = false;
      return Promise.reject(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:80'), {
        cause: { code: 'ECONNREFUSED' },
      })) as unknown as Response;
    }
    return okEnvelope();
  });
  setUndiciBridge(fake.carrier);
  try {
    const cfg: HttpClientConfig = { baseUrl: 'http+unix:///tmp/no27-inval.sock/v1', defaultTimeoutMs: 3000 };
    const r1 = await microFetch(cfg, '/health', { method: 'GET' });
    assert.ok(!r1.ok && r1.error.kind === PhysicalErrorKind.TRANSPORT_ERROR, '网络级失败归 transport_error');
    assert.ok(fake.agents[0]!.closed, 'transport_error ⇒ 旧池立即 close（失效）');
    // 逐出验证：同 socketPath 恢复后重拨必新建池（不复用已 close 的死池）
    const r2 = await microFetch(cfg, '/health', { method: 'GET' });
    assert.ok(r2.ok, '恢复后请求成功');
    assert.equal(fake.agents.length, 2, '失效重建：新 Agent（不复用旧池）');
    assert.ok(!fake.agents[1]!.closed, '新池在役');
  } finally {
    setUndiciBridge(null);
  }
});

test('ΝΩ-27 失效边界: HTTP 5xx（transport_error 归因但服务活着）与 401 不失效重建池', async () => {
  let status = 503;
  const fake = makeFakeUndici(() => new Response('boom', { status }) as Response);
  setUndiciBridge(fake.carrier);
  try {
    const cfg: HttpClientConfig = { baseUrl: 'http+unix:///tmp/no27-5xx.sock/v1', defaultTimeoutMs: 3000 };
    const r1 = await microFetch(cfg, '/health', { method: 'GET' });
    assert.ok(!r1.ok && r1.error.kind === PhysicalErrorKind.TRANSPORT_ERROR, '5xx 仍归 transport_error（原语义）');
    assert.ok(!fake.agents[0]!.closed, '5xx：服务应答了 ⇒ 池有效不失效');
    status = 401;
    const r2 = await microFetch(cfg, '/health', { method: 'GET' });
    assert.ok(!r2.ok && r2.error.kind === PhysicalErrorKind.UNAUTHORIZED, '401 归 unauthorized');
    assert.equal(fake.agents.length, 1, '401 也不失效 —— 认证问题不是连接问题');
    assert.ok(!fake.agents[0]!.closed, '池仍在役复用');
  } finally {
    setUndiciBridge(null);
  }
});
