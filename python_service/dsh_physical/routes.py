"""所有 HTTP 路由 —— FastAPI APIRouter 汇总。

每个端点都包 ``safe_call``：异常诚实铁律的代码化（永不抛 500）。
端点 → capability 映射由 ``auth.ENDPOINT_CAPABILITY`` 定义，中间件统一校验。
"""
from __future__ import annotations

import asyncio
import sys
import time
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from . import shm as shm_module
from .auth import ALL_CAPS
from .config import AppConfig
from .errors import ErrorKind, PhysicalError, safe_call, success
from .input import InputController
from .screen import ScreenCapture
from .ui_tree import UIFunnel
from .window import WindowManager

router = APIRouter(prefix="/v1")


# ─── Pydantic 请求模型（强类型契约的代码化）───


class ClickRequest(BaseModel):
    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    button: Literal["left", "right", "middle"] = "left"
    dry_run: bool = False


class TypeRequest(BaseModel):
    text: str = Field(min_length=0, max_length=10_000)
    clear_first: bool = False
    dry_run: bool = False


class ScrollRequest(BaseModel):
    direction: Literal["up", "down", "left", "right"]
    amount: int = Field(ge=1, le=1000)
    dry_run: bool = False


class HotkeyRequest(BaseModel):
    keys: list[str] = Field(min_length=1, max_length=5)
    dry_run: bool = False


class DragRequest(BaseModel):
    start: dict[str, float]
    end: dict[str, float]
    dry_run: bool = False


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


# ─── 控制器容器（启动期注入）───

_controllers: dict[str, Any] = {}


def set_controllers(
    input_ctrl: InputController,
    screen_ctrl: ScreenCapture,
    funnel_ctrl: UIFunnel,
    window_ctrl: WindowManager,
    config: AppConfig,
) -> None:
    """启动期由 server 注入控制器实例。"""
    _controllers.clear()
    _controllers.update({
        "input": input_ctrl,
        "screen": screen_ctrl,
        "funnel": funnel_ctrl,
        "window": window_ctrl,
        "config": config,
    })


def _get(name: str) -> Any:
    if name not in _controllers:
        raise PhysicalError(
            ErrorKind.INTERNAL_ERROR,
            f"controller {name!r} not initialized",
        )
    return _controllers[name]


# ─── /v1/health：探活（无需 Cap Token，由 auth.allow_no_token_endpoints 放行）───


@router.get("/health")
async def health() -> dict:
    """健康检查 —— 返回服务能力声明。

    无需认证（``allow_no_token_endpoints``）；用于 Node 端启动期探活。
    """
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

    return success({
        "status": "ok",
        "version": "0.3.0",
        "platform": sys.platform,
        "python": platform.python_version(),
        "screen": screen_info,
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
            "pid_attestation": config.auth.enable_pid_attestation and sys.platform == "linux",
            "capability_token": True,
        },
    })


# ─── 动作端点（safe_call 包裹）───


@router.post("/click_mouse")
@safe_call
async def click_mouse(req: ClickRequest) -> dict:
    ctrl: InputController = _get("input")
    ctrl.set_dry_run(req.dry_run)
    return await ctrl.click(req.x, req.y, req.button)


@router.post("/type_text")
@safe_call
async def type_text(req: TypeRequest) -> dict:
    ctrl: InputController = _get("input")
    ctrl.set_dry_run(req.dry_run)
    return await ctrl.type_text(req.text, req.clear_first)


@router.post("/scroll_page")
@safe_call
async def scroll_page(req: ScrollRequest) -> dict:
    ctrl: InputController = _get("input")
    ctrl.set_dry_run(req.dry_run)
    return await ctrl.scroll(req.direction, req.amount)


@router.post("/press_hotkey")
@safe_call
async def press_hotkey(req: HotkeyRequest) -> dict:
    ctrl: InputController = _get("input")
    ctrl.set_dry_run(req.dry_run)
    return await ctrl.press_hotkey(req.keys)


