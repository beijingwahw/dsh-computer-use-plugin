// src/federation/digest.ts
// W9-3（D-F4 拆分·摘要分区）：自 federation/index.ts 低风险提取 —— 算法形状
// 常数（摘要 schema/坨数/裁剪域/超时/ε/份额缺省）+ 确定性随机源与 Laplace 噪声
// + Μ-a 铸摘要 / Μ-b 合并摘要。逐字节搬运（零逻辑变更）；index.ts 原位再导出 —
// — 导入面不变（消费方零改动）。
// ΝΩ-20（隐私会计）：摘要铸造不再是无台账的免费动作 —— (a) rdpEpsilon 纯函数
// 给出 Laplace 的 Rényi 发散度（Mironov 公式）；(b) 模块级 privacyBudget 账本按
// 「窗口指纹」逐窗口累计 ε，Σε 超冻结上限 ⇒ mint 拒绝（返回 null，绝不抛）且
// 拒绝事实在账本上如实申报；(c) 每 key 的 n 改 Laplace(1/ε) 加噪取整非负（活动量
// 不再明文出境）；(d) 可选泊松子采样 γ（缺省关 —— 旧行为逐字节）+ 采样放大
// ε_eff = log(1+γ(e^ε−1))。预算未超 ⇒ 铸造结果与旧实现逐字节一致（零回归纪律）。
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
/**
 * ΝΩ-20：隐私预算总上限 —— 每个窗口指纹的累计 ε 不得超过 10（常量冻结）。
 * 语义：同一 200 条滑窗的内容无论被 sync 多少次，朴素序列组合下的纯 DP 损失
 * 上界 Σε ≤ 10 —— sync 任意频率调用不再能无界放大隐私损失（旧行为 k 次 ⇒ ≈k·ε）。
 */
export const PRIVACY_BUDGET_EPSILON_TOTAL = 10;
/** ΝΩ-20：RDP 阶数缺省（冻结 α=10 —— rdpEpsilon 审计口径的固定阶） */
export const RDP_ORDER = 10;
/** ΝΩ-20：预算闸的浮点容差（Σε 与上限比较防 0.1+0.2 型尘埃误判方向） */
const PRIVACY_BUDGET_EPS_TOL = 1e-9;
// ─── 随机源与噪声（纯函数，确定性可测） ───
// ΝΩ-41（方言克隆律）：mulberry32 / fnv1a32 的本地副本退役 —— 流内核与滚动
// 哈希内核改自单源 src/dialects/random.ts 导入；federation 侧种子/累积器消毒
// 卫兵（floor / 非有限回落）在本边界包一层（dialects/random 头注的分工律，
// 与 gym.mulberry32 同式）。种子流与指纹逐字节一致（金样
// test/no41.dialectClones.test.ts），模块无新增依赖、不背自主环。
import { mulberry32 as dialectMulberry32, fnv1aSeeded } from '../dialects/random.js';
/**
 * mulberry32：32 位确定性 PRNG（种子钉死 ⇒ 序列钉死 ⇒ 同 seed 同摘要）。
 * 单源流内核 + federation 种子归一卫兵（有限值 Math.floor / 非有限按 0 记 ——
 * 收口前本地实现逐字节同律）。非有限种子按 0 记。
 */
