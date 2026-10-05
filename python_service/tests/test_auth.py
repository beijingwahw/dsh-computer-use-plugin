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
import io  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import tempfile  # noqa: E402
import time  # noqa: E402
import unittest  # noqa: E402

from dsh_physical import auth  # noqa: E402
from dsh_physical import routes  # noqa: E402
from dsh_physical.auth import (  # noqa: E402
    ALL_CAPS,
    ENDPOINT_CAPABILITY,
    _load_pid_whitelist,
    attest_pid,
    attestation_mode,
    check_and_consume_nonce,
    ensure_key,
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


# ─── ΠΑΝ-25/26/27:管理面入位图 / 密钥 ACL / Windows attestation / 中间件面 ───


class ManagementPlaneCapabilityTests(unittest.TestCase):
    """ΠΑΝ-25: 管理端点入能力位图 + ALL_CAPS 扩位（闭集契约）。"""

    def test_management_endpoints_mapped(self):
        # shutdown → 独立 admin 位；stats/input_events/devices → observe
        self.assertEqual(ENDPOINT_CAPABILITY["/v1/shutdown"], "admin")
        self.assertEqual(ENDPOINT_CAPABILITY["/v1/stats"], "observe")
        self.assertEqual(ENDPOINT_CAPABILITY["/v1/input_events"], "observe")
        self.assertEqual(ENDPOINT_CAPABILITY["/v1/devices"], "observe")

    def test_admin_observe_bits_in_all_caps(self):
        self.assertIn("admin", ALL_CAPS)
        self.assertIn("observe", ALL_CAPS)
        # 闭集契约：TS 端 contracts.ts 的 Capability 联合 + ALL_CAPS 数组必须
        # 同步镜像此二位（对接点 —— 未镜像期间旧 Node token 管理端点 401）。
        self.assertEqual(len(set(ALL_CAPS)), len(ALL_CAPS))

    def test_legacy_endpoint_mappings_unchanged(self):
        # 零回归锚点：既有正路径映射逐字节不变（迁移没动旧位）
        expected = {
            "/v1/click_mouse": "click",
            "/v1/type_text": "type",
            "/v1/scroll_page": "scroll",
            "/v1/press_hotkey": "hotkey",
            "/v1/drag_mouse": "drag",
            "/v1/move_mouse": "click",
            "/v1/take_screenshot": "screenshot",
            "/v1/get_ui_tree": "ui_tree",
            "/v1/switch_window": "switch_window",
            "/v1/cursor": "screenshot",
            "/v1/cursor_kind": "screenshot",
            "/v1/hit_test": "ui_tree",
            "/v1/displays": "screenshot",
            "/v1/frame_stats": "screenshot",
            "/v1/frame_rowmeans": "screenshot",
            "/v1/frame_diff": "screenshot",
            "/v1/audio_events": "screenshot",
            "/v1/uvc/capture": "screenshot",
            "/v1/hid/click": "click",
            "/v1/hid/move": "click",
            "/v1/hid/drag": "drag",
            "/v1/hid/scroll": "scroll",
            "/v1/hid/hotkey": "hotkey",
            "/v1/hid/type_text": "type",
        }
        for path, cap in expected.items():
            self.assertEqual(ENDPOINT_CAPABILITY.get(path), cap, f"{path} 映射漂移")


class KeyPermissionTests(unittest.TestCase):
    """ΠΑΝ-27: 密钥文件写后立即收紧 + 既有文件复查收紧。"""

    def test_ensure_key_tightens_on_create_and_reload(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "k.key")
            k1 = ensure_key(p)
            k2 = ensure_key(p)  # 加载路径同样复查/收紧
            self.assertEqual(k1, k2)
            self.assertEqual(len(k1), 32)
            if os.name == "nt":
                # 真实 NTFS 断言：icacls 回读 —— 仅当前用户 + SYSTEM 两条
                # 授权（继承已切断；旧形态含 BUILTIN\Users 等继承 ACE）。
                out = subprocess.run(
                    ["icacls", p], capture_output=True, timeout=15,
                )
                self.assertEqual(out.returncode, 0, out.stderr)
                txt = out.stdout.decode("mbcs", errors="replace")
                grants = [ln.strip() for ln in txt.splitlines() if ":(" in ln]
                self.assertEqual(
                    len(grants), 2, f"期望恰好 2 条授权（user+SYSTEM）: {grants}"
                )
                self.assertTrue(
                    any("SYSTEM" in g.upper() for g in grants),
                    f"SYSTEM 授权缺席: {grants}",
                )
            else:
                # POSIX：chmod 0600 收口可回读
                self.assertEqual(os.stat(p).st_mode & 0o777, 0o600)

    def test_ensure_key_short_existing_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "short.key")
            with open(p, "wb") as f:
                f.write(b"x" * 8)
            with self.assertRaises(ValueError):
                ensure_key(p)  # 加载层 raise 铁律不变

    def test_ensure_key_create_reload_deterministic(self):
        # ΠΑΝ-27 落盘复核回归锚点：本机实测 raw os.write 约 1 成概率落盘
        # 字节漂移（内存返回 32B、盘上 33B+）—— 缓冲写 + fsync + 回读复核
        # 后必须 0 漂移（生成→重读恒等）。
        for _ in range(15):
            with tempfile.TemporaryDirectory() as d:
                p = os.path.join(d, "k.key")
                k1 = ensure_key(p)
                self.assertEqual(len(k1), 32)
                self.assertEqual(k1, ensure_key(p))  # 重读 = 内存副本


