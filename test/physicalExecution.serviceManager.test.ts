// test/physicalExecution.serviceManager.test.ts
// ΝΩ-27 定向单测：优雅关停序列（HTTP /v1/shutdown 优先，信号链兜底）——
//   1. stopChildProcess 编排（导出纯函数）：HTTP ack ⇒ 宽限窗等自退（不发信号）；
//      无 ack ⇒ 既有 SIGTERM→3s→SIGKILL 链（graceMs=0 与旧行为逐字节等价）。
//   2. PhysicalServiceManager.dispose 顺序（白盒：注入 fake 子进程 + mock HTTP
//      管理面）—— dispose 必须先 POST /v1/shutdown（带 X-Cap-Token +
//      X-Request-Id nonce），ack 后宽限窗内等自退、零信号；HTTP 非 2xx 时退化信号链。
//
// Windows 背景：SIGTERM 即 TerminateProcess 硬杀 —— 3s 优雅窗形同虚设，
// HTTP 优雅关停是唯一能兑现 drain（拒新请求 + 排空在途）的通道。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PhysicalServiceManager,
  stopChildProcess,
  type StoppableChild,
} from '../src/physicalExecution/serviceManager.ts';

/** fake 子进程：记录 kill 信号序列，可编程 'exit'。
 *  exit 排队语义：stopChildProcess 在 await HTTP 关停请求**之后**才注册
 *  'exit' 监听 —— 早到的自退（请求刚抵达 mock 管理面、fetch 未 settle）不得
 *  丢失：无监听时挂起，首次注册即补发（消灭测试竞态）。 */
class FakeChild extends EventEmitter implements StoppableChild {
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly kills: string[] = [];
  private pendingExit = false;

  kill(signal?: string | number): boolean {
    this.kills.push(String(signal ?? 'SIGTERM'));
    return true;
  }
  override once(event: string | symbol, listener: (...args: unknown[]) => void): this {
    super.once(event, listener as (...args: unknown[]) => void);
    if (event === 'exit' && this.pendingExit) {
      this.pendingExit = false;
      queueMicrotask(() => this.emitExit());
    }
    return this;
  }
  /** 模拟进程自退（优雅路径） */
  selfExit(): void {
    if (this.listenerCount('exit') === 0) {
      this.pendingExit = true;
      return;
    }
    this.emitExit();
  }
  private emitExit(): void {
    this.exitCode = 0;
    this.emit('exit', 0, null);
  }
}

/** 轮询等待谓词成立（真实 I/O 轮转 —— fetch/HTTP mock 的应答不在微任务里） */
async function waitFor(pred: () => boolean, timeoutMs = 2000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) {
    await new Promise<void>(r => setTimeout(r, 10));
  }
  if (!pred()) throw new Error(`waitFor timeout: ${what}`);
}

test('ΝΩ-27 stopChildProcess: HTTP 请求先行 —— ack 后宽限窗等自退，零信号', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const child = new FakeChild();
    const order: string[] = [];
    const done = stopChildProcess(child, async () => {
      order.push('http-shutdown');
      return true; // 服务 ack
    });
    // 让 HTTP promise settle（微任务）后、宽限窗内自退
    await new Promise<void>(r => setImmediate(r));
    assert.deepEqual(order, ['http-shutdown'], 'HTTP 优雅关停请求最先发出');
    assert.deepEqual(child.kills, [], 'ack 后宽限窗内未发任何信号（Windows SIGTERM=硬杀）');
    child.selfExit(); // 服务排空后自退
    await done;
    assert.deepEqual(child.kills, [], '自退成功 ⇒ 全程零信号（最优雅路径）');
  } finally {
    mock.timers.reset();
  }
});

test('ΝΩ-27 stopChildProcess: ack 但宽限超时未退 ⇒ 退化 SIGTERM→SIGKILL 链', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const child = new FakeChild(); // 永不自退（服务卡死）
    const done = stopChildProcess(child, async () => true, { graceMs: 1000, sigkillMs: 3000 });
    await new Promise<void>(r => setImmediate(r));
    assert.deepEqual(child.kills, [], '宽限窗（<1000ms）内不发信号');
    mock.timers.tick(1000); // 宽限到期
    assert.deepEqual(child.kills, ['SIGTERM'], '宽限到期 ⇒ SIGTERM（既有链起点）');
    mock.timers.tick(2999);
    assert.deepEqual(child.kills, ['SIGTERM'], 'SIGKILL 前的 3s 窗内不再补发');
    mock.timers.tick(1);
    assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL'], '3s 到 ⇒ SIGKILL（既有链终点）');
    await done;
  } finally {
    mock.timers.reset();
  }
});

test('ΝΩ-27 stopChildProcess: HTTP 无 ack（服务不可达/请求抛错）⇒ 与旧行为等价 —— SIGTERM 即发，3s 后 SIGKILL', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const declined = new FakeChild();
    const d1 = stopChildProcess(declined, async () => false);
    await new Promise<void>(r => setImmediate(r)); // HTTP promise settle
    mock.timers.tick(1); // graceMs=0 的 SIGTERM 定时器到点
    assert.deepEqual(declined.kills, ['SIGTERM'], '无 ack ⇒ SIGTERM 立即（graceMs=0，旧 _killProcess 行为）');
    assert.equal(declined.exitCode, null, '进程未退 —— killer 窗仍在计时');
    declined.selfExit(); // resolve 收口（SIGKILL 计时器随之拆除）
    await d1;

    const threw = new FakeChild();
    const d2 = stopChildProcess(threw, async () => { throw new Error('fetch failed'); });
    await new Promise<void>(r => setImmediate(r));
    mock.timers.tick(1);
    assert.deepEqual(threw.kills, ['SIGTERM'], '请求抛错 ⇒ 同样按无 ack 走信号链（best-effort 吞错）');
    threw.selfExit();
    await d2;
  } finally {
    mock.timers.reset();
  }
});

