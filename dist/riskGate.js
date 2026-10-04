// src/riskGate.ts
// 第五轮创新之二：风险感知人机协同（Risk Gate）。
// E-6 混淆免疫（第五维·信息热力学）：归一化匹配对抗视觉混淆（p@ssw0rd/密 码/PIN 码）。
// 世界级 CUA 的安全共识：凭据类输入不该由 Agent 代劳 —— Operator 遇到密码框
// 会交还控制权。本模块用两段式实现：
//   1. click_mouse 时识别敏感目标（target_description 命中风险词）⇒ 标记焦点为敏感
//   2. type_text 到敏感焦点 ⇒ 拦截，要求暂停并请用户亲自输入（绝不回显内容）
// 风险词可配置（逗号分隔），默认覆盖中英常见凭据语义。
import { CONFUSABLES_ASCII } from './riskGate.confusables.generated.js';
export const DEFAULT_RISK_PATTERNS = 'password,passwd,密码,口令,验证码,verification code,2fa,otp,pin,secret,token,api key,私钥';
// 第六轮：不可逆操作模式 —— 命中即需一次性审批令牌（用户显式授权后方可执行）
export const DEFAULT_DANGER_PATTERNS = 'send,发送,delete,删除,remove,移除,pay,支付,付款,buy,购买,checkout,结算,下单,submit order,提交订单,' +
    'confirm,确认订单,format,格式化,erase,抹掉,uninstall,卸载,reset,重置,清空,withdraw,提现,transfer,转账';
/** 解析逗号分隔的风险词配置（空串回退 fallback） */
export function parseRiskPatterns(csv, fallback = DEFAULT_RISK_PATTERNS) {
    return (csv || fallback)
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
}
// ─── E-6 混淆免疫（第五维·信息热力学）：归一化对抗视觉混淆 ───
/** leet 还原表：人类可读、机器漏检的视觉同形混淆（0↔o、1↔l、@↔a…）。
 *  算法形状字面量 —— 覆盖常见凭据字段混淆；完整 homoglyph 表（西里尔 а 等）
 *  是留白（NFKC 归一化 + Unicode 同形映射，需真实语料定标）。 */
const LEET_MAP = {
    '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's',
};
/**
 * 归一化：小写 + leet 还原 + 剥空白/零宽字符/标点/符号。
 * 「p@ssw0rd」→「password」、「密 码」→「密码」、「verificati0n c0de」→
 * 「verificationcode」—— 三类视觉混淆在归一化域内全部还原为可匹配形态。
 * 语义方向：匹配面扩大只增召回（宁误拦不漏拦 —— 风险闸门的使命是保守，
 *  拦截的代价有界：模型多看一眼截图；漏拦的代价是凭据被代输）。
 * 词表与待检文本同律归一（双向一致 —— 词表「api key」与文本「A P I k e y」对齐）。
 */
// K 纪元（留白兑现之六）：同形字（homoglyph）归一 —— E-6 留白的兑现。
// 策领图（Unicode confusables 的策展子集，覆盖攻击面最广的三族）：
//   西里尔/希腊视觉同形 → 拉丁；全角字母数字 → 半角。完整 consortium 表
//   数千条 —— 策展 ~50 条是"值即边界"（新增条目零风险，纯数据扩展）。
/**
 * L 纪元扩表（值即边界 → 算术全表）：数学字母五套（U+1D400 系）、带圈
 * Ⓐ-ⓩ/ⓐ-ⓩ、上标/下标字母 —— 码点偏移算术批量生成（推导即数据，零数据文件）。
 * 策展跨脚本核心（西里尔/希腊/亚美尼亚/科普特）保留手工映射 —— 覆盖 =
 * 算术族全覆盖 + 混杂族策展；扩展是加一行，不是加一张表。
 */
/**
 * O 纪元（#10 全表）：Unicode confusables.txt（UTS #39）全表蒸馏接入 ——
 * 1665 条原型纯 ASCII 条目（数据血缘与再生命令见 generated 文件头）打底；
 * 策展/算术族覆写在后：既有行为零回归，全表只填空白。ASCII→ASCII 折叠
 * （如 m→rn、0→o）无害且正确 —— haystack 与 pattern 双方过同一归一化，
 * 对称一致（UTS#39 的混淆语义：rn 与 m 视觉互混，双向都该命中）。
 */
