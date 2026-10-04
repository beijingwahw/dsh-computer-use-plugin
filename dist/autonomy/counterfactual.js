// W6-1（doctor 债清偿·smell.over-engineering）：内部纯函数工具区与配套常量
// （分词/重合打分/风险映射/先验/效果推导/权重卫兵）逐字节搬至 ./counterfactualUtil —— 纯函数零状态，导入面不变。
import { clamp01, deriveEffects, elementsOf, normalizeText, progressPrior, quantizedScreenTypeOf, resolveWeights, riskOf, round2, targetLabelRaw, transitionActionKeyOf, } from './counterfactualUtil.js';
// ─── 常量 ───
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
// ─── 导出纯函数 ───
// ── ΝΩ-46（model-based 反事实）：世界模型只读面的模块默认接线 ──
/**
 * ΝΩ-46：进程级默认世界模型只读面（模块持有者）。为什么需要模块默认：
 * 生产决策面（policyEngineUtil.breakTieBand / autoPilot 岔路账的 ScoringContext
 * 铸造点）不携带 worldModel 字段——只读面经接线层（autonomy/index.ts 的
 * buildAutonomyStack）一次性注入此处，评分内核 scoreAll 对缺席字段回落本默认
 * ⇒ 真实转移分布进决策面而无需改动任何调用方。实验室 gym 不经 buildAutonomy
 * 铸栈 ⇒ 本默认恒 null（确定性不变）；未接线进程同律（零回归红律）。
 * 最新铸栈胜出：off 栈（enableProphecy=false）铸栈即清除旧接线。
 */
let wiredWorldModel = null;
/**
 * ΝΩ-46：注入（或清除）模块默认世界模型只读面（纯赋值，绝不抛）。
 * 脏端口（null / 非对象 / 无 predict 函数）按清除记。测试隔离：传 null 复位。
 */
export function wireCounterfactualWorldModel(port) {
    wiredWorldModel =
        port !== null && port !== undefined && typeof port === 'object' && typeof port.predict === 'function'
            ? port
            : null;
}
/** ΝΩ-46：模块默认只读面是否在场（接线开关的观察位 —— w4wire 两向断言用） */
export function counterfactualWorldModelWired() {
    return wiredWorldModel !== null;
}
/**
 * ΝΩ-46：世界模型只读面解析 —— ctx 显式注入优先，缺席回落模块默认接线；
 * 两层都缺席/脏形 ⇒ null（中性因子，逐字节旧路径）。
 */
function resolveWorldModelPort(explicit) {
    if (explicit !== null && explicit !== undefined && typeof explicit === 'object' &&
        typeof explicit.predict === 'function') {
        return explicit;
    }
    return wiredWorldModel;
}
/**
 * ΝΩ-46：转移置信因子（纯函数、绝不抛）—— model-based 反事实的乘子：
 *   · 端口缺席 / 非 click 种类 / 盲屏（快照无 dhash）/ 无落点（动作键无 '@' 格）/
 *     no-model（predict 返回 top:null）/ 端口抛错或坏形状 ⇒ 1.0 中性（零回归）；
 *   · 命中 ⇒ 0.5 + 0.5·clamp01(top.prob)：历史证据支持该 (屏型, 动作格) 有转移
 *     ⇒ 高置信逼近 ×1.0（纯加权不放大），低置信逼近 ×0.5（衰减）——**无证据
 *     恒中性、有证据只折不加**，模型无知绝不惩罚新探索。
 * 键方言：fromType = 量化屏型（快照 dhash 经 counterfactualUtil 的
 * quantizedScreenTypeOf——与 prophecy 单源对齐）；actionKey = 4×4 格动作键
 * （transitionActionKeyOf 同律，参考宽高取快照 width/height）——与 prophecy
 * 结算回灌 observe 的写键同表同格（同屏同键，读的正是它学到的分布）。
 */
export function transitionConfidenceFactor(port, snapshot, action) {
    try {
        if (port === null || port === undefined || typeof port.predict !== 'function')
            return 1;
        const a = action;
        if (a === null || a === undefined || typeof a !== 'object' || a.kind !== 'click')
            return 1;
        const s = (snapshot ?? null);
        const dhash = s?.dhash;
        if (typeof dhash !== 'string' || dhash === '')
            return 1; // 盲屏：无屏型身份不可对键
        const width = s?.width;
        const height = s?.height;
        const actionKey = transitionActionKeyOf(a, width, height);
        if (!actionKey.includes('@'))
            return 1; // 无落点/坏几何 ⇒ 无格不可对键
        const out = port.predict(quantizedScreenTypeOf(dhash), actionKey);
        if (out === null || out === undefined || typeof out !== 'object')
            return 1; // no-model 中性
        const top = out.top;
        if (top === null || top === undefined || typeof top !== 'object')
            return 1; // no-model 中性
        const prob = top.prob;
        if (typeof prob !== 'number' || !Number.isFinite(prob))
            return 1; // 无概率读数不可定价 ⇒ 中性
        return 0.5 + 0.5 * clamp01(prob);
    }
    catch {
        return 1; // 读模型是旁路增益不是评分前提 —— 任何故障中性直通，绝不炸评分
    }
}
/**
 * 评分内核（W3-6 从 scoreOptions 提取的共享底座，语义零变更）：
 * 三围计分律与原实现逐条相同（重复折价 / tried click 信息 0.1 / 风险映射），
 * 唯一增量是改选偏置 —— preferredActionKeys 命中者择优效用加 STEER_BIAS_UTILITY。
 * ΝΩ-10（infoGain 新鲜度）：ctx.noEffectActionKeys 在场 ⇒ click 信息增益改走
 * expectedInformationGain 的新鲜度计分（含从未点过 +0.15 / 点过且 no_effect −0.1），
 * 旧律的「tried click 恒 0.1」只在该字段缺席时执法 —— 既有调用方逐字节零漂移。
 * ΝΩ-46（model-based 反事实）：世界模型只读面（ctx.worldModel 显式优先、模块
 * 默认接线兜底）在场且 click 候选的 (量化屏型 × 4×4 动作格) 在转移表有证据 ⇒
 * progress 乘 (0.5 + 0.5·top.prob) 置信因子（transitionConfidenceFactor）；
 * 无证据/缺席/非 click ⇒ 乘 1.0 中性 —— 未接线调用方逐字节零漂移。
 */
