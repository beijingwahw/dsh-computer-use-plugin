// src/diagnosis.ts
// W6-2 结构性保留（doctor smell.over-engineering 登记）：H 纪元会诊皮层 —— 贝叶斯 CPT 标定/规则表/遥测观测/R1 根因链四节共享同一症候群词表与首中即断序，规则表与证据词表必须同框审计。
// H 纪元（创世纪·场的统一）：联合诊断皮层 —— 统计引擎之上的症候群规则表。
//
// 孤立信号只能报告「某指标异常」；症候群（信号组合）才能诊断「得了什么病」。
// E/F/G 三纪元装了七个观测引擎（noop 率/熵率/CUSUM/Hurst/GPD 尾/复杂度/……），
// 本模块是它们的会诊台：确定性规则表（非概率图模型 —— 规则可审计、可回放），
// 按诊断价值排序，首中即断。
//
// 诚实边界：规则阈值是各引擎洞见阈值的复用（不引入新旋钮）；规则间的互斥性
// 由优先序保证（先具体后一般）。贝叶斯网络/因果图是留白 —— 当前无训练数据。
//
// W1-6 注记：本文件末节新增「R1 鉴别试验根因归因链」—— 会诊台诊断系统级
// 症候群，R1 节诊断单次失败的病因；两者共享「首中即断 + 证据可回放」哲学。

// ─── K 纪元（留白兑现之四）：贝叶斯会诊 —— 规则表的概率侧写 ───
// 设计立场：确定性规则表仍是**主诊断**（可审计、可回放）；本网络提供的是
// 「证据组合的信念侧写」—— 六症候群后验（均匀先验 × 专家 CPT，精确枚举
// 归一，零近似、零采样、确定性）。无训练数据时 CPT 是专家律；值即边界。

/** 信号 → 布尔视图（缺席 = 不参与似然） */
interface BinarySignals {
  shifted: boolean | null;   // CUSUM 告警在场
  hurstHigh: boolean | null; // H > 0.6
  loop: boolean | null;      // 行为近周期判据
  heavyTail: boolean | null; // GPD ξ≥0.25
  highNoop: boolean | null;  // noop 洞见在场
}

type SyndromeId =
  'shift-and-cluster' | 'regime-shift' | 'deterministic-loop'
  | 'failure-clustering' | 'blind-clicking' | 'stall-regime';

/**
 * 专家 CPT：P(signal=on | syndrome)。行 = 症候群，列 = [shifted, hurstHigh,
 * loop, heavyTail, highNoop]。0.5 = 该症候群对此信号无主张（中性似然）。
 */
const BN_CPT: Record<SyndromeId, [number, number, number, number, number]> = {
  'shift-and-cluster':   [0.90, 0.85, 0.20, 0.30, 0.30],
  'regime-shift':        [0.85, 0.30, 0.20, 0.25, 0.35],
  'deterministic-loop':  [0.15, 0.35, 0.90, 0.10, 0.45],
  'failure-clustering':  [0.20, 0.90, 0.30, 0.25, 0.30],
  'blind-clicking':      [0.10, 0.20, 0.25, 0.10, 0.92],
  'stall-regime':        [0.20, 0.25, 0.10, 0.90, 0.25],
};
const BN_SIGNAL_KEYS: Array<keyof BinarySignals> = ['shifted', 'hurstHigh', 'loop', 'heavyTail', 'highNoop'];

export interface BayesianBelief {
  syndrome: SyndromeId;
  /** 后验概率（三位置小数；全表和 = 1 —— 枚举精确归一） */
  posterior: number;
}

/**
 * 贝叶斯会诊（纯函数、确定性）：六症候群后验。
 * 输入信号全缺席 / 全 false ⇒ null（健康是诚实的缺席，不硬造分布）。
 * 消费方：get_metrics 在规则诊断之外附加 belief 块 —— 「首中即断」给处方，
 * 信念表给**证据组合的全景**（包括未被规则命中的竞争假设）。
 */
/**
 * M 纪元（留白兑现）：CPT 标定 —— 数据从哪来？**从审计过的确定性规则表蒸馏**。
 * 32 个信号组合全枚举 × 规则表 oracle（首中即断）⇒ 共现计数 + Beta(1,1) 平滑
 * + 向专家律收缩（4 伪计数托底）⇒ 拟合 CPT；agreement = 拟合后验 MAP 与规则
 * 判决的吻合率。数据血缘成文：oracle 可审计（diagnose 规则序）、蒸馏无参
 * （计数+平滑）—— 真实运行数据的接入点 = 替换 oracle 为遥测流，接口不变。
 */
export function calibrateCptFromRules(): {
  cpt: Record<string, [number, number, number, number, number]>;
  agreement: number;
  enumerated: number;
  ruleFired: number;
} {
  const keys = Object.keys(BN_CPT) as SyndromeId[];
  const counts: Record<string, number[]> = {};
  const fired: Record<string, number> = {};
  for (const s of keys) { counts[s] = [0, 0, 0, 0, 0]; fired[s] = 0; }
  let enumerated = 0, ruleFired = 0, agree = 0;
  for (let mask = 0; mask < 32; mask++) {
    enumerated++;
    const sig: CognitionSignals = {
      regimeShiftTools: mask & 1 ? ['x'] : [],
      hurst: mask & 2 ? 0.8 : 0.3,
      behavior: { normalized: mask & 4 ? 0.1 : 0.6, phrases: mask & 4 ? 4 : 10, length: 30 },
      heavyLatencyTail: !!(mask & 8),
      highNoopTools: mask & 16 ? ['y'] : [],
    };
    const dx = diagnose(sig);
    if (!dx) continue;
    ruleFired++;
    fired[dx.syndrome] += 1;
    BN_SIGNAL_KEYS.forEach((k, i) => {
      if (mask & (1 << i)) counts[dx.syndrome][i] += 1;
      void k;
    });
    const belief = bayesianBelief({
      shifted: !!(mask & 1), hurstHigh: !!(mask & 2), loop: !!(mask & 4),
      heavyTail: !!(mask & 8), highNoop: !!(mask & 16),
    });
    if (belief && belief[0].posterior > 0.5 && belief[0].syndrome === dx.syndrome) agree++;
  }
  const cpt: Record<string, [number, number, number, number, number]> = {};
  for (const s of keys) {
    const n = fired[s];
    cpt[s] = counts[s].map((c, i) => {
      const expert = BN_CPT[s][i];
      if (n === 0) return expert; // 规则未触达 ⇒ 专家律兜底（血缘标注）
      const fitted = (c + 1) / (n + 2);        // Beta(1,1) 后验均值
      const w = n / (n + 4);                   // 收缩权重：证据多则数据主导
      return Math.round((w * fitted + (1 - w) * expert) * 1000) / 1000;
    }) as [number, number, number, number, number];
  }
  return { cpt, agreement: ruleFired > 0 ? agree / ruleFired : 0, enumerated, ruleFired };
}

