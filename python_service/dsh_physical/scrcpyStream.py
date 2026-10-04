"""W6-6 scrcpy 常驻视频流 PoC —— L1 遗留补全:单帧按需 → 常驻流取帧。

CLI 调研结论(实读 scrcpy v2.7 ``doc/develop.md``,2026-10):
  scrcpy 2.x 客户端 CLI **没有**「H.264 裸流写 stdout」的开关(``--record``
  是容器封装且面向文件路径)。任务卡里的 ``--no-display --video-codec=h264
  --no-audio --send-dummy-meta?`` 中的 ``--send-dummy-meta`` 并非客户端
  旗标 —— 它是 **scrcpy-server 端 key=value 参数族**
  (``send_device_meta`` / ``send_frame_meta`` / ``send_dummy_byte`` /
  ``raw_stream``)。官方 standalone 裸流姿势 = 直接跑设备端 server:

    adb push scrcpy-server /data/local/tmp/scrcpy-server.jar
    adb forward tcp:<port> localabstract:scrcpy_<scid>
    adb -s <serial> shell CLASSPATH=/data/local/tmp/scrcpy-server.jar \
        app_process / com.genymobile.scrcpy.Server <version> \
        scid=<31bit> log_level=error video_codec=h264 audio=false \
        control=true send_device_meta=false tunnel_forward=true \
        max_size=<n> max_fps=<n> video_bit_rate=<n>

  然后 TCP 连 ``127.0.0.1:<port>`` 读 video socket(读线程消费,与
  「stdout 读取线程」同构 —— 字节源经 ``ByteSource`` 抽象,socket/管道
  /mock 统一)。

video socket 字节序列(v2.x,framing_profile="2x"):
  1. ``tunnel_forward=true`` ⇒ 先收 1 字节 dummy byte(连接探测);
  2. ``send_device_meta=false`` ⇒ 跳过 device name 块(变长,免解析);
  3. codec meta 12B:codec id u32('h264' 四字符码 0x68323634)+ width
     u32 + height u32(大端);
  4. 每包 12B 头:u64 = config(1bit,MSB)+ keyframe(1bit)+ PTS
     (u62,= MediaCodec presentationTimeUs,微秒)+ packet size u32,
     随后是裸载荷 —— 顺序拼接即重建 H.264 ES(config 包 = CSD/SPS/PPS,
     必须照喂解码器)。
  scrcpy ≥3.0 头多一位 media/session 旗标(media+config+keyframe+PTS
  u61)—— ``framing_profile="4x"`` 已预留(真机清单校验点)。

资源纪律(本模块的铁律):
  - **背压安全**:帧环形缓冲 ``deque(maxlen=ring_capacity)``,最新帧覆盖
    式 —— 慢消费最多丢帧,永不排队涨内存(有界 = capacity × 单帧字节)。
  - **idle 停流**:watchdog 周期检查 ``last_access``,超 ``idle_timeout_s``
    自动 kill 子进程 + 关 socket(省电);下次 grab 惰性重启。
  - **启动失败降级**:spawn/首帧超时 ⇒ 流退出 + 冷却退避,控制器降回
    既有单帧链(android.py 的降级链分毫不动)。
    - **清理执法**:close = kill 子进程 + ``wait()`` + 关 socket + 移除
      adb forward(尽力,失败不阻塞)+ join 读线程 + decoder.close()。
    - **ΝΩ-52 控制通道复用**:``control=true`` 起流,控制连接是同一
      forward 端口的第二次 connect(forward 模式 server 收齐 video+control
      两个 accept 才开流,故在 spawner ``open()`` 内紧跟视频连接完成)。
      ``ControlWriter`` 写控制消息(tap/swipe/scroll/key 从 adb 一次性
      子进程 50-200ms → 写 socket <10ms);写失败 ⇒ 通道病亡随流同葬,
      动作降级 adb —— 运行层零异常、零新增依赖、缺席即旧行为。
    - 解码器可注入:pyav(真流式)→ cv2(POSIX fifo,实验)→ 都缺席则
      诚实 unsupported(不引第三方硬依赖, ImportError 即降级)。
"""
from __future__ import annotations

import os
import random
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

from PIL import Image

if __package__:  # 包内正常导入
    from .config import AndroidConfig
else:  # 直接脚本运行（python scrcpyStream.py --selftest）—— sys.path[0]=本目录
    from config import AndroidConfig  # type: ignore[no-redef]

# ─── W6-6 流配置(env 驱动;领地纪律:不碰 config.py,自治于此)───


@dataclass(frozen=True)
class StreamConfig:
    """常驻流参数。缺省 ``enabled=False`` —— 不显式开启则单帧链行为
    分毫不动(零回归铁律)。环境变量前缀 ``DSH_PHYSICAL_ANDROID_STREAM``。"""

    enabled: bool = False
    max_size: int = 1280            # server max_size(与单帧链 scrcpy --max-size 对齐)
    video_bit_rate: int = 4_000_000  # server video_bit_rate(bps)
    max_fps: int = 15               # server max_fps(产流节流 —— 省电第一道)
    idle_timeout_s: float = 10.0    # 无消费多久后自动停流
    first_frame_timeout_s: float = 5.0  # 惰性启动后等首帧的墙钟预算
    ring_capacity: int = 3          # 帧环形缓冲深度(背压上界的分母)
    gate_distance: int = 2          # 流内 dhash 门控距离(h264 有损 → 容 2bit 抖动)
    watchdog_tick_s: float = 0.5    # idle 看门狗周期
    start_cooldown_s: float = 30.0  # 启动失败后的退避(防止每次 grab 都重 spawn)
    decoder: str = "auto"           # auto | pyav | cv2 | none
    server_jar: str = "auto"        # scrcpy-server 路径;auto = 依 scrcpy 可执行文件探测
    tunnel_port: int = 27183        # adb forward 本地端口基
    framing_profile: str = "2x"     # 2x | 4x(帧头位序剖面,见模块 docstring)
    # ΝΩ-36:adb forward 端口冲突时的 scid 重掷上限(0 = 不重掷,旧行为)。
    # ``port = base + (scid % 512)`` 的随机冲突曾直接判 spawn 失败 ⇒ 30s
    # 冷却退避;冲突(而非永久故障)场景下重掷即愈。
    port_conflict_retries: int = 3
    # ΝΩ-52:控制通道单次 send 墙钟上限 —— server 常驻读控制 socket,健康时
    # 写入 <1ms;超时 ⇒ 通道病亡(socket close)降级 adb(写延迟有界铁律)。
    control_send_timeout_s: float = 2.0


def stream_config_from_env() -> StreamConfig:
    """W6-6:env → StreamConfig(加载层校验,异常诚实第一条)。"""
    def _b(name: str, default: bool) -> bool:
        raw = os.environ.get(name)
        if raw is None:
            return default
        return raw.strip().lower() in {"1", "true", "yes", "on"}

    def _i(name: str, default: int) -> int:
        raw = os.environ.get(name)
        return default if raw is None else int(raw)

    def _f(name: str, default: float) -> float:
        raw = os.environ.get(name)
        return default if raw is None else float(raw)

    pfx = "DSH_PHYSICAL_ANDROID_STREAM"
    decoder = os.environ.get(f"{pfx}_DECODER", "auto").lower()
    if decoder not in {"auto", "pyav", "cv2", "none"}:
        raise ValueError(f"{pfx}_DECODER must be auto|pyav|cv2|none, got {decoder!r}")
    profile = os.environ.get(f"{pfx}_PROFILE", "2x").lower()
    if profile not in {"2x", "4x"}:
        raise ValueError(f"{pfx}_PROFILE must be 2x|4x, got {profile!r}")
    return StreamConfig(
        enabled=_b(f"{pfx}_ENABLED", False),
        max_size=max(64, _i(f"{pfx}_MAX_SIZE", 1280)),
        video_bit_rate=max(100_000, _i(f"{pfx}_BITRATE", 4_000_000)),
        max_fps=max(1, _i(f"{pfx}_MAX_FPS", 15)),
        idle_timeout_s=max(0.05, _f(f"{pfx}_IDLE_S", 10.0)),
        first_frame_timeout_s=max(0.1, _f(f"{pfx}_FIRST_FRAME_S", 5.0)),
        ring_capacity=max(1, _i(f"{pfx}_RING", 3)),
        gate_distance=max(0, _i(f"{pfx}_GATE_DIST", 2)),
        watchdog_tick_s=max(0.01, _f(f"{pfx}_TICK_S", 0.5)),
        start_cooldown_s=max(0.0, _f(f"{pfx}_COOLDOWN_S", 30.0)),
        decoder=decoder,
        server_jar=os.environ.get(f"{pfx}_SERVER_JAR", "auto"),
        tunnel_port=_i(f"{pfx}_PORT", 27183),
        framing_profile=profile,
        port_conflict_retries=max(0, _i(f"{pfx}_PORT_RETRIES", 3)),
        control_send_timeout_s=max(0.05, _f(f"{pfx}_CONTROL_SEND_TIMEOUT_S", 2.0)),
    )


# ─── W6-6 帧记录(PTS 时戳保留的载体)───


@dataclass(frozen=True)
class FrameRecord:
    """一帧的完整出处:像素 + 解码序号 + 协议 PTS(微秒)+ 指纹。

    ``image`` 归流所有(环形缓冲覆盖后仍可被消费方持有 —— Python GC 兜
    底);消费方只读,不得原地修改(与单帧链 PIL 契约一致)。
    """

    image: Image.Image
    pts_us: int | None   # 协议 PTS(MediaCodec presentationTimeUs);None = 无头裸流
    seq: int             # 流内单调帧号(门控丢弃不推进 —— 「帧未变不重复产出」的可观测面)
    dhash: str           # 流内门控指纹(算法对齐 screen.compute_dhash)
    wall_s: float        # 收帧墙钟(time.time)

    @property
    def width(self) -> int:
        return self.image.width

    @property
    def height(self) -> int:
        return self.image.height


