"""HID 棒后端 —— L2 零 API 设备面:CH9329/ESP32 串口 HID 协议(W4-6)。

场景:目标设备无辅助功能 API(无障碍服务被禁 / 游戏主机 / BIOS 画面)时,
物理链路 = 本服务 → USB HID 棒(CH9329 串口转 HID 芯片,或 ESP32 自固件)
→ 目标设备 USB 口。目标设备视角里这是**一只真鼠标真键盘** —— 零驱动、
零 API、零检测面。本模块是「手」:协议帧构造为纯函数(可离线单测),
串口经可注入 transport 隔离(缺省 pyserial,缺席 mock 字节流)。

协议选型(W4-6):
  - **CH9329**(主协议):帧 = ``57 AB ADDR CMD LEN DATA… SUM``,
    SUM = (ADDR+CMD+LEN+DATA) 累加和截 8bit(手册官方校验)。
    CMD 0x02 绝对鼠标(X/Y 0..32767 小端)· 0x04 相对鼠标 · 0x08 标准键盘
    (HID Usage ID + 修饰键位图)。设备回执帧 CMD|0x80。
  - **ESP32 变体**:自固件场景 UART 噪声更常见,帧尾用 **CRC-16/XMODEM**
    (多项式 0x1021,校验值 ``b"123456789" → 0x31C3`` —— 业界标准测试向量)
    做双字节校验。两种校验并存:SUM 保 CH9329 官方语义,CRC 保自固件链路。

文本策略(W4-6):HID 键盘码表只覆盖 ASCII(非 ASCII 字符没有 Usage ID);
大文本/中文走 **Ctrl+V 组合键粘贴策略** —— 调用方负责先把内容放进目标机
剪贴板(零 API 设备面上,本服务无法替目标机写剪贴板 —— 诚实边界,见
``type_text`` 的 ``mode`` 文档)。

方言对齐 ``input.py``(只读不改动):归一化 [0,1] 坐标契约、``dry_run``
调用级覆盖、``PhysicalError`` 错误信封(UNKNOWN_KEY/OUT_OF_BOUNDS 同 kind)、
审计回执形状 —— 便于未来注册进 routes.py。

自测入口(W4-6):``python -m dsh_physical.hid --selftest``
"""
from __future__ import annotations

import asyncio
import os
import struct
import sys
from dataclasses import dataclass
from typing import Literal, Protocol

from .errors import ErrorKind, PhysicalError

# ─── 配置(W4-6):环境变量方言与 config.py 同律(DSH_PHYSICAL_ 前缀)───


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as e:
        raise ValueError(f"env {name} must be int, got {raw!r}") from e


@dataclass(frozen=True)
class HidConfig:
    """HID 棒配置(W4-6)。

    - ``port``:串口名(空 = PySerialTransport 打开时自动扫描 CH340/CP210x)
    - ``baud``:CH9329 出厂 9600,量产惯例升 115200(固件参数页须同步改)
    - ``target_width/height``:目标机分辨率(审计回执像素换算用;绝对坐标
      0..32767 与分辨率无关 —— 这正是绝对鼠标抗分辨率漂移的根基)
    - ``paste_threshold``:超过该字符数自动改走 Ctrl+V 粘贴策略
    - ``target_os``:粘贴组合键平台(win/linux → Ctrl+V;mac → Cmd+V)
    """

    port: str = ""
    baud: int = 115_200
    target_width: int = 1920
    target_height: int = 1080
    paste_threshold: int = 64
    target_os: Literal["win", "linux", "mac"] = "win"
    key_interval_ms: int = 2


def load_hid_config_from_env() -> HidConfig:
    """加载层方法(config.py 方言):校验失败 raise(W4-6)。"""
    os_name = _env("DSH_PHYSICAL_HID_TARGET_OS", "win").lower()
    if os_name not in {"win", "linux", "mac"}:
        raise ValueError(f"DSH_PHYSICAL_HID_TARGET_OS must be win/linux/mac, got {os_name!r}")
    return HidConfig(
        port=_env("DSH_PHYSICAL_HID_PORT", ""),
        baud=_env_int("DSH_PHYSICAL_HID_BAUD", 115_200),
        target_width=max(1, _env_int("DSH_PHYSICAL_HID_TARGET_W", 1920)),
        target_height=max(1, _env_int("DSH_PHYSICAL_HID_TARGET_H", 1080)),
        paste_threshold=max(1, _env_int("DSH_PHYSICAL_HID_PASTE_THRESHOLD", 64)),
        target_os=os_name,  # type: ignore[arg-type]
        key_interval_ms=max(0, _env_int("DSH_PHYSICAL_HID_KEY_INTERVAL_MS", 2)),
    )


# ─── CH9329 协议:帧构造纯函数区(零 I/O,可离线单测)(W4-6)───

HEAD = b"\x57\xab"          # CH9329 帧头
ADDR_HOST = 0x00            # 主机→设备地址(缺省)

CMD_ABS_MOUSE = 0x02        # 绝对鼠标(DATA: btn, x_lo, x_hi, y_lo, y_hi, wheel)
CMD_REL_MOUSE = 0x04        # 相对鼠标(DATA: btn, dx, dy, wheel, 0x00)
CMD_KB_GENERAL = 0x08       # 标准键盘(DATA: modifier, 0x00, key×8)
CMD_KB_MEDIA = 0x12         # 多媒体键(部分固件变体)

# 鼠标键位(W4-6):位图 —— 低位对齐 CH9329/HID 惯例
BTN_LEFT = 0x01
BTN_RIGHT = 0x02
BTN_MIDDLE = 0x04
BUTTON_MAP: dict[str, int] = {"left": BTN_LEFT, "right": BTN_RIGHT, "middle": BTN_MIDDLE}

ABS_MAX = 0x7FFF            # 绝对坐标域 0..32767(HID 15bit 惯例)


