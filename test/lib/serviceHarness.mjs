// test/lib/serviceHarness.mjs
// ΝΩ-49（全量套件提速）共享基建：spawn 真实 Python 物理微服务的测试册复用
// 「动态端口 + 随机 HMAC 密钥 tmp 文件 + 探活」三件套 —— 与 epochSigma.display
// 的先例同律（探活失败 ⇒ 返回 null，调用方按仓库先例 skip —— 环境信号非代码信号）。
//
// 动态端口的第二重收益：缺省单端口 8421（ΑΩ-R27 端口策略单源）在全量套件
// 并行册间会被彼此占坑（nonce 质询不通 ⇒ port_squatted）—— 册内测试改连
// 动态端口后对这类跨册竞态免疫。
//
// 纯测试基建：不 import src/（避免 TS 解析链），.mjs 原生 ESM 直跑。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessDir = dirname(fileURLToPath(import.meta.url));
/** 仓库根（test/lib/serviceHarness.mjs → 上两级） */
export const REPO_ROOT = resolve(harnessDir, '..', '..');

/** 探活上限（缺省 25s —— 上限非耗时：实际启动 ~2s；宽上限只为负载下不误判环境缺席） */
export const DEFAULT_PROBE_TIMEOUT_MS = 25_000;

/** 随机空闲端口（listen(0) 后即释放 —— 与绑定之间存在理论竞态窗，仓库先例接受） */
export function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolvePort(p));
    });
  });
}

/** 一次性 HMAC 密钥 tmp 文件（32B 熵 hex 落盘，mode 0600 —— 与 createTempKey 同律）。
 *  调用方负责生命周期（cleanup 删目录）。 */
export function makeTempKey(prefix = 'dsh-svc-key-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const keyPath = join(dir, 'test.key');
  writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600 });
  const cleanup = () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  };
  return { dir, keyPath, cleanup };
}

/** 起服务的回执形态（与 epochSigma.display 的 PyService 同形） */
export function pyServiceFrom({ proc, port, keyPath, tmpDir, baseUrl }) {
  let pyOut = '';
  proc.stdout?.on('data', d => { pyOut += d; });
  proc.stderr?.on('data', d => { pyOut += d; });
  return {
    proc, port, keyPath, tmpDir, baseUrl, pyOut,
    get output() { return pyOut; },
  };
}

/** 起真实 Python 微服务：随机空闲端口 + 一次性密钥。
 *  env 可为静态对象（合并于 process.env 之上）或构建函数（收 { port, keyPath,
 *  baseUrl } —— 动态端口/密钥路径需进 env 的调用方用它）。
 *  探活失败/启动即退 ⇒ 返回 null 并清场（调用方按仓库先例 skip，不判 fail）。
 *  bin 缺省 'python'（与 epochSigma.display 先例逐字一致 —— 不引入 python3 分支）。 */
export async function startPythonService(opts = {}) {
  const {
    env = {},
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    bin = 'python',
    cwd = join(REPO_ROOT, 'python_service'),
  } = opts;
  const port = await freePort();
  const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-svcharness-'));
  const keyPath = join(tmpDir, 'test.key');
  writeFileSync(keyPath, randomBytes(32));
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const extraEnv = typeof env === 'function' ? env({ port, keyPath, baseUrl }) : env;
  const proc = spawn(bin, ['-m', 'dsh_physical'], {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const svc = pyServiceFrom({ proc, port, keyPath, tmpDir, baseUrl });

  const deadline = Date.now() + probeTimeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return null; // 启动即退（缺依赖等）
    try {
      const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return svc;
    } catch { /* 尚未就绪 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  stopPythonService(svc);
  return null;
}

/** 关停 + 清场（幂等；kill 失败不抛 —— after() 钩子里安全） */
export function stopPythonService(svc) {
  if (!svc) return;
  try { svc.proc.kill(); } catch { /* noop */ }
  try { rmSync(svc.tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
}
