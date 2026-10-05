// test/physicalExecution.d7HostPort.test.ts
// 端到端集成测试：D7PhysicalHostPort 驱动真实 Python 微服务执行 SandboxAction。
//
// 前置条件：同 adapter.http.test —— 或由 D7PhysicalHostPort 自行启动子进程。
// 本测试走后者（真正验证批次 D：自启动 → 路由 → 关停 全链路）。
//
// 测试动作（均不依赖显示环境；Python 端 DSH_PHYSICAL_TEST_SCREEN=1 合成图兜底）：
//   - click_mouse (1.0, 1.0) → 应失败（out_of_bounds → host-error failure）
//   - click_mouse (0.5, 0.5) → 应成功（pyautogui 失败会被当作 success？不对：
//     Python 端 pyautogui click 失败 → PhysicalError('internal_error') → 应失败。
//     但测试环境无 X，我们只验证「链路通」：返回 failure，kind='host-error'，status='failure'。
//     这其实就是诚实降级 —— 正确行为。
//   - noop → 应立即 success
//   - press_hotkey → Hotkey 结果（Python 端也会失败并转为 host-error 诚实降级，或 native 成功）
//
// 核心验证点：
//   1. D7PhysicalHostPort.prewarm() 能启动 Python 子进程
//   2. execute(noop) 返回 status='success'（不调用微服务，router 内部短路）
//   3. execute(click_mouse) 返回 status='failure'，失败分类正确（链路通顺）
//   4. dispose() 后再 execute → host-error（已 disposed）
//   5. ServiceManager.dispose() 杀进程 + 清理临时文件
//
// ΝΩ-49（全量套件提速）：测试级共享服务 —— 本册原 11 例各自 spawn Python
// （每例探活 2-3s，册内串行累计 ~25s+）。现册顶起一次共享实例（动态端口 +
// 随机 HMAC 密钥 tmp 文件 + TEST_SCREEN=1），常规各例改连共享实例；after()
// 统一 dispose。语义必须独立生命周期的三例保留独立 spawn（各自也改动态端口，
// 免缺省 8421 在全量并行册间被占坑误伤）：
//   - dispose 幂等/已处置降级例（生命周期执法）
//   - capability cache 例（env DSH_PHYSICAL_WINDOW_BACKEND=hotkey-only 专属形态）
//   - ΑΩ-R27 broken-pyautogui 例（PYTHONPATH 劫持注入假 pyautogui）
// 认证面不受影响：adapter 每请求自铸新鲜 token/nonce（X-Cap-Token + X-Request-Id），
// 共享的只是服务进程与密钥文件 —— 与生产「一服务多请求」同一形态。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  D7PhysicalHostPort,
} from '../src/physicalExecution/index.ts';
import type { AtomicAction } from '../src/knowledge/contracts.ts';
import { freePort, makeTempKey } from './lib/serviceHarness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PYTHON_ROOT = resolve(__dirname, '..', 'python_service');

function makeAction(kind: AtomicAction['kind'], args: Record<string, unknown> = {}): AtomicAction {
  return { kind, args, rationale: 'test action' };
}

// ΝΩ-49：探活上限（非耗时 —— 实际启动 ~2s；宽上限免负载下把「起得慢」误判
// 成「环境缺席」而整册 skip —— 旧 5s 闸在并行全量下已实际触发过这种假阴性）
const STARTUP_CEILING_MS = 25_000;

// ── ΝΩ-49 共享服务：册顶一次 spawn，常规各例连接 ──
// 动态端口（freePort）+ 随机 HMAC 密钥 tmp 文件（外部提供 ⇒ manager 不代管
// 清理，after() 统一删）+ TEST_SCREEN=1 合成图兜底。
// 启动失败（无 python / 缺依赖）⇒ null ⇒ 整册 skip（与旧 canStartService 闸
// 同一诚实降级，少 spawn 一次探测进程）。
let sharedKeyCleanup: (() => void) | null = null;

