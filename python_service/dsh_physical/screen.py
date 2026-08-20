"""截屏 —— shm 优先 → mmap-file → base64 降级链。

依赖说明：
  - macOS：``pyautogui.screenshot()``（基于 PyObjC ApplicationServices）
  - Windows：``pyautogui.screenshot()``（基于 DWM API）
  - Linux：``pyautogui.screenshot()``（基于 scrot / ImageMagick；需 X server）
    - 无 X 时降级到 Xvfb 虚拟屏（容器场景）
    - 完全无显示时 ``raise`` → 转为 ``SCREEN_CAPTURE_FAILED``

输出格式：
  - ``PNG``（缺省）：无损，适合 OCR / VLM 分析；体积大
  - ``JPEG``：有损，适合网络传输；``quality`` 来自配置

裁剪窗（``region`` 参数）：
  - 归一化坐标 [0,1]×[0,1] 的左上角与宽高
  - 缺省 = 全屏
"""
from __future__ import annotations

import asyncio
import io
import os
import sys
import time
from typing import Literal

from PIL import Image

from .config import ScreenshotConfig
from .errors import ErrorKind, PhysicalError
from .shm import ShmHandle, make_handle

ImageFormat = Literal["png", "jpeg"]


class ScreenCapture:
    """屏幕截图控制器。

    所有方法异步；运行层永不抛错（异常由 ``safe_call`` 转失败响应）。
    """

    def __init__(self, config: ScreenshotConfig) -> None:
        self.cfg = config
        self._dry_run = False

    def set_dry_run(self, dry: bool) -> None:
        self._dry_run = dry

    async def capture(
        self,
        format: ImageFormat = "png",
        quality: int | None = None,
        region: dict | None = None,
    ) -> ShmHandle:
        """截屏并写入共享内存通道。

        ``region`` 格式：``{ x: float, y: float, width: float, height: float }``
        全部归一化 [0,1]；缺省 = 全屏。
        """
        if format not in ("png", "jpeg"):
            raise PhysicalError(
                ErrorKind.INVALID_ARGS,
                f"unsupported format: {format!r} (allowed: png/jpeg)",
            )

        # 在线程池中跑 PIL（避免阻塞事件循环）
        loop = asyncio.get_running_loop()

        def _capture_to_bytes() -> tuple[bytes, int, int]:
            # pyautogui.screenshot 是同步调用
            try:
                import pyautogui

                img = pyautogui.screenshot()
            except Exception as e:  # noqa: BLE001
                # 测试降级：DSH_PHYSICAL_TEST_SCREEN=1 时返回合成图（无显示环境集成测试用）
                if os.environ.get("DSH_PHYSICAL_TEST_SCREEN") == "1":
                    img = self._synthetic_test_image()
                else:
                    raise PhysicalError(
                        ErrorKind.SCREEN_CAPTURE_FAILED,
                        f"pyautogui.screenshot failed: {e}",
                    ) from e

            # 裁剪
            if region:
                img = self._crop_region(img, region)

            # 转 PNG / JPEG 字节
            buf = io.BytesIO()
            if format == "jpeg":
                # JPEG 不支持 RGBA → 转 RGB
                if img.mode in ("RGBA", "LA", "P"):
                    img = img.convert("RGB")
                q = quality if quality is not None else self.cfg.jpeg_quality
                img.save(buf, format="JPEG", quality=q, optimize=True)
                mime_format = "JPEG"
            else:
                img.save(buf, format="PNG", optimize=True)
                mime_format = "PNG"

            return buf.getvalue(), img.width, img.height

        try:
            image_bytes, width, height = await loop.run_in_executor(None, _capture_to_bytes)
        except PhysicalError:
            raise  # 透传受控错误
        except Exception as e:  # noqa: BLE001
            raise PhysicalError(
                ErrorKind.SCREEN_CAPTURE_FAILED,
                f"image encode failed: {e}",
            ) from e

        # 写入共享内存通道
        return make_handle(
            image_bytes,
            width,
            height,
            format=format.upper(),
            config=self.cfg,
        )

    def _crop_region(self, img: Image.Image, region: dict) -> Image.Image:
        """裁剪归一化 region → 像素坐标 box。"""
        try:
            x = float(region["x"])
            y = float(region["y"])
            w = float(region["width"])
            h = float(region["height"])
        except (KeyError, TypeError, ValueError) as e:
            raise PhysicalError(
                ErrorKind.INVALID_ARGS,
                f"region must be {{x,y,width,height}}: {e}",
            ) from e

        for name, v in (("x", x), ("y", y), ("width", w), ("height", h)):
            if not (0.0 <= v <= 1.0):
                raise PhysicalError(
                    ErrorKind.OUT_OF_BOUNDS,
                    f"region.{name} out of [0,1]: {v}",
                )
        if x + w > 1.0 + 1e-6 or y + h > 1.0 + 1e-6:
            raise PhysicalError(
                ErrorKind.OUT_OF_BOUNDS,
                f"region extends beyond screen: x+w={x + w}, y+h={y + h}",
            )

        iw, ih = img.size
        box = (
            int(round(x * iw)),
            int(round(y * ih)),
            int(round((x + w) * iw)),
            int(round((y + h) * ih)),
        )
        # box 宽高至少 1px
        if box[2] - box[0] < 1 or box[3] - box[1] < 1:
            raise PhysicalError(
                ErrorKind.INVALID_ARGS,
                f"region too small after pixel conversion: {box}",
            )
        return img.crop(box)

    async def get_screen_size(self) -> dict:
        """获取屏幕尺寸。"""
        try:
            import pyautogui

            size = await asyncio.get_running_loop().run_in_executor(
                None, lambda: pyautogui.size()
            )
            return {"width": int(size.width), "height": int(size.height)}
        except Exception as e:  # noqa: BLE001
            if os.environ.get("DSH_PHYSICAL_TEST_SCREEN") == "1":
                return {"width": 128, "height": 128}
            raise PhysicalError(
                ErrorKind.SCREEN_CAPTURE_FAILED,
                f"get_screen_size failed: {e}",
            ) from e

    def _synthetic_test_image(self) -> Image.Image:
        """测试降级图：128x128 RGB，左上 64x64 红块、右下 64x64 蓝块、其余黑。

        仅当 DSH_PHYSICAL_TEST_SCREEN=1 且 pyautogui 不可用时启用；
        用于无 X server 环境下的集成测试（不进入生产路径）。
        """
        import numpy as np

        arr = np.zeros((128, 128, 3), dtype=np.uint8)
        arr[0:64, 0:64] = [255, 0, 0]   # 左上红块
        arr[64:128, 64:128] = [0, 0, 255]  # 右下蓝块
        return Image.fromarray(arr, mode="RGB")
