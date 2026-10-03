// src/autonomy/policyEngine.ts
// 纪元 Φ（Φ-3 自主判断中枢）：给定世界快照与目标进度，裁决下一步动作。
//
// 定位：自主智能环的「意志」—— 不执行、只决策。输入 Φ-2 的世界快照与 Φ-1 的
// 目标状态，输出一个自带理据（rationale）、预期效应（expectedEffect）、效用
// （utility）与风险分层（riskTier）的 PolicyAction，交执行层落地、Φ-4 验证层核对。
//
// 决策铁律（与全仓一致）：
//   1. 确定性优先 —— 七级决策序逐级裁决、先到先得（详见 decide 的 JSDoc）；
//      云脑只在元素匹配「低置信或并列」时被咨询一次，失败即回退确定性选择。
//   2. 绝不抛异常 —— 任何内部异常收敛为 escalate 决策（degraded:true）。
//   3. 可审计 —— 每个动作自带一句中文 rationale 与预期效应，喂给验证层与人类。
//   4. 零新增依赖 —— 分词/匹配自带轻量实现（中文 2-gram + 英文单词），不复用
//      fuzzy.ts（那是对 OCR 逐字噪声的编辑距离容错，语义与此处不同）。
//   5. 分词结果有界缓存（纪元 Δ）—— GoalSpec 关键词按对象 WeakMap 缓存、字符串
//      分词走 1024 条上限的 Map：同输入同输出（行为透明），跨步复用的判据/标签/
//      技能描述零重算；缓存数组只读共享，调用方不得原地修改。
import { getGlmClient, isGlmConfigured, type GlmClient } from '../vlm/glmClient';
import type { SnapshotElement, WorldSnapshot } from './worldSnapshot';
import type { CriterionStatus, GoalProgress, GoalSpec } from './goalState';
import { kernelRegistry } from '../kernel/registry';

// ─── 契约类型（Φ 纪元行动词汇表） ───

/** 动作种类 —— 本中枢实际发出：click / hotkey / scroll / inspect / declare / recall_skill / escalate / ask_vlm（type / drag / wait 留给规划层与执行层扩展） */
export type AutonomyActionKind =
  | 'click'
  | 'type'
  | 'scroll'
  | 'hotkey'
  | 'drag'
  | 'inspect'
  | 'ask_vlm'
  | 'recall_skill'
  | 'wait'
  | 'escalate'
  | 'declare';

/** 一次政策裁决产出的动作 —— rationale / expectedEffect 恒为非空中文 */
export interface PolicyAction {
  kind: AutonomyActionKind;
  /** 世界坐标系内的动作落点（click / 弹窗确认点击时必有） */
  target?: {
    bbox: { x0: number; y0: number; x1: number; y1: number };
    center: { x: number; y: number };
    label: string;
  };
  /** 动作参数（如 {keys:['esc']}、{direction:'down'}、{criterion:...}） */
  payload?: Record<string, unknown>;
  /** 一句中文：为什么选这个动作（人类审计与日志主料） */
  rationale: string;
  /** 预期变化（中文，喂给 Φ-4 验证层做前后对照） */
  expectedEffect: string;
  /** 效用估计 0..1（决策序各级有约定基线，见 decide JSDoc） */
  utility: number;
  /** 风险分层：benign 无害 / sensitive 需留意 / destructive 破坏性（执行层风险闸门的预分类） */
  riskTier: 'benign' | 'sensitive' | 'destructive';
}

/** 一步执行后的世界反馈（由 Φ-4 验证层标注回灌 history） */
export type StepOutcome = 'progress' | 'no_effect' | 'regress' | 'error';

/** decide 的全部输入 —— 一次世界状态 + 目标状态 + 行动史 + 可选技能与预算 */
export interface PolicyContext {
  snapshot: WorldSnapshot;
  spec: GoalSpec;
  goal: GoalProgress;
  history: Array<{ action: PolicyAction; outcome: StepOutcome }>;
  skills?: Array<{ id: string; description: string; reliability: number }>;
  budgetRemaining?: { steps: number; ms: number };
}

/** 一次裁决的产出：动作 + 置信/降级标记（note 记录云脑裁决或回退原因） */
export interface PolicyDecision {
  action: PolicyAction;
  /** true = 本地确定性证据不足（匹配低置信或候选并列），已请云脑仲裁或待仲裁 */
  uncertain: boolean;
  /** true = 决策管线降级（云脑咨询失败回退 / 云脑未配置 / 内部异常） */
  degraded: boolean;
  note?: string;
}

