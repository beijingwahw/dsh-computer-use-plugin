// src/federation/sync.ts
// W9-3（D-F4 拆分·传输分区）：自 federation/index.ts 低风险提取 —— W6R-A5 聚合
// 端共享密钥认证（HMAC 请求签名 + 防重放）+ Μ-e 同步 federationSync（网络纪律的
// 落点：fire-and-forget POST / 鲁棒臂本地聚合 / 状态记忆）。逐字节搬运（零逻辑
// 变更）；index.ts 原位再导出 —— 导入面不变（消费方零改动）。
// ΠΑΝ-70（DP 种子密钥派生）：缺省种子不再 = nowMs >>> 0（mintedAt 公开 ⇒ 种子
// 可从摘要自身完整重构 —— Laplace 隐私实际为零）。改 HMAC 派生：seed =
// HMAC-SHA256(K_fed, digest_id)，K_fed = 显式注入 / env DSH_FED_DP_KEY 的本地
// 长期密钥，digest_id 绑定（时刻 + 进程内序号 + endpoint）；密钥缺席且无显式
// 种子 ⇒ 诚实拒绝 mint（fail-closed —— 绝不退化为公开可推的旧种子）。ε 越界
//（≤0/非有限/超单次上限）在 sync 入口即拒（config.federationEpsilon 的范围
// 校验对接点 = digest.validFederationEpsilon）。
// ΠΑΝ-71（预算主体）：mint 记账主体 = endpoint（离线 'local'）—— digest 侧按
// 「主体 # 键」开账，滑窗内容变化不再换账（组合律见 digest.ts 节首）。
// ΠΑΝ-72（检疫账对齐）：签名路径的掺入信任按**参与合并的指纹账**取最弱链
//（min）—— 检疫票记 endpoint#指纹账、配额闸查同一账（旧律查裸 endpoint 账：
// 裸账 3 轮毕业恒 1.0，指纹票的折减没有任何闸门消费）；applied 只记指纹账。
// ΠΑΝ-74（新鲜度与撤销）：远端摘要 mintedAt 过期（> FEDERATION_DIGEST_TTL_MS）
// /无时间锚 ⇒ 剔除计数（staleSources）；本地撤销表（trust.ts 的 revocation
// list，可落盘）命中的源/端点 ⇒ 剔除计数（revokedSources）；名册学习加饱和
//（federationMaxRemotes —— 已知客户端数封顶 KNOWN_CLIENT_ROSTER_SATURATION，
// 攻击者换钥撑大名册不再放松止血限额①）。
import {
  createHash, createHmac, createPrivateKey, createPublicKey, randomUUID,
  sign as ed25519Sign, verify as ed25519Verify,
  type KeyObject,
} from 'node:crypto';
import { evidenceLedger } from '../kernel/registry';
// ΠΑΝ-49：canonical 单源消费（canonicalFederationJson 的实现体 —— 见该函数注释）
import { canonicalJson } from '../dialects';
import { robustMergeDigests, applyQuarantineToTrust } from './aggregate';
import {
  DIGEST_VERSION, FEDERATION_TIMEOUT_MS, mintEvidenceDigest, validFederationEpsilon,
  type EvidenceDigest, type FederationLedgerView,
} from './digest';
import {
  applyFederatedEvidence, FEDERATION_DIGEST_TTL_MS, FEDERATION_FRESHNESS_SKEW_MS,
  type FederationLedgerTarget, type FederatedApplyReport,
} from './apply';
import {
  federationFingerprintSourceId, recordFederationTrust, federationTrustOf,
  isFederationSourceRevoked,
} from './trust';

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

// ΤΕΛ-6（D-G29）：ΠΑΝ-88 推荐协议 v2 的一次性 nonce 头。模块私有（不导出）——
// 头字面量与 scripts/federation-server.mjs 的 AUTH_NONCE_HEADER 同串（双端口径
// 由测试把守，同 FEDERATION_AUTH_ENV 族先例）；消费面全部在本文件内
// （federationAuthHeaders 的 v2 臂 + federationSync 的 mint 臂）。
const FEDERATION_AUTH_NONCE_HEADER = 'x-dsh-fed-nonce';

/**
 * 签名头铸造（纯函数、绝不抛）：token 非空字符串 ⇒ { 时间戳头, 签名头 }；否则 {}
 * （open 客户端零头 —— 服务端 open 模式照收，token 模式 401 诚实降级）。签名输入
 * `${timestamp}.${body}`：body 恒以 { 开头（JSON 对象）⇒ 分隔符无歧义。crypto
 * 故障 ⇒ {}（多掩蔽方向：宁可不发签名被拒，绝不发可伪造的弱签名）。导出为
 * 公开面 —— 测试与聚合端的等价断言共用同一实现（双端口径的唯一 TS 权威源）。
 *
 * ΤΕΛ-6（D-G29）：可选第四参 nonce —— ΠΑΝ-88 推荐协议 v2 的客户端半边（D-G29
 * 移交债收口）。非空字符串在场 ⇒ 签名输入升格 `${ts}.${nonce}.${body}` 并附
 * x-dsh-fed-nonce 头（服务端窗内按 nonce 本身重放拒绝——截获原样重放不再可行）；
 * 缺席/null/空串 ⇒ v1 既有面逐字节（`${ts}.${body}` 双头，向后兼容——「v1 客户端
 * 零变化可用」是 ΠΑΝ-88 的明示兼容承诺）。nonce 长度与服务端同域 [8,128]：域外值
 * 按缺席消毒为 v1（服务端 malformed-nonce 必 401 —— 绝不发自知会被拒的弱头）。
 */
