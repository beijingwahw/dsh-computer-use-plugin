#!/usr/bin/env python3
"""#11（O 纪元）：DSH_PHYSICAL_PID_WHITELIST 一次性部署助手。

用法：
  python scripts/compute_pid_whitelist.py                # Linux：哈希 /proc/self/exe（即本 Python）
  python scripts/compute_pid_whitelist.py --pid 1234     # Linux：哈希 /proc/1234/exe（如 DSH 宿主 node）
  python scripts/compute_pid_whitelist.py --path C:/node/node.exe  # 任意平台：哈希指定二进制

输出：即贴即用的环境变量行（多值逗号连接 —— auth.py 的 _load_pid_whitelist 方言）。
部署律：白名单非空即严格模式 —— 所有可合法访问物理服务的二进制都要列全
（DSH 宿主 node.exe + 任何经授权的 CLI），漏一个 = 该调用方全被拒。
Windows 注记：attest_pid 在非 Linux 恒 True（无 /proc）—— 本脚本在 Windows
算出的值供 Linux 部署机预热或跨机同版本二进制复用。
"""
import argparse
import hashlib
import os
import sys


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description="compute DSH_PHYSICAL_PID_WHITELIST entries")
    ap.add_argument("--pid", type=int, help="Linux: hash /proc/<pid>/exe (e.g. the DSH host node process)")
    ap.add_argument("--path", help="any platform: hash an explicit binary path (e.g. node.exe)")
    args = ap.parse_args()

    if args.path:
        target = args.path
    elif args.pid is not None and sys.platform == "linux":
        target = os.readlink(f"/proc/{args.pid}/exe")
    elif sys.platform == "linux":
        target = "/proc/self/exe"
    else:
        print("error: non-Linux requires --path (no /proc to resolve a pid)", file=sys.stderr)
        return 1

    digest = sha256_of(target)
    print(f"# target: {target}")
    print(f"export DSH_PHYSICAL_PID_WHITELIST=\"${{DSH_PHYSICAL_PID_WHITELIST:+$DSH_PHYSICAL_PID_WHITELIST,}}{digest}\"")
    print(f'# (powershell) $env:DSH_PHYSICAL_PID_WHITELIST = ("{0},{1}" -f $env:DSH_PHYSICAL_PID_WHITELIST, "{digest}").Trim(\',\')')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
