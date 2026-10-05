// ΠΑΝ-127（D-F5 清偿）：网格分派改自零环基座 knowledge/gridDispatch.ts 导入
//（原借 knowledge/stations 构成 knowledge↔physicalExecution value 环的一臂；
// stations 面同名符号仍经再导出可用）。
import { faultPatches, dispatchElementsToGrid } from '../knowledge/gridDispatch.js';
// ΠΑΝ-127（D-F5 清偿）：value 符号改自各源件导入（原经桶 './index' 回借构成
// d7↔index value 二环 —— 桶-卫星互指同病）；类型面（PhysicalExecutionAdapter/
// PhysicalExecutionConfig/UiTreeResult）仍 type-import 自桶（type 边豁免）。
import { createPhysicalExecution } from './compose.js';
import { PhysicalActionRouterImpl } from './router.js';
import { CapabilityCache, syncCapabilityFromHealth } from './capabilityCache.js';
import { PhysicalServiceManager, } from './serviceManager.js';
/**
 * 翻译层：orchestration ExecutionFailureKind → knowledge failure kind。
 * ΠΑΝ-65（错误细分折叠修复）：旧实现 default 整体折叠 host-error —— router
 * 的 ΝΩ-27 十四种细分透传在本翻译层全部湮灭（unauthorized/element-not-found/
 * transport-error 不可区分，上层重试策略失去判据），故先按可重试/不可重试/
 * 认证三类语义保义落位（折叠过渡期）。
 * ΤΕΛ-4（D-G20 清偿）：knowledge 词表已扩容（contracts 的 D7FailureKind
 * = D-6 ExecutionFailureKind 全量 ∪ {'timed-out'}）⇒ 本表**退化为恒等直通**：
 *   - 全部已知 kind 独立 case 恒等返回（ΠΑΝ-65 结构承诺的兑现——无隐藏
 *     类别耦合，细分值不再折叠，可观测面零损失）；
 *   - 唯 default 兜底保留：版本漂移的未知运行时值（wire 上 Python 升版引入
 *     新错误种）→ 'host-error'（保守可重试；router.mapErrorKind 已在其侧
 *     fold 未知 snake_case，本兜底是防御纵深第二层，非常规路径）；
 *   - 'timeout-aborted' 不再折到 'timeout'（D-7 超时预算语义负载在两个值上
 *     各自可见——knowledge 流水线对二者同入重试循环，行为面零变化）。
 * 导出：执法测试矩阵直接点名（physicalExecution 词表锁）。
 */
export function translateFailureKind(kind) {
    switch (kind) {
        // —— 基础六态 + ΝΩ-27 十四细分：恒等直通（无折叠）——
        case 'gate-rejected': return 'gate-rejected';
        case 'host-error': return 'host-error';
        case 'timeout': return 'timeout';
        case 'timeout-aborted': return 'timeout-aborted';
        case 'timed-out': return 'timed-out';
        case 'sandbox-degraded': return 'sandbox-degraded';
        case 'cancelled': return 'cancelled';
        case 'invalid-args': return 'invalid-args';
        case 'out-of-bounds': return 'out-of-bounds';
        case 'unknown-button': return 'unknown-button';
        case 'unknown-key': return 'unknown-key';
        case 'element-not-found': return 'element-not-found';
        case 'screen-capture-failed': return 'screen-capture-failed';
        case 'ocr-unavailable': return 'ocr-unavailable';
        case 'vlm-unavailable': return 'vlm-unavailable';
        case 'window-unavailable': return 'window-unavailable';
        case 'unauthorized': return 'unauthorized';
        case 'internal-error': return 'internal-error';
        case 'transport-error': return 'transport-error';
        // —— 版本漂移的未知 kind：可重试泛型（保守 —— 服务升级引入新错误种时
        //    宁可重试也不误判终局；detail 前缀保真原值供人工归类）——
        default: return 'host-error';
    }
}
// ─── ΠΑΝ-67（连接韧性）：Python 崩溃后的重生治理 ───
/** ΠΑΝ-67：重生预算 —— 崩溃后最多自动 respawn 次数（有限次，不是无限重启循环） */
export const RESPAWN_MAX_ATTEMPTS = 3;
/** ΠΑΝ-67：重生退避基值（ms）—— 500 → 1000 → 2000（指数退避，封顶 4s） */
export const RESPAWN_BACKOFF_BASE_MS = 500;
/** ΠΑΝ-67：重生退避封顶（ms） */
export const RESPAWN_BACKOFF_CAP_MS = 4_000;
/**
 * ΠΑΝ-67：重生裁决（纯函数，导出为执法测试面）—— 已失败 N 次重生后：
 *   - N < max  ⇒ 允许再试，且下一次前须退避 min(cap, base·2^(N-1)) ms
 *     （N=0 即首次启动，零退避）；
 *   - N ≥ max ⇒ 拒绝（预算耗尽 —— 调用方诚实降级 transport 事件，绝不
 *     无限重启循环吞噬宿主资源）。
 */
