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
//   返回（协议级坏件才 4xx）。W8-A7（D-F3 闭）：barrier 状态机已退役 JS 手工
//   移植（原 barrierApplyJS）—— 本文件经 dist/crossMachine.js 直连
//   createBarrierCore 单源权威；test/w5cross.test.ts ⑧ 的逐字段对账继续
//   在场，把守面从「手工移植漂移」转为「src↔dist 构建滞后」。
//
// 安全边界（诚实声明）：
//   · 仅绑定 127.0.0.1（环回）；无限速、无 TLS —— **参考实现**；
//   · W6R-A5（共享密钥认证）：环境变量 DSH_FEDERATION_TOKEN 设置 ⇒ /aggregate
//     强制 HMAC-SHA256 请求签名（头 x-dsh-fed-timestamp + x-dsh-fed-signature；
//     签名输入 = `${timestamp}.${body}`，时间戳容差 ±5 分钟防重放 —— 与
//     dsh_physical 的 Cap Token 同风格、与 src/federation/index.ts 的
//     federationAuthHeaders 同协议，双端口径由 test/epochMu2 等价断言把守）；
//     未设置 ⇒ open 模式零配置环回可用（/health 的 authMode 与启动日志明示
//     未认证 —— 不假装具备认证）。恒时比较（timingSafeEqual）拒计时侧信道；
//     密钥绝不进日志/错误面。
//   · W9-2（DEBTS D-C5 落锤）：barrier 三端点（allocate/commit/status）纳入
//     同款 HMAC 签名 —— token 模式下缺省**要求签名**（生产姿态：barrier 名册
//     与放行视图也是协调面情报，不再裸奔）；向后兼容通道：env
//     FED_ALLOW_OPEN_BARRIER=1 保留参考拓扑的开放 barrier（部署方显式声明
//     「barrier 面由反代/网络层收口」时的过渡姿势）。open 模式（未设 token）
//     一切端点照旧开放 —— 零配置环回语义不变。签名客户端姿势见
//     scripts/README-federation.md（含 curl 示例；src/crossMachine.ts 的
//     makeHttpBarrierTransport 可经注入 fetchImpl 加签 —— 见 README）。
//   · W9-2（DEBTS D-C2 落锤）：生产化 env 面（全部可选，未设 ⇒ 与参考实现
//     逐字节同行为 —— 生产化是能力不是缺省切换）：
//       DSH_FED_PORT            监听口（--port 参数优先；缺席 ⇒ 18433）
//       DSH_FED_MAX_BODY_BYTES  请求体上限（缺席 ⇒ 1MB；413 语义同律）
//       DSH_FEDERATION_TOKEN    HMAC 共享密钥（W6R-A5 既有名，不变）
//       DSH_FED_BARRIER_TTL_MS  barrier 驻留 TTL（缺席 ⇒ TS 立法缺省 120s）
//       DSH_FED_PERSIST_DIR     摘要环落盘目录（缺席 ⇒ 内存单实例「关机即忘」
//                               设计语义不变；设置 ⇒ 每次入环原子落盘 + 起动
//                               防御回读 —— 生产部署以「摘要落宿主盘」换重启
//                               环连续性的显式决策）
//       DSH_FED_DRAIN_MS        优雅关停排空上限（缺席 ⇒ 1500ms 参考缺省）
//       FED_ALLOW_OPEN_BARRIER  =1 ⇒ token 模式下 barrier 面保持开放（D-C5 兼容）
//     优雅关停：SIGTERM/SIGINT ⇒ 停收新连接 + 排空在途请求（closeIdleConnections
//     收掉 keep-alive 空闲连接）+ 落盘（如开持久化）+ drain 上限内 exit 0。
//     部署清单（反代 TLS / 速率限制 / 入站白名单 / 审计日志）：README-federation.md。
//   · 生产部署须知：速率限制、入站白名单、审计日志、跨网传输加密由部署方负责 ——
//     本件不假装具备这些；
//   · 请求体上限 1MB（超限 413）；不落盘（内存单实例，重启即空 —— 信任账与
//     摘要皆不留宿主盘）—— 除非显式设置 DSH_FED_PERSIST_DIR（上表权衡）。
//
// 双实现口径（重要）：本件的 robustMergeJS 是 src/federation/aggregate.ts
// （robustMergeDigests）的**等价 JS 移植** —— .mjs 不能 import TS（可 import
// dist 构建产物：barrier 面 W8-A7 已借此单源化；aggregate 面维持手工移植 +
// 下方等价执法，属 federation 域口径，不在 crossMachine 单源化范围）。两实现的
// 漂移由 test/epochMu2.aggregate.test.ts 的端到端等价断言把守（同一输入 ⇒
// digest/quarantined/method 逐字段一致）；核心以 TS 测试为准，本移植追随。
//
// 运行：node scripts/federation-server.mjs [--port 18433]（--port 0 ⇒ 随机可用口；
// 缺席时 env DSH_FED_PORT 次之、再缺席 ⇒ 18433 —— W9-2 D-C2 生产化 env 面，
// 全部 env 缺席时与参考实现逐字节同行为）。
// 部署指南：scripts/README-federation.md（env 清单 / 签名客户端示例 / 关停语义）。

