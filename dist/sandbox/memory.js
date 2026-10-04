// src/sandbox/memory.ts
// 肌肉记忆存储：skillLibrary 的沙箱对偶器官。
// 哲学对齐：技能是先验不是保证；肌肉记忆是先验不是保证 —— 召回值仅作排练建议，
// 宿主重放永远要过四重门禁。可靠度唯一事实源是宿主重放计数（rehearsalPassCount 不参与）。
// 冻结执法：consolidate 唯一铸造处深冻；restore 后重冻（JSON round-trip 蒸发冻结）。
// 召回评分四维（对齐 skillLibrary.match 哲学）：文本重合 + 可靠度 + 入口场景同屏加成 + 新近度。
// 抛错契约：一切方法永不抛错；落盘失败 warn（旁路义务）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { muscleReliability, } from './types.js';
/**
 * ΝΩ-30：递归规范化序列化 —— 深排序 + 环检测。旧实现的 replacer 数组只排
 * 顶层键：嵌套对象的键序不同即误判新技能（{point:{x,y}} vs {point:{y,x}} 同
 * 步异签），且白名单外的嵌套键被整层丢弃（drag_mouse 嵌套点参数坍缩同签 ——
 * 不同参数被当同一技能去重强化）。递归排序保证键序无关性；WeakSet 出口即删
 * （journal.canonical 同律）：共享子对象是合法 DAG 载荷，只有真环降级哨兵 ——
 * 环形 args 不再击穿签名（运行层铁律：一切方法永不抛错）。
 */
function canonicalArgs(v, seen) {
    if (v === null || typeof v !== 'object')
        return JSON.stringify(v) ?? 'null';
    if (seen.has(v))
        return '"<cycle>"';
    seen.add(v);
    try {
        if (Array.isArray(v)) {
            return `[${v.map(item => canonicalArgs(item, seen)).join(',')}]`;
        }
        const rec = v;
        return `{${Object.keys(rec).sort()
            .map(k => `${JSON.stringify(k)}:${canonicalArgs(rec[k], seen)}`)
            .join(',')}}`;
    }
    finally {
        seen.delete(v);
    }
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
/** 64 位指纹相似度（perceptualHash.similarity/hammingDistance 同构式本地复刻：
 *  纯字符串距离，不拖入 sharp 图像二进制运行时依赖 —— D-5 与宿主共享算法规范而非依赖链） */
function fingerprintSimilarity(a, b) {
    if (a.length !== b.length)
        return 0;
    let dist = 0;
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i])
            dist++;
    return 1 - dist / 64;
}
/** 召回权重（config-driven 铁律的例外说明：四维相对权重是算法结构常量而非部署魔法数字，
 *  与 skillLibrary 的 0.3/0.1 同性质 —— 改动它们改变的是算法而非部署形态） */
const W_SCENE_BONUS = 0.3;
const W_RECENCY = 0.1;
const RECENCY_HALF_LIFE_H = 72;
const SCENE_SIMILARITY_GATE = 0.9;
export class MuscleMemoryStore {
    entries = new Map();
    bySignature = new Map(); // signature → entryId（去重强化索引）
    filePath = '';
    configure(filePath) {
        this.filePath = filePath;
    }
    reset() {
        this.entries.clear();
        this.bySignature.clear();
    }
    get(id) {
        return this.entries.get(id);
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
                fingerprintSimilarity(query.currentSceneFingerprint, entry.entrySceneFingerprint) >= SCENE_SIMILARITY_GATE) {
                scene = W_SCENE_BONUS;
            }
            const ageH = (now - entry.lastRehearsedAt) / 3_600_000;
            const recency = W_RECENCY * Math.exp(-ageH / RECENCY_HALF_LIFE_H);
            hits.push({ entry, score: Math.max(text, 0) * reliability + scene + recency });
        }
        return hits.filter(h => h.score > 0.05).sort((a, b) => b.score - a.score).slice(0, limit);
    }
    /** 宿主重放结局回写：计数是唯一事实源，可靠度永远是导出值 */
    recordHostReplay(entryId, success) {
        const entry = this.entries.get(entryId);
        if (!entry)
            return undefined;
        entry.hostReplayCount += 1;
        if (success)
            entry.hostSuccessCount += 1;
        entry.lastHostReplayedAt = Date.now();
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
