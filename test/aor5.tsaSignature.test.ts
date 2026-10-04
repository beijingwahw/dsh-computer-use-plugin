// test/aor5.tsaSignature.test.ts
// ΑΩ-R5 执法册 —— notary TSA 签名离线验证（诚实边界升级）：
//   S-1 验签通过：RSA PKCS#1 v1.5 + signedAttrs（RFC 5652 §5.4 [0]→SET 字节）⇒
//      verifyTimestampToken 全绿含 signatureVerified=true；无 signedAttrs 直签
//      TSTInfo 同律通过；sha384/sha512 摘要族亦过
//   S-2 篡改签名一字节 ⇒ false（绝不误绿）；ok 绑定维度不受牵连
//   S-3 结构损坏（垃圾/截断/非 CMS 旧 mock 形态）⇒ 'unparseable' 且绝不抛
//   S-4 ECDSA（P-256，CMS 原生 DER r,s）⇒ true；篡改 ⇒ false
//   S-5 算法边界外（sha1 摘要 / rsaPSS 签名）⇒ 'unsupported-alg' 诚实申报
//   S-6 sid 变体：[0] subjectKeyIdentifier 匹配 ⇒ true；issuerAndSerial 失配 ⇒
//      'unparseable'（ΝΩ-21：单证书回退已删除 —— sid 失配是伪造向量不再是容错面）
//   S-7 内容被换（genTime 年份 +1）⇒ messageDigest 属性对不上 ⇒ false
//   S-8 端到端（真 notary + 假 TSA 回真 CMS token）：判决随锚入册、章③注记在场、
//      报告 lastAnchor.signatureVerified=true
//   S-9 端到端伪造（错钥签名 + 正确 imprint+nonce）：锚载 signatureVerified=false、
//      章③保守语义 —— 不翻红但 FAILED/UNPROVEN 注记在场、报告字段如实
//  ΝΩ-21 追加：
//   S-11 genTime 执法：正常提取（±1h 内注记在场 + 报告 genTime 字段）/ 偏差
//      （+2h ⇒ genTime-skew 注记、章不翻红）/ 不可提取（垃圾 token ⇒ null）
//   S-12 TSA 信任锚 pin（DSH_TSA_PIN_SHA256）：命中 ⇒ true；未命中 ⇒
//      'unpinned-key'（签名数学成立的降级判决）；env 端到端 + 锚载/报告透传
// 全离线：generateKeyPairSync 自铸密钥 + 手工 DER 编码器（零真网络、零真 TSA）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign, type KeyObject } from 'node:crypto';

import { derEncode, derRead, derChildren, verifyTsaSignature, verifyTimestampToken, extractGenTime, parseTsaPinList, TSA_PIN_ENV_KEY } from '../src/notary/rfc3161.ts';
import { notary, canonical, sha256Hex } from '../src/notary/index.ts';
import { journal } from '../src/journal.ts';
import { sandboxLog } from '../src/sandbox/log.ts';

// ─── 测试用小型 DER 编码器（本册自铸 CMS/SignedData 的唯一构造面） ───

const enc = new TextEncoder();

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
const derInt = (bytes: number[]): Uint8Array => derEncode(0x02, Uint8Array.from(bytes));
const derOid = (arms: number[]): Uint8Array => derEncode(0x06, Uint8Array.from(arms));
const derOct = (b: Uint8Array): Uint8Array => derEncode(0x04, b);
const derSeq = (...parts: Uint8Array[]): Uint8Array => derEncode(0x30, cat(...parts));
const derSet = (...parts: Uint8Array[]): Uint8Array => derEncode(0x31, cat(...parts));
const derA0 = (b: Uint8Array): Uint8Array => derEncode(0xa0, b);
const derA3 = (b: Uint8Array): Uint8Array => derEncode(0xa3, b);

// ─── OID 弧（与 src/notary/rfc3161.ts 常量同源 —— 测试侧独立复刻作双执法） ───

const SHA256 = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
const SHA384 = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02];
const SHA512 = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x03];
const SHA1 = [0x2b, 0x0e, 0x03, 0x02, 0x1a];
const RSA_ENC = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const RSA_PSS = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0a];
const ECDSA_SHA256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
const ID_SIGNED_DATA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02];
const ID_CT_TSTINFO = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x01, 0x04];
const ATTR_MSG_DIGEST = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x04];
const ATTR_CONTENT_TYPE = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x03];
const EXT_SKI = [0x55, 0x1d, 0x0e];
const CN = [0x55, 0x04, 0x03];

