"""光标本体感觉（Z-1 世界行动引擎的感知通道）。

操作系统在鼠标悬停时更换光标形态 —— 这不是猜测，是 OS 对「指针下是什么」
的原生判断，比任何视觉分类器都权威：

  - hand（手型）   ⇒ OS 亲口承认的可点击热区（链接/按钮）
  - ibeam（I 型）  ⇒ 可选择的**文本**（正文/聊天消息/文档）—— 不是入口
  - arrow（箭头）  ⇒ 未知（原生 Win32 按钮常保持箭头）—— 需悬停重绘旁证

纯视觉架构里，这是唯一无需 Accessibility 树就能拿到的交互性 ground truth：
截图看见的文字（聊天记录里写着「点击登录」）与真按钮在像素上等价，
但把鼠标悬停上去的一瞬，OS 会给出两种截然不同的回答。

实现：``GetCursorInfo`` 取当前全局光标句柄，与 ``LoadCursorW`` 取回的
系统标准光标句柄比对（系统光标句柄全局共享，二者相等）。
非 Windows 平台诚实降级为 ``unsupported`` —— 引擎会转用悬停重绘单通道。
"""
from __future__ import annotations

import sys

# 系统标准光标资源 id → 语义名（MAKEINTRESOURCE 低 16 位即 id 本身）
_STANDARD_CURSORS: dict[int, str] = {
    32512: "arrow",         # IDC_ARROW
    32513: "ibeam",         # IDC_IBEAM —— 正文文本的判决性信号
    32649: "hand",          # IDC_HAND —— 可点击的判决性信号
    32514: "wait",          # IDC_WAIT
    32651: "busy",          # IDC_APPSTARTING
    32644: "resize",        # IDC_SIZEALL
    32645: "resize",        # IDC_SIZENWSE
    32646: "resize",        # IDC_SIZENESW
    32647: "resize",        # IDC_SIZENS
    32648: "resize",        # IDC_SIZEWE
    32650: "unavailable",   # IDC_NO（拖拽禁区）
    32515: "cross",         # IDC_CROSS
}

_CURSOR_SHOWING = 0x00000001


def _read_kind_windows() -> dict:
    import ctypes
    from ctypes import wintypes

    class CURSORINFO(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("flags", wintypes.DWORD),
            ("hCursor", wintypes.HANDLE),
            ("ptScreenPos", wintypes.POINT),
        ]

    user32 = ctypes.windll.user32  # type: ignore[attr-defined]
    # 句柄是指针宽度 —— 不设 restype 会被截成 32 位 int，64 位上比较必假
    user32.LoadCursorW.restype = ctypes.c_void_p
    user32.LoadCursorW.argtypes = [ctypes.c_void_p, ctypes.c_void_p]

    ci = CURSORINFO()
    ci.cbSize = ctypes.sizeof(CURSORINFO)
    if not user32.GetCursorInfo(ctypes.byref(ci)):
        return {"kind": "error", "detail": "GetCursorInfo returned 0"}

    if not (ci.flags & _CURSOR_SHOWING):
        return {"kind": "hidden"}

    current = ctypes.c_void_p(ci.hCursor or 0).value or 0
    for resid, name in _STANDARD_CURSORS.items():
        standard = user32.LoadCursorW(None, ctypes.c_void_p(resid)) or 0
        if current and standard and current == standard:
            return {"kind": name, "handle": current}
    # 应用自定义光标（浏览器/游戏偶见）—— 无法归类，如实上报
    return {"kind": "custom", "handle": current}


def cursor_kind() -> dict:
    """当前全局光标形态（同步、纯读取、零副作用）。

    返回 ``{kind, handle?}``；kind ∈ arrow/ibeam/hand/wait/busy/resize/
    cross/unavailable/hidden/custom/error/unsupported。
    """
    if sys.platform != "win32":
        return {
            "kind": "unsupported",
            "platform": sys.platform,
            "detail": "cursor-shape channel requires Windows; "
                      "the probe falls back to hover-repaint evidence only",
        }
    try:
        return _read_kind_windows()
    except Exception as e:  # noqa: BLE001 —— 感知通道失败 = 诚实降级，不炸服务
        return {"kind": "error", "detail": f"{type(e).__name__}: {e}"}
