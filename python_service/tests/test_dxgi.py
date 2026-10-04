"""ΝΩ-51 DXGI Desktop Duplication backend 离线单测。

零外部 fixture、零显示器依赖：COM 结构体布局（ABI 锚点）/GUID 字节序/
BGRA→RGB 转换/脏区归一化/hr 分类/配置项/backend 分流三态（gdi 零变化、
dxgi 成功 meta 透出、dxgi 失败诚实降级）。vtable 槽位表以「对抗记忆修正」
的核对值钉死（IDXGIOutputDuplication::ReleaseFrame 在 14 而非 9 ——
见 dxgi_capture.py 模块头注）。
"""
import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

# 与 test_screen.py 同律：注入 python_service/ 使 dsh_physical 可导入
_SVC_ROOT = str(Path(__file__).resolve().parents[1])
if _SVC_ROOT not in sys.path:
    sys.path.insert(0, _SVC_ROOT)

import ctypes  # noqa: E402

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from dsh_physical import dxgi_capture as dc  # noqa: E402
from dsh_physical.config import ScreenshotConfig, load_config_from_env  # noqa: E402
from dsh_physical.errors import ErrorKind, PhysicalError  # noqa: E402
from dsh_physical.screen import ScreenCapture, compute_dhash  # noqa: E402


class AbiStructLayoutTests(unittest.TestCase):
    """COM 结构体 sizeof/offset —— mingw-w64 头核对值（布局漂移第一哨）。"""

    def test_frame_info_size_and_offsets(self):
        # DXGI_OUTDUPL_FRAME_INFO：8+8+4+4+1(+3 垫)+12+4+4 = 48（x86/x64 同值）
        self.assertEqual(ctypes.sizeof(dc._FrameInfo), 48)
        self.assertEqual(dc._FrameInfo.PointerPosition.offset, 28)
        self.assertEqual(dc._FrameInfo.TotalMetadataBufferSize.offset, 40)

    def test_move_rect_and_outdupl_desc_size(self):
        self.assertEqual(ctypes.sizeof(dc._OutduplMoveRect), 24)
        self.assertEqual(ctypes.sizeof(dc._OutduplDesc), 36)

    def test_texture2d_desc_and_mapped_subresource_size(self):
        # 11×UINT 族（5 基础 + SampleDesc 2 + 4 标志）= 44
        self.assertEqual(ctypes.sizeof(dc._Tex2DDesc), 44)
        self.assertEqual(
            ctypes.sizeof(dc._MappedSubresource),
            ctypes.sizeof(ctypes.c_void_p) + 8,
        )

    def test_vtable_slots_pinned(self):
        # 对抗记忆修正的核对值（见模块头注）——任何人「顺手改对」都要先过这里
        self.assertEqual(dc._VTBL["output1_duplicate_output"], 22)
        self.assertEqual(dc._VTBL["dupl_acquire_next_frame"], 8)
        self.assertEqual(dc._VTBL["dupl_get_frame_dirty_rects"], 9)
        self.assertEqual(dc._VTBL["dupl_release_frame"], 14)  # 末位，非 AcquireNextFrame 邻位
        self.assertEqual(dc._VTBL["ctx_copy_resource"], 47)
        self.assertEqual(dc._VTBL["device_create_texture2d"], 5)
        self.assertEqual(dc._VTBL["device_get_immediate_context"], 40)
        self.assertEqual(dc._VTBL["ctx_map"], 14)
        self.assertEqual(dc._VTBL["ctx_unmap"], 15)
        self.assertEqual(dc._VTBL["tex2d_get_desc"], 10)


