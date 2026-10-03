// test/epochSigma.identity.test.ts
// 纪元 Σ（全军升维）：质询应答式服务身份证明 —— 根治 Δ 留案的
// 「启动器别名 pid 盲区」：Windows PythonManager 启动器 re-exec 真实解释器
// ⇒ spawn pid ≠ /health 上报 pid ⇒ 旧 pid 等值判定误报 port_squatted。
// 原理：TS 探活每次随机发 nonce，服务用共享密钥 HMAC-SHA256 回签（proof）；
// 验签通过 = 应答者持有本回合密钥 = 自己人（pid 漂移也放行）；占坑者无密钥，
// 给不出正确回签即现形。
// 全离线：不依赖真实 FastAPI 服务 —— 端到端用 node:http 假服务按同一密钥回签；
// 快路径注入：tcpPort / startupTimeoutMs / pythonServiceRoot 全走 opts，
// 不碰 15s 缺省（对齐 Δ 纪元测试形态）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PhysicalServiceManager, judgeHealthBody } from '../src/physicalExecution/serviceManager.ts';

/** 质询回签 —— 与 TS probeHealth 期望值 / Python health() 回签同一字节序 */
function sign(key: Uint8Array, nonce: string): string {
  return createHmac('sha256', Buffer.from(key)).update(nonce, 'utf-8').digest('hex');
}

const TEST_KEY = Buffer.from('sigma-identity-shared-key-0123456789ab', 'utf-8');
const WRONG_KEY = Buffer.from('imposter-key-not-held-by-service-01', 'utf-8');

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

/** 假 python 根：`python -m dsh_physical` 进入 30s 睡眠（活着但不绑端口 ——
 *  端口由假 HTTP 服务持有，探活只会命中假服务，消除子进程死亡竞态） */
function sleeperPythonRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sigma-sleeper-'));
  mkdirSync(join(root, 'dsh_physical'));
  writeFileSync(join(root, 'dsh_physical', '__init__.py'), '');
  writeFileSync(join(root, 'dsh_physical', '__main__.py'), 'import time\ntime.sleep(30)\n');
  return root;
}

