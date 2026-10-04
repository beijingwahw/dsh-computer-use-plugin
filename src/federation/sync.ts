// src/federation/sync.ts
// W9-3（D-F4 拆分·传输分区）：自 federation/index.ts 低风险提取 —— W6R-A5 聚合
// 端共享密钥认证（HMAC 请求签名 + 防重放）+ Μ-e 同步 federationSync（网络纪律的
// 落点：fire-and-forget POST / 鲁棒臂本地聚合 / 状态记忆）。逐字节搬运（零逻辑
// 变更）；index.ts 原位再导出 —— 导入面不变（消费方零改动）。
import { createHmac } from 'node:crypto';
import { evidenceLedger } from '../kernel/registry';
import { robustMergeDigests, applyQuarantineToTrust } from './aggregate';
import {
  DIGEST_VERSION, FEDERATION_TIMEOUT_MS, mintEvidenceDigest,
  type EvidenceDigest, type FederationLedgerView,
} from './digest';
import { applyFederatedEvidence, type FederationLedgerTarget, type FederatedApplyReport } from './apply';
import { recordFederationTrust } from './trust';

// ─── W6R-A5（聚合端共享密钥认证）：上行 HMAC 请求签名 ───
//
// 缝隙（D-C2 配套）：参考聚合端（scripts/federation-server.mjs）明文无认证 ——
// 摘要上行/下行可被中间人替换。修复纪律与 dsh_physical 的 Cap Token 同风格：
// **HMAC-SHA256 + 时间戳防重放**，共享密钥经环境变量分发：
//   · 服务端：DSH_FEDERATION_TOKEN 设置 ⇒ 强制 /aggregate 请求带签名头，否则 401
//     （未设置 ⇒ 零配置环回可用，/health 与启动日志明示 open 未认证模式）；
//   · 客户端（本模块 federationSync 网络臂）：读同一 env，设置时为每次 POST 附
//     x-dsh-fed-timestamp（epoch ms）+ x-dsh-fed-signature（hex HMAC-SHA256），
//     签名输入 = `${timestamp}.${body}` —— **时间戳与摘要正文一并入 MAC**：中间人
//     换_body_签名失配、换_timestamp_防重放窗口外的重放被拒，双向都咬合。
//   · 密钥卫生：token 绝不进日志/错误注记/结果对象（错误消毒律同 endpoint 脱敏）；
//     客户端签名失败 = 诚实降级（空头 ⇒ 服务端 401 ⇒ 同步臂诚实注记，绝不炸宿主）。

/** 共享密钥环境变量名（服务端与客户端同字面量 —— 协议契约，双端漂移由测试把守） */
export const FEDERATION_AUTH_ENV = 'DSH_FEDERATION_TOKEN';

/** 签名时间戳头（epoch ms —— 防重放的时间面） */
export const FEDERATION_AUTH_TIMESTAMP_HEADER = 'x-dsh-fed-timestamp';

/** HMAC-SHA256 签名头（hex —— 密钥持有证明） */
export const FEDERATION_AUTH_SIGNATURE_HEADER = 'x-dsh-fed-signature';

/** 时间戳容差 ±5 分钟（服务端同值 —— 时钟偏移容忍与重放窗口的上界） */
export const FEDERATION_AUTH_SKEW_MS = 5 * 60_000;

/**
 * 签名头铸造（纯函数、绝不抛）：token 非空字符串 ⇒ { 时间戳头, 签名头 }；否则 {}
 * （open 客户端零头 —— 服务端 open 模式照收，token 模式 401 诚实降级）。签名输入
 * `${timestamp}.${body}`：body 恒以 { 开头（JSON 对象）⇒ 分隔符无歧义。crypto
 * 故障 ⇒ {}（多掩蔽方向：宁可不发签名被拒，绝不发可伪造的弱签名）。导出为
 * 公开面 —— 测试与聚合端的等价断言共用同一实现（双端口径的唯一 TS 权威源）。
 */
