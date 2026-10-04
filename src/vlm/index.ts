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
import { resetGlmClient, getGlmClient, attachFailoverPool, attachCascadeFace, attachVlmRateLimiter } from './glmClient';
import { vlmMeter, VlmRateLimiter } from './metering';
import type { VlmCallRecord } from './metering';
import { kernelRegistry } from '../kernel/registry';
import { createProviderPool } from './providers/failover';
import type { ProviderPool } from './providers/failover';
// W3-0（W2-8 C2 接线）：成本级联执行体 —— cascade 全族已经 './providers/index'
// （第 44 行 export * from './cascade'）再分发，本文件只额外按值引入铸造所需的
// 执行体与谓词类型（与 createProviderPool 自 './providers/failover' 直引同律）。
import { VlmCascade } from './providers/cascade';
import type { CascadeValidator } from './providers/cascade';
// ΑΩ-R2（级联因子源点亮）：请求级三因子分诊的类型面 + 词法风险分级的单一来源。
// riskGate 是纯词法叶子模块（唯一依赖 confusables 生成数据，零反向依赖 vlm），
// 接线层直引不构成环 —— 与下方 Config 的 import type 铁律不冲突（那是 config
// 专属的配置层禁令；riskGate 无任何到本桶的路径）。
import type { CascadeRiskTier, CascadeTriageFactors } from './providers/cascade';
import { matchesDangerPatterns, matchesRiskPatterns } from '../riskGate';
import type { ProviderTier } from './providers/types';
// 纪元 Β（反驳法院）：第二意见面的装配物料 + 法院本体再分发
import { createEnsembleCourt, EnsembleCourt } from './providers/ensemble';
import { attachRefuteFace, isSameRefuteSource, type RefuteBrain, type RefuteQuorumFace } from './refute';
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

// ─── ΝΩ-18（桥面语义谓词）：按请求类型注册的便宜臂法定校验 ───
//
// 病灶：级联桥原只内建「非空对象/数组」一条结构性谓词 —— grounding 空 elements
// 数组、verdict 缺字段（或枚举外值）、OCR 缺 words 的便宜答案都过检直采，语义
// 空转白省钱且错答上屏风险全靠下游兜底。修法：咨询桥按请求类型（prompt/system
// 的稳定标记词，与 som.ts 三提示词构造器同源）追加语义谓词 —— 谓词不过 ⇒ 走
// cascade 既有升级路径（便宜答案作废、主力档重做）；未命中任何类型的泛化请求
//（ask_screen 等）保持纯结构校验（零行为变化律）。

/** verdict 合法枚举（verdict.ts VlmVerdictLevel 同集 —— 本地声明避免器官耦合） */
const CASCADE_VERDICT_ENUM: ReadonlySet<string> = new Set(['confirmed', 'refuted', 'uncertain']);

/** bbox 双形态判定（grounding.parseBbox 同律）：[x0,y0,x1,y1] ≥4 有限数 或
 *  {x0,y0,x1,y1} 四有限数 —— 其余形态（缺字段/非有限）不可验证 */
function hasParseableBbox(raw: unknown): boolean {
  let ns: unknown[];
  if (Array.isArray(raw)) {
    if (raw.length < 4) return false;
    ns = [raw[0], raw[1], raw[2], raw[3]];
  } else if (raw !== null && typeof raw === 'object') {
    const o = raw as { x0?: unknown; y0?: unknown; x1?: unknown; y1?: unknown };
    ns = [o.x0, o.y0, o.x1, o.y1];
  } else {
    return false;
  }
  return ns.every(n => typeof n === 'number' && Number.isFinite(n));
}

/**
 * ΝΩ-18：请求类型分类（纯读，绝不抛）—— 按三器官提示词的稳定标记词判型：
 * grounding（system「屏幕元素定位器」/ prompt「列出图中所有可交互元素」）>
 * verdict（「对比前图与后图」）> OCR（「识别图中所有可见文字」）；未命中 ⇒
 * 'generic'。导出面：测试/可观测消费。
 */
export type CascadeRequestKind = 'grounding' | 'verdict' | 'ocr' | 'generic';

