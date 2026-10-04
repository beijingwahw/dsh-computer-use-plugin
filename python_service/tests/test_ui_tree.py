"""ΑΩ-R37 离线单测：UIA L1 深度遍历核心（剪枝/预算/矩形过滤）+ role 映射 + 方言。

遍历核心 ``_walk_ui_tree`` 是纯函数（children 迭代器/字段描述器注入）——
本文件以可编程假树离线覆盖：深度/宽度/预算三护栏、零面积与全然屏外剪枝、
IsOffscreen 子树跳过、describe/children 失败韧性、quartz 诚实降级信封、
L1 输出方言（source/role/name≤20/state/score 缺席）。零 COM、零网络。

ΝΩ-50 增补：Linux AT-SPI（pyatspi）适配器离线单测 —— 假 pyatspi 模块
（sys.modules 注入）锁死 children/describe 装配 + 同律护栏（深度/预算/
宽度/矩形剪枝/STATE_SHOWING 子树跳过）+ role 名映射与 Windows 同词表。
真机 Linux 集成路径未验证（Windows 开发机无 AT-SPI 总线）—— 诚实注记，
不伪造覆盖（见 AtspiAdapterTests docstring）。
"""
import asyncio
import sys
import types
import unittest
from dataclasses import dataclass, field
from pathlib import Path
from unittest import mock

import numpy as np  # noqa: E402 —— ΝΩ-35 等值用例的确定性随机元素工厂

# ΑΩ-R32 先例：discover 以本目录为 top-level，注入 python_service/（dsh_physical 所在目录）
_SVC_ROOT = str(Path(__file__).resolve().parents[1])
if _SVC_ROOT not in sys.path:
    sys.path.insert(0, _SVC_ROOT)

from dsh_physical import ui_tree  # noqa: E402
from dsh_physical.ui_tree import (  # noqa: E402
    L1TreeBackend,
    _ATSPI_ROLE_NAME_ROLES,
    _UIA_CONTROL_TYPE_ROLES,
    _UIA_MAX_CHILDREN,
    _UIA_MAX_DEPTH,
    _UIA_MAX_ELEMENTS,
    _TREE_MAX_CHILDREN,
    _TREE_MAX_DEPTH,
    _TREE_MAX_ELEMENTS,
    _atspi_role_from_name,
    _atspi_snapshot,
    _rect_is_degenerate,
    _ui_element_from_raw,
    _uia_role,
    _uia_role_from_name,
    _walk_ui_tree,
)


# ─── ΑΩ-R37: 可编程假树（注入纯遍历核心）───


@dataclass
class _FakeNode:
    """假 UIA 节点：rect/角色/可见性/失败模式全部可编程。"""

    name: str = "n"
    rect: dict | None = field(default_factory=lambda: {"x": 10, "y": 10, "width": 100, "height": 50})
    role: str = "button"
    state: str = "enabled"
    offscreen: bool | None = None  # None = describe 不携带该键（属性读不到）
    children: list = field(default_factory=list)
    describe_fails: bool = False  # describe → None（字段读取失败）
    children_raise: bool = False  # children_of → 抛（元素已消亡）


def _children_of(node: _FakeNode):
    if node.children_raise:
        raise RuntimeError("element vanished mid-iteration")
    return node.children


def _describe(node: _FakeNode) -> dict | None:
    if node.describe_fails:
        return None
    raw = {"name": node.name, "role": node.role, "state": node.state, "rect": dict(node.rect)}
    if node.offscreen is not None:
        raw["offscreen"] = node.offscreen
    return raw


def _chain(length: int, **kwargs) -> _FakeNode:
    """长度 length 的单叉链（root 为第 0 层）—— 钉死深度护栏。"""
    node = _FakeNode(name=f"d{length - 1}", **kwargs)
    for i in range(length - 2, -1, -1):
        node = _FakeNode(name=f"d{i}", children=[node])
    return node


SCREEN = (1920, 1080)


