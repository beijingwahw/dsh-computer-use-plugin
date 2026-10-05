// src/rollbackPlanner.trace.ts
// ΠΑΝ-127（D-F5 清偿）：回滚轨迹契约下沉叶 —— 桶（rollbackPlanner.ts）与卫星
// （rollbackPlanner.plan.ts）双双消费的 RollbackTraceStep/sanitizeTrace/
// ROLLBACK_BUDGET_STEPS 曾住在桶里，构成桶-卫星 value 二环（W6-2 分区提取
// 残留互指）。按「常量/契约下沉零出边基座」方言拆环：共享契约入住本叶（零
// 出边），桶与卫星皆改 import 本叶；桶面原符号 re-export 保兼容（导入面零
// 破坏）。行为零变化 —— 纯结构搬家，函数体逐字保留。
/** 回滚步数预算：回滚是「退回良好态」的偿债，不是无限重试 —— 12 步与
 *  W3-6 换支重放预算同量级（branchCards.BRANCH_REPLAY_BUDGET_STEPS=12，
 *  同为「第二尝试不继承全额」原则）。 */
export const ROLLBACK_BUDGET_STEPS = 12;
/** 轨迹步数上限（防御：脏调用方塞巨数组不得拖垮定位 —— 有界计算）。 */
const TRACE_HARD_CAP = 10_000;
/** 防御净化：脏步收敛（tool 非字符串 ⇒ 整步弃置 —— 不把噪声当轨迹） */
export function sanitizeTrace(steps) {
    const out = [];
    if (!Array.isArray(steps))
        return out;
    for (const s of steps.slice(0, TRACE_HARD_CAP)) {
        if (!s || typeof s !== 'object' || typeof s.tool !== 'string' || s.tool === '')
            continue;
        const c = s;
        out.push({
            tool: c.tool.slice(0, 64),
            ...(typeof c.status === 'string' ? { status: c.status.slice(0, 32) } : {}),
            ...(typeof c.effect_detected === 'boolean' ? { effect_detected: c.effect_detected } : {}),
            ...(c.args && typeof c.args === 'object' && !Array.isArray(c.args) ? { args: c.args } : {}),
            ...(typeof c.fingerprint === 'string' && c.fingerprint !== '' ? { fingerprint: c.fingerprint.slice(0, 256) } : {}),
        });
    }
    return out;
}
