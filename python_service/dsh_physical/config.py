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

    - ``enable_pid_attestation``：Linux 可用 ``SO_PEERPID``，Win/Mac 自动降级到 Layer 1+3
    - ``token_ttl_seconds``：Cap Token 生命周期（60s 缺省）
    - ``key_path``：HMAC 密钥落盘路径，权限 0600
    """

    enable_pid_attestation: bool = True
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


@dataclass(frozen=True)
class ActionConfig:
    """物理动作参数。"""

    step_timeout_ms: int = 10_000         # 单步墙钟上限（对齐 D-7 attemptTimeoutMs）
    mouse_move_duration_ms: int = 300     # pyautogui 平滑移动时长
    pause_after_action_ms: int = 50       # 动作后 settle 时间
    fail_safe_corner: tuple[int, int] = (0, 0)  # pyautogui FAILSAFE 鼠标到角落中止


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
class AppConfig:
    """应用配置根。所有字段的唯一事实源。"""

    server: ServerConfig = field(default_factory=ServerConfig)
    auth: AuthConfig = field(default_factory=AuthConfig)
    screenshot: ScreenshotConfig = field(default_factory=ScreenshotConfig)
    actions: ActionConfig = field(default_factory=ActionConfig)
    funnel: FunnelConfig = field(default_factory=FunnelConfig)
    window: WindowConfig = field(default_factory=WindowConfig)


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
    screenshot = ScreenshotConfig(
        transport=shot_transport_raw,  # type: ignore[arg-type]
        shm_prefix=_env("DSH_PHYSICAL_SHM_PREFIX", "dsh-shot-"),
        mmap_dir=_env("DSH_PHYSICAL_MMAP_DIR", str(Path.home() / ".dsh" / "shots")),
        jpeg_quality=max(0, min(100, _env_int("DSH_PHYSICAL_JPEG_QUALITY", 85))),
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
    funnel = FunnelConfig(
        arbitration_enabled=_env_bool("DSH_PHYSICAL_ARBITRATION", True),
        l3_backend=l3_backend_raw,  # type: ignore[arg-type]
        l3_model_path=_env("DSH_PHYSICAL_L3_MODEL_PATH", ""),
        l3_remote_endpoint=_env("DSH_PHYSICAL_L3_ENDPOINT", ""),
    )

    # ── window ──
    window = WindowConfig(
        backend=_env("DSH_PHYSICAL_WINDOW_BACKEND", "auto").lower(),  # type: ignore[arg-type]
    )

    return AppConfig(
        server=server,
        auth=auth,
        screenshot=screenshot,
        actions=actions,
        funnel=funnel,
        window=window,
    )
