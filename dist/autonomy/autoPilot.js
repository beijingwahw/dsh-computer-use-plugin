import { adviseAction } from './uncertainty.js';
// W4-0（B 接线）：岔路账/岔路卡的评分上下文与载荷类型（type-only —— 类型擦除后
// autoPilot 的运行时依赖图零变化；branchLedger 单例的注入面在 buildAutonomyStack）。
// ScoringContext 由 counterfactual 直接出（branchCards 只消费不转发 —— 就近事实源）。
// W5-5（缝3）：withSteerBias 升为值导入 —— steer(k) 换支偏置铸入 ③¼ 的评分
// 上下文（branchCards → counterfactual/diagnosis 均下游，与本文件零回路）。
import { withSteerBias } from '../branchCards.js';
// W4-0（B 接线）：岔路账落账的评分物料 —— 与 policyEngine 并列破平同一方言
//（goalKeywords/triedActionKeys 的单一事实源，不复制分词逻辑）。
import { extractGoalKeywords } from './policyEngine.js';
import { actionSignature } from './counterfactual.js';
// W4-0（B 接线）：活意图漂移会话（W3-5 交付 API —— createSteerSession 绑定
// 目标机与屏幕指纹源，会话铸造在 driveLoop 环内完成（goal 由调用方铸））。
// W5-5（缝3）：SteerBiasStepper 类型随行 —— 换支重放偏置的步进面端口。
import { createSteerSession, } from '../tools/steerTools.js';
// 纪元 Ε：预言端口与注记/动作键方言（路径显式指到桶文件 —— 目录导入在 Node
// strip 装载器是 ERR_UNSUPPORTED_DIR_IMPORT，纪元 Ι 同律）。
import { prophecyActionKey, prophecyJournalTag, } from '../prophecy/index.js';
/** W4-0（B）：在役 steer 会话（driveLoop 铸、跨环存续至下一环替换 —— 出题升级后
 *  用户的单字符应答经 steer_choice/steer_answer 工具对**同一会话**结算，环终清账
 *  会把「升级提问」变成死信；持有者只暴露只读出口，绝不炸） */
const w4ActiveSteer = { session: null };
/** W4-0（B）：当前/最近一次 steer 会话（无 ⇒ null；工具转发面消费） */
export function activeSteerSession() {
    return w4ActiveSteer.session;
}
/** W4-0（B）：最近一张岔路卡（goal failed/aborted 时铸造；供换支重放/审计消费） */
const w4LastCard = { card: null };
/** W4-0（B）：最近一张岔路卡的只读出口（未铸 ⇒ null） */
export function lastBranchCard() {
    return w4LastCard.card;
}
/** W4-0（B）：接线持有者归零（测试隔离缝 —— 会话/卡片跨 run 存续是设计语义，
 *  生产代码不需要调用） */
export function resetW4PilotWire() {
    w4ActiveSteer.session = null;
    w4LastCard.card = null;
}
/** 终局相集合 —— goal.evaluate() 落入即熔断循环 */
const TERMINAL_PHASES = new Set([
    'achieved', 'failed', 'aborted', 'blocked',
]);
/** 步数上限末级回退（opts.maxSteps → spec.maxSteps → 此值） */
const DEFAULT_MAX_STEPS = 24;
/** wait 动作默认沉降毫秒（opts.settleMs 可覆盖） */
const DEFAULT_SETTLE_MS = 300;
/**
 * 内置极简宪法（deps.constitution 缺省时的全放行铸造器）：
 * 一律放行、零审批；风险档透传校验 —— 合法值原样盖章，缺席或非法一律按 benign。
 * 闭环不因宪法缺席而卡死，宪法上线之日即无缝接管。
 */
const PERMISSIVE_CONSTITUTION = {
    check(action) {
        const tier = action.riskTier;
        return {
            allowed: true,
            riskTier: tier === 'sensitive' || tier === 'destructive' ? tier : 'benign',
            requiresApproval: false,
            reason: '未注入宪法：内置全放行铸造器（benign 盖章）',
        };
    },
};
/** 异常归因为安全字符串（绝不二次抛出） */
function errText(err) {
    if (err instanceof Error)
        return err.message;
    try {
        const text = String(err);
        return text === '' ? '未知异常' : text;
    }
    catch {
        return '未知异常';
    }
}
/** 宪法判决分层的合法性收口：Stub/垃圾判决给出的非三值一律视为缺席（不盖章） */
function validRiskTier(v) {
    return v === 'benign' || v === 'sensitive' || v === 'destructive' ? v : undefined;
}
/**
 * 动作自报置信（纪元 Η-1 口径，纯函数）：payload.confidence（有限数，夹 [0,1]）优先，
 * 其次 action.utility（policyEngine ② 级点击动作的 utility 即元素置信 —— 既有约定），
 * 双双缺席/非法 ⇒ 0.5 保守中值（不自夸也不自贬）。
 */
function epistemicConfidenceOf(action) {
    const payload = action && typeof action.payload === 'object' ? action.payload : null;
    const pc = payload ? payload.confidence : undefined;
    if (typeof pc === 'number' && Number.isFinite(pc))
        return Math.min(1, Math.max(0, pc));
    const u = action ? action.utility : undefined;
    if (typeof u === 'number' && Number.isFinite(u))
        return Math.min(1, Math.max(0, u));
    return 0.5;
}
/** 错误代价档映射（纪元 Η-1）：destructive/sensitive ⇒ high，其余（含垃圾分层）⇒ low */
function epistemicCostOfError(tier) {
    return tier === 'destructive' || tier === 'sensitive' ? 'high' : 'low';
}
/** 预算余量百分比轨道（纯函数）：used/total 折剩余百分比；非法轨 ⇒ null（不计入） */
function budgetTrackPct(used, total) {
    if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0)
        return null;
    return 100 * (1 - used / total);
}
// ─── W1-3 免看门控：常量与纯工具（零副作用、零异常） ───
/** 免看门控缺省汉明容差（与 worldSnapshot.snapshotChanged 缺省 3 同律） */
const GATE_DEFAULT_TOLERANCE = 3;
/** wait 值守缺省轮询间隔毫秒 */
const GATE_DEFAULT_POLL_INTERVAL_MS = 250;
/** wait 值守缺省上限毫秒 */
const GATE_DEFAULT_POLL_MAX_MS = 2_000;
/** 连续跳过缺省上限（到顶强制一次完整感知 —— 终局判据 OCR 的有界保鲜） */
const GATE_DEFAULT_MAX_CONSECUTIVE_SKIPS = 1;
/** 值守探测次数硬顶（时钟故障/零间隔配置下的最后防线，值守绝不失控轮询） */
const GATE_WATCH_PROBE_HARD_CAP = 128;
/** 门控跳过时合成快照的降级记号（旧元素/文本非当刻取证，诚实记账） */
const GATE_SNAPSHOT_DEGRADED_MARKER = 'perception-gate-skipped';
/** 门控跳过注入的轻量文本观察（规格原文；走 sceneLabel 通道 —— 该字段无判据匹配消费者，绝不污染 textDigest） */
const GATE_OBSERVATION_TEXT = '免看门控：已执行，屏未变';
/** 半字节 popcount 表（0..15 的置位数）：gateHexHamming 的查表核（与 worldSnapshot 私有实现同律，本文件自带避免跨器官耦合） */
const GATE_NIBBLE_POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
/**
 * W1-3：十六进制 dHash 汉明距离（纯函数，绝不抛）。null = 不可比（长度不一/
 * 空串/非十六进制字符）—— 调用方按保守律把不可比当作「不可判 ⇒ 照旧感知」。
 */
