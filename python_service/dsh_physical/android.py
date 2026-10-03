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
"""
from __future__ import annotations

import io
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Callable, Literal

from PIL import Image

from .config import AndroidConfig
from .errors import ErrorKind, PhysicalError

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

    def __init__(self, cfg: AndroidConfig, runner: SurfaceRunner | None = None) -> None:
        self.cfg = cfg
        self._runner: SurfaceRunner = runner or default_runner
        # serial → (w, h, 缓存时刻)；TTL 见 cfg.resolution_cache_s
        self._resolution_cache: dict[str, tuple[int, int, float]] = {}
        # 最近一次设备清单（/health 的 surfaces 报告读缓存，不发子进程）
        self._inventory_cache: dict | None = None
        # scrcpy 探测结果缓存：(available, version_or_reason)
        self._scrcpy_probe: tuple[bool, str] | None = None

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
        """取一帧 → ``(Image, note)``；note = 降级说明（scrcpy 在场时为 None）。

        降级链：scrcpy（带宽优先）→ 任一失败/缺席 → adb screencap 单帧，
        note 如实申报降级原因（诚实铁律：降级不静默）。两级都失败 ⇒ 抛
        ``PhysicalError``（最后一次的错误 —— 距离用户最近的事实）。
        """
        if not self.cfg.enabled:
            raise PhysicalError(
                ErrorKind.SCREEN_CAPTURE_FAILED,
                "android surface disabled (DSH_PHYSICAL_ANDROID_ENABLED)",
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

    def type_text(
        self, serial: str, text: str, clear_first: bool = False, dry_run: bool = False,
    ) -> dict:
        """文本注入 → ``adb shell input text``（空格转义 %s）。

        ``input text`` 只收 ASCII：非 ASCII ⇒ 诚实拒绝（不静默丢字）。
        ``clear_first``：设备无 Ctrl+A —— 退格近似（``input keyevent 67×N``，
        N = ``clear_first_backspaces``，config 驱动）。
        """
        non_ascii = [c for c in text if ord(c) > 0x7E]
        if non_ascii:
            raise PhysicalError(
                ErrorKind.INVALID_ARGS,
                f"adb input text supports printable ASCII only; "
                f"non-ascii chars present: {non_ascii[:4]!r}",
            )
        if not dry_run:
            if clear_first and self.cfg.clear_first_backspaces > 0:
                # input keyevent 接受空格分隔的多码序列 —— 一次子进程完成 N 连击
                codes = " ".join(["67"] * self.cfg.clear_first_backspaces)
                rc, _out, err = self._adb("-s", serial, "shell", "input", "keyevent", codes)
                if rc != 0:
                    raise PhysicalError(
                        ErrorKind.INTERNAL_ERROR,
                        self._detail(err, rc, f"clear_first backspaces on {serial}"),
                    )
            if text:
                escaped = text.replace(" ", "%s")
                self._shell(serial, "text", escaped)
        return {
            "typed_chars": len(text),
            "surface": format_surface_id("android", serial),
        }

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
        """关闭：清缓存（帧源是一次性子进程，无常驻句柄可泄）。"""
        self._resolution_cache.clear()
        self._inventory_cache = None
