// src/physicalBackend.ts
// D-1 工具层的物理躯体：懒启动 D-5 Python 微服务并暴露 throw 语义的同步包装。
//
// 为什么存在：批次 E 移除了 nut-js / screenshot-desktop / sharp / tesseract.js
// 四个原生依赖，但 D-1 工具层（模型实际调用的 20+ 工具）从未接线到 D-5 ——
// 真机安装里 take_screenshot / click_mouse 全部抛「removed (batch-E)」。
// 本模块把 system.ts 的系统调用面整体路由到微服务：
//   - 截图：服务端叠加(SoM) + 缩放 + 编码 + 指纹(dhash/phash) + 变化门控
//   - 键鼠：click / type(SendInput) / scroll / hotkey / drag
//   - 感知：cursor / displays / 帧统计(物理规则) / 帧行亮度 / 帧差分
//
// 生命周期：懒启动（首个调用触发）；密钥与 mmap 目录用稳定路径
// （~/.dsh/physical.key / ~/.dsh/shots）—— 插件重载后可「收养」仍存活的服务
// （同一密钥 ⇒ HMAC 令牌互通），避免端口占用导致的启动失败。
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  PhysicalServiceManager,
  createPhysicalExecution,
  type PhysicalExecutionAdapter,
  type PhysicalExecutionAdapterImpl,
  type HealthInfo,
  type ScreenshotResult,
} from './physicalExecution/index.js';
// ΑΩ-R27 端口策略单源：BASE/SPAN 不再本地铸造 —— 与 serviceManager 的缺省
// 端口同源（完整策略对照表与「为何双策略并存」见 serviceManager.ts 文件头）。
// 本模块走「扫描 + 同密钥收养」策略（稳定密钥 ⇒ 重载后可收养旧服务），
// manager 走「单端口如实快报」策略（每回合随机密钥 ⇒ 收养永不可能成立）。
// 直引子模块与 contracts.js/shmReader.js 先例同律（常量非器官表面，不经 barrel）。
import {
  PHYSICAL_TCP_BASE_PORT as BASE_PORT,
  PHYSICAL_TCP_PORT_SPAN as PORT_SPAN,
} from './physicalExecution/serviceManager.js';

/** 稳定密钥路径 —— 与 Python 端默认值一致（收养已存活服务的前提） */
export function defaultKeyPath(): string {
  return process.env.DSH_PHYSICAL_KEY_PATH ?? join(homedir(), '.dsh', 'physical.key');
}

export function defaultMmapDir(): string {
  return process.env.DSH_PHYSICAL_MMAP_DIR ?? join(homedir(), '.dsh', 'shots');
}

// 端口扫描范围 8421..8428：常量已单源化至 serviceManager.ts（ΑΩ-R27）——
// 本文件经顶部 import 以 BASE_PORT / PORT_SPAN 别名消费，勿在此重新铸造数字。

export interface ProcessedCapture {
  /** 最终图像（叠加层已烧入）—— unchanged 时为 null */
  buffer: Buffer | null;
  width: number;
  height: number;
  /** 干净帧指纹（服务端计算） */
  dhash: string | null;
  phash: string | null;
  regionDhash: string | null;
  unchanged: boolean;
  /** 帧环 id（keepFrame 时）—— frame_stats/frame_diff 引用锚 */
  frameId: number | null;
  transport: string;
  /** Y-1/Y-2：显著度图（服务端熵引擎） */
  salience: import('./physicalExecution/contracts.js').SalienceMap | null;
  /**
   * Σ-5 多屏感知：实际捕获的显示器索引。null = 主屏缺省（未请求 display，
   * 或非 Windows 平台诚实降级 —— 此时服务端响应附 note）。仅 opts.display
   * 在场时由服务端回填。
   */
  display?: number | null;
  /**
   * W4-5 移动 Surface：实际捕获的 surface id（'host:<i>' / 'android:<serial>'）。
   * null = 未请求 surface（主机主屏现状）。仅 opts.surface 在场时由服务端回填
   * （兼容铁律：缺省调用不引入新键）。
   */
  surface?: string | null;
}

export interface OverlayBox {
  x: number; y: number; width: number; height: number;
  label?: string;
}

