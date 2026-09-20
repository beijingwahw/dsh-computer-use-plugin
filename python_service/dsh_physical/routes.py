"""所有 HTTP 路由 —— FastAPI APIRouter 汇总。

每个端点都包 ``safe_call``：异常诚实铁律的代码化（永不抛 500）。
端点 → capability 映射由 ``auth.ENDPOINT_CAPABILITY`` 定义，中间件统一校验。
"""
from __future__ import annotations

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
        "version": "0.1.0",
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
    """
    screen_ctrl: ScreenCapture = _get("screen")
    handle = await screen_ctrl.capture(req.format, req.quality, req.region)
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
