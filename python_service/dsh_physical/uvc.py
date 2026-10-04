"""UVC 采集源 —— L2 零 API 设备面:HDMI 采集卡帧管线(W4-6)。

场景:目标设备无辅助功能 API(游戏机 / 工控机 / 加密桌面)时,物理链路 =
HDMI OUT → 采集卡(UVC 摄像头枚举) → 本服务。本模块是「眼睛」:从 UVC
设备读帧,经四角校准(采集卡过扫描裁剪)→ dhash 变化门控 → PNG/JPEG 编码,
方言与 ``screen.py`` 对齐(归一化 [0,1] 契约 / extras 字段 / gate 语义 /
``PhysicalError`` 错误信封),便于未来注册进 routes.py。

后端链(W4-6):
  - ``cv2.VideoCapture(index)``:首选(Windows 自动走 DirectShow,
    Linux 走 V4L2);cv2 缺席时**诚实 unsupported** —— 原生 DirectShow
    COM 互操作(IGraphBuilder/SampleGrabber)需数百行 ctypes 胶水且无
    硬件无法验证,PoC 不冒险,错误信息给出 remediation。
  - ``MockFrameSource``:确定性帧源(自测/无硬件 CI)。

全部外部依赖(cv2)经懒加载 + 可注入 ``source`` 构造参数隔离 —— 模块导入
零副作用,自测不需要任何硬件。

自测入口(W4-6):``python -m dsh_physical.uvc --selftest``
"""
from __future__ import annotations

import asyncio
import io
import os
import sys
import time
from dataclasses import dataclass
from typing import Literal, Protocol

from PIL import Image

from .errors import ErrorKind, PhysicalError
from .screen import compute_dhash, hamming_hex  # 只读复用:指纹与门控方言同源

ImageFormat = Literal["png", "jpeg"]


# ─── 配置(W4-6):环境变量方言与 config.py 同律(DSH_PHYSICAL_ 前缀)───


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as e:
        raise ValueError(f"env {name} must be int, got {raw!r}") from e


@dataclass(frozen=True)
class UvcConfig:
    """UVC 采集配置(W4-6)。

    - ``device_index``:cv2.VideoCapture 索引(0 起)
    - ``source_kind``:auto(真实设备,缺省)/ mock(确定性测试帧源)
    - ``width/height/fps``:请求的采集格式(None = 设备缺省)
    - ``jpeg_quality``:JPEG 编码质量(与 ScreenshotConfig.jpeg_quality 同语义)
    - ``gate_distance``:dhash 门控缺省汉明距离(与 screen.py gate.distance 同语义)
    """

    device_index: int = 0
    source_kind: Literal["auto", "mock"] = "auto"
    mock_width: int = 320
    mock_height: int = 240
    width: int | None = None
    height: int | None = None
    fps: int | None = None
    jpeg_quality: int = 85
    gate_distance: int = 3


def load_uvc_config_from_env() -> UvcConfig:
    """加载层方法(config.py 方言):校验失败 raise —— 拒绝带病上线(W4-6)。"""
    kind = _env("DSH_PHYSICAL_UVC_SOURCE", "auto").lower()
    if kind not in {"auto", "mock"}:
        raise ValueError(f"DSH_PHYSICAL_UVC_SOURCE must be 'auto' or 'mock', got {kind!r}")
    w = _env_int("DSH_PHYSICAL_UVC_WIDTH", 0)
    h = _env_int("DSH_PHYSICAL_UVC_HEIGHT", 0)
    return UvcConfig(
        device_index=_env_int("DSH_PHYSICAL_UVC_INDEX", 0),
        source_kind=kind,  # type: ignore[arg-type]
        mock_width=max(16, _env_int("DSH_PHYSICAL_UVC_MOCK_WIDTH", 320)),
        mock_height=max(16, _env_int("DSH_PHYSICAL_UVC_MOCK_HEIGHT", 240)),
        width=w if w > 0 else None,
        height=h if h > 0 else None,
        fps=_env_int("DSH_PHYSICAL_UVC_FPS", 0) or None,
        jpeg_quality=max(0, min(100, _env_int("DSH_PHYSICAL_UVC_JPEG_QUALITY", 85))),
        gate_distance=max(0, min(64, _env_int("DSH_PHYSICAL_UVC_GATE_DISTANCE", 3))),
    )


