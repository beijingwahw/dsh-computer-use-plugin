"""ΝΩ-27 优雅关停 drain 语义单测（离线：零 uvicorn/零网络）。

``POST /v1/shutdown`` 收到即：
  1. 置 draining 标志 —— drain_should_reject 对新请求（自身除外）判决拒绝；
  2. 后台排空：等在飞（drain_enter/leave 计数）完成，上限 3s，到点强制；
  3. 触发退出钩子 hook(force) —— 钩子缺席（测试形态）⇒ 仅排空不退出。

Windows 上 SIGTERM 即硬杀，Node 端 3s 优雅窗形同虚设 —— 本端点是其躯体。
"""
import sys
import time
from pathlib import Path

_SVC_ROOT = str(Path(__file__).resolve().parents[1])
if _SVC_ROOT not in sys.path:
    sys.path.insert(0, _SVC_ROOT)

import asyncio  # noqa: E402
import unittest  # noqa: E402

from dsh_physical import routes  # noqa: E402


class ShutdownDrainTests(unittest.TestCase):
    """drain 语义：标志/判决/计数/排空/端点幂等。"""

    def setUp(self) -> None:
        routes.reset_shutdown_state()

    def tearDown(self) -> None:
        routes.reset_shutdown_state()

    def test_default_drain_cap_is_3s(self):
        self.assertEqual(routes.SHUTDOWN_DRAIN_MAX_WAIT_S, 3.0, "排空上限 = 3s（与 Node 端优雅窗对齐）")

    def test_not_draining_rejects_nothing(self):
        self.assertFalse(routes.is_draining())
        for path in ("/v1/click_mouse", "/v1/health", "/v1/shutdown"):
            self.assertFalse(routes.drain_should_reject(path), f"未 draining：{path} 一律放行")

    def test_draining_rejects_all_but_shutdown(self):
        routes._drain_state["draining"] = True
        for path in ("/v1/click_mouse", "/v1/health", "/v1/get_ui_tree", "/v1/shm/x"):
            self.assertTrue(routes.drain_should_reject(path), f"draining：{path} 拒绝（503 信封）")
        # /v1/shutdown 自身放行（幂等）—— 含尾斜杠方言
        self.assertFalse(routes.drain_should_reject("/v1/shutdown"))
        self.assertFalse(routes.drain_should_reject("/v1/shutdown/"))

    def test_in_flight_counting(self):
        self.assertEqual(routes._drain_state["in_flight"], 0)
        routes.drain_enter()
        routes.drain_enter()
        self.assertEqual(routes._drain_state["in_flight"], 2)
        routes.drain_leave()
        self.assertEqual(routes._drain_state["in_flight"], 1)
        routes.drain_leave()
        self.assertEqual(routes._drain_state["in_flight"], 0)
        routes.drain_leave()  # 过量 leave 不出负（防御）
        self.assertEqual(routes._drain_state["in_flight"], 0)

    def test_drain_and_exit_no_in_flight_hook_graceful(self):
        calls: list[bool] = []

        async def scenario() -> None:
            routes.register_shutdown_hook(lambda force: calls.append(force))
            forced, drained = await routes.drain_and_exit(max_wait_s=0.1)
            self.assertFalse(forced, "无在飞 ⇒ 非强制")
            self.assertTrue(drained, "排空完成")
            self.assertEqual(calls, [False], "钩子以 force=False 调用（优雅 should_exit）")

        asyncio.run(scenario())

    def test_drain_and_exit_waits_for_in_flight(self):
        calls: list[bool] = []

        async def scenario() -> None:
            routes.register_shutdown_hook(lambda force: calls.append(force))
            routes.drain_enter()
            task = asyncio.get_running_loop().create_task(routes.drain_and_exit(max_wait_s=1.0))
            await asyncio.sleep(0.05)
            self.assertEqual(calls, [], "在飞未归零 ⇒ 钩子未触发（排空中）")
            self.assertFalse(task.done())
            routes.drain_leave()  # 在飞完成
            forced, drained = await task
            self.assertFalse(forced)
            self.assertTrue(drained)
            self.assertEqual(calls, [False])

        asyncio.run(scenario())

    def test_drain_and_exit_forces_after_cap(self):
        calls: list[bool] = []

        async def scenario() -> None:
            routes.register_shutdown_hook(lambda force: calls.append(force))
            routes.drain_enter()  # 卡死的在飞：永不归零
            started = time.monotonic()
            forced, drained = await routes.drain_and_exit(max_wait_s=0.2)
            elapsed = time.monotonic() - started
            self.assertTrue(forced, "到点仍在飞 ⇒ 强制")
            self.assertFalse(drained)
            self.assertGreaterEqual(elapsed, 0.15, "确曾等待（上限内）")
            self.assertLess(elapsed, 2.0, "不超过（太多于）排空上限")
            self.assertEqual(calls, [True], "钩子以 force=True 调用（force_exit）")

        asyncio.run(scenario())

    def test_drain_and_exit_hook_throw_swallowed(self):
        # 钩子契约是同步 hook(force)（server.py 注入的翻转器即同步）——
        # 同步抛错必须被吞（关停路径不得被钩子拖死）
        def bad_hook(force: bool) -> None:
            raise RuntimeError("hook exploded")

        async def scenario() -> None:
            routes.register_shutdown_hook(bad_hook)
            forced, _ = await routes.drain_and_exit(max_wait_s=0.05)  # 不得抛

        asyncio.run(scenario())  # 未抛即过

    def test_shutdown_endpoint_first_call_drains_and_schedules(self):
        async def scenario() -> None:
            self.assertFalse(routes.is_draining())
            resp = await routes.shutdown()  # safe_call 包装 ⇒ 完整成功信封
            self.assertEqual(resp["status"], "success")
            self.assertTrue(resp["data"]["draining"])
            self.assertFalse(resp["data"]["already_draining"])
            self.assertTrue(routes.is_draining(), "收到即置 draining（新请求将被拒）")
            # 幂等：二次调用成功信封 + already_draining（draining 期本端点放行）
            resp2 = await routes.shutdown()
            self.assertEqual(resp2["status"], "success")
            self.assertTrue(resp2["data"]["already_draining"])
            # 后台排空任务已排程（无在飞 ⇒ 快速完成，不挂测试进程）
            await asyncio.sleep(0.1)

        asyncio.run(scenario())

    def test_shutdown_endpoint_rejects_via_drain_verdict_immediately(self):
        # 端点置位后，同进程其他端点的中间件判决立即可见（顺序保证）
        async def scenario() -> None:
            await routes.shutdown()
            self.assertTrue(routes.drain_should_reject("/v1/click_mouse"))
            self.assertFalse(routes.drain_should_reject("/v1/shutdown"))

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
