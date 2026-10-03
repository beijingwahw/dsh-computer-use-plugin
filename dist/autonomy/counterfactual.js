// ─── 常量 ───
/** 效用权重缺省：进展 0.5 / 信息 0.3 / 风险 0.2（推进为主、信息次之、风险惩罚必在） */
const DEFAULT_WEIGHTS = { progress: 0.5, info: 0.3, risk: 0.2 };
/** 风险分层 → 风险分映射：benign=0.05 / sensitive=0.5 / destructive=1 */
const RISK_SCORES = { benign: 0.05, sensitive: 0.5, destructive: 1 };
/** 未知风险分层的保守记法（证据不足按需留意档） */
const RISK_UNKNOWN = 0.5;
/** 并列判定阈值：总效用差小于此值视为并列，取信息增益高者 */
const TIE_EPSILON = 0.01;
/**
 * W3-6（H3 换支重放）：改选偏置的择优效用加成。值即边界论证：三围 ∈ [0,1]、
 * 权重逐项夹 [0,1] ⇒ 诚实效用 U = w_p·p + w_i·i − w_r·r ∈ [−1, 2]，任意两候选
 * 的最大效用差严格小于 3；加成 3.5 > 3 ⇒ 只要被偏置候选在场，择优必被其决定
 * （偏好决定性 —— 「改选候选 k」的语义就是 k 被重放决策采纳）。偏置只进择优
 * 用力，绝不进 rawU：效用账面（rankTopK 的 utility、岔路账、落选理由数值）
 * 永远是未偏置的诚实预测。
 */
const STEER_BIAS_UTILITY = 3.5;
/**
 * W3-6（H3）：Top-K 排序的缺省深度 —— 岔路卡的三候选（Top-3）。
 * 值即边界：三支岔路覆盖「原路 + 两条最有竞争力的替代路」，再深则边际信息
 * 递减而卡面噪声明升（steer 一键三选的交互上限）。
 */
export const DEFAULT_TOP_K = 3;
/** actionSignature 截断上限（字符数） */
const SIGNATURE_MAX = 60;
/** 中日韩统一表意字符（含扩展 A / 兼容区）—— 2-gram 切分对象（自带副本，不 import policyEngine） */
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
/** 双语停用词（精简副本）—— 关键词重合打分的功能词滤除（判定性弱、误匹配率高） */
const STOPWORDS = new Set([
    '的', '了', '和', '与', '及', '或', '在', '是', '对', '从', '被', '把', '这', '那',
    '也', '又', '就', '都', '而', '则', '请', '不', '无', '于', '以', '为', '有', '个',
    '中', '并', '其', '之', '该', '当', '至', '给', '它', '你', '我',
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by',
    'is', 'are', 'be', 'been', 'was', 'were', 'this', 'that', 'these', 'those',
    'it', 'its', 'as', 'from', 'into', 'if', 'then', 'when', 'than', 'so', 'not',
    'no', 'yes', 'all', 'any', 'must', 'should', 'will', 'can',
]);
/** 空快照兜底 —— ctx.snapshot 缺席/脏值时的合成替身（零证据不伪造） */
const EMPTY_SNAPSHOT = {
    takenAt: 0,
    width: 0,
    height: 0,
    dhash: null,
    elements: [],
    textDigest: '',
    popups: [],
    focusedRegion: null,
    sceneLabel: '',
    degraded: [],
};
// ─── 内部纯函数工具（零副作用、零异常） ───
/** 空白折叠 + 小写化 —— 一切文本匹配/签名的前置归一 */
function normalizeText(s) {
    return typeof s === 'string' ? s.toLowerCase().replace(/\s+/g, ' ').trim() : '';
}
/** 数值夹 [0,1]；非有限数按 0 记（本器官一切产出都是有界概率） */
function clamp01(v) {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
    return Math.min(1, Math.max(0, n));
}
/** 保留两位小数（仅用于落选理由的展示，避免浮点尾噪；评分本体不取整） */
function round2(v) {
    return Math.round(v * 100) / 100;
}
/**
 * 轻量分词（自带，禁运行时 import policyEngine 的实现）：
 * 中文连续段按字符 2-gram（单字段保留单字）；英文/数字段按非字母数字切开取词；
 * 滤除停用词、纯数字与单个英文字母。输出按原文字符顺序（确定性）。
 */