function buildHomoglyphMap() {
    const m = {
        ...CONFUSABLES_ASCII,
        // ── 策展跨脚本核心（覆写位：与生成表冲突时以策展为准）──
        'а': 'a', 'е': 'e', 'о': 'o', 'с': 'c', 'р': 'p',
        'х': 'x', 'у': 'y', 'і': 'i', 'ѕ': 's', 'һ': 'h',
        'ԁ': 'd', 'җ': 'g', 'ӏ': 'l', 'ӣ': 'm', 'й': 'u',
        'ј': 'j', 'ѣ': 'y', 'ԛ': 'q',
        'α': 'a', 'ο': 'o', 'ρ': 'p', 'ε': 'e', 'ι': 'i',
        'κ': 'k', 'μ': 'm', 'ν': 'v', 'τ': 't', 'χ': 'x',
        'ա': 'a', 'ս': 's', 'օ': 'o', 'չ': 'p', 'թ': 't',
        'ⱥ': 'a', 'ⱦ': 'e', 'ꭱ': 'e',
    };
    for (let i = 0; i < 26; i++) {
        m[String.fromCharCode(0xff21 + i)] = String.fromCharCode(97 + i); // 全角 Ａ-Ｚ
        m[String.fromCharCode(0xff41 + i)] = String.fromCharCode(97 + i); // 全角 ａ-ｚ
        m[String.fromCodePoint(0x1d400 + i)] = String.fromCharCode(97 + i); // 数学粗体
        m[String.fromCodePoint(0x1d434 + i)] = String.fromCharCode(97 + i); // 数学斜体
        m[String.fromCodePoint(0x1d468 + i)] = String.fromCharCode(97 + i); // 数学粗斜体
        m[String.fromCodePoint(0x1d4d0 + i)] = String.fromCharCode(97 + i); // 数学粗花体
        m[String.fromCharCode(0x24b6 + i)] = String.fromCharCode(97 + i); // 带圈大写
        m[String.fromCharCode(0x24d0 + i)] = String.fromCharCode(97 + i); // 带圈小写
    }
    for (let i = 0; i < 10; i++)
        m[String.fromCharCode(0xff10 + i)] = String(i); // 全角数字
    return m;
}
const HOMOGLYPH_MAP = buildHomoglyphMap();
// Δ 纪元（安全外围#1）：单遍替换的折叠不对称 —— 全角 ｍ 单遍归一为 'm' 后不再
// 折叠为 'rn'，而 ASCII 词表 'submit' 单遍即成 'subrnit'（CONFUSABLES_ASCII 的
// m→rn 折叠）⇒ haystack 与 pattern 停在不同的中间形态（实测 ｓｕｂｍｉｔ 逃逸）。
// 修法：迭代归一至不动点（haystack 与词表两侧同律）。上限 3 遍 —— 恶意构造的
// 长折叠链（m→rn→…）不能把归一化变成放大器；真实混淆链（全角→ASCII→折叠）
// 两遍内收敛，3 遍是安全裕度。
const NORMALIZE_MAX_PASSES = 3;
function normalizeOnce(s) {
    let out = '';
    for (const ch of s.toLowerCase()) {
        if (LEET_MAP[ch] !== undefined) {
            out += LEET_MAP[ch];
            continue;
        }
        if (HOMOGLYPH_MAP[ch] !== undefined) {
            out += HOMOGLYPH_MAP[ch];
            continue;
        }
        if (/[\s\u200b\u200c\u200d\p{P}\p{S}]/u.test(ch))
            continue; // 空白/零宽/标点/符号全剥
        out += ch;
    }
    return out;
}
/** 风险域归一化（导出供同律消费者对齐；匹配语义只经 matches* 两函数） */
export function normalizeForRisk(s) {
    let prev = s;
    for (let i = 0; i < NORMALIZE_MAX_PASSES; i++) {
        const next = normalizeOnce(prev);
        if (next === prev)
            return next; // 不动点：再归一不变 ⇒ 已是最终形态
        prev = next;
    }
    return prev; // 越过迭代上限：按已收敛部分匹配（有界保守，不为恶意长链无限付费）
}
// Δ 纪元（安全外围#2）：模式归一化记忆化 —— 旧实现每次 matches* 调用都重切
// CSV 并逐 pattern 归一化（现在还是每 pattern 三遍迭代），而 csv 是每回合稳定
// 的配置串。按「生效 csv 字符串」缓存归一化后的词表（上限 32 条，满时逐出最旧
// —— Map 保序，首键即 LRU 牺牲者；词表配置的组合空间天然远小于 32）。
const PATTERN_CACHE_LIMIT = 32;
const patternCache = new Map();
/** 归一化词表（记忆化；键 = 生效 csv，即 csv || fallback） */
function normalizedPatterns(csv, fallback) {
    const key = csv || fallback;
    const hit = patternCache.get(key);
    if (hit)
        return hit;
    const pats = key
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
        .map(normalizeForRisk) // 与 haystack 同律（含不动点迭代 —— 两侧停在同一形态）
        // 归一化后为空的模式（纯标点/符号词，如 "***"）必须剔除：'' 是一切串的
        // 子串，留下它会令 matches* 对任意文本恒真 —— 风险门整体失效（全拦 = 失能）
        .filter(p => p.length > 0);
    if (patternCache.size >= PATTERN_CACHE_LIMIT) {
        const oldest = patternCache.keys().next().value;
        if (oldest !== undefined)
            patternCache.delete(oldest);
    }
    patternCache.set(key, pats);
    return pats;
}
/** 记忆化探针（测试/可观测性用：断言缓存命中、无需重复归一化） */
export function riskPatternCacheSize() {
    return patternCache.size;
}
/** 文本是否命中任一风险词（混淆免疫：归一化后包含匹配） */
export function matchesRiskPatterns(text, csv) {
    if (!text)
        return false;
    const hay = normalizeForRisk(text);
    const pats = normalizedPatterns(csv, DEFAULT_RISK_PATTERNS);
    for (let i = 0; i < pats.length; i++)
        if (hay.includes(pats[i]))
            return true;
    return false;
}
/** 文本是否命中任一不可逆操作词（需审批令牌；同律归一化） */
export function matchesDangerPatterns(text, csv) {
    if (!text)
        return false;
    const hay = normalizeForRisk(text);
    const pats = normalizedPatterns(csv, DEFAULT_DANGER_PATTERNS);
    for (let i = 0; i < pats.length; i++)
        if (hay.includes(pats[i]))
            return true;
    return false;
}
/** 分级判定的等级序（校准升级的步进面：reversible < compensable < irreversible） */
const LEVEL_ORDER = {
    reversible: 0, compensable: 1, irreversible: 2,
};
/** 按级分道（纯函数）：三级 → 派发要求。 */
export function dispatchLaneFor(level) {
    switch (level) {
        case 'reversible':
            return {
                lane: 'fast', requiresApprovalToken: false, requiresEscrowPlan: false, humanExecution: false,
                note: 'reversible: fast lane — a non-destructive inverse exists (scroll back / re-click / switch back); ' +
                    'no reversibility-imposed requirements (danger-word gate still applies independently)',
            };
        case 'compensable':
            return {
                lane: 'escrow', requiresApprovalToken: false, requiresEscrowPlan: true, humanExecution: false,
                note: 'compensable: W3-1 escrow lane — mint a reversal plan (reversalEscrow.mintPlan) BEFORE beginAttempt; ' +
                    'compensation path is hosted and verified (danger-word gate may still require approval independently)',
            };
        case 'irreversible':
            return {
                lane: 'human', requiresApprovalToken: true, requiresEscrowPlan: false, humanExecution: true,
                note: 'irreversible: forced approval + HUMAN execution — the escrow strategy table is manual-only ' +
                    '(fail-closed: a delivered message cannot be unsent); automation must hand control back to the user',
            };
    }
}
/**
 * 内置语义 → 级别表。键与 reversalEscrow 的补偿策略表对齐（compensable 键 =
 * 策略表 kind:'compensate' 的语义；irreversible 键 = manual-only 的语义 ——
 * 两表各自独立维护，键对齐是纪律不是依赖：riskGate 不得 import reversalEscrow
 * （会与 approval → riskGate 成环），对齐靠测试与注释执法）。
 */
