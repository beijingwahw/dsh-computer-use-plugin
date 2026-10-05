// src/autonomy/explorationCore.ts
// W6-1（doctor 债清偿·smell.over-engineering）：从 exploration.ts 提取的纯逻辑区 ——
// 常量（值即边界）、区域量化、UCB 前沿分数、端口契约类型、内部记账结构与
// 候选生成/riskGate 代价两个纯函数（原私有方法 buildCandidates/riskCostOf ——
// 零 this 引用，逐字节搬运为自由函数）。exploration.ts 保留 ExplorationLedger
// 账本类，导入面不变（公共面原位再导出）。
import type { PolicyAction, StepOutcome } from './policyEngine';
import type { WorldSnapshot, SnapshotElement } from './worldSnapshot';
import type { TrackedRect } from '../elementTracker';
import { matchesDangerPatterns, matchesRiskPatterns } from '../riskGate';

// ── W3-7：常量（值即边界）──

/** 量化网格横向格数（区域轴粒度：12 列 × 8 行 = 96 格覆盖整屏） */
export const EXPLORATION_GRID_COLS = 12;
/** 量化网格纵向格数 */
export const EXPLORATION_GRID_ROWS = 8;
/** UCB 探索项系数 c（c·√(ln N / n_i)）—— 模块常量，经内核键 exploration.ucbC 可调 */
export const EXPLORATION_UCB_C = 0.7;
/** 利用项系数 k（k·posteriorMean —— Beta 成功账的利用权重）—— 模块常量，经内核键
 *  exploration.exploitWeight 可调 [0,2]（0 ⇒ 纯探索旧行为；2 ⇒ 强利用） */
export const EXPLORATION_EXPLOIT_WEIGHT = 0.5;
/** 同模态连打惩罚（交替律：模态按轮换防连打 —— 与 policyEngine ④ 僵局切换同哲学） */
export const EXPLORATION_ALTERNATION_PENALTY = 0.25;
/** 负先验单位降权（failureMemory 每次文本命中 × 命中强度 score2） */
export const EXPLORATION_NEG_PRIOR_UNIT = 0.15;
/** 负先验降权上限（软先验的有界承诺 —— 绝不把一格打成禁区，只降权） */
export const EXPLORATION_NEG_PRIOR_CAP = 0.45;
/** riskGate 代价档：命中不可逆词表（danger）⇒ 0.6 */
export const EXPLORATION_RISK_COST_DANGER = 0.6;
/** riskGate 代价档：命中凭据词表（risk）⇒ 0.3 */
export const EXPLORATION_RISK_COST_SENSITIVE = 0.3;
/** 恢复态判据：尾部连续无效果/错误/倒退步数 ≥ 此值 ⇒ 恢复态（常态零触发红律） */
export const EXPLORATION_RECOVERY_MIN_RUN = 2;
/** 单 run 探索建议上限（探索绝不无限替代升级 —— 步保险丝之外的第三重停机） */
export const EXPLORATION_MAX_ADVISES_PER_RUN = 4;
/** 负先验查询返回上限（k —— 与 failureMemory.match 的 k 同义） */
export const EXPLORATION_NEG_PRIOR_K = 3;
/** 候选元素上限（每步 advise 的有界扫描面） */
export const EXPLORATION_ELEMENT_CAP = 64;
/** 探索账容量上限（LRU 驱逐 —— 目标 × 区域 × 模态 × 策略组合爆炸的有界承诺） */
export const EXPLORATION_MAX_CELLS_DEFAULT = 4096;
/** 单侧计数的合法上限（防御恢复：垃圾巨值不淹没后验） */
export const EXPLORATION_MAX_COUNT = 1_000_000;
/** 持久化格式版本 */
export const EXPLORATION_VERSION = 1;
/** 视口缺省（快照无宽高时的量化回退 —— 1920×1080 主流桌面） */
export const DEFAULT_VIEWPORT = { width: 1920, height: 1080 } as const;
/** 策略签名长度上限（账本键的带宽礼仪） */
export const STRATEGY_MAX = 120;

