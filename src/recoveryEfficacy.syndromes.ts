// src/recoveryEfficacy.syndromes.ts
// W6-2（doctor smell.over-engineering 清偿）：自 recoveryEfficacy.ts 低风险分区提取
// （>500 行拆分信号）—— 症候签名面（闭集症候 + 症状/动作分类器，纯函数）整体搬迁。
// 行为零变化；recoveryEfficacy.ts 以再导出保持导入面不变（diagnosis/branchCards 零改动）。
import type { RecoveryActionId } from './diagnosis';

// ── W2-5：症候签名（单次失败级的粗粒度症候 —— 疗效表的第一轴）──
//
// 命名空间辨析：diagnosis.Syndrome 是**系统级**症候（CUSUM/Hurst 聚合统计的
// 会诊结论）；本处的症候签名是**单次失败级**的粗化特征（失败事件现场可得：
// 症状首句关键词 + 熔断前缀 + 工具族缺省）。两者不混用 —— 单次失败没有
// 聚合统计，冒用系统症候名是语义污染。闭集 ≤ 6 值是疗效账可积累的前提
// （原始症状字符串做键 ⇒ 每条失败一个新格，永远凑不满样本闸）。

/** W2-5：单次失败的粗粒度症候签名（闭集 —— 疗效表第一轴） */
export type RecoverySyndromeId =
  | 'guard-blocked'        // 熔断/守卫拦截（聚合症状 —— 回合允许从熔断事件起算）
  | 'target-not-found'     // 定位/识别失败（找不到目标）
  | 'no-world-effect'      // 动作报败且屏幕无变化（点空/坐标偏差）
  | 'verification-mismatch'// 语义核对失败（读到的与预期不符 / 校验器判负）
  | 'stall-timeout'        // 超时/卡顿/冻结（世界没在响应）
  | 'generic-failure';     // 兜底（症状无决定性特征 —— 诚实的粗桶）

/** W2-5：运行时枚举面（防御解析的合法值域） */
export const RECOVERY_SYNDROME_IDS: readonly RecoverySyndromeId[] = [
  'guard-blocked', 'target-not-found', 'no-world-effect',
  'verification-mismatch', 'stall-timeout', 'generic-failure',
];

/** W2-5：防御解析 —— 任意值 → 合法症候签名（垃圾值 ⇒ generic-failure 兜底桶） */
export function parseRecoverySyndrome(v: unknown): RecoverySyndromeId {
  return typeof v === 'string' && (RECOVERY_SYNDROME_IDS as readonly string[]).includes(v)
    ? (v as RecoverySyndromeId)
    : 'generic-failure';
}

/**
 * W2-5：症候签名分类器（纯函数、确定性、首中即断 —— 与规则表同哲学）。
 * 判据序：熔断前缀 → 症状关键词（找不到 / 无变化 / 核对不符 / 卡顿）→
 * 工具族先验（感知类工具的失败模式是本职失败：找不到）→ 兜底粗桶。
 */
export function classifySyndromeSignature(symptom: unknown, tool?: unknown): RecoverySyndromeId {
  const s = typeof symptom === 'string' ? symptom.toLowerCase() : '';
  const t = typeof tool === 'string' ? tool.toLowerCase() : '';
  if (s.startsWith('circuit-breaker:')) return 'guard-blocked';
  if (/not found|no match|cannot find|can't find|not located|unrecognized|not detected|no .*located/.test(s)) {
    return 'target-not-found';
  }
  if (/no change|unchanged|no effect|nothing happen|did not change|didn't change|no visible/.test(s)) {
    return 'no-world-effect';
  }
  if (/mismatch|differ|expected|verify|incorrect|wrong text/.test(s)) {
    return 'verification-mismatch';
  }
  if (/timeout|timed out|stall|freez|hang|unresponsive/.test(s)) {
    return 'stall-timeout';
  }
  // 症状词缺席 ⇒ 工具族先验（感知/识别类工具的失败即「找不到」）
  if (t === 'find_text' || t === 'read_text' || t === 'zoom_inspect' || t === 'extract_ui_vision') {
    return 'target-not-found';
  }
  return 'generic-failure';
}

/**
 * W2-5：恢复动作分类器（纯函数）—— 工具名 → 规范动作（diagnosis 的动作词汇）。
 * 不在表内的工具 ⇒ null：该事件仍消耗回合窗口（是一次真实尝试），但不产生
 * 疗效观察（无法记名的动作不入账 —— 与 unknown 根因不写库同律）。
 */
const ACTION_TOOL_FAMILY: ReadonlyArray<readonly [RecoveryActionId, readonly string[]]> = [
  ['zoom-refine', ['zoom_inspect']],
  ['switch-modality', ['press_hotkey', 'type_text', 'scroll_page', 'recall_ui', 'switch_tab', 'switch_window', 'open_url']],
  ['re-observe', ['take_screenshot', 'diff_view', 'ask_screen']],
  ['ground-target', ['find_text', 'probe_interactivity', 'read_text', 'extract_ui_vision']],
];

export function classifyRecoveryAction(tool: unknown): RecoveryActionId | null {
  if (typeof tool !== 'string') return null;
  for (const [action, tools] of ACTION_TOOL_FAMILY) {
    if (tools.includes(tool)) return action;
  }
  return null;
}
