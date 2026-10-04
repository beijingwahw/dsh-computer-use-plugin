"""UVC 四角校准数学离线单测(ΑΩ-R32)。

双线性四边形正向映射 + 2×2 牛顿逆映射 + 轴对齐直裁/QUAD 矫正 ——
全部纯函数;rectify 用确定性位置编码图(无采集卡/无摄像头)。
"""
import sys
from pathlib import Path

# ΑΩ-R32:discover 以本目录为 top-level,注入 python_service/(dsh_physical 所在目录)
_SVC_ROOT = str(Path(__file__).resolve().parents[1])
if _SVC_ROOT not in sys.path:
    sys.path.insert(0, _SVC_ROOT)

import unittest  # noqa: E402

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from dsh_physical.errors import ErrorKind, PhysicalError  # noqa: E402
from dsh_physical.uvc import Calibration, rectify  # noqa: E402

# 10% 边距的过扫描标定(轴对齐手算基准)
SHRINK = Calibration((0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9))
# 梯形畸变标定(非轴对齐 —— QUAD 矫正路径)
TRAPEZOID = Calibration((0.05, 0.0), (0.95, 0.0), (0.85, 1.0), (0.15, 1.0))


class CalibrationMathTests(unittest.TestCase):
    """双线性四边形数学:恒等/手算点/雅可比逆映射。"""

    def test_identity_mapping(self):
        ident = Calibration.identity()
        self.assertEqual(ident.quad_point(0.25, 0.5), (0.25, 0.5))
        self.assertEqual(ident.quad_point(0.0, 1.0), (0.0, 1.0))
        self.assertEqual(ident.quad_point(1.0, 1.0), (1.0, 1.0))
        self.assertTrue(ident.is_axis_aligned())

    def test_shrink_corners_and_center_hand_computed(self):
        # 屏幕域四角 → 采集域:内容区左上 (0,0) → (0.1,0.1);中心对称不动
        self.assertEqual(SHRINK.quad_point(0.0, 0.0), (0.1, 0.1))
        self.assertEqual(SHRINK.quad_point(1.0, 0.0), (0.9, 0.1))
        self.assertEqual(SHRINK.quad_point(1.0, 1.0), (0.9, 0.9))
        self.assertEqual(SHRINK.quad_point(0.0, 1.0), (0.1, 0.9))
        self.assertEqual(SHRINK.quad_point(0.5, 0.5), (0.5, 0.5))
        self.assertTrue(SHRINK.is_axis_aligned())
        self.assertFalse(TRAPEZOID.is_axis_aligned())

    def test_inverse_axis_aligned_hand_computed(self):
        # 采集域 (0.74,0.30) ⇒ 屏幕域 (0.8,0.25)(u=(x-0.1)/0.8 线性手算)
        iu, iv = SHRINK.inverse_point(0.74, 0.30)
        self.assertAlmostEqual(iu, 0.8, places=9)
        self.assertAlmostEqual(iv, 0.25, places=9)

    def test_inverse_trapezoid_roundtrip(self):
        # 非轴对齐:牛顿迭代数值解,正逆往返误差 < 1e-6
        for u, v in ((0.2, 0.3), (0.8, 0.7), (0.5, 0.5), (0.0, 0.0), (1.0, 1.0)):
            px, py = TRAPEZOID.quad_point(u, v)
            ru, rv = TRAPEZOID.inverse_point(px, py)
            self.assertLess(abs(ru - u) + abs(rv - v), 1e-6, f"roundtrip at ({u},{v})")

    def test_from_params_forms_and_range_guard(self):
        # 四元素列表与 dict 两形态;恒等 == 全帧
        self.assertEqual(
            Calibration.from_params([(0, 0), (1, 0), (1, 1), (0, 1)]),
            Calibration.identity(),
        )
        self.assertEqual(
            Calibration.from_params(
                {"tl": {"x": 0, "y": 0}, "tr": {"x": 1, "y": 0},
                 "br": {"x": 1, "y": 1}, "bl": {"x": 0, "y": 1}}
            ),
            Calibration.identity(),
        )
        # 角点越界 [0,1] → 构造期拒绝(加载层语义)
        with self.assertRaises(ValueError):
            Calibration((1.2, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))
        with self.assertRaises(ValueError):
            Calibration((0.0, -0.1), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))
        with self.assertRaises(ValueError):
            Calibration.from_params({"tl": "bad", "tr": {}, "br": {}, "bl": {}})

    def test_crop_box_and_natural_size(self):
        # 轴对齐 → 整数像素裁剪框(10% 边距 × 1000x500)
        self.assertEqual(SHRINK.crop_box_px(1000, 500), (100, 50, 900, 450))
        # 矫正输出自然尺寸 = 标定区像素跨度(保持 1:1 采样密度)
        self.assertEqual(SHRINK.natural_size(1000, 1000), (800, 800))
        self.assertEqual(Calibration.identity().natural_size(640, 480), (640, 480))
        # 退化标定(面积 → 0)→ INVALID_ARGS 信封
        degenerate = Calibration((0.5, 0.5), (0.5, 0.5), (0.5, 0.5), (0.5, 0.5))
        with self.assertRaises(PhysicalError) as ctx:
            degenerate.crop_box_px(100, 100)
        self.assertIs(ctx.exception.kind, ErrorKind.INVALID_ARGS)


class RectifyTests(unittest.TestCase):
    """矫正执行:直裁零重采样 + PIL QUAD 角序(TL,BL,BR,TR)。"""

    @staticmethod
    def _encoded() -> Image.Image:
        # ΑΩ-R32:位置编码图 R=x*4 / G=y*4 —— 每像素自证来源坐标
        ramp = (np.arange(64) * 4).astype(np.uint8)
        return Image.fromarray(
            np.stack(
                [np.tile(ramp, (64, 1)), np.tile(ramp[:, None], (1, 64)), np.zeros((64, 64), np.uint8)],
                axis=2,
            ),
            mode="RGB",
        )

    def test_axis_aligned_crop_exact_source_pixels(self):
        inner = Calibration((16 / 64, 16 / 64), (47 / 64, 16 / 64), (47 / 64, 47 / 64), (16 / 64, 47 / 64))
        out = rectify(self._encoded(), inner)
        self.assertEqual(out.size, (31, 31))
        op = out.load()
        # 直裁必须零重采样:四角取到精确源像素(16*4=64,47*4=188 附近列)
        self.assertEqual(op[0, 0], (64, 64, 0))
        self.assertEqual(op[30, 0], (184, 64, 0))
        self.assertEqual(op[30, 30], (184, 184, 0))
        self.assertEqual(op[0, 30], (64, 184, 0))

    def test_rotated_quad_corner_order_pinned(self):
        # 钉死 PIL Image.QUAD 数据序 = (tl, bl, br, tr):
        # 90° 旋转源(左下角为内容区「左上」)矫正后原点应取到源 (16,47) → G=188
        rotated = Calibration((16 / 64, 47 / 64), (16 / 64, 16 / 64), (47 / 64, 16 / 64), (47 / 64, 47 / 64))
        out = rectify(self._encoded(), rotated)
        self.assertEqual(out.load()[0, 0], (64, 184, 0))

    def test_identity_rectify_returns_full_frame(self):
        enc = self._encoded()
        out = rectify(enc, Calibration.identity())
        self.assertEqual(out.size, enc.size)
        # ΑΩ-R32:用 tobytes 全量逐字节对照(恒等矫正 = 零修改全帧)
        self.assertEqual(out.tobytes(), enc.tobytes())


if __name__ == "__main__":
    unittest.main()
