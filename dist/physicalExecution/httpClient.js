import { PhysicalErrorKind } from './contracts.js';
/** http+unix:// 基址解析：socket 路径 + URL path。纯函数导出：测试面。
 *  方言：http+unix:///var/run/dsh-physical.sock/v1 —— socket 路径止于最后一个
 *  '.sock'，其后是 URL path。也兼容百分号编码方言（requests 风格：
 *  http+unix://%2Fvar%2Frun%2Fx.sock/v1 —— 先解码再按同一规则切分）。 */
export function parseUnixBaseUrl(baseUrl) {
    const m = /^http\+unix:\/\/(.+)$/i.exec(baseUrl);
    if (!m)
        return null;
    const decoded = decodeURIComponent(m[1]);
    const idx = decoded.lastIndexOf('.sock');
    if (idx < 0)
        return null;
    return {
        socketPath: decoded.slice(0, idx + '.sock'.length),
        urlPath: decoded.slice(idx + '.sock'.length) || '/',
    };
}
/** UDS dispatcher 缓存（每 socket 一个 Agent —— 连接池复用；模块级单例） */
const udsAgents = new Map();
/** 获取/铸造 UDS dispatcher（undici Agent）。不可用（非 Node undici 环境）⇒ null。 */
function udsDispatcher(socketPath) {
    let agent = udsAgents.get(socketPath);
    if (agent)
        return agent;
    try {
        // 全局 fetch 的 dispatcher 需要 undici 的 Agent —— Node 内置 fetch 自带
        // undici，但 Agent 类不全局暴露；经 fetch 自身的 undici 引用获取
        // （require('node:undici') 在内置环境不可用 —— 用 fetch.constructor?.dispatcher?
        // 兜底：Node >=18.17 全局暴露 undici 无望，但 process.binding 不可用）。
        // 现实路径：动态 require('undici')（若宿主装了独立 undici 包），或
        // Node >=20 的 fetch 直连 socketPath dispatcher 注入。此处诚实降级：
        // 尝试动态导入 undici，失败返回 null（transport_error 诚实归因）。
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const undici = globalThis.__undiciBridge ?? null;
        if (!undici?.Agent)
            return null;
        agent = new undici.Agent({ connect: { socketPath } });
        udsAgents.set(socketPath, agent);
        return agent;
    }
    catch {
        return null;
    }
}
/** O 纪元（#16）：undici 桥注入点 —— 宿主/测试可注入 { Agent } 实现。
 *  缺省自动装载：模块加载即异步 import('undici')（装了包 ⇒ 桥自通；
 *  未装 ⇒ UDS 诚实降级 transport_error）。 */
export function setUndiciBridge(bridge) {
    globalThis.__undiciBridge = bridge;
    udsAgents.clear();
}
// 缺省桥装载（旁路义务：失败静默 —— UDS 请求时按无桥诚实归因）
void import('undici').then(m => {
    if (!globalThis.__undiciBridge && m?.Agent)
        setUndiciBridge(m);
}).catch(() => { });
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
    const timeout = options.timeoutMs ?? config.defaultTimeoutMs;
    const method = options.method ?? 'POST';
    // O 纪元（#16）：UDS 基址翻译 —— http+unix://<sock>[/path] → dispatcher 传输
    const uds = parseUnixBaseUrl(config.baseUrl);
    let url = joinUrl(config.baseUrl, path);
    let dispatcher = null;
    if (uds) {
        dispatcher = udsDispatcher(uds.socketPath);
        if (!dispatcher) {
            return {
                ok: false,
                error: {
                    kind: PhysicalErrorKind.TRANSPORT_ERROR,
                    detail: `UDS transport unavailable: no undici bridge injected for ${uds.socketPath} ` +
                        '(call setUndiciBridge(require("undici")) on the host, or use http://127.0.0.1:<port>)',
                },
            };
        }
        url = `http://localhost${uds.urlPath === '/' ? '' : uds.urlPath}${path.startsWith('/') ? path : '/' + path}`;
    }
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
        // 旧 Node fallback：手动 AbortController（J 纪元：timer unref ——
        // 主路径 AbortSignal.timeout 不会阻止进程退出，fallback 不该有差别）
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeout);
        t.unref?.();
        signal = ctrl.signal;
    }
    let resp;
    try {
        resp = await fetch(url, {
            method,
            headers,
            body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
            signal,
            ...(dispatcher ? { dispatcher } : {}), // undici 扩展（#16 UDS 传输）
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