# ─── 四角校准(W4-6):采集卡过扫描的数学解 ───
#
# 采集卡常见病灶:HDMI 输入被缩进画框(四周黑边/过扫描),甚至轻微梯形畸变。
# 校准模型 = 屏幕内容四角在「采集帧归一化坐标系」中的位置:
#
#        tl ─────────── tr        屏幕内容区四角(TL/TR/BR/BL,
#         │  屏幕内容区  │          归一化 [0,1]×[0,1] 采集域坐标)
#        bl ─────────── br
#
# 正向映射(双线性四边形):p(u,v) = tl + u·(tr−tl) + v·(bl−tl)
#                              + u·v·(br−tr−bl+tl)
# 轴对齐时退化为普通矩形缩放(数学恒等,自测断言);非轴对齐时用
# ``PIL Image.QUAD`` 整帧矫正(数据序 = 左上、左下、右下、右上 —— 2026-10
# 实测钉死,与 Pillow 文档一致)。逆向映射经 2×2 牛顿迭代(纯函数,往返自测)。


Point = tuple[float, float]


@dataclass(frozen=True)
class Calibration:
    """屏幕内容区四角标定(采集帧归一化坐标;恒等标定 = 全帧)(W4-6)。"""

    tl: Point = (0.0, 0.0)
    tr: Point = (1.0, 0.0)
    br: Point = (1.0, 1.0)
    bl: Point = (0.0, 1.0)

    def __post_init__(self) -> None:
        for name in ("tl", "tr", "br", "bl"):
            x, y = getattr(self, name)
            if not (0.0 <= float(x) <= 1.0 and 0.0 <= float(y) <= 1.0):
                raise ValueError(f"calibration corner {name} out of [0,1]: ({x}, {y})")

    @classmethod
    def identity(cls) -> "Calibration":
        return cls()

    @classmethod
    def from_params(cls, params: dict) -> "Calibration":
        """从 ``{tl:{x,y}, tr:…, br:…, bl:…}``(或四元素列表)构造(W4-6)。"""
        order = ("tl", "tr", "br", "bl")
        if isinstance(params, (list, tuple)) and len(params) == 4:
            return cls(*[(float(p[0]), float(p[1])) for p in params])  # type: ignore[arg-type]
        if not isinstance(params, dict):
            raise ValueError("calibration params must be dict or 4-point list")
        pts: list[Point] = []
        for name in order:
            p = params.get(name)
            if not isinstance(p, dict) or "x" not in p or "y" not in p:
                raise ValueError(f"calibration params.{name} must be {{x, y}}")
            pts.append((float(p["x"]), float(p["y"])))
        return cls(*pts)

    def is_axis_aligned(self, tol: float = 1e-9) -> bool:
        """四角是否构成轴对齐矩形(是 ⇒ 可无重采样直裁,否 ⇒ QUAD 矫正)。"""
        return (
            abs(self.tl[1] - self.tr[1]) <= tol and abs(self.bl[1] - self.br[1]) <= tol
            and abs(self.tl[0] - self.bl[0]) <= tol and abs(self.tr[0] - self.br[0]) <= tol
        )

    def quad_point(self, u: float, v: float) -> Point:
        """屏幕归一化 (u,v) → 采集归一化坐标(双线性四边形,纯函数)(W4-6)。"""
        x = (
            self.tl[0] + u * (self.tr[0] - self.tl[0]) + v * (self.bl[0] - self.tl[0])
            + u * v * (self.br[0] - self.tr[0] - self.bl[0] + self.tl[0])
        )
        y = (
            self.tl[1] + u * (self.tr[1] - self.tl[1]) + v * (self.bl[1] - self.tl[1])
            + u * v * (self.br[1] - self.tr[1] - self.bl[1] + self.tl[1])
        )
        return (x, y)

    def inverse_point(self, x: float, y: float, iters: int = 12) -> Point:
        """采集归一化 → 屏幕归一化(2×2 牛顿迭代;轴对齐时一步收敛,纯函数)。"""
        # r(u,v) = quad_point(u,v) − (x,y);J 为解析雅可比
        u, v = 0.5, 0.5
        a0 = self.br[0] - self.tr[0] - self.bl[0] + self.tl[0]
        a1 = self.br[1] - self.tr[1] - self.bl[1] + self.tl[1]
        for _ in range(max(1, iters)):
            px, py = self.quad_point(u, v)
            rx, ry = px - x, py - y
            j00 = (self.tr[0] - self.tl[0]) + v * a0
            j01 = (self.bl[0] - self.tl[0]) + u * a0
            j10 = (self.tr[1] - self.tl[1]) + v * a1
            j11 = (self.bl[1] - self.tl[1]) + u * a1
            det = j00 * j11 - j01 * j10
            if abs(det) < 1e-15:  # 退化四边形(面积→0):保底返回当前估计
                break
            du = -(j11 * rx - j01 * ry) / det
            dv = -(j00 * ry - j10 * rx) / det
            u, v = u + du, v + dv
        return (u, v)

    def crop_box_px(self, w: int, h: int) -> tuple[int, int, int, int]:
        """轴对齐标定 → 整数像素裁剪框 (x0, y0, x1, y1)(越界钳制)(W4-6)。"""
        x0 = max(0, int(round(self.tl[0] * w)))
        y0 = max(0, int(round(self.tl[1] * h)))
        x1 = min(w, int(round(self.br[0] * w)))
        y1 = min(h, int(round(self.br[1] * h)))
        if x1 - x0 < 1 or y1 - y0 < 1:
            raise PhysicalError(
                ErrorKind.INVALID_ARGS,
                f"calibration degenerate after px conversion: ({x0},{y0})-({x1},{y1}) in {w}x{h}",
            )
        return (x0, y0, x1, y1)

    def natural_size(self, w: int, h: int) -> tuple[int, int]:
        """矫正输出的自然尺寸(标定区像素跨度 —— 保持 1:1 采样密度)(W4-6)。"""
        out_w = round(((self.tr[0] - self.tl[0]) ** 2 + (self.tr[1] - self.tl[1]) ** 2) ** 0.5 * w)
        out_h = round(((self.bl[0] - self.tl[0]) ** 2 + (self.bl[1] - self.tl[1]) ** 2) ** 0.5 * h)
        return (max(1, out_w), max(1, out_h))


