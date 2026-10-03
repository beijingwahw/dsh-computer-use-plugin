// test/epochPi.notary.test.ts
// 纪元 Π（可公证行为账本）执法测试 —— Π-1~Π-5：
//   Π-1 锚链成链：两锚互链（prev=前锚 hash）、JSONL 落盘两行、断尾半行容忍重读 + 治疗写
//   Π-2 篡改翻红：锚定后篡改 journal 历史行 ⇒ chain-integrity 红、ok=false
//   Π-3 RFC3161：请求体合法 DER（sha256 OID + nonce 可解出）、Content-Type 正确；
//        假回执（内嵌正确 imprint+nonce）⇒ imprintVerified=true、source='rfc3161'；
//        fetch 拒绝/超时 ⇒ source='local' 回退 + 注记；endpoint='' ⇒ fetch 零调用
//   Π-4 MMR 章：诚实 journal ⇒ mmr-membership 绿；replay-consistency='n/a' 且理由在场
//   Π-5 notarize 工具动作：quality_checkup 分发走通、四章报告返回；autoAnchor 开关面在册
// 全离线：journal 单例 reset 直喂、假 fetch、注入时钟与 CSPRNG（确定性）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Config } from '../src/config';
import { notary, notaryAutoAnchorIfConfigured } from '../src/notary/index.ts';
import { journal } from '../src/journal.ts';
import { derRead, derChildren, derEncode } from '../src/notary/rfc3161.ts';
import { createQualityCheckupTool } from '../src/tools/qualityCheckup.ts';
import { doctor } from '../src/qualityDoctor.ts';

// ─── 测试基建：确定性时钟 / 种子 CSPRNG / journal 播种 ───

/** 固定时钟（2025-01-01T00:00:00Z —— 锚记录时间戳确定性） */
const fixedClock = (): number => 1735689600000;

/** 种子伪随机（仅测试 —— 生产 nonce 走 crypto.randomBytes；两实例同种子 ⇒ 同字节流） */
function makeRandom(seed: number): (n: number) => Uint8Array {
  let s = seed >>> 0 || 1;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      out[i] = (s >>> 16) & 0xff;
    }
    return out;
  };
}

/** 复刻 notary.mintNonce 的正号位规约（首字节 MSB 清零 + 置低位 —— 与请求 nonce 对照用） */
function asMintedNonce(raw: Uint8Array): Uint8Array {
  const out = Uint8Array.from(raw);
  out[0] = (out[0] & 0x7f) | 0x01;
  return out;
}

/** journal 播种：reset 后喂 n 条确定性动作（click_mouse ∈ ACTION_TOOLS，直接入链） */
async function seedJournal(n: number): Promise<void> {
  journal.reset();
  for (let i = 0; i < n; i++) {
    await journal.append({
      ts: 1700000000 + i, tool: 'click_mouse',
      args: { x: (i + 1) / 10, y: 0.5 }, status: 'SUCCESS', effect_detected: true,
    });
  }
}

function hex(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex');
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ─── Π-3 的假 TSA：从请求 DER 里取出 digest 与 nonce，铸内嵌两者的最小 DER 回执 ───

const OID = (bytes: number[]) => derEncode(0x06, Uint8Array.from(bytes));
const SHA256_OID_ARMS = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
const ID_CT_TSTINFO_ARMS = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x01, 0x04];

