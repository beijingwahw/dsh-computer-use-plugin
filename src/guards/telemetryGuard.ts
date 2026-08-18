// src/guards/telemetryGuard.ts
// 第七轮：遥测观察者 —— 纯旁路，绝不改写透传值。
// pre 记起点（WeakMap keyed by call 对象），post 结算耗时并观测。
// 若宿主在 pre/post 间不传同一 call 引用，耗时降级为 0（指标仍准确计数，仅延迟缺精度）。
// B-2：成败/noop 判定统一走 resultContract，不再嗅探序列化格式。
import type { Context } from '@deepseek-ai/cordis';
import { onToolPre, onToolPost, ToolCall } from './hooks';
import { telemetry } from '../telemetry';
import { classifyResult, isSuccess, isFailure } from '../resultContract';

export function registerTelemetryGuard(ctx: Context): void {
  const startedAt = new WeakMap<object, number>();

  onToolPre(ctx, async (call: ToolCall, next) => {
    startedAt.set(call, Date.now());
    return next();
  });

  onToolPost(ctx, async (call: ToolCall, result, next) => {
    const t0 = startedAt.get(call);
    const c = classifyResult(result);
    const status = isSuccess(c) ? 'SUCCESS' : isFailure(c) ? 'FAILED' : 'UNKNOWN';
    telemetry.observe(call.name, status, t0 ? Date.now() - t0 : 0, c.noop);
    return next(result);
  });
}
