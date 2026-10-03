// src/kernel/calibrator.ts
// 纪元 Θ（Θ-2 在线校准器）：内核参数的证据驱动换血 —— 挂在 Θ-1 的
// (KernelRegistry, EvidenceLedger) 与本模块的 KernelLineage 三器官上，
// 每 tick 用最新证据水位把参数推动**一小步**（可回滚、可审计、可复现）。
//
// 与 src/calibration.ts（O 纪元标定原子）的血统关系：那是**离线原子** —— 给定
// 完整标签序列一次性产出标定值；本模块是在线版 —— 证据滑窗 + 证据门 + 步长上限 +
// 回归守卫，把同型寻优切成可回滚的小步。「样本 <8 不标定」的诚实下限律在此延续
// （optimalThreshold 样本不足 / 无判定结构 ⇒ null ⇒ 参数不动，字面量继续服役）。
//
// 兄弟契约：registry / ledger 的签名照 src/kernel/registry.ts（Θ-1）逐字引用
// （import type —— 类型即契约，运行时零耦合）。纯离线、零网络、零 IO、
// 全确定性（now 可注入）、绝不抛。

import type { KernelRegistry, EvidenceLedger, KernelParam } from './registry.js';
import type { KernelLineage } from './lineage.js';

/** 护栏（全部可注入覆盖；缺省见 DEFAULT_GUARDRAILS）。 */
export interface Guardrails {
  /** 证据门：stats.n < minEvidence 的参数本 tick 不动（证据不满，字面量继续服役） */
  minEvidence: number;
  /** 步长上限：|新值 − 现值| ≤ maxStepPct × (max − min)（一次一小步，进化可回滚） */
  maxStepPct: number;
  /** 回归容忍：successRate < 上代 fitness − rollbackDrop ⇒ 判回归 */
  rollbackDrop: number;
  /** 回归判定所需的变更后证据量（防小样本误杀回滚） */
  minPostEvidence: number;
}

/** 缺省护栏：满月证据 30、单步 10% 区间、跌 5 个百分点判回归、回归判定至少 20 条证据。 */
export const DEFAULT_GUARDRAILS: Guardrails = {
  minEvidence: 30,
  maxStepPct: 0.1,
  rollbackDrop: 0.05,
  minPostEvidence: 20,
};

/** 一次换血（或回归回滚）的审计记录。 */
export interface CalibrationReport {
  /** 参数键 */
  key: string;
  /** 变更前值 */
  from: number;
  /** 实际落值（registry 夹取后） */
  to: number;
  /** 判决理由（确定性字符串：optimal-threshold / regression-rollback 前缀） */
  reason: string;
  /** 新世代号（lineage 在场 ⇒ promote 后的血统世代；否则 registry 现行世代） */
  generation: number;
}

/** 校准器构造选项（registry / ledger 必给 —— 它们是校准的氧气）。 */
export interface CalibratorOptions {
  registry: KernelRegistry;
  ledger: EvidenceLedger;
  /** 血统（可选：缺省则不记谱、不回滚，只换值） */
  lineage?: KernelLineage;
  /** 护栏部分覆盖（非法项静默回落缺省 —— maxStepPct 须在 [0,1]） */
  guardrails?: Partial<Guardrails>;
  /** 时钟注入（确定性测试用；缺省 Date.now） */
  now?: () => number;
}

/** 千分位净化：reason 里的数字统一 3 位小数（确定性字符串）。 */
const fmt = (x: number): string => String(Math.round(x * 1000) / 1000);

/** 护栏数值消毒：非有限 / 越界 ⇒ 回落缺省值（绝不抛）。 */
function numOr(x: number | undefined, dflt: number, min: number, max: number): number {
  return typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max ? x : dflt;
}

/**
 * 最优阈（纯函数，绝不抛）：在「排序 margins 的相邻中点 + 两端」候选网格上找
 * **预测正确率**最大的阈值。预测语义：margin ≥ 阈 ⇒ 预测 success（与真实 label 对账）。
 *   - 平票（多候选同达最大正确率）⇒ 取这些候选的**中位数**（偶数个取中间两数均值）
 *     —— 保守居中，不偏向任何端（参数方向不定时不押注）；
 *   - 诚实下限（致敬 calibration.ts 的 <8 律）：净化后样本 <8 ⇒ null；
 *   - 全同 label（无可学的判定结构）⇒ null；
 *   - 垃圾静默：非有限 margin / 非布尔 label 的配对剔队；两数组按短者截齐。
 */
