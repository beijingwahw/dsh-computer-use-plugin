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
/** 步骤签名：同签名 = 同动作序列（去重强化的判定基准，对齐技能库去重哲学） */
export function stepSignature(steps) {
    return steps.map(s => `${s.kind}:${JSON.stringify(s.args, Object.keys(s.args).sort())}`).join('|');
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
            const ageH = (now - entry.lastRehearsedAt) / 3600000;
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
                // steps 是 readonly 属性 —— 不可原地赋值，重建对象后重冻（JSON round-trip 蒸发冻结）
                const entry = { ...raw, steps: deepFreezeActions([...raw.steps]) };
                this.entries.set(entry.id, entry);
                this.bySignature.set(stepSignature(entry.steps), entry.id);
                restored++;
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
