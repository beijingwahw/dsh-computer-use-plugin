// src/recoveryEfficacy.ts
// ─── W2-5（R5 恢复策略疗效归因）：恢复回合划定 + Beta-Bernoulli 疗效表 ───
//
// 递进式恢复梯子（1 败教放大、2 败教换模态）是一套**从不看疗效**的固定处方：
// 它不知道「这个症候群里放大从来没有救回来过」。本模块给恢复动作记疗效账：
//
//   回合划定  从熔断/失败事件到其后 N 动作内的**首个成功**划为一个恢复回合；
//             边界由注入事件流（生产：circuitBreakerGuard 逐事件喂入）或
//             journal 回放（recoveryEventsFromJournal）判定 —— 纯状态机，
//             零墙钟依赖，离线可测。
//   疗效表    (症候签名 × 根因 × 恢复动作) 三元组各维护一册 Beta(1,1) 后验
//             账（复用熔断层 R-3 的 Beta-Bernoulli 机件风格：先验 Beta(1,1)、
//             后验均值 = (s+1)/(s+f+2)）。
//   排序律    样本量 n ≥ 5（该症候×根因语境合计）⇒ 后验均值降序动态排序；
//             n < 5 ⇒ 固定冷启动梯子（RECOVERY_COLD_LADDER，与熔断器历史
//             递进提示逐字节等价 —— 零回归承诺）。
//
// 设计立场（后验均值排序，而非 Thompson 采样）：**确定性**。处方可审计、
// 可回放（同账本 ⇒ 同排序），测试离线确定性（无 RNG 依赖）—— 与本项目
// 「规则可审计、证据可回放」的一贯律一致。探索由两处免费供给：冷启动梯子
// 本身（n<5 期间按固定序探索）与世界自身（失败之后的动作流天然遍历各动作）。
// Thompson 的优势（在线对抗性探索）在「世界不是对手、样本稀疏、需要可复现
// 处方」的场景不抵其随机性代价。
//
// 防御纪律（铁律）：一切公开入口绝不抛 —— 事件喂入/落盘/恢复/查询的任何
// 意外都以「跳过该事件 / 返回先验 / 返回错误对象」收口。持久化自带原子写
// （tmp + fsync + rename，checkpoint.ts 同律），**不碰 checkpoint.ts**：
// 本模块是独立器官，宿主按需接线（setPersistence / persist / restore）。
import { existsSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, mkdirSync, unlinkSync, } from 'fs';
import path from 'path';
import { parseRootCause, parseRecoveryAction, RECOVERY_ACTION_IDS, RECOVERY_COLD_LADDER, recoveryLadderFor, ROOT_CAUSE_IDS as ROOT_CAUSE_IDS_FILE, } from './diagnosis.js';
// ── W2-5：划界常量（值即边界 —— 不引入新旋钮的消费面）──
/** 恢复回合窗口：失败/熔断事件后 N 个动作内出现首个成功 ⇒ 回合「恢复成功」 */
export const RECOVERY_WINDOW_DEFAULT = 5;
/** 动态排序的样本闸：该 (症候×根因) 语境合计观察数 ≥ 此值才改排序（缺省梯子兜底） */
export const RECOVERY_MIN_SAMPLES = 5;
/** 疗效表容量上限（LRU 驱逐 —— 症候×根因×动作组合爆炸的有界承诺） */
const MAX_CELLS_DEFAULT = 512;
/** 最近回合环容量（快照的可观测面） */
const RECENT_EPISODES = 32;
/** 持久化格式版本 */
const EFFICACY_VERSION = 1;
/** 单侧计数的合法上限（防御恢复：垃圾巨值不淹没后验） */
const MAX_COUNT = 1_000_000;
// W6-2（doctor smell.over-engineering 清偿）：症候签名面 → recoveryEfficacy.syndromes.ts、
// 事件与回合结构（纯类型）→ recoveryEfficacy.contracts.ts（行为零变化）；导入面不变 —— 再分发。
import { RECOVERY_SYNDROME_IDS, parseRecoverySyndrome, classifySyndromeSignature, classifyRecoveryAction } from './recoveryEfficacy.syndromes.js';
export { RECOVERY_SYNDROME_IDS, parseRecoverySyndrome, classifySyndromeSignature, classifyRecoveryAction } from './recoveryEfficacy.syndromes.js';
// ── W2-5：回合划定状态机（demarcate 纯函数与增量 tracker 共用同一机芯）──
//
// 语义（一次一个事件，角色唯一 —— 无双重记账）：
//   failure  无回合 ⇒ 开回合（携带症候签名/根因/开下标）；
//            有回合 ⇒ 回合内一次失败尝试（可记名动作 ⇒ 失败观察），消耗窗位；
//            窗位耗尽 ⇒ 本回合以 timeout 闭合（该事件只当尝试，不当新开回合 ——
//            单事件单角色，避免同一失败既算旧回合尝试又算新回合 opener）
//   success  有回合 ⇒ 首个成功：成功观察 + 回合以 recovered 闭合；
//            无回合 ⇒ 忽略（日常成功不是任何回合的恢复）
//   unknown  有回合 ⇒ 消耗窗位、不产生观察（不可判定的动作诚实弃权）；
//            窗位耗尽 ⇒ timeout 闭合；无回合 ⇒ 忽略
class EpisodeScanner {
    open = null;
    window;
    constructor(window) {
        this.window = window;
    }
    step(ev, index) {
        const at = typeof ev.at === 'number' && Number.isFinite(ev.at) ? ev.at : null;
        if (!this.open) {
            if (ev.kind === 'failure') {
                this.open = {
                    syndrome: classifySyndromeSignature(ev.symptom, ev.tool),
                    rootCause: parseRootCause(ev.rootCause),
                    openIndex: index,
                    openedAt: at,
                    remaining: this.window,
                    observations: [],
                    unclassified: 0,
                };
            }
            return null;
        }
        const o = this.open;
        o.remaining -= 1;
        const action = classifyRecoveryAction(ev.tool);
        if (ev.kind === 'success') {
            if (action)
                o.observations.push({ tool: ev.tool, action, success: true });
            else
                o.unclassified += 1;
            return this.close('recovered', index, at);
        }
        if (action)
            o.observations.push({ tool: ev.tool, action, success: false });
        else
            o.unclassified += 1;
        if (o.remaining <= 0)
            return this.close('timeout', index, at);
        return null;
    }
    /** 流尽冲刷：未决回合如实上报 open（closeIndex null —— 不虚构结局） */
    flush() {
        if (!this.open)
            return null;
        const o = this.open;
        const rec = {
            syndrome: o.syndrome, rootCause: o.rootCause, outcome: 'open',
            openIndex: o.openIndex, closeIndex: null, openedAt: o.openedAt, closedAt: null,
            window: this.window, observations: [...o.observations], unclassifiedActions: o.unclassified,
        };
        this.open = null;
        return rec;
    }
    close(outcome, index, at) {
        const o = this.open;
        this.open = null;
        return {
            syndrome: o.syndrome, rootCause: o.rootCause, outcome,
            openIndex: o.openIndex, closeIndex: index, openedAt: o.openedAt, closedAt: at,
            window: this.window, observations: [...o.observations], unclassifiedActions: o.unclassified,
        };
    }
    /** 当前未决回合的只读投照（可观测面 —— 无回合 ⇒ null） */
    current() {
        return this.open
            ? { syndrome: this.open.syndrome, rootCause: this.open.rootCause, openIndex: this.open.openIndex }
            : null;
    }
}
/** 事件防御归一（垃圾事件 ⇒ unknown-kind 事件或缺席字段缺省 —— 绝不因输入抛） */
function coerceEvent(raw) {
    const e = (raw && typeof raw === 'object' ? raw : {});
    const kind = e.kind === 'failure' || e.kind === 'success' ? e.kind : 'unknown';
    const tool = typeof e.tool === 'string' ? e.tool.slice(0, 80) : '';
    const out = { kind, tool };
    if (typeof e.symptom === 'string')
        out.symptom = e.symptom.slice(0, 160);
    if (e.rootCause !== undefined)
        out.rootCause = e.rootCause;
    if (typeof e.at === 'number' && Number.isFinite(e.at))
        out.at = e.at;
    return out;
}
const clampWindow = (w) => Number.isFinite(w) ? Math.min(50, Math.max(1, Math.round(w))) : RECOVERY_WINDOW_DEFAULT;
/**
 * W2-5 回合划定（纯函数、确定性）：事件流 → 回合列表。
 * 消费面：测试直接注入假事件流；生产回放走 recoveryEventsFromJournal。
 * 末尾未决回合以 outcome 'open' 如实上报（不虚构 timeout）。
 */
