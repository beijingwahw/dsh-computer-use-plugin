"""W4-8 L4 声学证据通道 —— 系统音频回环的**非语义**物理证据采集。

宪法对齐（有节制的破戒）：
  - 本模块**绝不**做语音识别/说话人识别/内容转录 —— 只做 5 类非语义物理
    事件的轻量检测（通知叮声/错误提示/成功提示/按键音/静默）。声学**纹理**
    是证据，声学**内容**不是；任何把本模块推向语义识别的改动都违宪。
  - 证据权重恒低于视觉 —— 立法在 Node 端 ``src/actionVerifier.ts``
    （法条一 AUDIO_VISUAL_PRIORITY / 法条二 AUDIO_EVIDENCE_CONFIDENCE_CAP）。
    本模块只负责诚实产出 ``{event, confidence, ts}``，不参与判决仲裁。
  - 运行层绝不抛（对齐 errors.py 异常诚实第二条）：采集失败 ⇒ 诚实
    ``available=False`` + reason，``read()`` 返回空，绝不假装采到了样本。

采集（W4-8）：
  - Windows：WASAPI loopback（comtypes 驱动 IAudioClient 回环标志）；
    非 win32 / comtypes 缺席 / COM 或设备失败 ⇒ **诚实 unsupported**。
  - 全部采集经可注入 ``runner``（``read() -> list[float]``）—— 无真音频
    设备的环境注入 MockRunner 交付（mock 交付是合法形态，不是降级测试）。

检测（纯函数，零三方依赖 —— 可脱离包独立 ``python audio.py --selftest``）：
  - 特征：短时能量包络 + 过零率 + 频带比（一阶 IIR 低通 @500Hz / 高通
    @2kHz 的激活段能量占比），20ms 帧移，~2s 环形缓冲窗口；
  - 分类：阈值级联（先静默 → 按键瞬态 → 低频主导错误音 → 单音指数衰减
    叮声 → 兜底成功提示）。阈值即法条：改阈值 = 修法，必须过 ``--selftest``
    的 5 类合成波形断言。

事件输出结构（与 Node 端 actionVerifier 的 AudioEvent 契约对齐）：
  ``{"event": <五类之一>, "confidence": 0..1, "ts": <unix ms>}``
"""
from __future__ import annotations

import argparse
import math
import random
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Iterable, Protocol, runtime_checkable

# ─── 事件类型（W4-8：五类非语义物理事件 —— 与 TS 端 AudioEventKind 字面镜像）───

EVENT_KINDS: tuple[str, ...] = (
    "notification_ding",  # 通知叮声：单音、指数衰减
    "error_beep",         # 错误提示：低频主导、平包络、常双哔
    "success_chime",      # 成功提示：中高频多音/上行、较长
    "key_click",          # 按键音：极短宽带瞬态
    "silence",            # 静默：窗口内无激活帧
)

SAMPLE_RATE = 48_000  # 缺省采样率（WASAPI mix format 以实际为准；mock 用此值）

# ─── 分析参数（W4-8：阈值即法条 —— 改动需过 --selftest 五类断言）───

ANALYSIS_HOP_MS = 20        # 帧移
WINDOW_SECONDS = 2.0        # 环形缓冲窗口 ~2s
SILENCE_RMS = 0.002         # 静默门（≈ -54 dBFS）：窗口峰值能量低于此 ⇒ 静默
ACTIVE_RMS = 0.004          # 帧激活门（≈ -48 dBFS）：帧 RMS 高于此才计入激活段
LOW_BAND_HZ = 500.0         # 低/中频带分界（错误音家族的能量重心区）
HIGH_BAND_HZ = 2000.0       # 中/高频带分界
KEYCLICK_MAX_MS = 60.0      # 按键瞬态最长持续（3 帧以内）
KEYCLICK_MIN_ZCR = 0.08     # 按键瞬态最小过零率（宽带噪声特征；纯音 1kHz 仅 ~0.042）
ERROR_LOW_RATIO = 0.5       # 激活段低带能量占比 ≥ 此值 ⇒ 错误音家族
DING_DECAY = 0.35           # 叮声判定：最长 burst 后半/前半能量比 ≤ 此值（指数衰减）
DING_MAX_MS = 450.0         # 叮声最长持续（更长 ⇒ 多音家族 ⇒ 成功提示）
MIN_CONFIDENCE = 0.0
MAX_CONFIDENCE = 1.0


def _clamp01(v: float) -> float:
    return MIN_CONFIDENCE if v < MIN_CONFIDENCE else (MAX_CONFIDENCE if v > MAX_CONFIDENCE else v)


def _above(v: float, th: float) -> float:
    """v 超过门限 th 的相对裕度（0=贴线，1=裕度饱和）。"""
    return _clamp01((v - th) / th) if th > 0 else (1.0 if v > th else 0.0)


def _below(v: float, th: float) -> float:
    """v 低于门限 th 的相对裕度（0=贴线，1=裕度饱和）。"""
    return _clamp01((th - v) / th) if th > 0 else (1.0 if v < th else 0.0)


# ─── 特征提取（纯函数）───


