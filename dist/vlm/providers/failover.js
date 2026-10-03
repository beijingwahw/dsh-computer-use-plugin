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
import { VlmApiBreaker } from '../metering.js';
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
import { createOpenAiProvider } from './openai.js';
import { getPreset as registryGetPreset } from './registry.js';
import { resolveProviderConfig as registryResolveProviderConfig } from './registry.js';
import { extractProviderJson, isLocalBaseUrl, sanitizeError } from './types.js';
/** 取 trim 后的非空串 —— 非字符串/空白归 ''（配置链逐级回退用） */
function nonEmpty(v) {
    return typeof v === 'string' ? v.trim() : '';
}
/** 平台 id 归一：trim + 小写；脏值安静归 ''（不抛铁律） */
function normalizePlatformId(v) {
    try {
        return String(v ?? '').trim().toLowerCase();
    }
    catch {
        return '';
    }
}
/**
 * 平台 id → 预设查表（铸造 fallback 的第一砖）：未知/脏 id 安静返回 null。
 * 返回 { platform, preset } 双件套 —— platform 供 providerId 缺省与去重；
 * 预设本体查自 registry.getPreset（十三平台花名册唯一来源）。
 */
export function getPreset(id) {
    const platform = normalizePlatformId(id);
    if (platform === '')
        return null;
    const preset = registryGetPreset(platform);
    return preset !== null ? { platform, preset } : null;
}
/**
 * 解析主力平台配置（registry 收编版）：provider 未给/查无预设 ⇒ null。
 * 物料解析全权委托 registry.resolveProviderConfig 的「显式 provider」仲裁路
 * （apiKey = 显式 > envKeys 次序；baseUrl/model = 显式 > 预设缺省），本包装只
 * 重标注 via —— 按密钥来源三分（explicit / env / preset）。绝不抛异常。
 */
