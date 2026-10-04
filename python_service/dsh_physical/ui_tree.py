"""反双盲仲裁漏斗 —— Step 1 §② 世界级创新方案。

传统漏斗（L1 失败 → L2 → L3 兜底）：
  - L3 几乎每次都被调（L1 在复杂页面容易漏元素）
  - VLM 成本爆炸，每次扫描都付费

本仲裁式架构：
  L1-tree  ─┐
              ├─→ 仲裁器 ─→ 最终答案
  L2-ocr   ─┘

规则：
  1. L1 + L2 一致（逐元素 IoU ≥ 0.3 匹配后冲突占比 < 20%）→ 直接采纳，
     **L3 不调用**（多数常规场景免费）
  2. L1 + L2 冲突（位置不匹配或元素集合差异大）→ L3 仲裁（仅冲突场景付费）
  3. L1/L2 完全缺席 → L3 兜底

坐标契约（J 纪元统一 —— 本服务唯一的输出坐标方言）：
  - ``UIElement.rect`` 一律是**全屏归一化坐标 [0,1]**（与 D-6 contracts 对齐）
  - L1 原生像素坐标 → ÷ 屏幕尺寸归一化（需 screen_size）
  - L2 OCR 的 bbox 是**裁剪图内像素** → 映射回全屏像素再归一化
    （旧实现直接输出裁剪内像素，region 裁剪时坐标系整体漂移）
  - L3 VLM 的输出是**图内归一化** → 经 region 复合映射到全屏归一化
    （旧实现直接透传，被 Node 端再次 ÷ 屏幕尺寸 = 双重缩小）

L3 实现分层：
  - ``local-llama``：本地 VLM（llama.cpp + Qwen-VL）
  - ``remote-doubao``：远程 VLM API
  - ``stub``：返回 ``VLM_UNAVAILABLE``（开发模式默认）
  - ``disabled``：完全关闭，仅 L1+L2

输出对齐 D-6 ``UIElement`` 类型：
  { source, role, name, state?, rect: {x,y,width,height}, score? }
  （score?：缝隙闭合「词级真值跨线」—— 仅 L2 OCR 路径携带 [0,1] 真值，
   L1/L3 无分数 ⇒ 键缺席）
"""
from __future__ import annotations

import asyncio
import math
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Literal

from .config import FunnelConfig
from .errors import ErrorKind, PhysicalError
from .executors import TREE_POOL, get as get_pool, run_in  # ΑΩ-R25:重推理走 tree 专属池;ΑΩ-R37:run_in 阻塞遍历入池

# ─── 类型定义（镜像 D-6 UIElement，避免跨进程契约漂移）───


