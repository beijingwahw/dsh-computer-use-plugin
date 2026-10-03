// src/autonomy/evolutionEngine.ts
// 纪元 Φ（自主智能环）·Φ-5 自主进化引擎：每次自主运行后蒸馏技能、记教训、调策略权重——跑一次聪明一次。

/**
 * Φ-5：自主进化引擎（纯离线模块——零网络、零 sharp、零兄弟运行时依赖，本文件零 import）。
 *
 * 设计哲学：不缓存任何派生状态。history 是唯一事实源（有界环形，上限 200——
 * 超限旧记录挤出保新）；权重表 / 教训 / 蒸馏技能 /
 * 下一轮建议全部在 report() 与 heuristics() 被调用时从 history **重放推导**——
 * 每一次读数都基于当下全部历史，绝无「增量缓存与真实历史错位」的窗口
 * （swarm.counterfactual 的纯派生风味）。可靠度语义自持确定性递增
 * （首蒸馏 0.5，同 goal 复蒸馏 +0.1 封顶 0.95）——风味上参考 skillLibrary 的
 * Laplace 平滑 (s+1)/(n+2)（新技能谨慎起步、复验逐步加信），但绝不 import。
 *
 * ── 进化律（全部确定性：同 history 必得同报告） ──
 *
 * 【权重律】五策略权重表 { scroll, inspect, ask_vlm, recall_skill, click }
 * 初值全 1.0，按 history 逐轮重放调整：
 *   1. 成功运行：出现过的策略（**去重**——一次运行的证据量是 1，click 出现 3 次
 *      不代表 click 更可信 3 倍）各 +0.1，封顶 2.0。
 *   2. 失败运行：最后两个策略（**位置语义**——slice(-2)，重复策略叠加计罚：
 *      末两步都是 click = 双重嫌疑）各 -0.15，下限 0.2。
 *   3. 恢复加成：failureRootCause 含关键词（大小写不敏感）⇒ 对症恢复策略 +0.05
 *      （封顶 2.0）。确定性映射：popup→inspect、focus→inspect（弹窗遮蔽/焦点
 *      丢失都该先 inspect 看清现场再动手）、ocr→ask_vlm（文字读不出就换视觉
 *      模型直读）。多关键词并存则各自生效一次（叠加）。
 *   4. 权重表只认五个内建键：轨迹中的其他 kind 不入表（表形状恒定，
 *      heuristics() 永远恰好五键）。
 *
 * 【教训律】lessons 从 history 派生（插入序 = 首见序）：
 *   1. 失败 ⇒ 记一条教训，句首前缀 = failureSignature（同签名可检索）。
 *   2. 同一签名第 2 次出现 ⇒ 原句**升级**为「重复失败模式（第 N 次出现）」更高
 *      优先级句式，且同签名永远只占一席（去重升级，不刷屏）。
 *   3. 成功但 steps > distillMaxSteps×2 ⇒ 「低效路径」教训（同 goal 去重，
 *      记首次触发的步数）。
 *
 * 【蒸馏律】shouldDistillSkill 门通过（成功 && steps≤N && strategies 非空）
 * 才产出技能：description=`自动技能：${goal}`，steps=strategies 压成**单条可读
 * 路径串**（'click → scroll'——宏的最小表述，消费方按 ' → ' 切分即可还原），
 * 首蒸馏 reliability=0.5；同 goal 已蒸馏过 ⇒ 不重复建卡，仅 reliability
 * +0.1（封顶 0.95）。report 的 distilledSkill = 最近一次可蒸馏运行触达的技能
 * （蒸馏记忆持续在场；无可蒸馏历史 ⇒ 字段缺省）。
 *
 * 【建议律】nextRunAdvice 三分支（固定次序）：
 *   1. 恒在：权重表最高者推荐先行（平票按 scroll/inspect/ask_vlm/recall_skill/
 *      click 固定序裁决——确定性平票法院）；
 *   2. 重复失败签名（出现 ≥2 次——单次失败是噪声不是信号，swarm 同律）⇒ 建议
 *      该场景直接 escalate（换路径/求助，勿原样重试）；
 *   3. 已有蒸馏技能 ⇒ 建议下一轮优先 recall_skill 复用已验证路径。
 *
 * ── W1-5：EXP4 上下文老虎机（在旧权重律之上并置的第二进化轨道） ──
 *
 * 策略臂 = 五个内建策略（HEURISTIC_ORDER）。上下文特征 x = [场景标签 one-hot
 * (16 桶哈希) | 失败签名簇 id one-hot(8 桶) | 世界/任务种类 one-hot(8 桶) |
 * 剩余步数比(连续夹取 [0,1]) | 偏置 1]，维度恒 34（桶哈希 ⇒ 词表无界而特征
 * 有界）。选臂分布 P(a) = softmax((θᵀx + ln w_rule)/τ)——w_rule 为同一重放
 * 得出的旧律权重表：θ=0 时分布恰退化为旧权重表的比例分布（向后兼容锚点），
 * 学到的 θᵀx 只在上下文上做乘性修正。
 *
 * 更新（重要性加权 EXP4）：r = 成功 − λ·steps/budget；G = r / max(P(a), ε)；
 * θ[a] += η·(G·x − REG·θ[a])（L2 正则梯度步）。数值稳定三保险：η 夹取
 * [0, ETA_MAX]、每臂 ‖θ‖₂ 裁剪 ≤ THETA_MAX、重要性分母下限 ε 防小概率爆炸。
 *
 * 铁律（继承）：θ 与旧权重表一样，永远从 history（RunRecord 序列）**重放推导**
 * ——重放时不采样，缺省臂由贪心 argmax（平票按 HEURISTIC_ORDER 固定序）推导，
 * 保证同 seed 同历史重放结果逐字节一致；随机数只在 selectAction 的在线采样
 * 流里消费（自有 mulberry32 种子流，同 seed 同调用序 ⇒ 同采样序列）。
 *
 * 防泄漏律：失败签名簇作为**先决上下文**只认 ctx.failureCluster（调用方在开跑
 * 前注入的「既往失败簇」）；绝不从本轮 run 的结局事后推导簇特征——EXP4 的
 * 理论前提是 x 先于 a 可观测，用结局特征喂决策等于泄漏标签。
 *
 * 记账律：每轮 θ 更新的 (x, a, P(a), r, G) 由 exportAuditLedger() 重放导出，
 * 供离线审计 / 超参复盘。
 */
