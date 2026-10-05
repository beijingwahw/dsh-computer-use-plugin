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
  /** ΠΑΝ-128（镜像 ΠΑΝ-95）：设备级失败（adb 离线/未授权/USB 抖动）——
   *  高频可预期失败，Node 端可据此与 internal_error 区分做重试/重连策略 */
  | 'device_unreachable'
  /** ΠΑΝ-128（镜像 ΠΑΝ-93）：池背压拒绝（队列深度达上界）——不是失败是"忙"，
   *  调用方按退避重试（排队被拒时尚未开始执行，无部分副作用） */
  | 'busy'
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
  // ΠΑΝ-128: 与 Python 端 errors.py ErrorKind 闭集对齐（additive —— 旧 kind 语义不变）
  DEVICE_UNREACHABLE: 'device_unreachable' as PhysicalErrorKind,
  BUSY: 'busy' as PhysicalErrorKind,
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
  | 'screenshot' | 'ui_tree' | 'switch_window' | 'shm_delete'
  // ΠΑΝ-128（镜像 ΠΑΝ-25）：管理面能力位 —— shutdown 独立 admin 位（关停是
  // 最高权动作，与读写动作位隔离）；stats/input_events/devices 归 observe
  // （只读观测；input_events 是键盘 vk 审计流，敏感度独立于截图位）。
  // additive：既有九位语义不变；全权 token（ALL_CAPS）自此含新位。
  | 'admin' | 'observe';

