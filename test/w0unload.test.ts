// test/w0unload.test.ts
// ΠΑΝ-28 / ΠΑΝ-29 执法册 —— 组合根生命周期两缺陷的回归抗体：
//   ΠΑΝ-28（C1-1 H4 + C2-9 主题 2）：卸载链单例重置完整性。
//     · 28a 补齐漏清面（resetApproval 审批全家 + rootCauseGuard/canaryGuard/
//       popupGuard/rollbackPlanner/macroRehearsal/branchLedger/vlmMeter/
//       refuteStats/dreamCostLedger）；
//     · 28b 立法 computeUnloadChecklist()（卸载清单完备性的枚举面）+
//       runUnloadAction 登记簿（执行面）—— 本册执法：清单 ≡ 实际执行，
//       新增单例 reset 忘记接线即红（「立法存在、枚举面不存在」不再可能）。
//     · ΠΑΝ-34 新增 'escrow.reset' 键（逆转托管武装卸载：sweep 定时器停表 +
//       reversalEscrow 模块态归零；在途预案留 WAL 由下次装载恢复面转人工）。
//   ΠΑΝ-29（C1-1 M1 + C2-9 主题 2 时序①）：睡眠/dispose 竞速。
//     · 修复前：runSleepCycle async fire-and-forget，同步 disposer 先跑完一切
//       reset，睡眠幕②起消费空账本、晨报记 ok、水位线照常前滚 —— 该会话的
//       离线整合被永久标记为已消化，产物无声丢失；
//     · 修复后：组合根传 disposeSignal 并同步 abort —— 幕②起零依赖调用、
//       梦幕跳过、晨报行不带水印且 interrupted:true、内存水位线不前滚。
// 全离线确定性：假 ctx（tools/on/get/emit/effect/reflect）、tmp 目录落盘、
// 零真网络、零真截屏、零服务孵化。参考 p2b-fixes/w8.finalwiring 注入风格。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import { Config, type Config as ConfigType } from '../src/config.ts';
import {
  apply, computeUnloadChecklist, lastUnloadActions,
} from '../src/index.ts';
import {
  approval, approvalQueue, approvalBudget, resetApproval,
} from '../src/approval.ts';
import { confirmChannelArmed } from '../src/approval.security.ts';
import { journal } from '../src/journal.ts';
import { runSleepCycle, resetSleepCycle } from '../src/sleep/index.ts';
// ΤΕΛ-10（D-G31 三单例归零缝）：被执法的三个模块面（重铸/换场/全域释放）。
import { prophecyWorldModel, resetProphecyWorldModel } from '../src/prophecy/index.ts';
import { buildAutonomyStack, releaseAllExplorationLedgers } from '../src/autonomy/index.ts';
import { resetAutonomousRunEvolution } from '../src/tools/autonomousRun.ts';

// ─── 假件工坊 ───

/** 捕获 ctx.effect 登记的清理函数 + approval/confirm-code 总线码（grant 流原料） */
function makeFakeCtx() {
  const disposers: Array<() => void> = [];
  let oobPayload: { token: string; confirmCode: string } | null = null;
  const ctx = {
    tools: { register: (_t: unknown) => { /* 计数不消费 —— 装配成功以 apply 不抛为准 */ } },
    on: (_event: string, _handler: unknown) => () => { /* off */ },
    get: (_name: string) => undefined,
    emit: (event: string, payload: unknown) => {
      if (event === 'approval/confirm-code' && payload && typeof payload === 'object') {
        const p = payload as { token?: string; confirmCode?: string };
        oobPayload = { token: String(p.token ?? ''), confirmCode: String(p.confirmCode ?? '') };
      }
    },
    effect: (register: () => () => void) => { disposers.push(register()); },
    reflect: { get: () => null },
  };
  return {
    ctx: ctx as unknown as Context,
    runDisposer: () => { for (const d of disposers) d(); },
    oobCode: () => oobPayload,
  };
}

/** 全字段缺省配置（schemastery 解析 —— 与宿主 cordis 同一铸造面）+ 覆盖项。
 *  Schema 值运行时可调用但类型面未暴露调用签名 —— 装配期收窄为解析函数。 */
