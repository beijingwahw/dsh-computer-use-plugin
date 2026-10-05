"""三层纵深认证 —— Step 1 §⑤ 世界级创新方案。

Layer 1: Transport Binding
  - UDS 文件权限 0600 + chown $UID（进程启动时设置，跨用户隔离）
  - TCP 仅绑定 127.0.0.1，绝不开 0.0.0.0

Layer 2: PID Attestation
  - Linux：校验 token payload.pid 对应的 ``/proc/<PID>/exe`` 存在性
  - 二进制哈希白名单（``_NODE_BINARY_HASHES``）非空时升级为严格身份校验
  - 传输层 SO_PEERCRED 取对端 PID 需自定义 uvicorn handler（peercred.py
    服务端半边已落地）
  - ΠΑΝ-27：Windows 不再恒 True —— 用可得内核信号（进程存在性、可执行
    路径、创建时间/PID 复用检测）做真实校验；信号不可得时**诚实降级**为
    「仅回环 + HMAC」（``attestation_mode()`` 可查，启动日志申报），绝不
    在降级时误报已校验、也绝不在降级时阻断正路径

Layer 3: Capability Token（细粒度能力位图）
  - HMAC-SHA256 签名的 base64 payload
  - 携带 ``pid``、``exp``、``caps`` 三字段
  - 单 token 60s TTL + 一次性 nonce（防重放）
  - 校验：HMAC 正确 + 未过期 + 端点 ∈ caps

异常诚实：本模块所有公开方法永不抛错；失败一律返回 ``AuthResult`` 失败臂。
"""
from __future__ import annotations

import base64
import ctypes
import hashlib
import heapq
import hmac
import json
import os
import secrets
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
    # ΠΑΝ-25: 管理面能力位 —— shutdown 独立 admin 位（关停是最高权动作，
    # 与读写动作位隔离）；stats/input_events/devices 归 observe（只读观测，
    # input_events 是键盘 vk 审计流 —— 敏感度对齐独立观测位而非复用截图位）。
    # 闭集扩位 ⇒ TS 端 src/physicalExecution/contracts.ts 的 Capability 联合
    # 与 ALL_CAPS 数组必须同步镜像（对接点；本工单不碰 TS 文件）—— 未镜像
    # 期间旧 Node token 不含新位 ⇒ 管理端点对其 401（fail-closed 方向正确）。
    "admin", "observe",
]

ALL_CAPS: tuple[Capability, ...] = (
    "click", "type", "scroll", "hotkey", "drag",
    "screenshot", "ui_tree", "switch_window", "shm_delete",
    "admin", "observe",
)

# 端点 → 所需 capability 映射（路由层据此校验）
# 注：``/v1/shm/<name>`` 的 DELETE 由 ``server._match_capability`` 的
# startswith 分支匹配（路径含具体名字，字面量键永不命中 —— J 纪元移除失效条目）。
ENDPOINT_CAPABILITY: dict[str, Capability] = {
    "/v1/click_mouse": "click",
    "/v1/type_text": "type",
    "/v1/scroll_page": "scroll",
    "/v1/press_hotkey": "hotkey",
    "/v1/drag_mouse": "drag",
    # 移动属指针物理动作（与点击同级 —— 探针悬停的躯体）
    "/v1/move_mouse": "click",
    "/v1/take_screenshot": "screenshot",
    "/v1/get_ui_tree": "ui_tree",
    "/v1/switch_window": "switch_window",
    # 感知辅助端点（只读，与截图同能力位 —— D-1 工具层接线）
    "/v1/cursor": "screenshot",
    "/v1/cursor_kind": "screenshot",
    # UIA 点查询属结构感知族（与 UI 树同能力位 —— Z-1 第三通道）
    "/v1/hit_test": "ui_tree",
    "/v1/displays": "screenshot",
    "/v1/frame_stats": "screenshot",
    "/v1/frame_rowmeans": "screenshot",
    "/v1/frame_diff": "screenshot",
    # W5-1（W4-8 落盘）：L4 声学证据通道（只读感知族，与截图同能力位）
    "/v1/audio_events": "screenshot",
    # W5-1（W4-6 落盘）：L2 零 API 设备面 —— 能力位复用既有位图（不加新位：
    # Node 端 capToken 的 Capability 是闭集字面联合，新位 = 铸不出合法 token）。
    # UVC 采集属视觉感知族；HID 六端点与同名主机动作同能力位。
    "/v1/uvc/capture": "screenshot",
    "/v1/hid/click": "click",
    "/v1/hid/move": "click",
    "/v1/hid/drag": "drag",
    "/v1/hid/scroll": "scroll",
    "/v1/hid/hotkey": "hotkey",
    "/v1/hid/type_text": "type",
    # ΠΑΝ-25: 管理面入位图（C2-5 H-3 —— 旧实现管理端点不在映射内 ⇒
    # server._match_capability 返回 None ⇒ 中间件跳过能力校验，单能力
    # token 亦可关停服务/读键盘审计流/读内部拓扑）。
    # shutdown → 独立 admin 位（关停权与一切读写动作位隔离）；
    # stats/input_events/devices → observe（只读观测族 —— input_events 暴露
    # 键盘 vk 流，stats 暴露池/shm/流内部拓扑，devices 暴露 adb 设备清单）。
    "/v1/shutdown": "admin",
    "/v1/stats": "observe",
    "/v1/input_events": "observe",
    "/v1/devices": "observe",
}


