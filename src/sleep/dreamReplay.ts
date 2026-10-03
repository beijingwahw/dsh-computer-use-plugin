// src/sleep/dreamReplay.ts
// W5-2（M4 优先经验反事实梦回放）：真实失败轨迹在 PCG 同构世界里获得第二次机会。
//
// 一句话：睡梦里，把「当时败了的那条路」放进一座结构同构、输入冻结的文法世界，
// 让**当前**策略重走一遍 —— 若本可成功，产一条反事实教训进晨报；无论成败，
// 分歧点之后的重放结局作为新证据双写（实验室 kernel 账本 + 进化引擎 EXP4）。
//
// 设计律（与 sleep/index.ts 同源，另有本模块专属三条）：
//   · 永不抛异常 —— 梦是旁路中的旁路：任何故障（轨迹垃圾/世界铸造失败/引擎炸）
//     都收敛为报告里的 note，绝不炸睡眠、绝不炸宿主；
//   · 确定性铁律 —— 同轨迹 + 同策略状态 ⇒ 逐字节同重放：世界 seed 由轨迹指纹
//     冻结派生、梦训练营用虚拟时钟与离线哨兵 client（runPcgWorld 既有执法面）、
//     随机数只在 PCG 推导的种子流里（seed 钉死 ⇒ 推导钉死）；
//   · 隔离铁律 —— 梦训练营自带独立实验室（AutonomyGym 缺省自铸，Θ-3 律），
//     生产 kernel 注册表分毫不动；值进生产的唯一通道仍是外部显式 promoteFrom。
//
// 本模块的装载律（与 index.ts「相对导入全部 type-only」律的关系）：
// index.ts 对本模块只做**懒动态 import**（梦 dep 在场才装载）—— 六幕的装载器
// 零耦合律对既有路径逐字节保持；本模块自身是梦的机房，允许运行期导入 gym 的
// PCG 面（pcgWorldStream / AutonomyGym / runPcgWorld —— sharp 懒加载、零网络）。
//
// ── PER 优先级（Prioritized Experience Replay，公式可审计）──
//
//   p = ŝ × cost × recency
//
//   ŝ       惊异因子 = surpriseBits / (surpriseBits + SURPRISE_HALF_BITS)
//                     （饱和双曲归一 ∈ [0,1)：单调、有界、surpriseBits=半衰位时
//                      恰 0.5 —— 手算可验）
//   cost    失败代价 = riskFactor[riskTier] × (1 + min(stepsWasted, WASTE_CAP)/WASTE_CAP)
//                     （风险档乘子 × 步数浪费因子 ∈ [1,5]）
//   recency 新近衰减 = 2^(−age/HALF_LIFE_MS)
//                     （age = now − at；半衰期恒 24h —— 昨夜的失败权重减半）
//
//   surpriseBits 的证据优先序（诚实缺席链，逐级回落并申报来源）：
//     轨迹自带累计惊异 > 惊异谱按场景类型命中 > 惊异谱均值 > SURPRISE_PRIOR_BITS。
//   全部因子与权重为模块冻结常量（PER_WEIGHTS —— 审计与测试可读）。
import { AutonomyGym, pcgWorldStream } from '../autonomy/gym';
import type { GymGrammarOptions, GymNoiseSpec, PcgWorld } from '../autonomy/gym';
import type { EvolutionEngine, RunRecord } from '../autonomy/evolutionEngine';
import type { FailureRecord } from '../failureMemory';
import type { GymLabSuite } from '../autonomy/gym';

// ─── W5-2：PER 权重与预算（模块冻结常量 —— 公式可审计的锚） ───

/** PER 公式全部常量（Object.freeze —— 审计面；测试按此手算对照） */
export const PER_WEIGHTS = Object.freeze({
  /** 惊异半饱和位（bits）：surpriseBits = 此值时 ŝ 恰 0.5 */
  surpriseHalfBits: 8,
  /** 无任何惊异证据时的先验位（bits）—— 申报在案的代用，不冒充测量 */
  surprisePriorBits: 2,
  /** 风险档乘子（benign 1.0 / sensitive 1.5 / destructive 2.5） */
  riskFactor: Object.freeze({ benign: 1.0, sensitive: 1.5, destructive: 2.5 } as const),
  /** 步数浪费饱和上限（步）：stepsWasted = 此值时浪费因子恰 2.0 */
  wasteCap: 20,
  /** 新近衰减半衰期（ms）：24h —— 昨夜失败权重减半 */
  halfLifeMs: 86_400_000,
  /** 失败记录无步数浪费证据时的先验（步）—— 均匀先验只定标不改排序 */
  stepsWastedPrior: 4,
} as const);

/** 梦回放预算缺省（每睡眠周期最多 3 条、每条步数上限 8 —— 2s 睡眠预算的礼让） */
export const DREAM_BUDGET_DEFAULTS = Object.freeze({
  maxDreams: 3,
  maxStepsPerDream: 8,
  maxDreamsCap: 16,
  maxStepsCap: 40,
} as const);

