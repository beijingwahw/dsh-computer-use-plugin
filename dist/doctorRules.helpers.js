// src/doctorRules.helpers.ts
// D-4 质量医生抗体库的公共辅助面（W8-A9 自 doctorRules.ts 拆出 —— 医生吃自己
// 的处方：规则本体拆至 doctorRules.core.ts / doctorRules.security.ts 后，扫描
// 辅助函数与文本工具收口于此，供两份规则表共享）。
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
const MARKER_TOOLS = new Set(['AGENT_BEGIN', 'AGENT_END', 'ENV_SHAPED', 'SENSE_SHIFT']);
export const EMPTY_CATCH_FIX = 'FIXME(doctor): document why this error is intentionally swallowed';
/** checkpoint.ts 的 Checkpoint 是模块私有 —— 此为 D-4 的只读结构视图 */
function finding(rule, riskLevel, file, line, snippet, evidence, recommendation) {
    return {
        id: `${rule.id}@${file}:${line}`, ruleId: rule.id, severity: rule.severity, riskLevel,
        location: { file, line, snippet: snippet.trim().slice(0, 160) }, evidence, recommendation,
    };
}
export function lines(s) { return s.split('\n'); }
// ─── W6R-B9 扫描辅助（安全不变量规则的公共面） ───
/** 注释行判定（与 smell.magic-number 同律）：文档不是代码。shell 启动/审批
 *  纪律的检测只对代码行执法 —— 源内注释里的历史描述（如「弃 cmd.exe /c start」
 *  「-Command → -EncodedCommand」）是对修复的记载，不是违规。 */
function isCommentLine(l) {
    const t = l.trim();
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}
/** 仓库根锚点：本文件居 src/（构建产物居 dist/），'../' 恒为仓库根。
 *  供读取源码树（sourceRoot = src/，walker 只收 .ts）之外的安全工件：
 *  package.json（依赖归类）与 python_service/（android 转义纪律）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 读取仓库工件（源码树外）：ctx.sources 有同路径合成件时优先（测试注入面 ——
 *  合成证据走与真实出诊完全相同的扫描路径），缺席时回退磁盘实读。
 *  读不到 ⇒ null：调用方收敛为 ctx.warn（规则契约 —— 内部绝不抛，失败可见）。 */
function readRepoArtifact(rel, ctx) {
    const synth = ctx.sources.find(s => s.path === rel);
    if (synth !== undefined)
        return synth.content;
    try {
        return readFileSync(join(REPO_ROOT, rel), 'utf8');
    }
    catch {
        return null;
    }
}
/** Python 代码行提取（android.py 专用）：剔除 # 注释与三引号 docstring ——
 *  docstring 里对转义规则的**描述**（如「整串经 shlex.quote 包裹」）不算实现，
 *  检测必须锚定真正的代码行，否则文档在而实现被删时会静默漏判。 */
function pyCodeLines(ls) {
    let inDoc = false;
    const out = [];
    for (let i = 0; i < ls.length; i++) {
        const l = ls[i];
        if (l.trim().startsWith('#'))
            continue;
        const marks = (l.match(/"""/g) ?? []).length;
        if (inDoc) {
            if (marks % 2 === 1)
                inDoc = false;
            continue;
        }
        if (marks === 1) {
            inDoc = true;
            continue;
        }
        if (marks >= 2)
            continue; // 同行开闭的独立 docstring 行
        out.push({ l, i });
    }
    return out;
}
// 供规则表（core/security）内部使用的辅助面 —— 不进门面 re-export（公共 API 面不变）
export { finding, isCommentLine, readRepoArtifact, pyCodeLines, MARKER_TOOLS };