// ─── 自铸密钥（模块级一次 —— RSA 正主张 / RSA 伪造者 / EC P-256） ───

const rsaKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaSpki = new Uint8Array(rsaKeys.publicKey.export({ format: 'der', type: 'spki' }));
const rsaForger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ecKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ecSpki = new Uint8Array(ecKeys.publicKey.export({ format: 'der', type: 'spki' }));
const KEY_ID = (() => { const b = new Uint8Array(20); for (let i = 0; i < 20; i++) b[i] = i + 1; return b; })(); // 伪 subjectKeyIdentifier

const DIGEST = new Uint8Array(createHash('sha256').update('aor5-anchor-payload').digest());
const NONCE = Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10]);

// ─── CMS 构件：Name / Certificate / TSTInfo / SignedData token ───

const NAME = derSeq(derEncode(0x31, derSeq(derOid(CN), derEncode(0x13, enc.encode('Mock TSA')))));

/** 最小 X.509 形证书（占位自签形态 —— 验证器只取 serial/issuer/SPKI/SKI 本质） */
function buildCert(spkiDer: Uint8Array, ski?: Uint8Array): Uint8Array {
  const validity = derSeq(
    derEncode(0x17, enc.encode('260102030405Z')),
    derEncode(0x17, enc.encode('350102030405Z')),
  );
  const parts: Uint8Array[] = [
    derInt([0x01]), derSeq(derOid(RSA_ENC)), NAME, validity, NAME, spkiDer,
  ];
  if (ski) parts.push(derA3(derSeq(derSeq(derOid(EXT_SKI), derOct(derOct(ski))))));
  const tbs = derSeq(...parts);
  // 签名算法 + BIT STRING 占位（本验证器不验证书自身签名 —— 信任锚定属外部职权）
  return derSeq(tbs, derSeq(derOid(RSA_ENC)), derEncode(0x03, Uint8Array.of(0x00)));
}

function buildTstInfo(digest: Uint8Array, nonce: Uint8Array, genTimeText = '20260102030405Z'): Uint8Array {
  return derSeq(
    derInt([1]),
    derOid(ID_CT_TSTINFO),
    derSeq(derSeq(derOid(SHA256)), derOct(digest)),  // messageImprint
    derInt([0x0a]),                                   // serialNumber
    derEncode(0x18, enc.encode(genTimeText)),         // genTime（ΝΩ-21：可注入 —— 偏差实验缝）
    derEncode(0x02, nonce),                           // nonce 回显
  );
}

interface CmsSpec {
  digest: Uint8Array;
  nonce: Uint8Array;
  hashName: 'sha256' | 'sha384' | 'sha512';
  digestOid: number[];
  sigOid: number[];
  signerPriv: KeyObject;
  signerSpki: Uint8Array;
  signedAttrs: boolean;
  /** 在场 ⇒ sid 用 [0] subjectKeyIdentifier；缺席 ⇒ issuerAndSerialNumber */
  skiSid?: Uint8Array;
  /** issuerAndSerial 的 serial（缺省与证书一致 [0x01]） */
  sidSerial?: number[];
  /** ΝΩ-21：genTime 文本（缺省 '20260102030405Z' —— 与注入时钟的偏差实验缝） */
  genTimeText?: string;
  /** 签名实现覆盖（篡改一字节 / 错钥伪造实验） */
  signOverride?: (data: Uint8Array) => Uint8Array;
  /** 嵌入内容篡改（签名与 messageDigest 属性仍对原文 —— 换内容不换签） */
  contentOverride?: (tst: Uint8Array) => Uint8Array;
}

const rsaSpec = (over: Partial<CmsSpec> = {}): CmsSpec => ({
  digest: DIGEST, nonce: NONCE,
  hashName: 'sha256', digestOid: SHA256, sigOid: RSA_ENC,
  signerPriv: rsaKeys.privateKey, signerSpki: rsaSpki,
  signedAttrs: true,
  ...over,
});

