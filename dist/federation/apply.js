// src/federation/apply.ts
// W9-3（D-F4 拆分·掺入分区）：自 federation/index.ts 低风险提取 —— Μ-d 掺入
// applyFederatedEvidence（三道闸配额决算：本地非空/份额上限/信任折减；绝不写
// kernelRegistry 值）。逐字节搬运（零逻辑变更）；index.ts 原位再导出 —— 导入面
// 不变（消费方零改动）。
import { DIGEST_VERSION, DIGEST_BINS, DEFAULT_MAX_REMOTE_SHARE, numOr, binCenter, cleanCell, } from './digest.js';
import { federationTrustOf, recordFederationTrust } from './trust.js';
/**
 * 整数配额按坨质量成比例分配（最大余数法，纯函数、确定性）：quota 条按 16 格的
 * 质量占比分摊，整数化余数按「小数部分大者优先、平票按格序（坨↑、success 先于
 * fail）」逐格补 1 —— 掺入样本保形于远端分布，不因取整偏聚某坨。
 */
function allocateQuota(quota, cells) {
    const total = cells.reduce((s, c) => s + c, 0);
    if (total <= 0)
        return cells.map(() => 0);
    const exact = cells.map(c => (quota * c) / total);
    const base = exact.map(v => Math.floor(v));
    let left = quota - base.reduce((s, v) => s + v, 0);
    const order = exact
        .map((v, i) => ({ i, frac: v - Math.floor(v) }))
        .sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (const o of order) {
        if (left <= 0)
            break;
        base[o.i] += 1;
        left -= 1;
    }
    return base;
}
/**
 * 掺入合并摘要（绝不抛、绝不写 kernelRegistry 值）：
 *
 *   安全设计（本器官的立法核心）：远端证据只经 ledger.record 喂进证据账本 ——
 *   成败由坨坐标反演（success 列 ⇒ true）、margin 取坨中心；参数**值**的一切
 *   变化仍由本地 KernelCalibrator 的证据门（n ≥ 30）+ 回归守卫 + optimalThreshold
 *   全链执法。联邦没有任何直达 kernelRegistry.set 的写径。
 *
 *   逐 key 配额决算（三道闸，缺一不掺）：
 *   ① 本地零证据的 key 不掺 —— 本地没见过的参数不引入外源漂移（诚实注记）；
 *   ② 份额上限：cap = floor(maxRemoteShare × 本地 n)，防远端洪泛主导本地校准；
 *   ③ 信任折减：quota = floor(cap × trust)，trust ∈ (0,1]（信任账 1/(1+regressed)）。
 *
 *   输入摘要版本不符 / 形状坏 ⇒ { ok:false }（诚实拒绝）；目标账本故障 ⇒ 单 key
 *   隔离跳过；掺入记录共享同一 ts（注入时钟 ⇒ 确定性可测）。滑窗 200 FIFO：掺入
 *   挤占最旧的本地证据（内存有界纪律由账本既有契约执法）。
 */