export function bayesianBelief(signals: BinarySignals): BayesianBelief[] | null {
  const observed = BN_SIGNAL_KEYS.filter(k => signals[k] !== null);
  if (observed.length === 0) return null;
  if (observed.every(k => signals[k] === false)) return null;

  const logLike: Array<{ s: SyndromeId; ll: number }> = [];
  for (const s of Object.keys(BN_CPT) as SyndromeId[]) {
    let ll = Math.log(1 / 6); // 均匀先验
    BN_SIGNAL_KEYS.forEach((k, i) => {
      const v = signals[k];
      if (v === null) return; // 缺席不参与似然（missing-at-random 的最小假设）
      const pOn = BN_CPT[s][i];
      ll += Math.log(v ? pOn : 1 - pOn);
    });
    logLike.push({ s, ll });
  }
  // log-sum-exp 归一（数值稳定；六假设直接枚举 —— 无需近似）
  const m = Math.max(...logLike.map(x => x.ll));
  const ws = logLike.map(x => Math.exp(x.ll - m));
  const z = ws.reduce((a, b) => a + b, 0);
  return logLike
    .map((x, i) => ({ syndrome: x.s, posterior: Math.round((ws[i] / z) * 1000) / 1000 }))
    .sort((a, b) => b.posterior - a.posterior);
}

/** 会诊输入：各引擎的标准化信号（全部可缺席 —— 缺席不参与规则） */
export interface CognitionSignals {
  /** G-2：近期失败率突变的工具（CUSUM 告警者） */
  regimeShiftTools?: string[];
  /** G-6：结局流 Hurst 指数（>0.6 聚集） */
  hurst?: number | null;
  /** F-4：行为复杂度（归一化熵率 + 短语数 + 样本数） */
  behavior?: { normalized: number | null; phrases: number; length: number };
  /** F-2：延迟重尾（GPD ξ≥0.25） */
  heavyLatencyTail?: boolean;
  /** E/F/G 遥测基础：高 noop 率的工具（≥40% 且 ≥5 调用） */
  highNoopTools?: string[];
}

/** 会诊结论：症候群 + 诊断 + 处方（可执行的恢复动作） */
export interface Diagnosis {
  /** 症候群标识（机器可读） */
  syndrome:
    | 'shift-and-cluster'      // 环境突变 × 失败聚集（最险：双重恶性）
    | 'regime-shift'           // 环境变了（经验失效）
    | 'deterministic-loop'     // 行为近周期（卡死）
    | 'failure-clustering'     // 失败扎堆（短期相关）
    | 'blind-clicking'         // 高 noop（点空）
    | 'stall-regime';          // 延迟重尾（环境卡顿）
  /** 人类可读诊断（≤160 字符 —— Token 纪律） */
  diagnosis: string;
  /** 处方：下一步最优先的可执行动作序列（≤200 字符） */
  prescription: string;
  /** 触发本诊断的信号清单（归因透明 —— 审计可回放） */
  evidence: string[];
}

// W6-2（doctor smell.magic-number 清偿）：行为近周期判据的样本数下界（数值逐位不变）。
// 熵率臂：归一化熵率 ≤0.3 且样本 ≥24（渐近域）；短语臂：短语数 ≤6 且样本 ≥20
// （短序列的倍增签名 —— 归一化在小 n 时通胀，短语绝对数不受此影响）。
// 导出供 observabilityTools 洞见判据复用（「与 get_metrics 同律 —— 一处立法」）。
export const LOOP_ENTROPY_MIN_ACTIONS = 24;
export const LOOP_PHRASE_MIN_ACTIONS = 20;

const isLoop = (b?: CognitionSignals['behavior']): boolean =>
  !!b && (
    (b.normalized !== null && b.normalized <= 0.3 && b.length >= LOOP_ENTROPY_MIN_ACTIONS) ||
    (b.phrases <= 6 && b.length >= LOOP_PHRASE_MIN_ACTIONS)
  );

/**
 * 会诊主入口（纯函数）：规则按诊断价值降序，首中即断。
 * 全部信号正常 ⇒ null（健康是诚实的缺席，不是「轻度亚健康」）。
 */
