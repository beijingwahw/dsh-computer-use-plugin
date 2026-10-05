// src/sandbox/index.ts
// D-5 沙箱执行引擎 —— DSH 插件入口（第五器官降生）。
// ΠΑΝ-39（死接线修复）：装配面已收口至 ./apply.ts 的单一装配函数
// applySandboxStack（engine.configure / sandboxLog 落盘 / 三条事件接线 /
// 四个工具注册 / 可逆清理，含宿主执行器适配层 physicalBackendHostExecutor）。
// 本文件只是 cordis 插件壳：name/inject 导出 + apply 一行挂线 —— 宿主组合根
//（src/index.ts）装载本插件（ctx.plugin）或直接调用 applySandboxStack 均得
// 全套装配（修复前：dsh.plugin.json entry 唯一指向根插件且根插件从不装载
// 本插件 ⇒ 装配层生产不可达，D-6/D-7 复用的 sandboxLog 永不落盘）。
// 物理法则合规：
//   一切皆插件     → 标准 apply(ctx, config)，name/inject 导出
//   依赖驱动加载   → inject 声明 tools（必需）+ dsh.cognition? / dsh.quality-doctor?（可选，
//                    缺席时引擎仍加载，排练/门禁诚实降级 —— 服务就绪后经事件自动咬合）
//   可逆注册与隔离 → 一切监听与内存资源随 ctx.effect 登记清理（Cordis 注册即效果模型）
//   事件总线通信   → 与 D-1/D-4 零直接调用，咬合只走事件（events.ts 单点收口）
//   可观测性对齐   → 沙箱独立 append-only 哈希链账本（log.ts，规范对齐 journal）
// Token 纪律：工具返回只进紧凑数字（尝试/漂移/置信度），全量证据走 reportPath 句柄。
import type { Context } from '@deepseek-ai/cordis';
import { applySandboxStack } from './apply';
import type { SandboxConfig } from './types';

export type { SandboxConfig } from './types';
export { SandboxEngineImpl } from './engine';
export { muscleReliability, resolveConsolidation, hasVerificationLayer } from './types';
// ΝΩ-1：宿主执行器适配层公开（装配产物可独立执法测试 —— dryRun 拒绝/黑名单
// 拦截/存证 marker 均在适配层执法，不依赖 cordis 宿主在场）。ΠΑΝ-39 后实现
// 移驻 apply.ts，此处再导出维持既有公开导入面（测试/消费方零改动）。
export { physicalBackendHostExecutor } from './apply';
export type { HostExecutorVerifyOptions } from './apply';
// ΠΑΝ-39：单一装配函数公开（宿主组合根与测试的挂线面 —— 见 apply.ts）。
export { applySandboxStack } from './apply';
export type { SandboxStackPorts, SandboxStackHandle } from './apply';

export const name = 'sandbox-execution-plugin';

// 可选依赖 '?' 语法：缺席不阻断加载，相关能力诚实降级
export const inject = ['tools', 'dsh.cognition?', 'dsh.quality-doctor?'];

export async function apply(ctx: Context, config: SandboxConfig): Promise<void> {
  // ΠΑΝ-39：一行挂线 —— 全套装配（配置执法/事件接线/工具注册/可逆清理）
  // 收口在 applySandboxStack；返回句柄的 dispose 与 ctx.effect 登记的清理
  // 是同一函数（插件生命周期由 cordis 托管，句柄仅供测试直测卸载语义）。
  applySandboxStack(ctx, config);
}