def rectify(img: Image.Image, calib: Calibration, out_size: tuple[int, int] | None = None) -> Image.Image:
    """按四角标定矫正帧:轴对齐 ⇒ 直裁(零重采样损失);否则 QUAD 矫正(W4-6)。

    PIL ``Image.QUAD`` 数据序 = 源四边形 左上、左下、右下、右上 —— 即
    ``(tl, bl, br, tr)``(2026-10 实测钉死;自测用位置编码图守护此序)。
    """
    w, h = img.size
    if calib.is_axis_aligned():
        x0, y0, x1, y1 = calib.crop_box_px(w, h)
        return img.crop((x0, y0, x1, y1))
    out_w, out_h = out_size or calib.natural_size(w, h)
    quad = (
        calib.tl[0] * w, calib.tl[1] * h,
        calib.bl[0] * w, calib.bl[1] * h,
        calib.br[0] * w, calib.br[1] * h,
        calib.tr[0] * w, calib.tr[1] * h,
    )
    return img.transform((out_w, out_h), Image.QUAD, quad, Image.BILINEAR)


# ─── 帧源抽象(W4-6):外部依赖经可注入 source 隔离 ───


class FrameSource(Protocol):
    """UVC 帧源契约:open → read → close,同步(控制器丢线程池)(W4-6)。"""

    def open(self) -> None: ...
    def read(self) -> Image.Image: ...
    def close(self) -> None: ...
    def describe(self) -> dict: ...


