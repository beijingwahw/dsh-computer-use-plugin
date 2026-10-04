// src/autonomy/policyEngineUtil.ts
// W6-1（doctor 债清偿·smell.over-engineering）：从 policyEngine.ts 提取的纯函数
// 工具区与常量 —— 分词/缓存/词法风险预分类/候选构建/并列破平/僵局探测/提示词
// 铸造。逐字节搬运（零逻辑/零数值变更）；policyEngine.ts 保留契约类型与决策中枢
// 类，导入面不变（extractGoalKeywords 原位再导出）。
import type { SnapshotElement, WorldSnapshot } from './worldSnapshot';
import type { CriterionStatus, GoalProgress, GoalSpec } from './goalState';
import { kernelRegistry } from '../kernel/registry';
import { scoreOptions, actionSignature } from './counterfactual';
import type { AutonomyActionKind, PolicyAction, StepOutcome } from './policyEngine';

// ─── 常量 ───

/** 元素匹配置信门槛：最佳候选得分低于此值 ⇒ uncertain（请云脑或如实标注） */
export const MATCH_CONFIDENT = 0.55;
/** 候选并列判定：最佳与次佳得分差小于此值 ⇒ uncertain */
export const TIE_GAP = 0.05;
/** 云脑咨询的候选上限（提示词带宽礼仪） */
export const VLM_CANDIDATE_CAP = 8;
/** 预算红线：剩余步数 ≤2 或剩余毫秒 ≤15000 ⇒ 升级 */
export const BUDGET_STEPS_LOW = 2;
export const BUDGET_MS_LOW = 15_000;
/** 弹窗确认类元素判据（中文子串 + 英文整词，大小写/空白已折叠）。
 *  纪元 Δ 扫描面修正：补「确定/是/同意/yes」——只认 确认/ok/allow 时，四类
 *  高频确认按钮会反落 Esc 分支（Esc 对模态确认框常等于「取消」，语义相反）。 */
export const POPUP_CONFIRM_RE = /确认|确定|同意|允许|继续|是|\bok\b|\ballow\b|\byes\b/;
/** 中日韩统一表意字符（含扩展 A / 兼容区）—— 2-gram 切分对象 */
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
/** 双语停用词 —— 目标/判据分词后的功能词滤除（判定性弱、误匹配率高） */
const STOPWORDS = new Set([
  '的', '了', '和', '与', '及', '或', '在', '是', '对', '从', '被', '把', '这', '那',
  '也', '又', '就', '都', '而', '则', '请', '不', '无', '于', '以', '为', '有', '个',
  '中', '并', '其', '之', '该', '当', '至', '给', '它', '你', '我',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by',
  'is', 'are', 'be', 'been', 'was', 'were', 'this', 'that', 'these', 'those',
  'it', 'its', 'as', 'from', 'into', 'if', 'then', 'when', 'than', 'so', 'not',
  'no', 'yes', 'all', 'any', 'must', 'should', 'will', 'can',
]);
/** 破坏性词表（点击目标的词法预分类；英文按整词、中文按子串） */
const DESTRUCTIVE_ZH = ['删除', '卸载', '清空', '格式化', '重置', '抹掉'];
const DESTRUCTIVE_EN = ['delete', 'remove', 'uninstall', 'format', 'erase', 'destroy'];
/** 敏感词表（提交/外发/安装类动作；非破坏但需风险闸门留意） */
const SENSITIVE_ZH = ['发送', '提交', '支付', '购买', '下载', '上传', '安装', '保存'];
const SENSITIVE_EN = ['send', 'submit', 'pay', 'purchase', 'buy', 'download', 'upload', 'install', 'save'];

// ─── 纯函数工具（零副作用、零异常） ───

/** 空白折叠 + 小写化 —— 一切文本匹配的前置归一 */
export function normalizeWs(s: unknown): string {
  return typeof s === 'string' ? s.toLowerCase().replace(/\s+/g, ' ').trim() : '';
}

/** 数值夹 [0,1]；非有限数按中性 0.5 记（与 grounding 的置信兜底同律） */
export function clamp01(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0.5;
  return Math.min(1, Math.max(0, n));
}

/** 保留两位小数的得分（供 payload/rationale 展示，避免浮点尾噪） */
export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * 轻量分词（本模块自带，不依赖 fuzzy.ts）：
 * 中文连续段按字符 2-gram（单字段保留单字）；英文/数字段按非字母数字切开取词；
 * 滤除停用词、纯数字与单个英文字母。输出按原文字符顺序（确定性）。
 */
