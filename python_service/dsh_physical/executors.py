"""ΑΩ-R25 专属执行器隔离 —— 按控制器分池的有界 ThreadPoolExecutor 注册表。

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

死锁自检（ΑΩ-R25 纪律）：本注册表的所有用法都是「异步上下文 → 提交 →
await 完成释放 worker → 下一次提交」的**顺序**调用；任何被提交的同步函数
（pyautogui/PIL/adb runner/串口/OCR 引擎）都不再向上提交 executor ——
不存在同池嵌套提交（嵌套 + 有界 = 经典自锁）。scrcpyStream 的读线程/
看门狗是自有 ``threading.Thread``，不经本注册表。

生命周期：FastAPI lifespan 启动期 ``startup()`` 建池（server.py 挂钩），
关停期 ``shutdown_all()``（wait=False：不等待在飞动作，排队任务取消）；
模块导入期 ``atexit`` 兜底（lifespan 未走到的异常退出路径）。池为惰性
单例：未 startup（单元测试直构控制器）时首次 ``get()`` 按缺省容量自建 ——
selftest 无需启动服务即可全绿。
"""
from __future__ import annotations

import asyncio
import atexit
import functools
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

from .config import ExecutorConfig

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

_pools: dict[str, ThreadPoolExecutor] = {}
_sizes: dict[str, int] = dict(_DEFAULT_SIZES)
_lock = threading.Lock()  # 惰性建池的双检锁（多事件循环/测试并发首调安全）


def configure(config: ExecutorConfig) -> None:
    """ΑΩ-R25：启动期注入容量（config.py 的 ExecutorConfig → 池尺寸）。

    必须在 ``startup()`` 之前调用（startup 按本表建池）；已建的池不受影响
    （lifespan 顺序：configure → startup，正常路径无竞态）。
    """
    with _lock:
        _sizes.update({
            INPUT_POOL: config.input_workers,
            SCREEN_POOL: config.screen_workers,
            DEVICE_POOL: config.device_workers,
            TREE_POOL: config.tree_workers,
        })


def get(name: str) -> ThreadPoolExecutor:
    """取池（惰性单例；缺席 = 未 startup 的测试路径 ⇒ 按当前容量自建）。"""
    pool = _pools.get(name)
    if pool is not None:
        return pool
    with _lock:
        pool = _pools.get(name)
        if pool is not None:
            return pool
        pool = ThreadPoolExecutor(
            max_workers=max(1, _sizes.get(name, _DEFAULT_SIZES[name])),
            thread_name_prefix=f"dsh-exec-{name}",  # ΑΩ-R25：诊断时可辨池归属
        )
        _pools[name] = pool
        return pool


def startup(config: ExecutorConfig | None = None) -> dict[str, int]:
    """ΑΩ-R25：lifespan 启动钩 —— 建全部四池（eager，容量进诊断回执）。"""
    if config is not None:
        configure(config)
    return {name: get(name)._max_workers for name in _ALL_POOLS}  # noqa: SLF001 —— 同模块私有诊断


def shutdown_all() -> dict[str, int]:
    """ΑΩ-R25：lifespan 关停钩 + atexit 兜底 —— ``shutdown(wait=False)``。

    wait=False：不等待在飞的长阻塞动作（adb 15s 超时不能拖住服务下线）；
    cancel_futures=True：排队未启动的任务直接取消（关停后到达的工作不再
    执行是关停语义，不是丢帧 —— 客户端按失败信封重试）。
    幂等：重复调用无害；shutdown 后的 ``get()`` 会按需重建（关停窗口期
    迟到请求的优雅降级，而非 RuntimeError）。
    """
    with _lock:
        shut: dict[str, int] = {}
        for name in list(_pools):
            pool = _pools.pop(name)
            try:
                pool.shutdown(wait=False, cancel_futures=True)
                shut[name] = pool._max_workers  # noqa: SLF001 —— 同模块私有诊断
            except Exception:  # noqa: BLE001 —— 关停路径绝不抛（铁律）
                pass
        return shut


def _atexit_shutdown() -> None:
    """ΑΩ-R25：解释器退出兜底（lifespan 未走到的异常退出路径）。"""
    shutdown_all()


atexit.register(_atexit_shutdown)


# ─── 提交助手（run_in_executor 的池化版本）───


async def run_in(name: str, func: Callable, *args, **kwargs):
    """ΑΩ-R25：把同步阻塞调用丢进**专属池**（``run_in_executor(None,..)`` 的替换）。

    与 ``loop.run_in_executor`` 同语义（含 kwargs 经 ``functools.partial``
    绑定 —— input.py J 纪元修复的方言延续）；唯一差异是 executor 从缺省
    共享池换成按池名隔离的有界池。
    """
    loop = asyncio.get_running_loop()
    if kwargs:
        return await loop.run_in_executor(get(name), functools.partial(func, *args, **kwargs))
    return await loop.run_in_executor(get(name), func, *args)


def describe() -> dict:
    """池态诊断（诊断/测试用；只读，永不抛）。"""
    with _lock:
        return {
            "pools": {
                name: {"max_workers": pool._max_workers}  # noqa: SLF001
                for name, pool in _pools.items()
            },
            "sizes": dict(_sizes),
        }


# ─── ΑΩ-R25 自测入口：python -m dsh_physical.executors --selftest ───
# 覆盖：分池隔离（慢设备任务不拖输入）、容量有界、shutdown 幂等 + 重建、
# kwargs 透传、run_in 与裸 run_in_executor 结果一致。


def _run_selftest() -> int:
    import time as _time

    failures: list[str] = []

    def check(name: str, cond: bool) -> None:
        print(f"[{'PASS' if cond else 'FAIL'}] {name}")
        if not cond:
            failures.append(name)

    # 1. 惰性建池 + 容量有界 + 线程名可辨
    shutdown_all()
    p_in = get(INPUT_POOL)
    p_dev = get(DEVICE_POOL)
    check("lazy pools distinct per name", p_in is not p_dev)
    check("input pool bounded at 2", p_in._max_workers == 2)  # noqa: SLF001
    check("device pool bounded at 6", p_dev._max_workers == 6)  # noqa: SLF001

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

    # 4. shutdown 幂等 + cancel_futures + 关停后 get() 重建（迟到请求降级）
    shutdown_all()
    shutdown_all()  # 幂等：第二次为 no-op，不抛
    check("shutdown idempotent", True)
    p_reborn = get(INPUT_POOL)
    check("pool rebuilt after shutdown (drain-window tolerance)", p_reborn is not p_in)

    # 5. configure()：容量注入在建池前生效（startup 顺序的契约）
    shutdown_all()
    configure(ExecutorConfig(input_workers=3, screen_workers=5, device_workers=7, tree_workers=1))
    check("configure sizes take effect", get(TREE_POOL)._max_workers == 1)  # noqa: SLF001
    shutdown_all()
    configure(ExecutorConfig())  # 还原缺省，避免污染后续测试

    # 6. describe()：只读诊断
    d = describe()
    check("describe lists sizes", isinstance(d.get("sizes"), dict) and len(d["sizes"]) == 4)

    shutdown_all()
    print(f"\nexecutors selftest: {'OK' if not failures else 'FAILED: ' + '; '.join(failures)}")
    return 0 if not failures else 1


if __name__ == "__main__":
    import sys as _sys

    if "--selftest" in _sys.argv:
        raise SystemExit(_run_selftest())
    print("usage: python -m dsh_physical.executors --selftest")
    raise SystemExit(2)
