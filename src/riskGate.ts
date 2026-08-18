// src/riskGate.ts
// 第五轮创新之二：风险感知人机协同（Risk Gate）。
// 世界级 CUA 的安全共识：凭据类输入不该由 Agent 代劳 —— Operator 遇到密码框
// 会交还控制权。本模块用两段式实现：
//   1. click_mouse 时识别敏感目标（target_description 命中风险词）⇒ 标记焦点为敏感
//   2. type_text 到敏感焦点 ⇒ 拦截，要求暂停并请用户亲自输入（绝不回显内容）
// 风险词可配置（逗号分隔），默认覆盖中英常见凭据语义。
export const DEFAULT_RISK_PATTERNS = 'password,passwd,密码,口令,验证码,verification code,2fa,otp,pin,secret,token,api key,私钥';

/** 解析逗号分隔的风险词配置 */
export function parseRiskPatterns(csv: string): string[] {
  return (csv || DEFAULT_RISK_PATTERNS)
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

/** 文本是否命中任一风险词（大小写不敏感的包含匹配） */
export function matchesRiskPatterns(text: string, csv: string): boolean {
  if (!text) return false;
  const hay = text.toLowerCase();
  return parseRiskPatterns(csv).some(p => hay.includes(p));
}