@dataclass
class UIElement:
    """单个 UI 元素（与 D-6 ``contracts.ts`` 严格对齐）。

    ``rect``：全屏归一化 [0,1]（J 纪元统一坐标方言 —— 见模块头注）。
    """

    source: Literal["L1-tree", "L2-ocr", "L3-vlm"] | None
    role: str  # 开集词汇：'input' | 'button' | 'link' | ...
    name: str
    state: str | None = None  # 'enabled' | 'disabled' | 'masked' | 'checked' | 'unchecked'
    rect: dict = field(default_factory=lambda: {"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0})
    # 缝隙闭合：词级真值跨线（PyS）—— L2 RapidOCR 的词级置信度 [0,1] 随元素
    # 序列化跨线（旧世界：score_f 仅用于 <0.5 剔除后即丢，P2a-3 只能在 TS 侧
    # 恒填 90 + confidenceAssumed:true）。L1 结构树 / L3 VLM 路径无分数 ⇒
    # None（序列化缺席 —— 真值缺席的诚实方言，Node 端契约 score?: number 容忍）。
    score: float | None = None

    def to_dict(self) -> dict:
        d = {
            "source": self.source,
            "role": self.role,
            "name": self.name[:20],  # D-3 LABEL_MAX 先例：≤20 字符
            "state": self.state,
            "rect": self.rect,
        }
        # 缝隙闭合：词级真值跨线（PyS）—— 真值在场才出键；None ⇒ 键缺席
        # （下游按「有真值不标假设」的双态语义消费 —— 见 textReader.ts PyS 注）。
        if self.score is not None:
            d["score"] = self.score
        return d


# ─── 坐标归一化辅助（J 纪元统一坐标方言）───


def _normalize_px_rect(rect_px: dict, screen_size: tuple[int, int]) -> dict:
    """像素 rect → 全屏归一化 rect（越界钳制到 [0,1]）。"""
    sw, sh = screen_size
    if sw <= 0 or sh <= 0:
        raise ValueError(f"invalid screen size: {screen_size}")
    x = min(max(rect_px["x"] / sw, 0.0), 1.0)
    y = min(max(rect_px["y"] / sh, 0.0), 1.0)
    w = min(max(rect_px["width"] / sw, 0.0), 1.0 - x)
    h = min(max(rect_px["height"] / sh, 0.0), 1.0 - y)
    return {"x": x, "y": y, "width": w, "height": h}


def _center_in_region(cx: float, cy: float, region: dict | None) -> bool:
    """元素中心是否落在查询 region 内。

    半开区间 [x0, x1) + 右/下界 ≥1 的边缘闭合例外 —— 与 D-6
    ``dispatchElementsToGrid`` / ``visionAdapters.centerInRegion`` 同方言：
    防止中心恰在格线上的元素被所有分区漏掉。
    """
    if not region:
        return True
    x0, y0 = float(region["x"]), float(region["y"])
    x1, y1 = x0 + float(region["width"]), y0 + float(region["height"])
    in_x = (x0 <= cx < x1) or (x1 >= 1.0 and cx <= x1)
    in_y = (y0 <= cy < y1) or (y1 >= 1.0 and cy <= y1)
    return in_x and in_y


def _compose_region_rect(rect_img_norm: dict, region: dict | None) -> dict:
    """图内归一化 rect（L3 VLM 输出）→ 全屏归一化（经 region 复合映射）。"""
    if not region:
        return rect_img_norm
    rx, ry = float(region["x"]), float(region["y"])
    rw, rh = float(region["width"]), float(region["height"])
    return {
        "x": rx + rect_img_norm["x"] * rw,
        "y": ry + rect_img_norm["y"] * rh,
        "width": rect_img_norm["width"] * rw,
        "height": rect_img_norm["height"] * rh,
    }


@dataclass
class FunnelResult:
    """漏斗产出 —— 镜像 D-6 ``ScenePatch`` 单分区语义。"""

    elements: list[UIElement]
    funnel_depth: Literal["L1", "L2", "L3", "empty"]
    fault: dict | None = None  # { source: 'L1'|'L2'|'L3', detail: str }
    captured_at: int = 0
    # 内部观测：L3 是否被调用（仲裁机制的效益证据）
    l3_invoked: bool = False

    def to_dict(self) -> dict:
        return {
            "elements": [e.to_dict() for e in self.elements],
            "funnel_depth": self.funnel_depth,
            "fault": self.fault,
            "captured_at": self.captured_at,
            "l3_invoked": self.l3_invoked,
        }


# ─── L1: 无障碍树 ───

# ─── ΑΩ-R37: UIA 深度遍历 —— 护栏参数 + 纯函数核心 ───
# 旧骨架只枚举顶层控件，真机 UI 树深度不足 ⇒ 仲裁漏斗大量落到 L2/L3。
# 升级为带护栏的深度优先遍历；护栏三件套防失控树（UIA 桌面树在深窗口
# 嵌套/虚拟化列表下可达数万节点，无界遍历会拖死 tree 池）。
# ΝΩ-50: 三件套提取为平台无关单源常量 —— Windows UIA 与 Linux AT-SPI
# 深度遍历同律同常量（数值与 ΑΩ-R37 落地值逐项一致，Windows 行为零回归；
# 旧 Linux 顶层枚举无任何护栏）。
_TREE_MAX_DEPTH = 12     # 深度上限：根为第 0 层，最多展开到第 12 层（含）
_TREE_MAX_CHILDREN = 64  # 每层子数上限：超出截断（列表/表格类容器常见数百子）
_TREE_MAX_ELEMENTS = 800  # 总元素预算：产出元素数达阈值即停（输出规模的硬上界）
# ΑΩ-R37 旧名保留为单源别名（引用同一常量对象，绝非数值复制 —— 既有
# Windows 侧引用点与诊断习惯不破坏；单源性由单测 assertIs 钉死）。
_UIA_MAX_DEPTH = _TREE_MAX_DEPTH
_UIA_MAX_CHILDREN = _TREE_MAX_CHILDREN
_UIA_MAX_ELEMENTS = _TREE_MAX_ELEMENTS

# ΑΩ-R37: ControlType id → role 词表。沿用文件既有映射方言：role 是开集
# 词汇（UIElement 注：'input' | 'button' | 'link' | …），取控件类型名小写
# ——'button'/'text'/'menu' 等正落在文档词表内，其余（'edit'/'checkbox'/…）
# 同为开集合法成员（与 TS 端 interactiveRoles 'checkbox'/'combobox' 同形）；
# 缺失类型归 'unknown'（旧 `ControlTypeName or "unknown"` 同语义）。id 与
# UIAutomationClient.h 的 UIA_*ControlTypeId 一一对齐（本机 comtypes
# typelib 生成物逐项核验）。
_UIA_CONTROL_TYPE_ROLES: dict[int, str] = {
    50000: "button",
    50001: "calendar",
    50002: "checkbox",
    50003: "combobox",
    50004: "edit",
    50005: "hyperlink",
    50006: "image",
    50007: "listitem",
    50008: "list",
    50009: "menu",
    50010: "menubar",
    50011: "menuitem",
    50012: "progressbar",
    50013: "radiobutton",
    50014: "scrollbar",
    50015: "slider",
    50016: "spinner",
    50017: "statusbar",
    50018: "tab",
    50019: "tabitem",
    50020: "text",
    50021: "toolbar",
    50022: "tooltip",
    50023: "tree",
    50024: "treeitem",
    50025: "custom",
    50026: "group",
    50027: "thumb",
    50028: "datagrid",
    50029: "dataitem",
    50030: "document",
    50031: "splitbutton",
    50032: "window",
    50033: "pane",
    50034: "header",
    50035: "headeritem",
    50036: "table",
    50037: "titlebar",
    50038: "separator",
    50039: "semanticzoom",
    50040: "appbar",
}


def _uia_role(control_type_id: int | None) -> str:
    """UIA ControlType id → role（控件类型名小写）；未知/缺席 → 'unknown'。"""
    if control_type_id is None:
        return "unknown"
    return _UIA_CONTROL_TYPE_ROLES.get(control_type_id, "unknown")


def _uia_role_from_name(type_name: str | None) -> str:
    """ΑΩ-R37: 遗留 uiautomation 库的 ControlTypeName（'ButtonControl'）→ 'button'。

    剥包装类的 'Control' 后缀后小写 —— 与 comtypes 路径的 id 映射同词表。
    """
    if not type_name:
        return "unknown"
    base = type_name[:-7] if type_name.endswith("Control") else type_name
    return base.lower() or "unknown"


def _rect_is_degenerate(rect: dict | None, screen_px: tuple[int, int] | None) -> bool:
    """ΑΩ-R37 矩形退化剪枝判定：零/负面积，或与屏幕框交集为空（全然屏外）。

    部分越界不算退化（最大化窗口的 -7px 阴影边、跨屏半出界）—— 下游
    ``_normalize_px_rect`` 会钳制（既有方言）；只有完全在屏幕外才剪。
    ``screen_px`` 缺席时仅做面积判定（调用方给不出屏幕尺寸时的保守路径）。
    """
    if not isinstance(rect, dict):
        return True
    try:
        x, y = float(rect["x"]), float(rect["y"])
        w, h = float(rect["width"]), float(rect["height"])
    except (KeyError, TypeError, ValueError):
        return True  # 畸形 rect：按退化剪除（extract 归一化路径本也会跳过）
    if w <= 0 or h <= 0:
        return True
    if screen_px is not None:
        sw, sh = screen_px
        if x >= sw or y >= sh or x + w <= 0 or y + h <= 0:
            return True
    return False


def _walk_ui_tree(
    root,
    children_of,
    describe,
    screen_px: tuple[int, int] | None = None,
    max_depth: int = _TREE_MAX_DEPTH,
    max_children: int = _TREE_MAX_CHILDREN,
    max_elements: int = _TREE_MAX_ELEMENTS,
) -> tuple[list[dict], dict]:
    """ΑΩ-R37: 带护栏的深度优先遍历（纯函数，不触 COM/D-Bus —— 依赖注入）。

    ``children_of(node)`` → 子节点可迭代对象（可抛异常 → 按无子处理）；
    ``describe(node)`` → 原始字段 dict（px rect + 可选 ``offscreen``），
    读取失败返回 None。两者由平台适配器注入（comtypes / uiautomation 库 /
    ΝΩ-50 pyatspi），单测注入假树 —— 剪枝/预算逻辑由此可离线全覆盖。
    护栏默认值取平台无关单源常量 ``_TREE_MAX_*``（ΝΩ-50：Linux 与
    Windows 同律同常量）。

    剪枝规则：
      - ``offscreen`` 为 True（UIA IsOffscreen 判不可见）→ 元素与整个子树
        跳过（屏外容器不再消耗预算 —— 诚实依据 UIA 的可见性真值）
      - 矩形退化（零面积/全然屏外）→ 元素跳过、子树仍下钻（父 rect 是
        占位符畸形而子有真实 rect 的场景保留召回）
      - 深度超 ``max_depth`` / 每层子数超 ``max_children`` → 截断
      - 产出元素数达 ``max_elements`` → 整体停止

    返回 ``(elements, stats)``：stats 为观测字典（visited / max_depth_seen /
    各类剪枝计数 / budget_hit —— 真机 smoke 诊断用）。
    """
    elements: list[dict] = []
    stats: dict = {
        "visited": 0,
        "max_depth_seen": 0,
        "depth_pruned": 0,
        "width_pruned": 0,
        "degenerate_rect": 0,
        "offscreen_skipped": 0,
        "budget_hit": False,
    }
    stack: list[tuple[object, int]] = [(root, 0)]  # (node, depth)；根 = 第 0 层
    while stack and len(elements) < max_elements:
        node, depth = stack.pop()
        stats["visited"] += 1
        if depth > stats["max_depth_seen"]:
            stats["max_depth_seen"] = depth
        raw = describe(node)  # 注入方保证不抛（None = 字段读取失败）
        if raw is None:
            pass  # 该元素放弃，但子树照走（见 docstring 剪枝规则）
        elif raw.get("offscreen") is True:
            stats["offscreen_skipped"] += 1
            continue  # 不可见 ⇒ 连子树一起跳过（IsOffscreen 是 UIA 的可见性真值）
        elif _rect_is_degenerate(raw.get("rect"), screen_px):
            stats["degenerate_rect"] += 1
        else:
            elements.append(raw)
        if depth + 1 > max_depth:
            stats["depth_pruned"] += 1  # 已到深度界：此节点的子层整层不展开
            continue
        try:
            kids = list(children_of(node))
        except Exception:  # noqa: BLE001 —— 子枚举失败（元素已消亡）≠ 整树失败
            continue
        if len(kids) > max_children:
            stats["width_pruned"] += len(kids) - max_children
            kids = kids[:max_children]
        stack.extend((kid, depth + 1) for kid in reversed(kids))  # 逆序压栈 = 先序 DFS
    if len(elements) >= max_elements:
        stats["budget_hit"] = True
    return elements, stats


def _ui_element_from_raw(raw: dict) -> UIElement:
    """ΑΩ-R37: 遍历原始 dict → UIElement（L1 既有输出方言原样保持）。

    source='L1-tree'、state 常在（'enabled'/'disabled'）、score 恒缺席
    （真值缺席的诚实方言 —— to_dict 序列化不变）、rect 为像素坐标
    （上游 extract 归一化，与旧顶层枚举同路径）。
    """
    return UIElement(
        source="L1-tree",
        role=str(raw.get("role") or "unknown"),
        name=str(raw.get("name") or ""),
        state=raw.get("state"),
        rect=raw.get("rect") or {"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0},
    )


def _uia_comtypes_snapshot(screen_px: tuple[int, int] | None) -> tuple[list[dict], dict]:
    """ΑΩ-R37: comtypes（服务声明依赖，pyproject win32 标记）直连 UIA。

    阻塞式 COM 调用 —— 由调用方丢进 tree 池，不占事件循环。首次
    ``GetModule`` 从 UIAutomationCore.dll 类型库生成包装（缓存于
    comtypes.gen）；COM STA 在池线程按需初始化（池线程长存，初始化一次
    常驻 —— 刻意不配对 CoUninitialize，避免复用线程引用计数失衡）。
    """
    import comtypes
    import comtypes.client

    try:
        comtypes.CoInitializeEx()  # 已初始化 → S_FALSE，容忍
    except Exception:  # noqa: BLE001 —— 初始化失败不预判死刑，COM 调用自证可用性
        pass
    comtypes.client.GetModule("UIAutomationCore.dll")
    from comtypes.gen.UIAutomationClient import CUIAutomation, IUIAutomation, TreeScope_Children

    uia = comtypes.client.CreateObject(CUIAutomation, interface=IUIAutomation)
    root = uia.GetRootElement()
    # ΑΩ-R37 真机战果：ControlViewWalker 的 GetNextSiblingElement 兄弟链在本机
    # 随机 E_POINTER/NULL COM pointer（首步即炸，与首次探测结果不稳定相关）；
    # 改用 FindAll(TreeScope_Children) —— 单次 COM 调用返回子数组，指针生命
    # 周期由数组对象整体持有，且实测更快（一次往返取整层而非逐兄弟两次）。
    true_cond = uia.CreateTrueCondition()

    def children_of(el):
        arr = el.FindAll(TreeScope_Children, true_cond)
        for i in range(arr.Length if arr else 0):
            yield arr.GetElement(i)

    def describe(el) -> dict | None:
        try:
            rect = el.CurrentBoundingRectangle
            raw = {
                "name": el.CurrentName or "",
                "role": _uia_role(el.CurrentControlType),
                "state": "enabled" if el.CurrentIsEnabled else "disabled",
                "rect": {
                    "x": rect.left,
                    "y": rect.top,
                    "width": rect.right - rect.left,
                    "height": rect.bottom - rect.top,
                },
            }
            try:
                raw["offscreen"] = bool(el.CurrentIsOffscreen)
            except Exception:  # noqa: BLE001 —— IsOffscreen 读不到 → 不剪，保守保留
                pass
            return raw
        except Exception:  # noqa: BLE001 —— 单元素字段读取失败 ≠ 整树失败
            return None

    return _walk_ui_tree(root, children_of, describe, screen_px)


def _uia_uiautomation_snapshot(screen_px: tuple[int, int] | None) -> tuple[list[dict], dict]:
    """ΑΩ-R37: 遗留第三方 uiautomation 包装库兜底（未声明依赖 —— 装了就用）。

    与 comtypes 快照共用同一 ``_walk_ui_tree`` 核心，仅属性取值方言不同。
    """
    import uiautomation as ua  # type: ignore[import-not-found]

    root = ua.GetRootControl()

    def children_of(ctrl):
        return ctrl.GetChildren()

    def describe(ctrl) -> dict | None:
        try:
            rect_obj = ctrl.BoundingRectangle
            if not rect_obj:
                return None
            raw = {
                "name": ctrl.Name or "",
                "role": _uia_role_from_name(ctrl.ControlTypeName),
                "state": "enabled" if ctrl.IsEnabled else "disabled",
                "rect": {
                    "x": rect_obj.left,
                    "y": rect_obj.top,
                    "width": rect_obj.width,
                    "height": rect_obj.height,
                },
            }
            try:
                raw["offscreen"] = bool(ctrl.IsOffscreen)
            except Exception:  # noqa: BLE001 —— IsOffscreen 读不到 → 不剪，保守保留
                pass
            return raw
        except Exception:  # noqa: BLE001 —— 单元素字段读取失败 ≠ 整树失败
            return None

    return _walk_ui_tree(root, children_of, describe, screen_px)


# ─── ΝΩ-50: Linux AT-SPI 深度遍历适配器（对齐 R37 Windows UIA DFS）───

# AT-SPI role name（ATK/atspi 稳定字符串方言，如 'push button'/'check box'）
# → role 词表映射。值与 _UIA_CONTROL_TYPE_ROLES 同词表（Windows/Linux 同律的
# role 方言 —— 'button'/'checkbox'/'edit' 等）；未映射项走 ``_atspi_role_from_name``
# 的小写原名兜底（开集词汇合法成员，旧顶层枚举 ``role.lower()`` 方言保留）。
_ATSPI_ROLE_NAME_ROLES: dict[str, str] = {
    "push button": "button",
    "toggle button": "button",
    "check box": "checkbox",
    "combo box": "combobox",
    "entry": "edit",
    "password text": "edit",
    "text": "text",
    "label": "text",
    "radio button": "radiobutton",
    "list": "list",
    "list item": "listitem",
    "menu": "menu",
    "popup menu": "menu",
    "menu bar": "menubar",
    "menu item": "menuitem",
    "check menu item": "menuitem",
    "radio menu item": "menuitem",
    "tear off menu item": "menuitem",
    "progress bar": "progressbar",
    "scroll bar": "scrollbar",
    "slider": "slider",
    "spin button": "spinner",
    "status bar": "statusbar",
    "page tab": "tabitem",
    "page tab list": "tab",
    "tool bar": "toolbar",
    "tool tip": "tooltip",
    "tree": "tree",
    "tree table": "tree",
    "table": "table",
    "icon": "image",
    "image": "image",
    "link": "hyperlink",
    "frame": "window",
    "dialog": "window",
    "calendar": "calendar",
    "panel": "pane",
    "filler": "group",
    "grouping": "group",
    "separator": "separator",
    "document web": "document",
    "document frame": "document",
}


def _atspi_role_from_name(role_name: str | None) -> str:
    """ΝΩ-50: AT-SPI role name → role（与 UIA 词表同律）；未映射 → 小写原名。"""
    if not role_name:
        return "unknown"
    return _ATSPI_ROLE_NAME_ROLES.get(role_name, role_name.strip().lower() or "unknown")


def _atspi_snapshot(screen_px: tuple[int, int] | None) -> tuple[list[dict], dict]:
    """ΝΩ-50: Linux AT-SPI（pyatspi —— 旧顶层枚举 :554-590 的既有依赖面）接 R37 DFS 核心。

    children/describe 适配 AT-SPI Accessible 方言后注入 ``_walk_ui_tree`` ——
    护栏（深度 12/每层 64/总 800/矩形剪枝/SHOWING 不可见跳过）与 Windows
    UIA 同律同常量（``_TREE_MAX_*`` 单源）。AT-SPI 是 D-Bus 阻塞调用 —— 由
    调用方丢进 tree 池（ΑΩ-R25 纪律）。

    字段方言：
      - extents：优先 Component 接口 ``queryComponent().getExtents(DESKTOP_COORDS)``
        （DESKTOP_COORDS = 屏幕像素系，与矩形剪枝同坐标系），接口缺席时回落
        旧顶层枚举的 ``getExtents()`` 直连方言；两者都失败 → describe None
      - 可见性：STATE_SHOWING 是 UIA IsOffscreen 的逆命题（不在屏上渲染）→
        ``offscreen = not SHOWING``；states 读不到 → 不设键（保守保留，与
        UIA 侧 IsOffscreen 读不到同策）
      - 状态：STATE_ENABLED → 'enabled'/'disabled'（读不到 → 键缺席，旧方言）

    真机 Linux 集成路径未验证（Windows 开发机无 AT-SPI 总线/pyatspi）——
    装配/剪枝逻辑由离线单测以假 pyatspi 模块全覆盖
    （tests/test_ui_tree.py AtspiAdapterTests）；真机冒烟待 Linux 硬件在场补。
    """
    import pyatspi  # type: ignore[import-not-found]

    desktop_coords = getattr(pyatspi, "DESKTOP_COORDS", 0)
    state_enabled = getattr(pyatspi, "STATE_ENABLED", None)
    state_showing = getattr(pyatspi, "STATE_SHOWING", None)
    root = pyatspi.Registry.getDesktop(0)

    def children_of(node):
        # AT-SPI 子枚举方言：childCount + getChildAtIndex（可抛 → 核心按无子处理）
        for i in range(node.childCount):
            child = node.getChildAtIndex(i)
            if child is not None:
                yield child

    def describe(node) -> dict | None:
        try:
            try:
                ext = node.queryComponent().getExtents(desktop_coords)
            except Exception:  # noqa: BLE001 —— Component 接口缺席 → 旧 getExtents 直连方言
                ext = node.getExtents()
            raw = {
                "name": node.name or "",
                "role": _atspi_role_from_name(node.getRoleName()),
                "rect": {"x": ext.x, "y": ext.y, "width": ext.width, "height": ext.height},
            }
            try:
                states = node.getStates()
                if state_enabled is not None:
                    raw["state"] = "enabled" if states.contains(state_enabled) else "disabled"
                if state_showing is not None:
                    raw["offscreen"] = not states.contains(state_showing)
            except Exception:  # noqa: BLE001 —— states 读不到 → 不设 state/offscreen（保守保留）
                pass
            return raw
        except Exception:  # noqa: BLE001 —— 单元素字段读取失败 ≠ 整树失败
            return None

    return _walk_ui_tree(root, children_of, describe, screen_px)


class L1TreeBackend:
    """L1 无障碍树读取 —— 平台分治。

    ``backend`` 选择：
      - ``auto``：按 sys.platform 自动选 darwin/win32/linux
      - ``quartz`` / ``uiautomation`` / ``xlib``：显式指定
        （``xlib`` 为历史名 —— ΝΩ-50 实装为 AT-SPI/pyatspi 深度遍历）
      - ``disabled``：完全关闭
    """

    def __init__(self, backend: str) -> None:
        self.backend = backend
        self._impl = self._resolve_backend(backend)

    def _resolve_backend(self, backend: str) -> str:
        if backend == "disabled":
            return "disabled"
        if backend == "auto":
            return {
                "darwin": "quartz",
                "win32": "uiautomation",
                "linux": "xlib",
            }.get(sys.platform, "disabled")
        return backend

    async def extract(
        self,
        region: dict | None,
        screen_size: tuple[int, int] | None = None,
    ) -> tuple[list[UIElement], str | None]:
        """提取 UI 元素（像素坐标 → 全屏归一化 + region 中心过滤）。

        返回 ``(elements, fault_detail)``：``fault_detail`` 非 None 表示该层失败。
        永不抛错 —— 一切异常转 ``fault_detail``。
        """
        if self._impl == "disabled":
            return [], "L1 backend disabled"

        if screen_size is None:
            # 像素坐标无法归一化（screen_size 缺席）—— 诚实 fault 而非
            # 输出像素坐标毒化下游（Node 端契约是归一化）
            return [], "L1 screen size unavailable (cannot normalize pixel rects)"

        try:
            raw: list[UIElement] = []
            fault: str | None = None
            if self._impl == "quartz":
                raw, fault = await self._extract_quartz(region)
            elif self._impl == "uiautomation":
                # ΑΩ-R37:screen_size 传给遍历器做屏外剪枝（归一化仍在下方统一做）
                raw, fault = await self._extract_uiautomation(region, screen_size)
            elif self._impl == "xlib":
                # ΝΩ-50:screen_size 传给遍历器做屏外剪枝（与 UIA 分支同律；
                # 归一化仍在下方统一做）
                raw, fault = await self._extract_xlib(region, screen_size)
            else:
                return [], f"unknown L1 backend: {self._impl}"
            if fault or not raw:
                return [], fault

            # 像素 → 全屏归一化；region 过滤按归一化中心（J 纪元：region 参数
            # 旧实现三层后端全部忽略 —— 全屏提取不过滤，分区扫描时每元素
            # 重复出现在每个 region 的返回里）
            elements: list[UIElement] = []
            for e in raw:
                try:
                    e.rect = _normalize_px_rect(e.rect, screen_size)
                except (KeyError, TypeError, ValueError):
                    continue  # 畸形 rect：跳过该元素而非整层失败
                cx = e.rect["x"] + e.rect["width"] / 2
                cy = e.rect["y"] + e.rect["height"] / 2
                if _center_in_region(cx, cy, region):
                    elements.append(e)
            return elements, None
        except Exception as e:  # noqa: BLE001
            return [], f"{type(e).__name__}: {e}"

    async def _extract_quartz(self, region: dict | None) -> tuple[list[UIElement], str | None]:
        """macOS Quartz Accessibility API —— ΑΩ-R37 诚实降级注记（不谎报）。"""
        try:
            from ApplicationServices import (
                AXUIElementCreateApplication, AXUIElementCopyAttributeValue,
                kAXChildrenAttribute, kAXRoleAttribute, kAXTitleAttribute,
                kAXPositionAttribute, kAXSizeAttribute, kAXEnabledAttribute,
            )
        except ImportError as e:
            return [], f"quartz import failed: {e}. install pyobjc-framework-ApplicationServices"

        # ΑΩ-R37: AX 树深度遍历尚未实现 —— 诚实降级（空列表 + reason 的既有
        # 信封方言），绝不伪造元素让 L1 假装在场（仲裁漏斗会正确落到 L2/L3
        # 兜底，比谎报的空壳骨架更安全）。完整实现需要 frontmost app 的
        # PID + AXUIElementCreateApplication + 本模块同款护栏 DFS。
        return [], "quartz-l1-not-implemented: AX tree traversal not yet implemented (honest degradation, no fabricated elements)"

    async def _extract_uiautomation(
        self, region: dict | None, screen_size: tuple[int, int] | None = None,
    ) -> tuple[list[UIElement], str | None]:
        """Windows UI Automation —— ΑΩ-R37 从顶层枚举升级为深度优先遍历。

        comtypes（声明依赖）优先，遗留 uiautomation 库兜底；遍历体是纯函数
        ``_walk_ui_tree``（剪枝/预算逻辑单测离线覆盖）。COM 是阻塞调用 ——
        经 ``run_in`` 跑 tree 池（ΑΩ-R25 纪律：重结构查询不占事件循环）。
        输出方言与旧顶层枚举完全一致（source/role/name≤20/state/rect 像素，
        上游归一化路径未动）。
        """
        def _snapshot() -> tuple[list[dict], dict]:
            try:
                return _uia_comtypes_snapshot(screen_size)
            except ImportError:
                return _uia_uiautomation_snapshot(screen_size)

        try:
            raw_list, _stats = await run_in(TREE_POOL, _snapshot)
        except ImportError as e:
            return [], (
                f"comtypes/uiautomation import failed: {e}. "
                "comtypes is the declared win32 dependency (see pyproject)"
            )
        except Exception as e:  # noqa: BLE001 —— 运行层绝不抛（信封铁律）
            return [], f"uiautomation traversal failed: {e}"
        return [_ui_element_from_raw(raw) for raw in raw_list], None

    async def _extract_xlib(
        self, region: dict | None, screen_size: tuple[int, int] | None = None,
    ) -> tuple[list[UIElement], str | None]:
        """Linux AT-SPI tree —— ΝΩ-50 从顶层枚举升级为深度优先遍历。

        ``xlib`` 是历史后端名（配置方言零回归）；实际依赖面是 AT-SPI 无障碍
        总线（pyatspi，Debian 系 ``apt install python3-pyatspi``）—— python-xlib
        只有 X 协议、无无障碍树可走，不硬上。遍历体复用 Windows 同款纯函数
        ``_walk_ui_tree``（护栏同律同常量 ``_TREE_MAX_*`` 单源）；AT-SPI 是
        D-Bus 阻塞调用 —— 经 ``run_in`` 跑 tree 池（ΑΩ-R25 纪律）。pyatspi
        缺席 → 诚实降级 import fault 信封（旧方言原样：无元素 + reason 注记，
        绝不伪造顶层骨架）。
        """
        def _snapshot() -> tuple[list[dict], dict]:
            return _atspi_snapshot(screen_size)

        try:
            raw_list, _stats = await run_in(TREE_POOL, _snapshot)
        except ImportError as e:
            return [], f"pyatspi import failed: {e}. apt install python3-pyatspi"
        except Exception as e:  # noqa: BLE001 —— 运行层绝不抛（信封铁律）
            return [], f"pyatspi traversal failed: {e}"
        return [_ui_element_from_raw(raw) for raw in raw_list], None


# ─── L2: OCR ───


class L2OCRBackend:
    """L2 OCR —— RapidOCR (ONNX Runtime) 跨平台。"""

    def __init__(self, backend: str, languages: list[str]) -> None:
        self.backend = backend
        self.languages = languages
        self._engine = None

    def _ensure_engine(self) -> None:
        if self._engine is not None or self.backend == "disabled":
            return
        try:
            from rapidocr_onnxruntime import RapidOCR  # type: ignore[import-not-found]

            self._engine = RapidOCR()
        except ImportError as e:
            raise PhysicalError(
                ErrorKind.OCR_UNAVAILABLE,
                f"rapidocr import failed: {e}. pip install rapidocr-onnxruntime",
            ) from e

    async def extract(
        self,
        image_bytes: bytes | None,
        region: dict | None = None,
        screen_size: tuple[int, int] | None = None,
    ) -> tuple[list[UIElement], str | None]:
        """对图像做 OCR，返回元素列表（bbox 映射回全屏归一化坐标）。

        ``image_bytes``：PNG/JPEG 字节（region 裁剪后的图）；``None`` 表示无图。
        返回 ``(elements, fault_detail)``。
        """
        if self.backend == "disabled":
            return [], "L2 backend disabled"
        if image_bytes is None:
            return [], "no image bytes for OCR"

        try:
            # ΝΩ-35（体检 T4）：RapidOCR() 构造（ONNX 会话建立 + 模型加载，
            # 首调秒级）原在事件循环 —— 首次 L2 请求把整个服务的全部路由
            # 卡住数秒 ⇒ tree 池（推理同池；PhysicalError 经 await 原样上抛，
            # OCR_UNAVAILABLE 信封不变）。
            await run_in(TREE_POOL, self._ensure_engine)
        except PhysicalError as e:
            return [], e.detail

        try:
            import numpy as np
            from PIL import Image
            import io

            img = Image.open(io.BytesIO(image_bytes))
            img_w, img_h = img.size

            # Y6 真机战果：区域裁剪后的小图（如 read_text half=0.1 → ~250px 高）
            # 里的小号 UI 文字对 OCR 引擎太小 —— 英文被拼错、无关中文词混入
            # （"Sbeaany"/"beadify"）。短边 < 640px 时 LANCZOS 放大 2 倍再识别，
            # bbox 坐标按放大倍数除回，坐标方言不变。
            scale = 2 if min(img_w, img_h) < 640 else 1
            if scale > 1:
                img = img.resize((img_w * scale, img_h * scale), Image.LANCZOS)

            arr = np.array(img)

            # ΑΩ-R25:RapidOCR 推理(重 CPU,数百 ms)⇒ tree 专属池 —— 不再
            # 与输入注入/截屏编码共享缺省池(OCR 慢帧不得拖住物理动作)
            loop = asyncio.get_running_loop()
            result, _ = await loop.run_in_executor(get_pool(TREE_POOL), self._engine, arr)
            if result is None:
                return [], None  # OCR 成功但无文本

            # J 纪元坐标统一：OCR bbox 是（可能的）裁剪图内像素 —— 先映射回
            # 全屏像素（box 原点 = region 像素偏移），再归一化。
            # region 缺席时裁剪图 == 全屏，图自身尺寸即屏幕尺寸。
            if region:
                if screen_size is None:
                    return [], "L2 screen size unavailable (cannot map cropped bbox to full screen)"
                sw, sh = screen_size
                off_x, off_y = float(region["x"]) * sw, float(region["y"]) * sh
            else:
                sw, sh = img_w, img_h
                off_x = off_y = 0.0

            elements: list[UIElement] = []
            for box, text, score in result:
                # rapidocr 1.2.x 的 score 是字符串（'0.8307…'）—— 与浮点比较
                # 前必须归一（真机战果：str < float 直接 TypeError，L2 全灭）
                try:
                    score_f = float(score)
                except (TypeError, ValueError):
                    continue
                if not text or score_f < 0.5:
                    continue
                # 缝隙闭合：词级真值跨线（PyS）—— 剔除律（<0.5 丢弃）在上行照旧
                # 先行未动；幸存真值夹 [0,1] 后随元素序列化（旧世界：算出即丢）。
                # NaN 判定（score_f != score_f）⇒ None —— 非有限值不是真值，
                # 缺席交给 TS 侧回退 90+assumed 旧方言（双态语义的另一臂）。
                score_out: float | None = (
                    min(max(score_f, 0.0), 1.0) if score_f == score_f else None
                )
                # box = [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]（四点多边形；放大后坐标除回）
                xs = [p[0] / scale for p in box]
                ys = [p[1] / scale for p in box]
                x, y = min(xs), min(ys)
                w, h = max(xs) - x, max(ys) - y
                if sw <= 0 or sh <= 0:
                    continue
                try:
                    rect = _normalize_px_rect(
                        {"x": off_x + x, "y": off_y + y, "width": w, "height": h},
                        (int(sw), int(sh)),
                    )
                except (KeyError, TypeError, ValueError):
                    continue
                elements.append(UIElement(
                    source="L2-ocr",
                    role="text",
                    name=text[:20],
                    rect=rect,
                    score=score_out,  # 缝隙闭合：词级真值跨线（PyS）
                ))
            return elements, None
        except Exception as e:  # noqa: BLE001
            return [], f"{type(e).__name__}: {e}"


# ─── L3: VLM 仲裁器 ───


def _parse_vlm_elements(text: str) -> tuple[list[UIElement], str | None]:
    r"""VLM 结构化输出解析（视觉皮层的言语区）。

    容错域（VLM 是有噪声的传感器，不是配置输入 —— 解析宽容但校验严格）：
      - 剥离 markdown 围栏（```json ... ```）与前后散文
      - 接受 JSON 数组或单对象；逐元素域校验（name 非空字符串、x/y/w/h ∈ [0,1]）
      - 无效元素跳过（保留有效者），全无效 ⇒ 诚实 fault（绝不把散文伪装成元素）
    """
    import json
    import re

    if not text or not text.strip():
        return [], "VLM returned empty text"

    stripped = text.strip()
    # 剥围栏：```json ... ``` 或 ``` ... ```
    fence = re.search(r"```(?:json)?\s*(.*?)\s*```", stripped, re.DOTALL)
    if fence:
        stripped = fence.group(1)
    # 剥散文：截取首个 '[' 到最后一个 ']'（数组体），或 '{' 到 '}'（单对象）
    arr_match = re.search(r"\[.*\]", stripped, re.DOTALL)
    obj_match = re.search(r"\{.*\}", stripped, re.DOTALL)
    if arr_match:
        stripped = arr_match.group(0)
    elif obj_match:
        stripped = "[" + obj_match.group(0) + "]"

    try:
        items = json.loads(stripped)
    except json.JSONDecodeError as e:
        return [], f"VLM output not parseable as JSON: {e}"

    if not isinstance(items, list):
        return [], "VLM output is not a JSON array"

    elements: list[UIElement] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        coords = []
        valid = True
        for key in ("x", "y", "w", "h"):
            v = item.get(key)
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0.0 <= float(v) <= 1.0:
                valid = False
                break
            coords.append(float(v))
        if not valid:
            continue
        x, y, w, h = coords
        elements.append(UIElement(
            source="L3-vlm",
            role=str(item.get("role", "vlm-element")),
            name=name.strip()[:20],  # 与 L1/L2 同预算（D-3 LABEL_MAX 先例）
            rect={"x": x, "y": y, "width": w, "height": h},
        ))

    if not elements:
        return [], f"VLM output had no valid elements ({len(items)} items parsed)"
    return elements, None


class L3VLMBackend:
    """L3 VLM 仲裁器 —— 本地优先 + 远程兜底 + stub。

    ``backend`` 选择：
      - ``local-llama``：``llama-cpp-python`` 加载本地 GGUF 模型
      - ``remote-doubao``：HTTP API 调远程 VLM
      - ``stub``：永远返回 ``VLM_UNAVAILABLE``（开发模式默认）
      - ``disabled``：完全关闭
    """

    def __init__(self, config: FunnelConfig) -> None:
        self.config = config
        self._local_model = None

    async def arbitrate(
        self,
        image_bytes: bytes | None,
        l1_elements: list[UIElement],
        l2_elements: list[UIElement],
        question: str = "list all interactive UI elements with their positions",
        region: dict | None = None,
    ) -> tuple[list[UIElement], str | None]:
        """L3 仲裁入口。

        ``region``：J 纪元新增 —— VLM 输出的图内归一化坐标经 region 复合
        映射到全屏归一化（与 L1/L2 同一方言），消灭跨层坐标漂移。
        返回 ``(elements, fault_detail)``；``fault_detail`` 非 None 表示 L3 失败。
        """
        backend = self.config.l3_backend

        if backend == "disabled":
            return [], "L3 backend disabled"
        if backend == "stub":
            return [], "L3 stub (no VLM available)"

        if image_bytes is None:
            return [], "no image bytes for VLM"

        try:
            if backend == "local-llama":
                return await self._local_llama(image_bytes, question, region)
            elif backend == "remote-doubao":
                return await self._remote_doubao(image_bytes, question, region)
            else:
                return [], f"unknown L3 backend: {backend}"
        except Exception as e:  # noqa: BLE001
            return [], f"{type(e).__name__}: {e}"

    async def _local_llama(self, image_bytes: bytes, question: str, region: dict | None) -> tuple[list[UIElement], str | None]:
        """本地 llama.cpp + Qwen-VL。"""
        try:
            from llama_cpp import Llama  # type: ignore[import-not-found]
            from llama_cpp.llama_chat_format import Llava15ChatHandler  # type: ignore[import-not-found]
        except ImportError as e:
            return [], f"llama-cpp-python not installed: {e}"

        if not self.config.l3_model_path:
            return [], "DSH_PHYSICAL_L3_MODEL_PATH not set"

        try:
            if self._local_model is None:
                handler = Llava15ChatHandler(clip_model_path=self.config.l3_model_path)
                self._local_model = Llama(model_path=self.config.l3_model_path, chat_handler=handler)

            import base64

            img_b64 = base64.b64encode(image_bytes).decode("ascii")
            loop = asyncio.get_running_loop()

            def _chat() -> str:
                resp = self._local_model.create_chat_completion(
                    messages=[
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": question},
                                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}"}},
                            ],
                        }
                    ]
                )
                return resp["choices"][0]["message"]["content"]

            # ΑΩ-R25:本地 VLM 推理(秒级 CPU/GPU)⇒ tree 池(容量 2:引擎内锁
            # 串行化,更多并发无收益)
            text = await loop.run_in_executor(get_pool(TREE_POOL), _chat)
            # VLM 返回自然语言 → 解析元素（简化：返回原始文本作为单一元素；
            # rect 为整幅输入图 —— 经 region 复合映射后即"该次查询视野"的诚实占位）
            return [UIElement(
                source="L3-vlm",
                role="vlm-text",
                name=text[:20],
                rect=_compose_region_rect(
                    {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}, region
                ),
            )], None
        except Exception as e:  # noqa: BLE001
            return [], f"local llama failed: {e}"

    async def _remote_doubao(self, image_bytes: bytes, question: str, region: dict | None) -> tuple[list[UIElement], str | None]:
        """远程 doubao-vision API（神经纪元：结构化元素提取）。

        视觉皮层升级：不再回单一全屏文本块，而是要求 VLM 输出结构化 JSON
        元素数组（name + 归一化 rect），逐元素落位 —— L3 产物第一次可以直接
        进入网格分派与反射决策（与 L1/L2 同一元素方言）。
        解析失败 ⇒ 诚实 fault（绝不把散文伪装成元素）。
        """
        if not self.config.l3_remote_endpoint:
            return [], "DSH_PHYSICAL_L3_ENDPOINT not set"

        api_key = os.environ.get(self.config.l3_remote_api_key_env)
        if not api_key:
            return [], f"env {self.config.l3_remote_api_key_env} not set"

        try:
            import base64
            import httpx

            img_b64 = base64.b64encode(image_bytes).decode("ascii")
            structured_prompt = (
                "List all interactive UI elements in this screenshot. "
                "Respond with ONLY a JSON array, no prose. Each item: "
                '{"name": "<element label>", "role": "<button|link|input|text|menu>", '
                '"x": <0-1 normalized left>, "y": <0-1 normalized top>, '
                '"w": <0-1 normalized width>, "h": <0-1 normalized height>}. '
                "Coordinates are fractions of image width/height (0.0-1.0)."
            )
            payload = {
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": structured_prompt},
                            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}"}},
                        ],
                    }
                ]
            }
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    self.config.l3_remote_endpoint,
                    json=payload,
                    headers={"Authorization": f"Bearer {api_key}"},
                )
                resp.raise_for_status()
                data = resp.json()

            text = data["choices"][0]["message"]["content"]
            elements, fault = _parse_vlm_elements(text)
            # J 纪元坐标统一：图内归一化 → 全屏归一化（region 复合）。
            # 旧实现直接透传 —— Node 端 d7HostPort 再 ÷ 屏幕尺寸 = 双重缩小。
            if fault is None:
                for e in elements:
                    e.rect = _compose_region_rect(e.rect, region)
            return elements, fault
        except Exception as e:  # noqa: BLE001
            return [], f"remote doubao failed: {e}"


