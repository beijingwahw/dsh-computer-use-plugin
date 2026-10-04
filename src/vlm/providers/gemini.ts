// src/vlm/providers/gemini.ts
// 纪元 Ψ（Ψ-4 万脑归一）：Google Gemini 协议适配器。
// 把 Generative Language API（v1beta generateContent）适配为统一 VisionProvider，
// 与兄弟适配器共享 src/vlm/providers/types.ts 的契约与原语（fetchWithRetry /
// sanitizeError / extractProviderJson）。
//
// 协议要点：
//   POST {baseUrl}/models/{urlEncode(model)}:generateContent
//   鉴权走 header `x-goog-api-key: ${apiKey}` —— 不走 URL query：
//   URL 会进访问日志 / 错误信息 / 探针回显，query 携密钥等于日志裸奔。
//   多模态 = contents[0].parts = [inline_data 图片..., text 指令]
//   system 提示词走 systemInstruction.parts[0].text
//   结构化输出走 generationConfig.responseMimeType = 'application/json'
//   错误体形如 { error: { code, message, status } } —— 归因优先取 error.message
//
// 设计铁律（与全仓一致）：
//   1. 永不抛异常 —— 一切失败以返回值 ok:false 表达
//   2. 零新增依赖 —— 共享 fetchWithRetry（Node 18+ 内置 fetch + AbortSignal.timeout）
//   3. 降级诚实 —— 未配置 apiKey 时返回 degraded:true（零网络）
//   4. 可观测 —— 每次调用（含重试后的最终结果）经 meter 恰好上报一条
//      （kind = `${providerId}.chat`）
//   5. 密钥卫生 —— 错误串一律经 sanitizeError（密钥绝不出现在错误面）

import type {
  ProviderOptions,
  VisionChatRequest,
  VisionChatResult,
  VisionProvider,
} from './types';
import { extractProviderJson, fetchWithRetry, HTTP_STATUS_BAD_REQUEST, sanitizeError } from './types';

/** Gemini 适配器专属配置 —— 在共享 ProviderOptions 之上补三个缺省值注入口 */
export interface GeminiProviderConfig extends ProviderOptions {
  /** 缺省基址（ProviderOptions.baseUrl 未设时用）—— 默认 https://generativelanguage.googleapis.com/v1beta */
  defaultBaseUrl?: string;
  /** 缺省模型（ProviderOptions.model 未设时用）—— 默认 'gemini-2.0-flash' */
  defaultModel?: string;
  /** providerId 预设（ProviderOptions.id 未设时用）—— 默认 'gemini' */
  idPreset?: string;
}

const FALLBACK_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const FALLBACK_MODEL = 'gemini-2.0-flash';
const FALLBACK_ID = 'gemini';
const METER_KIND_SUFFIX = '.chat';

/** 首个非空串（trim 后）—— 配置解析的「显式字段 > 缺省值字段 > 内置缺省」链条 */
function firstNonEmpty(...vals: Array<string | undefined>): string {
  for (const v of vals) {
    const s = (v ?? '').trim();
    if (s !== '') return s;
  }
  return '';
}

/** usageMetadata 映射 —— promptTokenCount/candidatesTokenCount →
 *  promptTokens/completionTokens；至少一个为有限非负数才产出对象
 *  （服务端缺省 usageMetadata 时不下发空壳）。 */
function mapUsageMetadata(u: unknown): { promptTokens?: number; completionTokens?: number } | undefined {
  const o = u as { promptTokenCount?: unknown; candidatesTokenCount?: unknown } | null;
  const pt = Number(o?.promptTokenCount);
  const ct = Number(o?.candidatesTokenCount);
  const has = (n: number) => Number.isFinite(n) && n >= 0;
  if (!o || (!has(pt) && !has(ct))) return undefined;
  return {
    ...(has(pt) ? { promptTokens: pt } : {}),
    ...(has(ct) ? { completionTokens: ct } : {}),
  };
}

/** 响应文本提取 —— candidates[0].content.parts 中 text 项按序拼接；
 *  parts 缺失（协议违约）返回 null。 */