/** W3-7：世界动作模态闭集（declare/escalate/wait/ask_vlm/recall_skill 不入模态账） */
export const EXPLORATION_MODALITIES = ['click', 'type', 'hotkey', 'scroll', 'drag', 'inspect'] as const;
export type ExplorationModality = (typeof EXPLORATION_MODALITIES)[number];

// ── W3-7：区域量化（纯函数、确定性、绝不抛） ──

/**
 * W3-7：elementTracker 框量化网格 —— 元素中心落格（只读消费 TrackedRect 方言）。
 * 坐标按视口相对位置折算（同一相对位置在不同分辨率落同格 —— 量化对分辨率免疫）；
 * 越界夹回网格边缘（半格在外仍在册）；中心非法（非有限数）⇒ -1（不入账）。
 * 纯确定性：同输入同输出。
 */
export function quantizeRegion(
  rect: TrackedRect | null | undefined,
  viewport?: { width?: unknown; height?: unknown } | null,
): number {
  return quantizePoint(
    rect === null || rect === undefined || typeof rect !== 'object'
      ? undefined
      : { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    viewport,
  );
}

/**
 * W3-7：点量化落格（quantizeRegion 的中心点方言 —— SnapshotElement.center 直入）。
 * col = ⌊relX·COLS⌋ 夹 [0, COLS−1]；row 同律；返回 row·COLS + col ∈ [0, 95]。
 */
export function quantizePoint(
  center: { x?: unknown; y?: unknown } | null | undefined,
  viewport?: { width?: unknown; height?: unknown } | null,
): number {
  if (center === null || center === undefined || typeof center !== 'object') return -1;
  const { x, y } = center as { x?: unknown; y?: unknown };
  if (typeof x !== 'number' || !Number.isFinite(x)) return -1;
  if (typeof y !== 'number' || !Number.isFinite(y)) return -1;
  const vp = viewport && typeof viewport === 'object' ? viewport : {};
  const w = typeof vp.width === 'number' && Number.isFinite(vp.width) && vp.width > 0 ? vp.width : DEFAULT_VIEWPORT.width;
  const h = typeof vp.height === 'number' && Number.isFinite(vp.height) && vp.height > 0 ? vp.height : DEFAULT_VIEWPORT.height;
  const relX = Math.min(1, Math.max(0, x / w));
  const relY = Math.min(1, Math.max(0, y / h));
  const col = Math.min(EXPLORATION_GRID_COLS - 1, Math.floor(relX * EXPLORATION_GRID_COLS));
  const row = Math.min(EXPLORATION_GRID_ROWS - 1, Math.floor(relY * EXPLORATION_GRID_ROWS));
  return row * EXPLORATION_GRID_COLS + col;
}

/** W3-7：区域的审计标签（负先验查询与 rationale 共用的名词形式） */
export function regionLabel(region: number): string {
  const r = Number.isInteger(region) && region >= 0 && region < EXPLORATION_GRID_COLS * EXPLORATION_GRID_ROWS
    ? region
    : -1;
  if (r < 0) return '区域 ?';
  return `区域 r${r} (${r % EXPLORATION_GRID_COLS},${Math.floor(r / EXPLORATION_GRID_COLS)})`;
}

/**
 * W3-7：尾部连续失败游程（纯函数）—— no_effect / error / regress 连续尾段长度。
 * 恢复态判据的核心：熔断后/僵局切换的现场特征就是「最近几步都没推进」。
 */
export function trailingFailureRun(
  history: ReadonlyArray<{ action?: unknown; outcome?: unknown }>,
): number {
  if (!Array.isArray(history)) return 0;
  let run = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const o = history[i]?.outcome;
    if (o === 'no_effect' || o === 'error' || o === 'regress') run++;
    else break;
  }
  return run;
}

// ── W3-7：UCB 前沿分数（纯函数、手算可验） ──

