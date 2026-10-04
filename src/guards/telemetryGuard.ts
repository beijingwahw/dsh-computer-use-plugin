// src/guards/telemetryGuard.ts
// 第七轮：遥测观察者 —— 纯旁路，绝不改写透传值。
// pre 记起点（WeakMap keyed by call 对象），post 结算耗时并观测。
// B-2：成败/noop 判定统一走 resultContract，不再嗅探序列化格式。
//
// Δ 纪元（安全外围#3）：延迟指标恒 0 的根除。旧实现经 hooks.onToolPre/
// onToolPost 拿到的是 normalizeExec **每事件新建**的归一化对象 —— WeakMap 按
// 归一化对象为键，pre 的键与 post 的键永不相同 ⇒ duration 恒 0，全部 P50/P95
// 失真（指标仍计数，只是延迟维度失明）。修法：直接挂原始事件，以**原始 exec
// 引用**为键（pre/post 事件对同一 ToolExecution 对象发射）；观察者语义不变：
// 结果值提取直接 import hooks 导出的 extractResultValue 正主（ΑΩ-R16 单源化：
// 旧私有镜像已删，两份实现漂移的隐患根除；「绕过 normalizeExec 挂原始事件」
// 的设计不变 —— 只单源化函数，不改挂载方式）。
import type { Context } from '@deepseek-ai/cordis';
import { telemetry } from '../telemetry';
import { classifyResult, isSuccess, isFailure } from '../resultContract';
import { extractResultValue } from './hooks';

export function registerTelemetryGuard(ctx: Context): void {
  const startedAt = new WeakMap<object, number>();

  // 原始事件挂载（不经 normalizeExec —— 归一化对象每事件新建，按其为键永不命中）：
  // rc.6 表面 exec 为 ToolExecution（.name/.arguments）；旧表面（≤rc.5）exec 为
  // {name, args} —— 两种表面的 .name 均在原始对象上，无需归一化即可观察。
  (ctx as any).on('tools/pre-execute', async (exec: any, next: () => Promise<any>) => {
    if (exec != null && typeof exec === 'object') startedAt.set(exec, Date.now());
    return next(); // 纯观察：不拦截、不改写，原样放行
  });

  (ctx as any).on('tools/post-execute', async (exec: any, result: any, next: (v: any) => Promise<any>) => {
    // 结算耗时：以原始 exec 引用查表 —— pre 与 post 拿到的是同一对象 ⇒ 命中。
    // 宿主若对 post 复制 exec（非同一引用），降级为 0（计数仍准确，仅延迟缺精度）。
    const t0 = exec != null && typeof exec === 'object' ? startedAt.get(exec) : undefined;
    const c = classifyResult(extractResultValue(result));
    const status = isSuccess(c) ? 'SUCCESS' : isFailure(c) ? 'FAILED' : 'UNKNOWN';
    telemetry.observe(
      typeof exec?.name === 'string' ? exec.name : '',
      status,
      t0 !== undefined ? Date.now() - t0 : 0,
      c.noop,
    );
    return next(result); // 原始 result 透传（观察者绝不改写透传值）
  });
}
