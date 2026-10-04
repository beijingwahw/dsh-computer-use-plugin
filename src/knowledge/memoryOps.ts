// src/knowledge/memoryOps.ts
// W2-6（创新提案 M5：分类级记忆操作 Thompson 老虎机）—— 记忆操作即摇臂。
//
// 立法动机：知识库的四类记忆操作（insert / boost / evict / no-op）目前由全库
// 统一的静态常数执法（AUTO_LEARN_FAILURE_CONFIDENCE、P.REINFORCE_STEP 等）——
// 「error-pattern 要激进学习、preference 要保守」这类分类级差异没有表达通道。
// 本模块把「(category × 操作) 的操作阈值」铸成老虎机摇臂：每臂独立
// Beta(s+1, f+1) 后验，Thompson 采样决定该臂阈值（注册表区间内插值），
// 检索命中 × 注入助益作奖励反馈，EvidenceLedger 逐臂记账（200 条 FIFO）。
//
// 三条先例律（与 registry.ts / params.ts 同源，一字不违）：
//   · 统计正确 —— Beta 采样走 Marsaglia–Tsang Gamma 桥（后验均值可手算回验），
//     门限下不采样（Beta(1,1) 先验主导的采样 = 纯噪声）；
//   · seed 可复现 —— RNG 注入（seededRng 种子流），同 seed + 同账本态 ⇒ 逐位重放一致；
//   · 防御式绝不抛 —— 一切公共 API 对垃圾输入静默降级（Result 方言 / 诚实缺席），
//     采样与映射的每条路径都有迭代上限与有限值护栏（NaN 流不悬挂、不传染）。
//
// 与 kernelRegistry 的关系（M5 台账律）：
//   · 每臂一个注册键 `memory.op.<category>.<op>`（28 臂 = 7 类 × 4 操作），
//     带可行区间与证据计数入册 —— registerMemoryOpKernels() 幂等（重复注册
//     保持现值，registry 契约）；**不触碰既有 55 键的语义**（键名空间隔离）；
//   · EvidenceLedger 逐臂记成败（recordMemoryOpFeedback），registry.addEvidence
//     同步累加计数 —— 账本（成败明细）与注册表（计数摘要）双轨，单源双视图；
//   · 反馈不足（n < MEMORY_OP_FEEDBACK_GATE）⇒ 阈值恒为现行静态常数
//     （defaultValue = 各消费点现行字面量 —— 零行为变化的安全带）。
//
// sleep 接线（本模块不 import sleep —— 收敛器独立暴露，接线是宿主的事）：
//   sleep/index.ts 第④幕（校准幕）的 SleepDeps 增加可选面
//   `memoryOpsConverger?: () => MemoryOpsConvergenceReport`，actCalibrate 旁挂调用
//   convergeMemoryOps({ seed: <水位线或确定性种子> })，报告条目并入晨报 ——
//   立法与纪元 Ζ 标定建议书同律：「睡眠出收敛、白天做决定」的落值版。

import type { KnowledgeCategory, KnowledgeEntry } from './contracts';
import type { RunMetricRecord } from './metrics';
import { kernelRegistry, evidenceLedger, type KernelParamSpec } from '../kernel/registry';

// ─── W2-6：依赖面（结构子集 —— 生产传单例，测试传隔离实例；皆为真实类同构形状）───

/** 注册表面（KernelRegistry 的结构子集：入册 / 读值 / 设值 / 计数） */
export interface MemoryOpRegistryLike {
  register(spec: KernelParamSpec): unknown;
  getOrDefault(key: string, fallback: number): number;
  set(key: string, value: number, evidenceDelta?: number): { ok: boolean };
  addEvidence(key: string, delta?: number): unknown;
}

/** 账本面（EvidenceLedger 的结构子集：记原子 / 窗口统计） */
export interface MemoryOpLedgerLike {
  record(o: { key: string; success: boolean; ts: number }): unknown;
  stats(key: string): { n: number; successRate: number };
}

// ─── W2-6：臂空间（分类学 × 操作全集 —— 与 knowledgeBase.ts CATEGORIES 同序同词表）───

