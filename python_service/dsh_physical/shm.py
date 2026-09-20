"""POSIX 共享内存零拷贝截图通道 —— Step 1 §③ 世界级创新方案。

传输链：
  1. Python 截屏 → PNG/JPEG 字节
  2. ``shm_open`` / 临时文件 mmap 创建共享通道
  3. ``ftruncate`` 预留大小 + ``mmap`` 映射 + 写入
  4. HTTP 响应只回元数据（name / size / shape），零字节传输
  5. Node 端按 name reopen / 直接读文件 → Buffer
  6. ``DELETE /v1/shm/<name>`` 显式释放；TTL 60s GC + 进程退出兜底

降级路径（J 纪元修正优先级歧义）：
  - 显式 ``base64`` → HTTP 内联（仅诊断）
  - ``shm`` 且 POSIX 可用 → shm_open
  - ``shm`` 但 POSIX 不可用（Windows）→ **mmap-file**（旧实现因
    ``or/and`` 优先级错误静默跌落 base64，与文档相反）
  - ``mmap-file`` → 临时文件

生命周期（J 纪元修正）：
  - 旧实现在 ``make_handle`` 上挂 ``weakref.finalize`` —— routes 层的
    handle 是局部变量，CPython 引用计数下 finalizer 在响应序列化前后
    即触发 munmap/unlink，Node 端 reopen 必然 ENOENT（shm 模式实际不可用）。
  - 现在：**注册表 ``_active_handles`` 是唯一持有者与唯一生命周期**；
    释放 = 显式 DELETE / TTL GC / lifespan cleanup 三道兜底。
  - 注册表键与 ``ShmHandle.name`` 严格一致（mmap-file 模式即文件全路径），
    DELETE 端点按 handle.name 释放永不 miss。
"""
from __future__ import annotations

import io
import os
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .config import ScreenshotConfig
from .errors import ErrorKind, PhysicalError

# POSIX shm 仅在 Linux/macOS 可用；Windows 走 mmap-file 降级
_HAS_POSIX_SHM = sys.platform in ("linux", "darwin") and hasattr(os, "shm_open")

ShmTransport = Literal["shm", "mmap-file", "base64"]


@dataclass
class ShmHandle:
    """跨进程图像引用 —— 仅含元数据，零字节图像传输。"""

    transport: ShmTransport
    name: str               # shm 对象名 / mmap 文件路径 / 空（base64 模式）
    size: int                # 字节总数
    shape: tuple[int, int, int]  # (height, width, channels)
    dtype: str               # 'uint8' 等 numpy dtype 字符串
    stride: int              # 行字节数
    format: str              # 'BGRA' / 'RGB' / 'JPEG' / 'PNG'
    width: int
    height: int
    captured_at: int         # unix ms
    # 仅 base64 模式使用：直接内联图像字节
    base64_data: str = ""


# ─── 注册表：活跃的 shm 对象（用于 DELETE 端点 + 启动期清理）───
# 名字 → (fd 或文件路径, mmap 对象, 过期时间)
# 注意：fd 关闭后 mmap 仍可读；此处仅保留 mmap 与路径以便释放
_active_handles: dict[str, dict] = {}


def _gc_expired_handles() -> None:
    """过期 shm 对象懒 GC（默认 60s 兜底回收，防 Node 端崩溃泄漏）。"""
    import time

    now = time.time()
    expired = [name for name, info in _active_handles.items() if info.get("expires_at", 0) < now]
    for name in expired:
        _release_handle(name)


def _release_handle(name: str) -> None:
    """释放 shm 对象（munmap + shm_unlink 或删文件）。永不抛错。"""
    info = _active_handles.pop(name, None)
    if info is None:
        return
    # 先 munmap（解除映射）
    mmap_obj = info.get("mmap")
    if mmap_obj is not None:
        try:
            mmap_obj.close()
        except OSError:
            pass
    # 再 shm_unlink（POSIX）或删文件（mmap-file）
    transport = info.get("transport", "shm")
    if transport == "shm" and hasattr(os, "shm_unlink"):
        try:
            os.shm_unlink(info.get("shm_name", ""))
        except OSError:
            pass  # 已被回收是正常路径
    elif transport == "mmap-file":
        path = info.get("path", "")
        try:
            os.unlink(path)
        except OSError:
            pass


