import { embed, cosine } from '../semanticHash.js';
// ─── 算法形状字面量（出册常数 —— 校准无可行区间，值即设计，非调参旋钮）───
/** 空间量化网格（4×4）：元素签名与动作区域共用同一坐标方言。
 *  校准：包络内 [2..8] 不敏感（测试世界元素间距充足）。 */
const TYPE_QUANTIZE = 4;
/** 屏幕同型认定阈值。校准：包络内不敏感（测试世界屏幕类型非歧义）；
 *  正确取值依赖部署域的布局密度分布 —— 值即「布局方言」的定义。 */
const TYPE_MATCH_SIMILARITY = 0.62;
/** Laplace 平滑系数 —— Jeffreys 二项不变先验 α=1/2（唯一有不变性推导的
 *  无信息先验，数值由推导固定）。校准：包络内不敏感（novel 直通通道主导）。 */
const SURPRISE_ALPHA = 0.5;
/** 元素签名分词：名称 + 量化空间位（'OK@22' —— 名字说什么 + 大致在哪） */
function sceneTokens(scene) {
    const tokens = [];
    for (const patch of scene) {
        for (const el of patch.elements) {
            const cx = el.rect.x + el.rect.width / 2;
            const cy = el.rect.y + el.rect.height / 2;
            const qx = Math.min(TYPE_QUANTIZE - 1, Math.max(0, Math.floor(cx * TYPE_QUANTIZE)));
            const qy = Math.min(TYPE_QUANTIZE - 1, Math.max(0, Math.floor(cy * TYPE_QUANTIZE)));
            tokens.push(`${el.name}@${qx}${qy}`);
        }
    }
    return tokens;
}
/** 非空字符串守卫（域执法的原子件） */
function nonEmptyStr(v) {
    return typeof v === 'string' && v.length > 0;
}
/**
 * 转移动作键：动作在动力学里的身份。
 * 指针动作 ⇒ kind + 量化区域（'click_mouse@22' —— 点哪一片，不记精确像素：
 * 精确坐标是噪声，区域是信号）；无坐标动作 ⇒ kind 本身。
 * 与屏幕签名共用 TYPE_QUANTIZE 网格 —— 「在什么样的屏上点哪个区」是同一门方言。
 */
export function transitionActionKey(action) {
    const args = (action?.args ?? {});
    if (typeof args.x === 'number' && typeof args.y === 'number' &&
        Number.isFinite(args.x) && Number.isFinite(args.y)) {
        const qx = Math.min(TYPE_QUANTIZE - 1, Math.max(0, Math.floor(Math.min(1, Math.max(0, args.x)) * TYPE_QUANTIZE)));
        const qy = Math.min(TYPE_QUANTIZE - 1, Math.max(0, Math.floor(Math.min(1, Math.max(0, args.y)) * TYPE_QUANTIZE)));
        return `${String(action.kind)}@${qx}${qy}`;
    }
    return String(action?.kind ?? 'unknown');
}
/**
 * 内存世界模型（预测编码纪元第一器官）。
 * 零持久化（与 InMemoryKnowledgeBase 同律 —— 落盘是留白）；GC 即归零。
 */