export function diagnose(sig: CognitionSignals): Diagnosis | null {
  const shifted = sig.regimeShiftTools ?? [];
  const clustered = typeof sig.hurst === 'number' && sig.hurst > 0.6;

  // 1. shift-and-cluster（最高优先）：环境突变 + 失败聚集 —— 旧经验失效且失败
  //    短期相关：任何「再试一次」都是最差策略
  if (shifted.length > 0 && clustered) {
    return {
      syndrome: 'shift-and-cluster',
      diagnosis: `Environment changed AND failures cluster (${shifted.join(', ')} regressed, Hurst ${sig.hurst}): prior experience is stale and failures are autocorrelated.`,
      prescription: 'STOP retrying entirely. take_screenshot to re-observe the world; treat old landmarks/skills as unverified; if two fresh attempts fail, ask the user.',
      evidence: [`cusum-shift:${shifted.join('|')}`, `hurst:${sig.hurst}`],
    };
  }
  // 2. regime-shift：环境变了 —— 旧经验（记忆/技能/坐标）可能整体失效
  if (shifted.length > 0) {
    return {
      syndrome: 'regime-shift',
      diagnosis: `Recent regime shift in ${shifted.join(', ')}: the environment changed under you (failure rate jumped vs its own baseline).`,
      prescription: 'Re-observe with take_screenshot before trusting any remembered coordinate; re-verify landmarks via recall_ui + from_memory_id pre-check.',
      evidence: [`cusum-shift:${shifted.join('|')}`],
    };
  }
  // 3. deterministic-loop：行为近周期 —— 与屏幕侧循环检测（E-3）互补的行为面
  if (isLoop(sig.behavior)) {
    return {
      syndrome: 'deterministic-loop',
      diagnosis: `Action stream is near-periodic (${sig.behavior!.phrases} phrases over ${sig.behavior!.length} actions): you are spinning deterministically.`,
      prescription: 'Break the cycle deliberately: what_if for counterfactual routes, match_skill for a verified path, or a completely different modality (keyboard via press_hotkey).',
      evidence: [`behavior:${sig.behavior!.phrases}p/${sig.behavior!.length}a`],
    };
  }
  // 4. failure-clustering：失败短期相关 —— 重试前先换状态
  if (clustered) {
    return {
      syndrome: 'failure-clustering',
      diagnosis: `Failures cluster in time (Hurst ${sig.hurst}): after a failure the next attempt is more likely to fail too.`,
      prescription: 'Insert an observation between attempts (take_screenshot or diff_view) instead of immediate retries; alternate modalities across attempts.',
      evidence: [`hurst:${sig.hurst}`],
    };
  }
  // 5. blind-clicking：高 noop —— 坐标系统性偏差
  if ((sig.highNoopTools ?? []).length > 0) {
    return {
      syndrome: 'blind-clicking',
      diagnosis: `High no-op rate in ${(sig.highNoopTools ?? []).join(', ')}: actions report success but change nothing — coordinates are systematically off.`,
      prescription: 'Ground before acting: find_text for labeled targets, zoom_inspect for uncertain regions, recall_ui priors with pre-verification.',
      evidence: [`noop:${(sig.highNoopTools ?? []).join('|')}`],
    };
  }
  // 6. stall-regime：延迟重尾 —— 环境卡顿，细碎动作放大尾部
  if (sig.heavyLatencyTail) {
    return {
      syndrome: 'stall-regime',
      diagnosis: 'Latency distribution is heavy-tailed (GPD ξ≥0.25): the environment stalls sporadically — rapid small actions amplify tail cost.',
      prescription: 'Batch interactions (type full text at once, avoid rapid click sequences); lengthen settle expectations rather than assuming hangs.',
      evidence: ['gpd-tail:xi>=0.25'],
    };
  }
  return null;
}

// ─── O 纪元（#9）：CPT 真实遥测标定 —— oracle 换血（M 纪元的接入点兑现）───

/** 遥测观测：一次真实会诊现场的五信号布尔视图 + 出现频次（权重） */
export interface TelemetryObservation {
  shifted: boolean;
  hurstHigh: boolean;
  loop: boolean;
  heavyTail: boolean;
  highNoop: boolean;
  /** 该组合在真实日志中的出现次数（缺省 1） */
  weight?: number;
}

/**
 * 遥测 → 观测向量（标定管线的推导端）：从活体 Telemetry/Journal 提取当前
 * 五信号视图（与 observabilityTools.get_metrics 的洞见判据同律 —— 一处立法）。
 * 任一引擎数据不足 ⇒ 该信号 false（缺席不参与毒化）。
 */
export function observeSignalsForCalibration(deps: {
  regimeShifts: Array<{ tool: string }>;
  hurst: number | null;
  behavior: { normalized: number | null; phrases: number; length: number };
  heavyLatencyTail: boolean;
  highNoopTools: string[];
}): TelemetryObservation {
  return {
    shifted: deps.regimeShifts.length > 0,
    hurstHigh: typeof deps.hurst === 'number' && deps.hurst > 0.6,
    // W6-2：复用上方 isLoop 同律谓词（与 get_metrics 洞见判据一处立法）
    loop: isLoop(deps.behavior),
    heavyTail: deps.heavyLatencyTail === true,
    highNoop: deps.highNoopTools.length > 0,
  };
}

/**
 * CPT 遥测标定（M 纪元接口的换血版）：观测流（真实日志的信号组合 + 频次）
 * × 规则表 oracle 标签 ⇒ 共现计数 + Beta(1,1) 平滑 + 专家律收缩（与
 * calibrateCptFromRules 同律；差别仅在数据源 —— 枚举 32 均匀组合 vs 真实
 * 分布加权）。agreement = 加权吻合率。样本不足的症候群行由专家律托底
 * （血缘标注在同行的 cpt 值中不可分 —— 由 n 字段如实申报）。
 */
export function calibrateCptFromTelemetry(
  observations: readonly TelemetryObservation[],
): {
  cpt: Record<string, [number, number, number, number, number]>;
  agreement: number;
  sampled: number;      // 加权观测数
  distinct: number;     // 出现过的组合数（≤32）
  syndromeSamples: Record<string, number>;
} {
  const keys = Object.keys(BN_CPT) as SyndromeId[];
  const counts: Record<string, number[]> = {};
  const fired: Record<string, number> = {};
  for (const s of keys) { counts[s] = [0, 0, 0, 0, 0]; fired[s] = 0; }
  let sampled = 0, agree = 0;
  const distinct = new Set<string>();
  for (const obs of observations) {
    const w = Math.max(1, Math.floor(obs.weight ?? 1));
    distinct.add([obs.shifted, obs.hurstHigh, obs.loop, obs.heavyTail, obs.highNoop].map(b => b ? 1 : 0).join(''));
    const sig: CognitionSignals = {
      regimeShiftTools: obs.shifted ? ['x'] : [],
      hurst: obs.hurstHigh ? 0.8 : 0.3,
      behavior: { normalized: obs.loop ? 0.1 : 0.6, phrases: obs.loop ? 4 : 10, length: 30 },
      heavyLatencyTail: obs.heavyTail,
      highNoopTools: obs.highNoop ? ['y'] : [],
    };
    const dx = diagnose(sig);
    sampled += w;
    if (!dx) continue; // 健康组合：无症候群可归 —— 不参与计数（同 M 律）
    fired[dx.syndrome] += w;
    const bits = [obs.shifted, obs.hurstHigh, obs.loop, obs.heavyTail, obs.highNoop];
    bits.forEach((b, i) => { if (b) counts[dx.syndrome][i] += w; });
    const belief = bayesianBelief({
      shifted: obs.shifted, hurstHigh: obs.hurstHigh, loop: obs.loop,
      heavyTail: obs.heavyTail, highNoop: obs.highNoop,
    });
    if (belief && belief[0].posterior > 0.5 && belief[0].syndrome === dx.syndrome) agree += w;
  }
  const cpt: Record<string, [number, number, number, number, number]> = {};
  for (const s of keys) {
    const n = fired[s];
    cpt[s] = counts[s].map((c, i) => {
      const expert = BN_CPT[s][i];
      if (n === 0) return expert;
      const fitted = (c + 1) / (n + 2);
      const w = n / (n + 4); // 收缩权重与 calibrateCptFromRules 同律（样本少 ⇒ 专家律主导）
      return Math.round((w * fitted + (1 - w) * expert) * 1000) / 1000;
    }) as [number, number, number, number, number];
  }
  return {
    cpt,
    agreement: sampled > 0 ? Math.round((agree / sampled) * 1000) / 1000 : 0,
    sampled,
    distinct: distinct.size,
    syndromeSamples: fired,
  };
}

