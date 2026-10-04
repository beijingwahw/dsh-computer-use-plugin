// src/approval.queueState.ts
// approval 队列状态核（W8-B3 自 approval.ts 拆出 —— 代码逐字保持，零漂移）。
// 离线待批队列的全部可变簿记（存储/时钟/超时/条目/审计计数）与状态机内脏：
// 惰性装载、恢复面净化、W6-3 已拒保留期清理、落盘、裁决传播、续跑铸造。
// 状态变量的**重赋值只发生在本文件**（arm/ensureQueueLoaded/restore/reset 四点）
// —— API 面（approval.queue.ts）经只读活绑定消费，防御式单写点。
// 公开面绝不抛：存储/时钟/输入垃圾一律收敛为诚实返回值（防御式律）。
import { randomBytes } from 'node:crypto';
import { TTL_MS, MAX_ATTEMPTS, LIFETIME_MULTIPLIER, AMENDMENT_NOTE_MAX, DEFAULT_STAGING_TIMEOUT_MS, DEFAULT_QUEUE_TTL_MS, DEFAULT_DENIED_RETENTION_MS, APPROVAL_QUEUE_VERSION } from './approval.constants.js';
import { strOrUndef, sanitizeActionShape } from './approval.shapes.js';
import { newToken, castAmendmentFor } from './approval.security.js';
import { pending } from './approval.registry.js';
// ── 队列模块态（全部经 armQueueState 注入；缺省 = 内存队列 + 真钟） ──
/** 存储端口（null = 仅内存 —— 跨进程不保，诚实降级）；只读本绑定的面：
 *  stagingAvailability/queueStats 的 persistent/storageArmed。 */
export let queueStorage = null;
/** 注入时钟（真钟缺省；qNow 安全包裹） */
let queueNow = Date.now;
export let queueStagingTimeoutMs = DEFAULT_STAGING_TIMEOUT_MS;
export let queueTtlMs = DEFAULT_QUEUE_TTL_MS;
/** W6-3：已拒条目保留期（deny 后审计窗口宽度；arm 可注入，负值 = 关闭清理） */
export let queueDeniedRetentionMs = DEFAULT_DENIED_RETENTION_MS;
/** W6-3：本模块生命周期内已清理的 denied 条目累计（审计留痕 —— 条目消失，
 *  「曾拒绝过多少」的账面长存；随档落盘为 prunedDeniedTotal，跨进程恢复取
 *  max(内存, 档) 不回退）。 */
export let prunedDeniedTotal = 0;
/** 队列条目（唯一事实源；数组内容的增删由 API 面经此绑定操作 —— 重赋值仅
 *  在本文件的装载/恢复/武装/归零四点）。 */
