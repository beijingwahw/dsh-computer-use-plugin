// src/autonomy/sceneSemantics.ts
// 纪元 Φ（Φ-6 场景语义理解中枢）：VLM 读屏认场景，按 dhash 指纹缓存 —— 同屏不问第二遍。
//
// 存在理由：自主智能环的决策层每一步都在问同一个开放语义问题 ——「这是什么场景、
// 现在能做什么」。OCR 给字、接地给框，唯独「场景」需要整屏理解（GLM 云脑）。
// 但屏幕静止时反复问同一个问题是云脑预算的浪费：dhash 指纹相同的屏（汉明距离
// ≤ 容差）语义必相同 —— 本器官以此为钥做读屏缓存：
//   · 命中律：存在缓存条目 dhash 距离 ≤ 容差 且未过期 且 question 相同（或两者
//     皆空）⇒ 直接回读（零 VLM、零编码）。
//   · 未命中律：encodeForVlm → client.chat（中文 system 模板：看图输出
//     {sceneLabel,appGuess,pageState,affordances[],confidence}，克制不臆造；
//     question 非空时附带回答）→ 校验（affordances 去空串截 8 条、confidence
//     夹 [0,1]、字符串兜底）→ 入缓存（容量 16，LRU 新条目挤最旧）。
//   · 降级律：未配置 client 且 isGlmConfigured()=false ⇒ 零网络降级
//     （reading:null + degraded:true）；VLM 失败 ⇒ degraded + error 且不缓存
//     失败（下次同屏仍可重拨）。缓存条目存 {reading, question, at}。
// 纪律：具名导出、无 default、零新增依赖、时间可注入（now）、对一切脏输入绝不抛异常。
import { extractGlmJson, getGlmClient, isGlmConfigured, } from '../vlm/glmClient.js';
import { encodeForVlm } from '../vlm/codec.js';
/** 缓存有效期缺省（毫秒）：同指纹自写入起 30s 内免重问 */
const DEFAULT_TTL_MS = 30000;
/** dhash 汉明容差缺省：距离 ≤ 3 视为同一屏（光标/时钟级微变不换场景） */
const DEFAULT_HAMMING_TOLERANCE = 3;
/** 缓存容量上限：超出挤最旧（LRU）—— 一屏一语义，16 条覆盖滚动窗口内的场景集 */
const MAX_CACHE_ENTRIES = 16;
/** affordances 截断上限：操作清单入决策上下文的带宽礼仪 */
const MAX_AFFORDANCES = 8;
/** 汉明距离哨兵值：不可比（长度不等/空串/非十六进制字符）时的返回值 */
const UNCOMPARABLE_DISTANCE = 9999;
/** 半字节 popcount 表（0..15 的置位数）：按 nibble 异或的查表核 */
const NIBBLE_POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
/** 十六进制字符 → 数值（大小写归一）；查无此字符记 undefined（调用方按不可比处理） */
const HEX_VALUE = (() => {
    const map = {};
    for (let i = 0; i < 10; i++)
        map[String(i)] = i;
    for (let i = 0; i < 6; i++)
        map[String.fromCharCode(97 + i)] = 10 + i; // a..f → 10..15
    return map;
})();
/**
 * 等长十六进制串的汉明距离（纯函数）：逐字符转 nibble 后异或 popcount 累加，
 * 大小写不敏感。长度不等、任一侧非字符串/空串/含非十六进制字符 ⇒ 返回 9999
 * （哨兵值而非 Infinity —— number 的可序列化可比性优先，调用方以 > 容差判不可比）。
 */
export function hammingDistanceHex(a, b) {
    try {
        if (typeof a !== 'string' || typeof b !== 'string')
            return UNCOMPARABLE_DISTANCE;
        const x = a.trim().toLowerCase();
        const y = b.trim().toLowerCase();
        if (!x || !y || x.length !== y.length)
            return UNCOMPARABLE_DISTANCE;
        let dist = 0;
        for (let i = 0; i < x.length; i++) {
            const va = HEX_VALUE[x[i]];
            const vb = HEX_VALUE[y[i]];
            if (va === undefined || vb === undefined)
                return UNCOMPARABLE_DISTANCE;
            dist += NIBBLE_POPCOUNT[va ^ vb];
        }
        return dist;
    }
    catch {
        return UNCOMPARABLE_DISTANCE;
    }
}
/** 宽松转数 —— 数字字符串也收（模型方言防御）；非法/NaN 返回 null */
function toFiniteNumber(v) {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
}
/** 字符串卫兵：非空字符串去首尾空白返回；否则给兜底值（模型方言不炸管线） */
function cleanString(v, fallback) {
    return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}
/**
 * 模型负载消毒 —— 只取五字段契约：
 * sceneLabel/pageState 非法 ⇒ ''、appGuess 非法 ⇒ '未知'、affordances 去空串
 * 弃非串截 8 条、confidence 夹 [0,1]（缺失/NaN 压 0）。多余字段（如 question
 * 应答的 answer）静默丢弃 —— 契约之外的内容不透传。
 */
