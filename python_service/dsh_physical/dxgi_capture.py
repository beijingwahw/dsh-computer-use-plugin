"""ΝΩ-51 —— DXGI Desktop Duplication 截屏 backend（ctypes 零依赖直调）。

动机：GDI BitBlt（pyautogui.screenshot）全桌面抓取是最大 CPU 热点；DXGI
Desktop Duplication（DDA）由 GPU 合成器直给桌面纹理，脏区矩形免费附带。

ABI 事实源（本模块所有 COM 槽位/IID/结构体尺寸均逐一核对 mingw-w64 头
（WIDL 生成，与 Windows 运行时 ABI 逐位一致；dxgi.h / dxgi1_2.h /
d3d11.h / winerror.h），拒绝"凭记忆写 COM"——IDXGIOutputDuplication 的
ReleaseFrame 在 vtable 末位（slot 14）而非 AcquireNextFrame 邻位，即
是靠核对而非记忆钉死的反例）：

  IID_IDXGIFactory1        {770aae78-f26f-4dba-a829-253c83d1b387}
  IID_IDXGIAdapter1        {29038f61-3839-4626-91fd-086879011a05}
  IID_IDXGIOutput          {ae02eedb-c735-4690-8d52-5a8dc20213aa}
  IID_IDXGIOutput1         {00cddea8-939b-4b83-a340-a685226666cc}
  IID_ID3D11Texture2D      {6f15aaf2-d208-4e89-9ab4-489535d34f9c}

  vtable 槽位（0 基，含继承累计）：
    IDXGIFactory1::EnumAdapters1            = 12
    IDXGIAdapter::EnumOutputs               = 7
    IDXGIOutput::GetDesc                    = 7   （HRESULT）
    IDXGIOutput1::DuplicateOutput           = 22  （3 IUnknown + 4 IDXGIObject
                                                    + 12 IDXGIOutput + 第 4 法）
    IDXGIOutputDuplication::GetDesc         = 7   （void）
    IDXGIOutputDuplication::AcquireNextFrame= 8
    IDXGIOutputDuplication::GetFrameDirtyRects = 9
    IDXGIOutputDuplication::GetFrameMoveRects  = 10
    IDXGIOutputDuplication::ReleaseFrame    = 14
    ID3D11Device::CreateTexture2D           = 5
    ID3D11Device::GetImmediateContext       = 40
    ID3D11DeviceContext::Map                = 14
    ID3D11DeviceContext::Unmap              = 15
    ID3D11DeviceContext::CopyResource       = 47
    ID3D11Texture2D::GetDesc                = 10  （void）

MVP 边界（诚实申报）：
  - 主屏单输出（第一个 AttachedToDesktop 的 adapter/output）；多屏走既有
    GDI 路径（screen.py 分流保证）。
  - DDA 帧不含鼠标指针（指针由 GetFramePointerShape 单独给 —— MVP 不画，
    meta["cursor"]=False 如实申报；对变化门控反而是降噪）。
  - "零拷贝"是营销词：实际 1 次 GPU 内拷贝（CopyResource 到 staging）+
    1 次 DMA（Map）。仍远低于 GDI BitBlt 的 CPU 路径。

线程模型（工单要求「COM 单线程亲和 + 重入锁」的落地）：
  - D3D11CreateDevice 不带 D3D11_CREATE_DEVICE_SINGLETHREADED ⇒ 设备
    free-threaded（内部自锁）；CoInitializeEx/CoUninitialize 严格配对在
    会话**创建线程**内（工厂创建完成后即卸 —— 后续跨池线程走 agile 指针
    直调 vtable，无需 apartment 编组）。
  - grabber 级 RLock 串行化所有 Acquire/Release —— AcquireNextFrame 与
    ReleaseFrame 的配对绝不容许并发交叉。

异常语义：本模块运行层抛 ``PhysicalError(SCREEN_CAPTURE_FAILED)``（受控
诚实信封 —— 与 GDI 路径同方言）；screen.py 分流处捕获并降级 GDI，端到端
仍满足「运行层绝不裸抛」。

自测入口（ΝΩ-51）：``python -m dsh_physical.dxgi_capture --selftest``
"""
from __future__ import annotations

import ctypes
import struct
import sys
import threading
import time
import uuid as _uuid
from typing import Callable, Iterable

from PIL import Image

from .errors import ErrorKind, PhysicalError

# ─── ABI 常量（全部来自 mingw-w64 头核对值，见模块头注）───

IID_IDXGIFACTORY1 = "770aae78-f26f-4dba-a829-253c83d1b387"
IID_IDXGIOUTPUT1 = "00cddea8-939b-4b83-a340-a685226666cc"
IID_ID3D11TEXTURE2D = "6f15aaf2-d208-4e89-9ab4-489535d34f9c"

_VTBL = {
    "factory1_enum_adapters1": 12,
    "adapter_enum_outputs": 7,
    "output_get_desc": 7,
    "output1_duplicate_output": 22,
    "dupl_get_desc": 7,
    "dupl_acquire_next_frame": 8,
    "dupl_get_frame_dirty_rects": 9,
    "dupl_get_frame_move_rects": 10,
    "dupl_release_frame": 14,
    "device_create_texture2d": 5,
    "device_get_immediate_context": 40,
    "ctx_map": 14,
    "ctx_unmap": 15,
    "ctx_copy_resource": 47,
    "tex2d_get_desc": 10,
}

DXGI_FORMAT_B8G8R8A8_UNORM = 87        # dxgiformat.h
D3D11_USAGE_STAGING = 3                 # d3d11.h
D3D11_CPU_ACCESS_READ = 0x20000
D3D11_MAP_READ = 1
D3D11_SDK_VERSION = 7
D3D_DRIVER_TYPE_UNKNOWN = 0             # 指定 adapter 时 DriverType 必须 UNKNOWN
COINIT_APARTMENTTHREADED = 0x2