export class InMemoryWorldModel {
    /** 屏幕类型注册表（tokens = 序列化真相；vec = 派生缓存，水合时重铸） */
    types = new Map();
    /** 转移统计表（`${fromType}|${actionKey}` → 下一类型分布 + 成功率） */
    transitions = new Map();
    typeCounter = 0;
    typeOf(scene) {
        if (!Array.isArray(scene))
            return null;
        const tokens = sceneTokens(scene);
        if (tokens.length === 0)
            return null; // 看不见 ≠ 真空屏（fault 补丁零元素同律）
        const vec = embed(tokens.join(' '));
        let bestId = null;
        let bestSim = 0;
        for (const [id, t] of this.types) {
            const sim = cosine(vec, t.vec);
            if (sim > bestSim) {
                bestSim = sim;
                bestId = id;
            }
        }
        if (bestId !== null && bestSim >= TYPE_MATCH_SIMILARITY) {
            this.types.get(bestId).members += 1; // 指认即注册（会员计数 = 观察次数）
            return bestId;
        }
        // 铸造新类型：增量聚类（贪心首遇 —— v1 的诚实局限：无分裂/合并，
        // 类型碎片化由阈值 + 语义签名的稳定性兜底）
        this.typeCounter += 1;
        const id = `screen-${this.typeCounter}`;
        this.types.set(id, { tokens, vec, members: 1 });
        return id;
    }
    observe(fromTypeId, actionKey, toTypeId, success) {
        if (!nonEmptyStr(fromTypeId) || !nonEmptyStr(actionKey) || !nonEmptyStr(toTypeId)) {
            return {
                ok: false,
                error: { field: 'transition', reason: 'fromTypeId, actionKey, toTypeId must be non-empty strings' },
            };
        }
        if (typeof success !== 'boolean') {
            return { ok: false, error: { field: 'success', reason: `success must be boolean, got "${success}"` } };
        }
        const key = `${fromTypeId}|${actionKey}`;
        let stats = this.transitions.get(key);
        if (!stats) {
            stats = { total: 0, success: 0, next: new Map() };
            this.transitions.set(key, stats);
        }
        stats.total += 1;
        if (success)
            stats.success += 1;
        stats.next.set(toTypeId, (stats.next.get(toTypeId) ?? 0) + 1);
        return { ok: true, value: undefined };
    }
    predict(fromTypeId, actionKey) {
        if (!nonEmptyStr(fromTypeId) || !nonEmptyStr(actionKey)) {
            return {
                ok: false,
                error: { field: 'transition', reason: 'fromTypeId and actionKey must be non-empty strings' },
            };
        }
        const stats = this.transitions.get(`${fromTypeId}|${actionKey}`);
        if (!stats)
            return { ok: true, value: null }; // 诚实的无知：无证据 ⇒ 无预测
        const nextTypes = [...stats.next.entries()]
            .map(([typeId, n]) => ({ typeId, prob: Math.round((n / stats.total) * 1000) / 1000 }))
            .sort((a, b) => b.prob - a.prob);
        return {
            ok: true,
            value: {
                nextTypes,
                successProb: Math.round((stats.success / stats.total) * 1000) / 1000,
                evidence: stats.total,
            },
        };
    }
    surprise(fromTypeId, actionKey, actualTypeId) {
        if (!nonEmptyStr(fromTypeId) || !nonEmptyStr(actionKey) || !nonEmptyStr(actualTypeId)) {
            return {
                ok: false,
                error: { field: 'transition', reason: 'fromTypeId, actionKey, actualTypeId must be non-empty strings' },
            };
        }
        const stats = this.transitions.get(`${fromTypeId}|${actionKey}`);
        if (!stats)
            return { ok: true, value: { bits: 0, novel: true, evidence: 0 } };
        const count = stats.next.get(actualTypeId) ?? 0;
        // Laplace 平滑：未见过的目的地仍有残余概率（α/(total+α(|distinct|+1))）——
        // 模型绝不把「我没见过」伪装成「这不可能」
        const p = (count + SURPRISE_ALPHA) / (stats.total + SURPRISE_ALPHA * (stats.next.size + 1));
        return {
            ok: true,
            value: {
                bits: Math.round(-Math.log2(p) * 1000) / 1000,
                novel: count === 0,
                evidence: stats.total,
            },
        };
    }
    /** 库存快照（可观测面：类型学规模 + 动力学覆盖） */
    stats() {
        let observations = 0;
        for (const t of this.transitions.values())
            observations += t.total;
        return { types: this.types.size, transitions: this.transitions.size, observations };
    }
    /**
     * 持久化快照：完整签名 tokens（类型学的序列化真相）+ 转移统计 + 计数器。
     * 向量由 tokens 确定性重铸 —— 快照里没有派生数据（单一真相原则）。
     */
    exportSnapshot() {
        return {
            version: 1,
            types: [...this.types.entries()].map(([id, t]) => ({ id, tokens: t.tokens, members: t.members })),
            transitions: [...this.transitions.entries()].map(([key, t]) => {
                const [from, action] = key.split('|');
                return { from, action, total: t.total, success: t.success, next: [...t.next.entries()] };
            }),
            typeCounter: this.typeCounter,
        };
    }
    /** 快照水合（异常诚实）：先验后写，任一非法 ⇒ 整体拒绝绝不半水合 */
    restoreSnapshot(snap) {
        const bad = (field, reason) => ({ ok: false, error: { field, reason } });
        if (!snap || typeof snap !== 'object')
            return bad('snapshot', 'snapshot must be an object');
        const s = snap;
        if (s.version !== 1)
            return bad('snapshot.version', `unsupported version ${JSON.stringify(s.version)}`);
        if (!Array.isArray(s.types) || !Array.isArray(s.transitions)) {
            return bad('snapshot', 'types and transitions must be arrays');
        }
        const typeIds = new Set();
        for (const t of s.types) {
            const ty = t;
            if (!ty || typeof ty.id !== 'string' || !ty.id || typeIds.has(ty.id)) {
                return bad('snapshot.types', `type id must be unique non-empty string, got ${JSON.stringify(ty?.id)}`);
            }
            typeIds.add(ty.id);
            if (!Array.isArray(ty.tokens) || ty.tokens.length === 0 || !ty.tokens.every((x) => typeof x === 'string')) {
                return bad('snapshot.types', `type "${ty.id}" tokens must be non-empty string array`);
            }
            if (typeof ty.members !== 'number' || ty.members < 1) {
                return bad('snapshot.types', `type "${ty.id}" members must be number >= 1`);
            }
        }
        for (const t of s.transitions) {
            const tr = t;
            if (!tr || typeof tr.from !== 'string' || typeof tr.action !== 'string' || !tr.from || !tr.action) {
                return bad('snapshot.transitions', 'from/action must be non-empty strings');
            }
            if (typeof tr.total !== 'number' || tr.total < 1 || typeof tr.success !== 'number' ||
                tr.success < 0 || tr.success > tr.total) {
                return bad('snapshot.transitions', `transition "${tr.from}|${tr.action}" has invalid total/success counts`);
            }
            if (!Array.isArray(tr.next) || !tr.next.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'number')) {
                return bad('snapshot.transitions', `transition "${tr.from}|${tr.action}" next must be [string, number] pairs`);
            }
        }
        // 换脑：预检全过后整批入账，向量重铸
        this.types.clear();
        this.transitions.clear();
        for (const t of s.types) {
            const ty = t;
            this.types.set(ty.id, { tokens: ty.tokens, vec: embed(ty.tokens.join(' ')), members: ty.members });
        }
        for (const t of s.transitions) {
            const tr = t;
            const next = new Map(tr.next);
            this.transitions.set(`${tr.from}|${tr.action}`, { total: tr.total, success: tr.success, next });
        }
        this.typeCounter = typeof s.typeCounter === 'number' && Number.isFinite(s.typeCounter)
            ? Math.max(0, Math.floor(s.typeCounter)) : this.types.size;
        return { ok: true, value: undefined };
    }
}