export interface CaptureOptions {
  format?: 'png' | 'jpeg';
  quality?: number;
  /** 归一化 region（zoom_inspect 用） */
  region?: { x: number; y: number; width: number; height: number };
  /** SoM 叠加层：网格分割数 */
  gridDivisions?: number;
  /** Y-1：服务端熵引擎自动中央凹 —— 热点区内网格 2x 加密 */
  autoFoveate?: boolean;
  /** 准星（全屏归一化） */
  crosshair?: { x: number; y: number };
  /** 元素框（全屏归一化） */
  boxes?: OverlayBox[];
  /** 编码前最大宽度 */
  maxWidth?: number;
  /** 叠加前放大倍数（zoom 用） */
  upscale?: number;
  wantHashes?: boolean;
  wantRegionHash?: { x: number; y: number; r: number };
  /** 变化门控：与参考指纹距离 ≤ distance ⇒ unchanged */
  gate?: { dhashRef: string; distance: number };
  keepFrame?: boolean;
  /** 只取指纹/帧缓存，不编码不传图（稳定轮询用） */
  metaOnly?: boolean;
  /** Y-1/Y-2：块级梯度熵显著度图 */
  wantSalience?: boolean;
  /**
   * Σ-5 多屏感知：显示器索引（0 起，/v1/displays 清单序）。缺省 = 主屏 = 现状
   * （请求字节等同）。选定后 region / crosshair / boxes 的归一化基准 = **所选
   * 显示器的矩形**（服务端在 PIL 最上游裁剪，下游管线无感继承）。
   * 非 Windows 服务端诚实降级主屏并附 note。
   */
  display?: number;
  /**
   * W4-5 移动 Surface：display 的字符串泛化 —— 'host:<i>' ≡ display=i；
   * 'android:<serial>' 路由到 scrcpy/adb 帧源（帧进同一管线 ⇒ dhash 变化
   * 门控 / 帧环 / 叠加层全部复用）。region / crosshair / boxes 的归一化基准
   * = 所选 surface 的矩形（[0,1]² 契约不破）。与 display 并存时 surface 获胜。
   */
  surface?: string;
}

interface BackendState {
  starting: Promise<PhysicalExecutionAdapter> | null;
  adapter: PhysicalExecutionAdapter | null;
  manager: PhysicalServiceManager | null;
  health: HealthInfo | null;
  screen: { width: number; height: number } | null;
  displays: Array<{ name: string; x: number; y: number; width: number; height: number; primary?: boolean }> | null;
}

const state: BackendState = {
  starting: null, adapter: null, manager: null,
  health: null, screen: null, displays: null,
};

// W6-2（doctor smell.over-engineering 清偿）：私有生命周期小件（probeAlive/versionLt）
// 已分区提取至 physicalBackend.internal.ts；Surface 方言与 diff_view 帧环 →
// physicalBackend.surface.ts。行为零变化；导入面不变 —— 再分发。
import { probeAlive, versionLt } from './physicalBackend.internal';
import { hostSurface as hostSurfaceOf, resetDiffFrameRing } from './physicalBackend.surface';
export { parseSurfaceId, hostSurface, androidSurface, noteFrameForDiff, lastTwoDiffFrames } from './physicalBackend.surface';
export type { SurfaceSpec } from './physicalBackend.surface';

/**
 * ΝΩ-25：physicalBackend 错误出口的结构化信封 —— Result 失败臂的 kind 通道
 * 透传到异常面。消息文本与既有 unwrap 方言逐字节一致（零回归），新增的只有
 * error.kind 字段：消费方（system.ts 的后端缺席判定）改读 kind，不再解析
 * 消息文本 —— 错误方言（消息文案）变更不再静默改道控制流。
 */
export class PhysicalBackendError extends Error {
  readonly kind: string;
  constructor(message: string, kind: string) {
    super(message);
    this.name = 'PhysicalBackendError';
    this.kind = kind;
  }
}

/** ΝΩ-25：unwrap 的 kind 透传版（消息格式与既有 unwrap 方言逐字节一致） */
function unwrapK<T>(result: { ok: true; value: T } | { ok: false; error: { kind: string; detail: string } }, what: string): T {
  if (result.ok) return result.value;
  throw new PhysicalBackendError(`[physicalBackend] ${what} failed: ${result.error.kind}: ${result.error.detail}`, result.error.kind);
}

