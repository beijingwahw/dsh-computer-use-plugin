// src/autonomy/exploration.ts
// ─── W3-7（R2 探索前沿策略 · UCB 择路）：已探索集 + UCB 探索账 + 独立原子持久化 ───
//
// 问题：闭环的策略序（判据匹配 → 文本宣称 → 僵局切换 → 技能 → 升级）是纯开发
// 式的 —— 它只在「已知路」里择优，从不为「还没试过的路」付学费。当所有已知路
// 失败（policy 交出 no-deterministic-action 的 escalate），闭环只剩升级移交一条
// 途。本模块给恢复态补一条途：按 (元素区域 × 模态 × 策略) 三元组维护已探索集
// 位图，用 UCB（Upper Confidence Bound）前沿分数择路：
//
//   score = 区域未探测不确定度 + 新颖度 + c·√(ln N / n_i)
//           − riskGate 代价 − failureMemory 负先验降权 − 同模态连打惩罚
//
//   区域    elementTracker 框量化网格（只读消费其 TrackedRect 方言 —— 类型级
//           引用，零运行时耦合）：元素中心落格，12×8 网格覆盖整屏；
//   模态    click / type / hotkey / scroll / drag / inspect（世界动作六族）；
//   策略    具体动作签名（模态 + 区域 + 参数摘要 —— 稳定字符串，跨步可对账）；
//   探索账  每格 Beta 风格计数（tries / successes），区域另有聚合尝试账。
//
// 设计立场（与 recoveryEfficacy 同律）：**确定性**。无 RNG —— 同账本同输入同
// 建议，可审计可回放；并列按候选输入序破平（稳定全序）。探索项是 UCB1 的
// 确定性折算（择 argmax 而非采样），处方可解释。
//
// 消费纪律（铁律）：
//   · 一切公开入口绝不抛 —— 建议失败的成本是「返回 null / 少记一笔账」，
//     绝不是异常穿越调用方（闭环绝不因探索旁路炸环）；
//   · 只在恢复态出手（所有已知路失败 / 尾部连续失败 ≥2），常态零触发；
//   · 预算红线（budget-low）与内部异常升级绝不探索 —— 绝不透支收手保护；
//   · 建议动作一律 benign 分层（探索是低风险增益，敏感/破坏性动作不属探索）；
//   · riskGate / failureMemory 只读消费（纯查询，绝不写它们的账）。
//
// 持久化：独立文件原子落盘（tmp + fsync + rename，recoveryEfficacy 同律），
// **不碰 checkpoint.ts**；防御恢复逐格校验，垃圾格弃置不连坐整档。会话边界
// 归零或恢复可配（beginSession('reset' | 'restore')）。
import { existsSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, mkdirSync, unlinkSync, } from 'fs';
import path from 'path';
import { failureMemory } from '../failureMemory.js';
import { kernelRegistry } from '../kernel/registry.js';
// W6-1（doctor 债清偿·smell.over-engineering）：常量（值即边界）、区域量化、UCB
// 前沿分数、端口契约类型、内部记账结构与候选生成/riskGate 代价纯函数逐字节搬至
// ./explorationCore —— 本文件保留 ExplorationLedger 账本类，导入面不变（公共面
// 原位再导出；buildCandidates/riskCostOf 两个零 this 私有方法搬运为自由函数，
// 调用点同步改名，行为零变化）。
export { EXPLORATION_GRID_COLS, EXPLORATION_GRID_ROWS, EXPLORATION_UCB_C, EXPLORATION_ALTERNATION_PENALTY, EXPLORATION_NEG_PRIOR_UNIT, EXPLORATION_NEG_PRIOR_CAP, EXPLORATION_RISK_COST_DANGER, EXPLORATION_RISK_COST_SENSITIVE, EXPLORATION_RECOVERY_MIN_RUN, EXPLORATION_MAX_ADVISES_PER_RUN, EXPLORATION_MODALITIES, quantizeRegion, quantizePoint, regionLabel, trailingFailureRun, explorationScore, } from './explorationCore.js';
import { DEFAULT_VIEWPORT, EXPLORATION_GRID_COLS, EXPLORATION_GRID_ROWS, EXPLORATION_MAX_ADVISES_PER_RUN, EXPLORATION_MAX_CELLS_DEFAULT, EXPLORATION_MAX_COUNT, EXPLORATION_MODALITIES, EXPLORATION_NEG_PRIOR_CAP, EXPLORATION_NEG_PRIOR_K, EXPLORATION_NEG_PRIOR_UNIT, EXPLORATION_RECOVERY_MIN_RUN, EXPLORATION_UCB_C, EXPLORATION_VERSION, STRATEGY_MAX, buildExplorationCandidates, cellKey, explorationRiskCostOf, explorationScore, modalityOfKind, quantizePoint, regionLabel, strategyOf, trailingFailureRun, } from './explorationCore.js';
// ── W3-7：探索账本 ──
/**
 * W3-7（R2）：探索前沿账本 —— 已探索集 + UCB 择路 + 独立原子持久化。
 * 按目标隔离（一目标一账本）；一切公开方法绝不抛（防御纪律）；确定性择路
 * （argmax + 稳定并列序，无 RNG）。构造缺省关闭（enabled:false —— 缺省关闭
 * 红律：点亮是集成接线的显式决定）。
 */
