// src/kernel/registry.ts
// 纪元 Θ（Θ-1 内核注册表与证据账本）：全库写死的数学内核阈值 → 可进化参数的铸造现场。
//
// 三条先例律（本器官一字不违）：
//   · 区间语义照 src/knowledge/params.ts —— 区间是校准结论，缺省取区间内一点，
//     一切写径越界即夹取（clamp），区间外不存在状态；
//   · 单例 + reset 照 src/vlm/metering.ts —— 模块级单例贯穿插件生命周期，
//     resetKernelRuntime 供测试隔离（生产代码无理由清空生产注册表）；
//   · 垃圾输入静默降级、绝不抛异常 —— 与 metering 同律（诚实回声 / 静默忽略）。
// 纯离线零依赖：无 IO；updatedAt 走 Date.now（不注入墙钟 —— 值语义可测）。
// ΠΑΝ-50 例外申报：本件自此刻起持两处有向 import —— ① calibrator 的
// regressionPosteriorMass（Beta 后验数学件单源 —— 晋升回归守卫与校准器 ΝΩ-6
// 判决共用同一数学，绝不双份；calibrator 对本件仅类型引用，运行时无环）；
// ② lineage 的 KernelLineage 类型（纯类型，擦除后零耦合）。旧行注释的
// 「无 import」承诺就位时本件是纯数据面；ΠΑΝ-50 立法把晋升护栏放进本件
//（一切写径的执法点），护栏所需的数学与血统类型随立法进场。

// ΠΑΝ-50：晋升护栏缺省（与校准器 DEFAULT_GUARDRAILS 同律 —— 单步 10% 区间、
// 回归后验质量门 0.9；minLabEvidence 缺省 0 = 证据门默认关：gym 侧证据在
// ledger 滑窗不在 registry 计数，无 ledger 注入时无从执法，交给显式通道
// promoteFromCli 全副武装）。
import { regressionPosteriorMass } from './calibrator';
import type { KernelLineage } from './lineage';

/** ΠΑΝ-50：promoteFrom 的护栏与审计注入面（全部可选 —— 缺省 = 步长护栏 + 证据只升不降） */
export interface PromoteOptions {
  /** 显式 key 域（非字符串项剔除；缺省 = 双方在册交集 —— 既有语义） */
  keys?: string[];
  /** 步长上限：|to − 现值| ≤ maxStepPct × (max − min)（缺省 0.1；1 = 全程单跳） */
  maxStepPct?: number;
  /** 回归守卫的实验室证据门（labLedger 在场才执法；缺省 0 = 关） */
  minLabEvidence?: number;
  /** 回归守卫后验质量门（缺省 0.9 —— 与 ΝΩ-6 rollbackPosteriorMass 同律） */
  rollbackPosteriorMass?: number;
  /** 实验室台账（在场 ⇒ 回归守卫按滑窗 n/successRate 执法 —— gym 侧证据所在） */
  labLedger?: EvidenceLedger;
  /** 生产台账（在场 ⇒ 血统 fitness 取生产窗成功率；回归守卫的生产侧对照） */
  ledger?: EvidenceLedger;
  /** 血统（在场 ⇒ 晋升按血统法登记现代快照 + 新一代 —— 两套代数计数器自此同律） */
  lineage?: KernelLineage;
  /** 时钟注入（血统登记与 updatedAt 的确定性测试缝；缺省 Date.now） */
  now?: () => number;
}

/** ΠΑΝ-50：晋升清单行（key/from/to 面向与旧契约逐字节兼容 —— 老断言不动） */
export interface PromoteChange {
  key: string;
  from: number;
  to: number;
  /** 晋升形态：'promoted' 直落 | 'step-capped' 步长截断 | 'at-target' 值未变（仅代际/证据更新） */
  reason?: 'promoted' | 'step-capped' | 'at-target';
}

