"""ΝΩ-53：Raw Input 事件驱动输入镜像 —— cursor/cursor_kind 的零往返读取面。

背景：``/v1/cursor`` 每请求一次 executor 往返（Win32 GetCursorInfo /
pyautogui.position 轮询），悬停探针延迟 5-15ms 且无输入事件流。本模块用
Win32 Raw Input（``RegisterRawInputDevices`` + ``RIDEV_INPUTSINK``）在隐藏
message-only 窗口线程里订阅全局鼠标/键盘事件，维护进程内状态镜像
``{x, y, button_flags, last_key_vk, updated_at}``（threading.Lock 保护）——
读侧变成零系统调用的 dict 快照。

铁律对齐：
  - 运行层绝不抛：所有公有入口（ensure_started/read_position/snapshot/
    recent_events/describe/shutdown）防御式吞异常、诚实降级
    （disabled/unavailable/stale —— 状态机见 ``describe()``）；
  - 默认关闭：``DSH_PHYSICAL_RAW_INPUT=1`` 显式开启（config.RawInputConfig，
    零回归铁律 —— 关闭时本模块对调用方完全不可见）；
  - 零新增第三方依赖：ctypes + 标准库；
  - 启动失败（权限 / 非交互桌面会话 / 非 Windows）⇒ ``state=unavailable`` +
    真实原因，调用方回退既有 Win32 轮询路径（诚实降级，不谎报、不阻塞启动）；
  - 光标**形态**（句柄）不在本镜像内 —— Raw Input 不给句柄，形态比对仍走
    cursor.py 的 GetCursorInfo/LoadCursorW（ΝΩ-53 修法第 2 条的注记边界）。

位置追踪：物理鼠标事件多为相对位移（lLastX/lLastY）—— 线程启动时用
GetCursorPos 播种、每事件累加并 clamp 到虚拟屏幕矩形；绝对位移事件
（MOUSE_MOVE_ABSOLUTE —— RDP/平板）按 0..65535 归一化映射回虚拟屏幕。
``SetCursorPos`` 类程序性移动**不产生** Raw Input ⇒ ``updated_at`` 陈旧度
门（缺省 2s，config-driven）超过即由调用方回退 Win32 轮询 —— 陈旧回退是
诚实设计的一部分，不是缺陷。
"""
from __future__ import annotations

import ctypes
import sys
import threading
import time
from collections import deque
from typing import Any

# ─── Win32 常量（NΩ-53：不引 pywin32 —— 手写 ctypes 绑定）───

WM_INPUT = 0x00FF            # Raw Input 投递消息（经窗口过程，非线程消息）
WM_QUIT = 0x0012             # 优雅关停：PostThreadMessage 投递，GetMessage 返回 0
HWND_MESSAGE = -3            # message-only 窗口父句柄（不可见、不枚举、只收消息）
RIDEV_INPUTSINK = 0x00000100  # 无前台焦点也收全局输入（后台镜像的成立前提）
RID_INPUT = 0x10000003       # GetRawInputData：取原始输入包
RIM_TYPEMOUSE = 0
RIM_TYPEKEYBOARD = 1
RIM_TYPEHID = 2
HID_USAGE_PAGE_GENERIC = 0x01
HID_USAGE_MOUSE = 0x02
HID_USAGE_KEYBOARD = 0x06
MOUSE_MOVE_ABSOLUTE = 0x0001
# usButtonFlags 位（镜像只存原始位图 + 语义名对照，见 BUTTON_FLAG_NAMES）
RI_MOUSE_LEFT_BUTTON_DOWN = 0x0001
RI_MOUSE_LEFT_BUTTON_UP = 0x0002
RI_MOUSE_RIGHT_BUTTON_DOWN = 0x0004
RI_MOUSE_RIGHT_BUTTON_UP = 0x0008
RI_MOUSE_MIDDLE_BUTTON_DOWN = 0x0010
RI_MOUSE_MIDDLE_BUTTON_UP = 0x0020
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_SYSKEYDOWN = 0x0104
WM_SYSKEYUP = 0x0105
# GetSystemMetrics 索引（虚拟屏幕 = 多屏联合矩形 —— clamp/绝对映射的基准）
SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79