# HRESULT（winerror.h —— DXGI 族为 0x887A0000 | code）
S_OK = 0
S_FALSE = 1
E_ACCESSDENIED = 0x80070005
RPC_E_CHANGED_MODE = 0x80010106
E_OUTOFMEMORY = 0x8007000E
DXGI_ERROR_INVALID_CALL = 0x887A0001
DXGI_ERROR_MORE_DATA = 0x887A0003
DXGI_ERROR_DEVICE_REMOVED = 0x887A0005
DXGI_ERROR_GRAPHICS_VIDPN_SOURCE_IN_USE = 0x887A000C
DXGI_ERROR_NOT_CURRENTLY_AVAILABLE = 0x887A0022
DXGI_ERROR_ACCESS_LOST = 0x887A0026
DXGI_ERROR_WAIT_TIMEOUT = 0x887A0027
DXGI_ERROR_SESSION_DISCONNECTED = 0x887A0028

_HR_NAMES = {
    S_OK: "S_OK", S_FALSE: "S_FALSE",
    E_ACCESSDENIED: "E_ACCESSDENIED", RPC_E_CHANGED_MODE: "RPC_E_CHANGED_MODE",
    E_OUTOFMEMORY: "E_OUTOFMEMORY",
    DXGI_ERROR_INVALID_CALL: "DXGI_ERROR_INVALID_CALL",
    DXGI_ERROR_MORE_DATA: "DXGI_ERROR_MORE_DATA",
    DXGI_ERROR_DEVICE_REMOVED: "DXGI_ERROR_DEVICE_REMOVED",
    DXGI_ERROR_GRAPHICS_VIDPN_SOURCE_IN_USE: "DXGI_ERROR_GRAPHICS_VIDPN_SOURCE_IN_USE",
    DXGI_ERROR_NOT_CURRENTLY_AVAILABLE: "DXGI_ERROR_NOT_CURRENTLY_AVAILABLE",
    DXGI_ERROR_ACCESS_LOST: "DXGI_ERROR_ACCESS_LOST",
    DXGI_ERROR_WAIT_TIMEOUT: "DXGI_ERROR_WAIT_TIMEOUT",
    DXGI_ERROR_SESSION_DISCONNECTED: "DXGI_ERROR_SESSION_DISCONNECTED",
}


def hr_name(hr: int) -> str:
    """HRESULT → 可读名（未知给 0xXXXXXXXX —— 诚实信封 detail 用）。"""
    return _HR_NAMES.get(hr & 0xFFFFFFFF, f"0x{hr & 0xFFFFFFFF:08X}")


# ─── 纯函数（离线单测锚点 —— 不触 COM/PIL 之外的任何系统面）───


def guid_bytes(guid: str) -> bytes:
    """IID 字符串 → Windows 内存布局 16 字节（Data1/2/3 小端 + Data8 原序）。

    与 C 侧 ``__uuidof`` 的内存表示逐字节一致：``uuid.UUID(...).bytes_le``。
    """
    return _uuid.UUID(guid).bytes_le


def bgra_to_rgb_image(data: bytes, width: int, height: int, pitch: int) -> Image.Image:
    """staging Map 出的 BGRA 行缓冲（stride=pitch）→ RGB PIL 图。

    numpy 视图三步（C 段常量因子）：按 pitch 重排行 → 切去行尾填充 →
    BGRA 反序成 RGB（numpy 是本服务硬依赖，非新增第三方）。一次
    string_at 拷贝不可省：Map 指针在 Unmap 后失效。输出与 GDI 路径
    同方言（RGB PIL Image）。
    """
    if width <= 0 or height <= 0 or pitch < width * 4 or len(data) < pitch * height:
        raise ValueError(
            f"bgra_to_rgb_image: bad geometry {width}x{height} pitch={pitch} "
            f"len(data)={len(data)}"
        )
    import numpy as np

    rows = np.frombuffer(data, dtype=np.uint8, count=pitch * height).reshape(height, pitch)
    rgb = rows[:, : width * 4].reshape(height, width, 4)[..., 2::-1]
    return Image.fromarray(np.ascontiguousarray(rgb), mode="RGB")


def normalize_dirty_rects(
    rects_px: Iterable[tuple[int, int, int, int]], out_w: int, out_h: int,
    cap: int = 64,
) -> list[dict]:
    """桌面像素域 (left, top, right, bottom) 矩形清单 → 归一化 [0,1] 方言。

    与 frame_diff 的 changed_regions 同方言（{x, y, width, height}，全屏
    归一化）。零面积/全出界矩形丢弃；部分出界夹取；按面积降序、cap 截断
    （DDA 在极端工况下可给上千微矩形 —— 不设上限会淹没上层）。
    """
    out: list[dict] = []
    for l, t, r, b in rects_px:
        x0, y0 = max(0, int(l)), max(0, int(t))
        x1, y1 = min(int(out_w), int(r)), min(int(out_h), int(b))
        if x1 - x0 < 1 or y1 - y0 < 1:
            continue
        out.append({
            "x": x0 / out_w, "y": y0 / out_h,
            "width": (x1 - x0) / out_w, "height": (y1 - y0) / out_h,
        })
    out.sort(key=lambda d: d["width"] * d["height"], reverse=True)
    return out[:cap]


def _parse_move_rects(raw: bytes) -> list[tuple[int, int, int, int]]:
    """DXGI_OUTDUPL_MOVE_RECT（POINT 源 + RECT 目的，24B/条）→ 目的矩形。

    源点仅供上层做滚动方向推断（MVP 不透出）；变化区域语义只关心目的矩形。
    """
    rects = []
    for off in range(0, len(raw) - 23, 24):
        _sx, _sy, l, t, r, b = struct.unpack_from("<6i", raw, off)
        rects.append((l, t, r, b))
    return rects


def _parse_dirty_rects(raw: bytes) -> list[tuple[int, int, int, int]]:
    """RECT（16B/条）清单 → (left, top, right, bottom) 元组清单。"""
    rects = []
    for off in range(0, len(raw) - 15, 16):
        rects.append(struct.unpack_from("<4i", raw, off))
    return rects


