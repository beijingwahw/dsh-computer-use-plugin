// test/w4reverse.test.ts
// W4-3（可逆性体系双包）执法册：
//   S5 可逆性分级注册表 ——
//     S5-1 三级映射（描述关键词 / 工具回退 / 显式语义；不可逆族优先的保守序）；
//     S5-2 未知动作默认最高级（未知工具 / 无命中描述 / 未注册语义）；
//     S5-3 示范事件调级证据门（单事件不翻级；双拒绝升一级；supportive 背景
//          抑制；irreversible 封顶；两 notch 门）；
//     S5-4 failureMemory 负证据（注入只读查询的瞬态合并 —— 不入持久账、
//          重复 classify 不膨胀）；
//     S5-5 快道分道（dispatchLaneFor 三级 + approval.request 携带级别 +
//          status/reversibilityOf/dispatchLaneOf 透明化 + 脏级别诚实弃置 +
//          grant(false)/consume 喂注册表证据）+ 与 escrow 策略表的键对齐律；
//   R3 有界回滚 + 分支重规划 ——
//     R3-1 良好态定位（判据核过/动作验证过；无良好态诚实缺席；LTLf 审计附页）；
//     R3-2 逆映射各模态（type→全选退格[破坏]/toggle→再点/scroll→反向/
//          shaper→UndoRecipe/其余 no-inverse）+ 复合计划 LIFO 序；
//     R3-3 破坏性逆动作过 approval 闸（拒绝 ⇒ 不执行 + 安全停；批准 ⇒ 执行）；
//     R3-4 复原验证两路（指纹容差内 ⇒ verified + 注入分支；不匹配 ⇒
//          not-restored 停安全态不注入；无通道 ⇒ unverified 诚实降级）；
//     R3-5 替代分支注入（自带偏置缝 pendingBiasOf + W3-6 withSteerBias 只读
//          消费 + ReplanBudgetController 总预算超支诚实终止）；
//     R3-6 计划有界（requiredSteps > 预算 ⇒ 截断保最新 + exceeded 诚实标记）；
//     R3-7 防御式绝不抛（端口抛错/垃圾输入 ⇒ 诚实结局）；
//     R3-8 shaper 定向复原桥（undoOne 单条/幂等/未命中回退全量 + 路由错配
//          醒目拒绝）；
//     R3-9 escrow 补偿路径只读查询（compensationPathOf 三面）。
// 全程离线确定性：纯函数直测 + 注入端口剧本化 + 可控指纹；不依赖 CSPRNG 取值。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  reversibilityRegistry, dispatchLaneFor,
} from '../src/riskGate.ts';
import {
  approval, resetApproval, setConfirmCodeChannel, type ConfirmCodeDelivery,
} from '../src/approval.ts';
import {
  reversalEscrow, builtinCompensationSemantics, compensationPathOf,
} from '../src/reversalEscrow.ts';
import {
  shaper, undoShaperRecord, createShaperRollbackExecutor,
  type SystemAdapter, type ShaperActionKind, type UndoRecipe,
} from '../src/environmentShaper.ts';
import {
  locateLastVerifiedGood, isVerifiedGood, inverseForStep, buildRollbackPlan,
  verifyRestoration, defaultAlternativeKeys, executeRollback, pendingBiasOf,
  resetRollbackPlanner, createSteerBiasPort, ReplanBudgetController,
  ROLLBACK_BUDGET_STEPS, REPLAN_BUDGET_STEPS,
  type RollbackTraceStep, type RollbackStep, type RollbackPorts,
} from '../src/rollbackPlanner.ts';
import type { ScoringContext } from '../src/autonomy/counterfactual.ts';

// ─── 测试基建（离线确定性） ───

/** 64 位 dhash 域的可控「屏幕」：A = 全 0；B = 半数翻转（sim=0.5 < 0.9 容差） */
const HASH_A = '0'.repeat(64);
const HASH_B = '0'.repeat(32) + '1'.repeat(32);

beforeEach(() => {
  resetApproval();          // 令牌/桶/观察者/队列/托管钩子 + S5 注册表证据账一并归零
  reversalEscrow.reset();   // 托管模块态归零
  resetRollbackPlanner();   // R3 自带偏置缝记录归零
  shaper.clearUndoLog();
  shaper.configure(false, false);
});

/** W6R fail-closed：带外码采集 + 携码授予（无码 grant 已废除 —— 授予面一律走此助手） */
const oobSink: ConfirmCodeDelivery[] = [];
function armOob(): void {
  setConfirmCodeChannel(d => { oobSink.push({ ...d }); });
}
function grantOob(token: string): boolean {
  const hit = oobSink.find(d => d.token === token);
  return approval.grantDetailed(token, true, hit ? { confirmCode: hit.confirmCode } : {}).ok;
}

// ─── S5-1 三级映射 ───

test('S5-1a 描述关键词三级映射：发送→不可逆 / 删除→可补偿 / 滚动→可逆', () => {
  const send = reversibilityRegistry.classify({ tool: 'click_mouse', description: 'click 发送 to send the email' });
  assert.equal(send.level, 'irreversible');
  assert.equal(send.semantics, 'send-message');
  assert.equal(send.source, 'builtin');

  const del = reversibilityRegistry.classify({ tool: 'click_mouse', description: 'click 删除 to remove report.docx' });
  assert.equal(del.level, 'compensable');
  assert.equal(del.semantics, 'file-delete');

  const pay = reversibilityRegistry.classify({ description: '支付 the invoice (pay now)' });
  assert.equal(pay.level, 'irreversible');
  assert.equal(pay.semantics, 'payment');

  const scroll = reversibilityRegistry.classify({ description: '滚动 the page down' });
  assert.equal(scroll.level, 'reversible');
  assert.equal(scroll.semantics, 'viewport-scroll');
});

