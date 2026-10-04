import { parseRootCause, recoveryLadderFor } from './diagnosis.js';
import { BRANCH_REPLAY_BUDGET_STEPS, cloneJson, safeNow, BranchLedgerBook } from './branchCards.js';
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
