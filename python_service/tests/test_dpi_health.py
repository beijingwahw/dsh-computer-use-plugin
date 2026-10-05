"""ΤΕΛ-6（D-G28②）执法册：DPI 像素域契约的 /health 申报接线。

ΠΑΝ-81 落地的 ``dsh_physical.dpi.pixel_domain_report()`` 诊断面此前只导出未
接线（DEBTS D-G28② 登记）。本册锁定：
  · ``/health`` 包体新增 ``pixel_domain`` 键（additive —— 既有键零变化），
    契约字段在场（contract/achieved/awareness/pixel_domain/endpoints）；
  · 30s TTL 缓存：窗内两次调用同对象（高频探活不逐次重跑 ctypes 探测链，
    surfaces 清单缓存同先例）；过期后重取；
  · 诚实 absent：dpi 面炸裂 ⇒ {absent, reason}，health 绝不抛；
  · 纯进程内零网络（不起 TestClient —— 直接驱动 health 协程 + 假控制器
    set_controllers 的鸭子类型缝，list_displays 对假件诚实降级 host:[]）。
"""
import asyncio
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

_SVC_ROOT = str(Path(__file__).resolve().parents[1])
if _SVC_ROOT not in sys.path:
    sys.path.insert(0, _SVC_ROOT)

from dsh_physical import routes  # noqa: E402


class _FakeScreen:
    async def get_screen_size(self) -> dict:
        return {"width": 1920, "height": 1080}


class _FakeWindow:
    @staticmethod
    def method() -> str:
        return "fake"


class PixelDomainHealthTests(unittest.TestCase):
    """D-G28②：/health 的 pixel_domain 申报面。"""

    def setUp(self) -> None:
        routes._pixel_domain_cache.clear()

    def test_face_reports_contract_keys_offline(self):
        """申报面契约字段在场（Windows 真 ctypes 链；他平台 ⇒ non-windows 申报）。"""
        report = routes._pixel_domain_face()
        self.assertIsInstance(report, dict)
        for key in ("contract", "achieved", "awareness", "system_dpi", "pixel_domain", "endpoints"):
            self.assertIn(key, report, f"契约键 {key} 在场")
        self.assertIn(
            report["awareness"],
            ("unaware", "system", "per-monitor", "per-monitor-v2", "unknown", "non-windows"),
        )

    def test_face_ttl_cache_window_reuses_report(self):
        """30s 窗内两次调用零重取（同一对象）；跨窗重取。"""
        first = routes._pixel_domain_face()
        with mock.patch(
            "dsh_physical.dpi.pixel_domain_report",
            side_effect=AssertionError("不应重取（TTL 窗内）"),
        ):
            second = routes._pixel_domain_face()
        self.assertIs(first, second, "TTL 窗内缓存命中（同对象）")

        # 跨窗：缓存时刻回拨 31s ⇒ 重取（解除打桩后走真实现）
        routes._pixel_domain_cache["at"] = time.monotonic() - 31.0
        third = routes._pixel_domain_face()
        self.assertIsInstance(third, dict)
        self.assertIn("pixel_domain", third)
        self.assertNotIn("absent", third)

    def test_face_honest_absent_never_raises(self):
        """dpi 面炸裂 ⇒ {absent, reason} 诚实申报（health 铁律：绝不抛）。"""
        routes._pixel_domain_cache.clear()
        boom = RuntimeError("dpi gone")
        with mock.patch("dsh_physical.dpi.pixel_domain_report", side_effect=boom):
            report = routes._pixel_domain_face()
        self.assertEqual(report.get("absent"), True)
        self.assertIn("RuntimeError", str(report.get("reason")))

    def test_health_endpoint_carries_pixel_domain(self):
        """/health 包体新增 pixel_domain 键（additive）—— 假控制器驱动真协程。"""
        fake_config = SimpleNamespace(
            auth=SimpleNamespace(enable_pid_attestation=False),
            funnel=SimpleNamespace(
                l1_backend="uia", l2_backend="ocr", l3_backend="vlm", arbitration_enabled=False
            ),
            screenshot=SimpleNamespace(transport="mss"),
            raw_input=SimpleNamespace(enabled=False),
        )
        routes.set_controllers(
            input_ctrl=object(),  # type: ignore[arg-type]
            screen_ctrl=_FakeScreen(),  # type: ignore[arg-type]
            funnel_ctrl=object(),  # type: ignore[arg-type]
            window_ctrl=_FakeWindow(),  # type: ignore[arg-type]
            config=fake_config,  # type: ignore[arg-type]
        )
        try:
            envelope = asyncio.run(routes.health())
        finally:
            routes._controllers.clear()
        self.assertEqual(envelope["status"], "success")
        data = envelope["data"]
        self.assertIn("pixel_domain", data, "D-G28②：/health 申报 DPI 像素域")
        self.assertIn("contract", data["pixel_domain"])
        # 既有键零变化（additive 面）：核心能力申报仍在
        for key in ("pid", "screen", "surfaces", "hardware", "auth"):
            self.assertIn(key, data, f"既有键 {key} 不因接线消失")


if __name__ == "__main__":
    unittest.main()