test('ΝΩ-27 stopChildProcess: 前置同旧律 —— 未 spawn（pid 缺席）/已退进程不发 HTTP 不发信号', async () => {
  const never = new FakeChild();
  never.pid = undefined; // spawn 未成功
  let httpCalled = false;
  await stopChildProcess(never, async () => { httpCalled = true; return true; });
  assert.equal(httpCalled, false, '无可杀进程 ⇒ HTTP 请求也不发');
  assert.deepEqual(never.kills, []);

  const dead = new FakeChild();
  dead.exitCode = 1; // 已退（exitCode 在场）
  await stopChildProcess(dead, async () => true);
  assert.deepEqual(dead.kills, [], '已退进程零动作');
});

/** mock HTTP 管理面：录像 /v1/shutdown 请求（头/路径/方法），可编程状态码 */
interface ShutdownRecording {
  server: Server;
  requests: Array<{ method: string; url: string; capToken: string | undefined; requestId: string | undefined }>;
  respondStatus: number;
}

async function startShutdownMock(): Promise<ShutdownRecording> {
  const rec: ShutdownRecording = {
    server: null as unknown as Server, requests: [], respondStatus: 200,
  };
  rec.server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      rec.requests.push({
        method: req.method ?? '?',
        url: req.url ?? '?',
        capToken: req.headers['x-cap-token'] as string | undefined,
        requestId: req.headers['x-request-id'] as string | undefined,
      });
      res.writeHead(rec.respondStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', data: { draining: true }, latency_ms: 0 }));
    });
  });
  await new Promise<void>(resolve => rec.server.listen(0, '127.0.0.1', resolve));
  return rec;
}

/** 白盒接线：把 manager 的连接事实指到 mock 管理面 + fake 子进程
 *  （_baseUrl/_keyPath/proc/_keyCleanup 均私有 —— 单测白盒注入，生产语义不变；
 *  临时密钥目录由 manager._cleanupLocal 走 _keyCleanup 清理） */
function wireManager(mgr: PhysicalServiceManager, rec: ShutdownRecording, child: FakeChild): void {
  const inner = mgr as unknown as {
    _baseUrl: string;
    _keyPath: string;
    proc: FakeChild | null;
    _keyCleanup: (() => void) | null;
  };
  // 真密钥文件（mintToken 需 ≥32 字节密钥 —— 与服务端 ensure_key 同构）
  const dir = mkdtempSync(join(tmpdir(), 'no27-mgr-key-'));
  const keyPath = join(dir, 'cap.key');
  writeFileSync(keyPath, 'a'.repeat(64), 'utf-8');
  inner._baseUrl = `http://127.0.0.1:${(rec.server.address() as { port: number }).port}/v1`;
  inner._keyPath = keyPath;
  inner.proc = child;
  inner._keyCleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } };
}

test('ΝΩ-27 dispose 顺序: 先 POST /v1/shutdown（Cap Token + Request-Id nonce）→ ack 后等自退，全程零信号', async () => {
  const rec = await startShutdownMock();
  const mgr = new PhysicalServiceManager();
  const child = new FakeChild();
  wireManager(mgr, rec, child);
  try {
    const disposePromise = mgr.dispose();
    // dispose 内部：HTTP 请求（真实 fetch —— 轮询等它抵达 mock 管理面）
    await waitFor(() => rec.requests.length === 1, 2000, '/v1/shutdown 请求抵达');
    assert.deepEqual(child.kills, [], 'HTTP 在任何信号之前；ack 后宽限窗内零信号');
    const req = rec.requests[0]!;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/shutdown');
    assert.ok(req.capToken, '携带 X-Cap-Token（服务端管理面强制）');
    assert.ok(req.requestId, '携带 X-Request-Id（nonce 防重放强制头）');
    child.selfExit(); // 服务排空完成自退
    await disposePromise;
    assert.deepEqual(child.kills, [], '自退路径：SIGTERM/SIGKILL 全程未用');
    assert.equal(mgr.disposed, true, 'dispose 完成（幂等收口）');
  } finally {
    await new Promise<void>(r => rec.server.close(() => r()));
  }
});

test('ΝΩ-27 dispose 退化: HTTP 401（占坑者/密钥不符）⇒ 不当 ack，退化 SIGTERM 信号链', async () => {
  const rec = await startShutdownMock();
  rec.respondStatus = 401; // 管理面拒绝 —— 诚实非 ack
  const mgr = new PhysicalServiceManager();
  const child = new FakeChild();
  wireManager(mgr, rec, child);
  try {
    const disposePromise = mgr.dispose();
    await waitFor(() => rec.requests.length === 1, 2000, '/v1/shutdown 请求抵达（即使将被拒）');
    // graceMs=0 ⇒ SIGTERM 在 ack 判定后立即定时（0ms）——真实计时器，稍候即发
    await waitFor(() => child.kills.length >= 1, 2000, 'SIGTERM 发出');
    assert.equal(child.kills[0], 'SIGTERM', '非 2xx ack ⇒ 既有信号链启动（SIGTERM 先行）');
    child.selfExit(); // 进程随后退出（信号致死或自退，均收口）
    await disposePromise;
    assert.equal(mgr.disposed, true);
  } finally {
    await new Promise<void>(r => rec.server.close(() => r()));
  }
});
