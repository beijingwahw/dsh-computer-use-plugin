import { applySandboxStack } from './apply.js';
export { SandboxEngineImpl } from './engine.js';
export { muscleReliability, resolveConsolidation, hasVerificationLayer } from './types.js';
// ΝΩ-1：宿主执行器适配层公开（装配产物可独立执法测试 —— dryRun 拒绝/黑名单
// 拦截/存证 marker 均在适配层执法，不依赖 cordis 宿主在场）。ΠΑΝ-39 后实现
// 移驻 apply.ts，此处再导出维持既有公开导入面（测试/消费方零改动）。
export { physicalBackendHostExecutor } from './apply.js';
// ΠΑΝ-39：单一装配函数公开（宿主组合根与测试的挂线面 —— 见 apply.ts）。
export { applySandboxStack } from './apply.js';
export const name = 'sandbox-execution-plugin';
// 可选依赖 '?' 语法：缺席不阻断加载，相关能力诚实降级
export const inject = ['tools', 'dsh.cognition?', 'dsh.quality-doctor?'];
export async function apply(ctx, config) {
    // ΠΑΝ-39：一行挂线 —— 全套装配（配置执法/事件接线/工具注册/可逆清理）
    // 收口在 applySandboxStack；返回句柄的 dispose 与 ctx.effect 登记的清理
    // 是同一函数（插件生命周期由 cordis 托管，句柄仅供测试直测卸载语义）。
    applySandboxStack(ctx, config);
}
