"""ΝΩ-52 scrcpy 控制通道复用 —— 离线单测(零真设备/零真 adb/零真 scrcpy)。

三层契约:
  1. 编码器字节级手算断言 —— 期望向量与 scrcpy 自带
     ``app/tests/test_control_msg_serialize.c`` 对齐(线格式的官方单测
     即文档);2.x/3.x 滚动方言按 framing_profile 同律分叉。
  2. ControlWriter 生命周期 —— 假 socket 捕获字节;写失败 ⇒ 病亡+关闭+
     如实报败(运行层绝不抛);send_sequence 原子性 + rescue 清场。
  3. AndroidController 降级链 —— 控制命中(adb 零触碰)/ 写失败降级
     (adb 被调 + 回执无 channel)/ 无流时回执与 argv 逐字节旧(零回归)。
"""
import io
import itertools
import queue as _queue
import struct
import sys
import threading
import time
import unittest
from pathlib import Path

# ΑΩ-R32 同律:discover 以本目录为 top-level,注入 python_service/
_SVC_ROOT = str(Path(__file__).resolve().parents[1])
if _SVC_ROOT not in sys.path:
    sys.path.insert(0, _SVC_ROOT)

from PIL import Image  # noqa: E402

from dsh_physical.android import AndroidController  # noqa: E402
from dsh_physical.config import AndroidConfig  # noqa: E402
from dsh_physical.scrcpyStream import (  # noqa: E402
    ACTION_DOWN,
    ACTION_MOVE,
    ACTION_UP,
    POINTER_ID_GENERIC_FINGER,
    StreamConfig,
    StreamHub,
    ControlWriter,
    encode_back_or_screen_on,
    encode_keycode,
    encode_scroll,
    encode_touch,
    float_to_i16fp,
    float_to_u16fp,
    scroll_ticks_per_message,
)


# ─── 编码器:字节级手算(scrcpy 官方单测向量对齐)───


class EncoderByteTests(unittest.TestCase):
    """手算字节向量 —— 与 scrcpy test_control_msg_serialize.c 的期望逐字节对齐。"""

    def test_inject_keycode_scrcpy_vector(self):
        # scrcpy 官方向言:action=UP(1) keycode=66(ENTER) repeat=5 metastate=65
        b = encode_keycode(ACTION_UP, 66, 5, 65)
        self.assertEqual(
            b.hex(), "0001" "00000042" "00000005" "00000041",
        )
        self.assertEqual(len(b), 14)

    def test_inject_keycode_defaults(self):
        # 缺省 repeat=0 metastate=0(动作面只注入 down/up)
        self.assertEqual(encode_keycode(ACTION_DOWN, 4).hex(), "00" + "00" + "00000004" + "00000000" + "00000000")

    def test_touch_scrcpy_vector(self):
        # 官方向言:pointer=0x1234567887654321 (100,200) 屏 1080x1920
        # pressure=1.0 action_button=1 buttons=1 → 32B
        b = encode_touch(ACTION_DOWN, 0x1234567887654321, 100, 200, 1080, 1920,
                         pressure=1.0, action_button=1, buttons=1)
        self.assertEqual(
            b.hex(),
            "0200" "1234567887654321" "00000064" "000000c8"
            "0438" "0780" "ffff" "00000001" "00000001",
        )
        self.assertEqual(len(b), 32)

    def test_touch_pointer_id_negative_finger_is_u64_wrapped(self):
        # GENERIC_FINGER=-2 按有符号 u64 编码(截断二补码)—— 与 scrcpy 客户端同律
        b = encode_touch(ACTION_DOWN, POINTER_ID_GENERIC_FINGER, 0, 0, 32, 48)
        self.assertEqual(b[2:10].hex(), "fffffffffffffffe")
        # down 压力 1.0 / up 压力 0.0(scrcpy 手势惯例:按下有压,抬起无压)
        self.assertEqual(b[22:24].hex(), "ffff")
        up = encode_touch(ACTION_UP, POINTER_ID_GENERIC_FINGER, 0, 0, 32, 48, pressure=0.0)
        self.assertEqual(up[22:24].hex(), "0000")
        self.assertEqual(up[1], ACTION_UP)

    def test_scroll_scrcpy_vector_2x(self):
        # 官方向言:(260,1026) 屏 1080x1920 hscroll=1 vscroll=-1 buttons=1 → 21B
        b = encode_scroll(260, 1026, 1080, 1920, hticks=1.0, vticks=-1.0, buttons=1, profile="2x")
        self.assertEqual(
            b.hex(),
            "03" "00000104" "00000402" "0438" "0780" "7fff" "8000" "00000001",
        )
        self.assertEqual(len(b), 21)

    def test_scroll_dialect_4x_divides_by_16(self):
        # 3.x server 把 i16fp 值 ×16 还原 ⇒ 1 tick 编码为 1/16 → 0x0800
        b = encode_scroll(16, 24, 32, 48, vticks=1.0, profile="4x")
        self.assertEqual(b[13:15].hex(), "0000")  # htick=0
        self.assertEqual(b[15:17].hex(), "0800")  # vtick=1 → 2048
        self.assertEqual(scroll_ticks_per_message("2x"), 1)
        self.assertEqual(scroll_ticks_per_message("4x"), 16)

    def test_back_or_screen_on_two_bytes(self):
        self.assertEqual(encode_back_or_screen_on(ACTION_DOWN).hex(), "0400")
        self.assertEqual(encode_back_or_screen_on(ACTION_UP).hex(), "0401")

    def test_encoders_deterministic(self):
        args = (ACTION_MOVE, -2, 10, 20, 32, 48)
        self.assertEqual(encode_touch(*args), encode_touch(*args))


