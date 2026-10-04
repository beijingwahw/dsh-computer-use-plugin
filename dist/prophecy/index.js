import { InMemoryWorldModel } from '../knowledge/worldModel.js';
// ─── 算法形状字面量（出册常数） ───
/** 账本环形容量（条）：错题本的物理上限 —— 审计史是滚动窗，不是无限账 */
const LEDGER_CAPACITY = 500;
/** 容量夹取上限（防注入式爆内存：账本是旁路，不值得无界） */
const CAPACITY_MAX = 10_000;
/** 挂起预言的诚实作废时限（ms）：60s 内取不到真实下一屏型 ⇒ 作废（绝不伪造） */
const PENDING_TTL_MS = 60_000;
/**
 * 有界 keyed pending 缺省槽数（ΑΩ-R18）：闭环 mint→settle 严格交替（单槽即
 * 足），富余只兜并发/跨 run 边界的滞留铸造 —— 8 槽 ≈ 8 条并发 run 的在途预
 * 言，是「审计丢件有痕」与「挂起集有界」的折中。
 */
const PENDING_SLOTS = 8;
/** 挂起槽数夹取上限（防注入式爆内存：挂起集与账本同律不值得无界） */
const PENDING_SLOTS_MAX = 64;
// W6-2（doctor smell.over-engineering 清偿）：内部纯工具已分区提取至 internal.ts
// （行为零变化；PROB_EPSILON 随迁 —— 仅 settleSurpriseBits 消费）。
// ΑΩ-R18：屏型量化/粗层方言（quantizedScreenType/coarseScreenType）定义于
// internal.ts（惊异读面的层级匹配需要它们，值定义在 internal 内避免值环）；
// 此处消费 + 再分发 —— 公开导入面与 W8 逐字节不变。
import { nonEmptyStr, safeNow, shortId, resultValue, settleSurpriseBits, coarseScreenType, quantizedScreenType, } from './internal.js';
export { coarseScreenType, COARSE_PREFIX_HEX, quantizedScreenType, QUANT_KEEP_HEX, QUANT_MIN_KEEP_HEX, QUANT_MAX_KEEP_HEX, PROPHECY_QUANT_KERNEL_KEY, 
// ΝΩ-11：惊异夹帽（错题本排序防单条拉爆）—— 常量与夹取函数随迁公开面
SURPRISE_MAX_BITS, clampSurpriseBits, } from './internal.js';
// ─── 铸造与结算（纯函数面） ───
/**
 * 铸预言（纯函数，永不抛）：按 (屏型, 动作键) 问世界模型 predict 读面。
 *   · 无历史 / 模型缺席 / 模型抛错 / 坏形状 ⇒ outcome 'no-model'（诚实无知，
 *     绝不把「没见过」伪装成任何预测）；
 *   · 有历史 ⇒ 取分布首名（typeId + prob），outcome 'pending'（铸而未验 ——
 *     三态终值只由 settleProphecy 落锤）。
 *   · ΑΩ-R18 三层梯级（细 → 粗，先到先得，来源层如实入账）：
 *       ① 原始指纹（'exact'）—— 字节级复现的旧通道（非 hex 方言的唯一通道，
 *          旧方言零漂移）；
 *       ② 量化格（'quant'）—— quantizedScreenType：dhash 低 16 位（屏幕下
 *          1/4 条带抖动正源）掩没 ⇒ 同场景抖动变体命中同键（R18 主诉的
 *          结构性修法）；
 *       ③ 粗格（'coarse'）—— D-G2 coarseScreenType（上 32 位）回退。
 *     各层查无 ⇒ 仍诚实 no-model。非 hex 屏型三键合一 ⇒ 逐字节旧路径。
 * @param ts 铸造时刻（缺省 Date.now —— 引擎注入闭环时钟）
 */
