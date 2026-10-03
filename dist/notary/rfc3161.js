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
//   · 不做证书链验证、不做 TSA 签名验证、不校验 genTime 合理性 ——
//     imprintVerified=true 的语义是「时间戳回执在册且绑定本请求」，
//     不是「TSA 身份已验」。要完整验签请导出 token 交给离线验签器
//     （certReq=true 使回执内嵌证书，正是为这条离线路径准备的）。
//   · 不定长（BER 0x80 长度）拒绝解码 —— 只接受 DER 定长形态（主流 TSA 均为 DER）。
// 网络纪律（与 swarm.fireUpload 同律）：5s 超时、单次尝试、失败诚实返回 ——
// 公证是旁路仪式，TSA 不可达绝不演变成第三方背书，更不允许炸宿主。
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
 */
function scanImprintAndNonce(buf, expected) {
    let imprintMatch = false;
    let nonceMatch = false;
    const wantNonce = normalizeUint(expected.nonce);
    const stack = [];
    const root = derRead(buf, 0);
    if (root)
        stack.push(root);
    while (stack.length > 0) {
        const node = stack.pop();
        if (node.tag === TAG_INTEGER && bytesEqual(normalizeUint(derContent(node, buf)), wantNonce)) {
            nonceMatch = true;
        }
        if ((node.tag & 0x20) !== 0) {
            const kids = derChildren(node, buf);
            for (let i = 0; i + 1 < kids.length; i++) {
                const a = kids[i], b = kids[i + 1];
                if (a.tag === TAG_SEQUENCE && b.tag === TAG_OCTET_STRING) {
                    const aKids = derChildren(a, buf);
                    if (aKids.length > 0 && aKids[0].tag === TAG_OID
                        && bytesEqual(derContent(aKids[0], buf), DER_OID_SHA256)
                        && bytesEqual(derContent(b, buf), expected.digest)) {
                        imprintMatch = true;
                    }
                }
            }
            for (const k of kids)
                stack.push(k);
        }
    }
    return { imprintMatch, nonceMatch };
}
/**
 * 解析并核验 TimeStampResp（永不动网络、永不抛 —— 纯函数，测试可确定性复跑）。
 *
 * TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken OPTIONAL }
 * 走法：顶层 [0] 是 PKIStatusInfo（status INTEGER 非 0/1 ⇒ TSA 拒签，诚实失败）；
 * 顶层 [1]（若在）即 TimeStampToken 的完整 TLV —— 原样切出留存。
 */
export function parseTimestampReply(reply, expected) {
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
    const { imprintMatch, nonceMatch } = scanImprintAndNonce(reply, expected);
    if (!imprintMatch) {
        return { ok: false, imprintMatch, nonceMatch, token, pkiStatus, error: 'messageImprint mismatch — reply does not bind our sha256 digest' };
    }
    if (!nonceMatch) {
        return { ok: false, imprintMatch, nonceMatch, token, pkiStatus, error: 'nonce mismatch — reply not bound to this request (possible cross-wiring/replay)' };
    }
    if (!token) {
        return { ok: false, imprintMatch, nonceMatch, token: null, pkiStatus, error: 'granted but TimeStampToken absent — nothing to retain as receipt' };
    }
    return { ok: true, imprintMatch, nonceMatch, token, pkiStatus };
}
/**
 * 离线复核留存的 TimeStampToken（锚记录 ③-c 的核验原语）。
 * 与 parseTimestampReply 的分工：token 是 ContentInfo（SEQUENCE{ OID, [0] TSTInfo }），
 * 不含 PKIStatusInfo（状态属响应信封，不在物证里 —— 信封级结论在领取时已下）；
 * 此处只做物证级核验：imprint 与 nonce 是否仍然绑定锚载荷摘要。永不抛。
 */
export function verifyTimestampToken(token, expected) {
    const root = derRead(token, 0);
    if (!root || root.tag !== TAG_SEQUENCE || root.end !== token.length) {
        return { ok: false, imprintMatch: false, nonceMatch: false, error: 'token is not one complete DER SEQUENCE (ContentInfo)' };
    }
    const { imprintMatch, nonceMatch } = scanImprintAndNonce(token, expected);
    if (!imprintMatch) {
        return { ok: false, imprintMatch, nonceMatch, error: 'token messageImprint mismatch — receipt does not bind the anchor payload digest' };
    }
    if (!nonceMatch) {
        return { ok: false, imprintMatch, nonceMatch, error: 'token nonce mismatch — receipt not bound to this anchor mint' };
    }
    return { ok: true, imprintMatch, nonceMatch };
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
        return { ok: true, token: parsed.token };
    }
    catch (e) {
        // 超时（AbortError）/网络拒绝/响应畸形统一归档为错误事实（不含堆栈）
        return { ok: false, error: e?.message ?? String(e) };
    }
}
