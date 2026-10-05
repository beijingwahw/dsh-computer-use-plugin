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
//   ΠΑΝ-1 裁决人证补全 —— grant 臂必须携带外确认码（入队锚定的哈希在裁决时
//      消费）：无码 / 错码 / 封顶焚毁 / 降级无锚 / 恢复无锚全部 fail-closed；
//      人证先于 Y-10（错码不烧预算 —— 与 grantDetailed 同序）；
//   ΠΑΝ-2 takeGranted 复查 TTL —— 陈年 granted 以当前时钟重验，过期即拒绝
//      并清理，新鲜条目照常可取；
//   ΠΑΝ-3 持久化完整性 —— HMAC-SHA256 信封：可信往返 granted 照常恢复；篡改
//      档整档归零；无密钥/旧明文降级恢复拒绝 granted 条目（不丢队列本体）；
//   ΠΑΝ-4 双通道双花封堵 —— 交互式 grant 兑现 ⇒ 条目 absorbed 终态不可再
//      take（一次同意恰一次物理兑付；执行载体 = 交互令牌本尊）。
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
  // ΠΑΝ-3：队列档为 HMAC-SHA256 完整性信封（内层 payload 仍是队列 JSON 原文）
  const envelope = JSON.parse(readFileSync(qfile, 'utf8'));
  assert.equal(envelope.v, 2, '信封版本 v2');
  assert.equal(envelope.alg, 'hmac-sha256');
  assert.match(envelope.mac, /^[0-9a-f]{64}$/, 'HMAC 随档（完整性证据面）');
  assert.ok(existsSync(qfile + '.key'), '密钥档与数据档同生（filePerms 加固面）');
  const raw = JSON.parse(envelope.payload);
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
  // ΠΑΝ-1：grant 臂携码（内存队列的人证锚照常执法 —— 与持久化成败正交）
  const adjc = approvalQueue.adjudicate([c.id], true, undefined, codeOf(c.token));
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
  approvalQueue.adjudicate([p4.id], true, undefined, codeOf(p4.token)); // ΠΑΝ-1：携码批准

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
  // ΠΑΝ-1：批量裁决逐条目各交各码（每条目锚定各自触发令牌的带外码）
  const budgetBefore = approvalBudget();
  const NOTE = '都同意，但改用正式抬头签名再发';
  const r = approvalQueue.adjudicate([e1.id, e2.id, e3.id, e4.id], true, NOTE, {
    [e1.id]: codeOf(e1.token), [e2.id]: codeOf(e2.token),
    [e3.id]: codeOf(e3.token), [e4.id]: codeOf(e4.token),
  });
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

  // 有效条目照常可批（ΠΑΝ-1：携码）
  assert.equal(approvalQueue.adjudicate([fresh.id], true, undefined, codeOf(fresh.token)).results[0].outcome, 'granted');

  // deny 过期条目恒可 —— 用户清场的出口
  const d = approvalQueue.adjudicate([stale.id], false, '这件事别做了');
  assert.equal(d.results[0].outcome, 'denied');
  assert.equal(approvalQueue.pendingSummary().expired, 0, '清场后过期清单归零');
});

// ─── H4-6（ΠΑΝ-4 重写）：grantDetailed 裁决传播 + 双通道双花封堵 ───

