"""ΝΩ-36 可观测性 + 设备面健壮性单测（离线：零硬件/零网络/零真子进程）。

七件套的纯函数/注入面断言：
  1. JSON-lines 结构化日志字段（server.request_log_record / log_json）
  2. /v1/stats 诊断端点形状（routes._collect_stats —— 缺席面诚实 absent）
  3. HID 热插拔自愈 + 扫描 TTL（fake serial 模块注入）
  4. UVC 读超时护栏（fake cv2：挂死 cap ⇒ 有界等待 + 诚实超时信封）
  5. scrcpy 隧道端口冲突 scid 重掷（reroll_tunnel_port 纯函数）
  6. audio VAD 预门 / numpy 双路径等价 / 声学指纹
  7. android ctempdir churn 治理（复用目录 + 帧序号 + 零残留）
"""
import asyncio
import io
import json
import math
import os
import sys
import time
import types
import unittest
from pathlib import Path
from unittest import mock

_SVC_ROOT = str(Path(__file__).resolve().parents[1])
if _SVC_ROOT not in sys.path:
    sys.path.insert(0, _SVC_ROOT)

from PIL import Image  # noqa: E402

from dsh_physical import audio as audio_mod  # noqa: E402
from dsh_physical import routes  # noqa: E402
from dsh_physical.android import AndroidController  # noqa: E402
from dsh_physical.auth import ENDPOINT_CAPABILITY  # noqa: E402
from dsh_physical.config import AndroidConfig, AppConfig, ScreenshotConfig  # noqa: E402
from dsh_physical.errors import ErrorKind, PhysicalError  # noqa: E402
from dsh_physical.hid import (  # noqa: E402
    _SCAN_TTL_S, PySerialTransport, reset_scan_cache, scan_serial_ports,
)
from dsh_physical.screen import ScreenCapture  # noqa: E402
from dsh_physical.scrcpyStream import StreamConfig, reroll_tunnel_port  # noqa: E402
from dsh_physical.server import log_json, request_log_record  # noqa: E402


# ─── 1. JSON-lines 结构化日志 ───