export function classifyCascadeRequest(req: { prompt?: unknown; system?: unknown } | null | undefined): CascadeRequestKind {
  try {
    const sys = typeof req?.system === 'string' ? req.system : '';
    const p = typeof req?.prompt === 'string' ? req.prompt : '';
    if (sys.includes('屏幕元素定位器') || p.includes('列出图中所有可交互元素')) return 'grounding';
    if (p.includes('对比前图与后图')) return 'verdict';
    if (p.includes('识别图中所有可见文字')) return 'ocr';
    return 'generic';
  } catch {
    return 'generic';
  }
}

/**
 * ΝΩ-18：按请求类型注册的语义谓词集（级联桥的 perCall 追加面）：
 *  - grounding ⇒ elements 数组非空且首条有 bbox（双方言：裸数组 / {elements}，
 *    与 grounding.ts 的双形态收窄同律）—— 空 elements = 便宜脑没看见东西，
 *    主力档值得再试一次；
 *  - verdict ⇒ verdict ∈ {confirmed, refuted, uncertain} 枚举（verdict.ts 同集）；
 *  - OCR ⇒ words 在场（{words:[...]} 或裸数组方言，与 vlmOcr.ts 同律 ——
 *    空数组是合法 OCR 结果「屏上无字」，只要求字段在场）。
 * 谓词不过 ⇒ cascade 现有升级路径（validation-failed:<name> 点名）。
 * 导出面：测试/可观测消费。
 */
export function cascadeSemanticValidators(req: { prompt?: unknown; system?: unknown } | null | undefined): CascadeValidator[] {
  const kind = classifyCascadeRequest(req);
  if (kind === 'grounding') {
    return [{
      name: 'semantic-grounding',
      check(value: unknown): boolean {
        try {
          const els = Array.isArray(value)
            ? value
            : value !== null && typeof value === 'object' && Array.isArray((value as { elements?: unknown }).elements)
              ? (value as { elements: unknown[] }).elements
              : null;
          if (!Array.isArray(els) || els.length === 0) return false;
          const first = els[0];
          return first !== null && typeof first === 'object'
            && hasParseableBbox((first as { bbox?: unknown }).bbox);
        } catch {
          return false;
        }
      },
    }];
  }
  if (kind === 'verdict') {
    return [{
      name: 'semantic-verdict',
      check(value: unknown): boolean {
        try {
          if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
          const v = (value as { verdict?: unknown }).verdict;
          return typeof v === 'string' && CASCADE_VERDICT_ENUM.has(v);
        } catch {
          return false;
        }
      },
    }];
  }
  if (kind === 'ocr') {
    return [{
      name: 'semantic-ocr',
      check(value: unknown): boolean {
        try {
          if (Array.isArray(value)) return true; // 裸数组方言 = words 本体
          return value !== null && typeof value === 'object'
            && Array.isArray((value as { words?: unknown }).words);
        } catch {
          return false;
        }
      },
    }];
  }
  return [];
}

/**
 * ΝΩ-18：级联咨询桥的装配体（从 configureVlm 提取为具名函数 —— 同一表达式
 * 供生产接线与测试直用）：perCall 供请求级动态因子（ΑΩ-R2）+ 按请求类型的
 * 语义谓词（追加在实例结构谓词之后 —— cascade 的 [...base, ...extra] 合并律）。
 * 绝不抛。
 */
export function wireCascadeConsultFace(cascade: VlmCascade): void {
  attachCascadeFace({
    consultJson: req => {
      const semantic = cascadeSemanticValidators(req);
      return cascade.runJson(req, {
        factors: cascadeRequestFactors(req),
        ...(semantic.length > 0 ? { validators: semantic } : {}),
      });
    },
  });
}

// ─── ΑΩ-R2（级联因子源点亮）：请求级三因子分诊（接线层注入）───
//
// 病灶（暗功能）：W3-0 原接线把 factors 供成静态保守值（中危/新场景/中性置信 ⇒
// danger 恒 0.6 > 缺省阈值 0.35）—— 便宜臂在缺省配置下永不触发，配了便宜档的
// 部署买不到一次省钱。修法：咨询桥携带的请求文本（prompt/system）在此变现为
// 真实动态因子，经 perCall.factors 压过实例保守源（W2-8g 优先级律）：
//   · risk —— riskGate 词法风险分级（混淆归一同律）：危险词/凭据词 ⇒ high
//     （danger ≥ 0.4 恒主力）；只读观察语义且无危险词 ⇒ low；不可分类 ⇒
//     medium（保守回落，诚实原则：无证据不便宜）；
//   · sceneFamiliar —— 便宜信号：近期同 prompt 记忆命中（LRU 上限 32）。dhash
//     指纹在咨询桥上不可得（解码截图是重操作），同 prompt 复现是场景熟悉度的
//     廉价代理；首见记新场景（false 保守）；
//   · confidence —— 调用方上下文在 GlmVisionRequest 上不可得（无置信字段），
//     诚实保持中性 0.5。
// 校准一致性（缺省权重 0.4/0.4/0.2 与缺省阈值 0.35 均被 w2cascade/w3wire 既有
// 断言钉死，本接线只校准因子不动数学）：低危 + 同 prompt 复现 ⇒ danger =
// 0.4×(1−0.5) = 0.2 < 0.35 ⇒ 便宜臂真正点亮；危险词 ⇒ risk=high ⇒ danger ≥
// 0.4×1 = 0.4 > 0.35 ⇒ 恒主力（场景再熟、置信再高也压不进便宜臂）。