const BUILTIN_LEVELS = new Map([
    // 可逆：逆动作存在且非破坏
    ['viewport-scroll', 'reversible'], // scroll_page → 反向滚动
    ['tab-switch', 'reversible'], // switch_tab / switch_window → 切回
    ['popup-dismiss', 'reversible'], // dismiss_popup → 关掉的浮层不改变持久世界
    ['toggle', 'reversible'], // 开关/复选 → 再点一次（精确逆）
    // 可补偿：W3-1 托管策略表有补偿路径
    ['form-submit', 'compensable'], // Ctrl+Z / 草稿箱回收
    ['file-delete', 'compensable'], // 回收站还原 / Ctrl+Z
    ['file-write', 'compensable'], // 应用内 undo 栈
    ['text-input', 'compensable'], // Ctrl+Z（W6-3 扩表后与 escrow 策略表对齐：输入类走应用内 undo）
    ['navigation', 'compensable'], // 后退导航 Backspace（W6-3 扩表：返回动作前页面）
    // 不可逆：策略表明示 manual-only
    ['send-message', 'irreversible'], // 已发出的消息无法收回
    ['payment', 'irreversible'], // 退款是新交易不是撤销
    ['permanent-delete', 'irreversible'], // 不进回收站的删除 —— 语义上已放弃可逆性
]);
/**
 * 描述关键词 → 语义键（与危险词表同律归一化、但**独立成表** —— 不改既有
 * 危险词语义，分级是叠加维度）。匹配序 = 表序：不可逆族最前（保守优先 ——
 * "delete then send" 的复合描述归入 send-message），可补偿族次之，可逆族最后。
 */