/** ΠΑΝ-50：promoteFrom 步长上限缺省（0.1 —— 与 DEFAULT_GUARDRAILS.maxStepPct 同值） */
const PROMOTE_DEFAULT_MAX_STEP_PCT = 0.1;
/** ΠΑΝ-50：promoteFrom 回归后验质量门缺省（0.9 —— 与 rollbackPosteriorMass 同值） */
const PROMOTE_DEFAULT_ROLLBACK_MASS = 0.9;

/** 内核参数规格：入册声明 —— key + 所属器官 + 缺省值 + 可行区间（+ 出处注记） */
export interface KernelParamSpec {
  /** 参数名（全局唯一键，非空字符串） */
  key: string;
  /** 所属器官名（消费方自定义词表；drift / promote 报表的归因维度） */
  organ: string;
  /** 缺省值（params.ts 律：缺省取区间内一点 —— 越界入册即夹取） */
  defaultValue: number;
  /** 可行区间下界（必须严格小于 max） */
  min: number;
  /** 可行区间上界（必须严格大于 min） */
  max: number;
  /** 区间出处注记（校准基准的实测结论，一字不虚；可选） */
  note?: string;
}

/** 入册后的内核参数：规格 + 运行时态（现值 / 证据计数 / 演化代际 / 最后变更时间戳） */
export interface KernelParam extends KernelParamSpec {
  /** 现值（不变式：恒在 [min, max] 内 —— register/set/restore/promote 皆夹取） */
  value: number;
  /** 证据累计计数（set/addEvidence 累积，promoteFrom 取实验室值；地板 0 不为负） */
  evidence: number;
  /** 演化代际（出厂 0；每次实验室晋升 +1 —— 世系计数，set/restore 不动它） */
  generation: number;
  /** 最后一次**数值**变更的时间戳（epoch ms；仅规格 / 证据更新不刷新它） */
  updatedAt: number;
}

/** 夹取：v 收进 [lo, hi]（调用方保证 v 有限、lo < hi —— 与 params.ts 同一区间语义） */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 垃圾 spec 回声的打标注记 —— 静默失败的唯一可观察面（入册与否以 has()/list() 为准） */
const IGNORED_SPEC_NOTE = '垃圾 spec：静默忽略，未入册（入册与否以 has()/list() 为准）';

/**
 * 规格体检 + 规格化：垃圾 spec 返回 null（绝不抛），合格 spec 返回全字段确定的
 * 规格副本（defaultValue 已夹入区间 —— params.ts「缺省取区间内一点」律）。
 * 垃圾判据：非对象 / key 非非空字符串 / organ 非字符串 / 三个数值任一非有限
 * （NaN、±Infinity 同罪）/ min ≥ max。
 */
function normalizeSpec(raw: KernelParamSpec): KernelParamSpec | null {
  const s = (raw ?? {}) as Partial<KernelParamSpec>;
  if (typeof s.key !== 'string' || s.key === '') return null;
  if (typeof s.organ !== 'string') return null;
  if (!Number.isFinite(s.defaultValue) || !Number.isFinite(s.min) || !Number.isFinite(s.max)) return null;
  const min = s.min as number;
  const max = s.max as number;
  if (min >= max) return null;
  const base: Omit<KernelParamSpec, 'note'> = {
    key: s.key,
    organ: s.organ,
    defaultValue: clamp(s.defaultValue as number, min, max),
    min,
    max,
  };
  return typeof s.note === 'string' ? { ...base, note: s.note } : base;
}

/**
 * 垃圾 spec 的未入册回声：字段尽力消毒（区间自洽、defaultValue 夹取），
 * note 打 IGNORED_SPEC_NOTE 标。它不入册、零副作用 —— register 对垃圾输入
 * 不许抛、也不改契约形状，故以「查无此 key」为失败判据，回声仅为调试线索。
 */
