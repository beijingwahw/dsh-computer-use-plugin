"""配置加载 —— 环境变量 + 显式参数的双源合并。

铁律对齐：
  - 加载层（``configure``/``__init__``）throw 合法（异常诚实第一条）
  - 运行层绝不抛错（异常诚实第二条）
  - 魔法数字一律不落代码常量（config-driven 铁律，对齐 D-6 PipelineConfig 哲学）
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal


@dataclass(frozen=True)
class ServerConfig:
    """服务监听配置 —— UDS 优先，TCP 降级。"""

    transport: Literal["uds", "tcp"] = "uds"
    uds_path: str = "/var/run/dsh-physical.sock"
    tcp_host: str = "127.0.0.1"
    tcp_port: int = 8421
    # 绑定 0.0.0.0 = 安全自杀（铁律：绝不开放外部网络）
    allow_external: bool = False


@dataclass(frozen=True)
class AuthConfig:
    """三层纵深认证配置。

    - ``enable_pid_attestation``：Linux 可做 /proc 白名单校验，Win/Mac 无此层
      （J 纪元修正：dataclass 缺省与 env 加载缺省对齐为 ``platform=='linux'``，
      旧实现两处不一致）
    - ``token_ttl_seconds``：Cap Token 生命周期（60s 缺省）
    - ``key_path``：HMAC 密钥落盘路径，权限 0600
    """

    enable_pid_attestation: bool = sys.platform == "linux"
    token_ttl_seconds: int = 60
    key_path: str = str(Path.home() / ".dsh" / "physical.key")
    allow_no_token_endpoints: frozenset[str] = frozenset({"/v1/health"})


@dataclass(frozen=True)
class ScreenshotConfig:
    """截图传输：shm 优先 → mmap 文件 → base64 兜底。"""

    transport: Literal["shm", "mmap-file", "base64"] = "shm"
    shm_prefix: str = "dsh-shot-"
    mmap_dir: str = str(Path.home() / ".dsh" / "shots")
    jpeg_quality: int = 85  # 0-100，仅 jpeg 生效
    # ΑΩ-R26：mmap-file 磁盘配额（MB）。仅约束 mmap-file 传输（POSIX shm 无磁盘
    # 占用）；0 = 关闭配额。注册新 handle 时检查 + 定期盘点，超过则兜底回收。
    mmap_quota_mb: int = 512
    # ΝΩ-51：捕获后端 —— gdi（缺省，兼容铁律：默认路径行为零变化）| dxgi
    # （Desktop Duplication，ctypes 零新依赖；缺席/失败由 screen.py 诚实降级
    # gdi 并 note 申报）。dxgi_acquire_timeout_ms：AcquireNextFrame 首参，
    # 0 = 不等待（静屏复用上一帧 —— 对截图语义即当前屏幕），首抓自带兜底
    # 重试（见 dxgi_capture.py grab）。
    backend: Literal["gdi", "dxgi"] = "gdi"
    dxgi_acquire_timeout_ms: int = 0


@dataclass(frozen=True)
class ActionConfig:
    """物理动作参数。"""

    step_timeout_ms: int = 10_000         # 单步墙钟上限（对齐 D-7 attemptTimeoutMs）
    mouse_move_duration_ms: int = 300     # pyautogui 平滑移动时长
    pause_after_action_ms: int = 50       # 动作后 settle 时间


@dataclass(frozen=True)
class FunnelConfig:
    """UI 树读取漏斗配置（L1+L2+L3 反双盲仲裁）。"""

    arbitration_enabled: bool = True   # L1/L2 一致时不调 L3
    l1_backend: Literal["auto", "quartz", "uiautomation", "xlib", "disabled"] = "auto"
    l2_backend: Literal["rapidocr", "disabled"] = "rapidocr"
    l3_backend: Literal["local-llama", "remote-doubao", "stub", "disabled"] = "stub"
    l3_model_path: str = ""             # 本地 VLM 模型路径
    l3_remote_endpoint: str = ""         # 远程 VLM endpoint
    l3_remote_api_key_env: str = "DSH_VLM_API_KEY"  # 密钥从环境变量读
    ocr_languages: list[str] = field(default_factory=lambda: ["en", "ch"])


@dataclass(frozen=True)
class WindowConfig:
    """窗口管理三栈：原生 → hotkey → unavailable。"""

    backend: Literal["auto", "osascript", "pygetwindow", "wmctrl", "hotkey-only", "disabled"] = "auto"


@dataclass(frozen=True)
class AndroidConfig:
    """W4-5 L1 移动 Surface —— scrcpy/ADB 设备入列虚拟显示器。

    真机缺席的诚实降级全部由本配置驱动：``enabled=False`` 时控制器不
    发任何子进程调用，``/v1/devices`` 返回空清单 + ``degraded`` 标记。
    帧源降级链：scrcpy（≥ ``scrcpy_min_version``，``--screenshot`` 经设备
    编码器取帧，带宽受 ``scrcpy_max_frame_size`` 约束）→ 缺席/失败降级
    ``adb exec-out screencap`` 单帧。
    """

    enabled: bool = True
    adb_path: str = "adb"
    scrcpy_path: str = "scrcpy"
    command_timeout_ms: int = 15_000        # 单条 adb/scrcpy 子进程墙钟上限
    scrcpy_min_version: str = "2.0.0"       # --screenshot 自 v2.0 起可用
    scrcpy_max_frame_size: int = 1280       # scrcpy --max-size（带宽门控的第一道）
    long_press_threshold_ms: int = 600      # 按 ≥ 此时长 = 长按（Android 惯例）
    long_press_min_px: int = 8              # 位移低于此像素视为原地（长按候选）
    swipe_duration_ms: int = 300            # drag/swipe 缺省时长
    scroll_px_per_tick: int = 120           # host 滚轮 1 tick 的设备像素换算
    clear_first_backspaces: int = 64        # clear_first 的退格近似（设备无 Ctrl+A）
    resolution_cache_s: float = 30.0        # wm size 结果缓存 TTL


@dataclass(frozen=True)
class ExecutorConfig:
    """ΑΩ-R25 专属执行器隔离 —— 按控制器分池的有界 ThreadPoolExecutor 容量。

    取值论证（完整版见 executors.py 模块头注）：
      - ``input_workers=2``：物理动作被 ``_io_lock`` 串行化，第 2 worker 只为
        探针/尺寸读取不排在长 typewrite 后；更多 = 乱序注入风险。
      - ``screen_workers=4``：PIL 编码/显著度是 CPU-bound（单次 100-500ms），
        4 覆盖同场竞争又不超订典型 4-8 核宿主。
      - ``device_workers=6``：adb（15s 超时）/串口/cv2 首帧等长阻塞 I/O，
        阻塞线程不占 CPU —— 容忍多路同时挂起互不排队。
      - ``tree_workers=2``：OCR/VLM 重 CPU+内存，>2 并发互相拖慢（引擎内锁
        串行化），2 即饱和。
    """

    input_workers: int = 2
    screen_workers: int = 4
    device_workers: int = 6
    tree_workers: int = 2


@dataclass(frozen=True)
class RawInputConfig:
    """ΝΩ-53：Raw Input 事件驱动输入镜像（默认关闭 —— 零回归铁律）。

    - ``enabled``：``DSH_PHYSICAL_RAW_INPUT=1`` 显式开启。关闭时
      rawinput 模块对 cursor/routes 完全透明（回退既有 Win32 轮询路径）。
    - ``stale_after_s``：镜像陈旧度门 —— ``updated_at`` 距今超过即判陈旧，
      调用方回退 Win32 调用并诚实注记（SetCursorPos 类程序性移动不产生
      Raw Input 事件，陈旧门是诚实设计的一部分）。
    - ``ring_capacity``：输入事件环容量（/v1/input_events 审计面）。
    - ``event_window_s``：/v1/input_events 只读回看窗口（最近 N 秒）。
    """

    enabled: bool = False
    stale_after_s: float = 2.0
    ring_capacity: int = 128
    event_window_s: float = 1.0


@dataclass(frozen=True)
class AppConfig:
    """应用配置根。所有字段的唯一事实源。"""

    server: ServerConfig = field(default_factory=ServerConfig)
    auth: AuthConfig = field(default_factory=AuthConfig)
    screenshot: ScreenshotConfig = field(default_factory=ScreenshotConfig)
    actions: ActionConfig = field(default_factory=ActionConfig)
    funnel: FunnelConfig = field(default_factory=FunnelConfig)
    window: WindowConfig = field(default_factory=WindowConfig)
    android: AndroidConfig = field(default_factory=AndroidConfig)
    # ΑΩ-R25：专属执行器容量（缺省见 ExecutorConfig —— 惰性建池的兜底同值）
    executors: ExecutorConfig = field(default_factory=ExecutorConfig)
    # ΝΩ-53：Raw Input 输入镜像（默认关闭 —— enabled=False 时全链路零变化）
    raw_input: RawInputConfig = field(default_factory=RawInputConfig)


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as e:
        raise ValueError(f"env {name} must be int, got {raw!r}") from e


def _is_loopback_host(host: str) -> bool:
    """host 是否回环（localhost / ::1 / 127.0.0.0/8）。"""
    h = host.strip().strip("[]").lower()
    return h == "localhost" or h == "::1" or h.startswith("127.")


def load_config_from_env() -> AppConfig:
    """从环境变量加载配置。

    加载层方法（异常诚实第一条）：校验失败 ``raise`` —— 拒绝带病上线。
    环境变量名一律前缀 ``DSH_PHYSICAL_`` 防冲突。
    """
    # ── server ──
    transport_raw = _env("DSH_PHYSICAL_TRANSPORT", "uds").lower()
    if transport_raw not in {"uds", "tcp"}:
        raise ValueError(f"DSH_PHYSICAL_TRANSPORT must be 'uds' or 'tcp', got {transport_raw!r}")
    server = ServerConfig(
        transport=transport_raw,  # type: ignore[arg-type]
        uds_path=_env("DSH_PHYSICAL_UDS_PATH", "/var/run/dsh-physical.sock"),
        tcp_host=_env("DSH_PHYSICAL_TCP_HOST", "127.0.0.1"),
        tcp_port=_env_int("DSH_PHYSICAL_TCP_PORT", 8421),
        allow_external=_env_bool("DSH_PHYSICAL_ALLOW_EXTERNAL", False),
    )
    if server.allow_external and server.transport == "tcp":
        # 安全铁律：开发者显式开启外部绑定 = 自杀，必须显式 ack 危险
        if not _env_bool("DSH_PHYSICAL_I_KNOW_THIS_IS_DANGEROUS", False):
            raise ValueError(
                "DSH_PHYSICAL_ALLOW_EXTERNAL=true requires DSH_PHYSICAL_I_KNOW_THIS_IS_DANGEROUS=true "
                "(explicitly acknowledging you are binding to a public interface)"
            )
    if server.transport == "tcp" and not server.allow_external:
        # 安全铁律堵口：不经 allow_external 险确认，TCP host 只允许回环 ——
        # 否则 DSH_PHYSICAL_TCP_HOST=0.0.0.0 可直接绕过上面的显式 ack 开外网
        if not _is_loopback_host(server.tcp_host):
            raise ValueError(
                f"DSH_PHYSICAL_TCP_HOST={server.tcp_host!r} is not loopback; binding a non-"
                "loopback interface requires DSH_PHYSICAL_ALLOW_EXTERNAL=true + "
                "DSH_PHYSICAL_I_KNOW_THIS_IS_DANGEROUS=true"
            )

    # ── auth ──
    auth = AuthConfig(
        enable_pid_attestation=_env_bool("DSH_PHYSICAL_PID_ATTESTATION", sys.platform == "linux"),
        token_ttl_seconds=_env_int("DSH_PHYSICAL_TOKEN_TTL", 60),
        key_path=_env("DSH_PHYSICAL_KEY_PATH", str(Path.home() / ".dsh" / "physical.key")),
    )

    # ── screenshot ──
    shot_transport_raw = _env("DSH_PHYSICAL_SHOT_TRANSPORT", "shm" if sys.platform != "win32" else "mmap-file").lower()
    if shot_transport_raw not in {"shm", "mmap-file", "base64"}:
        raise ValueError(f"DSH_PHYSICAL_SHOT_TRANSPORT invalid: {shot_transport_raw!r}")
    # ΝΩ-51：捕获后端分流项（缺省 gdi —— 默认路径零变化）
    shot_backend_raw = _env("DSH_PHYSICAL_SHOT_BACKEND", "gdi").lower()
    if shot_backend_raw not in {"gdi", "dxgi"}:
        raise ValueError(f"DSH_PHYSICAL_SHOT_BACKEND must be 'gdi' or 'dxgi', got {shot_backend_raw!r}")
    screenshot = ScreenshotConfig(
        transport=shot_transport_raw,  # type: ignore[arg-type]
        shm_prefix=_env("DSH_PHYSICAL_SHM_PREFIX", "dsh-shot-"),
        mmap_dir=_env("DSH_PHYSICAL_MMAP_DIR", str(Path.home() / ".dsh" / "shots")),
        jpeg_quality=max(0, min(100, _env_int("DSH_PHYSICAL_JPEG_QUALITY", 85))),
        # ΑΩ-R26：负值在此拒绝（clamp 到 0 会静默关掉配额 —— 配置面不许撒谎）
        mmap_quota_mb=_env_int("DSH_PHYSICAL_MMAP_QUOTA_MB", 512),
        # ΝΩ-51：backend 显式开启才走 DXGI DDA；负超时拒绝（clamp 会撒谎）
        backend=shot_backend_raw,  # type: ignore[arg-type]
        dxgi_acquire_timeout_ms=max(0, _env_int("DSH_PHYSICAL_DXGI_TIMEOUT_MS", 0)),
    )

    # ── actions ──
    actions = ActionConfig(
        step_timeout_ms=_env_int("DSH_PHYSICAL_STEP_TIMEOUT_MS", 10_000),
        mouse_move_duration_ms=_env_int("DSH_PHYSICAL_MOUSE_MOVE_MS", 300),
        pause_after_action_ms=_env_int("DSH_PHYSICAL_PAUSE_AFTER_MS", 50),
    )

    # ── funnel ──
    l3_backend_raw = _env("DSH_PHYSICAL_L3_BACKEND", "stub").lower()
    if l3_backend_raw not in {"local-llama", "remote-doubao", "stub", "disabled"}:
        raise ValueError(f"DSH_PHYSICAL_L3_BACKEND invalid: {l3_backend_raw!r}")
    l1_backend_raw = _env("DSH_PHYSICAL_L1_BACKEND", "auto").lower()
    if l1_backend_raw not in {"auto", "quartz", "uiautomation", "xlib", "disabled"}:
        raise ValueError(f"DSH_PHYSICAL_L1_BACKEND invalid: {l1_backend_raw!r}")
    l2_backend_raw = _env("DSH_PHYSICAL_L2_BACKEND", "rapidocr").lower()
    if l2_backend_raw not in {"rapidocr", "disabled"}:
        raise ValueError(f"DSH_PHYSICAL_L2_BACKEND invalid: {l2_backend_raw!r}")
    # J 纪元补全：l1/l2/ocr_languages/l3 api-key env 此前声明了配置项却无环境变量绑定
    # （永远 dataclass 默认 —— 配置面撒谎）。现在全部接入，逗号分隔解析语言表。
    ocr_langs_raw = _env("DSH_PHYSICAL_OCR_LANGUAGES", "en,ch")
    ocr_languages = [s.strip() for s in ocr_langs_raw.split(",") if s.strip()]
    funnel = FunnelConfig(
        arbitration_enabled=_env_bool("DSH_PHYSICAL_ARBITRATION", True),
        l1_backend=l1_backend_raw,  # type: ignore[arg-type]
        l2_backend=l2_backend_raw,  # type: ignore[arg-type]
        l3_backend=l3_backend_raw,  # type: ignore[arg-type]
        l3_model_path=_env("DSH_PHYSICAL_L3_MODEL_PATH", ""),
        l3_remote_endpoint=_env("DSH_PHYSICAL_L3_ENDPOINT", ""),
        l3_remote_api_key_env=_env("DSH_PHYSICAL_L3_API_KEY_ENV", "DSH_VLM_API_KEY"),
        ocr_languages=ocr_languages,
    )

    # ── window ──
    window = WindowConfig(
        backend=_env("DSH_PHYSICAL_WINDOW_BACKEND", "auto").lower(),  # type: ignore[arg-type]
    )

    # ── android（W4-5 移动 Surface）──
    def _env_float(name: str, default: float) -> float:
        raw = os.environ.get(name)
        if raw is None:
            return default
        try:
            return float(raw)
        except ValueError as e:
            raise ValueError(f"env {name} must be float, got {raw!r}") from e

    android = AndroidConfig(
        enabled=_env_bool("DSH_PHYSICAL_ANDROID_ENABLED", True),
        adb_path=_env("DSH_PHYSICAL_ANDROID_ADB_PATH", "adb"),
        scrcpy_path=_env("DSH_PHYSICAL_ANDROID_SCRCPY_PATH", "scrcpy"),
        command_timeout_ms=_env_int("DSH_PHYSICAL_ANDROID_CMD_TIMEOUT_MS", 15_000),
        scrcpy_min_version=_env("DSH_PHYSICAL_ANDROID_SCRCPY_MIN_VERSION", "2.0.0"),
        scrcpy_max_frame_size=max(64, _env_int("DSH_PHYSICAL_ANDROID_SCRCPY_MAX_SIZE", 1280)),
        long_press_threshold_ms=_env_int("DSH_PHYSICAL_ANDROID_LONG_PRESS_MS", 600),
        long_press_min_px=max(0, _env_int("DSH_PHYSICAL_ANDROID_LONG_PRESS_MIN_PX", 8)),
        swipe_duration_ms=_env_int("DSH_PHYSICAL_ANDROID_SWIPE_MS", 300),
        scroll_px_per_tick=max(1, _env_int("DSH_PHYSICAL_ANDROID_SCROLL_PX_PER_TICK", 120)),
        clear_first_backspaces=max(0, _env_int("DSH_PHYSICAL_ANDROID_CLEAR_BACKSPACES", 64)),
        resolution_cache_s=_env_float("DSH_PHYSICAL_ANDROID_RESOLUTION_TTL_S", 30.0),
    )

    # ── executors（ΑΩ-R25 专属执行器隔离：四池容量，max(1,·) 防零/负值）──
    executors_cfg = ExecutorConfig(
        input_workers=max(1, _env_int("DSH_PHYSICAL_EXEC_INPUT_WORKERS", 2)),
        screen_workers=max(1, _env_int("DSH_PHYSICAL_EXEC_SCREEN_WORKERS", 4)),
        device_workers=max(1, _env_int("DSH_PHYSICAL_EXEC_DEVICE_WORKERS", 6)),
        tree_workers=max(1, _env_int("DSH_PHYSICAL_EXEC_TREE_WORKERS", 2)),
    )

    # ── raw input（ΝΩ-53：事件驱动输入镜像，默认关闭零回归；环容量 max(1,·)）──
    raw_input_cfg = RawInputConfig(
        enabled=_env_bool("DSH_PHYSICAL_RAW_INPUT", False),
        stale_after_s=_env_float("DSH_PHYSICAL_RAW_INPUT_STALE_S", 2.0),
        ring_capacity=max(1, _env_int("DSH_PHYSICAL_RAW_INPUT_RING_CAPACITY", 128)),
        event_window_s=_env_float("DSH_PHYSICAL_RAW_INPUT_EVENT_WINDOW_S", 1.0),
    )

    return AppConfig(
        server=server,
        auth=auth,
        screenshot=screenshot,
        actions=actions,
        funnel=funnel,
        window=window,
        android=android,
        executors=executors_cfg,
        raw_input=raw_input_cfg,
    )
