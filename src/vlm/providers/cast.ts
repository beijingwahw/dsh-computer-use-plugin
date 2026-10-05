// src/vlm/providers/cast.ts
// 三兄弟适配器的统一铸造分派点（修复潮 F3-7 / BC-5 收编）。
//
// 为什么存在：ensemble.ts（合议庭铸造厂）与 failover.ts（故障切换池铸造厂）
// 各自落了一份逐字相同的 castProvider（bug_class_lint --strict 检出 BC-5
// 函数体克隆 ×2）。「按预设 protocol 分派 openai/anthropic/gemini 适配器 +
// config 形状（id/apiKey/baseUrl/model + 条件挂 fetchImpl/meter）」是同一道
// 铸造律，两处克隆漂移（如某天加第四家适配器只改一处）正是 BC-5 要防的虫型
// —— 故上提为共享件，两铸造厂改为引用（行为逐字不变，ensemble.elements.ts
// 同款 provider 家族卫星件方言）。
import { createAnthropicProvider } from './anthropic';
import { createGeminiProvider } from './gemini';
import { createOpenAiProvider } from './openai';
import { tokenCapForModel } from './types';
import type { VisionProvider } from './types';
import type { PlatformPreset } from './registry';
import type { ProviderMeterRecord } from './types';

// ─── R3-2（max_tokens 钳制泛化）：铸造点的模型硬顶包装 ───

/**
 * R3-2: 请求物料的 max_tokens 前置钳制 —— 模型无已知硬顶 ⇒ 原请求对象直传
 *（恒等引用，零行为变化）；有硬顶（glm-4v-flash 家族 1024）⇒ 缺省 2048 与
 * 一切超顶值拉进界内（界内值原样保留）。绝不抛。
 */
function r32ClampReq<T extends { maxTokens?: number }>(req: T, model: string): T {
  const cap = tokenCapForModel(model);
  if (cap === null) return req;
  const want = typeof req.maxTokens === 'number' && Number.isFinite(req.maxTokens)
    ? req.maxTokens
    : 2048; // R3-2: 三适配器缺省同律（openai/anthropic/gemini 均 2048）
  if (want <= cap) return req;
  return { ...req, maxTokens: cap };
}

/**
 * R3-2: 模型硬顶包装 —— chat/chatJson 双面前置钳制（依据适配器自报的已解析
 * model，非铸造参数 —— env 回退解析后的真名才作数）。展开律与 glmClient 的
 * wrapQwenCoordDomain 同法（{...inner} 保全 id/protocol/model/baseUrl/tier/
 * configured 等一切自报面）。绝不抛；包装面自身故障由内层适配器兜底。
 */
export function wrapModelTokenCap(inner: VisionProvider): VisionProvider {
  const model = inner.model;
  if (tokenCapForModel(model) === null) return inner; // 零硬顶 ⇒ 零包装（零行为变化律）
  return {
    ...inner,
    async chat(req: Parameters<VisionProvider['chat']>[0]) {
      return inner.chat(r32ClampReq(req, model));
    },
    async chatJson<T>(req: Parameters<VisionProvider['chatJson']>[0]) {
      return inner.chatJson<T>(r32ClampReq(req, model));
    },
  };
}

/**
 * 按预设协议选厂铸造 —— openai/anthropic/gemini 三兄弟适配器的分派点。
 * ΠΑΝ-23：meter 透传（缺省 undefined = 不挂，既往行为不变）—— 庭/池内每一次
 * 拨号经适配器恰好一条 ProviderMeterRecord 落台账（适配器级 meter 是单一
 * 定义点，聚合侧不另记 —— 防双计）。
 * R3-2：铸出的适配器按其自报模型过 model 硬顶包装（glm-4v-flash ≤1024）——
 * failover 池与合议庭的备脑自此不再被免费档 400 拒单（单一铸造点单一执法）。
 */
export function castProvider(
  preset: PlatformPreset,
  apiKey: string,
  baseUrl: string,
  model: string,
  fetchImpl: typeof fetch | undefined,
  meter?: (rec: ProviderMeterRecord) => void,
): VisionProvider {
  const config = {
    id: preset.id,
    apiKey,
    baseUrl,
    model,
    ...(fetchImpl ? { fetchImpl } : {}),
    // ΠΑΝ-23：适配器级 meter 是单一定义点（聚合侧不另记 —— 防双计）
    ...(meter ? { meter } : {}),
  };
  let provider: VisionProvider;
  switch (preset.protocol) {
    case 'anthropic':
      provider = createAnthropicProvider(config);
      break;
    case 'gemini':
      provider = createGeminiProvider(config);
      break;
    case 'openai':
    default:
      provider = createOpenAiProvider(config);
      break;
  }
  return wrapModelTokenCap(provider);
}