# ─── 仲裁器：反双盲核心 ───


def _iou(a: dict, b: dict) -> float:
    """计算两个 rect 的 IoU（Intersection over Union）。"""
    ax1, ay1 = a["x"], a["y"]
    ax2, ay2 = a["x"] + a["width"], a["y"] + a["height"]
    bx1, by1 = b["x"], b["y"]
    bx2, by2 = b["x"] + b["width"], b["y"] + b["height"]

    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    union = (a["width"] * a["height"]) + (b["width"] * b["height"]) - inter
    return inter / union if union > 0 else 0.0


# ΝΩ-35：仲裁对齐的候选剪枝参数 —— 粗网格桶（16x16=256 桶）+ 直积扫阈值。
_ALIGN_GRID = 16
_ALIGN_BRUTE_PAIRS = 4096  # L1×L2 ≤ 此值时桶构建不划算，走原直积扫


def _cells_of_span(x: float, w: float) -> tuple[int, int]:
    """归一化区间 [x, x+w] 覆盖的网格列/行号闭区间（夹取到 [0, G-1]）。"""
    lo = min(max(int(x * _ALIGN_GRID), 0), _ALIGN_GRID - 1)
    hi = min(max(math.ceil((x + w) * _ALIGN_GRID) - 1, 0), _ALIGN_GRID - 1)
    return lo, max(lo, hi)


