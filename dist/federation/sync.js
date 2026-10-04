// src/federation/sync.ts
// W9-3（D-F4 拆分·传输分区）：自 federation/index.ts 低风险提取 —— W6R-A5 聚合
// 端共享密钥认证（HMAC 请求签名 + 防重放）+ Μ-e 同步 federationSync（网络纪律的
// 落点：fire-and-forget POST / 鲁棒臂本地聚合 / 状态记忆）。逐字节搬运（零逻辑
// 变更）；index.ts 原位再导出 —— 导入面不变（消费方零改动）。
import { createHash, createHmac, createPrivateKey, createPublicKey, sign as ed25519Sign, verify as ed25519Verify, } from 'node:crypto';
import { evidenceLedger } from '../kernel/registry.js';
import { robustMergeDigests, applyQuarantineToTrust } from './aggregate.js';
import { DIGEST_VERSION, FEDERATION_TIMEOUT_MS, mintEvidenceDigest, } from './digest.js';
import { applyFederatedEvidence } from './apply.js';
import { federationFingerprintSourceId, recordFederationTrust } from './trust.js';
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
export function federationAuthHeaders(body, token, nowMs) {
    try {
        if (typeof token !== 'string' || token === '')
            return {};
        const ts = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
        const sig = createHmac('sha256', token).update(`${ts}.${body}`).digest('hex');
        return {
            [FEDERATION_AUTH_TIMESTAMP_HEADER]: String(ts),
            [FEDERATION_AUTH_SIGNATURE_HEADER]: sig,
        };
    }
    catch {
        return {}; // 绝不抛纪律：签名失败 = 无头（服务端 401 = 诚实降级）
    }
}
/** 解析同步用的共享密钥：显式注入优先（'' = 显式不签）；缺省读 env（open 语义零头） */
function resolveFederationAuthToken(explicit) {
    if (typeof explicit === 'string')
        return explicit;
    if (explicit === null)
        return '';
    try {
        const v = process.env[FEDERATION_AUTH_ENV];
        return typeof v === 'string' ? v : '';
    }
    catch {
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
/**
 * ΝΩ-19：稳定 canonical 序列化（notary/primitives.ts canonical 的本地同律镜像：
 * 键字典序 + undefined 过滤 —— 联邦不跨器官 import，mulberry32 同律的零依赖纪律）。
 * 签名域字节唯一性的根基：同一摘要无论经谁的 JSON 序列化（键序任意）往返，canonical
 * 字节恒同 —— 验签不因传输层键序漂移而误红。纯函数（循环引用会抛 —— 调用方全兜）。
 */
export function canonicalFederationJson(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value))
        return '[' + value.map(canonicalFederationJson).join(',') + ']';
    const rec = value;
    return ('{' +
        Object.keys(rec)
            .sort()
            .filter(k => rec[k] !== undefined)
            .map(k => JSON.stringify(k) + ':' + canonicalFederationJson(rec[k]))
            .join(',') +
        '}');
}
/**
 * 摘要签名域字节 = 核心四域（v/mintedAt/epsilon/keys）的 canonical 序列化（ΝΩ-19：
 * pubkey/sig 不入域）。形状非法（含陷阱属性）⇒ null（绝不抛 —— 坏输入没有签名资格）。
 */
