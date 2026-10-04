// src/autonomy/autonomyConstitution.ts
// 纪元 Φ（Φ-8 自主宪法）：高度自主的前提是安全立法 —— 哪些动作允许自主做、哪些必须请示人类。
//
// 纪元 Ξ（Ξ-C 宪法接线）：卡死/步数两键接上内核注册表 —— 条文缺省在**构造期**经
// kernelRegistry.getOrDefault('constitution.maxNoEffect'|'constitution.maxSteps') 读值
// （未注册 ⇒ 原样回声字面量 3/40 ⇒ 行为与接线前逐字节一致；详见 defaultRules JSDoc）。
//
// ΑΩ-R43（扫描面分层）：律③文本扫描不再把 goalText 拼进动作面扫描串 —— 目标文本
// 的危险词信号降为「任务级背景风险」（backgroundRisk 标注，进判决书字段与 reason
// 供审计与认识论参考），不再直接顶格每步动作的风险档；动作面文本（label/payload）
// 扫描照旧全功率，destructive 硬法恒审批与「证据缺席 ⇒ 保守档保持」兜底不变
// （取舍论证与兜底清单详见 check() 律③注）。
//
// 定位：自主智能环的「法」，不是「执法者」—— 纯裁决（check 返回一份判决书），
// 不执行、不联网、无副作用、绝不抛异常。立法哲学三条：
//   1. 保守举证 —— 证据不全时向重取：宁多一次人工审批，不漏一次不可逆操作
//      （子串包含匹配沿 riskGate 同律，「payload」含「pay」子串会保守升级 ——
//      误拦的代价有界：多一次审批；漏拦的代价是数据/资金不可逆）；
//   2. 审批 ≠ 禁止 —— requiresApproval 说的是「人有最终裁决权」，动作本身仍
//      合法（allowed:true，批了就能做）；allowed:false 是「审批也救不了」的
//      硬停机（黑名单动作 / 卡死循环 / 步数超限 —— 卡死是停机问题，不是授权问题）；
//   3. 分权制衡 —— 凭据代输的运行时拦截由 src/riskGate.ts 独立管辖（一事一法源），
//      宪法只借其归一化匹配能力（同形字 / leet / 全角混淆免疫）扫描危险词，
//      不重复立法。normalizeForRisk 未从 riskGate 导出，经由 matchesDangerPatterns
//      间接复用其全部归一化能力（词表与待检文本同律归一）。
import { matchesDangerPatterns, DEFAULT_DANGER_PATTERNS, parseRiskPatterns } from '../riskGate.js';
import { kernelRegistry } from '../kernel/registry.js';
// ─── 常量与纯工具 ───
/** 缺省危险词表（与契约一致：数据灭失 + 资金离账的中英常见形态） */
const DEFAULT_FORBIDDEN_KEYWORDS = [
    '删除', '格式化', '清空', '支付', '转账', '注销', '卸载',
    'delete', 'format', 'payment', 'transfer',
];
/**
 * 缺省条文母本（**构造期铸** —— 纪元 Ξ 起不再是模块级常量，卡死/步数两键经生产
 * 内核注册表读值）：maxConsecutiveNoEffect = kernelRegistry.getOrDefault
 * ('constitution.maxNoEffect', 3)、maxTotalSteps = getOrDefault('constitution.maxSteps', 40)。
 *   · 构造期读表 ⇒ **注册须早于宪法构造**：生产侧 registerProductionKernels() 在宿主
 *     apply() 早期已在（且两键 specs 归批次 B 扩容进 PRODUCTION_KERNEL_SPECS 之前，
 *     未注册 ⇒ getOrDefault 原样回声字面量 3/40 ⇒ 行为与接线前逐字节一致 —— 既有
 *     测试锁 3/40 的照旧通过）；实验室侧 gym 的 buildLab 先入册、每轮 runTask 后铸
 *     宪法（顺序自查通过 —— 且 gym 宪法恒显式传两键，注册表读值不进 gym 闭环）。
 *   · 注册表值可能被进化成小数 ⇒ 消费处 Math.max(1, Math.round(v)) 正整数化
 *     （见 registryPositiveInt；非有限数回退字面量 —— registry.set 本拒非有限值，
 *     此为读侧防御）。
 * 每次调用铸全新母本（数组字段新铸 —— 外部拿不到内部可变引用，与旧
 * cloneRules(DEFAULT_RULES) 同防御强度）。
 */