// ─── W1-6（R1 鉴别试验）：失败根因归因链 ───
//
// 会诊台（diagnose/bayesianBelief）回答「系统得了什么病」（症候群级）；本节
// 回答「这一次为什么败」（单次病因级）—— 医学鉴别诊断式（differential
// diagnosis）的探针瀑布：不猜，问世界。四步（首中即断，与规则表同哲学）：
//
//   ① 前后帧 visualDiff：动作报失败但屏变了 ⇒ over-strict-verification
//      （动作其实生效了 —— 校验器比世界更严，失败是误报，别盲目重试）
//   ② 屏没变 → 悬停光标探针：ibeam/hand ⇒ blind-spot-text
//      （该点是正文/语义热区，点击此路不通 —— 需键盘或换真控件）
//   ③ 连续帧冻结（dhash 相同）⇒ stall（世界没在重绘 —— 环境卡顿/挂起）
//   ④ 兜底 unknown（鉴别穷尽无决定性证人 —— 诚实的无知，不硬造病因）
//
// 每步探针产出「症状 → 鉴别 → 细化假设」链；终产物是排序根因候选列表，
// 每候选附触发的探针与观察值（审计可回放 —— 与 Diagnosis.evidence 同律）。
//
// 注入端口铁律：全部探针经 RootCauseProbePorts 注入（生产接线在 guards 层，
// 离线测试注入假帧/假光标/假 diff）。防御式：任何端口缺席/超时/抛错 ⇒ 降级
// 记入 degradedNotes，绝不抛、绝不阻塞主流程（归因是旁路观察者，不是闸门）。

import type { InteractivityVerdict } from './interactivityProbe'; // W1-6：只消费导出类型（type-only，零运行时耦合）
import type { DiffResult } from './visualDiff';                    // W1-6：同上（visualDiff 只读消费）
import { similarity } from './perceptualHash';                     // W1-6：dhash 回退通道的比较器（轻量纯模块）

/** W1-6：结构化根因枚举 —— failureMemory 的病因命名空间 + 遥测计数键 */
export type RootCauseId =
  | 'over-strict-verification' // ① 屏变了但报失败（校验过严类）
  | 'blind-spot-text'          // ② 该点不可点/需键盘（盲点文本型）
  | 'stall'                    // ③ 连续帧冻结（世界没在重绘）
  | 'unknown';                 // ④ 兜底（含探针缺席降级）

/** W1-6：运行时枚举面（防御解析/序列化往返的合法值域） */
export const ROOT_CAUSE_IDS: readonly RootCauseId[] = [
  'over-strict-verification', 'blind-spot-text', 'stall', 'unknown',
];

/**
 * W1-6：防御解析 —— 任意值 → 合法根因（旧记录无字段/垃圾值 ⇒ unknown）。
 * 失败记忆恢复（checkpoint 反序列化）与一切外部输入经此收口。
 */
export function parseRootCause(v: unknown): RootCauseId {
  return typeof v === 'string' && (ROOT_CAUSE_IDS as readonly string[]).includes(v)
    ? (v as RootCauseId)
    : 'unknown';
}

// ── W1-6：观察与证据结构 ──

/** 一帧探针观察（dhash 可缺席 —— 帧在而指纹缺席时诚实为 null） */
export interface ProbeFrame {
  dhash: string | null;
  buffer: Buffer | null;
}

/** ① visualDiff 通道的观察面（与 visualDiff.DiffResult 的结构子集兼容） */
export type DiffObservation = Pick<DiffResult, 'changed_fraction_pct' | 'identical'>;

/**
 * 鉴别链的一步：症状（观察到什么）→ 鉴别（这步排除了/倾向什么）→ 细化假设。
 * observation 是机器可读的原始观察值 —— 证据链的可回放锚点。
 */
export interface RootCauseEvidenceStep {
  probe: 'visual-diff' | 'hover-cursor' | 'frame-freeze' | 'fallback';
  symptom: string;
  differential: string;
  observation: string;
}

/** 根因候选：病因 + 排序置信 + 细化假设（处方方向）+ 支持它的证据链 */
export interface RootCauseCandidate {
  rootCause: RootCauseId;
  /** [0, 0.95] 的排序置信（0.95 封顶 —— 单探针证据永不冒充确定性） */
  score: number;
  /** 细化假设：下一步最优先的处方方向（≤200 字符） */
  hypothesis: string;
  /** 支持本候选的证据步（「症状→鉴别→细化假设」链的子链） */
  chain: RootCauseEvidenceStep[];
}

/** 鉴别报告：排序候选列表 + 全程鉴别轨迹（含被排除的分支 —— 可审计） */
export interface RootCauseReport {
  tool: string;
  /** 首位候选（无任何证据 ⇒ unknown 兜底） */
  rootCause: RootCauseId;
  /** 按诊断价值降序的候选列表（空 ⇔ 恒有 unknown 单元素兜底） */
  candidates: RootCauseCandidate[];
  /** 按执行序的全部鉴别步（含非决定性/排除步 —— 审计回放面） */
  trail: RootCauseEvidenceStep[];
  /** 任一探针缺席/超时/抛错 ⇒ true（降级是事实，如实申报） */
  degraded: boolean;
  degradedNotes: string[];
}

