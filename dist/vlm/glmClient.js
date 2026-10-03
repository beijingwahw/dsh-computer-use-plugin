// src/vlm/glmClient.ts
// 纪元 Ω（Ω-1 云脑皮层）：智谱 GLM-5.3-Flash 视觉大模型客户端。
// 纯视觉架构的「云脑」外接：本地反射弧（OCR/模糊/探针）处理毫秒级确定性，
// GLM 视觉模型补上开放语义（整屏理解 / 复杂推理 / 未见过的界面形态）。
//
// 纪元 Ψ（万脑归一 · 兼容壳）：本 class 升格为多协议统一层的兼容壳 ——
// platform='glm'（缺省）时原代码路径逐字节不动（错误前缀 'glm ...' /
// meter kind 'glm.chat' / GLM 环境变量语义全部保持）；platform 指向他平台
// （或 baseUrl 识别命中他平台预设）时，内部经 providers 三厂适配器
// （openai/anthropic/gemini 方言）委托实现 chat/chatJson，结果映射回
// GlmChatResult 形状（附 providerId 归因，error 用适配器串）。
// 全平台视觉模型由此点亮整套系统（ask_screen / grounding / semanticConfirm
// 兜底 / autonomy —— 消费面零改动）。
//
// 纪元 P2a（VLM 栈加固 · P2a-1 单例-池贯通）：chat/chatJson 在自身重试全败后、
// 返回 ok:false 之前咨询注入的故障切换池（attachFailoverPool —— 宿主 configureVlm
// 铸池后接线）。备脑救回 ⇒ 整流结果附 providerId 归因 + note:'failover'；池缺席
// （缺省，大多数既有测试形态）/ 空池 / 池全败 ⇒ 失败路径与返回值逐字节不变
// （零回归红律）。注入采用结构化契约而非直接 import providers/failover —— 杜绝环引。
//
// 设计铁律（与全仓一致）：
//   1. 永不抛异常 —— 一切失败以返回值 ok:false 表达（运行层零异常上抛）
//   2. 零新增依赖 —— Node 18+ 内置 fetch + AbortSignal.timeout；测试经
//      fetchImpl 注入假 fetch（绝不真实联网）
//   3. 降级诚实 —— 未配置 apiKey 时返回 degraded:true（调用方降级为
//      本地认知路径，而非崩溃）
//   4. 可观测 —— 每次调用（含重试后的最终结果）经 meter 回调上报
//   5. 缺省即兼容 —— 无新配置/新环境时行为与 Ω 纪元逐字节等同（缺省=GLM 路径）
//
// 协议：智谱开放平台 OpenAI 兼容 —— POST {baseUrl}/chat/completions，
// Bearer 鉴权，多模态 user content = [text part, image_url parts...]。
import { createAnthropicProvider } from './providers/anthropic.js';
import { createGeminiProvider } from './providers/gemini.js';
import { createOpenAiProvider } from './providers/openai.js';
import { detectPresetFromBaseUrl, detectPresetFromEnv, getPreset } from './providers/registry.js';
import { sanitizeError } from './providers/types.js';
const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_MODEL = 'glm-5.3-flash';
const METER_KIND = 'glm.chat';
/** 环境变量 apiKey 解析 —— GLM_API_KEY > ZHIPUAI_API_KEY > ZAI_API_KEY（三方历史命名兼容） */
function envApiKey() {
    return (process.env.GLM_API_KEY || process.env.ZHIPUAI_API_KEY || process.env.ZAI_API_KEY || '').trim();
}
/** 全抖动指数退避延迟 —— attempt 从 0 起：delay ∈ [0, min(500·2^attempt, 8000)) */
function jitterDelayMs(attempt) {
    const cap = Math.min(500 * 2 ** attempt, 8000);
    return Math.floor(Math.random() * cap);
}
/** 构造超时信号 —— AbortSignal.timeout 主路径 + 旧 Node AbortController 兜底
 *  （与 physicalExecution/httpClient.ts 同款：timer unref 不阻进程退出） */
