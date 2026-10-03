// src/crossMachine.ts
// W5-3（L3 跨机编排）：一任务 N 手 —— 「A 拨号、B 接听」式多机协同的分布式
// barrier + 跨机方言。ioMutex 是单躯体内的串行化（本地互斥），本模块是其
// **分布式类比**：N 台机器各自跑到 rendezvous 点，全到达才放行 —— 但绝不改
// ioMutex 一行（只读借用其「诚实失败不毒化队列」的纪律）。
//
// ── barrier 一致性论证（四支柱，测试逐一锁定）──
//   ① 全到达才放行：phase 从 'collecting' → 'committed' 的迁移只发生在**使
//      arrived.size === expected 的那一次 allocate 上**，且只迁移一次（此后
//      arrived 集合封顶 —— 迟到者按 missed-release 诚实拒绝，绝不二次计数）。
//      放行是中继端的**单一事实**（一份 server 侧状态迁移），不是各客户端
//      自行推导的多数派 —— 不存在「一半机器放行、一半继续等」的脑裂视图。
//   ② 序号防重放：每 name 的 generation seq 严格单调（1,2,3…）。一切**变更类**
//      请求（commit）必须携带 seq 且与现行 generation 相符；旧 generation 的
//      重放包 ⇒ stale-seq，超前序号 ⇒ unknown-seq。重放的 allocate 对同一
//      在役 generation 幂等（Set 语义，不重复计数）—— 同一包重放一万次，
//      arrived 仍是 1 票。
//   ③ 两阶段（allocate/commit）防脑裂：
//      阶段一 allocate = 加入 + 抵达（幂等，响应携带现行 phase）；
//      阶段二 commit = 放行后的确认（「我已通过」）。generation 在放行后
//      **驻留**到全部 N 方 commit 为止 —— 任何参与者都不会「错过放行而不自知」
//      （迟到加入者拿到 missed-release 的诚实拒绝，而不是被悄悄放进一个
//      已经放行过的 barrier）；全部确认后 generation 退休（retired），name 的
//      下一 generation seq 前进 —— 第 k 轮的迟到大礼包（旧 seq 包）永远无法
//      触碰第 k+1 轮（tombstone 序号账把守，见 ④）。
//   ④ 有界状态：在役 generation ≤ maxLive（FIFO 驱逐）、每 generation 名册
//      ≤ maxParticipants、退休序号账 ≤ maxTombstones（FIFO）、TTL 驻留清扫。
//      驱逐/清扫的 generation 先记 tombstone（name → 退休 seq）再删 ——
//      被驱逐轮次的迟到 commit 仍吃 stale-seq（重放视野 = tombstone 窗口，
//      有界内存 ⇒ 有界重放视野，这是诚实的工程折衷，非缺陷）。等待中的
//      参与者按 pollMs 轮询幂等 allocate ⇒ TTL 驱逐后自愈重建（seq 前进，
//      众人重新抵达），不卡死。
//   超时诚实失败：客户端等待超时 ⇒ { ok:false, reason:'timeout' }，绝不臆造
//   放行；transport 故障 ⇒ 'transport'（poll 即重试，deadline 内不放弃）。
//   运行层永不抛异常（federation 同律：跨机是旁路协同，不是主路债主）。
//
// 分层：纯逻辑核心（createBarrierCore，可注入时钟/容量/TTL，双实现口径的
// TS 权威源）+ 传输方言（BarrierTransport）+ 客户端等待循环
// （arriveAndWaitBarrier）+ HTTP 客户端壳（makeHttpBarrierTransport /
// createBarrierClient）。scripts/federation-server.mjs 是核心的等价 JS 移植
// （.mjs 不能 import TS），漂移由 test/w5cross.test.ts 的端到端等价断言把守。
// ─── 立法常量（算法形状字面量 —— 非旋钮）───
/** W5-3：单 barrier 最大参与方数（名册上界 —— 有界状态的每 generation 维度） */
export const BARRIER_MAX_PARTICIPANTS = 64;
/** W5-3：在役 barrier 数上界（FIFO 驱逐 —— 服务端有界状态的主维度） */
export const BARRIER_MAX_LIVE = 64;
/** W5-3：退休序号账上界（name → 最后退休 seq；重放视野的内存代价上界） */
export const BARRIER_MAX_TOMBSTONES = 256;
/** W5-3：generation 驻留 TTL（创建起算；驱逐前先记 tombstone —— 防重放不失效） */
export const BARRIER_TTL_MS = 120_000;
/** W5-3：barrier 名长度上界（含） */
export const BARRIER_NAME_MAX = 128;
/** W5-3：参与方 id 长度上界（含） */
export const BARRIER_PEER_MAX = 128;
/** W5-3：客户端等待超时缺省（诚实失败上界 —— 超时即报 timeout，不无限等） */
export const BARRIER_DEFAULT_TIMEOUT_MS = 30_000;
/** W5-3：轮询节奏缺省（幂等 allocate 即心跳：TTL 驱逐后自愈重建的载体） */
export const BARRIER_DEFAULT_POLL_MS = 200;
/** W5-3：单次 HTTP 往返超时（federation FEDERATION_TIMEOUT_MS 同律 5s） */
export const BARRIER_FETCH_TIMEOUT_MS = 5_000;
/** W5-3：barrier 步声明方言 —— action 文本内嵌 `barrier:<name>#<n>`（planner 冻结，
 *  声明走文本约定 + 注入覆写双通道；n 钳 [1, BARRIER_MAX_PARTICIPANTS]） */
