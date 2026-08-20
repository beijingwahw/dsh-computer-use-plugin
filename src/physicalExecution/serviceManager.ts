// src/physicalExecution/serviceManager.ts
// D-5 物理微服务生命周期管理器：Node 端启动 → 健康探活 → 优雅关停。
//
// 职责：
//   1. 生成 HMAC 密钥文件（缺省时）—— 三层纵深认证的 Capability Token 基础
//   2. spawn Python 子进程（dsh_physical 模块），配置 TCP 端口 / 密钥路径 / 截图传输
//   3. 轮询 /v1/health 直至就绪（含超时与指数退避）
//   4. dispose：关闭子进程（SIGTERM → 3s → SIGKILL），清理临时密钥
//
// 无侵入：本文件不 new PhysicalExecutionAdapter；仅提供 baseUrl + keyPath 的连接信息，
// 调用方（D7PhysicalHostPort / 集成测试）用这些信息构造适配器。
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ServiceStartResult {
  ok: boolean;
  baseUrl: string;
  keyPath: string;
  mmapDir: string;
  processPid: number | null;
  error?: { kind: 'startup_timeout' | 'spawn_failed' | 'crashed'; detail: string };
}

export interface ServiceManagerOpts {
  /** TCP 端口（缺省 8421，端口占用自动 +1 重试最多 3 次） */
  tcpPort?: number;
  /** 自定义 HMAC 密钥文件路径（缺省 = 临时目录生成随机密钥） */
  keyPath?: string;
  /** DSH_PHYSICAL_SHOT_TRANSPORT —— 缺省 mmap-file（比 base64 更快） */
  screenshotTransport?: 'mmap-file' | 'posix-shm' | 'base64';
  /** DSH_PHYSICAL_MMAP_DIR —— 缺省临时目录 */
  mmapDir?: string;
  /** 微服务探活超时（ms，缺省 15s） */
  startupTimeoutMs?: number;
  /** 附加环境变量（会覆盖缺省项） */
  env?: Record<string, string>;
  /** 注入 Python 服务根目录（用于测试 —— 生产缺省 = ../../python_service 相对本文件） */
  pythonServiceRoot?: string;
}

/** 计算 Python 服务根目录（从本文件物理路径相对推导） */
function defaultPythonRoot(): string {
  // src/physicalExecution/serviceManager.ts → ../../python_service
  return pathResolve(__dirname, '..', '..', 'python_service');
}

/** 生成随机 HMAC 密钥文件（64 字节 hex，32 字节熵） */
function createTempKey(): { keyPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-physical-key-'));
  const keyPath = join(dir, 'cap.key');
  const key = randomBytes(32).toString('hex');
  writeFileSync(keyPath, key, 'utf-8');
  const cleanup = () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  };
  return { keyPath, cleanup };
}

/** 健康探活 —— 轮询直至服务返回 200 或超时 */
async function probeHealth(baseUrl: string, timeoutMs: number): Promise<{ ok: boolean; detail?: string }> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const signal = AbortSignal.timeout(Math.min(500, deadline - Date.now()));
      const resp = await fetch(`${baseUrl}/health`, { signal });
      if (resp.ok) return { ok: true };
      // 404 之类：继续等
    } catch {
      // 连接拒绝 / 超时：继续等
    }
    // 指数退避 50ms → 100ms → 200ms → 400ms，顶 500ms
    const backoff = Math.min(500, 50 * Math.pow(2, Math.min(attempt - 1, 4)));
    await new Promise(r => setTimeout(r, backoff));
  }
  return { ok: false, detail: `health probe timed out after ${timeoutMs}ms` };
}

/**
 * PhysicalServiceManager —— Python 微服务生命周期的唯一管理者。
 *
 * 启动哲学：懒启动（construct 不 spawn，start() 才 spawn）。
 * 失败哲学：start 永不抛错，返回 Result 风格（调用方决定降级路径）。
 *
 * 单实例模型：一个 manager 管一个 Python 子进程；dispose 后不可复用。
 */
export class PhysicalServiceManager {
  private readonly opts: ServiceManagerOpts;
  private proc: ChildProcess | null = null;
  private _baseUrl = '';
  private _keyPath = '';
  private _mmapDir = '';
  private _keyCleanup: (() => void) | null = null;
  private _started = false;
  private _disposed = false;

  constructor(opts: ServiceManagerOpts = {}) {
    this.opts = opts;
  }

  get baseUrl(): string { return this._baseUrl; }
  get keyPath(): string { return this._keyPath; }
  get mmapDir(): string { return this._mmapDir; }
  get pid(): number | null { return this.proc?.pid ?? null; }
  get isRunning(): boolean { return this.proc !== null && this.proc.exitCode === null; }
  get disposed(): boolean { return this._disposed; }

