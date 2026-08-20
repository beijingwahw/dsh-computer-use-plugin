"""三平台原生窗口管理 —— Step 1 §④ 世界级创新方案。

能力声明 + 平台原生 + Hotkey 降级：
  - ``native``：当前平台有原生窗口管理（默认走原生）
  - ``hotkey_only``：原生不可用但能用 Alt+Tab / Cmd+Tab
  - ``unavailable``：彻底无窗口管理（容器环境）

平台栈：
  | 平台    | 原生 API                                       | 降级      |
  |---------|-------------------------------------------------|-----------|
  | macOS   | osascript AppleScript (System Events)          | Cmd+Tab   |
  | Windows | pygetwindow + Win32 SetForegroundWindow        | Alt+Tab   |
  | Linux   | wmctrl -a / xdotool search --name             | Alt+Tab   |

设计：
  - ``backend='auto'`` 按 sys.platform 自动选
  - ``backend='hotkey-only'`` 跳过原生，直接走 hotkey
  - ``backend='disabled'`` 完全关闭（容器环境）
  - 异常诚实：失败 ``raise PhysicalError`` → ``WINDOW_UNAVAILABLE``
"""
from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys
from typing import Literal

from .config import WindowConfig
from .errors import ErrorKind, PhysicalError

WindowMethod = Literal["native", "hotkey_only", "unavailable"]


