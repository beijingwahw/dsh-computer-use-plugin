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
    // ── ΝΩ-2（审计 WAL 顺序倒置修复）：拦截守卫先于 auditGuard 注册 ──
    // 事件瀑布的注册序即执行序。旧序 audit(L25) 先于 popup/repeatAction/canary：
    // 后者拦截调用（不调 next）时，「即将派发」的 AUDIT_PRE WAL 行已同步落盘，
    // 链上留下有意图无动作的幽灵审计行 —— 回滚系统按 WAL 对账会对从未发生的
    // 动作执行回滚。两案取舍（选 a，论证如下）：
    //  (a) 挪序（本实现）：audit 的 pre-WAL 提交移到全部拦截守卫之后。只有通过
    //      全部拦截判定的动作才提交「将派发」审计行，幽灵行在构造上不可再产生；
    //      「审计先行于派发」的 W2-2 fail-closed 语义不变 —— audit 仍在工具
    //      execute 之前提交（拦截守卫全部 next 放行后才轮到 audit）。代价权衡：
    //      · canary 在 audit 之前物理试演（可逆微探针先触世界）：探针派发自带
    //        ΑΩ-R4 的 GUARD_PROBE fail-open 审计行，防篡改轨迹不断链 —— 审计的
    //        是「动作将派发」而非「守卫在侦查」，语义各自成立；
    //      · audit fail-closed 拒派时 canary 预算已记账（计数先于探针是既有设计
    //        —— 并发/失败皆不超支）：罕见的审计通道故障多花一次预算，不构成
    //        正确性问题；
    //      · 被拦截动作的留痕走各自既有观察面而非 AUDIT_PRE（语义是「被拦截」
    //        而非「将派发」）：canary 拦截 ⇒ 事件环/遥测/approval.request +
    //        探针 GUARD_PROBE 行；熔断拦截 ⇒ GUARD_BLOCKED 入链（circuitBreaker
    //        先于 audit，本就无幽灵行）；popup/repeat ⇒ console.warn + hooks 的
    //        guard:<tool> deny 计数。
    //  (b) 保留旧序 + 被拦截时追加 GUARD_BLOCKED 对冲行：需要 popup/repeatAction
    //      在拦截分支补 journal 写入（两文件不在本工单修改面）；且崩溃窗口内
    //      （AUDIT_PRE 已落、拦截判定未落）幽灵行与「已派发未回执」不可区分，
    //      配对对账仍是启发式 —— 弃。
    registerPopupGuard(ctx);
    // 防死循环（第二轮创新）：原样重试无效动作 ⇒ 拦截并给出换策略指引
    registerRepeatActionGuard(ctx);
    // W2-7（R4 高风险链前金丝雀试演）：pre-execute 的可逆微探针 —— 认识论放行
    // 的高代价动作（proceed×high）物理执行前向世界核对反事实预测；探针端口
    // 缺席/失败一律降级放行（可用性优先），destructive 档豁免直审批
    registerCanaryGuard(ctx, config);
    registerAuditGuard(ctx);
    // W1-6（R1 鉴别试验）：post-execute 失败分支的根因归因（纯旁路观察者 ——
    // 熔断器管「该不该停」，它管「为什么败」；探针缺席自动降级，绝不阻塞）
    registerRootCauseGuard(ctx, config);
    // 行动日志观察者（突破三）：记录一切动作类调用，供审计与重放
    if (config.enableJournal)
        registerJournalGuard(ctx, config);
    // 遥测观察者（第七轮）：纯旁路指标采集，绝不改写结果
    if (config.enableTelemetry)
        registerTelemetryGuard(ctx);
}
