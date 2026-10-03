import { onToolPre } from './hooks.js';
import { adviseAction, costPriorOfCall } from '../autonomy/uncertainty.js';
import { scoreOptions } from '../autonomy/counterfactual.js';
import { similarity } from '../perceptualHash.js';
import { matchesDangerPatterns } from '../riskGate.js';
import { approval } from '../approval.js';
import { telemetry } from '../telemetry.js';
import { focusTracker } from '../focusTracker.js';
import * as physicalBackend from '../physicalBackend.js';
import { getPopupState } from './popupGuard.js';
// ─── 契约类型 ───
/** 受金丝雀约束的动作工具（与 actionGate 的 ActionKind 同一集合：直触物理世界且携带可判定语义面） */
export const CANARY_ACTION_TOOLS = new Set(['click_mouse', 'type_text']);
/** 探针预算缺省：每会话（≈每任务）最多试演 6 次 —— 增益有度，绝不喧宾夺主 */
export const CANARY_PROBE_BUDGET_DEFAULT = 6;
/** 复位通道地板：探针复原后区域相似度低于此 ⇒ 净变化 ⇒ 分歧（预测是「可复原」） */
export const CANARY_RESTORE_FLOOR_DEFAULT = 0.9;
// ─── 幂等词汇表（点击类可逆探针的准入判据） ───
/**
 * 幂等切换词汇表（W2-7）：目标标签命中 ⇒ 点击+回点论证为可逆（展开/收起、
 * 菜单开合这类「再点一次就回去」的控件）。命中不了就没有可逆探针可言 ——
 * 「提交/发送」类一次性按钮点击两次比点一次更糟，绝不入选（且那类早已被
 * dangerPatterns 划入 destructive 豁免）。
 */
const TOGGLE_LEXICON = /expand|collapse|toggle|dropdown|fold|unfold|chevron|more|less|menu|filter|show|hide|switch|options?|settings?|gear|展开|收起|折叠|切换|菜单|更多|更少|筛选|箭头|选项|设置|齿轮/i;
/** 目标标签是否为幂等切换候选（纯函数：非字符串/空串 ⇒ false —— 无法论证可逆） */
export function isIdempotentToggleLabel(label) {
    if (typeof label !== 'string')
        return false;
    const t = label.trim();
    if (t.length === 0 || t.length > 200)
        return false;
    return TOGGLE_LEXICON.test(t);
}
// ─── 纯函数：触发分类 ───
/** 从工具参数提取字符串（类型收口：非字符串真值一律按缺席） */
function strArg(v) {
    return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}
/**
 * 触发分类（纯函数，绝不抛异常）：一次工具调用是否需要金丝雀试演。
 *
 * 判序（依序短路）：
 *   1. 非 click_mouse / type_text ⇒ skip not-action-tool；
 *   2. approval_token 在场且已授予有效 ⇒ skip approval-present（人已裁决）；
 *   3. destructive：显式 risk_tier='destructive' 或 target_description /
 *      expected_text 命中 dangerPatterns ⇒ exempt-destructive（不试演，
 *      放行给既有审批闸门直接审批 —— 试演一次性按钮是二次伤害）；
 *   4. 探针预算耗尽 ⇒ skip budget-exhausted；
 *   5. costPriorOfCall 代价档非 high ⇒ skip low-cost（低危不触发）；
 *   6. adviseAction（confidence=args.confidence，缺省 0 —— 无自报置信认识论
 *      不会放行 high 档）未判 proceed ⇒ skip not-proceed；
 *   7. 探针计划：click 须有合法归一化坐标 + 幂等切换标签；type 恒有
 *      （单字符退格）。不可满足 ⇒ skip no-reversible-probe；
 *   8. predictedEffects 缺席 ⇒ skip prediction-unavailable（无比对基准）。
 */
