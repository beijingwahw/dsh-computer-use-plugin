"""L4 声学证据通道:五类事件阈值分类器离线单测(ΑΩ-R32)。

合成波形(模块自带的确定性工坊)+ 环形缓冲语义 + mock runner 端到端
(脚本化采样块 —— 无音频硬件、无 WASAPI、无真实声卡参与)。
"""
import sys
from pathlib import Path

# ΑΩ-R32:discover 以本目录为 top-level,注入 python_service/(dsh_physical 所在目录)
_SVC_ROOT = str(Path(__file__).resolve().parents[1])
if _SVC_ROOT not in sys.path:
    sys.path.insert(0, _SVC_ROOT)

import struct  # noqa: E402
import unittest  # noqa: E402

from dsh_physical.audio import (  # noqa: E402
    DING_DECAY,
    ERROR_LOW_RATIO,
    SAMPLE_RATE,
    SILENCE_RMS,
    AudioMonitor,
    AudioRingBuffer,
    MockRunner,
    _WaveFormatEx,
    _WaveFormatExtensible,
    _decode_to_mono,
    _wfx_total_size,
    audio_events_payload,
    classify_features,
    classify_window,
    extract_features,
    parse_wave_format,
    synth_error_beep,
    synth_key_click,
    synth_notification_ding,
    synth_silence,
    synth_success_chime,
)


class ClassifierTests(unittest.TestCase):
    """阈值级联:五类合成波形各归其类(阈值即法条 —— 改阈值必过此关)。"""

    def test_five_synthetic_classes(self):
        cases = [
            ("notification_ding", synth_notification_ding()),
            ("error_beep", synth_error_beep()),
            ("success_chime", synth_success_chime()),
            ("key_click", synth_key_click()),
            ("silence", synth_silence()),
        ]
        for expected, wave in cases:
            with self.subTest(expected=expected):
                verdict = classify_window(wave)
                self.assertEqual(verdict["event"], expected)
                self.assertGreaterEqual(verdict["confidence"], 0.0)
                self.assertLessEqual(verdict["confidence"], 1.0)
                self.assertEqual(set(verdict), {"event", "confidence"})

    def test_empty_window_is_honest_silence(self):
        # 空窗防御式:全零特征 → silence(缺席不是异常,更不是抛错)
        f = extract_features([])
        self.assertEqual(f.active_frames, 0)
        self.assertEqual(f.total_frames, 0)
        self.assertEqual(classify_features(f), {"event": "silence", "confidence": 1.0})

    def test_error_beep_features(self):
        # 错误音形态:双哔(2 burst)+ 低带能量占比 ≥ 0.5
        f = extract_features(synth_error_beep())
        self.assertEqual(f.burst_count, 2)
        self.assertGreaterEqual(f.low_ratio, ERROR_LOW_RATIO)
        self.assertGreater(f.active_frames, 0)
        self.assertGreater(f.total_frames, 0)

    def test_ding_decay_shape(self):
        # 叮声形态:单 burst + 指数衰减(后半/前半能量比 ≤ 0.35)
        f = extract_features(synth_notification_ding())
        self.assertEqual(f.burst_count, 1)
        self.assertLessEqual(f.decay, DING_DECAY)

    def test_silence_below_gate(self):
        # 本底噪声 1e-5 低于静默门(≈ -54 dBFS)两个量级
        f = extract_features(synth_silence())
        self.assertEqual(f.active_frames, 0)
        self.assertLess(f.peak_rms, SILENCE_RMS)

    def test_invalid_sample_rate_defensive(self):
        # 非法采样率 → 全零特征(防御式,不抛)
        f = extract_features([0.5] * 100, sample_rate=0)
        self.assertEqual(f.active_frames, 0)


class RingBufferTests(unittest.TestCase):
    """定长采样环:满后淘汰最旧(~2s 窗口的语义根基)。"""

    def test_evicts_oldest_beyond_capacity(self):
        rb = AudioRingBuffer(sample_rate=10, window_seconds=1.0)  # maxlen = 10
        rb.push([1.0] * 6)
        rb.push([float(v) for v in range(7, 13)])  # 再压 6 个 → 淘汰最旧 2 个
        snap = rb.snapshot()
        self.assertEqual(len(snap), 10)
        self.assertEqual(snap, [1.0, 1.0, 1.0, 1.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0])
        self.assertEqual(len(rb), 10)


