// ─── P0-2：D-6 → D-7 意图方言翻译器 ───
/** D-6 IntentPayload（goal 方言）→ D-7 IntentPayload（description 方言）—— 唯一翻译点 */
export function toD7Intent(intent) {
    return {
        id: intent.id,
        description: intent.goal.slice(0, 160), // D-7 description 预算 = D-6 goal 预算（≤160）
        previousResults: undefined, // D-6 方言无此维 —— 诚实缺席，绝不伪造
    };
}
// ─── P0-4：D-4 事件方言 → D-7 内部方言翻译器 ───
/** D-4 doctor/verdict 载荷 → D-7 三态判决（0-100 分数域 → 0-1 置信域换算）。
 *  域外分数防线：换算前先验 0-100 契约域 —— 域外绝不换算出域外 confidence
 *  （clamp 掩埋 bug，needs_review 标记交人审暴露它）。 */
export function translateVerdict(p) {
    if (typeof p.score !== 'number' || !Number.isFinite(p.score) || p.score < 0 || p.score > 100) {
        return { status: 'needs_review', flags: [`score ${String(p.score)} out of 0-100 domain`] };
    }
    if (p.verdict === 'approved') {
        return { status: 'approved', confidence: p.score / 100 }; // 0-100 → 0-1 域换算
    }
    if (p.verdict === 'rejected') {
        return { status: 'rejected', reason: (p.rationale ?? 'rejected by D-4').slice(0, 200) };
    }
    return { status: 'needs_review', flags: p.rationale ? [p.rationale.slice(0, 120)] : ['d-4 needs review'] };
}
// ─── P0-4：D-4 判决桥 —— D-7 验收结算门（OutcomeSettlement 处理逻辑）───
/** 回执缓存容量上限（防爆环保险丝：迟到/永不被结算的回执不允许无界滞留内存） */
const MAX_CACHED_VERDICTS = 500;
/**
 * 判决桥：D-4 事件回执的缓存 + outcome 验收结算器。
 * 铁律（D-7 验收门）：learnFromOutcome 只消费已结算的 outcome ——
 *   'verdict'   = D-4 回执到达（黄金路径，判决附加后结算）
 *   'run-end'   = 流水线终局冲账（D-4 沉默的诚实降级 —— 学习不因沉默而缺席，
 *                 但结算单如实标注证据缺席）
 * subject 逐字约定：`${intentId}:${seq}`（D-4 发射侧 / D-7 消费侧双端契约）。
 * 内存纪律（风险加固）：回执消费即销毁（已结算的证据不滞留）；
 *   永不被消费的回执 FIFO 淘汰至上限（迟到死证据不许无界堆积）。
 */
export class DoctorVerdictBridge {
    verdicts = new Map();
    pending = [];
    /** D-4 事件回执入口（index.ts 的 onDoctorVerdict 接线点）—— 翻译后缓存。
     *  域执法在入口：score 域外（非有限数或越 0-100）拒绝缓存 —— 回执缺席走
     *  run-end 冲账（诚实降级），绝不缓存域外证据毒化结算。 */
    ingest(p) {
        if (!p || typeof p.subject !== 'string' || !p.subject)
            return; // 非法载荷拒绝缓存
        if (typeof p.score !== 'number' || !Number.isFinite(p.score) || p.score < 0 || p.score > 100) {
            return; // score 域外拒绝（0-100 契约域 —— 入口执法，不靠下游）
        }
        this.verdicts.delete(p.subject); // 重铸刷新插入序（FIFO 淘汰按最新到达计龄）
        this.verdicts.set(p.subject, translateVerdict(p));
        if (this.verdicts.size > MAX_CACHED_VERDICTS) {
            const oldest = this.verdicts.keys().next().value; // Map 迭代序 = 插入序
            if (oldest !== undefined)
                this.verdicts.delete(oldest); // 最老死证据淘汰
        }
    }
    /** 只读窥视（审计/测试用；不产生结算） */
    peek(subject) {
        return this.verdicts.get(subject);
    }
    /** subject 铸造（`${intentId}:${seq}` 逐字约定 —— 双端契约的唯一落点） */
    subjectFor(intentId, seq) {
        return `${intentId}:${seq}`;
    }
    /**
     * 即时结算：回执在场 ⇒ 附加判决并结算（settledBy='verdict'）；
     * 回执缺席 ⇒ 返回 null（调用方挂账 pending —— 学习被验收门拦下，不发生）。
     * 消费即销毁：已结算的回执是死证据，从缓存删除（subject 一生只结算一次）。
     */
    trySettle(seq, outcome) {
        const subject = this.subjectFor(outcome.intent.id, seq);
        const v = this.verdicts.get(subject);
        if (!v)
            return null;
        this.verdicts.delete(subject);
        outcome.doctorVerdict = v;
        return { subject, outcome, settledBy: 'verdict', settledAt: Date.now() };
    }
    /** 挂账：回执未到的 outcome 等待 run-end 冲账（验收门的等待室） */
    defer(seq, outcome) {
        this.pending.push({ seq, outcome });
    }
    /**
     * 终局冲账：pending 结算 —— 迟到回执在场 ⇒ 'verdict'（证据后到不是沉默）；
     * 仍然缺席 ⇒ 'run-end'（诚实降级：学习照常，结算单如实标注 D-4 沉默）。
     * 作用域（风险加固）：无参 = 全量冲账（历史契约）；带 intentId = 只冲该
     * intent 的挂账 —— 并发 run 场景 A 的终局绝不越权结算 B 的等待室
     * （B 的 outcome 须等 B 自己的终局，验收门语义不被他人的时钟劫持）。
     * 幂等：冲账即清空对应等待室（重复调用返回空）。
     */
    settleAll(intentId) {
        const settledAt = Date.now();
        let drained;
        if (intentId === undefined) {
            drained = this.pending.splice(0);
        }
        else {
            drained = this.pending.filter(x => x.outcome.intent.id === intentId);
            this.pending = this.pending.filter(x => x.outcome.intent.id !== intentId);
        }
        return drained.map(({ seq, outcome }) => {
            const subject = this.subjectFor(outcome.intent.id, seq);
            const v = this.verdicts.get(subject);
            if (v) {
                outcome.doctorVerdict = v;
                this.verdicts.delete(subject); // 消费即销毁
            }
            return { subject, outcome, settledBy: v ? 'verdict' : 'run-end', settledAt };
        });
    }
    /** 生命周期归零（ctx.effect 清理函数调用 —— 零残留） */
    reset() {
        this.verdicts.clear();
        this.pending = [];
    }
}