export interface RunRecord {
  goal: string;
  success: boolean;
  steps: number;
  durationMs: number;
  /** 本轮用过的动作 kind 序列（如 ['click','scroll','click']） */
  strategies: string[];
  failureRootCause?: string;
  criteriaMet?: number;
  criteriaTotal?: number;
  /** W1-5：上下文老虎机标注——字段在场（对象）即该轮进 θ 重放；arm/prob 缺省由
   *  贪心 argmax + 当期重放分布推导（铁律：重放不采样）；context 缺省 ⇒ 中性上下文 */
  bandit?: BanditAnnotation;
}

/** 蒸馏出的宏技能：触发描述 + 可读路径串 + 确定性可靠度（0.5 起步，复验 +0.1 封顶 0.95） */
export interface DistilledSkill {
  description: string;
  steps: string[];
  reliability: number;
}

/** 一次进化读数：蒸馏技能（可能缺省）、教训清单、末轮权重调整、下一轮建议 */
export interface EvolutionReport {
  distilledSkill?: DistilledSkill;
  lessons: string[];
  weightAdjustments: Array<{ heuristic: string; delta: number; reason: string }>;
  nextRunAdvice: string[];
}

// ── 算法形状字面量（全部确定性常量） ──

/** 五个内建策略权重键：数组序 = 平票裁决序（先到先胜） */
const HEURISTIC_ORDER = ['scroll', 'inspect', 'ask_vlm', 'recall_skill', 'click'] as const;
const KNOWN = new Set<string>(HEURISTIC_ORDER);
const W_INIT = 1.0;        // 初值全 1.0
const W_MAX = 2.0;         // 上夹取
const W_MIN = 0.2;         // 下夹取
const REWARD = 0.1;        // 成功奖励
const PENALTY = 0.15;      // 失败惩罚
const RECOVERY = 0.05;     // 恢复加成
const RELIABILITY_INIT = 0.5;
const RELIABILITY_MAX = 0.95;
const RELIABILITY_STEP = 0.1;
/** history 环形上限（纪元 Δ）：旧记录挤出保新 —— 长驻进程里进化读数只看最近 200 轮 */
const HISTORY_MAX = 200;

/** 失败根因关键词 → 对症恢复策略（确定性映射；大小写不敏感子串匹配） */
const RECOVERY_MAP: ReadonlyArray<Readonly<{ keyword: string; strategy: string }>> = [
  { keyword: 'popup', strategy: 'inspect' },   // 弹窗遮蔽 ⇒ 先看清现场
  { keyword: 'focus', strategy: 'inspect' },   // 焦点丢失 ⇒ 先定位真实可交互面
  { keyword: 'ocr', strategy: 'ask_vlm' },     // 文字读不出 ⇒ 换视觉模型直读
];

type WeightAdjustment = { heuristic: string; delta: number; reason: string };

// ─── W1-5：EXP4 上下文老虎机——契约类型 ───

/**
 * W1-5：上下文特征描述（全部可选、全部防御读取——坏值回落中性默认）。
 * 场景标签与失败签名簇为「先决上下文」：调用方须在选臂**之前**注入
 * （失败簇建议注入既往重复失败签名，见 failureSignature——绝不喂本轮结局）。
 */
export interface BanditContext {
  /** 场景标签（可注入，如 'login' / 'file-dialog'）——FNV-1a 哈希进 16 桶 one-hot */
  scene?: string;
  /** 既往失败签名簇 id（先决知识；缺省 '' = 无既往故障簇，自成一类）——8 桶 one-hot */
  failureCluster?: string;
  /** 世界 / 任务种类（如 'web' / 'desktop' / 'settings'）——8 桶 one-hot */
  worldKind?: string;
  /** 剩余步数（配合 budget 得剩余步数比；缺省 ⇒ 中性 0.5） */
  stepsRemaining?: number;
  /** 步数预算（剩余比与奖励折价共用；缺省 ⇒ distillMaxSteps×2） */
  budget?: number;
}

