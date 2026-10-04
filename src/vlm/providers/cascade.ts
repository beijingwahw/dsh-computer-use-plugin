// src/vlm/providers/cascade.ts
// W2-8（创新提案 C2 · 成本级联路由 tier cascade）：三因子分诊 + 便宜臂确定性
// 校验 + 升级主力重做。
//
// 与纯路由的本质区别（级联验证律）：便宜 tier 的输出**不是被偏好而是被采信
// 前必须过确定性校验**（坐标落目标 bbox 内 / JSON schema 合法 / OCR 文字一致
// —— 三谓词集见下）。校验通过 ⇒ 采信便宜答案（省钱事件）；校验不过 ⇒ 便宜
// 答案作废、升级主力档链重做（安全升级 —— 便宜答案只在过检时省钱，失败安全
// 降级方向永远是「多花一次主力调用」而非「错答上屏」）。
//
// 三因子分诊（危险度打分，低分走便宜档、高分走主力）：
//   danger = w_conf·(1−confidence) + w_risk·riskScore + w_novel·(场景新颖度)
//   - confidence：grounding/任务置信度（grounding.GroundedElement.confidence
//     等置信面直供），缺省中性 0.5；
//   - risk：动作风险档（只读=low / 平移滚动=medium / 点击输入=high，调用方
//     语义自定），缺省 'medium'；
//   - 场景新旧度：dhash 指纹缓存命中（sceneFamiliar=true，旧场景）记 0、
//     未命中/新场景记 1 —— 以指纹缓存命中率为代理，缺省按新场景保守。
//   缺省因子（全缺席）⇒ danger = 0.6 > 阈值 0.35 ⇒ 直行主力（失败安全：无
//   证据不便宜）。权重与阈值均为模块常量且可注入调整。
//
// 实现铁律（与 types.ts / failover.ts 同调）：
//   1. 永不抛异常 —— 一切内部故障收敛为「弃权 null」（调用方主路径照走），
//      恶意桩上抛 / 敌意 validator 都不带崩主流程；
//   2. 统计诚实 —— CascadeMeter 只记真实拨号的钱（便宜脑被熔断跳行未拨号
//      计 0）；负节省如实上报不钳零；
//   3. 零行为变化律 —— 池内无 cheap 档标注 / 无校验谓词 / 无分诊因子 ⇒
//      runJson 恒 null，任何调用方路径与不接级联时逐字节一致；
//   4. 纯离线可测 —— 全部依赖经注入端口（CascadePoolFace 结构满足 ProviderPool），
//      假 provider 零网络复算全程。
//
// 三用途正交律：级联是 ProviderPool 的第三用途（failover 池序切换 / ensemble
// 合议庭之外的第三面），tier 字段不改变 chat() 的全池切换语义 —— 本模块只
// 经 chatTier/tierRoster 消费档位，绝不触碰池序。

import { normalizedLevenshtein } from '../arbitration';
import type { Bbox } from '../codec';
import { CascadeMeter } from '../metering';
import type { CascadeStats } from '../metering';
import { extractProviderJson } from './types';
import type { ProviderTier, VisionChatRequest, VisionChatResult } from './types';

// W6-2（doctor smell.over-engineering 清偿）：分诊面（协议类型 + 三因子分诊）已分区
// 提取至 cascade.triage.ts（行为零变化）；导入面不变 —— 再分发。
import { CASCADE_TRIAGE_WEIGHTS, CASCADE_RISK_SCORE, CASCADE_DANGER_MAX, triageDanger, triageCheapEligible, clamp01, normalizeWeights } from './cascade.triage';
export { CASCADE_TRIAGE_WEIGHTS, CASCADE_RISK_SCORE, CASCADE_DANGER_MAX, triageDanger, triageCheapEligible } from './cascade.triage';
export type { CascadeRiskTier, CascadeTriageFactors, CascadeTriageWeights, CascadeValidator, CascadeRunMeta, CascadeJsonResult, CascadePoolFace } from './cascade.triage';
import type { CascadeRiskTier, CascadeTriageFactors, CascadeTriageWeights, CascadeValidator, CascadeRunMeta, CascadeJsonResult, CascadePoolFace } from './cascade.triage';



// ─── 确定性校验谓词集（三件内置 + 自定义扩展面） ───

/** bbox 最小结构（与 codec.Bbox 同形 —— type import 零运行时耦合） */
type BboxLike = { x0: number; y0: number; x1: number; y1: number };