function tokenize(text) {
    const norm = normalizeText(text);
    if (!norm)
        return [];
    const tokens = [];
    const push = (t) => {
        if (t.length === 0)
            return;
        if (/^\d+$/.test(t))
            return; // 纯数字：坐标/序号噪声
        if (STOPWORDS.has(t))
            return; // 停用词
        if (!CJK_RE.test(t) && t.length < 2)
            return; // 单个英文字母噪声
        tokens.push(t);
    };
    let cjkRun = '';
    let wordRun = '';
    const flushCjk = () => {
        if (!cjkRun)
            return;
        if (cjkRun.length === 1)
            push(cjkRun);
        else
            for (let i = 0; i + 1 < cjkRun.length; i += 1)
                push(cjkRun.slice(i, i + 2));
        cjkRun = '';
    };
    const flushWord = () => {
        if (wordRun) {
            push(wordRun);
            wordRun = '';
        }
    };
    for (const ch of norm) {
        if (CJK_RE.test(ch)) {
            flushWord();
            cjkRun += ch;
        }
        else if (/[a-z0-9]/.test(ch)) {
            flushCjk();
            wordRun += ch;
        }
        else {
            flushCjk();
            flushWord();
        } // 空白/标点皆切段
    }
    flushCjk();
    flushWord();
    return tokens;
}
/**
 * 目标关键词重合率 = |目标词 ∩ 动作词| / |目标词|（目标词为空 ⇒ 0）。
 * 关键词逐条再分词（短语关键词分解为 2-gram 后可与元素标签逐克相撞）；
 * 分母取目标词 —— 语义是「目标被该动作覆盖了几成」，而非「标签几成命中目标」。
 */
function overlapRate(goalKeywords, text) {
    const kws = Array.isArray(goalKeywords) ? goalKeywords : [];
    const goalTokens = new Set();
    for (const k of kws)
        for (const t of tokenize(k))
            goalTokens.add(t);
    if (goalTokens.size === 0)
        return 0;
    const textTokens = new Set(tokenize(text));
    let hit = 0;
    for (const t of goalTokens)
        if (textTokens.has(t))
            hit += 1;
    return clamp01(hit / goalTokens.size);
}
/** 快照元素表卫兵：缺席/脏值 ⇒ 空表 */
function elementsOf(snapshot) {
    return snapshot && Array.isArray(snapshot.elements) ? snapshot.elements : [];
}
/** 动作落点的原始标签（未归一，供展示）；无 target / 无标签 ⇒ '' */
function targetLabelRaw(action) {
    const a = action;
    const t = a?.target;
    return t && typeof t === 'object' && typeof t.label === 'string' ? t.label : '';
}
/** 动作文本：click/declare 重合打分的语料 —— target.label 优先，空标签回退 expectedEffect */
function actionText(action) {
    const label = targetLabelRaw(action);
    if (normalizeText(label) !== '')
        return label;
    return typeof action?.expectedEffect === 'string' ? action.expectedEffect : '';
}
/** 风险分层 → 风险分：benign=0.05 / sensitive=0.5 / destructive=1；未知 ⇒ 0.5 保守记 */
function riskOf(tier) {
    return typeof tier === 'string' && Number.isFinite(RISK_SCORES[tier]) ? RISK_SCORES[tier] : RISK_UNKNOWN;
}
/**
 * 进展先验（未乘重复折价的基础值）：
 * click/declare ⇒ 目标关键词重合度（见 overlapRate）；scroll/inspect ⇒ 0.25（探索性
 * 固定先验）；ask_vlm ⇒ 0.35；escalate ⇒ 0.1；recall_skill ⇒ 0.5；
 * 其余种类（type/hotkey/drag/wait）⇒ 0.2（保守中性先验）。
 */