export function mulberry32(seed) {
    return dialectMulberry32(typeof seed === 'number' && Number.isFinite(seed) ? Math.floor(seed) : 0);
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
/**
 * ΝΩ-20 (a)：Laplace(0, 1/ε) 机制的 α 阶 Rényi 发散度（纯函数、绝不抛）。
 * Mironov《Rényi Differential Privacy and the Posterior Sampling》(CSF'17) 的
 * Laplace 闭式（敏感度 Δ=1、尺度 b=1/ε）：
 *
 *   D_α = (1/(α−1)) · log( (α/(2α−1))·e^{(α−1)·ε} + ((α−1)/(2α−1))·e^{−α·ε} )
 *
 * 消毒律：ε ≤ 0 / 非有限 ⇒ 0（零噪声尺度的机制零发散——ε=0 即完美隐私）；α ≤ 1 /
 * 非有限 ⇒ 冻结缺省阶 RDP_ORDER；数值溢出（大 α·ε）⇒ 回落纯 DP 界 ε —— 这恰是
 * α→∞ 的正确极限（RDP 单调收敛于纯 DP，D_α ≤ ε 恒成立，回落只会更保守不更乐观）。
 * 性质面（测试执法）：D_α ≤ ε、对 ε 单调、对 α 单调（α↑ ⇒ 收敛 ε）。
 */
export function rdpEpsilon(eps, alpha = RDP_ORDER) {
    const e = typeof eps === 'number' && Number.isFinite(eps) && eps > 0 ? eps : 0;
    if (e === 0)
        return 0;
    const a = typeof alpha === 'number' && Number.isFinite(alpha) && alpha > 1 ? alpha : RDP_ORDER;
    const w1 = a / (2 * a - 1);
    const w2 = (a - 1) / (2 * a - 1);
    const d = (Math.log(w1 * Math.exp((a - 1) * e) + w2 * Math.exp(-a * e))) / (a - 1);
    return Number.isFinite(d) ? d : e; // 溢出臂 = α→∞ 极限（纯 DP 界 —— 保守方向）
}
/**
 * ΝΩ-20 (d)：泊松子采样放大（纯函数、绝不抛）。对数据集以速率 γ 做泊松子采样后
 * 再跑 ε-DP 机制，对原数据集满足 ε_eff-DP，标准界（Ullman；pure-DP 机制的子采样
 * 放大）：
 *
 *   ε_eff = log(1 + γ·(e^ε − 1))
 *
 * γ=1（不采样）⇒ ε；γ→0 ⇒ →0（机制几乎看不见任何个体）；γ ∈ (0,1) ⇒ ε_eff < ε
 * （ε=1, γ=0.5 ⇒ ≈0.858；ε 大时省约 log(1/γ) —— γ=0.5 恒省 ≈0.69）。消毒律：
 * ε ≤ 0 / 非有限 ⇒ 0；γ ≥ 1 / 非有限 ⇒ 原样 ε；γ ≤ 0 ⇒ 0；溢出 ⇒ ε（保守方向）。
 * 该函数只在真做了子采样（MintDigestOptions.sampleGamma ∈ (0,1)）时用于记账 ——
 * 不采样却申报放大是不诚实的账。
 */
export function subsampleAmplifiedEpsilon(eps, gamma) {
    const e = typeof eps === 'number' && Number.isFinite(eps) && eps > 0 ? eps : 0;
    if (e === 0)
        return 0;
    const g = typeof gamma === 'number' && Number.isFinite(gamma) ? gamma : 1;
    if (g <= 0)
        return 0;
    if (g >= 1)
        return e;
    const eff = Math.log1p(g * Math.expm1(e));
    return Number.isFinite(eff) ? eff : e; // 溢出臂：回落纯 DP 界（保守方向）
}
/**
 * ΝΩ-20：FNV-1a 32 位滚动哈希（纯函数）—— 窗口指纹（digest 内部）与掺入抖动
 * 种子派生（apply）共用的确定性文本→整数混合器。非有限 h 按 FNV 偏移基记、
 * 非字符串 text 按空串记（消毒卫兵在本边界）；内核为单源 fnv1aSeeded 续算
 * （逐字节同循环 —— 金样钉死）。
 */
export function fnv1a32(h, text) {
    return fnv1aSeeded(typeof h === 'number' && Number.isFinite(h) ? Math.floor(h) : 0x811c9dc5, typeof text === 'string' ? text : '');
}
/** 坨中心（掺入时 margin 的反演值）：裁剪域均分的第 b 坨中点（b=0 ⇒ -0.875） */
export function binCenter(b) {
    return -DIGEST_MARGIN_CLIP + (b + 0.5) * ((2 * DIGEST_MARGIN_CLIP) / DIGEST_BINS);
}
/** 全零坨矩阵（K × [success, fail]）—— 摘要铸造与合并的初始画布 */
export function zeroBins() {
    return Array.from({ length: DIGEST_BINS }, () => [0, 0]);
}
/** 预算账本真值源（指纹 → 账目行 + 最近拒绝注记；模块级，进程生命周期） */
const privacyBudgets = new Map();
/** 账目行求和（执法口径 —— 逐行加 ε_eff；空 ⇒ 0） */
function sumReleases(releases) {
    let s = 0;
    for (const r of releases)
        s += typeof r.epsilon === 'number' && Number.isFinite(r.epsilon) && r.epsilon > 0 ? r.epsilon : 0;
    return s;
}
/** 单账户的派生视图（防御副本 —— 外发结构不含内部可变引用） */
function budgetAccountOf(fingerprint, raw) {
    const total = sumReleases(raw.releases);
    return {
        fingerprint,
        releases: raw.releases.map(r => ({ ts: r.ts, epsilon: r.epsilon })),
        totalEpsilon: total,
        totalRdpEpsilon: raw.releases.reduce((s, r) => s + rdpEpsilon(r.epsilon), 0),
        cap: PRIVACY_BUDGET_EPSILON_TOTAL,
        exhausted: total >= PRIVACY_BUDGET_EPSILON_TOTAL - PRIVACY_BUDGET_EPS_TOL,
        ...(raw.lastRejection ? { lastRejection: { ...raw.lastRejection } } : {}),
    };
}
/** 查询某窗口指纹的预算账户（缺席 ⇒ null —— 诚实面，不臆造空账） */
export function privacyBudgetOf(fingerprint) {
    const raw = privacyBudgets.get(fingerprint);
    return raw ? budgetAccountOf(fingerprint, raw) : null;
}
/** 预算账本全表（dump 面：指纹字典序，防御副本） */
export function privacyBudgetReport() {
    return [...privacyBudgets.entries()]
        .map(([fp, raw]) => budgetAccountOf(fp, raw))
        .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1));
}
/**
 * 预算闸（mint 的内部执法点，绝不抛）：本次 release 记账口径 ε_eff 能否放行。
 * 通过 ⇒ 追加账目行（ts, ε_eff）；超限 ⇒ 落 lastRejection 并返回 false。
 */