/** 手工铸一枚完整 CMS SignedData token（ContentInfo{id-signedData, [0] SignedData}） */
function buildCmsToken(spec: CmsSpec): Uint8Array {
  const tstSigned = buildTstInfo(spec.digest, spec.nonce, spec.genTimeText);
  const tstEmbedded = spec.contentOverride ? spec.contentOverride(tstSigned) : tstSigned;
  let signedBytes: Uint8Array;
  let attrs: Uint8Array | null = null;
  if (spec.signedAttrs) {
    const md = createHash(spec.hashName).update(tstSigned).digest();
    attrs = cat(
      derSeq(derOid(ATTR_CONTENT_TYPE), derSet(derOid(ID_CT_TSTINFO))),
      derSeq(derOid(ATTR_MSG_DIGEST), derSet(derOct(md))),
    );
    signedBytes = derEncode(0x31, attrs); // [0]→SET(0x31) 重编码 —— 验签绑定的字节
  } else {
    signedBytes = tstSigned; // 无属性 ⇒ 直接对 eContent（TSTInfo DER）签名
  }
  const doSign = spec.signOverride
    ?? ((data: Uint8Array) => new Uint8Array(sign(spec.hashName, data, spec.signerPriv)));
  const signature = doSign(signedBytes);
  const cert = buildCert(spec.signerSpki, spec.skiSid ? KEY_ID : undefined);
  const sid = spec.skiSid
    ? derEncode(0x80, spec.skiSid) // [0] IMPLICIT KeyIdentifier（原始字节）
    : derSeq(NAME, derInt(spec.sidSerial ?? [0x01]));
  const signerInfo = derSeq(
    derInt([1]),
    sid,
    derSeq(derOid(spec.digestOid)),
    ...(spec.signedAttrs && attrs ? [derA0(attrs)] : []),
    derSeq(derOid(spec.sigOid)),
    derOct(signature),
  );
  const signedData = derSeq(
    derInt([1]),                                        // version
    derSet(derSeq(derOid(spec.digestOid))),             // digestAlgorithms
    derSeq(derOid(ID_CT_TSTINFO), derA0(derOct(tstEmbedded))), // encapContentInfo
    derA0(cert),                                        // certificates [0]
    derSet(signerInfo),                                 // signerInfos
  );
  return derSeq(derOid(ID_SIGNED_DATA), derA0(signedData));
}

/** 篡改实验：真签名翻转末字节（单字节篡改 —— 确定性） */
function tamperSign(data: Uint8Array): Uint8Array {
  const sig = new Uint8Array(sign('sha256', data, rsaKeys.privateKey));
  sig[sig.length - 1] ^= 0x01;
  return sig;
}

/** 伪造实验：另一把 RSA 钥签名（证书仍嵌正主张 —— 恶意 endpoint 场景） */
function forgeSign(data: Uint8Array): Uint8Array {
  return new Uint8Array(sign('sha256', data, rsaForger.privateKey));
}

/** 换内容实验：嵌入的 TSTInfo genTime 年份 2026→2027（签名/摘要属性留在原文上） */
function bumpGenYear(t: Uint8Array): Uint8Array {
  const out = Uint8Array.from(t);
  const idx = Buffer.from(out.buffer, out.byteOffset, out.byteLength).toString('latin1').indexOf('2026');
  assert.ok(idx >= 0, '测试装置：genTime 标记在场');
  out[idx + 3] = 0x37;
  return out;
}

// ─── S-1 验签通过 ───

test('ΑΩ-R5 S-1: RSA PKCS#1 v1.5 + signedAttrs ⇒ signatureVerified=true（含无属性直签与 sha384/512 族）', () => {
  // 主形态：signedAttrs（真实 TSA 的常态 —— contentType + messageDigest）
  const token = buildCmsToken(rsaSpec());
  const v = verifyTimestampToken(token, { digest: DIGEST, nonce: NONCE });
  assert.equal(v.ok, true, '绑定维度：imprint+nonce 对上');
  assert.equal(v.imprintMatch, true);
  assert.equal(v.nonceMatch, true);
  assert.equal(v.signatureVerified, true, '签名维度：内嵌证书对 TSTInfo 的签名成立');
  assert.equal(v.signatureError, undefined, '判绿不携归因');

  // 变体 1：无 signedAttrs ⇒ 直接对 eContent（TSTInfo DER）验签
  const bare = buildCmsToken(rsaSpec({ signedAttrs: false }));
  assert.equal(verifyTsaSignature(bare).verdict, true, '无属性直签同律通过');

  // 变体 2/3：sha384 / sha512 摘要族（RSA 同钥）
  for (const [oid, hashName] of [[SHA384, 'sha384'], [SHA512, 'sha512']] as const) {
    const t = buildCmsToken(rsaSpec({ digestOid: oid as number[], hashName }));
    assert.equal(verifyTsaSignature(t).verdict, true, `${hashName} 摘要族验签通过`);
  }
});

// ─── S-2 篡改签名一字节 ⇒ false ───

