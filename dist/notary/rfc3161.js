// src/notary/rfc3161.ts
// 纪元 Π（可公证行为账本）：最小 RFC 3161 时间戳客户端 —— 零依赖、极简 DER。
//
// 使命：给一枚行为公证锚（src/notary/index.ts 的 AnchorRecord 载荷摘要）向
// TSA（Time Stamp Authority）换取「该摘要在时刻 T 已存在」的第三方回执。
// RFC 3161 的线协议是 DER 编码的 TimeStampReq/TimeStampResp（CMS 家族）——
// 本文件不引 ASN.1 库，手写两件恰好够用的东西：
//   1. 定点构造器：TimeStampReq = SEQUENCE{ version=1, messageImprint, nonce, certReq=TRUE }
//      （reqPolicy/extensions 缺席 —— 全部 OPTIONAL，合法最简形态）；
//   2. TLV 游走器：对响应做深度优先的「模式扫描」而非完整语法树 ——
//      只要能在任意深度找到 sha256 算法符 + 32 字节摘要对、以及回显的 nonce，
//      就足以核验「这枚回执在册且绑定本次请求」。
//
// 诚实边界（本客户端证明什么、不证明什么 —— 写死在公证报告的语义里）：
//   · 不做证书链验证 —— 但 ΑΩ-R5 起做 TSA 对 TSTInfo 的签名离线验证（node:crypto
//     数学验签，判决见 SignatureVerdict）；imprintVerified=true 的语义仍是「时间戳
//     回执在册且绑定本请求」，signatureVerified=true 的语义是「内嵌签名者密钥对
//     TSTInfo 的签名成立」，不是「TSA 身份已信」。ΝΩ-21 起信任锚有两个层次：
//     ① 可选密钥 pin —— env DSH_TSA_PIN_SHA256（SPKI sha256 逗号分隔表）在场 ⇒
//     验签成立后比对内嵌证书 SPKI 指纹，未命中 ⇒ 判决降为 'unpinned-key'（签名
//     数学成立但密钥不在 pin 表 —— 不算绿）；pin 缺席 ⇒ 维持既有边界（信任锚定
//     属外部验签器职权，如实保留）。② sid ↔ 证书逐位匹配是唯一寻径 —— 单证书
//     回退已删除（ΝΩ-21：回退让控制 endpoint 者自造证书即可 signatureVerified:
//     true，是伪造向量，不是编码方言容错）。
//   · genTime（TSTInfo 的 TSA 权威时刻）：ΝΩ-21 起从 token 提取（GeneralizedTime
//     DER 解码 —— extractGenTime），供锚核验层与 anchoredAt 做 |Δ| ≤ 1h 容差
//     校验（notary/index.ts 章③ 注记 genTime-skew —— 注记级，不翻章）。
//   · 不定长（BER 0x80 长度）拒绝解码 —— 只接受 DER 定长形态（主流 TSA 均为 DER）。
// 网络纪律（与 swarm.fireUpload 同律）：5s 超时、单次尝试、失败诚实返回 ——
// 公证是旁路仪式，TSA 不可达绝不演变成第三方背书，更不允许炸宿主。
//
// ΑΩ-R5（诚实边界升级）：本文件补上 TSA 签名离线验证 —— verifyTsaSignature 从
// token 的 CMS SignedData 提取签名者证书 SPKI、签名值与被签内容（TSTInfo DER），
// 用 node:crypto 按 digestAlgorithm 验签（RSA PKCS#1 v1.5 / ECDSA，sha256/384/512）。
// 上述「不做 TSA 签名验证」的旧边界就此收窄为「不做证书链/信任锚验证」——签名
// 数学上可离线复核（certReq=TRUE 内嵌签名者证书正是为此），但「该证书是否真属
// 可信 TSA」仍属外部验签器职权，如实保留在边界声明里。
import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
/** DER 常量标签：UNIVERSAL 类（本客户端边界内只用到这四种 + [0] 上下文标签） */
const TAG_BOOLEAN = 0x01;
const TAG_INTEGER = 0x02;
const TAG_OCTET_STRING = 0x04;
const TAG_OID = 0x06;
const TAG_SEQUENCE = 0x30;
/** id-sha256（2.16.840.1.101.3.4.2.1）的 DER 内容字节 —— 首两弧 40×2+16=0x60、840=0x8648 */
export const DER_OID_SHA256 = Uint8Array.of(0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01);
/** 读一个 TLV：短/长长度形式均可；畸形（不定长/长度越界/截断）返回 null（诚实拒绝） */
export function derRead(buf, offset = 0) {
    if (offset < 0 || offset + 2 > buf.length)
        return null;
    const tag = buf[offset];
    let i = offset + 1;
    const first = buf[i++];
    let len = 0;
    if (first < 0x80) {
        len = first; // 短长度形式
    }
    else if (first === 0x80) {
        return null; // 不定长（BER）—— DER 边界外
    }
    else {
        const n = first & 0x7f; // 长长度形式：后续 n 字节大端
        if (n === 0 || n > 4 || i + n > buf.length)
            return null;
        for (let k = 0; k < n; k++)
            len = len * 256 + buf[i++];
    }
    if (i + len > buf.length)
        return null; // 声称的长度越过缓冲（截断/损坏）
    return { tag, start: offset, contentStart: i, contentEnd: i + len, end: i + len };
}
/** 构造类型（tag 第 5 位 = 0x20）才有子节点；畸形子序列即止（防御性截断不抛） */
export function derChildren(node, buf) {
    if ((node.tag & 0x20) === 0)
        return [];
    const out = [];
    let off = node.contentStart;
    while (off < node.contentEnd) {
        const child = derRead(buf, off);
        if (!child || child.end > node.contentEnd)
            break; // 越过父内容区即畸形
        out.push(child);
        off = child.end;
    }
    return out;
}
/** 节点内容字节（原 buf 的 subarray 视图 —— 零拷贝） */
export function derContent(node, buf) {
    return buf.subarray(node.contentStart, node.contentEnd);
}
/** 定长 DER 编码：tag + 最短长度形式 + 内容（本客户端构造侧唯一入口） */
export function derEncode(tag, content) {
    const len = content.length;
    let header;
    if (len < 0x80) {
        header = Uint8Array.of(len);
    }
    else {
        const bytes = [];
        let v = len;
        while (v > 0) {
            bytes.unshift(v & 0xff);
            v = Math.floor(v / 256);
        }
        header = Uint8Array.of(0x80 | bytes.length, ...bytes);
    }
    const out = new Uint8Array(1 + header.length + len);
    out[0] = tag;
    out.set(header, 1);
    out.set(content, 1 + header.length);
    return out;
}
/** 字节串拼接（构造侧胶水） */
function concatBytes(...parts) {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}
function bytesEqual(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i])
            return false;
    return true;
}
/** 无符号整数的 DER INTEGER 内容归一：剥前导零（TSA 回显 nonce 可能补 0x00 正号位） */
function normalizeUint(b) {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0)
        i++;
    return b.subarray(i);
}
/**
 * 构造 TimeStampReq（RFC 3161 §3.1 的最简合法形态）：
 *   SEQUENCE {
 *     version         INTEGER 1,
 *     messageImprint  SEQUENCE { hashAlgorithm SEQUENCE{ OID id-sha256 },  -- parameters 缺席
 *                                  hashedMessage  OCTET STRING (32B) },     -- （RFC 6234：id-sha256 无参）
 *     nonce           INTEGER,   -- CSPRNG（8~16B；正号位由调用方保证 —— 见 notary.mintNonce）
 *     certReq         BOOLEAN TRUE }  -- 回执内嵌证书：离线验签路径的原料
 * （reqPolicy/extensions 为 OPTIONAL，缺席 —— 测试与真实 TSA 均接受此形态。）
 */