function ignoredEcho(raw: KernelParamSpec): KernelParam {
  const s = (raw ?? {}) as Partial<KernelParamSpec>;
  const min = Number.isFinite(s.min) ? (s.min as number) : 0;
  const maxRaw = Number.isFinite(s.max) ? (s.max as number) : 1;
  const max = maxRaw > min ? maxRaw : min + 1;
  const defaultValue = Number.isFinite(s.defaultValue)
    ? clamp(s.defaultValue as number, min, max)
    : min;
  return {
    key: typeof s.key === 'string' ? s.key : '',
    organ: typeof s.organ === 'string' ? s.organ : '',
    defaultValue,
    min,
    max,
    note: IGNORED_SPEC_NOTE,
    value: defaultValue,
    evidence: 0,
    generation: 0,
    updatedAt: 0,
  };
}

/**
 * 内核注册表：key → 参数（值 + 区间 + 证据 + 代际）的唯一权威源。
 *
 * 语义要点（全军团单位依赖的契约）：
 *   - 值不变式：一切写径（register 重夹 / set / restore / promoteFrom）恒夹取
 *     进 [min, max] —— 读方（get/getOrDefault/list/snapshot）永远拿到区间内值；
 *   - 绝不抛：垃圾输入静默忽略（register 的失败以 has()/list() 查无为准）；
 *   - updatedAt 只记数值变更（规格 / 证据更新不伪造「变过值」的痕迹）。
 */
export class KernelRegistry {
  /** 入册条目（插入序 = 入册序；防御纪律：对外只出副本） */
  private params = new Map<string, KernelParam>();

  /**
   * 入册（幂等）：
   *   - 新 key：value = 夹取后的 defaultValue，evidence = 0，generation = 0；
   *   - 重复注册：**保持现值**（新 bounds 越界即重夹 value）、证据与代际原样，
   *     只更新规格（organ / defaultValue / min / max / note —— note 未给即清除）；
   *   - 垃圾 spec（非对象 / key 空 / organ 非串 / 数值非有限 / min ≥ max）：
   *     **静默忽略，不入册**（has() 假、list() 查无此 key），返回 note 打
   *     「忽略」标的未入册回声（绝不抛、零副作用）；
   *   - 注册成功返回防御副本（篡改返回值不穿透注册表）。
   */
  register(spec: KernelParamSpec): KernelParam {
    const norm = normalizeSpec(spec);
    if (norm === null) return ignoredEcho(spec);
    const prev = this.params.get(norm.key);
    if (prev) {
      // 幂等重注册：现值重夹进新 bounds，证据 / 代际原样继承
      const value = clamp(prev.value, norm.min, norm.max);
      const next: KernelParam = {
        ...norm,
        value,
        evidence: prev.evidence,
        generation: prev.generation,
        updatedAt: value !== prev.value ? Date.now() : prev.updatedAt,
      };
      this.params.set(norm.key, next);
      return { ...next };
    }
    const fresh: KernelParam = {
      ...norm,
      value: norm.defaultValue,
      evidence: 0,
      generation: 0,
      updatedAt: Date.now(),
    };
    this.params.set(norm.key, fresh);
    return { ...fresh };
  }

  /** 是否在册（非字符串 key 一律 false） */
  has(key: string): boolean {
    return typeof key === 'string' && this.params.has(key);
  }

  /** 读现值：未注册返回 null（区间不变式保证返回值恒在 [min, max] 内） */
  get(key: string): number | null {
    const p = typeof key === 'string' ? this.params.get(key) : undefined;
    return p ? p.value : null;
  }

  /**
   * 读现值（生产缺省零行为变化的关键缝）：未注册 ⇒ 原样回声 fallback
   * （消费方以写死的字面量兜底时，行为与迁移前逐字节一致）；已注册 ⇒ 夹取后值
   * （不变式下即现值 —— 再夹一次是零成本的读侧防御）。
   */
  getOrDefault(key: string, fallback: number): number {
    const p = typeof key === 'string' ? this.params.get(key) : undefined;
    return p ? clamp(p.value, p.min, p.max) : fallback;
  }

