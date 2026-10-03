#!/usr/bin/env node
// scripts/federation-server.mjs
// 纪元 Μ2 参考聚合端（GENESIS 缝隙「Μ 聚合端点未部署」的环回参考实现）：
// 纯 Node:http 的联邦摘要聚合服务 —— 跨宿主联邦从登记缝隙变成可运行的现实。
//
// 协议（环回参考口径）：
//   · POST /aggregate —— 请求体 = 一份摘要对象**或**摘要数组（合法者入内存环
//     BUFFER_CAP=64，FIFO）；返回对**当前环内全部摘要**的鲁棒合并：
//     { ok, digest: 合并摘要|null, digests: 环内原始摘要数组（供 robust 客户端
//       本地再聚合 —— 「谁合并」可以永远发生在调用方）, quarantined, method,
//       excluded, sources, rejected }；
//   · GET /health —— 存活与缓冲水位（零敏感信息）。
//
// W5-3（L3 跨机编排）barrier 中继端点（向后兼容增量 —— 旧 peer 只碰
//   /aggregate 与 /health，行为逐字节不变）：
//   · POST /barrier/allocate —— 阶段一（加入+抵达）：体 { name, peer, n }；
//     幂等；响应 = 现行 generation 视图（phase: collecting|committed ——
//     名册满员即放行，放行是服务端单一事实）；
//   · POST /barrier/commit —— 阶段二（放行确认）：体 { name, peer, seq }；
//     序号防重放（stale-seq/unknown-seq）+ 全 N 确认 ⇒ generation 退休；
//   · GET /barrier/status?name=N（及 POST 同路径）—— 只读视图。
//   领域拒绝（count-conflict/missed-release/…）以 200 + { ok:false, reason }
//   返回（协议级坏件才 4xx）。barrierApplyJS 是 src/crossMachine.ts
//   （createBarrierCore）的等价 JS 移植 —— 双实现漂移由 test/w5cross.test.ts
//   的脚本序列逐字段等价断言把守（核心以 TS 测试为准，本移植追随）。
//
// 安全边界（诚实声明）：
//   · 仅绑定 127.0.0.1（环回）；无鉴权、无限速、无 TLS —— **参考实现**；
//   · 生产部署须知：鉴权（mTLS/令牌）、速率限制、入站白名单、审计日志、跨网
//     传输加密由部署方负责 —— 本件不假装具备这些；
//   · 请求体上限 1MB（超限 413）；不落盘（内存单实例，重启即空 —— 信任账与
//     摘要皆不留宿主盘）。
//
// 双实现口径（重要）：本件的 robustMergeJS 是 src/federation/aggregate.ts
// （robustMergeDigests）的**等价 JS 移植** —— .mjs 不能 import TS。两实现的
// 漂移由 test/epochMu2.aggregate.test.ts 的端到端等价断言把守（同一输入 ⇒
// digest/quarantined/method 逐字段一致）；核心以 TS 测试为准，本移植追随。
//
// 运行：node scripts/federation-server.mjs [--port 18433]（--port 0 ⇒ 随机可用口）

import http from 'node:http';

// ─── 服务常量 ───

const DEFAULT_PORT = 18433;
const MAX_BODY_BYTES = 1024 * 1024; // 1MB 请求体上限
const BUFFER_CAP = 64; // 内存摘要环容量（FIFO —— 单实例内存，不落盘）

// W5-3：barrier 中继常量（与 src/crossMachine.ts 立法常量同值 —— 双实现口径）
const BARRIER_MAX_PARTICIPANTS = 64;
const BARRIER_NAME_MAX = 128;
const BARRIER_PEER_MAX = 128;
const BARRIER_MAX_LIVE = 64; // 在役 generation 上界（FIFO 驱逐 —— 服务端有界状态）
const BARRIER_MAX_TOMBSTONES = 256; // 退休序号账上界（重放视野的内存代价上界）
const BARRIER_TTL_MS = 120_000; // generation 驻留 TTL（驱逐前先记 tombstone）

// ═══ 以下为 src/crossMachine.ts（createBarrierCore）的等价 JS 移植（W5-3）═══
// 双实现口径：核心以 TS 测试为准；test/w5cross.test.ts 把守两实现漂移
//（同一脚本序列 ⇒ 视图逐字段一致，releasedAt 时间戳除外 —— 时钟源不同）。

