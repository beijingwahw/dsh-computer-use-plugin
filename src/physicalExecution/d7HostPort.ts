// src/physicalExecution/d7HostPort.ts
// D-7 HostExecutePort 适配器：将 PhysicalActionRouterImpl 接线到 StubExecutionStation。
//
// 两层翻译：
//   1. D-7 AtomicAction (SandboxAction + rationale) → D-5 SandboxAction（剥离 rationale）
//   2. orchestration ExecutionResult { seq, effectDetected, latencyMs, rehearsed, failure }
//      → knowledge ExecutionResult Omit { status, failure }
//
// 启动哲学：懒启动（第一次 execute() 才 start()）。
// 失败哲学：
//   - 启动失败（Python 子进程 / 健康探活 超时）→ host-error，不改出任何成功
//   - 运行时失败 → router 已转 failure，诚实透传
import type {
  AtomicAction, ExecutionResult as D7ExecutionResult,
  PerceptionRequest, ScenePatch,
} from '../knowledge/contracts';
import type { HostExecutePort } from '../knowledge/stations';
import { faultPatches, dispatchElementsToGrid } from '../knowledge/stations';
import {
  createPhysicalExecution,
  PhysicalActionRouterImpl,
  CapabilityCache,
  syncCapabilityFromHealth,
  type PhysicalExecutionAdapter,
  type PhysicalExecutionConfig,
  type UiTreeResult,
} from './index';
import {
  PhysicalServiceManager,
  type ServiceManagerOpts,
} from './serviceManager';
import type { ExecutionResult as OrchExecutionResult } from './contracts';

/** D7PhysicalHostPort 构造选项 */
export interface D7PhysicalHostPortOpts {
  /** 子进程管理器选项（缺省：随机密钥 + 端口 8421 + mmap-file） */
  service?: ServiceManagerOpts;
  /** 适配器配置覆盖（缺省 timeoutMs = 5000） */
  adapter?: Partial<PhysicalExecutionConfig>;
  /** 启动期是否镜像 capability 到 CapabilityCache（缺省 true —— 路由更快） */
  syncCapabilityOnStartup?: boolean;
}

/** knowledge ExecutionResult 的 failure 类型（解包 Optional） */
type D7FailureKind =
  'gate-rejected' | 'host-error' | 'timeout' | 'sandbox-degraded' | 'cancelled' | 'timed-out';

