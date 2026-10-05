// src/physicalExecution/serviceManager.ts
// D-5 物理微服务生命周期管理器：Node 端启动 → 健康探活 → 优雅关停。
//
// 职责：
//   1. 生成 HMAC 密钥文件（缺省时）—— 三层纵深认证的 Capability Token 基础
//   2. spawn Python 子进程（dsh_physical 模块），配置 TCP 端口 / 密钥路径 / 截图传输
//   3. 轮询 /v1/health 直至就绪（含超时与指数退避；Δ 纪元：包体校验 ——
//      2xx + 信封 success + pid 吻合才算就绪，子进程死亡立即早退；Σ 纪元：
//      nonce 质询应答 —— 探活附随机 nonce，服务用共享密钥 HMAC 回签，验签
//      通过即证应答者持有本回合密钥 ⇒ pid 漂移也放行，根治 Windows Python
//      启动器 re-exec 的「spawn pid ≠ 上报 pid」盲区误判 port_squatted）
//   4. dispose：关闭子进程（SIGTERM → 3s → SIGKILL），清理临时密钥
//
// 无侵入：本文件不 new PhysicalExecutionAdapter；仅提供 baseUrl + keyPath 的连接信息，
// 调用方（D7PhysicalHostPort / 集成测试）用这些信息构造适配器。
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { resolvePythonBin } from './pythonBin.js';
import { ensureKey, mintToken } from './capToken.js';
import { ALL_CAPS } from './contracts.js';
import { allowMmapRoot } from './shmReader.js'; // ΠΑΝ-66：spawn 时登记 mmap 白名单根

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── ΑΩ-R27 端口策略单源 —— 全库唯一的 D-5 微服务 TCP 端口/跨度事实源 ───
// 双策略有意并存（不合并 —— 消费场景与密钥形态不同，统一即回归，证据见表下）：
//
//   消费方                          | 端口策略                         | 密钥形态
//   --------------------------------+----------------------------------+------------------------
//   PhysicalServiceManager 本模块   | 单端口 PHYSICAL_TCP_BASE_PORT，  | 每回合随机临时密钥
//   （D7PhysicalHostPort / 集成测试 | 无自动重试；占坑 ⇒ 如实快报      | （createTempKey）
//   经 opts 走此路）                | port_squatted / startup_timeout  |
//   physicalBackend（D-1 工具层，   | BASE..BASE+SPAN-1 逐端口扫描     | 稳定密钥 ~/.dsh/physical.key
//   经 import 引用本常量）          | （PHYSICAL_TCP_PORT_SPAN）+      | （插件重载后 HMAC 令牌
//                                  | 同密钥收养（adoptExisting）      | 互通 ⇒ 收养可能成立）
//
// 为什么不同（= 「不可安全统一」的证据）：
//   - manager 场景每回合 spawn 配新随机密钥 ⇒ 别端口上的任何存活服务都过不了
//     Σ 纪元 nonce 质询（无共享密钥）—— 收养扫描对它永远空手而归；且「占坑者
//     如实快报」是 Δ 纪元契约（epochDelta.infra 执法在册），把扫描重试搬进来
//     会把「配错端口/陌生占坑」静默吞掉，属行为回归。
//   - backend 场景插件热重载后旧服务仍持同一稳定密钥活着 ⇒ 收养是唯一正确动作
//     （省一次 spawn + 15-20s 探活）；仅当端口被外部实例（密钥不通）占据时才
//     顺延下一端口。
export const PHYSICAL_TCP_BASE_PORT = 8421;
/** D-1 physicalBackend 的逐端口扫描跨度：探测范围 = BASE .. BASE+SPAN-1（8421..8428） */
export const PHYSICAL_TCP_PORT_SPAN = 8;

export interface ServiceStartResult {
  ok: boolean;
  baseUrl: string;
  keyPath: string;
  mmapDir: string;
  processPid: number | null;
  error?: { kind: 'startup_timeout' | 'spawn_failed' | 'crashed' | 'port_squatted'; detail: string };
}

