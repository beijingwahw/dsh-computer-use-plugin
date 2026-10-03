// src/autonomy/pilotStore.ts
// 纪元 Σ（Σ-3 断点续跑）：自主环运行档案库 —— token → PilotRunRecord。
// autonomous_run 开环 begin 铸档（token='AUTO-'+8 位十六进制），每步入轨迹即
// recordStep 落轨迹摘要 + 判据账快照，终局 finish 定档（phase→status 映射）；
// autonomy_resume 凭 token load 同一档案复活铸态 —— 中断处续跑的血脉。
//
// 落盘律（与 config.autonomyTracePath 对偶）：
//  · 构造 filePath 空/缺席 ⇒ 纯内存 Map（缺省行为：不落盘，token 生命周期 = 进程）；
//  · 非空 ⇒ 追加式 JSONL：每行 {type:'begin'|'step'|'finish', ...}，构造时重放
//    铸态（跨进程续跑）；断尾行容忍（进程被杀的半行跳过，不炸重放）；
//  · 任何磁盘写失败 ⇒ 永久降级纯内存并记 lastError（内存档仍在 —— 磁盘故障
//    绝不炸自主环，只是失去跨进程续跑能力）。
// 铁律：公共方法绝不抛异常（内部异常吞掉并记 lastError）。
import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import path from 'path';
/** 异常归因为安全字符串（绝不二次抛出） */
function errText(err) {
    if (err instanceof Error)
        return err.message;
    try {
        const text = String(err);
        return text === '' ? '未知异常' : text;
    }
    catch {
        return '未知异常';
    }
}
/** 档案深拷贝（档案恒为 JSON 安全数据 —— JSON 往返即深拷贝；异常时原样返回不炸） */
function copyRecord(rec) {
    try {
        return JSON.parse(JSON.stringify(rec));
    }
    catch {
        return rec;
    }
}
/** GoalSpec（或任何 begin/JSONL 来源的疑似对象）防御式铸成可序列化 goal 快照 */
function serializeGoal(goal) {
    const g = (goal ?? {});
    const out = {
        goal: typeof g.goal === 'string' ? g.goal : '',
        successCriteria: Array.isArray(g.successCriteria)
            ? g.successCriteria.filter((c) => typeof c === 'string')
            : [],
    };
    const failure = Array.isArray(g.failureCriteria)
        ? g.failureCriteria.filter((f) => typeof f === 'string')
        : [];
    if (failure.length > 0)
        out.failureCriteria = failure;
    if (typeof g.maxSteps === 'number' && Number.isFinite(g.maxSteps))
        out.maxSteps = g.maxSteps;
    if (typeof g.timeBudgetSec === 'number' && Number.isFinite(g.timeBudgetSec)) {
        out.timeBudgetSec = g.timeBudgetSec;
    }
    return out;
}
/** 判据账防御式净化（非法条目剔除；非数组 ⇒ null 表示不可用） */
function sanitizeCriteria(from) {
    if (!Array.isArray(from))
        return null;
    const out = [];
    for (const item of from) {
        if (item === null || typeof item !== 'object')
            continue;
        const c = item;
        if (typeof c.criterion !== 'string' || c.criterion === '')
            continue;
        if (c.status !== 'unverified' && c.status !== 'met' && c.status !== 'violated')
            continue;
        out.push({ criterion: c.criterion, status: c.status });
    }
    return out;
}
/** 铸档初始判据账：successCriteria 逐条 unverified（空数组原样 —— 重铸时 GoalStateMachine 自行降级） */
function initialCriteria(goal) {
    const g = (goal ?? {});
    const criteria = Array.isArray(g.successCriteria)
        ? g.successCriteria.filter((c) => typeof c === 'string' && c.trim() !== '')
        : [];
    return criteria.map(criterion => ({ criterion, status: 'unverified' }));
}
/** 终局相位 → 档案状态映射：achieved ⇒ done；failed ⇒ failed；aborted/blocked ⇒ aborted（可续跑）；其余保持 running */
function statusForPhase(phase) {
    if (phase === 'achieved')
        return 'done';
    if (phase === 'failed')
        return 'failed';
    if (phase === 'aborted' || phase === 'blocked')
        return 'aborted';
    return 'running';
}
/** list() 返回条数上限（记账库不是档案库 —— 最近 50 次运行足矣） */
const LIST_CAP = 50;
/**
 * 自主环运行档案库（断点续跑的存储面）。
 *
 * 生命周期：begin（铸档 running）→ recordStep×N（轨迹摘要 + 判据账快照）→
 * finish（终局定档）。load/list 返回防御性深拷贝 —— 外部篡改不透档案。
 *
 * 判据账时效性说明：步级快照在 onStep 时刻摄取 —— 该步的 criteriaEvidence 由
 * 闭环在此之后才回填目标机，故第 N 步行携带的是「第 N-1 步证据后」的账面；
 * 终局 finish 携带最终全量账（若有传）。进程被杀（finish 未达）时，续跑回放
 * 至多缺失最后一StepRecord 的证据 —— 诚实降级，绝不谎报。
 */
