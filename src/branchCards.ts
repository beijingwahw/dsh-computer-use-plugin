// src/branchCards.ts
// W3-6（H3 反事实岔路卡 · Ghost Replay 纠偏）：失败之后，「如果当时走了另一条
// 路」不该是一句空话 —— 本模块把它铸成可一键执行的岔路卡。
//
// 既有事实：counterfactual（Φ-9）每步都对候选集做了完整的效用预演，但择优后
// 即弃全部落选者 —— 「当时第二好的路」这个最贵的反事实信息被白白扔掉。本
// 模块把它落账、铸卡、供一键换支重放：
//
//   ① 岔路账（BranchLedgerBook）：每步决策后按 Top-3 落盘（含预测效用、动作
//      形状、关键参数），有界环形缓冲只保最近 capacity 步 —— 内存账随
//      checkpoint 第六段 branchLedger 持久化（见 checkpoint.ts W3-6 注记）。
//   ② 岔路卡（generateBranchCard）：goal 进入 failed/aborted 终局相时自动取
//      失败前最近的可岔步铸卡 —— 三候选各附诚实预测效用 + 该步失败归因
//      （只读消费 diagnosis 的 R1 根因报告与 W2-5 恢复梯）+ 支点引用
//      （checkpoint 步账位置：journal 条数 + 链尖）。卡片结构化、可序列化。
//   ③ 换支重放（applyBranchChoice + BranchReplayController）：用户 steer(k)
//      一键选第 k 候选 —— 支点防御校验（锚不匹配/账无支点 ⇒ 诚实拒绝）后，
//      经 counterfactual 的 ScoringContext.preferredActionKeys 注入缝铸「改选
//      偏置」（偏置只改选择不改预测）；重放有步数预算，超支诚实终止。
//
// 防御律（与库内记忆系统同律）：无账 ⇒ 卡片缺席（诚实降级，不伪造岔路）；
// 垃圾账 ⇒ 归零；坏步 ⇒ 弃置保好；一切脏输入卫兵式收敛，公开面绝不抛异常。
// 纪律：纯内存 + 纯函数（checkpoint 采集面除外），全离线可测；时钟可注入。
import { rankTopK, actionSignature, DEFAULT_TOP_K, type ScoringContext } from './autonomy/counterfactual';
import type { PolicyAction } from './autonomy/policyEngine';
import {
  parseRootCause,
  recoveryLadderFor,
  type RootCauseReport,
  type RootCauseId,
  type RecoveryActionId,
} from './diagnosis';

// ─── W3-6：常量（值即边界） ───

/** 岔路账环形容量（步）：只保最近 8 步的岔路 —— 支点价值随距离衰减，无界
 *  落账会让快照膨胀且失败归因远离失败点；8 步覆盖典型 goal 预算（24 步）的
 *  尾窗，失败后取「最近的可岔步」永远有账可取。 */
export const BRANCH_LEDGER_CAPACITY = 8;
/** 换支重放步数预算：重放是从支点的「第二尝试」，不得继承原路的全额预算
 *  （否则一次失败 × 三条岔路 = 四倍步数税）；12 步 ≈ 原预算半额。 */
export const BRANCH_REPLAY_BUDGET_STEPS = 12;
/** 岔路账段内版本钉（W3-6）：checkpoint 主体版本沿 W2-1 原地扩展律保持 4，
 *  段结构自带版本 —— 段内演化只升此钉，不撕裂 checkpoint 主契约。 */
export const BRANCH_LEDGER_SEGMENT_VERSION = 1;

// ─── W3-6：岔路账类型 ───

/** 一名候选的岔路账面：动作形状 + 关键参数 + 诚实预测效用（未含偏置） */
export interface BranchCandidateRecord {
  /** 名次（1 起；1 = 当步实际采纳的候选 —— 与 scoreOptions 择优同律） */
  rank: number;
  /** 动作签名（kind:归一 label —— 偏置注入缝的匹配键） */
  signature: string;
  /** 完整动作（形状 + 关键参数；可序列化） */
  action: PolicyAction;
  /** 从世界快照推导的预期效果清单（中文一句一条） */
  predictedEffects: string[];
  progressProbability: number;
  informationGain: number;
  risk: number;
  /** 诚实预测效用（rankTopK.utility —— 未含改选偏置，效用账面） */
  utility: number;
  /** 记账时是否被改选偏置命中（重放期间再记账的审计标记） */
  steered: boolean;
  /** 是否为当步实际采纳的候选（rank === 1） */
  wasChosen: boolean;
}

