import { kernelRegistry } from '../kernel/registry.js';
import { scoreOptions, actionSignature } from './counterfactual.js';
import { CJK_RE, tokenizeText } from '../dialects/tokenizer.js';
import { extractQuotedSpans } from '../intentGrammar.js';
// ─── 常量 ───
/** 元素匹配置信门槛：最佳候选得分低于此值 ⇒ uncertain（请云脑或如实标注） */
export const MATCH_CONFIDENT = 0.55;
/** 候选并列判定：最佳与次佳得分差小于此值 ⇒ uncertain */
export const TIE_GAP = 0.05;
/** 云脑咨询的候选上限（提示词带宽礼仪） */
export const VLM_CANDIDATE_CAP = 8;
/** 预算红线：剩余步数 ≤2 或剩余毫秒 ≤15000 ⇒ 升级 */
export const BUDGET_STEPS_LOW = 2;
export const BUDGET_MS_LOW = 15_000;
/** 弹窗确认类元素判据（中文子串 + 英文整词，大小写/空白已折叠）。
 *  纪元 Δ 扫描面修正：补「确定/是/同意/yes」——只认 确认/ok/allow 时，四类
 *  高频确认按钮会反落 Esc 分支（Esc 对模态确认框常等于「取消」，语义相反）。 */
export const POPUP_CONFIRM_RE = /确认|确定|同意|允许|继续|是|\bok\b|\ballow\b|\byes\b/;
/** 破坏性词表（点击目标的词法预分类；英文按整词、中文按子串） */
const DESTRUCTIVE_ZH = ['删除', '卸载', '清空', '格式化', '重置', '抹掉'];
const DESTRUCTIVE_EN = ['delete', 'remove', 'uninstall', 'format', 'erase', 'destroy'];
/** 敏感词表（提交/外发/安装类动作；非破坏但需风险闸门留意） */
const SENSITIVE_ZH = ['发送', '提交', '支付', '购买', '下载', '上传', '安装', '保存'];
const SENSITIVE_EN = ['send', 'submit', 'pay', 'purchase', 'buy', 'download', 'upload', 'install', 'save'];
// ─── 纯函数工具（零副作用、零异常） ───
/** 空白折叠 + 小写化 —— 一切文本匹配的前置归一 */
export function normalizeWs(s) {
    return typeof s === 'string' ? s.toLowerCase().replace(/\s+/g, ' ').trim() : '';
}
/** 数值夹 [0,1]；非有限数按中性 0.5 记（与 grounding 的置信兜底同律） */
export function clamp01(v) {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : 0.5;
    return Math.min(1, Math.max(0, n));
}
/** 保留两位小数的得分（供 payload/rationale 展示，避免浮点尾噪） */
export function round2(v) {
    return Math.round(v * 100) / 100;
}
/**
 * 纯函数：提取目标关键词 —— goal + successCriteria 联合分词（中文 2-gram、
 * 英文单词），去停用词/纯数字，按首次出现序去重。
 * 故意不含 failureCriteria：失败判据关键词与成功判据混流会污染元素匹配。
 * 纪元 Δ 缓存律：结果按 GoalSpec 对象用 WeakMap 缓存 —— 调用方跨步复用同一
 * spec 对象时（正是常态）零重分词；spec 被回收则缓存随之释放（WeakMap 语义）。
 * 返回共享只读数组，调用方不得原地修改。
 */
const goalKeywordCache = new WeakMap();
export function extractGoalKeywords(spec) {
    const s = (spec ?? {});
    if (spec !== null && spec !== undefined && typeof spec === 'object') {
        const hit = goalKeywordCache.get(spec);
        if (hit)
            return hit;
    }
    const texts = [s.goal, ...(Array.isArray(s.successCriteria) ? s.successCriteria : [])];
    const out = [];
    const seen = new Set();
    for (const t of texts) {
        for (const tok of tokenizeText(t)) {
            if (!seen.has(tok)) {
                seen.add(tok);
                out.push(tok);
            }
        }
    }
    if (spec !== null && spec !== undefined && typeof spec === 'object') {
        goalKeywordCache.set(spec, out);
    }
    return out;
}
/**
 * 分词缓存（纪元 Δ 每步重复分词修律）：判据文本 / 元素标签 / 技能描述在步与步
 * 之间高度复用——同一字符串的 tokens 只算一次，后续命中直取。上限 1024 条，
 * 超限整体清空（快照词面滚动更新，旧键自然失热——简单有界，绝不无限膨胀）。
 * 返回共享只读数组，调用方不得原地修改（本模块内全部用途均为只读遍历）。
 */