def checksum_sum(payload: bytes) -> int:
    """CH9329 官方校验:ADDR+CMD+LEN+DATA 逐字节累加,截 8bit(纯函数)(W4-6)。

    手算对照(自测断言):``00 02 06 01`` → (0+2+6+1)&0xFF = 0x09。
    """
    return sum(payload) & 0xFF


def crc16_xmodem(data: bytes, crc: int = 0x0000) -> int:
    """CRC-16/XMODEM(多项式 0x1021,init 0,无反转,无异或出)—— ESP32 变体帧尾(W4-6)。

    标准测试向量(自测断言):``b"123456789"`` → ``0x31C3``。
    """
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if (crc & 0x8000) else (crc << 1)
            crc &= 0xFFFF
    return crc


def ch9329_frame(cmd: int, data: bytes, addr: int = ADDR_HOST) -> bytes:
    """组帧:``57 AB ADDR CMD LEN DATA… SUM``(纯函数;SUM 官方累加和)(W4-6)。"""
    if not 0 <= len(data) <= 255:
        raise ValueError(f"CH9329 data length out of 0..255: {len(data)}")
    body = bytes([addr, cmd, len(data)]) + data
    return HEAD + body + bytes([checksum_sum(body)])


def parse_ch9329_frame(buf: bytes) -> tuple[int, int, bytes]:
    """解帧(设备回执/mock 往返用):校验头/长度/累加和(纯函数)(W4-6)。

    损坏帧 raise ``ValueError``(调用方转 PhysicalError 信封)。
    """
    if len(buf) < 6:
        raise ValueError(f"frame too short: {len(buf)} bytes")
    if buf[:2] != HEAD:
        raise ValueError(f"bad head: {buf[:2]!r}")
    addr, cmd, ln = buf[2], buf[3], buf[4]
    if len(buf) < 5 + ln + 1:
        raise ValueError(f"truncated: need {5 + ln + 1}, got {len(buf)}")
    data = buf[5:5 + ln]
    got = checksum_sum(buf[2:5 + ln])
    if got != buf[5 + ln]:
        raise ValueError(f"checksum mismatch: computed 0x{got:02x}, got 0x{buf[5 + ln]:02x}")
    return addr, cmd, data


def esp32_frame(cmd: int, data: bytes) -> bytes:
    """ESP32 自固件变体:``55 AA CMD LEN_LE16 DATA… CRC16_LE``(CRC 保串口噪声)(W4-6)。"""
    body = bytes([cmd]) + struct.pack("<H", len(data)) + data
    crc = crc16_xmodem(body)
    return b"\x55\xaa" + body + struct.pack("<H", crc)


def esp32_check(frame: bytes) -> bool:
    """ESP32 变体帧校验(纯函数;自测 mock 往返用)(W4-6)。"""
    if len(frame) < 7 or frame[:2] != b"\x55\xaa":
        return False
    ln = struct.unpack("<H", frame[3:5])[0]
    if len(frame) < 5 + ln + 2:
        return False
    want = struct.unpack("<H", frame[5 + ln:7 + ln])[0]
    return crc16_xmodem(frame[2:5 + ln]) == want


# ─── 绝对鼠标 / 滚轮 / 相对鼠标帧(W4-6)───


def clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, int(v)))


def abs_mouse_frame(buttons: int, x: int, y: int, wheel: int = 0) -> bytes:
    """绝对鼠标帧 CMD 0x02(X/Y 钳制 0..32767 小端;wheel 钳制 ±127)(W4-6)。

    手算对照(自测断言):
      - 左键按下 @(0,0):   ``57 AB 00 02 06 01 00 00 00 00 00 09``
        (SUM = 00+02+06+01 = 09)
      - 无键 @(0x7FFF,0x7FFF): ``57 AB 00 02 06 00 FF 7F FF 7F 00 04``
        (SUM = 02+06+FF+7F+FF+7F = 0x304 → 截 8bit = 04)
    """
    if not 0 <= buttons <= 0x07:
        raise ValueError(f"mouse buttons bitmap out of 0..7: {buttons}")
    data = bytes([buttons]) + struct.pack("<HHb", clamp(x, 0, ABS_MAX), clamp(y, 0, ABS_MAX), clamp(wheel, -127, 127))
    return ch9329_frame(CMD_ABS_MOUSE, data)


def rel_mouse_frame(buttons: int, dx: int, dy: int, wheel: int = 0) -> bytes:
    """相对鼠标帧 CMD 0x04(横向滚动的载体;dx/dy/wheel 有符号字节)(W4-6)。"""
    data = bytes([buttons]) + struct.pack("<bbB", clamp(dx, -127, 127), clamp(dy, -127, 127), clamp(wheel, -127, 127) & 0xFF) + b"\x00"
    return ch9329_frame(CMD_REL_MOUSE, data)


