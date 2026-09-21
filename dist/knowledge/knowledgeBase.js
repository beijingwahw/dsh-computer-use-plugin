import { embed, cosine } from '../semanticHash.js';
import { P } from './params.js';
/** 分类学全集（insert 铸造点的域执法依据） */
const CATEGORIES = [
    'ui-pattern', 'shortcut', 'system-quirk',
    'business-rule', 'error-pattern', 'workflow', 'preference',
];
/** 知识内容预算（契约立法值 —— KnowledgeEntry.content ≤500 字符；D-7 工具面文案同源引用） */
export const CONTENT_MAX_CHARS = 500;
/** 注入摘要预算上限（契约立法值 —— KnowledgeInjection.summary ≤300 字符；
 *  configValidator 的 knowledgeMaxChars 域上界同源引用 —— 单一事实源） */
export const INJECTION_MAX_CHARS = 300;
/** 库容量上限（防无限膨胀：超限驱逐最低使用度的 auto-learn 条目 —— manual 永不驱逐） */
const MAX_ENTRIES = 1000;
// ─── 算法形状字面量（出册常数 —— 校准无可行区间，值即设计，非调参旋钮）───
/** 语义通道权重：hybrid = keyword 命中 + 2×cosine。校准：包络内全域不敏感
 *  （keyword 通道主导）；通道保留为零样本泛化能力，权重是形状不是旋钮。 */
const SEMANTIC_WEIGHT = 2;
/** 语义地板：cosine < 0.2 不计分 —— n-gram 噪声零容忍 */
const SEMANTIC_FLOOR = 0.2;
/** 失败学习初始置信度。校准：全域不敏感 —— REINFORCE_STEP（登记参数）才是
 *  学习动力学承重者：即使初始 0，3 次复证也升到 0.51 过压制阈值。 */
const AUTO_LEARN_FAILURE_CONFIDENCE = 0.3;
/** 成簇最小规模：两条重合是巧合，三条重合是模式（政策值，契约测试守护结构） */
const MIN_CLUSTER_SIZE = 3;
/** 成簇 cosine 阈值（场景聚类的引力常数 —— 布局方言定义） */
const CLUSTER_SIMILARITY = 0.45;
/** 共识加成系数（√n 形式：多源复证增益随规模衰减）。契约界定 (0, ~0.5)：
 *  0 无共识语义、过大顶格 1 失去信息；0.1 取下沿保守点。 */
const CONSENSUS_BONUS = 0.1;
/** 皮层化衰减：情景让位语义，留痕不销毁（knowledge.test 钉住 0.4×0.5=0.2） */
const CORTICALIZE_DECAY = 0.5;
/** 置信度半衰期基线（E-1 间隔重复：未复证条目的 30 天缺省）。数值是部署域假设
 *  （包络内时间不流逝，不可证伪）；衰减形状（过滤 + 排序让位）由
 *  knowledge.test 免疫 #1 时间旅行守护 —— 它只测未复证条目，基线形状零回归。 */
const CONFIDENCE_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
/** E-1 稳定性增长系数：每次复证半衰期 ×1.6 —— Ebbinghaus 间隔效应的工程化
 *  （FSRS/SuperMemo 文献报告单次复习稳定性增益 ×1.2~×2.5，取下沿保守值）。
 *  算法形状字面量（值即设计，非旋钮）：「复习让记忆更牢」的机制形状，
 *  epochE.test 间隔重复用例守护「复证条目抗遗忘 ≫ 未复证条目」的序关系。 */
const STABILITY_GROWTH = 1.6;
/** E-1 稳定性封顶（365 天）：一年不复证的记忆无论如何加固都让位 —— 世界会变，
 *  间隔效应不能把旧知识变成永恒（封顶是诚实性约束，不是性能参数）。 */
const HALF_LIFE_CAP_MS = 365 * 24 * 60 * 60 * 1000;
/** 分词（J 纪元统一）：复用 `../uiMemory` 的 tokenize（拉丁词 + CJK 单字 + 二元组）。
 *  旧实现私有一份「CJK 连续串整体」的分词 —— 与决策工位（reflexArc/deliberate
 *  经 uiMemory.tokenize）不同构：同一个中文词在两通道被切成不同粒度，KB 的
 *  keyword 通道（长串 includes 精确匹配）在中文场景几乎必然哑火，只剩语义通道兜底。 */
