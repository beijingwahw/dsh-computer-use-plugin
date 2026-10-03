// src/rollbackPlanner.ts
// W4-3（R3 有界回滚 + 分支重规划）：世界级 CUA 的回滚纪律 —— 不是「再点
// 一次撤销」的赌博，而是一段可审计的复合计划：
//
//   ① 定位最后验证良好态 —— journal 回放 + LTLf 性质（只读消费 ltlf.ts）：
//      「已验证良好」= status SUCCESS 且 effect_detected !== false（判据核过/
//      动作验证过的步）。最近的良好步是回滚的锚点：其后的步才是待回滚债务。
//   ② 复合回滚计划 —— 模态逆映射表（type→全选退格、toggle→再点、scroll→
//      反向、shaper 操作→UndoRecipe 走 undoLog；其余模态如实申报 no-inverse，
//      绝不伪造逆动作）。计划有界（步数预算，与 W3-6 重放预算同量级的半额
//      原则）；超支 ⇒ 截断到最新的预算内步骤 + exceeded 诚实标记（复原验证
//      兜底 —— 不完整回滚骗不过指纹比对）。
//   ③ 破坏性逆动作过 approval 闸 —— type 的全选退格会清掉整个字段（不只
//      本次输入），这类「救一个毁一片」的逆动作绝不静默执行：每步派发前过
//      注入的审批端口，拒绝 ⇒ 立即停在安全态 + 诚实报告（绝不绕闸）。
//   ④ 复原验证 —— 回滚后场景指纹比对（容差内 = 与 W3-1 托管验证同律的
//      dHash similarity ≥ 0.9）。不复原 ⇒ 诚实报告并停在安全态（不再注入
//      替代分支 —— 从未复原的世界重规划是在流沙上盖楼）。
//   ⑤ 替代分支注入 —— 复原确认后，经 counterfactual/W3-6 岔路偏置风格
//      （preferredActionKeys 注入缝 —— 只读消费 branchCards.withSteerBias）
//      注入替代决策；分支重规划有总预算（ReplanBudgetController，超支诚实
//      终止 —— 重规划是第二尝试，不继承原任务全额预算）。
//
// 架构：纯函数核心（定位/逆映射/计划铸造/复原判定 —— 全离线可测）+ 注入
// 端口（执行/感知/审批/偏置全注入 —— 编排面不含任何物理世界触点）。
// 防御式绝不抛：一切公开面（纯函数与编排器）脏输入/端口故障一律收敛为
// 诚实返回值（no-good-state / internal-error / 保守缺省），绝不抛给调用方。
//
// 只读消费面：ltlf.ts（ltlF/violationsOf/reactTraceProperties）、
// perceptualHash.similarity、branchCards.withSteerBias（W3-6 偏置风格）、
// autonomy/counterfactual 的 ScoringContext 类型 —— 均为类型或纯函数依赖，
// 零写触点。
import { ltlF, violationsOf, reactTraceProperties } from './ltlf.js';
import { similarity } from './perceptualHash.js';
import { withSteerBias } from './branchCards.js';
// ─── 常量（值即边界） ───
/** 回滚步数预算：回滚是「退回良好态」的偿债，不是无限重试 —— 12 步与
 *  W3-6 换支重放预算同量级（branchCards.BRANCH_REPLAY_BUDGET_STEPS=12，
 *  同为「第二尝试不继承全额」原则）。 */
export const ROLLBACK_BUDGET_STEPS = 12;
/** 分支重规划总预算（替代分支注入后的重规划步数上限 —— 半额原则）。 */
export const REPLAN_BUDGET_STEPS = 8;
/** 复原验证容差：dHash similarity ≥ 0.9（与 reversalEscrow.DEFAULT_VERIFY_THRESHOLD
 *  同律 —— 「回到良好态」的抖动容忍带）。 */