BUTTON_FLAG_NAMES: dict[int, str] = {
    RI_MOUSE_LEFT_BUTTON_DOWN: "left_down",
    RI_MOUSE_LEFT_BUTTON_UP: "left_up",
    RI_MOUSE_RIGHT_BUTTON_DOWN: "right_down",
    RI_MOUSE_RIGHT_BUTTON_UP: "right_up",
    RI_MOUSE_MIDDLE_BUTTON_DOWN: "middle_down",
    RI_MOUSE_MIDDLE_BUTTON_UP: "middle_up",
}

KEYDOWN_MESSAGES = {WM_KEYDOWN, WM_SYSKEYDOWN}


# ─── 离线解析层（合成字节可测 —— 单一事实源，线程处理与单测共用）───


def _header_body_offset() -> int:
    """RAWINPUT 头部长度：x64 = 24（HANDLE/WPARAM 各 8 字节），x86 = 16。"""
    return 24 if ctypes.sizeof(ctypes.c_void_p) == 8 else 16


def parse_raw_input(blob: bytes) -> dict:
    """RAWINPUT 原始包 → 语义事件 dict（永不抛；畸形包诚实 ``type="invalid"``）。

    结构（真实 Windows 内存布局，与官方头文件对齐）：
      header: dwType@0(I) dwSize@4(I) hDevice@ptr wParam@ptr
      mouse:  usFlags@0(H) usButtonFlags@4(H) usButtonData@6(H)
              ulRawButtons@8(I) lLastX@12(i) lLastY@16(i) ulExtra@20(I)  → 24 字节
      keyboard: MakeCode@0(H) Flags@2(H) Reserved@4(H) VKey@6(H)
              Message@8(I) ExtraInformation@12(I)                        → 16 字节
    """
    import struct

    try:
        if len(blob) < 8:
            return {"type": "invalid", "reason": f"blob too short: {len(blob)}B"}
        dw_type, dw_size = struct.unpack_from("<II", blob, 0)
        body = blob[_header_body_offset():]
        if dw_type == RIM_TYPEMOUSE:
            if len(body) < 24:
                return {"type": "invalid", "reason": f"mouse body short: {len(body)}B"}
            us_flags, us_button_flags, us_button_data, _raw_buttons, dx, dy, _extra = \
                struct.unpack_from("<H2xHHIiiI", body, 0)
            return {
                "type": "mouse",
                "flags": int(us_flags),
                "absolute": bool(us_flags & MOUSE_MOVE_ABSOLUTE),
                "button_flags": int(us_button_flags),
                "button_data": int(us_button_data),
                "dx": int(dx),
                "dy": int(dy),
                "dw_size": int(dw_size),
            }
        if dw_type == RIM_TYPEKEYBOARD:
            if len(body) < 16:
                return {"type": "invalid", "reason": f"keyboard body short: {len(body)}B"}
            make_code, _flags, _reserved, vkey, message, _extra = \
                struct.unpack_from("<HHHHII", body, 0)
            return {
                "type": "keyboard",
                "vk": int(vkey),
                "message": int(message),
                "down": int(message) in KEYDOWN_MESSAGES,
                "make_code": int(make_code),
                "dw_size": int(dw_size),
            }
        if dw_type == RIM_TYPEHID:
            return {"type": "hid", "dw_size": int(dw_size)}
        return {"type": "invalid", "reason": f"unknown dwType {dw_type}"}
    except Exception as e:  # noqa: BLE001 —— 解析层永不抛（运行层铁律）
        return {"type": "invalid", "reason": f"{type(e).__name__}: {e}"}


# ─── 状态镜像（Lock 保护；读写两侧均为短临界区）───


