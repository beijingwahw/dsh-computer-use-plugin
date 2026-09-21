#!/usr/bin/env python3
"""scripts/bug_class_lint.py —— Bug 类注册表（BCR）机械检测闸（P 纪元创世）。

立法背景：七轮战役 + O 纪元真机执法累计抓到的每一只潜伏 bug 都属于某个
**虫型类**（bug class）。修复若只改点不治类，同类 bug 必然在别处复发。
本脚本把每个虫型类铸成**机械检测器**：全库扫描其签名形状，命中即报。
接入 `npm run verify`（P 纪元）—— 虫型免疫从此是构建闸，不是记忆负担。

注册表（每类：检测器 + 起源故事 + 定位法）：
  BC-1 PS 引号律     PowerShell 字符串内的 `\\"` 不是转义（PS 用反引号）——
                     经 execFile 真机调用必炸。起源：O-#17 USER32_DECL/HC_DECL
                     （注入式测试掩盖）。检测：PS 命令串含 `\\"`。
  BC-2 闭包重赋值    Python 嵌套函数对捕获名重赋值 ⇒ UnboundLocalError
                     （先读后赋路径任何平台必炸）。起源：O-#1 screen._encode
                     的 img。检测：AST 语句序分析（Load 先于该名首赋值）。
  BC-3 时钟单调假设  JS 侧用裸 Date.now() 当唯一 id/排序键（同毫秒碰撞 +
                     回拨倒序）。起源：O-#22 contextManager。检测：裸
                     `Date.now()` 直接赋值给 *Id/序键变量。
用法：python scripts/bug_class_lint.py [--strict]（--strict：任何命中 exit 1）
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

violations: list[str] = []


def report(cls: str, where: str, detail: str) -> None:
    violations.append(f"[{cls}] {where}: {detail}")


# ─── BC-1：PS 引号律 ───

PS_CONTEXT = re.compile(r"powershell|PS_EXE|Add-Type|MemberDefinition|SetWindowPos|SystemParametersInfo", re.I)


def check_ps_quotes() -> None:
    for p in (REPO / "src").rglob("*.ts"):
        text = p.read_text(encoding="utf8", errors="replace")
        if not PS_CONTEXT.search(text):
            continue
        for i, line in enumerate(text.splitlines(), 1):
            # PS 命令构造行内的 \" 序列（TS 源码里合法的 JS 转义，但传给 PS 即炸）
            if '\\"' in line and PS_CONTEXT.search(line):
                report("BC-1", f"{p.relative_to(REPO)}:{i}", "PS 命令串含 \\\" —— PS 双引号串内不是转义（用单引号包 C# 定义）")


# ─── BC-2：闭包重赋值（语句序敏感的 AST 分析）───

def check_closure_reassignment() -> None:
    """检测：嵌套函数对名字 N 存在「Load 出现在 N 首次赋值语句**之前」——
    即 UnboundLocalError 形状（N 既是局部又是捕获名，或纯局部先读后赋）。"""
    for p in (REPO / "python_service").rglob("*.py"):
        if "__pycache__" in str(p):
            continue
        try:
            tree = ast.parse(p.read_text(encoding="utf8", errors="replace"))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for nested in ast.walk(node):
                if nested is node or not isinstance(nested, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                # 名 → 首赋值语句序
                first_assign: dict[str, int] = {}
                for idx, stmt in enumerate(nested.body):
                    for tgt in ast.walk(stmt):
                        if isinstance(tgt, ast.Name) and isinstance(tgt.ctx, ast.Store):
                            first_assign.setdefault(tgt.id, idx)
                # 先于首赋值的 Load（含 AugAssign 读）
                risky: dict[str, int] = {}
                for idx, stmt in enumerate(nested.body):
                    for reader in ast.walk(stmt):
                        name = None
                        if isinstance(reader, ast.Name) and isinstance(reader.ctx, ast.Load):
                            name = reader.id
                        elif isinstance(reader, ast.AugAssign) and isinstance(reader.target, ast.Name):
                            name = reader.target.id  # x += 1 读 x
                        if name and name in first_assign and idx < first_assign[name]:
                            risky.setdefault(name, idx)
                for name, idx in risky.items():
                    report(
                        "BC-2", f"{p.relative_to(REPO)}:{nested.lineno}",
                        f"嵌套函数 '{nested.name}' 对 '{name}' 在首次赋值（语句 {first_assign[name]}）"
                        f"之前读取（语句 {idx}）—— UnboundLocalError 形状（起源：screen._encode 的 img）",
                    )


# ─── BC-3：时钟单调假设 ───

CLOCK_ID = re.compile(r"(const|let)\s+(\w*(?:id|Id|Id|seq|Seq)\w*)\s*=\s*Date\.now\(\)")


def check_clock_ids() -> None:
    for p in (REPO / "src").rglob("*.ts"):
        for i, line in enumerate(p.read_text(encoding="utf8", errors="replace").splitlines(), 1):
            if CLOCK_ID.search(line) and "Math.max" not in line and "monotonic" not in line.lower():
                report("BC-3", f"{p.relative_to(REPO)}:{i}",
                       f"裸 Date.now() 作 id/序键 —— 同毫秒碰撞 + 时钟回拨倒序（用 max(now, last+1) 混合逻辑时钟）：{line.strip()[:80]}")


# ─── BC-4：TS 构造器参数属性（transform 语法 —— Node strip-only 拒载）───
# 起源：Q-3 SprtPopupFilter / S-2 P2Quantile 两度踩响。检测：constructor 形参
# 列表含 access-modifier 前缀（public/protected/private/readonly 组合）。


def check_ctor_param_properties() -> None:
    for p in (REPO / "src").rglob("*.ts"):
        text = p.read_text(encoding="utf8", errors="replace")
        # 块匹配 constructor( ... )：粗粒度括号配平（跨行）
        for m in re.finditer(r"constructor\s*\(", text):
            depth, i = 1, m.end()
            while i < len(text) and depth > 0:
                if text[i] == "(":
                    depth += 1
                elif text[i] == ")":
                    depth -= 1
                i += 1
            params = text[m.end():i - 1]
            for ln, line in enumerate(params.splitlines(), 1):
                if re.match(r"^\s*(public|protected|private)\s|readonly\s+\w+\s*:", line):
                    report("BC-4", f"{p.relative_to(REPO)}:ctor",
                           f"构造器参数属性（transform 语法，Node strip-only 拒载）：{line.strip()[:60]}")
                    break


def main() -> int:
    check_ps_quotes()
    check_closure_reassignment()
    check_clock_ids()
    check_ctor_param_properties()
    if violations:
        print(f"✖ 虫型检测命中 {len(violations)} 处：")
        for v in violations:
            print(f"  {v}")
        if "--strict" in sys.argv:
            return 1
        return 0
    print("✔ Bug 类注册表（BC-1/BC-2/BC-3/BC-4）全库零命中")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