function scoreAll(actions, c) {
    const snapshot = c.snapshot && typeof c.snapshot === 'object' ? c.snapshot : EMPTY_SNAPSHOT;
    const goalKeywords = Array.isArray(c.goalKeywords)
        ? c.goalKeywords.filter(k => typeof k === 'string')
        : [];
    const tried = new Set(Array.isArray(c.triedActionKeys) ? c.triedActionKeys.filter(k => typeof k === 'string') : []);
    // ΝΩ-10：no_effect 签名集 —— 字段缺席（undefined）即旧律；在场（含空数组）即
    // 新鲜度计分（空集 = 全部已试动作都不是 no_effect，点过即走「点过未失灵」臂）。
    const noEffect = Array.isArray(c.noEffectActionKeys)
        ? new Set(c.noEffectActionKeys.filter(k => typeof k === 'string'))
        : undefined;
    const freshness = noEffect === undefined ? undefined : { triedClickKeys: tried, noEffectClickKeys: noEffect };
    // W3-6：改选偏置集合（空串剔除 —— 空签名会误伤无标签动作）
    const preferred = new Set(Array.isArray(c.preferredActionKeys)
        ? c.preferredActionKeys.filter(k => typeof k === 'string' && k !== '')
        : []);
    // ΝΩ-46：世界模型只读面 —— 显式注入优先，缺席回落模块默认接线（均缺席 ⇒ null 中性）
    const worldModel = resolveWorldModelPort(c.worldModel);
    const w = resolveWeights(c.weights);
    return actions.map((action, index) => {
        const isTried = tried.has(actionSignature(action));
        // ΝΩ-46：转移置信因子只乘 click 的 progress（其余种类 ×1.0 —— 模型只按
        //（屏型 × 点击格）积累指针转移证据，先验族不受它辖制）。
        const progress = clamp01(progressPrior(action, goalKeywords) * (isTried ? 0.6 : 1) *
            transitionConfidenceFactor(worldModel, snapshot, action));
        const informationGain = action.kind === 'click' && isTried && freshness === undefined
            ? 0.1
            : clamp01(expectedInformationGain(action, snapshot, freshness));
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
 *
 * ΝΩ-10（infoGain 新鲜度）：freshness 在场（调用方自 ScoringContext 透传）时，
 * click 的信息增益在快照陌生度基线（0.3/0.4）上叠新鲜度修正：
 *   · 该落点从未被点击过（签名 ∉ triedClickKeys）⇒ +0.15 —— 带内候选此前只剩
 *     「标签是否见于快照账本」一个单维（而带内候选全部来自快照 ⇒ 恒 0.3，并列
 *     破平形同虚设），新鲜度让「没试过的落点」真正分出高下；
 *   · 点过且结局 no_effect（签名 ∈ noEffectClickKeys）⇒ −0.1 —— 点了没动静的
 *     地方，再见新物的概率应低于快照陌生度先验的估计；
 *   · 点过但结局非 no_effect（有进展/退化等）⇒ 不修正 —— 旧路径已由 progress
 *     侧的重复折价（×0.6）记账，信息侧不双重惩罚。
 * freshness 缺席 ⇒ 本函数返回值与旧版逐字节相同（既有调用方零漂移）。
 */
export function expectedInformationGain(action, snapshot, freshness) {
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
            let base = 0.3;
            if (label !== '') {
                const known = elementsOf(snapshot).some(el => normalizeText(el?.label) === label);
                base = known ? 0.3 : 0.4;
            }
            if (freshness === null || freshness === undefined || typeof freshness !== 'object')
                return base;
            // ΝΩ-10 新鲜度修正（次序：no_effect 臂优先于从未点过臂 —— no_effect 必已点过）
            const sig = actionSignature(action);
            if (freshness.noEffectClickKeys !== undefined && freshness.noEffectClickKeys.has(sig)) {
                return clamp01(base - 0.1);
            }
            if (freshness.triedClickKeys === undefined || !freshness.triedClickKeys.has(sig)) {
                return clamp01(base + 0.15);
            }
            return base;
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
 *      （重复折价，对一切种类生效）；
 *    - ΝΩ-46：ctx.worldModel（或模块默认接线）在场时，click 候选再乘转移置信
 *      因子 (0.5 + 0.5·top.prob)——世界模型按（量化屏型 × 4×4 动作格）积累的
 *      真实转移分布进效用评分（只读旁路，键方言与 prophecy 单源对齐）；无证据/
 *      端口缺席 ⇒ ×1.0 中性（零回归）。
 *  · informationGain（让「未见过的东西」进入视野的概率，0..1）：先验见
 *    expectedInformationGain 的 JSDoc；scoreOptions 额外执法 —— 已试过的 click
 *    ⇒ 0.1（重复点同一处，再见新物的概率骤降；其余种类不因 tried 折信息分）。
 *    ΝΩ-10：ctx.noEffectActionKeys 在场时 click 改走新鲜度计分（从未点过 +0.15 /
 *    点过且 no_effect −0.1，见 expectedInformationGain），旧律仅在该字段缺席时
 *    执法 —— 既有调用方逐字节零漂移。
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
