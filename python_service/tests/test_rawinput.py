"""ΝΩ-53 Raw Input 输入镜像离线单测（零窗口线程启动 —— 纯结构/纯逻辑）。

覆盖面：
  1. RAWINPUT 合成字节解析（真实 Windows 内存布局按偏移手工打包 —— 与
     解析器的 format 串独立成双轨，偏移漂移即现形）；
  2. 镜像写读语义（相对位移累加 / 绝对映射 / clamp / 按键位图 / vk）；
  3. 并发压测（多写多读，y == 2x 不变量 + 计数守恒 —— Lock 正确性）；
  4. 陈旧回退逻辑（updated_at 距今 > max_stale_s ⇒ ok=False + 真实原因）；
  5. 事件环（容量 128 clamp + 时间窗过滤）；
  6. 生命周期离线路径（enabled=False ⇒ disabled no-op；read_position 诚实）；
  7. 默认关闭零回归（cursor_kind 无 position 键；/v1/cursor 响应形状不变）。

真机冒烟（SendInput 移动鼠标 ⇒ 镜像坐标变化）不在本文件 —— 交互桌面
依赖，按工单以脚本形态单独执行给数字。
"""
import ctypes
import struct
import sys
import threading
import time
import unittest
from pathlib import Path

_SVC_ROOT = str(Path(__file__).resolve().parents[1])
if _SVC_ROOT not in sys.path:
    sys.path.insert(0, _SVC_ROOT)

from dsh_physical import rawinput  # noqa: E402
from dsh_physical.config import AppConfig, RawInputConfig  # noqa: E402

# 真实 RAWINPUT 头部长度（x64 = 24 / x86 = 16）—— 测试与解析器各自计算
_BODY_OFF = 24 if ctypes.sizeof(ctypes.c_void_p) == 8 else 16


def _pack_mouse(dw_type: int = 0, us_flags: int = 0, button_flags: int = 0,
                button_data: int = 0, dx: int = 0, dy: int = 0) -> bytes:
    """按官方头文件偏移手工打包 RAWINPUT mouse 包（不经解析器 format 串）。"""
    blob = bytearray(_BODY_OFF + 24)
    struct.pack_into("<II", blob, 0, dw_type, len(blob))       # dwType/dwSize
    struct.pack_into("<HH", blob, _BODY_OFF, 0xBEEF, 0x1234)   # hDevice/wParam（任意）
    body = _BODY_OFF
    struct.pack_into("<H", blob, body + 0, us_flags)
    struct.pack_into("<H", blob, body + 4, button_flags)
    struct.pack_into("<H", blob, body + 6, button_data)
    struct.pack_into("<I", blob, body + 8, 0)                  # ulRawButtons
    struct.pack_into("<i", blob, body + 12, dx)                # lLastX
    struct.pack_into("<i", blob, body + 16, dy)                # lLastY
    struct.pack_into("<I", blob, body + 20, 0)                 # ulExtraInformation
    return bytes(blob)


def _pack_keyboard(vkey: int, message: int, make_code: int = 0x1E) -> bytes:
    """RAWINPUT keyboard 包（偏移：MakeCode@0 Flags@2 Reserved@4 VKey@6 Msg@8）。"""
    blob = bytearray(_BODY_OFF + 16)
    struct.pack_into("<II", blob, 0, 1, len(blob))             # RIM_TYPEKEYBOARD
    struct.pack_into("<H", blob, _BODY_OFF + 0, make_code)
    struct.pack_into("<H", blob, _BODY_OFF + 2, 0)
    struct.pack_into("<H", blob, _BODY_OFF + 4, 0)
    struct.pack_into("<H", blob, _BODY_OFF + 6, vkey)
    struct.pack_into("<I", blob, _BODY_OFF + 8, message)
    struct.pack_into("<I", blob, _BODY_OFF + 12, 0)
    return bytes(blob)