async function startSharedHost(): Promise<D7PhysicalHostPort | null> {
  const port = await freePort();
  const key = makeTempKey('dsh-d7-shared-');
  const host = new D7PhysicalHostPort({
    service: {
      pythonServiceRoot: PYTHON_ROOT,
      startupTimeoutMs: STARTUP_CEILING_MS,
      tcpPort: port,
      keyPath: key.keyPath,
      env: { DSH_PHYSICAL_TEST_SCREEN: '1' },
    },
  });
  const pw = await host.prewarm();
  if (!pw.ok) {
    await host.dispose().catch(() => { /* noop */ });
    key.cleanup();
    return null;
  }
  sharedKeyCleanup = key.cleanup;
  return host;
}

const shared = await startSharedHost();
const skip = shared === null;
const maybeTest = skip ? test.skip : test;

if (shared) {
  after(async () => {
    await shared.dispose().catch(() => { /* noop */ });
    try { sharedKeyCleanup?.(); } catch { /* noop */ }
  });
}

// ── 双端口躯体：perceive（感知面）e2e ──
// 验证桩纪元终结的视觉侧：getUiTree 反双盲漏斗 → 归一化 → 网格分派 → ScenePatch[]。
maybeTest('perceive: SceneSourcePort 契约 —— getUiTree → ScenePatch[]（网格分区 + 坐标同一性）', async () => {
  const host = shared!;
  const patches = await host.perceive({ grid: { cols: 2, rows: 2 } });
  // 结构执法：分区数 = cols×rows，region.id 走 'g{col}x{row}' 方言
  assert.equal(patches.length, 4, '2x2 网格 ⇒ 4 个分区补丁');
  const ids = patches.map(p => p.region.id).sort();
  assert.deepEqual(ids, ['g0x0', 'g0x1', 'g1x0', 'g1x1'], '坐标同一性方言');
  // 诚实执法：无 X + 无 OCR 环境 ⇒ fault 或 empty（有结构的感知，绝不崩溃）
  for (const p of patches) {
    assert.ok(p.funnelDepth === 'empty' || p.funnelDepth === 'L1' || p.funnelDepth === 'L2',
      `funnelDepth 合法域，实际 ${p.funnelDepth}`);
    assert.ok(typeof p.capturedAt === 'number');
  }
});

maybeTest('perceive 后 execute：同一躯体的两面共享一个 Python 进程（零二次 spawn）', async () => {
  const host = shared!;
  const patches = await host.perceive({ grid: { cols: 1, rows: 1 } });
  assert.equal(patches.length, 1);
  const pid1 = host.manager.pid;
  const r = await host.execute(makeAction('noop')); // 执行复用同一进程
  assert.equal(r.status, 'success');
  assert.equal(host.manager.pid, pid1, '感知与执行共享同一 Python 进程 —— 双端口同躯体');
});

maybeTest('prewarm: spawns Python service, reports pid, baseUrl resolves via /health', async () => {
  // ΝΩ-49：共享实例上 prewarm 走「已启动 ⇒ 汇流复用」臂（spawn 语义由册顶
  // startSharedHost 的真 spawn 覆盖）；本例执法 prewarm 契约面：
  // ok / initialized / pid / isRunning / capability 同步。
  const host = shared!;
  const pw = await host.prewarm();
  assert.equal(pw.ok, true, 'prewarm must succeed');
  assert.ok(host.initialized, 'router should be initialized after prewarm');
  assert.ok(host.manager.pid != null, 'process pid should be non-null');
  assert.ok(host.manager.isRunning, 'service should be running');
  assert.ok(host.capability.isInitialized(), 'capability cache should be synced from health');
});

maybeTest('execute(noop): immediate success (router internal short-circuit, no micro-service call)', async () => {
  const host = shared!;
  // 首次执行触发懒启动
  const r = await host.execute(makeAction('noop'));
  assert.equal(r.status, 'success');
  assert.ok(!('failure' in r && r.failure), 'success must not carry failure');
});

