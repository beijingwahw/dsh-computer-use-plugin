// src/selfmodel/index.ts
// 纪元 Ι（自我模型）：经验胜任度后验 —— agent 在（动作类 × 场景桶）格子上
// 维护衰减 Beta 后验，认识论闸门从此拿到「实测校准置信」而非模型自报置信。
//
// 立意（世界级 novelty）：GUI agent 普遍「不知道自己不擅长什么」——纪元 Η 的
// 认识论闸门消费的是动作自报置信（主观，policyEngine 的元素匹配分），Ι 给
// agent 装上**经验胜任度后验**：每个格子按历史成败维护 Beta(s+1, f+1) 后验，
// 旧战绩按半衰期指数衰减（上周的战果不该无限背书今天的我）。闸门改用后验
// 均值后，agent 在自己历史上反复失败的格子前面**真正知道怕**。
//
// 诚实铁律（与 worldModel 同源）：冷启动/证据不足 ⇒ null —— 绝不返回 0.5
// 假数据，绝不把「没做过」伪装成「做不成」，也绝不伪装成「做得成」。
// 运行层铁律：本模块一切公开面永不抛异常（坏 cell/坏时间戳/坏快照全吸收）。
//
// 数学：
//   · 衰减（懒结算）：格子内 (s, f) 计数在每次触达时按 factor = 2^(−age/halfLife)
//     一次性折算（age = now − lastTs）——等价于每条历史战绩按其年龄独立衰减
//     （同批战绩同 factor ⇒ 与逐条衰减严格等价，O(1) 而非 O(n)）。
//   · 后验：s 成 f 败 ⇒ Beta(α=s+1, β=f+1)（Laplace/Jeffreys 型均匀先验 +1）；
//     mean = (s+1)/(s+f+2)；95% 可信区间取正态近似 mean ± 1.96·sd，
//     sd = sqrt(αβ/((α+β)²(α+β+1)))，夹 [0,1]。
//   · 场景桶：64 位 dhash 指纹（WorldSnapshot.dhash / contextManager 记录的
//     '0'/'1' 位串）量化成 24bit 两段式桶（W8-B5 精化，原 16bit）—— 粗段
//     16bit：8×8 网格按 2×2 分块共 4×4 块，每块均值阈值位图（块内 1 的个数
//     ≥2 记 1），与旧 16bit 桶逐位同律（新桶串前 4 位十六进制 = 旧桶）；
//     细段 8bit：行密度位图（每行 8 位中 ≥4 个 1 记 1）—— 粗段只答「大致在
//     哪片区域」，细段补「纵向密度分布」，两段正交互补（粗段相同的两个指纹
//     可被细段分开 —— 旧 16bit 的混桶由此精化）。指纹字段缺席 ⇒ 只用
//     actionKind 单轴（诚实降级，绝不伪造场景）。
//
// 接线（纪元 Ι）：autoPilot 认识论闸门消费 adviseConfidence（缺席/null ⇒
// 纪元 Η 自报链逐字节不变）；buildAutonomyStack 经 config.enableSelfModel
// 铸本单例进栈；get_metrics 经 introspect 暴露自省面。configure/reset 由
// 主控（src/index.ts，本纪元禁改）接线 —— 单例在此导出备铸。
/** 缺省参数（config 三键同值）：诚实冷启动 8 条证据起步、记忆半衰一周 */
const DEFAULT_MIN_EVIDENCE = 8;
const DEFAULT_HALF_LIFE_H = 168;
/** competence 读数的证据下限：有效证据 <1 视为冷启动（诚实无知 ⇒ null） */
const EVIDENCE_FLOOR = 1;
/** Beta 可信区间正态近似 z 值（95% 双侧） */
const Z95 = 1.96;
/** 衰减权重的数值下界：低于此按 0 计（防永久残尾） */
const WEIGHT_EPSILON = 1e-9;
/** W6-2（doctor smell.magic-number 清偿）：dhash 位串合法长度（row-major 8×8 网格），数值逐位不变 */
const DHASH_BITSTRING_LEN = 64;
/** W8-B5：桶串合法长度 —— 24bit 两段式（16bit 粗段 + 8bit 细段）= 6 位十六进制 */
const BUCKET_HEX_LEN = 6;
/** W8-B5：旧 16bit 粗桶串长度（4 位十六进制）—— 仅迁移面承认，不再铸造/直通 */
const LEGACY_BUCKET_HEX_LEN = 4;
/** W8-B5：细段行密度阈值 —— 8 位行中 ≥4 个 1 记 1（多数律，与粗段块阈值 2/4 同门） */
const FINE_ROW_THRESHOLD = 4;
/**
 * 场景桶量化（纯函数）：64 位 '0'/'1' dhash 位串 → 24bit 两段式桶（6 位十六进制串）。
 *
 * 粗段 16bit（与旧 16bit 桶逐位同律）：8×8 网格按 2×2 分块共 4×4 块，块 (R,C)
 * 覆盖行 {2R,2R+1} × 列 {2C,2C+1}；块内 1 的个数 ≥2（均值阈值 0.5）记 1，位序
 * R·4+C —— 与 worldModel transitionActionKey 的 TYPE_QUANTIZE=4 同一门方言
 * （「大致在哪片」，不记精确位）。
 * 细段 8bit（W8-B5 精化）：行 row（0..7）的 8 位中 1 的个数 ≥4 记 1，位序 row ——
 * 纵向密度分布信号，与粗段区域信号部分正交（粗段相同的指纹可被细段分开）。
 * 布局：粗段占高 16bit、细段占低 8bit ⇒ **新桶串前 4 位十六进制 = 旧 16bit 桶**
 * （前缀保持性质 —— 调试与迁移面一眼对上旧方言）。
 * 输入宽容性：已是 6 位十六进制桶串 ⇒ 原样归一化直通（幂等：桶化桶还是桶）；
 * 旧 4 位十六进制粗桶串 ⇒ **null**（W8-B5 方言收窄）—— 细段在旧量化时已丢失，
 * 粗→细是一对多、不可恢复，直通等于伪造细段（诚实律：宁可降级，绝不伪造）；
 * 其它一切（缺字段/摘要文本/非串等）⇒ null —— 诚实降级到 actionKind 单轴。
 * 永不抛异常。
 */
