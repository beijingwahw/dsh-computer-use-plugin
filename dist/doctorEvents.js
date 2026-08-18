// src/doctorEvents.ts
// D-4 公共事件契约（发射侧拥有的载荷类型，唯一事实源）。
// 与 doctorTypes.ts 成对而立，命名即产权：接口契约归 doctorTypes，事件契约归本文件。
// 依赖方向铁律：D-5（sandbox/*）import 本文件；本文件不 import 任何 D-5 模块 ——
// 断开「D-5→D-4 服务依赖 + D-4→D-5 类型依赖」的反向环。
// 本文件只含数据契约与纯铸造函数，零行为表面 ——
// 翻译规则（DiagnosisReport → 载荷）是 D-4 内部主权，不在此处立法。
/** doctor/verdict 事件名（事件名与载荷不可分，同归 D-4 主权） */
export const DOCTOR_VERDICT_EVENT = 'doctor/verdict';
/**
 * 唯一合法铸造点：域外拒绝而非截断（150 分是 bug，clamp 会掩埋它）。
 * 永不抛错 —— 非法输入返回 null，由调用方走 Result 降级路径（异常诚实铁律）。
 */
export function makeScore(raw) {
    return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : null;
}
/** 分数消费侧守门：跨事件/持久化边界重铸；非法即降级（不信任何越界而来的 brand 声明） */
export function remintScore(raw, fallback) {
    return makeScore(raw) ?? fallback;
}