class ParseRawInputTests(unittest.TestCase):
    """合成字节 → 语义事件（永不抛；畸形包诚实 invalid）。"""

    def test_mouse_relative_move_with_button(self):
        blob = _pack_mouse(us_flags=0, button_flags=0x0001, button_data=0, dx=-40, dy=30)
        ev = rawinput.parse_raw_input(blob)
        self.assertEqual(ev["type"], "mouse")
        self.assertFalse(ev["absolute"])
        self.assertEqual(ev["dx"], -40)
        self.assertEqual(ev["dy"], 30)
        self.assertEqual(ev["button_flags"], 0x0001)  # RI_MOUSE_LEFT_BUTTON_DOWN

    def test_mouse_absolute_flag(self):
        blob = _pack_mouse(us_flags=0x0001, dx=32768, dy=100)
        ev = rawinput.parse_raw_input(blob)
        self.assertEqual(ev["type"], "mouse")
        self.assertTrue(ev["absolute"], "MOUSE_MOVE_ABSOLUTE 位必须被识别（RDP/平板）")

    def test_keyboard_down_up(self):
        ev = rawinput.parse_raw_input(_pack_keyboard(0x41, 0x0100))  # 'A' WM_KEYDOWN
        self.assertEqual(ev["type"], "keyboard")
        self.assertEqual(ev["vk"], 0x41)
        self.assertTrue(ev["down"])
        ev2 = rawinput.parse_raw_input(_pack_keyboard(0x41, 0x0101))  # WM_KEYUP
        self.assertFalse(ev2["down"])
        ev3 = rawinput.parse_raw_input(_pack_keyboard(0x1B, 0x0104))  # Esc WM_SYSKEYDOWN
        self.assertTrue(ev3["down"], "SYSKEYDOWN 也是按下")

    def test_hid_and_unknown_and_garbage(self):
        blob = bytearray(_BODY_OFF + 8)
        struct.pack_into("<II", blob, 0, 2, len(blob))  # RIM_TYPEHID
        self.assertEqual(rawinput.parse_raw_input(bytes(blob))["type"], "hid")
        bad = bytearray(_BODY_OFF + 24)
        struct.pack_into("<II", bad, 0, 99, 0)  # 未知 dwType
        self.assertEqual(rawinput.parse_raw_input(bytes(bad))["type"], "invalid")
        for garbage in (b"", b"\x01", b"\x00" * 7, b"\x00" * 12):
            self.assertEqual(rawinput.parse_raw_input(garbage)["type"], "invalid",
                             f"短包 {len(garbage)}B 必须诚实 invalid 而非抛错")
        # 声称 mouse 但体截断
        trunc = bytearray(_BODY_OFF + 10)
        struct.pack_into("<II", trunc, 0, 0, 0)
        self.assertEqual(rawinput.parse_raw_input(bytes(trunc))["type"], "invalid")