function extractPartsText(payload: unknown): string | null {
  const parts = (payload as {
    candidates?: { content?: { parts?: unknown[] } }[];
  } | null)?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  let text = '';
  for (const p of parts) {
    if (typeof p === 'string') {
      text += p;
      continue;
    }
    const t = (p as { text?: unknown } | null)?.text;
    if (typeof t === 'string') text += t;
  }
  return text;
}

/** 尾斜杠剥离 —— '.../v1beta/' 与 '.../v1beta' 必须拼出同一 URL */
function trimTrailingSlashes(s: string): string {
  return s.replace(/\/+$/, '');
}

/** 安全 JSON.parse —— 脏值（空串/非 JSON）安静返回 undefined，绝不抛 */
function tryParseJson(s: string | undefined): unknown {
  if (typeof s !== 'string' || s === '') return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** 擦除门槛（纪元 Δ-3 硬化，三适配器同律）：短于 8 字符的「密钥」不具擦除价值
 *  （模式表前缀形密文同样要求 ≥8 字符），且单字符密钥会把错误正文成片误伤
 *  （如 'k' 撕碎 'max_tokens'）—— 宁可跳过，交由模式表兜底。 */
const SCRUB_MIN_SECRET_LEN = 8;

/**
 * 密钥兜底擦除（纪元 Δ-3，与 openai.scrubSecret 同律）：sanitizeError 只认
 * Bearer/前缀形/键值对形凭据，本 provider 的 exact-key（如网关 403/401 回显的
 * 自定义密钥串）不在模式表内 —— 任何上游把 key 原文漏进 error 串时在此就地处决。
 */
function scrubSecret(text: string, secret: string): string {
  if (!secret || secret.length < SCRUB_MIN_SECRET_LEN) return text;
  return text.split(secret).join('***redacted***');
}

// ─── ΝΩ-44（结构化输出约束解码）：Gemini OpenAPI 子集转换器 ───

/**
 * jsonMode 提示词追加行（ΝΩ-44 回退态用，与 anthropic.JSON_MODE_SUFFIX 同文）：
 * responseSchema 模式被网关 400 拒后的「提示词后缀模式」纪律行 —— 剥
 * responseSchema/responseMimeType，约束改由提示词约定承担。
 */
const JSON_MODE_SUFFIX = '\n\nOutput strict JSON only. 只输出严格 JSON，不要围栏。';

/** Gemini responseSchema 认识的 JSON Schema 键（OpenAPI 3.0 Schema 子集白名单）：
 *  白名单之外的一切键（$schema/$ref/additionalProperties/minLength/pattern/
 *  allOf…）丢弃并注记 —— 宁可少约束，不可发被拒的载荷。 */
const GEMINI_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  'type', 'format', 'description', 'nullable', 'enum', 'items', 'properties', 'required',
]);

/** JSON Schema type（小写）→ Gemini Type 枚举（大写）—— 未知名安静丢弃
 *  （'null' 等无 Gemini 对应形态，不臆造）。 */
const GEMINI_TYPE_MAP: Readonly<Record<string, string>> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
};

/**
 * JSON Schema → Gemini responseSchema 最小转换器（ΝΩ-44）：
 *  - 递归收窄到 OpenAPI 子集白名单；不支持键收集进 dropped（调用方注记面）
 *  - type 小写→大写枚举；format 仅认 'enum'/'date-time'（官方支持面）
 *  - enum 仅保留字符串成员（Gemini Schema.enum 为 string 数组面）
 *  - required 仅保留字符串成员；脏节点（非纯对象/数组）转换结果 undefined ——
 *    properties 下即整属性丢弃（诚实少约束，绝不臆造类型）
 *  - 空节点/全丢弃 ⇒ undefined（调用方据此回退提示词后缀模式）
 *  绝不抛异常 —— 一切脏值安静降级为「该节点不可表达」。
 */