export function classifyCanaryTrigger(tool, args, opts = {}) {
    const a = args !== null && typeof args === 'object' ? args : {};
    if (!CANARY_ACTION_TOOLS.has(tool)) {
        return { kind: 'skip', why: 'not-action-tool', note: '非动作类工具，与金丝雀无关' };
    }
    // 2. 人已裁决：已授予的有效令牌 ⇒ 让位（金丝雀不重复打扰）
    const token = strArg(a.approval_token);
    if (token) {
        try {
            if (approval.validate(token)) {
                return { kind: 'skip', why: 'approval-present', note: '已持有效已授予审批令牌，人已裁决' };
            }
        }
        catch {
            /* 审批簿读失败按无令牌继续 —— 绝不因旁路异常拦截主路径 */
        }
    }
    // 3. destructive 豁免：显式分层或危险词命中（J-14 双通道同律：description ∪ expected_text）
    const desc = strArg(a.target_description);
    const expectedText = strArg(a.expected_text);
    const dangerHit = (desc !== undefined && matchesDangerPatterns(desc, opts.dangerPatterns ?? '')) ||
        (expectedText !== undefined && matchesDangerPatterns(expectedText, opts.dangerPatterns ?? ''));
    if (a.risk_tier === 'destructive' || dangerHit) {
        return {
            kind: 'exempt-destructive',
            note: 'destructive 档豁免试演：直接放行给既有审批闸门（那类动作本就该直接审批）',
        };
    }
    // 4. 预算封顶
    const cap = typeof opts.probeBudgetCap === 'number' && Number.isFinite(opts.probeBudgetCap)
        ? Math.max(0, Math.floor(opts.probeBudgetCap))
        : CANARY_PROBE_BUDGET_DEFAULT;
    const used = typeof opts.probeBudgetUsed === 'number' && Number.isFinite(opts.probeBudgetUsed)
        ? Math.max(0, opts.probeBudgetUsed)
        : 0;
    if (used >= cap) {
        return { kind: 'skip', why: 'budget-exhausted', note: `探针预算耗尽（${used}/${cap}），让位放行` };
    }
    // 5. 代价档：非 high 不触发（低危放行是认识论的裁定，金丝雀不加戏）
    const consequenceDeclared = strArg(a.expected_change) !== undefined || strArg(a.expected_text) !== undefined;
    const cost = costPriorOfCall(tool === 'click_mouse' ? 'click' : 'type', {
        declaredTier: a.risk_tier,
        consequenceDeclared,
    });
    if (cost !== 'high') {
        return { kind: 'skip', why: 'low-cost', note: `错误代价 ${cost} 非 high，低危不试演` };
    }
    // 6. 认识论裁决：proceed × high 才是金丝雀的领地（出厂阈值下数学不可达 ⇒ 零回归）
    const rawConf = typeof a.confidence === 'number' && Number.isFinite(a.confidence)
        ? Math.min(1, Math.max(0, a.confidence))
        : 0;
    const report = adviseAction({
        confidence: rawConf,
        costOfError: cost,
        vlmAvailable: false,
        budgetRemainingPct: 100,
    });
    if (report.advise !== 'proceed') {
        return { kind: 'skip', why: 'not-proceed', note: `认识论裁决 ${report.advise}，非 proceed 不试演` };
    }
    // 7. 可逆探针计划
    let probe;
    if (tool === 'click_mouse') {
        const x = a.x;
        const y = a.y;
        const pointOk = typeof x === 'number' && typeof y === 'number' &&
            Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1;
        if (!pointOk || !isIdempotentToggleLabel(desc)) {
            return {
                kind: 'skip',
                why: 'no-reversible-probe',
                note: '点击目标无幂等切换标签（或坐标缺席），论证不出可逆探针，诚实跳过',
            };
        }
        probe = { kind: 'click-toggle', point: { x: x, y: y }, char: 'x' };
    }
    else {
        probe = { kind: 'type-char', point: null, char: 'x' };
    }
    // 8. 反事实预测（只读消费 counterfactual.predictedEffects）
    const predictedEffects = predictedEffectsOf(tool, a);
    if (predictedEffects === null) {
        return { kind: 'skip', why: 'prediction-unavailable', note: '反事实预测缺席，无比对基准' };
    }
    return {
        kind: 'rehearse',
        probe,
        predictedEffects,
        report,
        confidence: rawConf,
    };
}
// ─── 纯函数：反事实预测（只读消费 counterfactual） ───
/** 零证据空快照（counterfactual 同律：零证据不伪造 —— deriveEffects 只需动作形状） */
const ZERO_SNAPSHOT = {
    takenAt: 0, width: 0, height: 0, dhash: null, elements: [], textDigest: '',
    popups: [], focusedRegion: null, sceneLabel: '', degraded: [],
};
/** 工具调用 → 合成 PolicyAction（counterfactual 的词汇面；只用于推导 predictedEffects） */
function syntheticActionFor(tool, a) {
    const expectedEffect = strArg(a.expected_change) ?? strArg(a.expected_text) ?? '';
    if (tool === 'click_mouse') {
        const x = a.x;
        const y = a.y;
        if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y))
            return null;
        const label = strArg(a.target_description) ?? '';
        return {
            kind: 'click',
            target: { bbox: { x0: x, y0: y, x1: x, y1: y }, center: { x, y }, label },
            payload: {},
            rationale: 'W2-7 金丝雀合成动作（只读消费）',
            expectedEffect,
            utility: 0.5,
            riskTier: 'benign',
        };
    }
    if (tool === 'type_text') {
        return {
            kind: 'type',
            payload: { text: typeof a.text === 'string' ? a.text : '' },
            rationale: 'W2-7 金丝雀合成动作（只读消费）',
            expectedEffect,
            utility: 0.5,
            riskTier: 'benign',
        };
    }
    return null;
}
/** 经 counterfactual.scoreOptions 推导 predictedEffects（null = 推导不出） */
function predictedEffectsOf(tool, a) {
    const action = syntheticActionFor(tool, a);
    if (action === null)
        return null;
    const plan = scoreOptions([action], { goalKeywords: [], snapshot: ZERO_SNAPSHOT });
    if (plan === null || !Array.isArray(plan.chosen?.predictedEffects))
        return null;
    const effects = plan.chosen.predictedEffects.filter((e) => typeof e === 'string');
    return effects.length > 0 ? effects : null;
}
// ─── 纯函数：预测-验证比对 ───
/** 数值防御：夹 [0,1]，非有限数按 null（通道缺席，不伪造观察） */
function clamp01OrNull(v) {
    if (typeof v !== 'number' || !Number.isFinite(v))
        return null;
    return Math.min(1, Math.max(0, v));
}
/**
 * 预测-验证比对（纯函数，绝不抛异常）。
 *
 * 预测主张映射（诚实声明的观察语义边界）：click/type 的 predictedEffects
 * （「激活元素…」/「向焦点元素输入文本」）在视觉域的共同可观察投影是
 * 「目标邻域对交互产生视觉响应」—— 本比对只核对这一主命题；「揭示新界面」
 * 「弹窗消失」等次级预言不在区域指纹的裁判域内（证据链如实记录预测原文）。
 *
 *   响应通道：expectsResponse 且 responseSimilarity 在场时，
 *     分歧度量 = responseSimilarity（无响应=1 全矛盾；剧变=0 无矛盾），
 *     越阈判据 = responseSimilarity ≥ responseCeiling（缺省 noopSimilarityThreshold
 *     0.97 —— 只有近-total 无响应才算分歧，轻微重绘绝不误拦）；
 *   复位通道：restoreSimilarity 在场时，分歧度量 = 1 − restoreSimilarity，
 *     越阈判据 = restoreSimilarity < restoreFloor（探针没能把世界复原 ——
 *     「这是幂等切换」的预测被世界否决）。
 *   divergence = 两通道最大者；两通道皆缺席 ⇒ divergence/diverged 双 null
 *   （诚实弃权，调用方降级放行）。
 */