export function federationAuthHeaders(
  body: string,
  token: unknown,
  nowMs: number,
): Record<string, string> {
  try {
    if (typeof token !== 'string' || token === '') return {};
    const ts = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
    const sig = createHmac('sha256', token).update(`${ts}.${body}`).digest('hex');
    return {
      [FEDERATION_AUTH_TIMESTAMP_HEADER]: String(ts),
      [FEDERATION_AUTH_SIGNATURE_HEADER]: sig,
    };
  } catch {
    return {}; // 绝不抛纪律：签名失败 = 无头（服务端 401 = 诚实降级）
  }
}

/** 解析同步用的共享密钥：显式注入优先（'' = 显式不签）；缺省读 env（open 语义零头） */
function resolveFederationAuthToken(explicit: string | null | undefined): string {
  if (typeof explicit === 'string') return explicit;
  if (explicit === null) return '';
  try {
    const v = process.env[FEDERATION_AUTH_ENV];
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}


// ─── Μ-e 同步：federationSync（网络纪律的落点） ───

/** 最小 fetch 结构面（真 fetch / 假件皆可注入 —— 测试零网络） */
export type FederationFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ json?: () => Promise<unknown> }>;

/** 同步选项（endpoint/ε/份额/信任源/种子/时钟/网络/账本全可注入） */
export interface FederationSyncOptions {
  /** 聚合端点；空串/缺省 = 零网络（缺省语义与 config.federationEndpoint 同源，由调用方喂） */
  endpoint?: string;
  /** 差分隐私 ε（透传 mint；config.federationEpsilon 由调用方喂） */
  epsilon?: number;
  /** 远端份额上限（透传 apply；config.federationMaxRemoteShare 由调用方喂） */
  maxRemoteShare?: number;
  /** 信任源 id（缺省用 endpoint 立账 —— 端点即源） */
  sourceId?: string;
  /** 种子（缺省由 now 派生 ⇒ 每次同步噪声独立，跨次上传不复用同一噪声流） */
  seed?: number;
  /** 时钟注入 */
  now?: () => number;
  /** fetch 注入（null = 显式禁用网络；缺省用全局 fetch —— endpoint 空时永不触达） */
  fetchImpl?: FederationFetch | null;
  /** 账本注入（缺省全局 evidenceLedger 单例；测试自铸实例隔离） */
  ledger?: (FederationLedgerView & FederationLedgerTarget) | null;
  /**
   * 纪元 Μ2：拜占庭鲁棒联邦（true ⇒ 响应的多源原始摘要经 robustMergeDigests 本地
   * 逐格中位数聚合 —— 数学执法代替对聚合端的信任；远端检疫票折算 regressed 记到
   * endpoint 信任账，先检疫后掺入）。缺省 false = Μ 旧行为逐字节（响应的预合并
   * 摘要经 mergeDigests 语义直接掺入）；生产工具面（federationTools 的 sync 动作）
   * 缺省传 true —— D-B6 的投产落点。
   */
  robust?: boolean;
  /**
   * W6R-A5：聚合端共享密钥（HMAC 请求签名）。缺省读 FEDERATION_AUTH_ENV 环境变量
   * （DSH_FEDERATION_TOKEN）；非空 ⇒ 每次上行附 x-dsh-fed-timestamp +
   * x-dsh-fed-signature（见 federationAuthHeaders）；'' ⇒ 显式不签（open 端点）；
   * null ⇒ 显式禁用（即使 env 在场也不签 —— 测试/诊断缝）。
   */
  authToken?: string | null;
}

