"""截屏 —— shm 优先 → mmap-file → base64 降级链。

依赖说明：
  - macOS：``pyautogui.screenshot()``（基于 PyObjC ApplicationServices）
  - Windows：``pyautogui.screenshot()``（基于 DWM API）
  - Linux：``pyautogui.screenshot()``（基于 scrot / ImageMagick；需 X server）
    - 无 X 时降级到 Xvfb 虚拟屏（容器场景）
    - 完全无显示时 ``raise`` → 转为 ``SCREEN_CAPTURE_FAILED``
  - ΝΩ-51 可选 backend：``DSH_PHYSICAL_SHOT_BACKEND=dxgi`` 时 Windows 主屏
    优先走 DXGI Desktop Duplication（GPU 直取 + 脏区矩形，ctypes 零新依赖，
    见 ``dxgi_capture.py``）；缺席/失败诚实降级上方 GDI 路径并 ``note``
    申报。缺省 ``gdi`` —— 行为与此前逐字节一致（兼容铁律）。

输出格式：
  - ``PNG``（缺省）：无损，适合 OCR / VLM 分析；体积大
  - ``JPEG``：有损，适合网络传输；``quality`` 来自配置

裁剪窗（``region`` 参数）：
  - 归一化坐标 [0,1]×[0,1] 的左上角与宽高
  - 缺省 = 全屏
  - 纪元 Σ-5（多屏感知）：``display`` 参数选定显示器（索引，``/v1/displays``
    清单序）后，``region`` 的归一化基准 = **所选显示器的矩形**（而非主屏）；
    ``display=None``（缺省）= 主屏 = Σ-5 之前的行为（兼容铁律：逐字节不变）
"""
from __future__ import annotations

import asyncio
import io
import os
import platform
import sys
import threading
import time
from collections import deque
from typing import Callable, Literal

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .config import ScreenshotConfig
from .errors import ErrorKind, PhysicalError
from .executors import DEVICE_POOL, SCREEN_POOL, get as get_pool  # ΑΩ-R25 专属池
from .shm import ShmHandle, make_handle

# ΠΑΝ-81: DPI 像素域契约 —— 诊断面随本模块 re-export（canonical 在 dpi.py）。
from .dpi import ensure_process_dpi_awareness, pixel_domain_report  # noqa: F401

# ΠΑΝ-81: 进程启动（server/routes 装配即导入本模块）显式申请 per-monitor-v2
# —— 全链坐标域统一为物理像素（枚举 / ImageGrab / pyautogui.size / ui_tree
# 归一化分母同域；125% 缩放屏上 L2 坐标不再放大 1.25×）。幂等、绝不抛；
# 申请被宿主 manifest 拒绝时如实申报（pixel_domain_report）。详见 dpi.py。
_DPI_AWARENESS_STATE = ensure_process_dpi_awareness()

# W4-5 移动 Surface：外部帧源（android 设备）—— server 期注入；返回
# (帧, 降级说明|None)。
SurfaceFrameSource = Callable[[str], tuple[Image.Image, str | None]]

ImageFormat = Literal["png", "jpeg"]


# ─── 视觉指纹（服务端计算 —— Node 端无原生图像依赖的根基）───
#
# 语义与 Node 端 perceptualHash.ts 对齐：
#   dhash：9x8 灰度水平梯度 → 64bit（捕获前后对比 / 变化门控）
#   phash：32x32 灰度 DCT-II 低频 8x8（DC 排除 ⇒ 亮度不变）→ 64bit 第二指纹
# 指纹永远在「干净帧」（无叠加层）上计算 —— 叠加网格不得污染变化检测。


def compute_dhash(img: Image.Image) -> str:
    """dHash：9x8 灰度相邻列比较 → 64bit 十六进制。

    ΝΩ-35 numpy 向量化：``px[:, :-1] > px[:, 1:]`` 一趟比较 → 行主序
    (row*8+col) 位平面 → ``np.packbits(bitorder="little")``（首元素=LSB）
    + ``int.from_bytes(little)`` 还原整数 —— 与旧纯 Python 位循环逐位等值
    （uint8 整数比较无舍入；TS perceptualHash 已知值用例在 test_screen 钉死：
    平图全零 / 0xAA 行 / 0xD5 行主序 / 阶梯 0x24）。实测（perf_counter，
    本机）：位打包段 13.1µs → 9.6µs；200px 区域裁剪整函数 77µs → 70µs；
    1080p 端到端 2.90ms → 2.92ms（持平 —— 热点在 PIL 灰度化+resize 的
    2.93ms C 段，诚实记录）。uvc.py / scrcpyStream.py 与本函数对齐方言
    —— 结果位级不变是硬约束。
    """
    px = np.asarray(img.convert("L").resize((9, 8)), dtype=np.uint8)
    bits = (px[:, :-1] > px[:, 1:]).flatten()  # (8,8) 行主序，[row][col]
    packed = np.packbits(bits, bitorder="little")  # 首=LSB → byte_k = bits[8k:8k+8]
    return f"{int.from_bytes(packed.tobytes(), 'little'):016x}"


_DCT_CACHE: dict[int, np.ndarray] = {}


def _dct_matrix(n: int) -> np.ndarray:
    """正交归一 DCT-II 矩阵（C[k,n] = c_k·cos(π/n·(x+0.5)·k)）。"""
    if n not in _DCT_CACHE:
        x = np.arange(n)
        c = np.ones(n)
        c[0] = 1.0 / np.sqrt(2.0)
        m = c[:, None] * np.sqrt(2.0 / n) * np.cos(np.pi * np.outer(x, x + 0.5) / n)
        _DCT_CACHE[n] = m
    return _DCT_CACHE[n]


def compute_phash(img: Image.Image) -> str:
    """pHash：32x32 灰度二维 DCT → 左上 8x8（去 DC）中位阈值 → 64bit。

    ΝΩ-35：DCT 自 ΑΩ-R32 起已是 numpy 矩阵乘；残余的 64 次 Python 位循环
    改 packbits（bit i = flatten 序，``v > med`` 严格比较同律 —— 与 dhash
    同一小端打包方言）。评估结论：本函数热点本就在 resize（PIL C，1080p
    ~3ms），位循环仅 ~0.01ms 量级，实测整函数 3.21ms → 3.10ms —— 向量化
    为打包方言一致性而做，非性能必需。
    """
    g = np.asarray(img.convert("L").resize((32, 32)), dtype=np.float64)
    c32 = _dct_matrix(32)
    dct = c32 @ g @ c32.T
    low = dct[:8, :8].copy()
    low[0, 0] = 0.0  # DC 排除：亮度不变性（与 Node 端 Q-2 同律）
    med = float(np.median(low))
    bits = (low > med).flatten()  # bit i = 行主序 flatten 序（旧 enumerate 同律）
    packed = np.packbits(bits, bitorder="little")
    return f"{int.from_bytes(packed.tobytes(), 'little'):016x}"


def hamming_hex(a: str, b: str) -> int:
    try:
        return bin(int(a, 16) ^ int(b, 16)).count("1")
    except ValueError:
        return 64


# ─── SoM 叠加层绘制（PIL 实现 —— Node 端无 sharp 时的视觉辅助）───

_FONT_CACHE: dict[int, ImageFont.FreeTypeFont | None] = {}