/** 翻译层：orchestration ExecutionFailureKind → knowledge failure kind */
function translateFailureKind(kind: string): D7FailureKind {
  switch (kind) {
    case 'gate-rejected': return 'gate-rejected';
    case 'host-error': return 'host-error';
    case 'timeout': return 'timeout';
    case 'timed-out': return 'timed-out';
    case 'sandbox-degraded': return 'sandbox-degraded';
    case 'cancelled': return 'cancelled';
    default: return 'host-error';
  }
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
export class D7PhysicalHostPort implements HostExecutePort {
  readonly name = 'd5-microservice-host';

  private readonly opts: D7PhysicalHostPortOpts;
  private readonly mgr: PhysicalServiceManager;
  private readonly _capability: CapabilityCache;

  private adapter: PhysicalExecutionAdapter | null = null;
  private router: PhysicalActionRouterImpl | null = null;
  private screenSize: { width: number; height: number } | null = null;
  private seqCounter = 0;
  private initPromise: Promise<void> | null = null;
  private disposed = false;

  private static readonly _finalizer = new FinalizationRegistry<{ mgr: PhysicalServiceManager }>(
    (holdings) => {
      // GC 兜底：若调用方忘记 dispose，FinalizationRegistry 尽量关停子进程
      void holdings.mgr.dispose().catch(() => { /* noop */ });
    },
  );

  constructor(opts: D7PhysicalHostPortOpts = {}) {
    this.opts = opts;
    this.mgr = new PhysicalServiceManager(opts.service ?? {});
    this._capability = new CapabilityCache();
    // holdings 必须 != target（FinalizationRegistry 约束）—— 传一个独立容器对象
    D7PhysicalHostPort._finalizer.register(this, { mgr: this.mgr }, this);
  }

  /**
   * 执行原子动作（HostExecutePort 接口）。
   *
   * 首次调用会触发：spawn Python → 健康探活 → 构造 adapter → 构造 router → 探活 capability 同步。
   * 启动失败 / 运行失败一律诚实返回 failure，永不抛错。
   */
  async execute(action: AtomicAction): Promise<Omit<D7ExecutionResult, 'action' | 'durationMs'>> {
    if (this.disposed) {
      return {
        status: 'failure',
        failure: { kind: 'host-error', detail: 'D7PhysicalHostPort already disposed' },
      };
    }

    try {
      const router = await this._ensureInitialized();
      const seq = ++this.seqCounter;

      // 剥离 rationale（执行工位物理上看不见规划理由 —— 类型层已隔离，这里是保险）
      const sandboxAction = { kind: action.kind, args: action.args ?? {} };

      const result: OrchExecutionResult = await router.dispatch(sandboxAction, seq);

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
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        status: 'failure',
        failure: { kind: 'host-error', detail: `D7PhysicalHostPort execute threw: ${msg}` },
      };
    }
  }

  /** 显式 pre-warm：提前启动 Python 微服务，避免首个动作的冷启动延迟 */
  async prewarm(): Promise<{ ok: boolean; error?: string }> {
    if (this.disposed) return { ok: false, error: 'already disposed' };
    try {
      await this._ensureInitialized();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message ?? String(e) };
    }
  }

  /**
   * 感知端口（SceneSourcePort 契约）：屏幕 → ScenePatch[]。
   *
   * 通道：D-5 getUiTree 反双盲漏斗（L1 结构树 > L2 OCR；forceL3 语义授权 ⇒ 开 L3）。
   * 坐标翻译：Python 端像素 rect → 归一化（÷ 屏幕尺寸，尺寸来自 health 单次缓存）。
   * 异常诚实：任何故障 ⇒ fault 补丁（形状与 capability 源统一），绝不抛错毒化流水线。
   */
  async perceive(req: PerceptionRequest): Promise<ScenePatch[]> {
    try {
      await this._ensureInitialized();
      if (!this.screenSize) await this._syncScreenSize();
      if (!this.adapter) throw new Error('adapter not ready after init');
      if (!this.screenSize) {
        return faultPatches(req.grid, 'screen size unavailable (health screen probe failed)');
      }
      const r = await this.adapter.getUiTree({ funnelCeiling: req.forceL3 ? 'L3' : 'L2' });
      if (!r.ok) {
        return faultPatches(req.grid, `getUiTree failed (${r.error.kind}): ${r.error.detail}`);
      }
      return this._translateTree(r.value, req);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return faultPatches(req.grid, `D7PhysicalHostPort perceive fault: ${msg}`);
    }
  }

  /** UiTreeResult → ScenePatch[]（像素 → 归一化 + 网格分派公用律） */
  private _translateTree(tree: UiTreeResult, req: PerceptionRequest): ScenePatch[] {
    if (tree.fault && tree.elements.length === 0) {
      return faultPatches(req.grid, `ui funnel fault (${tree.fault.source}): ${tree.fault.detail}`);
    }
    const { width: w, height: h } = this.screenSize!;
    const els = tree.elements.map(e => ({
      role: e.role,
      name: e.name.slice(0, 20), // D-3 LABEL_MAX 先例（与 capability 源同律）
      rect: {
        x: e.rect.x / w, y: e.rect.y / h,
        width: e.rect.width / w, height: e.rect.height / h,
      },
    }));
    const depth: 'L1' | 'L2' = tree.funnel_depth === 'L2' ? 'L2' : 'L1';
    return dispatchElementsToGrid(els, req.grid, depth, depth === 'L1' ? 'L1-tree' : 'L2-ocr');
  }

  /** 屏幕尺寸缓存（health 单次探测；失败保持 null ⇒ perceive 诚实 fault） */
  private async _syncScreenSize(): Promise<void> {
    if (!this.adapter) return;
    const health = await this.adapter.health();
    if (health.ok && !('error' in health.value.screen)) {
      this.screenSize = { width: health.value.screen.width, height: health.value.screen.height };
    }
  }

  /** 当前是否已完成初始化（router 可路由） */
  get initialized(): boolean { return this.router !== null; }

  /** 暴露 capability cache —— 外部可查询当前路由策略 */
  get capability(): CapabilityCache { return this._capability; }

  /** 暴露 service manager（测试可观察 pid） */
  get manager(): PhysicalServiceManager { return this.mgr; }

  /** 优雅关停：router.reset()（若有）→ Python SIGTERM → 临时文件清理（幂等） */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    D7PhysicalHostPort._finalizer.unregister(this);
    try { this.adapter?.reset?.(); } catch { /* noop：reset 失败不阻断关停 */ }
    this.router = null;
    this.adapter = null;
    this.screenSize = null;
    await this.mgr.dispose();
  }

  private async _ensureInitialized(): Promise<PhysicalActionRouterImpl> {
    if (this.router) return this.router;
    if (this.initPromise) {
      await this.initPromise;
      if (this.router) return this.router;
      throw new Error('D7PhysicalHostPort init failed (router still null)');
    }
    this.initPromise = this._doInitialize();
    await this.initPromise;
    if (!this.router) throw new Error('D7PhysicalHostPort init failed silently');
    return this.router;
  }

  private async _doInitialize(): Promise<void> {
    // 1. 启动 Python 微服务
    const start = await this.mgr.start();
    if (!start.ok) {
      throw new Error(
        `PhysicalServiceManager.start failed (${start.error?.kind}): ${start.error?.detail}`,
      );
    }

    // 2. 构造 adapter
    const cfg: PhysicalExecutionConfig = {
      baseUrl: start.baseUrl,
      timeoutMs: this.opts.adapter?.timeoutMs ?? 5000,
      keyPath: start.keyPath,
      tokenTtlSeconds: this.opts.adapter?.tokenTtlSeconds ?? 60,
      enableAuth: this.opts.adapter?.enableAuth ?? true,
      ...(this.opts.adapter ?? {}),
    };
    const adapter = createPhysicalExecution(cfg);
    const init = await adapter.init();
    if (!init.ok) {
      await this.mgr.dispose();
      throw new Error(`adapter.init failed (${init.error.kind}): ${init.error.detail}`);
    }
    this.adapter = adapter;

    // 3. 构造 router
    this.router = new PhysicalActionRouterImpl(adapter, this._capability);

    // 4. (可选) 启动期探活 + 同步 capability 与屏幕尺寸（perceive 端口的归一化基准）
    if (this.opts.syncCapabilityOnStartup !== false) {
      try {
        const health = await adapter.health();
        if (health.ok) {
          syncCapabilityFromHealth(this._capability, health.value);
          if (!('error' in health.value.screen)) {
            this.screenSize = { width: health.value.screen.width, height: health.value.screen.height };
          }
        }
      } catch { /* 不阻断：capability cache 懒同步也 OK */ }
    }
  }
}