/** 同步结果（settled 是网络旁路的 settle 钩：生产 fire-and-forget 忽略，测试 await 用） */
export interface FederationSyncResult {
  /** 本地摘要铸造成功即 true（网络是旁路增益 —— 失败不减损本地荣誉） */
  ok: boolean;
  digest: EvidenceDigest | null;
  /** off = 零网络（endpoint 空）；fired = 已发出（应用结果看 applied）；failed = 网络臂诚实降级 */
  network: 'off' | 'fired' | 'failed';
  endpoint: string;
  /** 响应摘要的掺入报告（settled resolve 后填充；无可用响应 ⇒ null） */
  applied: FederatedApplyReport | null;
  /** 消毒后的网络错误注记（首行、200 字符、endpoint 原文已脱敏） */
  error?: string;
  /**
   * 纪元 Μ2 鲁棒臂的合并报告（仅 robust:true 且网络臂实际聚合了多源时填充；
   * legacy 路径该字段缺席 —— Μ 旧结果形状逐字节不变）。
   */
  robust?: {
    method: 'median' | 'mean' | 'single' | 'none';
    mergedFrom: number;
    /** 源标签 → 检疫票数（'local' = 本机摘要；'remote-N' = 响应第 N 份） */
    quarantined: Record<string, number>;
    excluded: number[];
  };
  settled: Promise<void>;
}

/** 上次同步的记忆（'status' 动作消费；防御副本外发） */
export interface FederationSyncStatus {
  at: number;
  network: 'off' | 'fired' | 'failed';
  applied: number;
  note?: string;
}

let lastSync: FederationSyncStatus | null = null;

/** 上次同步状态（null = 尚未同步过 —— 诚实面，不臆造） */
export function lastFederationSync(): FederationSyncStatus | null {
  return lastSync ? { ...lastSync } : null;
}

/** 网络错误消毒：只留首行 200 字符；endpoint 原文（可能带凭据）替换为 <endpoint>（密钥卫生） */
function sanitizeNetError(e: unknown, endpoint: string): string {
  try {
    let msg = String((e as { message?: unknown } | null)?.message ?? e ?? 'network error');
    msg = String(msg).split(/[\r\n]+/)[0].slice(0, 200);
    if (endpoint !== '') {
      while (msg.includes(endpoint)) msg = msg.split(endpoint).join('<endpoint>');
    }
    return msg === '' ? 'network error' : msg;
  } catch {
    return 'network error';
  }
}

/** 响应载荷 → 摘要：取 payload.digest（或 payload 本身），形状+版本核验过关才收 */
function extractDigest(payload: unknown): EvidenceDigest | null {
  try {
    const cand = (payload && typeof payload === 'object' && !Array.isArray(payload) &&
      (payload as { digest?: unknown }).digest && typeof (payload as { digest: unknown }).digest === 'object')
      ? (payload as { digest: unknown }).digest
      : payload;
    if (!cand || typeof cand !== 'object' || Array.isArray(cand)) return null;
    const c = cand as Partial<EvidenceDigest>;
    if (c.v !== DIGEST_VERSION || !Array.isArray(c.keys)) return null;
    return c as EvidenceDigest;
  } catch {
    return null;
  }
}

/**
 * 响应载荷 → 多源原始摘要表（纪元 Μ2 鲁棒臂的专用入口）：只收 payload.digests
 * 数组（或 payload 本身为数组）里的**原始摘要**，逐件形状+版本核验，坏件静默剔除。
 * 信任模型与 legacy 臂的分野：鲁棒臂不接受预合并结果（payload.digest 单件）——
 * 「谁合并」必须发生在本地（数学执法代替对聚合端的信任）；参考聚合端
 * （scripts/federation-server.mjs）因此同时回带 digests 原始数组。
 */
