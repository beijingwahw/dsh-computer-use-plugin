import { onToolPre, onToolPost } from './hooks.js';
import { ACTION_TOOLS } from '../journal.js';
import { classifyResult } from '../resultContract.js';
export function registerRepeatActionGuard(ctx) {
    const MAX_TRACKED_SESSIONS = 16;
    const bySession = new Map();
    const stateFor = (sessionId) => {
        let s = bySession.get(sessionId);
        if (!s) {
            // 容量上限：Map 保插入序，超限时逐出最旧会话（活跃会话的 get 会刷新不到
            // 插入序 —— 但 16 个并发会话已远超本插件的真实部署形态，简单逐出够用）
            if (bySession.size >= MAX_TRACKED_SESSIONS) {
                const oldest = bySession.keys().next().value;
                if (oldest !== undefined)
                    bySession.delete(oldest);
            }
            s = { lastSig: '', lastNoEffect: false, repeatCount: 0, pendingSig: '', pendingTool: '' };
            bySession.set(sessionId, s);
        }
        return s;
    };
    onToolPre(ctx, async (call, next) => {
        // 只管动作类工具；dismiss_popup 是幂等元工具，放行
        if (!ACTION_TOOLS.includes(call.name) || call.name === 'dismiss_popup')
            return next();
        const st = stateFor(call.sessionId ?? '_anon');
        // T 纪元（T-1）：量化相似签名 —— 数值参数四舍五入到 0.01 网格后铸签。
        // 旧逐字节签名对坐标抖动（0.501 vs 0.500）失明 —— 同一按钮的微移重试
        // 不算「重复」，防死循环守卫被抖动绕过。量化后抖动同签（物理分辨率
        // 0.01 ≈ 屏上 ~20px@1080p —— 低于此差的两次点击本就是同一意图）。
        const sig = call.name + ':' + JSON.stringify(call.args ?? {}, (_k, v) => typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
        if (sig === st.lastSig) {
            st.repeatCount++;
            if ((st.lastNoEffect && st.repeatCount >= 1) || st.repeatCount >= 2) {
                st.repeatCount = 0;
                st.lastSig = ''; // 重置：拦截后若模型仍发同签名，再走计数
                return `[Guard Blocked]: Repeated identical action ('${call.name}') with no effect last time. ` +
                    `Repeating it will likely fail again. Change strategy: 'zoom_inspect' to refine coordinates, ` +
                    `'recall_ui' for remembered locations, keyboard navigation via 'press_hotkey', or 'scroll_page' if the target may be off-screen.`;
            }
        }
        else {
            st.repeatCount = 0;
        }
        st.pendingSig = sig;
        st.pendingTool = call.name;
        return next();
    });
    onToolPost(ctx, async (call, result, next) => {
        const st = bySession.get(call.sessionId ?? '_anon');
        if (typeof result === 'string' && st?.pendingSig) {
            // J 纪元修正（stale 签名防线）：上一个调用的 post 缺席（工具抛错）时，
            // 本 post 属于别的工具 —— 签名与结果不配对，宁丢弃勿错配
            // （旧实现会把上一调用的签名与本结果张冠李戴，lastNoEffect 污染）。
            if (call.name !== st.pendingTool) {
                st.pendingSig = '';
                st.pendingTool = '';
                return next(result);
            }
            st.lastSig = st.pendingSig;
            st.pendingSig = '';
            st.pendingTool = '';
            const c = classifyResult(result);
            const noEffect = c.status === 'FAILED' || c.noop; // 失败或盲点（SUCCESS 但无效果）
            st.lastNoEffect = noEffect;
        }
        return next(result);
    });
}
