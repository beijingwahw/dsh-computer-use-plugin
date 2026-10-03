// src/reversalEscrow.ts
// W3-1（旗舰 S1 逆转托管）：把数据库 saga 的补偿语义移植到 GUI 物理操作。
//
// 数据库事务有 WAL 与补偿事务；GUI agent 的物理动作（点击「发送」、删除文件、
// 提交表单）落进真实世界后，业界 agent 的全部事后手段是「再截一张图看看」。
// S1 把 saga 纪律搬到像素世界，四条铁律：
//   1. 预案先行铸造 —— 危险动作派发前（approval.beginAttempt 前置挂点）必须
//      铸造逆转预案入托管：焦点窗口引用 + 动作前屏幕感知哈希（经注入端口）+
//      剪贴板备份句柄（经注入端口，可缺席）+ 补偿路径（按动作语义从补偿策略表
//      选取，内置 + 可注入扩展）。预案本身先行落盘（tmp+fsync+rename 原子写，
//      独立文件 —— 不碰 journal.ts 的防篡改链）：宁可世界多一次无害的 Ctrl+Z，
//      不可世界少一份「该怎么撤销」的知识。
//   2. 补偿可验证 —— 派发后 TTL 内验收失败（no_effect/错误）或用户喊停（经注入
//      的中断信号端口）⇒ 按预案自动补偿；补偿后验证（屏幕哈希回到预案态，或
//      补偿谓词确认）并记账。验证失败 ⇒ 升级为醒目的人工介入报告，绝不静默。
//   3. 无可逆路径者强制人类亲办 —— 策略表查不到补偿路径（语义未分类）或策略
//      表明示 manual-only（发送/支付类：已发生的不可逆不是技术问题而是物理
//      事实）的危险动作，beginAttempt 直接拒绝（fail-closed），要求走完整
//      审批 + 人类亲办路径。宁可得罪自动化，不可假装可撤销。
//   4. 防御式绝不抛 —— 本模块一切公开面（铸造/结算/补偿/恢复/报表）绝不抛：
//      端口故障、存储垃圾、时钟垃圾一律收敛为诚实返回值与 degraded 标记。
//
// 降级论证（可用性优先）：物理/感知端口经注入，缺席 ⇒ 逆转托管降级为「仅记账
// 不自动补偿」（记 degraded）。方向选择：补偿能力缺席是**已知的环境事实**而非
// 补偿失败 —— 若端口缺席也 fail-closed，则纯视觉插件在无截图/无热键管线的
// 环境里连可逆动作都不可派发，防御纵深反噬可用性；记账仍完整保留（预案、
// 触发原因、缺席清单全部入册），事后审计与人工补救有全量事实。对照：策略表
// 缺补偿路径是**语义事实**（这个动作本质上撤不回），必须 fail-closed ——
// 两种「缺失」方向相反，正交处理。
//
// 与现有体系的正交性：令牌/批注/队列语义零变化；approve 消费点不改；
// beginAttempt 增加可选 opts（缺省不携带 ⇒ 零行为），consume/attemptFailed
// 的托管结算钩子是 fire-and-forget 旁路（异常全吞、无计划 ⇒ no-op）。
// undo 先例：environmentShaper.UndoRecord/undoLog（改变世界的权力与复原世界
// 的义务对称）；本模块把它推广到一切危险派发，并加上 saga 的验证与升级语义。
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, mkdirSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import { similarity } from './perceptualHash.js';
import { setDispatchEscrowHook, setEscrowSettlementHook } from './approval.js';
/**
 * 内置初始集（策略表 = 内置 + 注入扩展，扩展同键覆盖内置）。
 * 键是动作语义类别（派发层对危险动作的分类面，riskGate 词表的对齐产物）：
 *   form-submit  → 草稿箱回收 / Ctrl+Z（多数表单提交会留草稿或支持撤销）
 *   file-delete  → 回收站还原 / Ctrl+Z（GUI 删除默认进回收站 —— 可逆性最强）
 *   file-write   → Ctrl+Z / 编辑菜单撤销（文档类写入普遍支持 undo 栈）
 *   send-message → manual-only（已发出的消息无法收回 —— 唯一例外：部署注入
 *                  「延迟发送队列撤回」类扩展后方可自动派发）
 *   payment      → manual-only（退款不是撤销 —— 资金流的逆流是新交易）
 *   permanent-delete → manual-only（不进回收站的删除 —— 语义上已放弃可逆性）
 */
const BUILTIN_STRATEGIES = new Map([
    ['form-submit', {
            kind: 'compensate',
            semantics: 'form-submit',
            steps: [
                { method: 'hotkey', label: 'Ctrl+Z undo the submission', keys: ['ctrl', 'z'] },
                { method: 'navigate', label: 'recover from drafts folder', target: 'drafts' },
            ],
            verify: { mode: 'screen-hash' },
            notes: '表单提交：多数客户端保留草稿或支持撤销',
        }],
    ['file-delete', {
            kind: 'compensate',
            semantics: 'file-delete',
            steps: [
                { method: 'recycle-bin-restore', label: 'restore from recycle bin', target: 'recycle-bin' },
                { method: 'hotkey', label: 'Ctrl+Z undo the delete', keys: ['ctrl', 'z'] },
            ],
            verify: { mode: 'screen-hash' },
            notes: 'GUI 删除默认进回收站 —— 可逆性最强的危险动作',
        }],
    ['file-write', {
            kind: 'compensate',
            semantics: 'file-write',
            steps: [
                { method: 'hotkey', label: 'Ctrl+Z undo the write', keys: ['ctrl', 'z'] },
                { method: 'menu', label: 'Edit > Undo menu', target: 'Edit>Undo' },
            ],
            verify: { mode: 'screen-hash' },
            notes: '文档类写入普遍支持应用内 undo 栈',
        }],
    ['send-message', {
            kind: 'manual-only',
            semantics: 'send-message',
            reason: 'send-class actions have NO compensation path: a delivered message cannot be unsent — the human must perform this personally (full approval + manual execution)',
        }],
    ['payment', {
            kind: 'manual-only',
            semantics: 'payment',
            reason: 'payments are irreversible: a refund is a NEW transaction, not an undo — the human must perform this personally',
        }],
    ['permanent-delete', {
            kind: 'manual-only',
            semantics: 'permanent-delete',
            reason: 'permanent delete bypasses the recycle bin by intent — irreversibility was the point — the human must perform this personally',
        }],
]);
// ─── 常量 ───
/** 在途预案 TTL：派发 → 验收结算的窗口（缺省 30s —— 远短于审批 TTL，
 *  因为结算紧随派发；覆盖验证等待与一次自动重试的间隔） */
