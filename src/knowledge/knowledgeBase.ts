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

/** 分类学全集（insert 铸造点的域执法依据） */
const CATEGORIES: ReadonlyArray<KnowledgeCategory> = [
  'ui-pattern', 'shortcut', 'system-quirk',
  'business-rule', 'error-pattern', 'workflow', 'preference',
];

/** 知识内容预算（契约立法值 —— KnowledgeEntry.content ≤500 字符；D-7 工具面文案同源引用） */
export const CONTENT_MAX_CHARS = 500;
/** 注入摘要预算上限（契约立法值 —— KnowledgeInjection.summary ≤300 字符） */
const INJECTION_MAX_CHARS = 300;
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
/** 置信度半衰期（30 天 —— UI 改版代谢周期的量级估计）。数值是部署域假设
 *  （包络内时间不流逝，不可证伪）；衰减形状（过滤 + 排序让位）由
 *  knowledge.test 免疫 #1 经 snapshot 时间旅行守护。 */
const CONFIDENCE_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/** 分词（检索通道共用：连续字母/数字/CJK 串；无停用词表 —— 留白） */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) ?? [];
}

/** 遗忘曲线（纯函数）：c × 0.5^(age/半衰期)。age=0 ⇒ 原值；越老越冷 */
function decay(confidence: number, updatedAt: number, now: number): number {
  const age = Math.max(0, now - updatedAt);
  return confidence * Math.pow(0.5, age / CONFIDENCE_HALF_LIFE_MS);
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
export function trustOf(confidence: number, verifiedAt: number | undefined, now: number): number {
  if (verifiedAt === undefined || !Number.isFinite(verifiedAt)) return 0;
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
export function distillInjection(result: KnowledgeResult, maxChars: number): KnowledgeInjection | null {
  if (!result || result.entries.length === 0) return null;
  const budget = Math.max(1, Math.min(maxChars, INJECTION_MAX_CHARS));
  const rotated = cocktailRotate(result.entries);
  const parts: string[] = [];
  const fragments: Array<{ category: KnowledgeCategory; content: string; confidence: number; verifiedAt?: number }> = [];
  let used = 0;
  for (const e of rotated) {
    const frag = `[${e.category}] ${e.content}`;
    if (parts.length > 0 && used + frag.length > budget) break;
    parts.push(frag);
    // fragments 与 summary 同源同序（单一真相）—— 前额叶仿真 + 信任评估的证据面
    fragments.push({ category: e.category, content: e.content, confidence: e.confidence, verifiedAt: e.verifiedAt });
    used += frag.length;
    if (used >= budget) break;
  }
  return {
    summary: parts.join('; ').slice(0, budget),
    categories: [...new Set(result.entries.map(e => e.category))],
    maxConfidence: Math.max(...result.entries.map(e => e.confidence)),
    sources: result.entries
      .filter(e => e.source !== 'import')
      .map(e => ({ type: e.source as 'manual' | 'auto-learn', ref: e.id })),
    fragments,
  };
}

/** 类别轮转（纯函数）：保序分组 → 按类别出现序轮流取一条；单类别输入 ⇒ 原序直通 */
function cocktailRotate(entries: KnowledgeEntry[]): KnowledgeEntry[] {
  const byCategory = new Map<KnowledgeCategory, KnowledgeEntry[]>();
  for (const e of entries) {
    const bucket = byCategory.get(e.category) ?? [];
    bucket.push(e);
    byCategory.set(e.category, bucket);
  }
  if (byCategory.size <= 1) return [...entries]; // 单类别：轮退化为原序
  const out: KnowledgeEntry[] = [];
  let emitted = true;
  while (emitted) {
    emitted = false;
    for (const bucket of byCategory.values()) {
      const next = bucket.shift();
      if (next) { out.push(next); emitted = true; }
    }
  }
  return out;
}

/** 学习蒸馏的主题键（免疫应答的抗原匹配键：同场景 = 同抗原） */
function learnTopicKey(scenario: string): string {
  return scenario.trim().toLowerCase();
}

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

  query(query: KnowledgeQuery): Result<KnowledgeResult, KnowledgeError> {
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
    const ranked = [...this.entries.values()]
      // 遗忘曲线执法点：过滤与排序均用有效置信度 —— 老知识自然让位
      .map(e => ({ entry: e, eff: decay(e.confidence, e.updatedAt, startedAt) }))
      .filter(({ entry, eff }) => eff >= minConfidence)
      .map(({ entry, eff }) => ({ entry, eff, score: this.hybridScore(entry, tokens, queryVec) }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score || b.eff - a.eff)
      .slice(0, maxResults);
    // 使用度簿记（检索即使用 —— usageCount 是后续置信度进化的燃料）
    for (const { entry } of ranked) entry.usageCount += 1;
    return {
      ok: true,
      value: { entries: ranked.map(r => r.entry), latencyMs: Date.now() - startedAt, strategy: 'hybrid' },
    };
  }

  /** hybrid 双通道评分（纯函数视角）：keyword 命中主导 + 语义 cosine 补零样本泛化 */
  private hybridScore(entry: KnowledgeEntry, tokens: string[], queryVec: SparseVector): number {
    let hits = 0;
    if (tokens.length > 0) {
      const haystack = `${entry.scenario} ${entry.content}`.toLowerCase();
      for (const t of tokens) if (haystack.includes(t)) hits += 1;
    }
    const vec = this.vectors.get(entry.id);
    const sim = vec ? cosine(queryVec, vec) : 0;
    return hits + (sim >= SEMANTIC_FLOOR ? SEMANTIC_WEIGHT * sim : 0);
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
    // 容量守卫：驱逐最低使用度的 auto-learn 条目（manual/import 是造物主主权，永不驱逐）。
    // 风险加固：全部条目皆不可驱逐（全 manual/import）时 —— 诚实拒绝插入，
    // 绝不静默越限膨胀（容量上限是结构承诺，不是软建议）。
    if (this.entries.size >= MAX_ENTRIES) {
      let victim: string | null = null;
      let victimUsage = Number.POSITIVE_INFINITY;
      for (const [id, e] of this.entries) {
        if (e.source === 'auto-learn' && e.usageCount < victimUsage) { victim = id; victimUsage = e.usageCount; }
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
    for (const e of this.entries.values()) {
      if (e.source !== 'auto-learn' || learnTopicKey(e.scenario) !== topic) continue;
      if (e.category === category) {
        e.confidence = e.confidence + (1 - e.confidence) * P.REINFORCE_STEP; // 渐近 1，结构不越界
        e.updatedAt = now; // 复证即保鲜（遗忘曲线重置）
        e.verifiedAt = now; // 复证即亲证（信任时钟重置）
        reinforced = true;
      } else {
        e.confidence = e.confidence * P.DISCONFIRM_DECAY; // 反证：下沉但绝不销毁证据
      }
    }
    if (reinforced) return { ok: true, value: undefined }; // 抗体已有：滴度升高即完成学习
    const content = failed
      ? `action ${outcome.action.kind} failed (${outcome.result.failure?.kind ?? 'unclassified'}): ${outcome.result.failure?.detail ?? outcome.result.status}`
      : `action ${outcome.action.kind} succeeded for intent "${outcome.intent.description.slice(0, 80)}" (retries: ${outcome.retryCount})`;
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

  dispose(): Result<void, Error> {
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
    // 贪心单链聚类：以未分簇条目为种子，吸收所有语义近邻
    const unassigned = new Set(episodes);
    const clusters: KnowledgeEntry[][] = [];
    for (const seed of episodes) {
      if (!unassigned.has(seed)) continue;
      const cluster: KnowledgeEntry[] = [seed];
      unassigned.delete(seed);
      const seedVec = this.vectors.get(seed.id);
      if (seedVec) {
        for (const other of unassigned) {
          const otherVec = this.vectors.get(other.id);
          if (otherVec && cosine(seedVec, otherVec) >= CLUSTER_SIMILARITY) {
            cluster.push(other);
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
    this.idCounter = typeof s.idCounter === 'number' && Number.isFinite(s.idCounter)
      ? Math.max(0, Math.floor(s.idCounter)) : 0;
    return { ok: true, value: undefined };
  }
}