/** 记忆操作四类（摇臂的动作词表）：入库 / 强化 / 驱逐 / 弃权 */
export const MEMORY_OP_KINDS = ['insert', 'boost', 'evict', 'noop'] as const;
export type MemoryOpKind = (typeof MEMORY_OP_KINDS)[number];

/** 分类学全集（与 contracts.KnowledgeCategory 同词表、与 knowledgeBase CATEGORIES 同序） */
export const MEMORY_OP_CATEGORIES: ReadonlyArray<KnowledgeCategory> = [
  'ui-pattern', 'shortcut', 'system-quirk',
  'business-rule', 'error-pattern', 'workflow', 'preference',
];

/**
 * 每臂操作阈值的可行区间与现行静态常数（defaultValue = 消费点现行字面量 ——
 * n < 门限时零行为变化的锚）。区间出处：
 *   · insert [0.1, 0.6] / 缺省 0.3 —— AUTO_LEARN_FAILURE_CONFIDENCE（knowledgeBase.ts：
 *     自体学习失败铸造的初始置信）；区间下界 0.1 = 再低则噪声入库，上界 0.6 =
 *     压制阈值量级（REFLEX_SUPPRESS_CONFIDENCE 上沿）；
 *   · boost [0.2, 1.0] / 缺省 0.3 —— P.REINFORCE_STEP，区间照 params.ts 注记的
 *     可行区间原文（下界由 E3 物理约束定标：3 次复证必须过压制线）；
 *   · evict [0.01, 0.3] / 缺省 0.05 —— 有效置信驱逐地板（新锚：现行容量驱逐
 *     MAX_ENTRIES 不动，本键是「按置信让位」的新通道，0.05 = 极保守起点）；
 *   · noop [0.2, 0.65] / 缺省 0.2 —— P.VERIFY_TRUST_FLOOR 同值同区间（params.ts
 *     注记的可行区间原文）：低于该信任的操作让位 no-op（少干预）。
 */
const OP_THRESHOLDS: Readonly<Record<MemoryOpKind, { min: number; max: number; defaultValue: number; note: string }>> = {
  insert: {
    min: 0.1, max: 0.6, defaultValue: 0.3,
    note: 'auto-learn 入库置信门槛：低于此值的新学条目不入库（缺省 0.3 = AUTO_LEARN_FAILURE_CONFIDENCE 现行字面量）',
  },
  boost: {
    min: 0.2, max: 1.0, defaultValue: 0.3,
    note: '该类条目复证强化步长：confidence += (1-confidence)×此值（缺省 0.3 = P.REINFORCE_STEP 现行字面量；区间照 params.ts）',
  },
  evict: {
    min: 0.01, max: 0.3, defaultValue: 0.05,
    note: '有效置信驱逐地板：衰减后有效置信低于此值的 auto-learn 条目可被让位（缺省 0.05 极保守；现行容量驱逐路径不受此键影响）',
  },
  noop: {
    min: 0.2, max: 0.65, defaultValue: 0.2,
    note: '弃权门槛：该类条目信任低于此值时记忆操作让位 no-op（缺省 0.2 = P.VERIFY_TRUST_FLOOR 现行字面量；区间照 params.ts）',
  },
};

/** 注册键铸造：`memory.op.<category>.<op>`（点分词表与既有 55 键同风格） */
export function memoryOpKey(category: KnowledgeCategory, op: MemoryOpKind): string {
  return `memory.op.${category}.${op}`;
}

/** 全部 28 臂的注册规格（分类学序 × 操作序 —— 确定性枚举序，重放的轴之一） */
export function memoryOpSpecs(): KernelParamSpec[] {
  const specs: KernelParamSpec[] = [];
  for (const category of MEMORY_OP_CATEGORIES) {
    for (const op of MEMORY_OP_KINDS) {
      const t = OP_THRESHOLDS[op];
      specs.push({
        key: memoryOpKey(category, op),
        organ: 'knowledge',
        defaultValue: t.defaultValue,
        min: t.min,
        max: t.max,
        note: `W2-6 ${t.note} [category=${category}]`,
      });
    }
  }
  return specs;
}

/** 臂规格查表（词表内臂 ⇒ 必中；垃圾输入 ⇒ null —— 纯查表绝不抛） */
export function memoryOpSpecOf(key: string): KernelParamSpec | null {
  for (const s of memoryOpSpecs()) if (s.key === key) return s;
  return null;
}

