// src/vlm/metering.ts
// 纪元 Ω（Ω-10 云脑皮层计量）：VLM 调用计量 / 双桶滑动窗限流 / API 熔断 / 全抖动退避。
// 纯离线器官 —— 零网络零 sharp：时间轴全部可注入（构造/方法传 now），云脑的每一次
// 心跳都可被测试离线复算。数学传统延续：全抖动退避 uniform(0, b·2^n)（AWS 架构
// 博客同源）、延迟分位数最近邻秩法（与 telemetry.percentile 同律）、熔断遵循
// guards 的「拒绝优于谎言」—— 全部具名导出、绝不抛异常（垃圾输入诚实降级）。
import { kernelRegistry } from '../kernel/registry';

/** VLM 单次调用记录（计量原子）：成败、延迟、令牌与错误症状随行 */
export interface VlmCallRecord {
  /** 调用时间戳（epoch ms —— 与限流/熔断共用同一时间轴） */
  ts: number;
  /** 调用类别（screen / ocr / ground …… 消费方自定义词表，byKind 的分桶键） */
  kind: string;
  /** 被调用的模型名（计量归因的维度之一） */
  model: string;
  latencyMs: number;
  ok: boolean;
  promptTokens?: number;
  completionTokens?: number;
  error?: string;
}

/** 延迟分位窗口：只看最近 1000 个样本（最近邻秩法精确分位，无桶近似） */
const LATENCY_WINDOW = 1000;

/**
 * 原始台账环形上限（P2a-2）：封顶 5000 条 —— 超限覆盖最老样本并计 dropped。
 * 全库遍历报告点名：p50/p95 只看最近 1000 窗，但原始 ledger 数组只增不减，
 * 长会话内存无界。上限取分位窗的 5 倍：exportJsonl 审计面保留足够近史，
 * 内存恒有界；被覆盖的总量由 dropped 计数器诚实标注（不假装全量在场）。
 */
const LEDGER_CAP = 5000;

/** 最近邻秩分位：sorted 升序，index = min(n−1, floor(q·n))；空样本诚实回 0 */
function rankPercentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

/**
 * VLM 调用计量器：环形有界台账（P2a-2：封顶 LEDGER_CAP=5000 条，溢出覆盖最老
 * 样本并计 dropped）+ 窗口化分位快照。写入 O(1)（溢出时一次 shift，5000 元素内
 * 开销可忽略）、读取时排序（读写频率不对称 —— 与 telemetry 的延迟环同一取舍）；
 * 分位数只取最近 1000 个样本，exportJsonl 审计最近 5000 条 —— 「样本被覆盖」
 * 由 dropped getter 诚实暴露（真总量 = summary().calls + dropped）。
 */
export class VlmMeter {
  private records: VlmCallRecord[] = [];
  /** P2a-2：被环形覆盖挤出的样本总数（诚实「样本被覆盖」账） */
  private droppedCount = 0;

  /** P2a-2：被覆盖样本数 —— summary() 的返回形状被既有测试 deepStrictEqual 锁死
   *  （不可加字段），故独立 getter 暴露；reset 归零 */
  get dropped(): number {
    return this.droppedCount;
  }

  /** 记入一次调用：非对象输入直接丢弃（诚实降级，绝不抛异常）；字段做有限性消毒 */
  record(rec: VlmCallRecord): void {
    if (!rec || typeof rec !== 'object') return;
    // 消毒副本：外部对象后续突变不污染台账；非有限数值归零，未知类别归 'unknown'
    const copy: VlmCallRecord = {
      ts: Number.isFinite(rec.ts) ? rec.ts : 0,
      kind: typeof rec.kind === 'string' ? rec.kind : 'unknown',
      model: typeof rec.model === 'string' ? rec.model : 'unknown',
      latencyMs: Number.isFinite(rec.latencyMs) ? rec.latencyMs : 0,
      ok: rec.ok === true,
    };
    if (Number.isFinite(rec.promptTokens)) copy.promptTokens = rec.promptTokens;
    if (Number.isFinite(rec.completionTokens)) copy.completionTokens = rec.completionTokens;
    if (typeof rec.error === 'string') copy.error = rec.error;
    // P2a-2：环形封顶 —— 台账满时挤掉最老样本（dropped 诚实计数），长会话内存有界
    if (this.records.length >= LEDGER_CAP) {
      this.records.shift();
      this.droppedCount++;
    }
    this.records.push(copy);
  }

