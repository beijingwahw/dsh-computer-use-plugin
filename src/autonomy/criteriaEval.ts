// src/autonomy/criteriaEval.ts
// W8-B4（判据证伪能力）：终局判据的独立评估器官 —— 判据核对的唯一权威方言。
// W9-1（D-G9 收口 · 判据证伪·极性分工红线）：runtime.checkCriteria 主路径已整体
// 换用本器官（evaluateCriteria）—— 旧的折叠子串匹配方言在 runtime 侧退役，
// 肯定面 fuzzy 容错 / 否定面证伪 / 判据解析 / 语料缺席降级四语义单一器官供给，
// 绝不两套方言并存。器官自身语义自 W8-B4 落地以来零改动（本行为收口纯接线）。
// W8-B4 立法史：既有判据匹配主路径（runtime 铸造的 execute 内折叠子串匹配）
// 只证真不证伪：判据 = 「屏幕必须出现某文本」⇒ OCR 命中即 met，永不产生
// violated。本器官在同一
// 判据 DSL（goalState.GoalSpec.successCriteria 的字符串数组）之上长出三块能力：
//   ① 否定判据：'mustNotAppear:'（或中文 '不得出现：'）前缀形态 —— 屏幕不得再出现 X；
//     OCR 命中否定词 ⇒ 判据 violated（goalState 判定律第 1 条：任一 violated ⇒ failed）；
//   ② fuzzy 容错全接入：判据匹配主路径补上 src/fuzzy.ts 的近似子串比较（容差沿用
//     fuzzy.ts 既有立法 ⌈m/6⌉ —— OCR 每六字符容一错；短模式 < 3 字符只走精确匹配，
//     与 tools/actionGate.ts 的 wholeHit 同律，杜绝单字符模式对空串的模糊误命中）；
//   ③ 诚实语义（三态判决纪律，与 actionVerifier 同律）：OCR 语料缺席/不可读 ⇒
//     一切判据零证据 —— 否定判据绝不因「看不见」而自动为真（宁缺毋错），
//     degraded 如实申报，交由上层保守处理。
// 纯函数、零依赖（仅 fuzzy）、确定性、绝不抛异常。
import { fuzzyIncludes } from '../fuzzy';

// ─── DSL：否定判据前缀（以现有判据结构为准，不臆造新结构字段） ───

/**
 * 否定前缀的折叠形态识别表（parseCriterion 消费）：
 *   · 'mustnotappear:'（原文 mustNotAppear: —— 大小写/空白折叠后识别）；
 *   · 'must not appear:'（带空格的自然写法 —— 折叠后单空格形态）；
 *   · '不得出现：' / '不得出现:'（中文形态，兼容全/半角冒号）。
 * 冒号是 DSL 边界：'屏幕不得出现错误提示'（无冒号紧跟）仍是普通字面判据，
 * 只有「前缀 + 冒号 + 禁词」的形态才升格为否定判据（防自然语句误伤）。
 */
const NEGATIVE_PREFIXES: readonly string[] = [
  'mustnotappear:',
  'mustnotappear：',
  'must not appear:',
  'must not appear：',
  '不得出现：',
  '不得出现:',
];

/** 大小写 + 空白折叠（与 runtime 判据子串匹配的 foldText 同一前置律 —— 一处方言） */
function foldText(s: unknown): string {
  return typeof s === 'string' ? s.toLowerCase().replace(/\s+/g, ' ').trim() : '';
}

/** 单条判据的解析产物（polarity = 极性；needle = 去前缀后的折叠禁词/期望词） */
export interface ParsedCriterion {
  /** 'must-appear'（默认：屏幕须出现）/ 'must-not-appear'（否定：屏幕不得再出现） */
  polarity: 'must-appear' | 'must-not-appear';
  /** 折叠后的比对词（前缀已剥；空串 = 非法判据，评估时整条跳过） */
  needle: string;
}

/**
 * 解析单条判据的极性与比对词（纯函数、绝不抛）。
 * 非字符串 / 空白串 ⇒ { polarity: 'must-appear', needle: '' }（按非法处理，
 * 与 runtime.checkCriteria 对非法判据的过滤律一致 —— 不得平移后续判据下标）。
 */
export function parseCriterion(raw: unknown): ParsedCriterion {
  const folded = foldText(raw);
  if (folded === '') return { polarity: 'must-appear', needle: '' };
  for (const prefix of NEGATIVE_PREFIXES) {
    if (folded.startsWith(prefix)) {
      // 前缀后可能是半角冒号已随前缀消费；剩余部分再折叠一次（前缀剥除可能
      // 留下首部空白），空 remainder ⇒ 非法否定判据（needle 空 ⇒ 跳过）
      const rest = foldText(folded.slice(prefix.length));
      return { polarity: 'must-not-appear', needle: rest };
    }
  }
  return { polarity: 'must-appear', needle: folded };
}

// ─── 评估：OCR 语料 × 判据账 ⇒ 三态证据 ───

/** 单条证据（index 锚定 spec.successCriteria 原位 —— goal.recordCriterion 同律） */
export interface CriterionEvidenceEntry {
  index: number;
  status: 'met' | 'violated';
  /** 极性随行（消费方可按极性过滤 —— autoPilot ⑧′ 只消费否定面） */
  polarity: 'must-appear' | 'must-not-appear';
}