export interface ServiceManagerOpts {
  /** TCP 端口（缺省 = PHYSICAL_TCP_BASE_PORT（8421）；被占用时不自动重试 ——
   *   Δ 纪元：占坑者应答健康但 pid/nonce 质询不吻合时如实快报 port_squatted，
   *   探活超时如实报 startup_timeout。双策略对照见文件头 ΑΩ-R27 端口策略单源） */
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
  // mode 0600：仅属主可读写（POSIX 生效；Windows 上无害忽略）。与 Python 端
  // auth.ensure_key 的 O_CREAT 0600、capToken.ensureKey 的 writeFile {mode:0o600}
  // 同一收口纪律 —— HMAC 密钥是三层纵深认证的信任根，落盘权限不得停留在 umask 缺省
  writeFileSync(keyPath, key, { encoding: 'utf-8', mode: 0o600 });
  const cleanup = () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  };
  return { keyPath, cleanup };
}

/**
 * 健康包体裁决（Δ 纪元纯函数 —— 单测直接点名，不 mock fetch/spawn）：
 *   - 'healthy'  ：信封 status==='success'，且满足下列之一：
 *       · Σ 纪元：data.proof 在场且与本端期望 HMAC 回签一致（nonce 质询
 *         应答）—— 密钥持有者必是自己人，pid 不匹配也放行（根治启动器
 *         re-exec 形态下 spawn pid ≠ 服务上报 pid 的盲区误判）；
 *       · data 无 pid —— 老版本服务按现状放行；
 *       · data.pid 与本 manager spawn 的子进程 pid 吻合（Δ 纪元 pid 等值判定）。
 *   - 'wait'     ：包体不可解析 / 信封非 success —— 服务未就绪，继续等
 *   - 'squatted' ：应答者证明了自己不是本回合 spawn 的服务 ——
 *       · proof 在场但验签失败（质询应答失败：占坑者无共享密钥，给不出
 *         正确回签）；
 *       · proof 缺席且 data.pid 与期望不符（旧形态 pid 不吻合）—— detail
 *         附 DSH_PYTHON 启动器形态提示（Δ 终审留案兑现：该提示只留在
 *         proof 缺席的旧形态错误里 —— 有质询后启动器形态本就能验签通过）。
 */
export type HealthBodyVerdict =
  | { verdict: 'healthy' }
  | { verdict: 'wait' }
  | { verdict: 'squatted'; reportedPid: number; expectedPid: number; detail?: string };

export function judgeHealthBody(
  body: unknown,
  expectedPid: number | null,
  expectedProof?: string | null,
): HealthBodyVerdict {
  if (body === null || typeof body !== 'object') return { verdict: 'wait' };
  const envelope = body as { status?: unknown; data?: unknown };
  if (envelope.status !== 'success') return { verdict: 'wait' };
  const data = envelope.data !== null && typeof envelope.data === 'object'
    ? (envelope.data as { pid?: unknown; proof?: unknown })
    : null;
  const pid = data?.pid;
  const pidFinite = typeof pid === 'number' && Number.isFinite(pid);

  // Σ 纪元：nonce 质询应答 —— proof 在场 ⇒ 验签优先于 pid 等值判定。
  // 每次探活随机发难，服务用共享密钥 HMAC 回签；回签不泄密钥（HMAC 单向），
  // 无密钥的占坑者给不出正确回签 —— pid 可能漂移/撞库，密钥无法伪造。
  const proof = data?.proof;
  if (typeof proof === 'string' && proof.length > 0) {
    const verified = typeof expectedProof === 'string'
      // timingSafeEqual 长度不等即抛 —— 先守长度再恒定时间比对（绝不炸）
      && expectedProof.length === proof.length
      && timingSafeEqual(Buffer.from(proof, 'utf-8'), Buffer.from(expectedProof, 'utf-8'));
    if (verified) {
      // 验签通过 ⇒ 密钥持有者必是自己人 —— pid 不匹配也放行（盲区根治）
      return { verdict: 'healthy' };
    }
    return {
      verdict: 'squatted',
      reportedPid: pidFinite ? pid : -1,
      expectedPid: expectedPid ?? -1,
      detail: typeof expectedProof === 'string'
        ? '质询应答失败：密钥不持有（health 回执 proof 与本回合期望 HMAC 回签不符）'
        : '质询应答失败：本端密钥不可用，无法验证应答者的 proof',
    };
  }

  // proof 缺席（旧版服务）⇒ 退回 Δ 纪元 pid 等值判定（现状语义原样保留）
  if (!pidFinite) {
    // 老版本服务（无 pid 字段）按现状放行 —— 版本收养闸门由 physicalBackend
    // 的 MIN_SVC_VERSION 另行把守，这里不立第二道版本墙（别破坏收养语义）。
    return { verdict: 'healthy' };
  }
  if (expectedPid !== null && pid !== expectedPid) {
    return {
      verdict: 'squatted',
      reportedPid: pid,
      expectedPid,
      detail: `health body reported pid ${pid} but spawned child pid is ${expectedPid}` +
        ' — 若为 Windows Python 启动器（PythonManager/py 别名）安装形态，启动器会' +
        ' re-exec 真实解释器致 pid 漂移，可设 DSH_PYTHON 指向真实解释器' +
        '（如 C:\\Python312\\python.exe）；否则为陌生占坑者，请停掉它或另选 tcpPort',
    };
  }
  return { verdict: 'healthy' };
}

