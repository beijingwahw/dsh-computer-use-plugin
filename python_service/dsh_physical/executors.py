"""ΑΩ-R25 专属执行器隔离 —— 按控制器分池的有界 worker 池注册表。

背景（head-of-line blocking）：uvicorn 单 worker（UDS 抢占防护），而
input/screen/uvc/hid/android 等全部 ``run_in_executor(None, ...)`` 共享
asyncio 缺省线程池 —— 一个慢 adb 子进程（15s 超时）或大图 PNG 编码可拖住
其他物理动作（截图排队在 adb 后、点击排队在编码后）。

分池（按工作的**性质**而非按文件 —— 同一控制器里"读硬件"与"编码图像"
进不同池，正是隔离的意义）：

  ``input``  输入注入：pyautogui 动作 / 光标读取 / 切窗 —— 小而快
  ``screen`` 截屏/图像：ImageGrab 抓帧、PIL 编码/裁剪/显著度、帧环统计 —— CPU 有界
  ``device`` 外部设备：adb/scrcpy 子进程、UVC 硬件读帧、HID 串口、WASAPI COM —— 容忍长阻塞
  ``tree``   UI 树/OCR：UIA 结构查询、RapidOCR 推理、本地 VLM —— 重 CPU 有界

容量论证（各有界，env 可调，见 config.ExecutorConfig）：
  - input=2：物理动作本就被 ``_io_lock`` 串行化（一副手只有一个），第 2 个
    worker 只为 ``get_screen_size``/悬停探针不排在长 typewrite（万字符注入）
    后面；更多 worker 只会引入乱序注入风险，无吞吐收益。
  - screen=4：单次 1080p PNG 编码/显著度约 100-500ms；4 并发覆盖"截图 +
    ui_tree 的 L2 截屏 + frame_stats + 显示器枚举"同场竞争，又不超订典型
    4-8 核宿主（CPU-bound 池超过核数只剩上下文切换）。
  - device=6：全部是长阻塞 I/O（adb 15s 超时、串口 timeout、cv2 首帧），
    线程在阻塞时不占 CPU；6 容纳"多设备清单 + 单帧链 + UVC 取帧 + HID
    写帧 + 声学建链"同时挂起而不互相排队，内存代价仅 6 个栈。
  - tree=2：OCR/VLM 推理是重 CPU+内存工作，>2 并发互相拖慢且常驻引擎
    （RapidOCR/llama）非线程安全的使用会串行化在引擎内部锁上；2 即饱和。

ΠΑΝ-93 三项加固（本模块自有 ``BoundedWorkerPool`` 替换 ``ThreadPoolExecutor``）：
  1. **队列有界 + 拒绝语义**：TPE 的内置队列无界 —— worker 有界而队列无界时
     队头阻塞只是搬家（无限排队后逐一超时，客户端看到超时信封而非背压）。
     现在队列深度达上界 ⇒ ``PhysicalError(BUSY)``（safe_call ⇒ 200 + 结构化
     busy 信封，背压可见，TS 端可退避重试）。
  2. **队列深度指标**：``describe()`` 申报每池 queue_depth / queue_limit /
     in_flight / rejected_total —— 队头阻塞复发时可诊断（/v1/stats 的
     executors 面）。
  3. **优雅关停 deadline + abandon**：TPE 的 worker 非 daemon 且被
     ``concurrent.futures`` 的解释器退出钩子 join —— 卡在 adb 15s 的 worker
     把进程退出拖满 15s（Node serviceManager 超窗 SIGKILL ⇒ mmap/子进程孤儿）。
     本池 worker 是 daemon 线程且不经 ``concurrent.futures`` 注册表 ——
     ``shutdown`` 给 worker **有界期限**（join_timeout_s），到点放弃汇合
     （abandoned_workers 如实申报），进程退出不等卡死 worker。

死锁自检（ΑΩ-R25 纪律）：本注册表的所有用法都是「异步上下文 → 提交 →
await 完成释放 worker → 下一次提交」的**顺序**调用；任何被提交的同步函数
（pyautogui/PIL/adb runner/串口/OCR 引擎）都不再向上提交 executor ——
不存在同池嵌套提交（嵌套 + 有界 = 经典自锁）。scrcpyStream 的读线程/
看门狗是自有 ``threading.Thread``，不经本注册表。

生命周期：FastAPI lifespan 启动期 ``startup()`` 建池（server.py 挂钩），
关停期 ``shutdown_all()``（cancel_futures + 有界 join + 放弃语义）；
模块导入期 ``atexit`` 兜底（lifespan 未走到的异常退出路径）。池为惰性
单例：未 startup（单元测试直构控制器）时首次 ``get()`` 按缺省容量自建 ——
selftest 无需启动服务即可全绿。
"""
from __future__ import annotations