function defaultRules() {
    return {
        allowAutonomousTiers: ['benign'],
        forbiddenActions: [],
        maxConsecutiveNoEffect: registryPositiveInt(kernelRegistry.getOrDefault('constitution.maxNoEffect', 3), 3),
        maxTotalSteps: registryPositiveInt(kernelRegistry.getOrDefault('constitution.maxSteps', 40), 40),
        forbiddenKeywords: [...DEFAULT_FORBIDDEN_KEYWORDS],
    };
}
/**
 * 注册表读值的正整数化（宪法两键消费处的防御）：Math.max(1, Math.round(v)) ——
 * registry 值可能被进化成小数（如 4.6 ⇒ 5）；非有限数回退 fallback。
 */
function registryPositiveInt(v, fallback) {
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.round(v)) : fallback;
}
/**
 * 不可逆词族（硬法 destructive 判据）：数据灭失族（删除/格式化/清空/抹掉/卸载/
 * 注销/重置/remove/erase/uninstall/reset）+ 系统还原族（恢复出厂/恢复默认/重置
 * 系统/restore factory/reset to default）+ 资金离账族（支付/付款/转账/提现/
 * pay/payment/transfer/withdraw）。命中 ⇒ destructive —— 即使白名单含 destructive
 * 也恒须审批（硬法：不可逆没有「自主授权」的立法通道）。
 * 纪元 Δ 扫描面修正：补系统还原族 —— 「OK 恢复出厂设置」「Restore factory
 * settings」这类按钮旧词面全不命中（「恢复出厂设置」不含「重置」子串），被判
 * benign 而被自主点击；系统还原 = 全盘数据灭失，风险与格式化同阶。
 * 注意与敏感族的分界：下单/购买/发送/提交（send/buy/checkout…）只是 sensitive ——
 * 订了单还没付钱，钱真正离账那一步才踩 destructive。
 */
const IRREVERSIBLE_WORDS = new Set([
    '删除', '移除', '格式化', '清空', '抹掉', '卸载', '注销', '重置',
    '恢复出厂', '恢复默认', '重置系统',
    '支付', '付款', '转账', '提现',
    'delete', 'remove', 'format', 'erase', 'uninstall', 'reset',
    'restore factory', 'reset to default',
    'pay', 'payment', 'transfer', 'withdraw',
]);
/** classifyRisk 的 type 分支判据 —— 外发/提交/安装/保存类敏感动词（csv，喂 riskGate 同律归一匹配） */
const SENSITIVE_VERBS_CSV = '发送,提交,上传,下载,安装,保存,购买,下单,send,submit,upload,download,install,save,purchase,buy,checkout';
/** classifyRisk 恒为 benign 的观察类动作：不改变世界，或只是读取/声明/等待/召回 */
const BENIGN_KINDS = new Set([
    'inspect', 'ask_vlm', 'recall_skill', 'wait', 'declare', 'scroll',
]);
/** 分层全序：destructive > sensitive > benign（取重函数的查表实现） */
const TIER_RANK = { benign: 0, sensitive: 1, destructive: 2 };
/** 两分层取重（证据冲突时宁信其险） */
function maxTier(a, b) {
    return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}
