// src/autonomy/exploration.ts
// ─── W3-7（R2 探索前沿策略 · UCB 择路）：已探索集 + UCB 探索账 + 独立原子持久化 ───
//
// 问题：闭环的策略序（判据匹配 → 文本宣称 → 僵局切换 → 技能 → 升级）是纯开发
// 式的 —— 它只在「已知路」里择优，从不为「还没试过的路」付学费。当所有已知路
// 失败（policy 交出 no-deterministic-action 的 escalate），闭环只剩升级移交一条
// 途。本模块给恢复态补一条途：按 (元素区域 × 模态 × 策略) 三元组维护已探索集
// 位图，用 UCB（Upper Confidence Bound）前沿分数择路：
//
//   score = 区域未探测不确定度 + 新颖度 + c·√(ln N / n_i)
//           − riskGate 代价 − failureMemory 负先验降权 − 同模态连打惩罚
//
//   区域    elementTracker 框量化网格（只读消费其 TrackedRect 方言 —— 类型级
//           引用，零运行时耦合）：元素中心落格，12×8 网格覆盖整屏；
//   模态    click / type / hotkey / scroll / drag / inspect（世界动作六族）；
//   策略    具体动作签名（模态 + 区域 + 参数摘要 —— 稳定字符串，跨步可对账）；
//   探索账  每格 Beta 风格计数（tries / successes），区域另有聚合尝试账。
//
// 设计立场（与 recoveryEfficacy 同律）：**确定性**。无 RNG —— 同账本同输入同
// 建议，可审计可回放；并列按候选输入序破平（稳定全序）。探索项是 UCB1 的
// 确定性折算（择 argmax 而非采样），处方可解释。
//
// 消费纪律（铁律）：
//   · 一切公开入口绝不抛 —— 建议失败的成本是「返回 null / 少记一笔账」，
//     绝不是异常穿越调用方（闭环绝不因探索旁路炸环）；
//   · 只在恢复态出手（所有已知路失败 / 尾部连续失败 ≥2），常态零触发；
//   · 预算红线（budget-low）与内部异常升级绝不探索 —— 绝不透支收手保护；
//   · 建议动作一律 benign 分层（探索是低风险增益，敏感/破坏性动作不属探索）；
//   · riskGate / failureMemory 只读消费（纯查询，绝不写它们的账）。
//
// 持久化：独立文件原子落盘（tmp + fsync + rename，recoveryEfficacy 同律），
// **不碰 checkpoint.ts**；防御恢复逐格校验，垃圾格弃置不连坐整档。会话边界
// 归零或恢复可配（beginSession('reset' | 'restore')）。
import {
  existsSync, readFileSync, openSync, writeSync, fsyncSync, closeSync,
  renameSync, mkdirSync, unlinkSync,
} from 'fs';
import path from 'path';
import type { PolicyAction, StepOutcome } from './policyEngine';
import type { WorldSnapshot, SnapshotElement } from './worldSnapshot';
// W3-7：elementTracker 只读消费 —— 类型级引用其框方言（TrackedRect），零运行时
// 耦合（跟踪器内部轨道绝不因探索账被动过）。
import type { TrackedRect } from '../elementTracker';
// W3-7：负先验只读查询（match 不写账）；riskGate 纯函数只读调用。
import { failureMemory } from '../failureMemory';
import { matchesDangerPatterns, matchesRiskPatterns } from '../riskGate';
import { kernelRegistry } from '../kernel/registry';

// ── W3-7：常量（值即边界）──

/** 量化网格横向格数（区域轴粒度：12 列 × 8 行 = 96 格覆盖整屏） */
export const EXPLORATION_GRID_COLS = 12;
/** 量化网格纵向格数 */
export const EXPLORATION_GRID_ROWS = 8;
/** UCB 探索项系数 c（c·√(ln N / n_i)）—— 模块常量，经内核键 exploration.ucbC 可调 */
export const EXPLORATION_UCB_C = 0.7;
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
const EXPLORATION_NEG_PRIOR_K = 3;
/** 候选元素上限（每步 advise 的有界扫描面） */
const EXPLORATION_ELEMENT_CAP = 64;
/** 探索账容量上限（LRU 驱逐 —— 目标 × 区域 × 模态 × 策略组合爆炸的有界承诺） */
const EXPLORATION_MAX_CELLS_DEFAULT = 4096;
/** 单侧计数的合法上限（防御恢复：垃圾巨值不淹没后验） */
const EXPLORATION_MAX_COUNT = 1_000_000;
/** 持久化格式版本 */
const EXPLORATION_VERSION = 1;
/** 视口缺省（快照无宽高时的量化回退 —— 1920×1080 主流桌面） */
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 } as const;
/** 策略签名长度上限（账本键的带宽礼仪） */
const STRATEGY_MAX = 120;

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
}