function digestSigningDomainBytes(d) {
    try {
        if (!d || typeof d !== 'object')
            return null;
        const e = d;
        if (typeof e.v !== 'number' || typeof e.mintedAt !== 'number' ||
            typeof e.epsilon !== 'number' || !Array.isArray(e.keys)) {
            return null;
        }
        return Buffer.from(canonicalFederationJson({ v: e.v, mintedAt: e.mintedAt, epsilon: e.epsilon, keys: e.keys }), 'utf8');
    }
    catch {
        return null;
    }
}
/** Ed25519 私钥解析（seed / pkcs8-base64 / PEM 三形态；非 Ed25519 或垃圾 ⇒ null，绝不抛） */
function parseEd25519PrivateKey(material) {
    try {
        const trimmed = material.trim();
        if (trimmed === '')
            return null;
        if (trimmed.startsWith('-----'))
            return createPrivateKey({ key: trimmed, format: 'pem' });
        const der = Buffer.from(trimmed, 'base64');
        if (der.length === ED25519_SEED_BYTES) { // ΝΩ 收官（magic-number 清偿）：Ed25519 原生 seed 恰 32 字节
            // 32 字节 seed ⇒ 固定 PKCS8 前缀包装成 DER 私钥（Ed25519 的 OID 唯一）
            return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, der]), format: 'der', type: 'pkcs8' });
        }
        return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    }
    catch {
        return null;
    }
}
/** 签名密钥解析缓存（键 = 密钥原文 —— 逐次 sync 免重解析；resetLastSync 复位） */
let signingKeyCache = null;
/** 解析签名密钥（缓存制；material 空/非法/非 Ed25519 ⇒ null，绝不抛） */
function resolveFederationSigningKey(material) {
    if (material === '')
        return null;
    if (signingKeyCache !== null && signingKeyCache.material === material)
        return signingKeyCache.resolved;
    let resolved = null;
    const priv = parseEd25519PrivateKey(material);
    if (priv !== null && priv.asymmetricKeyType === 'ed25519') {
        try {
            const spki = createPublicKey(priv).export({ format: 'der', type: 'spki' });
            resolved = {
                identity: {
                    fingerprint: createHash('sha256').update(spki).digest('hex').slice(0, 16),
                    publicKey: spki.toString('base64'),
                },
                privateKey: priv,
            };
        }
        catch {
            resolved = null;
        }
    }
    signingKeyCache = { material, resolved };
    return resolved;
}
/** 解析签名密钥原料：显式注入优先（'' = 显式禁用）；缺省读 env（未配置 ⇒ 空 = 旧路径） */
function resolveFederationSigningKeyMaterial(explicit) {
    if (typeof explicit === 'string')
        return explicit;
    if (explicit === null)
        return '';
    try {
        const v = process.env[FEDERATION_SIGNING_KEY_ENV];
        return typeof v === 'string' ? v : '';
    }
    catch {
        return '';
    }
}
/**
 * 客户端签名身份（绝不抛）：密钥合法 ⇒ { 指纹, 公钥 }；未配置/非法 ⇒ null。
 * 导出为公开面 —— 测试与运维诊断共用同一实现（指纹口径的唯一 TS 权威源）。
 */
export function federationSigningIdentity(signingKey) {
    try {
        const resolved = resolveFederationSigningKey(resolveFederationSigningKeyMaterial(signingKey));
        return resolved === null ? null : { ...resolved.identity };
    }
    catch {
        return null;
    }
}
/**
 * 摘要签名（ΝΩ-19 上行面，绝不抛）：密钥在场 ⇒ 摘要附 {pubkey, sig}；密钥缺席/
 * 域形状非法/签名故障 ⇒ null（调用方诚实降级发未签件 —— 服务端照收，本地不炸，
 * 绝不带可伪造的弱签名上路）。
 */
export function signEvidenceDigest(digest, signingKey) {
    try {
        const resolved = resolveFederationSigningKey(resolveFederationSigningKeyMaterial(signingKey));
        if (resolved === null)
            return null;
        const domain = digestSigningDomainBytes(digest);
        if (domain === null)
            return null;
        const sig = ed25519Sign(null, domain, resolved.privateKey).toString('base64');
        return { ...digest, pubkey: resolved.identity.publicKey, sig };
    }
    catch {
        return null;
    }
}
/**
 * 逐源验签（ΝΩ-19 下行面，纯函数、绝不抛、含陷阱属性隔离）：pubkey+sig 在场且
 * Ed25519 验签成立 ⇒ ok + 指纹。无签名（旧格式源）⇒ missing-signature —— 诚实
 * 降级为 unverifiable：无身份的源在中位数攻击面下不值得信任（迁移期需聚合端与
 * 客户端同步升级，见节首注记）；坏公钥/坏签名/畸形 ⇒ 对应归因。指纹对 SPKI DER
 * 字节取 sha256 前 16 hex（与客户端侧同口径 —— 双面同律由测试把守）。
 */
export function verifyEvidenceDigestSignature(entry) {
    try {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return { ok: false, fingerprint: null, reason: 'malformed' };
        }
        const e = entry;
        if (typeof e.pubkey !== 'string' || e.pubkey === '' || typeof e.sig !== 'string' || e.sig === '') {
            return { ok: false, fingerprint: null, reason: 'missing-signature' }; // 无签名旧格式：无身份 ⇒ 不可信
        }
        const spki = Buffer.from(e.pubkey, 'base64');
        const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
        if (pub.asymmetricKeyType !== 'ed25519')
            return { ok: false, fingerprint: null, reason: 'bad-key' };
        const domain = digestSigningDomainBytes(entry);
        if (domain === null)
            return { ok: false, fingerprint: null, reason: 'malformed' };
        const sigOk = ed25519Verify(null, domain, pub, Buffer.from(e.sig, 'base64'));
        if (!sigOk)
            return { ok: false, fingerprint: null, reason: 'bad-signature' };
        return { ok: true, fingerprint: createHash('sha256').update(spki).digest('hex').slice(0, 16) };
    }
    catch {
        return { ok: false, fingerprint: null, reason: 'malformed' };
    }
}
/**
 * 一次性密钥生成命令（运维辅助 —— 无 key 时控制台提示用；纯函数零状态）。
 * 提示面：logFederationSigningKeyHint（每进程至多一次）。
 */