async function startOnPort(port: number): Promise<PhysicalExecutionAdapter> {
  const manager = new PhysicalServiceManager({
    tcpPort: port,
    keyPath: defaultKeyPath(),
    mmapDir: defaultMmapDir(),
    screenshotTransport: 'mmap-file',
    startupTimeoutMs: 20_000,
  });
  const res = await manager.start();
  if (!res.ok) {
    // ΝΩ-25：启动失败同样透传 kind（spawn_failed/startup_timeout/crashed/port_squatted）
    throw new PhysicalBackendError(
      `[physicalBackend] service start failed on :${port}: ${res.error?.kind}: ${res.error?.detail}`,
      res.error?.kind ?? 'spawn_failed',
    );
  }
  const adapter = createPhysicalExecution({
    baseUrl: res.baseUrl,
    timeoutMs: 15_000,
    keyPath: res.keyPath,
  });
  try {
    unwrapK(await adapter.init(), 'adapter.init');
    const health = unwrapK(await adapter.health(), 'adapter.health');
    state.manager = manager;
    state.adapter = adapter;
    state.health = health;
    if (health.screen && 'width' in health.screen) {
      state.screen = { width: health.screen.width, height: health.screen.height };
    }
  } catch (e) {
    // init/health 失败：服务进程已 spawn，必须随失败一并处置 ——
    // 否则逐端口重试每失败一个端口就泄漏一个存活进程
    try { await manager.dispose(); } catch { /* dispose 失败不掩盖原始错误 */ }
    throw e;
  }
  return adapter;
}

/** 收养已存活服务：稳定密钥路径 ⇒ 同一 HMAC ⇒ 令牌互通 */
async function adoptExisting(port: number): Promise<boolean> {
  const adapter = createPhysicalExecution({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    timeoutMs: 15_000,
    keyPath: defaultKeyPath(),
  });
  unwrapK(await adapter.init(), 'adapter.init(adopt)');
  const health = await adapter.health();
  if (!health.ok) return false;
  // 版本闸门：旧版本服务（旧键表/旧端点面）不收养 —— 宁可换端口 spawn 新码。
  // 0.4.0：Z-1 世界行动端点（/move_mouse、/cursor_kind）入伍
  const MIN_SVC_VERSION = '0.4.0';
  if (versionLt(health.value.version ?? '0.0.0', MIN_SVC_VERSION)) return false;
  // 鉴权握手验证（收养的前提是同一密钥）：cursor 是最便宜的已鉴权端点
  const cursor = await adapter.getCursor();
  if (!cursor.ok) return false;
  state.adapter = adapter;
  state.health = health.value;
  if (health.value.screen && 'width' in health.value.screen) {
    state.screen = { width: health.value.screen.width, height: health.value.screen.height };
  }
  return true;
}

/**
 * ΝΩ-25：候选端口并行探活（上限并发 limit）。返回「首活」序的活端口清单 ——
 * 谁先给出活证据谁排前（Promise.any 的聚合等价物，但保留全量结果供回退）。
 * 串行最坏探活墙 = 端口数 × 800ms（端口被非 HTTP 监听占住时每次吃满超时）；
 * 并行后压缩为 ⌈n/limit⌉ 批。探活是只读 GET /health，并行无副作用。
 */
async function probeCandidatesOrdered(ports: readonly number[], limit: number): Promise<number[]> {
  const alive: number[] = [];
  let next = 0; // 单线程事件循环：同步段自增无交错
  const workerCount = Math.max(1, Math.min(limit, ports.length));
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push((async () => {
      while (next < ports.length) {
        const port = ports[next++];
        if (await probeAlive(port)) alive.push(port);
      }
    })());
  }
  await Promise.all(workers);
  return alive;
}

/**
 * 懒启动（并发安全）：已在跑 → 复用；端口被占 → 尝试收养；否则逐端口 spawn。
 *  ΑΩ-R27：本「扫描+收养」策略与 serviceManager 的「单端口如实快报」有意不同
 *  （密钥形态差异 + 重载收养收益），完整对照见 serviceManager.ts 文件头注释块。
 *  ΝΩ-25：候选端口并行探活（cap 4）→ 活端口按「首活」序收养（version 闸门
 *  语义不动：旧版本/密钥不通的服务不被收养，如实换位）→ 全不活/全不可收养
 *  ⇒ 死端口按序串行 spawn（同屏只铸一具躯体 —— spawn 不并行，失败换下一端口）。
 */