export function mintProphecy(worldModel, screenType, actionKey, ts) {
    const t = typeof ts === 'number' && Number.isFinite(ts) ? ts : Date.now();
    const s = nonEmptyStr(screenType) ? screenType : String(screenType ?? '');
    const k = nonEmptyStr(actionKey) ? actionKey : String(actionKey ?? '');
    const base = { screenType: s, actionKey: k, ts: t };
    const ask = (key) => {
        try {
            if (!worldModel || typeof worldModel.predict !== 'function' || !nonEmptyStr(key) || !nonEmptyStr(k)) {
                return null;
            }
            const pred = resultValue(worldModel.predict(key, k));
            const nextTypes = pred && Array.isArray(pred.nextTypes)
                ? pred.nextTypes
                : [];
            const top = nextTypes[0];
            if (!top || !nonEmptyStr(top.typeId))
                return null;
            const hit = { typeId: String(top.typeId) };
            if (typeof top.prob === 'number' && Number.isFinite(top.prob)) {
                hit.prob = Math.min(1, Math.max(0, top.prob));
            }
            return hit;
        }
        catch {
            return null; // 模型故障 = 无知识（诚实吞掉，绝不炸，绝不伪造）
        }
    };
    // ΑΩ-R18：梯级去重（量化格与原始键相同时不重问；粗格亦然 —— 键相同即同格）
    const quant = quantizedScreenType(s);
    const coarse = coarseScreenType(s);
    const tiers = [{ key: s, via: 'exact' }];
    if (quant !== s)
        tiers.push({ key: quant, via: 'quant' });
    if (coarse !== s && coarse !== quant)
        tiers.push({ key: coarse, via: 'coarse' });
    for (const tier of tiers) {
        const hit = ask(tier.key);
        if (hit !== null) {
            const rec = { ...base, predictedType: hit.typeId, predictedVia: tier.via, outcome: 'pending' };
            if (typeof hit.prob === 'number')
                rec.predictedProb = hit.prob;
            return rec;
        }
    }
    return { ...base, outcome: 'no-model' };
}
/**
 * 结预言（纯函数，永不抛）：命中律三态落锤。
 *   · ΑΩ-R18 键粒度两侧一致：比对一律经量化折算 —— predictedType ===
 *     quantizedScreenType(actualType) ⇒ 'hit'。引擎回灌的目的地恒为量化身份
 *     （见 ProphecyEngine.settle 三写），预言侧与见证侧在同一把量化尺上对账
 *     （不得 fine↔coarse 串味）；非 hex 方言量化恒等 ⇒ 逐字节旧判律。记录上
 *     的 actualType 保持原始精细见证（只作记录，比对经折算）。
 *   · 有预言而不符 ⇒ 'miss' + 惊异差值（settleSurpriseBits 口径 —— 同按来源
 *     层对键、目的地量化，读写同方言）；
 *   · 无预言（no-model 铸造）⇒ 直通 —— 无知就是无知，actualType 只作见证记录。
 * actualType 非非空字符串 ⇒ 原样直通（不结算 —— 挂起由引擎的 60s 作废律收口，
 * 绝不在这里伪造见证）。返回结算后的**新记录**（入参不可变）。
 */
export function settleProphecy(record, actualType, worldModel) {
    try {
        if (!record || typeof record !== 'object')
            return record; // 垃圾记录直通
        if (!nonEmptyStr(actualType))
            return record; // 无真实见证 ⇒ 不结算
        const out = { ...record, actualType };
        if (!nonEmptyStr(out.predictedType)) {
            out.outcome = 'no-model'; // 直通：模型无知
            return out;
        }
        if (out.predictedType === quantizedScreenType(actualType)) {
            out.outcome = 'hit';
            out.surpriseBits = settleSurpriseBits(out, actualType, 'hit', worldModel);
            return out;
        }
        out.outcome = 'miss';
        out.surpriseBits = settleSurpriseBits(out, actualType, 'miss', worldModel);
        return out;
    }
    catch {
        return record; // 结算绝不抛（运行层铁律）
    }
}
/**
 * 动作键方言（纯函数，永不抛）：PolicyAction → 世界模型转移表的键。
 * 指针动作 ⇒ kind + 量化区域（'click@22'）—— 与 worldModel.transitionActionKey
 * 的 TYPE_QUANTIZE=4 同门方言（「在什么样的屏上点哪个区」，精确坐标是噪声、
 * 区域是信号）；落点先从快照像素折算归一化（闭环坐标是像素，D-7 是归一化 ——
 * 折算在此收口）。无落点/坏几何 ⇒ kind 本身。
 */