export function buildTimestampRequest(digest, nonce) {
    const algId = derEncode(TAG_SEQUENCE, derEncode(TAG_OID, DER_OID_SHA256));
    const imprint = derEncode(TAG_SEQUENCE, concatBytes(algId, derEncode(TAG_OCTET_STRING, digest)));
    return derEncode(TAG_SEQUENCE, concatBytes(derEncode(TAG_INTEGER, Uint8Array.of(1)), imprint, derEncode(TAG_INTEGER, nonce), derEncode(TAG_BOOLEAN, Uint8Array.of(0xff))));
}
/** 小整数读取（PKIStatus/serial 场景 —— 大整数不在本客户端边界内） */
function readDerInt(buf, node) {
    let v = 0;
    for (let i = node.contentStart; i < node.contentEnd; i++)
        v = v * 256 + buf[i];
    return v;
}
/**
 * 深度优先模式扫描（响应与 token 复核共用的核验核）：
 *   ① 兄弟对 (SEQUENCE, OCTET STRING)：前者首子是 id-sha256 OID 且后者内容 ==
 *      本地摘要 ⇒ messageImprint 在册（CMS/SignedData 嵌套层数在不同 TSA 间有
 *      方言差异 —— 模式扫描对嵌套方言免疫，不建语法树）；
 *   ② 任意 INTEGER 内容（前导零归一后）== 请求 nonce ⇒ 回执绑定本请求。
 * ΑΩ-R5：真 CMS token 把 TSTInfo 封在 eContent 的 OCTET STRING 里 —— 对「内容
 * 恰好是一枚完整 SEQUENCE」的 OCTET STRING 下降一层再扫（随机签名字节解不成
 * 完整 SEQUENCE，即便偶然解出也须逐字节命中摘要/nonce 才计匹配 —— 无虚绿面）。
 */
