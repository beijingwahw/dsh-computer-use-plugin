// test/physicalExecution.httpClient.test.ts
// W6R-A6 定向单测：microFetch 统一请求入口的两项防御加固 ——
//   1. 防重放配套：每个请求必带 X-Request-Id（缺席注入 randomUUID、在场不覆盖）
//   2. 401 识别：Python 端认证失败自 HTTP 200 改 401（错误信封 JSON 结构不变）
//      ⇒ kind='unauthorized' + 密钥/时钟偏移类清晰提示；非 401 的非 2xx 仍走
//      transport_error（原语义回归守护）
//
// 测试形态：node:http 本地 mock 服务（127.0.0.1:0 临时端口）—— 不依赖真实
// Python 服务（那由 physicalExecution.adapter.http.test.ts 按 skip 闸门负责），
// 本文件只测 TS 客户端自身的协议行为。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { microFetch, type HttpClientConfig } from '../src/physicalExecution/httpClient.ts';
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
