#!/usr/bin/env python3
"""复杂世界（Windows）：Data Console —— 大规模真机验证的世界真相持有者。

与 realWorldWin.py（双按钮世界）同律，但把世界复杂度拉到真实 UI 密度：
  - 5 页左导航（files / network / reports / settings / archive）—— 任务多为
    「先导航后操作」的多步链
  - 每页 6 个内容控件（安全按钮 / 陷阱按钮 / 开关三族）+ 5 个导航 + 标题
    —— 每屏 12+ 可见文本元素，OCR 感知与词法匹配都有真实干扰
  - 陷阱族（词法强吸引的坏按钮 + 词法弱吸引的活路）分布在 archive /
    network / files 三页 —— 免疫系统（知识压制 + 前额叶改道）的考场
  - 世界真相 = 状态文件原子写（事件序号 / 页面 / 开关 / 陷阱标记）

OCR 工程纪律（真机教训）：按钮一律 FLAT 无边框 + 高对比配色（边框会读出
'|'']' 噪声字形并粘连词尾）；列间留 ≥80px 空隙 + 行交错（词级分组的
x-间隙判据天然分离跨列同基线词）。

用法：python complexWorldWin.py <state.json>
"""
import json
import os
import sys
import time
import tkinter as tk

STATE_PATH = sys.argv[1] if len(sys.argv) > 1 else 'complex-world-win/state.json'
WIDTH, HEIGHT = 800, 600

# DPI 感知（Windows）：物理像素 = 逻辑像素（与 realWorldWin.py 同律）
if sys.platform == 'win32':
    try:
        import ctypes
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

state = {"started": True, "page": "files", "events": [], "toggles": {}, "seq": 0,
         "entries": {}, "focus": None}


def persist():
    """原子写（tmp + rename）—— 世界真相落盘，读方永远看到一致快照。"""
    tmp = STATE_PATH + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(state, f)
    os.replace(tmp, STATE_PATH)


def record(widget, trap=False):
    state["seq"] += 1
    state["events"].append({
        "seq": state["seq"], "widget": widget, "page": state["page"],
        "trap": trap, "at": int(time.time() * 1000),
    })
    persist()


# 页面内容定义：槽位 (slot, kind, label) —— kind ∈ {'btn','trap','toggle'}
# 槽位坐标交错（colA/colB 垂直错开）—— 同排无两控件，OCR 词级分组不合并。
PAGES = {
    "files": [
        ("a0", "btn", "scan disk"), ("a1", "btn", "empty trash"), ("a2", "btn", "sort folder"),
        ("b0", "btn", "merge copies"), ("b1", "trap", "format disk"), ("b2", "btn", "unmount drive"),
    ],
    "network": [
        ("a0", "btn", "refresh status"), ("a1", "btn", "ping gateway"), ("a2", "btn", "reset adapter"),
        ("b0", "btn", "test bandwidth"), ("b1", "btn", "lock routes"), ("b2", "trap", "disable firewall"),
    ],
    "reports": [
        ("a0", "btn", "export table"), ("a1", "btn", "archive logs"), ("a2", "btn", "print summary"),
        ("b0", "btn", "zoom chart"), ("b1", "btn", "export chart"), ("b2", "btn", "share link"),
    ],
    "settings": [
        ("a0", "btn", "save options"), ("a1", "btn", "restore defaults"), ("a2", "toggle", "auto backup"),
        ("b0", "toggle", "dark theme"), ("b1", "toggle", "sync clock"), ("b2", "toggle", "guest login"),
    ],
    "archive": [
        ("a0", "btn", "clear log"), ("a1", "btn", "purge cache"), ("a2", "btn", "vacuum tables"),
        ("b0", "btn", "revoke sessions"), ("b1", "trap", "delete item"), ("b2", "trap", "erase history"),
    ],
}
NAV = ["files", "network", "reports", "settings", "archive", "editor"]
SLOT_POS = {
    "a0": (240, 170), "a1": (240, 290), "a2": (240, 410),
    "b0": (520, 230), "b1": (520, 350), "b2": (520, 470),
}
KIND_BG = {"btn": "#c6f5c6", "trap": "#f5c6c6", "toggle": "#cde6ff", "field": "#fdf3d0"}

root = tk.Tk()
root.title("console")
root.geometry(f"{WIDTH}x{HEIGHT}+0+0")
root.resizable(False, False)
try:
    root.attributes('-topmost', True)
except tk.TclError:
    pass