def _try_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont | None:
    if size in _FONT_CACHE:
        return _FONT_CACHE[size]
    font = None
    candidates = (
        "arial.ttf", "segoeui.ttf", "DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    )
    for name in candidates:
        try:
            font = ImageFont.truetype(name, size)
            break
        except Exception:  # noqa: BLE001
            continue
    if font is None:
        try:
            font = ImageFont.load_default()
        except Exception:  # noqa: BLE001
            font = None
    _FONT_CACHE[size] = font
    return font


def _norm_to_px_rect(rect: dict, w: int, h: int) -> tuple[int, int, int, int]:
    return (
        max(0, int(round(float(rect.get("x", 0.0)) * w))),
        max(0, int(round(float(rect.get("y", 0.0)) * h))),
        max(1, int(round(float(rect.get("width", 0.0)) * w))),
        max(1, int(round(float(rect.get("height", 0.0)) * h))),
    )


def draw_overlay(img: Image.Image, overlay: dict) -> Image.Image:
    """在截屏上绘制 SoM 辅助层。

    overlay 契约（坐标均为「本图内」归一化 [0,1]；全屏坐标由调用方换算）：
      grid_divisions: int            网格分割数（蓝色细线）
      crosshair: {x, y}              归一化准星位置（绿色十字 + 圆）
      boxes: [{x,y,width,height,label}]  元素框（蓝色 + 标签）
      color_rgb: (r,g,b) 可选基色（缺省蓝 3B82F6）
    """
    w, h = img.size
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    base = overlay.get("color_rgb") or (59, 130, 246)

    # 钳制（overlay 是未校验的原始 dict）：网格数/倍率直接进循环上界 ——
    # 一个 10^9 的恶意/失控值会在共享线程池里画几十亿条线，物理动作
    # （同一 executor）被整段饿死。上限远高于正常用法（TS 端缺省 10）。
    try:
        divisions = min(max(int(overlay.get("grid_divisions") or 0), 0), 256)
    except (TypeError, ValueError):
        divisions = 0
    if divisions and divisions > 1:
        line_rgba = (*base, 110)
        for i in range(1, divisions):
            x = round(w * i / divisions)
            y = round(h * i / divisions)
            d.line([(x, 0), (x, h)], fill=line_rgba, width=1)
            d.line([(0, y), (w, y)], fill=line_rgba, width=1)

    # Y-1 中央凹网格：热点区内网格密度翻倍 —— 信息密集处给更多定位精度。
    # 线色加深一档（alpha 170）与基础网格形成视觉层级（图例由锚点声明）。
    hot_zones = overlay.get("hot_zones") or []
    if isinstance(hot_zones, list):
        fine_rgba = (*base, 170)
        for hz in hot_zones:
            if not isinstance(hz, dict):
                continue
            hx, hy, hw, hh = _norm_to_px_rect(hz, w, h)
            try:
                factor = min(max(int(overlay.get("foveate_factor") or 2), 1), 8)
            except (TypeError, ValueError):
                factor = 2
            fine = factor * max(divisions or 4, 4)
            for i in range(1, fine):
                fx = hx + round(hw * i / fine)
                fy = hy + round(hh * i / fine)
                d.line([(fx, hy), (fx, hy + hh)], fill=fine_rgba, width=1)
                d.line([(hx, fy), (hx + hw, fy)], fill=fine_rgba, width=1)
            d.rectangle([hx, hy, hx + hw, hy + hh], outline=fine_rgba, width=1)

    cross = overlay.get("crosshair")
    if isinstance(cross, dict):
        cx = min(max(float(cross.get("x", 0.5)), 0.0), 1.0) * w
        cy = min(max(float(cross.get("y", 0.5)), 0.0), 1.0) * h
        green = (34, 197, 94, 220)
        d.line([(0, cy), (w, cy)], fill=green, width=2)
        d.line([(cx, 0), (cx, h)], fill=green, width=2)
        r = max(6, int(min(w, h) * 0.008))
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=green, width=2)

    boxes = overlay.get("boxes") or []
    if isinstance(boxes, list) and boxes:
        label_size = max(11, int(h * 0.012))
        font = _try_font(label_size)
        box_rgba = (*base, 235)
        tag_bg = (*base, 255)
        for b in boxes:
            if not isinstance(b, dict):
                continue
            x, y, bw, bh = _norm_to_px_rect(b, w, h)
            d.rectangle([x, y, x + bw, y + bh], outline=box_rgba, width=2)
            label = str(b.get("label", "")).strip()
            if label and font is not None:
                text = label[:24]
                try:
                    tw = int(d.textlength(text, font=font))
                except Exception:  # noqa: BLE001
                    tw = len(text) * label_size // 2
                ty = y - label_size - 4
                if ty < 0:
                    ty = y + 2
                d.rectangle([x, ty, x + tw + 8, ty + label_size + 4], fill=tag_bg)
                d.text((x + 4, ty + 2), text, fill=(255, 255, 255, 255), font=font)

    out = img.convert("RGBA")
    out.alpha_composite(layer)
    return out.convert("RGB")


# ─── Y-1/Y-2 感知显著度引擎（Epoch Y：中央凹视觉的数学根基）───
#
# 理论：人类视网膜中央凹（fovea）以非均匀分辨率采样世界 —— 黄斑区密集、
# 外周稀疏。屏上信息的分布同样高度非均匀：工具栏/正文区是高熵密集区，
# 背景壁纸是大片均匀低熵区。等密度 SoM 网格把一半的定位精度预算浪费在
# 「什么都不发生在那里」的区域。
#
# 数学：块级梯度幅值的 Shannon 熵 H(B) = -Σ p_i·log2 p_i（p_i = 归一化
# 梯度直方图第 i 桶）。高熵块 = 视觉细节密集（控件/文字/边缘）⇒ 值得
# 高密度网格；低熵块 = 均匀区域 ⇒ 粗网格即可。热点阈值 = μ + σ（单尾
# 1σ 显著性），相邻热点块 4-邻接 BFS 合并为连续中央凹区。


