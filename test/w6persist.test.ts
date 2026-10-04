// test/w6persist.test.ts
// W6-4（持久化缝包）执法册：
//   T-1 信任账往返 —— 记账 → 原子落盘（tmp+fsync+rename，无 .tmp 残留）→
//      resetFederationRuntime → loadFederationTrust 恢复 → federationTrustReport
//      逐字段一致（含派生 trust）；落盘字节确定（字典序 + 注入时钟）；
//   T-2 防御恢复（垃圾归先验）—— 档级垃圾（非对象/版本错配/accounts 非数组/
//      坏 JSON）⇒ 整档拒绝（内存账不动）；条目级垃圾（无 sourceId）⇒ skipped；
//      字段级垃圾（applied/regressed 非数/负数）⇒ 归 0（regressed 垃圾 ⇒ trust
//      回先验 1）；恢复是整体替换（不与内存残账合并）；幂等；
//   T-3 节流 —— 突变计数制：armed + flushEvery=N ⇒ 每 N 次记账恰一次落盘；
//      写失败保留计数 ⇒ 下次突变即重试；未武装 ⇒ flush 幂等 no-op、零落盘；
//      resetFederationRuntime 解除武装；
//   T-4 掺入闸语义零变化 —— 恢复档上的 regressed=1 ⇒ 掺入配额折半，与同状态
//      在线会话（recordFederationTrust 现记）逐字段一致；恢复后 applied 续账；
//   T-5 AGENT_NOTE 白名单隔离 —— marker 入链（status='MARKER'、哈希链完整）
//      但绝不进 ACTION_TOOLS：list(true)/sinceTaskStart（重放与技能归纳的原料
//      视图）全部跳过黑板行；
//   T-6 黑板事件入桩 journal —— wireBoardJournal 注入桩：成功 claim/post 铸
//      AGENT_NOTE（载荷有界）；失败路径（inactive/empty/lease-conflict）不入链；
//      桩抛错不炸黑板协议；null 复位回真 journal（缺省通道）；
//   T-7 restore 空板 + 审计留痕 —— 崩溃模拟（journal.reset + restoreChain +
//      coordinator.restore）：黑板诚实重建为空（租约不复活），链上 AGENT_NOTE
//      行留痕可查（verify 全绿），新会话继续落新行。
// 全程离线确定性：注入存储（tmp 目录 + 桩）、注入时钟、无网络。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EvidenceLedger } from '../src/kernel/registry.ts';
import { ACTION_TOOLS, journal, type JournalMarker } from '../src/journal.ts';
import { coordinator, type BoardJournalPort } from '../src/subAgent.ts';
import {
  recordFederationTrust,
  federationTrustOf,
  federationTrustReport,
  federationTrustPersistenceStatus,
  resetFederationRuntime,
  serializeFederationTrust,
  restoreFederationTrust,
  loadFederationTrust,
  armFederationTrustPersistence,
  flushFederationTrust,
  createFederationTrustFileStore,
  applyFederatedEvidence,
  DEFAULT_TRUST_FLUSH_EVERY,
  type FederationTrustStore,
} from '../src/federation/index.ts';

// ─── 一次性 tmp 目录（进程退出 best-effuit 清理） ───
const dirs: string[] = [];
function freshDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

beforeEach(() => {
  resetFederationRuntime(); // 联邦运行时隔离（含解除持久化武装）
  journal.reset();
  coordinator.reset();
  coordinator.configure(3, 10);
});
afterEach(() => {
  resetFederationRuntime();
  journal.reset();
  coordinator.reset();
});

/** 桩存储：捕获落盘文本（离线确定性；可注入失败） */
function spyStore(onSave?: (text: string) => { ok: boolean; error?: string }): FederationTrustStore & { saves: string[]; loads: string[] } {
  const s = {
    saves: [] as string[],
    loads: [] as string[],
    load(): string | null { return null; },
    save(text: string): { ok: boolean; error?: string } {
      s.saves.push(text);
      return onSave ? onSave(text) : { ok: true };
    },
  };
  return s;
}