# ─── ctypes 结构体（布局 ABI 锚点：tests/test_dxgi.py 钉死 sizeof）───
# 跨平台可导入（CI/离线单测在非 Windows 跑）：仅声明，不触碰 windll。

# ΝΩ-51 真机战果：restype 用 ctypes.HRESULT 时，ctypes 会把失败 HRESULT
# 自动转 OSError 抛出（真机实测 WAIT_TIMEOUT 0x887A0027 直接炸 OSError，
# 绕过所有 `hr & 0xFFFFFFFF` 比较分支）。HRESULT 本体就是 32 位有符号
# int —— 统一 c_long 裸值，判定权留在本模块的显式比较。
_HRESULT = ctypes.c_long
_ULONG = ctypes.c_ulong
_WINFUNCTYPE = getattr(ctypes, "WINFUNCTYPE", ctypes.CFUNCTYPE)
_LONGLONG = ctypes.c_longlong
_UINT = ctypes.c_uint
_BOOL = ctypes.c_int  # Win32 BOOL（4B）


class _POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class _RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long), ("top", ctypes.c_long),
        ("right", ctypes.c_long), ("bottom", ctypes.c_long),
    ]


class _Rational(ctypes.Structure):
    _fields_ = [("Numerator", _UINT), ("Denominator", _UINT)]


class _ModeDesc(ctypes.Structure):
    """DXGI_MODE_DESC：Width/Height/RefreshRate/Format/ScanlineOrdering/Scaling。"""
    _fields_ = [
        ("Width", _UINT), ("Height", _UINT), ("RefreshRate", _Rational),
        ("Format", _UINT), ("ScanlineOrdering", _UINT), ("Scaling", _UINT),
    ]


class _OutduplDesc(ctypes.Structure):
    """DXGI_OUTDUPL_DESC = ModeDesc(28) + Rotation(4) + BOOL(4) = 36。"""
    _fields_ = [
        ("ModeDesc", _ModeDesc), ("Rotation", _UINT),
        ("DesktopImageInSystemMemory", _BOOL),
    ]


class _PointerPosition(ctypes.Structure):
    _fields_ = [("Position", _POINT), ("Visible", _BOOL)]


class _FrameInfo(ctypes.Structure):
    """DXGI_OUTDUPL_FRAME_INFO —— sizeof 钉死 48（x86/x64 同值）。"""
    _fields_ = [
        ("LastPresentTime", _LONGLONG), ("LastMouseUpdateTime", _LONGLONG),
        ("AccumulatedFrames", _UINT), ("RectsCoalesced", _BOOL),
        ("ProtectedContentMaskedOut", ctypes.c_ubyte),
        ("PointerPosition", _PointerPosition),
        ("TotalMetadataBufferSize", _UINT), ("PointerShapeBufferSize", _UINT),
    ]


class _OutduplMoveRect(ctypes.Structure):
    """DXGI_OUTDUPL_MOVE_RECT = POINT(8) + RECT(16) = 24。"""
    _fields_ = [("SourcePoint", _POINT), ("DestinationRect", _RECT)]


class _Tex2DDesc(ctypes.Structure):
    """D3D11_TEXTURE2D_DESC —— 10×UINT 族，sizeof=40。"""
    _fields_ = [
        ("Width", _UINT), ("Height", _UINT), ("MipLevels", _UINT),
        ("ArraySize", _UINT), ("Format", _UINT),
        ("SampleDesc", _Rational), ("Usage", _UINT), ("BindFlags", _UINT),
        ("CPUAccessFlags", _UINT), ("MiscFlags", _UINT),
    ]


class _MappedSubresource(ctypes.Structure):
    """D3D11_MAPPED_SUBRESOURCE = ptr + 2×UINT。"""
    _fields_ = [
        ("pData", ctypes.c_void_p), ("RowPitch", _UINT), ("DepthPitch", _UINT),
    ]


class _OutputDesc(ctypes.Structure):
    """DXGI_OUTPUT_DESC（DeviceName[32] + RECT + BOOL + Rotation + HMONITOR）。"""
    _fields_ = [
        ("DeviceName", ctypes.c_wchar * 32), ("DesktopCoordinates", _RECT),
        ("AttachedToDesktop", _BOOL), ("Rotation", _UINT),
        ("Monitor", ctypes.c_void_p),
    ]


# ─── COM vtable 直调（槽位见 _VTBL；构造一次、会话期复用）───

_P_Release = _WINFUNCTYPE(_ULONG, ctypes.c_void_p)
_P_QI = _WINFUNCTYPE(_HRESULT, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))
_P_EnumAdapters1 = _WINFUNCTYPE(_HRESULT, ctypes.c_void_p, _UINT, ctypes.POINTER(ctypes.c_void_p))
_P_EnumOutputs = _WINFUNCTYPE(_HRESULT, ctypes.c_void_p, _UINT, ctypes.POINTER(ctypes.c_void_p))
_P_GetDescHR = _WINFUNCTYPE(_HRESULT, ctypes.c_void_p, ctypes.c_void_p)
_P_GetDescVoid = _WINFUNCTYPE(None, ctypes.c_void_p, ctypes.c_void_p)
_P_DuplicateOutput = _WINFUNCTYPE(
    _HRESULT, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p),
)
_P_AcquireNextFrame = _WINFUNCTYPE(
    _HRESULT, ctypes.c_void_p, _UINT, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p),
)
_P_ReleaseFrame = _WINFUNCTYPE(_HRESULT, ctypes.c_void_p)
_P_MetaRects = _WINFUNCTYPE(
    _HRESULT, ctypes.c_void_p, _UINT, ctypes.c_void_p, ctypes.POINTER(_UINT),
)
_P_CreateTexture2D = _WINFUNCTYPE(
    _HRESULT, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p),
)
_P_GetImmediateContext = _WINFUNCTYPE(None, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))
_P_CopyResource = _WINFUNCTYPE(None, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p)
_P_Map = _WINFUNCTYPE(
    _HRESULT, ctypes.c_void_p, ctypes.c_void_p, _UINT, _UINT, _UINT, ctypes.c_void_p,
)
_P_Unmap = _WINFUNCTYPE(_HRESULT, ctypes.c_void_p, ctypes.c_void_p, _UINT)