/** 有限数判定 */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 对象/两点数组安全取点：{x,y} 有限数形态或 [x,y] 数组形态；取不出 ⇒ null */
function asPoint(cand: unknown): { x: number; y: number } | null {
  if (cand !== null && typeof cand === 'object' && !Array.isArray(cand)) {
    const o = cand as { x?: unknown; y?: unknown };
    if (isFiniteNumber(o.x) && isFiniteNumber(o.y)) return { x: o.x, y: o.y };
    return null;
  }
  if (Array.isArray(cand) && isFiniteNumber(cand[0]) && isFiniteNumber(cand[1])) {
    return { x: cand[0], y: cand[1] };
  }
  return null;
}

/** 默认取点：value.point → value.center → value 本体（{x,y} 或 [x,y] 形态） */
function defaultPickPoint(value: unknown): { x: number; y: number } | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as { point?: unknown; center?: unknown };
    for (const cand of [o.point, o.center]) {
      const p = asPoint(cand);
      if (p !== null) return p;
    }
  }
  return asPoint(value);
}

/**
 * 坐标在目标 bbox 内谓词（升级触发用例之一：坐标出界）。
 * 闭区间含边界（x0 ≤ x ≤ x1 且 y0 ≤ y ≤ y1）；取不到点（缺 x/y/非对象）⇒
 * false（不可验证 = 不可采信）。pickPoint 可注入自定义取点路（默认
 * value.point → value.center → value 本体）；敌意取点抛错 ⇒ false 绝不带出。
 */
export function withinBboxValidator(
  bbox: BboxLike | Bbox,
  pickPoint: (value: unknown) => { x: number; y: number } | null = defaultPickPoint,
): CascadeValidator {
  return {
    name: 'bbox-within',
    check(value: unknown): boolean {
      try {
        const b = bbox;
        if (
          !b ||
          !isFiniteNumber(b.x0) ||
          !isFiniteNumber(b.y0) ||
          !isFiniteNumber(b.x1) ||
          !isFiniteNumber(b.y1)
        ) {
          return false; // 目标框自身脏值 —— 不可验证
        }
        const p = pickPoint(value);
        if (p === null || !isFiniteNumber(p.x) || !isFiniteNumber(p.y)) return false;
        const x0 = Math.min(b.x0, b.x1);
        const x1 = Math.max(b.x0, b.x1);
        const y0 = Math.min(b.y0, b.y1);
        const y1 = Math.max(b.y0, b.y1);
        return p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
      } catch {
        return false; // 敌意 pickPoint —— 收敛为不过（失败安全升级）
      }
    },
  };
}

/** schema 字段类型词表：'array' 走 Array.isArray，其余按 typeof 严格比对 */
export type CascadeSchemaType = 'string' | 'number' | 'boolean' | 'object' | 'array';

/**
 * JSON schema 合法谓词（升级触发用例之二：schema 坏）。
 * value 必须是非数组对象，且 shape 内每个键在场且类型相符（number 额外要求
 * 有限）；额外键宽容放行（只验必备面，不罚模型多嘴）。shape 为空 ⇒ 恒 false
 * （空 schema = 不可验证 = 不可采信，失败安全律）。
 */
