// test/w2recovery.test.ts
// W2-5（R5 恢复策略疗效归因）：恢复回合划定 / Beta 疗效账 / 冷启动门控 /
// 原子持久化与垃圾恢复 / 三元组独立记账 / 熔断器接线。
//
// 全离线确定性：事件流直接注入（零真实截图/鼠标/服务），无 RNG、无墙钟依赖
//（回合判定是纯下标状态机）；持久化走临时目录。锁死的内容：
//   1. 回合划定三态：成功闭合 / 超窗 timeout / 流尽 open（窗外成功不算）
//   2. Beta(1,1) 后验数值（手算小例：1/3 与 2/3）
//   3. n<5 固定冷启动梯子（与熔断器历史递进提示逐字节等价）、n≥5 后验均值动态排序
//   4. 持久化往返（tmp+fsync+rename 原子性、无 .tmp 残留）与垃圾格防御恢复
//   5. (症候 × 根因 × 动作) 三元组独立记账
//   6. circuitBreakerGuard 接线：失败/成功/熔断事件喂入 + 提示消费疗效排序
//   7. ΝΩ-7：CUSUM 序贯漂移臂（慢漂移熔断 / 恢复臂提前解除 / 探针预算复熔）
//      + 疗效账去污（拦截不计失败尝试的计数断言）
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RecoveryEfficacy,
  recoveryEfficacy,
  demarcateRecoveryEpisodes,
  classifySyndromeSignature,
  classifyRecoveryAction,
  recoveryPosteriorMean,
  recoveryEventsFromJournal,
  RECOVERY_WINDOW_DEFAULT,
} from '../src/recoveryEfficacy.ts';
import {
  RECOVERY_ACTION_IDS,
  RECOVERY_COLD_LADDER,
  ROOT_CAUSE_LADDER,
  recoveryLadderFor,
  parseRecoveryAction,
  parseRootCause,
  ROOT_CAUSE_IDS,
} from '../src/diagnosis.ts';
import { registerCircuitBreakerGuard, RECOVERY_HINT_TEXT, posteriorTripProbability } from '../src/guards/circuitBreakerGuard.ts';
import { failureMemory } from '../src/failureMemory.ts';

// ─── 测试基建 ───

/** 失败事件（症状 'screen did not change' ⇒ 症候签名 no-world-effect） */
const FAIL_NOEFFECT = { kind: 'failure', tool: 'click_mouse', symptom: 'FAILED: screen did not change' } as const;
const OK = (tool: string) => ({ kind: 'success', tool }) as const;
const FAIL = (tool: string, symptom = 'FAILED: screen did not change') =>
  ({ kind: 'failure', tool, symptom }) as const;

/** 一册完整小回合：失败开回合 → zoom 尝试败 → hotkey 尝试胜（闭合 recovered） */
function seedEpisode(
  ef: RecoveryEfficacy,
  rootCause?: string,
  symptom = 'FAILED: screen did not change',
): void {
  ef.ingest({ kind: 'failure', tool: 'click_mouse', symptom, ...(rootCause ? { rootCause } : {}) });
  ef.ingest({ kind: 'failure', tool: 'zoom_inspect', symptom });
  ef.ingest({ kind: 'success', tool: 'press_hotkey' });
}

// 假 ctx（守卫挂载面）—— pre/post 双事件
function fakeCtx() {
  const handlers: Array<{ event: string; handler: (e: any, r: any, next: any) => any }> = [];
  return {
    handlers,
    on(event: string, handler: any) { handlers.push({ event, handler }); return () => {}; },
  } as any;
}
const exec = (name: string, args: Record<string, unknown> = {}) =>
  ({ name, arguments: args, agent: { id: 'w2-5-test' }, token: {}, rootCallId: 'c1' });
const FAILED_RESULT = { isError: false, value: '{\n  "status": "FAILED",\n  "state_anchor": {},\n  "next_step": "screen did not change, re-aim"\n}' };
const SUCCESS_RESULT = { isError: false, value: '{\n  "status": "SUCCESS",\n  "state_anchor": {}\n}' };

async function drivePost(ctx: any, e: any, result: any): Promise<any> {
  const h = ctx.handlers.find((r: any) => r.event === 'tools/post-execute')!;
  return h.handler(e, result, async (v: any) => v);
}
async function drivePre(ctx: any, e: any): Promise<any> {
  const h = ctx.handlers.find((r: any) => r.event === 'tools/pre-execute')!;
  return h.handler(e, async () => 'allowed');
}
const hintOf = (resultJson: string): string => JSON.parse(resultJson).recovery_hint;
void hintOf; // 保留给后续端到端消费方（hooks 包装层当前丢弃 next 实参——见接线节注）

beforeEach(() => {
  failureMemory.reset();
  recoveryEfficacy.reset();
});

// ─── 1. 回合划定（纯状态机：成功闭合 / 超窗 / 无恢复 / 窗外成功）───

test('W2-5 回合划定: 窗内首个成功 ⇒ recovered 闭合；其后成功不属任何回合', () => {
  const eps = demarcateRecoveryEpisodes([
    FAIL_NOEFFECT,        // 0 开回合
    FAIL('zoom_inspect'), // 1 尝试败（可记名）
    OK('press_hotkey'),   // 2 首个成功 ⇒ 闭合
    OK('click_mouse'),    // 3 无回合 ⇒ 忽略
  ]);
  assert.equal(eps.length, 1, '恰好一个回合');
  const ep = eps[0];
  assert.equal(ep.outcome, 'recovered');
  assert.equal(ep.openIndex, 0);
  assert.equal(ep.closeIndex, 2);
  assert.equal(ep.syndrome, 'no-world-effect', '症状 "did not change" ⇒ 无世界效果症候');
  assert.deepEqual(ep.observations, [
    { tool: 'zoom_inspect', action: 'zoom-refine', success: false },
    { tool: 'press_hotkey', action: 'switch-modality', success: true },
  ]);
});