class WalkCoreTests(unittest.TestCase):
    """护栏三件套 + 剪枝规则（纯函数，零 COM）。"""

    def test_deep_traversal_preorder(self):
        # 三层树全量收集，先序 DFS：root → 第一子 → 其子 → 次子
        root = _FakeNode(name="root", children=[
            _FakeNode(name="a", children=[_FakeNode(name="a1")]),
            _FakeNode(name="b"),
        ])
        els, stats = _walk_ui_tree(root, _children_of, _describe)
        self.assertEqual([e["name"] for e in els], ["root", "a", "a1", "b"])
        self.assertEqual(stats["visited"], 4)
        self.assertEqual(stats["max_depth_seen"], 2)
        self.assertFalse(stats["budget_hit"])

    def test_depth_cap_prunes_beyond_limit(self):
        # 8 层链、上限 3：只收第 0..3 层，max_depth_seen 封顶于 3
        root = _chain(8)
        els, stats = _walk_ui_tree(root, _children_of, _describe, max_depth=3)
        self.assertEqual([e["name"] for e in els], ["d0", "d1", "d2", "d3"])
        self.assertEqual(stats["max_depth_seen"], 3)
        self.assertGreaterEqual(stats["depth_pruned"], 1)  # 第 3 层节点的子层被拒展开

    def test_children_cap_truncates_per_level(self):
        # 70 子、上限 64：保序截前 64 个，宽度剪枝计数 = 6
        root = _FakeNode(name="root", children=[
            _FakeNode(name=f"k{i}") for i in range(70)
        ])
        els, stats = _walk_ui_tree(root, _children_of, _describe, max_children=64)
        names = [e["name"] for e in els]
        self.assertEqual(names, ["root"] + [f"k{i}" for i in range(64)])
        self.assertEqual(stats["width_pruned"], 6)

    def test_element_budget_stops_traversal(self):
        # 100 个合法兄弟、预算 10：恰收 10 个即停，budget_hit 置位
        root = _FakeNode(name="root", children=[
            _FakeNode(name=f"k{i}") for i in range(100)
        ])
        els, stats = _walk_ui_tree(root, _children_of, _describe, max_elements=10)
        self.assertEqual(len(els), 10)
        self.assertTrue(stats["budget_hit"])
        self.assertLess(stats["visited"], 101)  # 真的提前停了，不是走完再截

    def test_zero_area_rect_pruned_but_subtree_kept(self):
        # 零/负面积父：元素剪除、子树照走（父 rect 占位符畸形 ≠ 子不可见）
        root = _FakeNode(
            name="bad-parent",
            rect={"x": 5, "y": 5, "width": 0, "height": 50},
            children=[_FakeNode(name="good-child")],
        )
        els, stats = _walk_ui_tree(root, _children_of, _describe)
        self.assertEqual([e["name"] for e in els], ["good-child"])
        self.assertEqual(stats["degenerate_rect"], 1)

    def test_fully_offscreen_rect_pruned_partial_overlap_kept(self):
        # 全然屏外剪、部分越界留（负 x 阴影边 / 右缘半出 —— normalize 钳制方言）
        kept_partial_right = _FakeNode(name="pr", rect={"x": 1800, "y": 0, "width": 300, "height": 50})
        kept_negative_x = _FakeNode(name="nx", rect={"x": -100, "y": 0, "width": 200, "height": 50})
        out_right = _FakeNode(name="or", rect={"x": 2000, "y": 0, "width": 100, "height": 50})
        out_left = _FakeNode(name="ol", rect={"x": -5000, "y": 0, "width": 100, "height": 50})
        out_below = _FakeNode(name="ob", rect={"x": 0, "y": 5000, "width": 100, "height": 50})
        root = _FakeNode(name="root", children=[kept_partial_right, kept_negative_x, out_right, out_left, out_below])
        els, stats = _walk_ui_tree(root, _children_of, _describe, screen_px=SCREEN)
        self.assertEqual([e["name"] for e in els], ["root", "pr", "nx"])
        self.assertEqual(stats["degenerate_rect"], 3)

    def test_offscreen_flag_skips_whole_subtree(self):
        # IsOffscreen=True：元素 + 整个子树跳过（屏外容器不消耗预算）
        hidden = _FakeNode(
            name="hidden", offscreen=True,
            children=[_FakeNode(name="hidden-child", children=[_FakeNode(name="hidden-grand")])],
        )
        root = _FakeNode(name="root", children=[hidden, _FakeNode(name="visible")])
        els, stats = _walk_ui_tree(root, _children_of, _describe)
        self.assertEqual([e["name"] for e in els], ["root", "visible"])
        self.assertEqual(stats["offscreen_skipped"], 1)
        self.assertEqual(stats["visited"], 3)  # hidden 的后代一次都没被访问

    def test_describe_failure_resilient_children_still_walked(self):
        # describe → None：元素放弃，子树照走
        root = _FakeNode(name="dead", describe_fails=True, children=[_FakeNode(name="alive")])
        els, stats = _walk_ui_tree(root, _children_of, _describe)
        self.assertEqual([e["name"] for e in els], ["alive"])
        self.assertEqual(stats["visited"], 2)

    def test_children_iterator_raising_treated_as_leaf(self):
        # 子枚举抛异常（元素消亡）→ 按无子处理，绝不上抛
        root = _FakeNode(name="root", children_raise=True, children=[_FakeNode(name="ghost")])
        els, stats = _walk_ui_tree(root, _children_of, _describe)
        self.assertEqual([e["name"] for e in els], ["root"])
        self.assertEqual(stats["visited"], 1)

    def test_screen_px_absent_only_area_rule(self):
        # screen_px 缺席：仅面积判定（x=99999 不算屏外 —— 保守路径）
        far = _FakeNode(name="far", rect={"x": 99999, "y": 99999, "width": 10, "height": 10})
        els, _ = _walk_ui_tree(far, _children_of, _describe, screen_px=None)
        self.assertEqual(len(els), 1)


class RectDegenerateTests(unittest.TestCase):
    """``_rect_is_degenerate`` 判定表（真值表直测）。"""

    def test_known_values(self):
        ok = {"x": 0, "y": 0, "width": 1, "height": 1}
        self.assertFalse(_rect_is_degenerate(ok, SCREEN))
        self.assertFalse(_rect_is_degenerate(ok, None))
        for bad_rect in (
            {"x": 0, "y": 0, "width": 0, "height": 5},     # 零宽
            {"x": 0, "y": 0, "width": 5, "height": 0},     # 零高
            {"x": 0, "y": 0, "width": -3, "height": 5},    # 负宽
            {"x": 1920, "y": 0, "width": 5, "height": 5},  # 右缘全出（x≥sw）
            {"x": 0, "y": 1080, "width": 5, "height": 5},  # 下缘全出（y≥sh）
            {"x": -10, "y": 0, "width": 5, "height": 5},   # 左缘全出（x+w≤0）
            {"x": 0, "y": -10, "width": 5, "height": 5},   # 上缘全出（y+h≤0）
            {"x": 0, "y": 0},                              # 键缺失 → 畸形
            None,                                          # 缺席
            "not-a-rect",                                  # 类型畸形
        ):
            self.assertTrue(_rect_is_degenerate(bad_rect, SCREEN), bad_rect)

    def test_partial_overlap_is_not_degenerate(self):
        # 部分越界（交非空）不算退化 —— 与 normalize 钳制方言配套
        self.assertFalse(_rect_is_degenerate({"x": 1900, "y": 0, "width": 100, "height": 5}, SCREEN))
        self.assertFalse(_rect_is_degenerate({"x": -50, "y": -50, "width": 100, "height": 100}, SCREEN))