class AttestPidPlatformTests(unittest.TestCase):
    """ΠΑΝ-27: attest_pid 平台语义 —— 活/死/降级/PID 复用/白名单。"""

    def tearDown(self) -> None:
        # 模块级共享态清场（复用缓存 + 降级时间戳）
        auth._pid_creation_cache.clear()
        auth._win_attest_degraded_at = 0.0

    def test_live_pid_attests_true(self):
        # 本测试进程：linux /proc 可读；win32 内核信号可得
        self.assertTrue(attest_pid(os.getpid()))

    def test_dead_pid_attests_false(self):
        if sys.platform == "darwin":
            self.skipTest("darwin 无可得信号（诚实降级恒 True）")
        # 已退出的子进程：linux /proc 缺席 / win32 OpenProcess 判死 ⇒ 拒绝
        proc = subprocess.Popen([sys.executable, "-c", "pass"])
        proc.wait()
        self.assertFalse(attest_pid(proc.pid))

    def test_win_signals_pid_reuse_rejected(self):
        if sys.platform != "win32":
            self.skipTest("win32 内核信号专测")
        real = auth._win_pid_signals
        try:
            auth._win_pid_signals = lambda pid: ("ok", r"C:\fake\node.exe", 1111)
            self.assertTrue(attest_pid(4242))  # 首见：缓存创建时间
            auth._win_pid_signals = lambda pid: ("ok", r"C:\fake\node.exe", 2222)
            self.assertFalse(attest_pid(4242))  # 创建时间漂移 ⇒ PID 复用 ⇒ 拒
        finally:
            auth._win_pid_signals = real

    def test_win_signals_unavailable_degrades_honestly(self):
        if sys.platform != "win32":
            self.skipTest("win32 内核信号专测")
        real = auth._win_pid_signals
        try:
            auth._win_pid_signals = lambda pid: ("unknown", None, None)
            self.assertTrue(attest_pid(4243))  # 降级放行（不阻断正路径）
            # 诚实降级申报：mode 从 win_signals 翻为 loopback_hmac_only
            self.assertEqual(attestation_mode(), "loopback_hmac_only")
        finally:
            auth._win_pid_signals = real
            auth._win_attest_degraded_at = 0.0
        self.assertEqual(attestation_mode(), "win_signals")  # 窗外恢复申报

    def test_win_exe_whitelist_strict_identity(self):
        if sys.platform != "win32":
            self.skipTest("win32 内核信号专测")
        target = os.path.abspath(__file__)  # 任意真实可读文件做白名单目标
        digest = hashlib.sha256(open(target, "rb").read()).hexdigest()
        real_signals = auth._win_pid_signals
        saved_whitelist = auth._NODE_BINARY_HASHES
        try:
            auth._NODE_BINARY_HASHES = {digest}
            auth._win_pid_signals = lambda pid: ("ok", target, 5555)
            self.assertTrue(attest_pid(4244))  # 哈希命中
            auth._win_pid_signals = lambda pid: ("ok", target + ".absent", 5555)
            self.assertFalse(attest_pid(4244))  # 哈希失配（文件缺席 → None → 拒）
        finally:
            auth._win_pid_signals = real_signals
            auth._NODE_BINARY_HASHES = saved_whitelist
            auth._pid_creation_cache.clear()

    def test_attestation_mode_honest_per_platform(self):
        mode = attestation_mode()
        if sys.platform == "linux":
            self.assertIn(mode, ("proc_existence", "proc_exe_whitelist"))
        elif sys.platform == "win32":
            self.assertIn(mode, ("win_signals", "win_exe_whitelist", "loopback_hmac_only"))
        else:
            self.assertEqual(mode, "loopback_hmac_only")


