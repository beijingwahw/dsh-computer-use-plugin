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
// ── ΠΑΝ-79（C2-1 F11）：守卫总兜底（fault wall）──
//
// 病灶：适配层裸调 `await handler(...)`，无 try/catch —— 守卫的「绝不抛」
// 纪律全靠各文件自觉（bounds/popup/repeatAction/circuitBreaker 的主体没有
// 内层 try，如 repeatActionGuard 的 JSON.stringify(args) 对病态 args 可抛）。
// 一旦抛出，异常进入宿主事件链：放行/拒绝语义取决于宿主兜底 —— 不可论证
// （「守卫挂了谁守卫」没有答案）。
//
// 修法：pre/post 两包装各设总 catch —— 守卫 handler 异常**绝不阻断主流程**
// （可用性优先的 fail-open：一个守卫的 bug 不能瘫痪整个 Agent 的工具面），
// 但必须**记账 + 计数告警，绝不静默**（遥测计数器 guard:handler-crash +
// 控制台告警行；记账面自身故障则到此为止，绝不抛）。
//
// next 单次闸（双重驱动防线）：守卫可能已内部调用 next()（瀑布已续行）之后
// 才抛错 —— 此时若在 catch 里再驱动 next()，下游守卫/宿主执行体会双跑。
// 故 onceNext 标记消费事实：next 已被消费 ⇒ 异常属下游自身故障（经 handler
// 帧上抛），如实重抛交宿主处置（不吞、不双驱）；next 未消费 ⇒ 守卫自身
// 故障，fail-open 放行。
function guardFaultAccounted(phase, call, e) {
    try {
        const msg = e instanceof Error ? e.message : String(e);
        telemetry.note('guard:handler-crash', false); // 计数告警（Σ-7 语义：false = 未放行守卫面）
        console.warn(`[Guards] handler crash (${phase}, tool=${call.name || '?'}) — fail-open, main flow NOT blocked: ${msg}`);
    }
    catch { /* 记账面故障：吞（放行主流程优先，绝不抛） */ }
}
export function onToolPre(ctx, handler) {
    ctx.on('tools/pre-execute', async (exec, next) => {
        const call = normalizeExec(exec);
        let nextUsed = false; // ΠΑΝ-79：next 单次闸（见 guardFaultAccounted 头注）
        // 形参兼容（value 收而不用）：PreExecuteHandler.next 的签名是 (value?) => any，
        // rc.6 pre 宿主 next 不收参（现有 pre 守卫全部无参调用 —— 遍历验证过）。
        const onceNext = (_value) => { nextUsed = true; return next(); };
        try {
            const out = await handler(call, onceNext);
            // 纪元 Σ（Σ-7 遥测仪表盘）：deny 分支守卫拦截打点 —— 守卫返回字符串即拦截
            // （与下方 toPreDecision 的 deny 转译同判）。counter 键 'guard:<工具名>'，
            // note(counter, hit=false) 的语义即「未放行」；纯旁路：note 绝不抛、不改写
            // 转译结果（metrics_dashboard 守卫区消费此计数）。
            if (typeof out === 'string' && call.name !== '')
                telemetry.note('guard:' + call.name, false);
            return toPreDecision(out);
        }
        catch (e) {
            if (nextUsed)
                throw e; // 下游异常归下游（经 handler 帧上抛：不吞不双驱）
            guardFaultAccounted('pre', call, e);
            return toPreDecision(await onceNext()); // ΠΑΝ-79：守卫故障 fail-open 放行主流程
        }
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
        const value = extractResultValue(result);
        let nextUsed = false; // ΠΑΝ-79：next 单次闸（见 guardFaultAccounted 头注）
        const onceNext = (v) => { nextUsed = true; return next(v); };
        try {
            const out = await handler(call, value, onceNext);
            return toPostDecision(out);
        }
        catch (e) {
            if (nextUsed)
                throw e; // 下游异常归下游（经 handler 帧上抛：不吞不双驱）
            guardFaultAccounted('post', call, e);
            return toPostDecision(await onceNext(value)); // ΠΑΝ-79：守卫故障 ⇒ 原结果透传（零伪造）
        }
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