export const RESTORATION_TOLERANCE = 0.9;
/** 轨迹步数上限（防御：脏调用方塞巨数组不得拖垮定位 —— 有界计算）。 */
const TRACE_HARD_CAP = 10_000;
/** 防御净化：脏步收敛（tool 非字符串 ⇒ 整步弃置 —— 不把噪声当轨迹） */
function sanitizeTrace(steps) {
    const out = [];
    if (!Array.isArray(steps))
        return out;
    for (const s of steps.slice(0, TRACE_HARD_CAP)) {
        if (!s || typeof s !== 'object' || typeof s.tool !== 'string' || s.tool === '')
            continue;
        const c = s;
        out.push({
            tool: c.tool.slice(0, 64),
            ...(typeof c.status === 'string' ? { status: c.status.slice(0, 32) } : {}),
            ...(typeof c.effect_detected === 'boolean' ? { effect_detected: c.effect_detected } : {}),
            ...(c.args && typeof c.args === 'object' && !Array.isArray(c.args) ? { args: c.args } : {}),
            ...(typeof c.fingerprint === 'string' && c.fingerprint !== '' ? { fingerprint: c.fingerprint.slice(0, 256) } : {}),
        });
    }
    return out;
}
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
/** 复原验证（纯函数）：当前指纹 vs 良好态指纹，容差内即复原。
 *  任一侧缺席 ⇒ unverified（无通道 ≠ 复原 —— 诚实降级，与 escrow 同律）。 */
export function verifyRestoration(current, checkpoint, tolerance = RESTORATION_TOLERANCE) {
    if (typeof checkpoint !== 'string' || checkpoint === '' || typeof current !== 'string' || current === '') {
        return { verdict: 'unverified' };
    }
    const tol = typeof tolerance === 'number' && Number.isFinite(tolerance) ? tolerance : RESTORATION_TOLERANCE;
    const sim = similarity(current, checkpoint);
    return { verdict: sim >= tol ? 'verified' : 'not-restored', similarity: Math.round(sim * 1000) / 1000 };
}
/**
 * 分支重规划预算控制器（W3-6 BranchReplayController 的镜像语义 —— 重规划
 * 是第二尝试，不继承原任务全额预算）：每步前 spend()；超支 ⇒ proceed=false
 * 诚实终止；complete() 收尾；exhausted 是终局（超支后再 complete 不改判）。
 */
export class ReplanBudgetController {
    stepsUsed = 0;
    status = 'armed';
    budgetSteps;
    constructor(budgetSteps) {
        this.budgetSteps = typeof budgetSteps === 'number' && Number.isFinite(budgetSteps)
            ? Math.max(1, Math.floor(budgetSteps)) : REPLAN_BUDGET_STEPS;
    }
    get state() {
        return { status: this.status, stepsUsed: this.stepsUsed, budgetSteps: this.budgetSteps };
    }
    spend() {
        if (this.status === 'completed') {
            return { proceed: false, state: this.state };
        }
        if (this.stepsUsed >= this.budgetSteps) {
            this.status = 'exhausted';
            return { proceed: false, state: this.state };
        }
        this.stepsUsed += 1;
        this.status = 'stepping';
        return { proceed: true, state: this.state };
    }
    complete() {
        if (this.status !== 'exhausted')
            this.status = 'completed';
    }
}
/**
 * 缺省替代键推导（纯函数）：复原锚点之前**成功过**且未陷入失败尾部的模态 ——
 * 「重选此前验证有效、未参与本次失败的路线」（W3-6 岔路偏置的自带推导面：
 * 调用方未显式提供 alternativeKeys 时的保守缺省）。无可用键 ⇒ 空数组（诚实）。
 */
export function defaultAlternativeKeys(steps, checkpointIndex) {
    const clean = sanitizeTrace(steps);
    const cp = Math.max(0, Math.floor(checkpointIndex));
    const goodTools = new Set();
    for (let i = 0; i <= cp && i < clean.length; i++) {
        if (isVerifiedGood(clean[i]))
            goodTools.add(clean[i].tool);
    }
    const failedTail = new Set(clean.slice(cp + 1).map(s => s.tool));
    return [...goodTools].filter(t => !failedTail.has(t)).slice(0, 8);
}
/** 自带偏置注入缝的最近一次记录（缺省端口的落点 —— 测试/宿主可读） */
let lastBias = null;
/** 最近一次经缺省缝注入的替代分支（无 ⇒ null；深拷贝） */
export function pendingBiasOf() {
    return lastBias === null ? null : JSON.parse(JSON.stringify(lastBias));
}
/**
 * W3-6 岔路偏置风格的注入端口适配器（只读消费 branchCards.withSteerBias）：
 * 把 R3 的替代分支偏置铸进 counterfactual 的 ScoringContext.preferredActionKeys
 * 注入缝（偏置只改选择不改预测 —— 与 W3-6 换支重放同一偏置协议）。biased()
 * 取出已偏置的评分上下文供重规划决策消费。
 */