export function optimalThreshold(margins: readonly number[], labels: readonly boolean[]): number | null {
  const pairs: Array<{ m: number; y: boolean }> = [];
  const n = Math.min(margins?.length ?? 0, labels?.length ?? 0);
  for (let i = 0; i < n; i++) {
    const m = margins[i];
    const y = labels[i];
    if (Number.isFinite(m) && typeof y === 'boolean') pairs.push({ m, y });
  }
  if (pairs.length < 8) return null; // 诚实下限：样本不足不标定
  const nPos = pairs.filter(p => p.y).length;
  if (nPos === 0 || nPos === pairs.length) return null; // 全同 label：无判定结构

  // 候选网格：排序 margins 的相邻中点 + 两端（等值相邻 ⇒ 中点重合，跳过）
  const sorted = pairs.map(p => p.m).sort((a, b) => a - b);
  const cands: number[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const mid = (sorted[i - 1] + sorted[i]) / 2;
    if (mid > cands[cands.length - 1]) cands.push(mid);
  }
  if (sorted[sorted.length - 1] > cands[cands.length - 1]) cands.push(sorted[sorted.length - 1]);

  const EPS = 1e-12; // 正确率并列判定的浮点容差（整数对账本可精确并列，此为护栏）
  let bestAcc = -1;
  let tied: number[] = [];
  for (const t of cands) {
    let correct = 0;
    for (const p of pairs) if ((p.m >= t) === p.y) correct++;
    const acc = correct / pairs.length;
    if (acc > bestAcc + EPS) {
      bestAcc = acc;
      tied = [t];
    } else if (acc >= bestAcc - EPS) {
      tied.push(t);
    }
  }
  tied.sort((a, b) => a - b);
  const mid = (tied.length - 1) / 2;
  return (tied[Math.floor(mid)] + tied[Math.ceil(mid)]) / 2; // 平票 ⇒ 候选中位数
}

/**
 * tick 内的标签重建（内部确定性先验）：ledger.stats 只给 (n, successRate, margins)
 * 汇总、无逐样本标签 ⇒ 按「margin 单调有益」先验重建 —— margin 降序，
 * 前 round(successRate × 有效样本) 个记 success。零随机；重建标签与 margin 排序
 * 完全一致 ⇒ optimalThreshold 求得的恰是历史 margin 分布的 successRate 分位点
 * （语义：把参数设到「历史上恰好有 successRate 成功率」的 margin 水位 —— 分位标定）。
 * successRate=0 或 1 ⇒ 全同标签 ⇒ optimalThreshold 回 null（完美/全败参数皆无
 * 判定结构可学 —— 诚实不动）。
 */
function reconstructLabels(margins: readonly number[], successRate: number): boolean[] {
  const order = margins.map((m, i) => ({ m, i })).sort((a, b) => b.m - a.m); // 降序
  const k = Math.max(0, Math.min(margins.length, Math.round(successRate * margins.length)));
  const labels = new Array<boolean>(margins.length).fill(false);
  for (let r = 0; r < k; r++) labels[order[r].i] = true;
  return labels;
}

/**
 * 在线校准器：对 registry.list() 的每个参数按五律进化（见 tick 的 JSDoc）。
 * 绝不抛；一切外部故障（ledger/registry 抛异常、返回垃圾）按参数隔离、静默降级。
 */
export class KernelCalibrator {
  private readonly registry: KernelRegistry | null;
  private readonly ledger: EvidenceLedger | null;
  private readonly lineage: KernelLineage | null;
  private readonly guardrails: Guardrails;
  private readonly now: () => number;
  private readonly _history: CalibrationReport[] = [];

  constructor(opts?: CalibratorOptions) {
    this.registry = opts?.registry ?? null;
    this.ledger = opts?.ledger ?? null;
    this.lineage = opts?.lineage ?? null;
    const o = opts?.guardrails ?? {};
    this.guardrails = {
      minEvidence: numOr(o.minEvidence, DEFAULT_GUARDRAILS.minEvidence, 0, Infinity),
      maxStepPct: numOr(o.maxStepPct, DEFAULT_GUARDRAILS.maxStepPct, 0, 1),
      rollbackDrop: numOr(o.rollbackDrop, DEFAULT_GUARDRAILS.rollbackDrop, 0, 1),
      minPostEvidence: numOr(o.minPostEvidence, DEFAULT_GUARDRAILS.minPostEvidence, 0, Infinity),
    };
    this.now = typeof opts?.now === 'function' ? opts.now : () => Date.now();
  }