class RoleMapTests(unittest.TestCase):
    """ΑΩ-R37 role 映射：id/名 → 既有词表（小写控件名），缺失归 'unknown'。"""

    def test_known_ids_map_to_vocab(self):
        self.assertEqual(_uia_role(50000), "button")
        self.assertEqual(_uia_role(50004), "edit")
        self.assertEqual(_uia_role(50005), "hyperlink")
        self.assertEqual(_uia_role(50009), "menu")
        self.assertEqual(_uia_role(50020), "text")
        self.assertEqual(_uia_role(50032), "window")
        self.assertEqual(_uia_role(50033), "pane")

    def test_unknown_and_missing_ids(self):
        self.assertEqual(_uia_role(99999), "unknown")
        self.assertEqual(_uia_role(None), "unknown")

    def test_map_is_complete_and_wellformed(self):
        # 41 个 UIA_*ControlTypeId 全覆盖（本机 typelib 核验数）；值全为非空小写
        self.assertEqual(len(_UIA_CONTROL_TYPE_ROLES), 41)
        for role in _UIA_CONTROL_TYPE_ROLES.values():
            self.assertRegex(role, r"^[a-z]+$")
        # 文件既有词表命中（UIElement 注 / L2 / L3 prompt 的核心词）
        self.assertIn("button", _UIA_CONTROL_TYPE_ROLES.values())
        self.assertIn("text", _UIA_CONTROL_TYPE_ROLES.values())
        self.assertIn("menu", _UIA_CONTROL_TYPE_ROLES.values())

    def test_role_from_name_strips_wrapper_suffix(self):
        # 遗留 uiautomation 库的 'ButtonControl' 形态 → 同词表
        self.assertEqual(_uia_role_from_name("ButtonControl"), "button")
        self.assertEqual(_uia_role_from_name("EditControl"), "edit")
        self.assertEqual(_uia_role_from_name("DataItemControl"), "dataitem")
        self.assertEqual(_uia_role_from_name(""), "unknown")
        self.assertEqual(_uia_role_from_name(None), "unknown")


class ElementDialectTests(unittest.TestCase):
    """L1 输出方言不变：source/role/name≤20/state/score 缺席。"""

    def test_from_raw_to_dict_dialect(self):
        el = _ui_element_from_raw({
            "name": "x" * 30,  # 超长 name —— to_dict 按 D-3 先例截 20
            "role": "button",
            "state": "disabled",
            "rect": {"x": 10, "y": 10, "width": 100, "height": 50},
        })
        self.assertIsNone(el.score)  # L1 无分数 —— 真值缺席
        d = el.to_dict()
        self.assertEqual(set(d), {"source", "role", "name", "state", "rect"})  # score 键缺席
        self.assertEqual(d["source"], "L1-tree")
        self.assertEqual(d["name"], "x" * 20)
        self.assertEqual(d["role"], "button")
        self.assertEqual(d["state"], "disabled")

    def test_from_raw_defensive_defaults(self):
        # 字段缺席 → unknown/""（诚实方言，不抛）
        el = _ui_element_from_raw({})
        self.assertEqual(el.role, "unknown")
        self.assertEqual(el.name, "")
        self.assertIsNone(el.state)
        self.assertEqual(el.source, "L1-tree")