export class ExplorationLedger {
    enabled;
    goal;
    maxAdvisesPerRun;
    maxCells;
    cells = new Map();
    regionTries = new Map();
    totalTries = 0;
    lastModality = null;
    advisesThisRun = 0;
    persistPath = null;
    observesSincePersist = 0;
    tick = 0;
    constructor(goal, opts = {}) {
        this.goal = typeof goal === 'string' ? goal.slice(0, 200) : '';
        this.enabled = opts?.enabled === true; // W3-7：缺省关闭
        this.maxAdvisesPerRun = Number.isFinite(opts?.maxAdvisesPerRun)
            ? Math.min(32, Math.max(1, Math.round(opts.maxAdvisesPerRun)))
            : EXPLORATION_MAX_ADVISES_PER_RUN;
        this.maxCells = Number.isFinite(opts?.maxCells)
            ? Math.min(65_536, Math.max(16, Math.round(opts.maxCells)))
            : EXPLORATION_MAX_CELLS_DEFAULT;
        if (typeof opts?.persistPath === 'string' && opts.persistPath !== '') {
            this.persistPath = opts.persistPath;
        }
    }
    /**
     * W3-7：恢复态问路（绝不抛）。门序（缺一即 null —— 照旧升级路径）：
     *  ① 总闸：enabled !== true 或内核键 exploration.enabledGate < 1 ⇒ null；
     *  ② 红线：escalateReason 为 budget-low / policy-engine-internal-error ⇒ null
     *     （预算将尽与内部异常是收手时刻，探索绝不透支收手保护）；
     *  ③ 恢复态：escalateReason === 'no-deterministic-action'（所有已知路失败）
     *     或尾部连续失败游程 ≥ 2（熔断后/僵局切换现场）⇒ 才出手（常态零触发）；
     *  ④ 预算：本 run 已发建议数达上限 ⇒ null（第三重停机）；
     *  ⑤ 候选：无可辩护候选（快照无元素且全局轮换候选不成立）⇒ null。
     * 择路：全部候选 UCB 前沿分数 argmax，并列按候选输入序（元素序 → 全局序）
     * —— 稳定全序，同账本同输入同建议。
     */
    advise(ctx) {
        try {
            // ① 总闸（双闸：实例开关 × 内核键 —— 开启条件由集成/内核键控）
            if (this.enabled !== true)
                return null;
            if (kernelRegistry.getOrDefault('exploration.enabledGate', 1) < 1)
                return null;
            const c = (ctx ?? {});
            // ② 红线：收手时刻绝不探索
            const reason = typeof c.escalateReason === 'string' && c.escalateReason !== ''
                ? c.escalateReason
                : '?';
            if (reason === 'budget-low' || reason === 'policy-engine-internal-error')
                return null;
            // ③ 恢复态判据（常态零触发红律）
            const recovering = reason === 'no-deterministic-action' ||
                trailingFailureRun(c.history) >= EXPLORATION_RECOVERY_MIN_RUN;
            if (!recovering)
                return null;
            // ④ 探索预算
            if (this.advisesThisRun >= this.maxAdvisesPerRun)
                return null;
            // ⑤ 候选生成与择路
            const goal = typeof c.goal === 'string' && c.goal !== '' ? c.goal : this.goal;
            const viewport = this.viewportOf(c.snapshot);
            const candidates = buildExplorationCandidates(c.snapshot, viewport);
            if (candidates.length === 0)
                return null;
            const ucbC = kernelRegistry.getOrDefault('exploration.ucbC', EXPLORATION_UCB_C);
            let best = null;
            let bestScore = Number.NEGATIVE_INFINITY;
            for (const cand of candidates) {
                const cell = this.cells.get(cellKey(cand.region, cand.modality, cand.strategy));
                const score = explorationScore({
                    regionTries: this.regionTries.get(cand.region) ?? 0,
                    cellTries: cell ? cell.tries : 0,
                    totalTries: this.totalTries,
                    riskCost: explorationRiskCostOf(cand.riskText),
                    negativePriorPenalty: this.negativePriorFor(cand.region, cand.modality, goal),
                    sameModalityAsLast: this.lastModality === cand.modality,
                    ucbC,
                });
                if (score > bestScore) {
                    bestScore = score;
                    best = cand;
                }
            }
            if (best === null)
                return null;
            // 记账：本次建议计入 run 预算；交替律状态前移到建议模态
            this.advisesThisRun++;
            this.lastModality = best.modality;
            const note = `W3-7 探索建议：${regionLabel(best.region)}×模态 ${best.modality}（UCB 分 ${Math.round(bestScore * 1000) / 1000}，本 run 第 ${this.advisesThisRun}/${this.maxAdvisesPerRun} 次）`;
            return { action: best.action, note };
        }
        catch {
            return null; // 绝不抛的字面兑现 —— 探索是恢复增益不是依赖
        }
    }
    /**
     * W3-7：步落账回报 —— 世界动作入探索账（每格尝试与成败的 Beta 计数）。
     * 三元组还原优先级：动作 payload.exploration 标注（advise 铸动作时预标 ——
     * 精确对账）> 现场量化（target.center 或视口中心 + viewport）。观察族/元动作
     * （declare/escalate/wait/ask_vlm/recall_skill）不入账；三元组无法确定 ⇒ 诚实
     * 跳过（不把账记到猜的格子上）。autoPilot 对全动作流回报 —— 账本不只记自己
     * 的建议，策略自选动作同样计入已探索集（探索度是全流的账）。
     */
    observe(action, outcome, viewport) {
        try {
            const a = (action ?? {});
            const modality = modalityOfKind(a.kind);
            if (modality === null)
                return;
            // 三元组还原：payload 预标优先，现场量化兜底
            const payload = a.payload && typeof a.payload === 'object' ? a.payload : null;
            const mark = payload?.exploration;
            let region = -1;
            let strategy = '';
            if (mark && typeof mark === 'object' && !Array.isArray(mark)) {
                const m = mark;
                if (Number.isInteger(m.region) && m.region >= 0)
                    region = m.region;
                if (typeof m.strategy === 'string' && m.strategy !== '')
                    strategy = m.strategy.slice(0, STRATEGY_MAX);
            }
            if (region < 0) {
                region = quantizePoint(a.target?.center, viewport);
                // inspect 族：payload.region（Bbox）中心即落点 —— 聚焦区域就是它的区域
                if (region < 0 && modality === 'inspect' && payload?.region && typeof payload.region === 'object') {
                    const b = payload.region;
                    const xs = [b.x0, b.x1], ys = [b.y0, b.y1];
                    region = quantizePoint(xs.every(v => typeof v === 'number' && Number.isFinite(v)) && ys.every(v => typeof v === 'number' && Number.isFinite(v))
                        ? { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }
                        : undefined, viewport);
                }
                // 无靶点模态（scroll/hotkey/type）：视口中心格兜底（全局动作的区域语义）
                if (region < 0 && (modality === 'scroll' || modality === 'hotkey' || modality === 'type') && viewport) {
                    region = quantizePoint({ x: viewport.width / 2, y: viewport.height / 2 }, viewport);
                }
                if (region < 0)
                    return; // 无法定位 ⇒ 诚实跳过（不把账记到猜的格子上）
            }
            if (strategy === '')
                strategy = strategyOf(modality, region, action);
            // 入账：格 Beta 计数 + 区域聚合账 + 全账 + 交替律状态
            const key = cellKey(region, modality, strategy);
            const cell = this.cells.get(key) ??
                { region, modality, strategy, tries: 0, successes: 0, lru: 0 };
            cell.tries = Math.min(EXPLORATION_MAX_COUNT, cell.tries + 1);
            if (outcome === 'progress') {
                cell.successes = Math.min(EXPLORATION_MAX_COUNT, cell.successes + 1);
            }
            cell.lru = ++this.tick;
            this.cells.set(key, cell);
            this.regionTries.set(region, Math.min(EXPLORATION_MAX_COUNT, (this.regionTries.get(region) ?? 0) + 1));
            this.totalTries = Math.min(EXPLORATION_MAX_COUNT, this.totalTries + 1);
            this.lastModality = modality;
            this.evictOverflow();
            // 节流落盘：成功或每 8 笔一次（事件级 fsync 太碎 —— recoveryEfficacy 同律）
            this.observesSincePersist++;
            if (this.persistPath !== null && (outcome === 'progress' || this.observesSincePersist >= 8)) {
                this.observesSincePersist = 0;
                this.persist(this.persistPath);
            }
        }
        catch {
            /* 绝不抛：这一笔没记上就是全部代价 */
        }
    }
    /** W3-7：负先验降权（只读查询 failureMemory ——绝不写它的账）。
     *  查询文本 = 目标 + 模态 + 区域标签；命中按 score2（legacy 加权和 = 词面
     *  重合 + 0.3×压缩相似）加权累计：文本重合越满，降权越重；上限 0.45（软
     *  先验 —— 降权不除名，UCB 其余三项仍可翻案）。任何故障 ⇒ 0。 */
    negativePriorFor(region, modality, goal) {
        try {
            const g = typeof goal === 'string' && goal !== '' ? goal : this.goal;
            const query = `${g} ${modality} ${regionLabel(region)}`.trim();
            // 运行时 match 逐记录附加 score2（legacy 加权和），但其返回类型的公开面
            // 只列 score —— 此处按运行时形状收窄（只读消费，绝不写它的账）。
            const hits = failureMemory.match(query, undefined, EXPLORATION_NEG_PRIOR_K);
            let penalty = 0;
            for (const h of hits) {
                const s = typeof h.score2 === 'number' && Number.isFinite(h.score2) && h.score2 > 0 ? h.score2 : 0;
                penalty += EXPLORATION_NEG_PRIOR_UNIT * s;
            }
            return Math.min(EXPLORATION_NEG_PRIOR_CAP, penalty);
        }
        catch {
            return 0;
        }
    }
    /** 读单格（缺席 ⇒ null —— 调用方以「从未尝试」解读） */
    cellFor(region, modality, strategy) {
        const c = this.cells.get(cellKey(region, modality, strategy));
        return c ? { tries: c.tries, successes: c.successes } : null;
    }
    /** 区域聚合尝试账（只读） */
    regionTryCount(region) {
        return this.regionTries.get(region) ?? 0;
    }
    /** 全账总尝试数（只读） */
    get totalTryCount() {
        return this.totalTries;
    }
    /** 账本快照（审计/metrics 消费面 —— 只读投影，键序确定） */
    snapshot() {
        const cells = [...this.cells.values()]
            .sort((a, b) => a.region - b.region ||
            (a.modality < b.modality ? -1 : a.modality > b.modality ? 1 : 0) ||
            (a.strategy < b.strategy ? -1 : a.strategy > b.strategy ? 1 : 0))
            .map(({ lru: _lru, ...c }) => ({
            ...c,
            posteriorMean: Math.round(((c.successes + 1) / (c.tries + 2)) * 1e6) / 1e6,
        }));
        const regionTries = [...this.regionTries.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([region, tries]) => ({ region, tries }));
        return {
            goal: this.goal,
            totalTries: this.totalTries,
            advisesThisRun: this.advisesThisRun,
            lastModality: this.lastModality,
            cells,
            regionTries,
        };
    }
    /**
     * W3-7：原子落盘（recoveryEfficacy / checkpoint 同律：tmp + fsync + rename ——
     * 要么完整旧档，要么完整新档，绝无半档）。独立文件，不碰 checkpoint.ts。
     * 绝不抛：失败 ⇒ {ok:false, error}。
     */
    persist(filePath) {
        try {
            if (typeof filePath !== 'string' || filePath === '')
                return { ok: false, error: 'no exploration path' };
            const tmp = `${filePath}.tmp`;
            const snap = this.snapshot();
            const payload = {
                version: EXPLORATION_VERSION,
                savedAt: Date.now(),
                goal: this.goal,
                cells: snap.cells.map(({ posteriorMean: _m, ...c }) => c),
                regionTries: snap.regionTries,
                lastModality: this.lastModality,
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
     * W3-7：防御性恢复 —— 逐格校验（区域在网格值域 + 模态在闭集 + 签名非空 +
     * 计数为有限非负整数 + 上限夹取），垃圾格弃置计数入 dropped（不连坐整档）。
     * 目标不符（他账）⇒ 拒收整档 —— 按目标隔离的红律。绝不抛。
     */
    restore(filePath) {
        try {
            if (typeof filePath !== 'string' || filePath === '' || !existsSync(filePath)) {
                return { ok: false, restored: 0, dropped: 0, error: 'no exploration file' };
            }
            const raw = JSON.parse(readFileSync(filePath, 'utf8'));
            if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
                return { ok: false, restored: 0, dropped: 0, error: 'exploration file malformed' };
            }
            const file = raw;
            if (file.version !== EXPLORATION_VERSION) {
                return { ok: false, restored: 0, dropped: 0, error: 'version mismatch' };
            }
            if (typeof file.goal !== 'string' || file.goal !== this.goal) {
                return { ok: false, restored: 0, dropped: 0, error: 'goal mismatch (他目标账本)' };
            }
            if (!Array.isArray(file.cells)) {
                return { ok: false, restored: 0, dropped: 0, error: 'cells malformed' };
            }
            const gridCells = EXPLORATION_GRID_COLS * EXPLORATION_GRID_ROWS;
            const count = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= EXPLORATION_MAX_COUNT
                ? Math.floor(x)
                : null;
            let restored = 0;
            let dropped = 0;
            for (const v of file.cells) {
                if (v === null || typeof v !== 'object' || Array.isArray(v)) {
                    dropped++;
                    continue;
                }
                const cell = v;
                if (!Number.isInteger(cell.region) || cell.region < 0 || cell.region >= gridCells) {
                    dropped++;
                    continue;
                }
                if (typeof cell.modality !== 'string' || !EXPLORATION_MODALITIES.includes(cell.modality)) {
                    dropped++;
                    continue;
                }
                if (typeof cell.strategy !== 'string' || cell.strategy === '') {
                    dropped++;
                    continue;
                }
                const tries = count(cell.tries);
                const successes = count(cell.successes);
                if (tries === null || successes === null || successes > tries) {
                    dropped++;
                    continue;
                }
                this.cells.set(cellKey(cell.region, cell.modality, cell.strategy.slice(0, STRATEGY_MAX)), {
                    region: cell.region,
                    modality: cell.modality,
                    strategy: cell.strategy.slice(0, STRATEGY_MAX),
                    tries,
                    successes,
                    lru: ++this.tick,
                });
                restored++;
            }
            if (Array.isArray(file.regionTries)) {
                for (const v of file.regionTries) {
                    if (v === null || typeof v !== 'object' || Array.isArray(v))
                        continue;
                    const entry = v;
                    const tries = count(entry.tries);
                    if (!Number.isInteger(entry.region) || entry.region < 0 || entry.region >= gridCells || tries === null)
                        continue;
                    this.regionTries.set(entry.region, tries);
                }
            }
            if (typeof file.lastModality === 'string' && EXPLORATION_MODALITIES.includes(file.lastModality)) {
                this.lastModality = file.lastModality;
            }
            // W3-7：全账总数不持久化（派生账）—— 恢复时从格子账重演；LRU 驱逐可能
            // 丢格 ⇒ 取格账与区域账两口径的较大者（宁可高估 N 也不低估 —— UCB 的
            // 探索项随 N 单调不减，高估只会收敛探索加成，绝不放大）。
            let cellSum = 0;
            for (const c of this.cells.values())
                cellSum += c.tries;
            let regionSum = 0;
            for (const t of this.regionTries.values())
                regionSum += t;
            this.totalTries = Math.min(EXPLORATION_MAX_COUNT, Math.max(cellSum, regionSum));
            this.evictOverflow();
            return { ok: true, restored, dropped };
        }
        catch (e) {
            return { ok: false, restored: 0, dropped: 0, error: String(e?.message ?? e) };
        }
    }
    /** 配置自动落盘（observe 节流触发；null ⇒ 关闭）。不抛。 */
    setPersistence(filePath) {
        this.persistPath = typeof filePath === 'string' && filePath !== '' ? filePath : null;
    }
    /**
     * W3-7：会话边界（归零或恢复，可配）—— 'reset'（缺省）⇒ run 级状态归零
     * （建议预算/交替律状态），细胞账保留在内存（归零的是会话边界态不是知识）；
     * 'restore' ⇒ 先从持久化档恢复账本再归零 run 态（跨会话延续探索记忆）。
     */
    beginSession(mode = 'reset') {
        try {
            if (mode === 'restore' && this.persistPath !== null)
                this.restore(this.persistPath);
            this.advisesThisRun = 0;
            this.lastModality = null;
            this.observesSincePersist = 0;
        }
        catch { /* 绝不抛 */ }
    }
    /** 生命周期归零（插件卸载 / 测试隔离）—— 回到构造态 */
    reset() {
        this.cells.clear();
        this.regionTries.clear();
        this.totalTries = 0;
        this.lastModality = null;
        this.advisesThisRun = 0;
        this.observesSincePersist = 0;
        this.tick = 0;
        this.persistPath = null;
    }
    // ── 内部 ──
    /** 快照的量化视口（缺省 1920×1080 —— 防御回退） */
    viewportOf(snapshot) {
        const s = (snapshot ?? {});
        return {
            width: typeof s.width === 'number' && Number.isFinite(s.width) && s.width > 0 ? s.width : DEFAULT_VIEWPORT.width,
            height: typeof s.height === 'number' && Number.isFinite(s.height) && s.height > 0 ? s.height : DEFAULT_VIEWPORT.height,
        };
    }
    /** 容量驱逐：超上限 ⇒ 最久未更新格让位（探索账的有界承诺） */
    evictOverflow() {
        while (this.cells.size > this.maxCells) {
            let oldestKey = null;
            let oldest = Infinity;
            for (const [k, c] of this.cells) {
                if (c.lru < oldest) {
                    oldest = c.lru;
                    oldestKey = k;
                }
            }
            if (oldestKey === null)
                break;
            this.cells.delete(oldestKey);
        }
    }
}
