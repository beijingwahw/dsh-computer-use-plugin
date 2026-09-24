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

# Y6：常见应用的窗口标题本地化别名（小写）。英文关键词在中文 Windows 上
# 匹配不到本地化标题（"Calculator" vs "计算器"）—— 切窗先试原词，再试别名。
WINDOW_TITLE_ALIASES: dict[str, list[str]] = {
    "notepad": ["记事本"],
    "calculator": ["计算器"],
    "calc": ["计算器"],
    "paint": ["画图", "绘图"],
    "mspaint": ["画图", "绘图"],
    "explorer": ["资源管理器", "文件资源管理器"],
    "file explorer": ["资源管理器", "文件资源管理器"],
    "edge": ["microsoft edge"],
    "msedge": ["microsoft edge"],
    "chrome": ["google chrome"],
    "firefox": ["mozilla firefox"],
    "word": ["microsoft word"],
    "excel": ["microsoft excel"],
    "记事本": ["notepad"],
    "计算器": ["calculator"],
    "画图": ["paint"],
    "资源管理器": ["explorer", "file explorer"],
}


def escape_applescript(text: str) -> str:
    """AppleScript 字符串字面量转义（J 纪元：从内联修复提为可测纯函数）。

    铁律：**先转义反斜杠、再转义引号** —— 顺序不可反（先引号会引入新反斜杠，
    再转义反斜杠时被二次翻倍）。旧实现的注入面即源于此 + 占位符 no-op。
    """
    return text.replace("\\", "\\\\").replace('"', '\\"')


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
            except PhysicalError as e:
                # Y6 真机战果：ELEMENT_NOT_FOUND 是调用方关键词未命中（合法失败，
                # 错误里带可用窗口清单供模型一轮自纠）—— 必须原样上抛。
                # 旧实现把它当"原生不可用"一并触发 hotkey 永久降级：一个打错的
                # 探测词（如 ZZZ-NOT-EXIST）就毒化服务余生，后续所有切窗盲降
                # alt+tab。只有 WINDOW_UNAVAILABLE 这类后端缺席才允许降级。
                if e.kind == ErrorKind.ELEMENT_NOT_FOUND:
                    raise
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

        # J 纪元修正 AppleScript 注入防护（旧实现两处错误）：
        #   1. f-string 先插值原始 keyword，再 replace('"{keyword}"', ...) —— 占位符
        #      已不存在，replace 恒 no-op，原始 keyword（可含引号/括号）直接注入脚本；
        #   2. 转义顺序反了 —— 先替换引号再替换反斜杠，会把第一步引入的反斜杠再翻倍。
        # 正确做法：先转义反斜杠、再转义引号（escape_applescript 纯函数，可测），
        # 然后把转义后的值直接插进脚本。
        safe_keyword = escape_applescript(keyword)
        script = f'''
        tell application "System Events"
            set frontmostApp to ""
            repeat with proc in (every process whose background only is false)
                repeat with w in windows of proc
                    if name of w contains "{safe_keyword}" then
                        set frontmost of proc to true
                        perform action "AXRaise" of w
                        return name of proc & "|" & name of w
                    end if
                end repeat
            end repeat
            return ""
        end tell
        '''

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
        """Windows：pygetwindow + SetForegroundWindow。

        Y6 真机战果三连修：
          1. ``gw.getWindowsWithTitle`` 是**大小写敏感**子串匹配 —— 模型传
             "todo-a" 匹配不到 "TODO-A"，改为自行枚举 + lower() 包含；
          2. 英文关键词在中文 Windows 上必然落空（"Calculator" vs "计算器"），
             加常见应用的本地化别名表，关键词与别名依次尝试；
          3. 未命中时的错误信息附上当前全部可见窗口标题 —— 模型一轮自纠，
             不再盲试 alt+tab。
        """
        try:
            import pygetwindow as gw  # type: ignore[import-not-found]
        except ImportError as e:
            raise PhysicalError(
                ErrorKind.WINDOW_UNAVAILABLE,
                f"pygetwindow not installed: {e}",
            ) from e

        def _do_switch() -> str:
            candidates = [keyword.strip().lower()] + [
                alias for alias in WINDOW_TITLE_ALIASES.get(keyword.strip().lower(), [])
            ]
            windows = [w for w in gw.getAllWindows() if w.title.strip()]
            for w in windows:
                title_lower = w.title.lower()
                if any(c and c in title_lower for c in candidates):
                    if w.isMinimized:
                        w.restore()
                    w.activate()
                    return w.title
            titles = "; ".join(w.title[:40] for w in windows[:12]) or "(none)"
            raise PhysicalError(
                ErrorKind.ELEMENT_NOT_FOUND,
                f"no window with title containing {keyword!r} (tried aliases: "
                f"{candidates}). Visible windows: {titles}",
            )

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
