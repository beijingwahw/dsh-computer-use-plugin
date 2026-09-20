"""鼠标键盘 pyautogui 封装 —— D-5 物理躯体。

设计哲学：
  - 归一化坐标 [0,1] 是契约层（对齐 D-7 SandboxAction.args）；
    本模块负责 [0,1] → 像素坐标的换算。
  - 串行队列：所有物理动作经 ``serialize`` 排队，多心智并发触碰同一副手时自动排队
    （对齐 D-1 物理躯体公理，对齐 nut-js fork 的 ``ioMutex`` 哲学）。
  - dry_run：仅记录不执行（CI/测试场景）。
  - 异常诚实：失败 ``raise PhysicalError``，由 ``safe_call`` 转失败响应。

依赖说明：
  ``pyautogui`` 在 Linux 无 X server 时会 ``raise`` —— 此处捕获并转 ``host-error``。
  生产环境建议 macOS（最有原生支持）或带 Xvfb 的 Linux 容器。
"""
from __future__ import annotations

import asyncio
import functools
import platform
import sys
import time
from typing import Literal

from .config import ActionConfig
from .errors import ErrorKind, PhysicalError

# pyautogui 懒加载：服务能在无 pyautogui / 无 X 环境下启动；
# 仅在真正执行物理动作时才 import，并捕获 ImportError 转为 PhysicalError。
_pyautogui = None  # type: ignore[var-annotated]


def _get_pyautogui():
    """懒加载 pyautogui，并完成模块级配置（FAILSAFE / LOG_SCREEN_SIZE）。

    失败 ``raise PhysicalError``，由 ``safe_call`` 转为失败响应。
    """
    global _pyautogui
    if _pyautogui is not None:
        return _pyautogui
    try:
        import pyautogui as _pa  # noqa: PLC0415
    except Exception as e:  # noqa: BLE001
        raise PhysicalError(
            ErrorKind.INTERNAL_ERROR,
            f"pyautogui import failed (no display / not installed?): {e}",
        ) from e
    # pyautogui 安全铁律：FAILSAFE=True 时鼠标到角落中止。本服务是 agent 之手，
    # 必须保留 FAILSAFE 以防失控（用户随时把鼠标甩到角落即可中止 agent）。
    _pa.FAILSAFE = True
    # 隐藏 pyautogui 默认的 print 噪音
    _pa.LOG_SCREEN_SIZE = False
    _pyautogui = _pa
    return _pa

# ─── 业务语义 → pyautogui 按钮枚举翻译表（防腐层核心）───

MouseButton = Literal["left", "right", "middle"]
_BUTTON_MAP: dict[str, str] = {
    "left": "left",
    "right": "right",
    "middle": "middle",
}

# 键位白名单（对齐 D-5 system.ts keyMap，避免 import 跨语言）
Key = Literal[
    "ctrl", "cmd", "alt", "shift",
    "enter", "tab", "space", "backspace", "delete", "esc",
    "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
    "a", "c", "v", "z",
]

# ``keyMap`` 与 D-5 system.ts 严格一致 —— 任何扩展必须双向同步
_KEY_MAP: dict[str, str] = {
    "ctrl": "ctrl",       # pyautogui 接受 'ctrl' 简写
    "cmd": "cmd" if sys.platform == "darwin" else "win",
    "alt": "alt",
    "shift": "shift",
    "enter": "enter",
    "tab": "tab",
    "space": "space",
    "backspace": "backspace",
    "delete": "delete",
    "esc": "esc",
    "f1": "f1", "f2": "f2", "f3": "f3", "f4": "f4", "f5": "f5",
    "f6": "f6", "f7": "f7", "f8": "f8", "f9": "f9", "f10": "f10",
    "f11": "f11", "f12": "f12",
    "a": "a", "c": "c", "v": "v", "z": "z",
}

# ─── 串行队列：所有物理动作经此排队（ioMutex 同源）───

_io_lock: asyncio.Lock | None = None


def _get_lock() -> asyncio.Lock:
    global _io_lock
    if _io_lock is None:
        _io_lock = asyncio.Lock()
    return _io_lock


async def _run_in_executor(func, *args, **kwargs):
    """把同步 pyautogui 调用丢到线程池，避免阻塞事件循环。

    支持 kwargs（经 ``functools.partial`` 绑定）—— J 纪元修复：
    旧签名 ``(*args)`` 使 ``pa.click(x, y, button=...)`` 必抛 TypeError，
    真实点击路径 100% 失败（被 ``safe_call`` 误归为 internal_error）。
    """
    loop = asyncio.get_running_loop()
    if kwargs:
        return await loop.run_in_executor(None, functools.partial(func, *args, **kwargs))
    return await loop.run_in_executor(None, func, *args)


