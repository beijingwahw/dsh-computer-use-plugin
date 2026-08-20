// src/physicalExecution/capabilityCache.ts
// D-5 Health-Driven Capability Map —— 世界级创新方案「Reactive Memoization + TTL 失效」。
//
// 创新机制：
//   1. **启动期建立 capability map**：调 /v1/health 拿 switch_window_method 等能力声明
//   2. **路由前先查 map**：
//      - native       → 调 /v1/switch_window（让 Python 端处理失败降级）
//      - hotkey_only   → 直接调 pressHotkey，跳过一次网络往返
//      - unavailable   → 直接返回错误，不发请求
//   3. **Reactive 状态同步**：当 /v1/switch_window 响应 method='hotkey_only'
//      （Python 端 fallback 触发），Node 端立即更新 capability map，后续走快速路径
//   4. **TTL 失效**：healthCache 60s 自动过期重探，防止 Python 端重启后能力恢复而 Node 端仍降级
//   5. **零状态依赖**：Node 端不再"每次都试 native"，capability map 是单源真理
//
// 与 Python 端的契约对齐：
//   Python WindowManager.method() 返回 'native' | 'hotkey_only' | 'unavailable'；
//   本缓存镜像此三态 + 加一个 'unknown'（启动期未探活）。
import type { HealthInfo, Result } from './contracts.js';

/** 能力快照 —— 镜像 HealthInfo 关键字段，去掉无关细节 */
export interface CapabilitySnapshot {
  switchWindowMethod: 'native' | 'hotkey_only' | 'unavailable' | 'unknown';
  uiFunnelL1: 'available' | 'unavailable';
  uiFunnelL2: 'available' | 'unavailable';
  uiFunnelL3: string;
  screenshotTransport: 'shm' | 'mmap-file' | 'base64';
  /** 缓存建立时间（unix ms）—— 用于 TTL 失效判断 */
  capturedAt: number;
}

/** 缓存 TTL：超过此时间自动失效（默认 60s） */
const CACHE_TTL_MS = 60_000;

/** Capability Cache 实现 */
export class CapabilityCache {
  private snapshot: CapabilitySnapshot | null = null;
  private ttlMs: number;

  constructor(ttlMs: number = CACHE_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** 从 HealthInfo 更新缓存 —— 用于启动期探活后填充 */
  updateFromHealth(health: HealthInfo): void {
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
  updateSwitchWindowMethod(method: 'native' | 'hotkey_only' | 'unavailable'): void {
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
    if (this.snapshot.switchWindowMethod === method) return;
    // 状态变化 —— 立即更新（不重置 capturedAt，保留原 TTL）
    this.snapshot = { ...this.snapshot, switchWindowMethod: method };
  }

  /** 取当前快照（若过期返回 null） */
  get(): CapabilitySnapshot | null {
    if (!this.snapshot) return null;
    if (Date.now() - this.snapshot.capturedAt > this.ttlMs) {
      // TTL 失效 —— 清空缓存，调用方需重新探活
      this.snapshot = null;
      return null;
    }
    return this.snapshot;
  }

  /** 便捷查询：switch_window 当前应走哪条路径 */
  switchWindowRoute(): 'native' | 'hotkey_only' | 'unavailable' | 'unknown' {
    const snap = this.get();
    return snap?.switchWindowMethod ?? 'unknown';
  }

  /** 便捷查询：截图传输方式 */
  screenshotTransport(): 'shm' | 'mmap-file' | 'base64' | 'unknown' {
    const snap = this.get();
    return snap?.screenshotTransport ?? 'unknown';
  }

  /** 强制失效（调用方怀疑状态过期时主动调用） */
  invalidate(): void {
    this.snapshot = null;
  }

  /** 是否已建立（启动期探活成功的标志） */
  isInitialized(): boolean {
    return this.snapshot !== null;
  }
}

/**
 * 把 HealthInfo 探活结果同步到 CapabilityCache。
 *
 * 便捷封装：调用方只需 ``if (health.ok) syncCapabilityFromHealth(cache, health.value)``。
 */
export function syncCapabilityFromHealth(
  cache: CapabilityCache,
  health: HealthInfo,
): void {
  cache.updateFromHealth(health);
}

/**
 * 把 SwitchWindowResult 同步回 CapabilityCache。
 *
 * Reactive 状态同步：当 Python 端 fallback 触发，Node 端立即更新缓存。
 */
export function syncCapabilityFromSwitchWindowResult(
  cache: CapabilityCache,
  result: { method: 'native' | 'hotkey_only' },
): void {
  cache.updateSwitchWindowMethod(result.method);
}