export function schemaValidator(shape: Readonly<Record<string, CascadeSchemaType>>): CascadeValidator {
  return {
    name: 'json-schema',
    check(value: unknown): boolean {
      try {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
        const keys = Object.keys(shape ?? {});
        if (keys.length === 0) return false;
        const o = value as Record<string, unknown>;
        for (const k of keys) {
          const want = shape[k];
          const got = o[k];
          if (want === 'array') {
            if (!Array.isArray(got)) return false;
          } else if (want === 'number') {
            if (!isFiniteNumber(got)) return false;
          } else if (want === 'object') {
            if (got === null || typeof got !== 'object' || Array.isArray(got)) return false;
          } else {
            if (typeof got !== want) return false;
          }
        }
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** 文本归一双轨：A = 小写+空白折叠（英文语序敏感）；B = 小写+全空白剥除
 *  （CJK 字间空格是 OCR 噪声 ——「确 定」与「确定」同身份） */
function normalizeTextA(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeTextB(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

/**
 * OCR 文字一致性谓词（升级触发用例之三：文字不一致）。
 * 从答案取文本（默认 value.text → value.label → value 本体字符串；key 可注入
 * 指定字段），与期望文字（本地 OCR 读数）双轨比对：任一轨归一后**包含**即过；
 * 否则 normalizedLevenshtein 相似度（A 轨文本对）≥ minSimilarity（缺省 0.8，
 * arbitration 单一定义点）才过。期望为空 / 取不到文本 ⇒ false（无文字身份
 * 不可交叉验证 —— 失败安全方向恒为升级主力）。
 */
export function ocrTextValidator(
  expected: string,
  opts?: { minSimilarity?: number; key?: string },
): CascadeValidator {
  return {
    name: 'ocr-text',
    check(value: unknown): boolean {
      try {
        const wantA = normalizeTextA(typeof expected === 'string' ? expected : '');
        if (wantA === '') return false; // 空期望不可验证
        let actual: string | null = null;
        if (typeof value === 'string') {
          actual = value;
        } else if (value !== null && typeof value === 'object') {
          const o = value as Record<string, unknown>;
          const cand = opts?.key !== undefined ? o[opts.key] : (o.text ?? o.label);
          if (typeof cand === 'string') actual = cand;
        }
        if (actual === null) return false; // 取不到文本
        const gotA = normalizeTextA(actual);
        if (gotA === '') return false;
        if (gotA.includes(wantA)) return true; // A 轨归一包含直通
        const wantB = normalizeTextB(expected as string);
        const gotB = normalizeTextB(actual);
        if (wantB !== '' && gotB.includes(wantB)) return true; // B 轨剥空白包含（CJK 字间噪声）
        const min = clamp01(opts?.minSimilarity, 0.8);
        return normalizedLevenshtein(wantA, gotA) >= min;
      } catch {
        return false;
      }
    },
  };
}

/** 首个不过检的谓词点名（全过 ⇒ null）；谓词自身抛错按不过计（不抛铁律） */
function findFailedValidator(
  validators: readonly CascadeValidator[],
  value: unknown,
): CascadeValidator | null {
  for (const v of validators) {
    let pass = false;
    try {
      pass = v.check(value) === true;
    } catch {
      pass = false;
    }
    if (!pass) return v;
  }
  return null;
}

// ─── 级联执行器 ───

/** 级联选项 —— 阈值/权重/谓词/因子源/价格/台账全注入可调 */
export interface CascadeOptions {
  /** 便宜臂准入阈值（缺省 CASCADE_DANGER_MAX = 0.35；边界含等号） */
  dangerMax?: number;
  /** 三因子权重（缺省 CASCADE_TRIAGE_WEIGHTS） */
  weights?: CascadeTriageWeights;
  /** 便宜臂法定校验谓词集（实例级；可被 perCall 追加）；空 ⇒ 便宜臂禁用 */
  validators?: CascadeValidator[];
  /**
   * 接线态因子源（宿主闭包读最新置信/风险/场景新旧度 —— 经 glmClient 咨询面
   * 桥接时 perCall 无法携带因子，由此供给）；perCall.factors 显式给出时优先；
   * 两者皆缺席 ⇒ 弃权（无证据不便宜）。抛错/回脏值 ⇒ 视为缺席。
   */
  factors?: () => CascadeTriageFactors | undefined | null;
  /** 相对价格（缺省 primary 1 / cheap 0.25）—— 只用于台账，不影响路由决策 */
  prices?: { primary?: number; cheap?: number };
  /** 台账注入（缺省内部自铸；宿主要有全局账本时注入共享实例） */
  meter?: CascadeMeter;
}

/** 每调用附加面：分诊因子可逐调用给出（优先于 CascadeOptions.factors 接线源）；谓词可追加 */
export interface CascadeRunOptions {
  factors?: CascadeTriageFactors;
  validators?: CascadeValidator[];
}

/** 空池兜底 —— 脏 pool 注入的静默替身（一切查询恒「无脑可用」） */
const NULL_POOL: CascadePoolFace = {
  size: 0,
  tierRoster: () => [],
  async chatTier(): Promise<VisionChatResult> {
    return {
      ok: false, degraded: true, error: 'no provider available',
      providerId: 'pool', model: '', text: '', latencyMs: 0,
    };
  },
};

/**
 * VlmCascade —— 成本级联路由的执行面（咨询式契约）。
 *
 * runJson() 级联律（返回 null = 弃权，调用方主路径照走，绝不部分承接）：
 *   0. 弃权闸（任一不过 ⇒ null，零调用零行为）：
 *      a. 池空 / 便宜档不在场（tierRoster 无 'cheap'）—— 未标注 tier 零行为变化；
 *      b. 校验谓词集为空（instance + perCall 合并后）—— 无确定性校验则便宜
 *         答案永不可采信，级联无从谈起（统计诚实：宁可不动省钱念想）；
 *      c. 分诊因子缺席（perCall 与接线态因子源皆无产出）—— 无证据不便宜
 *         （失败安全缺省）；
 *      d. danger > dangerMax —— 高危直行主力（分诊判主力，本面弃权让主路径
 *         走主力；记 primaryDirect 观测账）；
 *   1. 便宜臂：chatTier('cheap') 强制 jsonMode；调用败 / JSON 不可解析 /
 *      任一谓词不过 ⇒ 记升级原因，进入 2；全过 ⇒ 采信便宜答案（cheap-hit，
 *      台账记真实便宜花费）；
 *   2. 升级主力重做：chatTier('primary') —— 便宜答案作废，主力档链重做；
 *      成功且可解析 ⇒ 主力值承接（escalated）；失败/不可解析 ⇒ ok:false 诚实
 *      归因（不用失败覆盖主路径的失败 —— 但也绝不静默吞：升级已花真金，结果
 *      如实上报）。台账记便宜实拨 + 主力价（负节省如实呈现）。
 *
 * 内部任何故障（敌意桩上抛 / 假想外的同步面）⇒ null（不抛铁律的最终兜底）。
 */
export class VlmCascade {
  private readonly pool: CascadePoolFace;
  private readonly dangerMax: number;
  private readonly weights: CascadeTriageWeights;
  private readonly baseValidators: readonly CascadeValidator[];
  private readonly factorsSource: (() => CascadeTriageFactors | undefined | null) | undefined;
  private readonly prices: { primary: number; cheap: number };
  private readonly meterImpl: CascadeMeter;

  constructor(pool: CascadePoolFace, opts?: CascadeOptions) {
    this.pool = pool && typeof pool === 'object' ? pool : NULL_POOL;
    const o = opts ?? {};
    const dm = Number(o.dangerMax);
    this.dangerMax = Number.isFinite(dm) ? (dm as number) : CASCADE_DANGER_MAX;
    this.weights = normalizeWeights(o.weights);
    this.baseValidators = Array.isArray(o.validators)
      ? o.validators.filter(v => v && typeof v === 'object' && typeof v.check === 'function')
      : [];
    this.factorsSource = typeof o.factors === 'function' ? o.factors : undefined;
    const pp = Number(o.prices?.primary);
    const cp = Number(o.prices?.cheap);
    this.prices = {
      primary: Number.isFinite(pp) && pp > 0 ? pp : 1,
      cheap: Number.isFinite(cp) && cp >= 0 ? cp : 0.25,
    };
    this.meterImpl =
      o.meter && typeof o.meter === 'object' ? o.meter : new CascadeMeter({ primaryPrice: this.prices.primary });
  }

  /** 级联台账快照（结构化节省率 —— 离线可断言） */
  get stats(): CascadeStats {
    return this.meterImpl.stats();
  }

  /** 台账引用（宿主共享账本时回读/reset 用） */
  get meter(): CascadeMeter {
    return this.meterImpl;
  }

  /** 便宜档在场判定（tierRoster 读取抛错 ⇒ false，绝不带崩） */
  private hasCheapTier(): boolean {
    try {
      const roster = this.pool.tierRoster();
      return Array.isArray(roster) && roster.some(e => e && (e as { tier?: unknown }).tier === 'cheap');
    } catch {
      return false;
    }
  }

  /**
   * 级联咨询（结构化路径）—— 详见类 JSDoc 级联律。
   * 返回 null = 弃权（调用方主路径照走）；非 null = 级联已承接（含诚实失败）。
   */
  async runJson<T = unknown>(
    req: VisionChatRequest,
    perCall?: CascadeRunOptions | null,
  ): Promise<CascadeJsonResult<T> | null> {
    try {
      // 弃权闸 0a：池空 / 便宜档不在场（未标注 tier ⇒ 恒弃权，零行为变化律）
      let size = 0;
      try {
        size = Number(this.pool.size);
      } catch {
        return null; // 敌意 getter —— 视为不可咨询
      }
      if (!Number.isFinite(size) || size <= 0) return null;
      if (!this.hasCheapTier()) return null;

      // 弃权闸 0b：无确定性校验谓词 ⇒ 便宜答案永不可采信 ⇒ 级联无从谈起
      const extra = Array.isArray(perCall?.validators)
        ? perCall!.validators.filter(v => v && typeof v === 'object' && typeof v.check === 'function')
        : [];
      const validators = [...this.baseValidators, ...extra];
      if (validators.length === 0) return null;

      // 弃权闸 0c：分诊因子缺席（perCall 与接线态因子源皆无产出）—— 无证据不便宜
      let factors = perCall?.factors;
      if (factors === undefined || factors === null) {
        try {
          factors = this.factorsSource?.() ?? undefined;
        } catch {
          factors = undefined; // 敌意因子源 —— 视为缺席
        }
      }
      if (factors === undefined || factors === null) return null;

      // 弃权闸 0d：高危直行主力（分诊判主力；本面弃权让主路径走主力）
      if (!triageCheapEligible(factors, { dangerMax: this.dangerMax, weights: this.weights })) {
        this.meterImpl.recordPrimaryDirect();
        return null;
      }

      // ── 便宜臂：最便宜档先试，输出必须过确定性校验才被采信 ──
      const cheapRes = await this.safeChatTier(req, 'cheap');
      const cheapCalled = cheapRes !== null && cheapRes.degraded !== true; // 合成 degraded = 未拨号
      const cheapUnits = cheapCalled ? this.prices.cheap : 0;
      let escalationReason: string;

      let cheapValue: unknown;
      if (cheapRes !== null && cheapRes.ok === true) {
        cheapValue = extractProviderJson(cheapRes.text);
        if (cheapValue !== undefined) {
          const failed = findFailedValidator(validators, cheapValue);
          if (failed === null) {
            // 校验全过 —— 采信便宜答案（省钱事件）
            this.meterImpl.recordCheapHit(cheapUnits, cheapCalled);
            return {
              ok: true,
              value: cheapValue as T,
              raw: typeof cheapRes.text === 'string' ? cheapRes.text : '',
              providerId: cheapRes.providerId,
              model: cheapRes.model,
              latencyMs: Number.isFinite(cheapRes.latencyMs) ? cheapRes.latencyMs : 0,
              meta: { tier: 'cheap', escalated: false, reason: 'cheap-hit' },
            };
          }
          escalationReason = `validation-failed:${failed.name}`;
        } else {
          escalationReason = 'json-unparseable';
        }
      } else {
        escalationReason = 'cheap-call-failed';
      }

      // ── 升级主力重做：便宜答案作废，主力档链重做（安全升级） ──
      const primaryRes = await this.safeChatTier(req, 'primary');
      this.meterImpl.recordEscalation(cheapUnits, cheapCalled);
      if (primaryRes !== null && primaryRes.ok === true) {
        const v = extractProviderJson(primaryRes.text);
        if (v !== undefined) {
          return {
            ok: true,
            value: v as T,
            raw: typeof primaryRes.text === 'string' ? primaryRes.text : '',
            providerId: primaryRes.providerId,
            model: primaryRes.model,
            latencyMs: Number.isFinite(primaryRes.latencyMs) ? primaryRes.latencyMs : 0,
            meta: { tier: 'primary', escalated: true, reason: escalationReason },
          };
        }
        return {
          ok: false,
          error: `cascade primary json extraction failed: no balanced JSON object/array in reply (${primaryRes.text.length} chars)`,
          raw: primaryRes.text,
          providerId: primaryRes.providerId,
          model: primaryRes.model,
          latencyMs: Number.isFinite(primaryRes.latencyMs) ? primaryRes.latencyMs : 0,
          meta: { tier: 'primary', escalated: true, reason: escalationReason },
        };
      }
      const failRes = primaryRes;
      return {
        ok: false,
        error:
          failRes !== null && typeof failRes.error === 'string' && failRes.error !== ''
            ? failRes.error
            : 'cascade escalation failed: no primary-tier provider available',
        raw: failRes !== null && typeof failRes.text === 'string' ? failRes.text : '',
        providerId: failRes !== null && typeof failRes.providerId === 'string' ? failRes.providerId : 'pool',
        model: failRes !== null && typeof failRes.model === 'string' ? failRes.model : '',
        latencyMs: failRes !== null && Number.isFinite(failRes.latencyMs) ? failRes.latencyMs : 0,
        meta: { tier: 'primary', escalated: true, reason: escalationReason },
      };
    } catch {
      return null; // 不抛铁律的最终兜底 —— 弃权，主路径照走
    }
  }

  /** chatTier 安全包装：池违约上抛 ⇒ null（弃权/按失败处置，绝不带出异常） */
  private async safeChatTier(
    req: VisionChatRequest,
    tier: ProviderTier,
  ): Promise<VisionChatResult | null> {
    try {
      return await this.pool.chatTier({ ...req, jsonMode: true }, tier);
    } catch {
      return null;
    }
  }
}
