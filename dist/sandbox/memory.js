// src/sandbox/memory.ts
// 肌肉记忆存储：skillLibrary 的沙箱对偶器官。
// 哲学对齐：技能是先验不是保证；肌肉记忆是先验不是保证 —— 召回值仅作排练建议，
// 宿主重放永远要过四重门禁。可靠度唯一事实源是宿主重放计数（rehearsalPassCount 不参与）。
// 冻结执法：consolidate 唯一铸造处深冻；restore 后重冻（JSON round-trip 蒸发冻结）。
// 召回评分四维（对齐 skillLibrary.match 哲学）：文本重合 + 可靠度 + 入口场景同屏加成 + 新近度。
// 抛错契约：一切方法永不抛错；落盘失败 warn（旁路义务）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { fpSimilarity, muscleReliability, } from './types.js';
// ΠΑΝ-49：canonical 单源消费（canonicalArgs 的实现体 —— 见该函数注释）
import { canonicalJson } from '../dialects/index.js';
/**
 * ΝΩ-30：递归规范化序列化 —— 深排序 + 环检测。旧实现的 replacer 数组只排
 * 顶层键：嵌套对象的键序不同即误判新技能（{point:{x,y}} vs {point:{y,x}} 同
 * 步异签），且白名单外的嵌套键被整层丢弃（drag_mouse 嵌套点参数坍缩同签 ——
 * 不同参数被当同一技能去重强化）。递归排序保证键序无关性；WeakSet 出口即删
 * （journal.canonical 同律）：共享子对象是合法 DAG 载荷，只有真环降级哨兵 ——
 * 环形 args 不再击穿签名（运行层铁律：一切方法永不抛错）。
 * ΠΑΝ-49：实现收编为 dialects/canonical.ts 单源（全库 6 份 canonical 同族实现
 * 自此逐字节同律）。语义对齐两处（均为修复而非漂移）：① 环/超深哨兵统一为
 * '"#unserializable"'（旧 '"<cycle>"' 废弃 —— 同机同载荷跨模块指纹一致）；
 * ② undefined 值自有键与缺键同域（旧形态串成 `"k":null`，与 JSON.stringify
 * 落盘 dropping 键不一致 —— restore 往返会得出不同签名）。seen 形参保留
 *（签名兼容），实现忽略之（单源自管环检测）。
 */
function canonicalArgs(v, _seen) {
    return canonicalJson(v);
}
/** 步骤签名：同签名 = 同动作序列（去重强化的判定基准，对齐技能库去重哲学） */
export function stepSignature(steps) {
    // args 缺席（外部文件脏步 —— load() 校验明确放行 args===undefined）⇒ 稳定字面
    // 'undefined' 入签：若在此抛 Object.keys(undefined)，load() 会在 entries.set 之后、
    // bySignature.set 之前中断 —— 库内留下未索引条目（去重缺口 = 同签名重复入库）。
    // 平铺 args 的签名字面与旧实现逐字节一致（深排序只在嵌套对象上产生差异 ——
    // 那正是被修复的误判面）。
    return steps.map(s => `${s.kind}:${s.args ? canonicalArgs(s.args, new WeakSet()) : 'undefined'}`).join('|');
}
/** 深冻：ReadonlyArray 类型层的运行时对偶（restore 后必须重跑） */
function deepFreezeActions(steps) {
    for (const s of steps) {
        if (s.args && typeof s.args === 'object')
            Object.freeze(s.args);
        if (s.expect && typeof s.expect === 'object')
            Object.freeze(s.expect);
        Object.freeze(s);
    }
    Object.freeze(steps);
    return steps;
}
/** 中英混合分词 + 重合系数（skillLibrary.tokenize/overlapCoefficient 的最小复刻，模块私有未导出） */
function tokenize(text) {
    const tokens = new Set();
    const en = text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
    for (const t of en)
        tokens.add(t);
    for (const ch of text)
        if (/[\u4e00-\u9fff]/.test(ch))
            tokens.add(ch);
    return tokens;
}
function overlapCoefficient(a, b) {
    if (a.size === 0 || b.size === 0)
        return 0;
    let hit = 0;
    for (const t of a)
        if (b.has(t))
            hit++;
    return hit / Math.min(a.size, b.size);
}
/** 召回权重（config-driven 铁律的例外说明：四维相对权重是算法结构常量而非部署魔法数字，
 *  与 skillLibrary 的 0.3/0.1 同性质 —— 改动它们改变的是算法而非部署形态） */
