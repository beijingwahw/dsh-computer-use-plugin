// src/prophecy/index.ts
// 纪元 Ε（预言引擎）：自主环的动作前预言 + 动作后对账 —— 可审计的 Dyna 旁路。
//
// 立意（世界级 novelty）：业界 agent 全部「先做后看」；Dyna-Think 类研究停在
// 提示词层面。Ε 给自主环装上**可审计的预言引擎**：每个动作执行前，世界模型按
// (当前屏型, 动作键) 铸预言（期望下一屏型 + 转移概率）；执行后对账 —— 预言
// 命中/失手/模型无知三态入账，失手的惊异差值入册。agent 的世界观第一次有了
// 「考试」：每个动作都是一次预言测验，错题本（最常失手的 (屏型,动作) TopK）
// 自动生成。
//
// 与 D-7 预测编码回路的分工：知识管线里 surprise 先于 observe（先测误差再入账，
// 那是学习回路）；本模块是**审计回路** —— 只读地考世界模型（predict 读面 +
// surprise 读面），考完经 observe 把真实转移回灌（Dyna 式：真实经验喂模型，
// 模型逐步走出无知），但绝不反过来影响动作选择。运行层铁律：预言是纯审计
// 旁路 —— 任何故障只丢预言，绝不抛异常、绝不阻断动作、绝不伪造结算。
//
// 诚实三律（与 worldModel 同源）：
//   1. 模型无该转移 ⇒ outcome 'no-model'（诚实的无知，不是均匀分布的伪装）；
//   2. 执行后屏型取不到 ⇒ 预言挂起，60s 后诚实作废（expired 计数）——
//      绝不伪造 actualType，绝不把失明结算成真空屏；
//   3. 结算前有预言的记录 outcome='pending'（铸而未验）—— 账本与统计面
//      只见 hit/miss/no-model 三态终值，pending 绝不入账。
//
// 异常诚实铁律：本模块一切公开面永不抛异常（坏模型 throw 全吸收 ⇒ 按无知识
// 处理；坏参数 ⇒ 域外拒绝式静默吸收）。
import type { TransitionPrediction, WorldModel } from '../knowledge/contracts';
import { InMemoryWorldModel } from '../knowledge/worldModel';

// ─── 算法形状字面量（出册常数） ───

/** 账本环形容量（条）：错题本的物理上限 —— 审计史是滚动窗，不是无限账 */
const LEDGER_CAPACITY = 500;
/** 容量夹取上限（防注入式爆内存：账本是旁路，不值得无界） */
const CAPACITY_MAX = 10_000;
/** 挂起预言的诚实作废时限（ms）：60s 内取不到真实下一屏型 ⇒ 作废（绝不伪造） */
const PENDING_TTL_MS = 60_000;
/** 错题本缺省榜单长度（TopK） */
const DEFAULT_TOP_K = 5;
/** 概率夹取下界（−log₂ 的数值地平：p=0 的惊异按此封顶） */
const PROB_EPSILON = 1e-9;

/** 预言结算三态 + 铸造暂态（pending 只存在于铸造与结算之间，绝不入账） */
export type ProphecyOutcome = 'hit' | 'miss' | 'no-model' | 'pending';

/** 一条预言的完整生命（铸造 ⇒ 结算）：账本里的最小审计单元 */
export interface ProphecyRecord {
  /** 铸造时的屏型身份（闭环语境 = 快照 dhash 指纹） */
  screenType: string;
  /** 动作键（prophecyActionKey 的方言：kind 或 kind@量化区域） */
  actionKey: string;
  /** 预言的期望下一屏型（无历史 ⇒ 缺席 —— 诚实无知） */
  predictedType?: string;
  /** 预言的转移概率（predict 首名概率） */
  predictedProb?: number;
  /** 结算惊异差值（bits）：模型对实际到达的平滑惊讶 —— 命中小、失手大 */
  surpriseBits?: number;
  /** 结算判定：hit 命中 / miss 失手 / no-model 模型无知（pending = 铸而未验） */
  outcome: ProphecyOutcome;
  /** 实际到达的屏型（结算见证；挂起/作废 ⇒ 缺席） */
  actualType?: string;
  /** 铸造时刻（注入时钟） */
  ts: number;
}

