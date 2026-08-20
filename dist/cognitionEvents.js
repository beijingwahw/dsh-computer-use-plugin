import { GOAL_MAX_CHARS, SUCCESS_CRITERIA_MAX_CHARS } from './orchestration/contracts.js';
/** D-1 发射、D-5/D-6/D-7 消费 —— 事件名（事件名与载荷不可分，同归 D-1 主权） */
export const COGNITION_PLAN_READY_EVENT = 'cognition/plan-ready';
/** D-1 规划器版本（世界模型溯源 —— 载荷 planVersion 字段的缺省铸造源） */
export const COGNITION_PLAN_VERSION = 'd1-planner/1';
// ─── 类型化发射表面（永不抛错 —— 发射失败是旁路义务，不阻断主流程）───
/** D-1 发射侧铸造点：意图方言载荷（delegateToPipeline 交班的唯一铸造源）。
 *  结构保证：goal ≤160 / successCriteria ≤200（对齐 D-6 契约预算 —— 不靠下游自觉）；
 *  budgetMs 域执法（风险加固）：只放行正有限数 —— 负数（秒级瞬死）/ NaN（永不超时）
 *  一旦流入 D-6 时间治理即毒化 intent 层时钟，域外值诚实缺席（undefined）。
 *  source='cognition' / planVersion 缺省铸造（世界模型溯源）。 */
export function mintIntentPlanReady(input) {
    return {
        id: input.id,
        goal: input.goal.slice(0, GOAL_MAX_CHARS),
        successCriteria: input.successCriteria?.slice(0, SUCCESS_CRITERIA_MAX_CHARS),
        budgetMs: isPositiveFinite(input.budgetMs) ? input.budgetMs : undefined,
        source: 'cognition',
        planVersion: COGNITION_PLAN_VERSION,
    };
}
/** budgetMs 域判别：正有限数才合法（时间治理的入域门票） */
function isPositiveFinite(n) {
    return typeof n === 'number' && Number.isFinite(n) && n > 0;
}
/** D-1 发射端：计划就绪信号上事件总线（联合方言任一形态皆可发射）。
 *  发射守卫：永不抛错 —— 发射失败是旁路义务，不阻断 D-1 主流程 */
export function emitCognitionPlanReady(ctx, payload) {
    try {
        ctx.emit(COGNITION_PLAN_READY_EVENT, payload);
    }
    catch { /* 旁路义务：事件面缺席/故障不毒化发射方 */ }
}
