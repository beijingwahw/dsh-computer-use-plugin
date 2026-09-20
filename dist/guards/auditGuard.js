import { onToolPre } from './hooks.js';
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
            console.warn(`[Audit Guard] Sensitive action intercepted: ${toolCall.name}`, redactArgs(toolCall.args));
            // TODO: 接入 DSH Approval 子系统，挂起等待用户确认后再放行
        }
        return next();
    });
}
