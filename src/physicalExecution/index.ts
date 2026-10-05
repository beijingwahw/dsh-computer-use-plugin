// src/physicalExecution/index.ts
// D-5 物理执行适配器 —— 模块出口（唯一对外表面）。
//
// 产权铁律：本模块的所有类型与实现经此文件统一导出 ——
//   跨器官消费方只 import 此文件，绝不直接 import 内部模块（如 adapter.ts / capToken.ts）。
//   这与 D-5 sandbox/index.ts、D-6 orchestration/index.ts 同构。
//
// 使用范式（D-7 编排器侧）：
//   import { createPhysicalExecution, PhysicalActionRouterImpl } from '../physicalExecution';
//
//   const adapter = createPhysicalExecution({
//     baseUrl: 'http+unix:///var/run/dsh-physical.sock/v1',
//     timeoutMs: pipelineConfig.attemptTimeoutMs,
//     keyPath: path.join(os.homedir(), '.dsh/physical.key'),
//   });
//   await adapter.init();
//   const health = await adapter.health();
//   if (!health.ok) throw new Error('physical service unavailable');
//   const router = new PhysicalActionRouterImpl(adapter);
//
//   // D-7 ExecutionStation.execute 内部：
//   const result = await router.dispatch(order.action, order.seq);
export type {
  Capability, ClickResult, DragResult, HealthInfo, HotkeyResult,
  MicroFailure, MicroResponse, MicroSuccess, PhysicalActionRouter,
  PhysicalError, PhysicalErrorKind, PhysicalExecutionAdapter,
  PhysicalExecutionConfig, Result, ScreenshotHandleLike, ScreenshotResult,
  ScrollResult, SwitchWindowResult, TypeResult, UIElement, UiTreeResult,
  ActiveWindowResult,
} from './contracts.js';
export { ALL_CAPS } from './contracts.js';
export { PhysicalExecutionAdapterImpl } from './adapter.js';
export { PhysicalActionRouterImpl } from './router.js';
export {
  readShm, readShmStreaming, evictShmFd, closeAllFds,
} from './shmReader.js';
export {
  ensureKey, mintNonce, mintToken, parseToken, type CapTokenPayload,
} from './capToken.js';
export { microFetch, type HttpClientConfig } from './httpClient.js';
// W2-0（E 桶导出）：W1-1 执行层世界探针 —— Result 方言 → autonomy 运行时 null
// 降级方言的桥（集成接线：autonomy/index.ts 的 buildAutonomyStack 消费）。
export {
  createExecWorldProbe,
  type ExecWorldProbe,
  type FrameSample,
  type HitTestProbeOutcome,
} from './execProbe.js';

// 世界级创新：RAII 资源管理 + Capability-Driven Routing
export { ScreenshotHandle, ScreenshotBatch } from './screenshotHandle.js';
export {
  CapabilityCache, syncCapabilityFromHealth, syncCapabilityFromSwitchWindowResult,
  type CapabilitySnapshot,
} from './capabilityCache.js';

// 批次 D：默认实现切换 —— Python 子进程生命周期 + D-7 HostExecutePort 适配
export {
  PhysicalServiceManager,
  type ServiceManagerOpts,
  type ServiceStartResult,
} from './serviceManager.js';
export {
  D7PhysicalHostPort,
  sanitizeScreenSize,
  type D7PhysicalHostPortOpts,
} from './d7HostPort.js';

// ΠΑΝ-127（D-F5 清偿）：组合工厂 createPhysicalExecution 已下沉卫星
// physicalExecution/compose.ts —— 卫星 d7HostPort.ts 曾回借本桶该工厂构成
// d7↔index value 二环；此处再导出保导入面零破坏（physicalBackend 等消费点
// 零改动）。行为零变化 —— 纯结构搬家。
export { createPhysicalExecution } from './compose.js';
