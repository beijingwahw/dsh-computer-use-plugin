// test/pan64-68.physicalExecution.test.ts
// ΠΑΝ 修复潮执法测试（physicalExecution 面）：
//   ΠΑΝ-64：router.dispatch 第三参 signal 透传到全部动作方法（止损链 D-5 段）；
//   ΠΑΝ-65：d7HostPort.translateFailureKind 细分保真矩阵（不再 default 整体
//     折叠 host-error —— 按可重试/不可重试/认证三类落位，词表对接点在册）；
//   ΠΑΝ-66：mmap-file 路径防线 —— 拒绝遍历 + 白名单根 + fail-closed
//    （缺省传输与 shm 模式同级的校验；约定根覆盖收养流）；
//   ΠΑΝ-67a：adapter keyPromise 拒绝后可重试（瞬态密钥故障 ≠ 适配器终身瘫痪）；
//   ΠΑΝ-67b：respawnRuling 重生裁决（有限次 + 指数退避 + 超限拒绝）；
//   ΠΑΝ-68：adapter.getUiTree 缺省 funnel_ceiling='L2'（缺省不自铸花钱权）。
// 除 ΠΑΝ-68 起本地 HTTP 假服务外全离线，零 Python。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, sep } from 'node:path';
import { PhysicalActionRouterImpl } from '../src/physicalExecution/router.ts';
import { CapabilityCache } from '../src/physicalExecution/capabilityCache.ts';
import {
  D7PhysicalHostPort, translateFailureKind, respawnRuling, RESPAWN_MAX_ATTEMPTS,
} from '../src/physicalExecution/d7HostPort.ts';
import { readShm, allowMmapRoot, clearMmapRoots, closeAllFds } from '../src/physicalExecution/shmReader.ts';
import { createPhysicalExecution } from '../src/physicalExecution/index.ts';
import type {
  ClickResult, CursorKindInfo, DragResult, HealthInfo, HitTestResult, HotkeyResult,
  ActiveWindowResult, MoveResult, PhysicalError, PhysicalErrorKind, PhysicalExecutionAdapter,
  PhysicalExecutionConfig, Result, ScreenshotHandleLike, ScreenshotResult,
  ScrollResult, SwitchWindowResult, TypeResult, UiTreeResult,
} from '../src/physicalExecution/contracts.ts';
import type { SandboxAction } from '../src/sandbox/types.ts';

function okVal<T>(v: T): Result<T, PhysicalError> { return { ok: true, value: v }; }
const ERR_KIND = { kind: 'internal_error' as PhysicalErrorKind, detail: 'unused' };

// ─── ΠΑΝ-64：router.dispatch 第三参 signal 透传（全部动作面）───

/** 信号记录型 fake adapter —— 只实装路由会走到的面 */
class SignalRecordingAdapter implements PhysicalExecutionAdapter {
  readonly calls: Array<{ method: string; signal: AbortSignal | undefined }> = [];
  private rec(method: string, signal?: AbortSignal): void { this.calls.push({ method, signal }); }