@dataclass(frozen=True)
class AuthResult:
    """认证结果 —— 镜像 D-7 Result<T> 双臂结构。

    ``exp``：token 过期时刻（unix 秒）。J 纪元新增 —— nonce 防重放需要
    每个 nonce 的存活上界，旧实现为此在中间件里手工二次 base64 解码
    payload；现在 parse_token 一次解析全程携带。
    """

    ok: bool
    pid: int | None = None
    caps: tuple[Capability, ...] = ()
    reason: str = ""
    exp: int = 0


# ─── HMAC 密钥管理（启动期一次性生成，落盘 0600）───


# ΠΑΝ-27: Windows DACL 收口的 ctypes 绑定（结构体布局以 mingw-w64 头为
# 事实源：TRUSTEE_W x64 = 32B、EXPLICIT_ACCESS_W x64 = 48B —— 与
# dxgi_capture 的 ABI 钉死纪律同方言）。绑定按调用现建（仅 ensure_key 的
# 生成/加载两条低频路径触达），任一跳失败 ⇒ None/warn 诚实降级，绝不抛。
class _TRUSTEE_W(ctypes.Structure):
    _fields_ = [
        ("pMultipleTrustee", ctypes.c_void_p),
        ("pMultipleTrusteeAction", ctypes.c_int),
        ("TrusteeForm", ctypes.c_int),
        ("TrusteeType", ctypes.c_int),
        ("ptstrName", ctypes.c_void_p),
    ]


class _EXPLICIT_ACCESS_W(ctypes.Structure):
    _fields_ = [
        ("grfAccessPermissions", ctypes.c_ulong),
        ("grfAccessMode", ctypes.c_int),
        ("grfInheritance", ctypes.c_ulong),
        ("Trustee", _TRUSTEE_W),
    ]


def _win_current_user_sid() -> str | None:
    """ΠΑΝ-27: 当前进程用户 SID（``S-1-5-21-...`` 字符串形态）。

    GetUserNameW → LookupAccountNameW → ConvertSidToStringSidW 三跳。
    运行层方法：任一跳失败返回 None（调用方诚实降级），绝不抛。
    """
    try:
        from ctypes import wintypes  # 局部导入：非 Windows 平台无 wintypes 面

        adv = ctypes.WinDLL("advapi32", use_last_error=True)
        adv.GetUserNameW.restype = wintypes.BOOL
        adv.GetUserNameW.argtypes = [wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
        adv.LookupAccountNameW.restype = wintypes.BOOL
        adv.LookupAccountNameW.argtypes = [
            wintypes.LPWSTR, wintypes.LPWSTR, ctypes.c_void_p,
            ctypes.POINTER(wintypes.DWORD), wintypes.LPWSTR,
            ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD),
        ]
        adv.ConvertSidToStringSidW.restype = wintypes.BOOL
        adv.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar_p)]

        name = ctypes.create_unicode_buffer(256)
        n = wintypes.DWORD(256)
        if not adv.GetUserNameW(name, ctypes.byref(n)):
            return None
        sid = ctypes.create_string_buffer(68)  # SID 结构体上限 68B
        cb = wintypes.DWORD(68)
        dom = ctypes.create_unicode_buffer(256)
        dcb = wintypes.DWORD(256)
        use = wintypes.DWORD()
        if not adv.LookupAccountNameW(
            None, name.value, sid, ctypes.byref(cb), dom, ctypes.byref(dcb), ctypes.byref(use)
        ):
            return None
        sid_str = ctypes.c_wchar_p()
        if not adv.ConvertSidToStringSidW(sid, ctypes.byref(sid_str)):
            return None
        out = sid_str.value
        ctypes.WinDLL("kernel32", use_last_error=True).LocalFree(sid_str)
        return out
    except Exception:  # noqa: BLE001 —— 信号不可得 = 降级，绝不抛
        return None