class BackendEnvelopeTests(unittest.TestCase):
    """信封行为（离线：disabled / screen_size 缺席 / quartz 诚实降级 / UIA 适配器装配）。"""

    def test_disabled_backend_envelope(self):
        els, fault = asyncio.run(L1TreeBackend("disabled").extract(None, (1920, 1080)))
        self.assertEqual(els, [])
        self.assertEqual(fault, "L1 backend disabled")

    def test_screen_size_absent_honest_fault(self):
        # 像素坐标无法归一化 → 诚实 fault（在平台分派之前短路，零 COM）
        els, fault = asyncio.run(L1TreeBackend("uiautomation").extract(None, None))
        self.assertEqual(els, [])
        self.assertIn("screen size unavailable", fault)

    def test_quartz_honest_degradation_no_fabricated_elements(self):
        # quartz：空列表 + 非 None fault（win32 上是 import failed，
        # 装了 pyobjc 的 mac 上是 quartz-l1-not-implemented）—— 两条都是诚实降级
        els, fault = asyncio.run(L1TreeBackend("quartz")._extract_quartz(None))
        self.assertEqual(els, [])
        self.assertIsNotNone(fault)
        self.assertTrue(
            "quartz-l1-not-implemented" in fault or "quartz import failed" in fault,
            fault,
        )

    def test_extract_normalizes_and_filters_region(self):
        # 集成：monkeypatch comtypes 快照 → extract 归一化 + region 中心过滤（J 纪元路径未动）
        def fake_snapshot(screen_px):
            raws = [
                {"name": "left", "role": "button", "state": "enabled",
                 "rect": {"x": 0, "y": 0, "width": 100, "height": 100}},      # 中心 (0.026,0.046)
                {"name": "right", "role": "edit", "state": "enabled",
                 "rect": {"x": 1800, "y": 0, "width": 100, "height": 100}},   # 中心 (~0.96,0.046)
            ]
            return raws, {"visited": 2, "max_depth_seen": 0, "depth_pruned": 0,
                          "width_pruned": 0, "degenerate_rect": 0,
                          "offscreen_skipped": 0, "budget_hit": False}

        with mock.patch.object(ui_tree, "_uia_comtypes_snapshot", side_effect=fake_snapshot):
            els, fault = asyncio.run(
                L1TreeBackend("uiautomation").extract(
                    {"x": 0.0, "y": 0.0, "width": 0.5, "height": 1.0}, SCREEN,
                )
            )
        self.assertIsNone(fault)
        self.assertEqual([e.name for e in els], ["left"])  # 右半屏元素被 region 过滤
        r = els[0].rect
        self.assertTrue(all(0.0 <= r[k] <= 1.0 for k in ("x", "y", "width", "height")))  # 已归一化
        self.assertAlmostEqual(r["width"], 100 / 1920)

    def test_uiautomation_library_fallback_adapter(self):
        # comtypes 缺席 → 遗留 uiautomation 库适配器接管（假模块注入，零真 COM）
        class _FakeRect:
            left, top, width, height = 96, 54, 200, 100

        class _FakeCtrl:
            def __init__(self, name, type_name, children=()):
                self.Name, self.ControlTypeName = name, type_name
                self.IsEnabled, self.BoundingRectangle, self.IsOffscreen = True, _FakeRect(), False
                self._children = list(children)

            def GetChildren(self):
                return self._children

        fake_mod = types.ModuleType("uiautomation")
        fake_mod.GetRootControl = lambda: _FakeCtrl("root", "PaneControl", [
            _FakeCtrl("btn", "ButtonControl"),
            _FakeCtrl("edit", "EditControl", [_FakeCtrl("inner-text", "TextControl")]),
        ])
        with mock.patch.dict(sys.modules, {"uiautomation": fake_mod}), \
                mock.patch.object(ui_tree, "_uia_comtypes_snapshot", side_effect=ImportError("no comtypes")):
            els, fault = asyncio.run(
                L1TreeBackend("uiautomation")._extract_uiautomation(None, SCREEN)
            )
        self.assertIsNone(fault)
        # 深度收集（旧骨架只见顶层 2 个 —— 现在含 3 层的 inner-text）+ role 同词表
        self.assertEqual([e.name for e in els], ["root", "btn", "edit", "inner-text"])
        self.assertEqual([e.role for e in els], ["pane", "button", "edit", "text"])
        self.assertTrue(all(e.state == "enabled" for e in els))

    def test_both_uia_backends_missing_honest_fault(self):
        # comtypes 与 uiautomation 都缺席 → 诚实 import fault（不抛）
        with mock.patch.object(ui_tree, "_uia_comtypes_snapshot", side_effect=ImportError("no comtypes")), \
                mock.patch.dict(sys.modules, {"uiautomation": None}):
            els, fault = asyncio.run(
                L1TreeBackend("uiautomation")._extract_uiautomation(None, SCREEN)
            )
        self.assertEqual(els, [])
        self.assertIn("import failed", fault)


# ─── ΝΩ-50: 假 AT-SPI 树（pyatspi Accessible 方言 —— Linux 适配器离线覆盖）───

# 假 StateSet 的两个状态位（真 pyatspi 的 STATE_ENABLED/STATE_SHOWING 是模块级常量）
_ST_ENABLED, _ST_SHOWING = 1, 2
_ST_OK = (_ST_ENABLED, _ST_SHOWING)


class _FakeStateSet:
    def __init__(self, *states: int):
        self._states = set(states)

    def contains(self, state: int) -> bool:
        return state in self._states


class _FakeAtspiRect:
    """AT-SPI Extents 方言：属性访问 x/y/width/height。"""

    def __init__(self, rect: dict):
        self.x, self.y = rect["x"], rect["y"]
        self.width, self.height = rect["width"], rect["height"]


class _FakeAtspiComponent:
    """Component 接口桩：getExtents(coords) —— 供 queryComponent 路径。"""

    def __init__(self, rect: dict):
        self._rect = _FakeAtspiRect(rect)

    def getExtents(self, _coords: int) -> _FakeAtspiRect:
        return self._rect


class _FakeAtspiNode:
    """假 pyatspi Accessible：name/role/extents/states/children/失败模式全可编程。

    覆盖的字段面与真 AT-SPI Accessible 一致：name（属性）、getRoleName()、
    childCount/getChildAtIndex、getExtents()（旧顶层枚举直连方言）、
    queryComponent()（Component 接口）、getStates()（StateSet.contains）。
    ``states=None`` → getStates() 抛（状态读不到的保守路径）；
    ``component_rect`` 缺席 → queryComponent() 抛 NotImplementedError。
    """

    def __init__(self, name="", role_name="panel",
                 rect: dict | None = None, children=(), states: tuple | None = None,
                 component_rect: dict | None = None,
                 extents_raise: bool = False, child_raise: bool = False):
        self.name = name
        self._role_name = role_name
        self._rect = dict(rect or {"x": 10, "y": 10, "width": 100, "height": 50})
        self._children = list(children)
        self._states = _FakeStateSet(*states) if states is not None else None
        self._component = _FakeAtspiComponent(component_rect) if component_rect else None
        self._extents_raise = extents_raise
        self._child_raise = child_raise

    def getRoleName(self) -> str:
        return self._role_name

    @property
    def childCount(self) -> int:
        if self._child_raise:
            raise RuntimeError("accessible vanished")
        return len(self._children)

    def getChildAtIndex(self, i: int):
        if self._child_raise:
            raise RuntimeError("accessible vanished")
        return self._children[i]

    def getExtents(self) -> _FakeAtspiRect:
        if self._extents_raise:
            raise RuntimeError("dead object")
        return _FakeAtspiRect(self._rect)

    def queryComponent(self):
        if self._component is None:
            raise NotImplementedError("no component interface")
        return self._component

    def getStates(self) -> _FakeStateSet:
        if self._states is None:
            raise RuntimeError("states unavailable")
        return self._states