  configure(_c: PhysicalExecutionConfig): void { /* noop */ }
  async init(): Promise<Result<void, PhysicalError>> { return okVal(undefined); }
  async health(): Promise<Result<HealthInfo, PhysicalError>> { return { ok: false, error: ERR_KIND }; }
  async clickMouse(args: { signal?: AbortSignal }): Promise<Result<ClickResult, PhysicalError>> {
    this.rec('clickMouse', args.signal);
    return okVal({ pixel: { x: 0, y: 0 }, screen: { width: 1, height: 1 } });
  }
  async typeText(args: { signal?: AbortSignal }): Promise<Result<TypeResult, PhysicalError>> {
    this.rec('typeText', args.signal);
    return okVal({ typed_chars: 0 });
  }
  async scrollPage(args: { signal?: AbortSignal }): Promise<Result<ScrollResult, PhysicalError>> {
    this.rec('scrollPage', args.signal);
    return okVal({ scrolled: 0 });
  }
  async pressHotkey(args: { signal?: AbortSignal }): Promise<Result<HotkeyResult, PhysicalError>> {
    this.rec('pressHotkey', args.signal);
    return okVal({ pressed: [] });
  }
  async dragMouse(args: { signal?: AbortSignal }): Promise<Result<DragResult, PhysicalError>> {
    this.rec('dragMouse', args.signal);
    return okVal({ start_pixel: { x: 0, y: 0 }, end_pixel: { x: 0, y: 0 } });
  }
  async moveMouse(args: { signal?: AbortSignal }): Promise<Result<MoveResult, PhysicalError>> {
    this.rec('moveMouse', args.signal);
    return okVal({ pixel: { x: 0, y: 0 } });
  }
  async switchWindow(args: { signal?: AbortSignal }): Promise<Result<SwitchWindowResult, PhysicalError>> {
    this.rec('switchWindow', args.signal);
    return okVal({ method: 'native', matched: null, keyword: 'k' });
  }
  async takeScreenshot(): Promise<Result<ScreenshotResult, PhysicalError>> { return { ok: false, error: ERR_KIND }; }
  async takeScreenshotHandle(): Promise<Result<ScreenshotHandleLike, PhysicalError>> { return { ok: false, error: ERR_KIND }; }
  async getUiTree(): Promise<Result<UiTreeResult, PhysicalError>> { return { ok: false, error: ERR_KIND }; }
  // R2-3（焦点保卫）：前台探测假实现 —— signal 测试不消费，仅满足接口面
  async getActiveWindow(): Promise<Result<ActiveWindowResult, PhysicalError>> { return okVal({ method: 'native', title: null }); }
  async getCursor(): Promise<Result<{ x: number; y: number }, PhysicalError>> { return okVal({ x: 0, y: 0 }); }
  async getCursorKind(): Promise<Result<CursorKindInfo, PhysicalError>> { return { ok: false, error: ERR_KIND }; }
  async hitTest(): Promise<Result<HitTestResult, PhysicalError>> { return { ok: false, error: ERR_KIND }; }
  async getDisplays(): Promise<Result<{ displays: Array<{ name: string; x: number; y: number; width: number; height: number; primary?: boolean }> }, PhysicalError>> { return okVal({ displays: [] }); }
  async frameStats(): Promise<Result<never, PhysicalError>> { return { ok: false, error: ERR_KIND }; }
  async frameRowmeans(): Promise<Result<never, PhysicalError>> { return { ok: false, error: ERR_KIND }; }
  async frameDiff(): Promise<Result<never, PhysicalError>> { return { ok: false, error: ERR_KIND }; }
  async releaseShm(): Promise<Result<{ released: boolean }, PhysicalError>> { return okVal({ released: true }); }
  reset(): void { /* noop */ }
}