/** 只读观察语义标记（中文动词族 —— 观察语义；不含动作词，命中且无危险词 ⇒ low） */
const CASCADE_READONLY_MARKERS_ZH: readonly string[] = [
  '列出', '识别', '读取', '读出', '描述', '对比', '比较', '判断', '找出', '检查', '观察', '转写',
];

/** 只读观察语义标记（英文 —— 词边界匹配，防 'already' ⊃ 'read' 类子串误判） */
const CASCADE_READONLY_MARKERS_EN =
  /\b(describe|list|read|detect|recogni[sz]e|compare|locate|identify|observe|transcribe|ocr)\b/i;

/** 近期同 prompt 记忆上限（无界记忆 = 无界账 —— 满后逐出最旧，Map 保序即 LRU） */
const CASCADE_FAMILIAR_PROMPT_LIMIT = 32;

/** 模块级同 prompt 记忆 —— 键 = prompt 原文，值恒 true（在场性即全部信息） */
const cascadeFamiliarPrompts = new Map<string, true>();

/**
 * 场景熟悉度代理（记账式读取，绝不抛）：近期同 prompt 命中 ⇒ true 并刷新新近度
 * （LRU 触碰 = 删后重插）；首见 ⇒ 记账后返回 false（新场景保守）。空 prompt
 * 不可熟悉也不记账（无文本无身份）。
 */
function cascadeSceneFamiliar(prompt: string): boolean {
  if (prompt === '') return false;
  if (cascadeFamiliarPrompts.has(prompt)) {
    cascadeFamiliarPrompts.delete(prompt);
    cascadeFamiliarPrompts.set(prompt, true);
    return true;
  }
  if (cascadeFamiliarPrompts.size >= CASCADE_FAMILIAR_PROMPT_LIMIT) {
    const oldest = cascadeFamiliarPrompts.keys().next().value;
    if (oldest !== undefined) cascadeFamiliarPrompts.delete(oldest);
  }
  cascadeFamiliarPrompts.set(prompt, true);
  return false;
}

/**
 * ΑΩ-R2：请求文本的词法风险分级（纯读，绝不抛）。
 * 危险词（matchesDangerPatterns）/ 凭据词（matchesRiskPatterns）任一命中 ⇒
 * 'high' —— riskGate 归一化同律（leet/同形/全角混淆还原后包含匹配，宁高不低）；
 * 只读观察标记命中 ⇒ 'low'；其余不可分类 ⇒ 'medium'（与旧静态保守源同档）。
 * 导出面：测试/可观测消费。
 */
export function classifyCascadeRiskText(text: string): CascadeRiskTier {
  try {
    if (typeof text !== 'string' || text === '') return 'medium';
    if (matchesDangerPatterns(text, '') || matchesRiskPatterns(text, '')) return 'high';
    if (CASCADE_READONLY_MARKERS_EN.test(text)) return 'low';
    for (const m of CASCADE_READONLY_MARKERS_ZH) {
      if (text.includes(m)) return 'low';
    }
    return 'medium';
  } catch {
    return 'medium'; // 信号不可用 ⇒ 保守回落（诚实原则）
  }
}

/**
 * ΑΩ-R2：请求级三因子 —— 咨询桥的 perCall 因子源（真实动态信号）。
 * 信号不可用（无 prompt 文本/分类失败）时各项回落保守值 medium/false/0.5 ——
 * 与 W3-0 静态保守源逐字节同值（旧行为的诚实降级面）。导出面：测试/可观测消费。
 */
