import { onToolPre } from './hooks.js';
export function registerAuditGuard(ctx) {
    onToolPre(ctx, async (toolCall, next) => {
        const sensitiveActions = ['type_text', 'press_hotkey'];
        if (sensitiveActions.includes(toolCall.name)) {
            console.warn(`[Audit Guard] Sensitive action intercepted: ${toolCall.name}`, toolCall.args);
            // TODO: 接入 DSH Approval 子系统，挂起等待用户确认后再放行
        }
        return next();
    });
}