test('ΑΩ-R5 S-2: 签名翻转一字节 ⇒ signatureVerified=false（绝不误绿）；绑定维度不受牵连', () => {
  const token = buildCmsToken(rsaSpec({ signOverride: tamperSign }));
  const direct = verifyTsaSignature(token);
  assert.equal(direct.verdict, false);
  assert.ok(direct.reason, '失败归因在场');

  const v = verifyTimestampToken(token, { digest: DIGEST, nonce: NONCE });
  assert.equal(v.signatureVerified, false, '篡改签名 ⇒ 验过而败');
  assert.equal(v.ok, true, 'imprint+nonce 绑定仍是事实（两维度正交上报）');
  assert.equal(v.signatureError !== undefined, true, '归因随判携带');
});

// ─── S-3 结构损坏 ⇒ unparseable 且绝不抛 ───

test('ΑΩ-R5 S-3: 垃圾/截断/非 CMS 旧 mock 形态 ⇒ unparseable，绝不抛异常', () => {
  const garbage = new Uint8Array(64).map((_, i) => (i * 7) & 0xff);
  const empty = new Uint8Array(0);
  const truncated = buildCmsToken(rsaSpec()).slice(0, 40); // 半个 TLV
  // 旧 mock 形态：ContentInfo{id-ct-TSTInfo, [0] TSTInfo} —— 非 CMS SignedData
  const legacyMock = derSeq(derOid(ID_CT_TSTINFO), derA0(buildTstInfo(DIGEST, NONCE)));

  for (const [name, bytes] of [['garbage', garbage], ['empty', empty], ['truncated', truncated], ['legacy-non-cms', legacyMock]] as const) {
    let r: ReturnType<typeof verifyTsaSignature> | null = null;
    assert.doesNotThrow(() => { r = verifyTsaSignature(bytes); }, `${name} 不抛`);
    assert.equal(r!.verdict, 'unparseable', `${name} ⇒ unparseable`);
    assert.ok(r!.reason, `${name} 归因在场`);
  }

  // 验证面同律：verifyTimestampToken 对垃圾物证不炸、绑定红、签名 unparseable
  let v: ReturnType<typeof verifyTimestampToken> | null = null;
  assert.doesNotThrow(() => { v = verifyTimestampToken(garbage, { digest: DIGEST, nonce: NONCE }); });
  assert.equal(v!.ok, false);
  assert.equal(v!.signatureVerified, 'unparseable');
  assert.ok(v!.error, '绑定维度失败理由在场');
});

// ─── S-4 ECDSA ───

test('ΑΩ-R5 S-4: ECDSA P-256（CMS 原生 DER r,s）⇒ true；篡改 ⇒ false', () => {
  const good = buildCmsToken(rsaSpec({
    signerPriv: ecKeys.privateKey, signerSpki: ecSpki, sigOid: ECDSA_SHA256,
  }));
  assert.equal(verifyTsaSignature(good).verdict, true, 'ECDSA 验签通过');

  const bad = buildCmsToken(rsaSpec({
    signerPriv: ecKeys.privateKey, signerSpki: ecSpki, sigOid: ECDSA_SHA256,
    signOverride: (data) => {
      const sig = new Uint8Array(sign('sha256', data, ecKeys.privateKey));
      sig[sig.length - 1] ^= 0x01;
      return sig;
    },
  }));
  assert.equal(verifyTsaSignature(bad).verdict, false, 'ECDSA 签名篡改 ⇒ false');
});

// ─── S-5 算法边界外 ⇒ unsupported-alg ───

test('ΑΩ-R5 S-5: sha1 摘要 / rsaPSS 签名 ⇒ unsupported-alg（诚实申报，不硬验不虚绿）', () => {
  const sha1 = buildCmsToken(rsaSpec({ digestOid: SHA1 }));
  const r1 = verifyTsaSignature(sha1);
  assert.equal(r1.verdict, 'unsupported-alg');
  assert.match(r1.reason ?? '', /sha1|1\.3\.14/);

  const pss = buildCmsToken(rsaSpec({ sigOid: RSA_PSS }));
  const r2 = verifyTsaSignature(pss);
  assert.equal(r2.verdict, 'unsupported-alg');
  assert.match(r2.reason ?? '', /rsaPSS|1\.2\.840\.113549\.1\.1\.10/);
});

// ─── S-6 sid 变体：SKI 匹配 + 失配即拒（ΝΩ-21：单证书回退已删除） ───