const LEVEL_KEYWORDS = [
    // 不可逆族（对齐 DEFAULT_DANGER_PATTERNS 的发送/支付/格式化词组）
    { key: normalizeForRisk('send'), semantics: 'send-message' },
    { key: '发送', semantics: 'send-message' },
    { key: normalizeForRisk('pay'), semantics: 'payment' },
    { key: '支付', semantics: 'payment' }, { key: '付款', semantics: 'payment' },
    { key: 'buy', semantics: 'payment' }, { key: '购买', semantics: 'payment' },
    { key: 'checkout', semantics: 'payment' }, { key: '结算', semantics: 'payment' },
    { key: 'withdraw', semantics: 'payment' }, { key: '提现', semantics: 'payment' },
    { key: 'transfer', semantics: 'payment' }, { key: '转账', semantics: 'payment' },
    { key: 'format', semantics: 'permanent-delete' }, { key: '格式化', semantics: 'permanent-delete' },
    { key: 'erase', semantics: 'permanent-delete' }, { key: '抹掉', semantics: 'permanent-delete' },
    // 可补偿族
    { key: 'delete', semantics: 'file-delete' }, { key: '删除', semantics: 'file-delete' },
    { key: 'remove', semantics: 'file-delete' }, { key: '移除', semantics: 'file-delete' },
    { key: 'submit', semantics: 'form-submit' }, { key: '提交', semantics: 'form-submit' },
    { key: '下单', semantics: 'form-submit' }, { key: '订单', semantics: 'form-submit' },
    { key: 'type', semantics: 'text-input' }, { key: '输入', semantics: 'text-input' },
    { key: '填写', semantics: 'text-input' },
    { key: 'open', semantics: 'navigation' }, { key: 'navigate', semantics: 'navigation' },
    { key: '跳转', semantics: 'navigation' },
    // 可逆族（描述面少用 —— 工具回退表承担主力）
    { key: 'scroll', semantics: 'viewport-scroll' }, { key: '滚动', semantics: 'viewport-scroll' },
    { key: 'tab', semantics: 'tab-switch' },
];
/** 已知工具 → 语义键回退表（描述无命中时的次级判定面）。
 *  刻意不收录 click_mouse/click_element/drag_mouse/press_hotkey —— 这些工具
 *  的可逆性由**目标语义**决定而非工具本身（点开关可逆、点发送不可逆），目标
 *  未知 ⇒ 保守律默认最高级。 */
