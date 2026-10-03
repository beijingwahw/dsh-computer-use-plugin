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
function idxOr(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : d;
}

/** 注入时钟安全读取：抛错/非有限数 ⇒ 0 */
function safeNow(now: () => number): number {
  try {
    const t = now();
    return typeof t === 'number' && Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

/** JSON 深拷贝（防御：不可序列化载荷 ⇒ 原样透传，绝不抛） */
function cloneJson<T>(v: T): T {
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
function parseStepRecord(e: unknown): BranchStepRecord | null {
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

// ─── W3-6：岔路卡（失败相触发的结构化纠偏卡） ───

/** 该步失败归因（diagnosis 只读消费的铸形面 —— R1 根因 + W2-5 恢复梯） */
export interface BranchCardAttribution {
  /** R1 鉴别链的首位根因（垃圾 ⇒ 'unknown' —— parseRootCause 律） */
  rootCause: RootCauseId;
  /** 首位根因的细化假设（处方方向；报告缺席 ⇒ ''） */
  hypothesis: string;
  /** W2-5 根因 → 恢复动作先验梯（steer 之后的默认行动序） */
  recoveryLadder: readonly RecoveryActionId[];
  /** 探针链摘要（≤8 条「探针:观察」—— 审计可回放面） */
  probeTrail: string[];
  /** 鉴别探针是否降级（旁路事实如实申报） */
  degraded: boolean;
}

/** 岔路卡：失败终局相 × 最近可岔步 × 三候选 + 归因 + 支点（可序列化） */
export interface BranchCard {
  /** 卡面版本钉（W3-6） */
  cardVersion: number;
  createdAt: number;
  /** 触发相（只有失败终局相铸卡） */
  goalPhase: 'failed' | 'aborted';
  /** goal 判定理由（一句话） */
  goalReason: string;
  /** 支点引用：失败前最近的可岔步（换支重放的恢复点） */
  pivot: {
    stepIndex: number;
    recordedAt: number;
    /** checkpoint 步账位置（journal 条数 + 链尖）—— 防御校验锚 */
    anchor: { journalLength: number; chainTip: string };
  };
  /** 三候选（Top-3；各附效用 + 该步失败归因） */
  candidates: Array<BranchCandidateRecord & { attribution: BranchCardAttribution }>;
}

/** diagnosis 根因报告 → 卡面归因（只读消费 + 防御收敛；报告缺席 ⇒ unknown 兜底） */
function attributionOf(report: unknown): BranchCardAttribution {
  const r = (report && typeof report === 'object' ? report : null) as Partial<RootCauseReport> | null;
  const rootCause = parseRootCause(r?.rootCause); // 垃圾值 ⇒ 'unknown'（diagnosis 律）
  const cands = Array.isArray(r?.candidates) ? (r!.candidates as RootCauseReport['candidates']) : [];
  const cand = cands.find(c => !!c && parseRootCause(c?.rootCause) === rootCause);
  const hypothesis =
    typeof cand?.hypothesis === 'string' && cand.hypothesis !== '' ? cand.hypothesis : '';
  const trail = Array.isArray(r?.trail) ? r!.trail! : [];
  const probeTrail: string[] = [];
  for (const t of trail) {
    if (!t || typeof t !== 'object') continue;
    const step = t as { probe?: unknown; observation?: unknown };
    if (typeof step.probe !== 'string') continue;
    probeTrail.push(`${step.probe}: ${typeof step.observation === 'string' ? step.observation : 'n/a'}`);
    if (probeTrail.length >= 8) break; // 卡面纪律：审计摘要封顶
  }
  return {
    rootCause,
    hypothesis,
    recoveryLadder: recoveryLadderFor(rootCause),
    probeTrail,
    degraded: r?.degraded === true,
  };
}

/** 账面 → 步账列表（book / snapshot 双形态收口，防御脏值） */
function ledgerEntriesOf(ledger: unknown): BranchStepRecord[] {
  if (!ledger) return [];
  if (ledger instanceof BranchLedgerBook) return ledger.dump().entries;
  const snap = ledger as { entries?: unknown };
  return Array.isArray(snap.entries) ? (snap.entries as BranchStepRecord[]) : [];
}

/**
 * 岔路卡生成（纯函数、绝不抛）：
 * goal 进入 failed/aborted 终局相 ⇒ 取失败前最近的可岔步（环形账最后一步），
 * 铸三候选岔路卡 —— 各候选附诚实预测效用 + 该步失败归因（diagnosis 只读）
 * + 卡级支点引用（checkpoint 步账位置）。
 *
 * 诚实边界：非失败终局相（acting/achieved/blocked/…）⇒ null（岔路卡只在
 * 失败后有意义）；岔路账为空（未武装 / 环形淘汰殆尽 / 崩溃后未恢复）⇒ null
 * （无账不造卡 —— 诚实降级）；归因报告缺席 ⇒ unknown 兜底（鉴别穷尽的诚实
 * 无知，与 R1 兜底律同源）。
 */
export function generateBranchCard(
  ledger: BranchLedgerBook | BranchLedgerSnapshot | null | undefined,
  failure: {
    /** goal 判定相 —— 只认 'failed' | 'aborted'（脏值 ⇒ null 不造卡） */
    phase: unknown;
    /** goal 判定理由（一句话） */
    reason?: unknown;
    /** 该步失败的 R1 根因报告（diagnosis 只读消费；缺席 ⇒ unknown 兜底） */
    attribution?: RootCauseReport | null;
    /** 时钟注入（缺省 Date.now） */
    now?: () => number;
  },
): BranchCard | null {
  if (!failure || (failure.phase !== 'failed' && failure.phase !== 'aborted')) return null;
  const entries = ledgerEntriesOf(ledger);
  if (entries.length === 0) return null; // 无岔路账 ⇒ 卡片缺席（诚实降级）
  const pivotStep = entries[entries.length - 1];
  const attribution = attributionOf(failure.attribution ?? null);
  const now = typeof failure.now === 'function' ? failure.now : Date.now;
  return {
    cardVersion: 1,
    createdAt: safeNow(now),
    goalPhase: failure.phase,
    goalReason: typeof failure.reason === 'string' ? failure.reason : '',
    pivot: {
      stepIndex: pivotStep.stepIndex,
      recordedAt: pivotStep.recordedAt,
      anchor: { journalLength: pivotStep.anchor.journalLength, chainTip: pivotStep.anchor.chainTip },
    },
    candidates: pivotStep.candidates.map(c => ({ ...c, attribution })),
  };
}

// ─── W3-6：换支重放（steer(k) 的纯 API 面） ───

/** 重放步账状态（预算执法的透明面） */
export interface BranchReplayState {
  /** armed=已武装未动 / stepping=预算内推进 / exhausted=超支诚实终止 / completed=重放收尾 */
  status: 'armed' | 'stepping' | 'exhausted' | 'completed';
  stepsUsed: number;
  budgetSteps: number;
}

/**
 * 重放预算控制器：换支重放的每一步先 spend() 扣预算 —— 预算内放行计步，
 * 超支 ⇒ proceed=false 诚实终止（绝不悄悄续命：重放是第二尝试，不继承原路
 * 全额预算）。complete() 收尾；exhausted 是终局（超支后再 complete 不改判）。
 */
export class BranchReplayController {
  private _stepsUsed = 0;
  private _status: BranchReplayState['status'] = 'armed';
  private readonly _budgetSteps: number;
  constructor(budgetSteps: number) {
    this._budgetSteps = budgetSteps;
  }

  get state(): BranchReplayState {
    return { status: this._status, stepsUsed: this._stepsUsed, budgetSteps: this._budgetSteps };
  }

  /** 重放每步前扣预算（预算执法点） */
  spend(): {
    proceed: boolean;
    status: BranchReplayState['status'];
    stepsUsed: number;
    budgetSteps: number;
    note?: string;
  } {
    if (this._status === 'completed') {
      return {
        proceed: false, status: 'completed', stepsUsed: this._stepsUsed, budgetSteps: this._budgetSteps,
        note: '重放已完成（complete 之后再 spend = 调用方账目混乱，拒绝计步）',
      };
    }
    if (this._stepsUsed >= this._budgetSteps) {
      this._status = 'exhausted';
      return {
        proceed: false, status: 'exhausted', stepsUsed: this._stepsUsed, budgetSteps: this._budgetSteps,
        note: `重放预算 ${this._budgetSteps} 步已耗尽 —— 诚实终止（不伪造继续）`,
      };
    }
    this._stepsUsed += 1;
    this._status = 'stepping';
    return { proceed: true, status: 'stepping', stepsUsed: this._stepsUsed, budgetSteps: this._budgetSteps };
  }

  /** 重放成功收尾（exhausted 后调用无效 —— 超支是终局事实） */
  complete(): void {
    if (this._status !== 'exhausted') this._status = 'completed';
  }
}

/** applyBranchChoice 的可选项（全可缺席 —— 防御缺省） */
export interface BranchChoiceOptions {
  /**
   * 支点防御校验锚：checkpoint 恢复侧的当前步账位置（journal 条数 + 链尖）。
   * 提供且与卡内支点锚不等 ⇒ 拒绝换支（世界已漂移，从旧支点重放的前提不
   * 成立）；不提供 ⇒ 支点引用随卡携带（如实标注「未经强校验」）。
   */
  verifyAnchor?: { journalLength?: unknown; chainTip?: unknown } | null;
  /** 当前岔路账（checkpoint 段恢复后的账面）：提供且无该支点步 ⇒ 拒绝 */
  ledger?: BranchLedgerBook | BranchLedgerSnapshot | null;
  /** 重放步数预算（缺省 BRANCH_REPLAY_BUDGET_STEPS；非法 ⇒ 缺省） */
  budgetSteps?: number;
}

/** 换支重放的产出：选中候选 + 支点 + 偏置载荷 + 重放预算控制器（或拒绝理由） */
export interface BranchChoiceResult {
  ok: boolean;
  /** 拒绝原因（ok=false 时在场 —— 诚实降级面） */
  error?: string;
  /** 选中的候选序号（1..K；ok=true 时在场） */
  k?: number;
  /** 选中候选（签名 + 动作 + 诚实效用） */
  choice?: { signature: string; action: PolicyAction; utility: number; rank: number };
  /** 支点引用（拒绝时若卡可解析亦随行 —— 审计面） */
  pivot?: BranchCard['pivot'];
  /** 支点恢复报告（校验方式如实申报） */
  restore?: { ok: boolean; anchor: { journalLength: number; chainTip: string }; note: string };
  /** 决策偏置载荷 —— 铸入 ScoringContext.preferredActionKeys 注入缝（经 withSteerBias） */
  bias?: { preferredActionKeys: string[] };
  /** 重放步账控制器（预算执法：超支诚实终止） */
  replay?: BranchReplayController;
}

/** 岔路卡防御解析：结构坏 ⇒ null（缺卡/坏卡一律诚实拒绝，绝不伪造换支） */
function parseBranchCard(card: unknown): BranchCard | null {
  if (!card || typeof card !== 'object') return null;
  const c = card as Record<string, unknown>;
  if (c.cardVersion !== 1) return null;
  if (typeof c.pivot !== 'object' || c.pivot === null) return null;
  const pivot = c.pivot as Record<string, unknown>;
  if (typeof pivot.stepIndex !== 'number' || !Number.isFinite(pivot.stepIndex)) return null;
  const rawCands = Array.isArray(c.candidates) ? c.candidates : [];
  const candidates = rawCands
    .map(x => (x && typeof x === 'object' ? (x as BranchCandidateRecord) : null))
    .filter((x): x is BranchCandidateRecord => x !== null && !!x.action && typeof x.signature === 'string');
  if (candidates.length === 0) return null;
  return card as BranchCard;
}

/**
 * W3-6（H3）换支重放主入口（纯函数、绝不抛 —— steer 工具/集成侧的调用面）：
 * 用户 steer(k) 一键选第 k 候选 ——
 *   ① 缺卡/坏卡 ⇒ ok:false（goal 未失败或岔路账缺席的诚实降级）；
 *   ② k 域防御：非整数 / 越界 ⇒ ok:false（合法域 1..candidates.length）；
 *   ③ 支点防御恢复：verifyAnchor 不匹配或当前账无该支点步 ⇒ ok:false
 *      （世界已漂移 / 支点被环形淘汰 —— 拒绝换支，绝不从错位世界重放）；
 *   ④ 偏置载荷：选中候选的签名铸为 preferredActionKeys（经 withSteerBias 铸入
 *      counterfactual 的 ScoringContext 注入缝 —— 改选偏置只改选择不改预测）；
 *   ⑤ 重放预算：BranchReplayController 执法（缺省 12 步，超支诚实终止）。
 */
export function applyBranchChoice(
  card: BranchCard | null | undefined,
  k: unknown,
  opts: BranchChoiceOptions = {},
): BranchChoiceResult {
  const parsed = parseBranchCard(card);
  if (parsed === null) {
    return { ok: false, error: 'no branch card（goal 未进入失败终局相，或岔路账缺席 —— 诚实降级）' };
  }
  if (typeof k !== 'number' || !Number.isInteger(k) || k < 1 || k > parsed.candidates.length) {
    return { ok: false, error: `invalid choice k=${String(k)}（合法域 1..${parsed.candidates.length}）`, pivot: parsed.pivot };
  }
  const anchor = parsed.pivot.anchor;
  if (opts.verifyAnchor !== undefined && opts.verifyAnchor !== null) {
    const vj =
      typeof opts.verifyAnchor.journalLength === 'number' && Number.isFinite(opts.verifyAnchor.journalLength)
        ? Math.floor(opts.verifyAnchor.journalLength)
        : -1;
    const vc = typeof opts.verifyAnchor.chainTip === 'string' ? opts.verifyAnchor.chainTip : '';
    if (vj !== anchor.journalLength || vc !== anchor.chainTip) {
      return {
        ok: false,
        error: `pivot anchor mismatch（卡内 ${anchor.journalLength}/${anchor.chainTip || '∅'} vs 当前 ${vj}/${vc || '∅'}）—— 世界已漂移，拒绝换支`,
        pivot: parsed.pivot,
      };
    }
  }
  if (opts.ledger !== undefined && opts.ledger !== null) {
    const has = ledgerEntriesOf(opts.ledger).some(
      e => e.stepIndex === parsed.pivot.stepIndex && e.anchor.chainTip === anchor.chainTip,
    );
    if (!has) {
      return {
        ok: false,
        error: `岔路账中无支点步 ${parsed.pivot.stepIndex}（环形淘汰或段未恢复）—— 拒绝换支`,
        pivot: parsed.pivot,
      };
    }
  }
  const budget =
    typeof opts.budgetSteps === 'number' && Number.isFinite(opts.budgetSteps)
      ? Math.max(1, Math.floor(opts.budgetSteps))
      : BRANCH_REPLAY_BUDGET_STEPS;
  const cand = parsed.candidates[k - 1];
  return {
    ok: true,
    k,
    choice: { signature: cand.signature, action: cloneJson(cand.action), utility: cand.utility, rank: cand.rank },
    pivot: parsed.pivot,
    restore: {
      ok: true,
      anchor: { journalLength: anchor.journalLength, chainTip: anchor.chainTip },
      note:
        opts.verifyAnchor !== undefined && opts.verifyAnchor !== null
          ? '支点锚校验通过（checkpoint 步账一致）'
          : '支点引用随卡携带（未提供校验锚 —— 未经强校验，如实申报）',
    },
    bias: { preferredActionKeys: [cand.signature] },
    replay: new BranchReplayController(budget),
  };
}

/**
 * 偏置铸入（注入缝消费面）：把 applyBranchChoice 的 bias 载荷合并进评分上下文
 * 的 preferredActionKeys（去重保序）。纯函数 —— 原 ctx 不被改动。
 */
export function withSteerBias(ctx: ScoringContext, keys: readonly string[]): ScoringContext {
  const base = (ctx && typeof ctx === 'object' ? ctx : {}) as ScoringContext;
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const k of [...(base.preferredActionKeys ?? []), ...keys]) {
    if (typeof k !== 'string' || k === '' || seen.has(k)) continue;
    seen.add(k);
    merged.push(k);
  }
  return { ...base, preferredActionKeys: merged };
}