export function federationAuthHeaders(
  body: string,
  token: unknown,
  nowMs: number,
  nonce?: string | null,
): Record<string, string> {
  try {
    if (typeof token !== 'string' || token === '') return {};
    const ts = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
    // ΤΕΛ-6（D-G29）：nonce 消毒 —— 非字符串/空串/服务端长度域外一律按 v1（缺席）
    const n = typeof nonce === 'string' && nonce.length >= 8 && nonce.length <= 128 ? nonce : null;
    const sig = n === null
      ? createHmac('sha256', token).update(`${ts}.${body}`).digest('hex')
      : createHmac('sha256', token).update(`${ts}.${n}.${body}`).digest('hex');
    const headers: Record<string, string> = {
      [FEDERATION_AUTH_TIMESTAMP_HEADER]: String(ts),
      [FEDERATION_AUTH_SIGNATURE_HEADER]: sig,
    };
    if (n !== null) headers[FEDERATION_AUTH_NONCE_HEADER] = n;
    return headers;
  } catch {
    return {}; // 绝不抛纪律：签名失败 = 无头（服务端 401 = 诚实降级）
  }
}

/**
 * ΤΕΛ-6（D-G29）：v2 nonce 铸造（模块私有，绝不抛）。opts.authNonce === true ⇒
 * 每次上行铸一次性 randomUUID（128bit 熵，服务端 [8,128] 长度域内）；字符串注入
 * = 部署/测试钉面（显式指定 nonce，域外值降级 v1）；false/缺省 ⇒ null = v1。
 * 铸造失败（极端环境）⇒ null 诚实降级 v1 —— 绝不因 nonce 缺席阻断同步（v1 是
 * ΠΑΝ-88 明示的合法兼容面），也绝不发空/短 nonce 的弱 v2 头。
 */
function mintFederationNonce(opt: boolean | string | undefined): string | null {
  if (typeof opt === 'string') return opt.length >= 8 && opt.length <= 128 ? opt : null;
  if (opt !== true) return null;
  try {
    return randomUUID();
  } catch {
    return null; // 铸造缺席 ⇒ v1（诚实降级，绝不抛）
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


// ─── ΝΩ-19（联邦逐源签名）：Ed25519 客户端签名 + 指纹粒度信任 ───
//
// 缝隙（本工单立意）：robust 臂把响应 payload.digests 逐件收为 remote-0..N 源时
// 没有任何**逐源身份认证** —— 恶意聚合端可回传 5 份自造摘要 + 本机 = 6 源，假源
// 5/6 > 50% 恰好击穿逐格中位数的崩溃点；ΑΩ-R6 试用期又只压 endpoint 单账 ——
// Sybil 在 digest 层免费开号。修复三面 + 一对止血护栏：
//   · 上行：DSH_FED_SIGNING_KEY 在场 ⇒ 每份摘要附 {pubkey, sig}（Ed25519 签名域
//     = 摘要核心四域 v/mintedAt/epsilon/keys 的 canonical 字节 —— pubkey/sig 自身
//     不入域：签名不能签自己）；私钥绝不进载荷/日志/错误面（密钥卫生同 authToken）。
//   · 下行：逐源 Ed25519 验签，验不过按缺席剔除并计数 unverifiableSources（绝不
//     混入中位数）。无签名的旧格式源诚实降级为 unverifiable：无身份的源在中位数
//     攻击面下不值得信任（迁移期部署需聚合端与客户端同步升级 —— 聚合端只中继不
//     剥签名域，见 scripts/federation-server.mjs；这是显式设计取舍，不是疏漏）。
//   · 账本：检疫票/试用期记到 `endpoint#指纹` 账（federationFingerprintSourceId）
//     —— ΑΩ-R6 平移到正确主体粒度：真实客户端的毒摘要把票记到该客户端自己的
//     账上，端点不再为伪造的"集体"背锅；裸 endpoint 键（旧档/掺入侧累计账）照常
//     共存（键是自由字符串，持久化 schema 不动 —— 旧档零迁移）。
//   · 止血护栏（签名链路内的额外防线，非根治 —— 根治在验签：伪造者必须持有每个
//     假源的 Ed25519 私钥）：①响应源数上限「本地已知客户端数×2+4」—— 一阶
//     Sybil 洪泛的成本面；②mintedAt 同毫秒批量特征整组剔除 —— 同一毫秒铸造的
//     多份"独立源"是批量假摘要的一阶特征。
//   · 零回归律：未配置密钥（env 与注入皆空/非法）⇒ 上行不签、下行不验、账键不动
//     —— 与旧路径逐字节一致（Μ2-5/Μ-4/Μ-8 的既有断言原样保绿）；非法密钥 = 诚实
//     关闭整条链路并一次性警示（绝不半开：上行签、下行不验的半开态比关闭更危险）。

/** 客户端签名密钥环境变量名（pkcs8/base64、32 字节 seed 的 base64 或 PEM —— 协议契约字面量） */
export const FEDERATION_SIGNING_KEY_ENV = 'DSH_FED_SIGNING_KEY';

/** Ed25519 32 字节 seed 的 PKCS8 DER 包装前缀（固定字面量 —— Ed25519 的 DER 形是确定性的） */
const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SEED_BYTES = 32; // Ed25519 私钥 seed 长度（RFC 8032 固定值，非阈值）

/** 带签摘要：摘要本体 + 签名者公钥与签名（聚合端原样转发，接收方逐源验签） */
export interface SignedEvidenceDigest extends EvidenceDigest {
  /** 签名者公钥（base64 SPKI —— 验签与指纹的原料） */
  pubkey: string;
  /** Ed25519 签名（base64 —— 签名域 = 核心四域 canonical 字节） */
  sig: string;
}

/** 客户端签名身份（指纹粒度信任账的原料；私钥永不外发） */
export interface FederationSigningIdentity {
  /** 客户端指纹 = sha256(公钥 SPKI 字节) 前 16 hex */
  fingerprint: string;
  /** 公钥（base64 SPKI —— 随摘要上行的就是它） */
  publicKey: string;
}

/**
 * ΝΩ-19：稳定 canonical 序列化 —— ΠΑΝ-49 起收编为 dialects/canonical.ts 单源
 *（原为 notary/primitives.ts canonical 的本地同律镜像；复刻律因 C1-9 H1 实证
 * 漂移退役 —— 逐字节一致的前提只能靠单源，不能靠复刻纪律）。
 * 签名域字节唯一性的根基：同一摘要无论经谁的 JSON 序列化（键序任意）往返，canonical
 * 字节恒同 —— 验签不因传输层键序漂移而误红。病态载荷（超深/真环）⇒ 哨兵降级
 *（单源 ΝΩ-24 守卫 —— 旧形态循环引用无限递归）；BigInt/硬拒值照实抛（调用方全兜）。
 */
export function canonicalFederationJson(value: unknown): string {
  return canonicalJson(value);
}

/**
 * 摘要签名域字节 = 核心四域（v/mintedAt/epsilon/keys）的 canonical 序列化（ΝΩ-19：
 * pubkey/sig 不入域）。形状非法（含陷阱属性）⇒ null（绝不抛 —— 坏输入没有签名资格）。
 */
function digestSigningDomainBytes(d: unknown): Buffer | null {
  try {
    if (!d || typeof d !== 'object') return null;
    const e = d as { v?: unknown; mintedAt?: unknown; epsilon?: unknown; keys?: unknown };
    if (
      typeof e.v !== 'number' || typeof e.mintedAt !== 'number' ||
      typeof e.epsilon !== 'number' || !Array.isArray(e.keys)
    ) {
      return null;
    }
    return Buffer.from(
      canonicalFederationJson({ v: e.v, mintedAt: e.mintedAt, epsilon: e.epsilon, keys: e.keys }),
      'utf8',
    );
  } catch {
    return null;
  }
}

/** 解析后的签名密钥（identity + 私钥句柄 —— 模块内部面，私钥绝不外发） */
interface ResolvedSigningKey {
  identity: FederationSigningIdentity;
  privateKey: KeyObject;
}

/** Ed25519 私钥解析（seed / pkcs8-base64 / PEM 三形态；非 Ed25519 或垃圾 ⇒ null，绝不抛） */
function parseEd25519PrivateKey(material: string): KeyObject | null {
  try {
    const trimmed = material.trim();
    if (trimmed === '') return null;
    if (trimmed.startsWith('-----')) return createPrivateKey({ key: trimmed, format: 'pem' });
    const der = Buffer.from(trimmed, 'base64');
    if (der.length === ED25519_SEED_BYTES) { // ΝΩ 收官（magic-number 清偿）：Ed25519 原生 seed 恰 32 字节
      // 32 字节 seed ⇒ 固定 PKCS8 前缀包装成 DER 私钥（Ed25519 的 OID 唯一）
      return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, der]), format: 'der', type: 'pkcs8' });
    }
    return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } catch {
    return null;
  }
}

