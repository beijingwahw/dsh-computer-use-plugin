"""R2-3（焦点保卫）：WindowManager.active_window 前台窗口只读探测离线单测。

零真实 GUI 依赖：win32 路径经 ``_active_title_win32`` 打桩（unittest.mock
patch.object）；其余断言走 backend 解析与错误信封 —— 与 test_errors.py 同款
asyncio.run 驱动，零网络/零 HTTP 框架。
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

# ΑΩ-R32 同律：discover 以本目录为 top-level，注入 python_service/
_SVC_ROOT = str(Path(__file__).resolve().parents[1])
if _SVC_ROOT not in sys.path:
    sys.path.insert(0, _SVC_ROOT)

import asyncio  # noqa: E402

from dsh_physical.config import WindowConfig  # noqa: E402
from dsh_physical.errors import ErrorKind, PhysicalError  # noqa: E402
from dsh_physical.window import WindowManager  # noqa: E402


class _FakeWin:
    """pygetwindow.getActiveWindow 的替身 —— 只需要 .title。"""

    def __init__(self, title: str | None) -> None:
        self.title = title


class ActiveWindowTests(unittest.TestCase):
    """active_window：平台分治 + 诚实缺席（title=None / WINDOW_UNAVAILABLE）。"""

    def test_win32_backend_resolution_auto(self):
        # auto 在 win32 解析为 pygetwindow（Linux CI 上解析为 wmctrl —— 断言非空）
        mgr = WindowManager(WindowConfig(backend="auto"))
        self.assertIn(mgr._backend, {"pygetwindow", "wmctrl", "osascript", "hotkey-only"})

    def test_active_window_returns_title(self):
        mgr = WindowManager(WindowConfig(backend="pygetwindow"))
        with mock.patch.object(
            WindowManager, "_active_title_win32", return_value="DeepSeek Harness"
        ):
            out = asyncio.run(mgr.active_window())
        self.assertEqual(out, {"method": "native", "title": "DeepSeek Harness"})

    def test_active_window_none_title_when_no_foreground(self):
        # 无前台窗口可读 ⇒ title=None（诚实缺席，不猜）
        mgr = WindowManager(WindowConfig(backend="pygetwindow"))
        with mock.patch.object(WindowManager, "_active_title_win32", return_value=None):
            out = asyncio.run(mgr.active_window())
        self.assertEqual(out, {"method": "native", "title": None})

    def test_active_window_blank_title_becomes_none(self):
        # 空白标题（桌面焦点等）归一为 None —— _active_title_win32 自身的纪律；
        # 直接驱动真实现（sys.modules 替身注入假 pygetwindow，import 取到替身）
        mgr = WindowManager(WindowConfig(backend="pygetwindow"))
        fake_blank = type("M", (), {"getActiveWindow": staticmethod(lambda: _FakeWin("   "))})
        with mock.patch.dict(sys.modules, {"pygetwindow": fake_blank}):
            self.assertIsNone(mgr._active_title_win32())
        fake_none = type("M", (), {"getActiveWindow": staticmethod(lambda: None)})
        with mock.patch.dict(sys.modules, {"pygetwindow": fake_none}):
            self.assertIsNone(mgr._active_title_win32())
        fake_real = type("M", (), {"getActiveWindow": staticmethod(lambda: _FakeWin("记事本 - Notepad"))})
        with mock.patch.dict(sys.modules, {"pygetwindow": fake_real}):
            self.assertEqual(mgr._active_title_win32(), "记事本 - Notepad")

    def test_hotkey_only_backend_honest_unavailable(self):
        # hotkey-only 读不了焦点 ⇒ WINDOW_UNAVAILABLE（Node 侧按通道缺席降级）
        mgr = WindowManager(WindowConfig(backend="hotkey-only"))
        with self.assertRaises(PhysicalError) as ctx:
            asyncio.run(mgr.active_window())
        self.assertEqual(ctx.exception.kind, ErrorKind.WINDOW_UNAVAILABLE)

    def test_disabled_backend_honest_unavailable(self):
        mgr = WindowManager(WindowConfig(backend="disabled"))
        with self.assertRaises(PhysicalError) as ctx:
            asyncio.run(mgr.active_window())
        self.assertEqual(ctx.exception.kind, ErrorKind.WINDOW_UNAVAILABLE)

    def test_fallback_latch_treated_as_unavailable(self):
        # ΝΩ-9 latch 期内原生缺席 ⇒ 同 hotkey-only 的诚实不可用（不发半截能力）
        mgr = WindowManager(WindowConfig(backend="pygetwindow"))
        mgr._latch_fallback()
        with self.assertRaises(PhysicalError) as ctx:
            asyncio.run(mgr.active_window())
        self.assertEqual(ctx.exception.kind, ErrorKind.WINDOW_UNAVAILABLE)


if __name__ == "__main__":
    unittest.main()