const TOKEN_CACHE_MAX = 1024;
const tokenCache = new Map();
export function tokenizeCached(text) {
    if (typeof text !== 'string')
        return tokenizeText(text); // 非串（垃圾输入）走纯函数，不进缓存
    const hit = tokenCache.get(text);
    if (hit)
        return hit;
    const tokens = tokenizeText(text);
    if (tokenCache.size >= TOKEN_CACHE_MAX)
        tokenCache.clear();
    tokenCache.set(text, tokens);
    return tokens;
}
/** 点击目标的词法风险预分类（中文子串命中，英文整词命中；默认 benign） */
export function classifyClickRisk(label) {
    const s = normalizeWs(label);
    if (!s)
        return 'benign';
    if (DESTRUCTIVE_ZH.some(w => s.includes(w)))
        return 'destructive';
    if (DESTRUCTIVE_EN.some(w => new RegExp(`\\b${w}\\b`).test(s)))
        return 'destructive';
    if (SENSITIVE_ZH.some(w => s.includes(w)))
        return 'sensitive';
    if (SENSITIVE_EN.some(w => new RegExp(`\\b${w}\\b`).test(s)))
        return 'sensitive';
    return 'benign';
}
/** 文本摘要是否含某 token：中文子串直判；英文整词边界判（防 'ok' 误中 'token'） */
export function digestHas(digestNorm, token) {
    if (!token)
        return false;
    if (CJK_RE.test(token))
        return digestNorm.includes(token);
    return new RegExp(`\\b${token}\\b`).test(digestNorm);
}
/** 未达成（status !== 'met'）的判据集：优先取 GoalProgress 的实时标注，缺省把 successCriteria 视作全 unverified */
export function unmetCriteria(goal, spec) {
    if (Array.isArray(goal?.criteriaStatus)) {
        return goal.criteriaStatus.filter(c => c && typeof c.criterion === 'string' && c.criterion.trim() !== '' && c.status !== 'met');
    }
    const fromSpec = Array.isArray(spec?.successCriteria) ? spec.successCriteria : [];
    return fromSpec
        .filter(c => typeof c === 'string' && c.trim() !== '')
        .map(c => ({ criterion: c, status: 'unverified' }));
}
/**
 * findInSnapshot 式匹配：对每个 interactive !== false 的元素，取其标签 token
 * 与各未达成判据 token 集的重合覆盖率（标签被判据完全解释 ⇒ 1.0），保留得分 >0
 * 者，按 得分降序 → 元素置信降序 → 原序 升序排序（全确定性）。
 */
export function buildCandidates(elements, unmet) {
    const critTokens = unmet
        .map(c => ({ text: c.criterion, tokens: new Set(tokenizeCached(c.criterion)) }))
        .filter(c => c.tokens.size > 0);
    const out = [];
    elements.forEach((el, index) => {
        if (!el)
            return;
        if (el.interactive === false)
            return; // 明确不可交互者不参选（null = 未知，仍参选）
        const labelTokens = tokenizeCached(el.label);
        if (labelTokens.length === 0)
            return;
        let best = 0;
        let bestCrit = '';
        for (const c of critTokens) {
            let inter = 0;
            for (const t of labelTokens)
                if (c.tokens.has(t))
                    inter++;
            const score = inter / labelTokens.length;
            if (score > best) {
                best = score;
                bestCrit = c.text;
            }
        }
        if (best > 0)
            out.push({ element: el, index, score: best, criterion: bestCrit });
    });
    out.sort((a, b) => b.score - a.score ||
        clamp01(b.element.confidence) - clamp01(a.element.confidence) ||
        a.index - b.index);
    return out;
}
/**
 * 纪元 Η（Η-4 候选并列破平）：把并列带（与最佳得分差 < tieGap —— 与 uncertain 的
 * 并列判据同带）内的候选交给 Φ-9 反事实沙盘择优 —— scoreOptions 真实 API：
 *   U = 0.5·progressProbability + 0.3·informationGain − 0.2·risk
 * （progress = 目标关键词与元素标签的重合率 / info = 陌生目标 +0.1、已试过 click
 * 折价 0.1 / risk = benign 0.05、sensitive 0.5、destructive 1），胜者挪到带首，带内
 * 其余保持原序 —— 全确定性稳定序（同输入同输出，同 seed 可复现）。
 *
 * 保序律（红律）：效用全并列时 scoreOptions 取带内输入次序在前者 —— 带内输入序
 * 即旧确定性排序（得分→元素置信→原序），故并列破平对「效用同分」的既有路径
 * 逐字节零变化（良性/常规置信候选的选优结果不因本函数在场而漂移）。
 * 防御律：任何异常 ⇒ 原序直通（绝不抛）；带内不足 2 人 ⇒ 原样返回。
 */