test('ΠΑΝ-64: dispatch(action, seq, signal) —— signal 到达全部动作方法（同一实例透传）', async () => {
  const adapter = new SignalRecordingAdapter();
  const cap = new CapabilityCache();
  cap.updateSwitchWindowMethod('native'); // 走 switch_window native 路径
  const router = new PhysicalActionRouterImpl(adapter, cap);
  const ctrl = new AbortController();
  const sig = ctrl.signal;

  const cases: Array<[string, SandboxAction, string]> = [
    ['click', { kind: 'click_mouse', args: { x: 0.1, y: 0.1 } }, 'clickMouse'],
    ['type', { kind: 'type_text', args: { text: 'hi' } }, 'typeText'],
    ['scroll', { kind: 'scroll_page', args: { direction: 'down' } }, 'scrollPage'],
    ['hotkey', { kind: 'press_hotkey', args: { keys: ['ctrl'] } }, 'pressHotkey'],
    ['drag', { kind: 'drag_mouse', args: { start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } }, 'dragMouse'],
    ['switch_tab(→hotkey)', { kind: 'switch_tab', args: {} }, 'pressHotkey'],
    ['switch_window(native)', { kind: 'switch_window', args: { keyword: 'notes' } }, 'switchWindow'],
    ['switch_window(无 keyword→hotkey)', { kind: 'switch_window', args: {} }, 'pressHotkey'],
    ['dismiss_popup(→esc)', { kind: 'dismiss_popup', args: {} }, 'pressHotkey'],
  ];
  for (const [label, action, method] of cases) {
    const r = await router.dispatch(action, 1, sig);
    assert.equal(r.failure, undefined, `${label}: 动作成功`);
    const last = adapter.calls[adapter.calls.length - 1]!;
    assert.equal(last.method, method, `${label}: 路由到 ${method}`);
    assert.equal(last.signal, sig, `${label}: signal 同一实例透传到 ${method}（旧缺陷：dispatch 只收两参）`);
  }

  // signal 缺席 ⇒ 旧路径（动作方法收到 undefined）
  const before = adapter.calls.length;
  await router.dispatch({ kind: 'click_mouse', args: { x: 0.5, y: 0.5 } }, 2);
  assert.equal(adapter.calls[before]!.signal, undefined, 'signal 缺席 ⇒ 旧路径逐字节保持');

  // noop 短路：不经 adapter（零网络零延迟语义保持）
  const beforeNoop = adapter.calls.length;
  const r = await router.dispatch({ kind: 'noop', args: {} }, 3, sig);
  assert.equal(r.failure, undefined);
  assert.equal(adapter.calls.length, beforeNoop, 'noop 直返 —— adapter 不被调用');
});

// ─── ΠΑΝ-65：translateFailureKind 细分保真矩阵 ───
// ΤΕΛ-4（D-G20 清偿）：knowledge 词表已扩容（D7FailureKind = D-6
// ExecutionFailureKind ∪ {'timed-out'}）⇒ 翻译表退化为恒等直通——矩阵
// 从「三类折叠保义」改判为「逐值恒等」；未知 kind 兜底保守可重试保持。

test('ΠΑΝ-65: 错误细分恒等直通 —— 全部已知 kind 不折叠（ΤΕΛ-4/D-G20：词表扩容后的目标态）', async () => {
  const MATRIX: ReadonlyArray<[string, ReturnType<typeof translateFailureKind>]> = [
    // 基础六态恒等直通
    ['gate-rejected', 'gate-rejected'],
    ['host-error', 'host-error'],
    ['timeout', 'timeout'],
    ['timeout-aborted', 'timeout-aborted'], // ΤΕΛ-4: 不再折到 timeout——止损型超时归因独立可见
    ['timed-out', 'timed-out'],
    ['sandbox-degraded', 'sandbox-degraded'],
    ['cancelled', 'cancelled'],
    // ΝΩ-27 十四细分：恒等直通（不再折叠）
    ['unauthorized', 'unauthorized'],
    ['invalid-args', 'invalid-args'],
    ['out-of-bounds', 'out-of-bounds'],
    ['unknown-button', 'unknown-button'],
    ['unknown-key', 'unknown-key'],
    ['element-not-found', 'element-not-found'],
    ['screen-capture-failed', 'screen-capture-failed'],
    ['ocr-unavailable', 'ocr-unavailable'],
    ['vlm-unavailable', 'vlm-unavailable'],
    ['window-unavailable', 'window-unavailable'],
    ['transport-error', 'transport-error'],
    ['internal-error', 'internal-error'],
    // 版本漂移的未知 kind：保守可重试
    ['brand-new-kind-from-future-python', 'host-error'],
  ];
  for (const [src, want] of MATRIX) {
    assert.equal(translateFailureKind(src), want, `'${src}' 恒等直通 '${want}'（D-G20：细分不再折叠）`);
  }
  // 类别分治执法：认证/参数类与瞬态类必须可区分（恒等直通后更严格——逐值不等）
  assert.notEqual(translateFailureKind('unauthorized'), translateFailureKind('transport-error'),
    '认证类 ≠ 传输瞬态类（上层重试策略的判据）');
  assert.notEqual(translateFailureKind('cancelled'), translateFailureKind('element-not-found'),
    '终局类 ≠ 可重试类');
  assert.notEqual(translateFailureKind('timeout'), translateFailureKind('timeout-aborted'),
    '被动超时 ≠ 主动止损超时（ΝΩ-8 归因可见性——折叠回退即红）');
});