/** 构造选项 —— client 注入假件供测试；useVlmWhenUncertain 缺省 true（不确定即咨询，云脑只在此刻介入） */
export interface PolicyEngineOptions {
  client?: GlmClient;
  useVlmWhenUncertain?: boolean;
}

// ─── 常量 ───

/** 元素匹配置信门槛：最佳候选得分低于此值 ⇒ uncertain（请云脑或如实标注） */
const MATCH_CONFIDENT = 0.55;
/** 候选并列判定：最佳与次佳得分差小于此值 ⇒ uncertain */
const TIE_GAP = 0.05;
/** 云脑咨询的候选上限（提示词带宽礼仪） */
const VLM_CANDIDATE_CAP = 8;
/** 预算红线：剩余步数 ≤2 或剩余毫秒 ≤15000 ⇒ 升级 */
const BUDGET_STEPS_LOW = 2;
const BUDGET_MS_LOW = 15_000;
/** 弹窗确认类元素判据（中文子串 + 英文整词，大小写/空白已折叠）。
 *  纪元 Δ 扫描面修正：补「确定/是/同意/yes」——只认 确认/ok/allow 时，四类
 *  高频确认按钮会反落 Esc 分支（Esc 对模态确认框常等于「取消」，语义相反）。 */
const POPUP_CONFIRM_RE = /确认|确定|同意|允许|继续|是|\bok\b|\ballow\b|\byes\b/;
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
function normalizeWs(s: unknown): string {
  return typeof s === 'string' ? s.toLowerCase().replace(/\s+/g, ' ').trim() : '';
}

/** 数值夹 [0,1]；非有限数按中性 0.5 记（与 grounding 的置信兜底同律） */
function clamp01(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0.5;
  return Math.min(1, Math.max(0, n));
}

