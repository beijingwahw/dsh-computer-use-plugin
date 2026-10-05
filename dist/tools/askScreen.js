// src/tools/askScreen.ts
// 纪元 Ω（云脑皮层工具面）：ask_screen —— 自由视觉问答。
// 纯视觉架构的「云脑」对模型本人开放：截当前干净屏（无 SoM 网格/准星叠加 ——
// 问的是世界本身，不是导航辅助层）+ 自然语言问题 → GLM-5.3-Flash 看屏作答。
// 分工：本地反射弧（OCR/模糊/探针，毫秒级）回答确定性事实；开放语义
// （整屏理解 / 状态推断 / 图文混读 / 未见过的界面形态）走本工具（秒级）。
// 铁律：锚点一律走 toolResult 工厂；未配置/失败诚实 toolErr —— 绝不抛、绝不伪造答案。
import { defineTool } from '@deepseek-ai/dsh-tools';
import * as backend from '../physicalBackend.js';
import { normalizeHash, dhash, hammingDistance } from '../perceptualHash.js';
import { contextManager } from '../contextManager.js';
import { toolOk, toolErr } from '../toolResult.js';
import { getGlmClient, isGlmConfigured } from '../vlm/glmClient.js';
import { encodeForVlm } from '../vlm/codec.js';
import { kernelRegistry } from '../kernel/registry.js';
// ─── R5-4（视觉外包经济面）：同屏语义回放 + 视觉摘要缓存 ───
//
// 架构事实（R4-2 D4）：宿主规划脑 glm-5.3 为纯文本，ask_screen 是唯一眼睛；
// 批1/批2 证据包 59 次 ask_screen 中验证类占 ~53%，且 diff_view/read_text/
// find_text 全批 0 次调用 —— 唯一眼睛被当成了唯一验证通道。两面降本：
//
//   ① 语义回放（b）：同屏（dhash 汉明 0）+ 同问 + 同脑 ⇒ 30s 窗内直接回放
//      答案，零编码零拨号。键律与 ΝΩ-48 grounding 缓存同源（dhash/client/
//      question 都是输出语义的输入，缺一不可回放）；开关走内核键
//      `ask.semanticCache`（productionSpecs 入册，缺省 0=关 —— 与 ΝΩ-48
//      「W5-4⑧ 同输入双调必须两次真实进 VLM」契约的零回归铁律同款，
//      开关权交宿主）。
//   ② 视觉摘要缓存（a）：每次成功 ask 后登记单槽摘要（dhash+问+答+时刻）；
//      take_screenshot 回执按指纹近似（汉明 ≤ stableScreenDistance，与变化
//      门同阈）捎带该摘要 —— 纯文本宿主读回执即知「同屏不重问」。咨询性
//      提示（120s 新鲜窗），不做网络层拦截，故不加开关（纯加法回执面）。
/** R5-4: 语义回放窗口（与 ΝΩ-48 grounding 缓存同窗 30s） */
const ASK_CACHE_TTL_MS = 30_000;
/** R5-4: 回放缓存 LRU 容量封顶（防 Map 无界泄漏） */
const ASK_CACHE_CAP = 32;
/** R5-4: 回执摘要新鲜窗（咨询性提示，宽于回放窗 —— 答案 stale 得比回放慢） */
const ASK_SUMMARY_FRESH_MS = 120_000;
/** R5-4: 回执携带的问题/答案摘要截断（Token 纪律：状态锚点不是全文转录） */
const ASK_SUMMARY_Q_MAX = 120;
const ASK_SUMMARY_A_MAX = 300;
const askCache = new Map();
let lastAskSummary = null;
/** R5-4: 墙钟缝（生产恒 Date.now —— TTL 判定唯一时源；测试注入见 _override） */
let askClock = Date.now;
/** R5-4: client 身份证 —— WeakMap 发号（同 ΝΩ-48：缓存不跨腔回放） */
const askClientIds = new WeakMap();
let askClientSeq = 0;
function askCacheClientId(client) {
    let id = askClientIds.get(client);
    if (id === undefined) {
        askClientSeq += 1;
        id = askClientSeq;
        askClientIds.set(client, id);
    }
    return id;
}
/** R5-4: dhash 安全包装 —— 任何失败（sharp 缺席/非图字节/解码异常）返回 null（缓存失能，增益不是依赖） */
async function dhashSafe(buffer) {
    try {
        const h = await dhash(buffer);
        return typeof h === 'string' && h.length > 0 ? h : null;
    }
    catch {
        return null;
    }
}
/** R5-4: 铸回放缓存键 —— dhash + client 身份 + question（缺一即语义变，不可回放） */
function buildAskCacheKey(screenHash, question, client) {
    return `h=${screenHash}|c=${askCacheClientId(client)}|q=${question}`;
}
/** R5-4: 查回放缓存 —— TTL 内命中 ⇒ LRU 刷新回放；过期诚实逐出回源。零异常。 */
function lookupAskCache(key) {
    const hit = askCache.get(key);
    if (!hit)
        return null;
    if (askClock() - hit.at > ASK_CACHE_TTL_MS) {
        askCache.delete(key);
        return null;
    }
    askCache.delete(key);
    askCache.set(key, hit); // LRU 刷新：插入序 = 最近使用序
    return hit;
}
/** R5-4: 回填回放缓存 —— 仅成功答案；容量封顶 LRU 逐出。零异常。 */
function storeAskCache(key, entry) {
    try {
        if (askCache.size >= ASK_CACHE_CAP) {
            const oldest = askCache.keys().next().value;
            if (oldest !== undefined)
                askCache.delete(oldest);
        }
        askCache.set(key, entry);
    }
    catch { /* 理论不可达 —— 安静放弃缓存 */ }
}
/**
 * R5-4（a · 视觉摘要缓存的读面）：给定当前屏指纹，若与最近一次成功 ask_screen
 * 的问屏指纹近似（汉明距离 ≤ maxDistance —— 与 take_screenshot 变化门同阈，
 * 跨 clean/overlaid 域的既有容差先例 = ΝΩ-31 复用闸）且在新鲜窗内，返回该
 * 问答摘要（take_screenshot 回执捎带给纯文本宿主：同屏不重问）。
 * 任何不匹配/过期/无记录 ⇒ null。纯读，零副作用。
 */