test('ΑΩ-R5 S-6: [0] subjectKeyIdentifier 匹配 ⇒ true；issuerAndSerial 失配 ⇒ unparseable（回退已删 —— 失配是伪造向量）', () => {
  const skiSid = buildCmsToken(rsaSpec({ skiSid: KEY_ID }));
  assert.equal(verifyTsaSignature(skiSid).verdict, true, 'SKI 型 sid 与证书扩展 2.5.29.14 对上');

  // ΝΩ-21：serial 对不上任何证书（控制 endpoint 者自造证书 + 随手 sid 的形态）⇒
  // 诚实 'unparseable' —— 原「唯一证书回退」让伪证书凭「恰好只回发一张」入选，
  // 配合无信任锚验证即 signatureVerified:true，已按工单删除。
  const mismatch = buildCmsToken(rsaSpec({ sidSerial: [0x99] }));
  const r = verifyTsaSignature(mismatch);
  assert.equal(r.verdict, 'unparseable', 'sid 失配 ⇒ 不猜签名者（单证书回退已删）');
  assert.match(r.reason ?? '', /matches none|fallback was removed/, '归因申报回退删除事实');
});

// ─── S-7 换内容不换签 ⇒ false ───

test('ΑΩ-R5 S-7: 嵌入 TSTInfo 被换（genTime +1 年）而签名留在原文 ⇒ false（绑死正确内容字节）', () => {
  const token = buildCmsToken(rsaSpec({ contentOverride: bumpGenYear }));
  const r = verifyTsaSignature(token);
  assert.equal(r.verdict, false);
  assert.match(r.reason ?? '', /messageDigest/, '归因指向内容/摘要失配 —— 不是含糊的「验不过」');
});

// ─── S-8/S-9 端到端（真 notary + 假 TSA 回完整 TimeStampResp） ───

/** 从请求 DER 取 digest+nonce，铸签名 CMS token，封进 granted 响应 */
function makeFakeTsa(over: Partial<CmsSpec>): typeof fetch {
  return (async (_url: unknown, init: { body: Uint8Array }) => {
    const req = init.body;
    const kids = derChildren(derRead(req)!, req);
    const imprintKids = derChildren(kids[1], req);
    const digest = new Uint8Array(req.subarray(imprintKids[1].contentStart, imprintKids[1].contentEnd));
    const nonce = new Uint8Array(req.subarray(kids[2].contentStart, kids[2].contentEnd));
    const token = buildCmsToken(rsaSpec({ digest, nonce, ...over }));
    const reply = derSeq(derSeq(derInt([0])), token); // PKIStatusInfo{granted} + token
    return {
      ok: true, status: 200,
      arrayBuffer: async () =>
        reply.buffer.slice(reply.byteOffset, reply.byteOffset + reply.byteLength) as ArrayBuffer,
    };
  }) as unknown as typeof fetch;
}

async function seedJournal(n: number): Promise<void> {
  journal.reset();
  for (let i = 0; i < n; i++) {
    await journal.append({
      ts: 1_700_000_000 + i, tool: 'click_mouse',
      args: { x: 0.5, y: 0.5 }, status: 'SUCCESS',
    });
  }
}

test('ΑΩ-R5 S-8: 端到端真签 —— 判决随锚入册、章③注记在场、报告字段如实', async () => {
  notary.reset();
  notary.configure({ endpoint: '', tracePath: '' });
  await seedJournal(2);
  const a = await notary.anchorOnce({
    endpoint: 'https://tsa.example/tsr', fetchImpl: makeFakeTsa({}),
    now: () => 1_735_689_600_000,
    random: (n) => new Uint8Array(n).map((_, i) => (i + 3) & 0x7f || 0x01),
  });
  assert.ok(a);
  assert.equal(a.timestamp.source, 'rfc3161');
  assert.equal(a.timestamp.signatureVerified, true, '领取时判决随锚入册');
  assert.equal(notary.lastError, null);

  const r = notary.verifyNotary();
  assert.equal(r.badges['timestamp-anchor'].status, 'green');
  assert.match(r.badges['timestamp-anchor'].detail, /TSA signature verified offline/, '章③注记在场');
  assert.equal(r.lastAnchor?.signatureVerified, true, '报告字段如实');
  assert.equal(r.ok, true);
});