class RawInputMirror:
    """ΝΩ-53 状态镜像本体：写侧 = hook 线程 apply_*；读侧 = 零调用快照。

    ``updated_at`` 语义 = **鼠标位置**最后一次更新（陈旧度门的判据）；键盘
    事件只刷 ``last_event_at`` —— 光标位置不因打字而"变新鲜"。
    事件环（容量 128，config-driven）：最近输入事件的只读审计面（人手 vs
    agent 注入区分的原始证据流；本任务只做镜像 + 计数）。
    """

    def __init__(self, ring_capacity: int = 128) -> None:
        self._lock = threading.Lock()
        self._ring: deque[dict] = deque(maxlen=max(1, int(ring_capacity)))
        self._state: dict[str, Any] = {
            "x": 0, "y": 0,
            "button_flags": 0,
            "last_key_vk": 0,
            "updated_at": 0.0,
            "last_event_at": 0.0,
        }
        # 虚拟屏幕矩形（clamp / 绝对位移映射基准）—— hook 线程启动时播种，
        # 测试可显式注入（离线用例不依赖真实多屏拓扑）
        self._vx0, self._vy0 = 0, 0
        self._vw, self._vh = 65535, 65535
        self._counts = {"mouse_move": 0, "mouse_button": 0, "key": 0}

    # ── 写侧（hook 线程 / 测试）──

    def set_virtual_bounds(self, x0: int, y0: int, w: int, h: int) -> None:
        with self._lock:
            self._vx0, self._vy0, self._vw, self._vh = int(x0), int(y0), max(1, int(w)), max(1, int(h))

    def seed_position(self, x: int, y: int, now: float | None = None) -> None:
        t = time.time() if now is None else now
        with self._lock:
            self._state["x"], self._state["y"] = int(x), int(y)
            self._state["updated_at"] = t
            self._state["last_event_at"] = t

    def apply_mouse(self, ev: dict, now: float | None = None) -> None:
        """RAWINPUT mouse 事件入镜像（相对位移累加 / 绝对位移映射 + clamp）。"""
        t = time.time() if now is None else now
        with self._lock:
            x, y = self._state["x"], self._state["y"]
            if ev.get("absolute"):
                # MOUSE_MOVE_ABSOLUTE：lLastX/Y 为 0..65535 全屏归一化坐标
                x = self._vx0 + int(ev.get("dx", 0)) * self._vw // 65535
                y = self._vy0 + int(ev.get("dy", 0)) * self._vh // 65535
            else:
                x += int(ev.get("dx", 0))
                y += int(ev.get("dy", 0))
            # clamp 到虚拟屏幕（相对位移越界是常态 —— 屏幕边缘继续推动）
            x = min(max(x, self._vx0), self._vx0 + self._vw - 1)
            y = min(max(y, self._vy0), self._vy0 + self._vh - 1)
            moved = (x, y) != (self._state["x"], self._state["y"])
            self._state["x"], self._state["y"] = x, y
            self._state["updated_at"] = t
            self._state["last_event_at"] = t
            btn = int(ev.get("button_flags", 0))
            if btn:
                self._state["button_flags"] = btn
                self._counts["mouse_button"] += 1
                self._ring.append({
                    "t": t, "type": "mouse_button",
                    "flags": btn, "button": BUTTON_FLAG_NAMES.get(btn, "other"),
                })
            if moved:
                self._counts["mouse_move"] += 1
                self._ring.append({"t": t, "type": "mouse_move", "x": x, "y": y})

    def apply_keyboard(self, ev: dict, now: float | None = None) -> None:
        """RAWINPUT keyboard 事件入镜像（只记 vk —— 不做文本还原，审计面最小化）。"""
        t = time.time() if now is None else now
        with self._lock:
            vk = int(ev.get("vk", 0))
            if vk:
                self._state["last_key_vk"] = vk
            self._state["last_event_at"] = t
            self._counts["key"] += 1
            self._ring.append({"t": t, "type": "key", "vk": vk, "down": bool(ev.get("down"))})

    # ── 读侧（永不抛；dict 拷贝出锁）──

    def snapshot(self) -> dict:
        with self._lock:
            s = dict(self._state)
            s["age_s"] = max(0.0, time.time() - s["updated_at"])
            return s

    def read_position(self, max_stale_s: float = 2.0) -> dict:
        """位置读取 + 陈旧度门：``{ok, x, y, age_s, stale, reason?}``。

        ok=False 的三种诚实形态：未播种（updated_at=0）/ 陈旧 / max_stale_s<=0。
        """
        try:
            s = self.snapshot()
            if s["updated_at"] <= 0.0:
                return {"ok": False, "stale": True, "reason": "not seeded yet"}
            if max_stale_s is not None and max_stale_s > 0 and s["age_s"] > max_stale_s:
                return {
                    "ok": False, "stale": True, "x": s["x"], "y": s["y"],
                    "age_s": s["age_s"], "reason": f"mirror stale ({s['age_s']:.2f}s > {max_stale_s}s)",
                }
            return {"ok": True, "stale": False, "x": s["x"], "y": s["y"], "age_s": s["age_s"]}
        except Exception as e:  # noqa: BLE001 —— 读侧永不抛
            return {"ok": False, "stale": True, "reason": f"{type(e).__name__}: {e}"}

    def recent_events(self, window_s: float = 1.0) -> list[dict]:
        """最近 window_s 秒的事件环快照（只读拷贝 —— 审计面不暴露内部 deque）。"""
        try:
            cutoff = time.time() - max(0.0, window_s)
            with self._lock:
                return [dict(e) for e in self._ring if e.get("t", 0.0) >= cutoff]
        except Exception:  # noqa: BLE001
            return []

    def stats(self) -> dict:
        with self._lock:
            return {
                "counts": dict(self._counts),
                "ring_len": len(self._ring),
                "ring_capacity": self._ring.maxlen,
                "last_event_age_s": max(0.0, time.time() - self._state["last_event_at"]),
            }


