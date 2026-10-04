// src/vlm/providers/openai.ts
// 纪元 Ψ（Ψ-2 万脑归一）：OpenAI 兼容协议适配器。
// 一个适配器覆盖一大族：OpenAI / 智谱GLM / 通义Qwen兼容模式 / Kimi / 豆包Ark / Grok /
// SiliconFlow / OpenRouter / Ollama / vLLM / LM Studio …… 凡说 /chat/completions 方言的
// 云脑皆从此接入；换脑只需换 baseUrl/model/id 三件套（defaultBaseUrl/defaultModel/idPreset 预设）。
//
// 实现铁律（与 glmClient.ts / providers/types.ts 同调）：
//   1. 永不抛异常 —— 一切失败以返回值 ok:false 表达（运行层零异常上抛）
//   2. 零新增依赖 —— 内置 fetch + AbortSignal.timeout（经 fetchWithRetry 统一实施）；
//      测试经 fetchImpl 注入假 fetch，绝不真实联网
//   3. 降级诚实 —— apiKey 缺失且 baseUrl 非本地 ⇒ degraded:true 零网络
//      （Ollama/vLLM/LM Studio 无需密钥，isLocalBaseUrl 豁免）
//   4. 可观测 —— 每次 chat 调用恰好 1 条 meter 记录（kind `${providerId}.chat`，
//      回调自身抛错静默吞掉）
//   5. 密钥卫生 —— error 字符串绝不允许含 apiKey（scrubSecret 末道兜底，见下）
//
// 协议：POST {baseUrl}/chat/completions；headers = Content-Type +（有 key 时）
// `Authorization: Bearer ${apiKey}` + extraHeaders 展开（同名后者覆盖前者）；
// body 为 OpenAI 多模态消息形态：system（可选）在前，user = [text, image_url...]。
import { buildDataUrl, extractProviderJson, fetchWithRetry, HTTP_STATUS_BAD_REQUEST, isLocalBaseUrl, sanitizeError, } from './types.js';
const FALLBACK_BASE_URL = 'https://api.openai.com/v1';
const FALLBACK_MODEL = 'gpt-4o-mini';
const FALLBACK_ID = 'openai';
// types.ts 宪法（VisionChatRequest.maxTokens）注明默认 2048 —— 与 anthropic/
// gemini/glmClient 三家同调；此前 1024 系契约违约（纪元 Δ-1 修正）。
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.1; // 桌面自动化要确定性，不要发散（与 glmClient 同调）
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
/** 响应 content 提取 —— choices[0].message.content；字符串直取，
 *  分段数组方言拼接各项 text（部分兼容网关按 part 分片下发）。 */
function extractContent(payload) {
    const c = payload
        ?.choices?.[0]?.message?.content;
    if (typeof c === 'string')
        return c;
    if (Array.isArray(c)) {
        return c.map(p => (typeof p === 'string' ? p : p?.text ?? '')).join('');
    }
    return null;
}
/** usage 映射 —— prompt_tokens/completion_tokens → promptTokens/completionTokens；
 *  至少一个为有限非负数才产出对象（服务端缺省 usage 时不下发空壳）。 */
function mapUsage(u) {
    const o = u;
    const pt = Number(o?.prompt_tokens);
    const ct = Number(o?.completion_tokens);
    const has = (n) => Number.isFinite(n) && n >= 0;
    if (!o || (!has(pt) && !has(ct)))
        return undefined;
    return {
        ...(has(pt) ? { promptTokens: pt } : {}),
        ...(has(ct) ? { completionTokens: ct } : {}),
    };
}
/** 擦除门槛（纪元 Δ-3 硬化，三适配器同律）：短于 8 字符的「密钥」不具擦除价值
 *  （模式表前缀形密文同样要求 ≥8 字符），且单字符密钥会把错误正文成片误伤
 *  （如 'k' 撕碎 'max_tokens'）—— 宁可跳过，交由模式表兜底。 */
const SCRUB_MIN_SECRET_LEN = 8;
/** 密钥兜底擦除 —— sanitizeError 并不认识本 provider 的 key，任何上游层
 *  （网关回显 / 错误体透传）把 key 漏进 error 串时在此就地处决。 */
