"""R5-2（D5 执法）：type_text 多行换行语义 —— 吞换行根因修复的离线单测。

零真实 GUI 依赖：SendInput 系统调用边界经可注入缝（``_type_unicode`` 的
``_sender``）与 ``ctypes.windll.user32.SendInput`` 桩双层拦截 —— 全路径
（InputController.type_text → _run_in_executor → _type_unicode）零物理键
注入，不占 GUI。事件流落盘为 canonical JSON 后逐字节比对黄金文件。

根因背景（批1 seed-report，R4-2 §4 D5）：KEYEVENTF_UNICODE 注 0x000A 合成
WM_CHAR '\\n'，Windows 编辑控件只认 '\\r'(0x0D) ⇒ 换行被吞、多行塌缩单行。
修法：\\r\\n/\\r/\\n 归一为真 VK_RETURN down/up 键事件（与用户手按 Enter
字节等价），其余码元保持 UNICODE 直注不变。
"""
import ctypes
import json
import sys
import unittest
from pathlib import Path

_SVC_ROOT = str(Path(__file__).resolve().parents[1])
if _SVC_ROOT not in sys.path:
    sys.path.insert(0, _SVC_ROOT)

import asyncio  # noqa: E402
import tempfile  # noqa: E402

from dsh_physical import input as dsh_input  # noqa: E402
from dsh_physical.config import ActionConfig  # noqa: E402

_WIN32 = sys.platform == "win32"


def _decode_events(n: int, arr, size: int) -> list[dict]:
    """把 SendInput 收到的 ctypes 事件数组解码为可序列化字典。"""
    out = []
    for i in range(n):
        ki = arr[i].u.ki
        out.append({
            "wVk": int(ki.wVk), "wScan": int(ki.wScan), "dwFlags": int(ki.dwFlags),
        })
    return out


class _RecordingSender:
    """SendInput 替身：返回注入数（全部成功），事件落 self.events。"""

    def __init__(self) -> None:
        self.events: list[dict] = []

    def __call__(self, n: int, arr, size: int) -> int:
        self.events = _decode_events(n, arr, size)
        return n


@unittest.skipUnless(_WIN32, "win32 SendInput 路径专属")
class TestNewlinePlan(unittest.TestCase):
    """_newline_plan：换行归一计划的原子级断言。"""

    def test_mixed_line_endings_collapse_to_single_enter(self) -> None:
        plan = dsh_input._newline_plan("a\r\nb\nc\rd")
        # a, ENTER, b, ENTER, c, ENTER, d —— \r\n 只记一次回车
        self.assertEqual(plan, [("uni", ord("a")), ("enter", 0), ("uni", ord("b")),
                                ("enter", 0), ("uni", ord("c")), ("enter", 0),
                                ("uni", ord("d"))])

    def test_surrogate_pair_splits_into_two_units(self) -> None:
        plan = dsh_input._newline_plan("\U0001F600")  # 😀 非 BMP
        self.assertEqual(plan, [("uni", 0xD83D), ("uni", 0xDE00)])

    def test_plain_text_all_unicode_atoms(self) -> None:
        plan = dsh_input._newline_plan("hello")
        self.assertEqual(plan, [("uni", ord(c)) for c in "hello"])

    def test_empty(self) -> None:
        self.assertEqual(dsh_input._newline_plan(""), [])


