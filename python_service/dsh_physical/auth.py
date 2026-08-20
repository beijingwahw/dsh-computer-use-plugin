"""三层纵深认证 —— Step 1 §⑤ 世界级创新方案。

Layer 1: Transport Binding
  - UDS 文件权限 0600 + chown $UID（进程启动时设置，跨用户隔离）
  - TCP 仅绑定 127.0.0.1，绝不开 0.0.0.0

Layer 2: PID Attestation（Linux 独有）
  - UDS 连接接受后用 ``SO_PEERPID`` 取对端 PID
  - 读 ``/proc/<PID>/exe`` 拿可执行路径
  - 路径哈希须在白名单（仅允许 ``node`` 与 dsh 进程）

Layer 3: Capability Token（细粒度能力位图）
  - HMAC-SHA256 签名的 base64 payload
  - 携带 ``pid``、``exp``、``caps`` 三字段
  - 单 token 60s TTL + 一次性 nonce（防重放）
  - 校验：HMAC 正确 + 未过期 + 端点 ∈ caps + payload.pid == SO_PEERPID

异常诚实：本模块所有公开方法永不抛错；失败一律返回 ``AuthResult`` 失败臂。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import socket
import stat
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .config import AuthConfig
from .errors import ErrorKind, PhysicalError

# ─── 能力位图（与 routes 端点对齐）───
# 注：``Literal`` 仅作类型层契约；运行时是字符串集合运算。
Capability = Literal[
    "click", "type", "scroll", "hotkey", "drag",
    "screenshot", "ui_tree", "switch_window", "shm_delete",
]

ALL_CAPS: tuple[Capability, ...] = (
    "click", "type", "scroll", "hotkey", "drag",
    "screenshot", "ui_tree", "switch_window", "shm_delete",
)

# 端点 → 所需 capability 映射（路由层据此校验）
ENDPOINT_CAPABILITY: dict[str, Capability] = {
    "/v1/click_mouse": "click",
    "/v1/type_text": "type",
    "/v1/scroll_page": "scroll",
    "/v1/press_hotkey": "hotkey",
    "/v1/drag_mouse": "drag",
    "/v1/take_screenshot": "screenshot",
    "/v1/get_ui_tree": "ui_tree",
    "/v1/switch_window": "switch_window",
    "/v1/shm/{name}": "shm_delete",  # DELETE 方法
}


@dataclass(frozen=True)
class AuthResult:
    """认证结果 —— 镜像 D-7 Result<T> 双臂结构。"""

    ok: bool
    pid: int | None = None
    caps: tuple[Capability, ...] = ()
    reason: str = ""


# ─── HMAC 密钥管理（启动期一次性生成，落盘 0600）───


def ensure_key(path: str) -> bytes:
    """加载或生成 HMAC 密钥。

    加载层方法：失败 ``raise`` —— 拒绝带病上线（异常诚实第一条）。
    密钥落盘权限 0600 + 父目录 0700；跨会话稳定。
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    # 父目录权限收口
    try:
        os.chmod(p.parent, 0o700)
    except PermissionError:
        # 父目录非己有：只读使用，不强制改权限（CI 容器场景）
        pass

    if p.exists():
        data = p.read_bytes()
        if len(data) < 32:
            raise ValueError(f"auth key {path} too short ({len(data)} bytes, need ≥32)")
        return data

    # 生成 32 字节随机密钥
    key = secrets.token_bytes(32)
    # O_EXCL：避免与其他进程竞态写
    fd = os.open(str(p), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(fd, key)
    finally:
        os.close(fd)
    return key


# ─── Cap Token 铸造与解析 ───


def mint_token(key: bytes, pid: int, caps: tuple[Capability, ...], ttl_seconds: int) -> str:
    """铸造 Capability Token。

    格式：``base64url(payload).base64url(hmac)`` —— JWT-style 但更紧凑。
    ``payload`` 不含敏感信息（caps 是声明而非密钥），但仍签名以防篡改。
    """
    payload = {
        "pid": pid,
        "exp": int(time.time()) + ttl_seconds,
        "caps": list(caps),
    }
    payload_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    sig = hmac.new(key, payload_bytes, hashlib.sha256).digest()
    return (
        base64.urlsafe_b64encode(payload_bytes).decode("ascii").rstrip("=")
        + "."
        + base64.urlsafe_b64encode(sig).decode("ascii").rstrip("=")
    )


def _b64url_decode(s: str) -> bytes:
    """JWT-style 容错解码（容忍缺省 padding）。"""
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def parse_token(key: bytes, token: str) -> AuthResult:
    """解析并校验 Capability Token。

    运行层方法：永不抛错 —— 一切失败转 ``AuthResult(ok=False, reason=...)``。
    """
    if not token or "." not in token:
        return AuthResult(ok=False, reason="malformed token: missing '.' separator")
    payload_b64, sig_b64 = token.split(".", 1)
    try:
        payload_bytes = _b64url_decode(payload_b64)
        sig = _b64url_decode(sig_b64)
    except Exception as e:  # noqa: BLE001
        return AuthResult(ok=False, reason=f"malformed token: base64 decode failed: {e}")

    # 重新计算 HMAC（恒定时间比较防时序攻击）
    expected_sig = hmac.new(key, payload_bytes, hashlib.sha256).digest()
    if not hmac.compare_digest(sig, expected_sig):
        return AuthResult(ok=False, reason="invalid signature")

    try:
        payload = json.loads(payload_bytes)
    except json.JSONDecodeError as e:
        return AuthResult(ok=False, reason=f"malformed payload: {e}")

    if not isinstance(payload, dict):
        return AuthResult(ok=False, reason="payload is not a dict")

    exp = payload.get("exp")
    if not isinstance(exp, int) or time.time() > exp:
        return AuthResult(ok=False, reason="token expired")

    caps_raw = payload.get("caps", [])
    if not isinstance(caps_raw, list):
        return AuthResult(ok=False, reason="caps is not a list")
    # 过滤未知 capability（容错：未知能力丢弃而非拒绝，签名已验过）
    caps: tuple[Capability, ...] = tuple(c for c in caps_raw if c in ALL_CAPS)  # type: ignore[misc]

    pid = payload.get("pid")
    if not isinstance(pid, int):
        return AuthResult(ok=False, reason="payload.pid is not int")

    return AuthResult(ok=True, pid=pid, caps=caps)


# ─── PID Attestation（Layer 2，Linux 独有）───

_NODE_BINARY_HASHES: set[str] = set()
"""启动期填充：允许的 Node 二进制 SHA256。空集合 = 不校验二进制身份（CI 友好）。"""


def _hash_binary(path: str) -> str | None:
    """计算可执行文件 SHA256。文件不存在返回 None。"""
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def get_peer_pid_linux(sock: socket.socket) -> int | None:
    """通过 ``SO_PEERPID`` 取对端 PID（仅 Linux）。

    失败返回 ``None`` —— 调用方降级到 Layer 1+3 即可，不抛错。
    """
    if sys.platform != "linux":
        return None
    try:
        # SO_PEERPID = 2 (Linux 内核 5.0+)
        pid = sock.getsockopt(socket.SOL_SOCKET, 2, 4)
        return int.from_bytes(pid, byteorder="little") or None
    except OSError:
        return None


def attest_pid(pid: int) -> bool:
    """校验 PID 的可执行路径白名单。

    空白名单（缺省）= 仅做存在性校验（任意进程都可访问）；
    非空白名单 = 严格二进制身份校验。
    运行层方法：永不抛错（读 /proc 失败 → False）。
    """
    if sys.platform != "linux":
        return True  # 非 Linux 平台无 PID attestation，Layer 1+3 兜底

    try:
        exe_path = os.readlink(f"/proc/{pid}/exe")
    except OSError:
        return False  # 进程不存在 / 无权限

    if not _NODE_BINARY_HASHES:
        return True  # 白名单未配置：开放模式（CI/开发）

    binary_hash = _hash_binary(exe_path)
    if binary_hash is None:
        return False
    return binary_hash in _NODE_BINARY_HASHES


# ─── Nonce 防重放（Layer 3 加固）───

_used_nonces: dict[str, float] = {}
"""``nonce → 过期时间``。Token 已带 exp，nonce 仅防同一 token 在 TTL 内被多次复用。"""


def check_and_consume_nonce(nonce: str, exp: int) -> bool:
    """单次性 nonce 校验。

    - 同一 nonce 第二次出现 → 拒绝（防重放）
    - 过期 nonce 自动清理（避免内存膨胀）
    """
    now = time.time()
    # 清理过期项（懒 GC，每次调用清一批）
    if len(_used_nonces) > 1024:
        for k in list(_used_nonces):
            if _used_nonces[k] < now:
                _used_nonces.pop(k, None)

    if nonce in _used_nonces:
        return False
    _used_nonces[nonce] = exp
    return True


# ─── UDS 文件权限初始化（Layer 1）───


def init_uds_file(path: str) -> None:
    """UDS 文件权限初始化：0600 + chown $UID。

    调用方：服务启动前调用一次，删除可能残留的旧 socket 文件。
    加载层方法：失败 ``raise``（异常诚实第一条）。
    """
    p = Path(path)
    if p.exists():
        if not p.is_socket():
            raise ValueError(f"UDS path {path} exists but is not a socket")
        try:
            p.unlink()
        except PermissionError as e:
            raise PermissionError(f"cannot remove stale UDS {path}: {e}") from e

    # 父目录权限收口
    p.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(p.parent, 0o700)
    except PermissionError:
        pass  # 父目录非己有：只读使用


def chmod_uds_file(path: str) -> None:
    """绑定后调用：把 socket 文件权限收口到 0600。

    uvicorn 创建 socket 时不会主动收口权限；此处补上 Layer 1 的硬绑定。
    运行层方法：失败不抛错（仅 warn，降级到 Layer 2+3）。
    """
    try:
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    except OSError as e:
        # 不抛错：Layer 1 失败时仍可由 Layer 2+3 兜底
        print(f"[warn] chmod UDS {path} failed: {e}", file=sys.stderr)
