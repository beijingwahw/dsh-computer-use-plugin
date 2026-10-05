// test/t1-6.fixes.test.ts
// ΤΕΛΟΣ 纪元 工单 ΤΕΛ-6（DEBTS D-G28..D-G32 清偿）执法册。
//
// 覆盖面（逐债一节）：
//   · D-G29（federation v2 客户端半边）：federationAuthHeaders 第四参 nonce ——
//     v1 三参调用逐字节回归（既有兼容面零漂移）/ v2 三头 + 签名输入
//     `${ts}.${nonce}.${body}` 与服务端 canonical 一致 / nonce 域外消毒为 v1
//     （绝不发自知会被拒的弱头）/ federationSync 的 authNonce 开关（true 铸
//     一次性 nonce、字符串钉面、缺省 v1 零漂移）；
//   · D-G30（hotkeyBlacklist 缺省串）：T1-8c 已落 config.ts 两键 —— 本册取证
//     锁定（schema 缺省含 ctrl+shift+esc/alt+space + 装载期补全收敛 no-op）；
//   · D-G32·M2（notaryHandshake 判据收口）：多词描述须过半词元可见（撒单词
//     穿透被拒）/ 短描述（≤2 词元）与 CJK 单词元维持旧律（引用式零误杀）/
//     整串包含与跳过路径零回归；
//   · D-G32·M3（公证证据新鲜度）：notaryEvidenceStale 纯函数边界（在场超阈 ⇒
//     过期；缺席/时钟回拨/非有限 ⇒ 不判过期）+ clickMouse 派发前闸源级取证
//     （dangerous+token 面消费该判决，freshness 同执法点族）。
// D-G28② 的 python 侧执法在 python_service/tests（pytest 册）；D-G31 见工单
// 报告（index.ts 登记面归 T1-1 产权，本册不越界）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  federationAuthHeaders,
  federationSync,
  resetFederationRuntime,
  FEDERATION_AUTH_TIMESTAMP_HEADER,
  FEDERATION_AUTH_SIGNATURE_HEADER,
  type FederationFetch,
} from '../src/federation/index.ts';
import { EvidenceLedger } from '../src/kernel/registry.ts';
import { notaryHandshake, notaryEvidenceStale } from '../src/tools/actionGate.ts';
import { Config as ConfigSchema } from '../src/config.ts';

function joinSrc(...seg: string[]): string {
  return fileURLToPath(new URL(`../src/${seg.join('/')}`, import.meta.url));
}
const clickMouseSource = readFileSync(joinSrc('tools/clickMouse.ts'), 'utf8');

// ─── D-G29：federationAuthHeaders 的 v2 nonce 半边 ───

test('D-G29①: v1 三参调用逐字节回归 —— 第四参缺席 ⇒ 双头 + `${ts}.${body}` 签名（兼容面零漂移）', () => {
  const body = '{"digest_id":"x"}';
  const h = federationAuthHeaders(body, 'secret', 42_000);
  assert.deepEqual(Object.keys(h).sort(), [FEDERATION_AUTH_SIGNATURE_HEADER, FEDERATION_AUTH_TIMESTAMP_HEADER].sort(),
    'v1：恰双头（无 nonce 头）');
  assert.equal(h[FEDERATION_AUTH_TIMESTAMP_HEADER], '42000');
  assert.equal(h[FEDERATION_AUTH_SIGNATURE_HEADER], createHmac('sha256', 'secret').update('42000.' + body).digest('hex'),
    'v1 签名输入 = `${ts}.${body}`（服务端 legacy canonical）');
  // nonce 显式 null/undefined/空串 ⇒ 同 v1
  for (const absent of [undefined, null, ''] as const) {
    const h2 = federationAuthHeaders(body, 'secret', 42_000, absent);
    assert.deepEqual(h2, h, `nonce=${String(absent)} ⇒ v1 逐字节`);
  }
  // 空 token ⇒ 零头（open 客户端）—— v2 参数不改变 open 语义
  assert.deepEqual(federationAuthHeaders(body, '', 42_000, 'nonce-1234'), {}, 'open 客户端零头（v2 参数无关）');
});