@dataclass(frozen=True)
class Packet:
    """FrameParser 解出的一个编码包(v2.x/4x 12B 头 + 载荷)。"""

    payload: bytes
    pts_us: int | None
    config: bool   # CSD(SPS/PPS 等)—— 照喂解码器
    keyframe: bool


# ─── W6-6 流内 dhash 门控(帧未变不重复产出)───
#
# 算法与 screen.compute_dhash 完全对齐(9x8 灰度水平梯度 → 64bit);不复用
# import 是有意的:screen 延迟导入 android(反向依赖禁止),且 screen 拉
# numpy 重依赖。上层(screen.py capture 的 gate 参数)门控照旧 —— 流内
# 门控是第一道(省 ring 写入与上游 dhash 重算),上层门控是第二道,双保险。


def _stream_dhash(img: Image.Image) -> str:
    g = img.convert("L").resize((9, 8))
    px = list(g.getdata())
    bits = 0
    for row in range(8):
        base = row * 9
        for col in range(8):
            if px[base + col] > px[base + col + 1]:
                bits |= 1 << (row * 8 + col)
    return f"{bits:016x}"


def _hamming_hex(a: str, b: str) -> int:
    try:
        return bin(int(a, 16) ^ int(b, 16)).count("1")
    except ValueError:
        return 64  # 畸形指纹 ⇒ 最大距离(视为「变了」—— 不丢帧铁律)


# ─── W6-6 帧头解析器(v2.x framed 协议状态机;mock 可测的纯函数)───


class FrameParser:
    """video socket 字节流 → ``Packet`` 序列。

    阶段:dummy byte(1B)→ codec meta(12B)→ 包循环(12B 头 + 载荷)。
    任意分片喂入(读线程 chunk 粒度无关);codec 非 h264 ⇒ ``error``
    置位(读线程判死,诚实不猜)。
    """

    def __init__(self, profile: str = "2x", expect_dummy_byte: bool = True,
                 expect_codec_meta: bool = True) -> None:
        self.profile = profile
        self._expect_dummy = expect_dummy_byte
        self._expect_meta = expect_codec_meta
        self._stage = 0  # 0=dummy 1=codec-meta 2=packets
        self._buf = bytearray()
        self.meta: dict | None = None  # {"codec": "h264", "width": w, "height": h}
        self.error: str | None = None

    def feed(self, data: bytes) -> list[Packet]:
        if self.error is not None or not data:
            return []
        self._buf += data
        out: list[Packet] = []
        while True:
            if self._stage == 0:
                if len(self._buf) < 1:
                    break
                del self._buf[:1]  # dummy byte:内容无语义,吞掉
                self._stage = 1 if self._expect_meta else 2
            elif self._stage == 1:
                if len(self._buf) < 12:
                    break
                codec = bytes(self._buf[:4])
                width = struct.unpack(">I", self._buf[4:8])[0]
                height = struct.unpack(">I", self._buf[8:12])[0]
                del self._buf[:12]
                name = codec.decode("ascii", "replace")
                if codec != b"h264":
                    self.error = (
                        f"unsupported video codec {name!r} (only h264 is decoded; "
                        "check server video_codec=h264)"
                    )
                    break
                if width <= 0 or height <= 0:
                    self.error = f"invalid codec meta dimensions {width}x{height}"
                    break
                self.meta = {"codec": "h264", "width": width, "height": height}
                self._stage = 2
            else:
                if len(self._buf) < 12:
                    break
                u64 = struct.unpack(">Q", self._buf[:8])[0]
                size = struct.unpack(">I", self._buf[8:12])[0]
                if len(self._buf) < 12 + size:
                    break  # 半包:等下一批字节
                payload = bytes(self._buf[12:12 + size])
                del self._buf[:12 + size]
                if self.profile == "4x":
                    # scrcpy ≥3.0:media(u1)+config(u1)+keyframe(u1)+PTS(u61)
                    _media = bool(u64 >> 63 & 1)
                    config = bool(u64 >> 62 & 1)
                    keyframe = bool(u64 >> 61 & 1)
                    pts = int(u64 & 0x1FFF_FFFF_FFFF_FFFF)
                else:
                    # scrcpy v2.x:config(u1)+keyframe(u1)+PTS(u62)
                    config = bool(u64 >> 63 & 1)
                    keyframe = bool(u64 >> 62 & 1)
                    pts = int(u64 & 0x3FFF_FFFF_FFFF_FFFF)
                out.append(Packet(payload, None if config else pts, config, keyframe))
        return out


# ─── ΝΩ-52 控制消息编码器(scrcpy ≥2.0 控制协议;纯函数区,与 FrameParser 对称)───
#
# 线格式实读 scrcpy 源码定谛(app/src/control_msg.c 的 ``sc_control_msg_serialize``
# + server 端 ``ControlMessageReader.java``;v2.0 / v2.7 / 3.x 四类消息字节布局
# 逐字节一致,单测向量与 scrcpy 自带 test_control_msg_serialize.c 对齐):
#   INJECT_KEYCODE (type=0, 14B): action(u8) keycode(u32be) repeat(u32be) metastate(u32be)
#   INJECT_TOUCH_EVENT (type=2, 32B): action(u8) pointer_id(u64be) x(u32be) y(u32be)
#       screen_w(u16be) screen_h(u16be) pressure(u16fp) action_button(u32be) buttons(u32be)
#   INJECT_SCROLL_EVENT (type=3, 21B): x(u32be) y(u32be) screen_w(u16be) screen_h(u16be)
#       hscroll(i16fp) vscroll(i16fp) buttons(u32be)
#   BACK_OR_SCREEN_ON (type=4, 2B): action(u8)
#
# 坐标语义(scrcpy ≥1.19 的通用方言):位置 = 像素点 + **视频帧尺寸对**;
# server 侧 ``Device.getPhysicalPoint`` 要求 position.screen_size 与其视频尺寸
# 全等,否则事件被静默丢弃 ⇒ 编码必须用流视频坐标系(本模块 ``video_size()``),
# 设备物理像素换算由 server 按比例代劳(max_size 降采样天然正确)。
# 工单表述校准:「绝对归一 ×65535」是 1.17-1.18 旧方言(u16 归一坐标、无
# 尺寸对);1.19 起即为本实现采用的「绝对像素 + 尺寸对」—— 以源码为准注记。
#
# 2.x/3.x 方言差异(按既有 framing_profile 同律处理,见 FrameParser):
#   - 触控/键码/BACK 消息:2.x 与 3.x 布局一致,无剖面分叉;
#   - 滚动消息:i16fp 解码后 2.x server 直接作 AXIS_*SCROLL 值([-1,1] = 1 tick),
#     3.x server 再乘 16([-16,16] 尺度)⇒ "4x" 剖面把 tick 值 ÷16 编码
#     (server/…/ControlMessageReader.java:2.7 无 ×16、master 有 ×16)。

MSG_TYPE_INJECT_KEYCODE = 0        # 工单表述「type=0 键码注入」
MSG_TYPE_INJECT_TOUCH_EVENT = 2
MSG_TYPE_INJECT_SCROLL_EVENT = 3
MSG_TYPE_BACK_OR_SCREEN_ON = 4     # 工单表述「type=4 INJECT_KEY_EVENT」

ACTION_DOWN = 0   # AMOTION_EVENT_ACTION_DOWN == AKEY_EVENT_ACTION_DOWN
ACTION_UP = 1     # AMOTION_EVENT_ACTION_UP   == AKEY_EVENT_ACTION_UP
ACTION_MOVE = 2   # AMOTION_EVENT_ACTION_MOVE

POINTER_ID_GENERIC_FINGER = -2  # SC_POINTER_ID_GENERIC_FINGER(server 注入
                                # TOOL_TYPE_FINGER/SOURCE_TOUCHSCREEN,对齐 input tap 语义)

_U64_MASK = (1 << 64) - 1


def float_to_u16fp(f: float) -> int:
    """[0,1] → u16 定点(scrcpy ``sc_float_to_u16fp`` 同律:向零截断 + 0xFFFF 钳位;
    0xFFFF 由 server 特判解码为精确 1.0)。"""
    if f <= 0.0:
        return 0
    if f >= 1.0:
        return 0xFFFF
    u = int(f * 65536.0)  # Python int() 向零截断,与 C 同律
    return 0xFFFF if u >= 0xFFFF else u


def float_to_i16fp(f: float) -> int:
    """[-1,1] → i16 定点(scrcpy ``sc_float_to_i16fp`` 同律:向零截断 + ±满幅钳位)。"""
    if f >= 1.0:
        return 0x7FFF
    if f <= -1.0:
        return -0x8000
    return int(f * 32768.0)


def encode_keycode(action: int, keycode: int, repeat: int = 0, metastate: int = 0) -> bytes:
    """INJECT_KEYEVENT(键码注入:down/up 各一条 = input keyevent 的设备侧等价物)。"""
    return struct.pack(">BBIII", MSG_TYPE_INJECT_KEYCODE, action, keycode, repeat, metastate)


def encode_touch(action: int, pointer_id: int, x: int, y: int,
                 screen_w: int, screen_h: int, pressure: float = 1.0,
                 action_button: int = 0, buttons: int = 0) -> bytes:
    """INJECT_TOUCH_EVENT(pointer_id 按有符号 u64 编码,-2 手指惯用语同律)。"""
    return struct.pack(
        ">BBQIIHHHII", MSG_TYPE_INJECT_TOUCH_EVENT, action,
        pointer_id & _U64_MASK, int(x), int(y), int(screen_w), int(screen_h),
        float_to_u16fp(pressure), int(action_button), int(buttons),
    )


def scroll_ticks_per_message(profile: str) -> int:
    """单条滚动消息可承载的 tick 上限(方言尺度:2x = 1,4x = 16)。"""
    return 16 if profile == "4x" else 1


