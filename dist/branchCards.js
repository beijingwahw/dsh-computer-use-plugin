// src/branchCards.ts
// W3-6（H3 反事实岔路卡 · Ghost Replay 纠偏）：失败之后，「如果当时走了另一条
// 路」不该是一句空话 —— 本模块把它铸成可一键执行的岔路卡。
//
// 既有事实：counterfactual（Φ-9）每步都对候选集做了完整的效用预演，但择优后
// 即弃全部落选者 —— 「当时第二好的路」这个最贵的反事实信息被白白扔掉。本
// 模块把它落账、铸卡、供一键换支重放：
//
//   ① 岔路账（BranchLedgerBook）：每步决策后按 Top-3 落盘（含预测效用、动作
//      形状、关键参数），有界环形缓冲只保最近 capacity 步 —— 内存账随
//      checkpoint 第六段 branchLedger 持久化（见 checkpoint.ts W3-6 注记）。
//   ② 岔路卡（generateBranchCard）：goal 进入 failed/aborted 终局相时自动取
//      失败前最近的可岔步铸卡 —— 三候选各附诚实预测效用 + 该步失败归因
//      （只读消费 diagnosis 的 R1 根因报告与 W2-5 恢复梯）+ 支点引用
//      （checkpoint 步账位置：journal 条数 + 链尖）。卡片结构化、可序列化。
//   ③ 换支重放（applyBranchChoice + BranchReplayController）：用户 steer(k)
//      一键选第 k 候选 —— 支点防御校验（锚不匹配/账无支点 ⇒ 诚实拒绝）后，
//      经 counterfactual 的 ScoringContext.preferredActionKeys 注入缝铸「改选
//      偏置」（偏置只改选择不改预测）；重放有步数预算，超支诚实终止。
//
// 防御律（与库内记忆系统同律）：无账 ⇒ 卡片缺席（诚实降级，不伪造岔路）；
// 垃圾账 ⇒ 归零；坏步 ⇒ 弃置保好；一切脏输入卫兵式收敛，公开面绝不抛异常。
// 纪律：纯内存 + 纯函数（checkpoint 采集面除外），全离线可测；时钟可注入。
import { rankTopK, actionSignature, DEFAULT_TOP_K } from './autonomy/counterfactual.js';
import { parseRootCause, recoveryLadderFor, } from './diagnosis.js';
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
function idxOr(v, d) {
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : d;
}
/** 注入时钟安全读取：抛错/非有限数 ⇒ 0 */
function safeNow(now) {
    try {
        const t = now();
        return typeof t === 'number' && Number.isFinite(t) ? t : 0;
    }
    catch {
        return 0;
    }
}
/** JSON 深拷贝（防御：不可序列化载荷 ⇒ 原样透传，绝不抛） */
function cloneJson(v) {
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
function parseStepRecord(e) {
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
/** diagnosis 根因报告 → 卡面归因（只读消费 + 防御收敛；报告缺席 ⇒ unknown 兜底） */
function attributionOf(report) {
    const r = (report && typeof report === 'object' ? report : null);
    const rootCause = parseRootCause(r?.rootCause); // 垃圾值 ⇒ 'unknown'（diagnosis 律）
    const cands = Array.isArray(r?.candidates) ? r.candidates : [];
    const cand = cands.find(c => !!c && parseRootCause(c?.rootCause) === rootCause);
    const hypothesis = typeof cand?.hypothesis === 'string' && cand.hypothesis !== '' ? cand.hypothesis : '';
    const trail = Array.isArray(r?.trail) ? r.trail : [];
    const probeTrail = [];
    for (const t of trail) {
        if (!t || typeof t !== 'object')
            continue;
        const step = t;
        if (typeof step.probe !== 'string')
            continue;
        probeTrail.push(`${step.probe}: ${typeof step.observation === 'string' ? step.observation : 'n/a'}`);
        if (probeTrail.length >= 8)
            break; // 卡面纪律：审计摘要封顶
    }
    return {
        rootCause,
        hypothesis,
        recoveryLadder: recoveryLadderFor(rootCause),
        probeTrail,
        degraded: r?.degraded === true,
    };
}
/** 账面 → 步账列表（book / snapshot 双形态收口，防御脏值） */
function ledgerEntriesOf(ledger) {
    if (!ledger)
        return [];
    if (ledger instanceof BranchLedgerBook)
        return ledger.dump().entries;
    const snap = ledger;
    return Array.isArray(snap.entries) ? snap.entries : [];
}
/**
 * 岔路卡生成（纯函数、绝不抛）：
 * goal 进入 failed/aborted 终局相 ⇒ 取失败前最近的可岔步（环形账最后一步），
 * 铸三候选岔路卡 —— 各候选附诚实预测效用 + 该步失败归因（diagnosis 只读）
 * + 卡级支点引用（checkpoint 步账位置）。
 *
 * 诚实边界：非失败终局相（acting/achieved/blocked/…）⇒ null（岔路卡只在
 * 失败后有意义）；岔路账为空（未武装 / 环形淘汰殆尽 / 崩溃后未恢复）⇒ null
 * （无账不造卡 —— 诚实降级）；归因报告缺席 ⇒ unknown 兜底（鉴别穷尽的诚实
 * 无知，与 R1 兜底律同源）。
 */
export function generateBranchCard(ledger, failure) {
    if (!failure || (failure.phase !== 'failed' && failure.phase !== 'aborted'))
        return null;
    const entries = ledgerEntriesOf(ledger);
    if (entries.length === 0)
        return null; // 无岔路账 ⇒ 卡片缺席（诚实降级）
    const pivotStep = entries[entries.length - 1];
    const attribution = attributionOf(failure.attribution ?? null);
    const now = typeof failure.now === 'function' ? failure.now : Date.now;
    return {
        cardVersion: 1,
        createdAt: safeNow(now),
        goalPhase: failure.phase,
        goalReason: typeof failure.reason === 'string' ? failure.reason : '',
        pivot: {
            stepIndex: pivotStep.stepIndex,
            recordedAt: pivotStep.recordedAt,
            anchor: { journalLength: pivotStep.anchor.journalLength, chainTip: pivotStep.anchor.chainTip },
        },
        candidates: pivotStep.candidates.map(c => ({ ...c, attribution })),
    };
}
/**
 * 重放预算控制器：换支重放的每一步先 spend() 扣预算 —— 预算内放行计步，
 * 超支 ⇒ proceed=false 诚实终止（绝不悄悄续命：重放是第二尝试，不继承原路
 * 全额预算）。complete() 收尾；exhausted 是终局（超支后再 complete 不改判）。
 */
export class BranchReplayController {
    _stepsUsed = 0;
    _status = 'armed';
    _budgetSteps;
    constructor(budgetSteps) {
        this._budgetSteps = budgetSteps;
    }
    get state() {
        return { status: this._status, stepsUsed: this._stepsUsed, budgetSteps: this._budgetSteps };
    }
    /** 重放每步前扣预算（预算执法点） */
    spend() {
        if (this._status === 'completed') {
            return {
                proceed: false, status: 'completed', stepsUsed: this._stepsUsed, budgetSteps: this._budgetSteps,
                note: '重放已完成（complete 之后再 spend = 调用方账目混乱，拒绝计步）',
            };
        }
        if (this._stepsUsed >= this._budgetSteps) {
            this._status = 'exhausted';
            return {
                proceed: false, status: 'exhausted', stepsUsed: this._stepsUsed, budgetSteps: this._budgetSteps,
                note: `重放预算 ${this._budgetSteps} 步已耗尽 —— 诚实终止（不伪造继续）`,
            };
        }
        this._stepsUsed += 1;
        this._status = 'stepping';
        return { proceed: true, status: 'stepping', stepsUsed: this._stepsUsed, budgetSteps: this._budgetSteps };
    }
    /** 重放成功收尾（exhausted 后调用无效 —— 超支是终局事实） */
    complete() {
        if (this._status !== 'exhausted')
            this._status = 'completed';
    }
}
/** 岔路卡防御解析：结构坏 ⇒ null（缺卡/坏卡一律诚实拒绝，绝不伪造换支） */
function parseBranchCard(card) {
    if (!card || typeof card !== 'object')
        return null;
    const c = card;
    if (c.cardVersion !== 1)
        return null;
    if (typeof c.pivot !== 'object' || c.pivot === null)
        return null;
    const pivot = c.pivot;
    if (typeof pivot.stepIndex !== 'number' || !Number.isFinite(pivot.stepIndex))
        return null;
    const rawCands = Array.isArray(c.candidates) ? c.candidates : [];
    const candidates = rawCands
        .map(x => (x && typeof x === 'object' ? x : null))
        .filter((x) => x !== null && !!x.action && typeof x.signature === 'string');
    if (candidates.length === 0)
        return null;
    return card;
}
/**
 * W3-6（H3）换支重放主入口（纯函数、绝不抛 —— steer 工具/集成侧的调用面）：
 * 用户 steer(k) 一键选第 k 候选 ——
 *   ① 缺卡/坏卡 ⇒ ok:false（goal 未失败或岔路账缺席的诚实降级）；
 *   ② k 域防御：非整数 / 越界 ⇒ ok:false（合法域 1..candidates.length）；
 *   ③ 支点防御恢复：verifyAnchor 不匹配或当前账无该支点步 ⇒ ok:false
 *      （世界已漂移 / 支点被环形淘汰 —— 拒绝换支，绝不从错位世界重放）；
 *   ④ 偏置载荷：选中候选的签名铸为 preferredActionKeys（经 withSteerBias 铸入
 *      counterfactual 的 ScoringContext 注入缝 —— 改选偏置只改选择不改预测）；
 *   ⑤ 重放预算：BranchReplayController 执法（缺省 12 步，超支诚实终止）。
 */
export function applyBranchChoice(card, k, opts = {}) {
    const parsed = parseBranchCard(card);
    if (parsed === null) {
        return { ok: false, error: 'no branch card（goal 未进入失败终局相，或岔路账缺席 —— 诚实降级）' };
    }
    if (typeof k !== 'number' || !Number.isInteger(k) || k < 1 || k > parsed.candidates.length) {
        return { ok: false, error: `invalid choice k=${String(k)}（合法域 1..${parsed.candidates.length}）`, pivot: parsed.pivot };
    }
    const anchor = parsed.pivot.anchor;
    if (opts.verifyAnchor !== undefined && opts.verifyAnchor !== null) {
        const vj = typeof opts.verifyAnchor.journalLength === 'number' && Number.isFinite(opts.verifyAnchor.journalLength)
            ? Math.floor(opts.verifyAnchor.journalLength)
            : -1;
        const vc = typeof opts.verifyAnchor.chainTip === 'string' ? opts.verifyAnchor.chainTip : '';
        if (vj !== anchor.journalLength || vc !== anchor.chainTip) {
            return {
                ok: false,
                error: `pivot anchor mismatch（卡内 ${anchor.journalLength}/${anchor.chainTip || '∅'} vs 当前 ${vj}/${vc || '∅'}）—— 世界已漂移，拒绝换支`,
                pivot: parsed.pivot,
            };
        }
    }
    if (opts.ledger !== undefined && opts.ledger !== null) {
        const has = ledgerEntriesOf(opts.ledger).some(e => e.stepIndex === parsed.pivot.stepIndex && e.anchor.chainTip === anchor.chainTip);
        if (!has) {
            return {
                ok: false,
                error: `岔路账中无支点步 ${parsed.pivot.stepIndex}（环形淘汰或段未恢复）—— 拒绝换支`,
                pivot: parsed.pivot,
            };
        }
    }
    const budget = typeof opts.budgetSteps === 'number' && Number.isFinite(opts.budgetSteps)
        ? Math.max(1, Math.floor(opts.budgetSteps))
        : BRANCH_REPLAY_BUDGET_STEPS;
    const cand = parsed.candidates[k - 1];
    return {
        ok: true,
        k,
        choice: { signature: cand.signature, action: cloneJson(cand.action), utility: cand.utility, rank: cand.rank },
        pivot: parsed.pivot,
        restore: {
            ok: true,
            anchor: { journalLength: anchor.journalLength, chainTip: anchor.chainTip },
            note: opts.verifyAnchor !== undefined && opts.verifyAnchor !== null
                ? '支点锚校验通过（checkpoint 步账一致）'
                : '支点引用随卡携带（未提供校验锚 —— 未经强校验，如实申报）',
        },
        bias: { preferredActionKeys: [cand.signature] },
        replay: new BranchReplayController(budget),
    };
}
/**
 * 偏置铸入（注入缝消费面）：把 applyBranchChoice 的 bias 载荷合并进评分上下文
 * 的 preferredActionKeys（去重保序）。纯函数 —— 原 ctx 不被改动。
 */
export function withSteerBias(ctx, keys) {
    const base = (ctx && typeof ctx === 'object' ? ctx : {});
    const merged = [];
    const seen = new Set();
    for (const k of [...(base.preferredActionKeys ?? []), ...keys]) {
        if (typeof k !== 'string' || k === '' || seen.has(k))
            continue;
        seen.add(k);
        merged.push(k);
    }
    return { ...base, preferredActionKeys: merged };
}
