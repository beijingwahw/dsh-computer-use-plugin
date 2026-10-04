"""W4-5 L1 移动 Surface —— scrcpy/ADB 安卓设备入列虚拟显示器。

世界级标准（创新提案 L1）：
  - 坐标归一化契约不破：本模块对外的一切坐标（tap/swipe/drag/region）都是
    [0,1]×[0,1] 归一化，基准矩形 = **设备屏幕**（与 host 侧「归一化基准 =
    所选显示器矩形」的 Σ-5 语义同构）。像素换算只发生在注入前最后一刻。
  - 真机缺席诚实降级：adb/scrcpy 缺席 ⇒ ``/v1/devices`` 空清单 + degraded
    标记 + 真实原因；动作端点对未知 serial / 缺席依赖如实报
    ``screen_capture_failed`` / ``invalid_args`` 失败信封，绝不假装成功。
  - 离线契约可测：所有外部调用（adb / scrcpy 子进程）经可注入 ``runner``
    （缺省 ``default_runner`` = subprocess.run；测试注入桩，不发任何真进程）。

帧源降级链（带宽优先 scrcpy）：
  1. scrcpy ≥ ``scrcpy_min_version``（v2.0 起有 ``--screenshot``：经设备端
     硬编码器拉一帧 —— 单帧带宽远低于全屏 PNG，且 ``--max-size`` 先行降采样）；
  2. scrcpy 缺席/超龄/失败 ⇒ ``adb exec-out screencap -p`` 单帧
     （exec-out 二进制安全 —— 旧 ``adb shell screencap`` 的 CRLF 污染不适用）。

带宽门控不在此层重复造轮：android 帧与 host 帧走同一条
``ScreenCapture.capture`` 管线 ⇒ 既有 dhash 变化门控（帧未变不重复编码
投递）天然复用（见 screen.py 的 gate 参数）。

W6-6 常驻视频流 PoC（scrcpyStream.py 携带实现）：
  - ``grab_frame`` 顶部先试常驻流（``StreamHub``）：取环形缓冲最新帧，
    缺席/失败/超时 ⇒ 无缝落回下面的单帧降级链 —— 上层产出契约
    ``(Image, note)`` 分毫不变，无感切换；
  - 流缺省关闭（``DSH_PHYSICAL_ANDROID_STREAM_ENABLED``），关闭时本模块
    行为与 W4-5 完全一致（零回归）；
  - 流内另有一道 dhash 门控（同算法）＋ idle 看门狗停流/惰性重启，
    见 scrcpyStream.py 的资源纪律注释。
"""
from __future__ import annotations

import io
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Callable, Literal

from PIL import Image

from .config import AndroidConfig
from .errors import ErrorKind, PhysicalError
from .scrcpyStream import (  # W6-6 常驻视频流
    AdbScrcpyServerSpawner,
    DecoderFactory,
    StreamConfig,
    StreamHub,
    resolve_decoder_factory,
    stream_config_from_env,
)

# ─── W4-5 Surface id 方言（host 显示器 / android 设备统一入列虚拟显示器）───
#
#   "host:0" / "host:1"      主机显示器（/v1/displays 清单序，0 起 —— Σ-5
#                            的 display 索引泛化为字符串 id）
#   "android:<serial>"       adb 设备 serial（emulator-5554 / R58M... / ip:port）

SurfaceKind = Literal["host", "android"]

_SURFACE_RE = re.compile(r"^(host|android):(.+)$")


def parse_surface_id(spec: str) -> tuple[SurfaceKind, int | str]:
    """surface id → ``(kind, key)``；畸形 id ⇒ ``INVALID_ARGS``（诚实信封）。

    ``host:<i>`` 的 ``i`` 必须是非负整数（Python 负索引会从尾部取 —— 显式挡掉，
    与 Σ-5 的 display 越界执法同律）；``android:<serial>`` 的 serial 为非空原样串
    （adb serial 字符集宽 —— 不做过收窄白名单，合法性交由 adb 事实判决）。
    """
    if not isinstance(spec, str):
        raise PhysicalError(ErrorKind.INVALID_ARGS, f"surface must be a string, got {type(spec).__name__}")
    m = _SURFACE_RE.match(spec.strip())
    if not m:
        raise PhysicalError(
            ErrorKind.INVALID_ARGS,
            f"invalid surface id {spec!r} (expected 'host:<index>' or 'android:<serial>')",
        )
    kind, key = m.group(1), m.group(2)
    if kind == "host":
        if not re.fullmatch(r"\d+", key):
            raise PhysicalError(
                ErrorKind.INVALID_ARGS,
                f"invalid surface id {spec!r}: host index must be a non-negative integer",
            )
        return "host", int(key)
    if not key:
        raise PhysicalError(ErrorKind.INVALID_ARGS, f"invalid surface id {spec!r}: android serial must be non-empty")
    return "android", key


def format_surface_id(kind: SurfaceKind, key: int | str) -> str:
    """ ``(kind, key)`` → surface id（与 parse_surface_id 互逆）。"""
    return f"{kind}:{key}"


# ─── 可注入 runner（离线契约测试的根基：测试注入桩，缺省 subprocess）───

CommandResult = tuple[int, bytes, bytes]
SurfaceRunner = Callable[..., CommandResult]


def default_runner(argv: list[str], timeout_s: float = 15.0, cwd: str | None = None) -> CommandResult:
    """缺省 runner：``subprocess.run`` 捕获版。

    二进制缺席（FileNotFoundError ⇒ 127）与超时（124）都转成结构化
    ``(rc, stdout, stderr)`` —— 调用方按诚实降级处理，永不抛裸异常。
    """
    try:
        cp = subprocess.run(argv, capture_output=True, timeout=timeout_s, cwd=cwd)
        return (cp.returncode, cp.stdout or b"", cp.stderr or b"")
    except FileNotFoundError as e:
        return (127, b"", str(e).encode("utf-8", "replace"))
    except subprocess.TimeoutExpired as e:
        return (124, e.stdout or b"", b"timeout")


