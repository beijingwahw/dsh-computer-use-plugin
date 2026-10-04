// src/vlm/providers/anthropic.ts
// 纪元 Ψ（Ψ-3 万脑归一）：Anthropic Claude 协议适配器 —— Messages API 方言。
//
// 协议要点（对齐 Ψ-1 types.ts 宪法）：
//   - POST {baseUrl 去尾斜杠}/v1/messages
//   - 鉴权头 x-api-key: ${apiKey}（非 Bearer）+ anthropic-version: ${apiVersion}
//   - system 是请求体顶层字段（不是 messages 里的消息）
//   - 图像走 content 块：{type:'image', source:{type:'base64', media_type, data}}
//   - jsonMode：Anthropic 无原生 response_format —— 以提示词尾部追加约定行代替
//
// 铁律（继承 glmClient 行为基调 + types.ts 宪法）：
//   1. 永不抛异常 —— 一切失败以返回值 ok:false 表达
//   2. 降级诚实 —— 未配置 apiKey（Anthropic 必须密钥）⇒ degraded:true 零网络
//   3. 密钥卫生 —— 错误串化面一律经 sanitizeError，绝不泄漏 apiKey 值
//   4. 可观测 —— 每次调用（含重试后的最终结果、含降级臂）恰好上报一条 meter
//   5. 传输重试全权委托 fetchWithRetry（重试律唯一定义点）：仅 429/5xx/网络错
//      可重试，超时不重试，全抖动指数退避
import type {
  ProviderMeterRecord,
  ProviderOptions,
  VisionChatRequest,
  VisionChatResult,
  VisionProvider,
} from './types';
import { extractProviderJson, fetchWithRetry, sanitizeError } from './types';