def wheel_frames(direction: str, amount: int) -> list[bytes]:
    """滚轮:垂直 = 绝对帧 wheel 字节(正=向上);水平 = 相对帧 dx(W4-6)。

    单帧 wheel 钳 ±127 ⇒ 大 amount 自动分帧(每帧 127 上限)。
    """
    if direction not in {"up", "down", "left", "right"}:
        raise ValueError(f"unknown scroll direction: {direction!r}")
    if amount <= 0 or amount > 1000:
        raise ValueError(f"scroll amount out of range: {amount} (1-1000)")
    frames: list[bytes] = []
    if direction in {"up", "down"}:
        step = 1 if direction == "up" else -1
        left = amount
        while left > 0:
            n = min(left, 127)
            frames.append(abs_mouse_frame(0, ABS_MAX // 2, ABS_MAX // 2, step * n))
            left -= n
    else:
        step = 1 if direction == "right" else -1
        left = amount
        while left > 0:
            n = min(left, 127)
            frames.append(rel_mouse_frame(0, step * n, 0, 0))
            left -= n
    return frames


# ─── 键盘:Usage ID 码表 + 组合键帧(W4-6)───

# HID Usage ID(USB HID Usage TablesKeyboard/Keypad Page 0x07)
USAGE = {
    **{chr(c): 0x04 + (c - ord("a")) for c in range(ord("a"), ord("z") + 1)},
    **{str(d): 0x1E + (d - 1) for d in range(1, 10)},
    "enter": 0x28, "esc": 0x29, "backspace": 0x2A, "tab": 0x2B, "space": 0x2C,
    "-": 0x2D, "=": 0x2E, "[": 0x2F, "]": 0x30, "\\": 0x31,
    ";": 0x33, "'": 0x34, "`": 0x35, ",": 0x36, ".": 0x37, "/": 0x38,
    "capslock": 0x39,
    "f1": 0x3A, "f2": 0x3B, "f3": 0x3C, "f4": 0x3D, "f5": 0x3E, "f6": 0x3F,
    "f7": 0x40, "f8": 0x41, "f9": 0x42, "f10": 0x43, "f11": 0x44, "f12": 0x45,
    "printscreen": 0x46, "delete": 0x4C, "home": 0x4A, "end": 0x4D,
    "pageup": 0x4B, "pagedown": 0x4E,
    "up": 0x52, "down": 0x51, "left": 0x50, "right": 0x4F,
    "insert": 0x49,
}
USAGE["0"] = 0x27  # '1'..'9' = 0x1E..0x26,'0' = 0x27(Usage Tables 官方排布)

# 上档符号:字符 → (shift, 基键)。大写字母 = shift + 小写 Usage。
SHIFT_BASE: dict[str, str] = {
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6",
    "&": "7", "*": "8", "(": "9", ")": "0",
    ":": ";", '"': "'", "<": ",", ">": ".", "?": "/",
    "{": "[", "}": "]", "|": "\\", "~": "`", "_": "-", "+": "=",
}

# 修饰键字节(HID 键盘报告 bit0..bit7 = L-Ctrl/L-Shift/L-Alt/L-GUI/R-…)
MOD_LCTRL = 0x01
MOD_LSHIFT = 0x02
MOD_LALT = 0x04
MOD_LGUI = 0x08
MOD_RCTRL = 0x10
MOD_RSHIFT = 0x20
MOD_RALT = 0x40
MOD_RGUI = 0x80

# 控制键名 → (修饰字节, Usage)。与 input.py 的 keyMap 同名覆盖面(方言对齐,
# 但映射目标是 HID Usage 而非 pyautogui 键名 —— 两张表不可混用)。
KEY_TABLE: dict[str, tuple[int, int]] = {
    "ctrl": (MOD_LCTRL, 0xE0), "control": (MOD_LCTRL, 0xE0),
    "shift": (MOD_LSHIFT, 0xE1),
    "alt": (MOD_LALT, 0xE2), "option": (MOD_LALT, 0xE2),
    "win": (MOD_LGUI, 0xE3), "meta": (MOD_LGUI, 0xE3),
    "super": (MOD_LGUI, 0xE3), "cmd": (MOD_LGUI, 0xE3),
    "rctrl": (MOD_RCTRL, 0xE4), "rshift": (MOD_RSHIFT, 0xE5),
    "enter": (0, USAGE["enter"]), "return": (0, USAGE["enter"]),
    "esc": (0, USAGE["esc"]), "escape": (0, USAGE["esc"]),
    "backspace": (0, USAGE["backspace"]), "tab": (0, USAGE["tab"]),
    "space": (0, USAGE["space"]), "delete": (0, USAGE["delete"]),
    "del": (0, USAGE["delete"]),
    "home": (0, USAGE["home"]), "end": (0, USAGE["end"]),
    "pageup": (0, USAGE["pageup"]), "pagedown": (0, USAGE["pagedown"]),
    "up": (0, USAGE["up"]), "down": (0, USAGE["down"]),
    "left": (0, USAGE["left"]), "right": (0, USAGE["right"]),
    "arrowup": (0, USAGE["up"]), "arrowdown": (0, USAGE["down"]),
    "arrowleft": (0, USAGE["left"]), "arrowright": (0, USAGE["right"]),
    "printscreen": (0, USAGE["printscreen"]), "prtsc": (0, USAGE["printscreen"]),
    "insert": (0, USAGE["insert"]),
    "capslock": (0, USAGE["capslock"]),
    **{f"f{i}": (0, USAGE[f"f{i}"]) for i in range(1, 13)},
    **{chr(c): (0, USAGE[chr(c)]) for c in range(ord("a"), ord("z") + 1)},
    **{str(d): (0, USAGE[str(d)]) for d in range(0, 10)},
}
_MODIFIER_USAGES = {0xE0, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7}


def char_report(ch: str) -> tuple[int, int] | None:
    """单字符 → (modifier, usage);无 Usage ID 的字符返回 None(纯函数)(W4-6)。

    手算对照(自测断言):'H' → (0x02, 0x0B)(shift + h);"!" → (0x02, 0x1E)。
    """
    if len(ch) != 1:
        raise ValueError(f"char_report expects single char, got {ch!r}")
    if ch.isascii():
        if ch.islower() and ch.isalpha():
            return (0, USAGE[ch])
        if ch.isupper() and ch.isalpha():
            return (MOD_LSHIFT, USAGE[ch.lower()])
        if ch in USAGE:
            return (0, USAGE[ch])
        if ch in SHIFT_BASE:
            return (MOD_LSHIFT, USAGE[SHIFT_BASE[ch]])
        if ch == "\n":
            return (0, USAGE["enter"])
    return None  # CJK / emoji 等:无 Usage ID —— 走粘贴策略的信号


def kb_frame(modifier: int, keys: list[int]) -> bytes:
    """标准键盘帧 CMD 0x08:LEN=10(modifier, 0x00, key×8;活动键 ≤6 防 boot 6KRO 越界)(W4-6)。

    CH9329 手册:0x08 帧 DATA 定长 10 字节(修饰键 + 保留 + 8 键槽)——
    即使只按一键也补零到 8 槽(逐字节可复现的手册帧型)。
    手算对照(自测断言):
      - 按下 'a':``57 AB 00 08 0A 00 00 04 00×7 16``(SUM = 08+0A+04 = 16)
      - Shift+'A':modifier=0x02 → SUM = 08+0A+02+04 = 18
    """
    if len(keys) > 6:
        raise ValueError(f"too many keys in one report (boot protocol 6KRO): {len(keys)}")
    if any(k in _MODIFIER_USAGES for k in keys):
        raise ValueError("modifier usage 0xE0-0xE7 must go in modifier byte, not key slots")
    data = bytes([modifier & 0xFF, 0x00]) + bytes(keys) + b"\x00" * (8 - len(keys))
    return ch9329_frame(CMD_KB_GENERAL, data)


def kb_release_frame() -> bytes:
    """全键释放帧(modifier=0,keys 空 —— 任何组合的对称收尾)(W4-6)。"""
    return kb_frame(0, [])


def text_frames(text: str) -> list[bytes]:
    """ASCII 文本 → 逐字符 [按下, 释放…] 帧序列(纯函数)(W4-6)。

    非 ASCII 字符出现即 raise ValueError(调用方决定降级粘贴策略)。
    """
    frames: list[bytes] = []
    for ch in text:
        rep = char_report(ch)
        if rep is None:
            raise ValueError(f"no HID usage for {ch!r} (non-ASCII: use paste strategy)")
        mod, usage = rep
        frames.append(kb_frame(mod, [usage]))
        frames.append(kb_release_frame())
    return frames


def hotkey_frames(keys: list[str]) -> list[bytes]:
    """组合键 → [全按下, 全释放] 两帧(修饰键入 modifier 字节,对称语义)(W4-6)。"""
    if not keys or len(keys) > 5:
        raise ValueError(f"hotkey keys count out of range: {len(keys)} (1-5)")
    mod = 0
    usages: list[int] = []
    for k in keys:
        entry = KEY_TABLE.get(k.lower())
        if entry is None:
            raise ValueError(f"unknown key: {k!r}")
        m, u = entry
        mod |= m
        if u < 0xE0:
            usages.append(u)
    return [kb_frame(mod, usages), kb_release_frame()]


def paste_frames(target_os: str = "win") -> list[bytes]:
    """粘贴策略帧:Ctrl+V(win/linux)或 Cmd+V(mac)按下→释放(W4-6)。

    前置契约:目标机剪贴板已由调用方备好内容(HID 链路无法代写剪贴板)。
    """
    mod = MOD_LGUI if target_os == "mac" else MOD_LCTRL
    return [kb_frame(mod, [USAGE["v"]]), kb_release_frame()]


# ─── 串口 transport(可注入;缺省 pyserial,缺席 mock)(W4-6)───


class SerialTransport(Protocol):
    """串口契约:阻塞式 write/read —— 控制器丢线程池(input.py 方言)(W4-6)。"""

    def open(self) -> None: ...
    def write(self, data: bytes) -> None: ...
    def read(self, size: int) -> bytes: ...
    def flush(self) -> None: ...
    def close(self) -> None: ...
    def describe(self) -> dict: ...


# 常见 USB-串口桥 VID(CH340/CH9102 = 0x1A86;CP210x = 0x10C4;FT232 = 0x0403)
_KNOWN_VIDS = {0x1A86, 0x10C4, 0x0403, 0x1B4F}


def scan_serial_ports() -> list[dict]:
    """枚举已知 VID 的串口(CH9329 常挂 CH340/CP210x 桥;无 pyserial ⇒ 空)(W4-6)。"""
    try:
        from serial.tools import list_ports
    except Exception:  # noqa: BLE001
        return []
    return [
        {"port": p.device, "vid": p.vid, "description": p.description or ""}
        for p in list_ports.comports()
        if p.vid in _KNOWN_VIDS
    ]


class PySerialTransport:
    """pyserial 串口(懒加载;缺席/打不开 ⇒ PhysicalError 诚实信封)(W4-6)。"""

    def __init__(self, port: str = "", baud: int = 115_200, timeout: float = 0.2) -> None:
        self.port = port
        self.baud = baud
        self.timeout = timeout
        self._ser = None

    def open(self) -> None:
        if self._ser is not None:
            return
        try:
            import serial
        except Exception as e:  # noqa: BLE001
            raise PhysicalError(
                ErrorKind.INTERNAL_ERROR,
                f"pyserial unavailable (HID stick needs pip install pyserial): {e}",
            ) from e
        port = self.port
        if not port:
            candidates = scan_serial_ports()
            if not candidates:
                raise PhysicalError(
                    ErrorKind.INTERNAL_ERROR,
                    "no known USB-serial device found (CH340/CP210x/FT232); "
                    "set DSH_PHYSICAL_HID_PORT explicitly",
                )
            port = candidates[0]["port"]
            self.port = port
        try:
            self._ser = serial.Serial(port, self.baud, timeout=self.timeout)
        except Exception as e:  # noqa: BLE001
            raise PhysicalError(
                ErrorKind.INTERNAL_ERROR,
                f"serial open({port!r}@{self.baud}) failed: {e}",
            ) from e

    def _ensure(self):
        if self._ser is None:
            self.open()
        return self._ser

    def write(self, data: bytes) -> None:
        self._ensure().write(data)

    def read(self, size: int) -> bytes:
        return self._ensure().read(size) or b""

    def flush(self) -> None:
        self._ensure().flush()

    def close(self) -> None:
        if self._ser is not None:
            self._ser.close()
            self._ser = None

    def describe(self) -> dict:
        return {
            "backend": "pyserial", "port": self.port or "(auto-scan)",
            "baud": self.baud, "open": self._ser is not None,
        }


class MockSerialTransport:
    """mock 字节流:记录写出帧;可选罐头回读(自测往返的确定性通道)(W4-6)。"""

    def __init__(self, canned_reads: list[bytes] | None = None) -> None:
        self.written: list[bytes] = []
        self._reads: list[bytes] = list(canned_reads or [])
        self._open = False

    def open(self) -> None:
        self._open = True

    def write(self, data: bytes) -> None:
        if not self._open:
            raise PhysicalError(ErrorKind.INTERNAL_ERROR, "mock serial not open")
        self.written.append(bytes(data))

    def read(self, size: int) -> bytes:
        return self._reads.pop(0)[:size] if self._reads else b""

    def flush(self) -> None:
        return None

    def close(self) -> None:
        self._open = False

    def describe(self) -> dict:
        return {"backend": "mock", "frames_written": len(self.written), "open": self._open}


# ─── HidController(W4-6):input.py 同方言的注入控制器 ───


class HidController:
    """串口 HID 控制器:归一化坐标 → CH9329 帧 → 串口(异步,运行层不抛裸异常)。

    方法形状与 ``InputController`` 对齐:归一化 [0,1] 契约、``dry_run`` 调用级
    覆盖、审计回执、``UNKNOWN_KEY``/``OUT_OF_BOUNDS`` 错误 kind —— 集成时套
    routes.py 的动作端点模板(见模块头注的注册行)。
    """

    def __init__(self, config: HidConfig | None = None, transport: SerialTransport | None = None) -> None:
        self.cfg = config or HidConfig()
        self._transport = transport or PySerialTransport(self.cfg.port, self.cfg.baud)
        self._dry_run = False
        self._lock: asyncio.Lock | None = None
        self._frames_sent = 0

    def set_dry_run(self, dry: bool) -> None:
        self._dry_run = dry

    def _get_lock(self) -> asyncio.Lock:
        # 惰性建锁(input.py 方言):控制器可能构造于无事件循环的加载期
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    def _norm_to_abs(self, x: float, y: float) -> tuple[int, int]:
        """归一化 → 绝对 0..32767(截断映射,中心 0.5 → 0x3FFF 手算可验)(W4-6)。"""
        if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
            raise PhysicalError(
                ErrorKind.OUT_OF_BOUNDS,
                f"coordinates out of [0,1]: ({x}, {y})",
            )
        return int(x * ABS_MAX), int(y * ABS_MAX)

    async def _send(self, frames: list[bytes], dry: bool) -> int:
        """帧序列 → 串口(线程池 + 实例锁串行化;帧间 settle)(W4-6)。"""
        if dry or not frames:
            return 0
        loop = asyncio.get_running_loop()
        async with self._get_lock():
            tr = self._transport
            await loop.run_in_executor(None, tr.open)
            for f in frames:
                await loop.run_in_executor(None, tr.write, f)
                await loop.run_in_executor(None, tr.flush)
                self._frames_sent += 1
                if self.cfg.key_interval_ms:
                    await asyncio.sleep(self.cfg.key_interval_ms / 1000)
        return len(frames)

    async def click(self, x: float, y: float, button: str = "left", dry_run: bool | None = None) -> dict:
        """点击:绝对移动+按下+释放(两帧;button 方言同 input.py)(W4-6)。"""
        dry = self._dry_run if dry_run is None else dry_run
        if button not in BUTTON_MAP:
            raise PhysicalError(
                ErrorKind.UNKNOWN_BUTTON,
                f"unknown mouse button: {button!r} (allowed: left/right/middle)",
            )
        ax, ay = self._norm_to_abs(x, y)
        btn = BUTTON_MAP[button]
        frames = [abs_mouse_frame(btn, ax, ay), abs_mouse_frame(0, ax, ay)]
        sent = await self._send(frames, dry)
        return {
            "abs": {"x": ax, "y": ay},
            "normalized": {"x": x, "y": y},
            "screen": {"width": self.cfg.target_width, "height": self.cfg.target_height},
            "frames_sent": sent,
        }

    async def move(self, x: float, y: float, dry_run: bool | None = None) -> dict:
        """绝对移动(单帧)—— 悬停/巡视动作(Z-1 探针的 HID 化)(W4-6)。"""
        dry = self._dry_run if dry_run is None else dry_run
        ax, ay = self._norm_to_abs(x, y)
        sent = await self._send([abs_mouse_frame(0, ax, ay)], dry)
        return {"abs": {"x": ax, "y": ay}, "frames_sent": sent}

    async def drag(self, start: dict, end: dict, dry_run: bool | None = None) -> dict:
        """拖拽:移动→按下→移动→释放(四帧;与 input.py 两阶段语义同构)(W4-6)。"""
        dry = self._dry_run if dry_run is None else dry_run
        try:
            sx, sy = float(start["x"]), float(start["y"])
            ex, ey = float(end["x"]), float(end["y"])
        except (KeyError, TypeError, ValueError) as e:
            raise PhysicalError(ErrorKind.INVALID_ARGS, f"drag start/end must be {{x,y}}: {e}") from e
        axs, ays = self._norm_to_abs(sx, sy)
        axe, aye = self._norm_to_abs(ex, ey)
        frames = [
            abs_mouse_frame(0, axs, ays),
            abs_mouse_frame(BTN_LEFT, axs, ays),
            abs_mouse_frame(BTN_LEFT, axe, aye),
            abs_mouse_frame(0, axe, aye),
        ]
        sent = await self._send(frames, dry)
        return {
            "start_abs": {"x": axs, "y": ays},
            "end_abs": {"x": axe, "y": aye},
            "frames_sent": sent,
        }

    async def scroll(self, direction: str, amount: int, dry_run: bool | None = None) -> dict:
        """滚轮:垂直走绝对帧 wheel 字节,水平走相对帧 dx(amount 方言同 input.py)(W4-6)。"""
        dry = self._dry_run if dry_run is None else dry_run
        try:
            frames = wheel_frames(direction, amount)
        except ValueError as e:
            raise PhysicalError(ErrorKind.INVALID_ARGS, str(e)) from e
        sent = await self._send(frames, dry)
        return {"scrolled": amount, "direction": direction, "frames_sent": sent}

    async def press_hotkey(self, keys: list[str], dry_run: bool | None = None) -> dict:
        """组合键(1-5 键;对称按下/释放;UNKNOWN_KEY 方言同 input.py)(W4-6)。"""
        dry = self._dry_run if dry_run is None else dry_run
        try:
            frames = hotkey_frames(keys)
        except ValueError as e:
            msg = str(e)
            if msg.startswith("unknown key:"):
                raise PhysicalError(ErrorKind.UNKNOWN_KEY, msg) from e
            raise PhysicalError(ErrorKind.INVALID_ARGS, msg) from e
        sent = await self._send(frames, dry)
        return {"pressed": list(keys), "frames_sent": sent}

    async def type_text(
        self,
        text: str,
        clear_first: bool = False,
        dry_run: bool | None = None,
        mode: Literal["auto", "keys", "paste"] = "auto",
    ) -> dict:
        """文本注入(W4-6)。

        策略(``mode``):
          - ``auto``(缺省):纯 ASCII 且 ≤ ``paste_threshold`` → 逐键;
            否则(长文本/含 CJK 等)→ **Ctrl+V 粘贴策略**(两帧)—— 前置契约:
            目标机剪贴板已由调用方备好(零 API 链路上本服务无法代写对端剪贴板)。
          - ``keys``:强制逐键;遇无 Usage ID 字符 ⇒ INVALID_ARGS 诚实失败。
          - ``paste``:强制粘贴组合键。
        ``clear_first``:先 Ctrl+A + Backspace(input.py 同语义;mac 为 Cmd+A)。
        """
        dry = self._dry_run if dry_run is None else dry_run
        non_ascii = any(char_report(ch) is None for ch in text)
        use_paste = mode == "paste" or (
            mode == "auto" and (len(text) > self.cfg.paste_threshold or non_ascii)
        )
        if not use_paste and non_ascii:
            bad = next(ch for ch in text if char_report(ch) is None)
            raise PhysicalError(
                ErrorKind.INVALID_ARGS,
                f"no HID usage for {bad!r}; use mode='paste' (clipboard strategy)",
            )

        clear_mod = MOD_LGUI if self.cfg.target_os == "mac" else MOD_LCTRL
        frames: list[bytes] = []
        if clear_first:
            frames += [kb_frame(clear_mod, [USAGE["a"]]), kb_release_frame(),
                       kb_frame(0, [USAGE["backspace"]]), kb_release_frame()]
        if use_paste:
            frames += paste_frames(self.cfg.target_os)
        else:
            try:
                frames += text_frames(text)
            except ValueError as e:
                raise PhysicalError(ErrorKind.INVALID_ARGS, str(e)) from e

        sent = await self._send(frames, dry)
        result: dict = {"typed_chars": len(text), "frames_sent": sent}
        if use_paste:
            result["pasted"] = True
            result["note"] = (
                "clipboard paste assumed: caller must preload target clipboard "
                f"({self.cfg.target_os}: {'Cmd' if self.cfg.target_os == 'mac' else 'Ctrl'}+V sent)"
            )
        return result

    async def read_ack(self) -> dict:
        """读设备回执帧(CH9329 成功回执 = CMD|0x80 + status 0x00)(W4-6)。"""
        loop = asyncio.get_running_loop()
        try:
            raw = await loop.run_in_executor(None, self._transport.read, 64)
            if not raw:
                return {"ack": None, "note": "no reply bytes (timeout)"}
            addr, cmd, data = parse_ch9329_frame(raw)
        except ValueError as e:
            raise PhysicalError(ErrorKind.INTERNAL_ERROR, f"bad device reply: {e}") from e
        return {"ack": {"addr": addr, "cmd": f"0x{cmd:02x}", "status": list(data)}}

    def device_info(self) -> dict:
        """设备信息(platform_info 方言;health 回执用)(W4-6)。"""
        return {
            "platform": sys.platform,
            "protocol": "ch9329",
            "transport": self.transport_info(),
            "target": {
                "width": self.cfg.target_width, "height": self.cfg.target_height,
                "os": self.cfg.target_os,
            },
            "frames_sent": self._frames_sent,
        }

    def transport_info(self) -> dict:
        """串口 transport 只读描述(公有面 —— 外层不得摸 ``_transport`` 私有属性,
        W6-R-A3 封装修复:server.py 曾直接 ``hid_ctrl._transport.describe()``/
        ``.close()`` 越权穿刺,现由控制器自持该信息)。"""
        return self._transport.describe()

    async def close(self) -> dict:
        """串口句柄优雅收口(公有面;线程池内执行,与 UvcController.close 同方言)。

        未写过帧 ⇒ 串口从未打开 ⇒ close 为无害 no-op(W6-R-A3:server.py 的
        lifespan 收口从私有属性穿刺改走本门面)。
        运行层方法:失败不抛错之外的最佳努力由调用方兜底 try/except。
        """
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._transport.close)
        return {"closed": True, "transport": self.transport_info()}


# ─── 自测入口(W4-6):python -m dsh_physical.hid --selftest ───


def _run_selftest() -> int:
    """无硬件自测:协议帧手算对照 → CRC 向量 → 解帧 → mock 串口往返。全过 exit 0。"""
    failures: list[str] = []

    def check(name: str, cond: bool) -> None:
        print(f"[{'PASS' if cond else 'FAIL'}] {name}")
        if not cond:
            failures.append(name)

    # ── 1. 校验和纯函数:手算对照 ──
    check("checksum_sum(00 02 06 01) == 0x09", checksum_sum(bytes([0x00, 0x02, 0x06, 0x01])) == 0x09)
    check(
        "checksum_sum wraps at 8bit (02 06 FF 7F FF 7F) == 0x04",
        checksum_sum(bytes([0x02, 0x06, 0xFF, 0x7F, 0xFF, 0x7F])) == 0x04,
    )

    # ── 2. 绝对鼠标帧:逐字节手算对照 ──
    check(
        "abs_mouse LEFT down @(0,0) exact bytes",
        abs_mouse_frame(BTN_LEFT, 0, 0) == bytes.fromhex("57ab000206" + "01" + "0000" + "0000" + "00" + "09"),
    )
    check(
        "abs_mouse center @(0x7FFF,0x7FFF) exact bytes",
        abs_mouse_frame(0, 0x7FFF, 0x7FFF) == bytes.fromhex("57ab000206" + "00" + "ff7f" + "ff7f" + "00" + "04"),
    )
    # 归一化中心 0.5 → 0x3FFF(截断映射手算:0.5*32767 = 16383.5 → 0x3FFF)
    check("norm 0.5 -> 0x3FFF mapping", int(0.5 * ABS_MAX) == 0x3FFF)
    check(
        "abs_mouse clamp: x=99999 -> 0x7FFF",
        abs_mouse_frame(0, 99_999, 0)[6:8] == b"\xff\x7f",
    )

    # ── 3. 键盘帧:Usage ID 与修饰键手算对照 ──
    check(
        "kb 'a' press exact bytes",
        kb_frame(0, [USAGE["a"]]) == bytes.fromhex("57ab00080a" + "00" + "00" + "04" + "00" * 7 + "16"),
    )
    check(
        "kb Shift+'A' exact bytes (SUM=0x18)",
        kb_frame(MOD_LSHIFT, [USAGE["a"]]) == bytes.fromhex("57ab00080a" + "02" + "00" + "04" + "00" * 7 + "18"),
    )
    check("char_report('H') == (0x02, 0x0B)", char_report("H") == (MOD_LSHIFT, 0x0B))
    check("char_report('!') == (0x02, 0x1E)", char_report("!") == (MOD_LSHIFT, 0x1E))
    check("char_report('i') == (0, 0x0C)", char_report("i") == (0, 0x0C))
    check("char_report('中') is None (paste signal)", char_report("中") is None)
    check(
        "kb release frame == all-zero report",
        kb_release_frame() == bytes.fromhex("57ab00080a" + "00" * 10 + "12"),
    )

    # ── 4. CRC-16/XMODEM:业界标准测试向量 + ESP32 变体帧 ──
    check("crc16_xmodem(b'123456789') == 0x31C3", crc16_xmodem(b"123456789") == 0x31C3)
    check("crc16_xmodem(b'') == 0x0000", crc16_xmodem(b"") == 0x0000)
    esp = esp32_frame(0x01, b"\x02\x06")
    check("esp32_frame passes esp32_check", esp32_check(esp))
    check(
        "esp32_frame trailer == CRC LE of body",
        esp[-2:] == struct.pack("<H", crc16_xmodem(esp[2:-2])),
    )
    corrupted = bytearray(esp)
    corrupted[4] ^= 0x01
    check("esp32_check rejects corrupted frame", not esp32_check(bytes(corrupted)))

    # ── 5. 解帧:往返 + 损坏检测 ──
    f = abs_mouse_frame(BTN_RIGHT, 0x1234, 0x567)
    addr, cmd, data = parse_ch9329_frame(f)
    check(
        "parse roundtrip abs mouse",
        addr == 0x00 and cmd == CMD_ABS_MOUSE
        and data[0] == BTN_RIGHT and struct.unpack("<H", data[1:3])[0] == 0x1234
        and struct.unpack("<H", data[3:5])[0] == 0x567 and data[5] == 0,
    )
    bad = bytearray(f)
    bad[6] ^= 0xFF  # 翻转一个数据字节
    try:
        parse_ch9329_frame(bytes(bad))
        check("parse rejects checksum corruption", False)
    except ValueError:
        check("parse rejects checksum corruption", True)
    try:
        parse_ch9329_frame(f[:-1])
        check("parse rejects truncation", False)
    except ValueError:
        check("parse rejects truncation", True)

    # ── 6. 滚轮帧:垂直合帧(±127/帧)+ 水平相对帧 ──
    wf = wheel_frames("down", 3)
    ok_wf = len(wf) == 1 and parse_ch9329_frame(wf[0])[1] == CMD_ABS_MOUSE and parse_ch9329_frame(wf[0])[2][5] == 0xFD
    check("wheel down 3 -> 1 abs frame wheel=-3 (0xFD)", ok_wf)
    check("wheel up 300 -> 3 frames (127+127+46)", [parse_ch9329_frame(x)[2][5] for x in wheel_frames("up", 300)] == [127, 127, 46])
    hf = wheel_frames("left", 5)
    check(
        "wheel left 5 -> 1 rel frame dx=-5",
        len(hf) == 1 and parse_ch9329_frame(hf[0])[1] == CMD_REL_MOUSE and parse_ch9329_frame(hf[0])[2][1] == -5 & 0xFF,
    )
    check(
        "rel_mouse_frame(0, 1, 0, 0) exact bytes (SUM=0x0A)",
        rel_mouse_frame(0, 1, 0, 0) == bytes.fromhex("57ab000405" + "00" + "01" + "00" + "00" + "00" + "0a"),
    )

    # ── 7. 组合键与粘贴策略帧 ──
    hk = hotkey_frames(["ctrl", "shift", "esc"])
    _, _, hd = parse_ch9329_frame(hk[0])
    check(
        "hotkey ctrl+shift+esc press report",
        hd[0] == (MOD_LCTRL | MOD_LSHIFT) and hd[2] == USAGE["esc"],
    )
    pf = paste_frames("win")
    _, _, pd = parse_ch9329_frame(pf[0])
    check("paste win -> Ctrl(0x01)+V(0x19)", pd[0] == MOD_LCTRL and pd[2] == 0x19)
    pm = paste_frames("mac")
    _, _, pmd = parse_ch9329_frame(pm[0])
    check("paste mac -> GUI(0x08)+V(0x19)", pmd[0] == MOD_LGUI and pmd[2] == 0x19)
    # Ctrl+V 帧全字节手算对照:SUM = 08+0A+01+19 = 0x2C
    check(
        "Ctrl+V press exact bytes (SUM=0x2C)",
        pf[0] == bytes.fromhex("57ab00080a" + "01" + "00" + "19" + "00" * 7 + "2c"),
    )
    tf = text_frames("Hi")
    check(
        "text_frames('Hi') == 4 frames (H shift+0x0B, i 0x0C)",
        len(tf) == 4
        and parse_ch9329_frame(tf[0])[2][0] == MOD_LSHIFT and parse_ch9329_frame(tf[0])[2][2] == 0x0B
        and parse_ch9329_frame(tf[2])[2][0] == 0 and parse_ch9329_frame(tf[2])[2][2] == 0x0C,
    )

    # ── 8. mock 串口:控制器全链路往返 ──
    async def _roundtrip() -> tuple[bool, bool, bool, bool, bool, bool, bool, bool, dict]:
        mock = MockSerialTransport()
        ctrl = HidController(HidConfig(key_interval_ms=0), transport=mock)
        # 中心点击:帧1 = 按下(0x3FFF,0x3FFF)
        await ctrl.click(0.5, 0.5)
        _, c1, d1 = parse_ch9329_frame(mock.written[0])
        ok_click = (
            c1 == CMD_ABS_MOUSE and d1[0] == BTN_LEFT
            and struct.unpack("<H", d1[1:3])[0] == 0x3FFF
            and struct.unpack("<H", d1[3:5])[0] == 0x3FFF
        )
        ok_click_pair = len(mock.written) == 2 and parse_ch9329_frame(mock.written[1])[2][0] == 0
        # 拖拽:4 帧
        n0 = len(mock.written)
        await ctrl.drag({"x": 0.1, "y": 0.1}, {"x": 0.9, "y": 0.9})
        ok_drag = len(mock.written) - n0 == 4
        # ASCII 短文本:逐键 4 帧('Hi')
        n0 = len(mock.written)
        r_text = await ctrl.type_text("Hi")
        ok_text = len(mock.written) - n0 == 4 and "pasted" not in r_text and r_text["typed_chars"] == 2
        # 长 CJK 文本:粘贴策略(恰 2 帧 Ctrl+V)
        n0 = len(mock.written)
        r_paste = await ctrl.type_text("零API设备面" * 20)
        ok_paste = len(mock.written) - n0 == 2 and r_paste.get("pasted") is True
        # dry_run:零写出
        n0 = len(mock.written)
        await ctrl.click(0.5, 0.5, dry_run=True)
        ok_dry = len(mock.written) == n0
        # 错误方言
        try:
            await ctrl.press_hotkey(["nope"])
            ok_err_key = False
        except PhysicalError as e:
            ok_err_key = e.kind is ErrorKind.UNKNOWN_KEY
        try:
            await ctrl.click(1.5, 0.5)
            ok_err_oob = False
        except PhysicalError as e:
            ok_err_oob = e.kind is ErrorKind.OUT_OF_BOUNDS
        return ok_click, ok_click_pair, ok_drag, ok_text, ok_paste, ok_dry, ok_err_key, ok_err_oob, ctrl.device_info()

    (ok_click, ok_click_pair, ok_drag, ok_text, ok_paste, ok_dry, ok_err_key, ok_err_oob, info) = asyncio.run(_roundtrip())
    check("mock click center -> (0x3FFF,0x3FFF) press frame", ok_click)
    check("mock click -> press+release pair", ok_click_pair)
    check("mock drag -> 4 frames", ok_drag)
    check("mock type_text('Hi') -> 4 key frames", ok_text)
    check("mock long CJK -> paste strategy (2 frames)", ok_paste)
    check("mock dry_run writes nothing", ok_dry)
    check("unknown key -> UNKNOWN_KEY envelope", ok_err_key)
    check("out-of-bounds -> OUT_OF_BOUNDS envelope", ok_err_oob)

    # ── 9. 罐头回执:read_ack 解析设备回帧 ──
    # CH9329 成功回执(手算):57 AB 00 82 01 00 SUM(0x00+0x82+0x01+0x00 = 0x83)
    async def _ack() -> dict:
        mock = MockSerialTransport(canned_reads=[bytes.fromhex("57ab00820100" + "83")])
        ctrl = HidController(HidConfig(), transport=mock)
        return await ctrl.read_ack()

    ack = asyncio.run(_ack())
    check(
        "read_ack parses canned success reply",
        ack.get("ack", {}).get("cmd") == "0x82" and ack.get("ack", {}).get("status") == [0x00],
    )

    # ── 10. 键盘帧防御:boot 6KRO 上限 + 修饰键入槽拒绝 ──
    try:
        kb_frame(0, [0x04] * 7)
        check("kb_frame rejects >6 keys", False)
    except ValueError:
        check("kb_frame rejects >6 keys", True)
    try:
        kb_frame(0, [0xE0])
        check("kb_frame rejects modifier in key slot", False)
    except ValueError:
        check("kb_frame rejects modifier in key slot", True)

    print(f"\nhid selftest: {'OK' if not failures else 'FAILED: ' + '; '.join(failures)}")
    return 0 if not failures else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(_run_selftest())
    if "--selftest-real" in sys.argv:
        # W9-4 真机实证探针入口:本模块逻辑零侵入,委托 real_probe.py
        # (COM 口枚举 + CH9329 帧经 pyserial loop:// 真序列化回读,证据落 JSON)。
        import pathlib as _pl

        _svc_root = _pl.Path(__file__).resolve().parent.parent
        if str(_svc_root) not in sys.path:
            sys.path.insert(0, str(_svc_root))
        from real_probe import run_debt_probe

        raise SystemExit(run_debt_probe("D-A2"))
    print("usage: python -m dsh_physical.hid --selftest | --selftest-real")
    raise SystemExit(2)