/** 统计面（错题本）：账本的聚合读数 */
export interface ProphecyStats {
  /** 已结算入账条数（≤ 容量） */
  settled: number;
  /** 命中数（有预言且言中） */
  hits: number;
  /** 失手数（有预言而不符） */
  misses: number;
  /** 模型无知数（无历史直通） */
  noModel: number;
  /** 命中率 = hits/(hits+misses)（有预言的分母；no-model 不掺水；无 ⇒ 0） */
  hitRate: number;
  /** 失手率 = misses/(hits+misses)（同上口径） */
  missRate: number;
  /** 失手平均惊异 bits（无失手 ⇒ 0） */
  avgMissSurpriseBits: number;
  /** 错题本：最常失手的 (屏型, 动作) TopK（count 降序、键字典序破平 —— 确定序） */
  topMisses: Array<{ screenType: string; actionKey: string; count: number }>;
}

/** 账本快照（dump/restore 的序列化真相） */
export interface ProphecyLedgerSnapshot {
  version: 1;
  /** 已结算记录（入账序） */
  records: ProphecyRecord[];
  /** 挂起作废累计数 */
  expired: number;
}

/**
 * 闭环消费面（结构性端口）：真实 ProphecyEngine 天然满足，测试桩只须实现
 * 同名两面（与 PolicyPort/ConstitutionPort/SelfModelPort 同律）。
 */
export interface ProphecyPort {
  /** 动作执行前铸预言（屏型指纹缺席 ⇒ 不铸 —— 盲屏不可预言） */
  mint(screenType: string | null | undefined, actionKey: string): void;
  /** 动作执行后拿真实下一屏型结算；返回结算记录（null = 无待结算/仍挂起） */
  settle(actualType: string | null | undefined, success?: boolean): ProphecyRecord | null;
}

// ─── 内部纯工具（零异常） ───

/** 非空字符串守卫 */
function nonEmptyStr(v: unknown): boolean {
  return typeof v === 'string' && v.length > 0;
}

/** 安全时钟读数：注入钟缺席/抛错 ⇒ Date.now；永不抛 */
function safeNow(injected: (() => number) | undefined): number {
  try {
    if (typeof injected === 'function') {
      const t = injected();
      if (typeof t === 'number' && Number.isFinite(t)) return t;
    }
  } catch { /* 坏钟 ⇒ 系统钟兜底 */ }
  return Date.now();
}

/** 展示位截断（journal 一行的 Token 纪律：指纹全量留在账本，注记只留锚点） */
function shortId(s: string): string {
  return s.length > 16 ? `${s.slice(0, 16)}…` : s;
}

/** 结果解析：Result 形状的成功值（坏形状/坏值 ⇒ null —— 防御式读模型） */
function resultValue<T>(r: unknown): T | null {
  if (!r || typeof r !== 'object' || (r as { ok?: unknown }).ok !== true) return null;
  const v = (r as { value?: unknown }).value;
  return (v ?? null) as T | null;
}

/**
 * 结算惊异差值（bits）—— 铸预言的自误定价（纯函数，永不抛）。
 * 优先走世界模型现成的 surprise() 读面（Laplace 平滑惊讶，与 D-7 计费器同一
 * 口径 —— 绝不复制实现，只复用读面）；模型缺席/抛错/坏值 ⇒ 按预言自身定价
 * 回退：miss 为 −log₂(1−p)（预言落空的惊异 —— 越自信错得越响，恒正），
 * hit 为 −log₂(p)（言中残差，≥0）。
 */
