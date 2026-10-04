// ─── 常量（随工具区同迁 —— 仅被本区函数消费） ───
/** 效用权重缺省：进展 0.5 / 信息 0.3 / 风险 0.2（推进为主、信息次之、风险惩罚必在） */
export const DEFAULT_WEIGHTS = { progress: 0.5, info: 0.3, risk: 0.2 };
/** 风险分层 → 风险分映射：benign=0.05 / sensitive=0.5 / destructive=1 */
export const RISK_SCORES = { benign: 0.05, sensitive: 0.5, destructive: 1 };
/** 未知风险分层的保守记法（证据不足按需留意档） */
export const RISK_UNKNOWN = 0.5;
/** 中日韩统一表意字符（含扩展 A / 兼容区）—— 2-gram 切分对象（自带副本，不 import policyEngine） */
export const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
/** 双语停用词（精简副本）—— 关键词重合打分的功能词滤除（判定性弱、误匹配率高） */
export const STOPWORDS = new Set([
    '的', '了', '和', '与', '及', '或', '在', '是', '对', '从', '被', '把', '这', '那',
    '也', '又', '就', '都', '而', '则', '请', '不', '无', '于', '以', '为', '有', '个',
    '中', '并', '其', '之', '该', '当', '至', '给', '它', '你', '我',
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by',
    'is', 'are', 'be', 'been', 'was', 'were', 'this', 'that', 'these', 'those',
    'it', 'its', 'as', 'from', 'into', 'if', 'then', 'when', 'than', 'so', 'not',
    'no', 'yes', 'all', 'any', 'must', 'should', 'will', 'can',
]);
// ─── 内部纯函数工具（零副作用、零异常） ───
/** 空白折叠 + 小写化 —— 一切文本匹配/签名的前置归一 */
export function normalizeText(s) {
    return typeof s === 'string' ? s.toLowerCase().replace(/\s+/g, ' ').trim() : '';
}
/** 数值夹 [0,1]；非有限数按 0 记（本器官一切产出都是有界概率） */
export function clamp01(v) {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
    return Math.min(1, Math.max(0, n));
}
/** 保留两位小数（仅用于落选理由的展示，避免浮点尾噪；评分本体不取整） */
export function round2(v) {
    return Math.round(v * 100) / 100;
}
/**
 * 轻量分词（自带，禁运行时 import policyEngine 的实现）：
 * 中文连续段按字符 2-gram（单字段保留单字）；英文/数字段按非字母数字切开取词；
 * 滤除停用词、纯数字与单个英文字母。输出按原文字符顺序（确定性）。
 */
export function tokenize(text) {
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
export function overlapRate(goalKeywords, text) {
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
export function elementsOf(snapshot) {
    return snapshot && Array.isArray(snapshot.elements) ? snapshot.elements : [];
}
/** 动作落点的原始标签（未归一，供展示）；无 target / 无标签 ⇒ '' */
export function targetLabelRaw(action) {
    const a = action;
    const t = a?.target;
    return t && typeof t === 'object' && typeof t.label === 'string' ? t.label : '';
}
/** 动作文本：click/declare 重合打分的语料 —— target.label 优先，空标签回退 expectedEffect */
export function actionText(action) {
    const label = targetLabelRaw(action);
    if (normalizeText(label) !== '')
        return label;
    return typeof action?.expectedEffect === 'string' ? action.expectedEffect : '';
}
/** 风险分层 → 风险分：benign=0.05 / sensitive=0.5 / destructive=1；未知 ⇒ 0.5 保守记 */
export function riskOf(tier) {
    return typeof tier === 'string' && Number.isFinite(RISK_SCORES[tier]) ? RISK_SCORES[tier] : RISK_UNKNOWN;
}
/**
 * 进展先验（未乘重复折价的基础值）：
 * click/declare ⇒ 目标关键词重合度（见 overlapRate）；scroll/inspect ⇒ 0.25（探索性
 * 固定先验）；ask_vlm ⇒ 0.35；escalate ⇒ 0.1；recall_skill ⇒ 0.5；
 * 其余种类（type/hotkey/drag/wait）⇒ 0.2（保守中性先验）。
 */
export function progressPrior(action, goalKeywords) {
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
export function n4(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
/**
 * 从快照推导的预期效果清单（每条一句中文、恒非空）：
 * click ⇒ 激活目标 +（label 未见于快照账本 ⇒ 可能揭示新界面）+（弹窗在场 ⇒ 可能消失）；
 * scroll ⇒ 视口按方向滚动；inspect ⇒ 焦点区/全画面放大细察；其余按动作语义记账。
 */
export function deriveEffects(action, snapshot) {
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
export function resolveWeights(w) {
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