test('D-G29②: v2 —— nonce 在场 ⇒ 三头，签名输入 `${ts}.${nonce}.${body}` 与服务端 v2 canonical 一致', () => {
  const body = '{"digest_id":"y"}';
  const nonce = 'n-abcdef01';
  const h = federationAuthHeaders(body, 'secret', 42_001, nonce);
  assert.equal(h['x-dsh-fed-nonce'], nonce, 'nonce 头透传（与服务端 AUTH_NONCE_HEADER 同字面量）');
  assert.equal(h[FEDERATION_AUTH_TIMESTAMP_HEADER], '42001');
  assert.equal(
    h[FEDERATION_AUTH_SIGNATURE_HEADER],
    createHmac('sha256', 'secret').update(`42001.${nonce}.${body}`).digest('hex'),
    'v2 签名输入 = `${ts}.${nonce}.${body}`（scripts/federation-server.mjs :228 同 canonical）',
  );
  // 双协议互斥：v2 签名 ≠ v1 签名（防静默降级到同一签名值）
  const v1 = federationAuthHeaders(body, 'secret', 42_001);
  assert.notEqual(h[FEDERATION_AUTH_SIGNATURE_HEADER], v1[FEDERATION_AUTH_SIGNATURE_HEADER]);
});

test('D-G29③: nonce 域外消毒 —— 长度 <8 或 >128 ⇒ 诚实降级 v1（绝不发自知会被拒的弱头）', () => {
  const body = '{"k":1}';
  const v1 = federationAuthHeaders(body, 'secret', 7);
  for (const bad of ['short', 'x'.repeat(129)]) {
    const h = federationAuthHeaders(body, 'secret', 7, bad);
    assert.deepEqual(h, v1, `域外 nonce（len=${bad.length}）⇒ v1 逐字节`);
  }
});

test('D-G29④: federationSync 的 authNonce 开关 —— true 铸一次性 nonce；字符串钉面；缺省 v1 零漂移', async () => {
  resetFederationRuntime();
  const prevEnv = process.env.DSH_FEDERATION_TOKEN;
  const EP = 'https://t16.example/fed';
  const seen: Array<Record<string, string>> = [];
  const bodies: string[] = [];
  const fake = (async (_u: string, init: { headers: Record<string, string>; body: string }) => {
    seen.push(init.headers);
    bodies.push(init.body);
    return { json: async () => ({}) };
  }) as unknown as FederationFetch;
  try {
    delete process.env.DSH_FEDERATION_TOKEN;

    // (a) 缺省 ⇒ v1（无 nonce 头）—— 缺省行为零漂移
    const r0 = federationSync({ endpoint: EP, fetchImpl: fake, ledger: new EvidenceLedger(), authToken: 's', dpKey: 'k-t16', now: () => 1 });
    await r0.settled;
    assert.equal(seen[0]['x-dsh-fed-nonce'], undefined, '缺省 ⇒ v1（无 nonce 头）');

    // (b) authNonce: true ⇒ 每次上行一次性 nonce（两次不同）+ 三头签名自洽
    const r1 = federationSync({ endpoint: EP, fetchImpl: fake, ledger: new EvidenceLedger(), authToken: 's', dpKey: 'k-t16', now: () => 2, authNonce: true });
    await r1.settled;
    const r2 = federationSync({ endpoint: EP, fetchImpl: fake, ledger: new EvidenceLedger(), authToken: 's', dpKey: 'k-t16', now: () => 3, authNonce: true });
    await r2.settled;
    const n1 = seen[1]['x-dsh-fed-nonce'];
    const n2 = seen[2]['x-dsh-fed-nonce'];
    assert.ok(typeof n1 === 'string' && n1.length >= 8 && n1.length <= 128, `nonce 域内（len=${n1?.length}）`);
    assert.ok(typeof n2 === 'string' && n2 !== n1, '两次同步 nonce 不同（一次性）');
    assert.equal(
      seen[1][FEDERATION_AUTH_SIGNATURE_HEADER],
      createHmac('sha256', 's').update(`2.${n1}.${bodies[1]}`).digest('hex'),
      'v2 签名 = `${ts}.${nonce}.${body}` canonical 重算一致',
    );

    // (c) 字符串钉面：显式 nonce 原样上行（部署/测试缝）
    const pinned = 'pinned-nonce-0001';
    const r3 = federationSync({ endpoint: EP, fetchImpl: fake, ledger: new EvidenceLedger(), authToken: 's', dpKey: 'k-t16', now: () => 4, authNonce: pinned });
    await r3.settled;
    assert.equal(seen[3]['x-dsh-fed-nonce'], pinned, '钉面 nonce 透传');
    assert.equal(seen[3][FEDERATION_AUTH_SIGNATURE_HEADER], createHmac('sha256', 's').update(`4.${pinned}.${bodies[3]}`).digest('hex'));

    // (d) 域外字符串 ⇒ 消毒回 v1（不抛、不弱签）
    const r4 = federationSync({ endpoint: EP, fetchImpl: fake, ledger: new EvidenceLedger(), authToken: 's', dpKey: 'k-t16', now: () => 5, authNonce: 'short' });
    await r4.settled;
    assert.equal(seen[4]['x-dsh-fed-nonce'], undefined, '域外钉面 ⇒ v1');

    // (e) open（无 token）⇒ 零头 —— authNonce 不反向制造签名面
    const r5 = federationSync({ endpoint: EP, fetchImpl: fake, ledger: new EvidenceLedger(), authToken: '', dpKey: 'k-t16', now: () => 6, authNonce: true });
    await r5.settled;
    assert.equal(seen[5][FEDERATION_AUTH_SIGNATURE_HEADER], undefined, 'open 客户端零头（authNonce 无 token 不生效）');
    assert.ok(r5.ok, '同步本体不受影响');
  } finally {
    if (prevEnv === undefined) delete process.env.DSH_FEDERATION_TOKEN;
    else process.env.DSH_FEDERATION_TOKEN = prevEnv;
  }
});

