// test/w3escrow.test.ts
// W3-1（旗舰 S1 逆转托管：动作级 WAL + 补偿预案）执法册：
//   S1-1 预案铸造字段 —— 策略命中 ⇒ 预案含焦点窗口/前态哈希/剪贴板句柄/
//      补偿路径快照（自包含）/TTL；WAL 先行落盘（铸造返回前文件已在场）；
//   S1-2 策略表命中与缺失 —— 内置命中；未知语义 ⇒ no-strategy；发送/支付类 ⇒
//      manual-only；注入扩展可增补并覆盖内置；
//   S1-3 缺失拒派（fail-closed）—— 无预案/预案无效/令牌错配/TTL 已过 ⇒
//      beginAttempt false + escrowBlockOf 透明化，且不烧尝试预算；消费点
//      （consume）不被托管改写；
//   S1-4 TTL 内验收失败触发补偿 —— attemptFailed 钩子 ⇒ 按预案逐步补偿、
//      执行序正确、账册 compensated-verified、WAL 同步改写；
//   S1-5 用户中断触发 —— 直接 interrupt 面 + 中断信号端口（sweep 轮询）；
//   S1-6 补偿成功验证 —— screen-hash 回预案态 / 扩展谓词确认；
//   S1-7 补偿失败升级人工 —— 执行失败/验证失败/补偿路径抛错 ⇒ 醒目升级报告
//      （pendingHumanAttention 持续可见，acknowledge 留痕）；
//   S1-8 预案先行落盘与崩溃回读 —— 落盘失败 ⇒ 拒绝铸造；重启回读在途预案 ⇒
//      recovered-human-attention（不自动补偿）+ 升级报告；垃圾档/垃圾条目防御；
//   S1-9 端口缺席降级 —— 全端口缺席 ⇒ 仅记账（degraded-record-only，不升级）；
//      验证通道缺席 ⇒ compensated-unverified；
//   S1-10 正交性 —— 钩子在装但派发不携带 escrow opts ⇒ 审批语义原样；
//      consume ⇒ 预案 verified 关闭（不补偿）；resetApproval 卸载钩子；
//   S1-11 TTL 巡检 —— 到期未结算 ⇒ saga in-doubt 补偿；同令牌重铸 ⇒ 旧预案
//      superseded 流产；双结算幂等；
//   S1-12 shaper 桥 —— shaper 撤销栈包装的补偿执行端口（restoreAll 落地、
//      路由错配醒目拒绝）。
// 全程离线确定性：注入时钟 / 注入端口（哈希剧本可控）/ tmp 目录存储；
// 不依赖 CSPRNG 具体取值（只断言格式与行为）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  approval, resetApproval, escrowBlockOf, setConfirmCodeChannel, type ConfirmCodeDelivery,
} from '../src/approval.ts';
import {
  reversalEscrow, createEscrowFileStorage, builtinCompensationSemantics,
  type EscrowStorage, type ReversalPlan, type CompensationStrategy,
} from '../src/reversalEscrow.ts';
import {
  shaper, createShaperCompensationExecutor, type SystemAdapter,
} from '../src/environmentShaper.ts';

// ─── ΝΩ-22：行式 WAL 解析助手（头行魔数 + 事件行；重放视图 = 等价内存态） ───

function readWalLines(wal: string): Array<Record<string, any>> {
  return readFileSync(wal, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l));
}

function walHeader(wal: string): Record<string, any> {
  return readWalLines(wal)[0];
}

function walEvents(wal: string): Array<Record<string, any>> {
  return readWalLines(wal).filter(l => l.wal === undefined);
}

/** 事件流重放出的等价内存态视图（在途 planId 清单 + 账册记录序） */
function walState(wal: string): { inFlight: string[]; ledger: Array<Record<string, any>> } {
  const inFlight: string[] = [];
  const ledger: Array<Record<string, any>> = [];
  for (const e of walEvents(wal)) {
    if (e.event === 'mint') {
      inFlight.push(e.payload.plan.planId);
      if (e.payload.superseded) ledger.push(e.payload.superseded);
    } else if (e.event === 'settle' || e.event === 'close' || e.event === 'compensate') {
      const i = inFlight.indexOf(e.payload.record.planId);
      if (i >= 0) inFlight.splice(i, 1);
      ledger.push(e.payload.record);
    }
  }
  return { inFlight, ledger };
}

// ─── 测试基建（离线确定性） ───