test('S5-1b 工具回退表：scroll_page/switch_tab 可逆；type_text 可补偿（补偿走 W3-1 托管语义域）', () => {
  assert.deepEqual(
    { level: reversibilityRegistry.classify({ tool: 'scroll_page' }).level, semantics: reversibilityRegistry.classify({ tool: 'scroll_page' }).semantics },
    { level: 'reversible', semantics: 'viewport-scroll' },
  );
  const tab = reversibilityRegistry.classify({ tool: 'switch_tab' });
  assert.equal(tab.level, 'reversible');
  const type = reversibilityRegistry.classify({ tool: 'type_text' });
  assert.equal(type.level, 'compensable');
  assert.equal(type.semantics, 'text-input');
});

test('S5-1c 显式语义键优先；复合描述走不可逆族优先的保守序', () => {
  assert.equal(reversibilityRegistry.classify({ semantics: 'payment' }).level, 'irreversible');
  assert.equal(reversibilityRegistry.classify({ semantics: 'form-submit' }).level, 'compensable');
  // "delete ... and send ..."：两族命中，表序不可逆族在前 ⇒ send-message
  const mixed = reversibilityRegistry.classify({ description: 'delete the draft and send it' });
  assert.equal(mixed.semantics, 'send-message');
  assert.equal(mixed.level, 'irreversible');
});

// ─── S5-2 未知动作默认最高级（保守律） ───

test('S5-2 未知动作默认最高级：未知工具 / 无命中描述 / 未注册语义 ⇒ irreversible + unknown-default', () => {
  const unknownTool = reversibilityRegistry.classify({ tool: 'press_hotkey' });
  assert.equal(unknownTool.level, 'irreversible');
  assert.equal(unknownTool.source, 'unknown-default');
  assert.equal(unknownTool.semantics, 'unknown');

  // click 的可逆性由目标语义决定 —— 目标未知 ⇒ 保守律默认最高级
  const bareClick = reversibilityRegistry.classify({ tool: 'click_mouse' });
  assert.equal(bareClick.level, 'irreversible');
  assert.equal(bareClick.source, 'unknown-default');

  const unknownDesc = reversibilityRegistry.classify({ tool: 'click_mouse', description: 'frobnicate the quux widget' });
  assert.equal(unknownDesc.level, 'irreversible');
  assert.equal(unknownDesc.source, 'unknown-default');

  const unregistered = reversibilityRegistry.classify({ semantics: 'my-custom-semantic' });
  assert.equal(unregistered.level, 'irreversible');
  assert.equal(unregistered.source, 'unknown-default');
});

// ─── S5-3 示范事件调级证据门 ───

test('S5-3a 单事件不翻级：1 次 approval-denied ⇒ 级别不变（Beta 证据门执法点）', () => {
  reversibilityRegistry.observeDemonstration({ kind: 'approval-denied', semantics: 'file-delete' });
  const v = reversibilityRegistry.classify({ semantics: 'file-delete' });
  assert.equal(v.level, 'compensable', '单次拒绝不足以翻级（adverse=1 < 2 门槛）');
  assert.equal(v.source, 'builtin');
  // 证据已入账（透明化面可见 —— 门是拦「翻级」，不是拦「记账」）
  assert.deepEqual(
    reversibilityRegistry.dumpEvidence().find(e => e.semantics === 'file-delete'),
    { semantics: 'file-delete', adverse: 1, supportive: 0, posterior: 0.667 },
  );
});

test('S5-3b 双拒绝升一级：compensable → irreversible（source=calibrated + 证据快照）', () => {
  reversibilityRegistry.observeDemonstration({ kind: 'approval-denied', semantics: 'file-delete' });
  reversibilityRegistry.observeDemonstration({ kind: 'approval-denied', semantics: 'file-delete' });
  const v = reversibilityRegistry.classify({ semantics: 'file-delete' });
  assert.equal(v.level, 'irreversible');
  assert.equal(v.source, 'calibrated');
  assert.equal(v.evidence?.adverse, 2);
  assert.equal(v.evidence?.raisedNotches, 1);
});

test('S5-3c 特权正示范是后验分母：3 次 consumed + 2 次 denied ⇒ 后验 < 0.5 不升级', () => {
  for (let i = 0; i < 3; i++) reversibilityRegistry.observeDemonstration({ kind: 'approval-consumed', semantics: 'form-submit' });
  reversibilityRegistry.observeDemonstration({ kind: 'approval-denied', semantics: 'form-submit' });
  reversibilityRegistry.observeDemonstration({ kind: 'approval-denied', semantics: 'form-submit' });
  const v = reversibilityRegistry.classify({ semantics: 'form-submit' });
  assert.equal(v.level, 'compensable', 'posterior 3/7 ≈ 0.43 < 0.5 —— 高频成功里的偶发拒绝不翻级');
});

test('S5-3d 两 notch 门：reversible + 4 拒绝 ⇒ 直升 irreversible；irreversible 封顶不变', () => {
  for (let i = 0; i < 4; i++) reversibilityRegistry.observeDemonstration({ kind: 'approval-denied', semantics: 'viewport-scroll' });
  const v = reversibilityRegistry.classify({ semantics: 'viewport-scroll' });
  assert.equal(v.level, 'irreversible', 'adverse=4、posterior=5/6≈0.83 ≥ 0.75 ⇒ 两级直升');
  assert.equal(v.evidence?.raisedNotches, 2);

  for (let i = 0; i < 6; i++) reversibilityRegistry.observeDemonstration({ kind: 'approval-denied', semantics: 'send-message' });
  assert.equal(reversibilityRegistry.classify({ semantics: 'send-message' }).level, 'irreversible', '已是最高级 —— 封顶');
});