test('H4-6+ΠΑΝ-4: 交互式裁决传播进入 absorbed 终态 —— 双通道双花封堵；执行载体 = 交互令牌本尊', async () => {
  armChannel();
  armAll();
  const e1 = await stageOne({ description: 'send the contract' });
  const e2 = await stageOne({ description: 'delete the draft' });

  // 传播·授予：暂存令牌被交互式 grant（携码 + 批注）⇒ 条目同步进入 absorbed 终态
  // （ΠΑΝ-4：旧实现传播为 granted，同一份同意可经交互令牌 + takeGranted 续跑
  //  令牌两条通道各铸一枚执行令牌 = 一次 Y-10 兑付两次不可逆派发）
  const budgetBefore = approvalBudget();
  assert.deepEqual(
    approval.grantDetailed(e1.token, true, { confirmCode: codeOf(e1.token), note: '同意，但用附件形式发' }),
    { ok: true },
    '带外码经人手交回后授予',
  );
  assert.equal(approvalBudget(), budgetBefore - 1, 'Y-10 恰计一次（传播不双计）');
  const d1 = approvalQueue.dumpQueue().find(x => x.id === e1.id)!.decision!;
  assert.equal(d1.verdict, 'absorbed', 'ΠΑΝ-4：交互兑现 ⇒ absorbed 终态（不再冒充可续跑）');
  assert.equal(d1.amendment!.note, '同意，但用附件形式发');

  // 传播·否决：拒绝路径同样铸批注（否决理由随行）
  assert.deepEqual(approval.grantDetailed(e2.token, false, { note: '草稿留着还有用' }), { ok: true });
  const d2 = approvalQueue.dumpQueue().find(x => x.id === e2.id)!.decision!;
  assert.equal(d2.verdict, 'denied');
  assert.equal(d2.amendment!.note, '草稿留着还有用');

  // ΠΑΝ-4 执法：absorbed 条目不可再 take —— 一次同意只兑付一次物理执行
  const s = approvalQueue.pendingSummary();
  assert.equal(s.grantedAwaitingResume, 0, '无可续跑的已批条目（已被交互通道吸收）');
  assert.equal(s.absorbedByInteractive, 1, '终态分账透明化（晨报不误导）');
  assert.equal(approvalQueue.takeGranted(), null, '双通道双花封堵：队列侧不得再铸第二枚执行令牌');

  // 执行载体 = 交互令牌本尊（W1-2 批注消费 + V 纪元验收式消费照常）
  assert.equal(approval.amendmentOf(e1.token)!.targetDescriptionDelta.original, 'send the contract');
  const plan = approval.applyAmendment(e1.token, {
    tool: 'click_mouse', x: 0.5, y: 0.5, target_description: 'send the contract',
  });
  assert.equal(plan.target_description, '同意，但用附件形式发', '交互执行照修正后的计划');
  assert.equal(approval.beginAttempt(e1.token), true);
  assert.equal(approval.consume(e1.token), true);
  assert.equal(approvalQueue.takeGranted(), null, '消费后队列侧仍无兑付（终态不可翻案）');
  assert.equal(approvalQueue.pendingSummary().deniedAwaitingPrune, 1, '已拒条目留档待审计清理');
  assert.equal(approvalQueue.pendingSummary().absorbedByInteractive, 1);
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
  approvalQueue.adjudicate([staged.id], true, '同意发送', codeOf(staged.token)); // ΠΑΝ-1：携码批准

  // 保存 → 快照含队列段（ΠΑΝ-80：approvalQueue 段为 HMAC-SHA256 信封 ——
  // 盘面形状 {v:2, alg, mac, payload}，队列 JSON 原文在 payload 内）
  const saved = saveCheckpoint(cpFile);
  assert.equal(saved.ok, true, saved.error);
  const rawCp = JSON.parse(readFileSync(cpFile, 'utf8'));
  assert.equal(rawCp.approvalQueue?.v, 2, 'approval-queue 段为信封形态（ΠΑΝ-80）');
  assert.match(rawCp.approvalQueue?.mac ?? '', /^[0-9a-f]{64}$/, '信封携带 mac（密钥档同生）');
  const aqRaw = typeof rawCp.approvalQueue?.payload === 'string'
    ? JSON.parse(rawCp.approvalQueue.payload)
    : rawCp.approvalQueue; // 旧版明文段（ΠΑΝ-80 前）兼容消费
  assert.ok(Array.isArray(aqRaw?.entries), 'approval-queue 段随档（信封 payload 内）');
  assert.equal(aqRaw.entries.length, 1);

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

  // 条目级垃圾 ⇒ 弃置保好（dropped 注记进报告；ΠΑΝ-80：明文段 = 不可信 ⇒
  // granted 剥离同律执法，好条目本体照常恢复）
  const mixed = path.join(dir, 'cp-mixed.json');
  const entry = aqRaw.entries[0];
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
  // w2queue 修复（F3-6）：注入钟领先真实铸造点的余量须留足数量级（本册头注的
  // 纪律）。旧 advance(1) 只留 ~1s 余量 —— 满载并行跑时两次工具执行的墙钟耗时
  // 可超 1s（本册全量跑实测 1.9s），pa2/pa3 的 stageAction 悄悄落入
  // not-timed-out-yet ⇒ adjudicated=0 误报。步进改为 60s 级余量，且 stage 结果
  // 显式断言（拒绝静默失败 —— 失败时第一现场即入队面，不再是下游计数）。
  const pa1 = approval.request('mail the letter');
  advance(360_000);
  assert.equal(approvalQueue.stageAction({ token: pa1.token, description: 'mail the letter' }).ok, true);
  const pa2 = approval.request('ship the crate');
  advance(60_000);
  assert.equal(approvalQueue.stageAction({ token: pa2.token, description: 'ship the crate' }).ok, true);
  const items = approvalQueue.pendingSummary().items;

  // 批量裁决工具（当前工具面未携 confirm_code 参数 —— ΠΑΝ-1 队列侧执法）：
  // 无码 grant=true ⇒ 全项 confirm-code-required 结构化拒绝，零批准、零预算消耗
  const budgetBefore = approvalBudget();
  const adjOut = JSON.parse(await exec(adjTool)({
    ids: items.map(i => i.id), grant: true, note: '都发，用加急渠道',
  }));
  assert.equal(adjOut.status, 'ADJUDICATED');
  assert.equal(adjOut.state_anchor.adjudicated, 2);
  assert.equal(adjOut.state_anchor.granted, 0, 'ΠΑΝ-1：无码 grant 零批准（fail-closed —— 模型自批链封死）');
  assert.equal(adjOut.state_anchor.queue_after.granted_awaiting_resume, 0);
  assert.deepEqual(
    adjOut.per_item.map((x: { outcome: string }) => x.outcome),
    ['confirm-code-required', 'confirm-code-required'],
    '结构化拒绝（绝不抛）',
  );
  assert.equal(approvalBudget(), budgetBefore, '无码拒绝不烧 Y-10');
  assert.equal(approvalQueue.pendingSummary().pending, 2, '条目保持待批（等待带码裁决）');

  // ΠΑΝ-36a（F2 波接线）：工具面 confirm_code 参数已透传 —— 携 per-id 码经
  // 工具批量裁决 ⇒ 批准（队列侧契约就绪后的目标形态）；无码调用的 next_step
  // 给出人证出路（ΠΑΝ-1 的诚实指引面 —— 零批准时不误导「已等续跑」）
  const codes = Object.fromEntries(
    approvalQueue.dumpQueue().filter(e => e.decision === undefined).map(e => [e.id, codeOf(e.token)]),
  );
  const okAdjTool = JSON.parse(await exec(adjTool)({
    ids: items.map(i => i.id), grant: true, note: '都发，用加急渠道', confirm_code: codes,
  }));
  assert.deepEqual(
    okAdjTool.per_item.map((x: { outcome: string }) => x.outcome),
    ['granted', 'granted'],
    '工具携 per-id 码批量批准（ΠΑΝ-36 透传贯通）',
  );
  assert.equal(approvalBudget(), budgetBefore - 2, '通过人证后 Y-10 逐项计费');
  assert.ok(existsSync(qfile), '工具路径落盘');
  assert.match(adjOut.next_step, /OUT-OF-BAND confirm code/, '无码调用的指引 = 人证出路（ΠΑΝ-36）');
  assert.match(okAdjTool.next_step, /RESUME/, '批准后的续跑语义透明化：next_step 指向 takeGranted 消费（不再打扰用户）');

  // ids 缺省 ⇒ 全部待批（新入队一条再测）
  // w2queue 修复（F3-6）：同上 —— advance(1) 余量过薄（满载跑实测在此翻车），
  // 改 60s 余量 + stage 结果显式断言。
  const pa3 = approval.request('fax the form');
  advance(60_000);
  assert.equal(approvalQueue.stageAction({ token: pa3.token, description: 'fax the form' }).ok, true);
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

// ─── ΠΑΝ-1：裁决人证补全（模型自批链封堵） ───

test('ΠΑΝ-1: 裁决人证 —— 无码/错码/封顶焚毁/降级无锚/恢复无锚全部 fail-closed；人证先于 Y-10', async () => {
  armChannel();
  armAll();
  const e = await stageOne({ description: 'wire the funds' });
  const budget0 = approvalBudget();

  // ① 无码 ⇒ confirm-code-required（结构化拒绝；条目保持待批；不烧 Y-10）
  const noCode = approvalQueue.adjudicate([e.id], true);
  assert.equal(noCode.results[0].outcome, 'confirm-code-required', '无码 grant 一律拒绝');
  assert.equal(approvalBudget(), budget0, '无码拒绝不烧同意预算（限速 ≠ 人证）');
  assert.equal(approvalQueue.queueStats().pending, 1, '条目保持待批');

  // ② 错码 ⇒ confirm-code-mismatch 逐次计数；封顶第 5 次 ⇒ 条目焚毁
  for (let i = 1; i <= 4; i++) {
    const wrong = approvalQueue.adjudicate([e.id], true, undefined, '000000');
    assert.equal(wrong.results[0].outcome, 'confirm-code-mismatch', `第 ${i} 次错码计数在案`);
  }
  assert.equal(approvalBudget(), budget0, '错码不烧 Y-10（码校验先于令牌桶 —— grantDetailed 同序）');
  const burned = approvalQueue.adjudicate([e.id], true, undefined, '000000');
  assert.equal(burned.results[0].outcome, 'code-attempts-exhausted', '枚举封顶 ⇒ 条目焚毁');
  assert.equal(approvalQueue.queueStats().entries, 0, '焚毁条目出队（重新走 request_approval 带外铸造）');
  assert.equal(approvalQueue.adjudicate([e.id], true, undefined, '000000').results[0].outcome, 'unknown-id');

  // ③ 正码 ⇒ granted + Y-10 计费（人证通过后限速照常是第二道闸）
  const g = await stageOne({ description: 'renew the certificate' });
  const right = approvalQueue.adjudicate([g.id], true, undefined, codeOf(g.token));
  assert.equal(right.results[0].outcome, 'granted', '用户读码交回 ⇒ 批准（模型只是邮差）');
  assert.equal(approvalBudget(), budget0 - 1, '通过人证后逐项计费');
  // 错码不焚毁无辜批注：deny 恒可（不需要人证）
  assert.equal(approvalQueue.adjudicate([g.id], false).results[0].outcome, 'already-decided');

  // ④ 降级令牌（通道在场但投递失败 ⇒ 无 confirmCodeHash）⇒ 入队成功但永不可批量批准
  setConfirmCodeChannel(() => false);
  const pa = approval.request('degraded mint');
  advance(301_000);
  assert.equal(approvalQueue.stageAction({ token: pa.token, description: 'degraded mint' }).ok, true,
    '通道在场 ⇒ 暂存资格成立（降级的是码，不是暂存）');
  const degradedId = approvalQueue.pendingSummary().items.find(i => i.description === 'degraded mint')!.id;
  assert.equal(
    approvalQueue.adjudicate([degradedId], true, undefined, '123456').results[0].outcome,
    'confirm-channel-absent',
    '无哈希锚 ⇒ fail-closed（与 grantDetailed 的 degraded 令牌同律）',
  );

  // ⑤ 跨进程恢复的条目无证据锚（哈希仅内存驻留 —— ΠΑΝ-1 设计取舍）⇒ 同律拒绝
  const qfile = path.join(dir, 'pan1-queue.json');
  resetApproval();
  resetClock();
  armChannel();
  armAll({ queueFile: qfile });
  const rr = await stageOne({ description: 'overnight op' });
  const savedCode = codeOf(rr.token); // 模拟用户仍持有当班投递的原码
  resetApproval();
  resetClock();
  armChannel();
  armAll({ queueFile: qfile });
  assert.equal(approvalQueue.pendingSummary().items[0]?.id, rr.id, '条目跨进程恢复（ΠΑΝ-3 可信档）');
  assert.equal(
    approvalQueue.adjudicate([rr.id], true, undefined, savedCode).results[0].outcome,
    'confirm-channel-absent',
    '恢复面无码锚 ⇒ 即使持有原码也拒绝（须 deny 后重新 request 走带外铸造）',
  );
});

// ─── ΠΑΝ-2：takeGranted 复查 TTL（陈年同意不可兑换） ───

test('ΠΑΝ-2: takeGranted 以当前时钟重验 TTL —— 过期 granted 拒绝并清理；新鲜条目照常可取', async () => {
  armChannel();
  armAll();
  const stale = await stageOne({ description: 'day-zero consent', ttlMs: 1_000 });
  // 裁决时刻 stale 仍有效（过期检查在裁决面先行通过；随后的 stageOne 推进 301s
  // 会使 stale 陈年化 —— 恰是本用例要制造的「裁决与消费之间的间隙」）
  assert.equal(approvalQueue.adjudicate([stale.id], true, undefined, codeOf(stale.token)).results[0].outcome, 'granted');
  const fresh = await stageOne({ description: 'fresh consent' }); // 推进 301s ⇒ stale 过期、fresh（24h）有效
  assert.equal(approvalQueue.adjudicate([fresh.id], true, undefined, codeOf(fresh.token)).results[0].outcome, 'granted');
  advance(2_000); // 再跨一段消费间隙

  // 陈年 granted 被清理，不越过新鲜条目被 take；新鲜条目照常可取
  const taken = approvalQueue.takeGranted();
  assert.ok(taken, '新鲜条目照常可取（清理不误伤）');
  assert.equal(taken!.entry.id, fresh.id, '取到的是未过期条目');
  assert.ok(!approvalQueue.dumpQueue().some(x => x.id === stale.id), '过期 granted 条目被清理出队');
  assert.equal(approvalQueue.pendingSummary().grantedAwaitingResume, 0, '无可续跑残留');

  // 纯陈年面：唯一的 granted 过期 ⇒ take 拒绝（null）且条目清理
  const stale2 = await stageOne({ description: 'another day-zero consent', ttlMs: 1_000 });
  assert.equal(approvalQueue.adjudicate([stale2.id], true, undefined, codeOf(stale2.token)).results[0].outcome, 'granted');
  advance(2_000);
  assert.equal(approvalQueue.takeGranted(), null, '陈年同意不得铸成执行令牌');
  assert.equal(approvalQueue.queueStats().entries, 0, '过期即清理（不冒充可续跑账面）');
});

// ─── ΠΑΝ-3：持久化完整性（HMAC-SHA256 信封三态） ───

test('ΠΑΝ-3: 可信往返 granted 照常恢复；篡改档整档归零；密钥缺席降级恢复拒绝 granted', async () => {
  const qfile = path.join(dir, 'pan3-queue.json');

  // 铸一条 granted（带码裁决）+ 一条 pending ⇒ 落盘为 HMAC 信封
  armChannel();
  armAll({ queueFile: qfile });
  const g = await stageOne({ description: 'trusted grant me' });
  const p = await stageOne({ description: 'still pending' });
  assert.equal(approvalQueue.adjudicate([g.id], true, undefined, codeOf(g.token)).results[0].outcome, 'granted');
  const envelope = JSON.parse(readFileSync(qfile, 'utf8'));
  assert.equal(envelope.v, 2, '信封版本 v2');
  assert.match(envelope.mac, /^[0-9a-f]{64}$/, 'HMAC 随档');
  assert.equal(JSON.parse(envelope.payload).version, 1, '内层载荷仍是队列 JSON 原文');

  // ① 可信往返：同密钥重载 ⇒ granted 照常恢复并可 take（完整性验证通过）
  resetApproval();
  resetClock();
  armChannel();
  armAll({ queueFile: qfile });
  const s1 = approvalQueue.pendingSummary();
  assert.equal(s1.grantedAwaitingResume, 1, '可信恢复：granted 裁决在案');
  assert.equal(s1.items.length, 1, 'pending 照常恢复');
  const taken = approvalQueue.takeGranted();
  assert.ok(taken && taken.entry.id === g.id, '可信恢复后可续跑消费');
  assert.equal(approval.validate(taken!.executionToken), true);

  // ② 篡改（改 payload 保 mac）⇒ 整档归零（绝不冒充恢复）
  const g2 = await stageOne({ description: 'forge me' });
  assert.equal(approvalQueue.adjudicate([g2.id], true, undefined, codeOf(g2.token)).results[0].outcome, 'granted');
  const env2 = JSON.parse(readFileSync(qfile, 'utf8'));
  const forgedPayload = JSON.stringify({
    version: 1, savedAt: 0, prunedDeniedTotal: 0,
    entries: [{
      id: 'QA-FORGED000000001', token: 'APR-FORGED', description: 'attacker entry',
      evidence: {}, enqueuedAt: 0, ttlMs: 86_400_000, expiresAt: now() + 86_400_000,
      decision: { verdict: 'granted', at: 0 },
    }],
  });
  writeFileSync(qfile, JSON.stringify({ ...env2, payload: forgedPayload }), 'utf8');
  resetApproval();
  resetClock();
  armChannel();
  armAll({ queueFile: qfile });
  assert.equal(approvalQueue.queueStats().entries, 0, 'HMAC 不匹配 ⇒ 篡改档归零（不冒充恢复）');
  assert.equal(approvalQueue.takeGranted(), null, '伪造 granted 无从兑换');

  // ③ 无密钥降级：密钥档被移除（只读环境/密钥损坏同律）⇒ 内容读回但 granted 剥离
  const qfile3 = path.join(dir, 'pan3-keyless.json');
  resetApproval();
  resetClock();
  armChannel();
  armAll({ queueFile: qfile3 });
  const g3 = await stageOne({ description: 'keyless grant' });
  assert.equal(approvalQueue.adjudicate([g3.id], true, undefined, codeOf(g3.token)).results[0].outcome, 'granted');
  rmSync(qfile3 + '.key');
  resetApproval();
  resetClock();
  armChannel();
  armAll({ queueFile: qfile3 });
  const s3 = approvalQueue.pendingSummary();
  assert.equal(s3.items.length, 1, '条目本体恢复（降级不丢队列 —— 晨报仍可唠叨）');
  assert.equal(s3.grantedAwaitingResume, 0, 'ΠΑΝ-3 fail-closed：不可信盘面的 granted 决不恢复');
  assert.equal(approvalQueue.takeGranted(), null, '不可信 granted 不可兑换执行令牌');
});

test('ΠΑΝ-3(续): 写侧无密钥 ⇒ 信封诚实省略 mac；旧版明文档 ⇒ 结构兼容但 granted 剥离', async () => {
  // ④ 写侧铸不出密钥（密钥路径被目录占位）⇒ 降级信封无 mac；读侧同律剥离 granted
  const qfile4 = path.join(dir, 'pan3-nowritekey.json');
  mkdirSync(qfile4 + '.key'); // 目录占位：loadOrCreateHmacKey 读档抛 EISDIR ⇒ null
  armChannel();
  approvalQueue.arm({ now, storage: createApprovalQueueFileStorage(qfile4) });
  const g4 = await stageOne({ description: 'no-key grant' });
  assert.equal(approvalQueue.adjudicate([g4.id], true, undefined, codeOf(g4.token)).results[0].outcome, 'granted');
  const env4 = JSON.parse(readFileSync(qfile4, 'utf8'));
  assert.equal(env4.mac, undefined, '无密钥 ⇒ 信封省略 mac（诚实降级，不伪装受保护）');
  assert.equal(env4.v, 2);
  resetApproval();
  resetClock();
  armChannel();
  approvalQueue.arm({ now, storage: createApprovalQueueFileStorage(qfile4) });
  assert.equal(approvalQueue.pendingSummary().grantedAwaitingResume, 0, '降级档恢复：granted 剥离');
  assert.equal(approvalQueue.pendingSummary().items.length, 1, '条目本体照常恢复');

  // ⑤ 旧版明文档（W2-1 原格式，无信封）⇒ 结构兼容读回但不可信 ⇒ granted 剥离
  const qfile5 = path.join(dir, 'pan3-legacy.json');
  writeFileSync(qfile5, JSON.stringify({
    version: 1, savedAt: 0, prunedDeniedTotal: 0,
    entries: [{
      id: 'QA-LEGACY0000000001', token: 'APR-LEGACY', description: 'legacy granted',
      evidence: {}, enqueuedAt: 0, ttlMs: 86_400_000, expiresAt: now() + 86_400_000,
      decision: { verdict: 'granted', at: 0 },
    }],
  }), 'utf8');
  resetApproval();
  armChannel();
  approvalQueue.arm({ now, storage: createApprovalQueueFileStorage(qfile5) });
  assert.equal(approvalQueue.pendingSummary().grantedAwaitingResume, 0, '旧明文档不可信 ⇒ granted 剥离（升级部署的在途 granted 须重裁）');
  assert.equal(approvalQueue.pendingSummary().items.length, 1, '条目本体照常恢复（不丢队列）');
});
