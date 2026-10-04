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

磁盘治理（ΑΩ-R26，仅 mmap-file —— POSIX shm 无磁盘占用）：
  - 磁盘配额 ``mmap_quota_mb``（缺省 512MB，``DSH_PHYSICAL_MMAP_QUOTA_MB``
    可调，0 = 关闭）：注册新 handle 时检查，超限先 oldest-first 回收过期
    handle 并清过期孤儿，仍超则 stderr 诚实上报（活跃 handle 不硬删）。
  - 启动清扫：首次 mmap-file 写入时懒触发（亦可 lifespan 显式调用
    ``startup_sweep``），清除超过 TTL 且不在注册表中的孤儿文件 ——
    防上次运行崩溃遗留文件在长时间空闲下驻留。
  - 运行中合计 + 每 60s 轻量目录盘点校准（``_inventory_mmap_dir``），
    unlink 失败（Windows 句柄占用）不炸、只记账，由下次盘点自愈。
"""
from __future__ import annotations

import io
import os
import sys
import threading
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

# ─── ΑΩ-R26：mmap-file 磁盘治理（配额 + 孤儿清扫）───
# POSIX shm 由内核随 fd 关闭回收，无磁盘驻留问题；本节只针对 mmap-file。
# 运行中合计（``mmap_bytes``）是快速路径的账面值；每 60s 一次轻量目录盘点
# （scandir + stat）校准漂移（unlink 失败 / 目录被外部改动），并顺手清过期孤儿。
_quota_lock = threading.RLock()  # RLock：_enforce 持锁调用 _release_handle 时可重入
_INVENTORY_INTERVAL_S = 60.0  # 盘点节流：注册新 handle 时至多触发一次 scandir
_TTL_FALLBACK_S = 60.0        # 孤儿判定 TTL，与 write_image ttl_seconds 缺省对齐
_quota_stats = {
    "mmap_bytes": 0,             # mmap-file 运行中字节合计（盘点校准）
    "last_inventory_at": 0.0,    # 上次目录盘点时刻（unix 秒）
    "startup_swept": False,      # 启动清扫是否已做（每进程一次）
    "orphans_removed": 0,        # 孤儿文件清除成功计数
    "orphan_remove_failed": 0,   # 清除失败计数（防御式：不炸，只记账）
    "quota_reclaims": 0,         # 配额触发的过期 handle 回收次数
    "quota_reclaimed_bytes": 0,  # 对应回收字节数
}


def _iter_own_mmap_files(config: ScreenshotConfig):
    """枚举 mmap 目录中**本服务命名模式**的文件（prefix*.bin）。

    防御边界：mmap_dir 可由用户配置指向共享目录 —— 绝不碰非本模式文件。
    生成 (绝对路径, st_mtime, st_size)；stat 失败的条目跳过（不炸）。
    """
    root = Path(config.mmap_dir)
    try:
        entries = list(os.scandir(root))
    except OSError:
        return
    for entry in entries:
        if not entry.name.startswith(config.shm_prefix) or not entry.name.endswith(".bin"):
            continue
        try:
            if not entry.is_file():
                continue
            st = entry.stat()
        except OSError:
            continue  # 条目消失/无权限：跳过（盘点永不抛错）
        yield str(root / entry.name), st.st_mtime, st.st_size


def _remove_orphan(path: str) -> bool:
    """删除一个孤儿文件。成功返回 True；失败计数不炸（ΑΩ-R26 防御式）。"""
    try:
        os.unlink(path)
        _quota_stats["orphans_removed"] += 1
        return True
    except OSError:
        # Windows：Node 端仍握着句柄时 unlink 报 PermissionError ——
        # 记账留给下一次盘点/清扫，绝不炸穿运行层
        _quota_stats["orphan_remove_failed"] += 1
        return False


def startup_sweep(config: ScreenshotConfig, ttl_seconds: float = _TTL_FALLBACK_S) -> None:
    """启动清扫：清除 mmap 目录中的孤儿文件（ΑΩ-R26）。

    孤儿 = 不在 ``_active_handles`` 注册表中且 mtime 超过 TTL 的本模式文件
    （上次运行崩溃遗留 —— 进程内注册表为空，TTL 兜底防误删并发实例的活跃文件）。
    每进程只做一次（幂等旗标）；由首次 mmap-file 写入懒触发（server lifespan
    未接线时依然生效），也可由 lifespan 显式调用。永不抛错。
    """
    with _quota_lock:
        if _quota_stats["startup_swept"]:
            return
        _quota_stats["startup_swept"] = True
    import time

    now = time.time()
    removed = failed = 0
    for path, mtime, _size in _iter_own_mmap_files(config):
        if path in _active_handles or now - mtime <= ttl_seconds:
            continue
        if _remove_orphan(path):
            removed += 1
        else:
            failed += 1
    if removed or failed:
        print(
            f"[dsh-physical] shm startup sweep ({config.mmap_dir}): "
            f"removed {removed} orphan(s), failed {failed} (ΑΩ-R26)",
            file=sys.stderr,
        )


def _inventory_mmap_dir(config: ScreenshotConfig, now: float) -> None:
    """轻量盘点：scandir 校准运行合计 + 顺手清过期孤儿（ΑΩ-R26）。

    以目录实况为准重置 ``mmap_bytes``（注册表内文件按 st_size 计入 ——
    与账面一致；unlink 失败的已释放文件也会被如实计回，等待下次过期清除）。
    调用方持锁或接受统计竞态（盘点本身永不抛错，漂移由下次盘点自愈）。
    """
    total = 0
    for path, mtime, size in _iter_own_mmap_files(config):
        total += size
        # 短路序：先判孤儿（不在注册表 + 超 TTL），再尝试删除（成功才从合计扣除）
        if (
            path not in _active_handles
            and now - mtime > _TTL_FALLBACK_S
            and _remove_orphan(path)
        ):
            total -= size
    _quota_stats["mmap_bytes"] = total
    _quota_stats["last_inventory_at"] = now


def _enforce_mmap_quota(config: ScreenshotConfig) -> None:
    """注册新 mmap-file handle 后的配额检查（ΑΩ-R26）。

    三步，全部运行层（永不抛错）：
      1. 盘点节流窗口到点 → 轻量盘点校准合计并清过期孤儿；
      2. 超配额 → oldest-first 兜底回收**已过期** handle（``write_image`` 入口
         GC 通常已抢先，此处防御性兜底 —— 配额路径不依赖上游 GC 时机）；
         活跃 handle 在 TTL 内不硬删 —— Node 端可能正在读，硬删 = ENOENT 破坏契约；
      3. 仍超 → stderr 诚实上报（配额、当前占用、活跃数）。
    """
    quota = getattr(config, "mmap_quota_mb", 512) * 1024 * 1024
    if quota <= 0:
        return  # 0 = 显式关闭配额
    import time

    now = time.time()
    with _quota_lock:
        inventoried = False
        if now - _quota_stats["last_inventory_at"] >= _INVENTORY_INTERVAL_S:
            _inventory_mmap_dir(config, now)
            inventoried = True
        if _quota_stats["mmap_bytes"] <= quota:
            return
        before = _quota_stats["mmap_bytes"]
        expired = sorted(
            (info.get("expires_at", 0), name)
            for name, info in _active_handles.items()
            if info.get("transport") == "mmap-file" and info.get("expires_at", 0) < now
        )
        for _expires_at, name in expired:
            _quota_stats["quota_reclaims"] += 1
            _release_handle(name)  # 内部同步扣减 mmap_bytes
        if not inventoried:
            _inventory_mmap_dir(config, now)  # 释放后仍超 → 盘点兜底清过期孤儿
        freed = max(0, before - _quota_stats["mmap_bytes"])
        _quota_stats["quota_reclaimed_bytes"] += freed
        if _quota_stats["mmap_bytes"] > quota:
            live = sum(
                1
                for info in _active_handles.values()
                if info.get("transport") == "mmap-file"
            )
            print(
                f"[warn] shm mmap-file quota {quota // (1024 * 1024)}MB exceeded: "
                f"{_quota_stats['mmap_bytes'] / (1024 * 1024):.1f}MB on disk, "
                f"{live} live handle(s) within TTL not evicted (ΑΩ-R26)",
                file=sys.stderr,
            )
        else:
            print(
                f"[dsh-physical] shm quota reclaim: {len(expired)} expired handle(s), "
                f"{freed / (1024 * 1024):.1f}MB freed, now "
                f"{_quota_stats['mmap_bytes'] / (1024 * 1024):.1f}MB (ΑΩ-R26)",
                file=sys.stderr,
            )


def get_stats() -> dict:
    """治理状态快照（ΑΩ-R26，测试/诊断用）。返回浅拷贝防外部篡改。"""
    with _quota_lock:
        return dict(_quota_stats)


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
        except (OSError, BufferError):
            # BufferError：仍有导出缓冲视图 —— 无法立即解除映射，
            # 进程退出兜底；不得炸穿“永不抛错”契约（否则 cleanup_all
            # 中断，后续 handle 全部泄漏）
            pass
    # 再 shm_unlink（POSIX）或删文件（mmap-file）
    transport = info.get("transport", "shm")
    unlinked = False
    if transport == "shm" and hasattr(os, "shm_unlink"):
        try:
            os.shm_unlink(info.get("shm_name", ""))
            unlinked = True
        except OSError:
            pass  # 已被回收是正常路径
    elif transport == "mmap-file":
        path = info.get("path", "")
        try:
            os.unlink(path)
            unlinked = True
        except OSError:
            pass
    # ΑΩ-R26：文件确认删除后才扣减磁盘账面（unlink 失败 —— 如 Windows 上
    # Node 仍持句柄 —— 磁盘并未真正释放，扣了就是撒谎；残留文件由盘点按孤儿收）。
    if transport == "mmap-file" and unlinked:
        with _quota_lock:
            _quota_stats["mmap_bytes"] = max(0, _quota_stats["mmap_bytes"] - info.get("size", 0))


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
        "size": size,  # ΑΩ-R26：配额账面用（shm 传输无磁盘占用，不计数）
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
    # ΑΩ-R26：本进程首次 mmap-file 写入 → 懒启动清扫（清上次运行崩溃遗留的
    # 孤儿文件；server lifespan 未显式接线时依然生效，接线后因幂等旗标为 no-op）
    startup_sweep(config)
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
        "size": size,
    }
    # ΑΩ-R26：磁盘账面 + 配额检查（新 handle 已计入后检查 —— 新来者自身
    # 也受配额约束；超限时先回收过期 handle，活跃 handle 不硬删，stderr 诚实上报）
    with _quota_lock:
        _quota_stats["mmap_bytes"] += size
    _enforce_mmap_quota(config)

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