// ─── S5-4 failureMemory 负证据（只读查询的瞬态合并） ───

test('S5-4a 负证据查询瞬态合并：count≥2 升级；count=1 不升；查询不入持久账', () => {
  reversibilityRegistry.arm({ negativeEvidenceQuery: (s) => (s === 'text-input' ? 2 : 0) });
  const v = reversibilityRegistry.classify({ tool: 'type_text' });
  assert.equal(v.level, 'irreversible', 'adverse=2（瞬态）+ posterior 3/4 ⇒ 升一级');
  assert.equal(v.source, 'calibrated');
  // 瞬态语义：持久证据账仍为零账（classify 反复调用不得自我膨胀 β）
  assert.equal(reversibilityRegistry.dumpEvidence().length, 0);
  const again = reversibilityRegistry.classify({ tool: 'type_text' });
  assert.equal(again.level, 'irreversible');
  assert.equal(again.evidence?.adverse, 2, '第二次 classify 结果一致（无累加）');

  reversibilityRegistry.arm({ negativeEvidenceQuery: (s) => (s === 'text-input' ? 1 : 0) });
  assert.equal(reversibilityRegistry.classify({ tool: 'type_text' }).level, 'compensable', 'count=1 不足证据门');
});

test('S5-4b 查询端口抛错 = 无负证据（诚实缺席，不炸分级）', () => {
  reversibilityRegistry.arm({ negativeEvidenceQuery: () => { throw new Error('failureMemory exploded'); } });
  assert.equal(reversibilityRegistry.classify({ semantics: 'file-delete' }).level, 'compensable');
});

// ─── S5-5 快道分道 + approval 接线 ───

test('S5-5a dispatchLaneFor 三级分道：fast / escrow（预案先行）/ human（审批+亲办）', () => {
  const fast = dispatchLaneFor('reversible');
  assert.equal(fast.lane, 'fast');
  assert.equal(fast.requiresApprovalToken, false);
  assert.equal(fast.requiresEscrowPlan, false);
  assert.equal(fast.humanExecution, false);

  const escrowLane = dispatchLaneFor('compensable');
  assert.equal(escrowLane.lane, 'escrow');
  assert.equal(escrowLane.requiresEscrowPlan, true, '可补偿 ⇒ 走 W3-1 托管：先 mintPlan 再 beginAttempt');
  assert.equal(escrowLane.humanExecution, false);

  const human = dispatchLaneFor('irreversible');
  assert.equal(human.lane, 'human');
  assert.equal(human.requiresApprovalToken, true, '不可逆 ⇒ 强制审批');
  assert.equal(human.humanExecution, true, '不可逆 ⇒ 人类亲办');
});

test('S5-5b approval.request 携带级别：reversibilityOf/status/dispatchLaneOf 透明化；脏级别诚实弃置', () => {
  const verdict = reversibilityRegistry.classify({ tool: 'click_mouse', description: 'click 删除 to remove report.docx' });
  const pa = approval.request('click 删除 to remove report.docx', {
    actionShape: { tool: 'click_mouse', x: 0.5, y: 0.5 },
    reversibility: { level: verdict.level, semantics: verdict.semantics, source: verdict.source },
  });
  assert.deepEqual(approval.reversibilityOf(pa.token), { level: 'compensable', semantics: 'file-delete', source: 'builtin' });
  assert.equal(approval.status(pa.token).reversibilityLevel, 'compensable');
  assert.equal(approval.status(pa.token).reversibilitySemantics, 'file-delete');
  const lane = approval.dispatchLaneOf(pa.token);
  assert.equal(lane?.lane, 'escrow', '派发层按级分道 —— compensable 走托管道');

  // 未携带分级 ⇒ null（诚实缺席，绝不替调用方默认）
  const bare = approval.request('plain approval');
  assert.equal(approval.reversibilityOf(bare.token), null);
  assert.equal(approval.dispatchLaneOf(bare.token), null);

  // 脏级别（不在三级域）⇒ 诚实弃置不携带
  const dirty = approval.request('dirty level', { reversibility: { level: 'nonsense' as unknown as 'reversible' } });
  assert.equal(approval.reversibilityOf(dirty.token), null);

  // 缺席令牌的 status 面不增键（既有 deepEqual 断言零破坏）
  assert.deepEqual(approval.status('APR-NONSENSE'), { present: false, granted: false, expired: false });
});

test('S5-5c Τ示范事件喂注册表：grant(false) ⇒ adverse++；consume ⇒ supportive++（经 approval 全链接线）', () => {
  armOob(); // W6R：授予（grant=true）须带外码；拒绝路径无需人证
  // 拒绝路径：request 携带分级 → grantDetailed(false) → 注册表 adverse +1
  const pd = approval.request('click 删除 report.docx', {
    actionShape: { tool: 'click_mouse', x: 0.5, y: 0.5 },
    reversibility: { level: 'compensable', semantics: 'file-delete', source: 'builtin' },
  });
  approval.grantDetailed(pd.token, false);
  assert.deepEqual(
    reversibilityRegistry.dumpEvidence().find(e => e.semantics === 'file-delete'),
    { semantics: 'file-delete', adverse: 1, supportive: 0, posterior: 0.667 },
  );

  // 消费路径：grant(true) → consume 成功 ⇒ supportive +1
  const pc = approval.request('click 删除 other.docx', {
    reversibility: { level: 'compensable', semantics: 'file-delete', source: 'builtin' },
  });
  assert.equal(grantOob(pc.token), true);
  assert.equal(approval.consume(pc.token), true);
  assert.deepEqual(
    reversibilityRegistry.dumpEvidence().find(e => e.semantics === 'file-delete'),
    { semantics: 'file-delete', adverse: 1, supportive: 1, posterior: 0.5 },
  );
});