function scanImprintAndNonce(buf, expected) {
    let imprintMatch = false;
    let nonceMatch = false;
    const wantNonce = normalizeUint(expected.nonce);
    // ΑΩ-R5：下降进 OCTET STRING 内容后偏移换域 —— 节点必须与其所属缓冲成对走
    const stack = [];
    const root = derRead(buf, 0);
    if (root)
        stack.push({ node: root, buf });
    while (stack.length > 0) {
        const { node, buf: b } = stack.pop();
        if (node.tag === TAG_INTEGER && bytesEqual(normalizeUint(derContent(node, b)), wantNonce)) {
            nonceMatch = true;
        }
        if ((node.tag & 0x20) !== 0) {
            const kids = derChildren(node, b);
            for (let i = 0; i + 1 < kids.length; i++) {
                const a = kids[i], c = kids[i + 1];
                if (a.tag === TAG_SEQUENCE && c.tag === TAG_OCTET_STRING) {
                    const aKids = derChildren(a, b);
                    if (aKids.length > 0 && aKids[0].tag === TAG_OID
                        && bytesEqual(derContent(aKids[0], b), DER_OID_SHA256)
                        && bytesEqual(derContent(c, b), expected.digest)) {
                        imprintMatch = true;
                    }
                }
            }
            for (const k of kids)
                stack.push({ node: k, buf: b });
        }
        else if (node.tag === TAG_OCTET_STRING) {
            // ΑΩ-R5：内容恰为一枚完整 SEQUENCE（如 eContent 里的 TSTInfo）⇒ 下降扫描
            const content = derContent(node, b);
            if (content.length >= 2) {
                const inner = derRead(content, 0);
                if (inner && inner.tag === TAG_SEQUENCE && inner.end === content.length) {
                    stack.push({ node: inner, buf: content });
                }
            }
        }
    }
    return { imprintMatch, nonceMatch };
}
// ─── ΑΩ-R5：TSA 签名离线验证（CMS SignedData 最小提取 + node:crypto 验签） ───
//
// 使命：verifyTimestampToken 原只验「imprint+nonce 绑定」（模式扫描），不验 TSA
// 对 TSTInfo 的签名 —— 恶意/被攻破 endpoint 理论上可回发伪造 token。本段补上
// 真正的离线验签：certReq=TRUE 时响应内嵌签名者证书（CMS certificates [0]），
// 正是离线验签的原料。三件套提取与验签纪律：
//   · 提取（位置走查 + 标签门，逐字段失败即诚实 'unparseable'）：
//       (a) 签名者 X.509 证书的 SubjectPublicKeyInfo（sid ↔ 证书逐位匹配）；
//       (b) SignerInfo.signature 的 OCTET STRING 字节；
//       (c) 被签内容 —— encapContentInfo.eContent 里 TSTInfo 的完整 DER。
//   · 验签（node:crypto，零新依赖）：digestAlgorithm 限 sha256/384/512；
//     RSA PKCS#1 v1.5 与 ECDSA（CMS 原生 DER r,s 形态 —— verify 缺省 dsaEncoding）。
//     signedAttrs 在场 ⇒ 按 RFC 5652 §5.4 对 [0]→SET(0x31) 重编码字节验签，并核
//     messageDigest 属性 == hash(eContent)（把签名绑定到正确的内容字节 ——
//     内容被换而摘要属性未换 ⇒ 直接 false，绝不拿错字节碰运气）。
//   · 判决四值 SignatureVerdict（绝不抛、绝不因验签失败误绿）：
//       true = 验了且过 / false = 验了而败（伪造或损坏）/
//       'unsupported-alg' = 结构可解但算法在边界外（诚实申报，不硬验）/
//       'unparseable' = 三件套提不出来（结构损坏/非 CMS 形态/证书缺席）。
// 仍是边界（如实保留）：不做证书链与信任锚验证 —— signatureVerified=true 证明
// 「内嵌密钥的签名成立」，不证明「该密钥属可信 TSA」（属外部验签器职权）。
/** ΑΩ-R5：SET OF / 上下文 [0][1] 构造标签（CMS 走查需要） */
const TAG_SET = 0x31;
/** ΑΩ-R5：算法/属性 OID 的 DER 内容字节（见 RFC 5652/8017、X9.62） */
const DER_OID_SIGNED_DATA = Uint8Array.of(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02);
const DER_OID_SHA384 = Uint8Array.of(0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02);
const DER_OID_SHA512 = Uint8Array.of(0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x03);
const DER_OID_RSA_ENCRYPTION = Uint8Array.of(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01);
const DER_OID_SHA256_WITH_RSA = Uint8Array.of(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b);
const DER_OID_SHA384_WITH_RSA = Uint8Array.of(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0c);
const DER_OID_SHA512_WITH_RSA = Uint8Array.of(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0d);
const DER_OID_ECDSA_WITH_SHA256 = Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02);
const DER_OID_ECDSA_WITH_SHA384 = Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03);
const DER_OID_ECDSA_WITH_SHA512 = Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x04);
const DER_OID_ATTR_MESSAGE_DIGEST = Uint8Array.of(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x04);
const DER_OID_EXT_SUBJECT_KEY_ID = Uint8Array.of(0x55, 0x1d, 0x0e);
/**
 * ΝΩ-21：DSH_TSA_PIN_SHA256（TSA 信任锚 pin 表）的 env 键名 —— 逗号分隔的
 * SPKI sha256 hex 列表。在场 ⇒ 验签成立后执法密钥钉扎；缺席 ⇒ 既有诚实边界。
 */
export const TSA_PIN_ENV_KEY = 'DSH_TSA_PIN_SHA256';
/**
 * ΝΩ-21：genTime 与锚本地钟（anchoredAt）的容差（1 小时，毫秒）—— 超差 ⇒
 * 锚核验层注记 genTime-skew（注记级，不翻章；TSA 钟与本地钟的正常漂移远小于此）。
 */
export const GEN_TIME_SKEW_TOLERANCE_MS = 3_600_000;
/**
 * ΝΩ-21：解析 pin 表（逗号分隔 SPKI sha256 hex，容忍空白/大小写/前缀 0x）。
 * env 缺席/空白 ⇒ null（pin 面未武装 —— 既有边界保持）；在场但无一合法指纹 ⇒
 * 空数组（fail-closed：一切签名者都不在 pin 表 ⇒ 'unpinned-key'，绝不在配置
 * 打错时静默缴械放行）。纯函数（env 表注入 —— 确定性测试缝）。
 */
export function parseTsaPinList(raw) {
    if (typeof raw !== 'string' || raw.trim() === '')
        return null;
    return raw
        .split(',')
        .map(s => s.trim().toLowerCase().replace(/^0x/, ''))
        .filter(s => /^[0-9a-f]{64}$/.test(s));
}
/** ΑΩ-R5：异常归因（本文件自持的最小版 —— 与 errText 同律，绝不二次抛） */
function msgOf(e) {
    if (e instanceof Error)
        return e.message;
    try {
        const s = String(e);
        return s === '' ? 'unknown error' : s;
    }
    catch {
        return 'unknown error';
    }
}
/** ΑΩ-R5：OID 内容字节 → 点分弧文本（reason 归因用 —— 大端 base-128 解码） */
function oidText(oid) {
    if (oid.length === 0)
        return '(empty OID)';
    const arcs = [String(Math.floor(oid[0] / 40)), String(oid[0] % 40)];
    let v = 0;
    for (let i = 1; i < oid.length; i++) {
        v = v * 128 + (oid[i] & 0x7f);
        if ((oid[i] & 0x80) === 0) {
            arcs.push(String(v));
            v = 0;
        }
    }
    return arcs.join('.');
}
/** ΑΩ-R5：AlgorithmIdentifier 的首 OID 内容（无 OID ⇒ null） */
function firstOid(node, buf) {
    const k = derChildren(node, buf).find(c => c.tag === TAG_OID);
    return k ? derContent(k, buf) : null;
}
/** ΑΩ-R5：摘要 OID → hash 名（sha256/384/512 之外 ⇒ null = 边界外） */
function mapDigestOid(oid) {
    if (bytesEqual(oid, DER_OID_SHA256))
        return 'sha256';
    if (bytesEqual(oid, DER_OID_SHA384))
        return 'sha384';
    if (bytesEqual(oid, DER_OID_SHA512))
        return 'sha512';
    return null;
}
/**
 * ΑΩ-R5：签名算法 OID + digestAlgorithm 一致性 → 密钥族。
 * 'rsa'（PKCS#1 v1.5）/'ecdsa'（DER r,s）；'mismatch' = 两处算法族自相矛盾
 * （CMS §5.1 违规 —— 验了也必败，如实报 false 而非 unsupported）；
 * null = 边界外（rsaPSS/ed25519/sha1 系/未知 —— 诚实 'unsupported-alg'）。
 */