export function respawnRuling(failures, max = RESPAWN_MAX_ATTEMPTS, baseMs = RESPAWN_BACKOFF_BASE_MS, capMs = RESPAWN_BACKOFF_CAP_MS) {
    if (!Number.isFinite(failures) || failures < 0 || failures >= max)
        return { allow: false };
    const backoffMs = failures === 0 ? 0 : Math.min(capMs, baseMs * 2 ** Math.min(failures - 1, 16));
    return { allow: true, backoffMs };
}
/**
 * D7PhysicalHostPort —— D-7 工位直连 D-5 物理微服务的双端口躯体：
 *   execute（HostExecutePort）→ 动作执行（批次 D 默认实现切换，取代 nut-js）
 *   perceive（SceneSourcePort）→ 真实感知（getUiTree 反双盲漏斗 → ScenePatch[]）
 * 同一躯体两副面孔：执行与感知共享同一 Python 进程 / 密钥 / capability 缓存 ——
 * 感知-决策-执行闭环第一次跑在同一物理基础之上。
 *
 * 生命周期：
 *   const host = new D7PhysicalHostPort();
 *   const station = new StubExecutionStation({ host });  // 立即可用
 *   station.execute(env);  // 懒启动 Python，首次稍慢（1-3s）
 *   host.perceive(req);    // 同一躯体：懒启动复用，零二次 spawn
 *   await host.dispose();  // 进程退出时优雅关停
 *
 * 注意：dispose 未被自动调用，需要 Cordis ctx.effect 或测试手动调。
 *       若调用方忘记，FinalizationRegistry 兜底（见 _finalizer）。
 */
/**
 * J 纪元纵深防御（纯函数）：屏幕尺寸的有限正数闸。
 * 旧链路的 NaN 事故（health 曾把 tuple 序列化成数组 → Node 端 undefined 除数
 * → 归一化产出 NaN 坐标，静默毒化决策链）在消费侧永久免疫：坏数据 ⇒ null
 * ⇒ 消费方诚实 fault。宁可失明，不可说谎。
 * ΑΩ-R27：d7HostPort 内部消费方已随 screenSize 缓存退役归零 —— 保留为公开
 * 导出（epochJ J-11 执法在册），供未来持屏幕尺寸的消费方复用同一防御闸。
 */
