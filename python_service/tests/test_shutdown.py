"""ΝΩ-27 优雅关停 drain 语义单测（离线：零 uvicorn/零网络）。

``POST /v1/shutdown`` 收到即：
  1. 置 draining 标志 —— drain_should_reject 对新请求（自身除外）判决拒绝；
  2. 后台排空：等在飞（drain_enter/leave 计数）完成，上限 3s，到点强制；
  3. 触发退出钩子 hook(force) —— 钩子缺席（测试形态）⇒ 仅排空不退出。

Windows 上 SIGTERM 即硬杀，Node 端 3s 优雅窗形同虚设 —— 本端点是其躯体。

ΠΑΝ-93 追加：执行器池的关停纪律（deadline + abandon —— 卡 adb 15s 的
worker 不拖住进程退出）与背压纪律（队列上界 ⇒ busy 信封 + 深度指标）。
"""
import asyncio
import sys
import time
import unittest
from pathlib import Path

_SVC_ROOT = str(Path(__file__).resolve().parents[1])
if _SVC_ROOT not in sys.path:
    sys.path.insert(0, _SVC_ROOT)

from dsh_physical import executors, routes  # noqa: E402
from dsh_physical.config import ExecutorConfig  # noqa: E402
from dsh_physical.errors import ErrorKind, PhysicalError  # noqa: E402


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


class ExecutorPoolDisciplineTests(unittest.TestCase):
    """ΠΑΝ-93：队列上界 busy 拒绝 + 深度指标 + deadline/abandon 关停纪律。"""

    def setUp(self):
        executors.shutdown_all()
        executors.configure(ExecutorConfig(
            input_workers=1, screen_workers=1, device_workers=1, tree_workers=1,
            input_queue=2, screen_queue=2, device_queue=2, tree_queue=2,
        ))

    def tearDown(self):
        # 还原缺省配置并清池：小容量/小队列不泄漏给后续测试（隔离铁律）
        for f in getattr(self, "_cleanup_futures", []):
            f.cancel()
        executors.shutdown_all()
        executors.configure(ExecutorConfig())
        executors.shutdown_all()

    def _wait_in_flight(self, pool, target=1, budget=2.0) -> None:
        dl = time.monotonic() + budget
        while pool.in_flight < target and time.monotonic() < dl:
            time.sleep(0.01)

    def test_queue_full_rejects_as_busy_envelope(self):
        """队满 ⇒ PhysicalError(BUSY)（safe_call ⇒ 200 + 结构化 busy 信封）。"""
        pool = executors.get(executors.INPUT_POOL)  # 1 worker / queue 2
        self._cleanup_futures = [pool.submit(time.sleep, 0.8)]
        self._wait_in_flight(pool)
        # 恰好两条排队项填满队列（首条已被 worker 取走在飞）
        self._cleanup_futures += [pool.submit(time.sleep, 0.8) for _ in range(2)]

        async def probe():
            await executors.run_in(executors.INPUT_POOL, time.sleep, 0.01)

        with self.assertRaises(PhysicalError) as ctx:
            asyncio.run(probe())
        self.assertIs(ctx.exception.kind, ErrorKind.BUSY)
        self.assertIn("queue full", ctx.exception.detail)

    def test_depth_metrics_visible_in_describe(self):
        """背压可观测：queue_depth/queue_limit/in_flight/rejected_total 在场。"""
        pool = executors.get(executors.DEVICE_POOL)
        self._cleanup_futures = [pool.submit(time.sleep, 0.6)]
        self._wait_in_flight(pool)
        self._cleanup_futures.append(pool.submit(time.sleep, 0.6))
        face = executors.describe()["pools"]["device"]
        self.assertEqual(face["queue_limit"], 2)
        self.assertEqual(face["max_workers"], 1)
        self.assertGreaterEqual(face["queue_depth"], 1)
        self.assertGreaterEqual(face["in_flight"], 1)
        self.assertIn("rejected_total", face)

    def test_shutdown_deadline_abandons_stuck_worker(self):
        """卡 3s 的 worker：关停在期限内返回、放弃汇合并如实申报。"""
        pool = executors.get(executors.SCREEN_POOL)
        stuck = pool.submit(time.sleep, 3.0)  # 模拟卡在 adb/长编码的 worker
        self._cleanup_futures = [stuck]
        self._wait_in_flight(pool)
        t0 = time.monotonic()
        shut = executors.shutdown_all(join_timeout_s=0.05)
        elapsed = time.monotonic() - t0
        self.assertLess(elapsed, 1.0, "关停有界（deadline 语义，不被卡死 worker 拖住）")
        self.assertGreaterEqual(shut["screen"]["abandoned_workers"], 1,
                                "放弃汇合的 worker 如实申报（诚实 abandon）")
        rebuilt = executors.get(executors.SCREEN_POOL)
        self.assertIsNot(rebuilt, pool, "关停后 get() 按需重建（迟到请求降级）")

    def test_workers_are_daemon_interpreter_exit_not_joined(self):
        """worker 是 daemon 且不经 concurrent.futures 退出注册表 —— 解释器
        退出不汇合（卡 adb 15s 的 worker 不拖住进程下线的结构保证）。"""
        pool = executors.get(executors.TREE_POOL)
        self.assertTrue(all(w.daemon for w in pool._workers))
        import concurrent.futures.thread as cft

        registered = [t for t, _q in getattr(cft, "_threads_queues", {}).items()
                      if t in pool._workers]
        self.assertEqual(registered, [], "不在 concurrent.futures 全局 join 注册表")

    def test_queued_futures_cancelled_on_shutdown(self):
        """cancel_futures：排队未启动的任务直接取消（await 侧 CancelledError）。"""
        pool = executors.get(executors.INPUT_POOL)
        self._cleanup_futures = [pool.submit(time.sleep, 0.05)]
        self._wait_in_flight(pool)
        queued = pool.submit(lambda: "never-run")
        executors.shutdown_all(join_timeout_s=0.0)
        self.assertTrue(queued.cancelled() or queued.done(),
                        "排队任务被取消/未执行（关停语义，不是丢帧）")


if __name__ == "__main__":
    unittest.main()
