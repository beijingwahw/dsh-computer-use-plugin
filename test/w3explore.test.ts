// test/w3explore.test.ts
// W3-7（R2 探索前沿策略 · UCB）：已探索集 + UCB 择路 + autoPilot 注入端口 ——
// 全离线确定性测试（零真钟、零真睡、零网络；failureMemory 单例逐用例隔离）。
// 覆盖（与验收清单一一对应）：
//   R2-1  区域量化：确定性 / 边界夹取 / 垃圾 −1 / 分辨率无关（相对坐标）
//   R2-2  UCB 数值：explorationScore 手算小例（分项逐项对表）
//   R2-3  探索集更新：observe 的 Beta 计数 / 区域聚合账 / payload 预标与现场量化
//   R2-4  UCB 未探索格胜出：尝试过的区域让位，未探索区域夺魁（手算对照）
//   R2-5  交替律：连续建议模态不连打（click → scroll → hotkey）
//   R2-6  负先验降权：failureMemory 命中的区域×模态组合降权且翻转择路
//   R2-7  恢复态触发 / 常态不触发 / 预算红线与内部异常绝不探索 / 双闸（实例+内核）
//   R2-8  持久化往返：原子落盘 + 防御恢复（垃圾格弃置 / 他账拒收 / 版本不符 /
//         坏档）+ 自动节流落盘 + 会话边界（归零 / 恢复）可配
//   R2-9  开关关闭零回归：端口缺席 / {enabled:false} / 建议为 null ⇒ 升级路径
//         逐字节不变
//   R2-10 集成：真实账本进环 —— 探索动作替代升级步、journal 注记、总汇报记账、
//         observe 全流回报、探索预算耗尽后回归升级终局
//   R2-11 防御：垃圾入参绝不抛（advise/observe/quantize/端口抛异常不炸环）
//   R22   容量驱逐复杂度（ΑΩ-R22：懒最小堆索引）：大账本驱逐与旧判据（全扫
//         min-lru）差分逐格一致 / 索引与主账本同步（插入·恢复·持久化往返）/
//         索引破损防御回退全扫并注记
//   ΝΩ-12 利用项（explore-exploit 平衡恢复）：第四项 k·posteriorMean ——
//         同 tries 异 successes ⇒ 高 successes 胜 / exploitWeight=0 ⇒ 旧公式
//         逐字节 / 内核键 exploration.exploitWeight 覆写（含越界夹取）生效 /
//         负先验×低均值不被过度双重惩罚（只奖不罚 + 有界下压）/ 持久化往返后
//         成功账照常入式
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ExplorationLedger,
  explorationScore,
  quantizePoint,
  quantizeRegion,
  regionLabel,
  trailingFailureRun,
  EXPLORATION_GRID_COLS,
  EXPLORATION_GRID_ROWS,
  EXPLORATION_UCB_C,
  EXPLORATION_EXPLOIT_WEIGHT,
  EXPLORATION_ALTERNATION_PENALTY,
  type ExplorationContext,
  type ExplorationPort,
} from '../src/autonomy/exploration.ts';
import { cellKey } from '../src/autonomy/explorationCore.ts';
import { runAutonomousLoop } from '../src/autonomy/autoPilot.ts';
import type { AutonomyDeps, StepRecord } from '../src/autonomy/autoPilot.ts';
import { failureMemory } from '../src/failureMemory.ts';
import { kernelRegistry } from '../src/kernel/registry.ts';

// ─── 测试工坊 ───

type Goal = AutonomyDeps['goal'];
// 与 autonomy.autoPilot.test.ts 同律：GoalStateMachine 含私有成员，结构性桩须经
// unknown 双跳注入（运行时只消费闭环的面）。
const asGoal = (g: StubGoal): Goal => g as unknown as Goal;
type Spec = Goal['spec'];
type Act = StepRecord['action'];
type Decision = Awaited<ReturnType<AutonomyDeps['policy']['decide']>>;
type ExecResult = Awaited<ReturnType<AutonomyDeps['execute']>>;
type Snap = Awaited<ReturnType<AutonomyDeps['perceive']>>;
type StubPhase = 'planning' | 'acting' | 'verifying' | 'blocked' | 'achieved' | 'failed' | 'aborted';

/** 固定视口（12×8 网格：格宽 160、格高 135 —— 手算锚点） */
const VP = { width: 1920, height: 1080 };

/** 视口中心 (960,540) 落格 r54；左上 (100,100) 落 r0；右下 (1700,900) 落 r82 */
const R_TL = 0;
const R_BR = 82;
const R_CENTER = 54;

/** 元素字面量（bbox 中心即传入中心 —— 与 worldSnapshot 的 center 重算律一致） */
function el(label: string, cx: number, cy: number): Snap['elements'][number] {
  return {
    label,
    role: 'button',
    bbox: { x0: cx - 30, y0: cy - 15, x1: cx + 30, y1: cy + 15 },
    center: { x: cx, y: cy },
    confidence: 0.9,
    source: 'vlm',
    interactive: true,
  };
}

/** 世界快照铸造器 */
function makeSnap(elements: Snap['elements']): Snap {
  return {
    takenAt: 1_000, width: VP.width, height: VP.height, dhash: '9f3a',
    elements, textDigest: '', popups: [], focusedRegion: null,
    sceneLabel: '测试桌面', degraded: [],
  };
}

/** 点击动作（带 payload.exploration 预标 —— observe 的精确对账通道） */
function clickAction(label: string, cx: number, cy: number, mark?: { region: number; modality: string; strategy: string }): Act {
  return {
    kind: 'click',
    target: { bbox: { x0: cx - 30, y0: cy - 15, x1: cx + 30, y1: cy + 15 }, center: { x: cx, y: cy }, label },
    payload: mark ? { exploration: mark } : undefined,
    rationale: `点击「${label}」`,
    expectedEffect: '界面变化',
    utility: 0.8,
    riskTier: 'benign',
  };
}

/** 手写目标机桩（与 autonomy.autoPilot.test.ts 同款最小面） */
class StubGoal {
  readonly spec: Spec;
  readonly progress: { steps: number; criteria: Array<'met' | 'violated' | 'pending'>; blockers: string[] };
  began = false;
  tickCount = 0;
  constructor(s: Spec) {
    this.spec = s;
    this.progress = { steps: 0, criteria: s.successCriteria.map(() => 'pending' as const), blockers: [] };
  }
  begin(): void { this.began = true; }
  tick(): void { this.tickCount++; this.progress.steps = this.tickCount; }
  recordCriterion(): void { /* 探索用例不消费 */ }
  evaluate(): { phase: StubPhase; reason: string } {
    return { phase: this.began ? 'acting' : 'planning', reason: '进行中' };
  }
}

/** 升级决策字面量（policy ⑦ 的「所有已知路失败」方言） */
function escalateDecision(reason: string): Decision {
  return {
    action: {
      kind: 'escalate',
      payload: { reason },
      rationale: '本地规则未命中且云脑未配置，升级上游',
      expectedEffect: '控制权移交上游',
      utility: 0.3,
      riskTier: 'benign',
    },
    uncertain: true,
    degraded: true,
  };
}

/** advise 上下文铸造器（缺省「所有已知路失败」恢复态） */
function ctx(over: Partial<ExplorationContext> = {}): ExplorationContext {
  return {
    goal: '打开设置',
    snapshot: makeSnap([]),
    history: [],
    escalateReason: 'no-deterministic-action',
    ...over,
  };
}

// ─── R2-1 区域量化 ───

