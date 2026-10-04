"""异常诚实信封:safe_call / success / failure 离线单测(ΑΩ-R32)。

运行层数据流神圣不可击穿:一切异常转结构化 failure dict,永不抛出。
异步装饰器用 asyncio.run 驱动,零网络/零 HTTP 框架参与。
"""
import sys
from pathlib import Path

# ΑΩ-R32:discover 以本目录为 top-level,注入 python_service/(dsh_physical 所在目录)
_SVC_ROOT = str(Path(__file__).resolve().parents[1])
if _SVC_ROOT not in sys.path:
    sys.path.insert(0, _SVC_ROOT)

import asyncio  # noqa: E402
import json  # noqa: E402
import unittest  # noqa: E402

from dsh_physical.errors import (  # noqa: E402
    ErrorKind,
    PhysicalError,
    failure,
    safe_call,
    success,
)


class EnvelopeMinterTests(unittest.TestCase):
    """信封铸造器:形状 + ErrorKind 的 JSON 字符串化。"""

    def test_success_shape(self):
        s = success({"x": 1})
        self.assertEqual(s["status"], "success")
        self.assertEqual(s["data"], {"x": 1})
        self.assertEqual(s["latency_ms"], 0)  # 缺省 0,由 safe_call 注入实际值
        self.assertEqual(success("d", 7)["latency_ms"], 7)

    def test_failure_shape(self):
        f = failure(ErrorKind.INVALID_ARGS, "boom", 3)
        self.assertEqual(f["status"], "failure")
        self.assertEqual(f["error"], {"kind": "invalid_args", "detail": "boom"})
        self.assertEqual(f["latency_ms"], 3)

    def test_error_kind_serializes_as_plain_string(self):
        # str 基类枚举:JSON 序列化为字符串原值(跨语言契约)
        self.assertEqual(json.dumps(ErrorKind.INVALID_ARGS), '"invalid_args"')
        self.assertEqual(ErrorKind.OUT_OF_BOUNDS.value, "out_of_bounds")

    def test_physical_error_carries_kind(self):
        e = PhysicalError(ErrorKind.UNKNOWN_KEY, "nope")
        self.assertIs(e.kind, ErrorKind.UNKNOWN_KEY)
        self.assertIn("nope", e.detail)
        self.assertIn("unknown_key", str(e))  # Exception 消息携带 kind


class SafeCallTests(unittest.TestCase):
    """safe_call 装饰器:四条映射路径 + 信封透传收紧判据。"""

    def test_success_envelope_injection(self):
        @safe_call
        async def ok():
            return {"answer": 42}

        r = asyncio.run(ok())
        self.assertEqual(r["status"], "success")
        self.assertEqual(r["data"], {"answer": 42})
        self.assertIsInstance(r["latency_ms"], int)
        self.assertGreaterEqual(r["latency_ms"], 0)

    def test_physical_error_maps_kind(self):
        @safe_call
        async def boom():
            raise PhysicalError(ErrorKind.OUT_OF_BOUNDS, "x out of [0,1]")

        r = asyncio.run(boom())
        self.assertEqual(r["status"], "failure")
        self.assertEqual(r["error"]["kind"], "out_of_bounds")
        self.assertIn("x out of [0,1]", r["error"]["detail"])

    def test_timeout_maps_action_timeout(self):
        @safe_call
        async def slow():
            raise asyncio.TimeoutError()

        r = asyncio.run(slow())
        self.assertEqual(r["status"], "failure")
        self.assertEqual(r["error"]["kind"], "action_timeout")

    def test_unexpected_exception_maps_internal_error(self):
        @safe_call
        async def bad():
            raise RuntimeError("kaboom")

        r = asyncio.run(bad())
        self.assertEqual(r["error"]["kind"], "internal_error")
        self.assertIn("RuntimeError: kaboom", r["error"]["detail"])
        self.assertIn("tb=", r["error"]["detail"])  # 携带栈迹(诊断证据)

    def test_preformed_envelope_passthrough(self):
        @safe_call
        async def shaped():
            return {"status": "success", "data": 1, "latency_ms": 5}

        # 已有非零延迟 → 原样透传不重算
        self.assertEqual(asyncio.run(shaped())["latency_ms"], 5)

    def test_envelope_detection_requires_vocabulary(self):
        # J 纪元收紧判据:业务数据恰含 status/latency_ms 同名字段不误判为信封
        @safe_call
        async def tricky():
            return {"status": "pending", "latency_ms": 9}

        r = asyncio.run(tricky())
        self.assertEqual(r["status"], "success")
        self.assertEqual(r["data"], {"status": "pending", "latency_ms": 9})


if __name__ == "__main__":
    unittest.main()
