"""异常诚实封装 —— 铁律的代码化。

造物主契约（Step 1 §3）：
  - Python 端捕获所有底层异常，封装为 ``{ status:'failure', error:{kind, detail} }`` 返回
  - HTTP 恒 200，业务成败由 body 中的 ``status`` 判定
    （W6-R-A3 澄清：本「恒 200」契约约束**业务层**失败；auth_middleware 的
    认证拒绝是传输/安全层判决，返回 HTTP 401 + 同款 failure 信封 —— 见
    server.py；信封 JSON 结构两处一致，仅 status_code 不同）
  - 绝不抛出未捕获异常（含 500）

设计：
  ``PhysicalError`` 是受控错误的载体（含分类法 kind）；
  ``safe_call`` 是异常诚实的外壳：把一切异常转 ``MicroResponse``；
  ``unhandled_exception_middleware`` 是最后兜底（ΠΑΝ-95：不宣称「理论不可达」——
  外部世界（adb/COM/第三方库）的未预期异常真实存在，纵深防御不靠自觉）。
"""
from __future__ import annotations

import asyncio
import functools
import time
import traceback
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Awaitable, Callable, Generic, ParamSpec, TypeVar

# ─── 错误分类法（对齐 Step 1 §三）───


class ErrorKind(str, Enum):
    """错误种类枚举。``str`` 基类保证 JSON 序列化为字符串原值。"""

    INVALID_ARGS = "invalid_args"
    OUT_OF_BOUNDS = "out_of_bounds"
    UNKNOWN_BUTTON = "unknown_button"
    UNKNOWN_KEY = "unknown_key"
    ELEMENT_NOT_FOUND = "element_not_found"
    SCREEN_CAPTURE_FAILED = "screen_capture_failed"
    OCR_UNAVAILABLE = "ocr_unavailable"
    VLM_UNAVAILABLE = "vlm_unavailable"
    ACTION_TIMEOUT = "action_timeout"
    WINDOW_UNAVAILABLE = "window_unavailable"
    UNAUTHORIZED = "unauthorized"
    # ΠΑΝ-95：设备级失败（adb 设备离线/未授权/USB 抖动等高频可预期失败）——
    # TS 端可据此与 internal_error 区分做重试/重连策略。此前 `_shell` 一律铸
    # INTERNAL_ERROR，错误分类学被污染。
    DEVICE_UNREACHABLE = "device_unreachable"
    # ΠΑΝ-93：池背压拒绝（队列深度达上界）——不是失败是"忙"，调用方按退避
    # 重试处理（区别于 action_timeout：排队被拒时尚未开始执行，无部分副作用）。
    BUSY = "busy"
    # 兜底：最后防线（诊断栈附带）。ΠΑΝ-95 起「理论不可达」的自我声明删除——
    # adb/COM/第三方库的未预期异常真实存在，分类学不得谎报可达性。
    INTERNAL_ERROR = "internal_error"


@dataclass
class PhysicalError(Exception):
    """受控错误：携带 ``kind`` 与 ``detail``，由 ``safe_call`` 转为失败响应。"""

    kind: ErrorKind
    detail: str

    def __post_init__(self) -> None:
        # dataclass(non-frozen) + Exception 继承：手动 super().__init__ 走通 Exception
        super().__init__(f"[{self.kind.value}] {self.detail}")


# ─── 微服务响应信封（对齐 Step 1 §二）───


T = TypeVar("T")


def success(data: T, latency_ms: int | None = None) -> dict[str, Any]:
    """成功响应铸造器。``latency_ms`` 缺省时由 ``safe_call`` 注入。"""
    return {
        "status": "success",
        "data": data,
        "latency_ms": latency_ms if latency_ms is not None else 0,
    }


def failure(kind: ErrorKind, detail: str, latency_ms: int = 0) -> dict[str, Any]:
    """失败响应铸造器。永不抛错，永远返回结构化 dict。"""
    return {
        "status": "failure",
        "error": {"kind": kind.value, "detail": detail},
        "latency_ms": latency_ms,
    }


# ─── 异常诚实外壳 ───

P = ParamSpec("P")
R = TypeVar("R")


def safe_call(func: Callable[P, Awaitable[R]]) -> Callable[P, Awaitable[R | dict[str, Any]]]:
    """异步函数装饰器：把一切异常转为 ``MicroResponse``。

    - ``PhysicalError``：直接映射其 ``kind``；
    - ``asyncio.TimeoutError``：映射为 ``action_timeout``；
    - 其余 ``Exception``：映射为 ``internal_error``（最后防线兜底 —— 见模块头注
      ΠΑΝ-95 的可达性修正）。

    永不抛错 —— 运行层数据流神圣不可击穿（异常诚实第二条）。
    """

    @functools.wraps(func)
    async def wrapper(*args: P.args, **kwargs: P.kwargs) -> R | dict[str, Any]:
        started = time.perf_counter()
        try:
            result = await func(*args, **kwargs)
            latency_ms = int((time.perf_counter() - started) * 1000)
            # 若被装饰函数自己返回了完整信封则透传不重算。
            # J 纪元收紧判据：旧式仅查 "status"+"latency_ms" 两键在场 ——
            # 业务数据恰含同名字段时会被误判成信封。现在 additionally 要求
            # status 取值在信封词表内。
            if (
                isinstance(result, dict)
                and result.get("status") in ("success", "failure")
                and "latency_ms" in result
            ):
                if result["latency_ms"] == 0:
                    result["latency_ms"] = latency_ms
                return result
            return success(result, latency_ms)
        except PhysicalError as e:
            latency_ms = int((time.perf_counter() - started) * 1000)
            return failure(e.kind, e.detail, latency_ms)
        except asyncio.TimeoutError:
            latency_ms = int((time.perf_counter() - started) * 1000)
            return failure(ErrorKind.ACTION_TIMEOUT, "step exceeded timeout budget", latency_ms)
        except Exception as e:  # noqa: BLE001 —— 兜底铁律：绝不抛 500
            latency_ms = int((time.perf_counter() - started) * 1000)
            tb = traceback.format_exc(limit=3)
            return failure(
                ErrorKind.INTERNAL_ERROR,
                f"{type(e).__name__}: {e} | tb={tb}",
                latency_ms,
            )

    return wrapper


# ─── 兜底中间件（理论不可达的最后一道墙）───


async def unhandled_exception_middleware(request: Any, call_next: Callable) -> Any:
    """纵深防御：即便 ``safe_call`` 漏网，此处把 500 转为 200+failure。

    「不靠自觉」的代码化 —— 架构保证胜过开发者保证。
    """
    started = time.perf_counter()
    try:
        return await call_next(request)
    except PhysicalError as e:
        latency_ms = int((time.perf_counter() - started) * 1000)
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=200, content=failure(e.kind, e.detail, latency_ms))
    except Exception as e:  # noqa: BLE001
        latency_ms = int((time.perf_counter() - started) * 1000)
        from fastapi.responses import JSONResponse

        tb = traceback.format_exc(limit=5)
        return JSONResponse(
            status_code=200,
            content=failure(
                ErrorKind.INTERNAL_ERROR,
                f"middleware-caught: {type(e).__name__}: {e} | tb={tb}",
                latency_ms,
            ),
        )