/** 铸一个 n=10、全质量在坨 0 success 列的本地账本（掺入闸测试的靶） */
function localLedgerN10(): EvidenceLedger {
  const ledger = new EvidenceLedger();
  for (let i = 0; i < 10; i++) ledger.record({ key: 'k.persist', success: true, margin: -0.9, ts: i });
  return ledger;
}

/** 远端合并摘要（手铸确定性件：坨 0 success 列 16 质量） */
const REMOTE_DIGEST = {
  v: 1 as const,
  mintedAt: 42,
  epsilon: 1,
  keys: [{ key: 'k.persist', n: 16, bins: [[16, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]] }],
};

// ─── T-1：信任账往返（原子落盘 + 恢复一致） ───

test('T-1: 文件存储往返 —— 落盘原子（无 .tmp 残留）、恢复后报告逐字段一致', () => {
  const dir = freshDir('w6trust-');
  const file = path.join(dir, 'trust.json');
  const store = createFederationTrustFileStore(file);

  // 在线记账：先回归折半，再由掺入累计 applied
  recordFederationTrust('src-a', { regressed: 1 });
  recordFederationTrust('src-b', { applied: 7 });
  const before = federationTrustReport();
  assert.deepEqual(before, [
    { sourceId: 'src-a', applied: 0, regressed: 1, trust: 0.5 },
    { sourceId: 'src-b', applied: 7, regressed: 0, trust: 1 },
  ]);

  assert.equal(armFederationTrustPersistence(store), true, '武装成功');
  const fl = flushFederationTrust();
  assert.equal(fl.ok, true);
  assert.equal(fl.written, 2);
  assert.ok(existsSync(file), '档已存在');
  assert.ok(!existsSync(file + '.tmp'), '原子换名：无 .tmp 残留');

  // 崩溃模拟：运行时全清 → 从档恢复
  resetFederationRuntime();
  assert.deepEqual(federationTrustReport(), [], '崩溃后内存空账');
  const rep = loadFederationTrust(store);
  assert.equal(rep.restored, 2);
  assert.equal(rep.skipped, 0);
  assert.deepEqual(federationTrustReport(), before, '恢复后 dump 面逐字段一致');
  assert.equal(federationTrustOf('src-a'), 0.5, '派生 trust 由 regressed 重算');
  assert.equal(federationTrustOf('src-b'), 1);
  assert.equal(federationTrustOf('src-unknown'), 1, '未立账源：初见全信先验');
});

test('T-1: 序列化字节确定 —— 注入时钟两次同字节；sourceId 字典序；trust 不落盘', () => {
  recordFederationTrust('zz', { applied: 1 });
  recordFederationTrust('aa', { regressed: 2 });
  const s1 = serializeFederationTrust(() => 123456);
  const s2 = serializeFederationTrust(() => 123456);
  assert.equal(s1, s2, '同账本态 + 同时钟 ⇒ 同字节');
  const doc = JSON.parse(s1) as { v: number; savedAt: number; accounts: Array<Record<string, unknown>> };
  assert.equal(doc.v, 1);
  assert.equal(doc.savedAt, 123456);
  assert.deepEqual(doc.accounts.map(a => a.sourceId), ['aa', 'zz'], '字典序落盘');
  for (const a of doc.accounts) assert.ok(!('trust' in a), '派生 trust 不落盘（单一真值源，档上无可投毒值）');
});

test('T-1: 恢复幂等 —— 同档恢复两次结果一致', () => {
  const doc = { v: 1, savedAt: 0, accounts: [{ sourceId: 'x', applied: 3, regressed: 1 }] };
  const r1 = restoreFederationTrust(doc);
  const r2 = restoreFederationTrust(doc);
  assert.deepEqual(r1, r2);
  assert.deepEqual(federationTrustReport(), [{ sourceId: 'x', applied: 3, regressed: 1, trust: 0.5 }]);
});

// ─── T-2：防御恢复（垃圾归先验） ───