function tokenizeText(text: unknown): string[] {
  const norm = normalizeWs(text);
  if (!norm) return [];
  const tokens: string[] = [];
  const push = (t: string): void => {
    if (t.length === 0) return;
    if (/^\d+$/.test(t)) return;                    // 纯数字：坐标/序号噪声
    if (STOPWORDS.has(t)) return;                   // 停用词
    if (!CJK_RE.test(t) && t.length < 2) return;    // 单个英文字母噪声
    tokens.push(t);
  };
  let cjkRun = '';
  let wordRun = '';
  const flushCjk = (): void => {
    if (!cjkRun) return;
    if (cjkRun.length === 1) push(cjkRun);
    else for (let i = 0; i + 1 < cjkRun.length; i += 1) push(cjkRun.slice(i, i + 2));
    cjkRun = '';
  };
  const flushWord = (): void => {
    if (wordRun) { push(wordRun); wordRun = ''; }
  };
  for (const ch of norm) {
    if (CJK_RE.test(ch)) { flushWord(); cjkRun += ch; }
    else if (/[a-z0-9]/.test(ch)) { flushCjk(); wordRun += ch; }
    else { flushCjk(); flushWord(); }               // 空白/标点皆切段
  }
  flushCjk();
  flushWord();
  return tokens;
}

/**
 * 纯函数：提取目标关键词 —— goal + successCriteria 联合分词（中文 2-gram、
 * 英文单词），去停用词/纯数字，按首次出现序去重。
 * 故意不含 failureCriteria：失败判据关键词与成功判据混流会污染元素匹配。
 * 纪元 Δ 缓存律：结果按 GoalSpec 对象用 WeakMap 缓存 —— 调用方跨步复用同一
 * spec 对象时（正是常态）零重分词；spec 被回收则缓存随之释放（WeakMap 语义）。
 * 返回共享只读数组，调用方不得原地修改。
 */
const goalKeywordCache = new WeakMap<object, string[]>();

export function extractGoalKeywords(spec: GoalSpec): string[] {
  const s = (spec ?? {}) as Partial<GoalSpec>;
  if (spec !== null && spec !== undefined && typeof spec === 'object') {
    const hit = goalKeywordCache.get(spec as object);
    if (hit) return hit;
  }
  const texts = [s.goal, ...(Array.isArray(s.successCriteria) ? s.successCriteria : [])];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of texts) {
    for (const tok of tokenizeText(t)) {
      if (!seen.has(tok)) { seen.add(tok); out.push(tok); }
    }
  }
  if (spec !== null && spec !== undefined && typeof spec === 'object') {
    goalKeywordCache.set(spec as object, out);
  }
  return out;
}

/**
 * 分词缓存（纪元 Δ 每步重复分词修律）：判据文本 / 元素标签 / 技能描述在步与步
 * 之间高度复用——同一字符串的 tokens 只算一次，后续命中直取。上限 1024 条，
 * 超限整体清空（快照词面滚动更新，旧键自然失热——简单有界，绝不无限膨胀）。
 * 返回共享只读数组，调用方不得原地修改（本模块内全部用途均为只读遍历）。
 */
const TOKEN_CACHE_MAX = 1024;
const tokenCache = new Map<string, string[]>();

export function tokenizeCached(text: unknown): string[] {
  if (typeof text !== 'string') return tokenizeText(text); // 非串（垃圾输入）走纯函数，不进缓存
  const hit = tokenCache.get(text);
  if (hit) return hit;
  const tokens = tokenizeText(text);
  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear();
  tokenCache.set(text, tokens);
  return tokens;
}

/** 点击目标的词法风险预分类（中文子串命中，英文整词命中；默认 benign） */
export function classifyClickRisk(label: string): 'benign' | 'sensitive' | 'destructive' {
  const s = normalizeWs(label);
  if (!s) return 'benign';
  if (DESTRUCTIVE_ZH.some(w => s.includes(w))) return 'destructive';
  if (DESTRUCTIVE_EN.some(w => new RegExp(`\\b${w}\\b`).test(s))) return 'destructive';
  if (SENSITIVE_ZH.some(w => s.includes(w))) return 'sensitive';
  if (SENSITIVE_EN.some(w => new RegExp(`\\b${w}\\b`).test(s))) return 'sensitive';
  return 'benign';
}