export function ensureBackend(): Promise<PhysicalExecutionAdapter> {
  if (state.adapter) return Promise.resolve(state.adapter);
  if (state.starting) return state.starting;

  const starting = (async () => {
    let lastErr: Error | null = null;
    const candidates = Array.from({ length: PORT_SPAN }, (_, i) => BASE_PORT + i);
    const alive = await probeCandidatesOrdered(candidates, 4);
    const aliveSet = new Set(alive);
    for (const port of alive) {
      try {
        if (await adoptExisting(port)) return state.adapter!;
        // 有服务但密钥/版本不通（外部实例）—— 换下一个活端口
      } catch (e: any) {
        lastErr = e; // 收养链路自身失败（传输/超时）→ 记因后继续
      }
    }
    for (const port of candidates) {
      if (aliveSet.has(port)) continue; // 活而不可收养（外部实例）—— 不在其上 spawn
      try {
        return await startOnPort(port);
      } catch (e: any) {
        lastErr = e;
        // spawn 失败（端口被占但探活超时/python 缺失等）→ 尝试下一端口
      }
    }
    state.starting = null;
    throw lastErr ?? new Error('[physicalBackend] no free port in range');
  })();
  state.starting = starting;

  // 拒绝清理只认自身承诺：迟到的 catch 不得清掉后来者新铸的 starting（并发双 spawn 竞态）
  starting.catch(() => { if (state.starting === starting) state.starting = null; });
  return starting;
}

async function adapter(): Promise<PhysicalExecutionAdapter> {
  return ensureBackend();
}

// ─── 截图：一次服务端往返完成叠加/缩放/编码/指纹/门控 ───

export async function captureProcessed(opts: CaptureOptions = {}): Promise<ProcessedCapture> {
  const a = await adapter();
  const overlay: Record<string, unknown> = {};
  if (opts.gridDivisions) overlay.grid_divisions = opts.gridDivisions;
  if (opts.autoFoveate) overlay.auto_foveate = true;
  if (opts.crosshair) overlay.crosshair = opts.crosshair;
  if (opts.boxes?.length) overlay.boxes = opts.boxes;

  // Σ-5：display 透传需 impl 的扩展参数面（contracts 的接口签名未含 display ——
  // 产权铁律下不改 contracts.ts，桥接类型断言到 impl）
  const meta = unwrapK(await (a as PhysicalExecutionAdapterImpl).takeScreenshot({
    format: opts.format ?? 'jpeg',
    quality: opts.quality,
    region: opts.region,
    overlay: Object.keys(overlay).length ? overlay : undefined,
    maxWidth: opts.maxWidth,
    upscale: opts.upscale,
    wantHashes: opts.wantHashes,
    wantRegionHash: opts.wantRegionHash,
    gate: opts.gate,
    keepFrame: opts.keepFrame,
    metaOnly: opts.metaOnly,
    wantSalience: opts.wantSalience,
    // Σ-5：undefined ⇒ JSON 序列化丢弃键 ⇒ 请求字节与现状等同（兼容铁律）
    display: opts.display,
    // W4-5：同律（缺省键缺席 ⇒ 请求字节与现状等同）
    surface: opts.surface,
  }), 'take_screenshot') as ScreenshotResult & { display?: number | null; surface?: string | null };

  const unchanged = !!meta.unchanged;
  if (unchanged || opts.metaOnly) {
    return {
      buffer: null, width: meta.width || 0, height: meta.height || 0,
      dhash: meta.dhash ?? null, phash: meta.phash ?? null,
      regionDhash: meta.region_dhash ?? null,
      unchanged, frameId: meta.frame_id ?? null,
      transport: meta.transport,
      salience: meta.salience ?? null,
      display: meta.display ?? null,
      surface: meta.surface ?? null,
    };
  }

  // 读取图像字节：readShm 统一处理 base64（内联）与 mmap-file（零拷贝文件）
  let buffer: Buffer;
  if (!meta.name && !(meta.transport === 'base64' && meta.image_base64)) {
    throw new Error(`[physicalBackend] screenshot returned no image (transport=${meta.transport})`);
  }
  const { readShm } = await import('./physicalExecution/shmReader.js');
  buffer = await readShm(meta);

  return {
    buffer,
    width: meta.width,
    height: meta.height,
    dhash: meta.dhash ?? null,
    phash: meta.phash ?? null,
    regionDhash: meta.region_dhash ?? null,
    unchanged: false,
    frameId: meta.frame_id ?? null,
    transport: meta.transport,
    salience: meta.salience ?? null,
    display: meta.display ?? null,
    surface: meta.surface ?? null,
  };
}