class GuidLayoutTests(unittest.TestCase):
    """IID 字符串 → Windows 内存布局（Data1/2/3 小端 + Data8 原序）。"""

    def test_guid_bytes_matches_windows_layout(self):
        # IID_IDXGIFactory1 {770aae78-f26f-4dba-a829-253c83d1b387}：
        # Data1=0x770aae78 → 78 ae 0a 77；Data2=0xf26f → 6f f2；Data3=0x4dba → ba 4d；
        # Data4 原序 a8 29 25 3c 83 d1 b3 87
        self.assertEqual(
            dc.guid_bytes("770aae78-f26f-4dba-a829-253c83d1b387"),
            bytes.fromhex("78ae0a77" "6ff2" "ba4d" "a829253c83d1b387"),
        )

    def test_all_module_iids_roundtrip(self):
        for g in (dc.IID_IDXGIFACTORY1, dc.IID_IDXGIOUTPUT1, dc.IID_ID3D11TEXTURE2D):
            self.assertEqual(len(dc.guid_bytes(g)), 16)

    def test_null_pointer_rejected_honestly(self):
        with self.assertRaises(PhysicalError):
            dc._vtbl_fn(0, 2, dc._P_Release)


class BgraConversionTests(unittest.TestCase):
    """staging Map 行缓冲 → RGB PIL（stride/通道序/alpha 剥离/防御式几何）。"""

    def test_stride_and_channel_order(self):
        # 2x2 图 pitch=16（每行 8B 像素 + 8B 行尾填充）：BGR 通道 → RGB 反序，
        # alpha 丢弃，行尾填充绝不渗入像素（stride 语义）
        px = lambda b, g, r: bytes([b, g, r, 255])
        raw = px(10, 20, 30) + px(40, 50, 60) + b"\xAA" * 8 \
            + px(70, 80, 90) + px(100, 110, 120) + b"\xBB" * 8
        img = dc.bgra_to_rgb_image(raw, 2, 2, 16)
        self.assertEqual(img.mode, "RGB")
        self.assertEqual(img.size, (2, 2))
        self.assertEqual(img.getpixel((0, 0)), (30, 20, 10))
        self.assertEqual(img.getpixel((1, 0)), (60, 50, 40))
        self.assertEqual(img.getpixel((0, 1)), (90, 80, 70))
        self.assertEqual(img.getpixel((1, 1)), (120, 110, 100))
        self.assertNotIn(
            (0xAA, 0xAA, 0xAA),
            [img.getpixel((x, y)) for y in range(2) for x in range(2)],
        )

    def test_dialect_same_as_gdi_path(self):
        # 与 GDI 路径输出同方言：RGB PIL Image，灰度化指纹可计算（dhash 长度合法）
        w = h = 9
        raw = bytes(i % 251 for i in range(w * 4 * h))
        img = dc.bgra_to_rgb_image(raw, w, h, w * 4)
        self.assertRegex(compute_dhash(img), r"^[0-9a-f]{16}$")

    def test_bad_geometry_raises_value_error(self):
        with self.assertRaises(ValueError):
            dc.bgra_to_rgb_image(b"\x00" * 16, 8, 1, 8 * 4)  # pitch*height 越界
        with self.assertRaises(ValueError):
            dc.bgra_to_rgb_image(b"", 0, 0, 0)  # 零尺寸


