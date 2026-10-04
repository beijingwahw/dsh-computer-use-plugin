// test/w2queue.test.ts
// W2-1（H4 暂存式离线批准队列）执法册：
//   H4-1 超时入队与降级路径 —— 通道缺席 ⇒ 拒绝暂存维持阻塞审批；未到超时 /
//      已授予 / 令牌缺席 / 队列封顶各自拒绝；到点入队携带证据链；重复入队幂等；
//   H4-2 持久化与恢复 —— tmp+rename 原子写（无 .tmp 残留）、跨进程（重新武装）
//      恢复、垃圾档/垃圾条目归零不连坐、落盘失败 ⇒ 内存队列照常 + takeGranted
//      拒绝交出执行权（宁可保守不可双发）；
//   H4-3 晨报清单 —— sleep 第⑥幕消费待批队列（清单/计数/JSONL 行/旁路故障
//      吞为注记；dep 缺席 ⇒ 字段诚实缺席 —— 既有行为零回归）；
//   H4-4 批注式批量裁决 —— 一次批注多项、每项各铸 amendment（original=各自
//      描述）、Y-10 逐项计费（桶空 ⇒ rate-limited 保持待批）、deny 恒可、
//      双重裁决封堵、未知 id / 重复 id 防御；
//   H4-5 TTL 保守律 —— 过期不自动作废、grant 保守拒绝（须重走完整审批）、
//      晨报持续标注过期、deny 仍是清场出口；
//   H4-6 grantDetailed 裁决传播 —— 暂存令牌被交互式 grant/deny ⇒ 在途条目
//      同步裁决（Y-10 不双计）；takeGranted 铸已授予执行令牌（amendment 随行，
//      V 纪元验收式消费照常）；
//   H4-7 checkpoint 续跑 —— approval-queue 段随档往返、stepCursor 步账
//      （已暂存的可逆部分不重复执行）、恢复后 takeGranted 消费恰一次；
//      段结构垃圾 ⇒ 归零 + SKIPPED、条目级垃圾 ⇒ 弃置保好；
//   H4-8 工具面透明化 —— request_approval 的 staging 锚点、
//      adjudicate_approval_queue 批量裁决输出。
// 全程离线确定性：注入时钟 / 注入存储（tmp 目录）、码从带外 sink 采集、
// 不依赖 CSPRNG 具体取值（只断言格式与行为）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  approval, approvalQueue, approvalBudget, resetApproval, setConfirmCodeChannel,
  createApprovalQueueFileStorage,
} from '../src/approval.ts';
import { runSleepCycle, resetSleepCycle, type SleepDeps, type SleepApprovalQueueLike } from '../src/sleep/index.ts';
import { saveCheckpoint, loadCheckpoint } from '../src/checkpoint.ts';
import { uiMemory } from '../src/uiMemory.ts';
import { failureMemory } from '../src/failureMemory.ts';
import { skillLibrary } from '../src/skillLibrary.ts';
import { telemetry } from '../src/telemetry.ts';
import { journal } from '../src/journal.ts';
import { createRequestApprovalTool, createAdjudicateApprovalQueueTool } from '../src/tools/approvalTools.ts';
import type { Config } from '../src/config.ts';

// ─── 测试基建（离线确定性） ───