export function createSteerBiasPort(initial) {
    let biased = null;
    return {
        injectBias: async (bias) => {
            try {
                biased = withSteerBias(initial, bias.preferredActionKeys);
                const merged = biased?.preferredActionKeys ?? [];
                const ok = bias.preferredActionKeys.every(k => merged.includes(k));
                return ok
                    ? { ok: true }
                    : { ok: false, detail: 'steer bias merge lost keys (empty/invalid signatures rejected by withSteerBias)' };
            }
            catch (e) {
                return { ok: false, detail: e instanceof Error ? e.message : String(e) };
            }
        },
        biased: () => biased,
    };
}
/** 端口防御包装：端口缺席 ⇒ fallback；抛错 ⇒ degraded（绝不炸编排器） */
async function safePort(fn, fallback, onThrow) {
    if (typeof fn !== 'function')
        return fallback;
    try {
        return await fn();
    }
    catch (e) {
        return onThrow(e);
    }
}
/**
 * 执行有界回滚 + 分支重规划注入（R3 主入口；绝不抛）：
 *   定位良好态 → 铸造有界计划 → LIFO 逐步执行（破坏性步过审批闸；执行失败
 *   即停）→ 复原验证（指纹比对容差内）→ 仅 verified 注入替代分支偏置 +
 *   交出重规划预算；not-restored / unverified ⇒ 诚实报告停安全态（unverified
 *   不注入分支 —— 「未确认复原」不满足「复原确认后」的注入前提）。
 */