def _vtbl_fn(obj: int, slot: int, proto: Callable) -> Callable:
    """COM 对象地址 + vtable 槽位 → 可调用函数指针（ctypes 构造，非 comtypes）。

    ``obj`` 是裸接口指针值（int）。x64 前参走寄存器，无 callee 清栈问题 ——
    即使槽位选错也只是参数被错误解读，不会栈损（自测探针的安全性根基）。
    """
    if not obj:
        raise PhysicalError(ErrorKind.SCREEN_CAPTURE_FAILED, "dxgi: null interface pointer")
    vtbl = ctypes.cast(obj, ctypes.POINTER(ctypes.c_void_p))[0]
    entries = ctypes.cast(vtbl, ctypes.POINTER(ctypes.c_void_p))
    return proto(entries[slot])


def _iid_buf(guid: str) -> ctypes.Array:
    return ctypes.create_string_buffer(guid_bytes(guid), 16)


_IID_BUF_FACTORY1 = _iid_buf(IID_IDXGIFACTORY1)
_IID_BUF_OUTPUT1 = _iid_buf(IID_IDXGIOUTPUT1)
_IID_BUF_TEX2D = _iid_buf(IID_ID3D11TEXTURE2D)


class _AccessLost(Exception):
    """DDA 会话失联（ACCESS_LOST / DEVICE_REMOVED）—— grabber 换会话重试的内部信号。"""


