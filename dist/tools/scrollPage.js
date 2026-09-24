// src/tools/scrollPage.ts
// dirMap 一石二鸟：合法值枚举 + 方向翻译表，!dirMap[direction] 一行完成校验。
// 修复原版「四方向全部 scrollDown」bug；滚动结果不可见 -> 回显自带复查指令。
// B-4：返回值统一走 toolResult 工厂（反幻觉锚点全覆盖）。
//
// Y-3 闭环滚动（Epoch Y）：滚动从「发射后不管」升维为「发射后测量」——
// 前后帧行亮度互相关（motionEstimator）给出实际内容位移（亚行精度）、
// 方向一致性、滚动边界判决。锚点直接回答「滚了吗 / 滚对了没 / 到底了没」。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system.js';
import * as backend from '../physicalBackend.js';
import { sleep } from '../actionVerifier.js';
import { estimateRowShift, judgeScroll } from '../motionEstimator.js';
import { toolOk, toolErr } from '../toolResult.js';
export function createScrollPageTool(config) {
    return defineTool({
        name: 'scroll_page',
        description: 'Scrolls the page up/down/left/right to reveal hidden content — CLOSED-LOOP: the result ' +
            'reports the actual content shift (sub-row precision, via row-brightness cross-correlation), ' +
            'whether it matched the requested direction, and whether the scroll boundary was reached.',
        parameters: {
            direction: {
                type: 'string',
                required: true,
                description: 'The scroll direction. Options: "up", "down", "left", "right".',
            },
            amount: {
                type: 'number',
                description: 'The scroll distance (number of scroll lines). Defaults to 5.',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            const { direction, amount = 5 } = args;
            const dirMap = {
                up: 'up', down: 'down', left: 'left', right: 'right',
            };
            if (!dirMap[direction]) {
                return toolErr('Scroll validation failed.', `Invalid direction "${direction}".`, 'Retry with one of: up, down, left, right.');
            }
            const dir = dirMap[direction];
            try {
                // 闭环：滚动前帧（入环）→ 滚动 → 稳定 → 滚动后帧（入环）→ 互相关
                const verify = config.verifyActions && !config.dryRun;
                const before = verify
                    ? await backend.captureProcessed({ metaOnly: true, keepFrame: true })
                    : null;
                await system.scroll(dir, amount);
                if (!before || !before.frameId) {
                    return toolOk(`Scrolled '${direction}' by ${amount} lines.`, { direction, amount }, "Call 'take_screenshot' to check if the target element is now visible. " +
                        "If not, scroll again or check whether the page has its own inner scroll region.");
                }
                await sleep(Math.max(config.actionSettleMs, 250));
                const after = await backend.captureProcessed({ metaOnly: true, keepFrame: true });
                if (!after.frameId) {
                    return toolOk(`Scrolled '${direction}' by ${amount} lines.`, { direction, amount, closed_loop: 'unavailable (frame cache miss)' }, "Call 'take_screenshot' to verify.");
                }
                const [rowsA, rowsB] = await Promise.all([
                    backend.frameRowmeans(before.frameId, 64),
                    backend.frameRowmeans(after.frameId, 64),
                ]);
                const est = estimateRowShift(rowsA, rowsB);
                const verdict = judgeScroll(est, dir);
                return JSON.stringify({
                    status: 'SUCCESS',
                    action: `Scrolled '${direction}' by ${amount} lines.`,
                    state_anchor: {
                        direction,
                        amount,
                        closed_loop: {
                            content_shift_rows: est.shift,
                            residual: est.residual,
                            effective: verdict.effective,
                            direction_consistent: verdict.directionConsistent,
                            at_boundary: verdict.atBoundary, // 到达滚动边界了吗
                        },
                    },
                    next_step: verdict.atBoundary
                        ? 'AT BOUNDARY: the content did not move and the frames are truly static — you have reached the scroll end. ' +
                            'Do NOT keep scrolling in this direction; take_screenshot to reassess.'
                        : !verdict.effective
                            ? 'NO EFFECT: the content barely moved — the scrollable area may not be focused. ' +
                                "Click inside the scrollable region first, then retry."
                            : verdict.directionConsistent === false
                                ? 'DIRECTION MISMATCH: content moved OPPOSITE to the request (natural scrolling may be inverted). ' +
                                    "Check with take_screenshot before scrolling again."
                                : "Call 'take_screenshot' to check if the target element is now visible. " +
                                    'If not, scroll again or check whether the page has its own inner scroll region.',
                }, null, 2);
            }
            catch (error) {
                return toolErr(`Scroll '${direction}' failed.`, error.message, 'The scroll target may not be focused. Click inside the scrollable area first, then retry.');
            }
        },
    });
}