def _tighten_key_acl_windows(path: str) -> bool:
    """ΠΑΝ-27: Windows 密钥文件 DACL 收紧 —— 仅当前用户 + SYSTEM 全权，
    切断继承（PROTECTED_DACL；icacls ``/inheritance:r`` 等价语义）。

    动机（C2-4 M-4）：NTFS 上 ``chmod 0600`` 近 no-op —— 未收口时密钥被
    同机其他账户/继承 ACE 读取即可铸任意 caps/pid/exp 的合法 token，
    三层纵深在主平台退化为「同用户全信」。
    返回 True = 收紧成功；失败仅 warn 不 raise（密钥仍可用，Layer 1+3
    照常承担 —— 与 chmod_uds_file 同款诚实降级方言）。
    """
    user_sid = _win_current_user_sid()
    if user_sid is None:
        print(
            f"[warn] cannot resolve current user SID; skip ACL tightening for {path}",
            file=sys.stderr,
        )
        return False
    try:
        from ctypes import wintypes

        adv = ctypes.WinDLL("advapi32", use_last_error=True)
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        adv.ConvertStringSidToSidW.restype = wintypes.BOOL
        adv.ConvertStringSidToSidW.argtypes = [wintypes.LPWSTR, ctypes.POINTER(ctypes.c_void_p)]
        adv.SetEntriesInAclW.restype = wintypes.DWORD
        adv.SetEntriesInAclW.argtypes = [
            ctypes.c_ulong, ctypes.POINTER(_EXPLICIT_ACCESS_W),
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p),
        ]
        adv.SetNamedSecurityInfoW.restype = wintypes.DWORD
        adv.SetNamedSecurityInfoW.argtypes = [
            wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD,
            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
        ]
        k32.LocalFree.restype = ctypes.c_void_p
        k32.LocalFree.argtypes = [ctypes.c_void_p]

        def _sid_ptr(sid_str: str) -> ctypes.c_void_p:
            out = ctypes.c_void_p()
            if not adv.ConvertStringSidToSidW(sid_str, ctypes.byref(out)):
                raise OSError(f"ConvertStringSidToSidW({sid_str}) failed")
            return out

        FILE_ALL_ACCESS = 0x001F01FF
        GRANT_ACCESS = 1
        TRUSTEE_IS_SID = 0
        TRUSTEE_IS_USER = 1
        SE_FILE_OBJECT = 1
        DACL_SECURITY_INFORMATION = 0x4
        PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000

        # S-1-5-18 = NT AUTHORITY\SYSTEM（按 SID 寻址 —— 账户显示名在本地化
        # Windows 上不稳定，SID 是语言无关事实源）
        user_p = _sid_ptr(user_sid)
        system_p = _sid_ptr("S-1-5-18")
        ea = (_EXPLICIT_ACCESS_W * 2)()
        for i, sp in enumerate((user_p, system_p)):
            ea[i].grfAccessPermissions = FILE_ALL_ACCESS
            ea[i].grfAccessMode = GRANT_ACCESS
            ea[i].grfInheritance = 0
            ea[i].Trustee.TrusteeForm = TRUSTEE_IS_SID
            ea[i].Trustee.TrusteeType = TRUSTEE_IS_USER
            ea[i].Trustee.ptstrName = sp

        new_acl = ctypes.c_void_p()
        try:
            rc = adv.SetEntriesInAclW(2, ea, None, ctypes.byref(new_acl))
            if rc != 0:
                raise OSError(f"SetEntriesInAclW rc={rc}")
            rc = adv.SetNamedSecurityInfoW(
                path, SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                None, None, new_acl, None,
            )
            if rc != 0:
                raise OSError(f"SetNamedSecurityInfoW rc={rc}")
        finally:
            if new_acl.value:
                k32.LocalFree(new_acl)
            k32.LocalFree(user_p)
            k32.LocalFree(system_p)
        return True
    except Exception as e:  # noqa: BLE001 —— 收紧失败 = 诚实降级（warn），不阻断
        print(f"[warn] ACL tightening failed for {path}: {e}", file=sys.stderr)
        return False