/** 鉴别试验的观察值集合（纯函数 differentialDiagnose 的输入 —— 全部可缺席） */
export interface RootCauseObservations {
  tool: string;
  /** 动作目标点（归一化坐标；悬停探针的落点 —— 缺席则跳过 ②） */
  point?: { x: number; y: number } | null;
  beforeFrame?: ProbeFrame | null;
  afterFrame?: ProbeFrame | null;
  /** ① 像素差分观察（visualDiff 通道；缺席 ⇒ 该步不参与） */
  diff?: DiffObservation | null;
  /** ① 的降级引擎：前后帧 dhash 相似度（像素通道缺席时的粗判） */
  dhashSimilarity?: number | null;
  /** ② 悬停光标形态（'ibeam'/'hand'/…；'n/a' 归一为 null） */
  hoverCursorKind?: string | null;
  /** ② 探针判决（interactivityProbe 的 verdict —— 结构层证据消费） */
  hoverVerdict?: InteractivityVerdict | null;
  /** ③ 后续帧指纹（含 null = 该次采帧失败；与 after 共同构成冻结序列） */
  followupDhashes?: readonly (string | null)[];
  /** 探针缺席/超时记录（降级透明） */
  degradedNotes?: readonly string[];
}

// ── W1-6：判据常量（不引入新旋钮 —— 值即边界，与模块头同立场）──

/** ① 「屏变了」的像素门槛（%）：≥0.5% 是结构性变化，<0.5% 多为闪烁/残影 */
const RC_CHANGED_STRONG_PCT = 0.5;
/** ① 强证据置信：动作生效 × 报失败 ⇒ 校验过严（像素级全屏证据） */
const RC_SCORE_OVERSTRICT_STRONG = 0.9;
/** ① 弱证据置信：微弱重绘（光标闪烁级）—— 只给倾向，不定案 */
const RC_SCORE_OVERSTRICT_WEAK = 0.55;
/** ② I-beam（OS 亲判正文）⇒ 盲点文本的置信（与 fuseVerdict ibeam 0.92 同律） */
const RC_SCORE_BLINDSPOT_IBEAM = 0.92;
/** ② UIA 结构层判 text ⇒ 盲点文本（0.93 判决降一档 —— 非 I-beam 直证） */
const RC_SCORE_BLINDSPOT_UIA_TEXT = 0.88;
/** ② hand（可点热区在场却无效）⇒ 盲点文本的弱置信（语义错配，非正文直证） */
const RC_SCORE_BLINDSPOT_HAND = 0.65;
/** ③ 连续帧冻结 ⇒ stall 的置信（行为证据：世界停摆的观察直证） */
const RC_SCORE_STALL = 0.85;
/** ③ 的 dhash 回退相似阈：≥0.9 视为「屏没变」（与场景匹配惯例 0.9 同律） */
const RC_DHASH_UNCHANGED_SIM = 0.9;

/** 各根因的细化假设（处方方向 —— 候选表的消费面） */
const RC_HYPOTHESIS: Record<RootCauseId, string> = {
  'over-strict-verification':
    'The action DID change the world while verification reported failure. Re-observe (take_screenshot/diff_view) and re-verify before retrying; do NOT blindly re-execute the same action.',
  'blind-spot-text':
    'The clicked point is not a working entry (text or mismatched hotzone). Switch modality: keyboard via press_hotkey (tab/enter), or re-locate the real control with find_text + zoom_inspect.',
  'stall':
    'Consecutive frames are frozen — the world is not repainting. Wait/settle longer before the next action; avoid rapid retries that amplify tail latency.',
  'unknown':
    'No root cause isolated by the available probes. Gather more evidence (take_screenshot, probe_interactivity, zoom_inspect) before retrying; treat this failure as unexplained.',
};

/**
 * W1-6 鉴别主入口（纯函数、确定性）：观察值集合 → 排序根因候选列表 + 证据链。
 *
 * 与 diagnose 同律的诚实边界：没有任何决定性证据 ⇒ 唯一候选是 unknown（诚实
 * 的兜底，不是「轻度倾向」）；被排除的分支记入 trail（鉴别过程可回放）。
 * 三类根因与三类探针一一对应（①→over-strict，②→blind-spot，③→stall）。
 */
