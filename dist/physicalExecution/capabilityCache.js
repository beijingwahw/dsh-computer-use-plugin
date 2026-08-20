/** 缓存 TTL：超过此时间自动失效（默认 60s） */
const CACHE_TTL_MS = 60000;
/** Capability Cache 实现 */
export class CapabilityCache {
    snapshot = null;
    ttlMs;
    constructor(ttlMs = CACHE_TTL_MS) {
        this.ttlMs = ttlMs;
    }
    /** 从 HealthInfo 更新缓存 —— 用于启动期探活后填充 */
    updateFromHealth(health) {
        this.snapshot = {
            switchWindowMethod: health.switch_window_method,
            uiFunnelL1: health.ui_funnel.l1_tree,
            uiFunnelL2: health.ui_funnel.l2_ocr,
            uiFunnelL3: health.ui_funnel.l3_vlm,
            screenshotTransport: health.screenshot_transport,
            capturedAt: Date.now(),
        };
    }
    /** Reactive 更新 —— 路由层收到响应后即时同步状态 */
    updateSwitchWindowMethod(method) {
        if (!this.snapshot) {
            // 缓存尚未建立 —— 但仍记录此字段（懒初始化）
            this.snapshot = {
                switchWindowMethod: method,
                uiFunnelL1: 'unavailable',
                uiFunnelL2: 'unavailable',
                uiFunnelL3: 'unknown',
                screenshotTransport: 'base64',
                capturedAt: Date.now(),
            };
            return;
        }
        if (this.snapshot.switchWindowMethod === method)
            return;
        // 状态变化 —— 立即更新（不重置 capturedAt，保留原 TTL）
        this.snapshot = { ...this.snapshot, switchWindowMethod: method };
    }
    /** 取当前快照（若过期返回 null） */
    get() {
        if (!this.snapshot)
            return null;
        if (Date.now() - this.snapshot.capturedAt > this.ttlMs) {
            // TTL 失效 —— 清空缓存，调用方需重新探活
            this.snapshot = null;
            return null;
        }
        return this.snapshot;
    }
    /** 便捷查询：switch_window 当前应走哪条路径 */
    switchWindowRoute() {
        const snap = this.get();
        return snap?.switchWindowMethod ?? 'unknown';
    }
    /** 便捷查询：截图传输方式 */
    screenshotTransport() {
        const snap = this.get();
        return snap?.screenshotTransport ?? 'unknown';
    }
    /** 强制失效（调用方怀疑状态过期时主动调用） */
    invalidate() {
        this.snapshot = null;
    }
    /** 是否已建立（启动期探活成功的标志） */
    isInitialized() {
        return this.snapshot !== null;
    }
}
/**
 * 把 HealthInfo 探活结果同步到 CapabilityCache。
 *
 * 便捷封装：调用方只需 ``if (health.ok) syncCapabilityFromHealth(cache, health.value)``。
 */
export function syncCapabilityFromHealth(cache, health) {
    cache.updateFromHealth(health);
}
/**
 * 把 SwitchWindowResult 同步回 CapabilityCache。
 *
 * Reactive 状态同步：当 Python 端 fallback 触发，Node 端立即更新缓存。
 */
export function syncCapabilityFromSwitchWindowResult(cache, result) {
    cache.updateSwitchWindowMethod(result.method);
}
