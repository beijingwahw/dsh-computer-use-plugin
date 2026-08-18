// src/doctorEvents.ts
// D-4 公共事件契约（发射侧拥有的载荷类型，唯一事实源）。
// 与 doctorTypes.ts 成对而立，命名即产权：接口契约归 doctorTypes，事件契约归本文件。
// 依赖方向铁律：D-5（sandbox/*）import 本文件；本文件不 import 任何 D-5 模块 ——
// 断开「D-5→D-4 服务依赖 + D-4→D-5 类型依赖」的反向环。
// 本文件只含数据契约与纯铸造函数，零行为表面 ——
// 翻译规则（DiagnosisReport → 载荷）是 D-4 内部主权，不在此处立法。

/** doctor/verdict 事件名（事件名与载荷不可分，同归 D-4 主权） */
export const DOCTOR_VERDICT_EVENT = 'doctor/verdict' as const;

/**
 * 三态判决：补全既有 genesisVerdict（'intact' | 'violated'）二元词汇表缺失的中间态。
 * 阈值主权在 D-4 配置域 —— 载荷只传决策不传阈值，消费方禁止二次猜阈值。
 */
export type DoctorVerdict = 'approved' | 'rejected' | 'needs_review';

/**
 * 名义分数：0-100 域与 0-1 可靠度在类型层不可互换。
 * 注意：brand 不 enforcement 0-100 域 —— 域的执行者是 makeScore 唯一铸造点。
 * 三条使用铁律：
 *   1. D-4 契约边界：现世 DiagnosisReport.score 保持裸 number（零侵入），翻译点在发射侧；
 *   2. 事件/持久化消费边界：收到的载荷与 checkpoint 重载的 score 一律重过 makeScore；
 *   3. 算术出口：任何运算结果退化为 number，重新铸造后方可入结构体。
 */
export type Score = number & { readonly _brand: 'score' };

/**
 * 唯一合法铸造点：域外拒绝而非截断（150 分是 bug，clamp 会掩埋它）。
 * 永不抛错 —— 非法输入返回 null，由调用方走 Result 降级路径（异常诚实铁律）。
 */
export function makeScore(raw: number): Score | null {
  return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? (raw as Score) : null;
}

/** 分数消费侧守门：跨事件/持久化边界重铸；非法即降级（不信任何越界而来的 brand 声明） */
export function remintScore(raw: number, fallback: Score): Score {
  return makeScore(raw) ?? fallback;
}

/**
 * doctor/verdict 事件载荷 —— D-4 发射、D-5 消费的唯一事实源。
 * Skinny 载荷原则：只传信号与定位锚，全量证据走 D-4 自己的 reportPath（Token 纪律）。
 */
export interface DoctorVerdictPayload {
  /** 审查对象（chainId —— 人类可读定位） */
  subject: string;
  /** 被审链位置的密码学锚点（与 sandbox/rehearsal-end 载荷逐字对应，构成请求-回执双重关联） */
  chainTip: string;
  /** 判决 —— 三态，见 DoctorVerdict */
  verdict: DoctorVerdict;
  /** 0-100 原始连续值；发射侧经 makeScore 铸造，翻译失败 ⇒ needs_review */
  score: Score;
  /** 判决理由，≤200 字符（Token 纪律，对齐 journal thought 预算哲学） */
  rationale?: string;
}
