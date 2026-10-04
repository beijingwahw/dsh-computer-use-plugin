import { onToolPre, onToolPost } from './hooks.js';
import { ACTION_TOOLS } from '../journal.js';
import { classifyResult } from '../resultContract.js';
// ─── W6R-A9：量化网格与轨迹阈值常量（集中立法，便于调参）───
/** 签名网格倒数：1000 = 0.001 步长（旧 100 = 0.01，收紧十倍）。
 *  半格内（≤0.0005）抖动同签 —— 低于此差的两次点击本就是同一意图；
 *  更大的微调不再 collapsing 进同签（交给轨迹级检测审判）。 */
const SIGNATURE_GRID = 1000;
/** 轨迹级近参数网格倒数：20 = 0.05 步长（比签名网格粗 50 倍）。
 *  0.05 归一化位移 ≈ 1080p 屏上 ~54px —— 同一控件级别的挪动仍算「近参数」；
 *  跨控件的真实换目标（≥0.05）不算。桶判等只是近参数的快路径（见 D-D11
 *  的 TRAJECTORY_NEAR_EPS —— 桶边界的半格悬崖由叶级真数值距离比较兜住）。 */
const TRAJECTORY_GRID = 20;
/** D-D11：叶级近参数数值阈 —— 同名数值叶 |a−b| ≤ 1/TRAJECTORY_GRID(=0.05)
 *  即近参数，以真数值距离独立于桶边界判决。桶判等保留为快路径（同桶 ⇔
 *  各叶落在同一 0.05 桶 ⇒ 各叶 |a−b| < 0.05 ⊆ 阈内），数值距离比较补上
 *  「跨桶但阈内」的半格悬崖带（0.50↔0.53 类交替微调）。 */
const TRAJECTORY_NEAR_EPS = 1 / TRAJECTORY_GRID;
/** 轨迹级滑动窗口：只统计最近 N 个动作类调用（观察类工具不入环）。 */
const TRAJECTORY_WINDOW = 8;
/** 轨迹级循环阈值：窗口内近参数出现 ≥K 次（含本次）即拦截。
 *  取 5/8 而非更小 —— 合法重试（失败后换微调再试 2-3 次）与交替双目标
 *  （各占半窗）都不得误杀；宁可放过缓慢爬行的循环，不可拦住正常探索。 */
const TRAJECTORY_MAX_REPEATS = 5;
/** 量化序列化：数值叶子取整到网格后铸串（网格倒数取整避免浮点除法尾差） */
function quantizedSig(name, args, gridRecip) {
    return name + ':' + JSON.stringify(args ?? {}, (_k, v) => typeof v === 'number' && Number.isFinite(v) ? Math.round(v * gridRecip) / gridRecip : v);
}
/** 数值叶剖面铸造：args 中有限数值叶按 JSON 遍历序抽出（挖空为 null 占位），
 *  其余结构原样序列化 —— 字符串/布尔/键形差异在骨架上逐字节判等（距离
 *  宽容只给同名数值叶，不放过换文本/换结构的真换目标）。 */
function leafProfile(name, args) {
    const numbers = [];
    const walk = (v) => {
        if (typeof v === 'number' && Number.isFinite(v)) {
            numbers.push(v);
            return null;
        }
        if (Array.isArray(v))
            return v.map(walk);
        if (v && typeof v === 'object') {
            const out = {};
            for (const [k, item] of Object.entries(v))
                out[k] = walk(item);
            return out;
        }
        return v;
    };
    return {
        coarse: quantizedSig(name, args, TRAJECTORY_GRID),
        skeleton: name + ':' + JSON.stringify(walk(args ?? {})),
        numbers,
    };
}
/** D-D11 近参数判等：桶判等 ∪ 叶级真数值距离判等。
 *  ① 同桶（coarse 相等）⇒ 近参数 —— W6R-A9 原语义，保持计数只增不减；
 *  ② 骨架全同且每个同名数值叶 |a−b| ≤ TRAJECTORY_NEAR_EPS ⇒ 近参数 ——
 *    消灭「跨桶但阈内」的半格悬崖带。二者都不成立 ⇒ 真换目标。 */
function isNearParam(a, b) {
    if (a.coarse === b.coarse)
        return true;
    if (a.skeleton !== b.skeleton || a.numbers.length !== b.numbers.length)
        return false;
    return a.numbers.every((v, i) => Math.abs(v - b.numbers[i]) <= TRAJECTORY_NEAR_EPS);
}
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
            s = { lastSig: '', lastNoEffect: false, repeatCount: 0, pendingSig: '', pendingTool: '', recent: [] };
            bySession.set(sessionId, s);
        }
        return s;
    };
    onToolPre(ctx, async (call, next) => {
        // 只管动作类工具；dismiss_popup 是幂等元工具，放行
        if (!ACTION_TOOLS.includes(call.name) || call.name === 'dismiss_popup')
            return next();
        const st = stateFor(call.sessionId ?? '_anon');
        // ── W6R-A9 ② + D-D11：轨迹级滑动窗口检测（参数微调式死循环）──
        // 样本先行入环 —— 即便本次随后被拦也计数（被拦后仍持续微调重试
        // 正是循环意图本身，保持守卫粘性）。窗口含本次调用。近参数计数 =
        // 桶判等 ∪ 叶级真数值距离判等（isNearParam —— 半格悬崖带归案）。
        const sample = leafProfile(call.name, call.args);
        st.recent.push(sample);
        if (st.recent.length > TRAJECTORY_WINDOW)
            st.recent.shift();
        const nearCount = st.recent.filter(s => isNearParam(s, sample)).length;
        if (nearCount >= TRAJECTORY_MAX_REPEATS) {
            return `[Guard Blocked]: Loop detected — '${call.name}' was invoked ${nearCount} times within ` +
                `the last ${TRAJECTORY_WINDOW} actions with near-identical parameters (only micro-adjusted). ` +
                `Micro-tweaking coordinates does not change the outcome. Change strategy materially: 'zoom_inspect' ` +
                `to re-locate the target, 'recall_ui'/'find_text' for a different anchor, 'press_hotkey' (e.g. Esc/Enter) ` +
                `for keyboard navigation, 'scroll_page' if the target may be off-screen, or report the blocker to the user.`;
        }
        // ── ① 原样重试检测（量化签名，W6R-A9 起 0.001 网格）──
        // T 纪元（T-1）：量化相似签名 —— 数值参数四舍五入到网格后铸签。
        // 旧逐字节签名对坐标抖动（0.5001 vs 0.5000）失明 —— 同一按钮的微移重试
        // 不算「重复」，防死循环守卫被抖动绕过。量化后抖动同签（亚毫厘抖动在
        // 物理上远低于屏幕单像素 —— 两次这样的点击本就是同一意图）。
        const sig = quantizedSig(call.name, call.args, SIGNATURE_GRID);
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