export function breakTieBand(candidates, spec, snapshot, history) {
    try {
        if (!Array.isArray(candidates) || candidates.length < 2)
            return candidates;
        const gap = kernelRegistry.getOrDefault('policy.tieGap', TIE_GAP);
        const top = candidates[0].score;
        let bandEnd = 1;
        while (bandEnd < candidates.length && top - candidates[bandEnd].score < gap)
            bandEnd += 1;
        if (bandEnd <= 1)
            return candidates;
        const band = candidates.slice(0, bandEnd);
        // 沙盘动作：与本中枢 ② 级真实产出同构（kind/target/utility=元素置信/风险词法分层）
        // —— 保证沙盘效用分与真实执行动作的口径一致
        const sandbox = band.map(c => ({
            kind: 'click',
            target: {
                bbox: c.element.bbox,
                center: c.element.center,
                label: typeof c.element.label === 'string' ? c.element.label : '',
            },
            rationale: '并列破平沙盘动作（不执行）',
            expectedEffect: '仅供 Φ-9 反事实效用评分',
            utility: clamp01(c.element.confidence),
            riskTier: classifyClickRisk(c.element.label),
        }));
        const plan = scoreOptions(sandbox, {
            goalKeywords: extractGoalKeywords(spec),
            snapshot: snapshot,
            triedActionKeys: (Array.isArray(history) ? history : []).map(h => actionSignature(h?.action)),
            // ΝΩ-10（infoGain 新鲜度）：把「点过且 no_effect」签名透传给 Φ-9 —— 带内
            // 候选全部来自快照（陌生度恒 0.3 单维），新鲜度让破平真正分出高下。
            noEffectActionKeys: (Array.isArray(history) ? history : [])
                .filter(h => h?.outcome === 'no_effect')
                .map(h => actionSignature(h?.action)),
        });
        if (!plan)
            return candidates;
        // 胜者回位：scoreOptions 的 chosen 是 sandbox 数组内的同一引用（indexOf 恒命中）
        const winIdx = sandbox.indexOf(plan.chosen.action);
        if (winIdx <= 0)
            return candidates; // 胜者已是带首（含效用并列取输入序的保序情形）
        const reordered = [band[winIdx], ...band.slice(0, winIdx), ...band.slice(winIdx + 1)];
        return [...reordered, ...candidates.slice(bandEnd)];
    }
    catch {
        return candidates; // 并列破平是裁决增强不是裁决前提 —— 异常时原序直通
    }
}
// ─── ΝΩ-10（决策面五合一）：②′ type/drag 产生通道 + 候选透出 ───
/** ②′a type 语义锚词（判据含其一才允许产生通道；含多字变体优先锚定，防「填写」
 *  被裸「填」截半后把「写…」误当载荷）。工单词面：输入/填/enter/密码（password
 *  为「密码」的英文对位，防 'enter your password' 把说明文字误当载荷）。 */