function timeoutSignal(timeoutMs) {
    try {
        return AbortSignal.timeout(timeoutMs);
    }
    catch {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        t.unref?.();
        return ctrl.signal;
    }
}
/** 判超时异常 —— AbortSignal.timeout 抛 TimeoutError，手动 abort 抛 AbortError */
function isAbortError(e) {
    const name = e?.name;
    return name === 'TimeoutError' || name === 'AbortError';
}
/** 错误信息提取（网络异常的 code/message 归并，供 error 字符串） */
function errText(e) {
    const anyE = e;
    const code = anyE?.cause?.code ?? anyE?.code ?? '';
    return `${code} ${anyE?.message ?? String(e)}`.trim();
}
/** 剥 Markdown 围栏 —— ```json\n{...}\n``` → {...（仅当整体被围栏包裹时） */
function stripFences(s) {
    const m = /^```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```$/.exec(s.trim());
    return m ? m[1].trim() : s.trim();
}
/** 从文本中取首个平衡的 {...} / [...] 片段 —— 字符串感知（跳过引号内的括号
 *  与转义），返回切出的原文片段；无平衡片段返回 null。 */
function scanBalanced(s) {
    const start = s.search(/[{[]/);
    if (start < 0)
        return null;
    const open = s[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (esc)
                esc = false;
            else if (ch === '\\')
                esc = true;
            else if (ch === '"')
                inStr = false;
            continue;
        }
        if (ch === '"') {
            inStr = true;
            continue;
        }
        if (ch === open)
            depth++;
        else if (ch === close) {
            depth--;
            if (depth === 0)
                return s.slice(start, i + 1);
        }
    }
    return null;
}
/** 健壮 JSON 提取：剥 ```json 围栏 → 取首个平衡 {...}/[...] → parse。
 *  成功返回解析值（可为 null/false 等合法 JSON 值）；失败返回 undefined。 */
export function extractGlmJson(text) {
    const candidate = scanBalanced(stripFences(text));
    if (candidate === null)
        return undefined;
    try {
        return JSON.parse(candidate);
    }
    catch {
        return undefined;
    }
}
/** 响应 content 提取 —— choices[0].message.content；数组方言（parts）防御兼容 */
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
 *  至少一个为有限数才产出对象（服务端缺省 usage 时不下发空壳）。 */
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
/** 安全读响应正文 —— body 读失败（连接已断）返回空串，绝不抛 */
async function safeBodyText(resp) {
    try {
        return await resp.text();
    }
    catch {
        return '';
    }
}
// ─── 纪元 Ψ：委托路径（非 glm 平台经 providers 三厂适配器铸造） ───
/** 平台 id 归一：trim + 小写；非字符串/脏值安静归 '' */
function normalizePlatform(v) {
    try {
        return typeof v === 'string' ? v.trim().toLowerCase() : '';
    }
    catch {
        return '';
    }
}
/** 按预设 envKeys 序列取首个非空环境变量（委托路径的 apiKey env 回退） */
function platformEnvApiKey(keys) {
    for (const name of keys) {
        try {
            const v = process.env[name];
            if (typeof v === 'string' && v.trim() !== '')
                return v.trim();
        }
        catch { /* env 访问故障 —— 视为该变量未设置 */ }
    }
    return '';
}
/**
 * 铸造委托适配器 —— 按平台预设的线协议分派三厂之一（providers 单一来源）：
 *  - apiKey：options 显式 > 平台预设 envKeys 序列（GLM 环境变量不外溢到他平台）；
 *  - baseUrl/model：options 显式 > 平台预设缺省（传 default* 形态，保住适配器
 *    自身的平台 env 回退链，如 ANTHROPIC_BASE_URL/ANTHROPIC_MODEL）；
 *  - meter：ProviderMeterRecord 映射回 GlmMeterRecord（kind 透传 —— 他平台即
 *    `${platform}.chat`；适配器已保证恰好一条/调用与回调故障静默）；
 *  - 未知名平台（registry 查无）按 OpenAI 兼容 custom 端点接入（providerId 用
 *    该名，协议取 openai 方言）—— 与 registry 的 custom 合成预设同律。
 */
function castDelegate(platform, options) {
    const preset = getPreset(platform);
    const id = preset?.id ?? platform;
    const apiKey = (options.apiKey ?? '').trim() || (preset ? platformEnvApiKey(preset.envKeys) : '');
    const baseUrlOpt = (options.baseUrl ?? '').trim().replace(/\/+$/, '');
    const modelOpt = (options.model ?? '').trim();
    const config = {
        id,
        apiKey,
        ...(baseUrlOpt !== '' ? { baseUrl: baseUrlOpt } : {}),
        ...(modelOpt !== '' ? { model: modelOpt } : {}),
        ...(preset ? { defaultBaseUrl: preset.baseUrl, defaultModel: preset.defaultModel } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.meter
            ? {
                meter: (rec) => {
                    try {
                        options.meter({
                            ts: rec.ts,
                            kind: rec.kind,
                            model: rec.model,
                            latencyMs: rec.latencyMs,
                            ok: rec.ok,
                            ...(rec.promptTokens !== undefined ? { promptTokens: rec.promptTokens } : {}),
                            ...(rec.completionTokens !== undefined ? { completionTokens: rec.completionTokens } : {}),
                            ...(rec.error !== undefined ? { error: rec.error } : {}),
                        });
                    }
                    catch { /* 遥测故障静默 —— 主结果已定 */ }
                },
            }
            : {}),
    };
    switch (preset?.protocol) {
        case 'anthropic':
            return createAnthropicProvider(config);
        case 'gemini':
            return createGeminiProvider(config);
        case 'openai':
        default:
            return createOpenAiProvider(config);
    }
}
/**
 * VisionChatResult → GlmChatResult 映射 —— 委托路径的结果整流：
 * providerId 附带归因；usage/json/error/degraded 条件展开（缺场不产空壳）。
 */
function toGlmResult(res) {
    const out = {
        ok: res.ok,
        text: res.text,
        latencyMs: res.latencyMs,
        model: res.model,
        providerId: res.providerId,
        ...(res.json !== undefined ? { json: res.json } : {}),
        ...(res.usage !== undefined ? { usage: res.usage } : {}),
        ...(res.error !== undefined ? { error: res.error } : {}),
        ...(res.degraded !== undefined ? { degraded: res.degraded } : {}),
    };
    return out;
}
/** 模块级故障切换池 —— 宿主铸池后注入（vlm/index 的 configureVlm 接线）；
 *  null = 未接线（缺省 —— 单例失败路径与既往逐字节一致，零回归红律） */
let failoverPool = null;
/**
 * 注入/摘除故障切换池（P2a-1）—— 传 null 摘除；垃圾输入（非对象/无 chat 函数）
 * 安静归 null（不抛铁律）。重复调用以最后一次为准（幂等）。
 */
export function attachFailoverPool(pool) {
    failoverPool = pool && typeof pool === 'object' && typeof pool.chat === 'function' ? pool : null;
}
/** 模块级级联咨询面 —— 宿主接线注入（缺省 null = 未接线，零行为变化律） */
let cascadeFace = null;
/**
 * W2-8：注入/摘除级联咨询面 —— 传 null 摘除；垃圾输入（非对象/无 consultJson
 * 函数）安静归 null（不抛铁律）。重复调用以最后一次为准（幂等）。
 */
export function attachCascadeFace(face) {
    cascadeFace =
        face && typeof face === 'object' && typeof face.consultJson === 'function'
            ? face
            : null;
}
/**
 * W2-8：咨询级联面 —— chatJson 的最前置闸。承接 ⇒ 整流为 chatJson 形状返回；
 * 弃权/面故障 ⇒ null（主路径照走）。绝不抛。
 */
async function consultCascadeFace(req) {
    const face = cascadeFace;
    if (face === null)
        return null;
    try {
        const r = await face.consultJson(req);
        if (r === null || r === undefined)
            return null; // 弃权
        if (typeof r !== 'object')
            return null; // 敌意返回 —— 视为弃权
        const ok = r.ok === true;
        if (ok && r.value === undefined) {
            // ok:true 却无值（敌意/违约面）—— 从 raw 自行剥壳补齐；剥不出 ⇒ 弃权
            const salvaged = extractGlmJson(typeof r.raw === 'string' ? r.raw : '');
            if (salvaged === undefined)
                return null;
            return { ok: true, value: salvaged, raw: typeof r.raw === 'string' ? r.raw : '' };
        }
        return {
            ok,
            ...(ok && r.value !== undefined ? { value: r.value } : {}),
            ...(!ok && typeof r.error === 'string' && r.error !== '' ? { error: r.error } : {}),
            raw: typeof r.raw === 'string' ? r.raw : '',
        };
    }
    catch {
        return null; // 咨询面故障 ⇒ 弃权（不抛铁律）
    }
}
/**
 * 咨询故障切换池（P2a-1）—— 单例自身重试全败后的备脑切换面：
 *  - 池缺席 / 空池（size ≤ 0）/ size 读取抛错 ⇒ null（调用方走原失败路径，逐字节不变）；
 *  - 池按序全败（ok:false）或违约上抛 ⇒ null（保留主脑失败现场 —— 不用池的失败覆盖归因）；
 *  - 池救回（ok:true）⇒ 整流回 GlmChatResult 形状：providerId 标注备脑来源、
 *    note:'failover'、latencyMs/model 取备脑自报值；计量由池内适配器自报
 *    （铸造路径即 vlmMeterTap —— 主脑失败一条 + 备脑成功一条，各记各的诚实账，
 *    本函数不重复上报）。
 */
async function consultFailoverPool(req) {
    const pool = failoverPool;
    if (!pool)
        return null;
    let size = 0;
    try {
        size = Number(pool.size);
    }
    catch {
        return null; // 敌意 getter —— 视为不可咨询
    }
    if (!Number.isFinite(size) || size <= 0)
        return null;
    try {
        const res = await pool.chat(req);
        if (!res || res.ok !== true)
            return null; // 池全败 ⇒ 原失败路径
        const r = res;
        const out = toGlmResult({
            ok: true,
            text: typeof r.text === 'string' ? r.text : '',
            latencyMs: Number.isFinite(r.latencyMs) ? r.latencyMs : 0,
            model: typeof r.model === 'string' && r.model !== '' ? r.model : 'failover',
            providerId: typeof r.providerId === 'string' && r.providerId !== '' ? r.providerId : 'failover',
            ...(r.json !== undefined ? { json: r.json } : {}),
            ...(r.usage !== undefined ? { usage: r.usage } : {}),
        });
        out.note = 'failover';
        return out;
    }
    catch {
        return null; // 池违约上抛 —— 收敛为原失败路径（不抛铁律）
    }
}
/**
 * GLM 视觉对话客户端 —— 无状态、线程安全（每次 chat 独立请求）。
 * 构造期快照配置（options > 环境变量），之后环境变量变更不回读 ——
 * 想重读环境请 reset 单例后重建（测试依赖此确定性）。
 *
 * 纪元 Ψ 兼容壳：平台解析「options.platform 显式 > baseUrl 识别命中非 glm
 * 预设 > 缺省 'glm'」。'glm' ⇒ 原生路径（Ω 纪元行为逐字节等同）；他平台 ⇒
 * 内部经 providers 适配器委托实现（chat/chatJson），结果整流回本类契约形状。
 */
export class GlmClient {
    apiKey;
    baseUrl;
    model;
    fetchImpl;
    meter;
    /** 生效平台 id（'glm' 或委托平台；探测/报告面消费） */
    platformId;
    /** 委托适配器 —— 非 glm 平台时非空；glm 路径恒 null */
    delegate;
    constructor(options = {}) {
        // 平台解析（纪元 Ψ）：显式 platform > baseUrl 识别命中非 glm > 缺省 'glm'
        let platform = normalizePlatform(options.platform);
        if (platform === '') {
            const hinted = detectPresetFromBaseUrl((options.baseUrl ?? '').trim());
            if (hinted !== null && hinted.id !== 'glm')
                platform = hinted.id;
        }
        this.platformId = platform === '' ? 'glm' : platform;
        if (this.platformId !== 'glm') {
            // 委托路径：配置经平台预设解析（apiKey 的 env 回退用平台自己的 envKeys）
            this.delegate = castDelegate(this.platformId, options);
            this.apiKey = '';
            this.baseUrl = '';
            this.model = '';
        }
        else {
            // 原生 GLM 路径 —— 配置解析优先级：构造 options > 环境变量 > 内置缺省
            this.delegate = null;
            this.apiKey = (options.apiKey ?? envApiKey()).trim();
            this.baseUrl = (options.baseUrl ?? process.env.GLM_BASE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
            this.model = (options.model ?? process.env.GLM_VLM_MODEL ?? DEFAULT_MODEL).trim();
        }
        this.fetchImpl = options.fetchImpl;
        this.meter = options.meter;
    }
    /** apiKey 是否已配置（未配置 ⇒ chat 走 degraded 降级臂；本地平台由适配器判定） */
    get configured() {
        return this.delegate !== null ? this.delegate.configured === true : this.apiKey.length > 0;
    }
    /** 生效平台 id —— 'glm' 或委托平台（vlm_platforms 报告面消费） */
    get platform() {
        return this.platformId;
    }
    /** meter 上报 —— 回调自身抛错不得影响主路径（不抛铁律的最后一块拼图） */
    report(res) {
        if (!this.meter)
            return;
        try {
            this.meter({
                ts: Date.now(),
                kind: METER_KIND,
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
     * - 429/5xx/网络错误 ⇒ 全抖动指数退避重试（默认 2 次）；超时不重试
     * - 成功 ⇒ text + usage + latencyMs；jsonMode 下附 json（提取失败仅缺省字段）
     * - 每次调用（无论成败）恰好上报一条 meter 记录
     */
    async chat(req) {
        // 委托路径（纪元 Ψ）：全权交平台适配器（重试律/降级律/meter/密键卫生皆其自管），
        // 壳层只整流结果形状；适配器违约上抛在此收敛（不抛铁律的最后一块拼图）。
        // P2a-1：委托路径自身重试全败后同样咨询池 —— 池救回 ⇒ 备脑结果；池缺席/全败
        // ⇒ 原失败结果逐字段不变（零回归红律）。
        if (this.delegate !== null) {
            let res;
            try {
                res = toGlmResult(await this.delegate.chat(req));
            }
            catch (e) {
                res = {
                    ok: false, text: '', latencyMs: 0,
                    model: this.delegate.model, providerId: this.delegate.id,
                    error: sanitizeError(e, this.delegate.id),
                };
            }
            if (res.ok)
                return res;
            return (await consultFailoverPool(req)) ?? res;
        }
        const startedAt = Date.now();
        const maxTokens = req.maxTokens ?? 2048;
        const temperature = req.temperature ?? 0.1;
        const timeoutMs = req.timeoutMs ?? 30_000;
        const maxRetries = req.maxRetries ?? 2;
        // 结束包装：补 latencyMs/model + meter 上报（含 degraded/失败臂）
        const finish = (r) => {
            const res = { ...r, latencyMs: Date.now() - startedAt, model: this.model };
            this.report(res);
            return res;
        };
        // 失败收尾（P2a-1）：先按原路径产出失败结果（meter 照报 —— 主脑失败是真实事件，
        // 不因备脑救回而抹账），再咨询故障切换池；救回 ⇒ 整流备脑成功结果（note
        // 'failover'），池缺席/空池/全败 ⇒ 原失败结果逐字段不变（零回归红律）。
        const fail = async (r) => {
            const res = finish(r);
            return (await consultFailoverPool(req)) ?? res;
        };
        if (!this.configured) {
            return fail({
                ok: false, text: '', degraded: true,
                error: 'glm api key not configured (set GLM_API_KEY / ZHIPUAI_API_KEY / ZAI_API_KEY or pass options.apiKey)',
            });
        }
        const doFetch = this.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
        if (!doFetch) {
            return fail({ ok: false, text: '', error: 'fetch is not available (Node >= 18 required)' });
        }
        // OpenAI 兼容多模态消息：system（可选）在前，user = 文本 + 图片序列
        const messages = [];
        if (req.system !== undefined && req.system !== '')
            messages.push({ role: 'system', content: req.system });
        messages.push({
            role: 'user',
            content: [
                { type: 'text', text: req.prompt },
                ...req.images.map(img => ({
                    type: 'image_url',
                    image_url: { url: `data:${img.mime ?? 'image/jpeg'};base64,${img.base64}` },
                })),
            ],
        });
        const payload = {
            model: this.model,
            messages,
            max_tokens: maxTokens,
            temperature,
            ...(req.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        };
        const url = `${this.baseUrl}/chat/completions`;
        let attempt = 0; // 已完成的重试次数
        for (;;) {
            let resp;
            try {
                resp = await doFetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${this.apiKey}`,
                    },
                    body: JSON.stringify(payload),
                    signal: timeoutSignal(timeoutMs),
                });
            }
            catch (e) {
                // 超时：调用方主动止损 —— 不重试，立即诚实归因
                if (isAbortError(e)) {
                    return fail({ ok: false, text: '', error: `glm request aborted after ${timeoutMs}ms` });
                }
                // 网络错误（连接拒绝 / DNS / 断流）：可重试
                if (attempt < maxRetries) {
                    await sleep(jitterDelayMs(attempt));
                    attempt++;
                    continue;
                }
                return fail({ ok: false, text: '', error: `glm fetch failed after ${attempt + 1} attempts: ${errText(e)}` });
            }
            if (resp.ok) {
                let body;
                try {
                    body = await resp.json();
                }
                catch (e) {
                    return fail({ ok: false, text: '', error: `glm response JSON parse failed: ${errText(e)}` });
                }
                const content = extractContent(body);
                if (content === null) {
                    return fail({ ok: false, text: '', error: 'glm response missing choices[0].message.content' });
                }
                const usage = mapUsage(body.usage);
                const r = { ok: true, text: content };
                if (usage)
                    r.usage = usage;
                if (req.jsonMode) {
                    const j = extractGlmJson(content);
                    if (j !== undefined)
                        r.json = j;
                }
                return finish(r);
            }
            // 非 2xx：429/5xx 可重试，其余 4xx 立即失败（请求本身有病，重试无义）
            const retryable = resp.status === 429 || resp.status >= 500;
            if (retryable && attempt < maxRetries) {
                await safeBodyText(resp); // 排干 body 再退避（连接复用礼貌）
                await sleep(jitterDelayMs(attempt));
                attempt++;
                continue;
            }
            const raw = (await safeBodyText(resp)).replace(/\s+/g, ' ').trim().slice(0, 300);
            // 密钥卫生律（纪元 Ψ 终审补刀）：错误体可能回显 apiKey，一律替换后才能进入 error/meter
            const snippet = this.apiKey ? raw.split(this.apiKey).join('[REDACTED]') : raw;
            return fail({
                ok: false, text: '',
                error: `glm chat/completions HTTP ${resp.status}${attempt > 0 ? ` after ${attempt + 1} attempts` : ''}: ${snippet}`,
            });
        }
    }
    /**
     * 结构化对话 —— 强制 jsonMode，对回复做健壮 JSON 提取
     * （剥 ```json 围栏 → 首个平衡 {...}/[...] → parse）。
     * 成功：{ ok:true, value, raw }；失败：{ ok:false, error, raw } —— raw 恒为
     * 模型回复原文（成功也是），调用方可落日志/回退解析。
     */
    async chatJson(req) {
        // W2-8（C2 成本级联路由）：结构化路径最先咨询级联面 —— 承接 ⇒ 直接整流返回
        // （便宜档过检直采 / 升级主力重做）；弃权/未接线/面故障 ⇒ null ⇒ 主路径照走
        // （缺省未接线时本段恒不改变任何返回值 —— 零行为变化律）。
        const cascaded = await consultCascadeFace(req);
        if (cascaded !== null)
            return cascaded;
        // 委托路径（纪元 Ψ）：适配器自带的 jsonMode 强制 + 剥壳提取（error 用适配器串）。
        // P2a-1：委托 jsonMode 全败 ⇒ 咨询池（与 chat 同咨询律）；救回且可剥壳 ⇒ 备脑值，
        // 池缺席/全败/剥壳失败 ⇒ 原失败结果逐字段不变（零回归红律）。
        if (this.delegate !== null) {
            let res;
            try {
                res = await this.delegate.chatJson(req);
            }
            catch (e) {
                res = { ok: false, error: sanitizeError(e, this.delegate.id), raw: '' };
            }
            if (res.ok)
                return res;
            const saved = await consultFailoverPool({ ...req, jsonMode: true });
            if (saved) {
                const value = extractGlmJson(saved.text);
                if (value !== undefined)
                    return { ok: true, value: value, raw: saved.text };
            }
            return res;
        }
        const res = await this.chat({ ...req, jsonMode: true });
        if (!res.ok) {
            return { ok: false, error: res.error, raw: res.text };
        }
        const value = extractGlmJson(res.text);
        if (value === undefined) {
            return {
                ok: false,
                error: `glm json extraction failed: no balanced JSON object/array in reply (${res.text.length} chars)`,
                raw: res.text,
            };
        }
        return { ok: true, value: value, raw: res.text };
    }
}
/** sleep Promise —— 退避专用 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
// ─── 模块级单例 ───
let singleton = null;
/** options 是否携带平台线索（apiKey/baseUrl/model/platform 任一非空）——
 *  无线索时才启用 env 平台自动识别（缺省解析增强的触发条件） */
function hasPlatformHint(o) {
    return [o.platform, o.apiKey, o.baseUrl, o.model].some(v => typeof v === 'string' && v.trim() !== '');
}
/**
 * 缺省铸造（纪元 Ψ 增强）：options 全空（无平台线索）时 ——
 *   1. GLM envs（GLM/ZHIPUAI/ZAI 任一）在场 ⇒ 现状 glm 路径（构造器自读，逐字节等同）；
 *   2. 否则 detectPresetFromEnv() 命中他平台 ⇒ 以该平台铸造（apiKey 经其 envKeys
 *      解析、baseUrl/model 取预设缺省；GLM_BASE_URL/GLM_VLM_MODEL 语义保持 glm 专属）；
 *   3. 都无 ⇒ 现状（glm 缺省 ⇒ 未配置降级臂）。
 * options 携带任一平台线索 ⇒ 直接 new GlmClient(options)（构造器平台解析自管）。
 * fetchImpl/meter 等注入面在任何分支都原样透传。
 */
function mintSingleton(options) {
    const o = options ?? {};
    if (hasPlatformHint(o))
        return new GlmClient(o);
    if (envApiKey() !== '')
        return new GlmClient(o); // GLM envs 在场 ⇒ 现状 glm 路径
    const hit = detectPresetFromEnv();
    if (hit !== null && hit.id !== 'glm') {
        return new GlmClient({ ...o, platform: hit.id }); // apiKey 由委托路径按平台 envKeys 自解析
    }
    return new GlmClient(o);
}
/** 获取模块级单例 —— options 仅首次（或 resetGlmClient 后）生效。
 *  测试之间请先 resetGlmClient() 再带新 options 取用。 */
export function getGlmClient(options) {
    if (!singleton)
        singleton = mintSingleton(options);
    return singleton;
}
/**
 * 探测云脑可用性 —— 不落地单例（避免先探测后带 options 取用时被空单例占位）。
 *
 * 纪元 Ψ 语义升格：本哨兵原意为「GLM 可用」，现为「任一云脑可用」——
 * tools/index.ts 的 ask_screen 挂载门与 src/index.ts 的提示词注入门以此判定，
 * 全平台视觉模型都应点亮整套系统。判定序（短路）：
 *   1. GLM envs（GLM/ZHIPUAI/ZAI 任一非空）⇒ true；
 *   2. 已铸造单例且其 configured ⇒ true；
 *   3. 否则 detectPresetFromEnv() 命中任一平台（含 glm）⇒ true；
 *   4. 都无 ⇒ false（与 getGlmClient 缺省解析保持一致 —— 探测真则缺省铸造可用）。
 */
export function isGlmConfigured() {
    if (envApiKey() !== '')
        return true;
    if (singleton && singleton.configured)
        return true;
    return detectPresetFromEnv() !== null;
}
/**
 * 只读窥探当前生效平台 —— 与 getGlmClient 缺省解析同律推演，绝不铸造单例
 * （探测只读律；vlm_platforms 报告面消费）。
 * 返回 { platform, configured, minted }：minted = 是否已有单例落地。
 */
export function peekGlmPlatform() {
    if (singleton) {
        return { platform: singleton.platform, configured: singleton.configured, minted: true };
    }
    if (envApiKey() !== '')
        return { platform: 'glm', configured: true, minted: false };
    const hit = detectPresetFromEnv();
    if (hit !== null)
        return { platform: hit.id, configured: true, minted: false };
    return { platform: 'glm', configured: false, minted: false };
}
/** 重置单例 —— 下次 getGlmClient 用新 options / 重读环境变量。 */
export function resetGlmClient() {
    singleton = null;
}