export let queueEntries = [];
/** 惰性装载标志（首次触及队列面前从存储读档） */
let queueLoaded = false;
/** 最近一次持久化错误（queueStats 透明化面） */
export let queuePersistError;
export function newQueueId() {
    return 'QA-' + randomBytes(8).toString('hex').toUpperCase();
}
/** 安全时钟读数（注入时钟抛错/回垃圾 ⇒ 0 —— 绝不因计时面炸队列） */
export function qNow() {
    try {
        const t = queueNow();
        return typeof t === 'number' && Number.isFinite(t) ? t : 0;
    }
    catch {
        return 0;
    }
}
/** 证据链净化：入队面（RawActionShape 即刻脱敏）与恢复面（已脱敏形状直通）共用 */
export function sanitizeEvidence(raw) {
    const ev = {};
    if (!raw || typeof raw !== 'object')
        return ev;
    const r = raw;
    const shot = strOrUndef(r.screenshotRef, 200);
    if (shot !== undefined)
        ev.screenshotRef = shot;
    const fp = strOrUndef(r.sceneFingerprint, 100);
    if (fp !== undefined)
        ev.sceneFingerprint = fp;
    const tier = strOrUndef(r.riskTier, 32);
    if (tier !== undefined)
        ev.riskTier = tier;
    const shape = r.actionShape;
    if (shape && typeof shape === 'object') {
        // 输入面：RawActionShape（含可能的原文 text）⇒ sanitizeActionShape 脱敏；
        // 已脱敏形状（tool + 可选 x/y/target_description/长度桶）再过一次幂等不变。
        const s = shape;
        if (typeof s.tool === 'string' && s.tool)
            ev.actionShape = sanitizeActionShape(s);
    }
    return ev;
}
/** 条目深拷贝（JSON 安全面 —— 队列条目全部为可序列化原语） */
export function cloneEntry(e) {
    return JSON.parse(JSON.stringify(e));
}
/** 恢复面净化：单条目结构校验（垃圾 ⇒ null 弃置 —— 好条目不连坐） */
export function sanitizeQueueEntry(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw;
    const id = strOrUndef(r.id, 64);
    const token = strOrUndef(r.token, 64);
    const description = strOrUndef(r.description, 200);
    if (id === undefined || token === undefined || description === undefined)
        return null;
    const enqueuedAt = r.enqueuedAt;
    const ttlMs = r.ttlMs;
    const expiresAt = r.expiresAt;
    if (typeof enqueuedAt !== 'number' || !Number.isFinite(enqueuedAt) || enqueuedAt < 0)
        return null;
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0)
        return null;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt < 0)
        return null;
    const entry = {
        id, token, description,
        evidence: sanitizeEvidence(r.evidence),
        enqueuedAt, ttlMs, expiresAt,
    };
    const cursor = r.stepCursor;
    if (typeof cursor === 'number' && Number.isFinite(cursor) && cursor >= 0) {
        entry.stepCursor = Math.floor(cursor);
    }
    const d = r.decision;
    if (d && typeof d === 'object') {
        const dd = d;
        if (dd.verdict === 'granted' || dd.verdict === 'denied') {
            const at = dd.at;
            const decision = {
                verdict: dd.verdict,
                at: typeof at === 'number' && Number.isFinite(at) && at >= 0 ? at : qNow(),
            };
            const note = strOrUndef(dd.amendment?.note, AMENDMENT_NOTE_MAX);
            if (note !== undefined) {
                // amendment 结构面净化：note 在场即按 W1-2 协议重铸（original 取条目描述
                // —— 恢复面没有铸造时自述的旁证，重铸保守可复现）
                decision.amendment = castAmendmentFor(description, note, decision.at);
            }
            entry.decision = decision;
        }
        // verdict 垃圾 ⇒ decision 整体弃置（回到待批 —— 保守方向：绝不凭恢复面伪造 grant）
    }
    return entry;
}
/** 惰性装载：首次触queue面前从存储读档（垃圾档 ⇒ 空队列归零 —— 绝不抛） */
export function ensureQueueLoaded() {
    if (queueLoaded)
        return;
    queueLoaded = true;
    queueEntries = [];
    if (queueStorage === null)
        return; // 仅内存（跨进程不保 —— 诚实降级）
    try {
        const text = queueStorage.load();
        if (text === null)
            return;
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object')
            return; // 垃圾档 ⇒ 归零
        const root = parsed;
        // W6-3：审计留痕恢复 —— 档中的累计清理数读回（取 max 不回退；垃圾值 ⇒ 忽略）
        const pr = root.prunedDeniedTotal;
        if (typeof pr === 'number' && Number.isFinite(pr) && pr >= 0) {
            prunedDeniedTotal = Math.max(prunedDeniedTotal, Math.floor(pr));
        }
        const entries = root.entries;
        if (!Array.isArray(entries))
            return; // 垃圾段 ⇒ 归零
        const seen = new Set();
        for (const raw of entries) {
            const e = sanitizeQueueEntry(raw);
            if (e === null || seen.has(e.id))
                continue; // 垃圾条目/重复 id 弃置
            seen.add(e.id);
            queueEntries.push(e);
        }
    }
    catch {
        queueEntries = []; // 解析故障 ⇒ 归零（防御式：坏档不炸队列，也不冒充恢复）
    }
}
/** W6-3（W2-1 遗留清偿）：已拒条目保留期清理 —— deny 后条目进入保留期
 *  （缺省 7 天），到期在下次队列落盘时清除。执法点置于 persistQueue 开头：
 *  一切落盘路径（stageAction/adjudicate/recordTokenDecision/takeGranted）统一
 *  经过，无需调用方各自记得清理；仅内存队列（存储缺席）也在落盘尝试时清理
 *  ——语义统一，队列缓慢增长在两面同律闭合。
 *  审计留痕（不静默消失）：每清一条 prunedDeniedTotal 累计 +1，随档落盘为
 *  prunedDeniedTotal 字段、经 queueStats().prunedDenied 暴露 —— 条目从晨报
 *  消失，但「曾拒绝过多少」的账面长存（跨进程恢复取 max 不回退）。
 *  防御式绝不抛：时钟垃圾（qNow=0）⇒ now−at ≤ 0 < 保留期 ⇒ 一条不清
 *  （保守方向：宁可留着挡晨报，不可误删审计面）；负保留期 = 部署显式关闭。 */