  /**
   * 设值（先夹取后入账 —— 夹取是成功而非失败）：
   *   - 已注册 + 有限值：恒生效。区间内 ⇒ { ok: true }；越界 ⇒ 夹到边界后
   *     { ok: true, reason: 'clamped', clampedTo: 实际落值 }；
   *   - 未注册 ⇒ { ok: false, reason: 'unregistered' }（不动任何状态）；
   *   - 值非有限（NaN / ±Infinity）⇒ { ok: false, reason: 'invalid-value' }（现值不动）；
   *   - evidenceDelta：缺省 0（不动证据）；有限则累加（地板 0）。
   */
  set(key: string, value: number, evidenceDelta?: number): { ok: boolean; reason?: string; clampedTo?: number } {
    const p = typeof key === 'string' ? this.params.get(key) : undefined;
    if (!p) return { ok: false, reason: 'unregistered' };
    if (!Number.isFinite(value)) return { ok: false, reason: 'invalid-value' };
    const clamped = clamp(value, p.min, p.max);
    const d = Number.isFinite(evidenceDelta) ? (evidenceDelta as number) : 0;
    const changed = clamped !== p.value;
    this.params.set(key, {
      ...p,
      value: clamped,
      evidence: Math.max(0, p.evidence + d),
      updatedAt: changed ? Date.now() : p.updatedAt,
    });
    if (clamped !== value) return { ok: true, reason: 'clamped', clampedTo: clamped };
    return { ok: true };
  }

  /**
   * 证据累加：缺省 +1；delta 非有限按 0 计（垃圾增量不掺水）；累加后地板 0
   * （证据是计数，不为负）；未注册静默。只动 evidence，不动数值与 updatedAt。
   */
  addEvidence(key: string, delta?: number): void {
    const p = typeof key === 'string' ? this.params.get(key) : undefined;
    if (!p) return;
    const d = delta === undefined ? 1 : Number.isFinite(delta) ? delta : 0;
    this.params.set(key, { ...p, evidence: Math.max(0, p.evidence + d) });
  }

  /** 全册目录（审计 / 仪表盘用）：防御深拷贝 —— 字段皆基元，逐项复制即深拷贝，篡改不穿透 */
  list(): KernelParam[] {
    return [...this.params.values()].map(p => ({ ...p }));
  }

  /**
   * 漂移报表：driftPct = |value − defaultValue| / (max − min) × 100（手算可复现）。
   * 仅列偏离者（value ≠ defaultValue —— 未动过的参数不出列）；
   * defaultValue 入册即夹取 ⇒ 分子 ≤ 分母，driftPct 恒 ∈ [0, 100]。
   */
  drift(): Array<{ key: string; organ: string; driftPct: number; evidence: number; generation: number }> {
    const out: Array<{ key: string; organ: string; driftPct: number; evidence: number; generation: number }> = [];
    for (const p of this.params.values()) {
      if (p.value === p.defaultValue) continue;
      out.push({
        key: p.key,
        organ: p.organ,
        driftPct: (Math.abs(p.value - p.defaultValue) / (p.max - p.min)) * 100,
        evidence: p.evidence,
        generation: p.generation,
      });
    }
    return out;
  }

  /** 值快照：{ key: value }（新对象 —— 与注册表后续变动解耦；promote/restore 的载体） */
  snapshot(): Record<string, number> {
    const snap: Record<string, number> = {};
    for (const [k, p] of this.params) snap[k] = p.value;
    return snap;
  }

  /**
   * 从快照恢复：只恢复**已注册** key（未注册 key 静默忽略 —— 快照可含历史残迹），
   * 值重夹当时 bounds（快照可能出自旧区间）；非有限值静默跳过；证据与代际不动
   * （恢复的是数值，不是历史 —— 历史由 ledger 管）。
   */
  restore(snap: Record<string, number>): void {
    if (!snap || typeof snap !== 'object') return;
    for (const [k, v] of Object.entries(snap)) {
      const p = this.params.get(k);
      if (!p || !Number.isFinite(v)) continue;
      const value = clamp(v, p.min, p.max);
      this.params.set(k, {
        ...p,
        value,
        updatedAt: value !== p.value ? Date.now() : p.updatedAt,
      });
    }
  }