  /** 结构化快照：计数 / 令牌 / byKind 分桶 / 窗口化 p50·p95（最近邻秩法） */
  summary(): {
    calls: number; failures: number; totalLatencyMs: number;
    p50LatencyMs: number; p95LatencyMs: number;
    promptTokens: number; completionTokens: number;
    byKind: Record<string, number>;
  } {
    let failures = 0, totalLatencyMs = 0, promptTokens = 0, completionTokens = 0;
    const byKind: Record<string, number> = {};
    for (const r of this.records) {
      if (!r.ok) failures++;
      totalLatencyMs += r.latencyMs;
      promptTokens += r.promptTokens ?? 0;
      completionTokens += r.completionTokens ?? 0;
      byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    }
    const recent = this.records.slice(-LATENCY_WINDOW)
      .map(r => r.latencyMs)
      .sort((a, b) => a - b);
    return {
      calls: this.records.length,
      failures,
      totalLatencyMs,
      p50LatencyMs: rankPercentile(recent, 0.5),
      p95LatencyMs: rankPercentile(recent, 0.95),
      promptTokens,
      completionTokens,
      byKind,
    };
  }

  /** JSONL 审计导出：每行一个 JSON（空台账返回空串）；消费方可直接落盘/回放。
   *  P2a-2：导出的是环形保留窗（最近 LEDGER_CAP 条）—— 被覆盖的早期样本不在场，
   *  总量见 dropped */
  exportJsonl(): string {
    return this.records.map(r => JSON.stringify(r)).join('\n');
  }

  /** 清空台账（计量归零 —— 会话切换 / 测试隔离用；P2a-2：dropped 同步归零） */
  reset(): void {
    this.records = [];
    this.droppedCount = 0;
  }
}

/** 模块级单例：云脑皮层的全局心跳账本（插件生命周期内唯一） */
export const vlmMeter: VlmMeter = new VlmMeter();

// ─── 限流：双桶滑动窗（分钟桶 × 小时桶） ───

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * VLM 限流器：滑动窗双桶 —— 分钟桶容量 maxPerMinute、小时桶容量 maxPerHour
 * （缺省 = 分钟 × 60，即「允许持续满速一小时」的保守缺省）。now 可注入，
 * 测试零墙钟。语义要点：
 *   - 获批须**两桶同时有空位**（分钟桶防突发，小时桶防日预算耗尽）；
 *   - 被拒不占配额（denied 的戳不入账）；
 *   - retryAfterMs = 到最近**可获批**释放边界的毫秒数：若两桶皆满，
 *     须等较晚释放的那个（只等较早的桶边界处重试必再被拒 —— 诚实值取 max）；
 *   - 桶容量为 0 的退化配置 ⇒ 永拒（降级方向为「拒绝优于超支」），等待期以整窗计。
 */
export class VlmRateLimiter {
  private readonly maxPerMinute: number;
  private readonly maxPerHour: number;
  /** 已获批的时间戳（升序不假设 —— 注入时间可回拨，扫描时动态取最老） */
  private stamps: number[] = [];

  constructor(opts: { maxPerMinute: number; maxPerHour?: number }) {
    const m = Number.isFinite(opts?.maxPerMinute) ? Math.max(0, Math.floor(opts.maxPerMinute)) : 0;
    this.maxPerMinute = m;
    const h = opts?.maxPerHour;
    // 缺省小时桶 = 分钟桶 × 60；显式注入可以为任意值（含比分钟桶更紧的日预算）
    this.maxPerHour = Number.isFinite(h) ? Math.max(0, Math.floor(h as number)) : m * 60;
  }

