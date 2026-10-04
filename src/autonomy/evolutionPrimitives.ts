// src/autonomy/evolutionPrimitives.ts
// W6-1（doctor 债清偿·smell.over-engineering）：从 evolutionEngine.ts 提取的确定性
// 原语区 —— EXP4 特征/超参常量、哈希与 PRNG、向量数学、防御访问器、蒸馏门/失败签名
// 与权重律纯函数（applyRun/deriveLessons/deriveSkills）。逐字节搬运（零逻辑/零数值
// 变更）；类型经 type-only 反向引用 evolutionEngine（擦除后零运行时环）。
// ΝΩ-11（闭环账本工单）：applyRun 的律 1/律 2 已自旧「末两步/去重全额」升级为
// 全轨迹 HCA 折扣（γ=0.7 冻结），RECOVERY_MAP 扩生产方言——上述搬运声明对这两
// 处自本工单起失效（有意的行为变更，测试同步手算更新）。
// ΑΩ-R10（方言三重复制单源化）：mulberry32/fnv1a 本地副本已迁出至 ../dialects/random
// 单源模块 —— 本文件改为 import + 原位再导出（mulberry32），种子流与散列值逐位一致。
import type { BanditContext, DistilledSkill, RunRecord } from './evolutionEngine';
import { fnv1a, mulberry32 } from '../dialects/random';

export { mulberry32 };

// ── 算法形状字面量（全部确定性常量） ──

/** 五个内建策略权重键：数组序 = 平票裁决序（先到先胜） */
export const HEURISTIC_ORDER = ['scroll', 'inspect', 'ask_vlm', 'recall_skill', 'click'] as const;
export const KNOWN = new Set<string>(HEURISTIC_ORDER);
export const W_INIT = 1.0;        // 初值全 1.0
export const W_MAX = 2.0;         // 上夹取
export const W_MIN = 0.2;         // 下夹取
export const REWARD = 0.1;        // 成功奖励
export const PENALTY = 0.15;      // 失败惩罚
export const RECOVERY = 0.05;     // 恢复加成
export const RELIABILITY_INIT = 0.5;
export const RELIABILITY_MAX = 0.95;
export const RELIABILITY_STEP = 0.1;

/**
 * 失败根因关键词 → 对症恢复策略（确定性映射；大小写不敏感子串匹配）。
 * ΝΩ-11（恢复加成律方言断裂修复）：旧表只认 gym 方言（popup/focus/ocr）——
 * 生产根因词是 autonomousRun 的 failureRootCause = escalateReason ?? 终局相位
 * （'constitution-veto' / 'approval-required' / 'policy-escalate' /
 * 'epistemic-gate' / 'steer-drift'，或 'failed' / 'aborted' / 'blocked'；
 * gym 与 dream-replay 侧方言为 `phase=同词` / `dream-replay:phase=同词`），
 * 旧表对生产流 +0.05 结构性不可达。扩表以子串覆盖两种载体（'failed' 同时命中
 * 'failed' 与 'phase=failed'），gym 旧词全保留（零回归）；多关键词照旧叠加。
 * autoPilot 现无 lastNoEffectKind 信号（ΝΩ-11 已核查）——无可透传；该信号
 * 在场之日在此续接（no_effect 动作种类的对症行）。
 */
export const RECOVERY_MAP: ReadonlyArray<Readonly<{ keyword: string; strategy: string }>> = [
  // —— gym 方言（旧表逐字节保留） ——
  { keyword: 'popup', strategy: 'inspect' },   // 弹窗遮蔽 ⇒ 先看清现场
  { keyword: 'focus', strategy: 'inspect' },   // 焦点丢失 ⇒ 先定位真实可交互面
  { keyword: 'ocr', strategy: 'ask_vlm' },     // 文字读不出 ⇒ 换视觉模型直读
  // —— ΝΩ-11 生产方言：escalateReason（子串取词根，勿整词——根因串可能带前后缀） ——
  { keyword: 'veto', strategy: 'inspect' },        // constitution-veto：现场危险词否决 ⇒ 先看清现场再选路
  { keyword: 'approval', strategy: 'inspect' },    // approval-required：审批拦截 ⇒ 看清现场换良性路径
  { keyword: 'escalate', strategy: 'ask_vlm' },    // policy-escalate：已知路全败 ⇒ 换视觉模型找新路
  { keyword: 'epistemic', strategy: 'ask_vlm' },   // epistemic-gate：置信不足 ⇒ 云脑直读补证据
  { keyword: 'steer-drift', strategy: 'inspect' }, // 活意图漂移 ⇒ 重看现场对齐意图
  // —— ΝΩ-11 生产方言：终局相位名（escalateReason 缺席时的根因词） ——
  { keyword: 'blocked', strategy: 'inspect' },      // 阻塞 ⇒ 看清阻塞现场找解除路径
  { keyword: 'failed', strategy: 'inspect' },       // 判据未达 ⇒ 重试前先看清现场（与教训文案同律）
  { keyword: 'aborted', strategy: 'recall_skill' }, // 步数熔断 ⇒ 复用蒸馏宏省步数（更短路径是预算的解药）
];