const DEFAULT_ESCROW_TTL_MS = 30_000;
/** screen-hash 验证缺省阈值：dHash 64 位下 similarity ≥ 0.9（≤6 位差）——
 *  「回到预案态」的抖动容忍带（光标/菜单残影占少数位） */
const DEFAULT_VERIFY_THRESHOLD = 0.9;
/** 账册封顶（无界账册 = 无界 WAL —— 封顶后丢最旧，恢复报告优先保新） */
const MAX_LEDGER_ENTRIES = 256;
/** WAL 档版本 */
const ESCROW_WAL_VERSION = 1;
// ─── 文件存储实现（tmp + fsync + rename —— checkpoint.ts / approval.ts 同律） ───
/** W3-1：托管 WAL 的文件实现（原子写：tmp + fsync + rename —— 绝无半档） */
export function createEscrowFileStorage(filePath) {
    return {
        load() {
            try {
                if (!filePath || !existsSync(filePath))
                    return null;
                const text = readFileSync(filePath, 'utf8');
                return typeof text === 'string' && text.trim() !== '' ? text : null;
            }
            catch {
                return null; // 读故障（含 ENOENT 竞态）= 无在途托管（诚实方向）
            }
        },
        save(text) {
            if (!filePath)
                return { ok: false, error: 'escrow wal path is empty' };
            const tmp = filePath + '.tmp';
            try {
                mkdirSync(path.dirname(filePath), { recursive: true });
                // fsync 落盘后再换名：rename 可先于数据块持久化 —— 崩溃后可能读到空/截断档
                const fd = openSync(tmp, 'w');
                try {
                    writeSync(fd, Buffer.from(text, 'utf8'));
                    fsyncSync(fd);
                }
                finally {
                    closeSync(fd);
                }
                renameSync(tmp, filePath); // 原子换名：要么完整旧档要么完整新档
                return { ok: true };
            }
            catch (e) {
                try {
                    unlinkSync(tmp);
                }
                catch { /* tmp 可能未创建 */ }
                return { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
        },
    };
}
// ─── 模块态（全部经 arm 注入；缺省 = 无端口 + 内置表 + 真钟 + 仅内存） ───
let escrowStorage = null;
let escrowNow = Date.now;
let escrowTtlMs = DEFAULT_ESCROW_TTL_MS;
let hashPort = null;
let clipboardPort = null;
let focusPort = null;
let interruptPort = null;
let executorPort = null;
/** 注入扩展的策略表（同键覆盖内置） */
let extensionStrategies = new Map();
let inFlightPlans = new Map(); // planId → plan
let tokenPlan = new Map(); // approvalToken → planId
let ledger = [];
let walLoaded = false;
let walPersistError;
/** approval 钩子注册标记（arm 注册 / escrow.reset 后回 false —— 透明化事实源） */
let hooksRegistered = false;
/** 在途异步工作（fire-and-forget 结算的追踪面 —— idle() 供测试/宿主排空） */
const activeWork = new Set();
/** 安全时钟读数（注入钟抛错/回垃圾 ⇒ 真钟兜底 —— TTL 语义不因计时面归零） */
function eNow() {
    try {
        const t = escrowNow();
        if (typeof t === 'number' && Number.isFinite(t) && t >= 0)
            return t;
    }
    catch { /* 注入钟故障 ⇒ 真钟兜底 */ }
    try {
        return Date.now();
    }
    catch {
        return 0;
    }
}
function newPlanId() {
    return 'ESC-' + randomBytes(8).toString('hex').toUpperCase();
}
/** 字符串净化：非字符串/空 ⇒ undefined；否则截断（Token 纪律与隐私截断） */
function strOrUndef(v, max) {
    return typeof v === 'string' && v.trim() !== '' ? v.slice(0, max) : undefined;
}
// ─── WAL 装载 / 净化 / 落盘 ───
/** 补偿步骤净化（垃圾 ⇒ null 弃置） */
function sanitizeStep(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw;
    const method = r.method;
    const label = strOrUndef(r.label, 200);
    if (typeof method !== 'string' || label === undefined)
        return null;
    const ALLOWED = ['hotkey', 'menu', 'recycle-bin-restore', 'clipboard-restore', 'navigate', 'shaper-undo', 'custom'];
    if (!ALLOWED.includes(method))
        return null;
    const step = { method: method, label };
    if (Array.isArray(r.keys)) {
        const keys = r.keys.filter((k) => typeof k === 'string' && k.trim() !== '').slice(0, 8);
        if (keys.length > 0)
            step.keys = keys;
    }
    const target = strOrUndef(r.target, 200);
    if (target !== undefined)
        step.target = target;
    return step;
}
/** 预案净化（垃圾 ⇒ null 弃置 —— 好预案不连坐） */
function sanitizePlan(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw;
    const planId = strOrUndef(r.planId, 64);
    const semantics = strOrUndef(r.semantics, 64);
    const mintedAt = r.mintedAt;
    const ttlMs = r.ttlMs;
    const expiresAt = r.expiresAt;
    const compensation = r.compensation;
    if (planId === undefined || semantics === undefined)
        return null;
    if (typeof mintedAt !== 'number' || !Number.isFinite(mintedAt) || mintedAt < 0)
        return null;
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0)
        return null;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt < 0)
        return null;
    if (!Array.isArray(compensation))
        return null;
    const steps = [];
    for (const s of compensation) {
        const step = sanitizeStep(s);
        if (step)
            steps.push(step);
    }
    if (steps.length === 0)
        return null; // 无补偿路径的预案不是预案
    const plan = {
        planId, semantics,
        mintedAt: Math.floor(mintedAt),
        ttlMs: Math.floor(ttlMs),
        expiresAt: Math.floor(expiresAt),
        compensation: steps,
        verifyMode: r.verifyMode === 'screen-hash' || r.verifyMode === 'predicate' || r.verifyMode === 'none'
            ? r.verifyMode : 'none',
    };
    const token = strOrUndef(r.approvalToken, 64);
    if (token !== undefined)
        plan.approvalToken = token;
    const desc = strOrUndef(r.description, 200);
    if (desc !== undefined)
        plan.description = desc;
    const tool = strOrUndef(r.tool, 64);
    if (tool !== undefined)
        plan.tool = tool;
    const focus = strOrUndef(r.focusWindow, 200);
    if (focus !== undefined)
        plan.focusWindow = focus;
    const hash = strOrUndef(r.preActionHash, 256);
    if (hash !== undefined)
        plan.preActionHash = hash;
    const clip = strOrUndef(r.clipboardBackupHandle, 256);
    if (clip !== undefined)
        plan.clipboardBackupHandle = clip;
    if (typeof r.verifyThreshold === 'number' && Number.isFinite(r.verifyThreshold)) {
        plan.verifyThreshold = r.verifyThreshold;
    }
    if (Array.isArray(r.degraded)) {
        const tags = r.degraded.filter((d) => typeof d === 'string').slice(0, 16);
        if (tags.length > 0)
            plan.degraded = tags;
    }
    return plan;
}
/**
 * 惰性装载 + 崩溃恢复：首次触面时从 WAL 读档。**在途预案 ⇒ 不自动补偿** ——
 * 崩溃后的世界状态未知（动作可能已生效、屏幕早已相变数页），按陈旧预案对
 * 现在的屏幕执行热键是新一轮破坏；saga 的 in-doubt 事务在恢复期只做一件事：
 * 醒目地交给人。每条在途预案转为 recovered-human-attention 账册记录 +
 * 升级报告（pendingHumanAttention 持续可见，直到宿主 acknowledge）。
 */