// ─── 纯净截屏（无叠加层）：语义核对 OCR / 记忆预验等 ───

export async function captureCleanPng(region?: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
  const r = await captureProcessed({ format: 'png', region, maxWidth: 1600 });
  if (!r.buffer) throw new Error('[physicalBackend] clean capture unexpectedly unchanged-gated');
  return r.buffer;
}

// ─── 键鼠动作 ───
// ΤΕΛ-5 D-G23：门面函数补可选 signal 透传面（adapter 侧 ΠΑΝ-64 管线已在：
// signal → microFetch options.signal 断流）。缺席 ⇒ JSON 丢键 ⇒ 请求字节等同
// 现状（零回归）；system.ts 的 ioMutex 取消端口经此抵达 D-5 HTTP 调用。

export async function clickMouse(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', dryRun = false, surface?: string, signal?: AbortSignal): Promise<void> {
  const a = await adapter();
  // W4-5：surface 经 impl 扩展参数面透传（Σ-5 的 display 同型 —— contracts
  // 接口签名未含，桥接断言到 impl；undefined ⇒ JSON 丢键 ⇒ 请求字节等同现状）
  unwrapK(await (a as PhysicalExecutionAdapterImpl).clickMouse({ x, y, button, dryRun, surface, signal }), 'click_mouse');
}

export async function typeText(text: string, clearFirst = false, dryRun = false, surface?: string, signal?: AbortSignal): Promise<number> {
  const a = await adapter();
  const r = unwrapK(await (a as PhysicalExecutionAdapterImpl).typeText({ text, clearFirst, dryRun, surface, signal }), 'type_text');
  return r.typed_chars;
}

export async function scrollPage(direction: 'up' | 'down' | 'left' | 'right', amount: number, dryRun = false, surface?: string, signal?: AbortSignal): Promise<void> {
  const a = await adapter();
  unwrapK(await (a as PhysicalExecutionAdapterImpl).scrollPage({ direction, amount, dryRun, surface, signal }), 'scroll_page');
}

export async function pressHotkey(keys: string[], dryRun = false, surface?: string, signal?: AbortSignal): Promise<void> {
  const a = await adapter();
  unwrapK(await (a as PhysicalExecutionAdapterImpl).pressHotkey({ keys, dryRun, surface, signal }), 'press_hotkey');
}

export async function dragMouse(start: { x: number; y: number }, end: { x: number; y: number }, dryRun = false, surface?: string, signal?: AbortSignal): Promise<void> {
  const a = await adapter();
  unwrapK(await (a as PhysicalExecutionAdapterImpl).dragMouse({ start, end, dryRun, surface, signal }), 'drag_mouse');
}

/** 移动鼠标（无点击）—— Z-1 交互性探针的悬停躯体（归一化坐标） */
export async function moveMouse(x: number, y: number, durationMs = 0, dryRun = false, signal?: AbortSignal): Promise<void> {
  const a = await adapter();
  unwrapK(await a.moveMouse({ x, y, durationMs, dryRun, signal }), 'move_mouse');
}

/** 当前全局光标形态 —— Z-1 交互性探针的 OS 判决通道 */
export async function getCursorKind(): Promise<import('./physicalExecution/contracts.js').CursorKindInfo> {
  const a = await adapter();
  return unwrapK(await a.getCursorKind(), 'cursor_kind');
}

/** UIA 单点结构查询 —— Z-1 第三通道（结构层判决，零物理副作用） */
export async function hitTest(x: number, y: number): Promise<import('./physicalExecution/contracts.js').HitTestResult> {
  const a = await adapter();
  return unwrapK(await a.hitTest({ x, y }), 'hit_test');
}

export async function switchWindow(keyword: string): Promise<{ method: string; matched: string | null; next_step?: string }> {
  const a = await adapter();
  return unwrapK(await a.switchWindow({ keyword }), 'switch_window');
}

// ─── R2-3（焦点保卫）：前台窗口只读探测（type_text 前置校验的数据源） ───

export async function getActiveWindow(): Promise<{ method: 'native'; title: string | null }> {
  const a = await adapter();
  return unwrapK(await a.getActiveWindow(), 'active_window');
}

// ─── 感知辅助 ───

export async function getCursor(): Promise<{ x: number; y: number }> {
  const a = await adapter();
  return unwrapK(await a.getCursor(), 'cursor');
}