/** W1-5：RunRecord 上的老虎机标注——记录「当时选了哪个臂、概率多少、上下文是什么」 */
export interface BanditAnnotation {
  /** 选臂时刻的上下文（selectAction 返回的 annotation 原样回灌） */
  context?: BanditContext;
  /** 当时选中的策略臂（缺省 ⇒ 重放贪心 argmax 推导） */
  arm?: string;
  /** 当时的选中概率 P(a)，取值 (0,1]（非法或缺省 ⇒ 重放分布回填） */
  prob?: number;
}

/** W1-5：审计账目一行——每轮 θ 更新的 (x, a, P(a), r, G) 全量可导出 */
export interface BanditLedgerEntry {
  /** 该记录在当前 history 窗口内的序号（1 起；环形挤出后随窗口重排） */
  step: number;
  /** 实际更新的策略臂 */
  arm: string;
  /** P(a) 生效值（记录值合法则原样；否则重放分布回填） */
  prob: number;
  /** r = 成功(1/0) − λ·clamp01(steps/budget) */
  reward: number;
  /** 重要性权重 G = r / max(P(a), ε) */
  importance: number;
  /** 上下文特征向量 x（维度恒 FEATURE_LAYOUT.dim） */
  x: number[];
}

/** W1-5：一次选臂采样——臂、选中概率、全分布、可直接回灌 RunRecord.bandit 的标注 */
export interface ActionSample {
  arm: string;
  prob: number;
  probabilities: Record<string, number>;
  annotation: BanditAnnotation;
}

// ─── W1-5：EXP4 超参与特征布局（模块常量——审计与测试可读，冻结防篡改） ───

/** 特征布局：三段 one-hot 块 + 剩余步数比 + 偏置，维度恒 34 */
export const FEATURE_LAYOUT = Object.freeze({
  sceneOffset: 0,
  sceneWidth: 16,
  clusterOffset: 16,
  clusterWidth: 8,
  worldOffset: 24,
  worldWidth: 8,
  ratioIndex: 32,
  biasIndex: 33,
  dim: 34,
} as const);

/** EXP4 超参一览（τ 温度 / η 缺省与上界 / L2 正则 / θ 范数上限 / ε 分母下限 / λ 步代价） */
export const EXP4_HYPERPARAMS = Object.freeze({
  tau: 1.0,        // softmax 温度 τ
  eta: 0.05,       // 缺省学习率 η
  etaMax: 0.5,     // η 上夹取（防调用方注入爆炸步长）
  reg: 0.01,       // L2 正则系数
  thetaMax: 4.0,   // 每臂 θ 的 L2 范数上限
  probFloor: 0.01, // 重要性分母下限 ε（G 有界 ⇔ |G| ≤ max(1,λ)/ε）
  stepCost: 0.2,   // λ：奖励的步数折价
} as const);

const TAU = EXP4_HYPERPARAMS.tau;
const ETA = EXP4_HYPERPARAMS.eta;
const ETA_MAX = EXP4_HYPERPARAMS.etaMax;
const REG_L2 = EXP4_HYPERPARAMS.reg;
const THETA_MAX = EXP4_HYPERPARAMS.thetaMax;
const PROB_FLOOR = EXP4_HYPERPARAMS.probFloor;
const REWARD_STEP_COST = EXP4_HYPERPARAMS.stepCost;
/** 剩余步数比的中性默认（缺省/非法 ⇒ 0.5，与全仓置信兜底同律） */
const NEUTRAL_RATIO = 0.5;
/** W1-5：采样流缺省种子（黄金分割常数——任意固定值皆可，钉死即复现） */
const DEFAULT_BANDIT_SEED = 0x9e3779b9;
const SCENE_BLOCK = FEATURE_LAYOUT.sceneWidth;
const CLUSTER_BLOCK = FEATURE_LAYOUT.clusterWidth;
const WORLD_BLOCK = FEATURE_LAYOUT.worldWidth;
const FEATURE_DIM = FEATURE_LAYOUT.dim;

// ─── W1-5：确定性原语（本文件零 import——哈希与 PRNG 自带，绝不外借） ───

/** FNV-1a 32 位字符串哈希（>>>0 归一）——类别标签进桶的确定性锚 */
const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/**
 * W1-5：mulberry32——32 位确定性 PRNG（种子钉死 ⇒ 序列钉死；与 gym 的同名实现
 * 语义同源但互不 import：本模块零依赖铁律）。均匀输出 [0,1)。
 */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * W1-5：上下文 → 特征向量（纯函数、维度恒 34、绝不产出 NaN/Inf）。
 * 每个类别块恒恰一个 1（缺省标签 '' 自成一桶 = 「未知/无」类）；剩余步数比
 * 夹取 [0,1]；偏置恒 1。同 ctx 必得同 x（重放逐字节一致的地基）。
 */