export function differentialDiagnose(obs: RootCauseObservations): RootCauseReport {
  const trail: RootCauseEvidenceStep[] = [];
  const degradedNotes = [...(obs.degradedNotes ?? [])];
  const supports: Partial<Record<RootCauseId, { score: number; chain: RootCauseEvidenceStep[] }>> = {};

  const addSupport = (id: RootCauseId, score: number, step: RootCauseEvidenceStep): void => {
    const prev = supports[id];
    if (!prev || score > prev.score) {
      supports[id] = { score: Math.min(0.95, score), chain: [...(prev?.chain ?? []), step] };
    } else {
      prev.chain.push(step); // 同病因的次级证据入链（排序取主证分）
    }
  };

  // ── ① 前后帧 visualDiff：屏变没变（over-strict 的判别通道）──
  const diff = obs.diff ?? null;
  if (diff) {
    const pct = Number.isFinite(diff.changed_fraction_pct) ? diff.changed_fraction_pct : 0;
    if (!diff.identical && pct >= RC_CHANGED_STRONG_PCT) {
      const step: RootCauseEvidenceStep = {
        probe: 'visual-diff',
        symptom: 'screen changed after the failed action',
        differential: 'the action had a real world-effect — the failure verdict is stricter than reality',
        observation: `changed_fraction_pct=${pct}`,
      };
      trail.push(step);
      addSupport('over-strict-verification', RC_SCORE_OVERSTRICT_STRONG, step);
    } else if (!diff.identical) {
      const step: RootCauseEvidenceStep = {
        probe: 'visual-diff',
        symptom: 'screen barely changed after the failed action',
        differential: 'tiny repaint is cursor-blink-grade — weak support for over-strict verification, not decisive',
        observation: `changed_fraction_pct=${pct}`,
      };
      trail.push(step);
      addSupport('over-strict-verification', RC_SCORE_OVERSTRICT_WEAK, step);
    } else {
      trail.push({
        probe: 'visual-diff',
        symptom: 'screen unchanged after the failed action',
        differential: 'no world-effect — over-strict verification excluded',
        observation: 'identical=true',
      });
    }
  } else if (typeof obs.dhashSimilarity === 'number' && Number.isFinite(obs.dhashSimilarity)) {
    // 像素通道缺席时的 dhash 粗判（降级引擎，置信降档 —— 如实标注观察源）
    const s = Math.round(obs.dhashSimilarity * 1000) / 1000;
    if (s < RC_DHASH_UNCHANGED_SIM) {
      const step: RootCauseEvidenceStep = {
        probe: 'visual-diff',
        symptom: 'frame fingerprints differ after the failed action',
        differential: 'coarse dhash channel suggests a world-effect — weak support for over-strict verification',
        observation: `dhash_similarity=${s}`,
      };
      trail.push(step);
      addSupport('over-strict-verification', RC_SCORE_OVERSTRICT_WEAK, step);
    } else {
      trail.push({
        probe: 'visual-diff',
        symptom: 'frame fingerprints match after the failed action',
        differential: 'no world-effect at fingerprint resolution — over-strict verification excluded',
        observation: `dhash_similarity=${s}`,
      });
    }
  }

  // ── ② 悬停光标探针：该点是什么（blind-spot 的判别通道）──
  const cursor = obs.hoverCursorKind ?? null;
  const verdict = obs.hoverVerdict ?? null;
  if (cursor || verdict) {
    if (cursor === 'ibeam') {
      const step: RootCauseEvidenceStep = {
        probe: 'hover-cursor',
        symptom: 'cursor over the failed target is an I-beam',
        differential: 'the OS treats this point as selectable text, not a clickable entry — clicking cannot work here',
        observation: `cursor=ibeam${verdict ? ` verdict=${verdict}` : ''}`,
      };
      trail.push(step);
      addSupport('blind-spot-text', RC_SCORE_BLINDSPOT_IBEAM, step);
    } else if (cursor === 'hand') {
      const step: RootCauseEvidenceStep = {
        probe: 'hover-cursor',
        symptom: 'cursor over the failed target is a hand (clickable hotzone) yet nothing changed',
        differential: 'a hotzone exists but the click produced no effect — interaction semantics mismatch (needs keyboard or a different gesture/target)',
        observation: `cursor=hand${verdict ? ` verdict=${verdict}` : ''}`,
      };
      trail.push(step);
      addSupport('blind-spot-text', RC_SCORE_BLINDSPOT_HAND, step);
    } else if (verdict === 'text') {
      const step: RootCauseEvidenceStep = {
        probe: 'hover-cursor',
        symptom: 'structure layer registers the failed target as static text',
        differential: 'UIA point-query classifies this point as content, not a control — the click target is a blind spot',
        observation: `verdict=text${cursor ? ` cursor=${cursor}` : ''}`,
      };
      trail.push(step);
      addSupport('blind-spot-text', RC_SCORE_BLINDSPOT_UIA_TEXT, step);
    } else {
      trail.push({
        probe: 'hover-cursor',
        symptom: `cursor channel abstains over the failed target (${cursor ?? 'n/a'})`,
        differential: 'non-decisive cursor shape — blind-spot hypothesis stays open, freeze probe decides next',
        observation: `cursor=${cursor ?? 'n/a'} verdict=${verdict ?? 'n/a'}`,
      });
    }
  }

  // ── ③ 连续帧冻结：世界还在重绘吗（stall 的判别通道）──
  const afterDhash = obs.afterFrame?.dhash ?? null;
  const followups = obs.followupDhashes ?? [];
  if (afterDhash !== null && followups.length > 0) {
    const usable = followups.filter((d): d is string => typeof d === 'string' && d.length > 0);
    if (usable.length === 0) {
      degradedNotes.push('freeze probe ran but every followup frame lacked a fingerprint'); // W1-6：采帧在场、指纹缺席 = 降级
    } else if (usable.every(d => d === afterDhash)) {
      const step: RootCauseEvidenceStep = {
        probe: 'frame-freeze',
        symptom: `all consecutive frame fingerprints are identical (${usable.length + 1} frames)`,
        differential: 'the world is not repainting at all — environment stall, not a targeting error',
        observation: `frozen_frames=${usable.length + 1}`,
      };
      trail.push(step);
      addSupport('stall', RC_SCORE_STALL, step);
    } else {
      trail.push({
        probe: 'frame-freeze',
        symptom: 'a followup frame differs from the post-failure frame',
        differential: 'the world is still repainting — stall excluded',
        observation: `followups=${followups.length} frozen=false`,
      });
    }
  }

  // ── ④ 兜底与结算 ──
  const ORDER: RootCauseId[] = ['over-strict-verification', 'blind-spot-text', 'stall'];
  const candidates = ORDER
    .filter(id => supports[id])
    .map(id => ({
      rootCause: id,
      score: Math.round(supports[id]!.score * 1000) / 1000,
      hypothesis: RC_HYPOTHESIS[id],
      chain: supports[id]!.chain,
    }))
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    const step: RootCauseEvidenceStep = {
      probe: 'fallback',
      symptom: 'no discriminating probe evidence in this failure',
      differential: 'differential exhausted without a decisive witness — honest unknown, not a fabricated cause',
      observation: `probes_consulted=${trail.length}${degradedNotes.length > 0 ? ` degraded=${degradedNotes.length}` : ''}`,
    };
    trail.push(step);
    candidates.push({ rootCause: 'unknown', score: 0, hypothesis: RC_HYPOTHESIS.unknown, chain: [step] });
  }

  return {
    tool: obs.tool ?? '',
    rootCause: candidates[0].rootCause,
    candidates,
    trail,
    degraded: degradedNotes.length > 0,
    degradedNotes,
  };
}

// ── W1-6：注入端口与探针序列编排（生产接线在 guards 层，离线测试注入假件）──

/**
 * 鉴别探针注入端口：全部可选 —— 缺席即该步降级（不参与鉴别，绝不抛）。
 * 生产实现（guards/rootCauseGuard.ts）分别接线 visualDiff / interactivityProbe /
 * physicalBackend / contextManager；测试注入假帧/假光标/假 diff。
 */
