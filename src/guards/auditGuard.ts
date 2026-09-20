// src/guards/auditGuard.ts
// 审计守卫：纯观察者，恒放行。
// 按威胁能力分类（能输入内容的 / 能触发系统快捷键的）而非按工具类型；
// 预留 DSH Approval 审批子系统的接入位 —— 人机协同的确认闸门。
import type { Context } from '@deepseek-ai/cordis';
import { onToolPre } from './hooks';

/** 审计日志脱敏：type_text 的 args 可能含凭据/验证码 —— 与 typeText 工具的
 *  [REDACTED] 锚点同律，宿主控制台不落明文秘密 */
const REDACT_KEYS = /^(text|typed_content|content|password|passwd|secret|token|api_?key)$/i;

function redactArgs(args: unknown): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    out[k] = REDACT_KEYS.test(k) ? '[REDACTED]' : v;
  }
  return out;
}

export function registerAuditGuard(ctx: Context): void {
  onToolPre(ctx, async (toolCall, next) => {
    const sensitiveActions = ['type_text', 'press_hotkey'];
    if (sensitiveActions.includes(toolCall.name)) {
      console.warn(`[Audit Guard] Sensitive action intercepted: ${toolCall.name}`, redactArgs(toolCall.args));
      // TODO: 接入 DSH Approval 子系统，挂起等待用户确认后再放行
    }
    return next();
  });
}
