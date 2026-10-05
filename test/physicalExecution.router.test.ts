// test/physicalExecution.router.test.ts
// ΝΩ-27 定向单测：PhysicalActionRouterImpl 的两项加固 ——
//   1. 错误分类细分：14 种 PhysicalErrorKind → ExecutionFailureKind 同构映射
//      矩阵（旧实现 14 压 2 —— unauthorized/element_not_found/internal_error
//      不可区分，上层重试策略失去判据）；detail 保留 [snake_case] 结构化前缀。
//   2. switch_window native 失败回退 hotkey 前先探活：服务已死（health 失败/
//      抛错）⇒ 不再发起注定超时的第二跳，如实回传原错误；服务活着 ⇒ 回退照旧。
//
// 测试形态：内存 fake adapter（零网络/零 Python）—— 经 dispatch 公共面驱动
// （mapErrorKind/toFailureResult 私有，经公开行为断言）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhysicalActionRouterImpl } from '../src/physicalExecution/router.ts';
import { CapabilityCache } from '../src/physicalExecution/capabilityCache.ts';
import type {
  ClickResult, CursorKindInfo, DragResult, HealthInfo, HitTestResult, HotkeyResult,
  ActiveWindowResult, MoveResult, PhysicalError, PhysicalExecutionAdapter, PhysicalExecutionConfig,
  ScreenshotHandleLike, ScreenshotResult, ScrollResult, SwitchWindowResult,
  TypeResult, UiTreeResult,
} from '../src/physicalExecution/contracts.ts';
import type { Result } from '../src/orchestration/contracts.ts';
import type { SandboxAction } from '../src/sandbox/types.ts';

/** 可编程 fake adapter —— 只实装路由会用到的面，其余按契约返回成功占位 */
class FakeAdapter implements PhysicalExecutionAdapter {
  failClick: PhysicalError | null = null;
  failSwitchWindow: PhysicalError | null = null;
  failHotkey: PhysicalError | null = null;
  failHealth: PhysicalError | null = null;
  healthThrows = false;
  healthCalls = 0;
  hotkeyCalls: { keys: string[] }[] = [];
  switchWindowCalls = 0;

  configure(_config: PhysicalExecutionConfig): void { /* noop */ }
  async init(): Promise<Result<void, PhysicalError>> { return { ok: true, value: undefined }; }
  async health(): Promise<Result<HealthInfo, PhysicalError>> {
    this.healthCalls += 1;
    if (this.healthThrows) throw new Error('health contract breach');
    if (this.failHealth) return { ok: false, error: this.failHealth };
    return { ok: true, value: {} as HealthInfo };
  }
  async clickMouse(args: { x: number; y: number }): Promise<Result<ClickResult, PhysicalError>> {
    if (this.failClick) return { ok: false, error: this.failClick };
    return { ok: true, value: { pixel: { x: args.x, y: args.y }, screen: { width: 1, height: 1 } } };
  }
  async typeText(): Promise<Result<TypeResult, PhysicalError>> { return ok(); }
  async scrollPage(): Promise<Result<ScrollResult, PhysicalError>> { return ok(); }
  async pressHotkey(args: { keys: string[] }): Promise<Result<HotkeyResult, PhysicalError>> {
    this.hotkeyCalls.push({ keys: args.keys });
    if (this.failHotkey) return { ok: false, error: this.failHotkey };
    return { ok: true, value: { pressed: args.keys } };
  }
  async dragMouse(): Promise<Result<DragResult, PhysicalError>> { return ok(); }
  async moveMouse(): Promise<Result<MoveResult, PhysicalError>> { return ok(); }
  async takeScreenshot(): Promise<Result<ScreenshotResult, PhysicalError>> { return ok(); }
  async takeScreenshotHandle(): Promise<Result<ScreenshotHandleLike, PhysicalError>> { return ok(); }
  async getUiTree(): Promise<Result<UiTreeResult, PhysicalError>> { return ok(); }
  async switchWindow(args: { keyword: string }): Promise<Result<SwitchWindowResult, PhysicalError>> {
    this.switchWindowCalls += 1;
    if (this.failSwitchWindow) return { ok: false, error: this.failSwitchWindow };
    return { ok: true, value: { method: 'native', matched: null, keyword: args.keyword } };
  }
  // R2-3（焦点保卫）：前台探测假实现 —— router 测试不消费，仅满足接口面
  async getActiveWindow(): Promise<Result<ActiveWindowResult, PhysicalError>> { return ok(); }
  async getCursor(): Promise<Result<{ x: number; y: number }, PhysicalError>> { return ok(); }
  async getCursorKind(): Promise<Result<CursorKindInfo, PhysicalError>> { return ok(); }
  async hitTest(): Promise<Result<HitTestResult, PhysicalError>> { return ok(); }
  async getDisplays(): Promise<Result<{ displays: [] }, PhysicalError>> { return ok(); }
  async frameStats(): Promise<Result<never, PhysicalError>> { return ok(); }
  async frameRowmeans(): Promise<Result<never, PhysicalError>> { return ok(); }
  async frameDiff(): Promise<Result<never, PhysicalError>> { return ok(); }
  async releaseShm(): Promise<Result<{ released: boolean }, PhysicalError>> { return ok(); }
  reset(): void { /* noop */ }
}

