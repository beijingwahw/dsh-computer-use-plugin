// src/branchCards.ledger.ts
// ΠΑΝ-127（D-F5 清偿）：岔路账域下沉叶 —— W6-2 把岔路卡/换支重放分区提取至
// branchCards.card.ts 后，卫星回借桶（branchCards.ts）的账本类/常量/防御工具
// （BranchLedgerBook/branchLedger/BRANCH_REPLAY_BUDGET_STEPS/safeNow/cloneJson
// /idxOr/parseStepRecord）构成桶-卫星 value 二环。按「共享契约下沉零环基座」
// 方言拆环：账本域整体入住本叶（消费链：叶 → autonomy/counterfactual 纯函数
// 评分内核，单向无环 —— counterfactual 不可达 branchCards，环执法在案为证）；
// 桶与卫星皆改 import 本叶；桶面 `export *` 再分发保导入面零破坏（checkpoint/
// index/steerTools 等消费点零改动）。行为零变化 —— 纯结构搬家，代码逐字保留。
import { rankTopK, actionSignature, DEFAULT_TOP_K } from './autonomy/counterfactual.js';
// ─── W3-6：常量（值即边界） ───
/** 岔路账环形容量（步）：只保最近 8 步的岔路 —— 支点价值随距离衰减，无界
 *  落账会让快照膨胀且失败归因远离失败点；8 步覆盖典型 goal 预算（24 步）的
 *  尾窗，失败后取「最近的可岔步」永远有账可取。 */
export const BRANCH_LEDGER_CAPACITY = 8;
/** 换支重放步数预算：重放是从支点的「第二尝试」，不得继承原路的全额预算
 *  （否则一次失败 × 三条岔路 = 四倍步数税）；12 步 ≈ 原预算半额。 */
export const BRANCH_REPLAY_BUDGET_STEPS = 12;
/** 岔路账段内版本钉（W3-6）：checkpoint 主体版本沿 W2-1 原地扩展律保持 4，
 *  段结构自带版本 —— 段内演化只升此钉，不撕裂 checkpoint 主契约。 */
export const BRANCH_LEDGER_SEGMENT_VERSION = 1;
// ─── W3-6：内部防御工具（零异常） ───
/** 非负整数卫兵：有限数 ⇒ floor 且夹 ≥0；否则缺省 */
export function idxOr(v, d) {
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : d;
}
/** 注入时钟安全读取：抛错/非有限数 ⇒ 0 */
export function safeNow(now) {
    try {
        const t = now();
        return typeof t === 'number' && Number.isFinite(t) ? t : 0;
    }
    catch {
        return 0;
    }
}
/** JSON 深拷贝（防御：不可序列化载荷 ⇒ 原样透传，绝不抛） */
export function cloneJson(v) {
    try {
        return JSON.parse(JSON.stringify(v));
    }
    catch {
        return v;
    }
}
// ─── W3-6：岔路账本体（有界环形缓冲） ───
/**
 * 岔路账：每步决策后的 Top-K 候选环形账（内存账 + dump/restore 持久化面）。
 *
 * record(options, ctx, meta)：调 counterfactual.rankTopK（与当步 scoreOptions
 * 同一评分内核 —— 账面即决策面）取 Top-3 落账；空候选/全脏 ⇒ null 不伪造。
 * 超容量 ⇒ 淘汰最旧步（环形有界，账永不膨胀）。
 *
 * restore（防御性恢复，入参 = **段对象**（BranchLedgerSnapshot 形状，含
 * entries 数组的对象）；条目数组/字符串/其它垃圾 ⇒ 归零）：整段垃圾 ⇒ 归零；
 * 坏步 ⇒ 弃置保好；好步按步号升序排稳后截实例容量。dump 恒出深拷贝（账面
 * 与调用方解耦）。
 */