def _iou_candidates(l1: list[UIElement], l2: list[UIElement]) -> list[list[int]]:
    """ΝΩ-35：粗网格桶 → 每个 e1 的候选 j 升序清单。

    等值根基：IoU>0 要求 x/y 区间双双正长重叠；两区间重叠时，取 m=max(左端)
    所在格 k —— k 落在两者覆盖格区间内（左端≤m ⇒ k≥各自的 floor(左端·G)；
    m<右端 ⇒ k≤各自的 ceil(右端·G)-1）⇒ 共格。反向不保证（共格但区间仅
    相触/分离的对会进候选）—— 但它们 IoU≡0，而 best 更新是严格 ``> 0.0``
    起步，0 分对永不获胜 ⇒ 多算不改变结果、少算只少算 0 分对。候选按 j
    升序评估，首达最大语义（``iou > best_iou`` 保留更早的并列最大）与直积
    扫一致。畸形 rect（键缺失/NaN）两侧都退化为全候选/全格 —— 与旧直积扫
    在 _iou 处的异常/NaN 行为逐步对齐。
    """
    full = (0, _ALIGN_GRID - 1)
    buckets: dict[int, list[int]] = {}
    for j, e2 in enumerate(l2):
        r = e2.rect
        try:
            gx = _cells_of_span(float(r["x"]), float(r["width"]))
            gy = _cells_of_span(float(r["y"]), float(r["height"]))
        except (KeyError, TypeError, ValueError):
            gx = gy = full  # 畸形 rect：进全部格（旧直积扫会把它与每个 e1 配对）
        for cy in range(gy[0], gy[1] + 1):
            base = cy * _ALIGN_GRID
            for cx in range(gx[0], gx[1] + 1):
                buckets.setdefault(base + cx, []).append(j)

    out: list[list[int]] = []
    for e1 in l1:
        r = e1.rect
        try:
            gx = _cells_of_span(float(r["x"]), float(r["width"]))
            gy = _cells_of_span(float(r["y"]), float(r["height"]))
        except (KeyError, TypeError, ValueError):
            out.append(list(range(len(l2))))  # 畸形 rect：退化为全候选（旧直积扫行为）
            continue
        cand: set[int] = set()
        for cy in range(gy[0], gy[1] + 1):
            base = cy * _ALIGN_GRID
            for cx in range(gx[0], gx[1] + 1):
                cand.update(buckets.get(base + cx, ()))
        out.append(sorted(cand))
    return out


