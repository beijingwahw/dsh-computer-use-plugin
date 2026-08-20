import { ALL_CAPS, PhysicalErrorKind } from './contracts.js';
import { ensureKey, mintToken, mintNonce } from './capToken.js';
import { microFetch } from './httpClient.js';
import { ScreenshotHandle } from './screenshotHandle.js';
/** Cap Token 提前刷新阈值（避免请求时刻过期） */
const TOKEN_REFRESH_MARGIN_MS = 5000;
export class PhysicalExecutionAdapterImpl {
    state = null;
    /** 加载层方法（《异常诚实分层契约》第一条）：失败 throw —— 拒绝带病上线 */
    configure(config) {
        const errors = [];
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
        const httpClientConfig = {
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
    async init() {
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
        }
        catch (e) {
            return {
                ok: false,
                error: { kind: PhysicalErrorKind.INTERNAL_ERROR, detail: `key load failed: ${e.message}` },
            };
        }
    }
    /** 启动期探活 —— Result 降级，永不抛错 */
    async health() {
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
        const result = await microFetch(this.state.httpClientConfig, '/health', {
            method: 'GET',
        });
        if (!result.ok) {
            return { ok: false, error: result.error };
        }
        const resp = result.response;
        if (resp.status === 'failure') {
            return {
                ok: false,
                error: { kind: resp.error.kind, detail: resp.error.detail },
            };
        }
        this.state.healthCache = { info: resp.data, fetchedAt: Date.now() };
        return { ok: true, value: resp.data };
    }
    // ─── 运行层方法：永不抛错（异常诚实第二条）───
    async clickMouse(args) {
        return this.call('/click_mouse', {
            x: args.x, y: args.y,
            button: args.button ?? 'left',
            dry_run: args.dryRun ?? false,
        });
    }
    async typeText(args) {
        return this.call('/type_text', {
            text: args.text,
            clear_first: args.clearFirst ?? false,
            dry_run: args.dryRun ?? false,
        });
    }
    async scrollPage(args) {
        return this.call('/scroll_page', {
            direction: args.direction,
            amount: args.amount,
            dry_run: args.dryRun ?? false,
        });
    }
    async pressHotkey(args) {
        return this.call('/press_hotkey', {
            keys: args.keys,
            dry_run: args.dryRun ?? false,
        });
    }
    async dragMouse(args) {
        return this.call('/drag_mouse', {
            start: args.start,
            end: args.end,
            dry_run: args.dryRun ?? false,
        });
    }
    async takeScreenshot(args) {
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
    async takeScreenshotHandle(args) {
        const meta = await this.takeScreenshot(args);
        if (!meta.ok) {
            return { ok: false, error: meta.error };
        }
        return { ok: true, value: new ScreenshotHandle(meta.value, this) };
    }
    async getUiTree(args) {
        return this.call('/get_ui_tree', {
            source: args?.source ?? 'auto',
            region: args?.region,
            funnel_ceiling: args?.funnelCeiling ?? 'L3',
        });
    }
    async switchWindow(args) {
        return this.call('/switch_window', { keyword: args.keyword });
    }
    async releaseShm(name) {
        if (!this.state) {
            return {
                ok: false,
                error: { kind: PhysicalErrorKind.INTERNAL_ERROR, detail: 'adapter not configured' },
            };
        }
        const result = await microFetch(this.state.httpClientConfig, `/shm/${encodeURIComponent(name)}`, { method: 'DELETE' });
        if (!result.ok) {
            return { ok: false, error: result.error };
        }
        const resp = result.response;
        if (resp.status === 'failure') {
            return {
                ok: false,
                error: { kind: resp.error.kind, detail: resp.error.detail },
            };
        }
        return { ok: true, value: { released: resp.data.released } };
    }
    reset() {
        this.state = null;
    }
    // ─── 私有辅助 ───
    /** 异步加载 HMAC 密钥（首次 configure 末尾 fire-and-forget 启动） */
    async loadKey() {
        if (!this.state)
            throw new Error('adapter not configured');
        const key = await ensureKey(this.state.config.keyPath);
        this.state.key = key;
        return key;
    }
    /** 通用 POST 调用 —— 处理 Cap Token / 错误转换 / Result 包装 */
    async call(path, body) {
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
        const result = await microFetch(this.state.httpClientConfig, path, {
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
                error: { kind: resp.error.kind, detail: resp.error.detail },
            };
        }
        return { ok: true, value: resp.data };
    }
    /** 构造鉴权头（sync，由 httpClient headers callback 调用） */
    buildAuthHeadersSync() {
        if (!this.state || this.state.config.enableAuth === false)
            return {};
        const token = this.ensureTokenSync();
        const nonce = mintNonce();
        return {
            'X-Cap-Token': token,
            'X-Request-Id': nonce,
        };
    }
    /** 确保 Cap Token 在有效期内（sync，调用前必须 init 完成） */
    ensureTokenSync() {
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