export function compareCanaryObservation(predictedEffects, obs, thresholds = {}) {
    const notes = [];
    const responseSim = clamp01OrNull(obs?.responseSimilarity);
    const restoreSim = clamp01OrNull(obs?.restoreSimilarity);
    const ceiling = clamp01OrNull(thresholds.responseCeiling) ?? 0.97;
    const floor = clamp01OrNull(thresholds.restoreFloor) ?? CANARY_RESTORE_FLOOR_DEFAULT;
    const expectsResponse = Array.isArray(predictedEffects) &&
        predictedEffects.some(e => typeof e === 'string' && e.trim() !== '');
    if (!expectsResponse)
        notes.push('预测主张不含可观察响应，弃权');
    const responseDivergence = expectsResponse && responseSim !== null ? responseSim : null;
    const responseDiverged = responseDivergence !== null && responseDivergence >= ceiling;
    const restoreDivergence = restoreSim !== null ? 1 - restoreSim : null;
    const restoreDiverged = restoreSim !== null && restoreSim < floor;
    if (responseDivergence !== null) {
        notes.push(`响应通道：相似度 ${responseSim.toFixed(3)}（阈 ${ceiling}）${responseDiverged ? '⇒ 无响应分歧' : '⇒ 响应符合预测'}`);
    }
    if (restoreDivergence !== null) {
        notes.push(`复位通道：相似度 ${restoreSim.toFixed(3)}（地板 ${floor}）${restoreDiverged ? '⇒ 未复原分歧' : '⇒ 复原完好'}`);
    }
    const parts = [responseDivergence, restoreDivergence].filter((v) => v !== null);
    return {
        divergence: parts.length > 0 ? Math.max(...parts) : null,
        diverged: parts.length > 0 ? responseDiverged || restoreDiverged : null,
        responseSimilarity: responseSim,
        restoreSimilarity: restoreSim,
        notes,
    };
}
// ─── 探针编排（防御式：一切端口异常收敛为状态，绝不抛、绝不悬挂） ───
/** 端口调用包装：异常 / 非真值 ⇒ false（世界侧是否被触碰由调用序保证） */
async function tryStep(name, fn, steps) {
    try {
        const ok = (await fn()) === true;
        steps.push(`${name}: ${ok ? 'ok' : 'dispatch-failed'}`);
        return ok;
    }
    catch (e) {
        steps.push(`${name}: threw(${e?.message ?? 'unknown'})`);
        return false;
    }
}
/** 帧哈希端口包装：异常/非串/空串 ⇒ null（帧通道缺席） */
async function tryHash(ports, point, radius) {
    try {
        if (typeof ports.regionHash !== 'function')
            return null;
        const h = await ports.regionHash(point, radius);
        return typeof h === 'string' && h.length > 0 ? h : null;
    }
    catch {
        return null;
    }
}
/**
 * 可逆微探针编排（W2-7 核心）：点击回点 / 单字符退格，三帧区域指纹取证。
 *
 * 可逆性编排律：
 *   · 首步派发失败 ⇒ 世界未被触碰，整体 unavailable（无副作用失败）；
 *   · 复位步派发失败 ⇒ 立即尽力重试一次；仍失败 ⇒ failed（世界可能被触碰，
 *     调用方按纪律降级放行并诚实记注 —— 绝不假装复原成功）；
 *   · 全步派发成功 ⇒ observed，三帧相似度即响应/复位两通道的原始证据。
 */
