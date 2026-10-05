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
from . import dpi as _dpi  # ΠΑΝ-81/82: DPI 像素域契约（见 dpi.py）

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
    # ΠΑΝ-82: 先锁进程 DPI 感知，再允许 pyautogui 入场 —— pyautogui 的
    # _pyautogui_win.py 在 import 时调用 SetProcessDPIAware()（进程级副作用，
    # 与 uiautomation 同病）。我们的 per-monitor-v2 档位先立，OS「只能升不能
    # 降」即封死其翻转 ⇒ pyautogui.size() 恒物理像素，不再随导入时序漂移。
    _dpi.ensure_process_dpi_awareness()
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
# R2-2: 文档级镜像收口 —— TS 侧白名单（pressHotkey.HOTKEY_WHITELIST_KEYS /
# system._getKey fallbackMap）已补全字母表与导航键（根因：缺 s 致 ctrl+s 被
# 协议层拒，R1-8 冒烟遗留①）；_KEY_MAP 本就含全字母表+导航，此处仅同步声明。
Key = Literal[
    "ctrl", "cmd", "alt", "shift",
    "enter", "tab", "space", "backspace", "delete", "esc",
    "home", "end", "pageup", "pagedown",
    "up", "down", "left", "right",
    "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
    "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
    "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
]

# ``keyMap`` 与 D-5 system.ts 严格一致 —— 任何扩展必须双向同步
_KEY_MAP: dict[str, str] = {
    "ctrl": "ctrl",       # pyautogui 接受 'ctrl' 简写
    "cmd": "cmd" if sys.platform == "darwin" else "win",
    # Windows 键的完整别名族（win+r 运行框 / win+d 显示桌面 / win+e 资源管理器
    # 是 GUI 自动化的高频入口 —— 缺失时 Agent 只能绕道 shell 启动应用）
    "win": "cmd" if sys.platform == "darwin" else "win",
    "meta": "cmd" if sys.platform == "darwin" else "win",
    "super": "cmd" if sys.platform == "darwin" else "win",
    "alt": "alt",
    "shift": "shift",
    "enter": "enter",
    "return": "enter",
    "tab": "tab",
    "space": "space",
    "backspace": "backspace",
    "delete": "delete",
    "del": "delete",
    "esc": "esc",
    "escape": "esc",
    # 导航与编辑键（滚动/选择/对话框导航的键盘模态）
    "home": "home", "end": "end",
    "pageup": "pageup", "pagedown": "pagedown",
    "up": "up", "down": "down", "left": "left", "right": "right",
    "arrowup": "up", "arrowdown": "down", "arrowleft": "left", "arrowright": "right",
    "printscreen": "printscreen", "prtsc": "printscreen",
    "f1": "f1", "f2": "f2", "f3": "f3", "f4": "f4", "f5": "f5",
    "f6": "f6", "f7": "f7", "f8": "f8", "f9": "f9", "f10": "f10",
    "f11": "f11", "f12": "f12",
    # 编辑快捷键常用字母（全字母表补齐 —— ctrl+s / ctrl+o / ctrl+n 等组合的完整覆盖）
    **{chr(c): chr(c) for c in range(ord("a"), ord("z") + 1)},
    **{str(d): str(d) for d in range(0, 10)},
}