export class PilotStore {
    runs = new Map();
    filePath;
    diskEnabled;
    dirEnsured = false;
    _lastError = null;
    /**
     * @param filePath JSONL 落盘路径：空/缺席 ⇒ 纯内存；非空 ⇒ 构造即重放铸态，
     *                 此后 begin/recordStep/finish 追加事件行。
     */
    constructor(filePath) {
        this.filePath = typeof filePath === 'string' && filePath.trim() !== '' ? filePath : '';
        this.diskEnabled = this.filePath !== '';
        if (this.diskEnabled)
            this.replay();
    }
    /** 最近一次磁盘故障（降级取证；null = 无故障） */
    get lastError() {
        return this._lastError;
    }
    /** 磁盘镜像是否仍在工作（降级后 false —— 纯内存） */
    get persistent() {
        return this.diskEnabled;
    }
    /**
     * 铸档：新 token + running 状态 + 判据账全 unverified。
     * @param goal 目标规格（铸 GoalStateMachine 的同一份原料）
     * @param now  注入时钟（缺省 Date.now）
     * @returns token（'AUTO-' + randomBytes(4).hex；撞号重铸 —— 概率天文级小但零成本防御）
     */
    begin(goal, now) {
        try {
            let token = '';
            do {
                token = 'AUTO-' + randomBytes(4).toString('hex');
            } while (this.runs.has(token));
            const t = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
            const goalSnap = serializeGoal(goal);
            const record = {
                token,
                goal: goalSnap,
                startedAt: t,
                updatedAt: t,
                status: 'running',
                phase: 'planning',
                steps: 0,
                trajectory: [],
                criteriaStatus: initialCriteria(goal),
            };
            this.runs.set(token, record);
            this.appendEvent({ type: 'begin', token, goal: copyShallowGoal(goalSnap), startedAt: t });
            return token;
        }
        catch (err) {
            this.noteError(err);
            return 'AUTO-ERROR';
        }
    }
    /**
     * 步级落账：轨迹摘要入档 + 判据账快照整账替换 + steps 前滚。
     * 未知 token 静默忽略（绝不抛）。
     * @param step            可序列化步摘要原料（action.target.label 可选）
     * @param criteriaStatus  判据账全量快照（非法输入 ⇒ 沿用档内旧账）
     */
    recordStep(token, step, criteriaStatus) {
        try {
            const rec = this.runs.get(token);
            if (!rec)
                return;
            const s = step ?? {};
            const summary = {
                stepIndex: typeof s.stepIndex === 'number' && Number.isFinite(s.stepIndex)
                    ? Math.floor(s.stepIndex)
                    : rec.trajectory.length,
                kind: typeof s.action?.kind === 'string' && s.action.kind !== '' ? s.action.kind : 'unknown',
                outcome: typeof s.outcome === 'string' && s.outcome !== '' ? s.outcome : 'unknown',
                at: typeof s.at === 'number' && Number.isFinite(s.at) ? s.at : Date.now(),
            };
            const label = s.action?.target?.label;
            if (typeof label === 'string' && label !== '')
                summary.label = label;
            this.applyStep(rec, summary, sanitizeCriteria(criteriaStatus));
            this.appendEvent({
                type: 'step',
                token,
                step: { ...summary },
                criteriaStatus: copyCriteria(rec.criteriaStatus),
            });
        }
        catch (err) {
            this.noteError(err);
        }
    }
    /**
     * 终局定档：phase/summary/status 落账（status 由 phase 映射，见 statusForPhase）。
     * 非终局相位（如审批中断的 acting）亦合法落账 —— 映射为 running，档案可续跑。
     * @param criteriaStatus 终局判据账全量（可选；传入则整账替换 —— 续跑回放的权威源）
     */
    finish(token, phase, summary, now, criteriaStatus) {
        try {
            const rec = this.runs.get(token);
            if (!rec)
                return;
            const t = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
            if (typeof phase === 'string' && phase !== '')
                rec.phase = phase;
            if (typeof summary === 'string')
                rec.summary = summary;
            rec.status = statusForPhase(rec.phase);
            rec.updatedAt = t;
            const cs = criteriaStatus === undefined ? null : sanitizeCriteria(criteriaStatus);
            if (cs)
                rec.criteriaStatus = cs;
            const line = {
                type: 'finish',
                token,
                phase: rec.phase,
                summary: rec.summary ?? '',
                status: rec.status,
                steps: rec.steps,
                at: t,
                ...(cs ? { criteriaStatus: copyCriteria(cs) } : {}),
            };
            this.appendEvent(line);
        }
        catch (err) {
            this.noteError(err);
        }
    }
    /** 按 token 取档案（防御性深拷贝；无档 ⇒ null） */
    load(token) {
        const rec = typeof token === 'string' ? this.runs.get(token) : undefined;
        return rec ? copyRecord(rec) : null;
    }
    /** 全部档案：startedAt 倒序（新者先），至多 50 条，深拷贝 */
    list() {
        try {
            return [...this.runs.values()]
                .sort((a, b) => b.startedAt - a.startedAt || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0))
                .slice(0, LIST_CAP)
                .map(copyRecord);
        }
        catch (err) {
            this.noteError(err);
            return [];
        }
    }
    /** 清空内存铸态（磁盘档案不删 —— 文件清理属宿主运维职权，存储面绝不做破坏性动作） */
    reset() {
        this.runs.clear();
        this._lastError = null;
        this.dirEnsured = false;
    }
    // ─── 内部机制 ───
    /** 步落账共用核（在线 recordStep 与重放 applyEvent 同一语义） */
    applyStep(rec, summary, criteria) {
        rec.trajectory.push(summary);
        rec.steps = rec.trajectory.length;
        rec.updatedAt = summary.at;
        if (criteria)
            rec.criteriaStatus = criteria;
    }
    /** 构造期重放：读 JSONL → 逐行铸态（文件不存在 = 空库首用，合法态） */
    replay() {
        let text;
        try {
            text = readFileSync(this.filePath, 'utf8');
        }
        catch (err) {
            const code = err?.code;
            if (code !== 'ENOENT') {
                this.diskEnabled = false;
                this._lastError = `replay: ${errText(err)}`;
            }
            return;
        }
        for (const raw of text.split('\n')) {
            const line = raw.trim();
            if (line === '')
                continue;
            let ev;
            try {
                ev = JSON.parse(line);
            }
            catch {
                continue; // 断尾行容忍（进程被杀的半行）—— 之前的完整行照常铸态
            }
            this.applyEvent(ev);
        }
    }
    /** 单事件铸态（垃圾事件静默忽略） */
    applyEvent(ev) {
        if (ev === null || typeof ev !== 'object')
            return;
        const e = ev;
        if (e.type === 'begin' && typeof e.token === 'string') {
            const startedAt = typeof e.startedAt === 'number' && Number.isFinite(e.startedAt) ? e.startedAt : 0;
            const goalSnap = serializeGoal(e.goal);
            this.runs.set(e.token, {
                token: e.token,
                goal: goalSnap,
                startedAt,
                updatedAt: startedAt,
                status: 'running',
                phase: 'planning',
                steps: 0,
                trajectory: [],
                criteriaStatus: initialCriteria(e.goal),
            });
            return;
        }
        if (e.type === 'step' && typeof e.token === 'string') {
            const rec = this.runs.get(e.token);
            if (!rec)
                return;
            const s = (e.step ?? {});
            const summary = {
                stepIndex: typeof s.stepIndex === 'number' && Number.isFinite(s.stepIndex)
                    ? s.stepIndex
                    : rec.trajectory.length,
                kind: typeof s.kind === 'string' ? s.kind : 'unknown',
                outcome: typeof s.outcome === 'string' ? s.outcome : 'unknown',
                at: typeof s.at === 'number' && Number.isFinite(s.at) ? s.at : rec.updatedAt,
            };
            if (typeof s.label === 'string' && s.label !== '')
                summary.label = s.label;
            this.applyStep(rec, summary, sanitizeCriteria(e.criteriaStatus));
            return;
        }
        if (e.type === 'finish' && typeof e.token === 'string') {
            const rec = this.runs.get(e.token);
            if (!rec)
                return;
            if (typeof e.phase === 'string' && e.phase !== '')
                rec.phase = e.phase;
            if (typeof e.summary === 'string')
                rec.summary = e.summary;
            rec.status =
                e.status === 'done' || e.status === 'failed' || e.status === 'aborted' || e.status === 'running'
                    ? e.status
                    : statusForPhase(rec.phase);
            if (typeof e.steps === 'number' && Number.isFinite(e.steps)) {
                rec.steps = Math.max(rec.steps, Math.floor(e.steps));
            }
            if (typeof e.at === 'number' && Number.isFinite(e.at))
                rec.updatedAt = e.at;
            const cs = sanitizeCriteria(e.criteriaStatus);
            if (cs)
                rec.criteriaStatus = cs;
            return;
        }
    }
    /** 追加事件行（目录一次保证；写失败 ⇒ 永久降级内存并留痕） */
    appendEvent(line) {
        if (!this.diskEnabled || this.filePath === '')
            return;
        try {
            if (!this.dirEnsured) {
                mkdirSync(path.dirname(this.filePath), { recursive: true });
                this.dirEnsured = true;
            }
            appendFileSync(this.filePath, JSON.stringify(line) + '\n', 'utf8');
        }
        catch (err) {
            // 降级律：磁盘故障 ⇒ 此后纯内存（内存档仍完整），错误留痕供运维取证
            this.diskEnabled = false;
            this._lastError = `append: ${errText(err)}`;
        }
    }
    /** 内部异常留痕（绝不外抛） */
    noteError(err) {
        this._lastError = errText(err);
    }
}
/** goal 快照浅拷贝（数组复制 —— 事件行序列化前的防御） */
function copyShallowGoal(goal) {
    const out = {
        goal: goal.goal,
        successCriteria: [...goal.successCriteria],
    };
    if (goal.failureCriteria !== undefined)
        out.failureCriteria = [...goal.failureCriteria];
    if (goal.maxSteps !== undefined)
        out.maxSteps = goal.maxSteps;
    if (goal.timeBudgetSec !== undefined)
        out.timeBudgetSec = goal.timeBudgetSec;
    return out;
}
/** 判据账深拷贝 */
function copyCriteria(from) {
    return from.map(c => ({ criterion: c.criterion, status: c.status }));
}