const TYPE_SEMANTIC_ANCHORS = ['输入', '键入', '填入', '填写', '填上', '填', '密码', 'enter', 'password'];
/** ②′b drag 动词词面（判据含其一才允许产生通道）。工单词面：拖/移动到。 */
const DRAG_VERBS = ['拖', '移动到'];
/** 后缀提取的续接标记：载荷里出现「后/然后/再/并/…」说明切出来的是句子残段不是载荷 */
const CONTINUATION_MARKERS = [
    '后', '然后', '再', '接着', '并且', '并', '且', '及', '或', '直到', '和',
    '，', '、', '。', ',', ';', '；',
];
/** 后缀载荷的长度上限：超过 20 字符的是句子不是键入内容（保守拒绝） */
const TYPE_SUFFIX_MAX_LEN = 20;
/** click 动词守卫（英文按整词，中文按子串） */
const CLICK_VERB_RE = /点击|单击|双击|点按|\bclick\b/;
/** 语义锚词命中（英文 enter/password 按整词，中文按子串）；返回命中末端，未命中 −1 */
function typeAnchorEnd(text, w) {
    if (w === 'enter' || w === 'password') {
        const m = new RegExp(`\\b${w}\\b`).exec(text);
        return m ? m.index + m[0].length : -1;
    }
    const idx = text.lastIndexOf(w);
    return idx >= 0 ? idx + w.length : -1;
}
/**
 * ②′a type 载荷提取（纯函数、绝不抛）：优先仓内 intentGrammar 的引号锚定提取
 * （精确性优先 —— 与书写内容编辑距离为 0）；无引号段时退最小后缀提取器 ——
 * 取最后一个语义锚词之后的残段，残段必须：非空、≤20 字符、不含语义锚词（拒绝
 * 「输入密码」这类纯标签判据）、不含续接标记（拒绝「填写表单后提交」句子残段）、
 * 且不是单个 CJK 字符（拒绝「点击输入框」被切出的「框」）。
 * 任一守卫不过 ⇒ null（拿不准不产 —— escalate 兜底仍在）。
 */
function extractTypeText(criterion) {
    if (typeof criterion !== 'string' || criterion.trim() === '')
        return null;
    const norm = normalizeWs(criterion);
    if (norm === '' || CLICK_VERB_RE.test(norm))
        return null;
    // 语义锚词在场性：无锚词 ⇒ 不是键入判据
    if (!TYPE_SEMANTIC_ANCHORS.some(w => typeAnchorEnd(norm, w) >= 0))
        return null;
    // 引号优先：intentGrammar 的无损提取（"…" / '…' / 「…」等六种引号风格）
    const spans = extractQuotedSpans(criterion);
    const first = spans.find(s => typeof s.content === 'string' && s.content.trim() !== '');
    if (first)
        return first.content;
    // 后缀兜底：最后一个语义锚词之后
    let cutAt = -1;
    for (const w of TYPE_SEMANTIC_ANCHORS) {
        const end = typeAnchorEnd(norm, w);
        if (end > cutAt)
            cutAt = end;
    }
    if (cutAt < 0)
        return null;
    const suffix = norm.slice(cutAt).trim();
    if (suffix === '' || suffix.length > TYPE_SUFFIX_MAX_LEN)
        return null;
    if (suffix.length === 1 && CJK_RE.test(suffix))
        return null;
    if (TYPE_SEMANTIC_ANCHORS.some(w => typeAnchorEnd(suffix, w) >= 0))
        return null;
    if (CONTINUATION_MARKERS.some(m => suffix.includes(m)))
        return null;
    return suffix;
}
/** 元素角色判定：role 归一后恰为 'input'（worldSnapshot 的可交互角色词表成员） */
function isInputRole(el) {
    return !!el && typeof el.role === 'string' && el.role.toLowerCase() === 'input';
}
/** 中心点卫兵：x/y 均有限数才算可用落点 */
function finiteCenter(el) {
    const c = el?.center;
    if (!c || typeof c !== 'object')
        return null;
    const { x, y } = c;
    if (typeof x !== 'number' || !Number.isFinite(x))
        return null;
    if (typeof y !== 'number' || !Number.isFinite(y))
        return null;
    return { x, y };
}
/** 引号段 → 快照元素：归一标签包含归一段文的第一个可交互元素（interactive !== false） */
function elementContainingText(elements, spanText) {
    const needle = normalizeWs(spanText);
    if (needle === '')
        return null;
    for (const el of elements) {
        if (!el || el.interactive === false)
            continue;
        const label = normalizeWs(el.label);
        if (label !== '' && label.includes(needle))
            return el;
    }
    return null;
}
/**
 * ΝΩ-10 ②′（type/drag 产生通道，② 级点击之前的保守窄门）：
 *   · type —— 判据含「输入/填/enter/密码」语义锚词、且判据匹配候选中有
 *     role=input 的可交互元素、且载荷可提取（引号内容或合格后缀）⇒ 产
 *     {kind:'type', target, payload:{text}}；键入凭据判据（含「密码」）riskTier
 *     记 sensitive（执行层风险闸门预分类），其余 benign。
 *   · drag —— 判据含「拖/移动到」动词、且判据含两个引号锚定落点（源/目的地，
 *     即「两坐标语义词」）且各自可在快照中按标签包含匹配到不同元素 ⇒ 产
 *     {kind:'drag', target=源, payload:{end:{x,y}, toLabel}}（执行层契约：
 *     target.center 起点、payload.end 终点）。
 *   拿不准不产（返回 null ⇒ 决策序继续走 ② 点击，escalate 兜底仍在）；产出的
 *   动作与 ② 级真实动作同构，下游统一过宪法与验证层。
 */
