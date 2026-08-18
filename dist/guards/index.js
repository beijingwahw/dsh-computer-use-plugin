import { registerBoundsGuard } from './boundsGuard.js';
import { registerCircuitBreakerGuard } from './circuitBreakerGuard.js';
import { registerAuditGuard } from './auditGuard.js';
import { registerPopupGuard } from './popupGuard.js';
import { registerRepeatActionGuard } from './repeatActionGuard.js';
import { registerTelemetryGuard } from './telemetryGuard.js';
import { registerJournalGuard } from '../journal.js';
export { updatePopupState, getPopupState } from './popupGuard.js';
export { onToolPre, onToolPost, onLlmPreRequest } from './hooks.js';
export function registerAllGuards(ctx, config) {
    registerBoundsGuard(ctx);
    registerCircuitBreakerGuard(ctx, config.maxConsecutiveFailures);
    registerAuditGuard(ctx);
    registerPopupGuard(ctx);
    // 防死循环（第二轮创新）：原样重试无效动作 ⇒ 拦截并给出换策略指引
    registerRepeatActionGuard(ctx);
    // 行动日志观察者（突破三）：记录一切动作类调用，供审计与重放
    if (config.enableJournal)
        registerJournalGuard(ctx, config);
    // 遥测观察者（第七轮）：纯旁路指标采集，绝不改写结果
    if (config.enableTelemetry)
        registerTelemetryGuard(ctx);
}
