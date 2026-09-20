import { onToolPre, onToolPost } from './hooks.js';
import { ACTION_TOOLS } from '../journal.js';
import { classifyResult } from '../resultContract.js';
export function registerRepeatActionGuard(ctx) {
    let lastSig = '';
    let pendingSig = '';
    let pendingTool = '';
    let lastNoEffect = false;
    let repeatCount = 0;
    onToolPre(ctx, async (call, next) => {
        // 只管动作类工具；dismiss_popup 是幂等元工具，放行
        if (!ACTION_TOOLS.includes(call.name) || call.name === 'dismiss_popup')
            return next();
        const sig = call.name + ':' + JSON.stringify(call.args ?? {});
        if (sig === lastSig) {
            repeatCount++;
            if ((lastNoEffect && repeatCount >= 1) || repeatCount >= 2) {
                repeatCount = 0;
                lastSig = ''; // 重置：拦截后若模型仍发同签名，再走计数
                return `[Guard Blocked]: Repeated identical action ('${call.name}') with no effect last time. ` +
                    `Repeating it will likely fail again. Change strategy: 'zoom_inspect' to refine coordinates, ` +
                    `'recall_ui' for remembered locations, keyboard navigation via 'press_hotkey', or 'scroll_page' if the target may be off-screen.`;
            }
        }
        else {
            repeatCount = 0;
        }
        pendingSig = sig;
        pendingTool = call.name;
        return next();
    });
    onToolPost(ctx, async (call, result, next) => {
        if (typeof result === 'string' && pendingSig) {
            // J 纪元修正（stale 签名防线）：上一个调用的 post 缺席（工具抛错）时，
            // 本 post 属于别的工具 —— 签名与结果不配对，宁丢弃勿错配
            // （旧实现会把上一调用的签名与本结果张冠李戴，lastNoEffect 污染）。
            if (call.name !== pendingTool) {
                pendingSig = '';
                pendingTool = '';
                return next(result);
            }
            lastSig = pendingSig;
            pendingSig = '';
            pendingTool = '';
            const c = classifyResult(result);
            const noEffect = c.status === 'FAILED' || c.noop; // 失败或盲点（SUCCESS 但无效果）
            lastNoEffect = noEffect;
        }
        return next(result);
    });
}