/**
 * 幂等入册（M5 台账律）：把 28 个 memory.op.* 阈值键注册进注册表。
 * 首次 ⇒ value = defaultValue（零行为变化）；重入 ⇒ 保持现值只刷规格
 * （registry.register 幂等契约）。返回入册键数（审计面）。
 */
export function registerMemoryOpKernels(registry: MemoryOpRegistryLike = kernelRegistry): number {
  let n = 0;
  for (const spec of memoryOpSpecs()) {
    registry.register(spec);
    n += 1;
  }
  return n;
}

// W6-2（doctor smell.over-engineering 清偿）：确定性 RNG 与 Beta 采样已分区提取至
// memoryOps.random.ts（纯数学，行为零变化）；导入面不变 —— 再分发。
import { seededRng, betaSample, betaPosteriorFromStats, type SeededRng } from './memoryOps.random';
export { seededRng, betaSample, betaPosterior, betaPosteriorFromStats } from './memoryOps.random';
export type { SeededRng } from './memoryOps.random';



// ─── W2-6：奖励函数（M5 规格：奖励 = 该条目 N 天内被检索命中 + 注入后助益）───

/** 奖励窗口缺省：7 天（M5 规格的 N —— 一周的自然任务周期量级） */
export const DEFAULT_REWARD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 逐条目二元奖励判定（纯函数，手算可回验）：
 *   success := 命中(hit) ∧ 助益(helped)
 *   · hit = 该条目被检索过（usageCount > 0 —— query 的使用度簿记）；
 *   · helped = 窗口内存在「知识注入在场（knowledgeRounds > 0）且 run 完成
 *     （verdict === 'completed'）」的 run 记录（metrics.ts 命中统计的反馈源 ——
 *     注入在场 = 经验被消费，run 完成 = 消费有助益）。
 * 未命中或未助益 ⇒ failure（占库不产出 / 产出未变现，都是操作的机会成本）。
 */
export function evaluateMemoryOpSuccess(hit: boolean, helped: boolean): boolean {
  return hit === true && helped === true;
}

/** 逐类别试验账：窗口内每条目一次伯努利试验的成败计数 */
export interface CategoryTrials {
  successes: number;
  failures: number;
  /** 参与窗口的条目数（= successes + failures 的审计对账面） */
  entries: number;
}

/**
 * 奖励收割（metrics 反馈源 → 逐类别试验账）：
 *   · 窗口 W = [now − windowMs, now]；runs 取 ts ∈ W，条目取 updatedAt ∈ W
 *     （usageCount 无逐次时间戳 —— updatedAt 是最后一次触碰的诚实代理，文档在案）；
 *   · helped 见 evaluateMemoryOpSuccess；逐类别逐条目判定成败。
 * 垃圾输入（非数组 / 字段缺失 / 时间戳畸形）静默跳过 —— 绝不抛。返回恒为全分类学
 * 键的完整映射（无数据类别 = 全零账，不缺席 —— 消费方可直索引）。
 */