export function contextFeatureVector(ctx?: BanditContext | null): number[] {
  const c = ctx !== null && typeof ctx === 'object' ? (ctx as Partial<BanditContext>) : {};
  const x = new Array<number>(FEATURE_DIM).fill(0);
  const scene = typeof c.scene === 'string' ? c.scene : '';
  const cluster = typeof c.failureCluster === 'string' ? c.failureCluster : '';
  const world = typeof c.worldKind === 'string' ? c.worldKind : '';
  x[FEATURE_LAYOUT.sceneOffset + (fnv1a(scene) % SCENE_BLOCK)] = 1;
  x[FEATURE_LAYOUT.clusterOffset + (fnv1a(cluster) % CLUSTER_BLOCK)] = 1;
  x[FEATURE_LAYOUT.worldOffset + (fnv1a(world) % WORLD_BLOCK)] = 1;
  const remain =
    typeof c.stepsRemaining === 'number' && Number.isFinite(c.stepsRemaining) ? c.stepsRemaining : null;
  const budget =
    typeof c.budget === 'number' && Number.isFinite(c.budget) && c.budget > 0 ? c.budget : null;
  x[FEATURE_LAYOUT.ratioIndex] =
    remain !== null && budget !== null ? Math.min(1, Math.max(0, remain / budget)) : NEUTRAL_RATIO;
  x[FEATURE_LAYOUT.biasIndex] = 1;
  return x;
}

/** 点积（长度不齐按短者；非有限结果按 0——防御汇总，正常路径恒有限） */
const dotVec = (a: readonly number[], b: readonly number[]): number => {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return Number.isFinite(s) ? s : 0;
};

/** 数值稳定 softmax：减最大值后归一；全 NaN/零和等不可达路径回落均匀（绝不抛） */
const softmaxStable = (logits: readonly number[]): number[] => {
  const n = logits.length;
  if (n === 0) return [];
  const ls: number[] = new Array<number>(n);
  let mx = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = logits[i];
    const l = typeof v === 'number' && Number.isFinite(v) ? v : 0;
    ls[i] = l;
    if (l > mx) mx = l;
  }
  let sum = 0;
  const es: number[] = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const e = Math.exp(ls[i] - mx);
    es[i] = e;
    sum += e;
  }
  if (!(sum > 0) || !Number.isFinite(sum)) return new Array<number>(n).fill(1 / n);
  for (let i = 0; i < n; i++) es[i] = es[i] / sum;
  return es;
};

/**
 * W1-5：当前重放态下的选臂分布（HEURISTIC_ORDER 序）：
 * logit(a) = θ[a]ᵀx/τ + ln w_rule(a)。θ=0 ⇒ P ∝ w_rule（旧固定规则的比例化，
 * 向后兼容锚点）；w_rule ∈ [0.2,2] 恒正 ⇒ ln 恒有限。
 */
const armDistribution = (
  theta: Record<string, number[]>,
  ruleWeights: Record<string, number>,
  x: readonly number[],
): number[] => {
  const logits = HEURISTIC_ORDER.map(
    k => dotVec(theta[k] ?? [], x) / TAU + Math.log(Math.max(W_MIN, ruleWeights[k] ?? W_INIT)),
  );
  return softmaxStable(logits);
};

/** 首个最大值下标（严格大于才夺位 ⇒ 平票按 HEURISTIC_ORDER 固定序——确定性法院） */
const argmaxIndex = (dist: readonly number[]): number => {
  let best = 0;
  for (let i = 1; i < dist.length; i++) {
    if (dist[i] > dist[best]) best = i;
  }
  return best;
};

/** W1-5：奖励（纯函数）：r = 成功(1/0) − λ·clamp01(steps/budget)。预算缺省 distillMaxSteps×2 */
const rewardOf = (
  ctx: BanditContext,
  run: RunRecord | undefined | null,
  defaultBudget: number,
): number => {
  const ok = run !== null && run !== undefined && run.success === true ? 1 : 0;
  const b =
    typeof ctx.budget === 'number' && Number.isFinite(ctx.budget) && ctx.budget > 0
      ? ctx.budget
      : Math.max(1, defaultBudget);
  const cost = Math.min(1, Math.max(0, stepsOf(run) / b));
  return ok - REWARD_STEP_COST * cost;
};

/**
 * W1-5：重要性加权 θ 更新（就地）：θ[a] += η·(G·x − REG·θ[a])
 * （损失 −G·θᵀx + REG/2·‖θ‖² 的负梯度步）。稳定性三保险：η 已在构造处夹取、
 * 逐坐标 NaN 归零、更新后 ‖θ[a]‖₂ > THETA_MAX ⇒ 整体缩放回球面。
 */
const applyThetaUpdate = (
  theta: Record<string, number[]>,
  arm: string,
  x: readonly number[],
  importance: number,
  eta: number,
): void => {
  const t = theta[arm];
  if (!Array.isArray(t)) return;
  for (let j = 0; j < FEATURE_DIM && j < t.length; j++) {
    t[j] += eta * (importance * x[j] - REG_L2 * t[j]);
    if (!Number.isFinite(t[j])) t[j] = 0;
  }
  let n2 = 0;
  for (const v of t) n2 += v * v;
  const norm = Math.sqrt(n2);
  if (Number.isFinite(norm) && norm > THETA_MAX && norm > 0) {
    const s = THETA_MAX / norm;
    for (let j = 0; j < t.length; j++) t[j] *= s;
  }
};