// ─── D-G30：hotkeyBlacklist 缺省串取证锁定（T1-8c 落地，本册防回归） ───

test('D-G30: schema 缺省串含 ctrl+shift+esc/alt+space —— 装载期补全收敛 no-op（两初始路径同一生效缺省）', () => {
  const def = (ConfigSchema as unknown as { (i?: Record<string, unknown>): { hotkeyBlacklist?: unknown } })({}).hotkeyBlacklist;
  assert.equal(def, 'alt+f4,meta,meta+l,meta+r,meta+d,win,cmd+q,ctrl+alt+delete,ctrl+shift+esc,alt+space',
    'schema 缺省串已含两键（T1-8c/ΤΕΛ-8c 落地）');
  const csv = String(def).split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  assert.ok(csv.includes('ctrl+shift+esc') && csv.includes('alt+space'), '两键在列');
  // 幂等收敛：withPan10DefaultAdditions 对新缺省为 no-op（源级 —— 补全函数在册防镜像漂移）
  const src = readFileSync(joinSrc('system.hotkeyPolicy.ts'), 'utf8');
  assert.ok(src.includes('withPan10DefaultAdditions'), '补全函数仍在册（幂等兜底立法面）');
});

// ─── D-G32·M2：notaryHandshake 判据收口 ───

test('D-G32·M2①: 撒单词穿透被拒 —— 多词描述（≥3 词元）须过半词元在实读可见', () => {
  // C1-5 M2 的原攻击形：描述长而具体、只含一个邻域可见词
  const v1 = notaryHandshake('Delete account Settings', 'open the Settings page please');
  assert.equal(v1.ok, false, '长描述只撒一个可见词（settings）⇒ 拒（旧「任一同现」律下此例过）');
  assert.equal(v1.skipped, null);
  // 过半可见 ⇒ 过（引用式纪律的正例）
  const v2 = notaryHandshake('Delete account Settings page', 'delete the settings page now');
  assert.equal(v2.ok, true, '描述 5 词元 3 可见（delete/settings/page）⇒ 过半 ⇒ 过');
});

test('D-G32·M2②: 双向同现要求 —— 实读侧零命中即拒（点 A 描述 B 的邻域词形）', () => {
  // 描述词全不在实读中（实读是另一个控件的邻域）⇒ 两侧皆空 ⇒ 拒
  const v = notaryHandshake('quantum entanglement lab', 'open the Settings page now');
  assert.equal(v.ok, false, '两侧互不可见 ⇒ 拒（整串/词元全落空）');
  // 合法引用正例：目标词双向命中（documents 在双侧）⇒ 过
  const v2 = notaryHandshake('Recycle bin Documents', 'documents folder');
  assert.equal(v2.ok, true, '目标词双向命中 ⇒ 过（引用式正例）');
});

