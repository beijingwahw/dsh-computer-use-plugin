// src/federation/index.ts
// 纪元 Μ（万脑联邦进化）：认知器官参数证据的差分隐私联邦。万脑各自把
// EvidenceLedger 的滑窗证据铸成「裁剪直方图 + Laplace 噪声」摘要，聚合侧逐格
// 求和（secure-aggregation 风格），本地按「远端份额上限 × 信任权重」把合并摘要
// 掺回自己的证据账本 —— 一机学习，万机受益，且隐私与主权双边界都划得清清楚楚。
//
// 制度先例（本器官一字不违）：
//   · 差分隐私照 src/swarm.ts 的 H-5（buildPacket 的 Laplace 逆 CDF 采样、
//     ε 缺省 1 与群体经验结晶同律）—— 隐私边界只划在上传面：本地账本恒保持
//     真值，联邦是增益不是依赖；单条证据的增删恰动一格 ⇒ 计数敏感度 1 ⇒
//     每格加 Laplace(0, 1/ε) 噪声即 Dwork 机制的逐格实现；
//   · 网络纪律照 swarm.fireUpload：endpoint 空 = 零网络行为（缺省即离线全功能，
//     摘要/合并/掺入手递手可用）、单次不重试、AbortSignal.timeout(5s)、
//     fire-and-forget、错误消毒（绝不泄摘要外的信息 —— endpoint 原文可能带
//     凭据，错误注记一律替换脱敏）；
//   · 「绝不直接写 kernelRegistry 值」是本器官的安全设计核心：远端证据只喂
//     EvidenceLedger（经既有 record API，成败由坨坐标反演、margin 取坨中心），
//     参数值的一切变化仍由本地 KernelCalibrator 的证据门（n ≥ 30）+ 回归守卫 +
//     optimalThreshold 全链执法 —— 联邦没有任何直达参数值的写径；远端洪泛或
//     投毒最多污染证据水位，过不了本地数学执法（掺入还有份额上限与信任折减
//     两道闸，见 applyFederatedEvidence）。
// 运行层永不抛异常（联邦是纯增益旁路：失败 = 诚实跳过/降级，绝不炸宿主）。
// 信任账纯内存（不落盘；dump 面 = federationTrustReport，restore 缝留待需要时
// 再开 —— 本纪元只立账不持久化）。全模块随机源/时钟/网络/账本皆可注入，
// resetFederationRuntime 供测试隔离。
import { evidenceLedger } from '../kernel/registry.js';
import { robustMergeDigests, applyQuarantineToTrust } from './aggregate.js';
// ─── 纪元 Μ2 纯增量：拜占庭鲁棒聚合面再分发 ───
// aggregate.ts 是零运行时依赖本模块的纯函数核心（类型面经 import type 借用，编译期
// 擦除）—— 逐格中位数/均值/直通聚合 + 离群检疫（票折算 regressed 喂信任账）+ 贡献
// 份额帽。此处只做面分发与 federationSync 的 robust 臂接线；缺省（robust 缺席）走
// Μ 旧行为逐字节不变（纯增量纪律）。
export { robustMergeDigests, applyQuarantineToTrust, contributionCap, OUTLIER_FLOOR, OUTLIER_IQR_SCALE, QUARANTINE_VOTES_PER_REGRESSED, DEFAULT_CONTRIBUTION_CAP_SHARE, } from './aggregate.js';
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
function numOr(x, dflt, min, max) {
    return typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max ? x : dflt;
}
/** 坨中心（掺入时 margin 的反演值）：裁剪域均分的第 b 坨中点（b=0 ⇒ -0.875） */
function binCenter(b) {
    return -DIGEST_MARGIN_CLIP + (b + 0.5) * ((2 * DIGEST_MARGIN_CLIP) / DIGEST_BINS);
}
/** 全零坨矩阵（K × [success, fail]）—— 摘要铸造与合并的初始画布 */
function zeroBins() {
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
function cleanCell(v) {
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
/** 信任账本体（模块级内存 Map —— 进程生命周期；dump 面 = federationTrustReport） */
const trustAccounts = new Map();
/**
 * 记信任账（绝不抛）：sourceId 非空字符串才立账；applied / regressed 非有限按 0、
 * 负数按 0、取整（计数语义）。消费语义：applyFederatedEvidence 成功掺入时自动记
 * applied；远端证据引发本地校准回归时由守卫方记 regressed（本模块不判回归 ——
 * 回归是本地 calibrator/lineage 的执法事实，信任账只记账不执法）。
 */
export function recordFederationTrust(sourceId, delta = {}) {
    try {
        if (typeof sourceId !== 'string' || sourceId === '')
            return; // 匿名摘要无源不立账
        const cur = trustAccounts.get(sourceId) ?? { applied: 0, regressed: 0 };
        const a = typeof delta.applied === 'number' && Number.isFinite(delta.applied) ? Math.max(0, Math.floor(delta.applied)) : 0;
        const r = typeof delta.regressed === 'number' && Number.isFinite(delta.regressed) ? Math.max(0, Math.floor(delta.regressed)) : 0;
        trustAccounts.set(sourceId, { applied: cur.applied + a, regressed: cur.regressed + r });
    }
    catch {
        /* 绝不抛 */
    }
}
/** 现行信任度：1/(1+regressed)；未立账（初见）或垃圾 id ⇒ 1（初见全信，回归才折减） */
export function federationTrustOf(sourceId) {
    if (typeof sourceId !== 'string' || sourceId === '')
        return 1;
    const cur = trustAccounts.get(sourceId);
    if (!cur || cur.regressed <= 0)
        return 1;
    return 1 / (1 + cur.regressed);
}
/** 信任账全表（dump 面，防御副本，sourceId 字典序 —— restore 缝留待需要时再开） */
export function federationTrustReport() {
    return [...trustAccounts.entries()]
        .map(([sourceId, t]) => ({ sourceId, applied: t.applied, regressed: t.regressed, trust: federationTrustOf(sourceId) }))
        .sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1));
}
/**
 * 整数配额按坨质量成比例分配（最大余数法，纯函数、确定性）：quota 条按 16 格的
 * 质量占比分摊，整数化余数按「小数部分大者优先、平票按格序（坨↑、success 先于
 * fail）」逐格补 1 —— 掺入样本保形于远端分布，不因取整偏聚某坨。
 */
