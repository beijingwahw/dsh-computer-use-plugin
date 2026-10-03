// src/autonomy/goalState.ts
// 纪元 Φ（Φ-1）：目标状态机 —— 自主智能环的「判官」。
// 自主环（自主识别 → 自主判断 → 自主执行）的每一圈由 evaluate() 纯确定裁决进退：
// 判据全 met ⇒ achieved；任一 violated ⇒ failed；有阻塞 ⇒ blocked；超步/超时 ⇒ aborted。
// 本器官不依赖任何兄弟器官（零运行时依赖），时间一律可注入（缺省 Date.now）。
// 铁律：绝不抛异常 —— 非法 spec 在构造期降级并记 blocker（见构造函数 JSDoc）。
/** goal 原文长度上限（纪元 Δ：goal 是状态锚点不是需求文档——超长文本会灌爆
 *  下游 prompt/日志/签名，构造期截断并记 blocker 留审计痕迹） */
const GOAL_MAX_CHARS = 2000;
/**
 * 目标状态机：把一份 GoalSpec 铸成纯确定的相变裁判。
 *
 * 相不落地存储 —— 恒由判定律从（判据账 / 阻塞账 / 步账 / 时间账）即时推导，
 * 故 progress.phase 与 evaluate().phase 永不陈旧、永不分歧。
 *
 * evaluate() 判定律（纯确定，按序短路，前者优先）：
 *  1. 任一判据 violated        ⇒ failed（显式失败坐实即终局，压过一切）
 *  2. 全部判据 met             ⇒ achieved（判据终局压过步数/时间预算）
 *  3. 已 begin 且 blockers 非空 ⇒ blocked（clearBlockers 后自动回归 acting）
 *  4. stepIndex ≥ maxSteps     ⇒ aborted（超步）
 *  5. elapsed > timeBudgetSec×1000 ⇒ aborted（超时，严格大于：恰等预算仍算在限内）
 *  6. 否则：未 begin ⇒ planning；已 begin ⇒ acting
 *
 * 降级律（绝不抛异常）：构造期不校验失败即抛错，而是——
 *  · spec 非对象 / goal 非字符串或为空：按空目标降级并记 blocker；
 *  · goal 超 2000 字符：截断至 2000 并记 blocker（「goal 截断」，纪元 Δ）；
 *  · successCriteria 为空（或剔除非法条目后为空）：把 goal 原文视作唯一一条
 *    字面判据并记 blocker —— 因此机器永远至少有 1 条判据，判定律永不空转；
 *  · maxSteps < 1（或非法）：降级为缺省 24 并记 blocker；
 *  · timeBudgetSec < 1（或非法）：降级为缺省 300 并记 blocker。
 * 注意：降级 blocker 记入常规阻塞账 —— begin 后机器会立即 blocked，
 * 由调用方人工确认后 clearBlockers() 放行（非法输入值得一次显式驻足）。
 */