const parseConfig = Config as unknown as (over?: Record<string, unknown>) => ConfigType;
function makeConfig(over: Record<string, unknown> = {}): ConfigType {
  return parseConfig(over);
}

/** 离线 apply 专用配置：vlmApiKey 占位阻断 lightUpVision 探测/向导；路径全 tmp。 */
function offlineApplyConfig(tmp: string, over: Record<string, unknown> = {}): ConfigType {
  return makeConfig({
    vlmApiKey: 'pan28-offline-no-network',
    checkpointPath: join(tmp, 'checkpoint.json'),
    skillLibraryPath: join(tmp, 'skills.json'),
    recoveryEfficacyPath: join(tmp, 'efficacy.json'),
    ...over,
  });
}

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const INDEX_SRC = fileURLToPath(new URL('../src/index.ts', import.meta.url));

beforeEach(() => {
  // 审批簿记/睡眠水位线隔离缝（生产由卸载链的 approval.reset/sleep.cycle 归零；
  // 测试显式归零保证各用例起点确定 —— 与 w2queue beforeEach 同律）。
  resetApproval();
  resetSleepCycle();
});

// ═══ ΠΑΝ-28b：卸载清单完备性立法 ═══

/** 金名单（法定义面）—— 与 src/index.ts 的 UNLOAD_CHECKLIST 逐键锁定：
 *  序即执行序（持久化先行、内存归零殿后）。任何增删都必须在此同步修法 ——
 *  这是「新增单例忘记注册即红」的对账锚。 */
const GOLDEN_CHECKLIST = [
  'sleep.cycle', 'journal.flush', 'notary.autoAnchor', 'shaper.restoreOrClear',
  'checkpoint.save', 'kernelStore.save', 'swarm.finalSync',
  'telemetry.reset', 'contextManager.reset', 'uiMemory.reset', 'selfModel.reset',
  'channelArbitration.reset', 'probeMemory.reset', 'journal.reset',
  'sessionBoundary.off', 'popup.sensor', 'popup.belief', 'popup.sprt',
  'freshness.port', 'oscillation.reset', 'elementTracker.reset', 'focusTracker.clear',
  'verifyGateBudget.reset', 'diffPersistence.reset', 'skillLibrary.save',
  'skillLibrary.reset', 'knowledgeBase.dispose', 'failureMemory.reset',
  'recoveryEfficacy.finalize', 'federationTrust.flush', 'skillFed.persist', 'federation.reset',
  'coordinator.reset', 'federation.unwire', 'reversibility.disarm', 'escrow.reset',
  'approval.reset', 'rootCauseGuard.reset', 'canaryGuard.reset', 'popupGuard.sessions',
  'rollbackPlanner.reset', 'macroRehearsal.reset', 'branchLedger.reset',
  'vlmMeter.reset', 'refuteStats.reset', 'dreamCostLedger.reset',
  // ΤΕΛ-10（D-G31 三单例归零缝收口）： prophecyWorldModel 重铸 / EXP4 进化
  // 单例换场 / explorationLedger pilot 域全域释放 —— vlmMeter 同族纯内存
  // 会话簿记（T1-6 移交方案的时序裁定），三键与 disposer 同窗落地。
  'prophecy.worldModel', 'autonomousRun.evolution.reset', 'explorationLedger.release',
  'windowDelegate.unset', 'quantum.reset', 'ocr.dispose', 'backend.stop',
];

test('ΠΑΝ-28b①: computeUnloadChecklist 与金名单逐键逐序一致（法定义面锁定）', () => {
  assert.deepEqual(
    [...computeUnloadChecklist()],
    GOLDEN_CHECKLIST,
    '卸载清单漂移 —— 修清单必须同步修本测试（完备性执法的对账锚）',
  );
  assert.equal(new Set(GOLDEN_CHECKLIST).size, GOLDEN_CHECKLIST.length, '键名不得重复');
});