function settleSurpriseBits(
  record: ProphecyRecord,
  actualType: string,
  outcome: 'hit' | 'miss',
  worldModel: WorldModel | null | undefined,
): number | undefined {
  try {
    if (worldModel && typeof worldModel.surprise === 'function') {
      const r = worldModel.surprise(record.screenType, record.actionKey, actualType);
      const v = resultValue<{ bits?: unknown }>(r);
      if (v && typeof v.bits === 'number' && Number.isFinite(v.bits) && v.bits >= 0) {
        return Math.round(v.bits * 1e6) / 1e6;
      }
    }
  } catch { /* 模型故障 ⇒ 回退自误定价（绝不炸结算） */ }
  try {
    const p = typeof record.predictedProb === 'number' && Number.isFinite(record.predictedProb)
      ? Math.min(1, Math.max(0, record.predictedProb))
      : 0.5; // 无概率读数 ⇒ 中性 0.5（不自夸也不自贬）
    if (outcome === 'hit') {
      const q = Math.min(1, Math.max(PROB_EPSILON, p));
      return Math.round(-Math.log2(q) * 1e6) / 1e6;
    }
    const q = Math.min(1 - PROB_EPSILON, Math.max(PROB_EPSILON, 1 - p));
    return Math.round(-Math.log2(q) * 1e6) / 1e6; // 夹 (0,1) ⇒ 恒正
  } catch {
    return undefined; // 数学库故障（理论上不可达）⇒ 惊异缺席，绝不抛
  }
}

// ─── 铸造与结算（纯函数面） ───

/**
 * 铸预言（纯函数，永不抛）：按 (屏型, 动作键) 问世界模型 predict 读面。
 *   · 无历史 / 模型缺席 / 模型抛错 / 坏形状 ⇒ outcome 'no-model'（诚实无知，
 *     绝不把「没见过」伪装成任何预测）；
 *   · 有历史 ⇒ 取分布首名（typeId + prob），outcome 'pending'（铸而未验 ——
 *     三态终值只由 settleProphecy 落锤）。
 * @param ts 铸造时刻（缺省 Date.now —— 引擎注入闭环时钟）
 */
export function mintProphecy(
  worldModel: WorldModel | null | undefined,
  screenType: string,
  actionKey: string,
  ts?: number,
): ProphecyRecord {
  const t = typeof ts === 'number' && Number.isFinite(ts) ? ts : Date.now();
  const s = nonEmptyStr(screenType) ? screenType : String(screenType ?? '');
  const k = nonEmptyStr(actionKey) ? actionKey : String(actionKey ?? '');
  const base = { screenType: s, actionKey: k, ts: t };
  let pred: TransitionPrediction | null = null;
  try {
    if (worldModel && typeof worldModel.predict === 'function' && nonEmptyStr(s) && nonEmptyStr(k)) {
      pred = resultValue<TransitionPrediction | null>(worldModel.predict(s, k));
    }
  } catch {
    pred = null; // 模型故障 = 无知识（诚实吞掉，绝不炸，绝不伪造）
  }
  const nextTypes = pred && Array.isArray((pred as TransitionPrediction).nextTypes)
    ? (pred as TransitionPrediction).nextTypes
    : [];
  const top = nextTypes[0] as { typeId?: unknown; prob?: unknown } | undefined;
  if (!top || !nonEmptyStr(top.typeId)) {
    return { ...base, outcome: 'no-model' };
  }
  const rec: ProphecyRecord = { ...base, predictedType: String(top.typeId), outcome: 'pending' };
  if (typeof top.prob === 'number' && Number.isFinite(top.prob)) {
    rec.predictedProb = Math.min(1, Math.max(0, top.prob));
  }
  return rec;
}

/**
 * 结预言（纯函数，永不抛）：命中律三态落锤。
 *   · predictedType === actualType ⇒ 'hit'；
 *   · 有预言而不符 ⇒ 'miss' + 惊异差值（settleSurpriseBits 口径）；
 *   · 无预言（no-model 铸造）⇒ 直通 —— 无知就是无知，actualType 只作见证记录。
 * actualType 非非空字符串 ⇒ 原样直通（不结算 —— 挂起由引擎的 60s 作废律收口，
 * 绝不在这里伪造见证）。返回结算后的**新记录**（入参不可变）。
 */
