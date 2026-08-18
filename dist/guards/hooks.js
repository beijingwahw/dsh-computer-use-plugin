export function onToolPre(ctx, handler) {
    ctx.on('tools/pre-execute', handler);
}
export function onToolPost(ctx, handler) {
    ctx.on('tools/post-execute', handler);
}
/**
 * llm 请求前注入点（原版地层中游离的「最后一块拼图」片段，此处正式接线）：
 * 无论 Agent 截了多少图，发给大模型的永远只有滑动窗口内的最新图片 + 旧图的文字占位符。
 * 事件表面同样以目标 DSH 版本为准，收口于此。
 */
export function onLlmPreRequest(ctx, handler) {
    ctx.on('llm/pre-request', handler);
}