const dirs: string[] = [];
let dir: string;
function newDir(): string {
  dir = mkdtempSync(path.join(tmpdir(), 'w3e-'));
  dirs.push(dir);
  return dir;
}
process.on('exit', () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

/** 注入时钟（托管 TTL 判定的唯一时间源 —— 步进确定） */
let clockBase = 0;
let clockOffset = 0;
function now(): number { return clockBase + clockOffset; }
function advance(ms: number): void { clockOffset += ms; }

/** 64 位 dhash 域的可控「屏幕」：A = 全 0；B = 半数翻转（sim=0.5 < 0.9 阈值） */
const HASH_A = '0'.repeat(64);
const HASH_B = '0'.repeat(32) + '1'.repeat(32);

// ─── 可控端口（生产的截图/剪贴板/热键管线在此全部剧本化） ───

let focusNow: string | null = 'Window - Drafts';
const focusPort = { current: async () => focusNow };

let hashNow: string | null = HASH_A;
const hashPort = { capture: async () => hashNow };

let clipNow: string | null = 'clip-handle-1';
const clipRestored: string[] = [];
const clipboardPort = {
  backup: async () => clipNow,
  restore: async (h: string) => { clipRestored.push(h); return true; },
};

let interruptFlag = false;
const interruptPort = { pending: () => interruptFlag };

/** 补偿执行端口：记录执行序；可按标签注入失败/抛错 */
const execLog: Array<{ label: string; method: string }> = [];
let execFailOn: string | null = null;
let execThrowOn: string | null = null;
const executorPort = {
  execute: async (step: { method: string; label: string }, _plan: ReversalPlan): Promise<{ ok: boolean; detail?: string }> => {
    execLog.push({ label: step.label, method: step.method });
    if (execThrowOn === step.label) throw new Error('executor exploded');
    if (execFailOn === step.label) return { ok: false, detail: 'executor denied this step' };
    return { ok: true };
  },
};

/** 标准武装：全端口 + 可选 WAL 文件（缺省仅内存）+ 可选中断信号端口 */
function armStandard(o: { walFile?: string | null; withInterrupt?: boolean; strategies?: CompensationStrategy[] } = {}): void {
  reversalEscrow.arm({
    now,
    storage: o.walFile === undefined || o.walFile === null ? null : createEscrowFileStorage(o.walFile),
    hashPort, clipboardPort, focusPort,
    interruptPort: o.withInterrupt === true ? interruptPort : null,
    executorPort,
    ...(o.strategies !== undefined ? { strategies: o.strategies } : {}),
  });
}

/** 铸造一枚已授予令牌（Y-10 桶每用例复位 ⇒ 无需限流面）。
 *  W6R fail-closed：无码 grant 已废除 —— 授予须带外码；本助手内联武装
 *  采集 sink（生产中人类读码的视角）并携码授予。 */
function grantedToken(description = 'click 删除 to remove report.docx'): string {
  const sink: ConfirmCodeDelivery[] = [];
  setConfirmCodeChannel(d => { sink.push({ ...d }); });
  const pa = approval.request(description, { actionShape: { tool: 'click_mouse', x: 0.5, y: 0.5 } });
  const g = approval.grantDetailed(pa.token, true, { confirmCode: sink[0]?.confirmCode });
  assert.equal(g.ok, true, JSON.stringify(g));
  return pa.token;
}

/** 标准前置：铸造 + 派发预留（返回预案与令牌） */
async function mintAndReserve(semantics = 'file-delete', ttlMs?: number): Promise<{ token: string; plan: ReversalPlan }> {
  const token = grantedToken();
  const mint = await reversalEscrow.mintPlan({
    semantics, description: '删除 report.docx', approvalToken: token, tool: 'click_mouse',
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  });
  assert.equal(mint.ok, true, JSON.stringify(mint));
  if (!mint.ok) throw new Error('unreachable');
  const reserved = approval.beginAttempt(token, { escrow: { planId: mint.plan.planId, semantics } });
  assert.equal(reserved, true, 'escrow-gated beginAttempt should reserve');
  return { token, plan: mint.plan };
}

beforeEach(() => {
  resetApproval();          // 令牌/桶/观察者/带外通道/队列/托管钩子一并归零
  reversalEscrow.reset();   // 托管模块态归零（端口/存储/表/账册）
  clockBase = Date.now();
  clockOffset = 0;
  focusNow = 'Window - Drafts';
  hashNow = HASH_A;
  clipNow = 'clip-handle-1';
  clipRestored.length = 0;
  interruptFlag = false;
  execLog.length = 0;
  execFailOn = null;
  execThrowOn = null;
  dir = newDir();
});

// ─── S1-1 预案铸造字段 + WAL 先行落盘 ───

test('S1-1a 预案铸造字段齐全（焦点/哈希/剪贴板/补偿路径快照/TTL/降级缺席为空）', async () => {
  armStandard();
  const mint = await reversalEscrow.mintPlan({
    semantics: 'form-submit', description: '提交订单表单', approvalToken: 'APR-X', tool: 'click_mouse',
  });
  assert.equal(mint.ok, true);
  if (!mint.ok) return;
  const p = mint.plan;
  assert.match(p.planId, /^ESC-[0-9A-F]{16}$/);
  assert.equal(p.semantics, 'form-submit');
  assert.equal(p.focusWindow, 'Window - Drafts');
  assert.equal(p.preActionHash, HASH_A);
  assert.equal(p.clipboardBackupHandle, 'clip-handle-1');
  assert.equal(p.approvalToken, 'APR-X');
  assert.equal(p.mintedAt, now());
  assert.equal(p.expiresAt, now() + p.ttlMs);
  assert.equal(p.ttlMs, 30_000); // 缺省 TTL
  // 补偿路径快照自包含（与内置表一致：草稿箱回收 + Ctrl+Z）
  assert.deepEqual(p.compensation.map(s => s.label), ['Ctrl+Z undo the submission', 'recover from drafts folder']);
  assert.equal(p.verifyMode, 'screen-hash');
  assert.equal(p.verifyThreshold, 0.9);
  // 全感知/物理端口在场 ⇒ 无端口降级标记（storage 缺省缺席是跨进程降级的诚实标记）
  assert.deepEqual(p.degraded, ['no-storage']);
  // 在途注册
  assert.equal(reversalEscrow.dumpInFlight().length, 1);
});

test('S1-1b 预案先行落盘：铸造返回时 WAL 文件已在场且含预案（独立文件，不碰 journal）', async () => {
  const wal = path.join(dir, 'escrow-wal.json');
  armStandard({ walFile: wal });
  const mint = await reversalEscrow.mintPlan({ semantics: 'file-delete', description: '删除 report.docx' });
  assert.equal(mint.ok, true);
  if (!mint.ok) return;
  // ΝΩ-22 行式档：头行魔数 + 单 mint 事件行（预案自包含在 payload.plan）
  const header = walHeader(wal);
  assert.equal(header.wal, 'dsh-escrow-wal');
  assert.equal(header.version, 2);
  const mints = walEvents(wal).filter(e => e.event === 'mint');
  assert.equal(mints.length, 1);
  assert.equal(mints[0].planId, mint.plan.planId);
  assert.equal(mints[0].payload.plan.planId, mint.plan.planId);
  assert.equal(mints[0].payload.plan.compensation.length, 2);
});

// ─── S1-2 策略表命中与缺失 ───

test('S1-2a 策略表：内置命中 / 未知语义 no-strategy / 发送支付类 manual-only', async () => {
  armStandard();
  assert.ok(builtinCompensationSemantics().includes('form-submit'));
  assert.ok(builtinCompensationSemantics().includes('send-message'));
  // 命中
  const hit = await reversalEscrow.mintPlan({ semantics: 'file-write' });
  assert.equal(hit.ok, true);
  // 未知语义：fail-closed（须先分类 —— 人类亲办）
  const miss = await reversalEscrow.mintPlan({ semantics: 'launch-missiles' });
  assert.equal(miss.ok, false);
  if (miss.ok) return;
  assert.equal(miss.reason, 'no-strategy');
  assert.match(miss.detail ?? '', /HUMAN must perform it personally/);
  // 发送类：策略表明示不可补偿（已发出的消息收不回）
  const send = await reversalEscrow.mintPlan({ semantics: 'send-message' });
  assert.equal(send.ok, false);
  if (send.ok) return;
  assert.equal(send.reason, 'manual-only');
  assert.match(send.detail ?? '', /cannot be unsent/);
  // 支付类同律
  const pay = await reversalEscrow.mintPlan({ semantics: 'payment' });
  assert.equal(pay.ok, false);
  if (!pay.ok) assert.equal(pay.reason, 'manual-only');
  // 未知/不可补偿语义 ⇒ 不注册在途（只有此前的合法命中 file-write 在途）
  assert.equal(reversalEscrow.dumpInFlight().length, 1);
});

test('S1-2b 策略表可注入扩展：增补新语义 + 同键覆盖内置', async () => {
  armStandard({
    strategies: [
      {
        kind: 'compensate', semantics: 'deploy-push',
        steps: [{ method: 'custom', label: 'ci rollback the deployment', target: 'ci:rollback' }],
        verify: { mode: 'none' },
      },
      {
        kind: 'compensate', semantics: 'form-submit',
        steps: [{ method: 'menu', label: '扩展版：表单 > 撤销提交', target: 'Form>UndoSubmit' }],
        verify: { mode: 'screen-hash', threshold: 0.95 },
      },
    ],
  });
  const added = await reversalEscrow.mintPlan({ semantics: 'deploy-push' });
  assert.equal(added.ok, true);
  if (added.ok) {
    assert.deepEqual(added.plan.compensation.map(s => s.label), ['ci rollback the deployment']);
    assert.equal(added.plan.verifyMode, 'none');
  }
  const overridden = await reversalEscrow.mintPlan({ semantics: 'form-submit' });
  assert.equal(overridden.ok, true);
  if (overridden.ok) {
    assert.deepEqual(overridden.plan.compensation.map(s => s.label), ['扩展版：表单 > 撤销提交']);
    assert.equal(overridden.plan.verifyThreshold, 0.95); // 覆盖含阈值
  }
});

// ─── S1-3 缺失拒派（fail-closed） ───

test('S1-3a 无预案派发 ⇒ beginAttempt 拒绝（plan-required），不烧预算不毁令牌', async () => {
  armStandard();
  const token = grantedToken();
  // 派发层未铸造（或铸造被 manual-only 拒绝后仍试图派发）
  const r = approval.beginAttempt(token, { escrow: { semantics: 'send-message' } });
  assert.equal(r, false);
  const block = escrowBlockOf();
  assert.ok(block);
  assert.equal(block!.reason, 'plan-required');
  assert.equal(block!.token, token);
  assert.match(block!.detail ?? '', /mintPlan/);
  // fail-closed 且零簿记副作用：尝试预算未烧、令牌仍在场
  const st = approval.status(token);
  assert.equal(st.present, true);
  assert.equal(st.attempts, 0);
  // 补铸合规预案后同令牌可正常预留（拒绝不产生持续毒化）
  const mint = await reversalEscrow.mintPlan({ semantics: 'file-delete', approvalToken: token });
  assert.equal(mint.ok, true);
  if (!mint.ok) return;
  assert.equal(approval.beginAttempt(token, { escrow: { planId: mint.plan.planId } }), true);
  assert.equal(approval.status(token).attempts, 1);
});

test('S1-3b 预案无效/令牌错配/TTL 已过 ⇒ 各自拒绝并透明化', async () => {
  armStandard();
  const tokenA = grantedToken();
  const tokenB = grantedToken();
  // 无效 planId
  assert.equal(approval.beginAttempt(tokenA, { escrow: { planId: 'ESC-0000000000000000' } }), false);
  assert.equal(escrowBlockOf()!.reason, 'plan-invalid');
  // 令牌错配（预案为 A 铸造，B 携之派发）
  const mint = await reversalEscrow.mintPlan({ semantics: 'file-delete', approvalToken: tokenA });
  assert.equal(mint.ok, true);
  if (!mint.ok) return;
  assert.equal(approval.beginAttempt(tokenB, { escrow: { planId: mint.plan.planId } }), false);
  assert.equal(escrowBlockOf()!.reason, 'plan-token-mismatch');
  assert.equal(approval.status(tokenA).attempts, 0); // 仍未烧预算
  // TTL 已过
  advance(31_000);
  assert.equal(approval.beginAttempt(tokenA, { escrow: { planId: mint.plan.planId } }), false);
  assert.equal(escrowBlockOf()!.reason, 'plan-expired');
});

// ─── S1-4 TTL 内验收失败触发补偿（全链路） ───

test('S1-4a attemptFailed(no-effect) ⇒ 按预案补偿：执行序正确、验证通过、账册/WAL 同步', async () => {
  const wal = path.join(dir, 'escrow-wal.json');
  armStandard({ walFile: wal });
  const { token, plan } = await mintAndReserve('file-delete');
  // 验收失败：世界未出现预期变化（点空/落错窗口）⇒ 托管补偿触发
  approval.attemptFailed(token, 'no-effect');
  await reversalEscrow.idle();
  // 补偿按预案序执行（回收站还原 → Ctrl+Z）
  assert.deepEqual(execLog.map(e => e.label), ['restore from recycle bin', 'Ctrl+Z undo the delete']);
  // 屏幕哈希回预案态（HASH_A 未变）⇒ compensated-verified
  const ledger = reversalEscrow.dumpLedger();
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].planId, plan.planId);
  assert.equal(ledger[0].outcome, 'compensated-verified');
  assert.equal(ledger[0].trigger, 'no-effect');
  assert.deepEqual(ledger[0].executedSteps, ['restore from recycle bin', 'Ctrl+Z undo the delete']);
  assert.equal(ledger[0].approvalToken, token);
  assert.equal(reversalEscrow.dumpInFlight().length, 0);
  // WAL 同步：inFlight 清空、账册入档（ΝΩ-22 行式重放视图）
  const st = walState(wal);
  assert.deepEqual(st.inFlight, []);
  assert.equal(st.ledger.filter(r => r.outcome === 'compensated-verified').length, 1);
  // 令牌侧语义原样（V 纪元：验收失败保留令牌供重试）
  assert.equal(approval.status(token).present, true);
});