class DirtyRectTests(unittest.TestCase):
    """脏区/移动矩形解析与归一化（frame_diff 方言对齐）。"""

    def test_parse_move_and_dirty_rects_stride(self):
        import struct

        mv = struct.pack("<6i", 7, 8, 0, 0, 64, 32) + struct.pack("<6i", 0, 0, 10, 10, 20, 40)
        self.assertEqual(dc._parse_move_rects(mv), [(0, 0, 64, 32), (10, 10, 20, 40)])
        dr = struct.pack("<4i", 1, 2, 3, 4) + struct.pack("<4i", 5, 6, 7, 8) + b"\xff" * 7
        self.assertEqual(dc._parse_dirty_rects(dr), [(1, 2, 3, 4), (5, 6, 7, 8)])  # 尾部残字节忽略

    def test_normalize_clamps_and_drops_degenerate(self):
        norm = dc.normalize_dirty_rects(
            [(-8, -8, 100, 50), (10, 10, 11, 11), (0, 0, 200, 100), (300, 300, 400, 400)],
            200, 100,
        )
        # 全出界丢弃、部分出界夹取、按面积降序；1x1 像素矩形**不**算零面积
        self.assertEqual(
            norm,
            [
                {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
                {"x": 0.0, "y": 0.0, "width": 0.5, "height": 0.5},
                {"x": 0.05, "y": 0.1, "width": 0.005, "height": 0.01},
            ],
        )
        # 真零面积（clamp 后空）丢弃
        self.assertEqual(
            dc.normalize_dirty_rects([(50, 50, 50, 50)], 200, 100),
            [],
        )

    def test_normalize_cap(self):
        rects = [(i, i, i + 2, i + 2) for i in range(0, 100, 2)]
        self.assertEqual(len(dc.normalize_dirty_rects(rects, 200, 100, cap=4)), 4)

    def test_normalize_empty(self):
        self.assertEqual(dc.normalize_dirty_rects([], 100, 100), [])


class HrNameTests(unittest.TestCase):
    """HRESULT 分类（诚实信封 detail 用的可读名）。"""

    def test_known(self):
        self.assertEqual(dc.hr_name(dc.DXGI_ERROR_WAIT_TIMEOUT), "DXGI_ERROR_WAIT_TIMEOUT")
        self.assertEqual(dc.hr_name(dc.DXGI_ERROR_ACCESS_LOST), "DXGI_ERROR_ACCESS_LOST")
        self.assertEqual(
            dc.hr_name(dc.DXGI_ERROR_SESSION_DISCONNECTED),
            "DXGI_ERROR_SESSION_DISCONNECTED",
        )
        self.assertEqual(dc.hr_name(dc.E_ACCESSDENIED), "E_ACCESSDENIED")
        self.assertEqual(dc.hr_name(0), "S_OK")

    def test_unknown_hex(self):
        self.assertEqual(dc.hr_name(0x12345678), "0x12345678")


class BackendConfigTests(unittest.TestCase):
    """ΝΩ-51 配置项：缺省 gdi（零回归）+ 显式 dxgi + 非法值加载层拒绝。"""

    def test_default_gdi(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith("DSH_PHYSICAL_")}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(load_config_from_env().screenshot.backend, "gdi")
            self.assertEqual(load_config_from_env().screenshot.dxgi_acquire_timeout_ms, 0)

    def test_dxgi_selected_and_timeout(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith("DSH_PHYSICAL_")}
        env["DSH_PHYSICAL_SHOT_BACKEND"] = "dxgi"
        env["DSH_PHYSICAL_DXGI_TIMEOUT_MS"] = "17"
        with mock.patch.dict(os.environ, env, clear=True):
            cfg = load_config_from_env().screenshot
            self.assertEqual(cfg.backend, "dxgi")
            self.assertEqual(cfg.dxgi_acquire_timeout_ms, 17)

    def test_invalid_backend_rejected_at_load(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith("DSH_PHYSICAL_")}
        env["DSH_PHYSICAL_SHOT_BACKEND"] = "directdraw"
        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(ValueError):
                load_config_from_env()


class BackendDispatchTests(unittest.TestCase):
    """screen.py 分流三态 —— dxgi 模块不触 COM（monkeypatch 注入帧/失败）。"""

    @staticmethod
    def _synthetic() -> Image.Image:
        rng = np.random.RandomState(7)
        return Image.fromarray(rng.randint(0, 256, size=(96, 128, 3)).astype(np.uint8))

    def test_default_backend_never_touches_dxgi(self):
        def _sentinel():
            raise AssertionError("dxgi must not be touched when backend=gdi")

        ctrl = ScreenCapture(ScreenshotConfig())
        ctrl._grab_dxgi_frame = _sentinel  # type: ignore[assignment]
        with mock.patch.dict(os.environ, {"DSH_PHYSICAL_TEST_SCREEN": "1"}):
            _h, extras = asyncio.run(ctrl.capture(want_hashes=True, meta_only=True))
        self.assertNotIn("dxgi", extras)
        self.assertNotIn("note", extras)
        self.assertRegex(extras["dhash"], r"^[0-9a-f]{16}$")

    def test_dxgi_success_meta_surfaced_and_pipeline_intact(self):
        injected = self._synthetic()
        meta = {"backend": "dxgi", "width": 128, "height": 96, "fresh": True,
                "dirty_rects": [{"x": 0.0, "y": 0.0, "width": 1.0, "height": 0.5}],
                "move_count": 2, "cursor": False}
        ctrl = ScreenCapture(ScreenshotConfig(backend="dxgi"))
        ctrl._grab_dxgi_frame = lambda: (injected, None, meta)  # type: ignore[assignment]
        _h, extras = asyncio.run(ctrl.capture(want_hashes=True, meta_only=True))
        self.assertEqual(extras["dxgi"], meta)
        self.assertNotIn("note", extras)
        # 帧确实流经既有管线（指纹 = 注入帧的指纹）
        self.assertEqual(extras["dhash"], compute_dhash(injected))

    def test_dxgi_failure_degrades_to_gdi_with_honest_note(self):
        ctrl = ScreenCapture(ScreenshotConfig(backend="dxgi"))
        ctrl._grab_dxgi_frame = lambda: (  # type: ignore[assignment]
            None, "dxgi DuplicateOutput: E_ACCESSDENIED; degraded to gdi", None)
        with mock.patch.dict(os.environ, {"DSH_PHYSICAL_TEST_SCREEN": "1"}):
            try:
                import pyautogui as pag
                ctx = mock.patch.object(pag, "screenshot", side_effect=RuntimeError("forced"))
            except ImportError:
                ctx = mock.patch.dict(os.environ, {"DSH_PHYSICAL_TEST_SCREEN": "1"})
            with ctx:
                _h, extras = asyncio.run(ctrl.capture(want_hashes=True, meta_only=True))
        self.assertIn("degraded to gdi", extras.get("note", ""))
        self.assertNotIn("dxgi", extras)
        self.assertRegex(extras["dhash"], r"^[0-9a-f]{16}$")  # GDI 降级帧仍交付

    def test_capture_image_region_crop_applies_to_dxgi_frame(self):
        # dxgi 成功后 region 裁剪照旧（下游方言不变）
        injected = Image.new("RGB", (100, 100), (1, 2, 3))
        ctrl = ScreenCapture(ScreenshotConfig(backend="dxgi"))
        ctrl._grab_dxgi_frame = (  # type: ignore[assignment]
            lambda: (injected, None, {"backend": "dxgi"}))
        meta: dict = {}
        out = ctrl._capture_image({"x": 0.2, "y": 0.2, "width": 0.5, "height": 0.5},
                                  None, meta)
        self.assertEqual(out.size, (50, 50))
        self.assertEqual(meta.get("backend"), "dxgi")

    def test_grab_dxgi_frame_translates_physical_error(self):
        # 真实 dxgi_capture 抛 PhysicalError ⇒ (None, 原因, None)，绝不裸抛
        ctrl = ScreenCapture(ScreenshotConfig(backend="dxgi"))
        with mock.patch(
            "dsh_physical.dxgi_capture.get_grabber",
            side_effect=PhysicalError(ErrorKind.SCREEN_CAPTURE_FAILED, "boom"),
        ):
            img, degraded, meta = ctrl._grab_dxgi_frame()
        self.assertIsNone(img)
        self.assertIsNone(meta)
        self.assertIn("boom", degraded)
        self.assertIn("degraded to gdi", degraded)

    def test_grab_dxgi_frame_survives_raw_exception(self):
        # 连裸异常也不许穿透（运行层铁律的兜底分句）
        ctrl = ScreenCapture(ScreenshotConfig(backend="dxgi"))
        with mock.patch(
            "dsh_physical.dxgi_capture.get_grabber",
            side_effect=ZeroDivisionError("wild"),
        ):
            img, degraded, meta = ctrl._grab_dxgi_frame()
        self.assertIsNone(img)
        self.assertIn("ZeroDivisionError", degraded)


class GrabberLogicTests(unittest.TestCase):
    """grabber 会话管理纯逻辑（不触 COM）。"""

    def test_session_close_is_idempotent_and_safe(self):
        s = dc._DxgiSession()  # 未 create —— 全 None 指针
        s.close()
        s.close()  # 幂等，不抛

    def test_probe_backend_on_nonwin32_reports_honestly(self):
        # 非 win32：create 诚实 PhysicalError ⇒ probe ok=False（不炸）
        if sys.platform == "win32":
            self.skipTest("win32 真机走 selftest dxci 探针")
        probe = dc.probe_backend()
        self.assertFalse(probe["ok"])
        self.assertIn("requires win32", probe["reason"])


if __name__ == "__main__":
    unittest.main()
