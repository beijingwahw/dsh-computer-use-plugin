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

采集（W4-8；ΑΩ-R1 双引擎分治）：
  - Windows：WASAPI loopback 按 ``sys.version_info`` 分流 —— Python ≥3.14 走
    **原始 vtable** 引擎（纯 ctypes 手写 vtable 调用；py3.14 的 ctypes 出参
    约定回归使 comtypes 接口出参不可用，实证在案 real_probe D-A4），低版本
    保留 comtypes 路径（行为零回归）；两路共用同一 PCM 解码与上层分类器。
    非 win32 / 引擎缺席 / COM 或设备失败 ⇒ **诚实 unsupported**。
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
import ctypes
import math
import random
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Iterable, Protocol, runtime_checkable

# ΝΩ-36(c):特征扫描 numpy 分块向量化(numpy 可用性核对后启用;缺席 ⇒
# 纯 Python 逐样本路径原样保留 —— 行为零回归,selftest 无 numpy 也可跑)。
try:
    import numpy as _np  # noqa: N813
except Exception:  # noqa: BLE001 —— numpy 缺席 = 性能降级,不是能力缺席
    _np = None

# ─── ΑΩ-R1（D-E2）：WASAPI 引擎分治 ───
# py3.14 的 _ctypes 对 comtypes 接口类型的出参触发约定回归
# （「'out' parameter must be passed as default value」—— real_probe D-A4 报文
# 在案），故 ≥3.14 首选**原始 vtable** 引擎（纯 ctypes，零 paramflags 依赖，
# 版本无关地可用）；低版本保留 comtypes（零回归）。原始 vtable 链路已经
# D-A4 真机闭环验证（真播放 → 回环 → 分类 = notification_ding）。
_USE_RAW_VTABLE = sys.version_info >= (3, 14)

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

# ─── ΝΩ-36：VAD 预门 + 声学指纹（性能与刷屏治理）───
# (a) 能量 VAD 预门：峰值帧 RMS < SILENCE_RMS 的窗口（真实占空比最高）直接
#     silence 快径，跳过 IIR×2 + 过零全特征扫描；
# (b) 激活段 8 带能量比 → 量化声学指纹；同指纹激活窗口聚合计数 —— 同一
#     提示音重复播放不每沿一报（FINGERPRINT_WINDOW_S 内同指纹 = 同一系列）。
FINGERPRINT_BANDS = 8         # 指纹频带数（几何分带）
FINGERPRINT_WINDOW_S = 30.0   # 同指纹聚合窗（秒）


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


def _peak_frame_rms(samples: list[float], hop: int) -> tuple[float, int]:
    """ΝΩ-36(a) VAD 预门数据：峰值帧 RMS + 帧数（纯能量，无 IIR/过零）。

    分帧与全特征扫描**逐帧一致**（整数 hop 分块 + 尾帧）；帧 RMS 分母一律
    ``hop``（尾帧亦然 —— 与全扫描 ``sqrt(s/hop)`` 的方言逐字段对齐）⇒ 所得
    峰值与全扫描的 ``peak_rms`` 相等（浮点求和顺序差异 ≤ 1e-15 相对量级）。
    numpy 在场 ⇒ 向量化（reshape 均值）；缺席 ⇒ 纯 Python 块循环（仍省去
    全扫描的 IIR×2 + 过零 —— 预门自身的开销有界且远轻）。
    """
    n = len(samples)
    n_frames = (n + hop - 1) // hop
    if _np is not None:
        arr = _np.asarray(samples, dtype=_np.float64)
        sq = arr * arr
        n_full = n // hop
        best_ms = 0.0
        if n_full:
            best_ms = float(sq[: n_full * hop].reshape(n_full, hop).mean(axis=1).max())
        tail = sq[n_full * hop:]
        if tail.size:
            best_ms = max(best_ms, float(tail.sum()) / hop)  # 尾帧分母同为 hop
        return math.sqrt(max(0.0, best_ms)), n_frames
    best_ms = 0.0  # 帧均方值（分母一律 hop；开方推迟到 return）
    sq = 0.0
    n_in = 0
    for x in samples:
        sq += x * x
        n_in += 1
        if n_in >= hop:
            ms = sq / hop
            if ms > best_ms:
                best_ms = ms
            sq = 0.0
            n_in = 0
    if n_in and sq / hop > best_ms:  # 尾帧：分母仍为 hop（全扫描方言）
        best_ms = sq / hop
    return math.sqrt(max(0.0, best_ms)), n_frames


def _np_one_pole(x: "_np.ndarray", a: float) -> "_np.ndarray":
    """一阶 IIR 低通 ``y[n] = (1-a)·y[n-1] + a·x[n]``（y[-1]=0）的 numpy 等价实现。

    闭式解 = 与指数核 ``a·(1-a)^k`` 的全卷积 —— FFT 卷积 O(n log n) 完成顺序
    递推（ΝΩ-36(c)）。核在尾权 < 1e-9 处截断（L ≈ 317 @500Hz/80 @2kHz ——
    实测 2.4× 快于全核；截断偏差 ~1e-9 相对，阈值级联与双路径等价断言均无感）。
    """
    n = x.size
    if n == 0:
        return x
    decay = 1.0 - a
    ell = min(n, max(1, math.ceil(math.log(1e-9) / math.log(decay))))
    kernel = a * decay ** _np.arange(ell, dtype=_np.float64)
    nfft = 1 << (n + ell - 2).bit_length()  # ≥ n+L-1 的最小 2 幂(线性卷积无环绕)
    y = _np.fft.irfft(_np.fft.rfft(x, nfft) * _np.fft.rfft(kernel, nfft), nfft)
    return y[:n]


def _frame_stats_np(
    samples: list[float], a_low: float, a_high: float, hop: int,
) -> tuple[list[float], list[float], list[float], list[int]]:
    """ΝΩ-36(c)：numpy 分块向量化的帧统计（raw/low/high 能量和 + 过零数）。

    与纯 Python 路径逐字段等价（IIR 闭式卷积 + reduceat 分帧求和 + 帧内
    符号翻转计数 —— 帧首样本不计，与 ``_frame_stats_python`` 的
    ``n_in_frame > 0`` 守卫逐位一致）。
    """
    arr = _np.asarray(samples, dtype=_np.float64)
    n = arr.size
    y_low = _np_one_pole(arr, a_low)
    hi = arr - _np_one_pole(arr, a_high)  # 高带 = 原信号 − 2kHz 低通
    sq = arr * arr
    sq_low = y_low * y_low
    sq_high = hi * hi
    ge = arr >= 0.0
    zc_flags = _np.zeros(n, dtype=_np.int64)
    if n > 1:
        zc_flags[1:] = (ge[1:] != ge[:-1]).astype(_np.int64)
    n_full = n // hop
    offsets = _np.arange(n_full + (1 if n % hop else 0)) * hop
    zc_flags[offsets] = 0  # 帧首样本的跨帧翻转不计（对齐纯 Python 守卫）
    return (
        _np.add.reduceat(sq, offsets).tolist(),
        _np.add.reduceat(sq_low, offsets).tolist(),
        _np.add.reduceat(sq_high, offsets).tolist(),
        _np.add.reduceat(zc_flags, offsets).tolist(),
    )


def _frame_stats_python(
    samples: list[float], a_low: float, a_high: float, hop: int,
) -> tuple[list[float], list[float], list[float], list[int]]:
    """纯 Python 逐样本路径（numpy 缺席的降级 —— 与 W4-8 原实现逐字段一致）。"""
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
    return frame_sq, frame_sq_low, frame_sq_high, frame_zc


