import { onToolPre } from './hooks.js';
import { matchesRiskPatterns } from '../riskGate.js';
import { journal } from '../journal.js';
/** 审计日志脱敏：type_text 的 args 可能含凭据/验证码 —— 与 typeText 工具的
 *  [REDACTED] 锚点同律，宿主控制台不落明文秘密 */
const REDACT_KEYS = /^(text|typed_content|content|password|passwd|secret|token|api_?key)$/i;
/** 嵌套脱敏限深：环/超深结构不得把审计行炸成栈溢出；越深整体脱敏（宁过度） */
const REDACT_MAX_DEPTH = 3;
function redactArgs(args, depth = 0) {
    if (!args || typeof args !== 'object' || Array.isArray(args))
        return args;
    const out = {};
    for (const [k, v] of Object.entries(args)) {
        if (REDACT_KEYS.test(k)) {
            out[k] = '[REDACTED]'; // 敏感键：无论标量/数组/对象，整值脱敏（J 纪元：数组不再原样放行）
        }
        else if (v && typeof v === 'object' && !Array.isArray(v)) {
            out[k] = depth < REDACT_MAX_DEPTH ? redactArgs(v, depth + 1) : '[REDACTED]';
        }
        else {
            out[k] = v;
        }
    }
    return out;
}
/** W2-2（S4）：先行审计覆盖面 —— 全部变更类工具（触达物理世界的动作面）。
 *  观察/只读工具（take_screenshot 等）不入列：审计的是「世界将被打改」的意图。 */
const MUTATING_TOOLS = new Set([
    'click_mouse', 'click_element', 'drag_mouse',
    'scroll_page', 'type_text', 'press_hotkey',
]);
export function registerAuditGuard(ctx) {
    onToolPre(ctx, async (toolCall, next) => {
        const sensitiveActions = ['type_text', 'press_hotkey'];
        if (sensitiveActions.includes(toolCall.name)) {
            // L 纪元：TODO 兑现 —— 审计行消费 J 纪元 risk/approval 体系语境：
            //   凭据语义文本 ⇒ 标注风险闸门将要求人工输入（挂起点在 typeText 工具内）；
            //   click 类危险操作的令牌核验在 click_mouse 内（grant 前置）。
            //   审计不拦截（旁路观察者），但把"安全系统接下来会做什么"写进审计轨迹。
            try {
                const args = toolCall.args;
                const text = typeof args?.text === 'string' ? args.text : '';
                const risk = matchesRiskPatterns(text, 'password,passwd,密码,验证码,verification code,2fa,otp,secret,token,api key')
                    ? ' [risk: credential-like — risk gate will demand human input]'
                    : '';
                console.warn(`[Audit Guard] Sensitive action intercepted: ${toolCall.name}${risk}`, redactArgs(args));
            }
            catch (e) {
                // 审计行丢失必须可见，但观察者自身崩溃绝不允许阻断工具调用（恒放行契约）
                console.warn(`[Audit Guard] audit line lost for ${toolCall.name}: ${e?.message ?? e}`);
            }
        }
        // ── W2-2（S4）：先行审计 WAL —— 变更类工具派发前的 fail-closed 提交 ──
        // 审计行（脱敏后）在此刻（next() 之前 = 工具 execute 之前）追加进 journal
        // 哈希链；提交失败 ⇒ 短路拒绝（不调 next 即拦截），拒绝面是结构化 JSON
        // （hooks.toPreDecision 转译为 PreToolDecision deny）。防御式：提交通道
        // 自身绝不抛（appendPreDispatch 内部捕获），此处再兜一层 —— 守卫代码的
        // 任何意外异常也走 fail-closed 拒派，绝不静默放行无审计的动作。
        if (MUTATING_TOOLS.has(toolCall.name)) {
            let commit;
            try {
                // 非对象载荷（数组/标量）装箱为 { value } —— 审计行的 args 域恒为纯对象
                const redacted = redactArgs(toolCall.args ?? {});
                const payload = redacted && typeof redacted === 'object' && !Array.isArray(redacted)
                    ? redacted
                    : { value: redacted };
                commit = journal.appendPreDispatch(toolCall.name, payload);
            }
            catch (e) {
                commit = { ok: false, error: `audit-guard-internal:${String(e?.message ?? e)}` };
            }
            if (!commit.ok) {
                console.warn(`[Audit Guard] FAIL-CLOSED: ${toolCall.name} refused — pre-dispatch audit commit failed: ${commit.error}`);
                return JSON.stringify({
                    status: 'ACTION_REQUIRED',
                    state_anchor: {
                        audit_gate: 'fail-closed',
                        reason: 'pre-dispatch-audit-commit-failed',
                        tool: toolCall.name,
                        detail: commit.error,
                        note: 'The action was NOT dispatched: its write-ahead audit record could not be committed ' +
                            'to the tamper-evident journal. Actions without an audit trail are refused by design.',
                    },
                    next_step: 'RETRY once (transient disk hiccup). If it persists, inspect the journal path ' +
                        '(disk space / write permissions) before attempting any further world-changing action — ' +
                        'read-only tools (take_screenshot, ask_screen) remain available for diagnosis.',
                }, null, 2);
            }
        }
        return next();
    });
}
