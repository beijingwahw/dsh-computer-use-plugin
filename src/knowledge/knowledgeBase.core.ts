// src/knowledge/knowledgeBase.core.ts
// W6-2（doctor smell.over-engineering 清偿）：自 knowledgeBase.ts 低风险分区提取
// （>500 行拆分信号）—— 出册常数（分类学/预算/算法形状字面量）与纯函数面
// （遗忘曲线/信任度/注入蒸馏/鸡尾酒轮转/主题键）整体搬迁。零 IO 依赖，行为零变化；
// knowledgeBase.ts 以再导出保持导入面不变。
import type { KnowledgeCategory, KnowledgeEntry, KnowledgeInjection, KnowledgeResult } from './contracts';


/** 分类学全集（insert 铸造点的域执法依据） */
export const CATEGORIES: ReadonlyArray<KnowledgeCategory> = [
  'ui-pattern', 'shortcut', 'system-quirk',
  'business-rule', 'error-pattern', 'workflow', 'preference',
];

/** 知识内容预算（契约立法值 —— KnowledgeEntry.content ≤500 字符；D-7 工具面文案同源引用） */
export const CONTENT_MAX_CHARS = 500;
/** 注入摘要预算上限（契约立法值 —— KnowledgeInjection.summary ≤300 字符；
 *  configValidator 的 knowledgeMaxChars 域上界同源引用 —— 单一事实源） */
export const INJECTION_MAX_CHARS = 300;
/** 库容量上限（防无限膨胀：超限驱逐最低使用度的 auto-learn 条目 —— manual 永不驱逐） */
export const MAX_ENTRIES = 1000;

// ─── 算法形状字面量（出册常数 —— 校准无可行区间，值即设计，非调参旋钮）───

/** 语义通道权重：hybrid = keyword 命中 + 2×cosine。校准：包络内全域不敏感
 *  （keyword 通道主导）；通道保留为零样本泛化能力，权重是形状不是旋钮。 */
export const SEMANTIC_WEIGHT = 2;
/** 语义地板：cosine < 0.2 不计分 —— n-gram 噪声零容忍 */
export const SEMANTIC_FLOOR = 0.2;
/** 失败学习初始置信度。校准：全域不敏感 —— REINFORCE_STEP（登记参数）才是
 *  学习动力学承重者：即使初始 0，3 次复证也升到 0.51 过压制阈值。 */
export const AUTO_LEARN_FAILURE_CONFIDENCE = 0.3;
/** 成簇最小规模：两条重合是巧合，三条重合是模式（政策值，契约测试守护结构） */
export const MIN_CLUSTER_SIZE = 3;
/** 成簇 cosine 阈值（场景聚类的引力常数 —— 布局方言定义） */
export const CLUSTER_SIMILARITY = 0.45;
/** 共识加成系数（√n 形式：多源复证增益随规模衰减）。契约界定 (0, ~0.5)：
 *  0 无共识语义、过大顶格 1 失去信息；0.1 取下沿保守点。 */
export const CONSENSUS_BONUS = 0.1;
/** 皮层化衰减：情景让位语义，留痕不销毁（knowledge.test 钉住 0.4×0.5=0.2） */
export const CORTICALIZE_DECAY = 0.5;
/** 置信度半衰期基线（E-1 间隔重复：未复证条目的 30 天缺省）。数值是部署域假设
 *  （包络内时间不流逝，不可证伪）；衰减形状（过滤 + 排序让位）由
 *  knowledge.test 免疫 #1 时间旅行守护 —— 它只测未复证条目，基线形状零回归。 */
export const CONFIDENCE_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
/** E-1 稳定性增长系数：每次复证半衰期 ×1.6 —— Ebbinghaus 间隔效应的工程化
 *  （FSRS/SuperMemo 文献报告单次复习稳定性增益 ×1.2~×2.5，取下沿保守值）。
 *  算法形状字面量（值即设计，非旋钮）：「复习让记忆更牢」的机制形状，
 *  epochE.test 间隔重复用例守护「复证条目抗遗忘 ≫ 未复证条目」的序关系。 */
export const STABILITY_GROWTH = 1.6;
/** E-1 稳定性封顶（365 天）：一年不复证的记忆无论如何加固都让位 —— 世界会变，
 *  间隔效应不能把旧知识变成永恒（封顶是诚实性约束，不是性能参数）。 */
export const HALF_LIFE_CAP_MS = 365 * 24 * 60 * 60 * 1000;

/** 分词（J 纪元统一）：复用 `../uiMemory` 的 tokenize（拉丁词 + CJK 单字 + 二元组）。
 *  旧实现私有一份「CJK 连续串整体」的分词 —— 与决策工位（reflexArc/deliberate
 *  经 uiMemory.tokenize）不同构：同一个中文词在两通道被切成不同粒度，KB 的
 *  keyword 通道（长串 includes 精确匹配）在中文场景几乎必然哑火，只剩语义通道兜底。 */
import { tokenize } from '../uiMemory';

/** 遗忘曲线（纯函数）：c × 0.5^(age/半衰期)。age=0 ⇒ 原值；越老越冷。
 *  E-1 间隔重复：半衰期逐条目化 —— 条目自带 halfLifeMs（复证增长），
 *  缺席回退 30 天基线（旧档/未复证自然降级，零迁移成本）；封顶 365 天。 */
export function decay(confidence: number, updatedAt: number, now: number, halfLifeMs?: number): number {
  const age = Math.max(0, now - updatedAt);
  const hl = Math.min(
    typeof halfLifeMs === 'number' && Number.isFinite(halfLifeMs) && halfLifeMs > 0
      ? halfLifeMs : CONFIDENCE_HALF_LIFE_MS,
    HALF_LIFE_CAP_MS,
  );
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
export function cocktailRotate(entries: KnowledgeEntry[]): KnowledgeEntry[] {
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
export function learnTopicKey(scenario: string): string {
  return scenario.trim().toLowerCase();
}

