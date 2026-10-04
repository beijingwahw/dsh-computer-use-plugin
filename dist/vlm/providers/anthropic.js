import { extractProviderJson, fetchWithRetry, HTTP_STATUS_BAD_REQUEST, sanitizeError } from './types.js';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MODEL = 'claude-sonnet-4';
const DEFAULT_API_VERSION = '2023-06-01';
const DEFAULT_PROVIDER_ID = 'anthropic';
/**
 * jsonMode 提示词追加行 —— Anthropic Messages API 无原生 response_format，
 * jsonMode=true 时在 prompt 尾部追加此行（空行 + 指令），以提示词约定
 * 代替协议字段；成功回复仍走 extractProviderJson 剥壳提取。
 * ΑΩ-R35（中英双语）：追加行改为双语 —— 只认中文指令的英文语境模型（经
 * Anthropic 端点接入的第三方网关脑）此前可能无视约定输出围栏/散文；双语后
 * 任一语境的脑都能读懂「只输出严格 JSON」，剥壳提取的输入面随之收窄。
 */
const JSON_MODE_SUFFIX = '\n\nOutput strict JSON only. 只输出严格 JSON，不要围栏。';
/** 取非空串 —— 非字符串/空白归 ''（用于配置链逐级回退） */
function nonEmptyStr(v) {
    return typeof v === 'string' ? v.trim() : '';
}
/** media_type 解析 —— mime 缺省/空串回退 'image/jpeg'（buildDataUrl 同律） */
function mediaType(mime) {
    return typeof mime === 'string' && mime !== '' ? mime : 'image/jpeg';
}
/** usage 映射 —— input_tokens/output_tokens → promptTokens/completionTokens；
 *  至少一个为非负有限数才产出对象（服务端缺省 usage 时不下发空壳）。 */
function mapUsage(u) {
    const o = u;
    const pt = Number(o?.input_tokens);
    const ct = Number(o?.output_tokens);
    const has = (n) => Number.isFinite(n) && n >= 0;
    if (!o || (!has(pt) && !has(ct)))
        return undefined;
    return {
        ...(has(pt) ? { promptTokens: pt } : {}),
        ...(has(ct) ? { completionTokens: ct } : {}),
    };
}
/** 响应 content 拼接 —— content 数组中 type==='text' 块的 text 顺序拼接；
 *  thinking/tool_use 等非文本块静默跳过。content 非数组 ⇒ null（诚实失败）。 */
function extractTextBlocks(payload) {
    const content = payload?.content;
    if (!Array.isArray(content))
        return null;
    let text = '';
    for (const part of content) {
        const p = part;
        if (p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string') {
            text += p.text;
        }
    }
    return text;
}
/**
 * ΝΩ-44（结构化输出约束解码）：content 数组中首个 tool_use 块的 input 提取。
 * tool_use 强 schema 模式下模型的结构化回复落在 content 里 {type:'tool_use',
 * name:'emit', input:{...}} 块 —— input 已是解析好的对象（无需剥壳）；
 * content 非数组 / 无 tool_use 块 / input 缺席 ⇒ undefined（调用方回退文本剥壳）。
 * 绝不抛异常；input 原样透传（脏值由消费面 JSON 序列化兜底）。
 */
function extractToolUseInput(payload) {
    const content = payload?.content;
    if (!Array.isArray(content))
        return undefined;
    for (const part of content) {
        const p = part;
        if (p && typeof p === 'object' && p.type === 'tool_use' && 'input' in p)
            return p.input;
    }
    return undefined;
}
/** Anthropic 错误体 message 提取 —— {type:'error',error:{message}} 优先取
 *  error.message；非 JSON / 无 message ⇒ undefined（调用方回退原文片段）。 */