function sanitizeReading(payload, dhash, takenAt) {
    const rawAffordances = payload.affordances;
    const affordances = Array.isArray(rawAffordances)
        ? rawAffordances
            .filter((x) => typeof x === 'string')
            .map(x => x.trim())
            .filter(x => x.length > 0)
            .slice(0, MAX_AFFORDANCES)
        : [];
    const c = toFiniteNumber(payload.confidence);
    return {
        sceneLabel: cleanString(payload.sceneLabel, ''),
        appGuess: cleanString(payload.appGuess, '未知'),
        pageState: cleanString(payload.pageState, ''),
        affordances,
        confidence: c === null ? 0 : Math.min(Math.max(c, 0), 1),
        takenAt,
        dhash,
    };
}
/** 中文 system 模板（固定）：整屏场景理解铁律 —— 只看图、克制不臆造、只出 JSON */
function buildSceneSystemPrompt() {
    return [
        '你是桌面自动化系统的场景语义理解中枢，任务是对一张屏幕截图做整屏场景理解。',
        '只依据截图本身作答，克制不臆造：看不清的内容降低置信度，认不出的应用就写「未知」。',
        '请只输出一个 JSON 对象（不要任何多余文字）：',
        '{',
        '  "sceneLabel": "场景一句话描述，如「浏览器购物车页」「IDE 代码编辑中」",',
        '  "appGuess": "应用猜测短语，如「浏览器」「IDE」「终端」「办公软件」「聊天客户端」「未知」",',
        '  "pageState": "页面状态短语，如「就绪」「加载中」「弹窗阻挡」「登录墙」「空白」",',
        '  "affordances": ["当前屏幕上可执行的操作，中文短语，至多 8 条，如「点击结算按钮」「关闭弹窗」"],',
        '  "confidence": "0.0 到 1.0 的数值置信度"',
        '}',
    ].join('\n');
}
/** 用户提示词：无问时只请求读屏；有问时附带 question 并要求在 JSON 的 answer 字段作答 */
function buildSceneUserPrompt(question) {
    return question
        ? `请读屏并按系统约定输出 JSON，同时回答附加问题：${question}\n（在 JSON 中追加 "answer" 字段承载回答，同样克制，不确定就明说。）`
        : '请读屏并按系统约定输出 JSON。';
}
/**
 * 场景语义缓存器官 —— VLM 读屏 + dhash 指纹缓存（同屏不问第二遍）。
 *
 * 缓存键为「dhash + question」组合键（同屏异问各自成条、互不挤占）；命中判定
 * 扫全部条目取「距离 ≤ 容差 且 未过期 且 question 相同（或两者皆空）」中最
 * 近写入者。容量 16 真 LRU：命中即触碰挪到队尾，写入超容挤队首（最久未用）。
 * 过期条目在扫描时懒清除（TTL 自写入计时，命中不续期 —— 陈旧语义宁可重问）。
 *
 * 铁律：read() 绝不抛异常（一切失败以 degraded:true + error 返回）；未配置
 * client 且 isGlmConfigured()=false 时零网络零编码直接降级；VLM 失败不入缓存。
 */
