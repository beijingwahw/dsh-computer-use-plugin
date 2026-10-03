// test/epochDelta.infra.test.ts
// 纪元 Δ（全库跃迁）基础设施簇收尾验收：
//   Δ-A 探活包体校验：端口占坑者（2xx 但 pid 不符）不再被误收养，也不再傻等满超时
//   Δ-B 子进程 exitCode 早退：进程已死立即报 crashed（不等满超时）
//   Δ-C 器官册真自检：环境探针在场 + EMA 描述纠偏 + 静态器官如实标注
// 快路径注入：tcpPort / startupTimeoutMs / pythonServiceRoot 全走 opts，
// 不碰 15s 缺省。假 python 根目录：
//   - sleeper 根（__main__.py 睡 30s）：进程活着但永不绑端口 —— 探活只会命中假 HTTP 服务，
//     消除「子进程死亡先于探活」的竞态；
//   - 空根（No module named dsh_physical）：进程秒死 —— 考 exitCode 早退路径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhysicalServiceManager, judgeHealthBody } from '../src/physicalExecution/serviceManager.ts';

/** 领一个临时空闲端口（listen :0 → 取 port → close；窗口极小，测试专用） */
function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** 起一个假 HTTP 服务：对一切请求回固定包体（模拟占坑者 / 伪装的旧服务） */
function fakeHealthServer(body: () => string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body());
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

/** 假 python 根：`python -m dsh_physical` 进入 30s 睡眠（活着但不绑端口） */
function sleeperPythonRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-infra-sleeper-'));
  mkdirSync(join(root, 'dsh_physical'));
  writeFileSync(join(root, 'dsh_physical', '__init__.py'), '');
  writeFileSync(join(root, 'dsh_physical', '__main__.py'), 'import time\ntime.sleep(30)\n');
  return root;
}

/** 空 python 根：`python -m dsh_physical` 立即 No-module 退出（exit 1） */
function bogusPythonRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-infra-nosvc-'));
}