/** 签名密钥解析缓存（键 = 密钥原文 —— 逐次 sync 免重解析；resetLastSync 复位） */
let signingKeyCache: { material: string; resolved: ResolvedSigningKey | null } | null = null;

/** 解析签名密钥（缓存制；material 空/非法/非 Ed25519 ⇒ null，绝不抛） */
function resolveFederationSigningKey(material: string): ResolvedSigningKey | null {
  if (material === '') return null;
  if (signingKeyCache !== null && signingKeyCache.material === material) return signingKeyCache.resolved;
  let resolved: ResolvedSigningKey | null = null;
  const priv = parseEd25519PrivateKey(material);
  if (priv !== null && priv.asymmetricKeyType === 'ed25519') {
    try {
      const spki = createPublicKey(priv).export({ format: 'der', type: 'spki' }) as Buffer;
      resolved = {
        identity: {
          fingerprint: createHash('sha256').update(spki).digest('hex').slice(0, 16),
          publicKey: spki.toString('base64'),
        },
        privateKey: priv,
      };
    } catch {
      resolved = null;
    }
  }
  signingKeyCache = { material, resolved };
  return resolved;
}

/** 解析签名密钥原料：显式注入优先（'' = 显式禁用）；缺省读 env（未配置 ⇒ 空 = 旧路径） */
function resolveFederationSigningKeyMaterial(explicit: string | null | undefined): string {
  if (typeof explicit === 'string') return explicit;
  if (explicit === null) return '';
  try {
    const v = process.env[FEDERATION_SIGNING_KEY_ENV];
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

/**
 * 客户端签名身份（绝不抛）：密钥合法 ⇒ { 指纹, 公钥 }；未配置/非法 ⇒ null。
 * 导出为公开面 —— 测试与运维诊断共用同一实现（指纹口径的唯一 TS 权威源）。
 */
export function federationSigningIdentity(signingKey?: string | null): FederationSigningIdentity | null {
  try {
    const resolved = resolveFederationSigningKey(resolveFederationSigningKeyMaterial(signingKey));
    return resolved === null ? null : { ...resolved.identity };
  } catch {
    return null;
  }
}

/**
 * 摘要签名（ΝΩ-19 上行面，绝不抛）：密钥在场 ⇒ 摘要附 {pubkey, sig}；密钥缺席/
 * 域形状非法/签名故障 ⇒ null（调用方诚实降级发未签件 —— 服务端照收，本地不炸，
 * 绝不带可伪造的弱签名上路）。
 */
export function signEvidenceDigest(
  digest: EvidenceDigest,
  signingKey?: string | null,
): SignedEvidenceDigest | null {
  try {
    const resolved = resolveFederationSigningKey(resolveFederationSigningKeyMaterial(signingKey));
    if (resolved === null) return null;
    const domain = digestSigningDomainBytes(digest);
    if (domain === null) return null;
    const sig = ed25519Sign(null, domain, resolved.privateKey).toString('base64');
    return { ...digest, pubkey: resolved.identity.publicKey, sig };
  } catch {
    return null;
  }
}

/** 逐源验签结论（reason 供审计注记 —— 不进判据） */
export interface FederationSignatureVerdict {
  ok: boolean;
  /** ok=true 时的签名者指纹（endpoint#指纹 账键的原料）；否则 null */
  fingerprint: string | null;
  reason?: 'missing-signature' | 'bad-signature' | 'bad-key' | 'malformed';
}

/**
 * 逐源验签（ΝΩ-19 下行面，纯函数、绝不抛、含陷阱属性隔离）：pubkey+sig 在场且
 * Ed25519 验签成立 ⇒ ok + 指纹。无签名（旧格式源）⇒ missing-signature —— 诚实
 * 降级为 unverifiable：无身份的源在中位数攻击面下不值得信任（迁移期需聚合端与
 * 客户端同步升级，见节首注记）；坏公钥/坏签名/畸形 ⇒ 对应归因。指纹对 SPKI DER
 * 字节取 sha256 前 16 hex（与客户端侧同口径 —— 双面同律由测试把守）。
 */
export function verifyEvidenceDigestSignature(entry: unknown): FederationSignatureVerdict {
  try {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, fingerprint: null, reason: 'malformed' };
    }
    const e = entry as { pubkey?: unknown; sig?: unknown };
    if (typeof e.pubkey !== 'string' || e.pubkey === '' || typeof e.sig !== 'string' || e.sig === '') {
      return { ok: false, fingerprint: null, reason: 'missing-signature' }; // 无签名旧格式：无身份 ⇒ 不可信
    }
    const spki = Buffer.from(e.pubkey, 'base64');
    const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    if (pub.asymmetricKeyType !== 'ed25519') return { ok: false, fingerprint: null, reason: 'bad-key' };
    const domain = digestSigningDomainBytes(entry);
    if (domain === null) return { ok: false, fingerprint: null, reason: 'malformed' };
    const sigOk = ed25519Verify(null, domain, pub, Buffer.from(e.sig, 'base64'));
    if (!sigOk) return { ok: false, fingerprint: null, reason: 'bad-signature' };
    return { ok: true, fingerprint: createHash('sha256').update(spki).digest('hex').slice(0, 16) };
  } catch {
    return { ok: false, fingerprint: null, reason: 'malformed' };
  }
}

