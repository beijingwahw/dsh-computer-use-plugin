"""所有 HTTP 路由 —— FastAPI APIRouter 汇总。

每个端点都包 ``safe_call``：异常诚实铁律的代码化（永不抛 500）。
端点 → capability 映射由 ``auth.ENDPOINT_CAPABILITY`` 定义，中间件统一校验。
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import platform
import sys
import time
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from . import shm as shm_module
from .android import AndroidController, parse_surface_id
from .audio import audio_events_payload
from .auth import ALL_CAPS, attestation_mode, attest_pid_supported
from .config import AppConfig
from .errors import ErrorKind, PhysicalError, safe_call, success
from . import executors as executors_module  # ΝΩ-36：/v1/stats 的池态诊断面
from .executors import (  # ΑΩ-R25 专属执行器:端点层残留的裸 executor 全部归池
    DEVICE_POOL, INPUT_POOL, SCREEN_POOL, TREE_POOL, get as get_pool,
)
from .hid import HidController
from .input import InputController
from . import rawinput as rawinput_module  # ΝΩ-53：事件驱动输入镜像（默认关闭）
from .screen import ScreenCapture, list_displays
from .ui_tree import UIFunnel
from .uvc import UvcController
from .window import WindowManager

router = APIRouter(prefix="/v1")


# ─── Pydantic 请求模型（强类型契约的代码化）───


class ClickRequest(BaseModel):
    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    button: Literal["left", "right", "middle"] = "left"
    dry_run: bool = False
    # W4-5 移动 Surface：'host:<i>' = 第 i 主机显示器（Σ-5 display 的泛化）、
    # 'android:<serial>' = adb 设备。None = 主机现状（兼容铁律）。
    # 畸形 id 由 parse_surface_id 判 INVALID_ARGS（单一事实源，模型不重复校验）。
    surface: str | None = Field(default=None, max_length=256)


class TypeRequest(BaseModel):
    text: str = Field(min_length=0, max_length=10_000)
    clear_first: bool = False
    dry_run: bool = False
    surface: str | None = Field(default=None, max_length=256)  # W4-5


class ScrollRequest(BaseModel):
    direction: Literal["up", "down", "left", "right"]
    amount: int = Field(ge=1, le=1000)
    dry_run: bool = False
    surface: str | None = Field(default=None, max_length=256)  # W4-5


class HotkeyRequest(BaseModel):
    keys: list[str] = Field(min_length=1, max_length=5)
    dry_run: bool = False
    surface: str | None = Field(default=None, max_length=256)  # W4-5


class DragRequest(BaseModel):
    start: dict[str, float]
    end: dict[str, float]
    dry_run: bool = False
    surface: str | None = Field(default=None, max_length=256)  # W4-5


class MoveRequest(BaseModel):
    """鼠标移动（无点击）—— Z-1 交互性探针的悬停躯体。"""

    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    duration_ms: float = Field(default=0.0, ge=0.0, le=2000.0)
    dry_run: bool = False
    surface: str | None = Field(default=None, max_length=256)  # W4-5（android 无悬停概念 → 诚实拒绝）


class HitTestRequest(BaseModel):
    """UIA 点查询（归一化坐标）—— Z-1 第三通道：结构层单点判决。"""

    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)


class RegionSpec(BaseModel):
    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    width: float = Field(gt=0.0, le=1.0)
    height: float = Field(gt=0.0, le=1.0)


class ScreenshotRequest(BaseModel):
    format: Literal["png", "jpeg"] = "png"
    quality: int | None = Field(default=None, ge=0, le=100)
    # J 纪元统一：截图 region 与 UiTree 的 RegionSpec 同一强类型校验
    # （旧实现截图侧是裸 dict，靠 screen._crop_region 手工校验 —— 同概念双轨）
    region: RegionSpec | None = None
    # ── D-1 工具层接线扩展（无原生图像依赖的 Node 端）──
    overlay: dict | None = None          # SoM 叠加层（draw_overlay 契约，全屏归一化坐标）
    max_width: int | None = Field(default=None, ge=64, le=8192)
    upscale: float | None = Field(default=None, ge=1.0, le=8.0)
    want_hashes: bool = False            # 返回干净帧 dhash/phash
    want_region_hash: dict | None = None  # {x, y, r}（全屏归一化）→ 区域 dhash
    gate: dict | None = None             # {dhash_ref, distance} 变化门控
    keep_frame: bool = False             # 干净帧入环（frame_stats/frame_diff 用）
    meta_only: bool = False              # 只取指纹/帧缓存，不编码不传图（轮询用）
    want_salience: bool = False          # 块级梯度熵图（Y-1 中央凹 / Y-2 金字塔）
    # Σ-5 多屏感知：显示器索引（/v1/displays 清单序，0 起）。None = 主屏 = 现状
    # （兼容铁律）。选定后 region/overlay 归一化基准 = 所选显示器矩形；
    # 非 Windows 平台请求 ⇒ 服务端诚实降级主屏并在响应附 note。
    display: int | None = None
    # W4-5 移动 Surface：display 的字符串泛化 —— 'host:<i>' ≡ display=i、
    # 'android:<serial>' 路由到 scrcpy/adb 帧源。与 display 并存时 surface 获胜；
    # region/overlay 归一化基准 = 所选 surface 的矩形（契约不破）。
    surface: str | None = Field(default=None, max_length=256)


class FrameStatsRequest(BaseModel):
    frame_id: int
    regions: list[dict] = Field(default_factory=list)


class FrameRowmeansRequest(BaseModel):
    frame_id: int
    grid: int = Field(default=16, ge=4, le=256)


class FrameDiffRequest(BaseModel):
    frame_a: int
    frame_b: int
    block: int = Field(default=24, ge=8, le=128)
    annotate: bool = False


class UiTreeRequest(BaseModel):
    source: Literal["auto", "tree", "ocr", "vlm"] = "auto"
    region: RegionSpec | None = None
    funnel_ceiling: Literal["L1", "L2", "L3"] = "L3"


class SwitchWindowRequest(BaseModel):
    keyword: str = Field(min_length=1, max_length=200)


# ─── W5-1（W4-6 落盘）：L2 零 API 设备面（UVC 采集卡 / HID 棒）请求模型 ───
# 字段方言对齐 ScreenshotRequest / ClickRequest 等既有模板（归一化 [0,1]
# 契约、dry_run 调用级覆盖、gate 变化门控）—— 硬件缺席 ⇒ 控制器层诚实
# unsupported 信封，模型层不重复校验。


class UvcCaptureRequest(BaseModel):
    """UVC 采集卡取帧请求（W5-1：对齐 ScreenshotRequest 的可用字段子集）。"""
    format: Literal["png", "jpeg"] = "png"
    quality: int | None = Field(default=None, ge=0, le=100)
    region: RegionSpec | None = None
    gate: dict | None = None             # {dhash_ref, distance}（screen.py 同语义）
    want_hashes: bool = False
    max_width: int | None = Field(default=None, ge=64, le=8192)


class HidClickRequest(BaseModel):
    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    button: Literal["left", "right", "middle"] = "left"
    dry_run: bool = False


class HidMoveRequest(BaseModel):
    """HID 绝对移动请求（W5-1）。

    无 ``duration_ms``：HID 绝对鼠标是单帧瞬移（无平滑移动概念）——
    参数缺席即诚实（伪装支持 = 谎报）。
    """
    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    dry_run: bool = False


class HidDragRequest(BaseModel):
    start: dict[str, float]
    end: dict[str, float]
    dry_run: bool = False


class HidScrollRequest(BaseModel):
    direction: Literal["up", "down", "left", "right"]
    amount: int = Field(ge=1, le=1000)
    dry_run: bool = False


class HidHotkeyRequest(BaseModel):
    keys: list[str] = Field(min_length=1, max_length=5)
    dry_run: bool = False


class HidTypeRequest(BaseModel):
    text: str = Field(min_length=0, max_length=10_000)
    clear_first: bool = False
    dry_run: bool = False
    # auto: 纯 ASCII 短文本逐键；长文/非 ASCII 改走 Ctrl+V 粘贴（调用方备剪贴板）
    mode: Literal["auto", "keys", "paste"] = "auto"


# ─── 控制器容器（启动期注入）───

_controllers: dict[str, Any] = {}


def set_controllers(
    input_ctrl: InputController,
    screen_ctrl: ScreenCapture,
    funnel_ctrl: UIFunnel,
    window_ctrl: WindowManager,
    config: AppConfig,
    android_ctrl: AndroidController | None = None,
    uvc: UvcController | None = None,
    hid: HidController | None = None,
) -> None:
    """启动期由 server 注入控制器实例。

    W4-5：``android_ctrl`` 注入移动 Surface 控制器（缺席 = 移动面不可用，
    相关端点诚实降级/拒绝 —— 兼容旧装配路径）。
    W5-1（W4-6 落盘）：``uvc``/``hid`` 注入 L2 零 API 设备面控制器
    （UVC 采集卡 / HID 棒；缺席 = 相关端点诚实拒绝，不影响既有端点）。
    """
    _controllers.clear()
    _controllers.update({
        "input": input_ctrl,
        "screen": screen_ctrl,
        "funnel": funnel_ctrl,
        "window": window_ctrl,
        "config": config,
    })
    if android_ctrl is not None:
        _controllers["android"] = android_ctrl
    if uvc is not None:
        _controllers["uvc"] = uvc
    if hid is not None:
        _controllers["hid"] = hid
    # ΝΩ-53：Raw Input 镜像按配置启动（enabled=False ⇒ no-op 零回归）。
    # best-effort：装配失败不击穿 set_controllers —— 事实留在 rawinput 状态机
    # （describe），调用侧诚实回退轮询。
    try:
        rawinput_module.ensure_started(config.raw_input)
    except Exception as e:  # noqa: BLE001 —— 装配期也不许抛（诚实降级进状态机）
        print(f"[warn] raw-input mirror start failed: {type(e).__name__}: {e}", file=sys.stderr)


def _get(name: str) -> Any:
    if name not in _controllers:
        raise PhysicalError(
            ErrorKind.INTERNAL_ERROR,
            f"controller {name!r} not initialized",
        )
    return _controllers[name]


# ─── W4-5 移动 Surface：surface id 路由（host 显示器 / android 设备）───


def _android_ctrl() -> AndroidController:
    """android 控制器（缺席 = 移动面未装配 ⇒ 诚实拒绝，不静默走主机）。"""
    ctrl = _controllers.get("android")
    if ctrl is None:
        raise PhysicalError(
            ErrorKind.INVALID_ARGS,
            "android surface requested but android controller not initialized "
            "(mobile surface unavailable in this deployment)",
        )
    return ctrl


def _run_android(fn: Any, /, *args: Any) -> Any:
    """android 同步控制器方法 → **device 专属池**（ΑΩ-R25）。

    adb/scrcpy 子进程阻塞（command_timeout 15s 量级）不进事件循环，也
    不再进缺省共享池 —— 否则一台失联设备可拖住截图/输入等其他面。
    """
    return asyncio.get_running_loop().run_in_executor(get_pool(DEVICE_POOL), fn, *args)


# ─── W5-1（W4-6 落盘）：L2 零 API 设备面控制器取用（缺席 = 诚实拒绝）───


def _uvc_ctrl() -> UvcController:
    """uvc 控制器（缺席 = 采集面未装配 ⇒ 诚实失败，不静默降级主机截屏）。"""
    ctrl = _controllers.get("uvc")
    if ctrl is None:
        raise PhysicalError(
            ErrorKind.SCREEN_CAPTURE_FAILED,
            "uvc capture requested but uvc controller not initialized "
            "(capture-card surface unavailable in this deployment)",
        )
    return ctrl


def _hid_ctrl() -> HidController:
    """hid 控制器（缺席 = HID 面未装配 ⇒ 诚实拒绝，不静默改走主机 pyautogui）。"""
    ctrl = _controllers.get("hid")
    if ctrl is None:
        raise PhysicalError(
            ErrorKind.INVALID_ARGS,
            "hid endpoint called but hid controller not initialized "
            "(hid stick unavailable in this deployment)",
        )
    return ctrl


# ─── W5-1（W4-8 落盘）：声学通道缓存态（health 读，/v1/audio_events 写）───
# health 高频探活不得触发 WASAPI 建链 —— 只读此缓存；探测事实由端点首调落账。
_audio_state: dict = {"probed": False, "available": None, "backend": None}


async def _host_remap(display_idx: int | None, x: float, y: float) -> tuple[float, float, str | None]:
    """``host:<i>`` 选定后，归一化坐标换算到 InputController 的主屏基准。

    InputController 以主屏尺寸归一化（pyautogui 坐标 = 全屏虚拟坐标系，
    主屏原点即虚拟原点）⇒ 目标显示器矩形上的 (x,y) 先映射虚拟像素、再除以
    主屏宽高。非 Windows / 越界索引 ⇒ 与 Σ-5 同律：诚实降级主屏 + note
    （Windows 越界 ⇒ INVALID_ARGS —— 枚举是事实源）。
    """
    if display_idx is None:
        return x, y, None
    if platform.system() != "Windows":
        return x, y, (
            f"surface host:{display_idx} ignored: cross-screen input is Windows-only; "
            "degraded to primary"
        )
    screen_ctrl: ScreenCapture = _get("screen")
    displays = await list_displays(screen_ctrl)
    if display_idx < 0 or display_idx >= len(displays):
        raise PhysicalError(
            ErrorKind.INVALID_ARGS,
            f"invalid surface host:{display_idx}: {len(displays)} display(s) enumerated "
            f"(valid indices: 0..{len(displays) - 1})",
        )
    d = displays[display_idx]
    primary = next((p for p in displays if p.get("primary")), displays[0])
    nx = (d["x"] + x * d["width"]) / max(1, primary["width"])
    ny = (d["y"] + y * d["height"]) / max(1, primary["height"])
    return nx, ny, None


def _with_surface(result: dict, surface: str | None, note: str | None) -> dict:
    """动作回执附加 surface 回显与降级 note（仅 surface 请求在场时 —— 兼容铁律）。"""
    if surface is None:
        return result
    out = {**result, "surface": surface}
    if note:
        out["note"] = note
    return out


async def _surfaces_report() -> dict:
    """W4-5：surface 清单（health 的能力申报 —— 永不抛，异常诚实第一条）。

    host：显示器枚举（与 /displays、display 索引同一事实源）；android：控制器
    的清单**缓存**（未探测过 = 尚无事实，如实申报 unknown —— health 高频探活
    不能每次都跑 adb 子进程；现场探测走 /v1/devices）。
    """
    report: dict = {"host": [], "android": [], "android_probed": False}
    try:
        screen_ctrl: ScreenCapture = _get("screen")
        displays = await list_displays(screen_ctrl)
        report["host"] = [f"host:{i}" for i in range(len(displays))]
    except Exception:  # noqa: BLE001 —— health 绝不抛
        report["host"] = []
    android = _controllers.get("android")
    if android is not None:
        try:
            # ΑΩ-R25：android 域读取（纯缓存 dict 拷贝）随 android 面 ⇒ device 池
            cached = await asyncio.get_running_loop().run_in_executor(
                get_pool(DEVICE_POOL), android.cached_inventory,
            )
            if cached is not None:
                report["android"] = [d["surface_id"] for d in cached.get("devices", [])]
                report["android_probed"] = True
                if cached.get("degraded"):
                    report["android_degraded_reason"] = cached.get("reason")
        except Exception:  # noqa: BLE001
            pass
    return report


def _hardware_faces() -> dict:
    """W5-1：uvc/hid/audio 硬件面能力申报（health 永不抛、不阻塞铁律）。

    只读缓存态：uvc/hid 的 ``device_info()`` 为纯读取（backend 未解析 =
    如实报 unresolved，不触发设备打开）；audio 读 ``_audio_state`` 缓存
    （未探测过 = 如实报未探测，不在探活路径上建 WASAPI 链）。
    """
    faces: dict = {}
    uvc = _controllers.get("uvc")
    if uvc is None:
        faces["uvc"] = {"initialized": False,
                        "reason": "uvc controller not assembled (capture-card surface unavailable)"}
    else:
        try:
            faces["uvc"] = {"initialized": True, **uvc.device_info()}
        except Exception as e:  # noqa: BLE001 —— health 绝不抛
            faces["uvc"] = {"initialized": True, "error": f"{type(e).__name__}: {e}"}
    hid = _controllers.get("hid")
    if hid is None:
        faces["hid"] = {"initialized": False,
                        "reason": "hid controller not assembled (hid stick unavailable)"}
    else:
        try:
            faces["hid"] = {"initialized": True, **hid.device_info()}
        except Exception as e:  # noqa: BLE001 —— health 绝不抛
            faces["hid"] = {"initialized": True, "error": f"{type(e).__name__}: {e}"}
    faces["audio"] = dict(_audio_state)
    return faces


# ─── ΤΕΛ-6（D-G28②）：DPI 像素域契约的 /health 申报（ΠΑΝ-81 诊断面接线）───
# pixel_domain_report() 已由 dpi.py 导出（screen.py 再导出 canonical 面），本处
# 是 DEBTS D-G28② 登记的 /health 接线义务的兑现。纪律：
#   · 30s TTL 缓存（surfaces 清单缓存同先例 —— /health 是高频探活端点，ctypes
#     探测链虽纯进程内零 IO，也不逐探活重跑；域漂移由 InputController 的
#     domain_epoch 缓存键独立执法，此处申报面允许 30s 滞后）；
#   · 绝不抛（health 铁律）：dpi 面故障 ⇒ 诚实 absent（{absent, reason}），
#     绝不谎报已统一、也绝不击穿探活。


_pixel_domain_cache: dict[str, Any] = {}
_PIXEL_DOMAIN_TTL_S = 30.0


def _pixel_domain_face() -> Any:
    """DPI 像素域申报（30s TTL 缓存；任何异常 ⇒ 诚实 absent，绝不抛）。"""
    now = time.monotonic()
    cached_at = _pixel_domain_cache.get("at")
    if isinstance(cached_at, (int, float)) and now - float(cached_at) < _PIXEL_DOMAIN_TTL_S:
        return _pixel_domain_cache.get("report")
    try:
        from .dpi import pixel_domain_report  # canonical 路径（screen.py 仅再导出）

        report: Any = pixel_domain_report()
    except Exception as e:  # noqa: BLE001 —— health 绝不抛
        report = {"absent": True, "reason": f"{type(e).__name__}: {e}"}
    _pixel_domain_cache.clear()
    _pixel_domain_cache["at"] = now
    _pixel_domain_cache["report"] = report
    return report


# ─── /v1/health：探活（无需 Cap Token，由 auth.allow_no_token_endpoints 放行）───


@router.get("/health")
async def health(nonce: str | None = None) -> dict:
    """健康检查 —— 返回服务能力声明。

    无需认证（``allow_no_token_endpoints``）；用于 Node 端启动期探活。

    纪元 Σ：nonce 质询应答式身份证明 —— ``nonce`` query 参数在场且非空时，
    用共享密钥对其做 HMAC-SHA256 回签（``data['proof']``）。Node 端验签即证
    应答者持有本回合密钥 —— 占坑者无密钥即现形（根治 Windows Python 启动器
    re-exec 形态下「spawn pid ≠ 上报 pid」被误判 port_squatted 的盲区）。
    回签不泄密钥（HMAC 单向），/health 仍免鉴权（nonce 本身就是挑战）。
    老版 Node 端不发 nonce ⇒ 无 proof 字段，走既有 pid 判定（向后兼容）。
    """
    import os
    import sys
    import platform

    input_ctrl: InputController = _get("input")
    screen_ctrl: ScreenCapture = _get("screen")
    window_ctrl: WindowManager = _get("window")
    config: AppConfig = _get("config")

    # J 纪元修正：screen 字段必须与 TS 契约 HealthInfo.screen 对齐
    # （``{width,height}`` 或 ``{error}``）。旧实现误用 input_ctrl 的
    # tuple 版本 ``get_screen_size()`` —— 序列化成 ``[w, h]`` 数组，
    # Node 端 d7HostPort 解出 ``{width: undefined}`` → 归一化产出 NaN 坐标。
    screen_info: dict = {}
    try:
        screen_info = await screen_ctrl.get_screen_size()
    except PhysicalError as e:
        screen_info = {"error": e.detail}

    data = {
        "status": "ok",
        # 纪元 Δ：进程身份证明 —— Node 端探活从「2xx 即收」升级为包体校验，
        # 用本 pid 判定应答者确为 spawn 的子进程（端口占坑者给不出吻合 pid）。
        # 老版本 Node 端忽略此字段，向后兼容。Σ 纪元：启动器 re-exec 形态下
        # 此 pid 会漂移 —— 由上方 nonce 回签兜底（密钥持有即自己人）。
        "pid": os.getpid(),
        "version": "0.4.0",
        "platform": sys.platform,
        "python": platform.python_version(),
        "screen": screen_info,
        # W4-5 移动 Surface：能力申报 —— host 显示器 + android 设备统一入列
        # 虚拟显示器（surface id 方言）。android 部分读缓存（health 高频探活
        # 不得每次都跑 adb 子进程 —— 30s 清单缓存 / /v1devices 现场探测）。
        "surfaces": await _surfaces_report(),
        # W5-1（W4-6/W4-8 落盘）：L2 零 API 设备面 + 声学通道的能力申报 ——
        # 读缓存态（backend/frames/已探测事实），不触发任何设备打开或建链。
        "hardware": _hardware_faces(),
        # ΤΕΛ-6（D-G28②）：DPI 像素域契约申报（additive 新键，30s TTL 缓存，
        # 故障诚实 absent —— Node 端/运维可观测「物理像素契约是否成立」，
        # 此前只能读源码自证）。
        "pixel_domain": _pixel_domain_face(),
        # J 纪元修正：capabilities 语义撞名 —— 旧实现返回控制器名列表，
        # 与 auth.ALL_CAPS 的能力位图语义冲突，误导 Node 端 CapabilityCache。
        # 现在 capabilities = 能力位图；控制器清单另立 controllers 字段。
        "capabilities": list(ALL_CAPS),
        "controllers": list(_controllers.keys()),
        "switch_window_method": window_ctrl.method(),
        "ui_funnel": {
            "l1_tree": "available" if config.funnel.l1_backend != "disabled" else "unavailable",
            "l2_ocr": "available" if config.funnel.l2_backend != "disabled" else "unavailable",
            "l3_vlm": config.funnel.l3_backend,
            "l3_arbitration_enabled": config.funnel.arbitration_enabled,
        },
        "screenshot_transport": config.screenshot.transport,
        "auth": {
            # ΠΑΝ-128: 平台判定改走 attest_pid_supported()（linux/win32 —— F1-7
            # ΠΑΝ-27 起 Windows 也具备真实内核信号，旧 ``sys.platform == "linux"``
            # 把武装态误报为关）。attestation_mode 为 additive 新键：诚实形态
            # 申报（proc_*/win_* = 真实信号；loopback_hmac_only = 降级）。
            "pid_attestation": config.auth.enable_pid_attestation and attest_pid_supported(),
            "attestation_mode": attestation_mode() if config.auth.enable_pid_attestation else "disabled",
            "capability_token": True,
        },
    }

    # 纪元 Σ：质询应答 —— 密钥缺席 / 任何异常 ⇒ 无 proof（Node 端退回 pid
    # 判定）；health 绝不抛（异常诚实第二条）。
    if nonce:
        try:
            from .server import _app_state  # 运行期延迟导入：server 顶层导入 routes，模块级互导成环
            key = _app_state.get("key")
            if isinstance(key, (bytes, bytearray)):
                data["proof"] = hmac.new(bytes(key), nonce.encode("utf-8"), hashlib.sha256).hexdigest()
        except Exception:  # noqa: BLE001
            pass

    return success(data)


# ─── 动作端点（safe_call 包裹）───


@router.post("/click_mouse")
@safe_call
async def click_mouse(req: ClickRequest) -> dict:
    # W4-5：surface 路由 —— android → adb input tap/长按；host:<i> → 坐标
    # 换算到目标显示器后走主机 pyautogui；None → 主机现状（字节兼容）。
    if req.surface is not None:
        kind, key = parse_surface_id(req.surface)
        if kind == "android":
            android = _android_ctrl()
            return await _run_android(
                android.tap, str(key), req.x, req.y, req.button, req.dry_run,
            )
        x, y, note = await _host_remap(int(key), req.x, req.y)  # type: ignore[arg-type]
        ctrl: InputController = _get("input")
        return _with_surface(
            await ctrl.click(x, y, req.button, dry_run=req.dry_run), req.surface, note,
        )
    ctrl = _get("input")
    return await ctrl.click(req.x, req.y, req.button, dry_run=req.dry_run)


@router.post("/type_text")
@safe_call
async def type_text(req: TypeRequest) -> dict:
    if req.surface is not None:
        kind, key = parse_surface_id(req.surface)
        if kind == "android":
            android = _android_ctrl()
            return await _run_android(
                android.type_text, str(key), req.text, req.clear_first, req.dry_run,
            )
        x, y, note = await _host_remap(int(key), 0.5, 0.5)  # type: ignore[arg-type]
        del x, y  # 打字与坐标无关；host:<i> 只需校验索引合法并如实降级申报
        ctrl: InputController = _get("input")
        return _with_surface(
            await ctrl.type_text(req.text, req.clear_first, dry_run=req.dry_run),
            req.surface, note,
        )
    ctrl = _get("input")
    return await ctrl.type_text(req.text, req.clear_first, dry_run=req.dry_run)


@router.post("/scroll_page")
@safe_call
async def scroll_page(req: ScrollRequest) -> dict:
    if req.surface is not None:
        kind, key = parse_surface_id(req.surface)
        if kind == "android":
            android = _android_ctrl()
            return await _run_android(
                android.scroll, str(key), req.direction, req.amount, req.dry_run,
            )
        _x, _y, note = await _host_remap(int(key), 0.5, 0.5)  # type: ignore[arg-type]
        ctrl: InputController = _get("input")
        return _with_surface(
            await ctrl.scroll(req.direction, req.amount, dry_run=req.dry_run),
            req.surface, note,
        )
    ctrl = _get("input")
    return await ctrl.scroll(req.direction, req.amount, dry_run=req.dry_run)


@router.post("/press_hotkey")
@safe_call
async def press_hotkey(req: HotkeyRequest) -> dict:
    if req.surface is not None:
        kind, key = parse_surface_id(req.surface)
        if kind == "android":
            android = _android_ctrl()
            return await _run_android(android.key, str(key), req.keys, req.dry_run)
        _x, _y, note = await _host_remap(int(key), 0.5, 0.5)  # type: ignore[arg-type]
        ctrl: InputController = _get("input")
        return _with_surface(
            await ctrl.press_hotkey(req.keys, dry_run=req.dry_run), req.surface, note,
        )
    ctrl = _get("input")
    return await ctrl.press_hotkey(req.keys, dry_run=req.dry_run)


@router.post("/drag_mouse")
@safe_call
async def drag_mouse(req: DragRequest) -> dict:
    if req.surface is not None:
        kind, key = parse_surface_id(req.surface)
        if kind == "android":
            android = _android_ctrl()
            return await _run_android(android.drag, str(key), req.start, req.end, None, req.dry_run)
        ctrl: InputController = _get("input")
        sx, sy, note = await _host_remap(int(key), float(req.start["x"]), float(req.start["y"]))  # type: ignore[arg-type]
        ex, ey, _n = await _host_remap(int(key), float(req.end["x"]), float(req.end["y"]))  # type: ignore[arg-type]
        return _with_surface(
            await ctrl.drag({"x": sx, "y": sy}, {"x": ex, "y": ey}, dry_run=req.dry_run),
            req.surface, note,
        )
    ctrl = _get("input")
    return await ctrl.drag(req.start, req.end, dry_run=req.dry_run)


@router.post("/move_mouse")
@safe_call
async def move_mouse(req: MoveRequest) -> dict:
    """移动鼠标到归一化坐标（不点击）。

    Z-1 世界行动引擎：探针悬停 → 读光标形态 → 观察悬停重绘 → 复位。
    独立成端点（而非复用 click）是因为探针需要「移动但绝不按下」的
    零破坏语义 —— 复用 click 路径总有一天会带上按钮参数穿进来。

    W4-5：android surface ⇒ 诚实拒绝（触屏无「悬停不按下」概念 ——
    input swipe/motionevent 都会留下按压痕迹，伪装悬停 = 谎报）。
    """
    if req.surface is not None:
        kind, _key = parse_surface_id(req.surface)
        if kind == "android":
            raise PhysicalError(
                ErrorKind.INVALID_ARGS,
                "move_mouse unsupported on android surface: touch input has no "
                "hover-without-press semantics (honest refusal, no emulation)",
            )
        x, y, note = await _host_remap(int(_key), req.x, req.y)  # type: ignore[arg-type]
        ctrl: InputController = _get("input")
        return _with_surface(
            await ctrl.move(x, y, duration_ms=req.duration_ms, dry_run=req.dry_run),
            req.surface, note,
        )
    ctrl = _get("input")
    return await ctrl.move(req.x, req.y, duration_ms=req.duration_ms, dry_run=req.dry_run)


@router.post("/take_screenshot")
@safe_call
async def take_screenshot(req: ScreenshotRequest) -> dict:
    """截屏 → 写入 shm → 返回 ShmHandle 元数据。

    零字节图像传输（shm 模式）；base64 模式才内联数据。
    gate 命中（屏幕未变）时无 handle，响应携带 ``unchanged=true``。
    """
    screen_ctrl: ScreenCapture = _get("screen")
    region_dict = req.region.model_dump() if req.region else None
    handle, extras = await screen_ctrl.capture(
        req.format, req.quality, region_dict,
        overlay=req.overlay, max_width=req.max_width, upscale=req.upscale,
        want_hashes=req.want_hashes, want_region_hash=req.want_region_hash,
        gate=req.gate, keep_frame=req.keep_frame, meta_only=req.meta_only,
        want_salience=req.want_salience,
        display=req.display,
        surface=req.surface,
    )
    if handle is None:
        # captured_at 单位与 ShmHandle 对齐（unix 毫秒 —— 旧实现误用秒级 time.time()，
        # 同字段在 gate/meta_only 路径与 handle 路径间单位漂移）
        return success({**extras, "transport": "none", "name": "", "size": 0,
                        "shape": [0, 0, 0], "dtype": "", "stride": 0,
                        "format": "", "width": 0, "height": 0,
                        "captured_at": int(time.time() * 1000), "image_base64": ""})
    return {
        "transport": handle.transport,
        "name": handle.name,
        "size": handle.size,
        "shape": list(handle.shape),
        "dtype": handle.dtype,
        "stride": handle.stride,
        "format": handle.format,
        "width": handle.width,
        "height": handle.height,
        "captured_at": handle.captured_at,
        # 仅 base64 模式才有 base64_data；shm/mmap-file 模式为空字符串
        "image_base64": handle.base64_data if handle.transport == "base64" else "",
        **extras,
    }


@router.post("/get_ui_tree")
@safe_call
async def get_ui_tree(req: UiTreeRequest) -> dict:
    """UI 树读取 —— 反双盲仲裁漏斗。

    若需要 L2/L3，先经 ``ScreenCapture.capture_png_bytes`` 截屏（J 纪元修正：
    旧实现内联独立截屏代码 —— 不享受测试合成图降级，异常还被 ``pass`` 静默
    吞掉，fault 只会谎报下游 "no image bytes for OCR"）。

    ΠΑΝ-96（routes 侧可达部分）：``source`` 字段此前**收而不用**（声明
    tree/ocr/vlm 语义却恒走 ceiling 缺省 —— 契约谎言）。现在 source 作为
    ceiling 的**收紧**语义生效：tree→L1、ocr→L2、vlm→L3，与显式
    ``funnel_ceiling`` 取**较浅者**（min 语义：两者都只能收紧视野，不能
    互相放大 —— 客户端钉死 source="ocr" 的纯文本屏不再落到 L3 付费）。
    ``source="auto"``（缺省）+ ``funnel_ceiling="L3"``（缺省）⇒ L3 —— 旧
    客户端零回归。冲突计数的数学放宽（L2-only 不恒计冲突）与 arbitrate
    消费 l1/l2 证据的改造在 ui_tree.py（A 半辖域）—— 对接点见修复报告
    F3-2：``_align_elements`` 的 conflicts 计数与 ``L3VLMBackend.arbitrate``
    的 prompt 构造。
    """
    import sys

    funnel_ctrl: UIFunnel = _get("funnel")
    screen_ctrl: ScreenCapture = _get("screen")

    region_dict = req.region.model_dump() if req.region else None

    # ΠΑΝ-96：source → ceiling 收紧（min 语义，见 docstring）；auto = L3 不收紧
    _SRC_CEILING = {"tree": 0, "ocr": 1, "vlm": 2, "auto": 2}
    _CEILING_NAMES = ("L1", "L2", "L3")
    ceiling = _CEILING_NAMES[
        min(_SRC_CEILING[req.source], _CEILING_NAMES.index(req.funnel_ceiling))
    ]

    # 若需要 L2/L3，先截屏（走 ScreenCapture 统一路径，含测试降级）
    screenshot_bytes: bytes | None = None
    if ceiling in ("L2", "L3"):
        try:
            screenshot_bytes, _, _ = await screen_ctrl.capture_png_bytes(region_dict)
        except PhysicalError as e:
            # 截屏失败：L1 仍可尝试，L2/L3 降级 —— 但必须留下真实原因
            print(f"[warn] get_ui_tree screenshot failed: {e.detail}", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print(f"[warn] get_ui_tree screenshot failed: {e}", file=sys.stderr)

    # 全屏尺寸（漏斗坐标归一化的分母；L1 像素坐标换算必需）
    screen_size: tuple[int, int] | None = None
    try:
        size_dict = await screen_ctrl.get_screen_size()
        screen_size = (int(size_dict["width"]), int(size_dict["height"]))
    except (PhysicalError, KeyError, TypeError, ValueError):
        screen_size = None

    result = await funnel_ctrl.extract(
        screenshot_bytes=screenshot_bytes,
        region=region_dict,
        funnel_ceiling=ceiling,
        screen_size=screen_size,
    )
    return result.to_dict()


@router.post("/switch_window")
@safe_call
async def switch_window(req: SwitchWindowRequest) -> dict:
    """按标题关键词切窗。"""
    window_ctrl: WindowManager = _get("window")
    return await window_ctrl.switch_by_title(req.keyword)


@router.get("/active_window")
@safe_call
async def active_window() -> dict:
    """读前台窗口标题（只读零副作用）—— R2-3 type_text 前置焦点校验的数据源。

    backend 缺席 ⇒ WINDOW_UNAVAILABLE failure 信封（Node 侧按通道缺席降级，
    绝不伪造标题）。
    """
    window_ctrl: WindowManager = _get("window")
    return await window_ctrl.active_window()


# ─── 感知辅助端点（D-1 工具层接线：无原生依赖的 Node 端所需）───


@router.get("/cursor")
@safe_call
async def cursor() -> dict:
    """当前鼠标位置（全屏像素）—— SoM 准星与多屏感知的数据源。

    ΝΩ-53：Raw Input 镜像优先（零 Win32 调用、零 executor 往返 —— 事件驱动
    替代轮询）；镜像陈旧度 > ``stale_after_s``（缺省 2s）或不可用 ⇒ 回退
    pyautogui 轮询并诚实注记。默认关闭（``DSH_PHYSICAL_RAW_INPUT=1`` 开启）
    ⇒ 响应与旧版逐字段一致（零回归铁律）。
    """
    cfg: AppConfig = _get("config")
    shot = rawinput_module.read_position(cfg.raw_input.stale_after_s)  # 纯 dict 读
    if shot.get("ok"):
        # 镜像快路径：零 Win32 调用、零 executor 往返、零 pyautogui import
        return {
            "x": float(shot["x"]), "y": float(shot["y"]),
            "source": "raw-input-mirror",
            "age_ms": int(float(shot["age_s"]) * 1000),
        }
    out_extra: dict = {}
    if cfg.raw_input.enabled:
        # 开了但没成/陈旧：回退轮询必须留痕（诚实注记 —— 不静默装作没开过）
        out_extra["source"] = "win32-poll"
        out_extra["note"] = f"raw-input mirror not serving ({shot.get('reason')}); fell back to Win32 poll"
    import pyautogui  # 仅回退路径需要（镜像路径不付 ~90ms 首导入税）

    loop = asyncio.get_running_loop()
    # ΑΩ-R25：pyautogui 读取 ⇒ input 池（快通道，不排在 adb/编码队尾）
    pos = await loop.run_in_executor(get_pool(INPUT_POOL), pyautogui.position)
    if cfg.raw_input.enabled:
        # ΠΑΝ-90：回退即回灌 —— 轮询读到的 ground-truth 播种回镜像（漂移
        # 账/滑动窗口归零）。SetCursorPos 类程序性移动与弹道学近似漂移都
        # 靠这个闭环收口：镜像最多错「一个漂移预算」的量，随即自愈。
        rawinput_module.reseed(float(pos.x), float(pos.y))
    return {"x": float(pos.x), "y": float(pos.y), **out_extra}


@router.get("/cursor_kind")
@safe_call
async def cursor_kind() -> dict:
    """当前全局光标形态（hand/ibeam/arrow/...）—— 交互性探针的 OS 判决通道。

    操作系统对「指针下是什么」的原生判断：手型 = 可点击热区，
    I 型 = 可选择文本。纯视觉架构中唯一无需 a11y 树的交互性 ground truth。

    ΝΩ-53：镜像开启时响应附加 ``position``（(x,y) 优先读 Raw Input 镜像
    零调用；句柄比对仍需 GetCursorInfo —— Raw Input 不给句柄，此为结构
    差异注记）。默认关闭 ⇒ 响应形状不变。
    """
    from .cursor import cursor_kind as read_cursor_kind

    loop = asyncio.get_running_loop()
    # ΑΩ-R25：Win32 快读（GetCursorInfo）⇒ input 池 —— 悬停探针要低延迟
    return await loop.run_in_executor(get_pool(INPUT_POOL), read_cursor_kind)


@router.get("/input_events")
@safe_call
async def input_events() -> dict:
    """ΝΩ-53：最近输入事件环（只读）—— 「人手 vs agent 注入」审计面。

    镜像开启时返回最近 ``event_window_s``（缺省 1s）内的事件（环容量
    ``ring_capacity`` 缺省 128；鼠标位移/按钮位图 + 键盘 vk—— 不含文本，
    审计所需的最小证据流）。镜像关闭/不可用 ⇒ ``available=False`` + 真实
    原因（诚实降级，不谎报空事件）。鉴权：``ENDPOINT_CAPABILITY`` 映射
    ``observe`` 位（ΠΑΝ-25 —— 键盘 vk 审计流敏感度独立于截图位；旧注释
    「不在映射 ⇒ 不要求特定位图」已随 ΠΑΝ-25 失效）。
    """
    cfg: AppConfig = _get("config")
    desc = rawinput_module.describe()
    events = rawinput_module.recent_events(cfg.raw_input.event_window_s) \
        if desc.get("state") == "running" else []
    return {
        "available": desc.get("state") == "running",
        "state": desc.get("state"),
        "reason": desc.get("reason"),
        "enabled": cfg.raw_input.enabled,
        "window_s": cfg.raw_input.event_window_s,
        "events": events,
        "counts": rawinput_module.stats(),
    }


@router.post("/hit_test")
@safe_call
async def hit_test(req: HitTestRequest) -> dict:
    """UIA 单点结构查询 —— Z-1 第三通道（判别力天花板）。

    ``ControlFromPoint``：坐标处官方登记的控件类型（Button/Text/Edit...），
    含祖先链（按钮里的 Text 标签沿祖先找到 Button）。零物理副作用——
    不动鼠标、不截图。门控：``DSH_PHYSICAL_L1_BACKEND=disabled`` 时缺席。
    """
    from .hit_test import hit_test as run_hit_test

    config: AppConfig = _get("config")
    if config.funnel.l1_backend == "disabled":
        return {
            "available": False,
            "reason": "l1_backend disabled (pure-vision ideology; opt-in via DSH_PHYSICAL_L1_BACKEND)",
            "classification": "unavailable",
        }

    input_ctrl: InputController = _get("input")
    w, h = await input_ctrl.get_screen_size()
    px = min(int(round(req.x * w)), w - 1)
    py = min(int(round(req.y * h)), h - 1)

    loop = asyncio.get_running_loop()
    # ΑΩ-R25：UIA 结构查询与 L1 树同域 ⇒ tree 池（与 OCR 共池互拖可容忍，
    # 但绝不拖物理动作 —— 结构感知慢于动作是可接受的优先级排序）
    result = await loop.run_in_executor(get_pool(TREE_POOL), run_hit_test, px, py)
    return {**result, "pixel": {"x": px, "y": py}}


@router.get("/displays")
@safe_call
async def displays() -> dict:
    """显示器清单（全屏虚拟坐标系）—— 多屏感知与边界守卫的数据源。

    枚举逻辑在 ``screen.list_displays``（Σ-5 抽取的共享函数 ——
    take_screenshot 的 ``display`` 索引裁剪出自同一枚举 ⇒ 索引语义一致）。
    Windows：Win32 EnumDisplayMonitors；其余平台诚实降级为主屏单条。
    """
    screen_ctrl: ScreenCapture = _get("screen")
    result = await list_displays(screen_ctrl)
    return {"displays": result}


@router.get("/devices")
@safe_call
async def devices() -> dict:
    """W4-5：adb 设备清单（移动 Surface 枚举）—— ``{devices, degraded}``。

    每台设备：``{serial, state, surface_id, resolution?}``。真机/adb 缺席 ⇒
    空清单 + ``degraded=True`` + 真实原因（诚实降级铁律 —— 不静默、不谎报）。
    控制器为同步（adb 子进程阻塞）⇒ executor 内执行。
    """
    android = _controllers.get("android")
    if android is None:
        return {
            "devices": [],
            "degraded": True,
            "reason": "android controller not initialized (mobile surface unavailable)",
        }
    # ΑΩ-R25：adb devices 子进程（15s 超时量级）⇒ device 池
    return await asyncio.get_running_loop().run_in_executor(
        get_pool(DEVICE_POOL), android.list_devices,
    )


# ─── W5-1（W4-6 落盘）：L2 零 API 设备面端点（UVC 眼睛 / HID 手）───
# 硬件缺席安全律：控制器构造零硬件副作用（懒解析帧源/懒开串口）；端点调用
# 在无硬件/无依赖时由控制器抛 PhysicalError 信封（safe_call ⇒ 200+failure），
# 绝不带崩服务。safe_call 方言与 input 端点模板逐字对齐。


@router.post("/uvc/capture")
@safe_call
async def uvc_capture(req: UvcCaptureRequest) -> dict:
    """UVC 采集卡取帧 —— 校准 → dhash 门控 → PNG/JPEG 编码（base64 内联）。

    cv2 缺席 / 无采集卡 ⇒ 诚实 ``screen_capture_failed`` 信封（附 remediation），
    绝不静默降级主机截屏（帧源语义不同 —— 坐标基准污染）。
    """
    import base64

    ctrl = _uvc_ctrl()
    data, extras = await ctrl.capture(
        req.format, req.quality,
        req.region.model_dump() if req.region else None,
        gate=req.gate, want_hashes=req.want_hashes, max_width=req.max_width,
    )
    out = dict(extras)
    out["format"] = req.format
    out["transport"] = "base64" if data is not None else "none"
    out["image_base64"] = base64.b64encode(data).decode("ascii") if data is not None else ""
    return out


@router.post("/hid/click")
@safe_call
async def hid_click(req: HidClickRequest) -> dict:
    """HID 棒点击（绝对鼠标两帧）—— 零 API 设备面的「手」。"""
    ctrl = _hid_ctrl()
    return await ctrl.click(req.x, req.y, req.button, dry_run=req.dry_run)


@router.post("/hid/move")
@safe_call
async def hid_move(req: HidMoveRequest) -> dict:
    """HID 棒绝对移动（单帧，无点击）—— 悬停/巡视的零 API 化。"""
    ctrl = _hid_ctrl()
    return await ctrl.move(req.x, req.y, dry_run=req.dry_run)


@router.post("/hid/drag")
@safe_call
async def hid_drag(req: HidDragRequest) -> dict:
    """HID 棒拖拽（移动→按下→移动→释放四帧）。"""
    ctrl = _hid_ctrl()
    return await ctrl.drag(req.start, req.end, dry_run=req.dry_run)


@router.post("/hid/scroll")
@safe_call
async def hid_scroll(req: HidScrollRequest) -> dict:
    """HID 棒滚轮（垂直走绝对帧 wheel 字节，水平走相对帧）。"""
    ctrl = _hid_ctrl()
    return await ctrl.scroll(req.direction, req.amount, dry_run=req.dry_run)


@router.post("/hid/hotkey")
@safe_call
async def hid_hotkey(req: HidHotkeyRequest) -> dict:
    """HID 棒组合键（1-5 键对称按下/释放）。"""
    ctrl = _hid_ctrl()
    return await ctrl.press_hotkey(req.keys, dry_run=req.dry_run)


@router.post("/hid/type_text")
@safe_call
async def hid_type_text(req: HidTypeRequest) -> dict:
    """HID 棒文本注入（auto: ASCII 逐键 / 长文非 ASCII 走 Ctrl+V 粘贴）。"""
    ctrl = _hid_ctrl()
    return await ctrl.type_text(
        req.text, clear_first=req.clear_first, dry_run=req.dry_run, mode=req.mode,
    )


@router.post("/frame_stats")
@safe_call
async def frame_stats(req: FrameStatsRequest) -> dict:
    """缓存帧区域统计（intent.ts 物理规则 / popupDetector 几何传感的躯体）。"""
    screen_ctrl: ScreenCapture = _get("screen")
    # ΑΩ-R25：numpy 统计是 CPU 图像工作 ⇒ screen 池
    stats = await asyncio.get_running_loop().run_in_executor(
        get_pool(SCREEN_POOL), screen_ctrl.frame_stats, req.frame_id, req.regions,
    )
    return {"frame_id": req.frame_id, "stats": stats}


@router.post("/frame_rowmeans")
@safe_call
async def frame_rowmeans(req: FrameRowmeansRequest) -> dict:
    """缓存帧行亮度序列（内容平移检测 —— scroll 物理规则的躯体）。"""
    screen_ctrl: ScreenCapture = _get("screen")
    rows = await asyncio.get_running_loop().run_in_executor(
        get_pool(SCREEN_POOL), screen_ctrl.frame_rowmeans, req.frame_id, req.grid,
    )
    return {"frame_id": req.frame_id, "rows": rows}


@router.post("/frame_diff")
@safe_call
async def frame_diff(req: FrameDiffRequest) -> dict:
    """两缓存帧差分 → 变化区域清单 + 可选红框标注 JPEG（diff_view 的躯体）。"""
    import base64

    screen_ctrl: ScreenCapture = _get("screen")
    result = await asyncio.get_running_loop().run_in_executor(
        get_pool(SCREEN_POOL), screen_ctrl.frame_diff,
        req.frame_a, req.frame_b, req.block, req.annotate,
    )
    annotated = result.pop("annotated_jpeg")
    if annotated is not None:
        result["annotated_image_base64"] = base64.b64encode(annotated).decode("ascii")
    return result


@router.get("/audio_events")
@safe_call
async def audio_events() -> dict:
    """W5-1（W4-8 落盘）：系统音频非语义事件 —— L4 声学证据通道。

    ``audio_events_payload`` 防御式绝不抛（通道不可用 ⇒ ``available=False``
    + 真实 reason，``event=None`` 诚实缺席）；建链/读环是阻塞 COM 调用
    ⇒ executor 内执行，不进事件循环。首调事实落 ``_audio_state`` 缓存
    （health 能力申报读缓存，不在探活路径上建链）。
    """
    loop = asyncio.get_running_loop()
    # ΑΩ-R25：WASAPI 建链/读环是阻塞 COM 设备 I/O ⇒ device 池
    payload = await loop.run_in_executor(get_pool(DEVICE_POOL), audio_events_payload)
    _audio_state.update({
        "probed": True,
        "available": payload.get("available"),
        "backend": payload.get("backend"),
        "probed_at": int(time.time() * 1000),
    })
    return payload


# ─── ΝΩ-36：/v1/stats 诊断端点（只读聚合，永不抛）───


def _collect_stats() -> dict:
    """ΝΩ-36：诊断面聚合（纯读；任何一面缺席/抛错 ⇒ 诚实 absent，绝不击穿）。

    聚合五面：
      - ``executors``：四池容量/在役态（executors.describe）；
      - ``shm``：mmap 治理账面（shm.get_stats，ΑΩ-R26 既有）；
      - ``streams``：scrcpy 常驻流枢纽（StreamHub.stats —— 未建枢纽 ⇒ absent，
        不触发惰性构造：诊断读不得引发 scrcpy 探测/解码器解析副作用）；
      - ``audio``：声学通道缓存态（``_audio_state``，health 同源）；
      - ``frame_ring``：帧环水位（ScreenCapture 帧环公有快照 frame_ids + 容量）。
    另附 drain 状态（ΝΩ-27 的在飞计数 —— 关停排空的现场可观测面）。
    """
    stats: dict = {"ts": int(time.time() * 1000)}

    def _face(name: str, reader: Any) -> None:
        try:
            stats[name] = reader()
        except Exception as e:  # noqa: BLE001 —— 诊断端点绝不抛（safe_call 外的第二道）
            stats[name] = {"absent": True, "reason": f"{type(e).__name__}: {e}"}

    _face("executors", executors_module.describe)
    _face("shm", shm_module.get_stats)
    _face("drain", lambda: {
        "draining": bool(_drain_state["draining"]),
        "in_flight": int(_drain_state["in_flight"]),
    })

    android = _controllers.get("android")
    if android is None:
        stats["streams"] = {"absent": True,
                            "reason": "android controller not assembled"}
    else:
        _face("streams", android.stream_stats)

    stats["audio"] = dict(_audio_state)

    screen = _controllers.get("screen")
    if screen is None:
        stats["frame_ring"] = {"absent": True,
                               "reason": "screen controller not initialized"}
    else:
        def _ring_watermark() -> dict:
            ids = screen.frame_ids()
            return {
                "frames": len(ids),
                "capacity": ScreenCapture.MAX_CACHED_FRAMES,
                "latest_frame_id": ids[-1] if ids else None,
            }
        _face("frame_ring", _ring_watermark)
    return stats


@router.get("/stats")
@safe_call
async def stats() -> dict:
    """ΝΩ-36：诊断端点 —— 池/shm/常驻流/声学/帧环水位的只读聚合。

    鉴权：``ENDPOINT_CAPABILITY`` 映射 ``observe`` 位（ΠΑΝ-25 —— stats 暴露
    池/shm/流内部拓扑，归只读观测族；X-Cap-Token + X-Request-Id nonce 强制
    校验照走。旧注释「不在映射 ⇒ 不要求特定位图」已随 ΠΑΝ-25 失效）。
    缺数据的面诚实 ``{"absent": true}``。
    """
    return _collect_stats()


# ─── /v1/shm/{name}：共享内存显式释放（DELETE 方法）───


@router.delete("/shm/{name}")
@safe_call
async def release_shm(name: str) -> dict:
    """显式释放 shm 对象（Node 端读完后调用）。

    返回 ``{ released: bool }`` —— false 表示对象已过期或不存在（无害）。
    """
    released = shm_module.release_by_name(name)
    return {"released": released, "name": name}


# J 纪元移除 ``POST /v1/mint_token`` 端点 —— 它是自举死锁 + 安全洞的组合：
#   1. 该端点存在的意义是"给没有 token 的客户端铸 token"，却被 auth 中间件
#      挡住（白名单只有 /v1/health）—— 永远不可达的死代码；
#   2. 若加入白名单，则任何本地进程都能免密钥铸全能力 token，Layer 3 的
#      capability 模型形同虚设。
# 信任根在密钥文件（0600）—— Node 端读密钥自铸（capToken.ts 与 auth.py
# 字节级镜像），无需服务端铸造入口。


# ─── ΝΩ-27：优雅关停（drain 语义）───
# Windows 上 SIGTERM 即硬杀（TerminateProcess），Node 端 serviceManager 的
# 3s 优雅窗形同虚设。管理面改走 HTTP：``POST /v1/shutdown`` 收到即
#   1. 置 draining 标志 —— server.py 的 drain 中间件对新请求（/v1/shutdown
#      自身除外）回 503+failure 信封（先于 auth 执行、logging 之内 —— F1-7
#      中间件层级重排后 logging 移到 drain 之外，503 与 401 同样留痕；
#      旧注「先于 auth/logging」的 logging 半句已过时）；
#   2. 等在飞请求完成（上限 SHUTDOWN_DRAIN_MAX_WAIT_S=3s —— 卡死的在飞
#      动作不拖住下线，到点强制走退出）；
#   3. 触发退出钩子 —— server.run() 注入的 uvicorn.Server 翻转器
#      （should_exit / 超时 force_exit），lifespan finally 链（shm 清理、
#      UVC/HID/执行器池收口）随之执行后进程自退。
# 鉴权（ΠΑΝ-25 管理面入位图）：/v1/shutdown 不在 allow_no_token_endpoints ⇒
# 走既有管理面 = X-Cap-Token + X-Request-Id nonce 强制校验；ENDPOINT_CAPABILITY
# 映射 ``admin`` 位（关停权独立成位，与一切读写动作位隔离 —— 单能力 token
# 不可关停；旧注「不在映射 ⇒ 密钥持有者即可关停」已随 ΠΑΝ-25 失效）。

SHUTDOWN_DRAIN_MAX_WAIT_S = 3.0
SHUTDOWN_POLL_INTERVAL_S = 0.02

# drain 状态（模块级单例 —— server.py 的 drain 中间件与本端点共享；
# ``_audio_state`` 同款模块 dict 方言）。in_flight 由 drain 中间件 enter/leave。
_drain_state: dict = {"draining": False, "in_flight": 0}

# 退出钩子：``hook(force: bool) -> None`` —— server.run() 注入（翻转
# uvicorn.Server.should_exit / force_exit）；缺席（测试/裸 app）⇒ 退化为
# 仅排空（不真正退出 —— 单测可观察 drain 语义而不杀测试进程）。
_shutdown_hook: Any = None


def register_shutdown_hook(hook: Any) -> None:
    """注入退出钩子（server.run() 装配期调用）。hook(force) 永不期待抛错。"""
    global _shutdown_hook
    _shutdown_hook = hook


def reset_shutdown_state() -> None:
    """归零 drain 状态/钩子（测试隔离用；生产单次进程本就用不上）。"""
    global _shutdown_hook
    _drain_state["draining"] = False
    _drain_state["in_flight"] = 0
    _shutdown_hook = None


def is_draining() -> bool:
    """draining 标志读口 —— server.py drain 中间件的拒绝判据。"""
    return bool(_drain_state["draining"])


def drain_should_reject(path: str) -> bool:
    """drain 中间件的纯函数判决（测试面）：draining 且非 /v1/shutdown ⇒ 拒。

    /v1/shutdown 自身放行 —— 幂等（二次调用回 ``already_draining``，
    Node 端重试/竞态双 dispose 不至于拿到 503 反而误判失败）。
    """
    return is_draining() and not path.rstrip("/").endswith("/shutdown")


def drain_enter() -> None:
    """在飞计数 +1（server.py drain 中间件 call_next 前）。"""
    _drain_state["in_flight"] += 1


def drain_leave() -> None:
    """在飞计数 -1（中间件 finally —— 异常路径同样归还）。"""
    _drain_state["in_flight"] = max(0, _drain_state["in_flight"] - 1)


async def drain_and_exit(max_wait_s: float = SHUTDOWN_DRAIN_MAX_WAIT_S) -> tuple[bool, bool]:
    """等在飞完成（上限 max_wait_s）后触发退出钩子。返回 ``(forced, drained)``：
    ``forced`` = 到点仍在飞（钩子以 force=True 调用）；``drained`` = 触发钩子时
    在飞是否已归零。钩子缺席 ⇒ 仅排空（返回值仍如实）。永不抛错。
    """
    deadline = time.monotonic() + max_wait_s
    while _drain_state["in_flight"] > 0 and time.monotonic() < deadline:
        await asyncio.sleep(SHUTDOWN_POLL_INTERVAL_S)
    forced = _drain_state["in_flight"] > 0
    hook = _shutdown_hook
    if hook is not None:
        try:
            hook(forced)
        except Exception:  # noqa: BLE001 —— 关停路径不得被钩子拖死
            pass
    return forced, not forced


@router.post("/shutdown")
@safe_call
async def shutdown() -> dict:
    """ΝΩ-27：优雅关停入口（drain 语义，见上方模块段注）。

    幂等：已在 draining ⇒ 成功信封 + ``already_draining=True``（不重复
    排空任务）。首调立即应答（drain 排空在后台任务）—— 调用方不必等服务
    自退，Node 端 serviceManager 收到 ack 即开始等 ``exit``。
    """
    if _drain_state["draining"]:
        return {"draining": True, "already_draining": True}
    _drain_state["draining"] = True
    # 后台排空 + 退出（create_task 需事件循环 —— ASGI 端点内必有；
    # 单测经 asyncio.run 驱动同样成立）
    asyncio.get_running_loop().create_task(drain_and_exit())
    return {"draining": True, "already_draining": False}
