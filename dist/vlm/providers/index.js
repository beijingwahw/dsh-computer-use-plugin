// src/vlm/providers/index.ts
// 纪元 Ψ（万脑归一）：供应方桶文件 —— 七模块公共导出的统一再分发。
// 器官清单：types（Ψ-1 宪法与共享原语）/ registry（Ψ-2 花名册）/ openai（Ψ-2 兼容
// 家族适配器）/ anthropic（Ψ-3 Messages 方言）/ gemini（Ψ-4 generateContent 方言）/
// probe（Ψ-7 体检与模型发现）/ failover（Ψ-6 多脑故障切换池）。
//
// 命名仲裁（同名不同物的唯一两处，桶层显式改名消歧）：
//   - registry 与 failover 各有一个 ResolvedProviderConfig / getPreset /
//     resolveProviderConfig（前者按「平台发现路」标注 via，后者按「密钥来源」
//     三分且只认显式 provider）—— failover 三件以 Pool* 前缀别名再分发；
//   - registry 与 probe 各有一个 PlatformPreset / PLATFORM_PRESETS（后者是前者
//     的探针展示投影）—— probe 两件以 Probe* 前缀别名再分发。
// 其余导出名全族唯一，star 转发零歧义。
export * from './types.js';
export * from './registry.js';
export * from './openai.js';
export * from './anthropic.js';
export * from './gemini.js';
export { probeProvider, discoverModels, probeAllPlatforms, PLATFORM_PRESETS as PROBE_PLATFORM_PRESETS, } from './probe.js';
export { ProviderPool, createProviderPool, getPreset as getPoolPreset, resolveProviderConfig as resolvePoolProviderConfig, } from './failover.js';
// 纪元 Σ（Σ-1 全军升维）：云脑合议庭 —— ensemble 全族导出名（Ensemble* 前缀）
// 与既有导出零重名，star 转发零歧义。
export * from './ensemble.js';
// W2-8（C2 成本级联路由）：tier cascade —— Cascade*/triage*/CASCADE_* 全族
// 导出名与既有导出零重名，star 转发零歧义。
export * from './cascade.js';