/**
 * 一次性密钥生成命令（运维辅助 —— 无 key 时控制台提示用；纯函数零状态）。
 * 提示面：logFederationSigningKeyHint（每进程至多一次）。
 */
export function federationSigningKeyHint(): string {
  return `node -e "console.log('export ${FEDERATION_SIGNING_KEY_ENV}=' + require('node:crypto').randomBytes(32).toString('base64'))"`;
}

/** 无 key 一次性提示旗（每进程至多一次） */
let signingHintLogged = false;

/** 无 key 提示（每进程至多一次；绝不抛）：同侪已升级而本机未配钥的迁移期哨兵 */
export function logFederationSigningKeyHint(): void {
  try {
    if (signingHintLogged) return;
    signingHintLogged = true;
    console.info(
      `[dsh-federation] ${FEDERATION_SIGNING_KEY_ENV} 未配置：联邦逐源签名链路关闭（ΝΩ-19）。一次性生成：${federationSigningKeyHint()}`,
    );
  } catch {
    /* 绝不抛 */
  }
}

/** 非法密钥一次性警示旗（诚实可见，不静默猜） */
let badSigningKeyWarned = false;

/** 已知客户端指纹名册（止血限额①的基数 —— 只学经验签+护栏存活的指纹；resetLastSync 复位） */
const knownClientFingerprints = new Set<string>();

/** 远端件是否携带签名域（迁移期哨兵的判据 —— 只看面不验签，零开销） */
function digestCarriesSignature(entry: unknown): boolean {
  try {
    return (
      !!entry && typeof entry === 'object' && !Array.isArray(entry) &&
      typeof (entry as { pubkey?: unknown }).pubkey === 'string' &&
      (entry as { pubkey: string }).pubkey !== ''
    );
  } catch {
    return false;
  }
}

// ─── ΠΑΝ-70（DP 种子密钥派生）：本地长期密钥 K_fed + HMAC 种子 ───
//
// 缝隙（C2-1 F1）：旧律缺省种子 = `nowMs >>> 0`，而 mint 把同一个 nowMs 写进
// 摘要的公开域 mintedAt —— **种子与 mintedAt 是同一个数**。mulberry32 是无密钥
// 确定性 PRNG：收到摘要的聚合端与任何同侪都能取 `seed = mintedAt >>> 0` 重放噪声
// 流，用纯函数 laplaceNoise 逐一减去噪声，精确还原真值直方图与真值 n —— Laplace
// 机制的全部隐私保证依赖噪声不可预测，预算账本记的是一个不存在的保证。
// 修复律：
//   · 种子 = HMAC-SHA256(K_fed, digest_id) 的前 32 位（digest_id = 铸造时刻 + 进程
//     内铸造序号 + endpoint —— 序号是模块私有状态，公开面推不出）；
//   · K_fed 是本地长期密钥：显式注入（opts.dpKey，测试缝）优先，缺省读 env
//     DSH_FED_DP_KEY；密钥绝不进载荷/日志/错误面（密钥卫生同 authToken）；
//   · **密钥缺席则诚实拒绝 mint**（digest = null + lastSync 如实注记）—— 绝不
//     退化为公开可推的旧种子（那等于明文出境；隐私面 fail-closed）。显式 seed
//     注入（手递手/确定性测试缝）仍可用 —— 显式种子不是公开信息，威胁模型内
//     只有「从摘要公开域推出种子」这一条路，此路已断。
//   · 附带收口（C2-1 F24）：同毫秒两次 sync ⇒ 同种子同噪声流的旧病随 digest_id
//     的铸造序号段一并消失。

/** ΠΑΝ-70：本地长期 DP 种子密钥的环境变量名（协议契约字面量） */
export const FEDERATION_DP_KEY_ENV = 'DSH_FED_DP_KEY';

/** 铸造序号（digest_id 的私有随机性段 —— 模块级单调计数，公开面推不出） */
let mintSequence = 0n;