  /**
   * 一个校准 tick（全确定性，绝不抛）。对 registry.list() 每参数依次执法五律：
   *
   *  ① 证据门：ledger.stats(key).n < minEvidence ⇒ 跳过（证据不满不动参数）。
   *
   *  ⑤ 回归守卫（**先于变异** —— 若先变异再回滚，promote 会污染血统使回滚目标
   *     错位；回归期的参数本 tick 只回滚、不进化，防「先变异再回滚」的血统空转）：
   *     血统 ≥2 代 且 stats.n ≥ minPostEvidence 且 successRate < 上代 fitness −
   *     rollbackDrop（上代 = 血统倒数第二代的 fitness）⇒ 回滚到血统倒数第二代值；
   *     已回滚到位（目标 == 现值）⇒ 静默空转（不刷屏报告、不再变异）。
   *     回滚 Report 的 reason 注明 regression-rollback。
   *
   *  ② 候选阈：margins 非空 ⇒ 按分位先验重建标签（见 reconstructLabels）⇒
   *     optimalThreshold；阈为 null（样本不足 / 全同标签 / 全同 margin）或不在
   *     [min, max] 内 ⇒ 本 tick 不动（诚实下限，不硬拉）。
   *
   *  ③ 步长上限：|候选 − 现值| > maxStepPct × (max − min) ⇒ 沿方向截到上限。
   *     截点介于现值与候选之间 ⇒ 天然在界内（再夹一次 [min,max] 纯为数值护栏）；
   *     截后原地（目标 == 现值）⇒ 无换血。
   *
   *  ④ 换血：变更前 lineage.record 现代快照（fitness = 当前 successRate —— 只记
   *     观测事实，不引入探索奖励 / 随机）；registry.set 成功 ⇒ lineage.promote
   *     （fitness = 变更时 successRate）+ CalibrationReport 入史并随 tick 返回；
   *     set 被拒 ⇒ 静默放弃（血统快照无害留存，不立报告、不 promote）。
   *     report.generation = promote 后的血统世代（无 lineage ⇒ registry 现行世代）。
   *
   * 返回本 tick 的全部报告（同时累积进 history()）。
   */
  tick(): CalibrationReport[] {
    const reports: CalibrationReport[] = [];
    let params: KernelParam[];
    try {
      if (!this.registry || !this.ledger) return reports; // 器官缺位：诚实空转
      params = this.registry.list() ?? [];
    } catch {
      return reports; // registry 故障：静默降级
    }
    for (const p of params) {
      if (!p || typeof p.key !== 'string' || !Number.isFinite(p.value)) continue; // 垃圾条目跳过
      try {
        const r = this.calibrateOne(p);
        if (r) reports.push(r);
      } catch {
        /* 单参数故障隔离：绝不抛 */
      }
    }
    return reports;
  }

  /** 单参数执法（①→⑤→②→③→④，见 tick JSDoc 的次序论证）。 */
  private calibrateOne(p: KernelParam): CalibrationReport | null {
    const registry = this.registry;
    const ledger = this.ledger;
    if (!registry || !ledger) return null;
    const g = this.guardrails;

    let stats: { n: number; successRate: number; margins: readonly number[] };
    try {
      stats = ledger.stats(p.key);
    } catch {
      return null; // ledger 故障：本参数静默跳过
    }
    if (!stats || !Number.isFinite(stats.n) || stats.n < g.minEvidence) return null; // ① 证据门
    const rate = Number.isFinite(stats.successRate) ? stats.successRate : 0;

    // ⑤ 回归守卫（先于变异 —— 见 tick JSDoc）
    const rg = this.regressionGate(p, rate, stats.n);
    if (rg.regressed) return rg.report;

    // ② 候选阈
    const margins = Array.isArray(stats.margins)
      ? stats.margins.filter((m: number) => Number.isFinite(m))
      : [];
    if (margins.length === 0) return null;
    const threshold = optimalThreshold(margins, reconstructLabels(margins, rate));
    if (threshold === null) return null; // 诚实下限：无可学的判定结构
    if (threshold < p.min || threshold > p.max) return null; // 越界候选：不动（不硬拉）

    // ③ 步长上限（沿方向截断）
    const limit = Math.max(0, g.maxStepPct * (p.max - p.min));
    let target = threshold;
    let stepCapped = false;
    if (Math.abs(threshold - p.value) > limit) {
      target = p.value + (threshold > p.value ? limit : -limit);
      stepCapped = true;
    }
    target = Math.min(p.max, Math.max(p.min, target)); // 数值护栏（截点本应在界内）
    if (target === p.value) return null; // 截后原地：无换血

    // ④ 换血：现代快照 → set → 新世代
    if (this.lineage) {
      this.lineage.record({
        key: p.key,
        generation: p.generation,
        value: p.value,
        fitness: rate,
        createdAt: this.now(),
      });
    }
    let res: { ok: boolean; reason?: string; clampedTo?: number };
    try {
      res = registry.set(p.key, target);
    } catch {
      return null; // set 故障：静默放弃
    }
    if (!res || res.ok !== true) return null; // registry 拒绝：静默放弃
    const applied = typeof res.clampedTo === 'number' && Number.isFinite(res.clampedTo)
      ? res.clampedTo
      : target;

    let generation = p.generation;
    if (this.lineage) {
      generation = this.lineage.promote(p.key, applied, rate, this.now()).generation;
    }
    const report: CalibrationReport = {
      key: p.key,
      from: p.value,
      to: applied,
      reason: `optimal-threshold t=${fmt(threshold)} n=${fmt(stats.n)}${stepCapped ? ' step-capped' : ''}`,
      generation,
    };
    this._history.push(report);
    return report;
  }