/** explorationScore 的全部入参（纯数据 —— 测试手算小例的直接消费面） */
export interface ExplorationScoreInput {
  /** 该区域的总尝试数（任意模态任意策略 —— 区域未探测不确定度的分母） */
  regionTries: number;
  /** 该 (区域×模态×策略) 格的尝试数（新颖度的分母 + UCB 的 n_i） */
  cellTries: number;
  /** 全账总尝试数（UCB 的 N） */
  totalTries: number;
  /** riskGate 代价（命中凭据词 0.3 / 不可逆词 0.6 / 无 0；只读调用的折算） */
  riskCost: number;
  /** failureMemory 负先验降权（区域×模态组合的文本命中折算，上限 0.45） */
  negativePriorPenalty: number;
  /** 该候选模态与上一步模态相同 ⇒ 交替律惩罚（防同模态连打） */
  sameModalityAsLast: boolean;
  /** UCB 系数 c（缺省模块常量；生产经内核键 exploration.ucbC 注入） */
  ucbC?: number;
  /** 该格成功数（progress 结局计数 —— 利用项的后验分子，posteriorMean =
   *  (cellSuccesses+1)/(cellTries+2) Laplace，与 snapshot 口径同源）。字段缺席 ⇒
   *  利用项 0（零回归：无成功账的格不受罚）。 */
  cellSuccesses?: number;
  /** 利用项系数 k（缺省模块常量；生产经内核键 exploration.exploitWeight 注入 [0,2]） */
  exploitWeight?: number;
}

/**
 * W3-7：UCB 前沿分数（纯函数、确定性、绝不抛；负输入按 0 收敛）：
 *
 *   score = 1/(1+regionTries)            区域未探测不确定度（全新区域 ⇒ 1）
 *         + 1/(1+cellTries)              新颖度（从未试过的格 ⇒ 1）
 *         + c·√(ln(1+N)/(1+n_i))         UCB 探索项（欠采样加成；N=0 ⇒ 0）
 *         + k·(s_i+1)/(n_i+2)            利用项（ΝΩ-12：Beta(1,1) Laplace 后验均值 ——
 *                                        成功账入式，同 tries 下已知好格压过已知坏格；
 *                                        cellSuccesses 缺席 ⇒ 0 —— 无成功账不受罚）
 *         − riskCost                     riskGate 代价（只读）
 *         − negativePriorPenalty         负先验降权（只读）
 *         − sameModalityAsLast ? 0.25 : 0  交替律（防同模态连打）
 *
 * 分母一律 +1（n_i=0 / N=0 的除零免疫）；对数取 ln(1+N)（N=0 ⇒ 0 —— 空账
 * 不虚发探索加成，新颖度与不确定度两项已是满额）。
 *
 * ΝΩ-12（explore-exploit 平衡恢复）：负先验与利用项的相互作用核对 —— 利用项
 * 恒 ≥ 0 且 ≤ k（只奖不罚：已知坏格失去的是它本可得的奖励，绝非额外罚金），
 * 与 negPrior（软先验，≤ 0.45）叠加的总下压有界：各项均在 [0,1] 夹取 ⇒
 * score ≥ 0+0+0+0 −1 −1 −0.25 = −2.25，绝无除法参与（后验分母 n_i+2 ≥ 2 恒正，
 * 「分母为负」结构上不可能）；负分数合法 —— 消费面是 advise 的 argmax 相对序
 * （重罪格理应沉底），UCB 其余三项仍可翻案（软先验降权不除名）。
 */
