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
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readShm, readShmStreaming, closeAllFds, allowMmapRoot } from '../src/physicalExecution/shmReader.ts';
import { resolvePythonBin } from '../src/physicalExecution/pythonBin.ts';
import type { ScreenshotResult } from '../src/physicalExecution/contracts.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'seed_screenshot.py');

interface SeededMeta extends ScreenshotResult {
  _expected_size: number;
}

/** 启动 Python fixture，写入 shm 并阻塞等待 stdin 关闭 */
function seedScreenshot(transport: 'mmap-file' | 'base64' | 'shm', mmapDir: string): {
  proc: ReturnType<typeof spawn>;
  metaPromise: Promise<SeededMeta>;
} {
  // ΠΑΝ-66：mmap-file 读取防线（白名单根 fail-closed）—— 测试种子目录须登记
  allowMmapRoot(mmapDir);
  const proc = spawn(resolvePythonBin(), [FIXTURE, transport, mmapDir], {
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
  // ΠΑΝ-66：路径须先落白名单根内（防线在 ENOENT 之前）—— 在已登记根内指向
  // 不存在文件，保持本例原意（对象已释放的 element_not_found 诚实归因）。
  const mmapDir = mkdtempSync(join(tmpdir(), 'dsh-shm-notfound-'));
  try {
    allowMmapRoot(mmapDir);
    const fakeMeta: ScreenshotResult = {
      transport: 'mmap-file',
      name: join(mmapDir, 'dsh-nonexistent-shm-test.bin'),
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
  } finally {
    rmSync(mmapDir, { recursive: true, force: true });
  }
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


// ─── ΤΕΛ-7b：mmap-file symlink 逃逸收口执法（F2-7/源注登记留白的清偿） ───
// 白名单根内的符号链接可指向根外任意文件（逻辑落根 ≠ 物理落根）。防线：
// resolve 落根后 realpath 再验白名单；realpath 失败 fail-closed（唯 ENOENT 放行
// 交由 open 的 element_not_found 诚实归因）。win32 无特权建目录 junction
// （reparse point），POSIX 用目录 symlink —— 两平台同一代码路径。

/** 造目录链接（win32: junction 免特权；其他平台: dir symlink） */
function linkDir(target: string, linkPath: string): void {
  if (process.platform === 'win32') symlinkSync(target, linkPath, 'junction');
  else symlinkSync(target, linkPath, 'dir');
}

function mmapMeta(name: string, size: number): ScreenshotResult {
  return {
    transport: 'mmap-file',
    name,
    size,
    shape: [size, 1, 1],
    dtype: 'uint8',
    stride: size,
    format: 'PNG',
    width: size,
    height: 1,
    captured_at: Date.now(),
    image_base64: '',
  };
}

test('ΤΕΛ-7b readShm: symlink escaping whitelisted root rejected (fail-closed)', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'dsh-shm-root-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'dsh-shm-outside-')); // 未登记根外目录
  try {
    allowMmapRoot(rootDir);
    const secret = Buffer.from('SECRET-BYTES-OUTSIDE-ROOT');
    writeFileSync(join(outsideDir, 'shot.bin'), secret);
    // 根内链接指向根外 —— 逻辑路径落根（旧防线放行），物理路径在外 ⇒ 必须拒绝
    linkDir(outsideDir, join(rootDir, 'escape-link'));
    await assert.rejects(
      () => readShm(mmapMeta(join(rootDir, 'escape-link', 'shot.bin'), secret.length)),
      (err: any) => {
        assert.ok(err && typeof err === 'object');
        assert.equal(err.kind, 'invalid_args', `symlink 逃逸须 invalid_args 拒绝，得 ${err.kind}: ${err.detail}`);
        assert.match(String(err.detail), /symlink|outside/, '拒绝理由须指明 symlink 逃逸/fail-closed');
        return true;
      },
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('ΤΕΛ-7b readShm: real file in root passes realpath check (no false rejection)', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'dsh-shm-root-ok-'));
  try {
    allowMmapRoot(rootDir);
    const payload = Buffer.from('PLAIN-BYTES-INSIDE-ROOT');
    writeFileSync(join(rootDir, 'shot.bin'), payload);
    const buf = await readShm(mmapMeta(join(rootDir, 'shot.bin'), payload.length));
    assert.equal(buf.toString('utf-8'), payload.toString('utf-8'), '根内真实文件须可读（realpath 对账不误伤）');
  } finally {
    await closeAllFds();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('ΤΕΛ-7b readShm: path through broken link rejects (never silently reads)', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'dsh-shm-root-broken-'));
  try {
    allowMmapRoot(rootDir);
    // 断链（指向不存在目录）：realpath ENOENT 放行 ⇒ open ENOENT ⇒ 归因
    // element_not_found（对象已释放语义）—— 唯一放行面，绝不静默成功
    linkDir(join(rootDir, 'no-such-target'), join(rootDir, 'broken-link'));
    await assert.rejects(
      () => readShm(mmapMeta(join(rootDir, 'broken-link', 'shot.bin'), 16)),
      (err: any) => {
        assert.ok(err && typeof err === 'object');
        assert.equal(err.kind, 'element_not_found', `断链须 element_not_found 归因，得 ${err.kind}: ${err.detail}`);
        return true;
      },
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ─── O 纪元（#2）：POSIX shm 分支实测 —— Linux CI 上 readShm 跨进程往返 ───

test('readShm: POSIX shm transport cross-process round trip (/dev/shm)', { skip: process.platform !== 'linux' ? 'POSIX shm 仅 Linux（/dev/shm）' : false }, async () => {
  const mmapDir = mkdtempSync(join(tmpdir(), 'dsh-shm-test-'));
  const { proc, metaPromise } = seedScreenshot('shm', mmapDir);
  try {
    const meta = await metaPromise;
    assert.equal(meta.transport, 'shm', 'POSIX shm 传输');
    assert.ok(meta.name, 'shm 对象名非空（/dev/shm 下）');
    assert.equal(meta.size, meta._expected_size);
    assert.equal(meta.format, 'PNG');

    // 跨进程往返：Python write_image 写 → Node readShm 读
    const buf = await readShm(meta);
    assert.equal(buf.length, meta._expected_size, '字节长度一致（跨进程往返无损）');
    assert.equal(buf[0], 0x89);
    assert.equal(buf[1], 0x50); // 'P'
    assert.equal(buf[2], 0x4e); // 'N'
    assert.equal(buf[3], 0x47); // 'G'

    // 流式读同律
    const chunks: Buffer[] = [];
    for await (const chunk of readShmStreaming(meta)) chunks.push(chunk);
    assert.equal(chunks.reduce((acc, c) => acc + c.length, 0), meta._expected_size, '流式往返无损');
  } finally {
    await teardown(proc);
    await closeAllFds();
    rmSync(mmapDir, { recursive: true, force: true });
  }
});