class _DxgiSession:
    """一次 DuplicateOutput 的完整生命周期（创建 → 抓帧 → 释放）。

    所有裸指针在 ``close()`` 逐个 ``Release``；``grab`` 内 Acquire 与
    ReleaseFrame 严格配对（try/finally 保证资源释放不因异常路径漏调）。
    """

    MAX_ADAPTER_PROBES = 16  # EnumAdapters1 上限防御（坏驱动停不下来说实话）

    def __init__(self) -> None:
        self._factory = self._adapter = self._output = self._output1 = None
        self._device = self._context = self._dupl = self._staging = None
        self._fn: dict[str, Callable] = {}
        self.width = 0
        self.height = 0
        self._origin = (0, 0)
        self._cached: Image.Image | None = None

    # ── 创建链（调用线程内 CoInitialize/CoUninitialize 严格配对）──

    @classmethod
    def create(cls) -> "_DxgiSession":
        if sys.platform != "win32":
            raise PhysicalError(
                ErrorKind.SCREEN_CAPTURE_FAILED,
                "dxgi backend requires win32 (ctypes dxgi/d3d11 unavailable)",
            )
        try:
            ole32 = ctypes.WinDLL("ole32")
            dxgi = ctypes.WinDLL("dxgi")
            d3d11 = ctypes.WinDLL("d3d11")
        except OSError as e:
            raise PhysicalError(
                ErrorKind.SCREEN_CAPTURE_FAILED,
                f"dxgi: system dll unavailable: {e}",
            ) from e

        ole32.CoInitializeEx.restype = _HRESULT
        ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, _UINT]
        hr = int(ole32.CoInitializeEx(None, COINIT_APARTMENTTHREADED))
        if hr & 0xFFFFFFFF == RPC_E_CHANGED_MODE:
            co_uninit = False  # 本线程已被他方按其他模型初始化 —— 不许误拆
        elif hr in (S_OK, S_FALSE):
            co_uninit = True   # S_FALSE 也要配对卸载（COM 引用计数语义）
        else:
            raise PhysicalError(
                ErrorKind.SCREEN_CAPTURE_FAILED,
                f"CoInitializeEx failed: {hr_name(hr)}",
            )
        try:
            return cls._create_chain(dxgi, d3d11)
        finally:
            if co_uninit:
                ole32.CoUninitialize()

    @classmethod
    def _create_chain(cls, dxgi, d3d11) -> "_DxgiSession":
        s = cls()
        factory = ctypes.c_void_p()
        dxgi.CreateDXGIFactory1.restype = _HRESULT
        dxgi.CreateDXGIFactory1.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
        hr = int(dxgi.CreateDXGIFactory1(
            ctypes.cast(ctypes.byref(_IID_BUF_FACTORY1), ctypes.c_void_p),
            ctypes.byref(factory),
        ))
        if hr != S_OK or not factory.value:
            raise PhysicalError(
                ErrorKind.SCREEN_CAPTURE_FAILED,
                f"CreateDXGIFactory1 failed: {hr_name(hr)}",
            )
        s._factory = factory

        try:
            # 找第一个「有在桌面输出」的 adapter/output（MVP：主屏单输出）。
            # 释放账本：每条路径（continue/break/raise）里未移交的接口必须
            # 显式 Release —— 裸指针泄漏在本模块按 bug 对待。
            enum_adapters1 = _vtbl_fn(
                factory.value, _VTBL["factory1_enum_adapters1"], _P_EnumAdapters1)
            release = lambda p: _vtbl_fn(p, 2, _P_Release)(p)  # noqa: E731
            adapter = output = None
            for i in range(cls.MAX_ADAPTER_PROBES):
                a = ctypes.c_void_p()
                hr = int(enum_adapters1(factory.value, i, ctypes.byref(a)))
                if hr != S_OK:
                    break  # DXGI_ERROR_NOT_FOUND = 枚举尽头
                o = ctypes.c_void_p()
                try:
                    hr2 = int(_vtbl_fn(a.value, _VTBL["adapter_enum_outputs"], _P_EnumOutputs)(
                        a.value, 0, ctypes.byref(o)))
                    if hr2 != S_OK or not o.value:
                        continue
                    od = _OutputDesc()
                    hr3 = int(_vtbl_fn(o.value, _VTBL["output_get_desc"], _P_GetDescHR)(
                        o.value, ctypes.byref(od)))
                    if hr3 == S_OK and od.AttachedToDesktop:
                        # 肖像/旋转屏：像素行列与桌面宽高对调 —— MVP 诚实拒付，
                        # screen.py 分流降级 GDI（行为可预期优于错图）。
                        if od.Rotation not in (0, 1):
                            release(o.value)
                            raise PhysicalError(
                                ErrorKind.SCREEN_CAPTURE_FAILED,
                                f"dxgi: rotated output ({od.Rotation}) unsupported in "
                                "ΝΩ-51 MVP; falling back",
                            )
                        adapter, output = a, o
                        s._origin = (
                            int(od.DesktopCoordinates.left), int(od.DesktopCoordinates.top),
                        )
                        break
                    release(o.value)  # 不在桌面（休眠副屏等）→ 换下一个
                finally:
                    if adapter is None and a.value:
                        release(a.value)  # 未选中即释放；选中则所有权移交 s._adapter
            if adapter is None or output is None:
                raise PhysicalError(
                    ErrorKind.SCREEN_CAPTURE_FAILED,
                    "dxgi: no adapter output attached to desktop",
                )
            s._adapter, s._output = adapter, output

            # D3D11 device（指定 adapter ⇒ DriverType 必须 UNKNOWN）
            device = ctypes.c_void_p()
            context = ctypes.c_void_p()
            d3d11.D3D11CreateDevice.restype = _HRESULT
            d3d11.D3D11CreateDevice.argtypes = [
                ctypes.c_void_p, _UINT, ctypes.c_void_p, _UINT, ctypes.c_void_p,
                _UINT, _UINT, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p,
                ctypes.POINTER(ctypes.c_void_p),
            ]
            hr = int(d3d11.D3D11CreateDevice(
                adapter.value, D3D_DRIVER_TYPE_UNKNOWN, None, 0,  # 无 SINGLETHREADED ⇒ free-threaded
                None, 0, D3D11_SDK_VERSION,
                ctypes.byref(device), None, ctypes.byref(context),
            ))
            if hr != S_OK or not device.value:
                raise PhysicalError(
                    ErrorKind.SCREEN_CAPTURE_FAILED,
                    f"D3D11CreateDevice failed: {hr_name(hr)}",
                )
            s._device, s._context = device, context

            # IDXGIOutput1（QI）→ DuplicateOutput
            output1 = ctypes.c_void_p()
            hr = int(_vtbl_fn(output.value, 0, _P_QI)(
                output.value,
                ctypes.cast(ctypes.byref(_IID_BUF_OUTPUT1), ctypes.c_void_p),
                ctypes.byref(output1),
            ))
            if hr != S_OK or not output1.value:
                raise PhysicalError(
                    ErrorKind.SCREEN_CAPTURE_FAILED,
                    f"QI(IDXGIOutput1) failed: {hr_name(hr)}",
                )
            s._output1 = output1

            dupl = ctypes.c_void_p()
            hr = int(_vtbl_fn(output1.value, _VTBL["output1_duplicate_output"], _P_DuplicateOutput)(
                output1.value, device.value, ctypes.byref(dupl)))
            if hr != S_OK or not dupl.value:
                raise PhysicalError(ErrorKind.SCREEN_CAPTURE_FAILED, _duplicate_error_detail(hr))
            s._dupl = dupl

            desc = _OutduplDesc()
            _vtbl_fn(dupl.value, _VTBL["dupl_get_desc"], _P_GetDescVoid)(
                dupl.value, ctypes.byref(desc))
            s.width, s.height = int(desc.ModeDesc.Width), int(desc.ModeDesc.Height)
            if desc.ModeDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM:
                raise PhysicalError(
                    ErrorKind.SCREEN_CAPTURE_FAILED,
                    f"dxgi: unexpected desktop format {desc.ModeDesc.Format} "
                    f"(expected B8G8R8A8_UNORM)",
                )

            # 会话期槽位绑定（vtable 地址进程期稳定 —— 构造一次复用）
            s._fn = {
                "release": lambda p: _vtbl_fn(p, 2, _P_Release)(p),
                "acquire": _vtbl_fn(
                    dupl.value, _VTBL["dupl_acquire_next_frame"], _P_AcquireNextFrame),
                "release_frame": _vtbl_fn(dupl.value, _VTBL["dupl_release_frame"], _P_ReleaseFrame),
                "dirty": _vtbl_fn(dupl.value, _VTBL["dupl_get_frame_dirty_rects"], _P_MetaRects),
                "move": _vtbl_fn(dupl.value, _VTBL["dupl_get_frame_move_rects"], _P_MetaRects),
                "create_tex": _vtbl_fn(
                    device.value, _VTBL["device_create_texture2d"], _P_CreateTexture2D),
                "copy": _vtbl_fn(context.value, _VTBL["ctx_copy_resource"], _P_CopyResource),
                "map": _vtbl_fn(context.value, _VTBL["ctx_map"], _P_Map),
                "unmap": _vtbl_fn(context.value, _VTBL["ctx_unmap"], _P_Unmap),
            }
            return s
        except Exception:
            s.close()
            raise

    # ── 抓帧（grabber 锁内调用 —— Acquire/ReleaseFrame 配对不受并发打扰）──

    # ΝΩ-51 真机战果（1920x1080 Console 会话实测）：DuplicateOutput 后的
    # 首个 AcquireNextFrame 可能是**仅鼠标更新**（LastPresentTime==0、
    # AccumulatedFrames==0、TotalMeta==0）—— 桌面纹理尚未填充，直接
    # CopyResource 得全黑帧（GDI 同刻均值 31.7 vs dxgi 0.0）。有界 warmup：
    # 释放空帧重试直到带 present 的内容帧到达。
    _MAX_ACQUIRE_ATTEMPTS = 5
    _RETRY_WAIT_MS = 120

    def grab(self, timeout_ms: int = 0) -> tuple[Image.Image, dict]:
        """返回 ``(RGB PIL Image, meta)``。

        meta：{backend:'dxgi', width, height, fresh, dirty_rects, move_count,
        cursor:False}。``fresh=False`` = DDA 无内容帧（超时/仅鼠标更新）返回
        上一缓存帧 —— 对截图语义这**就是**当前屏幕（诚实：脏区为空表）。
        """
        info = _FrameInfo()
        for attempt in range(self._MAX_ACQUIRE_ATTEMPTS):
            wait = max(0, int(timeout_ms)) if attempt == 0 else self._RETRY_WAIT_MS
            resource = ctypes.c_void_p()
            hr = int(self._fn["acquire"](
                self._dupl.value, wait, ctypes.byref(info), ctypes.byref(resource)))
            u = hr & 0xFFFFFFFF
            if u in (DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_DEVICE_REMOVED):
                raise _AccessLost(hr_name(u))
            if u == DXGI_ERROR_WAIT_TIMEOUT:
                # 无新帧：屏幕自上次 present 未变 —— 缓存帧即当前屏
                if self._cached is not None:
                    return self._cached, self._meta(fresh=False)
                continue  # 会话初启无基线：再等一轮真 present
            if u != S_OK or not resource.value:
                raise PhysicalError(
                    ErrorKind.SCREEN_CAPTURE_FAILED,
                    f"dxgi: AcquireNextFrame failed: {hr_name(u)}",
                )
            has_present = info.LastPresentTime != 0 or info.AccumulatedFrames > 0
            if not has_present:
                # 仅鼠标/空帧（纹理空，Copy 即黑帧）：释放后重试；有缓存则
                # 直接回缓存（鼠标不在 DDA 帧内 —— 无内容变化，语义准确）
                self._fn["release"](resource.value)
                self._fn["release_frame"](self._dupl.value)
                if self._cached is not None:
                    return self._cached, self._meta(fresh=False)
                continue
            return self._copy_and_map(resource, info)
        raise PhysicalError(
            ErrorKind.SCREEN_CAPTURE_FAILED,
            "dxgi: no presented frame within warmup budget "
            f"({self._MAX_ACQUIRE_ATTEMPTS} attempts) - static screen with no "
            "baseline frame; degrading",
        )

    def _copy_and_map(
        self, resource: ctypes.c_void_p, info: _FrameInfo,
    ) -> tuple[Image.Image, dict]:
        """内容帧落盘路径：QI 纹理 → 脏区 → CopyResource → ReleaseFrame → Map。"""
        dirty: list[tuple[int, int, int, int]] = []
        moves = 0
        staging: ctypes.c_void_p | None = None
        try:
            tex = ctypes.c_void_p()
            hr = int(_vtbl_fn(resource.value, 0, _P_QI)(
                resource.value,
                ctypes.cast(ctypes.byref(_IID_BUF_TEX2D), ctypes.c_void_p),
                ctypes.byref(tex),
            ))
            if hr != S_OK or not tex.value:
                raise PhysicalError(
                    ErrorKind.SCREEN_CAPTURE_FAILED,
                    f"QI(ID3D11Texture2D) on desktop resource failed: {hr_name(hr)}",
                )
            try:
                dirty, moves = self._collect_metadata(info)
                staging = self._ensure_staging()
                # CopyResource 入队先于 ReleaseFrame —— immediate context 按
                # 提交序执行，Map(READ) 冲刷保证读到内容帧（MS 样本同序）
                self._fn["copy"](self._context.value, staging.value, tex.value)
            finally:
                self._fn["release"](tex.value)
        finally:
            self._fn["release"](resource.value)
            self._fn["release_frame"](self._dupl.value)

        mapped = _MappedSubresource()
        hr = int(self._fn["map"](
            self._context.value, staging.value, 0, D3D11_MAP_READ, 0,
            ctypes.byref(mapped),
        ))
        if hr != S_OK or not mapped.pData:
            raise PhysicalError(
                ErrorKind.SCREEN_CAPTURE_FAILED,
                f"dxgi: staging Map failed: {hr_name(hr)}",
            )
        try:
            raw = ctypes.string_at(mapped.pData, int(mapped.RowPitch) * self.height)
        finally:
            self._fn["unmap"](self._context.value, staging.value, 0)

        img = bgra_to_rgb_image(raw, self.width, self.height, int(mapped.RowPitch))
        self._cached = img
        ox, oy = self._origin
        meta = self._meta(
            fresh=True,
            dirty=normalize_dirty_rects(
                ((l - ox, t - oy, r - ox, b - oy) for l, t, r, b in dirty),
                self.width, self.height,
            ),
            moves=moves,
        )
        return img, meta

    def _meta(
        self, fresh: bool, dirty: list[dict] | None = None, moves: int = 0,
    ) -> dict:
        return {
            "backend": "dxgi", "width": self.width, "height": self.height,
            "fresh": fresh, "dirty_rects": dirty or [], "move_count": moves,
            "cursor": False,  # DDA 帧不含指针（诚实申报，见模块头注）
        }

    def _collect_metadata(self, info: _FrameInfo) -> tuple[list[tuple[int, int, int, int]], int]:
        """帧元数据（仅 Acquire..ReleaseFrame 窗口内合法）—— 失败只弃 meta。

        ΝΩ-51 真机战果（py3.14 ctypes 变更）：独立 ``c_uint`` 实例不能再用
        ``int(x)`` 取值（会把缓冲字节当字面量解析而炸 ValueError）—— 统一
        ``.value``（Structure 字段访问不受影响，仍直接给 int）。
        """
        try:
            need = int(info.TotalMetadataBufferSize)
            if need <= 0:
                return [], 0
            raw_move = ctypes.create_string_buffer(need)
            got = _UINT(0)
            hr = int(self._fn["move"](self._dupl.value, need, raw_move, ctypes.byref(got)))
            moves = _parse_move_rects(raw_move.raw[: got.value]) if hr == S_OK else []
            raw_dirty = ctypes.create_string_buffer(need)
            got2 = _UINT(0)
            hr2 = int(self._fn["dirty"](self._dupl.value, need, raw_dirty, ctypes.byref(got2)))
            rects = _parse_dirty_rects(raw_dirty.raw[: got2.value]) if hr2 == S_OK else []
            return moves + rects, len(moves)
        except Exception:  # noqa: BLE001 —— meta 是可选附件，绝不葬送帧本体
            return [], 0

    def _ensure_staging(self) -> ctypes.c_void_p:
        if self._staging is not None:
            return self._staging
        desc = _Tex2DDesc()
        desc.Width, desc.Height = self.width, self.height
        desc.MipLevels, desc.ArraySize = 1, 1
        desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM
        desc.SampleDesc = _Rational(1, 0)
        desc.Usage = D3D11_USAGE_STAGING
        desc.BindFlags = 0
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ
        tex = ctypes.c_void_p()
        hr = int(self._fn["create_tex"](
            self._device.value, ctypes.byref(desc), None, ctypes.byref(tex)))
        if hr != S_OK or not tex.value:
            raise PhysicalError(
                ErrorKind.SCREEN_CAPTURE_FAILED,
                f"dxgi: CreateTexture2D(staging) failed: {hr_name(hr)}",
            )
        self._staging = tex
        return tex

    def close(self) -> None:
        """逐接口 Release（best-effort：单个失败不阻断其余释放）。"""
        for ptr in (
            self._staging, self._dupl, self._output1, self._output,
            self._context, self._device, self._adapter, self._factory,
        ):
            if ptr is not None and ptr.value:
                try:
                    _vtbl_fn(ptr.value, 2, _P_Release)(ptr.value)
                except Exception:  # noqa: BLE001
                    pass
        self._staging = self._dupl = self._output1 = None
        self._output = self._context = self._device = None
        self._adapter = self._factory = None
        self._cached = None


