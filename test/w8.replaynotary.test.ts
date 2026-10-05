// test/w8.replaynotary.test.ts
// D-G5（W8 第 2 批）执法册 —— replayOne 重放层公证接线（DEBTS「重放证词留白」清偿）：
//   N-1 便捷面三态：假 notary 捕获见证内容（anchored 事实字段）；未装配 ⇒ 诚实
//      degraded 不铸锚；铸锚失败/崩溃/目标缺席 ⇒ degraded 归因如实
//   N-2 真 notary 铸证：witness 入锚（哈希域覆盖 —— 篡改见证 ⇒ 哈希失配）；四绿章
//      不因见证变红；endpoint 空 = 本地时间锚零网络（既有纪律保持）
//   N-3 RFC 3161 摘要域绑定：假 TSA 捕获请求 DER —— imprint 摘要 = sha256(canonical(
//      {seq, chainTip, mmrRoot, prevAnchorHash, witness}))（第三方回执连回放见证一起绑）
//   N-4 JSONL 落盘往返：见证随锚行落盘、reload 后逐字段复活
//   N-5 工具面接线：装配 ⇒ 回放完成铸锚（见证内容 = 步指纹序列 + 三态结局 + 成败）；
//      公证缺席 ⇒ 降级标注（回放照常、锚链零增量）；halt 中止也照铸不讳；
//      正常回放行为不受影响（物理派发计数与旧册同律）
//   N-7（ΝΩ-21）：journalDisk 磁盘指纹旁链与见证同锚共存 —— 哈希域/JSONL 往返/
//      复算注记/磁盘重写 drift 注记不翻章（驱逐盲区取证面接入回放铸证路径）
// 全离线确定性：零真网络（fetch 全注入）、零真机（system 假件计数）。
import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { journal } from '../src/journal.ts';
import { system } from '../src/system.ts';
import { stopBackend } from '../src/physicalBackend.ts';
import {
  notary,
  anchorReplayTrajectory,
  anchorReplayTrajectoryOn,
  replayStepFingerprint,
  canonical,
  sha256Hex,
  anchorHash,
  type AnchorRecord,
  type ReplayTrajectoryWitness,
  type NotaryTarget,
} from '../src/notary/index.ts';
import { sandboxLog } from '../src/sandbox/log.ts';
import { derRead, derChildren, derEncode } from '../src/notary/rfc3161.ts';
import { createReplayActionsTool, replayStepExecuted } from '../src/tools/replayActions.ts';
import { SAFETY_GATE_BLOCK } from '../src/tools/actionGate.ts';
import type { Config } from '../src/config.ts';

// ─── 见证工厂（字面量 —— 内容断言的事实源） ───

const WITNESS: ReplayTrajectoryWitness = {
  kind: 'replay-trajectory',
  version: 1,
  source: 'replay_actions',
  replayedSteps: 1,
  totalSteps: 2,
  success: false,
  halt: { gate: 'safety-gate', index: 1, tool: 'click_mouse' },
  steps: [
    { index: 0, tool: 'click_mouse', fingerprint: 'ab'.repeat(32), executed: true },
    { index: 1, tool: 'click_mouse', fingerprint: 'cd'.repeat(32), executed: false },
  ],
};

/** journal 播种：n 条安全点击步（入链带 hash —— 步指纹的既有事实源） */
async function seedJournal(n: number): Promise<void> {
  journal.reset();
  for (let i = 0; i < n; i++) {
    await journal.append({
      ts: 1_700_000_000 + i, tool: 'click_mouse',
      args: { x: (i + 1) / 10, y: 0.5, target_description: '菜单按钮' }, status: 'SUCCESS',
      effect_detected: true,
    });
  }
}

/** 首字符必然翻转（修复潮 F3-7 / N-6·N-7 概率性红自纠）：hex 摘要首字符
 *  1/16 概率本就是 'f' —— 旧篡改写死 'f' + rest 会让「改一字节 ⇒ hash 变」
 *  断言在那种情况下空转（值未变 ⇒ notEqual 失败，约 6% 概率偶发红）。
 *  本助手保证换出的首字符与原值**必然不同**，哈希域覆盖断言恒有效。 */
