// src/physicalExecution/contracts.ts
// D-5 物理执行适配器 —— 契约层（批次 B：Node.js 侧）。
// 造物主契约（Step 1）：
//   - 仅负责 HTTP 通信与类型转换；底层物理操作全在 Python 微服务
//   - 异步 HTTP 请求受 D-7 PipelineConfig.attemptTimeoutMs 控制（零阻塞铁律）
//   - 异常诚实：运行层永不抛错，失败入 Result<T> 失败臂
//   - 契约驱动：跨进程仅传强类型 JSON Payload，绝不传自然语言
//
// 产权铁律：跨器官类型一律 import ——
//   SandboxAction / ExecutionResult / ExecutionFailureKind / ConfigError 来自 D-7 + D-5；
//   本文件只拥有 D-5 物理执行方言（PhysicalExecutionAdapter / PhysicalError / …）。
import type { SandboxAction } from '../sandbox/types';
import type {
  ConfigError, ExecutionFailureKind, ExecutionResult, Result,
} from '../orchestration/contracts';

export type { SandboxAction, ConfigError, ExecutionFailureKind, ExecutionResult, Result };

// ─── 0. 统一结果协议（D-7 单源消费，绝不另立方言）───
// 复用 ../orchestration/contracts 的 Result<T, E>；失败臂 E = PhysicalError

/** 物理执行错误种类（镜像 Python 端 ErrorKind 枚举） */
export type PhysicalErrorKind =
  | 'invalid_args' | 'out_of_bounds' | 'unknown_button' | 'unknown_key'
  | 'element_not_found' | 'screen_capture_failed' | 'ocr_unavailable'
  | 'vlm_unavailable' | 'action_timeout' | 'window_unavailable'
  | 'unauthorized' | 'internal_error'
  /** Node 端独有：HTTP 传输层失败（连接拒绝 / DNS 失败 / 网络断开） */
  | 'transport_error'
  /** Node 端独有：超时（AbortController 触发） */
  | 'client_timeout';

/** PhysicalErrorKind 运行时值（声明合并：const + type 同名，TS 支持） */
export const PhysicalErrorKind = {
  INVALID_ARGS: 'invalid_args' as PhysicalErrorKind,
  OUT_OF_BOUNDS: 'out_of_bounds' as PhysicalErrorKind,
  UNKNOWN_BUTTON: 'unknown_button' as PhysicalErrorKind,
  UNKNOWN_KEY: 'unknown_key' as PhysicalErrorKind,
  ELEMENT_NOT_FOUND: 'element_not_found' as PhysicalErrorKind,
  SCREEN_CAPTURE_FAILED: 'screen_capture_failed' as PhysicalErrorKind,
  OCR_UNAVAILABLE: 'ocr_unavailable' as PhysicalErrorKind,
  VLM_UNAVAILABLE: 'vlm_unavailable' as PhysicalErrorKind,
  ACTION_TIMEOUT: 'action_timeout' as PhysicalErrorKind,
  WINDOW_UNAVAILABLE: 'window_unavailable' as PhysicalErrorKind,
  UNAUTHORIZED: 'unauthorized' as PhysicalErrorKind,
  INTERNAL_ERROR: 'internal_error' as PhysicalErrorKind,
  TRANSPORT_ERROR: 'transport_error' as PhysicalErrorKind,
  CLIENT_TIMEOUT: 'client_timeout' as PhysicalErrorKind,
} as const;

/** D-5 物理执行方言的错误臂（D-7 Result 的 E 参数化） */
export interface PhysicalError {
  kind: PhysicalErrorKind;
  detail: string;
}

// ─── 1. 微服务响应信封（镜像 Python 端 success / failure）───

export interface MicroSuccess<T> {
  status: 'success';
  data: T;
  latency_ms: number;
}

export interface MicroFailure {
  status: 'failure';
  error: { kind: string; detail: string };
  latency_ms: number;
}

export type MicroResponse<T> = MicroSuccess<T> | MicroFailure;

// ─── 2. 配置 ───