function mapSigAlgOid(oid, hashName) {
    if (bytesEqual(oid, DER_OID_RSA_ENCRYPTION))
        return 'rsa'; // 摘要族由 digestAlgorithm 提供
    const rsaWith = [
        [DER_OID_SHA256_WITH_RSA, 'sha256'],
        [DER_OID_SHA384_WITH_RSA, 'sha384'],
        [DER_OID_SHA512_WITH_RSA, 'sha512'],
    ];
    for (const [o, h] of rsaWith) {
        if (bytesEqual(oid, o))
            return h === hashName ? 'rsa' : 'mismatch';
    }
    const ecdsaWith = [
        [DER_OID_ECDSA_WITH_SHA256, 'sha256'],
        [DER_OID_ECDSA_WITH_SHA384, 'sha384'],
        [DER_OID_ECDSA_WITH_SHA512, 'sha512'],
    ];
    for (const [o, h] of ecdsaWith) {
        if (bytesEqual(oid, o))
            return h === hashName ? 'ecdsa' : 'mismatch';
    }
    return null;
}
/**
 * ΑΩ-R5：解析一枚内嵌证书的最小本质（位置走查 + 标签门 —— 不建完整证书模型、
 * 不验证书自身签名[属外部验签器职权]）。畸形 ⇒ null（调用方按证书缺席诚实降级）。
 */
function parseCertificate(buf, cert) {
    const kids = derChildren(cert, buf);
    const tbs = kids[0];
    if (!tbs || tbs.tag !== TAG_SEQUENCE)
        return null;
    let t = derChildren(tbs, buf);
    if (t.length > 0 && t[0].tag === 0xa0)
        t = t.slice(1); // [0] EXPLICIT version 可选
    if (t.length < 6)
        return null;
    const [serial, , issuer, , , spki] = t;
    if (serial.tag !== TAG_INTEGER || issuer.tag !== TAG_SEQUENCE || spki.tag !== TAG_SEQUENCE)
        return null;
    return {
        serial: derContent(serial, buf),
        issuerDer: buf.slice(issuer.start, issuer.end),
        spkiDer: buf.slice(spki.start, spki.end),
        ski: findSubjectKeyId(t, buf),
    };
}
/** ΑΩ-R5：在 tbs 孩子里找 2.5.29.14 扩展的 KeyIdentifier（无 ⇒ null） */
function findSubjectKeyId(tbsKids, buf) {
    for (const k of tbsKids) {
        if (k.tag !== 0xa3)
            continue; // [3] EXPLICIT Extensions
        for (const seq of derChildren(k, buf)) {
            if (seq.tag !== TAG_SEQUENCE)
                continue;
            for (const ext of derChildren(seq, buf)) {
                if (ext.tag !== TAG_SEQUENCE)
                    continue;
                const ek = derChildren(ext, buf);
                // Extension ::= SEQUENCE { extnID OID, critical BOOLEAN OPTIONAL, extnValue OCTET STRING }
                // —— critical 缺席时 extnValue 是第 2 个孩子，取「最后一个 OCTET STRING 孩子」
                if (ek.length < 2 || ek[0].tag !== TAG_OID
                    || !bytesEqual(derContent(ek[0], buf), DER_OID_EXT_SUBJECT_KEY_ID))
                    continue;
                const val = ek.reduce((acc, c) => (c.tag === TAG_OCTET_STRING ? c : acc), null);
                if (!val)
                    continue;
                // extnValue 的内容是 KeyIdentifier 的 DER（OCTET STRING）
                const inner = derRead(buf, val.contentStart);
                if (inner && inner.tag === TAG_OCTET_STRING)
                    return derContent(inner, buf);
            }
        }
    }
    return null;
}
/** ΑΩ-R5：signedAttrs 里找 messageDigest 属性值（RFC 5652 §5.3 —— 无 ⇒ null） */
function findMessageDigest(attrs, buf) {
    for (const attr of derChildren(attrs, buf)) {
        if (attr.tag !== TAG_SEQUENCE)
            continue;
        const k = derChildren(attr, buf);
        if (k.length >= 2 && k[0].tag === TAG_OID
            && bytesEqual(derContent(k[0], buf), DER_OID_ATTR_MESSAGE_DIGEST)
            && k[1].tag === TAG_SET) {
            const val = derChildren(k[1], buf).find(c => c.tag === TAG_OCTET_STRING);
            if (val)
                return derContent(val, buf);
        }
    }
    return null;
}
// ─── ΝΩ-21：genTime 执法的原料面（TSTInfo 权威时刻的离线提取） ───
//
// 台账原文（工单 ΝΩ-21 第 2 条）：「TSTInfo 里的 TSA 权威时刻从未被提取」——
// token 里被签名的 genTime 一直只是「字节躺在物证里」，锚核验层无从与本地钟
// 对照。细化 = 深度扫描器的可扩面：按 verifyTsaSignatureInner 同一走查路径定位
// eContent 里的 TSTInfo，取其第一个 GeneralizedTime（0x18）孩子即 genTime
// （RFC 3161 §5.1：TSTInfo ::= SEQUENCE{ version, policy, messageImprint,
// serialNumber, genTime GeneralizedTime, ... }——genTime 是唯一 0x18 孩子，
// 证书 validity 等干扰不在 TSTInfo 域内）。解码只收 Z 形态（RFC 3161 明示
// genTime MUST 用 Greenwich Mean Time 的 Z 形态；时区偏移形态 ⇒ null 诚实拒绝）。
/** GeneralizedTime 标签（UNIVERSAL 24） */
const TAG_GENERALIZED_TIME = 0x18;
/**
 * 定位 eContent 里的 TSTInfo 字节（ContentInfo→[0]SignedData→encapContentInfo
 * →[0]eContent→OCTET STRING 内容 —— 与签名验签同一走查路径的只读复用）。
 * 任何一步畸形 ⇒ null（调用方诚实缺席，绝不猜）。
 */