const TOOL_SEMANTICS = new Map([
    ['scroll_page', 'viewport-scroll'],
    ['switch_tab', 'tab-switch'],
    ['switch_window', 'tab-switch'],
    ['dismiss_popup', 'popup-dismiss'],
    ['type_text', 'text-input'],
    ['open_url', 'navigation'],
]);
// ─── 证据门常量（Beta 风格 —— 值即边界） ───
/** 升一级的最低 adverse 事件数（防单事件翻级的执法点） */
const RAISE_MIN_ADVERSE = 2;
/** 升一级的后验均值门（Beta(1+adverse, 1+supportive) 均值） */
const RAISE_POSTERIOR = 0.5;
/** 升两级的最低 adverse 事件数 */
const RAISE2_MIN_ADVERSE = 4;
/** 升两级的后验均值门 */
const RAISE2_POSTERIOR = 0.75;
/** 证据键封顶（无界键表 = 无界记忆 —— 满后逐出最旧） */
const EVIDENCE_KEYS_MAX = 128;
/** 单次负证据查询的折算上限（查询返回巨数不得一次买断两级） */
const NEGATIVE_EVIDENCE_CAP = 10;
// ─── 注册表模块态（全部经 arm 注入；缺省 = 内置表 + 无扩展 + 无查询） ───
let extensionLevels = new Map();
let evidenceStore = new Map();
let negativeEvidenceQuery = null;
function cleanStr(v, max) {
    return typeof v === 'string' && v.trim() !== '' ? v.slice(0, max) : undefined;
}
function isLevel(v) {
    return v === 'reversible' || v === 'compensable' || v === 'irreversible';
}
function clampCount(v, max) {
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0;
    return Math.max(0, Math.min(max, n));
}
/** 证据账读取（无则零账 —— 诚实起点） */
function evidenceOf(semantics) {
    return evidenceStore.get(semantics) ?? { adverse: 0, supportive: 0 };
}
/** 证据账写入（封顶逐出最旧 —— Map 保序，首键即牺牲者） */
function putEvidence(semantics, ev) {
    if (evidenceStore.size >= EVIDENCE_KEYS_MAX && !evidenceStore.has(semantics)) {
        const oldest = evidenceStore.keys().next().value;
        if (oldest !== undefined)
            evidenceStore.delete(oldest);
    }
    evidenceStore.set(semantics, ev);
}
/** Beta 后验均值：Beta(1+adverse, 1+supportive) 的 mean = α/(α+β)（α=1+adverse；W7 审计改正原注释方向笔误） */
function posteriorMean(ev) {
    return (ev.adverse + 1) / (ev.adverse + ev.supportive + 2);
}
/** 证据门（纯函数）：base 级 + 证据账 → 校准级与升档数 */
function gateLevel(base, ev) {
    const p = posteriorMean(ev);
    let notches = 0;
    if (ev.adverse >= RAISE_MIN_ADVERSE && p >= RAISE_POSTERIOR)
        notches = 1;
    if (ev.adverse >= RAISE2_MIN_ADVERSE && p >= RAISE2_POSTERIOR)
        notches = 2;
    const levelNum = Math.min(LEVEL_ORDER.irreversible, LEVEL_ORDER[base] + notches);
    const level = ['reversible', 'compensable', 'irreversible'][levelNum];
    return { level, raisedNotches: levelNum - LEVEL_ORDER[base] };
}
/** 描述 → 语义键（关键词表序匹配 —— 不可逆族优先的保守序） */
function semanticsFromDescription(description) {
    if (!description)
        return null;
    const hay = normalizeForRisk(description);
    if (hay === '')
        return null;
    for (const { key, semantics } of LEVEL_KEYWORDS) {
        if (key !== '' && hay.includes(key))
            return semantics;
    }
    return null;
}
/** 分级判定的核心实现（注册表方法与示范入账共用的内部面） */
function classifyIntent(intent) {
    try {
        const explicit = cleanStr(intent?.semantics, 64);
        const tool = cleanStr(intent?.tool, 64);
        const description = cleanStr(intent?.description, 200);
        let semantics = null;
        let known = false;
        if (explicit !== undefined && (BUILTIN_LEVELS.has(explicit) || extensionLevels.has(explicit))) {
            semantics = explicit;
            known = true;
        }
        if (!known) {
            const byDesc = description !== undefined ? semanticsFromDescription(description) : null;
            if (byDesc !== null) {
                semantics = byDesc;
                known = true;
            }
        }
        if (!known && tool !== undefined && TOOL_SEMANTICS.has(tool)) {
            semantics = TOOL_SEMANTICS.get(tool);
            known = true;
        }
        if (!known) {
            // 保守律：未知动作默认最高级（分级知识的缺口按最坏情况收费）
            return { level: 'irreversible', semantics: 'unknown', source: 'unknown-default' };
        }
        const ext = extensionLevels.get(semantics);
        const base = ext ?? BUILTIN_LEVELS.get(semantics) ?? 'irreversible';
        const baseSource = ext !== undefined ? 'extension' : 'builtin';
        // 瞬态负证据合并（只读查询 —— 不入持久账，防 classify 自我膨胀）
        let ev = evidenceOf(semantics);
        if (semantics !== 'unknown' && negativeEvidenceQuery !== null) {
            try {
                ev = { ...ev, adverse: ev.adverse + clampCount(negativeEvidenceQuery(semantics), NEGATIVE_EVIDENCE_CAP) };
            }
            catch { /* 查询端口故障 = 无负证据（诚实缺席，不炸分级） */ }
        }
        const gated = gateLevel(base, ev);
        if (gated.raisedNotches > 0) {
            return {
                level: gated.level, semantics: semantics, source: 'calibrated',
                evidence: {
                    adverse: ev.adverse, supportive: ev.supportive,
                    posterior: Math.round(posteriorMean(ev) * 1000) / 1000,
                    raisedNotches: gated.raisedNotches,
                },
            };
        }
        return { level: gated.level, semantics: semantics, source: baseSource };
    }
    catch {
        return { level: 'irreversible', semantics: 'unknown', source: 'unknown-default' }; // 防御式兜底
    }
}
/**
 * W4-3（S5）：可逆性分级注册表（模块单例 —— 插件卸载随闭包消亡）。
 * 一切公开面绝不抛：脏输入 / 查询端口故障 ⇒ 收敛为保守返回值（未知默认
 * 最高级是缺省的方向，不是异常的出口）。
 */