export class GoalStateMachine {
    _goal;
    _failureCriteria;
    _maxSteps;
    _timeBudgetSec;
    _now;
    _criteria;
    _blockers;
    _begun = false;
    _startedAt = 0;
    _stepIndex = 0;
    _lastUpdateAt;
    /**
     * 构造一台目标状态机（绝不抛异常，非法 spec 按降级律处理并记 blocker）。
     * @param spec 目标规格（可传入任意垃圾 —— 非法字段逐项降级）
     * @param now  时钟注入（缺省 Date.now；非函数亦降级为 Date.now）
     */
    constructor(spec, now) {
        const blockers = [];
        let s;
        if (spec !== null && spec !== undefined && typeof spec === 'object') {
            s = spec;
        }
        else {
            s = {};
            blockers.push('spec 非法（非对象），已按空目标降级');
        }
        let goal = '';
        if (typeof s.goal === 'string') {
            goal = s.goal;
            if (goal.trim() === '')
                blockers.push('目标描述（goal）为空');
        }
        else {
            blockers.push('goal 非字符串，已按空目标降级');
        }
        // 纪元 Δ 器官层限长：构造期超 2000 字符截断并记 blocker（空判据降级的字面
        // 判据也用截断后的 goal——机器内部永不携带超长文本）
        if (goal.length > GOAL_MAX_CHARS) {
            blockers.push(`goal 截断：原文 ${goal.length} 字符超上限 ${GOAL_MAX_CHARS}，已截取前 ${GOAL_MAX_CHARS} 字符`);
            goal = goal.slice(0, GOAL_MAX_CHARS);
        }
        let criteria = [];
        if (Array.isArray(s.successCriteria)) {
            criteria = s.successCriteria.filter(c => typeof c === 'string' && c.trim() !== '');
            if (criteria.length !== s.successCriteria.length) {
                blockers.push('successCriteria 含非法条目，已剔除');
            }
        }
        else if (s.successCriteria !== undefined) {
            blockers.push('successCriteria 非数组，已忽略');
        }
        if (criteria.length === 0) {
            // 降级律核心：空判据化身一条字面 goal 判据（机器保证 ≥1 条判据）
            criteria = [goal];
            blockers.push('成功判据为空，已降级为以目标原文为唯一判据');
        }
        let maxSteps = 24;
        if (s.maxSteps !== undefined) {
            if (typeof s.maxSteps === 'number' && Number.isFinite(s.maxSteps) && s.maxSteps >= 1) {
                maxSteps = s.maxSteps;
            }
            else {
                blockers.push(`maxSteps 非法（${String(s.maxSteps)}），已降级为缺省 24`);
            }
        }
        let timeBudgetSec = 300;
        if (s.timeBudgetSec !== undefined) {
            if (typeof s.timeBudgetSec === 'number' && Number.isFinite(s.timeBudgetSec) && s.timeBudgetSec >= 1) {
                timeBudgetSec = s.timeBudgetSec;
            }
            else {
                blockers.push(`timeBudgetSec 非法（${String(s.timeBudgetSec)}），已降级为缺省 300`);
            }
        }
        this._goal = goal;
        this._failureCriteria = Array.isArray(s.failureCriteria)
            ? s.failureCriteria.filter(f => typeof f === 'string' && f.trim() !== '')
            : [];
        this._maxSteps = maxSteps;
        this._timeBudgetSec = timeBudgetSec;
        this._criteria = criteria.map(criterion => ({ criterion, status: 'unverified' }));
        this._blockers = blockers; // 降级 blocker 记入常规阻塞账（见类 JSDoc 注意项）
        this._now = typeof now === 'function' ? now : () => Date.now();
        this._lastUpdateAt = this.nowSafe();
    }
    /** 时钟安全读取：注入的 now 抛异常或返回非有限数时归 0（绝不外抛）。 */
    nowSafe() {
        try {
            const t = this._now();
            return typeof t === 'number' && Number.isFinite(t) ? t : 0;
        }
        catch {
            return 0;
        }
    }
    /** 已执行时长（毫秒）：未 begin 恒为 0；负时钟夹回 0。 */
    elapsedMs() {
        if (!this._begun)
            return 0;
        return Math.max(0, this.nowSafe() - this._startedAt);
    }
    /** 判定律本体（纯函数，见类 JSDoc 的六条有序规则）。 */
    computePhase() {
        const total = this._criteria.length;
        const met = this._criteria.filter(c => c.status === 'met').length;
        for (let i = 0; i < this._criteria.length; i++) {
            if (this._criteria[i].status === 'violated') {
                const snippet = this._criteria[i].criterion.slice(0, 24);
                return { phase: 'failed', reason: `第 ${i + 1} 条判据「${snippet}」已被违反，目标失败。` };
            }
        }
        if (total > 0 && met === total) {
            return { phase: 'achieved', reason: `全部 ${total} 条成功判据均已达成，目标达成。` };
        }
        if (this._begun && this._blockers.length > 0) {
            return { phase: 'blocked', reason: `执行被 ${this._blockers.length} 项阻塞：${this._blockers.join('；')}。` };
        }
        if (this._stepIndex >= this._maxSteps) {
            return { phase: 'aborted', reason: `已用 ${this._stepIndex} 步达到步数上限 ${this._maxSteps} 步，判定中止。` };
        }
        const elapsed = this.elapsedMs();
        const budgetMs = this._timeBudgetSec * 1000;
        if (elapsed > budgetMs) {
            return { phase: 'aborted', reason: `耗时 ${elapsed}ms 超出时间预算 ${budgetMs}ms，判定中止。` };
        }
        if (!this._begun) {
            return { phase: 'planning', reason: '尚未 begin()，处于规划阶段。' };
        }
        return { phase: 'acting', reason: `执行中：已用 ${this._stepIndex}/${this._maxSteps} 步，判据达成 ${met}/${total}。` };
    }
    /** 生效规格（防御性副本：数组深拷贝，外部篡改不透内部；failureCriteria 为空时键不出现）。 */
    get spec() {
        const out = {
            goal: this._goal,
            successCriteria: this._criteria.map(c => c.criterion),
            maxSteps: this._maxSteps,
            timeBudgetSec: this._timeBudgetSec,
        };
        if (this._failureCriteria.length > 0)
            out.failureCriteria = [...this._failureCriteria];
        return out;
    }
    /** 进度快照（防御性深拷贝：判据对象逐条新建、数组全新 —— 外部改副本不影响内部）。 */
    get progress() {
        return {
            phase: this.computePhase().phase,
            stepIndex: this._stepIndex,
            criteriaStatus: this._criteria.map(c => ({ criterion: c.criterion, status: c.status })),
            startedAt: this._startedAt,
            lastUpdateAt: this._lastUpdateAt,
            blockers: [...this._blockers],
        };
    }
    /** 进入执行生命周期：planning → acting，startedAt 记时（重复调用幂等无害）。 */
    begin() {
        if (this._begun)
            return;
        this._begun = true;
        const t = this.nowSafe();
        this._startedAt = t;
        this._lastUpdateAt = t;
    }
    /** 步账 +1（仅当前判定相为 acting 时生效；planning/blocked/终局相均为静默空转）。 */
    tick() {
        if (this.computePhase().phase !== 'acting')
            return;
        this._stepIndex += 1;
        this._lastUpdateAt = this.nowSafe();
    }
    /** 记单条判据核对结果（越界索引 / 非法状态静默忽略，绝不抛）。 */
    recordCriterion(index, status) {
        if (!Number.isInteger(index) || index < 0 || index >= this._criteria.length)
            return;
        if (status !== 'met' && status !== 'violated')
            return;
        this._criteria[index] = { criterion: this._criteria[index].criterion, status };
        this._lastUpdateAt = this.nowSafe();
    }
    /** 全部判据一齐置位（终局便捷通道：met ⇒ achieved / violated ⇒ failed）。 */
    recordAll(status) {
        if (status !== 'met' && status !== 'violated')
            return;
        this._criteria = this._criteria.map(c => ({ criterion: c.criterion, status }));
        this._lastUpdateAt = this.nowSafe();
    }
    /** 追加一条阻塞（空串/非字符串静默忽略）；阻塞使 acting 相转入 blocked。 */
    addBlocker(reason) {
        if (typeof reason !== 'string' || reason.trim() === '')
            return;
        this._blockers.push(reason);
        this._lastUpdateAt = this.nowSafe();
    }
    /** 清空阻塞账（blocked 相由此自动回归 acting —— 判定律纯推导，无需显式转相）。 */
    clearBlockers() {
        if (this._blockers.length === 0)
            return;
        this._blockers = [];
        this._lastUpdateAt = this.nowSafe();
    }
    /** 判定当前相并给出一句话中文理由（纯确定，见类 JSDoc 六条有序规则）。 */
    evaluate() {
        return this.computePhase();
    }
    /**
     * 导出锚点（供上层 prompt/日志直接嵌入的扁平快照）：
     * {phase, step_index, steps_budget, elapsed_ms, criteria:{met,total}, blockers}
     * （blockers 为副本；未 begin 时 elapsed_ms 恒 0）。
     */
    toAnchor() {
        const total = this._criteria.length;
        const met = this._criteria.filter(c => c.status === 'met').length;
        return {
            phase: this.computePhase().phase,
            step_index: this._stepIndex,
            steps_budget: this._maxSteps,
            elapsed_ms: this.elapsedMs(),
            criteria: { met, total },
            blockers: [...this._blockers],
        };
    }
}
