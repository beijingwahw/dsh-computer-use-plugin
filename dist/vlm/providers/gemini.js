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
import { extractProviderJson, fetchWithRetry, sanitizeError } from './types.js';
const FALLBACK_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const FALLBACK_MODEL = 'gemini-2.0-flash';
const FALLBACK_ID = 'gemini';
const METER_KIND_SUFFIX = '.chat';
/** 首个非空串（trim 后）—— 配置解析的「显式字段 > 缺省值字段 > 内置缺省」链条 */
function firstNonEmpty(...vals) {
    for (const v of vals) {
        const s = (v ?? '').trim();
        if (s !== '')
            return s;
    }
    return '';
}
/** usageMetadata 映射 —— promptTokenCount/candidatesTokenCount →
 *  promptTokens/completionTokens；至少一个为有限非负数才产出对象
 *  （服务端缺省 usageMetadata 时不下发空壳）。 */
function mapUsageMetadata(u) {
    const o = u;
    const pt = Number(o?.promptTokenCount);
    const ct = Number(o?.candidatesTokenCount);
    const has = (n) => Number.isFinite(n) && n >= 0;
    if (!o || (!has(pt) && !has(ct)))
        return undefined;
    return {
        ...(has(pt) ? { promptTokens: pt } : {}),
        ...(has(ct) ? { completionTokens: ct } : {}),
    };
}
/** 响应文本提取 —— candidates[0].content.parts 中 text 项按序拼接；
 *  parts 缺失（协议违约）返回 null。 */
