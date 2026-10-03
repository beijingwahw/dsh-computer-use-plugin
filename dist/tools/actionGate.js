// src/tools/actionGate.ts
// Δ 纪元（全库跃迁·审计#1）：动作闸门的唯一事实源。
//
// 背景：审批闸门（危险词 ⇒ 需已授予的一次性令牌）与风险闸门（凭据 ⇒ 交还
// 用户）原本住在 clickMouse / typeText 工具内部 —— 而 replayOne（replay_actions
// / run_skill / orchestrator 的技能回退）直调 system.clickMouse/typeText，完全
// 绕过工具层。日志里的「发送」点击、凭据输入可被 run_skill 无令牌原样重放。
//
// 修法：判定逻辑抽取为本模块的 assertActionAllowed —— 工具层与重放层共用同一
// 事实源。抽取自 clickMouse（第六轮 + B-3 + J-14 跨通道 + N 纪元硬前置）与
// typeText（长度防御 + 第五轮风险闸门），逐语义等价：
//   click_mouse：
//     · 危险信号 = target_description **或** expected_text 命中 dangerPatterns
//       （J-14：expected_text 是第二危险信号通道 —— 绕过须同时沉默两条独立通道）；
//     · dangerous（闸门开启且命中）且无已授予有效令牌 ⇒ 拒绝（token 在场归因
//       'token-not-granted-or-expired'，缺席归因 'irreversible-action'），
//       阻断路径顺手 sweep 过期令牌（与旧实现同律）；
//     · 闸门开启时双通道全沉默 ⇒ 'undescribed-click' 硬前置（N 纪元 #18）。
//   type_text：
//     · 长度防御：text 超过 maxTextLength ⇒ 拒绝（防注入超长文本）；
//     · 风险闸门：焦点被标记为敏感区（点击密码框后）或文本自身命中风险语义
//       ⇒ 拒绝（凭据类输入不代劳）。
import { matchesRiskPatterns, matchesDangerPatterns, DEFAULT_RISK_PATTERNS, DEFAULT_DANGER_PATTERNS } from '../riskGate.js';
import { approval } from '../approval.js';
import { focusTracker } from '../focusTracker.js';
/** 缺省闸门配置：与 Config 缺省同值 —— 重放层未透传配置时不得静默失守 */
export const DEFAULT_ACTION_GATE_CONFIG = {
    enableApprovalGate: true,
    dangerPatterns: DEFAULT_DANGER_PATTERNS,
    enableRiskGate: true,
    riskPatterns: DEFAULT_RISK_PATTERNS,
    maxTextLength: 1000,
    focusMaxAgeMs: 30_000,
};
/** 重放/技能步骤被闸门拦截的稳定标记（replay_actions 据此 fail-fast 中止；
 *  run_skill 据 FAILED 前缀计失败步） */
export const SAFETY_GATE_BLOCK = 'safety-gate-blocked';
/**
 * 断言一个动作（live 工具调用或日志/技能重放步）是否被放行。
 * 纯判定 + 与旧工具内实现一致的副作用谱（仅审批域阻断路径 sweep 过期令牌）。
 * 不派发任何物理动作 —— 派发与验收式消费仍是调用方（clickMouse/replayOne）的职责。
 */
export function assertActionAllowed(kind, args, cfg) {
    const c = { ...DEFAULT_ACTION_GATE_CONFIG, ...cfg };
    const a = args ?? {};
    if (kind === 'click_mouse') {
        const target_description = a.target_description;
        const expected_text = a.expected_text;
        const approval_token = a.approval_token;
        // J-14 跨通道法则：两条独立危险信号通道，任一命中即触发审批域
        const descHit = target_description ? matchesDangerPatterns(target_description, c.dangerPatterns) : false;
        const textHit = expected_text ? matchesDangerPatterns(expected_text, c.dangerPatterns) : false;
        const dangerous = c.enableApprovalGate && (descHit || textHit);
        if (dangerous && !(approval_token && approval.validate(approval_token))) {
            approval.sweep(); // 顺手清理过期令牌（与旧工具内实现同律）
            return {
                allowed: false,
                reason: approval_token ? 'token-not-granted-or-expired' : 'irreversible-action',
                requiresApproval: true,
                dangerous: true,
                dangerSignalChannel: descHit ? 'target_description' : 'expected_text',
            };
        }
        // N 纪元（盲区根除）：闸门开启时描述是硬前置 —— 两条信号通道全沉默的点击
        // 不再放行（审批闸门无法审判一个无名目标）。
        if (c.enableApprovalGate && !target_description && !expected_text) {
            return { allowed: false, reason: 'undescribed-click', requiresApproval: false, dangerous: false };
        }
        return { allowed: true, requiresApproval: dangerous, dangerous };
    }
    // type_text
    const text = typeof a.text === 'string' ? a.text : '';
    if (text.length > c.maxTextLength) {
        return { allowed: false, reason: 'text-too-long', requiresApproval: false, dangerous: false };
    }
    if (c.enableRiskGate && (focusTracker.isSensitive(c.focusMaxAgeMs) || matchesRiskPatterns(text, c.riskPatterns))) {
        return { allowed: false, reason: 'sensitive-input', requiresApproval: false, dangerous: false };
    }
    return { allowed: true, requiresApproval: false, dangerous: false };
}