test('ΑΩ-R5 S-9: 端到端伪造（错钥签名 + 正确 imprint+nonce）⇒ 锚载 false、章③保守不翻红但注记在场', async () => {
  notary.reset();
  notary.configure({ endpoint: '', tracePath: '' });
  await seedJournal(2);
  const a = await notary.anchorOnce({
    endpoint: 'https://evil.example/tsr', fetchImpl: makeFakeTsa({ signOverride: forgeSign }),
    now: () => 1_735_689_600_000,
    random: (n) => new Uint8Array(n).map((_, i) => (i + 11) & 0x7f || 0x01),
  });
  assert.ok(a, '伪造回执不炸铸锚（旁路纪律）');
  assert.equal(a.timestamp.source, 'rfc3161', '回执在册 —— source 如实（绑定维度成立）');
  assert.equal(a.timestamp.signatureVerified, false, '签名判决 false 随锚入册（绝不误绿）');
  assert.equal(notary.lastError, null, '诚实判决不是故障');

  const r = notary.verifyNotary();
  // 保守取舍（工单明示）：signatureVerified=false 体现在注记/报告，不改既有章判据
  assert.equal(r.badges['timestamp-anchor'].status, 'green', '章判据不变（绑定维度仍立）');
  assert.match(r.badges['timestamp-anchor'].detail, /TSA signature verification FAILED/, '失败注记在场');
  assert.match(r.badges['timestamp-anchor'].detail, /UNPROVEN/, '第三方背书未证如实申报');
  assert.equal(r.lastAnchor?.signatureVerified, false, '报告字段可供下游独立执法');
  assert.equal(r.ok, true);
});

// ─── ΑΩ-R42：旁链快照进 TSA 摘要域（双账覆盖的第三方绑定面） ───

test('ΑΩ-R42 S-10: auxChains 进 imprint —— 第三方回执连学习史链尖一起绑定；离线复核对称执法', async () => {
  sandboxLog.reset();
  await sandboxLog.append('observation', { note: 'learning-history' }); // 在场旁链（学习史链）
  notary.reset();
  notary.configure({ endpoint: '', tracePath: '' });
  await seedJournal(2);
  let capturedBody: Uint8Array | null = null;
  const realTsa = makeFakeTsa({});
  const spyTsa = (async (_url: unknown, init: { body: Uint8Array }) => {
    capturedBody = init.body;
    return realTsa(_url as never, init as never);
  }) as unknown as typeof fetch;
  const a = await notary.anchorOnce({
    endpoint: 'https://tsa.example/tsr', fetchImpl: spyTsa,
    now: () => 1_735_689_600_000,
    random: (n) => new Uint8Array(n).map((_, i) => (i + 21) & 0x7f || 0x01),
  });
  assert.ok(a);
  assert.ok(a.auxChains, '旁链快照随锚入册');
  assert.ok(capturedBody, 'TSA 请求捕获');

  // 执法：imprint = sha256(canonical({seq, chainTip, mmrRoot, prevAnchorHash, auxChains}))
  // —— 旁链快照（学习史链尖）与主账状态同域入第三方时间背书（D-G5 witness 同律）
  const req = capturedBody as Uint8Array;
  const kids = derChildren(derRead(req)!, req);
  const imprintKids = derChildren(kids[1], req);
  const digestBytes = req.subarray(imprintKids[1].contentStart, imprintKids[1].contentEnd);
  const expected = sha256Hex(canonical({
    seq: journal.list(false).length,
    chainTip: journal.tip,
    mmrRoot: journal.mmrRoot(),
    prevAnchorHash: null, // 本测首锚
    auxChains: [{ chainName: 'sandboxLog', seq: 1, chainTip: sandboxLog.tip }],
  }));
  assert.equal(
    Buffer.from(digestBytes.buffer, digestBytes.byteOffset, digestBytes.byteLength).toString('hex'),
    expected,
    'RFC 3161 摘要域覆盖旁链快照（第三方回执绑定学习史链尖）',
  );

  // 离线复核章仍绿（token 复核走同一摘要域 —— 对称执法）+ 旁链复算注记在场
  const r = notary.verifyNotary();
  assert.equal(r.badges['timestamp-anchor'].status, 'green');
  assert.match(r.badges['timestamp-anchor'].detail, /TSA signature verified offline/);
  assert.match(r.badges['timestamp-anchor'].detail, /aux chain sandboxLog re-walk over 1 entry reproduces/);
  assert.deepEqual(r.lastAnchor?.auxChains, a.auxChains, '报告投影如实');

  sandboxLog.reset(); // 单例卫生（本册无 beforeEach —— 不渗后续用例）
});

