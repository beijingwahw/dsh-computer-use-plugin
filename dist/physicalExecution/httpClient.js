import { PhysicalErrorKind } from './contracts.js';
/**
 * 异常诚实的 HTTP 调用 —— 永不抛错。
 *
 * 返回值：``MicroResponse<T> | PhysicalError`` ——
 *   - 成功响应 200 + body.status='success' → ``MicroSuccess``
 *   - 成功响应 200 + body.status='failure' → ``MicroFailure``（Python 端业务失败）
 *   - 网络错误 / 超时 / 非 200 → ``PhysicalError``（传输层失败）
 *
 * 调用方据此分支处理：``MicroSuccess`` 走业务路径；其余转 Result 失败臂。
 */
export async function microFetch(config, path, options = {}) {
    const url = joinUrl(config.baseUrl, path);
    const timeout = options.timeoutMs ?? config.defaultTimeoutMs;
    const method = options.method ?? 'POST';
    // 构造请求头
    const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(config.headers?.() ?? {}),
        ...(options.extraHeaders ?? {}),
    };
    // AbortSignal.timeout —— Node 18+ 原生支持
    let signal;
    try {
        signal = AbortSignal.timeout(timeout);
    }
    catch {
        // 旧 Node fallback：手动 AbortController
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), timeout);
        signal = ctrl.signal;
    }
    let resp;
    try {
        resp = await fetch(url, {
            method,
            headers,
            body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
            signal,
        });
    }
    catch (e) {
        // 区分超时 vs 网络错误
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
            return {
                ok: false,
                error: {
                    kind: PhysicalErrorKind.CLIENT_TIMEOUT,
                    detail: `fetch ${method} ${path} aborted after ${timeout}ms: ${e.message}`,
                },
            };
        }
        // fetch 错误：连接拒绝 / DNS / 网络断开 / UDS 文件不存在
        const code = e?.cause?.code ?? e?.code ?? 'UNKNOWN';
        return {
            ok: false,
            error: {
                kind: PhysicalErrorKind.TRANSPORT_ERROR,
                detail: `fetch ${method} ${path} failed: ${code} ${e.message}`,
            },
        };
    }
    // HTTP 状态检查 —— Python 端铁律恒 200；非 200 即传输层异常
    if (!resp.ok) {
        let bodyText = '';
        try {
            bodyText = await resp.text();
        }
        catch {
            // body 读失败 → 无能为力，记空串
        }
        return {
            ok: false,
            error: {
                kind: PhysicalErrorKind.TRANSPORT_ERROR,
                detail: `HTTP ${resp.status} ${resp.statusText} for ${method} ${path}: ${bodyText.slice(0, 500)}`,
            },
        };
    }
    // 解析 JSON body
    let bodyJson;
    try {
        bodyJson = await resp.json();
    }
    catch (e) {
        return {
            ok: false,
            error: {
                kind: PhysicalErrorKind.TRANSPORT_ERROR,
                detail: `response JSON parse failed for ${method} ${path}: ${e.message}`,
            },
        };
    }
    // 校验响应信封（MicroResponse 结构）
    if (!bodyJson || typeof bodyJson !== 'object') {
        return {
            ok: false,
            error: {
                kind: PhysicalErrorKind.INTERNAL_ERROR,
                detail: `response is not an object: ${JSON.stringify(bodyJson).slice(0, 200)}`,
            },
        };
    }
    const obj = bodyJson;
    if (obj.status !== 'success' && obj.status !== 'failure') {
        return {
            ok: false,
            error: {
                kind: PhysicalErrorKind.INTERNAL_ERROR,
                detail: `response.status missing or invalid: ${obj.status ?? 'undefined'}`,
            },
        };
    }
    return { ok: true, response: bodyJson };
}
/** 拼接 URL —— 处理 baseUrl 末尾 / 与 path 开头 / 的去重 */
function joinUrl(base, path) {
    // UDS URL 形如：http+unix:///var/run/dsh-physical.sock
    // TCP URL 形如：http://127.0.0.1:8421
    if (base.endsWith('/')) {
        return base.slice(0, -1) + (path.startsWith('/') ? path : '/' + path);
    }
    return base + (path.startsWith('/') ? path : '/' + path);
}
