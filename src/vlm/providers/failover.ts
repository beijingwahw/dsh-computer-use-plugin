// src/vlm/providers/failover.ts
// 纪元 Ψ（Ψ-6 万脑归一）：多脑故障切换池 —— 主力挂了备补位，熔断跳行。
//
// 职责：把多个 VisionProvider（万脑）排成一列战斗序列。chat 按池序尝试：
// 未配置的跳过、熔断 open 的跳行、失败记一笔人话切换决策后备脑顶上；全部
// 倒下回传最后一个失败结果；无任何可用脑（空池 / 全员被跳）返回合成 degraded
// —— 全程绝不抛异常。熔断复用 metering.VlmApiBreaker（连续失败阈值 + 冷却期
// 半开回闭，时间轴可注入，测试零墙钟）。
//
// 纪元 Ψ 收编（万脑归一）：本文件曾经的 PLATFORM_PRESETS / resolveProviderConfig /
// getPreset 内嵌桩已删除 —— 预设花名册的唯一来源是 './registry'（十三平台挂号表）。
// 此处保留三个池语义包装：getPreset 返回 { platform, preset } 双件套（platform 供
// providerId 缺省与去重）、resolveProviderConfig 只走 registry 的「显式 provider」
// 仲裁路（池不认 baseUrl/env 自动换脑 —— 换错脑比没有脑更糟）、via 仍按密钥来源
// 三分（explicit / env / preset，registry 的 via 标的是平台发现路，语义不同）。

import { VlmApiBreaker } from '../metering';
import { createAnthropicProvider } from './anthropic';
import { createGeminiProvider } from './gemini';
import { createOpenAiProvider } from './openai';
import { getPreset as registryGetPreset } from './registry';
import { resolveProviderConfig as registryResolveProviderConfig } from './registry';
import { extractProviderJson, isLocalBaseUrl, sanitizeError } from './types';
import type {
  ProviderMeterRecord,
  ProviderTier,
  VisionChatRequest,
  VisionChatResult,
  VisionProvider,
} from './types';
import type { PlatformPreset } from './registry';

// 平台预设类型单一来源转发（原内嵌桩已删；形状见 registry.PlatformPreset）
export type { PlatformPreset } from './registry';

// ─── registry 预设的池语义包装（预设数据零重复，全部查表自 registry） ───

/** 配置解析来源 —— 显式注入 / 环境变量 / 仅预设（未取到密钥） */
export type ProviderConfigVia = 'explicit' | 'env' | 'preset';

/** resolveProviderConfig 的解析产物 —— 铸造一个 provider 所需的全部材料 */
export interface ResolvedProviderConfig {
  /** 命中的平台预设（registry.PlatformPreset：id/protocol/baseUrl/envKeys/defaultModel…） */
  preset: PlatformPreset;
  /** 解析出的 apiKey（可为 '' —— 由适配器按 configured 规则处置） */
  apiKey: string;
  /** 服务基址（显式 > 预设） */
  baseUrl: string;
  /** 模型名（显式 > 预设） */
  model: string;
  /** 密钥来源：explicit = 显式注入；env = 环境变量；preset = 没解析到密钥 */
  via: ProviderConfigVia;
}

