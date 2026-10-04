// src/knowledge/knowledgeBase.ts
// D-7 隐知识行为引擎 —— 知识免疫系统（Knowledge Immune System）纪元。
// 四大核心动作（query / insert / learnFromOutcome / dispose）全部异常诚实：
// 一切方法永不 throw，非法输入域外拒绝（对齐 makeScore 哲学：clamp 会掩埋 bug）。
//
// 免疫四机制（与 D-4 QualityDoctor 的架构对仗：D-4 免疫代码缺陷，D-7 免疫经验腐烂）：
//   1. 遗忘曲线：检索时置信度按半衰期指数衰减 —— 老知识自然让位，被复证的知识保鲜
//   2. 免疫应答：复证强化（同结论渐近 1，不新建条目 —— 抗体滴度升高而非新造抗体）；
//      反证衰减（矛盾双留痕：旧条目减半下沉，新条目代表当前世界）
//   3. hybrid 检索：keyword 命中 + 语义向量（semanticHash 零依赖嵌入）双通道线性混合
//   4. 睡眠整合：情景条目聚类蒸馏为语义记忆（consolidate —— 海马体→皮层）
import type {
  ConsolidationReport, ExecutionOutcome, KnowledgeBase, KnowledgeCategory, KnowledgeEntry,
  KnowledgeError, KnowledgeInjection, KnowledgeQuery, KnowledgeResult, Result,
} from './contracts';
import { embed, cosine, type SparseVector } from '../semanticHash';
import { P } from './params';
// W6-2（doctor smell.over-engineering 清偿）：出册常数与纯函数面已分区提取至
// knowledgeBase.core.ts（行为零变化）；导入面不变 —— 再分发。
import {
  CATEGORIES, decay, cocktailRotate, learnTopicKey, CONTENT_MAX_CHARS, INJECTION_MAX_CHARS,
  SEMANTIC_WEIGHT, SEMANTIC_FLOOR, MAX_ENTRIES, HALF_LIFE_CAP_MS, CONFIDENCE_HALF_LIFE_MS, STABILITY_GROWTH, AUTO_LEARN_FAILURE_CONFIDENCE, MIN_CLUSTER_SIZE, CLUSTER_SIMILARITY, CONSENSUS_BONUS, CORTICALIZE_DECAY, SEMANTIC_DEDUP_COSINE,
} from './knowledgeBase.core';
import { tokenize } from '../uiMemory';
// ΝΩ-28 任务2（M5 决策接线）：强化步长 / 铸造置信消费 kernelRegistry 的
// memory.op.<category>.<op> 键（memoryOps.ts 铸键）。getOrDefault 缺省 = 各消费点
// 现行字面量 —— 未入册 / 未收敛 ⇒ 零漂移安全带；sleep 第④幕收敛后逐类可调。
import { kernelRegistry } from '../kernel/registry';
import { memoryOpKey } from './memoryOps';
export { trustOf, distillInjection, CONTENT_MAX_CHARS, INJECTION_MAX_CHARS } from './knowledgeBase.core';


/**
 * 内存隐知识库（免疫系统纪元）。
 * 零持久化 —— 落盘策略（JSONL / sqlite）是留白；dispose 即归零，绝不留泄漏。
 */
export class InMemoryKnowledgeBase implements KnowledgeBase {
  private entries = new Map<string, KnowledgeEntry>();
  /** 语义向量缓存（insert 铸造 / 驱逐同步清 —— 与条目同生命周期，绝不悬空） */
  private vectors = new Map<string, SparseVector>();
  /** 已皮层化的情景条目（已折叠进某条语义记忆 —— 重复 consolidate 不再参与聚类） */
  private corticalizedIds = new Set<string>();
  /** 语义记忆产物 ID（consolidate 铸造 —— 它们是皮层内容物，不是情景） */
  private semanticMemoryIds = new Set<string>();
  private idCounter = 0;
  /**
   * ΑΩ-R21-2：BM25 语料统计的增量缓存（df / 逐条目 tf / docLen / lenSum）。
   * 旧实现（Δ-1）每次 query 全库重新 tokenize（O(N) 分词/次，满库 1000 条时
   * 每次检索都重付全语料分词成本）；现在 insert / 驱逐 / 水合时同步增删，
   * query 零重算 —— 只做 O(查询词数 × 命中条目) 的查表算术。
   * tf 缓存**全词表**（不只查询词）—— df 由此对任意 token 成立，query 侧
   * 无需预知词表。口径与 Δ-1 逐次重算严格同构：df = 含该 token 的条目数，
   * tf = 条目内 token 真实词频，avgdl = lenSum/N（空库下不消费该值）。
   */
  private corpusStats = {
    lenSum: 0,
    df: new Map<string, number>(),
    docTf: new Map<string, Map<string, number>>(),
    docLen: new Map<string, number>(),
  };
  /**
   * ΑΩ-R21-3：主题→条目 ID 索引（learnFromOutcome 免疫应答的抗原定位器）。
   * 只收录 auto-learn 条目（免疫应答的扫描域），键 = learnTopicKey(scenario)。
   * insert / 驱逐 / 水合同步维护；发现任何不同步迹象（死 ID / 键漂移）时
   * 防御性全扫重建（见 topicCandidates）—— 绝不消费已知过期 的索引。
   */
  private topicIndex = new Map<string, Set<string>>();

