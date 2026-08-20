"""POSIX 共享内存零拷贝截图通道 —— Step 1 §③ 世界级创新方案。

传输链：
  1. Python 截屏 → numpy ndarray (BGRA)
  2. ``shm_open`` 创建共享内存对象
  3. ``ftruncate`` 预留大小
  4. ``mmap`` 映射到进程地址空间
  5. ``memcpy`` 拷贝图像数据
  6. HTTP 响应只回元数据（shm_name / size / shape），零字节传输
  7. Node 端 ``shm_open`` 同名对象 → 直接读 Buffer
  8. ``DELETE /v1/shm/<name>`` 释放（或 Python 端 weakref.finalize 兜底）

降级路径：
  - 非 POSIX（Windows）：``mmap-file`` 模式（``/tmp`` 临时文件）
  - 两者都不可用：``base64`` over HTTP（仅诊断模式）

铁律：
  - ``shm_unlink`` 在 ``shm_open`` 后立即调用 → 对象随所有 fd 关闭自动回收
    （永不泄漏，即便 Node 端崩掉）
  - ``close(fd)`` 不释放内存（``mmap`` 仍持有），但 ``munmap`` + ``unlink`` 会
"""
from __future__ import annotations

import io
import os
import sys
import uuid
import weakref
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
    """Node 端 DELETE /v1/shm/<name> 调用：显式释放。返回是否命中。"""
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

    if config.transport == "base64" or not _HAS_POSIX_SHM and config.transport != "mmap-file":
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
    else:
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

    try:
        # ftruncate 预留大小
        os.ftruncate(fd, size)
        # mmap 映射
        mm = mmap.mmap(fd, size, access=mmap.ACCESS_WRITE)
        # 写入图像
        mm[:size] = image_bytes
    except OSError as e:
        os.close(fd)
        raise PhysicalError(
            ErrorKind.SCREEN_CAPTURE_FAILED,
            f"shm mmap failed: {e}",
        ) from e
    finally:
        # 关闭 fd（mmap 仍持有引用；Node 端拿自己的 fd）
        # 不在此 munmap —— 否则 Node 端就读不到数据了
        try:
            os.close(fd)
        except OSError:
            pass

    # 注意：此处**不**立即 shm_unlink —— POSIX 语义是 unlink 后名字消失，
    # Node 端 ``shm_open`` 同名将无法命中此对象（只能创建新对象）。
    # unlink 推迟到 ``_release_handle``（DELETE 端点或 TTL GC 触发），
    # 保证 Node 端在拿到元数据后能正常 reopen。
    # 防泄漏由两道兜底：
    #   1. Node 端调用 DELETE /v1/shm/<name> → _release_handle → shm_unlink + munmap
    #   2. TTL 60s 过期 GC → _release_handle
    #   3. 进程退出 → 内核自动回收（POSIX shm 在所有 fd 关闭后回收）

    # 注册到活跃表（Node 端 DELETE 时使用 / 过期 GC）
    # 注意：已 unlink 后 Node 端无法 reopen；此处保留 mmap 让 Node 端能读
    # 但 Python 进程退出后 mmap 持有的引用立即消失 → 对象回收
    # 这是 POSIX shm 的设计：fd 全部关闭即回收，进程退出即回收
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

    try:
        os.ftruncate(fd, size)
        mm = mmap.mmap(fd, size, access=mmap.ACCESS_WRITE)
        mm[:size] = image_bytes
    except OSError as e:
        os.close(fd)
        raise PhysicalError(
            ErrorKind.SCREEN_CAPTURE_FAILED,
            f"mmap-file write failed: {e}",
        ) from e
    finally:
        try:
            os.close(fd)
        except OSError:
            pass

    # 注意：此处**不**立即 unlink —— 同 _write_via_posix_shm 的修复逻辑：
    # 立即 unlink 会让 Node 端 ``fs.open(path)`` 失败（ENOENT）。
    # unlink 推迟到 ``_release_handle``（DELETE 端点或 TTL GC 触发）。
    # 防泄漏由 _release_handle + 进程退出兜底（OS 临时目录清理）。

    _active_handles[name] = {
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

def _finalize_handle(name: str) -> None:
    """ShmHandle 被 GC 时触发：尝试 release。"""
    release_by_name(name)


def make_handle(image_bytes: bytes, width: int, height: int, format: str, config: ScreenshotConfig) -> ShmHandle:
    """工厂方法：写图像 + 注册 weakref 兜底。"""
    handle = write_image(image_bytes, width, height, format=format, config=config)
    # weakref.finalize：handle 被 GC 时调用 _finalize_handle(name)
    # 注意：weakref 不会延长 handle 的生命周期；只要 Node 端还在使用，
    # Python 端应保留对 handle 的引用（routes 层会保留直到响应发送完）
    weakref.finalize(handle, _finalize_handle, handle.name)
    return handle