def extract_features(
    samples: Iterable[float],
    sample_rate: int = SAMPLE_RATE,
    hop_ms: int = ANALYSIS_HOP_MS,
) -> WindowFeatures:
    """短时能量包络 + 过零率 + 频带比 —— 一次线性扫描完成（无 FFT 特征语义，
    轻量）。频带比用一阶 IIR：``y += a * (x - y)``，``a = 1 - exp(-2π·fc/sr)``；
    高带 = 原信号 − 2kHz 低通。防御式：空窗/非法采样率 ⇒ 全零特征
    （下游分类为 silence —— 空窗没有证据，只有缺席）。

    ΝΩ-36 改造（行为零回归）：
      (a) 能量 VAD 预门：峰值帧 RMS < SILENCE_RMS ⇒ 全帧必低于 ACTIVE_RMS
          （SILENCE_RMS < ACTIVE_RMS）⇒ 判决必为 silence —— 直接返回与全
          扫描**逐字段相等**的零激活特征，跳过 IIR×2 + 过零全扫描（静默窗
          是真实占空比最高的窗口形态）；
      (c) 非静默窗的帧统计走 numpy 分块向量化（IIR 闭式 FFT 卷积 + reduceat
          分帧；numpy 缺席 ⇒ 纯 Python 原路径原样保留）。
    """
    samples = list(samples)
    if not samples or sample_rate <= 0:
        return WindowFeatures(0.0, 0, 0, 0.0, 0, 0.0, 0.0, 0.0, 0.0)

    a_low = 1.0 - math.exp(-2.0 * math.pi * LOW_BAND_HZ / sample_rate)
    a_high = 1.0 - math.exp(-2.0 * math.pi * HIGH_BAND_HZ / sample_rate)
    hop = max(1, int(sample_rate * hop_ms / 1000.0))

    # ── ΝΩ-36(a) 能量 VAD 预门（分帧与全扫描逐帧一致 ⇒ 快径输出 == 全扫描输出）──
    peak_rms, n_frames = _peak_frame_rms(samples, hop)
    if peak_rms < SILENCE_RMS:
        return WindowFeatures(
            peak_rms=peak_rms, active_frames=0, total_frames=n_frames,
            longest_burst_ms=0.0, burst_count=0, mean_zcr=0.0,
            low_ratio=0.0, high_ratio=0.0, decay=1.0,
        )

    # ── 帧统计：raw/low/high 能量和、过零数（ΝΩ-36(c) 双路径）──
    if _np is not None:
        frame_sq, frame_sq_low, frame_sq_high, frame_zc = _frame_stats_np(
            samples, a_low, a_high, hop)
    else:
        frame_sq, frame_sq_low, frame_sq_high, frame_zc = _frame_stats_python(
            samples, a_low, a_high, hop)

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


# ─── ΝΩ-36(b)：激活段 8 带能量比 → 声学指纹（去重的判别面）───

# 几何分带边界（Hz）：8 带 = [<125, 125-250, 250-500, 500-1k, 1k-2k, 2k-4k, 4k-8k, >8k]
_FINGERPRINT_EDGES_HZ = (125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0)


def _quantize_ratios(energies: list[float]) -> str:
    """带能量 → 归一化占比 → 每带 4bit 量化 → 8 nibble 十六进制串（纯函数）。"""
    total = sum(energies)
    if total <= 0.0:
        return "0" * FINGERPRINT_BANDS
    return "".join(
        f"{min(15, int(max(0.0, e / total) * 16)):x}" for e in energies
    )


def acoustic_fingerprint(
    samples: Iterable[float], sample_rate: int = SAMPLE_RATE,
) -> str | None:
    """ΝΩ-36(b)：激活段 8 带能量比 → 量化声学指纹（纯函数；静默/空窗 ⇒ None）。

    激活段 = 帧 RMS ≥ ``ACTIVE_RMS`` 的帧覆盖的样本（帧粒度掩码，静默段
    的频谱不稀释指纹）。8 几何带能量：
      - numpy 在场：掩码信号单次 rfft 的谱能量分箱（O(n log n)）；
      - 缺席：隔 4 抽样的 7 点一阶低通滤波器组差分能量（确定性降级 ——
        同波形 ⇒ 同指纹、异波形 ⇒ 异指纹的判别性两路一致）。
    """
    samples = list(samples)
    if not samples or sample_rate <= 0:
        return None
    hop = max(1, int(sample_rate * ANALYSIS_HOP_MS / 1000.0))
    peak_rms, _ = _peak_frame_rms(samples, hop)
    if peak_rms < SILENCE_RMS:
        return None  # 静默窗无激活段 —— 指纹诚实缺席

    if _np is not None:
        arr = _np.asarray(samples, dtype=_np.float64)
        n = arr.size
        # 帧粒度激活掩码 → 样本掩码（帧均方 ≥ ACTIVE_RMS² ⟺ 帧 RMS ≥ ACTIVE_RMS，
        # 开方保序 —— 免开方的等价判据）
        sq = arr * arr
        n_full = n // hop
        frame_ms = (
            sq[: n_full * hop].reshape(n_full, hop).mean(axis=1)
            if n_full else _np.zeros(0)
        )
        if n % hop and n_full * hop < n:
            frame_ms = _np.concatenate([frame_ms, [sq[n_full * hop:].sum() / hop]])
        active_frames = frame_ms >= ACTIVE_RMS ** 2
        mask = _np.repeat(active_frames, hop)[:n]
        masked = arr * mask
        spec = _np.abs(_np.fft.rfft(masked)) ** 2
        freqs = _np.fft.rfftfreq(n, d=1.0 / sample_rate)
        lo = 0.0
        energies: list[float] = []
        for edge in (*_FINGERPRINT_EDGES_HZ, float("inf")):
            energies.append(float(spec[(freqs >= lo) & (freqs < edge)].sum()))
            lo = edge
        return _quantize_ratios(energies)

    # 纯 Python 降级：stride-4 抽样 + 7 点一阶低通滤波器组（差分能量；
    # 免激活掩码 —— 静默样本能量 ≈ 0，占比天然由激活段主导）
    stride = 4
    coefs = [
        1.0 - math.exp(-2.0 * math.pi * fc / sample_rate) for fc in _FINGERPRINT_EDGES_HZ
    ]
    ys = [0.0] * len(coefs)
    band_sq = [0.0] * (len(coefs) + 1)
    for i, x in enumerate(samples):
        if i % stride:
            continue
        prev_lp = 0.0
        for k, a in enumerate(coefs):
            ys[k] += a * (x - ys[k])
            diff = ys[k] - prev_lp
            band_sq[k] += diff * diff
            prev_lp = ys[k]
        band_sq[len(coefs)] += (x - prev_lp) * (x - prev_lp)
    return _quantize_ratios(band_sq)


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


def _decode_to_mono(addr: int, frames: int, channels: int, tag: int, bits: int) -> list[float]:
    """PCM 帧指针 → 单声道 float 列表（ΑΩ-R1：comtypes / 原始 vtable 两引擎
    共用的唯一解码实现 —— 语义与原 ``WasapiLoopbackRunner._decode`` 逐分支一致：
    未知编码宁可缺席不可造假，多声道平均成单声道）。"""
    import ctypes

    total = frames * channels
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
    return [sum(raw[i * channels:(i + 1) * channels]) / channels for i in range(frames)]