/**
 * W3-7：UCB 前沿分数（纯函数、确定性、绝不抛；负输入按 0 收敛）：
 *
 *   score = 1/(1+regionTries)            区域未探测不确定度（全新区域 ⇒ 1）
 *         + 1/(1+cellTries)              新颖度（从未试过的格 ⇒ 1）
 *         + c·√(ln(1+N)/(1+n_i))         UCB 探索项（欠采样加成；N=0 ⇒ 0）
 *         − riskCost                     riskGate 代价（只读）
 *         − negativePriorPenalty         负先验降权（只读）
 *         − sameModalityAsLast ? 0.25 : 0  交替律（防同模态连打）
 *
 * 分母一律 +1（n_i=0 / N=0 的除零免疫）；对数取 ln(1+N)（N=0 ⇒ 0 —— 空账
 * 不虚发探索加成，新颖度与不确定度两项已是满额）。
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
  const uncertainty = 1 / (1 + regionTries);
  const novelty = 1 / (1 + cellTries);
  const bonus = c * Math.sqrt(Math.log(1 + totalTries) / (1 + cellTries));
  const alternation = input?.sameModalityAsLast === true ? EXPLORATION_ALTERNATION_PENALTY : 0;
  return uncertainty + novelty + bonus - riskCost - negPrior - alternation;
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
interface ExplorationCell {
  region: number;
  modality: ExplorationModality;
  strategy: string;
  tries: number;
  successes: number;
  lru: number; // LRU 驱逐的时钟序（快照面剔除）
}

/** W3-7：动作种类 → 模态（观察族/元动作不入账：declare/escalate/wait/ask_vlm/recall_skill） */
function modalityOfKind(kind: unknown): ExplorationModality | null {
  if (typeof kind !== 'string') return null;
  return (EXPLORATION_MODALITIES as readonly string[]).includes(kind) ? (kind as ExplorationModality) : null;
}

/** 标签归一（策略签名用）：小写 + 空白折叠 + 截 24 */
function normLabel(label: unknown): string {
  if (typeof label !== 'string') return '';
  return label.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 24);
}