function chargePrivacyBudget(fingerprint, ts, epsilonEff) {
    try {
        const cur = privacyBudgets.get(fingerprint) ?? { releases: [] };
        const total = sumReleases(cur.releases);
        if (total + epsilonEff > PRIVACY_BUDGET_EPSILON_TOTAL + PRIVACY_BUDGET_EPS_TOL) {
            cur.lastRejection = {
                ts,
                epsilon: epsilonEff,
                totalEpsilon: total,
                cap: PRIVACY_BUDGET_EPSILON_TOTAL,
                note: 'budget-exhausted：窗口指纹累计 ε 已达上限，mint 拒绝（诚实跳过，绝不抛）',
            };
            privacyBudgets.set(fingerprint, cur);
            return false;
        }
        cur.releases.push({ ts, epsilon: epsilonEff });
        privacyBudgets.set(fingerprint, cur);
        return true;
    }
    catch {
        return true; // 记账故障 ⇒ 放行（预算闸是隐私旁路义务，不反噬铸造主路 —— 宁可多放不可炸宿主）
    }
}
/** ΝΩ-20：预算账本复位（测试隔离专用缝 —— 生产代码无理由清空会计不变量） */
export function resetPrivacyBudgetRuntime() {
    privacyBudgets.clear();
}
/**
 * 铸摘要（绝不抛）：对每 key 的窗口证据产出「margin 裁剪进 [-1,1] 的 K=8 坨 ×
 * 成败两列」直方图，每格加 Laplace(0, 1/ε) 噪声后取整非负；n 亦加同尺度噪声取整
 * 非负（ΝΩ-20 (c) —— 活动量不再明文出境）。同 seed 同账本 ⇒ 摘要逐字段一致
 * （mulberry32 流 + 固定格序：key 序、逐条目子采样币、n 噪声、坨 0..7、success
 * 先于 fail）。无 margin 的条目计入 n、不入格（直方图只覆盖带裕量的证据 —— 与
 * calibrator 只消费 margins 的口径对齐）；账本视图非法 ⇒ null（诚实跳过，
 * 绝不抛）。rng 异常产出非有限噪声 ⇒ 该格按 0（宁缺毋假，绝不回退真值 —— DP
 * 的失败方向只能是多掩蔽、不能是少掩蔽）。
 *
 * ΝΩ-20 (b) 隐私预算闸：铸造按窗口指纹记账 —— 全程零有效条目（输出与任何个体
 * 无关的纯噪声）⇒ 零成本；否则按 ε_eff（采样放大后）对照 Σε ≤ 上限执法，超限 ⇒
 * 返回 null 且拒绝事件落在 privacyBudget 账本（lastRejection 如实申报
 * budget-exhausted —— null 的区分面在账本不在返回值）。预算未超 ⇒ 返回值与旧
 * 实现逐字节一致（零回归纪律）；预算是会计不变量 —— 同窗口反复 mint 会真实扣减。
 */