/** 文本摘要是否含某 token：中文子串直判；英文整词边界判（防 'ok' 误中 'token'） */
export function digestHas(digestNorm: string, token: string): boolean {
  if (!token) return false;
  if (CJK_RE.test(token)) return digestNorm.includes(token);
  return new RegExp(`\\b${token}\\b`).test(digestNorm);
}

/** 未达成（status !== 'met'）的判据集：优先取 GoalProgress 的实时标注，缺省把 successCriteria 视作全 unverified */
export function unmetCriteria(goal: Partial<GoalProgress>, spec: Partial<GoalSpec>): CriterionStatus[] {
  if (Array.isArray(goal?.criteriaStatus)) {
    return goal.criteriaStatus.filter(
      c => c && typeof c.criterion === 'string' && c.criterion.trim() !== '' && c.status !== 'met',
    );
  }
  const fromSpec = Array.isArray(spec?.successCriteria) ? spec.successCriteria : [];
  return fromSpec
    .filter(c => typeof c === 'string' && c.trim() !== '')
    .map(c => ({ criterion: c, status: 'unverified' as const }));
}

/** 元素匹配候选：得分 = 标签 token 被某未达成判据关键词覆盖的比例（|∩|/|标签|） */
export interface ScoredCandidate {
  element: SnapshotElement;
  index: number;
  score: number;
  criterion: string;
}

/**
 * findInSnapshot 式匹配：对每个 interactive !== false 的元素，取其标签 token
 * 与各未达成判据 token 集的重合覆盖率（标签被判据完全解释 ⇒ 1.0），保留得分 >0
 * 者，按 得分降序 → 元素置信降序 → 原序 升序排序（全确定性）。
 */
export function buildCandidates(
  elements: SnapshotElement[],
  unmet: CriterionStatus[],
): ScoredCandidate[] {
  const critTokens = unmet
    .map(c => ({ text: c.criterion, tokens: new Set(tokenizeCached(c.criterion)) }))
    .filter(c => c.tokens.size > 0);
  const out: ScoredCandidate[] = [];
  elements.forEach((el, index) => {
    if (!el) return;
    if (el.interactive === false) return; // 明确不可交互者不参选（null = 未知，仍参选）
    const labelTokens = tokenizeCached(el.label);
    if (labelTokens.length === 0) return;
    let best = 0;
    let bestCrit = '';
    for (const c of critTokens) {
      let inter = 0;
      for (const t of labelTokens) if (c.tokens.has(t)) inter++;
      const score = inter / labelTokens.length;
      if (score > best) { best = score; bestCrit = c.text; }
    }
    if (best > 0) out.push({ element: el, index, score: best, criterion: bestCrit });
  });
  out.sort((a, b) =>
    b.score - a.score ||
    clamp01(b.element.confidence) - clamp01(a.element.confidence) ||
    a.index - b.index,
  );
  return out;
}

/**
 * 纪元 Η（Η-4 候选并列破平）：把并列带（与最佳得分差 < tieGap —— 与 uncertain 的
 * 并列判据同带）内的候选交给 Φ-9 反事实沙盘择优 —— scoreOptions 真实 API：
 *   U = 0.5·progressProbability + 0.3·informationGain − 0.2·risk
 * （progress = 目标关键词与元素标签的重合率 / info = 陌生目标 +0.1、已试过 click
 * 折价 0.1 / risk = benign 0.05、sensitive 0.5、destructive 1），胜者挪到带首，带内
 * 其余保持原序 —— 全确定性稳定序（同输入同输出，同 seed 可复现）。
 *
 * 保序律（红律）：效用全并列时 scoreOptions 取带内输入次序在前者 —— 带内输入序
 * 即旧确定性排序（得分→元素置信→原序），故并列破平对「效用同分」的既有路径
 * 逐字节零变化（良性/常规置信候选的选优结果不因本函数在场而漂移）。
 * 防御律：任何异常 ⇒ 原序直通（绝不抛）；带内不足 2 人 ⇒ 原样返回。
 */
