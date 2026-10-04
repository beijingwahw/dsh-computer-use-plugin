import { embed, cosine } from '../semanticHash.js';
// ─── 算法形状字面量（出册常数 —— 校准无可行区间，值即设计，非调参旋钮）───
/** 空间量化网格（4×4）：元素签名与动作区域共用同一坐标方言。
 *  校准：包络内 [2..8] 不敏感（测试世界元素间距充足）。 */
const TYPE_QUANTIZE = 4;
/** 屏幕同型认定阈值。校准：包络内不敏感（测试世界屏幕类型非歧义）；
 *  正确取值依赖部署域的布局密度分布 —— 值即「布局方言」的定义。 */
const TYPE_MATCH_SIMILARITY = 0.62;
/** ΝΩ-15：近邻合并阈值（周期维护收拢幕）。高于认定阈值（0.62）一档 ——
 *  只有「本就该是一型、却因渐变被分铸」的碎片才收拢；0.62~0.85 之间是
 *  合理的方言内变体，各自成型。值即碎片治理的口径，非调参旋钮。 */
const TYPE_MERGE_SIMILARITY = 0.85;
/** Laplace 平滑系数 —— Jeffreys 二项不变先验 α=1/2（唯一有不变性推导的
 *  无信息先验，数值由推导固定）。校准：包络内不敏感（novel 直通通道主导）。 */
const SURPRISE_ALPHA = 0.5;
/** 坐标 → 网格号（越界钳回网格内 —— 执行方言的防御性归一） */
function quantizeCell(v) {
    return Math.min(TYPE_QUANTIZE - 1, Math.max(0, Math.floor(v * TYPE_QUANTIZE)));
}
/** 网格号钳回 [0, TYPE_QUANTIZE-1]（邻格越界时归并回主格侧的边格） */
function clampCellIndex(i) {
    return Math.min(TYPE_QUANTIZE - 1, Math.max(0, i));
}
/**
 * 元素签名分词：名称 + 软量化空间位（'OK@22' —— 名字说什么 + 大致在哪）。
 * ΝΩ-15（WM-2 顺修）：单格硬量化在格线上脆断 —— 元素中心跨过 0.25/0.5/0.75
 * 即突变签名，布局微移被放大成换屏。软方案（top-2 近格 0.7/0.3 的等价降维）：
 * 元素同时入主格与最近邻格，双格等权（集合语义）。跨格线移动时主/邻格恰好
 * 互换 ⇒ 签名集合严格不变；跨格中点才翻一枚 token（部分保留）。
 * 邻格 = 四方向边距最小者，并列取左/上 —— 纯几何，随机流零。
 */
function sceneTokens(scene) {
    const tokens = [];
    for (const patch of scene) {
        for (const el of patch.elements) {
            const cx = el.rect.x + el.rect.width / 2;
            const cy = el.rect.y + el.rect.height / 2;
            const qx = quantizeCell(cx);
            const qy = quantizeCell(cy);
            tokens.push(`${el.name}@${qx}${qy}`);
            const w = 1 / TYPE_QUANTIZE;
            const dl = qx > 0 ? cx - qx * w : Infinity;
            const dr = qx < TYPE_QUANTIZE - 1 ? (qx + 1) * w - cx : Infinity;
            const du = qy > 0 ? cy - qy * w : Infinity;
            const dd = qy < TYPE_QUANTIZE - 1 ? (qy + 1) * w - cy : Infinity;
            const m = Math.min(dl, dr, du, dd);
            let nx = qx;
            let ny = qy;
            if (m === dl)
                nx = qx - 1;
            else if (m === dr)
                nx = qx + 1;
            else if (m === du)
                ny = qy - 1;
            else
                ny = qy + 1;
            tokens.push(`${el.name}@${clampCellIndex(nx)}${clampCellIndex(ny)}`);
        }
    }
    return tokens;
}
/** 非空字符串守卫（域执法的原子件） */
function nonEmptyStr(v) {
    return typeof v === 'string' && v.length > 0;
}
/**
 * Laplace 平滑惊讶（bits）—— 惊讶计价的唯一实现，绝不复制。
 * p = (count+α)/(total+α·(distinct+1))：未见过的目的地仍有残余概率 ——
 * 模型绝不把「我没见过」伪装成「这不可能」。surprise() 方法（单转移报告）
 * 与 surpriseSpectrum()（纪元 Κ 谱聚合）共用本函数：两处口径分毫不得漂移，
 * 改这里即同时改两处 —— 这就是「复用现有内部惊讶计算」的落点。
 */