  /**
   * 实验室 → 生产晋升：把 lab 的值拷入本注册表（生产）。
   *   - key 域：显式 opts.keys（非字符串项剔除）∩ 双方在册；缺省 = 全部已注册交集；
   *     任一侧未注册的 key 跳过（lab 未注册不报错，生产未注册不动）；
   *   - 拷贝语义：to = lab 值**重夹生产 bounds**（实验室可以探得更宽的区间），
   *     generation + 1（世系 +1 代），updatedAt 仅数值变化时刷新；
   *   - 返回晋升清单：[{ key, from, to }]，值未变（from === to）也入清单 ——
   *     代际已更新，这是一次真实的晋升事件；
   *   - lab 非法（非 KernelRegistry）⇒ 空清单；晋升是拷贝不是移动 —— lab 不受影响。
   *
   * ΠΑΝ-50（晋升护栏 + 合法通道）：C1-9 M2 判定旧 promoteFrom 是全库约束最弱
   * 的写径（safetyCritical 键的「唯一合法通道」反而零护栏）：一次晋升可跳
   * [min,max] 任意点（绕过校准器 maxStepPct=10% 与回归守卫）、lineage 完全不被
   * 触碰（注册表代与血统代两套计数器自此漂移）、evidence 取不是加（生产累计
   * 证据被实验室小样本覆写）、无晋升审计。本方法自此执法四护栏（全部可注入
   * 覆盖，opts.guard 见 PromoteOptions）：
   *   ① 步长夹取：|to − 现值| ≤ maxStepPct × (max − min)（缺省 0.1，与校准器
   *      DEFAULT_GUARDRAILS.maxStepPct 同律）—— 沿方向截断，远距值经多次晋升
   *      逐步走近（每次都过证据门，不是一次跳到位）；maxStepPct=1 = 全程单跳
   *      （显式解除，测试/运维迁移用）；
   *   ② 过回归守卫（Beta-Bernoulli，与校准器 ΝΩ-6 同一数学件 regressionPosteriorMass）：
   *      labLedger 在场且该键实验室证据 n ≥ minLabEvidence(缺省 0=关) 时，若实验室
   *      窗成功率相对生产窗成功率的后验 P(rate_lab < rate_prod) ≥ rollbackPosteriorMass
   *      （缺省 0.9）⇒ 该键本批跳过（证据说实验室值更差 —— 晋升不许退化）；
   *      证据不足 ⇒ 不判（保守放行 —— 与校准器「证据不足维持现行为」同律）；
   *   ③ 血统记录：lineage 在场 ⇒ 晋升前对现代拍快照（fitness = 生产窗成功率，
   *      ledger 在场时取 stats().successRate，缺席按 0 —— 诚实下限且失败安全：
   *      fitness=0 使后续回归守卫永不误回滚）、晋升后 promote 新一代 —— 注册表
   *      代与血统代自此同律推进，校准器的回归守卫对被晋升的值有了执法面；
   *   ④ 证据计数不覆写：evidence := max(生产, lab)（只升不降 —— 生产累计证据
   *      不被实验室小样本覆写；旧「取 lab 的」语义废弃）。
   * 晋升审计：变更行延展 { key, from, to, reason }（reason = 'promoted' |
   * 'step-capped' | 'at-target'），跳过项入 skipped（结构化审计面 —— 老调用方
   * 只读 key/from/to 面向兼容）。绝不抛（垃圾注入静默回落缺省护栏）。
   */
  promoteFrom(lab: KernelRegistry, opts?: PromoteOptions): Array<PromoteChange> {
    if (!(lab instanceof KernelRegistry)) return [];
    this.lastPromoteSkips = []; // ΠΑΝ-50：跳过审计随每次晋升重立（不跨次累积）
    // ΠΑΝ-50：护栏消毒（绝不抛 —— 非法项回落缺省，与 set/ register 的垃圾静默同律）
    const maxStepPct =
      typeof opts?.maxStepPct === 'number' && Number.isFinite(opts.maxStepPct) && opts.maxStepPct >= 0 && opts.maxStepPct <= 1
        ? opts.maxStepPct
        : PROMOTE_DEFAULT_MAX_STEP_PCT;
    const minLabEvidence =
      typeof opts?.minLabEvidence === 'number' && Number.isFinite(opts.minLabEvidence) && opts.minLabEvidence >= 0
        ? opts.minLabEvidence
        : 0;
    const rollbackMass =
      typeof opts?.rollbackPosteriorMass === 'number' && Number.isFinite(opts.rollbackPosteriorMass) &&
      opts.rollbackPosteriorMass >= 0 && opts.rollbackPosteriorMass <= 1
        ? opts.rollbackPosteriorMass
        : PROMOTE_DEFAULT_ROLLBACK_MASS;
    const lineage = opts?.lineage ?? null;
    const labLedger = opts?.labLedger ?? null;
    const prodLedger = opts?.ledger ?? null;
    const nowFn = typeof opts?.now === 'function' ? opts.now : Date.now;

    const wanted = opts?.keys;
    const keys = Array.isArray(wanted)
      ? wanted.filter((k): k is string => typeof k === 'string')
      : [...this.params.keys()].filter(k => lab.params.has(k));
    const changes: Array<PromoteChange> = [];
    for (const key of keys) {
      const prod = this.params.get(key);
      const labP = lab.params.get(key);
      if (!prod || !labP) continue;

      // ΠΑΝ-50 ②：回归守卫（Beta 后验 —— lab 值显著更差 ⇒ 跳过该键）
      if (labLedger !== null && minLabEvidence > 0) {
        try {
          const labStats = labLedger.stats(key);
          const prodStats = prodLedger !== null ? prodLedger.stats(key) : null;
          if (labStats.n >= minLabEvidence && prodStats !== null && prodStats.n >= minLabEvidence) {
            const k = Math.min(labStats.n, Math.max(0, Math.round(labStats.successRate * labStats.n)));
            const mass = regressionPosteriorMass(k, labStats.n, prodStats.successRate);
            if (mass >= rollbackMass) {
              this.lastPromoteSkips.push({
                key,
                reason: `regression-guard: posterior P(rate_lab<rate_prod)=${Math.round(mass * 1000) / 1000} >= ${rollbackMass} @labN=${labStats.n} prodN=${prodStats.n} — lab value is evidence-wise worse, promotion refused`,
              });
              continue;
            }
          }
        } catch { /* 守卫故障 ⇒ 放行该键（旁路义务，绝不炸晋升） */ }
      }

      // ΠΑΝ-50 ①：步长夹取（沿方向截到上限；maxStepPct=1 时区间全程即单跳）
      const raw = clamp(labP.value, prod.min, prod.max);
      const limit = Math.max(0, maxStepPct * (prod.max - prod.min));
      let to = raw;
      let reason: PromoteChange['reason'] = raw === prod.value ? 'at-target' : 'promoted';
      if (Math.abs(raw - prod.value) > limit) {
        to = prod.value + (raw > prod.value ? limit : -limit);
        to = clamp(to, prod.min, prod.max);
        reason = 'step-capped';
      }

      // ΠΑΝ-50 ③：血统记录（现代快照 → 落值 → 新一代；fitness 诚实取生产窗成功率）
      if (lineage !== null) {
        try {
          let fitness = 0;
          if (prodLedger !== null) {
            const st = prodLedger.stats(key);
            fitness = Number.isFinite(st.successRate) ? st.successRate : 0;
          }
          lineage.record({
            key,
            generation: prod.generation,
            value: prod.value,
            fitness,
            createdAt: nowFn(),
          });
        } catch { /* 血统快照故障不阻断晋升（旁路义务） */ }
      }
      this.params.set(key, {
        ...prod,
        value: to,
        // ΠΑΝ-50 ④：证据只升不降（max —— 生产累计不被实验室小样本覆写）
        evidence: Math.max(prod.evidence, labP.evidence),
        generation: prod.generation + 1,
        updatedAt: to !== prod.value ? nowFn() : prod.updatedAt,
      });
      if (lineage !== null) {
        try {
          let fitness = 0;
          if (prodLedger !== null) {
            const st = prodLedger.stats(key);
            fitness = Number.isFinite(st.successRate) ? st.successRate : 0;
          }
          lineage.promote(key, to, fitness, nowFn());
        } catch { /* 血统推进故障不回滚值（血统是审计事实，尽力入账） */ }
      }
      changes.push({ key, from: prod.value, to, ...(reason !== 'promoted' ? { reason } : {}) });
    }
    return changes;
  }

