// test/physicalExecution.adapter.http.test.ts
// 端到端集成测试：通过 HTTP 调用真实运行的 Python 微服务。
//
// 前置条件：
//   - Python 微服务已启动：DSH_PHYSICAL_TRANSPORT=tcp DSH_PHYSICAL_TCP_PORT=8421
//   - DSH_PHYSICAL_TEST_SCREEN=1（pyautogui 不可用时返回合成图）
//   - DSH_PHYSICAL_PID_ATTESTATION=false
//   - DSH_PHYSICAL_KEY_PATH=/tmp/dsh-test.key（与 Node 端共享 HMAC 密钥）
//
// 测试链路：
//   1. createPhysicalExecution({ baseUrl, timeoutMs, keyPath, enableAuth=true })
//   2. await adapter.init() —— 加载 HMAC 密钥
//   3. await adapter.health() —— 探活 + 镜像 capability map
//   4. await adapter.takeScreenshotHandle() —— 调 /v1/take_screenshot
//   5. ScreenshotHandle.read() —— 读 mmap-file 字节
//   6. 校验 PNG magic + 尺寸
//   7. await handle.release() —— 显式释放
//   8. await adapter.releaseShm(name) —— Python 端 DELETE
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPhysicalExecution } from '../src/physicalExecution/index.ts';
import { CapabilityCache, syncCapabilityFromHealth } from '../src/physicalExecution/index.ts';
import type { PhysicalExecutionConfig } from '../src/physicalExecution/contracts.ts';

const BASE_URL = process.env.DSH_PHYSICAL_BASE_URL ?? 'http://127.0.0.1:8421/v1';
const KEY_PATH = process.env.DSH_PHYSICAL_KEY_PATH ?? '/tmp/dsh-test.key';

function makeConfig(overrides: Partial<PhysicalExecutionConfig> = {}): PhysicalExecutionConfig {
  return {
    baseUrl: BASE_URL,
    timeoutMs: 5000,
    keyPath: KEY_PATH,
    tokenTtlSeconds: 60,
    enableAuth: true,
    ...overrides,
  };
}

// 启动期探活 —— 失败则跳过整个测试套件（服务未启动 / 端口被占）
async function ensureServiceUp(): Promise<boolean> {
  try {
    const resp = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch {
    return false;
  }
}

const serviceUp = await ensureServiceUp();
const skip = !serviceUp;
const maybeTest = skip ? test.skip : test;

test('adapter.health: 探活 + 返回能力声明', { skip }, async () => {
  const adapter = createPhysicalExecution(makeConfig());
  await adapter.init();
  const result = await adapter.health();
  assert.ok(result.ok, 'health must succeed');
  if (!result.ok) return; // type narrow
  assert.equal(result.value.status, 'ok');
  assert.equal(result.value.platform, 'linux');
  assert.equal(result.value.screenshot_transport, 'mmap-file');
  assert.equal(result.value.switch_window_method, 'hotkey_only');
});

test('adapter.takeScreenshotHandle: HTTP 端到端 + RAII 生命周期', { skip }, async () => {
  const adapter = createPhysicalExecution(makeConfig());
  await adapter.init();

  // 1. takeScreenshotHandle —— 调 /v1/take_screenshot，返回 ScreenshotHandle
  const result = await adapter.takeScreenshotHandle({ format: 'png' });
  assert.ok(result.ok, 'takeScreenshotHandle must succeed');
  if (!result.ok) return;
  const handle = result.value;

  assert.equal(handle.meta.transport, 'mmap-file');
  assert.ok(handle.meta.name, 'mmap-file transport must have file path');
  assert.equal(handle.meta.format, 'PNG');
  assert.equal(handle.meta.width, 128);
  assert.equal(handle.meta.height, 128);
  assert.equal(handle.released, false);

  // 2. read —— 读出字节
  const buf = await handle.read();
  assert.ok(buf.length > 0);
  assert.equal(buf[0], 0x89); // PNG magic

  // 3. 二次 read —— Lazy Buffer 缓存
  const buf2 = await handle.read();
  assert.equal(buf, buf2, 'second read() must return cached Buffer');

  // 4. release —— 显式释放（触发 adapter.releaseShm → Python DELETE）
  await handle.release();
  assert.equal(handle.released, true);

  // 5. 二次 release 幂等
  await handle.release();
});

test('adapter.takeScreenshotHandle: stream + transfer 语义', { skip }, async () => {
  const adapter = createPhysicalExecution(makeConfig());
  await adapter.init();

  const result = await adapter.takeScreenshotHandle();
  assert.ok(result.ok);
  if (!result.ok) return;
  const handle = result.value;

  // stream —— 分块产出
  const chunks: Buffer[] = [];
  for await (const chunk of handle.stream()) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  assert.ok(total > 0);
  assert.equal(chunks[0][0], 0x89);

  // transfer —— 拿走 Buffer + handle 失效
  const buf = await handle.transfer();
  assert.ok(buf.length > 0);
  assert.equal(handle.released, true);

  // 后续 read 抛错
  await assert.rejects(() => handle.read(), /already released/);
});

test('adapter: CapabilityCache 从 health 同步状态', { skip }, async () => {
  const adapter = createPhysicalExecution(makeConfig());
  await adapter.init();
  const health = await adapter.health();
  assert.ok(health.ok);
  if (!health.ok) return;

  const cache = new CapabilityCache();
  syncCapabilityFromHealth(cache, health.value);

  assert.equal(cache.switchWindowRoute(), 'hotkey_only');
  assert.equal(cache.screenshotTransport(), 'mmap-file');
  assert.equal(cache.isInitialized(), true);

  // 失效后回到 unknown
  cache.invalidate();
  assert.equal(cache.switchWindowRoute(), 'unknown');
  assert.equal(cache.isInitialized(), false);
});

test('adapter: 未配置时返回 internal_error', async () => {
  // 直接构造一个未 configure 的 adapter（绕过工厂）
  const { PhysicalExecutionAdapterImpl } = await import('../src/physicalExecution/adapter.ts');
  const adapter = new PhysicalExecutionAdapterImpl();
  const result = await adapter.health();
  assert.ok(!result.ok);
  if (result.ok) return;
  assert.equal(result.error.kind, 'internal_error');
});

test('adapter: 错误的 baseUrl 配置时 throw（加载层铁律）', async () => {
  assert.throws(
    () => createPhysicalExecution({
      baseUrl: 'ftp://invalid',
      timeoutMs: 1000,
      keyPath: '/tmp/dsh-test.key',
    } as any),
    /invalid configuration/,
  );
});