test('S1-4b 双结算幂等：重复 attemptFailed 只补偿一次', async () => {
  armStandard();
  const { token } = await mintAndReserve();
  approval.attemptFailed(token, 'no-effect');
  approval.attemptFailed(token, 'no-effect'); // 重复登记（防御面）
  await reversalEscrow.idle();
  assert.equal(execLog.length, 2); // 恰一轮补偿步骤
  assert.equal(reversalEscrow.dumpLedger().filter(r => r.outcome.startsWith('compensated')).length, 1);
});

// ─── S1-5 用户中断触发 ───

test('S1-5a 用户喊停（直接面）⇒ 全部在途预案补偿，trigger=interrupt', async () => {
  armStandard();
  const { plan } = await mintAndReserve();
  const n = await reversalEscrow.interrupt('user shouted stop');
  assert.equal(n, 1);
  const rec = reversalEscrow.dumpLedger()[0];
  assert.equal(rec.planId, plan.planId);
  assert.equal(rec.trigger, 'interrupt');
  assert.equal(rec.outcome, 'compensated-verified');
  assert.equal(reversalEscrow.dumpInFlight().length, 0);
});

test('S1-5b 中断信号端口（sweep 轮询 pending ⇒ 补偿）；无中断无到期 ⇒ sweep 空转', async () => {
  armStandard({ withInterrupt: true });
  const { plan } = await mintAndReserve();
  assert.equal(await reversalEscrow.sweep(), 0); // 无中断、未到期
  assert.equal(execLog.length, 0);
  interruptFlag = true;
  assert.equal(await reversalEscrow.sweep(), 1);
  const rec = reversalEscrow.dumpLedger()[0];
  assert.equal(rec.planId, plan.planId);
  assert.equal(rec.trigger, 'interrupt');
  assert.equal(rec.outcome, 'compensated-verified');
});