def encode_scroll(x: int, y: int, screen_w: int, screen_h: int,
                  hticks: float = 0.0, vticks: float = 0.0,
                  buttons: int = 0, profile: str = "2x") -> bytes:
    """INJECT_SCROLL_EVENT(hticks/vticks = 滚轮 tick 数;剖面决定编码尺度)。"""
    scale = 16.0 if profile == "4x" else 1.0
    return struct.pack(
        ">BIIHHhhI", MSG_TYPE_INJECT_SCROLL_EVENT,
        int(x), int(y), int(screen_w), int(screen_h),
        float_to_i16fp(hticks / scale), float_to_i16fp(vticks / scale), int(buttons),
    )


def encode_back_or_screen_on(action: int) -> bytes:
    """BACK_OR_SCREEN_ON(2B;动作面未接线 —— 留作协议完备性,键码路径已覆盖 back)。"""
    return struct.pack(">BB", MSG_TYPE_BACK_OR_SCREEN_ON, action)


# ─── W6-6 解码器(可注入;pyav → cv2 → 诚实 unsupported)───


class H264DecoderLike(Protocol):
    """解码器契约:``feed(es_chunk) -> [PIL.Image, ...]``;``close()`` 释放。"""

    def feed(self, data: bytes) -> list[Image.Image]: ...
    def close(self) -> None: ...


DecoderFactory = Callable[[], H264DecoderLike]


class PyavDecoder:
    """pyav 解码器(一等路线:纯进程内流式,全平台)。

    ``CodecContext('h264','dec')`` 内部缓冲跨 chunk 的半包 —— 任意分片
    喂入皆可。CSD(config 包)照喂,出 0 帧是正常的。
    """

    name = "pyav"

    def __init__(self) -> None:
        import av  # 延迟导入:缺席时 factory 探测已挡,此处必在

        self._av = av
        self._ctx = av.codec.CodecContext.create("h264", "r")

    def feed(self, data: bytes) -> list[Image.Image]:
        import av.error

        pkt = self._av.Packet(data)
        frames: list[Image.Image] = []
        try:
            for frame in self._ctx.decode(pkt):
                frames.append(frame.to_image())  # pyav 自带 PIL 桥
        except av.error.InvalidDataError:
            pass  # 半包/噪声:CodecContext 内部缓冲,等后续字节
        return frames

    def close(self) -> None:
        try:
            self._ctx.close(True)
        except Exception:
            pass


class Cv2FifoDecoder:
    """cv2 降级解码器(POSIX-only,实验性 —— 真机清单建议优先装 pyav)。

    OpenCV 的 FFmpeg 后端无法从进程内管道读;POSIX 上用 mkfifo 桥接:
    ``feed`` 的 ES 字节写 fifo,``VideoCapture(fifo)`` 读。Windows 无
    对应语义 ⇒ resolve 阶段不激活(诚实 unsupported,不硬凑)。
    """

    name = "cv2"

    def __init__(self) -> None:
        import cv2

        self._cv2 = cv2
        self._dir = tempfile.mkdtemp(prefix="dsh-h264fifo-")
        self._path = os.path.join(self._dir, "stream.h264")
        os.mkfifo(self._path, 0o600)
        self._cap: "cv2.VideoCapture | None" = None
        self._wfh = None
        self._closed = False
        # fifo 双端 open 会互相等待 —— 各起一线程握手,主构造立即返回
        threading.Thread(target=self._open_cap, daemon=True).start()
        threading.Thread(target=self._open_writer, daemon=True).start()

    def _open_cap(self) -> None:
        try:
            self._cap = self._cv2.VideoCapture(self._path)
        except Exception:
            self._cap = None

    def _open_writer(self) -> None:
        try:
            self._wfh = open(self._path, "wb", buffering=0)
        except Exception:
            self._wfh = None

    def feed(self, data: bytes) -> list[Image.Image]:
        wfh, cap = self._wfh, self._cap
        if wfh is None or cap is None or not cap.isOpened():
            return []
        try:
            wfh.write(data)
        except OSError:
            return []
        ok, arr = cap.read()  # 每次 feed 至多取一帧(无帧时 FFmpeg 内部缓冲)
        if not ok:
            return []
        return [Image.fromarray(self._cv2.cvtColor(arr, self._cv2.COLOR_BGR2RGB))]

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for closer in (lambda: self._cap and self._cap.release(),
                       lambda: self._wfh and self._wfh.close()):
            try:
                closer()
            except Exception:
                pass
        shutil.rmtree(self._dir, ignore_errors=True)


def resolve_decoder_factory(pref: str) -> tuple[DecoderFactory | None, str]:
    """解码器降级链解析:pyav → cv2(POSIX)→ ``(None, 原因)``。

    探测即实构一次再丢弃(ImportError / codec 缺失当场现形,不带病上线)。
    返回 None = 诚实 unsupported —— 调用方禁用常驻流,降回单帧链。
    """
    if pref == "none":
        return None, "decoder=none (config)"
    reasons: list[str] = []
    order = ["pyav", "cv2"] if pref == "auto" else [pref]
    for name in order:
        if name == "pyav":
            try:
                probe = PyavDecoder()
                probe.close()
                return PyavDecoder, ""
            except Exception as e:  # ImportError 为主;codec 缺失同理
                reasons.append(f"pyav unavailable: {type(e).__name__}: {e}")
        elif name == "cv2":
            if os.name == "nt":
                reasons.append("cv2 unavailable: named-pipe capture unsupported on Windows")
                continue
            try:
                import cv2  # noqa: F401 —— 探测在场即可(fifo 打开惰性)

                return Cv2FifoDecoder, ""
            except Exception as e:
                reasons.append(f"cv2 unavailable: {type(e).__name__}: {e}")
        else:
            reasons.append(f"unknown decoder {name!r}")
    return None, "; ".join(reasons)


# ─── W6-6 字节源(socket / 进程 stdout / mock 统一抽象)───


class ByteSourceLike(Protocol):
    """读线程的字节源:``read(n)``(b"" = EOF)与 ``close()``(清理执法)。"""

    def read(self, n: int) -> bytes: ...
    def close(self) -> None: ...


StreamSpawnerLike = Callable[[str], ByteSourceLike]
"""serial → 字节源。真实现 = adb push/forward + server 进程 + socket;
mock = 内存字节队列(--selftest 的离线契约根基)。"""


class AdbTunnelByteSource:
    """真机字节源:adb forward 隧道 socket + 承载它的 ``adb shell`` 进程。

    ΝΩ-52 起携带可选控制 socket(同一 forward 端口的第二次 connect;
    ``take_control_socket()`` 一次性移交给 ControlWriter,close 执法仍在此
    侧兜底 —— 双重 close 无害)。

    close 纪律:先 kill ``adb shell``(server 进程死 ⇒ socket 必断,阻塞
    中的 recv 立刻现形)再 ``wait()``(不留僵尸),关 socket,最后尽力移除
    adb forward(失败不阻塞 —— 端口随 adb server 生命周期自愈)。
    """

    def __init__(self, sock: socket.socket, proc: subprocess.Popen, adb: str, port: int,
                 control_sock: "socket.socket | None" = None) -> None:
        self._sock = sock
        self._proc = proc
        self._adb = adb
        self._port = port
        self._closed = False
        self._control_sock = control_sock
        self._control_taken = False

    def take_control_socket(self) -> "socket.socket | None":
        """ΝΩ-52:控制 socket 一次性移交(spawner 未开控制 ⇒ None ⇒ 调用方降级 adb)。"""
        sock = self._control_sock if not self._control_taken else None
        self._control_taken = True
        return sock

    def read(self, n: int) -> bytes:
        try:
            return self._sock.recv(n)
        except (OSError, ConnectionResetError):
            return b""  # 对端关闭/复位 ⇒ EOF 语义,读线程自然退出

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._proc.poll() is None:
            try:
                self._proc.kill()  # Windows=TerminateProcess;POSIX=SIGKILL
            except OSError:
                pass
        try:
            self._proc.wait(timeout=5)  # 收尸:不留半死进程句柄
        except subprocess.TimeoutExpired:
            pass
        try:
            self._sock.close()
        except OSError:
            pass
        if self._control_sock is not None:  # ΝΩ-52:控制通道随流同葬(未移交/已移交都兜底)
            try:
                self._control_sock.close()
            except OSError:
                pass
        try:  # 尽力撤隧道;失败不阻塞(诚实记录由调用方 stats 承担)
            subprocess.run(
                [self._adb, "forward", "--remove", f"tcp:{self._port}"],
                capture_output=True, timeout=3,
            )
        except Exception:
            pass


def reroll_tunnel_port(
    fwd: Callable[[int, int], tuple[int, str]],
    base_port: int,
    max_retries: int = 3,
    rng: Callable[[], int] | None = None,
) -> tuple[int, int, int]:
    """ΝΩ-36:端口冲突自愈 —— adb forward 失败 ⇒ scid 重掷(至多 ``max_retries`` 次)。

    ``port = base + (scid % 512)`` 把 31bit scid 折进 512 端口窗,随机冲突
    (他进程占用/同机多流撞窗)曾直接判 spawn 失败 ⇒ 30s 冷却退避;现在冲突
    场景重掷即愈,重掷耗尽才如实失败(调用方落冷却)。

    ``fwd(scid, port) -> (rc, detail)`` 由调用方注入(真实现 = adb forward
    子进程;单测注入桩 —— 纯函数可离线测)。返回 ``(scid, port, attempts)``。
    """
    roll = rng if rng is not None else (lambda: random.getrandbits(31))
    retries = max(0, int(max_retries))
    attempts = 0
    detail = ""
    while True:
        attempts += 1
        scid = roll()
        port = base_port + (scid % 512)
        rc, detail = fwd(scid, port)
        if rc == 0:
            return scid, port, attempts
        if attempts > retries:
            raise RuntimeError(
                f"adb forward failed after {attempts} attempt(s) "
                f"(port window {base_port}..{base_port + 511} conflicts?): {detail}"
            )