function locateTstInfo(token) {
    const root = derRead(token, 0);
    if (!root || root.tag !== TAG_SEQUENCE || root.end !== token.length)
        return null;
    const ci = derChildren(root, token);
    if (ci.length < 2 || ci[0].tag !== TAG_OID
        || !bytesEqual(derContent(ci[0], token), DER_OID_SIGNED_DATA)
        || ci[1].tag !== 0xa0)
        return null;
    const sdWrap = derChildren(ci[1], token).find(k => k.tag === TAG_SEQUENCE);
    if (!sdWrap)
        return null;
    const f = derChildren(sdWrap, token);
    if (f[0]?.tag !== TAG_INTEGER || f[1]?.tag !== TAG_SET)
        return null;
    const encap = f[2];
    if (!encap || encap.tag !== TAG_SEQUENCE)
        return null;
    const ec = derChildren(encap, token);
    if (ec.length < 2 || ec[1].tag !== 0xa0)
        return null;
    const octet = derChildren(ec[1], token).find(k => k.tag === TAG_OCTET_STRING);
    if (!octet)
        return null;
    return derContent(octet, token);
}
/**
 * GeneralizedTime 文本 → epoch ms（YYYYMMDDHH[MM[SS[.f…]]]Z —— 分钟/秒/小数
 * 秒可缺席， defensive 容忍；非 Z 形态/非数字/超域日期 ⇒ null 绝不抛）。
 */
function parseGeneralizedTime(text) {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})?(\d{2})?(?:\.(\d{1,9}))?Z$/.exec(text);
    if (!m)
        return null;
    const [, y, mo, d, h, mi, s, frac] = m;
    const ms = frac !== undefined ? Math.round(Number('0.' + frac) * 1000) : 0;
    const t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), mi !== undefined ? Number(mi) : 0, s !== undefined ? Number(s) : 0, ms);
    return Number.isFinite(t) ? t : null;
}
/**
 * ΝΩ-21：从留存的 TimeStampToken 提取 TSA 权威时刻 genTime（epoch ms；纯函数
 * 永不抛）。TSTInfo 不可定位 / genTime 缺席或畸形 ⇒ null（诚实缺席 —— 归因在
 * 锚核验层以注记呈现，本函数只报事实）。
 */
export function extractGenTime(token) {
    try {
        const tst = locateTstInfo(token);
        if (!tst)
            return null;
        const seq = derRead(tst, 0);
        if (!seq || seq.tag !== TAG_SEQUENCE || seq.end !== tst.length)
            return null;
        for (const k of derChildren(seq, tst)) {
            if (k.tag !== TAG_GENERALIZED_TIME)
                continue;
            return parseGeneralizedTime(Buffer.from(tst.subarray(k.contentStart, k.contentEnd)).toString('ascii'));
        }
        return null;
    }
    catch {
        return null; // 运行层铁律：提取崩溃 = 结构损坏的又一种形态，诚实缺席
    }
}
/**
 * ΑΩ-R5：TSA 签名离线验证（纯函数、永不抛 —— 一切结构意外归 'unparseable'）。
 * 入参是留存的 TimeStampToken（ContentInfo）；判决语义见 SignatureVerdict。
 * ΝΩ-21：pins —— TSA 信任锚 pin 表（SPKI sha256 hex 列表）。undefined ⇒ 读
 * env DSH_TSA_PIN_SHA256（生产默认）；null ⇒ 显式不钉扎（测试隔离缝）；数组 ⇒
 * 钉扎该表。表在场且验签成立 ⇒ 比对签名者 SPKI 指纹，未命中 ⇒ 'unpinned-key'。
 */