class FixedPointTests(unittest.TestCase):
    """定点换算与 scrcpy ``sc_float_to_u16fp`` / ``sc_float_to_i16fp`` 同律。"""

    def test_u16fp(self):
        self.assertEqual(float_to_u16fp(1.0), 0xFFFF)   # 满幅特判(server 解码为精确 1.0)
        self.assertEqual(float_to_u16fp(0.0), 0)
        self.assertEqual(float_to_u16fp(0.5), 0x8000)   # 32768
        self.assertEqual(float_to_u16fp(0.25), 0x4000)
        self.assertEqual(float_to_u16fp(-0.1), 0)       # 负压钳 0
        self.assertEqual(float_to_u16fp(2.0), 0xFFFF)   # 越界钳满幅
        self.assertEqual(float_to_u16fp(0.9999), int(0.9999 * 65536))  # 向零截断

    def test_i16fp(self):
        self.assertEqual(float_to_i16fp(1.0), 0x7FFF)
        self.assertEqual(float_to_i16fp(-1.0), -0x8000)
        self.assertEqual(float_to_i16fp(0.5), 0x4000)
        self.assertEqual(float_to_i16fp(-0.5), -0x4000)
        self.assertEqual(float_to_i16fp(1.0 / 16), 0x0800)  # 3.x 方言 1 tick
        self.assertEqual(float_to_i16fp(0.9999), int(0.9999 * 32768))  # 截断不进位


# ─── ControlWriter:假 socket 生命周期 ───


class FakeControlSock:
    """假控制 socket:sendall 捕获字节;fail_at(第 n 次调用,0 起)抛 OSError。"""

    def __init__(self, fail_at=()):
        self.sent: list[bytes] = []
        self.timeouts: list = []
        self.closed = 0
        self._closed = False
        self.fail_at = set(fail_at)
        self._n = 0

    def settimeout(self, t):
        self.timeouts.append(t)

    def sendall(self, b):
        if self._n in self.fail_at:
            self._n += 1
            raise OSError(f"stub send failure #{self._n - 1}")
        self._n += 1
        self.sent.append(bytes(b))

    def close(self):
        if self._closed:
            return          # 与真 socket 同律:close 幂等
        self._closed = True
        self.closed += 1

    @property
    def joined(self) -> bytes:
        return b"".join(self.sent)