// ── 防御访问器（绝不抛异常的根基：坏记录一律诚实降级） ──

const strategiesOf = (run: RunRecord | undefined | null): string[] =>
  Array.isArray(run?.strategies) ? run.strategies : [];
const causeOf = (run: RunRecord | undefined | null): string =>
  typeof run?.failureRootCause === 'string' ? run.failureRootCause : '';
const stepsOf = (run: RunRecord | undefined | null): number =>
  Number.isFinite(run?.steps) ? (run as RunRecord).steps : 0;

const r2 = (x: number): number => Math.round(x * 100) / 100;
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * 蒸馏门（纯函数）：成功 && steps ≤ distillMaxSteps && strategies 非空。
 * 三条件缺一不可——失败无经验可沉淀，超步是低效路径不配当宏，空策略无内容可记。
 */
export function shouldDistillSkill(run: RunRecord, distillMaxSteps = 12): boolean {
  if (!run || run.success !== true) return false;
  const n = Number.isFinite(run.steps) ? run.steps : Number.POSITIVE_INFINITY;
  return n <= distillMaxSteps && strategiesOf(run).length > 0;
}

/**
 * 失败签名（纯函数）：`成败|根因|前4策略(>连接)`，截 80 字。
 * 同因同策 ⇒ 同签名——教训去重升级与 escalate 建议的锚点。
 * 防御：空记录返回 'fail|unknown|'，绝不抛异常。
 */
export function failureSignature(run: RunRecord): string {
  if (!run) return 'fail|unknown|';
  const sig = `${run.success ? 'ok' : 'fail'}|${run.failureRootCause ?? 'unknown'}|${strategiesOf(run).slice(0, 4).join('>')}`;
  if (sig.length <= 80) return sig;
  const cut = sig.slice(0, 80);
  // 截断点落在代理对中间时退一位 —— 绝不产出孤立代理项（签名作 Map 键/教训前缀）
  const last = cut.charCodeAt(79);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, 79) : cut;
}

/**
 * 把一轮运行按权重律叠进权重表（就地修改），返回本轮产生的调整记录
 * （delta = 夹取后的**实际**增量——触顶/触底轮的 delta 为 0，夹取对读者可见）。
 */
function applyRun(weights: Record<string, number>, run: RunRecord | undefined | null): WeightAdjustment[] {
  const adj: WeightAdjustment[] = [];
  if (!run) return adj;
  if (run.success === true) {
    // 律 1：成功奖励——出现过的策略去重后各 +0.1（封顶 2.0）
    const seen = new Set<string>();
    for (const kind of strategiesOf(run)) {
      if (!KNOWN.has(kind) || seen.has(kind)) continue;
      seen.add(kind);
      const before = weights[kind];
      const after = Math.min(W_MAX, r3(before + REWARD));
      weights[kind] = after;
      adj.push({ heuristic: kind, delta: r3(after - before), reason: `成功轨迹验证：${kind} 出现在成功运行中（+0.1，封顶 2.0）` });
    }
    return adj;
  }
  // 律 2：失败惩罚——末两步各 -0.15（位置语义：重复策略叠加计罚；下限 0.2）
  for (const kind of strategiesOf(run).slice(-2)) {
    if (!KNOWN.has(kind)) continue;
    const before = weights[kind];
    const after = Math.max(W_MIN, r3(before - PENALTY));
    weights[kind] = after;
    adj.push({ heuristic: kind, delta: r3(after - before), reason: `失败归因：${kind} 是末两步之一（-0.15，下限 0.2）` });
  }
  // 律 3：恢复加成——根因关键词 ⇒ 对症策略 +0.05（封顶 2.0；多关键词叠加）
  const cause = causeOf(run).toLowerCase();
  for (const { keyword, strategy } of RECOVERY_MAP) {
    if (!cause.includes(keyword)) continue;
    const before = weights[strategy];
    const after = Math.min(W_MAX, r3(before + RECOVERY));
    weights[strategy] = after;
    adj.push({ heuristic: strategy, delta: r3(after - before), reason: `恢复加成：根因含「${keyword}」⇒ ${strategy} 对症（+0.05，封顶 2.0）` });
  }
  return adj;
}

/**
 * 教训派生（纯函数）：一遍扫描 history。
 * 返回 lessons（插入序 = 首见序，同签名/同 goal 去重升级）与失败签名计数
 * （escalate 建议的依据——≥2 次才算重复失败模式）。
 */