export function harvestMemoryOpRewards(
  entries: readonly KnowledgeEntry[] | null | undefined,
  runs: readonly RunMetricRecord[] | null | undefined,
  opts?: { windowMs?: number; now?: number },
): Record<KnowledgeCategory, CategoryTrials> {
  const out = {} as Record<KnowledgeCategory, CategoryTrials>;
  for (const c of MEMORY_OP_CATEGORIES) out[c] = { successes: 0, failures: 0, entries: 0 };
  const windowMs = Number.isFinite(opts?.windowMs) && (opts?.windowMs as number) > 0
    ? (opts?.windowMs as number) : DEFAULT_REWARD_WINDOW_MS;
  const now = Number.isFinite(opts?.now) ? (opts?.now as number) : Date.now();
  // 助益判定：窗口内知识消费 run 的完成性（metrics 命中统计反馈源的唯一消费点）
  let helped = false;
  if (Array.isArray(runs)) {
    for (const r of runs) {
      if (!r || typeof r !== 'object') continue;
      const ts = (r as Partial<RunMetricRecord>).ts;
      const kr = (r as Partial<RunMetricRecord>).knowledgeRounds;
      if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < now - windowMs || ts > now) continue;
      if (typeof kr !== 'number' || !Number.isFinite(kr)) continue;
      if (kr > 0 && r.verdict === 'completed') { helped = true; break; }
    }
  }
  if (!Array.isArray(entries)) return out;
  // isArray 守卫把 readonly KnowledgeEntry[] 窄化成与 any[] 的交集（元素被 any
  // 传染 —— TS 已知行为），显式还原元素类型；运行时垃圾防御靠下方逐字段守卫
  const list = entries as readonly KnowledgeEntry[];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    if (!(MEMORY_OP_CATEGORIES as readonly unknown[]).includes(e.category)) continue;
    if (typeof e.updatedAt !== 'number' || !Number.isFinite(e.updatedAt)) continue;
    if (e.updatedAt < now - windowMs || e.updatedAt > now) continue;
    const hit = typeof e.usageCount === 'number' && e.usageCount > 0;
    const success = evaluateMemoryOpSuccess(hit, helped);
    const t = out[e.category];
    t.entries += 1;
    if (success) t.successes += 1; else t.failures += 1;
  }
  return out;
}

// ─── W2-6：反馈记账（EvidenceLedger 逐臂成败 + registry 证据计数）───

/** 记账依赖面（生产传单例，测试传隔离实例） */
export interface MemoryOpFeedbackDeps {
  registry?: MemoryOpRegistryLike;
  ledger?: MemoryOpLedgerLike;
  ts?: number;
}

/**
 * 记一次 (category × op) 臂成败：EvidenceLedger 记原子（200 FIFO 滑窗由账本保证），
 * registry.addEvidence 同步 +1（计数摘要轨）。幂等入册先行（键必须在册才可记账 ——
 * 台账律）。垃圾输入 {ok:false} 绝不抛；诚实记账恒 {ok:true}。
 */
export function recordMemoryOpFeedback(
  category: unknown,
  op: unknown,
  success: unknown,
  deps: MemoryOpFeedbackDeps | null = {},
): { ok: boolean; reason?: string } {
  if (!(MEMORY_OP_CATEGORIES as readonly unknown[]).includes(category)) {
    return { ok: false, reason: `unknown category ${JSON.stringify(category)}` };
  }
  if (!(MEMORY_OP_KINDS as readonly unknown[]).includes(op)) {
    return { ok: false, reason: `unknown op ${JSON.stringify(op)}` };
  }
  if (typeof success !== 'boolean') {
    return { ok: false, reason: `success must be boolean, got ${typeof success}` };
  }
  const d = deps ?? {};
  const registry = d.registry ?? kernelRegistry;
  const ledger = d.ledger ?? evidenceLedger;
  const key = memoryOpKey(category as KnowledgeCategory, op as MemoryOpKind);
  try {
    registerMemoryOpKernels(registry);
    ledger.record({ key, success, ts: Number.isFinite(d.ts) ? (d.ts as number) : Date.now() });
    registry.addEvidence(key, 1);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'ledger/registry degraded (never throws)' };
  }
}

/**
 * 收割账 → 逐臂记账（把 harvestMemoryOpRewards 的逐类别试验写进指定操作的臂）。
 * 缺省记入 'insert' 臂（条目在场 = 入库操作的产物 —— 奖励通道的默认语义）；
 * 显式 op 可把同一份试验账归因到 boost/evict/noop 臂。返回记账总数（审计面）。
 */
export function applyHarvestedRewards(
  trials: Partial<Record<KnowledgeCategory, CategoryTrials>> | null | undefined,
  op: MemoryOpKind = 'insert',
  deps: MemoryOpFeedbackDeps | null = {},
): number {
  if (!trials || typeof trials !== 'object') return 0;
  const d = deps ?? {};
  let recorded = 0;
  for (const c of MEMORY_OP_CATEGORIES) {
    const t = trials[c];
    if (!t || typeof t !== 'object') continue;
    const s = Number.isFinite(t.successes) && t.successes > 0 ? Math.round(t.successes) : 0;
    const f = Number.isFinite(t.failures) && t.failures > 0 ? Math.round(t.failures) : 0;
    for (let i = 0; i < s; i++) {
      if (recordMemoryOpFeedback(c, op, true, d).ok) recorded += 1;
    }
    for (let i = 0; i < f; i++) {
      if (recordMemoryOpFeedback(c, op, false, d).ok) recorded += 1;
    }
  }
  return recorded;
}

