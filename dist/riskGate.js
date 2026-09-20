// src/riskGate.ts
// 第五轮创新之二：风险感知人机协同（Risk Gate）。
// E-6 混淆免疫（第五维·信息热力学）：归一化匹配对抗视觉混淆（p@ssw0rd/密 码/PIN 码）。
// 世界级 CUA 的安全共识：凭据类输入不该由 Agent 代劳 —— Operator 遇到密码框
// 会交还控制权。本模块用两段式实现：
//   1. click_mouse 时识别敏感目标（target_description 命中风险词）⇒ 标记焦点为敏感
//   2. type_text 到敏感焦点 ⇒ 拦截，要求暂停并请用户亲自输入（绝不回显内容）
// 风险词可配置（逗号分隔），默认覆盖中英常见凭据语义。
export const DEFAULT_RISK_PATTERNS = 'password,passwd,密码,口令,验证码,verification code,2fa,otp,pin,secret,token,api key,私钥';
// 第六轮：不可逆操作模式 —— 命中即需一次性审批令牌（用户显式授权后方可执行）
export const DEFAULT_DANGER_PATTERNS = 'send,发送,delete,删除,remove,移除,pay,支付,付款,buy,购买,checkout,结算,下单,submit order,提交订单,' +
    'confirm,确认订单,format,格式化,erase,抹掉,uninstall,卸载,reset,重置,清空,withdraw,提现,transfer,转账';
/** 解析逗号分隔的风险词配置 */
export function parseRiskPatterns(csv) {
    return (csv || DEFAULT_RISK_PATTERNS)
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
function normalizeForRisk(s) {
    let out = '';
    for (const ch of s.toLowerCase()) {
        if (LEET_MAP[ch] !== undefined) {
            out += LEET_MAP[ch];
            continue;
        }
        if (/[\s\u200b\u200c\u200d\p{P}\p{S}]/u.test(ch))
            continue; // 空白/零宽/标点/符号全剥
        out += ch;
    }
    return out;
}
/** 文本是否命中任一风险词（混淆免疫：归一化后包含匹配） */
export function matchesRiskPatterns(text, csv) {
    if (!text)
        return false;
    const hay = normalizeForRisk(text);
    return parseRiskPatterns(csv).some(p => hay.includes(normalizeForRisk(p)));
}
/** 文本是否命中任一不可逆操作词（需审批令牌；同律归一化） */
export function matchesDangerPatterns(text, csv) {
    if (!text)
        return false;
    const hay = normalizeForRisk(text);
    return (csv || DEFAULT_DANGER_PATTERNS)
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
        .some(p => hay.includes(normalizeForRisk(p)));
}