/** 取 trim 后的非空串 —— 非字符串/空白归 ''（配置链逐级回退用） */
function nonEmpty(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 平台 id 归一：trim + 小写；脏值安静归 ''（不抛铁律） */
function normalizePlatformId(v: unknown): string {
  try {
    return String(v ?? '').trim().toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 平台 id → 预设查表（铸造 fallback 的第一砖）：未知/脏 id 安静返回 null。
 * 返回 { platform, preset } 双件套 —— platform 供 providerId 缺省与去重；
 * 预设本体查自 registry.getPreset（十三平台花名册唯一来源）。
 */
export function getPreset(id: unknown): { platform: string; preset: PlatformPreset } | null {
  const platform = normalizePlatformId(id);
  if (platform === '') return null;
  const preset = registryGetPreset(platform);
  return preset !== null ? { platform, preset } : null;
}

/**
 * 解析主力平台配置（registry 收编版）：provider 未给/查无预设 ⇒ null。
 * 物料解析全权委托 registry.resolveProviderConfig 的「显式 provider」仲裁路
 * （apiKey = 显式 > envKeys 次序；baseUrl/model = 显式 > 预设缺省），本包装只
 * 重标注 via —— 按密钥来源三分（explicit / env / preset）。绝不抛异常。
 */
export function resolveProviderConfig(
  opts?: { provider?: string; apiKey?: string; baseUrl?: string; model?: string },
): ResolvedProviderConfig | null {
  try {
    const o = opts ?? {};
    const platform = normalizePlatformId(o.provider);
    if (platform === '') return null; // 池语义：无显式平台 ⇒ null（baseUrl/env 自动识别不归池管）
    const preset = registryGetPreset(platform);
    if (preset === null) return null; // 未知平台诚实 null（不静默换脑）
    const r = registryResolveProviderConfig({
      provider: platform,
      ...(nonEmpty(o.apiKey) !== '' ? { apiKey: o.apiKey } : {}),
      ...(nonEmpty(o.baseUrl) !== '' ? { baseUrl: o.baseUrl } : {}),
      ...(nonEmpty(o.model) !== '' ? { model: o.model } : {}),
    });
    if (r === null) return null; // 理论不可达（platform 已查有预设）
    const via: ProviderConfigVia =
      nonEmpty(o.apiKey) !== '' ? 'explicit' : r.apiKey !== '' ? 'env' : 'preset';
    return { preset: r.preset, apiKey: r.apiKey, baseUrl: r.baseUrl, model: r.model, via };
  } catch {
    return null;
  }
}

// ─── 多脑故障切换池 ───

/** 故障切换池选项 —— 熔断参数与时间轴全部可注入（离线测试零墙钟） */
export interface ProviderPoolOptions {
  /** 熔断器参数（透传 VlmApiBreaker：failureThreshold 缺省 5，cooldownMs 缺省 60000） */
  breakers?: { failureThreshold?: number; cooldownMs?: number };
  /** 时钟注入 —— 缺省 Date.now；返回非有限值或抛错都被安全兜底 */
  now?: () => number;
  /**
   * W2-8（C2 成本级联路由）：tier 标注注入（配置序标注面）—— id → tier 的
   * 显式覆盖表，优先于供应方自报的 provider.tier；未列出的 id 走自报/缺省
   * 'primary'。仅级联路由消费，chat()/failover 语义零影响。
   */
  tiers?: Readonly<Record<string, ProviderTier>>;
}

/** note 环形缓冲容量 —— 只留最近 10 条切换决策 */
const NOTE_RING = 10;

/** 池内条目：provider 与其专属熔断器一一配对 */
interface PoolEntry {
  readonly provider: VisionProvider;
  readonly breaker: VlmApiBreaker;
  /** W2-8：成本档标注（options.tiers[id] > provider.tier > 'primary' 三级解析） */
  readonly tier: ProviderTier;
}

// ─── ΑΩ-R35（同源降位）：与主力同平台同端点的候选降一位 ───

/** 基址归一：trim + 小写 + 剥尾斜杠（同源判定的端点因子；缺席 ⇒ ''） */
function normPoolBaseUrl(v: unknown): string {
  try {
    return typeof v === 'string' ? v.trim().toLowerCase().replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

/**
 * 同源判定（ΑΩ-R35）：同 platform（线协议方言一致）**且**同 baseUrl（归一后
 * 相等、双侧非空）才判同源 —— 池构造已按 id 去重，同源只可能是「不同 id、
 * 同方言、同端点」的镜像脑（如经不同预设 id 接入的同一网关/同一云脑）。
 * 任一侧 baseUrl 缺席 ⇒ 不同源（诚实不虚构比对材料，refute.ts 同律）。
 */
function isSamePoolSource(a: VisionProvider, b: VisionProvider): boolean {
  try {
    if (a.protocol !== b.protocol) return false;
    const ua = normPoolBaseUrl(a.baseUrl);
    const ub = normPoolBaseUrl(b.baseUrl);
    return ua !== '' && ua === ub;
  } catch {
    return false;
  }
}

/**
 * 同源降位（ΑΩ-R35）：主脑网络错时，与主力同平台同端点的次席大概率沿同一
 * 网络路径再失败一次（DNS 污染/端点抖动对同源脑是共享故障域）—— 故把紧随
 * 主力的同源候选降一位，让异构脑先顶上；**降序不删除**：同源脑仍留池内作
 * 最后手段（异构脑也倒下时，同源脑的剩余价值大于空池）。每颗同源候选至多
 * 降一位（与其后继交换一次，不连锁连降）；判定/交换全程 try 兜底，任何
 * 故障保持原池序（不抛铁律）。返回降位数供观测面记账。
 */
function demoteSameSourceAsHead(entries: readonly PoolEntry[]): { order: PoolEntry[]; demoted: string[] } {
  const out = [...entries];
  const demoted: string[] = [];
  if (out.length < 3) return { order: out, demoted }; // 无后继可换（单脑/双脑池）⇒ 原序
  const head = out[0]!;
  for (let i = 1; i + 1 < out.length; i++) {
    if (!isSamePoolSource(head.provider, out[i]!.provider)) continue;
    if (isSamePoolSource(head.provider, out[i + 1]!.provider)) continue; // 连续同源：让位后者等效
    const next = out[i + 1]!;
    out[i + 1] = out[i]!;
    out[i] = next;
    demoted.push(out[i + 1]!.provider.id);
    i++; // 已降位者不再连降（至多一位）
  }
  return { order: out, demoted };
}

/**
 * 多脑故障切换池 —— 万脑战斗序列。
 *
 * chat() 切换律（按池序逐一尝试，绝不抛异常）：
 *   1. 跳过 `!configured` 的脑（未配置零网络，不值得尝试）；
 *   2. 跳过熔断 open 的脑（连续失败越阈，冷却期内整行跳过 —— 「熔断跳行」）；
 *   3. 调用 provider.chat：ok:true ⇒ 熔断器 onSuccess 记账并**直接返回**
 *      该脑的 VisionChatResult（providerId 天然归因，零包装）；
 *   4. ok:false（含兄弟适配器违约上抛 —— 就地收敛为失败）⇒ 熔断器 onFailure
 *      记账、note() 记一句人话切换决策，继续下一脑；
 *   5. 全部尝试皆败 ⇒ 回传**最后一个**失败结果（保留真实归因与错误现场）；
 *   6. 无任何脑被尝试（空池 / 全员被跳过）⇒ 返回合成 degraded 结果：
 *      `{ ok:false, degraded:true, error:'no provider available',
 *         providerId:'pool', model:'', text:'', latencyMs:0 }`。
 *
 * 熔断语义全权委托 metering.VlmApiBreaker：连续失败 ≥ failureThreshold ⇒ open；
 * 冷却期（cooldownMs）期满自动回 closed（半开语义惰性判定，无后台定时器）。
 * 时间轴经 options.now 注入 —— 测试可离线拨钟复算熔断全程。
 */
export class ProviderPool {
  private readonly entries: readonly PoolEntry[];
  private readonly clock: () => number;
  private readonly notesRing: string[] = [];

  /**
   * @param providers 池序战斗序列（index 0 = 主力）；垃圾条目（非对象/无 chat
   *        函数）与 id 重复者被安静剔除（不抛铁律在构造期即生效）。ΑΩ-R35：
   *        构造期同源降位 —— 与主力同平台（同 protocol）且同 baseUrl 的候选
   *        降一位（降序不删除，仍可作最后手段），理由见 demoteSameSourceAsHead。
   * @param options 熔断参数与时钟注入
   */
  constructor(providers: VisionProvider[], options?: ProviderPoolOptions) {
    const opts = options ?? {};
    // 时钟安全包装：注入的 now 抛错/回脏值都兜底到 Date.now（绝不抛铁律）
    const rawNow = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.clock = (): number => {
      try {
        const t = rawNow();
        return Number.isFinite(t) ? (t as number) : Date.now();
      } catch {
        return Date.now();
      }
    };
    const breakerOpts = opts.breakers;
    // W2-8：tier 覆盖表（配置序标注面）—— 非对象安静视为缺席（不抛铁律）
    const tierOverrides =
      opts.tiers && typeof opts.tiers === 'object' ? (opts.tiers as Readonly<Record<string, ProviderTier>>) : undefined;
    const entries: PoolEntry[] = [];
    const source = Array.isArray(providers) ? providers : [];
    for (const p of source) {
      try {
        if (!p || typeof p !== 'object' || typeof p.chat !== 'function') continue;
        if (entries.some(e => e.provider.id === p.id)) continue; // 同 id 去重，先到先得
        // W2-8：tier 三级解析 —— options.tiers[id] 显式覆盖 > provider.tier 自报 > 'primary'。
        // 只认 'cheap' 字面量，其余一切值（含脏值）归主力档（未标注零行为变化律）。
        const override = tierOverrides?.[p.id];
        const tier: ProviderTier =
          override === 'cheap' || override === 'primary'
            ? override
            : (p as { tier?: unknown }).tier === 'cheap'
              ? 'cheap'
              : 'primary';
        entries.push({ provider: p, breaker: new VlmApiBreaker(breakerOpts), tier });
      } catch { /* 垃圾条目静默剔除 */ }
    }
    // ΑΩ-R35（同源降位）：与主力同平台同端点的候选降一位（降序不删除，仍作
    // 最后手段）—— 论证见 demoteSameSourceAsHead；任何故障保持原池序（不抛）。
    let ordered = entries;
    try {
      const demoted = demoteSameSourceAsHead(entries);
      ordered = demoted.order;
      if (demoted.demoted.length > 0) {
        this.note(`同源降位：${demoted.demoted.join('、')} 与主力 ${entries[0]!.provider.id} 同平台同端点，降一位（异构脑先上，同源脑殿后作最后手段）`);
      }
    } catch { /* 降位面故障 —— 原池序兜底 */ }
    this.entries = ordered;
  }

  /** 池内脑数（垃圾/重复条目已剔除后） */
  get size(): number {
    return this.entries.length;
  }

  /** 池序 id 快照（index 0 = 主力） */
  get ids(): string[] {
    return this.entries.map(e => e.provider.id);
  }

  /**
   * 人话记录最近一次切换决策 —— 环形只留最近 10 条（溢出丢最老）。
   * 空/非串输入安静丢弃；正文截 300 字防失控。health 报告消费（notes 快照）。
   */
  note(text: string): void {
    try {
      const t = typeof text === 'string' ? text.trim().slice(0, 300) : '';
      if (t === '') return;
      this.notesRing.push(t);
      if (this.notesRing.length > NOTE_RING) {
        this.notesRing.splice(0, this.notesRing.length - NOTE_RING);
      }
    } catch { /* 记录面故障静默 —— 主流程不受影响 */ }
  }

  /** 切换决策环形快照（只读副本）—— health 报告的叙事面，顺序 = 时间序 */
  get notes(): string[] {
    return [...this.notesRing];
  }

  /**
   * 视觉对话 —— 故障切换律的执行面（详见类 JSDoc）：
   * 按池序尝试，未配置跳过、熔断 open 跳行、失败切下一脑；首胜即回传，
   * 全败回传末败，无脑可用回传合成 degraded。绝不抛异常。
   */
  async chat(req: VisionChatRequest): Promise<VisionChatResult> {
    // W2-8：全池链 = 不筛 tier（chat 的池序切换语义逐字节保持，tier 正交不掺和）
    return this.runChain(req, this.entries);
  }
  /**
   * W2-8（C2 成本级联路由）：分档对话 —— 切换律与 chat() 完全同构（未配置跳过、
   * 熔断 open 跳行、失败切同档下一脑、首胜直传、全败传末败、无可用脑回合成
   * degraded），仅把战斗序列限制在指定 tier 档内。与 chat()（全池 failover）和
   * ensemble（合议庭）正交 —— 级联路由的第三用途专用面：
   *   - tier='cheap'：便宜臂尝试（池内最便宜档）；
   *   - tier='primary'：主力档链（级联升级重做 / 高危直行）。
   * 脏 tier 值归 'primary'（保守）。绝不抛异常。
   */
  async chatTier(req: VisionChatRequest, tier: ProviderTier): Promise<VisionChatResult> {
    const want: ProviderTier = tier === 'cheap' ? 'cheap' : 'primary';
    return this.runChain(req, this.entries.filter(e => e.tier === want));
  }

  /**
   * W2-8：tier 花名册快照 —— 每脑一条 { id, tier }（池序）。级联路由据此判断
   * 便宜档是否在场；观测面/健康报告亦可消费。只读，不改变状态，绝不抛。
   */
  tierRoster(): Array<{ id: string; tier: ProviderTier }> {
    return this.entries.map(e => ({ id: e.provider.id, tier: e.tier }));
  }

  /**
   * 切换律执行体 —— chat/chatTier 共用（entries 为本次战斗序列，语义见类 JSDoc）。
   * ΝΩ-18（熔断剥壳半权）：runChain 的结构重构为「runChainEntry（不复核胜者
   * 熔断账）+ 胜者 onSuccess 补账」—— 胜者记账从链内挪到链外，chatJson 才能
   * 在「拨号成功但 JSON 剥壳失败」时改记半权失败（onExtractionFailure）而不被
   * 先行的 onSuccess 清零。chat/chatTier 的可观测行为逐字节保持。
   */
  private async runChain(req: VisionChatRequest, entries: readonly PoolEntry[]): Promise<VisionChatResult> {
    const { res, entry } = await this.runChainEntry(req, entries);
    if (res.ok === true && entry !== null) {
      entry.breaker.onSuccess(this.clock());
    }
    return res;
  }

  /** 切换律执行体（胜者熔断账延迟面）—— 返回胜者条目（ok:true 时非 null）供调用方补账 */
  private async runChainEntry(
    req: VisionChatRequest,
    entries: readonly PoolEntry[],
  ): Promise<{ res: VisionChatResult; entry: PoolEntry | null }> {
    try {
      let lastFailed: VisionChatResult | undefined;
      for (const entry of entries) {
        const p = entry.provider;
        if (p.configured !== true) {
          this.note(`跳过 ${p.id}（未配置）`);
          continue;
        }
        if (entry.breaker.state(this.clock()) === 'open') {
          this.note(`跳过 ${p.id}（熔断 open，冷静期内跳行）`);
          continue;
        }
        let res: VisionChatResult;
        try {
          res = await p.chat(req);
        } catch (e) {
          // 兄弟适配器违约上抛（契约要求永不抛）—— 就地收敛为失败并继续切脑
          res = {
            ok: false, text: '', latencyMs: 0,
            model: p.model, providerId: p.id,
            error: sanitizeError(e, p.id),
          };
        }
        if (res && res.ok === true) {
          return { res, entry }; // 首胜直传 —— providerId/model 原样归因；熔断账由调用方补
        }
        // 失败结果契约整形：ok:false 时 text 恒为 ''，error 必有
        const fail: VisionChatResult =
          res && typeof res === 'object'
            ? {
                ...res,
                ok: false,
                text: '',
                providerId: typeof res.providerId === 'string' && res.providerId !== ''
                  ? res.providerId
                  : p.id,
                model: typeof res.model === 'string' && res.model !== '' ? res.model : p.model,
                latencyMs: Number.isFinite(res.latencyMs) ? res.latencyMs : 0,
                error: typeof res.error === 'string' && res.error !== ''
                  ? res.error
                  : `${p.id} unknown error`,
              }
            : {
                ok: false, text: '', latencyMs: 0,
                model: p.model, providerId: p.id,
                error: sanitizeError('provider returned no result', p.id),
              };
        // failureKind 区分面（ΝΩ-18）：真实拨号后的失败 = 全权 onFailure（既有律）
        entry.breaker.onFailure(this.clock());
        lastFailed = fail;
        const snippet = (fail.error ?? 'unknown error').slice(0, 80);
        this.note(`${p.id} 失败（${snippet}）—— 按池序切换下一脑`);
      }
      if (lastFailed !== undefined) {
        this.note(`全线失败 —— 回传最后一个失败结果（${lastFailed.providerId}）`);
        return { res: lastFailed, entry: null };
      }
      this.note('无可用脑（空池或全员被跳过）—— 合成 degraded 结果');
      return {
        res: {
          ok: false, degraded: true, error: 'no provider available',
          providerId: 'pool', model: '', text: '', latencyMs: 0,
        },
        entry: null,
      };
    } catch (e) {
      // 不抛铁律的最终兜底（理论不可达 —— 同步面故障也归约为合成 degraded）
      return {
        res: {
          ok: false, degraded: true, error: sanitizeError(e, 'pool'),
          providerId: 'pool', model: '', text: '', latencyMs: 0,
        },
        entry: null,
      };
    }
  }

  /**
   * 结构化对话 —— 基于 chat() 的故障切换结果做 JSON 剥壳提取
   * （extractProviderJson 同律：剥围栏 → 首个平衡 {...}/[...] → parse）。
   * 强制 jsonMode；成功：{ ok:true, value, raw }；失败：{ ok:false, error, raw }
   * —— raw 恒为模型回复原文（成功也是）。绝不抛异常。
   *
   * ΝΩ-18（熔断剥壳半权）：拨号成功但剥壳失败 = 「未拨号成功」语义的服务质量
   * 劣化（脑可达、回复非 JSON）—— 胜者熔断账按 failureKind 区分：好 JSON ⇒
   * onSuccess；剥壳失败 ⇒ onExtractionFailure（半权 0.5，论证见 metering.ts），
   * 绝不与真实拨号失败的全权 onFailure 同速熔断（误熔断好脑防线）。
   */
  async chatJson<T = unknown>(
    req: VisionChatRequest,
  ): Promise<{ ok: boolean; value?: T; error?: string; raw: string }> {
    try {
      // 强制 jsonMode（原 this.chat({...req, jsonMode:true}) 同律 —— 池内适配器收到
      // 结构化输出指令）；胜者熔断账按剥壳成败分流（onSuccess / 半权）。
      const { res, entry } = await this.runChainEntry({ ...req, jsonMode: true }, this.entries);
      if (!res.ok) {
        return { ok: false, error: res.error, raw: res.text };
      }
      const value = extractProviderJson(res.text);
      if (value === undefined) {
        // 剥壳失败半权 —— 胜者条目在此（runChainEntry 已延迟其成功账）
        if (entry !== null) entry.breaker.onExtractionFailure(this.clock());
        return {
          ok: false,
          error: `pool json extraction failed: no balanced JSON object/array in reply (${res.text.length} chars)`,
          raw: res.text,
        };
      }
      if (entry !== null) entry.breaker.onSuccess(this.clock());
      return { ok: true, value: value as T, raw: res.text };
    } catch (e) {
      return { ok: false, error: sanitizeError(e, 'pool'), raw: '' };
    }
  }

  /**
   * 健康快照：每脑一条 { id, configured, state } —— state 为其专属熔断器
   * 当前态（closed/open，半开语义由 VlmApiBreaker 惰性判定）。只读快照，
   * 不改变任何状态；叙事面配合 notes 快照构成完整 health 报告。
   */
  health(): Array<{ id: string; configured: boolean; state: 'closed' | 'open' }> {
    const now = this.clock();
    return this.entries.map(e => ({
      id: e.provider.id,
      configured: e.provider.configured === true,
      state: e.breaker.state(now),
    }));
  }
}

// ─── 池铸造厂：PoolBuildOptions → ProviderPool ───

/** 铸池选项 —— 主力显式配置 + 备选平台清单，fetch/meter 全可注入 */
export interface PoolBuildOptions {
  /** 主力平台 id（registry.PLATFORM_PRESETS 的平台 id，如 'glm'/'openai'/'anthropic'）；未给/查无 ⇒ 空池 */
  provider?: string;
  /** 主力显式 apiKey（优先于该平台的环境变量回退次序） */
  apiKey?: string;
  /** 主力服务基址（缺省用平台预设；仅作用于主力，fallback 各自解析） */
  baseUrl?: string;
  /** 主力模型名（缺省用平台预设；仅作用于主力） */
  model?: string;
  /** 备选平台 id 清单（各自的 env/key 自解析，按序排在主力之后） */
  fallbacks?: string[];
  /** fetch 实现 —— 透传给池内每个适配器（测试注入假实现，绝不真实联网） */
  fetchImpl?: typeof fetch;
  /** 用量遥测回调 —— 透传给池内每个适配器（每次 chat 恰好一条） */
  meter?: (rec: ProviderMeterRecord) => void;
  /**
   * W2-8（C2 成本级联路由）：tier 标注注入（配置序标注面）—— 平台 id →
   * 'cheap'/'primary'；透传 ProviderPoolOptions.tiers（自报 provider.tier 的
   * 显式覆盖）。未给 ⇒ 全员主力档（零行为变化律）。
   */
  tiers?: Readonly<Record<string, ProviderTier>>;
}

/** 按预设协议选厂铸造 —— openai/anthropic/gemini 三兄弟适配器的分派点 */
function castProvider(
  preset: PlatformPreset,
  apiKey: string,
  baseUrl: string,
  model: string,
  fetchImpl: typeof fetch | undefined,
  meter: ((rec: ProviderMeterRecord) => void) | undefined,
): VisionProvider {
  const config = {
    id: preset.id,
    apiKey,
    baseUrl,
    model,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(meter ? { meter } : {}),
  };
  switch (preset.protocol) {
    case 'anthropic':
      return createAnthropicProvider(config);
    case 'gemini':
      return createGeminiProvider(config);
    case 'openai':
    default:
      return createOpenAiProvider(config);
  }
}

/**
 * 铸造多脑故障切换池（铸造律）：
 *  1. resolveProviderConfig 解析主力 —— null（平台未给/查无预设）⇒ 空池
 *     （size 0，chat 回合成 degraded）；主力即便没解析到密钥也照常进池
 *     （configured:false，chat 会跳过它 —— 诚实降级而非静默丢脑）；
 *  2. 每个 fallback id 经 getPreset + registry env 自解析为 provider；查无预设
 *     跳过，与主力同 id 跳过（去重）；
 *  3. 解析不出 key 且预设非 localAuthOptional（本机免钥脑）的 fallback
 *     跳过 —— 不进池（半配置的备脑顶上去只会白烧一次降级调用）；
 *  4. 按预设 protocol 分派 createOpenAiProvider / createAnthropicProvider /
 *     createGeminiProvider（import 自兄弟文件），fetchImpl/meter 全员透传。
 * 任何铸造面故障都收敛为「尽力而为的池」乃至空池 —— 绝不抛异常。
 */
export function createProviderPool(opts?: PoolBuildOptions): ProviderPool {
  try {
    const o = opts ?? {};
    const providers: VisionProvider[] = [];

    // 主力：resolveProviderConfig 解析（null ⇒ 空池，铸造律第 1 条）
    const primary = resolveProviderConfig(o);
    if (primary === null) return new ProviderPool([]);
    providers.push(
      castProvider(
        primary.preset,
        primary.apiKey,
        primary.baseUrl,
        primary.model,
        o.fetchImpl,
        o.meter,
      ),
    );

    // 备选：各自 env/key 自解析（registry 仲裁），解析不出 key 且非本机免钥 ⇒ 跳过
    const seen = new Set<string>([primary.preset.id]);
    const fallbacks = Array.isArray(o.fallbacks) ? o.fallbacks : [];
    for (const raw of fallbacks) {
      const found = getPreset(raw);
      if (found === null) continue; // 查无预设
      if (seen.has(found.platform)) continue; // 主力或先到的同 id 去重
      seen.add(found.platform);
      const r = registryResolveProviderConfig({ provider: found.platform });
      if (r === null) continue; // 理论不可达（found 已查有预设）
      const localFree =
        found.preset.localAuthOptional === true && isLocalBaseUrl(found.preset.baseUrl);
      if (r.apiKey === '' && !localFree) continue; // 无钥且非本机免钥 —— 不进池
      providers.push(
        castProvider(
          found.preset,
          r.apiKey,
          r.baseUrl,
          r.model,
          o.fetchImpl,
          o.meter,
        ),
      );
    }
    // W2-8：tier 标注透传（配置序标注面）—— 级联路由专用，缺省全员主力档
    return new ProviderPool(providers, o.tiers !== undefined ? { tiers: o.tiers } : undefined);
  } catch {
    // 铸造面意外故障 —— 空池兜底（chat 走合成 degraded，绝不抛）
    return new ProviderPool([]);
  }
}