class AdbScrcpyServerSpawner:
    """真机 spawner:三条 adb 命令 + server 进程 + 隧道 socket。

    server 参数表(实读 v2.7 develop.md;真机清单逐项校验):
      ``<version> scid=<31bit> log_level=error video_codec=h264 audio=false
      control=true send_device_meta=false tunnel_forward=true
      max_size=… max_fps=… video_bit_rate=…``
    version 必须与 jar 完全一致(scrcpy 无前后兼容承诺)—— 由控制器的
    ``scrcpy --version`` 探测结果传入。

    ΝΩ-52:``control=true`` 起,open() 在视频 socket 连上后**立即**对同一
    forward 端口做第二次 connect 作为控制通道 —— forward 模式下 server 的
    accept 顺序是 video→(audio)→control 且收齐才返回开流
    (``DesktopConnection.open``);控制连接缺席 ⇒ server 永远不开始编码 ⇒
    流必死。因此控制 connect 是开流的一部分,不是动作时才惰性补连。
    """

    _DEV_JAR = "/data/local/tmp/scrcpy-server.jar"

    def __init__(self, acfg: AndroidConfig, scfg: StreamConfig, version: str) -> None:
        self._acfg = acfg
        self._scfg = scfg
        self._version = version

    def _locate_jar(self) -> str:
        if self._scfg.server_jar != "auto":
            return self._scfg.server_jar
        candidates: list[Path] = []
        exe = shutil.which(self._acfg.scrcpy_path)
        if exe:
            d = Path(exe).parent
            candidates += [d / "scrcpy-server", d / "scrcpy-server.jar"]
        candidates += [
            Path("/usr/share/scrcpy/scrcpy-server"),
            Path("/usr/local/share/scrcpy/scrcpy-server"),
        ]
        for c in candidates:
            if c.is_file():
                return str(c)
        raise RuntimeError(
            "scrcpy-server jar not found (looked: "
            + ", ".join(str(c) for c in candidates)
            + "); set DSH_PHYSICAL_ANDROID_STREAM_SERVER_JAR"
        )

    def open(self, serial: str) -> ByteSourceLike:
        jar = self._locate_jar()
        push = subprocess.run(
            [self._acfg.adb_path, "-s", serial, "push", jar, self._DEV_JAR],
            capture_output=True, timeout=15,
        )
        if push.returncode != 0:
            raise RuntimeError(
                f"adb push scrcpy-server failed (rc={push.returncode}): "
                f"{(push.stderr or b'').decode('utf-8', 'replace')[:200]}"
            )
        scid = random.getrandbits(31)
        # ΝΩ-36:端口冲突 ⇒ scid 重掷(至多 port_conflict_retries 次)——
        # 随机冲突不再直接落 30s 冷却退避;真失败(adb 缺席/设备离线)语义不变。
        def _fwd(try_scid: int, try_port: int) -> tuple[int, str]:
            r = subprocess.run(
                [self._acfg.adb_path, "-s", serial, "forward",
                 f"tcp:{try_port}", f"localabstract:scrcpy_{try_scid}"],
                capture_output=True, timeout=10,
            )
            return r.returncode, (r.stderr or b"").decode("utf-8", "replace")[:200]

        scid, port, _attempts = reroll_tunnel_port(
            _fwd, self._scfg.tunnel_port, self._scfg.port_conflict_retries,
        )
        argv = [
            self._acfg.adb_path, "-s", serial, "shell",
            f"CLASSPATH={self._DEV_JAR}", "app_process", "/",
            "com.genymobile.scrcpy.Server", self._version,
            f"scid={scid}", "log_level=error", "video_codec=h264",
            "audio=false", "control=true", "send_device_meta=false",
            "tunnel_forward=true",
            f"max_size={self._scfg.max_size}", f"max_fps={self._scfg.max_fps}",
            f"video_bit_rate={self._scfg.video_bit_rate}",
        ]
        # server 生命周期由 socket 消费方持有;日志降噪防管道写堵塞
        proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 5.0
        last_err: Exception | None = None
        sock: socket.socket | None = None
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(
                    f"scrcpy-server exited rc={proc.returncode} before accepting "
                    "(version mismatch with jar? see true-device checklist)"
                )
            try:
                sock = socket.create_connection(("127.0.0.1", port), timeout=2.0)
                sock.settimeout(None)  # 常驻读:阻塞语义(EOF 由进程死保证)
                break
            except OSError as e:
                last_err = e
                time.sleep(0.25)
        if sock is None:
            self._reap(proc)
            raise RuntimeError(f"scrcpy video socket never accepted on tcp:{port}: {last_err}")
        # ΝΩ-52:控制通道 = 同一 forward 端口的第二次 connect(server 侧
        # accept 顺序 video→control,此刻正阻塞等此连接,连上即开流)。
        # 失败 ⇒ 如实判 spawn 失败(冷却退避,降级单帧链)—— 绝不带病
        # 返回「有视频无控制」的半残流(server 不收齐不开流,半残不存在)。
        csock: socket.socket | None = None
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                break
            try:
                csock = socket.create_connection(("127.0.0.1", port), timeout=2.0)
                break
            except OSError as e:
                last_err = e
                time.sleep(0.25)
        if csock is None:
            try:
                sock.close()
            except OSError:
                pass
            self._reap(proc)
            raise RuntimeError(
                f"scrcpy control socket never accepted on tcp:{port}: {last_err}"
            )
        return AdbTunnelByteSource(sock, proc, self._acfg.adb_path, port, control_sock=csock)

    @staticmethod
    def _reap(proc: subprocess.Popen) -> None:
        proc.kill()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass

    def __call__(self, serial: str) -> ByteSourceLike:
        """StreamSpawnerLike 签名适配(serial → 字节源)。"""
        return self.open(serial)


# ─── ΝΩ-52 控制通道写器(活跃流的控制 socket 专用)───


class ControlWriter:
    """控制 socket 的写通道:``send``/``send_sequence`` 全部**不抛**
    (运行层铁律),任何写异常 ⇒ 通道病亡 + 关闭 + 返回 ``False``,
    调用方(AndroidController)据此降级 adb —— 每次发送 35B 级字节,
    相比 ``adb shell input`` 的 50-200ms 子进程税即 tap <10ms 的来源。

    - ``send_sequence`` 持锁贯穿整串(down-move-up 手势不可被并发动作
      穿插);``inter_s`` 为相邻消息间隔(长按/拖拽的时长语义);
      中途失败 ⇒ 尽力补发 ``rescue``(孤儿 down 的现场清理,如 touch UP),
      补发成败不影响「如实报败 + 通道病亡」的判决。
    - 死通道不复活(流重启才有新通道)—— 调用方拿到 ``None``/``False``
      即走 adb,绝不在病通道上重试。
    """

    def __init__(self, sock: "socket.socket | None", profile: str = "2x",
                 send_timeout_s: float = 2.0) -> None:
        self.profile = profile
        self._sock = sock
        self._lock = threading.Lock()
        self._alive = sock is not None
        self.sent_count = 0
        self.last_error: str | None = None
        if sock is not None:
            try:
                sock.settimeout(send_timeout_s)  # 写延迟有界:server 病亡 ⇒ 超时现形
            except Exception as e:  # noqa: BLE001 —— 运行层不抛:设置失败即病亡
                self.last_error = f"settimeout failed: {type(e).__name__}: {e}"
                self._die()

    @property
    def alive(self) -> bool:
        return self._alive

    def _die(self) -> None:
        self._alive = False
        try:
            if self._sock is not None:
                self._sock.close()
        except Exception:  # noqa: BLE001 —— 收尾尽力,失败不放大
            pass

    def _write(self, msg: bytes) -> bool:
        """单条写入(调用方持锁)。失败只记因不死通道 —— 病亡时序由调用方
        安排(send_sequence 要先做 rescue 清场再关 socket)。"""
        try:
            self._sock.sendall(msg)
            self.sent_count += 1
            return True
        except Exception as e:  # noqa: BLE001 —— OSError 为主;mock/怪源全兜
            self.last_error = f"control send failed: {type(e).__name__}: {e}"
            return False

    def send(self, msg: bytes) -> bool:
        """发一条控制消息(原子;通道病亡 ⇒ False,不抛)。"""
        if not self._alive:
            return False
        with self._lock:
            if not self._alive:
                return False
            if self._write(msg):
                return True
            self._die()
            return False

    def send_sequence(self, msgs: list[bytes], inter_s: float = 0.0,
                      rescue: bytes | None = None) -> bool:
        """整串原子发送(锁贯穿 ⇒ 手势不可穿插)。首条即败 ⇒ 未注入任何
        字节,调用方可无痕降级;中途败 ⇒ 先在原 socket 上补发 rescue 清场
        (超时类瞬断可能救回;失败忽略)再病亡,如实报败。"""
        if not msgs:
            return True
        if not self._alive:
            return False
        with self._lock:
            if not self._alive:
                return False
            for i, msg in enumerate(msgs):
                if i > 0 and inter_s > 0:
                    time.sleep(inter_s)  # 时长语义(持锁 = 手势原子性优先)
                if not self._write(msg):
                    if i > 0 and rescue is not None:
                        try:  # 孤儿 down 清理:先于 _die(socket 尚开着,超时类
                            # 瞬断有机会送达);成败不改变「报败 + 病亡」判决
                            self._sock.sendall(rescue)
                            self.sent_count += 1
                        except Exception:  # noqa: BLE001
                            pass
                    self._die()
                    return False
            return True

    def close(self) -> None:
        """主动关闭(幂等;与 source.close 的兜底双重 close 无害)。"""
        with self._lock:
            self._die()


# ─── W6-6 单设备常驻流(读线程 + 环形缓冲 + 流内门控)───


