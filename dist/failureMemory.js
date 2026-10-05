// src/failureMemory.ts
// 第六轮创新之二：失败记忆（Anti-Skill，反技能）。
// 技能库学习「什么有效」，本模块学习「什么无效」—— 两条记忆对称共存：
//   记录：熔断触发时自动捕获（场景指纹 + 动作签名 + 症状）
//   （ΑΩ-R34：旧注释称「手动 remember_failure + …」—— 该工具面在本插件从未
//    注册（全史仅此注释行），实际唯一写入方是 circuitBreakerGuard 自动接线）
//   检索：match_skill 召回技能时同步附上「同场景已知失败路径」，先验正负对照
// 价值：大多数系统只从成功学习；而一次探索中验证过的死路，本会话内不必再走第二遍。
import { similarity } from './perceptualHash.js';
import { tokenize, overlapCoefficient } from './uiMemory.js';
import { ncdSimilarity } from './ncd.js';
import { kernelRegistry } from './kernel/registry.js';
import { parseRootCause } from './diagnosis.js'; // W1-6：R1 根因归因链的病因命名空间
/** W1-6：记录的有效病因（无字段/垃圾值 ⇒ unknown —— 与 parseRootCause 同律） */
function effectiveRootCause(r) {
    return r.rootCause === undefined ? 'unknown' : parseRootCause(r.rootCause);
}
// ── W8-B5：显著性淘汰常量（纯 FIFO → 显著性感知；数值全是字面量，注入钟下确定）──
/** 缺省库容 30（历史值 —— 既有语义钉死，configure 可覆盖） */
const DEFAULT_CAPACITY = 30;
/** 新近性半衰期（毫秒）：24h —— 旧失败的价值随年龄折半让位新失败 */
const SALIENCE_HALF_LIFE_MS = 24 * 3_600_000;
/** 拥挤罚系数：同根因桶每多一条兄弟，显著性 −0.5（单一根因挤占库容时其成员先让位） */
const CROWD_PENALTY = 0.5;
/** 去重命中数归一封顶：第 3 次踩同一条死路后再踩不再加权（活性信号饱和） */
const REPEAT_CAP = 3;
class FailureMemory {
    records = [];
    nextId = 1;
    capacity = DEFAULT_CAPACITY;
    /** 注入时钟（测试确定性生命线；缺省 Date.now） */
    nowFn;
    /**
     * 近重复去重命中数（W8-B5 显著性维度之三）：id → 次数。
     * 铁律：记录五元组结构不变（checkpoint 兼容）⇒ 命中数**不落盘**——它是会话内
     * 活性信号，恢复后归零是诚实降级（不伪造跨会话命中史）。
     */
    dedupHits = new Map();
    /**
     * 配置注入（W8-B5：容量可配置 + 注入时钟；部分覆盖语义，重复调用幂等无害）。
     * 非法值逐键忽略（capacity 非有限正整数忽略；now 非函数忽略）—— 永不抛。
     * 收缩库容时即刻按显著性淘汰到新上限（扩容无操作）；时钟先于库容生效。
     */
    configure(opts = {}) {
        try {
            if (!opts || typeof opts !== 'object')
                return;
            if (typeof opts.now === 'function')
                this.nowFn = opts.now;
            if (typeof opts.capacity === 'number' && Number.isFinite(opts.capacity)
                && Number.isInteger(opts.capacity) && opts.capacity >= 1) {
                this.capacity = opts.capacity;
                this.evictTo(this.safeNow());
            }
        }
        catch { /* 配置绝不抛 */ }
    }
    /** 安全时钟读数：注入钟缺席/抛错/坏值 ⇒ Date.now；永不抛（selfmodel 同律） */
    safeNow() {
        try {
            if (typeof this.nowFn === 'function') {
                const t = this.nowFn();
                if (typeof t === 'number' && Number.isFinite(t))
                    return t;
            }
        }
        catch { /* 坏钟 ⇒ 系统钟兜底 */ }
        return Date.now();
    }
    /**
     * 显著性感知淘汰（W8-B5：替代纯 FIFO shift）。容量超限 ⇒ 逐出显著性最低者。
     * 三维显著性（低者先走；并列取 id 升序 —— 全序确定，注入钟下逐字节可复现）：
     *   · 新近性：2^(−age/24h 半衰期) —— 昨天的死路比上个月的相关；
     *   · 重复度：近重复去重命中数（封顶 3 归一）—— 反复踩中的死路比孤例值得留；
     *   · 拥挤罚：同根因桶每多一条兄弟 −0.5 —— 同根因不挤占全部名额的软执法。
     * 硬配额（独苗保护）：某根因桶只剩 1 条且存在 ≥2 条的桶 ⇒ 独苗免逐 ——
     * 根因多样性的下限执法（只要还有别的桶在占多名额，最后一个异见根因不走）。
     * 退化特例：全库同根因（无桶 ≥2）⇒ 拥挤罚同配、按新近性/id 决胜 —— 与旧
     * FIFO 同向（id 升序 = 先入先出）。记录五元组结构零改动（铁律）。
     */
    evictTo(t) {
        while (this.records.length > this.capacity) {
            const victim = this.pickVictim(t);
            if (!victim)
                break; // 防御：空库/理论不可达
            this.records = this.records.filter(r => r !== victim);
            this.dedupHits.delete(victim.id);
        }
    }
    /** 选逐出者：显著性最低者；并列 id 升序（先入者先走）。永不抛 */
    pickVictim(t) {
        if (this.records.length === 0)
            return null;
        // 根因分桶计数（effectiveRootCause：旧记录无字段 ⇒ unknown 桶）
        const counts = new Map();
        for (const r of this.records) {
            const c = effectiveRootCause(r);
            counts.set(c, (counts.get(c) ?? 0) + 1);
        }
        // 独苗保护：存在 ≥2 条的桶 ⇒ 候选池排除独苗（同根因不挤占全部名额的硬下限）
        const crowded = [...counts.values()].some(n => n >= 2);
        const pool = crowded
            ? this.records.filter(r => (counts.get(effectiveRootCause(r)) ?? 0) >= 2)
            : this.records;
        if (pool.length === 0)
            return this.records[0]; // 防御兜底
        let victim = pool[0];
        let victimScore = Infinity;
        for (const r of pool) {
            const age = Math.max(0, t - r.at);
            const recency = Math.pow(2, -age / SALIENCE_HALF_LIFE_MS);
            const repeat = Math.min(this.dedupHits.get(r.id) ?? 0, REPEAT_CAP) / REPEAT_CAP;
            const crowd = ((counts.get(effectiveRootCause(r)) ?? 1) - 1) * CROWD_PENALTY;
            const score = recency + repeat - crowd;
            if (score < victimScore - 1e-12 || (Math.abs(score - victimScore) <= 1e-12 && r.id < victim.id)) {
                victim = r;
                victimScore = score;
            }
        }
        return victim;
    }
    record(query, approach, symptom, sceneHash, rootCause) {
        const t = this.safeNow();
        // 近重复去重：同查询+同路径 5 分钟内不重复记录
        const dup = this.records.find(r => r.query === query && r.approach === approach && t - r.at < 300_000);
        if (dup) {
            dup.at = t;
            // W8-B5：去重命中数 +1（显著性维度之三 —— 反复踩同一条死路 ⇒ 更值得留）
            this.dedupHits.set(dup.id, (this.dedupHits.get(dup.id) ?? 0) + 1);
            // W1-6：重复失败路径刷新病因 —— 鉴别探针的结论比「未归因」新（如旧记录
            // 无 rootCause 而本次归因出 stall）。垃圾值经 parseRootCause 收口。
            if (rootCause !== undefined)
                dup.rootCause = parseRootCause(rootCause);
            return dup;
        }
        const rec = {
            id: this.nextId++, query, approach, symptom, sceneHash, at: t,
            // W1-6：病因防御入库（非法值 ⇒ unknown，不冒充知识）
            ...(rootCause !== undefined ? { rootCause: parseRootCause(rootCause) } : {}),
        };
        this.records.push(rec);
        this.evictTo(t); // W8-B5：显著性淘汰（旧 FIFO 是全同根因时的退化特例）
        return rec;
    }
    /** 匹配：文本重合（query+approach+symptom 全文）+ 同场景加成 + H-2 压缩相似。
     *  H-2 修正注记：symptom 纳入 token hay（症状文本本就可检索 —— 原只搜 query/
     *  approach 是检索面残缺）；NCD 仍只对 symptom 比（可换述的部分，避免 approach
     *  的 ASCII 坐标稀释）。返回「在这个场景/任务下别这么试」的清单
     *  W1-6（R1）：opts.rootCause 在场 ⇒ 先按病因过滤候选池再走三通道 —— 病因
     *  通道与文本通道并存（结构化 narrowing，不替换排序律）；缺省不过滤，零回归。 */
    match(query, currentSceneHash, k = 3, opts) {
        const qTokens = tokenize(query);
        // W1-6：病因过滤（与文本通道并存 —— 池 narrowed，RRF/legacy 排序律不变）
        const pool = opts?.rootCause
            ? this.records.filter(r => effectiveRootCause(r) === opts.rootCause)
            : this.records;
        // R 纪元（R-6 召回层）：RRF 倒数排名融合 —— 三通道（词面重合 / NCD 压缩 /
        // 场景指纹）各排各的名次，融合分 = Σ 1/(60+rankᵢ)（TREC 2003 Cormack 形，
        // k=60 惯例）。为什么不用加权和：三通道分数量纲悬殊（重合系数 [0,1]、
        // NCD 相似 [0,1] 但分布不同、场景是 0/0.4 脉冲）—— 加权需要逐通道定标，
        // 排名是量纲自由的。旧加权和保留为 score2 字段（消费方按需取用，零回归）。
        // 纪元 Ξ（Ξ-D 生产接线）：三常量读内核注册表 —— failure.score2Floor（相关性
        // 闸门，缺省 0.2）/ failure.rrfK（RRF 平滑常数，缺省 60，区间 10..200）/
        // failure.sceneBonus（同场景脉冲，缺省 0.4）。未注册 ⇒ getOrDefault 回声
        // 字面量，召回与排序逐字节不变；每次 match 单次读取。
        const score2Floor = kernelRegistry.getOrDefault('failure.score2Floor', 0.2);
        const RRF_K = Math.round(kernelRegistry.getOrDefault('failure.rrfK', 60));
        const sceneBonus = kernelRegistry.getOrDefault('failure.sceneBonus', 0.4);
        const scored = pool.map(r => {
            const hay = `${r.query} ${r.approach} ${r.symptom}`;
            const text = overlapCoefficient(qTokens, tokenize(hay));
            // H-2 NCD 通道：leet/typo 变体与原文共享长子串（'verificat·on'）而 token
            // 化后零词面命中 —— 词面通道失明处由压缩器兜底。
            const compress = ncdSimilarity(query, r.symptom);
            let scene = 0;
            if (currentSceneHash && r.sceneHash && similarity(currentSceneHash, r.sceneHash) >= 0.9)
                scene = sceneBonus;
            return { r, text, compress, scene };
        });
        // 通道排名（降序；并列取同秩 —— 标准竞争排名：并列者共享首位名次）
        const rank = (key) => {
            const sorted = [...scored].sort((a, b) => b[key] - a[key]);
            const m = new Map();
            let prevVal = null;
            let prevRank = 0;
            sorted.forEach((x, i) => {
                const r = prevVal !== null && x[key] === prevVal ? prevRank : i + 1;
                m.set(x.r, r);
                prevVal = x[key];
                prevRank = r;
            });
            return m;
        };
        const rText = rank('text'), rComp = rank('compress'), rScene = rank('scene');
        return scored
            .map(({ r, text, compress, scene }) => {
            const rrf = 1 / (RRF_K + rText.get(r)) + (compress > 0 ? 1 / (RRF_K + rComp.get(r)) : 0)
                + (scene > 0 ? 1 / (RRF_K + rScene.get(r)) : 0);
            const legacy = Math.round((text + 0.3 * compress + scene) * 1000) / 1000;
            // score = RRF × 量纲还原（×1000 保持旧阈值 0.2 的语义近邻）
            return { ...r, score: Math.round(rrf * 1000 * 1000) / 1000, score2: legacy };
        })
            // Δ-2 过滤修正：RRF 分恒 ≥ 1000/(60+N)（rank ≤ N）—— 旧实现 filter(score>0.2)
            // 对任何非空库恒真（两条记录时下限 16.1），任意查询必召回全部无关失败。
            // 相关性闸门回归 score2（legacy 加权和）域：三通道证据至少其一实质在场
            // （词面重合 / 压缩相似 / 场景指纹）才过闸 —— R-6 之前的既有阈值语义。
            // 排序仍用 score（RRF 排名融合无量纲 —— R-6 的本意只在排序，不在过滤）。
            .filter(r => r.score2 > score2Floor)
            .sort((a, b) => b.score - a.score)
            .slice(0, k);
    }
    get size() {
        return this.records.length;
    }
    /**
     * W1-6（R1 鉴别试验）：按病因检索 —— 「已知 stall 类死路有哪些」「这个场景下
     * 的盲点文本点击败过几次」。与文本通道（match）并存而非替代：match 回答
     * 「这个任务下别这么试」，本方法回答「这类病因下都有哪些前科」。
     * 旧记录（无 rootCause 字段）统一归入 unknown 桶 —— 向后兼容的检索面。
     * 排序按时间降序（无文本查询 ⇒ 无相关性维度，新近性是唯一诚实序）。
     */
    matchByRootCause(rootCause, k = 5) {
        const wanted = parseRootCause(rootCause); // 防御：非法入参 ⇒ unknown 桶
        return this.records
            .filter(r => effectiveRootCause(r) === wanted)
            .sort((a, b) => b.at - a.at)
            .slice(0, Math.max(1, k));
    }
    /** checkpoint 序列化：失败记忆与技能库对称持久化 */
    dump() {
        return { records: this.records, nextId: this.nextId };
    }
    restore(data) {
        if (!data?.records)
            return;
        // W1-6：病因字段防御收口 —— 旧 checkpoint 无此字段（保持 undefined = unknown
        // 语义）；被篡改/损坏的垃圾值归一为 unknown（parseRootCause 律）。
        this.records = data.records.map(r => (r.rootCause === undefined || parseRootCause(r.rootCause) === r.rootCause)
            ? r
            : { ...r, rootCause: 'unknown' });
        this.nextId = data.nextId ?? (this.records.at(-1)?.id ?? 0) + 1;
        // W8-B5：去重命中数是会话内活性信号（不入五元组 ⇒ 不落盘）—— 换账即清零，
        // 恢复后的淘汰决策只信落盘字段（诚实降级，不伪造跨会话命中史）。
        // 注：恢复不裁剪 —— 超容量旧档（如 30 条档载入更小容量）原样入账，
        // 裁剪延迟到下一次 record 的显著性淘汰执法（旧档载入不丢是兼容铁律）。
        this.dedupHits.clear();
    }
    reset() {
        this.records = [];
        this.dedupHits.clear();
        // 配置（容量/时钟）保留 —— 只清账本（selfModel.reset 同律）
    }
}
export const failureMemory = new FailureMemory();
/**
 * 配置面（W8-B5）：模块级注入口 —— 容量可配置（缺省 30 不变）+ 注入时钟。
 * 与 configureSelfModel 同律（主控/测试接线备面）。永不抛。
 */
export function configureFailureMemory(opts) {
    failureMemory.configure(opts);
}
/**
 * ΤΕΛ-1（C2-9 主题1 B 级 · 生产接线）：DSH_FAILURE_MEMORY_CAPACITY 的解析律
 * （纯函数、单源立法 —— 组合根只消费不解析）。缺省关红律：env 未设（undefined
 * /空串）⇒ null ⇒ 组合根零调用、库容钉死 30（历史语义逐字节不变）。合法值 =
 * 正有限整数字面（'5'/'128'）；其余（小数/负数/零/非数/前后缀垃圾）一律 null
 * （部署方拼错不静默改库容 —— 组合根侧出警告日志）。绝不抛。
 */
export function failureMemoryCapacityFromEnv(raw) {
    if (typeof raw !== 'string' || raw.trim() === '')
        return null;
    const n = Number(raw.trim());
    return Number.isInteger(n) && n >= 1 && n <= 1_000_000 ? n : null;
}