import { tokenize } from '../uiMemory.js';
/** 遗忘曲线（纯函数）：c × 0.5^(age/半衰期)。age=0 ⇒ 原值；越老越冷。
 *  E-1 间隔重复：半衰期逐条目化 —— 条目自带 halfLifeMs（复证增长），
 *  缺席回退 30 天基线（旧档/未复证自然降级，零迁移成本）；封顶 365 天。 */
function decay(confidence, updatedAt, now, halfLifeMs) {
    const age = Math.max(0, now - updatedAt);
    const hl = Math.min(typeof halfLifeMs === 'number' && Number.isFinite(halfLifeMs) && halfLifeMs > 0
        ? halfLifeMs : CONFIDENCE_HALF_LIFE_MS, HALF_LIFE_CAP_MS);
    return confidence * Math.pow(0.5, age / hl);
}
/** 亲证半衰期（核证接地纪元，出册常数）：信任 = 置信度 × 0.5^(age/半衰期)。
 *  与 CONFIDENCE_HALF_LIFE_MS 同律（30 天 UI 改版代谢周期量级）：数值是
 *  部署域假设（包络内时间不流逝，不可证伪）；衰减形状由单元测试
 *  （信任生命周期）时间旅行守护。 */
const VERIFIED_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * 信任度（核证接地纪元，纯函数）：confidence × 亲证因子。
 *   传闻（verifiedAt 缺席）⇒ 0 —— 没被亲证过的证据不配压制到死；
 *   亲证 ⇒ 随时间衰减（陈年亲证让位新鲜亲证 —— 世界会变，亲证会过期）。
 * 与遗忘曲线 decay() 分工：decay 评估「内容新鲜度」（检索排序），
 * trustOf 评估「证据资格」（接地前门控）—— 两个时钟，两种经济学。
 */
export function trustOf(confidence, verifiedAt, now) {
    if (verifiedAt === undefined || !Number.isFinite(verifiedAt))
        return 0;
    const age = Math.max(0, now - verifiedAt);
    return confidence * Math.pow(0.5, age / VERIFIED_HALF_LIFE_MS);
}
/**
 * 蒸馏器：KnowledgeResult → KnowledgeInjection（V2 防卡顿蒸馏版）。
 * 摘要硬预算 maxChars（≤300）在此铸造点执法 —— 结构保证，不靠下游自觉。
 * 'import' 来源不进 sources（注入溯源只认 manual / auto-learn —— import 是只读档案）。
 * 类别鸡尾酒：按类别轮转采样（每类轮流取一条）—— 同类扎堆时注入保持组合多样性，
 * 老员工直觉是「弹窗模式 + 失败史 + 系统怪癖」的组合判断，不是同类复读。
 */
export function distillInjection(result, maxChars) {
    if (!result || result.entries.length === 0)
        return null;
    const budget = Math.max(1, Math.min(maxChars, INJECTION_MAX_CHARS));
    const rotated = cocktailRotate(result.entries);
    const parts = [];
    const fragments = [];
    let used = 0;
    for (const e of rotated) {
        const frag = `[${e.category}] ${e.content}`;
        if (parts.length > 0 && used + frag.length > budget)
            break;
        parts.push(frag);
        // fragments 与 summary 同源同序（单一真相）—— 前额叶仿真 + 信任评估的证据面
        fragments.push({ category: e.category, content: e.content, confidence: e.confidence, verifiedAt: e.verifiedAt });
        used += frag.length;
        if (used >= budget)
            break;
    }
    return {
        summary: parts.join('; ').slice(0, budget),
        categories: [...new Set(result.entries.map(e => e.category))],
        maxConfidence: Math.max(...result.entries.map(e => e.confidence)),
        sources: result.entries
            .filter(e => e.source !== 'import')
            .map(e => ({ type: e.source, ref: e.id })),
        fragments,
    };
}
/** 类别轮转（纯函数）：保序分组 → 按类别出现序轮流取一条；单类别输入 ⇒ 原序直通 */
function cocktailRotate(entries) {
    const byCategory = new Map();
    for (const e of entries) {
        const bucket = byCategory.get(e.category) ?? [];
        bucket.push(e);
        byCategory.set(e.category, bucket);
    }
    if (byCategory.size <= 1)
        return [...entries]; // 单类别：轮退化为原序
    const out = [];
    let emitted = true;
    while (emitted) {
        emitted = false;
        for (const bucket of byCategory.values()) {
            const next = bucket.shift();
            if (next) {
                out.push(next);
                emitted = true;
            }
        }
    }
    return out;
}
/** 学习蒸馏的主题键（免疫应答的抗原匹配键：同场景 = 同抗原） */
function learnTopicKey(scenario) {
    return scenario.trim().toLowerCase();
}
/**
 * 内存隐知识库（免疫系统纪元）。
 * 零持久化 —— 落盘策略（JSONL / sqlite）是留白；dispose 即归零，绝不留泄漏。
 */