  /**
   * ΠΑΝ-50：本注册表最近一次 promoteFrom 的跳过审计（结构化 — regression-guard
   * 拒绝的键与理由；每次 promoteFrom 开头清账）。只读消费面（CLI 报告/测试）。
   */
  get promoteSkips(): ReadonlyArray<{ key: string; reason: string }> {
    return this.lastPromoteSkips.slice();
  }

  /** ΠΑΝ-50：promoteFrom 跳过审计账（每次调用清账重立） */
  private lastPromoteSkips: Array<{ key: string; reason: string }> = [];

  /** 清空全部条目（测试隔离 / 会话切换用 —— 生产代码无理由调用） */
  reset(): void {
    this.params.clear();
  }
}

/** 生产单例：插件生命周期内唯一的生产注册表 —— 内核阈值的唯一权威源（实验室请自建实例） */
export const kernelRegistry: KernelRegistry = new KernelRegistry();

// ─── 证据账本：每 key 滑窗 200 的结果台账 ───

/** 内核结果原子：某参数的一次执行结果（成败、裕量、时间戳） */
export interface KernelOutcome {
  /** 参数名（非空字符串 —— 与注册表的 key 同一词表） */
  key: string;
  /** 成败（必须布尔 —— 判据非黑即白，不做程度折衷） */
  success: boolean;
  /** 成败裕量（判决边距 / 余量等；可选，仅有限值入账） */
  margin?: number;
  /** 结果时间戳（epoch ms；非有限消毒为 0） */
  ts: number;
  /**
   * 证据来源标记（ΑΩ-R41 provenance）：缺省缺席 = 既有语义 local（本地真实观察）；
   * 联邦掺入路径逐条打 'federation'（与本地观察在账本内可分离 —— 事后审计能区分
   * 「自己试出来的」与「联邦学来的」）。只立账不立规：calibrator / 统计读路径对
   * origin **零行为区分**（未来若要按来源加权，账已就绪）；水合/恢复路径对未知
   * origin 值防御式归 local（record 消毒：仅两已知字面量入账，其余一律缺席）。
   */
  origin?: 'local' | 'federation';
}