class MockMonitorEndToEndTests(unittest.TestCase):
    """脚本化 runner → 环形缓冲 → 窗口判决 → 边沿触发事件流(零硬件)。"""

    def test_mock_runner_payload_and_edge_trigger(self):
        wave = synth_notification_ding()
        chunk = SAMPLE_RATE // 20  # 50ms 采样块
        script = [wave[i:i + chunk] for i in range(0, len(wave), chunk)]
        mon = AudioMonitor(MockRunner(script))
        payload = audio_events_payload(mon)
        self.assertTrue(payload["available"])
        self.assertEqual(payload["backend"], "mock")
        self.assertEqual(payload["window_ms"], 2000)
        self.assertEqual(payload["event"]["event"], "notification_ding")
        # 边沿触发:首询产出事件,同类第二询抑制(防刷屏)
        self.assertEqual(mon.poll()["event"], "notification_ding")
        self.assertIsNone(mon.poll())

    def test_mock_runner_exhaustion_returns_empty(self):
        # 脚本耗尽 → read() 恒 [](通道静默语义,绝不凭空造样本)
        runner = MockRunner([[0.1, -0.1]])
        self.assertEqual(runner.read(), [0.1, -0.1])
        self.assertEqual(runner.read(), [])
        self.assertTrue(runner.describe()["exhausted"])


# ─── ΠΑΝ-83：WAVEFORMATEX/EXTENSIBLE 布局锚点 + 字节级夹具（堵死 selftest 盲区）───


class WaveFormatAbiAnchorTests(unittest.TestCase):
    """布局 ABI 锚点（mingw-w64 mmreg.h pack(1) 核对；对齐 dxgi_capture 的
    「结构体尺寸钉死在 selftest」纪律 —— C2-4 H-1/H-2 两个病灶的根因都是
    布局无锚：comtypes 引擎字段序错（wBitsPerSample@8 读到字节率低 16 位）、
    EXTENSIBLE 真标签读 sizeof(20) 处（dwChannelMask 而非 SubFormat@24）。"""

    def test_sizes_match_mmreg(self):
        import ctypes

        self.assertEqual(ctypes.sizeof(_WaveFormatEx), 18)
        self.assertEqual(ctypes.sizeof(_WaveFormatExtensible), 40)

    def test_field_offsets_match_mmreg(self):
        # pack(1) 下逐字段偏移 = mmreg.h 声明序（无对齐填充）
        offsets = {name: getattr(_WaveFormatEx, name).offset
                   for name, _t in _WaveFormatEx._fields_}
        self.assertEqual(offsets, {
            "wFormatTag": 0, "nChannels": 2, "nSamplesPerSec": 4,
            "nAvgBytesPerSec": 8, "nBlockAlign": 12, "wBitsPerSample": 14,
            "cbSize": 16,
        })
        self.assertEqual(_WaveFormatExtensible.wValidBitsPerSample.offset, 18)
        self.assertEqual(_WaveFormatExtensible.dwChannelMask.offset, 20)
        self.assertEqual(_WaveFormatExtensible.SubFormat.offset, 24)


