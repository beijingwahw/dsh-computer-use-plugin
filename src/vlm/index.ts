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
import { resetGlmClient, getGlmClient, attachFailoverPool, attachCascadeFace } from './glmClient';
import { vlmMeter } from './metering';
import type { VlmCallRecord } from './metering';
import { createProviderPool } from './providers/failover';
import type { ProviderPool } from './providers/failover';
// W3-0（W2-8 C2 接线）：成本级联执行体 —— cascade 全族已经 './providers/index'
// （第 44 行 export * from './cascade'）再分发，本文件只额外按值引入铸造所需的
// 执行体与谓词类型（与 createProviderPool 自 './providers/failover' 直引同律）。
import { VlmCascade } from './providers/cascade';
import type { CascadeValidator } from './providers/cascade';
import type { ProviderTier } from './providers/types';
// 纪元 Β（反驳法院）：第二意见面的装配物料 + 法院本体再分发
import { createEnsembleCourt } from './providers/ensemble';
import { attachRefuteFace, type RefuteBrain } from './refute';
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
export * from './refute';
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
 * 双轨取舍（JSDoc 契约 → P2a-1 升格为「贯通双轨」）：本池与 GlmClient 单例曾
 * 是双轨并存、互不感知 —— 单例（getGlmClient）保 Ω 纪元 glm 路径逐字节不变，
 * 池只服务 vlm_platforms 工具与健康报告等显式消费面，主力路径（ask_screen /
 * grounding / vlmOcr 走的 getGlmClient chat/chatJson）失败后不切备脑 —— 这正是
 * 全库遍历报告点名的缺陷（用户配了 vlmFallbackProviders 以为有容错，实际主力
 * 路径没有）。P2a-1 贯通：configureVlm 铸池时把池注入单例的失败咨询面
 * （attachFailoverPool），单例 chat/chatJson 自身重试全败后按池序取首个健康脑
 * 救回（providerId 标注来源 + note:'failover'）；不配 fallbacks（池 null）⇒
 * 单例行为与 Ω 纪元逐字段一致。池另供 vlm_platforms 工具与健康报告消费
 * （createProviderPool 铸造，熔断跳行见 failover.ts）。
 */
export function getProviderPool(): ProviderPool | null {
  return poolSingleton;
}

// ─── W3-0（W2-8 C2 成本级联路由）：级联铸造与咨询面接线 ───

/** 模块级级联执行体单例 —— tiers 显式标注了 cheap 档且池在场时铸造；null = 未铸 */
let cascadeSingleton: VlmCascade | null = null;

/** 取模块级 VlmCascade（只读快照 —— 可观测性/测试面）；未铸时 null */
export function getVlmCascade(): VlmCascade | null {
  return cascadeSingleton;
}

/**
 * W3-0：CSV tier 标注表解析（"id=tier" 逗号分隔；tier ∈ cheap|primary，键为池内
 * provider id）。脏段（无 = / 空 id / 非法 tier）安静跳过 —— 配置错误不毒化铸池
 *（与 fallbacks CSV 的宽容解析同律，绝不抛）。
 */
function parseProviderTiers(raw: string): Record<string, ProviderTier> {
  const out: Record<string, ProviderTier> = {};
  for (const part of raw.split(',')) {
    const seg = part.trim();
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    const id = seg.slice(0, eq).trim().toLowerCase();
    const tier = seg.slice(eq + 1).trim().toLowerCase();
    if (id === '' || (tier !== 'cheap' && tier !== 'primary')) continue;
    out[id] = tier;
  }
  return out;
}

/**
 * W3-0：便宜臂法定校验谓词（缺省内建）—— 结构性 JSON 判定（解析值为非 null
 * 对象/数组）。glmClient 咨询桥不携带逐调用谓词物料（bbox/OCR 期望等调用点
 * 语境在桥的另一端不可得），故铸池面只内建这一条确定性谓词：它保证「采信的
 * 便宜答案必须是结构完整的 JSON 值」，而逐调用语义校验（withinBbox/
 * ocrText/schema 族）保留给携带得动语境的直接消费面。校验不过 ⇒ 安全升级
 * 主力重做（失败安全方向恒为多花一次主力调用，而非错答上屏）。
 */