// ─── S1-6 补偿成功验证 ───

test('S1-6a screen-hash 验证：回预案态 ⇒ verified；未回 ⇒ 升级', async () => {
  armStandard();
  const { token } = await mintAndReserve('form-submit');
  hashNow = HASH_B; // 补偿后屏幕未回预案态（sim=0.5 < 0.9）
  approval.attemptFailed(token, 'no-effect');
  await reversalEscrow.idle();
  const rec = reversalEscrow.dumpLedger()[0];
  assert.equal(rec.outcome, 'compensation-failed'); // 验证失败也是补偿失败 ⇒ 升级
  assert.ok(rec.escalation);
  assert.match(rec.escalation!.headline, /HUMAN INTERVENTION REQUIRED/);
});

test('S1-6b 扩展谓词验证：谓词确认 ⇒ compensated-verified；谓词否定 ⇒ 升级', async () => {
  let predicateResult = true;
  const predicateCalls: string[] = [];
  armStandard({
    strategies: [{
      kind: 'compensate', semantics: 'ci-deploy',
      steps: [{ method: 'custom', label: 'ci rollback', target: 'ci:rollback' }],
      verify: { mode: 'predicate' },
      verifyPredicate: async (p: ReversalPlan) => { predicateCalls.push(p.semantics); return predicateResult; },
    }],
  });
  const { token } = await mintAndReserve('ci-deploy');
  approval.attemptFailed(token, 'no-effect');
  await reversalEscrow.idle();
  assert.deepEqual(predicateCalls, ['ci-deploy']);
  assert.equal(reversalEscrow.dumpLedger()[0].outcome, 'compensated-verified');
  // 谓词否定 ⇒ 补偿失败升级
  predicateResult = false;
  const second = await mintAndReserve('ci-deploy');
  approval.attemptFailed(second.token, 'no-effect');
  await reversalEscrow.idle();
  const recs = reversalEscrow.dumpLedger();
  assert.equal(recs[recs.length - 1].outcome, 'compensation-failed');
  assert.ok(recs[recs.length - 1].escalation);
});

// ─── S1-7 补偿失败升级人工 ───

test('S1-7a 执行失败 ⇒ compensation-failed + 醒目升级报告；acknowledge 后消隐', async () => {
  armStandard();
  const { token, plan } = await mintAndReserve('file-delete');
  execFailOn = 'restore from recycle bin'; // 第一步就被执行端口拒绝
  approval.attemptFailed(token, 'no-effect');
  await reversalEscrow.idle();
  assert.deepEqual(execLog.map(e => e.label), ['restore from recycle bin']); // 一步失败即止
  const rec = reversalEscrow.dumpLedger()[0];
  assert.equal(rec.outcome, 'compensation-failed');
  const esc = rec.escalation!;
  assert.equal(esc.severity, 'critical');
  assert.equal(esc.planId, plan.planId);
  assert.match(esc.headline, /compensation FAILED/);
  assert.equal(esc.failureDetail, 'executor denied this step');
  assert.match(esc.suggestedHumanAction, /Ctrl\+Z undo the delete/); // 剩余补偿路径随行
  assert.deepEqual(esc.compensationAttempted, ['restore from recycle bin']);
  // 升级绝不静默：pendingHumanAttention 持续可见
  const pending = reversalEscrow.pendingHumanAttention();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].planId, plan.planId);
  // 人工处置确认后消隐（留痕不删史）
  assert.equal(reversalEscrow.acknowledge(plan.planId), true);
  assert.equal(reversalEscrow.pendingHumanAttention().length, 0);
  assert.notEqual(reversalEscrow.dumpLedger()[0].escalation!.acknowledgedAt, undefined);
  assert.equal(reversalEscrow.acknowledge('ESC-NOPE'), false); // 未知 id 防御
});

test('S1-7b 补偿路径抛错 ⇒ 防御式收敛为升级（绝不抛出、绝不静默）', async () => {
  armStandard();
  const { token } = await mintAndReserve('file-write');
  execThrowOn = 'Ctrl+Z undo the write';
  await assert.doesNotReject(async () => {
    approval.attemptFailed(token, 'no-effect');
    await reversalEscrow.idle();
  });
  const rec = reversalEscrow.dumpLedger()[0];
  assert.equal(rec.outcome, 'compensation-failed');
  assert.equal(rec.escalation!.failureDetail, 'executor exploded');
});