def _version_tuple(s: str) -> tuple[int, ...]:
    """版本串 → 可比较元组（不足三段右补零：'2.7' == '2.7.0'）。"""
    parts = [int(p) for p in re.findall(r"\d+", s)[:3]]
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)


# ─── Android 键位码表（host 键名 → KEYCODE；仅单键，组合键诚实拒绝）───

_ANDROID_KEYCODES: dict[str, int] = {
    "enter": 66, "return": 66, "tab": 61, "space": 62,
    "backspace": 67, "delete": 67, "del": 67, "esc": 4, "escape": 4,
    "home": 3, "back": 4, "menu": 82, "app_switch": 187,
    "up": 19, "down": 20, "left": 21, "right": 22,
    "pageup": 92, "pagedown": 93, "volup": 24, "voldown": 25, "power": 26,
    **{chr(c): 29 + c - ord("a") for c in range(ord("a"), ord("z") + 1)},
    **{str(d): 7 + d for d in range(10)},
}
_ANDROID_MODIFIERS = {"ctrl", "cmd", "alt", "shift", "win", "meta", "super"}


class AndroidController:
    """adb/scrcpy 设备控制器 —— 设备管理 + 帧源 + input 注入。

    所有方法同步（子进程阻塞）；HTTP 层在 executor 里跑（对齐
    ``ScreenCapture._capture_image`` 的既有范式）。失败 ``raise
    PhysicalError``，由 ``safe_call`` 转失败信封（异常诚实）。
    """

    RESOLUTION_TTL_DEFAULT = 30.0  # 兜底常量；真值来自 config.resolution_cache_s

    def __init__(self, cfg: AndroidConfig, runner: SurfaceRunner | None = None,
                 stream_cfg: StreamConfig | None = None,
                 stream_spawner=None,
                 stream_decoder_factory: DecoderFactory | str | None = None) -> None:
        """W6-6:``stream_*`` 三参为常驻流的离线注入口(缺省走 env + 真机
        spawner)。``stream_decoder_factory`` 语义:``None`` = 按
        ``cfg.decoder`` 解析降级链;``"none"`` = 强制缺席(测降级);
        callable = 直接采用。"""
        self.cfg = cfg
        self._runner: SurfaceRunner = runner or default_runner
        # serial → (w, h, 缓存时刻);TTL 见 cfg.resolution_cache_s
        self._resolution_cache: dict[str, tuple[int, int, float]] = {}
        # 最近一次设备清单(/health 的 surfaces 报告读缓存,不发子进程)
        self._inventory_cache: dict | None = None
        # scrcpy 探测结果缓存:(available, version_or_reason)
        self._scrcpy_probe: tuple[bool, str] | None = None
        # W6-6 常驻流:None = 未显式给 ⇒ env 决定(env 缺省 off ⇒ 零回归)
        self._stream_cfg: StreamConfig | None = (
            stream_cfg if stream_cfg is not None else stream_config_from_env()
        )
        self._stream_spawner = stream_spawner
        self._stream_decoder_factory = stream_decoder_factory
        self._stream_hub: StreamHub | None = None
        self._stream_dead_reason: str | None = None

    # ─── W6-6 常驻流枢纽(惰性构造;缺席 = 单帧链独走)───

    def _hub(self) -> StreamHub | None:
        """常驻流枢纽;不可用 ⇒ None + ``_stream_dead_reason`` 如实记录
        (诚实降级:缺席的依赖不假装在,grab_frame 落回单帧链)。"""
        cfg = self._stream_cfg
        if cfg is None or not cfg.enabled or self._stream_dead_reason is not None:
            return None
        if self._stream_hub is not None:
            return self._stream_hub
        # 流依赖 scrcpy ≥ min_version(server 协议 v2 起才有帧头 PTS)
        ok, version_or_reason = self._scrcpy_available()
        if not ok:
            self._stream_dead_reason = f"scrcpy probe failed for stream ({version_or_reason})"
            return None
        factory: DecoderFactory
        if self._stream_decoder_factory is None:
            resolved, reason = resolve_decoder_factory(cfg.decoder)
            if resolved is None:
                self._stream_dead_reason = f"stream decoder unsupported: {reason}"
                return None
            factory = resolved
        elif isinstance(self._stream_decoder_factory, str):
            # "none" = 强制缺席(离线契约测试的降级注入口)
            self._stream_dead_reason = "stream decoder disabled by injection"
            return None
        else:
            factory = self._stream_decoder_factory
        spawner = self._stream_spawner or AdbScrcpyServerSpawner(self.cfg, cfg, version_or_reason)
        self._stream_hub = StreamHub(
            cfg, spawner, factory,
            decoder_name=getattr(factory, "name", getattr(factory, "__name__", "custom")),
        )
        return self._stream_hub

    # ─── 子进程小包装（唯一的外部世界出口 —— 全部经注入 runner）───

    def _run(self, argv: list[str], cwd: str | None = None, timeout_ms: int | None = None) -> CommandResult:
        timeout_s = (timeout_ms if timeout_ms is not None else self.cfg.command_timeout_ms) / 1000.0
        return self._runner(argv, timeout_s, cwd)

    def _adb(self, *args: str, timeout_ms: int | None = None) -> CommandResult:
        return self._run([self.cfg.adb_path, *args], timeout_ms=timeout_ms)

    @staticmethod
    def _detail(stderr: bytes, rc: int, what: str) -> str:
        tail = (stderr or b"").decode("utf-8", "replace").strip()[:200]
        return f"{what} failed (rc={rc}): {tail}" if tail else f"{what} failed (rc={rc})"

    # ─── 设备管理 ───

    def list_devices(self) -> dict:
        """``adb devices`` 清单 + 每台的分辨率 → ``{devices, degraded, reason?}``。

        adb 缺席（rc=127）/ 失败 ⇒ 空清单 + ``degraded=True`` + 真实原因
        （诚实降级铁律：不静默假装无设备，也不谎报成功）。结果缓存供
        ``/health`` 的 surfaces 报告（只读缓存，不发子进程）。
        """
        if not self.cfg.enabled:
            self._inventory_cache = {
                "devices": [], "degraded": True,
                "reason": "android surface disabled (DSH_PHYSICAL_ANDROID_ENABLED)",
            }
            return dict(self._inventory_cache)

        rc, out, err = self._adb("devices")
        if rc != 0:
            reason = self._detail(err, rc, "adb devices")
            self._inventory_cache = {"devices": [], "degraded": True, "reason": reason}
            return dict(self._inventory_cache)

        devices: list[dict] = []
        for line in out.decode("utf-8", "replace").splitlines()[1:]:
            line = line.strip()
            if not line or line.startswith("*"):  # daemon 起动横幅等噪声行
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            serial, state = parts[0], parts[1]
            entry: dict = {
                "serial": serial,
                "state": state,
                "surface_id": format_surface_id("android", serial),
            }
            if state == "device":
                res = self._device_resolution(serial, refresh=False)
                entry["resolution"] = (
                    {"width": res[0], "height": res[1]} if res else None
                )
            else:
                # offline/unauthorized：如实列出状态，分辨率未知不编造
                entry["resolution"] = None
            devices.append(entry)

        self._inventory_cache = {"devices": devices, "degraded": False}
        return dict(self._inventory_cache)

    def cached_inventory(self) -> dict | None:
        """/health 用：最近一次清单缓存（未探测过 = None，不触发子进程）。"""
        return dict(self._inventory_cache) if self._inventory_cache is not None else None

    def connect(self, addr: str) -> dict:
        """``adb connect <ip:port>``（无线调试设备入列）。"""
        rc, out, err = self._adb("connect", addr)
        ok = rc == 0 and b"connected" in (out + err).lower()
        return {
            "connected": ok,
            "detail": (out or err).decode("utf-8", "replace").strip()[:200],
        }

    def disconnect(self, addr: str) -> dict:
        """``adb disconnect <addr>``。"""
        rc, out, err = self._adb("disconnect", addr)
        return {
            "disconnected": rc == 0,
            "detail": (out or err).decode("utf-8", "replace").strip()[:200],
        }

    # ─── 分辨率（归一化换算的分母 —— [0,1] 契约的设备侧锚点）───

    def _device_resolution(
        self, serial: str, refresh: bool = True,
    ) -> tuple[int, int] | None:
        """``wm size`` → ``(w, h)``；Override 优先于 Physical（用户设定优先）。

        TTL 缓存（分辨率极少漂移；旋转也会改 w/h —— TTL 到期自愈）。
        """
        now = time.monotonic()
        cached = self._resolution_cache.get(serial)
        if cached and (not refresh or now - cached[2] < self.cfg.resolution_cache_s):
            return (cached[0], cached[1])
        rc, out, err = self._adb("-s", serial, "shell", "wm", "size")
        if rc != 0:
            return None
        text = out.decode("utf-8", "replace")
        w = h = None
        for prefix in ("Override size:", "Physical size:"):
            m = re.search(re.escape(prefix) + r"\s*(\d+)x(\d+)", text)
            if m:
                w, h = int(m.group(1)), int(m.group(2))
                break
        if not w or not h:
            return None
        self._resolution_cache[serial] = (w, h, now)
        return (w, h)

    def resolution_or_raise(self, serial: str) -> tuple[int, int]:
        """分辨率（缓存穿透版）—— 未知 ⇒ 诚实失败（换算分母缺席不可编造）。"""
        res = self._device_resolution(serial)
        if not res:
            raise PhysicalError(
                ErrorKind.SCREEN_CAPTURE_FAILED,
                f"cannot resolve screen size of android device {serial!r} "
                "(wm size failed; device detached or unauthorized?)",
            )
        return res

    def _to_px(self, serial: str, x: float, y: float) -> tuple[int, int, int, int]:
        """归一化 [0,1]² → 设备像素（钳制到 [0, w-1]/[0, h-1]，对齐 host 侧
        ``InputController._normalize_to_pixel`` 的边界语义）。越界 ⇒ OUT_OF_BOUNDS。

        返回 ``(px, py, w, h)``（w/h 供审计回执）。
        """
        if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
            raise PhysicalError(
                ErrorKind.OUT_OF_BOUNDS,
                f"coordinates out of [0,1] for android surface: ({x}, {y})",
            )
        w, h = self.resolution_or_raise(serial)
        px = min(int(round(x * w)), w - 1)
        py = min(int(round(y * h)), h - 1)
        return max(0, px), max(0, py), w, h

    # ─── 帧源：scrcpy 优先 → adb screencap 降级 ───

    def _scrcpy_available(self) -> tuple[bool, str]:
        """scrcpy 在场性 + 版本闸门（≥ min_version 才信 ``--screenshot``）。"""
        if self._scrcpy_probe is not None:
            return self._scrcpy_probe
        rc, out, err = self._run([self.cfg.scrcpy_path, "--version"])
        if rc != 0:
            self._scrcpy_probe = (False, self._detail(err, rc, "scrcpy --version"))
            return self._scrcpy_probe
        first = (out or b"").decode("utf-8", "replace").splitlines()[0] if out else ""
        # 两段/三段版本都收（scrcpy 官方版既有 '2.3.1' 也有 '2.7'）
        m = re.search(r"scrcpy\s+v?(\d+(?:\.\d+){1,2})", first)
        if not m:
            self._scrcpy_probe = (False, f"cannot parse scrcpy version from {first!r}")
            return self._scrcpy_probe
        version = m.group(1)
        if _version_tuple(version) < _version_tuple(self.cfg.scrcpy_min_version):
            self._scrcpy_probe = (
                False,
                f"scrcpy {version} < min {self.cfg.scrcpy_min_version} (--screenshot unavailable)",
            )
            return self._scrcpy_probe
        self._scrcpy_probe = (True, version)
        return self._scrcpy_probe

    def _scrcpy_grab(self, serial: str) -> Image.Image:
        """scrcpy 单帧：``--screenshot`` 写 PNG 到进程 cwd（tempdir 隔离）。

        ``--max-size`` 先行降采样（带宽第一道门）；``--no-audio --no-control``
        关闭无关通道。找不到产物 ⇒ ``SCREEN_CAPTURE_FAILED``（调用方降级链接手）。
        """
        tmp = tempfile.mkdtemp(prefix="dsh-scrcpy-")
        try:
            argv = [
                self.cfg.scrcpy_path,
                f"--serial={serial}",
                "--no-audio",
                "--no-control",
                f"--max-size={self.cfg.scrcpy_max_frame_size}",
                "--screenshot",
            ]
            rc, out, err = self._run(argv, cwd=tmp)
            if rc != 0:
                raise PhysicalError(
                    ErrorKind.SCREEN_CAPTURE_FAILED,
                    self._detail(err, rc, f"scrcpy --screenshot on {serial}"),
                )
            pngs = sorted(Path(tmp).glob("*.png"), key=lambda p: p.stat().st_mtime)
            if not pngs:
                raise PhysicalError(
                    ErrorKind.SCREEN_CAPTURE_FAILED,
                    f"scrcpy --screenshot on {serial} produced no png in {tmp}",
                )
            with open(pngs[-1], "rb") as f:
                img = Image.open(io.BytesIO(f.read()))
                img.load()  # 截断图在此现形，不流进下游管线
                return img
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def _adb_screencap(self, serial: str) -> Image.Image:
        """降级帧源：``adb exec-out screencap -p``（exec-out 二进制安全）。"""
        rc, out, err = self._adb("-s", serial, "exec-out", "screencap", "-p")
        if rc != 0:
            raise PhysicalError(
                ErrorKind.SCREEN_CAPTURE_FAILED,
                self._detail(err, rc, f"adb exec-out screencap on {serial}"),
            )
        if not out:
            raise PhysicalError(
                ErrorKind.SCREEN_CAPTURE_FAILED,
                f"adb exec-out screencap on {serial} returned empty bytes",
            )
        img = Image.open(io.BytesIO(out))
        img.load()
        return img

    def grab_frame(self, serial: str) -> tuple[Image.Image, str | None]:
        """取一帧 → ``(Image, note)``;note = 降级/来源说明。

        W6-6 产出优先级:常驻流(最新缓冲帧,note 申报流出处)→ 单帧降级链
        (scrcpy ``--screenshot`` → adb screencap)。流任何不适用/失败/超时
        都静默落链(note 由链如实申报)—— 上层契约 ``(Image, note)`` 与
        单帧模式完全同形,无感切换;流命中的 note 含 "resident",不含
        "degraded"(降级字眼专属单帧链)。
        """
        if not self.cfg.enabled:
            raise PhysicalError(
                ErrorKind.SCREEN_CAPTURE_FAILED,
                "android surface disabled (DSH_PHYSICAL_ANDROID_ENABLED)",
            )
        hub = self._hub()
        if hub is not None:
            rec = None
            try:
                rec = hub.grab(serial)
            except Exception:
                rec = None  # 常驻流故障绝不拦截单帧链(降级纪律)
            if rec is not None:
                return rec.image, (
                    f"resident scrcpy stream frame ({rec.width}x{rec.height}, "
                    f"pts_us={rec.pts_us}, seq={rec.seq}, decoder={hub.decoder_name})"
                )
        ok, detail = self._scrcpy_available()
        if ok:
            try:
                return self._scrcpy_grab(serial), None
            except PhysicalError as e:
                note = f"scrcpy grab failed ({e.detail}); degraded to adb screencap"
                try:
                    return self._adb_screencap(serial), note
                except PhysicalError:
                    raise e from None  # scrcpy 的错误更接近根因（设备级）
        return self._adb_screencap(serial), (
            f"scrcpy unavailable ({detail}); degraded to adb exec-out screencap single frame"
        )

    # ─── input 注入（adb shell input —— 归一化坐标在 _to_px 换算）───

    def _shell(self, serial: str, *args: str) -> None:
        rc, _out, err = self._adb("-s", serial, "shell", "input", *args)
        if rc != 0:
            raise PhysicalError(
                ErrorKind.INTERNAL_ERROR,
                self._detail(err, rc, f"adb shell input {' '.join(args)} on {serial}"),
            )

    def tap(
        self, serial: str, x: float, y: float, button: str = "left", dry_run: bool = False,
    ) -> dict:
        """点击：left=``input tap``；right=长按惯用语（``input swipe x y x y
        long_press_threshold_ms`` —— Android 无右键，长按是其上下文菜单等价物）；
        middle 不存在 ⇒ 诚实拒绝。"""
        if button not in ("left", "right", "middle"):
            raise PhysicalError(
                ErrorKind.UNKNOWN_BUTTON,
                f"unknown mouse button: {button!r} (allowed: left/right/middle)",
            )
        px, py, w, h = self._to_px(serial, x, y)
        if button == "middle":
            raise PhysicalError(
                ErrorKind.INVALID_ARGS,
                "middle click has no android equivalent (no middle button on touch surfaces)",
            )
        if not dry_run:
            if button == "right":
                self._shell(serial, "swipe", str(px), str(py), str(px), str(py),
                            str(self.cfg.long_press_threshold_ms))
            else:
                self._shell(serial, "tap", str(px), str(py))
        return {
            "pixel": {"x": px, "y": py},
            "screen": {"width": w, "height": h},
            "surface": format_surface_id("android", serial),
            **({"mode": "long_press"} if button == "right" else {}),
        }

    def drag(
        self, serial: str, start: dict, end: dict,
        duration_ms: float | None = None, dry_run: bool = False,
    ) -> dict:
        """拖拽 → ``input swipe``（时长 = 按压时长）。

        长按 = 时长阈值：位移 < ``long_press_min_px``（≈ 原地）且时长 ≥
        ``long_press_threshold_ms`` ⇒ 原地 swipe（Android 长按惯用语）。
        """
        try:
            sx, sy = float(start["x"]), float(start["y"])
            ex, ey = float(end["x"]), float(end["y"])
        except (KeyError, TypeError, ValueError) as e:
            raise PhysicalError(
                ErrorKind.INVALID_ARGS, f"drag start/end must be {{x,y}}: {e}",
            ) from e
        spx, spy, w, h = self._to_px(serial, sx, sy)
        epx, epy, _w, _h = self._to_px(serial, ex, ey)
        duration = int(self.cfg.swipe_duration_ms if duration_ms is None else duration_ms)
        stationary = abs(epx - spx) <= self.cfg.long_press_min_px and abs(epy - spy) <= self.cfg.long_press_min_px
        mode = "long_press" if stationary else "swipe"
        if stationary:
            duration = max(duration, self.cfg.long_press_threshold_ms)
            epx, epy = spx, spy  # 原地长按（钳制抖动）
        if not dry_run:
            self._shell(serial, "swipe", str(spx), str(spy), str(epx), str(epy), str(duration))
        return {
            "start_pixel": {"x": spx, "y": spy},
            "end_pixel": {"x": epx, "y": epy},
            "duration_ms": duration,
            "mode": mode,
            "surface": format_surface_id("android", serial),
        }

    # adb 客户端把 ``shell`` 子命令后的参数按空格拼接、原样发给设备端
    # ``/system/bin/sh -c`` 解释 —— ``; & $ ( ) ` | < >`` 等元字符在设备端
    # 是 shell 语法（W6-R-A3 注入修复的根因）。设备 shell 是 POSIX 方言，
    # 单引号内的字节不做任何展开/替换，原样直达 ``input`` 二进制。
    # ``shlex.quote`` 正是该方言的标准实现（stdlib，零自制转义轮子）。
    #
    # 注：不用 %XX 百分号转义 —— ``input text`` 官方只认 ``%s``（空格），
    # 通用 %XX 解码在旧 Android 上缺席（会打出字面 "%3B"），保真不可移植；
    # 单引号包裹则对所有设备版本一律成立。
    #
    # ``%`` 本身的诚实边界：设备端 ``input`` 无法转义字面 ``%s`` —— 文本里
    # 出现 ``%s`` 会被设备打成空格（历史行为，保持并在回执 note 申报）。

    def type_text(
        self, serial: str, text: str, clear_first: bool = False, dry_run: bool = False,
    ) -> dict:
        """文本注入 → ``adb shell input text``（空格转义 %s + 设备 shell 单引号包裹）。

        转义规则（W6-R-A3 注入修复）：
          1. 仅收可打印 ASCII（0x20-0x7E）；非 ASCII / 控制字符 ⇒ 诚实拒绝
             （不静默丢字，也不给设备 shell 留词分割/换行注入口）。
          2. 空格 → ``%s``（``input text`` 官方空格惯用语，先于引号处理 ——
             保证最终 argv 元素内无空格，adb 客户端的按空格拼接无害）。
          3. 整串经 ``shlex.quote`` 单引号包裹（内嵌 ``'`` → ``'\\''``）——
             ``; & $ ( ) ` | < > " ' * ? [ ] ~ { }`` 等全部元字符在设备端
             ``/system/bin/sh`` 视角只剩字面字节，注入面从根上消解。

        ``clear_first``：设备无 Ctrl+A —— 退格近似（``input keyevent 67×N``，
        N = ``clear_first_backspaces``，config 驱动）。
        """
        # 防御第一步：字符域白名单（可打印 ASCII）。旧检查只挡 >0x7E，
        # 控制字符（换行/制表/NUL 等）会漏进设备 shell 的词分割/命令边界。
        bad_chars = [c for c in text if not (0x20 <= ord(c) <= 0x7E)]
        if bad_chars:
            preview = [f"U+{ord(c):04X}" for c in bad_chars[:4]]
            raise PhysicalError(
                ErrorKind.INVALID_ARGS,
                f"adb input text supports printable ASCII only; "
                f"non-printable/non-ascii chars present: {preview}",
            )
        if not dry_run:
            if clear_first and self.cfg.clear_first_backspaces > 0:
                # input keyevent 接受空格分隔的多码序列 —— 一次子进程完成 N 连击
                # （纯数字 + 空格，无元字符面）
                codes = " ".join(["67"] * self.cfg.clear_first_backspaces)
                rc, _out, err = self._adb("-s", serial, "shell", "input", "keyevent", codes)
                if rc != 0:
                    raise PhysicalError(
                        ErrorKind.INTERNAL_ERROR,
                        self._detail(err, rc, f"clear_first backspaces on {serial}"),
                    )
            if text:
                escaped = shlex.quote(text.replace(" ", "%s"))
                self._shell(serial, "text", escaped)
        result: dict = {
            "typed_chars": len(text),
            "surface": format_surface_id("android", serial),
        }
        if "%s" in text:
            # 诚实申报设备端 %s 的语义边界（见上文「% 本身的诚实边界」）
            result["note"] = (
                "literal '%s' in text is decoded as space by device 'input text' "
                "(android protocol limitation, not silently dropped)"
            )
        return result

    def key(self, serial: str, keys: list[str], dry_run: bool = False) -> dict:
        """按键 → ``input keyevent``。Android 无组合键面：修饰键/多键组合 ⇒
        诚实拒绝（UNKNOWN_KEY / INVALID_ARGS），绝不静默只按其中一个。"""
        if not keys or len(keys) > 5:
            raise PhysicalError(
                ErrorKind.INVALID_ARGS, f"hotkey keys count out of range: {len(keys)} (1-5)",
            )
        codes: list[int] = []
        for k in keys:
            kl = k.lower()
            if kl in _ANDROID_MODIFIERS:
                raise PhysicalError(
                    ErrorKind.UNKNOWN_KEY,
                    f"modifier key {k!r} has no android equivalent (combos unsupported on android surface)",
                )
            if kl not in _ANDROID_KEYCODES:
                raise PhysicalError(
                    ErrorKind.UNKNOWN_KEY,
                    f"unknown key on android surface: {k!r} "
                    f"(allowed: {', '.join(sorted(set(_ANDROID_KEYCODES) - set('abcdefghijklmnopqrstuvwxyz0123456789'))[:24])} a-z 0-9)",
                )
            codes.append(_ANDROID_KEYCODES[kl])
        if len(codes) > 1:
            raise PhysicalError(
                ErrorKind.INVALID_ARGS,
                f"key combos unsupported on android surface (got {len(codes)} keys); "
                "send keys one at a time",
            )
        if not dry_run:
            self._shell(serial, "keyevent", str(codes[0]))
        return {"pressed": keys, "surface": format_surface_id("android", serial)}

    def scroll(
        self, serial: str, direction: str, amount: int, dry_run: bool = False,
    ) -> dict:
        """滚动 → 屏心 ``input swipe``（amount tick × ``scroll_px_per_tick`` 像素）。

        host 语义对齐：direction=down（看下方内容）= 手势上滑。
        """
        if direction not in {"up", "down", "left", "right"}:
            raise PhysicalError(
                ErrorKind.INVALID_ARGS, f"unknown scroll direction: {direction!r}",
            )
        if amount <= 0 or amount > 1000:
            raise PhysicalError(
                ErrorKind.INVALID_ARGS, f"scroll amount out of range: {amount} (1-1000)",
            )
        w, h = self.resolution_or_raise(serial)
        cx, cy = w // 2, h // 2
        d = max(1, int(amount * self.cfg.scroll_px_per_tick))
        if direction == "down":
            x0, y0, x1, y1 = cx, cy + d // 2, cx, cy - d // 2
        elif direction == "up":
            x0, y0, x1, y1 = cx, cy - d // 2, cx, cy + d // 2
        elif direction == "right":
            x0, y0, x1, y1 = cx - d // 2, cy, cx + d // 2, cy
        else:  # left
            x0, y0, x1, y1 = cx + d // 2, cy, cx - d // 2, cy
        if not dry_run:
            self._shell(serial, "swipe", str(x0), str(y0), str(x1), str(y1),
                        str(self.cfg.swipe_duration_ms))
        return {"scrolled": amount, "pixels": d, "surface": format_surface_id("android", serial)}

    # ─── 生命周期 ───

    def close(self) -> None:
        """关闭:清缓存 + W6-6 常驻流全停(kill 子进程/关 socket/join 线程)。"""
        hub = self._stream_hub
        if hub is not None:
            hub.close()
            self._stream_hub = None
        self._resolution_cache.clear()
        self._inventory_cache = None