@dataclass(frozen=True)
class WindowFeatures:
    """~2s 窗口的聚合特征 —— 分类器的全部输入（无原始波形泄漏）。"""

    peak_rms: float          # 全窗峰值帧 RMS
    active_frames: int       # 激活帧数（RMS ≥ ACTIVE_RMS）
    total_frames: int
    longest_burst_ms: float  # 最长连续激活段时长
    burst_count: int         # 激活段个数（双哔=2；多音阶=2..4）
    mean_zcr: float          # 激活段过零率（每样本符号翻转占比；纯音 ≈ 2f/sr）
    low_ratio: float         # 激活段低带（<500Hz）能量占比
    high_ratio: float        # 激活段高带（>2kHz）能量占比
    decay: float             # 最长 burst 后半/前半能量比（指数衰减 ⇒ ≪1；平包络 ≈1）


def extract_features(
    samples: Iterable[float],
    sample_rate: int = SAMPLE_RATE,
    hop_ms: int = ANALYSIS_HOP_MS,
) -> WindowFeatures:
    """短时能量包络 + 过零率 + 频带比 —— 一次线性扫描完成（无 FFT，轻量）。

    频带比用一阶 IIR：``y += a * (x - y)``，``a = 1 - exp(-2π·fc/sr)``；
    高带 = 原信号 − 2kHz 低通。防御式：空窗/非法采样率 ⇒ 全零特征
    （下游分类为 silence —— 空窗没有证据，只有缺席）。
    """
    samples = list(samples)
    if not samples or sample_rate <= 0:
        return WindowFeatures(0.0, 0, 0, 0.0, 0, 0.0, 0.0, 0.0, 0.0)

    a_low = 1.0 - math.exp(-2.0 * math.pi * LOW_BAND_HZ / sample_rate)
    a_high = 1.0 - math.exp(-2.0 * math.pi * HIGH_BAND_HZ / sample_rate)
    hop = max(1, int(sample_rate * hop_ms / 1000.0))

    # 帧统计：raw/low/high 能量和、过零数 —— 单遍扫描内联计算
    frame_sq: list[float] = []      # 每帧原始能量和
    frame_sq_low: list[float] = []
    frame_sq_high: list[float] = []
    frame_zc: list[int] = []

    y_low = 0.0
    y_hi = 0.0
    prev_x = 0.0
    sq = sq_low = sq_high = 0.0
    zc = 0
    n_in_frame = 0
    for x in samples:
        y_low += a_low * (x - y_low)
        y_hi += a_high * (x - y_hi)
        hi = x - y_hi
        sq += x * x
        sq_low += y_low * y_low
        sq_high += hi * hi
        if n_in_frame > 0 and (x >= 0.0) != (prev_x >= 0.0):
            zc += 1
        prev_x = x
        n_in_frame += 1
        if n_in_frame >= hop:
            frame_sq.append(sq)
            frame_sq_low.append(sq_low)
            frame_sq_high.append(sq_high)
            frame_zc.append(zc)
            sq = sq_low = sq_high = 0.0
            zc = 0
            n_in_frame = 0
    if n_in_frame > 0:  # 尾帧不足 hop 也入列（诚实保留残余能量）
        frame_sq.append(sq)
        frame_sq_low.append(sq_low)
        frame_sq_high.append(sq_high)
        frame_zc.append(zc)

    hop_seconds = hop / sample_rate
    active: list[bool] = []
    peak_rms = 0.0
    for s in frame_sq:
        rms = math.sqrt(s / hop)
        if rms > peak_rms:
            peak_rms = rms
        active.append(rms >= ACTIVE_RMS)

    # burst 结构：连续激活段
    bursts: list[tuple[int, int]] = []  # [start, end) 帧区间
    i = 0
    n_frames = len(frame_sq)
    while i < n_frames:
        if active[i]:
            j = i
            while j < n_frames and active[j]:
                j += 1
            bursts.append((i, j))
            i = j
        else:
            i += 1

    longest = max(bursts, key=lambda b: b[1] - b[0]) if bursts else None
    longest_burst_ms = (longest[1] - longest[0]) * hop_seconds * 1000.0 if longest else 0.0

    # 激活段能量加权频带比 + 过零率（只在有证据的帧上聚合 —— 静默段的
    # 频带比是噪声除噪声，无信息量）
    act_sq = act_sq_low = act_sq_high = 0.0
    act_zc = 0
    act_samples = 0
    for idx in range(n_frames):
        if active[idx]:
            act_sq += frame_sq[idx]
            act_sq_low += frame_sq_low[idx]
            act_sq_high += frame_sq_high[idx]
            act_zc += frame_zc[idx]
            act_samples += hop
    low_ratio = act_sq_low / act_sq if act_sq > 0 else 0.0
    high_ratio = act_sq_high / act_sq if act_sq > 0 else 0.0
    mean_zcr = act_zc / act_samples if act_samples > 0 else 0.0

    # 最长 burst 的后半/前半能量比（指数衰减判据）
    decay = 1.0
    if longest is not None:
        b0, b1 = longest
        mid = (b0 + b1) // 2
        first = sum(frame_sq[b0:mid])
        second = sum(frame_sq[mid:b1])
        decay = _clamp01(second / first) if first > 0 else 1.0

    return WindowFeatures(
        peak_rms=peak_rms,
        active_frames=sum(1 for a in active if a),
        total_frames=n_frames,
        longest_burst_ms=longest_burst_ms,
        burst_count=len(bursts),
        mean_zcr=mean_zcr,
        low_ratio=low_ratio,
        high_ratio=high_ratio,
        decay=decay,
    )


