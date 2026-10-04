// src/rollbackPlanner.plan.ts
// W6-2（doctor smell.over-engineering 清偿）：自 rollbackPlanner.ts 低风险分区提取
// （>500 行拆分信号）—— ① 良好态定位 / ② 模态逆映射表 / ③ 复合回滚计划铸造
// （全部纯函数）整体搬迁。行为零变化；rollbackPlanner.ts 以再导出保持导入面不变。
import { ltlF, violationsOf, reactTraceProperties } from './ltlf.js';
import { sanitizeTrace, ROLLBACK_BUDGET_STEPS } from './rollbackPlanner.js';
// ─── ① 良好态定位（纯函数 —— LTLf 只读消费） ───
/** 良好步判据：判据核过（status SUCCESS）且动作验证过（effect_detected === true）。
 *  未验证（undefined）不算良好 —— 「已验证良好」的字面义（验证过 ≠ 没失败），
 *  宁缺毋滥：回滚锚点必须是「世界被确认处于预期态」的时刻。 */
export function isVerifiedGood(step) {
    return step.status === 'SUCCESS' && step.effect_detected === true;
}
/**
 * 定位最后验证良好态（纯函数）：journal 回放 + LTLf 性质。
 *   · ltlF(good, n) 断言良好步存在性（不存在 ⇒ index:null —— 「没有良好态
 *     可退」是诚实结论，不是错误）；
 *   · 反向扫描取**最近**的良好步（回滚锚点越近，债务越少）；
 *   · violationsOf(¬good) 给出非良好位清单（规模入审计面）；
 *   · reactTraceProperties 顺带产出 ReAct 判决书（blind-start / 观察饥饿 /
 *     盲区连击 —— 回滚报告的审计附页）。绝不抛。
 */
export function locateLastVerifiedGood(steps) {
    const clean = sanitizeTrace(steps);
    const n = clean.length;
    const good = (i) => isVerifiedGood(clean[i]);
    const audit = reactTraceProperties(clean.map(s => ({
        tool: s.tool,
        observed: true, // 定位面无观察信息 ⇒ 不冒充盲启动（观察审计归 journal 侧）
        effect: s.effect_detected,
    })));
    const nonGood = violationsOf((i) => !good(i), n).length;
    if (!ltlF(good, n)) {
        return { index: null, fingerprint: null, traceAudit: audit, nonGoodPositions: nonGood };
    }
    for (let i = n - 1; i >= 0; i--) {
        if (good(i)) {
            return { index: i, fingerprint: clean[i].fingerprint ?? null, traceAudit: audit, nonGoodPositions: nonGood };
        }
    }
    return { index: null, fingerprint: null, traceAudit: audit, nonGoodPositions: nonGood }; // 防御式不可达
}
/** toggle 判别：显式标记或目标描述命中开关语义（checkbox/toggle/开关/复选） */
function isToggleClick(args) {
    if (args.toggle === true || args.is_toggle === true || args.isToggle === true)
        return true;
    const desc = args.target_description ?? args.targetDescription;
    return typeof desc === 'string' && /toggle|checkbox|switch|开关|复选/i.test(desc);
}
function finiteNum(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
/** 模态逆映射（纯函数）：一步 → 其逆动作描述。无逆模态 ⇒ no-inverse 如实申报。 */
export function inverseForStep(step) {
    const tool = typeof step.tool === 'string' ? step.tool : '';
    const args = (step.args && typeof step.args === 'object' && !Array.isArray(step.args)
        ? step.args : {});
    const origin = { tool, ...(Object.keys(args).length > 0 ? { args } : {}) };
    if (tool === 'type_text') {
        return {
            origin, modality: 'select-all-backspace', destructive: true,
            payload: {
                label: 'select-all + backspace to clear the typed text',
                keys: [['ctrl', 'a'], ['backspace']],
            },
        };
    }
    if (tool === 'click_mouse' || tool === 'click_element') {
        if (isToggleClick(args)) {
            const x = finiteNum(args.x);
            const y = finiteNum(args.y);
            return {
                origin, modality: 're-click-toggle', destructive: false,
                payload: {
                    label: 're-click the toggle to flip it back (exact inverse)',
                    ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}),
                },
            };
        }
        return {
            origin, modality: 'no-inverse', destructive: false,
            payload: { label: `generic "${tool}" has no automatic inverse — flagged for manual compensation` },
        };
    }
    if (tool === 'scroll_page') {
        const dy = finiteNum(args.dy) ?? finiteNum(args.amount);
        const dx = finiteNum(args.dx);
        return {
            origin, modality: 'reverse-scroll', destructive: false,
            payload: {
                label: 'scroll the opposite amount (exact inverse)',
                ...(dy !== undefined ? { dy: -dy } : {}), ...(dx !== undefined ? { dx: -dx } : {}),
            },
        };
    }
    if (tool === 'shaper' || tool === 'shape_environment') {
        const token = typeof args.undoToken === 'string' ? args.undoToken : undefined;
        return {
            origin, modality: 'shaper-undo', destructive: false,
            payload: {
                label: token
                    ? `restore shaper change via undoLog record "${token}"`
                    : 'restore shaper changes via undoLog (full LIFO fallback)',
                ...(token !== undefined ? { undoToken: token } : {}),
            },
        };
    }
    return {
        origin, modality: 'no-inverse', destructive: false,
        payload: { label: `"${tool}" has no registered inverse modality` },
    };
}
/** 铸造复合回滚计划（纯函数）：良好态之后的每步 → 逆映射 → LIFO 排序 →
 *  预算执法（可执行逆步 > maxSteps ⇒ 截断保最新 + exceeded 标记）。绝不抛。 */
export function buildRollbackPlan(steps, checkpointIndex, opts = {}) {
    const clean = sanitizeTrace(steps);
    const maxSteps = typeof opts.maxRollbackSteps === 'number' && Number.isFinite(opts.maxRollbackSteps)
        ? Math.max(1, Math.floor(opts.maxRollbackSteps)) : ROLLBACK_BUDGET_STEPS;
    const cpFp = (typeof opts.fingerprint === 'string' && opts.fingerprint !== ''
        ? opts.fingerprint : clean[checkpointIndex]?.fingerprint) ?? null;
    const debt = clean.slice(Math.max(0, Math.floor(checkpointIndex) + 1));
    const inverses = debt.map(inverseForStep);
    const lifo = [...inverses].reverse(); // 后做的先还原
    const executable = lifo.filter(s => s.modality !== 'no-inverse');
    const requiredSteps = executable.length;
    let finalSteps = lifo;
    let exceeded = false;
    if (requiredSteps > maxSteps) {
        // 截断保最新（LIFO 序的前 maxSteps 个可执行步 + 其间的 no-inverse 审计步）
        exceeded = true;
        const kept = [];
        let count = 0;
        for (const s of lifo) {
            if (s.modality !== 'no-inverse') {
                if (count >= maxSteps)
                    continue;
                count++;
            }
            kept.push(s);
        }
        finalSteps = kept;
    }
    return {
        checkpointIndex: Math.max(0, Math.floor(checkpointIndex)),
        checkpointFingerprint: cpFp,
        steps: finalSteps,
        destructiveSteps: finalSteps.filter(s => s.destructive),
        noInverseTools: [...new Set(finalSteps.filter(s => s.modality === 'no-inverse').map(s => s.origin.tool))],
        budget: { maxSteps, requiredSteps, exceeded },
    };
}