function deriveLessons(history: readonly RunRecord[], distillMaxSteps: number):
{ lessons: string[]; failCounts: Map<string, number> } {
  const lessons = new Map<string, string>();
  const failCounts = new Map<string, number>();
  for (const run of history) {
    if (run?.success === true) {
      // 律 3：成功但超 distillMaxSteps×2 步 ⇒ 低效路径教训（同 goal 去重）
      if (stepsOf(run) > distillMaxSteps * 2) {
        const goal = run.goal ?? '?';
        const key = `低效:${goal}`;
        if (!lessons.has(key)) {
          lessons.set(key, `目标「${goal}」成功但用了 ${stepsOf(run)} 步（> ${distillMaxSteps * 2} 上限）——低效路径：优先蒸馏更短的宏，或换先验策略直达。`);
        }
      }
      continue;
    }
    const sig = failureSignature(run ?? ({} as RunRecord));
    const n = (failCounts.get(sig) ?? 0) + 1;
    failCounts.set(sig, n);
    if (n >= 2) {
      // 律 2：同签名第 2 次起升级为重复失败模式（去重：只占一席，句式随次数升级）
      lessons.set(sig, `${sig}｜重复失败模式（第 ${n} 次出现）：同一签名反复失败——升级处理优先级：该场景直接换策略或求助（escalate），勿原样重试。`);
    } else {
      const cause = causeOf(run) ? `（根因：${causeOf(run)}）` : '';
      lessons.set(sig, `${sig}｜教训：目标「${run?.goal ?? '?'}」失败${cause}——末段策略嫌疑最大已降权；重试前先看清现场（inspect / ask_vlm）。`);
    }
  }
  return { lessons: [...lessons.values()], failCounts };
}

/**
 * 蒸馏派生（纯函数）：按蒸馏门扫 history，同 goal 只建一卡、复蒸馏只涨可靠度。
 * lastKey = 最近一次可蒸馏运行触达的 goal（report 的 distilledSkill 取它；
 * null = 无可蒸馏历史 ⇒ 字段缺省）。
 */
function deriveSkills(history: readonly RunRecord[], distillMaxSteps: number):
{ skills: Map<string, DistilledSkill>; lastKey: string | null } {
  const skills = new Map<string, DistilledSkill>();
  let lastKey: string | null = null;
  for (const run of history) {
    if (!shouldDistillSkill(run ?? ({} as RunRecord), distillMaxSteps)) continue;
    const goal = run.goal ?? '';
    const existing = skills.get(goal);
    if (!existing) {
      skills.set(goal, {
        description: `自动技能：${goal}`,
        steps: [strategiesOf(run).join(' → ')],
        reliability: RELIABILITY_INIT,
      });
    } else {
      existing.reliability = Math.min(RELIABILITY_MAX, r2(existing.reliability + RELIABILITY_STEP));
    }
    lastKey = goal;
  }
  return { skills, lastKey };
}

/**
 * 自主进化引擎：ingest 记录运行，report/heuristics 即时派生进化读数。
 * 绝不抛异常：坏输入静默拒收或诚实降级；纯离线、零兄弟依赖。
 * history 是有界环形账本（上限 200，旧记录挤出保新——纪元 Δ：长驻进程无上限
 * 累积会让重放与内存双双发散）；reset() 清账回到出厂状态（测试与换场用）。
 * W1-5：双轨进化——旧权重律（heuristics/report，逐字节向后兼容）之外并置
 * EXP4 上下文老虎机（selectAction/armProbabilities/greedyArm/thetaNorms/
 * exportAuditLedger），两轨同一遍 history 重放、互不扰动。
 */
export class EvolutionEngine {
  private readonly runs: RunRecord[] = [];
  private readonly distillMaxSteps: number;
  /** W1-5：采样流（同 seed ⇒ 同序列；重放/读数绝不消费——铁律的随机隔离） */
  private readonly rng: () => number;
  /** W1-5：学习率 η（构造处夹取 [0, ETA_MAX]；η=0 ⇒ 关学习只记账） */
  private readonly eta: number;

