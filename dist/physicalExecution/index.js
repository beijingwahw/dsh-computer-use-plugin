export { ALL_CAPS } from './contracts.js';
export { PhysicalExecutionAdapterImpl } from './adapter.js';
export { PhysicalActionRouterImpl } from './router.js';
export { readShm, readShmStreaming, evictShmFd, closeAllFds, } from './shmReader.js';
export { ensureKey, mintNonce, mintToken, parseToken, } from './capToken.js';
export { microFetch } from './httpClient.js';
// W2-0（E 桶导出）：W1-1 执行层世界探针 —— Result 方言 → autonomy 运行时 null
// 降级方言的桥（集成接线：autonomy/index.ts 的 buildAutonomyStack 消费）。
export { createExecWorldProbe, } from './execProbe.js';
// 世界级创新：RAII 资源管理 + Capability-Driven Routing
export { ScreenshotHandle, ScreenshotBatch } from './screenshotHandle.js';
export { CapabilityCache, syncCapabilityFromHealth, syncCapabilityFromSwitchWindowResult, } from './capabilityCache.js';
// 批次 D：默认实现切换 —— Python 子进程生命周期 + D-7 HostExecutePort 适配
export { PhysicalServiceManager, } from './serviceManager.js';
export { D7PhysicalHostPort, sanitizeScreenSize, } from './d7HostPort.js';
// ΠΑΝ-127（D-F5 清偿）：组合工厂 createPhysicalExecution 已下沉卫星
// physicalExecution/compose.ts —— 卫星 d7HostPort.ts 曾回借本桶该工厂构成
// d7↔index value 二环；此处再导出保导入面零破坏（physicalBackend 等消费点
// 零改动）。行为零变化 —— 纯结构搬家。
export { createPhysicalExecution } from './compose.js';