  query(query: KnowledgeQuery): Result<KnowledgeResult, KnowledgeError> {
    if (!query || typeof query !== 'object') {
      return { ok: false, error: { field: 'query', reason: 'query must be an object' } };
    }
    if (typeof query.sceneDescription !== 'string' || typeof query.intentDescription !== 'string') {
      return { ok: false, error: { field: 'query', reason: 'sceneDescription and intentDescription are required strings' } };
    }
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
    const startedAt = Date.now();
    const text = `${query.sceneDescription} ${query.intentDescription}`;
    // J 纪元 query 侧去重口径（Map/Set 迭代天然去重）→ 逐条目查表
    const queryTokens = [...new Set(tokenize(text))];
    const queryVec = embed(text);
    // ΑΩ-R21-2：BM25 上下文从增量缓存一次成型（查询词为空 / 空库 ⇒ null ⇒
    // 词法通道 0 分，与 Δ-1 的 corpus null / N=0 守卫同语义）。缓存写入
    // （防御性重建）只发生在此处 —— 遍历开始后读路径不再有任何写动作。
    const corpus = this.bm25Context(queryTokens);
    const ranked = [...this.entries.values()]
      // 遗忘曲线执法点：过滤与排序均用有效置信度 —— 老知识自然让位
      .map(e => ({ entry: e, eff: decay(e.confidence, e.updatedAt, startedAt, e.halfLifeMs) }))
      .filter(({ entry, eff }) => eff >= minConfidence)
      .map(({ entry, eff }) => ({ entry, eff, score: this.hybridScore(entry, queryVec, corpus) }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score || b.eff - a.eff)
      .slice(0, maxResults);
    // ΑΩ-R21-4（读路径纯化）：上面整条遍历/评分/排序链是纯读 —— usageCount
    // 不再在遍历途中变异（旧写法虽在 slice 后提交，但与评分链同段，驱逐判据
    // 被检索频率污染的窗口糊在一起）。现在显式分两段：收集命中（ranked 即
    // 命中清单）→ 遍历彻底结束后**一次性 touch 提交**。对外行为不变：
    // 连续两次 query 后 usageCount 照常 +1（检索即使用的簿记语义保持）。
    for (const { entry } of ranked) entry.usageCount += 1;
    return {
      ok: true,
      value: { entries: ranked.map(r => r.entry), latencyMs: Date.now() - startedAt, strategy: 'hybrid' },
    };
  }

  /**
   * ΑΩ-R21-2：BM25 查询上下文（从增量语料缓存一次成型）。
   * 查询词为空 ⇒ null；空库 ⇒ null（两种情形词法通道都恒 0，与 Δ-1 口径
   * 同语义）。附带的 ensureCorpusFresh 是缓存失效的防御执法点：计数失配
   * （任何未经收口的增删路径）⇒ 整体重建 —— 宁可付一次 O(N) 重建，绝不
   * 消费一份与库内条目数对不上的统计（统计谎言比慢更糟）。
   */
  private bm25Context(tokens: ReadonlyArray<string>): {
    N: number;
    avgdl: number;
    df: Map<string, number>;
    docLen: Map<string, number>;
    docTf: Map<string, Map<string, number>>;
    tokens: ReadonlyArray<string>;
  } | null {
    if (tokens.length === 0) return null;
    this.ensureCorpusFresh();
    const N = this.entries.size;
    if (N === 0) return null;
    return {
      N,
      avgdl: Math.max(1, this.corpusStats.lenSum / Math.max(1, N)),
      df: this.corpusStats.df,
      docLen: this.corpusStats.docLen,
      docTf: this.corpusStats.docTf,
      tokens,
    };
  }

  /** ΑΩ-R21-2：缓存一致性守卫 —— 条目数与 tf 簿记数失配 ⇒ 整体重建（防御式） */
  private ensureCorpusFresh(): void {
    if (this.corpusStats.docTf.size === this.entries.size) return;
    this.rebuildCorpus();
  }

  /** ΑΩ-R21-2：全量重建语料统计（水合 / 防御失效时的诚实路径） */
  private rebuildCorpus(): void {
    this.corpusStats.lenSum = 0;
    this.corpusStats.df = new Map();
    this.corpusStats.docTf = new Map();
    this.corpusStats.docLen = new Map();
    for (const [id, e] of this.entries) {
      this.corpusAdd(id, `${e.scenario} ${e.content}`.toLowerCase());
    }
  }

  /** ΑΩ-R21-2：单条目统计入账（insert 铸造点 / 重建路径共用 —— 恰好 tokenize 一次） */
  private corpusAdd(id: string, text: string): void {
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.corpusStats.docTf.set(id, tf);
    this.corpusStats.docLen.set(id, tokens.length);
    this.corpusStats.lenSum += tokens.length;
    // df 按去重后的 token 计（含该 token 的文档数 —— 与 Δ-1 逐次重算口径一致）
    for (const t of tf.keys()) this.corpusStats.df.set(t, (this.corpusStats.df.get(t) ?? 0) + 1);
  }

  /** ΑΩ-R21-2：单条目统计销账（驱逐路径）。条目不在缓存 ⇒ 防御性整体重建 */
  private corpusRemove(id: string): void {
    const tf = this.corpusStats.docTf.get(id);
    if (!tf) {
      this.rebuildCorpus(); // 未收口的删除被当场发现 —— 重建，绝不留缺口
      return;
    }
    this.corpusStats.lenSum -= this.corpusStats.docLen.get(id) ?? 0;
    this.corpusStats.docLen.delete(id);
    this.corpusStats.docTf.delete(id);
    for (const t of tf.keys()) {
      const remaining = (this.corpusStats.df.get(t) ?? 1) - 1;
      if (remaining <= 0) this.corpusStats.df.delete(t);
      else this.corpusStats.df.set(t, remaining);
    }
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
   * Δ-1：语料统计由 query 入口一次算好下传，本方法退化为纯算术。
   * ΑΩ-R21-2：统计源从「query 入口 O(N) 单遍重算」换成「增量维护的缓存」
   * —— 求和项改按查询词序遍历（逐词查 docTf 表；项集与 Δ-1 的按文档词序
   * 遍历完全相同，仅浮点求和次序可能不同 —— 差异在 1e-15 量级，不影响
   * 任何排序语义）。本方法零写动作（ΑΩ-R21-4 读路径纯化的评分侧承诺）。
   */
  private hybridScore(
    entry: KnowledgeEntry,
    queryVec: SparseVector,
    corpus: ReturnType<InMemoryKnowledgeBase['bm25Context']> | null,
  ): number {
    let bm25 = 0;
    const docTf = corpus?.docTf.get(entry.id);
    if (corpus && docTf && corpus.N > 0) {
      const k1 = 1.2, b = 0.75;
      const docLen = corpus.docLen.get(entry.id) ?? 1;
      const norm = k1 * (1 - b + b * (docLen / corpus.avgdl));
      for (const t of corpus.tokens) { // 查询词已去重（J 纪元口径）
        const tf = docTf.get(t);
        if (tf === undefined) continue; // 该查询词不在本文档 —— 零贡献
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

  insert(entry: Omit<KnowledgeEntry, 'id' | 'updatedAt' | 'usageCount'>): Result<string, KnowledgeError> {
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
    // 容量守卫：驱逐「使用度 × 有效置信」最低的 auto-learn 条目（manual/import 是
    // 造物主主权，永不驱逐）。风险加固：全部条目皆不可驱逐（全 manual/import）时 ——
    // 诚实拒绝插入，绝不静默越限膨胀（容量上限是结构承诺，不是软建议）。
    // ΝΩ-28 任务4（驱逐分修正）：旧判据裸 usageCount —— 高频陈年错知识的使用度
    // 只增不减，永久占座赶走一切新证据。改 usageCount × decay(当前有效置信)：
    // 使用度只在记忆仍可信时计价，遗忘曲线把陈年条目的占座分自然折旧，
    // 新鲜证据（哪怕低使用）优先保座。
    if (this.entries.size >= MAX_ENTRIES) {
      const evictNow = Date.now();
      let victim: string | null = null;
      let victimScore = Number.POSITIVE_INFINITY;
      for (const [id, e] of this.entries) {
        if (e.source !== 'auto-learn') continue;
        const score = e.usageCount * decay(e.confidence, e.updatedAt, evictNow, e.halfLifeMs);
        if (score < victimScore) { victim = id; victimScore = score; }
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
      // ΑΩ-R21-2/3：派生索引先于条目本体销账（corpusRemove / topicRemove 都
      // 只依赖缓存自身状态，删除次序无耦合；ensureCorpusFresh 守卫兜底）
      const victimEntry = this.entries.get(victim);
      this.corpusRemove(victim);
      if (victimEntry) this.topicRemove(victimEntry);
      this.entries.delete(victim);
      this.vectors.delete(victim);
      this.corticalizedIds.delete(victim);
      this.semanticMemoryIds.delete(victim);
    }
    // ΑΩ-R21-5（ID 防撞）：id = kb-<Date.now().toString(36)>-<counter>，同毫秒
    // 撞号的三条通道全部封死 ——
    //   ① counter 在实例生命周期内严格单调递增（永不复用：同一毫秒内后铸的
    //      counter 恒大于先铸的，dispose 也不回卷 —— ID 序列是对外承诺，旧 id
    //      可能活在注入溯源 sources[].ref / 流水线报告里，回卷重铸 = 溯源谎言；
    //      dispose 归零的是记忆内容，不是身份命名空间）；
    //   ② 水合时扫描存量 ID 的 counter 最大值续号（见 restoreSnapshot）——
    //      旧脑的编号被新脑继承，跨会话不撞；
    //   ③ 铸造点终审守卫：万一外部注入的任意格式 ID 恰好占住铸造位，续号
    //      直到让出（entries.has 是唯一真相，O(1) 典型）。
    this.idCounter += 1;
    let id = `kb-${Date.now().toString(36)}-${this.idCounter}`;
    while (this.entries.has(id)) {
      this.idCounter += 1;
      id = `kb-${Date.now().toString(36)}-${this.idCounter}`;
    }
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
    // ΑΩ-R21-2：BM25 语料统计入账（缓存文本口径与 Δ-1 重算口径逐字一致：
    // `${scenario} ${content}`.toLowerCase() 后 tokenize —— content 已是截断后
    // 的入账本体，scenario 是入账原样）
    this.corpusAdd(id, `${String(entry.scenario ?? '')} ${content}`.toLowerCase());
    // ΑΩ-R21-3：主题索引入账（免疫应答只扫 auto-learn —— 其他来源不入索引）
    if (entry.source === 'auto-learn') this.topicAdd(id, String(entry.scenario ?? ''));
    return { ok: true, value: id };
  }

  learnFromOutcome(outcome: ExecutionOutcome): Result<void, KnowledgeError> {
    if (!outcome || !outcome.intent || !outcome.action || !outcome.result) {
      return { ok: false, error: { field: 'outcome', reason: 'malformed outcome (intent/action/result required)' } };
    }
    const failed = outcome.result.status === 'failure';
    const category: KnowledgeCategory = failed ? 'error-pattern' : 'workflow';
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
    // ΑΩ-R21-3：抗原定位从全库线性扫描换成主题索引（O(命中主题的条目数)）。
    // 语义零变化：候选集 = 全扫描会触达的同一批条目（auto-learn 且
    // learnTopicKey(scenario) === topic）；强化/反证的算术逐行保持原样。
    // learnFromOutcome 的强化路径只动 confidence/updatedAt/verifiedAt/
    // halfLifeMs —— 不动 content/scenario ⇒ 语料统计与主题索引皆无需更新
    // （ΑΩ-R21-2 缓存对 boost 天然免疫，这是内容不变式，不是遗漏）。
    for (const e of this.topicCandidates(topic)) {
      if (e.category === category) {
        // ΝΩ-28 任务2（M5 决策接线）：强化步长消费 kernelRegistry 键
        // memory.op.<category>.boost（缺省 = P.REINFORCE_STEP 现行字面量 —— 零漂移）。
        this.reinforceEntry(e, now);
        reinforced = true;
      } else {
        e.confidence = e.confidence * P.DISCONFIRM_DECAY; // 反证：下沉但绝不销毁证据
      }
    }
    if (reinforced) return { ok: true, value: undefined }; // 抗体已有：滴度升高即完成学习
    // J 纪元修正：degraded（效果未验证）的痕迹如实标注 —— 旧实现把
    // "completed with degraded verification" 学成 "succeeded"，语义有损。
    const degradedNote = !failed && outcome.result.status === 'degraded'
      ? ' [degraded — effect unverified]' : '';
    const content = failed
      ? `action ${outcome.action.kind} failed (${outcome.result.failure?.kind ?? 'unclassified'}): ${outcome.result.failure?.detail ?? outcome.result.status}`
      : `action ${outcome.action.kind} succeeded${degradedNote} for intent "${outcome.intent.description.slice(0, 80)}" (retries: ${outcome.retryCount})`;
    // ΝΩ-28 任务2（M5 决策接线）：失败铸造置信消费 kernelRegistry 键
    // memory.op.<category>.insert（缺省 = AUTO_LEARN_FAILURE_CONFIDENCE 现行字面量
    // —— 与 memoryOps.ts OP_THRESHOLDS.insert.defaultValue 同值，零漂移安全带）。
    const mintConfidence = failed
      ? kernelRegistry.getOrDefault(memoryOpKey(category, 'insert'), AUTO_LEARN_FAILURE_CONFIDENCE)
      : P.AUTO_LEARN_SUCCESS_CONFIDENCE;
    const r = this.insert({
      category,
      content,
      scenario: outcome.intent.description,
      confidence: mintConfidence,
      source: 'auto-learn',
      intentRef: outcome.intent.id,
      verifiedAt: now, // 生而亲证：亲历执行的直接观察（核证接地纪元）
    });
    return r.ok ? { ok: true, value: undefined } : { ok: false, error: r.error };
  }

  /**
   * 免疫应答强化原子（ΝΩ-28 提取 —— learnFromOutcome 复证路径与 consolidate
   * 语义去重锚共用同一滴度动力学）：confidence += (1−confidence)×步长（渐近 1，
   * 结构不越界；步长消费 memory.op.<category>.boost 内核键，缺省 = P.REINFORCE_STEP
   * 现行字面量）+ 复证即保鲜（updatedAt）+ 复证即亲证（verifiedAt）+ 间隔重复
   * （半衰期 ×1.6 封顶 365 天 —— 越被复证的记忆越抗遗忘）。
   * 只动 confidence/updatedAt/verifiedAt/halfLifeMs —— 不动 content/scenario
   * ⇒ 语料统计与主题索引皆无需更新（ΑΩ-R21-2 缓存对 boost 天然免疫）。
   */
  private reinforceEntry(e: KnowledgeEntry, now: number): void {
    const step = kernelRegistry.getOrDefault(memoryOpKey(e.category, 'boost'), P.REINFORCE_STEP);
    e.confidence = e.confidence + (1 - e.confidence) * step; // 渐近 1，结构不越界
    e.updatedAt = now; // 复证即保鲜（遗忘曲线重置）
    e.verifiedAt = now; // 复证即亲证（信任时钟重置）
    // E-1 间隔重复：复证不仅升滴度（confidence），也升稳定性（半衰期 ×1.6）——
    // 越被复证的记忆越抗遗忘；封顶 365 天（间隔效应不许把旧知识变成永恒）
    e.halfLifeMs = Math.min(
      HALF_LIFE_CAP_MS,
      Math.round((e.halfLifeMs ?? CONFIDENCE_HALF_LIFE_MS) * STABILITY_GROWTH),
    );
  }

  // ─── ΑΩ-R21-3：主题→条目索引（免疫应答的抗原定位器）───

  /** 索引入账（insert 铸造点 / 重建路径共用；只收 auto-learn —— 应答扫描域） */
  private topicAdd(id: string, scenario: string): void {
    const key = learnTopicKey(scenario);
    const set = this.topicIndex.get(key) ?? new Set<string>();
    set.add(id);
    this.topicIndex.set(key, set);
  }

  /** 索引销账（驱逐路径）：清空集合即顺手摘键 —— 键空间与条目同生命周期，不泄漏 */
  private topicRemove(entry: KnowledgeEntry): void {
    const key = learnTopicKey(entry.scenario);
    const set = this.topicIndex.get(key);
    if (!set) return;
    set.delete(entry.id);
    if (set.size === 0) this.topicIndex.delete(key);
  }

  /**
   * 免疫应答候选集（防御式索引消费）：
   *   索引命中 ⇒ 直接返回；任何不同步迹象（死 ID / 键漂移 —— 如快照后门改了
   *   scenario）⇒ 立即全扫重建索引后按重建结果应答 —— 回退的是**全扫描的
   *   诚实**，绝不是带着已知过期的索引继续跑。空主题键不存在 ⇒ 空候选
   *   （与全扫描「无同抗原条目」同语义）。
   */
  private topicCandidates(topic: string): KnowledgeEntry[] {
    const indexed = this.topicIndex.get(topic);
    if (!indexed) return [];
    const out: KnowledgeEntry[] = [];
    let stale = false;
    for (const id of indexed) {
      const e = this.entries.get(id);
      // 域复核（防御）：索引说的与库里的不一致 —— scenario 被外部改写 / 条目已被
      // 未收口路径删除。任何一例 ⇒ 放弃本轮索引视图
      if (!e || e.source !== 'auto-learn' || learnTopicKey(e.scenario) !== topic) {
        stale = true;
        break;
      }
      out.push(e);
    }
    if (!stale) return out;
    this.rebuildTopicIndex();
    const rebuilt = this.topicIndex.get(topic) ?? new Set<string>();
    const honest: KnowledgeEntry[] = [];
    for (const id of rebuilt) {
      const e = this.entries.get(id);
      if (e) honest.push(e);
    }
    return honest;
  }

  /** 全量重建主题索引（水合 / 防御失效时的诚实路径 —— 单遍 O(N)） */
  private rebuildTopicIndex(): void {
    this.topicIndex = new Map<string, Set<string>>();
    for (const [id, e] of this.entries) {
      if (e.source === 'auto-learn') this.topicAdd(id, e.scenario);
    }
  }

  dispose(): Result<void, Error> {
    this.entries.clear();
    this.vectors.clear();
    this.corticalizedIds.clear();
    this.semanticMemoryIds.clear();
    // ΑΩ-R21-2/3：派生缓存随本体归零（corpusStats 换新容器三表清空）
    this.corpusStats.lenSum = 0;
    this.corpusStats.df = new Map();
    this.corpusStats.docTf = new Map();
    this.corpusStats.docLen = new Map();
    this.topicIndex = new Map();
    // ΑΩ-R21-5：idCounter 不随 dispose 回卷 —— ID 序列是跨生命周期的对外
    // 承诺（旧 id 活在注入溯源 / 报告里，回卷重铸 = 同毫秒撞号 + 溯源谎言）。
    // dispose 归零的是记忆内容与派生缓存，不是身份命名空间（一个 number 的
    // 保留不构成泄漏 —— 它不引用任何条目）。
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
  consolidate(): Result<ConsolidationReport, KnowledgeError> {
    const startedAt = Date.now();
    // 情景收集：auto-learn 且未被皮层化且非语义记忆产物（幂等双守卫）
    const episodes = [...this.entries.values()].filter(e =>
      e.source === 'auto-learn' &&
      !this.corticalizedIds.has(e.id) &&
      !this.semanticMemoryIds.has(e.id));
    if (episodes.length < MIN_CLUSTER_SIZE) {
      return { ok: true, value: { episodes: episodes.length, clusters: 0, consolidated: 0, episodedDecayed: 0, durationMs: Date.now() - startedAt } };
    }
    // 贪心单链聚类：以未分簇条目为种子，吸收所有语义近邻。
    // ΑΩ-R21-1（桶化预筛）：旧实现对每个种子全量扫描未分簇条目两两 cosine
    // （O(N²) 对比、满库 1000 条情景时每次 run-end 的 consolidate 都重付）。
    // 现在先按语义向量的**维度桶**（32 位 FNV 桶号）建倒排索引，cosine 只在
    // 与种子共享 ≥1 维的候选内精算。**严格等价论证**（保守超集的反面 ——
    // 这是精确等价，不是近似）：
    //   embed 产出非负稀疏向量，cosine(a,b) = Σ_{i∈dims(a)∩dims(b)} aᵢbᵢ/(‖a‖‖b‖)；
    //   维度零相交 ⇒ 分子恒 0 ⇒ cosine = 0 < CLUSTER_SIMILARITY(0.45) ——
    //   被桶预筛排除的条目对在旧全扫下也必然落选，不可能漏簇。
    //   种子序（episodes 插入序）、成员判定（cosine ≥ 阈值）、unassigned 语义
    //   （收集期间不变异、整簇收集完再摘除）与旧算法逐点一致 ⇒ 簇划分恒同。
    // 性能形状：典型语料下无关条目哈希维几乎零相交（全域 32 位哈希，碰撞近零），
    // 候选集收敛到同话题近邻；最坏退化（全员共享一维，如同一高频词）回落到
    // 旧 O(N²) —— 上界不劣于旧实现，绝不更差。
    const dimBuckets = new Map<number, KnowledgeEntry[]>();
    for (const e of episodes) {
      const vec = this.vectors.get(e.id);
      if (!vec) continue; // 无向量条目不占桶（旧算法对它们恒 cosine 跳过）
      for (const [dim] of vec.dims) {
        const bucket = dimBuckets.get(dim);
        if (bucket) bucket.push(e);
        else dimBuckets.set(dim, [e]);
      }
    }
    const unassigned = new Set(episodes);
    const clusters: KnowledgeEntry[][] = [];
    for (const seed of episodes) {
      if (!unassigned.has(seed)) continue;
      const cluster: KnowledgeEntry[] = [seed];
      unassigned.delete(seed);
      const seedVec = this.vectors.get(seed.id);
      if (seedVec && seedVec.dims.length > 0) {
        // 候选去重章戳（同一条目与种子共享多维时只精算一次）
        const seen = new Set<KnowledgeEntry>();
        for (const [dim] of seedVec.dims) {
          const bucket = dimBuckets.get(dim);
          if (!bucket) continue;
          for (const other of bucket) {
            if (other === seed || seen.has(other) || !unassigned.has(other)) continue;
            seen.add(other);
            const otherVec = this.vectors.get(other.id);
            if (otherVec && cosine(seedVec, otherVec) >= CLUSTER_SIMILARITY) {
              cluster.push(other);
            }
          }
        }
        for (const member of cluster) unassigned.delete(member);
      }
      if (cluster.length >= MIN_CLUSTER_SIZE) clusters.push(cluster);
    }
    // 逐簇蒸馏：多数类别 + 共识置信度 + 跨场景主题（簇内最高置信条目的场景为代表）
    let consolidated = 0;
    let episodedDecayed = 0;
    for (const cluster of clusters) {
      const byCategory = new Map<KnowledgeCategory, number>();
      for (const e of cluster) byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + 1);
      let category: KnowledgeCategory = cluster[0].category;
      let bestCount = 0;
      for (const [cat, n] of byCategory) if (n > bestCount) { bestCount = n; category = cat; }
      const meanConfidence = cluster.reduce((s, e) => s + e.confidence, 0) / cluster.length;
      const consensus = Math.min(1, meanConfidence + CONSENSUS_BONUS * Math.sqrt(cluster.length));
      const representative = cluster.reduce((a, b) => (b.confidence > a.confidence ? b : a));
      // ΝΩ-28 任务5（语义去重锚）：蒸馏 insert 前查既有语义记忆 —— 同主题
      //（learnTopicKey 同抗原，与免疫应答同一匹配键）且语义向量 cosine ≥
      // SEMANTIC_DEDUP_COSINE(0.8) 的锚在场 ⇒ 该簇不是新知识，是新证据：
      // 走免疫应答强化路径（滴度升高 + 保鲜 + 亲证 + 稳定性增长），不新建条目
      // —— 同题两夜只沉淀一条语义记忆，皮层不增殖。
      // 向量基对齐律：既有语义记忆的存量向量 = 其铸造时的
      // embed(scenario + 蒸馏文本)（insert 铸造点）；锚比较必须用**本簇将铸造的
      // 蒸馏文本向量**（同一文本基 —— 与 insert 的 vectors.set 逐字一致）对照，
      // 而非情景原文向量：蒸馏壳与情景原文的余弦实测 ~0.74（永久失锚），
      // 蒸馏文本对蒸馏文本则同内容跨簇规模 0.975 / 异内容 0.758 —— 判别性成立。
      // 双重严判据（主题精确同 + 高余弦）：宁可漏合并（退回原蒸馏路径，无损），
      // 不可错合并两条异义语义记忆。
      const content = `consolidated pattern from ${cluster.length} episodes: ${representative.content.slice(0, 340)}`;
      const repTopic = learnTopicKey(representative.scenario);
      const candidateVec = embed(`${representative.scenario} ${content}`);
      let anchored = false;
      for (const sid of this.semanticMemoryIds) {
        const sem = this.entries.get(sid);
        if (!sem) continue; // 死 ID（防御）：跳过 —— semanticMemoryIds 与条目同生命周期
        if (learnTopicKey(sem.scenario) !== repTopic) continue;
        const semVec = this.vectors.get(sid);
        if (!semVec || cosine(candidateVec, semVec) < SEMANTIC_DEDUP_COSINE) continue;
        this.reinforceEntry(sem, Date.now());
        anchored = true;
        break;
      }
      if (anchored) {
        // 锚命中：簇成员照常皮层化（已被既有语义记忆吸收 —— 让位不销毁）；
        // consolidated 不增（无新铸 —— 报告口径 = 新语义记忆数，诚实不虚报）
        for (const e of cluster) {
          e.confidence = Math.round(e.confidence * CORTICALIZE_DECAY * 1000) / 1000;
          this.corticalizedIds.add(e.id);
          episodedDecayed += 1;
        }
        continue;
      }
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
  snapshot(): KnowledgeEntry[] {
    return [...this.entries.values()];
  }

  /**
   * 持久化快照（跨会话记忆的序列化面）：全条目 + 皮层化簿记 + ID 计数器。
   * 语义向量不序列化 —— embed 确定性，水合时重铸（杜绝格式漂移双真相）。
   */
  exportSnapshot(): {
    version: 1;
    entries: KnowledgeEntry[];
    corticalizedIds: string[];
    semanticMemoryIds: string[];
    idCounter: number;
  } {
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
  restoreSnapshot(snap: unknown): Result<void, KnowledgeError> {
    if (!snap || typeof snap !== 'object') {
      return { ok: false, error: { field: 'snapshot', reason: 'snapshot must be an object' } };
    }
    const s = snap as Record<string, unknown>;
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
    const idSet = new Set<string>();
    for (const e of s.entries) {
      const entry = e as Partial<KnowledgeEntry> | null;
      if (!entry || typeof entry !== 'object') {
        return { ok: false, error: { field: 'snapshot.entries', reason: 'entry must be an object' } };
      }
      if (typeof entry.id !== 'string' || entry.id.length === 0 || idSet.has(entry.id)) {
        return { ok: false, error: { field: 'snapshot.entries', reason: `entry id must be unique non-empty string, got ${JSON.stringify(entry.id)}` } };
      }
      idSet.add(entry.id);
      if (!CATEGORIES.includes(entry.category as KnowledgeCategory)) {
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
      const entry = e as KnowledgeEntry;
      this.entries.set(entry.id, entry);
      this.vectors.set(entry.id, embed(`${entry.scenario} ${entry.content}`));
    }
    for (const id of Array.isArray(s.corticalizedIds) ? s.corticalizedIds : []) {
      if (typeof id === 'string' && this.entries.has(id)) this.corticalizedIds.add(id);
    }
    for (const id of Array.isArray(s.semanticMemoryIds) ? s.semanticMemoryIds : []) {
      if (typeof id === 'string' && this.entries.has(id)) this.semanticMemoryIds.add(id);
    }
    // ΑΩ-R21-2/3：派生缓存随换脑整体重建（水合是缓存的全量失效点 ——
    // 旧脑的增量簿记对新脑毫无意义；重建 = 单遍 O(N)，与旧 query 逐次重算
    // 相比仍是零和以上的赢面）
    this.rebuildCorpus();
    this.rebuildTopicIndex();
    // ΑΩ-R21-5（水合推进 ID counter）：旧实现无条件信快照的 idCounter（缺席
    // 即归零）—— 同毫秒续铸同号 ⇒ Map 静默覆盖丢条。现在取三值最大：
    //   快照 idCounter（正常路径）/ 存量 ID 扫描出的 counter 峰值（防御：快照
    //   缺 idCounter 的旧档 / 手工拼接快照 / 编号领先于簿记的任何形态）/ 0。
    //   counter 全局单调 ⇒ 续铸编号恒大于存量 ⇒ 同毫秒同号在结构上不可能。
    //   （对非 kb-* 格式的外部 ID 不解析 —— 铸造点终审守卫兜底它们的撞位。）
    let maxMintedCounter = 0;
    for (const id of this.entries.keys()) {
      const m = /^kb-[0-9a-z]+-(\d+)$/.exec(id);
      if (!m) continue;
      const c = Number(m[1]);
      // 域执法（防御）：超出 int32 的巨号不是本铸造器可续的序列（parseInt 对
      // 超长数字串会产出非有限数）—— 忽略之，交由铸造点守卫防撞
      if (Number.isFinite(c) && c > maxMintedCounter && c <= 0x7fffffff) maxMintedCounter = c;
    }
    const snapCounter = typeof s.idCounter === 'number' && Number.isFinite(s.idCounter)
      ? Math.max(0, Math.floor(s.idCounter)) : 0;
    this.idCounter = Math.max(snapCounter, maxMintedCounter);
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
