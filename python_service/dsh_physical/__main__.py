"""D-5 物理执行微服务入口 —— ``python -m dsh_physical``。

直接调用 ``server.run()``；所有加载期异常会被 Python 默认 traceback 打印后退出（exit code 1）。
"""
from .server import run


def main() -> None:
    """pip 命令入口（ΝΩ-9）：pyproject ``[project.scripts]`` 的
    ``dsh-physical = "dsh_physical.__main__:main"`` 指向本函数 —— 此前本模块
    并无 ``main``，pip 安装后命令 100% AttributeError。补薄委托（而非改
    入口指向 ``:run``），保持 scripts 描述与既有安装兼容。"""
    run()


if __name__ == "__main__":
    main()