test('T-2: 档级垃圾 ⇒ 整档拒绝（内存账不动）', () => {
  recordFederationTrust('live', { applied: 1 });
  const snapshot = federationTrustReport();
  for (const garbage of [null, 42, 'text', [], true, {}, { v: 2, accounts: [] }, { v: 1, accounts: 'no' }]) {
    const rep = restoreFederationTrust(garbage);
    assert.equal(rep.restored, 0, `垃圾档不恢复：${JSON.stringify(garbage)}`);
    assert.ok(rep.note, '拒绝原因注记在案');
    assert.deepEqual(federationTrustReport(), snapshot, '内存账不受档级垃圾牵连');
  }
});

test('T-2: 条目级垃圾跳过、字段级垃圾归先验（regressed 垃圾 ⇒ trust 1）', () => {
  const rep = restoreFederationTrust({
    v: 1, savedAt: 0,
    accounts: [
      null, 42, { applied: 1 }, { sourceId: '', applied: 1 },               // 条目级垃圾 → skipped
      { sourceId: 'bad', applied: 'abc', regressed: -3 },                    // 字段级垃圾 → 归 0
      { sourceId: 'floor', applied: 2.9, regressed: 1.9 },                   // 非整数 → 取整
    ],
  });
  assert.equal(rep.restored, 2);
  assert.equal(rep.skipped, 4);
  assert.deepEqual(federationTrustReport(), [
    { sourceId: 'bad', applied: 0, regressed: 0, trust: 1 },   // 垃圾归先验：trust 回 1
    { sourceId: 'floor', applied: 2, regressed: 1, trust: 0.5 },
  ]);
  assert.equal(federationTrustOf('bad'), 1);
});

test('T-2: 恢复是整体替换（不与内存残账合并）', () => {
  recordFederationTrust('stale', { applied: 100 });
  const rep = restoreFederationTrust({ v: 1, savedAt: 0, accounts: [{ sourceId: 'fresh', applied: 1, regressed: 0 }] });
  assert.equal(rep.restored, 1);
  assert.equal(federationTrustOf('stale'), 1, '残账源已被档替换（初见全信）');
  assert.deepEqual(federationTrustReport(), [{ sourceId: 'fresh', applied: 1, regressed: 0, trust: 1 }]);
});

test('T-2: loadFederationTrust —— 档缺席/坏 JSON/端口异常各按诚实方向收敛', () => {
  assert.ok(loadFederationTrust(null).note?.includes('缺席'), '端口缺席');
  assert.ok(loadFederationTrust({} as FederationTrustStore).note?.includes('缺席'), '结构非法端口按缺席');
  assert.ok(loadFederationTrust({ load: () => null, save: () => ({ ok: true }) }).note?.includes('冷启动'), '无档 = 冷启动空账');
  assert.ok(loadFederationTrust({ load: () => 'garbage{', save: () => ({ ok: true }) }).note?.includes('坏 JSON'), '坏 JSON 整档拒绝');
  const rep = loadFederationTrust({ load: () => { throw new Error('boom'); }, save: () => ({ ok: true }) });
  assert.equal(rep.restored, 0, '端口抛错 ⇒ 防御兜底（绝不炸）');
  assert.deepEqual(federationTrustReport(), []);
});

// ─── T-3：突变计数节流 ───

test('T-3: 节流 —— 每 N 次突变恰一次落盘；冲刷后计数归零；内容即账本态', () => {
  const spy = spyStore();
  assert.equal(armFederationTrustPersistence(spy, { flushEvery: 3 }), true);
  recordFederationTrust('a', { applied: 1 });   // 突变 1
  recordFederationTrust('a', { regressed: 1 }); // 突变 2
  assert.equal(spy.saves.length, 0, '未到阈值零落盘');
  assert.equal(federationTrustPersistenceStatus().pendingMutations, 2);
  recordFederationTrust('b', { applied: 1 });   // 突变 3 → 触发
  assert.equal(spy.saves.length, 1, '第 3 次突变恰一次落盘');
  assert.equal(federationTrustPersistenceStatus().pendingMutations, 0, '成功落盘后计数归零');
  const doc = JSON.parse(spy.saves[0]) as { accounts: Array<{ sourceId: string; applied: number; regressed: number }> };
  assert.deepEqual(doc.accounts, [
    { sourceId: 'a', applied: 1, regressed: 1 },
    { sourceId: 'b', applied: 1, regressed: 0 },
  ]);
  // 垃圾记账也是突变（recordFederationTrust 的 set 语义不变 —— 掺入闸零变化）
  assert.ok(recordFederationTrust('a', { applied: Number.NaN }) === undefined);
  recordFederationTrust('a', { applied: 1 });
  recordFederationTrust('a', { applied: 1 });
  assert.equal(spy.saves.length, 2, '后续节流周期照常触发');
});