export interface RootCauseProbePorts {
  /** 动作前参考帧（生产：contextManager 最近截图；测试：假帧） */
  getBeforeFrame?(): Promise<ProbeFrame | null>;
  /** 失败后立即采帧（生产：低分辨率截屏；测试：假帧） */
  captureFrame?(): Promise<ProbeFrame | null>;
  /** ① 像素差分引擎（生产：visualDiff.computeDiffRegions；测试：假 diff） */
  diffFrames?(before: ProbeFrame, after: ProbeFrame): Promise<DiffObservation | null>;
  /** ② 悬停光标探针（生产：interactivityProbe.probePoints；测试：假光标） */
  probePoint?(point: { x: number; y: number }): Promise<{
    cursorKind: string | null;
    verdict: InteractivityVerdict | null;
  } | null>;
  /** ③ 连续帧冻结的后续采帧数（缺省 2，夹取 [1,3]） */
  freezeSamples?: number;
  /** ③ 后续帧间隔 ms（缺省 300 —— 避开光标闪烁周期；测试注入 0/1） */
  freezeSampleGapMs?: number;
  /** 单端口墙钟上限 ms（缺省 1500；超时 ⇒ 该步降级，绝不悬挂主流程） */
  portTimeoutMs?: number;
}

const RC_DEFAULT_PORT_TIMEOUT_MS = 1500;
const RC_DEFAULT_FREEZE_SAMPLES = 2;
const RC_DEFAULT_FREEZE_GAP_MS = 300;
const RC_MAX_FREEZE_SAMPLES = 3;
/** 整个鉴别序列的墙钟预算 ms：超支 ⇒ 跳过余下探针（旁路纪律） */
const RC_BUDGET_MS = 3000;
const rcSleep = (ms: number) => new Promise<void>(r => setTimeout(r, Math.max(0, ms)));

/**
 * W1-6 鉴别探针序列编排（医学鉴别诊断式瀑布，防御式、绝不抛）：
 *
 *   ① 取前后帧 → 像素 diff（屏显著变了 ⇒ over-strict 成立，首中即断）
 *   ② 屏没变/像素通道缺席 → 悬停探针读目标点光标（ibeam/hand/text ⇒ blind-spot，首中即断）
 *   ③ 仍无决定性证据 → 连续帧冻结探针（dhash 全同 ⇒ stall）
 *   ④ 兜底 unknown
 *
 * 每个端口调用独立 try/catch + 墙钟超时 + 总预算；缺席/超时/抛错一律记
 * degradedNotes 并继续 —— 归因失败的成本上限是「一次无结论」，不是异常。
 * ports 本身缺席（未注入且生产端口不可用）⇒ 直接降级 unknown 报告。
 */
export async function runDifferentialProbes(
  ports: RootCauseProbePorts | null | undefined,
  context: { tool: string; point?: { x: number; y: number } | null },
): Promise<RootCauseReport> {
  // W1-6：绝对不抛保证 —— 序列本体的一切意外（含注入件的恶意属性读取）在此
  // 收口为「一次无结论 + 降级记注」，调用方（守卫）永远拿到合法报告。
  try {
    return await runDifferentialProbesSequence(ports, context);
  } catch {
    return differentialDiagnose({
      tool: context?.tool ?? '',
      degradedNotes: ['orchestrator defensive fallback (unexpected throw)'],
    });
  }
}

async function runDifferentialProbesSequence(
  ports: RootCauseProbePorts | null | undefined,
  context: { tool: string; point?: { x: number; y: number } | null },
): Promise<RootCauseReport> {
  const tool = context?.tool ?? '';
  const notes: string[] = [];
  const t0 = Date.now();
  const portTimeout = Math.max(100, ports?.portTimeoutMs ?? RC_DEFAULT_PORT_TIMEOUT_MS);
  const budgetLeft = () => Date.now() - t0 < RC_BUDGET_MS;

  /** 单端口防御执行：缺席 ⇒ null；抛错 ⇒ null + 记注；超时 ⇒ null（race 兜底）。
   *  超时定时器在 race 结算后清掉 —— 快端口的定时器不悬挂进程事件循环。 */
  async function safe<T>(label: string, fn: (() => Promise<T | null>) | undefined): Promise<T | null> {
    if (typeof fn !== 'function') return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const out = await Promise.race([
        fn(),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), portTimeout); }),
      ]);
      if (out === null || out === undefined) notes.push(`${label}: returned no observation`);
      return out ?? null;
    } catch {
      notes.push(`${label}: threw`);
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  if (!ports || typeof ports !== 'object') {
    return differentialDiagnose({ tool, degradedNotes: ['no probe ports injected (attribution skipped)'] });
  }

  // ── ① 前后帧 + 像素差分 ──
  let before: ProbeFrame | null = null;
  let after: ProbeFrame | null = null;
  let diff: DiffObservation | null = null;
  const hasFramePort = typeof ports.getBeforeFrame === 'function' || typeof ports.captureFrame === 'function';
  if (hasFramePort && budgetLeft()) {
    const pair = await Promise.all([
      safe('getBeforeFrame', typeof ports.getBeforeFrame === 'function' ? () => ports.getBeforeFrame!() : undefined),
      safe('captureFrame', typeof ports.captureFrame === 'function' ? () => ports.captureFrame!() : undefined),
    ]);
    before = pair[0];
    after = pair[1];
    if (before && after) {
      if (before.buffer && after.buffer && typeof ports.diffFrames === 'function') {
        diff = await safe('diffFrames', () => ports.diffFrames!(before!, after!));
      } else if (before.dhash && after.dhash) {
        // 像素通道缺席（参考帧降级为指纹 / 差分引擎未注入）⇒ dhash 粗判兜底
        notes.push(
          !before.buffer || !after.buffer
            ? 'diffFrames: frames lack pixel data (dhash fallback)'
            : 'diffFrames: not injected (dhash fallback)',
        );
      }
    }
  }

  const obs: RootCauseObservations = {
    tool,
    point: context?.point ?? null,
    beforeFrame: before,
    afterFrame: after,
    diff,
    dhashSimilarity:
      diff == null && before?.dhash && after?.dhash
        ? Math.round(similarity(before.dhash, after.dhash) * 1000) / 1000
        : null,
  };

  // 屏是否「显著变了」：① 的首中即断闸（屏显著变了 ⇒ ②③ 无从谈起）
  const screenChangedDecisively = !!diff && !diff.identical && diff.changed_fraction_pct >= RC_CHANGED_STRONG_PCT;
  // W1-6：屏是否「有任何重绘证据」（像素微变 / dhash 指纹分歧）—— ③ 冻结探针的
  // 前提闸：世界刚重绘过，「冻结」叙事自相矛盾（弱 ① 证据在场即跳过 ③，
  // ② 悬停不受此闸 —— 微变化可能是失败点击的悬停副作用，仍需鉴别盲点）。
  const screenRepainted =
    (!!diff && !diff.identical) ||
    (diff == null && obs.dhashSimilarity != null && obs.dhashSimilarity < RC_DHASH_UNCHANGED_SIM);

  // ── ② 悬停光标探针（屏没变 / 像素通道缺席时执行）──
  const point = context?.point ?? null;
  if (!screenChangedDecisively && point && budgetLeft() && typeof ports.probePoint === 'function') {
    const probe = await safe('probePoint', () => ports.probePoint!(point));
    if (probe) {
      obs.hoverCursorKind = probe.cursorKind && probe.cursorKind !== 'n/a' ? probe.cursorKind : null;
      obs.hoverVerdict = probe.verdict ?? null;
    }
  }

  // ② 是否给出了决定性盲点证据（ibeam/hand/text —— 与纯函数判据同律）
  const blindSpotDecisive =
    obs.hoverCursorKind === 'ibeam' || obs.hoverCursorKind === 'hand' || obs.hoverVerdict === 'text';

  // ── ③ 连续帧冻结探针（② 缺席/弃权时执行）──
  const freezeSamples = Math.min(
    RC_MAX_FREEZE_SAMPLES,
    Math.max(1, Math.round(ports.freezeSamples ?? RC_DEFAULT_FREEZE_SAMPLES)),
  );
  if (!screenChangedDecisively && !blindSpotDecisive && !screenRepainted && budgetLeft() && typeof ports.captureFrame === 'function') {
    const gap = Math.max(0, ports.freezeSampleGapMs ?? RC_DEFAULT_FREEZE_GAP_MS);
    const followups: Array<string | null> = [];
    for (let i = 0; i < freezeSamples; i++) {
      if (!budgetLeft()) { notes.push('budget exhausted during freeze probe'); break; }
      if (gap > 0) await rcSleep(gap);
      const f = await safe('captureFrame', () => ports.captureFrame!());
      followups.push(f?.dhash ?? null);
    }
    if (followups.length > 0) obs.followupDhashes = followups;
  }

  if (!budgetLeft()) notes.push('budget exhausted');

  obs.degradedNotes = notes;
  return differentialDiagnose(obs);
}