test('R2-1: 区域量化 —— 确定性 / 边界夹取 / 垃圾 −1 / 分辨率无关', () => {
  // 视口内三个锚点：左上 r0、右下 r82、中心 r54
  assert.equal(quantizePoint({ x: 100, y: 100 }, VP), R_TL);
  assert.equal(quantizePoint({ x: 1700, y: 900 }, VP), R_BR);
  assert.equal(quantizePoint({ x: 960, y: 540 }, VP), R_CENTER);
  // 确定性：同输入同输出
  for (let i = 0; i < 5; i++) assert.equal(quantizePoint({ x: 100, y: 100 }, VP), R_TL);
  // 边界夹取：越界坐标夹回网格边缘（r95 = 最右下格）
  assert.equal(quantizePoint({ x: 5000, y: 5000 }, VP), EXPLORATION_GRID_ROWS * EXPLORATION_GRID_COLS - 1);
  assert.equal(quantizePoint({ x: -50, y: -50 }, VP), R_TL);
  // 垃圾输入 ⇒ −1（不入账）
  assert.equal(quantizePoint({ x: Number.NaN, y: 5 }, VP), -1);
  assert.equal(quantizePoint({ x: 5, y: Number.POSITIVE_INFINITY }, VP), -1);
  assert.equal(quantizePoint(null, VP), -1);
  assert.equal(quantizePoint({ x: 100, y: 100 }), R_TL); // 视口缺席 ⇒ 1920×1080 回退
  // 分辨率无关：同一相对位置（1/19.2, 1/10.8）在不同分辨率落同格
  assert.equal(quantizePoint({ x: 200, y: 200 }, { width: 3840, height: 2160 }), R_TL);
  // elementTracker 框方言（TrackedRect）：中心 = (x+w/2, y+h/2) 同律落格
  assert.equal(quantizeRegion({ x: 40, y: 40, width: 120, height: 120 }, VP), R_TL);
  assert.equal(quantizeRegion({ x: 1670, y: 885, width: 60, height: 30 }, VP), R_BR);
  assert.equal(quantizeRegion(null, VP), -1);
  // 区域标签（负先验查询与 rationale 的名词形式 —— 确定性）
  assert.equal(regionLabel(R_TL), '区域 r0 (0,0)');
  assert.equal(regionLabel(R_BR), `区域 r82 (10,6)`);
  assert.equal(regionLabel(-1), '区域 ?');
});

// ─── R2-2 UCB 数值（手算小例） ───

test('R2-2: explorationScore 手算 —— 分项逐项对表', () => {
  // 空账全新格：不确定度 1 + 新颖度 1 + 探索项 c·√(ln1/1)=0 ⇒ 恰 2
  assert.equal(explorationScore({
    regionTries: 0, cellTries: 0, totalTries: 0,
    riskCost: 0, negativePriorPenalty: 0, sameModalityAsLast: false,
  }), 2);
  // 手算例：区域试 3 次、格试 3 次、全账 3 次
  //   1/(1+3) + 1/(1+3) + 0.7·√(ln4/4) = 0.25 + 0.25 + 0.7·0.588705…
  const hand = 0.25 + 0.25 + EXPLORATION_UCB_C * Math.sqrt(Math.log(4) / 4);
  assert.equal(explorationScore({
    regionTries: 3, cellTries: 3, totalTries: 3,
    riskCost: 0, negativePriorPenalty: 0, sameModalityAsLast: false,
  }), hand);
  // 三项代价逐项精确扣除
  assert.equal(explorationScore({
    regionTries: 0, cellTries: 0, totalTries: 0,
    riskCost: 0.6, negativePriorPenalty: 0.45, sameModalityAsLast: true,
  }), 2 - 0.6 - 0.45 - EXPLORATION_ALTERNATION_PENALTY);
  // 探索项随 N 单调不减（UCB 欠采样加成的方向性）
  const s1 = explorationScore({
    regionTries: 0, cellTries: 1, totalTries: 1, riskCost: 0, negativePriorPenalty: 0, sameModalityAsLast: false,
  });
  const s2 = explorationScore({
    regionTries: 0, cellTries: 1, totalTries: 100, riskCost: 0, negativePriorPenalty: 0, sameModalityAsLast: false,
  });
  assert.ok(s2 > s1);
  // 垃圾入参按 0 收敛（绝不抛）
  assert.equal(explorationScore({} as Partial<import('../src/autonomy/exploration.ts').ExplorationScoreInput> as never), 2);
  // 自带 c 覆盖（生产经内核键注入的同位面）
  assert.equal(explorationScore({
    regionTries: 0, cellTries: 0, totalTries: 0,
    riskCost: 0, negativePriorPenalty: 0, sameModalityAsLast: false, ucbC: 0,
  }), 2);
});

// ─── R2-3 探索集更新 ───

test('R2-3: observe —— Beta 计数 / 区域聚合账 / 预标与现场量化 / 观察族不入账', () => {
  failureMemory.reset();
  const ledger = new ExplorationLedger('打开设置', { enabled: true });
  // 预标通道：payload.exploration 精确对账
  const marked = clickAction('设置', 100, 100, { region: 5, modality: 'click', strategy: 'click#5#设置' });
  ledger.observe(marked, 'progress', VP);
  assert.deepEqual(ledger.cellFor(5, 'click', 'click#5#设置'), { tries: 1, successes: 1 });
  ledger.observe(marked, 'no_effect', VP);
  assert.deepEqual(ledger.cellFor(5, 'click', 'click#5#设置'), { tries: 2, successes: 1 });
  assert.equal(ledger.regionTryCount(5), 2);
  assert.equal(ledger.totalTryCount, 2);
  // 现场量化通道：无预标的点击按 target.center + 视口落格（(100,100) ⇒ r0）
  ledger.observe(clickAction('按钮甲', 100, 100), 'no_effect', VP);
  assert.deepEqual(ledger.cellFor(0, 'click', 'click#0#按钮甲'), { tries: 1, successes: 0 });
  assert.equal(ledger.regionTryCount(0), 1);
  // 无 target 无视口的全局动作（hotkey）⇒ 无法定位 ⇒ 诚实跳过（不记猜的格子）
  ledger.observe({
    kind: 'hotkey', payload: { keys: ['tab'] },
    rationale: 'r', expectedEffect: 'e', utility: 0.5, riskTier: 'benign',
  }, 'no_effect');
  assert.equal(ledger.totalTryCount, 3);
  // 有视口 ⇒ 视口中心格（r54）+ 方言签名
  ledger.observe({
    kind: 'scroll', payload: { direction: 'down' },
    rationale: 'r', expectedEffect: 'e', utility: 0.5, riskTier: 'benign',
  }, 'no_effect', VP);
  assert.deepEqual(ledger.cellFor(R_CENTER, 'scroll', 'scroll#down'), { tries: 1, successes: 0 });
  assert.equal(ledger.regionTryCount(R_CENTER), 1);
  // 观察族 / 元动作不入账：declare / escalate / wait / ask_vlm / recall_skill
  for (const kind of ['declare', 'escalate', 'wait', 'ask_vlm', 'recall_skill'] as const) {
    ledger.observe({
      kind, rationale: 'r', expectedEffect: 'e', utility: 0.1, riskTier: 'benign',
    }, 'no_effect', VP);
  }
  assert.equal(ledger.totalTryCount, 4);
  // 快照面：Beta(1,1) 后验均值 (1+1)/(1+2)
  const snap = ledger.snapshot();
  assert.equal(snap.totalTries, 4);
  assert.equal(snap.cells.length, 3);
  const c0 = snap.cells.find(c => c.region === 5 && c.modality === 'click');
  assert.ok(c0);
  assert.equal(c0.posteriorMean, Math.round((2 / 4) * 1e6) / 1e6);
  assert.equal(snap.lastModality, 'scroll');
});

