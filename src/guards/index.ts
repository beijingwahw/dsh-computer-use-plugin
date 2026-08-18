// src/guards/index.ts
// 守卫聚合入口：三轴防线（边界/熔断/审计）+ 弹窗联动，一次挂载。
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from '../config';
import { registerBoundsGuard } from './boundsGuard';
import { registerCircuitBreakerGuard } from './circuitBreakerGuard';
import { registerAuditGuard } from './auditGuard';
import { registerPopupGuard } from './popupGuard';

export { updatePopupState, getPopupState } from './popupGuard';

export function registerAllGuards(ctx: Context, config: Config): void {
  registerBoundsGuard(ctx);
  registerCircuitBreakerGuard(ctx, config.maxConsecutiveFailures);
  registerAuditGuard(ctx);
  registerPopupGuard(ctx);
}
