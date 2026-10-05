import { onToolPre } from './hooks.js';
import { similarity } from '../perceptualHash.js';
import { approval } from '../approval.js';
import { telemetry } from '../telemetry.js';
import { focusTracker } from '../focusTracker.js';
import * as physicalBackend from '../physicalBackend.js';
// ΠΑΝ-77（多源证据）：生产 OCR 通道 —— 落点邻域实读（textReader 是叶子工具件，
// popupDetector/contextManager 已同律静态依赖；读失败/服务缺席由包装层收敛）
import { readTextAny } from '../textReader.js';
// ΠΑΝ-76（洪泛防护）：探针预算账换分保护区统一件
import { SessionLruCache } from './sessionLru.js';
// ΝΩ-2（物理探针互斥）：试演探针与用户/其他会话动作在同一 D-1 躯体队列排队
//（ioMutex 只读引入 —— 探针步/复位步/帧通道不再与并发物理派发交错，三帧
// 取证证据 h0→h1→h2 的每次派发原子串行，不再被并发动作污染）
import { serialize } from '../ioMutex.js';
import { getPopupState } from './popupGuard.js';
// ΑΩ-R4（审计盲区消除）：物理探针派发的 GUARD_PROBE 存证提交（fail-open ——
// 探针是安全机制本身，审计失败只打点不拦截，立法论证见 probeAudit.ts 文件头）
import { auditGuardProbe } from './probeAudit.js';
// W6-1（doctor 债清偿·smell.over-engineering）：契约类型 + 幂等词汇表 + 触发分类 +
// 反事实预测 + 预测-验证比对三个纯函数区逐字节搬至 ./canaryLogic —— 导入面不变
// （本文件原位再导出全部公共面）。
// W8-B4（tools↔autonomy 破环）：canaryLogic 对上游认识论器官的三张面改为端口注入，
// 本文件是生产装配点 —— 模块装载即把真身（adviseAction / costPriorOfCall /
// scoreOptions 包装）注册进 canaryLogic（同一函数、同一调用序，行为零变化；
// 依赖边 guards→上游为单向合法边，canaryLogic 纯逻辑区不再反向牵动器官包）。
import { adviseAction, costPriorOfCall } from '../autonomy/uncertainty.js';
import { scoreOptions } from '../autonomy/counterfactual.js';
export { CANARY_ACTION_TOOLS, CANARY_PROBE_BUDGET_DEFAULT, CANARY_RESTORE_FLOOR_DEFAULT, isIdempotentToggleLabel, isInstantReactionLabel, classifyCanaryTrigger, compareCanaryObservation, } from './canaryLogic.js';
export { bindCanaryEpistemicPorts, boundCanaryEpistemicPorts } from './canaryLogic.js';
import { CANARY_PROBE_BUDGET_DEFAULT, CANARY_RESTORE_FLOOR_DEFAULT, classifyCanaryTrigger, compareCanaryObservation, bindCanaryEpistemicPorts, } from './canaryLogic.js';
// ─── W8-B4：认识论端口的生产面（自 canaryLogic 回迁的三件套，逐字节同逻辑） ───
/** 零证据空快照（上游 scoreOptions 同律：零证据不伪造 —— deriveEffects 只需动作形状） */
const ZERO_SNAPSHOT = {
    takenAt: 0, width: 0, height: 0, dhash: null, elements: [], textDigest: '',
    popups: [], focusedRegion: null, sceneLabel: '', degraded: [],
};
/** 从工具参数提取字符串（与 canaryLogic 同律的类型收口：非字符串真值一律按缺席） */
function strArg(v) {
    return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}
