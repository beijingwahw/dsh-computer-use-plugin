import { onToolPre, onToolPost } from './hooks.js';
import { telemetry } from '../telemetry.js';
import { classifyResult, isSuccess, isFailure } from '../resultContract.js';
export function registerTelemetryGuard(ctx) {
    const startedAt = new WeakMap();
    onToolPre(ctx, async (call, next) => {
        startedAt.set(call, Date.now());
        return next();
    });
    onToolPost(ctx, async (call, result, next) => {
        const t0 = startedAt.get(call);
        const c = classifyResult(result);
        const status = isSuccess(c) ? 'SUCCESS' : isFailure(c) ? 'FAILED' : 'UNKNOWN';
        telemetry.observe(call.name, status, t0 ? Date.now() - t0 : 0, c.noop);
        return next(result);
    });
}