class MirrorSemanticsTests(unittest.TestCase):
    """镜像写读语义：累加 / 绝对映射 / clamp / 按键位图 / vk。"""

    def _mirror(self, cap: int = 128) -> rawinput.RawInputMirror:
        m = rawinput.RawInputMirror(ring_capacity=cap)
        m.set_virtual_bounds(0, 0, 10_000, 10_000)  # 离线拓扑（不依赖真实多屏）
        m.seed_position(500, 500)
        return m

    def test_relative_moves_accumulate(self):
        m = self._mirror()
        m.apply_mouse(rawinput.parse_raw_input(_pack_mouse(dx=100, dy=50)))
        m.apply_mouse(rawinput.parse_raw_input(_pack_mouse(dx=-30, dy=-20)))
        s = m.snapshot()
        self.assertEqual((s["x"], s["y"]), (570, 530))

    def test_absolute_move_maps_virtual_screen(self):
        m = self._mirror()
        m.set_virtual_bounds(100, 200, 1000, 500)
        # 0..65535 → 虚拟屏幕：x = 100 + 32768*1000//65535 = 600；
        # dy=65535（最大）映射 700 但 clamp 到最后一像素 699（vy0+vh-1）
        m.apply_mouse(rawinput.parse_raw_input(_pack_mouse(us_flags=0x0001, dx=32768, dy=65535)))
        s = m.snapshot()
        self.assertEqual(s["x"], 100 + 32768 * 1000 // 65535)
        self.assertEqual(s["y"], 699, "映射 700 → clamp 到 vy0+vh-1 = 699（屏内最后一像素）")

    def test_relative_move_clamped_to_virtual_screen(self):
        m = self._mirror()
        m.apply_mouse(rawinput.parse_raw_input(_pack_mouse(dx=999_999, dy=-999_999)))
        s = m.snapshot()
        self.assertEqual((s["x"], s["y"]), (9_999, 0), "越界位移 clamp 到虚拟屏矩形")

    def test_button_flags_and_vk(self):
        m = self._mirror()
        m.apply_mouse(rawinput.parse_raw_input(_pack_mouse(button_flags=0x0004)))  # 右键按下
        m.apply_keyboard(rawinput.parse_raw_input(_pack_keyboard(0x41, 0x0100)))
        s = m.snapshot()
        self.assertEqual(s["button_flags"], 0x0004)
        self.assertEqual(s["last_key_vk"], 0x41)

    def test_keyboard_does_not_refresh_position_freshness(self):
        m = self._mirror()
        m.seed_position(5, 5, now=time.time() - 10)  # 位置已陈旧（10s > 2s 门）
        m.apply_keyboard({"vk": 0x41, "down": True}, now=time.time())  # 键盘新鲜
        shot = m.read_position(2.0)
        self.assertFalse(shot["ok"],
                         "键盘事件不得刷新位置 updated_at（陈旧门只认鼠标事件）")
        self.assertTrue(shot["stale"])


class StaleFallbackTests(unittest.TestCase):
    """陈旧回退：updated_at 距今 > max_stale_s ⇒ ok=False + 诚实原因。"""

    def test_not_seeded(self):
        m = rawinput.RawInputMirror()
        shot = m.read_position(2.0)
        self.assertFalse(shot["ok"])
        self.assertIn("seeded", shot["reason"])

    def test_fresh_position_ok(self):
        m = rawinput.RawInputMirror()
        m.seed_position(10, 20)
        shot = m.read_position(2.0)
        self.assertTrue(shot["ok"])
        self.assertEqual((shot["x"], shot["y"]), (10, 20))
        self.assertLess(shot["age_s"], 2.0)

    def test_stale_position_falls_back_with_reason(self):
        m = rawinput.RawInputMirror()
        m.seed_position(10, 20, now=time.time() - 5.0)
        shot = m.read_position(2.0)
        self.assertFalse(shot["ok"], "陈旧 5s > 2s 门 ⇒ 必须判陈旧（回退轮询）")
        self.assertTrue(shot["stale"])
        self.assertEqual((shot["x"], shot["y"]), (10, 20), "陈旧也带回坐标（诊断面）")
        self.assertIn("stale", shot["reason"])

    def test_boundary_exactly_at_gate_is_ok(self):
        m = rawinput.RawInputMirror()
        m.seed_position(1, 1, now=time.time() - 1.9)
        self.assertTrue(m.read_position(2.0)["ok"], "1.9s < 2s 门内仍可用")


class EventRingTests(unittest.TestCase):
    """事件环：容量 clamp + 时间窗过滤（审计面只读）。"""

    def test_capacity_clamp(self):
        m = rawinput.RawInputMirror(ring_capacity=8)
        m.seed_position(0, 0)
        for _ in range(50):
            m.apply_mouse({"absolute": False, "dx": 1, "dy": 0, "button_flags": 0})
        self.assertEqual(m.stats()["ring_len"], 8, "环容量 8 ⇒ 只留最近 8 条")
        self.assertEqual(m.stats()["counts"]["mouse_move"], 50, "计数不受环淘汰影响")

    def test_window_filter(self):
        m = rawinput.RawInputMirror(ring_capacity=128)
        now = time.time()
        m.apply_mouse({"absolute": False, "dx": 1, "dy": 0, "button_flags": 0}, now=now - 5)
        m.apply_mouse({"absolute": False, "dx": 1, "dy": 0, "button_flags": 0}, now=now - 0.2)
        recent = m.recent_events(1.0)
        self.assertEqual(len(recent), 1, "窗口 1s：5s 前的淘汰、0.2s 前的保留")
        self.assertEqual(recent[0]["type"], "mouse_move")

    def test_returned_events_are_copies(self):
        m = rawinput.RawInputMirror(ring_capacity=4)
        m.seed_position(0, 0)
        m.apply_mouse({"absolute": False, "dx": 1, "dy": 0, "button_flags": 0x0001})
        ev = m.recent_events(10.0)[0]
        ev["x"] = 99999
        self.assertNotIn(99999, [e.get("x") for e in m.recent_events(10.0)],
                         "recent_events 必须返回拷贝（内部 deque 不外泄）")


class ConcurrencyStressTests(unittest.TestCase):
    """并发压测：多写多读下 Lock 不变量（y == 2x）+ 计数守恒。"""

    def test_concurrent_writers_readers_invariant(self):
        m = rawinput.RawInputMirror(ring_capacity=128)
        m.set_virtual_bounds(0, 0, 10**9, 10**9)  # 关闭 clamp 干扰（不变量纯化）
        m.seed_position(0, 0)
        writers, n_per_writer = 4, 2000
        errors: list[str] = []
        stop = threading.Event()

        def writer() -> None:
            for _ in range(n_per_writer):
                m.apply_mouse({"absolute": False, "dx": 1, "dy": 2, "button_flags": 0})

        def reader() -> None:
            while not stop.is_set():
                s = m.snapshot()
                if s["y"] != 2 * s["x"]:
                    errors.append(f"tom: x={s['x']} y={s['y']}（读写撕裂 = Lock 失效）")

        readers = [threading.Thread(target=reader) for _ in range(4)]
        wthreads = [threading.Thread(target=writer) for _ in range(writers)]
        for t in readers:
            t.start()
        for t in wthreads:
            t.start()
        for t in wthreads:
            t.join()
        stop.set()
        for t in readers:
            t.join()
        self.assertEqual(errors, [], "读侧不得观察到撕裂的 (x,y) 对")
        s = m.snapshot()
        self.assertEqual(s["x"], writers * n_per_writer)
        self.assertEqual(s["y"], 2 * writers * n_per_writer)
        self.assertEqual(m.stats()["counts"]["mouse_move"], writers * n_per_writer,
                         "计数守恒：无丢事件")


class LifecycleOfflineTests(unittest.TestCase):
    """离线生命周期：enabled=False ⇒ no-op；read_position 诚实形态。"""

    def test_disabled_config_is_noop(self):
        out = rawinput.ensure_started(RawInputConfig())  # enabled=False（默认）
        self.assertEqual(out["state"], "disabled")
        self.assertFalse(out["enabled"])
        self.assertFalse(out["thread_alive"], "默认关闭绝不 spawn 线程")

    def test_read_position_honest_when_disabled(self):
        rawinput.ensure_started(RawInputConfig())
        shot = rawinput.read_position(2.0)
        self.assertFalse(shot["ok"])
        self.assertIn("disabled", shot["reason"], "未开 ⇒ 原因如实（调用方回退轮询）")
        self.assertTrue(shot["stale"])

    def test_describe_never_raises(self):
        self.assertIsInstance(rawinput.describe(), dict)
        self.assertIsInstance(rawinput.stats(), dict)
        self.assertEqual(rawinput.recent_events(1.0), [], "未启动 ⇒ 空清单（不抛）")

    def test_shutdown_without_start_is_noop(self):
        rawinput.shutdown()  # 不得抛（未启动 = 无害 no-op）


class DefaultOffZeroRegressionTests(unittest.TestCase):
    """默认关闭零回归：cursor/routes 响应形状与旧版一致。"""

    def test_cursor_kind_no_position_key_when_disabled(self):
        from dsh_physical.cursor import cursor_kind

        rawinput.ensure_started(RawInputConfig())  # 保证 disabled 态（防测试序污染）
        result = cursor_kind()  # win32 真调用 GetCursorInfo（快、只读、零副作用）
        self.assertIsInstance(result, dict)
        self.assertIn(result.get("kind", "error"), {
            "arrow", "ibeam", "hand", "wait", "busy", "resize", "cross",
            "unavailable", "hidden", "custom", "error", "unsupported",
        })
        self.assertNotIn("position", result, "镜像关闭 ⇒ 不附加 position（形状不变）")
        self.assertNotIn("pt_screen_pos", result, "临时键必须被剥除")

    def test_cursor_position_public_helper(self):
        from dsh_physical.cursor import cursor_position

        out = cursor_position()
        self.assertIsInstance(out, dict)
        if sys.platform == "win32":
            self.assertIn("x", out)
            self.assertIn("y", out)
            self.assertNotEqual(out.get("source"), "raw-input-mirror", "镜像关闭不走镜像源")

    def test_input_events_endpoint_shape_when_disabled(self):
        import asyncio

        from dsh_physical import routes

        routes._controllers["config"] = AppConfig()  # raw_input 默认 disabled
        try:
            resp = asyncio.run(routes.input_events())
            self.assertEqual(resp["status"], "success")
            data = resp["data"]
            self.assertFalse(data["available"])
            self.assertEqual(data["state"], "disabled")
            self.assertEqual(data["events"], [])
            self.assertIn("counts", data)
            self.assertIn("absent", data["counts"], "未启动 ⇒ counts 诚实 absent（不谎报零计数）")
        finally:
            routes._controllers.pop("config", None)

    def test_cursor_endpoint_shape_unchanged_when_disabled(self):
        import asyncio

        try:
            import pyautogui  # noqa: F401
        except ImportError:
            self.skipTest("pyautogui absent — /v1/cursor fallback path needs it")

        from dsh_physical import routes

        routes._controllers["config"] = AppConfig()
        try:
            rawinput.ensure_started(RawInputConfig())
            resp = asyncio.run(routes.cursor())
            self.assertEqual(resp["status"], "success")
            self.assertEqual(set(resp["data"].keys()), {"x", "y"},
                             "镜像关闭 ⇒ 响应字段与旧版完全一致（零回归铁律）")
            self.assertIsInstance(resp["data"]["x"], float)
        finally:
            routes._controllers.pop("config", None)


if __name__ == "__main__":
    unittest.main()