// ─── S1-8 预案先行落盘与崩溃回读 ───

test('S1-8a WAL 落盘失败 ⇒ 拒绝铸造（预案不入托管即不派发 —— fail-closed）', async () => {
  const failingStorage: EscrowStorage = {
    load: () => null,
    save: () => ({ ok: false, error: 'disk full' }),
  };
  reversalEscrow.arm({ now, storage: failingStorage, executorPort, hashPort, focusPort, clipboardPort });
  const mint = await reversalEscrow.mintPlan({ semantics: 'file-delete', approvalToken: 'APR-Y' });
  assert.equal(mint.ok, false);
  if (mint.ok) return;
  assert.equal(mint.reason, 'persist-failed');
  assert.match(mint.detail ?? '', /disk full/);
  assert.equal(reversalEscrow.dumpInFlight().length, 0); // 回滚：未注册
  assert.ok((reversalEscrow.stats().persistError ?? '').includes('disk full'));
});

test('S1-8b 崩溃回读：重启后在途预案 ⇒ recovered-human-attention（不自动补偿）+ 升级报告', async () => {
  const wal = path.join(dir, 'escrow-wal.json');
  armStandard({ walFile: wal });
  const mint = await reversalEscrow.mintPlan({
    semantics: 'form-submit', description: '提交订单表单', approvalToken: 'APR-Z',
  });
  assert.equal(mint.ok, true);
  if (!mint.ok) return;
  // 模拟崩溃重启：同一 WAL 文件重新武装（进程内存态清零）
  armStandard({ walFile: wal });
  const r = reversalEscrow.recover();
  assert.equal(r.recovered, 1);
  assert.equal(r.pendingHumanAttention, 1);
  // 在途清空（不自动补偿 —— 崩溃后世界状态未知，按陈旧预案动热键是新一轮破坏）
  assert.equal(reversalEscrow.dumpInFlight().length, 0);
  assert.equal(execLog.length, 0);
  const rec = reversalEscrow.dumpLedger()[0];
  assert.equal(rec.outcome, 'recovered-human-attention');
  assert.equal(rec.trigger, 'crash-recovery');
  assert.match(rec.escalation!.headline, /HUMAN ATTENTION REQUIRED/);
  assert.match(rec.escalation!.suggestedHumanAction, /提交订单表单/); // 描述与手工补偿路径随行
  assert.match(rec.escalation!.suggestedHumanAction, /drafts folder/);
  // WAL 已改写：恢复结算落盘（inFlight 空、账册含恢复记录 —— ΝΩ-22 行式重放视图）
  const st = walState(wal);
  assert.deepEqual(st.inFlight, []);
  assert.equal(st.ledger.filter(x => x.outcome === 'recovered-human-attention').length, 1);
  // acknowledge 后消隐
  reversalEscrow.acknowledge(mint.plan.planId);
  assert.equal(reversalEscrow.pendingHumanAttention().length, 0);
});

test('S1-8c 垃圾档/垃圾条目防御：坏档归零不抛，好预案不连坐', async () => {
  const wal = path.join(dir, 'escrow-wal.json');
  writeFileSync(wal, 'not-json{{{', 'utf8');
  armStandard({ walFile: wal });
  const r = reversalEscrow.recover(); // 整档垃圾 ⇒ 归零
  assert.equal(r.recovered, 0);
  assert.equal(reversalEscrow.dumpInFlight().length, 0);
  // 条目级垃圾：一条好预案 + 一条垃圾
  writeFileSync(wal, JSON.stringify({
    version: 1,
    inFlight: [
      { planId: 'ESC-GOOD', semantics: 'file-delete', mintedAt: 1, ttlMs: 30_000, expiresAt: 31_000, compensation: [{ method: 'hotkey', label: 'Ctrl+Z' }] },
      { garbage: true },
    ],
    ledger: [],
  }), 'utf8');
  reversalEscrow.arm({
    now, storage: createEscrowFileStorage(wal), executorPort, hashPort, focusPort, clipboardPort,
  });
  const r2 = reversalEscrow.recover();
  assert.equal(r2.recovered, 1); // 好预案回读，垃圾弃置
  assert.equal(execLog.length, 0); // 恢复不自动补偿
  // ΝΩ-22：旧整档只读迁移 —— 重建后档已原子改写为行式（头行魔数 + 恢复账）
  const header = walHeader(wal);
  assert.equal(header.wal, 'dsh-escrow-wal');
  const st = walState(wal);
  assert.deepEqual(st.inFlight, []);
  assert.equal(st.ledger.filter(x => x.outcome === 'recovered-human-attention').length, 1);
  assert.equal(reversalEscrow.stats().walSkippedLines, 0, '旧档垃圾条目在净化面弃置（非行级跳过）');
});

// ─── S1-9 端口缺席降级 ───

test('S1-9a 全端口缺席 ⇒ 铸造成功记 degraded；补偿触发 ⇒ 仅记账不自动补偿', async () => {
  reversalEscrow.arm({ now }); // 无任何端口、无存储（可用性优先的降级起点）
  const mint = await reversalEscrow.mintPlan({ semantics: 'file-write', approvalToken: 'APR-D' });
  assert.equal(mint.ok, true);
  if (!mint.ok) return;
  assert.deepEqual(new Set(mint.plan.degraded), new Set(['no-focus-port', 'no-hash-port', 'no-clipboard-port', 'no-executor-port', 'no-storage']));
  assert.equal(mint.plan.preActionHash, undefined); // 诚实缺席，不伪造
  assert.equal(mint.plan.focusWindow, undefined);
  await reversalEscrow.settleFailed('APR-D', 'no-effect');
  const rec = reversalEscrow.dumpLedger()[0];
  assert.equal(rec.outcome, 'degraded-record-only'); // 仅记账
  assert.equal(execLog.length, 0);                   // 无自动补偿
  assert.equal(reversalEscrow.pendingHumanAttention().length, 0); // 已知缺席 ≠ 失败 ⇒ 不升级（论证见模块头）
  assert.equal(reversalEscrow.stats().degraded, true);
});