export function explorationScore(input: ExplorationScoreInput): number {
  const num = (v: unknown, fallback = 0): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
  const regionTries = num(input?.regionTries);
  const cellTries = num(input?.cellTries);
  const totalTries = num(input?.totalTries);
  const riskCost = Math.min(1, num(input?.riskCost));
  const negPrior = Math.min(1, num(input?.negativePriorPenalty));
  const c = typeof input?.ucbC === 'number' && Number.isFinite(input.ucbC) && input.ucbC >= 0
    ? input.ucbC
    : EXPLORATION_UCB_C;
  const k = typeof input?.exploitWeight === 'number' && Number.isFinite(input.exploitWeight) && input.exploitWeight >= 0
    ? input.exploitWeight
    : EXPLORATION_EXPLOIT_WEIGHT;
  const successes = typeof input?.cellSuccesses === 'number' && Number.isFinite(input.cellSuccesses) && input.cellSuccesses >= 0
    ? input.cellSuccesses
    : null;
  const uncertainty = 1 / (1 + regionTries);
  const novelty = 1 / (1 + cellTries);
  const bonus = c * Math.sqrt(Math.log(1 + totalTries) / (1 + cellTries));
  // ΝΩ-12：利用项 —— Laplace 后验均值夹 [0,1]（垃圾 successes > tries 不虚发 >1 均值）；
  // 字段缺席 ⇒ 0（零回归：无成功账的格不受罚）
  const exploit = successes === null ? 0 : k * Math.min(1, (successes + 1) / (cellTries + 2));
  const alternation = input?.sameModalityAsLast === true ? EXPLORATION_ALTERNATION_PENALTY : 0;
  return uncertainty + novelty + bonus + exploit - riskCost - negPrior - alternation;
}

// ── W3-7：端口契约（autoPilot 只消费这两个面 + 总闸） ──

/** advise 的全部输入（闭环决策环在升级分支的现场快照） */
export interface ExplorationContext {
  /** 目标原文（账本按目标隔离 —— 逐字段防御） */
  goal: string;
  /** 当前世界快照（候选元素的来源；null ⇒ 无元素候选，只剩全局轮换候选） */
  snapshot: WorldSnapshot | null;
  /** 行动史（恢复态判据：尾部连续失败游程） */
  history: ReadonlyArray<{ action: PolicyAction; outcome: StepOutcome }>;
  /** 升级理由（policy 的 payload.reason；'budget-low' 绝不探索） */
  escalateReason?: string;
}

/** 一次探索建议：替换升级步的世界动作 + 入账 journal 的注记 */
export interface ExplorationAdvice {
  action: PolicyAction;
  note: string;
}

/**
 * W3-7：探索前沿策略端口（结构性契约，与 PolicyPort/ProphecyPort 同律）。
 * 闭环只消费 advise（恢复分支问路）与 observe（步落账回报）两面 + enabled 总闸；
 * 缺席或 enabled !== true ⇒ 闭环整段零执行（与接线前逐字节同路径 —— 开关默认
 * off，零回归红律）。真实账本 ExplorationLedger 天然满足，测试桩实现同名方法即可。
 */
export interface ExplorationPort {
  /** 总闸：闭环仅在 enabled === true 时消费；缺省视为 false（缺省关闭） */
  enabled?: boolean;
  /** 恢复态问路：null = 无建议（照旧升级路径）。绝不抛。 */
  advise(ctx: ExplorationContext): ExplorationAdvice | null;
  /** 步落账回报（记每格尝试与成败）；viewport 供无 payload 标注的动作量化。绝不抛。 */
  observe(
    action: PolicyAction,
    outcome: StepOutcome,
    viewport?: { width: number; height: number },
  ): void;
}

// ── W3-7：内部记账结构 ──

/** 探索账的一格：(区域 × 模态 × 策略) 的 Beta 风格计数 */
export interface ExplorationCell {
  region: number;
  modality: ExplorationModality;
  strategy: string;
  tries: number;
  successes: number;
  lru: number; // LRU 驱逐的时钟序（快照面剔除）
}

/** W3-7：动作种类 → 模态（观察族/元动作不入账：declare/escalate/wait/ask_vlm/recall_skill） */
export function modalityOfKind(kind: unknown): ExplorationModality | null {
  if (typeof kind !== 'string') return null;
  return (EXPLORATION_MODALITIES as readonly string[]).includes(kind) ? (kind as ExplorationModality) : null;
}

/** 标签归一（策略签名用）：小写 + 空白折叠 + 截 24 */
export function normLabel(label: unknown): string {
  if (typeof label !== 'string') return '';
  return label.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 24);
}