test('ΠΑΝ-28b②: 真实 disposer 执行登记 ≡ 清单（漏接线即红 —— 枚举面变执法面）', async () => {
  const tmp = tmpDir('pan28-parity-');
  const harness = makeFakeCtx();
  await apply(harness.ctx, offlineApplyConfig(tmp));
  assert.equal(lastUnloadActions().length, 0, '卸载前登记簿为空');
  harness.runDisposer();
  assert.deepEqual(
    [...lastUnloadActions()],
    [...computeUnloadChecklist()],
    '清单上有而链上没跑（漏接线），或链上跑了而清单没收录（漏立法）—— 均红',
  );
});

test('ΠΑΝ-28b③: 源级金丝雀 —— 审批归零经登记簿执行且在 checkpoint 落盘之后（C1-1 H4 抗体）', () => {
  const src = readFileSync(INDEX_SRC, 'utf8');
  const disposerStart = src.indexOf('return () => {');
  const disposerEnd = src.indexOf("console.log('[Vision Plugin] Initialization complete!");
  const disposer = src.slice(disposerStart, disposerEnd);
  assert.ok(disposer.length > 1000, '锚定了 disposer 主体段落');
  assert.ok(disposer.includes("runUnloadAction('approval.reset'"), 'ΠΑΝ-28a：审批归零必须经登记簿执行');
  assert.ok(disposer.includes('resetApproval();'), 'resetApproval 生产调用点在卸载链在场');
  // 时序法：审批归零必须晚于 checkpoint 落盘（approvalQueue 是快照段 —— 先清账
  // 再落盘会把队列段写成空档，热重载丢待批条目）。
  assert.ok(
    disposer.indexOf("runUnloadAction('checkpoint.save'") < disposer.indexOf("runUnloadAction('approval.reset'"),
    'approval.reset 必须晚于 checkpoint.save（快照段完整性）',
  );
  assert.ok(
    disposer.indexOf("runUnloadAction('skillLibrary.save'") < disposer.indexOf("runUnloadAction('skillLibrary.reset'"),
    '既有立法不回归：技能先落盘后清内存',
  );
});

// ═══ ΠΑΝ-28a（C1-1 H4）：热重载后审批簿记不存活 ═══

test('ΠΑΝ-28a: 卸载后令牌/确认码通道/Y-10 桶/队列武装全部归零（一次性令牌在会话边界恢复一次性）', async () => {
  const tmp = tmpDir('pan28-approval-');
  const harness = makeFakeCtx();
  await apply(harness.ctx, offlineApplyConfig(tmp));

  // 脏化①：完整 grant 流（带外码经假总线投递 + 捕获）—— 耗一枚 Y-10
  const granted = approval.request('pan28：发送不可逆测试邮件');
  const code = harness.oobCode();
  assert.ok(code && code.confirmCode.length >= 6, '带外码经宿主总线投递并被捕获（通道已武装）');
  assert.equal(approvalBudget(), 3, '起点：Y-10 满桶（容量 3）');
  assert.deepEqual(
    approval.grantDetailed(granted.token, true, { confirmCode: code.confirmCode }),
    { ok: true },
    '码正确 ⇒ 授予成功（消耗一枚 Y-10）',
  );
  assert.equal(approval.status(granted.token).granted, true, '已授予令牌在场');
  assert.equal(approvalBudget(), 2, 'Y-10 已扣 1');
  // 脏化②：第二枚未授予令牌超时入队（stagingTimeoutMs:0 即刻成熟；通道在场）
  const staged = approval.request('pan28：离线暂存测试条目');
  const stageR = approvalQueue.stageAction({
    token: staged.token, description: 'pan28：离线暂存测试条目', stagingTimeoutMs: 0,
  });
  assert.equal(stageR.ok, true, '队列条目入队成功');
  assert.ok(approvalQueue.queueStats().entries >= 1, '队列内存条目在场');
  assert.equal(approvalQueue.queueStats().storageArmed, true, '队列存储已武装（checkpointPath 派生）');
  assert.equal(confirmChannelArmed(), true, '确认码通道闭包在场（绑定旧 ctx）');

  // 卸载（热重载的会话终界）
  harness.runDisposer();

  // 执法：审批全家归零 —— 已授令牌不跨会话存活
  assert.equal(approval.status(granted.token).present, false, 'ΠΑΝ-28a：已授予令牌随卸载清账（修复前：10min TTL 内跨会话可兑现）');
  assert.equal(approval.status(staged.token).present, false, '暂存令牌同律清账');
  assert.equal(confirmChannelArmed(), false, '确认码通道闭包解除（修复前：持已 dispose 的 ctx 继续向死宿主 emit）');
  assert.equal(approvalBudget(), 3, 'Y-10 桶回满（修复前：同意预算跨会话继承）');
  const qs = approvalQueue.queueStats();
  assert.equal(qs.entries, 0, '队列内存条目清空（磁盘档已由 persistQueue+checkpoint 双落盘交棒）');
  assert.equal(qs.storageArmed, false, '队列存储注入解除（下次 apply 的 armApprovalQueue 重装载）');
});

