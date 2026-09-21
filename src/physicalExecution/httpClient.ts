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
//
// Node 18+ 内置 fetch + AbortSignal.timeout（无外部依赖）
// O 纪元（#16）：UDS 客户端半兑现 —— http+unix:// 经 undici Agent(socketPath)
// dispatcher 传输（全局 fetch 即 undici，init.dispatcher 是其原生扩展）。
import type { MicroResponse, PhysicalError } from './contracts.js';
import { PhysicalErrorKind } from './contracts.js';

/** http+unix:// 基址解析：socket 路径 + URL path。纯函数导出：测试面。
 *  方言：http+unix:///var/run/dsh-physical.sock/v1 —— socket 路径止于最后一个
 *  '.sock'，其后是 URL path。也兼容百分号编码方言（requests 风格：
 *  http+unix://%2Fvar%2Frun%2Fx.sock/v1 —— 先解码再按同一规则切分）。 */
export function parseUnixBaseUrl(baseUrl: string): { socketPath: string; urlPath: string } | null {
  const m = /^http\+unix:\/\/(.+)$/i.exec(baseUrl);
  if (!m) return null;
  const decoded = decodeURIComponent(m[1]);
  const idx = decoded.lastIndexOf('.sock');
  if (idx < 0) return null;
  return {
    socketPath: decoded.slice(0, idx + '.sock'.length),
    urlPath: decoded.slice(idx + '.sock'.length) || '/',
  };
}

/** UDS dispatcher 缓存（每 socket 一个 Agent —— 连接池复用；模块级单例） */
const udsAgents = new Map<string, unknown>();

/** 获取/铸造 UDS dispatcher（undici Agent）。不可用（非 Node undici 环境）⇒ null。 */
function udsDispatcher(socketPath: string): unknown | null {
  let agent = udsAgents.get(socketPath);
  if (agent) return agent;
  try {
    // 全局 fetch 的 dispatcher 需要 undici 的 Agent —— Node 内置 fetch 自带
    // undici，但 Agent 类不全局暴露；经 fetch 自身的 undici 引用获取
    // （require('node:undici') 在内置环境不可用 —— 用 fetch.constructor?.dispatcher?
    // 兜底：Node >=18.17 全局暴露 undici 无望，但 process.binding 不可用）。
    // 现实路径：动态 require('undici')（若宿主装了独立 undici 包），或
    // Node >=20 的 fetch 直连 socketPath dispatcher 注入。此处诚实降级：
    // 尝试动态导入 undici，失败返回 null（transport_error 诚实归因）。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const undici = (globalThis as any).__undiciBridge ?? null;
    if (!undici?.Agent) return null;
    agent = new undici.Agent({ connect: { socketPath } });
    udsAgents.set(socketPath, agent);
    return agent;
  } catch {
    return null;
  }
}

/** O 纪元（#16）：undici 桥注入点 —— 宿主/测试可注入 { Agent } 实现。
 *  缺省自动装载：模块加载即异步 import('undici')（装了包 ⇒ 桥自通；
 *  未装 ⇒ UDS 诚实降级 transport_error）。 */
export function setUndiciBridge(bridge: { Agent: new (opts: unknown) => unknown } | null): void {
  (globalThis as any).__undiciBridge = bridge;
  udsAgents.clear();
}

// 缺省桥装载（旁路义务：失败静默 —— UDS 请求时按无桥诚实归因）
void import('undici' as string).then(m => {
  if (!(globalThis as any).__undiciBridge && m?.Agent) setUndiciBridge(m as { Agent: new (o: unknown) => unknown });
}).catch(() => { /* undici 未安装：TCP 主路径不受影响 */ });

/** HTTP 客户端配置 —— 由 PhysicalExecutionAdapter 注入 */
export interface HttpClientConfig {
  /** Base URL —— 如 ``http+unix:///var/run/dsh-physical.sock/v1`` 或 ``http://127.0.0.1:8421/v1`` */
  baseUrl: string;
  /** 默认超时（毫秒）—— 单个 fetch 的 wall clock 上限 */
  defaultTimeoutMs: number;
  /** 自定义请求头注入点（如 X-Cap-Token / X-Request-Id） */
  headers?: () => Record<string, string>;
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
export async function microFetch<T>(
  config: HttpClientConfig,
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
    body?: unknown;
    timeoutMs?: number; // 缺省 = config.defaultTimeoutMs
    extraHeaders?: Record<string, string>;
  } = {},
): Promise<{ ok: true; response: MicroResponse<T> } | { ok: false; error: PhysicalError }> {
  const timeout = options.timeoutMs ?? config.defaultTimeoutMs;
  const method = options.method ?? 'POST';

  // O 纪元（#16）：UDS 基址翻译 —— http+unix://<sock>[/path] → dispatcher 传输
  const uds = parseUnixBaseUrl(config.baseUrl);
  let url = joinUrl(config.baseUrl, path);
  let dispatcher: unknown | null = null;
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
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(config.headers?.() ?? {}),
    ...(options.extraHeaders ?? {}),
  };

  // AbortSignal.timeout —— Node 18+ 原生支持
  let signal: AbortSignal;
  try {
    signal = AbortSignal.timeout(timeout);
  } catch {
    // 旧 Node fallback：手动 AbortController（J 纪元：timer unref ——
    // 主路径 AbortSignal.timeout 不会阻止进程退出，fallback 不该有差别）
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    t.unref?.();
    signal = ctrl.signal;
  }

  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal,
      ...(dispatcher ? { dispatcher } : {}), // undici 扩展（#16 UDS 传输）
    } as RequestInit);
  } catch (e: any) {
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
    } catch {
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
  let bodyJson: unknown;
  try {
    bodyJson = await resp.json();
  } catch (e: any) {
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
  const obj = bodyJson as { status?: string; data?: unknown; error?: unknown; latency_ms?: number };
  if (obj.status !== 'success' && obj.status !== 'failure') {
    return {
      ok: false,
      error: {
        kind: PhysicalErrorKind.INTERNAL_ERROR,
        detail: `response.status missing or invalid: ${obj.status ?? 'undefined'}`,
      },
    };
  }

  return { ok: true, response: bodyJson as MicroResponse<T> };
}

/** 拼接 URL —— 处理 baseUrl 末尾 / 与 path 开头 / 的去重 */
function joinUrl(base: string, path: string): string {
  // UDS URL 形如：http+unix:///var/run/dsh-physical.sock
  // TCP URL 形如：http://127.0.0.1:8421
  if (base.endsWith('/')) {
    return base.slice(0, -1) + (path.startsWith('/') ? path : '/' + path);
  }
  return base + (path.startsWith('/') ? path : '/' + path);
}