export function cascadeRequestFactors(req: {
  prompt?: unknown;
  system?: unknown;
} | null | undefined): CascadeTriageFactors {
  const prompt = typeof req?.prompt === 'string' ? req.prompt : '';
  const system = typeof req?.system === 'string' ? req.system : '';
  return {
    risk: classifyCascadeRiskText(prompt === '' && system === '' ? '' : `${prompt}\n${system}`),
    sceneFamiliar: cascadeSceneFamiliar(prompt),
    confidence: 0.5, // 调用方上下文不可得 ⇒ 中性（不褒不贬，诚实）
  };
}

/** ΑΩ-R2：同 prompt 记忆归零（测试隔离缝；configureVlm 重铸新纪元时清账） */
export function resetCascadeTriageFamiliarity(): void {
  cascadeFamiliarPrompts.clear();
}

// ─── ΝΩ-47（合议庭点亮）：反驳法院的多脑裁决面装配 ───

/**
 * ΝΩ-47：把合议庭的**异构子庭**（同源剔除后的庭员）铸为反驳法院的多脑裁决面。
 *
 * 铸造律：整庭名册经 isSameRefuteSource 剔除与主脑同源（providerId/baseUrl
 * 双因子）的庭员 —— 主脑不得入陪审席反驳自己（确认偏误马戏律）；剔除后
 * ≥2 颗才铸（多数票最少需要两票 —— 1 颗异构脑成不了合议，退回单脑通道
 * 诚实降级，不静默凑数）；子庭复用整庭已铸的适配器实例（零重解析零网络）。
 * 返回的 face 结构满足 RefuteQuorumFace（EnsembleCourt.askVerdict 天然契合，
 * census 即 members 普查）。绝不抛：任何读取故障 ⇒ null（多脑缺席 = 单脑
 * 旧行为）。导出面：测试/可观测消费（wireCascadeConsultFace 同律）。
 */