export async function executeRollback(steps, ports, opts = {}) {
    try {
        const clean = sanitizeTrace(steps);
        const loc = locateLastVerifiedGood(clean);
        if (loc.index === null) {
            return {
                phase: 'no-good-state',
                report: 'no verified-good checkpoint found in the trace (no step with SUCCESS status and verified effect) — ' +
                    'nowhere safe to roll back to; stopping',
                traceAudit: loc.traceAudit,
                safeStop: true,
            };
        }
        const cp = loc.index;
        if (cp >= clean.length - 1) {
            return {
                phase: 'nothing-to-rollback',
                checkpointIndex: cp,
                report: `last verified-good step (index ${cp}) is the final step — nothing to roll back`,
                safeStop: false,
            };
        }
        const plan = buildRollbackPlan(clean, cp, {
            ...(opts.maxRollbackSteps !== undefined ? { maxRollbackSteps: opts.maxRollbackSteps } : {}),
            ...(opts.checkpointFingerprint !== undefined ? { fingerprint: opts.checkpointFingerprint } : {}),
        });
        const executedSteps = [];
        const skippedNoInverse = [];
        let executedCount = 0;
        for (const step of plan.steps) {
            if (step.modality === 'no-inverse') {
                skippedNoInverse.push(step.payload.label);
                continue; // 无逆模态：如实申报跳过（复原验证兜底 —— 骗不过指纹）
            }
            if (executedCount >= plan.budget.maxSteps)
                break; // 双保险（截断后不可达）
            if (step.destructive) {
                // 破坏性逆动作过 approval 闸 —— 拒绝（含端口故障 fail-closed）⇒ 停安全态
                const verdict = await safePort(() => ports.requestApproval({
                    step,
                    reason: `destructive inverse for "${step.origin.tool}": ${step.payload.label} — this undo itself can destroy data`,
                }), { approved: false, detail: 'approval port absent — failing closed (destructive inverse never runs silently)' }, (e) => ({ approved: false, detail: `approval port threw: ${e instanceof Error ? e.message : String(e)}` }));
                if (!verdict.approved) {
                    return {
                        phase: 'approval-denied',
                        denied: step,
                        ...(typeof verdict.detail === 'string' && verdict.detail !== '' ? { denialDetail: verdict.detail } : {}),
                        executedSteps: [...executedSteps],
                        report: `destructive inverse "${step.payload.label}" was NOT approved (${verdict.detail ?? 'denied'}) — ` +
                            `rollback stopped in a safe state after ${executedSteps.length} step(s); ` +
                            `${plan.steps.length - executedSteps.length - skippedNoInverse.length} inverse step(s) left unexecuted`,
                        safeStop: true,
                    };
                }
            }
            const r = await safePort(() => ports.execute(step), { ok: false, detail: 'executor port absent — cannot perform the inverse' }, (e) => ({ ok: false, detail: `executor threw: ${e instanceof Error ? e.message : String(e)}` }));
            if (!r.ok) {
                return {
                    phase: 'execution-failed',
                    failed: step,
                    failureDetail: r.detail ?? 'executor reported failure',
                    executedSteps: [...executedSteps],
                    report: `inverse "${step.payload.label}" FAILED (${r.detail ?? 'unknown'}) — rollback stopped in a safe ` +
                        `state after ${executedSteps.length} step(s); the world may be partially rolled back`,
                    safeStop: true,
                };
            }
            executedSteps.push(step.payload.label);
            executedCount++;
        }
        // ④ 复原验证（指纹比对 —— 容差内确认复原）
        const currentFp = await safePort(() => ports.fingerprint(), null, () => null);
        const verdict = verifyRestoration(currentFp, plan.checkpointFingerprint, opts.fingerprintTolerance);
        // ⑤ 替代分支注入（仅 verified —— 复原确认后才有资格重规划）
        let branch = null;
        if (verdict.verdict === 'verified') {
            const keys = (Array.isArray(opts.alternativeKeys)
                ? opts.alternativeKeys.filter((k) => typeof k === 'string' && k.trim() !== '').slice(0, 8)
                : defaultAlternativeKeys(clean, cp));
            const replan = new ReplanBudgetController(opts.replanBudgetSteps);
            const reason = `post-rollback replan from verified-good checkpoint (index ${cp}): prefer previously ` +
                `verified-effective modalities not involved in the failed tail${plan.budget.exceeded ? ' (rollback was budget-truncated — restoration verified anyway)' : ''}`;
            if (typeof ports.injectBias === 'function') {
                // 外部偏置端口（counterfactual/W3-6 岔路偏置风格 —— 只读消费方注入）
                const inj = await safePort(() => ports.injectBias({ preferredActionKeys: keys, reason }), undefined, () => undefined);
                branch = inj !== undefined
                    ? {
                        preferredActionKeys: keys, reason, injected: inj.ok,
                        ...(inj.detail !== undefined ? { detail: inj.detail } : {}),
                        replan: replan.state,
                    }
                    : {
                        preferredActionKeys: keys, reason, injected: false,
                        detail: 'bias port threw — injection failed honestly (replan budget NOT handed out)',
                        replan: replan.state,
                    };
            }
            else {
                // 自带偏置注入缝：无外部端口 ⇒ 记录待消费（宿主/测试经 pendingBiasOf 读）
                lastBias = {
                    preferredActionKeys: keys, reason, injected: keys.length > 0,
                    ...(keys.length === 0 ? { detail: 'no alternative branch keys derivable — bias recorded empty (honest)' } : {}),
                    replan: replan.state,
                };
                branch = JSON.parse(JSON.stringify(lastBias));
            }
        }
        const restorationDetail = verdict.verdict === 'verified'
            ? `scene fingerprint returned within tolerance of the checkpoint state (similarity ${verdict.similarity})`
            : verdict.verdict === 'not-restored'
                ? 'scene fingerprint does NOT match the checkpoint state — restoration NOT confirmed; ' +
                    'stopping in a safe state (no replan from an unverified world)'
                : 'no verification channel (checkpoint fingerprint or perception absent) — restoration UNVERIFIED (honest degradation)';
        const report = `rollback of ${executedCount} inverse step(s) toward checkpoint ${cp} complete` +
            (skippedNoInverse.length > 0 ? `; ${skippedNoInverse.length} step(s) had no inverse and were skipped (flagged)` : '') +
            (plan.budget.exceeded ? `; budget exceeded (${plan.budget.requiredSteps} required > ${plan.budget.maxSteps} allowed) — plan truncated to the newest steps` : '') +
            `; restoration: ${verdict.verdict}` +
            (branch !== null && branch.injected ? `; alternative branch bias injected (${branch.preferredActionKeys.length} key(s))` : '');
        return {
            phase: 'completed',
            checkpointIndex: cp,
            plan,
            executedSteps,
            skippedNoInverse,
            restoration: verdict.verdict,
            restorationDetail,
            ...(verdict.similarity !== undefined ? { restorationSimilarity: verdict.similarity } : {}),
            branch,
            safeStop: verdict.verdict !== 'verified',
            report,
        };
    }
    catch (e) {
        return {
            phase: 'internal-error',
            report: `rollback planner internal error (defensive stop): ${e instanceof Error ? e.message : String(e)}`,
            safeStop: true,
        };
    }
}
/** W4-3（R3）：隔离缝（测试 beforeEach / 插件卸载）—— 自带偏置缝记录归零 */
export function resetRollbackPlanner() {
    lastBias = null;
}