function extractErrorMessage(body) {
    try {
        const eb = JSON.parse(body ?? '');
        const m = eb?.error?.message;
        if (typeof m === 'string' && m !== '')
            return m;
    }
    catch { /* 非法 JSON —— 回退原文片段 */ }
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
function scrubSecret(text, secret) {
    if (!secret || secret.length < SCRUB_MIN_SECRET_LEN)
        return text;
    return text.split(secret).join('***redacted***');
}
/**
 * 铸造 Anthropic Claude 适配器 —— 工厂函数，无状态、线程安全（每次 chat 独立请求）。
 * 构造期快照配置（options > 环境变量 > 内置缺省），之后环境变量变更不回读。
 *
 * @param config 装配配置（apiKey/fetchImpl/meter/extraHeaders 全部可注入）
 * @returns VisionProvider —— id 缺省 'anthropic'，protocol 'anthropic'，永不抛错
 */
export function createAnthropicProvider(config = {}) {
    const cfg = config ?? {};
    // ── 配置解析（构造期一次定格）──
    const providerId = nonEmptyStr(cfg.id) || nonEmptyStr(cfg.idPreset) || DEFAULT_PROVIDER_ID;
    const apiKey = nonEmptyStr(cfg.apiKey) || nonEmptyStr(process.env.ANTHROPIC_API_KEY);
    const baseUrl = (nonEmptyStr(cfg.baseUrl) ||
        nonEmptyStr(process.env.ANTHROPIC_BASE_URL) ||
        nonEmptyStr(cfg.defaultBaseUrl) ||
        DEFAULT_BASE_URL).replace(/\/+$/, '');
    const model = nonEmptyStr(cfg.model) ||
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
    function report(res) {
        if (!meter)
            return;
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
        }
        catch { /* 遥测故障静默 —— 主结果已定 */ }
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
     *   prompt 尾部追加一行 "\n\nOutput strict JSON only. 只输出严格 JSON，不要围栏。"
     *   （ΑΩ-R35 中英双语），成功后仍以
     *   extractProviderJson 剥围栏/取平衡段提取；请求体绝不出现 response_format 字段
     * - 2xx ⇒ content 数组 type==='text' 块的 text 拼接；usage.input_tokens/
     *   output_tokens → promptTokens/completionTokens
     * - 非 2xx ⇒ 错误体 {type:'error',error:{message}} 优先取 error.message，
     *   经 sanitizeError 密钥卫生后归入 error（绝不含 apiKey 值）
     * - 重试律（fetchWithRetry 唯一定义点）：429/5xx/网络错可重试；400 等 4xx
     *   立即失败；超时（AbortError）不重试
     * - 每次调用（无论成败）恰好上报一条 meter 记录，kind = `${providerId}.chat`
     */
    async function chat(req) {
        const startedAt = Date.now();
        const maxTokens = req.maxTokens ?? 2048;
        const temperature = req.temperature ?? 0.1;
        const timeoutMs = req.timeoutMs ?? 30_000;
        const maxRetries = req.maxRetries ?? 2;
        // 结束包装：补 latencyMs/model/providerId + 密钥卫生兜底（纪元 Δ-3）+ meter 上报
        //（degraded/传输失败/解析失败/成功全走此处 ⇒ 恰好一条遥测）
        const finish = (r) => {
            const res = { ...r, latencyMs: Date.now() - startedAt, model, providerId };
            if (res.error !== undefined)
                res.error = scrubSecret(res.error, apiKey);
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
            const headers = {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': apiVersion,
                ...(extraHeaders ?? {}),
            };
            // Messages API 请求体：system 顶层字段；user content = 图像块序列 + 文本块殿后。
            // ΝΩ-44（结构化输出约束解码）：构造收进闭包 —— jsonSchema 在场 ⇒ 首发即
            // tool_use 强 schema（tools:[{name:'emit', input_schema}] + tool_choice
            // 强制，prompt 不加 JSON 约定行 —— 结构化纪律由 tool_choice 承担）；
            // 缺席 ⇒ 旧负载逐字节保持（无 tools/tool_choice 键，suffix 仅随 jsonMode，
            // 零回归铁律）。
            const wantTools = req.jsonSchema !== undefined;
            const buildBody = (toolMode, withSuffix) => ({
                model,
                max_tokens: maxTokens,
                ...(req.system !== undefined && req.system !== '' ? { system: req.system } : {}),
                ...(toolMode
                    ? {
                        tools: [{
                                name: 'emit',
                                description: 'Emit the structured response for this request.',
                                input_schema: req.jsonSchema,
                            }],
                        tool_choice: { type: 'tool', name: 'emit' },
                    }
                    : {}),
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
                                text: withSuffix ? `${req.prompt}${JSON_MODE_SUFFIX}` : req.prompt,
                            },
                        ],
                    }],
            });
            let fr = await fetchWithRetry({
                doFetch,
                url: `${baseUrl}/v1/messages`,
                init: {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(buildBody(wantTools, !wantTools && req.jsonMode === true)),
                },
                maxRetries,
                timeoutMs,
            });
            // ΝΩ-44 回退（tool_use 不被网关支持）：400 类配置性失败（429/5xx 已由
            // fetchWithRetry 重试域处置，传输面失败换模式无义）⇒ 剥 tools/tool_choice、
            // prompt 尾部补 JSON 约定行重发**恰一次**（提示词后缀模式 —— 约束解码
            // 失败的诚实回退，运行层绝不抛）；重发再败按终败处置（wantTools 不变但
            // 回退只挂在这一处顺序代码上，无循环）。degradeNote 为降级注记：仅
            // jsonSchema 路径可非空，终败时并入 error 诚实归因（旧路径恒 undefined
            // ⇒ 旧 error 串逐字节不变）。
            let degradeNote;
            if (wantTools && !fr.ok && fr.failureKind === 'http' && fr.status === HTTP_STATUS_BAD_REQUEST) {
                degradeNote = 'structured tool_use rejected by gateway (HTTP 400) - fell back to prompt-suffix json mode';
                fr = await fetchWithRetry({
                    doFetch,
                    url: `${baseUrl}/v1/messages`,
                    init: {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(buildBody(false, true)),
                    },
                    maxRetries,
                    timeoutMs,
                });
            }
            // 传输终败（网络错误/超时）—— fetchWithRetry 的 error 已含尝试次数归因
            if (!fr.ok && fr.status === undefined) {
                const noted = degradeNote !== undefined ? `${fr.error} [ΝΩ-44: ${degradeNote}]` : fr.error;
                return finish({ ok: false, text: '', error: sanitizeError(noted, providerId) });
            }
            // HTTP 终败（非 2xx）—— 错误体 error.message 优先，原文片段兜底
            if (!fr.ok) {
                const status = fr.status ?? 0;
                const snippet = (fr.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
                const detail = extractErrorMessage(fr.body) ?? snippet;
                const attemptNote = fr.attempts > 1 ? ` after ${fr.attempts} attempts` : '';
                const noted = degradeNote !== undefined
                    ? `messages HTTP ${status}${attemptNote}: ${detail} [ΝΩ-44: ${degradeNote}]`
                    : `messages HTTP ${status}${attemptNote}: ${detail}`;
                return finish({
                    ok: false, text: '',
                    error: sanitizeError(noted, providerId),
                });
            }
            // 2xx —— 解析 Messages 响应体
            let body;
            try {
                body = JSON.parse(fr.body ?? '');
            }
            catch (e) {
                const m = e?.message ?? String(e);
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
            const usage = mapUsage(body.usage);
            const r = { ok: true, text };
            if (usage)
                r.usage = usage;
            // ΝΩ-44（结构化输出约束解码）：tool_use 强 schema 成功 ⇒ 首个 tool_use 块
            // 的 input（响应体里已是解析好的对象，无需剥壳）包装为文本结果
            //（JSON.stringify —— extractProviderJson 剥壳链消费面无感），对象本体透传
            // r.json（透传即核对律：不二道串解，脏值不可能 —— 来自 JSON.parse）。
            // 模型违约未出 tool_use 块（网关放行但模型自由发挥）⇒ 落回文本剥壳旧路径
            //（诚实回退，绝不抛）；json 提取门槛放行 wantTools（结构化意图在场即可，
            // 旧路径 wantTools=false ⇒ 行为逐字节不变）。
            if (wantTools) {
                const toolInput = extractToolUseInput(body);
                if (toolInput !== undefined) {
                    r.text = JSON.stringify(toolInput);
                    r.json = toolInput;
                }
            }
            if (req.jsonMode && r.json === undefined) {
                const j = extractProviderJson(r.text);
                if (j !== undefined)
                    r.json = j;
            }
            return finish(r);
        }
        catch (e) {
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
    async function chatJson(req) {
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