# ─── 生命周期（模块级单例；状态机 disabled→starting→running/unavailable→stopped）───

_STATUS: dict[str, Any] = {
    "state": "disabled",       # disabled/starting/running/unavailable/stopped
    "reason": None,
    "enabled": False,          # config 开关的回显（调用方区分"没开"与"开了没成"）
    "started_at": None,
}
_mirror: RawInputMirror | None = None
_thread: threading.Thread | None = None
_tid: int = 0                  # hook 线程 id（PostThreadMessage WM_QUIT 的靶）
_ready: threading.Event = threading.Event()
# RLock（可重入）：ensure_started 临界区内调用 describe()（同锁二次获取）——
# 朴素 Lock 在此自死锁（单测压现：test_disabled_config_is_noop 挂死）
_lifecycle_lock = threading.RLock()
_stale_after_s: float = 2.0    # read_position() 缺省陈旧门（ensure_started 播种）
_atexit_armed = False


def _win32() -> Any | None:
    """user32 绑定（非 win32 平台 ⇒ None —— 调用方诚实 unavailable）。"""
    if sys.platform != "win32":
        return None
    return ctypes.windll.user32  # type: ignore[attr-defined]


def describe() -> dict:
    """镜像生命周期快照（永不抛；/v1/input_events 与降级注记的数据源）。"""
    try:
        with _lifecycle_lock:
            out = dict(_STATUS)
            out["thread_alive"] = bool(_thread and _thread.is_alive())
            return out
    except Exception:  # noqa: BLE001
        return {"state": "unknown", "reason": "describe failed", "enabled": False}


def snapshot() -> dict:
    """镜像状态快照（未启动 ⇒ available=False 诚实形态）。"""
    m = _mirror
    if m is None:
        return {"available": False, "reason": "mirror not started"}
    out = {"available": True}
    out.update(m.snapshot())
    return out


def read_position(max_stale_s: float | None = None) -> dict:
    """ΝΩ-53 镜像读位入口（routes/cursor 共用；永不抛）。

    未启动/未开 ⇒ ``{ok: False, reason: ...}`` —— 调用方回退 Win32 轮询
    （零回归：默认关闭时本函数对旧路径完全透明）。
    """
    try:
        m = _mirror
        if m is None:
            return {"ok": False, "stale": True,
                    "reason": f"raw-input mirror {_STATUS['state']}"}
        return m.read_position(_stale_after_s if max_stale_s is None else max_stale_s)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "stale": True, "reason": f"{type(e).__name__}: {e}"}