test('S1-9b 执行端口在场但验证通道缺席 ⇒ 补偿执行 + compensated-unverified 诚实降级', async () => {
  reversalEscrow.arm({ now, executorPort }); // 有执行端口，无哈希/焦点/剪贴板端口
  const token = grantedToken();
  const mint = await reversalEscrow.mintPlan({ semantics: 'file-delete', approvalToken: token });
  assert.equal(mint.ok, true);
  if (!mint.ok) return;
  assert.equal(approval.beginAttempt(token, { escrow: { planId: mint.plan.planId } }), true);
  approval.attemptFailed(token, 'no-effect');
  await reversalEscrow.idle();
  assert.deepEqual(execLog.map(e => e.label), ['restore from recycle bin', 'Ctrl+Z undo the delete']); // 补偿照常执行
  const rec = reversalEscrow.dumpLedger()[0];
  assert.equal(rec.outcome, 'compensated-unverified');
  assert.ok(rec.degraded!.includes('no-verify-channel')); // 区别于验证失败：诚实降级，不升级
  assert.equal(reversalEscrow.pendingHumanAttention().length, 0);
});

// ─── S1-10 正交性 ───

test('S1-10a 钩子在装但派发不携 escrow opts ⇒ 审批语义原样（attempts/inFlight/consume）', async () => {
  armStandard();
  const token = grantedToken();
  assert.equal(approval.beginAttempt(token), true); // 旧调用面（无 opts）零行为
  assert.equal(approval.status(token).attempts, 1);
  approval.attemptFailed(token, 'no-effect'); // 无在途预案 ⇒ 托管 no-op
  await reversalEscrow.idle();
  assert.equal(reversalEscrow.dumpLedger().length, 0);
  assert.equal(execLog.length, 0);
  assert.equal(approval.status(token).present, true); // V 纪元：令牌保留续期
  // 消费点不被托管改写：验收通过 ⇒ consume 原样焚毁
  assert.equal(approval.beginAttempt(token), true);
  assert.equal(approval.consume(token), true);
  assert.equal(approval.status(token).present, false);
});

test('S1-10b consume（验收通过）⇒ 在途预案关闭为 verified，不触发补偿', async () => {
  armStandard();
  const { token } = await mintAndReserve();
  approval.consume(token);
  await reversalEscrow.idle();
  const rec = reversalEscrow.dumpLedger()[0];
  assert.equal(rec.outcome, 'verified');
  assert.equal(rec.trigger, 'acceptance-verified');
  assert.equal(execLog.length, 0); // 世界出现预期变化 —— 无补偿义务
});

test('S1-10c resetApproval 卸载托管钩子（隔离缝跨界自治）；escrow.arm 重接', async () => {
  armStandard();
  resetApproval(); // 隔离缝：钩子/拦截簿记归零（令牌簿记随之清空 —— 重新铸造）
  const token = grantedToken();
  const mint = await reversalEscrow.mintPlan({ semantics: 'file-delete', approvalToken: token });
  assert.equal(mint.ok, true);
  if (!mint.ok) return;
  // 钩子已卸：beginAttempt 的 escrow opts 被忽略（零行为 —— 隔离缝不越界）
  assert.equal(approval.beginAttempt(token, { escrow: { planId: mint.plan.planId } }), true);
  assert.equal(escrowBlockOf(), null); // 拦截簿记随审批隔离缝归零
  // 隔离缝分治：approval 侧清钩子不触碰 escrow 模块态（托管自记账原样，
  // 两侧各自 arm/reset —— stats().armed 只反映 escrow 自身的武装事实）
  assert.equal(reversalEscrow.dumpInFlight().length, 1);
});

// ─── S1-11 TTL 巡检 / superseded / 内部面 ───

test('S1-11a TTL 到期未结算 ⇒ saga in-doubt 补偿（settlement 永不到达的世界）', async () => {
  armStandard();
  const { plan } = await mintAndReserve('file-delete', 5_000);
  advance(6_000);
  assert.equal(await reversalEscrow.sweep(), 1);
  const rec = reversalEscrow.dumpLedger()[0];
  assert.equal(rec.planId, plan.planId);
  assert.equal(rec.trigger, 'ttl-expired');
  assert.equal(rec.outcome, 'compensated-verified');
});

test('S1-11b 同令牌重铸 ⇒ 旧在途预案 superseded 流产（无补偿义务）', async () => {
  armStandard();
  const token = grantedToken();
  const first = await reversalEscrow.mintPlan({ semantics: 'file-delete', approvalToken: token });
  assert.equal(first.ok, true);
  const second = await reversalEscrow.mintPlan({ semantics: 'file-delete', approvalToken: token });
  assert.equal(second.ok, true);
  assert.equal(reversalEscrow.dumpInFlight().length, 1); // 仅新预案在途
  const recs = reversalEscrow.dumpLedger();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].outcome, 'aborted-pre-dispatch');
  assert.equal(recs[0].trigger, 'superseded');
  assert.equal(execLog.length, 0);
});

// ─── ΝΩ-22（热路径 IO 放大②）：行式 append-only WAL 执法册 ───
//
//   a 行重放等价：事件流重放的内存态与旧整档路径等价（已结算账逐字段保留、
//     在途转 recovered-human-attention 与旧整档同律）；
//   b 旧档迁移：旧整档只读迁移为行式（原子改写），账册与在途全保留，幂等；
//   c 坏行/崩溃半行防御：跳过计数在册，好行照常重放；
//   d mint 顶替单事件行：同令牌重铸 ⇒ 一次追加携带 superseded（双写合并），
//     重放后顶替账与新预案在途等价；
//   e append 面故障 ⇒ persist-failed 回滚（与旧存储面同律）。

