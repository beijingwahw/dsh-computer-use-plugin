"""shm 句柄注册表语义离线单测(ΑΩ-R32)。

tmp 目录模拟 mmap-file 通道(Windows 主路径):注册表是唯一持有者与
唯一生命周期 —— 写入字节镜像 / 按名释放 / TTL 懒 GC / base64 内联。
零 POSIX shm、零网络、零 Node 端参与。
"""
import sys
from pathlib import Path

# ΑΩ-R32:discover 以本目录为 top-level,注入 python_service/(dsh_physical 所在目录)
_SVC_ROOT = str(Path(__file__).resolve().parents[1])
if _SVC_ROOT not in sys.path:
    sys.path.insert(0, _SVC_ROOT)

import base64  # noqa: E402
import os  # noqa: E402
import tempfile  # noqa: E402
import unittest  # noqa: E402
from dataclasses import replace  # noqa: E402
from pathlib import Path as FsPath  # noqa: E402

from dsh_physical import shm  # noqa: E402
from dsh_physical.config import ScreenshotConfig  # noqa: E402


class ShmRegistryTests(unittest.TestCase):
    """注册表语义:make_handle / release_by_name / cleanup_all / GC。"""

    def setUp(self) -> None:
        # ΑΩ-R32:注册表是模块级共享状态,逐测试清场 + 独立 tmp 目录
        shm.cleanup_all()
        self._tmp = tempfile.TemporaryDirectory()
        self.cfg = ScreenshotConfig(transport="mmap-file", mmap_dir=self._tmp.name)

    def tearDown(self) -> None:
        shm.cleanup_all()
        self._tmp.cleanup()

    def test_mmap_file_write_release_lifecycle(self):
        payload = bytes(range(256)) * 4  # 1024 字节
        h = shm.make_handle(payload, 64, 32, format="PNG", config=self.cfg)
        self.assertEqual(h.transport, "mmap-file")
        self.assertEqual(h.size, len(payload))
        self.assertEqual(h.shape, (32, 64, 3))  # (height, width, channels)
        self.assertEqual(h.stride, len(payload) // 32)  # PNG: size // height
        # 字节镜像:落盘内容与写入负载逐字节一致,Node 端按路径重读的根基
        self.assertTrue(os.path.isfile(h.name))
        self.assertEqual(FsPath(h.name).read_bytes(), payload)
        # 注册表键 = handle.name(DELETE 端点按名释放永不 miss)
        self.assertIn(h.name, shm._active_handles)
        # 显式释放:munmap + 删文件 + 出注册表
        self.assertTrue(shm.release_by_name(h.name))
        self.assertFalse(os.path.exists(h.name))
        self.assertNotIn(h.name, shm._active_handles)
        self.assertFalse(shm.release_by_name(h.name))  # 二次释放 miss

    def test_rgb_stride_is_width_times_channels(self):
        h = shm.make_handle(b"x" * 300, 100, 3, format="RGB", config=self.cfg)
        self.assertEqual(h.stride, 300)  # 100 px * 3 通道
        self.assertTrue(shm.release_by_name(h.name))

    def test_base64_transport_inline_no_registry(self):
        payload = b"\x89PNG-fake-bytes"
        cfg = replace(self.cfg, transport="base64")
        h = shm.make_handle(payload, 4, 4, format="PNG", config=cfg)
        self.assertEqual(h.transport, "base64")
        self.assertEqual(h.name, "")
        self.assertEqual(base64.b64decode(h.base64_data), payload)  # 字节镜像往返
        self.assertEqual(shm._active_handles, {})  # base64 不入注册表

    def test_transport_shm_falls_back_to_mmap_file_when_posix_unavailable(self):
        # J 纪元级联修正:显式 shm 但 POSIX 不可用 → mmap-file(不静默跌落 base64)
        if shm._HAS_POSIX_SHM:
            self.skipTest("POSIX shm 可用,Windows 降级分支不适用")
        cfg = replace(self.cfg, transport="shm")
        h = shm.make_handle(b"x" * 100, 10, 10, format="PNG", config=cfg)
        self.assertEqual(h.transport, "mmap-file")
        self.assertTrue(os.path.isfile(h.name))

    def test_expired_handle_lazy_gc(self):
        # TTL 已过 → 任意后续入口(write/release)的懒 GC 先行回收 → 按名释放 miss
        h = shm.write_image(b"y" * 50, 5, 5, format="PNG", config=self.cfg, ttl_seconds=-5)
        self.assertTrue(os.path.isfile(h.name))
        self.assertFalse(shm.release_by_name(h.name))  # GC 已回收,release miss
        self.assertFalse(os.path.exists(h.name))
        # 活跃 handle 不受 GC 波及:正常 TTL 的按名释放命中
        h2 = shm.write_image(b"z" * 10, 2, 5, format="PNG", config=self.cfg, ttl_seconds=60)
        self.assertTrue(shm.release_by_name(h2.name))

    def test_cleanup_all_releases_everything(self):
        names = [
            shm.write_image(bytes([i]) * 16, 4, 4, format="PNG", config=self.cfg).name
            for i in range(3)
        ]
        self.assertEqual(len(shm._active_handles), 3)
        shm.cleanup_all()
        self.assertEqual(shm._active_handles, {})
        for n in names:
            self.assertFalse(os.path.exists(n))  # 退出兜底不留文件

    def test_get_stats_returns_defensive_copy(self):
        snap = shm.get_stats()
        self.assertIn("mmap_bytes", snap)
        snap["mmap_bytes"] = -999  # 篡改快照不得影响内部账面
        self.assertNotEqual(shm.get_stats()["mmap_bytes"], -999)


if __name__ == "__main__":
    unittest.main()
