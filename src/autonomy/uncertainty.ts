// src/autonomy/uncertainty.ts
// 纪元 Φ（Φ-7 认识论中枢）：量化每一步判断的不确定性——何时放行、何时问云脑、何时问人、何时收手，全凭熵与置信的数值说话。

/**
 * Φ-7 认识论中枢（纯函数模块：零网络、零 IO——唯一的模块依赖是内核注册表的
 * 同步只读 getOrDefault（纪元 Θ-4 生产接线），未注册时回声字面量缺省，
 * 数学行为与接线前逐字节一致）。
 *
 * 职责：把"这一步我有多确定"压缩成三个可审计的数（熵 / 有效置信 / 行动建议），
 * 让自主环在每次动手前先过一道认识论闸门：
 *
 * ── 数学定义 ──
 *
 * 【二元香农熵】H(p) = -p·log₂(p) - (1-p)·log₂(1-p)，单位比特，值域 [0,1]。
 *   p=0.5 时最"懵"（H=1，正反各半）；p∈{0,1} 时全知（H=0）。
 *
 * 【加权几何平均】combineConfidences(list, weights) = exp( Σwᵢ·ln(cᵢ) / Σwᵢ )。
 *   即 (∏ cᵢ^wᵢ)^(1/Σwᵢ)。用几何而非算术平均，是因为连乘会**惩罚任何一项
 *   低置信**：一个 0.1 的怀疑足以把整体拉下来，而算术平均会被高置信项淹没。
 *   cᵢ 夹取到 (0.001, 1] 防 ln(0)＝-∞ 毁掉整组。
 *
 * 【Beta 式校准】calibratedProbability(raw, {α, β}) = (raw·α + (1-raw)·β) / (α+β)。
 *   α 代表"模型自报可信时确实可信"的先验强度，β 反之（自报不可信时其实可信
 *   的底噪强度）。这是 raw 与先验重量的线性混合：raw=1 映射到 α/(α+β)，
 *   raw=0 映射到 β/(α+β)——自报置信普遍过乐观，校准后向中间收缩。
 *   α 或 β 任一 ≤ 0（含非数）⇒ 校准无效，**原样返回 raw**（不抛异常）。
 *
 * 【adviseAction 决策表】有效置信 = calibratedProbability(confidence,
 *   {α:4, β:1})（对称收缩：eff = 0.5 + 0.6×(raw−0.5)，值域 [0.2, 0.8]——自报
 *   满格 1.0 也只值 0.8、自报归零仍留 0.2 底噪），随后按"错误代价 × 有效置信 ×
 *   云脑在否 × 预算"四维裁决，详见 adviseAction 的 JSDoc。
 *
 * 铁律：具名导出、无 default；绝不抛异常——一切非法输入夹取/直通后照算。
 */
import { kernelRegistry } from '../kernel/registry';
/**
 * 认识论报告：一步判断的不确定性全景（纯数据，无方法）。
 */
export interface UncertaintyReport {
  /** 熵（比特）＝ shannonEntropy(有效置信)：越接近 1 越拿不准 */
  entropy: number;
  /** 有效置信（经 α=4/β=1 对称校准后的值，值域 [0.2,0.8]）——决策实际依据的数值，entropy 即由它算出 */
  confidence: number;
  /** 行动建议：放行 / 问云脑 / 问人 / 收手 */
  advise: 'proceed' | 'ask_vlm' | 'ask_human' | 'abort';
  /** 中文理由，每条一句（审计轨迹；至少一条） */
  reasons: string[];
}

/**
 * 二元香农熵（纯函数）：H(p) = -p·log₂(p) - (1-p)·log₂(1-p)。
 *
 * 数学：
 * - p ∈ (0,1) 时两项皆负、取负后为正；p=0.5 ⇒ H=1 比特（最大不确定性）。
 * - 边界 p∈{0,1} ⇒ 0（极限 lim x→0⁺ x·log₂x = 0，代码里显式短路，不做 0·(-∞)）。
 * - 对称：H(p) = H(1-p)。
 * - 非法输入夹取后再算：p<0 按 0 算、p>1 按 1 算（两者都得 0）；
 *   NaN 无法被夹取修正，直接返回 0（读数损坏按"无信息"处理，绝不抛异常）。
 */
