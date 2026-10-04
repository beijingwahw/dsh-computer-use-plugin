// src/vlm/providers/types.ts
// 纪元 Ψ（Ψ-1 万脑归一）：全平台视觉模型统一契约 —— 协议类型 + 共享原语。
//
// 本文件是 Ψ 纪元的宪法石碑：所有兄弟适配器（openai / anthropic / gemini …）
// 一字不差地依赖这里的接口与工具函数。因此本模块：
//   1. 零兄弟依赖 —— 不 import 任何兄弟适配器（杜绝环引）；唯一依赖是同为
//      零依赖叶子的 internalUtils（W6R-A4 工具去重：stripFences / scanBalanced /
//      传输小件 / 状态常量收拢为单一实现，叶子链不可能成环）
//   2. 永不抛异常 —— 一切失败以返回值 ok:false / undefined 表达（与 glmClient 同律）
//   3. 密钥卫生 —— 错误串化面绝不泄漏 apiKey 值（sanitizeError 强制剔除）
//   4. 行为基调继承 Ω-1（glmClient）：degraded 降级律 / JSON 剥壳律 /
//      全抖动指数退避（500·2^n 封顶 8s，仅 429/5xx/网络错可重试，超时不重试）
//
// 适配器实现 VisionProvider 接口；registry（Ψ-2+）按 ProviderOptions 装配。
import { extractBalancedJson, HTTP_STATUS_SERVER_ERROR_FLOOR, HTTP_STATUS_TOO_MANY_REQUESTS, isAbortError, safeBodyText, sleep, timeoutSignal, } from '../internalUtils.js';
// ─── JSON 剥壳律（W6R-A4：单一实现收拢于 internalUtils.extractBalancedJson，
//     本导出名保留为消费面兼容的薄委托 —— 与 glmClient.extractGlmJson 同源同律） ───
/**
 * 健壮 JSON 提取（JSON 剥壳律）：剥 ```json 围栏 → 取首个平衡 {...}/[...] → parse。
 * 成功返回解析值（可为 null/false 等合法 JSON 值）；失败返回 undefined。
 * 永不抛异常 —— 入参为 null/undefined 等脏值同样安静返回 undefined。
 */
export function extractProviderJson(text) {
    return extractBalancedJson(text);
}
// ─── 图像 data URL ───
/**
 * 拼 data URL：`data:${mime};base64,${base64}`（mime 缺省/空串回退 'image/jpeg'）。
 * 纯字符串拼接，绝不抛异常。
 */
export function buildDataUrl(img) {
    const rawMime = img?.mime;
    const mime = typeof rawMime === 'string' && rawMime !== '' ? rawMime : 'image/jpeg';
    return `data:${mime};base64,${img?.base64 ?? ''}`;
}
// ─── 密钥卫生律：错误串化 ───
/** 密钥占位符 —— 一切被识别的凭据片段统一替换为此串 */
const REDACTED = '[REDACTED]';
/** 敏感模式与替换式（密钥卫生律的执行面，依次全量应用）：
 *  1. Bearer 令牌值；2. 常见前缀形密钥（sk-/gsk_/AIza…）；3. 键值对形
 *  （api_key=… / "apiKey":"…" / ?key=… / Authorization: …）。宁可错杀一百
 *  （误伤普通词），不可放过一个密钥 —— 错误面丢了细节无损，泄了密钥致命。 */