function rmTemp(root: string): void {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * 质询应答假服务：解析 ?nonce=...，用 signKey() 的密钥回签 proof。
 * pidOf() 模拟上报 pid（可注入启动器 re-exec 形态的异值 pid）。
 */
function fakeChallengeServer(
  signKey: () => Uint8Array,
  pidOf: () => number,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      const nonce = u.searchParams.get('nonce') ?? '';
      const data: Record<string, unknown> = {
        status: 'ok', version: '0.4.0', pid: pidOf(),
      };
      if (nonce) data.proof = sign(signKey(), nonce);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', data }));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

// ─── Σ-1：judgeHealthBody 验签纯函数（不 mock fetch/spawn，直接点名裁决） ───

test('Σ-1a: 正确 proof + 异 pid ⇒ healthy（启动器别名 pid 盲区根治断言）', () => {
  const nonce = 'ab'.repeat(16);
  const expected = sign(TEST_KEY, nonce);
  // 上报 pid 999999 ≠ 期望 4242 —— 旧 Δ 语义必判 squatted；Σ 验签通过 ⇒ 自己人放行
  const v = judgeHealthBody({ status: 'success', data: { pid: 999999, proof: expected } }, 4242, expected);
  assert.equal(v.verdict, 'healthy', '密钥持有者 pid 漂移也放行（Windows PythonManager re-exec 形态）');
});

test('Σ-1b: 正确 proof + 无 pid（键持有者旧形包体）⇒ healthy', () => {
  const nonce = 'cd'.repeat(16);
  const expected = sign(TEST_KEY, nonce);
  const v = judgeHealthBody({ status: 'success', data: { proof: expected } }, null, expected);
  assert.equal(v.verdict, 'healthy');
});

test('Σ-1c: 错误 proof（异密钥回签）⇒ squatted 且 detail 附「质询应答失败：密钥不持有」', () => {
  const nonce = 'ef'.repeat(16);
  const v = judgeHealthBody(
    { status: 'success', data: { pid: 999999, proof: sign(WRONG_KEY, nonce) } },
    4242,
    sign(TEST_KEY, nonce),
  );
  assert.equal(v.verdict, 'squatted');
  if (v.verdict === 'squatted') {
    assert.match(v.detail ?? '', /质询应答失败/);
    assert.match(v.detail ?? '', /密钥不持有/);
    assert.equal(v.reportedPid, 999999);
    assert.equal(v.expectedPid, 4242);
    // 有质询的形态错误里不再给 DSH_PYTHON 启动器提示（启动器形态本就能验签通过）
    assert.doesNotMatch(v.detail ?? '', /DSH_PYTHON/);
  }
});

test('Σ-1d: proof 长度不等（timingSafeEqual 长度守卫）⇒ squatted，不炸', () => {
  const v1 = judgeHealthBody(
    { status: 'success', data: { pid: 1, proof: 'deadbeef' } }, // 8 字符 ≠ 期望 64 字符
    4242,
    sign(TEST_KEY, 'ff'.repeat(16)),
  );
  assert.equal(v1.verdict, 'squatted', '长度不等先行短路，timingSafeEqual 不抛 RangeError');
  // 反向：期望值短、proof 长 —— 同样不炸
  const v2 = judgeHealthBody(
    { status: 'success', data: { pid: 1, proof: sign(TEST_KEY, 'ab'.repeat(16)) } },
    4242,
    'deadbeef',
  );
  assert.equal(v2.verdict, 'squatted');
});

test('Σ-1e: proof 在场但本端密钥不可用（expectedProof 缺席）⇒ squatted（fail-closed，不炸）', () => {
  const v = judgeHealthBody(
    { status: 'success', data: { pid: 4242, proof: 'ab'.repeat(32) } },
    4242,
  );
  assert.equal(v.verdict, 'squatted', '无法验证的 proof 视同质询应答失败（fail-closed）');
  if (v.verdict === 'squatted') assert.match(v.detail ?? '', /质询应答失败/);
});

test('Σ-1f: 无 proof + pid 吻合 ⇒ healthy（旧服务回退路径原样保留）', () => {
  assert.equal(
    judgeHealthBody({ status: 'success', data: { status: 'ok', version: '0.4.0', pid: 4242 } }, 4242).verdict,
    'healthy',
  );
});

test('Σ-1g: 无 proof + pid 不符 ⇒ squatted 且 detail 附 DSH_PYTHON 启动器提示（Δ 终审留案兑现）', () => {
  const v = judgeHealthBody({ status: 'success', data: { pid: 999999 } }, 4242);
  assert.equal(v.verdict, 'squatted');
  if (v.verdict === 'squatted') {
    assert.match(v.detail ?? '', /DSH_PYTHON/);
    assert.equal(v.reportedPid, 999999);
    assert.equal(v.expectedPid, 4242);
  }
});

test('Σ-1h: 无 proof + 无 pid（老版本服务）⇒ healthy（收养语义不破坏）', () => {
  assert.equal(
    judgeHealthBody({ status: 'success', data: { status: 'ok', version: '0.3.0' } }, 4242).verdict,
    'healthy',
  );
});

// ─── Σ-2/Σ-3：端到端 —— 真 HTTP 假服务回签，probeHealth（经 start()）验证 ───

test('Σ-2: 服务用共享密钥回签 + 上报异 pid（模拟启动器 re-exec）⇒ start() 通过', async () => {
  const holder: { mgr?: PhysicalServiceManager } = {};
  // 假服务在请求时读 mgr.keyPath 的密钥文件（字节级 = TS ensureKey 读到的同一字节）
  const { server, port } = await fakeChallengeServer(
    () => readFileSync(holder.mgr!.keyPath),
    () => 99999999, // 模拟 Windows Python 启动器别名：上报 pid ≠ spawn pid
  );
  const root = sleeperPythonRoot();
  holder.mgr = new PhysicalServiceManager({
    tcpPort: port,
    startupTimeoutMs: 8_000,
    pythonServiceRoot: root,
  });
  const res = await holder.mgr.start();
  assert.equal(res.ok, true, `密钥持有者 pid 异值也应放行（detail: ${res.error?.detail ?? 'n/a'}）`);
  await holder.mgr.dispose();
  rmTemp(root);
  await closeServer(server);
});

test('Σ-3: 回签密钥错误 ⇒ start() 快报 port_squatted（质询应答失败，不傻等）', async () => {
  const holder: { mgr?: PhysicalServiceManager } = {};
  const { server, port } = await fakeChallengeServer(
    () => WRONG_KEY, // 占坑者不持有本回合密钥 —— 回签必错
    () => 99999999,
  );
  const root = sleeperPythonRoot();
  holder.mgr = new PhysicalServiceManager({
    tcpPort: port,
    startupTimeoutMs: 8_000,
    pythonServiceRoot: root,
  });
  const t0 = Date.now();
  const res = await holder.mgr.start();
  const elapsed = Date.now() - t0;
  assert.equal(res.ok, false, '异密钥回签不得被收养');
  assert.equal(res.error!.kind, 'port_squatted', `kind=port_squatted（实际 ${res.error!.kind}）`);
  assert.match(res.error!.detail, /质询应答失败/);
  assert.match(res.error!.detail, /pid 99999999/);
  assert.ok(elapsed < 6_000, `质询快败（${elapsed}ms < 6s），不再傻等满 8s 超时`);
  await holder.mgr.dispose();
  rmTemp(root);
  await closeServer(server);
});

// ─── Σ-4：Python 侧 nonce 质询代码语法可编译（compileall） ───

test('Σ-4: python -m compileall 通过（routes.py 的 nonce 质询无语法/缩进错误）', () => {
  const repoRoot = pathResolve(dirname(fileURLToPath(import.meta.url)), '..');
  const r = spawnSync('python', ['-m', 'compileall', '-q', join(repoRoot, 'python_service', 'dsh_physical')], {
    timeout: 60_000,
  });
  assert.equal(r.status, 0, `compileall 失败：${r.stderr?.toString().trim() ?? '(no stderr)'}`);
});