// ─── ΠΑΝ-66：mmap-file 路径防线 ───

function mmapMeta(name: string, size: number): ScreenshotResult {
  return {
    transport: 'mmap-file', name, size,
    shape: [size, 1, 1], dtype: 'uint8', stride: size, format: 'RAW',
    width: size, height: 1, captured_at: Date.now(), image_base64: '',
  };
}

test('ΠΑΝ-66: 白名单根内的合法路径可读；遍历拒绝（即使 resolve 后仍在根内）；根外 fail-closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pan66-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'pan66-out-'));
  try {
    allowMmapRoot(root);
    const good = join(root, 'shot.bin');
    writeFileSync(good, Buffer.alloc(16, 7));
    const buf = await readShm(mmapMeta(good, 16));
    assert.equal(buf.length, 16);
    assert.equal(buf[0], 7, '根内合法路径照常读取');

    // 遍历拒绝：原始段含 '..'（join 会归一化吃掉 '..'，须手工拼接保留原始段；
    // 即使规范化后仍落在根内 —— 服务端不该用回溯描述暂存文件）
    const traversal = [root, 'sub', '..', 'shot.bin'].join(sep);
    await assert.rejects(
      () => readShm(mmapMeta(traversal, 16)),
      (err: any) => err.kind === 'invalid_args' && /traversal/.test(err.detail),
      '显式 .. 段一律拒绝',
    );

    // fail-closed：根外路径拒绝（即使文件真实存在 —— 被攻破服务不得牵引读取任意文件）
    const evil = join(outside, 'secret.bin');
    writeFileSync(evil, Buffer.alloc(16, 9));
    await assert.rejects(
      () => readShm(mmapMeta(evil, 16)),
      (err: any) => err.kind === 'invalid_args' && /whitelisted|outside/.test(err.detail),
      '白名单根外 fail-closed',
    );

    // 清空显式注册根后仍拒绝（fail-closed 不因注册面清空而退化为全放行 —— 约定根在岗）
    clearMmapRoots();
    await assert.rejects(
      () => readShm(mmapMeta(evil, 16)),
      (err: any) => err.kind === 'invalid_args',
      '无显式根 ⇒ 仅约定根放行（收养流兼容），其余仍拒绝',
    );
  } finally {
    clearMmapRoots();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    await closeAllFds();
  }
});

test('ΠΑΝ-66: 约定根（~/.dsh/shots，Python 缺省/收养流同源）放行 —— 归因是 ENOENT 而非防线拒绝', async () => {
  clearMmapRoots();
  const conventional = join(homedir(), '.dsh', 'shots', 'pan66-probe.png');
  // 不真实创建文件：约定根内的路径过防线后在 open 处 ENOENT（element_not_found）
  // —— 证明防线放行了约定根（收养流兼容），而非一刀切拒绝。
  await assert.rejects(
    () => readShm(mmapMeta(conventional, 4)),
    (err: any) => err.kind === 'element_not_found' || err.kind === 'screen_capture_failed',
    '约定根内路径通过防线（ENOENT 是文件缺席的诚实归因，不是 invalid_args 防线拒绝）',
  );
});

// ─── ΠΑΝ-67a：adapter keyPromise 拒绝后可重试 ───