export function peekAskSummary(screenHash, maxDistance, maxAgeMs = ASK_SUMMARY_FRESH_MS) {
    if (!lastAskSummary)
        return null;
    const age = askClock() - lastAskSummary.at;
    if (!(age >= 0) || age > maxAgeMs)
        return null;
    const a = normalizeHash(lastAskSummary.dhash);
    const b = normalizeHash(screenHash);
    if (b.length !== 64 || /^0+$/.test(b))
        return null; // 脏指纹/全零哨兵 ⇒ 无证据不提示（零误报优先）
    if (hammingDistance(a, b) > Math.max(0, maxDistance))
        return null;
    return {
        question: lastAskSummary.question.slice(0, ASK_SUMMARY_Q_MAX),
        answer: lastAskSummary.answer.slice(0, ASK_SUMMARY_A_MAX),
        age_ms: age,
    };
}
/** R5-4: 测试注入口 —— 回放缓存 + 摘要单槽清零 */
export function _resetAskCache_forTest() {
    askCache.clear();
    lastAskSummary = null;
}
/** R5-4: 测试注入口 —— 覆写墙钟（null = 复位 Date.now） */
export function _overrideAskClock_forTest(clock) {
    askClock = clock ?? Date.now;
}
/** 回答字符预算（Token 纪律：问答是状态锚点，不是整屏转录） */
const ANSWER_MAX_CHARS = 1500;
/** 问题字符预算（防超长注入烧 Token） */
const QUESTION_MAX_CHARS = 500;
/** 云脑角色设定：看屏作答的诚实描述员 —— 只描述所见，不猜屏外，不编事实 */
const ASK_SYSTEM_PROMPT = '你是屏幕观察员。用户给出一张当前屏幕截图和一个问题，请只依据截图中的可见内容作答：' +
    '简洁、直接、事实优先；引用屏幕上的原文时保持原文。截图之外的信息不要臆测；' +
    '看不清/不确定时如实说明。用提问所用的语言回答。';