function ensureWalLoaded() {
    if (walLoaded)
        return;
    walLoaded = true;
    inFlightPlans = new Map();
    tokenPlan = new Map();
    ledger = [];
    if (escrowStorage === null)
        return; // 仅内存（跨进程不保 —— 诚实降级）
    try {
        const text = escrowStorage.load();
        if (text === null)
            return;
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object')
            return; // 垃圾档 ⇒ 归零
        const root = parsed;
        const now = eNow();
        if (Array.isArray(root.ledger)) {
            for (const raw of root.ledger.slice(-MAX_LEDGER_ENTRIES)) {
                const rec = sanitizeLedgerRecord(raw);
                if (rec)
                    ledger.push(rec);
            }
        }
        if (Array.isArray(root.inFlight)) {
            let recovered = 0;
            for (const raw of root.inFlight) {
                const plan = sanitizePlan(raw);
                if (plan === null)
                    continue; // 垃圾预案弃置（好预案不连坐）
                const rec = {
                    planId: plan.planId,
                    semantics: plan.semantics,
                    ...(plan.description !== undefined ? { description: plan.description } : {}),
                    ...(plan.approvalToken !== undefined ? { approvalToken: plan.approvalToken } : {}),
                    mintedAt: plan.mintedAt,
                    settledAt: now,
                    outcome: 'recovered-human-attention',
                    trigger: 'crash-recovery',
                    reason: 'in-flight escrow plan found in WAL after restart — world state unknown, auto-compensation refused',
                    executedSteps: [],
                    escalation: {
                        severity: 'critical',
                        headline: 'REVERSAL ESCROW: in-flight plan recovered from WAL — HUMAN ATTENTION REQUIRED',
                        planId: plan.planId,
                        semantics: plan.semantics,
                        whatHappened: `A dangerous "${plan.semantics}" action had a minted reversal escrow plan when the process stopped. ` +
                            'Whether the action took effect is UNKNOWN. Automated compensation on the post-crash screen was refused ' +
                            '(acting on a stale plan against an unknown world state is a new hazard, not a remedy).',
                        compensationAttempted: [],
                        suggestedHumanAction: plan.description
                            ? `Inspect the world manually for: ${plan.description}. If the action took effect and is unwanted, ` +
                                `apply the compensation path by hand: ${plan.compensation.map(s => s.label).join('; ')}.`
                            : `Inspect the world manually for the "${plan.semantics}" action; if unwanted, compensate by hand: ` +
                                plan.compensation.map(s => s.label).join('; ') + '.',
                        mintedAt: plan.mintedAt,
                        raisedAt: now,
                    },
                };
                ledger.push(rec);
                recovered++;
            }
            if (recovered > 0) {
                // 恢复结算立即落盘：恢复动作本身崩溃 ⇒ 下次恢复重读原档（幂等 ——
                // 原档未被改写，同批预案再次浮现；宁可重复唠叨，不可静默蒸发）
                persistWal();
            }
        }
    }
    catch {
        /* 解析故障 ⇒ 归零（防御式：坏档不炸托管，也不冒充恢复） */
    }
}
/** 账册记录净化（垃圾 ⇒ null 弃置） */
function sanitizeLedgerRecord(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw;
    const planId = strOrUndef(r.planId, 64);
    const semantics = strOrUndef(r.semantics, 64);
    const mintedAt = r.mintedAt;
    const settledAt = r.settledAt;
    const OUTCOMES = [
        'verified', 'aborted-pre-dispatch', 'compensated-verified', 'compensated-unverified',
        'compensation-failed', 'degraded-record-only', 'recovered-human-attention',
    ];
    if (planId === undefined || semantics === undefined)
        return null;
    if (typeof mintedAt !== 'number' || !Number.isFinite(mintedAt) || mintedAt < 0)
        return null;
    if (typeof settledAt !== 'number' || !Number.isFinite(settledAt) || settledAt < 0)
        return null;
    if (typeof r.outcome !== 'string' || !OUTCOMES.includes(r.outcome))
        return null;
    const rec = {
        planId, semantics,
        mintedAt: Math.floor(mintedAt),
        settledAt: Math.floor(settledAt),
        outcome: r.outcome,
    };
    const desc = strOrUndef(r.description, 200);
    if (desc !== undefined)
        rec.description = desc;
    const token = strOrUndef(r.approvalToken, 64);
    if (token !== undefined)
        rec.approvalToken = token;
    const trigger = strOrUndef(r.trigger, 64);
    if (trigger !== undefined)
        rec.trigger = trigger;
    const reason = strOrUndef(r.reason, 400);
    if (reason !== undefined)
        rec.reason = reason;
    if (Array.isArray(r.executedSteps)) {
        const steps = r.executedSteps.filter((s) => typeof s === 'string').slice(0, 16);
        if (steps.length > 0)
            rec.executedSteps = steps;
    }
    if (Array.isArray(r.degraded)) {
        const tags = r.degraded.filter((d) => typeof d === 'string').slice(0, 16);
        if (tags.length > 0)
            rec.degraded = tags;
    }
    const esc = r.escalation;
    if (esc && typeof esc === 'object') {
        const e = esc;
        const headline = strOrUndef(e.headline, 400);
        const suggested = strOrUndef(e.suggestedHumanAction, 800);
        if (headline !== undefined && suggested !== undefined) {
            const failure = strOrUndef(e.failureDetail, 400);
            rec.escalation = {
                severity: 'critical',
                headline,
                planId,
                semantics,
                whatHappened: strOrUndef(e.whatHappened, 800) ?? '',
                compensationAttempted: Array.isArray(e.compensationAttempted)
                    ? e.compensationAttempted.filter((s) => typeof s === 'string').slice(0, 16) : [],
                ...(failure !== undefined ? { failureDetail: failure } : {}),
                suggestedHumanAction: suggested,
                mintedAt: typeof e.mintedAt === 'number' && Number.isFinite(e.mintedAt) ? e.mintedAt : mintedAt,
                raisedAt: typeof e.raisedAt === 'number' && Number.isFinite(e.raisedAt) ? e.raisedAt : settledAt,
                ...(typeof e.acknowledgedAt === 'number' && Number.isFinite(e.acknowledgedAt) ? { acknowledgedAt: e.acknowledgedAt } : {}),
            };
        }
    }
    return rec;
}
/** WAL 落盘（存储缺席 = 仅内存恒 ok；失败记 walPersistError —— 绝不抛） */
function persistWal() {
    if (escrowStorage === null)
        return { ok: true };
    try {
        const r = escrowStorage.save(JSON.stringify({
            version: ESCROW_WAL_VERSION,
            savedAt: eNow(),
            inFlight: [...inFlightPlans.values()],
            ledger: ledger.slice(-MAX_LEDGER_ENTRIES),
        }));
        if (!r.ok)
            walPersistError = r.error ?? 'unknown storage error';
        else
            walPersistError = undefined;
        return r;
    }
    catch (e) {
        walPersistError = e instanceof Error ? e.message : String(e);
        return { ok: false, error: walPersistError };
    }
}
/** 策略查表：扩展覆盖内置（注入扩展是部署对策略表的显式修订 —— 后见者胜） */
function lookupStrategy(semantics) {
    const ext = extensionStrategies.get(semantics);
    if (ext)
        return ext;
    return BUILTIN_STRATEGIES.get(semantics) ?? null;
}
/** 在途异步工作登记（fire-and-forget 结算的排空面） */
function track(p) {
    activeWork.add(p);
    void p.finally(() => { activeWork.delete(p); }).catch(() => { });
    return p;
}
// ─── 预案铸造 ───
/**
 * 铸造逆转预案（危险动作派发**之前**调用 —— approval.beginAttempt 的前置挂点）。
 * 语义序：策略查表（缺失/manual-only ⇒ fail-closed 拒绝，人类亲办）→ 端口采集
 * （缺席 ⇒ 诚实缺席 + degraded 标记）→ **WAL 先行落盘**（失败 ⇒ 拒绝 —— 预案
 * 不入托管即不派发，H4 takeGranted「宁可保守不可双发」同律）→ 注册返回。
 * 同令牌重复铸造 ⇒ 旧在途预案就地流产（aborted-superseded：beginAttempt 的
 * 单在途约束保证被顶替的预案从未派发 —— 无补偿义务）。绝不抛。
 */
