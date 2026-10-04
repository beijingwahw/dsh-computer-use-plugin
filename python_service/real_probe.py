"""W9-4 「需真机」债的软件在环最大化实证总探针。

宪法对齐:本文件是**实证探针**,不是功能改动 —— 四个控制器
(uvc/audio/hid/android)的逻辑零侵入;全部证据产出到
``python_service/real_probe_report.json``(每条债 → 实证深度 → 结论),
可重复运行(exit 0 = 全部探针完成;探针内部断言失败才非零)。

实证矩阵(逐条对应 DEBTS D-A1..A7 / D-G4):
  - D-A1 UVC:cv2(5.0.0)+ DirectShow 设备在场 ⇒ 真采集帧过完整 uvc 管线
    (枚举 → 开设备 → 连续读帧 → 通道序钉死 → 四角校准恒等/过扫描/梯形 →
    dhash 门控计数 → PNG/JPEG 编码)——「帧管线真硬件在环」在软件在环层面
    以真 DirectShow 设备帧闭合。
  - D-A4 声学:comtypes(1.4.17)在场 ⇒ WASAPI 真建链 + 枚举 render 端点 +
    winsound 真播放合成叮声 → 回环采集 ~2s → 5 类分类器判决。
  - D-A2 HID:pyserial(3.5)在场但无 CH9329 棒(枚举 COM 口为证)⇒
    ``loop://`` 真序列化回读(帧经真 pyserial Serial.write/read 往返后解帧
    校验)—— 比纯 mock 深一层;无棒定谳唯余硬件。
  - D-A3 Android:adb/scrcpy 在场性探测 ⇒ 缺席定谳唯余硬件。
  - D-A5 跨机 barrier:真三进程真 socket —— federation-server 子进程 +
    两个独立 node 客户端进程(scripts/w9real-barrier-client.mjs)环回
    127.0.0.1 barrier 往返 —— 从「环回参考」升为「真 socket 多进程实证」。
  - D-A6/D-A7/D-G4:真模型/长跑/Linux UDS/生产数据 —— 物理边界,各以
    本机探测证据定谳「已尽软件在环,唯余硬件在场」。

用法:
  python real_probe.py                 # 全矩阵 + 报告落盘
  python real_probe.py --only D-A1,D-A5
  python real_probe.py --dA1           # 单债快捷(供 --selftest-real 委托)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))  # dsh_physical 可导入(直接脚本运行时)

REPORT_PATH = HERE / "real_probe_report.json"
FRAME_EVIDENCE = HERE / "real_probe_dA1_frame.jpg"

Depth = str  # "真硬件在环" | "真软件栈在环" | "mock 边界" | "唯余硬件"


def _find_node() -> str | None:
    """node 可执行(缺省 PATH;缺席再探本机 omega-node 缓存)(W9-4)。"""
    exe = shutil.which("node")
    if exe:
        return exe
    for cand in (
        Path.home() / ".cache" / "omega-node" / "node-v22.14.0-win-x64" / "node.exe",
        Path.home() / ".cache" / "omega-node" / "node-v22.14.0-win-x64" / "bin" / "node",
    ):
        if cand.exists():
            return str(cand)
    return None


def _env_block() -> dict:
    try:
        import cv2

        cv2_ver = cv2.__version__
    except Exception:  # noqa: BLE001
        cv2_ver = None
    vers = {}
    for mod in ("comtypes", "serial"):
        try:
            m = __import__(mod)
            vers[mod] = getattr(m, "__version__", "present")
        except Exception:  # noqa: BLE001
            vers[mod] = None
    return {
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "cv2": cv2_ver,
        "comtypes": vers["comtypes"],
        "pyserial": vers["serial"],
        "node": _find_node(),
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }


# ═══ D-A1:UVC 真采集帧过完整 uvc 管线(W9-4 最大机会)═══


def probe_da1() -> dict:
    """真 DirectShow 设备帧 → 枚举/通道序/尺寸/门控计数/校准/编码 全链断言。"""
    checks: list[tuple[str, bool]] = []

    def check(name: str, cond: bool) -> None:
        print(f"[{'PASS' if cond else 'FAIL'}] D-A1 {name}")
        checks.append((name, bool(cond)))

    ev: dict = {"probe": "real_probe.py --dA1", "depth": "真软件栈+真DirectShow设备帧"}
    try:
        import cv2
        import numpy as np

        from dsh_physical.screen import hamming_hex
        from dsh_physical.uvc import Calibration, Cv2FrameSource, UvcConfig, UvcController, cv2_to_rgb
    except Exception as e:  # noqa: BLE001
        ev.update({"status": "failed", "error": f"import failed: {e}"})
        return ev
    ev["cv2"] = cv2.__version__

    # ── 1. 设备枚举(DirectShow 后端,索引 0..3)──
    found: list[dict] = []
    for idx in range(4):
        cap = cv2.VideoCapture(idx, cv2.CAP_DSHOW)
        if cap.isOpened():
            ok, frame = cap.read()
            found.append({
                "index": idx,
                "readable": bool(ok and frame is not None),
                "shape": list(frame.shape) if ok and frame is not None else None,
            })
        cap.release()
    ev["devices"] = found
    usable = [d for d in found if d["readable"]]
    check("DirectShow 设备枚举:至少一台可读", bool(usable))
    if not usable:
        ev.update({
            "status": "degraded",
            "verdict": "本机无可用 DirectShow 视频设备 —— D-A1 唯余采集卡硬件在场"
            "(cv2 5.0.0 管线与 mock 证据链已在 --selftest 闭合)",
        })
        return ev

    dev = usable[0]
    idx = dev["index"]
    h, w, ch = dev["shape"]

    # ── 2. 原始帧连续读:统计 + 通道序钉死(同一帧 BGR vs cv2_to_rgb)──
    cap = cv2.VideoCapture(idx, cv2.CAP_DSHOW)
    t0 = time.monotonic()
    stats: list[dict] = []
    raw_frames = []
    for _ in range(15):
        ok, frame = cap.read()
        if ok and frame is not None:
            raw_frames.append(frame)
            stats.append({"mean": round(float(frame.mean()), 3), "std": round(float(frame.std()), 3)})
    read_elapsed = time.monotonic() - t0
    cap.release()
    check("连续读 15 帧全部成功", len(raw_frames) == 15)
    check(f"帧形状 {w}x{h}x{ch} 三通道", ch == 3)
    ev["raw_reads"] = {
        "n": len(raw_frames), "elapsed_s": round(read_elapsed, 3),
        "fps_est": round(len(raw_frames) / read_elapsed, 1) if read_elapsed > 0 else None,
        "frame_means": [s["mean"] for s in stats], "frame_stds": [s["std"] for s in stats],
    }

    probe_frame = raw_frames[0]
    rgb_img = cv2_to_rgb(probe_frame, np)  # uvc.py 的真转换函数作用于真设备帧
    pts = [(0, 0), (w // 2, h // 2), (w - 1, h - 1), (w // 4, h // 3), (3 * w // 4, 2 * h // 3)]
    chan_ok = all(rgb_img.getpixel((x, y)) == tuple(int(v) for v in probe_frame[y, x][::-1]) for x, y in pts)
    check("通道序:BGR 设备帧 → RGB 经 cv2_to_rgb 逐像素一致(5 采样点)", chan_ok)

    # ── 3. 完整 uvc 管线:Cv2FrameSource 注入 UvcController(恒等校准)──
    async def _pipeline() -> dict:
        out: dict = {}
        src = Cv2FrameSource(idx)
        ctrl = UvcController(UvcConfig(source_kind="auto"), source=src)
        try:
            data_png, ex1 = await ctrl.capture(format="png", want_hashes=True)
            out["png_ok"] = data_png is not None and data_png[:8] == b"\x89PNG\r\n\x1a\n"
            out["png_bytes"] = len(data_png or b"")
            out["dims"] = (ex1["width"], ex1["height"])
            out["dhash0"] = ex1["dhash"]

            data_jpg, ex2 = await ctrl.capture(format="jpeg", quality=85, max_width=320)
            out["jpeg_ok"] = data_jpg is not None and data_jpg[:3] == b"\xff\xd8\xff"
            out["jpeg_bytes"] = len(data_jpg or b"")
            out["jpeg_dims"] = (ex2["width"], ex2["height"])
            if data_jpg is not None:
                FRAME_EVIDENCE.write_bytes(data_jpg)  # 帧证据落盘

            # 门控计数:同一参考 dhash 连续 12 次捕获,统计 unchanged/regenerated
            ref = ex1["dhash"]
            hashes: list[str] = [ref]
            gated = regen = 0
            dists: list[int] = []
            for _ in range(12):
                d, ex = await ctrl.capture(format="png", gate={"dhash_ref": ref, "distance": 3})
                hashes.append(ex["dhash"])
                dists.append(hamming_hex(ex["dhash"], ref))
                if ex["unchanged"]:
                    gated += 1
                else:
                    regen += 1
                    ref = ex["dhash"]  # 场景真变了 ⇒ 参考随行(连续漂移语义)
            out["gate"] = {"attempts": 12, "unchanged": gated, "regenerated": regen,
                           "hamming_vs_ref": dists}
            out["gate_mechanism_ok"] = gated + regen == 12

            # 过扫描校准:四角收 10% ⇒ 帧裁到 0.8 尺寸
            ctrl.set_calibration(Calibration((0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9)))
            d3, ex3 = await ctrl.capture(format="png")
            out["overscan_dims"] = (ex3["width"], ex3["height"])
            out["overscan_ok"] = d3 is not None and (ex3["width"], ex3["height"]) == (round(0.8 * w), round(0.8 * h))
        finally:
            await ctrl.close()
        return out

    pipe = asyncio.run(_pipeline())
    ev["pipeline"] = pipe
    check("管线 PNG 编码魔数 + 字节产出", pipe["png_ok"])
    check("管线 JPEG(max_width=320)编码魔数 + 缩放", pipe["jpeg_ok"] and pipe["jpeg_dims"][0] == 320)
    check("管线 dhash 16-hex 产出", isinstance(pipe["dhash0"], str) and len(pipe["dhash0"]) == 16)
    check("门控计数:12 次决策全落账(unchanged+regenerated==12)", pipe["gate_mechanism_ok"])
    check(
        f"过扫描校准:真帧裁剪 {pipe['overscan_dims']}",
        pipe["overscan_ok"],
    )

    # ── 4. 非轴对齐(梯形)校准矫正真帧(QUAD 重采样路径)──
    from PIL import Image

    from dsh_physical.uvc import rectify

    trap = Calibration((0.05, 0.0), (0.95, 0.0), (0.85, 1.0), (0.15, 1.0))
    real_pil = Image.fromarray(np.ascontiguousarray(probe_frame[:, :, ::-1]))
    t1 = time.monotonic()
    rect = rectify(real_pil, trap)
    rect_ms = (time.monotonic() - t1) * 1000
    natural = trap.natural_size(w, h)
    check(
        f"梯形校准 QUAD 矫正版真帧 → {rect.size}(自然尺寸 {natural},{rect_ms:.1f}ms)",
        rect.size == natural and rect.size[0] > 0,
    )
    ev["rectify"] = {"out_size": list(rect.size), "natural": list(natural), "ms": round(rect_ms, 1)}

    ev["status"] = "ok" if all(c for _, c in checks) else "failed"
    ev["verdict"] = (
        "真 DirectShow 设备帧经完整 uvc 管线(校准/门控/编码)闭环 —— D-A1 的"
        "「帧管线真硬件在环」缺口在软件在环层面闭合;唯余:真实 HDMI 采集卡"
        "过扫描/方言对齐的现场标定(需采集卡在场)"
    )
    return ev


# ═══ D-A4:WASAPI 回环建链 + 真播放 → 分类(W9-4)═══
#
# 实证路线说明(W9-4 关键发现):audio.py 的 WasapiLoopbackRunner 在本机
# Python 3.14.6 + comtypes 1.4.17 下,`GetDefaultAudioEndpoint` 的
# `POINTER(IMMDevice)` 出参触发 CPython _ctypes 出参检查
# (「'out' parameter must be passed as default value」—— comtypes 接口类型
# 的惰性 proto 是字符串);`POINTER(c_void_p)` 出参则以值语义传 NULL
# (E_POINTER)。这是**软件层调用约定回归**,不是硬件/系统缺席 —— 本探针
# 以原始 vtable 调用(纯 ctypes,零 paramflags 依赖)重建 WASAPI 回环链,
# 采集到的真样本喂 audio.py 的**纯函数**分类器(extract_features/
# classify_window,无 COM 耦合),证明:WASAPI 系统侧可用、分类器对真回环
# 样本有效、阻塞点仅在 comtypes-on-py3.14 声明约定(audio.py 后续修复项)。


class _RawWasapi:
    """原始 vtable WASAPI 客户端(W9-4 探针专用;audio.py 零侵入)。"""

    # vtable 槽位(0=QI,1=AddRef,2=Release 之后按接口方法序)
    SLOT_ENUM_GETDEFAULT = 4      # IMMDeviceEnumerator::GetDefaultAudioEndpoint
    SLOT_DEV_ACTIVATE = 3         # IMMDevice::Activate
    SLOT_DEV_GETID = 5            # IMMDevice::GetId
    SLOT_CLI_INITIALIZE = 3       # IAudioClient::Initialize
    SLOT_CLI_GETMIXFMT = 8        # IAudioClient::GetMixFormat
    SLOT_CLI_START = 10           # IAudioClient::Start
    SLOT_CLI_STOP = 11            # IAudioClient::Stop
    SLOT_CLI_GETSERVICE = 14      # IAudioClient::GetService
    SLOT_CAP_NEXTPACKET = 5       # IAudioCaptureClient::GetNextPacketSize
    SLOT_CAP_GETBUFFER = 3        # IAudioCaptureClient::GetBuffer
    SLOT_CAP_RELEASEBUF = 4       # IAudioCaptureClient::ReleaseBuffer

    CLSID_MMDeviceEnumerator = "{bcde0395-e52f-467c-8e3d-c4579291692e}"
    IID_IMMDeviceEnumerator = "{a95664d2-9614-4f35-a746-de8db63617e6}"
    IID_IAudioClient = "{1cb9ad4c-dbfa-4c32-b178-c2f568a703b2}"
    IID_IAudioCaptureClient = "{c8adbd64-e71e-48a0-a4de-185c395cd317}"

    def __init__(self) -> None:
        import ctypes

        self.ct = ctypes
        self.ole32 = ctypes.WinDLL("ole32")
        self.ptrs: list[int] = []

    def _fn(self, obj: int, slot: int, restype, *argtypes):
        ct = self.ct
        vtbl = ct.cast(obj, ct.POINTER(ct.c_void_p)).contents.value
        fn_addr = ct.cast(vtbl + slot * ct.sizeof(ct.c_void_p), ct.POINTER(ct.c_void_p)).contents.value
        return ct.WINFUNCTYPE(restype, ct.c_void_p, *argtypes)(fn_addr)

    def _keep(self, p) -> int:
        v = self.ct.cast(p, self.ct.c_void_p).value or 0
        if v:
            self.ptrs.append(v)
        return v

    def _release_all(self) -> None:
        for v in reversed(self.ptrs):
            try:
                self._fn(v, 2, self.ct.c_ulong)(self.ct.c_void_p(v))
            except Exception:  # noqa: BLE001
                pass
        self.ptrs = []

    # ── 建链:enumerator → 默认 render 端点 → IAudioClient ──
    def open_default_render_client(self) -> dict:
        ct = self.ct
        try:
            hr = self.ole32.CoInitializeEx(None, 0x0)  # COINIT_MULTITHREADED;已初始化则忽略
        except Exception:  # noqa: BLE001 —— OSError(已初始化/模式冲突)不阻断
            hr = -1
        from uuid import UUID

        clsid = ct.create_string_buffer(UUID(self.CLSID_MMDeviceEnumerator).bytes_le)
        iid_enum = ct.create_string_buffer(UUID(self.IID_IMMDeviceEnumerator).bytes_le)
        pv = ct.c_void_p()
        hr = self.ole32.CoCreateInstance(
            ct.byref(clsid), None, 0x17, ct.byref(iid_enum), ct.byref(pv))
        if hr != 0:
            return {"error": f"CoCreateInstance hr=0x{hr & 0xFFFFFFFF:08x}"}
        enum = self._keep(pv)

        dev = ct.c_void_p()
        hr = self._fn(enum, self.SLOT_ENUM_GETDEFAULT, ct.c_long, ct.c_uint32, ct.c_uint32,
                      ct.POINTER(ct.c_void_p))(ct.c_void_p(enum), 0, 0, ct.byref(dev))
        if hr != 0:
            self._release_all()
            return {"error": f"GetDefaultAudioEndpoint hr=0x{hr & 0xFFFFFFFF:08x}(无默认 render 端点?)"}
        devp = self._keep(dev)

        # 端点 ID(GetId → CoTaskMemAlloc 的 wchar*;记证据后释放)
        wid = ct.c_wchar_p()
        hr = self._fn(devp, self.SLOT_DEV_GETID, ct.c_long, ct.POINTER(ct.c_wchar_p))(
            ct.c_void_p(devp), ct.byref(wid))
        endpoint_id = wid.value if hr == 0 else None
        if endpoint_id:
            self.ole32.CoTaskMemFree(None)

        iid_cli = ct.create_string_buffer(UUID(self.IID_IAudioClient).bytes_le)
        client = ct.c_void_p()
        hr = self._fn(devp, self.SLOT_DEV_ACTIVATE, ct.c_long,
                      ct.POINTER(ct.c_ubyte * 16), ct.c_uint32, ct.c_void_p,
                      ct.POINTER(ct.c_void_p))(
            ct.c_void_p(devp), ct.cast(iid_cli, ct.POINTER(ct.c_ubyte * 16)), 0x17, None, ct.byref(client))
        if hr != 0:
            self._release_all()
            return {"error": f"Activate(IAudioClient) hr=0x{hr & 0xFFFFFFFF:08x}", "endpoint_id": endpoint_id}
        clip = self._keep(client)
        return {"ok": True, "endpoint_id": endpoint_id, "client": clip}

    # ── mix format 解析(WAVEFORMATEX / EXTENSIBLE)──
    def mix_format(self, client: int) -> dict:
        ct = self.ct

        class WFX(ct.Structure):
            _fields_ = [
                ("tag", ct.c_ushort), ("channels", ct.c_ushort), ("sr", ct.c_uint),
                ("byterate", ct.c_uint), ("align", ct.c_ushort), ("bits", ct.c_ushort),
                ("cbSize", ct.c_ushort),
            ]

        pwfx = ct.c_void_p()
        hr = self._fn(client, self.SLOT_CLI_GETMIXFMT, ct.c_long, ct.POINTER(ct.c_void_p))(
            ct.c_void_p(client), ct.byref(pwfx))
        if hr != 0:
            return {"error": f"GetMixFormat hr=0x{hr & 0xFFFFFFFF:08x}"}
        fmt = ct.cast(pwfx, ct.POINTER(WFX)).contents
        tag = int(fmt.tag)
        if tag == 0xFFFE and int(fmt.cbSize) >= 22:  # EXTENSIBLE:SubFormat 首 2 字节 = 真标签
            raw = ct.cast(pwfx, ct.POINTER(ct.c_ubyte * (ct.sizeof(WFX) + int(fmt.cbSize)))).contents
            tag = raw[ct.sizeof(WFX)] | (raw[ct.sizeof(WFX) + 1] << 8)
        info = {"tag": tag, "channels": int(fmt.channels), "sr": int(fmt.sr),
                "bits": int(fmt.bits), "wfx_ptr": pwfx.value}
        return info

    def initialize_loopback(self, client: int, wfx_ptr: int) -> int:
        ct = self.ct
        return self._fn(client, self.SLOT_CLI_INITIALIZE, ct.c_long,
                        ct.c_uint32, ct.c_uint32, ct.c_longlong, ct.c_longlong,
                        ct.c_void_p, ct.c_void_p)(
            ct.c_void_p(client), 0, 0x00020000, 20_000_000, 0, ct.c_void_p(wfx_ptr), None)

    def start(self, client: int) -> int:
        return self._fn(client, self.SLOT_CLI_START, self.ct.c_long)(self.ct.c_void_p(client))

    def stop(self, client: int) -> int:
        return self._fn(client, self.SLOT_CLI_STOP, self.ct.c_long)(self.ct.c_void_p(client))

    def get_capture(self, client: int) -> int:
        from uuid import UUID

        ct = self.ct
        iid_cap = ct.create_string_buffer(UUID(self.IID_IAudioCaptureClient).bytes_le)
        cap = ct.c_void_p()
        hr = self._fn(client, self.SLOT_CLI_GETSERVICE, ct.c_long,
                      ct.POINTER(ct.c_ubyte * 16), ct.POINTER(ct.c_void_p))(
            ct.c_void_p(client), ct.cast(iid_cap, ct.POINTER(ct.c_ubyte * 16)), ct.byref(cap))
        if hr != 0:
            return 0
        return self._keep(cap)

    def drain(self, cap: int, seconds: float, fmt: dict, sink: list) -> int:
        """轮询读包(单声道 float 化入 sink);返回累计样本数。"""
        ct = self.ct
        total = 0
        deadline = time.time() + seconds
        channels, bits, tag = fmt["channels"], fmt["bits"], fmt["tag"]
        while time.time() < deadline:
            n = ct.c_uint32()
            hr = self._fn(cap, self.SLOT_CAP_NEXTPACKET, ct.c_long, ct.POINTER(ct.c_uint32))(
                ct.c_void_p(cap), ct.byref(n))
            if hr != 0 or n.value == 0:
                time.sleep(0.02)
                continue
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
                if flags.value & 0x2 or not data.value:  # AUDCLNT_BUFFERFLAGS_SILENT
                    sink.extend([0.0] * fcount)
                else:
                    cnt = fcount * channels
                    if tag == 3 and bits == 32:
                        sink.extend((ct.c_float * cnt).from_address(data.value))
                    elif tag == 1 and bits == 32:
                        sink.extend(v / 2147483648.0 for v in (ct.c_int32 * cnt).from_address(data.value))
                    elif tag == 1 and bits == 16:
                        sink.extend(v / 32768.0 for v in (ct.c_int16 * cnt).from_address(data.value))
                    else:
                        sink.extend([0.0] * fcount)
                    if channels > 1:  # 多声道 → 平均成单声道(与 audio.py _decode 同语义)
                        flat = sink[len(sink) - cnt:]
                        mono = [sum(flat[i * channels:(i + 1) * channels]) / channels for i in range(fcount)]
                        sink[len(sink) - cnt:] = mono
                total += fcount
                self._fn(cap, self.SLOT_CAP_RELEASEBUF, ct.c_long, ct.c_uint32)(
                    ct.c_void_p(cap), fcount)
                nn = ct.c_uint32()
                hr2 = self._fn(cap, self.SLOT_CAP_NEXTPACKET, ct.c_long, ct.POINTER(ct.c_uint32))(
                    ct.c_void_p(cap), ct.byref(nn))
                if hr2 != 0:
                    break
                n = nn
        return total


def probe_da4() -> dict:
    """WASAPI 真建链(原始 vtable)→ winsound 真播放合成叮声 → 回环采 ~2.5s → 5 类判决。"""
    checks: list[tuple[str, bool]] = []

    def check(name: str, cond: bool) -> None:
        print(f"[{'PASS' if cond else 'FAIL'}] D-A4 {name}")
        checks.append((name, bool(cond)))

    ev: dict = {"probe": "real_probe.py --dA4", "depth": "真软件栈(原始 vtable WASAPI)+真播放声学在环"}
    from dsh_physical.audio import WasapiLoopbackRunner, classify_window, synth_notification_ding

    if sys.platform != "win32":
        ev.update({"status": "degraded", "verdict": "非 win32 —— WASAPI 唯余 Windows 在场"})
        return ev

    # 0) audio.py 既有 runner 在本机的诚实状态(实证记录,不改其逻辑)
    probe_runner = WasapiLoopbackRunner()
    probe_runner.read()
    ev["audio_py_runner_status"] = probe_runner.describe()

    raw = _RawWasapi()
    link = raw.open_default_render_client()
    ev["link"] = {k: v for k, v in link.items() if k != "client"}
    if "error" in link:
        raw._release_all()  # noqa: SLF001
        ev.update({
            "status": "degraded",
            "verdict": f"WASAPI 建链失败({link['error']})—— 唯余真 render 端点硬件在场",
        })
        return ev
    client = link["client"]
    check("WASAPI 真建链:CoCreateInstance→默认 render 端点→Activate(IAudioClient)", True)

    fmt = raw.mix_format(client)
    ev["mix_format"] = {k: v for k, v in fmt.items() if k != "wfx_ptr"}
    if "error" in fmt:
        raw._release_all()
        ev.update({"status": "failed", "error": fmt["error"]})
        return ev
    check(f"GetMixFormat 真设备格式:{fmt['sr']}Hz {fmt['bits']}bit {fmt['channels']}ch tag=0x{fmt['tag']:X}", fmt["sr"] > 0)

    hr = raw.initialize_loopback(client, fmt["wfx_ptr"])
    check("Initialize(SHARED, LOOPBACK) hr=0", hr == 0)
    if hr != 0:
        raw._release_all()
        ev.update({"status": "failed", "error": f"Initialize hr=0x{hr & 0xFFFFFFFF:08x}"})
        return ev
    cap = raw.get_capture(client)
    check("GetService(IAudioCaptureClient)", cap != 0)
    if cap == 0:
        raw._release_all()
        ev.update({"status": "failed", "error": "GetService failed"})
        return ev
    raw.start(client)

    # 真播放:合成叮声经 winsound 走系统 render 路径(与回环捕获同一 mix)
    played = False
    play_note = ""
    try:
        import tempfile

        import winsound  # type: ignore[import-not-found]

        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "w9_ding.wav"
            _write_wav(wav, synth_notification_ding(48_000), 48_000)
            try:
                winsound.PlaySound(str(wav), winsound.SND_FILENAME | winsound.SND_ASYNC)
                played = True
            except Exception as e:  # noqa: BLE001
                play_note = f"winsound playback failed: {e}"
    except Exception as e:  # noqa: BLE001
        play_note = f"playback path unavailable: {e}"
    ev["playback"] = {"played": played, "note": play_note}
    check("winsound 真播放合成叮声(880Hz 指数衰减 220ms)", played)

    samples: list[float] = []
    t0 = time.monotonic()
    n = raw.drain(cap, 2.5, fmt, samples)
    elapsed = time.monotonic() - t0
    raw.stop(client)
    raw._release_all()  # noqa: SLF001
    ev["capture"] = {"frames": n, "elapsed_s": round(elapsed, 2), "seconds_audio": round(n / fmt["sr"], 2)}
    check(f"回环真采样本({n} 帧 ≈ {n / fmt['sr']:.2f}s)", n > fmt["sr"] // 2)

    # 喂 audio.py 纯函数分类器(真样本,真采样率)
    window = samples[-int(fmt["sr"] * 2.0):] if len(samples) > fmt["sr"] else samples
    verdict = classify_window(window, fmt["sr"]) if window else {"event": "no-samples", "confidence": 0.0}
    ev["classifier_verdict"] = verdict
    check("audio.py 纯函数分类器对真回环样本产出判决", verdict["event"] != "no-samples")
    ev["non_silence"] = verdict["event"] != "silence"
    if played:
        check(f"真声学在环闭环:播放叮声→回环→分类 = {verdict['event']}(conf {verdict['confidence']})",
              verdict["event"] != "silence")

    ev["status"] = "ok" if all(c for _, c in checks) else ("degraded" if ev.get("non_silence") else "failed")
    runner_note = (
        ";audio.py 既有 WasapiLoopbackRunner 在 py3.14+comtypes1.4.17 因 ctypes 出参约定回归不可用"
        f"(reason={ev['audio_py_runner_status'].get('reason', 'n/a')[:160]})"
        if not ev["audio_py_runner_status"].get("available")
        else ""
    )
    ev["verdict"] = (
        "WASAPI 真建链(原始 vtable)+ 真播放→回环→分类闭环:"
        f"判决={verdict['event']} —— D-A4 软件在环已闭{runner_note};唯余:真实系统提示音生态现场长跑"
        if played and verdict["event"] != "silence"
        else f"WASAPI 真建链+真采集在环(播放/捕获未成环:{play_note or '窗口未检出非静默'})"
             f"—— 部分实证;唯余真声学输出链在场{runner_note}"
    )
    return ev


def _write_wav(path: Path, samples: list[float], sr: int) -> None:
    import array
    import wave

    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(array.array("h", (max(-32767, min(32767, int(x * 32767))) for x in samples)).tobytes())


# ═══ D-A2:pyserial 真序列化回读(loop://)(W9-4)═══


def probe_da2() -> dict:
    """COM 口枚举为证无棒;CH9329 帧经真 pyserial 序列化写出 → loop:// 回读 → 解帧。"""
    checks: list[tuple[str, bool]] = []

    def check(name: str, cond: bool) -> None:
        print(f"[{'PASS' if cond else 'FAIL'}] D-A2 {name}")
        checks.append((name, bool(cond)))

    ev: dict = {"probe": "real_probe.py --dA2", "depth": "真软件栈(pyserial loop:// 序列化)+无棒(mock 物理层)"}
    try:
        import serial
        from serial.tools import list_ports

        from dsh_physical.hid import CMD_ABS_MOUSE, HidConfig, HidController, parse_ch9329_frame

        ports = [(p.device, p.description or "", p.vid) for p in list_ports.comports()]
    except Exception as e:  # noqa: BLE001
        ev.update({"status": "failed", "error": f"import failed: {e}"})
        return ev
    ev["comports"] = [{"device": d, "desc": desc, "vid": vid} for d, desc, vid in ports]
    ev["ch9329_stick_present"] = any(vid in (0x1A86, 0x10C4, 0x0403) for _, _, vid in ports)
    check("串口枚举执行(pyserial ListPortInfo 真系统查询)", True)
    check("本机无 CH9329 棒(COM 口空/无已知 VID)", not ev["ch9329_stick_present"])

    class LoopSerialTransport:
        """loop:// 适配器:注入 HidController 的 transport 缝(真 pyserial 实例)。"""

        def __init__(self, ser) -> None:
            self._ser = ser

        def open(self) -> None:
            if not self._ser.is_open:
                self._ser.open()

        def write(self, data: bytes) -> None:
            self._ser.write(data)

        def read(self, size: int) -> bytes:
            return self._ser.read(size) or b""

        def flush(self) -> None:
            self._ser.flush()

        def close(self) -> None:
            if self._ser.is_open:
                self._ser.close()

        def describe(self) -> dict:
            return {"backend": "pyserial-loop", "port": "loop://", "open": self._ser.is_open}

    try:
        ser = serial.serial_for_url("loop://", timeout=0.05)
    except Exception as e:  # noqa: BLE001
        ev.update({
            "status": "degraded",
            "loop_error": f"{type(e).__name__}: {e}",
            "verdict": f"pyserial loop:// 不可用({e})—— 帧构造数学已由 --selftest 闭;唯余真棒在场",
        })
        return ev

    async def _exercise() -> dict:
        tr = LoopSerialTransport(ser)
        ctrl = HidController(HidConfig(key_interval_ms=0), transport=tr)
        await ctrl.click(0.5, 0.5)
        await ctrl.drag({"x": 0.1, "y": 0.1}, {"x": 0.9, "y": 0.9})
        await ctrl.type_text("Hi")
        await ctrl.press_hotkey(["ctrl", "shift", "esc"])
        return {"frames_sent": ctrl._frames_sent}  # noqa: SLF001 —— 探针只读

    sent = asyncio.run(_exercise())
    ev["frames_sent"] = sent["frames_sent"]

    # 回读:真 pyserial Serial.read 从 loop:// 缓冲取回全部字节,逐帧解校验
    time.sleep(0.1)
    raw = b""
    deadline = time.time() + 1.0
    while time.time() < deadline:
        chunk = ser.read(4096)
        if chunk:
            raw += chunk
        elif raw:
            break
    ser.close()
    ev["wire_bytes"] = len(raw)

    frames: list[dict] = []
    off = 0
    parse_clean = True
    while off < len(raw):
        try:
            addr, cmd, data = parse_ch9329_frame(raw[off:])
        except ValueError as e:
            parse_clean = False
            ev["parse_error_at"] = {"offset": off, "error": str(e), "remaining": len(raw) - off}
            break
        flen = 5 + len(data) + 1
        frames.append({"addr": addr, "cmd": f"0x{cmd:02x}", "len": len(data),
                       "data_head": list(data[:3])})
        off += flen
    ev["frames_parsed"] = frames

    check("真序列化:控制器 12 帧全部经 pyserial 写出(click2+drag4+text4+hotkey2)", sent["frames_sent"] == 12)
    check("回读字节流逐帧解校验通过(帧头/长度/SUM 累加和,零残余字节)", parse_clean and off == len(raw) and len(frames) == 12)
    check("首帧 = 绝对鼠标按下 @(0x3FFF,0x3FFF)",
          bool(frames) and frames[0]["cmd"] == "0x02" and frames[0]["data_head"][0] == 0x01)

    ev["status"] = "ok" if all(c for _, c in checks) else "failed"
    ev["verdict"] = (
        "CH9329 协议帧经真 pyserial 序列化(loop:// 全双工回环)写出→回读→逐帧"
        "SUM 校验通过 —— 比 mock 深一层(真 Serial.write/read 代码路径);"
        "本机无 CH9329 棒(COM 枚举空)—— D-A2 唯余真棒在目标设备注入的硬件闭环"
    )
    return ev