def _fake_pyatspi_module(desktop: _FakeAtspiNode) -> types.ModuleType:
    """假 pyatspi 模块：Registry.getDesktop + 状态/坐标常量（sys.modules 注入用）。"""
    mod = types.ModuleType("pyatspi")
    mod.STATE_ENABLED = _ST_ENABLED
    mod.STATE_SHOWING = _ST_SHOWING
    mod.DESKTOP_COORDS = 0

    class _Registry:
        @staticmethod
        def getDesktop(_i: int) -> _FakeAtspiNode:
            return desktop

    mod.Registry = _Registry
    return mod


def _atspi_walk(desktop: _FakeAtspiNode, screen_px=SCREEN):
    """假 pyatspi 注入后跑真适配器 ``_atspi_snapshot``（零 D-Bus）。"""
    with mock.patch.dict(sys.modules, {"pyatspi": _fake_pyatspi_module(desktop)}):
        return _atspi_snapshot(screen_px)


def _atspi_chain(length: int, **kwargs) -> _FakeAtspiNode:
    """长度 length 的单叉链（desktop 为第 0 层）—— 钉死深度护栏。"""
    node = _FakeAtspiNode(name=f"d{length - 1}", **kwargs)
    for i in range(length - 2, -1, -1):
        node = _FakeAtspiNode(name=f"d{i}", children=[node])
    return node


