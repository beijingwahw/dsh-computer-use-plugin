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
    32650: "busy",          # IDC_APPSTARTING
    32646: "resize",        # IDC_SIZEALL
    32645: "resize",        # IDC_SIZENS
    32644: "resize",        # IDC_SIZEWE
    32642: "resize",        # IDC_SIZENWSE
    32643: "resize",        # IDC_SIZENESW
    32648: "unavailable",   # IDC_NO（拖拽禁区）
    32515: "cross",         # IDC_CROSS
    # 32651 = IDC_HELP：无对应语义词表，落 "custom" 如实上报
}

_CURSOR_SHOWING = 0x00000001


def _raw_mirror_position() -> dict | None:
    """ΝΩ-53：Raw Input 镜像读位（零 Win32 调用 —— 事件驱动替代轮询）。

    镜像缺席（默认关闭）/未启动/陈旧 ⇒ ``None``：调用方回退既有轮询路径，
    不抛、不谎报（运行层铁律）。陈旧门由 rawinput 模块按 config 播种
    （``stale_after_s`` 缺省 2s —— SetCursorPos 类程序性移动不产生 Raw
    Input 事件，陈旧即回退是诚实设计）。
    """
    try:
        from . import rawinput

        shot = rawinput.read_position()
        if shot.get("ok"):
            return {
                "x": int(shot["x"]), "y": int(shot["y"]),
                "age_ms": int(float(shot["age_s"]) * 1000),
            }
    except Exception:  # noqa: BLE001 —— 感知通道失败 = 诚实降级，不炸服务
        pass
    return None


def _mirror_enabled() -> bool:
    """ΝΩ-53：镜像开关回显（config.enabled —— 决定响应是否附加 position）。"""
    try:
        from . import rawinput

        return bool(rawinput.describe().get("enabled"))
    except Exception:  # noqa: BLE001
        return False


def cursor_position() -> dict:
    """鼠标位置读取 —— Raw Input 镜像优先，缺席/陈旧回退 GetCursorPos。

    ΝΩ-53 的读取面：镜像在场时零系统调用（dict 快照）；否则单次
    GetCursorPos（与 pyautogui.position 同一底层调用）。永不抛。
    """
    pos = _raw_mirror_position()
    if pos is not None:
        return {**pos, "source": "raw-input-mirror"}
    if sys.platform != "win32":
        return {"source": "unsupported", "platform": sys.platform}
    try:
        import ctypes
        from ctypes import wintypes

        pt = wintypes.POINT(0, 0)
        if not ctypes.windll.user32.GetCursorPos(ctypes.byref(pt)):  # type: ignore[attr-defined]
            return {"source": "win32", "error": "GetCursorPos returned 0"}
        return {"x": int(pt.x), "y": int(pt.y), "source": "win32"}
    except Exception as e:  # noqa: BLE001 —— 读侧绝不抛
        return {"source": "win32", "error": f"{type(e).__name__}: {e}"}


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

    # ΝΩ-53：CURSORINFO 结构本就携带 ptScreenPos —— 同一次调用的免费位置
    # （临时键，cursor_kind 决定去留：镜像开启 ⇒ 转正为 position；关闭 ⇒ 剥除
    # 保持旧响应形状）
    pos = {"x": int(ci.ptScreenPos.x), "y": int(ci.ptScreenPos.y)}

    if not (ci.flags & _CURSOR_SHOWING):
        return {"kind": "hidden", "pt_screen_pos": pos}

    current = ctypes.c_void_p(ci.hCursor or 0).value or 0
    for resid, name in _STANDARD_CURSORS.items():
        standard = user32.LoadCursorW(None, ctypes.c_void_p(resid)) or 0
        if current and standard and current == standard:
            return {"kind": name, "handle": current, "pt_screen_pos": pos}
    # 应用自定义光标（浏览器/游戏偶见）—— 无法归类，如实上报
    return {"kind": "custom", "handle": current, "pt_screen_pos": pos}


def cursor_kind() -> dict:
    """当前全局光标形态（同步、纯读取、零副作用）。

    返回 ``{kind, handle?}``；kind ∈ arrow/ibeam/hand/wait/busy/resize/
    cross/unavailable/hidden/custom/error/unsupported。

    ΝΩ-53 结构差异注记：镜像开关开启（``DSH_PHYSICAL_RAW_INPUT=1``）时
    响应附加 ``position`` —— (x,y) 优先读 Raw Input 镜像（零额外 Win32
    调用；句柄比对仍需 GetCursorInfo，Raw Input 不给句柄），镜像陈旧/缺席
    则回用**同一次** GetCursorInfo 已取回的 ``ptScreenPos``（零新增调用）。
    默认关闭 ⇒ 响应形状与旧版逐字节一致（零回归铁律）。
    """
    if sys.platform != "win32":
        return {
            "kind": "unsupported",
            "platform": sys.platform,
            "detail": "cursor-shape channel requires Windows; "
                      "the probe falls back to hover-repaint evidence only",
        }
    try:
        result = _read_kind_windows()
    except Exception as e:  # noqa: BLE001 —— 感知通道失败 = 诚实降级，不炸服务
        return {"kind": "error", "detail": f"{type(e).__name__}: {e}"}
    if not isinstance(result, dict):
        return result
    ci_pos = result.pop("pt_screen_pos", None)
    if _mirror_enabled():
        # 镜像在场：(x,y) 优先读镜像（零额外调用）；陈旧/未播种 ⇒ 回用同一次
        # GetCursorInfo 已取回的 ptScreenPos（零新增调用 —— 结构差异注记）
        mirror_pos = _raw_mirror_position()
        if mirror_pos is not None:
            result["position"] = {**mirror_pos, "source": "raw-input-mirror"}
        elif ci_pos is not None:
            result["position"] = {**ci_pos, "source": "getcursorinfo"}
    return result