/** 保留两位小数的得分（供 payload/rationale 展示，避免浮点尾噪） */
function round2(v: number): number {
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
    else for (let i = 0; i + 1 < cjkRun.length; i++) push(cjkRun.slice(i, i + 2));
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

function tokenizeCached(text: unknown): string[] {
  if (typeof text !== 'string') return tokenizeText(text); // 非串（垃圾输入）走纯函数，不进缓存
  const hit = tokenCache.get(text);
  if (hit) return hit;
  const tokens = tokenizeText(text);
  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear();
  tokenCache.set(text, tokens);
  return tokens;
}

/** 点击目标的词法风险预分类（中文子串命中，英文整词命中；默认 benign） */
function classifyClickRisk(label: string): 'benign' | 'sensitive' | 'destructive' {
  const s = normalizeWs(label);
  if (!s) return 'benign';
  if (DESTRUCTIVE_ZH.some(w => s.includes(w))) return 'destructive';
  if (DESTRUCTIVE_EN.some(w => new RegExp(`\\b${w}\\b`).test(s))) return 'destructive';
  if (SENSITIVE_ZH.some(w => s.includes(w))) return 'sensitive';
  if (SENSITIVE_EN.some(w => new RegExp(`\\b${w}\\b`).test(s))) return 'sensitive';
  return 'benign';
}

/** 文本摘要是否含某 token：中文子串直判；英文整词边界判（防 'ok' 误中 'token'） */
function digestHas(digestNorm: string, token: string): boolean {
  if (!token) return false;
  if (CJK_RE.test(token)) return digestNorm.includes(token);
  return new RegExp(`\\b${token}\\b`).test(digestNorm);
}

/** 未达成（status !== 'met'）的判据集：优先取 GoalProgress 的实时标注，缺省把 successCriteria 视作全 unverified */
function unmetCriteria(goal: Partial<GoalProgress>, spec: Partial<GoalSpec>): CriterionStatus[] {
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
interface ScoredCandidate {
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
function buildCandidates(
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
 * 僵局探测：取 history 尾部连续 no_effect 段，段内存在「同 kind 相邻成对」的
 * 最近一段 ⇒ 返回 { kind, count }（同类动作连续 ≥2 次无效果）。
 */
function detectStagnation(
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
function lastSwitchKind(
  history: Array<{ action: PolicyAction; outcome: StepOutcome }>,
): 'scroll' | 'inspect' | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const k = history[i]?.action?.kind;
    if (k === 'scroll' || k === 'inspect') return k;
  }
  return null;
}

/** 技能描述与目标的关键词重合数（token 集交集大小；描述 tokens 由调用方单次分词复用） */
function skillOverlap(goalTokens: Set<string>, descriptionTokens: readonly string[]): number {
  let shared = 0;
  for (const t of descriptionTokens) if (goalTokens.has(t)) shared++;
  return shared;
}

/** 云脑选点提示词 —— 中文模板：目标 + 未达成判据 + 候选标签列表，索要 {index, reason} */
function buildPickPrompt(goalText: string, unmetTexts: string[], labels: string[]): string {
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

// ─── 决策中枢 ───

/**
 * Φ-3 自主判断中枢 —— 无状态、确定性优先、绝不抛异常。
 *
 * decide() 的七级确定性决策序（先到先得，每级 rationale 见实现）：
 *  ① 弹窗优先：popups 非空 ⇒ 点弹窗内确认类元素（label 命中 确认/确定/同意/
 *     允许/继续/是/ok/allow/yes）或按 Esc（payload {keys:['esc']}），utility 0.9；
 *  ② 判据匹配点击：未 met 判据关键词与元素标签重合（覆盖率打分）且
 *     interactive !== false ⇒ click 最佳候选，utility = 元素 confidence；
 *  ③ 文本宣称：无元素匹配但 textDigest 已含某判据全部关键词 ⇒ declare
 *     （宣称达成，交验证层核对），utility 0.6；
 *  ④ 僵局切换：尾部同类动作连续 ≥2 次 no_effect ⇒ scroll（{direction:'down'}）
 *     与 inspect（聚焦区域放大）轮换，utility 0.5；
 *  ⑤ 技能召回：skills 描述与目标关键词重合 ⇒ recall_skill，
 *     utility = reliability × 0.8；
 *  ⑥ 预算升级：剩余步数 ≤2 或剩余毫秒 ≤15000 ⇒ escalate，utility 0.4；
 *  ⑦ 云脑兜底：ask_vlm（uncertain:true，utility 0.3，动作本身由执行层持图
 *     发问）；若云脑未配置（无注入 client 且 isGlmConfigured()=false）⇒
 *     escalate（degraded:true，utility 0.3）。
 *
 * 不确定判定（仅 ②）：最佳候选得分 <0.55 或与次佳差 <0.05 ⇒ uncertain；
 * 此时若 useVlmWhenUncertain 且云脑可用，用 client.chatJson 问一次
 * 「给定目标与元素标签列表，该点哪个 index」（纯文本对话，输出 {index, reason}），
 * 命中 ⇒ 用云脑选择；越界/失败/异常 ⇒ 回退确定性最佳选择并标 degraded:true。
 */
export class PolicyEngine {
  private readonly injectedClient: GlmClient | undefined;
  private readonly useVlmWhenUncertain: boolean;

  constructor(options: PolicyEngineOptions = {}) {
    this.injectedClient = options?.client;
    // 缺省 true：不确定即咨询 —— 云脑只在这一刻介入，其余时刻全确定性
    this.useVlmWhenUncertain = options?.useVlmWhenUncertain !== false;
  }

  /** 解析可用云脑：注入 client 优先，其次全局单例（须已配置）；注入了未配置的真 client 视同未配置 */
  private resolveClient(): GlmClient | null {
    try {
      const c = this.injectedClient ?? (isGlmConfigured() ? getGlmClient() : null);
      if (!c) return null;
      if ((c as { configured?: boolean }).configured === false) return null;
      return c;
    } catch {
      return null;
    }
  }

  /**
   * 云脑选点咨询（只问一次）：候选列表 index → {index, reason}。
   * 越界 / 非法 / 调用失败 / 抛异常 ⇒ { picked:null, note:回退原因 }，绝不抛。
   */
  private async consultVlmPick(
    client: GlmClient,
    goalText: string,
    unmetTexts: string[],
    candidates: ScoredCandidate[],
  ): Promise<{ picked: ScoredCandidate | null; note: string }> {
    const labels = candidates.map(c =>
      typeof c.element.label === 'string' ? c.element.label : '',
    );
    const prompt = buildPickPrompt(goalText, unmetTexts, labels);
    try {
      const res = await client.chatJson<{ index?: unknown; reason?: unknown }>({
        images: [], // 快照不含像素，纯文本语义仲裁（协议允许空图对话）
        prompt,
        temperature: 0.1,
        maxTokens: 512,
      });
      if (!res.ok) {
        return { picked: null, note: `云脑咨询失败（${res.error ?? '未知错误'}），回退确定性最佳匹配` };
      }
      const v = res.value;
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        return { picked: null, note: '云脑回复非 JSON 对象，回退确定性最佳匹配' };
      }
      const idx = (v as { index?: unknown }).index;
      if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= candidates.length) {
        return { picked: null, note: `云脑给出的 index 越界（${String(idx)}），回退确定性最佳匹配` };
      }
      const reason = String((v as { reason?: unknown }).reason ?? '').slice(0, 80);
      return { picked: candidates[idx], note: reason || '点击该候选最有利于推进目标' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { picked: null, note: `云脑咨询异常（${msg}），回退确定性最佳匹配` };
    }
  }

  /**
   * 裁决下一步动作 —— 永不抛错；任何内部异常收敛为 escalate（degraded:true）。
   * 输入缺字段按空集处理（宁可保守升级，不可凭空动作）。
   */
  async decide(ctx: PolicyContext): Promise<PolicyDecision> {
    try {
      const snapshot = (ctx?.snapshot ?? {}) as Partial<WorldSnapshot>;
      const spec = (ctx?.spec ?? {}) as Partial<GoalSpec>;
      const goal = (ctx?.goal ?? {}) as Partial<GoalProgress>;
      const history = Array.isArray(ctx?.history) ? ctx.history : [];
      const elements = (Array.isArray(snapshot.elements) ? snapshot.elements : []).filter(
        e => !!e,
      ) as SnapshotElement[];
      const popups = (Array.isArray(snapshot.popups) ? snapshot.popups : []).filter(
        p => typeof p === 'string' && p.trim() !== '',
      );
      const unmet = unmetCriteria(goal, spec);
      const unmetTexts = unmet.map(u => u.criterion);
      const goalText = typeof spec.goal === 'string' ? spec.goal : '';

      // ① 弹窗优先：弹窗遮挡下的其余决策都不可信，先恢复主界面
      if (popups.length > 0) {
        const popupName = popups[0];
        const confirmEl = elements
          .filter(
            e => e.interactive !== false && POPUP_CONFIRM_RE.test(normalizeWs(e.label)),
          )
          .sort((a, b) => clamp01(b.confidence) - clamp01(a.confidence))[0];
        if (confirmEl) {
          return {
            action: {
              kind: 'click',
              target: {
                bbox: confirmEl.bbox,
                center: confirmEl.center,
                label: confirmEl.label,
              },
              payload: { popup: popupName },
              rationale: `检测到弹窗「${popupName}」，点击其确认类元素「${confirmEl.label}」以关闭`,
              expectedEffect: '弹窗确认后关闭，下一帧快照 popups 为空',
              utility: 0.9,
              riskTier: classifyClickRisk(confirmEl.label),
            },
            uncertain: false,
            degraded: false,
          };
        }
        return {
          action: {
            kind: 'hotkey',
            payload: { keys: ['esc'] },
            rationale: `检测到弹窗「${popupName}」且无确认类元素，按 Esc 先行关闭以恢复主界面`,
            expectedEffect: '弹窗关闭，下一帧快照 popups 为空',
            utility: 0.9,
            riskTier: 'benign',
          },
          uncertain: false,
          degraded: false,
        };
      }

      // ② 判据匹配点击：未达成判据的关键词在可交互元素标签上的最佳覆盖
      const candidates = buildCandidates(elements, unmet);
      if (candidates.length > 0) {
        const best = candidates[0];
        const second = candidates[1];
        // 纪元 Θ（Θ-4 生产接线）：不确定判据双阈值读内核注册表 —— 未注册 ⇒
        // getOrDefault 回声模块常量（0.55 / 0.05），行为逐字节不变。
        const tied = second !== undefined && best.score - second.score < kernelRegistry.getOrDefault('policy.tieGap', TIE_GAP);
        const low = best.score < kernelRegistry.getOrDefault('policy.matchConfident', MATCH_CONFIDENT);
        const uncertain = tied || low;
        let chosen = best;
        let degraded = false;
        let note: string | undefined;
        let rationale = `判据「${best.criterion}」关键词与元素「${best.element.label}」标签重合（得分 ${round2(best.score)}），点击推进目标`;
        if (uncertain && this.useVlmWhenUncertain) {
          const client = this.resolveClient();
          if (client) {
            const r = await this.consultVlmPick(
              client,
              goalText,
              unmetTexts,
              candidates.slice(0, VLM_CANDIDATE_CAP),
            );
            if (r.picked) {
              chosen = r.picked;
              note = `云脑裁决：${r.note}`;
              rationale = `元素匹配不确定（${tied ? '候选得分并列' : '匹配置信不足'}），${note}，点击「${chosen.element.label}」`;
            } else {
              degraded = true;
              note = r.note;
            }
          } else {
            note = '云脑未配置或不可用，保留确定性最佳匹配';
          }
        }
        return {
          action: {
            kind: 'click',
            target: {
              bbox: chosen.element.bbox,
              center: chosen.element.center,
              label: chosen.element.label,
            },
            payload: { criterion: chosen.criterion, matchScore: round2(chosen.score) },
            rationale,
            expectedEffect: `「${chosen.element.label}」被激活，页面状态变化使判据「${chosen.criterion}」可被验证`,
            utility: clamp01(chosen.element.confidence),
            riskTier: classifyClickRisk(chosen.element.label),
          },
          uncertain,
          degraded,
          ...(note ? { note } : {}),
        };
      }

      // ③ 文本宣称：判据关键词已全部见于文本摘要 ⇒ 宣称达成，交验证层核对
      const digest = normalizeWs(snapshot.textDigest);
      if (digest) {
        for (const c of unmet) {
          const tokens = [...new Set(tokenizeCached(c.criterion))];
          if (tokens.length > 0 && tokens.every(t => digestHas(digest, t))) {
            return {
              action: {
                kind: 'declare',
                payload: { criterion: c.criterion },
                rationale: `判据「${c.criterion}」的全部关键词已见于页面文本摘要，宣称其达成并交验证层核对`,
                expectedEffect: '验证层复核后，该判据状态更新为 met',
                utility: 0.6,
                riskTier: 'benign',
              },
              uncertain: false,
              degraded: false,
            };
          }
        }
      }

      // ④ 僵局切换：尾部同类动作连续 ≥2 次无效果 ⇒ scroll / inspect 轮换
      const stagnation = detectStagnation(history);
      if (stagnation) {
        const next = lastSwitchKind(history) === 'scroll' ? 'inspect' : 'scroll';
        if (next === 'scroll') {
          return {
            action: {
              kind: 'scroll',
              payload: { direction: 'down' },
              rationale: `「${stagnation.kind}」连续 ${stagnation.count} 次无效果，切换策略：向下滚动暴露未见内容`,
              expectedEffect: '视口下移，快照出现新元素或新文本',
              utility: 0.5,
              riskTier: 'benign',
            },
            uncertain: false,
            degraded: false,
          };
        }
        const fr = snapshot.focusedRegion;
        const region =
          fr && typeof fr === 'object'
            ? fr
            : {
                x0: 0,
                y0: 0,
                x1: typeof snapshot.width === 'number' && snapshot.width > 0 ? snapshot.width : 1920,
                y1: typeof snapshot.height === 'number' && snapshot.height > 0 ? snapshot.height : 1080,
              };
        return {
          action: {
            kind: 'inspect',
            payload: { region },
            rationale: `「${stagnation.kind}」连续 ${stagnation.count} 次无效果，切换策略：聚焦区域放大细察`,
            expectedEffect: '聚焦区域被放大细察，识别出更精细的元素或文本',
            utility: 0.5,
            riskTier: 'benign',
          },
          uncertain: false,
          degraded: false,
        };
      }

      // ⑤ 技能召回：技能描述与目标关键词重合 ⇒ 复用可靠流程
      //    （描述只分词一次，重叠计算与长词复查共用 —— 纪元 Δ 每步重复分词修律）
      if (Array.isArray(ctx?.skills) && ctx.skills.length > 0) {
        const goalTokens = new Set(tokenizeCached(goalText));
        const overlapping = ctx.skills
          .map((s, i) => {
            const descTokens = tokenizeCached(s?.description);
            return { skill: s, i, descTokens, shared: skillOverlap(goalTokens, descTokens) };
          })
          .filter(
            e =>
              e.shared >= 2 ||
              (e.shared >= 1 &&
                e.descTokens.some(
                  t => goalTokens.has(t) && t.length >= 4,
                )),
          )
          .sort((a, b) => clamp01(b.skill?.reliability) - clamp01(a.skill?.reliability) || a.i - b.i);
        const top = overlapping[0];
        if (top) {
          return {
            action: {
              kind: 'recall_skill',
              payload: { skillId: top.skill.id, description: top.skill.description },
              rationale: `技能「${top.skill.id}」描述与目标重合（共享 ${top.shared} 个关键词），召回其可靠流程`,
              expectedEffect: '技能流程逐步展开执行，推进目标判据',
              utility: clamp01(top.skill.reliability) * 0.8,
              riskTier: 'benign',
            },
            uncertain: false,
            degraded: false,
          };
        }
      }

      // ⑥ 预算升级：步数/时间将尽 ⇒ 交上游裁决，避免半途失控
      // 纪元 Ξ（Ξ-D 生产接线）：预算红线读内核注册表 —— policy.budgetStepsLow
      //（缺省 2）/ policy.budgetMsLow（缺省 15000）。未注册 ⇒ getOrDefault 回声
      // 字面量，升级判决逐字节不变；每次 decide 单次读取（set 即时生效）。
      const budget = ctx?.budgetRemaining;
      if (budget && typeof budget === 'object') {
        const steps = typeof budget.steps === 'number' && Number.isFinite(budget.steps) ? budget.steps : Number.POSITIVE_INFINITY;
        const ms = typeof budget.ms === 'number' && Number.isFinite(budget.ms) ? budget.ms : Number.POSITIVE_INFINITY;
        if (steps <= kernelRegistry.getOrDefault('policy.budgetStepsLow', BUDGET_STEPS_LOW)
          || ms <= kernelRegistry.getOrDefault('policy.budgetMsLow', BUDGET_MS_LOW)) {
          return {
            action: {
              kind: 'escalate',
              payload: {
                reason: 'budget-low',
                ...(Number.isFinite(steps) ? { stepsLeft: steps } : {}),
                ...(Number.isFinite(ms) ? { msLeft: ms } : {}),
              },
              rationale: `预算将尽（剩 ${Number.isFinite(steps) ? steps : '?'} 步 / ${Number.isFinite(ms) ? ms : '?'}ms），升级上游裁决避免半途失控`,
              expectedEffect: '控制权移交上游（人工介入或重新规划）',
              utility: 0.4,
              riskTier: 'benign',
            },
            uncertain: false,
            degraded: false,
          };
        }
      }

      // ⑦ 云脑兜底：本地七级规则均未命中 —— 有云脑则交开放语义，无云脑则升级
      const client = this.resolveClient();
      if (client) {
        return {
          action: {
            kind: 'ask_vlm',
            payload: {
              question: `目标「${goalText || '（未给出）'}」在当前快照中无确定性动作可推进；请观察整屏并给出下一步建议（未达成判据：${unmetTexts.length > 0 ? unmetTexts.join('；') : '无'}）`,
            },
            rationale: '本地七级确定性规则均未命中，交云脑开放语义观察整屏给出建议',
            expectedEffect: '云脑给出下一步动作建议，进入下一决策循环',
            utility: 0.3,
            riskTier: 'benign',
          },
          uncertain: true,
          degraded: false,
        };
      }
      return {
        action: {
          kind: 'escalate',
          payload: { reason: 'no-deterministic-action' },
          rationale: '本地规则未命中且云脑未配置（缺 API Key），升级上游或人工裁决',
          expectedEffect: '控制权移交上游或人工，本环暂停',
          utility: 0.3,
          riskTier: 'benign',
        },
        uncertain: true,
        degraded: true,
      };
    } catch (e) {
      // 绝不抛异常：未知异常（含注入物炸裂）收敛为升级决策
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      return {
        action: {
          kind: 'escalate',
          payload: { reason: 'policy-engine-internal-error', detail: msg },
          rationale: `决策管线内部异常（${msg}），升级上游裁决`,
          expectedEffect: '本轮不执行世界动作，等待上游指令',
          utility: 0.3,
          riskTier: 'benign',
        },
        uncertain: true,
        degraded: true,
        note: 'policy-engine-internal-error',
      };
    }
  }
}