/** Anthropic 适配器装配配置 —— 在通用 ProviderOptions 上叠加 Anthropic 特有缺省 */
export interface AnthropicProviderConfig extends ProviderOptions {
  /** 缺省基址 —— 优先级：baseUrl > env ANTHROPIC_BASE_URL > 此值 > 内置官方云 */
  defaultBaseUrl?: string;
  /** 缺省模型 —— 优先级：model > env ANTHROPIC_MODEL > 此值 > 'claude-sonnet-4' */
  defaultModel?: string;
  /** anthropic-version 请求头的版本串 —— 缺省 '2023-06-01' */
  apiVersion?: string;
  /** providerId 预设（options.id 缺席时生效）—— 缺省 'anthropic' */
  idPreset?: string;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MODEL = 'claude-sonnet-4';
const DEFAULT_API_VERSION = '2023-06-01';
const DEFAULT_PROVIDER_ID = 'anthropic';

/**
 * jsonMode 提示词追加行 —— Anthropic Messages API 无原生 response_format，
 * jsonMode=true 时在 prompt 尾部追加此行（空行 + 指令），以提示词约定
 * 代替协议字段；成功回复仍走 extractProviderJson 剥壳提取。
 */
const JSON_MODE_SUFFIX = '\n\n只输出严格 JSON，不要围栏。';

/** 取非空串 —— 非字符串/空白归 ''（用于配置链逐级回退） */
function nonEmptyStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** media_type 解析 —— mime 缺省/空串回退 'image/jpeg'（buildDataUrl 同律） */
function mediaType(mime: string | undefined): string {
  return typeof mime === 'string' && mime !== '' ? mime : 'image/jpeg';
}

/** usage 映射 —— input_tokens/output_tokens → promptTokens/completionTokens；
 *  至少一个为非负有限数才产出对象（服务端缺省 usage 时不下发空壳）。 */
function mapUsage(u: unknown): { promptTokens?: number; completionTokens?: number } | undefined {
  const o = u as { input_tokens?: unknown; output_tokens?: unknown } | null;
  const pt = Number(o?.input_tokens);
  const ct = Number(o?.output_tokens);
  const has = (n: number) => Number.isFinite(n) && n >= 0;
  if (!o || (!has(pt) && !has(ct))) return undefined;
  return {
    ...(has(pt) ? { promptTokens: pt } : {}),
    ...(has(ct) ? { completionTokens: ct } : {}),
  };
}

/** 响应 content 拼接 —— content 数组中 type==='text' 块的 text 顺序拼接；
 *  thinking/tool_use 等非文本块静默跳过。content 非数组 ⇒ null（诚实失败）。 */
function extractTextBlocks(payload: unknown): string | null {
  const content = (payload as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return null;
  let text = '';
  for (const part of content) {
    const p = part as { type?: unknown; text?: unknown } | null;
    if (p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string') {
      text += p.text;
    }
  }
  return text;
}

/** Anthropic 错误体 message 提取 —— {type:'error',error:{message}} 优先取
 *  error.message；非 JSON / 无 message ⇒ undefined（调用方回退原文片段）。 */
function extractErrorMessage(body: string | undefined): string | undefined {
  try {
    const eb = JSON.parse(body ?? '') as { error?: { message?: unknown } } | null;
    const m = eb?.error?.message;
    if (typeof m === 'string' && m !== '') return m;
  } catch { /* 非法 JSON —— 回退原文片段 */ }
  return undefined;
}

/** 擦除门槛（纪元 Δ-3 硬化，三适配器同律）：短于 8 字符的「密钥」不具擦除价值
 *  （模式表前缀形密文同样要求 ≥8 字符），且单字符密钥会把错误正文成片误伤
 *  （如 'k' 撕碎 'max_tokens'）—— 宁可跳过，交由模式表兜底。 */
const SCRUB_MIN_SECRET_LEN = 8;

/**
 * 密钥兜底擦除（纪元 Δ-3，与 openai.scrubSecret 同律）：sanitizeError 只认
 * Bearer/前缀形/键值对形凭据，本 provider 的 exact-key（如网关 401 回显的
 * 自定义密钥串）不在模式表内 —— 任何上游把 key 原文漏进 error 串时在此就地处决。
 */
function scrubSecret(text: string, secret: string): string {
  if (!secret || secret.length < SCRUB_MIN_SECRET_LEN) return text;
  return text.split(secret).join('***redacted***');
}

/**
 * 铸造 Anthropic Claude 适配器 —— 工厂函数，无状态、线程安全（每次 chat 独立请求）。
 * 构造期快照配置（options > 环境变量 > 内置缺省），之后环境变量变更不回读。
 *
 * @param config 装配配置（apiKey/fetchImpl/meter/extraHeaders 全部可注入）
 * @returns VisionProvider —— id 缺省 'anthropic'，protocol 'anthropic'，永不抛错
 */
export function createAnthropicProvider(config: AnthropicProviderConfig = {}): VisionProvider {
  const cfg = config ?? {};

  // ── 配置解析（构造期一次定格）──
  const providerId = nonEmptyStr(cfg.id) || nonEmptyStr(cfg.idPreset) || DEFAULT_PROVIDER_ID;
  const apiKey =
    nonEmptyStr(cfg.apiKey) || nonEmptyStr(process.env.ANTHROPIC_API_KEY);
  const baseUrl = (
    nonEmptyStr(cfg.baseUrl) ||
    nonEmptyStr(process.env.ANTHROPIC_BASE_URL) ||
    nonEmptyStr(cfg.defaultBaseUrl) ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, '');
  const model =
    nonEmptyStr(cfg.model) ||
    nonEmptyStr(process.env.ANTHROPIC_MODEL) ||
    nonEmptyStr(cfg.defaultModel) ||
    DEFAULT_MODEL;
  const apiVersion = nonEmptyStr(cfg.apiVersion) || DEFAULT_API_VERSION;
  const extraHeaders = cfg.extraHeaders;
  const fetchImpl = cfg.fetchImpl;
  const meter = cfg.meter;

  /** Anthropic 必须密钥 —— 无 key ⇒ chat 走 degraded 降级臂（零网络） */
  const configured = apiKey.length > 0;

  /** meter 上报 —— 恰好一条/调用；回调自身抛错不得影响主路径（不抛铁律拼图） */
  function report(res: VisionChatResult): void {
    if (!meter) return;
    try {
      meter({
        ts: Date.now(),
        kind: `${providerId}.chat`,
        providerId,
        model: res.model,
        latencyMs: res.latencyMs,
        ok: res.ok,
        ...(res.usage?.promptTokens !== undefined ? { promptTokens: res.usage.promptTokens } : {}),
        ...(res.usage?.completionTokens !== undefined ? { completionTokens: res.usage.completionTokens } : {}),
        ...(res.error !== undefined ? { error: res.error } : {}),
      });
    } catch { /* 遥测故障静默 —— 主结果已定 */ }
  }

  /**
   * 视觉对话 —— 永不抛错。
   *
   * - 未配置 apiKey ⇒ { ok:false, degraded:true }（调用方降级为本地认知）
   * - POST {baseUrl}/v1/messages，头：x-api-key / anthropic-version / Content-Type
   *   / extraHeaders（同名覆盖缺省头）
   * - body：{ model, max_tokens, system?, temperature?, messages:[{role:'user',
   *   content:[...images, {type:'text',text:prompt}]}] }（图像块在前、文本块殿后）
   * - jsonMode 语义（JSDoc 契约）：Anthropic 无原生 response_format —— true 时在
   *   prompt 尾部追加一行 "\n\n只输出严格 JSON，不要围栏。"，成功后仍以
   *   extractProviderJson 剥围栏/取平衡段提取；请求体绝不出现 response_format 字段
   * - 2xx ⇒ content 数组 type==='text' 块的 text 拼接；usage.input_tokens/
   *   output_tokens → promptTokens/completionTokens
   * - 非 2xx ⇒ 错误体 {type:'error',error:{message}} 优先取 error.message，
   *   经 sanitizeError 密钥卫生后归入 error（绝不含 apiKey 值）
   * - 重试律（fetchWithRetry 唯一定义点）：429/5xx/网络错可重试；400 等 4xx
   *   立即失败；超时（AbortError）不重试
   * - 每次调用（无论成败）恰好上报一条 meter 记录，kind = `${providerId}.chat`
   */
  async function chat(req: VisionChatRequest): Promise<VisionChatResult> {
    const startedAt = Date.now();
    const maxTokens = req.maxTokens ?? 2048;
    const temperature = req.temperature ?? 0.1;
    const timeoutMs = req.timeoutMs ?? 30_000;
    const maxRetries = req.maxRetries ?? 2;

    // 结束包装：补 latencyMs/model/providerId + 密钥卫生兜底（纪元 Δ-3）+ meter 上报
    //（degraded/传输失败/解析失败/成功全走此处 ⇒ 恰好一条遥测）
    const finish = (r: Omit<VisionChatResult, 'latencyMs' | 'model' | 'providerId'>): VisionChatResult => {
      const res: VisionChatResult = { ...r, latencyMs: Date.now() - startedAt, model, providerId };
      if (res.error !== undefined) res.error = scrubSecret(res.error, apiKey);
      report(res);
      return res;
    };

    try {
      if (!configured) {
        return finish({
          ok: false, text: '', degraded: true,
          error: `${providerId} api key not configured (set ANTHROPIC_API_KEY or pass config.apiKey)`,
        });
      }
      const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
      if (!doFetch) {
        return finish({
          ok: false, text: '',
          error: sanitizeError('fetch is not available (Node >= 18 required)', providerId), // doctor-exempt: 文案字符串，非阈值比较（W6-2）
        });
      }

      // 请求头：x-api-key 鉴权（非 Bearer）+ 协议版本；extraHeaders 同名覆盖缺省
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': apiVersion,
        ...(extraHeaders ?? {}),
      };

      // Messages API 请求体：system 顶层字段；user content = 图像块序列 + 文本块殿后
      const payload: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        ...(req.system !== undefined && req.system !== '' ? { system: req.system } : {}),
        temperature,
        messages: [{
          role: 'user',
          content: [
            ...req.images.map(img => ({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType(img?.mime),
                data: img?.base64 ?? '',
              },
            })),
            {
              type: 'text',
              text: req.jsonMode ? `${req.prompt}${JSON_MODE_SUFFIX}` : req.prompt,
            },
          ],
        }],
      };

      const fr = await fetchWithRetry({
        doFetch,
        url: `${baseUrl}/v1/messages`,
        init: { method: 'POST', headers, body: JSON.stringify(payload) },
        maxRetries,
        timeoutMs,
      });

      // 传输终败（网络错误/超时）—— fetchWithRetry 的 error 已含尝试次数归因
      if (!fr.ok && fr.status === undefined) {
        return finish({ ok: false, text: '', error: sanitizeError(fr.error, providerId) });
      }

      // HTTP 终败（非 2xx）—— 错误体 error.message 优先，原文片段兜底
      if (!fr.ok) {
        const status = fr.status ?? 0;
        const snippet = (fr.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
        const detail = extractErrorMessage(fr.body) ?? snippet;
        const attemptNote = fr.attempts > 1 ? ` after ${fr.attempts} attempts` : '';
        return finish({
          ok: false, text: '',
          error: sanitizeError(`messages HTTP ${status}${attemptNote}: ${detail}`, providerId),
        });
      }

      // 2xx —— 解析 Messages 响应体
      let body: unknown;
      try {
        body = JSON.parse(fr.body ?? '');
      } catch (e) {
        const m = (e as { message?: string } | null)?.message ?? String(e);
        return finish({
          ok: false, text: '',
          error: sanitizeError(`messages response JSON parse failed: ${m}`, providerId),
        });
      }
      const text = extractTextBlocks(body);
      if (text === null) {
        return finish({
          ok: false, text: '',
          error: sanitizeError('response missing content array', providerId),
        });
      }
      const usage = mapUsage((body as { usage?: unknown }).usage);
      const r: Omit<VisionChatResult, 'latencyMs' | 'model' | 'providerId'> = { ok: true, text };
      if (usage) r.usage = usage;
      if (req.jsonMode) {
        const j = extractProviderJson(text);
        if (j !== undefined) r.json = j;
      }
      return finish(r);
    } catch (e) {
      // 不抛铁律的最终兜底（理论不可达 —— 同步面故障也归约为 ok:false）
      return finish({ ok: false, text: '', error: sanitizeError(e, providerId) });
    }
  }