const cascadeStructuralValidator: CascadeValidator = {
  name: 'json-structural',
  check(value: unknown): boolean {
    return value !== null && (Array.isArray(value) || typeof value === 'object');
  },
};

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
 *   的备选不进池）；空 ⇒ 池置 null。P2a-1（单例-池贯通）：池的在场性同步注入
 *   单例咨询面 —— 铸池 ⇒ attachFailoverPool(pool)，空 ⇒ attachFailoverPool(null)
 *   （摘除）。
 *
 * 反驳面装配（纪元 Β）：备选链非空（≥2 颗脑）⇒ 另铸一座 EnsembleCourt（主力
 *   + 备选全部入席），庭员名册（listRoster）连同主脑身份注入 vlm/refute 的
 *   attachRefuteFace —— 危险点击派发前 askRefutation 按身份剔除同源庭员后请
 *   首颗异构脑反驳「目标=描述」；空链 ⇒ attachRefuteFace(null)（单脑部署：
 *   法院诚实缺席，零调用零行为）。
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
        | 'vlmProviderTiers' | 'vlmCascadeDangerMax'
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
    // W3-0（W2-8 C2 接线）：tier 标注表（缺省空 = 池内全 primary ⇒ 级联恒弃权）
    const tiers = parseProviderTiers(cfgStr(config?.vlmProviderTiers));

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
        // W3-0（W2-8 C2 接线）：tier 标注入池 —— options.tiers[id] 显式覆盖 >
        // provider 自报 > 'primary'（failover.ts 三级解析）。空表缺席注入 ⇒
        // 铸池路径与既往逐字节一致。
        ...(Object.keys(tiers).length > 0 ? { tiers } : {}),
        meter: vlmMeterTap,
      });
    } else {
      poolSingleton = null;
    }
    // P2a-1（单例-池贯通）：池的在场性同步注入单例失败咨询面 —— 铸池 ⇒ 接线，
    // 空池 ⇒ 摘除。此后 getGlmClient 的 chat/chatJson 自身重试全败后按池序取
    // 首个健康脑救回；不配 fallbacks ⇒ null 注入 ⇒ 单例行为与既往逐字段一致。
    attachFailoverPool(poolSingleton);

    // ── 纪元 Β（反驳法院）：第二意见面装配（照 P2a attachFailoverPool 的注入模式）──
    // 备选链在场（≥2 颗脑配置）才有异构可言：铸一座合议庭（主力 + 备选全部入席，
    // 铸造面零网络 —— 只是适配器落座），把庭员名册连同主脑身份注入反驳面 ——
    // askRefutation 按身份（providerId/baseUrl）剔除与主脑同源的庭员后请首颗
    // 异构脑作证。单脑部署（无 fallbacks）⇒ attachRefuteFace(null) —— 法院
    // 诚实缺席（零调用零行为，绝不静默把主脑自己请上证人席反驳自己）。
    try {
      if (fallbacks !== '') {
        const chain = fallbacks.split(',').map(s => s.trim()).filter(s => s !== '');
        const primary = provider !== '' ? provider : 'glm';
        const url = eraDefaultStr(baseUrl, GLM_ERA_BASE_URL, primary);
        const court = createEnsembleCourt({
          provider: primary,
          ...(apiKey ? { apiKey } : {}),
          ...(url ? { baseUrl: url } : {}),
          extraProviders: chain,
        });
        attachRefuteFace({
          primaryId: primary,
          ...(url ? { primaryBaseUrl: url } : {}),
          // 庭员名册 → 第二意见脑（VisionProvider 天然结构满足 RefuteBrain 契约；
          // baseUrl 适配器不外露 ⇒ 缺席，同源比对退回 providerId 单因子，诚实不虚构）
          brains: court.listRoster().map(p => ({
            id: p.id,
            configured: p.configured === true,
            chatJson: (req: Parameters<RefuteBrain['chatJson']>[0]) => p.chatJson(req),
          })),
        });
      } else {
        attachRefuteFace(null);
      }
    } catch {
      attachRefuteFace(null); // 装配失败 = 法院缺席：零调用零行为（绝不抛）
    }

    // ── W3-0（W2-8 C2 成本级联路由）：级联执行体铸造 + 咨询面接线 ──
    // 激活双钥：① vlmProviderTiers 显式标注了 cheap 档（无 cheap 档 ⇒ 级联律
    // 恒弃权，接线无意义）；② 池在场（fallbacks 非空时铸造）。双钥齐 ⇒ 铸
    // VlmCascade 并 attachCascadeFace —— glmClient.chatJson 的最前置咨询闸自此
    // 有真实消费面；任一缺席 ⇒ attachCascadeFace(null)（摘除，幂等），单例
    // chatJson 行为与未接线逐字节一致（缺省零行为变化律）。
    // 因子源诚实声明：glmClient 桥不携带逐调用分诊因子（置信/风险/场景新旧度
    // 在桥的另一端不可得），铸池面只能供保守静态因子（中危/新场景/中性置信 ⇒
    // danger = 0.4×0.5+0.4×0.5+0.2×1 = 0.6）—— 配缺省阈值 0.35 ⇒ 高危直行
    // 主力（弃权），把「无证据不便宜」的失败安全缺省落在接线层；vlmCascadeDangerMax
    // 配置 ≥0.6 才真正点亮便宜臂（两钥激活，绝不静默便宜）。
    try {
      if (poolSingleton !== null && Object.values(tiers).includes('cheap')) {
        const dm = Number(config?.vlmCascadeDangerMax);
        cascadeSingleton = new VlmCascade(poolSingleton, {
          ...(Number.isFinite(dm) ? { dangerMax: Math.min(1, Math.max(0, dm)) } : {}),
          factors: () => ({ risk: 'medium' as const, sceneFamiliar: false, confidence: 0.5 }),
          validators: [cascadeStructuralValidator],
        });
        attachCascadeFace({
          consultJson: req => {
            const c = cascadeSingleton;
            return c === null ? Promise.resolve(null) : c.runJson(req);
          },
        });
      } else {
        cascadeSingleton = null;
        attachCascadeFace(null);
      }
    } catch {
      cascadeSingleton = null;
      attachCascadeFace(null); // 铸造失败 = 级联缺席：零调用零行为（绝不抛）
    }
  } catch { /* 铸造失败 = 云脑缺席：env/降级路径不变（绝不抛） */ }
}