class MixFormatByteFixtureTests(unittest.TestCase):
    """手工构造字节流 → parse_wave_format 断言（ΠΑΝ-83 夹具 —— 单声道 /
    5.1 / PCM16 / float32 各一例，另含非 EXTENSIBLE 与截断防御）。

    夹具经 struct.pack 显式落字节（不经被测代码生成 —— 拒绝自证循环）；
    每例注释标明旧病灶下的错读值，即回归哨。
    """

    @staticmethod
    def _guid(data1: int) -> bytes:
        # KSDATAFORMAT_SUBTYPE_*：Data1(LE) + Data2/Data3 + Data4 常量尾
        return (struct.pack("<IHH", data1, 0x0000, 0x0010)
                + bytes((0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71)))

    @classmethod
    def _ext(cls, ch: int, sr: int, bits: int, mask: int, data1: int,
             valid_bits: int | None = None) -> bytes:
        align = ch * bits // 8
        return (struct.pack("<HHIIHHH", 0xFFFE, ch, sr, sr * align, align, bits, 22)
                + struct.pack("<H", bits if valid_bits is None else valid_bits)
                + struct.pack("<I", mask)
                + cls._guid(data1))

    @staticmethod
    def _plain(tag: int, ch: int, sr: int, bits: int) -> bytes:
        align = ch * bits // 8
        return struct.pack("<HHIIHHH", tag, ch, sr, sr * align, align, bits, 0)

    def test_mono_float32_extensible(self):
        # 旧病灶哨：真标签误读 mask@20 ⇒ tag=4（未知）⇒ 全零假静默；
        # comtypes 字段序错读 bits@8 ⇒ 192000 & 0xFFFF = 0xEE00。
        d = parse_wave_format(self._ext(1, 48_000, 32, 0x4, 3))
        self.assertEqual(d["tag"], 3)
        self.assertEqual(d["bits"], 32)
        self.assertEqual(d["channels"], 1)
        self.assertEqual(d["sr"], 48_000)
        self.assertTrue(d["extensible"])
        self.assertEqual(d["valid_bits"], 32)
        self.assertEqual(d["channel_mask"], 0x4)

    def test_51_float32_extensible(self):
        # 旧病灶哨：真标签误读 mask@20 ⇒ tag=63（未知）⇒ 全零假静默。
        d = parse_wave_format(self._ext(6, 48_000, 32, 0x3F, 3))
        self.assertEqual(d["tag"], 3)
        self.assertEqual(d["channels"], 6)
        self.assertEqual(d["bits"], 32)
        self.assertEqual(d["block_align"], 24)
        self.assertEqual(d["channel_mask"], 0x3F)

    def test_stereo_pcm16_extensible(self):
        # 旧病灶哨：真标签误读 mask@20 ⇒ tag=3 与 bits=16 不匹配 ⇒ 全零
        # （真标签应为 PCM=1 —— 位深与标签必须同源，H-2 的实际伤害形态）。
        d = parse_wave_format(self._ext(2, 44_100, 16, 0x3, 1))
        self.assertEqual(d["tag"], 1)
        self.assertEqual(d["bits"], 16)
        self.assertEqual(d["block_align"], 4)
        self.assertEqual(d["byterate"], 176_400)

    def test_plain_pcm_and_float_waveformatex(self):
        # 非 EXTENSIBLE 的 18B 纯 WAVEFORMATEX：tag 原样、无扩展字段
        d = parse_wave_format(self._plain(1, 2, 44_100, 16))
        self.assertEqual((d["tag"], d["bits"], d["channels"]), (1, 16, 2))
        self.assertFalse(d["extensible"])
        self.assertIsNone(d["valid_bits"])
        self.assertIsNone(d["channel_mask"])
        d2 = parse_wave_format(self._plain(3, 2, 48_000, 32))
        self.assertEqual((d2["tag"], d2["bits"]), (3, 32))

    def test_truncated_buffers_raise(self):
        # 截断（cbSize=22 但缓冲 <40B）/ 短于 18B ⇒ ValueError —— 在线读与
        # 离线夹具共用同一执法面（绝不让截断缓冲静默产出垃圾字段）。
        with self.assertRaises(ValueError):
            parse_wave_format(self._ext(2, 48_000, 32, 0x3, 3)[:30])
        with self.assertRaises(ValueError):
            parse_wave_format(b"\x01\x00\x02")

    def test_total_size_helper(self):
        # 两引擎的读长单源：EXTENSIBLE 头 ⇒ 18+cbSize；纯 WAVEFORMATEX ⇒ 18
        self.assertEqual(_wfx_total_size(self._ext(2, 48_000, 32, 0x3, 3)[:18]), 40)
        self.assertEqual(_wfx_total_size(self._plain(1, 2, 44_100, 16)), 18)
        # 短头防御：按 18 起步（parse 阶段的 ValueError 兜底执法）
        self.assertEqual(_wfx_total_size(b"\xff\xfe"), 18)

    def test_decode_branches_driven_by_parsed_tag_bits(self):
        # H-1 的实际伤害路径闭环：解析出的 (tag, bits) 必须命中 _decode_to_mono
        # 分支（旧 bits 垃圾值 ⇒ 无分支命中 ⇒ [0.0]*frames 假静默）。
        import ctypes

        pcm16 = (ctypes.c_int16 * 4)(0, 16384, -16384, 8192)
        mono = _decode_to_mono(ctypes.addressof(pcm16), 2, 2, 1, 16)
        self.assertEqual(len(mono), 2)
        self.assertAlmostEqual(mono[0], 0.25, places=9)
        self.assertAlmostEqual(mono[1], -0.125, places=9)
        flt = (ctypes.c_float * 2)(1.0, -1.0)
        self.assertAlmostEqual(_decode_to_mono(ctypes.addressof(flt), 1, 2, 3, 32)[0],
                               0.0, places=9)

    def test_both_engines_share_single_layout_source(self):
        # ΠΑΝ-83 双引擎布局一致性：comtypes 引擎不再自带 WAVEFORMATEX 定义
        # （旧 H-1 病灶所在），两引擎同经 parse_wave_format —— 模块级锚点
        # 结构体是唯一布局权威。_build_comtypes 仅返回接口三元组。
        from dsh_physical import audio

        self.assertIsInstance(audio._WaveFormatEx, type)  # 唯一锚点在场
        built = audio.WasapiLoopbackRunner._build_comtypes()
        if built is None:  # comtypes 缺席环境：诚实跳过（布局单源性不受影响）
            self.skipTest("comtypes not installed")
        self.assertEqual(len(built), 3)
        # comtypes 建链路径（py<3.14 运行臂）无法离线实测真 COM —— 解析层
        # 一致性由共享 parse_wave_format 构造性保证（诚实边界：真机
        # py<3.14 冒烟待补，见修复报告 F3-1）。
