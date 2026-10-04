// src/vlm/internalUtils.ts
// W6R-A4（工具去重）：VLM 栈共享的零依赖原语 —— JSON 剥壳律（stripFences /
// scanBalanced / extractBalancedJson）与传输底座小件（sleep / timeoutSignal /
// isAbortError / safeBodyText）+ 可重试 HTTP 状态域常量。
//
// 缘起：glmClient.ts 与 providers/types.ts 此前各持一份逐字节拷贝（jitter
// 退避与脏值防御两版已然漂移），双份维护违 DRY；本文件收拢为单一实现，
// 两个消费方统一引用。行为以既有测试锁定为准 —— 实现逐字节取自原拷贝，
// 未做任何"顺手优化"（extractBalancedJson 取 providers 版的整体 try/catch
// 形态：脏值安静返回 undefined 的不抛铁律已被 vlm.providers.types.test.ts
// 锁定）。
//
// 宪法（与全仓同律）：
//   1. 零依赖叶子 —— 不 import 任何模块（providers/types 引用本文件不成环）；
//   2. 永不抛异常 —— 一切失败以返回值 ok:false / undefined / null 表达；
//   3. 全部具名导出、无 default。
// W6-2（doctor smell.magic-number 清偿）：可重试 HTTP 状态域（数值逐位不变）
// —— 429 限流与 5xx 服务端故障值得退避重试；其余 4xx 是请求本身有病，重试无义。
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
export const HTTP_STATUS_SERVER_ERROR_FLOOR = 500;
// ΝΩ 收官（smell.magic-number 清偿）：400 是"请求方言被网关拒绝"的信号位
// （json_schema/response_format 不支持类）——ΝΩ-18/44 的降级回退链以它为触发。
export const HTTP_STATUS_BAD_REQUEST = 400;
/** 剥 Markdown 围栏 —— ```json\n{...}\n``` → {...（仅当整体被围栏包裹时） */
export function stripFences(s) {
    const m = /^```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```$/.exec(s.trim());
    return m ? m[1].trim() : s.trim();
}
/** 从文本中取首个平衡的 {...} / [...] 片段 —— 字符串感知（跳过引号内的括号
 *  与转义），返回切出的原文片段；无平衡片段返回 null。 */
export function scanBalanced(s) {
    const start = s.search(/[{[]/);
    if (start < 0)
        return null;
    const open = s[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (esc)
                esc = false;
            else if (ch === '\\')
                esc = true;
            else if (ch === '"')
                inStr = false;
            continue;
        }
        if (ch === '"') {
            inStr = true;
            continue;
        }
        if (ch === open)
            depth++;
        else if (ch === close) {
            depth--;
            if (depth === 0)
                return s.slice(start, i + 1);
        }
    }
    return null;
}
/**
 * 健壮 JSON 提取（JSON 剥壳律的单一实现）：剥 ```json 围栏 → 取首个平衡
 * {...}/[...] → parse。成功返回解析值（可为 null/false 等合法 JSON 值）；
 * 失败或脏值（null/undefined 等非字符串）安静返回 undefined —— 绝不抛异常。
 * （glmClient.extractGlmJson 与 providers/types.extractProviderJson 均为
 * 本函数的薄委托 —— 历史导出名保留，消费面零改动。）
 */
export function extractBalancedJson(text) {
    try {
        const candidate = scanBalanced(stripFences(text));
        if (candidate === null)
            return undefined;
        return JSON.parse(candidate);
    }
    catch {
        return undefined;
    }
}
/** sleep Promise —— 退避专用 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
/** 构造超时信号 —— AbortSignal.timeout 主路径 + 旧 Node AbortController 兜底
 *  （与 physicalExecution/httpClient.ts 同款：timer unref 不阻进程退出） */
export function timeoutSignal(timeoutMs) {
    try {
        return AbortSignal.timeout(timeoutMs);
    }
    catch {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        t.unref?.();
        return ctrl.signal;
    }
}
/** 判超时/中止异常 —— AbortSignal.timeout 抛 TimeoutError，手动 abort 抛 AbortError */
export function isAbortError(e) {
    const name = e?.name;
    return name === 'TimeoutError' || name === 'AbortError';
}
/** 安全读响应正文 —— body 读失败（连接已断）返回空串，绝不抛 */
export async function safeBodyText(resp) {
    try {
        return await resp.text();
    }
    catch {
        return '';
    }
}
