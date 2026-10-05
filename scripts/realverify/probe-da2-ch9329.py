"""ΤΕΛ-9a 逐债探针 · D-A2:CH9329 串口 HID 真棒在环（hid.py 通道回环）。

债（DEBTS D-A2）：CH9329 串口 HID 棒待真棒在环——SUM/CRC-16 帧构造已 dry-run
可验、pyserial loop:// 序列化回读已实证（real_probe.py --dA2），唯余**真棒接在
真串口上**的通道闭环。本探针把收割动作一键化：

  环境自检（硬件在场判定）：
    1. pyserial 可导入（缺席 ⇒ absent「依赖缺席」——与台账「pyserial
       unavailable」本机复核日志同款诚实语义）；
    2. COM 口枚举里有已知 USB-串口桥 VID（CH340=0x1A86 / CP210x=0x10C4 /
       FT232=0x0403——hid.py `_KNOWN_VIDS` 同源），或显式指定
       `DSH_REALVERIFY_HID_PORT` / `DSH_PHYSICAL_HID_PORT`。
  在场执行（hid.py 通道回环——只发无害帧，绝不点击/按键）：
    - 经 HidController.move() 把绝对鼠标移到屏幕中心附近（纯移动帧
      CMD 0x02，无按键位——对目标机无副作用）；
    - 随后从同一串口回读：CH9329 应答模式回 CMD|0x80 回执帧；若收发
      TX-RX 短接（环回头），回读的就是我们写出的命令帧本身——两种形态
      都经 parse_ch9329_frame 逐帧解校验（帧头/长度/SUM 累加和）。
  判定：
    pass     = 写出成功 + 回读流 ≥1 帧解校验通过（通道闭环实证）；
    degraded = 写出成功但回读零字节（CH9329 出厂模式 0 不回执且未短接——
               写出臂已证，回读环未证）；
    fail     = 串口打开/写出失败（真棒在场但链路坏——真红）。

用法：
  python scripts/realverify/probe-da2-ch9329.py [--force-absent]
退出码：0=pass / 1=fail / 2=absent（真棒缺席，诚实退出）/ 3=degraded。
"""
from __future__ import annotations

import asyncio
import os
import sys
import time

from probe_common import emit, ensure_dsh_physical_on_path, force_absent, run_probe

PROBE = "scripts/realverify/probe-da2-ch9329.py"


def _absent(reason: str, evidence: dict | None = None):
    # ΤΕΛ-9: 缺席诚实退出（exit 2 + 「设备缺席」结构化输出）
    return "absent", f"设备缺席——{reason}", evidence or {}


