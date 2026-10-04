// src/vlm/providers/ensemble.ts
// 纪元 Σ（Σ-1 全军升维）：云脑合议庭 —— 多平台视觉模型并行作答、仲裁融合（ensemble quorum）。
//
// 存在理由：单颗云脑是单点视角 —— 幻觉、方言、坐标漂移都是一家之言。合议庭把
// 多颗脑（openai / anthropic / gemini / qwen …）并排请上席，同一截图同一问题
// 各自独立作答，再用纯数学（normalizedLevenshtein 聚类 / 多数票 / arbitrateElements
// 凸组合）融合出比任一单脑更可信的答案。与 failover（Ψ-6 串行切换、首胜即回）
// 互补：池是「一颗脑活着就行」，庭是「多颗脑互相作证」。
//
// 实现铁律（与 types.ts / failover.ts 同调）：
//   1. 永不抛异常 —— 一切失败以成员条目 ok:false / 降级形态表达（恶意桩上抛
//      也收敛为该成员的失败记账，绝不带崩整庭）；
//   2. 密钥卫生 —— 成员错误面经 sanitizeError（复用 types.ts 唯一定义点）；
//   3. 纯离线可测 —— 依赖只有兄弟适配器（fetchImpl 注入）与纯函数仲裁器，
//      本模块自身零网络、零 I/O、零时钟注入（延迟用 Date.now 实测记账）；
//   4. census 透明 —— members[] 恒为全体庭员普查表：未配置 / 失败 / 成功各记
//      一笔，长度恒等于庭员数（调用方永远知道每颗脑怎么了）。
//
// 融合数学的单一定义点：文本相似度与元素凸组合全部委托 arbitration.ts
// （normalizedLevenshtein / arbitrateElements）—— 本模块只做编排，不发明新测度。
import { normalizedLevenshtein } from '../arbitration.js';
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
import { createOpenAiProvider } from './openai.js';
import { resolveProviderConfig } from './failover.js';
import { isLocalBaseUrl, sanitizeError } from './types.js';
import { normalizeElements, fusePair, confOr } from './ensemble.elements.js';
// ─── 内部常量与默认提示词 ───
/** 同簇判据线：两两 normalizedLevenshtein 相似度 ≥ 0.7 判同一簇（拼写级分歧容忍） */
const CLUSTER_THRESHOLD = 0.7;
/** 裁决系统词缺省 —— 强制 {verdict, confidence} 严格 JSON 方言 */
const VERDICT_SYSTEM = '你是严谨的事实裁决官。只输出严格 JSON：{"verdict":"confirmed"|"refuted","confidence":0到1的小数}。' +
    '依据截图与问题判定陈述真假，不要输出 JSON 以外的任何内容。';
/** 接地系统词缺省 —— 强制 {elements:[...]} 严格 JSON 方言（bbox 数组/对象双形态） */
const ELEMENTS_SYSTEM = '你是桌面截图的视觉接地专家。只输出严格 JSON：{"elements":[{"label":"元素可见文字",' +
    '"role":"button|textbox|link|icon|text","bbox":[x0,y0,x1,y1] 或 {"x0":..,"y0":..,"x1":..,"y1":..},' +
    '"confidence":0到1的小数}]}。bbox 为像素坐标且 x1>x0、y1>y0。不要输出 JSON 以外的任何内容。';
// ─── 内部：文本相似度测度与聚类 ───
/**
 * 两两相似度均值（agreement 的唯一算法）：成功成员文本的全对 (i<j)
 * normalizedLevenshtein 均值。0 家（空集无对）与约定 0；恰 1 家（无对可算、
 * 自证恒等）约定 1 —— 与 askText 单家直通律配套。
 */
function meanPairwiseSimilarity(texts) {
    if (texts.length === 0)
        return 0;
    if (texts.length === 1)
        return 1;
    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < texts.length; i++) {
        for (let j = i + 1; j < texts.length; j++) {
            sum += normalizedLevenshtein(texts[i], texts[j]);
            pairs++;
        }
    }
    return pairs > 0 ? sum / pairs : 0;
}
/**
 * 相似度聚类（代表簇的选法定义点）：并查集把两两相似度 ≥ threshold 的成员
 * 传递闭包归同簇（a~b 且 b~c ⇒ a、b、c 同簇，即使 a~c 低于线）；返回簇列表
 ** 按簇容量降序、并列取成员序最小者先 —— groups[0] 即代表簇，簇内序升序。
 */
