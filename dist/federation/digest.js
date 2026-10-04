// src/federation/digest.ts
// W9-3（D-F4 拆分·摘要分区）：自 federation/index.ts 低风险提取 —— 算法形状
// 常数（摘要 schema/坨数/裁剪域/超时/ε/份额缺省）+ 确定性随机源与 Laplace 噪声
// + Μ-a 铸摘要 / Μ-b 合并摘要。逐字节搬运（零逻辑变更）；index.ts 原位再导出 —
// — 导入面不变（消费方零改动）。
// ─── 常量（算法形状字面量 —— 非旋钮） ───
/** 摘要 schema 版本：mergeDigests 见到任一输入版本不符 ⇒ 整体拒绝合并返回 null */
export const DIGEST_VERSION = 1;
/** 每 key 的 margin 坨数 K=8（裁剪域均分，坨宽 0.25） */
export const DIGEST_BINS = 8;
/**
 * margin 裁剪域 [-1, +1]。账本真实域读码定：registry 的 margin 是任意有限值
 * （相似度 / 汉明距离 / 置信差等，器官各异且无全局界）—— 联邦摘要取对称单位域
 * 裁剪：域内无损，域外夹到边界（分布尾被保守收拢，坨坐标仍可反演）。
 */
export const DIGEST_MARGIN_CLIP = 1;
/** 联邦单次 POST 超时（swarm.fireUpload 同律 5s —— 遥测是旁路义务不是主路债主） */
export const FEDERATION_TIMEOUT_MS = 5_000;
/** 差分隐私 ε 缺省（config.federationEpsilon 同缺省 1 —— 与 H-5 群体结晶一致） */
export const DEFAULT_FEDERATION_EPSILON = 1;
/** 远端份额上限缺省（config.federationMaxRemoteShare 同缺省 0.5 —— 至多对半掺入） */
export const DEFAULT_MAX_REMOTE_SHARE = 0.5;
// ─── 随机源与噪声（纯函数，确定性可测） ───
/**
 * mulberry32：32 位确定性 PRNG（种子钉死 ⇒ 序列钉死 ⇒ 同 seed 同摘要）。
 * 与 src/autonomy/gym.ts 同算法的零依赖本地实现 —— 不跨器官 import，
 * 联邦模块不背自主环的依赖图。非有限种子按 0 记。
 */