/** 未知值是否为合法分层（运行时收到的申报可能是任意垃圾） */
function isTier(v) {
    return v === 'benign' || v === 'sensitive' || v === 'destructive';
}
/** 字符串清单净化：滤非串/空白、trim、小写、去重（与 parseRiskPatterns 同律） */
function strList(v) {
    if (!Array.isArray(v))
        return [];
    return [
        ...new Set(v
            .filter((x) => typeof x === 'string' && x.trim() !== '')
            .map(x => x.trim().toLowerCase())),
    ];
}
/** 正整数净化：<1 / 非有限数 / 非数一律回退 fallback（0 步上限会当场瘫痪自主环，视为非法） */
function positiveInt(v, fallback) {
    return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
}
/** 深拷贝条文（getter 每次返回副本 —— 篡改判决依据不透内部） */
function cloneRules(r) {
    return {
        allowAutonomousTiers: [...r.allowAutonomousTiers],
        forbiddenActions: [...r.forbiddenActions],
        maxConsecutiveNoEffect: r.maxConsecutiveNoEffect,
        maxTotalSteps: r.maxTotalSteps,
        forbiddenKeywords: [...r.forbiddenKeywords],
    };
}
/** partial 条文合并：字段级「传了才覆写、垃圾收敛到缺省」，任何入参不抛（缺省母本构造期铸 —— 见 defaultRules） */
function mergeRules(partial) {
    const base = defaultRules();
    const p = partial;
    if (!p || typeof p !== 'object')
        return base;
    return {
        allowAutonomousTiers: Array.isArray(p.allowAutonomousTiers)
            ? p.allowAutonomousTiers.filter(isTier)
            : base.allowAutonomousTiers,
        forbiddenActions: p.forbiddenActions !== undefined ? strList(p.forbiddenActions) : base.forbiddenActions,
        maxConsecutiveNoEffect: positiveInt(p.maxConsecutiveNoEffect, base.maxConsecutiveNoEffect),
        maxTotalSteps: positiveInt(p.maxTotalSteps, base.maxTotalSteps),
        forbiddenKeywords: p.forbiddenKeywords !== undefined ? strList(p.forbiddenKeywords) : base.forbiddenKeywords,
    };
}
/** 安全序列化：payload 可能含循环引用 / BigInt 等让 JSON.stringify 炸裂之物 —— 一律收敛空串 */
function safeStringify(v) {
    try {
        if (v === undefined || v === null)
            return '';
        if (typeof v === 'string')
            return v;
        const s = JSON.stringify(v);
        return typeof s === 'string' ? s : '';
    }
    catch {
        return '';
    }
}
/**
 * ΑΩ-R43：把背景风险注记以分号缀进一句中文理由（句号收尾不变 —— 理由契约恒一句
 * 中文，注记不得破坏句读）。reason 不以句号收尾时防御性补句号：任何形态的入参
 * 都不抛、不吞原句。
 */
function appendNote(reason, fragment) {
    return reason.endsWith('。') ? `${reason.slice(0, -1)}；${fragment}。` : `${reason}；${fragment}。`;
}
// ─── 纯函数：词法分层 ───
/**
 * 动作词法分层（纯函数，绝不抛；垃圾动作收敛 benign）：
 *  - inspect / ask_vlm / recall_skill / wait / declare / scroll ⇒ benign（观察族，不改世界）；
 *  - click：目标 label 命中不可逆词族 ⇒ destructive（经 riskGate 归一化匹配，
 *    「dеlete」西里尔混淆同律命中）；其余 benign（敏感词由 check 的文本扫描律接管）；
 *  - type：payload 文本命中敏感动词族（发送/提交/send/submit…）⇒ sensitive；
 *  - hotkey：按键含 delete / backspace（大段删除）⇒ sensitive；
 *  - 其余（drag / escalate / 未知种类）⇒ benign —— 分层从证据出发，不凭空猜险。
 */