export function prophecyActionKey(action, refWidth, refHeight) {
    try {
        const kind = action && typeof action === 'object' && nonEmptyStr(action.kind) ? String(action.kind) : 'unknown';
        const target = action && typeof action === 'object' ? action.target : null;
        const center = target && typeof target === 'object' ? target.center : null;
        const cx = center && typeof center === 'object' ? center.x : undefined;
        const cy = center && typeof center === 'object' ? center.y : undefined;
        const hasGeom = typeof refWidth === 'number' && Number.isFinite(refWidth) && refWidth > 0 &&
            typeof refHeight === 'number' && Number.isFinite(refHeight) && refHeight > 0;
        if (typeof cx === 'number' && Number.isFinite(cx) && typeof cy === 'number' && Number.isFinite(cy) && hasGeom) {
            const nx = Math.min(1, Math.max(0, cx / refWidth));
            const ny = Math.min(1, Math.max(0, cy / refHeight));
            const qx = Math.min(3, Math.max(0, Math.floor(nx * 4)));
            const qy = Math.min(3, Math.max(0, Math.floor(ny * 4)));
            return `${kind}@${qx}${qy}`;
        }
        return kind;
    }
    catch {
        return 'unknown'; // 键铸造绝不抛
    }
}
/**
 * 步 journal 注记（一行，纯函数）：`prophecy:hit|miss|no-model（…）` ——
 * 闭环唯一的留痕差量（不扩 StepRecord 字段结构）。指纹截 16 字符（Token 纪律，
 * 全量身份留在账本）。
 */
export function prophecyJournalTag(record) {
    try {
        const cell = `${shortId(record.screenType)}|${record.actionKey}`;
        const to = nonEmptyStr(record.actualType) ? shortId(String(record.actualType)) : '?';
        // D-G2/ΑΩ-R18：回退/量化层铸出的预言在注记上如实标注 —— 精确层注记逐字节旧方言
        const via = record.predictedVia === 'coarse' ? '，via 粗层' : record.predictedVia === 'quant' ? '，via 量化层' : '';
        if (record.outcome === 'hit') {
            const p = typeof record.predictedProb === 'number' && Number.isFinite(record.predictedProb)
                ? Math.round(record.predictedProb * 1000) / 1000
                : '?';
            return `prophecy:hit（${cell} → ${to}，p=${p}${via}）`;
        }
        if (record.outcome === 'miss') {
            const bits = typeof record.surpriseBits === 'number' && Number.isFinite(record.surpriseBits)
                ? Math.round(record.surpriseBits * 1000) / 1000
                : '?';
            return `prophecy:miss（${cell} → ${to}，惊异 ${bits} bits${via}）`;
        }
        return `prophecy:no-model（${cell} → ${to}，模型无知直通）`;
    }
    catch {
        return 'prophecy:no-model（注记铸造故障，账本为准）'; // 注记绝不抛
    }
}
// W6-2（doctor smell.over-engineering 清偿）：统计面已分区提取至 stats.ts（行为零变化）；
// 导入面不变 —— 再分发。
export { prophecyStats } from './stats.js';
export { prophecyCalibration, prophecyPostmortem, prophecyPostmortemLines } from './stats.js';
import { prophecyStats } from './stats.js';
/**
 * 失手记录 → 惊异喂养记录（纯函数，永不抛）：只有 miss 有惊异可喂 ——
 * hit / no-model 返回 null（命中不是教训、无知没有 bits —— 诚实 null，
 * 绝不伪造喂养载荷）。方言对齐 RunRecord 必填面（goal/success/steps/
 * durationMs/strategies），failureRootCause 携带失手注记（复盘线索）。
 */
export function surpriseRunRecord(rec) {
    try {
        if (!rec || typeof rec !== 'object' || rec.outcome !== 'miss')
            return null;
        const bits = typeof rec.surpriseBits === 'number' && Number.isFinite(rec.surpriseBits)
            ? Math.round(rec.surpriseBits * 1000) / 1000
            : null;
        return {
            goal: `prophecy:miss ${shortId(rec.screenType)}|${rec.actionKey}`,
            success: false,
            steps: 1,
            durationMs: 0,
            strategies: [rec.actionKey],
            failureRootCause: `prophecy-miss → ${nonEmptyStr(rec.actualType) ? shortId(String(rec.actualType)) : '?'}`
                + (bits !== null ? `（惊异 ${bits} bits）` : '（惊异缺席）'),
        };
    }
    catch {
        return null; // 喂养载荷铸造绝不抛
    }
}
/**
 * 预言引擎（ProphecyPort 的真实实现）：铸造 → 挂起 → 结算 → 入账 的账本主人。
 *   · mint（ΑΩ-R18 有界 keyed pending）：先作废超时挂起，再铸新预言（盲屏
 *     指纹 ⇒ 不铸）；各铸造各占一槽（按铸造序键控，缺省 8 槽）—— 并发/跨
 *     run 边界的铸造不再静默覆盖未结算预言，溢出最旧作废计入 expired（作废
 *     有痕，绝不无痕丢件）；
 *   · settle（ΑΩ-R18 LIFO 配对）：结算见证恒属最近执行的动作 ⇒ 配对最近铸造
 *     （后进先出）；actualType 缺席 ⇒ 挂起保持（60s 后作废计数，绝不伪造
 *     见证）；结算成功 ⇒ 记录入环形账本（500 封顶，逐出最旧）+（learn 时）
 *     observe 回灌世界模型三写 {原始, 量化, 粗格}（先 surprise 后 observe ——
 *     与 D-7 回路同序，误差先于学习；目的地一律量化身份 ⇒ 表内键与目的地
 *     粒度同律，结算比对两侧一致不串味）；
 *   · 一切公开面永不抛异常。
 */