function allocateQuota(quota, cells) {
    const total = cells.reduce((s, c) => s + c, 0);
    if (total <= 0)
        return cells.map(() => 0);
    const exact = cells.map(c => (quota * c) / total);
    const base = exact.map(v => Math.floor(v));
    let left = quota - base.reduce((s, v) => s + v, 0);
    const order = exact
        .map((v, i) => ({ i, frac: v - Math.floor(v) }))
        .sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (const o of order) {
        if (left <= 0)
            break;
        base[o.i] += 1;
        left -= 1;
    }
    return base;
}
/**
 * 掺入合并摘要（绝不抛、绝不写 kernelRegistry 值）：
 *
 *   安全设计（本器官的立法核心）：远端证据只经 ledger.record 喂进证据账本 ——
 *   成败由坨坐标反演（success 列 ⇒ true）、margin 取坨中心；参数**值**的一切
 *   变化仍由本地 KernelCalibrator 的证据门（n ≥ 30）+ 回归守卫 + optimalThreshold
 *   全链执法。联邦没有任何直达 kernelRegistry.set 的写径。
 *
 *   逐 key 配额决算（三道闸，缺一不掺）：
 *   ① 本地零证据的 key 不掺 —— 本地没见过的参数不引入外源漂移（诚实注记）；
 *   ② 份额上限：cap = floor(maxRemoteShare × 本地 n)，防远端洪泛主导本地校准；
 *   ③ 信任折减：quota = floor(cap × trust)，trust ∈ (0,1]（信任账 1/(1+regressed)）。
 *
 *   输入摘要版本不符 / 形状坏 ⇒ { ok:false }（诚实拒绝）；目标账本故障 ⇒ 单 key
 *   隔离跳过；掺入记录共享同一 ts（注入时钟 ⇒ 确定性可测）。滑窗 200 FIFO：掺入
 *   挤占最旧的本地证据（内存有界纪律由账本既有契约执法）。
 */
