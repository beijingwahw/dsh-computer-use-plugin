// src/knowledge/configValidator.ts
// D-7 配置守卫 —— configure() 校验域的独立执法模块（自 pipeline.ts 拆出：
// smell.over-engineering 自愈 —— 校验是纯函数零 this 依赖，责任边界即模块边界）。
// 异常诚实（D-7 修正案）：Result 降级严禁 throw；域外拒绝对齐 makeScore 哲学
// （clamp 会掩埋 bug），首个错误即返回 —— field 精确定位。
import type { ConfigError, PipelineConfig, Result } from './contracts';

/** 工位 Token 预算缺省（P1-2 config-driven：本表仅为 PipelineConfig.stationTokenBudgets
 *  缺席时的回退缺省 —— 预算治理主权在配置域，校验后不再有第二个常量源） */
const DEFAULT_STATION_TOKEN_BUDGETS = { vision: 0, decision: 2000, execution: 0 } as const;

/** 网格缺省（regionGrid 缺席时的回退缺省 —— 具名常量，避免 undefined 域泄漏） */
export const DEFAULT_REGION_GRID = { cols: 2, rows: 2 } as const;

/**
 * 配置校验 + 归一化（纯函数）：域外拒绝，首个错误即返回；
 * 合法配置填平缺省（regionGrid / stationTokenBudgets）后原样通过。
 */
export function validatePipelineConfig(config: PipelineConfig): Result<PipelineConfig, ConfigError> {
  if (!config || typeof config !== 'object') {
    return { ok: false, error: { field: 'config', reason: 'config must be an object' } };
  }
  const t = config.timeout;
  if (!t || !Number.isFinite(t.overall) || t.overall <= 0) {
    return { ok: false, error: { field: 'timeout.overall', reason: `must be a positive finite number, got ${t?.overall}` } };
  }
  if (!Number.isFinite(t.perStep) || t.perStep <= 0) {
    return { ok: false, error: { field: 'timeout.perStep', reason: `must be a positive finite number, got ${t?.perStep}` } };
  }
  if (!Number.isFinite(t.perPerception) || t.perPerception <= 0) {
    return { ok: false, error: { field: 'timeout.perPerception', reason: `must be a positive finite number, got ${t?.perPerception}` } };
  }
  const rp = config.retryPolicy;
  if (!rp || !Number.isInteger(rp.maxRetries) || rp.maxRetries < 0) {
    return { ok: false, error: { field: 'retryPolicy.maxRetries', reason: `must be a non-negative integer, got ${rp?.maxRetries}` } };
  }
  if (!Number.isFinite(rp.backoffMs) || rp.backoffMs < 0) {
    return { ok: false, error: { field: 'retryPolicy.backoffMs', reason: `must be a non-negative finite number, got ${rp?.backoffMs}` } };
  }
  if (!Number.isFinite(rp.maxBackoffMs) || rp.maxBackoffMs < rp.backoffMs) {
    return { ok: false, error: { field: 'retryPolicy.maxBackoffMs', reason: `must be >= backoffMs (${rp?.backoffMs}), got ${rp?.maxBackoffMs}` } };
  }
  if (!Number.isFinite(config.knowledgeTimeout) || config.knowledgeTimeout <= 0) {
    return { ok: false, error: { field: 'knowledgeTimeout', reason: `must be a positive finite number (anti-stall guard), got ${config.knowledgeTimeout}` } };
  }
  if (!Number.isInteger(config.knowledgeMaxResults) || config.knowledgeMaxResults < 1) {
    return { ok: false, error: { field: 'knowledgeMaxResults', reason: `must be an integer >= 1, got ${config.knowledgeMaxResults}` } };
  }
  if (!Number.isInteger(config.knowledgeMaxChars) || config.knowledgeMaxChars < 1 || config.knowledgeMaxChars > 300) {
    return { ok: false, error: { field: 'knowledgeMaxChars', reason: `must be an integer in [1,300] (injection summary budget), got ${config.knowledgeMaxChars}` } };
  }
  const g = config.regionGrid;
  if (g && (!Number.isInteger(g.cols) || g.cols < 1 || !Number.isInteger(g.rows) || g.rows < 1)) {
    return { ok: false, error: { field: 'regionGrid', reason: `cols/rows must be integers >= 1, got ${JSON.stringify(g)}` } };
  }
  // P1-2 工位 Token 预算域执法：非负整数；execution 恒 0（零模型肌肉的类型层
  // 延伸 —— 域外拒绝，绝不 clamp 掩埋）
  const tb = config.stationTokenBudgets ?? DEFAULT_STATION_TOKEN_BUDGETS;
  if (!Number.isInteger(tb.vision) || tb.vision < 0 ||
      !Number.isInteger(tb.decision) || tb.decision < 0 ||
      !Number.isInteger(tb.execution) || tb.execution < 0) {
    return { ok: false, error: { field: 'stationTokenBudgets', reason: `vision/decision/execution must be non-negative integers, got ${JSON.stringify(tb)}` } };
  }
  if (tb.execution !== 0) {
    return { ok: false, error: { field: 'stationTokenBudgets.execution', reason: `execution is zero-model muscle and must stay 0, got ${tb.execution}` } };
  }
  // 消融域执法：l3Policy 枚举 + 布尔开关（科学义务：非法消融配置 = 不可复现的实验）
  const ab = config.ablation;
  if (ab !== undefined) {
    if (typeof ab !== 'object' || ab === null) {
      return { ok: false, error: { field: 'ablation', reason: 'ablation must be an object when present' } };
    }
    if (ab.disableKnowledge !== undefined && typeof ab.disableKnowledge !== 'boolean') {
      return { ok: false, error: { field: 'ablation.disableKnowledge', reason: `must be boolean, got ${JSON.stringify(ab.disableKnowledge)}` } };
    }
    if (ab.l3Policy !== undefined && !['surprise', 'always', 'never'].includes(ab.l3Policy)) {
      return { ok: false, error: { field: 'ablation.l3Policy', reason: `must be 'surprise'|'always'|'never', got ${JSON.stringify(ab.l3Policy)}` } };
    }
  }
  return {
    ok: true,
    value: {
      ...config,
      regionGrid: g ?? DEFAULT_REGION_GRID,
      stationTokenBudgets: tb,
      ablation: ab ? { disableKnowledge: ab.disableKnowledge ?? false, l3Policy: ab.l3Policy ?? 'surprise' } : { disableKnowledge: false, l3Policy: 'surprise' },
    },
  };
}