export const BARRIER_STEP_RE = /barrier:([A-Za-z0-9._-]{1,64})#(\d{1,3})/;
/** 数值护栏：整数 ∈ [min, max]，非法 ⇒ 缺省（federation numOr 同律） */
function intOr(x, dflt, min, max) {
    return typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max ? Math.floor(x) : dflt;
}
/**
 * W5-3：创建 barrier 纯核心（状态机、同步、绝不抛）。双实现口径的 TS 权威源
 * —— scripts/federation-server.mjs 的 barrierApplyJS 是本函数语义的逐分支
 * JS 移植（等价性由 test/w5cross.test.ts 的脚本序列逐字段断言把守）。
 */
export function createBarrierCore(opts) {
    const now = typeof opts?.now === 'function' ? opts.now : Date.now;
    const maxLive = intOr(opts?.maxLive, BARRIER_MAX_LIVE, 1, 1_000_000);
    const maxTombstones = intOr(opts?.maxTombstones, BARRIER_MAX_TOMBSTONES, 1, 1_000_000);
    const ttlMs = intOr(opts?.ttlMs, BARRIER_TTL_MS, 1, Number.MAX_SAFE_INTEGER);
    const maxParticipants = intOr(opts?.maxParticipants, BARRIER_MAX_PARTICIPANTS, 1, 10_000);
    const live = new Map(); // 插入序 = 创建序（FIFO 驱逐依据）
    const tomb = new Map(); // name → 最后退休 seq（重放视野）
    const bad = (reason, extra) => ({ ok: false, reason, ...(extra ?? {}) });
    const view = (g, extra) => ({
        ok: true, name: g.name, seq: g.seq, phase: g.phase, expected: g.expected,
        arrived: [...g.arrived].sort(), acked: [...g.acked].sort(), releasedAt: g.releasedAt,
        ...(extra ?? {}),
    });
    /** 退休序号账入账 + FIFO 有界 */
    const entomb = (name, seq) => {
        tomb.set(name, seq);
        while (tomb.size > maxTombstones) {
            const first = tomb.keys().next().value;
            if (first === undefined)
                break;
            tomb.delete(first);
        }
    };
    /** 在役 generation FIFO 有界（驱逐前先记 tombstone —— 防重放不因驱逐失效） */
    const boundLive = () => {
        while (live.size > maxLive) {
            const first = live.keys().next().value;
            if (first === undefined)
                break;
            const g = live.get(first);
            if (g)
                entomb(first, g.seq);
            live.delete(first);
        }
    };
    /** TTL 清扫（惰性：每次 apply 首步；驻留超时 ⇒ tombstone + 删除 —— 轮询者自愈重建） */
    const sweep = () => {
        for (const [name, g] of live) {
            if (now() - g.createdAt > ttlMs) {
                entomb(name, g.seq);
                live.delete(name);
            }
        }
    };
    /** 放行迁移（唯一迁移点 —— 只能由使名册满员的那次 allocate 触发） */
    const release = (g) => {
        g.phase = 'committed';
        g.releasedAt = now();
    };
    const apply = (req) => {
        try {
            sweep();
            if (!req || typeof req !== 'object')
                return bad('bad-request');
            const { op, name, peer } = req;
            if (typeof name !== 'string' || name === '' || name.length > BARRIER_NAME_MAX)
                return bad('bad-request');
            if (op !== 'status' && (typeof peer !== 'string' || peer === '' || peer.length > BARRIER_PEER_MAX)) {
                return bad('bad-request');
            }
            if (op === 'status') {
                const g = live.get(name);
                return g ? view(g) : bad('unknown-barrier');
            }
            if (op === 'commit') {
                const seq = req.seq;
                if (typeof seq !== 'number' || !Number.isFinite(seq))
                    return bad('bad-request');
                const g = live.get(name);
                if (!g) {
                    // 无在役 generation：序号落后于退休账 ⇒ 重放；否则 ⇒ 无此 barrier（不猜）
                    const t = tomb.get(name);
                    return bad(typeof t === 'number' && seq <= t ? 'stale-seq' : 'unknown-barrier');
                }
                if (seq !== g.seq)
                    return bad(seq < g.seq ? 'stale-seq' : 'unknown-seq');
                if (!g.arrived.has(peer))
                    return bad('not-a-participant');
                if (g.phase !== 'committed')
                    return bad('not-released');
                g.acked.add(peer);
                // 退休条件：全 N 确认（名册满员才放行 ⇒ acked ⊆ arrived，size 上界即 N）
                if (g.acked.size >= g.expected) {
                    entomb(name, g.seq);
                    live.delete(name);
                    return view(g, { retired: true });
                }
                return view(g);
            }
            // ── allocate（阶段一：加入 + 抵达；幂等）──
            const n = req.n;
            if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > maxParticipants)
                return bad('bad-request');
            let g = live.get(name);
            if (g && g.phase === 'committed' && g.acked.size >= g.expected) {
                // 防御臂：满确认却仍驻留（理论不可达 —— 退休在最后一次 ack 原地完成；
                // JS/TS 双实现漂移时这层兜底保证 allocate 不会误入已完结轮次）
                entomb(name, g.seq);
                live.delete(name);
                g = undefined;
            }
            if (!g) {
                g = {
                    name, seq: (tomb.get(name) ?? 0) + 1, expected: n, phase: 'collecting',
                    arrived: new Set([peer]), acked: new Set(), createdAt: now(), releasedAt: null,
                };
                live.set(name, g);
                boundLive();
                if (g.expected === 1)
                    release(g); // N=1：单参与者 barrier 抵达即满员
                return view(g);
            }
            if (g.phase === 'committed') {
                // 已放行：名册内者幂等重询（拿现行视图）；名册外者诚实拒绝（脑裂守卫）
                return g.arrived.has(peer) ? view(g) : bad('missed-release');
            }
            if (g.expected !== n) {
                return bad('count-conflict', { expected: g.expected });
            }
            if (g.arrived.has(peer))
                return view(g); // 幂等：重放/重询不重复计数
            g.arrived.add(peer);
            if (g.arrived.size >= g.expected)
                release(g);
            return view(g);
        }
        catch {
            return bad('bad-request'); // 绝不抛纪律的兜底臂
        }
    };
    return {
        apply,
        snapshot: () => [...live.values()].map(g => ({
            name: g.name, seq: g.seq, phase: g.phase, expected: g.expected,
            arrived: [...g.arrived].sort(), acked: [...g.acked].sort(),
        })),
        liveCount: () => live.size,
        tombstoneCount: () => tomb.size,
    };
}
/**
 * W5-3：抵达并等待放行（两阶段客户端，绝不抛）：
 *   ① 阶段一 allocate（幂等）——响应即现行视图；phase=committed ⇒ 进入 ②，
 *      否则按 pollMs 轮询（幂等 allocate 兼作心跳：TTL 驱逐后自愈重建）；
 *   ② 阶段二 commit 确认 —— 放行事实已被观察到，确认失败（transport 抖动/
 *      TTL 驻留过期）不推翻放行，仅如实记录在 ack 回执；
 *   ③ 领域拒绝（stale-seq/count-conflict/missed-release…）⇒ 立即诚实失败，
 *      不轮询硬磨；transport 抖动 ⇒ 继续轮询到 deadline（poll 即重试），
 *      全程零成功往返 ⇒ 'transport'；到 deadline 仍未放行 ⇒ 'timeout'
 *      （附最后在役面，绝不臆造放行）。
 * 迭代护栏 maxPolls：即使注入时钟冻结也不死循环（诚实超时收场）。
 */