test('D-G32·M2③: 短描述（≤2 词元）与 CJK 单词元维持旧律 —— 引用式零误杀', () => {
  // CJK：无空白分词 ⇒ 单词元描述，多数律不适用（≤2 词元走旧「任一同现」）
  assert.equal(notaryHandshake('确定', '点击确定按钮以提交表单').ok, true, 'CJK 实读词在长描述中 ⇒ 过（单词元旧律）');
  assert.equal(notaryHandshake('确定 取消', '确定').ok, true, '实读侧多词、描述单词元命中 ⇒ 过');
  // 拉丁两词元引用式：submit 可见即过（旧律保持 —— 多数律自 ≥3 词元起）
  assert.equal(notaryHandshake('Submit Cancel Forgot password', 'submit button').ok, true, '两词元描述 1/2 可见 ⇒ 过（floor=1）');
  // 整串包含路径零回归
  assert.equal(notaryHandshake('Settings — Account page', 'Settings').ok, true, '整串包含（描述 ⊂ 实读）⇒ 过');
});

test('D-G32·M2④: 跳过路径零回归 —— 标签过短/纯标点/描述不可归一 ⇒ ok+skipped', () => {
  assert.deepEqual(notaryHandshake('×', 'close button'), { ok: true, skipped: 'ocr-label-too-short' });
  assert.deepEqual(notaryHandshake('!!', 'close button'), { ok: true, skipped: 'ocr-label-pure-punctuation' });
  assert.deepEqual(notaryHandshake('Close', '***'), { ok: true, skipped: 'description-unnormalizable' });
});

// ─── D-G32·M3：公证证据新鲜度 ───

test('D-G32·M3①: notaryEvidenceStale 纯函数边界 —— 在场超阈 ⇒ 过期；缺席/回拨/非有限 ⇒ 不判', () => {
  assert.equal(notaryEvidenceStale(1_000_000, 1_000_000 + 9_999), false, '阈内（9.999s）⇒ 不过期');
  assert.equal(notaryEvidenceStale(1_000_000, 1_000_000 + 10_001), true, '超阈（10.001s）⇒ 过期');
  assert.equal(notaryEvidenceStale(1_000_000, 1_000_000 + 10_000), false, '恰 10s ⇒ 不过期（> 阈才过期）');
  assert.equal(notaryEvidenceStale(null, 1_000_000), false, '证据缺席（公证未 engage）⇒ 不适用');
  assert.equal(notaryEvidenceStale(undefined, 1_000_000), false, 'undefined ⇒ 不适用');
  assert.equal(notaryEvidenceStale(Number.NaN, 1_000_000), false, 'NaN ⇒ 不适用');
  assert.equal(notaryEvidenceStale(1_000_000, 999_000), false, '时钟回拨（负龄）⇒ 不在此判（ΠΑΝ-53 回拨披露面承接）');
  assert.equal(notaryEvidenceStale(1_000_000, Number.NaN), false, 'now 非有限 ⇒ 不判（绝不抛）');
});

test('D-G32·M3②: clickMouse 派发前闸源级取证 —— dangerous+token 面消费 notaryEvidenceStale（freshness 同执法点族）', () => {
  // 源级断言（epochMu Μ-6 双断言同律）：接线金丝雀 —— 判决消费点 + 取证时刻记录点
  assert.ok(clickMouseSource.includes('notaryEvidenceStale(notaryEvidenceAt, Date.now())'),
    'freshnessStage 内消费 notaryEvidenceStale（派发前、dangerous+token 面）');
  assert.ok(clickMouseSource.includes('notaryEvidenceAt = Date.now()'),
    'notaryStage 取证成功时记录时刻（证据在场才有值）');
  assert.ok(clickMouseSource.includes("'notary-evidence-stale'"),
    '过期拒绝的结构化归因在案（重试指引：令牌未烧）');
  const gateIdx = clickMouseSource.indexOf('notaryEvidenceStale(notaryEvidenceAt');
  const reserveIdx = clickMouseSource.indexOf('const attemptReservationStage');
  assert.ok(gateIdx >= 0 && reserveIdx > gateIdx, '时效闸先于 attemptReservationStage/beginAttempt（令牌不烧 —— 阻断在预留/派发之前）');
});