/** 工具调用 → 合成 PolicyAction（上游器官的词汇面；只用于推导 predictedEffects） */
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
/** 经 scoreOptions 推导 predictedEffects（null = 推导不出）—— predictEffects 端口真身 */
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
// W8-B4：生产装配 —— 模块装载即注册（本文件的任何导入方都带上生产面；与
// canaryLogic 破环前的直接调用同一真身同一调用序，行为零变化）。
bindCanaryEpistemicPorts({
    adviseAction,
    costPriorOfCall,
    predictEffects: predictedEffectsOf,
});
// ─── 探针编排（防御式：一切端口异常收敛为状态，绝不抛、绝不悬挂） ───
/** 端口调用包装：异常 / 非真值 ⇒ false（世界侧是否被触碰由调用序保证）。
 *  ΑΩ-R4：每次物理派发（探针步 + 复位重试步）结算后立即补 GUARD_PROBE 审计
 *  行入防篡改链 —— 此前这些绕过宿主管线的微动作链上无痕。审计 fail-open：
 *  auditGuardProbe 绝不抛，探针行为与既有三帧取证零变化。 */
async function tryStep(name, fn, steps, auditCtx) {
    try {
        const ok = (await fn()) === true;
        steps.push(`${name}: ${ok ? 'ok' : 'dispatch-failed'}`);
        await auditGuardProbe('canary', name, ok ? 'ok' : 'failed', auditCtx);
        return ok;
    }
    catch (e) {
        steps.push(`${name}: threw(${e?.message ?? 'unknown'})`);
        await auditGuardProbe('canary', name, 'threw', auditCtx);
        return false;
    }
}
/** 帧哈希端口包装：异常/非串/空串 ⇒ null（帧通道缺席）。
 *  ΑΩ-R4：帧通道也是物理派发（captureProcessed）—— 同律入链（结果三态
 *  ok=指纹在手 / failed=通道缺席 / threw=端口抛错）；端口未注入属未派发，
 *  无审计行。 */