export function settleProphecy(
  record: ProphecyRecord,
  actualType: string,
  worldModel?: WorldModel | null,
): ProphecyRecord {
  try {
    if (!record || typeof record !== 'object') return record; // 垃圾记录直通
    if (!nonEmptyStr(actualType)) return record; // 无真实见证 ⇒ 不结算
    const out: ProphecyRecord = { ...record, actualType };
    if (!nonEmptyStr(out.predictedType)) {
      out.outcome = 'no-model'; // 直通：模型无知
      return out;
    }
    if (out.predictedType === actualType) {
      out.outcome = 'hit';
      out.surpriseBits = settleSurpriseBits(out, actualType, 'hit', worldModel);
      return out;
    }
    out.outcome = 'miss';
    out.surpriseBits = settleSurpriseBits(out, actualType, 'miss', worldModel);
    return out;
  } catch {
    return record; // 结算绝不抛（运行层铁律）
  }
}

/**
 * 动作键方言（纯函数，永不抛）：PolicyAction → 世界模型转移表的键。
 * 指针动作 ⇒ kind + 量化区域（'click@22'）—— 与 worldModel.transitionActionKey
 * 的 TYPE_QUANTIZE=4 同门方言（「在什么样的屏上点哪个区」，精确坐标是噪声、
 * 区域是信号）；落点先从快照像素折算归一化（闭环坐标是像素，D-7 是归一化 ——
 * 折算在此收口）。无落点/坏几何 ⇒ kind 本身。
 */
export function prophecyActionKey(
  action: { kind?: unknown; target?: unknown } | null | undefined,
  refWidth?: number,
  refHeight?: number,
): string {
  try {
    const kind =
      action && typeof action === 'object' && nonEmptyStr(action.kind) ? String(action.kind) : 'unknown';
    const target = action && typeof action === 'object' ? (action as { target?: unknown }).target : null;
    const center = target && typeof target === 'object' ? (target as { center?: unknown }).center : null;
    const cx = center && typeof center === 'object' ? (center as { x?: unknown }).x : undefined;
    const cy = center && typeof center === 'object' ? (center as { y?: unknown }).y : undefined;
    const hasGeom =
      typeof refWidth === 'number' && Number.isFinite(refWidth) && refWidth > 0 &&
      typeof refHeight === 'number' && Number.isFinite(refHeight) && refHeight > 0;
    if (typeof cx === 'number' && Number.isFinite(cx) && typeof cy === 'number' && Number.isFinite(cy) && hasGeom) {
      const nx = Math.min(1, Math.max(0, cx / refWidth!));
      const ny = Math.min(1, Math.max(0, cy / refHeight!));
      const qx = Math.min(3, Math.max(0, Math.floor(nx * 4)));
      const qy = Math.min(3, Math.max(0, Math.floor(ny * 4)));
      return `${kind}@${qx}${qy}`;
    }
    return kind;
  } catch {
    return 'unknown'; // 键铸造绝不抛
  }
}

/**
 * 步 journal 注记（一行，纯函数）：`prophecy:hit|miss|no-model（…）` ——
 * 闭环唯一的留痕差量（不扩 StepRecord 字段结构）。指纹截 16 字符（Token 纪律，
 * 全量身份留在账本）。
 */
export function prophecyJournalTag(record: ProphecyRecord): string {
  try {
    const cell = `${shortId(record.screenType)}|${record.actionKey}`;
    const to = nonEmptyStr(record.actualType) ? shortId(String(record.actualType)) : '?';
    if (record.outcome === 'hit') {
      const p = typeof record.predictedProb === 'number' && Number.isFinite(record.predictedProb)
        ? Math.round(record.predictedProb * 1000) / 1000
        : '?';
      return `prophecy:hit（${cell} → ${to}，p=${p}）`;
    }
    if (record.outcome === 'miss') {
      const bits = typeof record.surpriseBits === 'number' && Number.isFinite(record.surpriseBits)
        ? Math.round(record.surpriseBits * 1000) / 1000
        : '?';
      return `prophecy:miss（${cell} → ${to}，惊异 ${bits} bits）`;
    }
    return `prophecy:no-model（${cell} → ${to}，模型无知直通）`;
  } catch {
    return 'prophecy:no-model（注记铸造故障，账本为准）'; // 注记绝不抛
  }
}