  /** 尝试获取一个配额：获批则入账并放行；被拒则给出到最近可获批边界的毫秒数 */
  tryAcquire(now?: number): { allowed: boolean; retryAfterMs: number } {
    const t = Number.isFinite(now) ? (now as number) : Date.now();
    // 单遍扫描：滑出小时窗的戳出账（内存有界），窗内计数 + 各桶最老戳（释放边界锚）
    let minuteCount = 0, hourCount = 0;
    let minuteOldest = Infinity, hourOldest = Infinity;
    const kept: number[] = [];
    for (const s of this.stamps) {
      if (!(s > t - HOUR_MS)) continue;
      kept.push(s);
      hourCount++;
      if (s < hourOldest) hourOldest = s;
      if (s > t - MINUTE_MS) {
        minuteCount++;
        if (s < minuteOldest) minuteOldest = s;
      }
    }
    this.stamps = kept;
    let wait = 0;
    if (minuteCount >= this.maxPerMinute) {
      // 最老戳 + 窗宽 = 该桶释放边界；空桶且容量 0 ⇒ 无戳可滑出，以整窗为等待期
      const boundary = Number.isFinite(minuteOldest) ? minuteOldest + MINUTE_MS : t + MINUTE_MS;
      wait = Math.max(wait, boundary - t);
    }
    if (hourCount >= this.maxPerHour) {
      const boundary = Number.isFinite(hourOldest) ? hourOldest + HOUR_MS : t + HOUR_MS;
      wait = Math.max(wait, boundary - t);
    }
    if (wait > 0) return { allowed: false, retryAfterMs: wait };
    this.stamps.push(t);
    return { allowed: true, retryAfterMs: 0 };
  }
}

// ─── 熔断：连续失败计数 + 冷却期 ───

/**
 * VLM API 熔断器：连续失败 ≥ failureThreshold（缺省 5）⇒ open（拒绝一切）；
 * cooldownMs（缺省 60000）期满自动回 closed —— 半开语义在 state()/retryAt()
 * 内惰性判定（无需后台定时器，纯函数式时间注入）；成功清零连续失败。
 * open 态再遭失败 ⇒ 冷却期自该失败重新起算（API 仍在病中，冷静期不缩水）。
 *
 * 纪元 Ξ（Ξ-D 生产接线）：缺省参读内核注册表 —— vlm.breakerFailures（缺省 5）
 * / vlm.breakerCooldownMs（缺省 60000）。读点在构造器的缺省表达式：每次
 * new 求值一次 ⇒ set 后新实例即时生效（显式入参恒压过注册表，调用方主权）；
 * 未注册 ⇒ getOrDefault 回声字面量，行为逐字节不变。
 */