def _duplicate_error_detail(hr: int) -> str:
    """DuplicateOutput 失败 → 诚实降级语义的 detail（screen.py 原样透给 note）。"""
    u = hr & 0xFFFFFFFF
    if u == E_ACCESSDENIED:
        return ("dxgi DuplicateOutput: E_ACCESSDENIED (no exclusive access - secure "
                "desktop / permission-restricted session)")
    if u == DXGI_ERROR_SESSION_DISCONNECTED:
        return ("dxgi DuplicateOutput: DXGI_ERROR_SESSION_DISCONNECTED "
                "(RDP-detached / no display session attached)")
    if u == DXGI_ERROR_NOT_CURRENTLY_AVAILABLE:
        return ("dxgi DuplicateOutput: DXGI_ERROR_NOT_CURRENTLY_AVAILABLE "
                "(duplication quota in use by another session)")
    if u == DXGI_ERROR_GRAPHICS_VIDPN_SOURCE_IN_USE:
        return ("dxgi DuplicateOutput: DXGI_ERROR_GRAPHICS_VIDPN_SOURCE_IN_USE "
                "(fullscreen exclusive app)")
    return f"dxgi DuplicateOutput failed: {hr_name(hr)}"


# ─── grabber：模块级单例 + 重入锁 + ACCESS_LOST 换会话 ───