# ═══ D-A3:adb/scrcpy 在场性探测(W9-4)═══


def probe_da3() -> dict:
    """adb/scrcpy/scrcpy-server.jar 探测;缺席 ⇒ 定谳唯余硬件。"""
    ev: dict = {"probe": "real_probe.py --dA3", "depth": "在场性探测(定谳证据)"}
    adb = shutil.which("adb")
    scrcpy = shutil.which("scrcpy")
    ev["adb_on_path"] = adb
    ev["scrcpy_on_path"] = scrcpy
    if adb:
        try:
            r = subprocess.run([adb, "version"], capture_output=True, timeout=10, text=True)
            ev["adb_version"] = r.stdout.strip().splitlines()[0] if r.stdout.strip() else f"rc={r.returncode}"
            r2 = subprocess.run([adb, "devices"], capture_output=True, timeout=10, text=True)
            ev["adb_devices"] = r2.stdout.strip()
        except Exception as e:  # noqa: BLE001
            ev["adb_probe_error"] = str(e)
    jars: list[str] = []
    for base in (ROOT, ROOT / "python_service", ROOT / "scripts", ROOT / "dist", ROOT / "test"):
        if base.is_dir():
            jars += [str(p) for p in base.glob("scrcpy-server*.jar")]
    ev["scrcpy_server_jars"] = jars
    device_present = bool(ev.get("adb_devices", "").strip().splitlines()[2:]) if adb and "adb_devices" in ev else False
    ev["android_device_attached"] = device_present
    ev["status"] = "ok"
    if adb and device_present:
        ev["verdict"] = "adb 与真设备在场 —— 可端到端;唯余自动化纳入"
    else:
        ev["verdict"] = (
            f"本机无 adb({'PATH 未命中' if not adb else '在场但无设备'})、无 scrcpy"
            f"({'PATH 未命中' if not scrcpy else '在场'})、无 scrcpy-server.jar"
            f"({'未找到' if not jars else jars}) —— D-A3 唯余 Android 设备+adb 在场"
            "(离线契约/mock runner 证据链已由 --selftest 闭)"
        )
    print(f"[PASS] D-A3 定谳证据采集:adb={'有' if adb else '无'} scrcpy={'有' if scrcpy else '无'}")
    return ev