export function composeTypeOrDragAction(candidates, unmet, elements) {
    try {
        if (!Array.isArray(candidates) || !Array.isArray(elements))
            return null;
        // ②′a type：按排名序找首个「input 角色 + 其匹配判据可提取键入载荷」的候选
        for (const c of candidates) {
            const el = c?.element;
            if (!el || el.interactive === false || !isInputRole(el))
                continue;
            if (typeof c.criterion !== 'string' || c.criterion === '')
                continue;
            const text = extractTypeText(c.criterion);
            if (text === null)
                continue;
            const label = typeof el.label === 'string' ? el.label : '';
            return {
                kind: 'type',
                target: {
                    bbox: el.bbox,
                    center: finiteCenter(el) ?? { x: 0, y: 0 },
                    label,
                },
                payload: { text },
                rationale: `判据「${c.criterion}」要求输入内容，向输入框「${label}」键入「${text}」`,
                expectedEffect: `输入框「${label}」获得文本，判据「${c.criterion}」可被验证`,
                utility: clamp01(el.confidence),
                riskTier: c.criterion.includes('密码') ? 'sensitive' : 'benign',
            };
        }
        // ②′b drag：判据拖动词 + 两个引号落点（源/目的地）皆可在快照锚定
        if (Array.isArray(unmet)) {
            for (const u of unmet) {
                const criterion = typeof u?.criterion === 'string' ? u.criterion : '';
                const norm = normalizeWs(criterion);
                if (norm === '' || !DRAG_VERBS.some(v => norm.includes(v)))
                    continue;
                const spans = extractQuotedSpans(criterion).filter(s => typeof s.content === 'string' && s.content.trim() !== '');
                if (spans.length < 2)
                    continue;
                const src = elementContainingText(elements, spans[0].content);
                const dst = elementContainingText(elements, spans[1].content);
                if (!src || !dst || src === dst)
                    continue;
                const dstCenter = finiteCenter(dst);
                if (!dstCenter)
                    continue;
                const srcLabel = typeof src.label === 'string' ? src.label : '';
                const dstLabel = typeof dst.label === 'string' ? dst.label : '';
                return {
                    kind: 'drag',
                    target: { bbox: src.bbox, center: finiteCenter(src) ?? { x: 0, y: 0 }, label: srcLabel },
                    payload: { end: dstCenter, toLabel: dstLabel },
                    rationale: `判据「${criterion}」要求拖拽，把「${srcLabel}」拖至「${dstLabel}」`,
                    expectedEffect: `「${srcLabel}」被移动到「${dstLabel}」的位置，判据「${criterion}」可被验证`,
                    utility: Math.min(clamp01(src.confidence), clamp01(dst.confidence)),
                    // 词法风险预分类扫源+目的双标签（「拖到删除区」类落点须过风险闸门）
                    riskTier: classifyClickRisk(`${srcLabel} ${dstLabel}`),
                };
            }
        }
        return null;
    }
    catch {
        return null; // 产生通道是裁决增强不是裁决前提 —— 异常时走 ② 原路
    }
}
/**
 * ΝΩ-10（候选透出）：② 级 breakTieBand 后的排名候选 → 与真实点击动作同构的
 * PolicyAction 清单（岔路账消费面）。截前 VLM_CANDIDATE_CAP（8）名 —— 与云脑
 * 咨询的候选上限同一带宽礼仪；防御律：脏输入/异常 ⇒ 空清单（调用方按缺席处理）。
 */
export function candidatesToActions(candidates) {
    try {
        if (!Array.isArray(candidates))
            return [];
        const out = [];
        for (const c of candidates.slice(0, VLM_CANDIDATE_CAP)) {
            const el = c?.element;
            if (!el || typeof el.label !== 'string')
                continue;
            out.push({
                kind: 'click',
                target: { bbox: el.bbox, center: el.center, label: el.label },
                payload: { criterion: c.criterion, matchScore: round2(c.score) },
                rationale: `候选「${el.label}」：判据「${c.criterion}」关键词重合（得分 ${round2(c.score)}）`,
                expectedEffect: `「${el.label}」被激活，推进判据「${c.criterion}」`,
                utility: clamp01(el.confidence),
                riskTier: classifyClickRisk(el.label),
            });
        }
        return out;
    }
    catch {
        return [];
    }
}
/**
 * 僵局探测：取 history 尾部连续 no_effect 段，段内存在「同 kind 相邻成对」的
 * 最近一段 ⇒ 返回 { kind, count }（同类动作连续 ≥2 次无效果）。
 */