/** 每 key 滑窗容量：200 条 FIFO（内存有界，最近行为优先 —— 与 metering 的窗口取舍同律） */
const LEDGER_WINDOW = 200;

/** 账本内部条目（消毒后的 outcome：ts 已归零化、margin 仅有限值、origin 仅已知字面量） */
interface LedgerEntry {
  success: boolean;
  margin?: number;
  ts: number;
  origin?: 'local' | 'federation';
}

/**
 * 证据账本：逐 key 的结果滑窗（200 条 FIFO），为进化决策供成败率与裕量分布。
 * 垃圾输入静默（非对象 / key 非非空串 / success 非布尔 ⇒ 丢弃；ts 非有限消毒为 0）；
 * margins 与滑窗同序（旧 → 新），只含有 margin 的条目；一切读取出防御副本。
 */
export class EvidenceLedger {
  /** key → 滑窗（插入序 = 入账序；窗口满后挤最旧） */
  private windows = new Map<string, LedgerEntry[]>();

  /** 记一结果：垃圾输入静默丢弃；每 key 滑窗 200，第 201 条挤最旧（FIFO） */
  record(outcome: KernelOutcome): void {
    const o = (outcome ?? {}) as Partial<KernelOutcome>;
    if (typeof o.key !== 'string' || o.key === '') return;
    if (typeof o.success !== 'boolean') return;
    const entry: LedgerEntry = {
      success: o.success,
      ts: Number.isFinite(o.ts) ? (o.ts as number) : 0,
    };
    if (Number.isFinite(o.margin)) entry.margin = o.margin;
    // ΑΩ-R41 origin 消毒（水合/恢复的防御带）：仅两已知字面量入账；未知值（异版
    // 字符串 / 非串垃圾）一律缺席 —— 缺席即既有语义 local，账本永不持未知来源。
    if (o.origin === 'local' || o.origin === 'federation') entry.origin = o.origin;
    const win = this.windows.get(o.key) ?? [];
    win.push(entry);
    if (win.length > LEDGER_WINDOW) win.splice(0, win.length - LEDGER_WINDOW);
    this.windows.set(o.key, win);
  }