def recent_events(window_s: float = 1.0) -> list[dict]:
    m = _mirror
    return m.recent_events(window_s) if m is not None else []


def stats() -> dict:
    m = _mirror
    return m.stats() if m is not None else {"absent": True, "reason": "mirror not started"}


def ensure_started(cfg: Any) -> dict:
    """按配置启动镜像线程（幂等、永不抛）。返回 describe() 快照。

    - ``enabled=False`` ⇒ no-op（默认关闭零回归铁律）；
    - 非 Windows / 窗口创建失败 / RegisterRawInputDevices 失败 ⇒ 状态机
      ``unavailable`` + GetLastError 真实原因 —— 单次尝试不重试（失败风暴
      比缺席更糟），调用方按现状回退轮询。
    """
    global _mirror, _thread, _stale_after_s, _atexit_armed
    with _lifecycle_lock:
        if _STATUS["state"] in ("running", "starting", "unavailable"):
            return describe()
        enabled = bool(getattr(cfg, "enabled", False))
        _STATUS["enabled"] = enabled
        if not enabled:
            _STATUS["state"], _STATUS["reason"] = "disabled", None
            return describe()
        ring_cap = int(getattr(cfg, "ring_capacity", 128) or 128)
        _stale_after_s = float(getattr(cfg, "stale_after_s", 2.0) or 2.0)
        if sys.platform != "win32":
            _STATUS["state"] = "unavailable"
            _STATUS["reason"] = f"raw input requires Windows (platform={sys.platform})"
            return describe()
        _mirror = RawInputMirror(ring_capacity=ring_cap)
        _ready.clear()
        _STATUS["state"], _STATUS["reason"] = "starting", None
        _thread = threading.Thread(
            target=_thread_main, name="dsh-rawinput", daemon=True,
        )
        _thread.start()
        if not _atexit_armed:
            # 优雅关停兜底：ΝΩ-27 drain 链不经过本模块 —— atexit 在解释器
            # 收 daemon 线程前触发 shutdown()（PostThreadMessage WM_QUIT）
            import atexit
            atexit.register(shutdown)
            _atexit_armed = True
    _ready.wait(timeout=3.0)  # 窗口建链通常 <50ms；3s 仍在 starting = 如实报
    return describe()


def shutdown() -> None:
    """优雅关停（PostThreadMessage WM_QUIT + 有界 join；永不抛）。"""
    global _tid
    try:
        with _lifecycle_lock:
            t = _thread
            tid = _tid
            if t is None or not t.is_alive():
                if _STATUS["state"] == "running":
                    _STATUS["state"] = "stopped"
                return
        if tid and _win32() is not None:
            # 消息队列已存在（_ready 在窗口建链后才置位）⇒ 投递必达
            ctypes.windll.user32.PostThreadMessageW(tid, WM_QUIT, 0, 0)  # type: ignore[attr-defined]
        t.join(timeout=1.0)
        with _lifecycle_lock:
            if _STATUS["state"] != "unavailable":
                _STATUS["state"] = "stopped"
                _STATUS["reason"] = None if not t.is_alive() else "thread did not exit in 1s (daemon)"
    except Exception:  # noqa: BLE001 —— 关停路径绝不抛
        pass


def _set_state(state: str, reason: str | None) -> None:
    with _lifecycle_lock:
        _STATUS["state"] = state
        _STATUS["reason"] = reason


# ─── hook 线程主体（Win32；任何失败 ⇒ unavailable 诚实退场）───


