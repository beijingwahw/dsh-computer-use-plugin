// src/tools/replayActions.ts
// 突破三的工具面：行动重放。日志中的动作序列 = 可执行的宏。
// confirm:true 显式确认（防误触发真实桌面操作）；步数上限由配置约束；
// click_element 依赖运行时元素缓存，重放时显式跳过并说明原因。
// B-4：返回值统一走 toolResult 工厂（反幻觉锚点全覆盖）。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system.js';
import { journal } from '../journal.js';
import * as backend from '../physicalBackend.js';
import { normalizeHash, hammingDistance } from '../perceptualHash.js';
// ─── Y-6 重放场景门控（Epoch Y：宏从「盲目复读」升维为「带门控的执行」）───
//
// 数学：每步前后取全屏 dhash，汉明距离 ≤ deadStepDistance ⇒ 该步是「死步」
// （重放的点击落在已变化的 UI 上，什么都没发生）。策略：死步即停（fail-fast）
// —— 宏的后续步骤建立在死步的前提之上，继续只会制造连锁错误。与幂等重试
// 的区别：这里重放的是「历史」，历史的前提已崩塌时诚实中止并报告分叉点。
export const DEAD_STEP_DISTANCE = 1;
/** 死步判决（纯函数 —— 测试的确定性事实源） */
export function isDeadStep(hashBefore, hashAfter, deadDistance = DEAD_STEP_DISTANCE) {
    if (!hashBefore || !hashAfter)
        return false; // 证据缺席：不判死（放行）
    return hammingDistance(normalizeHash(hashBefore), normalizeHash(hashAfter)) <= deadDistance;
}
import { sleep } from '../actionVerifier.js';
import { toolOk, toolErr, toolActionRequired } from '../toolResult.js';
import { assertActionAllowed, SAFETY_GATE_BLOCK } from './actionGate.js';
import { approval } from '../approval.js';
export function createReplayActionsTool(config) {
    return defineTool({
        name: 'replay_actions',
        description: 'Replays recorded actions from the journal (a macro). Use this to repeat a previously ' +
            'successful action sequence, e.g., re-opening the same workflow. Requires confirm=true.',
        parameters: {
            confirm: { type: 'boolean', required: true, description: 'Must be explicitly true to execute.' },
            from_step: { type: 'number', description: '0-based start index in the journal. Default 0.' },
            to_step: { type: 'number', description: '0-based end index (inclusive). Default: latest.' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            if (!config.enableJournal) {
                return toolErr('Replay unavailable.', 'Journal is disabled (enableJournal=false). Nothing to replay.', 'Enable the journal in config to record and replay actions.');
            }
            if (args.confirm !== true) {
                return toolActionRequired('Replay awaiting explicit confirmation.', 'replay-needs-confirm', { current_state: 'Replay is a real-world side-effect operation.' }, 'Set confirm=true to execute the replay, or inspect the plan first via the dry-run report.');
            }
            const all = journal.list();
            // J 纪元修正：to_step 补下界钳制 —— 旧实现只有上界 min(len-1)，
            // to_step=-5 时 slice(0, -4) 静默选中「除最后 4 条外的全部」并重放，
            // 与钳制 from 的初衷自相矛盾。NaN 防御：Math.max(0, NaN)=NaN，slice 视
            // NaN 为 0 —— 非有限数一律按缺省记，绝不让坏下标静默扩大重放范围。
            const fromStep = typeof args.from_step === 'number' && Number.isFinite(args.from_step)
                ? args.from_step
                : 0;
            const toStep = typeof args.to_step === 'number' && Number.isFinite(args.to_step)
                ? args.to_step
                : all.length - 1;
            const from = Math.max(0, fromStep);
            const to = Math.max(from, Math.min(all.length - 1, toStep));
            const steps = all.slice(from, to + 1);
            if (steps.length === 0) {
                return toolOk(`No replayable actions in range [${from}, ${to}].`, { range: { from, to }, journal_length: all.length }, 'Adjust from_step/to_step, or perform the actions manually — the journal may be empty or the range is out of bounds.');
            }
            if (steps.length > config.replayMaxSteps) {
                return toolErr('Replay rejected.', `${steps.length} steps exceed replayMaxSteps (${config.replayMaxSteps}).`, 'Narrow the from_step/to_step range and retry in batches.');
            }
            const log = [];
            let halted = null;
            let haltGate = 'dead-step';
            const gated = config.verifyActions && !config.dryRun;
            for (let i = 0; i < steps.length; i++) {
                const entry = steps[i];
                // Y-6 场景门控：动作步前取指纹（观察型步骤无副作用，免门控开销）
                const isActionStep = ['click_mouse', 'type_text', 'scroll_page', 'press_hotkey', 'drag_mouse'].includes(entry.tool);
                const before = gated && isActionStep
                    ? await backend.captureProcessed({ metaOnly: true, wantHashes: true })
                    : null;
                const line = await replayOne(entry, config);
                log.push(`#${entry.ts} ${entry.tool}: ${line}`);
                await sleep(150); // 步间微歇，给 UI 响应时间
                // Δ 纪元（审计#1）：安全闸门拦截 ⇒ fail-fast 中止 —— 宏的后续步骤建立在
                // 被拦截的不可逆步骤之上，继续只会制造半途而废的世界状态（与 Y-6 死步
                // 即停同律：诚实中止并报告分叉点）。
                if (line.includes(SAFETY_GATE_BLOCK)) {
                    halted = { index: i, tool: entry.tool };
                    haltGate = 'safety-gate';
                    log.push(`  [GATE] step ${i} 重放被安全闸门拦截 — replay halted (dangerous/gated step was NOT executed)`);
                    break;
                }
                // 派发失败即停：FAILED 步 = 物理动作根本没执行（system 层异常）—— 比
                // 死步（执行了但无效）更强的事实，后续步骤的前提同样已崩塌，继续只会
                // 制造连锁错误（与 Y-6 死步即停 / Δ 纪元闸门即停同律）
                if (line.startsWith('FAILED:')) {
                    halted = { index: i, tool: entry.tool };
                    haltGate = 'step-failure';
                    log.push(`  [GATE] step ${i} dispatch FAILED — replay halted (the step did NOT execute)`);
                    break;
                }
                if (before?.dhash) {
                    const after = await backend.captureProcessed({ metaOnly: true, wantHashes: true });
                    if (isDeadStep(before.dhash, after.dhash ?? null)) {
                        halted = { index: i, tool: entry.tool };
                        haltGate = 'dead-step';
                        log.push(`  [GATE] step ${i} produced NO screen change — replay halted (the UI has diverged from the recorded scene)`);
                        break;
                    }
                }
            }
            if (halted) {
                return JSON.stringify({
                    status: 'PARTIAL_FAILURE',
                    state_anchor: {
                        replayed_steps: halted.index,
                        total_steps: steps.length,
                        diverged_at_step: halted.index,
                        diverged_tool: halted.tool,
                        gate: haltGate === 'safety-gate'
                            ? 'pre-dispatch safety gate (approval/risk) — 重放被安全闸门拦截'
                            : haltGate === 'step-failure'
                                ? 'step dispatch failure (system-layer exception) — 该步未执行即失败'
                                : 'per-step scene hash (dHash dead-step detection)',
                    },
                    execution_log: log.join('\n'),
                    next_step: haltGate === 'safety-gate'
                        ? 'REPLAY HALTED: a step was BLOCKED by the safety gate (irreversible target without a valid approval ' +
                            'token, or gated input) and was NOT executed. Re-run that step live via click_mouse/type_text with ' +
                            'proper user consent (request_approval → grant_approval), then continue the remaining steps manually.'
                        : haltGate === 'step-failure'
                            ? 'REPLAY HALTED: a step FAILED to dispatch (system-layer exception — the action did NOT execute; ' +
                                'see execution_log for the error). take_screenshot to inspect the current state, re-run the failed ' +
                                'step live, then continue the remaining steps.'
                            : 'REPLAY HALTED: a step produced zero screen change — the current UI no longer matches the scene ' +
                                'where this macro was recorded. take_screenshot, re-record the affected steps (save_skill), and replay the rest.',
                }, null, 2);
            }
            return toolOk(`Replayed ${steps.length} action(s).`, { replayed_steps: steps.length, detail: log }, "Call 'take_screenshot' to verify the final state matches the expected outcome.");
        },
    });
}
/** 单条日志/技能步骤 → 系统层调用。依赖运行时缓存的工具（click_element）显式跳过。
 *  Δ 纪元（审计#1）：重放不再豁免工具层闸门 —— click_mouse/type_text 步前置
 *  assertActionAllowed（与 clickMouse/typeText 工具同一事实源）：危险词命中且
 *  步骤无有效审批令牌、或凭据/超长输入 ⇒ 该步返回结构化失败（FAILED 形态，
 *  不派发物理动作）；replay_actions 循环据此 fail-fast 中止，run_skill 据此
 *  计失败步。config 由调用方透传（缺省 = 与 Config 缺省同值的保守闸门）。 */
export async function replayOne(entry, config) {
    const a = entry.args ?? {};
    try {
        if (entry.tool === 'click_mouse' || entry.tool === 'type_text') {
            const gate = assertActionAllowed(entry.tool, a, config);
            if (!gate.allowed) {
                return `FAILED: [${SAFETY_GATE_BLOCK}] 重放被安全闸门拦截 (${gate.reason}) — replayed journal/skill steps ` +
                    'pass through the SAME approval/risk gates as live tool calls; re-run this step live via the real tool ' +
                    'with a valid approval_token (or user-entered credentials for sensitive input).';
            }
            // 带有效令牌的危险重放步：派发前预留尝试预算（审计#2 同律 —— 重放不经
            // clickMouse 的验收链路，预算即预算）；在途/耗尽 ⇒ 拦截，不派发。
            if (entry.tool === 'click_mouse' && gate.dangerous && a.approval_token) {
                if (!approval.beginAttempt(String(a.approval_token))) {
                    return `FAILED: [${SAFETY_GATE_BLOCK}] 重放被安全闸门拦截 (attempt-in-flight-or-budget-exhausted) — ` +
                        "the approval token's retry budget is exhausted or another attempt is still in flight.";
                }
            }
        }
        switch (entry.tool) {
            case 'click_mouse': {
                // 尺寸只取一次：两次独立异步读在分辨率切换间隙会用不同比例映射 x/y
                const s = await system.getScreenSize();
                await system.clickMouse(a.x * s.width, a.y * s.height, a.button ?? 'left');
                return 'clicked';
            }
            case 'type_text':
                await system.typeText(a.text ?? '', a.clearFirst ?? false);
                return 'typed';
            case 'scroll_page':
                await system.scroll(a.direction ?? 'down', a.amount ?? 5);
                return 'scrolled';
            case 'press_hotkey':
                await system.pressHotkey(a.keys ?? []);
                return 'hotkey pressed';
            case 'drag_mouse': {
                const s = await system.getScreenSize();
                await system.dragMouse({ x: a.startX * s.width, y: a.startY * s.height }, { x: a.endX * s.width, y: a.endY * s.height });
                return 'dragged';
            }
            case 'switch_tab':
                await system.pressHotkey(a.direction === 'previous' ? ['ctrl', 'shift', 'tab'] : ['ctrl', 'tab']);
                return 'tab switched';
            case 'switch_window':
                await system.switchWindowByTitle(String(a.titleKeyword ?? ''));
                return 'window switched';
            case 'click_element':
                return 'SKIPPED (element-ID tools depend on runtime cache; replay with click_mouse coordinates instead)';
            case 'dismiss_popup':
                // 纯模型侧恢复指令（无机械动作）—— 宏里是无害占位，不作为失败计
                return 'OK (model-side recovery instruction; nothing to execute)';
            default:
                return `SKIPPED (unsupported for replay: ${entry.tool})`;
        }
    }
    catch (e) {
        return `FAILED: ${e.message}`;
    }
}
