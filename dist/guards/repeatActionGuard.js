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
        // T 纪元（T-1）：量化相似签名 —— 数值参数四舍五入到 0.01 网格后铸签。
        // 旧逐字节签名对坐标抖动（0.501 vs 0.500）失明 —— 同一按钮的微移重试
        // 不算「重复」，防死循环守卫被抖动绕过。量化后抖动同签（物理分辨率
        // 0.01 ≈ 屏上 ~20px@1080p —— 低于此差的两次点击本就是同一意图）。
        const sig = call.name + ':' + JSON.stringify(call.args ?? {}, (_k, v) => typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
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
