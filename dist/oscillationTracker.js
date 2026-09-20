// src/oscillationTracker.ts
// 第六轮创新之三：振荡检测（零成本环形缓冲）。
// E-3 循环谱升级（第五维·信息热力学）：从「同一指纹出现 ≥3 次」（周期 1 的特例）
// 升级为任意周期 p ∈ {1..4} 的循环检测 —— A→B→A→B 双态振荡（旧版完全看不见：
// 每个指纹只出现两次，永远够不到旧阈值）如今在第三个完整周期块即告警。
//
// 数学形态：指纹序列的自相关峰检测的离散版 —— autocorr(p) 在精确匹配语义下
// 取满秩（尾部 3p 帧折叠为 p 个残差类且类内逐帧相等 ⇒ ≥3 个完整周期块）。
// 判据确定性、零随机：p 从小到大探测，首中即报（p=1 语义 = 旧版行为回归）。
//
// 诚实边界：精确匹配语义 —— 中途插入一帧噪声即断尾（对噪声不鲁棒）；
// 量化指纹（如 4 位格雷码桶）上的模糊循环检测是留白，值即边界。
const RING_SIZE = 12; // 3 × 最大周期 4：容纳三份完整周期块的观测窗
const MAX_PERIOD = 4;
const ring = [];
/** 尾部 3p 帧是否构成 p-周期循环（残差类内全等 ⇒ 自相关满秩） */
function isPCycle(w, p) {
    if (w.length < 3 * p)
        return false;
    const tail = w.slice(w.length - 3 * p);
    for (let i = 0; i + p < tail.length; i++) {
        if (tail[i] !== tail[i + p])
            return false;
    }
    return true;
}
export const oscillationTracker = {
    /** 记录一次稳定帧指纹，返回振荡告警（或 null）。非阻塞、不抛错。 */
    observe(hash) {
        ring.push(hash);
        if (ring.length > RING_SIZE)
            ring.shift();
        for (let p = 1; p <= MAX_PERIOD; p++) {
            if (!isPCycle(ring, p))
                continue;
            const shape = p === 1
                ? 'same state repeating ≥3 times'
                : `${p}-state cycle (A→B→${p === 2 ? 'A' : '…'}→A loop, 3 full periods)`;
            // 告警后清环：下次检测基于全新窗口，避免同一停滞反复刷屏
            ring.length = 0;
            return `OSCILLATION DETECTED (${shape}): the screen keeps cycling back through ` +
                `${p === 1 ? 'the same state' : `${p} states`} across recent actions. ` +
                'You are likely stuck in a loop. STEP BACK: re-read the task goal, take a fresh take_screenshot, ' +
                'consider a different route (keyboard navigation, another tab/window), or ask the user for guidance.';
        }
        return null;
    },
    reset() {
        ring.length = 0;
    },
};