// ─── R2-4 UCB 未探索格胜出 ───

test('R2-4: UCB 择路 —— 尝试过的区域让位，未探索区域夺魁（手算对照）', () => {
  failureMemory.reset();
  const ledger = new ExplorationLedger('打开设置', { enabled: true });
  // 区域 r0 已试 3 次（click，全败）；r82 未试。此时 lastModality=click ⇒ 交替律
  // 对 click 候选 −0.25（防同模态连打 —— 与 R2-5 的同一个法）
  const tried = clickAction('旧按钮', 100, 100, { region: 0, modality: 'click', strategy: 'click#0#旧按钮' });
  ledger.observe(tried, 'no_effect', VP);
  ledger.observe(tried, 'no_effect', VP);
  ledger.observe(tried, 'no_effect', VP);
  const snapshot = makeSnap([el('旧按钮', 100, 100), el('新按钮', 1700, 900)]);
  // 第 1 发手算（N=3）：旧 click 0.25+0.25+0.412−0.25 ≈ 0.662；新 click 1+1+0.824−0.25 ≈ 2.574；
  // 未探索区域的 scroll 1+1+0.824 ≈ 2.824 ⇒ 未探索区域（r54）胜过一切已试路径
  const a1 = ledger.advise(ctx({ snapshot }));
  assert.ok(a1, '恢复态 + 有候选 ⇒ 必有建议');
  assert.equal(a1.action.kind, 'scroll');
  assert.equal((a1.action.payload as { exploration?: { region?: number } }).exploration?.region, R_CENTER);
  assert.ok(a1.note.includes('W3-7 探索建议'));
  // 回报 scroll 后（N=4，lastModality=scroll）：未探索元素格 click@r82 手算
  //   1+1+0.7·√(ln5/1) ≈ 2.888 > hotkey@r54 0.5+1+0.888=2.388 > scroll-up 2.138 ⇒ click@r82 夺魁
  ledger.observe(a1.action, 'no_effect', VP);
  const a2 = ledger.advise(ctx({
    snapshot, history: [{ action: a1.action, outcome: 'no_effect' }],
  }));
  assert.ok(a2);
  assert.equal(a2.action.kind, 'click');
  const mark = (a2.action.payload as { exploration?: { region?: number } }).exploration;
  assert.equal(mark?.region, R_BR, '未探索元素区域 r82 击败已试区域 r0');
  assert.ok(a2.note.includes('r82'));
  // 建议即计入本 run 预算
  assert.equal(ledger.snapshot().advisesThisRun, 2);
});

// ─── R2-5 交替律 ───

test('R2-5: 交替律 —— 连续建议模态不连打（click → scroll → hotkey）', () => {
  failureMemory.reset();
  const ledger = new ExplorationLedger('打开设置', { enabled: true });
  const snapshot = makeSnap([el('按钮甲', 100, 100)]); // 唯一元素在 r0
  const c = (hist: ExplorationContext['history']): ExplorationContext =>
    ctx({ snapshot, history: hist });
  // 第 1 发：click@r0 与 scroll@r54 同分 2.0 —— 元素序破平 ⇒ click
  const a1 = ledger.advise(c([]));
  assert.ok(a1);
  assert.equal(a1.action.kind, 'click');
  // 回报（no_effect）后：click 带交替惩罚 + 探索度折价 ⇒ 第 2 发必为 scroll
  ledger.observe(a1.action, 'no_effect', VP);
  const a2 = ledger.advise(c([{ action: a1.action, outcome: 'no_effect' }]));
  assert.ok(a2);
  assert.equal(a2.action.kind, 'scroll');
  assert.equal((a2.action.payload as { direction?: string }).direction, 'down');
  // 第 3 发：scroll 连打受罚 ⇒ hotkey（tab）夺魁
  ledger.observe(a2.action, 'no_effect', VP);
  const a3 = ledger.advise(c([
    { action: a1.action, outcome: 'no_effect' },
    { action: a2.action, outcome: 'no_effect' },
  ]));
  assert.ok(a3);
  assert.equal(a3.action.kind, 'hotkey');
  // 交替律断言：连续建议模态两两不同
  const kinds = [a1.action.kind, a2.action.kind, a3.action.kind];
  assert.ok(kinds[0] !== kinds[1] && kinds[1] !== kinds[2], `模态序列 ${kinds.join('→')} 出现连打`);
});

// ─── R2-6 负先验降权 ───

test('R2-6: 负先验降权 —— failureMemory 命中的区域×模态组合降权且翻转择路', () => {
  failureMemory.reset();
  try {
    // 种两条 r0×click 的前科（不同 approach 免去重）
    failureMemory.record('打开设置', 'click 区域 r0 (0,0)', '点击无变化');
    failureMemory.record('打开设置', 'click 区域 r0 (0,0) 重试', '点击无变化');
    // 布景：把全局 scroll 候选的区域（视口中心 r54）灌成热区，隔离出「两个全新
    // click 格 r0/r82 之争」—— 只有负先验能决定胜负
    const ledger = new ExplorationLedger('打开设置', { enabled: true });
    const scrollAct = {
      kind: 'scroll' as const,
      payload: { direction: 'down', exploration: { region: R_CENTER, modality: 'scroll', strategy: 'scroll#down' } },
      rationale: 'r', expectedEffect: 'e', utility: 0.5, riskTier: 'benign' as const,
    };
    ledger.observe(scrollAct, 'no_effect', VP);
    ledger.observe(scrollAct, 'no_effect', VP);
    ledger.observe(scrollAct, 'no_effect', VP);
    const snapshot = makeSnap([el('按钮甲', 100, 100), el('按钮乙', 1700, 900)]);
    // 降权数值面：命中格 > 未命中格 ≥ 0
    const penHit = ledger.negativePriorFor(R_TL, 'click', '打开设置');
    const penMiss = ledger.negativePriorFor(R_BR, 'click', '打开设置');
    assert.ok(penHit > 0, `命中组合必须降权（实测 ${penHit}）`);
    assert.ok(penHit > penMiss, `命中格降权须重于未命中格（${penHit} > ${penMiss}）`);
    // 择路翻转（N=3，lastModality=scroll ⇒ click 无交替惩罚）：
    //   click@r0 = 2.824 − penHit；click@r82 = 2.824 − penMiss < 前者之外的最大对手
    //   hotkey 2.074 ⇒ r82 胜
    const penalized = ledger.advise(ctx({ snapshot }));
    assert.ok(penalized);
    const markP = (penalized.action.payload as { exploration?: { region?: number } }).exploration;
    assert.equal(markP?.region, R_BR, '负先验命中的 r0 让位给 r82');
    assert.equal(penalized.action.kind, 'click');
    // 对照组：空库（penHit = penMiss = 0）⇒ 两 click 格同分 ⇒ 候选序破平 r0 胜 —— 翻转坐实
    failureMemory.reset();
    const control = ledger.advise(ctx({ snapshot }));
    assert.ok(control);
    const markC = (control.action.payload as { exploration?: { region?: number } }).exploration;
    assert.equal(markC?.region, R_TL, '无负先验时候选序破平 ⇒ r0 胜（对照组）');
    // 空库 ⇒ 零降权（只读查询绝不写账）
    assert.equal(ledger.negativePriorFor(R_TL, 'click', '打开设置'), 0);
  } finally {
    failureMemory.reset();
  }
});

