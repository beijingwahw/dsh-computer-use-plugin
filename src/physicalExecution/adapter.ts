// src/physicalExecution/adapter.ts
// D-5 物理执行适配器 —— PhysicalExecutionAdapter 主类实现。
//
// 职责（造物主契约 Step 1）：
//   - Node 端只负责 HTTP 通信和类型转换
//   - 异步 HTTP 请求 + 严格受 D-7 attemptTimeoutMs 控制（零阻塞铁律）
//   - 实现超时降级和 Result<T> 包装（异常诚实铁律）
//
// 接口对接：
//   - 上游：D-7 ExecutionStation.execute(ExecutionOrder) → 通过 PhysicalActionRouter
//   - 下游：Python 微服务（FastAPI + UDS + Cap Token）
//
// 铁律对齐：
//   - 加载层 configure：失败 throw，拒绝带病上线
//   - 预热 init：异步加载 HMAC 密钥（configure 末尾 fire-and-forget，call 内 await 兜底）
//   - 运行层 health/clickMouse/typeText/...：永不抛错，失败入 Result.error
//   - 契约驱动：所有跨进程通信为强类型 JSON Payload
import type {
  ClickResult, DragResult, HealthInfo, HotkeyResult, PhysicalError,
  PhysicalExecutionAdapter, PhysicalExecutionConfig, Result,
  ScreenshotResult, ScrollResult, SwitchWindowResult, TypeResult, UiTreeResult,
} from './contracts.js';
import { ALL_CAPS, PhysicalErrorKind } from './contracts.js';
import { ensureKey, mintToken, mintNonce } from './capToken.js';
import { microFetch, type HttpClientConfig } from './httpClient.js';
import { ScreenshotHandle } from './screenshotHandle.js';

/** Cap Token 提前刷新阈值（避免请求时刻过期） */
const TOKEN_REFRESH_MARGIN_MS = 5_000;

/** 适配器内部状态 */
interface AdapterState {
  config: PhysicalExecutionConfig;
  httpClientConfig: HttpClientConfig;
  /** HMAC 密钥加载 Promise（init 期间填充，后续业务调用 await 兜底） */
  keyPromise: Promise<Uint8Array> | null;
  /** HMAC 密钥（keyPromise resolve 后缓存） */
  key: Uint8Array | null;
  /** 当前持有的 Cap Token（带过期时间） */
  token: { value: string; expiresAt: number } | null;
  /** 最近一次 health 缓存（避免频繁探活） */
  healthCache: { info: HealthInfo; fetchedAt: number } | null;
}

export class PhysicalExecutionAdapterImpl implements PhysicalExecutionAdapter {
  private state: AdapterState | null = null;

  /** 加载层方法（《异常诚实分层契约》第一条）：失败 throw —— 拒绝带病上线 */
  configure(config: PhysicalExecutionConfig): void {
    const errors: string[] = [];
    if (!config.baseUrl || !/^(http|http\+unix):\/\//.test(config.baseUrl)) {
      errors.push(`baseUrl must start with http:// or http+unix://, got ${config.baseUrl}`);
    }
    if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
      errors.push(`timeoutMs must be positive finite, got ${config.timeoutMs}`);
    }
    if (config.enableAuth !== false && !config.keyPath) {
      errors.push('keyPath is required for Cap Token authentication (set enableAuth=false to disable)');
    }
    if (errors.length > 0) {
      throw new Error(`[PhysicalExecutionAdapter] invalid configuration:\n  - ${errors.join('\n  - ')}`);
    }

    const httpClientConfig: HttpClientConfig = {
      baseUrl: config.baseUrl,
      defaultTimeoutMs: config.timeoutMs,
      // headers callback 是 sync，故仅返回已缓存的 token；首次调用前需 await init()
      headers: config.enableAuth === false ? undefined : () => this.buildAuthHeadersSync(),
    };

    this.state = {
      config,
      httpClientConfig,
      keyPromise: null,
      key: null,
      token: null,
      healthCache: null,
    };