# ─── ΠΑΝ-83: WAVEFORMATEX(/EXTENSIBLE) ABI 锚点 + 双引擎共享解析器 ───
#
# mingw-w64 mmreg.h 核对（定义位于 #pragma pack(1) 区段）：
#   WAVEFORMATEX: wFormatTag@0 WORD / nChannels@2 / nSamplesPerSec@4 DWORD /
#     nAvgBytesPerSec@8 DWORD / nBlockAlign@12 WORD / wBitsPerSample@14 WORD /
#     cbSize@16 WORD ⇒ sizeof = 18
#   WAVEFORMATEXTENSIBLE = WAVEFORMATEX + wValidBitsPerSample@18 WORD /
#     dwChannelMask@20 DWORD / SubFormat GUID@24 ⇒ sizeof = 40（cbSize = 22）
#
# 旧实现两病灶（批判报告 C2-4 H-1/H-2，本修复的靶）：
#   1. comtypes 引擎的 WAVEFORMATEX 字段序写错（wBitsPerSample 排在
#      nAvgBytesPerSec/nBlockAlign 之前）⇒ wBitsPerSample 落偏移 8，读到
#      **字节率低 16 位**（如 48k 立体声 float32 ⇒ 384000 & 0xFFFF = 56320）
#      ⇒ ``_decode_to_mono`` 无分支命中 ⇒ 全零假静默 —— 违反本模块宪法
#      「『没采到』绝不伪装成『静默』」；
#   2. 两引擎的 EXTENSIBLE 真标签都读 ``sizeof(WFX)``（未 pack 的 ctypes
#      sizeof = 20）⇒ 读到 **dwChannelMask 低 16 位** 而非 SubFormat@24：
#      立体声掩码 0x3 恰 = IEEE float 标签（真机 D-A4 通过纯属巧合）；
#      单声道 0x4 / 5.1 掩码 0x3F ⇒ 未知标签 ⇒ 全零假静默。
# 修复纪律（对齐 dxgi_capture 的「布局 ABI 锚点钉死在 selftest」）：
#   - 布局单源 = 本节锚点结构体；两引擎一律经 ``parse_wave_format`` 解析；
#   - ``--selftest`` / tests/test_audio.py 以手工字节流夹具（单声道 float32 /
#     5.1 float32 / 立体声 PCM16 / 非 EXTENSIBLE PCM·float）断言解析值，
#     堵死「selftest 全绿但引擎把所有样本解成 0」的盲区（C2-4 H-3）。


class _WaveFormatEx(ctypes.Structure):
    """mmreg.h WAVEFORMATEX（pack(1)，18B）—— 布局 ABI 锚点（ΠΑΝ-83）。"""

    _pack_ = 1
    _fields_ = [
        ("wFormatTag", ctypes.c_uint16),
        ("nChannels", ctypes.c_uint16),
        ("nSamplesPerSec", ctypes.c_uint32),
        ("nAvgBytesPerSec", ctypes.c_uint32),
        ("nBlockAlign", ctypes.c_uint16),
        ("wBitsPerSample", ctypes.c_uint16),
        ("cbSize", ctypes.c_uint16),
    ]


class _WaveFormatExtensible(ctypes.Structure):
    """mmreg.h WAVEFORMATEXTENSIBLE（pack(1)，40B）；SubFormat 是 16B GUID。"""

    _pack_ = 1
    _fields_ = [
        ("Format", _WaveFormatEx),
        ("wValidBitsPerSample", ctypes.c_uint16),
        ("dwChannelMask", ctypes.c_uint32),
        ("SubFormat", ctypes.c_uint8 * 16),
    ]


WAVE_FORMAT_EXTENSIBLE = 0xFFFE
_WFX_SIZE = 18    # sizeof(WAVEFORMATEX)（selftest 钉死）
_WFXE_SIZE = 40   # sizeof(WAVEFORMATEXTENSIBLE)（selftest 钉死）
_OFF_SUBFORMAT = 24  # SubFormat GUID 偏移（selftest 钉死 = _WFX_SIZE + 6）

# KSDATAFORMAT_SUBTYPE_* 的 GUID Data1（首 DWORD，LE）：
#   PCM = {00000001-…} ⇒ 首 2 字节 0x0001；IEEE_FLOAT = {00000003-…} ⇒ 0x0003
_SUBFORMAT_PCM = 0x00000001
_SUBFORMAT_IEEE_FLOAT = 0x00000003


def _wfx_total_size(head: bytes) -> int:
    """按头 18B 计算完整应读长度（EXTENSIBLE ⇒ 18 + cbSize；防御钳到合法下限）。

    WASAPI GetMixFormat 的共享模式 mix format 几乎恒为 EXTENSIBLE（cbSize=22
    ⇒ 总 40B）；非 EXTENSIBLE 的纯 WAVEFORMATEX 恒 18B。
    """
    if len(head) >= _WFX_SIZE and int.from_bytes(head[0:2], "little") == WAVE_FORMAT_EXTENSIBLE:
        return _WFX_SIZE + int.from_bytes(head[16:18], "little")
    return _WFX_SIZE


def parse_wave_format(buf: bytes) -> dict:
    """WAVEFORMATEX(/EXTENSIBLE) 字节流 → 格式字典（纯函数，ΠΑΝ-83 夹具靶）。

    EXTENSIBLE 判据（``wFormatTag==0xFFFE`` 且 ``cbSize>=22`` 且缓冲足长）成立
    ⇒ 真标签取 **SubFormat GUID 首 2 字节**（Data1 低 16 位 @24），并解析
    wValidBitsPerSample / dwChannelMask；判据不成立 ⇒ 原样返回头部 tag（可能
    仍是 0xFFFE —— 调用方按未知编码走「宁可缺席不造假」分支）。
    缓冲不足（<18B / EXTENSIBLE 截断）⇒ ``ValueError`` —— 离线字节夹具与
    在线 GetMixFormat 读共用同一执法面。raw-vtable / comtypes 双引擎同经
    此函数解析（布局单源，杜绝「一个引擎一错序、另一个错偏移」再发）。
    """
    if len(buf) < _WFX_SIZE:
        raise ValueError(f"wave format buffer too short: {len(buf)} < {_WFX_SIZE}")
    fmt = _WaveFormatEx.from_buffer_copy(bytes(buf[:_WFX_SIZE]))
    out = {
        "raw_tag": int(fmt.wFormatTag),
        "tag": int(fmt.wFormatTag),
        "channels": int(fmt.nChannels),
        "sr": int(fmt.nSamplesPerSec),
        "byterate": int(fmt.nAvgBytesPerSec),
        "block_align": int(fmt.nBlockAlign),
        "bits": int(fmt.wBitsPerSample),
        "cb_size": int(fmt.cbSize),
        "extensible": False,
        "valid_bits": None,
        "channel_mask": None,
    }
    if out["raw_tag"] == WAVE_FORMAT_EXTENSIBLE and out["cb_size"] >= _WFXE_SIZE - _WFX_SIZE:
        need = _WFX_SIZE + out["cb_size"]
        if len(buf) < need:
            raise ValueError(
                f"extensible wave format truncated: {len(buf)} < {need} "
                f"(cbSize={out['cb_size']})"
            )
        ext = _WaveFormatExtensible.from_buffer_copy(bytes(buf[:_WFXE_SIZE]))
        out["extensible"] = True
        out["valid_bits"] = int(ext.wValidBitsPerSample)
        out["channel_mask"] = int(ext.dwChannelMask)
        # SubFormat GUID 首 2 字节 = Data1 低 16 位（PCM=1 / IEEE_FLOAT=3）
        out["tag"] = int(ext.SubFormat[0]) | (int(ext.SubFormat[1]) << 8)
    return out