function flipFirstHexChar(hex: string): string {
  const orig = hex[0] ?? '0';
  return (orig === 'f' ? '0' : 'f') + hex.slice(1);
}

// ─── N-1 便捷面三态 ───

test('N-1: 假 notary 锚捕获摘要内容（anchored 事实字段）；未装配/失败/崩溃/缺席 ⇒ 诚实 degraded', async () => {
  // 正例：假 notary（结构性目标）捕获 anchorOnce 入参的 witness —— 摘要内容逐字段
  const captured: Array<Record<string, unknown>> = [];
  const fakeAnchor: AnchorRecord = {
    seq: 7, chainTip: 'tip', mmrRoot: null,
    timestamp: { source: 'local', anchoredAt: 1, nonce: 'bg==' },
    prevAnchorHash: null, hash: 'hash-1',
  };
  const fakeNotary: NotaryTarget = {
    isConfigured: () => true,
    anchorOnce: async (opts: Record<string, unknown>) => {
      captured.push(opts);
      return fakeAnchor;
    },
  };
  const ok = await anchorReplayTrajectoryOn(fakeNotary, WITNESS);
  assert.equal(ok.status, 'anchored');
  if (ok.status === 'anchored') {
    assert.equal(ok.anchorHash, 'hash-1');
    assert.equal(ok.timestampSource, 'local');
    assert.equal(ok.seq, 7);
  }
  assert.equal(captured.length, 1, '恰一次铸锚');
  assert.deepEqual((captured[0] as { witness: unknown }).witness, WITNESS, '见证原样透传（捕获执法）');

  // 反例 1：未装配 ⇒ degraded、绝不铸锚
  let unconfiguredCalls = 0;
  const unconfigured: NotaryTarget = {
    isConfigured: () => false,
    anchorOnce: async () => { unconfiguredCalls++; return fakeAnchor; },
  };
  const d1 = await anchorReplayTrajectoryOn(unconfigured, WITNESS);
  assert.equal(d1.status, 'degraded');
  if (d1.status === 'degraded') assert.match(d1.reason, /notary-not-configured/);
  assert.equal(unconfiguredCalls, 0, '未装配 ⇒ 铸锚面零调用');

  // 反例 2：铸锚失败（anchorOnce → null）⇒ degraded 带 lastError 归因
  const mintFail: NotaryTarget & { lastError: string | null } = {
    isConfigured: () => true,
    lastError: 'anchorOnce: disk on fire',
    anchorOnce: async () => null,
  };
  const d2 = await anchorReplayTrajectoryOn(mintFail, WITNESS);
  assert.equal(d2.status, 'degraded');
  if (d2.status === 'degraded') assert.match(d2.reason, /anchor-mint-failed/);

  // 反例 3：铸锚崩溃（throw）⇒ degraded 吞错绝不炸
  const boom: NotaryTarget = {
    isConfigured: () => true,
    anchorOnce: async () => { throw new Error('boom'); },
  };
  const d3 = await anchorReplayTrajectoryOn(boom, WITNESS);
  assert.equal(d3.status, 'degraded');
  if (d3.status === 'degraded') assert.match(d3.reason, /anchor-crashed/);

  // 反例 4：目标缺席 ⇒ degraded（旁路零行为）
  const d4 = await anchorReplayTrajectoryOn(null, WITNESS);
  assert.equal(d4.status, 'degraded');
  if (d4.status === 'degraded') assert.match(d4.reason, /notary-target-absent/);
});

// ─── N-2 真 notary 铸证：哈希域覆盖 + 四绿章 ───

