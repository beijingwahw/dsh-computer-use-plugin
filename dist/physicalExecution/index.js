export { ALL_CAPS } from './contracts.js';
export { PhysicalExecutionAdapterImpl } from './adapter.js';
export { PhysicalActionRouterImpl } from './router.js';
export { readShm, readShmStreaming, evictShmFd, closeAllFds, releaseLocalShm, } from './shmReader.js';
export { ensureKey, mintNonce, mintToken, parseToken, } from './capToken.js';
export { microFetch } from './httpClient.js';
// 世界级创新：RAII 资源管理 + Capability-Driven Routing
export { ScreenshotHandle, ScreenshotBatch } from './screenshotHandle.js';
export { CapabilityCache, syncCapabilityFromHealth, syncCapabilityFromSwitchWindowResult, } from './capabilityCache.js';
// 批次 D：默认实现切换 —— Python 子进程生命周期 + D-7 HostExecutePort 适配
export { PhysicalServiceManager, } from './serviceManager.js';
export { D7PhysicalHostPort, } from './d7HostPort.js';
import { PhysicalExecutionAdapterImpl } from './adapter.js';
/**
 * 适配器工厂 —— D-7 编排器侧的便捷入口。
 *
 * 加载层方法：configure 内部失败 throw —— 拒绝带病上线。
 * 返回的适配器尚未预热，调用方需 ``await adapter.init()`` 加载 HMAC 密钥。
 */
export function createPhysicalExecution(config) {
    const adapter = new PhysicalExecutionAdapterImpl();
    adapter.configure(config);
    return adapter;
}