@unittest.skipUnless(_WIN32, "win32 SendInput 路径专属")
class TestTypeUnicodeEvents(unittest.TestCase):
    """_type_unicode：事件流字节形状 —— 换行 = 真 VK_RETURN 对，其余 = VK_PACKET 对。"""

    def test_newline_becomes_real_enter_keyevent(self) -> None:
        sent = _RecordingSender()
        ret = dsh_input._type_unicode("A\nB", _sender=sent)
        self.assertEqual(ret, 6)  # 3 原子 × down+up
        ev = sent.events
        self.assertEqual(len(ev), 6)
        # 'A'：VK_PACKET（wVk=0 + KEYEVENTF_UNICODE）
        self.assertEqual((ev[0]["wVk"], ev[0]["wScan"], ev[0]["dwFlags"]), (0, ord("A"), 0x0004))
        self.assertEqual((ev[1]["wVk"], ev[1]["wScan"], ev[1]["dwFlags"]), (0, ord("A"), 0x0004 | 0x0002))
        # '\n'：真回车（wVk=VK_RETURN=0x0D，无 UNICODE 标志）
        self.assertEqual((ev[2]["wVk"], ev[2]["wScan"], ev[2]["dwFlags"]), (0x0D, 0, 0))
        self.assertEqual((ev[3]["wVk"], ev[3]["wScan"], ev[3]["dwFlags"]), (0x0D, 0, 0x0002))
        # 'B'
        self.assertEqual((ev[4]["wVk"], ev[4]["wScan"], ev[4]["dwFlags"]), (0, ord("B"), 0x0004))

    def test_crlf_counts_single_enter(self) -> None:
        sent = _RecordingSender()
        ret = dsh_input._type_unicode("a\r\nb", _sender=sent)
        self.assertEqual(ret, 6)  # a, ENTER, b —— \r\n 不重复
        enter_events = [e for e in sent.events if e["wVk"] == 0x0D]
        self.assertEqual(len(enter_events), 2)  # 一对 down/up

    def test_no_lf_scan_code_leaks_through(self) -> None:
        """D5 回归钉：任何事件不得再以 UNICODE 0x000A/0x000D 注入换行。"""
        sent = _RecordingSender()
        dsh_input._type_unicode("x\r\ny\nz\ry", _sender=sent)
        leaked = [e for e in sent.events if e["wVk"] == 0 and e["wScan"] in (0x0A, 0x0D)]
        self.assertEqual(leaked, [], "换行必须以 VK_RETURN 键事件注入，不得走 VK_PACKET 0x0A/0x0D")

    def test_event_stream_lands_on_disk_byte_exact(self) -> None:
        """落盘逐字节比对：canonical JSON 与黄金串逐字节相等。"""
        sent = _RecordingSender()
        dsh_input._type_unicode("line1\r\nline2\nline3\rline4", _sender=sent)
        canonical = json.dumps(sent.events, separators=(",", ":"), sort_keys=False)
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8",
        ) as f:
            f.write(canonical)
            path = f.name
        try:
            landed = Path(path).read_bytes()
            self.assertEqual(landed, canonical.encode("utf-8"))
        finally:
            Path(path).unlink(missing_ok=True)
        # 换行原子计数：\r\n + \n + \r = 3 对 VK_RETURN
        self.assertEqual(len([e for e in sent.events if e["wVk"] == 0x0D]), 6)


@unittest.skipUnless(_WIN32, "win32 SendInput 路径专属")
class TestControllerFullPath(unittest.TestCase):
    """InputController.type_text 全路径（SendInput 桩在系统调用边界拦截）。

    零物理注入：monkeypatch ctypes.windll.user32.SendInput —— _type_unicode
    在调用时惰性读取该属性（R5-2 可注入缝的兼容面），桩后全路径不触真实键。
    """

    def test_multiline_full_path_no_throw_and_accounting_consistent(self) -> None:
        user32 = ctypes.windll.user32
        sent = _RecordingSender()
        original = user32.SendInput
        user32.SendInput = sent  # type: ignore[method-assign]
        try:
            ctrl = dsh_input.InputController(ActionConfig())
            text = "ROW-1\nROW-2\r\nROW-3\rROW-4"
            out = asyncio.run(ctrl.type_text(text))
            self.assertEqual(out["typed_chars"], len(text))
            # 对账一致：expected = 原子数 × 2，桩返回全成功 ⇒ 不抛
            expected_events = len(dsh_input._newline_plan(text)) * 2
            self.assertEqual(len(sent.events), expected_events)
        finally:
            user32.SendInput = original  # type: ignore[method-assign]

    def test_partial_send_raises_physical_error(self) -> None:
        """SendInput 部分成功（返回数不足）⇒ 诚实失败（不静默截断输入）。"""

        def short_sender(n: int, arr, size: int) -> int:
            return n - 2  # 差一对

        user32 = ctypes.windll.user32
        original = user32.SendInput
        user32.SendInput = short_sender  # type: ignore[method-assign]
        try:
            from dsh_physical.errors import PhysicalError
            ctrl = dsh_input.InputController(ActionConfig())
            with self.assertRaises(PhysicalError) as ctx:
                asyncio.run(ctrl.type_text("ab\ncd"))
            self.assertIn("incomplete", str(ctx.exception.detail))
        finally:
            user32.SendInput = original  # type: ignore[method-assign]

    def test_dry_run_returns_char_count_without_events(self) -> None:
        ctrl = dsh_input.InputController(ActionConfig())
        out = asyncio.run(ctrl.type_text("a\nb", dry_run=True))
        self.assertEqual(out, {"typed_chars": 3})


if __name__ == "__main__":
    unittest.main()