// ═══ ΠΑΝ-29：睡眠/dispose 竞速（单元级 —— runSleepCycle 的 disposeSignal 执法） ═══

/** 最小 journal 桩（水位线可计算：1 条 + 链尖哈希）；onVerify 钩子用于在第①幕中途 abort */
function stubJournal(onVerify?: () => void) {
  return {
    list: (_actionOnly?: boolean) => [
      { ts: 1, tool: 'take_screenshot', args: {}, status: 'SUCCESS', hash: 'abcdef0123456789ffff' },
    ],
    verify: () => {
      onVerify?.();
      return { ok: true, length: 1, brokenAt: null };
    },
    currentTask: () => 'pan29-test',
  };
}

test('ΠΑΝ-29①: 第①幕后中止 ⇒ 幕②起零依赖调用、晨报不记 ok、不带水印、水位线不前滚', async () => {
  const tmp = tmpDir('pan29-unit-');
  const trace = join(tmp, 'sleep-trace.jsonl');
  const distillCalls: string[] = [];
  const signal = { aborted: false };
  // 模拟组合根时序：触发睡眠（第①幕同步消化）→ 同步 abort → disposer 复位一切
  const r1 = await runSleepCycle(
    {
      journal: stubJournal(() => { signal.aborted = true; }), // 第①幕 verify 时即中止（组合根「触发后同步 abort」的单元化）
      skillLibrary: {
        induceFromJournal: () => { distillCalls.push('distill'); return null; },
      },
      log: () => { /* 静音 */ },
    },
    { sleepTracePath: trace, disposeSignal: signal },
  );
  // 第①幕真消化（reset 前同步完成），幕②起被信号掐断且零依赖调用
  assert.equal(r1.acts[0].name, 'replay');
  assert.equal(r1.acts[0].status, 'ok', '第①幕在中止前同步消化（链结算保留）');
  for (const name of ['distill', 'immune', 'calibrate', 'audit']) {
    const act = r1.acts.find(a => a.name === name);
    assert.equal(act?.status, 'timeout', `${name} 被卸载信号掐断`);
    assert.ok(act?.detail?.includes('卸载信号'), `${name} 注记中断原因（诚实标注，不记 ok）`);
  }
  assert.equal(distillCalls.length, 0, '蒸馏幕零依赖调用 —— 不消费已复位的空账本（伪消化杜绝）');
  assert.equal(r1.timeout, true, '半程报告标志位');
  assert.equal(r1.watermark, null, '中断睡不申报指纹（未完成 ≠ 已消化）');
  // 晨报行：不带水印 + interrupted 注记（readTail 跳过无水印行 ⇒ 不毒化幂等账）
  const lines = readFileSync(trace, 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]) as { watermark?: unknown; interrupted?: boolean; timeout?: boolean };
  assert.equal(last.watermark, undefined, '中断晨报行不带水位线（磁盘面不前滚）');
  assert.equal(last.interrupted, true, '中断注记在案');
  assert.equal(last.timeout, true, '晨报行 timeout 旗（不得记 ok）');

  // 水位线不前滚的幂等性证明：同状态二睡必须是实睡（若 r1 已记账则会 noop）
  const r2 = await runSleepCycle(
    {
      journal: stubJournal(),
      skillLibrary: {
        induceFromJournal: () => { distillCalls.push('distill2'); return null; },
      },
      log: () => { /* 静音 */ },
    },
    { sleepTracePath: trace },
  );
  assert.notEqual(r2.acts[0].status, 'noop', '中断睡未记账 —— 同状态二睡实睡（宁可重复归纳不可漏睡）');
  assert.ok(distillCalls.includes('distill2'), '二睡真实消化（修复前：noop 跳过 ⇒ 蒸馏永久丢失）');
});