import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, mkdirSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
// W8-A7（D-F3 闭：barrier 面单源化）：barrier 状态机彻底退役 JS 手工移植，
// 直连 dist 构建产物里的 TS 权威源（package.json "type":"module" ⇒ dist 是
// 纯 ESM，.mjs 原生可命名导入 —— 原「.mjs 不能 import TS」约束由「import
// dist 产物」化解；dist 入库且 CI 每轮 npm run build）。src↔dist 构建滞后
// 由 test/w5cross.test.ts ⑧ 的逐字段对账闸把守（脚本序列对 TS 源核心与
// HTTP server 对账 —— dist 过期即闸红），本文件不再持有第二份状态机。
import { createBarrierCore, BARRIER_MAX_LIVE } from '../dist/crossMachine.js';

// ─── 服务常量 ───

const DEFAULT_PORT = 18433;
const BUFFER_CAP = 64; // 内存摘要环容量（FIFO —— 单实例内存；持久化开启时为落盘上限）

// ─── W9-2（DEBTS D-C2 落锤）：生产化 env 面 —— 全部可选，缺席 ⇒ 参考缺省 ───
// 保守律：任何 env 值非法（非正整数/超界）⇒ 忽略并回参考缺省 + 启动日志明示
// warning（配置错误要可见，不要静默猜）；缺省行为与落锤前逐字节一致。

const PORT_ENV = 'DSH_FED_PORT';
const MAX_BODY_ENV = 'DSH_FED_MAX_BODY_BYTES';
const BARRIER_TTL_ENV = 'DSH_FED_BARRIER_TTL_MS';
const PERSIST_ENV = 'DSH_FED_PERSIST_DIR';
const DRAIN_ENV = 'DSH_FED_DRAIN_MS';
const OPEN_BARRIER_ENV = 'FED_ALLOW_OPEN_BARRIER';

const envWarnings = [];

/** 正整数 env 读取（min ≤ v ≤ max）；缺席/非法 ⇒ null（调用方回缺省并记 warning） */
function envInt(name, min, max) {
  const raw = process.env[name];
  if (raw === undefined || typeof raw !== 'string' || raw.trim() === '') return null;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) {
    envWarnings.push(`${name}=${raw} is not an integer in [${min}, ${max}] — ignored, using default`);
    return null;
  }
  return v;
}

/** W9-2 D-C2：请求体上限（缺席 ⇒ 1MB 参考缺省；上界 64MB —— 无界配置 = 无界内存面） */
const MAX_BODY_BYTES = envInt(MAX_BODY_ENV, 1, 64 * 1024 * 1024) ?? 1024 * 1024;
/** W9-2 D-C2：barrier 驻留 TTL 覆盖（缺席 ⇒ null = TS 立法缺省 120s —— 单源纪律：缺省值不在此复制） */
const BARRIER_TTL_OVERRIDE_MS = envInt(BARRIER_TTL_ENV, 1, 3_600_000);
/** W9-2 D-C2：优雅关停排空上限（缺席 ⇒ 1500ms 参考缺省 —— 与落锤前超时同值） */
const DRAIN_MS = envInt(DRAIN_ENV, 100, 60_000) ?? 1500;
/** W9-2 D-C2：摘要环持久化目录（缺席 ⇒ null = 内存单实例「关机即忘」设计语义不变） */
const rawPersistDir = typeof process.env[PERSIST_ENV] === 'string' ? process.env[PERSIST_ENV].trim() : '';
const PERSIST_DIR = rawPersistDir !== '' ? rawPersistDir : null;
const PERSIST_FILE = PERSIST_DIR !== null ? path.join(PERSIST_DIR, 'federation-digests.json') : null;
/** W9-2 D-C5：token 模式下 barrier 面缺省要求签名；=1 显式保留参考拓扑的开放 barrier */
const ALLOW_OPEN_BARRIER = process.env[OPEN_BARRIER_ENV] === '1';