/** 成功占位（value 为 never 形态 —— 可赋给任意 data 形状；fake 契约：只测失败分支） */
function ok<T>(): Result<T, PhysicalError> {
  return { ok: true, value: undefined as unknown as T };
}

const click = (x = 0.5, y = 0.5): SandboxAction => ({ kind: 'click_mouse', args: { x, y } });

// ─── ΝΩ-27：错误 kind 透传矩阵（14 种 → 细分映射表断言）───

/** 14 种 PhysicalErrorKind → ExecutionFailureKind 期望矩阵（ snake→kebab 同构；
 *  双超时归 'timeout' —— D-7 超时预算语义同一性） */
const KIND_MATRIX: ReadonlyArray<[PhysicalError['kind'], NonNullable<import('../src/orchestration/contracts.ts').ExecutionResult['failure']>['kind']]> = [
  ['invalid_args', 'invalid-args'],
  ['out_of_bounds', 'out-of-bounds'],
  ['unknown_button', 'unknown-button'],
  ['unknown_key', 'unknown-key'],
  ['element_not_found', 'element-not-found'],
  ['screen_capture_failed', 'screen-capture-failed'],
  ['ocr_unavailable', 'ocr-unavailable'],
  ['vlm_unavailable', 'vlm-unavailable'],
  ['action_timeout', 'timeout'],
  ['client_timeout', 'timeout'],
  ['window_unavailable', 'window-unavailable'],
  ['unauthorized', 'unauthorized'],
  ['internal_error', 'internal-error'],
  ['transport_error', 'transport-error'],
];

test('ΝΩ-27 mapErrorKind 矩阵: 14 种 PhysicalErrorKind → 细分 ExecutionFailureKind（detail 保留 [snake] 前缀）', async () => {
  assert.equal(KIND_MATRIX.length, 14, 'PhysicalErrorKind 全集（14 种）');
  for (const [physicalKind, expectedFailureKind] of KIND_MATRIX) {
    const adapter = new FakeAdapter();
    adapter.failClick = { kind: physicalKind, detail: `boom-${physicalKind}` };
    const router = new PhysicalActionRouterImpl(adapter);
    const result = await router.dispatch(click(), 1);
    assert.ok(result.failure, `${physicalKind} 必须落失败臂`);
    assert.equal(result.failure!.kind, expectedFailureKind,
      `${physicalKind} → ${expectedFailureKind}（细分透传，不再压成 host-error）`);
    assert.ok(result.failure!.detail.startsWith(`[${physicalKind}]`),
      `${physicalKind} 的 detail 保留结构化 kind 前缀（实际 ${result.failure!.detail.slice(0, 40)}）`);
    assert.ok(result.failure!.detail.includes(`boom-${physicalKind}`), 'detail 透传原始终端详情');
    assert.equal(result.effectDetected, false, '失败臂效果证据 = false');
  }
});

test('ΝΩ-27 路由域内拒绝也走细分: click_mouse 缺坐标 → invalid-args（gate 先于物理执行）', async () => {
  const router = new PhysicalActionRouterImpl(new FakeAdapter());
  const result = await router.dispatch({ kind: 'click_mouse', args: {} }, 1);
  assert.ok(result.failure);
  assert.equal(result.failure!.kind, 'invalid-args', '域外拒绝 = invalid_args 细分（旧为 host-error）');
});

test('ΝΩ-27 noop 短路与成功路径不受细分影响（零回归守护）', async () => {
  const adapter = new FakeAdapter();
  const router = new PhysicalActionRouterImpl(adapter);
  const noop = await router.dispatch({ kind: 'noop', args: {} }, 1);
  assert.equal(noop.failure, undefined, 'noop 直接成功');
  const ok = await router.dispatch(click(), 2);
  assert.equal(ok.failure, undefined, '正常点击成功（fake adapter ok 臂）');
  assert.equal(ok.effectDetected, null, '物理执行不做效果验证');
});

// ─── ΝΩ-27：switch_window native 失败回退 hotkey 前先探活 ───

/** 组装 native 路由的 router（capability 探测过 native —— 回退路径的唯一入口） */
function makeNativeRouter(adapter: FakeAdapter): PhysicalActionRouterImpl {
  const capability = new CapabilityCache();
  capability.updateSwitchWindowMethod('native');
  return new PhysicalActionRouterImpl(adapter, capability);
}

