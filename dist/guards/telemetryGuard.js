import { telemetry } from '../telemetry.js';
import { classifyResult, isSuccess, isFailure } from '../resultContract.js';
import { extractResultValue } from './hooks.js';
export function registerTelemetryGuard(ctx) {
    const startedAt = new WeakMap();
    // 原始事件挂载（不经 normalizeExec —— 归一化对象每事件新建，按其为键永不命中）：
    // rc.6 表面 exec 为 ToolExecution（.name/.arguments）；旧表面（≤rc.5）exec 为
    // {name, args} —— 两种表面的 .name 均在原始对象上，无需归一化即可观察。
    ctx.on('tools/pre-execute', async (exec, next) => {
        if (exec != null && typeof exec === 'object')
            startedAt.set(exec, Date.now());
        return next(); // 纯观察：不拦截、不改写，原样放行
    });
    ctx.on('tools/post-execute', async (exec, result, next) => {
        // 结算耗时：以原始 exec 引用查表 —— pre 与 post 拿到的是同一对象 ⇒ 命中。
        // 宿主若对 post 复制 exec（非同一引用），降级为 0（计数仍准确，仅延迟缺精度）。
        const t0 = exec != null && typeof exec === 'object' ? startedAt.get(exec) : undefined;
        const c = classifyResult(extractResultValue(result));
        const status = isSuccess(c) ? 'SUCCESS' : isFailure(c) ? 'FAILED' : 'UNKNOWN';
        telemetry.observe(typeof exec?.name === 'string' ? exec.name : '', status, t0 !== undefined ? Date.now() - t0 : 0, c.noop);
        return next(result); // 原始 result 透传（观察者绝不改写透传值）
    });
}