# ─── 公开 API ───


class InputController:
    """鼠标键盘控制器。

    所有方法异步；运行层永不抛错（异常由 ``safe_call`` 转失败响应）。
    """

    # 屏幕尺寸缓存带 TTL：分辨率热插拔 / 显示器切换后坐标换算不会
    # 终身停留在旧值（J 纪元修复：旧实现首次缓存后永不失效）。
    SCREEN_SIZE_TTL_S = 30.0

    def __init__(self, config: ActionConfig) -> None:
        self.cfg = config
        self._dry_run = False
        self._screen_size: tuple[int, int] | None = None
        self._screen_size_at: float = 0.0

    def set_dry_run(self, dry: bool) -> None:
        self._dry_run = dry

    async def get_screen_size(self) -> tuple[int, int]:
        """获取屏幕尺寸（TTL 缓存，防系统调用抖动也防分辨率漂移）。"""
        now = time.monotonic()
        if self._screen_size is None or now - self._screen_size_at > self.SCREEN_SIZE_TTL_S:
            try:
                pa = _get_pyautogui()
                size = await _run_in_executor(lambda: pa.size())
                self._screen_size = (int(size.width), int(size.height))
                self._screen_size_at = now
            except PhysicalError:
                # 受控失败：保留旧缓存（若有）—— 比崩溃诚实，比误算保守
                if self._screen_size is None:
                    raise
            except Exception as e:  # noqa: BLE001
                if self._screen_size is None:
                    raise PhysicalError(
                        ErrorKind.SCREEN_CAPTURE_FAILED,
                        f"cannot detect screen size: {e}",
                    ) from e
        return self._screen_size

    def _normalize_to_pixel(self, x: float, y: float) -> tuple[int, int]:
        """归一化坐标 → 像素坐标。

        ``PhysicalError(OUT_OF_BOUNDS)``：坐标越 [0,1]；
        ``PhysicalError(INTERNAL_ERROR)``：屏幕尺寸未初始化（理论不可达）。
        """
        if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
            raise PhysicalError(
                ErrorKind.OUT_OF_BOUNDS,
                f"coordinates out of [0,1]: ({x}, {y})",
            )
        if self._screen_size is None:
            raise PhysicalError(
                ErrorKind.INTERNAL_ERROR,
                "screen size not initialized (call get_screen_size first)",
            )
        w, h = self._screen_size
        # -1 防止 round(1.0 * w) = w 越界
        px = min(int(round(x * w)), w - 1)
        py = min(int(round(y * h)), h - 1)
        return max(0, px), max(0, py)

    async def click(self, x: float, y: float, button: str = "left") -> dict:
        """点击鼠标。

        返回 ``{ pixel, screen }`` 用于审计回执。
        """
        if button not in _BUTTON_MAP:
            raise PhysicalError(
                ErrorKind.UNKNOWN_BUTTON,
                f"unknown mouse button: {button!r} (allowed: left/right/middle)",
            )
        btn = _BUTTON_MAP[button]
        size = await self.get_screen_size()
        px, py = self._normalize_to_pixel(x, y)

        if self._dry_run:
            return {"pixel": {"x": px, "y": py}, "screen": {"width": size[0], "height": size[1]}}

        async with _get_lock():
            pa = _get_pyautogui()
            await _run_in_executor(
                pa.click,
                px, py, button=btn, _pause=False,
            )
            await asyncio.sleep(self.cfg.pause_after_action_ms / 1000)

        return {"pixel": {"x": px, "y": py}, "screen": {"width": size[0], "height": size[1]}}

    async def type_text(self, text: str, clear_first: bool = False) -> dict:
        """输入文本。

        ``clear_first=True``：Mac=Cmd+A / Win=Ctrl+A 然后 Backspace 全选删除。
        """
        if self._dry_run:
            return {"typed_chars": len(text)}

        async with _get_lock():
            pa = _get_pyautogui()
            if clear_first:
                if sys.platform == "darwin":
                    await _run_in_executor(pa.hotkey, "command", "a")
                else:
                    await _run_in_executor(pa.hotkey, "ctrl", "a")
                await _run_in_executor(pa.press, "backspace")
            # type 安全：长文本可能触发 KeyBoardInterrupt？我们在线程池中跑，无影响
            await _run_in_executor(lambda: pa.typewrite(text, interval=0) if text else None)
            await asyncio.sleep(self.cfg.pause_after_action_ms / 1000)

        return {"typed_chars": len(text)}

    async def scroll(self, direction: str, amount: int) -> dict:
        """滚动鼠标滚轮。``amount`` 是 pyautogui 的 clicks 单位。"""
        if direction not in {"up", "down", "left", "right"}:
            raise PhysicalError(
                ErrorKind.INVALID_ARGS,
                f"unknown scroll direction: {direction!r}",
            )
        if amount <= 0 or amount > 1000:
            raise PhysicalError(
                ErrorKind.INVALID_ARGS,
                f"scroll amount out of range: {amount} (1-1000)",
            )

        if self._dry_run:
            return {"scrolled": amount}

        async with _get_lock():
            pa = _get_pyautogui()
            # pyautogui scroll: 正数=up, 负数=down；horizontal_scroll: 正数=right, 负数=left
            if direction == "up":
                await _run_in_executor(pa.scroll, amount)
            elif direction == "down":
                await _run_in_executor(pa.scroll, -amount)
            elif direction == "right":
                await _run_in_executor(pa.hscroll, amount)
            else:  # left
                await _run_in_executor(pa.hscroll, -amount)
            await asyncio.sleep(self.cfg.pause_after_action_ms / 1000)

        return {"scrolled": amount}

    async def press_hotkey(self, keys: list[str]) -> dict:
        """组合键：白名单映射 + 数量对账 + 对称按下/释放。"""
        if not keys or len(keys) > 5:
            raise PhysicalError(
                ErrorKind.INVALID_ARGS,
                f"hotkey keys count out of range: {len(keys)} (1-5)",
            )

        mapped: list[str] = []
        for k in keys:
            key_lower = k.lower()
            if key_lower not in _KEY_MAP:
                raise PhysicalError(
                    ErrorKind.UNKNOWN_KEY,
                    f"unknown key: {k!r} (allowed: {', '.join(sorted(_KEY_MAP.keys()))})",
                )
            mapped.append(_KEY_MAP[key_lower])

        if self._dry_run:
            return {"pressed": mapped}

        async with _get_lock():
            pa = _get_pyautogui()
            # pyautogui.hotkey 自动按下所有键再释放（对称语义）
            await _run_in_executor(lambda: pa.hotkey(*mapped))
            await asyncio.sleep(self.cfg.pause_after_action_ms / 1000)

        return {"pressed": mapped}

    async def drag(self, start: dict, end: dict) -> dict:
        """拖拽鼠标：start/end 都是归一化 {x, y}。

        pyautogui ``dragTo`` 的默认拖拽时长是 0.0；我们用 ``mouseDownTimer`` 风格的
        两阶段：``moveTo(start)`` → ``mouseDown`` → ``moveTo(end)`` → ``mouseUp``。
        """
        try:
            sx, sy = float(start["x"]), float(start["y"])
            ex, ey = float(end["x"]), float(end["y"])
        except (KeyError, TypeError, ValueError) as e:
            raise PhysicalError(
                ErrorKind.INVALID_ARGS,
                f"drag start/end must be {{x,y}}: {e}",
            ) from e

        if self._dry_run:
            # J 纪元修复：旧实现用 int(sx*1000) 伪造像素（把 1000 当屏幕宽高）。
            # 诚实回执：有显示则给真实像素换算；无显示则只回归一化坐标并注明。
            try:
                await self.get_screen_size()
                spx0, spy0 = self._normalize_to_pixel(sx, sy)
                epx0, epy0 = self._normalize_to_pixel(ex, ey)
                pixels: dict = {
                    "start_pixel": {"x": spx0, "y": spy0},
                    "end_pixel": {"x": epx0, "y": epy0},
                }
            except PhysicalError:
                pixels = {
                    "start_pixel": None,
                    "end_pixel": None,
                    "note": "dry-run without display; only normalized coords echoed",
                }
            return {
                **pixels,
                "start": {"x": sx, "y": sy},
                "end": {"x": ex, "y": ey},
            }

        await self.get_screen_size()
        spx, spy = self._normalize_to_pixel(sx, sy)
        epx, epy = self._normalize_to_pixel(ex, ey)

        async with _get_lock():
            pa = _get_pyautogui()
            duration = self.cfg.mouse_move_duration_ms / 1000

            def _do_drag() -> None:
                pa.moveTo(spx, spy, duration=duration / 2)
                pa.mouseDown(spx, spy, button="left")
                pa.moveTo(epx, epy, duration=duration)
                pa.mouseUp(epx, epy, button="left")

            await _run_in_executor(_do_drag)
            await asyncio.sleep(self.cfg.pause_after_action_ms / 1000)

        return {
            "start_pixel": {"x": spx, "y": spy},
            "end_pixel": {"x": epx, "y": epy},
        }

    def platform_info(self) -> dict:
        """平台信息（health 端点回执的一部分）。"""
        try:
            pa = _get_pyautogui()
            pa_version = pa.__version__
        except PhysicalError:
            pa_version = "unavailable"
        return {
            "platform": sys.platform,
            "python": platform.python_version(),
            "pyautogui_version": pa_version,
        }