function clusterBySimilarity(texts, threshold = CLUSTER_THRESHOLD) {
    const n = texts.length;
    const parent = texts.map((_, i) => i);
    const find = (i) => {
        let r = i;
        while (parent[r] !== r)
            r = parent[r];
        while (parent[i] !== r) {
            const next = parent[i];
            parent[i] = r;
            i = next;
        }
        return r;
    };
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (normalizedLevenshtein(texts[i], texts[j]) >= threshold) {
                const a = find(i);
                const b = find(j);
                if (a !== b)
                    parent[Math.max(a, b)] = Math.min(a, b);
            }
        }
    }
    const groups = new Map();
    for (let i = 0; i < n; i++) {
        const root = find(i);
        const g = groups.get(root);
        if (g !== undefined)
            g.push(i);
        else
            groups.set(root, [i]);
    }
    return [...groups.values()]
        .map(g => g.sort((a, b) => a - b))
        .sort((a, b) => b.length - a.length || a[0] - b[0]);
}
// ─── 云脑合议庭 ───
/**
 * 云脑合议庭 —— ensemble quorum 的执行面。
 *
 * 构造律（与 ProviderPool 同调）：垃圾条目（非对象 / 缺 chat 或 chatJson 函数）
 * 安静剔除；同 id 去重先到先得 —— 构造期即生效不抛铁律。庭员不复制、不熔断
 * （庭的信条是互相作证而非切换续命，配额/熔断归各适配器与池管辖）。
 */