function gateHexHamming(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || a.length !== b.length) {
        return null;
    }
    let dist = 0;
    for (let i = 0; i < a.length; i++) {
        const x = Number.parseInt(a[i], 16);
        const y = Number.parseInt(b[i], 16);
        if (Number.isNaN(x) || Number.isNaN(y))
            return null;
        dist += GATE_NIBBLE_POPCOUNT[x ^ y];
    }
    return dist;
}
/** W1-3：数值卫兵 —— 非有限数取 fallback，否则夹 [min,max]（门控配置的脏值收敛） */
function gateNumIn(v, min, max, fallback) {
    if (typeof v !== 'number' || !Number.isFinite(v))
        return fallback;
    return Math.min(max, Math.max(min, v));
}
/** W1-3：合法滚动方向集（与 runtime.createExecute 的 scroll 方向白名单同律；方向缺席按 down 仍会滚动） */
const GATE_SCROLL_DIRECTIONS = new Set(['up', 'down', 'left', 'right']);
/**
 * W3-7：escalate 动作的理由提取（payload.reason 的防御字符串化；缺席/垃圾 ⇒ '?'）。
 * 消费面是探索账本的恢复态判据（'no-deterministic-action' = 所有已知路失败）。
 */
function extractEscalateReason(action) {
    const p = action && typeof action.payload === 'object' ? action.payload : null;
    const r = p ? p.reason : undefined;
    return typeof r === 'string' && r !== '' ? r : '?';
}
/**
 * W1-3：动作的预期视觉效应三档标注（C1 规格第一项，纯函数、绝不抛）。
 * 从动作种类 × 风险档推导（详见 ExpectedVisualEffect 的 JSDoc）：高风险世界
 * 动作 ⇒ 必变（后果必须目击）；良性有效世界动作 ⇒ 可能变（如 type 后大概率变）；
 * 观察性动作与参数无效不会落地的动作（如无效坐标点击）⇒ 无影响；未知种类 ⇒
 * 必变（保守红律：不确定 ⇒ 必看）。
 */
export function classifyExpectedVisualEffect(action) {
    const a = (action ?? {});
    const payload = a.payload && typeof a.payload === 'object' ? a.payload : null;
    const center = a.target?.center;
    const hasFiniteCenter = center !== null && center !== undefined && typeof center === 'object' &&
        typeof center.x === 'number' && Number.isFinite(center.x) &&
        typeof center.y === 'number' && Number.isFinite(center.y);
    const heavy = a.riskTier === 'sensitive' || a.riskTier === 'destructive';
    switch (a.kind) {
        case 'click':
        case 'drag':
            // 有效落点 ⇒ 世界动作（风险档分档）；无效坐标 ⇒ 执行面不动作 ⇒ 无影响
            return hasFiniteCenter ? (heavy ? 'must-change' : 'may-change') : 'no-impact';
        case 'type': {
            const text = payload ? payload.text : undefined;
            return typeof text === 'string' && text.length > 0
                ? (heavy ? 'must-change' : 'may-change')
                : 'no-impact';
        }
        case 'scroll': {
            // 方向缺席/非字符串 ⇒ runtime 按 down 滚动（仍是世界动作）；字符串非法 ⇒ 不动作
            const dir = payload ? payload.direction : undefined;
            const valid = typeof dir !== 'string' || GATE_SCROLL_DIRECTIONS.has(dir);
            return valid ? (heavy ? 'must-change' : 'may-change') : 'no-impact';
        }
        case 'hotkey': {
            const keys = payload ? payload.keys : undefined;
            const valid = Array.isArray(keys) && keys.some(k => typeof k === 'string' && k.trim() !== '');
            return valid ? (heavy ? 'must-change' : 'may-change') : 'no-impact';
        }
        case 'inspect':
        case 'declare':
        case 'ask_vlm':
        case 'recall_skill':
            return 'no-impact'; // 观察性动作：只看不改世界
        case 'wait':
            return 'may-change'; // 等待的语义就是预期变化 —— dHash 值守轮询覆盖（⑥ 不经 execute）
        default:
            return 'must-change'; // escalate / 未知种类：不确定 ⇒ 必看
    }
}
/**
 * W1-3：门控跳过时的轻量合成快照（纯函数、绝不抛）—— 以最近完整感知快照为
 * 底本透传旧账（屏未变 ⇒ 旧元素/文本账仍真），takenAt 刷新为当刻；degraded
 * 诚实追加 'perception-gate-skipped'（本次元素/文本非当刻取证）；轻量文本观察
 * 走 sceneLabel 通道（该字段无判据匹配消费者 —— textDigest 分毫不动，终局判据
 * OCR 红线不破）。
 */
function synthesizeGateSnapshot(base, takenAt, observation) {
    const b = (base ?? {});
    const degraded = Array.isArray(b.degraded) ? [...b.degraded] : [];
    if (!degraded.includes(GATE_SNAPSHOT_DEGRADED_MARKER))
        degraded.push(GATE_SNAPSHOT_DEGRADED_MARKER);
    const prevScene = typeof b.sceneLabel === 'string' ? b.sceneLabel : '';
    return {
        takenAt,
        width: typeof b.width === 'number' && Number.isFinite(b.width) ? b.width : 0,
        height: typeof b.height === 'number' && Number.isFinite(b.height) ? b.height : 0,
        dhash: b.dhash ?? null,
        elements: Array.isArray(b.elements) ? b.elements : [],
        textDigest: typeof b.textDigest === 'string' ? b.textDigest : '',
        popups: Array.isArray(b.popups) ? b.popups : [],
        focusedRegion: b.focusedRegion ?? null,
        sceneLabel: prevScene === '' ? observation : `${prevScene}｜${observation}`,
        degraded,
    };
}
/** 感知/判断等前置阶段异常时合成的占位动作（不入世界，仅入轨迹） */
function syntheticDeclareAction(stage) {
    return {
        kind: 'declare',
        rationale: `${stage} 阶段异常，收敛为 error 步`,
        expectedEffect: '不改变世界，仅把异常写进轨迹供审计',
        utility: 0,
        riskTier: 'benign',
    };
}
/**
 * 闭环主脉（内部实现；对外入口是 runAutonomousLoop 的防弹壳）。
 *
 * 循环律（与测试逐一对应）：
 *  ⓪ goal.begin() 开环（begin 异常 ⇒ 记 error 步，环照常进入感知）；
 *  ① 步保险丝：steps ≥ (opts.maxSteps ?? spec.maxSteps ?? 24) ⇒ 强制 aborted 收场；
 *  ①′ 环顶终局相位预判：每轮 perceive 前先 evaluate —— 目标机已终局（预置 blocker
 *     ⇒ blocked、判据已全 met ⇒ achieved 等）即熔断收场，零感知零判断零执行
 *     （纪元 Δ 修律：旧律首次相位判定在 execute 之后，blocked-at-begin 仍执行一个
 *     真动作）；
 *  ①″ W1-3 免看门控（C1 Act-Expectation 免看门控）：② 感知前的免看裁决 ——
 *     上步动作属「预期无影响 × 申报 benign × 宪法盖章 benign」最窄类（或 benign
 *     wait 值守）且弹窗活跃标志不在场时，先经注入的本地帧哈希端口比对前后屏
 *     dHash：未变 ⇒ 跳过重型感知（VLM/OCR），以携带轻量文本观察「已执行，屏
 *     未变」的合成快照推进循环；变化超阈值 ⇒ 唤醒完整感知；wait 步由 dHash
 *     循环值守（间隔 × 上限）。安全红线：门控只允许跳过「确认型」感知，五重
 *     与门缺一即照旧感知（详见 ② 处注释）；端口缺席 ⇒ 整体降级（逐字节旧路径）；
 *  ② perceive() 感知 —— 异常 ⇒ 合成 declare 动作记 error 步并推进目标机评估；
 *     感知成功 ⇒ 先结算上一动作的预言（新屏型指纹即 actualType —— D-7 预测编码
 *     回路的 pendingTransition 同律：下一轮到达场景结算上一动作的转移；取不到
 *     真实指纹 ⇒ 引擎内挂起 60s 后诚实作废，绝不伪造 actualType；结算注记回写
 *     预言归属步的 journal —— 纪元 Ε 纯审计旁路，绝不炸环绝不改判据）；
 *  ③ 组装 PolicyContext（history 逐步步累积；budgetRemaining 由 spec 与已耗步/毫秒推算）
 *     → policy.decide —— 异常或缺 action ⇒ error 步收敛；
 *  ③″ W3-7 探索拦截（R2 探索前沿策略）：decide 给出 escalate（所有已知路失败
 *     的恢复分支）且 deps.exploration 端口点亮（enabled === true）时，问一次
 *     探索账本（区域×模态×策略 UCB 择路）—— 有建议 ⇒ 用探索动作替换本步
 *     （照旧走 ③′ 闸门与 ④ 宪法全流程），无建议/常态/故障 ⇒ escalate 原路径
 *     逐字节不变；世界动作落账时经端口 observe 回报探索账（Beta 计数）；端口
 *     缺席 ⇒ 两段零执行（逐字节旧路径 —— 开关默认 off）；
 *  ③′ 认识论闸门（纪元 Η-1，仅 deps.epistemicGate 在场时执行）：adviseAction 四维
 *     裁决（代价档按 riskTier 映射 / 置信取动作自报 / 云脑在否 / 预算余量换算）——
 *     ask_human 且过红律 ⇒ escalated 终局（escalateReason='epistemic-gate'）；abort
 *     且过红律 ⇒ aborted 终局；ask_vlm/proceed（及红律收窄降级者）⇒ 步注记放行；
 *     纪元 Ι：deps.selfModel 给出非 null 建议时置信源换为经验校准置信
 *     （注记/理由带 source:'self-model'），缺席/null ⇒ 自报链逐字节旧路径；
 *  ④ constitution.check(action, { goalText, consecutiveNoEffect, stepsTaken }) ——
 *     allowed=false ⇒ escalated 终局（escalateReason='constitution-veto'，终局相取
 *     goal.evaluate()，summary 写明宪法理由，被否决动作不入轨迹不执行）；
 *     requiresApproval ⇒ escalated 终局（escalateReason='approval-required'）；
 *  ⑤ 动作 kind='escalate' ⇒ 记 no_effect 升级步后 escalated 终局（不执行）；
 *  ⑥ 动作 kind='wait' ⇒ sleep(opts.settleMs ?? 300) 沉降后记 no_effect 步继续（不执行）；
 *  ⑥′ 预言铸造（纪元 Ε，仅 deps.prophecy 在场时执行）：execute 之前按（当前屏型
 *     指纹 × 动作键）铸预言 —— 盲屏（无 dhash）不铸；预言归属即将入账的这一步；
 *  ⑦ execute(action) —— 异常或缺 outcome ⇒ error 步收敛；正常则 StepRecord 入轨迹
 *     （effectiveRiskTier = 宪法判决分层盖章，垃圾判决值视为缺席）；
 *  ⑧ criteriaEvidence 逐条 goal.recordCriterion（回填异常吞掉）；
 *  ⑨ goal.tick() → goal.evaluate()：achieved/failed/aborted/blocked 任一终局相即熔断；
 *  ⑩ 每步入轨迹即触发 onStep（回调异常吞掉）。
 * 任何依赖异常都不炸环；所有时间取注入时钟。
 */