class Cv2FrameSource:
    """cv2.VideoCapture 后端(缺省;Windows 经 DirectShow,Linux 经 V4L2)(W4-6)。"""

    def __init__(
        self,
        index: int = 0,
        width: int | None = None,
        height: int | None = None,
        fps: int | None = None,
    ) -> None:
        self.index = index
        self.width = width
        self.height = height
        self.fps = fps
        self._cap = None

    def open(self) -> None:
        try:
            import cv2  # 懒加载:无 cv2 环境导入本模块零代价
        except Exception as e:  # noqa: BLE001
            raise PhysicalError(
                ErrorKind.SCREEN_CAPTURE_FAILED,
                f"cv2 unavailable (UVC capture needs opencv-python): {e}",
            ) from e
        if sys.platform == "win32":
            # DirectShow 后端:MSMF 在部分采集卡上首帧超时(DirectShow 更稳)
            self._cap = cv2.VideoCapture(self.index, cv2.CAP_DSHOW)
        else:
            self._cap = cv2.VideoCapture(self.index)
        if not self._cap.isOpened():
            self._cap.release()
            self._cap = None
            raise PhysicalError(
                ErrorKind.SCREEN_CAPTURE_FAILED,
                f"cv2.VideoCapture({self.index}) cannot open (no UVC device?)",
            )
        if self.width:
            self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        if self.height:
            self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        if self.fps:
            self._cap.set(cv2.CAP_PROP_FPS, self.fps)

    def read(self) -> Image.Image:
        import numpy as np  # cv2 在场 ⇒ numpy 必在场

        if self._cap is None:
            raise PhysicalError(ErrorKind.INTERNAL_ERROR, "capture not opened")
        ok, frame = self._cap.read()
        if not ok or frame is None:
            raise PhysicalError(
                ErrorKind.SCREEN_CAPTURE_FAILED,
                "cv2 read() returned no frame (signal lost?)",
            )
        # cv2_to_rgb 已返回 PIL Image,不得再包 fromarray(双重包装 TypeError,W6 集成修复 D-E1)
        return cv2_to_rgb(frame, np)

    def close(self) -> None:
        if self._cap is not None:
            self._cap.release()
            self._cap = None

    def describe(self) -> dict:
        return {
            "backend": "cv2",
            "index": self.index,
            "opened": self._cap is not None,
        }


def cv2_to_rgb(frame, np) -> "Image.Image":
    """BGR ndarray → RGB PIL(独立成函数便于直接单测色彩通道序)(W4-6)。"""
    from PIL import Image as _Image

    return _Image.fromarray(np.ascontiguousarray(frame[:, :, ::-1]))


class UnsupportedFrameSource:
    """诚实 unsupported:cv2 缺席时的直读替代(remediation 见错误文案)(W4-6)。

    原生 DirectShow(ctypes)需要 IGraphBuilder/SampleGrabber 等数百行 COM
    胶水且无硬件不可验证 —— PoC 拒绝冒险,诚实申报能力边界。
    """

    def __init__(self, reason: str = "cv2 not installed") -> None:
        self.reason = reason

    def open(self) -> None:
        raise PhysicalError(
            ErrorKind.SCREEN_CAPTURE_FAILED,
            f"UVC frame source unavailable: {self.reason}; remediation: "
            "pip install opencv-python (Windows uses DirectShow via cv2), "
            "or inject a custom FrameSource",
        )

    def read(self) -> Image.Image:  # pragma: no cover - open 必炸,不可达
        self.open()
        raise PhysicalError(ErrorKind.INTERNAL_ERROR, "unreachable")

    def close(self) -> None:
        return None

    def describe(self) -> dict:
        return {"backend": "unsupported", "reason": self.reason}


