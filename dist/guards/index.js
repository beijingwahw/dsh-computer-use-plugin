import { registerBoundsGuard } from './boundsGuard.js';
import { registerCircuitBreakerGuard } from './circuitBreakerGuard.js';
import { registerAuditGuard } from './auditGuard.js';
import { registerPopupGuard } from './popupGuard.js';
import { registerRepeatActionGuard } from './repeatActionGuard.js';
import { registerTelemetryGuard } from './telemetryGuard.js';
import { registerRootCauseGuard } from './rootCauseGuard.js'; // W1-6（R1）：失败根因归因守卫
import { registerCanaryGuard } from './canaryGuard.js'; // W2-7（R4）：高风险链前金丝雀试演守卫
import { registerJournalGuard } from '../journal.js';
export { updatePopupState, getPopupState } from './popupGuard.js';
export { onToolPre, onToolPost, onLlmPreRequest } from './hooks.js';
// W1-6（R1）：根因归因观察面（诊断面板 / 测试）
export { recentRootCauseReports, resetRootCauseGuard } from './rootCauseGuard.js';
// W2-7（R4）：金丝雀试演观察面（事件环 / 预算账本 / 测试隔离）
export { recentCanaryEvents, canaryBudgetSnapshot, resetCanaryGuard } from './canaryGuard.js';
export function registerAllGuards(ctx, config) {
    registerBoundsGuard(ctx);
    registerCircuitBreakerGuard(ctx, config.maxConsecutiveFailures);
    registerAuditGuard(ctx);
    registerPopupGuard(ctx);
    // 防死循环（第二轮创新）：原样重试无效动作 ⇒ 拦截并给出换策略指引
    registerRepeatActionGuard(ctx);
    // W1-6（R1 鉴别试验）：post-execute 失败分支的根因归因（纯旁路观察者 ——
    // 熔断器管「该不该停」，它管「为什么败」；探针缺席自动降级，绝不阻塞）
    registerRootCauseGuard(ctx, config);
    // W2-7（R4 高风险链前金丝雀试演）：pre-execute 的可逆微探针 —— 认识论放行
    // 的高代价动作（proceed×high）物理执行前向世界核对反事实预测；探针端口
    // 缺席/失败一律降级放行（可用性优先），destructive 档豁免直审批
    registerCanaryGuard(ctx, config);
    // 行动日志观察者（突破三）：记录一切动作类调用，供审计与重放
    if (config.enableJournal)
        registerJournalGuard(ctx, config);
    // 遥测观察者（第七轮）：纯旁路指标采集，绝不改写结果
    if (config.enableTelemetry)
        registerTelemetryGuard(ctx);
}