class ControlWriterTests(unittest.TestCase):

    def test_send_ok_sets_timeout_and_records(self):
        s = FakeControlSock()
        w = ControlWriter(s, "2x", send_timeout_s=0.5)
        self.assertTrue(w.alive)
        self.assertEqual(s.timeouts, [0.5])
        self.assertTrue(w.send(b"\x02"))
        self.assertTrue(w.send(b"\x03"))
        self.assertEqual(s.sent, [b"\x02", b"\x03"])
        self.assertEqual(w.sent_count, 2)

    def test_send_failure_kills_channel_no_raise(self):
        s = FakeControlSock(fail_at={0})
        w = ControlWriter(s)
        self.assertFalse(w.send(b"\x02"))          # 不抛,如实报败
        self.assertFalse(w.alive)
        self.assertEqual(s.closed, 1)              # 病亡即关闭
        self.assertEqual(s.sent, [])
        self.assertFalse(w.send(b"\x02"))          # 死通道恒 False
        self.assertTrue("control send failed" in (w.last_error or ""))

    def test_send_sequence_atomic_and_inter_sleep(self):
        s = FakeControlSock()
        w = ControlWriter(s)
        t0 = time.monotonic()
        self.assertTrue(w.send_sequence([b"a", b"b", b"c"], inter_s=0.05))
        self.assertGreaterEqual(time.monotonic() - t0, 0.1)  # 2 个间隔
        self.assertEqual(s.sent, [b"a", b"b", b"c"])

    def test_send_sequence_first_failure_no_injection_no_rescue(self):
        s = FakeControlSock(fail_at={0})
        w = ControlWriter(s)
        self.assertFalse(w.send_sequence([b"down", b"up"], rescue=b"up"))
        self.assertEqual(s.sent, [])   # 首条即败:零字节注入,调用方可无痕降级
        self.assertFalse(w.alive)

    def test_send_sequence_mid_failure_sends_rescue_then_dies(self):
        s = FakeControlSock(fail_at={1})
        w = ControlWriter(s)
        self.assertFalse(w.send_sequence([b"down", b"move", b"up"], rescue=b"UP-RESCUE"))
        self.assertEqual(s.sent, [b"down", b"UP-RESCUE"])  # 孤儿 down 清场补发
        self.assertFalse(w.alive)
        self.assertEqual(s.closed, 1)

    def test_empty_sequence_is_true(self):
        w = ControlWriter(FakeControlSock())
        self.assertTrue(w.send_sequence([]))

    def test_close_idempotent(self):
        s = FakeControlSock()
        w = ControlWriter(s)
        w.close()
        w.close()
        self.assertEqual(s.closed, 1)
        self.assertFalse(w.alive)

    def test_none_socket_born_dead(self):
        w = ControlWriter(None)
        self.assertFalse(w.alive)
        self.assertFalse(w.send(b"\x00"))


# ─── 集成:控制命中 / 写失败降级 / 零回归 ───


class _ControlCapableSource:
    """假字节源(真 socket 阻塞语义)+ 可选控制 socket 移交。"""

    def __init__(self, spawner: "_ControlCapableSpawner") -> None:
        self._q: _queue.Queue = _queue.Queue()
        self.closed = threading.Event()
        self._spawner = spawner
        self.control: FakeControlSock | None = None
        self._control_taken = False

    def push(self, data: bytes) -> None:
        self._q.put(data)

    def read(self, n: int) -> bytes:
        while True:
            if self.closed.is_set():
                return b""
            try:
                return self._q.get(timeout=0.02)
            except _queue.Empty:
                continue

    def take_control_socket(self):
        sock = self.control if not self._control_taken else None
        self._control_taken = True
        return sock

    def close(self) -> None:
        if not self.closed.is_set():
            self.closed.set()
            self._spawner.closes += 1
        if self.control is not None:
            self.control.close()  # 与 AdbTunnelByteSource 同律:随流同葬兜底


