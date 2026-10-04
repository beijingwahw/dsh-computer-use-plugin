"""CH9329 / ESP32 HID 协议帧构造离线单测(ΑΩ-R32)。

字节级执法:帧头/地址/命令/长度/数据/校验逐字节对照手算向量(与 hid.py
模块头注的协议规格一致)。全部纯函数,零 I/O —— 无串口/无硬件参与。

运行(仓库根):python -m unittest discover -s python_service/tests -p "test_*.py"
"""
import sys
from pathlib import Path

# ΑΩ-R32:discover 以本目录为 top-level,注入 python_service/(dsh_physical 所在目录)
_SVC_ROOT = str(Path(__file__).resolve().parents[1])
if _SVC_ROOT not in sys.path:
    sys.path.insert(0, _SVC_ROOT)

import struct  # noqa: E402
import unittest  # noqa: E402

from dsh_physical.hid import (  # noqa: E402
    BTN_LEFT,
    BTN_RIGHT,
    CMD_ABS_MOUSE,
    CMD_REL_MOUSE,
    MOD_LCTRL,
    MOD_LGUI,
    MOD_LSHIFT,
    USAGE,
    abs_mouse_frame,
    ch9329_frame,
    char_report,
    checksum_sum,
    crc16_xmodem,
    esp32_check,
    esp32_frame,
    hotkey_frames,
    kb_frame,
    kb_release_frame,
    parse_ch9329_frame,
    paste_frames,
    rel_mouse_frame,
    text_frames,
    wheel_frames,
)


class ChecksumAndCrcTests(unittest.TestCase):
    """校验纯函数:手算向量 + 业界标准 CRC 向量。"""

    def test_checksum_sum_known_vectors(self):
        # 手算:00 02 06 01 → 0x09;累加和溢出截 8bit → 0x04
        self.assertEqual(checksum_sum(bytes([0x00, 0x02, 0x06, 0x01])), 0x09)
        self.assertEqual(checksum_sum(bytes([0x02, 0x06, 0xFF, 0x7F, 0xFF, 0x7F])), 0x04)

    def test_crc16_xmodem_standard_vectors(self):
        # CRC-16/XMODEM 标准测试向量 b"123456789" → 0x31C3;空串 → 0x0000
        self.assertEqual(crc16_xmodem(b"123456789"), 0x31C3)
        self.assertEqual(crc16_xmodem(b""), 0x0000)


class FrameByteLevelTests(unittest.TestCase):
    """帧构造字节级:逐字节对照手算向量(CH9329 手册帧型)。"""

    def test_abs_mouse_frame_exact_bytes(self):
        # 左键按下 @(0,0):SUM = 00+02+06+01 = 09
        self.assertEqual(
            abs_mouse_frame(BTN_LEFT, 0, 0),
            bytes.fromhex("57ab000206" + "01" + "0000" + "0000" + "00" + "09"),
        )
        # 无键 @(0x7FFF,0x7FFF):SUM = 02+06+FF+7F+FF+7F = 0x304 → 截 8bit = 04
        self.assertEqual(
            abs_mouse_frame(0, 0x7FFF, 0x7FFF),
            bytes.fromhex("57ab000206" + "00" + "ff7f" + "ff7f" + "00" + "04"),
        )

    def test_abs_mouse_clamps_and_button_guard(self):
        # 越界钳制:超大正数 → 0x7FFF 小端 FF 7F;负数 → 0
        self.assertEqual(abs_mouse_frame(0, 99_999, -5)[6:8], b"\xff\x7f")
        self.assertEqual(abs_mouse_frame(0, -5, 0)[8:10], b"\x00\x00")
        # 键位位图域 0..7(左/右/中三位)
        with self.assertRaises(ValueError):
            abs_mouse_frame(0x08, 0, 0)

    def test_kb_frame_exact_bytes(self):
        # 按下 'a'(Usage 0x04):DATA 定长 10 字节,SUM = 08+0A+04 = 16
        self.assertEqual(
            kb_frame(0, [USAGE["a"]]),
            bytes.fromhex("57ab00080a" + "00" + "00" + "04" + "00" * 7 + "16"),
        )
        # Shift+'a':modifier=02 → SUM = 08+0A+02+04 = 18
        self.assertEqual(
            kb_frame(MOD_LSHIFT, [USAGE["a"]]),
            bytes.fromhex("57ab00080a" + "02" + "00" + "04" + "00" * 7 + "18"),
        )
        # 全键释放:全零报告,SUM = 08+0A = 12
        self.assertEqual(
            kb_release_frame(),
            bytes.fromhex("57ab00080a" + "00" * 10 + "12"),
        )

    def test_kb_frame_boot_protocol_guards(self):
        with self.assertRaises(ValueError):
            kb_frame(0, [0x04] * 7)  # >6 键(boot 协议 6KRO 上限)
        with self.assertRaises(ValueError):
            kb_frame(0, [0xE0])  # 修饰键 Usage 0xE0-0xE7 不得入键槽

    def test_ch9329_frame_length_guard(self):
        with self.assertRaises(ValueError):
            ch9329_frame(0x02, b"\x00" * 256)  # LEN 单字节域 0..255