export function demarcateRecoveryEpisodes(events, window = RECOVERY_WINDOW_DEFAULT) {
    const scanner = new EpisodeScanner(clampWindow(window));
    const out = [];
    for (let i = 0; i < events.length; i++) {
        const rec = scanner.step(coerceEvent(events[i]), i);
        if (rec)
            out.push(rec);
    }
    const tail = scanner.flush();
    if (tail)
        out.push(tail);
    return out;
}
/**
 * W2-5：journal 回放通道 —— 行动日志条目 → 疗效事件流。
 * status 'FAILED' ⇒ failure、'SUCCESS' ⇒ success、其余 ⇒ unknown（消耗窗位）；
 * GUARD_BLOCKED 标记（tool='GUARD_BLOCKED'）⇒ 熔断失败事件（回合可从熔断
 * 事件起算）。journal 不载症状/病因文本 ⇒ 症候签名走工具族缺省、根因
 * unknown —— 诚实的有损回放，不虚构证据。
 */
export function recoveryEventsFromJournal(entries) {
    const out = [];
    for (const e of Array.isArray(entries) ? entries : []) {
        if (!e || typeof e !== 'object')
            continue;
        const tool = typeof e.tool === 'string' ? e.tool : '';
        const status = typeof e.status === 'string' ? e.status : '';
        const at = typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : undefined;
        if (tool === 'GUARD_BLOCKED') {
            const guard = e.args?.guard;
            out.push({
                kind: 'failure', tool: String(guard ?? 'guard'),
                symptom: `circuit-breaker: guard ${String(guard ?? '?')} blocked`,
                ...(at !== undefined ? { at } : {}),
            });
            continue;
        }
        const kind = status === 'FAILED' ? 'failure' : status === 'SUCCESS' ? 'success' : 'unknown';
        out.push({ kind, tool, ...(at !== undefined ? { at } : {}) });
    }
    return out;
}
// ── W2-5：疗效账本（Beta(1,1) 后验 —— R-3 熔断双臂同款机件风格）──
const cellKey = (s, r, a) => `${s}\u001f${r}\u001f${a}`;
/** Beta(1,1) 后验均值：(s+1)/(s+f+2)（先验不越数据 —— 与 posteriorTripProbability 的 f+1/s+1 同律） */
export function recoveryPosteriorMean(successes, failures) {
    const s = Math.max(0, Math.floor(successes));
    const f = Math.max(0, Math.floor(failures));
    return (s + 1) / (s + f + 2);
}
/**
 * W2-5 疗效账本：回合喂入 + Beta 记账 + 动态处方排序 + 原子持久化。
 * 一切公开方法绝不抛（防御纪律）；失败的成本是「这一笔没记上 / 返回先验」，
 * 绝不是异常穿越调用方。
 */