export class VlmApiBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private consecutive = 0;
  private openedAt: number | null = null;

  constructor(opts?: { failureThreshold?: number; cooldownMs?: number }) {
    const ft = opts?.failureThreshold;
    this.failureThreshold = Number.isFinite(ft)
      ? Math.max(1, Math.floor(ft as number))
      : Math.max(1, Math.floor(kernelRegistry.getOrDefault('vlm.breakerFailures', 5)));
    const cd = opts?.cooldownMs;
    this.cooldownMs = Number.isFinite(cd)
      ? Math.max(0, Math.floor(cd as number))
      : Math.max(0, Math.floor(kernelRegistry.getOrDefault('vlm.breakerCooldownMs', 60000)));
  }

  /** 惰性半开判定：open 且冷静期满 ⇒ 回 closed（连续失败清零，还给完整机会） */
  private refresh(t: number): void {
    if (this.openedAt !== null && t - this.openedAt >= this.cooldownMs) {
      this.openedAt = null;
      this.consecutive = 0;
    }
  }

  /** 一次成功：无论 closed（清零连败）还是 open/半开（试探成功即治愈）都闭合 */
  onSuccess(now?: number): void {
    this.refresh(Number.isFinite(now) ? (now as number) : Date.now());
    this.openedAt = null;
    this.consecutive = 0;
  }

  /** 一次失败：连败 +1，越阈 ⇒ open；open 态失败 ⇒ 冷却期重燃（自此刻重新起算） */
  onFailure(now?: number): void {
    const t = Number.isFinite(now) ? (now as number) : Date.now();
    this.refresh(t);
    this.consecutive++;
    if (this.consecutive >= this.failureThreshold) this.openedAt = t;
  }

  /** 当前状态（半开语义在此判定：冷静期满即视为 closed） */
  state(now?: number): 'closed' | 'open' {
    this.refresh(Number.isFinite(now) ? (now as number) : Date.now());
    return this.openedAt === null ? 'closed' : 'open';
  }

  retryAt(now?: number): number | null {
    this.refresh(Number.isFinite(now) ? (now as number) : Date.now());
    return this.openedAt === null ? null : this.openedAt + this.cooldownMs;
  }
}

/**
 * 全抖动退避（Full Jitter，AWS 架构博客同源）：返回 uniform(0, min(cap, base·2^attempt))。
 * 纯函数、直接用 Math.random（测试只断言范围与上界单调，不播种）；base 缺省 500ms、
 * cap 缺省 8000ms；attempt 非有限值按 0 计，指数溢出（2^attempt → ∞）由 cap 兜底。
 */
export function jitterBackoff(attempt: number, baseMs = 500, capMs = 8000): number {
  const a = Number.isFinite(attempt) ? Math.max(0, attempt) : 0;
  const b = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 500;
  const c = Number.isFinite(capMs) && capMs > 0 ? capMs : 8000;
  const upper = Math.min(c, b * 2 ** a);
  return Math.random() * upper;
}

// ─── W2-8（C2 成本级联路由）：按 tier 分列的级联台账 + 节省率 ───

/**
 * W2-8：级联节省率结构化快照 —— 全部字段可离线精确断言（统计诚实律：
 * 负节省如实上报，不做钳零美化；级联比全主力更贵时 savedUnits/savingsRate
 * 为负值，供宿主据实回撤策略）。
 */
export interface CascadeStats {
  /** 级联队列（便宜臂实际承接的调用）= cheapHit + escalated */
  eligible: number;
  /** 便宜档答案通过确定性校验被采信的次数（省钱事件） */
  cheapHit: number;
  /** 便宜臂失败（调用败/JSON 坏/校验不过）升级主力重做的次数 */
  escalated: number;
  /** 便宜命中率 = cheapHit / eligible（eligible 0 时诚实记 0） */
  hitRate: number;
  /** 按 tier 分列：便宜档实际拨号次数与花费（相对价格单位） */
  cheapTier: { calls: number; units: number };
  /** 按 tier 分列：主力档在级联队列内的实际次数与花费（升级重做） */
  primaryTier: { calls: number; units: number };
  /** 级联队列实际总花费 = cheapTier.units + primaryTier.units */
  spentUnits: number;
  /** 反事实基线 = eligible × primaryPrice（不用级联时的全主力花费） */
  baselineUnits: number;
  /** 净节省 = baseline − spent（可为负 —— 统计诚实，不钳零） */
  savedUnits: number;
  /** 节省率 = saved / baseline（= 命中率 × 价差比；baseline 0 时记 0） */
  savingsRate: number;
  /** 分诊判高危直行主力的次数（级联队列之外，仅观测） */
  primaryDirect: number;
}

