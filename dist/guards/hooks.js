/** rc.6 ToolExecution → 旧 ToolCall 形状（arguments 已是解析对象；防御字符串） */
function normalizeExec(exec) {
    let args = exec?.arguments ?? {};
    if (typeof args === 'string') {
        try {
            args = JSON.parse(args || '{}');
        }
        catch {
            args = {};
        }
    }
    const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id;
    return {
        name: exec?.name ?? '',
        args: args,
        ...(sessionId ? { sessionId: String(sessionId) } : {}),
    };
}
/** rc.6 ToolExecutionResult → 旧字符串值语义（守卫的 resultContract 解析面） */
function extractResultValue(result) {
    if (result == null || typeof result === 'string')
        return result;
    if (result.isError === true) {
        // 失败臂：错误文本（circuitBreaker 的失败计数依赖可解析的失败签名）
        const content = Array.isArray(result.content)
            ? result.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
            : '';
        return content || (result.error ? `[Error]: ${JSON.stringify(result.error).slice(0, 300)}` : '[Error]');
    }
    if ('value' in result)
        return result.value;
    if (Array.isArray(result.content)) {
        return result.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
    }
    return result;
}
/** 旧拦截语义（返回字符串）→ rc.6 PreToolDecision deny */
function toPreDecision(out) {
    if (typeof out === 'string')
        return { kind: 'deny', reason: out };
    return out; // next() 的返回（decision 对象）原样透传
}
/** 旧改写语义（返回字符串 result）→ rc.6 PostToolDecision accept+content */
function toPostDecision(out) {
    if (typeof out === 'string') {
        return { kind: 'accept', content: [{ type: 'text', text: out }] };
    }
    return out;
}
export function onToolPre(ctx, handler) {
    ctx.on('tools/pre-execute', async (exec, next) => {
        const call = normalizeExec(exec);
        const out = await handler(call, () => next());
        return toPreDecision(out);
    });
}
export function onToolPost(ctx, handler) {
    ctx.on('tools/post-execute', async (exec, result, next) => {
        const call = normalizeExec(exec);
        const out = await handler(call, extractResultValue(result), () => next());
        return toPostDecision(out);
    });
}
/**
 * llm 请求前注入点（旧表面）：rc.6 起事件已不存在 —— 图像注入由
 * imageDelivery（附件服务 + 工具结果 image 块）承担。保留挂载以兼容
 * 仍发射该事件的宿主版本；永远不会触发时无害。
 */
export function onLlmPreRequest(ctx, handler) {
    ctx.on('llm/pre-request', handler);
}