test('N-2: 真 notary —— 见证随锚入册（哈希域覆盖：篡改见证 ⇒ 失配）；四绿章不红；本地锚零网络', async () => {
  notary.reset();
  notary.configure({ endpoint: '', tracePath: '' });
  await seedJournal(2);
  const r = await anchorReplayTrajectory(WITNESS);
  assert.equal(r.status, 'anchored', '装配（endpoint 空 = 本地锚零网络）⇒ 铸证成功');
  const anchor = notary.lastAnchor();
  assert.ok(anchor, '锚在册');
  assert.deepEqual(anchor!.witness, WITNESS, '见证逐字段随锚入册');

  // 哈希域覆盖：canonical(record − hash) 重算锚哈希一致；篡改见证任一字节 ⇒ 失配
  const domain = { ...anchor! } as Partial<AnchorRecord>;
  delete domain.hash;
  assert.equal(anchorHash(domain as Omit<AnchorRecord, 'hash'>), anchor!.hash, '见证在防篡改哈希域内');
  const tampered = { ...anchor!, witness: { ...WITNESS, success: true } };
  const tDomain = { ...tampered } as Partial<AnchorRecord>;
  delete tDomain.hash;
  assert.notEqual(anchorHash(tDomain as Omit<AnchorRecord, 'hash'>), tampered.hash, '篡改见证 ⇒ 哈希失配（公证防篡改执法）');

  // 四绿章核验：见证锚不引入红章（链完整/MMR/时间锚绿；重放章无沙箱段诚实 n/a）
  const report = notary.verifyNotary();
  assert.equal(report.ok, true);
  assert.equal(report.badges['chain-integrity'].status, 'green');
  assert.equal(report.badges['mmr-membership'].status, 'green');
  assert.equal(report.badges['timestamp-anchor'].status, 'green');
  assert.equal(report.badges['replay-consistency'].status, 'n/a');
  assert.equal(anchor!.timestamp.source, 'local', 'endpoint 空 ⇒ 本地时间锚（零网络纪律保持）');
});

// ─── N-3 RFC 3161 摘要域绑定 ───

test('N-3: 假 TSA —— imprint 摘要覆盖见证（第三方回执连回放证据一起绑定）', async () => {
  notary.reset();
  notary.configure({ endpoint: '', tracePath: '' }); // 装配（isConfigured 判据）
  await seedJournal(2);
  let capturedBody: Uint8Array | null = null;
  // 最小 TimeStampResp：回执内嵌请求自身的 digest+nonce（epochPi Π-3 同律的假 TSA）
  const OID = (bytes: number[]) => derEncode(0x06, Uint8Array.from(bytes));
  const SHA256_OID_ARMS = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
  const ID_CT_TSTINFO_ARMS = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x01, 0x04];
  const concat = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  };
  const fakeTsa = (async (_url: unknown, init: { body: Uint8Array }) => {
    capturedBody = init.body;
    const req = init.body;
    const root = derRead(req)!;
    const kids = derChildren(root, req);
    const imprint = derChildren(kids[1], req);
    const digest = req.subarray(imprint[1].contentStart, imprint[1].contentEnd);
    const nonce = req.subarray(kids[2].contentStart, kids[2].contentEnd);
    const tstInfo = derEncode(0x30, concat(
      derEncode(0x02, Uint8Array.of(1)),
      OID(ID_CT_TSTINFO_ARMS),
      derEncode(0x30, concat(derEncode(0x30, OID(SHA256_OID_ARMS)), derEncode(0x04, digest))),
      derEncode(0x02, Uint8Array.of(0x0a)),
      derEncode(0x18, new TextEncoder().encode('20260102030405Z')),
      derEncode(0x02, nonce),
    ));
    const contentInfo = derEncode(0x30, concat(OID(ID_CT_TSTINFO_ARMS), derEncode(0xa0, tstInfo)));
    const statusInfo = derEncode(0x30, derEncode(0x02, Uint8Array.of(0)));
    const reply = derEncode(0x30, concat(statusInfo, contentInfo));
    return {
      ok: true, status: 200,
      arrayBuffer: async () => reply.buffer.slice(reply.byteOffset, reply.byteOffset + reply.byteLength) as ArrayBuffer,
    };
  }) as unknown as typeof fetch;

  const r = await anchorReplayTrajectory(WITNESS, { endpoint: 'https://tsa.example/tsr', fetchImpl: fakeTsa, now: () => 1_735_689_600_000 });
  assert.equal(r.status, 'anchored');
  if (r.status === 'anchored') assert.equal(r.timestampSource, 'rfc3161', '回执取得 ⇒ 第三方源');
  assert.ok(capturedBody, 'TSA 请求捕获');

  // 执法：imprint = sha256(canonical({seq, chainTip, mmrRoot, prevAnchorHash, witness}))
  // —— 见证与账本状态同域入第三方时间背书
  const req = capturedBody as Uint8Array;
  const kids = derChildren(derRead(req)!, req);
  const imprintKids = derChildren(kids[1], req);
  const digestBytes = req.subarray(imprintKids[1].contentStart, imprintKids[1].contentEnd);
  const expected = sha256Hex(canonical({
    seq: journal.list(false).length,
    chainTip: journal.tip,
    mmrRoot: journal.mmrRoot(),
    prevAnchorHash: null, // N-2 重置后本测的首锚
    witness: WITNESS,
  }));
  assert.equal(
    Buffer.from(digestBytes.buffer, digestBytes.byteOffset, digestBytes.byteLength).toString('hex'),
    expected,
    'RFC 3161 摘要域覆盖见证（第三方回执绑定回放证据）',
  );
  // 离线复核章仍绿（token 复核走同一摘要域 —— 对称执法）
  const report = notary.verifyNotary();
  assert.equal(report.badges['timestamp-anchor'].status, 'green');
});