function pruneDeniedEntries() {
    try {
        if (queueDeniedRetentionMs < 0)
            return; // 部署显式关闭清理（保留期 = ∞）
        const now = qNow();
        if (now <= 0)
            return; // 时钟面垃圾 ⇒ 不清（保守）
        let pruned = 0;
        for (let i = queueEntries.length - 1; i >= 0; i--) {
            const d = queueEntries[i].decision;
            if (d?.verdict === 'denied' && (now - d.at) >= queueDeniedRetentionMs) {
                queueEntries.splice(i, 1);
                pruned++;
            }
        }
        if (pruned > 0)
            prunedDeniedTotal += pruned; // 审计计数（save 失败 ⇒ 内存面已一致，下次落盘补写）
    }
    catch {
        /* 防御式兜底：清理故障绝不炸落盘主流程（条目多留一轮 = 保守方向） */
    }
}
/** 队列落盘（存储缺席 = 仅内存恒 ok；失败记 queuePersistError —— 绝不抛）。
 *  W6-3：落盘前先执法 denied 保留期清理（见 pruneDeniedEntries）。 */
export function persistQueue() {
    pruneDeniedEntries(); // W6-3：到期清理的统一执法点（一切落盘路径必经）
    if (queueStorage === null)
        return { ok: true };
    try {
        const r = queueStorage.save(JSON.stringify({
            version: APPROVAL_QUEUE_VERSION,
            savedAt: qNow(),
            // W6-3 审计留痕：累计清理数随档长存（恢复面读回取 max —— 绝不回退）
            prunedDeniedTotal,
            entries: queueEntries,
        }));
        if (!r.ok)
            queuePersistError = r.error ?? 'unknown storage error';
        else
            queuePersistError = undefined;
        return r;
    }
    catch (e) {
        queuePersistError = e instanceof Error ? e.message : String(e);
        return { ok: false, error: queuePersistError };
    }
}
/** W2-1（H4）：grantDetailed 的裁决传播（旁路义务 —— 队列故障绝不炸审批主流程）。
 *  令牌在暂存后又被交互式 grant/deny ⇒ 在途条目同步裁决（amendment 同律铸入；
 *  Y-10 预算已在 grantDetailed 计费，此处不重复扣）。 */
export function recordTokenDecision(token, granted, note) {
    try {
        ensureQueueLoaded();
        const entry = queueEntries.find(e => e.token === token && e.decision === undefined);
        if (!entry)
            return;
        const now = qNow();
        entry.decision = {
            verdict: granted ? 'granted' : 'denied',
            at: now,
            ...(note ? { amendment: castAmendmentFor(entry.description, note, now) } : {}),
        };
        persistQueue();
    }
    catch {
        /* 队列是审批的旁路：传播失败 = 条目留待批量裁决（保守方向） */
    }
}
/** 续跑执行令牌铸造：已授予（不扣 Y-10 —— 批量裁决时已扣）、amendment 随行、
 *  生命周期同常规铸造（V 纪元验收式消费照常执法）。 */
