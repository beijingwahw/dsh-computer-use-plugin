// src/physicalExecution/httpClient.ts
// D-5 HTTP 客户端 —— fetch + AbortController 超时 + Result 包装。
//
// 零阻塞铁律（造物主契约 Step 1 §3）：
//   - Node 端调用 Python 微服务必须使用异步 HTTP 请求
//   - 严格受 D-7 PipelineConfig.attemptTimeoutMs 中的 timeout 控制
//   - 超时绝不抛异常上抛到 D-7 ExecutionStation（运行层永不抛错）
//
// 异常诚实（造物主契约 Step 1 §3）：
//   - 网络错误 / DNS 失败 / 连接拒绝 → ``transport_error``（D-5 host-error 路径）
//   - AbortController 超时 → ``client_timeout``（D-7 timeout 路径）
//   - Python 端返回的失败信封 → 透传 ``error.kind`` 字段
//   - HTTP 401（Python 端认证失败自 200 改 401，错误信封 JSON 结构不变）→
//     ``unauthorized`` —— 与密钥/时钟偏移相关的客户端侧可修问题，区别于
//     传输层异常（transport_error）与服务内部错误（5xx 仍是 transport_error 归因）
//
// 防重放配套（W6R-A6）：本模块是 Node → Python 的统一请求入口 —— 每个请求
// 自动携带 X-Request-Id（crypto.randomUUID()），缺席才注入、在场不覆盖
// （adapter 的 buildAuthHeadersSync 用 mintNonce() 提供的值优先）。Python 端
// 将 X-Request-Id 作强制 nonce 校验（缺失即 401），覆盖面 = 所有 microFetch
// 调用点（enableAuth=false 的诊断路径、health 探活、业务端点一视同仁）。
//
// Node 18+ 内置 fetch + AbortSignal.timeout（无外部依赖）
// O 纪元（#16）：UDS 基址 http+unix:// 合法化。
// ΑΩ-R3：UDS 传输全兑现 —— 修半兑现实坏点：全局 fetch **忽略** init.dispatcher
// （仅 undici 自家 fetch 认它），旧实现只传 dispatcher 给全局 fetch ⇒ 无宿主桥时
// UDS 请求一律 transport_error。现改为：宿主桥（setUndiciBridge）最优先，缺省
// 懒加载 npm undici（本项目 runtime 依赖），用 undici.fetch + Agent({
// connections, connect: { socketPath } }) 专用连接池传输；undici 不可用时
// 诚实降级 transport_error（detail 归因 undici-unavailable），绝不静默走 TCP。
import { randomUUID } from 'node:crypto';
import { PhysicalErrorKind } from './contracts.js';
/** http+unix:// 基址解析：socket 路径 + URL path。纯函数导出：测试面。
 *  方言：http+unix:///var/run/dsh-physical.sock/v1 —— socket 路径止于最后一个
 *  '.sock'，其后是 URL path。也兼容百分号编码方言（requests 风格：
 *  http+unix://%2Fvar%2Frun%2Fx.sock/v1 —— 先解码再按同一规则切分）。 */
export function parseUnixBaseUrl(baseUrl) {
    const m = /^http\+unix:\/\/(.+)$/i.exec(baseUrl);
    if (!m)
        return null;
    let decoded;
    try {
        decoded = decodeURIComponent(m[1]);
    }
    catch {
        return null; // 畸形百分号序列：不可解析即非 UDS 基址（microFetch 永不抛契约）
    }
    const idx = decoded.lastIndexOf('.sock');
    if (idx < 0)
        return null;
    return {
        socketPath: decoded.slice(0, idx + '.sock'.length),
        urlPath: decoded.slice(idx + '.sock'.length) || '/',
    };
}
const udsAgents = new Map();
/** ΑΩ-R3：UDS 池单 socket 连接上限 —— 同 socket 并发请求复用同一池不炸连接；
 *  undici 缺省无上限，此处显式封顶（本机微服务场景 64 绰绰有余）。 */
