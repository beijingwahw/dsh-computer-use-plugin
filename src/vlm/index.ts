// src/vlm/index.ts
// 纪元 Ω（云脑皮层桶文件）：十器官公共导出的统一再分发 + 宿主接线入口。
// 器官清单（各自测试全绿，本文件只做转发与铸造，不新增认知）：
//   glmClient（Ω-1 客户端，Ψ 纪元升格为多协议兼容壳）/ codec（Ω-2 编码）/
//   som（Ω-3 提示词与标注）/ grounding（Ω-4 元素接地）/ vlmOcr（Ω-5 云端 OCR）/
//   verdict（Ω-6 语义判决）/ diffExplainer（Ω-7 差分解释）/ diagnosis（Ω-8 失败会诊）/
//   arbitration（Ω-9 双脑仲裁）/ metering（Ω-10 计量限流）。
// 纪元 Ψ（万脑归一）：providers 七模块（统一契约/花名册/三厂适配器/探针/切换池）
//   经桶文件 ./providers/index 再分发 —— 全平台视觉模型在此挂号。
//
// 依赖方向铁律：config.ts 绝不 import vlm（配置层对认知层零依赖）；
// 本文件对 Config 只做 import type 引用 —— 类型擦除后无运行时回路。
// sharp 纪律：codec 经 _legacyDeps 懒加载 sharp，本桶静态引入不触发原生二进制加载。
import type { Config } from '../config';
import { resetGlmClient, getGlmClient } from './glmClient';
import { vlmMeter } from './metering';
import type { VlmCallRecord } from './metering';
import { createProviderPool } from './providers/failover';
import type { ProviderPool } from './providers/failover';
// 纪元 Λ（开箱即亮）：连接存档 / 本地自动接管 / 向导服务 三模块再分发
export * from './connection';
export * from './autoAdopt';
export * from './onboarding';

export * from './glmClient';
export * from './codec';
export * from './som';
export * from './grounding';
export * from './vlmOcr';
export * from './verdict';
export * from './diffExplainer';
export * from './diagnosis';
export * from './arbitration';
export * from './metering';
export * from './providers/index';

// ─── 宿主接线入口 ───

/** 安全读配置字符串：非字符串/空白归 ''（schema 缺省与手写配置双方言防御） */
function cfgStr(v: unknown): string {
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
function eraDefaultStr(v: string, eraDefault: string, provider: string): string {
  return provider !== '' && provider !== 'glm' && v === eraDefault ? '' : v;
}

// ─── 池与单例双轨（纪元 Ψ） ───

/** 模块级备选池单例 —— vlmFallbackProviders 非空时铸造；null = 未铸池 */
let poolSingleton: ProviderPool | null = null;

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
const vlmMeterTap = (rec: VlmCallRecord): void => {
  try {
    vlmMeter.record(rec);
  } catch { /* 计量故障静默 —— 主路径无关（VlmMeter.record 自身绝不抛，双保险） */ }
};

/**
 * 取模块级 ProviderPool（只读快照）—— 未铸池时 null。
 *
 * 双轨取舍（JSDoc 契约）：本池与 GlmClient 单例**双轨并存、互不感知** ——
 * 单例（getGlmClient）保 Ω 纪元 glm 路径逐字节不变（兼容层 3 号命门优先），
 * 池不介入其 chat/chatJson；池供 vlm_platforms 工具与健康报告消费，供宿主/
 * 未来消费面按池序故障切换（createProviderPool 铸造，熔断跳行见 failover.ts）。
 */
export function getProviderPool(): ProviderPool | null {
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
export function configureVlm(
  config:
    | Partial<Pick<
        Config,
        | 'vlmApiKey' | 'vlmBaseUrl' | 'vlmModel'
        | 'vlmProvider' | 'vlmFallbackProviders'
      >>
    | null
    | undefined,
): void {
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
    } else if (apiKey || baseUrl || model) {
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
    } else {
      poolSingleton = null;
    }
  } catch { /* 铸造失败 = 云脑缺席：env/降级路径不变（绝不抛） */ }
}