class ScrcpyStream:
    """一台设备一条流:``start`` → 读线程消化字节 → 帧 入 ring(gate)→
    ``grab`` 取最新;``stop`` 全链清理。状态机 idle→starting→running→
    stopped(读线程 EOF / 异常 / watchdog idle 都落 stopped)。
    """

    def __init__(self, serial: str, cfg: StreamConfig, spawner: StreamSpawnerLike,
                 decoder_factory: DecoderFactory) -> None:
        self.serial = serial
        self.cfg = cfg
        self._spawner = spawner
        self._decoder_factory = decoder_factory
        self._state = "idle"
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._ring: deque[FrameRecord] = deque(maxlen=cfg.ring_capacity)
        self._seq = 0
        self._last_access = 0.0
        self._source: ByteSourceLike | None = None
        self._decoder: H264DecoderLike | None = None
        self._reader: threading.Thread | None = None
        self._parser = FrameParser(profile=cfg.framing_profile)
        self._control_writer: ControlWriter | None = None  # ΝΩ-52(惰建,随流同葬)
        self.last_error: str | None = None
        self.stats = {
            "spawn_count": 0, "frames_decoded": 0, "gate_dropped": 0,
            "ring_overrun": 0, "bytes_read": 0, "ring_len": 0,
        }

    @property
    def state(self) -> str:
        with self._lock:
            return self._state

    @property
    def last_access(self) -> float:
        with self._lock:
            return self._last_access

    def control_writer(self) -> ControlWriter | None:
        """ΝΩ-52:本流的控制写通道(仅 running 态;mock 源无控制 socket ⇒
        None;通道病亡 ⇒ 恒 None 直到流重启)。控制面使用计入活跃消费
        (idle 看门狗不误杀纯动作突发)。"""
        with self._lock:
            if self._state != "running":
                return None
            w = self._control_writer
            if w is not None:
                return w if w.alive else None
            taker = getattr(self._source, "take_control_socket", None)
            raw = taker() if callable(taker) else None
            if raw is None:
                return None
            self._control_writer = ControlWriter(
                raw, self.cfg.framing_profile,
                send_timeout_s=self.cfg.control_send_timeout_s,
            )
            self._last_access = time.monotonic()
            return self._control_writer

    def video_size(self) -> tuple[int, int] | None:
        """ΝΩ-52:控制消息 position 所需的视频坐标系(server 要求 screen_size
        与其视频尺寸全等,否则事件被静默丢弃)。最新解码帧尺寸优先(旋转
        自愈),兜底 codec meta(首帧未出但 meta 已解析)。"""
        with self._lock:
            if self._ring:
                last = self._ring[-1]
                return (last.width, last.height)
            meta = self._parser.meta
            if meta:
                return (meta["width"], meta["height"])
            return None

    def start(self) -> None:
        """spawn + 起读线程。失败抛异常(state 回 idle),调用方退避。"""
        with self._lock:
            if self._state != "idle":
                return
            self._state = "starting"
        try:
            source = self._spawner(self.serial)
            decoder = self._decoder_factory()
        except Exception as e:
            with self._lock:
                self._state = "idle"
            self.last_error = f"start failed: {e}"
            raise
        with self._lock:
            self._source = source
            self._decoder = decoder
            self._parser = FrameParser(profile=self.cfg.framing_profile)
            self._control_writer = None  # ΝΩ-52:新流新通道(旧 writer 已随旧流关闭)
            self._seq = 0
            self._ring.clear()
            self._last_access = time.monotonic()
            self.stats["spawn_count"] += 1
            self._state = "running"
            self._reader = threading.Thread(
                target=self._reader_loop, name=f"dsh-scrcpy-{self.serial}", daemon=True,
            )
            self._reader.start()

    def touch(self) -> None:
        with self._lock:
            self._last_access = time.monotonic()

    def grab(self, timeout_s: float) -> FrameRecord | None:
        """取最新帧(等首帧至多 ``timeout_s``);流死/超时 ⇒ None。"""
        with self._cond:
            deadline = time.monotonic() + timeout_s
            while not self._ring:
                if self._state != "running":
                    return None
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self._cond.wait(min(remaining, 0.05))
            rec = self._ring[-1]
            self._last_access = time.monotonic()
            return rec

    def _reader_loop(self) -> None:
        """字节 → 包 → 帧 → ring(gate)。EOF / parser.error / 异常 = 流死。"""
        source = self._source
        decoder = self._decoder
        try:
            while True:
                with self._lock:
                    if self._state != "running":
                        break
                chunk = source.read(65536)
                if not chunk:
                    self.last_error = self.last_error or "stream EOF (device detached or server exited)"
                    break
                self.stats["bytes_read"] += len(chunk)
                for pkt in self._parser.feed(chunk):
                    if self._parser.error:
                        self.last_error = self._parser.error
                        raise RuntimeError(self._parser.error)
                    for img in decoder.feed(pkt.payload):
                        self.stats["frames_decoded"] += 1
                        self._offer(img, pkt.pts_us)
        except Exception as e:  # noqa: BLE001 —— 读线程不抛出:死因记录后落幕
            self.last_error = self.last_error or f"reader died: {type(e).__name__}: {e}"
        finally:
            with self._cond:
                self._state = "stopped"
                self._cond.notify_all()

    def _offer(self, img: Image.Image, pts_us: int | None) -> None:
        """帧入 ring 前的流内门控:dhash 距离 ≤ gate_distance ⇒ 丢弃
        (seq 不推进 —— 帧未变不重复产出的可观测承诺)。"""
        dh = _stream_dhash(img)
        with self._cond:
            if self._ring and _hamming_hex(dh, self._ring[-1].dhash) <= self.cfg.gate_distance:
                self.stats["gate_dropped"] += 1
                return
            if len(self._ring) == self._ring.maxlen:
                self.stats["ring_overrun"] += 1  # 覆盖式:慢消费的代价是丢旧帧,不是涨内存
            self._seq += 1
            self._ring.append(
                FrameRecord(image=img, pts_us=pts_us, seq=self._seq, dhash=dh,
                            wall_s=time.time())
            )
            self.stats["ring_len"] = len(self._ring)
            self._cond.notify_all()

    def stop(self) -> None:
        """清理执法:kill+wait 子进程、关 socket、join 读线程、decoder.close。
        幂等(stop 竞态双调用安全)。"""
        with self._lock:
            if self._state in ("stopping", "stopped"):
                return
            self._state = "stopping"
        source, decoder, reader, cwriter = (
            self._source, self._decoder, self._reader, self._control_writer,
        )
        if source is not None:
            try:
                source.close()  # kill+wait 进程 ⇒ 阻塞中的 read 立刻 EOF
            except Exception:
                pass
        if cwriter is not None:  # ΝΩ-52:控制通道随流同葬(动作侧据此降级 adb)
            try:
                cwriter.close()
            except Exception:
                pass
        if reader is not None and reader.is_alive() and reader is not threading.current_thread():
            reader.join(timeout=3.0)
        if decoder is not None:
            try:
                decoder.close()
            except Exception:
                pass
        with self._cond:
            self._state = "stopped"
            self._cond.notify_all()


# ─── W6-6 流枢纽(多设备 + idle 看门狗 + 失败退避)───


class StreamHub:
    """serial → ScrcpyStream 的生命周期枢纽。

    - 惰性启动:首次 ``grab`` 才 spawn;启动失败 ⇒ ``start_cooldown_s``
      退避(不每次 grab 都付 spawn 税);流死/首帧超时 ⇒ 移除 + 退避。
    - idle 看门狗:单线程周期巡检,``now - last_access > idle_timeout_s``
      ⇒ ``stop()``(省电);下次 grab 自动重启。
    - ``close()``:全停 + join 看门狗(进程退出清理)。
    """

    def __init__(self, cfg: StreamConfig, spawner: StreamSpawnerLike,
                 decoder_factory: DecoderFactory, decoder_name: str = "custom") -> None:
        self.cfg = cfg
        self.decoder_name = decoder_name  # W6-6:note/审计里的解码器出处
        self._spawner = spawner
        self._decoder_factory = decoder_factory
        self._streams: dict[str, ScrcpyStream] = {}
        self._cooldown: dict[str, float] = {}  # serial → until(monotonic)
        self._lock = threading.Lock()
        self._watchdog_stop = threading.Event()
        self._watchdog: threading.Thread | None = None

    # -- 对外面:grab / stats / close --

    def grab(self, serial: str, timeout_s: float | None = None) -> FrameRecord | None:
        """取该设备最新帧;不可用/失败/超时 ⇒ None(调用方降级单帧链)。"""
        st = self._acquire(serial)
        if st is None:
            return None
        budget = self.cfg.first_frame_timeout_s if timeout_s is None else timeout_s
        rec = st.grab(budget)
        if rec is None:
            reason = st.last_error or f"no frame within {budget}s"
            self._retire(serial, st, f"grab failed: {reason}")
            return None
        return rec

    def stats(self) -> dict:
        with self._lock:
            out = {}
            for serial, st in self._streams.items():
                out[serial] = {
                    "state": st.state, "last_error": st.last_error,
                    "last_access_age_s": round(time.monotonic() - st.last_access, 3),
                    **st.stats,
                }
            return out

    def control_writer(self, serial: str) -> "ControlWriter | None":
        """ΝΩ-52:活跃流的控制写通道 —— **绝不 spawn**(动作路径不付启动税,
        也不触发探测);无流/流死/无控制 socket ⇒ None(调用方降级 adb)。"""
        with self._lock:
            st = self._streams.get(serial)
        if st is None or st.state != "running":
            return None
        return st.control_writer()

    def video_size(self, serial: str) -> tuple[int, int] | None:
        """ΝΩ-52:该设备流视频尺寸(控制消息的坐标系锚点;无流 ⇒ None)。"""
        with self._lock:
            st = self._streams.get(serial)
        return st.video_size() if st is not None else None

    def close(self) -> None:
        """进程退出清理:停所有流 + join 看门狗。幂等。"""
        self._watchdog_stop.set()
        wd = self._watchdog
        if wd is not None and wd.is_alive():
            wd.join(timeout=3.0)
        with self._lock:
            streams = list(self._streams.values())
            self._streams.clear()
        for st in streams:
            st.stop()  # 锁外停:stop 可能阻塞(kill+wait)

    # -- 内部 --

    def _acquire(self, serial: str) -> ScrcpyStream | None:
        now = time.monotonic()
        with self._lock:
            until = self._cooldown.get(serial, 0.0)
            if now < until:
                return None
            st = self._streams.get(serial)
            if st is not None and st.state == "stopped":
                self._streams.pop(serial, None)
                st = None
            if st is not None:
                return st
        # 锁外 start(spawn 可能数百 ms;持锁会饿死其它设备)
        st = ScrcpyStream(serial, self.cfg, self._spawner, self._decoder_factory)
        try:
            st.start()
        except Exception:
            self._cooldown[serial] = time.monotonic() + self.cfg.start_cooldown_s
            return None
        with self._lock:
            existing = self._streams.get(serial)  # 并发双检:后到者让位
            if existing is not None:
                st.stop()
                return existing
            self._streams[serial] = st
            self._ensure_watchdog_locked()
        return st

    def _retire(self, serial: str, st: ScrcpyStream, reason: str) -> None:
        st.stop()
        with self._lock:
            if self._streams.get(serial) is st:
                self._streams.pop(serial, None)
            self._cooldown[serial] = time.monotonic() + self.cfg.start_cooldown_s
            _ = reason  # 死因已在 st.last_error;这里只管退避

    def _ensure_watchdog_locked(self) -> None:
        if self._watchdog is None or not self._watchdog.is_alive():
            self._watchdog_stop.clear()
            self._watchdog = threading.Thread(
                target=self._watchdog_loop, name="dsh-scrcpy-watchdog", daemon=True,
            )
            self._watchdog.start()

    def _watchdog_loop(self) -> None:
        while not self._watchdog_stop.wait(self.cfg.watchdog_tick_s):
            with self._lock:
                items = [(s, st) for s, st in self._streams.items()]
            now = time.monotonic()
            for serial, st in items:
                if st.state == "running" and now - st.last_access > self.cfg.idle_timeout_s:
                    st.stop()  # idle 停流(省电);下次 grab 惰性重启
                elif st.state == "stopped":
                    with self._lock:
                        if self._streams.get(serial) is st:
                            self._streams.pop(serial, None)