/** 64 位 dhash 的 hex 表示长度（perceptualHash 单源方言）。 */
const DHASH_HEX_LENGTH = 16;
/** ΝΩ-31：位串 → hex（backend gate 比对域；已是 hex 透传，坏值回空串跳闸）。 */
function hashBitsToHex(h) {
    const bits = normalizeHash(h);
    if (/^[01]+$/.test(bits)) {
        try {
            return BigInt(`0b${bits}`).toString(16).padStart(DHASH_HEX_LENGTH, '0');
        }
        catch {
            return '';
        }
    }
    return /^[0-9a-f]+$/i.test(bits) && bits.length === DHASH_HEX_LENGTH ? bits : ''; // ΝΩ 收官：dhash 恒 64bit=16 hex（perceptualHash 方言）
}
/** ΝΩ-31：缺省复用闸 —— 窗口内最新截图指纹 vs 当前屏（metaOnly 探针，零图像字节）。
 *  探针任何失败 ⇒ null（诚实退回全新截屏，绝不以缓存冒充新鲜）。 */
function defaultReuseGate(config) {
    return async () => {
        // config.stableScreenDistance 缺席（残缺 config / 测试注入 {}）⇒ 门控不武装
        if (typeof config.stableScreenDistance !== 'number')
            return null;
        const last = contextManager.lastImageRecord();
        if (!last?.hash || !last.base64)
            return null;
        const ref = hashBitsToHex(last.hash);
        if (!ref)
            return null;
        try {
            const probe = await backend.captureProcessed({
                metaOnly: true,
                wantHashes: true,
                gate: { dhashRef: ref, distance: config.stableScreenDistance },
            });
            if (probe?.unchanged) {
                const bare = last.base64.replace(/^data:[^;]+;base64,/, '');
                const buffer = Buffer.from(bare, 'base64');
                if (buffer.length > 0)
                    return { unchanged: true, buffer, sourceId: last.id };
            }
        }
        catch {
            return null; // 探针故障 = 无证据（诚实全新截屏）
        }
        return { unchanged: false };
    };
}
export function createAskScreenTool(_config, deps = {}) {
    return defineTool({
        name: 'ask_screen',
        description: 'Ask the GLM vision model a free-form question about the CURRENT screen (captured fresh, without overlays). ' +
            'Use it when local tools are not enough: overall page state, purpose of unfamiliar UI, mixed text-and-image ' +
            'content, or anything requiring open semantic understanding. Read-only — it never touches the world. ' +
            'For precise text coordinates use find_text; for plain text extraction use read_text. ' +
            // R5-4（c · 验证经济）：批1/批2 证据 —— 59 次 ask 中验证类 ~53%，而
            // diff_view/read_text/find_text 全批 0 次。描述层立「确定性优先」门：
            // 动作后验证先走本地免费通道，本工具只留给语义判断。
            'VERIFICATION ECONOMY: this is the most expensive observation channel (a VLM round trip). ' +
            'For post-action verification prefer, in order: diff_view (did the screen change, and where), ' +
            'read_text / find_text (exact on-screen text or keyword presence), and the effect/state_anchor fields ' +
            'already present in action receipts (effect.detected). Reserve ask_screen for questions only semantic ' +
            'vision can answer (which control is focused, what an unfamiliar UI means, caret position).',
        parameters: {
            question: {
                type: 'string', required: true,
                description: 'The question about the current screen, in any language, e.g. "哪个输入框当前获得焦点？" ' +
                    'or "Is this a login page and is any form field filled?"',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            const question = typeof args.question === 'string' ? args.question.trim().slice(0, QUESTION_MAX_CHARS) : '';
            if (!question) {
                return toolErr('ask_screen validation failed.', 'Empty question argument.', 'Ask a concrete question about the visible screen, e.g. "What dialog is currently open?"');
            }
            // 配置哨兵：未注入 client 且云脑未配置 ⇒ 零截屏零网络诚实降级（无 Key 用户不伪答）
            if (!deps.client && !isGlmConfigured()) {
                return toolErr('ask_screen unavailable.', 'VLM not configured (set vlmApiKey in config, or GLM_API_KEY / ZHIPUAI_API_KEY / ZAI_API_KEY in env).', 
                // 纪元 Λ：无模型时给模型指路 —— vlm_wizard 是零门槛出口（用户页面上贴一次密钥即亮）
                'Use take_screenshot and your own vision, or read_text / find_text for text-level sensing — ' +
                    'or call vlm_wizard to open the connection wizard so the user can connect a vision model.');
            }
            try {
                const capture = deps.capture ?? (() => backend.captureCleanPng());
                // ΝΩ-31（unchanged 门控）：先问复用闸 —— 屏幕与窗口内最新截图同指纹 ⇒
                // 复用缓存帧引用（零新截屏），与 take_screenshot 的变化门同律协同。
                let reusedFrom = null;
                let buffer = null;
                const gate = deps.reuseGate ?? defaultReuseGate(_config);
                try {
                    const verdict = await gate();
                    if (verdict?.unchanged && Buffer.isBuffer(verdict.buffer) && verdict.buffer.length > 0) {
                        buffer = verdict.buffer;
                        reusedFrom = typeof verdict.sourceId === 'number' ? verdict.sourceId : null;
                    }
                }
                catch { /* 门控故障 = 诚实全新截屏 */ }
                if (buffer === null) {
                    buffer = await capture();
                }
                if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
                    return toolErr('ask_screen failed.', 'Screen capture returned an empty buffer.', 'The capture pipeline may be unavailable — try take_screenshot to check the vision channel.');
                }
                // ── R5-4（b · 同屏语义回放）：开关走内核键 ask.semanticCache（缺省 0=关，
                // 未注册回声同值 = 零行为变化）。键 = dhash + client 身份 + question ——
                // 与 ΝΩ-48 同律：三分量任一变则语义变，不可回放。命中 ⇒ 零编码零拨号。 ──
                const client = deps.client ?? getGlmClient();
                const cacheWanted = kernelRegistry.getOrDefault('ask.semanticCache', 0) > 0.5;
                // R5-4: dhash 恒算（摘要登记不受回放开关调制——纯回执加法面；sharp 缺席 ⇒ null 安静失能）
                const screenHash = await dhashSafe(buffer);
                const cacheKey = cacheWanted && screenHash ? buildAskCacheKey(screenHash, question, client) : null;
                const replay = cacheKey ? lookupAskCache(cacheKey) : null;
                if (replay) {
                    // 回放也刷新摘要单槽（take_screenshot 的同屏提示以最近一次问答为准）
                    lastAskSummary = { dhash: screenHash, question, answer: replay.answer, at: askClock() };
                    return toolOk(`ask_screen: "${question.slice(0, 80)}" answered by ${replay.model}.`, {
                        answer: replay.answer,
                        latency_ms: 0,
                        model: replay.model,
                        // R5-4: 回放标记 —— 网络面零拨号，宿主计量可据此分桶（verify 去重命中面）
                        answer_source: `semantic-cache-hit (screen fingerprint + question identical within ${Math.round(ASK_CACHE_TTL_MS / 1000)}s — no VLM call was made)`,
                        ...(reusedFrom !== null
                            ? { frame_source: `reused cached screenshot #${reusedFrom} (screen unchanged since capture)` }
                            : { frame_source: 'fresh capture' }),
                    }, 'The answer describes the screen AT CAPTURE TIME — it may be stale now. ' +
                        'Before acting on it, ground coordinates yourself: take_screenshot (visual grounding) or find_text; ' +
                        'ask_screen is read-only and never justifies clicking guessed coordinates.');
                }
                const enc = await encodeForVlm(buffer);
                if (!enc.ok || !enc.value) {
                    return toolErr('ask_screen failed.', enc.error ?? 'screenshot encoding failed', 
                    // R4-3（b6，证据：R1-8 九跑 ask_screen 失败回执的降级建议 7 次出现
                    // 0 次执行 read_text/find_text）：「fall back to 工具清单」不是可执行
                    // 指令。改为逐步命令 + 熔断（不再重试 ask_screen）。
                    'Retry ask_screen ONCE. If it fails again, switch tools for good: call take_screenshot and read the screen ' +
                        'yourself; for text or coordinates call read_text (on-screen text) or find_text with your exact keyword ' +
                        '(returns clickable coordinates). Do not keep retrying ask_screen.');
                }
                const res = await client.chat({
                    images: [{ base64: enc.value.base64, mime: enc.value.mime }],
                    system: ASK_SYSTEM_PROMPT,
                    prompt: question,
                    temperature: 0.2, // 读屏问答要忠实，不要发散
                    maxTokens: 1024,
                });
                if (!res.ok) {
                    return toolErr('ask_screen failed.', res.error ?? 'unknown VLM error', 
                    // R4-3（b6，证据：R1-8 a2-a9 ask_screen 429 后建议 fall back to
                    // read_text / find_text 共 7 次，0 次被执行 —— 模型对文字通道有
                    // 系统性盲区）：降级建议必须是可直接执行的指令，点名参数形状。
                    'The cloud cortex did not answer. Do this NOW instead of retrying: 1) call take_screenshot and read the ' +
                        'screen yourself; 2) if you need on-screen text call read_text, or call find_text with your exact keyword ' +
                        'to get clickable coordinates. ask_screen may be retried at most once, then abandoned.');
                }
                const answer = res.text.trim();
                if (!answer) {
                    return toolErr('ask_screen failed.', 'Vision model returned an empty answer.', 
                    // R4-3（b6）：同册可执行化 —— 空答案给出确定的替代动作而非开放选项。
                    'Rephrase the question more concretely and retry ONCE; if still empty, call take_screenshot and answer it ' +
                        'yourself from the image (read_text can extract the on-screen text for you).');
                }
                // ── R5-4：成功答案登记两面 ──
                // b · 回放缓存回填（开关开且指纹可得时；仅成功答案，失败不污染缓存）；
                // a · 摘要单槽刷新（无条件 —— take_screenshot 回执的同屏捎带面）。
                if (cacheKey)
                    storeAskCache(cacheKey, { answer, model: res.model, at: askClock() });
                if (screenHash)
                    lastAskSummary = { dhash: screenHash, question, answer, at: askClock() };
                return toolOk(`ask_screen: "${question.slice(0, 80)}" answered by ${res.model}.`, {
                    answer: answer.length > ANSWER_MAX_CHARS ? answer.slice(0, ANSWER_MAX_CHARS) + '...[truncated]' : answer,
                    latency_ms: res.latencyMs,
                    model: res.model,
                    // ΝΩ-31：帧供给通道透明化 —— 缓存帧复用（截图 #id，零新截屏）或全新截屏
                    ...(reusedFrom !== null
                        ? { frame_source: `reused cached screenshot #${reusedFrom} (screen unchanged since capture)` }
                        : { frame_source: 'fresh capture' }),
                }, 'The answer describes the screen AT CAPTURE TIME — it may be stale now. ' +
                    'Before acting on it, ground coordinates yourself: take_screenshot (visual grounding) or find_text; ' +
                    'ask_screen is read-only and never justifies clicking guessed coordinates.');
            }
            catch (error) {
                return toolErr('ask_screen failed.', error?.message ?? 'unknown error', 
                // R4-3（b6）：同册可执行化（catch 面与编码失败面同律）。
                'Capture or the VLM pipeline failed. Switch tools NOW: call take_screenshot to see the screen yourself; for ' +
                    'text or coordinates use read_text / find_text "<your keyword>" instead of retrying ask_screen.');
            }
        },
    });
}
