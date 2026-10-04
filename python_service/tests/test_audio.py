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

import unittest  # noqa: E402

from dsh_physical.audio import (  # noqa: E402
    DING_DECAY,
    ERROR_LOW_RATIO,
    SAMPLE_RATE,
    SILENCE_RMS,
    AudioMonitor,
    AudioRingBuffer,
    MockRunner,
    audio_events_payload,
    classify_features,
    classify_window,
    extract_features,
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


if __name__ == "__main__":
    unittest.main()
