"""ΠΑΝ-81: 进程级 DPI 域契约 —— 单一坐标域（物理像素）的立法 / 执法 / 诊断。

背景（批判报告 C2-5 H-1/H-2）：三个读屏通道各自落在不同像素域——
  - ``EnumDisplayMonitors``/``GetMonitorInfoW``：随进程 DPI 感知档位
    （unaware 进程得到**逻辑**像素 —— 真机 1920x1080@125% 实测 1536x864）；
  - ``ImageGrab``/``pyautogui.screenshot()``：**物理**像素（PIL 内部按物理
    分辨率抓取，与感知无关）；
  - ``pyautogui.size()``（GetSystemMetrics）：随线程/进程感知（unaware ⇒
    逻辑像素）。
  ⇒ 125% 缩放屏上：ui_tree L2「物理 bbox ÷ 逻辑 screen_size」系统性放大
  1.25×；输入域与树域同类漂移（C2-5 H-1）。

叠加第三方库的进程级副作用（C2-5 H-2）：``uiautomation`` 与 ``pyautogui``
自身（``_pyautogui_win.py`` import 时 ``SetProcessDPIAware()``）都会翻转
进程感知 ——「哪个端点先被调用」决定坐标域，同一会话前后读数不一致。

契约（本模块立法）：
  1. 进程启动即显式申请 ``PER_MONITOR_AWARE_V2``（Win10 1703+ 的 context
     API，纯 ctypes，幂等，绝不抛）—— 申请成功后全链统一**物理像素**；
  2. 感知只能升不能降：宿主 manifest / 更早的第三方调用已钉死感知时本申请
     ``E_ACCESSDENIED`` —— 如实记录当前档位（``pixel_domain_report`` 申报），
     绝不谎报「已统一」；
  3. 任何会翻转感知的第三方库导入**之前**必须先经 ``ensure_process_dpi_awareness``
     （ΠΑΝ-82 执法点：input._get_pyautogui / hit_test / ui_tree 的
     uiautomation 导入）。

诊断面：``pixel_domain_report()``（各坐标端点当前所处域）。
"""
from __future__ import annotations

import ctypes
import sys
import threading

# DPI_AWARENESS_CONTEXT 伪句柄（winuser.h；sign-extended 到指针宽）
_CTX_PER_MONITOR_AWARE_V2 = -4
_CTX_PER_MONITOR_AWARE = -3
_CTX_SYSTEM_AWARE = -2
_CTX_UNAWARE = -1

# GetAwarenessFromDpiAwarenessContext 返回的 DPI_AWARENESS 枚举（v2 是
# context 级差异，不在该枚举内 —— 用 AreDpiAwarenessContextsEqual 区分）
_AWARENESS_ENUM_NAMES = {0: "unaware", 1: "system", 2: "per-monitor"}

# 感知档位 → 坐标域（契约申报）。诚实边界：system 档仅在系统 DPI 的主屏上
# 是物理像素，混缩放多屏仍被虚拟化 —— 单独标注，不冒充 physical。
_DOMAIN_OF_AWARENESS = {
    "unaware": "logical",
    "system": "physical(system-dpi)",
    "per-monitor": "physical",
    "per-monitor-v2": "physical",
    "non-windows": "non-windows",
    "unknown": "unknown",
}

_lock = threading.Lock()
_state: dict = {"attempted": False, "achieved": False, "error": None}


def _user32():
    """user32 句柄（非 win32 / 加载失败 ⇒ None —— 契约尽力而为，绝不抛）。"""
    if sys.platform != "win32":
        return None
    try:
        return ctypes.windll.user32  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        return None


def _ctx_equal(u, ctx: int, special: int) -> bool:
    """语义比较两个 DPI_AWARENESS_CONTEXT（真句柄 vs 伪句柄均可 —— 该 API
    的存在意义就是抹平「manifest 真句柄 / API 伪句柄」两种形态）。"""
    try:
        u.AreDpiAwarenessContextsEqual.restype = ctypes.c_int
        u.AreDpiAwarenessContextsEqual.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        return bool(
            u.AreDpiAwarenessContextsEqual(ctypes.c_void_p(ctx), ctypes.c_void_p(special))
        )
    except Exception:  # noqa: BLE001
        return False


def _process_ctx(u):
    """当前进程 DPI_AWARENESS_CONTEXT 句柄（读不到 ⇒ None，绝不抛）。

    探测链：``GetDpiAwarenessContextForProcess``（本机已验证可用）→
    ``GetThreadDpiAwarenessContext``（未显式设置线程感知的线程，其 context
    == 进程 context）。两个 getter 在不同 Windows 构建上可用性漂移（本机
    26200 无 GetProcessDpiAwarenessContext）—— 逐个降级探测。
    """
    try:
        if hasattr(u, "GetDpiAwarenessContextForProcess"):
            u.GetDpiAwarenessContextForProcess.restype = ctypes.c_void_p
            u.GetDpiAwarenessContextForProcess.argtypes = [ctypes.c_void_p]
            h = u.GetDpiAwarenessContextForProcess(
                ctypes.c_void_p(ctypes.windll.kernel32.GetCurrentProcess())
            )
            if h:
                return h
    except Exception:  # noqa: BLE001
        pass
    try:
        u.GetThreadDpiAwarenessContext.restype = ctypes.c_void_p
        return u.GetThreadDpiAwarenessContext()
    except Exception:  # noqa: BLE001
        return None


