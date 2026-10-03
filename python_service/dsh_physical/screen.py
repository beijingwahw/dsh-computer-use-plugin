"""截屏 —— shm 优先 → mmap-file → base64 降级链。

依赖说明：
  - macOS：``pyautogui.screenshot()``（基于 PyObjC ApplicationServices）
  - Windows：``pyautogui.screenshot()``（基于 DWM API）
  - Linux：``pyautogui.screenshot()``（基于 scrot / ImageMagick；需 X server）
    - 无 X 时降级到 Xvfb 虚拟屏（容器场景）
    - 完全无显示时 ``raise`` → 转为 ``SCREEN_CAPTURE_FAILED``

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
import time
from collections import deque
from typing import Literal

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .config import ScreenshotConfig
from .errors import ErrorKind, PhysicalError
from .shm import ShmHandle, make_handle

ImageFormat = Literal["png", "jpeg"]


# ─── 视觉指纹（服务端计算 —— Node 端无原生图像依赖的根基）───
#
# 语义与 Node 端 perceptualHash.ts 对齐：
#   dhash：9x8 灰度水平梯度 → 64bit（捕获前后对比 / 变化门控）
#   phash：32x32 灰度 DCT-II 低频 8x8（DC 排除 ⇒ 亮度不变）→ 64bit 第二指纹
# 指纹永远在「干净帧」（无叠加层）上计算 —— 叠加网格不得污染变化检测。


def compute_dhash(img: Image.Image) -> str:
    """dHash：9x8 灰度相邻列比较 → 64bit 十六进制。"""
    g = img.convert("L").resize((9, 8))
    px = list(g.getdata())
    bits = 0
    for row in range(8):
        base = row * 9
        for col in range(8):
            if px[base + col] > px[base + col + 1]:
                bits |= 1 << (row * 8 + col)
    return f"{bits:016x}"


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
    """pHash：32x32 灰度二维 DCT → 左上 8x8（去 DC）中位阈值 → 64bit。"""
    g = np.asarray(img.convert("L").resize((32, 32)), dtype=np.float64)
    c32 = _dct_matrix(32)
    dct = c32 @ g @ c32.T
    low = dct[:8, :8].copy()
    low[0, 0] = 0.0  # DC 排除：亮度不变性（与 Node 端 Q-2 同律）
    med = float(np.median(low))
    bits = 0
    for i, v in enumerate(low.flatten()):
        if v > med:
            bits |= 1 << i
    return f"{bits:016x}"


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
    entropies: list[float] = []
    for by in range(grid[1]):
        for bx in range(grid[0]):
            block = mag[by * bh:(by + 1) * bh, bx * bw:(bx + 1) * bw]
            hist, _ = np.histogram(block, bins=bins, range=(0, mag.max() + 1e-9))
            p = hist.astype(np.float64) + 1e-9
            p /= p.sum()
            entropies.append(float(-(p * np.log2(p)).sum()))

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
        result = await loop.run_in_executor(None, _enum_monitors_win32)
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

    def __init__(self, config: ScreenshotConfig) -> None:
        self.cfg = config
        self._dry_run = False
        # 帧环缓存（干净帧半分辨率 RGB）：frame_id → ndarray。物理规则统计 /
        # popup 几何传感 / frame_diff 全部在此计算 —— Node 端零图像解码依赖。
        self._frames: deque[tuple[int, np.ndarray, tuple[int, int]]] = deque()
        self._frame_seq = 0

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

        返回 ``(handle, extras)``；extras = {dhash, phash, region_dhash,
        unchanged, frame_id, frame_count}。
        """
        if format not in ("png", "jpeg"):
            raise PhysicalError(
                ErrorKind.INVALID_ARGS,
                f"unsupported format: {format!r} (allowed: png/jpeg)",
            )

        loop = asyncio.get_running_loop()

        # Σ-5：非 Windows 请求 display ⇒ 诚实降级主屏并 note 如实申报
        # （不静默假装多屏，也不拒服务 —— 跨平台行为可预期）。
        display_used: int | None = display
        degrade_note: str | None = None
        if display is not None and platform.system() != "Windows":
            degrade_note = (
                f"display={display} ignored: cross-screen capture is Windows-only; "
                f"degraded to primary capture"
            )
            display_used = None

        full = await loop.run_in_executor(None, self._capture_image, None, display_used)

        extras: dict = {
            "dhash": None, "phash": None, "region_dhash": None,
            "unchanged": False, "frame_id": None, "frame_count": len(self._frames),
            "salience": None,
        }
        if degrade_note is not None:
            extras["note"] = degrade_note
        if display is not None:
            extras["display"] = display_used

        if want_hashes or gate:
            extras["dhash"] = compute_dhash(full)

        if want_hashes:
            extras["phash"] = compute_phash(full)

        if want_region_hash:
            crop = self._crop_region(full, self._center_to_rect(want_region_hash))
            extras["region_dhash"] = compute_dhash(crop)

        # 变化门控：新鲜指纹与参考几乎相同 ⇒ 屏幕未变，跳过整条下游管线
        if gate and extras["dhash"]:
            ref = str(gate.get("dhash_ref") or "")
            dist = int(gate.get("distance") or 0)
            if ref and hamming_hex(extras["dhash"], ref) <= dist:
                extras["unchanged"] = True
                return None, extras

        if keep_frame:
            self._frame_seq += 1
            half = full.convert("RGB").resize(
                (max(1, full.width // 2), max(1, full.height // 2)),
            )
            self._frames.append(
                (self._frame_seq, np.asarray(half, dtype=np.uint8), (full.width, full.height))
            )
            while len(self._frames) > self.MAX_CACHED_FRAMES:
                self._frames.popleft()
            extras["frame_id"] = self._frame_seq
            extras["frame_count"] = len(self._frames)

        # Y-1/Y-2：显著度图（干净帧上计算 —— 叠加网格不得污染熵估计）
        if want_salience or (overlay and overlay.get("auto_foveate")):
            sal = await loop.run_in_executor(None, compute_salience, full)
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

        img = await loop.run_in_executor(None, _compose)

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
            img.save(buf, format="PNG", optimize=True)
            return buf.getvalue(), img.width, img.height

        try:
            image_bytes, width, height = await loop.run_in_executor(None, _encode)
        except Exception as e:  # noqa: BLE001
            raise PhysicalError(
                ErrorKind.SCREEN_CAPTURE_FAILED,
                f"image encode failed: {e}",
            ) from e

        # 写入共享内存通道
        handle = make_handle(
            image_bytes,
            width,
            height,
            format=format.upper(),
            config=self.cfg,
        )
        return handle, extras

    async def capture_png_bytes(self, region: dict | None = None) -> tuple[bytes, int, int]:
        """截屏为 PNG 字节（J 纪元新增 —— 供 get_ui_tree 复用同一截屏路径）。

        旧实现里 get_ui_tree 内联了一份独立截屏代码：不走本类 ⇒ 不享受
        ``DSH_PHYSICAL_TEST_SCREEN`` 合成图降级，且异常被静默 ``pass`` 吞掉。
        """
        loop = asyncio.get_running_loop()
        img = await loop.run_in_executor(None, self._capture_image, region)

        def _encode() -> tuple[bytes, int, int]:
            buf = io.BytesIO()
            img.save(buf, format="PNG", optimize=True)
            return buf.getvalue(), img.width, img.height

        try:
            return await loop.run_in_executor(None, _encode)
        except Exception as e:  # noqa: BLE001
            raise PhysicalError(
                ErrorKind.SCREEN_CAPTURE_FAILED,
                f"image encode failed: {e}",
            ) from e

    def _capture_image(self, region: dict | None, display: int | None = None) -> Image.Image:
        """同步截屏（线程池内执行）：真实截屏 → 测试降级 → 裁剪。

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
        """获取屏幕尺寸。"""
        try:
            import pyautogui

            size = await asyncio.get_running_loop().run_in_executor(
                None, lambda: pyautogui.size()
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
        for fid, arr, full_size in reversed(self._frames):
            if fid == frame_id:
                return arr, full_size
        raise PhysicalError(
            ErrorKind.INVALID_ARGS,
            f"frame {frame_id} not in cache (kept: {[f[0] for f in self._frames]})",
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
        return [f[0] for f in self._frames]