import asyncio
import atexit
import functools
import queue
import threading
import time
from concurrent.futures import Future
from typing import Callable

from .config import ExecutorConfig
from .errors import ErrorKind, PhysicalError

# ─── 池名（稳定字符串键 —— 控制器侧只认名字，不持池引用）───

INPUT_POOL = "input"
SCREEN_POOL = "screen"
DEVICE_POOL = "device"
TREE_POOL = "tree"

_ALL_POOLS = (INPUT_POOL, SCREEN_POOL, DEVICE_POOL, TREE_POOL)

# 缺省容量（ExecutorConfig 缺省的单一事实源镜像 —— 惰性建池在 configure()
# 之前发生时的兜底；startup() 之后以 config 为准）
_DEFAULT_SIZES: dict[str, int] = {
    INPUT_POOL: 2,
    SCREEN_POOL: 4,
    DEVICE_POOL: 6,
    TREE_POOL: 2,
}

# ΠΑΝ-93：缺省队列上界（同上单一事实源镜像 —— 取「正常峰值排队深度的宽裕
# 倍数」：正常流量深度 ~0，队满只在池被拖死时发生，届时 busy 拒绝即背压信号）
_DEFAULT_QUEUES: dict[str, int] = {
    INPUT_POOL: 128,
    SCREEN_POOL: 64,
    DEVICE_POOL: 128,
    TREE_POOL: 64,
}

# ΠΑΝ-93：优雅关停的 worker 汇合期限（秒）。给健康 worker 足够时间收尾在飞
# 动作；卡在 adb 15s 的 worker 到点放弃（daemon：进程退出不 join —— 解释器
# 只 join 非 daemon 线程，且本池不经 concurrent.futures 的全局退出注册表）。
_SHUTDOWN_JOIN_DEADLINE_S = 0.5

# ΠΑΝ-93：worker 空闲轮询周期（秒）—— shutdown 标志的最坏可见延迟。
_WORKER_POLL_S = 0.2

_pools: dict[str, "BoundedWorkerPool"] = {}
_sizes: dict[str, int] = dict(_DEFAULT_SIZES)
_queues: dict[str, int] = dict(_DEFAULT_QUEUES)
_lock = threading.Lock()  # 惰性建池的双检锁（多事件循环/测试并发首调安全）