async function mintPlan(info) {
    try {
        ensureWalLoaded();
        const semantics = strOrUndef(info?.semantics, 64);
        if (semantics === undefined)
            return { ok: false, reason: 'no-strategy', detail: 'semantics is required to look up a compensation path' };
        // 铁律 3：无可逆路径者强制人类亲办（fail-closed —— 两类成因分开报告）
        const strategy = lookupStrategy(semantics);
        if (strategy === null) {
            return {
                ok: false, reason: 'no-strategy',
                detail: `no compensation strategy for semantics "${semantics}" — classify the action (extend the strategy table) ` +
                    'or the HUMAN must perform it personally via full approval + manual execution',
            };
        }
        if (strategy.kind === 'manual-only') {
            return { ok: false, reason: 'manual-only', detail: strategy.reason };
        }
        // 端口采集（逐个防御：故障 = 缺席 + degraded 标记 —— 可用性优先）
        const degraded = [];
        const focusWindow = await captureFromPort('focus', () => focusPort?.current() ?? Promise.resolve(null), degraded, 'no-focus-port');
        const preActionHash = await captureFromPort('hash', () => hashPort?.capture() ?? Promise.resolve(null), degraded, 'no-hash-port');
        const clipboardBackupHandle = await captureFromPort('clipboard', () => clipboardPort?.backup() ?? Promise.resolve(null), degraded, 'no-clipboard-port');
        if (executorPort === null)
            degraded.push('no-executor-port');
        if (escrowStorage === null)
            degraded.push('no-storage');
        const now = eNow();
        const ttl = Math.max(1_000, typeof info?.ttlMs === 'number' && Number.isFinite(info.ttlMs) ? info.ttlMs : escrowTtlMs);
        const description = strOrUndef(info?.description, 200);
        const approvalToken = strOrUndef(info?.approvalToken, 64);
        const tool = strOrUndef(info?.tool, 64);
        const plan = {
            planId: newPlanId(),
            semantics,
            ...(description !== undefined ? { description } : {}),
            ...(approvalToken !== undefined ? { approvalToken } : {}),
            ...(tool !== undefined ? { tool } : {}),
            mintedAt: now,
            ttlMs: ttl,
            expiresAt: now + ttl,
            compensation: strategy.steps.map(s => ({ ...s })), // 自包含快照
            verifyMode: strategy.verify.mode,
            ...(focusWindow !== undefined ? { focusWindow } : {}),
            ...(preActionHash !== undefined ? { preActionHash } : {}),
            ...(clipboardBackupHandle !== undefined ? { clipboardBackupHandle } : {}),
            ...(strategy.verify.mode === 'screen-hash'
                ? { verifyThreshold: strategy.verify.threshold ?? DEFAULT_VERIFY_THRESHOLD } : {}),
            ...(degraded.length > 0 ? { degraded } : {}),
        };
        // 同令牌旧在途预案流产（见函数头注释的论证）
        if (plan.approvalToken !== undefined) {
            const staleId = tokenPlan.get(plan.approvalToken);
            if (staleId !== undefined && inFlightPlans.has(staleId)) {
                closePlan(inFlightPlans.get(staleId), {
                    outcome: 'aborted-pre-dispatch', trigger: 'superseded',
                    reason: 'superseded by a newer mint for the same approval token (single in-flight dispatch per token)',
                });
            }
        }
        // 铁律 4（WAL 语义）：预案先行落盘 —— 失败 ⇒ 不入托管即拒绝派发
        inFlightPlans.set(plan.planId, plan);
        if (plan.approvalToken !== undefined)
            tokenPlan.set(plan.approvalToken, plan.planId);
        const persisted = persistWal();
        if (!persisted.ok) {
            inFlightPlans.delete(plan.planId);
            if (plan.approvalToken !== undefined)
                tokenPlan.delete(plan.approvalToken);
            return { ok: false, reason: 'persist-failed', detail: persisted.error };
        }
        return { ok: true, plan: clonePlan(plan) };
    }
    catch {
        return { ok: false, reason: 'internal' }; // 防御式兜底（正常流不可达）
    }
}
/** 端口采集的防御包装：端口缺席/抛错/非字符串 ⇒ undefined + degraded 标记 */
async function captureFromPort(_name, fn, degraded, absentTag) {
    try {
        const v = await fn();
        if (typeof v === 'string' && v.trim() !== '')
            return v.slice(0, 256);
        degraded.push(absentTag);
        return undefined;
    }
    catch {
        degraded.push(absentTag); // 端口故障 = 端口缺席（诚实降级，绝不炸铸造）
        return undefined;
    }
}
// ─── 派发闸门（approval.beginAttempt 的同步前置钩子） ───
/**
 * beginAttempt 前置闸门（同步面 —— 物理派发前的最后一道托管执法）：
 * 无 planId ⇒ plan-required（必须先铸造 —— 「预案先行」的执法点）；
 * planId 无效/令牌错配/TTL 已过 ⇒ 拒绝。策略表缺失的拒绝发生在铸造面
 * （mintPlan fail-closed），此处保证**没有预案就绝无派发预留**。
 */
