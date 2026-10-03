import { resetGlmClient, getGlmClient } from './glmClient.js';
import { vlmMeter } from './metering.js';
import { createProviderPool } from './providers/failover.js';
// 纪元 Λ（开箱即亮）：连接存档 / 本地自动接管 / 向导服务 三模块再分发
export * from './connection.js';
export * from './autoAdopt.js';
export * from './onboarding.js';
export * from './glmClient.js';
export * from './codec.js';
export * from './som.js';
export * from './grounding.js';
export * from './vlmOcr.js';
export * from './verdict.js';
export * from './diffExplainer.js';
export * from './diagnosis.js';
export * from './arbitration.js';
export * from './metering.js';
export * from './providers/index.js';
// 纪元 Λ（开箱即亮）：connection（Λ-1 连接存档）/ autoAdopt（本地自动接管）/
// onboarding（Λ-2 向导服务）—— 三器官公共导出的统一再分发（导出名与既有
// 十器官及 providers 花名册零重叠，export * 无遮蔽）。
export * from './connection.js';
export * from './autoAdopt.js';
export * from './onboarding.js';
// ─── 宿主接线入口 ───
/** 安全读配置字符串：非字符串/空白归 ''（schema 缺省与手写配置双方言防御） */
function cfgStr(v) {
    return typeof v === 'string' ? v.trim() : '';
}
/** Ω 纪元 vlmBaseUrl 的 schema 缺省值（GLM 官方基址） */
const GLM_ERA_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
/** Ω 纪元 vlmModel 的 schema 缺省值 */
const GLM_ERA_MODEL = 'glm-5.3-flash';
/**
 * Ω 纪元 schema 缺省值在平台切换时视为缺席 —— 宿主把 vlmBaseUrl/vlmModel 的
 * schema 缺省（GLM 基址/模型名）填进了 config，若原样透传给非 glm 平台，
 * vlmProvider='openai' 会拿到 GLM 基址而指错脑。仅对显式非 glm 平台生效；
 * glm 平台或缺省平台下该值本就等于预设缺省，透传无害（行为不变）。
 */
function eraDefaultStr(v, eraDefault, provider) {
    return provider !== '' && provider !== 'glm' && v === eraDefault ? '' : v;
}
// ─── 池与单例双轨（纪元 Ψ） ───
/** 模块级备选池单例 —— vlmFallbackProviders 非空时铸造；null = 未铸池 */
let poolSingleton = null;
/**
 * 计量缺省接线（纪元 Δ-6）：configureVlm 铸造时把 vlmMeter 单例挂入 meter ——
 * 云脑的每一次心跳（单例 glm/委托路径 + 备选池全脑）落进模块级台账，
 * summary()/exportJsonl() 观测面自此有生产消费者。字段对齐零适配：
 * GlmMeterRecord 与 metering.VlmCallRecord 逐一同名同型（ts/kind/model/latencyMs/
 * ok/promptTokens/completionTokens/error）；ProviderMeterRecord 仅多 providerId
 * 归因字段，VlmMeter.record 的消毒副本自然剥落。直接构造 GlmClient / 池且显式
 * 给了 meter 的消费面不受影响 —— 用户显式 meter 优先，本缺省只在 configureVlm
 * 铸造路径注入（缺省=GLM 路径的既有 meter kind 'glm.chat' 等行为逐字节保持）。
 */
const vlmMeterTap = (rec) => {
    try {
        vlmMeter.record(rec);
    }
    catch { /* 计量故障静默 —— 主路径无关（VlmMeter.record 自身绝不抛，双保险） */ }
};
/**
 * 取模块级 ProviderPool（只读快照）—— 未铸池时 null。
 *
 * 双轨取舍（JSDoc 契约）：本池与 GlmClient 单例**双轨并存、互不感知** ——
 * 单例（getGlmClient）保 Ω 纪元 glm 路径逐字节不变（兼容层 3 号命门优先），
 * 池不介入其 chat/chatJson；池供 vlm_platforms 工具与健康报告消费，供宿主/
 * 未来消费面按池序故障切换（createProviderPool 铸造，熔断跳行见 failover.ts）。
 */