class BoundedWorkerPool:
    """ΠΑΝ-93：有界队列 + busy 拒绝 + 深度指标 + daemon worker 的执行器池。

    ``submit`` 签名与 ``ThreadPoolExecutor`` 逐参兼容（``loop.run_in_executor``
    直接可用）；返回 ``concurrent.futures.Future``（asyncio wrap_future 无感）。
    队满 ⇒ ``PhysicalError(BUSY)``（结构化信封经 safe_call 面 TS）。
    """

    def __init__(self, max_workers: int, queue_limit: int, name_prefix: str) -> None:
        self._workers_n = max(1, int(max_workers))
        self.queue_limit = max(1, int(queue_limit))
        self._q: "queue.Queue[tuple | None]" = queue.Queue(maxsize=self.queue_limit)
        self._shutdown = False
        self._lock = threading.Lock()
        self._stats_lock = threading.Lock()
        self._rejected = 0
        self._in_flight = 0
        self._completed = 0
        self.abandoned_workers = 0  # ΠΑΝ-93：关停到点放弃汇合的 worker 数（诊断面）
        self._workers = [
            threading.Thread(
                target=self._worker, name=f"{name_prefix}-{i}", daemon=True,
            )
            for i in range(self._workers_n)
        ]
        for w in self._workers:
            w.start()

    # 诊断兼容属性：旧代码/selftest 读 ``pool._max_workers``（TPE 私有属性的
    # 既有方言）—— 公开只读属性承接，避免四处 noqa。
    @property
    def _max_workers(self) -> int:  # noqa: SLF001 —— 历史诊断方言的兼容面
        return self._workers_n

    @property
    def max_workers(self) -> int:
        return self._workers_n

    def submit(self, fn: Callable, /, *args, **kwargs) -> Future:
        """提交任务（kwargs 经 partial 绑定后入队）。队满 ⇒ BUSY 拒绝（不抛裸异常）。"""
        with self._lock:
            if self._shutdown:
                # 与 TPE 同方言：关停后提交 = RuntimeError（get() 的按需重建
                # 覆盖关停窗口期迟到请求的优雅降级 —— 见 shutdown_all 注）
                raise RuntimeError("cannot schedule new futures after shutdown")
        fut: Future = Future()
        try:
            self._q.put_nowait((fut, fn, args, kwargs))
        except queue.Full:
            # ΠΑΝ-93：背压可见 —— 队列深度达上界即拒绝为结构化 busy 信封，
            # 不再无限排队后逐一超时（客户端能区分「没排上」与「做超时」）。
            with self._stats_lock:
                self._rejected += 1
            raise PhysicalError(
                ErrorKind.BUSY,
                f"executor pool queue full: depth reached limit "
                f"{self.queue_limit} (busy = backpressure, retry after a pause)",
            ) from None
        return fut

    def _worker(self) -> None:
        while True:
            try:
                item = self._q.get(timeout=_WORKER_POLL_S)
            except queue.Empty:
                if self._shutdown:
                    return
                continue
            if item is None:  # shutdown 哨兵：立即收工
                return
            fut, fn, args, kwargs = item
            if not fut.set_running_or_notify_cancel():
                continue  # 排队期被取消：跳过执行（cancel_futures 的 worker 侧）
            with self._stats_lock:
                self._in_flight += 1
            try:
                fut.set_result(fn(*args, **kwargs))
                with self._stats_lock:
                    self._completed += 1
            except BaseException as e:  # noqa: BLE001 —— Future 契约：异常必经 set_exception
                fut.set_exception(e)
            finally:
                with self._stats_lock:
                    self._in_flight -= 1

    def shutdown(self, wait: bool = True, *, cancel_futures: bool = False,
                 join_timeout_s: float = _SHUTDOWN_JOIN_DEADLINE_S) -> dict:
        """关停：排队任务取消 + 唤醒 worker + （wait=True 时）**有界**汇合。

        ΠΑΝ-93 的 deadline + abandon 语义：``wait=True`` 给每个 worker 至多
        ``join_timeout_s`` 的收尾期限，到点放弃（daemon 线程不阻塞进程退出；
        ``abandoned_workers`` 如实申报）。返回诊断 dict（永不抛）。
        """
        with self._lock:
            self._shutdown = True
        if cancel_futures:
            while True:
                try:
                    item = self._q.get_nowait()
                except queue.Empty:
                    break
                if item is None:
                    continue
                item[0].cancel()
        for _ in self._workers:  # 唤醒空闲 worker（队列满时哨兵投放失败无害：轮询兜底）
            try:
                self._q.put_nowait(None)
            except queue.Full:
                break
        abandoned = 0
        if wait:
            # 期限是**池级**共享预算（ΠΑΝ-93）：逐 worker join 但共扣同一
            # deadline，而非 n×timeout —— 关停总时长有上界；到点放弃的
            # worker 数如实申报（daemon：进程退出不 join 它们）。
            deadline = time.monotonic() + max(0.0, join_timeout_s)
            for w in self._workers:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    w.join(timeout=0)
                else:
                    w.join(timeout=remaining)
            abandoned = sum(1 for w in self._workers if w.is_alive())
            self.abandoned_workers = abandoned
        return {"max_workers": self._workers_n, "abandoned_workers": abandoned}

    # ── 诊断面（ΠΑΝ-93 深度指标；只读、近似即时）──

    @property
    def queue_depth(self) -> int:
        return self._q.qsize()

    @property
    def in_flight(self) -> int:
        with self._stats_lock:
            return self._in_flight

    @property
    def rejected_total(self) -> int:
        with self._stats_lock:
            return self._rejected

    @property
    def completed_total(self) -> int:
        with self._stats_lock:
            return self._completed