test('ΠΑΝ-67: keyPromise 拒绝后清零 —— 密钥文件迟到的瞬态故障可自愈（不再终身瘫痪）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pan67-key-'));
  try {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'not-a-dir');
    const keyPath = join(blocker, 'cap.key'); // dirname 是常规文件 ⇒ mkdir ENOTDIR 持续失败
    const adapter = createPhysicalExecution({
      baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 1000, keyPath, enableAuth: true,
    });
    const r1 = await adapter.init();
    assert.equal(r1.ok, false, '首次加载失败（密钥路径被常规文件占位）');
    assert.match(r1.ok ? '' : r1.error.detail, /key load failed/);

    // 障碍移除（密钥文件迟到的等价形态）：目录位置让开 ⇒ ensureKey 可创建
    rmSync(blocker);
    const r2 = await adapter.init();
    // 旧缺陷：state.keyPromise 仍缓存 rejected promise ⇒ r2 永远失败（终身瘫痪）；
    // ΠΑΝ-67：拒绝即清零 ⇒ 重新 loadKey ⇒ 自愈。
    assert.equal(r2.ok, true, '瞬态故障自愈：清零 rejected promise 后重新加载成功');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── ΠΑΝ-67b：respawnRuling 重生裁决 ───

test('ΠΑΝ-67: respawnRuling —— 有限次（3）+ 指数退避（500→1000，封顶 4000）+ 超限拒绝', () => {
  assert.equal(RESPAWN_MAX_ATTEMPTS, 3, '重生预算单源 = 3（有限次，不是无限重启循环）');
  assert.deepEqual(respawnRuling(0), { allow: true, backoffMs: 0 }, '首次尝试零退避');
  assert.deepEqual(respawnRuling(1), { allow: true, backoffMs: 500 }, '第一次失败后退避 500ms');
  assert.deepEqual(respawnRuling(2), { allow: true, backoffMs: 1000 }, '第二次失败后退避 1000ms');
  assert.deepEqual(respawnRuling(3), { allow: false }, '第三次失败后拒绝（预算耗尽 —— 诚实降级 transport 事件）');
  assert.deepEqual(respawnRuling(4), { allow: false }, '超限后持续拒绝');
  assert.deepEqual(respawnRuling(5, 10), { allow: true, backoffMs: 4000 }, '退避封顶 4000ms（不无限翻倍）');
  assert.deepEqual(respawnRuling(-1), { allow: false }, '域外输入 fail-closed');
});

// ─── ΠΑΝ-68：getUiTree 缺省 L2 ───

test('ΠΑΝ-68: getUiTree 缺省 funnel_ceiling=L2（缺省不自铸花钱权）；显式 L3 照常透传', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try { bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { /* 空体 */ }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        status: 'success',
        data: { elements: [], funnel_depth: 'empty', fault: null, captured_at: 0, l3_invoked: false },
        latency_ms: 1,
      }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const adapter = createPhysicalExecution({
      baseUrl: `http://127.0.0.1:${port}/v1`, timeoutMs: 2000, keyPath: '', enableAuth: false,
    });
    // 缺省调用（漏传 ceiling 的新调用方）：授权停在 L2
    const r1 = await adapter.getUiTree();
    assert.equal(r1.ok, true);
    assert.equal(bodies[0]!.funnel_ceiling, 'L2', '缺省 ceiling = L2（旧缺陷：缺省 L3 = D-5 层自铸花钱权）');
    // 显式要 L3 才花钱（与注意力治理对齐）
    const r2 = await adapter.getUiTree({ funnelCeiling: 'L3' });
    assert.equal(r2.ok, true);
    assert.equal(bodies[1]!.funnel_ceiling, 'L3', '显式 L3 透传（消费方要花钱才花钱）');
  } finally {
    server.close();
  }
});

// ─── 收尾：D7PhysicalHostPort 模块面无泄漏（翻译表 + 裁决导出在册）───

test('ΠΑΝ 面: d7HostPort 导出面 —— translateFailureKind / respawnRuling / RESPAWN_MAX_ATTEMPTS 在册（执法锁）', async () => {
  const host = new D7PhysicalHostPort({});
  try {
    assert.equal(typeof translateFailureKind, 'function');
    assert.equal(typeof respawnRuling, 'function');
    assert.equal(typeof RESPAWN_MAX_ATTEMPTS, 'number');
    assert.equal(host.manager.isRunning, false, '构造不 spawn（懒启动语义保持）');
  } finally {
    await host.dispose();
  }
});