export async function arriveAndWaitBarrier(name, n, o) {
    const fail = (reason, waitedMs, extra) => ({ ok: false, name: String(name), reason, waitedMs, ...(extra ?? {}) });
    try {
        if (typeof name !== 'string' || name === '' || name.length > BARRIER_NAME_MAX ||
            typeof o?.peer !== 'string' || o.peer === '' || o.peer.length > BARRIER_PEER_MAX ||
            typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > BARRIER_MAX_PARTICIPANTS ||
            typeof o.transport !== 'function') {
            return fail('bad-request', 0);
        }
        const now = typeof o.now === 'function' ? o.now : Date.now;
        const sleep = typeof o.sleep === 'function' ? o.sleep : (ms) => new Promise(r => setTimeout(r, ms));
        const pollMs = intOr(o.pollMs, BARRIER_DEFAULT_POLL_MS, 1, 60_000);
        const timeoutMs = intOr(o.timeoutMs, BARRIER_DEFAULT_TIMEOUT_MS, 1, 2_147_483_647);
        const start = now();
        const maxPolls = Math.ceil(timeoutMs / pollMs) + 3; // 冻结时钟护栏
        let everOk = false;
        let lastView = null;
        for (let i = 0;; i++) {
            try {
                lastView = await o.transport({ op: 'allocate', name, peer: o.peer, n });
                if (lastView && lastView.ok)
                    everOk = true;
            }
            catch {
                lastView = null; // 单次往返故障：poll 即重试（deadline 内不放弃）
            }
            if (lastView && lastView.ok) {
                if (lastView.phase === 'committed' && typeof lastView.seq === 'number') {
                    const waitedMs = now() - start;
                    // 阶段二：确认放行（housekeeping —— 失败不推翻已观察到的放行事实）
                    let ack;
                    try {
                        const a = await o.transport({ op: 'commit', name, peer: o.peer, seq: lastView.seq });
                        ack = a && a.ok
                            ? { ok: true, ...(a.retired === true ? { retired: true } : {}) }
                            : { ok: false, reason: a?.reason ?? 'transport' };
                    }
                    catch {
                        ack = { ok: false, reason: 'transport' };
                    }
                    return {
                        ok: true, name, seq: lastView.seq, peers: lastView.arrived ?? [],
                        waitedMs, ...(ack !== undefined ? { ack } : {}),
                    };
                }
            }
            else if (lastView && !lastView.ok) {
                // 领域拒绝：诚实立即失败（语义性错误，轮询磨不掉）
                return fail(lastView.reason ?? 'unknown-barrier', now() - start, lastView.expected !== undefined ? { expected: lastView.expected } : {});
            }
            if (now() - start >= timeoutMs || i + 1 >= maxPolls) {
                return fail(everOk ? 'timeout' : 'transport', now() - start, lastView && lastView.ok
                    ? { expected: lastView.expected, arrived: lastView.arrived }
                    : {});
            }
            await sleep(pollMs);
        }
    }
    catch {
        return fail('transport', 0);
    }
}
/** W5-3：视图净化（HTTP 载荷 → BarrierView；形状非法 ⇒ null ⇒ transport 诚实失败） */
function sanitizeView(p) {
    try {
        if (!p || typeof p !== 'object' || Array.isArray(p))
            return null;
        const v = p;
        if (typeof v.ok !== 'boolean')
            return null;
        return v;
    }
    catch {
        return null;
    }
}
/**
 * W5-3：HTTP barrier 传输壳（POST /barrier/{allocate|commit|status}；单次不重试、
 * AbortSignal.timeout(5s)、错误上抛由等待循环的 poll 即重试纪律吸收 ——
 * federation 网络纪律同源）。endpoint 尾斜杠容忍；fetch 注入 null = 显式禁网络。
 */
