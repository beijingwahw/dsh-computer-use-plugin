// src/oscillationTracker.ts
// 第六轮创新之三：振荡检测（零成本环形缓冲）。
// 失败模式的隐蔽形态：动作都「成功」（画面有变化），但屏幕状态反复回到旧值 ——
// A→B→A→B 循环。连续失败计数器抓不住它（没有 [Error]），Token 却在稳定燃烧。
// 实现：验证管线里已经捕获的稳定帧指纹顺手入环（零额外截图），同指纹在窗口内
// 出现 ≥3 次 ⇒ 判定振荡，注入「退后一步」指引。
const RING_SIZE = 8;
const REPEAT_THRESHOLD = 3;
const ring = [];
export const oscillationTracker = {
    /** 记录一次稳定帧指纹，返回振荡告警（或 null）。非阻塞、不抛错。 */
    observe(hash) {
        ring.push(hash);
        if (ring.length > RING_SIZE)
            ring.shift();
        const count = ring.filter(h => h === hash).length;
        if (count < REPEAT_THRESHOLD)
            return null;
        // 告警后清环：下次检测基于全新窗口，避免同一停滞反复刷屏
        ring.length = 0;
        return 'OSCILLATION DETECTED: the screen keeps returning to this exact state across recent actions. ' +
            'You are likely stuck in a loop. STEP BACK: re-read the task goal, take a fresh take_screenshot, ' +
            'consider a different route (keyboard navigation, another tab/window), or ask the user for guidance.';
    },
    reset() {
        ring.length = 0;
    },
};
