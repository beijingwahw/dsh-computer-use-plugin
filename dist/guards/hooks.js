import { telemetry } from '../telemetry.js';
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
/**
 * rc.6 ToolExecutionResult → 旧字符串值语义（守卫的 resultContract 解析面）。
 * ΑΩ-R16：本函数是全库唯一实现（事件表面适配层的正主）——telemetryGuard 曾
 * 按「别簇所有」纪律私有镜像一份（行为逐行相同），两份实现仅靠注释锚定，
 * 宿主事件表面再演进时漏改一份的风险真实存在；现收口为单源导出，改只改此处。
 */
export function extractResultValue(result) {
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
        // 纪元 Σ（Σ-7 遥测仪表盘）：deny 分支守卫拦截打点 —— 守卫返回字符串即拦截
        // （与下方 toPreDecision 的 deny 转译同判）。counter 键 'guard:<工具名>'，
        // note(counter, hit=false) 的语义即「未放行」；纯旁路：note 绝不抛、不改写
        // 转译结果（metrics_dashboard 守卫区消费此计数）。
        if (typeof out === 'string' && call.name !== '')
            telemetry.note('guard:' + call.name, false);
        return toPreDecision(out);
    });
}
export function onToolPost(ctx, handler) {
    ctx.on('tools/post-execute', async (exec, result, next) => {
        const call = normalizeExec(exec);
        // W6-3：透传 next 实参。旧包装 `() => next()` 丢弃守卫递给 next 的改写值
        // （circuitBreaker 第 1/2 败的 appendHint 递进提示经 next(改写值) 回传宿主，
        // 实参被丢 ⇒ 改写值永不可达 —— w2recovery 接线节注登记的遗留）。透传后：
        // 守卫 next(v) ⇒ 宿主 next(v)；守卫无参 next() ⇒ 宿主收 undefined
        // （诚实缺省，零伪造）。pre 包装维持原样：现有 pre 守卫全部无参调用 next
        // （bounds/popup/audit/canary/repeatAction 遍历验证），不构成实害，最小变更。
        const out = await handler(call, extractResultValue(result), (value) => next(value));
        return toPostDecision(out);
    });
}
/**
 * llm 请求前注入点（旧表面）：rc.6 起事件已不存在 —— 图像注入由
 * imageDelivery（附件服务 + 工具结果 image 块）承担。保留挂载以兼容
 * 仍发射该事件的宿主版本；永远不会触发时无害。
 *
 * ΝΩ-3 单源投递立法：新宿主走附件，旧宿主走滑窗 —— 两通道绝不对同一请求
 * 双投图像。挂载方（见 src/index.ts 第 6 步接线）注入图片前必须先探测
 * imageDeliveryAvailable()（附件服务在场性）：在场 ⇒ 滑窗注入闸门关闭
 * （文本锚点已由工具结果携带）。本函数保持纯挂载面，不代行探测 ——
 * 策略归调用方，挂载归此处（单一职责，宿主事件面再演进时只改一处）。
 */
export function onLlmPreRequest(ctx, handler) {
    ctx.on('llm/pre-request', handler);
}