def _thread_main() -> None:
    global _tid
    user32 = _win32()
    if user32 is None:
        _set_state("unavailable", "user32 unavailable")
        _ready.set()
        return
    from ctypes import wintypes

    class WNDCLASSEXW(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.UINT), ("style", wintypes.UINT),
            ("lpfnWndProc", ctypes.c_void_p), ("cbClsExtra", wintypes.INT),
            ("cbWndExtra", wintypes.INT), ("hInstance", wintypes.HINSTANCE),
            ("hIcon", wintypes.HICON), ("hCursor", wintypes.HANDLE),
            ("hbrBackground", wintypes.HBRUSH), ("lpszMenuName", wintypes.LPCWSTR),
            ("lpszClassName", wintypes.LPCWSTR), ("hIconSm", wintypes.HICON),
        ]

    class RAWINPUTDEVICE(ctypes.Structure):
        _fields_ = [
            ("usUsagePage", wintypes.USHORT), ("usUsage", wintypes.USHORT),
            ("dwFlags", wintypes.DWORD), ("hwndTarget", wintypes.HWND),
        ]

    class RAWINPUTHEADER(ctypes.Structure):
        _fields_ = [
            ("dwType", wintypes.DWORD), ("dwSize", wintypes.DWORD),
            ("hDevice", wintypes.HANDLE), ("wParam", wintypes.WPARAM),
        ]

    class MSG(ctypes.Structure):
        _fields_ = [
            ("hwnd", wintypes.HWND), ("message", wintypes.UINT),
            ("wParam", wintypes.WPARAM), ("lParam", wintypes.LPARAM),
            ("time", wintypes.DWORD), ("pt", wintypes.POINT),
        ]

    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    # 句柄/HRESULT 宽度修正：不设 restype 会被截成 32 位（cursor.py 的
    # LoadCursorW 同款坑）—— 64 位上句柄比较/传递必假
    kernel32.GetModuleHandleW.restype = ctypes.c_void_p
    kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
    user32.CreateWindowExW.restype = wintypes.HWND
    user32.CreateWindowExW.argtypes = [
        wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID,
    ]
    user32.GetRawInputData.restype = wintypes.UINT
    user32.GetRawInputData.argtypes = [
        wintypes.HANDLE, wintypes.UINT, wintypes.LPVOID,
        ctypes.POINTER(wintypes.UINT), wintypes.UINT,
    ]
    # DefWindowProcW 全宽绑定：缺省 argtypes 会把 wparam/lparam 截成 32 位
    # c_int —— 携带句柄量级值的消息即 OverflowError（真机冒烟压现）
    user32.DefWindowProcW.restype = ctypes.c_ssize_t
    user32.DefWindowProcW.argtypes = [
        wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
    ]
    hinstance = kernel32.GetModuleHandleW(None)
    class_name = f"DshRawInputSink-{kernel32.GetCurrentProcessId()}"
    mirror = _mirror

    def _fail(reason: str) -> None:
        _set_state("unavailable", reason)
        _ready.set()

    def wnd_proc(hwnd: int, msg: int, wparam: int, lparam: int) -> int:
        # ΝΩ-53：WM_INPUT 在窗口过程投递（GetMessage 只回投递给线程的消息）；
        # 处理后必须回落 DefWindowProc（Raw Input 文档要求的清理路径）。
        if msg == WM_INPUT:
            try:
                _handle_raw_input(user32, ctypes.c_void_p(lparam), mirror)
            except Exception:  # noqa: BLE001 —— hook 层绝不抛（抛出 = 进程死）
                pass
        return int(user32.DefWindowProcW(hwnd, msg, wparam, lparam) or 0)

    WNDPROC = ctypes.WINFUNCTYPE(
        ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT,
        wintypes.WPARAM, wintypes.LPARAM,
    )
    wnd_proc_c = WNDPROC(wnd_proc)  # 持引用防 GC（窗口存活期间回调指针必须有效）

    wc = WNDCLASSEXW()
    wc.cbSize = ctypes.sizeof(WNDCLASSEXW)
    wc.lpfnWndProc = ctypes.cast(wnd_proc_c, ctypes.c_void_p)
    wc.hInstance = hinstance
    wc.lpszClassName = class_name
    if not user32.RegisterClassExW(ctypes.byref(wc)):
        _fail(f"RegisterClassExW failed (GetLastError={kernel32.GetLastError()})")
        return

    hwnd = user32.CreateWindowExW(
        0, class_name, None, 0, 0, 0, 0, 0,
        wintypes.HWND(HWND_MESSAGE), None, hinstance, None,
    )
    if not hwnd:
        user32.UnregisterClassW(class_name, hinstance)
        _fail(f"CreateWindowExW failed (GetLastError={kernel32.GetLastError()})")
        return

    try:
        # 订阅鼠标 + 键盘（INPUTSINK：无焦点也收 —— 后台镜像语义）
        devices = (RAWINPUTDEVICE * 2)(
            RAWINPUTDEVICE(HID_USAGE_PAGE_GENERIC, HID_USAGE_MOUSE, RIDEV_INPUTSINK, hwnd),
            RAWINPUTDEVICE(HID_USAGE_PAGE_GENERIC, HID_USAGE_KEYBOARD, RIDEV_INPUTSINK, hwnd),
        )
        if not user32.RegisterRawInputDevices(devices, 2, ctypes.sizeof(RAWINPUTDEVICE)):
            _fail(f"RegisterRawInputDevices failed (GetLastError={kernel32.GetLastError()})")
            return

        # 位置播种 + 虚拟屏幕矩形（clamp/绝对映射基准）
        pt = wintypes.POINT(0, 0)
        user32.GetCursorPos(ctypes.byref(pt))
        vx = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
        vy = user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
        vw = user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)
        vh = user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)
        if mirror is not None:
            mirror.set_virtual_bounds(vx, vy, max(1, vw), max(1, vh))
            mirror.seed_position(pt.x, pt.y)

        # 线程 id 就绪门：窗口已建（消息队列必在）⇒ PostThreadMessage 可达
        global _tid
        with _lifecycle_lock:
            _tid = int(kernel32.GetCurrentThreadId())
        _STATUS["started_at"] = time.time()
        _set_state("running", None)
        _ready.set()

        msg = MSG()
        while True:
            ret = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
            if ret == 0 or ret == -1:  # 0 = WM_QUIT（优雅）；-1 = 错误（诚实降级）
                if ret == -1:
                    _set_state("stopped", f"GetMessageW error (GetLastError={kernel32.GetLastError()})")
                break
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))
    finally:
        try:
            user32.DestroyWindow(hwnd)
        except Exception:  # noqa: BLE001
            pass
        try:
            user32.UnregisterClassW(class_name, hinstance)
        except Exception:  # noqa: BLE001
            pass
        with _lifecycle_lock:
            if _STATUS["state"] == "running":
                _STATUS["state"] = "stopped"
                _STATUS["reason"] = None
        _ready.set()