export interface PhysicalExecutionConfig {
  /** 微服务 Base URL —— UDS 模式：http+unix:///var/run/dsh-physical.sock/v1
   *  TCP 模式：http://127.0.0.1:8421/v1 */
  baseUrl: string;
  /** 单步墙钟上限（毫秒）—— 复用 D-7 PipelineConfig.attemptTimeoutMs */
  timeoutMs: number;
  /** 健康检查间隔（毫秒），0 = 启动时探一次即可 */
  healthCheckIntervalMs?: number;
  /** HMAC 密钥落盘路径（与 Python 端 auth.key_path 一致） */
  keyPath: string;
  /** Cap Token TTL（秒）—— 复用 Python 端 token_ttl_seconds */
  tokenTtlSeconds?: number;
  /** 本进程 PID（铸 token 时写入 payload；缺省 = process.pid） */
  pid?: number;
  /** 鉴权开关：false = 不发 X-Cap-Token（仅诊断模式，配合 Python 端 disabled 后端） */
  enableAuth?: boolean;
  /** 默认能力位图：缺省 = ALL_CAPS（全权 token） */
  defaultCaps?: readonly Capability[];
}

// ─── 3. 能力位图（镜像 Python auth.ALL_CAPS）───

export type Capability =
  | 'click' | 'type' | 'scroll' | 'hotkey' | 'drag'
  | 'screenshot' | 'ui_tree' | 'switch_window' | 'shm_delete';

export const ALL_CAPS: readonly Capability[] = [
  'click', 'type', 'scroll', 'hotkey', 'drag',
  'screenshot', 'ui_tree', 'switch_window', 'shm_delete',
] as const;

// ─── 4. 响应 DTO（镜像 Python 端 routes 响应）───

export interface HealthInfo {
  status: 'ok';
  version: string;
  platform: 'darwin' | 'win32' | 'linux';
  python: string;
  screen: { width: number; height: number } | { error: string };
  capabilities: string[];
  switch_window_method: 'native' | 'hotkey_only' | 'unavailable';
  ui_funnel: {
    l1_tree: 'available' | 'unavailable';
    l2_ocr: 'available' | 'unavailable';
    l3_vlm: string;
    l3_arbitration_enabled: boolean;
  };
  screenshot_transport: 'shm' | 'mmap-file' | 'base64';
  auth: { pid_attestation: boolean; capability_token: boolean };
}

export interface ClickResult {
  pixel: { x: number; y: number };
  screen: { width: number; height: number };
}

export interface TypeResult { typed_chars: number; }
export interface ScrollResult { scrolled: number; }
export interface HotkeyResult { pressed: string[]; }
export interface DragResult {
  start_pixel: { x: number; y: number };
  end_pixel: { x: number; y: number };
}

export interface ScreenshotResult {
  transport: 'shm' | 'mmap-file' | 'base64';
  /** shm 模式：shm 对象名；mmap-file 模式：文件路径；base64 模式：空串 */
  name: string;
  size: number;
  shape: [number, number, number]; // [height, width, channels]
  dtype: string;
  stride: number;
  format: string;
  width: number;
  height: number;
  captured_at: number;
  /** 仅 base64 模式：内联图像字节 */
  image_base64: string;
}

export interface UIElement {
  source: 'L1-tree' | 'L2-ocr' | 'L3-vlm' | null;
  role: string;
  name: string;
  state?: 'enabled' | 'disabled' | 'masked' | 'checked' | 'unchecked' | null;
  rect: { x: number; y: number; width: number; height: number };
}

export interface UiTreeResult {
  elements: UIElement[];
  funnel_depth: 'L1' | 'L2' | 'L3' | 'empty';
  fault: { source: 'L1' | 'L2' | 'L3'; detail: string } | null;
  captured_at: number;
  l3_invoked: boolean;
}

export interface SwitchWindowResult {
  method: 'native' | 'hotkey_only';
  matched: string | null;
  keyword: string;
  next_step?: string;
}