test('W2-5 回合划定: N 动作窗耗尽无成功 ⇒ timeout 闭合（窗外成功不算数）', () => {
  const events = [
    FAIL_NOEFFECT, // 0 开回合（默认窗 N=5）
    FAIL('zoom_inspect'), FAIL('zoom_inspect'), FAIL('zoom_inspect'),
    FAIL('zoom_inspect'), FAIL('zoom_inspect'), // 1-5 五次尝试耗尽窗口
    OK('press_hotkey'), // 6 窗外成功 ⇒ 无回合在场，忽略
  ];
  const eps = demarcateRecoveryEpisodes(events);
  assert.equal(eps.length, 1, '窗外成功不开新回合、不闭合旧回合');
  assert.equal(eps[0].outcome, 'timeout');
  assert.equal(eps[0].closeIndex, 5, '第 N 个动作位闭合');
  assert.equal(eps[0].observations.length, 5);
  assert.ok(eps[0].observations.every(o => !o.success), '全部尝试记失败观察');
  assert.equal(RECOVERY_WINDOW_DEFAULT, 5, '默认窗口 N=5');
});

test('W2-5 回合划定: 窗口=1 时第二事件即超窗；其后成功被忽略', () => {
  const eps = demarcateRecoveryEpisodes([FAIL_NOEFFECT, FAIL('zoom_inspect'), OK('press_hotkey')], 1);
  assert.equal(eps.length, 1);
  assert.equal(eps[0].outcome, 'timeout');
  assert.equal(eps[0].closeIndex, 1, '窗=1：第一个后续动作即耗尽');
  // 成功事件（下标 2）在无回合时被忽略 —— demarcate 结果已无第二个回合
});

test('W2-5 回合划定: 流尽而窗未满 ⇒ open 如实上报（不虚构结局）', () => {
  const eps = demarcateRecoveryEpisodes([FAIL_NOEFFECT, FAIL('zoom_inspect')]);
  assert.equal(eps.length, 1);
  assert.equal(eps[0].outcome, 'open');
  assert.equal(eps[0].closeIndex, null);
  assert.equal(eps[0].observations.length, 1);
});

test('W2-5 回合划定: 回合闭合后新失败开新回合；窗内失败是尝试不是新回合', () => {
  const eps = demarcateRecoveryEpisodes([
    FAIL_NOEFFECT, OK('press_hotkey'),   // 回合 1：recovered
    FAIL_NOEFFECT, FAIL('zoom_inspect'), // 回合 2：开 + 尝试
  ]);
  assert.equal(eps.length, 2);
  assert.equal(eps[0].outcome, 'recovered');
  assert.equal(eps[1].outcome, 'open');
  assert.equal(eps[1].openIndex, 2, '新失败在旧回合闭合后才开新回合');
});

test('W2-5 回合划定: 熔断事件可开回合（guard-blocked 症候）', () => {
  const eps = demarcateRecoveryEpisodes([
    { kind: 'failure', tool: 'click_mouse', symptom: 'circuit-breaker: 3 consecutive failures triggered a forced pause' },
    OK('take_screenshot'),
  ]);
  assert.equal(eps.length, 1);
  assert.equal(eps[0].syndrome, 'guard-blocked');
  assert.equal(eps[0].outcome, 'recovered');
  assert.deepEqual(eps[0].observations, [
    { tool: 'take_screenshot', action: 're-observe', success: true },
  ]);
});

test('W2-5 回合划定: 不可判定事件消耗窗位但不产生观察；垃圾事件绝不抛', () => {
  const eps = demarcateRecoveryEpisodes([
    FAIL_NOEFFECT,
    { kind: 'unknown', tool: 'click_element' },
    undefined, null, 'garbage', { kind: 'bogus', tool: {} },
  ]);
  assert.equal(eps.length, 1);
  assert.equal(eps[0].outcome, 'timeout', '垃圾/不可判定事件照样消耗窗口');
  assert.equal(eps[0].observations.length, 0, '无可记名观察');
  assert.equal(eps[0].unclassifiedActions, 5);
  assert.doesNotThrow(() => demarcateRecoveryEpisodes([undefined, 42, { kind: 'failure' }] as any[]));
});

// ─── 2. Beta(1,1) 后验数值（手算小例）───