/** 同构世界从 pcgWorldStream 取样的搜索窗（index ∈ [0, window)） */
const DREAM_STREAM_WINDOW = 16;
/** 历史决策序列的防御上限（分歧 diff 的对照面；超长截断保新） */
const HISTORY_MAX = 8;
/** 优先级数值网格（1e-6 —— 防浮点尾噪，可重放） */
const PRIORITY_GRID = 1e6;

// ─── 确定性原语（本模块零依赖铁律：哈希自带，与 evolutionEngine 同源不外借） ───

/** FNV-1a 32 位字符串哈希（>>>0 归一）—— 轨迹指纹与世界种子的确定性锚 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 非负有限数守卫（垃圾计数不进公式） */
function finiteNonNeg(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

// ─── 契约类型 ───

/** 历史决策单步（分歧 diff 的对照面：当时走了什么） */
export interface DreamHistoricalStep {
  kind: string;
  label?: string;
}

/** 冻结世界参数（「场景输入冻结」的执法面：seed 与世界参数来自原轨迹） */
export interface DreamWorldParams {
  seed?: number;
  /** 文法难度 1..3（缺省由轨迹指纹确定性派生） */
  difficulty?: number;
  noise?: GymNoiseSpec;
  /** 文法产生式权重（同构世界可以带着当时的课程偏置入梦） */
  weights?: Record<string, number>;
}

/**
 * 梦回放的失败轨迹（失败记录的梦方言 —— FailureRecord 的防御超集）：
 * 生产由 dreamTrajectories() 从 failureMemory 记录映射（缺字段走申报先验），
 * 测试可直接铸造带 history/world 的完整轨迹（分歧点定位的对照面）。
 */
export interface DreamFailureTrajectory {
  /** 轨迹身份（FailureRecord.id 或注入方自定义） */
  id: string;
  query: string;
  approach: string;
  symptom: string;
  /** 失败时的整屏指纹（同构世界选取的种子源之一） */
  sceneHash?: string;
  /** 结构化病因（EXP4 失败簇上下文 / 教训文案） */
  rootCause?: string;
  /** 失败时刻（epoch ms —— 新近衰减的锚） */
  at: number;
  /** 风险档（失败代价因子；垃圾值 ⇒ benign） */
  riskTier?: 'benign' | 'sensitive' | 'destructive';
  /** 步数浪费（失败代价因子；缺席 ⇒ 申报先验） */
  stepsWasted?: number;
  /** 累计惊异 bits（缺席 ⇒ 惊异谱回落链） */
  surpriseBits?: number;
  /** 场景类型键（surpriseSpectrum 谱键 —— 谱命中通道） */
  sceneType?: string;
  /** 历史决策序列（逐步 diff 的对照面；缺席 ⇒ 从 approach 尽力解析） */
  history?: DreamHistoricalStep[];
  /** 冻结世界参数（缺席 ⇒ 由轨迹指纹确定性派生） */
  world?: DreamWorldParams;
}

/** PER 公式的分解审计面（三因子各自的读数 —— 晨报可回算） */
export interface DreamPriorityFactors {
  surpriseBits: number;
  surpriseSource: 'trajectory' | 'spectrum-key' | 'spectrum-mean' | 'prior';
  cost: number;
  recency: number;
}

/** EXP4 面（EvolutionEngine 的结构子集 —— 只读消费 greedyArm/armProbabilities，
 *  双写走 ingest；index.ts 经 type-only 推导，生产传单例、测试传假件） */
export type DreamEvolutionLike = Pick<EvolutionEngine, 'greedyArm' | 'armProbabilities' | 'ingest'>;

/** 一条轨迹的梦回放审计行 */
export interface DreamReplayEntry {
  id: string;
  /** PER 优先级（p = ŝ × cost × recency，网格化到 1e-6） */
  priority: number;
  factors: DreamPriorityFactors;
  /** 同构世界审计面（master=冻结的流水主种子（重放确定性的锚）、seed/index=
   *  从流水取到的世界自身种子与序号、difficulty/推导指纹） */
  world: { master: number; seed: number; index: number; difficulty: number; fingerprint: string };
  /** 是否真的重放了（预算掐断/水位线跳过/铸造失败 ⇒ false） */
  replayed: boolean;
  /** 重放结局（replayed=true 时在场） */
  replay?: {
    success: boolean;
    steps: number;
    phase: string;
    /** 当前策略的动作 kind 序列 */
    strategies: string[];
    /** 首个分歧点（历史 vs 重放的步序 diff；null = 无分歧或无对照面） */
    divergence: number | null;
  };
  /** 分歧点之后的双写执法面（无分歧 ⇒ 双 skipped） */
  doubleWrite: { kernel: boolean; evolution: boolean };
  /** 反事实教训（重放成功且历史失败 ⇒ 在场；进晨报） */
  lesson?: string;
  /** 跳过/钳制/故障注记（诚实面） */
  note?: string;
}

/** 一次梦回放批次的总汇报（晨报侧车 + trace 行的形状） */
export interface DreamReplayReport {
  /** 梦回放独立水位线（输入失败集指纹 —— 防重复回放） */
  watermark: string;
  /** PER 选出的候选条数（含被预算掐断的） */
  attempted: number;
  replayed: number;
  successes: number;
  divergences: number;
  /** 反事实教训清单（重放成功而历史失败 —— 晨报消费面） */
  lessons: string[];
  entries: DreamReplayEntry[];
  budget: { maxDreams: number; maxStepsPerDream: number; truncated: boolean; reason: 'none' | 'count' | 'time' };
  /** 实验室 kernel 证据摘要（现有 lab 记账通道的产出对账面） */
  kernelEvidence: Array<{ key: string; n: number }>;
  /** 批次级诚实注记（无失败轨迹/水位线未动/…） */
  note?: string;
}

/** 梦回放编排的依赖面（index.ts 第①幕复合幕的消费契约） */
export interface DreamReplayDeps {
  /** 已映射的失败轨迹（dreamTrajectories 的产出） */
  trajectories: DreamFailureTrajectory[];
  /** 惊异谱（surpriseSpectrum 产出 —— PER 惊异因子的谱回落通道） */
  spectrum?: Record<string, number>;
  /** 注入时钟（PER 新近衰减；缺省恒 0 —— age 上限钳制的诚实退化） */
  now?: () => number;
  /** 睡眠预算检查（实读 sleep 预算机制：safeNow(now) − startedAt > budgetMs） */
  overBudget: () => boolean;
  /** EXP4 面（缺席 ⇒ evolution 双写缺席，注记在案） */
  evolution?: DreamEvolutionLike;
  /** 梦回放预算（缺省 DREAM_BUDGET_DEFAULTS；夹取律见 resolveDreamBudget） */
  budget?: { maxDreams?: number; maxStepsPerDream?: number };
  /** 上次已消化的梦回放水位线（独立水位线幂等执法的锚） */
  priorWatermark?: string | null;
  /** 梦 gym 种子（缺省由批次指纹派生 —— 确定性） */
  gymSeed?: number;
}

/** runDreamReplay 的返回：报告 + 实验室句柄（集成侧 promoteFrom 晋升的线头） */
export interface DreamReplayHandle {
  report: DreamReplayReport;
  /** 梦训练营实验室（隔离铁律：绝非遗漏生产单例；外部显式 promoteFrom 才晋升） */
  lab: GymLabSuite | null;
}

// ─── 失败记录 → 梦轨迹（防御映射 + 冻结参数派生） ───

/** 历史动作 kind 词表（approach 尽力解析的字面 —— 与 PolicyAction kinds 同源） */
const KNOWN_KINDS: readonly string[] = [
  'click', 'scroll', 'type', 'hotkey', 'drag', 'inspect', 'ask_vlm', 'recall_skill', 'wait', 'escalate', 'declare',
  // 旧工具层方言（actionSignature 的 name 面）一并认领
  'click_mouse', 'type_text', 'scroll_wheel', 'press_keys', 'zoom_inspect',
];

/**
 * 从 approach 文本尽力解析历史决策序列（确定性、绝不抛）：贪心最长词匹配 ——
 * 逐位扫描，每位置取词表中最长的命中词（'click_mouse' 不被 'click' 拆成两步），
 * 取前 HISTORY_MAX 步。这是**申报的尽力面**：真实失败记录的 approach 是
 * 「工具+参数摘要」自由文本，解析不全是诚实降级（history 越短，分歧点越晚或
 * 缺席 —— 绝不伪造未发生的决策）。
 */
function parseHistoryFromApproach(approach: string): DreamHistoricalStep[] {
  const text = typeof approach === 'string' ? approach : '';
  if (text === '') return [];
  const sorted = [...KNOWN_KINDS].sort((a, b) => b.length - a.length); // 长词优先
  const steps: DreamHistoricalStep[] = [];
  let i = 0;
  while (i < text.length && steps.length < HISTORY_MAX) {
    let matched = false;
    for (const kind of sorted) {
      if (text.startsWith(kind, i)) {
        steps.push({ kind });
        i += kind.length;
        matched = true;
        break;
      }
    }
    if (!matched) i += 1;
  }
  return steps;
}

/** 轨迹身份指纹的最小结构面（净化中途的半成品也可取指纹） */
interface FingerprintInput {
  query: string;
  approach: string;
  symptom: string;
  sceneHash?: string;
}

/** 轨迹身份指纹（同构世界种子派生 + 水位线的原料；缺 sceneHash 时用文本三元组） */
function trajectoryFingerprint(t: FingerprintInput): string {
  const scene = typeof t.sceneHash === 'string' && t.sceneHash ? t.sceneHash : '';
  if (scene) return scene;
  return `${t.query}|${t.approach}|${t.symptom}`.slice(0, 200);
}

/**
 * 失败记录 → 梦轨迹批次（防御式，绝不抛）：
 *   · 逐条净化（id/query/approach/symptom/at 防守；垃圾条目静默剔除）；
 *   · 冻结世界参数：显式 world 优先（seed/difficulty/noise/weights 原样采用 ——
 *     「场景输入冻结」的强形式）；缺席 ⇒ 由轨迹身份确定性派生（seed 与难度皆
 *     指纹哈希钉死 —— 同轨迹恒同世界，派生过程申报在案）；
 *   · history：显式序列优先；缺席 ⇒ approach 尽力解析；
 *   · 输入既可是 FailureRecord[]（生产：failureMemory.dump().records）也可是
 *     已铸的 DreamFailureTrajectory[]（测试）—— 同一净化律。
 */
export function dreamTrajectories(raw: unknown): DreamFailureTrajectory[] {
  if (!Array.isArray(raw)) return [];
  const out: DreamFailureTrajectory[] = [];
  raw.forEach((item, idx) => {
    if (!item || typeof item !== 'object') return;
    const r = item as Partial<FailureRecord> & Partial<DreamFailureTrajectory>;
    const id =
      typeof r.id === 'number' && Number.isFinite(r.id) ? String(Math.floor(r.id))
      : typeof r.id === 'string' && r.id ? r.id
      : null;
    if (id === null) return; // 无身份的轨迹不成梦（防重复回放失去锚）
    const query = typeof r.query === 'string' ? r.query.slice(0, 200) : '';
    const approach = typeof r.approach === 'string' ? r.approach.slice(0, 300) : '';
    const symptom = typeof r.symptom === 'string' ? r.symptom.slice(0, 300) : '';
    const at = typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0;
    const sceneHash = typeof r.sceneHash === 'string' && r.sceneHash ? r.sceneHash.slice(0, 100) : undefined;
    const rootCause = typeof r.rootCause === 'string' && r.rootCause ? r.rootCause.slice(0, 40) : undefined;
    const riskTier =
      r.riskTier === 'sensitive' || r.riskTier === 'destructive' ? r.riskTier
      : r.riskTier === 'benign' ? 'benign'
      : undefined;
    const stepsWasted = finiteNonNeg(r.stepsWasted) ?? undefined;
    const surpriseBits = finiteNonNeg(r.surpriseBits) ?? undefined;
    const sceneType = typeof r.sceneType === 'string' && r.sceneType ? r.sceneType.slice(0, 64) : undefined;
    // 冻结世界参数：显式优先，否则指纹派生（确定性 —— 同轨迹恒同世界）
    const fp = trajectoryFingerprint({ query, approach, symptom, sceneHash });
    const rawWorld = r.world && typeof r.world === 'object' ? (r.world as Partial<DreamWorldParams>) : {};
    const seedOk = typeof rawWorld.seed === 'number' && Number.isFinite(rawWorld.seed) && rawWorld.seed >= 0;
    const diffOk =
      typeof rawWorld.difficulty === 'number' && Number.isFinite(rawWorld.difficulty)
        ? Math.min(3, Math.max(1, Math.floor(rawWorld.difficulty)))
        : null;
    const world: DreamWorldParams = {
      seed: seedOk ? Math.floor((rawWorld as { seed: number }).seed) % 0x80000000 : fnv1a(`w5-2:dream-world:${id}:${fp}`) % 0x7fffffff,
      ...(diffOk !== null ? { difficulty: diffOk } : { difficulty: 1 + (fnv1a(`w5-2:dream-diff:${id}:${fp}`) % 3) }),
      ...(rawWorld.noise && typeof rawWorld.noise === 'object' ? { noise: rawWorld.noise as GymNoiseSpec } : {}),
      ...(rawWorld.weights && typeof rawWorld.weights === 'object' && !Array.isArray(rawWorld.weights)
        ? { weights: rawWorld.weights as Record<string, number> }
        : {}),
    };
    const history = Array.isArray(r.history)
      ? r.history
          .filter((s): s is DreamHistoricalStep => !!s && typeof s === 'object' && typeof (s as DreamHistoricalStep).kind === 'string')
          .slice(0, HISTORY_MAX)
          .map(s => ({
            kind: String(s.kind).slice(0, 24),
            ...(typeof s.label === 'string' && s.label ? { label: s.label.slice(0, 60) } : {}),
          }))
      : parseHistoryFromApproach(approach);
    out.push({
      id,
      query,
      approach,
      symptom,
      ...(sceneHash !== undefined ? { sceneHash } : {}),
      ...(rootCause !== undefined ? { rootCause } : {}),
      at,
      ...(riskTier !== undefined ? { riskTier } : {}),
      ...(stepsWasted !== undefined ? { stepsWasted } : {}),
      ...(surpriseBits !== undefined ? { surpriseBits } : {}),
      ...(sceneType !== undefined ? { sceneType } : {}),
      ...(history.length > 0 ? { history } : {}),
      world,
    });
  });
  return out;
}

// ─── PER 优先级（纯函数、模块常量、手算可验） ───

/**
 * 惊异 bits 的证据回落链（诚实缺席律）：轨迹自带 > 谱按键命中 > 谱均值 > 先验。
 * 返回值连同来源申报（surpriseSource）—— 晨报可回算「这个 0.37 是哪来的」。
 */
function resolveSurpriseBits(
  t: DreamFailureTrajectory,
  spectrum: Record<string, number> | undefined,
): { bits: number; source: DreamPriorityFactors['surpriseSource'] } {
  const own = finiteNonNeg(t.surpriseBits);
  if (own !== null) return { bits: own, source: 'trajectory' };
  if (spectrum && typeof spectrum === 'object' && !Array.isArray(spectrum)) {
    const key = typeof t.sceneType === 'string' ? t.sceneType : '';
    if (key && finiteNonNeg(spectrum[key]) !== null) {
      return { bits: finiteNonNeg(spectrum[key]) as number, source: 'spectrum-key' };
    }
    const vals = Object.values(spectrum).map(v => finiteNonNeg(v)).filter((v): v is number => v !== null);
    if (vals.length > 0) {
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      if (Number.isFinite(mean)) return { bits: Math.max(0, mean), source: 'spectrum-mean' };
    }
  }
  return { bits: PER_WEIGHTS.surprisePriorBits, source: 'prior' };
}

/**
 * W5-2 PER 优先级（纯函数、绝不抛）：
 *   p = ŝ × cost × recency
 *   ŝ = bits/(bits+surpriseHalfBits)；cost = riskFactor × (1 + min(waste,wasteCap)/wasteCap)；
 *   recency = 2^(−age/halfLifeMs)，age = max(0, now − at)（at 缺席按 0 —— 「未知
 *   年龄视为新鲜」：宁可多给一次梦，不可静默永不回放）。
 * 网格化 1e-6（防浮点尾噪 —— 同输入同输出，可重放）。垃圾输入逐因子回落申报
 * 先验/缺省，结果恒有限非负。
 */
export function computeDreamPriority(
  t: DreamFailureTrajectory,
  ctx: { spectrum?: Record<string, number>; now?: number } = {},
): { p: number; factors: DreamPriorityFactors } {
  const { bits, source } = resolveSurpriseBits(t, ctx.spectrum);
  const denom = bits + PER_WEIGHTS.surpriseHalfBits;
  const surpriseFactor = denom > 0 && Number.isFinite(denom) ? bits / denom : 0;
  const tier = t.riskTier === 'sensitive' || t.riskTier === 'destructive' ? t.riskTier : 'benign';
  const wasteRaw = finiteNonNeg(t.stepsWasted) ?? PER_WEIGHTS.stepsWastedPrior;
  const wasteFactor = 1 + Math.min(wasteRaw, PER_WEIGHTS.wasteCap) / PER_WEIGHTS.wasteCap;
  const cost = PER_WEIGHTS.riskFactor[tier] * wasteFactor;
  const now = typeof ctx.now === 'number' && Number.isFinite(ctx.now) ? ctx.now : 0;
  const age = Math.max(0, now - (typeof t.at === 'number' && Number.isFinite(t.at) ? t.at : 0));
  const recency = Math.pow(2, -age / PER_WEIGHTS.halfLifeMs);
  const p = surpriseFactor * cost * (Number.isFinite(recency) ? recency : 0);
  return {
    p: Number.isFinite(p) ? Math.round(p * PRIORITY_GRID) / PRIORITY_GRID : 0,
    factors: {
      surpriseBits: Math.round(bits * PRIORITY_GRID) / PRIORITY_GRID,
      surpriseSource: source,
      cost: Math.round(cost * PRIORITY_GRID) / PRIORITY_GRID,
      recency: Math.round(recency * PRIORITY_GRID) / PRIORITY_GRID,
    },
  };
}

/**
 * 梦回放批次水位线（纯函数）：输入失败集的**身份指纹**（id/at/sceneHash/文本
 * 三元组/冻结世界参数的规范形，按 id 排序 —— 与 now 与优先级无关：年龄增长
 * 不改变「这批失败已梦过」的事实，防重复回放的锚是身份不是分数）。
 */
export function dreamBatchWatermark(trajectories: DreamFailureTrajectory[]): string {
  const canon = trajectories
    .map(t => [
      t.id,
      typeof t.at === 'number' && Number.isFinite(t.at) ? t.at : 0,
      t.sceneHash ?? '',
      t.query,
      t.approach,
      t.symptom,
      t.world?.seed ?? -1,
      t.world?.difficulty ?? -1,
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(row => JSON.stringify(row));
  return `dream-${fnv1a(canon.join('')).toString(16)}`;
}

// ─── 同构世界选取（从 pcgWorldStream 取 —— seed 与世界参数来自原轨迹） ───

/**
 * W5-2 同构世界选取（确定性纯函数，绝不抛）：
 *   master = fnv1a('w5-2:dream:master:<id>:<指纹>') —— 轨迹身份钉死的流水主种子；
 *   index  = fnv1a('w5-2:dream:index:<id>:<指纹>') % DREAM_STREAM_WINDOW；
 *   world  = pcgWorldStream(master, 冻结语法制量).nth(index)。
 * 「同构」的落地：失败记录只携场景指纹与文本，同构世界按指纹确定性映射到文法
 * 世界 —— 同轨迹恒同世界（重放确定性的地基）；显式 world 参数（seed/难度/
 * 噪声/课程权重）原样入语法量（「冻结场景输入」的强形式：当时的课程偏置也冻结）。
 */
export function pickIsomorphicWorld(t: DreamFailureTrajectory): {
  world: PcgWorld;
  index: number;
  master: number;
} {
  const fp = trajectoryFingerprint(t);
  const index = fnv1a(`w5-2:dream:index:${t.id}:${fp}`) % DREAM_STREAM_WINDOW;
  const w = t.world ?? {};
  const grammar: GymGrammarOptions = {
    ...(typeof w.difficulty === 'number' && Number.isFinite(w.difficulty)
      ? { difficulty: Math.min(3, Math.max(1, Math.floor(w.difficulty))) }
      : {}),
    ...(w.noise && typeof w.noise === 'object' ? { noise: w.noise } : {}),
    ...(w.weights && typeof w.weights === 'object' && !Array.isArray(w.weights) ? { weights: w.weights } : {}),
  };
  // 冻结的流水主种子：显式 world.seed 优先，否则由轨迹身份确定性派生（同律
  // dreamTrajectories 的派生口径 —— master 即「场景输入冻结」的种子锚）
  const master = typeof w.seed === 'number' && Number.isFinite(w.seed) && w.seed >= 0
    ? Math.floor(w.seed) % 0x80000000
    : fnv1a(`w5-2:dream-world:${t.id}:${fp}`) % 0x7fffffff;
  // 从流水取第 index 个世界（构造即推导 —— 零渲染开销，直到 capture 才碰 sharp）
  const stream = pcgWorldStream(master, grammar);
  let picked = stream.next().value as PcgWorld;
  for (let i = 0; i < index; i++) picked = stream.next().value as PcgWorld;
  return { world: picked, index, master };
}

// ─── 分歧点定位（纯函数） ───

/**
 * 首个分歧点：历史决策序列 vs 当前策略重放动作序的第一个不同 kind 的下标。
 * 无历史对照面（空序列）或前缀完全一致 ⇒ null（「当前策略尚未分歧」—— 双写
 * 的门槛：无分歧 ⇒ 重放与历史同路，结局无新信息，不双写）。比较只到双序列
 * 较短者（重放步数受预算钳制 —— 钳制不是分歧）。
 */
export function locateDivergence(history: DreamHistoricalStep[] | undefined, replay: string[]): number | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  if (!Array.isArray(replay)) return null;
  const n = Math.min(history.length, replay.length);
  for (let i = 0; i < n; i++) {
    if (history[i]?.kind !== replay[i]) return i;
  }
  return null;
}

// ─── 预算解析（防御夹取） ───

/** 梦回放预算解析（缺省 DREAM_BUDGET_DEFAULTS；越界/垃圾 ⇒ 夹取，绝不抛） */
export function resolveDreamBudget(raw: unknown): { maxDreams: number; maxStepsPerDream: number } {
  const o = raw && typeof raw === 'object' ? (raw as { maxDreams?: unknown; maxStepsPerDream?: unknown }) : {};
  const dRaw = Number(o.maxDreams);
  const maxDreams = Number.isFinite(dRaw)
    ? Math.min(DREAM_BUDGET_DEFAULTS.maxDreamsCap, Math.max(0, Math.floor(dRaw)))
    : DREAM_BUDGET_DEFAULTS.maxDreams;
  const sRaw = Number(o.maxStepsPerDream);
  const maxStepsPerDream = Number.isFinite(sRaw)
    ? Math.min(DREAM_BUDGET_DEFAULTS.maxStepsCap, Math.max(1, Math.floor(sRaw)))
    : DREAM_BUDGET_DEFAULTS.maxStepsPerDream;
  return { maxDreams, maxStepsPerDream };
}

// ─── 梦回放编排（永不抛；确定性；预算纪律；分歧点双写） ───

/**
 * W5-2 梦回放编排（async —— sharp 合成帧是唯一的真异步面）：
 *   1. 独立水位线幂等：批次指纹 === priorWatermark ⇒ 全跳过（note 申报，防重复回放）；
 *   2. PER 排序选 top-maxDreams（p 降序、平票 id 升序 —— 确定性法院）；
 *   3. 逐条：预算检查（overBudget —— 实读 sleep 预算机制，条间执法）⇒ 取同构
 *      世界（冻结输入）⇒ 梦训练营 runPcgWorld 重决策（现有 policyEngine 决策面
 *      + 离线哨兵 client + 宪法 + Θ-3 全套记账 —— 全是既有执法面，只读消费）；
 *   4. 分歧点之后双写：(a) kernel 证据 —— runPcgWorld 期间已按现有 lab 记账通道
 *      入账（世界真相对账四键），分歧结局另记 dream.counterfactual 一条（margin =
 *      分歧步序）；(b) evolutionEngine.ingest 带 bandit 标注（arm/prob 取自 EXP4
 *      greedy 的只读面 —— 重放不采样铁律）；
 *   5. 重放成功且历史失败 ⇒ 反事实教训条目（晨报消费面）。
 * 确定性：世界 seed 冻结 + 梦训练营虚拟时钟 + 离线哨兵 client ⇒ 同轨迹同策略
 * 状态逐字节同重放。隔离：梦实验室独立自铸（Θ-3 律），生产 kernel 分毫不动。
 */
export async function runDreamReplay(deps: DreamReplayDeps): Promise<DreamReplayHandle> {
  const empty: DreamReplayHandle = {
    report: {
      watermark: '',
      attempted: 0, replayed: 0, successes: 0, divergences: 0,
      lessons: [], entries: [],
      budget: { ...resolveDreamBudget(deps?.budget), truncated: false, reason: 'none' },
      kernelEvidence: [],
    },
    lab: null,
  };
  try {
    const d = deps && typeof deps === 'object' ? deps : ({} as DreamReplayDeps);
    const trajectories = Array.isArray(d.trajectories) ? d.trajectories.filter(t => t && typeof t === 'object') : [];
    const budget = resolveDreamBudget(d.budget);
    const base = {
      ...empty.report,
      budget: { ...budget, truncated: false, reason: 'none' as const },
    };
    if (trajectories.length === 0) {
      return { report: { ...base, note: '梦回放跳过：无失败轨迹（失败记忆为空或全部垃圾 —— 诚实缺席）' }, lab: null };
    }
    const watermark = dreamBatchWatermark(trajectories);
    if (typeof d.priorWatermark === 'string' && d.priorWatermark === watermark) {
      return {
        report: { ...base, watermark, note: '梦回放水位线未动 —— 本轮零回放（同一失败集已梦过，防重复回放）' },
        lab: null,
      };
    }
    if (budget.maxDreams <= 0) {
      return { report: { ...base, watermark, note: '梦回放预算 maxDreams=0 —— 关闭（申报在案）' }, lab: null };
    }

    // PER 打分 + 确定性排序（p 降序；平票 id 升序）
    const now = typeof d.now === 'function' ? d.now() : 0;
    const nowSafe = typeof now === 'number' && Number.isFinite(now) ? now : 0;
    const scored = trajectories.map(t => {
      const { p, factors } = computeDreamPriority(t, { spectrum: d.spectrum, now: nowSafe });
      return { t, p, factors };
    });
    scored.sort((a, b) => b.p - a.p || String(a.t.id).localeCompare(String(b.t.id)));
    const selected = scored.slice(0, budget.maxDreams);

    // 梦训练营：一批一馆（共享隔离实验室 —— 梦证据同本累积；虚拟时钟确定性；
    // runPcgWorld 不 ingest 馆内引擎 ⇒ 馆内进化面零扰动，双写只走显式 evolution dep）
    const gymSeed = typeof d.gymSeed === 'number' && Number.isFinite(d.gymSeed) && d.gymSeed >= 0
      ? Math.floor(d.gymSeed) % 0x80000000
      : fnv1a(`w5-2:dream:gym:${watermark}`) % 0x7fffffff;
    let dreamClock = 2_000_000;
    const gym = new AutonomyGym({ seed: gymSeed, maxSteps: budget.maxStepsPerDream, now: () => (dreamClock += 5) });

    const entries: DreamReplayEntry[] = [];
    const lessons: string[] = [];
    let replayed = 0;
    let successes = 0;
    let divergences = 0;
    let truncated = false;
    let reason: 'none' | 'count' | 'time' = 'none';

    for (const s of selected) {
      // 预算纪律：条间实读睡眠预算（safeNow(now) − startedAt > budgetMs 的既有执法面）
      if (d.overBudget()) {
        truncated = true;
        reason = 'time';
        entries.push({
          id: s.t.id, priority: s.p, factors: s.factors,
          world: { master: -1, seed: -1, index: -1, difficulty: -1, fingerprint: '' },
          replayed: false,
          doubleWrite: { kernel: false, evolution: false },
          note: '睡眠预算耗尽 —— 本条未回放（宁短勿挂）',
        });
        continue;
      }
      let picked: ReturnType<typeof pickIsomorphicWorld>;
      try {
        picked = pickIsomorphicWorld(s.t);
      } catch (e) {
        entries.push({
          id: s.t.id, priority: s.p, factors: s.factors,
          world: { master: -1, seed: -1, index: -1, difficulty: -1, fingerprint: '' },
          replayed: false, doubleWrite: { kernel: false, evolution: false },
          note: `同构世界铸造故障（旁路吸收）：${e instanceof Error ? e.message : String(e)}`,
        });
        continue;
      }
      // 重放：现有闭环执法面（runPcgWorld 自带防弹壳 —— 内部异常收敛为失败轮）
      const round = await gym.runPcgWorld(picked.world);
      const strategies = Array.isArray(round.strategies) ? round.strategies : [];
      const divergence = locateDivergence(s.t.history, strategies);
      const replayView = {
        success: round.result.success === true,
        steps: Number.isFinite(round.result.steps) ? round.result.steps : 0,
        phase: typeof round.result.phase === 'string' ? round.result.phase : '?',
        strategies,
        divergence,
      };
      const entry: DreamReplayEntry = {
        id: s.t.id,
        priority: s.p,
        factors: s.factors,
        world: {
          master: picked.master,
          seed: picked.world.seed,
          index: picked.index,
          difficulty: picked.world.derivation.difficulty,
          fingerprint: picked.world.derivation.fingerprint,
        },
        replayed: true,
        replay: replayView,
        doubleWrite: { kernel: false, evolution: false },
      };
      replayed += 1;
      if (replayView.success) successes += 1;
      if (divergence !== null) divergences += 1;

      // ── 分歧点双写（首个分歧点之后才有新信息；无分歧 ⇒ 双缺席 + 注记） ──
      if (divergence === null) {
        entry.note = '无分歧点（当前策略与历史前缀一致或无历史对照面）—— 不双写（重放结局无新信息）';
      } else {
        // (a) kernel 证据：现有 lab 记账通道（runPcgWorld 已记 Θ-3 四键 + pcg.truth.*；
        //     分歧结局补记 dream.counterfactual，margin = 分歧步序）
        try {
          gym.lab?.ledger.record({
            key: 'dream.counterfactual',
            success: replayView.success,
            margin: divergence,
            ts: dreamClock,
          });
          entry.doubleWrite.kernel = true;
        } catch {
          entry.doubleWrite.kernel = false; // 记账绝不炸梦
        }
        // (b) evolution 双写：ingest 带 bandit 标注（EXP4 greedy 只读面 —— 重放不采样）
        const evo = d.evolution;
        if (evo && typeof evo.greedyArm === 'function' && typeof evo.armProbabilities === 'function' && typeof evo.ingest === 'function') {
          try {
            const ctx = {
              scene: entry.world.fingerprint.slice(0, 32),
              failureCluster: typeof s.t.rootCause === 'string' && s.t.rootCause ? s.t.rootCause : 'unknown',
              worldKind: 'pcg',
              stepsRemaining: Math.max(0, budget.maxStepsPerDream - replayView.steps),
              budget: budget.maxStepsPerDream,
            };
            const arm = evo.greedyArm(ctx);
            const dist = evo.armProbabilities(ctx);
            const prob = typeof dist?.[arm] === 'number' && Number.isFinite(dist[arm]) && dist[arm] > 0
              ? Math.min(1, dist[arm])
              : 1;
            const record: RunRecord = {
              goal: `梦回放:${s.t.query}`.slice(0, 120),
              success: replayView.success,
              steps: replayView.steps,
              durationMs: round.result.durationMs,
              strategies,
              ...(replayView.success ? {} : { failureRootCause: `dream-replay:phase=${replayView.phase}` }),
              bandit: { context: ctx, arm, prob },
            };
            evo.ingest(record);
            entry.doubleWrite.evolution = true;
          } catch {
            entry.doubleWrite.evolution = false; // 进化双写绝不炸梦
          }
        } else {
          entry.note = 'evolution 面缺席 —— EXP4 双写缺席（诚实注记）';
        }
        // 反事实教训：重放成功而历史失败（失败轨迹恒历史失败 —— 梦的全部前提）
        if (replayView.success) {
          const histKind = s.t.history?.[divergence]?.kind ?? '?';
          const replayKind = strategies[divergence] ?? '?';
          const lesson =
            `反事实教训：任务「${s.t.query.slice(0, 60)}」第 ${divergence + 1} 步的决策「${histKind}」在同构世界（指纹 ${entry.world.fingerprint.slice(0, 12)}、seed ${entry.world.seed}）本可被纠正 —— ` +
            `当前策略改走「${replayKind}」后重放成功（${replayView.steps} 步）；同类场景重试前优先考虑 ${replayKind}，勿原样重试 ${histKind}。`;
          entry.lesson = lesson;
          lessons.push(lesson);
        }
      }
      entries.push(entry);
    }

    if (!truncated && selected.length < scored.length) {
      truncated = true;
      reason = 'count';
    }

    // kernel 证据对账面（现有 lab 记账通道的产出盘点）
    const kernelEvidence: Array<{ key: string; n: number }> = [];
    try {
      const ledger = gym.lab?.ledger;
      if (ledger) {
        for (const key of ledger.keys()) {
          const st = ledger.stats(key);
          kernelEvidence.push({ key, n: st.n });
        }
      }
    } catch {
      /* 对账面故障 ⇒ 缺席（记账本身已成功） */
    }

    return {
      report: {
        watermark,
        attempted: selected.length,
        replayed,
        successes,
        divergences,
        lessons,
        entries,
        budget: { ...budget, truncated, reason },
        kernelEvidence,
      },
      lab: gym.lab,
    };
  } catch (e) {
    // 永不抛铁律：编排器自身的意外故障也收敛为诚实报告
    return {
      report: {
        ...empty.report,
        note: `梦回放编排意外故障（已吞，绝不炸睡眠）：${e instanceof Error ? e.message : String(e)}`,
      },
      lab: null,
    };
  }
}