class _RawVtableWasapiLink:
    """ΑΩ-R1（D-E2）：原始 vtable WASAPI 客户端 —— py≥3.14 首选引擎。

    背景：py3.14 的 _ctypes 出参约定回归使 comtypes 接口出参
    （``POINTER(IMMDevice)`` 等）不可用；本类以纯 ctypes 手写 vtable 调用重建
    同一条链（IMMDeviceEnumerator → 默认 render 端点 → IAudioClient(LOOPBACK)
    → IAudioCaptureClient），移植自 real_probe.py D-A4 探针的**已验证**实现
    （真播放 → 回环 → 分类闭环）。与 runner 的契约：建链/读失败**抛出**，
    由 ``WasapiLoopbackRunner`` 统一记因降级（available=False + reason）——
    本类绝不吞错、绝不造假样本。
    """

    # vtable 槽位（0=QI，1=AddRef，2=Release 之后按接口方法序）
    SLOT_ENUM_GETDEFAULT = 4   # IMMDeviceEnumerator::GetDefaultAudioEndpoint
    SLOT_DEV_ACTIVATE = 3      # IMMDevice::Activate
    SLOT_DEV_GETID = 5         # IMMDevice::GetId
    SLOT_CLI_INITIALIZE = 3    # IAudioClient::Initialize
    SLOT_CLI_GETMIXFMT = 8     # IAudioClient::GetMixFormat
    SLOT_CLI_START = 10        # IAudioClient::Start
    SLOT_CLI_STOP = 11         # IAudioClient::Stop
    SLOT_CLI_GETSERVICE = 14   # IAudioClient::GetService
    SLOT_CAP_GETBUFFER = 3     # IAudioCaptureClient::GetBuffer
    SLOT_CAP_RELEASEBUF = 4    # IAudioCaptureClient::ReleaseBuffer
    SLOT_CAP_NEXTPACKET = 5    # IAudioCaptureClient::GetNextPacketSize

    CLSID_MMDeviceEnumerator = "{bcde0395-e52f-467c-8e3d-c4579291692e}"
    IID_IMMDeviceEnumerator = "{a95664d2-9614-4f35-a746-de8db63617e6}"
    IID_IAudioClient = "{1cb9ad4c-dbfa-4c32-b178-c2f568a703b2}"
    IID_IAudioCaptureClient = "{c8adbd64-e71e-48a0-a4de-185c395cd317}"

    def __init__(self) -> None:
        import ctypes

        self.ct = ctypes
        self.ole32 = ctypes.WinDLL("ole32")  # 仅 win32 构造（runner 已平台分治）
        self.ptrs: list[int] = []            # 保活 + 逆序 Release 名册
        self._tls = threading.local()        # ΑΩ-R1：按读线程各补一次 COM 初始化

    def _fn(self, obj: int, slot: int, restype, *argtypes):
        """取 vtable 第 slot 槽函数指针并包装为可调用（ΑΩ-R1）。"""
        ct = self.ct
        vtbl = ct.cast(obj, ct.POINTER(ct.c_void_p)).contents.value
        fn_addr = ct.cast(vtbl + slot * ct.sizeof(ct.c_void_p),
                          ct.POINTER(ct.c_void_p)).contents.value
        return ct.WINFUNCTYPE(restype, ct.c_void_p, *argtypes)(fn_addr)

    def _keep(self, p) -> int:
        v = self.ct.cast(p, self.ct.c_void_p).value or 0
        if v:
            self.ptrs.append(v)
        return v

    def _release_all(self) -> None:
        for v in reversed(self.ptrs):
            try:
                self._fn(v, 2, self.ct.c_ulong)(self.ct.c_void_p(v))  # Release
            except Exception:  # noqa: BLE001 —— 尽力回收，失败不阻断
                pass
        self.ptrs = []

    def _com_mta_init(self) -> None:
        """当前线程尽力初始化 COM（MTA）；已初始化/异模式冲突 ⇒ 沿用现状不阻断
        （ΑΩ-R1：建链线程与后台采集线程可能不同，逐线程各补一次）。"""
        if getattr(self._tls, "mta_init", False):
            return
        try:
            self.ole32.CoInitializeEx(None, 0x0)  # COINIT_MULTITHREADED
        except Exception:  # noqa: BLE001
            pass
        self._tls.mta_init = True

    def _mix_format(self, client: int) -> dict:
        """GetMixFormat → 解析 WAVEFORMATEX(/EXTENSIBLE) 真格式标签（ΑΩ-R1；
        ΠΑΝ-83：布局经 mmreg.h 锚点 + 共享 ``parse_wave_format`` —— 真标签读
        SubFormat@24，不再误读 dwChannelMask/字节率）。"""
        ct = self.ct
        pwfx = ct.c_void_p()
        hr = self._fn(client, self.SLOT_CLI_GETMIXFMT, ct.c_long, ct.POINTER(ct.c_void_p))(
            ct.c_void_p(client), ct.byref(pwfx))
        if hr != 0 or not pwfx.value:
            raise OSError(f"GetMixFormat hr=0x{hr & 0xFFFFFFFF:08x}")
        # ΠΑΝ-83：先读头 18B 定长 → 按 cbSize 决定整块长度 → 共享解析器。
        head = ct.string_at(pwfx.value, _WFX_SIZE)
        parsed = parse_wave_format(ct.string_at(pwfx.value, _wfx_total_size(head)))
        return {"tag": parsed["tag"], "channels": max(1, parsed["channels"]),
                "bits": parsed["bits"], "sr": parsed["sr"], "wfx_ptr": pwfx.value}

    def open_session(self) -> dict:
        """建链：enumerator → 默认 render 端点 → IAudioClient(LOOPBACK) → capture。
        失败 ⇒ 抛 OSError（hr 载明）由调用方记因降级（ΑΩ-R1）。"""
        ct = self.ct
        self._com_mta_init()
        from uuid import UUID

        clsid = ct.create_string_buffer(UUID(self.CLSID_MMDeviceEnumerator).bytes_le)
        iid_enum = ct.create_string_buffer(UUID(self.IID_IMMDeviceEnumerator).bytes_le)
        pv = ct.c_void_p()
        hr = self.ole32.CoCreateInstance(
            ct.byref(clsid), None, 0x17, ct.byref(iid_enum), ct.byref(pv))  # CLSCTX_ALL
        if hr != 0:
            raise OSError(f"CoCreateInstance(MMDeviceEnumerator) hr=0x{hr & 0xFFFFFFFF:08x}")
        enum = self._keep(pv)

        dev = ct.c_void_p()
        hr = self._fn(enum, self.SLOT_ENUM_GETDEFAULT, ct.c_long, ct.c_uint32, ct.c_uint32,
                      ct.POINTER(ct.c_void_p))(ct.c_void_p(enum), 0, 0, ct.byref(dev))
        if hr != 0:  # eRender/eConsole —— 无默认 render 端点（无音频设备）
            self._release_all()
            raise OSError(f"GetDefaultAudioEndpoint(eRender,eConsole) hr=0x{hr & 0xFFFFFFFF:08x}")
        devp = self._keep(dev)

        # 端点 ID 证据（CoTaskMemAlloc 内存读后真释放 —— 修探针版漏释放，ΑΩ-R1）
        endpoint_id = None
        wid = ct.c_void_p()
        hr = self._fn(devp, self.SLOT_DEV_GETID, ct.c_long, ct.POINTER(ct.c_void_p))(
            ct.c_void_p(devp), ct.byref(wid))
        if hr == 0 and wid.value:
            try:
                endpoint_id = ct.wstring_at(wid.value)
            finally:
                self.ole32.CoTaskMemFree(wid)

        iid_cli = ct.create_string_buffer(UUID(self.IID_IAudioClient).bytes_le)
        client = ct.c_void_p()
        hr = self._fn(devp, self.SLOT_DEV_ACTIVATE, ct.c_long,
                      ct.POINTER(ct.c_ubyte * 16), ct.c_uint32, ct.c_void_p,
                      ct.POINTER(ct.c_void_p))(
            ct.c_void_p(devp), ct.cast(iid_cli, ct.POINTER(ct.c_ubyte * 16)), 0x17, None,
            ct.byref(client))
        if hr != 0:
            self._release_all()
            raise OSError(f"IMMDevice.Activate(IAudioClient) hr=0x{hr & 0xFFFFFFFF:08x}")
        clip = self._keep(client)

        fmt = self._mix_format(clip)
        # ΠΑΝ-83：GetMixFormat 的缓冲由**调用方**负责 CoTaskMemFree（MSDN ——
        # CoTaskMemAlloc'd；旧注释「归 IAudioClient 生命周期管」为错误论断，
        # C2-4 L-11）。Initialize 返回（成败皆然）后即释放 —— SDK 样例同款方言。
        try:
            hr = self._fn(clip, self.SLOT_CLI_INITIALIZE, ct.c_long, ct.c_uint32, ct.c_uint32,
                          ct.c_longlong, ct.c_longlong, ct.c_void_p, ct.c_void_p)(
                ct.c_void_p(clip), 0, 0x00020000, 20_000_000, 0,  # SHARED | LOOPBACK，2s 缓冲
                ct.c_void_p(fmt["wfx_ptr"]), None)                 # 回环必须用 mix format 原样
        finally:
            self.ole32.CoTaskMemFree(ct.c_void_p(fmt["wfx_ptr"]))
        if hr != 0:
            self._release_all()
            raise OSError(f"IAudioClient.Initialize(SHARED,LOOPBACK) hr=0x{hr & 0xFFFFFFFF:08x}")

        iid_cap = ct.create_string_buffer(UUID(self.IID_IAudioCaptureClient).bytes_le)
        cap = ct.c_void_p()
        hr = self._fn(clip, self.SLOT_CLI_GETSERVICE, ct.c_long,
                      ct.POINTER(ct.c_ubyte * 16), ct.POINTER(ct.c_void_p))(
            ct.c_void_p(clip), ct.cast(iid_cap, ct.POINTER(ct.c_ubyte * 16)), ct.byref(cap))
        if hr != 0 or not cap.value:
            self._release_all()
            raise OSError(f"IAudioClient.GetService(IAudioCaptureClient) hr=0x{hr & 0xFFFFFFFF:08x}")
        capp = self._keep(cap)

        hr = self._fn(clip, self.SLOT_CLI_START, ct.c_long)(ct.c_void_p(clip))
        if hr != 0:
            self._release_all()
            raise OSError(f"IAudioClient.Start hr=0x{hr & 0xFFFFFFFF:08x}")

        return {
            "engine": "raw-vtable",
            "link": self,
            "client": clip,
            "capture": capp,
            "channels": fmt["channels"],
            "bits": fmt["bits"],
            "format_tag": fmt["tag"],
            "sr": fmt["sr"],
            "silent_flag": 0x2,  # AUDCLNT_BUFFERFLAGS_SILENT
            "endpoint_id": endpoint_id,
            # ΠΑΝ-83：mix format 缓冲已在 Initialize 后 CoTaskMemFree（归调用方，
            # MSDN）—— 不再持有/保活（旧注释的「IAudioClient 生命周期管」论断有误）。
        }

    def read_block(self, session: dict) -> list[float]:
        """读一块待决包（语义与 comtypes 路径 ``read()`` 对齐）；无包 ⇒ []。
        意外异常向上抛 —— 由 runner 记因标死（诚实缺席，ΑΩ-R1）。"""
        ct = self.ct
        self._com_mta_init()
        cap = session["capture"]
        channels = session["channels"]
        n = ct.c_uint32()
        hr = self._fn(cap, self.SLOT_CAP_NEXTPACKET, ct.c_long, ct.POINTER(ct.c_uint32))(
            ct.c_void_p(cap), ct.byref(n))
        if hr != 0 or n.value == 0:
            return []
        out: list[float] = []
        while n.value > 0:
            data = ct.c_void_p()
            frames = ct.c_uint32()
            flags = ct.c_uint32()
            hr = self._fn(cap, self.SLOT_CAP_GETBUFFER, ct.c_long,
                          ct.POINTER(ct.c_void_p), ct.POINTER(ct.c_uint32),
                          ct.POINTER(ct.c_uint32), ct.c_void_p, ct.c_void_p)(
                ct.c_void_p(cap), ct.byref(data), ct.byref(frames), ct.byref(flags), None, None)
            if hr != 0:
                break
            fcount = frames.value
            if flags.value & session["silent_flag"] or not data.value:
                out.extend([0.0] * fcount)
            else:
                out.extend(_decode_to_mono(data.value, fcount, channels,
                                           session["format_tag"], session["bits"]))
            self._fn(cap, self.SLOT_CAP_RELEASEBUF, ct.c_long, ct.c_uint32)(
                ct.c_void_p(cap), fcount)
            nn = ct.c_uint32()
            hr2 = self._fn(cap, self.SLOT_CAP_NEXTPACKET, ct.c_long, ct.POINTER(ct.c_uint32))(
                ct.c_void_p(cap), ct.byref(nn))
            if hr2 != 0:
                break
            n = nn
        return out

    def stop(self, session: dict) -> None:
        """尽力收尾：Stop + 逆序 Release（ΑΩ-R1；通道标死时回收用）。"""
        try:
            self._fn(session["client"], self.SLOT_CLI_STOP, self.ct.c_long)(
                self.ct.c_void_p(session["client"]))
        finally:
            self._release_all()