const UDS_AGENT_CONNECTIONS = 64;
/** ΝΩ-27：UDS 池空闲回收 TTL —— 无请求（且无在飞）持续此时长即 close+逐出。 */
const UDS_AGENT_IDLE_TTL_MS = 60_000;
/** best-effort 关闭单个 Agent —— close 失败/抛错皆吞（运行层零阻塞铁律）。 */
function bestEffortCloseAgent(agent) {
    try {
        const closing = agent.close?.();
        if (closing && typeof closing.catch === 'function')
            closing.catch(() => { });
    }
    catch { /* 同步抛错也吞 */ }
}
/** ΝΩ-27：（重）布防某 socket 的空闲 TTL 计时器 —— 请求时刷新即调用本函数；
 *  到期时在飞 >0 ⇒ 顺延一整个 TTL（不能关在役池），否则回收。 */
function armIdleTimer(socketPath) {
    const entry = udsAgents.get(socketPath);
    if (!entry)
        return;
    if (entry.timer)
        clearTimeout(entry.timer);
    const t = setTimeout(() => {
        const cur = udsAgents.get(socketPath);
        if (!cur || cur !== entry)
            return; // 已被失效/清桥路径处理：此处不动
        if (cur.inFlight > 0) {
            armIdleTimer(socketPath); // 在飞：顺延（计时器模式复用 —— 重布防）
            return;
        }
        udsAgents.delete(socketPath);
        bestEffortCloseAgent(entry.agent);
    }, UDS_AGENT_IDLE_TTL_MS);
    t.unref?.();
    entry.timer = t;
}
/** ΝΩ-27：失效重建 —— 传输层失败后对该 socketPath 的池立即 close+逐出，
 *  下一次请求用新 Agent 重拨（服务可能已换 socket 路径重启）。 */
function invalidateUdsAgent(socketPath) {
    const entry = udsAgents.get(socketPath);
    if (!entry)
        return;
    udsAgents.delete(socketPath);
    if (entry.timer)
        clearTimeout(entry.timer);
    bestEffortCloseAgent(entry.agent);
}
/** ΑΩ-R3：缺省 undici 懒加载缓存 —— import('undici') 成败各缓存一次
 *  （失败缓存后续请求不再重复导入；成功走 ESM 模块缓存本就只装一次）。 */
let lazyCarrier;
function loadUndici() {
    if (!lazyCarrier) {
        // undici 是本项目 runtime 依赖；宿主环境未装/损坏 ⇒ reject ⇒ 缓存 null
        // （旁路义务：导入失败静默缓存，UDS 请求时按不可用诚实归因）
        lazyCarrier = import('undici').then((m) => {
            const Agent = m.Agent;
            const udsFetch = m.fetch;
            if (typeof Agent !== 'function' || typeof udsFetch !== 'function')
                return null;
            return { Agent: Agent, fetch: udsFetch };
        }, () => null);
    }
    return lazyCarrier;
}
/** ΑΩ-R3：载面解析 —— 宿主桥最优先（字段级覆盖：只给 Agent 或只给 fetch 也成立，
 *  缺的半边由缺省 undici 补齐）；桥缺席 ⇒ 懒加载 npm undici；
 *  桥 === false ⇒ 宿主明示 undici 不可用（禁懒加载）。不可用 ⇒ null。 */
async function resolveUndici() {
    const injected = globalThis.__undiciBridge;
    if (injected === false)
        return null;
    const bridge = injected && typeof injected === 'object' ? injected : null;
    if (bridge && (typeof bridge.Agent === 'function' || typeof bridge.fetch === 'function')) {
        const base = typeof bridge.Agent === 'function' && typeof bridge.fetch === 'function'
            ? null
            : await loadUndici();
        const Agent = typeof bridge.Agent === 'function' ? bridge.Agent : base?.Agent;
        const udsFetch = typeof bridge.fetch === 'function' ? bridge.fetch : base?.fetch;
        return Agent && udsFetch ? { Agent, fetch: udsFetch } : null;
    }
    const loaded = await loadUndici();
    return loaded?.Agent && loaded?.fetch ? { Agent: loaded.Agent, fetch: loaded.fetch } : null;
}
/** ΑΩ-R3：UDS 请求面 —— { agent（按 socketPath 池化复用）, fetch, release }。
 *  不可用 ⇒ null。ΝΩ-27：acquire 即 inFlight+1 并刷新空闲 TTL；请求结束后
 *  调用 release 归还计数（microFetch 的 fetch finally 统一收口）。 */