  /**
   * 结构化对话 —— 强制 jsonMode（prompt 尾部追加 JSON 约定行），对回复做
   * 健壮 JSON 提取（extractProviderJson 同律：剥围栏 → 首个平衡 {...}/[...] → parse）。
   * 成功：{ ok:true, value, raw }；失败：{ ok:false, error, raw } —— raw 恒为
   * 模型回复原文（成功也是），调用方可落日志/回退解析。绝不抛错。
   */
  async function chatJson<T>(req: VisionChatRequest): Promise<{ ok: boolean; value?: T; error?: string; raw: string }> {
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
  }

  return {
    id: providerId,
    protocol: 'anthropic',
    model,
    // W8-A6（D-G3）baseUrl 回填（D-A6 遗留闭账）：装配期定格的服务基址只读
    // 暴露 —— 配置自报（cfg.baseUrl > env ANTHROPIC_BASE_URL）> 平台预设缺省
    // （cfg.defaultBaseUrl —— glmClient.castDelegate 传预设处）> 官方云。与实际
    // 拨号端点同一常量（`${baseUrl}/v1/messages`），尾斜杠已归一；消费面回退
    // registry.effectiveBaseUrl，展示面必经 maskBaseUrl（types.ts 宪法）。
    baseUrl,
    configured,
    chat,
    chatJson,
  };
}