// ─── 统计面（纯函数 + 引擎委托） ───

/**
 * 错题本统计（纯函数，永不抛）：对已结算记录聚合。
 * 命中/失手率只以**有预言**的结算为分母（no-model 是无知不是错误 —— 掺水
 * 会让新模型看起来「永远全错」，不诚实）。topMisses 按失手计数降序、
 * (屏型|动作) 字典序破平 —— 全序确定，绝不掷硬币。
 */
export function prophecyStats(records: ReadonlyArray<ProphecyRecord>, topK = DEFAULT_TOP_K): ProphecyStats {
  try {
    let hits = 0;
    let misses = 0;
    let noModel = 0;
    let missBits = 0;
    let missBitsN = 0;
    const missCells = new Map<string, { screenType: string; actionKey: string; count: number }>();
    for (const r of records) {
      if (!r || typeof r !== 'object') continue;
      if (r.outcome === 'hit') {
        hits++;
      } else if (r.outcome === 'miss') {
        misses++;
        if (typeof r.surpriseBits === 'number' && Number.isFinite(r.surpriseBits)) {
          missBits += r.surpriseBits;
          missBitsN++;
        }
        const key = `${String(r.screenType)}|${String(r.actionKey)}`;
        const cell = missCells.get(key) ?? { screenType: String(r.screenType), actionKey: String(r.actionKey), count: 0 };
        cell.count++;
        missCells.set(key, cell);
      } else if (r.outcome === 'no-model') {
        noModel++;
      } // pending / 垃圾值不入统计（账本不该有 pending —— 防御式忽略）
    }
    const denom = hits + misses;
    const k = typeof topK === 'number' && Number.isFinite(topK) && topK >= 1 ? Math.floor(topK) : DEFAULT_TOP_K;
    const topMisses = [...missCells.values()]
      .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.screenType < b.screenType ? -1 : a.screenType > b.screenType ? 1 : a.actionKey < b.actionKey ? -1 : a.actionKey > b.actionKey ? 1 : 0))
      .slice(0, k)
      .map(c => ({ screenType: c.screenType, actionKey: c.actionKey, count: c.count }));
    const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;
    return {
      settled: records.length,
      hits,
      misses,
      noModel,
      hitRate: denom > 0 ? round6(hits / denom) : 0,
      missRate: denom > 0 ? round6(misses / denom) : 0,
      avgMissSurpriseBits: missBitsN > 0 ? round6(missBits / missBitsN) : 0,
      topMisses,
    };
  } catch {
    return {
      settled: 0, hits: 0, misses: 0, noModel: 0,
      hitRate: 0, missRate: 0, avgMissSurpriseBits: 0, topMisses: [],
    }; // 统计绝不抛（运行层铁律）
  }
}

// ─── 引擎（账本 + 挂起律 + Dyna 回灌） ───

/** 引擎构造选项（全部可缺席） */
export interface ProphecyEngineOptions {
  /** 世界模型（predict/surprise 读面 + observe 回灌写面；缺席 ⇒ 恒 no-model） */
  worldModel?: WorldModel | null;
  /** 注入时钟（缺省 Date.now —— 测试确定性生命线） */
  now?: () => number;
  /** 挂起作废时限 ms（缺省 60_000） */
  pendingTtlMs?: number;
  /** 账本容量（缺省 500，夹 [1, 10000]） */
  capacity?: number;
  /** 结算后回灌世界模型（observe —— Dyna 式学习；缺省 true；false ⇒ 纯只读审计） */
  learn?: boolean;
}

/**
 * 预言引擎（ProphecyPort 的真实实现）：铸造 → 挂起 → 结算 → 入账 的账本主人。
 *   · mint：先作废超时挂起，再铸新预言（盲屏指纹 ⇒ 不铸）；已有挂起被新铸
 *     覆盖时静默丢弃（闭环里 mint 恒在 settle 之后 —— 覆盖只在跨 run 边界）；
 *   · settle：actualType 缺席 ⇒ 挂起保持（60s 后作废计数，绝不伪造见证）；
 *     结算成功 ⇒ 记录入环形账本（500 封顶，逐出最旧）+（learn 时）observe
 *     回灌世界模型（先 surprise 后 observe —— 与 D-7 回路同序，误差先于学习）；
 *   · 一切公开面永不抛异常。
 */