// ─── ΝΩ-21：genTime 执法（TSTInfo 权威时刻的提取 + 与锚本地钟的偏差校验） ───

const GEN_AT = Date.UTC(2026, 0, 2, 3, 4, 5); // '20260102030405Z' 的 epoch ms

test('ΝΩ-21 S-11: genTime 正常提取（±1h 内注记 + 报告字段）/ 偏差注记 genTime-skew 不翻章 / 不可提取 ⇒ null', async () => {
  // (a) 单元面：extractGenTime 从 CMS token 解出 TSTInfo.genTime；垃圾/非 CMS ⇒ null
  const good = buildCmsToken(rsaSpec());
  assert.equal(extractGenTime(good), GEN_AT, 'GeneralizedTime Z 形态解码为 epoch ms');
  assert.equal(extractGenTime(new Uint8Array(32)), null, '垃圾 ⇒ null 绝不抛');
  const legacyMock = derSeq(derOid(ID_CT_TSTINFO), derA0(buildTstInfo(DIGEST, NONCE)));
  assert.equal(extractGenTime(legacyMock), null, '非 CMS SignedData 形态 ⇒ TSTInfo 域不可定位 ⇒ null');
  const v = verifyTimestampToken(good, { digest: DIGEST, nonce: NONCE }, null);
  assert.equal(v.genTime, GEN_AT, 'verifyTimestampToken 透传 genTime（与 ok/签名判决正交）');

  notary.reset();
  notary.configure({ endpoint: '', tracePath: '' });
  await seedJournal(2);

  // (b) 端到端正常：假 TSA 回 genTime 与注入时钟同刻 ⇒ 章③绿 + within 注记 + 报告字段
  const a = await notary.anchorOnce({
    endpoint: 'https://tsa.example/tsr', fetchImpl: makeFakeTsa({ genTimeText: '20260102030405Z' }),
    now: () => GEN_AT,
    random: (n) => new Uint8Array(n).map((_, i) => (i + 31) & 0x7f || 0x01),
  });
  assert.ok(a);
  let r = notary.verifyNotary();
  assert.equal(r.badges['timestamp-anchor'].status, 'green', '容差内 ⇒ 不翻章');
  assert.match(r.badges['timestamp-anchor'].detail, /genTime .* within ±60min of anchoredAt/, '正常提取注记在场');
  assert.equal(r.lastAnchor?.genTime, GEN_AT, '报告 lastAnchor.genTime 透传（下游独立复核入口）');
  assert.equal(r.ok, true);

  // (c) 端到端偏差：genTime +2h（> 1h 容差）⇒ genTime-skew 注记在场、章仍绿（注记级）
  const skew = await notary.anchorOnce({
    endpoint: 'https://tsa.example/tsr', fetchImpl: makeFakeTsa({ genTimeText: '20260102050405Z' }),
    now: () => GEN_AT,
    random: (n) => new Uint8Array(n).map((_, i) => (i + 37) & 0x7f || 0x01),
  });
  assert.ok(skew);
  r = notary.verifyNotary();
  assert.equal(r.badges['timestamp-anchor'].status, 'green', '保守取舍：超差不翻红（锚定 ≠ 两钟一致的证明）');
  assert.match(r.badges['timestamp-anchor'].detail, /genTime-skew/, '偏差注记在场');
  assert.match(r.badges['timestamp-anchor'].detail, /120 min > 60 min tolerance/, '偏差量与容差如实申报');
  assert.equal(r.lastAnchor?.genTime, Date.UTC(2026, 0, 2, 5, 4, 5), '偏差时刻如实透传（不为绿而修饰）');

  // (d) 不可提取 ⇒ 诚实 n/a 注记路径的事实源：非 CMS 旧 mock 形态 token
  //     （epochPi Π-3 同款）⇒ verifyTimestampToken.genTime === null —— 章③对
  //     该形态走 "genTime not extractable … honest n/a" 注记（badge 面已由
  //     epochPi Π-3 的绿章覆盖：注记不翻章）。
  const vLegacy = verifyTimestampToken(legacyMock, { digest: DIGEST, nonce: NONCE }, null);
  assert.equal(vLegacy.genTime, null, '非 CMS token ⇒ genTime 不可提取（诚实缺席，不猜）');
});

// ─── ΝΩ-21：TSA 信任锚 pin（DSH_TSA_PIN_SHA256 —— 可选强加固） ───

const RSA_SPKI_SHA256 = createHash('sha256').update(rsaSpki).digest('hex');