test('W2-5 Beta 账: 手算 —— zoom 1 败 ⇒ 均值 1/3；hotkey 1 胜 ⇒ 均值 2/3', () => {
  const ef = new RecoveryEfficacy();
  assert.equal(ef.ingest(FAIL_NOEFFECT), null, '开回合不闭合');
  assert.equal(ef.ingest(FAIL('zoom_inspect')), null, '尝试败不闭合');
  const closed = ef.ingest(OK('press_hotkey'));
  assert.ok(closed, '首个成功闭合回合');
  assert.equal(closed!.outcome, 'recovered');

  // Beta(1,1) 先验 + 1 败 ⇒ Beta(1,2)：均值 1/3
  const zoom = ef.cell('no-world-effect', 'unknown', 'zoom-refine')!;
  assert.deepEqual(
    { s: zoom.successes, f: zoom.failures },
    { s: 0, f: 1 },
    'zoom-refine 记 0 胜 1 败',
  );
  // Beta(1,1) + 1 胜 ⇒ Beta(2,1)：均值 2/3
  const hotkey = ef.cell('no-world-effect', 'unknown', 'switch-modality')!;
  assert.deepEqual({ s: hotkey.successes, f: hotkey.failures }, { s: 1, f: 0 });

  const snap = ef.snapshot();
  const zoomCell = snap.cells.find(c => c.action === 'zoom-refine')!;
  const hotkeyCell = snap.cells.find(c => c.action === 'switch-modality')!;
  // 快照均值按 1e-6 舍入（可读性）—— 容差取半个舍入区间
  assert.ok(Math.abs(zoomCell.posteriorMean - 1 / 3) < 5.1e-7, `zoom 均值 1/3（实得 ${zoomCell.posteriorMean}）`);
  assert.ok(Math.abs(hotkeyCell.posteriorMean - 2 / 3) < 5.1e-7, `hotkey 均值 2/3（实得 ${hotkeyCell.posteriorMean}）`);
  assert.deepEqual(snap.totals, { recovered: 1, timedOut: 0, observations: 2 });
  // 纯函数直检：(0+1)/(0+1+2) 与 (1+1)/(1+0+2)
  assert.ok(Math.abs(recoveryPosteriorMean(0, 1) - 1 / 3) < 1e-12);
  assert.ok(Math.abs(recoveryPosteriorMean(1, 0) - 2 / 3) < 1e-12);
  assert.equal(recoveryPosteriorMean(0, 0), 0.5, '零观察 = 均匀先验均值');
});

// ─── 3. 样本闸：n<5 固定冷启动梯子 / n≥5 后验均值动态排序 ───

test('W2-5 样本闸: n<5 ⇒ 冷启动梯子（1 败教放大、2 败教换模态）', () => {
  const ef = new RecoveryEfficacy();
  assert.deepEqual(
    ef.prescriptionOrder('no-world-effect', 'unknown').slice(0, 2),
    ['zoom-refine', 'switch-modality'],
    '零样本 ⇒ 固定梯子打头',
  );
  seedEpisode(ef); seedEpisode(ef); // n = 2+2 = 4 < 5
  assert.deepEqual(
    ef.prescriptionOrder('no-world-effect', 'unknown').slice(0, 2),
    ['zoom-refine', 'switch-modality'],
    'n=4 仍冷启动 —— 证据不足不改排序',
  );
});

test('W2-5 样本闸: n≥5 ⇒ 后验均值降序（hotkey 3 胜 4/5 居首）', () => {
  const ef = new RecoveryEfficacy();
  for (let i = 0; i < 3; i++) seedEpisode(ef); // zoom f=3（均值 1/5）、hotkey s=3（均值 4/5），n=6
  const order = ef.prescriptionOrder('no-world-effect', 'unknown');
  assert.equal(order.length, RECOVERY_ACTION_IDS.length, '全序返回（消费方按下标取）');
  assert.equal(order[0], 'switch-modality', '后验 4/5 居首');
  // 未探索动作落回均匀先验 0.5 —— 排在实证坏动作（zoom 1/5）之前：后验均值
  // 排序的诚实探索语义（确证无效者沉底，未知者保持乐观）
  assert.equal(order[1], 're-observe', '零观察 = 先验 0.5 居次（梯子平手序）');
  assert.equal(order[order.length - 1], 'zoom-refine', '实证 1/5 的动作沉底');
});

// ─── 4. 三元组独立记账（症候 × 根因 × 动作）───

test('W2-5 三元组独立: 根因轴与症候轴分册 —— 互不串账、互不串门控', () => {
  const ef = new RecoveryEfficacy();
  // 语境 A（no-world-effect × unknown）攒足 n=6 ⇒ 动态
  for (let i = 0; i < 3; i++) seedEpisode(ef);
  // 语境 B（no-world-effect × blind-spot-text）仅 n=2 ⇒ 冷启动
  seedEpisode(ef, 'blind-spot-text');
  seedEpisode(ef, 'blind-spot-text');
  // 语境 C（target-not-found × unknown）零样本 ⇒ 冷启动
  assert.equal(ef.prescriptionOrder('no-world-effect', 'unknown')[0], 'switch-modality', 'A 册动态');
  assert.equal(ef.prescriptionOrder('no-world-effect', 'blind-spot-text')[0], 'zoom-refine', 'B 册仍冷启动');
  assert.equal(ef.prescriptionOrder('target-not-found', 'unknown')[0], 'zoom-refine', 'C 册冷启动');
  // 分册不串账：B 册的 zoom 败与 A 册的 zoom 败分开记
  const aZoom = ef.cell('no-world-effect', 'unknown', 'zoom-refine')!;
  const bZoom = ef.cell('no-world-effect', 'blind-spot-text', 'zoom-refine')!;
  assert.deepEqual({ s: aZoom.successes, f: aZoom.failures }, { s: 0, f: 3 });
  assert.deepEqual({ s: bZoom.successes, f: bZoom.failures }, { s: 0, f: 2 });
});

// ─── 5. 持久化：原子落盘 + 防御恢复 ───