test('T-3: 写失败保留计数 ⇒ 下次突变即重试；重武装可换好盘', () => {
  const failing = spyStore(() => ({ ok: false, error: 'disk full' }));
  assert.equal(armFederationTrustPersistence(failing, { flushEvery: 1 }), true);
  recordFederationTrust('a', { applied: 1 });
  assert.equal(failing.saves.length, 1, '阈值 1：首次突变即尝试');
  assert.equal(federationTrustPersistenceStatus().pendingMutations, 1, '失败不清计数');
  const bad = flushFederationTrust();
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'disk full');
  assert.equal(failing.saves.length, 2, '强制冲刷是显式尝试（不算突变写放大）');
  recordFederationTrust('a', { applied: 1 });
  assert.equal(failing.saves.length, 3, '下次突变即重试（每突变至多一次尝试）');
  assert.deepEqual(federationTrustReport(), [{ sourceId: 'a', applied: 2, regressed: 0, trust: 1 }], '持久化失败不反噬内存执法');
  // 重武装换好盘（幂等：以后一次为准）→ 冲刷成功
  const good = spyStore();
  assert.equal(armFederationTrustPersistence(good, { flushEvery: 1 }), true);
  recordFederationTrust('a', { applied: 1 });
  assert.equal(good.saves.length, 1);
  assert.equal(federationTrustPersistenceStatus().pendingMutations, 0);
});

test('T-3: 缺省未武装 —— 零落盘、flush 幂等 no-op、reset 解除武装', () => {
  const st = federationTrustPersistenceStatus();
  assert.equal(st.armed, false);
  assert.equal(st.flushEvery, DEFAULT_TRUST_FLUSH_EVERY);
  for (let i = 0; i < 20; i++) recordFederationTrust('a', { applied: 1 });
  const noop = flushFederationTrust();
  assert.deepEqual(noop, { ok: true, written: 0 }, '未武装是合法配置态：flush 幂等 no-op');
  // 武装后再 reset → 解除（测试隔离缝）
  assert.equal(armFederationTrustPersistence(spyStore()), true);
  assert.equal(federationTrustPersistenceStatus().armed, true);
  resetFederationRuntime();
  assert.equal(federationTrustPersistenceStatus().armed, false, 'reset 解除武装');
  recordFederationTrust('a', { applied: 1 });
  assert.deepEqual(flushFederationTrust(), { ok: true, written: 0 });
});

test('T-3: arm 拒绝结构非法端口；非法 flushEvery 回落缺省', () => {
  assert.equal(armFederationTrustPersistence(null), false);
  assert.equal(armFederationTrustPersistence({ load: () => null } as unknown as FederationTrustStore), false);
  assert.equal(federationTrustPersistenceStatus().armed, false);
  assert.equal(armFederationTrustPersistence(spyStore(), { flushEvery: Number.NaN }), true);
  assert.equal(federationTrustPersistenceStatus().flushEvery, DEFAULT_TRUST_FLUSH_EVERY, '非法阈值回落缺省');
});

// ─── T-4：掺入闸语义零变化 ───