class AtspiAdapterTests(unittest.TestCase):
    """ΝΩ-50: Linux AT-SPI 适配器 —— 与 Windows UIA 同律的护栏/剪枝/role 方言。

    集成路径诚实注记：真机 Linux（AT-SPI 总线 + python3-pyatspi）路径未
    验证 —— 本机是 Windows 开发机（无 AT-SPI 守护/总线）。本类以假
    pyatspi 模块离线锁死适配器装配与纯遍历核心的对接；真机冒烟（含
    queryComponent/getStates 的真实方言差异）待 Linux 硬件在场补验。
    """

    def test_guardrail_constants_single_source(self):
        # 三件套单源：数值 = R37 Windows 落地值；_UIA_* 旧名是同一对象别名
        self.assertEqual((_TREE_MAX_DEPTH, _TREE_MAX_CHILDREN, _TREE_MAX_ELEMENTS), (12, 64, 800))
        self.assertIs(_UIA_MAX_DEPTH, _TREE_MAX_DEPTH)
        self.assertIs(_UIA_MAX_CHILDREN, _TREE_MAX_CHILDREN)
        self.assertIs(_UIA_MAX_ELEMENTS, _TREE_MAX_ELEMENTS)
        # 词表交集对齐（Windows/Linux 同律 role 方言的核心成员）
        shared = set(_ATSPI_ROLE_NAME_ROLES.values()) & set(_UIA_CONTROL_TYPE_ROLES.values())
        for role in ("button", "checkbox", "combobox", "edit", "menu", "menubar",
                     "menuitem", "text", "list", "listitem", "progressbar", "slider",
                     "spinner", "statusbar", "tab", "tabitem", "toolbar", "tooltip",
                     "tree", "table", "image", "hyperlink", "window", "pane", "group",
                     "separator", "document", "calendar", "radiobutton", "scrollbar"):
            self.assertIn(role, shared, role)

    def test_deep_dfs_collects_below_toplevel(self):
        # 旧骨架只见 desktop 顶层；深度 DFS 下钻 3 层（Linux L1 召回对齐 Windows）
        desktop = _FakeAtspiNode(name="desktop", role_name="desktop frame", children=[
            _FakeAtspiNode(name="app", role_name="frame", children=[
                _FakeAtspiNode(name="dlg", role_name="dialog", children=[
                    _FakeAtspiNode(name="btn", role_name="push button"),
                ]),
            ]),
        ])
        els, stats = _atspi_walk(desktop)
        self.assertEqual([e["name"] for e in els], ["desktop", "app", "dlg", "btn"])
        # 'desktop frame' 未映射 → 小写原名（开集旧方言）；frame/dialog → window 同词表
        self.assertEqual([e["role"] for e in els], ["desktop frame", "window", "window", "button"])
        self.assertEqual(stats["max_depth_seen"], 3)
        self.assertFalse(stats["budget_hit"])

    def test_depth_cap_uses_windows_constants(self):
        # 20 层链、护栏 12：恰收 d0..d12（与 WalkCoreTests.test_depth_cap 同律，
        # 但走真适配器默认常量 —— 不降参注入）
        desktop = _atspi_chain(20)
        els, stats = _atspi_walk(desktop)
        self.assertEqual([e["name"] for e in els], [f"d{i}" for i in range(_TREE_MAX_DEPTH + 1)])
        self.assertEqual(stats["max_depth_seen"], _TREE_MAX_DEPTH)
        self.assertGreaterEqual(stats["depth_pruned"], 1)

    def test_budget_cap_hard_stops(self):
        # 64 叉 × 2 层（1+64+4096=4161 潜在节点，每层恰 64 不触发宽度截断）
        # —— 预算 800 先于树的规模起作用：恰收 800 即停（budget_hit 置位）
        desktop = _FakeAtspiNode(name="d", children=[
            _FakeAtspiNode(name=f"k{i}", children=[
                _FakeAtspiNode(name=f"k{i}_{j}") for j in range(64)
            ]) for i in range(64)
        ])
        els, stats = _atspi_walk(desktop)
        self.assertEqual(len(els), _TREE_MAX_ELEMENTS)
        self.assertTrue(stats["budget_hit"])
        self.assertLess(stats["visited"], 1 + 64 + 64 * 64)  # 真的提前停了，不是走完再截
        self.assertEqual(els[0]["name"], "d")
        self.assertEqual(els[1]["name"], "k0")
        self.assertEqual(els[2]["name"], "k0_0")  # 先序 DFS：k0 的子先于 k1

    def test_children_cap_truncates_per_level(self):
        # 70 子、每层 64：保序截前 64（与 Windows 同律同常量）
        desktop = _FakeAtspiNode(name="d", children=[
            _FakeAtspiNode(name=f"k{i}") for i in range(70)
        ])
        els, stats = _atspi_walk(desktop)
        self.assertEqual(
            [e["name"] for e in els], ["d"] + [f"k{i}" for i in range(_TREE_MAX_CHILDREN)],
        )
        self.assertEqual(stats["width_pruned"], 70 - _TREE_MAX_CHILDREN)

    def test_showing_absent_prunes_subtree_states_unreadable_keeps(self):
        # STATE_SHOWING 缺席（AT-SPI 版 IsOffscreen）→ 元素+子树剪；
        # getStates() 抛（读不到）→ 保守保留（无 offscreen 键 —— 与 UIA 同策）
        hidden = _FakeAtspiNode(name="hidden", states=(_ST_ENABLED,),
                                children=[_FakeAtspiNode(name="hidden-child")])
        blind = _FakeAtspiNode(name="blind")  # states=None → getStates 抛
        desktop = _FakeAtspiNode(name="d", children=[hidden, blind])
        els, stats = _atspi_walk(desktop)
        self.assertEqual([e["name"] for e in els], ["d", "blind"])
        self.assertEqual(stats["offscreen_skipped"], 1)
        self.assertEqual(stats["visited"], 3)  # hidden 后代一次都没被访问

    def test_state_dialect_enabled_disabled(self):
        # STATE_ENABLED → 'enabled'/'disabled'；states 读不到 → 键缺席（None）
        desktop = _FakeAtspiNode(name="d", children=[
            _FakeAtspiNode(name="on", role_name="push button", states=_ST_OK),
            _FakeAtspiNode(name="off", role_name="push button", states=(_ST_SHOWING,)),
        ])
        els, _ = _atspi_walk(desktop)
        self.assertEqual([e.get("state") for e in els], [None, "enabled", "disabled"])

    def test_degenerate_and_fully_offscreen_rect_pruned(self):
        # 零宽父：元素剪、子树照走；全然屏外（x≥sw）：剪 —— 与 Windows 同律
        bad_parent = _FakeAtspiNode(
            name="bp", rect={"x": 0, "y": 0, "width": 0, "height": 10},
            children=[_FakeAtspiNode(name="child")],
        )
        out = _FakeAtspiNode(name="out", rect={"x": 5000, "y": 0, "width": 50, "height": 50})
        desktop = _FakeAtspiNode(name="d", children=[bad_parent, out])
        els, stats = _atspi_walk(desktop, screen_px=SCREEN)
        self.assertEqual([e["name"] for e in els], ["d", "child"])
        self.assertEqual(stats["degenerate_rect"], 2)

    def test_component_interface_face_preferred(self):
        # queryComponent().getExtents(coords) 优先；缺席时才回落旧 getExtents()
        comp = _FakeAtspiNode(
            name="c", component_rect={"x": 1, "y": 2, "width": 3, "height": 4},
            rect={"x": 9, "y": 9, "width": 9, "height": 9},
        )
        els, _ = _atspi_walk(comp)
        self.assertEqual(els[0]["rect"], {"x": 1, "y": 2, "width": 3, "height": 4})
        legacy = _FakeAtspiNode(name="l")  # 无 Component 接口 → 旧直连方言
        els2, _ = _atspi_walk(legacy)
        self.assertEqual(els2[0]["rect"], {"x": 10, "y": 10, "width": 100, "height": 50})

    def test_extents_failure_drops_element_keeps_children(self):
        # 双 extents 路径全失败 → describe None：元素放弃、子树照走
        dead = _FakeAtspiNode(name="dead", extents_raise=True,
                              children=[_FakeAtspiNode(name="alive")])
        desktop = _FakeAtspiNode(name="d", children=[dead])
        els, _ = _atspi_walk(desktop)
        self.assertEqual([e["name"] for e in els], ["d", "alive"])

    def test_child_enumeration_failure_treated_as_leaf(self):
        # childCount/getChildAtIndex 抛（元素消亡）→ 按无子处理，绝不上抛
        ghost = _FakeAtspiNode(name="ghost", child_raise=True,
                               children=[_FakeAtspiNode(name="never")])
        desktop = _FakeAtspiNode(name="d", children=[ghost])
        els, _ = _atspi_walk(desktop)
        self.assertEqual([e["name"] for e in els], ["d", "ghost"])

    def test_role_mapping_table(self):
        # 名称键 → Windows 同词表；未映射 → 小写原名（开集）；空/None → unknown
        self.assertEqual(_atspi_role_from_name("push button"), "button")
        self.assertEqual(_atspi_role_from_name("toggle button"), "button")
        self.assertEqual(_atspi_role_from_name("check box"), "checkbox")
        self.assertEqual(_atspi_role_from_name("combo box"), "combobox")
        self.assertEqual(_atspi_role_from_name("entry"), "edit")
        self.assertEqual(_atspi_role_from_name("page tab list"), "tab")
        self.assertEqual(_atspi_role_from_name("page tab"), "tabitem")
        self.assertEqual(_atspi_role_from_name("radio button"), "radiobutton")
        self.assertEqual(_atspi_role_from_name("menu item"), "menuitem")
        self.assertEqual(_atspi_role_from_name("spin button"), "spinner")
        self.assertEqual(_atspi_role_from_name("Dial"), "dial")  # 未映射 → 旧小写方言
        self.assertEqual(_atspi_role_from_name(None), "unknown")
        self.assertEqual(_atspi_role_from_name(""), "unknown")
        for role in _ATSPI_ROLE_NAME_ROLES.values():
            self.assertRegex(role, r"^[a-z]+$")  # 映射值全部落入闭词表形态

    def test_pyatspi_missing_honest_fault(self):
        # pyatspi 缺席 → 诚实 import fault（零回归：旧顶层枚举同款信封）
        with mock.patch.dict(sys.modules, {"pyatspi": None}):
            els, fault = asyncio.run(L1TreeBackend("xlib")._extract_xlib(None, SCREEN))
        self.assertEqual(els, [])
        self.assertIn("pyatspi import failed", fault)
        self.assertIn("python3-pyatspi", fault)

    def test_extract_xlib_full_path_dialect_and_pool(self):
        # 端到端（假 pyatspi + tree 池）：像素 rect → UIElement 方言；extract 再归一化
        desktop = _FakeAtspiNode(name="d", children=[
            _FakeAtspiNode(name="btn", role_name="push button", states=_ST_OK),
        ])
        with mock.patch.dict(sys.modules, {"pyatspi": _fake_pyatspi_module(desktop)}):
            els, fault = asyncio.run(L1TreeBackend("xlib")._extract_xlib(None, SCREEN))
            self.assertIsNone(fault)
            self.assertEqual([e.name for e in els], ["d", "btn"])
            self.assertEqual([e.role for e in els], ["pane", "button"])  # panel→pane 同词表
            self.assertEqual([e.state for e in els], [None, "enabled"])
            # L1TreeBackend.extract 全路径：归一化 + region 过滤（J 纪元方言）
            els2, fault2 = asyncio.run(L1TreeBackend("xlib").extract(None, SCREEN))
        self.assertIsNone(fault2)
        r = els2[-1].rect
        self.assertTrue(all(0.0 <= r[k] <= 1.0 for k in ("x", "y", "width", "height")))
        self.assertAlmostEqual(r["width"], 100 / 1920)

    def test_auto_backend_resolves_linux_to_xlib(self):
        # auto 分派方言零回归：linux → xlib（历史名，实装 AT-SPI）
        with mock.patch.object(ui_tree.sys, "platform", "linux"):
            self.assertEqual(L1TreeBackend("auto")._impl, "xlib")