export function sceneBucketFromFingerprint(fingerprint) {
    try {
        if (typeof fingerprint !== 'string')
            return null;
        const fp = fingerprint.trim();
        // 已量化桶串直通（幂等：桶化桶还是桶 —— 新方言 24bit/6 位十六进制）
        if (fp.length === BUCKET_HEX_LEN && /^[0-9a-f]+$/i.test(fp))
            return fp.toLowerCase();
        // 64 位 dhash 位串（row-major 8×8）→ 24bit 两段式桶
        if (fp.length === DHASH_BITSTRING_LEN && /^[01]+$/.test(fp)) {
            let coarse = 0;
            for (let r = 0; r < 4; r++) {
                for (let c = 0; c < 4; c++) {
                    // 块内 4 位：行 2r/2r+1 × 列 2c/2c+1（位索引 = row·8 + col）
                    let ones = 0;
                    for (const row of [2 * r, 2 * r + 1]) {
                        for (const col of [2 * c, 2 * c + 1]) {
                            if (fp[row * 8 + col] === '1')
                                ones++;
                        }
                    }
                    if (ones >= 2)
                        coarse |= 1 << (r * 4 + c);
                }
            }
            let fine = 0;
            for (let row = 0; row < 8; row++) {
                let ones = 0;
                for (let col = 0; col < 8; col++) {
                    if (fp[row * 8 + col] === '1')
                        ones++;
                }
                if (ones >= FINE_ROW_THRESHOLD)
                    fine |= 1 << row;
            }
            return (coarse * 0x100 + fine).toString(16).padStart(BUCKET_HEX_LEN, '0');
        }
        return null;
    }
    catch {
        return null; // 量化绝不抛（运行层铁律）
    }
}
/** 旧 16bit 粗桶串判定（迁移面专用）：4 位十六进制（大小写宽容 —— 篡改档同律聚合） */
function isLegacyBucket(bucket) {
    return bucket.length === LEGACY_BUCKET_HEX_LEN && /^[0-9a-f]+$/i.test(bucket);
}
/**
 * 格子键（纯函数）：actionKind 单轴或 actionKind|sceneBucket 双轴；永不抛。
 * W8-B5 方言执法：入账桶串必须是 6 位十六进制（新粒度）；旧 4 位粗桶/垃圾桶串
 * ⇒ 诚实降级为单轴键（与「sceneBucket 非法 ⇒ 单轴」既有同律 —— 细段不可恢复，
 * 不伪造新粒度格子）。写读同律 ⇒ dump 只落新方言键，快照往返逐字段等价。
 */