export function shannonEntropy(p: number): number {
  if (Number.isNaN(p)) return 0;
  const q = p < 0 ? 0 : p > 1 ? 1 : p;
  if (q <= 0 || q >= 1) return 0;
  return -(q * Math.log2(q) + (1 - q) * Math.log2(1 - q));
}

/**
 * 加权几何平均（纯函数）：exp( Σwᵢ·ln(cᵢ) / Σwᵢ )，即 (∏ cᵢ^wᵢ)^(1/Σwᵢ)。
 *
 * 数学与规则：
 * - weights 省略 ⇒ 等权（每项权重 1），退化为普通几何平均 (∏cᵢ)^(1/n)。
 * - 几何平均 ≤ 算术平均（AM-GM 不等式），各项全等时取等——低置信项的
 *   连乘惩罚正是选它而不选算术平均的理由。
 * - cᵢ 夹取到 (0.001, 1]：cᵢ ≤ 0.001 或非数 ⇒ 0.001，cᵢ > 1 ⇒ 1（防 ln(0)）。
 * - 权重按位对齐：weights 比 list 短时，缺位的项权重按 0（剔除不计）；
 *   多出的权重自然忽略。权重非数或 ≤ 0 ⇒ 按 0 计。
 * - 空列表、或全部有效权重之和为 0 ⇒ 返回 0（无证据即无置信）。
 * - 绝不抛异常：list 非数组按空列表处理。
 */
export function combineConfidences(list: number[], weights?: number[]): number {
  if (!Array.isArray(list) || list.length === 0) return 0;
  const n = list.length;
  let wSum = 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const raw = list[i];
    // 夹取到 (0.001, 1]：非数/过小 ⇒ 下限 0.001；超过 1 ⇒ 1
    const c = !(raw > 0.001) ? 0.001 : raw > 1 ? 1 : raw;
    const wRaw = weights === undefined ? 1 : i < weights.length ? weights[i] : 0;
    const w = typeof wRaw === 'number' && wRaw > 0 && Number.isFinite(wRaw) ? wRaw : 0;
    wSum += w;
    acc += w * Math.log(c);
  }
  if (wSum <= 0) return 0;
  return Math.exp(acc / wSum);
}

/**
 * Beta 式置信校准（纯函数）：
 *
 *   校准后 = (raw·α + (1-raw)·β) / (α+β)
 *
 * 数学：
 * - α 是"自报可信 ⇒ 确实可信"的先验强度，β 是"自报不可信 ⇒ 其实可信"的
 *   底噪强度；结果恒落在 (β/(α+β), α/(α+β)) 区间内（α,β>0 时），即把
 *   raw 线性收缩向先验中心 β/(α+β)——自报置信普遍过乐观，故收缩即降温。
 * - raw=1 ⇒ α/(α+β)；raw=0 ⇒ β/(α+β)；α=β ⇒ 恒 0.5（对称先验抹平自报）。
 * - α 或 β 任一 ≤ 0（含非数、含 calibration 本身缺失）⇒ 校准无效，
 *   **原样返回 raw**（直通，不夹取、不抛异常）。
 * - 校准有效时 raw 先夹取到 [0,1]（非数按 0 计），再入公式。
 */
export function calibratedProbability(rawConfidence: number, calibration: { alpha: number; beta: number }): number {
  const alpha = calibration === null || calibration === undefined ? Number.NaN : calibration.alpha;
  const beta = calibration === null || calibration === undefined ? Number.NaN : calibration.beta;
  if (!(alpha > 0) || !(beta > 0)) return rawConfidence;
  const raw = Number.isNaN(rawConfidence) ? 0 : rawConfidence < 0 ? 0 : rawConfidence > 1 ? 1 : rawConfidence;
  return (raw * alpha + (1 - raw) * beta) / (alpha + beta);
}

/** adviseAction 内建校准常数：α=4 / β=1 —— 对称收缩（eff = 0.5 + 0.6×(raw−0.5)，值域 [0.2,0.8]）。
 *  校准律纪元 Δ 修正：旧 α=1.3 把 eff 压进 [0.4348,0.5652]，high 档云脑阈 0.6 与
 *  medium/low 档 proceed 阈数学上不可达（决策表大半成摆设：high 恒问人、无云脑时
 *  low/medium 恒冒险放行）。α=4 让除 high.proceed（0.85 > 值域上限 0.8，刻意保留：
 *  高危代价不存在免检直通道）外的全部阈值分支皆可达，校准真正参与裁决。 */