# ─── ΝΩ-35：仲裁对齐桶剪枝等值用例（旧 O(L1×L2) 直积扫为内联参照）───


def _rand_elements(n: int, seed: int, spread: float = 0.05) -> list:
    rng = np.random.RandomState(seed)
    els = []
    for i in range(n):
        x, y = float(rng.rand() * 0.95), float(rng.rand() * 0.95)
        w, h = float(0.004 + rng.rand() * spread), float(0.004 + rng.rand() * spread)
        els.append(ui_tree.UIElement(
            source="L1-tree", role="text", name=f"e{i}",
            rect={"x": x, "y": y, "width": w, "height": h},
        ))
    return els


def _ref_align_brute(l1: list, l2: list, iou_threshold: float = 0.3) -> tuple[list, int]:
    """旧实现（全积扫）—— 等值参照。"""
    aligned = []
    used_l2 = [False] * len(l2)
    conflicts = 0
    for e1 in l1:
        best_iou = 0.0
        best_j = -1
        for j, e2 in enumerate(l2):
            if used_l2[j]:
                continue
            iou = ui_tree._iou(e1.rect, e2.rect)
            if iou > best_iou:
                best_iou = iou
                best_j = j
        if best_iou >= iou_threshold and best_j >= 0:
            e2 = l2[best_j]
            used_l2[best_j] = True
            aligned.append(ui_tree.UIElement(
                source="L1-tree", role=e1.role,
                name=e2.name if e2.name else e1.name,
                state=e1.state, rect=e1.rect,
            ))
        else:
            aligned.append(e1)
            conflicts += 1
    for j, e2 in enumerate(l2):
        if not used_l2[j]:
            aligned.append(e2)
            conflicts += 1
    return aligned, conflicts


def _fingerprint(els: list) -> list:
    return [(e.source, e.role, e.name, e.state, tuple(sorted(e.rect.items()))) for e in els]


