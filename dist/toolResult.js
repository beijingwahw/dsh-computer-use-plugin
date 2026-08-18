// src/toolResult.ts
// B-4 锚点结果工厂：反幻觉基因的全工具覆盖。
//
// 根因（诊断书 E-3）：9 个工具返回裸 '[System]:' / '[Error]:' 前缀字符串 ——
// 无 state_anchor（当前绝对状态）、无 next_step（下一步验证逻辑），
// 模型在这些工具上处于「无记忆盲区」。
//
// 本工厂统一产出四件套：{ status, action, state_anchor, next_step }。
// 与 resultContract（B-2）配套：工厂是唯一「写」方，解析器是唯一「读」方。
// 禁止工具手写 JSON.stringify({status:...}) —— 格式演化只改这一处。
/**
 * 成功结果：状态 + 动作描述 + 状态锚点 + 下一步指引
 * @param action    人类可读的动作描述（做了什么）
 * @param anchor    状态锚点：动作后的绝对世界状态（坐标/分辨率/效果验证...）
 * @param nextStep  下一步验证逻辑：告诉模型如何确认此动作生效
 */
export function toolOk(action, anchor, nextStep) {
    return JSON.stringify({
        status: 'SUCCESS',
        action,
        state_anchor: anchor,
        next_step: nextStep,
    }, null, 2);
}
/**
 * 失败结果：结构化错误 + 恢复指引
 * @param action   尝试的动作
 * @param error    错误事实（不含堆栈，模型不需要）
 * @param nextStep 恢复路径：换模态/重定位/放弃的具体建议
 */
export function toolErr(action, error, nextStep) {
    return JSON.stringify({
        status: 'FAILED',
        action,
        state_anchor: { error },
        next_step: nextStep,
    }, null, 2);
}
/**
 * 需外部介入的结果（审批/凭据/熔断类）：动作被安全系统暂停
 * @param reason    暂停原因标识（irreversible-action / sensitive-field ...）
 * @param anchor    触发暂停的世界状态
 * @param nextStep  用户协同流程指引
 */
export function toolActionRequired(reason, anchor, nextStep) {
    return JSON.stringify({
        status: 'ACTION_REQUIRED',
        state_anchor: { reason, ...anchor },
        next_step: nextStep,
    }, null, 2);
}