export async function attemptCanaryProbe(plan, ports, opts = {}) {
    if (ports === null || ports === undefined || typeof ports !== 'object') {
        return { status: 'unavailable', notes: ['探针端口缺席（生产后端未孵化或测试未注入）'] };
    }
    const radius = typeof opts.regionRadius === 'number' && Number.isFinite(opts.regionRadius) && opts.regionRadius > 0
        ? opts.regionRadius
        : 0.06;
    const steps = [];
    const degradedNotes = [];
    if (plan.kind === 'click-toggle') {
        if (typeof ports.click !== 'function') {
            return { status: 'unavailable', notes: ['点击物理端口缺席'] };
        }
        const p = plan.point;
        if (p === null)
            return { status: 'unavailable', notes: ['点击探针无目标点'] };
        const h0 = await tryHash(ports, p, radius);
        if (h0 === null)
            return { status: 'unavailable', notes: ['基线帧通道缺席（无 h0 不可比）'] };
        const ok1 = await tryStep('probe-click', () => ports.click(p), steps);
        if (!ok1)
            return { status: 'unavailable', notes: [...steps, '首步点击派发失败 —— 世界未被触碰'] };
        const h1 = await tryHash(ports, p, radius);
        const ok2 = await tryStep('probe-click-back', () => ports.click(p), steps) ||
            await tryStep('probe-click-back-retry', () => ports.click(p), steps);
        if (!ok2)
            degradedNotes.push('回点派发失败（已尽力重试）—— 世界可能停留在展开态');
        const h2 = await tryHash(ports, p, radius);
        if (!ok2)
            return { status: 'failed', notes: [...steps, ...degradedNotes] };
        return {
            status: 'observed',
            observation: {
                responseSimilarity: h1 !== null ? similarity(h0, h1) : null,
                restoreSimilarity: h2 !== null ? similarity(h0, h2) : null,
                steps,
                degradedNotes,
            },
        };
    }
    // type-char：输入 1 字符 → 立即退格（任何可编辑上下文状态恒复原）
    if (typeof ports.typeChar !== 'function' || typeof ports.backspace !== 'function') {
        return { status: 'unavailable', notes: ['输入/退格物理端口缺席'] };
    }
    const h0 = await tryHash(ports, null, radius);
    if (h0 === null)
        return { status: 'unavailable', notes: ['基线帧通道缺席（无 h0 不可比）'] };
    const ch = typeof plan.char === 'string' && plan.char.length > 0 ? plan.char : 'x';
    const ok1 = await tryStep('probe-type-char', () => ports.typeChar(ch), steps);
    if (!ok1)
        return { status: 'unavailable', notes: [...steps, '首步输入派发失败 —— 世界未被触碰'] };
    const h1 = await tryHash(ports, null, radius);
    const ok2 = await tryStep('probe-backspace', () => ports.backspace(), steps) ||
        await tryStep('probe-backspace-retry', () => ports.backspace(), steps);
    if (!ok2)
        degradedNotes.push('退格派发失败（已尽力重试）—— 焦点元素可能残留 1 个探针字符');
    const h2 = await tryHash(ports, null, radius);
    if (!ok2)
        return { status: 'failed', notes: [...steps, ...degradedNotes] };
    return {
        status: 'observed',
        observation: {
            responseSimilarity: h1 !== null ? similarity(h0, h1) : null,
            restoreSimilarity: h2 !== null ? similarity(h0, h2) : null,
            steps,
            degradedNotes,
        },
    };
}
// ─── 生产端口（零孵化 + dry-run 纪律，与 interactivityProbe/rootCauseGuard 同律） ───
/**
 * 生产探针端口：physicalBackend 的薄包装。
 *   · 派发闸：healthSnapshot() 在场（绝不因试演孵化服务）且非 dry-run；
 *   · 帧通道：click 用目标邻域 wantRegionHash；type 用焦点槽
 *     （focusTracker，过期即缺席）—— 焦点缺席退全屏 dhash。
 */