def compute_salience(
    img: "Image.Image", grid: tuple[int, int] = (12, 8), bins: int = 16,
) -> dict:
    """块级梯度熵图 + 热点区合并。

    返回 {zones: [{x,y,width,height,entropy}...]（归一化，按熵降序）,
    blocks: [entropy...]（行优先网格）, stats: {mean, std, max}}。
    """
    import numpy as np

    g = np.asarray(img.convert("L").resize((grid[0] * 16, grid[1] * 16)), dtype=np.float64)
    gx = np.abs(np.diff(g, axis=1))[:-1, :]
    gy = np.abs(np.diff(g, axis=0))[:, :-1]
    mag = np.sqrt(gx ** 2 + gy ** 2)

    bh = mag.shape[0] // grid[1]
    bw = mag.shape[1] // grid[0]
    # ΝΩ-35：96 次 np.histogram 纯 Python 循环 → 单趟向量化。等值根基：
    # 旧代码每块 histogram 的 range=(0, mag.max()+1e-9) 用的是**全图** max
    # ⇒ 桶边界是全局的 —— 先一次性算出每像素桶索引（np.histogram 对均匀桶
    # 的定义即 linspace 边界、左闭右开、末桶闭合：searchsorted(edges,'right')-1
    # + 两端夹取同律），再以「桶索引 + 块偏移」的 bincount 一趟收全部 96 块
    # ×16 桶计数（整型等值，test_screen 等值用例对随机/平图/阶梯图钉死）。
    # 块切片边界 [:grid*bh, :grid*bw] 与旧循环的 (by+1)*bh 切片严格同界
    # （尾部余数行/列本就被旧循环忽略）。实测 1080p 8.2ms → 5.1ms（-38%；
    # 残余 3.8ms 是 PIL resize(192x128)+asarray 的 C 段，熵循环段
    # ~4ms → ~1.6ms，诚实记录）。
    n_blocks = grid[1] * grid[0]
    hi = float(mag.max()) + 1e-9
    edges = np.linspace(0.0, hi, bins + 1)
    idx = np.searchsorted(edges, mag, side="right").astype(np.int64) - 1
    np.clip(idx, 0, bins - 1, out=idx)  # v==0 → -1 夹回 0（首桶左闭）；v==hi 不可能（+1e-9 严格大）
    sub = idx[: grid[1] * bh, : grid[0] * bw]
    sub = sub.reshape(grid[1], bh, grid[0], bw).transpose(0, 2, 1, 3).reshape(-1)
    codes = sub + np.repeat(np.arange(n_blocks, dtype=np.int64) * bins, bh * bw)
    counts = np.bincount(codes, minlength=n_blocks * bins).reshape(n_blocks, bins)
    p = counts.astype(np.float64) + 1e-9
    p /= p.sum(axis=1, keepdims=True)
    entropies: list[float] = list(-(p * np.log2(p)).sum(axis=1))

    mean = float(np.mean(entropies))
    std = float(np.std(entropies))
    thr = mean + std

    # 热点块 → 4-邻接 BFS 合并
    hot = [e >= thr for e in entropies]
    seen = [False] * len(entropies)
    zones: list[dict] = []
    for start in range(len(entropies)):
        if not hot[start] or seen[start]:
            continue
        stack = [start]
        seen[start] = True
        cells = []
        while stack:
            cur = stack.pop()
            cells.append(cur)
            cy, cx = divmod(cur, grid[0])
            for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                if 0 <= ny < grid[1] and 0 <= nx < grid[0]:
                    idx = ny * grid[0] + nx
                    if hot[idx] and not seen[idx]:
                        seen[idx] = True
                        stack.append(idx)
        ys = [c // grid[0] for c in cells]
        xs = [c % grid[0] for c in cells]
        y0, y1 = min(ys), max(ys)
        x0, x1 = min(xs), max(xs)
        zones.append({
            "x": x0 / grid[0], "y": y0 / grid[1],
            "width": (x1 - x0 + 1) / grid[0],
            "height": (y1 - y0 + 1) / grid[1],
            "entropy": round(max(entropies[c] for c in cells), 3),
        })
    zones.sort(key=lambda z: z["entropy"], reverse=True)
    return {
        "zones": zones[:6],
        "blocks": [round(e, 3) for e in entropies],
        "stats": {"mean": round(mean, 3), "std": round(std, 3), "max": round(max(entropies), 3)},
    }


# ─── Σ-5 多屏感知：显示器枚举（/displays 端点与 display 截图参数的共享地基）───
#
# 坐标系契约：全屏虚拟坐标系（Windows 惯例 —— 主屏左上角为原点，副屏矩形
# 可为负坐标）。routes./displays 的清单与 _capture_image 的 display 裁剪必须
# 出自同一枚举函数 —— 同一枚举顺序 ⇒ 「索引 i」在两端指同一块物理屏。


def _enum_monitors_win32() -> list[dict]:
    """Win32 EnumDisplayMonitors → 显示器矩形清单（全屏虚拟坐标系）。

    纯同步函数：/displays 路由放线程池执行；``_capture_image`` 的 display
    裁剪本就运行在线程池内，直接调用（不经过事件循环）。

    修正（Σ-5 真机执法）：``ctypes.wintypes`` 并无 ``MONITORINFO`` —— 旧
    /displays 内联代码引用 ``wt.MONITORINFO()`` 在回调内抛 AttributeError，
    被 ctypes「Exception ignored」静默吞掉 ⇒ 枚举恒空 ⇒ /displays 恒降级
    主屏单条（多屏清单从未真正工作过）。手写 MONITORINFOW 结构体修复。
    """
    import ctypes
    import ctypes.wintypes as wt

    class _MonitorInfoW(ctypes.Structure):
        """MONITORINFOW（布局与 Win32 一致）。"""

        _fields_ = [
            ("cbSize", wt.DWORD),
            ("rcMonitor", wt.RECT),
            ("rcWork", wt.RECT),
            ("dwFlags", wt.DWORD),
        ]

    user32 = ctypes.windll.user32
    monitors: list[dict] = []
    MonitorEnumProc = ctypes.WINFUNCTYPE(
        ctypes.c_int, wt.HMONITOR, wt.HDC, ctypes.POINTER(wt.RECT), ctypes.c_void_p,
    )

    def _cb(hmon, _hdc, rect, _lparam):
        info = _MonitorInfoW()
        info.cbSize = ctypes.sizeof(_MonitorInfoW)
        if user32.GetMonitorInfoW(hmon, ctypes.byref(info)):
            r = info.rcMonitor
            monitors.append({
                "name": f"Monitor@{r.left},{r.top}",
                "x": int(r.left), "y": int(r.top),
                "width": int(r.right - r.left), "height": int(r.bottom - r.top),
                "primary": bool(info.dwFlags & 1),
            })
        return 1

    user32.EnumDisplayMonitors(None, None, MonitorEnumProc(_cb), 0)
    return monitors


async def list_displays(screen_ctrl: "ScreenCapture | None" = None) -> list[dict]:
    """显示器清单（全屏虚拟坐标系）—— routes./displays 的唯一事实源。

    Windows：``_enum_monitors_win32``；其余平台/枚举失败 ⇒ 诚实降级为
    主屏单条（尺寸经 ``screen_ctrl.get_screen_size()`` —— 享受测试合成图
    降级；``screen_ctrl`` 缺席时经 pyautogui.size() 同源读取）。
    """
    result: list[dict] = []
    if platform.system() == "Windows":
        loop = asyncio.get_running_loop()
        # ΑΩ-R25：显示器枚举（Win32 COM 回调）走 screen 池 —— 不与 adb/编码共池
        result = await loop.run_in_executor(get_pool(SCREEN_POOL), _enum_monitors_win32)
    if not result:
        if screen_ctrl is not None:
            size = await screen_ctrl.get_screen_size()
            w, h = int(size["width"]), int(size["height"])
        else:
            import pyautogui

            size = pyautogui.size()
            w, h = int(size.width), int(size.height)
        result = [{
            "name": "Primary", "x": 0, "y": 0,
            "width": w, "height": h,
            "primary": True,
        }]
    return result


def _display_capture_rect(display: int) -> tuple[tuple[int, int, int, int], tuple[int, int, int, int]]:
    """display 索引 → ``(显示器矩形, 虚拟桌面包围盒)``，均为枚举坐标系。

    ``PIL.ImageGrab.grab(all_screens=True)`` 的图原点是虚拟桌面包围盒的
    左上角（= 各显示器矩形的最小 x/y）。越界/非法索引 ⇒ ``INVALID_ARGS``
    （诚实失败信封）。

    DPI 缩放环境（真机执法战果）：EnumDisplayMonitors 可能报**逻辑**像素
    （1920x1080@125% 实测报 1536x864）而 ImageGrab 抓到**物理**像素 ——
    本函数同时返回包围盒，``_capture_image`` 按实际图像尺寸做比例映射对齐。

    ΠΑΝ-81 后：进程启动即显式申请 per-monitor(-v2) 感知（dpi.py）⇒ 枚举
    与抓图同域（unvirtualized 物理像素），上述逻辑/物理错配在契约下不再
    出现；比例映射保留为防御层 —— 宿主进程被外部钉死 unaware/system 档
    （申请被拒）时仍能对齐两域。当前域经 ``pixel_domain_report()`` 可观测。
    """
    monitors = _enum_monitors_win32()
    if display < 0 or display >= len(monitors):
        rng = f" (valid indices: 0..{len(monitors) - 1})" if monitors else ""
        raise PhysicalError(
            ErrorKind.INVALID_ARGS,
            f"invalid display index {display}: "
            f"{len(monitors)} monitor(s) enumerated{rng}",
        )
    m = monitors[display]
    vx0 = min(mn["x"] for mn in monitors)
    vy0 = min(mn["y"] for mn in monitors)
    vw = max(mn["x"] + mn["width"] for mn in monitors) - vx0
    vh = max(mn["y"] + mn["height"] for mn in monitors) - vy0
    return (m["x"], m["y"], m["width"], m["height"]), (vx0, vy0, vw, vh)


class ScreenCapture:
    """屏幕截图控制器。

    所有方法异步；运行层永不抛错（异常由 ``safe_call`` 转失败响应）。
    """

    MAX_CACHED_FRAMES = 8

    def __init__(
        self,
        config: ScreenshotConfig,
        surface_source: "SurfaceFrameSource | None" = None,
    ) -> None:
        self.cfg = config
        self._dry_run = False
        # W4-5 移动 Surface：android 帧源（server 期注入 AndroidController.grab_frame）。
        # 缺席时 android surface 请求 ⇒ 诚实失败（不静默降级主机屏 —— 那是坐标污染）。
        self._surface_source = surface_source
        # 帧环缓存（干净帧半分辨率 RGB）：frame_id → ndarray。物理规则统计 /
        # popup 几何传感 / frame_diff 全部在此计算 —— Node 端零图像解码依赖。
        self._frames: deque[tuple[int, np.ndarray, tuple[int, int]]] = deque()
        self._frame_seq = 0
        # ΝΩ-9：帧环跨线程无锁 —— capture（事件循环线程）append/popleft 与
        # frame_stats/frame_diff（SCREEN_POOL 线程）reversed 迭代并发，deque
        # 迭代中变异偶发 RuntimeError。O(1) 粒度锁：持锁只做入环/引用快照，
        # numpy 统计与图像编码在锁外跑。
        self._frames_lock = threading.Lock()

    def set_dry_run(self, dry: bool) -> None:
        self._dry_run = dry

    async def capture(
        self,
        format: ImageFormat = "png",
        quality: int | None = None,
        region: dict | None = None,
        overlay: dict | None = None,
        max_width: int | None = None,
        upscale: float | None = None,
        want_hashes: bool = False,
        want_region_hash: dict | None = None,
        gate: dict | None = None,
        keep_frame: bool = False,
        meta_only: bool = False,
        want_salience: bool = False,
        display: int | None = None,
        surface: str | None = None,
    ) -> tuple[ShmHandle | None, dict]:
        """截屏并写入共享内存通道。

        ``region`` 格式：``{ x: float, y: float, width: float, height: float }``
        全部归一化 [0,1]；缺省 = 全屏。

        扩展参数（D-1 工具层无原生依赖接线）：
          ``overlay``：SoM 叠加层规格（draw_overlay 契约；坐标为**全屏**归一化，
                       region 裁剪的坐标平移在本方法内完成）
          ``max_width``：编码前缩放到指定宽度（Token 预算）
          ``upscale``：叠加层绘制前整体放大倍数（zoom_inspect 的放大重绘）
          ``want_hashes``：返回干净帧 dhash/phash（服务端指纹）
          ``want_region_hash``：``{x, y, r}``（全屏归一化中心+半径）→ 区域 dhash
          ``gate``：``{dhash_ref, distance}`` 变化门控 —— 命中（距离 ≤ distance）
                    时跳过编码/叠加，响应携带 ``unchanged=true``
          ``keep_frame``：干净帧入环缓存（frame_stats/frame_diff 的引用锚）

        Σ-5 多屏感知（``display``）：显示器索引（``/v1/displays`` 清单序，0 起）；
        ``None`` = 主屏 = Σ-5 之前的行为（兼容铁律：响应逐字节不变）。选定后
        ``region`` / overlay 坐标的归一化基准 = **所选显示器的矩形**（裁剪发生在
        ``_capture_image`` 最上游，overlay/salience/指纹等下游自然继承）。
        非 Windows 平台请求 ``display`` ⇒ 诚实降级主屏 + ``note``（跨平台行为
        可预期）；``extras['display']`` = 实际使用的索引（仅 display 请求在场时
        附带，避免污染无参调用的响应字节）。

        W4-5 移动 Surface（``surface``）：display 索引的字符串泛化 ——
        ``"host:<i>"`` ≡ ``display=i``；``"android:<serial>"`` 路由到注入的
        android 帧源（scrcpy 优先、adb screencap 降级，见 android.py）。
        ``surface`` 与 ``display`` 并存时 surface 获胜（单一事实源）。
        ``region`` / overlay 的归一化基准 = **设备屏幕矩形**（[0,1]² 契约不破，
        与 Σ-5 的「基准 = 所选显示器矩形」同构）；帧进入同一管线 ⇒ 既有 dhash
        变化门控 / 帧环 / 叠加层全部复用。``extras['surface']`` = 回显（仅
        surface 请求在场时附带，兼容铁律）；帧源降级时 ``extras['note']`` 申报。

        返回 ``(handle, extras)``；extras = {dhash, phash, region_dhash,
        unchanged, frame_id, frame_count}。
        """
        if format not in ("png", "jpeg"):
            raise PhysicalError(
                ErrorKind.INVALID_ARGS,
                f"unsupported format: {format!r} (allowed: png/jpeg)",
            )

        loop = asyncio.get_running_loop()

        # W4-5：surface id 解析（畸形 ⇒ INVALID_ARGS 诚实信封；safe_call 兜底）
        android_serial: str | None = None
        display_eff: int | None = display
        if surface is not None:
            from .android import parse_surface_id  # 延迟导入：android 侧不反向依赖本模块

            kind, key = parse_surface_id(surface)
            if kind == "host":
                display_eff = int(key)
            else:
                android_serial = str(key)
                display_eff = None

        # Σ-5：非 Windows 请求 display ⇒ 诚实降级主屏并 note 如实申报
        # （不静默假装多屏，也不拒服务 —— 跨平台行为可预期）。
        display_used: int | None = display_eff
        degrade_note: str | None = None
        if display_eff is not None and platform.system() != "Windows":
            degrade_note = (
                f"display={display_eff} ignored: cross-screen capture is Windows-only; "
                f"degraded to primary capture"
            )
            display_used = None

        surface_note: str | None = None
        # ΝΩ-51：dxgi backend 记账容器（经 _capture_image 出参回填 —— 成功收
        # meta、失败收 degraded 原因；避免共享实例状态的跨线程串扰）
        dxgi_meta: dict = {}
        if android_serial is not None:
            # ΑΩ-R25：android 帧源是 adb/scrcpy 子进程（command_timeout 15s
            # 量级的长阻塞 I/O）⇒ device 池；绝不能与主机截图/编码共池 ——
            # 否则一台失联设备能把整个图像面拖住 15s（head-of-line blocking）。
            full, surface_note = await loop.run_in_executor(
                get_pool(DEVICE_POOL), self._grab_surface, android_serial,
            )
        else:
            # ΑΩ-R25：主机抓帧（ImageGrab/pyautogui/ddxgi，百 ms 级 CPU+GDI）⇒ screen 池
            full = await loop.run_in_executor(
                get_pool(SCREEN_POOL), self._capture_image, None, display_used, dxgi_meta,
            )
        # ΝΩ-51：dxgi 成功 ⇒ extras["dxgi"] meta 透出（脏区矩形供 frame_diff
        # 通道注记；默认 gdi 路径此键缺席 —— 响应字节零变化）。降级 ⇒ 并入
        # note（与 display/surface 语义 note 拼接共存，不互相覆盖）。
        if dxgi_meta.get("backend") == "dxgi":
            extras_note_dxgi: str | None = None
            dxgi_extras = dict(dxgi_meta)
        elif dxgi_meta.get("degraded"):
            extras_note_dxgi = str(dxgi_meta["degraded"])
            dxgi_extras = None
        else:
            extras_note_dxgi = None
            dxgi_extras = None
        # dxgi MVP = 主屏单输出：多显示器请求走 GDI（诚实申报，不静默）
        if (
            getattr(self.cfg, "backend", "gdi") == "dxgi"
            and display_used is not None
            and platform.system() == "Windows"
        ):
            mvp_note = ("dxgi backend is primary-output only (ΝΩ-51 MVP); "
                        "multi-display capture via gdi")
            extras_note_dxgi = (
                mvp_note if extras_note_dxgi is None else f"{extras_note_dxgi}; {mvp_note}"
            )

        extras: dict = {
            "dhash": None, "phash": None, "region_dhash": None,
            "unchanged": False, "frame_id": None, "frame_count": len(self._frames),
            "salience": None,
        }
        if dxgi_extras is not None:
            extras["dxgi"] = dxgi_extras
        if degrade_note is not None:
            extras["note"] = degrade_note
        # ΝΩ-51：dxgi 降级/MVP 边界 note —— 追加语义，与 display/surface 语义
        # note 共存不覆盖（degrade_note 与 surface_note 本互斥，追加对既有
        # 组合无行为变化）。
        if extras_note_dxgi is not None:
            extras["note"] = (
                f"{extras['note']}; {extras_note_dxgi}" if "note" in extras else extras_note_dxgi
            )
        if surface_note is not None:
            extras["note"] = (
                f"{extras['note']}; {surface_note}" if "note" in extras else surface_note
            )
        if surface is not None:
            extras["surface"] = surface
        if display is not None:
            extras["display"] = display_used

        if want_hashes or gate or want_region_hash:
            def _fingerprints() -> None:
                # ΝΩ-35（体检 T4）：灰度化+resize+位打包是 CPU 图像工作（1080p
                # 三指纹合计 ~3ms，stable 轮询 want_hashes 每帧都跑）—— 原先在
                # 事件循环同步计算 ⇒ SCREEN_POOL（与抓帧同池、顺序 await，无
                # 同池嵌套死锁面）。异常语义不变：_crop_region 的 PhysicalError
                # 经 await 原样上抛（safe_call 信封照旧兜底）。
                if want_hashes or gate:
                    extras["dhash"] = compute_dhash(full)
                if want_hashes:
                    extras["phash"] = compute_phash(full)
                if want_region_hash:
                    crop = self._crop_region(full, self._center_to_rect(want_region_hash))
                    extras["region_dhash"] = compute_dhash(crop)

            await loop.run_in_executor(get_pool(SCREEN_POOL), _fingerprints)

        # 变化门控：新鲜指纹与参考几乎相同 ⇒ 屏幕未变，跳过整条下游管线
        if gate and extras["dhash"]:
            ref = str(gate.get("dhash_ref") or "")
            dist = int(gate.get("distance") or 0)
            if ref and hamming_hex(extras["dhash"], ref) <= dist:
                extras["unchanged"] = True
                return None, extras

        if keep_frame:
            def _half_frame() -> np.ndarray:
                # ΝΩ-35（体检 T4）：1080p 半分辨率重采样 + ndarray 拷贝
                # （LANCZOS-free 的 bilinear 也要 ~10ms 量级）原在事件循环 ⇒
                # SCREEN_POOL。入环/清环与 extras 记账仍在循环线程持帧锁
                # （ΝΩ-9 锁不变量不动）。
                half = full.convert("RGB").resize(
                    (max(1, full.width // 2), max(1, full.height // 2)),
                )
                return np.asarray(half, dtype=np.uint8)

            half_arr = await loop.run_in_executor(get_pool(SCREEN_POOL), _half_frame)
            with self._frames_lock:  # ΝΩ-9：与 SCREEN_POOL 线程的 frame_* 读互斥
                self._frame_seq += 1
                self._frames.append(
                    (self._frame_seq, half_arr, (full.width, full.height))
                )
                while len(self._frames) > self.MAX_CACHED_FRAMES:
                    self._frames.popleft()
                extras["frame_id"] = self._frame_seq
                extras["frame_count"] = len(self._frames)

        # Y-1/Y-2：显著度图（干净帧上计算 —— 叠加网格不得污染熵估计）
        if want_salience or (overlay and overlay.get("auto_foveate")):
            sal = await loop.run_in_executor(get_pool(SCREEN_POOL), compute_salience, full)
            extras["salience"] = sal

        # 纯指纹模式（稳定轮询）：不编码不传图 —— 指纹与帧缓存已就绪
        if meta_only:
            return None, extras

        # 组装最终图：region 裁剪 → 放大 → 叠加层（坐标平移到裁剪域）→ 宽度预算
        def _compose() -> Image.Image:
            img = self._crop_region(full, region) if region else full
            if upscale and upscale > 1.0:
                img = img.resize(
                    (max(1, int(img.width * upscale)), max(1, int(img.height * upscale))),
                    Image.LANCZOS,
                )
            if overlay:
                ov = dict(overlay)
                # Y-1 中央凹网格：热点区内网格密度翻倍（salience 已在异步上下文算好）
                if ov.get("auto_foveate") and extras.get("salience"):
                    ov.setdefault("hot_zones", [
                        {"x": z["x"], "y": z["y"], "width": z["width"], "height": z["height"]}
                        for z in extras["salience"]["zones"]
                    ])
                # 全屏归一化坐标 → 当前图域：先映射回全屏像素域再除以当前图尺寸。
                # upscale 只改图尺寸不改归一化坐标 ⇒ 无需缩放坐标；但 region 裁剪
                # 会使归一化平移（x'=(x-rx)/rw）—— 对 crosshair 与 boxes 逐个换算。
                if region:
                    rx, ry, rw, rh = self._region_px(region, full.width, full.height)
                    def remap(norm: float, origin_px: float, span_px: float, out_size: int) -> float:
                        px = origin_px + norm * span_px
                        return min(max(px / out_size, 0.0), 1.0)
                    if isinstance(ov.get("crosshair"), dict):
                        ov["crosshair"] = {
                            "x": remap(ov["crosshair"].get("x", 0.5), rx, rw, img.width),
                            "y": remap(ov["crosshair"].get("y", 0.5), ry, rh, img.height),
                        }
                    if isinstance(ov.get("boxes"), list):
                        ov["boxes"] = [
                            {
                                "x": remap(b.get("x", 0.0), rx, rw, img.width),
                                "y": remap(b.get("y", 0.0), ry, rh, img.height),
                                "width": float(b.get("width", 0.0)) * rw / img.width,
                                "height": float(b.get("height", 0.0)) * rh / img.height,
                                "label": b.get("label"),
                            }
                            for b in ov["boxes"] if isinstance(b, dict)
                        ]
                img = draw_overlay(img, ov)
            if max_width and img.width > max_width:
                ratio = max_width / img.width
                img = img.resize((max_width, max(1, int(img.height * ratio))), Image.LANCZOS)
            return img

        # ΑΩ-R25：组装/编码是 CPU-bound 图像工作 ⇒ screen 池（与抓帧同池：
        # 顺序 await，worker 在每次提交间释放 —— 无同池嵌套死锁面）
        img = await loop.run_in_executor(get_pool(SCREEN_POOL), _compose)

        def _encode() -> tuple[bytes, int, int]:
            buf = io.BytesIO()
            if format == "jpeg":
                # O 纪元（#1 真机执法）：不得对 img 重赋值 —— 闭包内赋值会使 img
                # 整体变局部量，第 74 行读未赋值局部量 ⇒ UnboundLocalError
                # （jpeg+任意模式在一切平台必炸的潜伏 bug；改用别名 src）。
                src = img.convert("RGB") if img.mode in ("RGBA", "LA", "P") else img
                q = quality if quality is not None else self.cfg.jpeg_quality
                src.save(buf, format="JPEG", quality=q, optimize=True)
                return buf.getvalue(), src.width, src.height
            # ΝΩ-35：PNG optimize=True → False。量化（1080p 类真机截屏，
            # perf_counter ×10）：23.4ms → 10.2ms（-56%）；体积 8039B → 8638B
            # （+7%，绝对量 <1KB —— shm 通道走本地 mmap，带宽不敏感）。最坏
            # 不可压缩内容（纯噪声）179→205ms（+15%，zlib 主导，罕见工况，
            # 诚实记录）。thumbnail 路径（max_width 缩放后）同改：4.8→1.8ms。
            img.save(buf, format="PNG", optimize=False)
            return buf.getvalue(), img.width, img.height

        try:
            image_bytes, width, height = await loop.run_in_executor(
                get_pool(SCREEN_POOL), _encode,
            )
        except Exception as e:  # noqa: BLE001
            raise PhysicalError(
                ErrorKind.SCREEN_CAPTURE_FAILED,
                f"image encode failed: {e}",
            ) from e

        # 写入共享内存通道
        # ΝΩ-35（体检 T4）：make_handle 是 MB 级 mmap memcpy（1080p PNG
        # 1-6MB，~2-8ms/MB）+ mmap-file 落盘 —— 原在事件循环 ⇒ SCREEN_POOL
        # （shm 注册表自带 _quota_lock/uuid 命名，多 worker 并发安全）。
        # PhysicalError 语义不变：经 await 原样上抛。
        def _store() -> ShmHandle:
            return make_handle(
                image_bytes,
                width,
                height,
                format=format.upper(),
                config=self.cfg,
            )

        handle = await loop.run_in_executor(get_pool(SCREEN_POOL), _store)
        return handle, extras

    async def capture_png_bytes(self, region: dict | None = None) -> tuple[bytes, int, int]:
        """截屏为 PNG 字节（J 纪元新增 —— 供 get_ui_tree 复用同一截屏路径）。

        旧实现里 get_ui_tree 内联了一份独立截屏代码：不走本类 ⇒ 不享受
        ``DSH_PHYSICAL_TEST_SCREEN`` 合成图降级，且异常被静默 ``pass`` 吞掉。

        ΝΩ-51：backend=dxgi 时同样走 DXGI 分流（同 ``capture``）；本路径无
        extras 面，dxgi meta（脏区）与降级 note 在此丢弃 —— 调用方只消费
        图像字节，诚实降级本身仍生效（失败自动回 GDI）。
        """
        loop = asyncio.get_running_loop()
        # ΑΩ-R25：抓帧 + 编码均 CPU 图像工作 ⇒ screen 专属池
        img = await loop.run_in_executor(get_pool(SCREEN_POOL), self._capture_image, region)

        def _encode() -> tuple[bytes, int, int]:
            buf = io.BytesIO()
            # ΝΩ-35：同 capture._encode 的 PNG optimize=False 决策（数字见彼处
            # 注释）；本路径字节供 ui_tree L2 OCR 解码 —— 延迟敏感、体积无关。
            img.save(buf, format="PNG", optimize=False)
            return buf.getvalue(), img.width, img.height

        try:
            return await loop.run_in_executor(get_pool(SCREEN_POOL), _encode)
        except Exception as e:  # noqa: BLE001
            raise PhysicalError(
                ErrorKind.SCREEN_CAPTURE_FAILED,
                f"image encode failed: {e}",
            ) from e

    def _grab_surface(self, serial: str) -> tuple[Image.Image, str | None]:
        """W4-5：android 设备帧（线程池内执行）—— ``(帧, 降级说明)``。

        帧源未接线（单元测试直构 ScreenCapture / 旧装配路径）⇒ 诚实失败：
        绝不静默降级到主机屏 —— 那会让 [0,1]² 的基准矩形从设备屏漂移成
        主机屏，坐标契约整体污染。
        """
        if self._surface_source is None:
            raise PhysicalError(
                ErrorKind.SCREEN_CAPTURE_FAILED,
                f"android surface {serial!r} requested but no frame source wired "
                "(AndroidController not injected)",
            )
        return self._surface_source(serial)

    def _grab_dxgi_frame(self) -> tuple[Image.Image | None, str | None, dict | None]:
        """ΝΩ-51：DXGI DDA 抓帧（SCREEN_POOL 线程内执行，锁由 grabber 持有）。

        返回 ``(帧, None, meta)`` 或 ``(None, 降级原因, None)``。绝不抛 ——
        缺席/失败一律转诚实降级说明（运行层铁律），由 ``_capture_image`` 落
        ``dxgi_meta['degraded']`` ⇒ ``capture`` 的 ``note``。meta 仅
        ``capture`` 透出（``capture_png_bytes`` 无 extras 面，丢弃 —— 该路径
        只消费图像本体）。
        """
        try:
            from .dxgi_capture import get_grabber
        except Exception as e:  # noqa: BLE001 —— 模块缺席（理论不可达）也降级
            return None, f"dxgi backend unavailable (import: {type(e).__name__}: {e}); degraded to gdi", None
        try:
            img, meta = get_grabber().grab(
                max(0, int(getattr(self.cfg, "dxgi_acquire_timeout_ms", 0)))
            )
        except PhysicalError as e:
            return None, f"{e.detail}; degraded to gdi", None
        except Exception as e:  # noqa: BLE001 —— 兜底铁律：运行层绝不裸抛
            return None, f"dxgi capture failed ({type(e).__name__}: {e}); degraded to gdi", None
        return img, None, meta

    def _capture_image(
        self,
        region: dict | None,
        display: int | None = None,
        dxgi_meta: dict | None = None,
    ) -> Image.Image:
        """同步截屏（线程池内执行）：真实截屏 → 测试降级 → 裁剪。

        ΝΩ-51 backend 分流（``cfg.backend=='dxgi'`` 且显式配置开启）：
        Windows 在场且 ``display`` 未指定（MVP 主屏单输出）时优先走 DXGI
        Desktop Duplication（``dxgi_capture.get_grabber``）；任何失败/缺席
        （DLL、无显示器会话、权限、旋转屏）⇒ **诚实降级**下方既有 GDI 路径，
        原因写入 ``dxgi_meta['degraded']``（``capture`` 转 ``note``）。成功则
        ``dxgi_meta`` 收到 dxgi meta（脏区矩形/fresh —— frame_diff 通道注记
        面）。``region`` 裁剪两路同在后置 —— 下游管线（指纹/gate/SOM/编码）
        方言不变。缺省 backend=gdi 时本分支零触达（兼容铁律：逐字节不变）。

        Σ-5 多屏感知：``display`` = 显示器索引（``list_displays`` 清单序，0 起）。
        非 None 且 Windows 在场时：``PIL.ImageGrab.grab(all_screens=True)`` 抓
        全屏虚拟桌面 → 按该显示器矩形裁剪（越界/非法索引 ⇒ INVALID_ARGS 失败
        信封）。裁剪发生在最上游 —— 后续 region 裁剪 / overlay / salience /
        指纹消费的「全图」即该显示器：

        坐标系语义：
          - ``display=None``（缺省）：``pyautogui.screenshot()`` 主屏 ——
            与 Σ-5 之前逐字节一致（兼容铁律）；
          - ``display=i``：``region`` 归一化 [0,1]² 的基准矩形 = **显示器 i**
            （而非主屏）—— overlay 全屏归一化坐标同理。
        """
        if (
            getattr(self.cfg, "backend", "gdi") == "dxgi"
            and display is None
            and platform.system() == "Windows"
        ):
            img, degraded, dmeta = self._grab_dxgi_frame()
            if img is not None:
                if dxgi_meta is not None and dmeta:
                    dxgi_meta.update(dmeta)
                if region:
                    img = self._crop_region(img, region)
                return img
            if dxgi_meta is not None and degraded:
                dxgi_meta["degraded"] = degraded
        if display is not None and platform.system() == "Windows":
            (mx, my, mw, mh), (vx0, vy0, vw, vh) = _display_capture_rect(display)
            try:
                from PIL import ImageGrab

                virtual = ImageGrab.grab(all_screens=True)
            except Exception as e:  # noqa: BLE001
                # 测试降级：DSH_PHYSICAL_TEST_SCREEN=1 时返回合成图（无显示环境集成测试用）
                if os.environ.get("DSH_PHYSICAL_TEST_SCREEN") == "1":
                    img = self._synthetic_test_image()
                else:
                    raise PhysicalError(
                        ErrorKind.SCREEN_CAPTURE_FAILED,
                        f"ImageGrab.grab(all_screens=True) failed for display {display}: {e}",
                    ) from e
            else:
                # 枚举域 → 抓图像素域：包围盒比例映射（DPI 缩放下枚举报逻辑像素、
                # ImageGrab 抓物理像素 —— 真机 1920x1080@125% 实测 1536x864 枚举值）。
                # ΠΑΝ-81：进程感知契约下两域恒同 ⇒ sx=sy=1；映射保留为防御层
                # （宿主感知被外部钉死 unaware/system 档时仍对齐）。
                # 同 DPI 环境 sx=sy=1（整数直裁）；边界夹取防微溢出。
                sx = (virtual.width / vw) if vw > 0 else 1.0
                sy = (virtual.height / vh) if vh > 0 else 1.0
                x0 = max(0, int(round((mx - vx0) * sx)))
                y0 = max(0, int(round((my - vy0) * sy)))
                x1 = min(virtual.width, int(round((mx + mw - vx0) * sx)))
                y1 = min(virtual.height, int(round((my + mh - vy0) * sy)))
                if x1 - x0 < 1 or y1 - y0 < 1:
                    raise PhysicalError(
                        ErrorKind.SCREEN_CAPTURE_FAILED,
                        f"display {display} rect degenerate after mapping: "
                        f"({x0},{y0})-({x1},{y1}) in {virtual.width}x{virtual.height}",
                    )
                img = virtual.crop((x0, y0, x1, y1))
        else:
            try:
                import pyautogui

                img = pyautogui.screenshot()
            except Exception as e:  # noqa: BLE001
                # 测试降级：DSH_PHYSICAL_TEST_SCREEN=1 时返回合成图（无显示环境集成测试用）
                if os.environ.get("DSH_PHYSICAL_TEST_SCREEN") == "1":
                    img = self._synthetic_test_image()
                else:
                    raise PhysicalError(
                        ErrorKind.SCREEN_CAPTURE_FAILED,
                        f"pyautogui.screenshot failed: {e}",
                    ) from e

        if region:
            img = self._crop_region(img, region)
        return img

    def _crop_region(self, img: Image.Image, region: dict) -> Image.Image:
        """裁剪归一化 region → 像素坐标 box。

        归一化基准 = ``img`` 的矩形：display=None 时即主屏；display=i 时即
        显示器 i（``_capture_image`` 已在最上游裁剪 ⇒ 本函数无需感知多屏）。
        """
        try:
            x = float(region["x"])
            y = float(region["y"])
            w = float(region["width"])
            h = float(region["height"])
        except (KeyError, TypeError, ValueError) as e:
            raise PhysicalError(
                ErrorKind.INVALID_ARGS,
                f"region must be {{x,y,width,height}}: {e}",
            ) from e

        for name, v in (("x", x), ("y", y), ("width", w), ("height", h)):
            if not (0.0 <= v <= 1.0):
                raise PhysicalError(
                    ErrorKind.OUT_OF_BOUNDS,
                    f"region.{name} out of [0,1]: {v}",
                )
        if x + w > 1.0 + 1e-6 or y + h > 1.0 + 1e-6:
            raise PhysicalError(
                ErrorKind.OUT_OF_BOUNDS,
                f"region extends beyond screen: x+w={x + w}, y+h={y + h}",
            )

        iw, ih = img.size
        box = (
            int(round(x * iw)),
            int(round(y * ih)),
            int(round((x + w) * iw)),
            int(round((y + h) * ih)),
        )
        # box 宽高至少 1px
        if box[2] - box[0] < 1 or box[3] - box[1] < 1:
            raise PhysicalError(
                ErrorKind.INVALID_ARGS,
                f"region too small after pixel conversion: {box}",
            )
        return img.crop(box)

    async def get_screen_size(self) -> dict:
        """获取屏幕尺寸（主屏物理像素）。

        ΠΑΝ-81：进程感知契约下 ``pyautogui.size()`` 与 ImageGrab / 枚举
        同为物理像素域 —— 本读数同时是 ui_tree L1/L2 归一化分母（经 routes
        透传给 get_ui_tree），物理化后 L2「物理 bbox ÷ 分母」不再被逻辑
        像素放大 1.25×（C2-5 H-1 的树域病灶即在此处收口）。当前域经
        ``pixel_domain_report()`` 可观测。
        """
        try:
            import pyautogui

            # ΑΩ-R25：尺寸读取（快）走 screen 池 —— 不排在 adb/编码队尾
            size = await asyncio.get_running_loop().run_in_executor(
                get_pool(SCREEN_POOL), lambda: pyautogui.size()
            )
            return {"width": int(size.width), "height": int(size.height)}
        except Exception as e:  # noqa: BLE001
            if os.environ.get("DSH_PHYSICAL_TEST_SCREEN") == "1":
                return {"width": 128, "height": 128}
            raise PhysicalError(
                ErrorKind.SCREEN_CAPTURE_FAILED,
                f"get_screen_size failed: {e}",
            ) from e

    def _synthetic_test_image(self) -> Image.Image:
        """测试降级图：128x128 RGB，左上 64x64 红块、右下 64x64 蓝块、其余黑。

        仅当 DSH_PHYSICAL_TEST_SCREEN=1 且 pyautogui 不可用时启用；
        用于无 X server 环境下的集成测试（不进入生产路径）。
        """
        import numpy as np

        arr = np.zeros((128, 128, 3), dtype=np.uint8)
        arr[0:64, 0:64] = [255, 0, 0]   # 左上红块
        arr[64:128, 64:128] = [0, 0, 255]  # 右下蓝块
        return Image.fromarray(arr, mode="RGB")

    # ─── 帧环缓存访问：物理规则统计 / popup 几何传感 / frame_diff ───

    def _region_px(self, region: dict, full_w: int, full_h: int) -> tuple[int, int, int, int]:
        """归一化 region → 全屏像素 (x, y, w, h)（越界夹取）。"""
        x = max(0.0, min(1.0, float(region.get("x", 0.0))))
        y = max(0.0, min(1.0, float(region.get("y", 0.0))))
        w = max(1e-6, min(1.0, float(region.get("width", 1.0))))
        h = max(1e-6, min(1.0, float(region.get("height", 1.0))))
        px = int(round(x * full_w))
        py = int(round(y * full_h))
        pw = max(1, int(round(w * full_w)))
        ph = max(1, int(round(h * full_h)))
        pw = min(pw, full_w - px)
        ph = min(ph, full_h - py)
        return px, py, pw, ph

    def _center_to_rect(self, spec: dict) -> dict:
        """{x, y, r}（归一化中心+半径）→ 归一化 region（双侧夹取）。"""
        cx = max(0.0, min(1.0, float(spec.get("x", 0.5))))
        cy = max(0.0, min(1.0, float(spec.get("y", 0.5))))
        r = max(0.01, min(0.5, float(spec.get("r", 0.1))))
        # Y6 真机战果：旧实现只夹原点（max(0,·)）、宽高恒 2r —— 靠近屏幕边缘的
        # 动作（任务栏 y≈0.98、右缘 x≈0.95）得到 x+w>1 / y+h>1 的 region，
        # _crop_region 判 OUT_OF_BOUNDS，把已成功执行的点击整体误报 FAILED。
        # 双侧夹取：终点也夹到 1.0，宽高改为夹取后差值。
        x0, x1 = max(0.0, cx - r), min(1.0, cx + r)
        y0, y1 = max(0.0, cy - r), min(1.0, cy + r)
        return {
            "x": x0, "y": y0,
            "width": max(0.01, x1 - x0), "height": max(0.01, y1 - y0),
        }

    def _get_frame(self, frame_id: int) -> tuple[np.ndarray, tuple[int, int]]:
        """按 id 取缓存帧（半分辨率 RGB + 原始全屏尺寸）。"""
        # ΝΩ-9：持锁迭代（入环/清环在事件循环线程并发）—— deque 迭代中变异
        # 会抛 RuntimeError；命中即返回（with 块退出自动放锁），numpy 统计在锁外。
        with self._frames_lock:
            for fid, arr, full_size in reversed(self._frames):
                if fid == frame_id:
                    return arr, full_size
            kept = [f[0] for f in self._frames]
        raise PhysicalError(
            ErrorKind.INVALID_ARGS,
            f"frame {frame_id} not in cache (kept: {kept})",
        )

    def frame_stats(self, frame_id: int, regions: list[dict]) -> list[dict]:
        """缓存帧区域统计（亮度均值 + 标准差）—— intent.ts 物理规则的服务端躯体。

        regions：归一化 {x,y,width,height} 列表；空列表 = 全图统计。
        坐标在半分辨率帧上换算 —— 均值/方差对 2x 降采样不敏感（分布不变）。
        """
        arr, (full_w, full_h) = self._get_frame(frame_id)
        h, w = arr.shape[:2]
        gray = arr.astype(np.float64).mean(axis=2)
        out: list[dict] = []
        if not regions:
            out.append({"mean": float(gray.mean()), "stdev": float(gray.std())})
            return out
        for r in regions:
            if not isinstance(r, dict):
                out.append({"mean": None, "stdev": None})
                continue
            px, py, pw, ph = self._region_px(r, full_w, full_h)
            # 半分辨率帧的像素坐标
            sx, sy = int(round(px * w / full_w)), int(round(py * h / full_h))
            sw = max(1, int(round(pw * w / full_w)))
            sh = max(1, int(round(ph * h / full_h)))
            sx = min(max(0, sx), w - 1)
            sy = min(max(0, sy), h - 1)
            sw = min(sw, w - sx)
            sh = min(sh, h - sy)
            block = gray[sy:sy + sh, sx:sx + sw]
            out.append({"mean": float(block.mean()), "stdev": float(block.std())})
        return out

    def frame_rowmeans(self, frame_id: int, grid: int = 64) -> list[float]:
        """缓存帧行亮度序列（内容平移检测 —— scroll 物理规则的躯体）。"""
        arr, _ = self._get_frame(frame_id)
        g = max(4, min(256, int(grid)))
        small = np.asarray(
            Image.fromarray(arr).convert("L").resize((g, g))
        ).astype(np.float64)
        return [float(row.mean()) for row in small]

    def frame_diff(
        self, frame_a: int, frame_b: int, block: int = 24, annotate: bool = False,
    ) -> dict:
        """两缓存帧的分块差分 → 变化区域清单（归一化全屏坐标）+ 可选红框标注图。

        annotate=True 时返回 JPEG 字节（在 frame_b 上画红框）；坐标基于半分辨率
        缓存帧 —— 区域粒度即块粒度（block 像素，半分辨率域）。
        """
        arr_a, size_a = self._get_frame(frame_a)
        arr_b, size_b = self._get_frame(frame_b)
        if arr_a.shape != arr_b.shape:
            raise PhysicalError(
                ErrorKind.INVALID_ARGS,
                f"frame shape mismatch: {arr_a.shape} vs {arr_b.shape} "
                "(resize/scale changed between captures)",
            )
        h, w = arr_a.shape[:2]
        ga = arr_a.astype(np.float64).mean(axis=2)
        gb = arr_b.astype(np.float64).mean(axis=2)
        bs = max(8, int(block))

        # 逐块平均绝对差 → 阈值 → 连通域合并（4-邻接）
        ncols, nrows = w // bs, h // bs
        if ncols < 1 or nrows < 1:
            bs = max(4, min(w, h) // 4)
            ncols, nrows = w // bs, h // bs
        diff = np.zeros((nrows, ncols), dtype=np.float64)
        for by in range(nrows):
            for bx in range(ncols):
                pa = ga[by*bs:(by+1)*bs, bx*bs:(bx+1)*bs]
                pb = gb[by*bs:(by+1)*bs, bx*bs:(bx+1)*bs]
                diff[by, bx] = float(np.abs(pa - pb).mean())

        thr = max(6.0, float(diff.std()) * 2.0)
        mask = diff > thr

        # 连通域（简单 BFS —— 块级矩阵很小）
        seen = np.zeros_like(mask, dtype=bool)
        regions: list[dict] = []
        for sy in range(nrows):
            for sx in range(ncols):
                if not mask[sy, sx] or seen[sy, sx]:
                    continue
                stack = [(sy, sx)]
                seen[sy, sx] = True
                min_x = max_x = sx
                min_y = max_y = sy
                while stack:
                    cy, cx = stack.pop()
                    min_x, max_x = min(min_x, cx), max(max_x, cx)
                    min_y, max_y = min(min_y, cy), max(max_y, cy)
                    for ny, nx in ((cy-1, cx), (cy+1, cx), (cy, cx-1), (cy, cx+1)):
                        if 0 <= ny < nrows and 0 <= nx < ncols and mask[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            stack.append((ny, nx))
                regions.append({
                    "x": min_x * bs / w, "y": min_y * bs / h,
                    "width": (max_x - min_x + 1) * bs / w,
                    "height": (max_y - min_y + 1) * bs / h,
                })

        regions.sort(
            key=lambda r: r["width"] * r["height"], reverse=True,
        )
        annotated_jpeg: bytes | None = None
        if annotate and regions:
            img = Image.fromarray(arr_b).convert("RGB")
            d = ImageDraw.Draw(img)
            for r in regions[:24]:
                x = int(r["x"] * w)
                y = int(r["y"] * h)
                d.rectangle(
                    [x, y, x + int(r["width"] * w), y + int(r["height"] * h)],
                    outline=(239, 68, 68), width=3,
                )
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=80)
            annotated_jpeg = buf.getvalue()

        return {
            "frame_a": frame_a, "frame_b": frame_b,
            "changed_regions": regions[:24],
            "region_count": len(regions),
            "block_threshold": thr,
            "annotated_jpeg": annotated_jpeg,
        }

    def frame_ids(self) -> list[int]:
        with self._frames_lock:  # ΝΩ-9：帧环跨线程 —— 快照式读
            return [f[0] for f in self._frames]


# ─── ΝΩ-51 自测入口：python -m dsh_physical.screen --selftest ───
# 覆盖：视觉指纹已知值（不变式哨）+ backend 分流三态（默认 gdi 零变化 /
# dxgi 成功 meta 透出 / dxgi 失败诚实降级 GDI）。全部离线可跑（dxgi 真机
# 冒烟在 dxgi_capture --selftest 的 dxci 探针）。

def _run_selftest() -> int:
    import os
    from unittest import mock

    failures: list[str] = []

    def check(name: str, cond: bool) -> None:
        print(f"[{'PASS' if cond else 'FAIL'}] {name}")
        if not cond:
            failures.append(name)

    # 1. 视觉指纹不变式（既有热路径哨 —— dhash 平图全零 / 阶梯 0x24）
    flat = Image.new("RGB", (64, 64), (128, 128, 128))
    check("dhash flat all-zero", compute_dhash(flat) == "0" * 16)
    arr = np.full((64, 64, 3), 128, dtype=np.uint8)
    arr[:, 32:] = 248
    check("dhash ladder 0x24", compute_dhash(Image.fromarray(arr)) == "24" * 8)

    # 2. 默认 backend=gdi：dxgi 分支零触达（哨兵若被调即 FAIL）
    from .config import ScreenshotConfig

    def _dxgi_sentinel():
        raise AssertionError("dxgi must not be touched with default gdi backend")

    ctrl_gdi = ScreenCapture(ScreenshotConfig())
    ctrl_gdi._grab_dxgi_frame = _dxgi_sentinel  # type: ignore[assignment]
    async def _run_gdi() -> tuple[str | None, bool]:
        with mock.patch.dict(os.environ, {"DSH_PHYSICAL_TEST_SCREEN": "1"}):
            _h, ex = await ctrl_gdi.capture(want_hashes=True, meta_only=True)
        return ex.get("note"), "dxgi" in ex
    note_gdi, has_dxgi = asyncio.run(_run_gdi())
    check("default gdi: capture untouched by dxgi (note absent, no dxgi extras)",
          note_gdi is None and not has_dxgi)

    # 3. backend=dxgi 成功：注入帧经全管线，meta 透 extras["dxgi"]
    injected = Image.fromarray(
        (np.arange(96 * 128 * 3, dtype=np.uint8) % 251).reshape(96, 128, 3))
    ctrl_dx = ScreenCapture(ScreenshotConfig(backend="dxgi"))
    meta_in = {"backend": "dxgi", "width": 128, "height": 96, "fresh": True,
               "dirty_rects": [{"x": 0.25, "y": 0.0, "width": 0.5, "height": 1.0}],
               "move_count": 1, "cursor": False}
    ctrl_dx._grab_dxgi_frame = lambda: (injected, None, meta_in)  # type: ignore[assignment]
    async def _run_dx() -> dict:
        _h, ex = await ctrl_dx.capture(want_hashes=True, keep_frame=True, meta_only=True)
        return ex
    ex_dx = asyncio.run(_run_dx())
    check("dxgi success: extras['dxgi'] surfaced with dirty_rects",
          ex_dx.get("dxgi", {}).get("backend") == "dxgi"
          and len(ex_dx["dxgi"]["dirty_rects"]) == 1
          and ex_dx.get("note") is None)
    check("dxgi success: frame flows existing pipeline (dhash of injected)",
          ex_dx.get("dhash") == compute_dhash(injected))

    # 4. backend=dxgi 失败：诚实降级既有 GDI 路径 + note 申报原因
    # （pyautogui.screenshot 强制失败 → TEST_SCREEN 合成图；无 pyautogui 的
    # 环境走 ImportError 侧的自然失败降级 —— 两种环境同断言）
    ctrl_fail = ScreenCapture(ScreenshotConfig(backend="dxgi"))
    ctrl_fail._grab_dxgi_frame = lambda: (None, "dxgi exploded; degraded to gdi", None)  # type: ignore[assignment]

    async def _fail_once() -> dict:
        with mock.patch.dict(os.environ, {"DSH_PHYSICAL_TEST_SCREEN": "1"}):
            try:
                import pyautogui as _pag
            except ImportError:
                _h, ex = await ctrl_fail.capture(want_hashes=True, meta_only=True)
                return ex
            with mock.patch.object(_pag, "screenshot", side_effect=RuntimeError("forced")):
                _h, ex = await ctrl_fail.capture(want_hashes=True, meta_only=True)
                return ex

    ex_fail = asyncio.run(_fail_once())
    check("dxgi failure: honest degrade note + gdi frame still served",
          isinstance(ex_fail.get("note"), str) and "degraded to gdi" in ex_fail["note"]
          and "dxgi" not in ex_fail and ex_fail.get("dhash"))

    print(f"\nscreen selftest: {'OK' if not failures else 'FAILED: ' + '; '.join(failures)}")
    return 0 if not failures else 1


if __name__ == "__main__":
    import sys as _sys

    if "--selftest" in _sys.argv:
        raise SystemExit(_run_selftest())
    print("usage: python -m dsh_physical.screen --selftest")
    raise SystemExit(2)