test('ΝΩ-27 回退前探活: 服务已死（health 失败）⇒ 不发 hotkey 第二跳，如实回传原错误', async () => {
  const adapter = new FakeAdapter();
  adapter.failSwitchWindow = { kind: 'transport_error', detail: 'connect ECONNREFUSED' };
  adapter.failHealth = { kind: 'transport_error', detail: 'probe refused' };
  const router = makeNativeRouter(adapter);
  const result = await router.dispatch({ kind: 'switch_window', args: { keyword: 'chrome' } }, 1);
  assert.ok(result.failure, 'switch_window 失败（服务已死 ⇒ 无回退成功）');
  assert.equal(result.failure!.kind, 'transport-error', '回传**原**错误（非 hotkey 的）');
  assert.ok(result.failure!.detail.includes('ECONNREFUSED'), '原错误 detail 保留');
  assert.equal(adapter.hotkeyCalls.length, 0, '服务已死 ⇒ 不再发起注定失败的 hotkey 第二跳（防双倍超时）');
  assert.ok(adapter.healthCalls >= 1, '回退前执行了探活');
});

test('ΝΩ-27 回退前探活: health 抛错（契约击穿）⇒ 同样按不活处理', async () => {
  const adapter = new FakeAdapter();
  adapter.failSwitchWindow = { kind: 'client_timeout', detail: 'fetch timed out' };
  adapter.healthThrows = true;
  const router = makeNativeRouter(adapter);
  const result = await router.dispatch({ kind: 'switch_window', args: { keyword: 'x' } }, 1);
  assert.ok(result.failure);
  assert.equal(result.failure!.kind, 'timeout', 'client_timeout 归 timeout（原错误如实回传）');
  assert.equal(adapter.hotkeyCalls.length, 0, '探活抛错 = 防御深度兜底为不活');
});

test('ΝΩ-27 回退前探活: 服务活着（health ok）⇒ hotkey 回退照旧 + 能力降级同步', async () => {
  const adapter = new FakeAdapter();
  adapter.failSwitchWindow = { kind: 'internal_error', detail: 'native impl exploded' };
  // health 默认 ok（FakeAdapter.health 缺省成功）
  const capability = new CapabilityCache();
  capability.updateSwitchWindowMethod('native');
  const router = new PhysicalActionRouterImpl(adapter, capability);
  const result = await router.dispatch({ kind: 'switch_window', args: { keyword: 'x' } }, 1);
  assert.equal(result.failure, undefined, '探活通过 ⇒ 回退 hotkey 成功');
  assert.equal(adapter.hotkeyCalls.length, 1, '热键回退被执行（一次）');
  const mod = process.platform === 'darwin' ? 'cmd' : 'alt';
  assert.deepEqual(adapter.hotkeyCalls[0]!.keys, [mod, 'tab'], '平台修饰键 + tab');
  assert.equal(capability.switchWindowRoute(), 'hotkey_only', '降级成功 ⇒ Reactive 能力同步');
});

test('ΝΩ-27 回退前探活: window_unavailable 不回退（既有语义零回归），且不再额外探活', async () => {
  const adapter = new FakeAdapter();
  adapter.failSwitchWindow = { kind: 'window_unavailable', detail: 'no window backend' };
  const router = makeNativeRouter(adapter);
  const result = await router.dispatch({ kind: 'switch_window', args: { keyword: 'x' } }, 1);
  assert.ok(result.failure);
  assert.equal(result.failure!.kind, 'window-unavailable', 'window_unavailable 细分透传');
  assert.equal(adapter.hotkeyCalls.length, 0, 'window_unavailable 本就不回退（旧行为）');
});

test('ΝΩ-27 回退前探活: hotkey_only 路由 / 无 keyword ⇒ 快速路径不经探活不发 native 请求（零回归）', async () => {
  const adapter = new FakeAdapter();
  const capability = new CapabilityCache();
  capability.updateSwitchWindowMethod('hotkey_only');
  const router = new PhysicalActionRouterImpl(adapter, capability);
  await router.dispatch({ kind: 'switch_window', args: { keyword: 'chrome' } }, 1);
  assert.equal(adapter.switchWindowCalls, 0, 'hotkey_only 直接热键（跳过网络往返）');
  assert.equal(adapter.hotkeyCalls.length, 1);
  const adapter2 = new FakeAdapter();
  const router2 = new PhysicalActionRouterImpl(adapter2); // unknown 路由 + 无 keyword
  await router2.dispatch({ kind: 'switch_window', args: {} }, 1);
  assert.equal(adapter2.switchWindowCalls, 0, '无 keyword ⇒ 热键快速路径');
  assert.equal(adapter2.hotkeyCalls.length, 1);
});