/** 健康探活 —— 轮询直至包体证明就绪，或超时 / 子进程死亡 / 查明占坑者。
 *  Σ 纪元：key 在场 ⇒ 每次探测附随机 nonce 质询，本地算期望回签交
 *  judgeHealthBody 验（密钥持有 = 自己人，pid 漂移也放行）；key 缺席 ⇒
 *  不发 nonce、纯 pid 判定（旧 Δ 语义，向后兼容老服务）。 */
async function probeHealth(
  baseUrl: string,
  timeoutMs: number,
  child?: ChildProcess | null,
  key?: Uint8Array | null,
  spawnFailed?: () => string | null,
): Promise<{ ok: boolean; squatted?: { reportedPid: number; expectedPid: number }; detail?: string }> {
  const expectedPid = child?.pid ?? null;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    // Δ 纪元：子进程已死 ⇒ 立即失败早退 —— 傻等满超时只会把崩溃伪装成超时
    // （信号致死时 exitCode 为 null 而 signalCode 非 null —— 两者都查，缺一漏判）
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      return { ok: false, detail: `python process exited during health probe (exit code ${child.exitCode}, signal ${child.signalCode})` };
    }
    if (spawnFailed?.()) {
      return { ok: false, detail: `python process failed to spawn: ${spawnFailed()}` };
    }
    attempt++;
    try {
      const signal = AbortSignal.timeout(Math.min(500, deadline - Date.now()));
      // Σ 纪元：nonce 质询 —— hex 随机串本身 URL 安全，无需转义。
      // 老服务无 nonce 参数 ⇒ 忽略之，走 pid 路径（向后兼容）。
      const nonce = key ? randomBytes(16).toString('hex') : null;
      const url = nonce ? `${baseUrl}/health?nonce=${nonce}` : `${baseUrl}/health`;
      // 防重放配套：健康探活也带 X-Request-Id（/v1/health 虽在免鉴权白名单，
      // 但统一请求入口纪律 = 所有请求都带；未来 nonce 校验扩到任何端点也不破）
      const resp = await fetch(url, {
        signal,
        headers: { 'X-Request-Id': randomUUID() },
      });
      if (resp.ok) {
        // Δ 纪元：包体校验 —— 2xx 只证明「端口有人应答」，不证明应答者是本
        // manager spawn 的子进程。Σ 纪元升级：nonce 回签验签（密钥持有 =
        // 自己人）优先；proof 缺席退回信封 success + pid 吻合（或老版本无
        // pid）判定；两者皆败 ⇒ 占坑者在场，如实快报（不再误收养）。
        let body: unknown = null;
        try { body = await resp.json(); } catch { /* 非 JSON 包体：视同未就绪，继续等 */ }
        const expectedProof = nonce && key
          ? createHmac('sha256', Buffer.from(key)).update(nonce, 'utf-8').digest('hex')
          : null;
        const verdict = judgeHealthBody(body, expectedPid, expectedProof);
        if (verdict.verdict === 'healthy') return { ok: true };
        if (verdict.verdict === 'squatted') {
          return {
            ok: false,
            squatted: { reportedPid: verdict.reportedPid, expectedPid: verdict.expectedPid },
            detail: verdict.detail,
          };
        }
        // 'wait'：信封非 success —— 继续等
      }
      // 404 之类：继续等
    } catch {
      // 连接拒绝 / 超时：继续等
    }
    // T 纪元（T-4）：全抖动指数退避（AWS Architecture Blog 上的经典形态）——
    // sleep = uniform(0, min(cap, base·2^n))。定值退避使并发等待者的重试
    // 同相位共振（惊群）；全抖动把重试相位打散 —— 多实例/重启风暴下探测
    // 均值不变、方差吃掉相关性。
    const cap = Math.min(500, 50 * Math.pow(2, Math.min(attempt - 1, 4)));
    const backoff = Math.random() * cap;
    await new Promise(r => setTimeout(r, backoff));
  }
  return { ok: false, detail: `health probe timed out after ${timeoutMs}ms` };
}