  /**
   * 窗口统计：n = 窗内条数（n = 0 ⇒ successRate = 0 —— 空窗诚实归零，不用 NaN 说谎）；
   * successRate = 窗内成功占比；margins = 窗内有 margin 条目的裕量列表（旧 → 新，防御副本）。
   */
  stats(key: string): { n: number; successRate: number; margins: number[] } {
    const win = typeof key === 'string' ? this.windows.get(key) : undefined;
    if (!win || win.length === 0) return { n: 0, successRate: 0, margins: [] };
    let succ = 0;
    const margins: number[] = [];
    for (const e of win) {
      if (e.success) succ++;
      if (e.margin !== undefined) margins.push(e.margin);
    }
    return { n: win.length, successRate: succ / win.length, margins };
  }

  /**
   * 纪元 Μ（万脑联邦）纯增量导出：窗口逐条证据的防御副本（旧 → 新）。
   * 动机：stats() 只给汇总（n / successRate / margins），「成败 × margin」联合
   * 分布无法从汇总重建 —— 联邦摘要铸造（src/federation/index.ts 的
   * mintEvidenceDigest）需要逐条读账才能铸出真联合直方图。
   * ΑΩ-R41：副本带 origin（缺席 = local —— 掺入审计与水合往返的分离面；防御式
   * 逐字段拷贝，未知字段不穿透）。契约：未知 key / 垃圾 key ⇒ 空数组；返回防御
   * 副本（改返回值不穿透账本）；零副作用、不触任何既有路径（纯增量立法）。
   */
  entries(key: string): Array<{ success: boolean; margin?: number; ts: number; origin?: 'local' | 'federation' }> {
    const win = typeof key === 'string' ? this.windows.get(key) : undefined;
    if (!win) return [];
    return win.map(e => {
      const out: { success: boolean; margin?: number; ts: number; origin?: 'local' | 'federation' } = {
        success: e.success,
        ts: e.ts,
      };
      if (e.margin !== undefined) out.margin = e.margin;
      if (e.origin !== undefined) out.origin = e.origin;
      return out;
    });
  }

  /** 有入账的 key 目录（插入序副本 —— 与注册表入册序解耦） */
  keys(): string[] {
    return [...this.windows.keys()];
  }

  /** 清空全部账本（测试隔离 / 会话切换用） */
  reset(): void {
    this.windows.clear();
  }
}

/** 单例：内核进化证据的全局台账（插件生命周期内唯一） */
export const evidenceLedger: EvidenceLedger = new EvidenceLedger();

/** 两单例齐 reset（测试隔离专用 —— 生产代码无理由清空生产态） */
export function resetKernelRuntime(): void {
  kernelRegistry.reset();
  evidenceLedger.reset();
}
