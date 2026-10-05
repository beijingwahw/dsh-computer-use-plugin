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
// K 纪元（留白兑现之七）：噪声容忍循环检测 —— 从精确匹配升级为**汉明容差**
// 匹配（dHash 抖动 ≤ FUZZ_TOL 位视为"同一场景"；精确匹配即容差 0 的特例）。
// 动机（原诚实边界）：中途一帧噪声（光标闪烁/轻微动画）即断尾 —— 检测器对
// 真实 UI 的微小变化过度敏感。容差取 6/64 位：远小于场景切换（≥24 位），
// 足以吸收采集噪声 —— 阈值与 subconsciousMatchDistance（既视感）同律。
import { kernelRegistry } from './kernel/registry.js';
//
// 纪元 Ξ（Ξ-D 生产接线）：三常量读内核注册表 —— osc.ringSize（缺省 12）/
// osc.maxPeriod（缺省 4，区间 1..6）/ osc.fuzzTol（缺省 6，区间 0..12）。
// 未注册 ⇒ getOrDefault 回声字面量，行为逐字节不变。
// 结构序守护：观测窗必须容得下 3×maxPeriod 帧（尾部 3p 帧的自相关检验是
// 检测的数学前提）—— 读点处 ringSize = Math.max(3*maxPeriod, round(值))，
// 越序值就地抬到结构下限（夹序不是拒绝，与 registry 夹值同律）。
const RING_SIZE = 12; // 3 × 最大周期 4：容纳三份完整周期块的观测窗
const MAX_PERIOD = 4;
const FUZZ_TOL = 6; // 64 位指纹的容差位（同律阈值：既视感 6 / 场景切换 ≥24）
// ─── ΠΑΝ-123：键域 LRU + 上界（有界化立法） ───
//
// 病灶（C1-2 L7）：单一模块级环跨任务/跨场景共用 —— 任务 A 的尾部观测混入
// 任务 B 的首批帧，跨任务指纹错配可假报振荡（或延迟告警）。修法：观测环
// **键域化**（key = 任务/代理/屏面归属，缺省 '' = 旧行为逐字节兼容），
// 键集合本身有界：LRU 逐出（Map 插入序 + 命中重插刷新 —— 真 LRU，非 FIFO）
// + 键数上界 MAX_RINGS。内存上界 = MAX_RINGS × ringSize 条指纹字符串
// （8 × 12 × 64 字符 —— 常量级，无增长面）。告警只清所属键的环（跨键
// 隔离）；reset(key?) 定点清或全清（插件卸载走全清 —— index.ts 既有接线
// 语义不变）。
const MAX_RINGS = 8; // ΠΑΝ-123：键域上界（并发任务/代理/屏面的现实容量）
const rings = new Map();
/** 逐位汉明距离（等长二进制指纹；长度不等 ⇒ 最大距离，绝不假装可比） */
function hamming(a, b) {
    if (a.length !== b.length)
        return Math.max(a.length, b.length);
    let d = 0;
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i])
            d++;
    return d;
}
/** 尾部 3p 帧是否构成 p-周期循环（残差类内逐对距离 ≤ 容差 ⇒ 模糊自相关满秩） */
function isPCycle(w, p, fuzzTol) {
    if (w.length < 3 * p)
        return false;
    const tail = w.slice(w.length - 3 * p);
    for (let i = 0; i + p < tail.length; i++) {
        if (hamming(tail[i], tail[i + p]) > fuzzTol)
            return false;
    }
    return true;
}
export const oscillationTracker = {
    /**
     * 记录一次稳定帧指纹，返回振荡告警（或 null）。非阻塞、不抛错。
     * ΠΑΝ-123：可选 key（任务/代理/屏面归属）—— 同键同环，跨键隔离；
     * 缺省 '' = 旧行为（单环语义逐字节兼容）。键域 LRU + MAX_RINGS 上界见上注。
     */
    observe(hash, key = '') {
        // Ξ-D：三键每次 observe 单次读取（set 即时生效）；ringSize 结构序兜底见上注
        const maxPeriod = Math.round(kernelRegistry.getOrDefault('osc.maxPeriod', MAX_PERIOD));
        const fuzzTol = kernelRegistry.getOrDefault('osc.fuzzTol', FUZZ_TOL);
        const ringSize = Math.max(3 * maxPeriod, Math.round(kernelRegistry.getOrDefault('osc.ringSize', RING_SIZE)));
        const ring = ringFor(key);
        ring.push(hash);
        if (ring.length > ringSize)
            ring.shift();
        for (let p = 1; p <= maxPeriod; p++) {
            if (!isPCycle(ring, p, fuzzTol))
                continue;
            const shape = p === 1
                ? 'same state repeating ≥3 times'
                : `${p}-state cycle (A→B→${p === 2 ? 'A' : '…'}→A loop, 3 full periods)`;
            // 告警后清环：下次检测基于全新窗口，避免同一停滞反复刷屏
            // ΠΑΝ-123：只清本键的环（跨键不串扰）
            ring.length = 0;
            return `OSCILLATION DETECTED (${shape}): the screen keeps cycling back through ` +
                `${p === 1 ? 'the same state' : `${p} states`} across recent actions. ` +
                'You are likely stuck in a loop. STEP BACK: re-read the task goal, take a fresh take_screenshot, ' +
                'consider a different route (keyboard navigation, another tab/window), or ask the user for guidance.';
        }
        return null;
    },
    /** ΠΑΝ-123：在册键数（上界执法的可观测面 —— 恒 ≤ MAX_RINGS） */
    ringCount() { return rings.size; },
    /**
     * 生命周期归零。ΠΑΝ-123：带 key ⇒ 定点清该键；缺省全清（插件卸载/
     * 测试隔离的既有语义不变）。
     */
    reset(key) {
        if (key === undefined) {
            rings.clear();
            return;
        }
        rings.delete(key);
    },
};
/** ΠΑΝ-123：键 → 观测环（LRU：命中刷新位序；新键入册前逐出最久未用键） */
function ringFor(key) {
    const existing = rings.get(key);
    if (existing) {
        rings.delete(key);
        rings.set(key, existing); // 位序刷新（Map 尾部 = 最近使用）
        return existing;
    }
    while (rings.size >= MAX_RINGS) {
        const oldest = rings.keys().next().value; // Map 首键 = 最久未用
        if (oldest === undefined)
            break;
        rings.delete(oldest);
    }
    const fresh = [];
    rings.set(key, fresh);
    return fresh;
}
