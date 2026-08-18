/** 分类学全集（insert 铸造点的域执法依据） */
const CATEGORIES = [
    'ui-pattern', 'shortcut', 'system-quirk',
    'business-rule', 'error-pattern', 'workflow', 'preference',
];
/** 知识内容预算（契约立法值 —— KnowledgeEntry.content ≤500 字符） */
const CONTENT_MAX_CHARS = 500;
/** 注入摘要预算上限（契约立法值 —— KnowledgeInjection.summary ≤300 字符） */
const INJECTION_MAX_CHARS = 300;
/** 自动学习初始置信度（Laplace 保守先验：无复证的成功/失败不做强断言） */
const AUTO_LEARN_FAILURE_CONFIDENCE = 0.3;
const AUTO_LEARN_SUCCESS_CONFIDENCE = 0.6;
/** 库容量上限（防无限膨胀：超限驱逐最低使用度的 auto-learn 条目 —— manual 永不驱逐） */
const MAX_ENTRIES = 1000;
/** 分词（keyword 策略的最小形态：连续字母/数字/CJK 串；无停用词表 —— 留白） */
function tokenize(text) {
    return text.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) ?? [];
}
/** 条目与查询的相关性评分（命中词数；同分按置信度定序） */
function matchScore(entry, tokens) {
    if (tokens.length === 0)
        return 0;
    const haystack = `${entry.scenario} ${entry.content}`.toLowerCase();
    let hits = 0;
    for (const t of tokens)
        if (haystack.includes(t))
            hits += 1;
    return hits;
}
/**
 * 蒸馏器：KnowledgeResult → KnowledgeInjection（V2 防卡顿蒸馏版）。
 * 摘要硬预算 maxChars（≤300）在此铸造点执法 —— 结构保证，不靠下游自觉。
 * 'import' 来源不进 sources（注入溯源只认 manual / auto-learn —— import 是只读档案）。
 */
export function distillInjection(result, maxChars) {
    if (!result || result.entries.length === 0)
        return null;
    const budget = Math.max(1, Math.min(maxChars, INJECTION_MAX_CHARS));
    const parts = [];
    let used = 0;
    for (const e of result.entries) {
        const frag = `[${e.category}] ${e.content}`;
        if (parts.length > 0 && used + frag.length > budget)
            break;
        parts.push(frag);
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
    };
}
/**
 * 内存隐知识库（桩纪元）。
 * 零持久化 —— 落盘策略（JSONL / sqlite）是留白；dispose 即归零，绝不留泄漏。
 */
export class InMemoryKnowledgeBase {
    entries = new Map();
    idCounter = 0;
    query(query) {
        if (!query || typeof query !== 'object') {
            return { ok: false, error: { field: 'query', reason: 'query must be an object' } };
        }
        if (typeof query.sceneDescription !== 'string' || typeof query.intentDescription !== 'string') {
            return { ok: false, error: { field: 'query', reason: 'sceneDescription and intentDescription are required strings' } };
        }
        const startedAt = Date.now();
        const tokens = tokenize(`${query.sceneDescription} ${query.intentDescription}`);
        const minConfidence = query.minConfidence ?? 0;
        const maxResults = query.maxResults ?? 5;
        const ranked = [...this.entries.values()]
            .filter(e => e.confidence >= minConfidence)
            .map(e => ({ entry: e, score: matchScore(e, tokens) }))
            .filter(s => s.score > 0)
            .sort((a, b) => b.score - a.score || b.entry.confidence - a.entry.confidence)
            .slice(0, maxResults);
        // 使用度簿记（检索即使用 —— usageCount 是后续置信度进化的燃料）
        for (const { entry } of ranked)
            entry.usageCount += 1;
        return {
            ok: true,
            value: { entries: ranked.map(r => r.entry), latencyMs: Date.now() - startedAt, strategy: 'keyword' },
        };
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
        });
        return { ok: true, value: id };
    }
    learnFromOutcome(outcome) {
        if (!outcome || !outcome.intent || !outcome.action || !outcome.result) {
            return { ok: false, error: { field: 'outcome', reason: 'malformed outcome (intent/action/result required)' } };
        }
        const failed = outcome.result.status === 'failure';
        // 最小蒸馏策略（留白：真进化策略由后续纪元注入，桩只做结构性闭环）
        const content = failed
            ? `action ${outcome.action.kind} failed (${outcome.result.failure?.kind ?? 'unclassified'}): ${outcome.result.failure?.detail ?? outcome.result.status}`
            : `action ${outcome.action.kind} succeeded for intent "${outcome.intent.description.slice(0, 80)}" (retries: ${outcome.retryCount})`;
        const r = this.insert({
            category: failed ? 'error-pattern' : 'workflow',
            content,
            scenario: outcome.intent.description,
            confidence: failed ? AUTO_LEARN_FAILURE_CONFIDENCE : AUTO_LEARN_SUCCESS_CONFIDENCE,
            source: 'auto-learn',
            intentRef: outcome.intent.id,
        });
        return r.ok ? { ok: true, value: undefined } : { ok: false, error: r.error };
    }
    dispose() {
        this.entries.clear();
        this.idCounter = 0;
        return { ok: true, value: undefined };
    }
    /** 库存快照（工具面/测试用；只读投影，绝不外泄内部 Map） */
    snapshot() {
        return [...this.entries.values()];
    }
}
