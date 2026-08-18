// src/guards/auditGuard.ts
// 审计守卫：纯观察者，恒放行。
// 按威胁能力分类（能输入内容的 / 能触发系统快捷键的）而非按工具类型；
// 预留 DSH Approval 审批子系统的接入位 —— 人机协同的确认闸门。
import type { Context } from '@deepseek-ai/cordis';
import { onToolPre } from './hooks';

export function registerAuditGuard(ctx: Context): void {
  onToolPre(ctx, async (toolCall, next) => {
    const sensitiveActions = ['type_text', 'press_hotkey'];
    if (sensitiveActions.includes(toolCall.name)) {
      console.warn(`[Audit Guard] Sensitive action intercepted: ${toolCall.name}`, toolCall.args);
      // TODO: 接入 DSH Approval 子系统，挂起等待用户确认后再放行
    }
    return next();
  });
}