function cellKey(cell) {
    try {
        const kind = cell && typeof cell.actionKind === 'string' ? cell.actionKind.trim() : '';
        if (kind === '')
            return null;
        const raw = cell.sceneBucket;
        const bucket = typeof raw === 'string' && raw.trim().length === BUCKET_HEX_LEN && /^[0-9a-f]+$/i.test(raw.trim())
            ? raw.trim().toLowerCase()
            : null;
        return bucket === null ? kind : `${kind}|${bucket}`;
    }
    catch {
        return null;
    }
}
/** 安全时钟读数：注入钟缺席/抛错 ⇒ Date.now；永不抛 */
function safeNow(injected) {
    try {
        if (typeof injected === 'function') {
            const t = injected();
            if (typeof t === 'number' && Number.isFinite(t))
                return t;
        }
    }
    catch { /* 坏钟 ⇒ 系统钟兜底 */ }
    return Date.now();
}
/**
 * 内存自我模型（衰减 Beta 胜任度后验账本）。
 * 零持久化（dump/restore 纯数据面，供 checkpoint 未来消费）；GC 即归零。
 * 一切公开面永不抛异常；enabled=false ⇒ 记录面静默 no-op、读取面诚实 null。
 */
export class SelfModel {
    /** 格子账本：key → 衰减成败计数 + 懒结算基准 */
    cells = new Map();
    enabled = true;
    minEvidence = DEFAULT_MIN_EVIDENCE;
    halfLifeH = DEFAULT_HALF_LIFE_H;
    now;
    /**
     * 配置注入（部分覆盖语义：只改给出的键，其余保持 —— 重复调用幂等无害）。
     * 非法值逐键回退缺省（enabled 非布尔忽略；minEvidence 非有限数或 <1 ⇒ 8；
     * halfLifeH 非有限数或 ≤0 ⇒ 168）。永不抛异常。
     */
    configure(opts) {
        try {
            if (!opts || typeof opts !== 'object')
                return;
            if (typeof opts.enabled === 'boolean')
                this.enabled = opts.enabled;
            if (typeof opts.minEvidence === 'number' && Number.isFinite(opts.minEvidence) && opts.minEvidence >= 1) {
                this.minEvidence = opts.minEvidence;
            }
            if (typeof opts.halfLifeH === 'number' && Number.isFinite(opts.halfLifeH) && opts.halfLifeH > 0) {
                this.halfLifeH = opts.halfLifeH;
            }
            if (typeof opts.now === 'function')
                this.now = opts.now;
        }
        catch { /* 配置绝不抛（运行层铁律） */ }
    }
    /** 全量归零（会话边界/测试隔离；配置保留 —— 只清账本） */
    reset() {
        this.cells.clear();
    }
    /** 半衰期（毫秒）：小时 × 3.6e6；已由 configure 保证有限正数 */
    halfLifeMs() {
        return this.halfLifeH * 3_600_000;
    }
    /**
     * 懒衰减结算（内部件）：把格子的 (s, f) 折算到时刻 t。
     * factor = 2^(−(t−lastTs)/halfLifeMs)；时间倒流（t < lastTs）按 factor=1 容忍。
     * 结算后 lastTs = max(lastTs, t)。永不抛。
     */
    settle(stat, t) {
        const age = t - stat.lastTs;
        if (age > 0) {
            const factor = Math.pow(2, -age / this.halfLifeMs());
            if (Number.isFinite(factor) && factor >= 0) {
                stat.s = stat.s < WEIGHT_EPSILON ? 0 : stat.s * factor;
                stat.f = stat.f < WEIGHT_EPSILON ? 0 : stat.f * factor;
            }
        }
        if (t > stat.lastTs)
            stat.lastTs = t;
    }
    /**
     * 记录面：一格战绩入账（ok=true 成 / false 败）。
     * ts 非有限数 ⇒ 注入钟（缺省系统钟）兜底；坏 cell（null/非对象/空 actionKind）
     * ⇒ 静默吸收；sceneBucket 非法或旧 4 位粗桶方言（W8-B5 收窄）⇒ 诚实降级为
     * actionKind 单轴格（细段不可恢复 ⇒ 不伪造新粒度格子）。永不抛。
     */
    recordOutcome(cell, ok, ts) {
        try {
            if (!this.enabled)
                return;
            if (ok !== true && ok !== false)
                return; // 结局必须是真布尔 —— 垃圾结局不入账
            const key = cellKey(cell);
            if (key === null)
                return; // 坏 cell 吸收（诚实：无法归位的战绩不入账）
            const t = typeof ts === 'number' && Number.isFinite(ts)
                ? ts
                : safeNow(this.now);
            let stat = this.cells.get(key);
            if (!stat) {
                stat = { s: 0, f: 0, lastTs: t };
                this.cells.set(key, stat);
            }
            this.settle(stat, t);
            if (ok)
                stat.s += 1;
            else
                stat.f += 1;
        }
        catch { /* 记录绝不抛（运行层铁律） */ }
    }
    /**
     * 读取面：一格胜任度后验（Beta(α=s+1, β=f+1) 的均值与 95% 可信区间）。
     * 冷启动（格子无账/有效证据 <1/模型禁用）⇒ null —— 诚实无知，绝不返回
     * 0.5 假数据。读取即懒结算（衰减在触达时折算）。永不抛。
     */
    competence(cell) {
        try {
            if (!this.enabled)
                return null;
            const key = cellKey(cell);
            if (key === null)
                return null;
            const stat = this.cells.get(key);
            if (!stat)
                return null;
            this.settle(stat, safeNow(this.now));
            const s = Math.max(0, stat.s);
            const f = Math.max(0, stat.f);
            const n = s + f;
            if (!Number.isFinite(n) || n < EVIDENCE_FLOOR)
                return null; // 冷启动诚实
            const alpha = s + 1;
            const beta = f + 1;
            const total = alpha + beta;
            const mean = alpha / total;
            const sd = Math.sqrt((alpha * beta) / (total * total * (total + 1)));
            const lo = Math.min(1, Math.max(0, mean - Z95 * sd));
            const hi = Math.min(1, Math.max(0, mean + Z95 * sd));
            return { n, mean, ciLow: lo, ciHigh: hi, empirical: true };
        }
        catch {
            return null; // 读取绝不抛（运行层铁律）
        }
    }
    /**
     * 闸门建议面：给认识论闸门的经验校准置信。
     * action 取字符串（工具名/动作类）或带 kind 的动作对象；sceneFingerprint 取
     * 原始指纹（64 位 dhash 位串或已是 6 位十六进制新桶串；旧 4 位粗桶不可再铸
     * 细段 ⇒ null 同降级）—— 桶量化在本面内完成，调用方零方言。
     * 有效证据 n < minEvidence（含冷启动 null/模型禁用）⇒ null —— 不掺入闸门
     * （诚实冷启动：宁可走纪元 Η 自报链，不伪造经验）。永不抛。
     */
    adviseConfidence(action, sceneFingerprint) {
        try {
            if (!this.enabled)
                return null;
            const kind = typeof action === 'string'
                ? action.trim()
                : action && typeof action === 'object' && typeof action.kind === 'string'
                    ? action.kind.trim()
                    : '';
            if (kind === '')
                return null;
            const bucket = sceneBucketFromFingerprint(sceneFingerprint);
            const report = this.competence(bucket === null ? { actionKind: kind } : { actionKind: kind, sceneBucket: bucket });
            if (report === null || report.n < this.minEvidence)
                return null;
            if (!Number.isFinite(report.mean) || report.mean < 0 || report.mean > 1)
                return null;
            return { confidence: report.mean, n: report.n, source: 'self-model' };
        }
        catch {
            return null; // 建议绝不抛（运行层铁律）
        }
    }
    /** 全部格子（内部枚举前的懒结算快照；结算异常的格子跳过） */
    settledEntries() {
        const t = safeNow(this.now);
        const out = [];
        for (const [key, stat] of this.cells) {
            try {
                this.settle(stat, t);
            }
            catch { /* 单格结算故障不拖垮自省面 */ }
            const s = Math.max(0, stat.s);
            const f = Math.max(0, stat.f);
            const n = s + f;
            if (!Number.isFinite(n) || n < EVIDENCE_FLOOR)
                continue;
            const alpha = s + 1;
            const beta = f + 1;
            out.push({
                key,
                cell: key.includes('|')
                    ? { actionKind: key.slice(0, key.indexOf('|')), sceneBucket: key.slice(key.indexOf('|') + 1) }
                    : { actionKind: key },
                report: { n, mean: alpha / (alpha + beta), ciLow: 0, ciHigh: 1, empirical: true },
            });
        }
        return out;
    }
    /**
     * 自省面：最擅长的 k 个格子（Beta 均值降序；并列按证据量多者优先、再按键
     * 字典序 —— 全序确定，绝不掷硬币）。证据不足（n<1）的格子不入榜。永不抛。
     */
    topCells(k) {
        return this.rankedCells(k, false);
    }
    /**
     * 自省面：最不擅长的 k 个格子（Beta 均值升序；并列同上确定序）。
     * 「知道自己不擅长什么」正是本纪元的立意 —— 榜单供 get_metrics 自省。永不抛。
     */
    bottomCells(k) {
        return this.rankedCells(k, true);
    }
    /** 排序实现件（topCells/bottomCells 共用；坏 k ⇒ 空榜） */
    rankedCells(k, ascending) {
        try {
            if (typeof k !== 'number' || !Number.isFinite(k) || k <= 0)
                return [];
            const rows = this.settledEntries()
                .map(e => ({ cell: e.cell, n: e.report.n, mean: e.report.mean }))
                .sort((a, b) => {
                const byMean = ascending ? a.mean - b.mean : b.mean - a.mean;
                if (Math.abs(byMean) > 1e-12)
                    return byMean;
                if (a.n !== b.n)
                    return b.n - a.n; // 并列：证据多者胜（更可信的读数优先）
                return a.cell.actionKind < b.cell.actionKind ? -1 : a.cell.actionKind > b.cell.actionKind ? 1 : 0;
            });
            return rows.slice(0, Math.floor(k));
        }
        catch {
            return []; // 自省绝不抛（运行层铁律）
        }
    }
    /** 库存快照：总格子数（含未结算全部）+ 总有效证据量（结算后求和） */
    stats() {
        try {
            const entries = this.settledEntries();
            let evidence = 0;
            for (const e of entries)
                evidence += e.report.n;
            return { cells: this.cells.size, evidence: Number.isFinite(evidence) ? evidence : 0 };
        }
        catch {
            return { cells: this.cells.size, evidence: 0 };
        }
    }
    /**
     * 可观测内省面（get_metrics 消费）：禁用 ⇒ null（字段整体缺席）；
     * 在场 ⇒ 总格子数 + 总证据量 + top/bottom 各 k 条。永不抛。
     */
    introspect(k = 3) {
        try {
            if (!this.enabled)
                return null;
            const stats = this.stats();
            return {
                cells: stats.cells,
                evidence: Math.round(stats.evidence * 1e6) / 1e6, // 展示精度（防浮点尾长）
                top: this.topCells(k),
                bottom: this.bottomCells(k),
            };
        }
        catch {
            return null; // 内省绝不抛（运行层铁律）
        }
    }
    /**
     * 纯数据快照（checkpoint 消费面）：结算时刻 + 格子账本。
     * 键序按 Map 插入序稳定（确定性序列化）。永不抛。
     */
    dump() {
        const t = safeNow(this.now);
        const cells = [];
        for (const [key, stat] of this.cells) {
            try {
                this.settle(stat, t);
            }
            catch { /* 单格结算故障不拖垮快照 */ }
            cells.push({ key, s: Math.max(0, stat.s), f: Math.max(0, stat.f), lastTs: stat.lastTs });
        }
        return { version: 1, settledAt: t, cells };
    }
    /**
     * 快照水合（checkpoint 恢复面）：防御式整体替换 —— 任一行非法即跳过该行
     * （半水合诚实：好行入账、坏行弃置，绝不因一行脏数据丢整本账）。永不抛。
     *
     * W8-B5 迁移语义（旧 16bit 桶键 → 新 24bit 粒度）：
     *   旧档键形如 'click_mouse|f3a0'（4 位十六进制粗桶）。粗→细不可映射（细段
     *   行密度在旧量化时已丢，一对多）⇒ **不伪造新粒度格子**；但细→粗可映射 ——
     *   旧场景格是 actionKind 单轴格（全场景并集语义）的严格细分种群，且格子种群
     *   本就不相交（每条战绩恰入一格）⇒ 聚合（计数求和 + lastTs 取 max）进单轴格
     *   是**无损并集**，非冷启动丢证。聚合时旧计数按各自 lastTs 先折算到并集
     *   lastTs（懒衰减数学，restore 内一次折算）—— 不同时点的证据不在同一基准
     *   上相加。新 6 位桶键与其余键原样入账（快照往返逐字段等价不破）。
     */
    restore(snapshot) {
        try {
            if (!snapshot || typeof snapshot !== 'object')
                return;
            const snap = snapshot;
            if (!Array.isArray(snap.cells))
                return;
            const next = new Map();
            /** 细→粗聚合：把一行旧场景格账并进单轴格（同 ts 基准折算后求和；缺则建格） */
            const mergeIntoAxis = (kind, s, f, lastTs) => {
                const existing = next.get(kind);
                if (!existing) {
                    next.set(kind, { s, f, lastTs });
                    return;
                }
                const target = Math.max(existing.lastTs, lastTs);
                const hl = this.halfLifeMs();
                // 每笔计数从自己的 lastTs 折算到 target（target ≥ from ⇒ factor ≤ 1；绝不放大）
                const decay = (v, from) => v <= 0 ? 0 : v * Math.pow(2, -(target - from) / hl);
                next.set(kind, {
                    s: decay(existing.s, existing.lastTs) + decay(s, lastTs),
                    f: decay(existing.f, existing.lastTs) + decay(f, lastTs),
                    lastTs: target,
                });
            };
            for (const row of snap.cells) {
                const r = row;
                if (!r || typeof r.key !== 'string' || r.key.trim() === '' || r.key.includes('\n'))
                    continue;
                if (typeof r.s !== 'number' || !Number.isFinite(r.s) || r.s < 0)
                    continue;
                if (typeof r.f !== 'number' || !Number.isFinite(r.f) || r.f < 0)
                    continue;
                if (typeof r.lastTs !== 'number' || !Number.isFinite(r.lastTs))
                    continue;
                if (r.s + r.f <= 0)
                    continue; // 空格子不入账
                // W8-B5 迁移面：kind|旧16bit粗桶 ⇒ 聚合进 kind 单轴格（见方法注释）；
                // kind 需 trim 稳定（真旧档键由 cellKey 铸造时已 trim；带空格的篡改键
                // 不迁移、按原样保留为死格 —— 不因迁移面引入新键）
                const bar = r.key.indexOf('|');
                if (bar > 0) {
                    const kind = r.key.slice(0, bar);
                    const bucket = r.key.slice(bar + 1);
                    if (kind.trim() === kind && isLegacyBucket(bucket)) {
                        mergeIntoAxis(kind, r.s, r.f, r.lastTs);
                        continue;
                    }
                }
                next.set(r.key, { s: r.s, f: r.f, lastTs: r.lastTs });
            }
            this.cells = next;
        }
        catch { /* 水合绝不抛（运行层铁律） */ }
    }
}
/**
 * 自我模型单例（纪元 Ι 生产接线）：buildAutonomyStack 经
 * config.enableSelfModel 铸进自主闭环栈；get_metrics 经 introspect 自省。
 */
export const selfModel = new SelfModel();
/**
 * 配置面（主控接线口）：src/index.ts 禁改（纪元 Ι），主控在 apply 时把 config
 * 三键（enableSelfModel/selfModelMinEvidence/selfModelHalfLifeH）经此灌入单例；
 * 未灌入时缺省（true/8/168）即生产语义。部分覆盖语义，永不抛。
 */
export function configureSelfModel(opts) {
    selfModel.configure(opts);
}
/** 会话边界归零面（主控接线口）：清账本、留配置（与插件卸载清理序列同律） */
export function resetSelfModel() {
    selfModel.reset();
}