def flat_button(parent, **kw):
    """FLAT 无边框按钮 —— 边框浮雕在 OCR 里读出 '|'/']' 噪声字形。"""
    return tk.Button(parent, relief=tk.FLAT, bd=0, highlightthickness=0,
                     activebackground=kw.get('bg'), fg="#000000", **kw)


# 标题（harness 过滤词 —— 非可操作元素，却是 OCR 的真实干扰项）
tk.Label(root, text="console", font=("Segoe UI", 20, "bold"), fg="#333333").place(x=350, y=40)

content_widgets = []
entry_vars = {}
field_entries = {}


def on_toggle(widget):
    state["toggles"][widget] = not state["toggles"].get(widget, False)
    record(widget)


def make_field(name, y):
    """可输入行：标签（点击 = 聚焦输入框 —— 先落点后运笔的世界配合）+ Entry。
    世界真相：entries[name] 随每次击键原子落盘；focus 记录 FocusIn。"""
    label = flat_button(root, text=name, font=("Segoe UI", 15, "bold"), bg=KIND_BG["field"],
                        command=lambda: focus_entry(name))
    label.place(x=240, y=y + 4, width=170, height=48)
    content_widgets.append(label)
    var = tk.StringVar()
    entry_vars[name] = var
    var.trace_add("write", lambda *_: (state["entries"].__setitem__(name, var.get()), persist()))
    entry = tk.Entry(root, textvariable=var, font=("Segoe UI", 15), bd=0,
                     highlightthickness=1, highlightbackground="#999999")
    entry.place(x=430, y=y, width=310, height=44)
    entry.bind("<FocusIn>", lambda _e, n=name: (state.__setitem__("focus", n), persist()))
    field_entries[name] = entry
    content_widgets.append(entry)


def focus_entry(name):
    record(name)
    state["focus"] = name
    persist()
    entry = field_entries.get(name)
    if entry is not None:
        entry.focus_set()


def on_clear_fields():
    record("clear fields")
    for name, var in entry_vars.items():
        var.set("")
    state["focus"] = None
    persist()


def show_page(name):
    for w in content_widgets:
        w.destroy()
    content_widgets.clear()
    entry_vars.clear()
    field_entries.clear()
    state["page"] = name
    if name != "editor":
        state["focus"] = None
    persist()
    if name == "editor":
        # 笔迹纪元考场：三个可输入行 + 清空/保存
        for fname, y in [("server field", 170), ("user field", 290), ("notes field", 410)]:
            make_field(fname, y)
        b_clear = flat_button(root, text="clear fields", font=("Segoe UI", 15, "bold"),
                              bg=KIND_BG["btn"], command=on_clear_fields)
        b_clear.place(x=520, y=230, width=230, height=56)
        content_widgets.append(b_clear)
        b_save = flat_button(root, text="save profile", font=("Segoe UI", 15, "bold"),
                             bg=KIND_BG["btn"], command=lambda: record("save profile"))
        b_save.place(x=520, y=350, width=230, height=56)
        content_widgets.append(b_save)
        return
    for slot, kind, label in PAGES[name]:
        x, y = SLOT_POS[slot]
        if kind == "toggle":
            b = flat_button(root, text=label, font=("Segoe UI", 15, "bold"), bg=KIND_BG[kind],
                            command=lambda w=label: on_toggle(w))
        elif kind == "trap":
            b = flat_button(root, text=label, font=("Segoe UI", 15, "bold"), bg=KIND_BG[kind],
                            command=lambda w=label: record(w, True))
        else:
            b = flat_button(root, text=label, font=("Segoe UI", 15, "bold"), bg=KIND_BG[kind],
                            command=lambda w=label: record(w))
        b.place(x=x, y=y, width=230, height=56)
        content_widgets.append(b)


def on_nav(name):
    def handler():
        record(f"{name} page")
        show_page(name)
    return handler


# 导航标签 = 单词（'network page' 14pt 在窄按钮里会被两端裁剪 —— 真机教训：
# 文本渲染宽 ≥ 按钮宽 ⇒ 首末字母被吃，OCR 读出 'etwork pag'/'SEER'）。
# 字号 16：单词标签下 160px 按钮余量充足，且 ≥20px 字高远离 tesseract 误读带。
# 步距 80（六页导航在 600px 高度内的合法排布；与内容列的基线交错由
# 词级分组的 x-间隙判据天然分离）。
for i, name in enumerate(NAV):
    flat_button(root, text=name, font=("Segoe UI", 16, "bold"), bg="#e8e8e8",
                command=on_nav(name)).place(x=20, y=100 + i * 80, width=160, height=56)

show_page("files")
root.update_idletasks()
persist()
root.mainloop()