export function applyFederatedEvidence(target, merged, opts) {
    const reject = (note) => ({
        ok: false,
        applied: 0,
        trust: 1,
        perKey: [],
        notes: [note],
    });
    try {
        if (!target || typeof target.record !== 'function' || typeof target.stats !== 'function') {
            return reject('掺入目标账本非法：诚实跳过（绝不炸宿主）');
        }
        if (!merged || typeof merged !== 'object' || Array.isArray(merged)) {
            return reject('合并摘要形状非法：拒绝掺入');
        }
        const mm = merged;
        if (mm.v !== DIGEST_VERSION) {
            return reject(`摘要版本不符（期望 v=${DIGEST_VERSION}）：拒绝掺入`);
        }
        if (!Array.isArray(mm.keys)) {
            return reject('摘要 keys 非数组：拒绝掺入');
        }
        const share = numOr(opts?.maxRemoteShare, DEFAULT_MAX_REMOTE_SHARE, 0, 1);
        // 信任解析：显式 trust 优先（消毒到 (0,1]）；否则查 sourceId 信任账；再否则 1（初见全信）
        let trust = 1;
        if (typeof opts?.trust === 'number' && Number.isFinite(opts.trust) && opts.trust > 0) {
            trust = Math.min(1, opts.trust);
        }
        else if (typeof opts?.sourceId === 'string' && opts.sourceId !== '') {
            trust = federationTrustOf(opts.sourceId);
        }
        let nowMs = Date.now();
        if (typeof opts?.now === 'function') {
            try {
                const t = opts.now();
                if (Number.isFinite(t))
                    nowMs = t;
            }
            catch {
                /* 时钟故障保持 Date.now */
            }
        }
        const notes = [];
        const perKey = [];
        let applied = 0;
        for (const raw of mm.keys) {
            if (!raw || typeof raw !== 'object' || typeof raw.key !== 'string' ||
                raw.key === '') {
                notes.push('（无名 key 条目）：形状坏，跳过');
                continue;
            }
            const entry = raw;
            const key = entry.key;
            let localN = 0;
            try {
                const s = target.stats(key);
                localN = Number.isFinite(s?.n) ? s.n : 0;
            }
            catch {
                localN = 0; // stats 故障按零证据 ⇒ 走「不掺」臂（安全方向）
            }
            // 闸①：本地零证据不掺（本地没见过的参数不引入外源漂移）
            if (localN <= 0) {
                notes.push(`${key}: 本地零证据不掺入（防外源漂移）`);
                perKey.push({ key, localN: 0, cap: 0, quota: 0, injected: 0, reason: 'local-empty' });
                continue;
            }
            const cap = Math.floor(share * localN);
            // 闸②：份额上限（share 折没 / 本地 n 太小 ⇒ 零配额）
            if (cap <= 0) {
                notes.push(`${key}: 份额上限折没（share=${share} × n=${localN} ⇒ cap=0）`);
                perKey.push({ key, localN, cap: 0, quota: 0, injected: 0, reason: 'cap-zero' });
                continue;
            }
            const bins = Array.isArray(entry.bins) ? entry.bins : [];
            const cells = [];
            for (let b = 0; b < DIGEST_BINS; b++) {
                const cell = bins[b];
                for (let col = 0; col < 2; col++) {
                    const v = cleanCell(Array.isArray(cell) ? cell[col] : undefined);
                    cells.push(v ?? 0); // 坏格按 0（与 mergeDigests 同律 —— 掺入面不吃脏数据）
                }
            }
            const total = cells.reduce((s, c) => s + c, 0);
            if (total <= 0) {
                notes.push(`${key}: 远端摘要零质量（全格 0），无从掺入`);
                perKey.push({ key, localN, cap, quota: 0, injected: 0, reason: 'remote-empty-mass' });
                continue;
            }
            const quota = Math.floor(cap * trust);
            // 闸③：信任折减（trust × cap < 1 ⇒ 零配额 —— 回归源的诚实出局）
            if (quota <= 0) {
                notes.push(`${key}: 信任折没（trust=${trust} × cap=${cap} ⇒ quota=0）`);
                perKey.push({ key, localN, cap, quota: 0, injected: 0, reason: 'trust-zero' });
                continue;
            }
            const take = allocateQuota(quota, cells);
            let injected = 0;
            for (let b = 0; b < DIGEST_BINS; b++) {
                for (let col = 0; col < 2; col++) {
                    const count = take[b * 2 + col];
                    for (let i = 0; i < count; i++) {
                        try {
                            // 掺入记录：成败由坨坐标反演（col 0 = success 列）、margin 取坨中心；
                            // 只喂账本 —— 值变化仍由本地 calibrator 全链执法（见 JSDoc 安全设计）
                            target.record({ key, success: col === 0, margin: binCenter(b), ts: nowMs });
                            injected += 1;
                        }
                        catch {
                            /* 单条入账故障：跳过该条，其余照掺 */
                        }
                    }
                }
            }
            applied += injected;
            perKey.push({ key, localN, cap, quota, injected, reason: 'blended' });
        }
        if (applied === 0 && notes.length === 0)
            notes.push('摘要 keys 为空：无 key 完成掺入');
        // 信任账：真实掺入量入账（sourceId 在场才记 —— 匿名摘要无源不立账）
        if (typeof opts?.sourceId === 'string' && opts.sourceId !== '' && applied > 0) {
            recordFederationTrust(opts.sourceId, { applied });
        }
        return { ok: true, applied, trust, perKey, notes };
    }
    catch {
        return reject('掺入过程异常：诚实全跳（绝不炸宿主）');
    }
}
let lastSync = null;
/** 上次同步状态（null = 尚未同步过 —— 诚实面，不臆造） */
export function lastFederationSync() {
    return lastSync ? { ...lastSync } : null;
}
/** 网络错误消毒：只留首行 200 字符；endpoint 原文（可能带凭据）替换为 <endpoint>（密钥卫生） */
function sanitizeNetError(e, endpoint) {
    try {
        let msg = String(e?.message ?? e ?? 'network error');
        msg = String(msg).split(/[\r\n]+/)[0].slice(0, 200);
        if (endpoint !== '') {
            while (msg.includes(endpoint))
                msg = msg.split(endpoint).join('<endpoint>');
        }
        return msg === '' ? 'network error' : msg;
    }
    catch {
        return 'network error';
    }
}
/** 响应载荷 → 摘要：取 payload.digest（或 payload 本身），形状+版本核验过关才收 */
function extractDigest(payload) {
    try {
        const cand = (payload && typeof payload === 'object' && !Array.isArray(payload) &&
            payload.digest && typeof payload.digest === 'object')
            ? payload.digest
            : payload;
        if (!cand || typeof cand !== 'object' || Array.isArray(cand))
            return null;
        const c = cand;
        if (c.v !== DIGEST_VERSION || !Array.isArray(c.keys))
            return null;
        return c;
    }
    catch {
        return null;
    }
}
/**
 * 响应载荷 → 多源原始摘要表（纪元 Μ2 鲁棒臂的专用入口）：只收 payload.digests
 * 数组（或 payload 本身为数组）里的**原始摘要**，逐件形状+版本核验，坏件静默剔除。
 * 信任模型与 legacy 臂的分野：鲁棒臂不接受预合并结果（payload.digest 单件）——
 * 「谁合并」必须发生在本地（数学执法代替对聚合端的信任）；参考聚合端
 * （scripts/federation-server.mjs）因此同时回带 digests 原始数组。
 */