function toGeminiResponseSchema(
  node: unknown,
  dropped: Set<string>,
): Record<string, unknown> | undefined {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
  const src = node as Record<string, unknown>;
  for (const k of Object.keys(src)) {
    if (!GEMINI_SCHEMA_KEYS.has(k)) dropped.add(k);
  }
  const out: Record<string, unknown> = {};
  const mappedType = typeof src.type === 'string' ? GEMINI_TYPE_MAP[src.type] : undefined;
  if (mappedType !== undefined) out.type = mappedType;
  if (src.format === 'enum' || src.format === 'date-time') out.format = src.format;
  if (typeof src.description === 'string' && src.description !== '') out.description = src.description;
  if (typeof src.nullable === 'boolean') out.nullable = src.nullable;
  if (Array.isArray(src.enum)) {
    const strs = src.enum.filter((v): v is string => typeof v === 'string');
    if (strs.length > 0) out.enum = strs;
  }
  if (src.items !== null && typeof src.items === 'object' && !Array.isArray(src.items)) {
    const conv = toGeminiResponseSchema(src.items, dropped);
    if (conv !== undefined) out.items = conv;
  }
  const props = src.properties;
  if (props !== null && typeof props === 'object' && !Array.isArray(props)) {
    const converted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      const conv = toGeminiResponseSchema(v, dropped);
      if (conv !== undefined) converted[k] = conv;
    }
    if (Object.keys(converted).length > 0) out.properties = converted;
  }
  if (Array.isArray(src.required)) {
    const reqs = src.required.filter((s): s is string => typeof s === 'string');
    if (reqs.length > 0) out.required = reqs;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 创建 Gemini 协议适配器 —— 无状态、线程安全（每次 chat 独立请求）。
 * 构造期快照配置，之后不回读任何外部状态（测试依赖此确定性）。
 *
 * 配置解析优先级：ProviderOptions 显式字段（id/baseUrl/model/apiKey…）
 * > 本接口缺省值字段（idPreset/defaultBaseUrl/defaultModel）> 内置缺省。
 * 未配置 apiKey ⇒ configured:false，chat/chatJson 返回 degraded（零网络）。
 */
export function createGeminiProvider(config: GeminiProviderConfig = {}): VisionProvider {
  const apiKey = (config.apiKey ?? '').trim();
  const providerId = firstNonEmpty(config.id, config.idPreset, FALLBACK_ID);
  const baseUrl = trimTrailingSlashes(
    firstNonEmpty(config.baseUrl, config.defaultBaseUrl, FALLBACK_BASE_URL),
  );
  const model = firstNonEmpty(config.model, config.defaultModel) || FALLBACK_MODEL;
  const meterKind = `${providerId}${METER_KIND_SUFFIX}`;

  const configured = apiKey.length > 0;

  /** meter 上报 —— 回调自身抛错不得影响主路径（不抛铁律的最后一块拼图） */
  const report = (res: VisionChatResult): void => {
    if (!config.meter) return;
    try {
      config.meter({
        ts: Date.now(),
        kind: meterKind,
        providerId,
        model: res.model,
        latencyMs: res.latencyMs,
        ok: res.ok,
        ...(res.usage?.promptTokens !== undefined ? { promptTokens: res.usage.promptTokens } : {}),
        ...(res.usage?.completionTokens !== undefined ? { completionTokens: res.usage.completionTokens } : {}),
        ...(res.error !== undefined ? { error: res.error } : {}),
      });
    } catch { /* 遥测故障静默 —— 主结果已定 */ }
  };

  const chat = async (req: VisionChatRequest): Promise<VisionChatResult> => {
    const startedAt = Date.now();
    const maxTokens = req.maxTokens ?? 2048;
    const temperature = req.temperature ?? 0.1;
    const timeoutMs = req.timeoutMs ?? 30_000;
    const maxRetries = req.maxRetries ?? 2;

    // 结束包装：补 providerId/model/latencyMs + 密钥卫生兜底（纪元 Δ-3）+ meter 上报
    //（含 degraded/失败臂）
    const finish = (r: Omit<VisionChatResult, 'providerId' | 'latencyMs' | 'model'>): VisionChatResult => {
      const res: VisionChatResult = { ...r, providerId, latencyMs: Date.now() - startedAt, model };
      if (res.error !== undefined) res.error = scrubSecret(res.error, apiKey);
      report(res);
      return res;
    };

    // 不抛铁律（纪元 Δ-4，anthropic 模板）：chat 全体包 try —— 脏请求
    //（images 缺失/垃圾 payload 等消息构造面故障）也收敛为 ok:false，绝不上抛
    try {
      if (!configured) {
        return finish({
          ok: false, text: '', degraded: true,
          error: `${providerId} api key not configured (pass config.apiKey to createGeminiProvider)`,
        });
      }

      // ΝΩ-44（结构化输出约束解码）：jsonSchema 在场 ⇒ generationConfig 补
      // responseMimeType:'application/json' + responseSchema（schema 经 OpenAPI
      // 子集转换器收窄，不支持字段丢弃并注记 degradeNote —— 终败时并入 error
      // 诚实归因，旧路径恒 undefined ⇒ 旧 error 串逐字节不变）。schema 脏值/
      // 收窄到空 ⇒ 无法表达 ⇒ 诚实回退提示词后缀模式（prompt 补 JSON 约定行，
      // 运行层绝不抛）。缺席 ⇒ 旧 payload 逐字节保持（零回归铁律）。
      let degradeNote: string | undefined;
      let responseSchema: Record<string, unknown> | undefined;
      let promptText = req.prompt;
      if (req.jsonSchema !== undefined) {
        const dropped = new Set<string>();
        const converted = toGeminiResponseSchema(req.jsonSchema, dropped);
        if (converted !== undefined) {
          responseSchema = converted;
          if (dropped.size > 0) {
            degradeNote = `schema fields not supported by gemini responseSchema dropped: ${[...dropped].sort().join(', ')}`;
          }
        } else {
          degradeNote = 'jsonSchema not representable as gemini responseSchema - fell back to prompt-suffix json mode';
          promptText = `${req.prompt}${JSON_MODE_SUFFIX}`;
        }
      }
      const schemaIntent = req.jsonSchema !== undefined; // 结构化意图在场（提取门槛/注记面）

      // Gemini generateContent 请求体 —— undefined 字段经条件展开，绝不进序列化
      const payload: Record<string, unknown> = {
        ...(req.system !== undefined && req.system !== ''
          ? { systemInstruction: { parts: [{ text: req.system }] } }
          : {}),
        contents: [{
          role: 'user',
          parts: [
            ...req.images.map(img => ({
              inline_data: { mime_type: img.mime ?? 'image/jpeg', data: img.base64 },
            })),
            { text: promptText },
          ],
        }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature,
          ...(responseSchema !== undefined || req.jsonMode ? { responseMimeType: 'application/json' } : {}),
          ...(responseSchema !== undefined ? { responseSchema } : {}),
        },
      };

      // 密钥只走 header（x-goog-api-key）—— 绝不进 URL query（日志卫生）
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        ...(config.extraHeaders ?? {}),
      };

      const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;

      // 传输底座（重试律唯一定义点）：429/5xx/网络错可重试，超时不重试
      let outcome = await fetchWithRetry({
        doFetch: config.fetchImpl ?? fetch,
        url,
        init: {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        },
        maxRetries,
        timeoutMs,
      });

      // ΝΩ-44 回退（responseSchema 不被网关支持）：400 类配置性失败（429/5xx
      // 已由 fetchWithRetry 重试域处置，传输面失败换模式无义）⇒ 剥 responseSchema/
      // responseMimeType、prompt 尾部补 JSON 约定行重发**恰一次**（提示词后缀
      // 模式 —— 约束解码失败的诚实回退，运行层绝不抛）；重发再败按终败处置
      //（回退只挂在这一处顺序代码上，无循环）。旧路径（无 jsonSchema）恒不进
      // 此分支 ⇒ 旧 400 行为逐字节不变（零回归铁律）。
      if (
        !outcome.ok &&
        outcome.failureKind === 'http' &&
        outcome.status === HTTP_STATUS_BAD_REQUEST &&
        responseSchema !== undefined
      ) {
        degradeNote = degradeNote !== undefined
          ? `${degradeNote}; responseSchema rejected - fell back to prompt-suffix json mode`
          : 'responseSchema rejected by gateway (HTTP 400) - fell back to prompt-suffix json mode';
        outcome = await fetchWithRetry({
          doFetch: config.fetchImpl ?? fetch,
          url,
          init: {
            method: 'POST',
            headers,
            body: JSON.stringify({
              ...payload,
              contents: [{
                role: 'user',
                parts: [
                  ...req.images.map(img => ({
                    inline_data: { mime_type: img.mime ?? 'image/jpeg', data: img.base64 },
                  })),
                  { text: `${req.prompt}${JSON_MODE_SUFFIX}` },
                ],
              }],
              generationConfig: {
                maxOutputTokens: maxTokens,
                temperature,
              },
            }),
          },
          maxRetries,
          timeoutMs,
        });
      }

      if (!outcome.ok) {
        if (outcome.status === undefined) {
          // 传输终败 / 超时 —— fetchWithRetry 已产出归因串，再过一遍密钥卫生；
          // ΝΩ-44 注记（仅 schema 路径可非空）随 error 诚实归因
          const noted0 = degradeNote !== undefined ? `${outcome.error} [ΝΩ-44: ${degradeNote}]` : outcome.error;
          return finish({ ok: false, text: '', error: sanitizeError(noted0, providerId) });
        }
        // HTTP 终败：Gemini 错误体 {error:{message}} —— 归因优先取 error.message
        const parsed = tryParseJson(outcome.body);
        const apiMsg = (parsed as { error?: { message?: unknown } } | null | undefined)
          ?.error?.message;
        const inner = typeof apiMsg === 'string' && apiMsg !== ''
          ? apiMsg
          : (outcome.body ?? '').replace(/\s+/g, ' ').trim();
        const attemptsSuffix = outcome.attempts > 1 ? ` after ${outcome.attempts} attempts` : '';
        const noted = degradeNote !== undefined
          ? `HTTP ${outcome.status}${attemptsSuffix}${inner !== '' ? `: ${inner}` : ''} [ΝΩ-44: ${degradeNote}]`
          : `HTTP ${outcome.status}${attemptsSuffix}${inner !== '' ? `: ${inner}` : ''}`;
        return finish({
          ok: false, text: '',
          error: sanitizeError(noted, providerId),
        });
      }

      let body: unknown;
      try {
        body = JSON.parse(outcome.body ?? '');
      } catch (e) {
        return finish({
          ok: false, text: '',
          error: sanitizeError(`response JSON parse failed: ${(e as Error)?.message ?? String(e)}`, providerId),
        });
      }
      const text = extractPartsText(body);
      if (text === null || text === '') {
        return finish({
          ok: false, text: '',
          error: `${providerId} response missing candidates[0].content.parts text`,
        });
      }
      const usage = mapUsageMetadata((body as { usageMetadata?: unknown }).usageMetadata);
      const r: Omit<VisionChatResult, 'providerId' | 'latencyMs' | 'model'> = { ok: true, text };
      if (usage) r.usage = usage;
      // ΝΩ-44：json 提取门槛放行 schemaIntent（jsonSchema 在场即结构化意图，
      // 不苛求 jsonMode 同开）；旧路径（无 jsonSchema）行为逐字节不变。
      if (req.jsonMode || schemaIntent) {
        const j = extractProviderJson(text);
        if (j !== undefined) r.json = j;
      }
      return finish(r);
    } catch (e) {
      // 不抛铁律的最终兜底：任何实现层（含消息构造面）抛出的异常都收敛为 ok:false
      return finish({ ok: false, text: '', error: sanitizeError(e, providerId) });
    }
  };

  const chatJson = async <T,>(
    req: VisionChatRequest,
  ): Promise<{ ok: boolean; value?: T; error?: string; raw: string }> => {
    const res = await chat({ ...req, jsonMode: true });
    if (!res.ok) {
      return { ok: false, error: res.error, raw: res.text };
    }
    const value = extractProviderJson(res.text);
    if (value === undefined) {
      return {
        ok: false,
        error: `${providerId} json extraction failed: no balanced JSON object/array in reply (${res.text.length} chars)`,
        raw: res.text,
      };
    }
    return { ok: true, value: value as T, raw: res.text };
  };

  return {
    id: providerId,
    protocol: 'gemini',
    model,
    // W8-A6（D-G3）baseUrl 回填（D-A6 遗留闭账）：装配期定格的服务基址只读
    // 暴露 —— 配置自报（config.baseUrl）> 平台预设缺省（config.defaultBaseUrl
    // —— glmClient.castDelegate 传预设处）> Generative Language 官方云。与实际
    // 拨号端点同一常量（`${baseUrl}/models/{model}:generateContent`），尾斜杠
    // 已归一；消费面回退 registry.effectiveBaseUrl，展示面必经 maskBaseUrl。
    baseUrl,
    configured,
    chat,
    chatJson,
  };
}