def release_by_name(name: str) -> bool:
    """Node 端 DELETE /v1/shm/<name> 调用：显式释放。返回是否命中。

    顺手做一次懒 GC（旧实现只在 write_image 入口 GC —— 长时间不截图时
    过期 handle 的 mmap 内存/文件会驻留到下一次截图或进程退出）。
    """
    _gc_expired_handles()
    if name in _active_handles:
        _release_handle(name)
        return True
    return False


def cleanup_all() -> None:
    """服务退出时清理所有活跃 handle。"""
    for name in list(_active_handles.keys()):
        _release_handle(name)


# ─── 公开 API ───


def write_image(
    image_bytes: bytes,
    width: int,
    height: int,
    *,
    format: str = "PNG",
    config: ScreenshotConfig,
    ttl_seconds: int = 60,
) -> ShmHandle:
    """把图像字节写入共享内存通道。

    根据 ``config.transport`` 自动选择 shm / mmap-file / base64。

    异常诚实：失败 ``raise PhysicalError``，由 ``safe_call`` 转为失败响应。
    """
    import time

    _gc_expired_handles()
    captured_at = int(time.time() * 1000)
    size = len(image_bytes)

    # J 纪元修正：显式级联取代旧的单行 or/and（Python 的 and 优先级高于 or，
    # 旧式 ``a or not p and b`` 在 Windows 强制 shm 时会静默跌落 base64
    # 而非文档承诺的 mmap-file）。
    if config.transport == "base64":
        # base64 模式：直接内联（降级路径，仅诊断使用）
        import base64

        return ShmHandle(
            transport="base64",
            name="",
            size=size,
            shape=(height, width, 3),
            dtype="uint8",
            stride=0,
            format=format,
            width=width,
            height=height,
            captured_at=captured_at,
            base64_data=base64.b64encode(image_bytes).decode("ascii"),
        )

    name = f"{config.shm_prefix}{uuid.uuid4().hex}"
    expires_at = time.time() + ttl_seconds

    if config.transport == "shm" and _HAS_POSIX_SHM:
        return _write_via_posix_shm(
            name, image_bytes, width, height, format, size, captured_at, expires_at, config
        )
    # shm 但 POSIX 不可用 → mmap-file 降级；mmap-file 显式直达
    return _write_via_mmap_file(
        name, image_bytes, width, height, format, size, captured_at, expires_at, config
    )


def _write_via_posix_shm(
    name: str,
    image_bytes: bytes,
    width: int,
    height: int,
    format: str,
    size: int,
    captured_at: int,
    expires_at: float,
    config: ScreenshotConfig,
) -> ShmHandle:
    """POSIX ``shm_open`` 路径。

    铁律：``shm_unlink`` 在 ``shm_open`` 后立即调用 → 对象随所有 fd 关闭自动回收。
    Python 端先 mmap + memcpy + close(fd)；Node 端 ``shm_open`` 同名 → 拿到自己的 fd。
    Python 端 munmap 时数据仍在内核页缓存；Node 端 munmap 后才回收。
    """
    import mmap

    shm_name = "/" + name.lstrip("/")  # POSIX shm 名以 / 开头
    try:
        fd = os.shm_open(shm_name, os.O_CREAT | os.O_RDWR, 0o600)
    except OSError as e:
        # shm_open 失败 → 降级到 mmap-file
        return _write_via_mmap_file(
            name, image_bytes, width, height, format, size, captured_at, expires_at, config
        )

    # J 纪元修正：旧实现 except 关一次 fd、finally 再关一次（double-close，
    # fd 号被复用时可能误伤无关句柄）；且失败路径遗留已 ftruncate 的 shm 对象。
    # 现在单一出口：失败路径关 fd + shm_unlink 回收，成功路径仅关 fd（mmap 持引用）。
    mm = None
    try:
        os.ftruncate(fd, size)
        mm = mmap.mmap(fd, size, access=mmap.ACCESS_WRITE)
        mm[:size] = image_bytes
    except OSError as e:
        if mm is not None:
            try:
                mm.close()
            except OSError:
                pass
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.shm_unlink(shm_name)
        except OSError:
            pass
        raise PhysicalError(
            ErrorKind.SCREEN_CAPTURE_FAILED,
            f"shm mmap failed: {e}",
        ) from e
    else:
        # 关闭 fd（mmap 仍持有引用；Node 端拿自己的 fd）
        try:
            os.close(fd)
        except OSError:
            pass

    # 注意：此处**不**立即 shm_unlink —— POSIX 语义是 unlink 后名字消失，
    # Node 端 ``shm_open`` 同名将无法命中此对象（只能创建新对象）。
    # unlink 推迟到 ``_release_handle``（DELETE 端点或 TTL GC 触发），
    # 保证 Node 端在拿到元数据后能正常 reopen。
    # 防泄漏由三道兜底：
    #   1. Node 端调用 DELETE /v1/shm/<name> → _release_handle → munmap + shm_unlink
    #   2. TTL 60s 过期 GC → _release_handle
    #   3. 进程退出 → lifespan cleanup_all + 内核回收

    # 注册到活跃表（键 = handle.name，DELETE 端点按名释放永不 miss）
    _active_handles[name] = {
        "transport": "shm",
        "shm_name": shm_name,
        "mmap": mm,
        "expires_at": expires_at,
    }

    return ShmHandle(
        transport="shm",
        name=name,
        size=size,
        shape=(height, width, 3),
        dtype="uint8",
        stride=width * 3 if format in ("RGB", "BGR") else size // height,
        format=format,
        width=width,
        height=height,
        captured_at=captured_at,
    )


