"""异常诚实封装 —— 铁律的代码化。

造物主契约（Step 1 §3）：
  - Python 端捕获所有底层异常，封装为 ``{ status:'failure', error:{kind, detail} }`` 返回
  - HTTP 恒 200，业务成败由 body 中的 ``status`` 判定
  - 绝不抛出未捕获异常（含 500）

设计：
  ``PhysicalError`` 是受控错误的载体（含分类法 kind）；
  ``safe_call`` 是异常诚实的外壳：把一切异常转 ``MicroResponse``；
  ``unhandled_exception_middleware`` 是最后兜底（理论不可达，但纵深防御不靠自觉）。
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
    INTERNAL_ERROR = "internal_error"  # 兜底：理论不可达


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
    - 其余 ``Exception``：映射为 ``internal_error``（理论不可达的兜底）。

    永不抛错 —— 运行层数据流神圣不可击穿（异常诚实第二条）。
    """

    @functools.wraps(func)
    async def wrapper(*args: P.args, **kwargs: P.kwargs) -> R | dict[str, Any]:
        started = time.perf_counter()
        try:
            result = await func(*args, **kwargs)
            latency_ms = int((time.perf_counter() - started) * 1000)
            # 若被装饰函数自己返回了完整信封（含 latency_ms 字段），透传不重算
            if isinstance(result, dict) and "latency_ms" in result and "status" in result:
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
