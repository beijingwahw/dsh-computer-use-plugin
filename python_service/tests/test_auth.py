"""三层认证 Layer 3:Cap Token 铸造/解析/HMAC 双端字节镜像离线单测(ΑΩ-R32)。

全部纯函数(密钥/HMAC/时间均由测试控制),零 I/O —— 不触 UDS 文件、
不触 /proc。HMAC 用标准库独立重算做双端镜像,逐字节对照。
"""
import sys
from pathlib import Path

# ΑΩ-R32:discover 以本目录为 top-level,注入 python_service/(dsh_physical 所在目录)
_SVC_ROOT = str(Path(__file__).resolve().parents[1])
if _SVC_ROOT not in sys.path:
    sys.path.insert(0, _SVC_ROOT)

import base64  # noqa: E402
import hashlib  # noqa: E402
import hmac  # noqa: E402
import json  # noqa: E402
import time  # noqa: E402
import unittest  # noqa: E402

from dsh_physical import auth  # noqa: E402
from dsh_physical.auth import (  # noqa: E402
    ALL_CAPS,
    _load_pid_whitelist,
    check_and_consume_nonce,
    mint_token,
    parse_token,
)

_KEY = b"k" * 32
_OTHER_KEY = b"j" * 32


def _b64url_decode(s: str) -> bytes:
    # ΑΩ-R32:测试侧自带解码(不借用被测模块的 _b64url_decode,保持镜像独立性)
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class MintParseTests(unittest.TestCase):
    """铸造 → 解析往返:payload 字段镜像 + 时间边界。"""

    def test_roundtrip_payload_mirror(self):
        token = mint_token(_KEY, 4242, ("click", "screenshot"), 60)
        payload_b64, sig_b64 = token.split(".", 1)
        self.assertEqual(len(token.split(".")), 2)  # 单点分隔的紧凑形态
        payload = json.loads(_b64url_decode(payload_b64))
        self.assertEqual(payload["pid"], 4242)
        self.assertEqual(payload["caps"], ["click", "screenshot"])
        self.assertAlmostEqual(payload["exp"], int(time.time()) + 60, delta=2)
        self.assertGreater(len(sig_b64), 40)  # SHA256 → base64url 无填充长度 43
        r = parse_token(_KEY, token)
        self.assertTrue(r.ok)
        self.assertEqual(r.pid, 4242)
        self.assertEqual(r.caps, ("click", "screenshot"))
        self.assertEqual(r.exp, payload["exp"])

    def test_hmac_double_end_byte_mirror(self):
        # 双端镜像:标准库独立重算 HMAC-SHA256,与 token 携带签名逐字节一致
        token = mint_token(_KEY, 7, ("type",), 30)
        payload_b64, sig_b64 = token.split(".", 1)
        payload_bytes = _b64url_decode(payload_b64)
        expected = hmac.new(_KEY, payload_bytes, hashlib.sha256).digest()
        self.assertEqual(_b64url_decode(sig_b64), expected)
        # payload 为紧凑 JSON(分隔符无空白 —— 字节级稳定形态)
        self.assertNotIn(b" ", payload_bytes)
        self.assertNotIn(b"\n", payload_bytes)

    def test_wrong_key_rejected(self):
        token = mint_token(_KEY, 1, ("click",), 60)
        r = parse_token(_OTHER_KEY, token)
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, "invalid signature")

    def test_tampered_payload_rejected(self):
        # 换 payload 不换签名 → HMAC 失配(防篡改的根基)
        token = mint_token(_KEY, 1, ("click",), 60)
        _, sig_b64 = token.split(".", 1)
        forged = {
            "pid": 2,
            "exp": int(time.time()) + 999,
            "caps": list(ALL_CAPS),  # 提权尝试:全能力位
        }
        forged_b64 = (
            base64.urlsafe_b64encode(json.dumps(forged, separators=(",", ":")).encode())
            .decode("ascii")
            .rstrip("=")
        )
        r = parse_token(_KEY, f"{forged_b64}.{sig_b64}")
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, "invalid signature")

    def test_expired_token(self):
        token = mint_token(_KEY, 1, ("click",), -10)  # exp 已在过去
        r = parse_token(_KEY, token)
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, "token expired")

    def test_malformed_tokens_never_raise(self):
        # 运行层铁律:一切畸形输入 → 失败臂,绝不抛
        for bad in ("", "no-dot", "!!!.???", "a.b.c.d", "."):
            r = parse_token(_KEY, bad)
            self.assertIsInstance(r, auth.AuthResult)
            self.assertFalse(r.ok)
            self.assertTrue(r.reason)

    def test_unknown_caps_filtered_not_rejected(self):
        # 签名有效但 caps 含未知条目 → 丢弃未知而非拒绝(签名已验过的容错语义)
        payload = {
            "pid": 5,
            "exp": int(time.time()) + 60,
            "caps": ["click", "melt_down_core", "screenshot"],
        }
        pb = json.dumps(payload, separators=(",", ":")).encode()
        sig = base64.urlsafe_b64encode(hmac.new(_KEY, pb, hashlib.sha256).digest()).decode().rstrip("=")
        token = base64.urlsafe_b64encode(pb).decode().rstrip("=") + "." + sig
        r = parse_token(_KEY, token)
        self.assertTrue(r.ok)
        self.assertEqual(r.caps, ("click", "screenshot"))

    def test_bad_payload_fields_rejected(self):
        # pid 非 int / caps 非 list → 失败臂
        def _mint_raw(payload: dict) -> str:
            pb = json.dumps(payload, separators=(",", ":")).encode()
            sig = base64.urlsafe_b64encode(hmac.new(_KEY, pb, hashlib.sha256).digest()).decode().rstrip("=")
            return base64.urlsafe_b64encode(pb).decode().rstrip("=") + "." + sig

        now = int(time.time())
        r1 = parse_token(_KEY, _mint_raw({"pid": "x", "exp": now + 60, "caps": []}))
        self.assertFalse(r1.ok)
        self.assertEqual(r1.reason, "payload.pid is not int")
        r2 = parse_token(_KEY, _mint_raw({"pid": 1, "exp": now + 60, "caps": "click"}))
        self.assertFalse(r2.ok)
        self.assertEqual(r2.reason, "caps is not a list")