function extractDigestList(payload) {
    try {
        const list = payload && typeof payload === 'object' && Array.isArray(payload.digests)
            ? payload.digests
            : Array.isArray(payload)
                ? payload
                : [];
        const out = [];
        for (const cand of list) {
            if (!cand || typeof cand !== 'object' || Array.isArray(cand))
                continue;
            const c = cand;
            if (c.v !== DIGEST_VERSION || !Array.isArray(c.keys))
                continue;
            out.push(c);
        }
        return out;
    }
    catch {
        return [];
    }
}
/**
 * 联邦同步（绝不抛）：
 *   ① 铸摘要：从（注入或缺省全局的）evidenceLedger 铸 DP 摘要；铸造失败 ⇒ 诚实
 *      返回 ok:false（零网络、零应用，宿主无感）；
 *   ② endpoint 空 ⇒ **零网络**：不构造 fetch、不建 AbortSignal —— 仅返回本地摘要
 *      （多进程/测试手递手用：mergeDigests + applyFederatedEvidence 自行组网）；
 *   ③ endpoint 非空 ⇒ fire-and-forget POST（swarm.fireUpload 同律：单次不重试、
 *      AbortSignal.timeout(5s)、错误消毒；上行载荷**只有摘要** —— 零截图零文本
 *      零键，绝不泄摘要外的信息）。响应含合并摘要 ⇒ applyFederatedEvidence 掺入
 *      （sourceId 缺省 = endpoint，信任账自动立账）。
 * settled 永不 reject（网络臂全程 try/catch —— 联邦是旁路义务，不是主路债主）。
 */