/** 最小 TimeStampResp：PKIStatus=granted + ContentInfo[0]{ mock TSTInfo（imprint+nonce 内嵌） } */
function buildTimestampReply(req: Uint8Array): Uint8Array {
  const root = derRead(req)!;
  const kids = derChildren(root, req);
  const imprint = derChildren(kids[1], req); // [version, messageImprint, nonce, certReq]
  const digest = req.subarray(imprint[1].contentStart, imprint[1].contentEnd);
  const nonce = req.subarray(kids[2].contentStart, kids[2].contentEnd);
  const tstInfo = derEncode(0x30, concat(
    derEncode(0x02, Uint8Array.of(1)),                                    // version
    OID(ID_CT_TSTINFO_ARMS),                                              // policy（mock：任意合法 OID）
    derEncode(0x30, concat(                                               // messageImprint —— 内嵌正确摘要
      derEncode(0x30, OID(SHA256_OID_ARMS)),
      derEncode(0x04, digest),
    )),
    derEncode(0x02, Uint8Array.of(0x0a)),                                 // serialNumber
    derEncode(0x18, new TextEncoder().encode('20260102030405Z')),         // genTime
    derEncode(0x02, nonce),                                               // nonce 回显
  ));
  const contentInfo = derEncode(0x30, concat(OID(ID_CT_TSTINFO_ARMS), derEncode(0xa0, tstInfo)));
  const statusInfo = derEncode(0x30, derEncode(0x02, Uint8Array.of(0)));  // PKIStatus = 0 (granted)
  return derEncode(0x30, concat(statusInfo, contentInfo));
}

// ─── Π-1 锚链成链 ───