test('W2-5 持久化: 往返无损 + tmp+fsync+rename 原子性（无 .tmp 残留）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'w2rec-'));
  try {
    const p = join(dir, 'efficacy.json');
    const ef1 = new RecoveryEfficacy();
    seedEpisode(ef1);
    const r = ef1.persist(p);
    assert.equal(r.ok, true);
    assert.equal(r.cells, 2);
    assert.ok(!existsSync(p + '.tmp'), '原子换名后无 tmp 残留');
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.cells.length, 2);

    const ef2 = new RecoveryEfficacy();
    const rr = ef2.restore(p);
    assert.deepEqual({ ok: rr.ok, restored: rr.restored, dropped: rr.dropped }, { ok: true, restored: 2, dropped: 0 });
    assert.deepEqual(ef2.cell('no-world-effect', 'unknown', 'zoom-refine'), ef1.cell('no-world-effect', 'unknown', 'zoom-refine'));
    // 恢复后继续记账：再一册回合 ⇒ zoom 败 +1（从恢复值续账，不归零）
    seedEpisode(ef2);
    assert.equal(ef2.cell('no-world-effect', 'unknown', 'zoom-refine')!.failures, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('W2-5 持久化: 垃圾格弃置归先验（不连坐整档）+ 坏档/缺档不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'w2rec-g-'));
  try {
    const p = join(dir, 'bad.json');
    writeFileSync(p, JSON.stringify({
      version: 1,
      cells: [
        { syndrome: 'no-world-effect', rootCause: 'unknown', action: 'zoom-refine', successes: 2, failures: 1 }, // 好
        { syndrome: 'bogus-syndrome', rootCause: 'unknown', action: 'zoom-refine', successes: 1, failures: 0 }, // 症候轴垃圾 ⇒ 弃（归桶会混册）
        { syndrome: 'no-world-effect', rootCause: 'no-such-cause', action: 'zoom-refine', successes: 1 },        // 根因轴垃圾 ⇒ 弃
        { syndrome: 'no-world-effect', rootCause: 'unknown', action: 'nope', successes: 1, failures: 0 },        // 动作轴垃圾 ⇒ 弃
        { syndrome: 'no-world-effect', rootCause: 'unknown', action: 're-observe', successes: -3, failures: 0 }, // 负计数 ⇒ 弃
        { syndrome: 'no-world-effect', rootCause: 'unknown', action: 're-observe', successes: 'x', failures: 0 },// 非数值 ⇒ 弃
        'garbage', null, 42, { no: 'fields' },                                                                    // 非对象 ⇒ 弃
      ],
    }), 'utf8');
    const ef = new RecoveryEfficacy();
    const rr = ef.restore(p);
    assert.equal(rr.ok, true, '部分好格 ⇒ 整档仍可恢复');
    assert.equal(rr.restored, 1, '仅 1 格合法');
    assert.equal(rr.dropped, 9, '垃圾格 9 弃置（归先验不连坐）');
    // 弃置格 = 回到先验（null —— 由消费方以 Beta(1,1) 解读）
    assert.equal(ef.cell('no-world-effect', 'unknown', 're-observe'), null);

    // 完全坏档 / 缺档：绝不抛，返回 {ok:false}
    const pBad = join(dir, 'broken.json');
    writeFileSync(pBad, '{not json', 'utf8');
    assert.equal(ef.restore(pBad).ok, false);
    writeFileSync(join(dir, 'num.json'), '42', 'utf8');
    assert.equal(ef.restore(join(dir, 'num.json')).ok, false);
    assert.equal(ef.restore(join(dir, 'missing.json')).ok, false);
    assert.doesNotThrow(() => ef.restore(''));
    assert.doesNotThrow(() => ef.persist(''));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('W2-5 持久化: setPersistence ⇒ 回合闭合时自动原子落盘；reset 归零', () => {
  const dir = mkdtempSync(join(tmpdir(), 'w2rec-auto-'));
  try {
    const p = join(dir, 'auto.json');
    const ef = new RecoveryEfficacy();
    ef.setPersistence(p);
    ef.ingest(FAIL_NOEFFECT);           // 开回合：不落盘（事件级 fsync 太碎）
    assert.ok(!existsSync(p), '回合未闭合不落盘');
    ef.ingest(OK('press_hotkey'));      // 闭合 ⇒ 落盘
    assert.ok(existsSync(p), '回合闭合自动落盘');
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(raw.cells.length, 1, '只记 switch-modality 一格');

    ef.reset();
    assert.deepEqual(ef.snapshot().cells, []);
    assert.deepEqual(ef.snapshot().totals, { recovered: 0, timedOut: 0, observations: 0 });
    assert.equal(ef.prescriptionOrder('no-world-effect', 'unknown')[0], 'zoom-refine', '归零后回冷启动');
    ef.setPersistence(p); // reset 清空路径配置 —— 重设后仍可自动落盘
    seedEpisode(ef);
    assert.ok(existsSync(p));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 6. 分类器（纯函数）───

test('W2-5 分类器: 工具 → 规范动作；垃圾 ⇒ null', () => {
  assert.equal(classifyRecoveryAction('zoom_inspect'), 'zoom-refine');
  assert.equal(classifyRecoveryAction('press_hotkey'), 'switch-modality');
  assert.equal(classifyRecoveryAction('scroll_page'), 'switch-modality');
  assert.equal(classifyRecoveryAction('recall_ui'), 'switch-modality');
  assert.equal(classifyRecoveryAction('take_screenshot'), 're-observe');
  assert.equal(classifyRecoveryAction('diff_view'), 're-observe');
  assert.equal(classifyRecoveryAction('find_text'), 'ground-target');
  assert.equal(classifyRecoveryAction('probe_interactivity'), 'ground-target');
  assert.equal(classifyRecoveryAction('click_mouse'), null, '原动作不在恢复词汇内');
  assert.equal(classifyRecoveryAction(''), null);
  assert.equal(classifyRecoveryAction(42 as any), null);
});

test('W2-5 分类器: 症候签名 —— 首中即断的关键词序 + 工具族缺省', () => {
  assert.equal(classifySyndromeSignature('circuit-breaker: tripped'), 'guard-blocked');
  assert.equal(classifySyndromeSignature('FAILED: element not found'), 'target-not-found');
  assert.equal(classifySyndromeSignature('FAILED: screen did not change'), 'no-world-effect');
  assert.equal(classifySyndromeSignature('FAILED: text mismatch with expected'), 'verification-mismatch');
  assert.equal(classifySyndromeSignature('FAILED: request timeout'), 'stall-timeout');
  assert.equal(classifySyndromeSignature('', 'find_text'), 'target-not-found', '症状缺席 ⇒ 感知工具族先验');
  assert.equal(classifySyndromeSignature('', 'click_mouse'), 'generic-failure');
  assert.equal(classifySyndromeSignature(undefined, 42), 'generic-failure', '垃圾入参 ⇒ 兜底粗桶');
});

// ─── 7. diagnosis 增量：恢复动作词汇与先验梯子 ───

test('W2-5 diagnosis 增量: 动作词汇防御解析 + 梯子覆盖全部根因', () => {
  assert.equal(parseRecoveryAction('zoom-refine'), 'zoom-refine');
  assert.equal(parseRecoveryAction('bogus'), null);
  assert.equal(parseRecoveryAction(42), null);
  assert.deepEqual([...RECOVERY_COLD_LADDER], ['zoom-refine', 'switch-modality'], '冷启动 = 历史递进梯子的名词化');
  assert.deepEqual(Object.keys(ROOT_CAUSE_LADDER).sort(), [...ROOT_CAUSE_IDS].sort(), '每个根因都有先验梯子');
  for (const rc of ROOT_CAUSE_IDS) {
    assert.deepEqual([...ROOT_CAUSE_LADDER[rc]].sort(), [...RECOVERY_ACTION_IDS].sort(), `${rc} 梯子是全排列`);
  }
  assert.deepEqual([...recoveryLadderFor('garbage')], [...ROOT_CAUSE_LADDER.unknown], '非法根因 ⇒ unknown 梯子');
  assert.equal(parseRootCause('garbage'), 'unknown');
});

// ─── 8. journal 回放通道 ───

test('W2-5 journal 回放: 行动日志条目 ⇒ 疗效事件流（含 GUARD_BLOCKED 标记）', () => {
  const events = recoveryEventsFromJournal([
    { tool: 'click_mouse', status: 'FAILED', ts: 1 },
    { tool: 'zoom_inspect', status: 'FAILED', ts: 2 },
    { tool: 'press_hotkey', status: 'SUCCESS', ts: 3 },
    { tool: 'get_metrics', status: 'UNKNOWN', ts: 4 },
  ]);
  const eps = demarcateRecoveryEpisodes(events);
  assert.equal(eps.length, 1);
  assert.equal(eps[0].outcome, 'recovered');
  assert.equal(eps[0].observations.length, 2);
  assert.equal(eps[0].openedAt, 1, '墙钟随行（审计面）');

  // 熔断标记（tool='GUARD_BLOCKED'）⇒ 熔断失败事件 ⇒ guard-blocked 症候
  const marker = recoveryEventsFromJournal([
    { tool: 'GUARD_BLOCKED', status: 'MARKER', args: { guard: 'circuit-breaker', reason: 'posterior' } },
    { tool: 'press_hotkey', status: 'SUCCESS', ts: 9 },
  ]);
  const eps2 = demarcateRecoveryEpisodes(marker);
  assert.equal(eps2[0].syndrome, 'guard-blocked');
  assert.equal(eps2[0].outcome, 'recovered');

  assert.deepEqual(recoveryEventsFromJournal([null, 42, 'x'] as any), [], '垃圾条目跳过');
});

// ─── 9. 熔断器接线（注入隔离实例）───
//
// 注：hooks.ts 的 post 包装层以 `() => next()` 转调（实参被丢弃）—— 提示文本
// 在本离线管线不可经返回值观察（既有宿主行为，非本器官领地）。提示选择的
// 验证走组合证明：守卫以 (症候签名, 回读根因) 咨询注入账本的 prescriptionOrder
// （OrderSpy 记录咨询与返回序），返回序 × RECOVERY_HINT_TEXT 映射即所发提示。

/** 咨询哨兵：记录 prescriptionOrder 的每次咨询（语境与返回序） */
class OrderSpy extends RecoveryEfficacy {
  readonly consulted: Array<{ syndrome: string; rootCause: unknown; order: string[] }> = [];
  override prescriptionOrder(syndrome: unknown, rootCause: unknown): import('../src/diagnosis.ts').RecoveryActionId[] {
    const order = super.prescriptionOrder(syndrome, rootCause);
    this.consulted.push({ syndrome: String(syndrome), rootCause, order: [...order] });
    return order;
  }
}

test('W2-5 接线: 冷启动提示与历史递进梯子逐字节等价（n<5）', async () => {
  const spy = new OrderSpy();
  const ctx = fakeCtx();
  registerCircuitBreakerGuard(ctx, 3, spy);

  await drivePost(ctx, exec('click_mouse'), FAILED_RESULT); // 第 1 败
  await drivePost(ctx, exec('click_mouse'), FAILED_RESULT); // 第 2 败

  // 守卫两次咨询疗效表，语境 = (症候签名, 回读根因 undefined ⇒ unknown)
  assert.equal(spy.consulted.length, 2, '每次递进提示都咨询疗效表');
  assert.deepEqual(
    { s: spy.consulted[0].syndrome, r: spy.consulted[0].rootCause },
    { s: 'no-world-effect', r: undefined },
    '咨询语境 = 症候签名 × 回读根因',
  );
  // 冷启动（n<5）⇒ 固定梯子：1 败 zoom / 2 败 modality —— 所发提示逐字节保留
  assert.equal(spy.consulted[0].order[0], 'zoom-refine');
  assert.equal(spy.consulted[1].order[1], 'switch-modality');
  assert.equal(
    RECOVERY_HINT_TEXT['zoom-refine'],
    "Recovery hint: call 'zoom_inspect' around the target to refine coordinates before retrying.",
    '第 1 败教放大 —— 与旧实现逐字节等价',
  );
  assert.equal(
    RECOVERY_HINT_TEXT['switch-modality'],
    'Recovery hint: switch modality — try keyboard navigation via press_hotkey (tab/enter), '
      + "or scroll_page if the target may be off-screen. Also try recall_ui for remembered locations.",
    '第 2 败教换模态 —— 与旧实现逐字节等价',
  );

  // 失败事件已入疗效流（回合 open，症候签名已推导）
  const cur = spy.currentEpisode();
  assert.ok(cur, '失败开回合');
  assert.equal(cur!.syndrome, 'no-world-effect');

  // 成功闭合回合：疗效账入账（click_mouse 不可记名 ⇒ 无观察，但回合闭合计数）
  await drivePost(ctx, exec('click_mouse'), SUCCESS_RESULT);
  assert.equal(spy.snapshot().totals.recovered, 1, '成功闭合回合');
});

test('W2-5 提示面: RECOVERY_HINT_TEXT 覆盖全部恢复动作', () => {
  assert.deepEqual(
    Object.keys(RECOVERY_HINT_TEXT).sort(),
    [...RECOVERY_ACTION_IDS].sort(),
    '每个规范动作都有提示文案（排序消费的下标永不越界）',
  );
});

test('W2-5 接线: n≥5 后提示消费疗效排序（换模态跃居第 1 败提示）', async () => {
  const spy = new OrderSpy();
  for (let i = 0; i < 3; i++) seedEpisode(spy); // (no-world-effect × unknown) n=6，hotkey 4/5 居首
  const ctx = fakeCtx();
  registerCircuitBreakerGuard(ctx, 3, spy);

  await drivePost(ctx, exec('click_mouse'), FAILED_RESULT); // 第 1 败
  await drivePost(ctx, exec('click_mouse'), FAILED_RESULT); // 第 2 败
  assert.equal(spy.consulted[0].order[0], 'switch-modality', '第 1 败咨询的居首动作 = 换模态（4/5）');
  assert.ok(
    RECOVERY_HINT_TEXT['switch-modality'].startsWith('Recovery hint: switch modality'),
    '第 1 败提示动态切换为换模态文案',
  );
  assert.equal(spy.consulted[1].order[1], 're-observe', '第 2 败提示取次序动作（先验 0.5 的梯子平手序）');
});

test('W2-5 接线: 拦截不入疗效流（ΝΩ-7 去污）；未知结果消耗窗位不产观察', async () => {
  const tracker = new RecoveryEfficacy();
  const ctx = fakeCtx();
  registerCircuitBreakerGuard(ctx, 1, tracker);

  await drivePost(ctx, exec('click_mouse'), FAILED_RESULT); // recentFailures=1 = 阈值
  const blocked = await drivePre(ctx, exec('click_mouse'));
  // hooks 包装层把拦截字符串转译为 rc.6 PreToolDecision（deny + reason）
  assert.equal(blocked?.kind, 'deny', '熔断拦截（deny 决策）');
  assert.ok(String(blocked?.reason).includes('Guard Blocked'), '拦截理由随行');
  // ΝΩ-7 疗效账去污：拦截不再 ingest failure —— 回合仍由原始真实失败界定
  //（从熔断事件独立起算的路径由 journal 回放覆盖：GUARD_BLOCKED 标记无配对
  // post，见回放测试；活账只记真实派发结局）
  assert.equal(tracker.currentEpisode()?.syndrome, 'no-world-effect', '回合仍由原始失败界定');

  // 未知结果（无 [Error]/[System]、非 JSON）⇒ unknown 事件：消耗窗位、不产生观察
  await drivePost(ctx, exec('click_element'), { isError: false, value: 'plain opaque text' });
  assert.equal(tracker.snapshot().totals.observations, 0);

  // 成功闭合回合：hotkey 可记名 ⇒ 1 条成功观察；未知事件占一窗位（诚实申报）。
  // ΝΩ-7 计数断言：拦截事件不占窗位（旧实现 = 2：拦截 + 未知各一席）
  await drivePost(ctx, exec('press_hotkey'), SUCCESS_RESULT);
  const snap = tracker.snapshot();
  assert.equal(snap.totals.recovered, 1);
  assert.deepEqual(snap.episodes[0].observations, [
    { tool: 'press_hotkey', action: 'switch-modality', success: true },
  ]);
  assert.equal(snap.episodes[0].unclassifiedActions, 1, '仅未知结果事件占一窗位（拦截零占位）');
});

test('W2-5 接线: 记忆库带回的病因随失败事件入账（根因轴有据）', async () => {
  const tracker = new RecoveryEfficacy();
  const ctx = fakeCtx();
  registerCircuitBreakerGuard(ctx, 3, tracker);
  // 失败 1：开回合（此刻鉴别探针尚未归因 —— 根因诚实 unknown）
  await drivePost(ctx, exec('click_mouse'), FAILED_RESULT);
  await drivePost(ctx, exec('press_hotkey'), SUCCESS_RESULT); // 回合 1 闭合（unknown 册）
  // 模拟 rootCauseGuard 的归因刷新（近重复去重路径写回同一条记录）
  const { rememberFailure } = await import('../src/guards/circuitBreakerGuard.ts');
  rememberFailure('click_mouse', {}, 'FAILED: screen did not change, re-aim', 'blind-spot-text');
  // 失败 2：同路径再败 —— rememberFailure 回读已刷新的病因 ⇒ 开回合事件携带病因
  await drivePost(ctx, exec('click_mouse'), FAILED_RESULT);
  assert.equal(tracker.currentEpisode()?.rootCause, 'blind-spot-text', '回合 2 的根因轴 = 回读病因');
  await drivePost(ctx, exec('press_hotkey'), SUCCESS_RESULT); // 回合 2 闭合
  // 根因分册兑现：blind-spot-text 册记 hotkey 1 胜；unknown 册与它分账
  const b = tracker.cell('no-world-effect', 'blind-spot-text', 'switch-modality')!;
  const u = tracker.cell('no-world-effect', 'unknown', 'switch-modality')!;
  assert.deepEqual({ s: b.successes, f: b.failures }, { s: 1, f: 0 });
  assert.deepEqual({ s: u.successes, f: u.failures }, { s: 1, f: 0 }, '两册各记各的');
});

// ─── 10. ΝΩ-7：CUSUM 序贯漂移臂 + 冷静期半开探针 + 疗效账去污 ───

/** 判决形 drivePre：放行时 next 返回 accept 决策对象（拦截仍转译为 deny + reason）
 *  —— w2recovery 既有 drivePre 的 next 回传字符串会被 toPreDecision 误译 deny。 */
async function drivePreVerdict(ctx: any, e: any): Promise<any> {
  const h = ctx.handlers.find((r: any) => r.event === 'tools/pre-execute')!;
  return h.handler(e, async () => ({ kind: 'accept' }));
}

test('ΝΩ-7 CUSUM 臂: 55% 慢漂移 20 调用脚本触发熔断；同证据旧后验臂不触发', async () => {
  const ctx = fakeCtx();
  registerCircuitBreakerGuard(ctx, 6, new RecoveryEfficacy()); // 连续阈值 6 > 脚本最长败连 3：隔离 CUSUM 臂
  // 慢漂移脚本（20 调用 11 败 = 55%）：前 5 调用健康全胜，后 15 调用渐入热区
  //（11 败 4 胜 ≈ 73%）—— 恶化是渐变的，正是 20 样本后验窗（需 ≳68% 满窗
  // 才够 0.95 线）的盲区段；CUSUM 跨窗累积 LLR，S⁺ 在第 19 次派发后越阈 4
  const outcomes = [
    'S', 'S', 'S', 'S', 'S',
    'F', 'F', 'S', 'F', 'S', 'F', 'F', 'S', 'F', 'F', 'F', 'S', 'F', 'F', 'F',
  ];
  assert.equal(outcomes.length, 20);
  assert.equal(outcomes.filter(o => o === 'F').length, 11, '55% 失败率（11/20）');
  for (let i = 0; i < 19; i++) {
    const v = await drivePreVerdict(ctx, exec('click_mouse'));
    assert.equal(v.kind, 'accept', `第 ${i + 1} 调用放行（S⁺ 尚未越阈）`);
    await drivePost(ctx, exec('click_mouse'), outcomes[i] === 'F' ? FAILED_RESULT : SUCCESS_RESULT);
  }
  const tripped = await drivePreVerdict(ctx, exec('click_mouse'));
  assert.equal(tripped.kind, 'deny', '第 20 调用被 CUSUM 上行臂熔断');
  assert.match(String(tripped.reason), /CUSUM/, '按 CUSUM 臂归因');
  // 对照用例（旧法不触发）：被熔断时刻的真实证据 = 19 派发 10 败 9 胜 ——
  // 旧后验判决 P(失败率>50% | Beta(11,10)) ≈ 0.59，远不够 0.95 线；
  // 连续臂最长败连 3 < 6。任一旧臂都不触发，只有 CUSUM 臂看见这条慢坏路线。
  assert.ok(posteriorTripProbability(10, 9) < 0.95, `旧后验臂不触发（${posteriorTripProbability(10, 9)}）`);
});

test('ΝΩ-7 恢复臂: S⁻ 越下阈提前解除冷静期（4 个探针胜局，早于 6 探针预算）', async () => {
  const ctx = fakeCtx();
  registerCircuitBreakerGuard(ctx, 2, new RecoveryEfficacy());
  // 2 连败 ⇒ 连续臂熔断，进入冷静期（熔断本位拦截）
  for (let i = 0; i < 2; i++) {
    assert.equal((await drivePreVerdict(ctx, exec('click_mouse'))).kind, 'accept', `熔断前第 ${i + 1} 败放行`);
    await drivePost(ctx, exec('click_mouse'), FAILED_RESULT);
  }
  assert.equal((await drivePreVerdict(ctx, exec('click_mouse'))).kind, 'deny', '连续臂熔断');
  // 冷静期半开探针制：探针位放行（真实派发）→ 拦截位 → 探针位 … 交替。
  // 每个探针胜局 S⁻ -= ln(4/7) ≈ 0.560；第 4 个胜局后 S⁻ ≈ -2.238 ≤ -2.0
  // ⇒ 提前解除（预算 6 未耗尽 —— 恢复证据先到）
  for (let probe = 1; probe <= 4; probe++) {
    assert.equal((await drivePreVerdict(ctx, exec('click_mouse'))).kind, 'accept', `探针 ${probe} 放行`);
    await drivePost(ctx, exec('click_mouse'), SUCCESS_RESULT);
    if (probe < 4) {
      assert.equal((await drivePreVerdict(ctx, exec('click_mouse'))).kind, 'deny', `探针 ${probe} 后轮到拦截位`);
    }
  }
  // 提前解除证明：第 4 个探针胜局后（预算仅耗 4 < 6），下一调用是常态放行
  // —— 若只有预算路径，此处仍应是拦截位
  assert.equal((await drivePreVerdict(ctx, exec('click_mouse'))).kind, 'accept', 'S⁻ 提前解除 ⇒ 常态放行');
  assert.equal((await drivePreVerdict(ctx, exec('click_mouse'))).kind, 'accept', '解除后连续常态放行');
});

test('ΝΩ-7 冷静期预算: 无恢复证据 ⇒ 6 个探针结局耗尽才解除；仍坏 ⇒ 连续臂复熔', async () => {
  const ctx = fakeCtx();
  registerCircuitBreakerGuard(ctx, 2, new RecoveryEfficacy());
  for (let i = 0; i < 2; i++) {
    assert.equal((await drivePreVerdict(ctx, exec('click_mouse'))).kind, 'accept');
    await drivePost(ctx, exec('click_mouse'), FAILED_RESULT);
  }
  assert.equal((await drivePreVerdict(ctx, exec('click_mouse'))).kind, 'deny', '熔断');
  // 探针全败：S⁻ 被败局推回 0（min(0,·) 界），永远够不着下阈 —— 只能等
  // 探针预算（6 个真实派发结局）耗尽兜底解除（「非永久锁死」的边界承诺）
  for (let probe = 1; probe <= 6; probe++) {
    assert.equal((await drivePreVerdict(ctx, exec('click_mouse'))).kind, 'accept', `探针 ${probe} 放行`);
    await drivePost(ctx, exec('click_mouse'), FAILED_RESULT);
    if (probe < 6) {
      assert.equal((await drivePreVerdict(ctx, exec('click_mouse'))).kind, 'deny', `探针 ${probe} 后轮到拦截位`);
    }
  }
  // 解除 ≠ 放水：探针全败 ⇒ 复合判据在下一个 pre 立即复熔（两臂同时越线：
  // recentFailures=6 ≥ 2 连续臂 + 探针败局 S⁺ = 6·ln2 ≈ 4.16 ≥ 4 CUSUM 臂 ——
  // 归因按判决链取首个越线臂；CUSUM 升级不削弱既有保护的反向验证）
  const retrip = await drivePreVerdict(ctx, exec('click_mouse'));
  assert.equal(retrip.kind, 'deny', '预算解除后仍坏路线立即复熔');
  assert.match(String(retrip.reason), /CUSUM arm|consecutive failures/, '复熔按复合判据归因');
});

test('ΝΩ-7 疗效账去污: 拦截不计失败尝试 —— 不入格、不占窗位、不开幽灵回合', async () => {
  // 场景 1：回合在场时被拦截的恢复动作（zoom_inspect）不得记成失败观察
  //（旧实现：拦截 ingest failure + 工具可记名 ⇒ zoom-refine 记 1 败 —— 教坏处方排序）
  const tracker = new RecoveryEfficacy();
  const ctx = fakeCtx();
  registerCircuitBreakerGuard(ctx, 1, tracker);
  await drivePost(ctx, exec('click_mouse'), FAILED_RESULT); // 真实失败：开回合（no-world-effect）
  const blocked = await drivePreVerdict(ctx, exec('zoom_inspect')); // 熔断拦截一个恢复动作
  assert.equal(blocked.kind, 'deny', '恢复动作在熔断位被拦截（从未执行）');
  await drivePost(ctx, exec('press_hotkey'), SUCCESS_RESULT); // 真实成功：闭合回合
  const snap = tracker.snapshot();
  assert.equal(snap.totals.recovered, 1);
  assert.deepEqual(snap.episodes[0].observations, [
    { tool: 'press_hotkey', action: 'switch-modality', success: true },
  ], '被拦截的 zoom_inspect 不产生 zoom-refine 失败观察');
  assert.equal(tracker.cell('no-world-effect', 'unknown', 'zoom-refine'), null, '拦截不进任何疗效格');
  assert.equal(snap.episodes[0].unclassifiedActions, 0, '拦截不占回合窗位');

  // 场景 2：回合不在场时的拦截不得开幽灵回合（旧实现：拦截是 failure 事件 ⇒
  // 开幽灵回合，其后的常态成功被误记为一次「恢复」—— 计数断言）
  const tracker2 = new RecoveryEfficacy();
  const ctx2 = fakeCtx();
  registerCircuitBreakerGuard(ctx2, 1, tracker2);
  await drivePost(ctx2, exec('click_mouse'), FAILED_RESULT); // 真实失败：开回合
  assert.equal((await drivePreVerdict(ctx2, exec('click_mouse'))).kind, 'deny', '熔断（本位拦截）');
  assert.equal((await drivePreVerdict(ctx2, exec('click_mouse'))).kind, 'accept', '半开探针位放行');
  await drivePost(ctx2, exec('click_mouse'), SUCCESS_RESULT); // 真实成功：闭合回合 1
  assert.equal((await drivePreVerdict(ctx2, exec('click_mouse'))).kind, 'deny', '拦截位（此刻无回合在场）');
  await drivePost(ctx2, exec('click_mouse'), SUCCESS_RESULT); // 常态成功：无回合 ⇒ 忽略
  const snap2 = tracker2.snapshot();
  assert.equal(snap2.totals.recovered, 1, '只有真实回合闭合一次（拦截不开幽灵回合）');
  assert.equal(snap2.episodes.length, 1, '拦截风暴不膨胀回合册');
});