test('T-4: 恢复档的信任照常执法 —— 配额折半与在线会话逐字段一致；applied 续账', () => {
  // 会话 1（在线）：regressed=1 ⇒ trust 0.5 ⇒ 配额折半（cap 5 → quota 2）
  recordFederationTrust('src-a', { regressed: 1 });
  const r1 = applyFederatedEvidence(localLedgerN10(), REMOTE_DIGEST, { sourceId: 'src-a', now: () => 999 });
  assert.equal(r1.ok, true);
  assert.equal(r1.trust, 0.5);
  assert.equal(r1.applied, 2);
  assert.deepEqual(r1.perKey.map(p => ({ quota: p.quota, injected: p.injected, reason: p.reason })), [{ quota: 2, injected: 2, reason: 'blended' }]);
  const report1 = federationTrustReport(); // 含掺入自动续账 applied=2

  // 崩溃 → 落盘 → 恢复
  const dir = freshDir('w6gate-');
  const store = createFederationTrustFileStore(path.join(dir, 'trust.json'));
  armFederationTrustPersistence(store);
  assert.equal(flushFederationTrust().ok, true);
  resetFederationRuntime();
  const rep = loadFederationTrust(store);
  assert.equal(rep.restored, 1);
  assert.deepEqual(federationTrustReport(), report1, '恢复后账本态 = 崩溃前（含续账）');

  // 会话 2（恢复态）：同摘要同靶 ⇒ 同配额（闸语义零变化的实证）
  const r2 = applyFederatedEvidence(localLedgerN10(), REMOTE_DIGEST, { sourceId: 'src-a', now: () => 999 });
  assert.equal(r2.trust, r1.trust);
  assert.equal(r2.applied, r1.applied);
  assert.deepEqual(r2.perKey, r1.perKey);
  assert.deepEqual(federationTrustReport(), [{ sourceId: 'src-a', applied: 4, regressed: 1, trust: 0.5 }], '恢复态上继续续账');
});

test('T-4: 显式 trust 注入优先 —— 恢复态不改变既有解析序', () => {
  restoreFederationTrust({ v: 1, savedAt: 0, accounts: [{ sourceId: 'src-a', applied: 0, regressed: 3 }] });
  assert.equal(federationTrustOf('src-a'), 0.25);
  const r = applyFederatedEvidence(localLedgerN10(), REMOTE_DIGEST, { sourceId: 'src-a', trust: 1, now: () => 1 });
  assert.equal(r.trust, 1, '显式 trust 覆盖信任账（既有语义）');
  assert.equal(r.applied, 5, 'cap=floor(0.5×10)=5 全额');
  // 未恢复过的源：初见全信（既有语义）
  const r2 = applyFederatedEvidence(localLedgerN10(), REMOTE_DIGEST, { sourceId: 'stranger', now: () => 1 });
  assert.equal(r2.trust, 1);
  assert.equal(r2.applied, 5);
});

// ─── T-5：AGENT_NOTE 白名单隔离（绝不污染动作重放） ───

test('T-5: AGENT_NOTE 入链受哈希链保护，但不在 ACTION_TOOLS / list(true) / sinceTaskStart', async () => {
  assert.ok(!ACTION_TOOLS.includes('AGENT_NOTE'), '黑板行绝不进动作重放白名单');
  journal.markTaskStart('任务');
  await journal.append({ ts: 1, tool: 'click_mouse', args: { x: 0.5 }, status: 'SUCCESS' });
  await journal.appendMarker({ kind: 'AGENT_NOTE', agentId: 'a1', event: 'claim', subject: '竞品调研' });
  await journal.append({ ts: 2, tool: 'type_text', args: { text: 'x' }, status: 'SUCCESS' });
  await journal.appendMarker({ kind: 'AGENT_NOTE', agentId: 'a1', event: 'post', subject: '竞品调研', body: '免费版限 3 项目' });

  const all = journal.list(false);
  assert.equal(all.length, 4, '黑板行入全量链');
  const notes = all.filter(e => e.tool === 'AGENT_NOTE');
  assert.equal(notes.length, 2);
  for (const n of notes) {
    assert.equal(n.status, 'MARKER', 'marker 语义（processScore 的 status 旁路 / doctorRules 纯度律同判）');
    assert.ok(typeof n.hash === 'string' && n.hash.length > 0, '链上哈希在案');
  }
  assert.equal(notes[0].args.agentId, 'a1');
  assert.equal(notes[0].args.event, 'claim');
  assert.equal(notes[0].args.subject, '竞品调研');
  assert.ok(!('body' in notes[0].args), 'claim 无 body 键');
  assert.equal(notes[1].args.body, '免费版限 3 项目');

  assert.deepEqual(journal.list(true).map(e => e.tool), ['click_mouse', 'type_text'], '重放视图跳过黑板行');
  assert.deepEqual(journal.sinceTaskStart().map(e => e.tool), ['click_mouse', 'type_text'], '技能归纳切片跳过黑板行');
  const v = journal.verify();
  assert.equal(v.ok, true, '混合链（动作+黑板行）verify 全绿');
  assert.equal(v.length, 4);
});