  /**
   * @param opts.history         播种历史（等同逐条 ingest——权重/教训/蒸馏/θ 同律重放；
   *                             超 200 条按环形律截尾保新）
   * @param opts.distillMaxSteps 蒸馏步数上限，默认 12（≤0 或非有限数 ⇒ 回落 12）
   * @param opts.seed            W1-5 采样流种子（缺省 0x9e3779b9；非有限数 ⇒ 缺省）
   * @param opts.eta             W1-5 学习率 η，缺省 0.05（夹取 [0, 0.5]）
   */
  constructor(opts?: { history?: RunRecord[]; distillMaxSteps?: number; seed?: number; eta?: number }) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const n = Number(o.distillMaxSteps);
    this.distillMaxSteps = Number.isFinite(n) && n > 0 ? n : 12;
    // W1-5：种子流与学习率的防御初始化（坏值回落缺省，绝不抛）
    const sd = Number(o.seed);
    this.rng = mulberry32(Number.isFinite(sd) ? sd : DEFAULT_BANDIT_SEED);
    const et = Number(o.eta);
    this.eta = Number.isFinite(et) ? Math.min(ETA_MAX, Math.max(0, et)) : ETA;
    if (Array.isArray(o.history)) {
      for (const r of o.history) {
        if (r && typeof r === 'object') this.runs.push(r);
      }
      if (this.runs.length > HISTORY_MAX) this.runs.splice(0, this.runs.length - HISTORY_MAX);
    }
  }

  /** 收官一轮运行。坏记录（null/undefined/非对象）静默拒收，绝不抛异常；
   *  超 200 条时最旧记录被挤出（环形账本只看最近 200 轮）。 */
  ingest(run: RunRecord): void {
    if (!run || typeof run !== 'object') return;
    this.runs.push(run);
    if (this.runs.length > HISTORY_MAX) this.runs.shift();
  }

  /** 唯一事实源（只读副本：外部改返回值不透内部；派生读数全部由它重放得出） */
  get history(): readonly RunRecord[] {
    return [...this.runs];
  }

  /** 清账重置：history 归零、权重/教训/蒸馏回到出厂（单例跨场复用时的换场闸） */
  reset(): void {
    this.runs.length = 0;
  }

  /** 当前权重表：scroll/inspect/ask_vlm/recall_skill/click，初值全 1.0（每次调用重放，返回新对象） */
  heuristics(): Record<string, number> {
    return this.replay().weights;
  }

  // ─── W1-5：EXP4 上下文老虎机读数（全部纯重放派生，零缓存错位） ───

  /**
   * W1-5：按当前分布采样选臂（在线探索入口；每次调用恰消耗一个随机数）。
   * 返回臂、选中概率 P(a)、全分布，与可直接回灌 RunRecord.bandit 的 annotation
   * （闭环契约：selectAction → 执行 → ingest({...run, bandit: sample.annotation})）。
   * 兜底均匀臂（数学防御，正常不可达）——绝不抛异常。
   */
  selectAction(ctx?: BanditContext | null): ActionSample {
    try {
      const { theta, weights } = this.replay();
      const dist = armDistribution(theta, weights, contextFeatureVector(ctx));
      const u = this.rng();
      let acc = 0;
      let pick = dist.length - 1; // 浮点累计尾差兜底：越界落最后一臂
      for (let i = 0; i < dist.length; i++) {
        acc += dist[i];
        if (u < acc) {
          pick = i;
          break;
        }
      }
      const probabilities: Record<string, number> = {};
      HEURISTIC_ORDER.forEach((k, i) => {
        probabilities[k] = dist[i];
      });
      const arm = HEURISTIC_ORDER[pick];
      const prob = dist[pick];
      return { arm, prob, probabilities, annotation: { arm, prob, context: ctx ?? {} } };
    } catch {
      const p = 1 / HEURISTIC_ORDER.length;
      const probabilities: Record<string, number> = {};
      for (const k of HEURISTIC_ORDER) probabilities[k] = p;
      return { arm: HEURISTIC_ORDER[0], prob: p, probabilities, annotation: { arm: HEURISTIC_ORDER[0], prob: p, context: {} } };
    }
  }

  /**
   * W1-5：当前重放态的选臂分布（纯读数，零随机消费——与 selectAction 的区别只在
   * 采样那一步）。θ=0 时恰为旧权重表的比例分布 softmax(ln w_rule)——「θ=0 退化为
   * 旧固定规则行为」的兼容锚点。键序恒 HEURISTIC_ORDER，值和为 1。
   */
  armProbabilities(ctx?: BanditContext | null): Record<string, number> {
    try {
      const { theta, weights } = this.replay();
      const dist = armDistribution(theta, weights, contextFeatureVector(ctx));
      const out: Record<string, number> = {};
      HEURISTIC_ORDER.forEach((k, i) => {
        out[k] = dist[i];
      });
      return out;
    } catch {
      const p = 1 / HEURISTIC_ORDER.length;
      const out: Record<string, number> = {};
      for (const k of HEURISTIC_ORDER) out[k] = p;
      return out;
    }
  }

  /**
   * W1-5：贪心臂（argmax，平票按 HEURISTIC_ORDER 固定序）——重放推导用的正是
   * 这一裁决（铁律：重放不采样）。θ=0 时与旧建议分支一（最高权重先行）同裁。
   */
  greedyArm(ctx?: BanditContext | null): string {
    try {
      const { theta, weights } = this.replay();
      const dist = armDistribution(theta, weights, contextFeatureVector(ctx));
      return HEURISTIC_ORDER[argmaxIndex(dist)];
    } catch {
      return HEURISTIC_ORDER[0];
    }
  }

  /** W1-5：各臂 θ 的 L2 范数（有界性读数——恒 ≤ thetaMax；零学习 ⇒ 全 0） */
  thetaNorms(): Record<string, number> {
    const { theta } = this.replay();
    const out: Record<string, number> = {};
    for (const k of HEURISTIC_ORDER) {
      let n2 = 0;
      for (const v of theta[k]) n2 += v * v;
      out[k] = Number.isFinite(n2) ? Math.sqrt(n2) : 0;
    }
    return out;
  }

  /**
   * W1-5：审计账本导出——逐轮重放产生的 (x, a, P(a), r, G) 全量（无 bandit 标注的
   * 历史轮次不进账本；每次调用重放重建，外部改动不透内部）。
   */
  exportAuditLedger(): BanditLedgerEntry[] {
    return this.replay().ledger;
  }

  /**
   * 进化读数（每次调用基于当前 history 即时计算——纯派生，无缓存错位）：
   * distilledSkill = 最近触达的蒸馏技能；lessons = 教训去重升级后的清单；
   * weightAdjustments = **末轮** ingest 产生的调整（delta 为夹取后实际增量）；
   * nextRunAdvice = 先行/escalate/recall 三分支建议。
   */
  report(): EvolutionReport {
    const { weights, lastAdjustments } = this.replay();
    const { lessons, failCounts } = deriveLessons(this.runs, this.distillMaxSteps);
    const { skills, lastKey } = deriveSkills(this.runs, this.distillMaxSteps);

    const advice: string[] = [];
    // 分支一（恒在）：最高权重者先行——严格大于才夺位 ⇒ 平票由固定序裁决
    let top: string = HEURISTIC_ORDER[0];
    for (const k of HEURISTIC_ORDER) {
      if (weights[k] > weights[top]) top = k;
    }
    advice.push(`先行建议：优先尝试「${top}」（当前权重 ${r2(weights[top])}，五策略中最高）。`);
    // 分支二：重复失败签名（≥2 次）⇒ 直接 escalate 该场景
    for (const [sig, n] of failCounts) {
      if (n < 2) continue;
      advice.push(`escalate 建议：签名 ${sig} 已失败 ${n} 次（重复失败模式）——该场景直接升级处理：换路径或求助，勿原样重试。`);
    }
    // 分支三：有蒸馏技能 ⇒ 下一轮优先 recall
    if (skills.size > 0) {
      let maxRel = 0;
      for (const s of skills.values()) maxRel = Math.max(maxRel, s.reliability);
      advice.push(`记忆中有 ${skills.size} 个蒸馏技能（最高可靠度 ${r2(maxRel)}）——下一轮优先 recall_skill 复用已验证路径。`);
    }

    const skill = lastKey !== null ? skills.get(lastKey) : undefined;
    return skill
      ? { distilledSkill: skill, lessons, weightAdjustments: lastAdjustments, nextRunAdvice: advice }
      : { lessons, weightAdjustments: lastAdjustments, nextRunAdvice: advice };
  }

  /**
   * W1-5 双轨重放：旧权重律（applyRun）与 EXP4 θ（重要性加权）在**同一遍** history
   * 上推导。逐轮次序 = 在线时序：先按当前态推导 (a, P(a))（记录值合法则用记录值，
   * 否则贪心 argmax + 当期分布——铁律：重放不采样），再做 θ 更新，最后叠旧律——
   * 本轮自己的结局绝不进入自己的选中概率（在线无泄漏语义）。
   */
  private replay(): {
    weights: Record<string, number>;
    lastAdjustments: WeightAdjustment[];
    theta: Record<string, number[]>;
    ledger: BanditLedgerEntry[];
  } {
    const weights: Record<string, number> = {};
    for (const k of HEURISTIC_ORDER) weights[k] = W_INIT;
    // W1-5：θ 出厂全零（零向量 ⇒ 分布退化为旧权重比例——旧律兼容锚点）
    const theta: Record<string, number[]> = {};
    for (const k of HEURISTIC_ORDER) theta[k] = new Array<number>(FEATURE_DIM).fill(0);
    const ledger: BanditLedgerEntry[] = [];
    let lastAdjustments: WeightAdjustment[] = [];
    let step = 0;
    for (const run of this.runs) {
      step += 1;
      const bandit = run?.bandit;
      if (bandit !== null && bandit !== undefined && typeof bandit === 'object') {
        try {
          const rec = bandit as Partial<BanditAnnotation>;
          const ctx: BanditContext =
            rec.context !== null && rec.context !== undefined && typeof rec.context === 'object'
              ? rec.context
              : {};
          const x = contextFeatureVector(ctx);
          const dist = armDistribution(theta, weights, x);
          // 缺省臂 ⇒ 贪心 argmax（平票固定序）；非法臂名（不在五内建）同律回退
          let ai = (HEURISTIC_ORDER as readonly string[]).indexOf(typeof rec.arm === 'string' ? rec.arm : '');
          if (ai < 0) ai = argmaxIndex(dist);
          // P(a)：记录值合法（有限、(0,1]）则原样（在线真值），否则当期分布回填
          let prob = dist[ai];
          if (typeof rec.prob === 'number' && Number.isFinite(rec.prob) && rec.prob > 0 && rec.prob <= 1) {
            prob = rec.prob;
          }
          const reward = rewardOf(ctx, run, this.distillMaxSteps * 2);
          // 重要性加权：G = r / max(P(a), ε)——分母下限防小概率爆炸
          const gRaw = reward / Math.max(prob, PROB_FLOOR);
          const importance = Number.isFinite(gRaw) ? gRaw : 0;
          applyThetaUpdate(theta, HEURISTIC_ORDER[ai], x, importance, this.eta);
          ledger.push({ step, arm: HEURISTIC_ORDER[ai], prob, reward, importance, x });
        } catch {
          // W1-5：坏标注绝不炸重放——跳过该轮 θ 学习，旧律照常推进
        }
      }
      lastAdjustments = applyRun(weights, run);
    }
    return { weights, lastAdjustments, theta, ledger };
  }
}