export function sanitizeScreenSize(screen) {
    const w = Number(screen?.width);
    const h = Number(screen?.height);
    if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0)
        return { width: w, height: h };
    return null;
}
export class D7PhysicalHostPort {
    name = 'd5-microservice-host';
    opts;
    mgr;
    _capability;
    adapter = null;
    router = null;
    // ΑΩ-R27 定谳（screenSize 僵尸状态处决）：本类曾缓存 health 探测的屏幕尺寸，
    // 供 perceive 归一化（像素 rect ÷ screenSize）与「就绪判据」消费。J 纪元
    // 坐标统一后 Python 漏斗直接输出全屏归一化坐标，本端 _translateTree 零换算
    // 直通 —— 字段就此失去全部读方（全库检索 src/ + test/ 仅余就绪判据自食）。
    // 归一化基准的**活**依赖早已单源在服务端：/v1/get_ui_tree 每请求现场重探
    // screen size，缺席时漏斗诚实 fault（"L1 screen size unavailable (cannot
    // normalize pixel rects)"）—— 新鲜度由真正需要该值的一层负责。
    // 两案取舍：「TTL 活化」= 为无人读取的值在感知热路径引入周期 health 轮询，
    // 纯开销；且旧判据会在「health.screen 探测失败但 L2 OCR 可用」的环境把可用
    // 感知错杀成 fault。故删字段 + 删判据，perceive 的诚实边界由 getUiTree 的
    // fault/empty 结果单一裁决。sanitizeScreenSize 纯函数保留（公开导出，
    // epochJ J-11 执法在册，消费方自用防御闸）。
    seqCounter = 0;
    initPromise = null;
    disposed = false;
    /** ΠΑΝ-67：本生命周期内已失败的重生次数（成功初始化后归零 —— 预算按
     *  「连续崩溃episode」计，稳定运行一段后再次崩溃重新获预算） */
    respawnFailures = 0;
    static _finalizer = new FinalizationRegistry((holdings) => {
        // GC 兜底：若调用方忘记 dispose，FinalizationRegistry 尽量关停子进程
        void holdings.mgr.dispose().catch(() => { });
    });
    constructor(opts = {}) {
        this.opts = opts;
        this.mgr = new PhysicalServiceManager(opts.service ?? {});
        this._capability = new CapabilityCache();
        // holdings 必须 != target（FinalizationRegistry 约束）—— 传一个独立容器对象
        D7PhysicalHostPort._finalizer.register(this, { mgr: this.mgr }, this);
    }
    /**
     * 执行原子动作（HostExecutePort 接口；ΝΩ-8 增补可选止损 signal —— 接口臂缺参
     * 不破坏可赋值性，外部注入端口零感知）。
     *
     * 首次调用会触发：spawn Python → 健康探活 → 构造 adapter → 构造 router → 探活 capability 同步。
     * 启动失败 / 运行失败一律诚实返回 failure，永不抛错。
     *
     * ΝΩ-8 止损语义：signal 在场且已 abort ⇒ 立即 cancelled 归因返回（不为已取消的
     * 动作 spawn Python / 发请求）；在途 abort 经 dispatch → adapter → microFetch
     * 组合断流（Python 收到断连即中断 —— 服务器侧无需改动）。
     * signal 缺席 ⇒ 旧路径（逐字节）。
     */
    async execute(action, signal) {
        if (this.disposed) {
            return {
                status: 'failure',
                failure: { kind: 'host-error', detail: 'D7PhysicalHostPort already disposed' },
            };
        }
        const stop = signal instanceof AbortSignal ? signal : undefined; // 防御性收窄（garbage 按缺席）
        if (stop?.aborted) {
            // 取消先于派发：cancelled 归因直达（消费侧路由铁律：cancelled 不入重试）
            return {
                status: 'failure',
                failure: { kind: 'cancelled', detail: 'D7PhysicalHostPort execute aborted before dispatch (external signal)' },
            };
        }
        try {
            const router = await this._ensureInitialized();
            const seq = ++this.seqCounter;
            // 剥离 rationale（执行工位物理上看不见规划理由 —— 类型层已隔离，这里是保险）
            const sandboxAction = { kind: action.kind, args: action.args ?? {} };
            // ΝΩ-8：止损信号透传 dispatch（seam 类型见 SignalDispatch 注）——
            // 在场即随路由直达 adapter 调用 / microFetch（HTTP 层已吃 signal）；
            // 缺席即旧路径（无第三实参语义差）。
            const dispatch = router.dispatch.bind(router);
            const result = await dispatch(sandboxAction, seq, stop);
            // 翻译：orchestration ExecutionResult → knowledge ExecutionResult (Omit)
            if (result.failure) {
                return {
                    status: 'failure',
                    failure: {
                        kind: translateFailureKind(result.failure.kind),
                        detail: result.failure.detail,
                    },
                };
            }
            return { status: 'success' };
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return {
                status: 'failure',
                failure: { kind: 'host-error', detail: `D7PhysicalHostPort execute threw: ${msg}` },
            };
        }
    }
    /** 显式 pre-warm：提前启动 Python 微服务，避免首个动作的冷启动延迟 */
    async prewarm() {
        if (this.disposed)
            return { ok: false, error: 'already disposed' };
        try {
            await this._ensureInitialized();
            return { ok: true };
        }
        catch (e) {
            return { ok: false, error: e.message ?? String(e) };
        }
    }
    /**
     * 感知端口（SceneSourcePort 契约）：屏幕 → ScenePatch[]。
     *
     * 通道：D-5 getUiTree 反双盲漏斗（L1 结构树 > L2 OCR；forceL3 语义授权 ⇒ 开 L3）。
     * 坐标翻译：Python 端漏斗直接输出全屏归一化 rect（J 纪元），本端零换算直通。
     * ΑΩ-R27：旧「screenSize 就绪判据」已删 —— 归一化基准的活依赖在服务端
     * 每请求现场重探（见类内 ΑΩ-R27 定谳注），本端不再持有屏幕尺寸缓存。
     * 异常诚实：任何故障 ⇒ fault 补丁（形状与 capability 源统一），绝不抛错毒化流水线。
     */
    async perceive(req, signal) {
        if (this.disposed) {
            // dispose 后不再懒复活：perceive 缺此闸会把已关停的 Python 服务重新 spawn
            return faultPatches(req.grid, 'D7PhysicalHostPort already disposed');
        }
        try {
            await this._ensureInitialized();
            if (!this.adapter)
                throw new Error('adapter not ready after init');
            // 止损信号直通 getUiTree fetch（流水线感知步超时 ⇒ 立即断流，
            // 不再等 15s 内层超时自然到账 —— 感知是热路径，浪费窗口按步计）
            const r = await this.adapter.getUiTree({ funnelCeiling: req.forceL3 ? 'L3' : 'L2', signal });
            if (!r.ok) {
                return faultPatches(req.grid, `getUiTree failed (${r.error.kind}): ${r.error.detail}`);
            }
            return this._translateTree(r.value, req);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return faultPatches(req.grid, `D7PhysicalHostPort perceive fault: ${msg}`);
        }
    }
    /** UiTreeResult → ScenePatch[]（坐标直通 + 网格分派公用律）。
     *  J 纪元坐标统一：Python 漏斗（ui_tree.py）现在输出**全屏归一化**坐标 ——
     *  本端不再除以屏幕尺寸（旧实现：L1/L2 像素 ÷ 屏幕 = 正确；但 L3 VLM 的
     *  归一化坐标被二次缩小，region 裁剪时 L2 的裁剪内像素也整体漂移）。
     *  同时 funnel_depth 忠实映射（旧实现把 'L3' 与 'empty' 都压成 'L1'/
     *  'L1-tree' —— 伪造溯源标签，违背 source 是诚实降级载体的契约）。 */
    _translateTree(tree, req) {
        if (tree.fault && tree.elements.length === 0) {
            return faultPatches(req.grid, `ui funnel fault (${tree.fault.source}): ${tree.fault.detail}`);
        }
        const els = tree.elements.map(e => ({
            role: e.role,
            name: e.name.slice(0, 20), // D-3 LABEL_MAX 先例（与 capability 源同律）
            rect: { x: e.rect.x, y: e.rect.y, width: e.rect.width, height: e.rect.height },
        }));
        if (tree.funnel_depth === 'empty' && els.length === 0) {
            // 诚实空：与 fault 分派共用空补丁方言（elements: [] + funnelDepth 'empty'）
            return dispatchElementsToGrid([], req.grid, 'L1', 'L1-tree');
        }
        const depth = tree.funnel_depth === 'L3' ? 'L3' : tree.funnel_depth === 'L2' ? 'L2' : 'L1';
        const source = depth === 'L3' ? 'L3-vlm' : depth === 'L2' ? 'L2-ocr' : 'L1-tree';
        return dispatchElementsToGrid(els, req.grid, depth, source);
    }
    /** 当前是否已完成初始化（router 可路由） */
    get initialized() { return this.router !== null; }
    /** 暴露 capability cache —— 外部可查询当前路由策略 */
    get capability() { return this._capability; }
    /** 暴露 service manager（测试可观察 pid） */
    get manager() { return this.mgr; }
    /** 优雅关停：router.reset()（若有）→ Python SIGTERM → 临时文件清理（幂等） */
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        D7PhysicalHostPort._finalizer.unregister(this);
        try {
            this.adapter?.reset?.();
        }
        catch { /* noop：reset 失败不阻断关停 */ }
        this.router = null;
        this.adapter = null;
        await this.mgr.dispose();
    }
    async _ensureInitialized() {
        if (this.router) {
            if (this.mgr.isRunning)
                return this.router;
            // ΠΑΝ-67（连接韧性）：Python 进程已崩溃但路由还挂着 —— 旧实现无条件
            // `return this.router`，此后所有 execute/perceive 对着死端口发请求，
            // transport-error 永续直至插件重载。拆除陈旧路由/适配器，走重生路径。
            this._teardownStaleRouter();
        }
        if (this.initPromise)
            return this._awaitExistingInit();
        // ΠΑΝ-67：重生裁决 —— 有限次 + 指数退避；超限诚实降级（transport 事件
        // 归因的失败回执，绝不无限重启循环，也绝不假装路由可用）。首次尝试零
        // 退避；失败在 catch 计数，下一次尝试前按 min(cap, base·2^(n-1)) 退避。
        if (this.mgr.disposed) {
            // manager 已显式 dispose（外部经 manager getter 直呼）：终态意图，不做重生
            throw new Error('D7PhysicalHostPort manager disposed (no respawn)');
        }
        const ruling = respawnRuling(this.respawnFailures);
        if (!ruling.allow) {
            throw new Error(`python service crashed or failed to start; respawn budget exhausted (${RESPAWN_MAX_ATTEMPTS} retries) — ` +
                'transport unavailable (honest degradation; dispose and recreate the port to retry)');
        }
        if (ruling.backoffMs > 0) {
            await new Promise(r => setTimeout(r, ruling.backoffMs));
            // ΠΑΝ-67：退避窗内的并发调用可能已完成初始化 —— 汇流到既有 promise
            //（防退避窗造成双 _doInitialize：check→set 之间新增了 await 间隙）。
            if (this.initPromise)
                return this._awaitExistingInit();
        }
        this.initPromise = this._doInitialize().catch(e => {
            this.initPromise = null; // 失败即清：下次调用重新初始化
            this.respawnFailures += 1; // ΠΑΝ-67：失败计数（下次尝试前按指数退避）
            throw e;
        });
        await this.initPromise;
        if (!this.router)
            throw new Error('D7PhysicalHostPort init failed silently');
        this.respawnFailures = 0; // ΠΑΝ-67：成功即重置预算（新崩溃 episode 重新计数）
        return this.router;
    }
    /** 汇流到在飞初始化 promise（J 纪元语义保持：失败即清零可重试） */
    async _awaitExistingInit() {
        const p = this.initPromise;
        if (!p)
            throw new Error('D7PhysicalHostPort init failed (router still null)');
        try {
            await p;
        }
        catch (e) {
            // J 纪元修正：初始化失败可重试 —— 旧实现 rejected promise 永久缓存，
            // 此后每次 execute/perceive/prewarm 都 await 同一 rejected promise，
            // 实例永久失效（Python 临时起不来 = 终身瘫痪，只能 dispose 重建）。
            if (this.initPromise === p)
                this.initPromise = null;
            throw e;
        }
        if (this.router)
            return this.router;
        throw new Error('D7PhysicalHostPort init failed (router still null)');
    }
    /** ΠΑΝ-67：崩溃后拆除陈旧路由面 —— adapter.reset 归零连接状态、路由/适配器
     *  置空（下一次调用经 _ensureInitialized 重生；manager.start 的 respawn
     *  路径自会清理旧临时密钥/mmap 目录并重新 spawn + 探活）。 */
    _teardownStaleRouter() {
        try {
            this.adapter?.reset?.();
        }
        catch { /* noop：reset 失败不阻断重生 */ }
        this.adapter = null;
        this.router = null;
        this.initPromise = null;
    }
    async _doInitialize() {
        // 1. 启动 Python 微服务
        const start = await this.mgr.start();
        if (!start.ok) {
            throw new Error(`PhysicalServiceManager.start failed (${start.error?.kind}): ${start.error?.detail}`);
        }
        // dispose 与 init 并发竞态：dispose 可能在 await 期间已执行 —— 不再把
        // 适配器/路由铸到已关停的端口上（进程由 manager 侧 dispose 清场）
        if (this.disposed) {
            await this.mgr.dispose();
            throw new Error('D7PhysicalHostPort disposed during initialization');
        }
        // 2. 构造 adapter。
        //    J 纪元修正：覆盖项放前面、连接事实放后面 —— 旧实现把
        //    `...(this.opts.adapter ?? {})` 放最后，调用方误传 baseUrl/keyPath
        //    会覆盖掉 manager 给出的真实连接信息（密钥不匹配 ⇒ unauthorized）。
        const cfg = {
            ...(this.opts.adapter ?? {}),
            baseUrl: start.baseUrl,
            timeoutMs: this.opts.adapter?.timeoutMs ?? 5000,
            keyPath: start.keyPath,
            tokenTtlSeconds: this.opts.adapter?.tokenTtlSeconds ?? 60,
            enableAuth: this.opts.adapter?.enableAuth ?? true,
        };
        const adapter = createPhysicalExecution(cfg);
        const init = await adapter.init();
        if (!init.ok) {
            await this.mgr.dispose();
            throw new Error(`adapter.init failed (${init.error.kind}): ${init.error.detail}`);
        }
        if (this.disposed) {
            await this.mgr.dispose();
            throw new Error('D7PhysicalHostPort disposed during initialization');
        }
        this.adapter = adapter;
        // 3. 构造 router
        this.router = new PhysicalActionRouterImpl(adapter, this._capability);
        // 4. (可选) 启动期探活 + 同步 capability（ΑΩ-R27：屏幕尺寸不再缓存 ——
        //    J 纪元后本端零消费，活依赖在服务端每请求重探，见类内定谳注）
        if (this.opts.syncCapabilityOnStartup !== false && !this.disposed) {
            try {
                const health = await adapter.health();
                if (health.ok) {
                    syncCapabilityFromHealth(this._capability, health.value);
                }
            }
            catch { /* 不阻断：capability cache 懒同步也 OK */ }
        }
    }
}