test('T-5: 黑板行参与防篡改 —— 篡改 AGENT_NOTE 载荷 ⇒ 链断点定位', async () => {
  await journal.append({ ts: 1, tool: 'click_mouse', args: {}, status: 'SUCCESS' });
  await journal.appendMarker({ kind: 'AGENT_NOTE', agentId: 'a1', event: 'claim', subject: '原主题' });
  const entries = (journal as unknown as { entries: Array<{ tool: string; args: { subject?: string } }> }).entries;
  entries[1].args.subject = '篡改主题';
  const v = journal.verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 1, '黑板行与动作行同受哈希链执法');
});

// ─── T-6：黑板事件入桩 journal ───

test('T-6: 成功 claim/post 铸 AGENT_NOTE 入桩；失败路径不入链；桩抛错不炸', () => {
  const seen: JournalMarker[] = [];
  coordinator.wireBoardJournal({ appendMarker: m => { seen.push(m); } });
  coordinator.spawn([{ id: 's1', role: '调研员', objective: '查定价', maxSteps: 5 }]);
  coordinator.spawn([{ id: 's2', role: '复核员', objective: '复核', maxSteps: 5 }]);

  assert.ok(coordinator.claim('s1', '竞品A定价调研').ok);
  assert.equal(coordinator.post('s1', '竞品A定价调研', '免费版只支持3个项目'), true);
  assert.equal(seen.length, 2, '恰两行：claim + post');
  assert.deepEqual(seen[0], { kind: 'AGENT_NOTE', agentId: 's1', event: 'claim', subject: '竞品A定价调研' });
  assert.deepEqual(seen[1], { kind: 'AGENT_NOTE', agentId: 's1', event: 'post', subject: '竞品A定价调研', body: '免费版只支持3个项目' });

  // 失败路径不入链（只有成功突变才铸审计行）
  assert.equal(coordinator.claim('ghost', '任务').ok, false); // inactive-agent
  assert.equal(coordinator.claim('s1', '   ').ok, false); // empty-subject
  assert.equal(coordinator.claim('s2', '竞品A定价调研').ok, false); // lease-conflict（语义撞租约让位）
  assert.equal(coordinator.post('s2', '竞品A定价调研', ''), false); // 空 body
  assert.equal(seen.length, 2, '失败路径零入链');

  // 桩抛错 ⇒ 黑板协议照常（审计是旁路义务）
  coordinator.wireBoardJournal({ appendMarker() { throw new Error('boom'); } });
  const res = coordinator.claim('s2', '异主题调研');
  assert.deepEqual(res, { ok: true }, '端口炸不炸黑板');
  assert.equal(coordinator.post('s2', '异主题调研', '发现X'), true);
});

test('T-6: 异步拒绝桩不产生 unhandled rejection；null 复位回真 journal 缺省通道', async () => {
  coordinator.wireBoardJournal({ appendMarker() { return Promise.reject(new Error('async boom')); } });
  coordinator.spawn([{ id: 's1', role: 'r', objective: 'o', maxSteps: 3 }]);
  assert.ok(coordinator.claim('s1', '主题R').ok);
  await new Promise(r => setImmediate(r)); // 拒绝已被吞（绝不炸进程）

  coordinator.wireBoardJournal(null); // 复位缺省
  assert.ok(coordinator.claim('s1', '主题S').ok);
  const rows = journal.list(false).filter(e => e.tool === 'AGENT_NOTE');
  assert.equal(rows.length, 1, '缺省通道 = 真 journal 单例');
  assert.equal(rows[0].args.subject, '主题S');
});