test('ΠΑΝ-29②: 零漂移 —— 无 disposeSignal 时既有行为逐字节保持（水位线照常前滚、二睡 noop）', async () => {
  const tmp = tmpDir('pan29-drift-');
  const trace = join(tmp, 'sleep-trace.jsonl');
  const deps = {
    journal: stubJournal(),
    skillLibrary: { induceFromJournal: () => null },
    log: () => { /* 静音 */ },
  };
  const r1 = await runSleepCycle(deps, { sleepTracePath: trace });
  assert.ok(
    r1.acts.slice(0, 5).every(a => a.status === 'ok' || a.status === 'skipped'),
    '维护五幕无 timeout/error（无信号 ⇒ 旧语义；deps 缺席面诚实 skipped）',
  );
  assert.equal(r1.acts[5].status, 'ok', '晨报幕照常 ok');
  assert.equal(typeof r1.watermark, 'string', '正常睡照常申报指纹');
  const r2 = await runSleepCycle(deps, { sleepTracePath: trace });
  assert.ok(r2.acts.every(a => a.status === 'noop'), '同状态二睡 noop（幂等水位线律不变）');
});

// ═══ ΠΑΝ-29：睡眠/dispose 竞速（组合根级 —— 卸载链与睡眠周期的真实接线） ═══

test('ΠΑΝ-29③: 组合根卸载竞速 —— disposer 同步复位后睡眠微任务按信号收尾（晨报诚实、水印缺席）', async () => {
  const tmp = tmpDir('pan29-root-');
  const trace = join(tmp, 'sleep-trace.jsonl');
  const harness = makeFakeCtx();
  await apply(harness.ctx, offlineApplyConfig(tmp, {
    enableSleepCycle: true,
    sleepTracePath: trace,
  }));
  // 会话账本非空（水位线可计算；否则 '0:empty' 的 noop 语义会掩盖竞速）
  await journal.append({ ts: Date.now(), tool: 'take_screenshot', args: {}, status: 'SUCCESS' });

  harness.runDisposer(); // 同步跑完全部 reset（睡眠微任务此刻被挂起）
  // 让微任务结算（中断睡收尾极快：幕②起全被信号掐断、梦幕跳过 —— 无 2s 等待）
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));

  const lines = readFileSync(trace, 'utf8').trim().split('\n');
  assert.ok(lines.length >= 1, '中断晨报行已落盘（诚实标注被打断）');
  const last = JSON.parse(lines[lines.length - 1]) as {
    watermark?: unknown; interrupted?: boolean; timeout?: boolean;
    acts?: Array<{ name: string; status: string; detail?: string }>;
  };
  assert.equal(last.interrupted, true, '卸载竞速被如实标注（修复前：消费空账本后记 ok）');
  assert.equal(last.timeout, true, '晨报不得记 ok');
  assert.equal(last.watermark, undefined, '水位线不前滚（修复前：空消化被记账 ⇒ 下次加载 noop 跳过、蒸馏永久丢失）');
  const distill = last.acts?.find(a => a.name === 'distill');
  assert.equal(distill?.status, 'timeout', '蒸馏幕被信号掐断（journal/skillLibrary 已被 disposer 复位 —— 不得消费）');
  assert.ok(distill?.detail?.includes('卸载信号'), '掐断原因注记在案');
  const replay = last.acts?.find(a => a.name === 'replay');
  assert.equal(replay?.status, 'ok', '第①幕在复位前同步消化（链结算的真实价值保留）');
});