class ParseRoundtripTests(unittest.TestCase):
    """解帧:往返 + 损坏检测(设备回执/mock 通道的解析根基)。"""

    def test_parse_roundtrip_abs_mouse(self):
        f = abs_mouse_frame(BTN_RIGHT, 0x1234, 0x567)
        addr, cmd, data = parse_ch9329_frame(f)
        self.assertEqual(addr, 0x00)
        self.assertEqual(cmd, CMD_ABS_MOUSE)
        self.assertEqual(data[0], BTN_RIGHT)
        self.assertEqual(struct.unpack("<H", data[1:3])[0], 0x1234)
        self.assertEqual(struct.unpack("<H", data[3:5])[0], 0x567)
        self.assertEqual(data[5], 0)  # wheel

    def test_parse_rejects_corruption(self):
        f = abs_mouse_frame(BTN_RIGHT, 0x1234, 0x567)
        # 数据位翻转 → 累加和失配
        bad = bytearray(f)
        bad[6] ^= 0xFF
        with self.assertRaises(ValueError):
            parse_ch9329_frame(bytes(bad))
        # 截断
        with self.assertRaises(ValueError):
            parse_ch9329_frame(f[:-1])
        # 坏帧头
        with self.assertRaises(ValueError):
            parse_ch9329_frame(b"\x00\x00" + f[2:])
        # 过短
        with self.assertRaises(ValueError):
            parse_ch9329_frame(b"\x57\xab\x00\x02")


class Esp32VariantTests(unittest.TestCase):
    """ESP32 自固件变体:CRC-16/XMODEM 帧尾的双字节校验链路。"""

    def test_esp32_frame_structure_and_check(self):
        esp = esp32_frame(0x01, b"\x02\x06")
        self.assertTrue(esp32_check(esp))
        self.assertEqual(esp[:2], b"\x55\xaa")
        self.assertEqual(esp[1], 0xAA)
        # 帧尾 = body(CMD+LEN_LE16+DATA)的 CRC 小端
        self.assertEqual(esp[-2:], struct.pack("<H", crc16_xmodem(esp[2:-2])))
        # LEN 为小端 16bit
        self.assertEqual(struct.unpack("<H", esp[3:5])[0], 2)

    def test_esp32_check_rejects_corruption(self):
        esp = esp32_frame(0x01, b"\x02\x06")
        corrupted = bytearray(esp)
        corrupted[4] ^= 0x01  # 翻转一个数据字节
        self.assertFalse(esp32_check(bytes(corrupted)))
        self.assertFalse(esp32_check(esp[:-1]))  # 截断
        self.assertFalse(esp32_check(b"\x57\xaa" + esp[2:]))  # 坏头


class KeyboardMappingTests(unittest.TestCase):
    """键位码表:Usage ID / 修饰键 / 上档符号 / 非 ASCII 边界。"""

    def test_char_report_shift_and_non_ascii(self):
        self.assertEqual(char_report("H"), (MOD_LSHIFT, 0x0B))  # shift + h
        self.assertEqual(char_report("!"), (MOD_LSHIFT, 0x1E))  # shift + '1'
        self.assertEqual(char_report("i"), (0, 0x0C))
        self.assertIsNone(char_report("中"))  # CJK 无 Usage ID → 粘贴策略信号

    def test_hotkey_and_paste_frames(self):
        hk = hotkey_frames(["ctrl", "shift", "esc"])
        _, _, hd = parse_ch9329_frame(hk[0])
        self.assertEqual(hd[0], MOD_LCTRL | MOD_LSHIFT)  # 修饰键入 modifier 字节
        self.assertEqual(hd[2], USAGE["esc"])
        self.assertEqual(hk[1], kb_release_frame())  # 对称释放收尾
        # Ctrl+V 全字节:SUM = 08+0A+01+19 = 0x2C
        self.assertEqual(
            paste_frames("win")[0],
            bytes.fromhex("57ab00080a" + "01" + "00" + "19" + "00" * 7 + "2c"),
        )
        # mac → Cmd(GUI 0x08)+V
        _, _, pmd = parse_ch9329_frame(paste_frames("mac")[0])
        self.assertEqual((pmd[0], pmd[2]), (MOD_LGUI, 0x19))

    def test_wheel_frames_split_and_direction(self):
        # 垂直 300 → 127+127+46 分帧(绝对帧 wheel 字节,正=向上)
        self.assertEqual(
            [parse_ch9329_frame(x)[2][5] for x in wheel_frames("up", 300)],
            [127, 127, 46],
        )
        # 垂直 down 3 → 单帧 wheel=-3(0xFD)
        wf = wheel_frames("down", 3)
        self.assertEqual(len(wf), 1)
        self.assertEqual(parse_ch9329_frame(wf[0])[2][5], 0xFD)
        # 水平走相对帧 dx(left 5 → dx=-5 有符号字节)
        hf = wheel_frames("left", 5)
        _, cmd, hd = parse_ch9329_frame(hf[0])
        self.assertEqual(cmd, CMD_REL_MOUSE)
        self.assertEqual(struct.unpack("<b", hd[1:2])[0], -5)
        # 相对帧字节级:rel(0,1,0,0) SUM = 04+05+01 = 0x0A
        self.assertEqual(
            rel_mouse_frame(0, 1, 0, 0),
            bytes.fromhex("57ab000405" + "00" + "01" + "00" + "00" + "00" + "0a"),
        )
        # 方言守卫
        with self.assertRaises(ValueError):
            wheel_frames("diagonal", 5)
        with self.assertRaises(ValueError):
            wheel_frames("up", 0)

    def test_text_frames_press_release_pairs(self):
        tf = text_frames("Hi")
        self.assertEqual(len(tf), 4)  # 每字符 = 按下 + 释放 两帧
        _, _, d0 = parse_ch9329_frame(tf[0])
        self.assertEqual((d0[0], d0[2]), (MOD_LSHIFT, 0x0B))  # 'H' = shift+h
        _, _, d2 = parse_ch9329_frame(tf[2])
        self.assertEqual((d2[0], d2[2]), (0, 0x0C))  # 'i'
        # 非 ASCII 出现即拒绝(调用方降级粘贴策略的信号)
        with self.assertRaises(ValueError):
            text_frames("héllo")


if __name__ == "__main__":
    unittest.main()