class _ControlCapableSpawner:
    """假 spawner:合成 v2x 流(自动首帧 32x48)+ 每源挂一枚假控制 socket。"""

    def __init__(self) -> None:
        self.opens = 0
        self.closes = 0
        self.sources: list[_ControlCapableSource] = []
        self._seeds = itertools.count(1000)

    def open(self, serial: str) -> _ControlCapableSource:
        self.opens += 1
        src = _ControlCapableSource(self)
        src.control = FakeControlSock()
        self.sources.append(src)
        payload = struct.pack(">IIQ", 32, 48, next(self._seeds))
        u64 = (1 << 62) | 1000
        src.push(b"\x00" + b"h264" + struct.pack(">II", 32, 48)
                 + struct.pack(">QI", u64, len(payload)) + payload)
        return src

    __call__ = open

    @property
    def last_control(self) -> FakeControlSock:
        return self.sources[-1].control


def _fake_decoder():
    class FakeDecoder:
        name = "fake"

        def __init__(self):
            self._closed = False

        def feed(self, data):
            if self._closed:
                return []
            w, h, seed = struct.unpack(">IIQ", data)
            img = Image.new("L", (w, h))
            img.putdata([((x // 4 * 31 + y // 4 * 17 + seed * 29) % 256)
                         for y in range(h) for x in range(w)])
            return [img.convert("RGB")]

        def close(self):
            self._closed = True

    return FakeDecoder


def _mk_runner(calls: list):
    """桩 runner:wm size 报 1080x1920;scrcpy 2.7.1;其余记录返回成功。"""

    def runner(argv, timeout_s=15.0, cwd=None):
        calls.append(list(argv))
        if "--version" in argv:
            return 0, b"scrcpy 2.7.1\n", b""
        if "wm" in argv:
            return 0, b"Physical size: 1080x1920\n", b""
        return 0, b"", b""

    return runner


def _mk_controller(calls: list, spawner: _ControlCapableSpawner) -> AndroidController:
    return AndroidController(
        AndroidConfig(),
        runner=_mk_runner(calls),
        stream_cfg=StreamConfig(enabled=True, first_frame_timeout_s=2.0),
        stream_spawner=spawner,
        stream_decoder_factory=_fake_decoder(),
    )


def _adb_input_calls(calls: list) -> list:
    return [c for c in calls if "input" in c]


def _parse_touch(b: bytes) -> dict:
    return {
        "type": b[0], "action": b[1],
        "pointer_id": int.from_bytes(b[2:10], "big", signed=True),
        "x": int.from_bytes(b[10:14], "big"),
        "y": int.from_bytes(b[14:18], "big"),
        "screen_w": int.from_bytes(b[18:20], "big"),
        "screen_h": int.from_bytes(b[20:22], "big"),
        "pressure": b[22:24].hex(),
    }


class ControllerControlPathTests(unittest.TestCase):
    """有活跃流 ⇒ 动作走控制通道(adb 零触碰);回执申报 channel。"""

    def setUp(self):
        self.calls: list = []
        self.spawner = _ControlCapableSpawner()
        self.ctrl = _mk_controller(self.calls, self.spawner)
        img, note = self.ctrl.grab_frame("emu1")   # 惰性激活流(视频 32x48)
        assert img is not None and note and "resident" in note

    def tearDown(self):
        self.ctrl.close()

    def test_tap_via_control_channel(self):
        receipt = self.ctrl.tap("emu1", 0.25, 0.5)
        self.assertEqual(receipt["channel"], "scrcpy_control")
        self.assertEqual(_adb_input_calls(self.calls), [])          # adb 零触碰
        sock = self.spawner.last_control
        self.assertEqual(len(sock.sent), 2)                        # down + up
        down, up = map(_parse_touch, sock.sent)
        self.assertEqual(down["action"], ACTION_DOWN and 0)
        self.assertEqual(up["action"], 1)
        self.assertEqual(down["pointer_id"], POINTER_ID_GENERIC_FINGER)
        self.assertEqual((down["x"], down["y"]), (8, 24))          # 视频坐标系 32x48
        self.assertEqual((down["screen_w"], down["screen_h"]), (32, 48))
        self.assertEqual(down["pressure"], "ffff")
        self.assertEqual(up["pressure"], "0000")
        self.assertEqual(up["x"], 8)
        # 设备像素回执仍以 wm size 为锚(契约不变,只是新申报 channel)
        self.assertEqual(receipt["pixel"], {"x": 270, "y": 960})
        self.assertEqual(receipt["screen"], {"width": 1080, "height": 1920})

    def test_tap_right_is_long_press_sequence(self):
        self.ctrl.tap("emu1", 0.5, 0.5, button="right")
        sock = self.spawner.last_control
        self.assertEqual(len(sock.sent), 2)
        self.assertEqual(sock.sent[0][1], 0)
        self.assertEqual(sock.sent[1][1], 1)
        self.assertEqual(receipt_mode := self.ctrl.tap("emu1", 0.5, 0.5, button="right", dry_run=True)["mode"], "long_press")

    def test_drag_via_control_down_move_up(self):
        receipt = self.ctrl.drag("emu1", {"x": 0.1, "y": 0.2}, {"x": 0.9, "y": 0.8},
                                 duration_ms=300)
        self.assertEqual(receipt["channel"], "scrcpy_control")
        self.assertEqual(_adb_input_calls(self.calls), [])
        sock = self.spawner.last_control
        actions = [b[1] for b in sock.sent]
        self.assertEqual(actions[0], ACTION_DOWN)
        self.assertEqual(actions[-1], ACTION_UP)
        self.assertEqual(actions[1:-1], [ACTION_MOVE] * 12)        # 300ms/25ms = 12 步
        first, last = _parse_touch(sock.sent[0]), _parse_touch(sock.sent[-1])
        self.assertEqual((first["x"], first["y"]), (3, 10))        # round(0.1*32), round(0.2*48)
        self.assertEqual((last["x"], last["y"]), (29, 38))

    def test_scroll_via_control_chunks_per_dialect(self):
        receipt = self.ctrl.scroll("emu1", "down", 3)
        self.assertEqual(receipt["channel"], "scrcpy_control")
        self.assertEqual(_adb_input_calls(self.calls), [])
        sock = self.spawner.last_control
        self.assertEqual(len(sock.sent), 3)                        # 2x: 1 tick/条 ×3
        for msg in sock.sent:
            self.assertEqual(msg[0], 3)
            self.assertEqual(msg[1:5].hex(), "00000010")          # 屏心 x=16(视频 32)
            self.assertEqual(msg[5:9].hex(), "00000018")          # 屏心 y=24(视频 48)
            self.assertEqual(msg[15:17].hex(), "7fff")             # vscroll = +1 tick
        self.ctrl.scroll("emu1", "up", 1)
        self.assertEqual(self.spawner.last_control.sent[-1][15:17].hex(), "8000")  # 反向

    def test_key_via_control_keycode_down_up(self):
        receipt = self.ctrl.key("emu1", ["enter"])
        self.assertEqual(receipt["channel"], "scrcpy_control")
        self.assertEqual(_adb_input_calls(self.calls), [])
        sock = self.spawner.last_control
        self.assertEqual([b.hex() for b in sock.sent],
                         ["00" + "00" + "00000042" + "00000000" + "00000000",
                          "00" + "01" + "00000042" + "00000000" + "00000000"])

    def test_type_text_stays_adb(self):
        # 工单范围:文本注入不迁移(INJECT_TEXT 另行工单);控制在场也走 adb
        self.ctrl.type_text("emu1", "hi")
        self.assertTrue(any("text" in c for c in _adb_input_calls(self.calls)))
        self.assertEqual(self.spawner.last_control.sent, [])


class ControllerFallbackTests(unittest.TestCase):
    """写失败 ⇒ 通道病亡降级 adb;无流 ⇒ 路径与回执逐字节旧(零回归)。"""

    def setUp(self):
        self.calls: list = []
        self.spawner = _ControlCapableSpawner()
        self.ctrl = _mk_controller(self.calls, self.spawner)
        self.ctrl.grab_frame("emu1")

    def tearDown(self):
        self.ctrl.close()

    def test_write_failure_falls_back_to_adb(self):
        sock = self.spawner.last_control
        sock.fail_at = {0}                                          # 首条即败
        receipt = self.ctrl.tap("emu1", 0.5, 0.5)
        self.assertNotIn("channel", receipt)                        # 回执无新字段
        adb_calls = _adb_input_calls(self.calls)
        self.assertEqual(len(adb_calls), 1)                         # adb 恰好补位一次
        self.assertEqual(adb_calls[0][adb_calls[0].index("input"):],
                         ["input", "tap", "540", "960"])
        # 通道病亡记忆:死通道不复活(hub 返回 None ⇒ 后续动作恒 adb)
        self.assertIsNone(self.ctrl._stream_hub.control_writer("emu1"))

    def test_dead_channel_memory_no_flapping(self):
        sock = self.spawner.last_control
        sock.fail_at = {0}
        self.ctrl.tap("emu1", 0.5, 0.5)                             # 第一次:降级
        n_input = len(_adb_input_calls(self.calls))
        self.ctrl.tap("emu1", 0.5, 0.5)                             # 第二次:仍 adb(死通道不复活)
        self.assertEqual(len(_adb_input_calls(self.calls)), n_input + 1)

    def test_stopped_stream_degrades_to_adb(self):
        self.ctrl._stream_hub.close()                               # 流全停
        receipt = self.ctrl.tap("emu1", 0.5, 0.5)
        self.assertNotIn("channel", receipt)
        self.assertEqual(len(_adb_input_calls(self.calls)), 1)

    def test_dry_run_touches_neither_channel(self):
        self.ctrl.tap("emu1", 0.5, 0.5, dry_run=True)
        self.assertEqual(self.spawner.last_control.sent, [])
        self.assertEqual(_adb_input_calls(self.calls), [])


class ControllerZeroRegressionTests(unittest.TestCase):
    """无流(缺省)⇒ argv 与回执与 W4-5 逐字节相同 —— 零回归铁律的离线证明。"""

    def _legacy(self, method: str, *args, **kwargs):
        calls: list = []
        ctrl = AndroidController(AndroidConfig(), runner=_mk_runner(calls))
        try:
            result = getattr(ctrl, method)("emu1", *args, **kwargs)
        finally:
            ctrl.close()
        return calls, result

    def _modern_disabled(self, method: str, *args, **kwargs):
        calls: list = []
        spawner = _ControlCapableSpawner()
        ctrl = AndroidController(
            AndroidConfig(), runner=_mk_runner(calls),
            stream_cfg=StreamConfig(enabled=False),                 # 流缺省关
            stream_spawner=spawner, stream_decoder_factory=_fake_decoder(),
        )
        try:
            result = getattr(ctrl, method)("emu1", *args, **kwargs)
        finally:
            ctrl.close()
        return calls, result

    def test_tap_receipt_and_argv_byte_identical(self):
        lc, lr = self._legacy("tap", 0.5, 0.5)
        mc, mr = self._modern_disabled("tap", 0.5, 0.5)
        self.assertEqual(lr, mr)
        self.assertEqual(lc, mc)
        self.assertIn(["input", "tap", "540", "960"],
                      [c[c.index("input"):] for c in mc if "input" in c])

    def test_drag_receipt_and_argv_byte_identical(self):
        lc, lr = self._legacy("drag", {"x": 0.1, "y": 0.2}, {"x": 0.9, "y": 0.8})
        mc, mr = self._modern_disabled("drag", {"x": 0.1, "y": 0.2}, {"x": 0.9, "y": 0.8})
        self.assertEqual(lr, mr)
        self.assertEqual(lc, mc)

    def test_scroll_and_key_receipts_byte_identical(self):
        lc, lr = self._legacy("scroll", "down", 3)
        mc, mr = self._modern_disabled("scroll", "down", 3)
        self.assertEqual((lr, lc), (mr, mc))
        lc, lr = self._legacy("key", ["enter"])
        mc, mr = self._modern_disabled("key", ["enter"])
        self.assertEqual((lr, lc), (mr, mc))


class HubControlSurfaceTests(unittest.TestCase):
    """StreamHub 控制面:绝不 spawn;video_size 锚点;随流同葬。"""

    def test_control_writer_never_spawns(self):
        spawner = _ControlCapableSpawner()
        hub = StreamHub(StreamConfig(enabled=True, first_frame_timeout_s=2.0),
                        spawner, _fake_decoder(), decoder_name="fake")
        try:
            self.assertIsNone(hub.control_writer("never-grabbed"))  # 无流 ⇒ None,不开流
            self.assertEqual(spawner.opens, 0)
            self.assertIsNone(hub.video_size("never-grabbed"))
            rec = hub.grab("emu1")
            self.assertIsNotNone(rec)
            w = hub.control_writer("emu1")
            self.assertIsNotNone(w)
            self.assertEqual(w.profile, "2x")
            self.assertEqual(hub.video_size("emu1"), (32, 48))
            self.assertTrue(w.send(encode_keycode(ACTION_DOWN, 4)))
            # 同一 writer 复用(不重复移交 socket)
            self.assertIs(hub.control_writer("emu1"), w)
        finally:
            hub.close()

    def test_writer_closed_with_stream(self):
        spawner = _ControlCapableSpawner()
        hub = StreamHub(StreamConfig(enabled=True, first_frame_timeout_s=2.0),
                        spawner, _fake_decoder(), decoder_name="fake")
        hub.grab("emu1")
        sock = spawner.last_control
        w = hub.control_writer("emu1")
        hub.close()
        self.assertFalse(w.alive)
        self.assertGreaterEqual(sock.closed, 1)
        self.assertIsNone(hub.control_writer("emu1"))               # 停流后无通道

    def test_source_without_control_socket_degrades(self):
        # mock 源不带 take_control_socket(旧 spawner 兼容)⇒ None 不抛
        class PlainSource:
            def __init__(self):
                self.closed = threading.Event()
                self._q: _queue.Queue = _queue.Queue()
                payload = struct.pack(">IIQ", 32, 48, 7)
                self._q.put(b"\x00" + b"h264" + struct.pack(">II", 32, 48)
                            + struct.pack(">QI", (1 << 62) | 1, len(payload)) + payload)

            def read(self, n):
                while True:
                    if self.closed.is_set():
                        return b""
                    try:
                        return self._q.get(timeout=0.02)
                    except _queue.Empty:
                        continue

            def close(self):
                self.closed.set()

        class PlainSpawner:
            def __init__(self):
                self._src = PlainSource()

            def open(self, serial):
                return self._src

            __call__ = open

        hub = StreamHub(StreamConfig(enabled=True, first_frame_timeout_s=2.0),
                        PlainSpawner(), _fake_decoder(), decoder_name="fake")
        try:
            self.assertIsNotNone(hub.grab("emu1"))
            self.assertIsNone(hub.control_writer("emu1"))           # 降级:无控制面
            self.assertEqual(hub.video_size("emu1"), (32, 48))
        finally:
            hub.close()


if __name__ == "__main__":
    unittest.main()
