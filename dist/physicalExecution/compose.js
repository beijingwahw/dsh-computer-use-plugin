// src/physicalExecution/compose.ts
// ΠΑΝ-127（D-F5 清偿）：物理执行组合工厂下沉卫星 —— createPhysicalExecution
// 曾定义在桶 physicalExecution/index.ts，卫星 d7HostPort.ts 回借桶（连同
// router/capabilityCache 符号）构成 d7↔index value 二环（桶-卫星互指同病）。
// 按项目方言拆环：组合工厂入住本件（依赖面 = adapter/contracts，单向无环）；
// 桶面经再导出保导入面零破坏（physicalBackend 等消费点零改动）；d7 改 import
// 本件与各符号源件（不再回借桶）。行为零变化 —— 纯结构搬家。
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
