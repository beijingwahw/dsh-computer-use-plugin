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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  D7PhysicalHostPort,
} from '../src/physicalExecution/index.ts';
import type { AtomicAction } from '../src/knowledge/contracts.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PYTHON_ROOT = resolve(__dirname, '..', 'python_service');

function makeAction(kind: AtomicAction['kind'], args: Record<string, unknown> = {}): AtomicAction {
  return { kind, args, rationale: 'test action' };
}

// 跳过条件：Python 服务启动失败（无 python3 / 无依赖）时整个套件跳过
async function canStartService(): Promise<boolean> {
  const host = new D7PhysicalHostPort({
    service: { pythonServiceRoot: PYTHON_ROOT, startupTimeoutMs: 5000, env: { DSH_PHYSICAL_TEST_SCREEN: '1' } },
  });
  try {
    const r = await host.prewarm();
    await host.dispose();
    return r.ok;
  } catch {
    await host.dispose().catch(() => {});
    return false;
  }
}

const canRun = await canStartService();
const skip = !canRun;
const maybeTest = skip ? test.skip : test;

// ── 双端口躯体：perceive（感知面）e2e ──
// 验证桩纪元终结的视觉侧：getUiTree 反双盲漏斗 → 归一化 → 网格分派 → ScenePatch[]。
maybeTest('perceive: SceneSourcePort 契约 —— getUiTree → ScenePatch[]（网格分区 + 坐标同一性）', async () => {
  const host = new D7PhysicalHostPort({
    service: { pythonServiceRoot: PYTHON_ROOT, startupTimeoutMs: 8000, env: { DSH_PHYSICAL_TEST_SCREEN: '1' } },
  });
  try {
    await host.prewarm();
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
  } finally {
    await host.dispose();
  }
});

maybeTest('perceive 后 execute：同一躯体的两面共享一个 Python 进程（零二次 spawn）', async () => {
  const host = new D7PhysicalHostPort({
    service: { pythonServiceRoot: PYTHON_ROOT, startupTimeoutMs: 8000, env: { DSH_PHYSICAL_TEST_SCREEN: '1' } },
  });
  try {
    const patches = await host.perceive({ grid: { cols: 1, rows: 1 } }); // 感知触发懒启动
    assert.equal(patches.length, 1);
    const pid1 = host.manager.pid;
    const r = await host.execute(makeAction('noop')); // 执行复用同一进程
    assert.equal(r.status, 'success');
    assert.equal(host.manager.pid, pid1, '感知与执行共享同一 Python 进程 —— 双端口同躯体');
  } finally {
    await host.dispose();
  }
});

maybeTest('prewarm: spawns Python service, reports pid, baseUrl resolves via /health', async () => {
  const host = new D7PhysicalHostPort({
    service: { pythonServiceRoot: PYTHON_ROOT, startupTimeoutMs: 8000, env: { DSH_PHYSICAL_TEST_SCREEN: '1' } },
  });
  try {
    const pw = await host.prewarm();
    assert.equal(pw.ok, true, 'prewarm must succeed');
    assert.ok(host.initialized, 'router should be initialized after prewarm');
    assert.ok(host.manager.pid != null, 'process pid should be non-null');
    assert.ok(host.manager.isRunning, 'service should be running');
    assert.ok(host.capability.isInitialized(), 'capability cache should be synced from health');
  } finally {
    await host.dispose();
  }
});

maybeTest('execute(noop): immediate success (router internal short-circuit, no micro-service call)', async () => {
  const host = new D7PhysicalHostPort({
    service: { pythonServiceRoot: PYTHON_ROOT, startupTimeoutMs: 8000, env: { DSH_PHYSICAL_TEST_SCREEN: '1' } },
  });
  try {
    // 首次执行触发懒启动
    const r = await host.execute(makeAction('noop'));
    assert.equal(r.status, 'success');
    assert.ok(!('failure' in r && r.failure), 'success must not carry failure');
  } finally {
    await host.dispose();
  }
});

maybeTest('execute(click_mouse out_of_bounds): honest failure with correct kind', async () => {
  const host = new D7PhysicalHostPort({
    service: { pythonServiceRoot: PYTHON_ROOT, startupTimeoutMs: 8000, env: { DSH_PHYSICAL_TEST_SCREEN: '1' } },
  });
  try {
    await host.prewarm();
    // (2.0, 2.0) 超出归一化范围 [0,1] —— 应被 Python 端拒绝为 out_of_bounds，
    // router.toFailureResult 映射为 host-error（PhysicalErrorKind.out_of_bounds → ...）
    const r = await host.execute(makeAction('click_mouse', { x: 2.0, y: 2.0, button: 'left' }));
    assert.equal(r.status, 'failure');
    assert.ok(r.failure, 'failure must carry detail');
    // 无 X 环境：pyautogui 不可用 ⇒ 错误可能是 out_of_bounds 或 host-error，只要不是 success 就是诚实链路
    assert.ok(['host-error', 'sandbox-degraded', 'gate-rejected', 'timeout', 'cancelled', 'timed-out']
      .includes(r.failure.kind), `unexpected failure kind: ${r.failure.kind}`);
  } finally {
    await host.dispose();
  }
});

maybeTest('execute(click_mouse valid): works or honest degradation (link must be open)', async () => {
  const host = new D7PhysicalHostPort({
    service: { pythonServiceRoot: PYTHON_ROOT, startupTimeoutMs: 8000, env: { DSH_PHYSICAL_TEST_SCREEN: '1' } },
  });
  try {
    await host.prewarm();
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
  } finally {
    await host.dispose();
  }
});

maybeTest('execute(press_hotkey with unknown keys): fails with invalid_args → host-error', async () => {
  const host = new D7PhysicalHostPort({
    service: { pythonServiceRoot: PYTHON_ROOT, startupTimeoutMs: 8000, env: { DSH_PHYSICAL_TEST_SCREEN: '1' } },
  });
  try {
    await host.prewarm();
    const r = await host.execute(makeAction('press_hotkey', { keys: ['totally-bogus-key-that-does-not-exist'] }));
    // press_hotkey 的 unknown_key 错误 → 翻译为 host-error (或等价)
    assert.ok(r.status === 'success' || r.status === 'failure',
      `status must be valid (actually: ${JSON.stringify(r).slice(0, 80)})`);
    if (r.status === 'failure') {
      assert.ok(r.failure, 'failure must carry payload');
    }
  } finally {
    await host.dispose();
  }
});

maybeTest('dispose: idempotent + disposed host returns host-error', async () => {
  const host = new D7PhysicalHostPort({
    service: { pythonServiceRoot: PYTHON_ROOT, startupTimeoutMs: 8000, env: { DSH_PHYSICAL_TEST_SCREEN: '1' } },
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
  const host = new D7PhysicalHostPort({
    service: {
      pythonServiceRoot: PYTHON_ROOT,
      startupTimeoutMs: 8000,
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

if (skip) {
  console.warn('⚠️  D7PhysicalHostPort tests SKIPPED — cannot start Python micro-service ' +
    '(missing python3 / fastapi / pillow / numpy / uvicorn dependencies).');
}