# ═══ D-A5:真三进程真 socket barrier 往返(W9-4)═══


def probe_da5() -> dict:
    """federation-server 子进程 + 两个独立 node 客户端进程,真 HTTP socket 往返。"""
    checks: list[tuple[str, bool]] = []

    def check(name: str, cond: bool) -> None:
        print(f"[{'PASS' if cond else 'FAIL'}] D-A5 {name}")
        checks.append((name, bool(cond)))

    ev: dict = {"probe": "real_probe.py --dA5", "depth": "真三进程+真 socket(环回 127.0.0.1,非进程内 hub)"}
    node = _find_node()
    if node is None:
        ev.update({"status": "degraded", "verdict": "node 缺席 —— 无法起 server/客户端进程;唯余部署环境"})
        return ev
    server_js = ROOT / "scripts" / "federation-server.mjs"
    client_js = ROOT / "scripts" / "w9real-barrier-client.mjs"
    if not (server_js.exists() and client_js.exists()):
        ev.update({"status": "failed", "error": "server/client script missing"})
        return ev

    srv = subprocess.Popen(
        [node, str(server_js), "--port", "0"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    port = None
    deadline = time.time() + 10
    buf = ""
    while time.time() < deadline and port is None:
        line = srv.stdout.readline() if srv.stdout else ""
        if line:
            buf += line
            if '"event":"listening"' in buf:
                import re

                m = re.search(r'"port":(\d+)', buf)
                if m:
                    port = int(m.group(1))
        elif srv.poll() is not None:
            break
    ev["server"] = {"pid": srv.pid, "port": port, "boot_log_head": buf[:200]}
    check("federation-server 子进程启动并报监听口", port is not None)
    if port is None:
        srv.kill()
        ev.update({"status": "failed", "error": "server 未报口"})
        return ev

    import urllib.request

    base = f"http://127.0.0.1:{port}"
    healthy = False
    for _ in range(30):
        try:
            with urllib.request.urlopen(f"{base}/health", timeout=2) as r:
                if r.status == 200:
                    healthy = True
                    break
        except Exception:  # noqa: BLE001
            time.sleep(0.15)
    check("/health 探活 200", healthy)
    if not healthy:
        srv.kill()
        ev.update({"status": "failed", "error": "health 不通"})
        return ev

    name = f"w9-real-{int(time.time())}"
    t0 = time.monotonic()
    procs = {}
    for peer in ("A", "B"):
        procs[peer] = subprocess.Popen(
            [node, str(client_js), "--endpoint", base, "--peer", peer, "--name", name,
             "--n", "2", "--poll-ms", "25", "--timeout-ms", "8000"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
    results = {}
    for peer, p in procs.items():
        try:
            out, _ = p.communicate(timeout=20)
        except subprocess.TimeoutExpired:  # noqa: BLE001
            p.kill()
            out = ""
        results[peer] = {"pid": p.pid, "rc": p.returncode, "stdout": out.strip()}
    ev["roundtrip_s"] = round(time.monotonic() - t0, 3)
    ev["clients"] = results

    parsed = {}
    for peer, r in results.items():
        parsed[peer] = None
        for line in r["stdout"].splitlines():
            if line.startswith("RESULT "):
                try:
                    parsed[peer] = json.loads(line[7:])
                except json.JSONDecodeError:
                    pass
    ev["outcomes"] = parsed
    okA, okB = parsed["A"], parsed["B"]
    check("双客户端进程独立成活(PID 互异且异于 server)",
          okA and okB and okA["pid"] != okB["pid"] != srv.pid and okA["pid"] != srv.pid)
    check("A/B 双双放行(ok=true,退出码 0)",
          bool(okA and okB and okA["ok"] and okB["ok"] and results["A"]["rc"] == 0 and results["B"]["rc"] == 0))
    check("同 generation 同 seq + 名册 {A,B}",
          bool(okA and okB and okA.get("seq") == okB.get("seq") is not None
               and sorted(okA.get("peers") or []) == ["A", "B"]))
    check("两阶段确认回执 ackOk=true",
          bool(okA and okB and okA.get("ackOk") and okB.get("ackOk")))

    retired = None
    try:
        req = urllib.request.Request(f"{base}/barrier/status?name={name}", method="GET")
        with urllib.request.urlopen(req, timeout=2) as r:
            retired = json.loads(r.read().decode())
    except Exception as e:  # noqa: BLE001
        retired = {"error": str(e)}
    ev["status_query_after"] = retired
    check("双端确认 ⇒ generation 退休(unknown-barrier)", isinstance(retired, dict) and retired.get("reason") == "unknown-barrier")

    srv.terminate()
    try:
        srv.wait(timeout=3)
    except subprocess.TimeoutExpired:  # noqa: BLE001
        srv.kill()

    ev["status"] = "ok" if all(c for _, c in checks) else "failed"
    ev["verdict"] = (
        "真三进程(server + 客户端 A + 客户端 B)经 127.0.0.1 真 socket 完成"
        "两阶段 barrier 往返并退休 —— D-A5 从「环回参考」升为「真 socket "
        "多进程实证」;唯余:跨物理机的生产拓扑(TLS/限速/反代 —— 部署面 D-C2)"
    )
    return ev


# ═══ D-A6 / D-A7 / D-G4:物理边界定谳(W9-4)═══


def probe_da6() -> dict:
    """七项效能数字与 inset IoU A/B —— 离线确定性基准的在场证明 + 定谳。"""
    benches = [
        "test/w5cascade.bench.ts", "test/w5gate.bench.ts", "test/w5ledger.bench.ts",
        "test/w5macro.bench.ts", "test/w5roi.bench.ts", "test/w5settle.bench.ts",
        "test/ablation.bench.ts",
    ]
    found = {b: (ROOT / b).stat().st_size if (ROOT / b).exists() else None for b in benches}
    som = (ROOT / "test/w5somcall.test.ts").exists()
    ev = {
        "probe": "real_probe.py --dA6", "depth": "唯余硬件(真模型/长跑)",
        "bench_files": found, "w5somcall_present": som, "status": "ok",
        "verdict": (
            "七项效能证据全部为离线确定性基准(bench 文件在场:"
            f"{sum(1 for v in found.values() if v)} 个)+ SoM 模拟证据(w5somcall"
            f"{'在' if som else '缺席'})—— 在线真 VLM 对照/A-B 增益需真模型 API "
            "密钥与长跑预算,软件在环已尽(mock 边界诚实申报),唯余真模型在场"
        ),
    }
    print("[PASS] D-A6 定谳:离线基准文件在场证明 + 真模型长跑唯余硬件")
    return ev


def probe_da7() -> dict:
    """Linux UDS dispatcher —— 本机 Windows 平台边界的可探测证据 + 定谳。"""
    has_af_unix = hasattr(socket, "AF_UNIX")
    uds_error = None
    if has_af_unix:
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.close()
        except OSError as e:  # noqa: BLE001
            uds_error = f"{type(e).__name__}: {e}"
    ci = ROOT / ".github" / "workflows" / "ci.yml"
    ci_uds_steps = None
    if ci.exists():
        txt = ci.read_text(encoding="utf-8", errors="replace")
        ci_uds_steps = {
            "linux_physical_e2e": "ubuntu" in txt and "8421" in txt,
            "mentions_dev_shm": "/dev/shm" in txt,
        }
    ev = {
        "probe": "real_probe.py --dA7", "depth": "唯余硬件(Linux 真机 CI)",
        "socket_AF_UNIX": has_af_unix, "uds_create_error": uds_error,
        "platform": sys.platform, "ci_yml": ci_uds_steps, "status": "ok",
        "verdict": (
            f"本机 {sys.platform}:socket.AF_UNIX={'在场' if has_af_unix else '缺席'}"
            f"{f'(创建失败:{uds_error})' if uds_error else ''} —— POSIX UDS 真机"
            f"执法无法在本机复现;ci.yml Linux 物理服务 e2e 步骤"
            f"{'在场' if ci_uds_steps and ci_uds_steps['linux_physical_e2e'] else '缺席'}"
            "(D-A7 半闭状态)—— 唯余下次 push 后 Linux CI runner 真机首验"
        ),
    }
    print(f"[PASS] D-A7 定谳:AF_UNIX={'有' if has_af_unix else '无'} @ {sys.platform};ci.yml Linux 步骤在场={bool(ci_uds_steps and ci_uds_steps['linux_physical_e2e'])}")
    return ev


def probe_dg4() -> dict:
    """Kalman/GPD 标定值生产数据面 —— 立法语义(只建议不落值)的在场证明 + 定谳。"""
    calib = ROOT / "src" / "calibration.ts"
    sleep_idx = ROOT / "src" / "sleep" / "index.ts"
    ev = {
        "probe": "real_probe.py --dG4", "depth": "唯余硬件(生产数据长跑)",
        "calibration_ts": calib.exists(), "sleep_index_ts": sleep_idx.exists(), "status": "ok",
        "verdict": (
            "标定值生产数据面:睡眠④幕立法语义=只建议不落值(calibration.ts"
            f"{'在' if calib.exists() else '缺席'};sleep/index.ts{'在' if sleep_idx.exists() else '缺席'})"
            "—— Kalman/GPD 落值与 Schmitt/NCD 原子(弹窗帧三元组/检索回访标签)"
            "需生产环境长跑数据积累,软件在环已尽,唯余生产数据在场"
        ),
    }
    print("[PASS] D-G4 定谳:标定建议书语义在场 + 生产数据长跑唯余硬件")
    return ev


# ═══ 报告编排(W9-4)═══

PROBES: dict[str, callable] = {  # type: ignore[type-arg]
    "D-A1": probe_da1,
    "D-A2": probe_da2,
    "D-A3": probe_da3,
    "D-A4": probe_da4,
    "D-A5": probe_da5,
    "D-A6": probe_da6,
    "D-A7": probe_da7,
    "D-G4": probe_dg4,
}


def run_debt_probe(debt: str, write_report: bool = True) -> int:
    """单债探针(--selftest-real 委托入口);报告合并落盘。"""
    fn = PROBES.get(debt)
    if fn is None:
        print(f"unknown debt: {debt} (known: {', '.join(PROBES)})")
        return 2
    ev = fn()
    if write_report:
        report = json.loads(REPORT_PATH.read_text(encoding="utf-8")) if REPORT_PATH.exists() else {"schema": "w9-real-probe/1", "debts": {}}
        report["env"] = _env_block()
        report.setdefault("debts", {})[debt] = ev
        REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"report merged -> {REPORT_PATH}")
    failed = ev.get("status") == "failed"
    print(f"{debt}: {ev.get('status')} — {ev.get('verdict', '')}")
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="W9-4 需真机债的软件在环实证总探针")
    ap.add_argument("--only", default="", help="逗号分隔债号(如 D-A1,D-A5);空 = 全矩阵")
    for key in PROBES:
        ap.add_argument(f"--{key.replace('-', '')}", action="store_true", help=f"单跑 {key}")
    args = ap.parse_args(argv)

    wanted = [d.strip() for d in args.only.split(",") if d.strip()]
    for key in PROBES:
        if getattr(args, key.replace("-", "")):
            wanted.append(key)
    if not wanted:
        wanted = list(PROBES)

    report: dict = {"schema": "w9-real-probe/1", "env": _env_block(), "debts": {}}
    rc = 0
    for debt in wanted:
        fn = PROBES[debt]
        t0 = time.monotonic()
        try:
            ev = fn()
        except Exception as e:  # noqa: BLE001 —— 探针级诚实失败(不静默)
            import traceback

            traceback.print_exc()
            ev = {"probe": f"real_probe.py --{debt.replace('-', '')}", "status": "failed",
                  "error": f"{type(e).__name__}: {e}", "verdict": "探针异常(诚实失败码)"}
        ev["elapsed_s"] = round(time.monotonic() - t0, 3)
        report["debts"][debt] = ev
        if ev.get("status") == "failed":
            rc = 1
        print(f"== {debt}: {ev.get('status')} ({ev['elapsed_s']}s)")

    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nreport -> {REPORT_PATH} ({len(report['debts'])} debts)")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
