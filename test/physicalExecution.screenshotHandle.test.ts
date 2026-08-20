// test/physicalExecution.screenshotHandle.test.ts
// 集成测试：验证 ScreenshotHandle 的 RAII 生命周期 (read / transfer / release / GC 兜底)。
//
// 测试链路：
//   1. 启动 Python fixture 写入测试图像
//   2. 用 mock adapter 包装 ScreenshotHandle
//   3. 验证：
//      - read() Lazy Buffer 缓存（多次调返回同一引用）
//      - stream() 分块产出
//      - transfer() 拿走 Buffer + handle 立即失效
//      - release() 幂等
//      - released 标志正确
//   4. 关闭 Python 子进程
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ScreenshotHandle, ScreenshotBatch } from '../src/physicalExecution/screenshotHandle.ts';
import type {
  ClickResult, DragResult, HealthInfo, HotkeyResult, PhysicalError,
  PhysicalExecutionAdapter, Result, ScreenshotResult, ScrollResult,
  SwitchWindowResult, TypeResult, UiTreeResult,
} from '../src/physicalExecution/contracts.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'seed_screenshot.py');

interface SeededMeta extends ScreenshotResult {
  _expected_size: number;
}

/** Mock adapter：记录 releaseShm 调用，模拟 Python 端 DELETE 行为 */
class MockAdapter implements PhysicalExecutionAdapter {
  public releasedNames: string[] = [];
  public releaseCallCount = 0;

  configure(): void { /* noop */ }
  async init(): Promise<Result<void, PhysicalError>> { return { ok: true, value: undefined }; }
  async health(): Promise<Result<HealthInfo, PhysicalError>> { return { ok: true, value: {} as HealthInfo }; }
  async clickMouse(): Promise<Result<ClickResult, PhysicalError>> { return { ok: true, value: {} as ClickResult }; }
  async typeText(): Promise<Result<TypeResult, PhysicalError>> { return { ok: true, value: {} as TypeResult }; }
  async scrollPage(): Promise<Result<ScrollResult, PhysicalError>> { return { ok: true, value: {} as ScrollResult }; }
  async pressHotkey(): Promise<Result<HotkeyResult, PhysicalError>> { return { ok: true, value: {} as HotkeyResult }; }
  async dragMouse(): Promise<Result<DragResult, PhysicalError>> { return { ok: true, value: {} as DragResult }; }
  async takeScreenshot(): Promise<Result<ScreenshotResult, PhysicalError>> { return { ok: true, value: {} as ScreenshotResult }; }
  async takeScreenshotHandle(): Promise<Result<ScreenshotHandle, PhysicalError>> { return { ok: true, value: {} as ScreenshotHandle }; }
  async getUiTree(): Promise<Result<UiTreeResult, PhysicalError>> { return { ok: true, value: {} as UiTreeResult }; }
  async switchWindow(): Promise<Result<SwitchWindowResult, PhysicalError>> { return { ok: true, value: {} as SwitchWindowResult }; }

  async releaseShm(name: string): Promise<Result<{ released: boolean }, PhysicalError>> {
    this.releaseCallCount++;
    this.releasedNames.push(name);
    return { ok: true, value: { released: true } };
  }

  reset(): void { /* noop */ }
}