export class SceneSemanticsCache {
    ttlMs;
    hammingTolerance;
    injectedClient;
    now;
    cache = new Map();
    hits = 0;
    misses = 0;
    vlmCalls = 0;
    /** 一切可注入：ttl（缺省 30000）、汉明容差（缺省 3）、client（缺省走全局配置）、时钟（缺省 Date.now） */
    constructor(opts) {
        const ttl = opts?.ttlMs;
        this.ttlMs = typeof ttl === 'number' && Number.isFinite(ttl) && ttl >= 0 ? ttl : DEFAULT_TTL_MS;
        const tol = opts?.hammingTolerance;
        this.hammingTolerance =
            typeof tol === 'number' && Number.isFinite(tol) && tol >= 0 ? tol : DEFAULT_HAMMING_TOLERANCE;
        this.injectedClient = opts?.client;
        const nowFn = opts?.now;
        this.now = typeof nowFn === 'function' ? nowFn : () => Date.now();
    }
    /** 缓存命中查找：距离 ≤ 容差 且 未过期 且 question 相同（空串与缺席同为 ''，天然「两者皆空」）。
     *  命中条目 LRU 触碰挪队尾；过期条目顺手懒清。返回命中条目的 reading（未命中 null）。 */
    lookup(fingerprint, question) {
        const nowMs = this.now();
        let best = null;
        const expiredKeys = [];
        for (const [key, entry] of this.cache) {
            if (nowMs - entry.at >= this.ttlMs) {
                expiredKeys.push(key);
                continue;
            }
            if (entry.question !== question)
                continue;
            if (hammingDistanceHex(fingerprint, entry.reading.dhash) > this.hammingTolerance)
                continue;
            if (!best || entry.at >= best.entry.at)
                best = { key, entry };
        }
        for (const k of expiredKeys)
            this.cache.delete(k);
        if (!best)
            return null;
        this.cache.delete(best.key);
        this.cache.set(best.key, best.entry);
        return best.entry.reading;
    }
    /** 入缓存（容量 16 LRU）：组合键去重后写队尾，超容挤队首（最久未使用） */
    store(fingerprint, question, reading) {
        const key = `${fingerprint}\u0000${question}`;
        this.cache.delete(key);
        this.cache.set(key, { reading, question, at: this.now() });
        while (this.cache.size > MAX_CACHE_ENTRIES) {
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined)
                break;
            this.cache.delete(oldest);
        }
    }
    /**
     * 读屏认场景 —— 绝不抛异常。
     *
     * 1) 云脑可用性：注入 client 优先，否则全局配置探测 —— 未配置且未注入 ⇒
     *    { reading:null, degraded:true }（零网络、零编码、零缓存动作）。
     * 2) 缓存命中（dhash 距离 ≤ 容差 且未过期 且 question 相同或两者皆空）⇒
     *    cached:true 直接回读（零 VLM）。
     * 3) 未命中 ⇒ encodeForVlm → client.chat（中文 system 模板 + question 附问）
     *    → 健壮 JSON 提取（剥围栏）→ 五字段消毒 → 入缓存 → 返回。
     *    VLM 失败 / JSON 提取失败 ⇒ degraded:true + error，不缓存失败。
     * 4) dhash 非法（非字符串/空白）时仍可读屏，但不查也不写缓存（无键可依）。
     */
    async read(image, dhash, question) {
        try {
            const q = typeof question === 'string' ? question.trim() : '';
            const fingerprint = typeof dhash === 'string' ? dhash.trim() : '';
            // 1) 云脑可用性：未配置且未注入 ⇒ 零网络降级（缓存不咨询 —— 器官缺席即诚实降级）
            let client = this.injectedClient;
            if (!client) {
                if (!isGlmConfigured()) {
                    return {
                        reading: null,
                        degraded: true,
                        cached: false,
                        error: 'scene semantics unavailable: glm api key not configured and no client injected',
                    };
                }
                client = getGlmClient();
            }
            // 2) 缓存命中：同屏（距离 ≤ 容差）且未过期且同问 ⇒ 直接回读（零 VLM、零编码）
            const hit = fingerprint ? this.lookup(fingerprint, q) : null;
            if (hit) {
                this.hits++;
                return { reading: hit, degraded: false, cached: true };
            }
            this.misses++;
            // 3) 编码 → 对话 → 提取 → 消毒 → 入缓存
            if (!Buffer.isBuffer(image) || image.length === 0) {
                return {
                    reading: null,
                    degraded: true,
                    cached: false,
                    error: 'scene semantics unavailable: empty image buffer',
                };
            }
            const enc = await encodeForVlm(image);
            if (!enc.ok || !enc.value) {
                return {
                    reading: null,
                    degraded: true,
                    cached: false,
                    error: `scene semantics encode failed: ${enc.error ?? 'unknown codec error'}`,
                };
            }
            const imageInput = { base64: enc.value.base64, mime: enc.value.mime };
            this.vlmCalls++; // 记拨号（含随后失败的尝试 —— 预算记账按尝试算）
            const resp = await client.chat({
                images: [imageInput],
                system: buildSceneSystemPrompt(),
                prompt: buildSceneUserPrompt(q),
                jsonMode: true,
            });
            if (!resp.ok) {
                return {
                    reading: null,
                    degraded: true,
                    cached: false,
                    error: `scene semantics chat failed: ${resp.error ?? 'unknown glm error'}`,
                };
            }
            const payload = extractGlmJson(resp.text);
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
                return {
                    reading: null,
                    degraded: true,
                    cached: false,
                    error: `scene semantics json extraction failed: no balanced JSON object in reply (${resp.text.length} chars)`,
                };
            }
            const reading = sanitizeReading(payload, fingerprint, this.now());
            if (fingerprint)
                this.store(fingerprint, q, reading);
            return { reading, degraded: false, cached: false };
        }
        catch (e) {
            // 理论不可达（各步自兜底）—— 最后防线：异常转降级返回，绝不越狱上抛
            const msg = e instanceof Error ? e.message : String(e);
            return {
                reading: null,
                degraded: true,
                cached: false,
                error: `scene semantics crashed: ${msg.slice(0, 240)}`,
            };
        }
    }
    /** 清空缓存条目（命中/未命中/拨号计数是器官级遥测，保留不归零） */
    invalidate() {
        this.cache.clear();
    }
    /** 观测快照：当前条目数 / 缓存命中 / 未命中 / VLM 拨号次数（含失败的尝试） */
    stats() {
        return {
            entries: this.cache.size,
            hits: this.hits,
            misses: this.misses,
            vlmCalls: this.vlmCalls,
        };
    }
}