test('Π-1: 两锚互链（第二锚 prev=第一锚 hash）+ JSONL 两行 + 断尾半行容忍读/治疗写', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-notary-1-'));
  const trace = join(dir, 'anchors.jsonl');
  try {
    notary.reset();
    notary.configure({ endpoint: '', tracePath: trace });
    await seedJournal(3);

    const a1 = await notary.anchorOnce({ now: fixedClock, random: makeRandom(0x2a) });
    const a2 = await notary.anchorOnce({ now: fixedClock, random: makeRandom(0x2b) });
    assert.ok(a1 && a2, '两锚铸成');
    assert.equal(a1.prevAnchorHash, null, '首锚 prev 为 null 哨兵');
    assert.equal(a2.prevAnchorHash, a1.hash, '第二锚链接第一锚（锚自链）');
    assert.match(a1.hash, /^[0-9a-f]{64}$/, '锚 hash = sha256 hex');
    // 账本快照三件套忠实映射 journal 公开面
    assert.equal(a1.seq, 3);
    assert.equal(a1.chainTip, journal.tip);
    assert.equal(a1.mmrRoot, journal.mmrRoot());

    const lines = readFileSync(trace, 'utf8').split('\n').filter(l => l.trim() !== '');
    assert.equal(lines.length, 2, 'notaryTracePath 落两行');
    assert.equal(JSON.parse(lines[1]).hash, a2.hash, '磁盘行与内存锚同一');

    // 断尾：第二行截半（无尾换行 —— 模拟进程被杀）⇒ 重读不炸，半行被容忍
    const torn = lines[0] + '\n' + lines[1].slice(0, Math.floor(lines[1].length / 2));
    writeFileSync(trace, torn, 'utf8');
    notary.reset();
    notary.configure({ endpoint: '', tracePath: trace });
    assert.equal(notary.anchorCount, 1, '断尾半行被容忍（完好行照常铸回）');
    assert.equal(notary.lastError, null, '容忍不是故障（lastError 干净）');

    // 治疗写：续锚前先把断尾封口 —— 半行不再粘进新行
    const a3 = await notary.anchorOnce({ now: fixedClock, random: makeRandom(0x2c) });
    assert.ok(a3);
    assert.equal(a3.prevAnchorHash, JSON.parse(lines[0]).hash, '治疗后续锚接回完好尾锚');
    const parsed: string[] = [];
    for (const l of readFileSync(trace, 'utf8').split('\n')) {
      if (l.trim() === '') continue;
      try { parsed.push(JSON.parse(l).hash); } catch { /* 治疗封口后的断尾残骸 —— 非行 */ }
    }
    assert.deepEqual(parsed, [JSON.parse(lines[0]).hash, a3.hash], '断口封行后恰好两枚完好锚');
  } finally {
    notary.reset();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Π-2 篡改翻红 ───

test('Π-2: 锚定后篡改 journal 历史行 ⇒ chain-integrity 红、ok=false（前缀重走同翻红）', async () => {
  notary.reset();
  notary.configure({ endpoint: '', tracePath: '' }); // 纯内存锚链
  await seedJournal(4);
  const a = await notary.anchorOnce({ now: fixedClock, random: makeRandom(0x33) });
  assert.ok(a);

  // 篡改历史第 2 条（锚已宣誓的字节域）—— list(false) 返回的就是 journal 内部条目对象
  const entries = journal.list(false);
  (entries[1] as { status: string }).status = 'TAMPERED';

  const r = notary.verifyNotary();
  assert.equal(r.badges['chain-integrity'].status, 'red', '全链校验翻红');
  assert.match(r.badges['chain-integrity'].detail, /entry 1/, '断点定位到被篡改条目');
  assert.equal(r.badges['timestamp-anchor'].status, 'red', '前缀重走发现链尖复算失配');
  assert.equal(r.ok, false, '任一红章 ⇒ 整体 ok=false');
});

// ─── Π-3 RFC 3161 ───

test('Π-3: 请求 DER 合法（sha256 OID+nonce 可解）/ Content-Type 正确 / 回执核验 / 回退 / 零调用', async () => {
  notary.reset();
  notary.configure({ endpoint: '', tracePath: '' });
  await seedJournal(2);

  // (a) 假 TSA：回执内嵌请求自身的 digest+nonce ⇒ imprintVerified=true、source='rfc3161'
  let calls = 0;
  let capturedUrl = '';
  let capturedHeaders: Record<string, string> = {};
  let capturedBody: Uint8Array | null = null;
  const fetchReceipt = (async (url: unknown, init: { headers: Record<string, string>; body: Uint8Array }) => {
    calls++;
    capturedUrl = String(url);
    capturedHeaders = init.headers;
    capturedBody = init.body;
    const reply = buildTimestampReply(init.body);
    return {
      ok: true, status: 200,
      arrayBuffer: async () =>
        reply.buffer.slice(reply.byteOffset, reply.byteOffset + reply.byteLength) as ArrayBuffer,
    };
  }) as unknown as typeof fetch;

  const peek = makeRandom(0x2a); // 同种子预演 —— 复算 anchorOnce 将铸出的 nonce
  const expectedNonce = asMintedNonce(peek(16));
  const a = await notary.anchorOnce({
    endpoint: 'https://tsa.example/tsr', fetchImpl: fetchReceipt,
    now: fixedClock, random: makeRandom(0x2a),
  });
  assert.ok(a);
  assert.equal(a.timestamp.source, 'rfc3161', '回执取得 ⇒ 第三方源');
  assert.equal(a.timestamp.imprintVerified, true, 'imprint+nonce 均对上');
  assert.ok(a.timestamp.token, 'token 原始字节留存（base64）');
  assert.equal(calls, 1, '单次尝试');
  assert.equal(capturedUrl, 'https://tsa.example/tsr');
  assert.equal(capturedHeaders['content-type'], 'application/timestamp-query', 'RFC 3161 线协议头');

  // 请求体是合法 DER：TimeStampReq ::= SEQUENCE{ INTEGER 1, messageImprint, nonce, certReq TRUE }
  const req = capturedBody!;
  const root = derRead(req);
  assert.ok(root && root.tag === 0x30 && root.end === req.length, '单一完整 DER SEQUENCE');
  const kids = derChildren(root!, req);
  assert.equal(kids.length, 4, 'version / messageImprint / nonce / certReq 四元');
  assert.equal(kids[0].tag === 0x02 && req[kids[0].contentStart], 1, 'version=1');
  const imprintKids = derChildren(kids[1], req);
  const algKids = derChildren(imprintKids[0], req);
  assert.equal(algKids[0].tag, 0x06, 'hashAlgorithm 是 OID');
  assert.equal(hex(req.subarray(algKids[0].contentStart, algKids[0].contentEnd)), '608648016503040201',
    'sha256 OID 2.16.840.1.101.3.4.2.1 可解出');
  assert.equal(imprintKids[1].tag === 0x04 && imprintKids[1].contentEnd - imprintKids[1].contentStart, 32,
    'hashedMessage = 32 字节 sha256 摘要');
  assert.equal(kids[2].tag, 0x02, 'nonce 是 INTEGER');
  assert.deepEqual(req.subarray(kids[2].contentStart, kids[2].contentEnd), expectedNonce,
    'nonce 与注入 CSPRNG 输出一致（正号位规约）');
  assert.equal(kids[3].tag === 0x01 && req[kids[3].contentStart], 0xff, 'certReq=TRUE');

  // 留存 token 可离线复核：核验章 ③ 重走通过（零网络）
  const r = notary.verifyNotary();
  assert.equal(r.badges['timestamp-anchor'].status, 'green');
  assert.match(r.badges['timestamp-anchor'].detail, /re-verified offline/, 'token imprint+nonce 离线复核在场');
  assert.equal(r.ok, true);

  // (b) fetch 拒绝 ⇒ 诚实本地回退 + 注记（绝不谎称第三方）
  const fetchReject = (async () => { throw new Error('network unreachable'); }) as unknown as typeof fetch;
  const b = await notary.anchorOnce({
    endpoint: 'https://tsa.example/tsr', fetchImpl: fetchReject,
    now: fixedClock, random: makeRandom(0x44),
  });
  assert.ok(b);
  assert.equal(b.timestamp.source, 'local', '回退为本地时间锚');
  assert.ok(b.timestamp.note && /rfc3161 fallback/.test(b.timestamp.note) && /network unreachable/.test(b.timestamp.note),
    '回退注记携带失败事实');
  assert.equal(b.timestamp.imprintVerified, undefined, '无回执即无核验标志（不虚标）');

  // (c) 超时（挂起不答，abort 信号触发）⇒ 同律回退
  const fetchHang = (async (_url: unknown, init: { signal?: AbortSignal }) => {
    return new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted: tsa timeout')), { once: true });
    });
  }) as unknown as typeof fetch;
  const c = await notary.anchorOnce({
    endpoint: 'https://tsa.example/tsr', fetchImpl: fetchHang, timeoutMs: 40,
    now: fixedClock, random: makeRandom(0x55),
  });
  assert.ok(c);
  assert.equal(c.timestamp.source, 'local', '超时 ⇒ 本地回退');
  assert.match(c.timestamp.note ?? '', /aborted: tsa timeout/, '注记携带超时事实');

  // (d) endpoint='' ⇒ 零网络（spy 计数 = 0）
  notary.reset();
  notary.configure({ endpoint: '', tracePath: '' });
  await seedJournal(1);
  let spyCalls = 0;
  const spy = (async () => {
    spyCalls++;
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  }) as unknown as typeof fetch;
  const d = await notary.anchorOnce({ fetchImpl: spy, now: fixedClock, random: makeRandom(0x66) });
  assert.ok(d);
  assert.equal(d.timestamp.source, 'local');
  assert.equal(spyCalls, 0, 'endpoint 空 ⇒ fetch 零调用（零网络承诺）');
});