# ═══ W8-B8 自测入口:python -m dsh_physical.scrcpyStream --selftest ═══
# （或直接 python scrcpyStream.py --selftest —— 顶部 import 已兼容双模式）
#
# 离线契约(零真设备/零真 adb/零真 scrcpy):W6R-A3 已在 android selftest 覆盖
# FrameParser/StreamHub 的集成面;本入口补**模块自身**的基础纯函数断言 ——
# 假 spawner + 假解码器 + 合成 v2.x framed 字节流(读线程与解析器走真实
# 字节路径,只把「H264→PIL」这一环换成假解码器)。场景:
#   S0 流配置 env(缺省 off + 钳位 + 非法值诚实报错)
#   S1 帧头解析(dummy byte + codec meta)   S2 任意分片重组 + 半包缓冲
#   S3 4x 位序(scrcpy≥3.0)                S4 非 h264/非法尺寸 ⇒ 诚实报错 + 错误锁存
#   S5 协议剖面变体(免 dummy/免 meta)      S6 流内 dhash 纯函数(确定性/距离/畸形)
#   S7 解码器解析链纯函数(none/bogus)
#   S8 hub 惰性启动 → 首帧(PTS/序号/分辨率保留)
#   S9 hub 最新帧胜出                      S10 门控:帧未变不重复产出
#   S11 背压:慢消费 ⇒ 环形缓冲有界         S12 idle 超时停流 + 惰性重启
#   S13 多设备隔离                         S14 清理执法(源/解码器全关,幂等)
#   S15 spawn 失败 ⇒ None + 冷却退避       S16 无帧流 ⇒ retire + 冷却