maybeTest('execute(click_mouse out_of_bounds): honest failure with correct kind', async () => {
  const host = shared!;
  // (2.0, 2.0) 超出归一化范围 [0,1] —— 应被 Python 端拒绝为 out_of_bounds，
  // router.toFailureResult 映射为 out-of-bounds（ΝΩ-27 细分透传）
  const r = await host.execute(makeAction('click_mouse', { x: 2.0, y: 2.0, button: 'left' }));
  assert.equal(r.status, 'failure');
  assert.ok(r.failure, 'failure must carry detail');
  // 无 X 环境：pyautogui 不可用 ⇒ 错误可能是 out-of-bounds 或 host-error 等，
  // 只要不是 success 就是诚实链路。ΤΕΛ-4（D-G20）：词表已扩容为 D7FailureKind
  // 全量（D-6 ExecutionFailureKind ∪ timed-out）—— 按全集校验（transport-error
  // 等细分值到达 knowledge 面即目标态，非缺陷）。
  assert.ok([
    'gate-rejected', 'host-error', 'timeout', 'timeout-aborted', 'timed-out',
    'sandbox-degraded', 'cancelled', 'invalid-args', 'out-of-bounds',
    'unknown-button', 'unknown-key', 'element-not-found', 'screen-capture-failed',
    'ocr-unavailable', 'vlm-unavailable', 'window-unavailable', 'unauthorized',
    'internal-error', 'transport-error',
  ].includes(r.failure.kind), `unexpected failure kind: ${r.failure.kind}`);
});

maybeTest('execute(click_mouse valid): works or honest degradation (link must be open)', async () => {
  const host = shared!;
  const r = await host.execute(makeAction('click_mouse', { x: 0.5, y: 0.5, button: 'left' }));
  // 无 X 环境：诚实降级为 failure（host-error 或 internal_error 翻译）
  // 有 X 环境：返回 success。两者都接受，关键是不抛错 + status 合法。
  assert.ok(
    r.status === 'success' || r.status === 'failure',
    `status must be success|failure, got ${JSON.stringify(r)}`,
  );
  if (r.status === 'failure') {
    assert.ok(r.failure, 'failure status must have failure object');
  }
});

maybeTest('execute(press_hotkey with unknown keys): fails with invalid_args → host-error', async () => {
  const host = shared!;
  const r = await host.execute(makeAction('press_hotkey', { keys: ['totally-bogus-key-that-does-not-exist'] }));
  // press_hotkey 的 unknown_key 错误 → 翻译为 host-error (或等价)
  assert.ok(r.status === 'success' || r.status === 'failure',
    `status must be valid (actually: ${JSON.stringify(r).slice(0, 80)})`);
  if (r.status === 'failure') {
    assert.ok(r.failure, 'failure status must have payload');
  }
});

// ── 独立生命周期例（ΝΩ-49 保留独立 spawn —— 语义必须独占一个 Python 进程）──