/** W3-7：动作的策略签名（稳定字符串 —— 同一格的跨步对账键） */
function strategyOf(modality: ExplorationModality, region: number, action: PolicyAction): string {
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

const cellKey = (region: number, modality: string, strategy: string): string =>
  `${region}\u001f${modality}\u001f${strategy}`;

/** 候选（advise 的择路面）：预铸动作 + 三元组 + riskGate 扫描文本 */
interface ExplorationCandidate {
  region: number;
  modality: ExplorationModality;
  strategy: string;
  riskText: string; // riskGate 词表扫描面（'' = 全局轮换候选，无标签可扫）
  action: PolicyAction;
}

// ── W3-7：探索账本 ──

/**
 * W3-7（R2）：探索前沿账本 —— 已探索集 + UCB 择路 + 独立原子持久化。
 * 按目标隔离（一目标一账本）；一切公开方法绝不抛（防御纪律）；确定性择路
 * （argmax + 稳定并列序，无 RNG）。构造缺省关闭（enabled:false —— 缺省关闭
 * 红律：点亮是集成接线的显式决定）。
 */
export class ExplorationLedger implements ExplorationPort {
  enabled?: boolean;
  private readonly goal: string;
  private readonly maxAdvisesPerRun: number;
  private readonly maxCells: number;
  private cells = new Map<string, ExplorationCell>();
  private regionTries = new Map<number, number>();
  private totalTries = 0;
  private lastModality: ExplorationModality | null = null;
  private advisesThisRun = 0;
  private persistPath: string | null = null;
  private observesSincePersist = 0;
  private tick = 0;

  constructor(
    goal: unknown,
    opts: {
      enabled?: boolean;
      maxAdvisesPerRun?: number;
      maxCells?: number;
      persistPath?: string;
    } = {},
  ) {
    this.goal = typeof goal === 'string' ? goal.slice(0, 200) : '';
    this.enabled = opts?.enabled === true; // W3-7：缺省关闭
    this.maxAdvisesPerRun = Number.isFinite(opts?.maxAdvisesPerRun)
      ? Math.min(32, Math.max(1, Math.round(opts.maxAdvisesPerRun as number)))
      : EXPLORATION_MAX_ADVISES_PER_RUN;
    this.maxCells = Number.isFinite(opts?.maxCells)
      ? Math.min(65_536, Math.max(16, Math.round(opts.maxCells as number)))
      : EXPLORATION_MAX_CELLS_DEFAULT;
    if (typeof opts?.persistPath === 'string' && opts.persistPath !== '') {
      this.persistPath = opts.persistPath;
    }
  }

  /**
   * W3-7：恢复态问路（绝不抛）。门序（缺一即 null —— 照旧升级路径）：
   *  ① 总闸：enabled !== true 或内核键 exploration.enabledGate < 1 ⇒ null；
   *  ② 红线：escalateReason 为 budget-low / policy-engine-internal-error ⇒ null
   *     （预算将尽与内部异常是收手时刻，探索绝不透支收手保护）；
   *  ③ 恢复态：escalateReason === 'no-deterministic-action'（所有已知路失败）
   *     或尾部连续失败游程 ≥ 2（熔断后/僵局切换现场）⇒ 才出手（常态零触发）；
   *  ④ 预算：本 run 已发建议数达上限 ⇒ null（第三重停机）；
   *  ⑤ 候选：无可辩护候选（快照无元素且全局轮换候选不成立）⇒ null。
   * 择路：全部候选 UCB 前沿分数 argmax，并列按候选输入序（元素序 → 全局序）
   * —— 稳定全序，同账本同输入同建议。
   */
  advise(ctx: ExplorationContext): ExplorationAdvice | null {
    try {
      // ① 总闸（双闸：实例开关 × 内核键 —— 开启条件由集成/内核键控）
      if (this.enabled !== true) return null;
      if (kernelRegistry.getOrDefault('exploration.enabledGate', 1) < 1) return null;
      const c = (ctx ?? {}) as Partial<ExplorationContext>;
      // ② 红线：收手时刻绝不探索
      const reason = typeof c.escalateReason === 'string' && c.escalateReason !== ''
        ? c.escalateReason
        : '?';
      if (reason === 'budget-low' || reason === 'policy-engine-internal-error') return null;
      // ③ 恢复态判据（常态零触发红律）
      const recovering =
        reason === 'no-deterministic-action' ||
        trailingFailureRun(c.history as ReadonlyArray<{ action?: unknown; outcome?: unknown }>) >= EXPLORATION_RECOVERY_MIN_RUN;
      if (!recovering) return null;
      // ④ 探索预算
      if (this.advisesThisRun >= this.maxAdvisesPerRun) return null;
      // ⑤ 候选生成与择路
      const goal = typeof c.goal === 'string' && c.goal !== '' ? c.goal : this.goal;
      const viewport = this.viewportOf(c.snapshot);
      const candidates = this.buildCandidates(c.snapshot, viewport);
      if (candidates.length === 0) return null;
      const ucbC = kernelRegistry.getOrDefault('exploration.ucbC', EXPLORATION_UCB_C);
      let best: ExplorationCandidate | null = null;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (const cand of candidates) {
        const cell = this.cells.get(cellKey(cand.region, cand.modality, cand.strategy));
        const score = explorationScore({
          regionTries: this.regionTries.get(cand.region) ?? 0,
          cellTries: cell ? cell.tries : 0,
          totalTries: this.totalTries,
          riskCost: this.riskCostOf(cand.riskText),
          negativePriorPenalty: this.negativePriorFor(cand.region, cand.modality, goal),
          sameModalityAsLast: this.lastModality === cand.modality,
          ucbC,
        });
        if (score > bestScore) {
          bestScore = score;
          best = cand;
        }
      }
      if (best === null) return null;
      // 记账：本次建议计入 run 预算；交替律状态前移到建议模态
      this.advisesThisRun++;
      this.lastModality = best.modality;
      const note =
        `W3-7 探索建议：${regionLabel(best.region)}×模态 ${best.modality}（UCB 分 ${Math.round(bestScore * 1000) / 1000}，本 run 第 ${this.advisesThisRun}/${this.maxAdvisesPerRun} 次）`;
      return { action: best.action, note };
    } catch {
      return null; // 绝不抛的字面兑现 —— 探索是恢复增益不是依赖
    }
  }

  /**
   * W3-7：步落账回报 —— 世界动作入探索账（每格尝试与成败的 Beta 计数）。
   * 三元组还原优先级：动作 payload.exploration 标注（advise 铸动作时预标 ——
   * 精确对账）> 现场量化（target.center 或视口中心 + viewport）。观察族/元动作
   * （declare/escalate/wait/ask_vlm/recall_skill）不入账；三元组无法确定 ⇒ 诚实
   * 跳过（不把账记到猜的格子上）。autoPilot 对全动作流回报 —— 账本不只记自己
   * 的建议，策略自选动作同样计入已探索集（探索度是全流的账）。
   */
  observe(
    action: PolicyAction,
    outcome: StepOutcome,
    viewport?: { width: number; height: number },
  ): void {
    try {
      const a = (action ?? {}) as Partial<PolicyAction>;
      const modality = modalityOfKind(a.kind);
      if (modality === null) return;
      // 三元组还原：payload 预标优先，现场量化兜底
      const payload = a.payload && typeof a.payload === 'object' ? (a.payload as Record<string, unknown>) : null;
      const mark = payload?.exploration;
      let region = -1;
      let strategy = '';
      if (mark && typeof mark === 'object' && !Array.isArray(mark)) {
        const m = mark as { region?: unknown; modality?: unknown; strategy?: unknown };
        if (Number.isInteger(m.region) && (m.region as number) >= 0) region = m.region as number;
        if (typeof m.strategy === 'string' && m.strategy !== '') strategy = m.strategy.slice(0, STRATEGY_MAX);
      }
      if (region < 0) {
        region = quantizePoint(a.target?.center, viewport);
        // inspect 族：payload.region（Bbox）中心即落点 —— 聚焦区域就是它的区域
        if (region < 0 && modality === 'inspect' && payload?.region && typeof payload.region === 'object') {
          const b = payload.region as { x0?: unknown; y0?: unknown; x1?: unknown; y1?: unknown };
          const xs = [b.x0, b.x1], ys = [b.y0, b.y1];
          region = quantizePoint(
            xs.every(v => typeof v === 'number' && Number.isFinite(v)) && ys.every(v => typeof v === 'number' && Number.isFinite(v))
              ? { x: ((b.x0 as number) + (b.x1 as number)) / 2, y: ((b.y0 as number) + (b.y1 as number)) / 2 }
              : undefined,
            viewport,
          );
        }
        // 无靶点模态（scroll/hotkey/type）：视口中心格兜底（全局动作的区域语义）
        if (region < 0 && (modality === 'scroll' || modality === 'hotkey' || modality === 'type') && viewport) {
          region = quantizePoint({ x: viewport.width / 2, y: viewport.height / 2 }, viewport);
        }
        if (region < 0) return; // 无法定位 ⇒ 诚实跳过（不把账记到猜的格子上）
      }
      if (strategy === '') strategy = strategyOf(modality, region, action);
      // 入账：格 Beta 计数 + 区域聚合账 + 全账 + 交替律状态
      const key = cellKey(region, modality, strategy);
      const cell = this.cells.get(key) ??
        { region, modality, strategy, tries: 0, successes: 0, lru: 0 };
      cell.tries = Math.min(EXPLORATION_MAX_COUNT, cell.tries + 1);
      if (outcome === 'progress') {
        cell.successes = Math.min(EXPLORATION_MAX_COUNT, cell.successes + 1);
      }
      cell.lru = ++this.tick;
      this.cells.set(key, cell);
      this.regionTries.set(region, Math.min(EXPLORATION_MAX_COUNT, (this.regionTries.get(region) ?? 0) + 1));
      this.totalTries = Math.min(EXPLORATION_MAX_COUNT, this.totalTries + 1);
      this.lastModality = modality;
      this.evictOverflow();
      // 节流落盘：成功或每 8 笔一次（事件级 fsync 太碎 —— recoveryEfficacy 同律）
      this.observesSincePersist++;
      if (this.persistPath !== null && (outcome === 'progress' || this.observesSincePersist >= 8)) {
        this.observesSincePersist = 0;
        this.persist(this.persistPath);
      }
    } catch {
      /* 绝不抛：这一笔没记上就是全部代价 */
    }
  }

  /** W3-7：负先验降权（只读查询 failureMemory ——绝不写它的账）。
   *  查询文本 = 目标 + 模态 + 区域标签；命中按 score2（legacy 加权和 = 词面
   *  重合 + 0.3×压缩相似）加权累计：文本重合越满，降权越重；上限 0.45（软
   *  先验 —— 降权不除名，UCB 其余三项仍可翻案）。任何故障 ⇒ 0。 */
  negativePriorFor(region: number, modality: string, goal?: string): number {
    try {
      const g = typeof goal === 'string' && goal !== '' ? goal : this.goal;
      const query = `${g} ${modality} ${regionLabel(region)}`.trim();
      // 运行时 match 逐记录附加 score2（legacy 加权和），但其返回类型的公开面
      // 只列 score —— 此处按运行时形状收窄（只读消费，绝不写它的账）。
      const hits = failureMemory.match(query, undefined, EXPLORATION_NEG_PRIOR_K) as
        Array<{ score2?: unknown }>;
      let penalty = 0;
      for (const h of hits) {
        const s = typeof h.score2 === 'number' && Number.isFinite(h.score2) && h.score2 > 0 ? h.score2 : 0;
        penalty += EXPLORATION_NEG_PRIOR_UNIT * s;
      }
      return Math.min(EXPLORATION_NEG_PRIOR_CAP, penalty);
    } catch {
      return 0;
    }
  }

  /** 读单格（缺席 ⇒ null —— 调用方以「从未尝试」解读） */
  cellFor(region: number, modality: string, strategy: string): { tries: number; successes: number } | null {
    const c = this.cells.get(cellKey(region, modality, strategy));
    return c ? { tries: c.tries, successes: c.successes } : null;
  }

  /** 区域聚合尝试账（只读） */
  regionTryCount(region: number): number {
    return this.regionTries.get(region) ?? 0;
  }

  /** 全账总尝试数（只读） */
  get totalTryCount(): number {
    return this.totalTries;
  }

  /** 账本快照（审计/metrics 消费面 —— 只读投影，键序确定） */
  snapshot(): {
    goal: string;
    totalTries: number;
    advisesThisRun: number;
    lastModality: string | null;
    cells: Array<{ region: number; modality: ExplorationModality; strategy: string; tries: number; successes: number; posteriorMean: number }>;
    regionTries: Array<{ region: number; tries: number }>;
  } {
    const cells = [...this.cells.values()]
      .sort((a, b) =>
        a.region - b.region ||
        (a.modality < b.modality ? -1 : a.modality > b.modality ? 1 : 0) ||
        (a.strategy < b.strategy ? -1 : a.strategy > b.strategy ? 1 : 0))
      .map(({ lru: _lru, ...c }) => ({
        ...c,
        posteriorMean: Math.round(((c.successes + 1) / (c.tries + 2)) * 1e6) / 1e6,
      }));
    const regionTries = [...this.regionTries.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([region, tries]) => ({ region, tries }));
    return {
      goal: this.goal,
      totalTries: this.totalTries,
      advisesThisRun: this.advisesThisRun,
      lastModality: this.lastModality,
      cells,
      regionTries,
    };
  }

  /**
   * W3-7：原子落盘（recoveryEfficacy / checkpoint 同律：tmp + fsync + rename ——
   * 要么完整旧档，要么完整新档，绝无半档）。独立文件，不碰 checkpoint.ts。
   * 绝不抛：失败 ⇒ {ok:false, error}。
   */
  persist(filePath: string): { ok: boolean; cells?: number; error?: string } {
    try {
      if (typeof filePath !== 'string' || filePath === '') return { ok: false, error: 'no exploration path' };
      const tmp = `${filePath}.tmp`;
      const snap = this.snapshot();
      const payload = {
        version: EXPLORATION_VERSION,
        savedAt: Date.now(),
        goal: this.goal,
        cells: snap.cells.map(({ posteriorMean: _m, ...c }) => c),
        regionTries: snap.regionTries,
        lastModality: this.lastModality,
      };
      mkdirSync(path.dirname(filePath), { recursive: true });
      const fd = openSync(tmp, 'w');
      try {
        writeSync(fd, Buffer.from(JSON.stringify(payload), 'utf8'));
        fsyncSync(fd); // rename 可先于数据块持久化 —— 页缓存不算落盘
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, filePath);
      return { ok: true, cells: this.cells.size };
    } catch (e: unknown) {
      try { unlinkSync(`${filePath}.tmp`); } catch { /* tmp 可能未创建 */ }
      return { ok: false, error: String((e as { message?: unknown })?.message ?? e) };
    }
  }

  /**
   * W3-7：防御性恢复 —— 逐格校验（区域在网格值域 + 模态在闭集 + 签名非空 +
   * 计数为有限非负整数 + 上限夹取），垃圾格弃置计数入 dropped（不连坐整档）。
   * 目标不符（他账）⇒ 拒收整档 —— 按目标隔离的红律。绝不抛。
   */
  restore(filePath: string): { ok: boolean; restored: number; dropped: number; error?: string } {
    try {
      if (typeof filePath !== 'string' || filePath === '' || !existsSync(filePath)) {
        return { ok: false, restored: 0, dropped: 0, error: 'no exploration file' };
      }
      const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, restored: 0, dropped: 0, error: 'exploration file malformed' };
      }
      const file = raw as {
        version?: unknown; goal?: unknown; cells?: unknown; regionTries?: unknown; lastModality?: unknown;
      };
      if (file.version !== EXPLORATION_VERSION) {
        return { ok: false, restored: 0, dropped: 0, error: 'version mismatch' };
      }
      if (typeof file.goal !== 'string' || file.goal !== this.goal) {
        return { ok: false, restored: 0, dropped: 0, error: 'goal mismatch (他目标账本)' };
      }
      if (!Array.isArray(file.cells)) {
        return { ok: false, restored: 0, dropped: 0, error: 'cells malformed' };
      }
      const gridCells = EXPLORATION_GRID_COLS * EXPLORATION_GRID_ROWS;
      const count = (x: unknown): number | null =>
        typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= EXPLORATION_MAX_COUNT
          ? Math.floor(x)
          : null;
      let restored = 0;
      let dropped = 0;
      for (const v of file.cells) {
        if (v === null || typeof v !== 'object' || Array.isArray(v)) { dropped++; continue; }
        const cell = v as { region?: unknown; modality?: unknown; strategy?: unknown; tries?: unknown; successes?: unknown };
        if (!Number.isInteger(cell.region) || (cell.region as number) < 0 || (cell.region as number) >= gridCells) { dropped++; continue; }
        if (typeof cell.modality !== 'string' || !(EXPLORATION_MODALITIES as readonly string[]).includes(cell.modality)) { dropped++; continue; }
        if (typeof cell.strategy !== 'string' || cell.strategy === '') { dropped++; continue; }
        const tries = count(cell.tries);
        const successes = count(cell.successes);
        if (tries === null || successes === null || successes > tries) { dropped++; continue; }
        this.cells.set(
          cellKey(cell.region as number, cell.modality, cell.strategy.slice(0, STRATEGY_MAX)),
          {
            region: cell.region as number,
            modality: cell.modality as ExplorationModality,
            strategy: cell.strategy.slice(0, STRATEGY_MAX),
            tries,
            successes,
            lru: ++this.tick,
          },
        );
        restored++;
      }
      if (Array.isArray(file.regionTries)) {
        for (const v of file.regionTries) {
          if (v === null || typeof v !== 'object' || Array.isArray(v)) continue;
          const entry = v as { region?: unknown; tries?: unknown };
          const tries = count(entry.tries);
          if (!Number.isInteger(entry.region) || (entry.region as number) < 0 || (entry.region as number) >= gridCells || tries === null) continue;
          this.regionTries.set(entry.region as number, tries);
        }
      }
      if (typeof file.lastModality === 'string' && (EXPLORATION_MODALITIES as readonly string[]).includes(file.lastModality)) {
        this.lastModality = file.lastModality as ExplorationModality;
      }
      // W3-7：全账总数不持久化（派生账）—— 恢复时从格子账重演；LRU 驱逐可能
      // 丢格 ⇒ 取格账与区域账两口径的较大者（宁可高估 N 也不低估 —— UCB 的
      // 探索项随 N 单调不减，高估只会收敛探索加成，绝不放大）。
      let cellSum = 0;
      for (const c of this.cells.values()) cellSum += c.tries;
      let regionSum = 0;
      for (const t of this.regionTries.values()) regionSum += t;
      this.totalTries = Math.min(EXPLORATION_MAX_COUNT, Math.max(cellSum, regionSum));
      this.evictOverflow();
      return { ok: true, restored, dropped };
    } catch (e: unknown) {
      return { ok: false, restored: 0, dropped: 0, error: String((e as { message?: unknown })?.message ?? e) };
    }
  }

  /** 配置自动落盘（observe 节流触发；null ⇒ 关闭）。不抛。 */
  setPersistence(filePath: string | null): void {
    this.persistPath = typeof filePath === 'string' && filePath !== '' ? filePath : null;
  }

  /**
   * W3-7：会话边界（归零或恢复，可配）—— 'reset'（缺省）⇒ run 级状态归零
   * （建议预算/交替律状态），细胞账保留在内存（归零的是会话边界态不是知识）；
   * 'restore' ⇒ 先从持久化档恢复账本再归零 run 态（跨会话延续探索记忆）。
   */
  beginSession(mode: 'reset' | 'restore' = 'reset'): void {
    try {
      if (mode === 'restore' && this.persistPath !== null) this.restore(this.persistPath);
      this.advisesThisRun = 0;
      this.lastModality = null;
      this.observesSincePersist = 0;
    } catch { /* 绝不抛 */ }
  }

  /** 生命周期归零（插件卸载 / 测试隔离）—— 回到构造态 */
  reset(): void {
    this.cells.clear();
    this.regionTries.clear();
    this.totalTries = 0;
    this.lastModality = null;
    this.advisesThisRun = 0;
    this.observesSincePersist = 0;
    this.tick = 0;
    this.persistPath = null;
  }

  // ── 内部 ──

  /** 快照的量化视口（缺省 1920×1080 —— 防御回退） */
  private viewportOf(snapshot: WorldSnapshot | null | undefined): { width: number; height: number } {
    const s = (snapshot ?? {}) as Partial<WorldSnapshot>;
    return {
      width: typeof s.width === 'number' && Number.isFinite(s.width) && s.width > 0 ? s.width : DEFAULT_VIEWPORT.width,
      height: typeof s.height === 'number' && Number.isFinite(s.height) && s.height > 0 ? s.height : DEFAULT_VIEWPORT.height,
    };
  }

  /**
   * 候选生成（确定性序）：快照元素（interactive !== false，前 64 个）各铸一个
   * click 候选（区域 = 中心落格），随后全局轮换候选（scroll down / scroll up /
   * hotkey tab —— 区域 = 视口中心格）。建议动作一律 benign（探索是低风险增益）。
   */
  private buildCandidates(
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
          payload: { exploration: { region, modality: 'click', strategy } },
          rationale: `W3-7 探索：${regionLabel(region)}探索度最低，以 click 探测元素「${label || '未名元素'}」`,
          expectedEffect: `「${label || '未名元素'}」被激活，${regionLabel(region)}产生新的世界证据`,
          utility: 0.45,
          riskTier: 'benign',
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

  /** riskGate 代价（只读调用）：不可逆词 0.6 / 凭据词 0.3 / 无 0 */
  private riskCostOf(text: string): number {
    try {
      if (typeof text !== 'string' || text === '') return 0;
      if (matchesDangerPatterns(text, '')) return EXPLORATION_RISK_COST_DANGER;
      if (matchesRiskPatterns(text, '')) return EXPLORATION_RISK_COST_SENSITIVE;
      return 0;
    } catch {
      return 0;
    }
  }

  /** 容量驱逐：超上限 ⇒ 最久未更新格让位（探索账的有界承诺） */
  private evictOverflow(): void {
    while (this.cells.size > this.maxCells) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [k, c] of this.cells) {
        if (c.lru < oldest) { oldest = c.lru; oldestKey = k; }
      }
      if (oldestKey === null) break;
      this.cells.delete(oldestKey);
    }
  }
}