export const reversibilityRegistry = {
    /** 分级判定（纯读 + 瞬态负证据合并；绝不抛）。
     *  判定序：显式语义键（表内）→ 描述关键词 → 工具回退表 → 未知默认最高。
     *  显式语义键不在表内 ⇒ 同样默认最高（未注册的语义 = 注册表的知识缺口）。 */
    classify(intent) {
        return classifyIntent(intent);
    },
    /** Τ示范事件入账（approval.emitDemonstration 的旁路落点；绝不抛）：
     *  approval-denied ⇒ adverse++（用户视此为不可逆的证据）；
     *  approval-consumed ⇒ supportive++（特权正示范 —— 后验分母）。
     *  语义键解析：显式 semantics ?? 由 tool/description 现场分类（与 classify
     *  同一判定面 —— 事件落在哪个键上，分级就在哪个键上长证据）。 */
    observeDemonstration(ev) {
        try {
            if (ev?.kind !== 'approval-denied' && ev?.kind !== 'approval-consumed')
                return;
            let key = cleanStr(ev?.semantics, 64) ?? null;
            if (key === null || (!BUILTIN_LEVELS.has(key) && !extensionLevels.has(key))) {
                const v = classifyIntent({ tool: ev?.tool, description: ev?.description, semantics: ev?.semantics });
                key = v.semantics === 'unknown' ? null : v.semantics;
            }
            if (key === null)
                return; // 键不可解析 ⇒ 证据不落账（不把噪声记成知识）
            const cur = evidenceOf(key);
            putEvidence(key, ev?.kind === 'approval-denied'
                ? { ...cur, adverse: cur.adverse + 1 }
                : { ...cur, supportive: cur.supportive + 1 });
        }
        catch { /* 旁路义务：教育失败绝不炸调用方 */ }
    },
    /** 持久负证据注入（failureMemory 之外的显式入账面；一次封顶 8 —— 单次
     *  调用不得买断两级）。绝不抛。 */
    applyNegativeEvidence(semantics, count) {
        try {
            const key = cleanStr(semantics, 64);
            if (key === undefined)
                return;
            const cur = evidenceOf(key);
            putEvidence(key, { ...cur, adverse: cur.adverse + clampCount(count, 8) });
        }
        catch { /* 防御式兜底 */ }
    },
    /** 部署显式定级（人的决策 —— 在线校准只升不降，降级走此面或 arm 扩展） */
    setLevel(semantics, level) {
        try {
            const key = cleanStr(semantics, 64);
            if (key === undefined || !isLevel(level))
                return false;
            extensionLevels.set(key, level);
            return true;
        }
        catch {
            return false;
        }
    },
    // ─── W9-2（DEBTS D-C1 落锤）：外部补偿策略表的同步登记通道（增量）───
    //
    // 决策理由：D-C1 的剩余债是「compensate 扩表面待部署知识」—— 内置表受
    // S5-5d 键对齐律封死（riskGate 所有权），部署方扩表的正确姿势是**以文件
    // 扩表而非改源码**：reversalEscrow.loadExternalStrategyTable(path) 从 JSON
    // 外部表装载补偿路径，本通道是它在分级注册表侧的对应落点 —— 两表在同一
    // 次装载里同键登记（compensate ⇔ compensable；manual-only ⇔ irreversible），
    // 「两侧同步登记」由装载面原子完成，不再依赖部署方手工两次接线。
    // 立法边界：本通道只**增量登记**（compensable / irreversible 两级，不收
    // reversible —— 外部表没有「快道」语义面）；批量全有或全无（一条坏件 ⇒
    // 整批拒绝，绝不留下半套登记的中间态）；一切公开面绝不抛。
    /**
     * W9-2：批量定级登记（全有或全无 —— 外部策略表装载的分级侧半边）。
     * entries 每项 { semantics, level }；level 仅收 'compensable' | 'irreversible'
     * （reversible 是内置快道知识，不经部署文件面注入 —— 保守缺省）。
     * 任何一项不合格 ⇒ { ok:false } 且**零登记**（调用方整批重试或放弃）。
     */
    registerLevels(entries) {
        try {
            if (!Array.isArray(entries) || entries.length === 0) {
                return { ok: false, error: 'entries must be a non-empty array' };
            }
            const parsed = [];
            for (let i = 0; i < entries.length; i++) {
                const e = entries[i];
                if (!e || typeof e !== 'object')
                    return { ok: false, error: `entry ${i}: not an object` };
                const key = cleanStr(e.semantics, 64);
                const level = e.level;
                if (key === undefined)
                    return { ok: false, error: `entry ${i}: semantics is required` };
                if (level !== 'compensable' && level !== 'irreversible') {
                    return { ok: false, error: `entry ${i} (${key}): level must be 'compensable' or 'irreversible'` };
                }
                if (parsed.some(p => p.semantics === key)) {
                    return { ok: false, error: `entry ${i}: duplicate semantics "${key}"` };
                }
                parsed.push({ semantics: key, level });
            }
            for (const p of parsed)
                extensionLevels.set(p.semantics, p.level);
            return { ok: true, registered: parsed.length };
        }
        catch {
            return { ok: false, error: 'internal registration failure — nothing registered' };
        }
    },
    /**
     * W9-2：基级查询（校准前的注册表基础级别 —— 双侧对齐律的校验锚点）。
     * 与 classify 的分野：classify 叠加证据门校准（只升不降）与保守律默认，
     * 结果是「当下该怎么派发」；levelOf 返回注册表里**登记了什么**（内置/
     * 扩展来源面），供装载面验证「文件说的级别 = 注册表登记的级别」——
     * 对齐律校验必须用基级，否则校准升级（安全方向）会被误判为不对齐。
     * 未知键 ⇒ null（诚实缺席，不猜）。
     */
    levelOf(semantics) {
        try {
            const key = cleanStr(semantics, 64);
            if (key === undefined)
                return null;
            const ext = extensionLevels.get(key);
            if (ext !== undefined)
                return { level: ext, source: 'extension' };
            const builtin = BUILTIN_LEVELS.get(key);
            if (builtin !== undefined)
                return { level: builtin, source: 'builtin' };
            return null;
        }
        catch {
            return null;
        }
    },
    /** 武装（幂等）：注入扩展级别表 / failureMemory 负证据只读查询。绝不抛。 */
    arm(opts = {}) {
        try {
            if (Array.isArray(opts.extensionLevels)) {
                const m = new Map();
                for (const e of opts.extensionLevels) {
                    const key = cleanStr(e?.semantics, 64);
                    if (key !== undefined && isLevel(e?.level))
                        m.set(key, e.level);
                }
                extensionLevels = m;
            }
            if ('negativeEvidenceQuery' in opts) {
                negativeEvidenceQuery = typeof opts.negativeEvidenceQuery === 'function' ? opts.negativeEvidenceQuery : null;
            }
        }
        catch { /* 武装失败 = 保持现状（诚实降级） */ }
    },
    /** 透明化（测试/遥测面）：证据账快照（深拷贝 —— 新的在后） */
    dumpEvidence() {
        return [...evidenceStore.entries()].map(([semantics, ev]) => ({
            semantics, adverse: ev.adverse, supportive: ev.supportive,
            posterior: Math.round(posteriorMean(ev) * 1000) / 1000,
        }));
    },
    /** 隔离缝（测试 beforeEach / 插件卸载）：扩展表/证据账/查询端口归零回缺省 */
    reset() {
        extensionLevels = new Map();
        evidenceStore = new Map();
        negativeEvidenceQuery = null;
    },
};
