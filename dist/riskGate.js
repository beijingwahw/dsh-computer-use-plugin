// src/riskGate.ts
// 第五轮创新之二：风险感知人机协同（Risk Gate）。
// E-6 混淆免疫（第五维·信息热力学）：归一化匹配对抗视觉混淆（p@ssw0rd/密 码/PIN 码）。
// 世界级 CUA 的安全共识：凭据类输入不该由 Agent 代劳 —— Operator 遇到密码框
// 会交还控制权。本模块用两段式实现：
//   1. click_mouse 时识别敏感目标（target_description 命中风险词）⇒ 标记焦点为敏感
//   2. type_text 到敏感焦点 ⇒ 拦截，要求暂停并请用户亲自输入（绝不回显内容）
// 风险词可配置（逗号分隔），默认覆盖中英常见凭据语义。
import { CONFUSABLES_ASCII } from './riskGate.confusables.generated.js';
export const DEFAULT_RISK_PATTERNS = 'password,passwd,密码,口令,验证码,verification code,2fa,otp,pin,secret,token,api key,私钥';
// 第六轮：不可逆操作模式 —— 命中即需一次性审批令牌（用户显式授权后方可执行）
export const DEFAULT_DANGER_PATTERNS = 'send,发送,delete,删除,remove,移除,pay,支付,付款,buy,购买,checkout,结算,下单,submit order,提交订单,' +
    'confirm,确认订单,format,格式化,erase,抹掉,uninstall,卸载,reset,重置,清空,withdraw,提现,transfer,转账';
/** 解析逗号分隔的风险词配置（空串回退 fallback） */
export function parseRiskPatterns(csv, fallback = DEFAULT_RISK_PATTERNS) {
    return (csv || fallback)
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
}
// ─── E-6 混淆免疫（第五维·信息热力学）：归一化对抗视觉混淆 ───
/** leet 还原表：人类可读、机器漏检的视觉同形混淆（0↔o、1↔l、@↔a…）。
 *  算法形状字面量 —— 覆盖常见凭据字段混淆；完整 homoglyph 表（西里尔 а 等）
 *  是留白（NFKC 归一化 + Unicode 同形映射，需真实语料定标）。 */
const LEET_MAP = {
    '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's',
};
/**
 * 归一化：小写 + leet 还原 + 剥空白/零宽字符/标点/符号。
 * 「p@ssw0rd」→「password」、「密 码」→「密码」、「verificati0n c0de」→
 * 「verificationcode」—— 三类视觉混淆在归一化域内全部还原为可匹配形态。
 * 语义方向：匹配面扩大只增召回（宁误拦不漏拦 —— 风险闸门的使命是保守，
 *  拦截的代价有界：模型多看一眼截图；漏拦的代价是凭据被代输）。
 * 词表与待检文本同律归一（双向一致 —— 词表「api key」与文本「A P I k e y」对齐）。
 */
// K 纪元（留白兑现之六）：同形字（homoglyph）归一 —— E-6 留白的兑现。
// 策领图（Unicode confusables 的策展子集，覆盖攻击面最广的三族）：
//   西里尔/希腊视觉同形 → 拉丁；全角字母数字 → 半角。完整 consortium 表
//   数千条 —— 策展 ~50 条是"值即边界"（新增条目零风险，纯数据扩展）。
/**
 * L 纪元扩表（值即边界 → 算术全表）：数学字母五套（U+1D400 系）、带圈
 * Ⓐ-ⓩ/ⓐ-ⓩ、上标/下标字母 —— 码点偏移算术批量生成（推导即数据，零数据文件）。
 * 策展跨脚本核心（西里尔/希腊/亚美尼亚/科普特）保留手工映射 —— 覆盖 =
 * 算术族全覆盖 + 混杂族策展；扩展是加一行，不是加一张表。
 */
/**
 * O 纪元（#10 全表）：Unicode confusables.txt（UTS #39）全表蒸馏接入 ——
 * 1665 条原型纯 ASCII 条目（数据血缘与再生命令见 generated 文件头）打底；
 * 策展/算术族覆写在后：既有行为零回归，全表只填空白。ASCII→ASCII 折叠
 * （如 m→rn、0→o）无害且正确 —— haystack 与 pattern 双方过同一归一化，
 * 对称一致（UTS#39 的混淆语义：rn 与 m 视觉互混，双向都该命中）。
 */
