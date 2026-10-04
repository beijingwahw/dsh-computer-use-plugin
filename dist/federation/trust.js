// src/federation/trust.ts
// W9-3（D-F4 拆分·信任分区）：自 federation/index.ts 低风险提取 —— Μ-c 信任账
//（内存 Map 真值源）+ W6-4 持久化缝包（原子写文件存储/防御恢复/突变计数节流）。
// 逐字节搬运（零逻辑变更）；index.ts 原位再导出 —— 导入面不变（消费方零改动）。
import { existsSync, readFileSync, renameSync, mkdirSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
/** 信任账本体（模块级内存 Map —— 进程生命周期；dump 面 = federationTrustReport） */
const trustAccounts = new Map();
// ── W6-4（持久化缝包）：信任账落盘簿记（缺省未武装 = 纯内存，行为与旧逐字节一致）──
/** 信任账档 schema 版本（版本错配 ⇒ 整档拒绝恢复；形态见 FederationTrustStoreDoc） */
export const TRUST_STORE_VERSION = 1;
/** 突变计数节流缺省：每 8 次信任突变落盘一次（armFederationTrustPersistence 可覆盖） */
export const DEFAULT_TRUST_FLUSH_EVERY = 8;
/** 已武装的存储端口（armFederationTrustPersistence 注入；null = 纯内存） */
let trustStore = null;
/** 节流阈值：每 N 次信任突变触发一次落盘（突变计数制 —— 无时钟依赖，离线可测） */
let trustFlushEvery = DEFAULT_TRUST_FLUSH_EVERY;
/** 自上次成功落盘以来的突变计数（节流钟） */
let trustMutations = 0;
/** W6-4：突变计数推进 + 节流落盘（recordFederationTrust 的旁路尾钩，绝不抛） */
function noteTrustMutation() {
    try {
        trustMutations++;
        if (trustStore && trustMutations >= trustFlushEvery)
            flushFederationTrust();
    }
    catch {
        /* 绝不抛 */
    }
}
/**
 * 记信任账（绝不抛）：sourceId 非空字符串才立账；applied / regressed 非有限按 0、
 * 负数按 0、取整（计数语义）。消费语义：applyFederatedEvidence 成功掺入时自动记
 * applied；远端证据引发本地校准回归时由守卫方记 regressed（本模块不判回归 ——
 * 回归是本地 calibrator/lineage 的执法事实，信任账只记账不执法）。
 * W6-4：记账后走 noteTrustMutation —— 武装了持久化时按突变计数节流落盘
 * （缺省未武装 ⇒ 零磁盘行为，掺入闸语义零变化）。
 */
export function recordFederationTrust(sourceId, delta = {}) {
    try {
        if (typeof sourceId !== 'string' || sourceId === '')
            return; // 匿名摘要无源不立账
        const cur = trustAccounts.get(sourceId) ?? { applied: 0, regressed: 0 };
        const a = typeof delta.applied === 'number' && Number.isFinite(delta.applied) ? Math.max(0, Math.floor(delta.applied)) : 0;
        const r = typeof delta.regressed === 'number' && Number.isFinite(delta.regressed) ? Math.max(0, Math.floor(delta.regressed)) : 0;
        trustAccounts.set(sourceId, { applied: cur.applied + a, regressed: cur.regressed + r });
        noteTrustMutation();
    }
    catch {
        /* 绝不抛 */
    }
}
/** 现行信任度：1/(1+regressed)；未立账（初见）或垃圾 id ⇒ 1（初见全信，回归才折减） */
export function federationTrustOf(sourceId) {
    if (typeof sourceId !== 'string' || sourceId === '')
        return 1;
    const cur = trustAccounts.get(sourceId);
    if (!cur || cur.regressed <= 0)
        return 1;
    return 1 / (1 + cur.regressed);
}
/** 信任账全表（dump 面，防御副本，sourceId 字典序） */
export function federationTrustReport() {
    return [...trustAccounts.entries()]
        .map(([sourceId, t]) => ({ sourceId, applied: t.applied, regressed: t.regressed, trust: federationTrustOf(sourceId) }))
        .sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1));
}
/** W6-4：文件存储实现（原子写：tmp + fsync + rename —— checkpoint.ts 同律，绝不抛） */
export function createFederationTrustFileStore(filePath) {
    return {
        load() {
            try {
                if (!filePath || !existsSync(filePath))
                    return null;
                const text = readFileSync(filePath, 'utf8');
                return typeof text === 'string' && text.trim() !== '' ? text : null;
            }
            catch {
                return null; // 读故障（含 ENOENT 竞态）= 无持久化账（诚实方向）
            }
        },
        save(text) {
            if (!filePath)
                return { ok: false, error: 'trust-store path is empty' };
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
                renameSync(tmp, filePath); // 原子换名：要么完整旧档要么完整新档，绝无半档
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
/** W6-4：信任账序列化（dump 面的落盘形态；sourceId 字典序 ⇒ 同账本态同字节） */
export function serializeFederationTrust(now) {
    let savedAt = Date.now();
    if (typeof now === 'function') {
        try {
            const t = now();
            if (Number.isFinite(t))
                savedAt = t;
        }
        catch {
            /* 时钟故障保持 Date.now —— 绝不抛 */
        }
    }
    const doc = {
        v: TRUST_STORE_VERSION,
        savedAt,
        accounts: [...trustAccounts.entries()]
            .map(([sourceId, t]) => ({ sourceId, applied: t.applied, regressed: t.regressed }))
            .sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1)),
    };
    return JSON.stringify(doc);
}
/** W6-4：单计数字段消毒（垃圾归先验臂）：有限非负 ⇒ 取整封顶；其余 ⇒ 0 */
function sanitizeTrustCount(v) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
        return 0;
    return Math.min(Math.floor(v), Number.MAX_SAFE_INTEGER);
}
/**
 * W6-4：防御恢复（垃圾归先验、绝不抛）—— 档**整体替换**内存账（restore 是权威
 * 语义：恢复后的账 = 档上的账，不与内存残账合并）。档级垃圾（非对象/版本错配/
 * accounts 非数组）⇒ 整档拒绝（restored:0 + note，内存账不动）；条目级垃圾
 * （sourceId 非非空字符串）⇒ skipped++；字段级垃圾 ⇒ 该字段归 0（regressed 垃圾
 * ⇒ trust 回先验 1）。恢复幂等：同档恢复两次结果一致；恢复后突变计数归零。
 */