// ═══ ΤΕΛ-10（D-G31 三单例归零缝收口 · T1-6 移交方案）═══
// prophecyWorldModel / tools-autonomousRun EXP4 单例 / autonomy explorationLedger
// 三条「已知无归零缝的残留」（F1-8 登记）入册归零的执法面：源级金丝雀（三键经
// 登记簿执行 + 真实调用点在场 + 晚于 checkpoint.save 的时序裁定）+ 模块面行为
// （重铸回无知 / pilot 域清共享域留）。清单≡执行律由 28b①/② 随金名单同步执法。

test('ΤΕΛ-10①: 源级金丝雀 —— 三单例归零键经登记簿执行、真实调用点在场、晚于 checkpoint.save', () => {
  const src = readFileSync(INDEX_SRC, 'utf8');
  const disposerStart = src.indexOf('return () => {');
  const disposerEnd = src.indexOf("console.log('[Vision Plugin] Initialization complete!");
  const disposer = src.slice(disposerStart, disposerEnd);
  const keys = ['prophecy.worldModel', 'autonomousRun.evolution.reset', 'explorationLedger.release'];
  for (const key of keys) {
    assert.ok(disposer.includes(`runUnloadAction('${key}'`), `ΤΕΛ-10：${key} 必须经登记簿执行（旁路裸调用破坏清单≡执行律）`);
  }
  assert.ok(disposer.includes('resetProphecyWorldModel();'), 'prophecy 重铸面真实调用点在卸载链');
  assert.ok(disposer.includes('resetAutonomousRunEvolution();'), 'EXP4 进化单例重置面真实调用点在卸载链');
  assert.ok(disposer.includes('releaseAllExplorationLedgers();'), '探索账本全域释放面真实调用点在卸载链');
  // T1-6 移交方案的时序裁定：checkpoint.save 之后（vlmMeter.reset 同族殿后段，
  // 纯内存会话簿记零持久化依赖 —— 但若未来 prophecy 世界模型接持久化，此序法
  // 保证快照先落盘后归零）。
  const cp = disposer.indexOf("runUnloadAction('checkpoint.save'");
  for (const key of keys) {
    assert.ok(cp < disposer.indexOf(`runUnloadAction('${key}'`), `${key} 必须晚于 checkpoint.save`);
  }
  // 模块面冒烟：三个面直接调用绝不抛（自带契约）。
  resetProphecyWorldModel();
  resetAutonomousRunEvolution();
  releaseAllExplorationLedgers();
});

test('ΤΕΛ-10②: prophecy 重铸面 —— observe 入账 ⇒ predict 有知；重铸 ⇒ 回到诚实无知', () => {
  resetProphecyWorldModel(); // 起点归零（隔离先前用例/生产路径可能的脏化）
  assert.equal(prophecyWorldModel.observe('tel10-t1', 'tel10-act', 'tel10-t2', true).ok, true, '观察一次状态转移入账');
  const before = prophecyWorldModel.predict('tel10-t1', 'tel10-act');
  assert.ok(before.ok && before.value !== null, '重铸前：模型有知（转移分布非 null）');
  resetProphecyWorldModel();
  const after = prophecyWorldModel.predict('tel10-t1', 'tel10-act');
  assert.ok(after.ok && after.value === null, '重铸后：活绑定读新实例，回到诚实无知');
});

test('ΤΕΛ-10③: explorationLedger 全域释放 —— pilot 域清、共享域留（ΠΑΝ-60 语义）', () => {
  // 铸两个域：pilot 域（pilotId 非空）+ 共享域（pilotId 缺席 ''）。
  // enableProphecy:false 旁路 counterfactual 接线副作用（最小污染铸栈）。
  buildAutonomyStack(makeConfig({ enableExploration: true, enableProphecy: false }), { pilotId: 'tel10-pilot-a' });
  buildAutonomyStack(makeConfig({ enableExploration: true, enableProphecy: false }), {});
  const first = releaseAllExplorationLedgers();
  assert.ok(first >= 1, `pilot 域被释放（释放数 ${first} ≥ 1）`);
  assert.equal(releaseAllExplorationLedgers(), 0, '共享域不释放（二次调用零释放 —— ΠΑΝ-60：共享域与进程同尽，run 级状态由下次铸栈自归零）');
});