function dispatchGate(check) {
    try {
        ensureWalLoaded();
        if (!check?.planId) {
            return {
                ok: false, reason: 'plan-required',
                detail: 'dangerous dispatch requires a minted reversal plan — call reversalEscrow.mintPlan BEFORE beginAttempt ' +
                    '(actions without a compensation path are rejected fail-closed and must be performed by the human)',
            };
        }
        const plan = inFlightPlans.get(check.planId);
        if (!plan)
            return { ok: false, reason: 'plan-invalid', detail: `no in-flight escrow plan "${check.planId}"` };
        if (plan.approvalToken !== undefined && check.token !== plan.approvalToken) {
            return { ok: false, reason: 'plan-token-mismatch', detail: `plan ${plan.planId} was minted for a different approval token` };
        }
        if (eNow() > plan.expiresAt) {
            return { ok: false, reason: 'plan-expired', detail: `plan ${plan.planId} TTL elapsed before dispatch` };
        }
        return { ok: true };
    }
    catch {
        return { ok: false, reason: 'plan-invalid', detail: 'internal gate failure — failing closed' };
    }
}
// ─── 结算与补偿 ───
/** 占位：把预案原子摘出在途表 —— 并发的第二结算/中断/巡检找不到 ⇒ 不补
 *  （补偿恰一次的执法点；摘要出后 closePlan 入账册，WAL 随行更新） */
function claimPlan(plan) {
    if (!inFlightPlans.has(plan.planId))
        return false;
    inFlightPlans.delete(plan.planId);
    if (plan.approvalToken !== undefined && tokenPlan.get(plan.approvalToken) === plan.planId) {
        tokenPlan.delete(plan.approvalToken);
    }
    return true;
}
/** 按令牌结算（consume/attemptFailed 的钩子落点；fire-and-forget 调用） */
function settleByToken(token, kind, reason) {
    return track((async () => {
        ensureWalLoaded();
        const cleanToken = String(token ?? '').trim();
        const planId = tokenPlan.get(cleanToken);
        if (planId === undefined)
            return; // 无在途预案 ⇒ no-op（正交性：普通审批流零参与）
        const plan = inFlightPlans.get(planId);
        if (!plan) {
            tokenPlan.delete(cleanToken);
            return;
        }
        if (!claimPlan(plan))
            return; // 已被并发结算/中断占位 ⇒ 不补（恰一次）
        if (kind === 'verified') {
            closePlan(plan, { outcome: 'verified', trigger: 'acceptance-verified' });
            return;
        }
        await runCompensation(plan, reason === 'no-effect' ? 'no-effect' : 'acceptance-failed', reason);
    })());
}
/** 关闭预案入账册（WAL 随行；结算落盘失败 ⇒ 内存账册仍准确 —— 见 persistWal 注释） */
function closePlan(plan, fields) {
    inFlightPlans.delete(plan.planId);
    if (plan.approvalToken !== undefined && tokenPlan.get(plan.approvalToken) === plan.planId) {
        tokenPlan.delete(plan.approvalToken);
    }
    // 降级标记合并面：铸造时缺席清单 ∪ 结算时新增（如 no-verify-channel）
    const mergedDegraded = [...new Set([...(plan.degraded ?? []), ...(fields.degraded ?? [])])];
    const now = eNow();
    ledger.push({
        planId: plan.planId,
        semantics: plan.semantics,
        ...(plan.description !== undefined ? { description: plan.description } : {}),
        ...(plan.approvalToken !== undefined ? { approvalToken: plan.approvalToken } : {}),
        mintedAt: plan.mintedAt,
        settledAt: now,
        outcome: fields.outcome,
        ...(fields.trigger !== undefined ? { trigger: fields.trigger } : {}),
        ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
        ...(fields.executedSteps !== undefined && fields.executedSteps.length > 0 ? { executedSteps: fields.executedSteps } : {}),
        ...(mergedDegraded.length > 0 ? { degraded: mergedDegraded } : {}),
        ...(fields.escalation !== undefined ? { escalation: fields.escalation } : {}),
    });
    if (ledger.length > MAX_LEDGER_ENTRIES)
        ledger = ledger.slice(-MAX_LEDGER_ENTRIES);
    persistWal();
}
/** 构造补偿失败的升级报告（醒目 —— 绝不静默的落点） */
function buildEscalation(plan, whatHappened, attempted, failureDetail, suggestedHumanAction) {
    const now = eNow();
    return {
        severity: 'critical',
        headline: 'REVERSAL ESCROW: compensation FAILED — HUMAN INTERVENTION REQUIRED',
        planId: plan.planId,
        semantics: plan.semantics,
        whatHappened,
        compensationAttempted: attempted,
        failureDetail,
        suggestedHumanAction,
        mintedAt: plan.mintedAt,
        raisedAt: now,
    };
}
/**
 * 执行补偿（铁律 2 的核心）：无执行端口 ⇒ degraded-record-only（仅记账 —— 可用性
 * 优先，见模块头降级论证）；逐步执行（clipboard-restore 走一等端口，其余走执行
 * 端口），一步失败即止 ⇒ compensation-failed + 升级报告；全部执行 ⇒ 验证
 * （screen-hash 回预案态 / 谓词确认 / 无通道 ⇒ compensated-unverified 诚实降级）。
 */