class AlignElementsTests(unittest.TestCase):
    """ΝΩ-35：_align_elements 桶剪枝（>4096 对触发）与直积扫逐元素等值。"""

    def test_merge_dialect_and_conflict_count(self):
        # 同位 L1/L2 → 合并（L1 role/state + L2 name、rect 用 L1）；错位 → 各留 + 2 冲突
        a = ui_tree.UIElement(source="L1-tree", role="button", name="",
                              rect={"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.1})
        b = ui_tree.UIElement(source="L2-ocr", role="text", name="OK", score=0.9,
                              rect={"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.1})
        aligned, conflicts = ui_tree._align_elements([a], [b])
        self.assertEqual(conflicts, 0)
        self.assertEqual(aligned[0].name, "OK")
        self.assertEqual(aligned[0].role, "button")
        self.assertEqual(aligned[0].rect, a.rect)
        far = ui_tree.UIElement(source="L2-ocr", role="text", name="X",
                                rect={"x": 0.7, "y": 0.7, "width": 0.05, "height": 0.05})
        aligned2, conflicts2 = ui_tree._align_elements([a], [far])
        self.assertEqual(conflicts2, 2)  # L1 独有 + L2 独有各计 1
        self.assertEqual([e.source for e in aligned2], ["L1-tree", "L2-ocr"])

    def test_greedy_first_max_tie_break(self):
        # 两个等 IoU 候选 → 首达最大语义（保留更早的 j；严格 > 才更新）
        e1 = ui_tree.UIElement(source="L1-tree", role="text", name="",
                               rect={"x": 0.0, "y": 0.0, "width": 0.2, "height": 0.2})
        j0 = ui_tree.UIElement(source="L2-ocr", role="text", name="first",
                               rect={"x": 0.0, "y": 0.0, "width": 0.2, "height": 0.2})
        j1 = ui_tree.UIElement(source="L2-ocr", role="text", name="second",
                               rect={"x": 0.0, "y": 0.0, "width": 0.2, "height": 0.2})
        aligned, conflicts = ui_tree._align_elements([e1], [j0, j1])
        self.assertEqual(aligned[0].name, "first")  # IoU 并列 → 不更新（严格 >）
        self.assertEqual(conflicts, 1)  # 剩余 L2 独有

    def test_bucket_path_random_equivalence(self):
        # 70×75=5250 对 > 4096 → 桶剪枝路径；与直积扫参照逐元素等值
        for seed in (1, 2, 3):
            l1 = _rand_elements(70, seed)
            l2 = _rand_elements(75, seed + 100)
            new_a, new_c = ui_tree._align_elements(l1, l2)
            ref_a, ref_c = _ref_align_brute(l1, l2)
            self.assertEqual(new_c, ref_c, f"seed={seed}")
            self.assertEqual(_fingerprint(new_a), _fingerprint(ref_a), f"seed={seed}")

    def test_bucket_path_touching_grid_boundaries(self):
        # 恰在 1/16 网格线上相触/对齐的框（区间相触 IoU=0 的剪枝边界工况）
        grid_els = [
            ui_tree.UIElement(source="L1-tree", role="text", name=f"g{i}",
                              rect={"x": i * 0.0625, "y": 0.0, "width": 0.0625, "height": 1.0})
            for i in range(16)
        ]
        l2 = _rand_elements(75, 10)
        new_a, new_c = ui_tree._align_elements(grid_els, l2)  # 16×75=1200 ≤ 4096 直积
        ref_a, ref_c = _ref_align_brute(grid_els, l2)
        self.assertEqual((new_c, _fingerprint(new_a)), (ref_c, _fingerprint(ref_a)))
        # 强制桶路径：同一工况扩到 41×100=4100 对
        wide = grid_els + _rand_elements(25, 11)
        big_l2 = l2 + _rand_elements(25, 12)
        new_a, new_c = ui_tree._align_elements(wide, big_l2)
        ref_a, ref_c = _ref_align_brute(wide, big_l2)
        self.assertEqual(new_c, ref_c)
        self.assertEqual(_fingerprint(new_a), _fingerprint(ref_a))

    def test_bucket_path_fullscreen_frames_and_big_spread(self):
        # 全屏巨型框（跨全部 256 桶 → 候选退化为全积）+ 大面积重叠散布
        for seed, spread in ((6, 0.05), (7, 0.4)):
            rng = np.random.RandomState(seed)
            l1, l2 = _rand_elements(70, seed, spread=spread), _rand_elements(75, seed + 50, spread=spread)
            # 注入全屏框（5% 概率工况的确定性版本）
            l1.append(ui_tree.UIElement(source="L1-tree", role="window", name="full",
                                        rect={"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}))
            l2.append(ui_tree.UIElement(source="L2-ocr", role="text", name="FULL",
                                        rect={"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}))
            new_a, new_c = ui_tree._align_elements(l1, l2)
            ref_a, ref_c = _ref_align_brute(l1, l2)
            self.assertEqual(new_c, ref_c, f"seed={seed}")
            self.assertEqual(_fingerprint(new_a), _fingerprint(ref_a), f"seed={seed}")
            # 全屏框应与 FULL 匹配合并（IoU=1）
            self.assertIn(("L1-tree", "window", "FULL"), [(s, r, n) for s, r, n, _, _ in _fingerprint(new_a)])

    def test_zero_width_rect_no_match_no_crash(self):
        # 零宽/零高 rect：IoU≡0 → 不匹配、不抛（剪枝空区间工况）
        z = ui_tree.UIElement(source="L1-tree", role="text", name="z",
                              rect={"x": 0.5, "y": 0.5, "width": 0.0, "height": 0.2})
        o = ui_tree.UIElement(source="L2-ocr", role="text", name="o",
                              rect={"x": 0.5, "y": 0.5, "width": 0.2, "height": 0.2})
        aligned, conflicts = ui_tree._align_elements([z], [o])
        self.assertEqual(conflicts, 2)
        self.assertEqual([e.name for e in aligned], ["z", "o"])


class FunnelArbitrationPoolTests(unittest.TestCase):
    """ΝΩ-35：_align_elements 经 TREE_POOL 入池后的漏斗端到端（mock L1/L2）。"""

    def test_aligned_consensus_shortcircuits_l3(self):
        from unittest.mock import AsyncMock

        from dsh_physical.config import FunnelConfig

        funnel = ui_tree.UIFunnel(FunnelConfig(
            l1_backend="disabled", l2_backend="disabled", l3_backend="stub",
        ))
        rect = {"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.1}
        el1 = ui_tree.UIElement(source="L1-tree", role="button", name="", rect=dict(rect))
        el2 = ui_tree.UIElement(source="L2-ocr", role="text", name="OK", score=0.9, rect=dict(rect))
        funnel.l1.extract = AsyncMock(return_value=([el1], None))
        funnel.l2.extract = AsyncMock(return_value=([el2], None))

        res = asyncio.run(funnel.extract(b"png-bytes", None, "L3", SCREEN))
        # L1+L2 一致（冲突 0/2 < 20%）→ L3 不调用，深度 L2
        self.assertFalse(res.l3_invoked)
        self.assertEqual(res.funnel_depth, "L2")
        self.assertEqual(len(res.elements), 1)
        self.assertEqual(res.elements[0].name, "OK")


if __name__ == "__main__":
    unittest.main()