export function mintEvidenceDigest(ledgerView, opts) {
    try {
        if (!ledgerView || typeof ledgerView.keys !== 'function' || typeof ledgerView.entries !== 'function') {
            return null; // 账本视图非法：诚实跳过（零摘要，不是坏摘要）
        }
        const epsilon = numOr(opts?.epsilon, DEFAULT_FEDERATION_EPSILON, Number.MIN_VALUE, Infinity);
        const scale = 1 / epsilon; // 计数敏感度 1 ⇒ Laplace 尺度 1/ε（Dwork 机制）
        // ΝΩ-20 (d)：泊松子采样率 γ（缺省/非法 ⇒ 1 = 不采样 —— 旧行为逐字节）
        const gammaRaw = opts?.sampleGamma;
        const gamma = typeof gammaRaw === 'number' && Number.isFinite(gammaRaw) && gammaRaw > 0 && gammaRaw < 1 ? gammaRaw : 1;
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
        let fp = 0x811c9dc5; // ΝΩ-20：窗口指纹累积器（FNV-1a 偏移基）
        let totalN = 0; // ΝΩ-20：全程有效条目数（零 ⇒ 纯噪声输出 ⇒ 零记账）
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
            fp = fnv1a32(fp, `\u0000${rawKey}\u0000`);
            const bins = zeroBins();
            let n = 0;
            for (const e of entries) {
                if (!e || typeof e.success !== 'boolean')
                    continue; // 注入视图的垃圾条目：n 与格子都不收
                // ΝΩ-20：指纹滚入**子采样前**的全量有效条目（窗口身份 = 影响输出的条目集，
                // 子采样是逐 release 的随机视图不是窗口本身）
                fp = fnv1a32(fp, `${e.success ? 's' : 'f'}:${e.margin === undefined || !Number.isFinite(e.margin) ? '' : String(e.margin)};`);
                if (gamma < 1 && !(rng() < gamma))
                    continue; // ΝΩ-20 (d)：泊松子采样（γ=1 时此臂短路 —— 旧行为零消耗 rng）
                n += 1;
                if (e.margin === undefined || !Number.isFinite(e.margin))
                    continue; // 无裕量：只计 n
                const m = Math.min(DIGEST_MARGIN_CLIP, Math.max(-DIGEST_MARGIN_CLIP, e.margin));
                const idx = Math.min(DIGEST_BINS - 1, Math.floor((m + DIGEST_MARGIN_CLIP) / ((2 * DIGEST_MARGIN_CLIP) / DIGEST_BINS)));
                bins[idx][e.success ? 0 : 1] += 1;
            }
            totalN += n;
            // ΝΩ-20 (c)：n 加噪（Laplace(1/ε) 取整非负；rng 异常 ⇒ 0 —— 多掩蔽方向，
            // 绝不回退真值）
            const rawNoisyN = Math.round(n + laplaceNoise(scale, rng()));
            const noisyN = Number.isFinite(rawNoisyN) ? Math.max(0, rawNoisyN) : 0;
            const noisyBins = bins.map(cell => cell.map(c => {
                const v = Math.round(c + laplaceNoise(scale, rng()));
                return Number.isFinite(v) ? Math.max(0, v) : 0; // 后处理：取整非负；rng 异常 ⇒ 0（多掩蔽方向）
            }));
            outKeys.push({ key: rawKey, n: noisyN, bins: noisyBins });
        }
        // ΝΩ-20 (b)：隐私预算闸（零有效条目 ⇒ 纯噪声输出 ⇒ 零成本不记账）
        if (totalN > 0) {
            const epsEff = gamma < 1 ? subsampleAmplifiedEpsilon(epsilon, gamma) : epsilon;
            const fingerprint = `w${fp.toString(16).padStart(8, '0')}`;
            if (!chargePrivacyBudget(fingerprint, mintedAt, epsEff)) {
                return null; // budget-exhausted：诚实拒绝（拒绝详情在 privacyBudgetOf(fingerprint)）
            }
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