def _align_elements(l1: list[UIElement], l2: list[UIElement], iou_threshold: float = 0.3) -> tuple[list[UIElement], int]:
    """对齐 L1 与 L2 的元素。

    返回 ``(aligned, conflict_count)``：
      - ``aligned``：合并后的元素列表
      - ``conflict_count``：位置不匹配的元素数量（用于触发 L3 仲裁）

    ΝΩ-35 性能：O(L1×L2) 全积扫 → 粗网格桶候选剪枝（大列表时接近
    O(n log n)：典型 UI 元素只跨 1-4 格，候选集 O(1)；全屏巨型框退化为
    全候选 = 旧复杂度上界，不劣于旧实现）。结果与旧直积扫**逐元素等值**
    —— 依据见 ``_iou_candidates`` docstring（零 IoU 对永不赢得 best_iou
    的严格 > 语义）；test_ui_tree 随机/重叠/边界用例钉死。小列表（对数
    ≤4096）保留原直积扫路径（桶构建开销不划算）。调用方（UIFunnel）
    经 TREE_POOL 入池 —— 见 extract 内 ΝΩ-35 注。
    """
    aligned: list[UIElement] = []
    used_l2 = [False] * len(l2)
    conflicts = 0

    if len(l1) * len(l2) > _ALIGN_BRUTE_PAIRS:
        candidates: list[list[int]] | None = _iou_candidates(l1, l2)
    else:
        all_js = list(range(len(l2)))
        candidates = [all_js] * len(l1)

    for e1, js in zip(l1, candidates):
        best_iou = 0.0
        best_j = -1
        for j in js:
            if used_l2[j]:
                continue
            iou = _iou(e1.rect, l2[j].rect)
            if iou > best_iou:
                best_iou = iou
                best_j = j

        if best_iou >= iou_threshold and best_j >= 0:
            # 匹配成功：合并（L1 的 role/state + L2 的 name 文本）
            e2 = l2[best_j]
            used_l2[best_j] = True
            aligned.append(UIElement(
                source="L1-tree",  # 主源是 L1（结构信息更可靠）
                role=e1.role,
                name=e2.name if e2.name else e1.name,
                state=e1.state,
                rect=e1.rect,
            ))
        else:
            # L1 独有：可能是 L2 OCR 漏了
            aligned.append(e1)
            conflicts += 1

    # L2 独有元素
    for j, e2 in enumerate(l2):
        if not used_l2[j]:
            aligned.append(e2)
            conflicts += 1

    return aligned, conflicts