export class RecoveryEfficacy {
    cells = new Map();
    episodes = [];
    scanner;
    totals = { recovered: 0, timedOut: 0, observations: 0 };
    tick = 0;
    eventIndex = 0;
    persistPath = null;
    window;
    minSamples;
    maxCells;
    constructor(opts = {}) {
        this.window = clampWindow(opts.window);
        this.minSamples = Number.isFinite(opts.minSamples)
            ? Math.min(100, Math.max(1, Math.round(opts.minSamples)))
            : RECOVERY_MIN_SAMPLES;
        this.maxCells = Number.isFinite(opts.maxCells)
            ? Math.min(10_000, Math.max(8, Math.round(opts.maxCells)))
            : MAX_CELLS_DEFAULT;
        this.scanner = new EpisodeScanner(this.window);
    }
    /** 喂入一个事件；若某回合因此闭合 ⇒ 返回该回合（否则 null）。绝不抛。 */
    ingest(event) {
        try {
            const closed = this.scanner.step(coerceEvent(event), this.eventIndex++);
            if (closed)
                this.commit(closed);
            return closed;
        }
        catch {
            return null; // 状态机本体是纯数据操作 —— 此兜底是「绝不抛」的字面兑现
        }
    }
    /** 当前未决回合（可观测面；无回合 ⇒ null） */
    currentEpisode() {
        return this.scanner.current();
    }
    /**
     * 处方排序：该 (症候 × 根因) 语境下的动作全序。
     * n < minSamples ⇒ 冷启动梯子在前（RECOVERY_COLD_LADDER —— 熔断器历史
     * 递进提示的名词化，零回归）；n ≥ minSamples ⇒ 后验均值降序，平手按
     * ROOT_CAUSE_LADDER 先验序（确定性 —— 同账本同排序，可审计可回放）。
     */
    prescriptionOrder(syndrome, rootCause) {
        try {
            const syn = parseRecoverySyndrome(syndrome);
            const rc = parseRootCause(rootCause);
            const ladder = recoveryLadderFor(rc);
            const n = RECOVERY_ACTION_IDS.reduce((acc, a) => {
                const c = this.cells.get(cellKey(syn, rc, a));
                return acc + (c ? c.successes + c.failures : 0);
            }, 0);
            if (n < this.minSamples) {
                // 冷启动：固定梯子打头，其余按根因先验序补全（全序 —— 消费方按下标取）
                return [...RECOVERY_COLD_LADDER, ...ladder.filter(a => !RECOVERY_COLD_LADDER.includes(a))];
            }
            return [...RECOVERY_ACTION_IDS].sort((a, b) => {
                const ca = this.cells.get(cellKey(syn, rc, a));
                const cb = this.cells.get(cellKey(syn, rc, b));
                const ma = recoveryPosteriorMean(ca?.successes ?? 0, ca?.failures ?? 0);
                const mb = recoveryPosteriorMean(cb?.successes ?? 0, cb?.failures ?? 0);
                if (ma !== mb)
                    return mb - ma;
                return ladder.indexOf(a) - ladder.indexOf(b); // 确定性平手序
            });
        }
        catch {
            return [...RECOVERY_COLD_LADDER]; // 防御兜底：先验序（绝不抛的字面兑现）
        }
    }
    /** 读单格（缺席 ⇒ null —— 调用方以先验解读） */
    cell(syndrome, rootCause, action) {
        const syn = parseRecoverySyndrome(syndrome);
        const rc = parseRootCause(rootCause);
        const act = parseRecoveryAction(action);
        if (!act)
            return null;
        const c = this.cells.get(cellKey(syn, rc, act));
        return c ? { syndrome: c.syndrome, rootCause: c.rootCause, action: c.action, successes: c.successes, failures: c.failures } : null;
    }
    /** 疗效表快照（metrics / doctor 消费面 —— 只读投影，键序确定） */
    snapshot() {
        const cells = [...this.cells.values()]
            .sort((a, b) => a.syndrome < b.syndrome ? -1 : a.syndrome > b.syndrome ? 1
            : a.rootCause < b.rootCause ? -1 : a.rootCause > b.rootCause ? 1
                : a.action < b.action ? -1 : 1)
            .map(c => {
            const { lru: _lru, ...cell } = c;
            return { ...cell, n: cell.successes + cell.failures, posteriorMean: Math.round(recoveryPosteriorMean(cell.successes, cell.failures) * 1e6) / 1e6 };
        });
        return {
            cells,
            episodes: [...this.episodes],
            totals: { ...this.totals },
            window: this.window,
            minSamples: this.minSamples,
        };
    }
    /**
     * 原子落盘（checkpoint.ts 同律：tmp + fsync + rename —— 要么完整旧档，
     * 要么完整新档，绝无半档）。绝不抛：失败 ⇒ {ok:false, error}。
     */
    persist(filePath) {
        try {
            if (!filePath || typeof filePath !== 'string')
                return { ok: false, error: 'no efficacy path' };
            const tmp = `${filePath}.tmp`;
            const payload = {
                version: EFFICACY_VERSION,
                savedAt: Date.now(),
                window: this.window,
                cells: this.snapshot().cells.map(({ n: _n, posteriorMean: _m, ...c }) => c),
            };
            mkdirSync(path.dirname(filePath), { recursive: true });
            const fd = openSync(tmp, 'w');
            try {
                writeSync(fd, Buffer.from(JSON.stringify(payload), 'utf8'));
                fsyncSync(fd); // rename 可先于数据块持久化 —— 页缓存不算落盘
            }
            finally {
                closeSync(fd);
            }
            renameSync(tmp, filePath);
            return { ok: true, cells: this.cells.size };
        }
        catch (e) {
            try {
                unlinkSync(`${filePath}.tmp`);
            }
            catch { /* tmp 可能未创建 */ }
            return { ok: false, error: String(e?.message ?? e) };
        }
    }
    /**
     * 防御性恢复：逐格校验（三轴全在合法值域 + 计数为有限非负整数 + 上限夹取），
     * 垃圾格弃置计数入 dropped —— 归先验（格缺席 = Beta(1,1)），不连坐整档。
     * 文件缺席/不可解析/非对象 ⇒ {ok:false}；绝不抛。
     */
    restore(filePath) {
        try {
            if (!filePath || !existsSync(filePath)) {
                return { ok: false, restored: 0, dropped: 0, error: 'no efficacy file' };
            }
            const raw = JSON.parse(readFileSync(filePath, 'utf8'));
            if (!raw || typeof raw !== 'object' || !Array.isArray(raw.cells)) {
                return { ok: false, restored: 0, dropped: 0, error: 'efficacy file malformed' };
            }
            let restored = 0, dropped = 0;
            for (const c of raw.cells) {
                const cell = this.coerceCell(c);
                if (!cell) {
                    dropped++;
                    continue;
                }
                this.cells.set(cellKey(cell.syndrome, cell.rootCause, cell.action), { ...cell, lru: ++this.tick });
                restored++;
            }
            this.evictOverflow();
            return { ok: true, restored, dropped };
        }
        catch (e) {
            return { ok: false, restored: 0, dropped: 0, error: String(e?.message ?? e) };
        }
    }
    /** 配置自动落盘（回合闭合时 fire-and-forget 原子写；null ⇒ 关闭）。不抛。 */
    setPersistence(filePath) {
        this.persistPath = filePath && typeof filePath === 'string' ? filePath : null;
    }
    /** 生命周期归零（插件卸载 / 测试隔离）—— 回到构造态 */
    reset() {
        this.cells.clear();
        this.episodes.length = 0;
        this.totals = { recovered: 0, timedOut: 0, observations: 0 };
        this.scanner = new EpisodeScanner(this.window);
        this.tick = 0;
        this.eventIndex = 0;
        this.persistPath = null;
    }
    // ── 内部 ──
    commit(ep) {
        if (ep.outcome === 'recovered')
            this.totals.recovered++;
        else
            this.totals.timedOut++;
        for (const obs of ep.observations) {
            const key = cellKey(ep.syndrome, ep.rootCause, obs.action);
            const c = this.cells.get(key) ?? {
                syndrome: ep.syndrome, rootCause: ep.rootCause, action: obs.action,
                successes: 0, failures: 0, lru: 0,
            };
            if (obs.success)
                c.successes = Math.min(MAX_COUNT, c.successes + 1);
            else
                c.failures = Math.min(MAX_COUNT, c.failures + 1);
            c.lru = ++this.tick;
            this.cells.set(key, c);
        }
        this.totals.observations += ep.observations.length;
        this.episodes.unshift(ep); // 时间降序（最近回合居首 —— 与 recentRootCauseReports 同律）
        if (this.episodes.length > RECENT_EPISODES)
            this.episodes.length = RECENT_EPISODES;
        this.evictOverflow();
        if (this.persistPath)
            this.persist(this.persistPath); // 回合闭合才落盘（事件级 fsync 太碎）
    }
    /** 容量驱逐：超上限 ⇒ 最久未更新格让位（疗效账的有界承诺） */
    evictOverflow() {
        while (this.cells.size > this.maxCells) {
            let oldestKey = null, oldest = Infinity;
            for (const [k, c] of this.cells)
                if (c.lru < oldest) {
                    oldest = c.lru;
                    oldestKey = k;
                }
            if (oldestKey === null)
                break;
            this.cells.delete(oldestKey);
        }
    }
    /** 单格防御校验（垃圾 ⇒ null：归先验不入账）。
     *  三轴一律**严格值域校**（非 parse 收口归桶）：restore 面的格携带显式轴，
     *  把垃圾轴静默归并到 unknown/generic 桶会混册（不同病因的账搅在一起）——
     *  弃置整格才是诚实的「归先验」。（活事件流无此问题：轴由分类器产出，
     *  天然合法；缺席病因走 parseRootCause 的 unknown 诚实缺省。） */
    coerceCell(v) {
        if (!v || typeof v !== 'object')
            return null;
        const c = v;
        const action = parseRecoveryAction(c.action);
        if (!action)
            return null;
        if (typeof c.syndrome !== 'string' || !RECOVERY_SYNDROME_IDS.includes(c.syndrome))
            return null;
        if (typeof c.rootCause !== 'string' || !ROOT_CAUSE_IDS_FILE.includes(c.rootCause))
            return null;
        const num = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= MAX_COUNT ? Math.floor(x) : null;
        const successes = num(c.successes);
        const failures = num(c.failures);
        if (successes === null || failures === null)
            return null;
        return {
            syndrome: c.syndrome,
            rootCause: c.rootCause,
            action,
            successes,
            failures,
        };
    }
}
/** W2-5：进程级单例（与 failureMemory / journal 同律 —— 守卫接线面） */
export const recoveryEfficacy = new RecoveryEfficacy();