// ─── W6R-A5：共享密钥认证（HMAC-SHA256 + 时间戳防重放 —— Cap Token 同风格） ───
// 协议契约与 src/federation/index.ts 的 federationAuthHeaders 同律（双实现口径：
// 等价性由 test/epochMu2 的带签往返把守）。env 缺席 ⇒ open 模式零配置（诚实声明）。

const AUTH_ENV = 'DSH_FEDERATION_TOKEN';
const AUTH_TIMESTAMP_HEADER = 'x-dsh-fed-timestamp';
const AUTH_SIGNATURE_HEADER = 'x-dsh-fed-signature';
const AUTH_SKEW_MS = 5 * 60_000; // 与 TS FEDERATION_AUTH_SKEW_MS 同值（±5 分钟）

/** 共享密钥（env 设置 ⇒ token 模式；未设置/非字符串 ⇒ open 模式） */
const fedTokenRaw = process.env[AUTH_ENV];
const FED_TOKEN = typeof fedTokenRaw === 'string' ? fedTokenRaw : '';
const AUTH_REQUIRED = FED_TOKEN !== '';
// W9-2（DEBTS D-C5 落锤）：token 模式下 barrier 三端点缺省**要求签名**（生产
// 姿态）；FED_ALLOW_OPEN_BARRIER=1 ⇒ 兼容通道保留参考拓扑的开放 barrier（部署
// 方显式声明该面由反代/网络层收口时的过渡姿势）。open 模式（未设密钥）一切
// 照旧 —— 零配置环回语义不变。
const BARRIER_AUTH_REQUIRED = AUTH_REQUIRED && !ALLOW_OPEN_BARRIER;