def configure(config: ExecutorConfig) -> None:
    """ΑΩ-R25：启动期注入容量与队列上界（config.py → 池参数）。

    必须在 ``startup()`` 之前调用（startup 按本表建池）；已建的池不受影响
    （lifespan 顺序：configure → startup，正常路径无竞态）。ΠΑΝ-94：config
    层已保证 workers/queues ≥ 1（越界拒绝方言），此处 max(1,·) 仅防御直构
    ExecutorConfig 的调用方。
    """
    with _lock:
        _sizes.update({
            INPUT_POOL: config.input_workers,
            SCREEN_POOL: config.screen_workers,
            DEVICE_POOL: config.device_workers,
            TREE_POOL: config.tree_workers,
        })
        _queues.update({
            INPUT_POOL: config.input_queue,
            SCREEN_POOL: config.screen_queue,
            DEVICE_POOL: config.device_queue,
            TREE_POOL: config.tree_queue,
        })


def get(name: str) -> BoundedWorkerPool:
    """取池（惰性单例；缺席 = 未 startup 的测试路径 ⇒ 按当前容量/队列自建）。"""
    pool = _pools.get(name)
    if pool is not None:
        return pool
    with _lock:
        pool = _pools.get(name)
        if pool is not None:
            return pool
        pool = BoundedWorkerPool(
            max_workers=_sizes.get(name, _DEFAULT_SIZES[name]),
            queue_limit=_queues.get(name, _DEFAULT_QUEUES[name]),
            name_prefix=f"dsh-exec-{name}",  # ΑΩ-R25：诊断时可辨池归属
        )
        _pools[name] = pool
        return pool


def startup(config: ExecutorConfig | None = None) -> dict[str, int]:
    """ΑΩ-R25：lifespan 启动钩 —— 建全部四池（eager，容量进诊断回执）。"""
    if config is not None:
        configure(config)
    return {name: get(name).max_workers for name in _ALL_POOLS}


def shutdown_all(join_timeout_s: float = _SHUTDOWN_JOIN_DEADLINE_S) -> dict[str, dict]:
    """ΑΩ-R25 + ΠΑΝ-93：lifespan 关停钩 + atexit 兜底。

    - ``cancel_futures``：排队未启动的任务直接取消（关停后到达的工作不再
      执行是关停语义，不是丢帧 —— 客户端按失败信封重试）；
    - **deadline + abandon**：给每个 worker 至多 ``join_timeout_s`` 的收尾
      期限，到点放弃（卡在 adb 15s 的 worker 不再拖住服务下线 —— 本池
      worker 为 daemon 且不经 concurrent.futures 的解释器退出 join 注册表，
      进程退出不等它们；放弃数在各池 ``abandoned_workers`` 如实申报）。
    幂等：重复调用无害；shutdown 后的 ``get()`` 会按需重建（关停窗口期
    迟到请求的优雅降级，而非 RuntimeError）。
    """
    with _lock:
        shut: dict[str, dict] = {}
        for name in list(_pools):
            pool = _pools.pop(name)
            try:
                shut[name] = pool.shutdown(
                    wait=True, cancel_futures=True, join_timeout_s=join_timeout_s,
                )
            except Exception:  # noqa: BLE001 —— 关停路径绝不抛（铁律）
                pass
        return shut


def _atexit_shutdown() -> None:
    """ΑΩ-R25：解释器退出兜底（lifespan 未走到的异常退出路径）。

    ΠΑΝ-93：daemon worker 不被解释器 join —— 此钩只做取消排队 + 短期限
    汇合（0.2s），异常退出路径同样不被卡死 worker 拖住。
    """
    shutdown_all(join_timeout_s=0.2)


atexit.register(_atexit_shutdown)


# ─── 提交助手（run_in_executor 的池化版本）───


