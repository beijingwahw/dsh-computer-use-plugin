// src/dialects/tokenizer.ts
// ΑΩ-R10（方言三重复制单源化）：中英混合分词的单一事实源。此前
// policyEngineUtil.ts（tokenizeText）与 counterfactualUtil.ts（tokenize）各持
// 一份逐字节相同的实现（「零依赖铁律自带副本」），漂移风险真实存在，今起归源
// 于此。实现逐字节取自 policyEngineUtil.ts 副本（两份原本无行为差异，无需取舍）。
// 纪律：纯函数、零副作用、零异常、零依赖；输出按原文字符顺序（确定性）。
/** 中日韩统一表意字符（含扩展 A / 兼容区）—— 2-gram 切分对象 */
export const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
/** 双语停用词 —— 目标/判据分词后的功能词滤除（判定性弱、误匹配率高） */
export const STOPWORDS = new Set([
    '的', '了', '和', '与', '及', '或', '在', '是', '对', '从', '被', '把', '这', '那',
    '也', '又', '就', '都', '而', '则', '请', '不', '无', '于', '以', '为', '有', '个',
    '中', '并', '其', '之', '该', '当', '至', '给', '它', '你', '我',
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by',
    'is', 'are', 'be', 'been', 'was', 'were', 'this', 'that', 'these', 'those',
    'it', 'its', 'as', 'from', 'into', 'if', 'then', 'when', 'than', 'so', 'not',
    'no', 'yes', 'all', 'any', 'must', 'should', 'will', 'can',
]);
/** 空白折叠 + 小写化 —— 分词的前置归一（与各调用方自带的 normalize* 同律） */
function normalizeWs(s) {
    return typeof s === 'string' ? s.toLowerCase().replace(/\s+/g, ' ').trim() : '';
}
/**
 * 轻量分词（中文 2-gram + 英文分词，单源实现）：
 * 中文连续段按字符 2-gram（单字段保留单字）；英文/数字段按非字母数字切开取词；
 * 滤除停用词、纯数字与单个英文字母。输出按原文字符顺序（确定性）。
 * 入参宽收 unknown（非字符串 ⇒ 空表），string 调用方天然兼容。
 */
export function tokenizeText(text) {
    const norm = normalizeWs(text);
    if (!norm)
        return [];
    const tokens = [];
    const push = (t) => {
        if (t.length === 0)
            return;
        if (/^\d+$/.test(t))
            return; // 纯数字：坐标/序号噪声
        if (STOPWORDS.has(t))
            return; // 停用词
        if (!CJK_RE.test(t) && t.length < 2)
            return; // 单个英文字母噪声
        tokens.push(t);
    };
    let cjkRun = '';
    let wordRun = '';
    const flushCjk = () => {
        if (!cjkRun)
            return;
        if (cjkRun.length === 1)
            push(cjkRun);
        else
            for (let i = 0; i + 1 < cjkRun.length; i += 1)
                push(cjkRun.slice(i, i + 2));
        cjkRun = '';
    };
    const flushWord = () => {
        if (wordRun) {
            push(wordRun);
            wordRun = '';
        }
    };
    for (const ch of norm) {
        if (CJK_RE.test(ch)) {
            flushWord();
            cjkRun += ch;
        }
        else if (/[a-z0-9]/.test(ch)) {
            flushCjk();
            wordRun += ch;
        }
        else {
            flushCjk();
            flushWord();
        } // 空白/标点皆切段
    }
    flushCjk();
    flushWord();
    return tokens;
}