/** hex 恒时比较：期望侧恒 64 hex 字符；长度不等直接拒（长度不是秘密） */
function constantTimeHexEqual(actual, expected) {
  if (typeof actual !== 'string' || actual.length !== 64) return false;
  try {
    return timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * 请求验签（token 模式）：头 x-dsh-fed-timestamp（epoch ms）+
 * x-dsh-fed-signature（hex HMAC-SHA256(`${ts}.${body}`, token)）。
 * 时间戳偏移超 ±5 分钟 ⇒ stale（防重放窗口）；签名覆盖正文 ⇒ 中间人换体即失配。
 * open 模式恒 { ok:true }（零配置环回语义不变）。绝不抛（坏头按拒绝处理）。
 */
function verifyAuth(req, bodyText) {
  if (!AUTH_REQUIRED) return { ok: true, mode: 'open' };
  try {
    const tsRaw = req.headers[AUTH_TIMESTAMP_HEADER];
    const sigRaw = req.headers[AUTH_SIGNATURE_HEADER];
    if (tsRaw === undefined || sigRaw === undefined) {
      return { ok: false, mode: 'token', reason: 'missing-signature-headers' };
    }
    const ts = Number(Array.isArray(tsRaw) ? tsRaw[0] : tsRaw);
    if (!Number.isFinite(ts)) return { ok: false, mode: 'token', reason: 'malformed-timestamp' };
    if (Math.abs(Date.now() - ts) > AUTH_SKEW_MS) {
      return { ok: false, mode: 'token', reason: 'stale-timestamp' };
    }
    const sig = String(Array.isArray(sigRaw) ? sigRaw[0] : sigRaw);
    const expected = createHmac('sha256', FED_TOKEN).update(`${ts}.${bodyText}`).digest('hex');
    if (!constantTimeHexEqual(sig, expected)) {
      return { ok: false, mode: 'token', reason: 'signature-mismatch' };
    }
    return { ok: true, mode: 'token' };
  } catch {
    return { ok: false, mode: 'token', reason: 'auth-internal-error' };
  }
}

/** 401 响应（消毒：不泄密钥/期望签名 —— 只报缺口与协议指引） */
function sendUnauthorized(res, reason) {
  sendJson(res, 401, {
    ok: false,
    error: `unauthorized: valid HMAC request signature required (${AUTH_TIMESTAMP_HEADER} + ${AUTH_SIGNATURE_HEADER} headers; shared secret via ${AUTH_ENV})`,
    reason,
  });
}

// ═══ W5-3 barrier 状态机（W8-A7 单源化：dist/crossMachine.js 唯一权威）═══
// 模块级单例 = 服务器进程的单一 barrier 世界（与原手工移植的模块级 Map 单例
// 同语义）。时钟 Date.now、容量/TTL/参与上界全走 TS 立法缺省（maxLive=64 /
// maxTombstones=256 / ttl=120s / maxParticipants=64 —— 与原移植写死值逐值
// 相同）；W9-2（D-C2）：DSH_FED_BARRIER_TTL_MS 是唯一可覆盖项（生产部署的
// 驻留窗口调参面；缺席 ⇒ 零参调用 = TS 立法缺省，单源纪律不破）；
// allocate/commit 两阶段、seq 防重放、有界状态的全部协议语义单一
// 来源于 src/crossMachine.ts（经 dist 构建产物）——本文件不再持有第二份
// 状态机（退役即免维护：源改一处，server 随 dist 构建自动跟进）。
const barrierCore = BARRIER_TTL_OVERRIDE_MS !== null
  ? createBarrierCore({ ttlMs: BARRIER_TTL_OVERRIDE_MS })
  : createBarrierCore();

// ─── 参数解析（--port N；缺席 ⇒ env DSH_FED_PORT；再缺席 ⇒ 18433 —— W9-2 D-C2） ───

function parsePort(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && i + 1 < argv.length) {
      const p = Number(argv[i + 1]);
      if (Number.isInteger(p) && p >= 0 && p <= 65535) return p;
    }
  }
  return envInt(PORT_ENV, 1, 65535) ?? DEFAULT_PORT;
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

const buffer = []; // 内存摘要环（FIFO，BUFFER_CAP 封顶；DSH_FED_PERSIST_DIR 设置时随入环落盘）
const startedAt = Date.now();

// ─── W9-2（DEBTS D-C2 落锤）：摘要环可选持久化（DSH_FED_PERSIST_DIR）───
// 决策理由：参考实现的「不落盘」是信任姿态（摘要/信任账不留宿主盘），生产
// 部署重启即丢环 ⇒ 联邦聚合的连续性断档。落锤为**显式开关**而非缺省切换：
// 缺席 ⇒ 内存单实例语义与落锤前逐字节一致；设置 ⇒ 以「摘要落盘」换重启环
// 连续性 —— 权衡由部署方拍板，本件只提供能力与诚实的文档（README）。
// 写纪律：tmp + fsync + rename 原子写（checkpoint/escrow WAL 同律 —— 绝无半档）；
// 读纪律：起动防御回读（形状过滤 + 截到 BUFFER_CAP —— 坏档 ⇒ 空环起步，绝不炸）；
// 故障纪律：落盘失败记 warning 事件继续服务（持久化是旁路能力，不是主路径）。

function persistRing(cause) {
  if (PERSIST_FILE === null) return;
  const tmp = PERSIST_FILE + '.tmp';
  try {
    mkdirSync(path.dirname(PERSIST_FILE), { recursive: true });
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, Buffer.from(JSON.stringify({ version: 1, savedAt: Date.now(), cause, digests: buffer }, 'utf8')));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, PERSIST_FILE);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* tmp 可能未创建 */ }
    console.error(JSON.stringify({ event: 'persist-failed', cause, error: e instanceof Error ? e.message : String(e) }));
  }
}