/** 一步决策的岔路账：Top-K 候选 + 支点引用（checkpoint 步账位置） */
export interface BranchStepRecord {
  /** goal 步账位置（决策步号） */
  stepIndex: number;
  /** 记账时刻（注入时钟） */
  recordedAt: number;
  /** 支点引用：checkpoint 步账位置（journal 条数 + 行动日志链尖）—— 换支
   *  重放前的防御校验锚（世界漂移 ⇒ 拒绝换支，见 applyBranchChoice） */
  anchor: { journalLength: number; chainTip: string };
  /** Top-K 候选（按名次升序，恒非空） */
  candidates: BranchCandidateRecord[];
}

/** 岔路账持久化快照（checkpoint 第六段的载荷面） */
export interface BranchLedgerSnapshot {
  /** 段内版本钉（W3-6） */
  version: number;
  /** 环形容量（恢复时以实例容量为准 —— 档内容量只作记录，不可信） */
  capacity: number;
  /** 步账（时间/步号升序，长度 ≤ capacity） */
  entries: BranchStepRecord[];
}

// ─── W3-6：内部防御工具（零异常） ───

/** 非负整数卫兵：有限数 ⇒ floor 且夹 ≥0；否则缺省 */
export function idxOr(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : d;
}

/** 注入时钟安全读取：抛错/非有限数 ⇒ 0 */
export function safeNow(now: () => number): number {
  try {
    const t = now();
    return typeof t === 'number' && Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

/** JSON 深拷贝（防御：不可序列化载荷 ⇒ 原样透传，绝不抛） */
export function cloneJson<T>(v: T): T {
  try {
    return JSON.parse(JSON.stringify(v)) as T;
  } catch {
    return v;
  }
}

/** 记账元信息：步号 + 支点锚（全可缺席 —— 防御缺省） */
export interface BranchStepMeta {
  /** goal 步账位置；缺省 = 账内步数 + 1 */
  stepIndex?: number;
  /** 支点锚：journal 条数（checkpoint 步账位置） */
  journalLength?: number;
  /** 支点锚：行动日志链尖 */
  chainTip?: string;
}

// ─── W3-6：岔路账本体（有界环形缓冲） ───

/**
 * 岔路账：每步决策后的 Top-K 候选环形账（内存账 + dump/restore 持久化面）。
 *
 * record(options, ctx, meta)：调 counterfactual.rankTopK（与当步 scoreOptions
 * 同一评分内核 —— 账面即决策面）取 Top-3 落账；空候选/全脏 ⇒ null 不伪造。
 * 超容量 ⇒ 淘汰最旧步（环形有界，账永不膨胀）。
 *
 * restore（防御性恢复，入参 = **段对象**（BranchLedgerSnapshot 形状，含
 * entries 数组的对象）；条目数组/字符串/其它垃圾 ⇒ 归零）：整段垃圾 ⇒ 归零；
 * 坏步 ⇒ 弃置保好；好步按步号升序排稳后截实例容量。dump 恒出深拷贝（账面
 * 与调用方解耦）。
 */
export class BranchLedgerBook {
  private _entries: BranchStepRecord[] = [];
  private readonly _capacity: number;
  private readonly _now: () => number;

  constructor(opts: { capacity?: number; now?: () => number } = {}) {
    this._capacity =
      typeof opts.capacity === 'number' && Number.isFinite(opts.capacity)
        ? Math.max(1, Math.floor(opts.capacity))
        : BRANCH_LEDGER_CAPACITY;
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  }

  /** 每步决策后落账（返回入账记录的深拷贝；空候选集 ⇒ null） */
  record(options: PolicyAction[], ctx: ScoringContext, meta: BranchStepMeta = {}): BranchStepRecord | null {
    const ranked = rankTopK(options, ctx, DEFAULT_TOP_K);
    if (ranked === null || ranked.length === 0) return null; // 空候选不伪造岔路
    const rec: BranchStepRecord = {
      stepIndex: idxOr(meta.stepIndex, this._entries.length + 1),
      recordedAt: safeNow(this._now),
      anchor: {
        journalLength: idxOr(meta.journalLength, 0),
        chainTip: typeof meta.chainTip === 'string' ? meta.chainTip : '',
      },
      candidates: ranked.map(r => ({
        rank: r.rank,
        signature: actionSignature(r.option.action),
        action: cloneJson(r.option.action),
        predictedEffects: r.option.predictedEffects.map(e => (typeof e === 'string' ? e : String(e))),
        progressProbability: r.option.progressProbability,
        informationGain: r.option.informationGain,
        risk: r.option.risk,
        utility: r.utility,
        steered: r.steered,
        wasChosen: r.rank === 1,
      })),
    };
    this._entries.push(rec);
    while (this._entries.length > this._capacity) this._entries.shift(); // 环形有界
    return cloneJson(rec);
  }

  /** 当前步数（≤ 容量） */
  get size(): number {
    return this._entries.length;
  }

  /** 最近一步（无账 ⇒ null） */
  latest(): BranchStepRecord | null {
    return this._entries.length > 0 ? cloneJson(this._entries[this._entries.length - 1]) : null;
  }

  /** 持久化面：深拷贝快照（checkpoint 第六段的采集载荷） */
  dump(): BranchLedgerSnapshot {
    return {
      version: BRANCH_LEDGER_SEGMENT_VERSION,
      capacity: this._capacity,
      entries: this._entries.map(cloneJson),
    };
  }

  /** 防御性恢复：整段垃圾 ⇒ 归零；坏步弃置保好；好步截实例容量 */
  restore(raw: unknown): { kept: number; dropped: number } {
    this._entries = [];
    if (!raw || typeof raw !== 'object') return { kept: 0, dropped: 0 };
    const r = raw as { entries?: unknown };
    if (!Array.isArray(r.entries)) return { kept: 0, dropped: 0 };
    let dropped = 0;
    const parsed: BranchStepRecord[] = [];
    for (const e of r.entries) {
      const rec = parseStepRecord(e);
      if (rec === null) {
        dropped++;
        continue;
      }
      parsed.push(rec);
    }
    parsed.sort((a, b) => a.stepIndex - b.stepIndex || a.recordedAt - b.recordedAt);
    this._entries = parsed.slice(-this._capacity); // 实例容量执法（档内容量不可信）
    return { kept: this._entries.length, dropped };
  }

  /** 测试隔离 / 卸载面：账面归零 */
  reset(): void {
    this._entries = [];
  }
}

/** 岔路账单步的防御解析：结构坏 ⇒ null（弃置）；字段脏 ⇒ 逐项收敛 */
export function parseStepRecord(e: unknown): BranchStepRecord | null {
  if (!e || typeof e !== 'object') return null;
  const r = e as Record<string, unknown>;
  if (typeof r.stepIndex !== 'number' || !Number.isFinite(r.stepIndex) || r.stepIndex < 0) return null;
  if (!Array.isArray(r.candidates) || r.candidates.length === 0) return null;
  const candidates: BranchCandidateRecord[] = [];
  for (const c of r.candidates) {
    if (!c || typeof c !== 'object') continue;
    const cr = c as Record<string, unknown>;
    if (!cr.action || typeof cr.action !== 'object') continue;
    if (typeof cr.signature !== 'string' || cr.signature === '') continue;
    candidates.push({
      rank: idxOr(cr.rank, candidates.length + 1),
      signature: cr.signature,
      action: cloneJson(cr.action) as PolicyAction,
      predictedEffects: Array.isArray(cr.predictedEffects)
        ? (cr.predictedEffects.filter(p => typeof p === 'string') as string[])
        : [],
      progressProbability: typeof cr.progressProbability === 'number' && Number.isFinite(cr.progressProbability)
        ? Math.min(1, Math.max(0, cr.progressProbability))
        : 0,
      informationGain: typeof cr.informationGain === 'number' && Number.isFinite(cr.informationGain)
        ? Math.min(1, Math.max(0, cr.informationGain))
        : 0,
      risk: typeof cr.risk === 'number' && Number.isFinite(cr.risk) ? Math.min(1, Math.max(0, cr.risk)) : 0,
      utility: typeof cr.utility === 'number' && Number.isFinite(cr.utility) ? cr.utility : 0,
      steered: cr.steered === true,
      wasChosen: cr.wasChosen === true,
    });
  }
  if (candidates.length === 0) return null; // 无任何合法候选 ⇒ 该步整体弃置
  const a = (r.anchor ?? {}) as Record<string, unknown>;
  return {
    stepIndex: Math.floor(r.stepIndex as number),
    recordedAt: idxOr(r.recordedAt, 0),
    anchor: { journalLength: idxOr(a.journalLength, 0), chainTip: typeof a.chainTip === 'string' ? a.chainTip : '' },
    candidates,
  };
}

/** 岔路账采集面单例 —— checkpoint collect 的接线对象（组合根可换注入实例） */
export const branchLedger = new BranchLedgerBook();

// W6-2（doctor smell.over-engineering 清偿）：岔路卡 + 换支重放已分区提取至
// branchCards.card.ts（行为零变化）；导入面不变 —— export * 再分发。
export * from './branchCards.card';