async function tryHash(ports, point, radius) {
    try {
        if (typeof ports.regionHash !== 'function')
            return null; // 未派发 ⇒ 无审计行
        const h = await ports.regionHash(point, radius);
        const usable = typeof h === 'string' && h.length > 0;
        await auditGuardProbe('canary', 'region-hash', usable ? 'ok' : 'failed', { point, radius });
        return usable ? h : null;
    }
    catch {
        await auditGuardProbe('canary', 'region-hash', 'threw', { point, radius });
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
        const ok1 = await tryStep('probe-click', () => ports.click(p), steps, { point: p });
        if (!ok1)
            return { status: 'unavailable', notes: [...steps, '首步点击派发失败 —— 世界未被触碰'] };
        const h1 = await tryHash(ports, p, radius);
        const ok2 = await tryStep('probe-click-back', () => ports.click(p), steps, { point: p }) ||
            await tryStep('probe-click-back-retry', () => ports.click(p), steps, { point: p });
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
    // type-char：输入 1 字符 → 立即退格（任何可编辑上下文状态恒复原）。
    // ΑΩ-R38：能到达编排层的 type 探针已在 classifyCanaryTrigger 第 7 步过即时
    // 反应词表闸（带 search/自动补全信号的目标在分类层已降级不可论证）—— 此处
    // 不重复判词表（单一事实源，canaryLogic.isInstantReactionLabel）。
    if (typeof ports.typeChar !== 'function' || typeof ports.backspace !== 'function') {
        return { status: 'unavailable', notes: ['输入/退格物理端口缺席'] };
    }
    const h0 = await tryHash(ports, null, radius);
    if (h0 === null)
        return { status: 'unavailable', notes: ['基线帧通道缺席（无 h0 不可比）'] };
    const ch = typeof plan.char === 'string' && plan.char.length > 0 ? plan.char : 'x';
    // ΑΩ-R4 脱敏纪律：type 探针的审计行只记 charCount（单字符事实），字符内容零明文
    const ok1 = await tryStep('probe-type-char', () => ports.typeChar(ch), steps, { charCount: ch.length });
    if (!ok1)
        return { status: 'unavailable', notes: [...steps, '首步输入派发失败 —— 世界未被触碰'] };
    const h1 = await tryHash(ports, null, radius);
    const ok2 = await tryStep('probe-backspace', () => ports.backspace(), steps, {}) ||
        await tryStep('probe-backspace-retry', () => ports.backspace(), steps, {});
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
/**
 * 生产探针端口：physicalBackend 的薄包装。
 *   · 派发闸：healthSnapshot() 在场（绝不因试演孵化服务）且非 dry-run；
 *   · 帧通道：click 用目标邻域 wantRegionHash；type 用焦点槽
 *     （focusTracker，过期即缺席）—— 焦点缺席退全屏 dhash。
 * ΝΩ-2（物理探针互斥）：四个端口的**整个派发体**（含零孵化/dry-run 门控）
 * 经 io.serialize 入队 —— 探针步（点击/单字符/退格）与帧通道（采帧）和用户/
 * 其他会话的物理动作（system.ts 同队列）原子串行：三帧取证（h0→h1→h2）的
 * 每次派发不再被并发点击/输入交错污染。门控在临界区内裁决 —— 拒绝派发也占
 * 一次队列轮转（诚实：探针是否触世界由队列序保证）；排队超时走 ioMutex 的
 * IoTimeoutError → tryStep 收口为 'threw' → 既有降级语义（可用性优先不变）。
 * 原子性边界（诚实声明）：互斥粒度是**单次派发**，不是整个试演序列 —— 探针
 * 两步之间的队列空隙理论上可插入并发动作；彻底的序列级互斥需把编排整体
 * 入队，但 rootCause 冻结探针（300ms 帧间隔）证明「长持锁」会饿死全部用户
 * IO，故按派发粒度立法（与 system.ts 用户的动作粒度对等 —— 不越权插队）。
 */
export function productionCanaryPorts(config, io = { serialize }) {
    const dispatchOk = () => physicalBackend.healthSnapshot() !== null && config.dryRun !== true;
    return {
        click: async (p) => io.serialize(async () => {
            if (!dispatchOk())
                return false;
            await physicalBackend.clickMouse(p.x, p.y, 'left', false);
            return true;
        }),
        typeChar: async (ch) => io.serialize(async () => {
            if (!dispatchOk())
                return false;
            await physicalBackend.typeText(ch, false, false);
            return true;
        }),
        backspace: async () => io.serialize(async () => {
            if (!dispatchOk())
                return false;
            await physicalBackend.pressHotkey(['backspace'], false);
            return true;
        }),
        regionHash: async (p, r) => io.serialize(async () => {
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
        }),
        // ΠΑΝ-77（多源证据）：落点邻域 OCR 实读 —— 分类面的独立证据源。零孵化/
        // dry-run 同律（无后端不读）；读故障 ⇒ null（通道缺席，回自述单源零回归）。
        readRegionText: async (p, r) => io.serialize(async () => {
            if (physicalBackend.healthSnapshot() === null)
                return null; // 零孵化：OCR 通道诚实缺席
            const focus = p ?? focusTracker.get(config.focusMaxAgeMs);
            const cx = focus !== null ? focus.x : 0.5;
            const cy = focus !== null ? focus.y : 0.5;
            const clamp01 = (v) => Math.min(1, Math.max(0, v));
            const region = {
                x: clamp01(cx - r),
                y: clamp01(cy - r),
                width: Math.min(2 * r, 1 - clamp01(cx - r)),
                height: Math.min(2 * r, 1 - clamp01(cy - r)),
            };
            try {
                const { text } = await readTextAny(region);
                return typeof text === 'string' ? text : null;
            }
            catch {
                return null; // OCR 故障 = 通道缺席（不伪造证据，不炸主流程）
            }
        }),
    };
}
// ─── 观察面：事件环 + 预算账本（模块级单例，reset 供测试隔离/插件卸载） ───
const RECENT_LIMIT = 16;
const recentEvents = [];
/**
 * 探针预算账本（ΠΑΝ-76 洪泛防护）：会话键 → 已试演次数。
 * 旧 Map 插入序淘汰可被会话洪泛重置目标会话的预算（6 次/会话上限被绕）；
 * 换分保护区统一件：已消耗（used>0）的账是安全态不参与普通逐出；全局上界
 * 128；每窗新键 ≤8，超限新键的 charge 返回 false（调用方按预算耗尽处理 ——
 * 探针花的是真实物理动作，限流期不给洪泛者无限量的临时预算）。
 */
const probeBudget = new SessionLruCache({
    capacity: 128,
    isProtected: used => used > 0,
    maxNewKeysPerWindow: 8,
    windowMs: 60_000,
    protectedIdleMs: 30 * 60_000,
    onNewKeyLimited: () => { try {
        telemetry.note('canary:budget-new-session-limited', false);
    }
    catch { /* 记账面故障：吞 */ } },
});
function recordEvent(ev) {
    recentEvents.unshift(ev);
    if (recentEvents.length > RECENT_LIMIT)
        recentEvents.length = RECENT_LIMIT;
}
/** 预算读取（命中刷热度 —— F10 修正） */
function budgetUsed(sessionKey) {
    return probeBudget.get(sessionKey) ?? 0;
}
/** 预算记账：返回 false = 新键被洪泛限流（不试演 —— 见 chargeBudget 调用面） */
function chargeBudget(sessionKey) {
    return probeBudget.update(sessionKey, v => (v ?? 0) + 1);
}
/** W2-7：最近的试演事件（时间降序；诊断面板/测试观察面） */
export function recentCanaryEvents() {
    return [...recentEvents];
}
/** W2-7：探针预算账本只读快照（会话键 → 已用次数；可观测面） */
export function canaryBudgetSnapshot() {
    return new Map(probeBudget.entries());
}
/** W2-7：生命周期归零（插件卸载 / 测试隔离） */
export function resetCanaryGuard() {
    recentEvents.length = 0;
    probeBudget.clear();
}
// ─── 守卫注册 ───
/**
 * ΠΑΝ-80：裁决调用是否携带带外确认码证据（在场性检查 —— 码真伪由队列侧
 * ΠΑΝ-1 的哈希消费执法，本守卫不重复校验）。形态与队列契约同律：
 * confirm_code 为非空 string（单条目人体工学形态）或 Record<条目id, 非空码>
 * （批量逐条各交各码）。脏类型一律按无证据（fail-closed 方向）。
 */
function adjudicateCarriesConfirmEvidence(args) {
    try {
        const cc = args?.confirm_code;
        if (typeof cc === 'string' && cc.trim() !== '')
            return true;
        if (cc !== null && typeof cc === 'object' && !Array.isArray(cc)) {
            for (const v of Object.values(cc)) {
                if (typeof v === 'string' && v.trim() !== '')
                    return true;
            }
        }
        return false;
    }
    catch {
        return false; // 防御式：证据面故障 ⇒ 按无证据（拒绝方向）
    }
}
/**
 * 注册金丝雀试演守卫（W2-7）。ports 参数是注入缝 —— 测试注入假物理端口/
 * 假帧哈希（离线确定性）；缺省用生产端口（后端不在场时自动全降级，行为
 * 等价于纯旁路放行）。W6R 例外：携带审批令牌的调用（审批域活口）在探针
 * 缺席/失败时 fail-closed 拦截，除非逃生门 allowUnverifiedDangerous=true。
 * ΠΑΝ-77：ports.readRegionText 在场时，试演准入前对落点邻域做 OCR 实读交叉
 *（自述判 rehearse 后才采集 —— 让位分支零额外读屏成本）。ΠΑΝ-80：裁决面
 *（adjudicate_approval_queue 的 grant 臂）同过金丝雀 —— 无确认码证据的自述
 * 同意主张被 fail-closed 拦截。
 */
export function registerCanaryGuard(ctx, config, ports) {
    onToolPre(ctx, async (call, next) => {
        // 防御式铁律：守卫的一切都在 try 内；任何异常的成本是「这一次不试演」，
        // 绝不是工具调用被吞 / 被拦截 / 被延迟到异常路径。
        try {
            // ── ΠΑΝ-80：金丝雀锚扩展到裁决面（adjudicate 路径也过 canary）──
            // C1-1 H1 / F1-1 对接点：队列裁决是同意的第二入口 —— 模型自述「用户
            // 已批准」与自述 target_description 同为被审计对象的证词（C2-1 F14 的
            // 信任基座错位在裁决面原样存在）。执法：grant 主张必须携带**带外确认码
            // 证据**（入队时锚定的码哈希由队列侧 ΠΑΝ-1 消费 —— 本守卫只查证据
            // 「在场性」，不重复校验码本身）；无码 grant ⇒ fail-closed 拦截并指明
            // 出路（deny 永远可行，不需要人证）。审批闸关闭时队列本就不活跃，跳过。
            if (call.name === 'adjudicate_approval_queue' && config.enableApprovalGate !== false) {
                if (call.args?.grant === true && !adjudicateCarriesConfirmEvidence(call.args)) {
                    recordEvent({
                        at: Date.now(), tool: call.name, action: 'blocked',
                        why: '裁决面金丝雀（ΠΑΝ-80）：grant 主张无带外确认码人证 —— 模型自述单源，拒绝（队列侧 ΠΑΝ-1 同律 fail-closed）',
                    });
                    telemetry.note('canary:blocked', true);
                    return (`[Guard Blocked][Canary]: adjudicate_approval_queue(grant=true) 携带的同意主张没有人类证据 —— ` +
                        `grant 必须附带用户从带外通道（晨报/确认码投递）读给你的 confirm_code（单条目 string 或逐条目 map）。\n` +
                        `  这是防自批闸（与队列侧 ΠΑΝ-1 的码校验同律）：模型转述「用户同意了」不构成同意。\n` +
                        `  出路：① 向用户转达待批清单并索取每条目的确认码后携 confirm_code 重试；` +
                        `② 用户明确拒绝 ⇒ adjudicate(grant=false)（拒绝不需要码）；③ 条目过期 ⇒ 重新 request_approval 走带外铸造。`);
                }
                return next(); // 携码 grant（队列侧执法真伪）/ deny —— 金丝雀让位
            }
            const sessionKey = typeof call.sessionId === 'string' && call.sessionId !== ''
                ? call.sessionId
                : '_anon';
            let trigger = classifyCanaryTrigger(call.name, call.args, {
                dangerPatterns: config.dangerPatterns,
                probeBudgetUsed: budgetUsed(sessionKey),
                probeBudgetCap: CANARY_PROBE_BUDGET_DEFAULT,
            });
            // ── ΠΑΝ-77（多源证据）：自述判「可试演」后，采集独立证据再交叉一次 ──
            // 采集时机刻意放在自述分类命中 rehearse 之后：OCR 是真实读屏往返，只对
            // 「即将按自述试演」的少数调用付费（proceed×high 且幂等标签命中的窄面），
            // 一切让位分支（低危/非 proceed/预算尽/已裁决）零额外成本。通道缺席/
            // 读失败 ⇒ 不重分类（自述单源行为，与 ΠΑΝ-77 前逐字节一致）。
            if (trigger.kind === 'rehearse' && typeof ports?.readRegionText === 'function') {
                let regionText;
                try {
                    const t = await ports.readRegionText(trigger.probe.point, config.probeRegionRadius);
                    regionText = typeof t === 'string' ? t : undefined;
                }
                catch {
                    regionText = undefined; // OCR 故障 = 通道缺席（不伪造证据）
                }
                if (regionText !== undefined) {
                    trigger = classifyCanaryTrigger(call.name, call.args, {
                        dangerPatterns: config.dangerPatterns,
                        probeBudgetUsed: budgetUsed(sessionKey),
                        probeBudgetCap: CANARY_PROBE_BUDGET_DEFAULT,
                        regionText,
                    });
                }
            }
            // ΠΑΝ-77（任一危险即拦）：自述无害而 OCR 实读报危 —— 拦截 + 降级问人
            //（只读 approval.request，同分歧路径；不试演带矛盾证据的调用）。
            if (trigger.kind === 'danger-cross') {
                let token = null;
                try {
                    const pa = approval.request(`[金丝雀多源交叉] ${call.name} 自述无害但落点实读报危 —— 请人工裁决是否放行`, { actionShape: { tool: call.name } });
                    token = pa.token;
                }
                catch {
                    token = null; // 审批通道异常：拦截仍生效，令牌缺席如实记注
                }
                recordEvent({
                    at: Date.now(), tool: call.name, action: 'blocked',
                    why: trigger.note,
                    probe: undefined, point: undefined,
                    approvalToken: token,
                });
                telemetry.note('canary:blocked', true);
                return (`[Guard Blocked][Canary]: 多源证据交叉报危 —— 模型自述该目标无害，但落点邻域 OCR 实读` +
                    `命中危险词，原动作已被拦截并降级为人工审批。\n` +
                    `  action: ${call.name}\n` +
                    `  evidence: ${trigger.note}\n` +
                    (token !== null
                        ? `  approval token minted: ${token} — 请用户经 grant_approval 裁决后携 approval_token 重试；` +
                            `若目标是误标（自述与实读不一致），请先重新定位（find_text/zoom_inspect）核实真实控件。`
                        : `  审批通道铸造失败 —— 请直接向用户说明证据矛盾并等待人工指示，勿强行执行。`));
            }
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
            // ΠΑΝ-76：预算记账（计数先于探针 —— 并发/失败皆不超支）。新键被洪泛
            // 限流 ⇒ 记账未驻留：按「预算不可论证」处理，不试演、让位放行 + 诚实
            // 记注（绝不给限流期的新会话发无限量临时预算 —— 探针花的是真实物理动作）。
            if (!chargeBudget(sessionKey)) {
                recordEvent({
                    at: Date.now(), tool: call.name, action: 'degraded',
                    why: '新会话的探针预算账被洪泛限流（ΠΑΝ-76 分保护区）—— 本次不试演，让位放行（不驱逐既有会话账）',
                });
                telemetry.note('canary:degraded', false);
                return next();
            }
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
            // W6R（fail-closed 收口）：本调用是否走在审批令牌协议上（携带
            // approval_token —— dangerous 分级动作走 beginAttempt/consume 的前件）。
            // 触发分类上，危险词命中的动作已在第 3 步豁免直审批、已授予令牌的调用
            // 已在第 2 步让位 —— 能进入试演的令牌调用只剩「持未授予/悬置令牌的高危
            // 动作」；对这一活口，探针缺席/失败不再降级放行（见 degraded 分支执法）。
            const tokenPath = typeof call.args?.approval_token === 'string' && call.args.approval_token !== '';
            // 逃生门：部署显式接受未验证危险派发（与 clickMouse 的两处 fail-closed
            // 同一把钥匙）；dry-run 豁免（无物理世界可探，拦截只会误杀模拟）。
            const failClosed = tokenPath && config.dryRun !== true && config.allowUnverifiedDangerous !== true;
            const degraded = (why, notes) => {
                recordEvent({
                    at: Date.now(), tool: call.name,
                    action: failClosed ? 'blocked' : 'degraded',
                    why: failClosed ? `${why} —— 审批令牌路径 fail-closed（W6R）：拒绝派发` : why,
                    probe: trigger.probe.kind, point: trigger.probe.point,
                    predictedEffects: trigger.predictedEffects, epistemics,
                    degradedNotes: notes,
                });
                telemetry.note(failClosed ? 'canary:blocked' : 'canary:degraded', failClosed);
                if (failClosed) {
                    // W6R：探针缺席/失败 + 令牌路径 ⇒ 拦截（不调 next 即短路）。不铸造
                    // 审批令牌 —— 这是机器故障（防御栈缺席），不是需要人裁决的预测分歧。
                    return (`[Guard Blocked][Canary]: 高风险动作的试演探针缺席/失败，且本调用携带审批令牌` +
                        `（不可逆动作的 beginAttempt/consume 路径）—— fail-closed 拒绝派发。\n` +
                        `  action: ${call.name} ${why}\n` +
                        `  notes: ${notes.join('；')}\n` +
                        `  出路：① 重试（物理服务/探针端口可能稍后可用）；② 开探针 —— 确保物理服务已存活、` +
                        `探针端口已接线（生产组合根默认注入，测试经 CanaryProbePorts 注入缝）；` +
                        `③ 部署显式逃生门：配置 allowUnverifiedDangerous=true（明确接受未验证危险派发）。`);
                }
                return next(); // 可用性优先：非令牌动作探针缺席/失败 ⇒ 放行原动作（旧行为不变）
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
