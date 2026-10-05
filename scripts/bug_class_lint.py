#!/usr/bin/env python3
"""scripts/bug_class_lint.py —— Bug 类注册表（BCR）机械检测闸（P 纪元创世）。

立法背景：七轮战役 + O 纪元真机执法累计抓到的每一只潜伏 bug 都属于某个
**虫型类**（bug class）。修复若只改点不治类，同类 bug 必然在别处复发。
本脚本把每个虫型类铸成**机械检测器**：全库扫描其签名形状，命中即报。
接入 `npm run verify`（P 纪元）—— 虫型免疫从此是构建闸，不是记忆负担。

注册表（每类：检测器 + 起源故事 + 定位法）：
  BC-1 PS 引号律     PowerShell 字符串内的 `\\"` 不是转义（PS 用反引号）——
                     经 execFile 真机调用必炸。起源：O-#17 USER32_DECL/HC_DECL
                     （注入式测试掩盖）。检测：PS 上下文文件的字符串字面量含 `\\"`。
  BC-2 闭包重赋值    Python 嵌套函数对捕获名重赋值 ⇒ UnboundLocalError
                     （先读后赋路径任何平台必炸）。起源：O-#1 screen._encode
                     的 img。检测：AST 语句序分析（Load 先于该名首赋值）。
  BC-3 时钟单调假设  JS 侧用裸 Date.now() 当唯一 id/排序键（同毫秒碰撞 +
                     回拨倒序）。起源：O-#22 contextManager。检测：裸
                     `Date.now()` 直接赋值给 *Id/序键变量。
  BC-4 构造器参数属性 TS transform 语法（Node strip-only 拒载）。起源：Q-3 /
                     S-2 两度踩响。检测：constructor 形参含访问修饰符前缀。
  BC-5 函数体克隆    同一函数体在 src 内 ≥2 处逐字复刻且 ≥10 行（type-1
                     clone）⇒ 漂移风险（一处修 bug 他处复发）。起源：ΝΩ-41
                     方言克隆律 —— mulberry32/FNV-1a 六处副本。检测：注释
                     剥离 + 空白归一的 tokenize 指纹分组；行注释含
                     `exempt` 豁免（知情的残余克隆 —— 见豁免处的理由注）。

ΠΑΝ-85 规避封堵（C2-6/H-2 的三处实证绕过面）：
  · BC-3 类型注解不再豁免（剥除注解后再判：`const requestId: number =
    Date.now()` 照报）；行内任意 `// monotonic` 不再灭活检测——豁免必须精确
    格式 `// bcr-exempt: BC-3: <理由>` 且**登记**（输出尾部列豁免清单，豁免
    是可见的治理决定不是静默吞报）；`Math.max` 抑制须为真实调用（`Math.max(`），
    注释里提一嘴不再免报。
  · BC-4 词法级解析：constructor 形参表在「注释与字符串抹空」文本上配平括号
    （默认值 `f("(")` 不再错切段），顶层逗号切分后逐参数判修饰符前缀——单行
    多参数 `constructor(a: string, private b: number)` 照报，不再依赖行首锚。
  · BC-1 pwsh 入上下文；上下文判定升为**文件级**（PS 构造与 \\" 分行写不再
    绕过），命中面从「行内含 \\"」改为「字符串字面量含 \\"」（注释里的 \\" 不报）。
用法：python scripts/bug_class_lint.py [--strict] [--root DIR]
  （--strict：任何命中 exit 1；--root：扫描根（缺省仓库根）——阳性对照夹具用）
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

violations: list[str] = []
# ΠΑΝ-85 豁免登记册：精确格式豁免（bcr-exempt）必须在此可见——静默吞报 = 治理漏洞
exemptions: list[str] = []


def report(cls: str, where: str, detail: str) -> None:
    violations.append(f"[{cls}] {where}: {detail}")


# ─── BC-1：PS 引号律 ───

# ΠΑΝ-85：pwsh 入列（execFile('pwsh', …) 同一引号律）；上下文判定为文件级
PS_CONTEXT = re.compile(r"powershell|pwsh|PS_EXE|Add-Type|MemberDefinition|SetWindowPos|SystemParametersInfo", re.I)


def iter_string_literals(text: str):
    """产出字符串字面量跨度 (start, end, lineno)——注释盲区安全（注释内伪字符串
    不入列）；跨 sq/dq/tmpl 三态，处理转义与模板 ${} 嵌套（ΠΑΝ-85：BC-1 的命中面
    从「行含 \\"」升为「字符串字面量含 \\"」——分行书写不再绕过）。"""
    i, n, mode = 0, len(text), "code"
    stack: list[str] = []
    start = -1
    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if mode == "code":
            if c == "/" and nxt == "/":
                i = text.find("\n", i)
                i = n if i < 0 else i
                continue
            if c == "/" and nxt == "*":
                j = text.find("*/", i + 2)
                i = n if j < 0 else j + 2
                continue
            if c == "}":  # 模板 ${ 的闭界：回到模板态
                mode = stack.pop() if stack else "code"
                i += 1
                continue
            if c in "'\"`":
                mode = {"'": "sq", '"': "dq", "`": "tmpl"}[c]
                start = i
            i += 1
            continue
        if c == "\\":
            i += 2
            continue
        if (mode == "sq" and c == "'") or (mode == "dq" and c == '"'):
            yield start, i + 1, text.count("\n", 0, start) + 1
            mode = "code"
        elif mode == "tmpl":
            if c == "`" and not stack:
                yield start, i + 1, text.count("\n", 0, start) + 1
                mode = "code"
            elif c == "$" and nxt == "{":
                stack.append("tmpl")
                mode = "code"
                i += 2
                continue
        i += 1


def check_ps_quotes() -> None:
    for p in (REPO / "src").rglob("*.ts"):
        text = p.read_text(encoding="utf8", errors="replace")
        if not PS_CONTEXT.search(text):  # 文件级 PS 上下文（ΠΑΝ-85：含 pwsh）
            continue
        for s, e, ln in iter_string_literals(text):
            if '\\"' in text[s:e]:
                report("BC-1", f"{p.relative_to(REPO)}:{ln}", "PS 命令串含 \\\" —— PS 双引号串内不是转义（用单引号包 C# 定义；pwsh 同律）")


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
                # 名 → 首赋值语句序（AugAssign 目标不算首赋值：x += 1 先读 x，
                # 若计入会让下方 AugAssign 检测分支永远不触发）
                first_assign: dict[str, int] = {}
                for idx, stmt in enumerate(nested.body):
                    aug_names = {
                        t.target.id
                        for t in ast.walk(stmt)
                        if isinstance(t, ast.AugAssign) and isinstance(t.target, ast.Name)
                    }
                    for tgt in ast.walk(stmt):
                        if isinstance(tgt, ast.Name) and isinstance(tgt.ctx, ast.Store) and tgt.id not in aug_names:
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

# ΠΑΝ-85：`(?::[^=\n]+)?` 剥类型注解——`const requestId: number = Date.now()` 照报
# （批判样本：加注解即漏报）。
CLOCK_ID = re.compile(r"(const|let)\s+(\w*(?:id|Id|ID|seq|Seq)\w*)\s*(?::[^=\n]+)?=\s*Date\.now\(\)")
# ΠΑΝ-85 豁免精确格式：`// bcr-exempt: BC-3: <理由>`——登记后可见（输出尾部列清单）；
# 行内任意 `// monotonic` 不再灭活检测。
BC3_EXEMPT = re.compile(r"//\s*bcr-exempt:\s*BC-3\b\s*[:：]\s*(\S.*)$", re.I)


def check_clock_ids() -> None:
    for p in (REPO / "src").rglob("*.ts"):
        for i, line in enumerate(p.read_text(encoding="utf8", errors="replace").splitlines(), 1):
            if not CLOCK_ID.search(line):
                continue
            # ΠΑΝ-85：Math.max 抑制须为真实调用（`Math.max(`）——注释里提一嘴不再免报
            if "Math.max(" in line:
                continue
            m = BC3_EXEMPT.search(line)
            if m:
                exemptions.append(f"[BC-3] {p.relative_to(REPO)}:{i} 豁免（bcr-exempt）：{m.group(1).strip()}")
                continue
            report("BC-3", f"{p.relative_to(REPO)}:{i}",
                   f"裸 Date.now() 作 id/序键 —— 同毫秒碰撞 + 时钟回拨倒序（用 max(now, last+1) 混合逻辑时钟；"
                   f"豁免须精确格式 // bcr-exempt: BC-3: <理由> 并登记）：{line.strip()[:80]}")


# ─── BC-4：TS 构造器参数属性（transform 语法 —— Node strip-only 拒载）───
# 起源：Q-3 SprtPopupFilter / S-2 P2Quantile 两度踩响。检测：constructor 形参
# 列表含 access-modifier 前缀（public/protected/private/readonly 组合）。
# ΠΑΝ-85：词法级解析——①括号配平在「注释与字符串内容抹空」文本上做（默认值
# `f("(")` 不再错切参数段）；②顶层逗号切分后逐参数判修饰符前缀（单行多参数
# `constructor(a: string, private b: number)` 照报——不再依赖行首锚）。


def _split_params(params: str) -> list[str]:
    """形参表 → 顶层参数列表（(),[],{} 配平处切分；输入为字符串抹空文本）。"""
    out: list[str] = []
    buf: list[str] = []
    depth = 0
    for c in params:
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        if c == "," and depth == 0:
            out.append("".join(buf))
            buf = []
        else:
            buf.append(c)
    out.append("".join(buf))
    return [s.strip() for s in out if s.strip()]


def check_ctor_param_properties() -> None:
    for p in (REPO / "src").rglob("*.ts"):
        raw = p.read_text(encoding="utf8", errors="replace")
        _, struct = _strip_for_bc5(raw)  # 结构层：注释与字符串内容全抹空（保长保行号）
        for m in re.finditer(r"\bconstructor\s*\(", struct):
            depth, i = 1, m.end()
            while i < len(struct) and depth > 0:
                if struct[i] == "(":
                    depth += 1
                elif struct[i] == ")":
                    depth -= 1
                i += 1
            params = struct[m.end():i - 1]
            # readonly 形参缺类型注解（`readonly b`）也是参数属性——无类型的
            # transform 语法同样被 Node strip-only 拒载，一并检出
            for param in _split_params(params):
                if re.match(r"(?:public|protected|private)\s|readonly\s+\w+", param):
                    ln = raw.count("\n", 0, m.start()) + 1
                    report("BC-4", f"{p.relative_to(REPO)}:{ln}",
                           f"构造器参数属性（transform 语法，Node strip-only 拒载）：{param[:60]}")
                    break


# ─── BC-5：函数体克隆（type-1 clone —— tokenize 归一化指纹分组）───

BC5_MIN_LINES = 10  # 函数体跨行数下界（小工具函数的形似不算克隆债）
BC5_EXEMPT = re.compile(r"//\s*.*\bexempt\b|/\*\s*.*\bexempt\b", re.I)


def _strip_for_bc5(text: str) -> tuple[str, str]:
    """双层剥离（保长保行号）：
    fp_text    —— 注释抹空、字符串保形（指纹层：克隆判定要吃字符串差异）；
    struct_text—— 注释与字符串内容全抹空（结构层：括号/花括号配平不被字符串
                 内的 '{'/'}'/引号毒化 —— `${…}` 插值按代码保留以保模板平衡）。"""
    fp = list(text)
    st = list(text)
    i, n, mode = 0, len(text), "code"
    stack: list[str] = []  # 模板字面量内 ${ … } 的嵌套
    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if mode == "code":
            if c == "/" and nxt == "/":
                mode = "line"
                fp[i] = fp[i + 1] = st[i] = st[i + 1] = " "
                i += 2
                continue
            if c == "/" and nxt == "*":
                mode = "block"
                fp[i] = fp[i + 1] = st[i] = st[i + 1] = " "
                i += 2
                continue
            if c == "}" and stack:
                mode = stack.pop()
                st[i] = " "  # ${ 的闭界：结构层不计
                i += 1
                continue
            if c == "'":
                mode = "sq"
                st[i] = " "
            elif c == '"':
                mode = "dq"
                st[i] = " "
            elif c == "`":
                mode = "tmpl"
                st[i] = " "
            i += 1
            continue
        if mode == "line":
            if c == "\n":
                mode = "code"
            else:
                fp[i] = st[i] = " "
            i += 1
            continue
        if mode == "block":
            if c == "*" and nxt == "/":
                fp[i] = fp[i + 1] = st[i] = st[i + 1] = " "
                mode = "code"
                i += 2
                continue
            if c != "\n":
                fp[i] = st[i] = " "
            i += 1
            continue
        # 字符串态（sq/dq/tmpl）：指纹层保形，结构层抹空；跳转义与闭界
        if c == "\\":
            st[i] = " "
            i += 2
            continue
        st[i] = " "
        if (mode == "sq" and c == "'") or (mode == "dq" and c == '"'):
            mode = "code"
        elif mode == "tmpl":
            if c == "`" and not stack:
                mode = "code"
            elif c == "$" and nxt == "{":
                stack.append("tmpl")
                mode = "code"
                st[i] = st[i + 1] = " "  # '${' 开界：结构层不计
                i += 2
                continue
        i += 1
    return "".join(fp), "".join(st)


def _match_brace(text: str, i: int) -> int:
    """text[i] == '{' 起的配平闭界位置（闭界右侧），字符串/注释已在上游抹空。"""
    depth = 0
    while i < len(text):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return i


FUNC_RE = re.compile(r"\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)\s*\(")


def check_function_clones() -> None:
    """检测：src/**/*.ts 的 function 声明体 →（注释抹空 + 字符串保形 + 空白归一）
    指纹 → 同指纹 ≥2 处且函数体 ≥10 行 ⇒ 报；函数声明区（含前两行注解）含
    `exempt` 行注释 ⇒ 豁免（知情的残余克隆）。"""
    groups: dict[str, list[tuple[str, int, str]]] = {}
    for p in (REPO / "src").rglob("*.ts"):
        raw = p.read_text(encoding="utf8", errors="replace")
        fp_text, struct = _strip_for_bc5(raw)
        for m in FUNC_RE.finditer(struct):
            # 参数表 + 返回类型（在结构层跳到函数体开界 '{' —— 字符串内括号不毒化）
            j = m.end()
            depth = 1  # match 已吃掉参数表的开括号
            while j < len(struct):
                if struct[j] == "(":
                    depth += 1
                elif struct[j] == ")":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            k = struct.find("{", j)
            if k < 0:
                continue
            end = _match_brace(struct, k)
            body = fp_text[k + 1:end - 1]
            if body.count("\n") + 1 < BC5_MIN_LINES:
                continue
            # 豁免面：函数体原文 + 声明上方两行（JSDoc 豁免注记的落点）
            raw_slice = raw[m.start():end]
            head = raw[:m.start()].splitlines()[-2:]
            if BC5_EXEMPT.search(raw_slice) or (head and BC5_EXEMPT.search("\n".join(head))):
                continue
            fingerprint = " ".join(body.split())
            groups.setdefault(fingerprint, []).append((str(p.relative_to(REPO)), raw[: m.start()].count("\n") + 1, m.group(1)))
    for members in groups.values():
        if len(members) >= 2:
            where = "、".join(f"{f}:{ln}({name})" for f, ln, name in members)
            report("BC-5", where,
                   f"函数体克隆 ×{len(members)}（≥{BC5_MIN_LINES} 行逐字复刻）—— 单源化或加 exempt 行注释申报知情")


def main(argv: list[str]) -> int:
    global REPO
    strict = "--strict" in argv
    if "--root" in argv:
        i = argv.index("--root")
        if i + 1 >= len(argv):
            print("✖ --root 缺值（扫描根目录）", file=sys.stderr)
            return 3
        REPO = Path(argv[i + 1]).resolve()
    check_ps_quotes()
    check_closure_reassignment()
    check_clock_ids()
    check_ctor_param_properties()
    check_function_clones()
    if violations:
        print(f"✖ 虫型检测命中 {len(violations)} 处：")
        for v in violations:
            print(f"  {v}")
        _print_exemptions()
        if strict:
            return 1
        return 0
    print("✔ Bug 类注册表（BC-1/BC-2/BC-3/BC-4/BC-5）全库零命中")
    _print_exemptions()
    return 0


def _print_exemptions() -> None:
    if exemptions:
        # ΠΑΝ-85 豁免登记面：精确格式豁免全部列示——豁免是可见的治理决定
        print(f"✔ 豁免登记 {len(exemptions)} 处（bcr-exempt，精确格式）：")
        for e in exemptions:
            print(f"  {e}")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