export function mintResumedToken(entry) {
    const now = qNow();
    const pa = {
        token: newToken(),
        description: entry.description,
        expiresAt: now + TTL_MS,
        granted: true,
        attempts: 0,
        maxAttempts: MAX_ATTEMPTS,
        ttlMs: TTL_MS,
        lifetimeCapAt: now + TTL_MS * LIFETIME_MULTIPLIER,
        ...(entry.evidence.actionShape !== undefined ? { actionShape: entry.evidence.actionShape } : {}),
        ...(entry.evidence.sceneFingerprint !== undefined ? { sceneFingerprint: entry.evidence.sceneFingerprint } : {}),
        ...(entry.decision?.amendment !== undefined ? { amendment: entry.decision.amendment } : {}),
        resumedFromQueue: entry.id,
    };
    pending.set(pa.token, pa);
    return pa.token;
}
/** 武装（幂等）：注入存储/时钟/超时（W8-B3 拆分缝 —— 原为 approvalQueue.arm
 *  体内实现，逐字提取；缺省 = 内存队列 + 真钟 + 5min/24h。
 *  W6-3：deniedRetentionMs 注入已拒条目保留期（缺省 7 天；负值 = 关闭清理）。
 *  组合根挂点见 doctorChannel.wireDoctorVerdictChannel（W2-1 段）。绝不抛。） */
export function armQueueState(opts = {}) {
    try {
        if ('storage' in opts)
            queueStorage = opts.storage ?? null;
        if (typeof opts.now === 'function')
            queueNow = opts.now;
        if (typeof opts.stagingTimeoutMs === 'number' && Number.isFinite(opts.stagingTimeoutMs)) {
            queueStagingTimeoutMs = Math.max(0, opts.stagingTimeoutMs);
        }
        if (typeof opts.ttlMs === 'number' && Number.isFinite(opts.ttlMs)) {
            queueTtlMs = Math.max(1_000, opts.ttlMs);
        }
        // W6-3：负值原样保留（= 关闭清理的部署语义）；NaN/Infinity 已被 isFinite 拒
        if (typeof opts.deniedRetentionMs === 'number' && Number.isFinite(opts.deniedRetentionMs)) {
            queueDeniedRetentionMs = opts.deniedRetentionMs;
        }
        queueEntries = [];
        queueLoaded = false;
        queuePersistError = undefined;
        // W6-3：重新武装 = 新队列生命周期，累计清理数归零（跨进程续账由读档恢复）
        prunedDeniedTotal = 0;
    }
    catch {
        /* 武装失败 = 保持现状（阻塞审批原样 —— 诚实降级） */
    }
}
/** checkpoint 恢复面（防御性恢复 —— 垃圾值归零；W8-B3 拆分缝 —— 原为
 *  approvalQueue.restoreQueue 体内实现，逐字提取）：整段垃圾 ⇒ 空队列；
 *  条目级垃圾 ⇒ 弃置坏条目保住好条目（不连坐）。绝不抛。 */
export function restoreQueueEntries(rawEntries) {
    queueEntries = [];
    queueLoaded = true;
    if (!Array.isArray(rawEntries))
        return { kept: 0, dropped: 0 }; // 整段垃圾 ⇒ 归零
    const seen = new Set();
    let dropped = 0;
    for (const raw of rawEntries) {
        const e = sanitizeQueueEntry(raw);
        if (e === null || seen.has(e.id)) {
            dropped++;
            continue;
        }
        seen.add(e.id);
        queueEntries.push(e);
    }
    return { kept: queueEntries.length, dropped };
}
/** W-1 隔离缝的队列面归零（resetApproval 组合面调用 —— 内存条目清空、存储/
 *  时钟注入卸载回缺省；测试不得读到上一用例的持久化队列，生产由下一次组合根
 *  武装重接）。 */
export function resetQueueState() {
    queueStorage = null;
    queueNow = Date.now;
    queueStagingTimeoutMs = DEFAULT_STAGING_TIMEOUT_MS;
    queueTtlMs = DEFAULT_QUEUE_TTL_MS;
    queueDeniedRetentionMs = DEFAULT_DENIED_RETENTION_MS; // W6-3：保留期回缺省 7 天
    prunedDeniedTotal = 0; // W6-3：审计计数归零
    queueEntries = [];
    queueLoaded = false;
    queuePersistError = undefined;
}