/** 解析 DP 种子密钥原料：显式注入优先（'' / null = 显式无钥）；缺省读 env */
function resolveFederationDpKeyMaterial(explicit: string | null | undefined): string {
  if (typeof explicit === 'string') return explicit;
  if (explicit === null) return '';
  try {
    const v = process.env[FEDERATION_DP_KEY_ENV];
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

/**
 * ΠΑΝ-70：HMAC 派生种子（纯函数、绝不抛）：seed = readUInt32BE(
 * HMAC-SHA256(K_fed, digest_id)[0..4] )。digest_id 绑定本次铸造（时刻 + 进程内
 * 序号 + endpoint）—— 序号段保证同毫秒不同铸、密钥保证公开面（mintedAt/载荷
 * 全量）推不出种子。密钥缺席 ⇒ null（调用方诚实拒绝，不退化）。导出为公开面：
 * 「种子不可从公开面推出」的执法测试与运维诊断共用同一实现。
 */
export function federationDpSeed(dpKey: string, digestId: string): number | null {
  try {
    if (typeof dpKey !== 'string' || dpKey === '') return null;
    if (typeof digestId !== 'string') return null;
    return createHmac('sha256', dpKey).update(digestId).digest().readUInt32BE(0);
  } catch {
    return null;
  }
}

// ─── ΠΑΝ-74（新鲜度与撤销）：远端摘要的新鲜度过滤 + 名册饱和 ───

/**
 * ΠΑΝ-74：远端摘要新鲜度过滤（纯函数、绝不抛）：mintedAt 缺席/非法/超 TTL 的
 * 件按缺席剔除（新鲜度不可判 = 没有掺入资格，fail-closed）。**未来锚同拒**：
 * `now − t` 为负会使 TTL 检查恒过 —— 恶意源把 mintedAt 定到远未来即得「永不过期」
 * 的重放件；容差 = FEDERATION_FRESHNESS_SKEW_MS（时钟偏移容忍，apply 侧同律）。
 * 在验签**之前**执行 —— 便宜的数值检查先挡旧摘要洪泛（对恶意聚合端的 Ed25519
 * 验签 CPU 面也是一道前置闸）。
 */
function filterFreshRemotes(remotes: EvidenceDigest[], nowMs: number): { kept: EvidenceDigest[]; stale: number } {
  const kept: EvidenceDigest[] = [];
  let stale = 0;
  for (const d of remotes) {
    const t = (d as Partial<EvidenceDigest>).mintedAt;
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || nowMs - t > FEDERATION_DIGEST_TTL_MS) {
      stale += 1;
      continue;
    }
    if (t > nowMs + FEDERATION_FRESHNESS_SKEW_MS) {
      stale += 1; // ΠΑΝ-74：未来锚（超容差）—— 新鲜度不可判，同拒
      continue;
    }
    kept.push(d);
  }
  return { kept, stale };
}

/**
 * ΠΑΝ-74：止血限额①的饱和律（纯函数）—— 名册学习不再放松 maxRemotes：
 * `maxRemotes = min(已知客户端数, ROSTER_SATURATION) × 2 + 4`。旧律已知客户端
 * 只增不减 ⇒ 攻击者批量换钥即可把名册撑大、自我放松限额（护栏的一阶性质被
 * 名册增长对冲）；饱和后新指纹不再抬高上限（封顶 32×2+4 = 68 —— 真实联邦
// 规模之上、Sybil 洪泛成本面之下的冻结值）。
 */
export const KNOWN_CLIENT_ROSTER_SATURATION = 32;

/** ΠΑΝ-74：名册记忆容量上界（满员停学 —— 内存有界；不逐出：逐出会重置既有指纹的已知性） */
export const KNOWN_CLIENT_ROSTER_CAPACITY = 256;

/** ΠΑΝ-74：源数上限的饱和计算（纯函数、绝不抛 —— 测试与 sync 共用唯一权威源） */
export function federationMaxRemotes(knownClients: number): number {
  const k = typeof knownClients === 'number' && Number.isFinite(knownClients) && knownClients > 0 ? Math.floor(knownClients) : 0;
  return Math.min(k, KNOWN_CLIENT_ROSTER_SATURATION) * 2 + 4;
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
   *（DSH_FEDERATION_TOKEN）；非空 ⇒ 每次上行附 x-dsh-fed-timestamp +
   * x-dsh-fed-signature（见 federationAuthHeaders）；'' ⇒ 显式不签（open 端点）；
   * null ⇒ 显式禁用（即使 env 在场也不签 —— 测试/诊断缝）。
   */
  authToken?: string | null;
  /**
   * ΤΕΛ-6（D-G29）：ΠΑΝ-88 推荐协议 v2 的客户端开关。true ⇒ 上行 HMAC 头附
   * 一次性 nonce（x-dsh-fed-nonce；签名输入 `${ts}.${nonce}.${body}` —— 服务端
   * 窗内按 nonce 本身重放拒绝）；字符串 = 显式指定 nonce（部署钉面/测试面）；
   * false/缺省 = v1 既有面逐字节（`${ts}.${body}`，向后兼容——缺省行为零漂移）。
   * nonce 铸造/消毒失败 ⇒ 诚实降级 v1（绝不阻断同步、绝不发弱 v2 头）。部署方
   * 采用 v2 只需本开关 —— 客户端半边自此齐备（D-G29 收口）。
   */
  authNonce?: boolean | string;
  /**
   * ΝΩ-19：客户端 Ed25519 签名密钥（pkcs8/base64、32 字节 seed 的 base64 或 PEM）。
   * 非空 ⇒ 上行摘要附 {pubkey, sig}、下行逐源验签（验不过 ⇒ 缺席剔除 +
   * unverifiableSources 计数，绝不混入中位数）+ 止血限额 + 指纹粒度信任账
   * （endpoint#指纹）；'' / null ⇒ 显式禁用（即使 env 在场）；缺省读
   * FEDERATION_SIGNING_KEY_ENV（未配置 ⇒ 未签名旧路径逐字节 —— 零回归律）。
   */
  signingKey?: string | null;
  /**
   * ΠΑΝ-70：本地长期 DP 种子密钥 K_fed（HMAC 种子派生的 salt）。非空 ⇒ 缺省种子
   * = HMAC-SHA256(K_fed, digest_id)（公开面推不出）；'' / null ⇒ 显式无钥；缺省
   * 读 FEDERATION_DP_KEY_ENV。**密钥与显式 seed 皆缺席 ⇒ 诚实拒绝 mint**（隐私面
   * fail-closed —— 绝不退化为旧律的 `nowMs >>> 0` 公开可推种子）。
   */
  dpKey?: string | null;
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
    /**
     * 源标签 → 检疫票数（'local' = 本机摘要；'remote-N' = 响应第 N 份；
     * ΝΩ-19 签名链路下远端标签 = endpoint#指纹 —— 与信任账同键，票直接落正确主体）。
     */
    quarantined: Record<string, number>;
    excluded: number[];
    /**
     * ΝΩ-19（签名链路独有字段，未配置密钥时缺席 —— 旧结果形状逐字节）：
     * 验签不过（含无签名旧格式源）被剔除的源数 —— 假源绝不混入中位数。
     */
    unverifiableSources?: number;
    /** ΝΩ-19：超出「本地已知客户端数×2+4」上限被拒绝的源数（止血①） */
    excessiveSources?: number;
    /** ΝΩ-19：mintedAt 同毫秒批量特征被整组剔除的源数（止血②） */
    batchedSources?: number;
    /** ΠΑΝ-74：mintedAt 过期/缺席/非法（新鲜度不可判）被剔除的源数 */
    staleSources?: number;
    /** ΠΑΝ-74：命中本地撤销表（revocation list）被剔除的源数 */
    revokedSources?: number;
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
  // ΠΑΝ-70 fail-closed（config ε 范围校验的对接点）：显式给出的 ε 越界
  // （≤0 / 非有限 / 超单次上限 PRIVACY_BUDGET_EPSILON_TOTAL）⇒ 拒绝铸造 ——
  // 绝不静默回落缺省（「配置错当没配」是隐私面的 fail-open）
  if (opts.epsilon !== undefined && !validFederationEpsilon(opts.epsilon)) {
    const note = `ε 非法（${String(opts.epsilon)}：须为 (0, 10] 的有限数）：拒绝铸造（ΠΑΝ-70 fail-closed），零网络零应用`;
    lastSync = { at: nowMs, network: 'off', applied: 0, note };
    return {
      ok: false,
      digest: null,
      network: 'off',
      endpoint,
      applied: null,
      settled: Promise.resolve(),
    };
  }
  // ΠΑΝ-70：种子三律 —— ①显式注入（手递手/确定性测试缝）用之；②否则 K_fed 在场
  // ⇒ seed = HMAC(K_fed, digest_id)（digest_id 绑定时刻+进程内序号+endpoint，
  // 公开面推不出）；③两者皆缺席 ⇒ 诚实拒绝 mint（隐私面 fail-closed —— 绝不
  // 退化为旧律的 nowMs>>>0 公开可推种子，那等于真值明文出境）
  let seed: number | null =
    typeof opts.seed === 'number' && Number.isFinite(opts.seed) ? opts.seed : null;
  if (seed === null) {
    const dpKeyMaterial = resolveFederationDpKeyMaterial(opts.dpKey);
    mintSequence += 1n;
    seed = federationDpSeed(dpKeyMaterial, `${nowMs}|${mintSequence.toString(36)}|${endpoint}`);
    if (seed === null) {
      const note = `${FEDERATION_DP_KEY_ENV} 未配置且未注入 dpKey/seed：DP 噪声种子密钥缺席，拒绝铸造（ΠΑΝ-70 fail-closed —— 绝不以公开可推种子出境），零网络零应用`;
      lastSync = { at: nowMs, network: 'off', applied: 0, note };
      return {
        ok: false,
        digest: null,
        network: 'off',
        endpoint,
        applied: null,
        settled: Promise.resolve(),
      };
    }
  }
  // ΠΑΝ-71：记账主体 = endpoint（离线手递手铸造记 'local' 账）—— 同主体同键的
  // 滑窗重叠释放组合记账（digest 侧按「主体 # 键」开账）
  const digest = mintEvidenceDigest(ledger, {
    epsilon: opts.epsilon,
    seed,
    now: () => nowMs,
    subject: endpoint !== '' ? endpoint : 'local',
  });
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
  // ΝΩ-19：客户端签名密钥解析（显式注入优先 / 缺省 env；空或非法 ⇒ null = 未签名
  // 旧路径逐字节）。非法密钥一次性控制台警示（诚实可见，不静默猜）。
  const signingMaterial = resolveFederationSigningKeyMaterial(opts.signingKey);
  const signing = signingMaterial === '' ? null : resolveFederationSigningKey(signingMaterial);
  if (signingMaterial !== '' && signing === null) {
    try {
      if (!badSigningKeyWarned) {
        badSigningKeyWarned = true;
        console.warn(
          `[dsh-federation] ${FEDERATION_SIGNING_KEY_ENV} 无法解析为 Ed25519 私钥（pkcs8/base64、32 字节 seed 的 base64 或 PEM）：逐源签名链路诚实关闭，走未签名旧路径（ΝΩ-19）`,
        );
      }
    } catch {
      /* 日志面故障不挡同步 */
    }
  }
  // ΝΩ-19：上行签名 —— 密钥在场 ⇒ 每份摘要附 {pubkey, sig}（私钥绝不进载荷）；
  // 签名故障 ⇒ 诚实降级发未签件（绝不抛、不带弱签名上路）
  const signedUplink = signing === null ? null : signEvidenceDigest(digest, signingMaterial);
  const body = JSON.stringify(signedUplink ?? digest); // 上行载荷只有摘要（密钥卫生：无凭据无文本无截图；pubkey/sig 是摘要自带域）
  // W6R-A5：共享密钥在场 ⇒ 附 HMAC 签名头（token 绝不进载荷 —— 只发派生签名）。
  // ΤΕΛ-6（D-G29）：authNonce 开 ⇒ v2 推荐协议（+x-dsh-fed-nonce，签名输入
  // `${ts}.${nonce}.${body}`）；缺省 v1 逐字节（向后兼容零漂移）。
  const authHeaders = federationAuthHeaders(
    body,
    resolveFederationAuthToken(opts.authToken),
    nowMs,
    mintFederationNonce(opts.authNonce),
  );
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
        // ΠΑΝ-74：新鲜度过滤先行（验签/聚合之前的便宜数值闸）—— mintedAt 过期/
        // 缺席/非法的远端件按缺席剔除并计数（新鲜度不可判 = 没有掺入资格）
        const { kept: freshRemotes, stale: staleSources } = filterFreshRemotes(extractDigestList(payload), nowMs);
        if (freshRemotes.length === 0) {
          lastSync = {
            at: nowMs,
            network: 'fired',
            applied: 0,
            note: freshRemotes.length === 0 && staleSources === 0
              ? '响应不含可用的多源摘要（鲁棒臂只收 digests 原始数组）：只上传未掺入'
              : `响应远端摘要全部过期/无时间锚（ΠΑΝ-74 stale=${staleSources}）：只上传未掺入`,
          };
        } else if (signing === null) {
          // ΝΩ-19：未配置签名密钥 ⇒ 旧路径（remote-N 标签 + 端点集体账）。
          // 迁移期哨兵：同侪已升级（响应带签名域）而本机未配钥 ⇒ 一次性提示生成命令
          try {
            if (freshRemotes.some(digestCarriesSignature)) logFederationSigningKeyHint();
          } catch {
            /* 提示面故障不挡同步 */
          }
          // ΠΑΝ-74：端点撤销闸（未签名臂没有指纹粒度 —— 裸 endpoint 即账键）：
          // 本地撤销表命中 ⇒ 整轮不掺入（被撤销的端点连回环掺入赚干净轮的资格都没有）
          if (isFederationSourceRevoked(endpoint) || isFederationSourceRevoked(
            typeof opts.sourceId === 'string' && opts.sourceId !== '' ? opts.sourceId : endpoint,
          )) {
            lastSync = { at: nowMs, network: 'fired', applied: 0, note: `端点命中本地撤销表（ΠΑΝ-74 revocation list）：只上传未掺入` };
            return;
          }
          // 本机摘要作为第一源参与聚合（中位数对本机+诚实同侪有结构性保护 —— 毒未过半即被隔离）
          const rr = robustMergeDigests([digest as EvidenceDigest, ...freshRemotes], {
            sourceIds: ['local', ...freshRemotes.map((_, idx) => `remote-${idx}`)],
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
              ...(staleSources > 0 ? { staleSources } : {}),
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
        } else {
          // ── ΝΩ-19 签名链路：逐源验签 → 撤销/止血护栏 → 指纹粒度账 → 本地中位数聚合 ──
          const ownFp = signing.identity.fingerprint;
          const fpAccount = (fp: string): string => federationFingerprintSourceId(endpoint, fp);
          // ①逐源验签：验不过（含无签名旧格式）按缺席剔除并计数 —— 假源绝不混入中位数
          const kept: EvidenceDigest[] = [];
          const keptFps: string[] = [];
          let unverifiableSources = 0;
          for (const d of freshRemotes) {
            const verdict = verifyEvidenceDigestSignature(d);
            if (verdict.ok && typeof verdict.fingerprint === 'string' && verdict.fingerprint !== '') {
              kept.push(d);
              keptFps.push(verdict.fingerprint);
            } else {
              unverifiableSources += 1;
            }
          }
          // ①' ΠΑΝ-74 撤销闸：验签过的源命中本地撤销表（revocation list）⇒ 按缺席
          // 剔除并计数 —— 被撤销的源连中位数都进不了（比检疫票硬一档：票是缓慢
          // 折减，撤销是立即出局）；纯指纹键与 endpoint#指纹键都查（调用方按自己
          // 的账键口径撤销，两口径都咬合）
          let revokedSources = 0;
          for (let i = kept.length - 1; i >= 0; i--) {
            const fp = keptFps[i];
            if (isFederationSourceRevoked(fp) || isFederationSourceRevoked(fpAccount(fp))) {
              revokedSources += 1;
              kept.splice(i, 1);
              keptFps.splice(i, 1);
            }
          }
          // 止血①：响应源数上限 = 本地已知客户端数（含本机）×2+4（ΠΑΝ-74 饱和律：
          // 名册学习不再放松上限 —— min(已知, ROSTER_SATURATION)×2+4，攻击者批量
          // 换钥撑大名册也抬不动限额）—— 超额源拒绝并计数
          let knownClients = knownClientFingerprints.size;
          if (!knownClientFingerprints.has(ownFp)) knownClients += 1; // 本机也是已知客户端
          const maxRemotes = federationMaxRemotes(knownClients);
          let excessiveSources = 0;
          if (kept.length > maxRemotes) {
            excessiveSources = kept.length - maxRemotes;
            kept.length = maxRemotes;
            keptFps.length = maxRemotes;
          }
          // 止血②：mintedAt 同毫秒批量特征 —— 同毫秒铸造的 ≥2 份"独立源"整组剔除并计数
          let batchedSources = 0;
          try {
            const tsCounts = new Map<number, number>();
            for (const d of kept) {
              const t = (d as Partial<EvidenceDigest>).mintedAt;
              if (typeof t === 'number' && Number.isFinite(t)) tsCounts.set(t, (tsCounts.get(t) ?? 0) + 1);
            }
            const batchedTs = new Set<number>();
            for (const [t, c] of tsCounts) if (c >= 2) batchedTs.add(t);
            if (batchedTs.size > 0) {
              const survivors: EvidenceDigest[] = [];
              const survivorFps: string[] = [];
              kept.forEach((d, i) => {
                const t = (d as Partial<EvidenceDigest>).mintedAt;
                if (typeof t === 'number' && batchedTs.has(t)) batchedSources += 1;
                else {
                  survivors.push(d);
                  survivorFps.push(keptFps[i]);
                }
              });
              kept.length = 0;
              kept.push(...survivors);
              keptFps.length = 0;
              keptFps.push(...survivorFps);
            }
          } catch {
            /* 统计面故障 ⇒ 该护栏跳过（绝不炸宿主） */
          }
          if (kept.length === 0) {
            // 全剔除 ⇒ 只上传未掺入：恶意端点不得经由"本地摘要回环掺入"给端点账赚干净轮
            //（ΠΑΝ-74：剔除计数照发 —— 审计面不因全剔除而失明）
            result.robust = {
              method: 'none',
              mergedFrom: 0,
              quarantined: {},
              excluded: [],
              unverifiableSources,
              excessiveSources,
              batchedSources,
              staleSources,
              revokedSources,
            };
            lastSync = {
              at: nowMs,
              network: 'fired',
              applied: 0,
              note: `响应源全部剔除（验签不过 ${unverifiableSources}、同毫秒批量 ${batchedSources}、超额 ${excessiveSources}、过期 ${staleSources}、撤销 ${revokedSources}）：只上传未掺入（ΝΩ-19/ΠΑΝ-74）`,
            };
          } else {
            // 源标签 = endpoint#指纹（检疫票键与信任账键同源 —— 票落正确主体，端点不背锅）
            const rr = robustMergeDigests([digest as EvidenceDigest, ...kept], {
              sourceIds: ['local', ...keptFps.map(fpAccount)],
            });
            // 检疫票 → 指纹账（先检疫后掺入的 wired 序同律；'local' 的票不喂账）
            const votesByFp: Record<string, number> = {};
            for (const [label, votes] of Object.entries(rr.quarantined)) {
              if (label !== 'local') votesByFp[label] = votes;
            }
            if (Object.keys(votesByFp).length > 0) applyQuarantineToTrust(votesByFp, recordFederationTrust);
            // 已知客户端名册：只学经验签+护栏存活的指纹（下一轮止血限额①的基数）。
            // ΠΑΝ-74：名册记忆有容量上界 —— 满员停学（不逐出：逐出会重置既有指纹
            // 的已知性；饱和律已保证上限不随名册增长）
            if (knownClientFingerprints.size < KNOWN_CLIENT_ROSTER_CAPACITY) {
              for (const fp of keptFps) {
                try {
                  knownClientFingerprints.add(fp);
                  if (knownClientFingerprints.size >= KNOWN_CLIENT_ROSTER_CAPACITY) break;
                } catch {
                  /* 绝不抛 */
                }
              }
            }
            if (rr.merged !== null) {
              // ΠΑΝ-72（检疫账对齐）：掺入配额的信任查询与检疫票同账 —— 签名路径的
              // 票记在 endpoint#指纹账上，掺入信任也按**参与本次合并的指纹账**取
              // 最弱链（min）：旧律查裸 endpoint 账（掺入侧从不记 regressed ⇒ 裸账
              // 3 轮毕业恒 1.0），指纹账上累积的 regressed 衰减没有任何闸门消费 ——
              // 签名链路作为最强演化反而拆掉了检疫的牙齿。显式 sourceId 在场则尊重
              // 调用方的账键口径（旧语义），且掺入记账同步走该账。
              const explicitSource = typeof opts.sourceId === 'string' && opts.sourceId !== '' ? opts.sourceId : null;
              let blendTrust = 1;
              if (explicitSource === null) {
                for (const fp of keptFps) {
                  const t = federationTrustOf(fpAccount(fp));
                  if (Number.isFinite(t) && t > 0 && t < blendTrust) blendTrust = t; // 最弱链治理混合摘要
                }
              }
              const report = applyFederatedEvidence(ledger, rr.merged, {
                maxRemoteShare: opts.maxRemoteShare,
                ...(explicitSource !== null
                  ? { sourceId: explicitSource }
                  : { sourceId: '', trust: Math.min(1, blendTrust) }), // 匿名掺入 + 显式混合信任：票账与配额闸同键咬合
                now: () => nowMs,
              });
              result.applied = report;
              // R6 干净轮进度 → 指纹账：真实掺入的合并轮才计，且仅 0 票源（带票源已在
              // 上面立污点/回退 —— recordFederationTrust 的既有结算律，无需新法；
              // ΠΑΝ-72：applied 只记指纹账 —— 裸 endpoint 账不再被签名路径的掺入
              // 轮记账，端点不为指纹源的合并背书，指纹票也不再被裸账稀释）
              if (report.ok) {
                for (const fp of keptFps) {
                  if ((rr.quarantined[fpAccount(fp)] ?? 0) === 0) {
                    recordFederationTrust(fpAccount(fp), { applied: 1 });
                  }
                }
              }
              result.robust = {
                method: rr.method,
                mergedFrom: rr.merged.mergedFrom,
                quarantined: rr.quarantined,
                excluded: rr.excluded,
                unverifiableSources,
                excessiveSources,
                batchedSources,
                staleSources,
                revokedSources,
              };
              lastSync = {
                at: nowMs,
                network: 'fired',
                applied: report.applied,
                note: !report.ok
                  ? `鲁棒合并摘要掺入被拒：${report.notes[0] ?? '原因未注记'}`
                  : unverifiableSources + excessiveSources + batchedSources + staleSources + revokedSources > 0
                    ? `ΝΩ-19/ΠΑΝ-74 剔除：验签不过 ${unverifiableSources}、同毫秒批量 ${batchedSources}、超额 ${excessiveSources}、过期 ${staleSources}、撤销 ${revokedSources}`
                    : undefined,
              };
            } else {
              lastSync = { at: nowMs, network: 'fired', applied: 0, note: '鲁棒合并零有效源：只上传未掺入' };
            }
          }
        }
      } else {
        // ΠΑΝ-74：legacy 臂的端点撤销闸（预合并摘要直接掺入的最弱路径更要有撤销通道）
        const legacySource = typeof opts.sourceId === 'string' && opts.sourceId !== '' ? opts.sourceId : endpoint;
        if (isFederationSourceRevoked(endpoint) || isFederationSourceRevoked(legacySource)) {
          lastSync = { at: nowMs, network: 'fired', applied: 0, note: '端点命中本地撤销表（ΠΑΝ-74 revocation list）：只上传未掺入' };
        } else {
          const candidate = extractDigest(payload);
          if (candidate !== null) {
            const report = applyFederatedEvidence(ledger, candidate, {
              maxRemoteShare: opts.maxRemoteShare,
              sourceId: legacySource,
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
  // ΝΩ-19：同步侧模块记忆一并复位（签名密钥解析缓存 / 已知客户端名册 / 一次性
  // 提示与警示旗）—— 测试隔离缝；生产代码无理由调用。
  signingKeyCache = null;
  knownClientFingerprints.clear();
  signingHintLogged = false;
  badSigningKeyWarned = false;
}