class NonceTests(unittest.TestCase):
    """nonce 防重放:单次性 + 过期自动清理(ΑΩ-R26 时间驱动 GC)。"""

    def setUp(self) -> None:
        # ΑΩ-R32:模块级 nonce 表是进程内共享状态,逐测试清场
        auth._used_nonces.clear()

    def tearDown(self) -> None:
        auth._used_nonces.clear()

    def test_single_use_semantics(self):
        self.assertTrue(check_and_consume_nonce("n1", time.time() + 60))
        self.assertFalse(check_and_consume_nonce("n1", time.time() + 60))
        self.assertTrue(check_and_consume_nonce("n2", time.time() + 60))  # 他 nonce 不受累

    def test_expired_nonce_garbage_collected(self):
        # 过期 nonce 被时间驱动 GC 清除:同 nonce 在过期后可再消费(表不无限驻留)
        self.assertTrue(check_and_consume_nonce("old", time.time() - 1))
        self.assertTrue(check_and_consume_nonce("old", time.time() - 1))
        self.assertEqual(len(auth._used_nonces), 1)  # 旧条目不残留


class WhitelistTests(unittest.TestCase):
    """PID 白名单装载:整条拒绝(拒绝半载)+ 平台透传。"""

    def test_load_pid_whitelist_forms(self):
        a = "a" * 64
        b = "B" * 64
        self.assertEqual(_load_pid_whitelist(None), set())
        self.assertEqual(_load_pid_whitelist(""), set())
        # 大小写归一 + 空白条目跳过
        self.assertEqual(_load_pid_whitelist(f"{a},{b} , "), {a, b.lower()})

    def test_load_pid_whitelist_rejects_invalid_entry(self):
        with self.assertRaises(ValueError):
            _load_pid_whitelist("zzz")  # 非 64-hex → 整条拒绝(半载比空表更危险)

    def test_attest_pid_non_linux_pass_through(self):
        if sys.platform == "linux":
            self.skipTest("linux 有 /proc attestation 分支,透传断言不适用")
        # 非 Linux 无 Layer 2,Layer 1+3 兜底 → 恒 True(连不存在的 PID 也放行,
        # 由 HMAC token 承担身份校验)
        self.assertTrue(auth.attest_pid(999_999_999))


if __name__ == "__main__":
    unittest.main()