class WindowManager:
    """窗口管理器 —— 平台分治 + hotkey 降级。"""

    def __init__(self, config: WindowConfig) -> None:
        self.config = config
        self._backend = self._resolve_backend(config.backend)
        self._hotkey_fallback = False  # 原生失败时自动切到 hotkey-only 模式

    def _resolve_backend(self, backend: str) -> str:
        if backend == "disabled":
            return "disabled"
        if backend == "hotkey-only":
            return "hotkey-only"
        if backend == "auto":
            return {
                "darwin": "osascript",
                "win32": "pygetwindow",
                "linux": "wmctrl",
            }.get(sys.platform, "hotkey-only")
        return backend

    def method(self) -> WindowMethod:
        """当前窗口管理方式（health 端点回执的一部分）。

        能力诚实铁律：``native`` 声明前置探测 —— 原生工具链缺席时如实报
        ``hotkey_only``，绝不虚报能力（health 是 Node 端 CapabilityCache 的
        同步源，虚报会让上层路由走进必败分支）。
        """
        if self._backend == "disabled":
            return "unavailable"
        if self._backend == "hotkey-only" or self._hotkey_fallback:
            return "hotkey_only"
        if not self._native_available():
            return "hotkey_only"
        return "native"

    def _native_available(self) -> bool:
        """原生栈可用性探测（按 backend 分治，只影响能力声明不影响运行时降级）。"""
        if self._backend == "osascript":
            return shutil.which("osascript") is not None
        if self._backend == "pygetwindow":
            try:
                import pygetwindow  # noqa: F401
                return True
            except ImportError:
                return False
        if self._backend == "wmctrl":
            # X11 工具链：二进制在场 + DISPLAY 在场（无 X 会话原生必败 ——
            # xvfb-headless CI 下 DISPLAY=:99 在场，如实报 native）
            has_tool = shutil.which("wmctrl") is not None or shutil.which("xdotool") is not None
            return has_tool and bool(os.environ.get("DISPLAY"))
        return True

    async def switch_by_title(self, keyword: str) -> dict:
        """按标题关键词切到目标窗口。

        返回 ``{ method, matched, keyword }`` 用于审计。
        """
        if self._backend == "disabled":
            raise PhysicalError(
                ErrorKind.WINDOW_UNAVAILABLE,
                "window backend disabled (set DSH_PHYSICAL_WINDOW_BACKEND!=disabled)",
            )

        # 原生尝试 → 失败降级到 hotkey
        if not self._hotkey_fallback and self._backend != "hotkey-only":
            try:
                if self._backend == "osascript":
                    return await self._switch_darwin(keyword)
                elif self._backend == "pygetwindow":
                    return await self._switch_windows(keyword)
                elif self._backend == "wmctrl":
                    return await self._switch_linux_wmctrl(keyword)
            except PhysicalError:
                # 原生失败 → 切到 hotkey 模式（永久降级，本会话不再尝试原生）
                self._hotkey_fallback = True
            except Exception as e:  # noqa: BLE001
                # 原生未预期失败 → 同样降级
                self._hotkey_fallback = True
                print(f"[warn] window native failed, falling back to hotkey: {e}", file=sys.stderr)

        # Hotkey 降级：Cmd+Tab (Mac) / Alt+Tab (其他)
        return await self._switch_via_hotkey(keyword)

    async def _switch_darwin(self, keyword: str) -> dict:
        """macOS：osascript System Events。"""
        if not shutil.which("osascript"):
            raise PhysicalError(ErrorKind.WINDOW_UNAVAILABLE, "osascript not found")

        # AppleScript：遍历所有进程的窗口，找标题包含 keyword 的
        script = f'''
        tell application "System Events"
            set frontmostApp to ""
            repeat with proc in (every process whose background only is false)
                repeat with w in windows of proc
                    if name of w contains "{keyword}" then
                        set frontmost of proc to true
                        perform action "AXRaise" of w
                        return name of proc & "|" & name of w
                    end if
                end repeat
            end repeat
            return ""
        end tell
        '''
        # 安全转义 keyword（防止 AppleScript 注入）
        safe_keyword = keyword.replace('"', '\\"').replace("\\", "\\\\")
        script = script.replace('"{keyword}"', f'"{safe_keyword}"')

        proc = await asyncio.create_subprocess_exec(
            "osascript", "-e", script,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            raise PhysicalError(
                ErrorKind.WINDOW_UNAVAILABLE,
                f"osascript failed: {stderr.decode().strip()}",
            )

        result = stdout.decode().strip()
        if not result:
            raise PhysicalError(
                ErrorKind.ELEMENT_NOT_FOUND,
                f"no window with title containing {keyword!r}",
            )

        return {"method": "native", "matched": result, "keyword": keyword}

    async def _switch_windows(self, keyword: str) -> dict:
        """Windows：pygetwindow + SetForegroundWindow。"""
        try:
            import pygetwindow as gw  # type: ignore[import-not-found]
        except ImportError as e:
            raise PhysicalError(
                ErrorKind.WINDOW_UNAVAILABLE,
                f"pygetwindow not installed: {e}",
            ) from e

        def _do_switch() -> str:
            windows = gw.getWindowsWithTitle(keyword)
            if not windows:
                raise PhysicalError(
                    ErrorKind.ELEMENT_NOT_FOUND,
                    f"no window with title containing {keyword!r}",
                )
            win = windows[0]
            if win.isMinimized:
                win.restore()
            win.activate()
            return win.title

        loop = asyncio.get_running_loop()
        title = await loop.run_in_executor(None, _do_switch)
        return {"method": "native", "matched": title, "keyword": keyword}

    async def _switch_linux_wmctrl(self, keyword: str) -> dict:
        """Linux：wmctrl -a <window>。"""
        if not shutil.which("wmctrl"):
            # 退到 xdotool
            return await self._switch_linux_xdotool(keyword)

        proc = await asyncio.create_subprocess_exec(
            "wmctrl", "-a", keyword,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            err = stderr.decode().strip()
            if "no window" in err.lower() or proc.returncode == 1:
                raise PhysicalError(
                    ErrorKind.ELEMENT_NOT_FOUND,
                    f"no window with title containing {keyword!r}",
                )
            raise PhysicalError(ErrorKind.WINDOW_UNAVAILABLE, f"wmctrl failed: {err}")

        return {"method": "native", "matched": keyword, "keyword": keyword}

    async def _switch_linux_xdotool(self, keyword: str) -> dict:
        """Linux 退二：xdotool search --name + windowactivate。"""
        if not shutil.which("xdotool"):
            raise PhysicalError(
                ErrorKind.WINDOW_UNAVAILABLE,
                "neither wmctrl nor xdotool found (apt install wmctrl or xdotool)",
            )

        proc = await asyncio.create_subprocess_exec(
            "xdotool", "search", "--name", keyword,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0 or not stdout.decode().strip():
            raise PhysicalError(
                ErrorKind.ELEMENT_NOT_FOUND,
                f"no window with title containing {keyword!r}",
            )

        window_id = stdout.decode().strip().split("\n")[0]
        proc2 = await asyncio.create_subprocess_exec(
            "xdotool", "windowactivate", window_id,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc2.communicate()

        return {"method": "native", "matched": window_id, "keyword": keyword}

    async def _switch_via_hotkey(self, keyword: str) -> dict:
        """Hotkey 降级：无法精确切到指定窗口，但能切到下一个。"""
        # 注意：此路径不真正匹配 keyword，仅触发切换快捷键
        # 调用方应理解为「切换到下一个窗口」而非「切到指定窗口」
        from .input import InputController  # 局部 import 避免循环

        # 此处不直接调用 InputController（避免与 routes 层耦合）；
        # 由 routes 层在收到 method='hotkey_only' 时自行调用 press_hotkey
        return {
            "method": "hotkey_only",
            "matched": None,  # 无法精确匹配
            "keyword": keyword,
            "next_step": "call /v1/press_hotkey with [cmd+tab] (macOS) or [alt+tab] (other) to cycle windows",
        }