def _tighten_key_permissions(path: str) -> None:
    """ΠΑΝ-27: 密钥文件权限复查/收紧（新生成与既有加载两条路径都走）。

    - POSIX：``chmod 0600``（旧实现仅 O_EXCL 创建时带 0600，已存在文件
      从不复查 —— umask 放宽过的旧文件持续暴露）。
    - Windows：DACL 收口为「当前用户 + SYSTEM」（见 _tighten_key_acl_windows）。
    运行层方言：失败仅 warn 不 raise（密钥仍可用 —— Layer 1+3 照常承担）。
    """
    if os.name == "nt":
        _tighten_key_acl_windows(path)
        return
    try:
        os.chmod(path, 0o600)
    except OSError as e:
        print(f"[warn] chmod key {path} failed: {e}", file=sys.stderr)


def ensure_key(path: str) -> bytes:
    """加载或生成 HMAC 密钥。

    加载层方法：失败 ``raise`` —— 拒绝带病上线（异常诚实第一条）。
    密钥落盘权限 0600 + 父目录 0700；跨会话稳定。
    ΠΑΝ-27: 已存在文件的权限**复查/收紧**（旧实现只查长度 —— C2-4 M-4：
    Windows 上 ``chmod 0600`` 近 no-op，密钥可被同机继承 ACE 读取 ⇒ 铸
    任意 token）。收紧失败仅 warn 不 raise（密钥仍可用，诚实降级）。
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
        # ΠΑΝ-27: 既有文件复查/收紧（与新生成同一条收口路径）
        _tighten_key_permissions(path)
        return data

    # 生成 32 字节随机密钥
    key = secrets.token_bytes(32)
    # ΠΑΝ-27: 缓冲写 + fsync + **回读复核**。实测依据：本机（py3.14/Win）
    # raw ``os.write`` 约 1 成概率落盘字节漂移（32B 写入读回 33B+，中间插
    # 字节）—— 旧实现不回读，内存返回干净 32B、盘上是漂移字节 ⇒ 后继任何
    # 重读（含 Node 端 ensure_key）与首次内存副本 HMAC 必然失配，且无法
    # 自愈。缓冲写 + fsync 实测 0 漂移；回读复核兜住一切残余路径（失配 ⇒
    # 删掉重写，3 次不成 ⇒ 加载层 raise：密钥落盘不稳定 = 拒绝带病上线）。
    last_disk: bytes = b""
    try:
        for _attempt in range(3):
            _write_key_exclusive(str(p), key)
            _tighten_key_permissions(path)
            last_disk = p.read_bytes()
            if last_disk == key:
                return key
            try:
                p.unlink()  # 漂移落盘：删掉诚实重写，绝不静默用漂移字节
            except OSError:
                pass
    except FileExistsError:
        # O_EXCL 竞态：他进程刚建好密钥 —— 重读即得合法密钥（旧实现直接
        # raise 拒绝上线，而此时合法密钥已在盘上）
        data = p.read_bytes()
        if len(data) < 32:
            raise ValueError(
                f"auth key {path} too short ({len(data)} bytes, need ≥32)"
            )
        _tighten_key_permissions(path)
        return data
    raise RuntimeError(
        f"auth key {path} persisted bytes diverge from generated key "
        f"(disk={len(last_disk)}B, want 32B) after 3 attempts — refusing to "
        "start with a key whose on-disk form is unstable"
    )


def _write_key_exclusive(path: str, key: bytes) -> None:
    """O_EXCL 创建 + 缓冲写 + fsync（fd 单一所有权，异常路径必关）。

    用 ``os.fdopen`` 缓冲写而非 raw ``os.write``：见 ensure_key 内的落盘
    漂移实测注记。0600 在 ``os.open`` 期即生效（POSIX 无默认权限窗口）。
    """
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    wrapped = False
    try:
        with os.fdopen(fd, "wb") as f:
            wrapped = True
            f.write(key)
            f.flush()
            os.fsync(f.fileno())
    finally:
        if not wrapped:  # fdopen 自身失败的窄窗：fd 尚未被接管
            os.close(fd)


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

    return AuthResult(ok=True, pid=pid, caps=caps, exp=exp)


# ─── PID Attestation（Layer 2，Linux 独有）───

def _load_pid_whitelist(raw: str | None) -> set[str]:
    """PID 白名单装载（J 纪元机制化：空壳 → 可用旋钮）。

    ``DSH_PHYSICAL_PID_WHITELIST`` = 逗号分隔的 64 位十六进制 sha256。
    非法条目（长度/字符域不符）**整条拒绝**而非半载 —— 白名单半载比空表
    更危险（给人"已启用"的错觉）。空/缺席 = 开放模式（现状，CI 友好）。
    装载即校验：让 attestation 的严格性在启动期可见，而非运行期静默。
    """
    if not raw:
        return set()
    out: set[str] = set()
    for item in raw.split(","):
        h = item.strip().lower()
        if len(h) == 64 and all(c in "0123456789abcdef" for c in h):
            out.add(h)
        elif h:
            raise ValueError(
                f"DSH_PHYSICAL_PID_WHITELIST entry {item!r} is not a 64-hex sha256 "
                "(refusing half-loaded whitelist — fix or remove the entry)"
            )
    return out


# 加载层（模块导入时一次）：非法配置 ⇒ 启动即失败（异常诚实第一条）
_NODE_BINARY_HASHES: set[str] = _load_pid_whitelist(
    os.environ.get("DSH_PHYSICAL_PID_WHITELIST")
)
"""非空 ⇒ attest_pid 升级为严格二进制身份校验（sha256 of /proc/<pid>/exe）。
传输层 SO_PEERCRED 仍留白（需自定义 uvicorn handler）—— 见模块头注。"""


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


# ─── ΠΑΝ-27: Windows PID 信号（存在性/可执行路径/创建时间）───

_win_attest_degraded_at: float = 0.0
"""最近一次「信号不可得」降级的墙钟时刻（0 = 从未/平台无关）。
``attestation_mode()`` 据此把 Windows 形态诚实降报为 loopback_hmac_only。"""

_DEGRADE_REPORT_WINDOW_S = 600.0
"""降级态的报告窗：窗内 attestation_mode 报 loopback_hmac_only；窗外恢复
win_signals（下一次 attestation 尝试会重探真实信号）。"""

_pid_creation_cache: dict[int, tuple[int, float]] = {}
"""ΠΑΝ-27: ``pid → (创建时间 FILETIME, 最近校验墙钟)`` —— PID 复用检测。
同 pid 创建时间漂移 ⇒ 旧进程已死、pid 被新进程复用 ⇒ 诚实拒绝（旧 token
声称的进程身份已失效）。条目 600s 未刷新即弃（≫ token TTL 60s：旧 token
早已过期，弃条目避免把未来的合法新进程误拒）。"""

_PID_CREATION_CACHE_TTL_S = 600.0
_PID_CREATION_CACHE_MAX = 1024
"""缓存上界（防爆）：不同 pid 数远超此值 ⇒ 异常流量，整体清场重来
（最坏效果 = 复用检测短暂失效一轮，存在性/白名单校验不受影响）。"""


def _win_pid_signals(pid: int) -> tuple[str, str | None, int | None]:
    """ΠΑΝ-27: Windows 内核 PID 信号 —— (status, exe_path, creation_filetime)。

    - ``("ok", exe, creation)``：进程存活，可执行路径与创建时间均可得；
    - ``("dead", None, None)``：进程**确证不存在/已终止** —— OpenProcess 报
      ERROR_INVALID_PARAMETER（pid 无对应进程），或 GetProcessTimes 的
      exit time ≠ 0（已终止但句柄仍被持有 —— 父进程持有子句柄的僵尸形态；
      活进程 exit time 恒 0。死 PID 的 token 诚实拒绝）；
    - ``("unknown", None, None)``：存活但身份信号不可得（查询失败/权限）——
      诚实降级为「仅回环 + HMAC」，绝不误报已校验、也不阻断正路径。
    运行层方法：永不抛错。
    """
    try:
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenProcess.restype = wintypes.HANDLE  # 全宽句柄（64 位截断防线）
        k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k32.QueryFullProcessImageNameW.restype = wintypes.BOOL
        k32.QueryFullProcessImageNameW.argtypes = [
            wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD),
        ]
        k32.GetProcessTimes.restype = wintypes.BOOL
        k32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        k32.CloseHandle.restype = wintypes.BOOL
        k32.CloseHandle.argtypes = [wintypes.HANDLE]

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        ERROR_INVALID_PARAMETER = 87

        handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            err = ctypes.get_last_error()
            if err == ERROR_INVALID_PARAMETER:
                return ("dead", None, None)  # pid 无对应进程 —— 确证死亡
            return ("unknown", None, None)  # 权限/环境不可得 —— 降级
        try:
            # GetProcessTimes 先行：对僵尸（已终止、句柄被持有）同样成功 ——
            # exit time ≠ 0 即确证已终止（活进程恒 0）。
            ct = wintypes.FILETIME()
            et = wintypes.FILETIME()
            kt = wintypes.FILETIME()
            ut = wintypes.FILETIME()
            if not k32.GetProcessTimes(
                handle, ctypes.byref(ct), ctypes.byref(et), ctypes.byref(kt), ctypes.byref(ut)
            ):
                return ("unknown", None, None)
            exit_ft = (et.dwHighDateTime << 32) | et.dwLowDateTime
            if exit_ft != 0:
                return ("dead", None, None)  # 僵尸形态：已终止但句柄仍被持有
            creation = (ct.dwHighDateTime << 32) | ct.dwLowDateTime
            buf = ctypes.create_unicode_buffer(1024)
            n = wintypes.DWORD(1024)
            if not k32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(n)):
                return ("unknown", None, None)  # 存活但路径不可得 —— 降级
            return ("ok", buf.value, creation)
        finally:
            k32.CloseHandle(handle)
    except Exception:  # noqa: BLE001 —— 信号不可得 = 降级，绝不抛
        return ("unknown", None, None)


def _gc_pid_creation_cache(now: float) -> None:
    """过期条目清除 + 上界防爆（每请求 O(条目)，条目数 = 活跃 pid 数）。"""
    global _pid_creation_cache
    stale = [p for p, (_c, seen) in _pid_creation_cache.items() if now - seen > _PID_CREATION_CACHE_TTL_S]
    for p in stale:
        _pid_creation_cache.pop(p, None)
    if len(_pid_creation_cache) > _PID_CREATION_CACHE_MAX:
        _pid_creation_cache.clear()  # 异常流量防爆：复用检测短暂失效一轮


def attest_pid_supported() -> bool:
    """ΠΑΝ-27: 平台是否具备真实 PID attestation 信号。

    linux（/proc）与 win32（内核信号）为真；其余平台（darwin 等）无信号 ⇒
    False（中间件不调用 attestation —— 启动日志诚实申报降级形态）。
    """
    return sys.platform in ("linux", "win32")


def attestation_mode() -> str:
    """当前 Layer 2 attestation 的诚实形态（ΠΑΝ-27: 启动日志/信封标注源）。

    - ``proc_exe_whitelist`` / ``proc_existence``：Linux /proc 两形态；
    - ``win_exe_whitelist`` / ``win_signals``：Windows 白名单/信号形态；
    - ``loopback_hmac_only``：无真实信号（信号不可得降级 / 不支持平台）——
      认证实际仅由 Layer 1（回环/UDS 绑定）+ Layer 3（HMAC token）承担。
    """
    if sys.platform == "linux":
        return "proc_exe_whitelist" if _NODE_BINARY_HASHES else "proc_existence"
    if sys.platform == "win32":
        if _NODE_BINARY_HASHES:
            return "win_exe_whitelist"
        degraded = _win_attest_degraded_at > 0 and (
            time.time() - _win_attest_degraded_at < _DEGRADE_REPORT_WINDOW_S
        )
        return "loopback_hmac_only" if degraded else "win_signals"
    return "loopback_hmac_only"


def attest_pid(pid: int) -> bool:
    """校验 PID 的可执行路径白名单。

    空白名单（缺省）= 仅做存在性校验（任意进程都可访问）；
    非空白名单 = 严格二进制身份校验。
    运行层方法：永不抛错（读 /proc / 内核信号失败 → 按下述语义判决）。

    ΠΑΝ-27: 非 Linux 不再恒 True ——

    - Linux：/proc ``<pid>/exe`` 存在性 + 可选哈希白名单（语义不变）；
    - Windows：OpenProcess 信号 —— 进程**确证死亡** ⇒ False（诚实拒绝）；
      信号可得 ⇒ PID 复用检测（同 pid 创建时间漂移 = 旧进程已死被复用
      ⇒ False）+ 可选 exe 哈希白名单；信号**不可得** ⇒ 诚实降级放行
      （attestation_mode 报 loopback_hmac_only —— 绝不误报已校验）；
    - 其余平台：True（无可得信号 —— Layer 1+3 兜底，启动日志申报）。
    """
    global _win_attest_degraded_at

    if sys.platform == "linux":
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

    if sys.platform == "win32":
        status, exe_path, creation = _win_pid_signals(pid)
        if status == "dead":
            return False  # 死 PID：token 声称的进程身份已失效 —— 诚实拒绝
        if status == "unknown":
            # 信号不可得：降级为「仅回环 + HMAC」（mode 可查）—— 不阻断
            # 正路径（CI 容器/权限受限环境下服务仍可用），但绝不误报已校验。
            _win_attest_degraded_at = time.time()
            return True
        # ok：PID 复用检测 —— 创建时间漂移 ⇒ 旧进程已死被新进程复用
        if creation is not None:
            now = time.time()
            _gc_pid_creation_cache(now)
            cached = _pid_creation_cache.get(pid)
            if cached is not None and cached[0] != creation:
                return False
            _pid_creation_cache[pid] = (creation, now)
        if not _NODE_BINARY_HASHES:
            return True  # 白名单未配置：存在性 + 复用检测即全部可得信号
        if exe_path is None:
            return False
        binary_hash = _hash_binary(exe_path)
        if binary_hash is None:
            return False
        return binary_hash in _NODE_BINARY_HASHES

    return True  # 其余平台：无可得信号（Layer 1+3 兜底 —— 诚实降级）


# ─── Nonce 防重放（Layer 3 加固）───

_used_nonces: dict[str, float] = {}
"""``nonce → 过期时间``。Token 已带 exp，nonce 仅防同一 token 在 TTL 内被多次复用。"""

_nonce_heap: list[tuple[float, str]] = []
"""ΝΩ-9：``(exp, nonce)`` 小顶堆 —— 过期清除与硬上限逐出的共享索引。惰性
校验：堆项出堆时以 ``_used_nonces.get(nonce) == exp`` 为准，失配（条目已被
清场/逐出，如测试 setUp 直接 ``_used_nonces.clear()``）即丢弃，堆中陈旧项
无害。"""

_NONCE_HARD_CAP = 4096
"""ΑΩ-R26：总量硬上限（防爆）。正常流量的表大小 = TTL 窗口内的活跃请求数，
远低于此；仅异常/攻击流量触顶，届时逐出**最早过期**项（ΝΩ-9：heap 根 ——
旧实现按 dict 插入序逐"最旧"，长 TTL 项先死、短 TTL 项赖活，语义错位）。"""


def _gc_nonces(now: float) -> None:
    """ΝΩ-9：时间驱动 GC —— 小顶堆弹净全部已过期项。

    每请求 O(k·log n)（k = 本次到期的条数，通常 0~数条），替换旧实现的
    O(表大小) 全表扫描建 list（每请求都要白扫一遍未到期的大多数）。"""
    while _nonce_heap and _nonce_heap[0][0] < now:
        exp, k = heapq.heappop(_nonce_heap)
        if _used_nonces.get(k) == exp:  # 惰性校验：失配 = 陈旧堆项，弃
            _used_nonces.pop(k, None)


def check_and_consume_nonce(nonce: str, exp: int) -> bool:
    """单次性 nonce 校验。

    - 同一 nonce 第二次出现 → 拒绝（防重放）
    - 过期 nonce 自动清理（避免内存膨胀）

    ΑΩ-R26：时间驱动 GC —— 每次消费顺带清除过期项（旧实现 ``len > 1024``
    才触发，1024 以内的过期 nonce 永驻）。单次代价有界于本次到期条数；
    清后仍超硬上限（异常流量）→ 逐出最早过期项（heap 根），表大小恒有界。
    """
    now = time.time()
    _gc_nonces(now)
    while len(_used_nonces) >= _NONCE_HARD_CAP:
        if _nonce_heap:
            _, evicted = heapq.heappop(_nonce_heap)  # 最早过期者（ΝΩ-9）
            _used_nonces.pop(evicted, None)
        else:  # 病态防御：堆被外部清空而表满 —— 退回插入序逐出（绝无死循环）
            _used_nonces.pop(next(iter(_used_nonces)), None)

    if nonce in _used_nonces:
        return False
    _used_nonces[nonce] = exp
    heapq.heappush(_nonce_heap, (float(exp), nonce))
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