export function resolveProviderConfig(opts) {
    try {
        const o = opts ?? {};
        const platform = normalizePlatformId(o.provider);
        if (platform === '')
            return null; // 池语义：无显式平台 ⇒ null（baseUrl/env 自动识别不归池管）
        const preset = registryGetPreset(platform);
        if (preset === null)
            return null; // 未知平台诚实 null（不静默换脑）
        const r = registryResolveProviderConfig({
            provider: platform,
            ...(nonEmpty(o.apiKey) !== '' ? { apiKey: o.apiKey } : {}),
            ...(nonEmpty(o.baseUrl) !== '' ? { baseUrl: o.baseUrl } : {}),
            ...(nonEmpty(o.model) !== '' ? { model: o.model } : {}),
        });
        if (r === null)
            return null; // 理论不可达（platform 已查有预设）
        const via = nonEmpty(o.apiKey) !== '' ? 'explicit' : r.apiKey !== '' ? 'env' : 'preset';
        return { preset: r.preset, apiKey: r.apiKey, baseUrl: r.baseUrl, model: r.model, via };
    }
    catch {
        return null;
    }
}
/** note 环形缓冲容量 —— 只留最近 10 条切换决策 */
const NOTE_RING = 10;
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
    entries;
    clock;
    notesRing = [];
    /**
     * @param providers 池序战斗序列（index 0 = 主力）；垃圾条目（非对象/无 chat
     *        函数）与 id 重复者被安静剔除（不抛铁律在构造期即生效）
     * @param options 熔断参数与时钟注入
     */
    constructor(providers, options) {
        const opts = options ?? {};
        // 时钟安全包装：注入的 now 抛错/回脏值都兜底到 Date.now（绝不抛铁律）
        const rawNow = typeof opts.now === 'function' ? opts.now : () => Date.now();
        this.clock = () => {
            try {
                const t = rawNow();
                return Number.isFinite(t) ? t : Date.now();
            }
            catch {
                return Date.now();
            }
        };
        const breakerOpts = opts.breakers;
        const entries = [];
        const source = Array.isArray(providers) ? providers : [];
        for (const p of source) {
            try {
                if (!p || typeof p !== 'object' || typeof p.chat !== 'function')
                    continue;
                if (entries.some(e => e.provider.id === p.id))
                    continue; // 同 id 去重，先到先得
                entries.push({ provider: p, breaker: new VlmApiBreaker(breakerOpts) });
            }
            catch { /* 垃圾条目静默剔除 */ }
        }
        this.entries = entries;
    }
    /** 池内脑数（垃圾/重复条目已剔除后） */
    get size() {
        return this.entries.length;
    }
    /** 池序 id 快照（index 0 = 主力） */
    get ids() {
        return this.entries.map(e => e.provider.id);
    }
    /**
     * 人话记录最近一次切换决策 —— 环形只留最近 10 条（溢出丢最老）。
     * 空/非串输入安静丢弃；正文截 300 字防失控。health 报告消费（notes 快照）。
     */
    note(text) {
        try {
            const t = typeof text === 'string' ? text.trim().slice(0, 300) : '';
            if (t === '')
                return;
            this.notesRing.push(t);
            if (this.notesRing.length > NOTE_RING) {
                this.notesRing.splice(0, this.notesRing.length - NOTE_RING);
            }
        }
        catch { /* 记录面故障静默 —— 主流程不受影响 */ }
    }
    /** 切换决策环形快照（只读副本）—— health 报告的叙事面，顺序 = 时间序 */
    get notes() {
        return [...this.notesRing];
    }
    /**
     * 视觉对话 —— 故障切换律的执行面（详见类 JSDoc）：
     * 按池序尝试，未配置跳过、熔断 open 跳行、失败切下一脑；首胜即回传，
     * 全败回传末败，无脑可用回传合成 degraded。绝不抛异常。
     */
    async chat(req) {
        try {
            let lastFailed;
            for (const entry of this.entries) {
                const p = entry.provider;
                if (p.configured !== true) {
                    this.note(`跳过 ${p.id}（未配置）`);
                    continue;
                }
                if (entry.breaker.state(this.clock()) === 'open') {
                    this.note(`跳过 ${p.id}（熔断 open，冷静期内跳行）`);
                    continue;
                }
                let res;
                try {
                    res = await p.chat(req);
                }
                catch (e) {
                    // 兄弟适配器违约上抛（契约要求永不抛）—— 就地收敛为失败并继续切脑
                    res = {
                        ok: false, text: '', latencyMs: 0,
                        model: p.model, providerId: p.id,
                        error: sanitizeError(e, p.id),
                    };
                }
                if (res && res.ok === true) {
                    entry.breaker.onSuccess(this.clock());
                    return res; // 首胜直传 —— providerId/model 原样归因
                }
                // 失败结果契约整形：ok:false 时 text 恒为 ''，error 必有
                const fail = res && typeof res === 'object'
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
                entry.breaker.onFailure(this.clock());
                lastFailed = fail;
                const snippet = (fail.error ?? 'unknown error').slice(0, 80);
                this.note(`${p.id} 失败（${snippet}）—— 按池序切换下一脑`);
            }
            if (lastFailed !== undefined) {
                this.note(`全线失败 —— 回传最后一个失败结果（${lastFailed.providerId}）`);
                return lastFailed;
            }
            this.note('无可用脑（空池或全员被跳过）—— 合成 degraded 结果');
            return {
                ok: false, degraded: true, error: 'no provider available',
                providerId: 'pool', model: '', text: '', latencyMs: 0,
            };
        }
        catch (e) {
            // 不抛铁律的最终兜底（理论不可达 —— 同步面故障也归约为合成 degraded）
            return {
                ok: false, degraded: true, error: sanitizeError(e, 'pool'),
                providerId: 'pool', model: '', text: '', latencyMs: 0,
            };
        }
    }
    /**
     * 结构化对话 —— 基于 chat() 的故障切换结果做 JSON 剥壳提取
     * （extractProviderJson 同律：剥围栏 → 首个平衡 {...}/[...] → parse）。
     * 强制 jsonMode；成功：{ ok:true, value, raw }；失败：{ ok:false, error, raw }
     * —— raw 恒为模型回复原文（成功也是）。绝不抛异常。
     */
    async chatJson(req) {
        try {
            const res = await this.chat({ ...req, jsonMode: true });
            if (!res.ok) {
                return { ok: false, error: res.error, raw: res.text };
            }
            const value = extractProviderJson(res.text);
            if (value === undefined) {
                return {
                    ok: false,
                    error: `pool json extraction failed: no balanced JSON object/array in reply (${res.text.length} chars)`,
                    raw: res.text,
                };
            }
            return { ok: true, value: value, raw: res.text };
        }
        catch (e) {
            return { ok: false, error: sanitizeError(e, 'pool'), raw: '' };
        }
    }
    /**
     * 健康快照：每脑一条 { id, configured, state } —— state 为其专属熔断器
     * 当前态（closed/open，半开语义由 VlmApiBreaker 惰性判定）。只读快照，
     * 不改变任何状态；叙事面配合 notes 快照构成完整 health 报告。
     */
    health() {
        const now = this.clock();
        return this.entries.map(e => ({
            id: e.provider.id,
            configured: e.provider.configured === true,
            state: e.breaker.state(now),
        }));
    }
}
/** 按预设协议选厂铸造 —— openai/anthropic/gemini 三兄弟适配器的分派点 */
function castProvider(preset, apiKey, baseUrl, model, fetchImpl, meter) {
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
export function createProviderPool(opts) {
    try {
        const o = opts ?? {};
        const providers = [];
        // 主力：resolveProviderConfig 解析（null ⇒ 空池，铸造律第 1 条）
        const primary = resolveProviderConfig(o);
        if (primary === null)
            return new ProviderPool([]);
        providers.push(castProvider(primary.preset, primary.apiKey, primary.baseUrl, primary.model, o.fetchImpl, o.meter));
        // 备选：各自 env/key 自解析（registry 仲裁），解析不出 key 且非本机免钥 ⇒ 跳过
        const seen = new Set([primary.preset.id]);
        const fallbacks = Array.isArray(o.fallbacks) ? o.fallbacks : [];
        for (const raw of fallbacks) {
            const found = getPreset(raw);
            if (found === null)
                continue; // 查无预设
            if (seen.has(found.platform))
                continue; // 主力或先到的同 id 去重
            seen.add(found.platform);
            const r = registryResolveProviderConfig({ provider: found.platform });
            if (r === null)
                continue; // 理论不可达（found 已查有预设）
            const localFree = found.preset.localAuthOptional === true && isLocalBaseUrl(found.preset.baseUrl);
            if (r.apiKey === '' && !localFree)
                continue; // 无钥且非本机免钥 —— 不进池
            providers.push(castProvider(found.preset, r.apiKey, r.baseUrl, r.model, o.fetchImpl, o.meter));
        }
        return new ProviderPool(providers);
    }
    catch {
        // 铸造面意外故障 —— 空池兜底（chat 走合成 degraded，绝不抛）
        return new ProviderPool([]);
    }
}