const barrierLive = new Map(); // name → 在役 generation（插入序 = 创建序，FIFO 驱逐）
const barrierTomb = new Map(); // name → 最后退休 seq（重放视野；FIFO 有界）

function barrierEntomb(name, seq) {
  barrierTomb.set(name, seq);
  while (barrierTomb.size > BARRIER_MAX_TOMBSTONES) {
    const first = barrierTomb.keys().next().value;
    if (first === undefined) break;
    barrierTomb.delete(first);
  }
}

function barrierBoundLive() {
  while (barrierLive.size > BARRIER_MAX_LIVE) {
    const first = barrierLive.keys().next().value;
    if (first === undefined) break;
    const g = barrierLive.get(first);
    if (g) barrierEntomb(first, g.seq);
    barrierLive.delete(first);
  }
}

function barrierSweep() {
  for (const [name, g] of barrierLive) {
    if (Date.now() - g.createdAt > BARRIER_TTL_MS) {
      barrierEntomb(name, g.seq);
      barrierLive.delete(name);
    }
  }
}

function barrierBad(reason, extra) {
  return { ok: false, reason, ...(extra || {}) };
}

function barrierView(g, extra) {
  return {
    ok: true, name: g.name, seq: g.seq, phase: g.phase, expected: g.expected,
    arrived: [...g.arrived].sort(), acked: [...g.acked].sort(), releasedAt: g.releasedAt,
    ...(extra || {}),
  };
}

/** W5-3：barrier 状态机（createBarrierCore.apply 的 JS 移植 —— 语义逐分支一致） */
function barrierApplyJS(req) {
  try {
    barrierSweep();
    if (!req || typeof req !== 'object') return barrierBad('bad-request');
    const { op, name, peer } = req;
    if (typeof name !== 'string' || name === '' || name.length > BARRIER_NAME_MAX) return barrierBad('bad-request');
    if (op !== 'status' && (typeof peer !== 'string' || peer === '' || peer.length > BARRIER_PEER_MAX)) {
      return barrierBad('bad-request');
    }
    if (op === 'status') {
      const g = barrierLive.get(name);
      return g ? barrierView(g) : barrierBad('unknown-barrier');
    }
    if (op === 'commit') {
      const seq = req.seq;
      if (typeof seq !== 'number' || !Number.isFinite(seq)) return barrierBad('bad-request');
      const g = barrierLive.get(name);
      if (!g) {
        const t = barrierTomb.get(name);
        return barrierBad(typeof t === 'number' && seq <= t ? 'stale-seq' : 'unknown-barrier');
      }
      if (seq !== g.seq) return barrierBad(seq < g.seq ? 'stale-seq' : 'unknown-seq');
      if (!g.arrived.has(peer)) return barrierBad('not-a-participant');
      if (g.phase !== 'committed') return barrierBad('not-released');
      g.acked.add(peer);
      if (g.acked.size >= g.expected) {
        barrierEntomb(name, g.seq);
        barrierLive.delete(name);
        return barrierView(g, { retired: true });
      }
      return barrierView(g);
    }
    // allocate（阶段一：加入 + 抵达；幂等）
    const n = req.n;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > BARRIER_MAX_PARTICIPANTS) return barrierBad('bad-request');
    let g = barrierLive.get(name);
    if (g && g.phase === 'committed' && g.acked.size >= g.expected) {
      barrierEntomb(name, g.seq);
      barrierLive.delete(name);
      g = undefined;
    }
    if (!g) {
      g = {
        name,
        seq: (barrierTomb.get(name) ?? 0) + 1,
        expected: n,
        phase: 'collecting',
        arrived: new Set([peer]),
        acked: new Set(),
        createdAt: Date.now(),
        releasedAt: null,
      };
      barrierLive.set(name, g);
      barrierBoundLive();
      if (g.expected === 1) {
        g.phase = 'committed';
        g.releasedAt = Date.now();
      }
      return barrierView(g);
    }
    if (g.phase === 'committed') {
      return g.arrived.has(peer) ? barrierView(g) : barrierBad('missed-release');
    }
    if (g.expected !== n) {
      return barrierBad('count-conflict', { expected: g.expected });
    }
    if (g.arrived.has(peer)) return barrierView(g);
    g.arrived.add(peer);
    if (g.arrived.size >= g.expected) {
      g.phase = 'committed';
      g.releasedAt = Date.now();
    }
    return barrierView(g);
  } catch {
    return barrierBad('bad-request');
  }
}