export function applyFederatedEvidence(target, merged, opts) {
    const reject = (note) => ({
        ok: false,
        applied: 0,
        trust: 1,
        perKey: [],
        notes: [note],
    });
    try {
        if (!target || typeof target.record !== 'function' || typeof target.stats !== 'function') {
            return reject('掺入目标账本非法：诚实跳过（绝不炸宿主）');
        }
        if (!merged || typeof merged !== 'object' || Array.isArray(merged)) {
            return reject('合并摘要形状非法：拒绝掺入');
        }
        const mm = merged;
        if (mm.v !== DIGEST_VERSION) {
            return reject(`摘要版本不符（期望 v=${DIGEST_VERSION}）：拒绝掺入`);
        }
        if (!Array.isArray(mm.keys)) {
            return reject('摘要 keys 非数组：拒绝掺入');
        }
        const share = numOr(opts?.maxRemoteShare, DEFAULT_MAX_REMOTE_SHARE, 0, 1);
        // 信任解析：显式 trust 优先（消毒到 (0,1]）；否则查 sourceId 信任账；再否则 1（初见全信）
        let trust = 1;
        if (typeof opts?.trust === 'number' && Number.isFinite(opts.trust) && opts.trust > 0) {
            trust = Math.min(1, opts.trust);
        }
        else if (typeof opts?.sourceId === 'string' && opts.sourceId !== '') {
            trust = federationTrustOf(opts.sourceId);
        }
        let nowMs = Date.now();
        if (typeof opts?.now === 'function') {
            try {
                const t = opts.now();
                if (Number.isFinite(t))
                    nowMs = t;
            }
            catch {
                /* 时钟故障保持 Date.now */
            }
        }
        const notes = [];
        const perKey = [];
        let applied = 0;
        for (const raw of mm.keys) {
            if (!raw || typeof raw !== 'object' || typeof raw.key !== 'string' ||
                raw.key === '') {
                notes.push('（无名 key 条目）：形状坏，跳过');
                continue;
            }
            const entry = raw;
            const key = entry.key;
            let localN = 0;
            try {
                const s = target.stats(key);
                localN = Number.isFinite(s?.n) ? s.n : 0;
            }
            catch {
                localN = 0; // stats 故障按零证据 ⇒ 走「不掺」臂（安全方向）
            }
            // 闸①：本地零证据不掺（本地没见过的参数不引入外源漂移）
            if (localN <= 0) {
                notes.push(`${key}: 本地零证据不掺入（防外源漂移）`);
                perKey.push({ key, localN: 0, cap: 0, quota: 0, injected: 0, reason: 'local-empty' });
                continue;
            }
            const cap = Math.floor(share * localN);
            // 闸②：份额上限（share 折没 / 本地 n 太小 ⇒ 零配额）
            if (cap <= 0) {
                notes.push(`${key}: 份额上限折没（share=${share} × n=${localN} ⇒ cap=0）`);
                perKey.push({ key, localN, cap: 0, quota: 0, injected: 0, reason: 'cap-zero' });
                continue;
            }
            const bins = Array.isArray(entry.bins) ? entry.bins : [];
            const cells = [];
            for (let b = 0; b < DIGEST_BINS; b++) {
                const cell = bins[b];
                for (let col = 0; col < 2; col++) {
                    const v = cleanCell(Array.isArray(cell) ? cell[col] : undefined);
                    cells.push(v ?? 0); // 坏格按 0（与 mergeDigests 同律 —— 掺入面不吃脏数据）
                }
            }
            const total = cells.reduce((s, c) => s + c, 0);
            if (total <= 0) {
                notes.push(`${key}: 远端摘要零质量（全格 0），无从掺入`);
                perKey.push({ key, localN, cap, quota: 0, injected: 0, reason: 'remote-empty-mass' });
                continue;
            }
            const quota = Math.floor(cap * trust);
            // 闸③：信任折减（trust × cap < 1 ⇒ 零配额 —— 回归源的诚实出局）
            if (quota <= 0) {
                notes.push(`${key}: 信任折没（trust=${trust} × cap=${cap} ⇒ quota=0）`);
                perKey.push({ key, localN, cap, quota: 0, injected: 0, reason: 'trust-zero' });
                continue;
            }
            const take = allocateQuota(quota, cells);
            let injected = 0;
            for (let b = 0; b < DIGEST_BINS; b++) {
                for (let col = 0; col < 2; col++) {
                    const count = take[b * 2 + col];
                    for (let i = 0; i < count; i++) {
                        try {
                            // 掺入记录：成败由坨坐标反演（col 0 = success 列）、margin 取坨中心；
                            // 只喂账本 —— 值变化仍由本地 calibrator 全链执法（见 JSDoc 安全设计）
                            target.record({ key, success: col === 0, margin: binCenter(b), ts: nowMs });
                            injected += 1;
                        }
                        catch {
                            /* 单条入账故障：跳过该条，其余照掺 */
                        }
                    }
                }
            }
            applied += injected;
            perKey.push({ key, localN, cap, quota, injected, reason: 'blended' });
        }
        if (applied === 0 && notes.length === 0)
            notes.push('摘要 keys 为空：无 key 完成掺入');
        // 信任账：真实掺入量入账（sourceId 在场才记 —— 匿名摘要无源不立账）
        if (typeof opts?.sourceId === 'string' && opts.sourceId !== '' && applied > 0) {
            recordFederationTrust(opts.sourceId, { applied });
        }
        return { ok: true, applied, trust, perKey, notes };
    }
    catch {
        return reject('掺入过程异常：诚实全跳（绝不炸宿主）');
    }
}