export function mulberry32(seed) {
    let a = (typeof seed === 'number' && Number.isFinite(seed) ? Math.floor(seed) : 0) >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/**
 * Laplace(0, scale) 噪声（纯函数，绝不抛）：swarm.buildPacket 同式的逆 CDF 采样
 * —— u ∈ [0,1) 经 -scale·sign(u-½)·ln(1-2|u-½|+1e-12) 映射（1e-12 是 u 触界时
 * log(0) 的护栏）。消毒律：scale 非有限或 ≤ 0 ⇒ 0（无噪声）；u 非有限 ⇒ 取 0.5
 * （sign(0)=0 ⇒ 噪声 0 —— 确定性降级点）；u 夹回 [0, 1-1e-12] 防域外输入炸 log。
 * 对称性是测试面：u 与 1-u 关于 0.5 对称 ⇒ 噪声严格反号。
 */
export function laplaceNoise(scale, uniform) {
    if (!Number.isFinite(scale) || scale <= 0)
        return 0;
    const u = Number.isFinite(uniform) ? Math.min(Math.max(uniform, 0), 1 - 1e-12) : 0.5;
    return -scale * Math.sign(u - 0.5) * Math.log(1 - 2 * Math.abs(u - 0.5) + 1e-12);
}
/** 数值护栏：x 非有限或越界 ⇒ 缺省（calibrator.numOr 同律，绝不抛） */
export function numOr(x, dflt, min, max) {
    return typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max ? x : dflt;
}
/** 坨中心（掺入时 margin 的反演值）：裁剪域均分的第 b 坨中点（b=0 ⇒ -0.875） */
export function binCenter(b) {
    return -DIGEST_MARGIN_CLIP + (b + 0.5) * ((2 * DIGEST_MARGIN_CLIP) / DIGEST_BINS);
}
/** 全零坨矩阵（K × [success, fail]）—— 摘要铸造与合并的初始画布 */
export function zeroBins() {
    return Array.from({ length: DIGEST_BINS }, () => [0, 0]);
}
/**
 * 铸摘要（纯函数、绝不抛）：对每 key 的窗口证据产出「margin 裁剪进 [-1,1] 的
 * K=8 坨 × 成败两列」直方图，每格加 Laplace(0, 1/ε) 噪声后取整非负，附每 key
 * 的真值 n。同 seed 同账本 ⇒ 摘要逐字段一致（mulberry32 流 + 固定格序：key 序、
 * 坨 0..7、success 先于 fail）。无 margin 的条目计入 n、不入格（直方图只覆盖
 * 带裕量的证据 —— 与 calibrator 只消费 margins 的口径对齐）；账本视图非法 ⇒
 * null（诚实跳过，绝不抛）。rng 异常产出非有限噪声 ⇒ 该格按 0（宁缺毋假，
 * 绝不回退真值 —— DP 的失败方向只能是多掩蔽、不能是少掩蔽）。
 */
export function mintEvidenceDigest(ledgerView, opts) {
    try {
        if (!ledgerView || typeof ledgerView.keys !== 'function' || typeof ledgerView.entries !== 'function') {
            return null; // 账本视图非法：诚实跳过（零摘要，不是坏摘要）
        }
        const epsilon = numOr(opts?.epsilon, DEFAULT_FEDERATION_EPSILON, Number.MIN_VALUE, Infinity);
        const scale = 1 / epsilon; // 计数敏感度 1 ⇒ Laplace 尺度 1/ε（Dwork 机制）
        const rng = typeof opts?.rng === 'function'
            ? opts.rng
            : mulberry32(typeof opts?.seed === 'number' && Number.isFinite(opts.seed) ? opts.seed : 0);
        let mintedAt = Date.now();
        if (typeof opts?.now === 'function') {
            try {
                const t = opts.now();
                if (Number.isFinite(t))
                    mintedAt = t;
            }
            catch {
                /* 时钟故障保持 Date.now —— 绝不抛 */
            }
        }
        let keyList = [];
        try {
            keyList = ledgerView.keys() ?? [];
        }
        catch {
            keyList = [];
        }
        const outKeys = [];
        for (const rawKey of keyList) {
            if (typeof rawKey !== 'string' || rawKey === '')
                continue; // 垃圾 key 不入摘要
            let entries = [];
            try {
                entries = ledgerView.entries(rawKey) ?? [];
            }
            catch {
                entries = []; // 单 key 读账故障：按空窗铸（其余 key 不受牵连）
            }
            const bins = zeroBins();
            let n = 0;
            for (const e of entries) {
                if (!e || typeof e.success !== 'boolean')
                    continue; // 注入视图的垃圾条目：n 与格子都不收
                n += 1;
                if (e.margin === undefined || !Number.isFinite(e.margin))
                    continue; // 无裕量：只计 n
                const m = Math.min(DIGEST_MARGIN_CLIP, Math.max(-DIGEST_MARGIN_CLIP, e.margin));
                const idx = Math.min(DIGEST_BINS - 1, Math.floor((m + DIGEST_MARGIN_CLIP) / ((2 * DIGEST_MARGIN_CLIP) / DIGEST_BINS)));
                bins[idx][e.success ? 0 : 1] += 1;
            }
            const noisyBins = bins.map(cell => cell.map(c => {
                const v = Math.round(c + laplaceNoise(scale, rng()));
                return Number.isFinite(v) ? Math.max(0, v) : 0; // 后处理：取整非负；rng 异常 ⇒ 0（多掩蔽方向）
            }));
            outKeys.push({ key: rawKey, n, bins: noisyBins });
        }
        return { v: DIGEST_VERSION, mintedAt, epsilon, keys: outKeys };
    }
    catch {
        return null; // 绝不抛纪律的兜底臂（理论不可达 —— 全程防御式）
    }
}
/** 单格消毒：有限、非负的数值 ⇒ 四舍五入整数；其余（NaN/±Inf/负数/非数）⇒ null（按 0 计） */
export function cleanCell(v) {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}
/**
 * 合并摘要（secure-aggregation 风格、纯函数、绝不抛）：逐格求和 + n 求和。
 *   - 非数组 / 空数组 ⇒ null（无可合并者）；
 *   - 任一份形状坏（非对象）或版本 ≠ 1 ⇒ **整体拒绝合并返回 null**（schema 演进
 *     不静默吞异版 —— 版本错配是协议事件，不是数据噪声）；
 *   - 坏格按 0 计入并 skipped++（NaN / 非数 / 负数 / bins 形状错 —— 聚合器不因
 *     单格脏数据丢弃整份贡献，也不假装它是合法值）；
 *   - mintedAt 取各源最大；epsilon 取各源最小（最保守申报 —— 各源只对自己的 ε
 *     负责，合并面按最强噪声标准立账）。
 */
export function mergeDigests(digests) {
    try {
        if (!Array.isArray(digests) || digests.length === 0)
            return null;
        let mintedAt = 0;
        let minEps = null;
        let skipped = 0;
        const keyMap = new Map();
        for (const d of digests) {
            if (!d || typeof d !== 'object' || Array.isArray(d))
                return null; // 形状坏：整体拒绝
            const dd = d;
            if (dd.v !== DIGEST_VERSION)
                return null; // 版本错配：整体拒绝合并
            if (typeof dd.mintedAt === 'number' && Number.isFinite(dd.mintedAt) && dd.mintedAt > mintedAt) {
                mintedAt = dd.mintedAt;
            }
            if (typeof dd.epsilon === 'number' && Number.isFinite(dd.epsilon) && dd.epsilon > 0) {
                minEps = minEps === null ? dd.epsilon : Math.min(minEps, dd.epsilon);
            }
            for (const rawEntry of Array.isArray(dd.keys) ? dd.keys : []) {
                if (!rawEntry || typeof rawEntry !== 'object') {
                    skipped += DIGEST_BINS * 2; // 整条坏：按全格坏注记（粒度统一为格）
                    continue;
                }
                const e = rawEntry;
                if (typeof e.key !== 'string' || e.key === '') {
                    skipped += DIGEST_BINS * 2; // 无主条目：同上按全格坏注记
                    continue;
                }
                let acc = keyMap.get(e.key);
                if (!acc) {
                    acc = { n: 0, bins: zeroBins() };
                    keyMap.set(e.key, acc);
                }
                const cleanN = cleanCell(e.n);
                if (cleanN !== null)
                    acc.n += cleanN;
                else
                    skipped += 1; // 坏 n 按 0 计入注记
                const bins = Array.isArray(e.bins) ? e.bins : [];
                for (let b = 0; b < DIGEST_BINS; b++) {
                    const cell = bins[b];
                    for (let col = 0; col < 2; col++) {
                        const v = cleanCell(Array.isArray(cell) ? cell[col] : undefined);
                        if (v !== null)
                            acc.bins[b][col] += v;
                        else
                            skipped += 1; // 坏格按 0（诚实注记，不吞整份）
                    }
                }
            }
        }
        return {
            v: DIGEST_VERSION,
            mintedAt,
            epsilon: minEps ?? DEFAULT_FEDERATION_EPSILON,
            keys: [...keyMap.entries()].map(([key, acc]) => ({ key, n: acc.n, bins: acc.bins })),
            mergedFrom: digests.length,
            skipped,
        };
    }
    catch {
        return null; // 绝不抛
    }
}