const W_SCENE_BONUS = 0.3;
const W_RECENCY = 0.1;
const RECENCY_HALF_LIFE_H = 72;
const SCENE_SIMILARITY_GATE = 0.9;
// ── ΤΕΛ-13（D-G16 留案 M7 遗忘淘汰立法）：肌肉记忆库的清除面 ──
// C2-3 M7 病灶：全文无 delete/decay/上限 —— 污染只增不减、坏技能只能手改 JSON、
// save 全量重写的 IO 随库无界增长。立法三律（全部有界、确定性、绝不抛）：
//   ① 容量上界：新签名入库时库满 ⇒ 逐出「最不值得留」的条目（不是 FIFO ——
//      排序键：过期条目优先（> STALE_AFTER_MS 无任何活动），其次可靠度最低
//      （Beta 后验均值），再次最久未活动，最后 Map 插入序 —— 完全确定性）；
//   ② 宿主重放崩塌除名：hostReplayCount ≥ HOST_COLLAPSE_MIN_TRIALS 且后验
//      可靠度 < HOST_COLLAPSE_RELIABILITY ⇒ 条目除名（「失败只降可靠度不除名」
//      的旧病收口 —— 但保留 Laplace 先验的举证门槛：单次失败绝不除名，
//      3 次以上持续失败才构成「坏技能」证据）；
//   ③ 逐出审计账：evictions 台账（有界）记录每一次除名（id/理由/时刻）——
//      「坏技能如何清除」的审计要求有账可查；load() 恢复超限同样执法。
// 语义边界：淘汰面只影响「库里有谁」，不动召回评分/可靠度公式/冻结纪律；
// 被逐条目的同签名宏再排练通过 ⇒ 走 consolidate 正常重新入库（先验重置 ——
// 与「技能是先验不是保证」哲学一致：旧账不复活，新证据重新积累）。
/** 库容量上界（对齐 engine VERDICT_CACHE_MAX 的有界 Map 立法量级） */
export const MUSCLE_MEMORY_MAX_ENTRIES = 256;
/** 条目过期线：超过此时长无排练/重放活动 ⇒ 淘汰排序中的第一优先（遗忘律） */
export const MUSCLE_STALE_AFTER_MS = 30 * 24 * 3_600_000;
/** 崩塌除名的最低举证次数（Laplace 先验保护：单次失败不除名） */
export const MUSCLE_HOST_COLLAPSE_MIN_TRIALS = 3;
/** 崩塌除名的后验可靠度线（Beta(α=成功+1, β=失败+1) 均值下界） */
export const MUSCLE_HOST_COLLAPSE_RELIABILITY = 0.2;
/** 逐出台账容量（有界 —— 审计面自身不许无界增长） */
const EVICTION_LEDGER_MAX = 64;
export class MuscleMemoryStore {
    entries = new Map();
    bySignature = new Map(); // signature → entryId（去重强化索引）
    filePath = '';
    // ΤΕΛ-13（M7）：逐出台账 —— 有界审计面（最新 EVICTION_LEDGER_MAX 条）
    evictions = [];
    configure(filePath) {
        this.filePath = filePath;
    }
    reset() {
        this.entries.clear();
        this.bySignature.clear();
        this.evictions = []; // ΤΕΛ-13（M7）：台账随账本归零（同生命周期语义）
    }
    get(id) {
        return this.entries.get(id);
    }
    // ── ΤΕΛ-13（M7）：遗忘淘汰执法面（私有 —— 唯一公开面是 evictionLog 台账）──
    /** 条目最近活动时刻（排练与宿主重放取晚者 —— 两类活动都算「还活着」） */
    static lastActivityOf(e) {
        return Math.max(e.lastRehearsedAt, e.lastHostReplayedAt);
    }
    /** 除名 + 记账（唯一删除点 —— bySignature 索引同步剥离，绝不留孤儿索引） */
    evict(entryId, reason, detail) {
        const entry = this.entries.get(entryId);
        if (!entry)
            return;
        this.entries.delete(entryId);
        for (const [sig, id] of this.bySignature) {
            if (id === entryId)
                this.bySignature.delete(sig);
        }
        this.evictions.push({ id: entryId, reason, at: Date.now(), detail });
        while (this.evictions.length > EVICTION_LEDGER_MAX)
            this.evictions.shift();
    }
    /**
     * 容量执法：库满时逐出「最不值得留」的一条（确定性排序，见模块头立法①）。
     * 排序键依次：过期（> STALE_AFTER_MS 无活动）优先 → 后验可靠度最低 →
     * 最久未活动 → Map 插入序（entries 迭代序稳定 ⇒ 全序确定）。
     * 返回被逐条目 id（无条目可逐 ⇒ null —— 空库调用是防御面）。
     */
    evictWorstForCapacity(reason) {
        if (this.entries.size === 0)
            return null;
        const now = Date.now();
        let worstId = null;
        let worstKey = null;
        let insertion = 0;
        for (const [id, e] of this.entries) {
            const activity = MuscleMemoryStore.lastActivityOf(e);
            const key = [
                activity < now - MUSCLE_STALE_AFTER_MS ? 0 : 1, // 过期者先走
                Math.round(muscleReliability(e) * 1e6), // 可靠度低者先走（整数化避免浮点平票漂移）
                activity, // 久未活动者先走
                insertion, // 插入序最终裁决（确定性）
            ];
            if (worstKey === null || key < worstKey) {
                worstKey = key;
                worstId = id;
            }
            insertion++;
        }
        if (worstId !== null) {
            const e = this.entries.get(worstId);
            this.evict(worstId, reason, `stale=${MuscleMemoryStore.lastActivityOf(e) < now - MUSCLE_STALE_AFTER_MS}, `
                + `reliability=${muscleReliability(e).toFixed(3)}`);
        }
        return worstId;
    }
    /** 逐出台账（审计面只读镜像 —— 调用方不得改账） */
    evictionLog() {
        return [...this.evictions];
    }
    /**
     * 铸造入库：同签名步骤序列已存在 ⇒ 只强化 rehearsalPassCount（可靠度计数不动 ——
     * 它的唯一事实源是宿主重放），返回被强化的既有条目；新签名 ⇒ 深冻入库。
     */
    consolidate(idGen, trigger, chainId, steps, entrySceneFingerprint) {
        const sig = stepSignature(steps);
        const existingId = this.bySignature.get(sig);
        if (existingId) {
            const existing = this.entries.get(existingId);
            existing.rehearsalPassCount += 1;
            existing.lastRehearsedAt = Date.now();
            return existing;
        }
        // ΤΕΛ-13（M7 容量律）：新签名入库前库满 ⇒ 先逐出最不值得留的条目
        // （强化路径不增长库容 —— 只有新签名触发执法；确定性排序见 evictWorstForCapacity）
        while (this.entries.size >= MUSCLE_MEMORY_MAX_ENTRIES) {
            if (this.evictWorstForCapacity('capacity') === null)
                break;
        }
        const entry = {
            id: idGen.next('muscle'),
            trigger,
            chainId,
            steps: deepFreezeActions([...steps]),
            entrySceneFingerprint,
            rehearsalPassCount: 1,
            hostReplayCount: 0,
            hostSuccessCount: 0,
            lastRehearsedAt: Date.now(),
            lastHostReplayedAt: 0,
            origin: 'rehearsal',
        };
        this.entries.set(entry.id, entry);
        this.bySignature.set(sig, entry.id);
        return entry;
    }
    /** 召回：四维评分排序（先验，非保证 —— 调用方仍须走完整门禁） */
    recall(query, limit = 3) {
        const qTokens = tokenize(query.text);
        const now = Date.now();
        const hits = [];
        for (const entry of this.entries.values()) {
            const text = overlapCoefficient(qTokens, tokenize(entry.trigger));
            const reliability = muscleReliability(entry);
            let scene = 0;
            if (query.currentSceneFingerprint && entry.entrySceneFingerprint &&
                // ΠΑΝ-41：单源 fpSimilarity（位宽鲁棒 —— 128 位演进格式不再静默失配/
                // 负数，召回侧与重放门禁侧行为同源）
                fpSimilarity(query.currentSceneFingerprint, entry.entrySceneFingerprint).similarity >= SCENE_SIMILARITY_GATE) {
                scene = W_SCENE_BONUS;
            }
            const ageH = (now - entry.lastRehearsedAt) / 3_600_000;
            const recency = W_RECENCY * Math.exp(-ageH / RECENCY_HALF_LIFE_H);
            hits.push({ entry, score: Math.max(text, 0) * reliability + scene + recency });
        }
        return hits.filter(h => h.score > 0.05).sort((a, b) => b.score - a.score).slice(0, limit);
    }
    /** 宿主重放结局回写：计数是唯一事实源，可靠度永远是导出值。
     *  ΤΕΛ-13（M7 崩塌除名律）：失败回写后若 hostReplayCount ≥ 3 且后验可靠度
     *  < 0.2（持续失败多于成功 —— Beta 后验崩塌）⇒ 条目除名（旧病「失败只降
     *  可靠度不除名」收口：坏技能不再永生）。除名 ⇒ 返回终态快照（条目已不在
     *  库但调用方可如实报告崩塌后的可靠度 —— engine 的 `?? 旧引用` 兜底不受
     *  影响）。Laplace 先验的举证门槛（≥3 次）保证单次/两次失败绝不除名 ——
     *  先验保护与「技能是先验不是保证」哲学一致。 */
    recordHostReplay(entryId, success) {
        const entry = this.entries.get(entryId);
        if (!entry)
            return undefined;
        entry.hostReplayCount += 1;
        if (success)
            entry.hostSuccessCount += 1;
        entry.lastHostReplayedAt = Date.now();
        // ΤΕΛ-13（M7）：成功绝不除名；失败且后验崩塌 + 举证足额 ⇒ 除名
        if (!success
            && entry.hostReplayCount >= MUSCLE_HOST_COLLAPSE_MIN_TRIALS
            && muscleReliability(entry) < MUSCLE_HOST_COLLAPSE_RELIABILITY) {
            const snapshot = { ...entry };
            this.evict(entryId, 'host-replay-collapse', `trials=${entry.hostReplayCount}, reliability=${muscleReliability(snapshot).toFixed(3)}`);
            return snapshot; // 已除名：返回终态快照（非 undefined —— 调用方可如实报告崩塌值）
        }
        return entry;
    }
    /** 原子落盘（tmp+rename 方言，对齐 qualityDoctor.atomicWrite） */
    save() {
        if (!this.filePath)
            return true;
        try {
            mkdirSync(dirname(this.filePath), { recursive: true });
            const tmp = `${this.filePath}.tmp`;
            writeFileSync(tmp, JSON.stringify([...this.entries.values()]), 'utf8');
            renameSync(tmp, this.filePath);
            return true;
        }
        catch (e) {
            console.warn(`[MuscleMemory] save failed: ${e.message}`);
            return false;
        }
    }
    /** 载入：损坏则警告并从新开始（不阻断 —— 持久化是资产不是命脉）；载入后重冻 */
    load() {
        if (!this.filePath || !existsSync(this.filePath))
            return 0;
        try {
            const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
            if (!Array.isArray(parsed))
                return 0;
            let restored = 0;
            for (const raw of parsed) {
                if (!raw || typeof raw.id !== 'string' || !Array.isArray(raw.steps))
                    continue;
                // 逐条目防御（外部文件：手改/旧格式）：单条畸形跳过，不连坐整个库 ——
                // 否则 stepSignature 对 args:null 抛错，外层 catch 丢弃全部记录且残留半载状态
                try {
                    const stepsValid = raw.steps.every(s => s !== null && typeof s === 'object' && typeof s.kind === 'string' && (() => {
                        const args = s.args;
                        return args === undefined ||
                            (typeof args === 'object' && args !== null && !Array.isArray(args));
                    })());
                    if (!stepsValid)
                        continue;
                    // steps 是 readonly 属性 —— 不可原地赋值，重建对象后重冻（JSON round-trip 蒸发冻结）
                    const entry = { ...raw, steps: deepFreezeActions([...raw.steps]) };
                    this.entries.set(entry.id, entry);
                    this.bySignature.set(stepSignature(entry.steps), entry.id);
                    restored++;
                }
                catch {
                    continue; // 单条水合失败：跳过（持久化是资产不是命脉）
                }
            }
            // ΤΕΛ-13（M7 容量律的恢复面）：外部文件（手改/旧格式堆积）超限 ⇒ 载入后
            // 同律执法逐出至 ≤ 上限（理由 capacity-on-load —— 台账可审计）。中段return
            // 不经过此处：畸形档整体丢弃（空库）无从逐出。
            while (this.entries.size > MUSCLE_MEMORY_MAX_ENTRIES) {
                if (this.evictWorstForCapacity('capacity-on-load') === null)
                    break;
            }
            return restored;
        }
        catch (e) {
            console.warn(`[MuscleMemory] load failed (${e.message}); starting fresh`);
            return 0;
        }
    }
    size() {
        return this.entries.size;
    }
}
/**
 * ΑΩ-R20：引擎侧唯一 MuscleMemoryStore 共享实例（存储职责归一）。
 * 排练门禁（macroRehearsal 的 MacroRehearsalGate 构造缺省解析到此）与引擎
 * 记账共用同一账本 ——「排练通过」的登记与宿主重放计数同源互见、跨会话存活，
 * 不再并存第二份会话级内存账。持久化生命周期沿用本类现状：接线方持同一实例
 * configure(持久路径) 后 load/save 即生效；未配置路径时与会话级实例行为
 * 逐字节一致（save 无路径 = 旁路 true，load 无路径 = 0 —— 防御式缺席）。
 */
export const sharedMuscleMemoryStore = new MuscleMemoryStore();