class WasapiLoopbackRunner:
    """WASAPI 系统回环 runner（Windows；ΑΩ-R1/D-E2 双引擎分治：
    py≥3.14 首选原始 vtable，低版本保留 comtypes；缺席/失败 ⇒ 诚实 unsupported）。

    生命周期防御式（运行层绝不抛）：
      - 构造零副作用（COM 延迟到 ``_ensure_session``）；
      - 任一环节失败 ⇒ ``_reason`` 记因、``read()`` 恒 []，绝不 raise；
      - 读循环中途失败 ⇒ 会话标记死亡，等价通道缺席。
    """

    def __init__(self) -> None:
        # ΝΩ-9：Lock → RLock —— read() 现全程持锁（见其 docstring），锁内再经
        # _ensure_session/describe 重入同一锁（非重入 Lock 会自锁死）。
        self._lock = threading.RLock()
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

        # ΠΑΝ-83：此处的内联 WAVEFORMATEX 定义已删除 —— 旧定义字段序错误
        # （wBitsPerSample 排在 nAvgBytesPerSec/nBlockAlign 之前 ⇒ 读到字节率
        # 低 16 位 ⇒ bits 恒垃圾值 ⇒ 永久假静默，C2-4 H-1）。布局权威移至
        # 模块级锚点 ``_WaveFormatEx/_WaveFormatExtensible`` + 共享解析器
        # ``parse_wave_format`` —— 与 raw-vtable 引擎单源同律。
        return (IMMDeviceEnumerator, IAudioClient, IAudioCaptureClient)

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
        if _USE_RAW_VTABLE:  # ΑΩ-R1（D-E2）：py≥3.14 首选原始 vtable 引擎
            return self._open_session_raw()
        return self._open_session_comtypes()

    def _open_session_raw(self) -> dict | None:
        """ΑΩ-R1（D-E2）：原始 vtable 建链 —— real_probe D-A4 已真机验证的路径。"""
        try:
            return _RawVtableWasapiLink().open_session()
        except Exception as e:  # noqa: BLE001 —— 运行层铁律：绝不抛，记因降级
            self._reason = f"wasapi loopback (raw-vtable) unavailable: {type(e).__name__}: {e}"
            return None

    def _open_session_comtypes(self) -> dict | None:
        """comtypes 建链（py<3.14 保留路径 —— ΑΩ-R1；3.14 出参约定回归下不可用）。"""
        built = self._build_comtypes()
        if built is None:
            self._reason = "comtypes unavailable (pip install comtypes) — honest unsupported"
            return None
        try:
            import ctypes
            import comtypes
            Enumerator, AudioClient, CaptureClient = built

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
            # ΠΑΝ-83：解析经 mmreg.h 锚点 + 共享 ``parse_wave_format`` ——
            # 旧内联 WAVEFORMATEX 字段序错误（wBitsPerSample 读到字节率低 16 位
            # ⇒ bits 恒垃圾值 ⇒ 假静默，C2-4 H-1）且 EXTENSIBLE 真标签误读
            # sizeof(20) 处（dwChannelMask 而非 SubFormat@24，C2-4 H-2）。
            head = ctypes.string_at(pv_fmt, _WFX_SIZE)
            parsed = parse_wave_format(ctypes.string_at(pv_fmt, _wfx_total_size(head)))
            format_tag = parsed["tag"]
            bits = parsed["bits"]
            channels = max(1, parsed["channels"])
            sample_rate = parsed["sr"]

            client.Initialize(
                AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
                20_000_000, 0,                       # 2s 缓冲（hns），与 ~2s 分析窗对齐
                ctypes.cast(pv_fmt, ctypes.c_void_p),  # mix format 原样回传（回环必须用设备格式）
                None,
            )
            # ΠΑΝ-83：GetMixFormat 缓冲归调用方释放（MSDN —— CoTaskMemAlloc'd；
            # 旧注释「归 IAudioClient 生命周期管」论断有误，C2-4 L-11）。
            ctypes.windll.ole32.CoTaskMemFree(ctypes.c_void_p(pv_fmt))
            client.Start()

            pv_capture = client.GetService(ctypes.byref(IID_IAudioCaptureClient))
            capture = ctypes.cast(pv_capture, ctypes.POINTER(CaptureClient)).contents

            return {
                "engine": "comtypes",  # ΑΩ-R1：引擎标记（read/describe 分流用）
                "client": client,
                "capture": capture,
                "channels": channels,
                "bits": bits,
                "format_tag": format_tag,
                "sr": sample_rate,
                "silent_flag": AUDCLNT_BUFFERFLAGS_SILENT,
                # ΠΑΝ-83：mix format 缓冲已在 Initialize 后 CoTaskMemFree
                # （归调用方，MSDN）—— 会话不再持有（旧「保活」注释论断有误）。
            }
        except Exception as e:  # noqa: BLE001 —— 运行层铁律：绝不抛
            self._reason = f"wasapi loopback unavailable: {type(e).__name__}: {e}"
            return None

    def read(self) -> list[float]:
        """读一块（≤200ms）单声道采样；失败/缺席 ⇒ []（绝不抛）。

        ΝΩ-9：全程持 ``_lock``。IAudioCaptureClient 的 GetBuffer/ReleaseBuffer
        单线程所有，两方并发读同一 capture 句柄会互相窜包（AUDCLNT_E_* hr），
        异常即把通道标死（``_dead`` 无复活）—— 首调竞态有三方：ensure_started
        暖机循环 vs 刚起步的 _drain_loop；多个 /v1/audio_events 的 executor
        并发首调；外部直调 drain_once。选「read 全程加锁」而非「删暖机循环改
        轮询 len(self._ring)」：前者一次封死全部三方，后者只堵其一。持锁时长
        有界 —— read 只清已就绪包（≤2s 环缓冲 ≈ 数十 ms），竞争方至多顺延一拍。
        """
        with self._lock:
            session = self._ensure_session()
            if session is None:
                return []
            if session.get("engine") == "raw-vtable":  # ΑΩ-R1（D-E2）：py≥3.14 首选路径
                try:
                    return session["link"].read_block(session)
                except Exception as e:  # noqa: BLE001 —— 读失败 = 通道死亡（诚实缺席）
                    self._dead = True  # 已持锁（read 全程持锁，ΝΩ-9）
                    self._reason = f"wasapi read failed: {type(e).__name__}: {e}"
                    self._best_effort_release(session)
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
                self._dead = True  # 已持锁（read 全程持锁，ΝΩ-9）
                self._reason = f"wasapi read failed: {type(e).__name__}: {e}"
                return []

    @staticmethod
    def _decode(addr: int, frames: int, channels: int, session: dict) -> list[float]:
        # ΑΩ-R1：解码体已提为两引擎共用的模块级 _decode_to_mono（本静态方法保留薄委托）
        return _decode_to_mono(addr, frames, channels, session["format_tag"], session["bits"])

    def _best_effort_release(self, session: dict) -> None:
        """ΑΩ-R1：raw-vtable 会话标死时尽力回收 COM 引用（Stop + 逆序 Release）。"""
        link = session.get("link")
        if link is None:
            return
        try:
            link.stop(session)
        except Exception:  # noqa: BLE001 —— 回收失败不阻断降级路径
            pass

    def describe(self) -> dict:
        with self._lock:
            info: dict = {"available": not self._dead and self._reason is None, "backend": "wasapi-loopback"}
            if self._reason is not None:
                info["reason"] = self._reason
            if self._session is not None:
                info["engine"] = str(self._session.get("engine", "comtypes"))  # ΑΩ-R1
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

    def __init__(self, runner: CaptureRunner, sample_rate: int | None = None,
                 fingerprint_window_s: float = FINGERPRINT_WINDOW_S):
        self._runner = runner
        sr = sample_rate if sample_rate is not None else getattr(runner, "sample_rate", SAMPLE_RATE)
        self._sample_rate = int(sr)
        self._ring = AudioRingBuffer(self._sample_rate)
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop_flag = threading.Event()
        self._last_emitted: str | None = None
        # ΝΩ-36(b) 同指纹聚合状态:同一提示音重复播放(聚合窗内同指纹)只
        # 计数不报 —— 不每沿一报;聚合计数在 describe()/下次真报可见。
        self._fingerprint_window_s = max(1.0, float(fingerprint_window_s))
        self._fp_state: dict = {"fingerprint": None, "count": 0, "last_seen": 0.0}
        self._suppressed_total = 0

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
        构造期零副作用 ⇒ 未建链前 describe 恒乐观，必须重读）。

        ΝΩ-9：start() 之后的暖机循环与 _drain_loop 线程并发调 read —— 竞态
        已由 WasapiLoopbackRunner.read() 全程持锁封死（见其 docstring 论证），
        此处保留暖机语义（等首填 ~100ms，让首响应即有判决）。"""
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
        """当前窗口五类判决 ``{event, confidence, ts}``；通道不可用 ⇒ None。

        ΝΩ-36(b)：激活事件附 ``fingerprint``（8 带量化指纹，附加字段 ——
        五类判决字段不动）。指纹计算失败不击穿判决（诊断性字段，诚实缺席）。
        """
        if not self._runner.describe().get("available", False):
            return None
        with self._lock:
            snapshot = self._ring.snapshot()
        verdict = classify_window(snapshot, self._sample_rate)
        out = {"event": verdict["event"], "confidence": verdict["confidence"],
               "ts": int(time.time() * 1000)}
        if verdict["event"] != "silence":
            try:
                out["fingerprint"] = acoustic_fingerprint(snapshot, self._sample_rate)
            except Exception:  # noqa: BLE001 —— 指纹是诊断增强，不是判决依据
                out["fingerprint"] = None
        return out

    def poll(self) -> dict | None:
        """边沿触发事件流（类别变化才发，含进入/离开静默的边沿）。

        ΝΩ-36(b) 同指纹聚合：激活事件的指纹与上次已报指纹相同（聚合窗内）
        ⇒ 只聚合计数不报 —— **同一提示音重复播放不每沿一报**。被聚合的
        事件计数在 ``describe()`` 与下一次真报（指纹变化/超窗）时申报
        （真报携带 ``repeats`` = 本系列窗口数，含自身）。
        """
        ev = self.detect()
        if ev is None:
            return None
        if ev["event"] == self._last_emitted:
            return None
        if ev["event"] != "silence":
            fp = ev.get("fingerprint")
            now_s = ev["ts"] / 1000.0
            st = self._fp_state
            if now_s - st["last_seen"] > self._fingerprint_window_s:
                st["fingerprint"] = None  # 聚合窗过期：系列自然收尾
                st["count"] = 0
            if fp is not None and fp == st["fingerprint"]:
                st["count"] += 1
                st["last_seen"] = now_s
                self._suppressed_total += 1
                self._last_emitted = ev["event"]  # 边沿状态推进（同类持续不重判）
                return None                       # 聚合：不报
            ev["repeats"] = 1  # 新系列首报（suppressed 计数见 describe）
            st.update({"fingerprint": fp, "count": 0, "last_seen": now_s})
        self._last_emitted = ev["event"]
        return ev

    def describe(self) -> dict:
        try:
            desc = dict(self._runner.describe())
        except Exception:  # noqa: BLE001
            desc = {"available": False, "backend": "unknown", "reason": "describe() raised"}
        desc["window_ms"] = int(WINDOW_SECONDS * 1000)
        desc["buffered_samples"] = len(self._ring)
        # ΝΩ-36(b)：同指纹聚合的可观测面
        desc["fingerprint_dedup"] = {
            "window_s": self._fingerprint_window_s,
            "active_fingerprint": self._fp_state["fingerprint"],
            "suppressed_in_series": self._fp_state["count"],
            "suppressed_total": self._suppressed_total,
        }
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


# ─── ΠΑΝ-83 自测：布局锚点 + 手工字节流夹具（与 tests/test_audio.py 同源执法）───


def _selftest_wave_format() -> list[str]:
    """WAVEFORMATEX/EXTENSIBLE 字节级夹具（ΠΑΝ-83 —— 堵死 C2-4 H-3 盲区：
    旧 selftest 五类合成波形全绿与「引擎把所有样本解成 0」完全兼容，因为
    0 窗口判 silence 正是合成静默的期望值；字节夹具直接钉死解析层）。

    夹具全部**手工构造**（struct.pack 显式字节序/偏移，不经被测代码生成 ——
    拒绝自证循环）；每例同时是旧病灶的回归哨（注释标明旧错读会得到什么）。
    """
    import struct

    failures: list[str] = []

    def check(name: str, cond: bool) -> None:
        print(f"[{'PASS' if cond else 'FAIL'}] {name}")
        if not cond:
            failures.append(name)

    # ── 布局锚点（mmreg.h pack(1)；对齐 dxgi_capture「sizeof 钉死 selftest」纪律）──
    check("ABI sizeof(WAVEFORMATEX)==18", ctypes.sizeof(_WaveFormatEx) == _WFX_SIZE)
    check("ABI sizeof(WAVEFORMATEXTENSIBLE)==40",
          ctypes.sizeof(_WaveFormatExtensible) == _WFXE_SIZE)
    check("ABI SubFormat@24", _WaveFormatExtensible.SubFormat.offset == _OFF_SUBFORMAT)
    check("ABI wBitsPerSample@14 (after nBlockAlign/nAvgBytesPerSec)",
          _WaveFormatEx.wBitsPerSample.offset == 14
          and _WaveFormatEx.nBlockAlign.offset == 12
          and _WaveFormatEx.nAvgBytesPerSec.offset == 8)
    check("ABI dwChannelMask@20 / wValidBitsPerSample@18",
          _WaveFormatExtensible.dwChannelMask.offset == 20
          and _WaveFormatExtensible.wValidBitsPerSample.offset == 18)

    def _guid(data1: int) -> bytes:
        # KSDATAFORMAT_SUBTYPE_*：Data1(LE DWORD) + Data2/Data3 + Data4 常量尾
        return (struct.pack("<IHH", data1, 0x0000, 0x0010)
                + bytes((0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71)))

    def _ext(ch: int, sr: int, bits: int, mask: int, data1: int,
             valid_bits: int | None = None) -> bytes:
        align = ch * bits // 8
        return (
            struct.pack("<HHIIHHH", WAVE_FORMAT_EXTENSIBLE, ch, sr, sr * align, align, bits, 22)
            + struct.pack("<H", bits if valid_bits is None else valid_bits)
            + struct.pack("<I", mask)
            + _guid(data1)
        )

    def _plain(tag: int, ch: int, sr: int, bits: int) -> bytes:
        align = ch * bits // 8
        return struct.pack("<HHIIHHH", tag, ch, sr, sr * align, align, bits, 0)

    # ── 夹具 1：单声道 float32 EXTENSIBLE（mask=0x4）──
    # 旧病灶读数：真标签误读 mask 低 16 位 ⇒ tag=4（未知）⇒ 全零假静默；
    # comtypes 字段序下 bits 读字节率低 16 位（192000 & 0xFFFF = 0xEE00）。
    d = parse_wave_format(_ext(1, 48_000, 32, 0x4, _SUBFORMAT_IEEE_FLOAT))
    check("fixture mono float32: tag=3 bits=32 ch=1 sr=48000",
          d["tag"] == 3 and d["bits"] == 32 and d["channels"] == 1 and d["sr"] == 48_000)
    check("fixture mono float32: extensible fields (valid=32, mask=0x4)",
          d["extensible"] and d["valid_bits"] == 32 and d["channel_mask"] == 0x4)

    # ── 夹具 2：5.1 float32 EXTENSIBLE（mask=0x3F）──
    # 旧病灶读数：真标签误读 mask ⇒ tag=63（未知）⇒ 全零假静默。
    d = parse_wave_format(_ext(6, 48_000, 32, 0x3F, _SUBFORMAT_IEEE_FLOAT))
    check("fixture 5.1 float32: tag=3 (not channel-mask 63) bits=32 ch=6",
          d["tag"] == 3 and d["bits"] == 32 and d["channels"] == 6
          and d["channel_mask"] == 0x3F)

    # ── 夹具 3：立体声 PCM16 EXTENSIBLE（mask=0x3，SubFormat=PCM）──
    # 旧病灶读数：真标签误读 mask ⇒ tag=3（IEEE float）与 bits=16 不匹配 ⇒ 全零。
    d = parse_wave_format(_ext(2, 44_100, 16, 0x3, _SUBFORMAT_PCM))
    check("fixture stereo pcm16: tag=1 bits=16 align=4 byterate=176400",
          d["tag"] == 1 and d["bits"] == 16 and d["block_align"] == 4
          and d["byterate"] == 176_400)

    # ── 夹具 4/5：非 EXTENSIBLE 的纯 WAVEFORMATEX（PCM16 / float32）──
    d = parse_wave_format(_plain(1, 2, 44_100, 16))
    check("fixture plain pcm16: tag=1 extensible=False",
          d["tag"] == 1 and not d["extensible"] and d["bits"] == 16)
    d = parse_wave_format(_plain(3, 2, 48_000, 32))
    check("fixture plain float32: tag=3 extensible=False",
          d["tag"] == 3 and not d["extensible"] and d["bits"] == 32)

    # ── 防御：截断缓冲 ⇒ ValueError（在线读与离线夹具共用同一执法面）──
    try:
        parse_wave_format(_ext(2, 48_000, 32, 0x3, 3)[:30])
        check("fixture truncated extensible raises ValueError", False)
    except ValueError:
        check("fixture truncated extensible raises ValueError", True)
    try:
        parse_wave_format(b"\x01\x00")
        check("fixture short buffer raises ValueError", False)
    except ValueError:
        check("fixture short buffer raises ValueError", True)

    # ── 头长计算（两引擎读长单源）──
    check("_wfx_total_size: extensible→40 / plain→18",
          _wfx_total_size(_ext(2, 48_000, 32, 0x3, 3)[:18]) == 40
          and _wfx_total_size(_plain(1, 2, 44_100, 16)) == 18)

    # ── 解码联动：解析出的 (tag, bits) 必须命中 _decode_to_mono 分支 ──
    # （H-1 的实际伤害路径：旧 bits 垃圾值 ⇒ 无分支命中 ⇒ [0.0]*frames 假静默）
    pcm16 = (ctypes.c_int16 * 4)(0, 16384, -16384, 8192)
    mono = _decode_to_mono(ctypes.addressof(pcm16), 2, 2, 1, 16)
    check("decode linkage: pcm16 stereo pairs averaged",
          len(mono) == 2 and abs(mono[0] - 0.25) < 1e-9 and abs(mono[1] + 0.125) < 1e-9)
    flt = (ctypes.c_float * 2)(1.0, -1.0)
    mono_f = _decode_to_mono(ctypes.addressof(flt), 1, 2, 3, 32)
    check("decode linkage: float32 stereo pair averaged to 0.0",
          len(mono_f) == 1 and abs(mono_f[0]) < 1e-9)

    return failures


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

    # 诚实 unsupported：非 win32 / 引擎失败或缺席（raw-vtable 建链失败、无音频
    # 设备、低版本 comtypes 缺席）⇒ available=False ⇒ 端点信封必须 event=None
    # （「没采到」绝不伪装成「静默」—— ΑΩ-R1：双引擎同受此律约束）。
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

    # ── ΝΩ-36(a) VAD 预门零回归：快径输出 == 全扫描输出 ──
    # 把 SILENCE_RMS 钉到 0（门永不触发 ⇒ 走全扫描），与正常门（快径）对比。
    _saved_gate = SILENCE_RMS
    try:
        wave_sil = synth_silence()
        gated = extract_features(wave_sil)  # 快径（峰值 < 静默门）
        globals()["SILENCE_RMS"] = 0.0
        full = extract_features(wave_sil)   # 门永不触发 ⇒ 全扫描
        ok_gate = (
            gated.active_frames == full.active_frames == 0
            and gated.total_frames == full.total_frames
            and abs(gated.peak_rms - full.peak_rms) < 1e-12
            and (gated.decay, gated.burst_count, gated.mean_zcr,
                 gated.low_ratio, gated.high_ratio)
            == (full.decay, full.burst_count, full.mean_zcr,
                full.low_ratio, full.high_ratio)
        )
        if ok_gate:
            print("[OK ] vad gate fast-path == full scan (silence window)")
        else:
            failures.append(f"vad gate drift: gated={gated} full={full}")
            print(f"[FAIL] vad gate drift: {gated} vs {full}")
    finally:
        globals()["SILENCE_RMS"] = _saved_gate

    # ── ΝΩ-36(c) numpy/纯 Python 双路径等价（五类合成波形逐字段对比）──
    global _np  # noqa: PLW0603 —— 测试期路径切换（finally 还原）
    _saved_np = _np
    try:
        for expected, wave in cases:
            f_np = extract_features(wave)
            _np = None  # 强制纯 Python 降级路径
            f_py = extract_features(wave)
            _np = _saved_np
            fields = ("peak_rms", "active_frames", "total_frames",
                      "longest_burst_ms", "burst_count", "mean_zcr",
                      "low_ratio", "high_ratio", "decay")
            ok_path = all(
                math.isclose(getattr(f_np, k), getattr(f_py, k),
                             rel_tol=1e-6, abs_tol=1e-9)
                for k in fields
            )
            if ok_path:
                print(f"[OK ] numpy == pure-python features ({expected})")
            else:
                failures.append(f"path drift on {expected}: {f_np} vs {f_py}")
                print(f"[FAIL] path drift on {expected}: {f_np} vs {f_py}")
    finally:
        _np = _saved_np

    # ── ΝΩ-36(b) 声学指纹：确定性 / 判别性 / 静默缺席 ──
    fp_ding_1 = acoustic_fingerprint(synth_notification_ding())
    fp_ding_2 = acoustic_fingerprint(synth_notification_ding())
    fp_error = acoustic_fingerprint(synth_error_beep())
    fp_ok_fp = (
        isinstance(fp_ding_1, str) and len(fp_ding_1) == FINGERPRINT_BANDS
        and fp_ding_1 == fp_ding_2
        and fp_ding_1 != fp_error
        and acoustic_fingerprint(synth_silence()) is None
    )
    if fp_ok_fp:
        print(f"[OK ] fingerprint deterministic+discriminative: ding={fp_ding_1} error={fp_error}")
    else:
        failures.append(f"fingerprint: {fp_ding_1} {fp_error}")
        print(f"[FAIL] fingerprint: {fp_ding_1} {fp_error}")

    # ── ΝΩ-36(b) poll 同指纹聚合：同一提示音重复播放不每沿一报 ──
    # 分相喂数(ding → 静默 → 同 ding → 静默 → 同 ding)：首次报、后续同指纹
    # 聚合抑制;聚合计数在 describe() 可观测。
    ding_wave = synth_notification_ding()
    zeros_wave = [0.0] * SAMPLE_RATE * 2
    chunk = SAMPLE_RATE // 10  # 100ms 块

    def _chunks(w):
        return [w[i:i + chunk] for i in range(0, len(w), chunk)]

    phases = [_chunks(ding_wave), _chunks(zeros_wave),
              _chunks(ding_wave), _chunks(zeros_wave), _chunks(ding_wave)]
    script = [c for ph in phases for c in ph]
    mon2 = AudioMonitor(MockRunner(script))
    emissions: list[dict | None] = []
    for ph in phases:
        for _c in ph:
            mon2.drain_once()
        emissions.append(mon2.poll())
    ok_dedup = (
        emissions[0] is not None and emissions[0]["event"] == "notification_ding"
        and "fingerprint" in emissions[0]
        and emissions[1] is not None and emissions[1]["event"] == "silence"
        and emissions[2] is None  # 同指纹 ding：聚合抑制（不每沿一报）
        and emissions[3] is not None and emissions[3]["event"] == "silence"
        and emissions[4] is None  # 再次同指纹：仍聚合
        and mon2.describe()["fingerprint_dedup"]["suppressed_total"] == 2
    )
    if ok_dedup:
        dd = mon2.describe()["fingerprint_dedup"]
        print(f"[OK ] poll same-fingerprint aggregation (suppressed_total={dd['suppressed_total']})")
    else:
        failures.append(f"poll dedup: {emissions}")
        print(f"[FAIL] poll dedup: {emissions}")

    # ── ΠΑΝ-83：WAVEFORMATEX/EXTENSIBLE 布局锚点 + 字节级夹具 ──
    # （selftest 盲区收口：解析层从此有离线执法面，详见 _selftest_wave_format）
    failures.extend(_selftest_wave_format())

    if failures:
        print(f"audio selftest FAILED ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("audio selftest OK: 5/5 classes + mock e2e + edge-trigger"
          + (" + honest-unsupported" if not desc.get("available", False) else "")
          + " + wave-format byte fixtures (PAN-83)")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="W4-8 L4 声学证据通道（非语义物理证据）")
    parser.add_argument("--selftest", action="store_true",
                        help="合成波形（mock 注入）断言 5 类事件分类正确")
    parser.add_argument("--selftest-real", action="store_true",
                        help="W9-4 真机实证：WASAPI 真建链 + 真播放→回环→分类（委托 real_probe.py）")
    args = parser.parse_args(argv)
    if args.selftest:
        return run_selftest()
    if args.selftest_real:
        # W9-4 真机实证探针入口：本模块逻辑零侵入，委托 real_probe.py
        import pathlib as _pl

        _svc_root = _pl.Path(__file__).resolve().parent.parent
        if str(_svc_root) not in sys.path:
            sys.path.insert(0, str(_svc_root))
        from real_probe import run_debt_probe

        return run_debt_probe("D-A4")
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