export function classifyRisk(action) {
    try {
        const a = (action ?? {});
        const kind = typeof a.kind === 'string' ? a.kind : '';
        if (BENIGN_KINDS.has(kind))
            return 'benign';
        if (kind === 'click') {
            const t = a.target;
            const label = t && typeof t.label === 'string' ? t.label : '';
            // 逐词喂给 riskGate（其内部对词表与 label 同律归一 —— 同形字/leet/全角混淆全数命中）
            const irreversibleCsv = [...IRREVERSIBLE_WORDS].join(',');
            return matchesDangerPatterns(label, irreversibleCsv) ? 'destructive' : 'benign';
        }
        if (kind === 'type') {
            return matchesDangerPatterns(safeStringify(a.payload), SENSITIVE_VERBS_CSV) ? 'sensitive' : 'benign';
        }
        if (kind === 'hotkey') {
            return matchesDangerPatterns(safeStringify(a.payload), 'delete,backspace') ? 'sensitive' : 'benign';
        }
        return 'benign';
    }
    catch {
        return 'benign'; // 绝不抛：词法分层失败等于无词法证据
    }
}
// ─── 宪法本体 ───
/**
 * Φ-8 自主宪法 —— 无状态、纯裁决、绝不抛异常。
 *
 * check() 六律（按序短路，先到先得；reason 恒一句中文）：
 *  ① 黑名单律：action.kind ∈ forbiddenActions ⇒ allowed:false（禁止 —— 黑名单
 *     是立法层的绝对保留，审批不可解锁；判决书仍携带 riskTier 供审计）；
 *  ② 分层取重律：riskTier = max(action.riskTier（申报）, classifyRisk(action)（词法）)
 *     —— destructive > sensitive > benign，证据冲突取重（宁信其险）；
 *  ③ 文本扫描律（ΑΩ-R43 扫描面分层）：动作面文本（target.label +
 *     JSON.stringify(payload)）经 riskGate 归一化匹配（词表 = forbiddenKeywords ∪
 *     DEFAULT_DANGER_PATTERNS ∪ IRREVERSIBLE_WORDS —— 纪元 Δ 起不可逆词族整族
 *     并入扫描面）：
 *     命中 ⇒ riskTier 至少 sensitive；命中不可逆词族（删除/格式化/清空/支付/转账
 *     及其同族英文）⇒ destructive。同形字混淆输入（「dеlete」西里尔 е、「支 付」
 *     插空、「ｆｏｒｍａｔ」全角、「d3lete」leet）与明文同律命中 —— 复用即得。
 *     goalText 不再拼进动作面扫描：其危险词信号降为「任务级背景风险」
 *     （backgroundRisk：high = 不可逆词族 / elevated = 一般危险词表），进判决书
 *     字段与 reason 注记供审计与宪法其他律参考，**不再直接顶格每步动作的风险档**
 *     —— ΑΩ-R43 取舍：背景风险 ≠ 动作风险（同一任务里 scroll 不因目标说「删除」
 *     而变 destructive；目标含「删除/支付」类词曾令整个任务的动作面恒顶格恒审批，
 *     自主环寸步难行），而真正的危险动作其 label/payload 自带词法证据、扫描照旧
 *     全功率，安全语义不松。保守兜底：动作面文本证据缺席（无 label 无 payload）
 *     而目标背景危险时，goalText 照旧顶格（证据缺席向重取）；动作自身命中不可逆
 *     词族的路径判决逐字节不变；
 *  ④ 审批律：riskTier ∉ allowAutonomousTiers ⇒ allowed:true + requiresApproval:true
 *     （须审批，**不是禁止** —— 审批是人的裁决权，批了就能做）。
 *     硬法条款：destructive 恒 requiresApproval:true —— 即使白名单显式含
 *     destructive（不可逆操作没有「自主授权」的立法通道，这是宪法的不可让渡条款）；
 *  ⑤ 卡死律：ctx.consecutiveNoEffect ≥ maxConsecutiveNoEffect ⇒ allowed:false
 *     （疑似卡死循环，强制停止并升级人工 —— 审批救不了死循环：那是停机问题，
 *     不是授权问题，故判决 requiresApproval:false）；
 *  ⑥ 步数律：ctx.stepsTaken ≥ maxTotalSteps ⇒ allowed:false（步数硬顶，同理）。
 *
 * 裁决序注：① 在决策上压过一切；②③ 为证据计算（不改变裁决顺序），判决书的
 * riskTier 字段恒为动作面全量证据之最重（申报 ∪ 词法 ∪ 动作面文本扫描 ——
 * ΑΩ-R43 起 goalText 背景风险不进 tier，唯动作面证据缺席的兜底路径例外）——
 * 即使被 ①/⑤/⑥ 禁止，也如实报告危险等级；goalText 背景风险经 backgroundRisk
 * 字段与 reason 注记另行留痕（供审计与宪法其他律参考）。
 * 任何内部异常 ⇒ 保守禁止（allowed:false）并升级人工 —— 宪法失灵时宁可停机。
 */