class AuthMiddlewareTests(unittest.TestCase):
    """ΠΑΝ-25/26/27 中间件面：fail-closed / docs 认证 / 401·503 日志留痕。

    TestClient 驱动真实 create_app（不跑 lifespan —— 零 UDS/池副作用；
    正路径信封由路由层产出，与生产逐字节同构）。
    """

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls._saved_env = {
            k: os.environ.get(k)
            for k in ("DSH_PHYSICAL_KEY_PATH", "DSH_PHYSICAL_PID_ATTESTATION")
        }
        os.environ["DSH_PHYSICAL_KEY_PATH"] = os.path.join(cls._tmp.name, "k.key")
        # 主夹具关 attestation（其单测自建 app 显式开）
        os.environ["DSH_PHYSICAL_PID_ATTESTATION"] = "false"
        from dsh_physical.config import load_config_from_env
        from dsh_physical.server import create_app
        from fastapi.testclient import TestClient

        cls.key = ensure_key(os.environ["DSH_PHYSICAL_KEY_PATH"])
        cls.app = create_app(load_config_from_env())
        cls.client = TestClient(cls.app)

    @classmethod
    def tearDownClass(cls):
        for k, v in cls._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        cls._tmp.cleanup()

    def setUp(self) -> None:
        routes.reset_shutdown_state()
        auth._used_nonces.clear()

    def tearDown(self) -> None:
        routes.reset_shutdown_state()

    # ── 工具 ──

    def _headers(self, caps, pid=None, nonce=None):
        import secrets as _secrets

        token = mint_token(
            self.key, os.getpid() if pid is None else pid, tuple(caps), 60
        )
        return {
            "X-Cap-Token": token,
            "X-Request-Id": nonce or _secrets.token_hex(8),
        }

    def _request_capturing_stderr(self, method, path, **kw):
        buf = io.StringIO()
        saved = sys.stderr
        sys.stderr = buf
        try:
            resp = getattr(self.client, method.lower())(path, **kw)
        finally:
            sys.stderr = saved
        return resp, buf.getvalue()

    @staticmethod
    def _log_records(text: str) -> list[dict]:
        out = []
        for line in text.splitlines():
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if "http.status" in rec:
                    out.append(rec)
        return out

    # ── 既有正路径零回归锚点 ──

    def test_health_remains_tokenless(self):
        r = self.client.get("/v1/health")
        self.assertEqual(r.status_code, 200)
        # safe_call 信封：data 内才是路由原始回执（data.status = "ok"）
        body = r.json()
        self.assertEqual(body["status"], "success")
        self.assertEqual(body["data"]["status"], "ok")  # allow_no_token 面不变

    def test_missing_token_401_envelope_byte_stable(self):
        r = self.client.get("/v1/stats")
        self.assertEqual(r.status_code, 401)
        self.assertEqual(
            r.json(),
            {
                "status": "failure",
                "error": {"kind": "unauthorized", "detail": "missing X-Cap-Token header"},
                "latency_ms": 0,
            },
        )

    def test_mapped_endpoint_positive_path_unchanged(self):
        # observe token → /v1/stats：成功信封形状与修复前逐字节同构
        r = self.client.get("/v1/stats", headers=self._headers(("observe",)))
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["status"], "success")
        self.assertIn("executors", body["data"])
        self.assertIn("ts", body["data"])

    def test_nonce_replay_rejected_unchanged(self):
        h = self._headers(("observe",), nonce="replay-nonce-1")
        r1 = self.client.get("/v1/stats", headers=h)
        self.assertEqual(r1.status_code, 200)
        r2 = self.client.get("/v1/stats", headers=h)
        self.assertEqual(r2.status_code, 401)
        self.assertIn("nonce already consumed", r2.json()["error"]["detail"])

    # ── ΠΑΝ-25: 管理面入位图 + fail-closed ──

    def test_single_capability_token_cannot_shutdown(self):
        # 只铸 click 的最小 token 也不能关停服务（C2-5 H-3 的核心旁路关闭）
        r = self.client.post("/v1/shutdown", headers=self._headers(("click",)))
        self.assertEqual(r.status_code, 401)
        self.assertEqual(
            r.json()["error"]["detail"],
            "token lacks capability: 'admin' (has: ['click'])",
        )
        self.assertFalse(routes.is_draining(), "拒绝路径不得置 draining")

    def test_observe_required_for_stats_and_input_events(self):
        for path in ("/v1/stats", "/v1/input_events"):
            r = self.client.get(path, headers=self._headers(("click",)))
            self.assertEqual(r.status_code, 401, path)
            self.assertIn("token lacks capability: 'observe'", r.json()["error"]["detail"])

    def test_admin_token_shutdown_succeeds_and_drains(self):
        # 正路径：admin token → 成功信封 + 置 draining（隔离 drain 后台任务）
        real_drain = routes.drain_and_exit

        async def _quiet_drain(max_wait_s: float = 0):
            return (False, True)

        routes.drain_and_exit = _quiet_drain
        try:
            r = self.client.post("/v1/shutdown", headers=self._headers(("admin",)))
            self.assertEqual(r.status_code, 200)
            body = r.json()
            self.assertEqual(body["status"], "success")
            self.assertEqual(
                body["data"], {"draining": True, "already_draining": False}
            )
            self.assertTrue(routes.is_draining())
            # draining 期新请求被 drain 中间件 503 拒（auth 之前 —— 不烧 nonce）
            r2 = self.client.get("/v1/stats", headers=self._headers(("observe",)))
            self.assertEqual(r2.status_code, 503)
        finally:
            routes.drain_and_exit = real_drain
            routes.reset_shutdown_state()

    def test_unknown_endpoint_fail_closed_403(self):
        # 无映射端点（带合法全能力 token）⇒ 403 默认拒绝，不再放行到路由
        r = self.client.get("/v1/nonexistent", headers=self._headers(ALL_CAPS))
        self.assertEqual(r.status_code, 403)
        self.assertEqual(
            r.json(),
            {
                "status": "failure",
                "error": {
                    "kind": "unauthorized",
                    "detail": "endpoint '/v1/nonexistent' (GET) has no capability "
                              "mapping; fail-closed default deny (ΠΑΝ-25)",
                },
                "latency_ms": 0,
            },
        )

    def test_unknown_endpoint_without_token_still_401(self):
        # 判决次序：token 缺席优先 401（fail-closed 是能力映射层的语义）
        r = self.client.post("/v1/definitely-not-here")
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json()["error"]["detail"], "missing X-Cap-Token header")

    # ── ΠΑΝ-26: docs 认证收口 ──

    def test_docs_no_token_rejected(self):
        for path in ("/docs", "/openapi.json"):
            r = self.client.get(path)
            self.assertEqual(r.status_code, 401, path)
            self.assertEqual(r.json()["error"]["kind"], "unauthorized")

    def test_docs_requires_observe_capability(self):
        r = self.client.get("/docs", headers=self._headers(("click",)))
        self.assertEqual(r.status_code, 401)
        self.assertIn("token lacks capability: 'observe'", r.json()["error"]["detail"])

    def test_docs_served_with_observe_token(self):
        r = self.client.get("/docs", headers=self._headers(("observe",)))
        self.assertEqual(r.status_code, 200)
        r2 = self.client.get("/openapi.json", headers=self._headers(("observe",)))
        self.assertEqual(r2.status_code, 200)
        self.assertIn("openapi", r2.json())

    # ── ΠΑΝ-26: 401/503 落请求日志 ──

    def test_auth_401_leaves_log_trace(self):
        resp, text = self._request_capturing_stderr("GET", "/v1/stats")
        self.assertEqual(resp.status_code, 401)
        records = self._log_records(text)
        self.assertTrue(records, "401 必须留下一行 JSON-lines 请求日志（C2-5 M-2）")
        rec = records[-1]
        self.assertEqual(rec["http.status"], 401)
        self.assertEqual(rec["http.route"], "/v1/stats")
        self.assertEqual(rec["http.method"], "GET")

    def test_capability_401_leaves_log_trace(self):
        resp, text = self._request_capturing_stderr(
            "POST", "/v1/shutdown", headers=self._headers(("click",))
        )
        self.assertEqual(resp.status_code, 401)
        recs = self._log_records(text)
        self.assertTrue(recs and recs[-1]["http.status"] == 401)

    def test_fail_closed_403_leaves_log_trace(self):
        resp, text = self._request_capturing_stderr(
            "GET", "/v1/nonexistent", headers=self._headers(("click",))
        )
        self.assertEqual(resp.status_code, 403)
        recs = self._log_records(text)
        self.assertTrue(recs and recs[-1]["http.status"] == 403)

    def test_drain_503_leaves_log_trace(self):
        routes._drain_state["draining"] = True
        try:
            resp, text = self._request_capturing_stderr(
                "GET", "/v1/stats", headers=self._headers(("observe",))
            )
            self.assertEqual(resp.status_code, 503)
            recs = self._log_records(text)
            self.assertTrue(recs, "503 必须留下一行请求日志（旧序下零痕迹）")
            self.assertEqual(recs[-1]["http.status"], 503)
        finally:
            routes.reset_shutdown_state()

    # ── ΠΑΝ-27: 武装态 attestation 的中间件判决 ──

    def test_armed_attestation_rejects_dead_pid_token(self):
        if sys.platform == "darwin":
            self.skipTest("darwin 无真实信号（attest_pid_supported=False）")
        saved = os.environ.get("DSH_PHYSICAL_PID_ATTESTATION")
        os.environ["DSH_PHYSICAL_PID_ATTESTATION"] = "true"
        from dsh_physical.config import load_config_from_env
        from dsh_physical.server import create_app
        from fastapi.testclient import TestClient

        try:
            app = create_app(load_config_from_env())
            client = TestClient(app)
            proc = subprocess.Popen([sys.executable, "-c", "pass"])
            proc.wait()
            r = client.get(
                "/v1/stats",
                headers=self._headers(("observe",), pid=proc.pid),
            )
            self.assertEqual(r.status_code, 401)
            self.assertIn("failed attestation", r.json()["error"]["detail"])
            # 诚实标注：拒绝信封携带 attestation mode
            self.assertIn("mode=", r.json()["error"]["detail"])
        finally:
            if saved is None:
                os.environ.pop("DSH_PHYSICAL_PID_ATTESTATION", None)
            else:
                os.environ["DSH_PHYSICAL_PID_ATTESTATION"] = saved


if __name__ == "__main__":
    unittest.main()