test('ΝΩ-22-a 行重放等价：事件流重放的内存态与旧整档路径等价', async () => {
  const wal = path.join(dir, 'escrow-wal.json');
  armStandard({ walFile: wal });
  const t1 = grantedToken();
  await reversalEscrow.mintPlan({ semantics: 'file-delete', approvalToken: t1, description: '删除 a.docx' });
  await reversalEscrow.settleVerified(t1);
  await reversalEscrow.idle();
  const m2 = await reversalEscrow.mintPlan({ semantics: 'file-write', approvalToken: 'APR-NW2A', description: '写入 b.txt' });
  assert.equal(m2.ok, true, JSON.stringify(m2));
  const preLedger = JSON.parse(JSON.stringify(reversalEscrow.dumpLedger())) as Array<Record<string, any>>;
  const preVerified = preLedger.find(x => x.outcome === 'verified');
  assert.ok(preVerified, '崩溃前已有一笔 verified 结算');
  assert.equal(reversalEscrow.dumpInFlight().length, 1, '崩溃前一枚在途预案');

  // 崩溃重启：同一行式档重放
  armStandard({ walFile: wal });
  const r = reversalEscrow.recover();
  assert.equal(r.recovered, 1);
  assert.equal(execLog.length, 0, '恢复不自动补偿');
  const post = reversalEscrow.dumpLedger();
  assert.deepEqual(post.find(x => x.outcome === 'verified'), preVerified,
    '等价①：事件流重放后已结算账逐字段等价');
  const rec = post.find(x => x.outcome === 'recovered-human-attention')!;
  assert.equal(rec.planId, m2.plan.planId, '等价②：在途预案转 recovered（planId 对得上）');
  assert.equal(rec.trigger, 'crash-recovery');

  // 等价③：同一预案走旧整档格式（手写 legacy 档）⇒ 恢复记录核心字段等价
  const legacy = path.join(dir, 'escrow-wal-legacy.json');
  writeFileSync(legacy, JSON.stringify({
    version: 1, savedAt: 1,
    inFlight: [m2.plan],
    ledger: [preVerified],
  }), 'utf8');
  armStandard({ walFile: legacy });
  const r2 = reversalEscrow.recover();
  assert.equal(r2.recovered, 1);
  const post2 = reversalEscrow.dumpLedger();
  const rec2 = post2.find(x => x.outcome === 'recovered-human-attention')!;
  assert.equal(rec2.planId, rec.planId, '两代格式 ⇒ 同一预案恢复等价');
  assert.equal(rec2.semantics, rec.semantics);
  assert.equal(rec2.outcome, rec.outcome);
  assert.equal(rec2.escalation!.suggestedHumanAction, rec.escalation!.suggestedHumanAction);
  assert.deepEqual(post2.find(x => x.outcome === 'verified'), preVerified,
    '旧档路径的已结算账同样逐字段保留');
});

test('ΝΩ-22-b 旧档迁移：旧整档只读迁移为行式，账册与在途全保留，幂等', async () => {
  const wal = path.join(dir, 'legacy-wal.json');
  const plan = {
    planId: 'ESC-OLDPLAN01', semantics: 'file-write', description: '写入配置', approvalToken: 'APR-OLD',
    mintedAt: 1000, ttlMs: 30_000, expiresAt: 31_000,
    compensation: [{ method: 'hotkey', label: 'Ctrl+Z undo the write', keys: ['ctrl', 'z'] }],
    verifyMode: 'screen-hash' as const,
  };
  const ledgerRec = {
    planId: 'ESC-OLDLEDGER', semantics: 'file-delete', mintedAt: 100, settledAt: 200,
    outcome: 'compensated-verified', trigger: 'no-effect', executedSteps: ['restore from recycle bin'],
  };
  writeFileSync(wal, JSON.stringify({ version: 1, savedAt: 300, inFlight: [plan], ledger: [ledgerRec] }), 'utf8');
  armStandard({ walFile: wal });
  const r = reversalEscrow.recover();
  assert.equal(r.recovered, 1, '在途预案恢复');
  const ledger = reversalEscrow.dumpLedger();
  assert.equal(ledger.length, 2);
  assert.deepEqual(ledger.find(x => x.planId === 'ESC-OLDLEDGER')?.executedSteps,
    ['restore from recycle bin'], '旧账册内容迁移保全');
  // 迁移后档 = 行式：头行魔数 + 旧账(compensate) + 恢复账(close)
  assert.equal(walHeader(wal).wal, 'dsh-escrow-wal');
  assert.equal(walHeader(wal).version, 2);
  const evs = walEvents(wal);
  assert.deepEqual(evs.map(e => e.event).sort(), ['close', 'compensate'], '迁移 = 在途/账册各成一行');
  const st = walState(wal);
  assert.deepEqual(st.inFlight, []);
  assert.equal(st.ledger.filter(x => x.outcome === 'compensated-verified').length, 1);
  assert.equal(st.ledger.filter(x => x.outcome === 'recovered-human-attention').length, 1);
  // 迁移档再次重启：幂等（不重复恢复 —— recovered 计数含历史恢复账，账册不膨胀）
  armStandard({ walFile: wal });
  assert.equal(reversalEscrow.recover().recovered, 1, 'recover 面计数为累计语义（历史恢复账仍在册）');
  assert.equal(reversalEscrow.dumpLedger().length, 2, '无新增账（幂等 —— 在途已清不重复唠叨）');
  assert.equal(reversalEscrow.dumpLedger().filter(x => x.outcome === 'recovered-human-attention').length, 1);
  // 迁移后的档走增量追加（不再是全量重写形状）
  const t = grantedToken();
  const m = await reversalEscrow.mintPlan({ semantics: 'file-delete', approvalToken: t });
  assert.equal(m.ok, true, JSON.stringify(m));
  const linesAfter = readWalLines(wal).length;
  assert.equal(linesAfter, 4, '头 + compensate + close + 新 mint（追加不重写）');
  assert.equal(walEvents(wal).filter(e => e.event === 'mint').length, 1);
});

test('ΝΩ-22-c 坏行/崩溃半行防御：跳过计数在册，好行照常重放', async () => {
  const wal = path.join(dir, 'dirty-wal.json');
  armStandard({ walFile: wal });
  const t = grantedToken();
  await reversalEscrow.mintPlan({ semantics: 'file-delete', approvalToken: t });
  await reversalEscrow.settleVerified(t);
  await reversalEscrow.idle();
  // 模拟崩溃中断的尾部半行 + 人为垃圾行
  appendFileSync(wal, '{"planId": "ESC-X", "event": "mint", ts trun\n', 'utf8');
  appendFileSync(wal, 'garbage-not-json\n', 'utf8');
  reversalEscrow.arm({
    now, storage: createEscrowFileStorage(wal), executorPort, hashPort, focusPort, clipboardPort,
  });
  assert.equal(reversalEscrow.stats().walSkippedLines, 2, '坏行/半行跳过计数在册');
  assert.equal(reversalEscrow.dumpLedger().filter(x => x.outcome === 'verified').length, 1, '好行照常重放');
  assert.equal(reversalEscrow.dumpInFlight().length, 0);
  // 重放后继续追加新事件 —— 运行面无残迹
  const t2 = grantedToken();
  const m2 = await reversalEscrow.mintPlan({ semantics: 'file-write', approvalToken: t2 });
  assert.equal(m2.ok, true, JSON.stringify(m2));
});