test('S5-5d S5 ↔ escrow 策略表键对齐律：六个托管语义在分级注册表中级别一致', () => {
  // compensate 键 ⇒ compensable；manual-only 键 ⇒ irreversible（两表独立维护、
  // 键对齐靠本测试执法 —— riskGate 不得 import reversalEscrow（环），对齐是纪律）
  assert.equal(reversibilityRegistry.classify({ semantics: 'form-submit' }).level, 'compensable');
  assert.equal(reversibilityRegistry.classify({ semantics: 'file-delete' }).level, 'compensable');
  assert.equal(reversibilityRegistry.classify({ semantics: 'file-write' }).level, 'compensable');
  assert.equal(reversibilityRegistry.classify({ semantics: 'send-message' }).level, 'irreversible');
  assert.equal(reversibilityRegistry.classify({ semantics: 'payment' }).level, 'irreversible');
  assert.equal(reversibilityRegistry.classify({ semantics: 'permanent-delete' }).level, 'irreversible');
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

// ─── R3-1 良好态定位（journal 回放 + LTLf 只读消费） ───

test('R3-1a 定位最近的「已验证良好」步：SUCCESS+effect 过核；effect=false 不算良好', () => {
  const trace: RollbackTraceStep[] = [
    { tool: 'click_mouse', status: 'SUCCESS', effect_detected: true, fingerprint: HASH_A },
    { tool: 'type_text', status: 'SUCCESS', effect_detected: true, fingerprint: HASH_A },
    { tool: 'click_mouse', status: 'FAILED', fingerprint: HASH_A },
    { tool: 'type_text', status: 'SUCCESS', effect_detected: false, fingerprint: HASH_B }, // 验证无效 ⇒ 非良好
  ];
  const loc = locateLastVerifiedGood(trace);
  assert.equal(loc.index, 1, '最近的良好步是 index 1（2 失败、3 验证无效）');
  assert.equal(loc.fingerprint, HASH_A, '良好态步自带的指纹 = 复原验证锚点');
  assert.equal(loc.nonGoodPositions, 2);
  assert.ok(Array.isArray(loc.traceAudit) && loc.traceAudit.length > 0, 'LTLf ReAct 判决书随行（审计附页）');
});

test('R3-1b 无良好态诚实缺席：空迹 / 全失败 / 未验证（effect undefined）⇒ index null', () => {
  assert.equal(locateLastVerifiedGood([]).index, null);
  assert.equal(locateLastVerifiedGood([{ tool: 'click_mouse', status: 'FAILED' }]).index, null);
  // 未验证不算良好 —— 「已验证良好」的字面义（isVerifiedGood 纯函数直测）
  assert.equal(isVerifiedGood({ tool: 'x', status: 'SUCCESS' }), false);
  assert.equal(isVerifiedGood({ tool: 'x', status: 'SUCCESS', effect_detected: false }), false);
  assert.equal(isVerifiedGood({ tool: 'x', status: 'SUCCESS', effect_detected: true }), true);
});

// ─── R3-2 逆映射各模态 + 复合计划 ───

test('R3-2a 模态逆映射表：type→全选退格(破坏)/toggle→再点/scroll→反向/shaper→undoLog/其余 no-inverse', () => {
  const type = inverseForStep({ tool: 'type_text', args: { text: 'hello' } });
  assert.equal(type.modality, 'select-all-backspace');
  assert.equal(type.destructive, true, '全选退格会清掉整个字段（不只本次输入）—— 必过审批闸');
  assert.deepEqual(type.payload.keys, [['ctrl', 'a'], ['backspace']]);

  const toggle = inverseForStep({ tool: 'click_mouse', args: { x: 0.4, y: 0.6, target_description: 'dark mode toggle' } });
  assert.equal(toggle.modality, 're-click-toggle');
  assert.equal(toggle.destructive, false);
  assert.equal(toggle.payload.x, 0.4);
  assert.equal(toggle.payload.y, 0.6);

  const scroll = inverseForStep({ tool: 'scroll_page', args: { dy: 5 } });
  assert.equal(scroll.modality, 'reverse-scroll');
  assert.equal(scroll.destructive, false);
  assert.equal(scroll.payload.dy, -5, '反向同量（精确逆）');

  const shaperStep = inverseForStep({ tool: 'shaper', args: { undoToken: 'undo-2' } });
  assert.equal(shaperStep.modality, 'shaper-undo');
  assert.equal(shaperStep.destructive, false);
  assert.equal(shaperStep.payload.undoToken, 'undo-2');

  assert.equal(inverseForStep({ tool: 'press_hotkey' }).modality, 'no-inverse');
  assert.equal(inverseForStep({ tool: 'click_mouse', args: { x: 0.4, y: 0.6 } }).modality, 'no-inverse', '普通点击无自动逆 —— 如实申报，绝不伪造');
});

test('R3-2b 复合回滚计划：LIFO 序（后做的先还原）+ 破坏性步清单 + 预算账', () => {
  const trace: RollbackTraceStep[] = [
    { tool: 'click_mouse', status: 'SUCCESS', effect_detected: true, fingerprint: HASH_A }, // 良好态锚点
    { tool: 'type_text', args: { text: 'x' } },
    { tool: 'click_mouse', args: { x: 0.4, y: 0.6, target_description: 'the toggle' } },
    { tool: 'scroll_page', args: { dy: 3 } },
  ];
  const plan = buildRollbackPlan(trace, 0);
  assert.equal(plan.checkpointIndex, 0);
  assert.equal(plan.checkpointFingerprint, HASH_A);
  assert.deepEqual(plan.steps.map(s => s.modality), ['reverse-scroll', 're-click-toggle', 'select-all-backspace'], 'LIFO：scroll 逆在最前');
  assert.deepEqual(plan.destructiveSteps.map(s => s.modality), ['select-all-backspace']);
  assert.deepEqual(plan.budget, { maxSteps: ROLLBACK_BUDGET_STEPS, requiredSteps: 3, exceeded: false });
  assert.deepEqual(plan.noInverseTools, []);
});

// ─── R3-3 破坏性逆动作过 approval 闸 ───

/** 剧本化端口：全记录 + 可注入审批裁决（bias 用对象计数 —— 闭包内自增对
 *  解构出的原始值不可见） */
function makePorts(o: {
  approve?: boolean;
  fingerprint?: string | null;
  failOn?: string;
} = {}): { ports: RollbackPorts; executed: string[]; approvals: string[]; bias: { calls: number } } {
  const executed: string[] = [];
  const approvals: string[] = [];
  const bias = { calls: 0 };
  const ports: RollbackPorts = {
    execute: async (step: RollbackStep) => {
      executed.push(step.payload.label);
      if (o.failOn !== undefined && step.payload.label === o.failOn) return { ok: false, detail: 'scripted failure' };
      return { ok: true };
    },
    fingerprint: async () => o.fingerprint ?? null,
    requestApproval: async (req) => {
      approvals.push(req.step.payload.label);
      return { approved: o.approve !== false };
    },
    injectBias: async () => { bias.calls++; return { ok: true }; },
  };
  return { ports, executed, approvals, bias };
}

test('R3-3a 破坏性逆动作被拒 ⇒ 绝不执行 + approval-denied + 停安全态', async () => {
  const trace: RollbackTraceStep[] = [
    { tool: 'click_mouse', status: 'SUCCESS', effect_detected: true, fingerprint: HASH_A },
    { tool: 'scroll_page', args: { dy: 3 } },
    { tool: 'type_text', args: { text: 'oops' } },
  ];
  const { ports, executed, approvals } = makePorts({ approve: false, fingerprint: HASH_A });
  const out = await executeRollback(trace, ports);
  assert.equal(out.phase, 'approval-denied');
  if (out.phase !== 'approval-denied') return;
  assert.equal(out.denied.modality, 'select-all-backspace');
  // LIFO：type_text（最后做的）先还原 —— 其逆是破坏性步，闸在最前 ⇒ 拒绝即停，
  // 更早（更旧）的逆一步都不执行（部分回滚比带着未授权破坏继续走更安全）
  assert.deepEqual(executed, []);
  assert.deepEqual(approvals, ['select-all + backspace to clear the typed text'], '破坏性步过闸被拒');
  assert.equal(out.safeStop, true);
  assert.ok(out.report.includes('NOT approved'));
});

test('R3-3b 破坏性逆动作获批 ⇒ 执行（闸是审批不是禁止）', async () => {
  const trace: RollbackTraceStep[] = [
    { tool: 'click_mouse', status: 'SUCCESS', effect_detected: true, fingerprint: HASH_A },
    { tool: 'type_text', args: { text: 'oops' } },
  ];
  const { ports, executed, approvals } = makePorts({ approve: true, fingerprint: HASH_A });
  const out = await executeRollback(trace, ports);
  assert.equal(out.phase, 'completed');
  assert.deepEqual(approvals.length, 1);
  assert.deepEqual(executed, ['select-all + backspace to clear the typed text']);
});

// ─── R3-4 复原验证两路（+ 无通道降级） ───

test('R3-4a 复原验证·通过路：指纹容差内 ⇒ verified + 替代分支注入', async () => {
  const trace: RollbackTraceStep[] = [
    { tool: 'click_mouse', status: 'SUCCESS', effect_detected: true, fingerprint: HASH_A },
    { tool: 'scroll_page', args: { dy: 3 } },
  ];
  const { ports, bias } = makePorts({ fingerprint: HASH_A });
  const out = await executeRollback(trace, ports, { alternativeKeys: ['click_element'] });
  assert.equal(out.phase, 'completed');
  if (out.phase !== 'completed') return;
  assert.equal(out.restoration, 'verified');
  assert.equal(out.restorationSimilarity, 1);
  assert.equal(out.safeStop, false);
  assert.equal(bias.calls, 1, '复原确认后注入替代分支');
  assert.equal(out.branch?.injected, true);
  assert.deepEqual(out.branch?.preferredActionKeys, ['click_element']);
  assert.equal(out.branch?.replan.budgetSteps, REPLAN_BUDGET_STEPS);
});

test('R3-4b 复原验证·失败路：指纹不匹配 ⇒ not-restored + 停安全态 + 绝不注入分支', async () => {
  const trace: RollbackTraceStep[] = [
    { tool: 'click_mouse', status: 'SUCCESS', effect_detected: true, fingerprint: HASH_A },
    { tool: 'type_text', args: { text: 'oops' } },
  ];
  const { ports, bias } = makePorts({ approve: true, fingerprint: HASH_B }); // 指纹半数翻转：sim=0.5 < 0.9
  const out = await executeRollback(trace, ports, { alternativeKeys: ['click_element'] });
  assert.equal(out.phase, 'completed');
  if (out.phase !== 'completed') return;
  assert.equal(out.restoration, 'not-restored');
  assert.equal(out.safeStop, true, '不复原 ⇒ 诚实报告并停在安全态');
  assert.equal(out.branch, null, '从未复原的世界不重规划（流沙上不盖楼）');
  assert.equal(bias.calls, 0);
  assert.ok(out.restorationDetail.includes('NOT confirmed'));
});

test('R3-4c 复原验证·无通道：感知端口缺席 ⇒ unverified 诚实降级（≠ 失败）且不注入分支', async () => {
  const trace: RollbackTraceStep[] = [
    { tool: 'click_mouse', status: 'SUCCESS', effect_detected: true, fingerprint: HASH_A },
    { tool: 'scroll_page', args: { dy: 3 } },
  ];
  const { ports, bias } = makePorts({ fingerprint: null });
  const out = await executeRollback(trace, ports, { alternativeKeys: ['click_element'] });
  assert.equal(out.phase, 'completed');
  if (out.phase !== 'completed') return;
  assert.equal(out.restoration, 'unverified');
  assert.equal(out.safeStop, true);
  assert.equal(out.branch, null, '未确认复原 ⇒ 不满足「复原确认后注入」的前提');
  assert.equal(bias.calls, 0);
  // verifyRestoration 纯函数直测：缺锚点同样 unverified
  assert.deepEqual(verifyRestoration(HASH_A, null), { verdict: 'unverified' });
  assert.deepEqual(verifyRestoration(HASH_A, HASH_A).verdict, 'verified');
  assert.deepEqual(verifyRestoration(HASH_B, HASH_A), { verdict: 'not-restored', similarity: 0.5 });
});

// ─── R3-5 替代分支注入（自带缝 + W3-6 偏置风格只读消费 + 重规划预算） ───

test('R3-5a 自带偏置注入缝：无外部端口 ⇒ pendingBiasOf 可读（缺省替代键自推导）', async () => {
  const trace: RollbackTraceStep[] = [
    { tool: 'click_mouse', status: 'SUCCESS', effect_detected: true, fingerprint: HASH_A }, // 良好且成功的模态
    { tool: 'scroll_page', status: 'SUCCESS', effect_detected: true, fingerprint: HASH_A },
    { tool: 'type_text', args: { text: 'oops' } }, // 失败尾部
  ];
  assert.deepEqual(defaultAlternativeKeys(trace, 1), ['click_mouse', 'scroll_page'], '良好前缀中成功、且未陷入失败尾部的模态');
  const { ports } = makePorts({ approve: true, fingerprint: HASH_A });
  // 移除外部偏置端口 ⇒ 走自带缝
  const portsNoBias: RollbackPorts = { execute: ports.execute, fingerprint: ports.fingerprint, requestApproval: ports.requestApproval };
  const out = await executeRollback(trace, portsNoBias);
  assert.equal(out.phase, 'completed');
  if (out.phase !== 'completed') return;
  assert.equal(out.restoration, 'verified');
  assert.equal(out.branch?.injected, true);
  assert.deepEqual(out.branch?.preferredActionKeys, ['click_mouse', 'scroll_page']);
  const seam = pendingBiasOf();
  assert.deepEqual(seam?.preferredActionKeys, ['click_mouse', 'scroll_page'], '自带缝记录与返回一致');
  assert.equal(seam?.replan.status, 'armed');
});

test('R3-5b W3-6 岔路偏置风格只读消费：createSteerBiasPort 把键铸进 ScoringContext', async () => {
  const ctx: ScoringContext = {
    goalKeywords: ['reply', 'draft'],
    snapshot: {
      takenAt: 0, width: 1920, height: 1080, dhash: null,
      elements: [], textDigest: '', popups: [], focusedRegion: null, sceneLabel: '', degraded: [],
    },
  };
  const steer = createSteerBiasPort(ctx);
  const trace: RollbackTraceStep[] = [
    { tool: 'scroll_page', status: 'SUCCESS', effect_detected: true, fingerprint: HASH_A },
    { tool: 'type_text', args: { text: 'oops' } },
  ];
  const { ports, executed } = makePorts({ approve: true, fingerprint: HASH_A });
  const ports2: RollbackPorts = { ...ports, injectBias: steer.injectBias };
  const out = await executeRollback(trace, ports2, { alternativeKeys: ['click_element:reply-button'] });
  assert.equal(out.phase, 'completed');
  assert.equal(out.branch?.injected, true);
  const biased = steer.biased();
  assert.deepEqual(biased?.preferredActionKeys, ['click_element:reply-button'], 'withSteerBias 合并面（W3-6 偏置协议）');
  assert.equal(executed.length, 1);
});

test('R3-5c 分支重规划总预算：超支诚实终止；exhausted 是终局', async () => {
  const ctl = new ReplanBudgetController(3);
  assert.equal(ctl.state.status, 'armed');
  for (let i = 0; i < 3; i++) {
    const r = ctl.spend();
    assert.equal(r.proceed, true);
  }
  const over = ctl.spend();
  assert.equal(over.proceed, false);
  assert.equal(over.state.status, 'exhausted');
  ctl.complete();
  assert.equal(ctl.state.status, 'exhausted', '超支后再 complete 不改判 —— 第二尝试不悄悄续命');
  const ok2 = new ReplanBudgetController(2);
  ok2.spend(); ok2.complete();
  assert.equal(ok2.state.status, 'completed');
});

// ─── R3-6 计划有界（步数预算） ───

test('R3-6 预算超支：requiredSteps > maxSteps ⇒ 截断保最新 + exceeded 诚实标记 + 执行有界', async () => {
  const trace: RollbackTraceStep[] = [
    { tool: 'click_mouse', status: 'SUCCESS', effect_detected: true, fingerprint: HASH_A },
    ...Array.from({ length: 15 }, (_, i): RollbackTraceStep => ({ tool: 'scroll_page', args: { dy: i + 1 } })),
  ];
  const plan = buildRollbackPlan(trace, 0, { maxRollbackSteps: 4 });
  assert.equal(plan.budget.requiredSteps, 15);
  assert.equal(plan.budget.exceeded, true);
  assert.equal(plan.steps.filter(s => s.modality !== 'no-inverse').length, 4, '截断到预算内的最新逆步');

  const { ports, executed } = makePorts({ fingerprint: HASH_A });
  const out = await executeRollback(trace, ports, { maxRollbackSteps: 4 });
  assert.equal(out.phase, 'completed');
  if (out.phase !== 'completed') return;
  assert.equal(out.plan.budget.exceeded, true);
  assert.equal(executed.length, 4, '执行有界 —— 超支不悄悄续命');
  assert.ok(out.report.includes('budget exceeded'));
  // 截断保最新：保留的是 dy=15..12 的逆（LIFO 首 4 个 = 最新 4 步）
  assert.deepEqual(executed, ['scroll the opposite amount (exact inverse)', 'scroll the opposite amount (exact inverse)', 'scroll the opposite amount (exact inverse)', 'scroll the opposite amount (exact inverse)']);
  assert.equal(out.restoration, 'verified', '截断后复原验证兜底 —— 本剧本指纹仍回良好态');
});

// ─── R3-7 防御式绝不抛 ───

test('R3-7a 端口抛错收敛为诚实结局：审批抛 ⇒ 拒绝；执行抛 ⇒ 失败；垃圾轨迹 ⇒ no-good-state', async () => {
  const trace: RollbackTraceStep[] = [
    { tool: 'click_mouse', status: 'SUCCESS', effect_detected: true, fingerprint: HASH_A },
    { tool: 'type_text', args: { text: 'oops' } },
  ];
  // 审批端口抛错 ⇒ fail-closed（拒绝破坏性逆，绝不静默执行）
  const outDeny = await executeRollback(trace, {
    execute: async () => ({ ok: true }),
    fingerprint: async () => HASH_A,
    requestApproval: async () => { throw new Error('approval channel down'); },
  });
  assert.equal(outDeny.phase, 'approval-denied');
  if (outDeny.phase === 'approval-denied') assert.ok(outDeny.denialDetail?.includes('approval port threw'));

  // 执行端口抛错 ⇒ execution-failed 安全停
  const outFail = await executeRollback(trace, {
    execute: async () => { throw new Error('keyboard pipeline exploded'); },
    fingerprint: async () => HASH_A,
    requestApproval: async () => ({ approved: true }),
  });
  assert.equal(outFail.phase, 'execution-failed');
  if (outFail.phase === 'execution-failed') assert.ok(outFail.failureDetail.includes('executor threw'));

  // 感知端口抛错 ⇒ unverified 降级（通道故障 ≠ 复原失败）
  const outFp = await executeRollback(trace, {
    execute: async () => ({ ok: true }),
    fingerprint: async () => { throw new Error('screen capture failed'); },
    requestApproval: async () => ({ approved: true }),
  });
  assert.equal(outFp.phase, 'completed');
  if (outFp.phase === 'completed') assert.equal(outFp.restoration, 'unverified');

  // 垃圾轨迹（非数组 / 脏步）⇒ no-good-state（绝不抛）
  const outGarbage = await executeRollback(null as unknown as RollbackTraceStep[], {
    execute: async () => ({ ok: true }),
    fingerprint: async () => null,
    requestApproval: async () => ({ approved: true }),
  });
  assert.equal(outGarbage.phase, 'no-good-state');

  // 最后验证良好步是末步 ⇒ nothing-to-rollback
  const outNothing = await executeRollback([
    { tool: 'click_mouse', status: 'SUCCESS', effect_detected: true, fingerprint: HASH_A },
  ], makePorts({ fingerprint: HASH_A }).ports);
  assert.equal(outNothing.phase, 'nothing-to-rollback');
});

// ─── R3-8 shaper 定向复原桥（undoOne / undoShaperRecord / 路由错配） ───

/** 剧本化适配器：记录 undo 的 recipe kind（定向复原的取证面）。
 *  undoLog 经公共 restoreUndoLog 面铸入（apply 的能力闸门依赖真实探测、
 *  不可伪造 —— 现有 D-2 测试同律：适配器/撤销栈才是被测单元）。 */
function fakeAdapter(): { adapter: SystemAdapter; undone: string[] } {
  const undone: string[] = [];
  const adapter: SystemAdapter = {
    platform: 'null',
    capabilities: async () => new Set<ShaperActionKind>(['raise_window', 'move_window', 'set_zoom']),
    apply: async (action) => ({ kind: action.kind, titleHint: action.titleHint }) as UndoRecipe,
    undo: async (recipe) => { undone.push(recipe.kind); },
    getWindowGeometry: async () => null,
  };
  return { adapter, undone };
}

/** 两条 move_window 撤销义务入栈（undo-1 Notepad / undo-2 Calc） */
function seedUndoLog(): void {
  shaper.restoreUndoLog([
    {
      token: 'undo-1', undone: false,
      action: { kind: 'move_window', titleHint: 'Notepad', x: 10, y: 10 },
      recipe: { kind: 'move_window', titleHint: 'Notepad' },
    },
    {
      token: 'undo-2', undone: false,
      action: { kind: 'move_window', titleHint: 'Calc', x: 20, y: 20 },
      recipe: { kind: 'move_window', titleHint: 'Calc' },
    },
  ]);
}

test('R3-8a undoOne 定向复原：token 命中单条 / 幂等 / 未命中回退全量 LIFO', async () => {
  const { adapter, undone } = fakeAdapter();
  shaper.setAdapterForTest(adapter);
  seedUndoLog();

  const one = await shaper.undoOne('undo-1');
  assert.equal(one.ok, true);
  assert.deepEqual(undone, ['move_window'], '只复原了 token 命中的那一条');
  assert.equal(shaper.dumpUndoLog().find(r => r.token === 'undo-1')?.undone, true);
  assert.equal(shaper.dumpUndoLog().find(r => r.token === 'undo-2')?.undone, false);

  const again = await shaper.undoOne('undo-1');
  assert.equal(again.ok, true, '已复原的义务幂等 ok（不重复执行）');
  assert.equal(undone.length, 1);

  // 未命中 token ⇒ 回退全量 restoreAll（保守方向：多复原无害，少复原不完整）
  const fallback = await shaper.undoOne('undo-missing');
  assert.equal(fallback.ok, true);
  assert.equal(shaper.undoDepth(), 0, '全量 LIFO 复原后撤销栈清空');
  // undoShaperRecord 包装面（rollbackPlanner 端口/宿主的落点）
  shaper.restoreUndoLog([{
    token: 'undo-9', undone: false,
    action: { kind: 'set_zoom', titleHint: 'B', level: 125 },
    recipe: { kind: 'set_zoom', titleHint: 'B' },
  }]);
  assert.deepEqual(await undoShaperRecord('undo-9'), { ok: true });
  assert.deepEqual(await undoShaperRecord(undefined), { ok: true }, 'token 缺席 ⇒ 全量复原（保守回退面）');
});

test('R3-8b createShaperRollbackExecutor：shaper-undo 模态路由；错配醒目拒绝', async () => {
  const { adapter, undone } = fakeAdapter();
  shaper.setAdapterForTest(adapter);
  seedUndoLog();
  const exec = createShaperRollbackExecutor();
  const step: RollbackStep = {
    origin: { tool: 'shaper' },
    modality: 'shaper-undo',
    destructive: false,
    payload: { label: 'restore shaper change', undoToken: 'undo-2' },
  };
  assert.deepEqual(await exec.execute(step), { ok: true });
  assert.equal(shaper.dumpUndoLog().find(r => r.token === 'undo-2')?.undone, true, '定向复原 undoToken 命中条目');
  assert.equal(shaper.dumpUndoLog().find(r => r.token === 'undo-1')?.undone, false);
  assert.deepEqual(undone, ['move_window']);
  const wrong: RollbackStep = {
    origin: { tool: 'type_text' },
    modality: 'select-all-backspace',
    destructive: true,
    payload: { label: 'select-all + backspace' },
  };
  const refused = await exec.execute(wrong);
  assert.equal(refused.ok, false);
  assert.ok(refused.detail?.includes('only handles modality "shaper-undo"'));
});

// ─── R3-9 escrow 补偿路径只读查询 ───

test('R3-9 compensationPathOf：compensate / manual-only / none 三面（分级对齐锚点）', () => {
  const comp = compensationPathOf('file-delete');
  assert.equal(comp.kind, 'compensate');
  assert.ok(comp.steps.length >= 1);
  assert.ok(comp.steps.some(s => s.includes('recycle bin')));

  const manual = compensationPathOf('send-message');
  assert.equal(manual.kind, 'manual-only');
  assert.ok(manual.reason !== undefined && manual.reason.length > 0);

  assert.equal(compensationPathOf('totally-unknown-semantics').kind, 'none');
  assert.equal(compensationPathOf(null).kind, 'none');
});

// ─── 交叉防御：注册表脏输入（S5 面绝不抛） ───

test('W4-3 防御式：注册表/示范入账/扩展定级的脏输入全部收敛，绝不抛', () => {
  assert.deepEqual(
    reversibilityRegistry.classify(null as unknown as { tool: string }),
    { level: 'irreversible', semantics: 'unknown', source: 'unknown-default' },
  );
  reversibilityRegistry.observeDemonstration(null as unknown as { kind: string });
  reversibilityRegistry.observeDemonstration({ kind: 'garbage-kind' });
  reversibilityRegistry.applyNegativeEvidence(null, Number.NaN);
  reversibilityRegistry.applyNegativeEvidence('file-delete', 999); // 单次封顶 8
  // adverse=8（封顶后）、posterior=9/10=0.9 ≥ 0.75 ⇒ compensable 升至 irreversible
  assert.equal(reversibilityRegistry.classify({ semantics: 'file-delete' }).level, 'irreversible');
  assert.equal(reversibilityRegistry.setLevel('weird-semantics', 'reversible'), true);
  assert.equal(reversibilityRegistry.classify({ semantics: 'weird-semantics' }).source, 'extension');
  assert.equal(reversibilityRegistry.setLevel(null, 'reversible'), false, '脏键拒绝');
  assert.equal(reversibilityRegistry.setLevel('x', 'nope' as unknown as 'reversible'), false, '脏级别拒绝');
});