const dirs: string[] = [];
let dir: string;
function newDir(): string {
  dir = mkdtempSync(path.join(tmpdir(), 'w2q-'));
  dirs.push(dir);
  return dir;
}
process.on('exit', () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

/** 注入时钟：base 在铸造**前**锚定（stage 的超时判定 = 注入钟 − 真钟铸造点，
 *  两侧差 δ 为毫秒级 —— 步进值留足数量级余量，行为判定确定性不受影响） */
let clockBase = 0;
let clockOffset = 0;
function resetClock(): void { clockBase = Date.now(); clockOffset = 0; }
function now(): number { return clockBase + clockOffset; }
function advance(ms: number): void { clockOffset += ms; }

/** 武装采集型带外 sink（生产中人类的视角）+ 注入时钟/存储的队列 */
function armAll(opts: { queueFile?: string; stagingTimeoutMs?: number; ttlMs?: number } = {}): void {
  approvalQueue.arm({
    now,
    ...(opts.queueFile !== undefined ? { storage: createApprovalQueueFileStorage(opts.queueFile) } : {}),
    ...(opts.stagingTimeoutMs !== undefined ? { stagingTimeoutMs: opts.stagingTimeoutMs } : {}),
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
  });
}

/** 采集型带外通道（暂存资格的宿主在场信号；码从带外采集 —— 生产中人类的视角） */
const deliveries: Array<{ token: string; confirmCode: string }> = [];
function armChannel(): void {
  deliveries.length = 0;
  setConfirmCodeChannel(d => { deliveries.push({ token: d.token, confirmCode: d.confirmCode }); });
}
/** 令牌对应的带外码（不存在 ⇒ 空串 = 无码降级路径） */
function codeOf(token: string): string {
  return deliveries.find(d => d.token === token)?.confirmCode ?? '';
}

/** 铸造一个已过暂存超时的未应答请求并入队（多数用例的标准前置） */
async function stageOne(over: {
  description?: string; ttlMs?: number; stepCursor?: number; riskTier?: string;
} = {}): Promise<{ token: string; id: string }> {
  const pa = approval.request(over.description ?? 'click 发送 to submit the report', {
    actionShape: { tool: 'click_mouse', x: 0.5, y: 0.5, target_description: over.description ?? '发送' },
  });
  advance(301_000); // 越过缺省 5min 暂存超时
  const r = approvalQueue.stageAction({
    token: pa.token,
    description: over.description ?? 'click 发送 to submit the report',
    evidence: {
      screenshotRef: 'journal#snap-0123',
      sceneFingerprint: 'dhash:9e8a7b6c5d4e',
      riskTier: over.riskTier ?? 'irreversible-high',
      actionShape: { tool: 'click_mouse', x: 0.5, y: 0.5, target_description: '发送' },
    },
    ...(over.ttlMs !== undefined ? { ttlMs: over.ttlMs } : {}),
    ...(over.stepCursor !== undefined ? { stepCursor: over.stepCursor } : {}),
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw new Error('unreachable');
  return { token: pa.token, id: r.entry.id };
}

beforeEach(() => {
  resetApproval(); // 簿记/桶/观察者/带外通道/暂存队列（W2-1）一并归零
  resetSleepCycle();
  resetClock();
  uiMemory.reset();
  failureMemory.reset();
  skillLibrary.reset();
  telemetry.reset();
  journal.reset();
  dir = newDir();
});

/** 工具执行面便捷转换 */
type Exec = (args: unknown) => Promise<string>;
function exec(t: unknown): Exec {
  return (t as unknown as { execute: (a: unknown) => Promise<string> }).execute.bind(t);
}

// ─── H4-1：超时入队与降级路径 ───

test('H4-1: 超时入队与降级路径 —— 通道缺席维持阻塞审批；到点入队携带证据链；各类拒绝面', async () => {
  // 降级路径：带外通道缺席（宿主不在场）⇒ 拒绝暂存，现行阻塞审批原样可用
  armAll(); // 只武装队列（时钟/缺省超时），通道未接
  let pa = approval.request('send email to Bob');
  advance(301_000);
  const refused = approvalQueue.stageAction({ token: pa.token, description: 'send email to Bob' });
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.reason, 'channel-absent', '宿主缺席 ⇒ 不入暂存模式（保守方向）');
  // W6R fail-closed：通道缺席 ⇒ grant 同样拒绝（无码同意已废除 —— 令牌记
  // degraded，grantDetailed 返 confirm-channel-absent；用户须经宿主 UI 完成人证）
  assert.equal(approval.grant(pa.token, true), false, '无码 grant 已废除（fail-closed）');
  assert.deepEqual(approval.grantDetailed(pa.token, true), { ok: false, reason: 'confirm-channel-absent' });
  // 拒绝路径（否决）无需人证 —— 恒可行
  assert.equal(approval.grant(pa.token, false), true);

  // 通道在场：未到超时 ⇒ 拒绝（retryInMs 透明）
  armChannel();
  armAll();
  resetClock();
  pa = approval.request('send the invoice');
  const early = approvalQueue.stageAction({ token: pa.token, description: 'send the invoice' });
  assert.equal(!early.ok && early.reason, 'not-timed-out-yet');
  assert.ok(!early.ok && (early.retryInMs ?? 0) > 0, '剩余等待毫秒数透明');

  // 已授予 ⇒ 无需暂存（交互路径已恢复；带码审批携码授予）
  assert.deepEqual(
    approval.grantDetailed(pa.token, true, { confirmCode: codeOf(pa.token) }),
    { ok: true },
    '带外码经人手交回后授予（模型只是邮差）',
  );
  const granted = approvalQueue.stageAction({ token: pa.token, description: 'send the invoice' });
  assert.equal(!granted.ok && granted.reason, 'already-granted');

  // 令牌缺席 ⇒ 拒绝（须先 request_approval 铸造）
  assert.equal(!approvalQueue.stageAction({ token: 'APR-NEVER', description: 'x' }).ok
    && (approvalQueue.stageAction({ token: 'APR-NEVER', description: 'x' }) as { reason?: string }).reason === 'invalid-token', true);

  // 到点入队：条目结构与证据链完整
  resetClock();
  const { token, id } = await stageOne({ description: 'delete the production record', stepCursor: 7 });
  assert.match(id, /^QA-[0-9A-F]{16}$/, 'QA- 前缀 CSPRNG id（批量裁决寻址面）');
  const st = approvalQueue.queueStats();
  assert.equal(st.entries, 1);
  assert.equal(st.pending, 1);
  const summary = approvalQueue.pendingSummary();
  assert.equal(summary.items.length, 1);
  const item = summary.items[0];
  assert.equal(item.description, 'delete the production record');
  assert.equal(item.riskTier, 'irreversible-high');
  assert.equal(item.screenshotRef, 'journal#snap-0123');
  assert.equal(item.sceneFingerprint, 'dhash:9e8a7b6c5d4e');
  assert.equal(item.actionTool, 'click_mouse');
  assert.equal(item.ttlExpired, false);
  assert.equal(approvalQueue.dumpQueue()[0].stepCursor, 7, '续跑步账随行');
  assert.equal(approvalQueue.dumpQueue()[0].token, token, '触发令牌可追溯');
  // type_text 类证据脱敏（隐私铁律在入队面执法）
  const pt = approval.request('type the password');
  advance(301_000);
  const rt = approvalQueue.stageAction({
    token: pt.token, description: 'type the password',
    evidence: { actionShape: { tool: 'type_text', text: 'super-secret-plaintext' } },
  });
  assert.equal(rt.ok, true);
  if (rt.ok) {
    assert.deepEqual(rt.entry.evidence.actionShape, { tool: 'type_text', text_length_bucket: 'medium' },
      '队列证据链绝不携带文本原文（只记长度桶）');
  }

  // 重复入队幂等：同令牌再 stage ⇒ 返回既有条目 + duplicate 标注
  const dup = approvalQueue.stageAction({ token, description: 'delete the production record' });
  assert.equal(dup.ok, true);
  if (dup.ok) { assert.equal(dup.duplicate, true); assert.equal(dup.entry.id, id); }
  assert.equal(approvalQueue.queueStats().entries, 2, '幂等 ≠ 复制');

  // 队列封顶：灌满 64 条 ⇒ 第 65 条拒绝（逼一次人工介入）
  for (let i = 0; i < 62; i++) { // 已有 2 条
    const p = approval.request(`bulk op ${i}`);
    advance(1);
    const rr = approvalQueue.stageAction({ token: p.token, description: `bulk op ${i}` });
    assert.equal(rr.ok, true, `第 ${i + 3} 条入队`);
  }
  assert.equal(approvalQueue.queueStats().entries, 64);
  const overflowP = approval.request('one too many');
  advance(1);
  const overflow = approvalQueue.stageAction({ token: overflowP.token, description: 'one too many' });
  assert.equal(!overflow.ok && overflow.reason, 'queue-full', '封顶拒绝');
});

// ─── H4-2：持久化与恢复（含垃圾段） ───

test('H4-2: 队列持久化与恢复 —— 原子写无 tmp 残留、跨进程恢复、垃圾归零、落盘失败保守', async () => {
  const qfile = path.join(dir, 'approval-queue.json');

  // 入队 + 批量裁决一条（denied）⇒ 落盘
  armChannel();
  armAll({ queueFile: qfile });
  const a = await stageOne({ description: 'send the report to Alice' });
  const b = await stageOne({ description: 'delete the temp folder' });
  const adj = approvalQueue.adjudicate([b.id], false, '不要删');
  assert.equal(adj.results[0].outcome, 'denied');
  assert.ok(existsSync(qfile), '队列已落盘');
  assert.ok(!existsSync(qfile + '.tmp'), '原子写：换名后无 tmp 残留');
  const raw = JSON.parse(readFileSync(qfile, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.entries.length, 2);
  assert.equal(raw.entries.find((e: { id: string }) => e.id === b.id).decision.verdict, 'denied', '裁决随档');
  assert.equal(raw.entries.find((e: { id: string }) => e.id === a.id).decision, undefined, '待批条目无裁决');

  // 跨进程模拟：重新武装（同一文件）⇒ 条目与裁决都恢复
  resetApproval();
  resetClock();
  armChannel();
  armAll({ queueFile: qfile });
  const s2 = approvalQueue.pendingSummary();
  assert.equal(s2.items.length, 1, '待批条目恢复');
  assert.equal(s2.deniedAwaitingPrune, 1, '已拒条目恢复');
  assert.equal(s2.items[0].description, 'send the report to Alice');

  // 垃圾档：非 JSON ⇒ 归零不炸
  writeFileSync(qfile, '{{{not json', 'utf8');
  resetApproval();
  armAll({ queueFile: qfile });
  assert.equal(approvalQueue.queueStats().entries, 0, '垃圾档 ⇒ 空队列（归零）');

  // 合法 JSON 但结构垃圾：entries 非数组 ⇒ 归零
  writeFileSync(qfile, JSON.stringify({ version: 1, entries: 'garbage' }), 'utf8');
  resetApproval();
  armAll({ queueFile: qfile });
  assert.equal(approvalQueue.queueStats().entries, 0);

  // 条目级垃圾：好条目保住、坏条目弃置（不连坐）
  const goodEntry = {
    id: 'QA-GOOD0000000001', token: 'APR-GOOD', description: 'good entry',
    evidence: { riskTier: 'high' }, enqueuedAt: 1000, ttlMs: 86_400_000, expiresAt: 86_401_000,
  };
  writeFileSync(qfile, JSON.stringify({
    version: 1,
    entries: [goodEntry, 42, null, { id: 'QA-NODESC' }, goodEntry],
  }), 'utf8');
  resetApproval();
  armAll({ queueFile: qfile });
  assert.equal(approvalQueue.queueStats().entries, 1, '好条目恢复；垃圾/重复 id 弃置');
  assert.equal(approvalQueue.pendingSummary().items[0].description, 'good entry');

  // 落盘失败路径：存储指向不可写位置（父路径是普通文件）⇒ stage 内存照常、
  // persistError 在案；takeGranted 拒绝交出执行权（持久化先行 —— 宁可保守不可双发）
  const blocker = path.join(dir, 'blocker.txt');
  writeFileSync(blocker, 'x', 'utf8');
  const badStorage = createApprovalQueueFileStorage(path.join(blocker, 'nested', 'q.json'));
  resetApproval();
  resetClock();
  armChannel();
  approvalQueue.arm({ now, storage: badStorage });
  const c = await stageOne({ description: 'unpersistable op' });
  assert.equal(approvalQueue.queueStats().entries, 1, '落盘失败 ⇒ 内存队列仍有效（降级不丢功能）');
  assert.ok(approvalQueue.queueStats().persistError !== undefined, '持久化错误在案（透明化）');
  const adjc = approvalQueue.adjudicate([c.id], true);
  assert.equal(adjc.results[0].outcome, 'granted');
  assert.equal(adjc.persisted, false, '批量裁决如实上报持久化失败');
  assert.equal(approvalQueue.takeGranted(), null, '落盘失败 ⇒ 拒绝交出执行权（双发封堵）');
});

// ─── H4-3：晨报清单输出 ───

/** 假 journal（水位线指纹面；条目可控） */
function fakeJournal(entries: Array<{ hash: string }>) {
  return {
    list: (actionOnly = true) => (actionOnly ? [] : entries),
    verify: () => ({ ok: true, length: entries.length, brokenAt: null }),
  };
}

test('H4-3: 晨报消费待批队列 —— 清单/计数/JSONL 行齐全；dep 缺席零回归；故障/说谎 dep 旁路吸收', async () => {
  const trace = path.join(dir, 'sleep-trace.jsonl');
  const base = { list: () => [] as unknown[], verify: () => ({ ok: true, length: 0, brokenAt: null }) };

  // 队列：2 待批 + 1 过期 + 1 已批待续跑
  armChannel();
  armAll();
  const p1 = await stageOne({ description: 'send invoice #1' });
  const p2 = await stageOne({ description: 'send invoice #2' });
  const p3 = await stageOne({ description: 'stale delete op', ttlMs: 1_000 });
  const p4 = await stageOne({ description: 'already approved send' });
  advance(1_500); // p3 TTL 到期（1s 宽度）
  approvalQueue.adjudicate([p4.id], true);

  const deps: SleepDeps = {
    journal: fakeJournal([{ hash: 'w2q-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]) as unknown as SleepDeps['journal'],
    approvalQueue,
    log: () => { /* 测试静音 */ },
  };
  const r1 = await runSleepCycle(deps, { sleepTracePath: trace, now });
  assert.ok(r1.acts[5].status === 'ok', JSON.stringify(r1.acts));
  // SleepReport 结构面：清单随晨报携带
  assert.ok(r1.approvalQueue);
  assert.equal(r1.approvalQueue!.pending, 2);
  assert.equal(r1.approvalQueue!.expired, 1, '过期条目显式标注（TTL 保守律的晨报面）');
  assert.equal(r1.approvalQueue!.grantedAwaitingResume, 1);
  const ids = new Set(r1.approvalQueue!.items.map(i => i.id));
  assert.ok(ids.has(p1.id) && ids.has(p2.id) && ids.has(p3.id), '待批清单含全部未裁决条目');
  assert.equal(r1.approvalQueue!.items.find(i => i.id === p3.id)!.ttlExpired, true);
  // 晨报幕计数 + 附注
  const morning = r1.acts[5];
  assert.equal(morning.counts.queuePending, 2);
  assert.equal(morning.counts.queueExpired, 1);
  assert.equal(morning.counts.queueGrantedAwaiting, 1);
  assert.ok((morning.detail ?? '').includes('待批队列'), morning.detail);
  // JSONL 行携带清单（人回来后的裁决素材）
  const line = JSON.parse(readFileSync(trace, 'utf8').trim().split('\n')[0]);
  assert.equal(line.type, 'sleep');
  assert.equal(line.approvalQueue.items.length, 3);
  assert.equal(line.approvalQueue.items.find((i: { id: string }) => i.id === p3.id).ttlExpired, true);

  // dep 缺席 ⇒ 字段诚实缺席（既有睡眠行为零回归）
  resetSleepCycle();
  const r2 = await runSleepCycle(
    { journal: fakeJournal([{ hash: 'w2q-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }]) as unknown as SleepDeps['journal'], log: () => {} },
    { sleepTracePath: trace, now },
  );
  assert.equal(r2.approvalQueue, undefined, '不伪造空清单');
  assert.equal(r2.acts[5].counts.queuePending, undefined);

  // 故障 dep：pendingSummary 抛 ⇒ 晨报照常落盘，注记吸收
  resetSleepCycle();
  const bomb: SleepApprovalQueueLike = { pendingSummary: () => { throw new Error('queue exploded'); } };
  const r3 = await runSleepCycle(
    { journal: fakeJournal([{ hash: 'w2q-ccccccccccccccccccccccccccccccc' }]) as unknown as SleepDeps['journal'], approvalQueue: bomb, log: () => {} },
    { sleepTracePath: trace, now },
  );
  assert.equal(r3.acts[5].status, 'ok', '队列摘要故障不炸晨报');
  assert.equal(r3.approvalQueue, undefined);
  assert.ok((r3.acts[5].detail ?? '').includes('待批队列摘要故障'), r3.acts[5].detail);

  // 说谎 dep：回垃圾 ⇒ 净化（坏条目滤除、数值归零）
  resetSleepCycle();
  const liar: SleepApprovalQueueLike = {
    pendingSummary: () => ({
      pending: 'x', expired: {}, grantedAwaitingResume: 1, deniedAwaitingPrune: 0,
      items: [42, null, { id: 'QA-LYING00000001', description: 'ok entry' }, { id: '', description: 'no id' }],
    }) as unknown as ReturnType<SleepApprovalQueueLike['pendingSummary']>,
  };
  const r4 = await runSleepCycle(
    { journal: fakeJournal([{ hash: 'w2q-dddddddddddddddddddddddddddddddd' }]) as unknown as SleepDeps['journal'], approvalQueue: liar, log: () => {} },
    { sleepTracePath: trace, now },
  );
  assert.ok(r4.approvalQueue);
  assert.equal(r4.approvalQueue!.pending, 0, '垃圾数值归零');
  assert.equal(r4.approvalQueue!.items.length, 1, '垃圾条目滤除、合法条目保住');
  void base; // （占位：保持与假件工厂的一致风格）
});

// ─── H4-4：批注式批量裁决 ───

test('H4-4: 批量裁决 —— 一次批注多项、各铸 amendment、Y-10 逐项计费、双重裁决封堵', async () => {
  armChannel();
  armAll();
  const e1 = await stageOne({ description: 'send the morning digest' });
  const e2 = await stageOne({ description: 'archive the project folder' });
  const e3 = await stageOne({ description: 'submit the tax form' });
  const e4 = await stageOne({ description: 'pay the electricity bill' });

  // Y-10 缺省桶容量 3：四项同批 grant ⇒ 3 批 1 限流（批量不是 click-fatigue 后门）
  const budgetBefore = approvalBudget();
  const NOTE = '都同意，但改用正式抬头签名再发';
  const r = approvalQueue.adjudicate([e1.id, e2.id, e3.id, e4.id], true, NOTE);
  assert.deepEqual(
    r.results.map(x => ({ id: x.id, outcome: x.outcome })),
    [
      { id: e1.id, outcome: 'granted' },
      { id: e2.id, outcome: 'granted' },
      { id: e3.id, outcome: 'granted' },
      { id: e4.id, outcome: 'rate-limited' },
    ],
    JSON.stringify(r.results),
  );
  assert.equal(approvalBudget(), budgetBefore - 3, '每项 grant 恰消耗一枚同意预算');
  assert.equal(r.persisted, true);

  // 每个条目按自身描述各铸 amendment（一次批注 → 多份结构化 patch）
  const entries = approvalQueue.dumpQueue();
  for (const id of [e1.id, e2.id, e3.id]) {
    const d = entries.find(x => x.id === id)!.decision!;
    assert.equal(d.verdict, 'granted');
    assert.equal(d.amendment!.note, NOTE, '批注原文透传');
    assert.equal(d.amendment!.targetDescriptionDelta.corrected, NOTE);
    assert.equal(d.amendment!.actionShapeCorrection.target_description, NOTE);
  }
  assert.notEqual(
    entries.find(x => x.id === e1.id)!.decision!.amendment!.targetDescriptionDelta.original,
    entries.find(x => x.id === e2.id)!.decision!.amendment!.targetDescriptionDelta.original,
    'original = 各自条目描述（非共享宿主）',
  );

  // 双重裁决封堵：已裁决条目拒绝翻案
  const again = approvalQueue.adjudicate([e1.id], false);
  assert.equal(again.results[0].outcome, 'already-decided');
  // 未知 id / 重复 id 防御
  assert.equal(approvalQueue.adjudicate(['QA-NOSUCH'], true).results[0].outcome, 'unknown-id');
  const dupIds = approvalQueue.adjudicate([e4.id, e4.id], false, '算了不付');
  assert.equal(dupIds.results.length, 1, '同 id 重复出现只裁一次');
  assert.equal(dupIds.results[0].outcome, 'denied', 'deny 恒可（不占预算、不设 TTL 门槛）');
  assert.equal(approvalQueue.dumpQueue().find(x => x.id === e4.id)!.decision!.amendment!.note, '算了不付');

  // ids 缺省 ⇒ 全部待批条目（此处已无待批 —— 零裁决零落盘）
  const empty = approvalQueue.adjudicate(undefined, true);
  assert.equal(empty.results.length, 0);
  assert.equal(empty.persisted, true, '零突变 ⇒ 无落盘义务');
  const summary = approvalQueue.pendingSummary();
  assert.equal(summary.grantedAwaitingResume, 3);
  assert.equal(summary.deniedAwaitingPrune, 1);
  assert.equal(summary.items.length, 0, '已全部裁决 ⇒ 清单空');
});

// ─── H4-5：TTL 过期保守路径 ───

test('H4-5: TTL 保守律 —— 过期不自动作废、grant 保守拒绝、晨报持续标注、deny 是清场出口', async () => {
  armChannel();
  armAll();
  const fresh = await stageOne({ description: 'fresh op' });
  const stale = await stageOne({ description: 'stale op', ttlMs: 1_000 });
  advance(1_500); // stale 到期；fresh（24h 宽度）仍有效

  // 过期条目不蒸发：仍在清单中且显式标注
  const s = approvalQueue.pendingSummary();
  assert.equal(s.pending, 1);
  assert.equal(s.expired, 1);
  assert.equal(s.items.find(i => i.id === stale.id)!.ttlExpired, true);
  assert.equal(s.items.find(i => i.id === fresh.id)!.ttlExpired, false);

  // grant 过期条目 ⇒ 保守拒绝（陈年同意不可兑换成不可逆操作），条目保持待批
  const budgetBefore = approvalBudget();
  const r = approvalQueue.adjudicate([stale.id], true);
  assert.equal(r.results[0].outcome, 'ttl-expired');
  assert.equal(approvalBudget(), budgetBefore, '过期拒绝不烧同意预算');
  assert.equal(approvalQueue.queueStats().pending, 2, '过期 ≠ 作废 —— 条目留队');
  // 再次列入晨报（持续唠叨直到用户显式处理）
  assert.equal(approvalQueue.pendingSummary().expired, 1);

  // 有效条目照常可批
  assert.equal(approvalQueue.adjudicate([fresh.id], true).results[0].outcome, 'granted');

  // deny 过期条目恒可 —— 用户清场的出口
  const d = approvalQueue.adjudicate([stale.id], false, '这件事别做了');
  assert.equal(d.results[0].outcome, 'denied');
  assert.equal(approvalQueue.pendingSummary().expired, 0, '清场后过期清单归零');
});

// ─── H4-6：grantDetailed 裁决传播 + takeGranted 续跑执行令牌 ───

test('H4-6: 交互式裁决传播（Y-10 不双计）；takeGranted 铸已授予令牌（amendment 随行、验收式消费照常）', async () => {
  armChannel();
  armAll();
  const e1 = await stageOne({ description: 'send the contract' });
  const e2 = await stageOne({ description: 'delete the draft' });

  // 传播·授予：暂存令牌被交互式 grant（携码 + 批注）⇒ 在途条目同步裁决
  const budgetBefore = approvalBudget();
  assert.deepEqual(
    approval.grantDetailed(e1.token, true, { confirmCode: codeOf(e1.token), note: '同意，但用附件形式发' }),
    { ok: true },
    '带外码经人手交回后授予',
  );
  assert.equal(approvalBudget(), budgetBefore - 1, 'Y-10 恰计一次（传播不双计）');
  const d1 = approvalQueue.dumpQueue().find(x => x.id === e1.id)!.decision!;
  assert.equal(d1.verdict, 'granted');
  assert.equal(d1.amendment!.note, '同意，但用附件形式发');

  // 传播·否决：拒绝路径同样铸批注（否决理由随行）
  assert.deepEqual(approval.grantDetailed(e2.token, false, { note: '草稿留着还有用' }), { ok: true });
  const d2 = approvalQueue.dumpQueue().find(x => x.id === e2.id)!.decision!;
  assert.equal(d2.verdict, 'denied');
  assert.equal(d2.amendment!.note, '草稿留着还有用');

  // 续跑消费：铸已授予执行令牌（amendment 原样携带；V 纪元生命周期照常）
  assert.equal(approvalQueue.pendingSummary().grantedAwaitingResume, 1);
  const taken = approvalQueue.takeGranted();
  assert.ok(taken, '最早已批条目可取');
  assert.equal(taken!.entry.id, e1.id);
  assert.equal(taken!.entry.decision!.amendment!.note, '同意，但用附件形式发');
  assert.equal(approval.validate(taken!.executionToken), true, '执行令牌已授予');
  assert.equal(approvalBudget(), budgetBefore - 1, 'takeGranted 不再扣预算（裁决时已扣）');
  // 执行侧批注消费点（W1-2 API 原样工作）
  const am = approval.amendmentOf(taken!.executionToken);
  assert.equal(am!.targetDescriptionDelta.original, 'send the contract');
  const plan = approval.applyAmendment(taken!.executionToken, {
    tool: 'click_mouse', x: 0.5, y: 0.5, target_description: 'send the contract',
  });
  assert.equal(plan.target_description, '同意，但用附件形式发', '续跑执行照修正后的计划');
  // V 纪元验收式消费照常：beginAttempt → consume
  assert.equal(approval.beginAttempt(taken!.executionToken), true);
  assert.equal(approval.consume(taken!.executionToken), true);
  // 恰一次：已消费 ⇒ 再取为空
  assert.equal(approvalQueue.takeGranted(), null);
  assert.equal(approvalQueue.pendingSummary().deniedAwaitingPrune, 1, '已拒条目留档待审计清理');
});

// ─── H4-7：checkpoint 段与续跑步账 ───

test('H4-7: checkpoint 续跑 —— approval-queue 段随档往返、stepCursor 步账、恢复后消费恰一次；垃圾段归零', async () => {
  const cpFile = path.join(dir, 'cp.json');

  // 已暂存的可逆部分先入 journal（步账的事实源）
  await journal.append({ ts: Date.now(), tool: 'click_mouse', args: { x: 0.1, target_description: '打开发件箱' }, status: 'SUCCESS', effect_detected: true });
  await journal.append({ ts: Date.now() + 1, tool: 'type_text', args: { text: 'report body' }, status: 'SUCCESS', effect_detected: true });

  armChannel();
  armAll();
  // 不可逆动作超时入队（stepCursor = 当前账面 2 步 —— 此前可逆部分不重演）
  const staged = await stageOne({ description: 'click 发送 to submit', stepCursor: journal.list(false).length });
  assert.equal(staged.id !== '', true);
  approvalQueue.adjudicate([staged.id], true, '同意发送');

  // 保存 → 快照含队列段
  const saved = saveCheckpoint(cpFile);
  assert.equal(saved.ok, true, saved.error);
  const rawCp = JSON.parse(readFileSync(cpFile, 'utf8'));
  assert.ok(Array.isArray(rawCp.approvalQueue?.entries), 'approval-queue 段随档');
  assert.equal(rawCp.approvalQueue.entries.length, 1);

  // 模拟崩溃：全部归零
  resetApproval();
  journal.reset();
  uiMemory.reset();
  assert.equal(journal.list(false).length, 0);

  // 恢复：队列与步账同时满血
  const { restored, report } = loadCheckpoint(cpFile);
  assert.equal(restored, true, report.join('; '));
  assert.ok(report.some(l => l.startsWith('approvalQueue: OK')), report.join('; '));
  assert.equal(journal.list(false).length, 2, '已暂存的可逆部分在账上（不重复执行）');
  assert.equal(approvalQueue.pendingSummary().grantedAwaitingResume, 1, '已批条目跨崩溃存活');

  // 续跑消费：stepCursor 指示重演起点；执行令牌照常验收式消费；恰一次
  const taken = approvalQueue.takeGranted();
  assert.ok(taken);
  assert.equal(taken!.entry.stepCursor, 2, '步账恢复：只重演 cursor 之后的步骤');
  assert.equal(approval.validate(taken!.executionToken), true);
  assert.equal(approval.consume(taken!.executionToken), true);
  assert.equal(approvalQueue.takeGranted(), null);

  // 段结构垃圾 ⇒ 归零 + SKIPPED 注记（不连坐其余 section）
  const tampered = path.join(dir, 'cp-garbage.json');
  const bad = { ...rawCp, approvalQueue: { entries: 'not-an-array' } };
  writeFileSync(tampered, JSON.stringify(bad));
  resetApproval();
  const rg = loadCheckpoint(tampered);
  assert.equal(rg.restored, true);
  assert.ok(rg.report.some(l => l.startsWith('approvalQueue: SKIPPED')), rg.report.join('; '));
  assert.equal(approvalQueue.queueStats().entries, 0, '垃圾段 ⇒ 队列归零（不残留不冒充）');
  assert.equal(journal.list(false).length, 2, '其余 section 照常恢复（坏段隔离）');

  // 条目级垃圾 ⇒ 弃置保好（dropped 注记进报告）
  const mixed = path.join(dir, 'cp-mixed.json');
  const entry = rawCp.approvalQueue.entries[0];
  writeFileSync(mixed, JSON.stringify({ ...rawCp, approvalQueue: { entries: [entry, { junk: true }, 3] } }));
  resetApproval();
  const rm2 = loadCheckpoint(mixed);
  assert.equal(rm2.restored, true);
  assert.ok(rm2.report.some(l => l.startsWith('approvalQueue: OK')), rm2.report.join('; '));
  assert.ok(rm2.report.some(l => l.includes('DROPPED 2')), rm2.report.join('; '));
  assert.equal(approvalQueue.queueStats().entries, 1, '好条目保住');

  // W2-1 前旧档（无段）⇒ 不触队列（缺段冷启动，非错误 —— section 惯例仍记 OK 行）
  const oldStyle = path.join(dir, 'cp-old.json');
  const { approvalQueue: _drop, ...withoutQueue } = rawCp;
  void _drop;
  writeFileSync(oldStyle, JSON.stringify(withoutQueue));
  approvalQueue.adjudicate(undefined, false); // 现队列有 1 条（上一步恢复的）
  assert.equal(approvalQueue.queueStats().entries, 1);
  resetApproval();
  armChannel();
  armAll();
  const e0 = await stageOne({ description: 'post-restore op' });
  assert.equal(approvalQueue.queueStats().entries, 1);
  const ro = loadCheckpoint(oldStyle);
  assert.equal(ro.restored, true);
  assert.ok(!ro.report.some(l => l.startsWith('approvalQueue: SKIPPED') || l.includes('DROPPED')), ro.report.join('; '));
  assert.equal(approvalQueue.queueStats().entries, 1, '缺段不触队列（进程内现役队列原地保留）');
  assert.equal(approvalQueue.pendingSummary().items[0].description, 'post-restore op');
  void e0;
});

// ─── H4-8：工具面透明化 ───

test('H4-8: request_approval 的 staging 锚点 + adjudicate_approval_queue 批量裁决工具面', async () => {
  const cfg = { enableApprovalGate: true, enableDemonstrations: false } as unknown as Config;
  const reqTool = createRequestApprovalTool(cfg);
  const adjTool = createAdjudicateApprovalQueueTool(cfg);

  // 通道缺席（默认面）：staging.available=false（诚实 —— 暂存资格未获）
  const out0 = JSON.parse(await exec(reqTool)({ description: 'send the parcel' }));
  assert.equal(out0.state_anchor.staging.available, false);
  assert.equal(out0.state_anchor.staging.persistence, 'memory');

  // 通道 + 存储武装：available=true、超时/持久化透明
  armChannel();
  const qfile = path.join(dir, 'q.json');
  armAll({ queueFile: qfile });
  const out1 = JSON.parse(await exec(reqTool)({ description: 'send the parcel' }));
  assert.equal(out1.state_anchor.staging.available, true);
  assert.equal(out1.state_anchor.staging.stage_after_seconds, 300);
  assert.equal(out1.state_anchor.staging.persistence, 'file');

  // 批量裁决工具：两条入队 → 一次批注裁决 → 输出透明
  const pa1 = approval.request('mail the letter');
  advance(301_000);
  assert.equal(approvalQueue.stageAction({ token: pa1.token, description: 'mail the letter' }).ok, true);
  const pa2 = approval.request('ship the crate');
  advance(1);
  assert.equal(approvalQueue.stageAction({ token: pa2.token, description: 'ship the crate' }).ok, true);
  const items = approvalQueue.pendingSummary().items;

  const adjOut = JSON.parse(await exec(adjTool)({
    ids: items.map(i => i.id), grant: true, note: '都发，用加急渠道',
  }));
  assert.equal(adjOut.status, 'ADJUDICATED');
  assert.equal(adjOut.state_anchor.adjudicated, 2);
  assert.equal(adjOut.state_anchor.granted, 2);
  assert.equal(adjOut.state_anchor.persisted, true);
  assert.equal(adjOut.state_anchor.queue_after.granted_awaiting_resume, 2);
  assert.equal(adjOut.per_item.length, 2);
  assert.ok(existsSync(qfile), '工具路径落盘');

  // 续跑语义透明化：next_step 指向 takeGranted 消费（不再打扰用户）
  assert.match(adjOut.next_step, /RESUME/);

  // ids 缺省 ⇒ 全部待批（新入队一条再测）
  const pa3 = approval.request('fax the form');
  advance(1);
  approvalQueue.stageAction({ token: pa3.token, description: 'fax the form' });
  const adjAll = JSON.parse(await exec(adjTool)({ grant: false, note: '传真算了' }));
  assert.equal(adjAll.state_anchor.adjudicated, 1);
  assert.equal(adjAll.state_anchor.denied, 1);

  // 空队列再裁 ⇒ NOTHING_TO_ADJUDICATE
  const adjEmpty = JSON.parse(await exec(adjTool)({ grant: true }));
  assert.equal(adjEmpty.status, 'NOTHING_TO_ADJUDICATE');

  // 闸门关闭 ⇒ 工具诚实拒绝（队列不活跃）
  const cfgOff = { enableApprovalGate: false } as unknown as Config;
  const adjOff = await exec(createAdjudicateApprovalQueueTool(cfgOff))({ grant: true });
  assert.match(adjOff, /Approval gate disabled/);
});