export class ProphecyEngine {
    worldModel;
    now;
    pendingTtlMs;
    pendingSlots;
    capacity;
    learn;
    /** 惊异喂养通道（D-G2；缺席 ⇒ 零行为） */
    surpriseFeedTarget;
    /** 环形账本（入账序；超容量逐出最旧） */
    ledger = [];
    /**
     * 挂起中的预言（ΑΩ-R18 有界 keyed pending）：铸造序 → 记录（插入序 = 铸
     * 造序 ⇒ 首 key = 最旧、末 key = 最近；Map 有界 pendingSlots 槽）
     */
    pending = new Map();
    /** 铸造序发号器（单调计数 —— 挂起键的身份源；绝不用时钟充当 id） */
    mintSeq = 0;
    /** 挂起作废累计（诚实计数 —— TTL 超时与容量逐出同律入账：取不到真实下一屏型的预言归宿） */
    expiredCount = 0;
    /** 已扫视入账总数（喂养水位线 —— 与 evictedTotal 的差即当前未扫视起点） */
    fedCursor = 0;
    /** 环形逐出累计（水位线的驱逐补偿 —— 索引平移不改扫视史） */
    evictedTotal = 0;
    constructor(opts = {}) {
        this.worldModel = opts.worldModel ?? null;
        this.now = typeof opts.now === 'function' ? opts.now : undefined;
        this.pendingTtlMs =
            typeof opts.pendingTtlMs === 'number' && Number.isFinite(opts.pendingTtlMs) && opts.pendingTtlMs > 0
                ? opts.pendingTtlMs
                : PENDING_TTL_MS;
        this.pendingSlots =
            typeof opts.pendingSlots === 'number' && Number.isFinite(opts.pendingSlots)
                ? Math.min(PENDING_SLOTS_MAX, Math.max(1, Math.floor(opts.pendingSlots)))
                : PENDING_SLOTS;
        this.capacity =
            typeof opts.capacity === 'number' && Number.isFinite(opts.capacity)
                ? Math.min(CAPACITY_MAX, Math.max(1, Math.floor(opts.capacity)))
                : LEDGER_CAPACITY;
        this.learn = opts.learn !== false;
        this.surpriseFeedTarget =
            opts.surpriseFeed && typeof opts.surpriseFeed.ingest === 'function' ? opts.surpriseFeed : null;
    }
    /** 挂起超时作废（内部件）：逐槽扫视，now − ts 越过 TTL ⇒ expired 计数 + 丢弃 */
    voidStalePending() {
        if (this.pending.size === 0)
            return;
        const t = safeNow(this.now);
        for (const [seq, rec] of [...this.pending.entries()]) { // 快照遍历（作废中改 Map）
            const age = t - rec.ts;
            if (Number.isFinite(age) && age > this.pendingTtlMs) {
                this.expiredCount++;
                this.pending.delete(seq);
            }
        }
    }
    /** 铸造面（ProphecyPort）：盲屏不铸；任何故障只丢预言。永不抛。 */
    mint(screenType, actionKey) {
        try {
            this.voidStalePending();
            if (!nonEmptyStr(screenType) || !nonEmptyStr(actionKey))
                return; // 盲屏/空键不可预言
            // ΑΩ-R18：容量律 —— 溢出最旧作废（expired 有痕），铸造各占一槽不覆盖
            while (this.pending.size >= this.pendingSlots) {
                const oldest = this.pending.keys().next();
                if (oldest.done)
                    break;
                this.pending.delete(oldest.value);
                this.expiredCount++;
            }
            const seq = ++this.mintSeq;
            this.pending.set(seq, mintProphecy(this.worldModel, String(screenType), String(actionKey), safeNow(this.now)));
        }
        catch {
            this.pending.clear(); // 铸造故障吞掉 —— 丢预言不炸环
        }
    }
    /**
     * 结算面（ProphecyPort）：新屏型指纹 = actualType（结算见证）。
     * ΑΩ-R18 LIFO 配对：见证恒属最近执行的动作 ⇒ 结算最近铸造（早铸预言留待
     * 各自结算或作废律收口 —— 并发双预言各得其所，绝不互相顶掉）。
     * 返回结算记录（null = 无待结算 / 见证缺席仍挂起 / 已作废）。永不抛。
     * learn 时结算后回灌 observe（success 由闭环传执行结局 —— 缺省按成功入账）。
     */
    settle(actualType, success) {
        try {
            this.voidStalePending();
            // LIFO：插入序末位 = 最近铸造（Map 迭代序保证）
            let lastSeq = null;
            for (const seq of this.pending.keys())
                lastSeq = seq;
            if (lastSeq === null)
                return null;
            const pending = this.pending.get(lastSeq) ?? null;
            if (pending === null)
                return null;
            if (!nonEmptyStr(actualType))
                return null; // 见证缺席 ⇒ 挂起（60s 作废律收口）
            const settled = settleProphecy(pending, String(actualType), this.worldModel);
            // Dyna 回灌：真实转移喂模型（先 surprise 后 observe —— settleProphecy 已读
            // 惊异，此处才入账学习；回灌故障吞掉 —— 审计绝不为学习停摆）。
            // ΑΩ-R18 三写：from 侧 {原始, 量化格, 粗格}（去重 —— 非 hex/短屏型三键
            // 合一即单写，旧方言观察计数不翻倍）；to 侧一律量化身份 —— 表内目的地
            // 与铸造梯级、结算比对共用同一把量化尺（键粒度两侧一致，方言不串）。
            // 原始键一写是 D-G2 既有积累面的延续（字节级复现通道的证据源）。
            if (this.learn && this.worldModel && typeof this.worldModel.observe === 'function') {
                try {
                    const witness = quantizedScreenType(String(actualType));
                    const fromKeys = new Set([
                        settled.screenType,
                        quantizedScreenType(settled.screenType),
                        coarseScreenType(settled.screenType),
                    ]);
                    for (const key of fromKeys) {
                        this.worldModel.observe(key, settled.actionKey, witness, success !== false);
                    }
                }
                catch { /* 回灌故障吞掉 */ }
            }
            this.pending.delete(lastSeq);
            this.ledger.push(settled);
            if (this.ledger.length > this.capacity) {
                const evicted = this.ledger.length - this.capacity;
                this.ledger.splice(0, evicted); // 环形逐出最旧
                this.evictedTotal += evicted; // 水位线的驱逐补偿
            }
            if (this.surpriseFeedTarget !== null) {
                this.feedSurprise(this.surpriseFeedTarget); // D-G2：新入账失手即喂（旁路吞错）
            }
            return settled;
        }
        catch {
            this.pending.clear(); // 结算故障吞掉 —— 丢预言不炸环
            return null;
        }
    }
    /**
     * 惊异喂养通道（D-G2；拉取面）：把水位线之后新入账的失手记录逐条喂给
     * target.ingest，返回实喂条数。水位线 = 已扫视入账总数（环形驱逐由
     * evictedTotal 补偿 —— 逐出只平移索引，不改扫视史）；重复调用零重喂。
     * target 缺席/坏形状 ⇒ 0；单条 ingest 抛错 ⇒ 吞掉（该条计丢不计喂），
     * 绝不炸环。命中/无知记录跳过但仍记扫视（surpriseRunRecord 的 null 面）。
     * 永不抛。
     */
    feedSurprise(target) {
        try {
            if (!target || typeof target.ingest !== 'function')
                return 0;
            let fed = 0;
            // 水位线是绝对入账位（自构造起单调）；当前索引 = 绝对位 − 累计逐出。
            // 逐出先于扫视的记录已不在账上 —— 越过（诚实跳过：证据被环形律逐出，
            // 喂养面不回捞磁盘外历史）。
            let i = this.fedCursor - this.evictedTotal;
            if (i < 0) {
                this.fedCursor = this.evictedTotal;
                i = 0;
            }
            for (; i < this.ledger.length; i++) {
                this.fedCursor++; // 先记扫视（喂失败也不重扫 —— 旁路不重试）
                const run = surpriseRunRecord(this.ledger[i]);
                if (run === null)
                    continue;
                try {
                    target.ingest(run);
                    fed++;
                }
                catch { /* 喂养通道故障吞掉 —— 绝不为喂养炸审计主体 */ }
            }
            return fed;
        }
        catch {
            return 0; // 喂养绝不抛（运行层铁律）
        }
    }
    /** 账本只读副本（入账序；外部不得原地改 —— 副本隔离） */
    records() {
        try {
            return this.ledger.map(r => ({ ...r }));
        }
        catch {
            return [];
        }
    }
    /** 统计面 = prophecyStats(账本) + 引擎生命体征（挂起/作废/容量） */
    stats() {
        try {
            this.voidStalePending();
            return {
                ...prophecyStats(this.ledger),
                pending: this.pending.size,
                expired: this.expiredCount,
                capacity: this.capacity,
            };
        }
        catch {
            return {
                settled: 0, hits: 0, misses: 0, noModel: 0,
                hitRate: 0, missRate: 0, avgMissSurpriseBits: 0, coarseAssisted: 0, topMisses: [],
                pending: 0, expired: 0, capacity: this.capacity,
            };
        }
    }
    /** 账本快照（checkpoint 消费面）：记录 + 作废计数。永不抛。 */
    dump() {
        try {
            this.voidStalePending();
            return {
                version: 1,
                records: this.ledger.map(r => ({ ...r })),
                expired: this.expiredCount,
            };
        }
        catch {
            return { version: 1, records: [], expired: 0 };
        }
    }
    /**
     * 快照水合（防御式整体替换）：任一行非法即跳过该行（半水合诚实 —— 好行
     * 入账、坏行弃置）；快照整体非法 ⇒ 原账本保持不动。永不抛。
     */
    restore(snapshot) {
        try {
            if (!snapshot || typeof snapshot !== 'object')
                return;
            const s = snapshot;
            if (!Array.isArray(s.records))
                return;
            const next = [];
            for (const row of s.records) {
                const r = row;
                if (!r || typeof r !== 'object')
                    continue;
                if (!nonEmptyStr(r.screenType) || !nonEmptyStr(r.actionKey))
                    continue;
                if (typeof r.ts !== 'number' || !Number.isFinite(r.ts))
                    continue;
                if (r.outcome !== 'hit' && r.outcome !== 'miss' && r.outcome !== 'no-model')
                    continue; // pending 不入账
                const rec = {
                    screenType: String(r.screenType),
                    actionKey: String(r.actionKey),
                    outcome: r.outcome,
                    ts: r.ts,
                };
                if (nonEmptyStr(r.predictedType))
                    rec.predictedType = String(r.predictedType);
                if (r.predictedVia === 'exact' || r.predictedVia === 'quant' || r.predictedVia === 'coarse') {
                    rec.predictedVia = r.predictedVia; // D-G2/ΑΩ-R18：来源层白名单（域外值弃置）
                }
                if (typeof r.predictedProb === 'number' && Number.isFinite(r.predictedProb)) {
                    rec.predictedProb = Math.min(1, Math.max(0, r.predictedProb));
                }
                if (typeof r.surpriseBits === 'number' && Number.isFinite(r.surpriseBits) && r.surpriseBits >= 0) {
                    rec.surpriseBits = r.surpriseBits;
                }
                if (nonEmptyStr(r.actualType))
                    rec.actualType = String(r.actualType);
                next.push(rec);
            }
            this.ledger = next.slice(Math.max(0, next.length - this.capacity)); // 容量律同裁
            if (typeof s.expired === 'number' && Number.isFinite(s.expired) && s.expired >= 0) {
                this.expiredCount = Math.floor(s.expired);
            }
            this.pending.clear(); // 挂起不可序列化 —— 水合即清（诚实：跨进程的未验预言作废）
            // D-G2：水合后喂养水位线直抵账尾（已在册记录视为已消化 —— 与「挂起不可
            // 序列化 ⇒ 水合即清」同律：跨进程的喂养账不复存在，保守不重喂；重喂会使
            // 进化侧失手双计。dump/restore 消费面如需重喂自可直调 surpriseRunRecord）。
            this.fedCursor = this.ledger.length;
            this.evictedTotal = 0;
        }
        catch { /* 水合绝不抛（运行层铁律） */ }
    }
}
/**
 * 预言世界模型单例（纪元 Ε 生产接线）：进程内跨 run 存活 —— 每次结算的
 * observe 回灌在此累积，模型逐步走出无知（第二次遇见同一条路就有预言）。
 * 零持久化（与 InMemoryWorldModel 同律 —— 落盘是留白，checkpoint 消费
 * dump/restore 面）。
 */
export const prophecyWorldModel = new InMemoryWorldModel();
