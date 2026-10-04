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
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { resolvePythonBin } from './pythonBin.js';
import { ensureKey } from './capToken.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
/** 计算 Python 服务根目录（从本文件物理路径相对推导） */
function defaultPythonRoot() {
    // src/physicalExecution/serviceManager.ts → ../../python_service
    return pathResolve(__dirname, '..', '..', 'python_service');
}
/** 生成随机 HMAC 密钥文件（64 字节 hex，32 字节熵） */
function createTempKey() {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-physical-key-'));
    const keyPath = join(dir, 'cap.key');
    const key = randomBytes(32).toString('hex');
    // mode 0600：仅属主可读写（POSIX 生效；Windows 上无害忽略）。与 Python 端
    // auth.ensure_key 的 O_CREAT 0600、capToken.ensureKey 的 writeFile {mode:0o600}
    // 同一收口纪律 —— HMAC 密钥是三层纵深认证的信任根，落盘权限不得停留在 umask 缺省
    writeFileSync(keyPath, key, { encoding: 'utf-8', mode: 0o600 });
    const cleanup = () => {
        try {
            rmSync(dir, { recursive: true, force: true });
        }
        catch { /* noop */ }
    };
    return { keyPath, cleanup };
}
export function judgeHealthBody(body, expectedPid, expectedProof) {
    if (body === null || typeof body !== 'object')
        return { verdict: 'wait' };
    const envelope = body;
    if (envelope.status !== 'success')
        return { verdict: 'wait' };
    const data = envelope.data !== null && typeof envelope.data === 'object'
        ? envelope.data
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
async function probeHealth(baseUrl, timeoutMs, child, key, spawnFailed) {
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
                let body = null;
                try {
                    body = await resp.json();
                }
                catch { /* 非 JSON 包体：视同未就绪，继续等 */ }
                const expectedProof = nonce && key
                    ? createHmac('sha256', Buffer.from(key)).update(nonce, 'utf-8').digest('hex')
                    : null;
                const verdict = judgeHealthBody(body, expectedPid, expectedProof);
                if (verdict.verdict === 'healthy')
                    return { ok: true };
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
        }
        catch {
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
/**
 * PhysicalServiceManager —— Python 微服务生命周期的唯一管理者。
 *
 * 启动哲学：懒启动（construct 不 spawn，start() 才 spawn）。
 * 失败哲学：start 永不抛错，返回 Result 风格（调用方决定降级路径）。
 *
 * 单实例模型：一个 manager 管一个 Python 子进程；dispose 后不可复用。
 */
export class PhysicalServiceManager {
    opts;
    proc = null;
    _baseUrl = '';
    _keyPath = '';
    _mmapDir = '';
    _keyCleanup = null;
    _started = false;
    _disposed = false;
    /** 在飞的 start 调用（并发 start 汇流到同一次 spawn + 探活；失败即归零可重试） */
    _startPromise = null;
    constructor(opts = {}) {
        this.opts = opts;
    }
    get baseUrl() { return this._baseUrl; }
    get keyPath() { return this._keyPath; }
    get mmapDir() { return this._mmapDir; }
    get pid() { return this.proc?.pid ?? null; }
    get isRunning() { return this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null; }
    get disposed() { return this._disposed; }
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
    async start() {
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
        if (this._startPromise)
            return this._startPromise;
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
        }
        finally {
            if (this._startPromise === run)
                this._startPromise = null;
        }
    }
    async _spawnAndProbe() {
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
        }
        else {
            const { keyPath, cleanup } = createTempKey();
            this._keyPath = keyPath;
            this._keyCleanup = cleanup;
        }
        // 2. mmap 目录（缺省临时）
        if (this.opts.mmapDir) {
            this._mmapDir = this.opts.mmapDir;
        }
        else {
            this._mmapDir = mkdtempSync(join(tmpdir(), 'dsh-physical-mmap-'));
        }
        // 3. 端口（单一端口，无自动重试 —— 占用时由探活超时如实暴露）
        const port = this.opts.tcpPort ?? 8421;
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
        const env = {
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
        let spawnError = null;
        proc.on('error', (err) => { spawnError = err.message; });
        this.proc = proc;
        this._baseUrl = `http://127.0.0.1:${port}/v1`;
        // 收集 stderr 用于诊断（内存受限：留最后 1KB）
        let stderrTail = '';
        proc.stderr?.on('data', (chunk) => {
            stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-1024);
        });
        let stdoutTail = '';
        proc.stdout?.on('data', (chunk) => {
            stdoutTail = (stdoutTail + chunk.toString('utf-8')).slice(-1024);
        });
        // 5. 探活（Δ 纪元：传入子进程 —— 死亡早退 + 包体 pid 校验；
        //    Σ 纪元：传入共享密钥 —— nonce 质询应答式服务身份证明）
        const timeoutMs = this.opts.startupTimeoutMs ?? 15_000;
        // Σ 纪元：读取共享密钥 —— 与 Python 端同一密钥文件（DSH_PHYSICAL_KEY_PATH），
        // capToken.ensureKey 与 auth.ensure_key 字节级一致（文件原样字节即 HMAC key）。
        // 读取失败 ⇒ key=null 退回 pid-only 判定（旧 Δ 语义），绝不抛（start 永不抛错铁律）。
        let key = null;
        try {
            key = await ensureKey(this._keyPath);
        }
        catch { /* 密钥不可读：降级 pid-only 判定 */ }
        const probe = await probeHealth(this._baseUrl, timeoutMs, proc, key, () => spawnError);
        if (!probe.ok) {
            // 诊断信息：spawn 失败？被占坑？已崩溃？
            const squatted = probe.squatted;
            const crashed = proc.exitCode !== null || proc.signalCode !== null;
            const errorKind = spawnError !== null ? 'spawn_failed'
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
     * 优雅关停：SIGTERM → 等 3s → SIGKILL，清理临时密钥。
     * dispose 是幂等的（多次调用安全）。
     */
    async dispose() {
        if (this._disposed)
            return;
        this._disposed = true;
        await this._killProcess();
        this._cleanupLocal();
    }
    async _killProcess() {
        const p = this.proc;
        this.proc = null;
        // 信号致死（exitCode=null / signalCode≠null）同样视为已退出 —— 否则对已死
        // 进程注册的 'exit' 监听永不触发，dispose 白等满 3s SIGKILL 超时。
        // pid===undefined ⇒ spawn 从未成功（'error' 已发、'exit' 永不发）—— 没有
        // 可杀的进程，kill() 只会再 emit 一次 'error'，直接返回
        if (!p || p.pid === undefined || p.exitCode !== null || p.signalCode !== null)
            return;
        await new Promise((resolve) => {
            const killer = setTimeout(() => {
                try {
                    p.kill('SIGKILL');
                }
                catch { /* noop */ }
                resolve();
            }, 3000);
            killer.unref();
            p.once('exit', () => {
                clearTimeout(killer); // 进程已退：不得再对可能被复用的 pid 补发 SIGKILL
                resolve();
            });
            try {
                p.kill('SIGTERM');
            }
            catch { /* noop */ }
        });
    }
    _cleanupLocal() {
        if (this._keyCleanup) {
            try {
                this._keyCleanup();
            }
            catch { /* noop */ }
            this._keyCleanup = null;
        }
        // 清理缺省 mmap 临时目录（外部提供的目录不动）
        if (!this.opts.mmapDir && this._mmapDir && existsSync(this._mmapDir)) {
            try {
                rmSync(this._mmapDir, { recursive: true, force: true });
            }
            catch { /* noop */ }
        }
        // 清理外部提供 keyPath？不 —— 用户显式提供的由用户负责
    }
}