function extractPartsText(payload) {
    const parts = payload?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts))
        return null;
    let text = '';
    for (const p of parts) {
        if (typeof p === 'string') {
            text += p;
            continue;
        }
        const t = p?.text;
        if (typeof t === 'string')
            text += t;
    }
    return text;
}
/** 尾斜杠剥离 —— '.../v1beta/' 与 '.../v1beta' 必须拼出同一 URL */
function trimTrailingSlashes(s) {
    return s.replace(/\/+$/, '');
}
/** 安全 JSON.parse —— 脏值（空串/非 JSON）安静返回 undefined，绝不抛 */
function tryParseJson(s) {
    if (typeof s !== 'string' || s === '')
        return undefined;
    try {
        return JSON.parse(s);
    }
    catch {
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
function scrubSecret(text, secret) {
    if (!secret || secret.length < SCRUB_MIN_SECRET_LEN)
        return text;
    return text.split(secret).join('***redacted***');
}
/**
 * 创建 Gemini 协议适配器 —— 无状态、线程安全（每次 chat 独立请求）。
 * 构造期快照配置，之后不回读任何外部状态（测试依赖此确定性）。
 *
 * 配置解析优先级：ProviderOptions 显式字段（id/baseUrl/model/apiKey…）
 * > 本接口缺省值字段（idPreset/defaultBaseUrl/defaultModel）> 内置缺省。
 * 未配置 apiKey ⇒ configured:false，chat/chatJson 返回 degraded（零网络）。
 */
export function createGeminiProvider(config = {}) {
    const apiKey = (config.apiKey ?? '').trim();
    const providerId = firstNonEmpty(config.id, config.idPreset, FALLBACK_ID);
    const baseUrl = trimTrailingSlashes(firstNonEmpty(config.baseUrl, config.defaultBaseUrl, FALLBACK_BASE_URL));
    const model = firstNonEmpty(config.model, config.defaultModel) || FALLBACK_MODEL;
    const meterKind = `${providerId}${METER_KIND_SUFFIX}`;
    const configured = apiKey.length > 0;
    /** meter 上报 —— 回调自身抛错不得影响主路径（不抛铁律的最后一块拼图） */
    const report = (res) => {
        if (!config.meter)
            return;
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
        }
        catch { /* 遥测故障静默 —— 主结果已定 */ }
    };
    const chat = async (req) => {
        const startedAt = Date.now();
        const maxTokens = req.maxTokens ?? 2048;
        const temperature = req.temperature ?? 0.1;
        const timeoutMs = req.timeoutMs ?? 30_000;
        const maxRetries = req.maxRetries ?? 2;
        // 结束包装：补 providerId/model/latencyMs + 密钥卫生兜底（纪元 Δ-3）+ meter 上报
        //（含 degraded/失败臂）
        const finish = (r) => {
            const res = { ...r, providerId, latencyMs: Date.now() - startedAt, model };
            if (res.error !== undefined)
                res.error = scrubSecret(res.error, apiKey);
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
            // Gemini generateContent 请求体 —— undefined 字段经条件展开，绝不进序列化
            const payload = {
                ...(req.system !== undefined && req.system !== ''
                    ? { systemInstruction: { parts: [{ text: req.system }] } }
                    : {}),
                contents: [{
                        role: 'user',
                        parts: [
                            ...req.images.map(img => ({
                                inline_data: { mime_type: img.mime ?? 'image/jpeg', data: img.base64 },
                            })),
                            { text: req.prompt },
                        ],
                    }],
                generationConfig: {
                    maxOutputTokens: maxTokens,
                    temperature,
                    ...(req.jsonMode ? { responseMimeType: 'application/json' } : {}),
                },
            };
            // 密钥只走 header（x-goog-api-key）—— 绝不进 URL query（日志卫生）
            const headers = {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey,
                ...(config.extraHeaders ?? {}),
            };
            const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
            // 传输底座（重试律唯一定义点）：429/5xx/网络错可重试，超时不重试
            const outcome = await fetchWithRetry({
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
            if (!outcome.ok) {
                if (outcome.status === undefined) {
                    // 传输终败 / 超时 —— fetchWithRetry 已产出归因串，再过一遍密钥卫生
                    return finish({ ok: false, text: '', error: sanitizeError(outcome.error, providerId) });
                }
                // HTTP 终败：Gemini 错误体 {error:{message}} —— 归因优先取 error.message
                const parsed = tryParseJson(outcome.body);
                const apiMsg = parsed
                    ?.error?.message;
                const inner = typeof apiMsg === 'string' && apiMsg !== ''
                    ? apiMsg
                    : (outcome.body ?? '').replace(/\s+/g, ' ').trim();
                const attemptsSuffix = outcome.attempts > 1 ? ` after ${outcome.attempts} attempts` : '';
                return finish({
                    ok: false, text: '',
                    error: sanitizeError(`HTTP ${outcome.status}${attemptsSuffix}${inner !== '' ? `: ${inner}` : ''}`, providerId),
                });
            }
            let body;
            try {
                body = JSON.parse(outcome.body ?? '');
            }
            catch (e) {
                return finish({
                    ok: false, text: '',
                    error: sanitizeError(`response JSON parse failed: ${e?.message ?? String(e)}`, providerId),
                });
            }
            const text = extractPartsText(body);
            if (text === null || text === '') {
                return finish({
                    ok: false, text: '',
                    error: `${providerId} response missing candidates[0].content.parts text`,
                });
            }
            const usage = mapUsageMetadata(body.usageMetadata);
            const r = { ok: true, text };
            if (usage)
                r.usage = usage;
            if (req.jsonMode) {
                const j = extractProviderJson(text);
                if (j !== undefined)
                    r.json = j;
            }
            return finish(r);
        }
        catch (e) {
            // 不抛铁律的最终兜底：任何实现层（含消息构造面）抛出的异常都收敛为 ok:false
            return finish({ ok: false, text: '', error: sanitizeError(e, providerId) });
        }
    };
    const chatJson = async (req) => {
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
        return { ok: true, value: value, raw: res.text };
    };
    return {
        id: providerId,
        protocol: 'gemini',
        model,
        configured,
        chat,
        chatJson,
    };
}