export class ProphecyEngine implements ProphecyPort {
  private readonly worldModel: WorldModel | null;
  private readonly now: (() => number) | undefined;
  private readonly pendingTtlMs: number;
  private readonly capacity: number;
  private readonly learn: boolean;
  /** 环形账本（入账序；超容量逐出最旧） */
  private ledger: ProphecyRecord[] = [];
  /** 挂起中的预言（至多一条） */
  private pending: ProphecyRecord | null = null;
  /** 挂起作废累计（诚实计数 —— 取不到真实下一屏型的预言归宿） */
  private expiredCount = 0;

  constructor(opts: ProphecyEngineOptions = {}) {
    this.worldModel = opts.worldModel ?? null;
    this.now = typeof opts.now === 'function' ? opts.now : undefined;
    this.pendingTtlMs =
      typeof opts.pendingTtlMs === 'number' && Number.isFinite(opts.pendingTtlMs) && opts.pendingTtlMs > 0
        ? opts.pendingTtlMs
        : PENDING_TTL_MS;
    this.capacity =
      typeof opts.capacity === 'number' && Number.isFinite(opts.capacity)
        ? Math.min(CAPACITY_MAX, Math.max(1, Math.floor(opts.capacity)))
        : LEDGER_CAPACITY;
    this.learn = opts.learn !== false;
  }

  /** 挂起超时作废（内部件）：now − ts 越过 TTL ⇒ expired 计数 + 丢弃 */
  private voidStalePending(): void {
    if (this.pending === null) return;
    const age = safeNow(this.now) - this.pending.ts;
    if (Number.isFinite(age) && age > this.pendingTtlMs) {
      this.expiredCount++;
      this.pending = null;
    }
  }

  /** 铸造面（ProphecyPort）：盲屏不铸；任何故障只丢预言。永不抛。 */
  mint(screenType: string | null | undefined, actionKey: string): void {
    try {
      this.voidStalePending();
      if (!nonEmptyStr(screenType) || !nonEmptyStr(actionKey)) return; // 盲屏/空键不可预言
      this.pending = mintProphecy(this.worldModel, String(screenType), String(actionKey), safeNow(this.now));
    } catch {
      this.pending = null; // 铸造故障吞掉 —— 丢预言不炸环
    }
  }

  /**
   * 结算面（ProphecyPort）：新屏型指纹 = actualType（结算见证）。
   * 返回结算记录（null = 无待结算 / 见证缺席仍挂起 / 已作废）。永不抛。
   * learn 时结算后回灌 observe（success 由闭环传执行结局 —— 缺省按成功入账）。
   */
  settle(actualType: string | null | undefined, success?: boolean): ProphecyRecord | null {
    try {
      this.voidStalePending();
      const pending = this.pending;
      if (pending === null) return null;
      if (!nonEmptyStr(actualType)) return null; // 见证缺席 ⇒ 挂起（60s 作废律收口）
      const settled = settleProphecy(pending, String(actualType), this.worldModel);
      // Dyna 回灌：真实转移喂模型（先 surprise 后 observe —— settleProphecy 已读
      // 惊异，此处才入账学习；回灌故障吞掉 —— 审计绝不为学习停摆）
      if (this.learn && this.worldModel && typeof this.worldModel.observe === 'function') {
        try {
          this.worldModel.observe(
            settled.screenType, settled.actionKey,
            String(actualType), success !== false,
          );
        } catch { /* 回灌故障吞掉 */ }
      }
      this.pending = null;
      this.ledger.push(settled);
      if (this.ledger.length > this.capacity) {
        this.ledger.splice(0, this.ledger.length - this.capacity); // 环形逐出最旧
      }
      return settled;
    } catch {
      this.pending = null; // 结算故障吞掉 —— 丢预言不炸环
      return null;
    }
  }