// ─── W2-6：阈值决策（采样 → 区间插值 → 夹取 —— 臂的动作参数）───

/** 反馈门限：每臂 n < 8 不采样（Beta(1,1) 先验主导 ⇒ 采样是噪声 —— 用静态常数） */
export const MEMORY_OP_FEEDBACK_GATE = 8;

/** 决策依赖面（注入缝 —— 隔离测试与重放的地基） */
export interface MemoryOpDecisionDeps {
  registry?: MemoryOpRegistryLike;
  ledger?: MemoryOpLedgerLike;
  rng?: SeededRng;
  gate?: number;
}

/** 单臂决策（纯查询 —— 不写注册表）：来源 = 静态常数 | Thompson 采样 */
export interface MemoryOpDecision {
  key: string;
  category: KnowledgeCategory;
  op: MemoryOpKind;
  /** 本臂阈值（恒在注册区间内 —— 插值 + 双侧夹取） */
  threshold: number;
  /** 'static-default'：n < 门限（零行为变化）；'thompson-sample'：后验采样 */
  source: 'static-default' | 'thompson-sample';
  n: number;
  successes: number;
  failures: number;
  alpha: number;
  beta: number;
  /** 采样原值 θ ∈ [0,1]（source='thompson-sample' 时在场 —— 审计面） */
  sample?: number;
}

/**
 * 采样 → 阈值（纯函数，手算可回验）：θ 插值 min + θ×(max−min)，双侧夹取；
 * θ 非有限 ⇒ 区间中点（无偏回退 —— NaN 不许传染进注册表）。
 */