    // fire-and-forget 加载密钥（调用方应 await init() 确保就绪；未就绪时 call 内 await 兜底）
    if (config.enableAuth !== false) {
      this.state.keyPromise = this.loadKey();
    }
  }

  /** 预热：异步加载 HMAC 密钥（configure 后立即调用一次最佳） */
  async init(): Promise<Result<void, PhysicalError>> {
    if (!this.state) {
      return {
        ok: false,
        error: { kind: PhysicalErrorKind.INTERNAL_ERROR, detail: 'adapter not configured' },
      };
    }
    if (this.state.config.enableAuth === false) {
      return { ok: true, value: undefined };
    }
    if (this.state.key) {
      return { ok: true, value: undefined };
    }
    try {
      const key = this.state.keyPromise ?? (this.state.keyPromise = this.loadKey());
      this.state.key = await key;
      return { ok: true, value: undefined };
    } catch (e: any) {
      return {
        ok: false,
        error: { kind: PhysicalErrorKind.INTERNAL_ERROR, detail: `key load failed: ${e.message}` },
      };
    }
  }

  /** 启动期探活 —— Result 降级，永不抛错 */
  async health(): Promise<Result<HealthInfo, PhysicalError>> {
    if (!this.state) {
      return {
        ok: false,
        error: { kind: PhysicalErrorKind.INTERNAL_ERROR, detail: 'adapter not configured' },
      };
    }

    // 首次探活时确保 key 就绪（即便失败也不阻断探活 —— health 不强制要求 token）
    if (this.state.config.enableAuth !== false && !this.state.key) {
      const initResult = await this.init();
      if (!initResult.ok) {
        // key 加载失败：继续探活但 buildAuthHeadersSync 会返回空 token
        // Python 端会拒绝并返回 unauthorized —— 这是诚实降级
      }
    }

    // 健康检查不强制 Cap Token（Python 端 allow_no_token_endpoints 含 /v1/health）
    const result = await microFetch<HealthInfo>(this.state.httpClientConfig, '/health', {
      method: 'GET',
    });

    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    const resp = result.response;
    if (resp.status === 'failure') {
      return {
        ok: false,
        error: { kind: resp.error.kind as PhysicalErrorKind, detail: resp.error.detail },
      };
    }
    this.state.healthCache = { info: resp.data, fetchedAt: Date.now() };
    return { ok: true, value: resp.data };
  }

  // ─── 运行层方法：永不抛错（异常诚实第二条）───

  async clickMouse(args: {
    x: number; y: number; button?: 'left' | 'right' | 'middle'; dryRun?: boolean;
  }): Promise<Result<ClickResult, PhysicalError>> {
    return this.call('/click_mouse', {
      x: args.x, y: args.y,
      button: args.button ?? 'left',
      dry_run: args.dryRun ?? false,
    });
  }

  async typeText(args: {
    text: string; clearFirst?: boolean; dryRun?: boolean;
  }): Promise<Result<TypeResult, PhysicalError>> {
    return this.call('/type_text', {
      text: args.text,
      clear_first: args.clearFirst ?? false,
      dry_run: args.dryRun ?? false,
    });
  }

  async scrollPage(args: {
    direction: 'up' | 'down' | 'left' | 'right'; amount: number; dryRun?: boolean;
  }): Promise<Result<ScrollResult, PhysicalError>> {
    return this.call('/scroll_page', {
      direction: args.direction,
      amount: args.amount,
      dry_run: args.dryRun ?? false,
    });
  }

  async pressHotkey(args: {
    keys: string[]; dryRun?: boolean;
  }): Promise<Result<HotkeyResult, PhysicalError>> {
    return this.call('/press_hotkey', {
      keys: args.keys,
      dry_run: args.dryRun ?? false,
    });
  }

  async dragMouse(args: {
    start: { x: number; y: number };
    end: { x: number; y: number };
    dryRun?: boolean;
  }): Promise<Result<DragResult, PhysicalError>> {
    return this.call('/drag_mouse', {
      start: args.start,
      end: args.end,
      dry_run: args.dryRun ?? false,
    });
  }

  async takeScreenshot(args?: {
    format?: 'png' | 'jpeg';
    quality?: number;
    region?: { x: number; y: number; width: number; height: number };
  }): Promise<Result<ScreenshotResult, PhysicalError>> {
    return this.call('/take_screenshot', {
      format: args?.format ?? 'png',
      quality: args?.quality,
      region: args?.region,
    });
  }

  /**
   * 截图并返回 RAII 资源句柄 —— 世界级创新：自动资源管理。
   *
   * 与 `takeScreenshot` 的区别：
   *   - `takeScreenshot` 仅返回元数据（调用方需自行调 readShm + releaseShm）
   *   - `takeScreenshotHandle` 返回 ScreenshotHandle，封装 read/stream/transfer/release
   *
   * 资源安全：handle 被 GC 时自动调 releaseShm（FinalizationRegistry 兜底）
   *
   * 使用范式：
   *   const handle = await adapter.takeScreenshotHandle();
   *   if (!handle.ok) return handle;
   *   using h = handle.value;  // TC39 using（Node 22+ 实验性）
   *   const buf = await h.read();
   *   // 作用域结束时自动 release
   *
   * 或显式管理：
   *   const handle = await adapter.takeScreenshotHandle();
   *   if (!handle.ok) return handle;
   *   try {
   *     const buf = await handle.value.read();
   *   } finally {
   *     await handle.value.release();
   *   }
   */
  async takeScreenshotHandle(args?: {
    format?: 'png' | 'jpeg';
    quality?: number;
    region?: { x: number; y: number; width: number; height: number };
  }): Promise<Result<ScreenshotHandle, PhysicalError>> {
    const meta = await this.takeScreenshot(args);
    if (!meta.ok) {
      return { ok: false, error: meta.error };
    }
    return { ok: true, value: new ScreenshotHandle(meta.value, this) };
  }

  async getUiTree(args?: {
    source?: 'auto' | 'tree' | 'ocr' | 'vlm';
    region?: { x: number; y: number; width: number; height: number };
    funnelCeiling?: 'L1' | 'L2' | 'L3';
  }): Promise<Result<UiTreeResult, PhysicalError>> {
    return this.call('/get_ui_tree', {
      source: args?.source ?? 'auto',
      region: args?.region,
      funnel_ceiling: args?.funnelCeiling ?? 'L3',
    });
  }

  async switchWindow(args: { keyword: string }): Promise<Result<SwitchWindowResult, PhysicalError>> {
    return this.call('/switch_window', { keyword: args.keyword });
  }

  async releaseShm(name: string): Promise<Result<{ released: boolean }, PhysicalError>> {
    if (!this.state) {
      return {
        ok: false,
        error: { kind: PhysicalErrorKind.INTERNAL_ERROR, detail: 'adapter not configured' },
      };
    }
    const result = await microFetch<{ released: boolean; name: string }>(
      this.state.httpClientConfig,
      `/shm/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    );
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    const resp = result.response;
    if (resp.status === 'failure') {
      return {
        ok: false,
        error: { kind: resp.error.kind as PhysicalErrorKind, detail: resp.error.detail },
      };
    }
    return { ok: true, value: { released: resp.data.released } };
  }

  reset(): void {
    this.state = null;
  }

  // ─── 私有辅助 ───

  /** 异步加载 HMAC 密钥（首次 configure 末尾 fire-and-forget 启动） */
  private async loadKey(): Promise<Uint8Array> {
    if (!this.state) throw new Error('adapter not configured');
    const key = await ensureKey(this.state.config.keyPath);
    this.state.key = key;
    return key;
  }

  /** 通用 POST 调用 —— 处理 Cap Token / 错误转换 / Result 包装 */
  private async call<T>(
    path: string,
    body: unknown,
  ): Promise<Result<T, PhysicalError>> {
    if (!this.state) {
      return {
        ok: false,
        error: { kind: PhysicalErrorKind.INTERNAL_ERROR, detail: 'adapter not configured' },
      };
    }

    // 确保 key 就绪（init 已 await 过则 noop；未 init 则此 await 兜底）
    if (this.state.config.enableAuth !== false && !this.state.key) {
      const initResult = await this.init();
      if (!initResult.ok) {
        // key 加载失败：继续发请求，Python 端会拒绝并返回 unauthorized
        // 这样调用方能看到准确的 unauthorized 错误而非 internal_error
      }
    }

    const result = await microFetch<T>(this.state.httpClientConfig, path, {
      method: 'POST',
      body,
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    const resp = result.response;
    if (resp.status === 'failure') {
      return {
        ok: false,
        error: { kind: resp.error.kind as PhysicalErrorKind, detail: resp.error.detail },
      };
    }
    return { ok: true, value: resp.data };
  }

  /** 构造鉴权头（sync，由 httpClient headers callback 调用） */
  private buildAuthHeadersSync(): Record<string, string> {
    if (!this.state || this.state.config.enableAuth === false) return {};
    const token = this.ensureTokenSync();
    const nonce = mintNonce();
    return {
      'X-Cap-Token': token,
      'X-Request-Id': nonce,
    };
  }

  /** 确保 Cap Token 在有效期内（sync，调用前必须 init 完成） */
  private ensureTokenSync(): string {
    if (!this.state || !this.state.key) {
      // key 未就绪 —— 返回空串，Python 端会拒绝并返回 unauthorized（诚实降级）
      return '';
    }
    const now = Date.now();
    if (this.state.token && this.state.token.expiresAt - now > TOKEN_REFRESH_MARGIN_MS) {
      return this.state.token.value;
    }
    const ttl = this.state.config.tokenTtlSeconds ?? 60;
    const pid = this.state.config.pid ?? process.pid;
    const caps = this.state.config.defaultCaps ?? ALL_CAPS;
    const value = mintToken(this.state.key, pid, caps, ttl);
    this.state.token = { value, expiresAt: now + ttl * 1000 };
    return value;
  }
}