def main():
    if force_absent():
        # ΤΕΛ-9: 离线确定性测试钩子（缺席语义本身是被测对象）
        return _absent("force-absent（离线测试强制缺席路径）", {"forced": True})

    # ── 1. 依赖自检：pyserial 在场性（台账「pyserial unavailable」同款判定）──
    try:
        import serial  # noqa: F401 —— 在场性探测
        from serial.tools import list_ports
    except Exception as e:  # noqa: BLE001
        return _absent("pyserial 缺席（pip install pyserial 后重跑）", {"import_error": f"{type(e).__name__}: {e}"})

    ensure_dsh_physical_on_path()
    from dsh_physical.errors import PhysicalError
    from dsh_physical.hid import HidConfig, HidController, PySerialTransport, parse_ch9329_frame, scan_serial_ports

    # ── 2. 硬件在场判定：已知 VID 串口（或显式端口）──
    known = scan_serial_ports(ttl_s=0)  # ttl=0 直读（探针不受 TTL 缓存影响）
    all_ports = [{"device": p.device, "desc": (p.description or ""), "vid": (f"0x{p.vid:04X}" if p.vid else None)}
                 for p in list_ports.comports()]
    explicit = os.environ.get("DSH_REALVERIFY_HID_PORT") or os.environ.get("DSH_PHYSICAL_HID_PORT") or ""
    evidence = {
        "comports": all_ports[:8],
        "known_vid_ports": [{"port": p["port"], "vid": (f"0x{p['vid']:04X}" if p["vid"] else None),
                             "desc": p["description"]} for p in known],
        "explicit_port": explicit or None,
    }
    if not known and not explicit:
        return _absent(
            "无 CH9329 棒（COM 口无已知 USB-串口桥 VID：CH340/CP210x/FT232，且未显式指定端口）",
            evidence,
        )

    # ── 3. 在场：hid.py 通道回环（只发无害绝对移动帧——绝不点击/按键/滚轮）──
    port = explicit or known[0]["port"]
    baud = int(os.environ.get("DSH_PHYSICAL_HID_BAUD", "115200"))
    transport = PySerialTransport(port=port, baud=baud, timeout=0.05)
    cfg = HidConfig(port=port, baud=baud, key_interval_ms=0)
    ctrl = HidController(cfg, transport=transport)

    async def _moves() -> list[int]:
        # ΤΕΛ-9: 三次屏心附近纯移动（HidController 真路径：归一化→绝对→组帧→串口写出）
        receipts = []
        for x, y in ((0.5, 0.5), (0.45, 0.5), (0.5, 0.55)):
            receipts.append(await ctrl.move(x, y))
        return receipts

    t0 = time.monotonic()
    try:
        receipts = asyncio.run(_moves())
    except PhysicalError as e:
        # 真棒在场但串口链路失败 ⇒ 真红（fail），不是缺席
        evidence.update({"transport": transport.describe(), "error_kind": e.kind})
        return "fail", f"串口写出失败——真棒在场但链路坏（{e.detail[:160]}）", evidence

    write_s = time.monotonic() - t0
    frames_sent = ctrl._frames_sent  # noqa: SLF001 —— 探针只读（real_probe.py 同律）

    # ── 4. 回读环：收应答帧（CMD|0x80）或 TX-RX 短接回显（命令帧自身）──
    raw = b""
    deadline = time.time() + 1.5
    while time.time() < deadline:
        chunk = transport.read(4096)
        if chunk:
            raw += chunk
        elif raw:
            break
    transport.close()

    frames: list[dict] = []
    off = 0
    parse_clean = True
    parse_err = None
    while off < len(raw):
        try:
            addr, cmd, data = parse_ch9329_frame(raw[off:])
        except ValueError as e:
            parse_clean = False
            parse_err = f"offset {off}: {e}"
            break
        frames.append({"addr": addr, "cmd": f"0x{cmd:02x}", "len": len(data),
                       "kind": "ack" if cmd & 0x80 else "echo"})
        off += 5 + len(data) + 1

    evidence.update({
        "port": port, "baud": baud,
        "transport": {"backend": "pyserial", "port": port, "baud": baud},
        "moves": len(receipts), "frames_sent": frames_sent,
        "write_elapsed_ms": round(write_s * 1000, 1),
        "bytes_read": len(raw), "frames_parsed": frames[:6],
        "parse_clean": parse_clean and off == len(raw),
        **({"parse_error": parse_err} if parse_err else {}),
    })

    if frames_sent < 3:
        return "fail", f"写出帧数不足（{frames_sent}/3）——串口通但 hid.py 发送面异常", evidence
    if frames and evidence["parse_clean"]:
        kinds = sorted({f["kind"] for f in frames})
        return ("pass",
                f"CH9329 真棒通道闭环：{frames_sent} 帧绝对移动命令经真串口写出，回读 {len(frames)} 帧解 SUM 校验通过（{'+'.join(kinds)}）—— D-A2 可收割",
                evidence)
    if not raw:
        return ("degraded",
                "写出臂已证（3 帧经真串口 flush）但回读零字节——CH9329 出厂模式 0 不回执；短接 TX-RX 或设应答模式后重跑可得 pass",
                evidence)
    return "degraded", f"写出成功但回读流不可整体解帧（{parse_err or '残余字节'}）——部分实证", evidence


if __name__ == "__main__":
    # ΤΕΛ-9: run_probe 外包裹——任何异常折叠为结构化 fail（探针绝不裸抛）
    sys.exit(run_probe("D-A2", PROBE, main))
