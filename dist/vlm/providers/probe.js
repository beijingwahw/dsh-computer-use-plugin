// src/vlm/providers/probe.ts
// 纪元 Ψ（Ψ-7 万脑归一）：探针与模型发现 —— 各平台体检（能不能通/有哪些视觉模型可用）。
import { fetchWithRetry, sanitizeError } from './types.js';
import { getSharp } from '../../_legacyDeps.js';
/** 探针超时缺省 —— 比正式调用（30s）更急：一次不通就快速让位 */
const PROBE_TIMEOUT_MS = 15_000;
/** 探针的回复预算 —— 只需要一句「ok」，8 token 足矣 */
const PROBE_MAX_TOKENS = 8;
/**
 * 「模型明确拒绝/不支持图像」的拒绝语义模式族（ΑΩ-R8 收紧）—— 仅命中才判
 * visionGuessed:false。旧判据 /unsupport|not support|image/i 裸匹配 "image" 一词，
 * 正常视觉回复（"The image shows a red button"）即被误杀。
 *
 * 边界取舍（ΑΩ-R8）：拿不准 ⇒ 不命中 ⇒ 判 true（保守信任视觉能力）——
 * 误杀真视觉模型的代价（整条视觉链路被错误降级）高于漏判一个纯文本脑
 * （后续真调用自然暴露），与项目「宁可不确定不可乱判」的降级方向一致。
 * 故本族只收录明确拒绝形态（cannot process / does not support /
 * image inputs are not supported / unsupported / 只能处理文本 等），
 * 模糊表述（如 "I don't see text"、"I am a language model"）一律放行。
 */
const UNSUPPORTED_HINT_RE = new RegExp([
    // —— 英文拒绝语义 ——
    // ① 助动词否定 + 能力动词："This model does not support vision" / "don't accept images"
    String.raw `(?:don['’]?t|doesn['’]?t|didn['’]?t|do\s+not|does\s+not|did\s+not)\s+(?:currently\s+|directly\s+|yet\s+)?(?:support|accept|process|handle|understand|recogni[sz]e)`,
    // ② cannot/can't + 感知/处理动词："I cannot process image inputs" / "I can't see any image"
    String.raw `(?:cannot|can\s+not|can['’]?t)\s+(?:currently\s+)?(?:see|view|accept|process|handle|interpret|understand|recogni[sz]e|display|receive|access)`,
    // ③ (not) able to + 动词："unable to process images" / "not able to view"
    String.raw `(?:unable|not\s+able)\s+to\s+(?:see|view|accept|process|handle|support|interpret|understand|recogni[sz]e|display|receive|access)`,
    // ④ image(s)/vision/… (input(s)) not supported："image inputs are not supported"
    String.raw `(?:images?|photos?|pictures?|vision|visual|multimodal)\s+(?:inputs?\s+)?(?:(?:are|is)\s+)?not\s+(?:supported|allowed|accepted|enabled)`,
    // ⑤ 缩写否定 + supported 族："images aren't supported" / "vision isn't allowed"
    String.raw `(?:aren['’]?t|isn['’]?t)\s+(?:supported|allowed|accepted|enabled)`,
    // ⑥ unsupport* 词族（API 错误风）："unsupported content type" / "unsupported for vision requests"
    String.raw `\bunsupport`,
    // ⑦ 纯文本域自述："only supports text" / "can only process text" / "text-only model"
    String.raw `only\s+(?:supports?|handles?|accepts?|processes?|understands?)\s+(?:plain\s+)?text`,
    String.raw `can\s+only\s+(?:process|handle|accept|understand|generate|work(?:\s+with)?)\s+(?:plain\s+)?text`,
    String.raw `text[-\s]?(?:only|based)\s+(?:model|assistant|ai|input|mode)`,
    // —— 中文拒绝语义 ——
    // ⑧ 「不支持…图像/图片/视觉/输入」："当前模型不支持图像输入"
    String.raw `不\s*支持[^。！？]{0,12}?(?:图像|图片|视觉|多模态|输入|image|vision|photo)`,
    // ⑨ 「无法/不能 + 处理/查看…（图像）」："抱歉，我无法处理 image。"
    String.raw `(?:无法|不能|没法)(?:查看|看到|识别|处理|解析|理解|接收|接受|读取|显示)`,
    String.raw `(?:无法|不能|没法)[\s,，、]{0,3}(?:图像|图片|视觉|image|photo|picture)`,
    // ⑩ 「只能/仅支持…文本」："我只能处理文本" / "仅支持文本输入"
    String.raw `(?:只能|仅能|只可以|仅支持|只支持)[^。！？]{0,6}?(?:文本|text)`,
].join('|'), 'i');
/** 模型发现超时缺省 */
const DISCOVER_TIMEOUT_MS = 10_000;
// ─── 密钥卫生（detail/error 面的本地兜底；供应方已 sanitize 过，此处纵深防御） ───
/**
 * 错误摘要整形：空白折叠 + Bearer/前缀形密钥打码 + 截 120 字。
 * 任何一步故障都保持上一轮结果 —— 绝不抛异常。
 */