export function buildRefuteQuorumFace(
  court: EnsembleCourt,
  primary: { id: string; baseUrl?: string },
): RefuteQuorumFace | null {
  try {
    const jury = court.listRoster().filter(
      p => !isSameRefuteSource({ id: primary.id, baseUrl: primary.baseUrl }, p),
    );
    if (jury.length < 2) return null; // 异构庭员 <2 ⇒ 多数票无从谈起 —— 单脑路径保底
    const bench = new EnsembleCourt(jury);
    return {
      askVerdict: req => bench.askVerdict(req),
    };
  } catch {
    return null; // 装配故障 = 多脑缺席：单脑路径行为不变（绝不抛）
  }
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
 *   的备选不进池）；空 ⇒ 池置 null。P2a-1（单例-池贯通）：池的在场性同步注入
 *   单例咨询面 —— 铸池 ⇒ attachFailoverPool(pool)，空 ⇒ attachFailoverPool(null)
 *   （摘除）。
 *
 * 反驳面装配（纪元 Β）：备选链非空（≥2 颗脑）⇒ 另铸一座 EnsembleCourt（主力
 *   + 备选全部入席），庭员名册（listRoster）连同主脑身份注入 vlm/refute 的
 *   attachRefuteFace —— 危险点击派发前 askRefutation 按身份剔除同源庭员后请
 *   首颗异构脑反驳「目标=描述」；空链 ⇒ attachRefuteFace(null)（单脑部署：
 *   法院诚实缺席，零调用零行为）。ΝΩ-47（opt-in）：内核参 vlm.refuteQuorum > 0
 *   且异构子庭 ≥2 ⇒ 另挂多脑裁决面（quorum）—— 反驳通道升级 askVerdict
 *   多数票，census 透传；缺省未供参 ⇒ 单脑路径逐字节不变。
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

    // ── ΝΩ-18（限流器接线）：VlmRateLimiter 的 configureVlm 注入面 ──
    // 内核注册表供参（与 metering.VlmApiBreaker 的 Ξ-D 读法同律，不动 config
    // schema）：vlm.maxPerMinute > 0 ⇒ 铸双桶限流闸挂入单例 chat/chatJson 前置
    //（vlm.maxPerHour 可选，缺省 = 分钟 × 60）；未注册/ ≤0 ⇒ 摘除（缺省零行为
    // 变化律 —— 限流器全库原本零消费，未显式供参的部署行为逐字节不变）。
    try {
      const mpm = Math.floor(kernelRegistry.getOrDefault('vlm.maxPerMinute', 0));
      if (Number.isFinite(mpm) && mpm > 0) {
        const mph = Math.floor(kernelRegistry.getOrDefault('vlm.maxPerHour', mpm * 60));
        attachVlmRateLimiter(new VlmRateLimiter({
          maxPerMinute: mpm,
          maxPerHour: Number.isFinite(mph) && mph > 0 ? mph : mpm * 60,
        }));
      } else {
        attachVlmRateLimiter(null);
      }
    } catch {
      attachVlmRateLimiter(null); // 供参面故障 ⇒ 摘除（绝不抛）
    }

    // ── 纪元 Β（反驳法院）：第二意见面装配（照 P2a attachFailoverPool 的注入模式）──
    // 备选链在场（≥2 颗脑配置）才有异构可言：铸一座合议庭（主力 + 备选全部入席，
    // 铸造面零网络 —— 只是适配器落座），把庭员名册连同主脑身份注入反驳面 ——
    // askRefutation 按身份（providerId/baseUrl）剔除与主脑同源的庭员后请首颗
    // 异构脑作证。单脑部署（无 fallbacks）⇒ attachRefuteFace(null) —— 法院
    // 诚实缺席（零调用零行为，绝不静默把主脑自己请上证人席反驳自己）。
    // ΝΩ-47（合议庭点亮，opt-in）：内核参 vlm.refuteQuorum > 0 时另铸多脑
    // 裁决面 —— 同源剔除后的异构子庭 ≥2 颗 ⇒ askRefutation 的反驳通道整体
    // 升级为 askVerdict 多数票（不可逆动作核验从单脑单票变多脑多数票，
    // census 透传）；未供参 / 子庭不足 ⇒ quorum 缺席 = 单脑路径逐字节保持
    //（缺省零行为变化律）。
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
        // ΝΩ-47：多脑裁决面（opt-in —— 内核参未注册时 getOrDefault 回声 0 ⇒ 恒缺席）
        let quorumFace: RefuteQuorumFace | null = null;
        try {
          if (kernelRegistry.getOrDefault('vlm.refuteQuorum', 0) > 0) {
            quorumFace = buildRefuteQuorumFace(court, { id: primary, ...(url ? { baseUrl: url } : {}) });
          }
        } catch {
          quorumFace = null; // 供参面故障 ⇒ 多脑缺席（绝不抛）
        }
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
          ...(quorumFace !== null ? { quorum: quorumFace } : {}),
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
    // ΑΩ-R2（级联因子源点亮）：咨询桥以请求文本供真实动态因子（词法风险分级 +
    // 同 prompt 熟悉度，见 cascadeRequestFactors）—— 只读低危 + 同 prompt 复现
    // ⇒ danger 0.2 < 缺省阈值 0.35，配置了便宜档的部署真正能路由到便宜臂；
    // 危险词 ⇒ 恒 high 恒主力。信号不可用 ⇒ 各项回落保守值（与旧静态源同值 ⇒
    // 弃权，无证据不便宜）。vlmCascadeDangerMax 仍可配置覆盖阈值（收紧/放宽皆可）。
    try {
      if (poolSingleton !== null && Object.values(tiers).includes('cheap')) {
        const dm = Number(config?.vlmCascadeDangerMax);
        resetCascadeTriageFamiliarity(); // 重铸新纪元 —— 旧纪元的同 prompt 记忆不作数
        cascadeSingleton = new VlmCascade(poolSingleton, {
          ...(Number.isFinite(dm) ? { dangerMax: Math.min(1, Math.max(0, dm)) } : {}),
          // 实例级因子源保持 W3-0 静态保守值：直接 runJson（无 perCall）的调用面
          // 旧行为逐字节保持（danger 0.6 ⇒ 弃权）；咨询桥恒供 perCall 动态因子
          // （W2-8g 优先级律压过本源），本源退居「无请求语境」的诚实缺省。
          factors: () => ({ risk: 'medium' as const, sceneFamiliar: false, confidence: 0.5 }),
          validators: [cascadeStructuralValidator],
        });
        // ΝΩ-18：咨询桥经 wireCascadeConsultFace 装配（请求级动态因子 + 按
        // 请求类型的语义谓词 —— grounding/verdict/OCR 三型，见上方谓词面）。
        wireCascadeConsultFace(cascadeSingleton);
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