// ─── T-7：restore 空板 + 审计留痕 ───

test('T-7: 崩溃恢复 —— 黑板诚实重建为空（租约不复活），链上审计行留痕可查', async () => {
  // 会话 1：两个代理 + claim/post（缺省真 journal 通道 → AGENT_NOTE 入链）
  coordinator.spawn([{ id: 'r1', role: '调研员', objective: 'o1', maxSteps: 5 }]);
  coordinator.spawn([{ id: 'r2', role: '复核员', objective: 'o2', maxSteps: 5 }]);
  assert.ok(coordinator.claim('r1', '主题甲').ok);
  assert.equal(coordinator.post('r1', '主题甲', '发现甲'), true);
  await new Promise(r => setImmediate(r)); // 等 fire-and-forget marker 落链
  assert.equal(coordinator.blackboard().length, 2, '崩溃前板上有租约+发现');

  const rows = journal.list(false);
  const tip = journal.tip;
  const snap = coordinator.dump();
  assert.ok(rows.some(e => e.tool === 'AGENT_NOTE'), '崩溃前黑板行已入链');

  // 崩溃模拟：journal 与协调器全清，再各自恢复
  journal.reset();
  coordinator.restore(snap);
  assert.equal(coordinator.blackboard().length, 0, '黑板不自动复活锁：恢复 = 空板（步数钟跨进程失效，无证据不臆造）');

  journal.restoreChain(rows, tip);
  const v = journal.verify();
  assert.equal(v.ok, true, '审计链恢复后 verify 全绿');
  const notes = journal.list(false).filter(e => e.tool === 'AGENT_NOTE');
  assert.equal(notes.length, 2, '审计行留痕：谁曾认领/张贴过什么，链上可查');
  assert.equal(notes[0].args.agentId, 'r1');
  assert.equal(notes[0].args.event, 'claim');
  assert.equal(notes[1].args.body, '发现甲');

  // 新会话续行：恢复后的代理可重新认领（新租约 + 新审计行，审计不因空板断流）
  assert.ok(coordinator.claim('r2', '主题乙').ok);
  await new Promise(r => setImmediate(r));
  const notes2 = journal.list(false).filter(e => e.tool === 'AGENT_NOTE');
  assert.equal(notes2.length, 3, '新会话黑板事件继续入链');
  assert.equal(coordinator.blackboard().length, 1);
});

test('T-7: 桩端口是接线态不是随档态 —— restore/reset 不改接线；AGENT_NOTE 行与既有 marker 同形', async () => {
  const seen: JournalMarker[] = [];
  const port: BoardJournalPort = { appendMarker: m => { seen.push(m); } };
  coordinator.wireBoardJournal(port);
  coordinator.spawn([{ id: 'w1', role: 'r', objective: 'o', maxSteps: 3 }]);
  assert.ok(coordinator.claim('w1', '主题W').ok);
  coordinator.reset();
  coordinator.spawn([{ id: 'w1', role: 'r', objective: 'o', maxSteps: 3 }]);
  assert.ok(coordinator.claim('w1', '主题W2').ok);
  assert.equal(seen.length, 2, 'reset/重生不解除接线（与 configure 同律：接线态非随档态）');
  // 与既有 marker 同形：AGENT_BEGIN 与 AGENT_NOTE 均为 tool=kind、status=MARKER 的链上行
  const all = journal.list(false);
  assert.ok(all.some(e => e.tool === 'AGENT_BEGIN' && e.status === 'MARKER'));
  assert.ok(all.every(e => e.status === 'MARKER' || e.status === 'SUCCESS'));
  assert.equal(journal.verify().ok, true);
});
