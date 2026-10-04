// src/vlm/providers/cascade.triage.ts
// W6-2（doctor smell.over-engineering 清偿）：自 cascade.ts 低风险分区提取
// （>500 行拆分信号）—— 分诊面（协议类型 + 三因子分诊常量与纯函数）整体搬迁。
// 行为零变化；cascade.ts 以再导出保持导入面不变（w2cascade 测试与消费方零改动）。
import type { Bbox } from '../codec';
import type { ProviderTier, VisionChatRequest, VisionChatResult } from './types';

// ─── 协议类型 ───

/** 动作风险档 —— 调用方语义自定（如：只读观察 low / 平移滚动 medium / 点击输入 high） */
export type CascadeRiskTier = 'low' | 'medium' | 'high';

/** 三因子分诊输入 —— 全部可选，缺席取保守缺省（中性置信 / 中危 / 新场景） */
export interface CascadeTriageFactors {
  /** grounding/任务置信度 [0,1]（越高越不危险）；缺席/脏值记中性 0.5 */
  confidence?: number;
  /** 动作风险档；缺席记 'medium' */
  risk?: CascadeRiskTier;
  /** 场景新旧度代理：dhash 指纹缓存命中（旧场景）= true；缺席/脏值按新场景（false）保守 */
  sceneFamiliar?: boolean;
}

/** 三因子权重（和恒为 1 —— normalizeWeights 兜底钳制）；模块常量 + 注入可调 */
export interface CascadeTriageWeights {
  confidence: number;
  risk: number;
  novelty: number;
}

/**
 * 确定性校验谓词 —— 便宜答案被采信的法定门槛。check 必须是纯确定性函数
 * （零网络零模型），任何内部异常 ⇒ false（不可验证 = 不可采信，失败安全
 * 方向恒为升级主力）。全部通过（AND 语义）才放行便宜答案。
 */
export interface CascadeValidator {
  /** 谓词名（升级原因 reason 里点名，可观测） */
  readonly name: string;
  /** 校验便宜答案的 JSON 解析值；通过 true；不可验证/异常 false —— 绝不抛 */
  check(value: unknown): boolean;
}

/** 级联运行元数据 —— 每次承接的可观测足迹 */
export interface CascadeRunMeta {
  /** 采信答案的档位：'cheap' = 便宜档过检直采；'primary' = 主力档（升级或直行） */
  tier: 'cheap' | 'primary';
  /** true = 便宜臂失败后升级主力重做 */
  escalated: boolean;
  /** 路径人话：'cheap-hit' | 'validation-failed:<谓词名>' | 'json-unparseable'
   *  | 'cheap-call-failed' | 'escalation-failed' */
  reason: string;
}

/** 级联承接的结构化结果 —— 形状与池 chatJson 同族，附 meta 归因 */
export interface CascadeJsonResult<T = unknown> {
  ok: boolean;
  /** ok:true 时的 JSON 解析值 */
  value?: T;
  /** ok:false 时必有 */
  error?: string;
  /** 模型回复原文（成功也是） */
  raw: string;
  /** 采信来源脑归因 */
  providerId: string;
  model: string;
  latencyMs: number;
  meta: CascadeRunMeta;
}

/** 池的最小结构契约 —— ProviderPool 天然满足；测试可注假池 */
export interface CascadePoolFace {
  /** 池内脑数（0 = 空池 ⇒ 级联恒弃权） */
  readonly size: number;
  /** tier 花名册快照（级联判断便宜档在场性） */
  tierRoster(): ReadonlyArray<{ id: string; tier: ProviderTier }>;
  /** 分档对话（切换律同构 chat，序列限制在档内） */
  chatTier(req: VisionChatRequest, tier: ProviderTier): Promise<VisionChatResult>;
}

// ─── 三因子分诊（模块常量 + 注入可调） ───

/** 缺省权重：置信 0.4 / 风险 0.4 / 新颖 0.2（三因子齐权偏保守，风险与置信并重） */
export const CASCADE_TRIAGE_WEIGHTS: Readonly<CascadeTriageWeights> = {
  confidence: 0.4,
  risk: 0.4,
  novelty: 0.2,
};

/** 风险档危险分：low=0 / medium=0.5 / high=1 */
export const CASCADE_RISK_SCORE: Readonly<Record<CascadeRiskTier, number>> = {
  low: 0,
  medium: 0.5,
  high: 1,
};

/** 便宜臂准入阈值：danger ≤ 此值才走便宜档（边界含等号 —— 阈值注入可调） */
export const CASCADE_DANGER_MAX = 0.35;

/** 夹 [0,1]；非有限数归 fallback（不抛铁律） */
export function clamp01(v: unknown, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** 权重消毒：三值取非负有限、和 ≤ 0 时回退缺省权重（除零防线） */
export function normalizeWeights(w?: CascadeTriageWeights): CascadeTriageWeights {
  if (!w || typeof w !== 'object') return { ...CASCADE_TRIAGE_WEIGHTS };
  const c = clamp01(w.confidence, 0);
  const r = clamp01(w.risk, 0);
  const n = clamp01(w.novelty, 0);
  if (c + r + n <= 0) return { ...CASCADE_TRIAGE_WEIGHTS };
  return { confidence: c, risk: r, novelty: n };
}

/**
 * 三因子危险度打分（纯函数，绝不抛）：
 *   danger = wc·(1−confidence) + wr·riskScore + wn·novelty，夹 [0,1]。
 * 低分 = 置信高 + 低危 + 旧场景（便宜可试）；高分 = 不确定/高危/新场景（主力直行）。
 */
export function triageDanger(
  factors?: CascadeTriageFactors | null,
  weights?: CascadeTriageWeights,
): number {
  const f = factors && typeof factors === 'object' ? factors : {};
  const w = normalizeWeights(weights);
  const conf = clamp01(f.confidence, 0.5); // 缺席中性：不褒不贬
  const riskScore =
    f.risk === 'low' || f.risk === 'medium' || f.risk === 'high'
      ? CASCADE_RISK_SCORE[f.risk]
      : CASCADE_RISK_SCORE.medium; // 脏风险档按中危保守
  const novelty = f.sceneFamiliar === true ? 0 : 1; // 缺席按新场景保守
  return clamp01(w.confidence * (1 - conf) + w.risk * riskScore + w.novelty * novelty, 0);
}

/** 便宜臂准入判定：danger ≤ dangerMax（边界含等号）；阈值缺省 CASCADE_DANGER_MAX */
export function triageCheapEligible(
  factors?: CascadeTriageFactors | null,
  opts?: { dangerMax?: number; weights?: CascadeTriageWeights },
): boolean {
  const max = Number(opts?.dangerMax);
  const ceiling = Number.isFinite(max) ? (max as number) : CASCADE_DANGER_MAX;
  return triageDanger(factors, opts?.weights) <= ceiling;
}