test('ΝΩ-21 S-12: pin 命中 ⇒ true / 未命中 ⇒ unpinned-key / 缺席 ⇒ 现行为；env 端到端 + 锚载与报告透传', async () => {
  const good = buildCmsToken(rsaSpec());

  // (a) 注入面：命中 ⇒ true；未命中/空表 ⇒ 'unpinned-key'（fail-closed）；null ⇒ 显式不钉扎
  assert.equal(verifyTsaSignature(good, [RSA_SPKI_SHA256]).verdict, true, 'pin 命中 —— 判绿仍只认 true');
  const miss = verifyTsaSignature(good, ['f'.repeat(64)]);
  assert.equal(miss.verdict, 'unpinned-key', '未命中 ⇒ 新判决值（签名数学成立的降级）');
  assert.match(miss.reason ?? '', /not among the 1 pinned/, '归因申报 pin 表与指纹');
  assert.equal(verifyTsaSignature(good, []).verdict, 'unpinned-key', '表在场而空 ⇒ 一律拒（配置打错不静默缴械）');
  assert.equal(verifyTsaSignature(good, null).verdict, true, 'null ⇒ 显式不钉扎（测试隔离缝）');
  // 未命中不遮蔽既有失败形态：篡改签名 + pin 在场 ⇒ 仍是 false（pin 只降级成立的签名）
  const tampered = buildCmsToken(rsaSpec({ signOverride: tamperSign }));
  assert.equal(verifyTsaSignature(tampered, [RSA_SPKI_SHA256]).verdict, false, '签名先败 ⇒ false（pin 不翻绿也不吞失败）');

  // (b) parseTsaPinList 纯函数：缺席 ⇒ null；空白/垃圾归一
  assert.equal(parseTsaPinList(undefined), null, 'env 缺席 ⇒ pin 面未武装');
  assert.equal(parseTsaPinList('  '), null, '空白 ⇒ 未武装');
  assert.deepEqual(parseTsaPinList(` 0X${RSA_SPKI_SHA256.toUpperCase()} , zz-garbage `), [RSA_SPKI_SHA256],
    '逗号分隔 + 大小写/0x 前缀归一 + 垃圾剔除');
  assert.deepEqual(parseTsaPinList('not-a-hash'), [], '在场但无一合法 ⇒ 空表（fail-closed）');

  // (c) env 端到端：生产默认路径读 DSH_TSA_PIN_SHA256
  const saved = process.env[TSA_PIN_ENV_KEY];
  try {
    process.env[TSA_PIN_ENV_KEY] = RSA_SPKI_SHA256;
    assert.equal(verifyTsaSignature(good).verdict, true, 'env pin 命中');
    process.env[TSA_PIN_ENV_KEY] = 'a'.repeat(64);
    assert.equal(verifyTsaSignature(good).verdict, 'unpinned-key', 'env pin 未命中');

    // (d) 锚端到端：伪 TSA 自造证书（sid 匹配、签名成立）+ pin 未命中 ⇒ 锚载
    //     'unpinned-key'、章③注记在场不翻红、报告字段供下游执法 —— 控制 endpoint
    //     者的「自造证书即 signatureVerified:true」路径就此止步
    notary.reset();
    notary.configure({ endpoint: '', tracePath: '' });
    await seedJournal(2);
    const a = await notary.anchorOnce({
      endpoint: 'https://evil.example/tsr', fetchImpl: makeFakeTsa({}),
      now: () => 1_735_689_600_000,
      random: (n) => new Uint8Array(n).map((_, i) => (i + 41) & 0x7f || 0x01),
    });
    assert.ok(a);
    assert.equal(a.timestamp.signatureVerified, 'unpinned-key', '锚载降级判决（随 anchorHash 防篡改入册）');
    assert.equal(notary.lastError, null, '诚实判决不是故障');
    const r = notary.verifyNotary();
    assert.equal(r.badges['timestamp-anchor'].status, 'green', '注记级不翻章（判据面隔离）');
    assert.match(r.badges['timestamp-anchor'].detail, /NOT pinned/, '未钉住注记在场');
    assert.match(r.badges['timestamp-anchor'].detail, /trust anchor refused/, '信任锚拒绝如实申报');
    assert.equal(r.lastAnchor?.signatureVerified, 'unpinned-key', '报告字段可供下游独立执法');
  } finally {
    if (saved === undefined) delete process.env[TSA_PIN_ENV_KEY];
    else process.env[TSA_PIN_ENV_KEY] = saved;
    notary.reset();
  }
});