const SECRET_PATTERNS = [
    { re: /(bearer\s+)[^\s"',;]+/gi, repl: `$1${REDACTED}` },
    { re: /\b(?:sk|gsk|xai|rk|r8|hf)[_-][a-z0-9][a-z0-9_-]{7,}/gi, repl: REDACTED },
    { re: /\baiza[a-z0-9_-]{10,}\b/gi, repl: REDACTED },
    {
        re: /(^|[^a-z0-9_-])((?:api[-_]?key|access[-_]?token|auth[-_]?token|authorization|secret|password|token|key)["']?[ \t]*[:=][ \t]*)(?:"[^"]*"|'[^']*'|[^\s,;&>]+)/gi,
        repl: `$1$2${REDACTED}`,
    },
];
/** 对已串化的错误文本做密钥剔除 —— 任一模式故障不影响其余（不抛铁律） */
function redactSecrets(s) {
    let out = s;
    for (const { re, repl } of SECRET_PATTERNS) {
        try {
            out = out.replace(re, repl);
        }
        catch { /* 理论不可达 —— 保持上一轮结果 */ }
    }
    return out;
}
/** 错误串化（不安全面）：null/undefined → ''；Error → `code message`（cause.code
 *  归并，glmClient.errText 同律）；无 message 的裸对象 → JSON 序列化兜底；
 *  一切兜底皆 try/catch —— 绝不抛。 */
function stringifyError(err) {
    try {
        if (err === null || err === undefined)
            return '';
        if (typeof err === 'string')
            return err;
        if (typeof err !== 'object') {
            try {
                return String(err);
            }
            catch {
                return '';
            } // symbol 等原始值
        }
        const e = err;
        let msg = typeof e.message === 'string' ? e.message : '';
        if (msg === '') {
            // 无 message 的裸对象（如 { apiKey }）：JSON 序列化兜底（环引用/BigInt 吞掉）
            try {
                const j = JSON.stringify(err);
                if (typeof j === 'string' && j !== '' && j !== '{}')
                    msg = j;
            }
            catch { /* 留给 toString 兜底 */ }
        }
        if (msg === '') {
            try {
                const s = String(err);
                if (s !== '' && s !== '[object Object]')
                    msg = s;
            }
            catch {
                return '';
            }
        }
        const codeOf = (v) => (typeof v === 'string' || typeof v === 'number') && String(v) !== '' ? String(v) : '';
        const code = codeOf(e.cause?.code) || codeOf(e.code);
        return `${code} ${msg}`.trim();
    }
    catch {
        return '';
    }
}
/**
 * 错误安全串化（密钥卫生律 + 截断律）：
 *  - 输出恒为 `${providerId} ...` 前缀形态；无可用信息时 `${providerId} unknown error`
 *  - 正文（前缀之外）截 300 字、空白折叠为单空格
 *  - 绝不包含 apiKey 值：Bearer/前缀形/键值对形凭据一律替换 [REDACTED]
 *  - 绝不抛异常 —— err 为任何脏值（含抛错 toString 的对象）都安静产出字符串
 */
export function sanitizeError(err, providerId) {
    let pid = 'provider';
    try {
        const s = String(providerId ?? '').trim();
        if (s !== '')
            pid = s;
    }
    catch { /* 保持 'provider' */ }
    let body;
    try {
        body = redactSecrets(stringifyError(err)).replace(/\s+/g, ' ').trim().slice(0, 300);
    }
    catch {
        body = '';
    }
    return body === '' ? `${pid} unknown error` : `${pid} ${body}`;
}
// ─── 基址判别 ───
/**
 * W8-A6（D-G3 baseUrl 暴露的打码纪律）：端点脱敏 —— 展示面（日志/UI/遥测）
 * 输出 provider.baseUrl 前必须经过本函数（参照 sanitizeError/maskKey 的纪律：
 * 值可以丢细节，不可以泄凭据）。规则：
 *  - host（含端口、IPv6 方括号形态）保留 —— 归因与排障需要「哪台端点」
 *    （同平台不同端点的判别面恰好只剩 host 也够用）；
 *  - 路径 / 查询串 / userinfo 一律打码为 `/***` —— 路径可能嵌端点 ID/租户段
 *    （如方舟 ep-2024xxxx），查询可能带 ?key= 密钥（Gemini 方言），userinfo
 *    本身就是凭据。协议与 host 之外的任何原文绝不外泄；
 *  - 脏值（空串/非 URL/非字符串/解析故障）⇒ 安静返回 '(unknown endpoint)'
 *    （不抛、不回显原文 —— 宁可丢展示，不可泄端点细节）。
 * 绝不抛异常；输出恒可安全落日志。
 */
export function maskBaseUrl(raw) {
    try {
        const s = typeof raw === 'string' ? raw.trim() : '';
        if (s === '')
            return '(unknown endpoint)';
        const u = new URL(s);
        // u.host 已归一小写、含端口与 IPv6 方括号、且天然不含 userinfo 凭据
        if (u.host === '')
            return '(unknown endpoint)';
        return `${u.protocol}//${u.host}/***`;
    }
    catch {
        return '(unknown endpoint)';
    }
}
/** 本机回环主机集合（小写、去 IPv6 方括号后比对） */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
/**
 * 判基址是否指向本机：host 为 127.0.0.1 / localhost / ::1 ⇒ true。
 * URL 解析失败（脏值/相对串）⇒ 安静返回 false（不抛）；'localhost.evil.com'
 * 等后缀仿冒不匹配（整 host 精确比对）。
 */
export function isLocalBaseUrl(url) {
    try {
        const u = new URL(String(url ?? ''));
        const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        return LOCAL_HOSTS.has(host);
    }
    catch {
        return false;
    }
}
// ─── 退避与重试 ───
// W6-2（doctor smell.magic-number 清偿）：可重试 HTTP 状态域常量与传输小件
// （sleep/timeoutSignal/isAbortError/safeBodyText）已收拢 internalUtils 单一
// 实现（W6R-A4 去重）—— 本文件顶部 import，此处不再各持拷贝。
/**
 * 全抖动指数退避延迟 —— uniform(0, min(capMs, baseMs·2^attempt))，默认 500/8000。
 * 入参脏值（负/非有限）安静钳到安全域；上限恒不为负 —— 返回值总在 [0, ceiling)。
 */
export function jitterDelayMs(attempt, baseMs = 500, capMs = 8000) {
    const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 500;
    const cap = Number.isFinite(capMs) && capMs > 0 ? capMs : 8000;
    const a = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
    let ceiling;
    try {
        ceiling = Math.min(cap, base * 2 ** a);
    }
    catch {
        ceiling = 0;
    }
    if (!Number.isFinite(ceiling) || ceiling <= 0)
        return 0;
    return Math.floor(Math.random() * ceiling);
}
/**
 * 带重试的 fetch（全适配器共享的传输底座 —— 重试律的唯一定义点）：
 *  - 仅 429/5xx/网络异常可重试；AbortError/TimeoutError（超时止损）不重试
 *  - 每次重试前回调 onRetry(attempt, reason)（attempt 为刚失败尝试的 0 起序号，
 *    与 jitterDelayMs 同参；回调自身抛错被吞 —— 不抛铁律）
 *  - 每次尝试注入独立的超时 AbortSignal（覆盖 init.signal；timeoutMs 归此函数管）
 *  - 重试间隔 = jitterDelayMs(attempt)（全抖动 500·2^n 封顶 8s）
 *  - 成功（2xx）⇒ { ok:true, status, body, attempts }
 *  - HTTP 终败 ⇒ { ok:false, status, body, error:'http <s> after <n> attempts', attempts }
 *  - 传输终败 ⇒ { ok:false, error:'fetch failed after <n> attempts: ...', attempts }
 *  - 超时/中止 ⇒ { ok:false, error:'request aborted after <timeoutMs>ms', attempts }
 *  attempts 恒为实际发出的 fetch 次数（1 = 未重试）；绝不抛异常。
 */
export async function fetchWithRetry(opts) {
    try {
        const doFetch = typeof opts?.doFetch === 'function' ? opts.doFetch : undefined;
        if (!doFetch) {
            return { ok: false, error: 'fetch is not available (Node >= 18 required)', attempts: 0 }; // doctor-exempt: 文案字符串，非阈值比较（W6-2）
        }
        let url;
        try {
            url = typeof opts.url === 'string' ? opts.url : String(opts.url ?? '');
        }
        catch {
            url = '';
        }
        let init;
        try {
            init = { ...(opts.init ?? {}) };
        }
        catch {
            init = {};
        }
        const rawRetries = Number(opts.maxRetries);
        const maxRetries = Number.isFinite(rawRetries) ? Math.max(0, Math.floor(rawRetries)) : 0;
        const rawTimeout = Number(opts.timeoutMs);
        const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 30_000;
        const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : undefined;
        let attempt = 0; // 已失败尝试的 0 起序号（jitter 与 onRetry 共用）
        for (;;) {
            let resp;
            try {
                resp = await doFetch(url, { ...init, signal: timeoutSignal(timeoutMs) });
            }
            catch (e) {
                // 超时：调用方主动止损 —— 不重试，立即诚实归因
                if (isAbortError(e)) {
                    return { ok: false, error: `request aborted after ${timeoutMs}ms`, attempts: attempt + 1 };
                }
                // 网络错误（连接拒绝 / DNS / 断流）：可重试
                if (attempt < maxRetries) {
                    safeNotify(onRetry, attempt, `network: ${stringifyError(e).slice(0, 120)}`);
                    await sleep(jitterDelayMs(attempt));
                    attempt++;
                    continue;
                }
                return {
                    ok: false,
                    error: `fetch failed after ${attempt + 1} attempts: ${stringifyError(e).slice(0, 300)}`,
                    attempts: attempt + 1,
                };
            }
            if (resp && resp.ok) {
                return { ok: true, status: resp.status, body: await safeBodyText(resp), attempts: attempt + 1 };
            }
            // 非 2xx：429/5xx 可重试，其余 4xx 立即失败（请求本身有病，重试无义）
            const status = typeof resp?.status === 'number' ? resp.status : 0;
            const retryable = status === HTTP_STATUS_TOO_MANY_REQUESTS || status >= HTTP_STATUS_SERVER_ERROR_FLOOR;
            if (retryable && attempt < maxRetries) {
                await safeBodyText(resp); // 排干 body 再退避（连接复用礼貌）
                safeNotify(onRetry, attempt, `http ${status}`);
                await sleep(jitterDelayMs(attempt));
                attempt++;
                continue;
            }
            const n = attempt + 1;
            return {
                ok: false,
                status,
                body: await safeBodyText(resp),
                error: `http ${status} after ${n} attempt${n > 1 ? 's' : ''}`,
                attempts: n,
            };
        }
    }
    catch (e) {
        // 不抛铁律的最终兜底（理论不可达 —— init 展开等同步面故障）
        return { ok: false, error: `fetchWithRetry internal error: ${stringifyError(e).slice(0, 200)}`, attempts: 1 };
    }
}
/** onRetry 安全回调 —— 回调自身抛错不得影响主路径 */
function safeNotify(onRetry, attempt, reason) {
    if (!onRetry)
        return;
    try {
        onRetry(attempt, reason);
    }
    catch { /* 遥测故障静默 —— 主流程已定 */ }
}