class JsonLogTests(unittest.TestCase):
    """ΝΩ-36-1：请求日志字段组（OTel 短名对齐）+ stderr 单行输出 + 绝不抛。"""

    FIELDS = {"ts", "service", "http.method", "http.route", "http.status",
              "duration_ms", "request.id"}

    def test_record_fields_echo(self):
        rec = request_log_record("POST", "/v1/click_mouse", 200, 42, "req-abc-123")
        self.assertEqual(set(rec), self.FIELDS)
        self.assertEqual(rec["service"], "dsh-physical")
        self.assertEqual(rec["http.method"], "POST")
        self.assertEqual(rec["http.route"], "/v1/click_mouse")
        self.assertEqual(rec["http.status"], 200)
        self.assertEqual(rec["duration_ms"], 42)
        self.assertEqual(rec["request.id"], "req-abc-123")  # X-Request-Id 回显

    def test_record_ts_is_rfc3339_utc(self):
        rec = request_log_record("GET", "/v1/health", 200, 1, "")
        self.assertRegex(rec["ts"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
        self.assertEqual(rec["request.id"], "")  # 缺头诚实空串

    def test_log_json_single_line_stderr(self):
        saved = sys.stderr
        buf = io.StringIO()
        sys.stderr = buf
        try:
            log_json(request_log_record("GET", "/v1/stats", 200, 5, "rid-1"))
        finally:
            sys.stderr = saved
        lines = buf.getvalue().splitlines()
        self.assertEqual(len(lines), 1, "JSON-lines：恰一行")
        parsed = json.loads(lines[0])
        self.assertEqual(parsed["http.route"], "/v1/stats")
        self.assertEqual(parsed["request.id"], "rid-1")

    def test_log_json_never_raises(self):
        class _Boom:
            def write(self, *_a):
                raise OSError("stderr gone")

            def flush(self):
                raise OSError("stderr gone")

        saved = sys.stderr
        sys.stderr = _Boom()
        try:
            log_json({"anything": 1})  # 不得抛（日志失败不得击穿请求）
        finally:
            sys.stderr = saved

    def test_log_json_serializes_odd_values(self):
        saved = sys.stderr
        buf = io.StringIO()
        sys.stderr = buf
        try:
            log_json({"weird": object(), "ok": 1})  # default=str 兜底
        finally:
            sys.stderr = saved
        self.assertIn("ok", json.loads(buf.getvalue()))


# ─── 2. /v1/stats 诊断端点 ───


class StatsEndpointTests(unittest.TestCase):
    """ΝΩ-36-2：五面聚合形状 + 缺席面诚实 absent + 管理面鉴权方言。"""

    def setUp(self):
        self._saved_controllers = dict(routes._controllers)
        routes.set_controllers(
            types.SimpleNamespace(),          # input（本测试不触）
            ScreenCapture(ScreenshotConfig()),  # screen：真例（帧环公有快照）
            types.SimpleNamespace(),          # funnel
            types.SimpleNamespace(),          # window
            AppConfig(),
            android_ctrl=AndroidController(AndroidConfig()),
        )

    def tearDown(self):
        routes._controllers.clear()
        routes._controllers.update(self._saved_controllers)

    def test_collect_stats_shape(self):
        stats = routes._collect_stats()
        for face in ("ts", "executors", "shm", "streams", "audio", "frame_ring", "drain"):
            self.assertIn(face, stats, f"缺诊断面：{face}")
        self.assertIn("pools", stats["executors"])
        self.assertIn("sizes", stats["executors"])
        self.assertIn("mmap_bytes", stats["shm"])
        self.assertEqual(stats["drain"], {"draining": False, "in_flight": 0})

    def test_streams_absent_when_hub_never_started(self):
        # 流缺省 off ⇒ 枢纽未建 ⇒ absent（诊断读不触发惰性构造副作用）
        streams = routes._collect_stats()["streams"]
        self.assertTrue(streams.get("absent"))
        self.assertIn("reason", streams)

    def test_frame_ring_watermark_shape(self):
        ring = routes._collect_stats()["frame_ring"]
        self.assertEqual(set(ring), {"frames", "capacity", "latest_frame_id"})
        self.assertEqual(ring["capacity"], ScreenCapture.MAX_CACHED_FRAMES)
        self.assertEqual(ring["frames"], 0)
        self.assertIsNone(ring["latest_frame_id"])

    def test_audio_face_reads_cached_state(self):
        audio = routes._collect_stats()["audio"]
        self.assertIn("probed", audio)
        self.assertIn("available", audio)

    def test_endpoint_returns_success_envelope(self):
        resp = asyncio.run(routes.stats())  # safe_call ⇒ 完整信封
        self.assertEqual(resp["status"], "success")
        self.assertIn("executors", resp["data"])

    def test_absent_faces_when_controllers_not_assembled(self):
        routes._controllers.clear()
        stats = routes._collect_stats()
        self.assertTrue(stats["streams"]["absent"])
        self.assertTrue(stats["frame_ring"]["absent"])
        # 不依赖控制器的面照常在场
        self.assertIn("pools", stats["executors"])

    def test_stats_is_management_plane_observe_gated(self):
        # ΠΑΝ-25: 管理端点入能力位图 —— /v1/stats → observe（旧「不在
        # ENDPOINT_CAPABILITY ⇒ 免能力校验」方言已被 fail-closed 取代；
        # 中间件级判决测试见 test_auth.py AuthMiddlewareTests）
        self.assertEqual(ENDPOINT_CAPABILITY.get("/v1/stats"), "observe")

    def test_collect_stats_never_raises_on_broken_face(self):
        routes._controllers["screen"] = types.SimpleNamespace(
            frame_ids=lambda: (_ for _ in ()).throw(RuntimeError("boom")),
            MAX_CACHED_FRAMES=8,
        )
        stats = routes._collect_stats()  # 不得抛
        self.assertTrue(stats["frame_ring"]["absent"])
        self.assertIn("boom", stats["frame_ring"]["reason"])


# ─── 3. HID 热插拔自愈 + 扫描 TTL ───


def _install_fake_serial(testcase, serial_factory, comports):
    """注入 fake serial 模块（open() 的 ``import serial`` 命中 sys.modules）。"""
    fake = types.ModuleType("serial")
    fake.SerialException = type("SerialException", (OSError,), {})
    fake.Serial = serial_factory
    tools = types.ModuleType("serial.tools")
    list_ports = types.ModuleType("serial.tools.list_ports")
    list_ports.comports = comports
    tools.list_ports = list_ports
    fake.tools = tools
    saved = {k: sys.modules.get(k)
             for k in ("serial", "serial.tools", "serial.tools.list_ports")}
    sys.modules.update({"serial": fake, "serial.tools": tools,
                        "serial.tools.list_ports": list_ports})
    testcase.addCleanup(lambda: [
        sys.modules.pop(k, None) if v is None else sys.modules.__setitem__(k, v)
        for k, v in saved.items()
    ])
    reset_scan_cache()
    testcase.addCleanup(reset_scan_cache)
    return fake


class HidSelfHealTests(unittest.TestCase):
    """ΝΩ-36-3：write 捕串口异常 ⇒ close+置 None+重扫重开一次；TTL 防热循环。"""

    def test_write_self_heal_on_device_revival(self):
        class RevivingDevice:
            def __init__(self):
                self.dead = True
                self.written = []
                self.closed = 0

            def write(self, data):
                if self.dead:
                    self.dead = False  # 旧句柄死；重开的新句柄复活
                    raise fake.SerialException("device unplugged")
                self.written.append(bytes(data))

            def close(self):
                self.closed += 1

        dev = RevivingDevice()
        fake = _install_fake_serial(self, lambda port, baud, timeout=0.2: dev,
                                    lambda: [])
        tr = PySerialTransport(port="COM3")
        tr.write(b"\x57\xab")
        self.assertEqual(dev.written, [b"\x57\xab"], "新句柄重写成功")
        self.assertEqual(tr.self_heals, 1, "自愈恰一次")
        self.assertEqual(dev.closed, 1, "死句柄已收口")
        self.assertIn("self_heals", tr.describe())

    def test_write_self_heal_failure_is_honest_envelope(self):
        def factory(port, baud, timeout=0.2):
            raise OSError("port gone forever")

        _install_fake_serial(self, factory, lambda: [])

        class DeadDev:
            def write(self, data):
                raise OSError("write boom")

            def close(self):
                return None

        dev = DeadDev()
        tr = PySerialTransport(port="COM3")
        tr._ser = dev  # 直接装死句柄（跳过 open）
        with self.assertRaises(PhysicalError) as ctx:
            tr.write(b"\x01")
        self.assertIs(ctx.exception.kind, ErrorKind.INTERNAL_ERROR)
        self.assertIn("self-heal", ctx.exception.detail, "自愈失败如实申报")

    def test_scan_ttl_caches_within_window(self):
        calls = {"n": 0}

        def comports():
            calls["n"] += 1
            p = types.SimpleNamespace(device="COM3", vid=0x1A86, description="CH340")
            return [p]

        _install_fake_serial(self, lambda *a, **k: None, comports)
        first = scan_serial_ports()
        second = scan_serial_ports()
        self.assertEqual(first, second)
        self.assertEqual(calls["n"], 1, "TTL 窗内只枚举一次（防热循环）")
        self.assertEqual(first[0]["port"], "COM3")

    def test_scan_ttl_zero_bypasses_cache(self):
        calls = {"n": 0}

        def comports():
            calls["n"] += 1
            return []

        _install_fake_serial(self, lambda *a, **k: None, comports)
        scan_serial_ports(ttl_s=0.0)
        scan_serial_ports(ttl_s=0.0)
        self.assertEqual(calls["n"], 2)
        self.assertGreater(_SCAN_TTL_S, 0, "缺省 TTL 为正")


# ─── 4. UVC 读超时护栏 ───


def _install_fake_cv2(testcase, cap_factory):
    fake = types.ModuleType("cv2")
    fake.CAP_DSHOW = 1
    fake.CAP_PROP_FRAME_WIDTH = 3
    fake.CAP_PROP_FRAME_HEIGHT = 4
    fake.CAP_PROP_FPS = 5
    fake.VideoCapture = cap_factory
    saved = sys.modules.get("cv2")
    sys.modules["cv2"] = fake
    testcase.addCleanup(
        lambda: sys.modules.pop("cv2", None) if saved is None
        else sys.modules.__setitem__("cv2", saved))
    return fake


class UvcTimeoutTests(unittest.TestCase):
    """ΝΩ-36-4：挂死的 cap.read ⇒ 有界等待 + 诚实超时信封；健康 cap 走后台缓冲。"""

    def test_hanging_read_raises_bounded_timeout(self):
        from dsh_physical.uvc import Cv2FrameSource

        class HangingCap:
            released = False

            def isOpened(self):
                return True

            def set(self, *_a):
                return None

            def read(self):
                time.sleep(1.0)  # DirectShow 信号丢失形态：永不返回
                return False, None

            def release(self):
                HangingCap.released = True

        cap = HangingCap()
        _install_fake_cv2(self, lambda *a, **k: cap)
        src = Cv2FrameSource(0, read_timeout_s=0.2)
        src.open()
        t0 = time.monotonic()
        with self.assertRaises(PhysicalError) as ctx:
            src.read()
        elapsed = time.monotonic() - t0
        self.assertIs(ctx.exception.kind, ErrorKind.SCREEN_CAPTURE_FAILED)
        self.assertIn("within 0.2s", ctx.exception.detail)
        self.assertLess(elapsed, 0.9, "消费方有界等待（worker 归还）")
        self.assertEqual(src.read_timeouts, 1)
        self.assertTrue(src.describe()["reader_alive"], "后台线程保持运行（自愈面）")
        src.close()
        self.assertTrue(cap.released)

    def test_buffered_fast_read_returns_frame(self):
        import numpy as np

        from dsh_physical.uvc import Cv2FrameSource

        class FastCap:
            released = False

            def isOpened(self):
                return True

            def set(self, *_a):
                return None

            def read(self):
                arr = np.zeros((4, 6, 3), dtype=np.uint8)
                arr[:, :, 0] = 200  # BGR 的 B=200 ⇒ RGB 像素 (0,0,200)
                return True, arr

            def release(self):
                FastCap.released = True

        cap = FastCap()
        _install_fake_cv2(self, lambda *a, **k: cap)
        src = Cv2FrameSource(0, read_timeout_s=1.0)
        src.open()
        img = src.read()
        self.assertEqual(img.size, (6, 4))
        self.assertEqual(img.getpixel((0, 0)), (0, 0, 200))
        self.assertEqual(src.read_timeouts, 0)
        src.close()
        self.assertTrue(cap.released)


# ─── 5. scrcpy 隧道端口冲突重掷 ───


class PortRerollTests(unittest.TestCase):
    """ΝΩ-36-5：adb forward 失败 ⇒ scid 重掷至多 N 次；耗尽 ⇒ 诚实 RuntimeError。"""

    def test_conflict_rerolled_to_free_port(self):
        occupied = {27183 + 100}
        dice = iter([100, 101])

        def fwd(scid, port):
            if port in occupied:
                return 1, "cannot bind"
            return 0, ""

        scid, port, attempts = reroll_tunnel_port(fwd, 27183, max_retries=3,
                                                  rng=lambda: next(dice))
        self.assertEqual((scid, port, attempts), (101, 27183 + 101, 2))

    def test_exhausted_retries_raise(self):
        dice = iter([1, 2, 3, 4, 5])
        with self.assertRaises(RuntimeError) as ctx:
            reroll_tunnel_port(lambda s, p: (1, "busy"), 27183,
                               max_retries=3, rng=lambda: next(dice))
        self.assertIn("after 4 attempt", str(ctx.exception))
        self.assertIn("busy", str(ctx.exception))

    def test_first_try_free_single_attempt(self):
        scid, port, attempts = reroll_tunnel_port(
            lambda s, p: (0, ""), 27183, max_retries=0, rng=lambda: 9)
        self.assertEqual((scid, port, attempts), (9, 27183 + 9, 1))

    def test_default_config_retries(self):
        self.assertEqual(StreamConfig().port_conflict_retries, 3)

    def test_env_retries_binding(self):
        import os

        from dsh_physical.scrcpyStream import stream_config_from_env

        key = "DSH_PHYSICAL_ANDROID_STREAM_PORT_RETRIES"
        saved = os.environ.get(key)
        try:
            os.environ[key] = "5"
            self.assertEqual(stream_config_from_env().port_conflict_retries, 5)
            os.environ[key] = "-2"  # 负值钳 0（旧行为：不重掷）
            self.assertEqual(stream_config_from_env().port_conflict_retries, 0)
        finally:
            if saved is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = saved


# ─── 6. audio VAD 预门 / 双路径等价 / 声学指纹 / poll 去重 ───


class VadGateTests(unittest.TestCase):
    """ΝΩ-36-6a：静默窗快径输出 == 全扫描输出；快径确实跳过全特征。"""

    def _fields(self, f):
        return (f.peak_rms, f.active_frames, f.total_frames, f.longest_burst_ms,
                f.burst_count, f.mean_zcr, f.low_ratio, f.high_ratio, f.decay)

    def test_fast_path_equals_full_scan(self):
        wave = audio_mod.synth_silence()
        gated = audio_mod.extract_features(wave)  # 快径：峰值 < 静默门
        saved = audio_mod.SILENCE_RMS
        try:
            audio_mod.SILENCE_RMS = 0.0  # 门永不触发 ⇒ 全扫描
            full = audio_mod.extract_features(wave)
        finally:
            audio_mod.SILENCE_RMS = saved
        g, f_ = self._fields(gated), self._fields(full)
        self.assertEqual(g[1:5], f_[1:5])  # active/total/burst 结构逐字段相等
        self.assertEqual(g[5:], f_[5:])
        self.assertAlmostEqual(g[0], f_[0], delta=1e-12)

    def test_gate_skips_full_feature_scan(self):
        # 静默窗不得触碰全特征扫描（预门的性能承诺）
        def _boom(*_a, **_k):
            raise AssertionError("full feature scan must be skipped for silent window")

        saved_np = audio_mod._frame_stats_np
        saved_py = audio_mod._frame_stats_python
        audio_mod._frame_stats_np = _boom
        audio_mod._frame_stats_python = _boom
        try:
            f = audio_mod.extract_features(audio_mod.synth_silence())
        finally:
            audio_mod._frame_stats_np = saved_np
            audio_mod._frame_stats_python = saved_py
        self.assertEqual(f.active_frames, 0)


class NumpyPathEquivalenceTests(unittest.TestCase):
    """ΝΩ-36-6c：numpy 向量化路径与纯 Python 路径逐字段等价（五类波形）。"""

    FIELDS = ("peak_rms", "active_frames", "total_frames", "longest_burst_ms",
              "burst_count", "mean_zcr", "low_ratio", "high_ratio", "decay")

    def test_numpy_matches_pure_python_on_five_classes(self):
        waves = [
            audio_mod.synth_notification_ding(),
            audio_mod.synth_error_beep(),
            audio_mod.synth_success_chime(),
            audio_mod.synth_key_click(),
            audio_mod.synth_silence(),
        ]
        saved_np = audio_mod._np
        self.assertIsNotNone(saved_np, "本测试环境应带 numpy（screen.py 依赖）")
        try:
            for wave in waves:
                f_np = audio_mod.extract_features(wave)
                audio_mod._np = None
                try:
                    f_py = audio_mod.extract_features(wave)
                finally:
                    audio_mod._np = saved_np
                for k in self.FIELDS:
                    self.assertTrue(
                        math.isclose(getattr(f_np, k), getattr(f_py, k),
                                     rel_tol=1e-6, abs_tol=1e-9),
                        f"路径漂移 {k}: numpy={getattr(f_np, k)} pure={getattr(f_py, k)}",
                    )
        finally:
            audio_mod._np = saved_np


class FingerprintTests(unittest.TestCase):
    """ΝΩ-36-6b：8 带量化指纹 —— 确定性 / 判别性 / 静默诚实缺席。"""

    def test_deterministic_and_discriminative(self):
        ding1 = audio_mod.acoustic_fingerprint(audio_mod.synth_notification_ding())
        ding2 = audio_mod.acoustic_fingerprint(audio_mod.synth_notification_ding())
        error = audio_mod.acoustic_fingerprint(audio_mod.synth_error_beep())
        self.assertIsInstance(ding1, str)
        self.assertEqual(len(ding1), audio_mod.FINGERPRINT_BANDS)
        self.assertRegex(ding1, r"^[0-9a-f]{8}$")
        self.assertEqual(ding1, ding2, "同波形 ⇒ 同指纹")
        self.assertNotEqual(ding1, error, "异波形 ⇒ 异指纹")

    def test_silence_and_empty_are_absent(self):
        self.assertIsNone(audio_mod.acoustic_fingerprint(audio_mod.synth_silence()))
        self.assertIsNone(audio_mod.acoustic_fingerprint([]))


class PollDedupTests(unittest.TestCase):
    """ΝΩ-36-6b：同指纹激活窗口聚合计数 —— 同一提示音重复播放不每沿一报。"""

    def _phases(self):
        ding = audio_mod.synth_notification_ding()
        zeros = [0.0] * audio_mod.SAMPLE_RATE * 2
        chunk = audio_mod.SAMPLE_RATE // 10  # 100ms 块

        def cs(w):
            return [w[i:i + chunk] for i in range(0, len(w), chunk)]

        return [cs(ding), cs(zeros), cs(ding), cs(zeros), cs(ding)]

    def test_same_fingerprint_series_aggregates(self):
        from dsh_physical.audio import AudioMonitor, MockRunner

        phases = self._phases()
        mon = AudioMonitor(MockRunner([c for ph in phases for c in ph]))
        emissions = []
        for phase in phases:
            for _chunk in phase:
                mon.drain_once()
            emissions.append(mon.poll())
        # 首个 ding 报（含指纹）；静默沿照报；后续同指纹 ding 聚合抑制
        self.assertIsNotNone(emissions[0])
        self.assertEqual(emissions[0]["event"], "notification_ding")
        self.assertIn("fingerprint", emissions[0])
        self.assertIsNotNone(emissions[1])
        self.assertEqual(emissions[1]["event"], "silence")
        self.assertIsNone(emissions[2], "同指纹重复播放：聚合不报")
        self.assertIsNotNone(emissions[3])
        self.assertEqual(emissions[3]["event"], "silence")
        self.assertIsNone(emissions[4], "再次同指纹：仍聚合")
        dedup = mon.describe()["fingerprint_dedup"]
        self.assertEqual(dedup["suppressed_total"], 2)
        self.assertEqual(dedup["suppressed_in_series"], 2)
        self.assertEqual(dedup["window_s"], audio_mod.FINGERPRINT_WINDOW_S)


# ─── 7. android ctempdir churn 治理 ───


class AndroidTempdirChurnTests(unittest.TestCase):
    """ΝΩ-36-7：per-serial 复用目录 + 帧序号命名 + 帧后零残留 + close 回收。"""

    def _make_ctrl(self):
        from dsh_physical.android import default_runner  # noqa: F401 —— 类型参考

        cwds = set()

        def runner(argv, timeout_s=15.0, cwd=None):
            if cwd is not None:
                cwds.add(cwd)
            if "--version" in argv:
                return 0, b"scrcpy 2.7.1\n", b""
            if "--screenshot" in argv:
                Image.new("RGB", (32, 48), (11, 22, 33)).save(
                    f"{cwd}/screenshot_0001.png", format="PNG")
                return 0, b"", b""
            return 0, b"", b""

        ctrl = AndroidController(AndroidConfig(), runner=runner)
        return ctrl, cwds

    def test_reused_dir_and_zero_residue(self):
        ctrl, cwds = self._make_ctrl()
        try:
            imgs = [ctrl.grab_frame("emu1")[0] for _ in range(3)]
            self.assertTrue(all(im.size == (32, 48) for im in imgs))
            self.assertEqual(len(cwds), 1, "三次抓帧只一个工作目录（无 mkdtemp churn）")
            workdir = next(iter(cwds))
            self.assertEqual(list(Path(workdir).glob("*")), [], "帧后零残留 PNG")
            self.assertEqual(ctrl._grab_seq["emu1"], 3, "帧序号单调推进")
        finally:
            ctrl.close()

    def test_per_serial_isolation_and_close_cleanup(self):
        ctrl, _cwds = self._make_ctrl()
        ctrl.grab_frame("emu1")
        ctrl.grab_frame("192.168.1.5:5555")
        self.assertEqual(len(ctrl._grab_dirs), 2, "per-serial 独立目录")
        dirs = dict(ctrl._grab_dirs)
        ctrl.close()
        self.assertTrue(all(not Path(d).exists() for d in dirs.values()),
                        "close 回收全部复用目录")

    def test_safe_dir_token(self):
        self.assertEqual(AndroidController._safe_dir_token("192.168.1.5:5555"),
                         "192.168.1.5_5555")
        self.assertEqual(AndroidController._safe_dir_token("emu-1_2.3"),
                         "emu-1_2.3")


class UvcReaderBackoffTests(unittest.TestCase):
    """ΠΑΝ-92：热拔插后读线程指数退避 + 设备重枚举（不再单核空转）。"""

    def test_disconnected_cap_backs_off_and_reenumerates(self):
        from dsh_physical.uvc import Cv2FrameSource

        class DeadCap:
            """热拔插形态：read() 立即返 (False, None)。"""

            def __init__(self):
                self.calls = 0
                self.released = 0

            def isOpened(self):
                return True

            def set(self, *_a):
                return None

            def read(self):
                self.calls += 1
                return False, None

            def release(self):
                self.released += 1

        cap = DeadCap()
        constructions = {"n": 0}

        def factory(*_a, **_k):
            constructions["n"] += 1  # 重开 = DirectShow 重新枚举设备
            return cap

        _install_fake_cv2(self, factory)
        src = Cv2FrameSource(0, read_timeout_s=0.2, backoff_cap_s=0.05, reopen_every=4)
        src.open()
        try:
            # 读线程是惰性的（首次消费才起）：先触发一次 read 把它带起来，
            # 之后无消费期正是旧实现单核空转的现场。
            with self.assertRaises(PhysicalError):
                src.read()
            time.sleep(0.4)  # 旧实现 0.4s 内百万次级忙转；退避后个位~十位次
        finally:
            src.close()
        self.assertLess(cap.calls, 60, "指数退避生效：读调用速率有界（非单核空转）")
        self.assertGreaterEqual(constructions["n"], 2,
                                "连续失败 ⇒ 设备重枚举（release + reopen，重插自愈面）")
        self.assertGreaterEqual(src.reopens, 1, "重枚举计数申报（可观测面）")
        desc = src.describe()
        self.assertIn("read_failures", desc)
        self.assertIn("reopens", desc)

    def test_reader_recovers_when_signal_returns(self):
        import numpy as np

        from dsh_physical.uvc import Cv2FrameSource

        class FlakyCap:
            def __init__(self):
                self.fail = True

            def isOpened(self):
                return True

            def set(self, *_a):
                return None

            def read(self):
                if self.fail:
                    return False, None
                arr = np.zeros((4, 6, 3), dtype=np.uint8)
                arr[:, :, 2] = 180
                return True, arr

            def release(self):
                return None

        cap = FlakyCap()
        _install_fake_cv2(self, lambda *_a, **_k: cap)
        src = Cv2FrameSource(0, read_timeout_s=0.3, backoff_cap_s=0.02, reopen_every=1000)
        src.open()
        try:
            with self.assertRaises(PhysicalError):
                src.read()  # 失联期：诚实超时信封（排队中的失败项）
            cap.fail = False  # 信号恢复
            img = None
            for _ in range(5):  # 队列可能持有一条旧失败项：重试到新帧
                try:
                    img = src.read()
                    break
                except PhysicalError:
                    time.sleep(0.05)
            self.assertIsNotNone(img, "信号恢复 ⇒ 自然续流（退避不误杀恢复）")
            self.assertEqual(src.read_failures, 0, "成功帧 ⇒ 连续失败计数归零")
        finally:
            src.close()


# ─── 8. ΠΑΝ-94：配置面诚实（数值域违反一律 raise，不静默 clamp/放行） ───


class ConfigHonestyTests(unittest.TestCase):
    """ΠΑΝ-94：注释与代码对齐 —— 三处失真（宣称拒绝/实放行、宣称拒绝/实 clamp、
    静默 clamp）统一为拒绝方言（加载层 throw 是本模块自立的铁律）。"""

    def _load_raises(self, env: dict) -> ValueError:
        from dsh_physical.config import load_config_from_env

        clean = {k: v for k, v in os.environ.items() if not k.startswith("DSH_PHYSICAL_")}
        clean.update(env)
        with mock.patch.dict(os.environ, clean, clear=True):
            try:
                load_config_from_env()
            except ValueError as e:
                return e
        raise AssertionError(f"expected ValueError for {env}")

    def test_mmap_quota_negative_rejected(self):
        """旧实现：注释宣称拒绝、代码放行（本工单点名的失真 #1）。"""
        e = self._load_raises({"DSH_PHYSICAL_MMAP_QUOTA_MB": "-5"})
        self.assertIn("DSH_PHYSICAL_MMAP_QUOTA_MB", str(e))

    def test_dxgi_timeout_negative_rejected(self):
        """旧实现：注释宣称拒绝、代码 max(0,·) 恰是 clamp（失真 #2）。"""
        e = self._load_raises({"DSH_PHYSICAL_DXGI_TIMEOUT_MS": "-1"})
        self.assertIn("DSH_PHYSICAL_DXGI_TIMEOUT_MS", str(e))

    def test_jpeg_quality_out_of_range_rejected(self):
        e = self._load_raises({"DSH_PHYSICAL_JPEG_QUALITY": "150"})
        self.assertIn("domain", str(e))

    def test_tcp_port_domain_rejected(self):
        self._load_raises({"DSH_PHYSICAL_TCP_PORT": "70000"})

    def test_executor_queue_limit_rejected(self):
        e = self._load_raises({"DSH_PHYSICAL_EXEC_DEVICE_QUEUE": "0"})
        self.assertIn("DSH_PHYSICAL_EXEC_DEVICE_QUEUE", str(e))

    def test_raw_input_negative_stale_gate_rejected(self):
        """负陈旧门会让镜像永判陈旧（L-24）—— 拒绝而非放行。"""
        self._load_raises({"DSH_PHYSICAL_RAW_INPUT_STALE_S": "-2"})

    def test_valid_extremes_still_load(self):
        from dsh_physical.config import load_config_from_env

        clean = {k: v for k, v in os.environ.items() if not k.startswith("DSH_PHYSICAL_")}
        clean.update({
            "DSH_PHYSICAL_MMAP_QUOTA_MB": "0",     # 0 = 配额关（合法）
            "DSH_PHYSICAL_JPEG_QUALITY": "100",
            "DSH_PHYSICAL_DXGI_TIMEOUT_MS": "0",
            "DSH_PHYSICAL_RAW_INPUT_DRIFT_BUDGET_PX": "0",  # 0 = 漂移门关（合法）
        })
        with mock.patch.dict(os.environ, clean, clear=True):
            cfg = load_config_from_env()
        self.assertEqual(cfg.screenshot.mmap_quota_mb, 0)
        self.assertEqual(cfg.raw_input.drift_budget_px, 0)


# ─── 9. ΠΑΝ-95：adb 失败分类（device_unreachable —— TS 端可区分重试） ───


class AdbErrorClassificationTests(unittest.TestCase):
    """ΠΑΝ-95：例行 adb 失败不再铸 internal_error（那是最后防线诊断位）。"""

    def test_shell_input_failure_maps_device_unreachable(self):
        def runner(argv, timeout_s=15.0, cwd=None):
            if "--version" in argv:
                return 0, b"scrcpy 2.7.1\n", b""
            if "wm" in argv:
                return 0, b"Physical size: 1080x1920\n", b""
            if "input" in argv:
                return 1, b"", b"error: device offline"
            return 0, b"", b""

        ctrl = AndroidController(AndroidConfig(), runner=runner)
        try:
            with self.assertRaises(PhysicalError) as ctx:
                ctrl.tap("emu1", 0.5, 0.5)
            self.assertIs(ctx.exception.kind, ErrorKind.DEVICE_UNREACHABLE)
            self.assertIn("device offline", ctx.exception.detail,
                          "adb 真实 stderr 进入信封（分类的证据面）")
        finally:
            ctrl.close()

    def test_grab_double_failure_reports_adb_root_cause(self):
        def runner(argv, timeout_s=15.0, cwd=None):
            if "--version" in argv:
                return 0, b"scrcpy 2.7.1\n", b""
            if "--screenshot" in argv:
                return 1, b"", b"scrcpy boom"
            if "screencap" in argv:
                return 1, b"", b"error: device unauthorized"
            return 0, b"", b""

        ctrl = AndroidController(AndroidConfig(), runner=runner)
        try:
            with self.assertRaises(PhysicalError) as ctx:
                ctrl.grab_frame("emu1")
            # 旧实现 `raise e from None` 只报 scrcpy 的错并丢弃 adb 的设备级根因
            self.assertIn("device unauthorized", ctx.exception.detail,
                          "最后尝试的链（adb）是主判决")
            self.assertIn("scrcpy chain also failed", ctx.exception.detail,
                          "另一链的失败并进 detail（不凭猜测丢证据）")
        finally:
            ctrl.close()


# ─── 10. ΠΑΝ-96（routes 侧）：source 字段生效为 ceiling 收紧 ───


class UiTreeSourceFieldTests(unittest.TestCase):
    """ΠΑΝ-96：``source`` 此前收而不用（契约谎言）—— 现按 min 语义收紧 ceiling。"""

    def setUp(self):
        self._saved = dict(routes._controllers)
        seen = {"ceiling": None}

        class FakeFunnel:
            async def extract(self, screenshot_bytes, region, funnel_ceiling, screen_size):
                seen["ceiling"] = funnel_ceiling
                return types.SimpleNamespace(to_dict=lambda: {"elements": [], "depth": seen["ceiling"]})

        class FakeScreen:
            async def capture_png_bytes(self, region=None):
                return b"png", {}, None

            async def get_screen_size(self):
                return {"width": 1920, "height": 1080}

        self.seen = seen
        routes._controllers.clear()
        routes._controllers.update({
            "funnel": FakeFunnel(),
            "screen": FakeScreen(),
            "config": AppConfig(),
        })

    def tearDown(self):
        routes._controllers.clear()
        routes._controllers.update(self._saved)

    def _call(self, **kwargs):
        from dsh_physical.routes import UiTreeRequest

        return asyncio.run(routes.get_ui_tree(UiTreeRequest(**kwargs)))

    def test_source_ocr_caps_ceiling_at_l2(self):
        resp = self._call(source="ocr")
        self.assertEqual(resp["status"], "success")
        self.assertEqual(self.seen["ceiling"], "L2",
                         "纯文本屏钉 source=ocr ⇒ 不落 L3（免 VLM 付费的客户端杠杆）")

    def test_source_tree_caps_ceiling_at_l1(self):
        self._call(source="tree")
        self.assertEqual(self.seen["ceiling"], "L1")

    def test_source_vlm_with_explicit_ceiling_takes_shallower(self):
        self._call(source="vlm", funnel_ceiling="L2")
        self.assertEqual(self.seen["ceiling"], "L2",
                         "显式 ceiling 与 source 取较浅者（都只能收紧视野）")

    def test_default_auto_l3_zero_regression(self):
        self._call()
        self.assertEqual(self.seen["ceiling"], "L3",
                         "auto + 缺省 ceiling=L3 ⇒ L3（旧客户端零回归）")


if __name__ == "__main__":
    unittest.main()