export function getProviderPool() {
    return poolSingleton;
}
/**
 * 宿主血脉接线：以插件配置铸造云脑单例 + 备选池（config 优先于 env）。
 *
 * 单例铸造法（两路，先到先熔）：
 *   - vlmProvider 非空（纪元 Ψ 显式平台）⇒ resetGlmClient() 后以该平台
 *     getGlmClient({platform, ...}) 铸造 —— apiKey/baseUrl/model 取非空 config
 *     值（Ω 纪元 schema 缺省的 GLM 基址/模型名在非 glm 平台下视为缺席），
 *     缺席物料由委托路径回退平台预设与平台 envKeys；
 *   - 否则 vlmApiKey / vlmBaseUrl / vlmModel 任一非空 ⇒ 原生 glm 路径铸造
 *     （Ω 纪元行为不变：缺席字段由 GlmClient 构造器回退 GLM 环境变量）；
 *   - 都空 ⇒ 不动单例 —— 已有单例保持原样，无单例则走 env 探测路径
 *     （getGlmClient 缺省解析：GLM envs > 他平台 envKeys 自动识别）。
 *
 * 池铸造法：vlmFallbackProviders 非空 ⇒ 按 CSV 铸 ProviderPool（主力 =
 *   vlmProvider 或缺省 'glm'，备选各自 env 解析；解析不出 key 且非本机免钥
 *   的备选不进池）；空 ⇒ 池置 null。
 *
 * 计量接线（纪元 Δ-6）：铸造的单例与池缺省挂 `rec => vlmMeter.record(rec)`
 *（GlmMeterRecord 与 VlmCallRecord 字段同名同型，零适配直落台账）；直接
 *   构造 GlmClient / createProviderPool 且显式给 meter 的消费面不受影响
 *（用户显式 meter 优先）。全空不铸造 ⇒ 无接线可挂（env 路径行为不变）。
 *
 * 幂等性：重复调用以最后一次为准（单例 reset 先行 / 池重铸）；绝不抛异常。
 */
export function configureVlm(config) {
    try {
        const apiKey = cfgStr(config?.vlmApiKey);
        const baseUrl = cfgStr(config?.vlmBaseUrl);
        const model = cfgStr(config?.vlmModel);
        const provider = cfgStr(config?.vlmProvider).toLowerCase();
        const fallbacks = cfgStr(config?.vlmFallbackProviders);
        // 单例：显式平台（纪元 Ψ）⇒ 平台铸造；否则 Ω 纪元 glm 三字段法原样。
        // 两条铸造路都挂 vlmMeter 缺省接线（Δ-6）—— 心跳落进模块级计量台账。
        if (provider !== '') {
            const url = eraDefaultStr(baseUrl, GLM_ERA_BASE_URL, provider);
            const mdl = eraDefaultStr(model, GLM_ERA_MODEL, provider);
            resetGlmClient();
            getGlmClient({
                platform: provider,
                ...(apiKey ? { apiKey } : {}),
                ...(url ? { baseUrl: url } : {}),
                ...(mdl ? { model: mdl } : {}),
                meter: vlmMeterTap,
            });
        }
        else if (apiKey || baseUrl || model) {
            resetGlmClient();
            getGlmClient({
                ...(apiKey ? { apiKey } : {}),
                ...(baseUrl ? { baseUrl } : {}),
                ...(model ? { model } : {}),
                meter: vlmMeterTap,
            });
        } // 全空 ⇒ 不动单例，走 env 路径（不铸造 ⇒ 无接线可挂，env 探测路径行为不变）
        // 池（纪元 Ψ 双轨）：备选链非空 ⇒ 铸池；空 ⇒ 置 null（幂等）。
        // 铸池同样挂 vlmMeter 缺省接线（Δ-6）—— 池内全脑心跳同账本。
        if (fallbacks !== '') {
            const chain = fallbacks.split(',').map(s => s.trim()).filter(s => s !== '');
            const primary = provider !== '' ? provider : 'glm'; // 缺省主力 = GLM（Ω 纪元缺省脑）
            const url = eraDefaultStr(baseUrl, GLM_ERA_BASE_URL, primary);
            const mdl = eraDefaultStr(model, GLM_ERA_MODEL, primary);
            poolSingleton = createProviderPool({
                provider: primary,
                ...(apiKey ? { apiKey } : {}),
                ...(url ? { baseUrl: url } : {}),
                ...(mdl ? { model: mdl } : {}),
                fallbacks: chain,
                meter: vlmMeterTap,
            });
        }
        else {
            poolSingleton = null;
        }
    }
    catch { /* 铸造失败 = 云脑缺席：env/降级路径不变（绝不抛） */ }
}
