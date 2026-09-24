"""UIA 点查询（Z-1 第三通道：判别力天花板）。

``ControlFromPoint(x, y)`` 单点问 Windows UI Automation：这个坐标上
「官方登记」的控件是什么。不用悬停、不用等重绘、无时序抖动——
OS 的结构层直接给答案。

域知识（分类集）：
  - 交互集：Button/Hyperlink/MenuItem/ListItem/TreeItem/TabItem/CheckBox/
    RadioButton/ComboBox/Spinner/Slider/Thumb/SplitButton —— 点击是其
    第一可供性
  - 文本集：Text/Edit/Document —— 是「内容」而非「入口」
  - 其余（Pane/Custom/Group/Window/...）→ unknown，交回悬停双通道

祖先链律：按钮标签常是 Button 的子 Text（Chromium 尤甚）——最深元素
是 Text 不代表不可点，沿祖先上行至多 4 层找交互控件；找到即判 control
并记录 matched_depth。

门控：``DSH_PHYSICAL_L1_BACKEND=disabled`` ⇒ 本通道缺席（纯视觉意识形态
不受侵犯）；缺席时 TS 端降回光标+重绘双通道，不伤害。

异常诚实：库缺席/COM 失败/无显示 → ``available=False`` + 真实原因，
永不抛错。
"""
from __future__ import annotations

from typing import Any

# ControlTypeName 带 'Control' 后缀（'ButtonControl'）—— 归一后匹配
_INTERACTIVE: set[str] = {
    "Button", "Hyperlink", "MenuItem", "ListItem", "TreeItem", "TabItem",
    "CheckBox", "RadioButton", "ComboBox", "Spinner", "Slider", "Thumb",
    "SplitButton",
}
_TEXTUAL: set[str] = {"Text", "Edit", "Document"}

_MAX_ANCESTOR_DEPTH = 4


def _norm_type(control: Any) -> str:
    """'ButtonControl' → 'Button'；异常容错为空串。"""
    try:
        t = str(control.ControlTypeName)
    except Exception:  # noqa: BLE001 —— COM 对象半死状态
        return ""
    return t[: -len("Control")] if t.endswith("Control") else t


def _safe_name(control: Any) -> str:
    try:
        return (control.Name or "")[:40]
    except Exception:  # noqa: BLE001
        return ""


def hit_test(px: int, py: int) -> dict:
    """像素坐标点的 UIA 结构查询（同步、纯读取、零副作用）。

    返回 ``{available, control_type, name, chain, classification}``；
    classification ∈ control|text|unknown|unavailable。
    """
    try:
        import uiautomation as ua  # noqa: PLC0415 —— 懒加载：库缺席时服务仍可启动
    except Exception as e:  # noqa: BLE001
        return {
            "available": False,
            "reason": f"uiautomation unavailable: {e}",
            "classification": "unavailable",
        }

    try:
        deepest = ua.ControlFromPoint(px, py)
    except Exception as e:  # noqa: BLE001 —— COM 失败 = 通道缺席，非服务错误
        return {
            "available": False,
            "reason": f"ControlFromPoint failed: {type(e).__name__}: {e}",
            "classification": "unavailable",
        }

    if deepest is None:
        # 坐标处无登记控件（全屏游戏/canvas/部分 Electron）—— 诚实缺席
        return {
            "available": True,
            "control_type": None,
            "classification": "unknown",
        }

    ctype = _norm_type(deepest)
    chain: list[dict] = []

    # 祖先链律：Text in Button ⇒ 可点。上行至多 _MAX_ANCESTOR_DEPTH 层。
    cur = deepest
    for depth in range(1, _MAX_ANCESTOR_DEPTH + 1):
        try:
            cur = cur.GetParentControl()
        except Exception:  # noqa: BLE001
            break
        if cur is None:
            break
        ptype = _norm_type(cur)
        chain.append({"type": ptype, "name": _safe_name(cur), "depth": depth})

    classification = "unknown"
    matched_depth = None
    if ctype in _INTERACTIVE:
        classification, matched_depth = "control", 0
    else:
        ancestor_interactive = next(
            (a for a in chain if a["type"] in _INTERACTIVE), None,
        )
        if ancestor_interactive is not None:
            classification = "control"
            matched_depth = ancestor_interactive["depth"]
        elif ctype in _TEXTUAL:
            classification = "text"

    return {
        "available": True,
        "control_type": ctype,
        "name": _safe_name(deepest),
        "matched_depth": matched_depth,
        "chain": chain,
        "classification": classification,
    }
