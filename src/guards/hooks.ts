// src/guards/hooks.ts
// 工具管线事件挂载的唯一转换点。
// DSH 事件表面（名称/签名）随版本迭代，各子系统页的 cordis-surface 生成清单是唯一事实源；
// 集中一个 as any 收口，避免散落各处的类型逃逸 —— 换 DSH 版本时只改这一个文件。
import type { Context } from '@deepseek-ai/cordis';

export interface ToolCall {
  name: string;
  args: Record<string, any>;
}

/** waterfall 语义：不调用 next() 即短路拦截 —— 拒绝的同时给出改正方向 */
export type PreExecuteHandler = (
  call: ToolCall,
  next: (value?: any) => any,
) => Promise<any> | any;

export type PostExecuteHandler = (
  call: ToolCall,
  result: any,
  next: (value: any) => any,
) => Promise<any> | any;

export function onToolPre(ctx: Context, handler: PreExecuteHandler): void {
  (ctx as any).on('tools/pre-execute', handler);
}

export function onToolPost(ctx: Context, handler: PostExecuteHandler): void {
  (ctx as any).on('tools/post-execute', handler);
}

/**
 * llm 请求前注入点（原版地层中游离的「最后一块拼图」片段，此处正式接线）：
 * 无论 Agent 截了多少图，发给大模型的永远只有滑动窗口内的最新图片 + 旧图的文字占位符。
 * 事件表面同样以目标 DSH 版本为准，收口于此。
 */
export function onLlmPreRequest(
  ctx: Context,
  handler: (payload: { messages?: any[]; [key: string]: any }) => Promise<void> | void,
): void {
  (ctx as any).on('llm/pre-request', handler);
}
