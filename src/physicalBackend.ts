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
  type HealthInfo,
} from './physicalExecution/index.js';

/** 稳定密钥路径 —— 与 Python 端默认值一致（收养已存活服务的前提） */
export function defaultKeyPath(): string {
  return process.env.DSH_PHYSICAL_KEY_PATH ?? join(homedir(), '.dsh', 'physical.key');
}

export function defaultMmapDir(): string {
  return process.env.DSH_PHYSICAL_MMAP_DIR ?? join(homedir(), '.dsh', 'shots');
}

const BASE_PORT = 8421;
const PORT_SPAN = 8; // 8421..8428

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

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { kind: string; detail: string } }, what: string): T {
  if (result.ok) return result.value;
  throw new Error(`[physicalBackend] ${what} failed: ${result.error.kind}: ${result.error.detail}`);
}

/** 端口占用探测：健康端点有响应即视为「已有服务存活」 */
async function probeAlive(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      signal: AbortSignal.timeout(800),
    });
    return resp.ok;
  } catch {
    return false;
  }
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
    throw new Error(`[physicalBackend] service start failed on :${port}: ${res.error?.kind}: ${res.error?.detail}`);
  }
  const adapter = createPhysicalExecution({
    baseUrl: res.baseUrl,
    timeoutMs: 15_000,
    keyPath: res.keyPath,
  });
  unwrap(await adapter.init(), 'adapter.init');
  const health = unwrap(await adapter.health(), 'adapter.health');
  state.manager = manager;
  state.adapter = adapter;
  state.health = health;
  if (health.screen && 'width' in health.screen) {
    state.screen = { width: health.screen.width, height: health.screen.height };
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
  unwrap(await adapter.init(), 'adapter.init(adopt)');
  const health = await adapter.health();
  if (!health.ok) return false;
  // 版本闸门：旧版本服务（旧键表/旧端点面）不收养 —— 宁可换端口 spawn 新码
  const MIN_SVC_VERSION = '0.3.0';
  if ((health.value.version ?? '0.0.0') < MIN_SVC_VERSION) return false;
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

/** 懒启动（并发安全）：已在跑 → 复用；端口被占 → 尝试收养；否则逐端口 spawn */
export function ensureBackend(): Promise<PhysicalExecutionAdapter> {
  if (state.adapter) return Promise.resolve(state.adapter);
  if (state.starting) return state.starting;

  state.starting = (async () => {
    let lastErr: Error | null = null;
    for (let i = 0; i < PORT_SPAN; i++) {
      const port = BASE_PORT + i;
      try {
        if (await probeAlive(port)) {
          if (await adoptExisting(port)) return state.adapter!;
          // 有服务但密钥不通（外部实例）—— 换下一个端口
          continue;
        }
        return await startOnPort(port);
      } catch (e: any) {
        lastErr = e;
        // spawn 失败（端口被占但探活超时/python 缺失等）→ 尝试下一端口
        continue;
      }
    }
    state.starting = null;
    throw lastErr ?? new Error('[physicalBackend] no free port in range');
  })();

  state.starting.catch(() => { state.starting = null; });
  return state.starting;
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

  const meta = unwrap(await a.takeScreenshot({
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
  }), 'take_screenshot');

  const unchanged = !!meta.unchanged;
  if (unchanged || opts.metaOnly) {
    return {
      buffer: null, width: meta.width || 0, height: meta.height || 0,
      dhash: meta.dhash ?? null, phash: meta.phash ?? null,
      regionDhash: meta.region_dhash ?? null,
      unchanged, frameId: meta.frame_id ?? null,
      transport: meta.transport,
      salience: meta.salience ?? null,
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
  };
}

// ─── 纯净截屏（无叠加层）：语义核对 OCR / 记忆预验等 ───

export async function captureCleanPng(region?: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
  const r = await captureProcessed({ format: 'png', region, maxWidth: 1600 });
  if (!r.buffer) throw new Error('[physicalBackend] clean capture unexpectedly unchanged-gated');
  return r.buffer;
}

// ─── 键鼠动作 ───

export async function clickMouse(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', dryRun = false): Promise<void> {
  const a = await adapter();
  unwrap(await a.clickMouse({ x, y, button, dryRun }), 'click_mouse');
}

export async function typeText(text: string, clearFirst = false, dryRun = false): Promise<number> {
  const a = await adapter();
  const r = unwrap(await a.typeText({ text, clearFirst, dryRun }), 'type_text');
  return r.typed_chars;
}

export async function scrollPage(direction: 'up' | 'down' | 'left' | 'right', amount: number, dryRun = false): Promise<void> {
  const a = await adapter();
  unwrap(await a.scrollPage({ direction, amount, dryRun }), 'scroll_page');
}

export async function pressHotkey(keys: string[], dryRun = false): Promise<void> {
  const a = await adapter();
  unwrap(await a.pressHotkey({ keys, dryRun }), 'press_hotkey');
}

export async function dragMouse(start: { x: number; y: number }, end: { x: number; y: number }, dryRun = false): Promise<void> {
  const a = await adapter();
  unwrap(await a.dragMouse({ start, end, dryRun }), 'drag_mouse');
}

export async function switchWindow(keyword: string): Promise<{ method: string; matched: string | null; next_step?: string }> {
  const a = await adapter();
  return unwrap(await a.switchWindow({ keyword }), 'switch_window');
}

// ─── 感知辅助 ───

export async function getCursor(): Promise<{ x: number; y: number }> {
  const a = await adapter();
  return unwrap(await a.getCursor(), 'cursor');
}

export async function getDisplays(): Promise<Array<{ name: string; x: number; y: number; width: number; height: number; primary?: boolean }>> {
  if (state.displays) return state.displays;
  const a = await adapter();
  const r = unwrap(await a.getDisplays(), 'displays');
  state.displays = r.displays;
  return state.displays;
}

export async function getScreenSize(): Promise<{ width: number; height: number }> {
  if (state.screen) return state.screen;
  const a = await adapter();
  const h = unwrap(await a.health(), 'health');
  if (!h.screen || !('width' in h.screen)) {
    throw new Error(`[physicalBackend] screen size unavailable: ${JSON.stringify(h.screen)}`);
  }
  state.screen = { width: h.screen.width, height: h.screen.height };
  return state.screen;
}

export async function frameStats(frameId: number, regions: Array<{ x: number; y: number; width: number; height: number }>): Promise<Array<{ mean: number | null; stdev: number | null }>> {
  const a = await adapter();
  return unwrap(await a.frameStats(frameId, regions), 'frame_stats').stats;
}

export async function frameRowmeans(frameId: number, grid = 64): Promise<number[]> {
  const a = await adapter();
  return unwrap(await a.frameRowmeans(frameId, grid), 'frame_rowmeans').rows;
}

export async function frameDiff(args: {
  frameA: number; frameB: number; block?: number; annotate?: boolean;
}): Promise<{
  changed_regions: Array<{ x: number; y: number; width: number; height: number }>;
  region_count: number;
  annotated_image_base64?: string;
}> {
  const a = await adapter();
  return unwrap(await a.frameDiff(args), 'frame_diff');
}

export async function getUiTree(args?: {
  source?: 'auto' | 'tree' | 'ocr' | 'vlm';
  region?: { x: number; y: number; width: number; height: number };
  funnelCeiling?: 'L1' | 'L2' | 'L3';
}) {
  const a = await adapter();
  return unwrap(await a.getUiTree(args), 'get_ui_tree');
}

export function healthSnapshot(): HealthInfo | null {
  return state.health;
}

// ─── diff_view 帧登记：最近两张 keepFrame 截图的服务端帧 id ───

const diffFrameRing: number[] = [];

/** take_screenshot（keepFrame 捕获）登记帧 id —— diff_view 的默认对比对 */
export function noteFrameForDiff(frameId: number | null): void {
  if (frameId == null) return;
  diffFrameRing.push(frameId);
  while (diffFrameRing.length > 2) diffFrameRing.shift();
}

/** 最近两张已登记帧（旧在前）；不足两张返回 null */
export function lastTwoDiffFrames(): [number, number] | null {
  if (diffFrameRing.length < 2) return null;
  return [diffFrameRing[diffFrameRing.length - 2], diffFrameRing[diffFrameRing.length - 1]];
}

/** 生命周期归零（插件卸载 / 测试） */
export async function stopBackend(): Promise<void> {
  state.starting = null;
  state.adapter = null;
  state.health = null;
  state.screen = null;
  state.displays = null;
  diffFrameRing.length = 0;
  if (state.manager) {
    const m = state.manager;
    state.manager = null;
    try { await m.dispose(); } catch { /* noop */ }
  }
}

export function _reset_forTests(): void {
  state.starting = null;
  state.adapter = null;
  state.manager = null;
  state.health = null;
  state.screen = null;
  state.displays = null;
}
