// src/resultContract.ts
// B-2 统一结果契约解析器：全系统唯一的工具成败判定入口。
//
// 根因（诊断书 F-2）：熔断/遥测/日志三处曾用 `result.includes('"status": "FAILED"')`
// 嗅探字符串 —— 依赖 JSON.stringify(x, null, 2) 的缩进空格这一「格式巧合」。
// 任何工具改用紧凑格式，三个守卫将静默失明（不报错，只是不再计数）。
//
// 本模块把契约从「字符串巧合」升格为「类型事实」：
//   1. 优先 JSON.parse 读取强类型 obj.status 字段（锚点协议，B-4 起全工具覆盖）；
//   2. 解析失败回退前缀协议（[Error] / [System]，历史遗留工具的过渡通道）；
//   3. noop 判定：报 SUCCESS 且 effect.detected === false（动作完成但屏幕无变化）。
//
// 消费者：circuitBreakerGuard / telemetryGuard / journal(registerJournalGuard)。
// 新增状态枚举（如 PENDING_USER_CONSENT）只需在此登记映射，三消费者自动兼容。
/** 判定结果是否代表「执行失败」（熔断计数、失败记忆的语义） */
export function isFailure(c) {
    return c.status === 'FAILED';
}
/** 判定结果是否代表「执行成功」（熔断重置、遥测计数的语义） */
export function isSuccess(c) {
    return c.status === 'SUCCESS';
}
export function classifyResult(raw) {
    if (typeof raw !== 'string')
        return { status: 'UNKNOWN', noop: false };
    // 主通道：锚点 JSON 的强类型 status 字段（不依赖任何序列化格式细节）
    try {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object' && typeof obj.status === 'string') {
            const status = normalizeStatus(obj.status);
            const effectDetected = obj?.state_anchor?.effect?.detected ??
                obj?.effect?.detected;
            const noop = status === 'SUCCESS' && effectDetected === false;
            return { status, noop, effectDetected };
        }
    }
    catch { /* 非 JSON，走前缀协议回退 */ }
    // 回退通道：前缀协议（B-4 改造完成前的历史工具格式）
    if (raw.includes('[Error]'))
        return { status: 'FAILED', noop: false };
    if (raw.includes('[System]'))
        return { status: 'SUCCESS', noop: false };
    return { status: 'UNKNOWN', noop: false };
}
function normalizeStatus(s) {
    switch (s) {
        case 'SUCCESS':
        case 'FAILED':
        case 'ACTION_REQUIRED':
        case 'PENDING_USER_CONSENT':
            return s;
        default:
            return 'UNKNOWN';
    }
}