/**
 * W2-8（C2 成本级联路由）：级联台账 —— 按 tier 分列记账 + 节省率快照。
 *
 * 数学（与 CascadeStats 字段一一对应，可离线复算）：
 *   - 队列 = cheapHit + escalated；基线 = 队列 × primaryPrice（反事实：不用
 *     级联每次都走主力）；
 *   - 实际花费 = 便宜实拨次数计 cheapPrice（便宜脑被熔断/未配置跳过而未拨号
 *     ⇒ 计 0 —— 只记真实发生的钱）+ 升级重做计 primaryPrice；
 *   - 节省率 = (baseline − spent) / baseline = 命中率 × (primaryPrice −
 *     cheapPrice) / primaryPrice（便宜命中率 × 价差比，规格 C2-4 的定义式）。
 *
 * 记账事件由 VlmCascade（providers/cascade）在决策点如实上报；本类零网络零
 * 时钟、绝不抛异常（脏入参安静消毒：非有限价格单位记 0）。
 */
export class CascadeMeter {
  private readonly primaryPrice: number;
  private cheapHitCount = 0;
  private escalatedCount = 0;
  private cheapCalls = 0;
  private cheapUnitsTotal = 0;
  private primaryCalls = 0;
  private primaryUnitsTotal = 0;
  private primaryDirectCount = 0;

  /** @param opts.primaryPrice 主力档相对价格（反事实基线单价）；脏值回退 1 */
  constructor(opts?: { primaryPrice?: number }) {
    const p = Number(opts?.primaryPrice);
    this.primaryPrice = Number.isFinite(p) && p > 0 ? p : 1;
  }

  /** 非负有限数消毒：脏值（NaN/负/∞）记 0（不抛铁律 + 只记真实的钱） */
  private static cleanUnits(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** 便宜答案过校验被采信：cheapUnits = 便宜档本次实际花费；cheapCalled = 是否真拨号 */
  recordCheapHit(cheapUnits: number, cheapCalled: boolean): void {
    this.cheapHitCount++;
    if (cheapCalled === true) {
      this.cheapCalls++;
      this.cheapUnitsTotal += CascadeMeter.cleanUnits(cheapUnits);
    }
  }

  /** 升级主力重做：cheapUnits/cheapCalled 同上（未拨号计 0）；主力档按 primaryPrice 记账 */
  recordEscalation(cheapUnits: number, cheapCalled: boolean): void {
    this.escalatedCount++;
    if (cheapCalled === true) {
      this.cheapCalls++;
      this.cheapUnitsTotal += CascadeMeter.cleanUnits(cheapUnits);
    }
    this.primaryCalls++;
    this.primaryUnitsTotal += this.primaryPrice;
  }

  /** 分诊判高危直行主力（级联队列之外，仅观测计数） */
  recordPrimaryDirect(): void {
    this.primaryDirectCount++;
  }

  /** 结构化快照 —— 全字段纯函数推导，可离线精确断言 */
  stats(): CascadeStats {
    const eligible = this.cheapHitCount + this.escalatedCount;
    const spentUnits = this.cheapUnitsTotal + this.primaryUnitsTotal;
    const baselineUnits = eligible * this.primaryPrice;
    const savedUnits = baselineUnits - spentUnits; // 统计诚实：可为负，不钳零
    return {
      eligible,
      cheapHit: this.cheapHitCount,
      escalated: this.escalatedCount,
      hitRate: eligible > 0 ? this.cheapHitCount / eligible : 0,
      cheapTier: { calls: this.cheapCalls, units: this.cheapUnitsTotal },
      primaryTier: { calls: this.primaryCalls, units: this.primaryUnitsTotal },
      spentUnits,
      baselineUnits,
      savedUnits,
      savingsRate: baselineUnits > 0 ? savedUnits / baselineUnits : 0,
      primaryDirect: this.primaryDirectCount,
    };
  }

  /** 清空台账（测试隔离用） */
  reset(): void {
    this.cheapHitCount = 0;
    this.escalatedCount = 0;
    this.cheapCalls = 0;
    this.cheapUnitsTotal = 0;
    this.primaryCalls = 0;
    this.primaryUnitsTotal = 0;
    this.primaryDirectCount = 0;
  }
}
