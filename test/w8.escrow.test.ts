// test/w8.escrow.test.ts
// W8-A4（DEBTS D-C1 第二轮：反转托管补偿策略表扩表）执法册：
//   ① manual-only 显式登记三键（data-export / factory-reset / app-uninstall）
//      正：铸造拒绝携带立法理由（compensationPathOf 同律）；反：拒派发
//      （beginAttempt 无预案 ⇒ plan-required fail-closed，不烧预算）+
//      S5-5d / W6-3 F3-② 键对齐律在新表上重演（11 键全对齐）；
//   ② 组合补偿执行器（createCompositeCompensationExecutor —— shaper 撤销栈
//      接入 escrow 统一账本的接线件）
//      正：shaper-undo 步骤路由 shaper 桥（真桥 LIFO 复原可验证）、非
//      shaper-undo 步骤路由 primary；反：无端口醒目拒绝、回落由最知情的
//      拒绝者说明、执行器抛错收敛为 ok:false 绝不抛；
//   ③ 部署扩表姿势端到端（内置 compensate 键受键对齐律 + riskGate 所有权
//      双重约束，扩自动补偿覆盖面的正确姿势 = 注入扩展 + setLevel 对齐 +
//      组合执行器接线）：
//      ③a 系统设置类（shaper-undo → UndoRecipe/restoreAll）补偿验证通过；
//      ③b 窗口关闭类（按标题重开 + Ctrl+Shift+T）补偿验证通过；
//      反：扩展键未在分级注册表登记级别 ⇒ classify 保守律默认最高级 ⇒
//      人道（humanExecution）—— 两表对齐是部署义务，不是 escrow 的让步；
//   ④ 扩表纪律：fail-closed 总律不松动 —— 未知语义仍 no-strategy；全部
//      manual-only 键（旧三 + 新三）逐个拒绝铸造；未注入扩展时扩展键不可
//      铸造（扩表不产生隐式覆盖面）。
// 全程离线确定性：注入时钟 / 注入端口剧本化 / tmp 目录；不依赖 CSPRNG 取值。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  approval, resetApproval, escrowBlockOf, setConfirmCodeChannel, type ConfirmCodeDelivery,
} from '../src/approval.ts';
import {
  reversalEscrow, createCompositeCompensationExecutor, builtinCompensationSemantics,
  compensationPathOf, type ReversalPlan, type CompensationExecutorPort, type CompensationStrategy,
} from '../src/reversalEscrow.ts';
import {
  shaper, createShaperCompensationExecutor, type SystemAdapter, type ShaperActionKind,
} from '../src/environmentShaper.ts';
import { reversibilityRegistry, dispatchLaneFor } from '../src/riskGate.ts';

// ─── 测试基建（离线确定性 —— w3escrow 同律） ───