# ─── 漏斗主控 ───


class UIFunnel:
    """UI 树读取漏斗主控 —— 反双盲仲裁。"""

    def __init__(self, config: FunnelConfig) -> None:
        self.config = config
        self.l1 = L1TreeBackend(config.l1_backend)
        self.l2 = L2OCRBackend(config.l2_backend, config.ocr_languages)
        self.l3 = L3VLMBackend(config)

    async def extract(
        self,
        screenshot_bytes: bytes | None = None,
        region: dict | None = None,
        funnel_ceiling: str = "L3",
        screen_size: tuple[int, int] | None = None,
    ) -> FunnelResult:
        """执行漏斗：L1 → L2 → 仲裁 → L3（按需）。

        ``funnel_ceiling``：``'L1'`` 只跑 L1；``'L2'`` 跑到 L2；``'L3'`` 全跑（缺省）。
        ``screen_size``：``(width, height)`` 像素 —— L1 像素坐标归一化与
        L2 裁剪内 bbox 回映射的分母；缺席时 L1/L2（带 region）诚实降级 fault。
        """
        captured_at = int(time.time() * 1000)

        # ── L1 ──
        l1_elements, l1_fault = await self.l1.extract(region, screen_size)

        # ── L2（ceiling >= 'L2' 时跑）──
        l2_elements: list[UIElement] = []
        l2_fault: str | None = None
        if funnel_ceiling in ("L2", "L3"):
            l2_elements, l2_fault = await self.l2.extract(screenshot_bytes, region, screen_size)

        # ── 仲裁：L1+L2 一致则不调 L3 ──
        if self.config.arbitration_enabled and l1_elements and l2_elements:
            # ΝΩ-35（体检 T4）：O(L1×L2) 量级的对齐（L1 预算上限 800 元素 ×
            # OCR 数百词 ≈ 数十万 IoU，实测 800×500 直积扫 ~120ms）原在事件
            # 循环 ⇒ tree 池（与 OCR/VLM 同池；算法本体已桶剪枝降复杂度，
            # 入池保尾延迟不撞 P99）。
            aligned, conflicts = await run_in(
                TREE_POOL, _align_elements, l1_elements, l2_elements,
            )
            # 一致性判定：冲突数 < 总元素数的 20% → 视为一致
            total = len(l1_elements) + len(l2_elements)
            if total > 0 and conflicts / total < 0.2:
                return FunnelResult(
                    elements=aligned,
                    funnel_depth="L2",
                    captured_at=captured_at,
                    l3_invoked=False,
                )

        # ── L3 仲裁 / 兜底 ──
        if funnel_ceiling != "L3":
            # ceiling 不到 L3：返回当前结果（含降级 fault）
            depth: str = "L1" if l1_elements else ("L2" if l2_elements else "empty")
            fault = None
            if not l1_elements and l1_fault:
                fault = {"source": "L1", "detail": l1_fault}
            elif not l2_elements and l2_fault and funnel_ceiling == "L2":
                fault = {"source": "L2", "detail": l2_fault}
            return FunnelResult(
                elements=l1_elements + l2_elements,
                funnel_depth=depth,  # type: ignore[arg-type]
                fault=fault,
                captured_at=captured_at,
                l3_invoked=False,
            )

        # ── L3 调用 ──
        l3_elements, l3_fault = await self.l3.arbitrate(
            screenshot_bytes, l1_elements, l2_elements,
            region=region,
        )

        # ── 终局 ──
        if l3_elements:
            depth = "L3"
            fault = None
        elif l1_elements or l2_elements:
            # L3 失败但有 L1/L2 兜底
            depth = "L2" if l2_elements else "L1"
            fault = {"source": "L3", "detail": l3_fault or "L3 returned no elements"}
        else:
            depth = "empty"
            # 收集最先失败的 fault
            if l1_fault:
                fault = {"source": "L1", "detail": l1_fault}
            elif l2_fault:
                fault = {"source": "L2", "detail": l2_fault}
            else:
                fault = {"source": "L3", "detail": l3_fault or "all layers empty"}

        return FunnelResult(
            elements=l1_elements + l2_elements + l3_elements,
            funnel_depth=depth,  # type: ignore[arg-type]
            fault=fault,
            captured_at=captured_at,
            l3_invoked=True,
        )