function seedScreenshot(transport: 'mmap-file' | 'base64', mmapDir: string): {
  proc: ReturnType<typeof spawn>;
  metaPromise: Promise<SeededMeta>;
} {
  const proc = spawn('python3', [FIXTURE, transport, mmapDir], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const metaPromise = new Promise<SeededMeta>((resolve, reject) => {
    let buf = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        if (line) {
          try { resolve(JSON.parse(line) as SeededMeta); }
          catch (e: any) { reject(new Error(`Python fixture JSON parse failed: ${e.message}`)); }
        }
      }
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Python fixture exited with code ${code} before sending meta`));
      }
    });
  });
  return { proc, metaPromise };
}

async function teardown(proc: ReturnType<typeof spawn>): Promise<void> {
  try { proc.stdin?.end(); } catch { /* noop */ }
  await new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
    setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 3000).unref();
  });
}

test('ScreenshotHandle.read: Lazy Buffer 缓存（多次调返回同一引用）', async () => {
  const mmapDir = mkdtempSync(join(tmpdir(), 'dsh-handle-test-'));
  const { proc, metaPromise } = seedScreenshot('mmap-file', mmapDir);
  const adapter = new MockAdapter();
  try {
    const meta = await metaPromise;
    const handle = new ScreenshotHandle(meta, adapter);

    assert.equal(handle.released, false);
    const buf1 = await handle.read();
    const buf2 = await handle.read();
    assert.equal(buf1, buf2, 'read() must return cached Buffer on second call');
    assert.equal(buf1.length, meta._expected_size);
    assert.equal(buf1[0], 0x89); // PNG magic

    // 未 release：adapter 不应被调用
    assert.equal(adapter.releaseCallCount, 0);
  } finally {
    await teardown(proc);
  }
});

test('ScreenshotHandle.stream: 分块产出，总和等于 size', async () => {
  const mmapDir = mkdtempSync(join(tmpdir(), 'dsh-handle-test-'));
  const { proc, metaPromise } = seedScreenshot('mmap-file', mmapDir);
  const adapter = new MockAdapter();
  try {
    const meta = await metaPromise;
    const handle = new ScreenshotHandle(meta, adapter);

    const chunks: Buffer[] = [];
    for await (const chunk of handle.stream()) {
      chunks.push(chunk);
    }
    const total = chunks.reduce((acc, c) => acc + c.length, 0);
    assert.equal(total, meta._expected_size);
    assert.ok(chunks.length > 0);
    assert.equal(chunks[0][0], 0x89);
  } finally {
    await teardown(proc);
  }
});

test('ScreenshotHandle.transfer: 拿走 Buffer + handle 失效 + adapter.releaseShm 被调', async () => {
  const mmapDir = mkdtempSync(join(tmpdir(), 'dsh-handle-test-'));
  const { proc, metaPromise } = seedScreenshot('mmap-file', mmapDir);
  const adapter = new MockAdapter();
  try {
    const meta = await metaPromise;
    const handle = new ScreenshotHandle(meta, adapter);

    const buf = await handle.transfer();
    assert.equal(buf.length, meta._expected_size);
    assert.equal(buf[0], 0x89);

    // transfer 后 handle 失效
    assert.equal(handle.released, true);

    // 后续 read 应抛错
    await assert.rejects(
      () => handle.read(),
      /already released/,
    );

    // adapter.releaseShm 应被调一次（Python 端 DELETE）
    assert.equal(adapter.releaseCallCount, 1);
    assert.deepEqual(adapter.releasedNames, [meta.name]);
  } finally {
    await teardown(proc);
  }
});

test('ScreenshotHandle.release: 幂等，多次调用安全', async () => {
  const mmapDir = mkdtempSync(join(tmpdir(), 'dsh-handle-test-'));
  const { proc, metaPromise } = seedScreenshot('mmap-file', mmapDir);
  const adapter = new MockAdapter();
  try {
    const meta = await metaPromise;
    const handle = new ScreenshotHandle(meta, adapter);

    await handle.release();
    assert.equal(handle.released, true);

    // 二次 release 不抛错
    await handle.release();
    assert.equal(handle.released, true);

    // read 后抛错
    await assert.rejects(() => handle.read(), /already released/);

    // adapter.releaseShm 应被调一次（不是两次）
    assert.equal(adapter.releaseCallCount, 1);
  } finally {
    await teardown(proc);
  }
});

test('ScreenshotHandle: base64 模式不调 adapter.releaseShm（无外部资源）', async () => {
  const mmapDir = mkdtempSync(join(tmpdir(), 'dsh-handle-test-'));
  const { proc, metaPromise } = seedScreenshot('base64', mmapDir);
  const adapter = new MockAdapter();
  try {
    const meta = await metaPromise;
    assert.equal(meta.transport, 'base64');

    const handle = new ScreenshotHandle(meta, adapter);
    const buf = await handle.read();
    assert.equal(buf.length, meta._expected_size);

    await handle.release();
    // base64 模式无外部资源：adapter.releaseShm 不应被调
    assert.equal(adapter.releaseCallCount, 0);
  } finally {
    await teardown(proc);
  }
});

test('ScreenshotBatch: 批量管理多个 handle + releaseAll', async () => {
  const mmapDir = mkdtempSync(join(tmpdir(), 'dsh-batch-test-'));
  const { proc: proc1, metaPromise: p1 } = seedScreenshot('mmap-file', mmapDir);
  const { proc: proc2, metaPromise: p2 } = seedScreenshot('mmap-file', mmapDir);
  const adapter = new MockAdapter();
  try {
    const [m1, m2] = await Promise.all([p1, p2]);
    const batch = new ScreenshotBatch();
    const h1 = await batch.add(Promise.resolve(new ScreenshotHandle(m1, adapter)));
    const h2 = await batch.add(Promise.resolve(new ScreenshotHandle(m2, adapter)));

    const [b1, b2] = await Promise.all([h1.read(), h2.read()]);
    assert.equal(b1.length, m1._expected_size);
    assert.equal(b2.length, m2._expected_size);

    await batch.releaseAll();
    assert.equal(h1.released, true);
    assert.equal(h2.released, true);
    assert.equal(adapter.releaseCallCount, 2);
  } finally {
    await teardown(proc1);
    await teardown(proc2);
    rmSync(mmapDir, { recursive: true, force: true });
  }
});