export function makeHttpBarrierTransport(o) {
    return async (req) => {
        let fetchFn = null;
        if (typeof o.fetchImpl === 'function')
            fetchFn = o.fetchImpl;
        else if (o.fetchImpl === null)
            fetchFn = null;
        else if (typeof fetch === 'function')
            fetchFn = fetch;
        if (!fetchFn)
            throw new Error('fetch unavailable (crossMachine barrier transport)');
        const base = typeof o.endpoint === 'string' ? o.endpoint.replace(/\/+$/, '') : '';
        const res = await fetchFn(`${base}/barrier/${req.op}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                name: req.name,
                ...(req.op === 'status' ? {} : { peer: req.peer }),
                ...(req.n !== undefined ? { n: req.n } : {}),
                ...(req.seq !== undefined ? { seq: req.seq } : {}),
            }),
            signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
                ? AbortSignal.timeout(BARRIER_FETCH_TIMEOUT_MS)
                : undefined,
        });
        let payload = null;
        try {
            payload = await res?.json?.();
        }
        catch {
            payload = null;
        }
        const v = sanitizeView(payload);
        if (v === null)
            throw new Error('barrier response unparsable');
        return v;
    };
}
/** W5-3：创建客户端（peer/transport/时钟/节奏全注入；perCall 覆写超时） */
export function createBarrierClient(o) {
    return {
        arriveAndWait: (name, n, perCall) => arriveAndWaitBarrier(name, n, { ...o, ...(perCall?.timeoutMs !== undefined ? { timeoutMs: perCall.timeoutMs } : {}) }),
    };
}
// ─── barrier 步声明方言（编排注入缝的缺省解析器）───
/**
 * W5-3：从 action 文本解析 barrier 步声明（`barrier:<name>#<n>`；首处匹配）。
 * planner 冻结 —— 声明走文本约定：复合任务的 rendezvous 点由规划文本携带，
 * orchestrator 的 crossMachine 缝按此方言识别（可用 barrierOf 注入整体覆写）。
 * n 钳 [1, BARRIER_MAX_PARTICIPANTS]；无匹配/垃圾输入 ⇒ null（诚实无声明）。
 */
export function parseBarrierStep(action) {
    try {
        if (typeof action !== 'string')
            return null;
        const m = BARRIER_STEP_RE.exec(action);
        if (!m)
            return null;
        const nRaw = Number(m[2]);
        if (!Number.isFinite(nRaw))
            return null;
        return { name: m[1], n: Math.min(BARRIER_MAX_PARTICIPANTS, Math.max(1, Math.floor(nRaw))) };
    }
    catch {
        return null;
    }
}