/**
 * ΝΩ-11：HCA（Hindsight Credit Assignment）全轨迹折扣因子 γ —— 冻结常量 0.7。
 * 语义：距终局 k 步的策略贡献 ×γ^k（k=0 终局步全额、k=2 时 ≈0.49 即减半）。
 * 取 0.7 的论证（冻结，勿动）：0.9 衰减过慢（近似无折扣 ⇒ 退回「全轨迹等罚」
 * 的旧病——首步与终局步同罪，归因无梯度）；0.5 两步即斩至 1/4（长轨迹早期步
 * 贡献被抹零，正则项失效）；0.7 ⇒ γ²≈0.49（两步外减半）、γ³≈0.34（三步外
 * <1/3），与旧律「末两步位置语义」的近因偏重精神衔接最平滑，且为 RL 折扣
 * 经验值。纯函数消费（hcaFactor），确定性保持。
 */
export const HCA_GAMMA = 0.7;

/** ΝΩ-11：γ^k（纯函数；k 非法/负数防御归 γ^0=1 —— 不确定时不折价，归因从满） */
export function hcaFactor(stepsFromEnd: number): number {
  const k = typeof stepsFromEnd === 'number' && Number.isFinite(stepsFromEnd) ? Math.floor(stepsFromEnd) : 0;
  return Math.pow(HCA_GAMMA, Math.max(0, k));
}

/** ΝΩ-11：折扣后的单步奖/罚幅度（千分位取整 —— 手算可对照、浮点不漂移） */
export function hcaStepMagnitude(base: number, stepsFromEnd: number): number {
  return r3(base * hcaFactor(stepsFromEnd));
}

export type WeightAdjustment = { heuristic: string; delta: number; reason: string };

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
export const ETA = EXP4_HYPERPARAMS.eta;
export const ETA_MAX = EXP4_HYPERPARAMS.etaMax;
const REG_L2 = EXP4_HYPERPARAMS.reg;
const THETA_MAX = EXP4_HYPERPARAMS.thetaMax;
export const PROB_FLOOR = EXP4_HYPERPARAMS.probFloor;
const REWARD_STEP_COST = EXP4_HYPERPARAMS.stepCost;
/** 剩余步数比的中性默认（缺省/非法 ⇒ 0.5，与全仓置信兜底同律） */
const NEUTRAL_RATIO = 0.5;
/** W1-5：采样流缺省种子（黄金分割常数——任意固定值皆可，钉死即复现） */
export const DEFAULT_BANDIT_SEED = 0x9e3779b9;
const SCENE_BLOCK = FEATURE_LAYOUT.sceneWidth;
const CLUSTER_BLOCK = FEATURE_LAYOUT.clusterWidth;
const WORLD_BLOCK = FEATURE_LAYOUT.worldWidth;
export const FEATURE_DIM = FEATURE_LAYOUT.dim;

