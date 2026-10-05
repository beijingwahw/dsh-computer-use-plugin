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
//  · ΑΩ-R17 档案有界律：库容上限（缺省 500，构造可调）—— 超限驱逐「最旧
//    已完成」（进行中永不驱逐；全在进行中 ⇒ 诚实跳过等待完成），被驱逐 run
//    的 resume_token 自然失效 —— 档案有界，老令牌过期是设计而非事故；
//    JSONL 以追加为主，驱逐累计达阈值（⌊上限/10⌋ 且 ≥1）时 tmp+rename 原子
//    重写压缩，重写后文件只含幸存档案快照行（type:'snapshot'，旧读方按垃圾
//    行静默忽略 —— 与断尾容忍读兼容）；驱逐/压缩计数经 dump() 审计可见。
// 铁律：公共方法绝不抛异常（内部异常吞掉并记 lastError）。
import { mkdirSync, readFileSync, renameSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync, } from 'fs';
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
/**
 * ΑΩ-R17 快照行防御式复活（压缩重写行的重放面）：逐字段净化，垃圾档 null 弃置
 * —— 判据账非法时回退 initialCriteria（全 unverified 的保守可续跑态，诚实降级）。
 */
function reviveRecord(from) {
    if (from === null || typeof from !== 'object')
        return null;
    const r = from;
    if (typeof r.token !== 'string' || r.token === '')
        return null;
    const goal = serializeGoal(r.goal);
    const startedAt = typeof r.startedAt === 'number' && Number.isFinite(r.startedAt) ? r.startedAt : 0;
    const updatedAt = typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : startedAt;
    const status = r.status === 'done' || r.status === 'failed' || r.status === 'aborted' || r.status === 'running'
        ? r.status
        : 'running';
    const trajectory = [];
    if (Array.isArray(r.trajectory)) {
        for (const item of r.trajectory) {
            if (item === null || typeof item !== 'object')
                continue;
            const s = item;
            const entry = {
                stepIndex: typeof s.stepIndex === 'number' && Number.isFinite(s.stepIndex)
                    ? Math.floor(s.stepIndex)
                    : trajectory.length,
                kind: typeof s.kind === 'string' && s.kind !== '' ? s.kind : 'unknown',
                outcome: typeof s.outcome === 'string' && s.outcome !== '' ? s.outcome : 'unknown',
                at: typeof s.at === 'number' && Number.isFinite(s.at) ? s.at : updatedAt,
            };
            if (typeof s.label === 'string' && s.label !== '')
                entry.label = s.label;
            trajectory.push(entry);
        }
    }
    const rec = {
        token: r.token,
        goal,
        startedAt,
        updatedAt,
        status,
        phase: typeof r.phase === 'string' && r.phase !== '' ? r.phase : 'planning',
        steps: trajectory.length,
        trajectory,
        criteriaStatus: sanitizeCriteria(r.criteriaStatus) ?? initialCriteria(goal),
    };
    if (typeof r.steps === 'number' && Number.isFinite(r.steps)) {
        rec.steps = Math.max(rec.steps, Math.floor(r.steps));
    }
    if (typeof r.summary === 'string')
        rec.summary = r.summary;
    return rec;
}
/** list() 返回条数上限（记账库不是档案库 —— 最近 50 次运行足矣） */
const LIST_CAP = 50;
/**
 * ΑΩ-R17 档案库容量上限缺省值：长驻进程 + 高频 run 下档案只增不减 ⇒ 内存 Map
 * 与 JSONL 双侧缓慢膨胀。500 档 × 每档数十步摘要 —— 有界且够回溯（list() 本就
 * 只示最近 50）；超限驱逐政策见 PilotStore 类注释。
 */
export const PILOT_MAX_RUNS = 500;
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
 *
 * ΑΩ-R17 档案有界律（驱逐政策 —— 诚实条款）：
 *  · 在库档数超过 maxRuns（缺省 500，构造 opts.maxRuns 可调）时，驱逐「最旧
 *    已完成」档（done/failed/aborted 按 startedAt 取最旧，token 字典序破平）；
 *  · 进行中（running）档案永不驱逐 —— 活跃血脉/跨进程可续跑态优先于容量；
 *    若超限时全在进行中 ⇒ 本次诚实跳过，待其 finish 后的下一个 begin/finish
 *    补驱（在库数可能短暂超限 —— 有界以完成为界，绝不驱逐活跃档来凑数）；
 *  · 被驱逐档的 resume_token 自然失效：档案有界，老令牌过期是设计而非事故
 *    （autonomy_resume 对失效 token 走既有「No pilot run found」诚实拒绝）；
 *  · 驱逐计数（dump().evicted）终身累计留痕，reset() 不清零。
 * 落盘压缩：驱逐只动内存；盘上死行（被逐档的旧行）累计达阈值（⌊maxRuns/10⌋
 * 且 ≥1）时 tmp+rename 原子重写 —— 重写后文件只含幸存档快照行，append 续脉
 * 不断；重写失败同降级律（永久内存 + lastError 留痕）。
 */
