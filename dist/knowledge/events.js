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
};
// ─── 类型化发射表面（永不抛错 —— 旁路义务）───
export function emitKnowledgeAttempt(emit, p) {
    try {
        emit(KNOWLEDGE_EVENTS.attempt, p);
    }
    catch { /* 旁路义务 */ }
}
export function emitKnowledgeLearned(emit, p) {
    try {
        emit(KNOWLEDGE_EVENTS.learned, p);
    }
    catch { /* 旁路义务 */ }
}
export function emitKnowledgeRunEnd(emit, p) {
    try {
        emit(KNOWLEDGE_EVENTS.runEnd, p);
    }
    catch { /* 旁路义务 */ }
}