// ─── Π-4 MMR 章 + 诚实 n/a ───

test('Π-4: 诚实 journal ⇒ mmr-membership 绿（静止对锚根/增长对当前根）；replay-consistency 诚实 n/a', async () => {
  notary.reset();
  notary.configure({ endpoint: '', tracePath: '' });
  await seedJournal(5);
  const a = await notary.anchorOnce({ now: fixedClock, random: makeRandom(0x77) });
  assert.ok(a);

  const r = notary.verifyNotary();
  assert.equal(r.badges['chain-integrity'].status, 'green');
  assert.equal(r.badges['mmr-membership'].status, 'green', '包含证明对锚根验证通过');
  assert.match(r.badges['mmr-membership'].detail, /ANCHOR/);
  assert.equal(r.badges['timestamp-anchor'].status, 'green');
  // 章④：诚实降级 —— n/a 而非虚假的绿，理由在场
  assert.equal(r.badges['replay-consistency'].status, 'n/a');
  assert.ok(r.badges['replay-consistency'].detail.length > 20, 'n/a 理由说明在场');
  assert.equal(r.ok, true, 'n/a 不算失败');

  // 增长世界：锚后 journal 追加 —— MMR 追加型，旧叶不可能消失 ⇒ 章对「当前根」仍绿
  await journal.append({ ts: 1700000005, tool: 'scroll_page', args: { direction: 'down' }, status: 'SUCCESS' });
  const r2 = notary.verifyNotary();
  assert.equal(r2.badges['mmr-membership'].status, 'green');
  assert.match(r2.badges['mmr-membership'].detail, /CURRENT/, '增长世界对当前根验证（形态如实标注）');
  assert.equal(r2.ok, true);
});

