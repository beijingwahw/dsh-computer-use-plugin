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
export const DEFAULT_DANGER_PATTERNS =
  'send,发送,delete,删除,remove,移除,pay,支付,付款,buy,购买,checkout,结算,下单,submit order,提交订单,' +
  'confirm,确认订单,format,格式化,erase,抹掉,uninstall,卸载,reset,重置,清空,withdraw,提现,transfer,转账';

/** 解析逗号分隔的风险词配置（空串回退 fallback） */
export function parseRiskPatterns(csv: string, fallback: string = DEFAULT_RISK_PATTERNS): string[] {
  return (csv || fallback)
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

// ─── E-6 混淆免疫（第五维·信息热力学）：归一化对抗视觉混淆 ───

/** leet 还原表：人类可读、机器漏检的视觉同形混淆（0↔o、1↔l、@↔a…）。
 *  算法形状字面量 —— 覆盖常见凭据字段混淆；完整 homoglyph 表（西里尔 а 等）
 *  是留白（NFKC 归一化 + Unicode 同形映射，需真实语料定标）。 */
const LEET_MAP: Record<string, string> = {
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
const HOMOGLYPH_MAP: Record<string, string> = {
  // 西里尔（视觉同形拉丁）
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0441': 'c', '\u0440': 'p',
  '\u0445': 'x', '\u0443': 'y', '\u0456': 'i', '\u0455': 's', '\u04bb': 'h',
  '\u0501': 'd', '\u0497': 'g', '\u04cf': 'l', '\u04e3': 'm', '\u0439': 'u',
  '\u0458': 'j', '\u0463': 'y', '\u051b': 'q',
  // 希腊
  '\u03b1': 'a', '\u03bf': 'o', '\u03c1': 'p', '\u03b5': 'e', '\u03b9': 'i',
  '\u03ba': 'k', '\u03bc': 'm', '\u03bd': 'v', '\u03c4': 't', '\u03c7': 'x',
  // 全角字母数字（FF21-FF3A/FF41-FF5A/FF10-FF19 策展）
  '\uff41': 'a', '\uff42': 'b', '\uff43': 'c', '\uff44': 'd', '\uff45': 'e',
  '\uff46': 'f', '\uff47': 'g', '\uff48': 'h', '\uff49': 'i', '\uff4a': 'j',
  '\uff4b': 'k', '\uff4c': 'l', '\uff4d': 'm', '\uff4e': 'n', '\uff4f': 'o',
  '\uff50': 'p', '\uff51': 'q', '\uff52': 'r', '\uff53': 's', '\uff54': 't',
  '\uff55': 'u', '\uff56': 'v', '\uff57': 'w', '\uff58': 'x', '\uff59': 'y', '\uff5a': 'z',
  '\uff10': '0', '\uff11': '1', '\uff12': '2', '\uff13': '3', '\uff14': '4',
  '\uff15': '5', '\uff16': '6', '\uff17': '7', '\uff18': '8', '\uff19': '9',
};

function normalizeForRisk(s: string): string {
  let out = '';
  for (const ch of s.toLowerCase()) {
    if (LEET_MAP[ch] !== undefined) { out += LEET_MAP[ch]; continue; }
    if (HOMOGLYPH_MAP[ch] !== undefined) { out += HOMOGLYPH_MAP[ch]; continue; }
    if (/[\s\u200b\u200c\u200d\p{P}\p{S}]/u.test(ch)) continue; // 空白/零宽/标点/符号全剥
    out += ch;
  }
  return out;
}

/** 文本是否命中任一风险词（混淆免疫：归一化后包含匹配） */
export function matchesRiskPatterns(text: string, csv: string): boolean {
  if (!text) return false;
  const hay = normalizeForRisk(text);
  return parseRiskPatterns(csv).some(p => hay.includes(normalizeForRisk(p)));
}

/** 文本是否命中任一不可逆操作词（需审批令牌；同律归一化） */
export function matchesDangerPatterns(text: string, csv: string): boolean {
  if (!text) return false;
  const hay = normalizeForRisk(text);
  return parseRiskPatterns(csv, DEFAULT_DANGER_PATTERNS)
    .some(p => hay.includes(normalizeForRisk(p)));
}
