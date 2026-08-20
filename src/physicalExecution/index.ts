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
} from './contracts.js';
export { ALL_CAPS } from './contracts.js';
export { PhysicalExecutionAdapterImpl } from './adapter.js';
export { PhysicalActionRouterImpl } from './router.js';
export {
  readShm, readShmStreaming, evictShmFd, closeAllFds, releaseLocalShm,
} from './shmReader.js';
export {
  ensureKey, mintNonce, mintToken, parseToken, type CapTokenPayload,
} from './capToken.js';
export { microFetch, type HttpClientConfig } from './httpClient.js';

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
  type D7PhysicalHostPortOpts,
} from './d7HostPort.js';

import type { PhysicalExecutionAdapter, PhysicalExecutionConfig } from './contracts.js';
import { PhysicalExecutionAdapterImpl } from './adapter.js';

/**
 * 适配器工厂 —— D-7 编排器侧的便捷入口。
 *
 * 加载层方法：configure 内部失败 throw —— 拒绝带病上线。
 * 返回的适配器尚未预热，调用方需 ``await adapter.init()`` 加载 HMAC 密钥。
 */
export function createPhysicalExecution(
  config: PhysicalExecutionConfig,
): PhysicalExecutionAdapter {
  const adapter = new PhysicalExecutionAdapterImpl();
  adapter.configure(config);
  return adapter;
}