// ─── ΝΩ-27：优雅关停序列（HTTP shutdown 优先，信号链兜底）───

/** HTTP /v1/shutdown 请求超时（ms）—— 端点应答是快路径（置位即回）；
 *  卡死服务不必等满。 */
export const SHUTDOWN_HTTP_TIMEOUT_MS = 1_500;

/** HTTP ack 后的自退宽限（ms）—— 覆盖服务侧排空上限（3s）+ uvicorn 关停/
 *  lifespan 清理余量。宽限内不发任何信号：Windows 上 SIGTERM 即
 * TerminateProcess 硬杀，ack 后立即发信号会把服务侧排空窗打回原形。 */
export const SHUTDOWN_GRACE_MS = 3_500;

/** stopChildProcess 的子进程面（ChildProcess 结构子集 —— 测试可注入 fake；
 *  kill 参数取 string|number 并集：与 ChildProcess.kill(NodeJS.Signals|number)
 *  双向结构兼容） */
export interface StoppableChild {
  pid?: number;
  exitCode: number | null;
  signalCode: string | null;
  kill(signal?: string | number): boolean;
  once(event: 'exit', listener: () => void): unknown;
}

/**
 * ΝΩ-27：关停序列编排（导出：测试面）——
 *   1. 先 HTTP 优雅关停（requestGracefulShutdown ⇒ 是否 ack）；
 *   2. ack ⇒ 宽限窗（graceMs）等自退 —— 期内不发信号；
 *   3. 无 ack / 宽限到期仍未退 ⇒ 既有 SIGTERM → sigkillMs → SIGKILL 链
 *      （未 ack 时 graceMs=0，SIGTERM 即发 + 3s 后 SIGKILL —— 与旧
 *      _killProcess 行为逐字节等价，零回归）。
 * 前置同旧律：pid 缺席（spawn 未成）或进程已退（exitCode/signalCode 在场）
 * ⇒ 无可杀进程，直接返回。永不抛错；'exit' 一到即清计时器 resolve
 * （不对可能被复用的 pid 补发信号）。
 */