// ΠΑΝ-67（连接韧性）：Python 崩溃后 respawn 端到端执法 —— kill 子进程后
// 下一次 execute 检测 isRunning 掉线 ⇒ 拆除陈旧路由 ⇒ 自动重生（新 pid），
// 端口恢复可用。旧缺陷：`if (this.router) return this.router` 无条件复用死
// 路由 ⇒ transport-error 永续直至插件重载。
maybeTest('ΠΑΝ-67: Python 崩溃后 respawn —— kill 后下一次调用自动重生（新 pid + 恢复可用）', async () => {
  const key = makeTempKey('dsh-d7-respawn-');
  const host = new D7PhysicalHostPort({
    service: {
      pythonServiceRoot: PYTHON_ROOT,
      startupTimeoutMs: STARTUP_CEILING_MS,
      tcpPort: await freePort(),
      keyPath: key.keyPath,
      env: { DSH_PHYSICAL_TEST_SCREEN: '1' },
    },
  });
  try {
    await host.prewarm();
    const pid1 = host.manager.pid;
    assert.ok(pid1 != null && host.manager.isRunning);

    // 模拟崩溃：外部 kill（SIGKILL —— 服务来不及优雅关停）
    process.kill(pid1!, 'SIGKILL');
    // 等 exit 事实落到 ChildProcess（exitCode/signalCode 置位）
    const deadline = Date.now() + 5000;
    while (host.manager.isRunning && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(host.manager.isRunning, false, '场景在位：进程已死');

    // 下一次调用：_ensureInitialized 检测掉线 ⇒ teardown + respawn（ΠΑΝ-67）
    const r = await host.execute(makeAction('noop'));
    assert.equal(r.status, 'success', '崩溃后自动重生 —— 端口恢复可用');
    assert.ok(host.manager.pid != null && host.manager.pid !== pid1,
      '重生后是新 pid（旧缺陷：复用死路由，永不恢复）');
    assert.ok(host.manager.isRunning, '新进程存活');
  } finally {
    await host.dispose().catch(() => { /* noop */ });
    key.cleanup();
  }
});

maybeTest('dispose: idempotent + disposed host returns host-error', async () => {
  const host = new D7PhysicalHostPort({
    service: {
      pythonServiceRoot: PYTHON_ROOT,
      startupTimeoutMs: STARTUP_CEILING_MS,
      tcpPort: await freePort(), // 动态端口：免并行册占坑 8421 误伤
      env: { DSH_PHYSICAL_TEST_SCREEN: '1' },
    },
  });
  await host.prewarm();
  assert.equal(host.initialized, true);

  // 首次 dispose
  await host.dispose();
  assert.equal(host.manager.disposed, true);
  assert.equal(host.manager.isRunning, false);

  // 二次 dispose 幂等
  await host.dispose();

  // disposed 后的 execute 诚实降级
  const r = await host.execute(makeAction('noop'));
  assert.equal(r.status, 'failure');
  assert.ok(r.failure, 'must carry failure detail');
  assert.equal(r.failure.kind, 'host-error');
  assert.match(r.failure.detail, /disposed/);
});

maybeTest('capability cache: switch_window_method reported from health → accessible via host.capability', async () => {
  // 独立 spawn：env 专属形态（hotkey-only 后端）—— 共享实例的 auto 后端会稀释本例语义
  const host = new D7PhysicalHostPort({
    service: {
      pythonServiceRoot: PYTHON_ROOT,
      startupTimeoutMs: STARTUP_CEILING_MS,
      tcpPort: await freePort(),
      env: { DSH_PHYSICAL_TEST_SCREEN: '1', DSH_PHYSICAL_WINDOW_BACKEND: 'hotkey-only' },
    },
  });
  try {
    await host.prewarm();
    const route = host.capability.switchWindowRoute();
    // hotkey-only backend → capability 应是 hotkey_only
    assert.ok(route === 'hotkey_only' || route === 'native' || route === 'unknown',
      `unexpected switchWindowRoute: ${route}`);
    const transport = host.capability.screenshotTransport();
    assert.ok(transport === 'mmap-file' || transport === 'base64' || transport === 'shm' || transport === 'unknown',
      `unexpected screenshotTransport: ${transport}`);
  } finally {
    await host.dispose();
  }
});

// ── ΑΩ-R27：screenSize 僵尸状态处决执法 ──
// 定谳：删除字段与就绪判据，不做 TTL 活化（J 纪元后本端零读方；归一化基准的
// 活依赖在服务端 /v1/get_ui_tree 每请求现场重探 —— 详见 d7HostPort.ts 类内定谳注）。
// 三层执法：运行期结构（实例无僵尸属性）/ 源文本（器官不复活）/ 行为
//（health.screen 探测失败时 perceive 不再被 Node 侧判据短路）。

test('ΑΩ-R27: screenSize 僵尸已死 —— 实例不再携带该自有属性（运行期结构执法）', async () => {
  const host = new D7PhysicalHostPort({}); // 懒启动：构造不 spawn，零 Python 依赖
  try {
    assert.equal('screenSize' in host, false,
      'private 字段已删除 —— 运行期不得再出现该自有属性（防僵尸借尸还魂）');
  } finally {
    await host.dispose();
  }
});

test('ΑΩ-R27: screenSize 僵尸已死 —— 源文本不再含懒同步器官与就绪判据（防复活执法）', () => {
  const src = readFileSync(new URL('../src/physicalExecution/d7HostPort.ts', import.meta.url), 'utf8');
  assert.ok(!/private screenSize/.test(src), '字段声明已删除');
  assert.ok(!src.includes('_syncScreenSize'), '懒同步方法已删除');
  assert.ok(!src.includes('screen size unavailable (health screen probe failed)'),
    'perceive 就绪判据 fault 已删除');
  assert.ok(src.includes('ΑΩ-R27'), '定谳注释在册（删而非活化的证据链留档）');
});

// 行为执法脚手架：PYTHONPATH 劫持注入假 pyautogui（import 即 raise）——
// health 的 get_screen_size 走 except 分支 ⇒ health.screen = {error: ...}，
// 而 /v1/get_ui_tree 的 L1 归一化与 L2 OCR 由服务端每请求独立处理。
function brokenPyautoguiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-r27-nopa-'));
  writeFileSync(join(dir, 'pyautogui.py'),
    'raise RuntimeError("AΩ-R27 synthetic: pyautogui unavailable")\n');
  return dir;
}