/** W3-7：动作的策略签名（稳定字符串 —— 同一格的跨步对账键） */
export function strategyOf(modality: ExplorationModality, region: number, action: PolicyAction): string {
  const a = (action ?? {}) as Partial<PolicyAction>;
  const payload = a.payload && typeof a.payload === 'object' ? (a.payload as Record<string, unknown>) : null;
  let sig: string;
  switch (modality) {
    case 'click': {
      const label = normLabel(a.target?.label);
      sig = `click#${region}#${label}`;
      break;
    }
    case 'scroll': {
      const dir = payload?.direction;
      sig = `scroll#${typeof dir === 'string' && dir !== '' ? dir.toLowerCase() : 'down'}`;
      break;
    }
    case 'hotkey': {
      const keys = Array.isArray(payload?.keys)
        ? (payload.keys as unknown[]).filter(k => typeof k === 'string').join('+')
        : '';
      sig = `hotkey#${keys}`;
      break;
    }
    default:
      sig = `${modality}#${region}`;
  }
  return sig.length > STRATEGY_MAX ? sig.slice(0, STRATEGY_MAX) : sig;
}

export const cellKey = (region: number, modality: string, strategy: string): string =>
  `${region}\u001f${modality}\u001f${strategy}`;

// ── ΑΩ-R22：容量驱逐索引（懒最小堆 —— evictOverflow 逐格全扫 O(n)/次的清偿）──

/** ΑΩ-R22：驱逐索引目 —— 账本键 × 其 LRU 时钟序的配对（弹出侧双元校验的凭据） */
export interface EvictIndexEntry {
  lru: number;
  key: string;
}

/** ΑΩ-R22：懒最小堆全序 —— lru 升序，并列按 key 字典序（确定性；tick 严格递增
 *  ⇒ 在册格 lru 两两互异，key 破平仅为堆内序的形式保证） */
const evictEntryBefore = (a: EvictIndexEntry, b: EvictIndexEntry): boolean =>
  a.lru < b.lru || (a.lru === b.lru && a.key < b.key);

/**
 * ΑΩ-R22：驱逐索引下压（二叉最小堆 sift-up，原地 O(log n)）。
 * 懒失效协议：格新建/更新只追加目（旧目不删）；弹出侧以 (key,lru) 双元校验
 * —— cells 无该键或 lru 不一致 ⇒ 陈旧目，弃之续弹。纯函数绝不抛。
 */
export function evictIndexPush(heap: EvictIndexEntry[], lru: number, key: string): void {
  heap.push({ lru, key });
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (!evictEntryBefore(heap[i], heap[parent])) break;
    const swap = heap[i];
    heap[i] = heap[parent];
    heap[parent] = swap;
    i = parent;
  }
}

/**
 * ΑΩ-R22：驱逐索引弹出堆顶（sift-down，原地 O(log n)；空堆 ⇒ null）。
 * 调用方负责双元校验：返回目未必有效（可能陈旧）—— 无效即弃、续弹。
 */
export function evictIndexPopMin(heap: EvictIndexEntry[]): EvictIndexEntry | null {
  if (heap.length === 0) return null;
  const min = heap[0];
  const last = heap.pop();
  if (last !== undefined && heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < heap.length && evictEntryBefore(heap[left], heap[smallest])) smallest = left;
      if (right < heap.length && evictEntryBefore(heap[right], heap[smallest])) smallest = right;
      if (smallest === i) break;
      const swap = heap[i];
      heap[i] = heap[smallest];
      heap[smallest] = swap;
      i = smallest;
    }
  }
  return min;
}

/**
 * ΑΩ-R22：驱逐索引原地堆化（Floyd 自底向上 O(n)）—— 整体重建共用
 * （restore 恢复路径与降级自愈 / 陈旧目压实）。
 */