export class AutonomyConstitution {
    /** 净化合并后的条文（构造即定格，运行期不可变） */
    merged;
    constructor(rules) {
        // 构造净化绝不抛：垃圾入参（null / 非对象 / 字段类型错乱）逐项收敛到缺省
        // （缺省母本构造期铸：卡死/步数两键经生产注册表读值 —— 见 defaultRules JSDoc）
        this.merged = mergeRules(rules);
    }
    /** 条文副本（数组深拷贝 —— 篡改返回值不透内部判决依据） */
    get rules() {
        return cloneRules(this.merged);
    }
    /**
     * 宪法裁决：对一个待执行动作 + 现场账目出具判决书（六律见类 JSDoc）。
     * 输入缺字段按空/0 处理；任何内部异常收敛为保守禁止 —— 绝不抛、绝不凭空放行。
     */
    check(action, ctx) {
        let tier = 'benign'; // 异常路径下的兜底分层（catch 时保留已算得的最重证据）
        try {
            const a = (action ?? {});
            const c = (ctx ?? {});
            const kind = typeof a.kind === 'string' ? a.kind : '';
            // ② 分层取重：申报分层（垃圾值按 benign）与词法分层取重
            tier = maxTier(isTier(a.riskTier) ? a.riskTier : 'benign', classifyRisk(action));
            // ③ 文本扫描律：目标原文 + 点击目标标签 + 动作参数，经 riskGate 同律归一化匹配
            //    （不可逆词族整族并入并集 —— 纪元 Δ 前曾漏 'payment' 与系统还原族）。
            //    ΑΩ-R43 终版立法：本战役曾把 goalText 降为「任务级背景风险」（动作面全功
            //    率、目标词仅注记不顶格），但 Σ-3⑦（审批中断续跑）与 W7-D3（托管补偿）两
            //    条既有执法钉死「目标级危险词 ⇒ 保守顶格」是本项目刻意的安全立法 —— 可用
            //    性副作用让位于保守分层，故扫描面恢复旧律（goalText 并入，行为字节忠实）。
            //    ΑΩ-R43 的交付面收窄为纯审计标注：backgroundRisk 判决书字段 + reason 注记
            //    （把「目标背景高危」从隐式顶格变成显式可见账，零行为变化）。
            const t = a.target;
            const label = t && typeof t.label === 'string' ? t.label : '';
            const payloadText = safeStringify(a.payload);
            const actionScanText = [label, payloadText].filter(Boolean).join(' ');
            const goalText = typeof c.goalText === 'string' ? c.goalText : '';
            const scanText = [goalText, actionScanText].filter(Boolean).join(' ');
            const union = [
                ...this.merged.forbiddenKeywords,
                ...parseRiskPatterns(DEFAULT_DANGER_PATTERNS),
                ...IRREVERSIBLE_WORDS,
            ];
            const unionCsv = union.join(',');
            const irreversibleCsv = union.filter(w => IRREVERSIBLE_WORDS.has(w)).join(',');
            const actionIrreversible = matchesDangerPatterns(actionScanText, irreversibleCsv);
            if (matchesDangerPatterns(scanText, irreversibleCsv)) {
                tier = 'destructive'; // 不可逆词族命中：直接顶格
            }
            else if (matchesDangerPatterns(scanText, unionCsv)) {
                tier = maxTier(tier, 'sensitive'); // 一般危险词：至少 sensitive
            }
            // ΑΩ-R43 审计标注（零行为）：goalText 自身的词族别 —— high = 命中不可逆词族；
            // elevated = 仅命中一般危险词表。动作面自带不可逆证据的路径判决逐字节冻结
            // （无字段、无注记）；goalText 干净 ⇒ 无字段无注记（判决形态与旧律一致）。
            const goalIrreversible = matchesDangerPatterns(goalText, irreversibleCsv);
            const backgroundRisk = goalIrreversible
                ? 'high'
                : matchesDangerPatterns(goalText, unionCsv)
                    ? 'elevated'
                    : undefined;
            const note = (reason) => actionIrreversible || backgroundRisk === undefined
                ? reason
                : appendNote(reason, `ΑΩ-R43 背景风险 backgroundRisk=${backgroundRisk}（goalText 命中${goalIrreversible ? '不可逆词族' : '危险词表'}，已按旧律并入本步扫描面保守顶格，此标注仅供审计留痕）`);
            const backgroundRiskField = actionIrreversible || backgroundRisk === undefined ? {} : { backgroundRisk };
            // ① 黑名单律：立法层绝对保留 —— 审批不可解锁
            if (this.merged.forbiddenActions.includes(kind)) {
                return {
                    allowed: false,
                    riskTier: tier,
                    requiresApproval: false,
                    reason: note(`动作种类「${kind}」已列入宪法黑名单，禁止执行（审批不可解锁）。`),
                    ...backgroundRiskField,
                };
            }
            // ④ 审批律：白名单外 ⇒ 须审批（不是禁止）；destructive 硬法恒审批
            const inWhitelist = this.merged.allowAutonomousTiers.includes(tier);
            const requiresApproval = !inWhitelist || tier === 'destructive';
            // ⑤ 卡死律：连续无效果达上限 ⇒ 硬停机（审批救不了死循环）
            const noEffect = typeof c.consecutiveNoEffect === 'number' && Number.isFinite(c.consecutiveNoEffect)
                ? c.consecutiveNoEffect
                : 0;
            if (noEffect >= this.merged.maxConsecutiveNoEffect) {
                return {
                    allowed: false,
                    riskTier: tier,
                    requiresApproval: false,
                    reason: note(`连续 ${noEffect} 步无效果，疑似卡死循环，强制停止并升级人工裁决。`),
                    ...backgroundRiskField,
                };
            }
            // ⑥ 步数律：累计步数达硬顶 ⇒ 硬停机
            const steps = typeof c.stepsTaken === 'number' && Number.isFinite(c.stepsTaken) ? c.stepsTaken : 0;
            if (steps >= this.merged.maxTotalSteps) {
                return {
                    allowed: false,
                    riskTier: tier,
                    requiresApproval: false,
                    reason: note(`累计 ${steps} 步已达宪法步数上限 ${this.merged.maxTotalSteps}，强制停止并升级人工裁决。`),
                    ...backgroundRiskField,
                };
            }
            if (requiresApproval) {
                const why = tier === 'destructive' && inWhitelist
                    ? 'destructive 为硬法条款：即使列入自主白名单也一律须人工审批'
                    : `风险分层 ${tier} 不在自主白名单（${this.merged.allowAutonomousTiers.join('、') || '空'}）内`;
                return {
                    allowed: true,
                    riskTier: tier,
                    requiresApproval: true,
                    reason: note(`${why}，本动作须人工审批后方可执行。`),
                    ...backgroundRiskField,
                };
            }
            return {
                allowed: true,
                riskTier: tier,
                requiresApproval: false,
                reason: note(`风险分层 ${tier} 在自主白名单内且未触发黑名单、卡死、超步条款，准予自主执行。`),
                ...backgroundRiskField,
            };
        }
        catch (e) {
            // 宪法失灵时宁可停机：保守禁止并升级人工，绝不凭空放行
            const msg = e instanceof Error ? e.message : String(e);
            return {
                allowed: false,
                riskTier: tier,
                requiresApproval: false,
                reason: `宪法裁决内部异常（${msg}），保守禁止并升级人工。`,
            };
        }
    }
}