// ─── ΝΩ-12：利用项（explore-exploit 平衡恢复） ───

test('ΝΩ-12a: 利用项数值 —— 只奖不罚 / 字段缺席 ⇒ 0 / k=0 ⇒ 旧公式逐字节 / k 覆写', () => {
  failureMemory.reset();
  // 旧公式（W3-7 三项加减 —— ΝΩ-12 前的 explorationScore 逐型重铸，差分对照面）
  const oldFormula = (i: {
    regionTries: number; cellTries: number; totalTries: number;
    riskCost: number; negativePriorPenalty: number; sameModalityAsLast: boolean; ucbC?: number;
  }): number =>
    1 / (1 + i.regionTries) + 1 / (1 + i.cellTries)
    + (i.ucbC ?? EXPLORATION_UCB_C) * Math.sqrt(Math.log(1 + i.totalTries) / (1 + i.cellTries))
    - i.riskCost - i.negativePriorPenalty
    - (i.sameModalityAsLast ? EXPLORATION_ALTERNATION_PENALTY : 0);
  const base = {
    regionTries: 3, cellTries: 3, totalTries: 7,
    riskCost: 0.3, negativePriorPenalty: 0.45, sameModalityAsLast: true,
  };
  const old = oldFormula(base);
  // 字段缺席 ⇒ 利用项 0（零回归：无成功账的格不受罚）—— 与旧公式逐字节相等
  assert.equal(explorationScore(base), old);
  // k=0 ⇒ 旧行为逐字节（成功账在场也归零：利用项 0·均值 = 0 恰为比特恒等加数）
  for (const s of [0, 1, 3]) {
    assert.equal(explorationScore({ ...base, cellSuccesses: s, exploitWeight: 0 }), old);
  }
  // Laplace 手算：tries=3 下 successes 0/3 ⇒ 后验均值 (0+1)/(3+2)=0.2 与 (3+1)/(3+2)=0.8
  assert.ok(Math.abs(explorationScore({ ...base, cellSuccesses: 0 }) - (old + EXPLORATION_EXPLOIT_WEIGHT * (1 / 5))) < 1e-12);
  assert.ok(Math.abs(explorationScore({ ...base, cellSuccesses: 3 }) - (old + EXPLORATION_EXPLOIT_WEIGHT * (4 / 5))) < 1e-12);
  // k 覆写：2 ⇒ 利用权重加倍（内核键 [0,2] 上界的同位面）
  assert.ok(Math.abs(explorationScore({ ...base, cellSuccesses: 3, exploitWeight: 2 }) - (old + 2 * (4 / 5))) < 1e-12);
  // 垃圾 cellSuccesses（负 / NaN）⇒ 视同缺席（防御收敛，绝不抛、不受罚）
  assert.equal(explorationScore({ ...base, cellSuccesses: -1 }), old);
  assert.equal(explorationScore({ ...base, cellSuccesses: Number.NaN }), old);
  // 垃圾 successes > tries ⇒ 均值夹 1（不虚发 >1 的后验）
  assert.ok(Math.abs(explorationScore({ ...base, cellSuccesses: 99, exploitWeight: 2 }) - (old + 2)) < 1e-12);
});