@router.post("/drag_mouse")
@safe_call
async def drag_mouse(req: DragRequest) -> dict:
    ctrl: InputController = _get("input")
    ctrl.set_dry_run(req.dry_run)
    return await ctrl.drag(req.start, req.end)


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
    )
    if handle is None:
        return success({**extras, "transport": "none", "name": "", "size": 0,
                        "shape": [0, 0, 0], "dtype": "", "stride": 0,
                        "format": "", "width": 0, "height": 0,
                        "captured_at": time.time(), "image_base64": ""})
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
    """
    import sys

    funnel_ctrl: UIFunnel = _get("funnel")
    screen_ctrl: ScreenCapture = _get("screen")

    region_dict = req.region.model_dump() if req.region else None

    # 若需要 L2/L3，先截屏（走 ScreenCapture 统一路径，含测试降级）
    screenshot_bytes: bytes | None = None
    if req.funnel_ceiling in ("L2", "L3"):
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
        funnel_ceiling=req.funnel_ceiling,
        screen_size=screen_size,
    )
    return result.to_dict()


@router.post("/switch_window")
@safe_call
async def switch_window(req: SwitchWindowRequest) -> dict:
    """按标题关键词切窗。"""
    window_ctrl: WindowManager = _get("window")
    return await window_ctrl.switch_by_title(req.keyword)


# ─── 感知辅助端点（D-1 工具层接线：无原生依赖的 Node 端所需）───


@router.get("/cursor")
@safe_call
async def cursor() -> dict:
    """当前鼠标位置（全屏像素）—— SoM 准星与多屏感知的数据源。"""
    import pyautogui

    loop = asyncio.get_running_loop()
    pos = await loop.run_in_executor(None, pyautogui.position)
    return {"x": float(pos.x), "y": float(pos.y)}


@router.get("/displays")
@safe_call
async def displays() -> dict:
    """显示器清单（全屏虚拟坐标系）—— 多屏感知与边界守卫的数据源。

    Windows：Win32 EnumDisplayMonitors；其余平台诚实降级为主屏单条。
    """
    import platform

    result: list[dict] = []
    if platform.system() == "Windows":
        def _enum() -> list[dict]:
            import ctypes
            import ctypes.wintypes as wt

            user32 = ctypes.windll.user32
            monitors: list[dict] = []
            MonitorEnumProc = ctypes.WINFUNCTYPE(
                ctypes.c_int, wt.HMONITOR, wt.HDC, ctypes.POINTER(wt.RECT), ctypes.c_void_p,
            )

            def _cb(hmon, _hdc, rect, _lparam):
                info = wt.MONITORINFO()
                info.cbSize = ctypes.sizeof(wt.MONITORINFO)
                if user32.GetMonitorInfoW(hmon, ctypes.byref(info)):
                    r = info.rcMonitor
                    monitors.append({
                        "name": f"Monitor@{r.left},{r.top}",
                        "x": int(r.left), "y": int(r.top),
                        "width": int(r.right - r.left), "height": int(r.bottom - r.top),
                        "primary": bool(info.dwFlags & 1),
                    })
                return 1

            user32.EnumDisplayMonitors(None, None, MonitorEnumProc(_cb), 0)
            return monitors

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, _enum)

    if not result:
        screen_ctrl: ScreenCapture = _get("screen")
        size = await screen_ctrl.get_screen_size()
        result = [{
            "name": "Primary", "x": 0, "y": 0,
            "width": int(size["width"]), "height": int(size["height"]),
            "primary": True,
        }]
    return {"displays": result}


@router.post("/frame_stats")
@safe_call
async def frame_stats(req: FrameStatsRequest) -> dict:
    """缓存帧区域统计（intent.ts 物理规则 / popupDetector 几何传感的躯体）。"""
    screen_ctrl: ScreenCapture = _get("screen")
    stats = await asyncio.get_running_loop().run_in_executor(
        None, screen_ctrl.frame_stats, req.frame_id, req.regions,
    )
    return {"frame_id": req.frame_id, "stats": stats}


@router.post("/frame_rowmeans")
@safe_call
async def frame_rowmeans(req: FrameRowmeansRequest) -> dict:
    """缓存帧行亮度序列（内容平移检测 —— scroll 物理规则）。"""
    screen_ctrl: ScreenCapture = _get("screen")
    rows = await asyncio.get_running_loop().run_in_executor(
        None, screen_ctrl.frame_rowmeans, req.frame_id, req.grid,
    )
    return {"frame_id": req.frame_id, "rows": rows}


@router.post("/frame_diff")
@safe_call
async def frame_diff(req: FrameDiffRequest) -> dict:
    """两缓存帧差分 → 变化区域清单 + 可选红框标注 JPEG（diff_view 的躯体）。"""
    import base64

    screen_ctrl: ScreenCapture = _get("screen")
    result = await asyncio.get_running_loop().run_in_executor(
        None, screen_ctrl.frame_diff, req.frame_a, req.frame_b, req.block, req.annotate,
    )
    annotated = result.pop("annotated_jpeg")
    if annotated is not None:
        result["annotated_image_base64"] = base64.b64encode(annotated).decode("ascii")
    return result


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