# ═══ W6-6 自测入口:python -m dsh_physical.android --selftest ═══
#
# 离线契约(零真进程/零真设备):假 spawner + 假解码器 + 合成 v2.x framed
# 字节流(读线程与 FrameParser 走真实字节路径,只把「H264→PIL」这一环
# 换成假解码器)。场景:
#   S0 surface id 方言回归      S1 流配置 env(缺省 off)
#   S2 帧头解析(2x/4x 位序、分片重组)   S3 非 h264 ⇒ 诚实报错
#   S4 流启动→帧产出(PTS/分辨率保留)   S5 门控:帧未变不重复产出
#   S6 背压:50 帧不消费 ⇒ 缓冲有界     S7 idle 超时自动停流
#   S8 惰性重启                 S9 启动失败降级单帧链(+冷却退避)
#   S10 解码器缺席 ⇒ 降级单帧链  S11 清理执法(mock 计数:无残留句柄/线程)
#   S12 集成正路径(note 契约)  S13 缺省 off ⇒ 流零触碰(零回归)

def _run_selftest() -> int:
    import itertools
    import os
    import queue as _queue
    import struct as _struct
    import threading as _threading

    from .scrcpyStream import FrameParser, StreamHub, stream_config_from_env

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

    # ── 夹具工坊 ──

    def grad(w: int, h: int, phase: int) -> Image.Image:
        """确定性合成帧:4px 宏块伪随机图(phase 平移 ⇒ dhash 可区分)。"""
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
            self._q: _queue.Queue = _queue.Queue()
            self.closed = _threading.Event()
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
        """假 spawner:opens/closes 计数执法 + 合成 v2x 流(自动首帧,
        每次重启 seed 递增 ⇒ 帧内容必然不同)。"""

        def __init__(self, fail: bool = False) -> None:
            self.fail = fail
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
            self._emit(src, [next(self._seeds)], header=True)
            return src

        __call__ = open

        def _emit(self, src: FakeByteSource, seeds: list[int], header: bool) -> None:
            # 合成 v2x framed 流:header=True 时含 dummy byte + codec meta
            # (仅流首);纯帧块用于后续 push(parser 已进入包循环态)。
            buf = (b"\x00" + b"h264" + _struct.pack(">II", 32, 48)) if header else b""
            for s in seeds:
                payload = _struct.pack(">IIQ", 32, 48, s)
                u64 = (1 << 62) | s  # keyframe=1, config=0, PTS=seed
                buf += _struct.pack(">QI", u64, len(payload)) + payload
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
                w, h, seed = _struct.unpack(">IIQ", data)
                return [grad(w, h, seed)]

            def close(self) -> None:
                if not self._closed:
                    self._closed = True
                    counts["closed"] += 1
        return FakeDecoder

    def mk_stub_runner(calls: list) -> SurfaceRunner:
        """单帧链桩:scrcpy 2.7.1 在场、--screenshot 恒败(逼降级)、
        adb screencap 返合成 PNG。"""
        png_buf = io.BytesIO()
        Image.new("RGB", (32, 48), (7, 8, 9)).save(png_buf, format="PNG")
        png = png_buf.getvalue()

        def runner(argv, timeout_s=15.0, cwd=None):
            calls.append(list(argv))
            if "--version" in argv:
                return 0, b"scrcpy 2.7.1\n", b""
            if "--screenshot" in argv:
                return 1, b"", b"stub scrcpy screenshot failure"
            if "screencap" in argv:
                return 0, png, b""
            return 0, b"", b""

        return runner

    cfgA = AndroidConfig()

    # ── S0 既有 surface id 方言回归(W6-6 不破 W4-5 契约)──
    check("S0 parse host", parse_surface_id("host:0") == ("host", 0))
    check("S0 parse android", parse_surface_id("android:emu1") == ("android", "emu1"))
    check("S0 format inverse",
          format_surface_id(*parse_surface_id("android:ZX1G")) == "android:ZX1G")
    try:
        parse_surface_id("android:")
        check("S0 reject empty serial", False)
    except PhysicalError:
        check("S0 reject empty serial", True)

    # ── S1 流配置:缺省 off(env 开关往返)──
    env_key = "DSH_PHYSICAL_ANDROID_STREAM_ENABLED"
    saved_env = os.environ.get(env_key)
    try:
        os.environ.pop(env_key, None)
        check("S1 stream off by default", stream_config_from_env().enabled is False)
        os.environ[env_key] = "true"
        check("S1 env enables stream", stream_config_from_env().enabled is True)
    finally:
        if saved_env is None:
            os.environ.pop(env_key, None)
        else:
            os.environ[env_key] = saved_env

    # ── S2 帧头解析:v2x 位序 + 任意分片重组 ──
    parser = FrameParser("2x")
    pkt1 = _struct.pack(">QI", (1 << 62) | 100, 4) + b"\x11\x22\x33\x44"  # keyframe, pts=100
    pkt2 = _struct.pack(">QI", (1 << 63) | 200, 1) + b"\x55"              # config, pts 位无意义
    stream2 = b"\x00" + b"h264" + _struct.pack(">II", 32, 48) + pkt1 + pkt2
    pkts = [p for i in range(0, len(stream2), 3) for p in parser.feed(stream2[i:i + 3])]
    check("S2 codec meta parsed",
          parser.meta == {"codec": "h264", "width": 32, "height": 48})
    check("S2 packets from 3-byte chunks",
          len(pkts) == 2 and pkts[0].pts_us == 100 and pkts[1].pts_us is None)
    check("S2 flags/payload",
          pkts[0].keyframe and not pkts[0].config and pkts[0].payload == b"\x11\x22\x33\x44"
          and pkts[1].config)
    p4 = FrameParser("4x")
    u64_4x = (1 << 63) | (1 << 61) | 777  # scrcpy>=3: media + keyframe + PTS(u61)
    pk4 = p4.feed(b"\x00" + b"h264" + _struct.pack(">II", 8, 8)
                  + _struct.pack(">QI", u64_4x, 2) + b"zz")
    check("S2 4x bit layout",
          pk4 and pk4[0].keyframe and not pk4[0].config and pk4[0].pts_us == 777)

    # ── S3 非 h264 ⇒ 诚实报错(不猜)──
    p3 = FrameParser("2x")
    p3.feed(b"\x00" + b"h265" + _struct.pack(">II", 4, 4))
    check("S3 rejects non-h264 codec",
          p3.error is not None and "unsupported video codec" in p3.error)

    # ── S4-S8, S11:hub 全流程(mock spawner + mock decoder)──
    # idle_timeout 取 1.2s:大于 S4-S6 的交互间隔(流不被误停),
    # 又小于 S7 的观察预算(idle 停流可断言)。
    scfg = StreamConfig(enabled=True, idle_timeout_s=1.2, watchdog_tick_s=0.05,
                        first_frame_timeout_s=2.0, ring_capacity=3, gate_distance=0,
                        start_cooldown_s=30.0)
    fake = FakeSpawner()
    dec_counts: dict = {"made": 0, "closed": 0}
    hub = StreamHub(scfg, fake, mk_fake_decoder(dec_counts), decoder_name="fake")

    rec = hub.grab("emu1")  # 惰性启动 + 自动首帧(seed=1000)
    check("S4 stream start yields frame",
          rec is not None and (rec.width, rec.height) == (32, 48))
    check("S4 pts/seq preserved", rec.pts_us == 1000 and rec.seq == 1)
    fake.push_seeds([11, 12, 13])
    check("S4 decodes pushed frames",
          wait_until(lambda: hub.stats().get("emu1", {}).get("frames_decoded") == 4))
    rec = hub.grab("emu1")
    check("S4 latest frame wins", rec.seq == 4 and rec.pts_us == 13)

    fake.push_seeds([42] * 6)  # 6 帧同内容:第 1 帧入槽,后 5 帧被门控丢弃
    check("S5 gate consumes identical frames",
          wait_until(lambda: hub.stats().get("emu1", {}).get("frames_decoded") == 10))
    st5 = hub.stats()["emu1"]
    rec = hub.grab("emu1")
    check("S5 gate drops unchanged (seq frozen)",
          st5["gate_dropped"] == 5 and rec.seq == 5)

    fake.push_seeds([200 + i for i in range(50)])  # 慢消费:50 帧不被取走
    check("S6 decodes all 50",
          wait_until(lambda: hub.stats().get("emu1", {}).get("frames_decoded") == 60))
    st6 = hub.stats()["emu1"]
    rec = hub.grab("emu1")
    check("S6 ring bounded (backpressure safe)",
          st6["ring_len"] == 3 and st6["ring_overrun"] == 52 and rec.seq == 55)

    check("S7 idle timeout stops stream",
          wait_until(lambda: "emu1" not in hub.stats(), deadline_s=4.0))
    check("S7 no respawn during idle", fake.opens == 1 and fake.closes == 1)

    rec = hub.grab("emu1", timeout_s=3.0)  # 惰性重启(新 seed=1001)
    check("S8 lazy restart on next grab",
          rec is not None and fake.opens == 2 and rec.seq == 1 and rec.pts_us == 1001)

    hub.close()
    check("S11 all sources closed (no leaked handles)",
          fake.all_closed and fake.opens == fake.closes == 2)
    check("S11 watchdog joined",
          hub._watchdog is None or not hub._watchdog.is_alive())
    check("S11 decoders closed", dec_counts["made"] == dec_counts["closed"] >= 2)

    # ── S9 启动失败 ⇒ 降级单帧链 + 冷却退避 ──
    calls9: list = []
    fake9 = FakeSpawner(fail=True)
    ctrl9 = AndroidController(cfgA, runner=mk_stub_runner(calls9),
                              stream_cfg=StreamConfig(enabled=True, first_frame_timeout_s=0.5,
                                                      start_cooldown_s=5.0),
                              stream_spawner=fake9,
                              stream_decoder_factory=mk_fake_decoder({"made": 0, "closed": 0}))
    img9, note9 = ctrl9.grab_frame("emu1")
    check("S9 spawn failure degrades to single-frame chain",
          img9.size == (32, 48) and note9 is not None and "degraded" in note9)
    img9b, _ = ctrl9.grab_frame("emu1")
    check("S9 cooldown prevents immediate respin",
          fake9.opens == 1 and img9b.size == (32, 48))
    ctrl9.close()

    # ── S10 解码器缺席 ⇒ 诚实 unsupported,降级单帧链 ──
    calls10: list = []
    fake10 = FakeSpawner()
    ctrl10 = AndroidController(cfgA, runner=mk_stub_runner(calls10),
                               stream_cfg=StreamConfig(enabled=True),
                               stream_spawner=fake10,
                               stream_decoder_factory="none")
    img10, note10 = ctrl10.grab_frame("emu1")
    check("S10 decoder absent degrades (no spawn attempted)",
          img10.size == (32, 48) and note10 is not None and "degraded" in note10
          and fake10.opens == 0)
    ctrl10.close()

    # ── S12 集成正路径:流命中 ⇒ note 申报出处,单帧链零触碰 ──
    calls12: list = []
    fake12 = FakeSpawner()
    ctrl12 = AndroidController(cfgA, runner=mk_stub_runner(calls12),
                               stream_cfg=StreamConfig(enabled=True),
                               stream_spawner=fake12,
                               stream_decoder_factory=mk_fake_decoder({"made": 0, "closed": 0}))
    img12, note12 = ctrl12.grab_frame("emu1")
    check("S12 resident stream hit",
          img12.size == (32, 48) and note12 is not None and "resident" in note12
          and "pts_us=1000" in note12 and "degraded" not in note12)
    check("S12 single-frame chain untouched by stream hit",
          not any("--screenshot" in c or "screencap" in c for c in calls12))
    ctrl12.close()
    check("S12 controller.close stops stream",
          fake12.all_closed and fake12.opens == fake12.closes)

    # ── S13 缺省 off ⇒ 流零触碰(W4-5 零回归)──
    calls13: list = []
    fake13 = FakeSpawner()
    ctrl13 = AndroidController(cfgA, runner=mk_stub_runner(calls13),
                               stream_cfg=StreamConfig(enabled=False),
                               stream_spawner=fake13,
                               stream_decoder_factory=mk_fake_decoder({"made": 0, "closed": 0}))
    img13, _ = ctrl13.grab_frame("emu1")
    check("S13 disabled stream never spawns",
          img13.size == (32, 48) and fake13.opens == 0)
    ctrl13.close()

    # ── S14 type_text 注入防护(W6-R-A3:设备 shell 元字符消解)──
    # 契约:adb 客户端把 shell 子命令后参数按空格拼接发设备端 /system/bin/sh
    # 解释 —— 断言 = 用 POSIX 同方言的 shlex.split 解析设备端实际收到的命令
    # 行,input text 的参数必须逐字节还原(元字符全部沦为字面量)。
    calls14: list = []
    ctrl14 = AndroidController(cfgA, runner=mk_stub_runner(calls14))
    metachars = "a;b`c$(d)|e&f<g>h*i?j[k]l~m\"n'o_p{q}r!s^t"
    ctrl14.type_text("emu1", metachars)
    argv14 = next(c for c in calls14 if "text" in c)
    remote_cmd = " ".join(argv14[argv14.index("shell") + 1:])  # 设备端收到的命令行
    parsed14 = shlex.split(remote_cmd)
    check("S14 metachars survive device sh verbatim",
          parsed14 == ["input", "text", metachars])
    check("S14 escaped arg carries no shell-active syntax",
          argv14[argv14.index("text") + 1] != metachars)  # 确实做了转义(非裸传)
    ctrl14.type_text("emu1", "hello world")
    argv14b = next(c for c in reversed(calls14[-2:]) if "text" in c)
    parsed14b = shlex.split(" ".join(argv14b[argv14b.index("shell") + 1:]))
    check("S14 space -> %s inside quotes",
          parsed14b == ["input", "text", "hello%sworld"])
    try:
        ctrl14.type_text("emu1", "bad\x00;rm")  # 控制字符 + 注入载荷
        check("S14 control chars rejected honestly", False)
    except PhysicalError as e14:
        check("S14 control chars rejected honestly", e14.kind is ErrorKind.INVALID_ARGS)
    try:
        ctrl14.type_text("emu1", "中文")
        check("S14 non-ascii rejected honestly", False)
    except PhysicalError as e14b:
        check("S14 non-ascii rejected honestly", e14b.kind is ErrorKind.INVALID_ARGS)
    r14 = ctrl14.type_text("emu1", "100%", dry_run=False)
    check("S14 bare percent passes without note", "note" not in r14)
    r14b = ctrl14.type_text("emu1", "a%sb")
    check("S14 literal %s flagged in note", "note" in r14b)

    print(f"\nandroid selftest: {'OK' if not failures else 'FAILED'} "
          f"({passed} passed, {len(failures)} failed)")
    return 0 if not failures else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(_run_selftest())
    if "--selftest-real" in sys.argv:
        # W9-4 真机实证探针入口:本模块逻辑零侵入,委托 real_probe.py
        # (adb/scrcpy/scrcpy-server.jar 在场性探测定谳,证据落 JSON)。
        import pathlib as _pl

        _svc_root = _pl.Path(__file__).resolve().parent.parent
        if str(_svc_root) not in sys.path:
            sys.path.insert(0, str(_svc_root))
        from real_probe import run_debt_probe

        raise SystemExit(run_debt_probe("D-A3"))
    print("usage: python -m dsh_physical.android --selftest | --selftest-real")
    raise SystemExit(2)
