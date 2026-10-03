// src/kernel/registry.ts
// 纪元 Θ（Θ-1 内核注册表与证据账本）：全库写死的数学内核阈值 → 可进化参数的铸造现场。
//
// 三条先例律（本器官一字不违）：
//   · 区间语义照 src/knowledge/params.ts —— 区间是校准结论，缺省取区间内一点，
//     一切写径越界即夹取（clamp），区间外不存在状态；
//   · 单例 + reset 照 src/vlm/metering.ts —— 模块级单例贯穿插件生命周期，
//     resetKernelRuntime 供测试隔离（生产代码无理由清空生产注册表）；
//   · 垃圾输入静默降级、绝不抛异常 —— 与 metering 同律（诚实回声 / 静默忽略）。
// 纯离线零依赖：无 import、无 IO；updatedAt 走 Date.now（不注入墙钟 —— 值语义可测）。
/** 夹取：v 收进 [lo, hi]（调用方保证 v 有限、lo < hi —— 与 params.ts 同一区间语义） */
function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}
/** 垃圾 spec 回声的打标注记 —— 静默失败的唯一可观察面（入册与否以 has()/list() 为准） */
const IGNORED_SPEC_NOTE = '垃圾 spec：静默忽略，未入册（入册与否以 has()/list() 为准）';
/**
 * 规格体检 + 规格化：垃圾 spec 返回 null（绝不抛），合格 spec 返回全字段确定的
 * 规格副本（defaultValue 已夹入区间 —— params.ts「缺省取区间内一点」律）。
 * 垃圾判据：非对象 / key 非非空字符串 / organ 非字符串 / 三个数值任一非有限
 * （NaN、±Infinity 同罪）/ min ≥ max。
 */
function normalizeSpec(raw) {
    const s = (raw ?? {});
    if (typeof s.key !== 'string' || s.key === '')
        return null;
    if (typeof s.organ !== 'string')
        return null;
    if (!Number.isFinite(s.defaultValue) || !Number.isFinite(s.min) || !Number.isFinite(s.max))
        return null;
    const min = s.min;
    const max = s.max;
    if (min >= max)
        return null;
    const base = {
        key: s.key,
        organ: s.organ,
        defaultValue: clamp(s.defaultValue, min, max),
        min,
        max,
    };
    return typeof s.note === 'string' ? { ...base, note: s.note } : base;
}
/**
 * 垃圾 spec 的未入册回声：字段尽力消毒（区间自洽、defaultValue 夹取），
 * note 打 IGNORED_SPEC_NOTE 标。它不入册、零副作用 —— register 对垃圾输入
 * 不许抛、也不改契约形状，故以「查无此 key」为失败判据，回声仅为调试线索。
 */
function ignoredEcho(raw) {
    const s = (raw ?? {});
    const min = Number.isFinite(s.min) ? s.min : 0;
    const maxRaw = Number.isFinite(s.max) ? s.max : 1;
    const max = maxRaw > min ? maxRaw : min + 1;
    const defaultValue = Number.isFinite(s.defaultValue)
        ? clamp(s.defaultValue, min, max)
        : min;
    return {
        key: typeof s.key === 'string' ? s.key : '',
        organ: typeof s.organ === 'string' ? s.organ : '',
        defaultValue,
        min,
        max,
        note: IGNORED_SPEC_NOTE,
        value: defaultValue,
        evidence: 0,
        generation: 0,
        updatedAt: 0,
    };
}
/**
 * 内核注册表：key → 参数（值 + 区间 + 证据 + 代际）的唯一权威源。
 *
 * 语义要点（全军团单位依赖的契约）：
 *   - 值不变式：一切写径（register 重夹 / set / restore / promoteFrom）恒夹取
 *     进 [min, max] —— 读方（get/getOrDefault/list/snapshot）永远拿到区间内值；
 *   - 绝不抛：垃圾输入静默忽略（register 的失败以 has()/list() 查无为准）；
 *   - updatedAt 只记数值变更（规格 / 证据更新不伪造「变过值」的痕迹）。
 */