export const ALL_CAPS: readonly Capability[] = [
  'click', 'type', 'scroll', 'hotkey', 'drag',
  'screenshot', 'ui_tree', 'switch_window', 'shm_delete',
  // ΠΑΝ-128: 与 Python auth.ALL_CAPS 闭集同源镜像（程序化对账：test/pan128.capContract.test.ts）
  'admin', 'observe',
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
  /** ΠΑΝ-128: auth 面增补 attestation_mode（镜像 Python 端 auth.attestation_mode()
   *  的诚实形态申报：proc_* / win_* 为真实信号，loopback_hmac_only 为降级）。
   *  可选字段 —— 旧服务无此键照常工作（防御解析容忍缺席）。
   *  ΠΑΝ-127: 注释内星斜线序列曾提前终结块注释致 tsc 解析失败——已改写
   *  （纯注释文本修复，行为零变化）。 */
  auth: { pid_attestation: boolean; capability_token: boolean; attestation_mode?: string };
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

/** 移动鼠标（无点击）—— Z-1 交互性探针的悬停躯体 */
export interface MoveResult {
  pixel: { x: number; y: number };
}

/**
 * 当前全局光标形态 —— OS 对「指针下是什么」的原生判决。
 * hand=可点击热区；ibeam=可选择文本（正文/聊天消息）；
 * arrow/custom=未知（原生按钮常保持箭头，需悬停重绘旁证）。
 */
export interface CursorKindInfo {
  kind: 'arrow' | 'ibeam' | 'hand' | 'wait' | 'busy' | 'resize' | 'cross'
    | 'unavailable' | 'hidden' | 'custom' | 'error' | 'unsupported';
  handle?: number;
  detail?: string;
  platform?: string;
}

/**
 * UIA 单点结构查询（Z-1 第三通道：判别力天花板）。
 * classification：control=命中交互控件（含祖先链）；text=Text/Edit/Document
 * 且无交互祖先；unknown=Pane/Custom 等（交回悬停双通道）；
 * unavailable=库缺席/COM 失败/l1 门控关闭。
 */
export interface HitTestResult {
  available: boolean;
  control_type?: string | null;
  name?: string;
  matched_depth?: number | null;
  chain?: Array<{ type: string; name: string; depth: number }>;
  classification: 'control' | 'text' | 'unknown' | 'unavailable';
  reason?: string;
  pixel?: { x: number; y: number };
}

export interface ScreenshotResult {
  transport: 'shm' | 'mmap-file' | 'base64' | 'none';
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
  /** ── D-1 工具层接线扩展（服务端计算，无原生图像依赖）── */
  /** 干净帧（无叠加层）dHash —— 变化门控 / 前后对比 */
  dhash?: string | null;
  /** 干净帧 pHash（DCT 频谱第二指纹） */
  phash?: string | null;
  /** want_region_hash 请求的区域 dHash */
  region_dhash?: string | null;
  /** gate 命中（屏幕未变）—— 此时无图像句柄 */
  unchanged?: boolean;
  /** keep_frame 帧环 id（frame_stats / frame_diff 引用锚） */
  frame_id?: number | null;
  frame_count?: number;
  /** Y-1/Y-2：块级梯度熵显著度（zones 热点区/blocks 网格熵/stats） */
  salience?: SalienceMap | null;
}

/** 块级梯度熵显著度图（服务端 PIL 计算） */
export interface SalienceMap {
  zones: Array<{ x: number; y: number; width: number; height: number; entropy: number }>;
  blocks: number[];
  stats: { mean: number; std: number; max: number };
}

export interface UIElement {
  source: 'L1-tree' | 'L2-ocr' | 'L3-vlm' | null;
  role: string;
  name: string;
  state?: 'enabled' | 'disabled' | 'masked' | 'checked' | 'unchecked' | null;
  rect: { x: number; y: number; width: number; height: number };
  /** 缝隙闭合：词级真值跨线（PyS）—— L2 RapidOCR 词级置信度，[0,1] 浮点
   *  （python 端已夹取；越界值消费方按消毒律自夹）。L1 结构树 / L3 VLM
   *  路径无分数 ⇒ 键缺席（诚实方言 —— python 端 None 不出键）。可选字段：
   *  防御解析必须容忍缺席（旧服务/旧帧无此字段照常工作）。 */
  score?: number;
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
 * R2-3（焦点保卫）：前台窗口只读探测的结果契约。
 * title=null ⇒ 无前台窗口可读（桌面焦点/枚举拒绝）—— 诚实缺席，调用方
 * 按「不可校验」降级，绝不猜。
 */
export interface ActiveWindowResult {
  method: 'native';
  title: string | null;
}

/**
 * ScreenshotHandle 的结构化契约 —— 用于接口定义（避免循环 import）。
 *
 * 真实实现见 `screenshotHandle.ts` 的 `ScreenshotHandle` 类（含 FinalizationRegistry 兜底）。
 * 本接口仅声明调用方需可见的最小表面：read / stream / transfer / release / meta / released。
 *
 * 注：未声明 `[Symbol.asyncDispose]`（`using` 语法需 TS 5.2+，现行 5.9.3 已满足）；
 * 显式 release() 即可。ΑΩ-R34：旧注释「升级 TS 版本后可补充」的版本前提已过时 ——
 * 是否补充 asyncDispose 属行为面决定，本接口维持未声明（零回归，不破坏接口）。
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
  // ΠΑΝ-64（止损链断裂修复）：全部动作方法增补可选 signal（ExecutionOrder.signal
  // 的下游通道 —— 与内部超时组合断流，消灭「超时后幽灵动作落地」）；
  // 兼容式可选字段，缺席 ⇒ 请求字节与现状等同（兼容铁律）。
  clickMouse(args: { x: number; y: number; button?: 'left' | 'right' | 'middle'; dryRun?: boolean; signal?: AbortSignal }):
    Promise<Result<ClickResult, PhysicalError>>;
  typeText(args: { text: string; clearFirst?: boolean; dryRun?: boolean; signal?: AbortSignal }):
    Promise<Result<TypeResult, PhysicalError>>;
  scrollPage(args: { direction: 'up' | 'down' | 'left' | 'right'; amount: number; dryRun?: boolean; signal?: AbortSignal }):
    Promise<Result<ScrollResult, PhysicalError>>;
  pressHotkey(args: { keys: string[]; dryRun?: boolean; signal?: AbortSignal }):
    Promise<Result<HotkeyResult, PhysicalError>>;
  dragMouse(args: {
    start: { x: number; y: number };
    end: { x: number; y: number };
    dryRun?: boolean;
    signal?: AbortSignal;
  }): Promise<Result<DragResult, PhysicalError>>;
  /** 移动鼠标（无点击）—— Z-1 交互性探针的悬停躯体（归一化坐标） */
  moveMouse(args: {
    x: number; y: number; durationMs?: number; dryRun?: boolean; signal?: AbortSignal;
  }): Promise<Result<MoveResult, PhysicalError>>;
  takeScreenshot(args?: {
    format?: 'png' | 'jpeg';
    quality?: number;
    region?: { x: number; y: number; width: number; height: number };
    overlay?: Record<string, unknown>;
    maxWidth?: number;
    upscale?: number;
    wantHashes?: boolean;
    wantRegionHash?: { x: number; y: number; r: number };
    gate?: { dhashRef: string; distance: number };
    keepFrame?: boolean;
    metaOnly?: boolean;
    wantSalience?: boolean;
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
    /** 外部止损信号（流水线感知步超时 abort）—— 与内部超时组合断流 */
    signal?: AbortSignal;
  }): Promise<Result<UiTreeResult, PhysicalError>>;
  switchWindow(args: { keyword: string; signal?: AbortSignal }):  // ΠΑΝ-64：动作方法同律增补 signal
    Promise<Result<SwitchWindowResult, PhysicalError>>;
  /** R2-3（焦点保卫）：前台窗口标题只读探测（type_text 前置校验的数据源） */
  getActiveWindow(): Promise<Result<ActiveWindowResult, PhysicalError>>;

  // ─── 感知辅助端点（D-1 工具层接线 —— 只读，与截图同能力位）───
  /** 当前鼠标位置（全屏像素）—— SoM 准星与多屏感知的数据源 */
  getCursor(): Promise<Result<{ x: number; y: number }, PhysicalError>>;
  /** 当前全局光标形态（hand/ibeam/arrow/...）—— Z-1 交互性探针的 OS 判决通道 */
  getCursorKind(): Promise<Result<CursorKindInfo, PhysicalError>>;
  /** UIA 单点结构查询 —— Z-1 第三通道（结构层判决，零物理副作用） */
  hitTest(args: { x: number; y: number }): Promise<Result<HitTestResult, PhysicalError>>;
  /** 显示器清单（全屏虚拟坐标系） */
  getDisplays(): Promise<Result<{
    displays: Array<{ name: string; x: number; y: number; width: number; height: number; primary?: boolean }>;
  }, PhysicalError>>;
  /** 缓存帧区域统计（物理规则 / popup 几何传感的躯体） */
  frameStats(frameId: number, regions: Array<{
    x: number; y: number; width: number; height: number;
  }>): Promise<Result<{ frame_id: number; stats: Array<{ mean: number | null; stdev: number | null }> }, PhysicalError>>;
  /** 缓存帧行亮度序列（内容平移检测） */
  frameRowmeans(frameId: number, grid?: number): Promise<Result<{
    frame_id: number; rows: number[];
  }, PhysicalError>>;
  /** 两缓存帧差分 → 变化区域清单 + 可选红框标注 JPEG(base64) */
  frameDiff(args: {
    frameA: number; frameB: number; block?: number; annotate?: boolean;
  }): Promise<Result<{
    frame_a: number; frame_b: number;
    changed_regions: Array<{ x: number; y: number; width: number; height: number }>;
    region_count: number; block_threshold: number;
    annotated_image_base64?: string;
  }, PhysicalError>>;

  /** 显式释放 shm 对象（Node 端读完截图后调用） */
  releaseShm(name: string): Promise<Result<{ released: boolean }, PhysicalError>>;

  /** 生命周期归零 */
  reset(): void;
}

// ─── 6. SandboxAction 路由契约（D-7 SandboxAction → 微服务调用）───

export interface PhysicalActionRouter {
  /** 运行层方法：永不抛错 —— 失败入 ExecutionResult.failure。
   *  ΠΑΝ-64（止损链断裂修复）：第三可选参 signal —— 编排器 ExecutionOrder.signal
   *  经 d7HostPort → dispatch → adapter 动作方法 → microFetch 直达 HTTP 层断流。
   *  兼容式可选参数：既有两参调用方零改动（signal 缺席 ⇒ 旧路径逐字节）。 */
  dispatch(action: SandboxAction, seq: number, signal?: AbortSignal): Promise<ExecutionResult>;
}