export class PilotStore {
    runs = new Map();
    filePath;
    diskEnabled;
    dirEnsured = false;
    _lastError = null;
    /** ΑΩ-R17 容量上限（构造可调；缺省 PILOT_MAX_RUNS） */
    maxRuns;
    /** ΑΩ-R17 压缩阈值：盘上死行累计达此数才重写（防每次驱逐都全量重写的抖动） */
    compactThreshold;
    /** ΑΩ-R17 累计驱逐档数（终身审计账） */
    _evicted = 0;
    /** ΑΩ-R17 累计压缩重写次数 */
    _compactions = 0;
    /** ΑΩ-R17 待压缩的盘上死行数（驱逐 +1，重写清零） */
    dropsSinceCompact = 0;
    /**
     * @param filePath JSONL 落盘路径：空/缺席 ⇒ 纯内存；非空 ⇒ 构造即重放铸态，
     *                 此后 begin/recordStep/finish 追加事件行。
     * @param opts     ΑΩ-R17 可选项：maxRuns 容量上限（非法值静默回缺省）。
     */
    constructor(filePath, opts) {
        this.filePath = typeof filePath === 'string' && filePath.trim() !== '' ? filePath : '';
        this.diskEnabled = this.filePath !== '';
        const rawMax = opts?.maxRuns;
        this.maxRuns =
            typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax >= 1
                ? Math.floor(rawMax)
                : PILOT_MAX_RUNS;
        this.compactThreshold = Math.max(1, Math.floor(this.maxRuns / 10));
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
    /** ΑΩ-R17 累计驱逐档数（终身审计账 —— reset 不清零：留痕是义务不是状态） */
    get evicted() {
        return this._evicted;
    }
    /** ΑΩ-R17 审计快照：容量/驱逐/压缩/降级一图流（只读账 —— 驱逐政策可见性条款） */
    dump() {
        return {
            total: this.runs.size,
            maxRuns: this.maxRuns,
            evicted: this._evicted,
            compactions: this._compactions,
            persistent: this.diskEnabled,
            lastError: this._lastError,
        };
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
            this.enforceCapacity(); // ΑΩ-R17：超限驱逐最旧已完成（新档 running 永不在驱逐候选）
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
            this.enforceCapacity(); // ΑΩ-R17：补驱此前因「全在进行中」诚实跳过的驱逐
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
    /**
     * 全部档案：startedAt 倒序（新者先），至多 50 条，深拷贝。
     * ΑΩ-R17：被驱逐档案不在列（load 亦 null —— 老令牌过期是设计而非事故；
     * 驱逐计数见 dump()）。
     */
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
    /**
     * 清空内存铸态（磁盘档案不删 —— 文件清理属宿主运维职权，存储面绝不做破坏性动作）。
     * ΑΩ-R17：驱逐/压缩计数为终身审计账，reset 不清零；待压缩死行计数随内存归零。
     */
    reset() {
        this.runs.clear();
        this._lastError = null;
        this.dirEnsured = false;
        this.dropsSinceCompact = 0;
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
        // ΑΩ-R17：重放可能超限（盘上死行未压缩 / 宿主调小 maxRuns）—— 重放毕即守恒
        this.enforceCapacity();
    }
    /**
     * ΠΑΝ-60（压缩不吞档）：并档 —— 重读盘面，把**内存账上没有的 token** 的
     * 快照档并入 this.runs（他进程并发追加的档案）。只补缺席：内存已有的 token
     * 以内存为准（本进程的最新账不回退）；读失败/垃圾行静默跳过（断尾容忍同
     * replay 律）。绝不抛。
     */
    mergeForeignDiskRecords() {
        try {
            const text = readFileSync(this.filePath, 'utf8');
            for (const raw of text.split('\n')) {
                const line = raw.trim();
                if (line === '')
                    continue;
                let ev;
                try {
                    ev = JSON.parse(line);
                }
                catch {
                    continue; // 断尾行容忍
                }
                if (ev === null || typeof ev !== 'object')
                    continue;
                const e = ev;
                if (e.type !== 'snapshot')
                    continue; // 追加事件行不并（属其属主的活跃账）
                const rec = reviveRecord(e.record);
                if (rec && !this.runs.has(rec.token))
                    this.runs.set(rec.token, rec);
            }
        }
        catch {
            // 读失败（他进程 rename 竞态窗等）⇒ 放弃本轮并档 —— 压缩体照旧铸造
            //（不吞自家档；他进程档至多晚一轮再并）
        }
    }
    /** 单事件铸态（垃圾事件静默忽略） */
    applyEvent(ev) {
        if (ev === null || typeof ev !== 'object')
            return;
        const e = ev;
        if (e.type === 'snapshot') {
            // ΑΩ-R17 压缩重写行：一行一档全量快照（reviveRecord 防御式净化）
            const rec = reviveRecord(e.record);
            if (rec)
                this.runs.set(rec.token, rec);
            return;
        }
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
    /** 追加事件行（目录一次保证；写失败 ⇒ 永久降级内存并留痕）
     * ΠΑΝ-60（写入原子性）：appendFileSync 改为显式 'a' 追加模式句柄 +
     * writeSync + fsyncSync —— 追加模式由内核保证写偏移的原子定位（Windows
     * 上 appendFileSync 的多次打开-写-关在同文件双进程并发时可交错撕裂行尾，
     * 单句柄单写调用 + fsync 把「整行原子落盘」钉死）；失败降级律不变。 */
    appendEvent(line) {
        if (!this.diskEnabled || this.filePath === '')
            return;
        try {
            if (!this.dirEnsured) {
                mkdirSync(path.dirname(this.filePath), { recursive: true });
                this.dirEnsured = true;
            }
            const chunk = Buffer.from(JSON.stringify(line) + '\n', 'utf8');
            const fd = openSync(this.filePath, 'a');
            try {
                writeSync(fd, chunk);
                fsyncSync(fd);
            }
            finally {
                closeSync(fd);
            }
        }
        catch (err) {
            // 降级律：磁盘故障 ⇒ 此后纯内存（内存档仍完整），错误留痕供运维取证
            this.diskEnabled = false;
            this._lastError = `append: ${errText(err)}`;
        }
    }
    /**
     * ΑΩ-R17 容量守卫：在库数超上限 ⇒ 逐档驱逐「最旧已完成」（进行中永不驱逐；
     * 全在进行中 ⇒ 诚实跳过 —— 有界以完成为界）。驱逐只动内存 + 计数；盘上
     * 死行累计达压缩阈值时原子重写。绝不抛异常。
     */
    enforceCapacity() {
        try {
            while (this.runs.size > this.maxRuns) {
                let victim;
                for (const rec of this.runs.values()) {
                    if (rec.status === 'running')
                        continue; // 活跃血脉/跨进程可续跑态优先于容量
                    if (!victim ||
                        rec.startedAt < victim.startedAt ||
                        (rec.startedAt === victim.startedAt && rec.token < victim.token)) {
                        victim = rec;
                    }
                }
                if (!victim)
                    break; // 全在进行中：诚实跳过，待完成后的 begin/finish 补驱
                this.runs.delete(victim.token);
                this._evicted++;
                this.dropsSinceCompact++;
            }
            if (this.dropsSinceCompact >= this.compactThreshold)
                this.compactFile();
        }
        catch (err) {
            this.noteError(err);
        }
    }
    /**
     * ΑΩ-R17 压缩重写：tmp + fsync + rename 原子换档（checkpoint.ts 同一原子写律）
     * —— 重写后文件只含幸存档快照行（startedAt 升序），与断尾容忍读兼容（快照
     * 行本身即完整行；旧读方对未知 type 按垃圾行静默忽略）。失败 ⇒ 同降级律：
     * 永久纯内存 + lastError 留痕（内存档与驱逐政策不受影响）。
     * ΠΑΝ-60（写入原子性）：压缩前先**并档** —— 重读盘面快照行，把本进程内存
     * 账上没有的 token（他进程并发追加的档案）并入内存后再铸压缩体。单进程视角
     * 的压缩重写自此不会吞掉他进程追加的事件（跨进程互斥锁不在本层立法面 ——
     * 并档把「丢档」降级为「晚一轮驱逐」，与容量驱逐的最终一致语义同向）。
     */
    compactFile() {
        if (!this.diskEnabled || this.filePath === '') {
            this.dropsSinceCompact = 0;
            return;
        }
        const tmp = this.filePath + '.tmp';
        try {
            if (!this.dirEnsured) {
                mkdirSync(path.dirname(this.filePath), { recursive: true });
                this.dirEnsured = true;
            }
            // ΠΑΝ-60：并档 —— 盘上存在而内存没有的 token（他进程追加）先入内存账
            this.mergeForeignDiskRecords();
            const body = [...this.runs.values()]
                .sort((a, b) => a.startedAt - b.startedAt || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0))
                .map(rec => JSON.stringify({ type: 'snapshot', record: copyRecord(rec) }))
                .join('\n');
            const text = body === '' ? '' : body + '\n';
            // fsync 落盘后再换名：崩溃后要么完整旧档要么完整新档，绝无半档（页缓存不算落盘）
            const fd = openSync(tmp, 'w');
            try {
                writeSync(fd, Buffer.from(text, 'utf8'));
                fsyncSync(fd);
            }
            finally {
                closeSync(fd);
            }
            renameSync(tmp, this.filePath);
            this.dropsSinceCompact = 0;
            this._compactions++;
        }
        catch (err) {
            try {
                unlinkSync(tmp);
            }
            catch {
                /* tmp 可能未创建 */
            }
            // 降级律（与 appendEvent 同源）：任何磁盘写失败 ⇒ 永久纯内存并留痕
            this.diskEnabled = false;
            this._lastError = `compact: ${errText(err)}`;
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