def _handle_raw_input(user32: Any, h_raw_input: Any, mirror: RawInputMirror | None) -> None:
    """WM_INPUT → GetRawInputData 原始包 → parse_raw_input → 镜像写入。"""
    size = ctypes.c_uint(0)
    hdr_size = 24 if ctypes.sizeof(ctypes.c_void_p) == 8 else 16  # RAWINPUTHEADER
    # restype=UINT（_thread_main 绑定）：失败 = (UINT)-1 = 4294967295
    if user32.GetRawInputData(h_raw_input, RID_INPUT, None, ctypes.byref(size), hdr_size) == 0xFFFFFFFF:
        return
    if size.value <= 0:
        return
    buf = ctypes.create_string_buffer(size.value)
    got = user32.GetRawInputData(h_raw_input, RID_INPUT, buf, ctypes.byref(size), hdr_size)
    if got == 0xFFFFFFFF or got <= 0:
        return
    ev = parse_raw_input(bytes(buf.raw[:size.value]))
    if mirror is None:
        return
    if ev.get("type") == "mouse":
        mirror.apply_mouse(ev)
    elif ev.get("type") == "keyboard":
        mirror.apply_keyboard(ev)
    # hid/invalid：诚实跳过（MVP 镜像只关照鼠标/键盘）