export function thresholdFromSample(sample: number, min: number, max: number): number {
  const lo = Number.isFinite(min) ? min : 0;
  const hiRaw = Number.isFinite(max) ? max : 1;
  const hi = hiRaw > lo ? hiRaw : lo + 1;
  if (!Number.isFinite(sample)) return lo + (hi - lo) / 2;
  const t = Math.min(1, Math.max(0, sample));
  const v = lo + t * (hi - lo);
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 单臂决策：查账 → 门限判定 → （过门限）Beta 采样 → 区间插值。垃圾臂返回
 * null（绝不抛）。rng 缺省 = 按臂状态派生的种子流（决策本身可重放）：
 * seed = `<key>#<n>#<alpha>#<beta>` —— 同账本态 ⇒ 同阈值。
 */
export function decideMemoryOpThreshold(
  category: unknown,
  op: unknown,
  deps: MemoryOpDecisionDeps | null = {},
): MemoryOpDecision | null {
  if (!(MEMORY_OP_CATEGORIES as readonly unknown[]).includes(category)) return null;
  if (!(MEMORY_OP_KINDS as readonly unknown[]).includes(op)) return null;
  const key = memoryOpKey(category as KnowledgeCategory, op as MemoryOpKind);
  const spec = memoryOpSpecOf(key);
  if (!spec) return null; // 防御带（词表同源 ⇒ 实际不可达）
  try {
    const d = deps ?? {}; // null deps 走生产单例缺省（绝不抛）
    const registry = d.registry ?? kernelRegistry;
    const ledger = d.ledger ?? evidenceLedger;
    registerMemoryOpKernels(registry);
    const stats = ledger.stats(key);
    const { alpha, beta } = betaPosteriorFromStats(stats.n, stats.successRate);
    const n = Number.isFinite(stats.n) ? stats.n : 0;
    const successes = alpha - 1;
    const failures = beta - 1;
    const gate = Number.isFinite(d.gate) && (d.gate as number) >= 0
      ? (d.gate as number) : MEMORY_OP_FEEDBACK_GATE;
    if (n < gate) {
      // 安全带：反馈不足 ⇒ 现行静态常数（零行为变化 —— 不采样、不受漂移值牵连）
      return {
        key, category: category as KnowledgeCategory, op: op as MemoryOpKind,
        threshold: spec.defaultValue, source: 'static-default',
        n, successes, failures, alpha, beta,
      };
    }
    const rng = d.rng ?? seededRng(`${key}#${n}#${alpha}#${beta}`);
    const sample = betaSample(alpha, beta, rng);
    return {
      key, category: category as KnowledgeCategory, op: op as MemoryOpKind,
      threshold: thresholdFromSample(sample, spec.min, spec.max),
      source: 'thompson-sample',
      n, successes, failures, alpha, beta, sample,
    };
  } catch {
    return null; // 依赖面意外故障：诚实缺席（绝不抛）
  }
}

// ─── W2-6：收敛晋升（sleep 第④幕的落值面 —— convergeMemoryOps 由宿主接线）───

/** 收敛报告（晨报的 memory-ops 条目形状 —— 一切字段确定性可重放） */
export interface MemoryOpsConvergenceReport {
  /** 总臂数（28 = 7 类 × 4 操作 —— 结构常量的审计对账面） */
  arms: number;
  /** 过门限并落值的臂（setOk=false 是依赖面故障的诚实注记，不是异常） */
  converged: Array<MemoryOpDecision & { from: number; to: number; setOk: boolean }>;
  /** n < 门限按兵不动的臂（零行为变化的安全带审计面） */
  held: Array<{ key: string; category: KnowledgeCategory; op: MemoryOpKind; n: number; reason: 'insufficient-feedback' }>;
  /** 种子（重放的钥匙 —— rng 显式注入时记 '<injected-rng>'） */
  seed: string;
}

export interface MemoryOpsConvergeDeps extends MemoryOpDecisionDeps {
  /** 种子：与 rng 二选一（rng 优先）；都不给 ⇒ 按当时钟派生（非重放 —— 文档在案） */
  seed?: string | number;
}

/**
 * 收敛晋升（校准幕的落值面）：28 臂依确定性序逐臂决策 ——
 *   · n ≥ 门限 ⇒ Thompson 采样阈值 → registry.set（registry 写径自夹取，
 *     本侧 thresholdFromSample 先夹 —— 双侧安全带）；
 *   · n < 门限 ⇒ 按兵不动（held —— 值保持 defaultValue，零行为变化）。
 * 种子律：opts.rng ?? seededRng(opts.seed ?? `memory-ops@${Date.now()}`) ——
 * 同种子 + 同账本态 ⇒ 报告与落值逐位重放一致（测试即以此验收）。
 * 永不抛：单臂依赖故障收敛为该臂缺席 / setOk:false，不连坐其余臂
 * （sleep 旁路仪式同律 —— 睡眠绝不为一臂的故障失眠）。
 */
export function convergeMemoryOps(opts: MemoryOpsConvergeDeps | null = {}): MemoryOpsConvergenceReport {
  const o = opts ?? {}; // null opts 走生产单例 + 派生种子（绝不抛）
  const registry = o.registry ?? kernelRegistry;
  const ledger = o.ledger ?? evidenceLedger;
  const seedStr = o.rng ? '<injected-rng>' : o.seed !== undefined ? String(o.seed) : `memory-ops@${Date.now()}`;
  const rng = o.rng ?? seededRng(seedStr);
  const report: MemoryOpsConvergenceReport = {
    arms: MEMORY_OP_CATEGORIES.length * MEMORY_OP_KINDS.length,
    converged: [], held: [], seed: seedStr,
  };
  for (const category of MEMORY_OP_CATEGORIES) {
    for (const op of MEMORY_OP_KINDS) {
      try {
        const decision = decideMemoryOpThreshold(category, op, { registry, ledger, rng, gate: o.gate });
        if (decision === null) continue; // 词表内臂的决策不会 null —— 防御带
        if (decision.source === 'static-default') {
          report.held.push({ key: decision.key, category, op, n: decision.n, reason: 'insufficient-feedback' });
          continue;
        }
        const from = registry.getOrDefault(decision.key, decision.threshold);
        const setRes = registry.set(decision.key, decision.threshold);
        report.converged.push({ ...decision, from, to: decision.threshold, setOk: setRes.ok });
      } catch {
        // 单臂意外故障：跳过（收敛是旁路仪式 —— 一臂的故障不连坐其余 27 臂）
      }
    }
  }
  return report;
}