class DxgiDuplicationGrabber:
    """线程池世界里的会话管家：RLock 串行 + 失联重建（一次，诚实）。"""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._session: _DxgiSession | None = None

    def grab(self, timeout_ms: int = 0) -> tuple[Image.Image, dict]:
        with self._lock:
            if self._session is None:
                self._session = _DxgiSession.create()
            try:
                return self._session.grab(timeout_ms)
            except _AccessLost as first:
                # 模式切换/休眠唤醒/全屏独占 → 会话作废：关旧建新一次
                self._session.close()
                self._session = None
                try:
                    self._session = _DxgiSession.create()
                    return self._session.grab(timeout_ms)
                except _AccessLost as second:  # noqa: F841 —— 二连失联不再循环
                    raise PhysicalError(
                        ErrorKind.SCREEN_CAPTURE_FAILED,
                        f"dxgi: access lost twice in one grab ({first} then "
                        f"{second}) - session unstable",
                    ) from first

    def close(self) -> None:
        with self._lock:
            if self._session is not None:
                self._session.close()
                self._session = None

    def stats(self) -> dict:
        with self._lock:
            return {
                "alive": self._session is not None,
                "width": self._session.width if self._session else 0,
                "height": self._session.height if self._session else 0,
            }


_GRABBER: DxgiDuplicationGrabber | None = None
_GRABBER_LOCK = threading.Lock()


def get_grabber() -> DxgiDuplicationGrabber:
    """进程级单例（screen.py 分流的唯一入口）。"""
    global _GRABBER
    with _GRABBER_LOCK:
        if _GRABBER is None:
            _GRABBER = DxgiDuplicationGrabber()
        return _GRABBER