async function runCompensation(plan, trigger, reason) {
    // 降级：执行端口缺席 ⇒ 仅记账（预案与触发原因全量入册 —— 审计面完整）
    if (executorPort === null) {
        closePlan(plan, {
            outcome: 'degraded-record-only',
            trigger,
            ...(reason !== undefined ? { reason: `${reason ?? ''}${reason ? '; ' : ''}no compensation executor port — record only (degraded)` } : { reason: 'no compensation executor port — record only (degraded)' }),
        });
        return;
    }
    const attempted = [];
    const degraded = [...(plan.degraded ?? [])];
    try {
        for (const step of plan.compensation) {
            attempted.push(step.label);
            if (step.method === 'clipboard-restore') {
                // 剪贴板恢复是一等端口义务（有备份句柄 + 端口在场才可恢复）
                if (plan.clipboardBackupHandle === undefined || clipboardPort === null) {
                    degraded.push('clipboard-restore-unavailable');
                    continue; // 非致命：跳过该步继续主补偿路径
                }
                const ok = await clipboardPort.restore(plan.clipboardBackupHandle);
                if (!ok) {
                    degraded.push('clipboard-restore-failed');
                    continue; // 剪贴板是伴生恢复，失败不阻断主补偿
                }
                continue;
            }
            const r = await executorPort.execute(step, plan);
            if (!r.ok) {
                closePlan(plan, {
                    outcome: 'compensation-failed',
                    trigger,
                    ...(reason !== undefined ? { reason } : {}),
                    executedSteps: [...attempted],
                    ...(degraded.length > 0 ? { degraded: [...new Set(degraded)] } : {}),
                    escalation: buildEscalation(plan, `Dangerous "${plan.semantics}" action failed acceptance (trigger: ${trigger}) and automated compensation FAILED at step "${step.label}". ` +
                        'The world may be left in an unintended state.', [...attempted], r.detail ?? 'executor reported failure', plan.description
                        ? `Manually inspect: ${plan.description}. Then compensate by hand — remaining path: ${plan.compensation.slice(attempted.length).map(s => s.label).join('; ') || step.label}.`
                        : `Manually inspect the "${plan.semantics}" action and compensate by hand: ${plan.compensation.map(s => s.label).join('; ')}.`),
                });
                return;
            }
        }
        // 验证（补偿可验证 —— 铁律 2 的第二半）
        const verified = await verifyCompensation(plan);
        const degradedField = degraded.length > 0 ? { degraded: [...new Set(degraded)] } : {};
        if (verified === 'verified') {
            closePlan(plan, { outcome: 'compensated-verified', trigger, ...(reason !== undefined ? { reason } : {}), executedSteps: [...attempted], ...degradedField });
        }
        else if (verified === 'failed') {
            closePlan(plan, {
                outcome: 'compensation-failed',
                trigger,
                ...(reason !== undefined ? { reason } : {}),
                executedSteps: [...attempted],
                ...degradedField,
                escalation: buildEscalation(plan, `Compensation steps for the "${plan.semantics}" action all executed, but VERIFICATION says the world did NOT return to the pre-action state (trigger: ${trigger}).`, [...attempted], 'screen hash did not return to the pre-action plan state', plan.focusWindow
                    ? `Bring window "${plan.focusWindow}" to front and manually verify/complete the undo: ${plan.compensation.map(s => s.label).join('; ')}.`
                    : `Manually verify/complete the undo: ${plan.compensation.map(s => s.label).join('; ')}.`),
            });
        }
        else {
            // 'no-channel'：补偿已执行但无验证通道 —— 诚实降级记账（区别于验证失败）
            degraded.push('no-verify-channel');
            closePlan(plan, {
                outcome: 'compensated-unverified',
                trigger,
                ...(reason !== undefined ? { reason } : {}),
                executedSteps: [...attempted],
                ...(degraded.length > 0 ? { degraded: [...new Set(degraded)] } : {}),
            });
        }
    }
    catch (e) {
        // 防御式：补偿路径自身异常 ⇒ 视同补偿失败升级（绝不静默吞掉一个可能受损的世界）
        const detail = e instanceof Error ? e.message : String(e);
        closePlan(plan, {
            outcome: 'compensation-failed',
            trigger,
            ...(reason !== undefined ? { reason } : {}),
            executedSteps: [...attempted],
            ...(degraded.length > 0 ? { degraded: [...new Set(degraded)] } : {}),
            escalation: buildEscalation(plan, `Compensation for the "${plan.semantics}" action crashed (trigger: ${trigger}). The world may be left in an unintended state.`, [...attempted], detail, `Manually inspect the world and compensate by hand: ${plan.compensation.map(s => s.label).join('; ')}.`),
        });
    }
}
/** 补偿验证：'verified' | 'failed' | 'no-channel'（无通道 ≠ 失败 —— 诚实降级） */
async function verifyCompensation(plan) {
    try {
        if (plan.verifyMode === 'screen-hash') {
            if (hashPort === null || plan.preActionHash === undefined)
                return 'no-channel';
            const now = await hashPort.capture();
            if (typeof now !== 'string' || now.trim() === '')
                return 'no-channel'; // 采集失败 = 无通道（非验证失败）
            const sim = similarity(now, plan.preActionHash);
            const threshold = plan.verifyThreshold ?? DEFAULT_VERIFY_THRESHOLD;
            return sim >= threshold ? 'verified' : 'failed';
        }
        if (plan.verifyMode === 'predicate') {
            const strategy = lookupStrategy(plan.semantics);
            if (strategy && strategy.kind === 'compensate' && typeof strategy.verifyPredicate === 'function') {
                return (await strategy.verifyPredicate(plan)) ? 'verified' : 'failed';
            }
            return 'no-channel'; // 谓词随扩展注入，铸造后扩展被卸载 ⇒ 通道消失
        }
        return 'no-channel'; // mode 'none'
    }
    catch {
        return 'no-channel'; // 验证通道故障 = 无通道（诚实降级，绝不误报失败）
    }
}
// ─── 中断 / TTL 巡检 ───
/** 用户喊停 ⇒ 全部在途预案补偿（直接调用面；生产经 InterruptSignalPort 由 sweep 轮询） */
function interrupt(reason) {
    return track((async () => {
        ensureWalLoaded();
        let compensated = 0;
        for (const plan of [...inFlightPlans.values()]) {
            if (!claimPlan(plan))
                continue; // 并发中断/结算已占位 ⇒ 不补
            await runCompensation(plan, 'interrupt', reason ?? 'user interrupt');
            compensated++;
        }
        return compensated;
    })());
}
/**
 * 巡检（宿主周期调用 / 测试直调）：轮询中断端口（pending ⇒ 在途预案全部补偿）+
 * TTL 到期的未结算预案补偿（settlement 永不到达 = 世界状态未知 —— saga 的
 * in-doubt 事务按已生效处理：补偿一次无害的 Ctrl+Z 好过留下一次真实破坏）。
 * 绝不抛。
 */
