"""SO_PEERCRED 传输层佐证（K 纪元后补：L 纪元留白兑现）—— Linux UDS 专属。

机制：自定义 uvicorn HTTP 协议子类在 connection_made 取对端 ucred
（SO_PEERCRED = 17, struct ucred {pid, uid, gid}），把 peer_pid 注入 ASGI
scope；auth 中间件据此刻度 token payload.pid（auth.py 头注承诺的校验落地）。

诚实边界（成对声明）：Node 侧 undici fetch 不认 http+unix://（adapter 已在
加载层诚实拒绝）—— 本模块补全的是**服务端半边**；客户端半边仍为声明留白，
待 Node 侧引入 unix-socket Agent 后端到端可达。非 Linux / 非 UDS ⇒ 恒 None。
"""
from __future__ import annotations

import struct
import sys

SO_PEERCRED = 17  # Linux only（其他平台 getsockopt 直接抛错 → 捕获降级）
_UCRED_SIZE = struct.calcsize("3i")


def read_peer_pid(transport) -> int | None:
    """从 asyncio transport 的底层 socket 取对端 PID。失败/非 UDS ⇒ None。"""
    if sys.platform != "linux":
        return None
    try:
        sock = transport.get_extra_info("socket")
        if sock is None:
            return None
        raw = sock.getsockopt(1, SO_PEERCRED, _UCRED_SIZE)  # SOL_SOCKET = 1
        pid, _uid, _gid = struct.unpack("3i", raw)
        return pid if pid > 0 else None
    except Exception:  # noqa: BLE001 — 佐证缺席 = 降级，绝不阻断服务
        return None


def make_peercred_protocol():
    """构造带 ucred 捕获的 HTTP 协议类（uvicorn `http=` 插件位）。

    scope 注入经 app 包装：协议捕获 pid → 每请求把 peer_pid 写进 scope 副本
    → 原 app 照常收（零侵入既有中间件；auth 侧按 scope.get('peer_pid') 刻度）。
    返回 None = 当前环境不可用（非 Linux / uvicorn 缺席）—— 调用方保持原样。
    """
    if sys.platform != "linux":
        return None
    try:
        from uvicorn.protocols.http.h11_impl import H11Protocol
    except Exception:  # noqa: BLE001
        return None

    class PeerCredProtocol(H11Protocol):
        _peer_pid: int | None = None

        def connection_made(self, transport):  # type: ignore[override]
            super().connection_made(transport)
            self._peer_pid = read_peer_pid(transport)
            if self._peer_pid is not None:
                inner = self.app

                async def app_with_peer_pid(scope, receive, send):
                    scope = dict(scope)
                    scope["peer_pid"] = self._peer_pid
                    await inner(scope, receive, send)

                self.app = app_with_peer_pid

    return PeerCredProtocol
