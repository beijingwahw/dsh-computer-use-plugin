// src/cognitionEvents.ts
// D-1 认知引擎事件契约 —— 发射侧主权（P0-3：补全 cognition/plan-ready 发射端）。
// 事件名与载荷契约的唯一事实源：D-5（排练投喂）/ D-6（编排中枢）/ D-7（隐知识中枢）
// 一律 import 本文件消费，绝不另立方言 —— 单一事实源铁律。
// 依赖方向（全 type-only，零运行时环）：
//   ActionChain 来自 sandbox/types（D-5 主权 —— 依赖倒置：D-1 按其需求规格发射）；
//   IntentPayload 双方言来自 orchestration/contracts（D-6）与 knowledge/contracts（D-7）。
import type { Context } from '@deepseek-ai/cordis';
import type { ActionChain } from './sandbox/types';
import { GOAL_MAX_CHARS, SUCCESS_CRITERIA_MAX_CHARS } from './orchestration/contracts';
import type { IntentPayload as OrchestrationIntentPayload } from './orchestration/contracts';
import type { IntentPayload as KnowledgeIntentPayload } from './knowledge/contracts';

/** D-1 发射、D-5/D-6/D-7 消费 —— 事件名（事件名与载荷不可分，同归 D-1 主权） */
export const COGNITION_PLAN_READY_EVENT = 'cognition/plan-ready' as const;

/** D-1 规划器版本（世界模型溯源 —— 载荷 planVersion 字段的缺省铸造源） */
export const COGNITION_PLAN_VERSION = 'd1-planner/1';

// ─── 载荷联合方言（P0-3 立法：三方言并存，消费侧宽容解码）───

/** 既有方言：D-5 沙箱的排练投喂需求（ActionChain） */
export interface CognitionChainPayload {
  /** origin='cognition' */
  chain: ActionChain;
  /** D-1 规划器版本（世界模型溯源） */
  planVersion: string;
}

/**
 * plan-ready 载荷联合方言 —— 三方言皆为合法线上形态：
 *   CognitionChainPayload        既有方言（D-5 排练消费）
 *   OrchestrationIntentPayload   D-6 方言（goal/successCriteria —— 最丰意图形态）
 *   KnowledgeIntentPayload       D-7 方言（description/previousResults）
 * 消费侧各自宽容解码（normalizeIntent），发射侧经 emitCognitionPlanReady 铸造。
 * P1-3 仲裁：主消费者 = D-7；D-6 仅 consumePlanReady=true 时夺回；D-5 只认 chain 臂。
 */
export type CognitionPlanReadyPayload =
  | CognitionChainPayload
  | OrchestrationIntentPayload
  | KnowledgeIntentPayload;

// ─── 类型化发射表面（永不抛错 —— 发射失败是旁路义务，不阻断主流程）───

/** D-1 发射侧铸造点：意图方言载荷（delegateToPipeline 交班的唯一铸造源）。
 *  结构保证：goal ≤160 / successCriteria ≤200（对齐 D-6 契约预算 —— 不靠下游自觉）；
 *  budgetMs 域执法（风险加固）：只放行正有限数 —— 负数（秒级瞬死）/ NaN（永不超时）
 *  一旦流入 D-6 时间治理即毒化 intent 层时钟，域外值诚实缺席（undefined）。
 *  source='cognition' / planVersion 缺省铸造（世界模型溯源）。 */
export function mintIntentPlanReady(input: {
  id: string;
  goal: string;
  successCriteria?: string;
  budgetMs?: number;
}): OrchestrationIntentPayload {
  return {
    id: input.id,
    goal: input.goal.slice(0, GOAL_MAX_CHARS),
    successCriteria: input.successCriteria?.slice(0, SUCCESS_CRITERIA_MAX_CHARS),
    budgetMs: isPositiveFinite(input.budgetMs) ? input.budgetMs : undefined,
    source: 'cognition',
    planVersion: COGNITION_PLAN_VERSION,
  };
}

/** budgetMs 域判别：正有限数才合法（时间治理的入域门票） */
function isPositiveFinite(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/** D-1 发射端：计划就绪信号上事件总线（联合方言任一形态皆可发射）。
 *  发射守卫：永不抛错 —— 发射失败是旁路义务，不阻断 D-1 主流程 */
export function emitCognitionPlanReady(ctx: Context, payload: CognitionPlanReadyPayload): void {
  try { (ctx as any).emit(COGNITION_PLAN_READY_EVENT, payload); }
  catch { /* 旁路义务：事件面缺席/故障不毒化发射方 */ }
}