const dirs: string[] = [];
process.on('exit', () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

/** 注入时钟（TTL 判定唯一时间源） */
let clockOffset = 0;
function now(): number { return Date.now() + clockOffset; }

/** 64 位 dhash 域的可控「屏幕」：A = 全 0；B = 半数翻转（sim=0.5 < 0.9 阈值） */
const HASH_A = '0'.repeat(64);
let hashNow: string | null = HASH_A;
const hashPort = { capture: async () => hashNow };

const focusPort = { current: async () => 'Window - Drafts' as string | null };
const clipboardPort = { backup: async () => 'clip-handle-1' as string | null, restore: async () => true };

/** GUI 侧（primary）执行端口剧本：记录执行序；可按标签注入失败/抛错 */
const guiLog: Array<{ label: string; method: string }> = [];
let guiFailOn: string | null = null;
let guiThrowOn: string | null = null;
const guiExecutor: CompensationExecutorPort = {
  execute: async (step, _plan: ReversalPlan): Promise<{ ok: boolean; detail?: string }> => {
    guiLog.push({ label: step.label, method: step.method });
    if (guiThrowOn === step.label) throw new Error('gui executor exploded');
    if (guiFailOn === step.label) return { ok: false, detail: 'gui executor denied this step' };
    return { ok: true };
  },
};

/** W6R fail-closed：带外码采集 + 携码授予（无码 grant 已废除） */
function grantedToken(description = 'click 导出 to export the ledger'): string {
  const sink: ConfirmCodeDelivery[] = [];
  setConfirmCodeChannel(d => { sink.push({ ...d }); });
  const pa = approval.request(description, { actionShape: { tool: 'click_mouse', x: 0.5, y: 0.5 } });
  const g = approval.grantDetailed(pa.token, true, { confirmCode: sink[0]?.confirmCode });
  assert.equal(g.ok, true, JSON.stringify(g));
  return pa.token;
}

/** 剧本化 shaper 适配器：记录 undo 的 recipe kind（复原取证面） */
let undoneKinds: string[] = [];
function armFakeShaper(): void {
  const adapter: SystemAdapter = {
    platform: 'test',
    capabilities: async () => new Set<ShaperActionKind>(['move_window', 'maximize_window', 'set_zoom', 'set_contrast']),
    apply: async (a) => ({ kind: a.kind, titleHint: a.titleHint }),
    undo: async (r) => { undoneKinds.push(r.kind); },
    getWindowGeometry: async () => null,
  };
  shaper.setAdapterForTest(adapter);
}

/** 两条撤销义务入栈（undo-1 move / undo-2 maximize —— LIFO 复原序的取证素材） */
function seedShaperUndoLog(): void {
  shaper.restoreUndoLog([
    { token: 'undo-1', action: { kind: 'move_window', titleHint: 'Notepad' }, recipe: { kind: 'move_window', titleHint: 'Notepad' }, undone: false },
    { token: 'undo-2', action: { kind: 'maximize_window', titleHint: 'Calc' }, recipe: { kind: 'maximize_window', titleHint: 'Calc' }, undone: false },
  ]);
}

beforeEach(() => {
  resetApproval();          // 令牌/桶/观察者/带外通道/托管钩子一并归零
  reversalEscrow.reset();   // 托管模块态归零（端口/存储/表/账册）
  reversibilityRegistry.reset(); // 分级注册表扩展级别/证据账归零（部署对齐每用例自设）
  shaper.clearUndoLog();
  clockOffset = 0;
  hashNow = HASH_A;
  guiLog.length = 0;
  guiFailOn = null;
  guiThrowOn = null;
  undoneKinds = [];
  dirs.push(mkdtempSync(path.join(tmpdir(), 'w8e-')));
});

// ─── ① manual-only 显式登记三键 ───

test('W8-A4-①a 正：三新 manual-only 键铸造拒绝携带立法理由；查询面同律；不入在途', async () => {
  reversalEscrow.arm({ now }); // 仅内存、无执行端口 —— 铸造面可用
  const expect: Array<{ key: string; needle: string }> = [
    { key: 'data-export', needle: 'trust boundary' },
    { key: 'factory-reset', needle: 'no recycle bin' },
    { key: 'app-uninstall', needle: 'reinstall does NOT restore' },
  ];
  for (const { key, needle } of expect) {
    const mint = await reversalEscrow.mintPlan({ semantics: key, description: `危险动作 ${key}` });
    assert.equal(mint.ok, false, `${key} 应拒绝铸造`);
    if (mint.ok) continue;
    assert.equal(mint.reason, 'manual-only', `${key} ⇒ manual-only（人类亲办）`);
    assert.match(mint.detail ?? '', new RegExp(needle), `${key} 拒绝携带立法理由`);
    // 只读查询面与铸造面同律（分级对齐锚点可引用）
    const q = compensationPathOf(key);
    assert.equal(q.kind, 'manual-only');
    assert.match(q.reason ?? '', new RegExp(needle));
  }
  // 拒绝不入托管（在途零注册 —— 与未知语义拒绝同律，无簿记副作用）
  assert.equal(reversalEscrow.dumpInFlight().length, 0);
  assert.equal(reversalEscrow.dumpLedger().length, 0);
  // 内置表视图含三新键（透明化面）
  const builtin = builtinCompensationSemantics();
  for (const { key } of expect) assert.ok(builtin.includes(key), `内置表应含 ${key}`);
});

test('W8-A4-①b 反：新键无预案派发 ⇒ plan-required fail-closed（不烧预算）；键对齐律在新表重演', async () => {
  reversalEscrow.arm({ now });
  const token = grantedToken();
  // 派发层铸造被 manual-only 拒绝后仍试图派发（无 planId）⇒ 闸门拒绝
  assert.equal(approval.beginAttempt(token, { escrow: { semantics: 'factory-reset' } }), false);
  const block = escrowBlockOf();
  assert.ok(block);
  assert.equal(block!.reason, 'plan-required');
  assert.equal(approval.status(token).attempts, 0, '不烧尝试预算');
  assert.equal(approval.status(token).present, true, '令牌不毁');
  // S5-5d / W6-3 F3-② 键对齐律在 11 键新表上重演：每个内置策略键的
  // 补偿路径 kind 与分级注册表级别一致（compensate ⇔ compensable；
  // manual-only ⇔ irreversible —— 新键未在分级表登记 ⇒ 保守律默认最高级，
  // 与 manual-only 期望一致）
  assert.equal(builtinCompensationSemantics().length, 11, '8 旧键 + 3 新键');
  for (const key of builtinCompensationSemantics()) {
    const kind = compensationPathOf(key).kind;
    const level = reversibilityRegistry.classify({ semantics: key }).level;
    assert.equal(
      kind === 'manual-only' ? 'irreversible' : 'compensable',
      level,
      `escrow 策略 ${key}（${kind}）与分级注册表（${level}）不对齐`,
    );
  }
});

// ─── ② 组合补偿执行器（shaper 撤销栈 → escrow 统一账本的接线件） ───

test('W8-A4-②a 正：shaper-undo 步骤路由 shaper 桥（真桥 LIFO 复原）；非 shaper 步骤路由 primary', async () => {
  armFakeShaper();
  seedShaperUndoLog();
  const composite = createCompositeCompensationExecutor(guiExecutor, createShaperCompensationExecutor());
  // shaper-undo 步骤 → shaper 桥（restoreAll LIFO 复原 —— 复原后可核对）
  const r1 = await composite.execute(
    { method: 'shaper-undo', label: 'restore environment shape (shaper undo log)' },
    {} as ReversalPlan,
  );
  assert.deepEqual(r1, { ok: true });
  assert.deepEqual(undoneKinds, ['maximize_window', 'move_window'], 'LIFO：后做的先还原（UndoRecipe 逐条复原）');
  assert.equal(guiLog.length, 0, 'shaper-undo 步骤不经 GUI 执行器（一步恰一执行器）');
  // 非 shaper-undo 步骤 → primary（GUI 面）
  const r2 = await composite.execute(
    { method: 'recycle-bin-restore', label: 'restore from recycle bin', target: 'recycle-bin' },
    {} as ReversalPlan,
  );
  assert.deepEqual(r2, { ok: true });
  assert.deepEqual(guiLog.map(e => e.label), ['restore from recycle bin']);
  assert.equal(undoneKinds.length, 2, 'GUI 步骤不触发 shaper 复原');
});

test('W8-A4-②b 反：无端口醒目拒绝 / 回落由最知情的拒绝者说明 / 执行器抛错收敛绝不抛', async () => {
  armFakeShaper();
  seedShaperUndoLog();
  const shaperBridge = createShaperCompensationExecutor();
  // primary 缺席 + 非 shaper-undo 步骤 ⇒ 回落 shaper 桥（由桥醒目拒绝 ——
  // 「只处理 shaper-undo」的说明比组合器吞掉步骤更诚实）
  const onlyShaper = createCompositeCompensationExecutor(null, shaperBridge);
  const refused = await onlyShaper.execute(
    { method: 'menu', label: 'Edit > Undo menu', target: 'Edit>Undo' },
    {} as ReversalPlan,
  );
  assert.equal(refused.ok, false);
  assert.match(refused.detail ?? '', /only handles method "shaper-undo"/);
  assert.deepEqual(undoneKinds, [], '拒绝不触发任何物理复原');
  // 两者皆缺席 ⇒ 无端口拒绝（绝不假装执行）
  const none = createCompositeCompensationExecutor(null, null);
  const r2 = await none.execute({ method: 'hotkey', label: 'Ctrl+Z', keys: ['ctrl', 'z'] }, {} as ReversalPlan);
  assert.equal(r2.ok, false);
  assert.match(r2.detail ?? '', /no port/);
  // primary 抛错 ⇒ 收敛 ok:false（绝不抛 —— 升级决策交 runCompensation）
  const throwing = createCompositeCompensationExecutor(guiExecutor, null);
  guiThrowOn = 'Ctrl+Z undo the write';
  let r3: { ok: boolean; detail?: string } | undefined;
  await assert.doesNotReject(async () => {
    r3 = await throwing.execute({ method: 'hotkey', label: 'Ctrl+Z undo the write', keys: ['ctrl', 'z'] }, {} as ReversalPlan);
  });
  assert.equal(r3!.ok, false);
  assert.match(r3!.detail ?? '', /threw/);
  assert.match(r3!.detail ?? '', /gui executor exploded/);
  // 垃圾步骤防御（绝不抛）
  let r4: { ok: boolean; detail?: string } | undefined;
  await assert.doesNotReject(async () => {
    r4 = await throwing.execute(null as unknown as Parameters<typeof throwing.execute>[0], {} as ReversalPlan);
  });
  assert.equal(r4!.ok, false);
  assert.match(r4!.detail ?? '', /malformed/);
});

// ─── ③ 部署扩表姿势端到端（注入扩展 + setLevel 对齐 + 组合执行器接线） ───

/** 系统设置类扩展策略：补偿 = shaper 撤销栈全量 LIFO 复原（UndoRecipe 机制） */
const SYSTEM_SETTING_STRATEGY: CompensationStrategy = {
  kind: 'compensate',
  semantics: 'system-setting',
  steps: [{ method: 'shaper-undo', label: 'restore environment shape (shaper undo log)' }],
  verify: { mode: 'screen-hash' },
  notes: 'W8-A4 部署扩表示范：缩放/对比度/窗口几何类 —— environmentShaper 的 UndoRecipe/undoLog 即补偿路径',
};

/** 窗口关闭类扩展策略：补偿 = 按标题重开 + Ctrl+Shift+T 重开最近关闭标签页 */
const WINDOW_CLOSE_STRATEGY: CompensationStrategy = {
  kind: 'compensate',
  semantics: 'window-close',
  steps: [
    { method: 'navigate', label: 'reopen closed window by title', target: 'reopen:by-title' },
    { method: 'hotkey', label: 'Ctrl+Shift+T reopen last closed tab', keys: ['ctrl', 'shift', 't'] },
  ],
  verify: { mode: 'screen-hash' },
  notes: 'W8-A4 部署扩表示范：窗口关闭类 —— 重开是关闭的天然逆动作（openUrl/快捷键双预案）',
};

test('W8-A4-③a 正：系统设置类（shaper-undo）端到端 —— 铸预案成功 + shaper 复原 + 补偿验证通过', async () => {
  armFakeShaper();
  seedShaperUndoLog();
  reversibilityRegistry.setLevel('system-setting', 'compensable'); // 部署对齐义务（两表同步登记）
  reversalEscrow.arm({
    now,
    hashPort, focusPort, clipboardPort,
    executorPort: createCompositeCompensationExecutor(guiExecutor, createShaperCompensationExecutor()),
    strategies: [SYSTEM_SETTING_STRATEGY],
  });
  const mint = await reversalEscrow.mintPlan({
    semantics: 'system-setting', description: 'set_zoom 到 125%', approvalToken: 'APR-W8A', tool: 'shape_environment',
  });
  assert.equal(mint.ok, true, JSON.stringify(mint));
  if (!mint.ok) return;
  assert.equal(mint.plan.verifyMode, 'screen-hash');
  assert.equal(mint.plan.compensation[0]!.method, 'shaper-undo');
  // 验收失败 ⇒ 自动补偿：shaper-undo 经组合器路由 shaper 桥 ⇒ restoreAll LIFO
  await reversalEscrow.settleFailed('APR-W8A', 'no-effect');
  await reversalEscrow.idle();
  assert.deepEqual(undoneKinds, ['maximize_window', 'move_window'], 'UndoRecipe 逐条 LIFO 复原（统一账本接线落地）');
  assert.equal(guiLog.length, 0, '补偿未误路由 GUI 面');
  // screen-hash 回预案态（HASH_A 未变）⇒ compensated-verified（补偿可验证铁律）
  const rec = reversalEscrow.dumpLedger()[0]!;
  assert.equal(rec.outcome, 'compensated-verified');
  assert.equal(rec.trigger, 'no-effect');
  assert.deepEqual(rec.executedSteps, ['restore environment shape (shaper undo log)']);
  assert.equal(reversalEscrow.dumpInFlight().length, 0);
  assert.equal(reversalEscrow.pendingHumanAttention().length, 0, '验证通过 ⇒ 无升级');
});

test('W8-A4-③a 反：系统设置类补偿验证失败（屏幕未回预案态）⇒ 升级人工，绝不静默', async () => {
  armFakeShaper();
  seedShaperUndoLog();
  reversibilityRegistry.setLevel('system-setting', 'compensable');
  reversalEscrow.arm({
    now,
    hashPort, focusPort, clipboardPort,
    executorPort: createCompositeCompensationExecutor(guiExecutor, createShaperCompensationExecutor()),
    strategies: [SYSTEM_SETTING_STRATEGY],
  });
  const mint = await reversalEscrow.mintPlan({ semantics: 'system-setting', approvalToken: 'APR-W8A2' });
  assert.equal(mint.ok, true);
  hashNow = '0'.repeat(32) + '1'.repeat(32); // 补偿后屏幕未回预案态（sim=0.5 < 0.9）
  await reversalEscrow.settleFailed('APR-W8A2', 'no-effect');
  await reversalEscrow.idle();
  const rec = reversalEscrow.dumpLedger()[0]!;
  assert.equal(rec.outcome, 'compensation-failed', 'shaper 复原执行了但世界未回预案态 ⇒ 补偿失败');
  assert.deepEqual(undoneKinds, ['maximize_window', 'move_window'], '补偿步骤确实执行（失败在验证面）');
  assert.ok(rec.escalation);
  assert.match(rec.escalation!.headline, /HUMAN INTERVENTION REQUIRED/);
  assert.equal(reversalEscrow.pendingHumanAttention().length, 1);
});

test('W8-A4-③b 正：窗口关闭类（按标题重开 + Ctrl+Shift+T）端到端 —— 补偿路径按序执行且验证通过', async () => {
  reversibilityRegistry.setLevel('window-close', 'compensable');
  reversalEscrow.arm({
    now,
    hashPort, focusPort, clipboardPort,
    executorPort: createCompositeCompensationExecutor(guiExecutor, null), // 无 shaper 桥 —— GUI 面单执行器
    strategies: [WINDOW_CLOSE_STRATEGY],
  });
  const mint = await reversalEscrow.mintPlan({
    semantics: 'window-close', description: 'close the report window', approvalToken: 'APR-W8B', tool: 'click_mouse',
  });
  assert.equal(mint.ok, true, JSON.stringify(mint));
  await reversalEscrow.settleFailed('APR-W8B', 'no-effect');
  await reversalEscrow.idle();
  // 补偿路径按序全执行（navigate 经 executor；hotkey 无热键端口 ⇒ 亦经 executor）
  assert.deepEqual(guiLog.map(e => e.label), ['reopen closed window by title', 'Ctrl+Shift+T reopen last closed tab']);
  const rec = reversalEscrow.dumpLedger()[0]!;
  assert.equal(rec.outcome, 'compensated-verified', 'screen-hash 回预案态（HASH_A 未变）');
  assert.deepEqual(rec.executedSteps, ['reopen closed window by title', 'Ctrl+Shift+T reopen last closed tab']);
});

test('W8-A4-③b 反：扩展键未在分级注册表登记 ⇒ 保守律默认最高级 ⇒ 人道（两表对齐是部署义务）', async () => {
  // 不 setLevel：分级注册表不认识 'window-close' ⇒ unknown-default irreversible
  const v = reversibilityRegistry.classify({ semantics: 'window-close' });
  assert.equal(v.level, 'irreversible');
  assert.equal(v.source, 'unknown-default');
  const lane = dispatchLaneFor(v.level);
  assert.equal(lane.lane, 'human');
  assert.equal(lane.humanExecution, true, '未对齐的扩展语义走人道 —— escrow 扩表不越权改变分级面');
  // 对照：登记后（部署完成两表对齐）⇒ escrow 道（mintPlan → beginAttempt）
  assert.equal(reversibilityRegistry.setLevel('window-close', 'compensable'), true);
  const aligned = reversibilityRegistry.classify({ semantics: 'window-close' });
  assert.equal(aligned.level, 'compensable');
  assert.equal(dispatchLaneFor(aligned.level).requiresEscrowPlan, true);
});

// ─── ④ 扩表纪律：fail-closed 总律不松动 ───

test('W8-A4-④ 扩表只加覆盖面不松执法：未知语义仍 no-strategy；六 manual-only 键逐个拒绝；未注入的扩展键不可铸造', async () => {
  reversalEscrow.arm({ now });
  // 未知语义：fail-closed（扩表不产生隐式覆盖）
  const miss = await reversalEscrow.mintPlan({ semantics: 'launch-missiles' });
  assert.equal(miss.ok, false);
  if (!miss.ok) {
    assert.equal(miss.reason, 'no-strategy');
    assert.match(miss.detail ?? '', /HUMAN must perform it personally/);
  }
  // 全部 manual-only 键（旧三 + 新三）逐个拒绝（W6-3 F3-② 在新表上重演）
  for (const sem of ['send-message', 'payment', 'permanent-delete', 'data-export', 'factory-reset', 'app-uninstall']) {
    const m = await reversalEscrow.mintPlan({ semantics: sem });
    assert.equal(m.ok, false, `${sem} 保持不可铸造`);
    assert.ok(!m.ok && m.reason === 'manual-only', `${sem} ⇒ manual-only（人类亲办）`);
  }
  // 未注入扩展时扩展键不可铸造（window-close/system-setting 是部署知识，不是内置覆盖面）
  for (const sem of ['window-close', 'system-setting']) {
    const m = await reversalEscrow.mintPlan({ semantics: sem });
    assert.ok(!m.ok && m.reason === 'no-strategy', `${sem} 未注入 ⇒ no-strategy（不臆造覆盖面）`);
  }
  assert.equal(reversalEscrow.dumpInFlight().length, 0);
  // 无预案仍拒派发（fail-closed 总律 —— beginAttempt 不带 escrow opts 的旧面零行为由 S1-10a 执法）
  const token = grantedToken();
  assert.equal(approval.beginAttempt(token, { escrow: { semantics: 'data-export' } }), false);
  assert.equal(escrowBlockOf()!.reason, 'plan-required');
});