const CALIBRATION: { alpha: number; beta: number } = { alpha: 4, beta: 1 };

/** 三档错误代价的双阈值组：proceed 阈（直接放行线）与 vlm 阈（云脑复核线） */
const THRESHOLDS: Record<'low' | 'medium' | 'high', { proceed: number; vlm: number }> = {
  high: { proceed: 0.85, vlm: 0.6 },
  medium: { proceed: 0.7, vlm: 0.45 },
  low: { proceed: 0.5, vlm: 0.3 },
};

/** 预算红线（百分比）：低于此值云脑咨询失去意义 */
const BUDGET_FLOOR_PCT = 10;

/** 数值展示：非数原样转字符串，其余保留 3 位小数（供 reasons 中文句使用） */
function fmt3(x: number): string {
  return Number.isFinite(x) ? x.toFixed(3) : String(x);
}

/**
 * 认识论裁决（纯函数）：给定综合置信与代价档，产出放行/问云脑/问人/收口的建议。
 *
 * ── 决策表（JSDoc 完整版） ──
 *
 * 第一步·校准：有效置信 eff = calibratedProbability(confidence, {α:4, β:1}) =
 *   (4·raw + 1 − raw)/5 = 0.5 + 0.6×(raw−0.5)——关于 0.5 对称的线性收缩，
 *   值域恒为 [β/(α+β), α/(α+β)] = [0.2, 0.8]（raw=0.5 是不动点；自报满格
 *   1.0 只值 0.8，自报归零仍留 0.2 底噪——"无证据"与"确凿"之间永不分流死）。
 *
 * 第二步·阈值组（按错误代价三档）：
 *   high   { proceed ≥ 0.85, vlm ≥ 0.60 }
 *   medium { proceed ≥ 0.70, vlm ≥ 0.45 }
 *   low    { proceed ≥ 0.50, vlm ≥ 0.30 }
 *   可达性（eff ∈ [0.2,0.8]）：medium/low 的 proceed 与三档 vlm 阈全部可达
 *   （medium.proceed 需 raw ≥ 5/6；high.vlm 需 raw ≥ 2/3；low.vlm 需 raw ≥ 1/6）；
 *   唯 high.proceed（0.85 > 0.8）刻意不可达——高危错误代价下不存在免检直通道：
 *   即使自报置信满格，也至少要过一道云脑复核或人工裁决。
 *
 * 第三步·判序（依序短路，18 格语义 = 3 代价档 × {高,中,低} raw × 云脑在/缺席）：
 *   1. eff ≥ proceed 阈 ⇒ **proceed**（不确定性可承受，直接放行）。
 *   2. 否则 eff ≥ vlm 阈 ⇒
 *      a. 云脑在场 ⇒ **ask_vlm**（不足以放行但值得云脑复核）；
 *      b. 云脑缺席且代价 high ⇒ **ask_human**（不敢冒险放行，升级问人）；
 *      c. 云脑缺席且代价可控 ⇒ **proceed**，reasons 注明
 *         "云脑缺席且代价可控，冒险放行"。
 *   3. 否则（低置信）⇒
 *      a. 代价 high ⇒ **ask_human**（低置信 + 高代价 = 必须问人）；
 *      b. 云脑在场 ⇒ **ask_vlm**（低置信但代价可控，云脑兜底）；
 *      c. 云脑缺席 ⇒ **ask_human**（低置信且无云脑，只能问人）。
 *
 * 第四步·预算红线（budgetRemainingPct 缺省 100；非数按最坏 0 计）：
 *   - 原判 ask_vlm 且预算 < 10 ⇒ 降级 **abort**，reason"预算不足以承担云脑咨询"
 *     （预算耗尽时 ask_vlm 无意义，收手不烧钱）；预算恰为 10 不降级。
 *   - 原判 proceed 且预算 < 10 ⇒ **proceed 照旧**（不烧预算的动作，豁免降级）。
 *   - 原判 ask_human 且预算 < 10 ⇒ 维持 ask_human（问人不烧云脑预算）。
 *
 * 返回的 UncertaintyReport：confidence = 有效置信（决策依据），entropy =
 * shannonEntropy(有效置信)，reasons 每条一句中文且至少一条。
 *
 * 鲁棒性（绝不抛异常）：confidence 非数按 0 计；costOfError 非法值按 high
 * 保守处理（宁可多问，不可错放）；vlmAvailable 仅接受字面 true。
 */