// ─── Π-5 notarize 工具动作 + autoAnchor 开关面 ───

interface Executable { execute(args: unknown): Promise<string> }

test('Π-5: quality_checkup notarize 分发走通（四章报告 + 锚计数 + 时间戳来源）；开关面在册', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-notarize-'));
  try {
    // 预装配（与 P-5 同法：报告路径已设 ⇒ ensureDoctorConfigured 直通，不付真扫描）
    await doctor.configure({ sourceRoot: resolve(process.cwd(), 'src'), memoryPath: join(dir, 'mem.json'), strict: false });
    const cfg = {
      doctorMemoryPath: join(dir, 'mem.json'),
      notaryEndpoint: '', notaryTracePath: '', notaryAutoAnchor: false,
    } as unknown as Config;
    const tool = createQualityCheckupTool(cfg);

    await seedJournal(2);
    notary.reset();
    const out = await (tool as Executable).execute({ action: 'notarize' });
    const o = JSON.parse(out);
    assert.equal(o.status, 'SUCCESS', '四件套出证');
    assert.equal(o.state_anchor.anchor_minted, true);
    assert.equal(o.state_anchor.anchors_total, 1);
    assert.equal(o.state_anchor.timestamp_source, 'local', 'endpoint 空 ⇒ 诚实本地源');
    assert.equal(o.state_anchor.notary_ok, true);
    for (const badge of ['chain-integrity', 'mmr-membership', 'timestamp-anchor', 'replay-consistency']) {
      assert.ok(o.state_anchor.badges[badge], `章 ${badge} 在报告里`);
      assert.match(o.state_anchor.badges[badge], /^(green|red|n\/a) — /, '章形态：status — detail');
    }
    assert.equal(o.state_anchor.badges['replay-consistency'].startsWith('n/a — '), true, '重放章诚实 n/a');

    // 现有分发语义零变化：未知动作仍是 FAILED（理由串含 notarize 提示）
    const unknown = JSON.parse(await (tool as Executable).execute({ action: 'nope' }));
    assert.equal(unknown.status, 'FAILED');
    assert.match(unknown.reason, /unknown action/);
    assert.match(unknown.reason, /notarize/);

    // 开关面在册：notaryAutoAnchorIfConfigured —— 假 ⇒ 零行为；真 ⇒ 铸一枚（fire-and-forget）
    assert.equal(typeof notaryAutoAnchorIfConfigured, 'function', '开关面导出在册');
    notary.reset();
    notaryAutoAnchorIfConfigured({ notaryAutoAnchor: false, notaryEndpoint: '', notaryTracePath: '' });
    assert.equal(notary.anchorCount, 0, '开关假 ⇒ 不铸锚');
    notaryAutoAnchorIfConfigured({ notaryAutoAnchor: true, notaryEndpoint: '', notaryTracePath: '' });
    await new Promise(resolve_ => setTimeout(resolve_, 20)); // fire-and-forget 落账（本地锚路径同步即可完成，留拍宽限）
    assert.equal(notary.anchorCount, 1, '落账后恰好一枚自动锚');
    assert.equal(notary.lastAnchor()?.seq, 2, '锚覆盖当前 journal 条数');
    // null/undefined 配置面：零行为不炸（防御）
    notaryAutoAnchorIfConfigured(null);
    notaryAutoAnchorIfConfigured(undefined);
  } finally {
    notary.reset();
    rmSync(dir, { recursive: true, force: true });
  }
});