export class EnsembleCourt {
    roster;
    /** @param providers 庭员名单（index 0 = 座长席；垃圾与重复条目安静剔除） */
    constructor(providers) {
        const roster = [];
        const seen = new Set();
        const source = Array.isArray(providers) ? providers : [];
        for (const p of source) {
            try {
                if (!p || typeof p !== 'object' || typeof p.chat !== 'function' || typeof p.chatJson !== 'function')
                    continue;
                if (seen.has(p.id))
                    continue; // 同 id 去重，先到先得
                seen.add(p.id);
                roster.push(p);
            }
            catch { /* 垃圾条目静默剔除 */ }
        }
        this.roster = roster;
    }
    /** 庭员数（垃圾/重复条目已剔除后） */
    get size() {
        return this.roster.length;
    }
    /**
     * 纪元 Β（反驳法院）纯增量导出：庭员名册只读快照（座次序浅拷贝）。
     * 反驳法院的第二意见面（vlm/refute.ts）据此按身份（providerId）剔除与主脑
     * 同源的庭员、再请首颗异构脑作证 —— 本方法只暴露既有 roster 的防御性
     * 副本（成员对象仍为原引用，chatJson 直接绑定零包装零额外调用），对既有
     * 合议庭行为零影响。绝不抛。
     */
    listRoster() {
        return [...this.roster];
    }
    /**
     * 并席发问的公共底座：Promise.allSettled 并行问全部 configured 庭员，
     * 未配置成员不拨号但记普查条目（ok:false + 'not configured'）。
     * 成员违约上抛（契约要求永不抛）⇒ 就地收敛为该成员失败（sanitizeError 面）。
     * useJson 路径走 chatJson（延迟由本庭实测记账 —— chatJson 结果不含 latencyMs），
     * 成功时解析值随行返回；chat 路径优先采信结果自带的 latencyMs。
     * 返回序 = 座次序；本方法自身也绝不抛（理论兜底条目记 'ensemble' 归因）。
     */
    async askAll(req, useJson, system, prompt) {
        const chatReq = {
            images: Array.isArray(req?.images) ? req.images : [],
            system,
            prompt,
            maxTokens: req?.maxTokens,
            temperature: req?.temperature,
            jsonMode: useJson || req?.jsonMode === true,
            timeoutMs: req?.timeoutMs,
        };
        const jobs = this.roster.map(async (p) => {
            const t0 = Date.now();
            try {
                if (p.configured !== true) {
                    return { result: { id: p.id, ok: false, text: '', latencyMs: 0, error: `${p.id} not configured` } };
                }
                if (useJson) {
                    const r = await p.chatJson(chatReq);
                    const latencyMs = Date.now() - t0;
                    const raw = r && typeof r.raw === 'string' ? r.raw : '';
                    if (r && r.ok === true) {
                        return { result: { id: p.id, ok: true, text: raw, latencyMs }, value: r.value };
                    }
                    const err = r && typeof r.error === 'string' && r.error !== '' ? r.error : `${p.id} json call failed`;
                    return { result: { id: p.id, ok: false, text: raw, latencyMs, error: err } };
                }
                const r = await p.chat(chatReq);
                const measured = Date.now() - t0;
                if (r && typeof r === 'object' && r.ok === true) {
                    const latencyMs = Number.isFinite(r.latencyMs) ? r.latencyMs : measured;
                    return { result: { id: p.id, ok: true, text: typeof r.text === 'string' ? r.text : '', latencyMs } };
                }
                // 失败/脏结果整形：ok:false 时 text 恒 ''，error 必有
                const fail = r && typeof r === 'object' ? r : undefined;
                const latencyMs = fail && Number.isFinite(fail.latencyMs) ? fail.latencyMs : measured;
                const error = fail && typeof fail.error === 'string' && fail.error !== ''
                    ? fail.error
                    : sanitizeError('provider returned no result', p.id);
                return { result: { id: p.id, ok: false, text: '', latencyMs, error } };
            }
            catch (e) {
                return { result: { id: p.id, ok: false, text: '', latencyMs: Date.now() - t0, error: sanitizeError(e, p.id) } };
            }
        });
        const settled = await Promise.allSettled(jobs);
        const outcomes = [];
        for (let i = 0; i < settled.length; i++) {
            const s = settled[i];
            if (s.status === 'fulfilled') {
                outcomes.push(s.value);
            }
            else {
                // 理论不可达（每个 job 自带 try/catch）—— 保持座次对齐的兜底记账
                const id = this.roster[i] !== undefined ? this.roster[i].id : 'unknown';
                outcomes.push({ result: { id, ok: false, text: '', latencyMs: 0, error: sanitizeError(s.reason, 'ensemble') } });
            }
        }
        return outcomes;
    }
    /**
     * 文本合议 —— askText 融合律（JSDoc 即法定）：
     *
     *  1. Promise.allSettled 并行问全部 configured 庭员（未配置者记普查失败条目，
     *     不拨号）；
     *  2. 成功家 < 1（全败 / 空庭 / 全员未配置）⇒ `{ text:'', agreement:0,
     *     quorum:'degraded' }` —— 空集无对可算，agreement 约定 0；
     *  3. 恰 1 家成功 ⇒ 单家直通：text = 该家原文，agreement = 1（无对可算、
     *     自证恒等），quorum = 'degraded' —— 单席无法互相作证，诚实降级档；
     *  4. 多家成功 ⇒ normalizedLevenshtein 相似度聚类（两两相似度 ≥ 0.7 传递
     *     闭包归同簇），容量最大簇为代表簇（并列取成员序最小者）：
     *       · 全体同簇 ⇒ 'unanimous'（一致意见）；
     *       · 最大簇占成功家数比 ≥ 0.5 ⇒ 'majority'（多数意见）；
     *       · 否则 ⇒ 'split'（意见分裂，答案采信度存疑但如实上报）；
     *     text 恒取代表簇首家的文本（VisionChatResult 不携带置信度，无「簇中
     *     最高置信」可选 —— 按座次取首家，确定且可审计）；
     *  5. agreement = 成功成员间两两相似度均值（meanPairwiseSimilarity）；
     *  6. members 恒为全体庭员普查表 —— 绝不因个别成员失败/上抛而缺席。
     *
     * 绝不抛异常：任何内部故障收敛为 degraded 空答案。
     */
    async askText(req) {
        try {
            const outcomes = await this.askAll(req, false, req?.system, typeof req?.prompt === 'string' ? req.prompt : '');
            const members = outcomes.map(o => o.result);
            const texts = outcomes.filter(o => o.result.ok === true).map(o => o.result.text);
            if (texts.length === 0) {
                return { text: '', agreement: 0, quorum: 'degraded', members };
            }
            if (texts.length === 1) {
                return { text: texts[0], agreement: 1, quorum: 'degraded', members };
            }
            const groups = clusterBySimilarity(texts);
            const rep = groups[0];
            const ratio = rep.length / texts.length;
            const quorum = groups.length === 1 ? 'unanimous' : ratio >= 0.5 ? 'majority' : 'split';
            return {
                text: texts[rep[0]], // 代表簇首家（座次序）的文本 —— 无置信可选，取首定谳
                agreement: meanPairwiseSimilarity(texts),
                quorum,
                members,
            };
        }
        catch {
            // 不抛铁律的最终兜底（理论不可达 —— askAll 自带全量 try/catch）
            return { text: '', agreement: 0, quorum: 'degraded', members: [] };
        }
    }
    /**
     * 裁决合议 —— askVerdict 判决律：
     *
     *  1. 全部 configured 庭员并行 chatJson（缺省注入裁决系统词，强制 JSON 方言），
     *     各家载荷 {verdict, confidence}；
     *  2. 有效票 = verdict ∈ {'confirmed','refuted'}；confidence 取有限数字夹
     *     [0,1]，缺席/脏值记中性 0.5；verdict 脏值（含 'uncertain' 字面量）与
     *     chatJson 失败均不入票池（成员普查条目仍如实记账）；
     *  3. 多数票：confirmed 票 > refuted 票 ⇒ 'confirmed'；反之 ⇒ 'refuted'；
     *     平票（含 0:0 全垃圾）⇒ 'uncertain'；
     *  4. confidence = 胜方置信均值 × (胜方票数 / 有效总票数) —— 多数优势与
     *     自报置信的乘性折减；uncertain 恒 0（无胜方可均）；
     *  5. dissents = 少数派点名 `${id}:${verdict}`（胜者已定 ⇒ 仅败方入选）；
     *     uncertain 平票 ⇒ 全部已投有效票入列（无一票成为判决，票票皆异议）。
     *
     * 绝不抛异常：任何内部故障收敛为 { verdict:'uncertain', confidence:0, dissents:[], members:[] }。
     */
    async askVerdict(req) {
        try {
            const system = req?.system !== undefined && req.system !== '' ? req.system : VERDICT_SYSTEM;
            const outcomes = await this.askAll(req, true, system, typeof req?.prompt === 'string' ? req.prompt : '');
            const members = outcomes.map(o => o.result);
            const votes = [];
            for (const o of outcomes) {
                if (o.result.ok !== true || o.value === null || typeof o.value !== 'object')
                    continue;
                const v = o.value;
                if (v.verdict !== 'confirmed' && v.verdict !== 'refuted')
                    continue; // 垃圾载荷不入票池
                votes.push({ id: o.result.id, verdict: v.verdict, confidence: confOr(v.confidence) });
            }
            const confirmed = votes.filter(v => v.verdict === 'confirmed');
            const refuted = votes.filter(v => v.verdict === 'refuted');
            const mean = (vs) => vs.length > 0 ? vs.reduce((s, v) => s + v.confidence, 0) / vs.length : 0;
            if (confirmed.length > refuted.length) {
                return {
                    verdict: 'confirmed',
                    confidence: votes.length > 0 ? mean(confirmed) * (confirmed.length / votes.length) : 0,
                    dissents: refuted.map(v => `${v.id}:${v.verdict}`),
                    members,
                };
            }
            if (refuted.length > confirmed.length) {
                return {
                    verdict: 'refuted',
                    confidence: votes.length > 0 ? mean(refuted) * (refuted.length / votes.length) : 0,
                    dissents: confirmed.map(v => `${v.id}:${v.verdict}`),
                    members,
                };
            }
            // 平票（含 0:0 全垃圾/全失败）⇒ uncertain —— 已投有效票票票皆异议
            return {
                verdict: 'uncertain',
                confidence: 0,
                dissents: votes.map(v => `${v.id}:${v.verdict}`),
                members,
            };
        }
        catch {
            return { verdict: 'uncertain', confidence: 0, dissents: [], members: [] };
        }
    }
    /**
     * 元素合议 —— askElements 融合律：
     *
     *  1. 全部 configured 庭员并行 chatJson（缺省注入接地系统词；question 有值
     *     时以「聚焦问题」附注进 prompt），各家载荷 {elements:[...]}；
     *  2. 逐家规整（normalizeElements）：bbox 数组/对象双形态转对象、label/role
     *     兜底截断、confidence 夹 [0,1] 缺省 0.5 —— 不做 clamp / NMS（配对权
     *     归仲裁器）；规整后为空的家不参与融合（零证据不占席）；
     *  3. 全量喂 arbitrateElements 两两融合（vlm 源语义）：座次序累进折叠 ——
     *     累积席为左（vlm 侧）、下一家为右（local 侧），IoU ≥ 0.5 配对成
     *     置信度加权凸组合融合框，单源元素原样直通（数学定义点全在 arbitration.ts）；
     *  4. fusedFrom = 实际贡献了非空元素集的庭员数（1 = 单家直通无仲裁；
     *     0 = 无任何家给出元素 ⇒ elements 恒 []）。
     *
     * 绝不抛异常：任何内部故障收敛为 { elements:[], fusedFrom:0 }。
     */
    async askElements(req) {
        try {
            const system = req?.system !== undefined && req.system !== '' ? req.system : ELEMENTS_SYSTEM;
            const basePrompt = typeof req?.prompt === 'string' ? req.prompt : '';
            const prompt = typeof req?.question === 'string' && req.question.trim() !== ''
                ? `${basePrompt}\n聚焦问题：${req.question.trim()}`
                : basePrompt;
            const outcomes = await this.askAll(req, true, system, prompt);
            const collections = [];
            for (const o of outcomes) {
                if (o.result.ok !== true)
                    continue;
                const payload = o.value !== null && typeof o.value === 'object' ? o.value : undefined;
                const els = normalizeElements(payload?.elements);
                if (els.length > 0)
                    collections.push(els);
            }
            if (collections.length === 0)
                return { elements: [], fusedFrom: 0 };
            let acc = collections[0];
            for (let i = 1; i < collections.length; i++) {
                acc = fusePair(acc, collections[i]);
            }
            return { elements: acc, fusedFrom: collections.length };
        }
        catch {
            return { elements: [], fusedFrom: 0 };
        }
    }
}
// ─── 铸造厂：createEnsembleCourt ───
/** 按预设协议选厂铸造 —— openai/anthropic/gemini 三兄弟适配器的分派点 */
function castProvider(preset, apiKey, baseUrl, model, fetchImpl) {
    const config = {
        id: preset.id,
        apiKey,
        baseUrl,
        model,
        ...(fetchImpl ? { fetchImpl } : {}),
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
 * 铸造云脑合议庭（铸造律）：
 *  1. 主力平台经 resolveProviderConfig（failover 池语义包装：只认显式
 *     provider id）解析 —— null（平台未给/查无预设）⇒ 主力席位空缺，
 *     extraProviders 续铸（庭不因主力缺席而解散）；主力即便没解析到密钥也
 *     照常入席（configured:false —— askAll 普查记账，诚实降级不静默丢脑）；
 *  2. 每个 extraProvider id 同经 resolveProviderConfig 的 getPreset + env
 *     解析：查无预设跳过；与先到者同 id 去重；解析不出 key 且预设非
 *     localAuthOptional 本机免钥（isLocalBaseUrl）⇒ 跳过不占席
 *     （半配置的席只会白记一笔降级，凑不成作证对）；
 *  3. 按预设 protocol 分派三兄弟适配器，fetchImpl 全员透传（离线可测）；
 *  4. <2 家也如实构造 —— 单家庭 askText 走 'degraded' 单家直通（见融合律），
 *     决不静默补脑、决不抛异常（铸造面故障收敛为空庭）。
 */
export function createEnsembleCourt(opts) {
    try {
        const o = opts ?? {};
        const providers = [];
        const seen = new Set();
        // 主力：显式平台解析（null ⇒ 空席位，extra 续铸）
        const primary = resolveProviderConfig({ provider: o.provider });
        if (primary !== null) {
            seen.add(primary.preset.id);
            providers.push(castProvider(primary.preset, primary.apiKey, primary.baseUrl, primary.model, o.fetchImpl));
        }
        // 备选：getPreset + env 自解析；无 key 且非本机免钥跳过；同 id 去重
        const extras = Array.isArray(o.extraProviders) ? o.extraProviders : [];
        for (const raw of extras) {
            const platform = typeof raw === 'string' ? raw : String(raw ?? '');
            const r = resolveProviderConfig({ provider: platform });
            if (r === null)
                continue; // 查无预设
            if (seen.has(r.preset.id))
                continue; // 主力或先到的同 id 去重
            seen.add(r.preset.id);
            const localFree = r.preset.localAuthOptional === true && isLocalBaseUrl(r.baseUrl);
            if (r.apiKey === '' && !localFree)
                continue; // 无钥且非本机免钥 —— 不占席
            providers.push(castProvider(r.preset, r.apiKey, r.baseUrl, r.model, o.fetchImpl));
        }
        return new EnsembleCourt(providers);
    }
    catch {
        // 铸造面意外故障 —— 空庭兜底（绝不抛）
        return new EnsembleCourt([]);
    }
}
