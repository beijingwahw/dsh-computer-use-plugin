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

    # ─── ΤΕΛ-5 D-G26:releaseShm 服务端自校验(删除面必须落自家 mmap_dir)───

    def test_tel5_release_refuses_foreign_registered_path(self):
        """注册表被界外路径污染(假设上游 bug / 伪造)⇒ 拒删:界外文件原样存活。

        服务端半边的自校验防线 —— Node 侧白名单根(ΠΑΝ-66)之外的纵深:
        即使 name 命中注册表,删除面仍须过 _path_within(mmap_root)。
        """
        outside = FsPath(self._tmp.name).parent / "tel5_d26_outside_secret.bin"
        outside.write_bytes(b"DO-NOT-DELETE")
        try:
            shm._active_handles[str(outside)] = {
                "transport": "mmap-file",
                "path": str(outside),
                # 故意记录错误的 mmap_root(界内根)——路径不在根内 ⇒ 拒删
                "mmap_root": str(FsPath(self._tmp.name).resolve()),
                "mmap": None,
                "expires_at": 1e18,
                "size": 13,
            }
            before = shm.get_stats()["mmap_bytes"]
            self.assertTrue(shm.release_by_name(str(outside)))  # 注册表命中 = True
            self.assertTrue(outside.exists())  # 但文件拒绝被删(fail-closed)
            self.assertEqual(
                shm.get_stats()["mmap_bytes"], before
            )  # 没删就不扣账面(ΑΩ-R26 同律:扣了就是撒谎)
        finally:
            shm._active_handles.pop(str(outside), None)
            outside.unlink(missing_ok=True)

    def test_tel5_release_refuses_symlink_escape(self):
        """界内 symlink 指向界外真身 ⇒ realpath 解析出界 ⇒ 拒删。

        Node 侧防线不覆盖 symlink 逃逸(ΠΑΝ-66 已知留白);服务端 realpath
        解析是其配合面 —— 删除判据看真身而非链接文字面。手工注册表污染
        模拟「注册后换链接」终态(活跃 mmap 未关时 Windows 不许换文件,故
        直接构造该终态);symlink 创建需平台特权,不可用则如实跳过。
        """
        link = FsPath(self._tmp.name) / "tel5_d26_link.bin"
        target = FsPath(self._tmp.name).parent / "tel5_d26_escape_target.bin"
        target.write_bytes(b"ESCAPE-TARGET")
        try:
            os.symlink(str(target), str(link))
        except (OSError, NotImplementedError):
            target.unlink(missing_ok=True)
            self.skipTest("symlink 创建不可用(需开发者模式/特权)——realpath 分支本平台不可达")
        shm._active_handles[str(link)] = {
            "transport": "mmap-file",
            "path": str(link),
            "mmap_root": str(FsPath(self._tmp.name).resolve()),
            "mmap": None,
            "expires_at": 1e18,
            "size": 13,
        }
        try:
            before = shm.get_stats()["mmap_bytes"]
            self.assertTrue(shm.release_by_name(str(link)))  # 注册表命中
            self.assertTrue(target.exists())  # 界外真身未被删(realpath 拒删)
            self.assertTrue(os.path.lexists(str(link)))  # 链接本体也未被删
            self.assertEqual(shm.get_stats()["mmap_bytes"], before)
        finally:
            shm._active_handles.pop(str(link), None)
            if os.path.lexists(str(link)):
                os.unlink(str(link))
            target.unlink(missing_ok=True)

    def test_tel5_legitimate_release_still_deletes(self):
        """回归锚:合法界内 handle 的显式释放照常删文件(自校验不误伤)。"""
        h = shm.write_image(b"l" * 32, 4, 4, format="PNG", config=self.cfg, ttl_seconds=3600)
        before = shm.get_stats()["mmap_bytes"]
        self.assertTrue(shm.release_by_name(h.name))
        self.assertFalse(os.path.exists(h.name))
        self.assertEqual(shm.get_stats()["mmap_bytes"], before - 32)

    def test_tel5_path_within_prefix_and_case_guard(self):
        """_path_within 纯函数律:前缀伪命中 / 大小写折叠 / 根等值 / 判不出。"""
        root = str(FsPath(self._tmp.name).resolve())
        evil = FsPath(self._tmp.name).parent / (FsPath(self._tmp.name).name + "-evil")
        self.assertFalse(shm._path_within(str(evil), root))  # 前缀目录不是子目录
        self.assertTrue(shm._path_within(str(FsPath(root) / "a.bin"), root))
        self.assertTrue(shm._path_within(root, root))  # 根自身等值
        if os.name == "nt":
            upper = str(FsPath(root)).upper()
            self.assertTrue(shm._path_within(upper, root))  # Windows 盘符大小写折叠
        self.assertFalse(shm._path_within("", root))  # 空 child 判不出 ⇒ 不删
        self.assertFalse(shm._path_within(str(FsPath(root) / "a.bin"), ""))  # 空 root ⇒ 拒


if __name__ == "__main__":
    unittest.main()