export function breakTieBand(
  candidates: ScoredCandidate[],
  spec: Partial<GoalSpec>,
  snapshot: Partial<WorldSnapshot>,
  history: Array<{ action: PolicyAction; outcome: StepOutcome }>,
): ScoredCandidate[] {
  try {
    if (!Array.isArray(candidates) || candidates.length < 2) return candidates;
    const gap = kernelRegistry.getOrDefault('policy.tieGap', TIE_GAP);
    const top = candidates[0].score;
    let bandEnd = 1;
    while (bandEnd < candidates.length && top - candidates[bandEnd].score < gap) bandEnd += 1;
    if (bandEnd <= 1) return candidates;
    const band = candidates.slice(0, bandEnd);
    // 沙盘动作：与本中枢 ② 级真实产出同构（kind/target/utility=元素置信/风险词法分层）
    // —— 保证沙盘效用分与真实执行动作的口径一致
    const sandbox = band.map(c => ({
      kind: 'click' as const,
      target: {
        bbox: c.element.bbox,
        center: c.element.center,
        label: typeof c.element.label === 'string' ? c.element.label : '',
      },
      rationale: '并列破平沙盘动作（不执行）',
      expectedEffect: '仅供 Φ-9 反事实效用评分',
      utility: clamp01(c.element.confidence),
      riskTier: classifyClickRisk(c.element.label),
    }));
    const plan = scoreOptions(sandbox, {
      goalKeywords: extractGoalKeywords(spec as GoalSpec),
      snapshot: snapshot as WorldSnapshot,
      triedActionKeys: (Array.isArray(history) ? history : []).map(h => actionSignature(h?.action)),
    });
    if (!plan) return candidates;
    // 胜者回位：scoreOptions 的 chosen 是 sandbox 数组内的同一引用（indexOf 恒命中）
    const winIdx = sandbox.indexOf(plan.chosen.action as unknown as (typeof sandbox)[number]);
    if (winIdx <= 0) return candidates; // 胜者已是带首（含效用并列取输入序的保序情形）
    const reordered = [band[winIdx], ...band.slice(0, winIdx), ...band.slice(winIdx + 1)];
    return [...reordered, ...candidates.slice(bandEnd)];
  } catch {
    return candidates; // 并列破平是裁决增强不是裁决前提 —— 异常时原序直通
  }
}

/**
 * 僵局探测：取 history 尾部连续 no_effect 段，段内存在「同 kind 相邻成对」的
 * 最近一段 ⇒ 返回 { kind, count }（同类动作连续 ≥2 次无效果）。
 */
export function detectStagnation(
  history: Array<{ action: PolicyAction; outcome: StepOutcome }>,
): { kind: AutonomyActionKind; count: number } | null {
  let i = history.length;
  while (i > 0 && history[i - 1]?.outcome === 'no_effect') i--;
  const suffix = history.slice(i);
  let runKind: AutonomyActionKind | null = null;
  let runLen = 0;
  let best: { kind: AutonomyActionKind; count: number } | null = null;
  for (const entry of suffix) {
    const k = entry?.action?.kind;
    if (k === runKind) {
      runLen++;
      if (runLen >= 2) best = { kind: k, count: runLen };
    } else {
      runKind = k;
      runLen = 1;
    }
  }
  return best;
}

/** history 中最近一次策略切换动作（scroll / inspect 家族）—— 用于轮换抉择 */
export function lastSwitchKind(
  history: Array<{ action: PolicyAction; outcome: StepOutcome }>,
): 'scroll' | 'inspect' | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const k = history[i]?.action?.kind;
    if (k === 'scroll' || k === 'inspect') return k;
  }
  return null;
}

/** 技能描述与目标的关键词重合数（token 集交集大小；描述 tokens 由调用方单次分词复用） */
export function skillOverlap(goalTokens: Set<string>, descriptionTokens: readonly string[]): number {
  let shared = 0;
  for (const t of descriptionTokens) if (goalTokens.has(t)) shared++;
  return shared;
}

/** 云脑选点提示词 —— 中文模板：目标 + 未达成判据 + 候选标签列表，索要 {index, reason} */
export function buildPickPrompt(goalText: string, unmetTexts: string[], labels: string[]): string {
  return [
    '你是桌面自动化决策助手。当前世界快照中筛出了一组候选可交互元素。',
    `用户目标：${goalText || '（未给出）'}`,
    `尚未达成的成功判据：${unmetTexts.length > 0 ? unmetTexts.join('；') : '（无）'}`,
    '候选元素列表（index: 标签）：',
    ...labels.map((l, i) => `${i}. ${l}`),
    '请判断点击哪个候选元素最有利于推进目标。',
    '只输出一个 JSON 对象，不要输出其他文字：{"index": <候选序号整数>, "reason": "<一句中文理由>"}',
  ].join('\n');
}
