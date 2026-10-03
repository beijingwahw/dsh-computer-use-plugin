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
 */
export class EvolutionEngine {
  private readonly runs: RunRecord[] = [];
  private readonly distillMaxSteps: number;

  /**
   * @param opts.history         播种历史（等同逐条 ingest——权重/教训/蒸馏同律重放；
   *                             超 200 条按环形律截尾保新）
   * @param opts.distillMaxSteps 蒸馏步数上限，默认 12（≤0 或非有限数 ⇒ 回落 12）
   */
  constructor(opts?: { history?: RunRecord[]; distillMaxSteps?: number }) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const n = Number(o.distillMaxSteps);
    this.distillMaxSteps = Number.isFinite(n) && n > 0 ? n : 12;
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

  /** 权重重放：从全 1.0 出发逐轮叠律；lastAdjustments 始终保持末轮的调整记录 */
  private replay(): { weights: Record<string, number>; lastAdjustments: WeightAdjustment[] } {
    const weights: Record<string, number> = {};
    for (const k of HEURISTIC_ORDER) weights[k] = W_INIT;
    let lastAdjustments: WeightAdjustment[] = [];
    for (const run of this.runs) {
      lastAdjustments = applyRun(weights, run);
    }
    return { weights, lastAdjustments };
  }
}