export class KernelRegistry {
    /** 入册条目（插入序 = 入册序；防御纪律：对外只出副本） */
    params = new Map();
    /**
     * 入册（幂等）：
     *   - 新 key：value = 夹取后的 defaultValue，evidence = 0，generation = 0；
     *   - 重复注册：**保持现值**（新 bounds 越界即重夹 value）、证据与代际原样，
     *     只更新规格（organ / defaultValue / min / max / note —— note 未给即清除）；
     *   - 垃圾 spec（非对象 / key 空 / organ 非串 / 数值非有限 / min ≥ max）：
     *     **静默忽略，不入册**（has() 假、list() 查无此 key），返回 note 打
     *     「忽略」标的未入册回声（绝不抛、零副作用）；
     *   - 注册成功返回防御副本（篡改返回值不穿透注册表）。
     */
    register(spec) {
        const norm = normalizeSpec(spec);
        if (norm === null)
            return ignoredEcho(spec);
        const prev = this.params.get(norm.key);
        if (prev) {
            // 幂等重注册：现值重夹进新 bounds，证据 / 代际原样继承
            const value = clamp(prev.value, norm.min, norm.max);
            const next = {
                ...norm,
                value,
                evidence: prev.evidence,
                generation: prev.generation,
                updatedAt: value !== prev.value ? Date.now() : prev.updatedAt,
            };
            this.params.set(norm.key, next);
            return { ...next };
        }
        const fresh = {
            ...norm,
            value: norm.defaultValue,
            evidence: 0,
            generation: 0,
            updatedAt: Date.now(),
        };
        this.params.set(norm.key, fresh);
        return { ...fresh };
    }
    /** 是否在册（非字符串 key 一律 false） */
    has(key) {
        return typeof key === 'string' && this.params.has(key);
    }
    /** 读现值：未注册返回 null（区间不变式保证返回值恒在 [min, max] 内） */
    get(key) {
        const p = typeof key === 'string' ? this.params.get(key) : undefined;
        return p ? p.value : null;
    }
    /**
     * 读现值（生产缺省零行为变化的关键缝）：未注册 ⇒ 原样回声 fallback
     * （消费方以写死的字面量兜底时，行为与迁移前逐字节一致）；已注册 ⇒ 夹取后值
     * （不变式下即现值 —— 再夹一次是零成本的读侧防御）。
     */
    getOrDefault(key, fallback) {
        const p = typeof key === 'string' ? this.params.get(key) : undefined;
        return p ? clamp(p.value, p.min, p.max) : fallback;
    }
    /**
     * 设值（先夹取后入账 —— 夹取是成功而非失败）：
     *   - 已注册 + 有限值：恒生效。区间内 ⇒ { ok: true }；越界 ⇒ 夹到边界后
     *     { ok: true, reason: 'clamped', clampedTo: 实际落值 }；
     *   - 未注册 ⇒ { ok: false, reason: 'unregistered' }（不动任何状态）；
     *   - 值非有限（NaN / ±Infinity）⇒ { ok: false, reason: 'invalid-value' }（现值不动）；
     *   - evidenceDelta：缺省 0（不动证据）；有限则累加（地板 0）。
     */
    set(key, value, evidenceDelta) {
        const p = typeof key === 'string' ? this.params.get(key) : undefined;
        if (!p)
            return { ok: false, reason: 'unregistered' };
        if (!Number.isFinite(value))
            return { ok: false, reason: 'invalid-value' };
        const clamped = clamp(value, p.min, p.max);
        const d = Number.isFinite(evidenceDelta) ? evidenceDelta : 0;
        const changed = clamped !== p.value;
        this.params.set(key, {
            ...p,
            value: clamped,
            evidence: Math.max(0, p.evidence + d),
            updatedAt: changed ? Date.now() : p.updatedAt,
        });
        if (clamped !== value)
            return { ok: true, reason: 'clamped', clampedTo: clamped };
        return { ok: true };
    }
    /**
     * 证据累加：缺省 +1；delta 非有限按 0 计（垃圾增量不掺水）；累加后地板 0
     * （证据是计数，不为负）；未注册静默。只动 evidence，不动数值与 updatedAt。
     */
    addEvidence(key, delta) {
        const p = typeof key === 'string' ? this.params.get(key) : undefined;
        if (!p)
            return;
        const d = delta === undefined ? 1 : Number.isFinite(delta) ? delta : 0;
        this.params.set(key, { ...p, evidence: Math.max(0, p.evidence + d) });
    }
    /** 全册目录（审计 / 仪表盘用）：防御深拷贝 —— 字段皆基元，逐项复制即深拷贝，篡改不穿透 */
    list() {
        return [...this.params.values()].map(p => ({ ...p }));
    }
    /**
     * 漂移报表：driftPct = |value − defaultValue| / (max − min) × 100（手算可复现）。
     * 仅列偏离者（value ≠ defaultValue —— 未动过的参数不出列）；
     * defaultValue 入册即夹取 ⇒ 分子 ≤ 分母，driftPct 恒 ∈ [0, 100]。
     */
    drift() {
        const out = [];
        for (const p of this.params.values()) {
            if (p.value === p.defaultValue)
                continue;
            out.push({
                key: p.key,
                organ: p.organ,
                driftPct: (Math.abs(p.value - p.defaultValue) / (p.max - p.min)) * 100,
                evidence: p.evidence,
                generation: p.generation,
            });
        }
        return out;
    }
    /** 值快照：{ key: value }（新对象 —— 与注册表后续变动解耦；promote/restore 的载体） */
    snapshot() {
        const snap = {};
        for (const [k, p] of this.params)
            snap[k] = p.value;
        return snap;
    }
    /**
     * 从快照恢复：只恢复**已注册** key（未注册 key 静默忽略 —— 快照可含历史残迹），
     * 值重夹当时 bounds（快照可能出自旧区间）；非有限值静默跳过；证据与代际不动
     * （恢复的是数值，不是历史 —— 历史由 ledger 管）。
     */
    restore(snap) {
        if (!snap || typeof snap !== 'object')
            return;
        for (const [k, v] of Object.entries(snap)) {
            const p = this.params.get(k);
            if (!p || !Number.isFinite(v))
                continue;
            const value = clamp(v, p.min, p.max);
            this.params.set(k, {
                ...p,
                value,
                updatedAt: value !== p.value ? Date.now() : p.updatedAt,
            });
        }
    }
    /**
     * 实验室 → 生产晋升：把 lab 的值拷入本注册表（生产）。
     *   - key 域：显式 opts.keys（非字符串项剔除）∩ 双方在册；缺省 = 全部已注册交集；
     *     任一侧未注册的 key 跳过（lab 未注册不报错，生产未注册不动）；
     *   - 拷贝语义：to = lab 值**重夹生产 bounds**（实验室可以探得更宽的区间），
     *     evidence := lab 的（取，不是加 —— 证据跟着值走），generation + 1（世系 +1 代），
     *     updatedAt 仅数值变化时刷新；
     *   - 返回晋升清单：[{ key, from, to }]，值未变（from === to）也入清单 ——
     *     证据与代际已更新，这是一次真实的晋升事件；
     *   - lab 非法（非 KernelRegistry）⇒ 空清单；晋升是拷贝不是移动 —— lab 不受影响。
     */
    promoteFrom(lab, opts) {
        if (!(lab instanceof KernelRegistry))
            return [];
        const wanted = opts?.keys;
        const keys = Array.isArray(wanted)
            ? wanted.filter((k) => typeof k === 'string')
            : [...this.params.keys()].filter(k => lab.params.has(k));
        const changes = [];
        for (const key of keys) {
            const prod = this.params.get(key);
            const labP = lab.params.get(key);
            if (!prod || !labP)
                continue;
            const to = clamp(labP.value, prod.min, prod.max);
            this.params.set(key, {
                ...prod,
                value: to,
                evidence: labP.evidence,
                generation: prod.generation + 1,
                updatedAt: to !== prod.value ? Date.now() : prod.updatedAt,
            });
            changes.push({ key, from: prod.value, to });
        }
        return changes;
    }
    /** 清空全部条目（测试隔离 / 会话切换用 —— 生产代码无理由调用） */
    reset() {
        this.params.clear();
    }
}
/** 生产单例：插件生命周期内唯一的生产注册表 —— 内核阈值的唯一权威源（实验室请自建实例） */
export const kernelRegistry = new KernelRegistry();
/** 每 key 滑窗容量：200 条 FIFO（内存有界，最近行为优先 —— 与 metering 的窗口取舍同律） */
const LEDGER_WINDOW = 200;
/**
 * 证据账本：逐 key 的结果滑窗（200 条 FIFO），为进化决策供成败率与裕量分布。
 * 垃圾输入静默（非对象 / key 非非空串 / success 非布尔 ⇒ 丢弃；ts 非有限消毒为 0）；
 * margins 与滑窗同序（旧 → 新），只含有 margin 的条目；一切读取出防御副本。
 */