export function detectStagnation(history) {
    let i = history.length;
    while (i > 0 && history[i - 1]?.outcome === 'no_effect')
        i--;
    const suffix = history.slice(i);
    let runKind = null;
    let runLen = 0;
    let best = null;
    for (const entry of suffix) {
        const k = entry?.action?.kind;
        if (k === runKind) {
            runLen++;
            if (runLen >= 2)
                best = { kind: k, count: runLen };
        }
        else {
            runKind = k;
            runLen = 1;
        }
    }
    return best;
}
/**
 * 策略切换家族与三级轮换环（ΝΩ-10 僵局三级退避）：scroll → inspect → hotkey Tab
 * 焦点周游 → scroll。hotkey 家族成员仅限 Tab 焦点周游（payload.keys 含 'tab'，
 * 与探索层 explorationCore 的 hotkey#tab 全局候选同先例）—— ① 级弹窗 Esc 热键
 * 不是切换动作，不进轮换状态。
 */
export const SWITCH_CYCLE = ['scroll', 'inspect', 'hotkey'];
/**
 * history 中最近一次策略切换动作（scroll / inspect / hotkey Tab 焦点周游家族）——
 * 用于三级轮换抉择。ΝΩ-10：由二元（scroll/inspect）扩为三元 —— hotkey 仅当其
 * keys 含 'tab'（大小写折叠）才算切换家族；其余 hotkey（如弹窗 Esc）被跳过。
 */
export function lastSwitchKind(history) {
    for (let i = history.length - 1; i >= 0; i--) {
        const a = history[i]?.action;
        const k = a?.kind;
        if (k === 'scroll' || k === 'inspect')
            return k;
        if (k === 'hotkey') {
            const payload = a?.payload && typeof a.payload === 'object' ? a.payload : null;
            const keys = Array.isArray(payload?.keys) ? payload?.keys : [];
            if (keys.some(x => typeof x === 'string' && x.toLowerCase() === 'tab'))
                return 'hotkey';
        }
    }
    return null;
}
/**
 * 三级轮换的下一棒（ΝΩ-10）：上次切换是 scroll ⇒ inspect；inspect ⇒ hotkey Tab；
 * hotkey Tab ⇒ scroll（环回）；无切换史 ⇒ scroll（与旧二元轮换的缺省一致）。
 * 纯函数、脏 history 按「无切换史」记（lastSwitchKind 卫兵式返回 null）。
 */
export function nextSwitchKind(history) {
    const last = lastSwitchKind(history);
    if (last === null)
        return 'scroll';
    const idx = SWITCH_CYCLE.indexOf(last);
    if (idx < 0)
        return 'scroll';
    return SWITCH_CYCLE[(idx + 1) % SWITCH_CYCLE.length];
}
/** 技能描述与目标的关键词重合数（token 集交集大小；描述 tokens 由调用方单次分词复用） */
export function skillOverlap(goalTokens, descriptionTokens) {
    let shared = 0;
    for (const t of descriptionTokens)
        if (goalTokens.has(t))
            shared++;
    return shared;
}
/** 云脑选点提示词 —— 中文模板：目标 + 未达成判据 + 候选标签列表，索要 {index, reason} */
export function buildPickPrompt(goalText, unmetTexts, labels) {
    return [
        '你是桌面自动化决策助手。当前世界快照中筛出了一组候选可交互元素。',
        `用户目标：${goalText || '（未给出）'}`,
        `尚未达成的成功判据：${unmetTexts.length > 0 ? unmetTexts.join('；') : '（无）'}`,
        '候选元素列表（index: 标签）：',
        ...labels.map((l, i) => `${i}. ${l}`),
        '请判断点击哪个候选元素最有利于推进目标。',
        '只输出一个 JSON 对象，不要输出其他文字：{"index": <候选序号整数>, "reason": "<一句中文理由>"}',
    ].join('\n');
}