async function udsTransport(socketPath) {
    const carrier = await resolveUndici();
    if (!carrier)
        return null;
    let entry = udsAgents.get(socketPath);
    if (!entry) {
        entry = {
            agent: new carrier.Agent({ connections: UDS_AGENT_CONNECTIONS, connect: { socketPath } }),
            timer: null,
            inFlight: 0,
        };
        udsAgents.set(socketPath, entry);
    }
    entry.inFlight += 1;
    armIdleTimer(socketPath); // 请求时刷新：距最近请求重新计 60s
    let released = false;
    return {
        agent: entry.agent,
        fetch: carrier.fetch,
        release: () => {
            if (released)
                return; // 幂等防御（microFetch 单点调用，双调不增负）
            released = true;
            entry.inFlight = Math.max(0, entry.inFlight - 1);
        },
    };
}
/** ΑΩ-R3：best-effort 关闭全部 UDS 池（桥更换时调用）—— close 失败/抛错皆吞
 *  （运行层零阻塞铁律），只保证不再复用旧桥的池。ΝΩ-27：一并拆 TTL 计时器。 */
function closeAgents() {
    for (const entry of udsAgents.values()) {
        if (entry.timer)
            clearTimeout(entry.timer);
        bestEffortCloseAgent(entry.agent);
    }
    udsAgents.clear();
}
/** HTTP 401 Unauthorized：Python 端认证失败的信号位（HMAC 密钥两端不一致、
 *  Cap Token 过期、X-Request-Id nonce 重放或本机时钟偏移 —— 客户端侧可修）。
 *  是 unauthorized 与 transport_error 的分流判据，具名以脱离「裸状态码」面。 */
const HTTP_STATUS_UNAUTHORIZED = 401;
/** O 纪元（#16）→ ΑΩ-R3：undici 桥注入点 —— 宿主/测试可注入 { Agent, fetch }
 *  全量或半量（半量 = 字段级覆盖，缺的半边由缺省 undici 补齐；桥最优先）。
 *  null = 撤销注入（回到缺省懒加载 npm undici 路径）；
 *  false = 宿主明示 undici 不可用（UDS 诚实降级 transport_error，绝不静默走 TCP）。
 *  换桥/清桥时旧桥建池被 best-effort 关闭。 */