function extractDigestList(payload: unknown): EvidenceDigest[] {
  try {
    const list =
      payload && typeof payload === 'object' && Array.isArray((payload as { digests?: unknown }).digests)
        ? (payload as { digests: unknown[] }).digests
        : Array.isArray(payload)
          ? payload
          : [];
    const out: EvidenceDigest[] = [];
    for (const cand of list) {
      if (!cand || typeof cand !== 'object' || Array.isArray(cand)) continue;
      const c = cand as Partial<EvidenceDigest>;
      if (c.v !== DIGEST_VERSION || !Array.isArray(c.keys)) continue;
      out.push(c as EvidenceDigest);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 联邦同步（绝不抛）：
 *   ① 铸摘要：从（注入或缺省全局的）evidenceLedger 铸 DP 摘要；铸造失败 ⇒ 诚实
 *      返回 ok:false（零网络、零应用，宿主无感）；
 *   ② endpoint 空 ⇒ **零网络**：不构造 fetch、不建 AbortSignal —— 仅返回本地摘要
 *      （多进程/测试手递手用：mergeDigests + applyFederatedEvidence 自行组网）；
 *   ③ endpoint 非空 ⇒ fire-and-forget POST（swarm.fireUpload 同律：单次不重试、
 *      AbortSignal.timeout(5s)、错误消毒；上行载荷**只有摘要** —— 零截图零文本
 *      零键，绝不泄摘要外的信息）。响应含合并摘要 ⇒ applyFederatedEvidence 掺入
 *      （sourceId 缺省 = endpoint，信任账自动立账）。
 * settled 永不 reject（网络臂全程 try/catch —— 联邦是旁路义务，不是主路债主）。
 */
export function federationSync(opts: FederationSyncOptions = {}): FederationSyncResult {
  let nowMs = Date.now();
  if (typeof opts.now === 'function') {
    try {
      const t = opts.now();
      if (Number.isFinite(t)) nowMs = t;
    } catch {
      /* 时钟故障保持 Date.now */
    }
  }
  const endpoint = typeof opts.endpoint === 'string' ? opts.endpoint : '';
  const ledger = opts.ledger ?? evidenceLedger; // 缺省全局单例；可注入（测试/多账本）
  // 种子：给定用给定；缺省由 now 派生 —— 每次同步的噪声流独立（DP 的跨次纪律）
  const seed = typeof opts.seed === 'number' && Number.isFinite(opts.seed) ? opts.seed : nowMs >>> 0;
  const digest = mintEvidenceDigest(ledger, { epsilon: opts.epsilon, seed, now: () => nowMs });
  const result: FederationSyncResult = {
    ok: digest !== null,
    digest,
    network: 'off',
    endpoint,
    applied: null,
    settled: Promise.resolve(),
  };
  if (digest === null) {
    lastSync = { at: nowMs, network: 'off', applied: 0, note: '本地摘要铸造失败（账本视图非法）：零网络零应用' };
    return result;
  }
  if (endpoint === '') {
    // 零网络缺省：连 fetch 引用都不取（Μ-4 的 spy 面必须零调用）
    lastSync = { at: nowMs, network: 'off', applied: 0, note: 'endpoint 空：零网络，仅返回本地摘要' };
    return result;
  }
  // 网络臂：fetch 注入优先（null = 显式禁用），缺省全局 fetch（缺席 ⇒ 诚实降级）
  let fetchFn: FederationFetch | null = null;
  if (typeof opts.fetchImpl === 'function') fetchFn = opts.fetchImpl;
  else if (opts.fetchImpl === null) fetchFn = null;
  else if (typeof fetch === 'function') fetchFn = fetch as unknown as FederationFetch;
  if (!fetchFn) {
    result.network = 'failed';
    result.error = 'fetch 不可用（运行时无网络能力）：本地摘要已铸，诚实降级';
    lastSync = { at: nowMs, network: 'failed', applied: 0, note: result.error };
    return result;
  }
  result.network = 'fired';
  const body = JSON.stringify(digest); // 上行载荷只有摘要（密钥卫生：无凭据无文本无截图）
  // W6R-A5：共享密钥在场 ⇒ 附 HMAC 签名头（token 绝不进载荷 —— 只发派生签名）
  const authHeaders = federationAuthHeaders(body, resolveFederationAuthToken(opts.authToken), nowMs);
  result.settled = (async () => {
    try {
      const res = await fetchFn(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body,
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(FEDERATION_TIMEOUT_MS)
          : undefined,
      });
      let payload: unknown = null;
      try {
        payload = await res?.json?.();
      } catch {
        payload = null; // 响应体坏 JSON：按无合并摘要处理（不炸、不掺）
      }
      if (opts.robust === true) {
        // ── Μ2 鲁棒臂：只收多源原始摘要，本地逐格中位数聚合（数学执法代替对聚合端的信任）──
        const remotes = extractDigestList(payload);
        if (remotes.length === 0) {
          lastSync = { at: nowMs, network: 'fired', applied: 0, note: '响应不含可用的多源摘要（鲁棒臂只收 digests 原始数组）：只上传未掺入' };
        } else {
          // 本机摘要作为第一源参与聚合（中位数对本机+诚实同侪有结构性保护 —— 毒未过半即被隔离）
          const rr = robustMergeDigests([digest as EvidenceDigest, ...remotes], {
            sourceIds: ['local', ...remotes.map((_, idx) => `remote-${idx}`)],
          });
          // 检疫有牙齿（先检疫后掺入 —— 同一轮就咬合）：远端源的检疫票折算 regressed 记到
          // endpoint 账上（端点为它交出的每一份摘要集体负责 —— 激励端点清洗毒源；
          // 'local' 的票不喂账：本机偏离共识是本机校准自己的事，诚实注记在 robust 报告里）
          let remoteVotes = 0;
          for (const [label, votes] of Object.entries(rr.quarantined)) {
            if (label !== 'local') remoteVotes += votes;
          }
          if (remoteVotes > 0) applyQuarantineToTrust({ [endpoint]: remoteVotes }, recordFederationTrust);
          if (rr.merged !== null) {
            const report = applyFederatedEvidence(ledger, rr.merged, {
              maxRemoteShare: opts.maxRemoteShare,
              sourceId: typeof opts.sourceId === 'string' && opts.sourceId !== '' ? opts.sourceId : endpoint,
              now: () => nowMs,
            });
            result.applied = report;
            result.robust = {
              method: rr.method,
              mergedFrom: rr.merged.mergedFrom,
              quarantined: rr.quarantined,
              excluded: rr.excluded,
            };
            lastSync = {
              at: nowMs,
              network: 'fired',
              applied: report.applied,
              note: report.ok ? undefined : `鲁棒合并摘要掺入被拒：${report.notes[0] ?? '原因未注记'}`,
            };
          } else {
            lastSync = { at: nowMs, network: 'fired', applied: 0, note: '鲁棒合并零有效源：只上传未掺入' };
          }
        }
      } else {
        const candidate = extractDigest(payload);
        if (candidate !== null) {
          const report = applyFederatedEvidence(ledger, candidate, {
            maxRemoteShare: opts.maxRemoteShare,
            sourceId: typeof opts.sourceId === 'string' && opts.sourceId !== '' ? opts.sourceId : endpoint,
            now: () => nowMs,
          });
          result.applied = report;
          lastSync = {
            at: nowMs,
            network: 'fired',
            applied: report.applied,
            note: report.ok ? undefined : `响应摘要掺入被拒：${report.notes[0] ?? '原因未注记'}`,
          };
        } else {
          lastSync = { at: nowMs, network: 'fired', applied: 0, note: '响应不含可用的合并摘要：只上传未掺入' };
        }
      }
    } catch (e) {
      // 网络失败静默降级（swarm.fireUpload 同律）—— 但状态面留消毒注记供 status 观察
      result.network = 'failed';
      result.error = sanitizeNetError(e, endpoint);
      lastSync = { at: nowMs, network: 'failed', applied: 0, note: result.error };
    }
  })();
  return result;
}

// W9-3：联邦运行时复位的同步侧（index.resetFederationRuntime 调用 —— lastSync 是
// 本模块私有记忆，复位须经此门；与原文件内联语义逐字节一致）。
export function resetLastSync(): void {
  lastSync = null;
}