def _run_selftest() -> int:
    import itertools
    import queue as _queue

    failures: list[str] = []
    passed = 0

    def check(name: str, cond: bool) -> None:
        nonlocal passed
        if cond:
            passed += 1
        else:
            failures.append(name)
            print(f"  FAIL: {name}")

    def wait_until(fn, deadline_s: float = 2.0) -> bool:
        t0 = time.monotonic()
        while time.monotonic() - t0 < deadline_s:
            if fn():
                return True
            time.sleep(0.02)
        return fn()

    # ── 夹具工坊(与 android selftest 同构,但本模块自治) ──

    def grad(w: int, h: int, phase: int) -> Image.Image:
        """确定性合成帧:4px 宏块伪随机图(phase 平移 ⇒ 相邻帧 dhash 必可区分)。"""
        img = Image.new("L", (w, h))
        img.putdata([
            ((x // 4 * 31 + y // 4 * 17 + phase * 29) % 256)
            for y in range(h) for x in range(w)
        ])
        return img.convert("RGB")

    class FakeByteSource:
        """假字节源:内存队列;read 无数据时阻塞(真 socket 语义),
        close 后 read 恒返 b''(EOF)。close 计数由 spawner 执法。"""

        def __init__(self, spawner_ref: "FakeSpawner") -> None:
            self._q: "_queue.Queue" = _queue.Queue()
            self.closed = threading.Event()
            self._spawner_ref = spawner_ref

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

        def close(self) -> None:
            if self.closed.is_set():
                return
            self.closed.set()
            self._spawner_ref.closes += 1

    class FakeSpawner:
        """假 spawner:opens/closes 计数执法 + 合成 v2x 流(每次 open 自动
        首帧,seed 递增 ⇒ 重启/异设备帧内容必然不同)。starve=True 开流但
        永不推帧(逼首帧超时)。"""

        def __init__(self, fail: bool = False, starve: bool = False) -> None:
            self.fail = fail
            self.starve = starve
            self.opens = 0
            self.closes = 0
            self.sources: list[FakeByteSource] = []
            self._seeds = itertools.count(1000)

        def open(self, serial: str) -> FakeByteSource:
            self.opens += 1
            if self.fail:
                raise RuntimeError("stub spawn failure")
            src = FakeByteSource(self)
            self.sources.append(src)
            if not self.starve:
                self._emit(src, [next(self._seeds)], header=True)
            return src

        __call__ = open

        def _emit(self, src: FakeByteSource, seeds: list[int], header: bool) -> None:
            # 合成 v2x framed 流:header=True 时含 dummy byte + codec meta
            # (仅流首);纯帧块用于后续 push(parser 已进入包循环态)。
            buf = (b"\x00" + b"h264" + struct.pack(">II", 32, 48)) if header else b""
            for s in seeds:
                payload = struct.pack(">IIQ", 32, 48, s)
                u64 = (1 << 62) | s  # keyframe=1, config=0, PTS=seed
                buf += struct.pack(">QI", u64, len(payload)) + payload
            src.push(buf)

        def push_seeds(self, seeds: list[int]) -> None:
            self._emit(self.sources[-1], seeds, header=False)

        @property
        def all_closed(self) -> bool:
            return bool(self.sources) and all(s.closed.is_set() for s in self.sources)

    def mk_fake_decoder(counts: dict):
        """假解码器:载荷 = struct('>IIQ', w, h, seed) → 合成帧。"""
        class FakeDecoder:
            name = "fake"

            def __init__(self) -> None:
                counts["made"] += 1
                self._closed = False

            def feed(self, data: bytes) -> list[Image.Image]:
                if self._closed:
                    return []
                w, h, seed = struct.unpack(">IIQ", data)
                return [grad(w, h, seed)]

            def close(self) -> None:
                if not self._closed:
                    self._closed = True
                    counts["closed"] += 1
        return FakeDecoder

    # ── S0 流配置 env:缺省 off + 钳位 + 非法值诚实报错 ──
    pfx = "DSH_PHYSICAL_ANDROID_STREAM"
    env_keys = [f"{pfx}_ENABLED", f"{pfx}_RING", f"{pfx}_MAX_SIZE",
                f"{pfx}_GATE_DIST", f"{pfx}_DECODER", f"{pfx}_PROFILE"]
    saved_env = {k: os.environ.get(k) for k in env_keys}
    try:
        for k in env_keys:
            os.environ.pop(k, None)
        check("S0 stream off by default", stream_config_from_env().enabled is False)
        os.environ[f"{pfx}_ENABLED"] = "true"
        check("S0 env enables stream", stream_config_from_env().enabled is True)
        os.environ[f"{pfx}_RING"] = "5"
        os.environ[f"{pfx}_MAX_SIZE"] = "10"   # 低于下限 ⇒ 钳位到 64
        os.environ[f"{pfx}_GATE_DIST"] = "0"
        cfg0 = stream_config_from_env()
        check("S0 env mapped", cfg0.ring_capacity == 5 and cfg0.max_size == 64
              and cfg0.gate_distance == 0)
        os.environ[f"{pfx}_DECODER"] = "h265"
        try:
            stream_config_from_env()
            check("S0 invalid decoder rejected", False)
        except ValueError:
            check("S0 invalid decoder rejected", True)
        os.environ[f"{pfx}_DECODER"] = "pyav"
        os.environ[f"{pfx}_PROFILE"] = "3x"
        try:
            stream_config_from_env()
            check("S0 invalid profile rejected", False)
        except ValueError:
            check("S0 invalid profile rejected", True)
        os.environ[f"{pfx}_PROFILE"] = "4x"
        check("S0 4x profile accepted", stream_config_from_env().framing_profile == "4x")
    finally:
        for k, v in saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    # ── S1 帧头解析:dummy byte + codec meta + 包位序(2x) ──
    parser = FrameParser("2x")
    pkt1 = struct.pack(">QI", (1 << 62) | 100, 4) + b"\x11\x22\x33\x44"  # keyframe, pts=100
    pkt2 = struct.pack(">QI", (1 << 63) | 200, 1) + b"\x55"              # config ⇒ pts 无意义
    stream1 = b"\x00" + b"h264" + struct.pack(">II", 32, 48) + pkt1 + pkt2
    pkts = parser.feed(stream1)
    check("S1 codec meta parsed",
          parser.meta == {"codec": "h264", "width": 32, "height": 48})
    check("S1 two packets", len(pkts) == 2)
    check("S1 pts/flags/payload",
          pkts[0].pts_us == 100 and pkts[0].keyframe and not pkts[0].config
          and pkts[0].payload == b"\x11\x22\x33\x44"
          and pkts[1].config and pkts[1].pts_us is None)

    # ── S2 任意分片重组 + 半包缓冲 ──
    parser2 = FrameParser("2x")
    pkts2 = [p for i in range(0, len(stream1), 3) for p in parser2.feed(stream1[i:i + 3])]
    check("S2 packets from 3-byte chunks",
          len(pkts2) == 2 and pkts2[0].payload == b"\x11\x22\x33\x44"
          and pkts2[1].payload == b"\x55")
    parser2b = FrameParser("2x")
    head, body = pkt1[:12 + 2], pkt1[12 + 2:]  # 12B 头 + 半截载荷
    half = parser2b.feed(b"\x00" + b"h264" + struct.pack(">II", 8, 8) + head)
    check("S2 half-packet held back", half == [])
    done = parser2b.feed(body)
    check("S2 half-packet completed on next feed",
          len(done) == 1 and done[0].payload == b"\x11\x22\x33\x44")

    # ── S3 4x 位序:media(u1)+config(u1)+keyframe(u1)+PTS(u61) ──
    p4 = FrameParser("4x")
    u64_4x = (1 << 63) | (1 << 61) | 777  # media + keyframe + PTS(u61)
    pk4 = p4.feed(b"\x00" + b"h264" + struct.pack(">II", 8, 8)
                  + struct.pack(">QI", u64_4x, 2) + b"zz")
    check("S3 4x bit layout",
          pk4 and pk4[0].keyframe and not pk4[0].config and pk4[0].pts_us == 777)
    p4c = FrameParser("4x")
    pk4c = p4c.feed(b"\x00" + b"h264" + struct.pack(">II", 8, 8)
                    + struct.pack(">QI", (1 << 63) | (1 << 62) | 5, 1) + b"c")
    check("S3 4x config flag and pts=None",
          pk4c and pk4c[0].config and pk4c[0].pts_us is None)

    # ── S4 非 h264/非法尺寸 ⇒ 诚实报错 + 错误锁存 ──
    p3 = FrameParser("2x")
    p3.feed(b"\x00" + b"h265" + struct.pack(">II", 4, 4))
    check("S4 rejects non-h264 codec",
          p3.error is not None and "unsupported video codec" in p3.error)
    p3b = FrameParser("2x")
    p3b.feed(b"\x00" + b"h264" + struct.pack(">II", 0, 48))
    check("S4 rejects zero dimensions",
          p3b.error is not None and "invalid codec meta dimensions" in p3b.error)
    check("S4 error latched (feed after death returns [])",
          p3.feed(b"\x00" * 32) == [] and p3.error is not None)

    # ── S5 协议剖面变体:免 codec meta(expect_codec_meta 已接线)──
    # 注:expect_dummy_byte 形参当前是悬空位(feed 状态机恒吞 1 字节 dummy,
    # 从不读该旗标)—— 免 dummy 剖面无实现可测,悬空点记入模块遗留清单。
    p5 = FrameParser("2x", expect_codec_meta=False)
    pk5 = p5.feed(b"\x00" + struct.pack(">QI", (1 << 62) | 9, 1) + b"q")
    check("S5 no-meta profile parses packets directly",
          pk5 and pk5[0].pts_us == 9 and p5.meta is None and p5.error is None)

    # ── S6 流内 dhash 纯函数:确定性 / 距离 / 畸形指纹 ──
    g0, g1 = grad(32, 48, 0), grad(32, 48, 1)
    h0, h1 = _stream_dhash(g0), _stream_dhash(g1)
    check("S6 dhash deterministic", _stream_dhash(g0) == h0 and _stream_dhash(grad(32, 48, 0)) == h0)
    check("S6 distinct frames differ", _hamming_hex(h0, h1) > 0)
    check("S6 flat image hashes to zero",
          _stream_dhash(Image.new("RGB", (32, 48), "white")) == "0" * 16)
    check("S6 self distance is zero", _hamming_hex(h0, h0) == 0)
    check("S6 malformed fingerprint -> max distance",
          _hamming_hex("zzzzzzzzzzzzzzzz", h0) == 64)

    # ── S7 解码器解析链纯函数:none / 未知名诚实报错 ──
    fac_none, why_none = resolve_decoder_factory("none")
    check("S7 decoder=none is honest unsupported",
          fac_none is None and "decoder=none" in why_none)
    fac_bad, why_bad = resolve_decoder_factory("bogus")
    check("S7 unknown decoder named in reason",
          fac_bad is None and "unknown decoder" in why_bad)

    # ── S8-S14 hub 全流程(mock spawner + mock decoder)──
    # idle_timeout 取 1.5s:大于 S8-S11 的交互间隔(流不被误停),
    # 又小于 S12 的观察预算(idle 停流可断言)。
    scfg = StreamConfig(enabled=True, idle_timeout_s=1.5, watchdog_tick_s=0.05,
                        first_frame_timeout_s=2.0, ring_capacity=3, gate_distance=0,
                        start_cooldown_s=30.0)
    fake = FakeSpawner()
    dec_counts: dict = {"made": 0, "closed": 0}
    hub = StreamHub(scfg, fake, mk_fake_decoder(dec_counts), decoder_name="fake")

    rec = hub.grab("emu1")  # 惰性启动 + 自动首帧(seed=1000)
    check("S8 lazy start yields frame",
          rec is not None and (rec.width, rec.height) == (32, 48))
    check("S8 pts/seq preserved", rec.pts_us == 1000 and rec.seq == 1)
    check("S8 stats report stream",
          hub.stats().get("emu1", {}).get("spawn_count") == 1 and fake.opens == 1)

    fake.push_seeds([11, 12, 13])
    check("S9 decodes pushed frames",
          wait_until(lambda: hub.stats().get("emu1", {}).get("frames_decoded") == 4))
    rec = hub.grab("emu1")
    check("S9 latest frame wins", rec.seq == 4 and rec.pts_us == 13)

    fake.push_seeds([42] * 6)  # 6 帧同内容:第 1 帧入槽,后 5 帧被门控丢弃
    check("S10 gate consumes identical frames",
          wait_until(lambda: hub.stats().get("emu1", {}).get("frames_decoded") == 10))
    st10 = hub.stats()["emu1"]
    rec = hub.grab("emu1")
    check("S10 gate drops unchanged (seq frozen)",
          st10["gate_dropped"] == 5 and rec.seq == 5 and rec.pts_us == 42)

    fake.push_seeds([200 + i for i in range(50)])  # 慢消费:50 帧不被取走
    check("S11 decodes all 50",
          wait_until(lambda: hub.stats().get("emu1", {}).get("frames_decoded") == 60))
    st11 = hub.stats()["emu1"]
    rec = hub.grab("emu1")
    check("S11 ring bounded (backpressure safe)",
          st11["ring_len"] == 3 and st11["ring_overrun"] == 52 and rec.seq == 55
          and rec.pts_us == 249)

    check("S12 idle timeout stops stream",
          wait_until(lambda: "emu1" not in hub.stats(), deadline_s=5.0))
    check("S12 idle stop closed source", fake.opens == 1 and fake.closes == 1)
    rec = hub.grab("emu1", timeout_s=3.0)  # 惰性重启(新 seed=1001)
    check("S12 lazy restart on next grab",
          rec is not None and fake.opens == 2 and rec.seq == 1 and rec.pts_us == 1001)

    rec1 = hub.grab("emu1")
    rec2 = hub.grab("emu2", timeout_s=3.0)  # 第二台设备(seed=1002)
    check("S13 second device gets its own stream",
          fake.opens == 3 and set(hub.stats()) == {"emu1", "emu2"})
    check("S13 frames never cross devices",
          rec2 is not None and rec2.pts_us == 1002 and rec1.pts_us == 1001
          and rec2.seq == 1)

    hub.close()
    hub.close()  # 幂等:二次 close 不炸
    check("S14 all sources closed (no leaked handles)",
          fake.all_closed and fake.opens == fake.closes == 3)
    check("S14 watchdog joined",
          hub._watchdog is None or not hub._watchdog.is_alive())
    check("S14 decoders closed", dec_counts["made"] == dec_counts["closed"] >= 3)

    # ── S15 spawn 失败 ⇒ None + 冷却退避(不每次 grab 都付 spawn 税) ──
    fake15 = FakeSpawner(fail=True)
    hub15 = StreamHub(StreamConfig(enabled=True, first_frame_timeout_s=0.5,
                                   start_cooldown_s=5.0, watchdog_tick_s=0.05),
                      fake15, mk_fake_decoder({"made": 0, "closed": 0}), decoder_name="fake")
    check("S15 spawn failure returns None", hub15.grab("dead1") is None)
    check("S15 cooldown prevents immediate respin",
          hub15.grab("dead1") is None and fake15.opens == 1)
    check("S15 no stream registered", hub15.stats() == {})
    hub15.close()

    # ── S16 无帧流 ⇒ retire + 冷却(grab 超时降级为 None) ──
    fake16 = FakeSpawner(starve=True)  # 开流但永不推帧
    hub16 = StreamHub(StreamConfig(enabled=True, first_frame_timeout_s=0.3,
                                   start_cooldown_s=5.0, watchdog_tick_s=0.05),
                      fake16, mk_fake_decoder({"made": 0, "closed": 0}), decoder_name="fake")
    check("S16 starved stream times out", hub16.grab("slow", timeout_s=0.3) is None)
    check("S16 retired from registry", "slow" not in hub16.stats())
    check("S16 source closed on retire", fake16.closes == 1 and fake16.all_closed)
    check("S16 cooldown blocks respawn",
          hub16.grab("slow", timeout_s=0.3) is None and fake16.opens == 1)
    hub16.close()

    # ── S17 ΝΩ-36 端口冲突 ⇒ scid 重掷(纯函数,确定性 rng) ──
    occupied = {27183 + 100}  # 第一个掷出的端口被占(见下方确定性 scid 序)
    dice = iter([100, 101, 102, 103, 104])

    def fwd_stub(scid: int, port: int) -> tuple[int, str]:
        if port in occupied:
            return 1, f"error: cannot bind to '127.0.0.1:{port}'"
        return 0, ""

    scid, port, attempts = reroll_tunnel_port(
        fwd_stub, 27183, max_retries=3, rng=lambda: next(dice))
    check("S17 conflict rerolled to free port",
          scid == 101 and port == 27183 + 101 and attempts == 2)

    dice2 = iter([200, 201, 202, 203, 204])
    occupied2 = {27183 + i for i in (200, 201, 202, 203)}
    try:
        reroll_tunnel_port(lambda s, p: (1, "busy") if p in occupied2 else (0, ""),
                           27183, max_retries=3, rng=lambda: next(dice2))
        check("S17 exhausted retries raise honest error", False)
    except RuntimeError as e17:
        check("S17 exhausted retries raise honest error",
              "after 4 attempt" in str(e17) and "busy" in str(e17))

    scid0, port0, att0 = reroll_tunnel_port(
        lambda s, p: (0, ""), 27183, max_retries=0, rng=lambda: 7)
    check("S17 first try free passes at retries=0",
          scid0 == 7 and port0 == 27183 + 7 and att0 == 1)
    check("S17 config default retries = 3",
          StreamConfig().port_conflict_retries == 3)

    # ── S18 ΝΩ-52 控制消息编码器字节级手算(scrpy 官方单测向量对齐) ──
    check("S18 keycode vector",
          encode_keycode(ACTION_UP, 66, 5, 65).hex()
          == "0001" + "00000042" + "00000005" + "00000041"
          and len(encode_keycode(ACTION_UP, 66, 5, 65)) == 14)
    tvec = encode_touch(ACTION_DOWN, 0x1234567887654321, 100, 200, 1080, 1920,
                        pressure=1.0, action_button=1, buttons=1)
    check("S18 touch vector (scrcpy test_control_msg_serialize.c)",
          tvec.hex() == "0200" + "1234567887654321" + "00000064" + "000000c8"
          + "0438" + "0780" + "ffff" + "00000001" + "00000001" and len(tvec) == 32)
    tfing = encode_touch(ACTION_DOWN, POINTER_ID_GENERIC_FINGER, 0, 0, 32, 48)
    check("S18 generic finger pointer = -2 u64-wrapped",
          tfing[2:10].hex() == "fffffffffffffffe" and tfing[22:24].hex() == "ffff")
    tup = encode_touch(ACTION_UP, POINTER_ID_GENERIC_FINGER, 0, 0, 32, 48, pressure=0.0)
    check("S18 up carries zero pressure", tup[1] == ACTION_UP and tup[22:24].hex() == "0000")
    svec = encode_scroll(260, 1026, 1080, 1920, hticks=1.0, vticks=-1.0, buttons=1)
    check("S18 scroll 2x vector",
          svec.hex() == "03" + "00000104" + "00000402" + "0438" + "0780"
          + "7fff" + "8000" + "00000001" and len(svec) == 21)
    s4 = encode_scroll(16, 24, 32, 48, vticks=1.0, profile="4x")
    check("S18 scroll 4x dialect (tick/16 → 0x0800)",
          s4[13:15].hex() == "0000" and s4[15:17].hex() == "0800"
          and scroll_ticks_per_message("2x") == 1 and scroll_ticks_per_message("4x") == 16)
    check("S18 back-or-screen-on 2B",
          encode_back_or_screen_on(ACTION_DOWN).hex() == "0400")
    check("S18 fixed point laws",
          float_to_u16fp(1.0) == 0xFFFF and float_to_u16fp(0.5) == 0x8000
          and float_to_i16fp(-1.0) == -0x8000 and float_to_i16fp(1 / 16) == 0x0800)
    check("S18 encoders deterministic",
          encode_touch(ACTION_MOVE, -2, 1, 2, 32, 48) == encode_touch(ACTION_MOVE, -2, 1, 2, 32, 48))

    # ── S19 ΝΩ-52 ControlWriter 生命周期(假 socket;写失败 ⇒ 病亡降级) ──
    class SelfFakeSock:
        def __init__(self, fail_at=()):
            self.sent = []
            self.timeouts = []
            self.closed = 0
            self._closed = False
            self.fail_at = set(fail_at)
            self._n = 0

        def settimeout(self, t):
            self.timeouts.append(t)

        def sendall(self, b):
            if self._n in self.fail_at:
                self._n += 1
                raise OSError(f"stub failure #{self._n - 1}")
            self._n += 1
            self.sent.append(bytes(b))

        def close(self):
            if not self._closed:
                self._closed = True
                self.closed += 1

    sok = SelfFakeSock()
    wok = ControlWriter(sok, "2x", send_timeout_s=0.5)
    check("S19 writer sets send timeout", sok.timeouts == [0.5])
    check("S19 send ok", wok.send(b"\x02") and sok.sent == [b"\x02"] and wok.alive)
    sdead = SelfFakeSock(fail_at={0})
    wdead = ControlWriter(sdead)
    check("S19 send failure returns False (no raise)",
          wdead.send(b"\x02") is False and not wdead.alive and sdead.closed == 1)
    check("S19 dead writer stays dead", wdead.send(b"\x02") is False and sdead.sent == [])
    check("S19 empty sequence true", ControlWriter(SelfFakeSock()).send_sequence([]))
    smid = SelfFakeSock(fail_at={1})
    wmid = ControlWriter(smid)
    check("S19 mid-sequence failure rescues orphan then dies",
          wmid.send_sequence([b"down", b"move", b"up"], rescue=b"UP") is False
          and smid.sent == [b"down", b"UP"] and not wmid.alive)
    sfirst = SelfFakeSock(fail_at={0})
    check("S19 first-message failure injects nothing",
          ControlWriter(sfirst).send_sequence([b"down", b"up"], rescue=b"UP") is False
          and sfirst.sent == [])
    check("S19 born-dead writer (None socket)",
          ControlWriter(None).alive is False and ControlWriter(None).send(b"\x00") is False)
    sclose = SelfFakeSock()
    wclose = ControlWriter(sclose)
    wclose.close()
    wclose.close()
    check("S19 close idempotent", sclose.closed == 1 and not wclose.alive)

    # ── S20 ΝΩ-52 hub 控制面:绝不 spawn + video_size + 随流同葬 ──
    class ControlFakeSource(FakeByteSource):
        """FakeByteSource + 可移交控制 socket(假 socket,非真 fd)。"""

        def __init__(self, spawner_ref):
            super().__init__(spawner_ref)
            self.control_sock: SelfFakeSock | None = None
            self._control_taken = False

        def take_control_socket(self):
            sock = self.control_sock if not self._control_taken else None
            self._control_taken = True
            return sock

    class ControlFakeSpawner(FakeSpawner):
        """FakeSpawner + 每源一枚假控制 socket(ΝΩ-52 注入口)。"""

        def open(self, serial):
            self.opens += 1
            src = ControlFakeSource(self)
            src.control_sock = SelfFakeSock()
            self.sources.append(src)
            self._emit(src, [next(self._seeds)], header=True)
            return src

        __call__ = open  # 基类的 __call__ 绑定基类 open,子类须重绑

    fake20 = FakeSpawner()
    hub20 = StreamHub(StreamConfig(enabled=True, first_frame_timeout_s=2.0),
                      fake20, mk_fake_decoder({"made": 0, "closed": 0}), decoder_name="fake")
    check("S20 control never spawns", hub20.control_writer("emu1") is None and fake20.opens == 0)
    check("S20 video_size absent without stream", hub20.video_size("emu1") is None)
    hub20.grab("emu1")
    check("S20 video_size anchors to frame", hub20.video_size("emu1") == (32, 48))
    check("S20 legacy source (no control face) degrades to None",
          hub20.control_writer("emu1") is None)
    hub20.close()

    fake20b = ControlFakeSpawner()
    hub20b = StreamHub(StreamConfig(enabled=True, first_frame_timeout_s=2.0),
                       fake20b, mk_fake_decoder({"made": 0, "closed": 0}), decoder_name="fake")
    hub20b.grab("emu1")
    src20 = fake20b.sources[-1]
    w20 = hub20b.control_writer("emu1")
    check("S20 writer handed over once",
          w20 is not None and w20.profile == "2x"
          and hub20b.control_writer("emu1") is w20)
    check("S20 writer send ok", w20.send(encode_keycode(ACTION_DOWN, 4)) is True)
    hub20b.close()
    check("S20 writer dies with stream",
          w20.alive is False and src20.control_sock.closed >= 1
          and hub20b.control_writer("emu1") is None)

    print(f"\nscrcpyStream selftest: {'OK' if not failures else 'FAILED'} "
          f"({passed} passed, {len(failures)} failed)")
    return 0 if not failures else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(_run_selftest())
    print("usage: python -m dsh_physical.scrcpyStream --selftest "
          "(or: python scrcpyStream.py --selftest)")