# ─── Windows IME-proof typing（X 纪元真机战果）───
# pyautogui.typewrite 发虚拟键码 —— 经活动输入法（中文 IME）时被劫持：
# 'alpha.local' → 'alpha。local'、'ada' → '阿达'（拼音候选上屏）。物理躯体
# 的打字必须与键盘布局/输入法状态正交：SendInput + KEYEVENTF_UNICODE 按
# UTF-16 码元直注 WM_CHAR，绕过 IME 组合管线 —— 这是 Windows 上唯一与
# 输入法无关的确定性文本注入路径。非 Windows 平台保持 typewrite。
if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    _PUL = ctypes.POINTER(ctypes.c_ulong)

    class _KEYBDINPUT(ctypes.Structure):
        _fields_ = [
            ("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
            ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
            ("dwExtraInfo", _PUL),
        ]

    class _MOUSEINPUT(ctypes.Structure):
        _fields_ = [
            ("dx", wintypes.LONG), ("dy", wintypes.LONG),
            ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD), ("dwExtraInfo", _PUL),
        ]

    class _HARDWAREINPUT(ctypes.Structure):
        _fields_ = [("uMsg", wintypes.DWORD), ("wParamL", wintypes.WORD), ("wParamH", wintypes.WORD)]

    class _INPUTUNION(ctypes.Union):
        _fields_ = [("mi", _MOUSEINPUT), ("ki", _KEYBDINPUT), ("hi", _HARDWAREINPUT)]

    class _INPUT(ctypes.Structure):
        # 完整 union 布局（SendInput 校验 cbSize —— 只写 ki 会给短结构）
        _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]

    _INPUT_KEYBOARD = 1
    _KEYEVENTF_UNICODE = 0x0004
    _KEYEVENTF_KEYUP = 0x0002
    _VK_RETURN = 0x0D

    # R5-2（D5 修复）：换行注入计划 —— ("enter", 0) = 真回车键事件；
    # ("uni", scan) = KEYEVENTF_UNICODE 直注码元。
    def _newline_plan(text: str) -> list[tuple[str, int]]:
        """R5-2（D5 根因修复）：多行文本的换行语义归一。

        批1 seed-report 实战（R4-2 §2.1/§4 D5）：KEYEVENTF_UNICODE 以
        wScan=0x000A 注入 '\\n' 时，系统合成 VK_PACKET → WM_CHAR 0x0A ——
        而 Windows 编辑控件（记事本/EDIT/RichEdit 家族）只认 '\\r'(0x0D)
        为换行，0x0A 被静默丢弃 ⇒ 多行文本塌缩成单行（两轮全废、9 浪费步，
        模型被迫自行诊断改「逐行+enter」绕行）。

        修法：\\r\\n / \\r / \\n 三种形态归一为**真 VK_RETURN down/up 键事件**
        （WM_KEYDOWN(VK_RETURN) + TranslateMessage → WM_CHAR '\\r' —— 与用户
        手按 Enter 字节等价），其余码元仍走 UNICODE 直注。非 BMP 字符拆
        代理对（两码元各自成事件，SendInput 语义），保持旧路径逐字节不变。
        """
        plan: list[tuple[str, int]] = []
        i, n = 0, len(text)
        while i < n:
            ch = text[i]
            if ch == "\r":
                plan.append(("enter", 0))
                if i + 1 < n and text[i + 1] == "\n":
                    i += 1  # CRLF 记一次回车
            elif ch == "\n":
                plan.append(("enter", 0))
            else:
                cp = ord(ch)
                if cp > 0xFFFF:
                    # 代理对：高/低半区各自一个 VK_PACKET 事件
                    cp -= 0x10000
                    plan.append(("uni", 0xD800 + (cp >> 10)))
                    plan.append(("uni", 0xDC00 + (cp & 0x3FF)))
                else:
                    plan.append(("uni", cp))
            i += 1
        return plan

    def _type_unicode(text: str, _sender=None) -> int:
        """UTF-16 码元逐个直注（ surrogate pair 各自成事件 —— SendInput 语义）。

        R5-2（D5）：换行不再走 UNICODE 直注（0x0A 会被编辑控件吞掉），
        改发真 VK_RETURN 键事件 —— 见 ``_newline_plan`` 战果注记。
        ``_sender``：注入函数的可注入缝（测试拦截 SendInput 系统调用边界，
        全路径单测不占 GUI）；缺省 = ctypes.windll.user32.SendInput。
        """
        send = _sender if _sender is not None else ctypes.windll.user32.SendInput
        inputs = []
        for kind, scan in _newline_plan(text):
            if kind == "enter":
                for flag in (0, _KEYEVENTF_KEYUP):
                    inp = _INPUT(type=_INPUT_KEYBOARD)
                    inp.u.ki = _KEYBDINPUT(
                        wVk=_VK_RETURN, wScan=0,
                        dwFlags=flag, time=0, dwExtraInfo=None,
                    )
                    inputs.append(inp)
            else:
                for flag in (0, _KEYEVENTF_KEYUP):
                    inp = _INPUT(type=_INPUT_KEYBOARD)
                    inp.u.ki = _KEYBDINPUT(
                        wVk=0, wScan=scan,
                        dwFlags=_KEYEVENTF_UNICODE | flag, time=0, dwExtraInfo=None,
                    )
                    inputs.append(inp)
        if not inputs:
            return 0
        arr = (_INPUT * len(inputs))(*inputs)
        return int(send(len(inputs), arr, ctypes.sizeof(_INPUT)))


# ─── 串行队列：所有物理动作经此排队（ioMutex 同源）───

_io_lock: asyncio.Lock | None = None


def _get_lock() -> asyncio.Lock:
    global _io_lock
    if _io_lock is None:
        _io_lock = asyncio.Lock()
    return _io_lock