function rmTemp(root: string): void {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ─── Δ-A0：包体裁决纯函数（不 mock fetch/spawn，直接点名判定逻辑） ───

test('Δ-A0: judgeHealthBody —— pid 吻合=healthy / 不符=squatted / 老版本无 pid=放行 / 坏信封=wait', () => {
  // pid 吻合
  assert.equal(judgeHealthBody({ status: 'success', data: { pid: 4242 } }, 4242).verdict, 'healthy');
  // pid 不符 ⇒ 占坑
  const sq = judgeHealthBody({ status: 'success', data: { pid: 999999 } }, 4242);
  assert.equal(sq.verdict, 'squatted');
  assert.ok(sq.verdict === 'squatted' && sq.reportedPid === 999999 && sq.expectedPid === 4242, '占坑回执携带双方 pid');
  // 老版本服务（无 pid 字段）：按现状放行 —— 版本收养语义不破坏
  assert.equal(judgeHealthBody({ status: 'success', data: { status: 'ok', version: '0.4.0' } }, 4242).verdict, 'healthy');
  // 失败信封 / 非 JSON ⇒ wait（未就绪，继续等）
  assert.equal(judgeHealthBody({ status: 'failure', error: { kind: 'x' } }, 4242).verdict, 'wait');
  assert.equal(judgeHealthBody(null, 4242).verdict, 'wait');
  assert.equal(judgeHealthBody('garbage', 4242).verdict, 'wait');
  // 无期望 pid（spawn 失败兜底）：无从比对 ⇒ 放行（老语义）
  assert.equal(judgeHealthBody({ status: 'success', data: { pid: 999999 } }, null).verdict, 'healthy');
  // pid 非有限数（畸形包体）视同缺席 —— 不误判占坑
  assert.equal(judgeHealthBody({ status: 'success', data: { pid: 'not-a-number' } }, 4242).verdict, 'healthy');
});

// ─── Δ-A1：占坑场景端到端 —— 假服务 2xx 但 pid 不符 ⇒ start() 快报 port_squatted ───

test('Δ-A1: 占坑者应答 200 + 异己 pid ⇒ start() 报 port_squatted（诚实快败，不傻等）', async () => {
  const { server, port } = await fakeHealthServer(() =>
    JSON.stringify({ status: 'success', data: { status: 'ok', version: '0.4.0', pid: 99999999 } }));
  const root = sleeperPythonRoot();
  const mgr = new PhysicalServiceManager({
    tcpPort: port,
    startupTimeoutMs: 8_000,
    pythonServiceRoot: root,
  });
  const t0 = Date.now();
  const res = await mgr.start();
  const elapsed = Date.now() - t0;
  assert.equal(res.ok, false, '占坑不得被误收养');
  assert.equal(res.error!.kind, 'port_squatted', `kind=port_squatted（实际 ${res.error!.kind}）`);
  assert.match(res.error!.detail, /foreign process/);
  assert.match(res.error!.detail, /pid 99999999/);
  assert.ok(elapsed < 6_000, `占坑快败（${elapsed}ms < 6s），不再傻等满 8s 超时`);
  await mgr.dispose();
  rmTemp(root);
  await closeServer(server);
});

// ─── Δ-A2：pid 吻合 ⇒ 包体校验放行（正常就绪路径不误伤） ───

test('Δ-A2: 假服务回报 manager 子进程的真 pid ⇒ 探活通过（包体校验放行）', async () => {
  const holder: { mgr?: PhysicalServiceManager } = {};
  // 假服务在请求时读 mgr.pid（探活 fetch 发生在 spawn 之后 ⇒ 恰为子进程 pid）
  const { server, port } = await fakeHealthServer(() =>
    JSON.stringify({ status: 'success', data: { status: 'ok', version: '0.4.0', pid: holder.mgr?.pid ?? -1 } }));
  const root = sleeperPythonRoot();
  holder.mgr = new PhysicalServiceManager({
    tcpPort: port,
    startupTimeoutMs: 8_000,
    pythonServiceRoot: root,
  });
  const res = await holder.mgr.start();
  assert.equal(res.ok, true, `pid 吻合应放行（detail: ${res.error?.detail ?? 'n/a'}）`);
  assert.ok(res.processPid !== null && res.processPid > 0, '就绪回执携带子进程 pid');
  await holder.mgr.dispose();
  rmTemp(root);
  await closeServer(server);
});

// ─── Δ-B：子进程 exitCode 早退 —— 已死立即报 crashed，不等满超时 ───

test('Δ-B: 子进程秒死（No module named dsh_physical）⇒ 立即报 crashed 而非傻等 9s', async () => {
  const port = await ephemeralPort();
  const root = bogusPythonRoot();
  const mgr = new PhysicalServiceManager({
    tcpPort: port,
    startupTimeoutMs: 9_000,
    pythonServiceRoot: root,
  });
  const t0 = Date.now();
  const res = await mgr.start();
  const elapsed = Date.now() - t0;
  assert.equal(res.ok, false);
  assert.equal(res.error!.kind, 'crashed', `kind=crashed（实际 ${res.error!.kind}）`);
  assert.match(res.error!.detail, /exited with code/);
  assert.ok(elapsed < 5_000, `exitCode 早退生效（${elapsed}ms < 5s）；修复前会傻等满 9s`);
  await mgr.dispose();
  rmTemp(root);
});

// ─── Δ-C：器官册 —— 真自检 + EMA 描述纠偏 + 静态器官标注 ───

test('Δ-C1: 器官册 —— hedge-actor 描述对齐 EMA 现实（乘性权重措辞退役）', async () => {
  const { ORGAN_CENSUS } = await import('../src/organCensus.ts');
  const hedge = ORGAN_CENSUS.find(o => o.id === 'hedge-actor')!;
  assert.ok(hedge, 'hedge-actor 在册');
  assert.ok(hedge.math.includes('EMA'), `描述含 EMA 仲裁（实际：${hedge.math}）`);
  assert.ok(hedge.math.includes('α=0.15'), '描述含 α=0.15（对齐 orchestrator.ts 常量）');
  assert.ok(!hedge.math.includes('乘性权重'), '已推翻的乘性权重措辞退役');
  assert.ok(!hedge.math.includes('w←w·exp'), '乘性权重公式退役');
});

test('Δ-C2: 真自检器官 —— 环境探针在场（dev 仓 sharp/tesseract 可用 ⇒ 自检真）', async () => {
  const { ORGAN_CENSUS } = await import('../src/organCensus.ts');
  const PROBED = ['phash-dct', 'ringhash-rot', 'dejavu-dual-fp', 'fuzzy-substring'];
  const probed = ORGAN_CENSUS.filter(o => PROBED.includes(o.id));
  assert.equal(probed.length, PROBED.length, '4 件真自检器官在册');
  for (const o of probed) {
    assert.notEqual(o.static, true, `${o.id} 挂真探针，不得标 static`);
    assert.equal(o.selfCheck(), true, `${o.id} 自检为真（dev 仓依赖在场）`);
  }
});

test('Δ-C3: 静态器官如实标注 + census 形状契约不破坏（消费方 quality_checkup）', async () => {
  const { ORGAN_CENSUS, organCensus } = await import('../src/organCensus.ts');
  const PROBED = new Set(['phash-dct', 'ringhash-rot', 'dejavu-dual-fp', 'fuzzy-substring']);
  const statics = ORGAN_CENSUS.filter(o => !PROBED.has(o.id));
  assert.equal(statics.length, 29, '其余 29 件纯数学器官');
  for (const o of statics) {
    assert.equal(o.static, true, `${o.id} 标注 static: true（恒真 = 诚实声明，非装饰）`);
    assert.equal(o.selfCheck(), true, `${o.id} 纯数学自检恒真`);
  }
  // 形状契约：{total, healthy, degraded}（observabilityTools.ts 同步消费，不得 async 化）
  const c = organCensus();
  assert.equal(c.total, 33, '33 件在册（epochU 契约）');
  assert.equal(c.healthy, 33, 'dev 仓全员健康');
  assert.deepEqual(c.degraded, [], '无降级器官');
});