export function restoreFederationTrust(payload) {
    try {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return { restored: 0, skipped: 0, note: '信任档非对象：整档拒绝（内存账不动）' };
        }
        const doc = payload;
        if (doc.v !== TRUST_STORE_VERSION) {
            return { restored: 0, skipped: 0, note: `信任档版本不符（期望 v=${TRUST_STORE_VERSION}）：整档拒绝` };
        }
        if (!Array.isArray(doc.accounts)) {
            return { restored: 0, skipped: 0, note: '信任档 accounts 非数组：整档拒绝' };
        }
        const next = new Map();
        let skipped = 0;
        for (const raw of doc.accounts) {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                skipped++;
                continue;
            }
            const e = raw;
            if (typeof e.sourceId !== 'string' || e.sourceId === '') {
                skipped++;
                continue;
            } // 无主条目不立账
            next.set(e.sourceId, {
                applied: sanitizeTrustCount(e.applied),
                regressed: sanitizeTrustCount(e.regressed), // 垃圾 ⇒ 0 ⇒ trust 回先验 1
            });
        }
        trustAccounts.clear();
        for (const [k, v] of next)
            trustAccounts.set(k, v);
        trustMutations = 0; // 恢复即权威：突变计数与节流钟一并归零
        return { restored: next.size, skipped };
    }
    catch {
        return { restored: 0, skipped: 0, note: '恢复过程异常：整档拒绝（防御式兜底）' };
    }
}
/**
 * W6-4：从存储端口读档并恢复（生产接线的一步调用：启动时 arm 前先 load）。
 * 档缺席/不可读/坏 JSON ⇒ restored:0 + note（冷启动空账 —— 诚实方向，绝不抛）。
 */
export function loadFederationTrust(store) {
    try {
        if (!store || typeof store.load !== 'function') {
            return { restored: 0, skipped: 0, note: '存储端口缺席：无持久化账可恢复' };
        }
        const text = store.load();
        if (text === null || text === '') {
            return { restored: 0, skipped: 0, note: '无持久化档：冷启动空账' };
        }
        try {
            return restoreFederationTrust(JSON.parse(text));
        }
        catch {
            return { restored: 0, skipped: 0, note: '信任档坏 JSON：整档拒绝（冷启动空账）' };
        }
    }
    catch {
        return { restored: 0, skipped: 0, note: '读档异常：整档拒绝（防御式兜底）' };
    }
}
/**
 * W6-4：武装信任账持久化（幂等：重复武装以后一次为准）。store 结构非法 ⇒ false
 * （诚实拒绝，保持纯内存）。武装后 recordFederationTrust 每 flushEvery 次突变
 * 触发一次原子落盘；flushFederationTrust 随时可强制冲刷。绝不抛。
 */
export function armFederationTrustPersistence(store, opts) {
    try {
        if (!store || typeof store.load !== 'function' || typeof store.save !== 'function')
            return false;
        trustStore = store;
        const raw = opts?.flushEvery;
        trustFlushEvery = typeof raw === 'number' && Number.isFinite(raw) && raw >= 1
            ? Math.floor(raw)
            : DEFAULT_TRUST_FLUSH_EVERY;
        trustMutations = 0;
        return true;
    }
    catch {
        return false; // 防御式兜底：武装失败保持纯内存
    }
}
/**
 * W6-4：立即落盘（强制冲刷，绝不抛、幂等）。未武装 ⇒ ok:true + written:0
 * （纯内存是合法配置态，不是故障）。写失败 ⇒ ok:false + error（突变计数保留
 * ⇒ 下次突变即重试；内存账不受影响 —— 持久化失败绝不反噬信任执法）。
 */
export function flushFederationTrust() {
    try {
        if (!trustStore)
            return { ok: true, written: 0 };
        const text = serializeFederationTrust();
        const res = trustStore.save(text);
        if (res.ok) {
            trustMutations = 0;
            let written = 0;
            try {
                written = JSON.parse(text).accounts.length;
            }
            catch {
                written = 0;
            }
            return { ok: true, written };
        }
        return { ok: false, written: 0, error: res.error ?? 'save failed' };
    }
    catch (e) {
        return { ok: false, written: 0, error: e instanceof Error ? e.message : String(e) };
    }
}
/** W6-4：持久化簿记状态（审计面：armed/阈值/未冲刷突变/上次错误，防御副本） */
export function federationTrustPersistenceStatus() {
    return {
        armed: trustStore !== null,
        flushEvery: trustFlushEvery,
        pendingMutations: trustMutations,
        accounts: trustAccounts.size,
    };
}
// W9-3：联邦运行时复位的信任侧（index.resetFederationRuntime 调用；模块内账本私有，
// 复位须经此门 —— 与原文件内联语义逐字节一致）。
export function resetTrustRuntime() {
    trustAccounts.clear();
    trustStore = null;
    trustFlushEvery = DEFAULT_TRUST_FLUSH_EVERY;
    trustMutations = 0;
}
