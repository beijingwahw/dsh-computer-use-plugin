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
import { PhysicalServiceManager, createPhysicalExecution, } from './physicalExecution/index.js';
/** 稳定密钥路径 —— 与 Python 端默认值一致（收养已存活服务的前提） */
export function defaultKeyPath() {
    return process.env.DSH_PHYSICAL_KEY_PATH ?? join(homedir(), '.dsh', 'physical.key');
}
export function defaultMmapDir() {
    return process.env.DSH_PHYSICAL_MMAP_DIR ?? join(homedir(), '.dsh', 'shots');
}
const BASE_PORT = 8421;
const PORT_SPAN = 8; // 8421..8428
const state = {
    starting: null, adapter: null, manager: null,
    health: null, screen: null, displays: null,
};
// W6-2（doctor smell.over-engineering 清偿）：私有生命周期小件（unwrap/probeAlive/versionLt）
// 已分区提取至 physicalBackend.internal.ts；Surface 方言与 diff_view 帧环 →
// physicalBackend.surface.ts。行为零变化；导入面不变 —— 再分发。
import { unwrap, probeAlive, versionLt } from './physicalBackend.internal.js';
import { hostSurface as hostSurfaceOf, resetDiffFrameRing } from './physicalBackend.surface.js';
export { parseSurfaceId, hostSurface, androidSurface, noteFrameForDiff, lastTwoDiffFrames } from './physicalBackend.surface.js';
async function startOnPort(port) {
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
    try {
        unwrap(await adapter.init(), 'adapter.init');
        const health = unwrap(await adapter.health(), 'adapter.health');
        state.manager = manager;
        state.adapter = adapter;
        state.health = health;
        if (health.screen && 'width' in health.screen) {
            state.screen = { width: health.screen.width, height: health.screen.height };
        }
    }
    catch (e) {
        // init/health 失败：服务进程已 spawn，必须随失败一并处置 ——
        // 否则逐端口重试每失败一个端口就泄漏一个存活进程
        try {
            await manager.dispose();
        }
        catch { /* dispose 失败不掩盖原始错误 */ }
        throw e;
    }
    return adapter;
}
/** 收养已存活服务：稳定密钥路径 ⇒ 同一 HMAC ⇒ 令牌互通 */
async function adoptExisting(port) {
    const adapter = createPhysicalExecution({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        timeoutMs: 15_000,
        keyPath: defaultKeyPath(),
    });
    unwrap(await adapter.init(), 'adapter.init(adopt)');
    const health = await adapter.health();
    if (!health.ok)
        return false;
    // 版本闸门：旧版本服务（旧键表/旧端点面）不收养 —— 宁可换端口 spawn 新码。
    // 0.4.0：Z-1 世界行动端点（/move_mouse、/cursor_kind）入伍
    const MIN_SVC_VERSION = '0.4.0';
    if (versionLt(health.value.version ?? '0.0.0', MIN_SVC_VERSION))
        return false;
    // 鉴权握手验证（收养的前提是同一密钥）：cursor 是最便宜的已鉴权端点
    const cursor = await adapter.getCursor();
    if (!cursor.ok)
        return false;
    state.adapter = adapter;
    state.health = health.value;
    if (health.value.screen && 'width' in health.value.screen) {
        state.screen = { width: health.value.screen.width, height: health.value.screen.height };
    }
    return true;
}
/** 懒启动（并发安全）：已在跑 → 复用；端口被占 → 尝试收养；否则逐端口 spawn */
export function ensureBackend() {
    if (state.adapter)
        return Promise.resolve(state.adapter);
    if (state.starting)
        return state.starting;
    const starting = (async () => {
        let lastErr = null;
        for (let i = 0; i < PORT_SPAN; i++) {
            const port = BASE_PORT + i;
            try {
                if (await probeAlive(port)) {
                    if (await adoptExisting(port))
                        return state.adapter;
                    // 有服务但密钥不通（外部实例）—— 换下一个端口
                    continue;
                }
                return await startOnPort(port);
            }
            catch (e) {
                lastErr = e;
                // spawn 失败（端口被占但探活超时/python 缺失等）→ 尝试下一端口
                continue;
            }
        }
        state.starting = null;
        throw lastErr ?? new Error('[physicalBackend] no free port in range');
    })();
    state.starting = starting;
    // 拒绝清理只认自身承诺：迟到的 catch 不得清掉后来者新铸的 starting（并发双 spawn 竞态）
    starting.catch(() => { if (state.starting === starting)
        state.starting = null; });
    return starting;
}
async function adapter() {
    return ensureBackend();
}
// ─── 截图：一次服务端往返完成叠加/缩放/编码/指纹/门控 ───
export async function captureProcessed(opts = {}) {
    const a = await adapter();
    const overlay = {};
    if (opts.gridDivisions)
        overlay.grid_divisions = opts.gridDivisions;
    if (opts.autoFoveate)
        overlay.auto_foveate = true;
    if (opts.crosshair)
        overlay.crosshair = opts.crosshair;
    if (opts.boxes?.length)
        overlay.boxes = opts.boxes;
    // Σ-5：display 透传需 impl 的扩展参数面（contracts 的接口签名未含 display ——
    // 产权铁律下不改 contracts.ts，桥接类型断言到 impl）
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
        // Σ-5：undefined ⇒ JSON 序列化丢弃键 ⇒ 请求字节与现状等同（兼容铁律）
        display: opts.display,
        // W4-5：同律（缺省键缺席 ⇒ 请求字节与现状等同）
        surface: opts.surface,
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
            display: meta.display ?? null,
            surface: meta.surface ?? null,
        };
    }
    // 读取图像字节：readShm 统一处理 base64（内联）与 mmap-file（零拷贝文件）
    let buffer;
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
export async function captureCleanPng(region) {
    const r = await captureProcessed({ format: 'png', region, maxWidth: 1600 });
    if (!r.buffer)
        throw new Error('[physicalBackend] clean capture unexpectedly unchanged-gated');
    return r.buffer;
}
// ─── 键鼠动作 ───
export async function clickMouse(x, y, button = 'left', dryRun = false, surface) {
    const a = await adapter();
    // W4-5：surface 经 impl 扩展参数面透传（Σ-5 的 display 同型 —— contracts
    // 接口签名未含，桥接断言到 impl；undefined ⇒ JSON 丢键 ⇒ 请求字节等同现状）
    unwrap(await a.clickMouse({ x, y, button, dryRun, surface }), 'click_mouse');
}
export async function typeText(text, clearFirst = false, dryRun = false, surface) {
    const a = await adapter();
    const r = unwrap(await a.typeText({ text, clearFirst, dryRun, surface }), 'type_text');
    return r.typed_chars;
}
export async function scrollPage(direction, amount, dryRun = false, surface) {
    const a = await adapter();
    unwrap(await a.scrollPage({ direction, amount, dryRun, surface }), 'scroll_page');
}
export async function pressHotkey(keys, dryRun = false, surface) {
    const a = await adapter();
    unwrap(await a.pressHotkey({ keys, dryRun, surface }), 'press_hotkey');
}
export async function dragMouse(start, end, dryRun = false, surface) {
    const a = await adapter();
    unwrap(await a.dragMouse({ start, end, dryRun, surface }), 'drag_mouse');
}
/** 移动鼠标（无点击）—— Z-1 交互性探针的悬停躯体（归一化坐标） */
export async function moveMouse(x, y, durationMs = 0, dryRun = false) {
    const a = await adapter();
    unwrap(await a.moveMouse({ x, y, durationMs, dryRun }), 'move_mouse');
}
/** 当前全局光标形态 —— Z-1 交互性探针的 OS 判决通道 */
export async function getCursorKind() {
    const a = await adapter();
    return unwrap(await a.getCursorKind(), 'cursor_kind');
}
/** UIA 单点结构查询 —— Z-1 第三通道（结构层判决，零物理副作用） */
export async function hitTest(x, y) {
    const a = await adapter();
    return unwrap(await a.hitTest({ x, y }), 'hit_test');
}
export async function switchWindow(keyword) {
    const a = await adapter();
    return unwrap(await a.switchWindow({ keyword }), 'switch_window');
}
// ─── 感知辅助 ───
export async function getCursor() {
    const a = await adapter();
    return unwrap(await a.getCursor(), 'cursor');
}
export async function getDisplays() {
    if (state.displays)
        return state.displays;
    const a = await adapter();
    const r = unwrap(await a.getDisplays(), 'displays');
    state.displays = r.displays;
    return state.displays;
}
/** adb 设备清单（真机/adb 缺席 ⇒ 空清单 + degraded + 真实原因 —— 诚实降级）。 */
export async function listMobileDevices() {
    const a = await adapter();
    return unwrap(await a.getDevices(), 'devices');
}
/** 全量 surface 清单（主机显示器 + 移动设备统一入列 —— 多屏感知的移动扩展）。 */
export async function listSurfaces() {
    const [displays, inventory] = await Promise.all([getDisplays(), listMobileDevices()]);
    return {
        host: displays.map((_, i) => hostSurfaceOf(i)),
        android: inventory.devices.map(d => d.surface_id),
        degraded: inventory.degraded,
        ...(inventory.reason ? { reason: inventory.reason } : {}),
    };
}
export async function getScreenSize() {
    if (state.screen)
        return state.screen;
    const a = await adapter();
    const h = unwrap(await a.health(), 'health');
    if (!h.screen || !('width' in h.screen)) {
        throw new Error(`[physicalBackend] screen size unavailable: ${JSON.stringify(h.screen)}`);
    }
    state.screen = { width: h.screen.width, height: h.screen.height };
    return state.screen;
}
export async function frameStats(frameId, regions) {
    const a = await adapter();
    return unwrap(await a.frameStats(frameId, regions), 'frame_stats').stats;
}
export async function frameRowmeans(frameId, grid = 64) {
    const a = await adapter();
    return unwrap(await a.frameRowmeans(frameId, grid), 'frame_rowmeans').rows;
}
export async function frameDiff(args) {
    const a = await adapter();
    return unwrap(await a.frameDiff(args), 'frame_diff');
}
export async function getUiTree(args) {
    const a = await adapter();
    return unwrap(await a.getUiTree(args), 'get_ui_tree');
}
export function healthSnapshot() {
    return state.health;
}
/** 生命周期归零（插件卸载 / 测试） */
export async function stopBackend() {
    state.starting = null;
    state.adapter = null;
    state.health = null;
    state.screen = null;
    state.displays = null;
    resetDiffFrameRing(); // W6-2：帧环随 surface 分区搬迁，归零语义逐字节不变
    if (state.manager) {
        const m = state.manager;
        state.manager = null;
        try {
            await m.dispose();
        }
        catch { /* noop */ }
    }
}
export function _reset_forTests() {
    state.starting = null;
    state.adapter = null;
    state.manager = null;
    state.health = null;
    state.screen = null;
    state.displays = null;
}
/** Σ-5 测试面：假 adapter 直入 state（免 spawn —— CaptureOptions 透传的纯逻辑测试）。
 *  传 null 等效 _reset_forTests 的 adapter 清除（不 dispose manager —— 测试自管）。 */
export function _setAdapterForTests(a) {
    state.starting = null;
    state.adapter = a;
    state.displays = null;
}