  /**
   * ⑤ 回归守卫（判定 + 执行，见 tick JSDoc）：上代 = 血统倒数第二代。
   * regressed=true 表示本 tick 该参数已按回归处置（回滚报告或已回滚到位的静默）——
   * 调用方须短路变异路径。回滚目标 = 上代值；无二代血统不在此径（走 defaultValue
   * 是 rollback() 公开方法的职责）。
   */
  private regressionGate(
    p: KernelParam,
    rate: number,
    n: number,
  ): { regressed: boolean; report: CalibrationReport | null } {
    const g = this.guardrails;
    const none = { regressed: false, report: null } as const;
    if (!this.lineage || !this.registry) return none;
    if (!(n >= g.minPostEvidence)) return none; // 变更后证据不足：不判回归（防误杀）
    const gens = this.lineage.generations(p.key);
    if (gens.length < 2) return none; // 无上代可比
    const prev = gens[gens.length - 2];
    if (!Number.isFinite(prev.fitness)) return none;
    if (!(rate < prev.fitness - g.rollbackDrop)) return none; // 未跌出容忍带

    // 回归成立：本 tick 只回滚（或已回滚到位则静默），不再变异
    const target = Number.isFinite(prev.value) ? prev.value : p.defaultValue;
    if (target === p.value) return { regressed: true, report: null };
    let res: { ok: boolean; reason?: string; clampedTo?: number };
    try {
      res = this.registry.set(p.key, target);
    } catch {
      return { regressed: true, report: null };
    }
    if (!res || res.ok !== true) return { regressed: true, report: null };
    const applied = typeof res.clampedTo === 'number' && Number.isFinite(res.clampedTo)
      ? res.clampedTo
      : target;
    const report: CalibrationReport = {
      key: p.key,
      from: p.value,
      to: applied,
      reason: `regression-rollback: successRate ${fmt(rate)} < prevGenFitness ${fmt(prev.fitness)} - drop ${fmt(g.rollbackDrop)} @n=${fmt(n)}`,
      generation: prev.generation,
    };
    this._history.push(report);
    return { regressed: true, report };
  }

  /**
   * 手动回滚：回到血统倒数第二代值；**无二代血统 ⇒ 回 defaultValue**（出厂锚点）。
   * 已在目标位 / key 未注册 / set 被拒 ⇒ false（零副作用）。不立历史报告
   * （history 只记 tick 的执法痕迹）、不动血统（血统是审计事实，不因回滚重写）。
   */
  rollback(key: string): boolean {
    try {
      if (!this.registry || typeof key !== 'string' || key === '') return false;
      const params = this.registry.list() ?? [];
      const p = params.find(x => x && x.key === key);
      if (!p || !Number.isFinite(p.value)) return false;
      const gens = this.lineage ? this.lineage.generations(key) : [];
      const prev = gens.length >= 2 ? gens[gens.length - 2] : undefined;
      const target = prev !== undefined && Number.isFinite(prev.value) ? prev.value : p.defaultValue;
      if (!Number.isFinite(target) || target === p.value) return false;
      const res = this.registry.set(key, target);
      return !!res && res.ok === true;
    } catch {
      return false; // 绝不抛
    }
  }

  /** 校准史（tick 累积的报告）：防御副本 —— 改返回值不穿透内部账目。 */
  history(): readonly CalibrationReport[] {
    return this._history.slice();
  }

  /** 清空校准史（只清本类账目；registry / ledger / lineage 是注入器官，不处置）。 */
  reset(): void {
    this._history.length = 0;
  }
}