function redactDetail(text) {
    let s = '';
    try {
        s = String(text ?? '').replace(/\s+/g, ' ').trim();
    }
    catch {
        return '';
    }
    try {
        s = s.replace(/(bearer\s+)[^\s"',;]+/gi, '$1[REDACTED]');
    }
    catch { /* 保持上一轮 */ }
    try {
        s = s.replace(/\b(?:sk|gsk|xai|rk|r8|hf)[_-][a-z0-9][a-z0-9_-]{7,}/gi, '[REDACTED]');
    }
    catch { /* 保持上一轮 */ }
    return s.slice(0, 120);
}
/**
 * 失败归因 —— 把供应方的 error 串翻成一句中文：
 * 超时（fetchWithRetry 的 'aborted after' 族）/ HTTP 状态（'http 401'/'HTTP 401' 族）/
 * 其余错误摘要。入参为空串 ⇒ 「供应方未给出原因」。
 */
function classifyFailure(errText, timeoutMs) {
    const e = redactDetail(errText);
    if (e === '')
        return '失败：供应方未给出原因';
    if (/aborted after|timeouterror|etimedout/i.test(e))
        return `超时（> ${timeoutMs}ms）：${e}`;
    const m = /\bhttps?\s+(\d{3})\b/i.exec(e);
    if (m)
        return `失败（HTTP ${m[1]}）：${e}`;
    return `失败：${e}`;
}
// ─── 1x1 白图（sharp 现场生成 JPEG，模块级缓存） ───
let whitePixelPromise = null;
/** sharp 现场铸造 1x1 白色 JPEG 的 base64（裸 base64，无 data: 前缀） */
async function buildWhitePixelJpeg() {
    // sharp 纪律（纪元 Δ-5）：废弃原生依赖统一经 src/_legacyDeps.ts 懒加载
    //（模块缓存 + 迁移错误消息 + DSH_FORCE_LEGACY_DEPS 回退开关）——
    // 不再直连 import('sharp') 绕过纪律面。
    const sharpFn = await getSharp();
    const buf = await sharpFn({
        create: { width: 1, height: 1, channels: 3, background: '#ffffff' },
    }).jpeg().toBuffer();
    return Buffer.from(buf).toString('base64');
}
/** 取 1x1 白图 base64 —— 并发探测共享同一份缓存；失败不缓存（下次可重试） */
function whitePixelJpeg() {
    if (whitePixelPromise === null) {
        whitePixelPromise = buildWhitePixelJpeg().catch(err => {
            whitePixelPromise = null;
            throw err;
        });
    }
    return whitePixelPromise;
}
// ─── probeProvider：单脑体检 ───
/**
 * 探测一个视觉供应方 —— 永不抛异常。
 *
 * - provider 未 configured（缺 apiKey 等）⇒
 *   `{ ok:false, latencyMs:0, detail:'未配置密钥', visionGuessed:false }` —— 零网络
 * - 已配置 ⇒ 发一张 1x1 白图（sharp 现场生成 JPEG）+ prompt「回复 ok」
 *   （maxTokens 8 / maxRetries 0 —— 探针不重试，一次不通就快速让位），latency 记测
 * - ok 判定：chat 结果 ok 且 text 非空
 * - visionGuessed 判定：结果 text 不命中 UNSUPPORTED_HINT_RE 拒绝语义族
 *   （ΑΩ-R8：仅明确拒绝形态（"cannot process image inputs" 等）才判 false；
 *   正常视觉回复含 "image" 一词不算拒绝 —— 拿不准 ⇒ true 保守信任视觉能力）
 * - detail 一句中文（通了/未配置/超时/HTTP 状态/错误摘要），经密钥卫生兜底 —— 绝不泄 key
 *
 * @param provider 任意兄弟适配器铸造出的 VisionProvider（或测试桩）
 * @param opts.timeoutMs 探测超时 —— 缺省 15000（探针比正式调用更急）
 */
export async function probeProvider(provider, opts) {
    const timeoutMs = opts?.timeoutMs ?? PROBE_TIMEOUT_MS;
    let pid = 'provider';
    try {
        pid = String(provider?.id ?? 'provider') || 'provider';
    }
    catch { /* 保持 'provider' */ }
    if (provider === null || provider === undefined || typeof provider.chat !== 'function') {
        return { id: pid, ok: false, latencyMs: 0, detail: 'provider 对象不合法（缺少 chat 方法）', visionGuessed: false };
    }
    let configured = false;
    try {
        configured = provider.configured === true;
    }
    catch { /* 脏值视为未配置 */ }
    if (!configured) {
        return { id: pid, ok: false, latencyMs: 0, detail: '未配置密钥', visionGuessed: false };
    }
    const startedAt = Date.now();
    try {
        const base64 = await whitePixelJpeg();
        const res = await provider.chat({
            images: [{ base64, mime: 'image/jpeg' }],
            prompt: '回复 ok',
            maxTokens: PROBE_MAX_TOKENS,
            timeoutMs,
            maxRetries: 0,
        });
        const latencyMs = Date.now() - startedAt;
        const text = typeof res?.text === 'string' ? res.text : '';
        if (res?.ok === true && text.trim() !== '') {
            return {
                id: pid,
                ok: true,
                latencyMs,
                detail: `通了：${latencyMs}ms 回复「${redactDetail(text).slice(0, 40)}」`,
                visionGuessed: !UNSUPPORTED_HINT_RE.test(text),
            };
        }
        if (res?.ok === true) {
            return { id: pid, ok: false, latencyMs, detail: '通了但回复为空（无法判定视觉性）', visionGuessed: false };
        }
        if (res?.degraded === true) {
            // configured 快照与 chat 实况竞态（理论边界）—— 仍按未配置归因
            return { id: pid, ok: false, latencyMs, detail: '未配置密钥', visionGuessed: false };
        }
        const errText = typeof res?.error === 'string' ? res.error : '';
        return { id: pid, ok: false, latencyMs, detail: classifyFailure(errText, timeoutMs), visionGuessed: false };
    }
    catch (e) {
        // 不抛铁律兜底：sharp 故障 / provider.chat 抛错都在此收敛为 ok:false
        return {
            id: pid,
            ok: false,
            latencyMs: Date.now() - startedAt,
            detail: `探测异常：${redactDetail(sanitizeError(e, pid))}`,
            visionGuessed: false,
        };
    }
}
/**
 * 列模型接口的鉴权头（按方言）：
 * openai ⇒ `Authorization: Bearer`；anthropic ⇒ `x-api-key` + `anthropic-version:
 * 2023-06-01`；gemini ⇒ `x-goog-api-key`。apiKey 为空 ⇒ 无鉴权头
 * （本地无 key 的 baseUrl 免 Bearer —— 空头徒扰 Ollama 们）。
 */
function authHeaders(protocol, apiKey) {
    if (apiKey === '')
        return {};
    if (protocol === 'anthropic') {
        return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    }
    if (protocol === 'gemini') {
        return { 'x-goog-api-key': apiKey };
    }
    return { Authorization: `Bearer ${apiKey}` };
}
/**
 * 列模型 URL（按方言，尾斜杠已归一的 base）：
 * openai ⇒ `{base}/models`；anthropic ⇒ `{base}/v1/models`（base 已以 /v1 结尾则
 * 不重复追加）；gemini ⇒ `{base}/v1beta/models`（同理免 /v1beta 重复）。
 */
function modelListUrl(protocol, base) {
    if (protocol === 'anthropic') {
        return /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
    }
    if (protocol === 'gemini') {
        return /\/v1beta$/.test(base) ? `${base}/models` : `${base}/v1beta/models`;
    }
    return `${base}/models`;
}
/**
 * 响应解析（按方言）：
 * openai/anthropic ⇒ `data[].id`（openai 另取 `owned_by` → ownedBy）；
 * gemini ⇒ `models[].name` 剥 'models/' 前缀。
 * 容器字段非数组 ⇒ null（诚实失败）；无 id/name 的脏条目静默跳过。
 */
function extractModels(protocol, body) {
    if (protocol === 'gemini') {
        const arr = body?.models;
        if (!Array.isArray(arr))
            return null;
        const out = [];
        for (const m of arr) {
            const name = m?.name;
            if (typeof name !== 'string' || name === '')
                continue;
            const id = name.replace(/^models\//, '');
            if (id === '')
                continue;
            out.push({ id });
        }
        return out;
    }
    const arr = body?.data;
    if (!Array.isArray(arr))
        return null;
    const out = [];
    for (const m of arr) {
        const id = m?.id;
        if (typeof id !== 'string' || id === '')
            continue;
        const owned = m?.owned_by;
        out.push(typeof owned === 'string' && owned !== '' ? { id, ownedBy: owned } : { id });
    }
    return out;
}
/** 单协议形态的一次列模型尝试 —— 任何故障都归约为 { ok:false, error }，绝不抛 */
async function listModelsOnce(args) {
    const { base, apiKey, protocol, fetchImpl, timeoutMs } = args;
    const tag = `${protocol} 模型列表`;
    try {
        const doFetch = typeof fetchImpl === 'function' ? fetchImpl
            : typeof fetch === 'function' ? fetch
                : undefined;
        if (!doFetch)
            return { ok: false, error: `${tag}：fetch 不可用（Node >= 18）` }; // doctor-exempt: 文案字符串，非阈值比较（W6-2）
        const headers = { Accept: 'application/json', ...authHeaders(protocol, apiKey) };
        const fr = await fetchWithRetry({
            doFetch,
            url: modelListUrl(protocol, base),
            init: { method: 'GET', headers },
            maxRetries: 0, // 发现是尽力而为 —— 不退避重试
            timeoutMs,
        });
        if (!fr.ok) {
            const st = typeof fr.status === 'number' ? ` HTTP ${fr.status}` : '';
            return { ok: false, error: redactDetail(`${tag}请求失败${st}：${fr.error ?? ''}`) };
        }
        let body;
        try {
            body = JSON.parse(fr.body ?? '');
        }
        catch {
            return { ok: false, error: `${tag}响应不是合法 JSON` };
        }
        const models = extractModels(protocol, body);
        if (models === null) {
            const field = protocol === 'gemini' ? 'models' : 'data';
            return { ok: false, error: `${tag}响应缺少 ${field} 数组` };
        }
        return { ok: true, models };
    }
    catch (e) {
        return { ok: false, error: redactDetail(sanitizeError(e, 'discover')) };
    }
}
/**
 * 模型发现 —— 对一个服务基址列出可用模型，三协议尽力而为，永不抛异常。
 *
 * 方言形状（JSDoc 契约）：
 *  - openai     ⇒ GET `{base}/models`（`Authorization: Bearer`；取 `data[].id` 与
 *    `data[].owned_by`）
 *  - anthropic  ⇒ GET `{base}/v1/models`（`x-api-key` + `anthropic-version:
 *    2023-06-01`；取 `data[].id`）
 *  - gemini     ⇒ GET `{base}/v1beta/models`（`x-goog-api-key`；取
 *    `models[].name` 并剥 'models/' 前缀）
 *  - 协议未指明 ⇒ 先试 openai 形态，不通再依次试 anthropic / gemini 形态
 *    （首个成功者胜出 —— 兼容网关常混杂多方言）
 *  - 失败 / 非 2xx / 解析异常 ⇒ `{ ok:false, models:[] }`（error 为中文摘要，
 *    经密钥卫生 —— 绝不泄 key）
 *  - 本地无 key 的 baseUrl 免 Bearer/鉴权头（Ollama/vLLM/LM Studio 直连）
 *
 * @returns ok:true 时 models 按服务端顺序（可为空数组 —— 服务端合法返回空表）
 */
export async function discoverModels(opts) {
    try {
        const base = String(opts?.baseUrl ?? '').trim().replace(/\/+$/, '');
        if (base === '')
            return { ok: false, models: [], error: 'baseUrl 为空，无从发现模型' };
        const apiKey = String(opts?.apiKey ?? '').trim();
        const timeoutMs = opts?.timeoutMs ?? DISCOVER_TIMEOUT_MS;
        const fetchImpl = typeof opts?.fetchImpl === 'function' ? opts.fetchImpl : undefined;
        const attempts = opts?.protocol
            ? [opts.protocol]
            : ['openai', 'anthropic', 'gemini'];
        let lastError = '';
        for (const protocol of attempts) {
            const r = await listModelsOnce({ base, apiKey, protocol, fetchImpl, timeoutMs });
            if (r.ok)
                return { ok: true, models: r.models };
            lastError = r.error;
        }
        return { ok: false, models: [], error: lastError !== '' ? lastError : '模型发现失败（原因未知）' };
    }
    catch (e) {
        // 不抛铁律兜底（理论不可达）
        return { ok: false, models: [], error: redactDetail(sanitizeError(e, 'discover')) };
    }
}
// W6-2（doctor smell.over-engineering 清偿）：平台预设视图已分区提取至 probe.presets.ts
// （行为零变化）；导入面不变 —— 再分发。
import { PLATFORM_PRESETS, firstEnv, castPlatformProvider } from './probe.presets.js';
export { PLATFORM_PRESETS } from './probe.presets.js';
// ─── probeAllPlatforms：万脑总体检 ───
/**
 * 单平台探测任务（纪元 Δ-2 空模型发现路径的执行体）—— 永不抛：
 *  - model 非空（预设/环境给了缺省模型）⇒ 直接铸 provider 探测（原行为）；
 *  - model 为空（LM Studio/vLLM 形态，defaultModel:''）⇒ 先 discoverModels
 *    （协议已知 —— 单方言一次尝试）取服务端首个模型再探；发现失败或空表 ⇒
 *    如实报「无可用模型」（附失败摘要），绝不拿编造模型名撞出假 404。
 */
async function probeOnePreset(args) {
    const { preset, apiKey, baseUrl, model, fetchImpl } = args;
    const startedAt = Date.now();
    try {
        let effModel = model;
        if (effModel === '') {
            const disc = await discoverModels({
                baseUrl,
                ...(apiKey !== '' ? { apiKey } : {}),
                protocol: preset.protocol,
                ...(fetchImpl ? { fetchImpl } : {}),
            });
            if (!disc.ok || disc.models.length === 0) {
                const why = disc.ok
                    ? '服务端模型列表为空'
                    : `模型发现失败（${redactDetail(disc.error ?? '原因未知')}）`;
                return {
                    id: preset.id,
                    ok: false,
                    latencyMs: Date.now() - startedAt,
                    detail: `无可用模型：${why}`,
                    visionGuessed: false,
                    label: preset.label,
                    baseUrl,
                };
            }
            effModel = disc.models[0].id;
        }
        const provider = castPlatformProvider({ preset, apiKey, baseUrl, model: effModel, fetchImpl });
        return { ...(await probeProvider(provider)), label: preset.label, baseUrl };
    }
    catch (e) {
        // 不抛铁律兜底（discoverModels/probeProvider 自身皆不抛 —— 理论不可达）
        return {
            id: preset.id,
            ok: false,
            latencyMs: Date.now() - startedAt,
            detail: `探测异常：${redactDetail(sanitizeError(e, preset.id))}`,
            visionGuessed: false,
            label: preset.label,
            baseUrl,
        };
    }
}
/**
 * 遍历 PLATFORM_PRESETS 做全平台体检 —— 并行 Promise.all，永不抛异常。
 *
 * - 云端平台：env 放了 key（envKeys 首个非空者）才探，否则跳过（零网络零噪音）
 * - 本地平台（Ollama/LM Studio/vLLM，localAuthOptional）：无 key 也探
 *   （127.0.0.1 直连免鉴权）；includeLocal=false（缺省 true）时全部跳过
 * - 基址/模型可被 envBase/envModel 环境变量覆盖
 * - 空缺省模型平台（Δ-2）：先模型发现（GET {base}/models 等，按预设协议）取
 *   首个模型再探；发现失败 ⇒ detail 如实报「无可用模型」，不发假模型探测请求
 * - 返回数组只含被探测的平台，每条附 label 与实际 baseUrl；
 *   单平台失败不影响其余（probeOnePreset 自身收敛，Promise.all 不炸）
 *
 * @param opts.fetchImpl 注入 fetch —— 测试全离线；缺省走各 provider 的全局 fetch
 * @param opts.includeLocal 是否探本地三平台 —— 缺省 true
 */
export async function probeAllPlatforms(opts) {
    const includeLocal = opts?.includeLocal ?? true;
    const fetchImpl = opts?.fetchImpl;
    try {
        const tasks = [];
        for (const preset of PLATFORM_PRESETS) {
            const isLocal = preset.localAuthOptional === true;
            if (isLocal && !includeLocal)
                continue;
            const apiKey = firstEnv(preset.envKeys ?? []);
            if (!isLocal && apiKey === '')
                continue;
            const baseUrl = (firstEnv(preset.envBase ? [preset.envBase] : []) || preset.baseUrl).trim() || preset.baseUrl;
            const model = firstEnv(preset.envModel ? [preset.envModel] : []) || preset.model || '';
            tasks.push(probeOnePreset({ preset, apiKey, baseUrl, model, fetchImpl }));
        }
        return await Promise.all(tasks);
    }
    catch {
        // 不抛铁律兜底（理论不可达 —— preset 表静态合法）
        return [];
    }
}
