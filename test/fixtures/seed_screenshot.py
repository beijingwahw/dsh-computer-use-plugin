"""集成测试 fixture：用 dsh_physical.shm 写入已知测试图像，并保持进程存活供 Node 端读取。

用法：
  python3 seed_screenshot.py <transport> <mmap_dir>
  -> stdout 输出一行 JSON 元数据（ScreenshotResult 结构）
  -> 阻塞等待 stdin 关闭（Node 端读完 + release 后会关闭 stdin 触发退出）

设计意图：
  绕开 pyautogui（无 X 环境），直接用 dsh_physical.shm.write_image 写入一张
  确定性测试图像（128x128 RGB，左上红块、右下蓝块、其余黑），让 Node 端能验证：
    1. readShm 读出的字节与原始 PNG 一致
    2. ScreenshotHandle 的 read/transfer/release 生命周期正确
    3. 跨进程 mmap-file 传输正确（Python 写 → Node 读）
"""
from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path

# 让 dsh_physical 包可被 import（添加 python_service 到 sys.path）
HERE = Path(__file__).resolve().parent
SERVICE_ROOT = HERE.parent.parent / "python_service"
sys.path.insert(0, str(SERVICE_ROOT))

from dsh_physical.config import ScreenshotConfig  # noqa: E402
from dsh_physical.shm import write_image, release_by_name, _active_handles  # noqa: E402


def make_test_image() -> tuple[bytes, int, int]:
    """生成 128x128 RGB PNG：左上 64x64 红块、右下 64x64 蓝块、其余黑。"""
    import numpy as np
    from PIL import Image

    w, h = 128, 128
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    # 左上红块
    arr[0:64, 0:64] = [255, 0, 0]
    # 右下蓝块
    arr[64:128, 64:128] = [0, 0, 255]

    img = Image.fromarray(arr, mode="RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue(), w, h


def main() -> None:
    transport = sys.argv[1] if len(sys.argv) > 1 else "mmap-file"
    mmap_dir = sys.argv[2] if len(sys.argv) > 2 else "/tmp/dsh-test-shots"
    os.makedirs(mmap_dir, exist_ok=True)

    config = ScreenshotConfig(
        transport=transport,  # type: ignore[arg-type]
        shm_prefix="dsh-test-",
        mmap_dir=mmap_dir,
        jpeg_quality=85,
    )

    image_bytes, w, h = make_test_image()
    handle = write_image(
        image_bytes,
        w,
        h,
        format="PNG",
        config=config,
        ttl_seconds=120,  # 给 Node 端 2 分钟读取窗口
    )

    meta = {
        "transport": handle.transport,
        "name": handle.name,
        "size": handle.size,
        "shape": list(handle.shape),
        "dtype": handle.dtype,
        "stride": handle.stride,
        "format": handle.format,
        "width": handle.width,
        "height": handle.height,
        "captured_at": handle.captured_at,
        "image_base64": handle.base64_data if handle.transport == "base64" else "",
        # 测试辅助：原始字节长度（Node 端校验用）
        "_expected_size": len(image_bytes),
    }
    # stdout 单行 JSON
    sys.stdout.write(json.dumps(meta) + "\n")
    sys.stdout.flush()

    # 阻塞等待 stdin 关闭 —— Node 端测试结束后关闭子进程 stdin 触发退出
    # 期间 Python 进程保持存活，mmap 对象不释放，Node 端能正常读
    try:
        sys.stdin.read()
    except (KeyboardInterrupt, OSError):
        pass

    # 退出前释放（如果 Node 端没调 release 的话）
    if handle.name:
        release_by_name(handle.name)


if __name__ == "__main__":
    main()
