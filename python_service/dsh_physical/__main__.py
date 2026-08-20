"""D-5 物理执行微服务入口 —— ``python -m dsh_physical``。

直接调用 ``server.run()``；所有加载期异常会被 Python 默认 traceback 打印后退出（exit code 1）。
"""
from .server import run

if __name__ == "__main__":
    run()
