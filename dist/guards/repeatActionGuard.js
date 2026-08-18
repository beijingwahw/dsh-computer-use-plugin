import { onToolPre, onToolPost } from './hooks.js';
import { ACTION_TOOLS } from '../journal.js';
export function registerRepeatActionGuard(ctx) {
    let lastSig = '';
    let pendingSig = '';
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
        return next();
    });
    onToolPost(ctx, async (_call, result, next) => {
        if (typeof result === 'string' && pendingSig) {
            lastSig = pendingSig;
            pendingSig = '';
            let noEffect = result.includes('[Error]') || result.includes('"status": "FAILED"');
            try {
                const obj = JSON.parse(result);
                if (obj?.state_anchor?.effect?.detected === false)
                    noEffect = true; // 盲点也算无效
            }
            catch { /* 前缀协议字符串已由 includes 覆盖 */ }
            lastNoEffect = noEffect;
        }
        return next(result);
    });
}
