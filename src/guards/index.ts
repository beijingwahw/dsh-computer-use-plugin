// src/guards/index.ts
// 守卫聚合入口：三轴防线（边界/熔断/审计）+ 弹窗联动，一次挂载。
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from '../config';
import { registerBoundsGuard } from './boundsGuard';
import { registerCircuitBreakerGuard } from './circuitBreakerGuard';
import { registerAuditGuard } from './auditGuard';
import { registerPopupGuard } from './popupGuard';
import { registerRepeatActionGuard } from './repeatActionGuard';
import { registerJournalGuard } from '../journal';

export { updatePopupState, getPopupState } from './popupGuard';

export function registerAllGuards(ctx: Context, config: Config): void {
  registerBoundsGuard(ctx);
  registerCircuitBreakerGuard(ctx, config.maxConsecutiveFailures);
  registerAuditGuard(ctx);
  registerPopupGuard(ctx);
  // 防死循环（第二轮创新）：原样重试无效动作 ⇒ 拦截并给出换策略指引
  registerRepeatActionGuard(ctx);
  // 行动日志观察者（突破三）：记录一切动作类调用，供审计与重放
  if (config.enableJournal) registerJournalGuard(ctx, config);
}