async def run_in(name: str, func: Callable, *args, **kwargs):
    """ΑΩ-R25：把同步阻塞调用丢进**专属池**（``run_in_executor(None,..)`` 的替换）。

    与 ``loop.run_in_executor`` 同语义（含 kwargs 经 ``functools.partial``
    绑定 —— input.py J 纪元修复的方言延续）；差异有二：executor 从缺省
    共享池换成按池名隔离的有界池；ΠΑΝ-93 起队满 ⇒ ``PhysicalError(BUSY)``
    （safe_call ⇒ 结构化 busy 信封，背压可见）。
    """
    loop = asyncio.get_running_loop()
    if kwargs:
        return await loop.run_in_executor(get(name), functools.partial(func, *args, **kwargs))
    return await loop.run_in_executor(get(name), func, *args)


def describe() -> dict:
    """池态诊断（诊断/测试用；只读，永不抛）。ΠΑΝ-93：申报队列深度指标。"""
    with _lock:
        return {
            "pools": {
                name: {
                    "max_workers": pool.max_workers,
                    "queue_depth": pool.queue_depth,
                    "queue_limit": pool.queue_limit,
                    "in_flight": pool.in_flight,
                    "rejected_total": pool.rejected_total,
                }
                for name, pool in _pools.items()
            },
            "sizes": dict(_sizes),
            "queues": dict(_queues),
        }


# ─── ΑΩ-R25 自测入口：python -m dsh_physical.executors --selftest ───
# 覆盖：分池隔离（慢设备任务不拖输入）、容量有界、shutdown 幂等 + 重建、
# kwargs 透传、run_in 与裸 run_in_executor 结果一致；ΠΑΝ-93 追加：队列上界
# busy 拒绝 + 深度指标 + daemon worker + deadline/abandon 关停。