export function setUndiciBridge(bridge) {
    globalThis.__undiciBridge = bridge;
    closeAgents();
}
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
    // O 纪元（#16）+ ΑΩ-R3：UDS 基址翻译 —— http+unix://<sock>[/path] ⇒
    // undici.fetch + Agent(socketPath) dispatcher 传输（全局 fetch 不认 dispatcher）
    const uds = parseUnixBaseUrl(config.baseUrl);
    let url = joinUrl(config.baseUrl, path);
    let fetchFn = fetch; // TCP 主路径仍走全局 fetch（零回归）
    let dispatcher = null;
    let udsRelease;
    if (uds) {
        const transport = await udsTransport(uds.socketPath);
        if (!transport) {
            return {
                ok: false,
                error: {
                    kind: PhysicalErrorKind.TRANSPORT_ERROR,
                    detail: `undici-unavailable: UDS fetch for ${uds.socketPath} needs undici ` +
                        '(dynamic import(\'undici\') failed, or host disabled it via setUndiciBridge(false)); ' +
                        'install the undici runtime dependency, inject setUndiciBridge({ Agent, fetch }), ' +
                        'or use http://127.0.0.1:<port> — never silently falling back to TCP',
                },
            };
        }
        dispatcher = transport.agent;
        fetchFn = transport.fetch;
        udsRelease = transport.release;
        // 与 joinUrl 同律：基址 path 尾斜杠去重（'…sock/v1/' + '/exec' 不得拼出 '//exec'）
        const basePath = uds.urlPath === '/' ? '' : uds.urlPath.replace(/\/+$/, '');
        url = `http://localhost${basePath}${path.startsWith('/') ? path : '/' + path}`;
    }
    // 构造请求头
    // 防重放配套：X-Request-Id 缺席才注入（randomUUID），在场不覆盖 ——
    // adapter 鉴权路径经 headers 回调提供的 mintNonce() 优先（同一契约，同随机器）。
    // 注意 headers 对象大小写敏感合并：HTTP 头本应不区分大小写，但此处三个来源
    // （缺省/回调/extra）都是本模块与 adapter 自家代码，约定统一用 'X-Request-Id'
    // 拼写 ⇒ 直接判 in 即可，无需大小写折叠扫描。
    const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(config.headers?.() ?? {}),
        ...(options.extraHeaders ?? {}),
    };
    if (!('X-Request-Id' in headers) || !headers['X-Request-Id']) {
        headers['X-Request-Id'] = randomUUID();
    }
    // AbortSignal.timeout —— Node 18+ 原生支持；外部止损信号在场时手动组合
    //（Node 18 无 AbortSignal.any）：外部 abort 或内部超时任一触发即断流
    let signal;
    let cleanupComposed;
    const external = options.signal instanceof AbortSignal ? options.signal : undefined;
    if (external) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeout);
        t.unref?.();
        const onAbort = () => ctrl.abort();
        if (external.aborted)
            ctrl.abort();
        else
            external.addEventListener('abort', onAbort, { once: true });
        cleanupComposed = () => {
            clearTimeout(t);
            external.removeEventListener('abort', onAbort);
        };
        signal = ctrl.signal;
    }
    else {
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
    }
    let resp;
    try {
        // TCP ⇒ 全局 fetch；UDS ⇒ undici 方言 fetch（认 init.dispatcher，ΑΩ-R3）。
        // 超时/中止/错误分类对所有传输走同一 catch（语义零回归）。
        resp = await fetchFn(url, {
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
        // ΝΩ-27：传输层失败 ⇒ 该 socketPath 的池立即失效重建（旧池可能握着
        // 死 socket 的陈旧连接；服务换路径重启后旧路径池永不可用）。仅网络级
        // 抛错走此分支 —— HTTP 5xx（resp.ok=false）不失效：服务还活着且应答了。
        if (uds)
            invalidateUdsAgent(uds.socketPath);
        return {
            ok: false,
            error: {
                kind: PhysicalErrorKind.TRANSPORT_ERROR,
                detail: `fetch ${method} ${path} failed: ${code} ${e.message}`,
            },
        };
    }
    finally {
        // 组合信号的定时器/监听器随 fetch 结束（成功/失败皆然）拆除 ——
        // 长命外部 signal 上不留残听（body 读取阶段无需 signal：abort 只断传输本身）
        if (cleanupComposed)
            cleanupComposed();
        // ΝΩ-27：UDS 池在飞计数归还（成功/失败/失效重建皆然 —— 失效后 entry 已
        // 出 map，此处的 -1 落在孤儿 entry 上，无害）
        udsRelease?.();
    }
    // HTTP 状态检查 —— Python 端认证失败以 401 如实表达（错误信封 JSON 结构不变）；
    // 其余非 2xx 仍按传输层异常归因（服务崩溃 / 代理干预 / 协议漂移）
    if (!resp.ok) {
        let bodyText = '';
        try {
            bodyText = await resp.text();
        }
        catch {
            // body 读失败 → 无能为力，记空串
        }
        // 401 识别：认证失败 ⇒ unauthorized（客户端侧可修），与密钥/时钟偏移相关。
        // 错误信封结构不变（{status:'failure', error:{kind, detail}}）⇒ 尽力解析
        // 透传 Python 端给出的具体 reason；解析失败退回原文截断。
        if (resp.status === HTTP_STATUS_UNAUTHORIZED) {
            let envelopeKind = '';
            let envelopeDetail = '';
            try {
                const parsed = JSON.parse(bodyText);
                if (typeof parsed?.error?.detail === 'string')
                    envelopeDetail = parsed.error.detail;
                if (typeof parsed?.error?.kind === 'string')
                    envelopeKind = parsed.error.kind;
            }
            catch { /* 非 JSON 信封：用原文 */ }
            const reason = envelopeDetail || bodyText.slice(0, 500) || resp.statusText || 'no body';
            return {
                ok: false,
                error: {
                    kind: PhysicalErrorKind.UNAUTHORIZED,
                    detail: `HTTP 401 Unauthorized for ${method} ${path}: ${reason}` +
                        ' — 属密钥/时钟偏移类问题（HMAC 密钥两端不一致、Cap Token 过期或本机' +
                        '时钟偏移超出 TTL 窗、X-Request-Id nonce 重放）；不是服务内部错误' +
                        '（那类故障不会以 401 表达）' + (envelopeKind ? `（服务端 kind=${envelopeKind}）` : ''),
                },
            };
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