/**
 * ScreenshotHandle 的结构化契约 —— 用于接口定义（避免循环 import）。
 *
 * 真实实现见 `screenshotHandle.ts` 的 `ScreenshotHandle` 类（含 FinalizationRegistry 兜底）。
 * 本接口仅声明调用方需可见的最小表面：read / stream / transfer / release / meta / released。
 *
 * 注：未声明 `[Symbol.asyncDispose]`（需 TS 5.2+ 与 `using` 语法）；显式 release() 即可，
 * 升级 TS 版本后可补充 asyncDispose 实现（不破坏接口）。
 */
export interface ScreenshotHandleLike {
  readonly meta: Readonly<ScreenshotResult>;
  readonly released: boolean;
  read(): Promise<Buffer>;
  stream(): AsyncGenerator<Buffer, void, void>;
  transfer(): Promise<Buffer>;
  release(): Promise<void>;
}

// ─── 5. 适配器接口（D-7 ExecutionStation 的物理躯体对偶）───

export interface PhysicalExecutionAdapter {
  /** 加载层方法（《异常诚实分层契约》第一条）：失败 throw */
  configure(config: PhysicalExecutionConfig): void;

  /**
   * 预热：异步加载 HMAC 密钥。
   *
   * 加载层方法：configure 末尾 fire-and-forget 启动密钥加载，
   * 调用方可显式 ``await adapter.init()`` 确保就绪；未就绪时 call 内 await 兜底。
   * 失败入 Result.error（运行层降级路径，不抛错）。
   */
  init(): Promise<Result<void, PhysicalError>>;

  /** 启动期探活 —— Result 降级，永不抛错 */
  health(): Promise<Result<HealthInfo, PhysicalError>>;

  // 下列方法均运行层（异常诚实第二条）：永不抛错，失败入 Result.error
  clickMouse(args: { x: number; y: number; button?: 'left' | 'right' | 'middle'; dryRun?: boolean }):
    Promise<Result<ClickResult, PhysicalError>>;
  typeText(args: { text: string; clearFirst?: boolean; dryRun?: boolean }):
    Promise<Result<TypeResult, PhysicalError>>;
  scrollPage(args: { direction: 'up' | 'down' | 'left' | 'right'; amount: number; dryRun?: boolean }):
    Promise<Result<ScrollResult, PhysicalError>>;
  pressHotkey(args: { keys: string[]; dryRun?: boolean }):
    Promise<Result<HotkeyResult, PhysicalError>>;
  dragMouse(args: {
    start: { x: number; y: number };
    end: { x: number; y: number };
    dryRun?: boolean;
  }): Promise<Result<DragResult, PhysicalError>>;
  takeScreenshot(args?: {
    format?: 'png' | 'jpeg';
    quality?: number;
    region?: { x: number; y: number; width: number; height: number };
  }): Promise<Result<ScreenshotResult, PhysicalError>>;
  /** 截图并返回 RAII 资源句柄 —— 调用方无需自行管 readShm/releaseShm */
  takeScreenshotHandle(args?: {
    format?: 'png' | 'jpeg';
    quality?: number;
    region?: { x: number; y: number; width: number; height: number };
  }): Promise<Result<ScreenshotHandleLike, PhysicalError>>;
  getUiTree(args?: {
    source?: 'auto' | 'tree' | 'ocr' | 'vlm';
    region?: { x: number; y: number; width: number; height: number };
    funnelCeiling?: 'L1' | 'L2' | 'L3';
  }): Promise<Result<UiTreeResult, PhysicalError>>;
  switchWindow(args: { keyword: string }):
    Promise<Result<SwitchWindowResult, PhysicalError>>;

  /** 显式释放 shm 对象（Node 端读完截图后调用） */
  releaseShm(name: string): Promise<Result<{ released: boolean }, PhysicalError>>;

  /** 生命周期归零 */
  reset(): void;
}

// ─── 6. SandboxAction 路由契约（D-7 SandboxAction → 微服务调用）───

export interface PhysicalActionRouter {
  /** 运行层方法：永不抛错 —— 失败入 ExecutionResult.failure */
  dispatch(action: SandboxAction, seq: number): Promise<ExecutionResult>;
}