export function verifyTsaSignature(token, pins) {
    try {
        return verifyTsaSignatureInner(token, pins);
    }
    catch (e) {
        // 运行层铁律：验签崩溃 = 结构损坏的又一种形态，诚实降级绝不炸宿主
        return { verdict: 'unparseable', reason: `signature extraction crashed: ${msgOf(e)}` };
    }
}
function verifyTsaSignatureInner(token, pins) {
    // ContentInfo ::= SEQUENCE { contentType OID, content [0] ANY }
    const root = derRead(token, 0);
    if (!root || root.tag !== TAG_SEQUENCE || root.end !== token.length) {
        return { verdict: 'unparseable', reason: 'token is not one complete DER SEQUENCE (ContentInfo)' };
    }
    const ci = derChildren(root, token);
    if (ci.length < 2 || ci[0].tag !== TAG_OID
        || !bytesEqual(derContent(ci[0], token), DER_OID_SIGNED_DATA)) {
        return { verdict: 'unparseable', reason: 'ContentInfo contentType is not id-signedData — not a CMS SignedData token' };
    }
    if (ci[1].tag !== 0xa0) {
        return { verdict: 'unparseable', reason: 'ContentInfo lacks [0] content' };
    }
    const sdWrap = derChildren(ci[1], token).find(k => k.tag === TAG_SEQUENCE);
    if (!sdWrap) {
        return { verdict: 'unparseable', reason: '[0] content does not carry a SignedData SEQUENCE' };
    }
    // SignedData ::= SEQUENCE { version, digestAlgorithms SET, encapContentInfo,
    //                          certificates [0] OPTIONAL, crls [1] OPTIONAL, signerInfos SET }
    const f = derChildren(sdWrap, token);
    let i = 0;
    if (f[i]?.tag !== TAG_INTEGER)
        return { verdict: 'unparseable', reason: 'SignedData lacks version INTEGER' };
    i++;
    if (f[i]?.tag !== TAG_SET)
        return { verdict: 'unparseable', reason: 'SignedData lacks digestAlgorithms SET' };
    i++;
    const encap = f[i];
    if (!encap || encap.tag !== TAG_SEQUENCE) {
        return { verdict: 'unparseable', reason: 'SignedData lacks encapContentInfo SEQUENCE' };
    }
    i++;
    let certsNode = null;
    if (f[i]?.tag === 0xa0) {
        certsNode = f[i];
        i++;
    }
    if (f[i]?.tag === 0xa1)
        i++; // crls —— 验签用不到，跳过
    const signerInfos = f[i];
    if (!signerInfos || signerInfos.tag !== TAG_SET) {
        return { verdict: 'unparseable', reason: 'SignedData lacks signerInfos SET' };
    }
    // (c) 被签内容：eContent OCTET STRING 的内容 = TSTInfo 完整 DER
    const ec = derChildren(encap, token);
    if (ec.length < 2 || ec[1].tag !== 0xa0) {
        return { verdict: 'unparseable', reason: 'encapContentInfo lacks eContent [0] (token without TSTInfo bytes)' };
    }
    const octet = derChildren(ec[1], token).find(k => k.tag === TAG_OCTET_STRING);
    if (!octet) {
        return { verdict: 'unparseable', reason: 'eContent is not an OCTET STRING' };
    }
    const tstInfo = derContent(octet, token);
    // 内嵌证书集（[0] IMPLICIT CertificateSet —— 孩子们各是 Certificate SEQUENCE）
    const certs = [];
    if (certsNode) {
        for (const c of derChildren(certsNode, token)) {
            if (c.tag !== TAG_SEQUENCE)
                continue;
            const essence = parseCertificate(token, c);
            if (essence)
                certs.push(essence);
        }
    }
    // SignerInfo ::= SEQUENCE { version, sid, digestAlgorithm, signedAttrs [0] OPT,
    //                           signatureAlgorithm, signature, unsignedAttrs [1] OPT }
    const si = derChildren(signerInfos, token).find(k => k.tag === TAG_SEQUENCE);
    if (!si)
        return { verdict: 'unparseable', reason: 'signerInfos carries no SignerInfo SEQUENCE' };
    const s = derChildren(si, token);
    let j = 0;
    if (s[j]?.tag !== TAG_INTEGER)
        return { verdict: 'unparseable', reason: 'SignerInfo lacks version INTEGER' };
    j++;
    const sid = s[j];
    if (!sid || (sid.tag !== TAG_SEQUENCE && sid.tag !== 0x80)) {
        return { verdict: 'unparseable', reason: 'SignerInfo lacks a usable signer identifier (issuerAndSerialNumber/subjectKeyIdentifier)' };
    }
    j++;
    const digestAlg = s[j];
    if (!digestAlg || digestAlg.tag !== TAG_SEQUENCE) {
        return { verdict: 'unparseable', reason: 'SignerInfo lacks digestAlgorithm' };
    }
    j++;
    let signedAttrs = null;
    if (s[j]?.tag === 0xa0) {
        signedAttrs = s[j];
        j++;
    }
    const sigAlg = s[j];
    if (!sigAlg || sigAlg.tag !== TAG_SEQUENCE) {
        return { verdict: 'unparseable', reason: 'SignerInfo lacks signatureAlgorithm' };
    }
    j++;
    const sigNode = s[j];
    if (!sigNode || sigNode.tag !== TAG_OCTET_STRING) {
        return { verdict: 'unparseable', reason: 'SignerInfo lacks signature OCTET STRING' };
    }
    // 摘要/签名算法落界检查（sha256/384/512 × RSA PKCS#1 v1.5 / ECDSA 之外诚实申报）
    const digestOid = firstOid(digestAlg, token);
    if (!digestOid)
        return { verdict: 'unparseable', reason: 'digestAlgorithm carries no OID' };
    const hashName = mapDigestOid(digestOid);
    if (!hashName) {
        return { verdict: 'unsupported-alg', reason: `digest ${oidText(digestOid)} outside the sha256/384/512 boundary` };
    }
    const sigOid = firstOid(sigAlg, token);
    if (!sigOid)
        return { verdict: 'unparseable', reason: 'signatureAlgorithm carries no OID' };
    const family = mapSigAlgOid(sigOid, hashName);
    if (family === null) {
        return { verdict: 'unsupported-alg', reason: `signature algorithm ${oidText(sigOid)} outside RSA PKCS#1 v1.5 / ECDSA (sha256/384/512)` };
    }
    if (family === 'mismatch') {
        return { verdict: false, reason: 'signatureAlgorithm hash family contradicts digestAlgorithm (CMS SignedData inconsistent)' };
    }
    // (a) 签名者证书：sid ↔ 内嵌证书逐位匹配 —— 唯一寻径。
    //     ΝΩ-21：原「匹配不上但仅一枚证书 ⇒ 单证书回退」已删除。回退的善意解释
    //     是容忍编码方言致 sid 失配的真锚，但在「不做信任锚验证」的既有边界下，
    //     它同时是伪造向量：控制 endpoint 者自造证书 + 自签 TSTInfo（sid 随手指
    //     向任何 issuer/serial），回退照样把这枚伪证书当签名者 —— signatureVerified
    //     纯靠「endpoint 恰好只回发一张证书」这个攻击者自选的条件成立。sid 失配
    //     ⇒ 诚实 'unparseable'（不猜签名者是谁；真 TSA 的方言失配属结构性边界，
    //     由外部验签器/pin 部署侧消化，本客户端绝不替 endpoint 圆谎）。
    if (certs.length === 0) {
        return { verdict: 'unparseable', reason: 'no certificates embedded in token (certReq=FALSE?) — offline signature verification lacks the signer key' };
    }
    let signer = null;
    if (sid.tag === TAG_SEQUENCE) {
        const k = derChildren(sid, token);
        if (k.length < 2 || k[0].tag !== TAG_SEQUENCE || k[1].tag !== TAG_INTEGER) {
            return { verdict: 'unparseable', reason: 'signer identifier is a malformed issuerAndSerialNumber' };
        }
        const wantSerial = normalizeUint(derContent(k[1], token));
        const wantIssuer = token.slice(k[0].start, k[0].end);
        signer = certs.find(c => bytesEqual(normalizeUint(c.serial), wantSerial)
            && bytesEqual(c.issuerDer, wantIssuer)) ?? null;
    }
    else {
        // [0] IMPLICIT subjectKeyIdentifier —— 与证书扩展 2.5.29.14 逐位对照
        const ski = derContent(sid, token);
        signer = certs.find(c => c.ski !== null && bytesEqual(c.ski, ski)) ?? null;
    }
    if (!signer) {
        return { verdict: 'unparseable', reason: 'signer certificate not found among the embedded certificates — sid (issuerAndSerialNumber/subjectKeyIdentifier) matches none; the single-cert fallback was removed as a forgery vector (ΝΩ-21)' };
    }
    // SPKI → 公钥（喂 node:crypto；拒收 ⇒ 证书本质损坏，诚实 'unparseable'）
    let pubKey;
    try {
        pubKey = createPublicKey({
            key: Buffer.from(signer.spkiDer.buffer, signer.spkiDer.byteOffset, signer.spkiDer.byteLength),
            format: 'der',
            type: 'spki',
        });
    }
    catch (e) {
        return { verdict: 'unparseable', reason: `signer SubjectPublicKeyInfo rejected by crypto: ${msgOf(e)}` };
    }
    const keyKind = pubKey.asymmetricKeyType;
    if (family === 'rsa' && keyKind !== 'rsa') {
        return { verdict: false, reason: `signatureAlgorithm says RSA but the signer key is ${keyKind}` };
    }
    if (family === 'ecdsa' && keyKind !== 'ec') {
        return { verdict: false, reason: `signatureAlgorithm says ECDSA but the signer key is ${keyKind}` };
    }
    // (b) 签名值 + 被签字节：signedAttrs 在场 ⇒ [0]→SET(0x31) 重编码（RFC 5652 §5.4）
    //     且 messageDigest 属性必须 == hash(eContent) —— 签名绑死到正确的内容字节；
    //     缺席 ⇒ 直接对 eContent（TSTInfo DER）验签。
    const signature = derContent(sigNode, token);
    let signedBytes;
    if (signedAttrs) {
        signedBytes = derEncode(TAG_SET, derContent(signedAttrs, token));
        const md = findMessageDigest(signedAttrs, token);
        if (!md) {
            return { verdict: 'unparseable', reason: 'signedAttrs present but messageDigest attribute absent (RFC 5652 §5.3 violation)' };
        }
        const actual = createHash(hashName).update(tstInfo).digest();
        if (!bytesEqual(md, actual)) {
            return { verdict: false, reason: 'messageDigest attribute != hash(eContent) — signed content does not match the carried TSTInfo' };
        }
    }
    else {
        signedBytes = tstInfo;
    }
    let okSig;
    try {
        // ECDSA：CMS 存 DER(r,s) —— verify 缺省 dsaEncoding='der' 恰同形态；
        // RSA：缺省 padding 即 PKCS#1 v1.5。
        okSig = family === 'ecdsa'
            ? cryptoVerify(hashName, signedBytes, { key: pubKey, dsaEncoding: 'der' }, signature)
            : cryptoVerify(hashName, signedBytes, pubKey, signature);
    }
    catch (e) {
        return { verdict: false, reason: `crypto.verify rejected the material: ${msgOf(e)}` };
    }
    if (!okSig) {
        return { verdict: false, reason: 'signature does not verify under the embedded signer key (forged or corrupted)' };
    }
    // ΝΩ-21（可选强加固）：TSA 信任锚 pin —— 验签数学成立后，若 DSH_TSA_PIN_SHA256
    // pin 表在场（env 或显式注入），比对签名者证书 SPKI 指纹：未命中 ⇒ 判决降为
    // 'unpinned-key'（签名是真的，但签的不是被钉住的 TSA —— 控制.endpoint 者自造
    // 证书即止步于此）。pin 缺席 ⇒ 维持既有诚实边界（信任锚定属外部验签器职权，
    // 如实不假装已验身份）。比对放在验签之后：pin 只降级「成立」的签名，绝不把
    // 失败签名翻绿。
    const pinTable = pins !== undefined ? pins : parseTsaPinList(process.env[TSA_PIN_ENV_KEY]);
    if (pinTable !== null) {
        const spkiSha = createHash('sha256').update(signer.spkiDer).digest('hex');
        if (!pinTable.includes(spkiSha)) {
            return {
                verdict: 'unpinned-key',
                reason: `signer SPKI sha256 ${spkiSha.slice(0, 16)}… is not among the ${pinTable.length} pinned TSA key(s) (${TSA_PIN_ENV_KEY}) — signature math holds but the signer is not a pinned trust anchor`,
            };
        }
    }
    return { verdict: true };
}
/**
 * 解析并核验 TimeStampResp（永不动网络、永不抛 —— 纯函数，测试可确定性复跑）。
 *
 * TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken OPTIONAL }
 * 走法：顶层 [0] 是 PKIStatusInfo（status INTEGER 非 0/1 ⇒ TSA 拒签，诚实失败）；
 * 顶层 [1]（若在）即 TimeStampToken 的完整 TLV —— 原样切出留存。
 * ΑΩ-R5：token 在场 ⇒ 同时做 TSA 签名离线判决（signatureVerified —— 领取时
 * 即验、随锚入册；与 ok 正交，绝不因验签失败改判 ok 或抛异常）。
 */
