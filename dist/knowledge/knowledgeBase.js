import { embed, cosine } from '../semanticHash.js';
import { P } from './params.js';
// W6-2（doctor smell.over-engineering 清偿）：出册常数与纯函数面已分区提取至
// knowledgeBase.core.ts（行为零变化）；导入面不变 —— 再分发。
import { CATEGORIES, decay, learnTopicKey, CONTENT_MAX_CHARS, SEMANTIC_WEIGHT, SEMANTIC_FLOOR, MAX_ENTRIES, HALF_LIFE_CAP_MS, CONFIDENCE_HALF_LIFE_MS, STABILITY_GROWTH, AUTO_LEARN_FAILURE_CONFIDENCE, MIN_CLUSTER_SIZE, CLUSTER_SIMILARITY, CONSENSUS_BONUS, CORTICALIZE_DECAY, } from './knowledgeBase.core.js';
import { tokenize } from '../uiMemory.js';
export { trustOf, distillInjection, CONTENT_MAX_CHARS, INJECTION_MAX_CHARS } from './knowledgeBase.core.js';
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
        // Δ-1：BM25 语料统计在 query 入口一次成型（O(N) 单遍），逐条目下传 ——
        // 旧实现把统计埋进 hybridScore 逐条目重算，见 bm25Corpus 注记
        const corpus = tokens.length > 0 ? this.bm25Corpus(tokens) : null;
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
            .map(({ entry, eff }) => ({ entry, eff, score: this.hybridScore(entry, queryVec, corpus) }))
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
     * Δ-1 BM25 语料统计（query 入口一次成型的 O(N) 单遍）：每条目恰好 tokenize
     * 一次，同时产出文档长度表、查询词 tf 表（逐条目）与 df 表、avgdl。
     * 旧实现把统计埋进 hybridScore 逐条目重算 —— 求avgdl 每条目重 tokenize
     * 全语料、求 df 每查询词全库子串扫描，O(N²)；满库（1000 条）时单次检索
     * 付出百万次分词。df 口径同步收敛为 token 精确匹配：旧实现用子串 includes
     * （含 'clickable' 的条目被计入 'click' 的 df —— 与 tf 的 token 域不同构，
     * 稀有词 IDF 被无关条目稀释）。
     */
    bm25Corpus(tokens) {
        const df = new Map();
        const docLen = new Map();
        const tf = new Map();
        const querySet = new Set(tokens);
        let lenSum = 0;
        for (const e of this.entries.values()) {
            const docTokens = tokenize(`${e.scenario} ${e.content}`.toLowerCase());
            docLen.set(e.id, docTokens.length);
            lenSum += docTokens.length;
            const entryTf = new Map();
            for (const t of docTokens) {
                if (querySet.has(t))
                    entryTf.set(t, (entryTf.get(t) ?? 0) + 1);
            }
            if (entryTf.size > 0) {
                tf.set(e.id, entryTf);
                for (const t of entryTf.keys())
                    df.set(t, (df.get(t) ?? 0) + 1);
            }
        }
        const N = this.entries.size;
        return { N, avgdl: Math.max(1, lenSum / Math.max(1, N)), df, docLen, tf };
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
     * Δ-1：语料统计（df/avgdl/tf/docLen）由 bm25Corpus 在 query 入口一次算好
     * 下传 —— 本方法退化为纯算术，不再触碰语料（O(N²) → O(N)）。
     */
    hybridScore(entry, queryVec, corpus) {
        let bm25 = 0;
        const entryTf = corpus?.tf.get(entry.id);
        if (corpus && entryTf && corpus.N > 0) {
            const k1 = 1.2, b = 0.75;
            const docLen = corpus.docLen.get(entry.id) ?? 1;
            const norm = k1 * (1 - b + b * (docLen / corpus.avgdl));
            for (const [t, tf] of entryTf) { // Map 迭代天然去重（J 纪元 query 侧口径）
                const dcount = corpus.df.get(t) ?? 0;
                const idf = Math.log((corpus.N - dcount + 0.5) / (dcount + 0.5) + 1);
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
            content: content.slice(0, CONTENT_MAX_CHARS), // ≤500 铸造点截断 —— 结构保证
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
// ─── W9-3（D-D9 单例供给）：睡眠免疫幕的生产消费单例 ───
//
// 债项背景（DEBTS D-D9）：纪元 Υ 睡眠第③幕（免疫幕 —— consolidate 海马体→
// 皮层整合）此前在生产无单例可注入（唯一实例铸造在 D-7 知识插件 apply 内部，
// 主插件组合根不可及）⇒ 晨报恒标 skipped。本行把供给面就位：模块级单例随
// 加载铸造（构造零副作用、零 IO），组合根（src/index.ts）经 SleepDeps.
// knowledgeBase 投喂 —— 供给后免疫幕从 skipped 转 runnable（真实 consolidate、
// 真实计数，绝不伪造）。缺省行为零漂移：enableSleepCycle 缺省 false ⇒ 单例
// 无人消费，与供给前逐字节等价；卸载路径由组合根 dispose（W-1 单例隔离律）。
// D-7 插件 apply 内的自建实例不受影响（独立 apply 面、独立生命周期 —— 共享
// 与否是后续窗口的接线决策，本轮零碰）。
export const knowledgeBase = new InMemoryKnowledgeBase();