export class InMemoryKnowledgeBase {
    entries = new Map();
    /** 语义向量缓存（insert 铸造 / 驱逐同步清 —— 与条目同生命周期，绝不悬空） */
    vectors = new Map();
    /** 已皮层化的情景条目（已折叠进某条语义记忆 —— 重复 consolidate 不再参与聚类） */
    corticalizedIds = new Set();
    /** 语义记忆产物 ID（consolidate 铸造 —— 它们是皮层内容物，不是情景） */
    semanticMemoryIds = new Set();
    idCounter = 0;
    query(query) {
        if (!query || typeof query !== 'object') {
            return { ok: false, error: { field: 'query', reason: 'query must be an object' } };
        }
        if (typeof query.sceneDescription !== 'string' || typeof query.intentDescription !== 'string') {
            return { ok: false, error: { field: 'query', reason: 'sceneDescription and intentDescription are required strings' } };
        }
        const startedAt = Date.now();
        const text = `${query.sceneDescription} ${query.intentDescription}`;
        const tokens = tokenize(text);
        const queryVec = embed(text);
        const minConfidence = query.minConfidence ?? 0;
        const maxResults = query.maxResults ?? 5;
        // 域执法（与 insert 同律 —— 域外拒绝，不钳制）：NaN/负数经 slice/filter
        // 静默产出错误结果集（NaN ⇒ 恒空；负数 ⇒ 从尾部截断）
        if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
            return { ok: false, error: { field: 'minConfidence', reason: `minConfidence must be in [0,1], got ${minConfidence} (domain rejection, no clamp)` } };
        }
        if (!Number.isInteger(maxResults) || maxResults < 1) {
            return { ok: false, error: { field: 'maxResults', reason: `maxResults must be a positive integer, got ${maxResults} (domain rejection, no clamp)` } };
        }
        const ranked = [...this.entries.values()]
            // 遗忘曲线执法点：过滤与排序均用有效置信度 —— 老知识自然让位
            .map(e => ({ entry: e, eff: decay(e.confidence, e.updatedAt, startedAt, e.halfLifeMs) }))
            .filter(({ entry, eff }) => eff >= minConfidence)
            .map(({ entry, eff }) => ({ entry, eff, score: this.hybridScore(entry, tokens, queryVec) }))
            .filter(s => s.score > 0)
            .sort((a, b) => b.score - a.score || b.eff - a.eff)
            .slice(0, maxResults);
        // 使用度簿记（检索即使用 —— usageCount 是后续置信度进化的燃料）
        for (const { entry } of ranked)
            entry.usageCount += 1;
        return {
            ok: true,
            value: { entries: ranked.map(r => r.entry), latencyMs: Date.now() - startedAt, strategy: 'hybrid' },
        };
    }
    /**
     * hybrid 双通道评分（纯函数视角）：**BM25** 词法通道主导 + 语义 cosine 补零样本泛化。
     * R 纪元（R-2 检索层）升级：词法通道从**二值命中计数**升格为 BM25
     * （Robertson & Spärck Jones 血统；k1=1.2、b=0.75 惯例甜点）——
     *   score = Σ_t IDF(t)·tf·(k1+1)/(tf + k1·(1−b+b·|d|/avgdl))
     * IDF = ln((N−df+0.5)/(df+0.5)+1)（Lucene 非负形）。三重收益：
     * ① 稀有词（'token' 类）比常见词（'click' 类）按语料统计**应当**更重 ——
     *   二值计数把它们等权；② 条目长度归一 —— 长文本不再靠篇幅堆命中；
     * ③ tf 饱和 —— 同词重复出现边际递减。
     * J 纪元 Set 去重口径保留（query 侧）；tf 按条目侧真实词频计数。
     */
    hybridScore(entry, tokens, queryVec) {
        let bm25 = 0;
        if (tokens.length > 0 && this.entries.size > 0) {
            const k1 = 1.2, b = 0.75;
            const N = this.entries.size;
            const docText = `${entry.scenario} ${entry.content}`.toLowerCase();
            const docTokens = tokenize(docText);
            const tfMap = new Map();
            for (const t of docTokens)
                tfMap.set(t, (tfMap.get(t) ?? 0) + 1);
            // 语料统计（df / avgdl —— 检索时刻实算，条目集小到无需缓存）
            let lenSum = 0;
            const docLen = docTokens.length;
            for (const e of this.entries.values()) {
                lenSum += tokenize(`${e.scenario} ${e.content}`.toLowerCase()).length;
            }
            const avgdl = Math.max(1, lenSum / N);
            const norm = k1 * (1 - b + b * (docLen / avgdl));
            for (const t of new Set(tokens)) {
                const tf = tfMap.get(t);
                if (!tf)
                    continue;
                // df：含该 token 的条目数（首次出现位置线性扫 —— N 小，即用即算）
                let dcount = 0;
                for (const e of this.entries.values()) {
                    if (`${e.scenario} ${e.content}`.toLowerCase().includes(t))
                        dcount++;
                }
                const idf = Math.log((N - dcount + 0.5) / (dcount + 0.5) + 1);
                bm25 += idf * (tf * (k1 + 1)) / (tf + norm);
            }
        }
        const vec = this.vectors.get(entry.id);
        const sim = vec ? cosine(queryVec, vec) : 0;
        // BM25 无界（IDF 随 N 增长）—— 归一到 [0, ~N] 域后与语义权重同尺度：
        // 以 1 为词法单位（典型单命中 BM25 ≈ 1-4），除以 2 保持与旧二值分同量级
        return bm25 / 2 + (sim >= SEMANTIC_FLOOR ? SEMANTIC_WEIGHT * sim : 0);
    }
    insert(entry) {
        if (!entry || typeof entry !== 'object') {
            return { ok: false, error: { field: 'entry', reason: 'entry must be an object' } };
        }
        if (!CATEGORIES.includes(entry.category)) {
            return { ok: false, error: { field: 'category', reason: `unknown category "${entry.category}" (taxonomy: ${CATEGORIES.join('|')})` } };
        }
        if (!Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1) {
            return { ok: false, error: { field: 'confidence', reason: `confidence must be in [0,1], got ${entry.confidence} (domain rejection, no clamp)` } };
        }
        const content = String(entry.content ?? '');
        if (!content.trim()) {
            return { ok: false, error: { field: 'content', reason: 'content must be non-empty' } };
        }
        if (entry.source !== 'manual' && entry.source !== 'auto-learn' && entry.source !== 'import') {
            return { ok: false, error: { field: 'source', reason: `source must be manual|auto-learn|import, got "${entry.source}"` } };
        }
        // 容量守卫：驱逐最低使用度的 auto-learn 条目（manual/import 是造物主主权，永不驱逐）。
        // 风险加固：全部条目皆不可驱逐（全 manual/import）时 —— 诚实拒绝插入，
        // 绝不静默越限膨胀（容量上限是结构承诺，不是软建议）。
        if (this.entries.size >= MAX_ENTRIES) {
            let victim = null;
            let victimUsage = Number.POSITIVE_INFINITY;
            for (const [id, e] of this.entries) {
                if (e.source === 'auto-learn' && e.usageCount < victimUsage) {
                    victim = id;
                    victimUsage = e.usageCount;
                }
            }
            if (!victim) {
                return {
                    ok: false,
                    error: {
                        field: 'capacity',
                        reason: `knowledge base at capacity (${MAX_ENTRIES}) with no evictable auto-learn entries — insert rejected (manual/import are sovereign; raise capacity or prune)`,
                    },
                };
            }
            this.entries.delete(victim);
            this.vectors.delete(victim);
            this.corticalizedIds.delete(victim);
            this.semanticMemoryIds.delete(victim);
        }
        this.idCounter += 1;
        const id = `kb-${Date.now().toString(36)}-${this.idCounter}`;
        this.entries.set(id, {
            id,
            category: entry.category,
            content: content.slice(0, CONTENT_MAX_CHARS),
            scenario: String(entry.scenario ?? ''),
            confidence: entry.confidence,
            source: entry.source,
            updatedAt: Date.now(),
            usageCount: 0,
            intentRef: entry.intentRef,
            // 亲证透传（核证接地纪元）：缺席 = 传闻（manual 种子缺省身份——
            // 他人转述/手工断言，从未被直接观察证实）；显式在场 = 造物主亲证背书
            verifiedAt: entry.verifiedAt,
        });
        // 语义向量铸造（hybrid 通道的检索索引 —— insert 时一次成型，query 零重算）
        this.vectors.set(id, embed(`${entry.scenario} ${entry.content}`));
        return { ok: true, value: id };
    }
    learnFromOutcome(outcome) {
        if (!outcome || !outcome.intent || !outcome.action || !outcome.result) {
            return { ok: false, error: { field: 'outcome', reason: 'malformed outcome (intent/action/result required)' } };
        }
        const failed = outcome.result.status === 'failure';
        const category = failed ? 'error-pattern' : 'workflow';
        const topic = learnTopicKey(outcome.intent.description);
        const now = Date.now();
        // ── 免疫应答扫描：同场景（同抗原）的既有 auto-learn 结论 ──
        //   同结论 ⇒ 复证强化（滴度升高，不新建条目 —— 防库膨胀）
        //   反结论 ⇒ 反证衰减（旧条目减半下沉）+ 新条目照常插入（矛盾双留痕）
        // 亲证铸造三律（核证接地纪元）：
        //   复证 ⇒ verifiedAt 刷新（又一次直接观察证实 —— 亲证保鲜）
        //   反证 ⇒ verifiedAt 不动（证伪不是证实 —— 旧亲证仍是它最后一次被
        //         证实的时刻，矛盾交给 confidence 下沉表达）
        //   新铸 ⇒ verifiedAt = now（自体学习生而亲证 —— 与 manual 种子的
        //         传闻身份对立：执行结果是自己亲眼看的）
        let reinforced = false;
        for (const e of this.entries.values()) {
            if (e.source !== 'auto-learn' || learnTopicKey(e.scenario) !== topic)
                continue;
            if (e.category === category) {
                e.confidence = e.confidence + (1 - e.confidence) * P.REINFORCE_STEP; // 渐近 1，结构不越界
                e.updatedAt = now; // 复证即保鲜（遗忘曲线重置）
                e.verifiedAt = now; // 复证即亲证（信任时钟重置）
                // E-1 间隔重复：复证不仅升滴度（confidence），也升稳定性（半衰期 ×1.6）——
                // 越被复证的记忆越抗遗忘；封顶 365 天（间隔效应不许把旧知识变成永恒）
                e.halfLifeMs = Math.min(HALF_LIFE_CAP_MS, Math.round((e.halfLifeMs ?? CONFIDENCE_HALF_LIFE_MS) * STABILITY_GROWTH));
                reinforced = true;
            }
            else {
                e.confidence = e.confidence * P.DISCONFIRM_DECAY; // 反证：下沉但绝不销毁证据
            }
        }
        if (reinforced)
            return { ok: true, value: undefined }; // 抗体已有：滴度升高即完成学习
        // J 纪元修正：degraded（效果未验证）的痕迹如实标注 —— 旧实现把
        // "completed with degraded verification" 学成 "succeeded"，语义有损。
        const degradedNote = !failed && outcome.result.status === 'degraded'
            ? ' [degraded — effect unverified]' : '';
        const content = failed
            ? `action ${outcome.action.kind} failed (${outcome.result.failure?.kind ?? 'unclassified'}): ${outcome.result.failure?.detail ?? outcome.result.status}`
            : `action ${outcome.action.kind} succeeded${degradedNote} for intent "${outcome.intent.description.slice(0, 80)}" (retries: ${outcome.retryCount})`;
        const r = this.insert({
            category,
            content,
            scenario: outcome.intent.description,
            confidence: failed ? AUTO_LEARN_FAILURE_CONFIDENCE : P.AUTO_LEARN_SUCCESS_CONFIDENCE,
            source: 'auto-learn',
            intentRef: outcome.intent.id,
            verifiedAt: now, // 生而亲证：亲历执行的直接观察（核证接地纪元）
        });
        return r.ok ? { ok: true, value: undefined } : { ok: false, error: r.error };
    }
    dispose() {
        this.entries.clear();
        this.vectors.clear();
        this.corticalizedIds.clear();
        this.semanticMemoryIds.clear();
        this.idCounter = 0;
        return { ok: true, value: undefined };
    }
    /**
     * 睡眠整合（海马体→皮层）：auto-learn 情景条目按语义向量聚类（贪心单链，
     * cosine ≥ CLUSTER_SIMILARITY 同簇），≥ MIN_CLUSTER_SIZE 的簇蒸馏为一条
     * 语义记忆（多数类别 + 共识置信度 + 跨场景主题），原情景条目皮层化衰减
     * （×CORTICALIZE_DECAY —— 让位不销毁：证据永远留痕，只是不再占据检索前排）。
     *
     * 生物学对应：海马体快速记录的逐条经历，在睡眠中回放、聚类、抽象为皮层的
     * 概括性知识 —— 「这三次点击都失败」变成「此类弹窗的确定按钮是陷阱」。
     * 幂等安全：重复 consolidate 已衰减的条目会因有效置信度过低自然出局。
     */
    consolidate() {
        const startedAt = Date.now();
        // 情景收集：auto-learn 且未被皮层化且非语义记忆产物（幂等双守卫）
        const episodes = [...this.entries.values()].filter(e => e.source === 'auto-learn' &&
            !this.corticalizedIds.has(e.id) &&
            !this.semanticMemoryIds.has(e.id));
        if (episodes.length < MIN_CLUSTER_SIZE) {
            return { ok: true, value: { episodes: episodes.length, clusters: 0, consolidated: 0, episodedDecayed: 0, durationMs: Date.now() - startedAt } };
        }
        // 贪心单链聚类：以未分簇条目为种子，吸收所有语义近邻
        const unassigned = new Set(episodes);
        const clusters = [];
        for (const seed of episodes) {
            if (!unassigned.has(seed))
                continue;
            const cluster = [seed];
            unassigned.delete(seed);
            const seedVec = this.vectors.get(seed.id);
            if (seedVec) {
                for (const other of unassigned) {
                    const otherVec = this.vectors.get(other.id);
                    if (otherVec && cosine(seedVec, otherVec) >= CLUSTER_SIMILARITY) {
                        cluster.push(other);
                    }
                }
                for (const member of cluster)
                    unassigned.delete(member);
            }
            if (cluster.length >= MIN_CLUSTER_SIZE)
                clusters.push(cluster);
        }
        // 逐簇蒸馏：多数类别 + 共识置信度 + 跨场景主题（簇内最高置信条目的场景为代表）
        let consolidated = 0;
        let episodedDecayed = 0;
        for (const cluster of clusters) {
            const byCategory = new Map();
            for (const e of cluster)
                byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + 1);
            let category = cluster[0].category;
            let bestCount = 0;
            for (const [cat, n] of byCategory)
                if (n > bestCount) {
                    bestCount = n;
                    category = cat;
                }
            const meanConfidence = cluster.reduce((s, e) => s + e.confidence, 0) / cluster.length;
            const consensus = Math.min(1, meanConfidence + CONSENSUS_BONUS * Math.sqrt(cluster.length));
            const representative = cluster.reduce((a, b) => (b.confidence > a.confidence ? b : a));
            const content = `consolidated pattern from ${cluster.length} episodes: ${representative.content.slice(0, 340)}`;
            const r = this.insert({
                category,
                content,
                scenario: representative.scenario,
                confidence: Math.round(consensus * 1000) / 1000,
                source: 'auto-learn',
            });
            if (r.ok) {
                this.semanticMemoryIds.add(r.value);
                consolidated += 1;
                for (const e of cluster) {
                    e.confidence = Math.round(e.confidence * CORTICALIZE_DECAY * 1000) / 1000;
                    this.corticalizedIds.add(e.id);
                    episodedDecayed += 1;
                }
            }
            // insert 失败（容量守卫拒绝）⇒ 该簇跳过，情景条目保持原置信度 —— 整合是旁路义务
        }
        return {
            ok: true,
            value: {
                episodes: episodes.length,
                clusters: clusters.length,
                consolidated,
                episodedDecayed,
                durationMs: Date.now() - startedAt,
            },
        };
    }
    /** 库存快照（工具面/测试用；只读投影，绝不外泄内部 Map） */
    snapshot() {
        return [...this.entries.values()];
    }
    /**
     * 持久化快照（跨会话记忆的序列化面）：全条目 + 皮层化簿记 + ID 计数器。
     * 语义向量不序列化 —— embed 确定性，水合时重铸（杜绝格式漂移双真相）。
     */
    exportSnapshot() {
        return {
            version: 1,
            entries: this.snapshot(),
            corticalizedIds: [...this.corticalizedIds],
            semanticMemoryIds: [...this.semanticMemoryIds],
            idCounter: this.idCounter,
        };
    }
    /**
     * 快照水合（异常诚实）：域外拒绝（版本不符/结构非法 ⇒ Result 错误，绝不半水合）。
     * 水合前清空（换脑语义：一次水合 = 一次完整人格移植，不与旧记忆混合）。
     * 向量重铸在条目入账后一次完成（insert 路径之外的直接铸造 —— 与 insert 同律）。
     */
    restoreSnapshot(snap) {
        if (!snap || typeof snap !== 'object') {
            return { ok: false, error: { field: 'snapshot', reason: 'snapshot must be an object' } };
        }
        const s = snap;
        if (s.version !== 1) {
            return { ok: false, error: { field: 'snapshot.version', reason: `unsupported snapshot version ${JSON.stringify(s.version)}` } };
        }
        if (!Array.isArray(s.entries)) {
            return { ok: false, error: { field: 'snapshot.entries', reason: 'entries must be an array' } };
        }
        // J 纪元修正：快照水合执法容量上限 —— 旧实现绕过 MAX_ENTRIES（insert 才
        // 执法），一个 5000 条的合法结构快照会完整入账挤爆记忆预算。
        if (s.entries.length > MAX_ENTRIES) {
            return { ok: false, error: { field: 'snapshot.entries', reason: `snapshot carries ${s.entries.length} entries, capacity is ${MAX_ENTRIES} (domain rejection, no silent truncation)` } };
        }
        // 全量预检（先验后写：任一条目非法 ⇒ 整体拒绝，绝不部分水合）
        const idSet = new Set();
        for (const e of s.entries) {
            const entry = e;
            if (!entry || typeof entry !== 'object') {
                return { ok: false, error: { field: 'snapshot.entries', reason: 'entry must be an object' } };
            }
            if (typeof entry.id !== 'string' || entry.id.length === 0 || idSet.has(entry.id)) {
                return { ok: false, error: { field: 'snapshot.entries', reason: `entry id must be unique non-empty string, got ${JSON.stringify(entry.id)}` } };
            }
            idSet.add(entry.id);
            if (!CATEGORIES.includes(entry.category)) {
                return { ok: false, error: { field: 'snapshot.entries', reason: `entry "${entry.id}" has unknown category "${entry.category}"` } };
            }
            if (typeof entry.confidence !== 'number' || entry.confidence < 0 || entry.confidence > 1) {
                return { ok: false, error: { field: 'snapshot.entries', reason: `entry "${entry.id}" confidence out of [0,1]` } };
            }
            if (typeof entry.content !== 'string' || !entry.content.trim()) {
                return { ok: false, error: { field: 'snapshot.entries', reason: `entry "${entry.id}" content must be non-empty string` } };
            }
            // 亲证时间戳域执法（核证接地纪元）：在场必须是有限数；缺席 = 传闻
            // （旧快照自然降级为传闻身份 —— verifiedAt 的缺席本身就是语义）
            if (entry.verifiedAt !== undefined &&
                (typeof entry.verifiedAt !== 'number' || !Number.isFinite(entry.verifiedAt))) {
                return { ok: false, error: { field: 'snapshot.entries', reason: `entry "${entry.id}" verifiedAt must be a finite number when present` } };
            }
            // E-1 稳定性域执法：在场必须是正有限数（0/负/非数 = 结构谎言，域外拒绝）；
            // 缺席 = 30 天基线（旧档自然降级 —— 间隔重复对历史档案零迁移成本）
            if (entry.halfLifeMs !== undefined &&
                (typeof entry.halfLifeMs !== 'number' || !Number.isFinite(entry.halfLifeMs) || entry.halfLifeMs <= 0)) {
                return { ok: false, error: { field: 'snapshot.entries', reason: `entry "${entry.id}" halfLifeMs must be a positive finite number when present` } };
            }
            // 剩余簿记字段域执法（外部 JSON 完整性 —— 与 insert 铸造点同律）：
            // updatedAt 非有限数会让 decay() 产出 NaN（条目静默不可见）；source 词表外
            // 条目不可被驱逐（eviction 只驱逐 auto-learn）⇒ 可锁死库容；scenario 缺失
            // 让语义向量铸造成空串（检索通道失明）
            if (entry.source !== 'manual' && entry.source !== 'auto-learn' && entry.source !== 'import') {
                return { ok: false, error: { field: 'snapshot.entries', reason: `entry "${entry.id}" has unknown source "${JSON.stringify(entry.source)}"` } };
            }
            if (typeof entry.updatedAt !== 'number' || !Number.isFinite(entry.updatedAt)) {
                return { ok: false, error: { field: 'snapshot.entries', reason: `entry "${entry.id}" updatedAt must be a finite number` } };
            }
            if (typeof entry.usageCount !== 'number' || !Number.isFinite(entry.usageCount) || entry.usageCount < 0) {
                return { ok: false, error: { field: 'snapshot.entries', reason: `entry "${entry.id}" usageCount must be a non-negative finite number` } };
            }
            if (typeof entry.scenario !== 'string' || !entry.scenario.trim()) {
                return { ok: false, error: { field: 'snapshot.entries', reason: `entry "${entry.id}" scenario must be non-empty string` } };
            }
        }
        // 换脑：清空旧内容后整批入账
        this.entries.clear();
        this.vectors.clear();
        this.corticalizedIds.clear();
        this.semanticMemoryIds.clear();
        for (const e of s.entries) {
            const entry = e;
            this.entries.set(entry.id, entry);
            this.vectors.set(entry.id, embed(`${entry.scenario} ${entry.content}`));
        }
        for (const id of Array.isArray(s.corticalizedIds) ? s.corticalizedIds : []) {
            if (typeof id === 'string' && this.entries.has(id))
                this.corticalizedIds.add(id);
        }
        for (const id of Array.isArray(s.semanticMemoryIds) ? s.semanticMemoryIds : []) {
            if (typeof id === 'string' && this.entries.has(id))
                this.semanticMemoryIds.add(id);
        }
        this.idCounter = typeof s.idCounter === 'number' && Number.isFinite(s.idCounter)
            ? Math.max(0, Math.floor(s.idCounter)) : 0;
        return { ok: true, value: undefined };
    }
}