// ─── W1-5：确定性原语（ΑΩ-R10：哈希与 PRNG 本体已单源化至 ../dialects/random，
//     经顶部 import 引入 —— mulberry32 原位再导出，fnv1a 供 contextFeatureVector 消费） ───

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
export const armDistribution = (
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
export const argmaxIndex = (dist: readonly number[]): number => {
  let best = 0;
  for (let i = 1; i < dist.length; i++) {
    if (dist[i] > dist[best]) best = i;
  }
  return best;
};

/** W1-5：奖励（纯函数）：r = 成功(1/0) − λ·clamp01(steps/budget)。预算缺省 distillMaxSteps×2 */
export const rewardOf = (
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
export const applyThetaUpdate = (
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

export const strategiesOf = (run: RunRecord | undefined | null): string[] =>
  Array.isArray(run?.strategies) ? run.strategies : [];
export const causeOf = (run: RunRecord | undefined | null): string =>
  typeof run?.failureRootCause === 'string' ? run.failureRootCause : '';
export const stepsOf = (run: RunRecord | undefined | null): number =>
  Number.isFinite(run?.steps) ? (run as RunRecord).steps : 0;

export const r2 = (x: number): number => Math.round(x * 100) / 100;
export const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * 蒸馏门（纯函数）：成功 && steps ≤ distillMaxSteps && strategies 非空。
 * 三条件缺一不可——失败无经验可沉淀，超步是低效路径不配当宏，空策略无内容可记。
 */
export function shouldDistillSkill(run: RunRecord, distillMaxSteps = 12): boolean {
  if (!run || run.success !== true) return false;
  const n = Number.isFinite(run.steps) ? run.steps : Number.POSITIVE_INFINITY;
  return n <= distillMaxSteps && strategiesOf(run).length > 0;
}

/** W6-1（风格债）：失败签名截断上限（字符数）—— 原裸字面量 80 提取为具名常量，数值逐位不变 */
const FAILURE_SIGNATURE_MAX = 80;

/**
 * 失败签名（纯函数）：`成败|根因|前4策略(>连接)`，截 80 字。
 * 同因同策 ⇒ 同签名——教训去重升级与 escalate 建议的锚点。
 * 防御：空记录返回 'fail|unknown|'，绝不抛异常。
 */
export function failureSignature(run: RunRecord): string {
  if (!run) return 'fail|unknown|';
  const sig = `${run.success ? 'ok' : 'fail'}|${run.failureRootCause ?? 'unknown'}|${strategiesOf(run).slice(0, 4).join('>')}`;
  if (sig.length <= FAILURE_SIGNATURE_MAX) return sig;
  const cut = sig.slice(0, FAILURE_SIGNATURE_MAX);
  // 截断点落在代理对中间时退一位 —— 绝不产出孤立代理项（签名作 Map 键/教训前缀）
  const last = cut.charCodeAt(FAILURE_SIGNATURE_MAX - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, FAILURE_SIGNATURE_MAX - 1) : cut;
}

/**
 * 把一轮运行按权重律叠进权重表（就地修改），返回本轮产生的调整记录
 * （delta = 夹取后的**实际**增量——触顶/触底轮的 delta 为 0，夹取对读者可见）。
 * ΝΩ-11（折扣归因）：律 1/律 2 的位置语义自「末两步/去重全额」升级为全轨迹
 * HCA 折扣——第 i 步（1 基）的贡献 ×γ^(N−i)（γ=0.7 冻结，见 HCA_GAMMA）：
 * 终局步全额、早期步衰减（成功奖励与失败惩罚同律，符号相反）。纯函数，
 * 同输入同输出（千分位取整 —— 手算可对照）。
 */
export function applyRun(weights: Record<string, number>, run: RunRecord | undefined | null): WeightAdjustment[] {
  const adj: WeightAdjustment[] = [];
  if (!run) return adj;
  const traj = strategiesOf(run);
  const n = traj.length;
  if (run.success === true) {
    // 律 1（ΝΩ-11 折扣升级）：成功奖励——出现过的策略去重后按「最晚出现位」的
    // 折扣 +0.1·γ^(N−1−i)（封顶 2.0；最晚位 = 折扣最满 = 事后归因信用最大的
    // 那次出现——一次运行的证据量仍是 1，与旧去重律同精神）
    const credited = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const kind = traj[i];
      if (typeof kind === 'string' && KNOWN.has(kind)) credited.set(kind, i);
    }
    for (const [kind, i] of credited) {
      const gain = hcaStepMagnitude(REWARD, n - 1 - i);
      const before = weights[kind];
      const after = Math.min(W_MAX, r3(before + gain));
      weights[kind] = after;
      adj.push({
        heuristic: kind,
        delta: r3(after - before),
        reason: `成功轨迹验证：${kind} 出现在成功运行第 ${i + 1}/${n} 步（折扣 γ^${n - 1 - i} ⇒ +${gain}，封顶 2.0）`,
      });
    }
    return adj;
  }
  // 律 2（ΝΩ-11 折扣升级）：失败惩罚——全轨迹逐位按 γ^(N−1−i) 计罚
  //（近因步全额、早期步衰减；重复策略叠加计罚同旧律；下限 0.2）
  for (let i = 0; i < n; i++) {
    const kind = traj[i];
    if (typeof kind !== 'string' || !KNOWN.has(kind)) continue;
    const loss = hcaStepMagnitude(PENALTY, n - 1 - i);
    const before = weights[kind];
    const after = Math.max(W_MIN, r3(before - loss));
    weights[kind] = after;
    adj.push({
      heuristic: kind,
      delta: r3(after - before),
      reason: `失败归因：${kind} 位于第 ${i + 1}/${n} 步（折扣 γ^${n - 1 - i} ⇒ -${loss}，下限 0.2）`,
    });
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
export function deriveLessons(history: readonly RunRecord[], distillMaxSteps: number):
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
      lessons.set(sig, `${sig}｜教训：目标「${run?.goal ?? '?'}」失败${cause}——轨迹已按近因折扣降权（ΝΩ-11：γ^(N−i)，末位最重）；重试前先看清现场（inspect / ask_vlm）。`);
    }
  }
  return { lessons: [...lessons.values()], failCounts };
}

/**
 * 蒸馏派生（纯函数）：按蒸馏门扫 history，同 goal 只建一卡、复蒸馏只涨可靠度。
 * lastKey = 最近一次可蒸馏运行触达的 goal（report 的 distilledSkill 取它；
 * null = 无可蒸馏历史 ⇒ 字段缺省）。
 */
export function deriveSkills(history: readonly RunRecord[], distillMaxSteps: number):
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