function buildHomoglyphMap() {
    const m = {
        ...CONFUSABLES_ASCII,
        // ── 策展跨脚本核心（覆写位：与生成表冲突时以策展为准）──
        'а': 'a', 'е': 'e', 'о': 'o', 'с': 'c', 'р': 'p',
        'х': 'x', 'у': 'y', 'і': 'i', 'ѕ': 's', 'һ': 'h',
        'ԁ': 'd', 'җ': 'g', 'ӏ': 'l', 'ӣ': 'm', 'й': 'u',
        'ј': 'j', 'ѣ': 'y', 'ԛ': 'q',
        'α': 'a', 'ο': 'o', 'ρ': 'p', 'ε': 'e', 'ι': 'i',
        'κ': 'k', 'μ': 'm', 'ν': 'v', 'τ': 't', 'χ': 'x',
        'ա': 'a', 'ս': 's', 'օ': 'o', 'չ': 'p', 'թ': 't',
        'ⱥ': 'a', 'ⱦ': 'e', 'ꭱ': 'e',
    };
    for (let i = 0; i < 26; i++) {
        m[String.fromCharCode(0xff21 + i)] = String.fromCharCode(97 + i); // 全角 Ａ-Ｚ
        m[String.fromCharCode(0xff41 + i)] = String.fromCharCode(97 + i); // 全角 ａ-ｚ
        m[String.fromCodePoint(0x1d400 + i)] = String.fromCharCode(97 + i); // 数学粗体
        m[String.fromCodePoint(0x1d434 + i)] = String.fromCharCode(97 + i); // 数学斜体
        m[String.fromCodePoint(0x1d468 + i)] = String.fromCharCode(97 + i); // 数学粗斜体
        m[String.fromCodePoint(0x1d4d0 + i)] = String.fromCharCode(97 + i); // 数学粗花体
        m[String.fromCharCode(0x24b6 + i)] = String.fromCharCode(97 + i); // 带圈大写
        m[String.fromCharCode(0x24d0 + i)] = String.fromCharCode(97 + i); // 带圈小写
    }
    for (let i = 0; i < 10; i++)
        m[String.fromCharCode(0xff10 + i)] = String(i); // 全角数字
    return m;
}
const HOMOGLYPH_MAP = buildHomoglyphMap();
// Δ 纪元（安全外围#1）：单遍替换的折叠不对称 —— 全角 ｍ 单遍归一为 'm' 后不再
// 折叠为 'rn'，而 ASCII 词表 'submit' 单遍即成 'subrnit'（CONFUSABLES_ASCII 的
// m→rn 折叠）⇒ haystack 与 pattern 停在不同的中间形态（实测 ｓｕｂｍｉｔ 逃逸）。
// 修法：迭代归一至不动点（haystack 与词表两侧同律）。上限 3 遍 —— 恶意构造的
// 长折叠链（m→rn→…）不能把归一化变成放大器；真实混淆链（全角→ASCII→折叠）
// 两遍内收敛，3 遍是安全裕度。
const NORMALIZE_MAX_PASSES = 3;
function normalizeOnce(s) {
    let out = '';
    for (const ch of s.toLowerCase()) {
        if (LEET_MAP[ch] !== undefined) {
            out += LEET_MAP[ch];
            continue;
        }
        if (HOMOGLYPH_MAP[ch] !== undefined) {
            out += HOMOGLYPH_MAP[ch];
            continue;
        }
        if (/[\s\u200b\u200c\u200d\p{P}\p{S}]/u.test(ch))
            continue; // 空白/零宽/标点/符号全剥
        out += ch;
    }
    return out;
}
/** 风险域归一化（导出供同律消费者对齐；匹配语义只经 matches* 两函数） */
export function normalizeForRisk(s) {
    let prev = s;
    for (let i = 0; i < NORMALIZE_MAX_PASSES; i++) {
        const next = normalizeOnce(prev);
        if (next === prev)
            return next; // 不动点：再归一不变 ⇒ 已是最终形态
        prev = next;
    }
    return prev; // 越过迭代上限：按已收敛部分匹配（有界保守，不为恶意长链无限付费）
}
// Δ 纪元（安全外围#2）：模式归一化记忆化 —— 旧实现每次 matches* 调用都重切
// CSV 并逐 pattern 归一化（现在还是每 pattern 三遍迭代），而 csv 是每回合稳定
// 的配置串。按「生效 csv 字符串」缓存归一化后的词表（上限 32 条，满时逐出最旧
// —— Map 保序，首键即 LRU 牺牲者；词表配置的组合空间天然远小于 32）。
const PATTERN_CACHE_LIMIT = 32;
const patternCache = new Map();
/** 归一化词表（记忆化；键 = 生效 csv，即 csv || fallback） */
function normalizedPatterns(csv, fallback) {
    const key = csv || fallback;
    const hit = patternCache.get(key);
    if (hit)
        return hit;
    const pats = key
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
        .map(normalizeForRisk); // 与 haystack 同律（含不动点迭代 —— 两侧停在同一形态）
    if (patternCache.size >= PATTERN_CACHE_LIMIT) {
        const oldest = patternCache.keys().next().value;
        if (oldest !== undefined)
            patternCache.delete(oldest);
    }
    patternCache.set(key, pats);
    return pats;
}
/** 记忆化探针（测试/可观测性用：断言缓存命中、无需重复归一化） */
export function riskPatternCacheSize() {
    return patternCache.size;
}
/** 文本是否命中任一风险词（混淆免疫：归一化后包含匹配） */
export function matchesRiskPatterns(text, csv) {
    if (!text)
        return false;
    const hay = normalizeForRisk(text);
    const pats = normalizedPatterns(csv, DEFAULT_RISK_PATTERNS);
    for (let i = 0; i < pats.length; i++)
        if (hay.includes(pats[i]))
            return true;
    return false;
}
/** 文本是否命中任一不可逆操作词（需审批令牌；同律归一化） */
export function matchesDangerPatterns(text, csv) {
    if (!text)
        return false;
    const hay = normalizeForRisk(text);
    const pats = normalizedPatterns(csv, DEFAULT_DANGER_PATTERNS);
    for (let i = 0; i < pats.length; i++)
        if (hay.includes(pats[i]))
            return true;
    return false;
}