export class EvidenceLedger {
    /** key → 滑窗（插入序 = 入账序；窗口满后挤最旧） */
    windows = new Map();
    /** 记一结果：垃圾输入静默丢弃；每 key 滑窗 200，第 201 条挤最旧（FIFO） */
    record(outcome) {
        const o = (outcome ?? {});
        if (typeof o.key !== 'string' || o.key === '')
            return;
        if (typeof o.success !== 'boolean')
            return;
        const entry = {
            success: o.success,
            ts: Number.isFinite(o.ts) ? o.ts : 0,
        };
        if (Number.isFinite(o.margin))
            entry.margin = o.margin;
        const win = this.windows.get(o.key) ?? [];
        win.push(entry);
        if (win.length > LEDGER_WINDOW)
            win.splice(0, win.length - LEDGER_WINDOW);
        this.windows.set(o.key, win);
    }
    /**
     * 窗口统计：n = 窗内条数（n = 0 ⇒ successRate = 0 —— 空窗诚实归零，不用 NaN 说谎）；
     * successRate = 窗内成功占比；margins = 窗内有 margin 条目的裕量列表（旧 → 新，防御副本）。
     */
    stats(key) {
        const win = typeof key === 'string' ? this.windows.get(key) : undefined;
        if (!win || win.length === 0)
            return { n: 0, successRate: 0, margins: [] };
        let succ = 0;
        const margins = [];
        for (const e of win) {
            if (e.success)
                succ++;
            if (e.margin !== undefined)
                margins.push(e.margin);
        }
        return { n: win.length, successRate: succ / win.length, margins };
    }
    /** 有入账的 key 目录（插入序副本 —— 与注册表入册序解耦） */
    keys() {
        return [...this.windows.keys()];
    }
    /** 清空全部账本（测试隔离 / 会话切换用） */
    reset() {
        this.windows.clear();
    }
}
/** 单例：内核进化证据的全局台账（插件生命周期内唯一） */
export const evidenceLedger = new EvidenceLedger();
/** 两单例齐 reset（测试隔离专用 —— 生产代码无理由清空生产态） */
export function resetKernelRuntime() {
    kernelRegistry.reset();
    evidenceLedger.reset();
}