# ─── 阈值级联分类（纯函数）───


def classify_features(f: WindowFeatures) -> dict:
    """五类事件的阈值级联。置信度 = 0.5 + 0.5×裕度（贴线 0.5，饱和 1.0）
    —— 裕度取各判据最弱者（最弱环节诚实律）。

    级联次序（先具体后泛化）：
      ① 无激活帧                       ⇒ silence
      ② 极短 + 宽带（高过零率）        ⇒ key_click
      ③ 低带能量占比 ≥ 0.5             ⇒ error_beep（低音长/双哔家族）
      ④ 单 burst + 指数衰减 + ≤450ms   ⇒ notification_ding
      ⑤ 兜底（中高频多音/上行/更长）    ⇒ success_chime
    """
    if f.active_frames == 0:
        return {"event": "silence", "confidence": round(_below(f.peak_rms, SILENCE_RMS), 4)}

    if f.longest_burst_ms <= KEYCLICK_MAX_MS and f.mean_zcr >= KEYCLICK_MIN_ZCR:
        margin = min(_below(f.longest_burst_ms, KEYCLICK_MAX_MS), _above(f.mean_zcr, KEYCLICK_MIN_ZCR))
        return {"event": "key_click", "confidence": round(0.5 + 0.5 * margin, 4)}

    if f.low_ratio >= ERROR_LOW_RATIO:
        return {"event": "error_beep", "confidence": round(0.5 + 0.5 * _above(f.low_ratio, ERROR_LOW_RATIO), 4)}

    if f.decay <= DING_DECAY and f.longest_burst_ms <= DING_MAX_MS and f.burst_count == 1:
        margin = min(_below(f.decay, DING_DECAY), _below(f.longest_burst_ms, DING_MAX_MS))
        return {"event": "notification_ding", "confidence": round(0.5 + 0.5 * margin, 4)}

    # 兜底成功提示：与错误音/叮声两门的距离取最弱 —— 低占比越低、包络越平、
    # 多 burst/超时长，越是「多音上行成功音」的形态
    m_low = _below(f.low_ratio, ERROR_LOW_RATIO)
    m_decay = _above(f.decay, DING_DECAY) if f.decay > 0 else 1.0
    m_shape = 1.0 if f.burst_count > 1 else _above(f.longest_burst_ms, DING_MAX_MS)
    return {"event": "success_chime", "confidence": round(0.5 + 0.5 * min(m_low, m_decay, m_shape), 4)}


def classify_window(samples: Iterable[float], sample_rate: int = SAMPLE_RATE) -> dict:
    """整窗分类（纯函数入口）。输出 ``{event, confidence}``（ts 由采集层补）。"""
    return classify_features(extract_features(samples, sample_rate))


# ─── 环形缓冲（~2s 窗口）───


class AudioRingBuffer:
    """定长采样环 —— ``push`` 满后自动淘汰最旧样本（~2s 窗口）。"""

    def __init__(self, sample_rate: int = SAMPLE_RATE, window_seconds: float = WINDOW_SECONDS):
        self._buf: deque[float] = deque(maxlen=max(1, int(sample_rate * window_seconds)))

    def push(self, chunk: Iterable[float]) -> None:
        for x in chunk:
            self._buf.append(float(x))

    def snapshot(self) -> list[float]:
        return list(self._buf)

    def __len__(self) -> int:
        return len(self._buf)


# ─── 可注入 runner（全部采集的唯一入口）───


@runtime_checkable
class CaptureRunner(Protocol):
    """采集 runner 契约：阻塞读一块单声道采样 [-1,1]；不可用后恒返回 []。"""

    def read(self) -> list[float]: ...

    def describe(self) -> dict:
        """诚实能力声明：{available, backend, reason?}。"""
        ...


class MockRunner:
    """脚本化 mock runner —— 无真音频设备时的交付路径（W4-8 mock 交付）。

    ``script`` 为采样块列表，``read()`` 逐块弹出；耗尽后返回 []
    （等价「通道静默」，绝不凭空造样本）。确定性：内部不引入随机性。
    """

    def __init__(self, script: list[list[float]] | None = None, sample_rate: int = SAMPLE_RATE):
        self._script = list(script or [])
        self._sample_rate = sample_rate
        self._exhausted = False

    def read(self) -> list[float]:
        if self._script:
            return self._script.pop(0)
        self._exhausted = True
        return []

    def describe(self) -> dict:
        return {
            "available": True,
            "backend": "mock",
            "sample_rate": self._sample_rate,
            "exhausted": self._exhausted,
        }

    @property
    def sample_rate(self) -> int:
        return self._sample_rate