export function evictIndexHeapify(entries: EvictIndexEntry[]): void {
  for (let i = (entries.length >> 1) - 1; i >= 0; i--) {
    let root = i;
    for (;;) {
      const left = 2 * root + 1;
      const right = left + 1;
      let smallest = root;
      if (left < entries.length && evictEntryBefore(entries[left], entries[smallest])) smallest = left;
      if (right < entries.length && evictEntryBefore(entries[right], entries[smallest])) smallest = right;
      if (smallest === root) break;
      const swap = entries[root];
      entries[root] = entries[smallest];
      entries[smallest] = swap;
      root = smallest;
    }
  }
}

/** 候选（advise 的择路面）：预铸动作 + 三元组 + riskGate 扫描文本 */
export interface ExplorationCandidate {
  region: number;
  modality: ExplorationModality;
  strategy: string;
  riskText: string; // riskGate 词表扫描面（'' = 全局轮换候选，无标签可扫）
  action: PolicyAction;
}

/**
 * 候选生成（确定性序）：快照元素（interactive !== false，前 64 个）各铸一个
 * click 候选（区域 = 中心落格），随后全局轮换候选（scroll down / scroll up /
 * hotkey tab —— 区域 = 视口中心格）。
 * ΠΑΝ-61（探索步证据申报）：click 候选的 riskTier 不再一律自报 benign —— 按
 * label 词法证据申报（危险词 ⇒ destructive〔宪法硬法恒审批〕/ 凭据风险词 ⇒
 * sensitive / 干净 ⇒ benign），并对**无标签的未名元素**携带未知性标注
 * （payload.exploration.unknown: true —— 闭环 ④ 相位转宪法 backgroundRisk
 * 审计留痕）。「对未知元素的点击自我申报无害」违背诚实申报宪法的旧律就此
 * 废止；全局轮换候选（scroll/hotkey tab）无可点词面，保持 benign。
 * W6-1：原 ExplorationLedger 私有方法 buildCandidates（零 this 引用）逐字节
 * 搬运为自由函数 —— 行为零变化（ΠΑΝ-61 的申报面变更除外，见上）。
 */
export function explorationEvidenceTier(label: string): 'benign' | 'sensitive' | 'destructive' {
  try {
    if (typeof label !== 'string' || label === '') return 'benign';
    // 词表与 riskGate 缺省不可逆/凭据表同源（'' ⇒ 缺省词表 —— 与
    // explorationRiskCostOf 同律），归一化匹配在 riskGate 内完成。
    if (matchesDangerPatterns(label, '')) return 'destructive';
    if (matchesRiskPatterns(label, '')) return 'sensitive';
    return 'benign';
  } catch {
    return 'benign'; // 词法分层失败 = 无词法证据（旧律兜底）
  }
}