function progressPrior(action, goalKeywords) {
    const kind = action?.kind;
    if (kind === 'click' || kind === 'declare')
        return overlapRate(goalKeywords, actionText(action));
    if (kind === 'scroll' || kind === 'inspect')
        return 0.25;
    if (kind === 'ask_vlm')
        return 0.35;
    if (kind === 'escalate')
        return 0.1;
    if (kind === 'recall_skill')
        return 0.5;
    return 0.2;
}
/** 数字卫兵（展示用坐标）：非有限数按 0 记 */
function n4(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
/**
 * 从快照推导的预期效果清单（每条一句中文、恒非空）：
 * click ⇒ 激活目标 +（label 未见于快照账本 ⇒ 可能揭示新界面）+（弹窗在场 ⇒ 可能消失）；
 * scroll ⇒ 视口按方向滚动；inspect ⇒ 焦点区/全画面放大细察；其余按动作语义记账。
 */
function deriveEffects(action, snapshot) {
    const kind = action?.kind;
    const payload = action?.payload && typeof action.payload === 'object'
        ? action.payload
        : {};
    const labelRaw = targetLabelRaw(action);
    const labelNorm = normalizeText(labelRaw);
    const effects = [];
    if (kind === 'click') {
        if (labelNorm !== '') {
            effects.push(`激活元素「${labelRaw}」`);
            const known = elementsOf(snapshot).some(el => normalizeText(el?.label) === labelNorm);
            if (!known)
                effects.push(`「${labelRaw}」未见于当前快照账本，点击可能揭示新界面`);
        }
        else {
            effects.push('点击落点生效（目标无标签）');
        }
        const popup = (Array.isArray(snapshot?.popups) ? snapshot.popups : []).find(p => typeof p === 'string' && p.trim() !== '');
        if (popup !== undefined)
            effects.push(`遮挡弹窗「${popup}」可能随之消失`);
    }
    else if (kind === 'scroll') {
        const dirText = payload.direction === 'up' ? '上'
            : payload.direction === 'left' ? '左'
                : payload.direction === 'right' ? '右'
                    : '下';
        effects.push(`视口向${dirText}滚动，未见内容进入视野`);
    }
    else if (kind === 'inspect') {
        const fr = snapshot?.focusedRegion;
        const regionLabel = fr && typeof fr === 'object'
            ? `焦点区(${n4(fr.x0)},${n4(fr.y0)})-(${n4(fr.x1)},${n4(fr.y1)})`
            : '当前画面';
        effects.push(`${regionLabel}被放大细察，可能识别出更精细的元素或文本`);
    }
    else if (kind === 'ask_vlm') {
        effects.push('云脑观察整屏并给出下一步建议');
    }
    else if (kind === 'declare') {
        const criterion = typeof payload.criterion === 'string' && payload.criterion.trim() !== '' ? payload.criterion : '';
        effects.push(criterion !== '' ? `宣称判据「${criterion}」达成，交验证层核对` : '宣称判据达成，交验证层核对');
    }
    else if (kind === 'escalate') {
        effects.push('控制权移交上游裁决，本轮不动世界');
    }
    else if (kind === 'recall_skill') {
        const id = typeof payload.skillId === 'string' && payload.skillId.trim() !== '' ? payload.skillId : '';
        effects.push(`技能流程展开执行${id !== '' ? `（${id}）` : ''}`);
    }
    else if (kind === 'wait') {
        effects.push('静止一拍，等待世界自行变化');
    }
    else if (kind === 'type') {
        effects.push('向焦点元素输入文本');
    }
    else if (kind === 'hotkey') {
        const keys = Array.isArray(payload.keys) ? payload.keys.filter(k => typeof k === 'string') : [];
        effects.push(`按下按键组合${keys.length > 0 ? `（${keys.join('+')}）` : ''}`);
    }
    else if (kind === 'drag') {
        effects.push('拖拽元素至目标位置');
    }
    if (effects.length === 0) {
        const fallback = typeof action?.expectedEffect === 'string' && action.expectedEffect.trim() !== '' ? action.expectedEffect : '';
        effects.push(fallback !== '' ? fallback : '世界状态改变');
    }
    return effects;
}
/** 权重卫兵：逐项取有限数并夹 [0,1]（负权重按 0 计——负效用权重会把「推进目标」
 *  变成惩罚项、把「风险」变成奖励项，属调用方脏值；>1 压回 1）；缺席/非法 ⇒ 缺省
 *  0.5/0.3/0.2；三项夹取后全零 ⇒ 整组回退缺省（全零效用恒 0，择优退化为输入序
 *  ——纪元 Δ 设防）。 */
function resolveWeights(w) {
    const src = (w && typeof w === 'object' ? w : {});
    const pick = (v, d) => typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d;
    const progress = pick(src.progress, DEFAULT_WEIGHTS.progress);
    const info = pick(src.info, DEFAULT_WEIGHTS.info);
    const risk = pick(src.risk, DEFAULT_WEIGHTS.risk);
    if (progress === 0 && info === 0 && risk === 0) {
        return { progress: DEFAULT_WEIGHTS.progress, info: DEFAULT_WEIGHTS.info, risk: DEFAULT_WEIGHTS.risk };
    }
    return { progress, info, risk };
}
/**
 * 评分内核（W3-6 从 scoreOptions 提取的共享底座，语义零变更）：
 * 三围计分律与原实现逐条相同（重复折价 / tried click 信息 0.1 / 风险映射），
 * 唯一增量是改选偏置 —— preferredActionKeys 命中者择优效用加 STEER_BIAS_UTILITY。
 */
function scoreAll(actions, c) {
    const snapshot = c.snapshot && typeof c.snapshot === 'object' ? c.snapshot : EMPTY_SNAPSHOT;
    const goalKeywords = Array.isArray(c.goalKeywords)
        ? c.goalKeywords.filter(k => typeof k === 'string')
        : [];
    const tried = new Set(Array.isArray(c.triedActionKeys) ? c.triedActionKeys.filter(k => typeof k === 'string') : []);
    // W3-6：改选偏置集合（空串剔除 —— 空签名会误伤无标签动作）
    const preferred = new Set(Array.isArray(c.preferredActionKeys)
        ? c.preferredActionKeys.filter(k => typeof k === 'string' && k !== '')
        : []);
    const w = resolveWeights(c.weights);
    return actions.map((action, index) => {
        const isTried = tried.has(actionSignature(action));
        const progress = clamp01(progressPrior(action, goalKeywords) * (isTried ? 0.6 : 1));
        const informationGain = action.kind === 'click' && isTried ? 0.1 : clamp01(expectedInformationGain(action, snapshot));
        const risk = riskOf(action.riskTier);
        const option = {
            action,
            predictedEffects: deriveEffects(action, snapshot),
            progressProbability: progress,
            informationGain,
            risk,
        };
        const rawU = w.progress * progress + w.info * informationGain - w.risk * risk;
        const steered = preferred.size > 0 && preferred.has(actionSignature(action));
        return { option, index, rawU, steered, utility: rawU + (steered ? STEER_BIAS_UTILITY : 0) };
    });
}
/**
 * 择优律本体（W3-6 提取，与既有 scoreOptions 内联实现逐字节同律）：
 * 先取择优效用最大者；与最大者差 < TIE_EPSILON 视为并列，并列取信息增益高者；
 * 信息增益亦并列取输入次序在前者 —— 全确定性、可回放。
 */
function pickWinner(entries) {
    let bestU = Number.NEGATIVE_INFINITY;
    for (const s of entries)
        if (s.utility > bestU)
            bestU = s.utility;
    const contenders = entries.filter(s => bestU - s.utility < TIE_EPSILON);
    let winIdx = 0;
    for (let i = 1; i < contenders.length; i += 1) {
        if (contenders[i].option.informationGain > contenders[winIdx].option.informationGain)
            winIdx = i;
    }
    return contenders[winIdx];
}
/**
 * 动作签名（纯函数、绝不抛异常）：`${kind}:${normalize(target.label)}` 截 60 字符。
 * 归一律 = 小写化 + 连续空白折叠单空格 + 去首尾；无 target 的动作 label 记空串
 * （如 'scroll:' —— 方向不参与签名，同向异向视为同族）。脏动作（null/非对象）⇒ ''。
 * triedActionKeys 清单与其同律生成，方能对得上号。
 */
export function actionSignature(action) {
    if (action === null || action === undefined || typeof action !== 'object')
        return '';
    const a = action;
    const kind = typeof a.kind === 'string' ? a.kind : '';
    const sig = `${kind}:${normalizeText(targetLabelRaw(a))}`;
    return sig.length > SIGNATURE_MAX ? sig.slice(0, SIGNATURE_MAX) : sig;
}
/**
 * 信息增益先验（纯函数、绝不抛异常）：该动作能让「未见过的东西」进入视野的概率。
 *   scroll ⇒ 0.8（新视野是最稳的信息源）；inspect ⇒ 0.7（放大细察现视野的盲区）；
 *   ask_vlm ⇒ 0.6（云脑整屏观察补盲）；
 *   click ⇒ 0.3 起：target.label 归一后未恒等见于快照 elements 任一 label（陌生
 *   目标）⇒ +0.1 = 0.4 —— 快照账本之外的东西多半牵出新界面；无标签目标无陌生度
 *   可谈，仍 0.3；
 *   declare / escalate / wait ⇒ 0（既不动视野也不动世界）；
 *   其余种类（type/hotkey/drag/recall_skill）⇒ 0.2（中性先验）。
 * 「已试过」的折价（tried click ⇒ 0.1）由 scoreOptions 执法 —— 本函数只看动作与
 * 世界快照本身，不携带行动史。
 */
export function expectedInformationGain(action, snapshot) {
    const a = action;
    if (a === null || a === undefined || typeof a !== 'object')
        return 0;
    switch (a.kind) {
        case 'scroll':
            return 0.8;
        case 'inspect':
            return 0.7;
        case 'ask_vlm':
            return 0.6;
        case 'click': {
            const label = normalizeText(targetLabelRaw(a));
            if (label === '')
                return 0.3;
            const known = elementsOf(snapshot).some(el => normalizeText(el?.label) === label);
            return known ? 0.3 : 0.4;
        }
        case 'declare':
        case 'escalate':
        case 'wait':
            return 0;
        default:
            return 0.2;
    }
}
/**
 * 反事实评分主入口（纯函数、绝不抛异常）。
 *
 * 三围计分律：
 *  · progressProbability（与目标关键词的语义重合度，0..1）：
 *    - click / declare ⇒ 目标关键词与动作文本（target.label，空标签回退
 *      expectedEffect）的重合率 = |目标词 ∩ 动作词| / |目标词|（自带中文 2-gram +
 *      英文单词分词，去停用词/纯数字；目标词为空 ⇒ 0）；
 *    - scroll / inspect ⇒ 0.25（探索性固定先验）；ask_vlm ⇒ 0.35；
 *      escalate ⇒ 0.1；recall_skill ⇒ 0.5；
 *    - 其余种类（type/hotkey/drag/wait）⇒ 0.2（保守中性先验）；
 *    - 已试过（actionSignature ∈ triedActionKeys）⇒ progressProbability ×0.6
 *      （重复折价，对一切种类生效）。
 *  · informationGain（让「未见过的东西」进入视野的概率，0..1）：先验见
 *    expectedInformationGain 的 JSDoc；scoreOptions 额外执法 —— 已试过的 click
 *    ⇒ 0.1（重复点同一处，再见新物的概率骤降；其余种类不因 tried 折信息分）。
 *  · risk（0..1）：按 riskTier 映射 benign=0.05 / sensitive=0.5 / destructive=1，
 *    未知分层按 0.5 保守记。
 *
 * 总效用与择优律：
 *   U = w_p·progressProbability + w_i·informationGain − w_r·risk
 *   （w_p/w_i/w_r 缺省 0.5/0.3/0.2，ctx.weights 逐项覆盖，非有限数按缺省记）；
 *   先取 U 最大者；与最大者差 <0.01 视为并列，并列取 informationGain 高者；
 *   信息增益亦并列取输入次序在前者 —— 全确定性、可回放。
 *   W3-6（H3）注入缝：ctx.preferredActionKeys 命中的候选在择优中获得
 *   STEER_BIAS_UTILITY 决定性加成（换支重放的「改选候选 k」偏置）—— 偏置只
 *   改选择，rawU 与落选理由的数值仍是诚实预测；缝缺席时本函数行为与既有
 *   语义逐字节一致。
 *
 * 防御律：options 非数组或滤除脏条目（null/非对象）后为空 ⇒ 返回 null（空输入不
 * 伪造计划）；ctx / ctx.snapshot / goalKeywords 脏值按空上下文（空快照 + 零关键
 * 词）处理。rejected 按输入次序收录全部落选者，各带一句中文理由。
 */
export function scoreOptions(options, ctx) {
    const raw = Array.isArray(options) ? options : [];
    const actions = raw.filter(a => a !== null && a !== undefined && typeof a === 'object');
    if (actions.length === 0)
        return null;
    const scored = scoreAll(actions, (ctx ?? {}));
    const winner = pickWinner(scored);
    const rejected = scored
        .filter(s => s !== winner)
        .map(s => ({
        option: s.option,
        why: winner.steered
            // W3-6：胜者由改选偏置提升 ⇒ 落选理由如实申报偏置在场，数值用诚实 rawU
            ? `用户改选偏置将「${actionSignature(winner.option.action)}」定为胜者（其原始总效用 ${round2(winner.rawU)}，本候选 ${round2(s.rawU)}；偏置只改选择，不改预测）`
            : winner.utility - s.utility < TIE_EPSILON
                ? `总效用 ${round2(s.utility)} 与胜者 ${round2(winner.utility)} 并列（差 <0.01），信息增益 ${round2(s.option.informationGain)} 较低而落选`
                : `总效用 ${round2(s.utility)} 低于胜者 ${round2(winner.utility)}（进展 ${round2(s.option.progressProbability)}/信息 ${round2(s.option.informationGain)}/风险 ${round2(s.option.risk)}）`,
    }));
    return { chosen: winner.option, rejected };
}
/**
 * W3-6（H3）：Top-K 候选排序（纯函数、绝不抛异常；空候选集 ⇒ null 不伪造）。
 *
 * 排序律与择优律同源（同一 scoreAll 内核 + pickWinner 逐名抽取）：每轮在剩余
 * 候选中按「择优效用最大 → ε 并列取信息增益高 → 最早输入序」抽出一名，抽满
 * k 名或候选耗尽为止 ⇒ rank 1 与 scoreOptions(同输入).chosen 严格一致（择优
 * 单点 = 排序序列的头部，效用账与决策账互证）。
 *
 * 效用纪律：utility 字段恒为 rawU（诚实预测，未含 STEER_BIAS）；改选偏置只
 * 影响**名次**（被偏置者升到 rank 1），不污染账面 —— 岔路卡展示给用户的是
 * 未偏置的预测值，重放后的复盘与原决策可直接对照。
 *
 * 防御律：options 非数组 / 滤脏后为空 ⇒ null；k 非法（非有限数）⇒ 缺省
 * DEFAULT_TOP_K，<1 夹 1；ctx 脏值按空上下文处理（与 scoreOptions 同律）。
 */
export function rankTopK(options, ctx, k) {
    const raw = Array.isArray(options) ? options : [];
    const actions = raw.filter(a => a !== null && a !== undefined && typeof a === 'object');
    if (actions.length === 0)
        return null;
    const depth = typeof k === 'number' && Number.isFinite(k) ? Math.max(1, Math.floor(k)) : DEFAULT_TOP_K;
    const remaining = scoreAll(actions, (ctx ?? {}));
    const ranked = [];
    while (ranked.length < depth && remaining.length > 0) {
        const winner = pickWinner(remaining);
        ranked.push({ rank: ranked.length + 1, option: winner.option, utility: winner.rawU, steered: winner.steered });
        remaining.splice(remaining.indexOf(winner), 1);
    }
    return ranked;
}