class WasapiLoopbackRunner:
    """WASAPI 系统回环 runner（Windows；comtypes 驱动，缺席 ⇒ 诚实 unsupported）。

    生命周期防御式（运行层绝不抛）：
      - 构造零副作用（COM 延迟到 ``_ensure_session``）；
      - 任一环节失败 ⇒ ``_reason`` 记因、``read()`` 恒 []，绝不 raise；
      - 读循环中途失败 ⇒ 会话标记死亡，等价通道缺席。
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._session: dict | None = None  # {client, capture, channels, fmt, sr}
        self._reason: str | None = None
        self._dead = False

    # ── COM 接口与常量（audioclient.h / mmdeviceapi.h；方法序 = vtable 序）──

    @staticmethod
    def _build_comtypes() -> tuple[object, ...] | None:
        """构建 WASAPI 所需的 comtypes 接口定义集；失败返回 None。"""
        try:
            import ctypes  # noqa: PLC0415 —— 仅 win32/comtypes 在场时才加载
            from comtypes import COMMETHOD, GUID, HRESULT, IUnknown  # type: ignore
        except Exception:  # noqa: BLE001 —— comtypes 缺席 = 诚实 unsupported，不是错误
            return None
        from ctypes import (  # type: ignore
            POINTER, c_longlong, c_uint, c_uint32, c_ulonglong, c_ushort, c_void_p, c_wchar_p,
        )

        class IMMDevice(IUnknown):  # type: ignore[misc, valid-type]
            _iid_ = GUID("{d666063f-1587-4e43-81f1-b948ab4b23c3}")
            _methods_ = [
                COMMETHOD([], HRESULT, "Activate",
                          (["in"], POINTER(GUID), "iid"),
                          (["in"], c_uint32, "dwClsCtx"),
                          (["in"], c_void_p, "pActivationParams"),
                          (["out"], POINTER(c_void_p), "ppInterface")),
                COMMETHOD([], HRESULT, "OpenPropertyStore",
                          (["in"], c_uint32, "stgmAccess"),
                          (["out"], POINTER(c_void_p), "ppProperties")),
                COMMETHOD([], HRESULT, "GetId",
                          (["out"], POINTER(c_wchar_p), "ppstrId")),
                COMMETHOD([], HRESULT, "GetState",
                          (["out"], POINTER(c_uint32), "pdwState")),
            ]

        class IMMDeviceEnumerator(IUnknown):  # type: ignore[misc, valid-type]
            _iid_ = GUID("{a95664d2-9614-4f35-a746-de8db63617e6}")
            _methods_ = [
                COMMETHOD([], HRESULT, "EnumAudioEndpoints",
                          (["in"], c_uint32, "dataFlow"),
                          (["in"], c_uint32, "stateMask"),
                          (["out"], POINTER(c_void_p), "ppDevices")),
                COMMETHOD([], HRESULT, "GetDefaultAudioEndpoint",
                          (["in"], c_uint32, "dataFlow"),
                          (["in"], c_uint32, "role"),
                          (["out"], POINTER(IMMDevice), "ppEndpoint")),
                COMMETHOD([], HRESULT, "GetDevice",
                          (["in"], c_wchar_p, "pwstrId"),
                          (["out"], POINTER(IMMDevice), "ppDevice")),
                COMMETHOD([], HRESULT, "RegisterEndpointNotificationCallback",
                          (["in"], c_void_p, "pNotify")),
                COMMETHOD([], HRESULT, "UnregisterEndpointNotificationCallback",
                          (["in"], c_void_p, "pNotify")),
            ]

        class IAudioClient(IUnknown):  # type: ignore[misc, valid-type]
            _iid_ = GUID("{1cb9ad4c-dbfa-4c32-b178-c2f568a703b2}")
            _methods_ = [
                COMMETHOD([], HRESULT, "Initialize",
                          (["in"], c_uint32, "ShareMode"),
                          (["in"], c_uint32, "StreamFlags"),
                          (["in"], c_longlong, "hnsBufferDuration"),
                          (["in"], c_longlong, "hnsPeriodicity"),
                          (["in"], c_void_p, "pFormat"),
                          (["in"], c_void_p, "pAudioSessionGuid")),
                COMMETHOD([], HRESULT, "GetBufferSize",
                          (["out"], POINTER(c_uint32), "pNumBufferFrames")),
                COMMETHOD([], HRESULT, "GetStreamLatency",
                          (["out"], POINTER(c_longlong), "phnsLatency")),
                COMMETHOD([], HRESULT, "GetCurrentPadding",
                          (["out"], POINTER(c_uint32), "pNumPaddingFrames")),
                COMMETHOD([], HRESULT, "IsFormatSupported",
                          (["in"], c_uint32, "ShareMode"),
                          (["in"], c_void_p, "pFormat"),
                          (["out"], POINTER(c_void_p), "ppClosestMatch")),
                COMMETHOD([], HRESULT, "GetMixFormat",
                          (["out"], POINTER(c_void_p), "ppDeviceFormat")),
                COMMETHOD([], HRESULT, "GetDevicePeriod",
                          (["out"], POINTER(c_longlong), "phnsDefaultDevicePeriod"),
                          (["out"], POINTER(c_longlong), "phnsMinimumDevicePeriod")),
                COMMETHOD([], HRESULT, "Start"),
                COMMETHOD([], HRESULT, "Stop"),
                COMMETHOD([], HRESULT, "Reset"),
                COMMETHOD([], HRESULT, "SetEventHandle",
                          (["in"], c_void_p, "eventHandle")),
                COMMETHOD([], HRESULT, "GetService",
                          (["in"], POINTER(GUID), "riid"),
                          (["out"], POINTER(c_void_p), "ppv")),
            ]

        class IAudioCaptureClient(IUnknown):  # type: ignore[misc, valid-type]
            _iid_ = GUID("{c8adbd64-e71e-48a0-a4de-185c395cd317}")
            _methods_ = [
                COMMETHOD([], HRESULT, "GetBuffer",
                          (["out"], POINTER(c_void_p), "ppData"),
                          (["out"], POINTER(c_uint32), "pNumFramesToRead"),
                          (["out"], POINTER(c_uint32), "pFlags"),
                          (["out"], POINTER(c_ulonglong), "pu64DevicePosition"),
                          (["out"], POINTER(c_ulonglong), "pu64QPCPosition")),
                COMMETHOD([], HRESULT, "ReleaseBuffer",
                          (["in"], c_uint32, "NumFramesRead")),
                COMMETHOD([], HRESULT, "GetNextPacketSize",
                          (["out"], POINTER(c_uint32), "pNumFramesInNextPacket")),
            ]

        class WAVEFORMATEX(ctypes.Structure):  # type: ignore[misc]
            _fields_ = [
                ("wFormatTag", c_ushort),
                ("nChannels", c_ushort),
                ("nSamplesPerSec", c_uint),
                ("wBitsPerSample", c_ushort),
                ("nBlockAlign", c_ushort),
                ("nAvgBytesPerSec", c_uint),
                ("cbSize", c_ushort),
            ]

        return (IMMDeviceEnumerator, IAudioClient, IAudioCaptureClient, WAVEFORMATEX)

    def _ensure_session(self) -> dict | None:
        """惰性建立 WASAPI loopback 会话；失败记因返回 None（绝不抛）。"""
        with self._lock:
            if self._dead:
                return None
            if self._session is not None:
                return self._session
            if self._reason is not None:
                return None
            session = self._open_session()
            if session is None:
                return None
            self._session = session
            return session

    def _open_session(self) -> dict | None:
        if sys.platform != "win32":
            self._reason = "unsupported platform: WASAPI loopback is Windows-only"
            return None
        built = self._build_comtypes()
        if built is None:
            self._reason = "comtypes unavailable (pip install comtypes) — honest unsupported"
            return None
        try:
            import ctypes
            import comtypes
            Enumerator, AudioClient, CaptureClient, WaveFormatEx = built

            CLSID_MMDeviceEnumerator = comtypes.GUID("{bcde0395-e52f-467c-8e3d-c4579291692e}")
            IID_IAudioClient = comtypes.GUID("{1cb9ad4c-dbfa-4c32-b178-c2f568a703b2}")
            IID_IAudioCaptureClient = comtypes.GUID("{c8adbd64-e71e-48a0-a4de-185c395cd317}")
            CLSCTX_ALL = 0x17
            AUDCLNT_SHAREMODE_SHARED = 0
            AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000
            AUDCLNT_BUFFERFLAGS_SILENT = 0x2
            eRender, eConsole = 0, 0

            try:
                comtypes.CoInitializeEx(comtypes.COINIT_MULTITHREADED)
            except Exception:  # noqa: BLE001 —— 已初始化（异模式）等场景：沿用现状
                pass

            enumerator = comtypes.CoCreateInstance(
                CLSID_MMDeviceEnumerator, Enumerator, clsctx=CLSCTX_ALL,
            )
            device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)

            pv_client = device.Activate(
                ctypes.byref(IID_IAudioClient), CLSCTX_ALL, None,
            )
            client = ctypes.cast(pv_client, ctypes.POINTER(AudioClient)).contents

            pv_fmt = client.GetMixFormat()
            fmt = ctypes.cast(pv_fmt, ctypes.POINTER(WaveFormatEx)).contents
            format_tag = int(fmt.wFormatTag)
            bits = int(fmt.wBitsPerSample)
            channels = max(1, int(fmt.nChannels))
            sample_rate = int(fmt.nSamplesPerSec)
            if format_tag == 0xFFFE and int(fmt.cbSize) >= 22:
                # WAVEFORMATEXTENSIBLE：SubFormat GUID 首 2 字节才是真格式标签
                ext = ctypes.cast(
                    pv_fmt, ctypes.POINTER(ctypes.c_ubyte * (ctypes.sizeof(WaveFormatEx) + int(fmt.cbSize)),
                )).contents
                format_tag = ext[ctypes.sizeof(WaveFormatEx)] | (ext[ctypes.sizeof(WaveFormatEx) + 1] << 8)

            client.Initialize(
                AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
                20_000_000, 0,                       # 2s 缓冲（hns），与 ~2s 分析窗对齐
                ctypes.cast(pv_fmt, ctypes.c_void_p),  # mix format 原样回传（回环必须用设备格式）
                None,
            )
            client.Start()

            pv_capture = client.GetService(ctypes.byref(IID_IAudioCaptureClient))
            capture = ctypes.cast(pv_capture, ctypes.POINTER(CaptureClient)).contents

            return {
                "client": client,
                "capture": capture,
                "channels": channels,
                "bits": bits,
                "format_tag": format_tag,
                "sr": sample_rate,
                "silent_flag": AUDCLNT_BUFFERFLAGS_SILENT,
                "wave_format_ptr": pv_fmt,  # 保活：mix format 内存归 IAudioClient 生命周期管
            }
        except Exception as e:  # noqa: BLE001 —— 运行层铁律：绝不抛
            self._reason = f"wasapi loopback unavailable: {type(e).__name__}: {e}"
            return None

    def read(self) -> list[float]:
        """读一块（≤200ms）单声道采样；失败/缺席 ⇒ []（绝不抛）。"""
        session = self._ensure_session()
        if session is None:
            return []
        try:
            import ctypes
            capture = session["capture"]
            channels = session["channels"]
            packet = ctypes.c_uint32(0)
            if capture.GetNextPacketSize(ctypes.byref(packet)) != 0 or packet.value == 0:
                return []
            out: list[float] = []
            while packet.value > 0:
                data = ctypes.c_void_p()
                frames = ctypes.c_uint32(0)
                flags = ctypes.c_uint32(0)
                hr = capture.GetBuffer(
                    ctypes.byref(data), ctypes.byref(frames), ctypes.byref(flags),
                    None, None,
                )
                if hr != 0:
                    break
                n = frames.value
                if flags.value & session["silent_flag"] or not data.value:
                    out.extend([0.0] * n)
                else:
                    out.extend(self._decode(data.value, n, channels, session))
                capture.ReleaseBuffer(n)
                if capture.GetNextPacketSize(ctypes.byref(packet)) != 0:
                    break
            return out
        except Exception as e:  # noqa: BLE001 —— 读失败 = 通道死亡（诚实缺席）
            with self._lock:
                self._dead = True
                self._reason = f"wasapi read failed: {type(e).__name__}: {e}"
            return []

    @staticmethod
    def _decode(addr: int, frames: int, channels: int, session: dict) -> list[float]:
        import ctypes
        total = frames * channels
        tag = session["format_tag"]
        bits = session["bits"]
        if tag == 3 and bits == 32:  # IEEE float32（共享模式 mix format 最常见）
            arr = (ctypes.c_float * total).from_address(addr)
            raw = list(arr)
        elif tag == 1 and bits == 32:  # PCM int32
            arr = (ctypes.c_int32 * total).from_address(addr)
            raw = [v / 2147483648.0 for v in arr]
        elif tag == 1 and bits == 16:  # PCM int16
            arr = (ctypes.c_int16 * total).from_address(addr)
            raw = [v / 32768.0 for v in arr]
        else:  # 未知编码：宁可缺席不可造假
            return [0.0] * frames
        if channels == 1:
            return raw
        return [
            sum(raw[i * channels:(i + 1) * channels]) / channels
            for i in range(frames)
        ]

    def describe(self) -> dict:
        with self._lock:
            info: dict = {"available": not self._dead and self._reason is None, "backend": "wasapi-loopback"}
            if self._reason is not None:
                info["reason"] = self._reason
            if self._session is not None:
                info["sample_rate"] = self._session["sr"]
                info["channels"] = self._session["channels"]
            return info


# ─── 监视器：环形缓冲 + 窗口分类 + 事件产出（防御式绝不抛）───


class AudioMonitor:
    """~2s 环形缓冲上的五类事件检测器。

    - ``drain_once()``：从 runner 同步读一块入环（mock/测试路径）；
    - ``start()``/``stop()``：后台守护线程持续入环（真机 WASAPI 路径）；
    - ``detect()``：当前窗口五类判决（通道不可用 ⇒ None —— 诚实缺席，
      绝不把「没采到」伪装成「静默」）；
    - ``poll()``：边沿触发 —— 判决类别相对上次产出变化时才返回事件
      （防同类刷屏），否则 None。
    """

    def __init__(self, runner: CaptureRunner, sample_rate: int | None = None):
        self._runner = runner
        sr = sample_rate if sample_rate is not None else getattr(runner, "sample_rate", SAMPLE_RATE)
        self._sample_rate = int(sr)
        self._ring = AudioRingBuffer(self._sample_rate)
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop_flag = threading.Event()
        self._last_emitted: str | None = None

    # ── 采集 ──

    def drain_once(self) -> int:
        """同步读一块入环，返回入环样本数（防御式：read 永不抛）。"""
        try:
            chunk = self._runner.read()
        except Exception:  # noqa: BLE001 —— runner 故障 = 本块缺席
            chunk = []
        if not chunk:
            return 0
        with self._lock:
            self._ring.push(chunk)
        return len(chunk)

    def start(self) -> bool:
        """启动后台采集线程。runner 声明不可用 ⇒ False（诚实，不装启动）。

        MockRunner 不起线程（脚本有限，``ensure_started`` 会同步耗尽）。
        """
        if isinstance(self._runner, MockRunner):
            return True
        if not self._runner.describe().get("available", False):
            return False
        if self._thread is not None and self._thread.is_alive():
            return True
        self._stop_flag.clear()
        self._thread = threading.Thread(target=self._drain_loop, daemon=True,
                                        name="dsh-audio-loopback")
        self._thread.start()
        return True

    def stop(self) -> None:
        self._stop_flag.set()
        t = self._thread
        if t is not None and t.is_alive():
            t.join(timeout=1.0)
        self._thread = None

    def _drain_loop(self) -> None:
        while not self._stop_flag.is_set():
            n = self.drain_once()
            if n == 0:
                self._stop_flag.wait(0.02)  # 空转让路（20ms —— WASAPI 包间隔量级）

    def ensure_started(self) -> dict:
        """端点友好的启动：mock ⇒ 同步耗尽脚本；真机 ⇒ 惰性建链 + 起线程
        稍候首填。返回 runner **终态**能力声明（建链尝试之后的诚实信封 ——
        构造期零副作用 ⇒ 未建链前 describe 恒乐观，必须重读）。"""
        if isinstance(self._runner, MockRunner):
            while self.drain_once() > 0:
                pass
            return self._runner.describe()
        self.drain_once()  # 触发惰性建链（失败 ⇒ _reason 记因，read 返回空）
        desc = self._runner.describe()
        if desc.get("available", False):
            self.start()
            deadline = time.time() + 0.2
            while time.time() < deadline and len(self._ring) < self._sample_rate // 10:
                self.drain_once()
                time.sleep(0.01)
            desc = self._runner.describe()  # 读链可能中途死亡 —— 终态重读
        return desc

    # ── 判决 ──

    def detect(self) -> dict | None:
        """当前窗口五类判决 ``{event, confidence, ts}``；通道不可用 ⇒ None。"""
        if not self._runner.describe().get("available", False):
            return None
        with self._lock:
            snapshot = self._ring.snapshot()
        verdict = classify_window(snapshot, self._sample_rate)
        return {"event": verdict["event"], "confidence": verdict["confidence"],
                "ts": int(time.time() * 1000)}

    def poll(self) -> dict | None:
        """边沿触发事件流：类别变化才发（含进入/离开静默的边沿）。"""
        ev = self.detect()
        if ev is None:
            return None
        if ev["event"] == self._last_emitted:
            return None
        self._last_emitted = ev["event"]
        return ev

    def describe(self) -> dict:
        try:
            desc = dict(self._runner.describe())
        except Exception:  # noqa: BLE001
            desc = {"available": False, "backend": "unknown", "reason": "describe() raised"}
        desc["window_ms"] = int(WINDOW_SECONDS * 1000)
        desc["buffered_samples"] = len(self._ring)
        return desc


# ─── 共享单例 + 端点信封（注册行见 W4-8 集成报告）───

_shared_monitor: AudioMonitor | None = None
_shared_lock = threading.Lock()


def get_shared_monitor() -> AudioMonitor:
    """进程级共享监视器（缺省 WASAPI 回环；测试可 ``set_shared_monitor`` 注入 mock）。"""
    global _shared_monitor
    with _shared_lock:
        if _shared_monitor is None:
            _shared_monitor = AudioMonitor(WasapiLoopbackRunner())
        return _shared_monitor


def set_shared_monitor(monitor: AudioMonitor | None) -> None:
    """测试/嵌入方注入面（W4-8：mock 交付的接入口）。"""
    global _shared_monitor
    with _shared_lock:
        _shared_monitor = monitor


def audio_events_payload(monitor: AudioMonitor | None = None) -> dict:
    """/v1/audio_events 端点信封（防御式绝不抛）：

    ``{available, backend, window_ms, event: {event, confidence, ts} | None}``
    —— ``event=None`` 仅出现在通道不可用（诚实缺席，非静默）。
    """
    try:
        mon = monitor if monitor is not None else get_shared_monitor()
        desc = mon.ensure_started()
        payload: dict = {
            "available": bool(desc.get("available", False)),
            "backend": str(desc.get("backend", "unknown")),
            "window_ms": int(WINDOW_SECONDS * 1000),
        }
        if not payload["available"]:
            payload["reason"] = str(desc.get("reason", "capture backend unavailable"))
            payload["event"] = None
            return payload
        payload["event"] = mon.detect()
        return payload
    except Exception as e:  # noqa: BLE001 —— 运行层铁律：绝不抛
        return {
            "available": False,
            "backend": "error",
            "window_ms": int(WINDOW_SECONDS * 1000),
            "reason": f"{type(e).__name__}: {e}",
            "event": None,
        }


# ─── 合成波形工坊（--selftest 的 5 类断言夹具 —— 确定性，无随机）───


def _sine_burst(freq: float, ms: float, amp: float, decay_ms: float | None = None,
                sr: int = SAMPLE_RATE) -> list[float]:
    """单音突发；``decay_ms`` 给出指数衰减包络（None = 平包络）。"""
    n = int(sr * ms / 1000.0)
    tau = (decay_ms / 1000.0) if decay_ms else None
    out: list[float] = []
    for i in range(n):
        t = i / sr
        env = amp * (math.exp(-t / tau) if tau else 1.0)
        out.append(env * math.sin(2.0 * math.pi * freq * t))
    return out


def _zeros(ms: float, sr: int = SAMPLE_RATE) -> list[float]:
    return [0.0] * int(sr * ms / 1000.0)


def synth_notification_ding(sr: int = SAMPLE_RATE) -> list[float]:
    """通知叮声：单音 880Hz、220ms、指数衰减（τ=60ms）—— 单 burst + 衰减形态。"""
    return (_zeros(400, sr)
            + _sine_burst(880.0, 220.0, 0.5, decay_ms=60.0, sr=sr)
            + _zeros(1400, sr))


def synth_error_beep(sr: int = SAMPLE_RATE) -> list[float]:
    """错误提示：低频主导（220Hz+660Hz 谐波）、平包络、双哔（200ms×2，隔 100ms）。"""
    def dual(ms: float) -> list[float]:
        a = _sine_burst(220.0, ms, 0.7, sr=sr)
        b = _sine_burst(660.0, ms, 0.21, sr=sr)
        return [x + y for x, y in zip(a, b)]
    return (_zeros(400, sr) + dual(200.0) + _zeros(100.0) + dual(200.0)
            + _zeros(1100, sr))


def synth_success_chime(sr: int = SAMPLE_RATE) -> list[float]:
    """成功提示：三音上行（C6-E6-G6：1046/1318/1568Hz）、缓衰减、总 ~590ms。"""
    notes = ((1046.0, 150.0), (1318.0, 150.0), (1568.0, 250.0))
    out = _zeros(400, sr)
    for freq, ms in notes:
        out += _sine_burst(freq, ms, 0.5, decay_ms=1500.0, sr=sr)
        out += _zeros(30.0, sr=sr)
    out += _zeros(1000, sr)
    return out[:int(sr * WINDOW_SECONDS)]


def synth_key_click(sr: int = SAMPLE_RATE) -> list[float]:
    """按键音：8ms 宽带瞬态（确定性伪随机 —— 种子固定）。"""
    rng = random.Random(4242)
    click = [rng.uniform(-0.6, 0.6) for _ in range(int(sr * 0.008))]
    return _zeros(500, sr) + click + _zeros(int(WINDOW_SECONDS * 1000) - 508, sr)


def synth_silence(sr: int = SAMPLE_RATE) -> list[float]:
    """静默：本底噪声 1e-5（低于静默门两个量级）。"""
    rng = random.Random(7)
    return [rng.uniform(-1e-5, 1e-5) for _ in range(int(sr * WINDOW_SECONDS))]


# ─── 自测（合成波形 + mock 注入 —— exit 0 = 五类分类全对）───


def run_selftest() -> int:
    cases: list[tuple[str, list[float]]] = [
        ("notification_ding", synth_notification_ding()),
        ("error_beep", synth_error_beep()),
        ("success_chime", synth_success_chime()),
        ("key_click", synth_key_click()),
        ("silence", synth_silence()),
    ]
    failures: list[str] = []
    for expected, wave in cases:
        verdict = classify_window(wave, SAMPLE_RATE)
        ok = verdict["event"] == expected and 0.0 <= verdict["confidence"] <= 1.0
        status = "OK " if ok else "FAIL"
        print(f"[{status}] expected={expected:<17} got={verdict['event']:<17} "
              f"confidence={verdict['confidence']:.4f}")
        if not ok:
            failures.append(f"{expected} -> {verdict}")

    # mock 注入端到端：脚本化 runner → 环形缓冲 → 窗口判决 → 边沿触发事件流
    ding_wave = synth_notification_ding()
    chunk = SAMPLE_RATE // 20  # 50ms 块
    script = [ding_wave[i:i + chunk] for i in range(0, len(ding_wave), chunk)]
    mon = AudioMonitor(MockRunner(script))
    saved = _shared_monitor
    set_shared_monitor(mon)
    try:
        payload = audio_events_payload(mon)
        if not (payload["available"] and payload["event"]
                and payload["event"]["event"] == "notification_ding"):
            failures.append(f"mock e2e payload: {payload}")
            print(f"[FAIL] mock e2e payload: {payload}")
        else:
            print(f"[OK ] mock e2e via audio_events_payload: {payload['event']}")
        first = mon.poll()
        second = mon.poll()
        if not (first and first["event"] == "notification_ding" and second is None):
            failures.append(f"edge-trigger poll: first={first} second={second}")
            print(f"[FAIL] edge-trigger poll: first={first} second={second}")
        else:
            print("[OK ] edge-trigger poll: 变化沿产出 / 同类抑制")
    finally:
        set_shared_monitor(saved)

    # 诚实 unsupported：comtypes 缺席 / 非 win32 / 无设备 ⇒ available=False
    # ⇒ 端点信封必须 event=None（「没采到」绝不伪装成「静默」）。
    # 先 read() 一次触发惰性建链（构造零副作用 ⇒ describe 在建链前恒乐观）
    probe = WasapiLoopbackRunner()
    probe.read()
    desc = probe.describe()
    if not desc.get("available", False):
        payload_unsupported = audio_events_payload(AudioMonitor(WasapiLoopbackRunner()))
        if payload_unsupported["available"] or payload_unsupported["event"] is not None:
            failures.append(f"unsupported must be honest: {payload_unsupported}")
            print(f"[FAIL] unsupported honesty: {payload_unsupported}")
        else:
            print(f"[OK ] honest unsupported: {payload_unsupported['reason']}")

    if failures:
        print(f"audio selftest FAILED ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("audio selftest OK: 5/5 classes + mock e2e + edge-trigger"
          + (" + honest-unsupported" if not desc.get("available", False) else ""))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="W4-8 L4 声学证据通道（非语义物理证据）")
    parser.add_argument("--selftest", action="store_true",
                        help="合成波形（mock 注入）断言 5 类事件分类正确")
    args = parser.parse_args(argv)
    if args.selftest:
        return run_selftest()
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