export function parseTimestampReply(reply, expected, pins) {
    const base = { imprintMatch: false, nonceMatch: false, token: null, pkiStatus: null };
    const root = derRead(reply, 0);
    if (!root || root.tag !== TAG_SEQUENCE || root.end !== reply.length) {
        return { ...base, ok: false, error: 'reply is not one complete DER SEQUENCE (TimeStampResp)' };
    }
    const top = derChildren(root, reply);
    if (top.length === 0)
        return { ...base, ok: false, error: 'empty TimeStampResp' };
    // PKIStatusInfo ::= SEQUENCE { status INTEGER, statusString OPTIONAL, failInfo OPTIONAL }
    const statusKids = derChildren(top[0], reply);
    const statusNode = statusKids.find(n => n.tag === TAG_INTEGER) ?? null;
    if (!statusNode)
        return { ...base, ok: false, error: 'PKIStatusInfo lacks INTEGER status' };
    const pkiStatus = readDerInt(reply, statusNode);
    if (pkiStatus !== 0 && pkiStatus !== 1) {
        return {
            ...base, ok: false, pkiStatus,
            error: `PKIStatus ${pkiStatus} — TSA did not grant (2=rejection, 4+ = waiting/revoked/unknown)`,
        };
    }
    const tokenNode = top.length > 1 ? top[1] : null;
    const token = tokenNode ? reply.slice(tokenNode.start, tokenNode.end) : null;
    const sig = token ? verifyTsaSignature(token, pins) : null; // ΑΩ-R5：领取时即做离线判决
    const sigFields = sig
        ? { signatureVerified: sig.verdict, ...(sig.verdict !== true ? { signatureError: sig.reason } : {}) }
        : {};
    // ΝΩ-21：TSA 权威时刻随领取面一并提取（anchoredAt 只是本地钟 —— 与 genTime
    // 的偏差校验是锚核验层的职责，此处只透传事实字段）
    const genField = token ? { genTime: extractGenTime(token) } : {};
    const { imprintMatch, nonceMatch } = scanImprintAndNonce(reply, expected);
    if (!imprintMatch) {
        return { ...base, ...sigFields, ...genField, ok: false, imprintMatch, nonceMatch, token, pkiStatus, error: 'messageImprint mismatch — reply does not bind our sha256 digest' };
    }
    if (!nonceMatch) {
        return { ...base, ...sigFields, ...genField, ok: false, imprintMatch, nonceMatch, token, pkiStatus, error: 'nonce mismatch — reply not bound to this request (possible cross-wiring/replay)' };
    }
    if (!token) {
        return { ...base, ok: false, imprintMatch, nonceMatch, token: null, pkiStatus, error: 'granted but TimeStampToken absent — nothing to retain as receipt' };
    }
    return { ok: true, ...sigFields, ...genField, imprintMatch, nonceMatch, token, pkiStatus };
}
/**
 * 离线复核留存的 TimeStampToken（锚记录 ③-c 的核验原语）。
 * 与 parseTimestampReply 的分工：token 是 ContentInfo（SEQUENCE{ OID, [0] TSTInfo }），
 * 不含 PKIStatusInfo（状态属响应信封，不在物证里 —— 信封级结论在领取时已下）；
 * 此处做物证级核验：① imprint 与 nonce 是否仍然绑定锚载荷摘要；② ΑΩ-R5 ——
 * TSA 签名离线判决（signatureVerified，与 ok 正交上报：绑定与背书是两个维度，
 * 验签失败不改 ok、不抛异常 —— 误绿防线在「判绿只认 true」）。永不抛。
 */
