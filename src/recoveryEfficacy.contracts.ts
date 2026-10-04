// src/recoveryEfficacy.contracts.ts
// W6-2（doctor smell.over-engineering 清偿）：自 recoveryEfficacy.ts 低风险分区提取
// —— 事件与回合结构（纯类型面，零运行时代码）整体搬迁。行为零变化；
// recoveryEfficacy.ts 以再导出保持导入面不变。
import type { RecoverySyndromeId } from './recoveryEfficacy.syndromes';
import type { RootCauseId, RecoveryActionId } from './diagnosis';

// ── W2-5：事件与回合结构 ──

export type RecoveryEventKind = 'failure' | 'success' | 'unknown';

/** 疗效事件流的一个事件（生产：守卫逐事件喂入；测试/回放：注入） */
export interface RecoveryEvent {
  kind: RecoveryEventKind;
  tool: string;
  /** failure 的症状原文（症候签名的推导源；缺席 ⇒ 工具族缺省） */
  symptom?: string;
  /** failure 的根因（鉴别探针结论；缺席/垃圾 ⇒ unknown —— parseRootCause 律） */
  rootCause?: RootCauseId | string;
  /** 墙钟（可选 —— 审计面；缺席 ⇒ null，回合判定零墙钟依赖） */
  at?: number;
}

/** 回合内一次可记名恢复动作的观察（Beta 账的一笔） */
export interface RecoveryObservation {
  tool: string;
  action: RecoveryActionId;
  success: boolean;
}

/** 划定后的恢复回合（审计可回放：开闭下标 + 窗口 + 逐动作观察） */
export interface RecoveryEpisodeRecord {
  syndrome: RecoverySyndromeId;
  rootCause: RootCauseId;
  outcome: 'recovered' | 'timeout' | 'open';
  /** 开回合事件的下标（事件流内 —— 回放锚） */
  openIndex: number;
  /** 闭回合事件的下标（null = 未决 open —— 流尽而窗未满） */
  closeIndex: number | null;
  openedAt: number | null;
  closedAt: number | null;
  /** 划界窗口 N（回合判定所用值 —— 快照可解释性） */
  window: number;
  observations: RecoveryObservation[];
  /** 窗内无法记名动作的事件数（窗口消耗面 —— 诚实申报） */
  unclassifiedActions: number;
}

/** 疗效表的一格：(症候签名 × 根因 × 恢复动作) 的 Beta 账 */
export interface RecoveryCell {
  syndrome: RecoverySyndromeId;
  rootCause: RootCauseId;
  action: RecoveryActionId;
  successes: number;
  failures: number;
}

/** 疗效表快照（metrics / doctor 的消费面 —— 只读投影） */
export interface EfficacySnapshot {
  cells: Array<RecoveryCell & { n: number; posteriorMean: number }>;
  episodes: RecoveryEpisodeRecord[];
  totals: { recovered: number; timedOut: number; observations: number };
  window: number;
  minSamples: number;
}