function smoothedSurpriseBits(total, distinct, count) {
    const p = (count + SURPRISE_ALPHA) / (total + SURPRISE_ALPHA * (distinct + 1));
    return -Math.log2(p);
}
/**
 * ΝΩ-15：稀疏向量线性组合 wa·a + wb·b → 归一化重铸 —— 在线球面 k-means 的
 * 质心算术（吸收：wa=1-α/wb=α；合并：wa=mA/(mA+mB)/wb=mB/(mA+mB)）。
 * 与 embed 同律：权重取整到千分位后从同源重算 norm —— cosine(v,v)===1
 * 精确成立，cosine 语义分毫不动。桶号双指针线性合并（两入参皆有序）。
 */
function blend(a, b, wa, wb) {
    const dims = [];
    let i = 0;
    let j = 0;
    while (i < a.dims.length && j < b.dims.length) {
        const [ba, va] = a.dims[i];
        const [bb, vb] = b.dims[j];
        if (ba === bb) {
            dims.push([ba, wa * va + wb * vb]);
            i++;
            j++;
        }
        else if (ba < bb) {
            dims.push([ba, wa * va]);
            i++;
        }
        else {
            dims.push([bb, wb * vb]);
            j++;
        }
    }
    for (; i < a.dims.length; i++)
        dims.push([a.dims[i][0], wa * a.dims[i][1]]);
    for (; j < b.dims.length; j++)
        dims.push([b.dims[j][0], wb * b.dims[j][1]]);
    let sq = 0;
    for (const d of dims) {
        d[1] = Math.round(d[1] * 1000) / 1000;
        sq += d[1] * d[1];
    }
    return { dims, norm: Math.sqrt(sq) };
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
    /**
     * 屏幕类型注册表。tokens = 铸造时刻签名（谱系记录）；vec = 在线质心
     * （ΝΩ-15：typeOf 命中即吸收，随布局渐变漂移 —— 不再是 tokens 的派生
     * 缓存；快照双写，旧档无 vec 时由 tokens 重铸）。vec 只整体替换、绝不
     * 原地修改 —— fork 浅层共享稀疏向量的安全性前提。
     */
    types = new Map();
    /** 转移统计表（`${fromType}|${actionKey}` → 下一类型分布 + 成功率） */
    transitions = new Map();
    typeCounter = 0;
    /**
     * ΝΩ-15：碎片治理 alias 表（旧 id → 幸存 id，传递链）。typeOf 产出恒为
     * 幸存 id；observe/predict/surprise 的一切入参 id 先过本表（透明改写）——
     * 外部持有者（挂账转移、预言缓存）对合并无感。
     */
    aliases = new Map();
    // ── O 纪元（#20）：run 级快照 —— 并发 run 隔离 ──
    /** fork 出的实例才记账（根实例 journaling=false —— 根永不 merge 自己） */
    journaling = false;
    /** 重放日志：merge 时按序重放到父（mint/member/observe 三类原子操作）。
     *  ΝΩ-15：member 携带被吸收的 tokens —— 质心漂移随重放等价再现（fork 内
     *  发生的一切学习，merge 后与串行执行同果）。 */
    ops = [];
    /**
     * O 纪元（#20）：run 级快照。并发 run 共享同一模型时，typeOf 的中途定型
     * （会员计数/新类型铸造）会互相污染（J 纪元只隔离了 pendingTransition）。
     * fork = 全量拷贝 + 记账模式：run 内一切读写落 fork，run 终 merge 重放回父。
     * 拷贝是浅层共享不可变数据（tokens 永不修改；vec 只整体替换绝不原地改 ——
     * ΝΩ-15 质心漂移的写律）+ 复制可变壳（entries/next/aliases Map）。
     */
    fork() {
        const child = new InMemoryWorldModel();
        for (const [id, t] of this.types) {
            child.types.set(id, { tokens: t.tokens, vec: t.vec, members: t.members });
        }
        for (const [key, tr] of this.transitions) {
            child.transitions.set(key, { total: tr.total, success: tr.success, next: new Map(tr.next) });
        }
        for (const [from, into] of this.aliases)
            child.aliases.set(from, into);
        child.typeCounter = this.typeCounter;
        child.journaling = true;
        return child;
    }
    /**
     * O 纪元（#20）：fork 的操作日志重放回本模型（run 终点调用）。
     * 并发 fork 各自铸造的同号类型（screen-N）在此重铸为父计数器的新 id ——
     * 重放是确定性的（日志序 = 发生序），合并结果与串行执行等价。
     *
     * ΝΩ-15 与维护合并的次序语义（确定性，两种次序皆合法）：
     *   · 维护（mergeSimilarTypes）在重放之先：重放按父侧 alias 改写 ——
     *     已收拢的类型绝不因并发重放复活。铸造 op 撞上别名号时：内容与幸存者
     *     当前质心 ≥ TYPE_MATCH_SIMILARITY ⇒ 降级为幸存者的会员吸收（同型
     *     异号归一）；不相似 ⇒ 重铸新号（无关内容不得污染幸存者向量，别名
     *     占用的 id 亦不得复活为类型）。member/observe 一律先过 alias。
     *   · 维护在重放之后：重放按普通语义落地，下一轮维护按当刻余弦收拢
     *     （碎片最多多活一幕 —— 收拢是周期幕，不是即时反射）。
     */
    merge(child) {
        if (!child.journaling || child === this)
            return; // 只收 fork 的账
        const rewrite = new Map();
        const rw = (id) => rewrite.get(id) ?? id;
        for (const op of child.ops) {
            if (op.k === 'mint') {
                const canonical = this.resolveTypeId(op.id); // 父侧维护可能已收拢此号
                if (canonical !== op.id) {
                    const survivor = this.types.get(canonical);
                    if (survivor && cosine(embed(op.tokens.join(' ')), survivor.vec) >= TYPE_MATCH_SIMILARITY) {
                        // 同型异号：铸造降级为幸存者的会员吸收 —— 碎片不复活
                        survivor.members += 1;
                        survivor.vec = blend(survivor.vec, embed(op.tokens.join(' ')), 1 - 1 / survivor.members, 1 / survivor.members);
                        rewrite.set(op.id, canonical);
                        continue;
                    }
                    // 无关内容撞别名号：重铸新号（同并发同号律 —— 各铸各的，绝不复用别名 id）
                    this.typeCounter += 1;
                    const nid = `screen-${this.typeCounter}`;
                    rewrite.set(op.id, nid);
                    this.types.set(nid, { tokens: op.tokens, vec: embed(op.tokens.join(' ')), members: 1 });
                    continue;
                }
                if (this.types.has(op.id)) {
                    // 并发兄弟 fork 已用同号：重铸新 id（父计数器单调递增）
                    this.typeCounter += 1;
                    const nid = `screen-${this.typeCounter}`;
                    rewrite.set(op.id, nid);
                    this.types.set(nid, { tokens: op.tokens, vec: embed(op.tokens.join(' ')), members: 1 });
                }
                else {
                    rewrite.set(op.id, op.id);
                    this.types.set(op.id, { tokens: op.tokens, vec: embed(op.tokens.join(' ')), members: 1 });
                    // 计数器同步到所采 id 的序号（fork 的 id 可能领先父计数器 ——
                    // 不同步则后续重铸撞号覆写：screen-3 之后再铸仍是 screen-3）
                    const seq = Number.parseInt(op.id.slice('screen-'.length), 10);
                    if (Number.isFinite(seq) && seq > this.typeCounter)
                        this.typeCounter = seq;
                }
            }
            else if (op.k === 'member') {
                const t = this.types.get(this.resolveTypeId(rw(op.id)));
                if (t) {
                    t.members += 1;
                    // 质心漂移重放：与 fork 内发生的吸收同律（在线均值，串行等价）
                    t.vec = blend(t.vec, embed(op.tokens.join(' ')), 1 - 1 / t.members, 1 / t.members);
                }
            }
            else {
                // 复用入账（含校验）；id 先并发重写、再过父侧 alias（最新收拢状态）
                this.observe(rw(this.resolveTypeId(op.from)), op.action, rw(this.resolveTypeId(op.to)), op.success);
            }
        }
    }
    /** alias 传递链解析（查询侧压缩：旧→新逐跳到无记录止）。环防御 = 跳数
     *  上界取表长（水合预检拒环，此为纵深）；绝不 throw。 */
    resolveTypeId(id) {
        let cur = id;
        for (let hops = 0; hops < this.aliases.size; hops++) {
            const next = this.aliases.get(cur);
            if (next === undefined)
                return cur;
            cur = next;
        }
        return cur;
    }
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
            const t = this.types.get(bestId);
            t.members += 1; // 指认即注册（会员计数 = 观察次数）
            // ΝΩ-15：在线质心 —— α=1/members 增量吸收当前签名（运行均值）：质心
            // 随布局渐变漂移，不再冻结于铸造时刻（旧疾：漂移累积 ⇒ 相似度跌破
            // 0.62 ⇒ 铸新类型 ⇒ 转移表碎片化）。同屏重复命中由 members 加权天然
            // 阻尼（计数越大步长越小 —— 定型类型趋稳，防抖无需额外状态）。
            t.vec = blend(t.vec, vec, 1 - 1 / t.members, 1 / t.members);
            if (this.journaling)
                this.ops.push({ k: 'member', id: bestId, tokens });
            return bestId;
        }
        // 铸造新类型：增量聚类（贪心首遇 + 在线质心 + 周期近邻合并 ——
        // ΝΩ-15 碎片化治理三件套；分裂仍留白）
        this.typeCounter += 1;
        const id = `screen-${this.typeCounter}`;
        this.types.set(id, { tokens, vec, members: 1 });
        if (this.journaling)
            this.ops.push({ k: 'mint', id, tokens });
        return id;
    }
    /**
     * ΝΩ-15：近邻合并（cosine ≥ TYPE_MERGE_SIMILARITY）—— 碎片化治理的收拢
     * 器官（供 sleep 幕/维护钩子显式调用；接线由后续工单）。
     * 确定性贪心（单轮）：类型按 members 降序、id 字典升序遍历 —— 每型要么
     * 成为幸存者，要么并入已幸存集合中与其最相似且 ≥ 阈值者（证据多者为
     * 身份之锚）。并入动作：
     *   · members 相加；质心 = 双方 members 加权均值（重铸归一）；
     *   · 转移表重铸：from/next 全过 alias，同 actionKey 的 next 分布计数
     *     求和（sum(next)==total 记账不变量在 re-bucket 下自动保序）；
     *   · alias 留档（含既有链的展平改写），查询侧透明。
     * 运行层铁律：纯算术，永不 throw；返回收拢清单（空 = 无可合并对）。
     */
    mergeSimilarTypes() {
        const order = [...this.types.entries()]
            .sort((a, b) => (b[1].members - a[1].members) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        const survivors = [];
        const localAlias = new Map();
        for (const [id, t] of order) {
            let bestId = null;
            let bestSim = 0;
            for (const sid of survivors) {
                const sim = cosine(t.vec, this.types.get(sid).vec);
                if (sim > bestSim) {
                    bestSim = sim;
                    bestId = sid;
                }
            }
            if (bestId !== null && bestSim >= TYPE_MERGE_SIMILARITY) {
                const s = this.types.get(bestId);
                const total = s.members + t.members;
                s.vec = blend(s.vec, t.vec, s.members / total, t.members / total);
                s.members = total;
                this.types.delete(id);
                localAlias.set(id, bestId);
            }
            else {
                survivors.push(id);
            }
        }
        if (localAlias.size === 0)
            return { merged: [] };
        // 既有链展平：C→B 已在档而 B 新并入 A ⇒ C→A（localAlias 内部无链 —— 幸存者永不并入他人）
        for (const [from, into] of this.aliases) {
            const deeper = localAlias.get(into);
            if (deeper !== undefined)
                this.aliases.set(from, deeper);
        }
        for (const [from, into] of localAlias)
            this.aliases.set(from, into);
        // 转移表重铸：键拆分用首个 '|'（from 不含 '|'，action 可能含 —— 精确还原）
        const reborn = new Map();
        for (const [key, tr] of this.transitions) {
            const bar = key.indexOf('|');
            const from = this.resolveTypeId(bar === -1 ? key : key.slice(0, bar));
            const action = bar === -1 ? '' : key.slice(bar + 1);
            const nk = `${from}|${action}`;
            let st = reborn.get(nk);
            if (!st) {
                st = { total: 0, success: 0, next: new Map() };
                reborn.set(nk, st);
            }
            st.total += tr.total;
            st.success += tr.success;
            for (const [to, n] of tr.next) {
                const cto = this.resolveTypeId(to);
                st.next.set(cto, (st.next.get(cto) ?? 0) + n);
            }
        }
        this.transitions = reborn;
        return { merged: [...localAlias.entries()].map(([from, into]) => ({ from, into })) };
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
        // ΝΩ-15：alias 透明改写（旧 id ⇒ 幸存 id）；日志记原始 id —— 重放时按
        // 父侧最新 alias 再解析（父的收拢可能晚于 fork 的观察）。
        const from = this.resolveTypeId(fromTypeId);
        const to = this.resolveTypeId(toTypeId);
        const key = `${from}|${actionKey}`;
        let stats = this.transitions.get(key);
        if (!stats) {
            stats = { total: 0, success: 0, next: new Map() };
            this.transitions.set(key, stats);
        }
        stats.total += 1;
        if (success)
            stats.success += 1;
        stats.next.set(to, (stats.next.get(to) ?? 0) + 1);
        if (this.journaling)
            this.ops.push({ k: 'observe', from: fromTypeId, action: actionKey, to: toTypeId, success });
        return { ok: true, value: undefined };
    }
    predict(fromTypeId, actionKey) {
        if (!nonEmptyStr(fromTypeId) || !nonEmptyStr(actionKey)) {
            return {
                ok: false,
                error: { field: 'transition', reason: 'fromTypeId and actionKey must be non-empty strings' },
            };
        }
        const stats = this.transitions.get(`${this.resolveTypeId(fromTypeId)}|${actionKey}`); // ΝΩ-15：alias 透明
        if (!stats)
            return { ok: true, value: null }; // 诚实的无知：无证据 ⇒ 无预测
        const nextTypes = [...stats.next.entries()]
            .map(([typeId, n]) => ({ typeId, prob: Math.round((n / stats.total) * 1000) / 1000 }))
            .sort((a, b) => b.prob - a.prob);
        // Q 纪元（Q-4）：Dirichlet(1) 平滑预测熵 + 后验集中度（契约字段，纯派生）
        const K = stats.next.size + 1; // 已见目的地 + 一个未见漏斗
        const denom = stats.total + K;
        let entropy = 0;
        for (const n of stats.next.values()) {
            const p = (n + 1) / denom;
            entropy -= p * Math.log2(p);
        }
        entropy -= (1 / denom) * Math.log2(1 / denom); // 未见漏斗的熵贡献
        return {
            ok: true,
            value: {
                nextTypes,
                successProb: Math.round((stats.success / stats.total) * 1000) / 1000,
                evidence: stats.total,
                entropyBits: Math.round(entropy * 1000) / 1000,
                posteriorConcentration: Math.round((stats.total / (stats.total + 2)) * 1000) / 1000,
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
        const stats = this.transitions.get(`${this.resolveTypeId(fromTypeId)}|${actionKey}`); // ΝΩ-15：alias 透明
        if (!stats)
            return { ok: true, value: { bits: 0, novel: true, evidence: 0 } };
        const count = stats.next.get(this.resolveTypeId(actualTypeId)) ?? 0; // 同上
        // Laplace 平滑（唯一实现见 smoothedSurpriseBits，与纪元 Κ 谱聚合同源）
        return {
            ok: true,
            value: {
                bits: Math.round(smoothedSurpriseBits(stats.total, stats.next.size, count) * 1000) / 1000,
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
     * 持久化快照：完整签名 tokens（铸造谱系）+ 转移统计 + 计数器。
     * ΝΩ-15：质心 vec 漂移后不再可由 tokens 重铸 —— 双写入档（在线均值是
     * 吸收历史的积分，丢失即遗忘）；alias 表随档（旧档无此字段 ⇒ 空表）。
     * 未漂移模型的 vec 与 tokens 重铸值同构 —— 新旧档水合语义统一。
     */
    exportSnapshot() {
        return {
            version: 1,
            types: [...this.types.entries()].map(([id, t]) => ({
                id, tokens: t.tokens, members: t.members, vec: { dims: t.vec.dims, norm: t.vec.norm },
            })),
            transitions: [...this.transitions.entries()].map(([key, t]) => {
                const [from, action] = key.split('|');
                return { from, action, total: t.total, success: t.success, next: [...t.next.entries()] };
            }),
            typeCounter: this.typeCounter,
            aliases: [...this.aliases.entries()],
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
        let maxSeq = 0; // types 里 screen-N 序号的最大值（计数器同步用，见水合尾部）
        const vecs = []; // ΝΩ-15：漂移质心（与 types 等长对齐；缺省 ⇒ 由 tokens 重铸）
        for (const t of s.types) {
            const ty = t;
            if (!ty || typeof ty.id !== 'string' || !ty.id || typeIds.has(ty.id)) {
                return bad('snapshot.types', `type id must be unique non-empty string, got ${JSON.stringify(ty?.id)}`);
            }
            typeIds.add(ty.id);
            const seq = /^screen-(\d+)$/.exec(ty.id)?.[1];
            if (seq !== undefined)
                maxSeq = Math.max(maxSeq, Number.parseInt(seq, 10));
            if (!Array.isArray(ty.tokens) || ty.tokens.length === 0 || !ty.tokens.every((x) => typeof x === 'string')) {
                return bad('snapshot.types', `type "${ty.id}" tokens must be non-empty string array`);
            }
            if (typeof ty.members !== 'number' || ty.members < 1) {
                return bad('snapshot.types', `type "${ty.id}" members must be number >= 1`);
            }
            // ΝΩ-15：质心 vec 预检（向后兼容：旧档无字段 ⇒ undefined ⇒ tokens 重铸）。
            // 桶号严格递增是 cosine 双指针合并的格式前提（embed/blend 同律）——
            // 乱序/重复桶 = 损档，静默错算不如整体拒绝。
            if (ty.vec === undefined) {
                vecs.push(undefined);
            }
            else {
                if (!ty.vec || typeof ty.vec !== 'object') {
                    return bad('snapshot.types', `type "${ty.id}" vec must be an object`);
                }
                const vo = ty.vec;
                if (!Array.isArray(vo.dims) || typeof vo.norm !== 'number' || !Number.isFinite(vo.norm) || vo.norm < 0) {
                    return bad('snapshot.types', `type "${ty.id}" vec must have dims array and finite norm >= 0`);
                }
                let prevBucket = Number.NEGATIVE_INFINITY;
                const dims = [];
                for (const d of vo.dims) {
                    if (!Array.isArray(d) || d.length !== 2 || typeof d[0] !== 'number' || !Number.isFinite(d[0]) ||
                        typeof d[1] !== 'number' || !Number.isFinite(d[1])) {
                        return bad('snapshot.types', `type "${ty.id}" vec.dims must be [finite number, finite number] pairs`);
                    }
                    if (d[0] <= prevBucket) {
                        return bad('snapshot.types', `type "${ty.id}" vec.dims buckets must be strictly ascending`);
                    }
                    prevBucket = d[0];
                    dims.push([d[0], d[1]]);
                }
                vecs.push({ dims, norm: vo.norm });
            }
        }
        // ΝΩ-15：alias 表预检（向后兼容：旧档无字段 ⇒ 空表）。source 不得是活类型
        // （被并走的 id 已出册）、不得自指、不得重复；每条链沿表走到终点必须是
        // 活类型 —— 环与悬空 = 损档，整体拒绝。
        const aliasPairs = [];
        if (s.aliases !== undefined) {
            if (!Array.isArray(s.aliases)) {
                return bad('snapshot.aliases', 'aliases must be an array of [old, into] pairs');
            }
            const seenSrc = new Set();
            for (const p of s.aliases) {
                if (!Array.isArray(p) || p.length !== 2 || !nonEmptyStr(p[0]) || !nonEmptyStr(p[1])) {
                    return bad('snapshot.aliases', 'aliases must be [non-empty string, non-empty string] pairs');
                }
                if (seenSrc.has(p[0]))
                    return bad('snapshot.aliases', `duplicate alias source "${p[0]}"`);
                seenSrc.add(p[0]);
                if (p[0] === p[1])
                    return bad('snapshot.aliases', `alias source "${p[0]}" points to itself`);
                if (typeIds.has(p[0]))
                    return bad('snapshot.aliases', `alias source "${p[0]}" must not be a live type`);
                aliasPairs.push([p[0], p[1]]);
            }
            const chain = new Map(aliasPairs);
            for (const [src] of aliasPairs) {
                let cur = src;
                let hops = 0;
                while (chain.has(cur)) {
                    cur = chain.get(cur);
                    hops += 1;
                    if (hops > aliasPairs.length) {
                        return bad('snapshot.aliases', `alias chain from "${src}" is cyclic`);
                    }
                }
                if (!typeIds.has(cur)) {
                    return bad('snapshot.aliases', `alias chain from "${src}" dangles: "${cur}" not in snapshot.types`);
                }
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
            // O 纪元（#21 残差根除）：悬空引用不入库 —— from 与 next 的 typeId 必须
            // 指向 types 中真实存在的类型；否则 predict/surprise 将对幽灵类型给出
            // 假概率。附带两重记账不变量：next 键不重复（数组转 Map 会静默去重吞
            // 计数）、sum(next) === total（observe 每次必记 next —— 破缺即篡改/损坏）。
            if (!typeIds.has(tr.from)) {
                return bad('snapshot.transitions', `transition "${tr.from}|${tr.action}" dangles: from type not in snapshot.types`);
            }
            const seenNext = new Set();
            let nextSum = 0;
            for (const p of tr.next) {
                if (!typeIds.has(p[0])) {
                    return bad('snapshot.transitions', `transition "${tr.from}|${tr.action}" dangles: next type "${p[0]}" not in snapshot.types`);
                }
                if (seenNext.has(p[0])) {
                    return bad('snapshot.transitions', `transition "${tr.from}|${tr.action}" has duplicate next key "${p[0]}"`);
                }
                seenNext.add(p[0]);
                nextSum += p[1];
            }
            if (nextSum !== tr.total) {
                return bad('snapshot.transitions', `transition "${tr.from}|${tr.action}" bookkeeping broken: sum(next)=${nextSum} != total=${tr.total}`);
            }
        }
        // 换脑：预检全过后整批入账，质心优先档值、缺省由 tokens 重铸
        this.types.clear();
        this.transitions.clear();
        this.aliases.clear();
        for (const [from, into] of aliasPairs)
            this.aliases.set(from, into);
        for (let i = 0; i < s.types.length; i++) {
            const ty = s.types[i];
            this.types.set(ty.id, { tokens: ty.tokens, vec: vecs[i] ?? embed(ty.tokens.join(' ')), members: ty.members });
        }
        for (const t of s.transitions) {
            const tr = t;
            const next = new Map(tr.next);
            this.transitions.set(`${tr.from}|${tr.action}`, { total: tr.total, success: tr.success, next });
        }
        // 计数器同步到已水合 id 的最大序号（与 merge 的同步律同源）—— 否则快照
        // 携带偏小 typeCounter 时，下次铸造会同号覆写既有类型（members/tokens 静默丢失）
        this.typeCounter = typeof s.typeCounter === 'number' && Number.isFinite(s.typeCounter)
            ? Math.max(0, Math.floor(s.typeCounter), maxSeq) : Math.max(this.types.size, maxSeq);
        return { ok: true, value: undefined };
    }
}
// ─── 纪元 Κ（惊异课程）：惊异谱 ───
/**
 * 世界模型的惊异谱：按屏幕类型聚合转移表惊讶，产出 { [screenType]: 平均 bits }。
 * 聚合口径：每类型的全部出弧观察按次数加权平均 —— 类型 T 的谱值 =
 * Σ(count × Laplace 平滑惊讶) / Σcount，逐转移惊讶经 smoothedSurpriseBits
 * 计算（与 surprise() 方法同源同实现，绝不复制口径）。
 * 只入册而无出弧证据的类型记 0（「见过这屏、没见过它去哪」= 对其动力学无
 * 主张的诚实读数，不是零惊讶的伪装 —— 谱消费方自行决定探索权重）。
 * 纯函数（零副作用 —— 经 exportSnapshot 只读快照聚合，不动模型半分）；
 * 异常诚实铁律：model 缺席 / 非 InMemoryWorldModel / 空模型 / 聚合异常
 * ⇒ 空对象（诚实无知，绝不铸造幽灵谱，绝不 throw）。
 */
export function surpriseSpectrum(model) {
    try {
        if (!(model instanceof InMemoryWorldModel))
            return {};
        const snap = model.exportSnapshot();
        const sums = new Map();
        for (const ty of snap.types)
            sums.set(ty.id, { bits: 0, n: 0 });
        for (const tr of snap.transitions) {
            if (typeof tr.from !== 'string' || tr.from === '')
                continue;
            if (!Number.isFinite(tr.total) || tr.total < 1 || !Array.isArray(tr.next))
                continue;
            const acc = sums.get(tr.from) ?? { bits: 0, n: 0 };
            const distinct = tr.next.length;
            for (const [to, count] of tr.next) {
                if (typeof to !== 'string' || !Number.isFinite(count) || count < 1)
                    continue;
                acc.bits += count * smoothedSurpriseBits(tr.total, distinct, count);
                acc.n += count;
            }
            sums.set(tr.from, acc);
        }
        const out = {};
        for (const [id, acc] of sums) {
            out[id] = acc.n > 0 ? Math.round((acc.bits / acc.n) * 1000) / 1000 : 0;
        }
        return out;
    }
    catch {
        return {}; // 谱聚合绝不 throw（运行层铁律）
    }
}