def probe_backend() -> dict:
    """ΝΩ-51 自测用真机探针：一次真实抓帧 + 尺寸/耗时诚实报告。

    DuplicateOutput 失败（无显示器会话等）以 ``{"ok": False, "reason": ...}``
    诚实返回 —— 不抛（selftest 把缺席记 SKIP 而非 FAIL）。
    """
    try:
        g = DxgiDuplicationGrabber()
        t0 = time.perf_counter()
        img, meta = g.grab(200)
        cold_ms = (time.perf_counter() - t0) * 1000.0
        warm: list[float] = []
        for _ in range(16):
            t0 = time.perf_counter()
            g.grab(0)
            warm.append((time.perf_counter() - t0) * 1000.0)
        warm.sort()
        g.close()
        return {
            "ok": True, "cold_ms": round(cold_ms, 2),
            "warm_median_ms": round(warm[len(warm) // 2], 2),
            "warm_min_ms": round(warm[0], 2),
            "width": img.width, "height": img.height,
            "fresh": meta["fresh"], "dirty_rects": len(meta["dirty_rects"]),
        }
    except PhysicalError as e:
        return {"ok": False, "reason": e.detail}


# ─── 自测入口（ΝΩ-51）：python -m dsh_physical.dxgi_capture --selftest ───


def _run_selftest() -> int:
    import os

    failures: list[str] = []

    def check(name: str, cond: bool) -> None:
        print(f"[{'PASS' if cond else 'FAIL'}] {name}")
        if not cond:
            failures.append(name)

    # 1. ABI 结构体尺寸（mingw-w64 头核对值 —— COM 结构布局漂移的第一道哨）
    check("DXGI_OUTDUPL_FRAME_INFO sizeof=48", ctypes.sizeof(_FrameInfo) == 48)
    check("DXGI_OUTDUPL_MOVE_RECT sizeof=24", ctypes.sizeof(_OutduplMoveRect) == 24)
    check("DXGI_OUTDUPL_DESC sizeof=36", ctypes.sizeof(_OutduplDesc) == 36)
    check("D3D11_TEXTURE2D_DESC sizeof=44", ctypes.sizeof(_Tex2DDesc) == 44)
    check("D3D11_MAPPED_SUBRESOURCE sizeof=ptr+8",
          ctypes.sizeof(_MappedSubresource) == ctypes.sizeof(ctypes.c_void_p) + 8)
    # PointerPosition 偏移 = 28（BOOLEAN 后 3 字节对齐垫）—— 尾部两 UINT 不漂移
    check("FRAME_INFO PointerPosition offset=28",
          _FrameInfo.PointerPosition.offset == 28)

    # 2. GUID 字节序（uuid.bytes_le 与 Windows IID 内存表示逐字节一致）
    gb = guid_bytes("770aae78-f26f-4dba-a829-253c83d1b387")
    check("guid_bytes little-endian mixed layout",
          gb[:4] == bytes.fromhex("78ae0a77") and gb[-1] == 0x87 and len(gb) == 16)

    # 3. BGRA→RGB（stride + 通道序 + alpha 剥离）
    # 2x1 图，pitch=16（8B 像素 + 8B 行尾填充）：像素 [B,G,R,255]×2
    raw = bytes([10, 20, 30, 255, 40, 50, 60, 255]) + b"\xAA" * 8
    img = bgra_to_rgb_image(raw, 2, 1, 16)
    check("bgra conversion honors stride + channel order",
          img.getpixel((0, 0)) == (30, 20, 10) and img.getpixel((1, 0)) == (60, 50, 40)
          and img.mode == "RGB")

    # 4. 脏区归一化（夹取/去零面积/cap）
    rects = [(-5, -5, 100, 50), (10, 10, 11, 11), (0, 0, 200, 100)]
    norm = normalize_dirty_rects(rects, 200, 100, cap=2)
    check("dirty rect clamp+normalize+dedupe-degenerate",
          len(norm) == 2
          and norm[0] == {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}
          and norm[1] == {"x": 0.0, "y": 0.0, "width": 0.5, "height": 0.5})

    # 5. MOVE/DIRTY 矩形裸解析（24B/16B 记录）
    mv = struct.pack("<6i", 7, 8, 0, 0, 64, 32)
    dr = struct.pack("<4i", 1, 2, 3, 4) + struct.pack("<4i", 5, 6, 7, 8)
    check("move rect parse 24B stride", _parse_move_rects(mv) == [(0, 0, 64, 32)])
    check("dirty rect parse 16B stride",
          _parse_dirty_rects(dr) == [(1, 2, 3, 4), (5, 6, 7, 8)])

    # 6. hr_name 已知/未知
    check("hr_name known/unknown",
          hr_name(0x887A0027) == "DXGI_ERROR_WAIT_TIMEOUT"
          and hr_name(0xDEADBEEF) == "0xDEADBEEF")

    # 7. config backend 缺省（零回归第一哨：不设 env 必须 gdi）
    os.environ.pop("DSH_PHYSICAL_SHOT_BACKEND", None)
    from .config import load_config_from_env

    check(
        "default shot backend = gdi (zero-regression)",
        load_config_from_env().screenshot.backend == "gdi",
    )

    # 8. 真机探针（dxci）：在场一次真实抓帧 + 耗时；缺席/失败诚实 SKIP
    if sys.platform == "win32":
        probe = probe_backend()
        if probe["ok"]:
            print(f"[INFO] dxci real probe: {probe['width']}x{probe['height']} "
                  f"cold={probe['cold_ms']}ms warm_med={probe['warm_median_ms']}ms "
                  f"warm_min={probe['warm_min_ms']}ms fresh={probe['fresh']} "
                  f"dirty={probe['dirty_rects']}")
            check("dxci probe frame sane", probe["width"] >= 640 and probe["height"] >= 480)
            try:
                import pyautogui

                sizes = []
                for _ in range(8):
                    t0 = time.perf_counter()
                    pyautogui.screenshot()
                    sizes.append((time.perf_counter() - t0) * 1000.0)
                sizes.sort()
                print(f"[INFO] gdi (pyautogui.screenshot) median={sizes[len(sizes) // 2]:.2f}ms "
                      f"min={sizes[0]:.2f}ms n=8 —— 与上 dxci 数字同机对比")
            except Exception as e:  # noqa: BLE001
                print(f"[INFO] gdi 对照缺席（pyautogui 不可用）: {type(e).__name__}")
        else:
            print(f"[SKIP] dxci real probe (honest absence): {probe['reason']}")
    else:
        print("[SKIP] dxci real probe: non-win32 platform")

    print(f"\ndxgi_capture selftest: {'OK' if not failures else 'FAILED: ' + '; '.join(failures)}")
    return 0 if not failures else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(_run_selftest())
    print("usage: python -m dsh_physical.dxgi_capture --selftest")
    raise SystemExit(2)
