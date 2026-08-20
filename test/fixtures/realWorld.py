#!/usr/bin/env python3
"""真实世界：Record Cleaner（D-7 真机基准的世界真相持有者）。

与 stub 世界（ablation.bench.ts）同构：
  - 'delete item' 按钮 = 陷阱（点击真实发生，但按钮是坏的 —— 应用状态记 trap click）
  - 'clear log'  按钮 = 活路（点击 ⇒ 记录清理完成，任务达成）

世界真相 = 状态文件（原子写）：执行端口读它裁决成败，绝无 mock hitElement。
用法：DISPLAY=:99 python3 realWorld.py /tmp/d7-realworld/state.json
"""
import json
import os
import signal
import sys
import tkinter as tk

STATE_PATH = sys.argv[1] if len(sys.argv) > 1 else '/tmp/d7-realworld/state.json'
WIDTH, HEIGHT = 800, 600

state = {"clicks": [], "done": False, "started": True}


def persist():
    """原子写（tmp + rename）—— 世界真相落盘，读方永远看到一致快照。"""
    tmp = STATE_PATH + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(state, f)
    os.replace(tmp, STATE_PATH)


def on_trap():
    # 陷阱按钮：点击真实到达，但按钮坏了 —— 记录一次失败尝试（世界不撒谎）
    state["clicks"].append({"button": "delete item"})
    persist()


def on_safe():
    # 活路按钮：记录清理完成 —— 任务达成
    state["clicks"].append({"button": "clear log"})
    state["done"] = True
    persist()
    root.quit()


root = tk.Tk()
root.title("Record Cleaner")
root.geometry(f"{WIDTH}x{HEIGHT}+0+0")
root.resizable(False, False)

# 标题与基准 intent 词（delete/record/clear/log）零重合 —— 世界难度结构对齐 stub 基准
tk.Label(root, text="Cleanup Utility", font=("DejaVu Sans", 20, "bold")).place(x=300, y=60)

# 陷阱按钮（左上偏中 —— 与 stub 世界 ELEMENTS 同构；浅底深字 = OCR 友好）
tk.Button(
    root, text="delete item", font=("DejaVu Sans", 16, "bold"),
    bg="#f5c6c6", fg="#000000", width=14, height=2, command=on_trap,
).place(x=200, y=180)

# 活路按钮（右下 —— 与 stub 世界 ELEMENTS 同构）
tk.Button(
    root, text="clear log", font=("DejaVu Sans", 16, "bold"),
    bg="#c8e6c9", fg="#000000", width=14, height=2, command=on_safe,
).place(x=480, y=420)


def shutdown(signum, frame):
    persist()
    sys.exit(0)


signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)

persist()
root.mainloop()
persist()