/** 一次评估的产出：证据 + 诚实降级标记 */
export interface CriteriaEvaluation {
  /** 逐条证据（非法判据 / 语料缺席 / 未命中 ⇒ 不产出 —— 宁缺毋错） */
  evidence: CriterionEvidenceEntry[];
  /** true = OCR 语料缺席/不可读（本次评估整体降级 —— 否定判据不自动为真） */
  degraded: boolean;
  /** 证据链注记（审计/测试观察面） */
  notes: string[];
}

/** fuzzy 短模式护栏（与 tools/actionGate.ts 的 wholeHit 同律：< 3 字符只走精确匹配） */
const FUZZY_MIN_PATTERN_LEN = 3;

/**
 * 折叠语料上的命中判决（exact 优先、fuzzy 兜底 —— 容错阈值沿用 fuzzy.ts 立法）。
 * 短模式（< 3 字符）只走精确匹配：单字符模式在 ⌈1/6⌉=1 容差下对空串也命中，
 * 会把否定判据变成「必 violated」的伪证（actionGate 已立此律，此处同律收口）。
 */
function textHits(needle: string, foldedCorpus: string, tolerance?: number): boolean {
  if (foldedCorpus.includes(needle)) return true;
  if (needle.length < FUZZY_MIN_PATTERN_LEN) return false;
  try {
    return fuzzyIncludes(needle, foldedCorpus, tolerance);
  } catch {
    return false; // fuzzy 理论上不抛 —— 双保险，绝不因旁路器官炸评估
  }
}

/**
 * 判据账评估（纯函数、绝不抛）。
 *
 * @param criteria  判据对（text + 原始下标 —— 下标锚定 spec.successCriteria 原位）
 * @param ocrText   OCR 全文语料（null/undefined/非字符串/折叠后为空 ⇒ 诚实降级：
 *                  零证据 + degraded=true —— 肯定判据不证真，否定判据更不证真）
 * @param opts.tolerance  fuzzy 容错阈值覆写（缺省 = fuzzy.ts 立法 ⌈m/6⌉；负数按缺省）
 *
 * 判决律（逐条独立）：
 *   · 肯定判据：命中（精确 ∪ fuzzy）⇒ met；未命中 ⇒ 零证据（不产 violated ——
 *     「没找到」不是「被证伪」，与 runtime「宁缺毋错」同律）；
 *   · 否定判据：命中（精确 ∪ fuzzy）⇒ violated（证伪面本体）；语料在场且未命中
 *     ⇒ met（本次观察支持「屏幕确无禁词」—— 否定判据可由此凑齐全 met 终局）；
 *   · 非法判据（非字符串/空白/空 needle）⇒ 整条跳过（不产出、不下结论）。
 */
export function evaluateCriteria(
  criteria: Array<{ text: unknown; index: number }>,
  ocrText: string | null | undefined,
  opts?: { tolerance?: number },
): CriteriaEvaluation {
  const pairs = Array.isArray(criteria) ? criteria : [];
  const foldedCorpus = foldText(ocrText);
  if (foldedCorpus === '') {
    return {
      evidence: [],
      degraded: true,
      notes: ['OCR 语料缺席/不可读 —— 判据不证真也不证伪（诚实降级，否定判据不自动为真）'],
    };
  }
  const tolerance =
    typeof opts?.tolerance === 'number' && Number.isFinite(opts.tolerance) && opts.tolerance >= 0
      ? opts.tolerance
      : undefined;
  const evidence: CriterionEvidenceEntry[] = [];
  const notes: string[] = [];
  for (const pair of pairs) {
    if (pair === null || typeof pair !== 'object') continue;
    if (typeof pair.index !== 'number' || !Number.isInteger(pair.index) || pair.index < 0) continue;
    const parsed = parseCriterion(pair.text);
    if (parsed.needle === '') {
      notes.push(`第 ${pair.index + 1} 条判据非法（非字符串/空白/空禁词），整条跳过`);
      continue;
    }
    const hit = textHits(parsed.needle, foldedCorpus, tolerance);
    if (parsed.polarity === 'must-not-appear') {
      evidence.push({ index: pair.index, status: hit ? 'violated' : 'met', polarity: 'must-not-appear' });
      notes.push(
        hit
          ? `否定判据「${parsed.needle.slice(0, 24)}」命中禁词 ⇒ violated（证伪）`
          : `否定判据「${parsed.needle.slice(0, 24)}」语料在场且未命中 ⇒ met`,
      );
    } else if (hit) {
      evidence.push({ index: pair.index, status: 'met', polarity: 'must-appear' });
      notes.push(`肯定判据「${parsed.needle.slice(0, 24)}」命中（精确∪fuzzy）⇒ met`);
    }
    // 肯定判据未命中 ⇒ 零证据（不证伪 —— 与 runtime 主路径同律）
  }
  return { evidence, degraded: false, notes };
}

/**
 * 从 spec.successCriteria 铸判据对（原始下标锚定，非法条目剔除但**不平移**下标 ——
 * 与 runtime.createExecute 的判据对铸造同律）。非数组 ⇒ 空账。
 */
export function buildCriteriaPairs(
  successCriteria: unknown,
): Array<{ text: string; index: number }> {
  if (!Array.isArray(successCriteria)) return [];
  const out: Array<{ text: string; index: number }> = [];
  successCriteria.forEach((c, index) => {
    if (typeof c === 'string' && c.trim() !== '') out.push({ text: c, index });
  });
  return out;
}
