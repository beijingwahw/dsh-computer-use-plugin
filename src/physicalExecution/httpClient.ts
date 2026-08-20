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
import type { MicroResponse, PhysicalError } from './contracts.js';
import { PhysicalErrorKind } from './contracts.js';

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
  const url = joinUrl(config.baseUrl, path);
  const timeout = options.timeoutMs ?? config.defaultTimeoutMs;
  const method = options.method ?? 'POST';

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
    // 旧 Node fallback：手动 AbortController
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), timeout);
    signal = ctrl.signal;
  }

  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal,
    });
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