test('ΝΩ-22-d mint 顶替单事件行：双写合并为一行，重放等价', async () => {
  const wal = path.join(dir, 'supersede-wal.json');
  armStandard({ walFile: wal });
  const token = grantedToken();
  const first = await reversalEscrow.mintPlan({ semantics: 'file-delete', approvalToken: token });
  const second = await reversalEscrow.mintPlan({ semantics: 'file-delete', approvalToken: token });
  assert.ok(first.ok && second.ok);
  const evs = walEvents(wal);
  const mints = evs.filter(e => e.event === 'mint');
  assert.equal(mints.length, 2);
  assert.equal(mints[0].payload.superseded, undefined, '首次铸造无顶替');
  const sup = mints[1].payload.superseded;
  assert.equal(sup.planId, first.plan.planId);
  assert.equal(sup.outcome, 'aborted-pre-dispatch');
  assert.equal(sup.trigger, 'superseded');
  assert.equal(evs.filter(e => e.event === 'settle' || e.event === 'close' || e.event === 'compensate').length, 0,
    '顶替流产未另发结算行 —— 双写合并为单事件行');
  // 重放等价：重启后新预案在途被恢复、顶替流产账在场（与旧整档行为一致）
  armStandard({ walFile: wal });
  assert.equal(reversalEscrow.dumpInFlight().length, 0, '恢复语义：在途转人工处置');
  const ledger = reversalEscrow.dumpLedger();
  assert.equal(ledger.length, 2);
  assert.equal(ledger.find(x => x.outcome === 'aborted-pre-dispatch')?.planId, first.plan.planId);
  assert.equal(ledger.find(x => x.outcome === 'recovered-human-attention')?.planId, second.plan.planId);
});

test('ΝΩ-22-e append 面故障 ⇒ persist-failed 回滚（与旧存储面同律）', async () => {
  const okSaveBadAppend: EscrowStorage = {
    load: () => null,
    save: () => ({ ok: true }),
    append: () => ({ ok: false, error: 'append failed (disk full)' }),
  };
  reversalEscrow.arm({ now, storage: okSaveBadAppend, executorPort, hashPort, focusPort, clipboardPort });
  const first = await reversalEscrow.mintPlan({ semantics: 'file-delete', approvalToken: 'APR-NWE1' });
  assert.equal(first.ok, true, '首写建档走全量重写面（save ok）');
  const second = await reversalEscrow.mintPlan({ semantics: 'file-write', approvalToken: 'APR-NWE2' });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, 'persist-failed');
  assert.match(second.detail ?? '', /append failed/);
  assert.equal(reversalEscrow.dumpInFlight().length, 1, '失败铸造回滚（仅首枚在途）');
  assert.ok((reversalEscrow.stats().persistError ?? '').includes('append failed'));
});

// ─── S1-12 shaper 桥（environmentShaper 撤销栈 → 补偿执行端口） ───

test('S1-12 shaper 补偿执行器：shaper-undo 落到 restoreAll；路由错配醒目拒绝；绝不抛', async () => {
  const undoneKinds: string[] = [];
  const fakeAdapter: SystemAdapter = {
    platform: 'test',
    capabilities: async () => new Set(),
    apply: async (a) => ({ kind: a.kind, titleHint: a.titleHint }),
    undo: async (r) => { undoneKinds.push(r.kind); },
    getWindowGeometry: async () => null,
  };
  shaper.setAdapterForTest(fakeAdapter);
  shaper.restoreUndoLog([
    { token: 'undo-1', action: { kind: 'move_window' }, recipe: { kind: 'move_window', titleHint: 'X' }, undone: false },
    { token: 'undo-2', action: { kind: 'maximize_window' }, recipe: { kind: 'maximize_window', titleHint: 'X' }, undone: false },
  ]);
  const exec = createShaperCompensationExecutor();
  const r = await exec.execute({ method: 'shaper-undo', label: 'restore window layout' }, {} as ReversalPlan);
  assert.equal(r.ok, true);
  assert.deepEqual(undoneKinds, ['maximize_window', 'move_window']); // LIFO 逆序复原（后做的先还原）
  // 路由错配：非 shaper-undo 步骤醒目拒绝（绝不假装执行）
  const r2 = await exec.execute({ method: 'hotkey', label: 'Ctrl+Z' }, {} as ReversalPlan);
  assert.equal(r2.ok, false);
  assert.match(r2.detail ?? '', /shaper-undo/);
  shaper.clearUndoLog();
});

// ─── 组合执法：托管与审批的全链路协同（旗舰面回归） ───

test('S1-13 全链路：铸造→预留→派发后用户喊停→补偿验证→账册闭环', async () => {
  const wal = path.join(dir, 'escrow-wal.json');
  armStandard({ walFile: wal, withInterrupt: true });
  const { token, plan } = await mintAndReserve('form-submit');
  // 派发后用户喊停（中断端口信号经 sweep 轮询捕获）
  interruptFlag = true;
  assert.equal(await reversalEscrow.sweep(), 1);
  assert.deepEqual(execLog.map(e => e.label), ['Ctrl+Z undo the submission', 'recover from drafts folder']);
  const rec = reversalEscrow.dumpLedger()[0];
  assert.equal(rec.planId, plan.planId);
  assert.equal(rec.trigger, 'interrupt');
  assert.equal(rec.outcome, 'compensated-verified'); // HASH_A 未变 ⇒ 回预案态
  assert.equal(reversalEscrow.pendingHumanAttention().length, 0); // 无失败 ⇒ 无升级
  // 令牌侧：V 纪元语义原样（中断不焚令牌 —— 是否重试由审批层裁决）
  assert.equal(approval.status(token).present, true);
  const st = walState(wal);
  assert.deepEqual(st.inFlight, []); // WAL 与内存一致（在途清空 —— ΝΩ-22 行式重放视图）
});