// ═══ 以上为 TS 核心的等价 JS 移植 ═══

// ─── 参数解析（--port N；缺席 ⇒ 18433） ───

function parsePort(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && i + 1 < argv.length) {
      const p = Number(argv[i + 1]);
      if (Number.isInteger(p) && p >= 0 && p <= 65535) return p;
    }
  }
  return DEFAULT_PORT;
}

// ═══ 以下为 src/federation/aggregate.ts（robustMergeDigests）的等价 JS 移植 ═══
// （双实现口径：核心以 TS 测试为准；test/epochMu2.aggregate.test.ts 把守两实现漂移）

const DIGEST_VERSION = 1; // 与 index.ts 的 DIGEST_VERSION 同值
const DIGEST_BINS = 8; // 与 index.ts 的 DIGEST_BINS 同值（K=8 坨 × 成败两列）
const OUTLIER_FLOOR = 3; // 离群阈地板（DP 噪声容限）
const OUTLIER_IQR_SCALE = 2; // 离群阈的格间尺度（T = max(3, 2×IQR)）
const AGG_DEFAULT_EPSILON = 1;

/** 单格消毒：有限非负 ⇒ 取整；其余 ⇒ null（按缺席计） */
function cleanCellJS(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

function zeroBinsJS() {
  return Array.from({ length: DIGEST_BINS }, () => [0, 0]);
}

/** 中位数：奇数取正中；偶数取中间两数均值再取整（=2 个值时即均值） */
function medianOfJS(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** 四分位距（线性插值四分位 —— 与 TS iqrOf 同式；空集 ⇒ 0） */
function iqrOfJS(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => {
    const idx = p * (s.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  };
  return q(0.75) - q(0.25);
}

/** 逐格鲁棒值：0 源 ⇒ 0；1 源 ⇒ 直通；≥2 源 ⇒ 中位数 */
function robustOfJS(values) {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];
  return medianOfJS(values);
}

function methodOfCountJS(k) {
  return k >= 3 ? 'median' : k === 2 ? 'mean' : k === 1 ? 'single' : 'none';
}

/** 源资格甄别：坏源（形状坏/版本错配/陷阱属性）按缺席处理 —— 一个坏源只能缺席，不能否决合并 */
function validSourcesOfJS(digests) {
  const valid = [];
  const excluded = [];
  digests.forEach((d, i) => {
    try {
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('shape');
      if (d.v !== DIGEST_VERSION || !Array.isArray(d.keys)) throw new Error('schema');
      valid.push({ i, d });
    } catch {
      excluded.push(i);
    }
  });
  return { valid, excluded };
}

/**
 * 拜占庭鲁棒合并（robustMergeDigests 的 JS 移植）：逐格中位数（k≥3，偶数取中间
 * 均值）/ 均值（k=2，无鲁棒性注记）/ 直通（k=1）+ 逐格离群检疫（|源值−鲁棒值| >
 * max(3, 2×该 key 16 格鲁棒值 IQR) ⇒ 该源该格 1 票）。quarantined 键 = 源序号
 * 字符串（服务端无源命名面）。
 */
function robustMergeJS(digests) {
  try {
    if (!Array.isArray(digests) || digests.length === 0) {
      return { merged: null, quarantined: {}, method: 'none', excluded: [], notes: ['输入非数组或为空：无可合并源（诚实空手）'] };
    }
    const { valid, excluded } = validSourcesOfJS(digests);
    if (valid.length === 0) {
      return { merged: null, quarantined: {}, method: 'none', excluded, notes: ['零有效源：坏源全部按缺席处理后无可合并者'] };
    }
    const keyMap = new Map();
    let skipped = 0;
    let mintedAt = 0;
    let minEps = null;
    for (const { i, d } of valid) {
      if (typeof d.mintedAt === 'number' && Number.isFinite(d.mintedAt) && d.mintedAt > mintedAt) mintedAt = d.mintedAt;
      if (typeof d.epsilon === 'number' && Number.isFinite(d.epsilon) && d.epsilon > 0) {
        minEps = minEps === null ? d.epsilon : Math.min(minEps, d.epsilon);
      }
      for (const rawEntry of d.keys) {
        try {
          if (!rawEntry || typeof rawEntry !== 'object') {
            skipped += DIGEST_BINS * 2;
            continue;
          }
          if (typeof rawEntry.key !== 'string' || rawEntry.key === '') {
            skipped += DIGEST_BINS * 2;
            continue;
          }
          let agg = keyMap.get(rawEntry.key);
          if (!agg) {
            agg = {
              sources: new Set(),
              nValues: [],
              cells: Array.from({ length: DIGEST_BINS }, () => [[], []]),
            };
            keyMap.set(rawEntry.key, agg);
          }
          agg.sources.add(i);
          const nClean = cleanCellJS(rawEntry.n);
          if (nClean !== null) agg.nValues.push(nClean);
          else skipped += 1;
          const bins = Array.isArray(rawEntry.bins) ? rawEntry.bins : [];
          for (let b = 0; b < DIGEST_BINS; b++) {
            const cell = bins[b];
            for (let col = 0; col < 2; col++) {
              const v = cleanCellJS(Array.isArray(cell) ? cell[col] : undefined);
              if (v !== null) agg.cells[b][col].push({ i, v });
              else skipped += 1;
            }
          }
        } catch {
          skipped += DIGEST_BINS * 2;
        }
      }
    }
    const method = methodOfCountJS(valid.length);
    const notes = [];
    if (method === 'mean') notes.push('源数=2 ⇒ 逐格均值（诚实注记：无鲁棒性 —— 任一源可拉动半程，毒源未过半时仍是可用的过渡态）');
    if (method === 'single') notes.push('源数=1 ⇒ 直通（无聚合 —— 单源即全网）');
    const quarantined = {};
    const outKeys = [];
    for (const [key, agg] of keyMap) {
      const robustCells = [];
      for (let b = 0; b < DIGEST_BINS; b++) {
        for (let col = 0; col < 2; col++) robustCells.push(robustOfJS(agg.cells[b][col].map((c) => c.v)));
      }
      const T = Math.max(OUTLIER_FLOOR, OUTLIER_IQR_SCALE * iqrOfJS(robustCells));
      const kMethod = methodOfCountJS(agg.sources.size);
      if (kMethod !== method) {
        notes.push(`key「${key}」仅 ${agg.sources.size} 源在场 ⇒ 该 key 用 ${kMethod === 'mean' ? '均值（无鲁棒性）' : kMethod === 'single' ? '直通' : kMethod}`);
      }
      const bins = zeroBinsJS();
      for (let b = 0; b < DIGEST_BINS; b++) {
        for (let col = 0; col < 2; col++) {
          const r = robustCells[b * 2 + col];
          bins[b][col] = r;
          for (const { i, v } of agg.cells[b][col]) {
            if (Math.abs(v - r) > T) {
              const label = String(i);
              quarantined[label] = (quarantined[label] ?? 0) + 1;
            }
          }
        }
      }
      outKeys.push({ key, n: robustOfJS(agg.nValues), bins });
    }
    const merged = {
      v: DIGEST_VERSION,
      mintedAt,
      epsilon: minEps ?? AGG_DEFAULT_EPSILON,
      keys: outKeys,
      mergedFrom: valid.length,
      skipped,
    };
    return { merged, quarantined, method, excluded, notes };
  } catch {
    return { merged: null, quarantined: {}, method: 'none', excluded: [], notes: ['鲁棒合并过程异常：诚实空手（绝不炸服务）'] };
  }
}

// ═══ 以上为 TS 核心的等价 JS 移植 ═══

// ─── HTTP 骨架（纯 node:http、绝不因单请求崩服务） ───

const buffer = []; // 内存摘要环（FIFO，BUFFER_CAP 封顶；不落盘）
const startedAt = Date.now();

function sendJson(res, status, obj) {
  try {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  } catch {
    try {
      res.destroy();
    } catch {
      /* 套接字已死：无计可施，也不崩服务 */
    }
  }
}

/** 读请求体（带上限）：超限 ⇒ null（413，余流排空丢弃 —— 客户端能收到完整 413）；读故障 ⇒ undefined（400） */
function readBody(req, cap) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    req.on('data', (c) => {
      if (settled) return; // 已判超限：后续分片排空丢弃（不缓冲不硬断 —— 保 413 可达）
      size += c.length;
      if (size > cap) {
        done(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => done(Buffer.concat(chunks)));
    req.on('error', () => done(undefined));
  });
}

/** 摘要形状快筛（入环资格 —— 同 validSourcesOfJS 的前半） */
function looksLikeDigest(d) {
  try {
    return !!d && typeof d === 'object' && !Array.isArray(d) && d.v === DIGEST_VERSION && Array.isArray(d.keys);
  } catch {
    return false;
  }
}

const server = http.createServer((req, res) => {
  try {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'federation-aggregate',
        epoch: 'Mu2',
        buffered: buffer.length,
        bufferCap: BUFFER_CAP,
        maxBodyBytes: MAX_BODY_BYTES,
        uptimeMs: Date.now() - startedAt,
        // W5-3：barrier 中继水位（向后兼容增量字段 —— 旧 peer 不读不受影响）
        barriers: barrierLive.size,
        barrierCap: BARRIER_MAX_LIVE,
        barrierTombstones: barrierTomb.size,
      });
      return;
    }
    // ── W5-3：barrier 中继端点（领域拒绝 = 200 + {ok:false, reason}）──
    if (path === '/barrier/allocate' || path === '/barrier/commit' || path === '/barrier/status') {
      const op = path.split('/')[2];
      const handleBody = (obj) => {
        try {
          sendJson(res, 200, barrierApplyJS({ ...obj, op }));
        } catch {
          sendJson(res, 500, { ok: false, error: 'internal error (sanitized)' });
        }
      };
      if (req.method === 'GET' && path === '/barrier/status') {
        const name = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('name') ?? '';
        handleBody({ name });
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: `method not allowed: POST ${path}` });
        return;
      }
      readBody(req, MAX_BODY_BYTES).then((body) => {
        try {
          if (body === null) {
            sendJson(res, 413, { ok: false, error: `request body exceeds ${MAX_BODY_BYTES} bytes` });
            return;
          }
          if (body === undefined) {
            sendJson(res, 400, { ok: false, error: 'request body read failed' });
            return;
          }
          let parsed;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { ok: false, error: 'request body is not valid JSON' });
            return;
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            sendJson(res, 400, { ok: false, error: 'request body must be a barrier request object' });
            return;
          }
          handleBody(parsed);
        } catch {
          sendJson(res, 500, { ok: false, error: 'internal error (sanitized)' });
        }
      });
      return;
    }
    if (path === '/aggregate') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed: POST /aggregate' });
        return;
      }
      readBody(req, MAX_BODY_BYTES).then((body) => {
        try {
          if (body === null) {
            sendJson(res, 413, { ok: false, error: `request body exceeds ${MAX_BODY_BYTES} bytes` });
            return;
          }
          if (body === undefined) {
            sendJson(res, 400, { ok: false, error: 'request body read failed' });
            return;
          }
          let parsed;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { ok: false, error: 'request body is not valid JSON' });
            return;
          }
          if (!parsed || typeof parsed !== 'object') {
            sendJson(res, 400, { ok: false, error: 'request body must be a digest object or an array of digests' });
            return;
          }
          const incoming = Array.isArray(parsed) ? parsed : [parsed];
          let rejected = 0;
          for (const d of incoming) {
            if (looksLikeDigest(d)) buffer.push(d);
            else rejected += 1; // 坏件不入环（缺席处理 —— 与鲁棒律同源）
          }
          while (buffer.length > BUFFER_CAP) buffer.shift();
          const rr = robustMergeJS(buffer);
          sendJson(res, 200, {
            ok: true,
            digest: rr.merged,
            digests: buffer, // 环内原始摘要（供 robust 客户端本地再聚合）
            quarantined: rr.quarantined,
            method: rr.method,
            excluded: rr.excluded,
            sources: buffer.length,
            rejected,
          });
        } catch {
          sendJson(res, 500, { ok: false, error: 'internal error (sanitized)' });
        }
      });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not found: GET /health | POST /aggregate | POST /barrier/{allocate,commit,status} | GET /barrier/status?name=' });
  } catch {
    sendJson(res, 500, { ok: false, error: 'internal error (sanitized)' });
  }
});

// 协议层故障（坏请求行等）不崩服务
server.on('clientError', (err, socket) => {
  try {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } else {
      socket.destroy();
    }
  } catch {
    try {
      socket.destroy();
    } catch {
      /* 已死 */
    }
  }
});

const port = parsePort(process.argv.slice(2));
server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  console.log(JSON.stringify({ event: 'listening', address: '127.0.0.1', port: addr.port, epoch: 'Mu2', pid: process.pid }));
});

// 优雅停机（内存单实例：不落盘 —— 关机即忘是设计语义）
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