def _write_via_mmap_file(
    name: str,
    image_bytes: bytes,
    width: int,
    height: int,
    format: str,
    size: int,
    captured_at: int,
    expires_at: float,
    config: ScreenshotConfig,
) -> ShmHandle:
    """mmap 临时文件路径（Windows 兼容 / shm_open 失败时降级）。

    文件写入后立即 unlink（POSIX）或保留（Win，DELETE 端点清理）。
    Node 端通过文件路径直接 ``mmap`` 读。
    """
    import mmap

    Path(config.mmap_dir).mkdir(parents=True, exist_ok=True)
    file_path = str(Path(config.mmap_dir) / f"{name}.bin")

    try:
        fd = os.open(file_path, os.O_CREAT | os.O_RDWR, 0o600)
    except OSError as e:
        raise PhysicalError(
            ErrorKind.SCREEN_CAPTURE_FAILED,
            f"mmap-file open failed: {e}",
        ) from e

    # J 纪元修正：同 _write_via_posix_shm —— 单一出口，失败路径关 fd + 删半成品文件。
    mm = None
    try:
        os.ftruncate(fd, size)
        mm = mmap.mmap(fd, size, access=mmap.ACCESS_WRITE)
        mm[:size] = image_bytes
    except OSError as e:
        if mm is not None:
            try:
                mm.close()
            except OSError:
                pass
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.unlink(file_path)
        except OSError:
            pass
        raise PhysicalError(
            ErrorKind.SCREEN_CAPTURE_FAILED,
            f"mmap-file write failed: {e}",
        ) from e
    else:
        try:
            os.close(fd)
        except OSError:
            pass

    # 注意：此处**不**立即 unlink —— 立即 unlink 会让 Node 端 ``fs.open(path)``
    # 失败（ENOENT）。unlink 推迟到 ``_release_handle``（DELETE 端点或 TTL GC）。

    # J 纪元修正：注册键 = 文件全路径（与 ShmHandle.name 严格一致）。
    # 旧实现注册短名而 handle.name 是全路径 —— Node 端 DELETE /v1/shm/<path>
    # 永恒 miss（released:false），清理只能靠 TTL 兜底。
    _active_handles[file_path] = {
        "transport": "mmap-file",
        "path": file_path,
        "mmap": mm,
        "expires_at": expires_at,
    }

    return ShmHandle(
        transport="mmap-file",
        name=file_path,  # Node 端通过文件路径读
        size=size,
        shape=(height, width, 3),
        dtype="uint8",
        stride=width * 3 if format in ("RGB", "BGR") else size // height,
        format=format,
        width=width,
        height=height,
        captured_at=captured_at,
    )


# ─── weakref 兜底：ShmHandle 被回收时尝试释放 ───

def make_handle(image_bytes: bytes, width: int, height: int, format: str, config: ScreenshotConfig) -> ShmHandle:
    """工厂方法：写图像并登记注册表。

    J 纪元修正：移除旧实现的 ``weakref.finalize`` —— handle 是 routes 层的
    局部变量，CPython 引用计数下 finalizer 在响应序列化前后即触发
    munmap/unlink，Node 端 reopen 必然 ENOENT（shm 模式实际不可用）。
    生命周期唯一事实源 = ``_active_handles`` 注册表：
    DELETE 端点 / TTL 60s GC / lifespan cleanup 三道兜底，永不依赖 GC 时机。
    """
    return write_image(image_bytes, width, height, format=format, config=config)