// ─── N-4 JSONL 落盘往返 ───

test('N-4: 见证随锚行落盘 JSONL、reload 后逐字段复活（断尾容忍律不动）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'w8-replaynotary-'));
  const trace = join(dir, 'anchors.jsonl');
  try {
    notary.reset();
    notary.configure({ endpoint: '', tracePath: trace }); // 落盘面从一开始就装配（锚行要写盘）
    await seedJournal(1);
    const first = await anchorReplayTrajectory(WITNESS);
    assert.equal(first.status, 'anchored');
    const withWitness = notary.lastAnchor();
    assert.ok(withWitness?.witness);
    notary.reset(); // 进程重启面：清内存（磁盘锚行在）
    notary.configure({ endpoint: '', tracePath: trace }); // 路径变更 ⇒ 重放铸回
    const revived = notary.lastAnchor();
    assert.ok(revived, '锚行铸回内存锚链');
    assert.deepEqual(revived!.witness, WITNESS, '见证随 JSONL 往返逐字段复活');
    assert.equal(revived!.hash, withWitness!.hash, '哈希往返一致');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── N-5 工具面接线（假 system —— 物理派发计数） ───

const originals = {
  getScreenSize: system.getScreenSize.bind(system),
  clickMouse: system.clickMouse.bind(system),
  typeText: system.typeText.bind(system),
};
let clicks = 0;
function installFakeSystem(): void {
  clicks = 0;
  system.getScreenSize = async () => ({ width: 1920, height: 1080 });
  system.clickMouse = async () => { clicks++; };
  system.typeText = async () => { /* 本册不键入 */ };
}

/** replay 工具测试配置：闸门词汇在场、验证关（聚焦 D-G5 接线，不碰 D-5 后端） */
const cfg = {
  enableApprovalGate: true,
  dangerPatterns: 'send,发送,pay,支付',
  enableRiskGate: true,
  riskPatterns: '',
  maxTextLength: 1000,
  verifyActions: false,
  replayMaxSteps: 100,
  enableJournal: true,
} as unknown as Config;

type Executable = { execute: (a: unknown) => Promise<string> };
async function runJson(tool: unknown, args: unknown): Promise<any> {
  const out = await (tool as Executable).execute(args);
  return JSON.parse(out);
}

beforeEach(() => {
  notary.reset(); // 未装配缺省态（公证缺席面）；装配用例就地 configure
  journal.reset();
  installFakeSystem();
});

afterEach(() => {
  system.getScreenSize = originals.getScreenSize;
  system.clickMouse = originals.clickMouse;
  system.typeText = originals.typeText;
});

// 测试进程无卸载钩子 —— 显式关停懒拉起的物理微服务（与 Δ 册同律）
after(async () => {
  await stopBackend();
});

test('N-5a: 公证缺席 ⇒ 诚实降级标注（回放照常、锚链零增量）—— 旧语义升级为申报在册的 degraded', async () => {
  await seedJournal(2);
  const out = await runJson(createReplayActionsTool(cfg), { confirm: true });
  assert.equal(out.status, 'SUCCESS', '回放不受公证缺席影响');
  assert.equal(out.state_anchor.replayed_steps, 2);
  assert.equal(clicks, 2, '物理派发照常（两步真实执行）');
  assert.equal(out.state_anchor.notarization.status, 'degraded', '公证缺席 ⇒ 降级标注在场');
  assert.match(out.state_anchor.notarization.reason, /notary-not-configured/, '降级归因申报（不再是无声的旧语义）');
  assert.equal(notary.anchorCount, 0, '锚链零增量（未装配绝不铸锚）');
});

test('N-5b: 装配 ⇒ 回放完成铸锚 —— 见证 = 步指纹序列（journal 链哈希）+ 三态结局 + 整体成败', async () => {
  notary.configure({ endpoint: '', tracePath: '' });
  await seedJournal(2);
  const entries = journal.list();
  const out = await runJson(createReplayActionsTool(cfg), { confirm: true });
  assert.equal(out.status, 'SUCCESS');
  assert.equal(clicks, 2);
  assert.equal(out.state_anchor.notarization.status, 'anchored');
  assert.equal(out.state_anchor.notarization.timestampSource, 'local', 'endpoint 空 ⇒ 本地锚零网络');
  const anchor = notary.lastAnchor();
  assert.ok(anchor?.witness, '见证随锚入册');
  const w = anchor!.witness!;
  assert.equal(w.kind, 'replay-trajectory');
  assert.equal(w.version, 1);
  assert.equal(w.source, 'replay_actions');
  assert.equal(w.totalSteps, 2);
  assert.equal(w.replayedSteps, 2, '两步皆 executed=true');
  assert.equal(w.success, true);
  assert.equal(w.halt, null);
  assert.equal(w.steps.length, 2);
  assert.equal(w.steps[0].tool, 'click_mouse');
  assert.equal(w.steps[0].fingerprint, entries[0].hash, '步指纹 = journal 链哈希（既有防篡改身份复用）');
  assert.equal(w.steps[1].fingerprint, entries[1].hash);
  assert.equal(w.steps[0].executed, true);
  assert.equal(w.steps[1].executed, true);
  assert.equal(out.state_anchor.notarization.anchorHash, anchor!.hash, '回执锚哈希与锚链一致（复核入口）');
  // 铸证是旁路：SUCCESS 形状既有字段全在（B-4 工厂方言不动）
  assert.equal(out.state_anchor.replayed_steps, 2);
  assert.ok(Array.isArray(out.state_anchor.detail));
  assert.equal(typeof out.next_step, 'string');
});

test('N-5c: halt 中止也照铸不讳 —— 见证携 halt 事实与失败步三态；步结局三态单测', async () => {
  notary.configure({ endpoint: '', tracePath: '' });
  journal.reset();
  await journal.append({
    ts: 1, tool: 'click_mouse',
    args: { x: 0.5, y: 0.5, target_description: '发送订单' }, status: 'SUCCESS',
  });
  const out = await runJson(createReplayActionsTool(cfg), { confirm: true });
  assert.equal(out.status, 'PARTIAL_FAILURE', '危险步被闸门拦截 ⇒ fail-fast（Δ 审计#1 语义不动）');
  assert.equal(clicks, 0, '拦截步未派发');
  assert.equal(out.state_anchor.notarization.status, 'anchored', '中止也是结局 —— 照铸不讳');
  const w = notary.lastAnchor()!.witness!;
  assert.equal(w.success, false);
  assert.deepEqual(w.halt, { gate: 'safety-gate', index: 0, tool: 'click_mouse' });
  assert.equal(w.totalSteps, 1);
  assert.equal(w.replayedSteps, 0);
  assert.equal(w.steps[0].executed, false, '闸门拦截步 = false（未执行且失败）');

  // 步结局三态（纯函数单测）：执行/失败/跳过（null —— 未执行非失败）
  assert.equal(replayStepExecuted('clicked'), true);
  assert.equal(replayStepExecuted('typed'), true);
  assert.equal(replayStepExecuted('FAILED: boom'), false);
  assert.equal(replayStepExecuted(`FAILED: [${SAFETY_GATE_BLOCK}] ...`), false);
  assert.equal(replayStepExecuted('SKIPPED (unsupported for replay: foo)'), null);
  assert.equal(replayStepExecuted('OK (model-side recovery instruction; nothing to execute)'), null);
  assert.equal(replayStepExecuted(undefined), null);
  assert.equal(replayStepExecuted(42 as unknown as string), null, '非字符串 ⇒ null（绝不抛）');

  // 步指纹：journal 链哈希优先；缺席 ⇒ canonical({tool,args}) 的 sha256；垃圾 ⇒ 空串
  assert.equal(replayStepFingerprint({ tool: 't', args: { a: 1 }, hash: 'chain-hash' }), 'chain-hash');
  assert.equal(
    replayStepFingerprint({ tool: 't', args: { a: 1 } }),
    sha256Hex(canonical({ tool: 't', args: { a: 1 } })),
    '链哈希缺席 ⇒ canonical 摘要兜底',
  );
  assert.equal(replayStepFingerprint(null), '', '垃圾记录 ⇒ 空指纹（绝不抛）');
});

// ─── N-6（ΑΩ-R42）：旁链快照与回放见证同锚共存 —— 双账覆盖的哈希域与水合往返 ───

test('N-6: 旁链快照与见证同锚共存（哈希域覆盖）；JSONL 往返逐字段复活；复算注记在场', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'w8-replaynotary-r42-'));
  const trace = join(dir, 'anchors.jsonl');
  try {
    // 在场旁链播种：knowledge 学习史链上一条（ΑΩ-R42 双账覆盖的对象账本）
    sandboxLog.reset();
    await sandboxLog.append('knowledge-learned', { skill: 'menu-path' });
    notary.reset();
    notary.configure({ endpoint: '', tracePath: trace });
    await seedJournal(2);
    const r = await anchorReplayTrajectory(WITNESS);
    assert.equal(r.status, 'anchored');
    const anchor = notary.lastAnchor();
    assert.ok(anchor?.witness && anchor.auxChains, 'D-G5 见证与 ΑΩ-R42 旁链快照同锚共存');
    assert.deepEqual(anchor!.auxChains, [{ chainName: 'sandboxLog', seq: 1, chainTip: sandboxLog.tip }],
      '三元组忠实映射（学习史链尖）');

    // 哈希域覆盖：改旁链三元组一字节（tip 首字符必然翻转 ⇒ 锚 hash 失配）
    const tampered = {
      ...anchor!,
      auxChains: [{ ...anchor!.auxChains![0], chainTip: flipFirstHexChar(anchor!.auxChains![0].chainTip) }],
    };
    const tDomain = { ...tampered } as Partial<AnchorRecord>;
    delete tDomain.hash;
    assert.notEqual(anchorHash(tDomain as Omit<AnchorRecord, 'hash'>), tampered.hash, '改 auxChains 一字节 ⇒ 锚 hash 变');

    // 四绿章不红（旁链复算一致 + 见证在册）；knowledge 段非排练 ⇒ 重放章诚实 n/a
    const report = notary.verifyNotary();
    assert.equal(report.badges['timestamp-anchor'].status, 'green');
    assert.match(report.badges['timestamp-anchor'].detail, /aux chain sandboxLog re-walk over 1 entry reproduces/);
    assert.equal(report.badges['replay-consistency'].status, 'n/a');
    assert.equal(report.ok, true);

    // JSONL 往返（水合路径）：auxChains 随锚行落盘、reload 后逐字段复活
    notary.reset();
    notary.configure({ endpoint: '', tracePath: trace });
    const revived = notary.lastAnchor();
    assert.ok(revived, '锚行铸回内存锚链');
    assert.deepEqual(revived!.auxChains, [{ chainName: 'sandboxLog', seq: 1, chainTip: sandboxLog.tip }],
      '旁链快照随 JSONL 往返复活');
    assert.deepEqual(revived!.witness, WITNESS, '见证同律往返');
    assert.equal(revived!.hash, anchor!.hash, '哈希往返一致');
    const report2 = notary.verifyNotary();
    assert.equal(report2.badges['timestamp-anchor'].status, 'green', '复活锚复核照常（旁链复算仍一致）');
  } finally {
    sandboxLog.reset();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── N-7（ΝΩ-21）：journalDisk 旁链与回放见证同锚共存 —— 回放铸证路径的磁盘取证面 ───

test('N-7: journalDisk 与见证同锚共存（哈希域覆盖）；JSONL 往返复活；磁盘重写 ⇒ drift 注记不翻章', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'w8-replaynotary-n21-'));
  const disk = join(dir, 'journal-disk.jsonl');
  const trace = join(dir, 'anchors.jsonl');
  try {
    // 磁盘账本播种：2 行 JSONL（append-only 形态 —— journalDisk 旁链的登记对象）
    const twoLines = '{"tool":"click_mouse","i":1}\n{"tool":"click_mouse","i":2}\n';
    writeFileSync(disk, twoLines, 'utf8');
    const expectedTip = sha256Hex(twoLines);
    sandboxLog.reset(); // 旁链只留 journalDisk（沙箱缺席面 —— 断言确定性）
    notary.reset();
    notary.configure({ endpoint: '', tracePath: trace, journalDiskPath: disk });
    await seedJournal(2);
    const r = await anchorReplayTrajectory(WITNESS);
    assert.equal(r.status, 'anchored');
    const anchor = notary.lastAnchor();
    assert.ok(anchor?.witness && anchor.auxChains, 'D-G5 见证与 ΝΩ-21 磁盘指纹旁链同锚共存');
    assert.deepEqual(anchor!.auxChains,
      [{ chainName: 'journalDisk', seq: 2, chainTip: expectedTip }],
      '三元组 = (journalDisk, 完整行数, 行字节整体 sha256)');

    // 哈希域覆盖：改旁链三元组一字节（chainTip 首字符必然翻转 ⇒ 锚 hash 失配）
    const tampered = {
      ...anchor!,
      auxChains: [{ ...anchor!.auxChains![0], chainTip: flipFirstHexChar(anchor!.auxChains![0].chainTip) }],
    };
    const tDomain = { ...tampered } as Partial<AnchorRecord>;
    delete tDomain.hash;
    assert.notEqual(anchorHash(tDomain as Omit<AnchorRecord, 'hash'>), tampered.hash, '改 journalDisk 三元组一字节 ⇒ 锚 hash 变');

    // 复算一致 ⇒ 注记在场；四绿章不红（见证与磁盘指纹互不牵连）
    const report = notary.verifyNotary();
    assert.equal(report.badges['timestamp-anchor'].status, 'green');
    assert.match(report.badges['timestamp-anchor'].detail,
      /journalDisk re-hash over the sworn 2-line prefix reproduces its fingerprint/);
    assert.equal(report.badges['replay-consistency'].status, 'n/a');
    assert.equal(report.ok, true);

    // JSONL 往返（水合路径）：journalDisk 快照随锚行落盘、reload 后逐字段复活
    notary.reset();
    notary.configure({ endpoint: '', tracePath: trace, journalDiskPath: disk });
    const revived = notary.lastAnchor();
    assert.ok(revived, '锚行铸回内存锚链');
    assert.deepEqual(revived!.auxChains,
      [{ chainName: 'journalDisk', seq: 2, chainTip: expectedTip }],
      '磁盘指纹快照随 JSONL 往返复活');
    assert.deepEqual(revived!.witness, WITNESS, '见证同律往返');
    assert.equal(revived!.hash, anchor!.hash, '哈希往返一致');

    // 磁盘史锚后被重写（第 2 行内容更换、行数不变）⇒ disk-chain-drift 注记在场、章不翻红
    writeFileSync(disk, '{"tool":"click_mouse","i":1}\n{"tool":"click_mouse","i":"REWRITTEN"}\n', 'utf8');
    const report2 = notary.verifyNotary();
    assert.equal(report2.badges['timestamp-anchor'].status, 'green', '注记级核验不翻章（锚定 ≠ 内容为真）');
    assert.match(report2.badges['timestamp-anchor'].detail, /disk-chain-drift/, '磁盘重写证词在场');
    assert.equal(report2.ok, true);
  } finally {
    sandboxLog.reset();
    rmSync(dir, { recursive: true, force: true });
  }
});