export async function getDisplays(): Promise<Array<{ name: string; x: number; y: number; width: number; height: number; primary?: boolean }>> {
  if (state.displays) return state.displays;
  const a = await adapter();
  const r = unwrapK(await a.getDisplays(), 'displays');
  state.displays = r.displays;
  return state.displays;
}

// ─── W4-5 移动 Surface：surface id 方言已提取至 physicalBackend.surface.ts ───

/** /v1/devices 响应体（镜像 Python 端 AndroidController.list_devices ——
 *  impl 侧 getDevices 的返回型；契约层 contracts.ts 未含此 DTO，本地结构化）。 */
export interface MobileDeviceInventory {
  devices: Array<{
    serial: string;
    state: string;
    surface_id: string;
    resolution: { width: number; height: number } | null;
  }>;
  degraded: boolean;
  reason?: string;
}

/** adb 设备清单（真机/adb 缺席 ⇒ 空清单 + degraded + 真实原因 —— 诚实降级）。 */
export async function listMobileDevices(): Promise<MobileDeviceInventory> {
  const a = await adapter();
  return unwrapK(await (a as PhysicalExecutionAdapterImpl).getDevices(), 'devices');
}

/** 全量 surface 清单（主机显示器 + 移动设备统一入列 —— 多屏感知的移动扩展）。 */
export async function listSurfaces(): Promise<{
  host: string[];
  android: string[];
  degraded: boolean;
  reason?: string;
}> {
  const [displays, inventory] = await Promise.all([getDisplays(), listMobileDevices()]);
  return {
    host: displays.map((_, i) => hostSurfaceOf(i)),
    android: inventory.devices.map(d => d.surface_id),
    degraded: inventory.degraded,
    ...(inventory.reason ? { reason: inventory.reason } : {}),
  };
}

export async function getScreenSize(): Promise<{ width: number; height: number }> {
  if (state.screen) return state.screen;
  const a = await adapter();
  const h = unwrapK(await a.health(), 'health');
  if (!h.screen || !('width' in h.screen)) {
    throw new Error(`[physicalBackend] screen size unavailable: ${JSON.stringify(h.screen)}`);
  }
  state.screen = { width: h.screen.width, height: h.screen.height };
  return state.screen;
}

export async function frameStats(frameId: number, regions: Array<{ x: number; y: number; width: number; height: number }>): Promise<Array<{ mean: number | null; stdev: number | null }>> {
  const a = await adapter();
  return unwrapK(await a.frameStats(frameId, regions), 'frame_stats').stats;
}

export async function frameRowmeans(frameId: number, grid = 64): Promise<number[]> {
  const a = await adapter();
  return unwrapK(await a.frameRowmeans(frameId, grid), 'frame_rowmeans').rows;
}

export async function frameDiff(args: {
  frameA: number; frameB: number; block?: number; annotate?: boolean;
}): Promise<{
  changed_regions: Array<{ x: number; y: number; width: number; height: number }>;
  region_count: number;
  annotated_image_base64?: string;
}> {
  const a = await adapter();
  return unwrapK(await a.frameDiff(args), 'frame_diff');
}

export async function getUiTree(args?: {
  source?: 'auto' | 'tree' | 'ocr' | 'vlm';
  region?: { x: number; y: number; width: number; height: number };
  funnelCeiling?: 'L1' | 'L2' | 'L3';
}) {
  const a = await adapter();
  return unwrapK(await a.getUiTree(args), 'get_ui_tree');
}

export function healthSnapshot(): HealthInfo | null {
  return state.health;
}

/** 生命周期归零（插件卸载 / 测试） */
export async function stopBackend(): Promise<void> {
  state.starting = null;
  state.adapter = null;
  state.health = null;
  state.screen = null;
  state.displays = null;
  resetDiffFrameRing(); // W6-2：帧环随 surface 分区搬迁，归零语义逐字节不变
  if (state.manager) {
    const m = state.manager;
    state.manager = null;
    try { await m.dispose(); } catch { /* noop */ }
  }
}

/** Σ-5 测试面：假 adapter 直入 state（免 spawn —— CaptureOptions 透传的纯逻辑测试）。
 *  传 null 清除 adapter（不 dispose manager —— 测试自管）。 */
export function _setAdapterForTests(a: PhysicalExecutionAdapter | null): void {
  state.starting = null;
  state.adapter = a;
  state.displays = null;
}