export function federationSync(opts = {}) {
    let nowMs = Date.now();
    if (typeof opts.now === 'function') {
        try {
            const t = opts.now();
            if (Number.isFinite(t))
                nowMs = t;
        }
        catch {
            /* 时钟故障保持 Date.now */
        }
    }
    const endpoint = typeof opts.endpoint === 'string' ? opts.endpoint : '';
    const ledger = opts.ledger ?? evidenceLedger; // 缺省全局单例；可注入（测试/多账本）
    // 种子：给定用给定；缺省由 now 派生 —— 每次同步的噪声流独立（DP 的跨次纪律）
    const seed = typeof opts.seed === 'number' && Number.isFinite(opts.seed) ? opts.seed : nowMs >>> 0;
    const digest = mintEvidenceDigest(ledger, { epsilon: opts.epsilon, seed, now: () => nowMs });
    const result = {
        ok: digest !== null,
        digest,
        network: 'off',
        endpoint,
        applied: null,
        settled: Promise.resolve(),
    };
    if (digest === null) {
        lastSync = { at: nowMs, network: 'off', applied: 0, note: '本地摘要铸造失败（账本视图非法）：零网络零应用' };
        return result;
    }
    if (endpoint === '') {
        // 零网络缺省：连 fetch 引用都不取（Μ-4 的 spy 面必须零调用）
        lastSync = { at: nowMs, network: 'off', applied: 0, note: 'endpoint 空：零网络，仅返回本地摘要' };
        return result;
    }
    // 网络臂：fetch 注入优先（null = 显式禁用），缺省全局 fetch（缺席 ⇒ 诚实降级）
    let fetchFn = null;
    if (typeof opts.fetchImpl === 'function')
        fetchFn = opts.fetchImpl;
    else if (opts.fetchImpl === null)
        fetchFn = null;
    else if (typeof fetch === 'function')
        fetchFn = fetch;
    if (!fetchFn) {
        result.network = 'failed';
        result.error = 'fetch 不可用（运行时无网络能力）：本地摘要已铸，诚实降级';
        lastSync = { at: nowMs, network: 'failed', applied: 0, note: result.error };
        return result;
    }
    result.network = 'fired';
    const body = JSON.stringify(digest); // 上行载荷只有摘要（密钥卫生：无凭据无文本无截图）
    result.settled = (async () => {
        try {
            const res = await fetchFn(endpoint, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body,
                signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
                    ? AbortSignal.timeout(FEDERATION_TIMEOUT_MS)
                    : undefined,
            });
            let payload = null;
            try {
                payload = await res?.json?.();
            }
            catch {
                payload = null; // 响应体坏 JSON：按无合并摘要处理（不炸、不掺）
            }
            if (opts.robust === true) {
                // ── Μ2 鲁棒臂：只收多源原始摘要，本地逐格中位数聚合（数学执法代替对聚合端的信任）──
                const remotes = extractDigestList(payload);
                if (remotes.length === 0) {
                    lastSync = { at: nowMs, network: 'fired', applied: 0, note: '响应不含可用的多源摘要（鲁棒臂只收 digests 原始数组）：只上传未掺入' };
                }
                else {
                    // 本机摘要作为第一源参与聚合（中位数对本机+诚实同侪有结构性保护 —— 毒未过半即被隔离）
                    const rr = robustMergeDigests([digest, ...remotes], {
                        sourceIds: ['local', ...remotes.map((_, idx) => `remote-${idx}`)],
                    });
                    // 检疫有牙齿（先检疫后掺入 —— 同一轮就咬合）：远端源的检疫票折算 regressed 记到
                    // endpoint 账上（端点为它交出的每一份摘要集体负责 —— 激励端点清洗毒源；
                    // 'local' 的票不喂账：本机偏离共识是本机校准自己的事，诚实注记在 robust 报告里）
                    let remoteVotes = 0;
                    for (const [label, votes] of Object.entries(rr.quarantined)) {
                        if (label !== 'local')
                            remoteVotes += votes;
                    }
                    if (remoteVotes > 0)
                        applyQuarantineToTrust({ [endpoint]: remoteVotes }, recordFederationTrust);
                    if (rr.merged !== null) {
                        const report = applyFederatedEvidence(ledger, rr.merged, {
                            maxRemoteShare: opts.maxRemoteShare,
                            sourceId: typeof opts.sourceId === 'string' && opts.sourceId !== '' ? opts.sourceId : endpoint,
                            now: () => nowMs,
                        });
                        result.applied = report;
                        result.robust = {
                            method: rr.method,
                            mergedFrom: rr.merged.mergedFrom,
                            quarantined: rr.quarantined,
                            excluded: rr.excluded,
                        };
                        lastSync = {
                            at: nowMs,
                            network: 'fired',
                            applied: report.applied,
                            note: report.ok ? undefined : `鲁棒合并摘要掺入被拒：${report.notes[0] ?? '原因未注记'}`,
                        };
                    }
                    else {
                        lastSync = { at: nowMs, network: 'fired', applied: 0, note: '鲁棒合并零有效源：只上传未掺入' };
                    }
                }
            }
            else {
                const candidate = extractDigest(payload);
                if (candidate !== null) {
                    const report = applyFederatedEvidence(ledger, candidate, {
                        maxRemoteShare: opts.maxRemoteShare,
                        sourceId: typeof opts.sourceId === 'string' && opts.sourceId !== '' ? opts.sourceId : endpoint,
                        now: () => nowMs,
                    });
                    result.applied = report;
                    lastSync = {
                        at: nowMs,
                        network: 'fired',
                        applied: report.applied,
                        note: report.ok ? undefined : `响应摘要掺入被拒：${report.notes[0] ?? '原因未注记'}`,
                    };
                }
                else {
                    lastSync = { at: nowMs, network: 'fired', applied: 0, note: '响应不含可用的合并摘要：只上传未掺入' };
                }
            }
        }
        catch (e) {
            // 网络失败静默降级（swarm.fireUpload 同律）—— 但状态面留消毒注记供 status 观察
            result.network = 'failed';
            result.error = sanitizeNetError(e, endpoint);
            lastSync = { at: nowMs, network: 'failed', applied: 0, note: result.error };
        }
    })();
    return result;
}
// ─── 测试缝：联邦运行时复位（信任账 + 上次同步记忆；生产代码无理由调用） ───
export function resetFederationRuntime() {
    trustAccounts.clear();
    lastSync = null;
}