async def _run_in_executor(func, *args, **kwargs):
    """把同步 pyautogui 调用丢到**输入专属池**，避免阻塞事件循环。

    ΑΩ-R25 专属执行器隔离：原本 ``run_in_executor(None, ...)`` 走 asyncio
    缺省共享池 —— 慢 adb 子进程（device 面）/大图编码（screen 面）会把
    物理动作堵在队头（head-of-line blocking）。现在固定走 executors.INPUT_POOL
    （小而快、2 worker：动作本就被 ``_io_lock`` 串行化，第 2 worker 只为
    尺寸读取/探针不排在长 typewrite 后面）。

    支持 kwargs（经 ``functools.partial`` 绑定）—— J 纪元修复：
    旧签名 ``(*args)`` 使 ``pa.click(x, y, button=...)`` 必抛 TypeError，
    真实点击路径 100% 失败（被 ``safe_call`` 误归为 internal_error）。

    Y6 真机战果补丁：动作开始时鼠标恰好停在屏幕角落（往往是上一步动作的
    落点残留），pyautogui 的 fail-safe 急停被误触发 —— win+r / 任务栏点击
    整段失败。自愈路径：临时解除 FAILSAFE → 鼠标回屏幕中心 → 恢复
    FAILSAFE → 原调用重试一次。用户在动作进行中甩鼠标到角落的急停能力
    不受影响（正常路径 FAILSAFE 全程在场，仅恢复移动这一步旁路）。
    """
    from . import executors as _executors  # ΑΩ-R25：输入专属池

    loop = asyncio.get_running_loop()
    pool = _executors.get(_executors.INPUT_POOL)
    call = functools.partial(func, *args, **kwargs) if kwargs else functools.partial(func, *args)
    try:
        return await loop.run_in_executor(pool, call)
    except Exception as e:  # noqa: BLE001
        if type(e).__name__ != "FailSafeException":
            raise
        pa = _get_pyautogui()
        saved = pa.FAILSAFE
        pa.FAILSAFE = False
        try:
            def _recentre() -> None:
                w, h = pa.size()
                pa.moveTo(w // 2, h // 2, _pause=False)
            await loop.run_in_executor(pool, _recentre)
        finally:
            pa.FAILSAFE = saved
        return await loop.run_in_executor(pool, call)


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
        # ΠΑΝ-81: 缓存键含 DPI 域指纹（domain_epoch = 感知档位 + 系统 DPI）
        self._screen_size_epoch: tuple | None = None

    def set_dry_run(self, dry: bool) -> None:
        self._dry_run = dry

    async def get_screen_size(self) -> tuple[int, int]:
        """获取屏幕尺寸（TTL 缓存 + DPI 域感知失效）。

        ΠΑΝ-81：读数域 = 进程 DPI 感知档位（契约下恒物理像素，见 dpi.py）。
        缓存键含域指纹 —— 第三方库中途翻转进程感知（C2-5 H-2 的 30s 窗口
        内旧逻辑读数换算新物理坐标病灶）、或显示器 DPI 档变化时，缓存立即
        失效重查，绝不用旧域读数换算新域像素。
        """
        now = time.monotonic()
        epoch = _dpi.domain_epoch()
        if (
            self._screen_size is None
            or now - self._screen_size_at > self.SCREEN_SIZE_TTL_S
            or self._screen_size_epoch != epoch  # ΠΑΝ-81: 域翻转 ⇒ 立即失效
        ):
            try:
                pa = _get_pyautogui()
                size = await _run_in_executor(lambda: pa.size())
                self._screen_size = (int(size.width), int(size.height))
                self._screen_size_at = now
                self._screen_size_epoch = epoch
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

    async def click(self, x: float, y: float, button: str = "left", dry_run: bool | None = None) -> dict:
        """点击鼠标。

        返回 ``{ pixel, screen }`` 用于审计回执。
        ``dry_run``：调用级覆盖（并发安全 —— ``set_dry_run`` 是共享可变态，
        并发请求互踩标志会把真实点击静默变空操作）；None = 沿用控制器标志。
        """
        dry = self._dry_run if dry_run is None else dry_run
        if button not in _BUTTON_MAP:
            raise PhysicalError(
                ErrorKind.UNKNOWN_BUTTON,
                f"unknown mouse button: {button!r} (allowed: left/right/middle)",
            )
        btn = _BUTTON_MAP[button]
        size = await self.get_screen_size()
        px, py = self._normalize_to_pixel(x, y)

        if dry:
            return {"pixel": {"x": px, "y": py}, "screen": {"width": size[0], "height": size[1]}}

        async with _get_lock():
            pa = _get_pyautogui()
            await _run_in_executor(
                pa.click,
                px, py, button=btn, _pause=False,
            )
            await asyncio.sleep(self.cfg.pause_after_action_ms / 1000)

        return {"pixel": {"x": px, "y": py}, "screen": {"width": size[0], "height": size[1]}}

    async def type_text(self, text: str, clear_first: bool = False, dry_run: bool | None = None) -> dict:
        """输入文本。

        ``clear_first=True``：Mac=Cmd+A / Win=Ctrl+A 然后 Backspace 全选删除。
        ``dry_run``：调用级覆盖（见 ``click`` —— 并发安全）。
        """
        dry = self._dry_run if dry_run is None else dry_run
        if dry:
            return {"typed_chars": len(text)}

        async with _get_lock():
            pa = _get_pyautogui()
            if clear_first:
                if sys.platform == "darwin":
                    await _run_in_executor(pa.hotkey, "command", "a")
                else:
                    await _run_in_executor(pa.hotkey, "ctrl", "a")
                await _run_in_executor(pa.press, "backspace")
            if sys.platform == "win32" and text:
                # IME-proof：SendInput UNICODE 直注（见模块顶部战果注记）。
                # R5-2（D5）：换行按 _newline_plan 归一为真回车键事件 —— 事件数
                # 对账以同一计划为尺（每原子 down+up = 2 事件；\r\n 记 1 原子）。
                expected = len(_newline_plan(text)) * 2
                sent = await _run_in_executor(_type_unicode, text)
                if sent < expected:
                    raise PhysicalError(
                        ErrorKind.INTERNAL_ERROR,
                        f"SendInput(unicode) incomplete: {sent}/{expected} events",
                    )
            elif text:
                # type 安全：长文本可能触发 KeyBoardInterrupt？我们在线程池中跑，无影响
                await _run_in_executor(lambda: pa.typewrite(text, interval=0))
            await asyncio.sleep(self.cfg.pause_after_action_ms / 1000)

        return {"typed_chars": len(text)}

    async def scroll(self, direction: str, amount: int, dry_run: bool | None = None) -> dict:
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

        dry = self._dry_run if dry_run is None else dry_run
        if dry:
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

    async def press_hotkey(self, keys: list[str], dry_run: bool | None = None) -> dict:
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

        dry = self._dry_run if dry_run is None else dry_run
        if dry:
            return {"pressed": mapped}

        async with _get_lock():
            pa = _get_pyautogui()
            # pyautogui.hotkey 自动按下所有键再释放（对称语义）
            await _run_in_executor(lambda: pa.hotkey(*mapped))
            await asyncio.sleep(self.cfg.pause_after_action_ms / 1000)

        return {"pressed": mapped}

    async def move(self, x: float, y: float, duration_ms: float = 0.0, dry_run: bool | None = None) -> dict:
        """移动鼠标（不点击）—— Z-1 交互性探针的悬停动作。

        与 ``click`` 的差异：无 ``pause_after_action_ms`` 等待 —— 探针自己
        控制悬停停留与复位时序（dwell 在调用方）。
        """
        dry = self._dry_run if dry_run is None else dry_run
        size = await self.get_screen_size()
        px, py = self._normalize_to_pixel(x, y)

        if dry:
            return {
                "pixel": {"x": px, "y": py},
                "screen": {"width": size[0], "height": size[1]},
                "dry_run": True,
            }

        async with _get_lock():
            pa = _get_pyautogui()
            await _run_in_executor(
                pa.moveTo, px, py,
                duration=duration_ms / 1000.0, _pause=False,
            )

        return {"pixel": {"x": px, "y": py}}

    async def drag(self, start: dict, end: dict, dry_run: bool | None = None) -> dict:
        """拖拽鼠标：start/end 都是归一化 {x, y}。

        pyautogui ``dragTo`` 的默认拖拽时长是 0.0；我们用 ``mouseDownTimer`` 风格的
        两阶段：``moveTo(start)`` → ``mouseDown`` → ``moveTo(end)`` → ``mouseUp``。
        """
        dry = self._dry_run if dry_run is None else dry_run
        try:
            sx, sy = float(start["x"]), float(start["y"])
            ex, ey = float(end["x"]), float(end["y"])
        except (KeyError, TypeError, ValueError) as e:
            raise PhysicalError(
                ErrorKind.INVALID_ARGS,
                f"drag start/end must be {{x,y}}: {e}",
            ) from e

        if dry:
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