export function buildExplorationCandidates(
  snapshot: WorldSnapshot | null | undefined,
  viewport: { width: number; height: number },
): ExplorationCandidate[] {
  const out: ExplorationCandidate[] = [];
  const s = (snapshot ?? {}) as Partial<WorldSnapshot>;
  const elements: SnapshotElement[] = Array.isArray(s.elements) ? s.elements : [];
  for (const el of elements.slice(0, EXPLORATION_ELEMENT_CAP)) {
    if (el === null || el === undefined || el.interactive === false) continue;
    const region = quantizePoint(el?.center, viewport);
    if (region < 0) continue;
    const label = typeof el?.label === 'string' ? el.label : '';
    const strategy = `click#${region}#${normLabel(label)}`;
    out.push({
      region,
      modality: 'click',
      strategy,
      riskText: label,
      action: {
        kind: 'click',
        target: {
          bbox: {
            x0: typeof el.bbox?.x0 === 'number' && Number.isFinite(el.bbox.x0) ? el.bbox.x0 : 0,
            y0: typeof el.bbox?.y0 === 'number' && Number.isFinite(el.bbox.y0) ? el.bbox.y0 : 0,
            x1: typeof el.bbox?.x1 === 'number' && Number.isFinite(el.bbox.x1) ? el.bbox.x1 : 0,
            y1: typeof el.bbox?.y1 === 'number' && Number.isFinite(el.bbox.y1) ? el.bbox.y1 : 0,
          },
          center: {
            x: typeof el.center?.x === 'number' && Number.isFinite(el.center.x) ? el.center.x : 0,
            y: typeof el.center?.y === 'number' && Number.isFinite(el.center.y) ? el.center.y : 0,
          },
          label,
        },
        payload: {
          exploration: {
            region, modality: 'click', strategy,
            // ΠΑΝ-61：未名元素的未知性标注（label 词面缺席 ⇒ 语义未知 —— 交宪法
            // backgroundRisk 审计留痕，认识论闸门与审计面可见）
            ...(label === '' ? { unknown: true } : {}),
          },
        },
        rationale: `W3-7 探索：${regionLabel(region)}探索度最低，以 click 探测元素「${label || '未名元素'}」`,
        expectedEffect: `「${label || '未名元素'}」被激活，${regionLabel(region)}产生新的世界证据`,
        utility: 0.45,
        // ΠΑΝ-61：证据申报 —— label 词法分层（危险 ⇒ destructive / 凭据 ⇒
        // sensitive / 干净或未名 ⇒ benign），不再一律自报 benign
        riskTier: explorationEvidenceTier(label),
      },
    });
  }
  // 全局轮换候选（交替律的供给侧 —— 无元素可点时仍有模态可换）
  const centerRegion = quantizePoint(
    { x: viewport.width / 2, y: viewport.height / 2 },
    viewport,
  );
  const globals: Array<{ modality: ExplorationModality; strategy: string; build: () => PolicyAction }> = [
    {
      modality: 'scroll',
      strategy: 'scroll#down',
      build: () => ({
        kind: 'scroll',
        payload: { direction: 'down', exploration: { region: centerRegion, modality: 'scroll', strategy: 'scroll#down' } },
        rationale: 'W3-7 探索：模态轮换至 scroll，向下滚动暴露未见内容',
        expectedEffect: '视口下移，新的屏幕区域进入感知',
        utility: 0.4,
        riskTier: 'benign',
      }),
    },
    {
      modality: 'scroll',
      strategy: 'scroll#up',
      build: () => ({
        kind: 'scroll',
        payload: { direction: 'up', exploration: { region: centerRegion, modality: 'scroll', strategy: 'scroll#up' } },
        rationale: 'W3-7 探索：模态轮换至 scroll，向上滚动回看已越过的内容',
        expectedEffect: '视口上移，上方的屏幕区域重新进入感知',
        utility: 0.4,
        riskTier: 'benign',
      }),
    },
    {
      modality: 'hotkey',
      strategy: 'hotkey#tab',
      build: () => ({
        kind: 'hotkey',
        payload: { keys: ['tab'], exploration: { region: centerRegion, modality: 'hotkey', strategy: 'hotkey#tab' } },
        rationale: 'W3-7 探索：模态轮换至 hotkey，Tab 周游焦点寻找可达路径',
        expectedEffect: '焦点移至下一可交互元素，键盘通路被探测',
        utility: 0.35,
        riskTier: 'benign',
      }),
    },
  ];
  for (const g of globals) {
    out.push({
      region: centerRegion,
      modality: g.modality,
      strategy: g.strategy,
      riskText: '',
      action: g.build(),
    });
  }
  return out;
}

/** riskGate 代价（只读调用）：不可逆词 0.6 / 凭据词 0.3 / 无 0
 *  W6-1：原 ExplorationLedger 私有方法 riskCostOf（零 this 引用）逐字节搬运为
 *  自由函数 —— 行为零变化。 */
export function explorationRiskCostOf(text: string): number {
  try {
    if (typeof text !== 'string' || text === '') return 0;
    if (matchesDangerPatterns(text, '')) return EXPLORATION_RISK_COST_DANGER;
    if (matchesRiskPatterns(text, '')) return EXPLORATION_RISK_COST_SENSITIVE;
    return 0;
  } catch {
    return 0;
  }
}