export function adviseAction(opts: {
  /** 综合置信 0..1（各感知/判断环节置信的合成值） */
  confidence: number;
  /** 错误代价档：低 / 中 / 高 */
  costOfError: 'low' | 'medium' | 'high';
  /** 云脑（VLM）当下是否可咨询 */
  vlmAvailable: boolean;
  /** 云脑预算剩余百分比 0..100，缺省 100；非数按 0（最坏情况）计 */
  budgetRemainingPct?: number;
}): UncertaintyReport {
  const raw = typeof opts?.confidence === 'number' ? opts.confidence : 0;
  const cost: 'low' | 'medium' | 'high' =
    opts?.costOfError === 'low' || opts?.costOfError === 'medium' || opts?.costOfError === 'high'
      ? opts.costOfError
      : 'high';
  const vlmAvailable = opts?.vlmAvailable === true;
  const budgetRawPct = typeof opts?.budgetRemainingPct === 'number' ? opts.budgetRemainingPct : 100;
  const budget = Number.isFinite(budgetRawPct) ? budgetRawPct : 0;

  // 纪元 Θ（Θ-4 生产接线）：校准常数与三档双阈值读内核注册表 —— 键名全集：
  //   uncertainty.alpha / uncertainty.beta
  //   uncertainty.highProceed / uncertainty.highVlm
  //   uncertainty.mediumProceed / uncertainty.mediumVlm
  //   uncertainty.lowProceed / uncertainty.lowVlm
  // 未注册 ⇒ getOrDefault 回声 CALIBRATION / THRESHOLDS 字面量（α=4/β=1 与
  // 三档阈值决策表与接线前逐字节一致）。
  const alpha = kernelRegistry.getOrDefault('uncertainty.alpha', CALIBRATION.alpha);
  const beta = kernelRegistry.getOrDefault('uncertainty.beta', CALIBRATION.beta);
  const eff = calibratedProbability(raw, { alpha, beta });
  const t = {
    proceed: kernelRegistry.getOrDefault(`uncertainty.${cost}Proceed`, THRESHOLDS[cost].proceed),
    vlm: kernelRegistry.getOrDefault(`uncertainty.${cost}Vlm`, THRESHOLDS[cost].vlm),
  };
  const reasons: string[] = [
    `自报置信 ${fmt3(raw)} 经 α=${alpha}/β=${beta} 对称校准得有效置信 ${fmt3(eff)}`,
    `错误代价 ${cost}：proceed 阈 ${t.proceed}，云脑阈 ${t.vlm}`,
  ];

  let advise: UncertaintyReport['advise'];
  if (eff >= t.proceed) {
    advise = 'proceed';
    reasons.push('有效置信达到 proceed 阈，不确定性可承受，直接放行');
  } else if (eff >= t.vlm) {
    if (vlmAvailable) {
      advise = 'ask_vlm';
      reasons.push('置信不足以放行但已达云脑阈，交云脑复核');
    } else if (cost === 'high') {
      advise = 'ask_human';
      reasons.push('云脑缺席且错误代价高，不敢冒险放行，升级问人');
    } else {
      advise = 'proceed';
      reasons.push('云脑缺席且代价可控，冒险放行');
    }
  } else if (cost === 'high') {
    advise = 'ask_human';
    reasons.push('低置信且错误代价高，必须问人');
  } else if (vlmAvailable) {
    advise = 'ask_vlm';
    reasons.push('低置信但代价可控，云脑兜底复核');
  } else {
    advise = 'ask_human';
    reasons.push('低置信且云脑缺席，只能问人');
  }

  if (budget < BUDGET_FLOOR_PCT) {
    if (advise === 'ask_vlm') {
      advise = 'abort';
      reasons.push('预算不足以承担云脑咨询');
    } else if (advise === 'proceed') {
      reasons.push('预算见底，但 proceed 不烧预算，维持放行');
    }
    // ask_human 不烧云脑预算：维持原判
  }

  return { entropy: shannonEntropy(eff), confidence: eff, advise, reasons };
}
