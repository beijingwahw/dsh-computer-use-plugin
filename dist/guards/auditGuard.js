import { onToolPre } from './hooks.js';
import { matchesRiskPatterns } from '../riskGate.js';
/** 审计日志脱敏：type_text 的 args 可能含凭据/验证码 —— 与 typeText 工具的
 *  [REDACTED] 锚点同律，宿主控制台不落明文秘密 */
const REDACT_KEYS = /^(text|typed_content|content|password|passwd|secret|token|api_?key)$/i;
function redactArgs(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args))
        return args;
    const out = {};
    for (const [k, v] of Object.entries(args)) {
        if (REDACT_KEYS.test(k)) {
            out[k] = '[REDACTED]'; // 敏感键：无论标量/数组/对象，整值脱敏（J 纪元：数组不再原样放行）
        }
        else if (v && typeof v === 'object' && !Array.isArray(v)) {
            out[k] = redactArgs(v); // 嵌套一层同律（深层结构递归，环由 JSON.stringify 天然拒绝）
        }
        else {
            out[k] = v;
        }
    }
    return out;
}
export function registerAuditGuard(ctx) {
    onToolPre(ctx, async (toolCall, next) => {
        const sensitiveActions = ['type_text', 'press_hotkey'];
        if (sensitiveActions.includes(toolCall.name)) {
            // L 纪元：TODO 兑现 —— 审计行消费 J 纪元 risk/approval 体系语境：
            //   凭据语义文本 ⇒ 标注风险闸门将要求人工输入（挂起点在 typeText 工具内）；
            //   click 类危险操作的令牌核验在 click_mouse 内（grant 前置）。
            //   审计不拦截（旁路观察者），但把"安全系统接下来会做什么"写进审计轨迹。
            const args = toolCall.args;
            const text = typeof args?.text === 'string' ? args.text : '';
            const risk = matchesRiskPatterns(text, 'password,passwd,密码,验证码,verification code,2fa,otp,secret,token,api key')
                ? ' [risk: credential-like — risk gate will demand human input]'
                : '';
            console.warn(`[Audit Guard] Sensitive action intercepted: ${toolCall.name}${risk}`, redactArgs(args));
        }
        return next();
    });
}