export function verifyTimestampToken(token, expected, pins) {
    const sig = verifyTsaSignature(token, pins); // ΑΩ-R5：先判结构再验签 —— 两维度独立取证
    const sigFields = {
        signatureVerified: sig.verdict,
        ...(sig.verdict !== true ? { signatureError: sig.reason } : {}),
    };
    // ΝΩ-21：TSA 权威时刻的离线提取（与绑定/背书两维度正交 —— 提取失败不牵连）
    const genTime = extractGenTime(token);
    const root = derRead(token, 0);
    if (!root || root.tag !== TAG_SEQUENCE || root.end !== token.length) {
        return { ...sigFields, genTime, ok: false, imprintMatch: false, nonceMatch: false, error: 'token is not one complete DER SEQUENCE (ContentInfo)' };
    }
    const { imprintMatch, nonceMatch } = scanImprintAndNonce(token, expected);
    if (!imprintMatch) {
        return { ...sigFields, genTime, ok: false, imprintMatch, nonceMatch, error: 'token messageImprint mismatch — receipt does not bind the anchor payload digest' };
    }
    if (!nonceMatch) {
        return { ...sigFields, genTime, ok: false, imprintMatch, nonceMatch, error: 'token nonce mismatch — receipt not bound to this anchor mint' };
    }
    return { ...sigFields, genTime, ok: true, imprintMatch, nonceMatch };
}
/**
 * 一锤子买卖：POST application/timestamp-query，5s 超时、单次尝试。
 * 任何失败（网络/TSA 拒签/imprint 不符）→ {ok:false, error}，绝不抛 ——
 * 调用方（notary.anchorOnce）据此做诚实本地回退 + 注记，绝不谎称第三方背书。
 */
export async function requestRfc3161Timestamp(opts) {
    try {
        const doFetch = opts.fetchImpl ?? fetch;
        const res = await doFetch(opts.endpoint, {
            method: 'POST',
            headers: {
                'content-type': 'application/timestamp-query',
                accept: 'application/timestamp-reply',
            },
            body: buildTimestampRequest(opts.digest, opts.nonce),
            signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
        });
        if (!res.ok)
            return { ok: false, error: `TSA HTTP ${res.status}` };
        const reply = new Uint8Array(await res.arrayBuffer());
        const parsed = parseTimestampReply(reply, { digest: opts.digest, nonce: opts.nonce });
        if (!parsed.ok || !parsed.token) {
            return { ok: false, error: parsed.error ?? 'unparsed timestamp reply' };
        }
        return { ok: true, token: parsed.token, signatureVerified: parsed.signatureVerified ?? 'unparseable' };
    }
    catch (e) {
        // 超时（AbortError）/网络拒绝/响应畸形统一归档为错误事实（不含堆栈）
        return { ok: false, error: e?.message ?? String(e) };
    }
}
