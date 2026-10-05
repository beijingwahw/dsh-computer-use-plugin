"""视觉指纹 dhash / phash 离线单测(ΑΩ-R32)。

与 Node 端 perceptualHash.ts 语义对齐的已知值:平图 → 全零 dhash;
bit 排布 row*8+col 行主序逐位手算;phash DC 排除 ⇒ 亮度不变性。
确定性合成图,零外部 fixture。
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

from dsh_physical.screen import (  # noqa: E402
    compute_dhash,
    compute_phash,
    compute_salience,
    hamming_hex,
)


def _structured_pattern() -> Image.Image:
    # ΑΩ-R32:固定种子的结构化图(频谱丰富 —— phash 中位阈值稳健的载体)
    rng = np.random.RandomState(42)
    return Image.fromarray(rng.randint(0, 120, size=(64, 64, 3)).astype(np.uint8))


class DhashTests(unittest.TestCase):
    """dHash:9x8 灰度水平梯度 → 64bit。"""

    def test_flat_image_zero_hash(self):
        # TS 对齐已知值:无横向梯度 → 全零(等价 Node 端断言 '0'.repeat(64))
        flat = Image.new("RGB", (64, 64), (128, 128, 128))
        self.assertEqual(compute_dhash(flat), "0" * 16)

    def test_bit_layout_hand_computed(self):
        # 9x8 直接喂入(resize 恒等):每字节 = 一行的 8 个列比较
        row = bytes([16, 240, 16, 240, 16, 240, 16, 240, 99])
        img = Image.frombytes("L", (9, 8), row * 8)
        # bit = 1 << col 当 px[col] > px[col+1]:置位 col 1,3,5,7 → 0xAA
        self.assertEqual(compute_dhash(img), "a" * 16)
        # 行差异图:bit0,2,4,6,7 置位 → 0xD5 行(钉死行主序 row*8+col 排布)
        rows = b"".join(bytes([10 * (r + 1) + 5, 10 * (r + 1)] * 4 + [0]) for r in range(8))
        self.assertEqual(compute_dhash(Image.frombytes("L", (9, 8), rows)), "d5" * 8)

    def test_ladder_known_value(self):
        # 左 128 / 右 248 亮度阶梯:resize 平滑后每行恰 2 bit 翻转 → 0x24 行
        arr = np.full((64, 64, 3), 128, dtype=np.uint8)
        arr[:, 32:] = 248
        step = compute_dhash(Image.fromarray(arr))
        self.assertEqual(step, "24" * 8)
        self.assertEqual(hamming_hex("0" * 16, step), 16)

    def test_determinism_and_format(self):
        img = _structured_pattern()
        h = compute_dhash(img)
        self.assertRegex(h, r"^[0-9a-f]{16}$")
        self.assertEqual(compute_dhash(img), h)
        # 同图不同颜色通道携带等亮度 → 灰度化后同指纹
        twin = img.convert("L").convert("RGB")
        self.assertEqual(compute_dhash(twin), h)


class PhashTests(unittest.TestCase):
    """pHash:32x32 DCT 低频 8x8(去 DC)中位阈值 → 64bit 第二指纹。"""

    def test_brightness_invariance_dc_excluded(self):
        # DC 排除 ⇒ 恒定亮度平移不改变指纹(与 Node 端 Q-2 同律)
        a = _structured_pattern()
        pa = compute_phash(a)
        for shift in (40, 80):
            self.assertEqual(compute_phash(a.point(lambda v: v + shift)), pa)

    def test_orientation_discrimination(self):
        # 水平 vs 垂直梯度频谱落位不同 → 距离显著
        ramp = np.linspace(0, 200, 64).astype(np.uint8)
        h_img = Image.fromarray(np.stack([np.tile(ramp, (64, 1))] * 3, axis=2))
        v_img = Image.fromarray(np.stack([np.tile(ramp[:, None], (1, 64))] * 3, axis=2))
        self.assertGreaterEqual(hamming_hex(compute_phash(h_img), compute_phash(v_img)), 8)

    def test_determinism_and_format(self):
        p = compute_phash(_structured_pattern())
        self.assertRegex(p, r"^[0-9a-f]{16}$")
        self.assertEqual(compute_phash(_structured_pattern()), p)
        # dhash 与 phash 是独立维度:结构图上两者互异(第二指纹的意义)
        img = _structured_pattern()
        self.assertNotEqual(compute_dhash(img), compute_phash(img))


class HammingTests(unittest.TestCase):
    """hex 汉明距离:恒等 / 补集 / 防御式畸形输入。"""

    def test_hamming_hex_known_values(self):
        self.assertEqual(hamming_hex("0" * 16, "0" * 16), 0)
        self.assertEqual(hamming_hex("f" * 16, "0" * 16), 64)
        self.assertEqual(hamming_hex("0000000000000001", "0000000000000000"), 1)
        self.assertEqual(hamming_hex("0000000000000003", "0000000000000000"), 2)

    def test_hamming_hex_defensive(self):
        # 非十六进制输入 → 最大距离 64(防御式,不抛)
        self.assertEqual(hamming_hex("zzzz", "0" * 16), 64)
        self.assertEqual(hamming_hex("0" * 16, ""), 64)
        # 对称性
        a, b = "beef" + "0" * 12, "f00d" + "0" * 12
        self.assertEqual(hamming_hex(a, b), hamming_hex(b, a))


# ─── ΝΩ-35：热路径向量化等值用例（旧纯 Python 实现为内联参照）───


def _ref_dhash_python(img: Image.Image) -> str:
    """旧实现（getdata 位循环）—— 等值参照。"""
    g = img.convert("L").resize((9, 8))
    px = list(np.asarray(g).ravel())
    bits = 0
    for row in range(8):
        base = row * 9
        for col in range(8):
            if px[base + col] > px[base + col + 1]:
                bits |= 1 << (row * 8 + col)
    return f"{bits:016x}"


def _ref_salience_loop(img: Image.Image, grid: tuple[int, int] = (12, 8), bins: int = 16) -> dict:
    """旧实现（96 块 np.histogram 循环）—— 等值参照。"""
    g = np.asarray(img.convert("L").resize((grid[0] * 16, grid[1] * 16)), dtype=np.float64)
    gx = np.abs(np.diff(g, axis=1))[:-1, :]
    gy = np.abs(np.diff(g, axis=0))[:, :-1]
    mag = np.sqrt(gx ** 2 + gy ** 2)

    bh = mag.shape[0] // grid[1]
    bw = mag.shape[1] // grid[0]
    entropies: list[float] = []
    for by in range(grid[1]):
        for bx in range(grid[0]):
            block = mag[by * bh:(by + 1) * bh, bx * bw:(bx + 1) * bw]
            hist, _ = np.histogram(block, bins=bins, range=(0, mag.max() + 1e-9))
            p = hist.astype(np.float64) + 1e-9
            p /= p.sum()
            entropies.append(float(-(p * np.log2(p)).sum()))

    mean = float(np.mean(entropies))
    std = float(np.std(entropies))
    thr = mean + std
    hot = [e >= thr for e in entropies]
    seen = [False] * len(entropies)
    zones: list[dict] = []
    for start in range(len(entropies)):
        if not hot[start] or seen[start]:
            continue
        stack = [start]
        seen[start] = True
        cells = []
        while stack:
            cur = stack.pop()
            cells.append(cur)
            cy, cx = divmod(cur, grid[0])
            for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                if 0 <= ny < grid[1] and 0 <= nx < grid[0]:
                    idx = ny * grid[0] + nx
                    if hot[idx] and not seen[idx]:
                        seen[idx] = True
                        stack.append(idx)
        ys = [c // grid[0] for c in cells]
        xs = [c % grid[0] for c in cells]
        y0, y1 = min(ys), max(ys)
        x0, x1 = min(xs), max(xs)
        zones.append({
            "x": x0 / grid[0], "y": y0 / grid[1],
            "width": (x1 - x0 + 1) / grid[0], "height": (y1 - y0 + 1) / grid[1],
            "entropy": round(max(entropies[c] for c in cells), 3),
        })
    zones.sort(key=lambda z: z["entropy"], reverse=True)
    return {
        "zones": zones[:6],
        "blocks": [round(e, 3) for e in entropies],
        "stats": {"mean": round(mean, 3), "std": round(std, 3), "max": round(max(entropies), 3)},
    }


class DhashVectorizationTests(unittest.TestCase):
    """ΝΩ-35：packbits 向量化与旧位循环在确定性随机图上逐位等值。"""

    def test_random_patterns_bit_exact(self):
        for seed in range(6):
            rng = np.random.RandomState(seed)
            img = Image.fromarray(rng.randint(0, 256, size=(120, 160, 3)).astype(np.uint8))
            self.assertEqual(compute_dhash(img), _ref_dhash_python(img), f"seed={seed}")

    def test_quantized_edge_values(self):
        # 16 级量化（值恰落在 16 桶边界的倍数族）—— resize 插值后再比较，
        # 钉死 uint8 比较无舍入路径
        rng = np.random.RandomState(99)
        img = Image.fromarray(
            (rng.randint(0, 16, (240, 320)) * 16).astype(np.uint8)[:, :, None].repeat(3, 2)
        )
        self.assertEqual(compute_dhash(img), _ref_dhash_python(img))


class PhashVectorizationTests(unittest.TestCase):
    """ΝΩ-35：phash 位打包循环 → packbits 后，既有性质用例全部保持。"""

    def test_bit_packing_matches_median_threshold_enumeration(self):
        # 独立参照：np.median + enumerate 序逐位置位（旧实现语义）
        from dsh_physical.screen import _dct_matrix

        for seed in (3, 4):
            rng = np.random.RandomState(seed)
            img = Image.fromarray(rng.randint(0, 256, size=(64, 64, 3)).astype(np.uint8))
            g = np.asarray(img.convert("L").resize((32, 32)), dtype=np.float64)
            c32 = _dct_matrix(32)
            low = (c32 @ g @ c32.T)[:8, :8].copy()
            low[0, 0] = 0.0
            med = float(np.median(low))
            ref = 0
            for i, v in enumerate(low.flatten()):
                if v > med:
                    ref |= 1 << i
            self.assertEqual(compute_phash(img), f"{ref:016x}", f"seed={seed}")


class SalienceVectorizationTests(unittest.TestCase):
    """ΝΩ-35：分块熵单趟 bincount 向量化与旧 96 次 histogram 循环等值。

    全返回体逐键相等（blocks/stats 3 位小数、zones BFS 合并与排序）——
    桶计数是整型等值 ⇒ 熵浮点逐位相等 ⇒ round 后全等。
    """

    @staticmethod
    def _corpus() -> list[Image.Image]:
        cases = []
        for seed in range(6):
            rng = np.random.RandomState(seed)
            cases.append(Image.fromarray(rng.randint(0, 256, size=(240, 320, 3)).astype(np.uint8)))
        cases.append(Image.new("RGB", (640, 480), (100, 100, 100)))  # 平图（全零梯度）
        cases.append(Image.fromarray(  # 水平阶梯（部分块零熵/部分高熵）
            np.tile(np.linspace(0, 255, 640, dtype=np.uint8)[None, :, None], (480, 1, 3))
        ))
        arr = np.zeros((300, 400, 3), np.uint8)
        arr[::7, ::5] = 200  # 稀疏网格线（高频边缘）
        arr[50:100, 60:120] = 90
        cases.append(Image.fromarray(arr))
        rng = np.random.RandomState(99)
        cases.append(Image.fromarray(  # 16 级量化（桶边界倍数值族）
            (rng.randint(0, 16, (240, 320)) * 16).astype(np.uint8)[:, :, None].repeat(3, 2)
        ))
        return cases

    def test_full_result_dict_equal_to_loop_reference(self):
        for k, img in enumerate(self._corpus()):
            self.assertEqual(compute_salience(img), _ref_salience_loop(img), f"corpus[{k}]")

    def test_non_default_grid_bins_equal(self):
        # 非缺省 grid/bins 也等值（8x6 网格、8 桶）
        rng = np.random.RandomState(5)
        img = Image.fromarray(rng.randint(0, 256, size=(200, 260, 3)).astype(np.uint8))
        self.assertEqual(
            compute_salience(img, grid=(8, 6), bins=8),
            _ref_salience_loop(img, grid=(8, 6), bins=8),
        )


class CaptureHotPathSmokeTests(unittest.TestCase):
    """ΝΩ-35：指纹/keep_frame 入 SCREEN_POOL 后的端到端冒烟（meta_only 不编码）。"""

    def test_meta_only_capture_hashes_and_frame_ring(self):
        import asyncio
        import os
        from unittest import mock

        from dsh_physical.config import ScreenshotConfig
        from dsh_physical.screen import ScreenCapture

        ctrl = ScreenCapture(ScreenshotConfig())

        async def _run():
            return await ctrl.capture(
                want_hashes=True, keep_frame=True, meta_only=True,
                want_region_hash={"x": 0.5, "y": 0.5, "r": 0.2},
            )

        # DSH_PHYSICAL_TEST_SCREEN：无显示环境下走合成图降级；有真屏走真图
        with mock.patch.dict(os.environ, {"DSH_PHYSICAL_TEST_SCREEN": "1"}):
            handle, extras = asyncio.run(_run())
        self.assertIsNone(handle)  # meta_only：不编码不传图
        self.assertRegex(extras["dhash"], r"^[0-9a-f]{16}$")
        self.assertRegex(extras["phash"], r"^[0-9a-f]{16}$")
        self.assertRegex(extras["region_dhash"], r"^[0-9a-f]{16}$")
        self.assertIsNotNone(extras["frame_id"])
        # 帧环可读（keep_frame 的 ndarray 已入环）
        self.assertEqual(len(ctrl.frame_ids()), 1)
        stats = ctrl.frame_stats(extras["frame_id"], [])
        self.assertEqual(len(stats), 1)
        self.assertIn("mean", stats[0])


# ─── ΠΑΝ-81/82：进程级 DPI 域契约与执法（dpi.py + input 尺寸缓存）───


class DpiDomainContractTests(unittest.TestCase):
    """ΠΑΝ-81：单一像素域契约的立法（ensure）与可观测性（report）。

    契约：进程显式申请 per-monitor-v2 ⇒ 全链（枚举 / ImageGrab /
    pyautogui.size / ui_tree 归一化分母 / 点击换算 / 光标）物理像素同域。
    宿主 manifest 已钉死感知时申请被拒 —— 契约要求如实申报，不谎报。
    """

    def test_pixel_domain_report_shape_and_never_raises(self):
        from dsh_physical import dpi

        rep = dpi.pixel_domain_report()
        for key in ("platform", "contract", "requested", "achieved", "attempted",
                    "awareness", "system_dpi", "pixel_domain", "endpoints"):
            self.assertIn(key, rep)
        self.assertEqual(rep["requested"], "per-monitor-v2")
        self.assertIn(rep["awareness"], (
            "unaware", "system", "per-monitor", "per-monitor-v2", "unknown", "non-windows"))
        self.assertIn(rep["pixel_domain"], (
            "physical", "physical(system-dpi)", "logical", "unknown", "non-windows"))
        # 端点域申报：随感知漂移的五个端点 + 恒物理的抓图端点
        self.assertEqual(sorted(rep["endpoints"]), sorted([
            "pyautogui.size()", "EnumDisplayMonitors/GetMonitorInfoW",
            "ui_tree L1/L2 normalization divisor", "input pixel conversion",
            "cursor GetCursorPos/CURSORINFO", "pyautogui.screenshot()/ImageGrab"]))
        self.assertEqual(rep["endpoints"]["pyautogui.screenshot()/ImageGrab"], "physical")
        # 感知档位 ⇒ 域的映射一致性（契约申报不自相矛盾）
        expected = {
            "per-monitor": "physical", "per-monitor-v2": "physical",
            "system": "physical(system-dpi)", "unaware": "logical",
        }.get(rep["awareness"], rep["pixel_domain"])
        self.assertEqual(rep["pixel_domain"], expected)

    def test_ensure_idempotent_and_awareness_stable(self):
        from dsh_physical import dpi

        first = dpi.ensure_process_dpi_awareness()
        second = dpi.ensure_process_dpi_awareness()  # 幂等：二次为记账 no-op
        self.assertEqual(first, second)
        self.assertEqual(dpi.current_dpi_awareness(), first)

    def test_contract_holds_after_screen_module_import(self):
        # screen 模块导入即立法（server/routes 装配路径）—— 事后状态必须
        # 可查询且与本机探测一致（never raises / 形状稳定）。
        import dsh_physical.screen  # noqa: F401  已导入则为幂等 no-op

        from dsh_physical import dpi

        self.assertTrue(dpi.pixel_domain_report()["attempted"])

    @unittest.skipUnless(sys.platform == "win32", "win32-only DPI enforcement")
    def test_legacy_dpi_flip_attempt_cannot_change_domain(self):
        # ΠΑΝ-82 执法（不依赖 uiautomation 安装）：ensure 之后，第三方库
        # import 期的 SetProcessDPIAware()（uiautomation / pyautogui 的
        # _pyautogui_win.py 行为）不再能翻转进程感知 —— OS「只能升不能降」。
        import ctypes

        from dsh_physical import dpi

        u = ctypes.windll.user32
        if not hasattr(u, "SetProcessDpiAwarenessContext"):
            self.skipTest("SetProcessDpiAwarenessContext unavailable (pre Win10 1703)")
        dpi.ensure_process_dpi_awareness()
        before = dpi.current_dpi_awareness()
        before_epoch = dpi.domain_epoch()
        try:
            u.SetProcessDPIAware()  # 模拟第三方库导入副作用
        except Exception:  # noqa: BLE001 —— 调用本身失败正是契约生效的形态
            pass
        self.assertEqual(dpi.current_dpi_awareness(), before)
        self.assertEqual(dpi.domain_epoch(), before_epoch)

    def test_uiautomation_import_keeps_awareness(self):
        # ΠΑΝ-82 端到端执法：真 uiautomation 库的 import 不翻转感知
        # （库缺席的环境诚实跳过 —— 上一用例以直接系统调用覆盖同一条律）。
        import importlib.util

        if importlib.util.find_spec("uiautomation") is None:
            self.skipTest("uiautomation not installed on this host")
        from dsh_physical import dpi

        dpi.ensure_process_dpi_awareness()
        before = dpi.current_dpi_awareness()
        import uiautomation  # noqa: F401 —— 副作用导入正是被测对象

        self.assertEqual(dpi.current_dpi_awareness(), before)


class InputScreenSizeCacheTests(unittest.TestCase):
    """ΠΑΝ-81：InputController 尺寸缓存 = TTL + DPI 域指纹双失效键。

    C2-5 H-2 病灶：30s TTL 窗口内第三方库翻转感知 ⇒ 旧逻辑像素读数继续
    换算新物理坐标（~25% 偏移）。域指纹（domain_epoch）变化 ⇒ 缓存立即失效。
    """

    @staticmethod
    def _controller():
        from dsh_physical.config import ActionConfig
        from dsh_physical.input import InputController

        return InputController(ActionConfig())

    @staticmethod
    def _fake_pa(width=1920, height=1080, counter=None):
        import types

        def size():
            if counter is not None:
                counter["n"] = counter.get("n", 0) + 1
            return types.SimpleNamespace(width=width, height=height)

        return types.SimpleNamespace(size=size)

    def test_cache_hit_within_same_epoch(self):
        import asyncio
        from unittest import mock

        from dsh_physical import dpi, input as input_mod

        ctrl = self._controller()
        counter: dict = {}
        fake = self._fake_pa(counter=counter)
        with mock.patch.object(input_mod, "_get_pyautogui", return_value=fake), \
                mock.patch.object(dpi, "domain_epoch", return_value=("per-monitor", 96)):
            a = asyncio.run(ctrl.get_screen_size())
            b = asyncio.run(ctrl.get_screen_size())
            c = asyncio.run(ctrl.get_screen_size())
        # 同域 + TTL 内：一次真实查询，两次缓存命中
        self.assertEqual((a, b, c), ((1920, 1080),) * 3)
        self.assertEqual(counter["n"], 1)

    def test_epoch_flip_invalidates_cache(self):
        import asyncio
        from unittest import mock

        from dsh_physical import dpi, input as input_mod

        ctrl = self._controller()
        counter: dict = {}
        fake = self._fake_pa(counter=counter)
        epochs = iter([("unaware", 96), ("unaware", 96), ("per-monitor-v2", 96)])
        with mock.patch.object(input_mod, "_get_pyautogui", return_value=fake), \
                mock.patch.object(dpi, "domain_epoch", side_effect=lambda: next(epochs)):
            asyncio.run(ctrl.get_screen_size())
            asyncio.run(ctrl.get_screen_size())       # 同域 ⇒ 缓存
            asyncio.run(ctrl.get_screen_size())       # 域翻转 ⇒ 重查
        self.assertEqual(counter["n"], 2)

    def test_ttl_expiry_still_invalidates(self):
        import asyncio
        import time
        from unittest import mock

        from dsh_physical import dpi, input as input_mod

        ctrl = self._controller()
        counter: dict = {}
        fake = self._fake_pa(counter=counter)
        with mock.patch.object(input_mod, "_get_pyautogui", return_value=fake), \
                mock.patch.object(dpi, "domain_epoch", return_value=("per-monitor", 96)):
            asyncio.run(ctrl.get_screen_size())
            ctrl._screen_size_at = time.monotonic() - (ctrl.SCREEN_SIZE_TTL_S + 1)
            size = asyncio.run(ctrl.get_screen_size())
        self.assertEqual(size, (1920, 1080))
        self.assertEqual(counter["n"], 2)  # TTL 到期 ⇒ 重查（J 纪元行为保持）

    def test_pyautogui_import_gated_by_dpi_guard(self):
        # ΠΑΝ-82：_get_pyautogui 在 import pyautogui 之前必须先锁感知
        # （pyautogui 的 _pyautogui_win.py import 即 SetProcessDPIAware ——
        # 与 uiautomation 同病的进程级副作用）。
        import builtins
        from unittest import mock

        from dsh_physical import dpi, input as input_mod

        events: list[str] = []
        real_import = builtins.__import__

        def spy_import(name, *args, **kwargs):
            if name == "pyautogui":
                events.append("import")
            return real_import(name, *args, **kwargs)

        real_ensure = dpi.ensure_process_dpi_awareness

        def ensure_spy():
            events.append("dpi-locked")
            return real_ensure()

        saved = input_mod._pyautogui
        input_mod._pyautogui = None  # 强制走懒加载分支
        try:
            with mock.patch.object(builtins, "__import__", side_effect=spy_import), \
                    mock.patch.object(dpi, "ensure_process_dpi_awareness",
                                      side_effect=ensure_spy):
                try:
                    input_mod._get_pyautogui()
                except Exception:  # noqa: BLE001 —— 无显示环境失败不判死刑：
                    pass                            # 只执法「导入前的感知锁定」
        finally:
            input_mod._pyautogui = saved
        self.assertIn("dpi-locked", events)
        if "import" in events:  # 真发生了 pyautogui 导入 ⇒ 锁必须在前
            self.assertEqual(events[:2], ["dpi-locked", "import"])


if __name__ == "__main__":
    unittest.main()
