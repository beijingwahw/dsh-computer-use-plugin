"""所有 HTTP 路由 —— FastAPI APIRouter 汇总。

每个端点都包 ``safe_call``：异常诚实铁律的代码化（永不抛 500）。
端点 → capability 映射由 ``auth.ENDPOINT_CAPABILITY`` 定义，中间件统一校验。
"""
from __future__ import annotations

import asyncio
import time
from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from . import shm as shm_module
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


class ScreenshotRequest(BaseModel):
    format: Literal["png", "jpeg"] = "png"
    quality: int | None = Field(default=None, ge=0, le=100)
    region: dict | None = None


class RegionSpec(BaseModel):
    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    width: float = Field(gt=0.0, le=1.0)
    height: float = Field(gt=0.0, le=1.0)


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
    window_ctrl: WindowManager = _get("window")
    config: AppConfig = _get("config")

    # 探测屏幕尺寸（失败也返回，但 screen 字段为空）
    screen_info: dict = {}
    try:
        screen_info = await input_ctrl.get_screen_size()
    except PhysicalError as e:
        screen_info = {"error": e.detail}

    return success({
        "status": "ok",
        "version": "0.1.0",
        "platform": sys.platform,
        "python": platform.python_version(),
        "screen": screen_info,
        "capabilities": list(_controllers.keys()),
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

    若 ``screenshot`` 缺席，L2/L3 将无法运行（OCR/VLM 需要图像）；
    漏斗会诚实降级到 L1，并在 fault 中标注。
    """
    funnel_ctrl: UIFunnel = _get("funnel")

    # 若需要 L2/L3，先截屏（不通过 shm，直接拿 bytes 喂给漏斗）
    screenshot_bytes: bytes | None = None
    if req.funnel_ceiling in ("L2", "L3"):
        try:
            import pyautogui
            import io

            def _shot() -> bytes:
                img = pyautogui.screenshot()
                if req.region:
                    # 裁剪
                    iw, ih = img.size
                    box = (
                        int(req.region.x * iw),
                        int(req.region.y * ih),
                        int((req.region.x + req.region.width) * iw),
                        int((req.region.y + req.region.height) * ih),
                    )
                    img = img.crop(box)
                buf = io.BytesIO()
                img.save(buf, format="PNG")
                return buf.getvalue()

            loop = asyncio.get_running_loop()
            screenshot_bytes = await loop.run_in_executor(None, _shot)
        except Exception as e:  # noqa: BLE001
            # 截屏失败：L1 仍可尝试，L2/L3 降级
            pass

    result = await funnel_ctrl.extract(
        screenshot_bytes=screenshot_bytes,
        region=req.region.model_dump() if req.region else None,
        funnel_ceiling=req.funnel_ceiling,
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


# ─── /v1/mint_token：铸造 Cap Token（仅开发/调试使用，生产由 Node 端持有密钥自铸）───


@router.post("/mint_token")
async def mint_token_endpoint(request: Request) -> dict:
    """铸造 Capability Token（仅当 Node 端没持有密钥时的兜底入口）。

    生产环境强烈建议 Node 端读 ``~/.dsh/physical.key`` 自铸 token，
    本端点不持有密钥铸造权（信任根在文件系统）。
    """
    from .auth import ALL_CAPS, ensure_key, mint_token

    config: AppConfig = _get("config")
    try:
        key = ensure_key(config.auth.key_path)
    except Exception as e:  # noqa: BLE001
        return {"status": "failure", "error": {"kind": "internal_error", "detail": str(e)}, "latency_ms": 0}

    # 默认签发全能力 token（仅供测试；生产由 Node 端按需签发）
    body = await request.json() if request.headers.get("content-length") != "0" else {}
    caps = body.get("caps", list(ALL_CAPS))
    ttl = body.get("ttl", config.auth.token_ttl_seconds)
    pid = body.get("pid", 0)  # 测试模式 pid=0；生产由 Node 端填自身 PID

    token = mint_token(key, int(pid), tuple(caps), int(ttl))
    return {"token": token, "caps": caps, "ttl": ttl}