function loadRingAtBoot() {
  if (PERSIST_FILE === null) return;
  try {
    if (!existsSync(PERSIST_FILE)) return;
    const parsed = JSON.parse(readFileSync(PERSIST_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.digests)) return; // 坏档 ⇒ 空环起步
    for (const d of parsed.digests.slice(-BUFFER_CAP)) {
      if (looksLikeDigest(d)) buffer.push(d); // 形状过滤 —— 坏件按缺席（与入环资格同律）
    }
    console.log(JSON.stringify({ event: 'persist-loaded', restored: buffer.length, file: PERSIST_FILE }));
  } catch (e) {
    console.error(JSON.stringify({ event: 'persist-load-failed', error: e instanceof Error ? e.message : String(e) }));
  }
}

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
        // W6R-A5：认证模式明示（open = 未认证的诚实声明 —— 任务书的「明示未认证模式」）
        authMode: AUTH_REQUIRED ? 'token' : 'open',
        // W9-2（D-C5 落锤）：barrier 面认证模式明示 —— token 模式下缺省签名
        //（生产姿态）；FED_ALLOW_OPEN_BARRIER=1 ⇒ open（参考拓扑兼容，部署方
        // 显式声明 barrier 面由网络层/反代收口）
        barrierAuthMode: BARRIER_AUTH_REQUIRED ? 'token' : 'open',
        authNotice: AUTH_REQUIRED
          ? (BARRIER_AUTH_REQUIRED
            ? `HMAC signature enforced on POST /aggregate AND /barrier/{allocate,commit,status} (${AUTH_TIMESTAMP_HEADER} + ${AUTH_SIGNATURE_HEADER}; ±${Math.round(AUTH_SKEW_MS / 1000)}s clock skew)`
            : `HMAC signature enforced on POST /aggregate (${AUTH_TIMESTAMP_HEADER} + ${AUTH_SIGNATURE_HEADER}); barrier endpoints remain OPEN (${OPEN_BARRIER_ENV}=1 compatibility mode)`)
          : `UNAUTHENTICATED mode: set ${AUTH_ENV} to require HMAC signatures on POST /aggregate`,
        buffered: buffer.length,
        bufferCap: BUFFER_CAP,
        maxBodyBytes: MAX_BODY_BYTES,
        // W9-2（D-C2 生产化透明面 —— 增量字段，旧 peer 不读不受影响）
        persistence: PERSIST_FILE !== null,          // 摘要环落盘开关（缺席 = 内存单实例语义）
        barrierTtlOverrideMs: BARRIER_TTL_OVERRIDE_MS, // null = TS 立法缺省（120s —— 单源纪律不在本件复制缺省值）
        drainMs: DRAIN_MS,                             // 优雅关停排空上限
        uptimeMs: Date.now() - startedAt,
        // W5-3：barrier 中继水位（向后兼容增量字段 —— 旧 peer 不读不受影响）；
        // W8-A7：水位改读单源核心观测面（与原移植的 Map.size 同义）
        barriers: barrierCore.liveCount(),
        barrierCap: BARRIER_MAX_LIVE,
        barrierTombstones: barrierCore.tombstoneCount(),
      });
      return;
    }
    // ── W5-3：barrier 中继端点（领域拒绝 = 200 + {ok:false, reason}）──
    // W9-2（D-C5 落锤）：token 模式下三端点纳入 HMAC 验签（与 /aggregate 同款
    // 头与公式 —— 签名覆盖原始正文 `${ts}.${body}`；GET status 无正文 ⇒ 验签
    // 输入 `${ts}.`）。执法序与 /aggregate 同律：413/读故障 → 验签 401 →
    // JSON 解析 400 → 领域处理 —— 拒绝在解体之前（换体即失配）。
    if (path === '/barrier/allocate' || path === '/barrier/commit' || path === '/barrier/status') {
      const op = path.split('/')[2];
      const handleBody = (obj) => {
        try {
          // W8-A7：直连 dist 单源核心（原 barrierApplyJS 手工移植已退役）——
          // apply 自带绝不抛纪律（异常 ⇒ bad-request 视图），外壳 try 仍留一层
          sendJson(res, 200, barrierCore.apply({ ...obj, op }));
        } catch {
          sendJson(res, 500, { ok: false, error: 'internal error (sanitized)' });
        }
      };
      if (req.method === 'GET' && path === '/barrier/status') {
        // W9-2（D-C5）：GET 只读面同律验签（空正文签名 —— 名册/放行视图也是情报）
        if (BARRIER_AUTH_REQUIRED) {
          const auth = verifyAuth(req, '');
          if (!auth.ok) {
            sendUnauthorized(res, auth.reason);
            return;
          }
        }
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
          // W9-2（D-C5）：POST barrier 面验签（签名覆盖原始正文 —— 与 /aggregate 同序）
          const bodyText = body.toString('utf8');
          if (BARRIER_AUTH_REQUIRED) {
            const auth = verifyAuth(req, bodyText);
            if (!auth.ok) {
              sendUnauthorized(res, auth.reason);
              return;
            }
          }
          let parsed;
          try {
            parsed = JSON.parse(bodyText);
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
          // W6R-A5：token 模式下先验签再解体（签名覆盖原始正文 —— 换体即失配；
          // open 模式恒过 ⇒ 零配置环回语义不变）
          const bodyText = body.toString('utf8');
          const auth = verifyAuth(req, bodyText);
          if (!auth.ok) {
            sendUnauthorized(res, auth.reason);
            return;
          }
          let parsed;
          try {
            parsed = JSON.parse(bodyText);
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
          persistRing('aggregate'); // W9-2（D-C2）：持久化开启 ⇒ 环变更随行落盘（缺席 = no-op）
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
loadRingAtBoot(); // W9-2（D-C2）：持久化开启 ⇒ 起动防御回读（缺席 = no-op）
server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  // W6R-A5：启动日志明示认证模式（open = 未认证的诚实声明 —— 不假装具备认证）；
  // W9-2（D-C2/D-C5 落锤）：barrier 认证模式与生产化 env 面随行明示（缺省 =
  // 参考实现行为的透明化 —— 未设 env 时各字段即参考缺省值）
  console.log(JSON.stringify({
    event: 'listening',
    address: '127.0.0.1',
    port: addr.port,
    epoch: 'Mu2',
    pid: process.pid,
    auth: AUTH_REQUIRED ? 'token (HMAC-SHA256 enforced on POST /aggregate)' : 'open (UNAUTHENTICATED — set DSH_FEDERATION_TOKEN to enforce HMAC signatures)',
    barrierAuth: BARRIER_AUTH_REQUIRED
      ? 'token (HMAC-SHA256 enforced on /barrier/{allocate,commit,status})'
      : (AUTH_REQUIRED ? `open (compatibility: ${OPEN_BARRIER_ENV}=1 — barrier endpoints NOT signed)` : 'open (no token configured)'),
    maxBodyBytes: MAX_BODY_BYTES,
    barrierTtlOverrideMs: BARRIER_TTL_OVERRIDE_MS,
    persistence: PERSIST_FILE !== null,
    drainMs: DRAIN_MS,
    ...(envWarnings.length > 0 ? { envWarnings } : {}),
  }));
});

// 优雅停机（W9-2 D-C2 生产化）：SIGTERM/SIGINT ⇒ 停收新连接 + 排空在途请求
//（closeIdleConnections 收掉 keep-alive 空闲连接 —— 无它则已答完的空闲连接
// 会拖住 server.close 到超时）+ 持久化随行落盘（如开启）+ DRAIN_MS 上限内
// exit 0（缺省 1500ms —— 与落锤前参考超时同值；双信号幂等，重触发不重复排空）。
// 内存单实例且未开持久化时语义不变：关机即忘是设计语义（见安全边界声明）。
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    console.log(JSON.stringify({ event: 'shutdown', signal, drainMs: DRAIN_MS, buffered: buffer.length }));
  } catch { /* 日志面故障不挡关停 */ }
  try {
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  } catch { /* 无空闲连接面（老运行时）—— server.close 仍等待在途 */ }
  server.close(() => {
    persistRing('shutdown');
    process.exit(0);
  });
  setTimeout(() => {
    persistRing('shutdown-drain-timeout');
    process.exit(0);
  }, DRAIN_MS).unref();
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(sig));
}
