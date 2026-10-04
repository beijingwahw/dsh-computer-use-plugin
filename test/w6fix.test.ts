// test/w6fix.test.ts
// W6-3（真实缝隙修复包）：五纪元遗留四缺陷的执法册 —— 每项正 / 反 / 降级三路。
//   F1 hooks.ts post 包装实参丢弃（W2-5 遗留）—— 旧包装 `() => next()` 丢守卫
//      递给 next 的改写值（circuitBreaker 第 1/2 败的 appendHint 递进提示），
//      w2recovery.test 接线节注登记「hooks 包装层当前丢弃 next 实参」。
//      修复：透传实参 —— 守卫 next(v) ⇒ 宿主 next(v)；无参 next() ⇒ 宿主收
//      undefined（诚实缺省，零伪造）。
//   F2 审批队列 deniedAwaitingPrune 清理策略（W2-1 遗留）—— 已拒条目只计数
//      不清理，队列文件缓慢增长。修复：deny 后进入保留期（缺省 7 天模块常量，
//      可经 arm 注入），到期在下次队列落盘时清除；prunedDeniedTotal 计数器 +
//      档字段 prunedDeniedTotal 审计留痕（条目消失、账面长存，绝不静默）。
//   F3 escrow 补偿策略表扩容（W5-0 遗留）—— text-input / navigation 在 riskGate
//      判 compensable（escrow 道）却不在补偿策略表 ⇒ mintPlan fail-closed，
//      分级说「有托管补偿路径」而托管说「无策略」。修复：增补
//      text-input→[Ctrl+Z]、navigation→[Backspace 后退导航]；manual-only /
//      未知语义的 fail-closed 保持。
//   F4 hotkey 补偿 executor 接线（W3-1 遗留）—— 补偿中的 hotkey 类步骤此前只能
//      经通用 executor（部署无完整 executor 时热键补偿无法派发）。修复：
//      HotkeyPort 注入端口，hotkey 步骤优先路由；端口缺席回落通用 executor
//      （既有派发零变化）；全 hotkey 预案 + 仅热键端口 = 可执行（不再必然降级）；
//      热键失败 ⇒ compensation-failed 升级人工（绝不静默）。
// 全离线确定性：注入时钟 / 存储 / 端口，无真睡、无网络；单例测试后归位。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { onToolPost } from '../src/guards/hooks.ts';
import { registerCircuitBreakerGuard } from '../src/guards/circuitBreakerGuard.ts';
import { failureMemory } from '../src/failureMemory.ts';
import { recoveryEfficacy } from '../src/recoveryEfficacy.ts';
import { telemetry } from '../src/telemetry.ts';
import {
  approval, approvalQueue, resetApproval, setConfirmCodeChannel,
  createApprovalQueueFileStorage,
} from '../src/approval.ts';
import {
  reversalEscrow, builtinCompensationSemantics, compensationPathOf,
  type CompensationExecutorPort, type HotkeyPort,
} from '../src/reversalEscrow.ts';
import { reversibilityRegistry } from '../src/riskGate.ts';
import { gateByReversibility } from '../src/tools/clickMouse.ts';
import type { Config } from '../src/config.ts';

// ─── 测试基建（离线确定性 + 单例归位） ───