// ─── W2-5（R5 恢复策略疗效归因）：恢复动作词汇表 —— 处方出口的动作命名空间 ───
//
// R1 鉴别链（上文）回答「这一次为什么败」并给出 hypothesis 处方方向；本节把
// 处方方向升格为**机器可记名的动作词汇**——recoveryEfficacy 的疗效账按
// (症候签名 × 根因 × 恢复动作) 三元组记账，本节供应其中的动作轴与两条
// 先验梯子。纯数据 + 纯函数：diagnosis 的一切既有出口零行为变更；消费方
// （circuitBreakerGuard 的恢复提示、prescription 组装器）在疗效表样本量
// 充足后经 recoveryEfficacy.prescriptionOrder 消费同一名词空间。

/** W2-5：恢复动作标识 —— 疗效表的行为轴（可记名、可排序、可持久化） */
export type RecoveryActionId =
  | 'zoom-refine'     // 放大精定位（zoom_inspect 环绕复核坐标）
  | 'switch-modality' // 换模态（press_hotkey 键盘 / scroll_page / recall_ui）
  | 're-observe'      // 重新观察（take_screenshot / diff_view 刷新世界模型）
  | 'ground-target'   // 锚定真控件（find_text / probe_interactivity 定位本体）
  | 'wait-settle'     // 等世界稳定（stall 类：拉长间隔、勿急速重试）
  | 'stop-ask-user';  // 终止升级（停止重试、求助用户）

/** W2-5：运行时枚举面（防御解析/序列化往返的合法值域 —— 与 ROOT_CAUSE_IDS 同律） */
export const RECOVERY_ACTION_IDS: readonly RecoveryActionId[] = [
  'zoom-refine', 'switch-modality', 're-observe',
  'ground-target', 'wait-settle', 'stop-ask-user',
];

/**
 * W2-5：防御解析 —— 任意值 → 合法动作（垃圾值 ⇒ null，不冒充知识）。
 * 疗效表持久化恢复与一切外部输入经此收口（与 parseRootCause 同律，但
 * 动作无「unknown 兜底」——错名即弃置，不入账）。
 */
export function parseRecoveryAction(v: unknown): RecoveryActionId | null {
  return typeof v === 'string' && (RECOVERY_ACTION_IDS as readonly string[]).includes(v)
    ? (v as RecoveryActionId)
    : null;
}

/**
 * W2-5：冷启动梯子（固定缺省序）——「1 败教放大、2 败教换模态」。
 * circuitBreakerGuard 历史递进提示的名词化：疗效表对该 (症候×根因) 语境
 * 样本量不足（n < 5）时的缺省排序，行为等价于既有递进提示（零回归承诺）。
 */
export const RECOVERY_COLD_LADDER: readonly RecoveryActionId[] = ['zoom-refine', 'switch-modality'];

/**
 * W2-5：各根因的处方先验序（RC_HYPOTHESIS 的名词化）—— 疗效表动态排序的
 * 确定性平手序（tie-break）。值即边界：over-strict 先重观察（世界其实变了）、
 * blind-spot 先换模态（此路本不通）、stall 先等稳定（世界没在重绘）。
 */
export const ROOT_CAUSE_LADDER: Record<RootCauseId, readonly RecoveryActionId[]> = {
  'over-strict-verification': ['re-observe', 'zoom-refine', 'switch-modality', 'ground-target', 'wait-settle', 'stop-ask-user'],
  'blind-spot-text': ['switch-modality', 'ground-target', 'zoom-refine', 're-observe', 'wait-settle', 'stop-ask-user'],
  'stall': ['wait-settle', 're-observe', 'switch-modality', 'zoom-refine', 'ground-target', 'stop-ask-user'],
  'unknown': ['zoom-refine', 'switch-modality', 're-observe', 'ground-target', 'wait-settle', 'stop-ask-user'],
};

/** W2-5：根因 → 处方先验序（防御：非法根因 ⇒ unknown 梯子 —— parseRootCause 律） */
export function recoveryLadderFor(rootCause: unknown): readonly RecoveryActionId[] {
  return ROOT_CAUSE_LADDER[parseRootCause(rootCause)];
}