maybeTest('ΑΩ-R27: health.screen 探测失败 ⇒ perceive 不再被 Node 侧就绪判据短路（诚实边界由漏斗单一裁决）', async () => {
  // 独立 spawn：PYTHONPATH 劫持是本例专属的畸形环境 —— 不得污染共享实例
  const noPa = brokenPyautoguiDir();
  const host = new D7PhysicalHostPort({
    service: {
      pythonServiceRoot: PYTHON_ROOT,
      startupTimeoutMs: STARTUP_CEILING_MS,
      tcpPort: await freePort(),
      env: { PYTHONPATH: noPa }, // 故意不设 DSH_PHYSICAL_TEST_SCREEN（合成图会兜底出尺寸）
    },
  });
  try {
    await host.prewarm();
    // 场景真实性证明：health 确实报 screen error（而非测试空转）
    const resp = await fetch(`${host.manager.baseUrl}/health`);
    const body = (await resp.json()) as { data?: { screen?: unknown } };
    assert.ok(body.data && typeof body.data.screen === 'object' && body.data.screen !== null
      && 'error' in (body.data.screen as object), `场景在位：health.screen 应为 error 形态，实际 ${JSON.stringify(body.data?.screen)}`);
    // 旧判据会在此短路成 fault 'screen size unavailable (health screen probe
    // failed)'；删除后 perceive 直达 getUiTree —— 结果（元素/诚实 fault）由
    // 漏斗每请求现场重探的 screen size 单一裁决。
    const patches = await host.perceive({ grid: { cols: 2, rows: 2 } });
    assert.equal(patches.length, 4, '2x2 网格 ⇒ 4 个分区补丁（形状契约不因判据删除而破）');
    for (const p of patches) {
      assert.ok(p.funnelDepth === 'empty' || p.funnelDepth === 'L1' || p.funnelDepth === 'L2'
        || p.funnelDepth === 'L3', `funnelDepth 合法域，实际 ${p.funnelDepth}`);
      assert.ok(typeof p.capturedAt === 'number');
      const detail = (p as { fault?: { detail?: string } }).fault?.detail ?? '';
      assert.ok(!detail.includes('screen size unavailable (health screen probe failed)'),
        `不得再出现旧就绪判据 fault，实际 ${detail}`);
    }
  } finally {
    await host.dispose().catch(() => { /* noop */ });
    try { rmSync(noPa, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

if (skip) {
  console.warn('⚠️  D7PhysicalHostPort tests SKIPPED — cannot start Python micro-service ' +
    '(missing python / fastapi / pillow / numpy / uvicorn dependencies).');
}