def _run_selftest() -> int:
    import time as _time

    failures: list[str] = []

    def check(name: str, cond: bool) -> None:
        print(f"[{'PASS' if cond else 'FAIL'}] {name}")
        if not cond:
            failures.append(name)

    # 1. 惰性建池 + 容量/队列有界 + 线程名可辨 + ΠΑΝ-93 daemon
    shutdown_all()
    p_in = get(INPUT_POOL)
    p_dev = get(DEVICE_POOL)
    check("lazy pools distinct per name", p_in is not p_dev)
    check("input pool bounded at 2", p_in._max_workers == 2)  # noqa: SLF001
    check("device pool bounded at 6", p_dev._max_workers == 6)  # noqa: SLF001
    check("queue limits default (128/64)", p_in.queue_limit == 128 and p_dev.queue_limit == 128)
    check("ΠΑΝ-93 workers are daemon (exit not joined)",
          all(w.daemon for w in p_dev._workers))  # noqa: SLF001

    # 2. 隔离执法：device 池全占 1.2s，input 池仍即时完成（分池的意义）
    blockers = [get(DEVICE_POOL).submit(_time.sleep, 1.2) for _ in range(6)]

    async def _isolation_probe() -> float:
        t0 = _time.monotonic()
        await run_in(INPUT_POOL, _time.sleep, 0.01)
        return _time.monotonic() - t0

    elapsed = asyncio.run(_isolation_probe())
    check("input not blocked behind device pool (elapsed<0.5s)", elapsed < 0.5)
    for b in blockers:
        b.cancel()

    # 3. run_in：位置参/kwargs 透传 + 结果/异常语义与裸 executor 一致
    def _add(a: int, b: int, *, scale: int = 1) -> int:
        return (a + b) * scale

    async def _results() -> tuple[int, int, int]:
        pos = await run_in(INPUT_POOL, _add, 2, 3)
        kw = await run_in(INPUT_POOL, _add, 2, 3, scale=10)
        native = await asyncio.get_running_loop().run_in_executor(
            None, functools.partial(_add, 2, 3, scale=10),
        )
        return pos, kw, native

    pos, kw, native = asyncio.run(_results())
    check("run_in positional args", pos == 5)
    check("run_in kwargs bound", kw == 50)  # (2+3)*10 —— 手算对照
    check("run_in matches native executor result", kw == native)

    async def _raises() -> bool:
        try:
            await run_in(INPUT_POOL, _raise_value_error)
        except ValueError:
            return True
        return False

    def _raise_value_error() -> None:
        raise ValueError("boom")

    check("run_in propagates exceptions", asyncio.run(_raises()))

    # 4. ΠΑΝ-93：队列上界 ⇒ busy 拒绝 + 深度指标
    shutdown_all()
    configure(ExecutorConfig(input_workers=1, screen_workers=1, device_workers=1,
                             tree_workers=1, input_queue=2, screen_queue=2,
                             device_queue=2, tree_queue=2))
    busy_pool = get(INPUT_POOL)  # 1 worker, queue 2
    busy_pool.submit(_time.sleep, 0.8)  # 首件：等它真正跑起来（消除入队竞态）
    _dl = _time.monotonic() + 2.0
    while busy_pool.in_flight < 1 and _time.monotonic() < _dl:
        _time.sleep(0.01)
    blockers2 = [busy_pool.submit(_time.sleep, 0.8) for _ in range(2)]  # 恰好填满队列

    async def _busy_probe() -> str | None:
        try:
            await run_in(INPUT_POOL, _time.sleep, 0.01)
        except PhysicalError as e:
            return e.kind.value if e.kind is ErrorKind.BUSY else f"wrong-kind:{e.kind}"
        return None

    kind = asyncio.run(_busy_probe())
    check("ΠΑΝ-93 queue full rejects as busy envelope", kind == "busy")
    d4 = describe()["pools"].get(INPUT_POOL, {})
    check("ΠΑΝ-93 depth metrics visible",
          d4.get("queue_limit") == 2 and d4.get("rejected_total", 0) >= 1
          and d4.get("queue_depth", 0) >= 1)
    for b in blockers2:
        b.cancel()
    shutdown_all()
    configure(ExecutorConfig())  # 还原缺省，避免污染后续测试

    # 5. ΠΑΝ-93：deadline + abandon —— 卡死 worker 不拖住关停，池可重建
    stuck_pool = get(DEVICE_POOL)
    stuck = stuck_pool.submit(_time.sleep, 3.0)  # 卡 3s（远超期限）
    _dl5 = _time.monotonic() + 2.0
    while stuck_pool.in_flight < 1 and _time.monotonic() < _dl5:
        _time.sleep(0.01)  # 等它真正在飞（否则 cancel_futures 会在排队期取消它）
    t0 = _time.monotonic()
    shut = shutdown_all(join_timeout_s=0.1)
    elapsed5 = _time.monotonic() - t0
    check("ΠΑΝ-93 shutdown bounded (deadline, <1.5s)", elapsed5 < 1.5)
    check("ΠΑΝ-93 stuck worker abandoned honestly",
          shut.get(DEVICE_POOL, {}).get("abandoned_workers", 0) >= 1)
    stuck.cancel()
    p_reborn5 = get(INPUT_POOL)
    check("pool rebuilt after shutdown (drain-window tolerance)", p_reborn5 is not p_in)

    # 6. shutdown 幂等 + cancel_futures + 关停后 get() 重建（迟到请求降级）
    shutdown_all()
    shutdown_all()  # 幂等：第二次为 no-op，不抛
    check("shutdown idempotent", True)
    p_reborn = get(INPUT_POOL)
    check("pool rebuilt after shutdown (drain-window tolerance)", p_reborn is not p_in)

    # 7. configure()：容量注入在建池前生效（startup 顺序的契约）
    shutdown_all()
    configure(ExecutorConfig(input_workers=3, screen_workers=5, device_workers=7, tree_workers=1))
    check("configure sizes take effect", get(TREE_POOL)._max_workers == 1)  # noqa: SLF001
    shutdown_all()
    configure(ExecutorConfig())  # 还原缺省，避免污染后续测试

    # 8. describe()：只读诊断
    d = describe()
    check("describe lists sizes", isinstance(d.get("sizes"), dict) and len(d["sizes"]) == 4)
    get(SCREEN_POOL)
    d8 = describe()
    check("describe exposes per-pool depth face",
          isinstance(d8["pools"].get(SCREEN_POOL, {}).get("queue_depth"), int))

    shutdown_all()
    print(f"\nexecutors selftest: {'OK' if not failures else 'FAILED: ' + '; '.join(failures)}")
    return 0 if not failures else 1


if __name__ == "__main__":
    import sys as _sys

    if "--selftest" in _sys.argv:
        raise SystemExit(_run_selftest())
    print("usage: python -m dsh_physical.executors --selftest")
    raise SystemExit(2)
