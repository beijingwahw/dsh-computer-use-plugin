// test/physicalExecution.shmReader.test.ts
// 集成测试：验证 Node 端 shmReader 能跨进程读取 Python 端写入的 shm / mmap-file 对象。
//
// 测试链路：
//   1. 启动 Python 子进程（test/fixtures/seed_screenshot.py）
//   2. Python 用 dsh_physical.shm.write_image 写入一张确定性 PNG（128x128 红蓝块）
//   3. Python 输出 ScreenshotResult JSON 到 stdout
//   4. Node 调 readShm(meta) 读出字节
//   5. 校验：字节数 = expected_size；首字节 = PNG magic number (0x89)
//   6. 测试结束关闭 Python 子进程 stdin → Python 退出 → mmap 释放
//
// 本测试不依赖 FastAPI 服务、pyautogui 或 X server —— 直接验证跨进程契约。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readShm, readShmStreaming, closeAllFds } from '../src/physicalExecution/shmReader.ts';
import type { ScreenshotResult } from '../src/physicalExecution/contracts.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'seed_screenshot.py');

interface SeededMeta extends ScreenshotResult {
  _expected_size: number;
}

/** 启动 Python fixture，写入 shm 并阻塞等待 stdin 关闭 */
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
          try {
            resolve(JSON.parse(line) as SeededMeta);
          } catch (e: any) {
            reject(new Error(`Python fixture JSON parse failed: ${e.message}`));
          }
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

/** 优雅关闭 Python 子进程：关闭 stdin → Python 退出 → mmap 释放 */
async function teardown(proc: ReturnType<typeof spawn>): Promise<void> {
  try {
    proc.stdin?.end();
  } catch { /* noop */ }
  await new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
    setTimeout(() => {
      proc.kill('SIGKILL');
      resolve();
    }, 3000).unref();
  });
}

test('readShm: mmap-file transport reads bytes written by Python', async () => {
  const mmapDir = mkdtempSync(join(tmpdir(), 'dsh-shm-test-'));
  const { proc, metaPromise } = seedScreenshot('mmap-file', mmapDir);
  try {
    const meta = await metaPromise;
    assert.equal(meta.transport, 'mmap-file');
    assert.ok(meta.name, 'name (file path) must be non-empty');
    assert.equal(meta.size, meta._expected_size);
    assert.equal(meta.format, 'PNG');
    assert.equal(meta.width, 128);
    assert.equal(meta.height, 128);

    // 读出字节
    const buf = await readShm(meta);
    assert.equal(buf.length, meta._expected_size, 'byte length must match expected');
    // PNG magic number: 89 50 4E 47 0D 0A 1A 0A
    assert.equal(buf[0], 0x89);
    assert.equal(buf[1], 0x50); // 'P'
    assert.equal(buf[2], 0x4e); // 'N'
    assert.equal(buf[3], 0x47); // 'G'
  } finally {
    await teardown(proc);
    await closeAllFds();
    rmSync(mmapDir, { recursive: true, force: true });
  }
});

test('readShmStreaming: mmap-file transport yields chunks summing to full image', async () => {
  const mmapDir = mkdtempSync(join(tmpdir(), 'dsh-shm-test-'));
  const { proc, metaPromise } = seedScreenshot('mmap-file', mmapDir);
  try {
    const meta = await metaPromise;

    // 流式读：累积 chunks
    const chunks: Buffer[] = [];
    for await (const chunk of readShmStreaming(meta)) {
      chunks.push(chunk);
    }
    const total = chunks.reduce((acc, c) => acc + c.length, 0);
    assert.equal(total, meta._expected_size, 'streamed total bytes must match');

    // 校验首 chunk 的 PNG magic
    assert.ok(chunks.length > 0);
    assert.equal(chunks[0][0], 0x89);
  } finally {
    await teardown(proc);
    await closeAllFds();
    rmSync(mmapDir, { recursive: true, force: true });
  }
});

test('readShm: base64 transport decodes inline image_base64', async () => {
  const mmapDir = mkdtempSync(join(tmpdir(), 'dsh-shm-test-'));
  const { proc, metaPromise } = seedScreenshot('base64', mmapDir);
  try {
    const meta = await metaPromise;
    assert.equal(meta.transport, 'base64');
    assert.ok(meta.image_base64, 'base64 transport must have non-empty image_base64');
    assert.equal(meta.name, '', 'base64 transport name should be empty');

    const buf = await readShm(meta);
    assert.equal(buf.length, meta._expected_size);
    assert.equal(buf[0], 0x89);
  } finally {
    await teardown(proc);
    await closeAllFds();
    rmSync(mmapDir, { recursive: true, force: true });
  }
});

test('readShm: error when name not found (already released)', async () => {
  const fakeMeta: ScreenshotResult = {
    transport: 'mmap-file',
    name: '/tmp/dsh-nonexistent-shm-test.bin',
    size: 100,
    shape: [10, 10, 3],
    dtype: 'uint8',
    stride: 30,
    format: 'PNG',
    width: 10,
    height: 10,
    captured_at: Date.now(),
    image_base64: '',
  };
  await assert.rejects(
    () => readShm(fakeMeta),
    (err: any) => {
      // PhysicalError 对象（不抛 Error 实例，是普通对象）
      assert.ok(err && typeof err === 'object');
      assert.ok(err.kind === 'element_not_found' || err.kind === 'screen_capture_failed',
        `unexpected error kind: ${err.kind}`);
      return true;
    },
  );
});

test('readShm: invalid_args when base64 transport has empty image_base64', async () => {
  const fakeMeta: ScreenshotResult = {
    transport: 'base64',
    name: '',
    size: 0,
    shape: [0, 0, 3],
    dtype: 'uint8',
    stride: 0,
    format: 'PNG',
    width: 0,
    height: 0,
    captured_at: Date.now(),
    image_base64: '',
  };
  await assert.rejects(
    () => readShm(fakeMeta),
    (err: any) => {
      assert.equal(err.kind, 'invalid_args');
      return true;
    },
  );
});
