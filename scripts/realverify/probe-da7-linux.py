"""ΤΕΛ-9a 逐债探针 · D-A7:Linux 真机首验（uinput/peercred/POSIX shm 路径）。

债（DEBTS D-A7，半闭）：ci.yml Linux 物理服务 e2e 步骤已落地（可编辑安装 →
tcp:8421 预起 → adapter.http 真服务路径 + /dev/shm POSIX 分支），唯余下次
push 后 Linux runner 真机首验。Windows 主开发环境无法覆盖——本探针把
「Linux 到场当天」的验收动作一键化（在 Linux 机器/runner 上一键跑）：

  环境自检（硬件在场判定）：
    sys.platform == 'linux'（Windows/macOS ⇒ absent「平台缺席」——本机
    Windows 开发环境的常态诚实退出）。
  在场执行（Linux 真机路径四验）：
    a. /dev/uinput 在场 + 可写（物理输入注入面——uinput 权限：root 或
       uinput 组/udev 规则）；
    b. /dev/shm 在场 + 可写 + 剩余空间（ci.yml POSIX shm 分支的物理前提）；
    c. AF_UNIX socketpair + SO_PEERCRED（=17，dsh_physical.peercred 同源
       常量）取对端 pid —— 期望等于本进程 pid（内核佐证路径真执法）；
    d. dsh_physical.peercred.make_peercred_protocol() 可构造（uvicorn 协议
       插件位——服务端半边的装配面）；
    e. （可选）DSH_REALVERIFY_LINUX_SERVICE=1 时连 http://127.0.0.1:8421/health
       探活（预起服务的首验配方——探针不自行起服务，保持只读验收语义）。
  判定：
    pass     = a+b+c 全过（d 仅作证据申报——uvicorn 缺席不降级，服务面走 e）；
    degraded = c 过但 uinput/shm 任一缺席（UDS 路径证毕，注入/shm 面缺配置）；
    fail     = AF_UNIX/SO_PEERCRED 内核路径失败（Linux 在场而佐证面坏——真红）。

用法：
  python scripts/realverify/probe-da7-linux.py [--force-absent]
退出码：0=pass / 1=fail / 2=absent（Linux 平台缺席）/ 3=degraded。
"""
from __future__ import annotations

import json
import os
import socket
import struct
import sys
import urllib.request

from probe_common import ensure_dsh_physical_on_path, force_absent, run_probe

PROBE = "scripts/realverify/probe-da7-linux.py"
SO_PEERCRED = 17  # ΤΕΛ-9: 与 dsh_physical/peercred.py 同源常量（Linux UDS 专属）
_UCRED_SIZE = struct.calcsize("3i")


def _absent(reason: str, evidence: dict | None = None):
    # ΤΕΛ-9: 缺席诚实退出（exit 2 + 「设备缺席」结构化输出）
    return "absent", f"平台/设备缺席——{reason}", evidence or {}


def main():
    if force_absent():
        return _absent("force-absent（离线测试强制缺席路径）", {"forced": True})

    if sys.platform != "linux":
        return _absent(f"非 Linux 平台（{sys.platform}）——UDS/uinput/peercred 唯余 Linux 真机在场", {"platform": sys.platform})

    evidence: dict = {"platform": sys.platform, "kernel": os.uname().release if hasattr(os, "uname") else None}

    # ── a. /dev/uinput（物理注入面）──
    uinput = os.path.exists("/dev/uinput")
    uinput_writable = uinput and os.access("/dev/uinput", os.W_OK)
    evidence["uinput"] = {"present": uinput, "writable": bool(uinput_writable)}

    # ── b. /dev/shm（POSIX shm 分支——ci.yml 同款路径）──
    shm_ok = False
    shm_note = ""
    try:
        probe_file = "/dev/shm/.tel9_probe"
        with open(probe_file, "wb") as f:
            f.write(b"tel9")
        os.unlink(probe_file)
        shm_ok = True
        stat = os.statvfs("/dev/shm")
        evidence["shm"] = {"present": True, "writable": True,
                           "free_bytes": stat.f_bavail * stat.f_frsize}
    except Exception as e:  # noqa: BLE001
        shm_note = f"{type(e).__name__}: {e}"
        evidence["shm"] = {"present": os.path.exists("/dev/shm"), "writable": False, "note": shm_note[:160]}

    # ── c. AF_UNIX + SO_PEERCRED（内核佐证——peercred.py 同源语义）──
    peer_pid = None
    peer_err = None
    try:
        a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            raw = a.getsockopt(socket.SOL_SOCKET, SO_PEERCRED, _UCRED_SIZE)
            pid, uid, gid = struct.unpack("3i", raw)
            peer_pid = pid
            evidence["peercred"] = {"peer_pid": pid, "uid": uid, "gid": gid,
                                    "self_pid": os.getpid(), "pid_match": pid == os.getpid()}
        finally:
            a.close()
            b.close()
    except OSError as e:
        peer_err = f"{type(e).__name__}: {e}"
        evidence["peercred"] = {"error": peer_err[:200]}

    # ── d. 服务端协议插件装配面（uvicorn 在场性——证据申报，不参与判定）──
    protocol_ok = None
    try:
        ensure_dsh_physical_on_path()
        from dsh_physical.peercred import make_peercred_protocol

        protocol_ok = make_peercred_protocol() is not None
    except Exception as e:  # noqa: BLE001 —— 装配面缺席如实申报
        protocol_ok = None
        evidence["peercred_protocol"] = f"unavailable: {type(e).__name__}"
    if protocol_ok is not None:
        evidence["peercred_protocol"] = {"constructible": protocol_ok}

    # ── e. （可选）预起服务探活——ci.yml 首验配方的只读验收 ──
    if os.environ.get("DSH_REALVERIFY_LINUX_SERVICE") == "1":
        try:
            with urllib.request.urlopen("http://127.0.0.1:8421/health", timeout=5) as r:
                evidence["service_health"] = {"status": r.status, "body_head": r.read(400).decode("utf-8", "replace")}
        except Exception as e:  # noqa: BLE001
            evidence["service_health"] = {"error": f"{type(e).__name__}: {e}"[:200]}

    # ── 判定（c 是 Linux 佐证面的必要条件）──
    if peer_pid is None:
        return "fail", f"SO_PEERCRED 内核路径失败（{peer_err}）——Linux 在场而 UDS 佐证面坏", evidence
    pid_match = evidence["peercred"].get("pid_match") is True
    if pid_match and uinput_writable and shm_ok:
        return ("pass",
                "Linux 真机首验路径全过：/dev/uinput 可写 + /dev/shm 可写 + SO_PEERCRED 对端 pid 与本进程一致"
                + ("（服务 /health 探活入证据）" if "service_health" in evidence else "")
                + "—— D-A7 可收割",
                evidence)
    if pid_match:
        missing = [n for n, ok in (("uinput", uinput_writable), ("shm", shm_ok)) if not ok]
        return ("degraded",
                f"UDS peercred 佐证证毕（pid 匹配），但 {missing} 缺配置——ci.yml e2e 的对应分支将走降级路径",
                evidence)
    return "fail", f"SO_PEERCRED 返回 pid 异常（peer={peer_pid}，self={os.getpid()}）", evidence


if __name__ == "__main__":
    # ΤΕΛ-9: run_probe 外包裹——任何异常折叠为结构化 fail（探针绝不裸抛）
    sys.exit(run_probe("D-A7", PROBE, main))