const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'w6fix-'));
  dirs.push(d);
  return d;
}
process.on('exit', () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

/** 注入时钟（approvalQueue 侧）：base 在铸造前锚定 —— 与 w2queue 同律 */
let clockBase = 0;
let clockOffset = 0;
function resetClock(): void { clockBase = Date.now(); clockOffset = 0; }
function now(): number { return clockBase + clockOffset; }
function advance(ms: number): void { clockOffset += ms; }

/** 带外通道在场信号（暂存资格的前提；码不消费 —— 本册不测带外协议） */
function armChannel(): void { setConfirmCodeChannel(() => true); }

/** 超时入队一条待批条目（推进越过缺省 5min 暂存超时 —— w2queue stageOne 同律） */
async function stageOne(description = 'click 发送 to submit the report'): Promise<string> {
  const pa = approval.request(description);
  advance(301_000);
  const r = approvalQueue.stageAction({ token: pa.token, description });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw new Error('unreachable');
  return r.entry.id;
}

/** escrow 侧可控端口（F4）：通用 executor 与热键端口各记各账 */
const execLog: string[] = [];
const hotkeyLog: string[][] = [];
let hotkeyFail = false;
const executorPort: CompensationExecutorPort = {
  execute: async (step) => { execLog.push(step.label); return { ok: true }; },
};
const hotkeyPort: HotkeyPort = {
  send: async (keys) => {
    hotkeyLog.push([...keys]);
    return hotkeyFail ? { ok: false, detail: 'hotkey port reported failure' } : { ok: true };
  },
};

/** hooks 侧 fake 宿主（rc.6 事件表面的最小模拟 —— post 事件三参形状） */
interface RegisteredHandler { event: string; handler: (e: any, r: any, next: any) => any }
function fakeCtx() {
  const handlers: RegisteredHandler[] = [];
  return {
    handlers,
    on(event: string, handler: any) { handlers.push({ event, handler }); return () => {}; },
  } as any;
}
const exec = (name: string, args: Record<string, unknown> = {}) =>
  ({ name, arguments: args, agent: { id: 'w6-3-test' } });
const FAILED_RESULT = {
  isError: false,
  value: '{\n  "status": "FAILED",\n  "state_anchor": {},\n  "next_step": "screen did not change, re-aim"\n}',
};

beforeEach(() => {
  resetApproval();          // 令牌/桶/观察者/带外通道/暂存队列（含 W6-3 保留期/计数）归零
  reversalEscrow.reset();   // 托管模块态归零（端口/存储/表/账册/热键端口）
  reversibilityRegistry.reset();
  failureMemory.reset();
  recoveryEfficacy.reset();
  telemetry.reset();
  resetClock();
  hotkeyFail = false;
  execLog.length = 0;
  hotkeyLog.length = 0;
});

// ─── F1：hooks.ts post 包装透传 next 实参（W2-5 遗留闭合） ───

test('W6-3 F1-①正: post 包装透传 next 实参 —— 守卫改写值抵达宿主（修复前收到 undefined）', async () => {
  const ctx = fakeCtx();
  onToolPost(ctx, (_call, result, next) => next(`REWRITTEN:${String(result)}`));
  const received: unknown[] = [];
  const h = ctx.handlers.find((r: RegisteredHandler) => r.event === 'tools/post-execute')!;
  const out = await h.handler(exec('click_mouse'), 'raw-value', async (v: unknown) => { received.push(v); return v; });
  assert.deepEqual(received, ['REWRITTEN:raw-value'], '宿主 next 收到守卫改写值 —— 丢弃实参的缝隙已闭合');
  // 既有转译语义保持：宿主链返回字符串 ⇒ toPostDecision 转 accept 决策（改写面）
  assert.equal(out.kind, 'accept');
  assert.equal(out.content[0].text, 'REWRITTEN:raw-value');
});

test('W6-3 F1-②正(端到端): circuitBreaker 第 1 败的 appendHint 递进提示经包装层抵达宿主', async () => {
  const ctx = fakeCtx();
  registerCircuitBreakerGuard(ctx, 3);
  const h = ctx.handlers.find((r: RegisteredHandler) => r.event === 'tools/post-execute')!;
  let hostGot: unknown;
  const out = await h.handler(exec('click_mouse'), FAILED_RESULT, async (v: unknown) => { hostGot = v; return v; });
  assert.ok(typeof hostGot === 'string', '宿主收到改写后的字符串结果（修复前：undefined）');
  assert.ok(JSON.parse(hostGot as string).recovery_hint.startsWith('Recovery hint:'),
    '第 1 败的递进恢复提示（recovery_hint）抵达宿主 —— w2recovery 接线节注登记的遗留闭合');
  assert.equal(out.kind, 'accept');
});

test('W6-3 F1-③反: 无参 next() ⇒ 宿主收 undefined（透传不伪造）；短路返回不经宿主且转译改写', async () => {
  // 无参放行：宿主收 undefined —— 与旧包装行为逐字节一致（放行面零变化）
  const ctx = fakeCtx();
  onToolPost(ctx, (_call, _result, next) => next());
  const received: unknown[] = [];
  const h = ctx.handlers.find((r: RegisteredHandler) => r.event === 'tools/post-execute')!;
  await h.handler(exec('click_mouse'), 'raw', async (v: unknown) => { received.push(v); return v; });
  assert.deepEqual(received, [undefined], '无参放行 ⇒ 宿主收 undefined（诚实缺省）');

  // 短路（不调 next）⇒ 宿主不被调用；守卫返回字符串转译 accept+content（既有改写语义）
  const ctx2 = fakeCtx();
  onToolPost(ctx2, () => 'GUARD-REWRITE');
  let hostCalled = 0;
  const h2 = ctx2.handlers.find((r: RegisteredHandler) => r.event === 'tools/post-execute')!;
  const out2 = await h2.handler(exec('click_mouse'), 'raw', async () => { hostCalled++; return 'unused'; });
  assert.equal(hostCalled, 0, '短路不穿透宿主（waterfall 语义不变）');
  assert.deepEqual(out2, { kind: 'accept', content: [{ type: 'text', text: 'GUARD-REWRITE' }] });
});

test('W6-3 F1-④兼容: 观察者守卫 next(result) 原样透传 —— 宿主收到原值（epochDelta P-3 引用透传不回归）', async () => {
  const ctx = fakeCtx();
  onToolPost(ctx, (_call, result, next) => next(result));
  const received: unknown[] = [];
  const h = ctx.handlers.find((r: RegisteredHandler) => r.event === 'tools/post-execute')!;
  const raw = 'same-string-result';
  const out = await h.handler(exec('take_screenshot'), raw, async (v: unknown) => { received.push(v); return v; });
  assert.equal(received[0], raw, '原样透传：守卫不改写 ⇒ 宿主收到原值');
  // 既有转译语义保持：宿主链返回字符串 ⇒ toPostDecision 转 accept（内容即原值）
  assert.equal(out.kind, 'accept');
  assert.equal(out.content[0].text, raw);
});

// ─── F2：审批队列 deniedAwaitingPrune 保留期清理（W2-1 遗留闭合） ───

test('W6-3 F2-①正: deny 后保留期内不清理；到期在下次落盘清除 + 审计计数随档留痕（跨进程恢复）', async () => {
  // 缺省保留期 = 7 天（模块常量；resetApproval 后透明化面可见）
  assert.equal(approvalQueue.queueStats().deniedRetentionMs, 7 * 24 * 60 * 60 * 1000, '缺省保留期 7 天（模块常量）');
  armChannel();
  const qfile = join(newDir(), 'queue.json');
  const RETENTION = 10 * 60_000_000; // 10min 注入保留期（> 301s 步进，判定确定性）
  approvalQueue.arm({ now, storage: createApprovalQueueFileStorage(qfile), stagingTimeoutMs: 300_000, ttlMs: 600_000, deniedRetentionMs: RETENTION });

  const a = await stageOne(); // 落盘 #1（deny 的 at ≈ now）
  assert.equal(approvalQueue.adjudicate([a], false).results[0].outcome, 'denied');
  await stageOne();           // 落盘 #2（推进 301s < 保留期）
  assert.equal(approvalQueue.queueStats().prunedDenied, 0, '保留期内：不清理（反路在此同测）');
  assert.equal(approvalQueue.pendingSummary().deniedAwaitingPrune, 1, '保留期内：晨报仍可见 denied 条目（审计窗口）');

  advance(RETENTION + 1_000); // 越过保留期
  await stageOne();           // 落盘 #3 ⇒ prune 执法点清除 A
  const st = approvalQueue.queueStats();
  assert.equal(st.prunedDenied, 1, '到期落盘：denied 条目清除，审计计数 +1（不静默消失）');
  assert.equal(st.entries, 2, 'A 已清；其余待批条目保留');
  assert.equal(approvalQueue.pendingSummary().deniedAwaitingPrune, 0, '晨报不再唠叨过期 denied');
  assert.ok(!approvalQueue.dumpQueue().some(e => e.id === a), 'A 从队列消失');

  // 档审计：prunedDeniedTotal 随档落盘（条目消失，「曾拒绝过多少」账面长存）
  const raw = JSON.parse(readFileSync(qfile, 'utf8')) as { prunedDeniedTotal: number; entries: Array<{ id: string }> };
  assert.equal(raw.prunedDeniedTotal, 1, '审计留痕随档长存');
  assert.ok(!raw.entries.some(e => e.id === a));

  // 跨进程：重新武装（同档）⇒ 累计清理数读回（取 max 不回退）
  approvalQueue.arm({ now: () => Date.now(), storage: createApprovalQueueFileStorage(qfile), deniedRetentionMs: RETENTION });
  assert.equal(approvalQueue.queueStats().prunedDenied, 1, '跨进程：审计计数从档恢复');
});

test('W6-3 F2-②反: 清理只针对 denied —— granted（待续跑）与 pending（待裁决）条目到期也不清', async () => {
  armChannel();
  const qfile = join(newDir(), 'queue.json');
  approvalQueue.arm({ now, storage: createApprovalQueueFileStorage(qfile), stagingTimeoutMs: 300_000, ttlMs: 600_000, deniedRetentionMs: 1_000 });
  const g = await stageOne();
  const p = await stageOne();
  assert.equal(approvalQueue.adjudicate([g], true).results[0].outcome, 'granted'); // Y-10 桶满 3，1 枚可扣
  advance(1_000_000); // 越过保留期
  const t = await stageOne(); // 落盘触发 prune：无 denied ⇒ 零清理
  assert.equal(approvalQueue.queueStats().prunedDenied, 0, '无 denied ⇒ 零清理');
  const ids = approvalQueue.dumpQueue().map(e => e.id);
  assert.ok(ids.includes(g) && ids.includes(p) && ids.includes(t),
    'granted（takeGranted 的续跑面）与 pending（裁决面）不受清理影响 —— 清理语义精确锁定 denied');
  assert.equal(approvalQueue.pendingSummary().grantedAwaitingResume, 1, 'granted 条目的续跑语义原样');
});

test('W6-3 F2-③降级: 注入时钟抛错 ⇒ 落盘路径绝不抛且一条不清（保守：宁留不误删）', async () => {
  armChannel();
  const qfile = join(newDir(), 'queue.json');
  approvalQueue.arm({ now: () => { throw new Error('clock broken'); }, storage: createApprovalQueueFileStorage(qfile), stagingTimeoutMs: 300_000, ttlMs: 600_000, deniedRetentionMs: 1_000 });
  // 恢复面直接注入：一条陈年 denied（at=1）+ 一条待批 —— qNow 抛错 ⇒ 读数为 0
  approvalQueue.restoreQueue([
    { id: 'QA-OLD', token: 'APR-OLD', description: '陈年已拒条目', evidence: {}, enqueuedAt: 1, ttlMs: 600_000, expiresAt: now() + 600_000, decision: { verdict: 'denied', at: 1 } },
    { id: 'QA-PEND', token: 'APR-PEND', description: '待批条目', evidence: {}, enqueuedAt: 1, ttlMs: 600_000, expiresAt: now() + 600_000 },
  ]);
  // deny 触发落盘（mutated ⇒ persistQueue ⇒ prune 的时钟面垃圾防御分支）
  assert.doesNotThrow(() => approvalQueue.adjudicate(['QA-PEND'], false));
  assert.equal(approvalQueue.queueStats().prunedDenied, 0, '时钟垃圾（qNow=0）⇒ 一条不清（保守方向）');
  assert.ok(approvalQueue.dumpQueue().some(e => e.id === 'QA-OLD'), '陈年 denied 条目保留 —— 不可因计时面故障误删审计面');
});

test('W6-3 F2-④降级: 存储缺席（仅内存）⇒ 落盘尝试同样清理 —— 内存面缓慢增长同律闭合', async () => {
  armChannel();
  approvalQueue.arm({ now, stagingTimeoutMs: 300_000, ttlMs: 600_000, deniedRetentionMs: 1_000 }); // 无 storage
  assert.equal(approvalQueue.queueStats().storageArmed, false, '仅内存队列');
  const a = await stageOne();
  approvalQueue.adjudicate([a], false);
  advance(2_000);
  await stageOne(); // persist（仅内存恒 ok）⇒ prune 执行
  assert.equal(approvalQueue.queueStats().prunedDenied, 1, '仅内存队列：清理照常执法');
  assert.equal(approvalQueue.dumpQueue().length, 1, '只留新 stage 的待批条目');
});

test('W6-3 F2-⑤配置: 保留期透明化 + 负值 = 部署显式关闭清理', async () => {
  armChannel();
  approvalQueue.arm({ now, deniedRetentionMs: -1 });
  assert.equal(approvalQueue.queueStats().deniedRetentionMs, -1, '注入值透明化');
  const a = await stageOne();
  approvalQueue.adjudicate([a], false);
  advance(10 * 60_000_000); // 远超任何合理保留期
  await stageOne();
  assert.equal(approvalQueue.queueStats().prunedDenied, 0, '负保留期 = 关闭清理（部署显式选择）');
  assert.equal(approvalQueue.pendingSummary().deniedAwaitingPrune, 1, '条目保持原样（旧行为完整保留的出口）');
});

// ─── F3：escrow 补偿策略表扩容（W5-0 遗留闭合） ───

test('W6-3 F3-①正: text-input / navigation 入策略表 ⇒ 可铸造（compensate）且路径为热键补偿', async () => {
  reversalEscrow.arm({ now: () => 1_000 }); // 仅内存、无端口 —— 铸造面可用
  const ti = await reversalEscrow.mintPlan({ semantics: 'text-input' });
  assert.equal(ti.ok, true, JSON.stringify(ti));
  assert.ok(ti.ok && ti.plan.compensation.some(s => s.method === 'hotkey' && JSON.stringify(s.keys) === JSON.stringify(['ctrl', 'z'])),
    'text-input ⇒ Ctrl+Z（输入类可撤销 —— 应用内 undo 栈）');
  const nav = await reversalEscrow.mintPlan({ semantics: 'navigation' });
  assert.equal(nav.ok, true);
  assert.ok(nav.ok && nav.plan.compensation.some(s => s.method === 'hotkey' && s.keys?.includes('backspace')),
    'navigation ⇒ Backspace 后退导航（可补偿 —— 回到动作前页面）');
  // 只读查询面与内置表视图同步
  assert.equal(compensationPathOf('text-input').kind, 'compensate');
  assert.ok(compensationPathOf('text-input').steps.some(x => x.includes('Ctrl+Z')));
  assert.equal(compensationPathOf('navigation').kind, 'compensate');
  const builtin = builtinCompensationSemantics();
  assert.ok(builtin.includes('text-input') && builtin.includes('navigation'), '内置表含两新键');
});

test('W6-3 F3-②反: manual-only / 未知语义保持 —— fail-closed 执法不因扩表松动', async () => {
  reversalEscrow.arm({});
  for (const sem of ['send-message', 'payment', 'permanent-delete']) {
    const m = await reversalEscrow.mintPlan({ semantics: sem });
    assert.equal(m.ok, false, `${sem} 保持不可铸造`);
    assert.ok(!m.ok && m.reason === 'manual-only', `${sem} ⇒ manual-only（人类亲办）`);
  }
  const miss = await reversalEscrow.mintPlan({ semantics: 'launch-missiles' });
  assert.ok(!miss.ok && miss.reason === 'no-strategy', '未知语义 ⇒ no-strategy（fail-closed 不变）');
  // w4reverse S5-5d 键对齐律在新表上重演：每个内置策略键的分级与补偿路径一致
  for (const key of builtinCompensationSemantics()) {
    const kind = compensationPathOf(key).kind;
    const level = reversibilityRegistry.classify({ semantics: key }).level;
    assert.equal(kind === 'manual-only' ? 'irreversible' : 'compensable', level, `策略 ${key}（${kind}）与分级注册表（${level}）对齐`);
  }
});

test('W6-3 F3-③执法: gate 托管道 —— type_text / open_url 的 escrow 道铸成放行（原 fail-closed 缺口闭合）', async () => {
  reversalEscrow.arm({});
  const cfg = { enableReversibilityLanes: true } as Config;
  const ti = await gateByReversibility(cfg, { tool: 'type_text', enforceEscrow: true });
  assert.equal(ti.applied, true);
  assert.equal(ti.verdict.semantics, 'text-input');
  assert.ok(typeof ti.escrowPlanId === 'string' && ti.escrowPlanId !== '', 'text-input 补偿预案铸成（修复前：no-strategy fail-closed）');
  assert.equal(ti.blocked, null);
  const nav = await gateByReversibility(cfg, { tool: 'open_url', enforceEscrow: true });
  assert.equal(nav.applied, true); // 判别收窄（asserts 签名）—— 后续 verdict/escrowPlanId 访问的类型面
  assert.equal(nav.verdict.semantics, 'navigation');
  assert.ok(typeof nav.escrowPlanId === 'string' && nav.escrowPlanId !== '', 'navigation 同律铸成');
  // 反：人道不变 —— 扩表只补 escrow 道，manual-only 语义照旧交还人类
  const human = await gateByReversibility(cfg, { tool: 'click_mouse', description: 'click 发送 the email' });
  assert.ok(human.applied === true && human.blocked !== null, 'send-message 仍人道拦截（ACTION_REQUIRED）');
});

// ─── F4：hotkey 补偿的热键端口接线（W3-1 遗留闭合） ───

test('W6-3 F4-①正: hotkey 步骤路由到热键端口 —— 通用 executor 不再经手热键（混合步骤分道）', async () => {
  reversalEscrow.arm({ now: () => 1_000, executorPort, hotkeyPort });
  assert.equal(reversalEscrow.stats().hotkeyPortArmed, true, '热键端口武装透明化');
  // file-write = [hotkey Ctrl+Z, menu Edit>Undo] —— 两类步骤各走各的端口
  const mint = await reversalEscrow.mintPlan({ semantics: 'file-write', approvalToken: 'APR-F4A' });
  assert.equal(mint.ok, true);
  await reversalEscrow.settleFailed('APR-F4A', 'no-effect');
  await reversalEscrow.idle();
  assert.deepEqual(hotkeyLog, [['ctrl', 'z']], 'Ctrl+Z 经热键端口派发（键序列原样传给注入端口）');
  assert.deepEqual(execLog, ['Edit > Undo menu'], 'menu 步骤仍走通用 executor（分工各就各位）');
  const rec = reversalEscrow.dumpLedger()[0];
  assert.equal(rec.outcome, 'compensated-unverified', '两步全执行；无验证通道 ⇒ 诚实降级记账');
  assert.deepEqual(rec.executedSteps, ['Ctrl+Z undo the write', 'Edit > Undo menu']);
});

test('W6-3 F4-②新能力: 仅热键端口（无 executor）⇒ 全 hotkey 预案可执行，不再必然降级记账', async () => {
  reversalEscrow.arm({ now: () => 1_000, hotkeyPort }); // executor 缺席
  const mint = await reversalEscrow.mintPlan({ semantics: 'text-input', approvalToken: 'APR-F4B' }); // 全 hotkey
  assert.equal(mint.ok, true);
  assert.ok(mint.ok && !(mint.plan.degraded ?? []).includes('no-executor-port'),
    '全 hotkey 预案 + 热键端口在场 ⇒ 不标 no-executor-port（W3-1 遗留：仅有热键管线的部署曾必然降级）');
  await reversalEscrow.settleFailed('APR-F4B', 'no-effect');
  await reversalEscrow.idle();
  assert.deepEqual(hotkeyLog, [['ctrl', 'z']], '自动补偿经热键端口落地');
  assert.equal(reversalEscrow.dumpLedger()[0].outcome, 'compensated-unverified');

  // 反（同测试内对照）：含非 hotkey 步骤（file-write 的 menu 步）+ 仅热键端口 ⇒ 降级记账不变
  const fw = await reversalEscrow.mintPlan({ semantics: 'file-write', approvalToken: 'APR-F4B2' });
  assert.ok(fw.ok && (fw.plan.degraded ?? []).includes('no-executor-port'), '含非 hotkey 步骤且 executor 缺席 ⇒ 降级标记照旧');
  await reversalEscrow.settleFailed('APR-F4B2', 'no-effect');
  await reversalEscrow.idle();
  const recs = reversalEscrow.dumpLedger();
  assert.equal(recs[recs.length - 1].outcome, 'degraded-record-only', '菜单步无通道 ⇒ 仅记账（降级方向不变）');
  assert.equal(hotkeyLog.length, 1, '降级路径不派发任何热键');
});

test('W6-3 F4-③回落: 热键端口缺席 ⇒ hotkey 步骤照旧走通用 executor（既有派发零变化）', async () => {
  reversalEscrow.arm({ now: () => 1_000, executorPort });
  assert.equal(reversalEscrow.stats().hotkeyPortArmed, false, '热键端口缺席');
  const mint = await reversalEscrow.mintPlan({ semantics: 'text-input', approvalToken: 'APR-F4C' });
  assert.ok(mint.ok && !(mint.plan.degraded ?? []).includes('no-executor-port'), 'executor 在场 ⇒ 无降级标记（既有行为）');
  await reversalEscrow.settleFailed('APR-F4C', 'no-effect');
  await reversalEscrow.idle();
  assert.deepEqual(execLog, ['Ctrl+Z undo the typing'], 'hotkey 步骤经通用 executor（w3escrow 既有派发路径逐字节保持）');
  assert.equal(hotkeyLog.length, 0);
});

test('W6-3 F4-④反: 热键端口派发失败 ⇒ compensation-failed + 升级人工（绝不静默）', async () => {
  hotkeyFail = true;
  reversalEscrow.arm({ now: () => 1_000, executorPort, hotkeyPort });
  const mint = await reversalEscrow.mintPlan({ semantics: 'text-input', approvalToken: 'APR-F4D' });
  assert.equal(mint.ok, true);
  await reversalEscrow.settleFailed('APR-F4D', 'no-effect');
  await reversalEscrow.idle();
  const rec = reversalEscrow.dumpLedger()[0];
  assert.equal(rec.outcome, 'compensation-failed', '热键派发失败 = 补偿失败（与 executor 失败同律）');
  assert.equal(rec.escalation?.failureDetail, 'hotkey port reported failure', '失败细节来自热键端口的返回');
  assert.equal(reversalEscrow.pendingHumanAttention().length, 1, '升级报告在场 —— 绝不静默吞掉一个可能受损的世界');
  assert.deepEqual(rec.executedSteps, ['Ctrl+Z undo the typing'], '失败于第一步即止');
});

test('W6-3 F4-⑤降级: 两端口皆缺席 ⇒ degraded-record-only 不变（纯 hotkey 预案同律）', async () => {
  reversalEscrow.arm({ now: () => 1_000 });
  const mint = await reversalEscrow.mintPlan({ semantics: 'navigation', approvalToken: 'APR-F4E' });
  assert.ok(mint.ok && (mint.plan.degraded ?? []).includes('no-executor-port'), '无任何执行通道 ⇒ 降级标记（诚实）');
  await reversalEscrow.settleFailed('APR-F4E', 'no-effect');
  await reversalEscrow.idle();
  assert.equal(reversalEscrow.dumpLedger()[0].outcome, 'degraded-record-only', '仅记账（可用性优先的模块方向不变）');
  assert.equal(hotkeyLog.length + execLog.length, 0, '无端口派发');
});
