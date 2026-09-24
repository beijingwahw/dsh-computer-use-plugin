// src/guards/hooks.ts
// 工具管线事件挂载的唯一转换点。
//
// DSH 事件表面（名称/签名）随版本迭代；本文件做**双纪元适配**：
//   旧表面（≤rc.5）：ctx.on('tools/pre-execute', (call: {name, args}, next))，
//                   result 是工具返回的字符串值（锚点 JSON）
//   新表面（rc.6）：ctx.on('tools/pre-execute', (exec: ToolExecution, next))，
//                   exec.arguments 是已解析参数对象；result 是 ToolExecutionResult
//                   （{isError, value, content} 判别联合）；拦截经 PreToolDecision
//                   （{kind:'deny', reason}）而非返回字符串
//
// 守卫实现一律面向旧形状（{name, args} + 字符串 result）编写 —— 版本差异
// 收口于此：入参归一化、出参决策转译。
import type { Context } from '@deepseek-ai/cordis';

export interface ToolCall {
  name: string;
  args: Record<string, any>;
  /**
   * Y6：发起本次调用的会话标识（rc.6 exec.agent.id；缺席 = '_anon'）。
   * 进程级管线看见所有会话的调用 —— 守卫的"重复动作"记忆若不按会话
   * 分键，上一会话末尾的失败签名会拦住新会话的第一次同签名调用
   * （真机战果：新会话的 ZZZ 探测词被上一会话的同签名失败拦截）。
   */
  sessionId?: string;
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

/** rc.6 ToolExecution → 旧 ToolCall 形状（arguments 已是解析对象；防御字符串） */
function normalizeExec(exec: any): ToolCall {
  let args = exec?.arguments ?? {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args || '{}'); } catch { args = {}; }
  }
  const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id;
  return {
    name: exec?.name ?? '',
    args: args as Record<string, any>,
    ...(sessionId ? { sessionId: String(sessionId) } : {}),
  };
}

/** rc.6 ToolExecutionResult → 旧字符串值语义（守卫的 resultContract 解析面） */
function extractResultValue(result: any): any {
  if (result == null || typeof result === 'string') return result;
  if (result.isError === true) {
    // 失败臂：错误文本（circuitBreaker 的失败计数依赖可解析的失败签名）
    const content = Array.isArray(result.content)
      ? result.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
      : '';
    return content || (result.error ? `[Error]: ${JSON.stringify(result.error).slice(0, 300)}` : '[Error]');
  }
  if ('value' in result) return result.value;
  if (Array.isArray(result.content)) {
    return result.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n');
  }
  return result;
}

/** 旧拦截语义（返回字符串）→ rc.6 PreToolDecision deny */
function toPreDecision(out: any): any {
  if (typeof out === 'string') return { kind: 'deny', reason: out };
  return out; // next() 的返回（decision 对象）原样透传
}

/** 旧改写语义（返回字符串 result）→ rc.6 PostToolDecision accept+content */
function toPostDecision(out: any): any {
  if (typeof out === 'string') {
    return { kind: 'accept', content: [{ type: 'text', text: out }] };
  }
  return out;
}

export function onToolPre(ctx: Context, handler: PreExecuteHandler): void {
  (ctx as any).on('tools/pre-execute', async (exec: any, next: () => Promise<any>) => {
    const call = normalizeExec(exec);
    const out = await handler(call, () => next());
    return toPreDecision(out);
  });
}

export function onToolPost(ctx: Context, handler: PostExecuteHandler): void {
  (ctx as any).on('tools/post-execute', async (exec: any, result: any, next: () => Promise<any>) => {
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
export function onLlmPreRequest(
  ctx: Context,
  handler: (payload: { messages?: any[]; [key: string]: any }) => Promise<void> | void,
): void {
  (ctx as any).on('llm/pre-request', handler);
}
