// src/knowledge/events.ts
// D-7 事件表面单点收口（sandbox/events.ts 方言：as-any 集中于发射函数）。
// 事件载荷铁律：Skinny 载荷 —— 事件只传信号与定位锚，全量证据走 reportPath（Token 纪律）。
// 产权：knowledge/* 三事件名与载荷归 D-7 发射主权；
//      cognition/plan-ready 事件名属 D-1 主权，消费侧声明在 index.ts。
// 发射守卫：一切发射函数永不抛错 —— 发射失败是旁路义务，不阻断主流程。
/** D-7 发射事件名注册表（as const 防拼写漂移） */
export const KNOWLEDGE_EVENTS = {
  attempt: 'knowledge/attempt',
  learned: 'knowledge/learned',
  runEnd: 'knowledge/run-end',
} as const;

// ─── D-7 发射的载荷契约 ───

/** 单次执行尝试的信号（D-4 桥的消费锚：subject 约定 = `${intentId}:${seq}`） */
export interface KnowledgeAttemptPayload {
  intentId: string;
  seq: number;
  actionKind: string;
  status: 'success' | 'failure' | 'degraded';
  failureKind: string | null;
}

/** 闭环进化信号（learnFromOutcome 的账本面 —— 每笔自动学习可审计）。
 *  settledBy（P0-4 验收门）：学习发生时的结算路径 —— 'verdict' = D-4 回执结算；
 *  'run-end' = 终局冲账（D-4 沉默的诚实降级）。 */
export interface KnowledgeLearnedPayload {
  intentId: string;
  category: string;
  retryCount: number;
  settledBy: 'verdict' | 'run-end';
  learnedAt: number;
}

/** 流水线终局信号（Skinny：全量证据在 reportPath） */
export interface KnowledgeRunEndPayload {
  intentId: string;
  verdict: string;
  outcomes: number;
  knowledgeUsed: boolean;
  reportPath: string;
  endedAt: number;
}

/** 发射面类型（pipeline 注入；index.ts 桥接 ctx.emit；载荷 = Skinny 结构体） */
export type KnowledgeEmit = (event: string, payload: object) => void;

// ─── 类型化发射表面（永不抛错 —— 旁路义务）───

export function emitKnowledgeAttempt(emit: KnowledgeEmit, p: KnowledgeAttemptPayload): void {
  try { emit(KNOWLEDGE_EVENTS.attempt, p); } catch { /* 旁路义务 */ }
}

export function emitKnowledgeLearned(emit: KnowledgeEmit, p: KnowledgeLearnedPayload): void {
  try { emit(KNOWLEDGE_EVENTS.learned, p); } catch { /* 旁路义务 */ }
}

export function emitKnowledgeRunEnd(emit: KnowledgeEmit, p: KnowledgeRunEndPayload): void {
  try { emit(KNOWLEDGE_EVENTS.runEnd, p); } catch { /* 旁路义务 */ }
}