function sweep() {
    return track((async () => {
        try {
            ensureWalLoaded();
            if (inFlightPlans.size === 0)
                return 0;
            let interrupted = false;
            try {
                interrupted = interruptPort !== null && interruptPort.pending() === true;
            }
            catch { /* 中断端口故障 = 无中断（旁路义务） */ }
            if (interrupted) {
                let compensated = 0;
                for (const plan of [...inFlightPlans.values()]) {
                    if (!claimPlan(plan))
                        continue;
                    await runCompensation(plan, 'interrupt', 'user interrupt (signal port)');
                    compensated++;
                }
                return compensated;
            }
            const now = eNow();
            let swept = 0;
            for (const plan of [...inFlightPlans.values()]) {
                if (now > plan.expiresAt) {
                    if (!claimPlan(plan))
                        continue;
                    await runCompensation(plan, 'ttl-expired', 'settlement never arrived within TTL — world state unknown, compensating (saga in-doubt)');
                    swept++;
                }
            }
            return swept;
        }
        catch {
            return 0; // 防御式兜底
        }
    })());
}
// ─── 深拷贝 / 报表面 ───
function clonePlan(p) {
    return JSON.parse(JSON.stringify(p));
}
function cloneRecord(r) {
    return JSON.parse(JSON.stringify(r));
}
// ─── 托管单例（模块单例 —— 插件卸载随闭包消亡） ───
export const reversalEscrow = {
    /**
     * 武装（幂等）：注入端口/存储/时钟/TTL/策略扩展，并注册 approval 的托管钩子
     * （beginAttempt 前置闸门 + consume/attemptFailed 结算钩子 —— 组合根单点接线）。
     * 缺省 = 无端口 + 内置表 + 真钟 + 仅内存（一切降级路径的诚实起点）。绝不抛。
     */
    arm(opts = {}) {
        try {
            if ('storage' in opts)
                escrowStorage = opts.storage ?? null;
            if (typeof opts.now === 'function')
                escrowNow = opts.now;
            if (typeof opts.ttlMs === 'number' && Number.isFinite(opts.ttlMs)) {
                escrowTtlMs = Math.max(1_000, opts.ttlMs);
            }
            if ('hashPort' in opts)
                hashPort = opts.hashPort ?? null;
            if ('clipboardPort' in opts)
                clipboardPort = opts.clipboardPort ?? null;
            if ('focusPort' in opts)
                focusPort = opts.focusPort ?? null;
            if ('interruptPort' in opts)
                interruptPort = opts.interruptPort ?? null;
            if ('executorPort' in opts)
                executorPort = opts.executorPort ?? null;
            if (Array.isArray(opts.strategies)) {
                const m = new Map();
                for (const s of opts.strategies) {
                    if (s && typeof s === 'object' && typeof s.semantics === 'string' && s.semantics.trim() !== '') {
                        m.set(s.semantics.slice(0, 64), s);
                    }
                }
                extensionStrategies = m;
            }
            inFlightPlans = new Map();
            tokenPlan = new Map();
            ledger = [];
            walLoaded = false;
            walPersistError = undefined;
            // 单点接线：approval 的托管钩子（缺省武装后即接管 fail-closed 派发闸门）
            setDispatchEscrowHook(dispatchGate);
            setEscrowSettlementHook((token, verdict, reason) => {
                // fire-and-forget 旁路：结算异步面绝不阻塞/炸审批主流程
                void settleByToken(token, verdict === 'verified' ? 'verified' : 'failed', reason);
            });
            hooksRegistered = true;
        }
        catch {
            /* 武装失败 = 保持现状（托管缺席 —— 诚实降级） */
        }
    },
    /** 铸造逆转预案（派发层在 approval.beginAttempt 之前 await；见 mintPlan 全注释） */
    mintPlan(info) {
        return mintPlan(info);
    },
    /** 验收通过结算（consume 钩子的直接面 —— 测试/宿主可显式调用）：预案关闭为 verified */
    settleVerified(approvalToken) {
        return settleByToken(approvalToken, 'verified');
    },
    /** 验收失败结算（attemptFailed 钩子的直接面）⇒ 触发补偿 */
    settleFailed(approvalToken, reason) {
        return settleByToken(approvalToken, 'failed', reason);
    },
    /** 用户喊停：全部在途预案按预案补偿（返回补偿数） */
    interrupt(reason) {
        return interrupt(reason);
    },
    /** 巡检：中断端口轮询 + TTL 到期补偿（返回本轮补偿数） */
    sweep() {
        return sweep();
    },
    /**
     * 崩溃恢复面（宿主重启后显式调用 / 任意触面惰性执行）：读 WAL，在途预案转为
     * recovered-human-attention + 升级报告（不自动补偿 —— 见 ensureWalLoaded 论证）。
     */
    recover() {
        ensureWalLoaded();
        return {
            recovered: ledger.filter(r => r.outcome === 'recovered-human-attention').length,
            pendingHumanAttention: this.pendingHumanAttention().length,
        };
    },
    /** 待人工处置的升级报告（补偿失败/崩溃恢复 —— 未 acknowledge 持续可见，绝不静默） */
    pendingHumanAttention() {
        ensureWalLoaded();
        const out = [];
        for (let i = ledger.length - 1; i >= 0 && out.length < 32; i--) {
            const esc = ledger[i].escalation;
            if (esc && esc.acknowledgedAt === undefined)
                out.push(cloneRecord(ledger[i]).escalation);
        }
        return out;
    },
    /** 人工处置确认（宿主在报告处理后调用 —— 留痕但不删史） */
    acknowledge(planId) {
        ensureWalLoaded();
        const rec = [...ledger].reverse().find(r => r.planId === planId && r.escalation !== undefined);
        if (!rec || rec.escalation === undefined)
            return false;
        if (rec.escalation.acknowledgedAt === undefined) {
            rec.escalation.acknowledgedAt = eNow();
            persistWal();
        }
        return true;
    },
    /** 在途预案快照（深拷贝） */
    dumpInFlight() {
        ensureWalLoaded();
        return [...inFlightPlans.values()].map(clonePlan);
    },
    /** 账册快照（深拷贝 —— 新的在后） */
    dumpLedger() {
        ensureWalLoaded();
        return ledger.map(cloneRecord);
    },
    /** 排空在途异步结算（测试/宿主的确定性同步面） */
    async idle() {
        while (activeWork.size > 0) {
            await Promise.all([...activeWork]).catch(() => { });
        }
    },
    /** 透明化（测试/遥测面） */
    stats() {
        ensureWalLoaded();
        const lastDegraded = ledger.length > 0 && (ledger[ledger.length - 1].degraded?.length ?? 0) > 0;
        return {
            armed: hooksRegistered,
            inFlight: inFlightPlans.size,
            ledgerEntries: ledger.length,
            degraded: lastDegraded || [...inFlightPlans.values()].some(p => (p.degraded?.length ?? 0) > 0),
            storageArmed: escrowStorage !== null,
            ttlMs: escrowTtlMs,
            ...(walPersistError !== undefined ? { persistError: walPersistError } : {}),
            builtinStrategies: BUILTIN_STRATEGIES.size,
            extensionStrategies: extensionStrategies.size,
        };
    },
    /** 隔离缝（测试 beforeEach / 插件卸载）：一切模块态归零回缺省。
     *  approval 侧钩子由 resetApproval 卸载（两侧隔离缝各自负责 —— 不跨界）。 */
    reset() {
        escrowStorage = null;
        escrowNow = Date.now;
        escrowTtlMs = DEFAULT_ESCROW_TTL_MS;
        hashPort = null;
        clipboardPort = null;
        focusPort = null;
        interruptPort = null;
        executorPort = null;
        extensionStrategies = new Map();
        inFlightPlans = new Map();
        tokenPlan = new Map();
        ledger = [];
        walLoaded = false;
        walPersistError = undefined;
        hooksRegistered = false;
        activeWork.clear();
    },
};
/** W3-1：托管武装的独立函数面（组合根挂点 —— 与 armApprovalQueue 同风格） */
export function armReversalEscrow(opts = {}) {
    reversalEscrow.arm(opts);
}
/** 内置策略表视图（透明化 —— 派发层告知模型哪些语义有自动补偿路径） */
export function builtinCompensationSemantics() {
    return [...BUILTIN_STRATEGIES.keys()];
}
/**
 * W4-3（S5）：补偿策略只读查询（内置 + 注入扩展的合并视图）。分级注册表
 * 的「可补偿」级与策略表的对齐锚点：派发层/集成侧判断一个语义是否真有托管
 * 补偿路径（compensate：有；manual-only：不可补偿 —— 人类亲办；none：未分类
 * —— fail-closed）。与 riskGate.reversibilityRegistry 的对齐是纪律不是依赖
 * （riskGate 不得 import 本模块 —— 会与 approval → riskGate 成环），键对齐
 * 靠注释与测试执法。绝不抛。
 */
export function compensationPathOf(semantics) {
    try {
        const key = typeof semantics === 'string' && semantics.trim() !== '' ? semantics.slice(0, 64) : '';
        if (key === '')
            return { kind: 'none', steps: [], reason: 'semantics is required' };
        const strategy = lookupStrategy(key);
        if (strategy === null) {
            return { kind: 'none', steps: [], reason: `no compensation strategy for "${key}" — classify first (fail-closed)` };
        }
        if (strategy.kind === 'manual-only') {
            return { kind: 'manual-only', steps: [], reason: strategy.reason };
        }
        return { kind: 'compensate', steps: strategy.steps.map(s => s.label) };
    }
    catch {
        return { kind: 'none', steps: [], reason: 'internal query failure — treating as unclassified (fail-closed)' };
    }
}