async function driveLoop(deps, opts) {
    const now = deps.now ?? (() => Date.now());
    const sleep = deps.sleep ?? (async (ms) => {
        await new Promise(resolve => { setTimeout(resolve, ms); });
    });
    const constitution = deps.constitution ?? PERMISSIVE_CONSTITUTION;
    const startAt = now();
    const trajectory = [];
    const criteriaStatus = new Map();
    let stepsTaken = 0;
    // 目标规格防御式读取：读不到按空目标继续（空判据 ⇒ 目标机永不因判据终局，靠保险丝收）
    let spec = { goal: '', successCriteria: [] };
    try {
        spec = deps.goal.spec;
    }
    catch { /* 防御：spec 读取失败绝不炸环 */ }
    const criteriaTotal = Array.isArray(spec.successCriteria) ? spec.successCriteria.length : 0;
    // maxSteps 同律防御（与 goalState 构造器「非法 ⇒ 降级 24」一致）：stub 依赖给出
    // NaN/0/非数会把 stepCap 变 NaN（保险丝永不熔断 ⇒ 挂死）或 0（秒中止）
    const specMaxSteps = typeof spec.maxSteps === 'number' && Number.isFinite(spec.maxSteps) && spec.maxSteps >= 1
        ? spec.maxSteps
        : undefined;
    const stepCap = opts?.maxSteps ?? specMaxSteps ?? DEFAULT_MAX_STEPS;
    const timeBudgetMs = typeof spec.timeBudgetSec === 'number' ? spec.timeBudgetSec * 1000 : null;
    // 纪元 Η（Η-1）认识论闸门解析：deps.epistemicGate 缺席 ⇒ gate === undefined，
    // 主循环内闸门段整体零执行（与纪元 Η 接线前逐字节同路径）
    const gate = deps.epistemicGate && typeof deps.epistemicGate === 'object' ? deps.epistemicGate : undefined;
    // 纪元 Ε（预言引擎）解析：deps.prophecy 缺席或双面（mint/settle）不齐 ⇒
    // prophecy === undefined，主循环内铸造/结算两段整体零执行（逐字节旧路径）
    const prophecyRaw = deps.prophecy;
    const prophecy = prophecyRaw && typeof prophecyRaw === 'object' &&
        typeof prophecyRaw.mint === 'function' && typeof prophecyRaw.settle === 'function'
        ? prophecyRaw
        : undefined;
    const gateVlmAvailable = () => {
        if (!gate)
            return false;
        const v = gate.vlmAvailable;
        if (typeof v === 'function') {
            try {
                return v() === true;
            }
            catch {
                return false;
            }
        }
        return v === true;
    };
    /** 红律白名单：blockOnlyTiers 合法三值集合；缺席/空 ⇒ null（全部分层可熔断） */
    const gateBlockTiers = gate && Array.isArray(gate.blockOnlyTiers) && gate.blockOnlyTiers.length > 0
        ? new Set(gate.blockOnlyTiers.filter(t => t === 'benign' || t === 'sensitive' || t === 'destructive'))
        : null;
    /** 红律置信上限：自报置信仅严格小于此值才可熔断；缺省 +∞（不设限） */
    const gateBlockBelow = gate && typeof gate.blockOnlyBelowConfidence === 'number' && Number.isFinite(gate.blockOnlyBelowConfidence)
        ? gate.blockOnlyBelowConfidence
        : Number.POSITIVE_INFINITY;
    /** 闸门预算换算：步数/时间双轨各折剩余百分比取紧者（无轨 ⇒ 100，夹 [0,100]） */
    const gateBudgetPct = () => {
        const stepPct = budgetTrackPct(stepsTaken, stepCap);
        const timePct = timeBudgetMs === null ? null : budgetTrackPct(now() - startAt, timeBudgetMs);
        let pct = 100;
        if (stepPct !== null && stepPct < pct)
            pct = stepPct;
        if (timePct !== null && timePct < pct)
            pct = timePct;
        return Math.min(100, Math.max(0, pct));
    };
    // W1-3（C1 免看门控）解析：deps.perceptionGate 缺席 ⇒ 全缺省（门控开、仅最窄
    // 类）；{enabled:false} ⇒ 完全关闭（测试总闸）。哈希端口 deps.frameHash 缺席或
    // 非函数 ⇒ frameHashFn === null，② 处门控整体降级为照旧感知（与接线前逐字节
    // 同路径 —— 生产接线前零行为变化，接上线即生效）。全部配置脏值就地收敛。
    const w1GateConfRaw = deps.perceptionGate;
    const w1GateConf = w1GateConfRaw && typeof w1GateConfRaw === 'object' ? w1GateConfRaw : null;
    const w1GateEnabled = w1GateConf === null ? true : w1GateConf.enabled !== false;
    const w1GateFrameHash = typeof deps.frameHash === 'function' ? deps.frameHash : null;
    const w1GateTolerance = gateNumIn(w1GateConf?.hammingTolerance, 0, 64, GATE_DEFAULT_TOLERANCE);
    const w1GatePollIntervalMs = gateNumIn(w1GateConf?.pollIntervalMs, 0, 60_000, GATE_DEFAULT_POLL_INTERVAL_MS);
    const w1GatePollMaxMs = gateNumIn(w1GateConf?.pollMaxMs, 0, 600_000, GATE_DEFAULT_POLL_MAX_MS);
    const w1GateMaxConsecutiveSkips = Math.round(gateNumIn(w1GateConf?.maxConsecutiveSkips, 0, 1_000, GATE_DEFAULT_MAX_CONSECUTIVE_SKIPS));
    // 值守探测次数上限：上限毫秒 ÷ 间隔 + 1，再夹硬顶 —— 时钟故障/零间隔配置下
    // 值守也绝不失控轮询（有界性不依赖注入时钟的善意）
    const w1GateWatchMaxProbes = Math.min(GATE_WATCH_PROBE_HARD_CAP, Math.max(1, Math.floor(w1GatePollMaxMs / Math.max(1, w1GatePollIntervalMs)) + 1));
    // W3-7（R2 探索前沿策略）解析：deps.exploration 缺席 / enabled !== true ⇒
    // 端口未点亮（exploration === undefined），③″ 拦截段与观察回报段整体零执行
    //（与接线前逐字节同路径 —— 开关默认 off）。advise/observe 面的运行时防御：
    // 非函数 ⇒ 对应面禁用（结构端口契约的兜底，绝不因桩残缺而炸环）。
    const w3ExploreRaw = deps.exploration;
    const w3Explore = w3ExploreRaw && typeof w3ExploreRaw === 'object' && w3ExploreRaw.enabled === true
        ? w3ExploreRaw
        : undefined;
    const w3ExploreAdvise = w3Explore !== undefined && typeof w3Explore.advise === 'function' ? w3Explore.advise.bind(w3Explore) : null;
    const w3ExploreObserve = w3Explore !== undefined && typeof w3Explore.observe === 'function' ? w3Explore.observe.bind(w3Explore) : null;
    // W4-0（B 接线）解析：steer 端口缺席 / enabled !== true ⇒ w4Steer === null
    //（环内漂移检查整段零执行 —— 逐字节旧路径，零回归红律）；branchLedger 端口
    // 只认结构合法的 record 面（桩残缺 ⇒ 簿记面禁用，绝不炸环）。
    const w4SteerRaw = deps.steer;
    const w4Steer = w4SteerRaw && typeof w4SteerRaw === 'object' && w4SteerRaw.enabled === true ? w4SteerRaw : null;
    const w4BranchRaw = deps.branchLedger;
    const w4Branch = w4BranchRaw && typeof w4BranchRaw === 'object' && typeof w4BranchRaw.record === 'function'
        ? w4BranchRaw
        : null;
    // W4-0（B）：最近一次认识论闸门的校准熵（steer 会话的即时检查通道 —— 熵超阈
    // 可插队出题；闸门缺席 ⇒ null 只走周期通道）
    let w4LastEntropy = null;
    // W5-5（缝2/缝3）解析：岔路账支点锚端口与换支偏置端口 —— 结构不合法 ⇒
    // null（对应段零执行，逐字节旧路径）；一切脏值/故障在消费点防御收敛。
    const w5AnchorRaw = deps.branchAnchor;
    const w5AnchorFn = typeof w5AnchorRaw === 'function' ? w5AnchorRaw : null;
    const w5BiasRaw = deps.steerBias;
    const w5Bias = w5BiasRaw !== null && typeof w5BiasRaw === 'object' && typeof w5BiasRaw.step === 'function'
        ? w5BiasRaw
        : null;
    /** W5-5（缝2）：支点锚的防御读取（端口缺席/故障/垃圾 ⇒ 空对象 = 锚键缺席） */
    const w5AnchorMeta = () => {
        if (w5AnchorFn === null)
            return {};
        try {
            const a = w5AnchorFn();
            if (a === null || a === undefined || typeof a !== 'object')
                return {};
            const r = a;
            const out = {};
            if (typeof r.journalLength === 'number' && Number.isFinite(r.journalLength)) {
                out.journalLength = Math.max(0, Math.floor(r.journalLength));
            }
            if (typeof r.chainTip === 'string' && r.chainTip !== '')
                out.chainTip = r.chainTip;
            return out;
        }
        catch {
            return {}; // 端口故障 ⇒ 锚缺席（诚实降级，绝不炸环）
        }
    };
    let lastPhase = 'planning';
    let lastReason = '';
    let escalated = false;
    let escalateReason;
    let summaryCore = '';
    let lastDhash = null;
    // 纪元 Ε（预言）状态：armed = 已铸预言待归属（recordStep 落账时捕获）；
    // stepIndex = 预言归属步（结算注记的回写锚点）；success = 归属步执行结局
    // （'progress' ⇒ true —— settle 回灌 observe 的成败口径）。
    let prophecyArmed = false;
    let prophecyStepIndex = null;
    let prophecyStepSuccess = false;
    // W1-3（C1 免看门控）状态：基线快照（最近一次完整感知 —— 弹窗标志与旧元素/
    // 文本的出处）、上步门控语境（null = 世界状态未知或非最窄类 ⇒ 必看）、四本
    // 记账（触发/跳过/唤醒/连续跳过）与待搭车的步注记。
    let lastFullSnapshot = null;
    let lastGateEligibility = null;
    let gateProbes = 0;
    let gateSkips = 0;
    let gateWakes = 0;
    let gateConsecutiveSkips = 0;
    let pendingGateNote = null;
    // W3-7（R2 探索前沿策略）记账：本 run 探索建议替代升级步的次数（>0 才追加
    // 总汇报 —— 未触发 ⇒ summary 逐字节不变，零回归红律）
    let w3ExploreSubs = 0;
    /**
     * W1-3：单次哈希探测（三态）：true = 屏未变（距离 ≤ 容差）、false = 屏已变、
     * null = 不可判（端口缺席/抛异常/垃圾返回/指纹不可比）—— null 一律按「照旧
     * 感知」保守收敛，绝不炸环。
     */
    const gateProbeHash = async () => {
        if (w1GateFrameHash === null)
            return null;
        try {
            const fresh = await w1GateFrameHash();
            if (typeof fresh !== 'string' || fresh === '')
                return null;
            const baseline = lastDhash;
            if (typeof baseline !== 'string' || baseline === '')
                return null;
            const distance = gateHexHamming(baseline, fresh);
            if (distance === null)
                return null;
            return distance <= w1GateTolerance;
        }
        catch {
            return null; // 端口故障吞掉 —— 门控降级，绝不炸环
        }
    };
    /** 步落账：入轨迹 + 计步 + 通知观察者（观察者异常吞掉）；宪法判决分层可选盖章 */
    const recordStep = (action, outcome, snapshotDhash, note, effectiveRiskTier) => {
        // W1-3：免看门控注记搭车 —— 门控裁决发生的那一轮，其首个落账步 journal 留痕
        //（跳过/唤醒都记；无裁决 ⇒ 既有 note 逐字节不变 —— 零回归红律）
        let effNote = note;
        if (pendingGateNote !== null) {
            effNote = effNote !== undefined ? `${effNote}；${pendingGateNote}` : pendingGateNote;
            pendingGateNote = null;
        }
        const rec = { stepIndex: stepsTaken, action, outcome, snapshotDhash, at: now() };
        if (effNote !== undefined)
            rec.note = effNote;
        if (effectiveRiskTier !== undefined)
            rec.effectiveRiskTier = effectiveRiskTier;
        trajectory.push(rec);
        // W1-3 免看门控语境记账（单点挂载 —— 一切落账路径共用，纯推导零副作用）：
        // error 步 ⇒ 世界状态未知 ⇒ 下轮必看；wait 步 ⇒ 值守模式（等待的语义就是
        // 预期变化，仅 benign 可入 —— 敏感等待照旧感知）；其余已执行步 ⇒ 唯
        // 「分类无影响 × 申报 benign × 宪法盖章 benign（缺席章按申报）」三元与才入
        // 最窄门控类（may/must-change、sensitive/destructive、被盖章升级者一律必看）。
        lastGateEligibility =
            outcome === 'error'
                ? null
                : action && action.kind === 'wait'
                    ? (action.riskTier === 'benign' ? 'wait' : null)
                    : action &&
                        classifyExpectedVisualEffect(action) === 'no-impact' &&
                        action.riskTier === 'benign' &&
                        (effectiveRiskTier === undefined || effectiveRiskTier === 'benign')
                        ? 'no-impact'
                        : null;
        // 纪元 Ε：armed 的预言归属本步（mint 在 execute 前、recordStep 在 execute 后 ——
        // 之间的 recordStep 只会是本动作的结局步，捕获即对号）
        if (prophecyArmed) {
            prophecyArmed = false;
            prophecyStepIndex = rec.stepIndex;
            prophecyStepSuccess = outcome === 'progress';
        }
        // W3-7 探索账回报：世界动作步入账即回报探索账本（每格尝试与成败的 Beta
        // 计数；账本对全动作流记账 —— 策略自选动作同样计入已探索集，不只记探索
        // 建议自己）。视口取最近完整感知快照（量化网格的消费面）。账本故障吞掉
        // —— 绝不炸环。
        if (w3ExploreObserve !== null) {
            try {
                w3ExploreObserve(rec.action, rec.outcome, lastFullSnapshot !== null && typeof lastFullSnapshot.width === 'number'
                    ? { width: lastFullSnapshot.width, height: lastFullSnapshot.height }
                    : undefined);
            }
            catch { /* 账本故障吞掉 —— 探索是恢复增益不是依赖 */ }
        }
        stepsTaken++;
        if (deps.onStep) {
            try {
                deps.onStep(rec);
            }
            catch { /* 观察者异常吞掉 —— 闭环不为旁路观察者停摆 */ }
        }
    };
    /** 相位刷新：返回是否落入终局相（evaluate 异常 ⇒ 按非终局继续，靠保险丝兜底） */
    const evaluateGoal = () => {
        try {
            const ev = deps.goal.evaluate();
            lastPhase = ev.phase;
            lastReason = ev.reason;
            return TERMINAL_PHASES.has(ev.phase);
        }
        catch {
            return false;
        }
    };
    /** 推进目标机（tick 异常吞掉）并刷新相位 */
    const advanceGoal = () => {
        try {
            deps.goal.tick();
        }
        catch { /* tick 异常吞掉 */ }
        return evaluateGoal();
    };
    // ⓪ 开环：目标机就位（异常 ⇒ error 步入账，环照常进入感知）
    try {
        deps.goal.begin();
    }
    catch (err) {
        recordStep(syntheticDeclareAction('begin'), 'error', null, `begin: ${errText(err)}`);
    }
    // W4-0（B 接线）：活意图漂移会话铸造 —— 仅 steer 端口点亮时（goal 在环内才出生，
    // 铸造点只能在 driveLoop）。指纹源 = 最近完整感知快照的 textDigest + sceneLabel
    // 拼接（steerTools 的既定方言）；会话铸造防御式（goal 垃圾 ⇒ 永不出题的空转
    // 会话）。会话登记进模块持有者（跨环存续到下一环替换 —— 出题升级后用户的
    // 单字符应答经 steer_answer 对同一会话结算，环终清账会把升级提问变成死信）。
    let w4SteerSession = null;
    if (w4Steer !== null) {
        try {
            const conf = w4Steer;
            w4SteerSession = createSteerSession({
                goal: deps.goal,
                screenText: () => {
                    const s = lastFullSnapshot;
                    if (s === null || typeof s !== 'object')
                        return null;
                    const t = typeof s.textDigest === 'string' ? s.textDigest : '';
                    const l = typeof s.sceneLabel === 'string' ? s.sceneLabel : '';
                    const joined = `${t} ${l}`.trim();
                    return joined !== '' ? joined : null;
                },
                ...(typeof conf.diagnosisNote === 'function' ? { diagnosisNote: conf.diagnosisNote } : {}),
                ...(typeof conf.driftThreshold === 'number' && Number.isFinite(conf.driftThreshold)
                    ? { driftThreshold: conf.driftThreshold }
                    : {}),
                ...(typeof conf.throttleSteps === 'number' && Number.isFinite(conf.throttleSteps)
                    ? { throttleSteps: conf.throttleSteps }
                    : {}),
            });
        }
        catch {
            w4SteerSession = null; // 铸造故障吞掉 —— 漂移检查是旁路，绝不炸环
        }
        if (w4SteerSession !== null)
            w4ActiveSteer.session = w4SteerSession;
    }
    while (true) {
        // ① 步保险丝：到顶强制 aborted（优先于一切依赖调用，防依赖失控拖死环）
        if (stepsTaken >= stepCap) {
            lastPhase = 'aborted';
            summaryCore = `步数保险丝熔断（上限 ${stepCap} 步）`;
            break;
        }
        // ①′ 环顶终局相位预判：每轮 perceive 前先问目标机（纪元 Δ 修律——
        //    首次相位判定原本在 execute 之后，blocked-at-begin 仍会漏发一个真动作；
        //    预置 blocker / 判据已全 met 的目标机在此零感知零判断零执行直接收场）
        if (evaluateGoal())
            break;
        // ①″/② 感知 —— W1-3 免看门控先行，随后（未跳过时）重型感知（异常 ⇒ error
        //     步收敛，不炸环）。门控安全红线（五重与门，缺一即照旧感知 —— 门控决策
        //     必须保守，不确定时一律照旧感知）：
        //     ① 总闸：perceptionGate.enabled === false ⇒ 完全关闭（测试用）；
        //     ② 端口：deps.frameHash 缺席/非函数 ⇒ 门控整体降级（与接线前逐字节同路径）；
        //     ③ 基线：首轮完整感知未发生或基线无 dhash 指纹 ⇒ 无可比对 ⇒ 照旧感知；
        //     ④ 弹窗：最近完整感知快照 popups 非空（弹窗活跃标志在场）⇒ 禁止门控
        //        —— 弹窗检测输入绝不可跳（宪法的危险词扫描、策略①级弹窗优先都以
        //        完整感知为输入，跳过即致盲）；
        //     ⑤ 语境：上步非「无影响 + 双层 benign」最窄类亦非 benign wait（error 步
        //        世界状态未知 ⇒ null），或连续跳过已达上限（终局判据 OCR 的有界保鲜
        //        —— 旧屏账不可无限透支）⇒ 照旧感知。
        //     通过 ⇒ 「无影响」类单探比对、「wait」类循环值守（间隔 × 上限，探测次数
        //     双重有界）比对 dHash 汉明距离；未变 ⇒ 合成轻量快照推进循环 —— 透传旧
        //     元素/文本（屏未变 ⇒ 账仍真）、degraded 诚实记 'perception-gate-skipped'、
        //     sceneLabel 注入轻量文本观察「已执行，屏未变」（该字段无判据匹配消费者，
        //     绝不污染 textDigest —— 终局判据 OCR 红线）；变化 ⇒ 唤醒完整感知；任何
        //     端口故障（抛异常/垃圾返回/指纹不可比）一律按「不可判 ⇒ 照旧感知」收敛。
        //     预言结算只发生在真实感知路径（跳过 = 无新屏型证据，预言挂起等下一帧
        //     —— 纯旁路语义不变）。
        let snapshot = null;
        if (w1GateEnabled &&
            w1GateFrameHash !== null &&
            lastFullSnapshot !== null &&
            typeof lastDhash === 'string' && lastDhash !== '' &&
            Array.isArray(lastFullSnapshot.popups) && lastFullSnapshot.popups.length === 0 &&
            lastGateEligibility !== null &&
            gateConsecutiveSkips < w1GateMaxConsecutiveSkips) {
            gateProbes++; // 触发记账：门控裁决程序每运行一次记一笔
            if (lastGateEligibility === 'wait') {
                // 等待/轮询值守（C1 规格第四项）：本地 dHash 循环值守，带间隔与上限 ——
                // 变化超阈值才唤醒完整感知；到顶仍未变 ⇒ 轻量观察推进循环。
                const watchStart = now();
                let woke = false;
                let indecisive = false;
                let probes = 0;
                while (probes < w1GateWatchMaxProbes) {
                    const unchanged = await gateProbeHash();
                    probes++;
                    if (unchanged === null) {
                        indecisive = true;
                        break;
                    }
                    if (unchanged === false) {
                        woke = true;
                        break;
                    }
                    if (probes >= w1GateWatchMaxProbes)
                        break;
                    if (now() - watchStart >= w1GatePollMaxMs)
                        break;
                    try {
                        await sleep(w1GatePollIntervalMs);
                    }
                    catch {
                        break; /* 睡眠异常 ⇒ 提前收哨 */
                    }
                }
                const waitedMs = Math.max(0, now() - watchStart);
                if (woke) {
                    gateWakes++;
                    pendingGateNote = `免看门控：值守 ${waitedMs}ms 发现屏幕变化，唤醒完整感知（唤醒 ${gateWakes}）`;
                }
                else if (!indecisive) {
                    snapshot = synthesizeGateSnapshot(lastFullSnapshot, now(), `免看门控：已等待 ${waitedMs}ms 屏未变`);
                    gateSkips++;
                    gateConsecutiveSkips++;
                    pendingGateNote =
                        `免看门控：已等待 ${waitedMs}ms 屏未变，跳过重型感知（门控跳过 ${gateSkips}/${gateProbes}）`;
                }
            }
            else {
                // 「无影响 + 低风险」最窄类：单探比对 —— 屏未变才跳，其余一律照旧感知
                const unchanged = await gateProbeHash();
                if (unchanged === true) {
                    snapshot = synthesizeGateSnapshot(lastFullSnapshot, now(), GATE_OBSERVATION_TEXT);
                    gateSkips++;
                    gateConsecutiveSkips++;
                    pendingGateNote =
                        `免看门控：已执行，屏未变，跳过重型感知（门控跳过 ${gateSkips}/${gateProbes}）`;
                }
            }
        }
        if (snapshot === null) {
            try {
                snapshot = await deps.perceive();
                // 纪元 Ε（预言结算）：动作后的第一次感知即「对账时刻」—— 新屏型指纹就是
                // actualType（D-7 pendingTransition 同律）。取不到真实指纹 ⇒ 引擎内挂起
                // （60s 后诚实作废，绝不伪造 actualType）；结算注记回写预言归属步的
                // journal（一行，不扩字段结构）。旁路任何故障吞掉 —— 绝不炸环。
                if (prophecy !== undefined) {
                    try {
                        const nextType = snapshot && typeof snapshot.dhash === 'string' && snapshot.dhash !== ''
                            ? snapshot.dhash
                            : null;
                        const settled = prophecy.settle(nextType, prophecyStepIndex === null ? undefined : prophecyStepSuccess);
                        if (settled !== null) {
                            const rec = trajectory.length > 0 ? trajectory[trajectory.length - 1] : null;
                            if (rec !== null && rec.stepIndex === prophecyStepIndex) {
                                const tag = prophecyJournalTag(settled);
                                rec.note = rec.note !== undefined ? `${rec.note}；${tag}` : tag;
                            }
                            prophecyStepIndex = null; // 结算即清（一次性 —— 错号注记只丢不补）
                        }
                    }
                    catch { /* 预言结算故障吞掉 —— 旁路绝不炸环 */ }
                }
                lastDhash = snapshot && typeof snapshot.dhash === 'string' ? snapshot.dhash : null;
                lastFullSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : null;
                gateConsecutiveSkips = 0; // 完整感知发生 ⇒ 连续跳过保鲜账清零
            }
            catch (err) {
                recordStep(syntheticDeclareAction('perceive'), 'error', null, `perceive: ${errText(err)}`);
                if (advanceGoal())
                    break;
                continue;
            }
        }
        // ③-pre W4-0（B 接线）：活意图漂移检查 —— 每步（stepIndex 周期通道 + 最近
        //     校准熵的即时通道）经 steer 会话 maybeCheckAndAsk：出题 ⇒ steer-drift
        //     升级提问（沿认识论闸门 ask_human 的升级拦截风格 —— 被拦动作不入轨迹
        //     不执行不 tick，题面进总汇报供模型转述，应答经 steer_answer 单字符结算）。
        //     未超阈 / 节流中 / 指纹缺席 / 会话故障 ⇒ null 原路径继续（零回归红律）。
        if (w4SteerSession !== null) {
            let w4Question = null;
            try {
                w4Question = w4SteerSession.maybeCheckAndAsk(stepsTaken, w4LastEntropy);
            }
            catch {
                w4Question = null; // 会话故障吞掉 —— 漂移检查是旁路，绝不炸环
            }
            if (w4Question !== null) {
                escalated = true;
                escalateReason = 'steer-drift';
                evaluateGoal();
                summaryCore =
                    `活意图漂移出题（drift ${w4Question.drift.score}，趋势 ${w4Question.drift.trend}）：` +
                        `${w4Question.reason}。请向用户转述三选一（A 继续 / B 改判据：${w4Question.amendment.to} / ` +
                        `C 终止）并等待单字符应答，经 steer_answer 结算`;
                break;
            }
        }
        // ③ 判断：组装上下文（history 累积 / 预算推算）→ policy.decide
        let decision;
        try {
            const history = trajectory.map(rec => ({ action: rec.action, outcome: rec.outcome }));
            const ctx = {
                snapshot,
                spec,
                goal: deps.goal.progress,
                history,
                budgetRemaining: {
                    steps: Math.max(0, stepCap - stepsTaken),
                    ms: timeBudgetMs === null ? Number.POSITIVE_INFINITY : timeBudgetMs - (now() - startAt),
                },
            };
            decision = await deps.policy.decide(ctx);
        }
        catch (err) {
            recordStep(syntheticDeclareAction('policy'), 'error', lastDhash, `policy: ${errText(err)}`);
            if (advanceGoal())
                break;
            continue;
        }
        let action = decision && decision.action ? decision.action : null;
        if (!action) {
            recordStep(syntheticDeclareAction('policy'), 'error', lastDhash, 'policy: decide 返回缺少 action 的决定');
            if (advanceGoal())
                break;
            continue;
        }
        // ③″ W3-7 探索拦截（R2 探索前沿策略）：policy 给出 escalate（所有已知路
        //     失败的恢复分支）且端口点亮时，问一次探索账本 —— 有建议 ⇒ 用探索
        //     动作替换本步，替换动作照旧走 ③′ 认识论闸门与 ④ 宪法全流程（不越权：
        //     探索建议一律 benign，仍受宪法与闸门裁决）；无建议（常态未达恢复态 /
        //     预算红线 / 本 run 探索预算耗尽）/ 端口故障 ⇒ escalate 原路径逐字节
        //     不变（零回归红律）。建议注记随 decision.note 入本步 journal。
        if (action.kind === 'escalate' && w3ExploreAdvise !== null) {
            let advice = null;
            try {
                advice = w3ExploreAdvise({
                    goal: spec.goal,
                    snapshot,
                    history: trajectory.map(r => ({ action: r.action, outcome: r.outcome })),
                    escalateReason: extractEscalateReason(action),
                });
            }
            catch {
                advice = null; // 端口故障吞掉 —— 绝不炸环
            }
            if (advice !== null && advice.action && typeof advice.action.kind === 'string') {
                const tag = typeof advice.note === 'string' && advice.note !== '' ? advice.note : 'W3-7 探索建议';
                decision = {
                    ...decision,
                    action: advice.action,
                    note: decision.note !== undefined ? `${decision.note}；${tag}` : tag,
                };
                action = advice.action;
                w3ExploreSubs++;
            }
        }
        // ③¼ W4-0（B 接线）：岔路账落账 —— 决策既定（探索替换后、闸门/宪法裁决前）
        //     即按 W3-6 的评分内核（record 内部 rankTopK 与 scoreOptions 同源）记
        //     Top-K 候选账。评分上下文与 policyEngine 并列破平同一方言（单一事实源）：
        //     goalKeywords = extractGoalKeywords(spec)、triedActionKeys = 轨迹签名、
        //     snapshot = 当步感知。纯旁路簿记 —— PilotResult 分毫不动；故障吞掉绝不炸环。
        //     W5-5（缝2）：支点锚 journal 面 —— 注入端口的当前步账位置（journal 条数 +
        //     链尖）随账落锚（端口缺席 ⇒ 键缺席，与 W4-0 逐字节同路）。
        //     W5-5（缝3）：换支偏置 —— 步进面在场且预算内 ⇒ withSteerBias 铸 ctx
        //     （改选偏置只改选择不改预测；超支/故障 ⇒ 无偏置原路继续）。
        if (w4Branch !== null) {
            try {
                let w5RecordCtx = {
                    goalKeywords: extractGoalKeywords(spec),
                    snapshot: (snapshot ?? { takenAt: 0, width: 0, height: 0, dhash: null, elements: [], textDigest: '', popups: [], focusedRegion: null, sceneLabel: '', degraded: [] }),
                    triedActionKeys: trajectory.map(r => actionSignature(r.action)),
                };
                if (w5Bias !== null) {
                    try {
                        const b = w5Bias.step();
                        if (b !== null && typeof b === 'object' && Array.isArray(b.preferredActionKeys)) {
                            const keys = b.preferredActionKeys.filter((k) => typeof k === 'string' && k !== '');
                            if (keys.length > 0)
                                w5RecordCtx = withSteerBias(w5RecordCtx, keys);
                        }
                    }
                    catch {
                        /* 偏置步进故障吞掉 —— 原路无偏置（绝不炸环） */
                    }
                }
                w4Branch.record([action], w5RecordCtx, { stepIndex: stepsTaken, ...w5AnchorMeta() });
            }
            catch { /* 岔路账是旁路簿记 —— 故障绝不炸环 */ }
        }
        // ③′ 认识论闸门（纪元 Η-1）：Φ-7 adviseAction 四维裁决 —— 错误代价 × 校准置信 ×
        //     云脑在否 × 预算余量。ask_human 且过红律 ⇒ escalated 终局（epistemic-gate）；
        //     abort 且过红律 ⇒ aborted 终局；ask_vlm/proceed（及红律收窄降级者）⇒ 步注记
        //     放行（不新增网络调用）。闸门自身异常吞掉 —— 绝不炸环。
        //     纪元 Ι（经验置信换源）：deps.selfModel 在场且对当前动作返回非 null 建议时，
        //     置信源从动作自报（payload.confidence ?? utility）换为经验胜任度后验
        //     （实测校准置信，步注记/升级理由注明 source:'self-model' 与证据量）；
        //     缺席/返回 null/建议非法 ⇒ 自报链原样 —— 纪元 Η 全部既有行为逐字节不变。
        if (gate !== undefined) {
            let report = null;
            let rawConfidence = 0.5;
            /** 纪元 Ι：经验置信的支撑证据量（null = 本步走自报链，注记零变化） */
            let selfModelN = null;
            try {
                rawConfidence = epistemicConfidenceOf(action);
                if (deps.selfModel && typeof deps.selfModel.adviseConfidence === 'function') {
                    let advice = null;
                    try {
                        advice = deps.selfModel.adviseConfidence(action, lastDhash === null ? undefined : lastDhash);
                    }
                    catch {
                        advice = null; // 模型故障吞掉 —— 绝不炸环，回落纪元 Η 自报链
                    }
                    if (advice !== null && advice !== undefined &&
                        typeof advice.confidence === 'number' && Number.isFinite(advice.confidence)) {
                        rawConfidence = Math.min(1, Math.max(0, advice.confidence));
                        selfModelN =
                            typeof advice.n === 'number' && Number.isFinite(advice.n) ? advice.n : null;
                    }
                }
                report = adviseAction({
                    confidence: rawConfidence,
                    costOfError: epistemicCostOfError(action.riskTier),
                    vlmAvailable: gateVlmAvailable(),
                    budgetRemainingPct: gateBudgetPct(),
                });
            }
            catch {
                report = null; // 纯函数理论上不抛 —— 闸门自身异常也不炸环（按无裁决放行）
            }
            // W4-0（B）：校准熵随步刷新（steer 会话的即时检查通道 —— 下一步的
            // maybeCheckAndAsk 消费；闸门缺席/报告缺席 ⇒ null 只走周期通道）
            w4LastEntropy =
                report !== null && typeof report.entropy === 'number' && Number.isFinite(report.entropy)
                    ? report.entropy
                    : null;
            if (report !== null) {
                const blocking = report.advise === 'ask_human' || report.advise === 'abort';
                const redLineOk = (gateBlockTiers === null || gateBlockTiers.has(action.riskTier)) &&
                    rawConfidence < gateBlockBelow;
                // 纪元 Ι 溯源后缀：仅经验置信换源时附加（自报链逐字节旧格式 —— 零回归红律）
                const smSuffix = selfModelN !== null
                    ? `，source:'self-model'（经验置信 n=${Math.round(selfModelN * 1000) / 1000}）`
                    : '';
                if (blocking && redLineOk) {
                    if (report.advise === 'ask_human') {
                        // 认识论升级终局：镜像宪法否决式收场（被拦动作不入轨迹不执行不 tick）
                        escalated = true;
                        escalateReason = 'epistemic-gate';
                        evaluateGoal();
                        summaryCore = `认识论闸门升级（${report.reasons.join('；')}${smSuffix}）`;
                        break;
                    }
                    // 认识论收手终局：镜像步保险丝式 aborted 收场（不升级 —— 收手不是移交）
                    lastPhase = 'aborted';
                    summaryCore = `认识论闸门收手（${report.reasons.join('；')}${smSuffix}）`;
                    break;
                }
                // ask_vlm / proceed / 红律收窄降级 ⇒ 注记放行：该步 journal（note）留痕
                const effText = Number.isFinite(report.confidence) ? report.confidence.toFixed(3) : '?';
                const tag = `认识论闸门 ${report.advise}（有效置信 ${effText}${smSuffix}${blocking ? '，红律收窄放行' : ''}）`;
                decision = { ...decision, note: decision.note !== undefined ? `${decision.note}；${tag}` : tag };
            }
        }
        // ④ 宪法裁决（异常/空裁决 ⇒ error 步收敛）
        let consecutiveNoEffect = 0;
        for (let i = trajectory.length - 1; i >= 0 && trajectory[i].outcome === 'no_effect'; i--) {
            consecutiveNoEffect++;
        }
        let verdict;
        try {
            verdict = constitution.check(action, { goalText: spec.goal, consecutiveNoEffect, stepsTaken });
        }
        catch (err) {
            recordStep(action, 'error', lastDhash, `constitution: ${errText(err)}`);
            if (advanceGoal())
                break;
            continue;
        }
        if (!verdict) {
            recordStep(action, 'error', lastDhash, 'constitution: check 返回空裁决');
            if (advanceGoal())
                break;
            continue;
        }
        if (verdict.allowed === false) {
            // 否决终局：终局相取目标机；被否决动作不算一步世界推进（不 tick 不入轨迹）
            escalated = true;
            escalateReason = 'constitution-veto';
            evaluateGoal();
            summaryCore = `宪法否决：${verdict.reason}`;
            break;
        }
        if (verdict.requiresApproval === true) {
            // 审批终局：动作放行但必须人工确认 ⇒ 升级移交
            escalated = true;
            escalateReason = 'approval-required';
            evaluateGoal();
            summaryCore = `动作需人工审批：${verdict.reason}`;
            break;
        }
        // ⑤ 策略主动升级 ⇒ 记 no_effect 升级步后终局（不执行）
        if (action.kind === 'escalate') {
            recordStep(action, 'no_effect', lastDhash, decision.note);
            escalated = true;
            escalateReason = 'policy-escalate';
            evaluateGoal();
            summaryCore = `策略主动升级：${action.rationale}`;
            break;
        }
        // ⑥ wait 动作 ⇒ 注入式沉降后继续（不执行，记 no_effect 步）
        if (action.kind === 'wait') {
            try {
                await sleep(opts?.settleMs ?? DEFAULT_SETTLE_MS);
            }
            catch { /* 睡眠异常吞掉 */ }
            recordStep(action, 'no_effect', lastDhash, decision.note);
            if (advanceGoal())
                break;
            continue;
        }
        // ⑥′ 预言铸造（纪元 Ε，纯审计旁路）：动作落世界之前，世界模型按（当前屏型
        //     指纹 × 动作键）铸一次预言（期望下一屏型 + 转移概率）。盲屏（无 dhash）
        //     ⇒ 不铸 —— 看不见的世界不可预言；deps.prophecy 缺席 ⇒ 本段零执行
        //     （逐字节旧路径）；铸造任何故障 ⇒ 吞掉（只丢预言绝不炸环）。
        if (prophecy !== undefined && typeof lastDhash === 'string' && lastDhash !== '') {
            try {
                prophecy.mint(lastDhash, prophecyActionKey(action, snapshot?.width, snapshot?.height));
                prophecyArmed = true;
            }
            catch { /* 铸造故障吞掉 —— 预言是旁路，绝不炸环 */ }
        }
        // ⑦ 执行（异常/缺 outcome ⇒ error 步收敛）
        let exec = null;
        try {
            exec = await deps.execute(action);
        }
        catch (err) {
            recordStep(action, 'error', lastDhash, `execute: ${errText(err)}`);
            if (advanceGoal())
                break;
            continue;
        }
        if (!exec || !exec.outcome) {
            recordStep(action, 'error', lastDhash, 'execute: 返回值缺少 outcome');
            if (advanceGoal())
                break;
            continue;
        }
        // ⑧ 验证：步入轨迹（宪法判决分层盖章）+ 判据证据逐条回填目标机（回填异常吞掉）
        recordStep(action, exec.outcome, lastDhash, decision.note, validRiskTier(verdict.riskTier));
        if (Array.isArray(exec.criteriaEvidence)) {
            for (const evidence of exec.criteriaEvidence) {
                if (evidence === null || typeof evidence !== 'object')
                    continue;
                if (typeof evidence.index !== 'number')
                    continue;
                if (evidence.status !== 'met' && evidence.status !== 'violated')
                    continue;
                try {
                    deps.goal.recordCriterion(evidence.index, evidence.status);
                }
                catch { /* 回填异常吞掉 */ }
                criteriaStatus.set(evidence.index, evidence.status);
            }
        }
        // ⑨ 进化位：tick 后终局评估（achieved/failed/aborted/blocked 任一即熔断）
        if (advanceGoal())
            break;
    }
    if (!summaryCore)
        summaryCore = lastReason ? `目标机判定：${lastReason}` : '循环收敛退出';
    // W4-0（B 接线）：失败终局相铸岔路卡（W3-6）—— goal 落入 failed/aborted 且
    // 岔路账端口在场时，取失败前最近的可岔步铸三候选卡（归因报告缺席 ⇒ unknown
    // 诚实兜底），卡片经 lastBranchCard() 出口供换支重放（applyBranchChoice）与
    // 审计消费。纯旁路 —— PilotResult 既有字段分毫不动；故障吞掉绝不炸环。
    //（finalPhase 的宽化拷贝：lastPhase 经闭包赋值，TS 控制流不知道 —— as 还原
    //  GoalPhase 全域让 failed 比较合法。）
    const w4FinalPhase = lastPhase;
    if (w4Branch !== null && typeof w4Branch.generateCard === 'function' &&
        (w4FinalPhase === 'failed' || w4FinalPhase === 'aborted')) {
        try {
            w4LastCard.card = w4Branch.generateCard({ phase: w4FinalPhase, reason: lastReason, now });
        }
        catch {
            w4LastCard.card = null; // 铸卡故障吞掉 —— 无卡不伪造（诚实降级）
        }
        // W5-5（缝3）：铸卡同步注入在役 steer 会话（steer_answer 岔路模式的持有面 ——
        // 无持有面则 W4-0 的卡只能经 lastBranchCard() 出口审计，用户单键换支的通道
        // 断头）。会话在场且持有面可用才注入；注入是旁路（换支是增益不是依赖），
        // 故障吞掉绝不炸环。steer 未点亮 ⇒ 无会话 ⇒ 卡仍在册（审计面不受影响）。
        if (w4LastCard.card !== null && w4SteerSession !== null &&
            typeof w4SteerSession.holdBranchCard === 'function') {
            try {
                w4SteerSession.holdBranchCard(w4LastCard.card);
            }
            catch {
                /* 持有面故障吞掉 —— 卡仍在 lastBranchCard() 出口在册 */
            }
        }
    }
    let metCount = 0;
    for (const status of criteriaStatus.values()) {
        if (status === 'met')
            metCount++;
    }
    const result = {
        phase: lastPhase,
        steps: stepsTaken,
        durationMs: Math.max(0, now() - startAt),
        trajectory,
        summary: `终局 ${lastPhase}：${summaryCore}，共执行 ${stepsTaken} 步，达成判据 ${metCount}/${criteriaTotal}。`,
        escalated,
    };
    if (escalated)
        result.escalateReason = escalateReason;
    // W1-3 记账出口：门控触发过（触发/跳过/唤醒三本账）即追加总汇报；未触发 ⇒
    // summary 逐字节不变 —— 零回归红律（端口缺席的生产路径恒零触发）
    if (gateProbes > 0) {
        result.summary += `免看门控：触发 ${gateProbes} 次，跳过 ${gateSkips} 次，唤醒 ${gateWakes} 次。`;
    }
    // W3-7 记账出口：探索拦截发生过才追加总汇报；未触发 ⇒ summary 逐字节不变
    // —— 零回归红律（端口缺席/关闭的生产路径恒零触发）
    if (w3ExploreSubs > 0) {
        result.summary += `W3-7 探索拦截：替代升级 ${w3ExploreSubs} 次。`;
    }
    return result;
}
/**
 * 自主闭环入口（识别→判断→宪法→执行→验证→进化的主脉，循环律详见 driveLoop 注释）。
 * 防弹承诺：本函数对任何依赖异常都绝不向外抛 —— 漏网异常也收敛为 failed 的 PilotResult。
 * @param deps 全部外部依赖（感知/策略/执行/目标机/宪法/观察者/睡眠/时钟）
 * @param opts.maxSteps 步数上限（覆盖 spec.maxSteps，末级回退 24）
 * @param opts.settleMs wait 动作沉降毫秒（缺省 300）
 * @returns PilotResult —— phase/steps/durationMs/trajectory/summary/escalated(+/escalateReason)
 */
export async function runAutonomousLoop(deps, opts) {
    try {
        return await driveLoop(deps, opts);
    }
    catch (err) {
        // 最后防线：任何漏网异常收敛为 failed 结果 —— 本模块对外绝不抛
        return {
            phase: 'failed',
            steps: 0,
            durationMs: 0,
            trajectory: [],
            summary: `终局 failed：闭环遭遇未预期异常（${errText(err)}），共执行 0 步，达成判据 0/0。`,
            escalated: false,
        };
    }
}