class MockFrameSource:
    """确定性测试帧源:同一 pattern ⇒ 同一帧(dhash 门控的稳定参照)(W4-6)。"""

    PATTERNS = ("gradient", "blocks", "stripes", "flat")

    def __init__(self, width: int = 320, height: int = 240) -> None:
        self.width = max(16, int(width))
        self.height = max(16, int(height))
        self._pattern = "gradient"
        self._reads = 0

    def set_pattern(self, pattern: str) -> None:
        if pattern not in self.PATTERNS:
            raise ValueError(f"unknown mock pattern: {pattern!r}")
        self._pattern = pattern

    def mutate(self) -> None:
        """切到下一 pattern(自测「帧变了 ⇒ 产出」分支的确定性开关)。"""
        self._pattern = self.PATTERNS[(self.PATTERNS.index(self._pattern) + 1) % len(self.PATTERNS)]

    def open(self) -> None:
        self._reads = 0

    def read(self) -> Image.Image:
        import hashlib

        import numpy as np

        self._reads += 1
        w, h = self.width, self.height
        xs = np.arange(w, dtype=np.float64)
        ys = np.arange(h, dtype=np.float64)
        if self._pattern == "flat":
            arr = np.zeros((h, w, 3), dtype=np.uint8)
        elif self._pattern == "blocks":
            arr = np.zeros((h, w, 3), dtype=np.uint8)
            arr[: h // 2, : w // 2] = (220, 40, 40)
            arr[h // 2:, w // 2:] = (40, 40, 220)
        elif self._pattern == "stripes":
            # pattern 名混入哈希:不同 pattern ⇒ 不同条纹相位(确定性)
            seed = int(hashlib.sha256(self._pattern.encode()).hexdigest()[:8], 16)
            phase = seed % 16
            arr = np.tile(((xs + phase) % 16 < 8)[:, None].astype(np.uint8) * 255, (h, 1))
            arr = np.stack([arr, arr, arr], axis=2)
        else:  # gradient
            arr = np.zeros((h, w, 3), dtype=np.uint8)
            arr[:, :, 0] = np.tile((xs / max(1, w - 1) * 255).astype(np.uint8), (h, 1))
            arr[:, :, 1] = np.tile((ys / max(1, h - 1) * 255).astype(np.uint8)[:, None], (1, w))
        return Image.fromarray(arr, mode="RGB")

    def close(self) -> None:
        return None

    def describe(self) -> dict:
        return {
            "backend": "mock",
            "pattern": self._pattern,
            "width": self.width,
            "height": self.height,
            "reads": self._reads,
        }


def resolve_frame_source(cfg: UvcConfig, source: FrameSource | None = None) -> FrameSource:
    """工厂:注入优先 → mock 显式请求 → cv2 可用性探测 → 诚实 unsupported(W4-6)。"""
    if source is not None:
        return source
    if cfg.source_kind == "mock":
        return MockFrameSource(cfg.mock_width, cfg.mock_height)
    try:
        import cv2  # noqa: F401

        return Cv2FrameSource(cfg.device_index, cfg.width, cfg.height, cfg.fps)
    except Exception:  # noqa: BLE001
        return UnsupportedFrameSource("cv2 not importable in current environment")


# ─── UvcController(W4-6):screen.py 同方言的采集控制器 ───


class UvcController:
    """UVC 采集控制器:采集 → 校准 → 门控 → 编码(异步;运行层不抛裸异常)。

    方法形状与 ``ScreenCapture`` 对齐:归一化 region、``gate={dhash_ref,
    distance}`` 变化门控、extras 携带 dhash/unchanged —— 集成时可直接套用
    routes.py 的截图端点模板(见模块头注的注册行)。
    """

    def __init__(
        self,
        config: UvcConfig | None = None,
        source: FrameSource | None = None,
        calibration: Calibration | None = None,
    ) -> None:
        self.cfg = config or UvcConfig()
        self._source: FrameSource | None = source  # None = 首次 capture 时 resolve
        self.calibration = calibration or Calibration.identity()
        self._dry_run = False
        self._opened_at: float | None = None
        self._frames_read = 0

    def set_dry_run(self, dry: bool) -> None:
        self._dry_run = dry

    def set_calibration(self, calib: Calibration | None) -> None:
        """热更新标定(四角标定是运行期手工/自动流程的产物)(W4-6)。"""
        self.calibration = calib or Calibration.identity()

    def _ensure_source(self) -> FrameSource:
        if self._source is None:
            self._source = resolve_frame_source(self.cfg)
        return self._source

    async def open(self) -> dict:
        """打开设备(线程池内执行;失败 ⇒ PhysicalError 信封)(W4-6)。"""
        src = self._ensure_source()
        loop = asyncio.get_running_loop()
        if self._opened_at is None:
            await loop.run_in_executor(None, src.open)
            self._opened_at = time.monotonic()
        return {"opened": True, **src.describe()}

    async def close(self) -> dict:
        if self._source is not None and self._opened_at is not None:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, self._source.close)
        self._opened_at = None
        return {"closed": True}

    async def capture(
        self,
        format: ImageFormat = "png",
        quality: int | None = None,
        region: dict | None = None,
        gate: dict | None = None,
        want_hashes: bool = False,
        max_width: int | None = None,
    ) -> tuple[bytes | None, dict]:
        """采一帧 → 校准 → 门控 → 编码。返回 ``(image_bytes | None, extras)``。

        - ``gate={"dhash_ref": str, "distance": int}``:与 screen.py 同语义,
          汉明距离 ≤ distance ⇒ 帧未变 ``(None, {unchanged: True, dhash})``
          —— HDMI 源静止时不重复产出编码帧(轮询省流量的根基)。
        - ``region``:校准后帧上的归一化 {x, y, width, height}。
        - extras = {dhash, unchanged, width, height, source, calibration}。
        """
        if format not in ("png", "jpeg"):
            raise PhysicalError(
                ErrorKind.INVALID_ARGS,
                f"unsupported format: {format!r} (allowed: png/jpeg)",
            )
        loop = asyncio.get_running_loop()
        src = self._ensure_source()

        def _grab() -> Image.Image:
            if self._opened_at is None:
                src.open()
                self._opened_at = time.monotonic()
            img = src.read()
            self._frames_read += 1
            return rectify(img, self.calibration)

        try:
            clean = await loop.run_in_executor(None, _grab)
        except PhysicalError:
            self._opened_at = None  # 设备态可疑:下次 capture 重新打开
            raise

        extras: dict = {
            "dhash": None, "unchanged": False,
            "width": clean.width, "height": clean.height,
            "source": src.describe(),
            "calibration": {
                "tl": self.calibration.tl, "tr": self.calibration.tr,
                "br": self.calibration.br, "bl": self.calibration.bl,
            },
            "frames_read": self._frames_read,
        }

        if want_hashes or gate:
            extras["dhash"] = compute_dhash(clean)

        if gate and extras["dhash"]:
            ref = str(gate.get("dhash_ref") or "")
            dist = int(gate.get("distance", self.cfg.gate_distance) or 0)
            if ref and hamming_hex(extras["dhash"], ref) <= dist:
                extras["unchanged"] = True
                return None, extras

        def _compose() -> Image.Image:
            img = clean
            if region:
                img = self._crop_region(img, region)
            if max_width and img.width > max_width:
                ratio = max_width / img.width
                img = img.resize((max_width, max(1, int(img.height * ratio))), Image.LANCZOS)
            return img

        img = await loop.run_in_executor(None, _compose)

        def _encode() -> bytes:
            buf = io.BytesIO()
            if format == "jpeg":
                src_img = img.convert("RGB") if img.mode in ("RGBA", "LA", "P") else img
                src_img.save(buf, format="JPEG", quality=quality if quality is not None else self.cfg.jpeg_quality, optimize=True)
            else:
                img.save(buf, format="PNG", optimize=True)
            return buf.getvalue()

        try:
            data = await loop.run_in_executor(None, _encode)
        except Exception as e:  # noqa: BLE001
            raise PhysicalError(ErrorKind.SCREEN_CAPTURE_FAILED, f"image encode failed: {e}") from e
        extras["width"], extras["height"] = img.width, img.height
        return data, extras

    def _crop_region(self, img: Image.Image, region: dict) -> Image.Image:
        """归一化 region 裁剪(校准后帧为基准;方言同 screen._crop_region)(W4-6)。"""
        try:
            x = float(region["x"])
            y = float(region["y"])
            w = float(region["width"])
            h = float(region["height"])
        except (KeyError, TypeError, ValueError) as e:
            raise PhysicalError(ErrorKind.INVALID_ARGS, f"region must be {{x,y,width,height}}: {e}") from e
        for name, v in (("x", x), ("y", y), ("width", w), ("height", h)):
            if not (0.0 <= v <= 1.0):
                raise PhysicalError(ErrorKind.OUT_OF_BOUNDS, f"region.{name} out of [0,1]: {v}")
        iw, ih = img.size
        box = (int(round(x * iw)), int(round(y * ih)), int(round((x + w) * iw)), int(round((y + h) * ih)))
        if box[2] - box[0] < 1 or box[3] - box[1] < 1:
            raise PhysicalError(ErrorKind.INVALID_ARGS, f"region too small after px conversion: {box}")
        return img.crop(box)

    def device_info(self) -> dict:
        """平台/设备信息(platform_info 方言;health 回执用)(W4-6)。"""
        info = {
            "platform": sys.platform,
            "backend": self._source.describe().get("backend", "unresolved") if self._source else "unresolved",
            "source_kind": self.cfg.source_kind,
            "calibrated": self.calibration != Calibration.identity(),
            "frames_read": self._frames_read,
        }
        try:
            import cv2

            info["cv2_version"] = cv2.__version__
        except Exception:  # noqa: BLE001
            info["cv2_version"] = "unavailable"
        return info


# ─── 自测入口(W4-6):python -m dsh_physical.uvc --selftest ───


def _run_selftest() -> int:
    """无硬件自测:校准数学 → 矫正 → mock 管线 → 诚实降级。全过 exit 0。"""
    failures: list[str] = []

    def check(name: str, cond: bool) -> None:
        print(f"[{'PASS' if cond else 'FAIL'}] {name}")
        if not cond:
            failures.append(name)

    # ── 1. 校准数学:恒等 / 轴对齐 / 牛顿逆往返(手算对照)──
    ident = Calibration.identity()
    check("calib identity quad_point(0.25,0.5)==(0.25,0.5)", ident.quad_point(0.25, 0.5) == (0.25, 0.5))
    # 轴对齐手算:四角收进 10% 边距 ⇒ 内容区中心 (0.5,0.5) 仍是 (0.5,0.5),
    # 左上角 (0,0) 映射到采集域 (0.1,0.1)
    shrink = Calibration((0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9))
    check("calib shrink tl == (0.1,0.1)", shrink.quad_point(0.0, 0.0) == (0.1, 0.1))
    check("calib shrink center == (0.5,0.5)", shrink.quad_point(0.5, 0.5) == (0.5, 0.5))
    check("calib shrink is_axis_aligned", shrink.is_axis_aligned())
    # 牛顿逆:轴对齐手算 —— 采集域 (0.74,0.30) ⇒ 屏幕域 (0.8,0.25)
    iu, iv = shrink.inverse_point(0.74, 0.30)
    check("calib inverse roundtrip", abs(iu - 0.8) + abs(iv - 0.25) < 1e-9)
    # 非轴对齐(梯形)往返:数值解 < 1e-6
    trap = Calibration((0.05, 0.0), (0.95, 0.0), (0.85, 1.0), (0.15, 1.0))
    for (uu, vv) in ((0.2, 0.3), (0.8, 0.7), (0.5, 0.5)):
        px, py = trap.quad_point(uu, vv)
        ru, rv = trap.inverse_point(px, py)
        if abs(ru - uu) + abs(rv - vv) > 1e-6:
            check(f"calib trapezoid roundtrip u={uu} v={vv}", False)
            break
    else:
        check("calib trapezoid roundtrip", True)
    check(
        "calib from_params list == identity",
        Calibration.from_params([(0, 0), (1, 0), (1, 1), (0, 1)]) == Calibration.identity(),
    )
    try:
        Calibration((1.2, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))
        check("calib out-of-range corner rejected", False)
    except ValueError:
        check("calib out-of-range corner rejected", True)

    # ── 2. 矫正:位置编码图钉死 PIL QUAD 角序(TL,BL,BR,TR)──
    import numpy as np

    enc = Image.fromarray(
        np.stack(
            [
                np.tile((np.arange(64) * 4).astype(np.uint8), (64, 1)),
                np.tile((np.arange(64) * 4).astype(np.uint8)[:, None], (1, 64)),
                np.zeros((64, 64), dtype=np.uint8),
            ],
            axis=2,
        ),
        mode="RGB",
    )
    inner = Calibration((16 / 64, 16 / 64), (47 / 64, 16 / 64), (47 / 64, 47 / 64), (16 / 64, 47 / 64))
    out = rectify(enc, inner)
    op = out.load()
    check(
        "rectify axis-aligned corners exact",
        op[0, 0] == (64, 64, 0) and op[30, 0] == (184, 64, 0)
        and op[30, 30] == (184, 184, 0) and op[0, 30] == (64, 184, 0),
    )
    rotated = Calibration((16 / 64, 47 / 64), (16 / 64, 16 / 64), (47 / 64, 16 / 64), (47 / 64, 47 / 64))
    # 左下为内容区「左上」的 90° 旋转源:矫正后 (0,0) 应取到源 (16,47)
    out2 = rectify(enc, rotated)
    op2 = out2.load()
    check("rectify rotated quad origin", op2[0, 0] == (64, 184, 0))

    # ── 3. mock 管线:采集 → 校准 → 编码 → dhash 门控 ──
    async def _pipeline() -> tuple[bool, bool, bool, bool, bool, bool]:
        mock = MockFrameSource(320, 240)
        ctrl = UvcController(UvcConfig(source_kind="mock"), source=mock)
        data, extras = await ctrl.capture(want_hashes=True)
        ok_png = data is not None and data[:8] == b"\x89PNG\r\n\x1a\n" and extras["width"] == 320
        ok_hash = isinstance(extras["dhash"], str) and len(extras["dhash"]) == 16
        # 门控:同一帧(dhash 未变)⇒ 不重复产出
        data2, extras2 = await ctrl.capture(gate={"dhash_ref": extras["dhash"], "distance": 0})
        gated = data2 is None and extras2["unchanged"] is True
        # 帧变了(mutate)⇒ 产出
        mock.mutate()
        data3, extras3 = await ctrl.capture(gate={"dhash_ref": extras["dhash"], "distance": 0})
        regenerated = data3 is not None and extras3["unchanged"] is False
        # JPEG + region + 过扫描裁剪
        data4, extras4 = await ctrl.capture(
            format="jpeg", region={"x": 0.0, "y": 0.0, "width": 0.5, "height": 0.5},
        )
        ok_jpeg = data4 is not None and data4[:3] == b"\xff\xd8\xff" and extras4["width"] == 160
        ctrl.set_calibration(Calibration((0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9)))
        data5, extras5 = await ctrl.capture()
        ok_crop = data5 is not None and (extras5["width"], extras5["height"]) == (256, 192)
        return ok_png, ok_hash, gated, regenerated, ok_jpeg, ok_crop

    png_ok, hash_ok, gated_ok, regen_ok, jpeg_ok, crop_ok = asyncio.run(_pipeline())
    check("mock capture png bytes", png_ok)
    check("mock dhash 16-hex", hash_ok)
    check("gate: same frame -> unchanged, no bytes", gated_ok)
    check("gate: mutated frame -> regenerated", regen_ok)
    check("jpeg header + region crop", jpeg_ok)
    check("overscan calibration crops to 256x192", crop_ok)

    # ── 4. 诚实降级:cv2 缺席 ⇒ UnsupportedFrameSource 给 remediation ──
    try:
        import cv2  # noqa: F401

        print("[SKIP] cv2 present: unsupported-path skipped (factory will use cv2)")
        degraded_ok = True
    except Exception:  # noqa: BLE001
        src = resolve_frame_source(UvcConfig(source_kind="auto"))
        try:
            src.open()
            degraded_ok = False
        except PhysicalError as e:
            degraded_ok = e.kind is ErrorKind.SCREEN_CAPTURE_FAILED and "opencv-python" in e.detail
    check("honest unsupported when cv2 absent", degraded_ok)

    print(f"\nuvc selftest: {'OK' if not failures else 'FAILED: ' + '; '.join(failures)}")
    return 0 if not failures else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(_run_selftest())
    if "--selftest-real" in sys.argv:
        # W9-4 真机实证探针入口:本模块逻辑零侵入,委托 real_probe.py
        # (枚举 DirectShow 设备 → 真帧过校准/门控/编码全管线,证据落 JSON)。
        import pathlib as _pl

        _svc_root = _pl.Path(__file__).resolve().parent.parent
        if str(_svc_root) not in sys.path:
            sys.path.insert(0, str(_svc_root))
        from real_probe import run_debt_probe

        raise SystemExit(run_debt_probe("D-A1"))
    print("usage: python -m dsh_physical.uvc --selftest | --selftest-real")
    raise SystemExit(2)