function scrubSecret(text, secret) {
    if (!secret || secret.length < SCRUB_MIN_SECRET_LEN)
        return text;
    return text.split(secret).join('***redacted***');
}
/**
 * 创建 OpenAI 兼容协议 provider —— 无状态、永不抛。
 * 配置在工厂期快照解析（id > idPreset > 'openai'；baseUrl > defaultBaseUrl >
 * api.openai.com；model > defaultModel > gpt-4o-mini），之后外部变更不回读。
 */
export function createOpenAiProvider(config) {
    const cfg = config ?? {};
    const providerId = (cfg.id ?? cfg.idPreset ?? FALLBACK_ID).trim() || FALLBACK_ID;
    const apiKey = (cfg.apiKey ?? '').trim();
    // 尾斜杠归一：'http://x/v1/' 与 'http://x/v1' 同一归宿（双尾斜杠也吃）
    const baseUrl = (cfg.baseUrl ?? cfg.defaultBaseUrl ?? FALLBACK_BASE_URL).trim().replace(/\/+$/, '') || FALLBACK_BASE_URL;
    const model = (cfg.model ?? cfg.defaultModel ?? FALLBACK_MODEL).trim() || FALLBACK_MODEL;
    const fetchImpl = cfg.fetchImpl;
    const meter = cfg.meter;
    const extraHeaders = cfg.extraHeaders;
    /** 有 key，或 baseUrl 指向本地服务（Ollama/vLLM/LM Studio 无需密钥） */
    const configured = apiKey.length > 0 || isLocalBaseUrl(baseUrl);
    /** meter 上报 —— 每次调用恰好一条；回调自身抛错不得影响主路径 */
    const report = (res) => {
        if (!meter)
            return;
        try {
            meter({
                ts: Date.now(),
                kind: `${providerId}.chat`,
                providerId,
                model,
                latencyMs: res.latencyMs,
                ok: res.ok,
                ...(res.usage?.promptTokens !== undefined ? { promptTokens: res.usage.promptTokens } : {}),
                ...(res.usage?.completionTokens !== undefined ? { completionTokens: res.usage.completionTokens } : {}),
                ...(res.error !== undefined ? { error: res.error } : {}),
            });
        }
        catch { /* 遥测故障静默 —— 主结果已定 */ }
    };
    async function chat(req) {
        const startedAt = Date.now();
        const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
        const temperature = req.temperature ?? DEFAULT_TEMPERATURE;
        const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const maxRetries = req.maxRetries ?? DEFAULT_MAX_RETRIES;
        // 结束包装：补 latencyMs/model/providerId + 密钥卫生兜底 + meter 上报
        //（degraded/传输失败/解析失败/成功全走此处 ⇒ 恰好一条遥测）
        const finish = (r) => {
            const res = { ...r, latencyMs: Date.now() - startedAt, model, providerId };
            if (res.error !== undefined)
                res.error = scrubSecret(res.error, apiKey);
            report(res);
            return res;
        };
        // 不抛铁律（纪元 Δ-4）：chat 全体包 try（anthropic 模板）—— 脏请求
        //（images 缺失/垃圾 payload 等消息构造面故障）也收敛为 ok:false，绝不上抛
        try {
            // 降级臂：无 key 且非本地服务 ⇒ 零网络
            if (!configured) {
                return finish({
                    ok: false, text: '', degraded: true,
                    error: `${providerId} api key not configured (set config.apiKey or point baseUrl at a local server)`,
                });
            }
            const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
            if (!doFetch) {
                return finish({ ok: false, text: '', error: `${providerId} fetch is not available (Node >= 18 required)` }); // doctor-exempt: 文案字符串，非阈值比较（W6-2）
            }
            // OpenAI 多模态消息：system（可选）在前，user = 文本 + 图片序列。
            // ΝΩ-18（response_format 400 回退）：消息/负载构造收进闭包 —— 首发带
            // response_format（原行为），被网关 400 点名回退时剥字段重发一次。
            // ΝΩ-44（结构化输出约束解码）：format 升格为三态 —— 'none'（无字段，
            // 与旧 stripResponseFormat:true 逐字节同形）/ 'jsonObject'（旧 jsonMode
            // 原行为）/ 'jsonSchemaStrict'（jsonMode + req.jsonSchema 在场 ⇒ 原生
            // 约束解码：{type:'json_schema'} + strict 强 schema，schema 由请求方传入）。
            // 缺省缺席（req.jsonSchema 未传）⇒ 永远只在 none/jsonObject 二态间走 ——
            // 旧路径逐字节保持（零回归铁律）。
            const buildInit = (promptText, format) => {
                const messages = [];
                if (req.system !== undefined && req.system !== '')
                    messages.push({ role: 'system', content: req.system });
                messages.push({
                    role: 'user',
                    content: [
                        { type: 'text', text: promptText },
                        ...req.images.map(img => ({
                            type: 'image_url',
                            image_url: { url: buildDataUrl(img) },
                        })),
                    ],
                });
                const payload = {
                    model,
                    messages,
                    max_tokens: maxTokens,
                    temperature,
                    // jsonMode 关闭（或回退已剥）时 response_format 根本不出现在 JSON 里
                    ...(format === 'jsonObject'
                        ? { response_format: { type: 'json_object' } }
                        : format === 'jsonSchemaStrict'
                            ? {
                                response_format: {
                                    type: 'json_schema',
                                    json_schema: { name: 'dsh_response', strict: true, schema: req.jsonSchema },
                                },
                            }
                            : {}),
                };
                return { method: 'POST', headers, body: JSON.stringify(payload) };
            };
            const headers = {
                'Content-Type': 'application/json',
                // 无 key 的本地服务不下发 Authorization（空 Bearer 徒扰 Ollama 们）
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                // extraHeaders 最后展开 —— 同名可覆盖内置头（OpenRouter 类网关要求自带头）
                ...extraHeaders,
            };
            // 传输层统一交给 fetchWithRetry：AbortSignal.timeout(timeoutMs) 止损 +
            // 429/5xx/网络错误退避重试 + 超时不重试（重试律见 types.ts 契约）。
            // ΝΩ-44：jsonMode 且 jsonSchema 在场 ⇒ 首发即 strict json_schema（原生
            // 约束解码）；缺席 ⇒ 旧二值行为逐字节保持。
            let format = !req.jsonMode
                ? 'none'
                : (req.jsonSchema !== undefined ? 'jsonSchemaStrict' : 'jsonObject');
            let fr = await fetchWithRetry({
                doFetch,
                url: `${baseUrl}/chat/completions`,
                init: buildInit(req.prompt, format),
                maxRetries,
                timeoutMs,
            });
            // ΝΩ-44 注记：约束解码被网关拒绝后的降级轨迹（仅 strict 路径可非空 ——
            // 旧路径恒 undefined ⇒ error 串逐字节不变）；终败时并入 error 诚实归因。
            let degradeNote;
            // ΝΩ-44 一级回退（json_schema 不被网关支持）：400 且错误体点名
            // json_schema（或宽泛的 response_format）⇒ 降级 json_object 重发恰一次；
            // 降级后的 400 再点名 response_format ⇒ 交给下方 ΝΩ-18 二级回退剥字段，
            // 三级链 json_schema → json_object → prompt-only 恰两次重发，无循环
            //（每次条件都依赖当前 format 态，降到底后条件天然不成立）。
            if (!fr.ok &&
                fr.failureKind === 'http' &&
                fr.status === HTTP_STATUS_BAD_REQUEST &&
                format === 'jsonSchemaStrict' &&
                /json_schema|response_format/.test(`${fr.body ?? ''}`.toLowerCase())) {
                degradeNote = 'structured json_schema rejected by gateway (HTTP 400) - downgraded to json_object';
                format = 'jsonObject';
                fr = await fetchWithRetry({
                    doFetch,
                    url: `${baseUrl}/chat/completions`,
                    init: buildInit(req.prompt, format),
                    maxRetries,
                    timeoutMs,
                });
            }
            // ΝΩ-18（response_format 400 回退）：部分 OpenAI 兼容网关不认
            // response_format:{type:'json_object'}，对 json_object 模式回 400 —— 而
            // 4xx 不在重试域（types.ts 重试律：请求本身有病，重试无义），一次配置性
            // 失败会把该网关上的全部结构化调用判死。回退律：400 且错误体点名
            // response_format 且本次确实下发了该字段 ⇒ 剥字段重发**恰一次**
            //（prompt-only jsonMode：prompt 尾部补 JSON 铁律 + 上方 extractProviderJson
            // 剥壳提取兜底）；重发再败按终败处置（strip 后请求已无该字段，条件天然
            // 不再成立，无循环）。startedAt/meter 收口不变 —— 一次 chat 仍恰一条遥测，
            // latencyMs 如实涵盖多次拨号。ΝΩ-44 链衔接：strict 降级 json_object 后
            // 再 400 ⇒ 从此处继续降 prompt-only（degradeNote 追加注记）。
            if (!fr.ok &&
                fr.failureKind === 'http' &&
                fr.status === HTTP_STATUS_BAD_REQUEST &&
                format === 'jsonObject' &&
                req.jsonMode === true &&
                `${fr.body ?? ''}`.toLowerCase().includes('response_format')) {
                if (degradeNote !== undefined) {
                    degradeNote = `${degradeNote}; response_format rejected - downgraded to prompt-only jsonMode`;
                }
                fr = await fetchWithRetry({
                    doFetch,
                    url: `${baseUrl}/chat/completions`,
                    init: buildInit(`${req.prompt}\n\nRespond with a single valid JSON value only — no markdown fences, no extra text.`, 'none'),
                    maxRetries,
                    timeoutMs,
                });
            }
            if (!fr.ok) {
                const raw = fr.error ??
                    `${providerId} chat/completions failed${fr.status !== undefined ? ` (HTTP ${fr.status})` : ''}`;
                // ΝΩ-44 注记：约束解码降级轨迹并入终败归因（旧路径 degradeNote 恒
                // undefined ⇒ 旧 error 串逐字节不变）
                const noted = degradeNote !== undefined ? `${raw} [ΝΩ-44: ${degradeNote}]` : raw;
                return finish({ ok: false, text: '', error: sanitizeError(noted, providerId) });
            }
            let body;
            try {
                body = JSON.parse(fr.body ?? '');
            }
            catch (e) {
                return finish({ ok: false, text: '', error: sanitizeError(e, providerId) });
            }
            const content = extractContent(body);
            if (content === null) {
                return finish({
                    ok: false, text: '',
                    error: sanitizeError(new Error('response missing choices[0].message.content'), providerId),
                });
            }
            const usage = mapUsage(body.usage);
            const r = { ok: true, text: content };
            if (usage)
                r.usage = usage;
            // json 字段恒做健壮提取（围栏/杂文皆可），提不到仅缺省 —— 判失败请用 chatJson
            const j = extractProviderJson(content);
            if (j !== undefined)
                r.json = j;
            return finish(r);
        }
        catch (e) {
            // 末道防线：任何实现层（含 types.ts 工具）抛出的异常都在此收敛为 ok:false
            return finish({ ok: false, text: '', error: sanitizeError(e, providerId) });
        }
    }
    /** 结构化对话 —— 强制 jsonMode 后健壮提取；raw 恒为回复原文（成败皆然） */
    async function chatJson(req) {
        try {
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
        }
        catch (e) {
            return { ok: false, error: sanitizeError(e, providerId), raw: '' };
        }
    }
    // ΑΩ-R35（类型严格化）：返回对象恰好是 VisionProvider 接口面 —— 此前携带
    // 接口外属性 providerId 并以 `as VisionProvider` 压制检查（类型逃逸）。全库
    // 检索确认无人从 provider 对象读 providerId（归因一律走 chat 结果的
    // VisionChatResult.providerId 与本接口的 id），且其值恒等于 id —— 纯冗余，
    // 删除；断言一并摘除，让结构化检查全量生效（与 anthropic/gemini 同形）。
    return {
        id: providerId,
        protocol: 'openai',
        model,
        baseUrl,
        configured,
        chat,
        chatJson,
    };
}