export function productionCanaryPorts(config) {
    const dispatchOk = () => physicalBackend.healthSnapshot() !== null && config.dryRun !== true;
    return {
        click: async (p) => {
            if (!dispatchOk())
                return false;
            await physicalBackend.clickMouse(p.x, p.y, 'left', false);
            return true;
        },
        typeChar: async (ch) => {
            if (!dispatchOk())
                return false;
            await physicalBackend.typeText(ch, false, false);
            return true;
        },
        backspace: async () => {
            if (!dispatchOk())
                return false;
            await physicalBackend.pressHotkey(['backspace'], false);
            return true;
        },
        regionHash: async (p, r) => {
            if (physicalBackend.healthSnapshot() === null)
                return null; // 零孵化：帧通道诚实缺席
            const focus = p ?? focusTracker.get(config.focusMaxAgeMs);
            const cap = await physicalBackend.captureProcessed({
                metaOnly: true,
                ...(focus !== null
                    ? { wantRegionHash: { x: focus.x, y: focus.y, r } }
                    : { wantHashes: true }),
            });
            return (focus !== null ? cap.regionDhash : cap.dhash) ?? null;
        },
    };
}
// ─── 观察面：事件环 + 预算账本（模块级单例，reset 供测试隔离/插件卸载） ───
const RECENT_LIMIT = 16;
const recentEvents = [];
/** 探针预算账本：会话键 → 已试演次数（有界 128 会话，防缓慢泄漏） */
const probeBudget = new Map();
const BUDGET_SESSIONS_MAX = 128;
function recordEvent(ev) {
    recentEvents.unshift(ev);
    if (recentEvents.length > RECENT_LIMIT)
        recentEvents.length = RECENT_LIMIT;
}
function chargeBudget(sessionKey) {
    probeBudget.set(sessionKey, (probeBudget.get(sessionKey) ?? 0) + 1);
    if (probeBudget.size > BUDGET_SESSIONS_MAX) {
        const first = probeBudget.keys().next().value; // 插入序淘汰最旧会话
        if (first !== undefined)
            probeBudget.delete(first);
    }
}
/** W2-7：最近的试演事件（时间降序；诊断面板/测试观察面） */
export function recentCanaryEvents() {
    return [...recentEvents];
}
/** W2-7：探针预算账本只读快照（会话键 → 已用次数；可观测面） */
export function canaryBudgetSnapshot() {
    return new Map(probeBudget);
}
/** W2-7：生命周期归零（插件卸载 / 测试隔离） */
export function resetCanaryGuard() {
    recentEvents.length = 0;
    probeBudget.clear();
}
// ─── 守卫注册 ───
/**
 * 注册金丝雀试演守卫（W2-7）。ports 参数是注入缝 —— 测试注入假物理端口/
 * 假帧哈希（离线确定性）；缺省用生产端口（后端不在场时自动全降级，行为
 * 等价于纯旁路放行）。
 */