export async function stopChildProcess(
  child: StoppableChild,
  requestGracefulShutdown: () => Promise<boolean>,
  timings: { graceMs?: number; sigkillMs?: number } = {},
): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  let acked = false;
  try {
    acked = await requestGracefulShutdown();
  } catch { /* HTTP 关停失败不阻断 —— 退化信号链 */ }
  const graceMs = acked ? (timings.graceMs ?? SHUTDOWN_GRACE_MS) : 0;
  const sigkillMs = timings.sigkillMs ?? 3_000;
  await new Promise<void>((resolve) => {
    const sigterm = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* noop */ }
    }, graceMs);
    sigterm.unref?.();
    const killer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      resolve();
    }, graceMs + sigkillMs);
    killer.unref?.();
    child.once('exit', () => {
      clearTimeout(sigterm); // 进程已退：不得再对可能被复用的 pid 补发信号
      clearTimeout(killer);
      resolve();
    });
  });
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
  /** 在飞的 start 调用（并发 start 汇流到同一次 spawn + 探活；失败即归零可重试） */
  private _startPromise: Promise<ServiceStartResult> | null = null;

  constructor(opts: ServiceManagerOpts = {}) {
    this.opts = opts;
  }

  get baseUrl(): string { return this._baseUrl; }
  get keyPath(): string { return this._keyPath; }
  get mmapDir(): string { return this._mmapDir; }
  get pid(): number | null { return this.proc?.pid ?? null; }
  get isRunning(): boolean { return this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null; }
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
    // 启动竞态：并发 start 必须汇流到同一次 spawn + 探活。未汇流时后来者会在
    // 首调用探活期间闯入：要么在探活窗（isRunning 已真但服务未就绪）提前返回
    // 未经验证的 ok，要么走重生路径重复 spawn 并被首调用的失败清场误杀新进程
    // （_killProcess 按当前 this.proc 行事）。失败后 _startPromise 归零，可重试。
    if (this._startPromise) return this._startPromise;
    if (this._started && this.isRunning) {
      return {
        ok: true,
        baseUrl: this._baseUrl,
        keyPath: this._keyPath,
        mmapDir: this._mmapDir,
        processPid: this.pid,
      };
    }
    const run = this._spawnAndProbe();
    this._startPromise = run;
    try {
      return await run;
    } finally {
      if (this._startPromise === run) this._startPromise = null;
    }
  }

  private async _spawnAndProbe(): Promise<ServiceStartResult> {
    // 重生路径（进程崩溃后再 start）先清理上一轮的临时密钥/mmap 目录 —— 否则
    // 旧目录被覆盖引用后永久泄漏在 tmp 里。首次 start（_started=false）天然
    // 跳过；复用路径在 start() 的 isRunning 分支提前返回
    const respawn = this._started;
    this._started = true;
    if (respawn) {
      this._cleanupLocal();
    }
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
    // ΠΑΝ-66（mmap-file 路径校验）：manager 明知 mmapDir ⇒ spawn 即登记进
    // shmReader 读取侧白名单 —— 服务端返回的截图路径必须落在该目录内才可
    // fs.open（fail-closed；缺省传输的路径遍历防线由此闭合）。登记幂等、
    // 失败无害（读取侧仍有约定根 + fail-closed 兜底）。
    try { allowMmapRoot(this._mmapDir); } catch { /* noop */ }

    // 3. 端口（单一端口，无自动重试 —— 占用时如实快报；缺省值单源于
    //    ΑΩ-R27 端口策略常量，策略对照见文件头注释块）
    const port = this.opts.tcpPort ?? PHYSICAL_TCP_BASE_PORT;
    const transport = this.opts.screenshotTransport ?? 'mmap-file';
    const pythonRoot = this.opts.pythonServiceRoot ?? defaultPythonRoot();

    // 4. spawn
    // 认证降级修复：不再强制 DSH_PHYSICAL_PID_ATTESTATION=false。旧代码在 spawn
    // 时一刀切关闭 PID 证明 ⇒ TCP 模式下无 peer_pid，三层纵深认证实际只剩单因素
    // HMAC。现在把开关还给 Python 端按传输能力/平台自行决定（config.py 缺省 =
    // sys.platform=='linux'：Linux 上启用 /proc 存在性证明与 UDS SO_PEERCRED
    // peer_pid 逐位比对；Windows TCP 无此层，由 Python 端诚实降级）。
    // 安全性论证：token.pid 本端铸的是 process.pid（真实连接进程）⇒ UDS+Linux
    // 的 peer_pid 逐位比对天然吻合；Linux TCP 的 /proc/<pid>/exe 存在性校验也
    // 通过（Node 进程活着）。若调用方确需关闭（如多进程共享一服务的诊断场景），
    // 经 opts.env 显式传入 DSH_PHYSICAL_PID_ATTESTATION=false 即可。
    const env: Record<string, string> = {
      ...process.env,
      DSH_PHYSICAL_TRANSPORT: 'tcp',
      DSH_PHYSICAL_TCP_PORT: String(port),
      DSH_PHYSICAL_KEY_PATH: this._keyPath,
      DSH_PHYSICAL_SHOT_TRANSPORT: transport,
      DSH_PHYSICAL_MMAP_DIR: this._mmapDir,
      DSH_PHYSICAL_WINDOW_BACKEND: 'auto',
      DSH_PHYSICAL_L3_BACKEND: 'stub',
      ...(this.opts.env ?? {}),
    };

    const proc = spawn(resolvePythonBin(), ['-m', 'dsh_physical'], {
      cwd: pythonRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // spawn 失败（如解释器路径不存在）以异步 'error' 事件到达 —— 必须监听：
    // 无监听的 'error' 会成为 uncaught exception 炸掉宿主进程，且
    // ServiceStartResult 的 'spawn_failed' 形态将永不可达。
    // 用 on 而非 once：kill() 对已死/未 spawn 成功的进程也会 emit 'error'
    // （ESRCH 等）—— 一次性监听被 spawn 错误消费后，后续 emit 无人接 ⇒ uncaught
    let spawnError: string | null = null;
    proc.on('error', (err: Error) => { spawnError = err.message; });
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

    // 5. 探活（Δ 纪元：传入子进程 —— 死亡早退 + 包体 pid 校验；
    //    Σ 纪元：传入共享密钥 —— nonce 质询应答式服务身份证明）
    const timeoutMs = this.opts.startupTimeoutMs ?? 15_000;
    // Σ 纪元：读取共享密钥 —— 与 Python 端同一密钥文件（DSH_PHYSICAL_KEY_PATH），
    // capToken.ensureKey 与 auth.ensure_key 字节级一致（文件原样字节即 HMAC key）。
    // 读取失败 ⇒ key=null 退回 pid-only 判定（旧 Δ 语义），绝不抛（start 永不抛错铁律）。
    let key: Uint8Array | null = null;
    try {
      key = await ensureKey(this._keyPath);
    } catch { /* 密钥不可读：降级 pid-only 判定 */ }
    const probe = await probeHealth(this._baseUrl, timeoutMs, proc, key, () => spawnError);
    if (!probe.ok) {
      // 诊断信息：spawn 失败？被占坑？已崩溃？
      const squatted = probe.squatted;
      const crashed = proc.exitCode !== null || proc.signalCode !== null;
      const errorKind: 'startup_timeout' | 'spawn_failed' | 'crashed' | 'port_squatted' =
        spawnError !== null ? 'spawn_failed'
          : squatted ? 'port_squatted'
          : crashed ? 'crashed'
          : 'startup_timeout';
      const detail = spawnError !== null
        ? `Python process failed to spawn: ${spawnError} (check DSH_PYTHON / resolvePythonBin resolution). stderr tail: ${stderrTail}`
        : squatted
          ? `tcp port ${port} is held by a foreign process (health reported pid ${squatted.reportedPid}, ` +
            `expected spawned child pid ${squatted.expectedPid}) — refusing to adopt a stranger; ` +
            `stop the squatter or choose another tcpPort. ${probe.detail ?? ''}`
          : crashed
            ? `Python process exited with code ${proc.exitCode}${proc.signalCode ? ` (signal ${proc.signalCode})` : ''}. stderr tail: ${stderrTail}`
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
   * 优雅关停：ΝΩ-27 —— 先 HTTP ``POST /v1/shutdown``（服务自排空在途 ≤3s +
   * lifespan 清理后自退），再退化为既有 SIGTERM → 3s → SIGKILL 链。
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
    if (!p) return;
    // ΝΩ-27：关停序列单源（stopChildProcess）—— HTTP 优雅 ack ⇒ 宽限窗等
    // 自退（Windows 上 SIGTERM 即 TerminateProcess 硬杀，ack 后立即发信号
    // 会把服务侧 3s 排空窗打回原形）；无 ack/宽限超时 ⇒ 既有信号链
    // （graceMs=0 时与旧实现行为等价：SIGTERM 即发，3s 后 SIGKILL）。
    await stopChildProcess(p, () => this._requestShutdown());
  }

  /** ΝΩ-27：HTTP 优雅关停请求（best-effort，永不抛错）—— POST /v1/shutdown
   *  携带自铸 Cap Token + X-Request-Id nonce（服务端管理面强制头）。
   *  ack（2xx）⇒ true；baseUrl 缺席/密钥不可读/连接拒绝/超时/非 2xx ⇒ false
   *  （调用方退化信号链 —— 诚实降级，绝不静默把关停失败当成功）。 */
  private async _requestShutdown(): Promise<boolean> {
    if (!this._baseUrl) return false;
    let headers: Record<string, string> = { 'X-Request-Id': randomUUID() };
    try {
      // 与 Python 端同一密钥文件自铸全能力 token（/v1/shutdown 不在
      // ENDPOINT_CAPABILITY ⇒ 不要求特定位图，密钥持有者即可关停）
      const key = await ensureKey(this._keyPath);
      headers = {
        'X-Request-Id': randomUUID(),
        'X-Cap-Token': mintToken(key, process.pid, ALL_CAPS, 60),
      };
    } catch { /* 密钥不可读：裸发（服务端 401 ⇒ 走信号链） */ }
    try {
      const resp = await fetch(`${this._baseUrl}/shutdown`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(SHUTDOWN_HTTP_TIMEOUT_MS),
      });
      return resp.ok;
    } catch {
      return false; // 连接拒绝 / 超时 / 中止 —— 服务不可达 ⇒ 信号链
    }
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