  /** 账本只读副本（入账序；外部不得原地改 —— 副本隔离） */
  records(): ProphecyRecord[] {
    try {
      return this.ledger.map(r => ({ ...r }));
    } catch {
      return [];
    }
  }

  /** 统计面 = prophecyStats(账本) + 引擎生命体征（挂起/作废/容量） */
  stats(): ProphecyStats & { pending: number; expired: number; capacity: number } {
    try {
      this.voidStalePending();
      return {
        ...prophecyStats(this.ledger),
        pending: this.pending !== null ? 1 : 0,
        expired: this.expiredCount,
        capacity: this.capacity,
      };
    } catch {
      return {
        settled: 0, hits: 0, misses: 0, noModel: 0,
        hitRate: 0, missRate: 0, avgMissSurpriseBits: 0, topMisses: [],
        pending: 0, expired: 0, capacity: this.capacity,
      };
    }
  }

  /** 账本快照（checkpoint 消费面）：记录 + 作废计数。永不抛。 */
  dump(): ProphecyLedgerSnapshot {
    try {
      this.voidStalePending();
      return {
        version: 1,
        records: this.ledger.map(r => ({ ...r })),
        expired: this.expiredCount,
      };
    } catch {
      return { version: 1, records: [], expired: 0 };
    }
  }

  /**
   * 快照水合（防御式整体替换）：任一行非法即跳过该行（半水合诚实 —— 好行
   * 入账、坏行弃置）；快照整体非法 ⇒ 原账本保持不动。永不抛。
   */
  restore(snapshot: unknown): void {
    try {
      if (!snapshot || typeof snapshot !== 'object') return;
      const s = snapshot as { records?: unknown; expired?: unknown };
      if (!Array.isArray(s.records)) return;
      const next: ProphecyRecord[] = [];
      for (const row of s.records) {
        const r = row as Partial<ProphecyRecord> | null;
        if (!r || typeof r !== 'object') continue;
        if (!nonEmptyStr(r.screenType) || !nonEmptyStr(r.actionKey)) continue;
        if (typeof r.ts !== 'number' || !Number.isFinite(r.ts)) continue;
        if (r.outcome !== 'hit' && r.outcome !== 'miss' && r.outcome !== 'no-model') continue; // pending 不入账
        const rec: ProphecyRecord = {
          screenType: String(r.screenType),
          actionKey: String(r.actionKey),
          outcome: r.outcome,
          ts: r.ts,
        };
        if (nonEmptyStr(r.predictedType)) rec.predictedType = String(r.predictedType);
        if (typeof r.predictedProb === 'number' && Number.isFinite(r.predictedProb)) {
          rec.predictedProb = Math.min(1, Math.max(0, r.predictedProb));
        }
        if (typeof r.surpriseBits === 'number' && Number.isFinite(r.surpriseBits) && r.surpriseBits >= 0) {
          rec.surpriseBits = r.surpriseBits;
        }
        if (nonEmptyStr(r.actualType)) rec.actualType = String(r.actualType);
        next.push(rec);
      }
      this.ledger = next.slice(Math.max(0, next.length - this.capacity)); // 容量律同裁
      if (typeof s.expired === 'number' && Number.isFinite(s.expired) && s.expired >= 0) {
        this.expiredCount = Math.floor(s.expired);
      }
      this.pending = null; // 挂起不可序列化 —— 水合即清（诚实：跨进程的未验预言作废）
    } catch { /* 水合绝不抛（运行层铁律） */ }
  }
}

/**
 * 预言世界模型单例（纪元 Ε 生产接线）：进程内跨 run 存活 —— 每次结算的
 * observe 回灌在此累积，模型逐步走出无知（第二次遇见同一条路就有预言）。
 * 零持久化（与 InMemoryWorldModel 同律 —— 落盘是留白，checkpoint 消费
 * dump/restore 面）。
 */
export const prophecyWorldModel: WorldModel = new InMemoryWorldModel();