export class BranchLedgerBook {
    _entries = [];
    _capacity;
    _now;
    constructor(opts = {}) {
        this._capacity =
            typeof opts.capacity === 'number' && Number.isFinite(opts.capacity)
                ? Math.max(1, Math.floor(opts.capacity))
                : BRANCH_LEDGER_CAPACITY;
        this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    }
    /** 每步决策后落账（返回入账记录的深拷贝；空候选集 ⇒ null） */
    record(options, ctx, meta = {}) {
        const ranked = rankTopK(options, ctx, DEFAULT_TOP_K);
        if (ranked === null || ranked.length === 0)
            return null; // 空候选不伪造岔路
        const rec = {
            stepIndex: idxOr(meta.stepIndex, this._entries.length + 1),
            recordedAt: safeNow(this._now),
            anchor: {
                journalLength: idxOr(meta.journalLength, 0),
                chainTip: typeof meta.chainTip === 'string' ? meta.chainTip : '',
            },
            candidates: ranked.map(r => ({
                rank: r.rank,
                signature: actionSignature(r.option.action),
                action: cloneJson(r.option.action),
                predictedEffects: r.option.predictedEffects.map(e => (typeof e === 'string' ? e : String(e))),
                progressProbability: r.option.progressProbability,
                informationGain: r.option.informationGain,
                risk: r.option.risk,
                utility: r.utility,
                steered: r.steered,
                wasChosen: r.rank === 1,
            })),
        };
        this._entries.push(rec);
        while (this._entries.length > this._capacity)
            this._entries.shift(); // 环形有界
        return cloneJson(rec);
    }
    /** 当前步数（≤ 容量） */
    get size() {
        return this._entries.length;
    }
    /** 最近一步（无账 ⇒ null） */
    latest() {
        return this._entries.length > 0 ? cloneJson(this._entries[this._entries.length - 1]) : null;
    }
    /** 持久化面：深拷贝快照（checkpoint 第六段的采集载荷） */
    dump() {
        return {
            version: BRANCH_LEDGER_SEGMENT_VERSION,
            capacity: this._capacity,
            entries: this._entries.map(cloneJson),
        };
    }
    /** 防御性恢复：整段垃圾 ⇒ 归零；坏步弃置保好；好步截实例容量 */
    restore(raw) {
        this._entries = [];
        if (!raw || typeof raw !== 'object')
            return { kept: 0, dropped: 0 };
        const r = raw;
        if (!Array.isArray(r.entries))
            return { kept: 0, dropped: 0 };
        let dropped = 0;
        const parsed = [];
        for (const e of r.entries) {
            const rec = parseStepRecord(e);
            if (rec === null) {
                dropped++;
                continue;
            }
            parsed.push(rec);
        }
        parsed.sort((a, b) => a.stepIndex - b.stepIndex || a.recordedAt - b.recordedAt);
        this._entries = parsed.slice(-this._capacity); // 实例容量执法（档内容量不可信）
        return { kept: this._entries.length, dropped };
    }
    /** 测试隔离 / 卸载面：账面归零 */
    reset() {
        this._entries = [];
    }
}
/** 岔路账单步的防御解析：结构坏 ⇒ null（弃置）；字段脏 ⇒ 逐项收敛 */
export function parseStepRecord(e) {
    if (!e || typeof e !== 'object')
        return null;
    const r = e;
    if (typeof r.stepIndex !== 'number' || !Number.isFinite(r.stepIndex) || r.stepIndex < 0)
        return null;
    if (!Array.isArray(r.candidates) || r.candidates.length === 0)
        return null;
    const candidates = [];
    for (const c of r.candidates) {
        if (!c || typeof c !== 'object')
            continue;
        const cr = c;
        if (!cr.action || typeof cr.action !== 'object')
            continue;
        if (typeof cr.signature !== 'string' || cr.signature === '')
            continue;
        candidates.push({
            rank: idxOr(cr.rank, candidates.length + 1),
            signature: cr.signature,
            action: cloneJson(cr.action),
            predictedEffects: Array.isArray(cr.predictedEffects)
                ? cr.predictedEffects.filter(p => typeof p === 'string')
                : [],
            progressProbability: typeof cr.progressProbability === 'number' && Number.isFinite(cr.progressProbability)
                ? Math.min(1, Math.max(0, cr.progressProbability))
                : 0,
            informationGain: typeof cr.informationGain === 'number' && Number.isFinite(cr.informationGain)
                ? Math.min(1, Math.max(0, cr.informationGain))
                : 0,
            risk: typeof cr.risk === 'number' && Number.isFinite(cr.risk) ? Math.min(1, Math.max(0, cr.risk)) : 0,
            utility: typeof cr.utility === 'number' && Number.isFinite(cr.utility) ? cr.utility : 0,
            steered: cr.steered === true,
            wasChosen: cr.wasChosen === true,
        });
    }
    if (candidates.length === 0)
        return null; // 无任何合法候选 ⇒ 该步整体弃置
    const a = (r.anchor ?? {});
    return {
        stepIndex: Math.floor(r.stepIndex),
        recordedAt: idxOr(r.recordedAt, 0),
        anchor: { journalLength: idxOr(a.journalLength, 0), chainTip: typeof a.chainTip === 'string' ? a.chainTip : '' },
        candidates,
    };
}
/** 岔路账采集面单例 —— checkpoint collect 的接线对象（组合根可换注入实例） */
export const branchLedger = new BranchLedgerBook();