export function federationSigningKeyHint() {
    return `node -e "console.log('export ${FEDERATION_SIGNING_KEY_ENV}=' + require('node:crypto').randomBytes(32).toString('base64'))"`;
}
/** 无 key 一次性提示旗（每进程至多一次） */
let signingHintLogged = false;
/** 无 key 提示（每进程至多一次；绝不抛）：同侪已升级而本机未配钥的迁移期哨兵 */
export function logFederationSigningKeyHint() {
    try {
        if (signingHintLogged)
            return;
        signingHintLogged = true;
        console.info(`[dsh-federation] ${FEDERATION_SIGNING_KEY_ENV} 未配置：联邦逐源签名链路关闭（ΝΩ-19）。一次性生成：${federationSigningKeyHint()}`);
    }
    catch {
        /* 绝不抛 */
    }
}
/** 非法密钥一次性警示旗（诚实可见，不静默猜） */
let badSigningKeyWarned = false;
/** 已知客户端指纹名册（止血限额①的基数 —— 只学经验签+护栏存活的指纹；resetLastSync 复位） */
const knownClientFingerprints = new Set();
/** 远端件是否携带签名域（迁移期哨兵的判据 —— 只看面不验签，零开销） */
function digestCarriesSignature(entry) {
    try {
        return (!!entry && typeof entry === 'object' && !Array.isArray(entry) &&
            typeof entry.pubkey === 'string' &&
            entry.pubkey !== '');
    }
    catch {
        return false;
    }
}
let lastSync = null;
/** 上次同步状态（null = 尚未同步过 —— 诚实面，不臆造） */
export function lastFederationSync() {
    return lastSync ? { ...lastSync } : null;
}
/** 网络错误消毒：只留首行 200 字符；endpoint 原文（可能带凭据）替换为 <endpoint>（密钥卫生） */
function sanitizeNetError(e, endpoint) {
    try {
        let msg = String(e?.message ?? e ?? 'network error');
        msg = String(msg).split(/[\r\n]+/)[0].slice(0, 200);
        if (endpoint !== '') {
            while (msg.includes(endpoint))
                msg = msg.split(endpoint).join('<endpoint>');
        }
        return msg === '' ? 'network error' : msg;
    }
    catch {
        return 'network error';
    }
}
/** 响应载荷 → 摘要：取 payload.digest（或 payload 本身），形状+版本核验过关才收 */
function extractDigest(payload) {
    try {
        const cand = (payload && typeof payload === 'object' && !Array.isArray(payload) &&
            payload.digest && typeof payload.digest === 'object')
            ? payload.digest
            : payload;
        if (!cand || typeof cand !== 'object' || Array.isArray(cand))
            return null;
        const c = cand;
        if (c.v !== DIGEST_VERSION || !Array.isArray(c.keys))
            return null;
        return c;
    }
    catch {
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
function extractDigestList(payload) {
    try {
        const list = payload && typeof payload === 'object' && Array.isArray(payload.digests)
            ? payload.digests
            : Array.isArray(payload)
                ? payload
                : [];
        const out = [];
        for (const cand of list) {
            if (!cand || typeof cand !== 'object' || Array.isArray(cand))
                continue;
            const c = cand;
            if (c.v !== DIGEST_VERSION || !Array.isArray(c.keys))
                continue;
            out.push(c);
        }
        return out;
    }
    catch {
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
export function federationSync(opts = {}) {
    let nowMs = Date.now();
    if (typeof opts.now === 'function') {
        try {
            const t = opts.now();
            if (Number.isFinite(t))
                nowMs = t;
        }
        catch {
            /* 时钟故障保持 Date.now */
        }
    }
    const endpoint = typeof opts.endpoint === 'string' ? opts.endpoint : '';
    const ledger = opts.ledger ?? evidenceLedger; // 缺省全局单例；可注入（测试/多账本）
    // 种子：给定用给定；缺省由 now 派生 —— 每次同步的噪声流独立（DP 的跨次纪律）
    const seed = typeof opts.seed === 'number' && Number.isFinite(opts.seed) ? opts.seed : nowMs >>> 0;
    const digest = mintEvidenceDigest(ledger, { epsilon: opts.epsilon, seed, now: () => nowMs });
    const result = {
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
    let fetchFn = null;
    if (typeof opts.fetchImpl === 'function')
        fetchFn = opts.fetchImpl;
    else if (opts.fetchImpl === null)
        fetchFn = null;
    else if (typeof fetch === 'function')
        fetchFn = fetch;
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
                console.warn(`[dsh-federation] ${FEDERATION_SIGNING_KEY_ENV} 无法解析为 Ed25519 私钥（pkcs8/base64、32 字节 seed 的 base64 或 PEM）：逐源签名链路诚实关闭，走未签名旧路径（ΝΩ-19）`);
            }
        }
        catch {
            /* 日志面故障不挡同步 */
        }
    }
    // ΝΩ-19：上行签名 —— 密钥在场 ⇒ 每份摘要附 {pubkey, sig}（私钥绝不进载荷）；
    // 签名故障 ⇒ 诚实降级发未签件（绝不抛、不带弱签名上路）
    const signedUplink = signing === null ? null : signEvidenceDigest(digest, signingMaterial);
    const body = JSON.stringify(signedUplink ?? digest); // 上行载荷只有摘要（密钥卫生：无凭据无文本无截图；pubkey/sig 是摘要自带域）
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
            let payload = null;
            try {
                payload = await res?.json?.();
            }
            catch {
                payload = null; // 响应体坏 JSON：按无合并摘要处理（不炸、不掺）
            }
            if (opts.robust === true) {
                // ── Μ2 鲁棒臂：只收多源原始摘要，本地逐格中位数聚合（数学执法代替对聚合端的信任）──
                const remotes = extractDigestList(payload);
                if (remotes.length === 0) {
                    lastSync = { at: nowMs, network: 'fired', applied: 0, note: '响应不含可用的多源摘要（鲁棒臂只收 digests 原始数组）：只上传未掺入' };
                }
                else if (signing === null) {
                    // ΝΩ-19：未配置签名密钥 ⇒ 旧路径逐字节（remote-N 标签 + 端点集体账）。
                    // 迁移期哨兵：同侪已升级（响应带签名域）而本机未配钥 ⇒ 一次性提示生成命令
                    try {
                        if (remotes.some(digestCarriesSignature))
                            logFederationSigningKeyHint();
                    }
                    catch {
                        /* 提示面故障不挡同步 */
                    }
                    // 本机摘要作为第一源参与聚合（中位数对本机+诚实同侪有结构性保护 —— 毒未过半即被隔离）
                    const rr = robustMergeDigests([digest, ...remotes], {
                        sourceIds: ['local', ...remotes.map((_, idx) => `remote-${idx}`)],
                    });
                    // 检疫有牙齿（先检疫后掺入 —— 同一轮就咬合）：远端源的检疫票折算 regressed 记到
                    // endpoint 账上（端点为它交出的每一份摘要集体负责 —— 激励端点清洗毒源；
                    // 'local' 的票不喂账：本机偏离共识是本机校准自己的事，诚实注记在 robust 报告里）
                    let remoteVotes = 0;
                    for (const [label, votes] of Object.entries(rr.quarantined)) {
                        if (label !== 'local')
                            remoteVotes += votes;
                    }
                    if (remoteVotes > 0)
                        applyQuarantineToTrust({ [endpoint]: remoteVotes }, recordFederationTrust);
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
                    }
                    else {
                        lastSync = { at: nowMs, network: 'fired', applied: 0, note: '鲁棒合并零有效源：只上传未掺入' };
                    }
                }
                else {
                    // ── ΝΩ-19 签名链路：逐源验签 → 止血护栏 → 指纹粒度账 → 本地中位数聚合 ──
                    const ownFp = signing.identity.fingerprint;
                    const fpAccount = (fp) => federationFingerprintSourceId(endpoint, fp);
                    // ①逐源验签：验不过（含无签名旧格式）按缺席剔除并计数 —— 假源绝不混入中位数
                    const kept = [];
                    const keptFps = [];
                    let unverifiableSources = 0;
                    for (const d of remotes) {
                        const verdict = verifyEvidenceDigestSignature(d);
                        if (verdict.ok && typeof verdict.fingerprint === 'string' && verdict.fingerprint !== '') {
                            kept.push(d);
                            keptFps.push(verdict.fingerprint);
                        }
                        else {
                            unverifiableSources += 1;
                        }
                    }
                    // 止血①：响应源数上限 = 本地已知客户端数（含本机）×2+4 —— 超额源拒绝并计数
                    let knownClients = knownClientFingerprints.size;
                    if (!knownClientFingerprints.has(ownFp))
                        knownClients += 1; // 本机也是已知客户端
                    const maxRemotes = knownClients * 2 + 4;
                    let excessiveSources = 0;
                    if (kept.length > maxRemotes) {
                        excessiveSources = kept.length - maxRemotes;
                        kept.length = maxRemotes;
                        keptFps.length = maxRemotes;
                    }
                    // 止血②：mintedAt 同毫秒批量特征 —— 同毫秒铸造的 ≥2 份"独立源"整组剔除并计数
                    let batchedSources = 0;
                    try {
                        const tsCounts = new Map();
                        for (const d of kept) {
                            const t = d.mintedAt;
                            if (typeof t === 'number' && Number.isFinite(t))
                                tsCounts.set(t, (tsCounts.get(t) ?? 0) + 1);
                        }
                        const batchedTs = new Set();
                        for (const [t, c] of tsCounts)
                            if (c >= 2)
                                batchedTs.add(t);
                        if (batchedTs.size > 0) {
                            const survivors = [];
                            const survivorFps = [];
                            kept.forEach((d, i) => {
                                const t = d.mintedAt;
                                if (typeof t === 'number' && batchedTs.has(t))
                                    batchedSources += 1;
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
                    }
                    catch {
                        /* 统计面故障 ⇒ 该护栏跳过（绝不炸宿主） */
                    }
                    if (kept.length === 0) {
                        // 全剔除 ⇒ 只上传未掺入：恶意端点不得经由"本地摘要回环掺入"给端点账赚干净轮
                        lastSync = {
                            at: nowMs,
                            network: 'fired',
                            applied: 0,
                            note: `响应源全部剔除（验签不过 ${unverifiableSources}、同毫秒批量 ${batchedSources}、超额 ${excessiveSources}）：只上传未掺入（ΝΩ-19）`,
                        };
                    }
                    else {
                        // 源标签 = endpoint#指纹（检疫票键与信任账键同源 —— 票落正确主体，端点不背锅）
                        const rr = robustMergeDigests([digest, ...kept], {
                            sourceIds: ['local', ...keptFps.map(fpAccount)],
                        });
                        // 检疫票 → 指纹账（先检疫后掺入的 wired 序同律；'local' 的票不喂账）
                        const votesByFp = {};
                        for (const [label, votes] of Object.entries(rr.quarantined)) {
                            if (label !== 'local')
                                votesByFp[label] = votes;
                        }
                        if (Object.keys(votesByFp).length > 0)
                            applyQuarantineToTrust(votesByFp, recordFederationTrust);
                        // 已知客户端名册：只学经验签+护栏存活的指纹（下一轮止血限额①的基数）
                        for (const fp of keptFps) {
                            try {
                                knownClientFingerprints.add(fp);
                            }
                            catch {
                                /* 绝不抛 */
                            }
                        }
                        if (rr.merged !== null) {
                            const report = applyFederatedEvidence(ledger, rr.merged, {
                                maxRemoteShare: opts.maxRemoteShare,
                                sourceId: typeof opts.sourceId === 'string' && opts.sourceId !== '' ? opts.sourceId : endpoint,
                                now: () => nowMs,
                            });
                            result.applied = report;
                            // R6 干净轮进度 → 指纹账：真实掺入的合并轮才计，且仅 0 票源（带票源已在
                            // 上面立污点/回退 —— recordFederationTrust 的既有结算律，无需新法）
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
                            };
                            lastSync = {
                                at: nowMs,
                                network: 'fired',
                                applied: report.applied,
                                note: !report.ok
                                    ? `鲁棒合并摘要掺入被拒：${report.notes[0] ?? '原因未注记'}`
                                    : unverifiableSources + excessiveSources + batchedSources > 0
                                        ? `ΝΩ-19 剔除：验签不过 ${unverifiableSources}、同毫秒批量 ${batchedSources}、超额 ${excessiveSources}`
                                        : undefined,
                            };
                        }
                        else {
                            lastSync = { at: nowMs, network: 'fired', applied: 0, note: '鲁棒合并零有效源：只上传未掺入' };
                        }
                    }
                }
            }
            else {
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
                }
                else {
                    lastSync = { at: nowMs, network: 'fired', applied: 0, note: '响应不含可用的合并摘要：只上传未掺入' };
                }
            }
        }
        catch (e) {
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
export function resetLastSync() {
    lastSync = null;
    // ΝΩ-19：同步侧模块记忆一并复位（签名密钥解析缓存 / 已知客户端名册 / 一次性
    // 提示与警示旗）—— 测试隔离缝；生产代码无理由调用。
    signingKeyCache = null;
    knownClientFingerprints.clear();
    signingHintLogged = false;
    badSigningKeyWarned = false;
}