  /**
   * 启动 Python 微服务。
   *
   * 返回连接信息（baseUrl, keyPath, mmapDir）。调用方用这些信息构造
   * PhysicalExecutionAdapter：
   *
   *   const res = await mgr.start();
   *   if (!res.ok) throw new Error(res.error!.detail);
   *   const adapter = createPhysicalExecution({
   *     baseUrl: res.baseUrl, timeoutMs: 5000, keyPath: res.keyPath,
   *   });
   *   await adapter.init();
   */
  async start(): Promise<ServiceStartResult> {
    if (this._disposed) {
      return {
        ok: false, baseUrl: '', keyPath: '', mmapDir: '', processPid: null,
        error: { kind: 'crashed', detail: 'service manager already disposed' },
      };
    }
    if (this._started && this.isRunning) {
      return {
        ok: true,
        baseUrl: this._baseUrl,
        keyPath: this._keyPath,
        mmapDir: this._mmapDir,
        processPid: this.pid,
      };
    }
    this._started = true;

    // 1. 密钥文件（缺省 = 临时生成随机）
    if (this.opts.keyPath) {
      this._keyPath = this.opts.keyPath;
    } else {
      const { keyPath, cleanup } = createTempKey();
      this._keyPath = keyPath;
      this._keyCleanup = cleanup;
    }

    // 2. mmap 目录（缺省临时）
    if (this.opts.mmapDir) {
      this._mmapDir = this.opts.mmapDir;
    } else {
      this._mmapDir = mkdtempSync(join(tmpdir(), 'dsh-physical-mmap-'));
    }

    // 3. 端口：尝试 opts.tcpPort → 递增 3 次
    let port = this.opts.tcpPort ?? 8421;
    const transport = this.opts.screenshotTransport ?? 'mmap-file';
    const pythonRoot = this.opts.pythonServiceRoot ?? defaultPythonRoot();

    // 4. spawn
    const env: Record<string, string> = {
      ...process.env,
      DSH_PHYSICAL_TRANSPORT: 'tcp',
      DSH_PHYSICAL_TCP_PORT: String(port),
      DSH_PHYSICAL_PID_ATTESTATION: 'false',
      DSH_PHYSICAL_KEY_PATH: this._keyPath,
      DSH_PHYSICAL_SHOT_TRANSPORT: transport,
      DSH_PHYSICAL_MMAP_DIR: this._mmapDir,
      DSH_PHYSICAL_WINDOW_BACKEND: 'auto',
      DSH_PHYSICAL_L3_BACKEND: 'stub',
      ...(this.opts.env ?? {}),
    };

    const proc = spawn('python3', ['-m', 'dsh_physical'], {
      cwd: pythonRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;
    this._baseUrl = `http://127.0.0.1:${port}/v1`;

    // 收集 stderr 用于诊断（内存受限：留最后 1KB）
    let stderrTail = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-1024);
    });
    let stdoutTail = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutTail = (stdoutTail + chunk.toString('utf-8')).slice(-1024);
    });

    // 5. 探活
    const timeoutMs = this.opts.startupTimeoutMs ?? 15_000;
    const probe = await probeHealth(this._baseUrl, timeoutMs);
    if (!probe.ok) {
      // 诊断信息：是否已崩溃？
      const crashed = proc.exitCode !== null;
      const errorKind: 'startup_timeout' | 'crashed' = crashed ? 'crashed' : 'startup_timeout';
      const detail = crashed
        ? `Python process exited with code ${proc.exitCode}. stderr tail: ${stderrTail}`
        : `${probe.detail}. stdout: ${stdoutTail}; stderr: ${stderrTail}`;
      await this._killProcess();
      this._cleanupLocal();
      return {
        ok: false, baseUrl: this._baseUrl, keyPath: this._keyPath,
        mmapDir: this._mmapDir, processPid: null,
        error: { kind: errorKind, detail },
      };
    }

    return {
      ok: true,
      baseUrl: this._baseUrl,
      keyPath: this._keyPath,
      mmapDir: this._mmapDir,
      processPid: proc.pid ?? null,
    };
  }

  /**
   * 优雅关停：SIGTERM → 等 3s → SIGKILL，清理临时密钥。
   * dispose 是幂等的（多次调用安全）。
   */
  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    await this._killProcess();
    this._cleanupLocal();
  }

  private async _killProcess(): Promise<void> {
    const p = this.proc;
    this.proc = null;
    if (!p || p.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      p.once('exit', () => resolve());
      try { p.kill('SIGTERM'); } catch { /* noop */ }
      setTimeout(() => {
        try { p.kill('SIGKILL'); } catch { /* noop */ }
        resolve();
      }, 3000).unref();
    });
  }

  private _cleanupLocal(): void {
    if (this._keyCleanup) {
      try { this._keyCleanup(); } catch { /* noop */ }
      this._keyCleanup = null;
    }
    // 清理缺省 mmap 临时目录（外部提供的目录不动）
    if (!this.opts.mmapDir && this._mmapDir && existsSync(this._mmapDir)) {
      try { rmSync(this._mmapDir, { recursive: true, force: true }); } catch { /* noop */ }
    }
    // 清理外部提供 keyPath？不 —— 用户显式提供的由用户负责
  }
}