def current_dpi_awareness() -> str:
    """进程当前 DPI 感知档位名（unaware/system/per-monitor/per-monitor-v2；
    非 Windows ⇒ ``non-windows``；探测失败 ⇒ ``unknown``。永不抛）。"""
    u = _user32()
    if u is None:
        return "non-windows"
    ctx = _process_ctx(u)
    if not ctx:
        return "unknown"
    for special, name in (
        (_CTX_PER_MONITOR_AWARE_V2, "per-monitor-v2"),
        (_CTX_PER_MONITOR_AWARE, "per-monitor"),
        (_CTX_SYSTEM_AWARE, "system"),
        (_CTX_UNAWARE, "unaware"),
    ):
        if _ctx_equal(u, ctx, special):
            return name
    try:
        u.GetAwarenessFromDpiAwarenessContext.restype = ctypes.c_int
        u.GetAwarenessFromDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        val = u.GetAwarenessFromDpiAwarenessContext(ctypes.c_void_p(ctx))
        return _AWARENESS_ENUM_NAMES.get(int(val), "unknown")
    except Exception:  # noqa: BLE001
        return "unknown"


def system_dpi() -> int | None:
    """系统 DPI（GetDpiForSystem；缺席/非 win32 ⇒ None）。永不抛。"""
    u = _user32()
    if u is None:
        return None
    try:
        u.GetDpiForSystem.restype = ctypes.c_uint
        return int(u.GetDpiForSystem())
    except Exception:  # noqa: BLE001
        return None


def ensure_process_dpi_awareness() -> str:
    """ΠΑΝ-81 立法入口：幂等申请 ``PER_MONITOR_AWARE_V2``（纯 ctypes）。

    - 成功 ⇒ 此后所有坐标端点物理像素同域；后续任何库的
      ``SetProcessDPIAware()`` 翻转尝试都会被 OS 拒绝（只能升不能降）——
      这正是 ΠΑΝ-82 的执法根基；
    - ``E_ACCESSDENIED``（宿主 manifest / 更早调用已钉死感知）⇒ 不重试、
      不谎报：错误落 ``pixel_domain_report``，返回当前实际档位；
    - 非 win32 / API 缺席（< Win10 1703）⇒ 记录后按现状申报；
    - **绝不抛**（感知契约是尽力而为的加载层副词，不允许它瘫痪服务启动）。
    """
    with _lock:
        if _state["attempted"]:
            return current_dpi_awareness()
        _state["attempted"] = True
        u = _user32()
        if u is None:
            _state["error"] = "non-windows: DPI pixel-domain contract not applicable"
            return "non-windows"
        try:
            if hasattr(u, "SetProcessDpiAwarenessContext"):
                u.SetProcessDpiAwarenessContext.restype = ctypes.c_int
                u.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
                ok = u.SetProcessDpiAwarenessContext(
                    ctypes.c_void_p(_CTX_PER_MONITOR_AWARE_V2)
                )
                if ok:
                    _state["achieved"] = True
                else:
                    err = ctypes.GetLastError()
                    _state["error"] = (
                        f"SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2) denied "
                        f"(GetLastError={err}): awareness already pinned by manifest or "
                        f"earlier third-party call; recording actual level honestly"
                    )
            else:
                # 旧平台无 context API：不退而求其次设 system 档（半吊子域统一
                # 比诚实申报更危险）—— 记录后按现状申报。
                _state["error"] = (
                    "SetProcessDpiAwarenessContext unavailable (pre Win10 1703); "
                    "no legacy fallback applied deliberately"
                )
        except Exception as e:  # noqa: BLE001 —— 契约尽力而为，绝不阻断加载
            _state["error"] = f"{type(e).__name__}: {e}"
        return current_dpi_awareness()


def domain_epoch() -> tuple:
    """缓存失效指纹（ΠΑΝ-81）：感知档位或系统 DPI 任一变化 ⇒ epoch 变化。

    ``InputController`` 的屏幕尺寸缓存以此作键 —— 第三方库中途翻转感知、
    或显示器 DPI 档变化时缓存立即失效，绝不用旧域读数换算新域像素。
    """
    return (current_dpi_awareness(), system_dpi())


def pixel_domain_report() -> dict:
    """ΠΑΝ-81 诊断面：各坐标端点当前所处像素域（快照，永不抛）。

    供 /v1/stats 类聚合面与运维排查消费（health 申报留待后续接线）——
    「物理像素契约是否成立」从此可被观测，而非靠读源码自证。
    """
    awareness = current_dpi_awareness()
    domain = _DOMAIN_OF_AWARENESS.get(awareness, "unknown")
    return {
        "platform": sys.platform,
        "contract": "PAN-81: single pixel domain = physical (per-monitor-aware v2)",
        "requested": "per-monitor-v2",
        "requested_by": "dsh_physical.dpi (PAN-81)",
        "achieved": bool(_state["achieved"]),
        "attempted": bool(_state["attempted"]),
        "error": _state["error"],
        "awareness": awareness,
        "system_dpi": system_dpi(),
        "pixel_domain": domain,
        "endpoints": {
            # 随感知档位漂移的端点（契约把档位钉死后与 physical 对齐）
            "pyautogui.size()": domain,
            "EnumDisplayMonitors/GetMonitorInfoW": domain,
            "ui_tree L1/L2 normalization divisor": domain,
            "input pixel conversion": domain,
            "cursor GetCursorPos/CURSORINFO": domain,
            # 恒物理（PIL 内部按物理分辨率抓取，与感知无关）
            "pyautogui.screenshot()/ImageGrab": "physical",
        },
    }