test('ΝΩ-12b: 同 tries 异 successes ⇒ 高 successes 者胜；内核键覆写生效；往返后成功账照常入式', () => {
  failureMemory.reset();
  const dir = mkdtempSync(join(tmpdir(), 'w3explore-n12-'));
  try {
    const ledger = new ExplorationLedger('打开设置', { enabled: true });
    // 布景：r0 click ×2 全败（已知坏格，后验 0.25）、r82 click ×2 全胜（已知好格，
    // 后验 0.75）—— 同 tries 异 successes；全局三候选（scroll down/up、hotkey tab
    // @r54）各灌 3 笔饱和其新颖度，隔离出「两格之争只有利用项能裁决」
    const bad = clickAction('按钮甲', 100, 100, { region: R_TL, modality: 'click', strategy: 'click#0#按钮甲' });
    const good = clickAction('按钮乙', 1700, 900, { region: R_BR, modality: 'click', strategy: 'click#82#按钮乙' });
    ledger.observe(bad, 'no_effect', VP);
    ledger.observe(bad, 'no_effect', VP);
    ledger.observe(good, 'progress', VP);
    ledger.observe(good, 'progress', VP);
    const markedGlobal = (kind: 'scroll' | 'hotkey', payload: Record<string, unknown>, strategy: string): Act => ({
      kind, payload: { ...payload, exploration: { region: R_CENTER, modality: kind, strategy } },
      rationale: 'r', expectedEffect: 'e', utility: 0.5, riskTier: 'benign',
    } as Act);
    for (const scrollDir of ['down', 'up'] as const) {
      const act = markedGlobal('scroll', { direction: scrollDir }, `scroll#${scrollDir}`);
      for (let i = 0; i < 3; i++) ledger.observe(act, 'no_effect', VP);
    }
    const tab = markedGlobal('hotkey', { keys: ['tab'] }, 'hotkey#tab');
    for (let i = 0; i < 3; i++) ledger.observe(tab, 'no_effect', VP);
    const snapshot = makeSnap([el('按钮甲', 100, 100), el('按钮乙', 1700, 900)]);
    const regionOf = (adv: { action: Act }): number | undefined =>
      (adv.action.payload as { exploration?: { region?: number } } | undefined)?.exploration?.region;
    // ① 缺省 k=0.5（内核键未注册 ⇒ getOrDefault 回声模块常量）：已知好格 r82 胜过
    //    候选序在前的已知坏格 r0 —— 利用差恰 k·(0.75−0.25)=0.25
    const a1 = ledger.advise(ctx({ snapshot }));
    assert.ok(a1);
    assert.equal(a1.action.kind, 'click');
    assert.equal(regionOf(a1), R_BR, '同 tries 异 successes ⇒ 高 successes 者胜');
    // ② 内核键覆写：exploitWeight=0 ⇒ 纯探索旧行为（两 click 格同分 ⇒ 候选序破平 r0 胜）
    kernelRegistry.register({
      key: 'exploration.exploitWeight', organ: 'w3explore-test', defaultValue: 0.5, min: 0, max: 2,
    });
    kernelRegistry.set('exploration.exploitWeight', 0);
    const a2 = ledger.advise(ctx({ snapshot }));
    assert.ok(a2);
    assert.equal(a2.action.kind, 'click');
    assert.equal(regionOf(a2), R_TL, 'exploitWeight=0 ⇒ 旧行为（同分候选序破平）');
    // ③ 覆写回程：2 ⇒ 利用加倍，好格仍胜
    kernelRegistry.set('exploration.exploitWeight', 2);
    const a3 = ledger.advise(ctx({ snapshot }));
    assert.ok(a3);
    assert.equal(regionOf(a3), R_BR, 'exploitWeight=2 ⇒ 好格仍胜（利用加倍）');
    // ④ 越界覆写：99 ⇒ 注册表夹取 [0,2] ⇒ 与 2 同行为
    kernelRegistry.set('exploration.exploitWeight', 99);
    const a4 = ledger.advise(ctx({ snapshot }));
    assert.ok(a4);
    assert.equal(regionOf(a4), R_BR, '越界 set 被夹取 ⇒ 行为与 2 一致');
    // ⑤ 持久化往返后 successes 保留且利用项照常吃它：落盘 ⇒ 新账本恢复（回缺省 k）⇒ 好格仍胜
    kernelRegistry.set('exploration.exploitWeight', 0.5);
    const file = join(dir, 'n12.json');
    assert.equal(ledger.persist(file).ok, true);
    const restored = new ExplorationLedger('打开设置', { enabled: true });
    assert.equal(restored.restore(file).ok, true);
    assert.deepEqual(restored.cellFor(R_BR, 'click', 'click#82#按钮乙'), { tries: 2, successes: 2 }, '往返后 successes 在账');
    const a5 = restored.advise(ctx({ snapshot }));
    assert.ok(a5);
    assert.equal(regionOf(a5), R_BR, '恢复账本的成功账照常入式（好格胜）');
  } finally {
    failureMemory.reset();
    kernelRegistry.reset();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ΝΩ-12c: 负先验 × 低均值 —— 不被过度双重惩罚（只奖不罚 + 有界下压 + 软先验可翻案）', () => {
  failureMemory.reset();
  // 已知坏格的极端面：regionTries/cellTries/totalTries 全 3、三重罚全开
  const moderate = {
    regionTries: 3, cellTries: 3, totalTries: 3,
    riskCost: 0.6, negativePriorPenalty: 0.45, sameModalityAsLast: true,
  };
  const old = explorationScore(moderate); // 字段缺席 ⇒ 旧公式（无成功账不受罚）
  const withBad = explorationScore({ ...moderate, cellSuccesses: 0 });
  const withGood = explorationScore({ ...moderate, cellSuccesses: 3 });
  // 只奖不罚：成功账入场（即使 0 成功）也绝不压低分数 —— 低均值失去的是奖励而非额外罚金，
  // 「双重惩罚」实为 negPrior 罚 + 缺奖励，二者叠加仍严格可加
  assert.ok(withBad > old, `已知坏格不受成功账罚（${withBad} > ${old}）`);
  assert.ok(Math.abs((withGood - withBad) - EXPLORATION_EXPLOIT_WEIGHT * (3 / 5)) < 1e-12, '好坏差恰 k·Δ后验（有界）');
  // 有界下压：最坏情形（双罚全夹 1 + 交替律 + k=2 上界 + 海量 tries）⇒ 有限且 > −2.25
  //（先验下界：正项全 0 − 1 − 1 − 0.25；后验分母 n_i+2 恒正 ⇒ 绝无「分母为负」）
  const worst = explorationScore({
    regionTries: 1_000_000, cellTries: 1_000_000, totalTries: 1_000_000,
    riskCost: 1, negativePriorPenalty: 1, sameModalityAsLast: true,
    cellSuccesses: 0, exploitWeight: 2,
  });
  assert.ok(Number.isFinite(worst) && worst > -2.25, `双重惩罚有界（实测 ${worst}）`);
  // 软先验可翻案（降权不除名）：重罚已知坏格仍可与全新格同台竞技 —— 全新格凭
  // 满额新颖度领先，但差距恰为两重下压之和（有界 ⇒ UCB 其余三项仍可翻案）
  const fresh = explorationScore({
    regionTries: 0, cellTries: 0, totalTries: 1_000_000,
    riskCost: 0, negativePriorPenalty: 0, sameModalityAsLast: false,
    cellSuccesses: 0,
  });
  assert.ok(fresh > worst, `全新格仍胜重罚格（${fresh} > ${worst}），探索侧不被利用项挤压`);
});

// ─── R2-7 恢复态门（触发 / 常态 / 红线 / 双闸） ───

test('R2-7: 恢复态触发、常态不触发、预算红线绝不探索、双闸', () => {
  failureMemory.reset();
  try {
    const snapshot = makeSnap([el('按钮甲', 100, 100)]);
    const ledger = new ExplorationLedger('打开设置', { enabled: true });
    const fail = { action: clickAction('按钮甲', 100, 100), outcome: 'no_effect' } as const;
    // ① 所有已知路失败（policy ⑦ 方言）⇒ 触发
    assert.ok(ledger.advise(ctx({ snapshot })) !== null);
    // ② 常态（理由不明 + 干净历史）⇒ 不触发
    assert.equal(ledger.advise(ctx({ snapshot, escalateReason: '?' })), null);
    // ③ 熔断后/僵局现场：尾部连续失败 ≥2 ⇒ 触发
    assert.ok(ledger.advise(ctx({
      snapshot, escalateReason: '?', history: [fail, fail],
    })) !== null);
    // ④ 尾部仅 1 败 ⇒ 未达恢复态 ⇒ 不触发
    assert.equal(ledger.advise(ctx({ snapshot, escalateReason: '?', history: [fail] })), null);
    // ⑤ 预算红线 / 内部异常 ⇒ 绝不探索（收手时刻）
    assert.equal(ledger.advise(ctx({ snapshot, escalateReason: 'budget-low', history: [fail, fail, fail] })), null);
    assert.equal(ledger.advise(ctx({ snapshot, escalateReason: 'policy-engine-internal-error', history: [fail, fail] })), null);
    // ⑥ 本 run 探索预算耗尽 ⇒ 不触发（第三重停机）
    const capped = new ExplorationLedger('打开设置', { enabled: true, maxAdvisesPerRun: 1 });
    assert.ok(capped.advise(ctx({ snapshot })) !== null);
    assert.equal(capped.advise(ctx({ snapshot })), null);
    // ⑦ 实例总闸缺省关闭（缺省关闭红律）
    const offLedger = new ExplorationLedger('打开设置');
    assert.equal(offLedger.advise(ctx({ snapshot, history: [fail, fail] })), null);
    // ⑧ 内核双闸：exploration.enabledGate = 0 ⇒ 熄火
    kernelRegistry.register({
      key: 'exploration.enabledGate', organ: 'w3explore-test', defaultValue: 1, min: 0, max: 1,
    });
    kernelRegistry.set('exploration.enabledGate', 0);
    assert.equal(ledger.advise(ctx({ snapshot })), null);
    kernelRegistry.set('exploration.enabledGate', 1);
    assert.ok(ledger.advise(ctx({ snapshot })) !== null);
    // 尾部失败游程纯函数（判据核心）
    const p = { action: clickAction('x', 1, 1), outcome: 'progress' } as const;
    assert.equal(trailingFailureRun([p, fail, { action: fail.action, outcome: 'error' }]), 2);
    assert.equal(trailingFailureRun([fail, p]), 0);
    assert.equal(trailingFailureRun([]), 0);
  } finally {
    failureMemory.reset();
    kernelRegistry.reset();
  }
});

// ─── R2-8 持久化往返 ───

test('R2-8: 持久化 —— 原子落盘 / 防御恢复 / 自动节流 / 会话边界可配', () => {
  failureMemory.reset();
  const dir = mkdtempSync(join(tmpdir(), 'w3explore-'));
  try {
    const file = join(dir, 'exploration.json');
    // 往返：记 3 笔（2 成功 1 败）+ 区域账 + 交替态 ⇒ 落盘 ⇒ 新账本恢复
    const a = new ExplorationLedger('打开设置', { enabled: true });
    a.observe(clickAction('甲', 100, 100, { region: 0, modality: 'click', strategy: 'click#0#甲' }), 'progress', VP);
    a.observe(clickAction('甲', 100, 100, { region: 0, modality: 'click', strategy: 'click#0#甲' }), 'progress', VP);
    a.observe({
      kind: 'scroll', payload: { direction: 'down', exploration: { region: R_CENTER, modality: 'scroll', strategy: 'scroll#down' } },
      rationale: 'r', expectedEffect: 'e', utility: 0.5, riskTier: 'benign',
    }, 'no_effect', VP);
    const persistRes = a.persist(file);
    assert.equal(persistRes.ok, true);
    assert.equal(persistRes.cells, 2);
    assert.equal(existsSync(`${file}.tmp`), false, '原子落盘不留半档 tmp');
    const b = new ExplorationLedger('打开设置', { enabled: true });
    const res = b.restore(file);
    assert.equal(res.ok, true);
    assert.equal(res.restored, 2);
    assert.equal(res.dropped, 0);
    assert.deepEqual(b.snapshot().cells, a.snapshot().cells);
    assert.deepEqual(b.snapshot().regionTries, a.snapshot().regionTries);
    assert.equal(b.totalTryCount, a.totalTryCount, '全账总数从格账重演');
    assert.equal(b.snapshot().lastModality, 'scroll');
    // 他账拒收：目标不符 ⇒ 整档拒收（按目标隔离红律）
    const c = new ExplorationLedger('目标乙', { enabled: true });
    assert.equal(c.restore(file).ok, false);
    // 防御恢复：垃圾格弃置不连坐（区域越界 / 模态非法 / 成功数 > 尝试数 / 非对象）
    const dirty = join(dir, 'dirty.json');
    writeFileSync(dirty, JSON.stringify({
      version: 1, goal: '打开设置',
      cells: [
        { region: -1, modality: 'click', strategy: 'x', tries: 1, successes: 0 },
        { region: 9999, modality: 'click', strategy: 'x', tries: 1, successes: 0 },
        { region: 3, modality: 'teleport', strategy: 'x', tries: 1, successes: 0 },
        { region: 3, modality: 'click', strategy: '', tries: 1, successes: 0 },
        { region: 3, modality: 'click', strategy: 'y', tries: 2, successes: 5 },
        'garbage',
        { region: 7, modality: 'hotkey', strategy: 'hotkey#tab', tries: 4, successes: 1 },
      ],
      regionTries: [{ region: 7, tries: 4 }, { region: -3, tries: 9 }, 'junk'],
      lastModality: 'hotkey',
    }));
    const d = new ExplorationLedger('打开设置', { enabled: true });
    const dres = d.restore(dirty);
    assert.equal(dres.ok, true);
    assert.equal(dres.restored, 1);
    assert.equal(dres.dropped, 6);
    assert.deepEqual(d.cellFor(7, 'hotkey', 'hotkey#tab'), { tries: 4, successes: 1 });
    assert.equal(d.regionTryCount(7), 4);
    // 版本不符 / 非对象 / 坏 JSON / 文件缺席 ⇒ ok:false（绝不抛）
    const vFile = join(dir, 'version.json');
    writeFileSync(vFile, JSON.stringify({ version: 99, goal: '打开设置', cells: [] }));
    assert.equal(new ExplorationLedger('打开设置').restore(vFile).ok, false);
    const badFile = join(dir, 'bad.json');
    writeFileSync(badFile, 'not-json{{{');
    assert.equal(new ExplorationLedger('打开设置').restore(badFile).ok, false);
    assert.equal(new ExplorationLedger('打开设置').restore(join(dir, 'absent.json')).ok, false);
    // 自动节流落盘：第 8 笔观察触发（事件级 fsync 太碎的折中）
    const auto = join(dir, 'auto.json');
    const e = new ExplorationLedger('打开设置', { enabled: true });
    e.setPersistence(auto);
    for (let i = 0; i < 7; i++) {
      e.observe(clickAction('甲', 100, 100, { region: 0, modality: 'click', strategy: 'click#0#甲' }), 'no_effect', VP);
    }
    assert.equal(existsSync(auto), false, '7 笔未到节流阈值');
    e.observe(clickAction('甲', 100, 100, { region: 0, modality: 'click', strategy: 'click#0#甲' }), 'no_effect', VP);
    assert.equal(existsSync(auto), true, '第 8 笔触发自动落盘');
    // 成功即落盘（疗效事件优先持久化）
    const succ = join(dir, 'succ.json');
    const f = new ExplorationLedger('打开设置', { enabled: true });
    f.setPersistence(succ);
    f.observe(clickAction('甲', 100, 100, { region: 0, modality: 'click', strategy: 'click#0#甲' }), 'progress', VP);
    assert.equal(existsSync(succ), true);
    // 会话边界：'restore' ⇒ 跨会话延续账本；run 态归零
    const g = new ExplorationLedger('打开设置', { enabled: true, persistPath: file });
    g.advise(ctx({ snapshot: makeSnap([el('按钮甲', 100, 100)]) }));
    assert.equal(g.snapshot().advisesThisRun, 1);
    g.beginSession('restore');
    assert.equal(g.snapshot().advisesThisRun, 0, '会话边界归零 run 预算');
    assert.equal(g.cellFor(0, 'click', 'click#0#甲')?.tries, 2, '恢复延续细胞账');
    // 'reset'（缺省）⇒ run 态归零、细胞账保留
    const h = new ExplorationLedger('打开设置', { enabled: true });
    h.restore(file);
    h.advise(ctx({ snapshot: makeSnap([el('按钮甲', 100, 100)]) }));
    h.beginSession('reset');
    assert.equal(h.snapshot().advisesThisRun, 0);
    assert.equal(h.cellFor(0, 'click', 'click#0#甲')?.tries, 2);
  } finally {
    failureMemory.reset();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── R2-9 开关关闭零回归（autoPilot 注入面） ───

test('R2-9: 开关关闭零回归 —— 端口缺席 / enabled:false / 建议为 null ⇒ 升级路径不变', async () => {
  failureMemory.reset();
  const snapshot = makeSnap([el('设置入口', 100, 100)]);
  const makeDeps = (exploration?: ExplorationPort): AutonomyDeps => ({
    perceive: async () => snapshot,
    policy: { decide: async () => escalateDecision('no-deterministic-action') },
    execute: async () => ({ outcome: 'no_effect' }) as ExecResult,
    goal: asGoal(new StubGoal({ goal: '打开设置', successCriteria: ['设置窗口可见'] })),
    now: () => 5_000,
    sleep: async () => { /* 零真睡 */ },
    ...(exploration ? { exploration } : {}),
  });
  // 基线：端口缺席 —— policy-escalate 终局
  const base = await runAutonomousLoop(makeDeps(), { maxSteps: 6 });
  assert.equal(base.escalated, true);
  assert.equal(base.escalateReason, 'policy-escalate');
  assert.equal(base.steps, 1);
  assert.ok(!base.summary.includes('W3-7'), '零触发 ⇒ summary 逐字节不变');
  // enabled:false —— 与基线逐字段一致
  const off = await runAutonomousLoop(makeDeps({
    enabled: false,
    advise: () => { throw new Error('不应被调用'); },
    observe: () => { throw new Error('不应被调用'); },
  }), { maxSteps: 6 });
  assert.deepEqual(
    { phase: off.phase, steps: off.steps, escalated: off.escalated, escalateReason: off.escalateReason, summary: off.summary },
    { phase: base.phase, steps: base.steps, escalated: base.escalated, escalateReason: base.escalateReason, summary: base.summary },
  );
  // enabled:true 但建议为 null（常态门未过）⇒ 同基线
  const nullPort: ExplorationPort = {
    enabled: true,
    advise: () => null,
    observe: () => { /* 无消费 */ },
  };
  const nullified = await runAutonomousLoop(makeDeps(nullPort), { maxSteps: 6 });
  assert.equal(nullified.escalateReason, 'policy-escalate');
  assert.equal(nullified.steps, 1);
  // 端口抛异常 ⇒ 吞掉不炸环，同基线
  const boomPort: ExplorationPort = {
    enabled: true,
    advise: () => { throw new Error('端口故障'); },
    observe: () => { throw new Error('端口故障'); },
  };
  const boomed = await runAutonomousLoop(makeDeps(boomPort), { maxSteps: 6 });
  assert.equal(boomed.escalateReason, 'policy-escalate');
  assert.equal(boomed.steps, 1);
});

// ─── R2-10 集成：真实账本进环 ───

test('R2-10: 集成 —— 探索动作替代升级步 / journal 注记 / observe 全流回报 / 预算耗尽回归升级', async () => {
  failureMemory.reset();
  try {
    const snapshot = makeSnap([el('设置入口', 100, 100)]);
    const ledger = new ExplorationLedger('打开设置', { enabled: true });
    const executed: Act[] = [];
    const deps: AutonomyDeps = {
      perceive: async () => snapshot,
      policy: { decide: async () => escalateDecision('no-deterministic-action') },
      execute: async (action) => {
        executed.push(action);
        return { outcome: 'no_effect' } as ExecResult;
      },
      goal: asGoal(new StubGoal({ goal: '打开设置', successCriteria: ['设置窗口可见'] })),
      exploration: ledger,
      now: () => 5_000,
      sleep: async () => { /* 零真睡 */ },
    };
    const result = await runAutonomousLoop(deps, { maxSteps: 10 });
    // 探索预算 4 发全用完（click → scroll down → hotkey tab → scroll up）后回归升级终局
    assert.equal(result.escalated, true);
    assert.equal(result.escalateReason, 'policy-escalate');
    assert.equal(result.steps, 5, '4 步探索 + 1 步升级');
    const kinds = result.trajectory.map(rec => rec.action.kind);
    assert.deepEqual(kinds, ['click', 'scroll', 'hotkey', 'scroll', 'escalate']);
    // 交替律在环内同样成立（连打防线）
    assert.ok(kinds[0] !== kinds[1] && kinds[1] !== kinds[2] && kinds[2] !== kinds[3]);
    // 探索步注记与总汇报记账
    for (let i = 0; i < 4; i++) {
      assert.ok(result.trajectory[i].note?.includes('W3-7 探索建议'), `第 ${i} 步 journal 须带探索注记`);
    }
    assert.ok(result.summary.includes('W3-7 探索拦截：替代升级 4 次。'));
    // 探索动作的落格与方向取证
    const m0 = (result.trajectory[0].action.payload as { exploration?: { region?: number } }).exploration;
    assert.equal(m0?.region, R_TL);
    assert.equal((result.trajectory[1].action.payload as { direction?: string }).direction, 'down');
    assert.equal((result.trajectory[3].action.payload as { direction?: string }).direction, 'up');
    // observe 全流回报：4 个世界动作全部入账（升级步不入账）
    assert.equal(ledger.totalTryCount, 4);
    assert.equal(ledger.snapshot().advisesThisRun, 4);
    assert.deepEqual(ledger.cellFor(R_TL, 'click', 'click#0#设置入口'), { tries: 1, successes: 0 });
    assert.deepEqual(ledger.cellFor(R_CENTER, 'scroll', 'scroll#down'), { tries: 1, successes: 0 });
    assert.deepEqual(ledger.cellFor(R_CENTER, 'hotkey', 'hotkey#tab'), { tries: 1, successes: 0 });
    assert.deepEqual(ledger.cellFor(R_CENTER, 'scroll', 'scroll#up'), { tries: 1, successes: 0 });
    // 预算耗尽后的升级步与 execute 的对账：execute 只见过 4 个探索动作
    assert.equal(executed.length, 4);
    // 建议动作一律 benign（探索是低风险增益的红律）
    for (let i = 0; i < 4; i++) assert.equal(result.trajectory[i].action.riskTier, 'benign');
  } finally {
    failureMemory.reset();
  }
});

// ─── R2-11 防御：垃圾入参绝不抛 ───

test('R2-11: 防御 —— 垃圾入参与极端场景绝不抛', () => {
  failureMemory.reset();
  try {
    const ledger = new ExplorationLedger('打开设置', { enabled: true });
    // 垃圾上下文 / null
    assert.equal(ledger.advise(null as unknown as ExplorationContext), null);
    assert.equal(ledger.advise({} as ExplorationContext), null);
    assert.equal(ledger.advise({ goal: 42, snapshot: '垃圾', history: null } as unknown as ExplorationContext), null);
    // 垃圾动作 observe
    ledger.observe(null as unknown as Act, 'progress');
    ledger.observe({} as Act, 'weird' as never);
    ledger.observe(clickAction('甲', Number.NaN, 100), 'progress', VP); // 中心非法 ⇒ 跳过
    assert.equal(ledger.totalTryCount, 0);
    // 空快照（无元素）⇒ 仅剩全局轮换候选，仍可建议（恢复态门已过）
    const advice = ledger.advise(ctx({ snapshot: makeSnap([]) }));
    assert.ok(advice);
    assert.equal(advice.action.kind, 'scroll'); // 全新账：全局候选里 scroll down 居首
    // 快照为 null ⇒ 视口回退 1920×1080，全局候选照常
    assert.ok(ledger.advise(ctx({ snapshot: null })) !== null);
    // persist 到非法路径 ⇒ ok:false 绝不抛
    assert.equal(ledger.persist('').ok, false);
    assert.equal(ledger.persist('X:\\\\不存在的卷\\\\x.json' as string).ok, false);
    // LRU 有界：容量 16 的小账本灌 32 格 ⇒ 不超界
    const tiny = new ExplorationLedger('打开设置', { enabled: true, maxCells: 16 });
    for (let r = 0; r < 32; r++) {
      tiny.observe(clickAction('x', 100, 100, { region: r, modality: 'click', strategy: `click#${r}#x` }), 'no_effect', VP);
    }
    assert.ok(tiny.snapshot().cells.length <= 16);
    // reset 归零
    tiny.reset();
    assert.equal(tiny.totalTryCount, 0);
    assert.equal(tiny.snapshot().cells.length, 0);
  } finally {
    failureMemory.reset();
  }
});

// ─── ΑΩ-R22：容量驱逐复杂度（懒最小堆索引）───

/** ΑΩ-R22：带预标的点击（驱逐差分用最小动作面 —— (region,modality,strategy) 唯一即唯一格） */
function markedClick(region: number, strategy: string): Act {
  return clickAction('x', 5, 5, { region, modality: 'click', strategy });
}

/**
 * ΑΩ-R22：旧驱逐判据的对照实现 —— 与改造前 evictOverflow 逐字节同逻辑
 * （全扫 min-lru、Map 迭代序破平），驱动影子账（key → lru）做差分对照。
 */
function legacyObserveEvict(
  shadow: Map<string, number>, tick: { n: number }, key: string, maxCells: number,
): void {
  shadow.set(key, ++tick.n);
  while (shadow.size > maxCells) {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, lru] of shadow) {
      if (lru < oldest) { oldest = lru; oldestKey = k; }
    }
    if (oldestKey === null) break;
    shadow.delete(oldestKey);
  }
}

/** ΑΩ-R22：账本在册格键集（与影子账做集合对照） */
function ledgerKeys(ledger: ExplorationLedger): Set<string> {
  return new Set(ledger.snapshot().cells.map(c => cellKey(c.region, c.modality, c.strategy)));
}

test('R22-A: 大账本驱逐 —— 懒堆索引与旧判据逐格一致（>4096 格）', () => {
  failureMemory.reset();
  // maxCells 缺省 4096（EXPLORATION_MAX_CELLS_DEFAULT）
  const ledger = new ExplorationLedger('打开设置', { enabled: true });
  const shadow = new Map<string, number>();
  const tick = { n: 0 };
  const feed = (region: number, strategy: string): void => {
    ledger.observe(markedClick(region, strategy), 'no_effect', VP);
    legacyObserveEvict(shadow, tick, cellKey(region, 'click', strategy), 4096);
  };
  // 灌 4210 格（> 4096 上限 ⇒ 连续 114 次驱逐，期间每笔 observe 都走索引弹出）
  for (let i = 0; i < 4210; i++) feed(i % 96, `s${i}`);
  // 回触：升 lru 的再观察（含早已被驱逐的 s0 —— 「删后重建」的懒失效压力面）
  for (let i = 0; i < 4210; i += 213) feed(i % 96, `s${i}`);
  // 再灌 30 新格 ⇒ 每笔都驱逐
  for (let i = 4210; i < 4240; i++) feed(i % 96, `s${i}`);
  assert.equal(ledger.snapshot().cells.length, 4096, '驱逐后恰压回容量上限');
  assert.equal(ledger.evictIndexDegraded, false, '正常路径索引不降级');
  // 差分对照：同输入 ⇒ 同被驱逐集合（在册键集与旧判据影子账逐格一致）
  assert.deepEqual(ledgerKeys(ledger), new Set(shadow.keys()));
  // 索引内存有界：压实阈值（2×在册格 + 64）之内
  const internals = ledger as unknown as { evictIndex: unknown[] };
  assert.ok(internals.evictIndex.length <= 4096 * 2 + 64, `堆长 ${internals.evictIndex.length} 越界`);
});

test('R22-B: 索引与主账本同步 —— 插入/恢复/持久化往返后驱逐仍与旧判据一致', () => {
  failureMemory.reset();
  const dir = mkdtempSync(join(tmpdir(), 'w3explore-r22-'));
  try {
    const file = join(dir, 'ledger.json');
    // 阶段一：小账本（容量 16）灌 24 格 ⇒ 8 次驱逐；影子账同步差分
    const a = new ExplorationLedger('打开设置', { enabled: true, maxCells: 16 });
    const shadowA = new Map<string, number>();
    const tickA = { n: 0 };
    for (let i = 0; i < 24; i++) {
      const region = i % 96, strategy = `s${i}`;
      a.observe(markedClick(region, strategy), 'no_effect', VP);
      legacyObserveEvict(shadowA, tickA, cellKey(region, 'click', strategy), 16);
    }
    assert.equal(a.snapshot().cells.length, 16);
    assert.deepEqual(ledgerKeys(a), new Set(shadowA.keys()));
    assert.equal(a.evictIndexDegraded, false);
    // 阶段二：持久化 ⇒ 新账本恢复 ⇒ 快照逐字段往返（cells / regionTries / 总账）
    assert.equal(a.persist(file).ok, true);
    const b = new ExplorationLedger('打开设置', { enabled: true, maxCells: 16 });
    const resB = b.restore(file);
    assert.equal(resB.ok, true);
    assert.equal(resB.restored, 16);
    assert.deepEqual(b.snapshot().cells, a.snapshot().cells);
    assert.deepEqual(b.snapshot().regionTries, a.snapshot().regionTries);
    assert.equal(b.totalTryCount, a.totalTryCount);
    assert.equal(b.evictIndexDegraded, false);
    // 阶段三：恢复后继续观察 + 驱逐 —— 影子账按恢复语义重放（恢复格按落盘序
    // （region,modality,strategy 排序）重编 lru 1..16 —— 与实现同律），差分一致
    const shadowB = new Map<string, number>();
    const tickB = { n: 0 };
    for (const c of a.snapshot().cells) {
      shadowB.set(cellKey(c.region, c.modality, c.strategy), ++tickB.n);
    }
    for (let i = 100; i < 118; i++) {
      const region = i % 96, strategy = `s${i}`;
      b.observe(markedClick(region, strategy), 'no_effect', VP);
      legacyObserveEvict(shadowB, tickB, cellKey(region, 'click', strategy), 16);
    }
    assert.equal(b.snapshot().cells.length, 16);
    assert.deepEqual(ledgerKeys(b), new Set(shadowB.keys()));
    assert.equal(b.evictIndexDegraded, false);
  } finally {
    failureMemory.reset();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R22-C: 防御 —— 索引覆盖破损回退全扫并注记，驱逐结果仍与旧判据一致', () => {
  failureMemory.reset();
  const ledger = new ExplorationLedger('打开设置', { enabled: true, maxCells: 16 });
  const shadow = new Map<string, number>();
  const tick = { n: 0 };
  for (let i = 0; i < 16; i++) {
    const region = i % 96, strategy = `s${i}`;
    ledger.observe(markedClick(region, strategy), 'no_effect', VP);
    shadow.set(cellKey(region, 'click', strategy), ++tick.n);
  }
  assert.equal(ledger.evictIndexDegraded, false);
  // 人为破损：向 cells 直注 4 个无索引目的格（绕过 observe —— 模拟索引与主账本
  // 失同步；lru 取小数保证与真实 tick 不并列），再把索引整体替换为全陈旧目
  const internals = ledger as unknown as {
    cells: Map<string, { region: number; modality: 'click'; strategy: string; tries: number; successes: number; lru: number }>;
    evictIndex: Array<{ lru: number; key: string }>;
    evictOverflow(): void;
  };
  const injected: ReadonlyArray<readonly [number, number]> = [[100, 0.5], [101, 5.5], [102, 11.5], [103, 16.5]];
  for (const [i, lru] of injected) {
    const region = i % 96, strategy = `s${i}`;
    internals.cells.set(cellKey(region, 'click', strategy), { region, modality: 'click', strategy, tries: 1, successes: 0, lru });
    shadow.set(cellKey(region, 'click', strategy), lru);
  }
  internals.evictIndex = [{ lru: -1, key: 'ghost-a' }, { lru: -2, key: 'ghost-b' }];
  internals.evictOverflow();
  // 注记降级为真；驱逐结果与旧判据影子账逐格一致（全扫回退保证语义不变）
  assert.equal(ledger.evictIndexDegraded, true);
  while (shadow.size > 16) {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, lru] of shadow) if (lru < oldest) { oldest = lru; oldestKey = k; }
    if (oldestKey === null) break;
    shadow.delete(oldestKey);
  }
  assert.equal(ledger.snapshot().cells.length, 16);
  assert.deepEqual(ledgerKeys(ledger), new Set(shadow.keys()));
  // 自愈：注记粘性，但索引已重建 —— 后续驱逐恢复索引路径且仍与旧判据一致
  ledger.observe(markedClick(50, 's-new'), 'no_effect', VP);
  legacyObserveEvict(shadow, tick, cellKey(50, 'click', 's-new'), 16);
  assert.deepEqual(ledgerKeys(ledger), new Set(shadow.keys()));
  assert.equal(ledger.evictIndexDegraded, true, '注记粘性（reset 才归零）');
  ledger.reset();
  assert.equal((ledger as unknown as { evictDegraded: boolean }).evictDegraded, false, 'reset 归零注记');
  assert.equal(ledger.snapshot().cells.length, 0);
});