export function registerCanaryGuard(ctx, config, ports) {
    onToolPre(ctx, async (call, next) => {
        // 防御式铁律：守卫的一切都在 try 内；任何异常的成本是「这一次不试演」，
        // 绝不是工具调用被吞 / 被拦截 / 被延迟到异常路径。
        try {
            const sessionKey = typeof call.sessionId === 'string' && call.sessionId !== ''
                ? call.sessionId
                : '_anon';
            const trigger = classifyCanaryTrigger(call.name, call.args, {
                dangerPatterns: config.dangerPatterns,
                probeBudgetUsed: probeBudget.get(sessionKey) ?? 0,
                probeBudgetCap: CANARY_PROBE_BUDGET_DEFAULT,
            });
            if (trigger.kind === 'skip') {
                // 噪声纪律：not-action-tool 每次无关调用都发生，不打点；其余让位
                // （预算/令牌/不可逆等）以 miss 计数入遥测 —— 让位可观测但不拦截。
                if (trigger.why !== 'not-action-tool')
                    telemetry.note(`canary:skip-${trigger.why}`, false);
                return next();
            }
            if (trigger.kind === 'exempt-destructive') {
                // destructive 豁免直审批：不试演，放行给既有审批闸门（actionGate 在
                // 同一调用内执法 —— 对一次性按钮，试演点击两次比点一次更糟）。
                recordEvent({ at: Date.now(), tool: call.name, action: 'exempt-destructive', why: trigger.note });
                telemetry.note('canary:destructive-exempt', true);
                return next();
            }
            // ── rehearse：金丝雀试演 ──
            chargeBudget(sessionKey); // 计数先于探针（并发/失败皆不超支）
            const epistemics = `advise=${trigger.report.advise} 有效置信=${trigger.report.confidence.toFixed(3)}`;
            recordEvent({
                at: Date.now(),
                tool: call.name,
                action: 'triggered',
                why: 'proceed×high：认识论放行的高代价动作，物理执行前先试演',
                probe: trigger.probe.kind,
                point: trigger.probe.point,
                predictedEffects: trigger.predictedEffects,
                epistemics,
            });
            telemetry.note('canary:triggered', true);
            const degraded = (why, notes) => {
                recordEvent({
                    at: Date.now(), tool: call.name, action: 'degraded', why,
                    probe: trigger.probe.kind, point: trigger.probe.point,
                    predictedEffects: trigger.predictedEffects, epistemics,
                    degradedNotes: notes,
                });
                telemetry.note('canary:degraded', false);
                return next(); // 可用性优先：探针缺席/失败 ⇒ 放行原动作
            };
            // 弹窗期不试演（与 interactivityProbe 的 hoverGuardSkip 同律：隔着对话框动指针不安全）
            if (getPopupState())
                return degraded('弹窗活跃期不试演', ['popup active']);
            const outcome = await attemptCanaryProbe(trigger.probe, ports ?? productionCanaryPorts(config), { regionRadius: config.probeRegionRadius });
            if (outcome.status !== 'observed') {
                return degraded(`探针${outcome.status === 'unavailable' ? '不可用' : '失败'}（可用性优先放行）`, outcome.notes);
            }
            const cmp = compareCanaryObservation(trigger.predictedEffects, outcome.observation, {
                responseCeiling: config.noopSimilarityThreshold,
                restoreFloor: CANARY_RESTORE_FLOOR_DEFAULT,
            });
            if (cmp.diverged === null || cmp.divergence === null) {
                return degraded('两通道皆缺席，无法比对（诚实弃权放行）', cmp.notes);
            }
            if (cmp.diverged) {
                // 分歧 ⇒ 拦截 + 降级问人：只读调用 approval.request（铸造待审批令牌；
                // 不消费、不授予 —— 同意与否仍归用户 grant_approval 的既有协议）。
                const pointText = trigger.probe.point !== null
                    ? `(${trigger.probe.point.x.toFixed(3)},${trigger.probe.point.y.toFixed(3)})`
                    : '焦点槽';
                let token = null;
                try {
                    const pa = approval.request(`[金丝雀试演分歧] ${call.name} ${pointText}` +
                        ` 预测「${trigger.predictedEffects.join('；')}」` +
                        ` 观察 响应相似度=${cmp.responseSimilarity?.toFixed(3) ?? 'n/a'}` +
                        ` 复位相似度=${cmp.restoreSimilarity?.toFixed(3) ?? 'n/a'}` +
                        ` 分歧度量=${cmp.divergence.toFixed(3)} —— 请人工裁决是否放行原动作`, {
                        actionShape: {
                            tool: call.name,
                            ...(trigger.probe.point !== null ? { x: trigger.probe.point.x, y: trigger.probe.point.y } : {}),
                            ...(typeof call.args?.text === 'string' ? { text: call.args.text } : {}),
                            ...(typeof call.args?.target_description === 'string'
                                ? { target_description: call.args.target_description }
                                : {}),
                        },
                    });
                    token = pa.token;
                }
                catch {
                    token = null; // 审批通道异常：拦截仍生效，令牌缺席如实记注
                }
                recordEvent({
                    at: Date.now(), tool: call.name, action: 'blocked',
                    why: `预测-验证分歧（${cmp.notes.join('；')}）—— 拦截原动作，降级问人`,
                    probe: trigger.probe.kind, point: trigger.probe.point,
                    divergence: cmp.divergence,
                    responseSimilarity: cmp.responseSimilarity,
                    restoreSimilarity: cmp.restoreSimilarity,
                    predictedEffects: trigger.predictedEffects,
                    approvalToken: token,
                    epistemics,
                });
                telemetry.note('canary:blocked', true);
                return (`[Guard Blocked][Canary]: 高风险动作试演与预测分歧 —— 世界没有按反事实预测响应，` +
                    `原动作已被拦截并降级为人工审批。\n` +
                    `  action: ${call.name} ${pointText}` +
                    `${typeof call.args?.target_description === 'string' ? ` target "${call.args.target_description}"` : ''}\n` +
                    `  predicted: ${trigger.predictedEffects.join('；')}\n` +
                    `  observed: 响应相似度=${cmp.responseSimilarity?.toFixed(3) ?? 'n/a'}` +
                    ` 复位相似度=${cmp.restoreSimilarity?.toFixed(3) ?? 'n/a'} 分歧度量=${cmp.divergence.toFixed(3)}\n` +
                    (token !== null
                        ? `  approval token minted: ${token} — 请用户经 grant_approval 裁决后携 approval_token 重试；` +
                            `若目标定位错了，请重新定位（如 find_text）而非强行点击。`
                        : `  审批通道铸造失败 —— 请直接向用户说明分歧并等待人工指示，勿强行执行。`));
            }
            // 一致 ⇒ 放行，证据链记「金丝雀通过」
            recordEvent({
                at: Date.now(), tool: call.name, action: 'passed',
                why: `金丝雀通过：${cmp.notes.join('；')}`,
                probe: trigger.probe.kind, point: trigger.probe.point,
                divergence: cmp.divergence,
                responseSimilarity: cmp.responseSimilarity,
                restoreSimilarity: cmp.restoreSimilarity,
                predictedEffects: trigger.predictedEffects,
                epistemics,
            });
            telemetry.note('canary:passed', true);
            return next();
        }
        catch {
            try {
                telemetry.note('canary:degraded', false);
            }
            catch { /* 遥测也炸：到此为止，绝不抛 */ }
            return next(); // 主路径零感知
        }
    });
}
