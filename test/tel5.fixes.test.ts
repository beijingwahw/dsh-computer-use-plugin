// test/tel5.fixes.test.ts
// ΤΕΛ-5（ΤΕΛΟΣ 纪元 · 债务清偿工单 T1-5）：D-G21..D-G26 六条债务的执法测试册。
//   D-G21①  autoPilot 宿主接线 mint 返回号 → settle 严格配对（ΠΑΝ-54 引擎面
//           已就绪，本册锁宿主半边：号透传 + 消费后不重喂陈号）
//   D-G21②  gym 实验室 hammingTolerance margin 换原始距离口径（ΠΑΝ-52 生产面
//           同域 —— 对合振荡根除的实验室跟进）
//   D-G22   POPUP_CONFIRM_RE「是」汉字邻接收窄 + 弹窗栖息地（中央 40% 带）
//           bounds 校验（policyEngine 决策层；autoPilot 层 ΠΑΝ-119 闸为纵深）
//   D-G23   system.ts 键鼠包装层接线 ioMutex 取消端口（serialize 第三参 →
//           AbortController.abort → D-5 microFetch 断流；源级金丝雀）
//   D-G25③  检疫离散臂换 MAD 口径（IQR 等价换算 —— 少源时四分位插值不再把
//           毒隙半程混进阈：2 诚实 + 1 毒的 k=3 组毒源照常计票）
// 全离线、确定性、零真屏零网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runAutonomousLoop } from '../src/autonomy/autoPilot.ts';
import type { AutonomyDeps } from '../src/autonomy/autoPilot.ts';
import { PolicyEngine } from '../src/autonomy/policyEngine.ts';
import { POPUP_CONFIRM_RE, centerInPopupHabitat } from '../src/autonomy/policyEngineUtil.ts';
import type { WorldSnapshot, SnapshotElement } from '../src/autonomy/worldSnapshot.ts';
import type { GoalSpec, GoalProgress } from '../src/autonomy/goalState.ts';
import type { PolicyAction } from '../src/autonomy/policyEngine.ts';
import { AutonomyGym } from '../src/autonomy/gym.ts';
import { aggregateSkillShares } from '../src/skillFederation.ts';
import type { SkillFederationUpload } from '../src/skillFederation.ts';
import { robustDispersionOf, robustMergeDigests } from '../src/federation/aggregate.ts';
import type { EvidenceDigest } from '../src/federation/index.ts';

// ══════════════════ D-G21①：autoPilot 宿主接线铸造号严格配对 ══════════════════

type Snap = Awaited<ReturnType<AutonomyDeps['perceive']>>;

function snapOf(dhash: string): Snap {
  return {
    takenAt: 1_000, width: 1920, height: 1080, dhash,
    elements: [], textDigest: '', popups: [], focusedRegion: null,
    sceneLabel: '测试桌面', degraded: [],
  };
}

/** 手写目标机桩（autonomy.autoPilot.test.ts 同款契约的面具） */
class StubGoal {
  readonly spec: GoalSpec;
  readonly progress: { steps: number; criteria: Array<'met' | 'violated' | 'pending'>; blockers: string[] };
  began = false;
  tickCount = 0;
  constructor(s: GoalSpec) {
    this.spec = s;
    this.progress = { steps: 0, criteria: s.successCriteria.map(() => 'pending' as const), blockers: [] };
  }
  begin(): void { this.began = true; }
  tick(): void { this.tickCount++; this.progress.steps = this.tickCount; }
  recordCriterion(index: number, status: 'met' | 'violated'): void {
    this.progress.criteria[index] = status;
  }
  evaluate(): { phase: 'planning' | 'acting' | 'verifying' | 'blocked' | 'achieved' | 'failed' | 'aborted'; reason: string } {
    const c = this.progress.criteria;
    if (c.length > 0 && c.every(s => s === 'met')) return { phase: 'achieved', reason: '全部成功判据已满足' };
    if (c.some(s => s === 'violated')) return { phase: 'failed', reason: '命中失败判据' };
    if (this.progress.blockers.length > 0) return { phase: 'blocked', reason: this.progress.blockers[0] };
    return { phase: this.began ? 'acting' : 'planning', reason: '进行中' };
  }
  toAnchor(): Record<string, unknown> { return { steps: this.tickCount, began: this.began }; }
}

function clickAction(label: string): PolicyAction {
  return {
    kind: 'click',
    target: { bbox: { x0: 10, y0: 20, x1: 60, y1: 50 }, center: { x: 35, y: 35 }, label },
    rationale: `点击「${label}」`, expectedEffect: '目标界面出现', utility: 0.8, riskTier: 'benign',
  };
}

const INSPECT_ACTION: PolicyAction = {
  kind: 'inspect',
  rationale: '观察当前界面收集线索', expectedEffect: '获得更多上下文', utility: 0.3, riskTier: 'benign',
};

test('ΤΕΛ-5 D-G21①: autoPilot 把 mint 返回号透传 settle —— 严格配对 + 真见证消费后不重喂陈号', async () => {
  const mintCalls: Array<{ screenType: string; actionKey: string }> = [];
  const settleCalls: Array<{ actual: string | null; success: boolean | undefined; id: number | undefined }> = [];
  let mintSeq = 1000;
  const prophecyPort = {
    mint: (screenType: string, actionKey: string): number | null => {
      mintCalls.push({ screenType, actionKey });
      return ++mintSeq; // 恒有号（屏型在场 + 世界动作）
    },
    settle: (
      actualType: string | null,
      success?: boolean,
      prophecyId?: number,
    ): null => {
      settleCalls.push({ actual: actualType ?? null, success, id: prophecyId });
      return null; // 桩不产结算记录（journal 注记路径不参与本断言）
    },
  };

  const spec: GoalSpec = { goal: '完成两步点击', successCriteria: ['判据一', '判据二'] };
  const goal = new StubGoal(spec);
  const dhashes = ['aaaa1111aaaa1111', 'bbbb2222bbbb2222', 'cccc3333cccc3333', 'dddd4444dddd4444'];
  let perceiveIdx = 0;
  let decideIdx = 0;
  // 决策序：click（铸 1001）→ inspect（no-impact 不铸 —— ΝΩ-11 闸）→ click（铸 1002，判据全中 ⇒ 终局）
  const decisions = [
    { action: clickAction('第一步'), uncertain: false, degraded: false },
    { action: INSPECT_ACTION, uncertain: false, degraded: false },
    {
      action: clickAction('第二步'),
      uncertain: false, degraded: false,
      criteriaEvidence: [{ index: 0, status: 'met' as const }, { index: 1, status: 'met' as const }],
    },
  ];
  let execIdx = 0;
  const execOutcomes = [
    { outcome: 'progress' as const },
    { outcome: 'progress' as const },
    {
      outcome: 'progress' as const,
      criteriaEvidence: [{ index: 0, status: 'met' as const }, { index: 1, status: 'met' as const }],
    },
  ];

  const deps: AutonomyDeps = {
    perceive: async () => snapOf(dhashes[Math.min(perceiveIdx++, dhashes.length - 1)]),
    policy: { decide: async () => decisions[Math.min(decideIdx++, decisions.length - 1)] },
    execute: async () => execOutcomes[Math.min(execIdx++, execOutcomes.length - 1)],
    goal: goal as unknown as AutonomyDeps['goal'],
    prophecy: prophecyPort,
    sleep: async () => { throw new Error('本用例不得睡眠'); },
    now: () => 1_000,
  };

  const res = await runAutonomousLoop(deps);
  assert.equal(res.phase, 'achieved', '三步终局（前置：决策/执行桩按序消耗）');

  // 铸造账：click 两枚有号；inspect（no-impact）不铸 —— ΝΩ-11 闸保持
  assert.equal(mintCalls.length, 2, '两次世界动作各铸一枚（inspect 不铸）');
  const mintIds = [1001, 1002];

  // 结算账（关键断言）：
  //   感知#1（环首，先于任何铸造）⇒ 无号（undefined —— 不能把陈号/伪号喂给引擎）
  //   感知#2（click#1 之后）⇒ 恰是 mint 返回的 1001（严格配对透传）
  //   感知#3（inspect 之后 —— 无新铸）⇒ undefined（1001 已被真见证消费，不重喂
  //     —— 重喂会在引擎侧重复累计 noMatch 噪声）
  const withId = settleCalls.filter(s => s.id !== undefined);
  assert.deepEqual(
    settleCalls.map(s => s.id),
    [undefined, 1001, undefined],
    `settle 的号序 = [无, 1001, 无]（实测 ${JSON.stringify(settleCalls.map(s => s.id))}）`,
  );
  assert.deepEqual(withId.map(s => s.id), mintIds.slice(0, 1), '有号结算恰与未消费铸造号一一配对');
  // 感知序即结算见证序（dhash 逐帧不同）
  assert.deepEqual(settleCalls.map(s => s.actual), dhashes.slice(0, 3));
  // success 语义：归属步 progress ⇒ true（回灌闸口径）；环首无归属步 ⇒ undefined
  assert.equal(settleCalls[0]!.success, undefined);
  assert.equal(settleCalls[1]!.success, true);
});

test('ΤΕΛ-5 D-G21①: mint 返回 null（未铸）⇒ settle 无号 —— LIFO 兼容面不伪造', async () => {
  const settleIds: Array<number | undefined> = [];
  const prophecyPort = {
    mint: (): number | null => null, // 未铸（引擎契约：盲屏/铸造故障 ⇒ null）
    settle: (_a: string | null, _s?: boolean, id?: number): null => {
      settleIds.push(id);
      return null;
    },
  };
  const spec: GoalSpec = { goal: '单步', successCriteria: ['判据一'] };
  const goal = new StubGoal(spec);
  let perceiveIdx = 0;
  let execIdx = 0;
  const deps: AutonomyDeps = {
    perceive: async () => snapOf(perceiveIdx++ === 0 ? 'aaaa1111aaaa1111' : 'bbbb2222bbbb2222'),
    policy: {
      decide: async () => ({
        action: clickAction('唯一一步'),
        uncertain: false, degraded: false,
        criteriaEvidence: [{ index: 0, status: 'met' as const }],
      }),
    },
    execute: async () => ({
      outcome: 'progress' as const,
      criteriaEvidence: [{ index: 0, status: 'met' as const }],
    }),
    goal: goal as unknown as AutonomyDeps['goal'],
    prophecy: prophecyPort,
    sleep: async () => { throw new Error('本用例不得睡眠'); },
    now: () => 1_000,
  };
  void execIdx;
  const res = await runAutonomousLoop(deps);
  assert.equal(res.phase, 'achieved');
  assert.ok(settleIds.length >= 1);
  assert.ok(settleIds.every(id => id === undefined), '未铸 ⇒ 全部无号（绝不伪造预言号）');
});

// ══════════════════ D-G21②：gym 实验室 margin 原始距离口径 ══════════════════

test('ΤΕΛ-5 D-G21②: gym 训练后 hammingTolerance 记账 margin 全落在原始距离域（≥0 整数）+ 记录点源码锁', async () => {
  const gym = new AutonomyGym({ seed: 4242 });
  assert.ok(gym.lab, '缺省构造 ⇒ 馆内自铸实验室套件');
  await gym.train(2);
  const stats = gym.lab.ledger.stats('world.hammingTolerance');
  assert.ok(stats.n >= 1, `应有记账（实测 n=${stats.n}）`);
  // 原始距离域：margin = dhash 汉明距离（非负整数）。旧口径的有符号臂
  // （distance − tolerance）在「容差过紧误报」样本上产出负 margin —— 新域
  // 中 margin 分布与容差现值解耦（ΠΑΝ-52 对合振荡论证），负值/非整数即红。
  for (const m of stats.margins) {
    assert.ok(
      typeof m === 'number' && Number.isInteger(m) && m >= 0,
      `margin 须为非负整数（原始距离域）—— 实测 ${String(m)}`,
    );
  }
  // 记录点源码锁：margin 表达式 = distance 直录；旧差值形态不得回潮
  const src = readFileSync(resolve(process.cwd(), 'src/autonomy/gym.ts'), 'utf8');
  assert.ok(src.includes('ΤΕΛ-5 D-G21②'), '立法注释在场（margin 去内生 · 实验室跟进）');
  assert.ok(
    src.includes('distance === null ? 0 : distance,'),
    'margin = 原始距离直录（指纹缺席 ⇒ 0 占位）',
  );
  assert.ok(
    !src.includes('Math.abs(distance - tolerance)') && !src.includes('agree ? Math.abs'),
    '旧 |距离−容差| / 有符号差值形态不得回潮（对合振荡源）',
  );
});

// ══════════════════ D-G22：弹窗确认词面收窄 + 栖息地 bounds 校验 ══════════════════

function elem(label: string, o: Partial<SnapshotElement> = {}): SnapshotElement {
  const bbox = o.bbox ?? { x0: 700, y0: 420, x1: 800, y1: 460 }; // 缺省落栖息地内（1920×1080 中央带）
  return {
    label,
    role: o.role ?? 'button',
    bbox,
    center: o.center ?? { x: (bbox.x0 + bbox.x1) / 2, y: (bbox.y0 + bbox.y1) / 2 },
    confidence: o.confidence ?? 0.8,
    source: o.source ?? 'local',
    interactive: o.interactive === undefined ? true : o.interactive,
  };
}

function snap(o: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    takenAt: 1, width: o.width ?? 1920, height: o.height ?? 1080,
    dhash: o.dhash ?? null, elements: o.elements ?? [], textDigest: '',
    popups: o.popups ?? [], focusedRegion: null, sceneLabel: 'desktop', degraded: [],
  };
}

function pctx(o: { snapshot?: Partial<WorldSnapshot> }): Parameters<PolicyEngine['decide']>[0] {
  const s: GoalSpec = { goal: '关闭弹窗', successCriteria: ['主界面恢复'] };
  const g: GoalProgress = {
    phase: 'acting', stepIndex: 1,
    criteriaStatus: [{ criterion: '主界面恢复', status: 'unverified' as const }],
    startedAt: 1, lastUpdateAt: 2, blockers: [],
  };
  return { snapshot: snap(o.snapshot ?? {}), spec: s, goal: g, history: [] };
}

test('ΤΕΛ-5 D-G22a: POPUP_CONFIRM_RE「是」汉字邻接守卫 ——「是否/但是/是的」不中，「是/是(Y)/OK」照中', () => {
  const hit = (s: string): boolean => POPUP_CONFIRM_RE.test(s.toLowerCase().replace(/\s+/g, ' ').trim());
  assert.ok(hit('是'), '独立按钮「是」命中');
  assert.ok(hit('是(Y)'), '「是(Y)」命中（后邻非汉字）');
  assert.ok(hit('yes'), 'yes 整词命中');
  assert.ok(hit('OK 恢复出厂设置'), 'ok 整词命中（既有锚）');
  assert.ok(hit('确认保存'), '多字中文词保持子串律');
  // 收窄面：单字「是」前后邻汉字 ⇒ 句子文案，不是确认按钮
  assert.ok(!hit('是否删除此文件'), '「是否」疑问文案不中（旧律误中）');
  assert.ok(!hit('但是'), '「但是」转折文案不中');
  assert.ok(!hit('是的，已为您保存'), '「是的」陈述文案不中');
});

test('ΤΕΛ-5 D-G22b: 弹窗确认点击限定栖息地 —— 界外同词位置退 Esc（fail-closed），界内照点', async () => {
  const engine = new PolicyEngine();
  const OUTSIDE = { x0: 10, y0: 20, x1: 110, y1: 60 }; // 左上角（1920×1080 中央 40% 带外）
  // 债项主诉场景：弹窗在场，主界面角落有同词「确定」⇒ 不得以「弹窗确认」身份点掉
  const esc = await engine.decide(
    pctx({ snapshot: { popups: ['系统提示'], elements: [elem('确定', { bbox: OUTSIDE })] } }),
  );
  assert.equal(esc.action.kind, 'hotkey', '界外确认词面 ⇒ 退 Esc（不点弹窗外未知目标）');
  assert.deepEqual(esc.action.payload, { keys: ['esc'] });

  // 界内照点（回归锚）
  const click = await engine.decide(
    pctx({ snapshot: { popups: ['系统提示'], elements: [elem('确定')] } }),
  );
  assert.equal(click.action.kind, 'click');
  assert.equal(click.action.target?.label, '确定');

  // 几何缺席 ⇒ fail-closed（快照无宽高不给免检通行）
  const noGeom = await engine.decide(
    pctx({ snapshot: { width: 0, height: 0, popups: ['系统提示'], elements: [elem('确定')] } }),
  );
  assert.equal(noGeom.action.kind, 'hotkey', '宽高缺席 ⇒ Esc（判不出落点 = 不点）');
});

test('ΤΕΛ-5 D-G22c: centerInPopupHabitat 纯函数律 —— 判据带 / 边界值 / 几何回退与缺席', () => {
  const W = 1920, H = 1080; // 中央 40% 带 = [576,1344]×[324,756]
  assert.ok(centerInPopupHabitat({ center: { x: 960, y: 540 } }, W, H), '屏心在带内');
  assert.ok(centerInPopupHabitat({ center: { x: 576, y: 324 } }, W, H), '带边界（闭区间）在带内');
  assert.ok(!centerInPopupHabitat({ center: { x: 575.9, y: 540 } }, W, H), '带左界外一步即出');
  assert.ok(!centerInPopupHabitat({ center: { x: 60, y: 40 } }, W, H), '左上角出带');
  assert.ok(
    centerInPopupHabitat({ bbox: { x0: 700, y0: 420, x1: 800, y1: 460 } }, W, H),
    'center 缺席 ⇒ bbox 中点回退',
  );
  assert.ok(!centerInPopupHabitat({ bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }, W, H), 'bbox 回退同律判带');
  assert.ok(!centerInPopupHabitat({ label: '确定' }, W, H), '无几何 ⇒ false（fail-closed）');
  assert.ok(!centerInPopupHabitat({ center: { x: 960, y: 540 } }, 0, H), '宽缺席 ⇒ false');
  assert.ok(!centerInPopupHabitat(null, W, H), '元素缺席 ⇒ false');
  assert.ok(!centerInPopupHabitat({ center: { x: Number.NaN, y: 540 } }, W, H), '非有限坐标 ⇒ false');
});

// ══════════════════ D-G23：system.ts 取消端口接线（源级金丝雀） ══════════════════

test('ΤΕΛ-5 D-G23: 五处 D-5 键鼠 serialize 调用均接取消端口 + signal 透传门面（源码锁）', () => {
  const sys = readFileSync(resolve(process.cwd(), 'src/system.ts'), 'utf8');
  // 五个包装（clickMouse/moveMouse/typeText/dragMouse/scroll）各挂一个 AbortController
  assert.equal(
    (sys.match(/const io = new AbortController\(\);/g) ?? []).length,
    5,
    '五处 D-5 路径各持一个取消控制器',
  );
  assert.equal(
    (sys.match(/\(\) => io\.abort\(\),/g) ?? []).length,
    5,
    '五处 serialize 第三参均为 abort 端口（超时即断流 —— ΠΑΝ-33 恢复通路接线）',
  );
  for (const needle of [
    'backend.clickMouse(nx, ny, button as \'left\' | \'right\' | \'middle\', dryRun, undefined, io.signal)',
    'backend.moveMouse(nx, ny, durationMs, dryRun, io.signal)',
    'backend.typeText(text, clearFirst, dryRun, undefined, io.signal)',
    'io.signal,',
    'backend.scrollPage(direction, amount, dryRun, undefined, io.signal)',
  ]) {
    assert.ok(sys.includes(needle), `signal 抵达 D-5 调用面：${needle.slice(0, 48)}…`);
  }
  assert.ok(sys.includes('ΤΕΛ-5 D-G23'), '立法注释在场');

  // 门面透传面：physicalBackend 六个键鼠门面接收并透传 signal（adapter ΠΑΝ-64 管线）
  const pb = readFileSync(resolve(process.cwd(), 'src/physicalBackend.ts'), 'utf8');
  assert.ok(pb.includes('ΤΕΛ-5 D-G23'), '门面立法注释在场');
  assert.equal(
    (pb.match(/signal\?: AbortSignal/g) ?? []).length,
    6,
    '六门面（click/type/scroll/hotkey/drag/move）各增可选 signal 形参',
  );
  assert.equal(
    (pb.match(/dryRun, surface, signal \}/g) ?? []).length,
    5,
    '五处 surface 族门面把 signal 铸进 adapter args',
  );
  assert.ok(pb.includes('durationMs, dryRun, signal }'), 'moveMouse 门面同律透传');
});

// ══════════════════ D-G25③：检疫离散臂 MAD 口径（少源毒值不拉爆阈） ══════════════════

function skillShare(fingerprint: string, dxMedian: number): SkillFederationUpload {
  return {
    v: 1,
    fingerprint,
    slotStats: { dx: { median: dxMedian, iqr: 0 } },
    reliability: 0.8,
    useCount: 10,
  };
}

test('ΤΕΛ-5 D-G25③a: robustDispersionOf 纯函数律 —— IQR 等价换算 + 毒值隔离', () => {
  assert.equal(robustDispersionOf([]), 0, '空集 ⇒ 0');
  assert.equal(robustDispersionOf([5, 5, 5]), 0, '同匀 ⇒ 0（地板臂独裁 —— epochMu2 回归锚）');
  // IQR 等价锚：[0,1,2,3] 的 IQR = 2；MAD = 1 ⇒ 2×MAD = 2（同尺度）
  assert.equal(robustDispersionOf([0, 1, 2, 3]), 2, '对称分布与旧 IQR 律同值');
  // 毒值隔离（债项主诉）：旧 iqrOf([0,1,2,5000]) 的插值 q3 半程含毒 ⇒ IQR≈1250；
  // MAD 的 devs 中位仍由诚实簇决定 ⇒ 离散臂不再被单条毒值拉爆
  assert.ok(robustDispersionOf([0, 1, 2, 5000]) <= 4, '单条毒值拉不动离散臂（实测不超诚实簇尺度）');
});

test('ΤΕΛ-5 D-G25③b: 2 诚实 + 1 毒（k=3 组）毒源照常计票、诚实源零票 —— 旧 2×IQR 律的吞没域闭合', () => {
  const fp = 'tel5d25:fp';
  // 旧律数值复算：iqrOf([0.5,0.5,5.0]) = 2.25 ⇒ 2×IQR = 4.5 = 毒偏差 ⇒ 不 > 阈 ⇒
  // 毒源零票（被吞）—— 本断言域在 F2-8 测试注记为「≥4 诚实源可用域」之外的
  // 已知保守面；MAD 口径下 MAD([0.5,0.5,5.0]) = 0 ⇒ 臂 0 ⇒ T = 3×0.05 = 0.15。
  const rr = aggregateSkillShares(
    [skillShare(fp, 0.5), skillShare(fp, 0.5), skillShare(fp, 5.0)],
    { sourceIds: ['a', 'b', 'poison'] },
  );
  assert.equal(rr.aggregated.length, 1, 'k=3 过拒聚门');
  assert.equal(rr.aggregated[0]!.slotStats.dx!.median, 0.5, '中位数隔离毒源（既有律）');
  assert.ok((rr.quarantined['poison'] ?? 0) >= 1, `毒源计票（实测 ${String(rr.quarantined['poison'] ?? 0)}）`);
  assert.equal(rr.quarantined['a'] ?? 0, 0, '诚实源 a 零票');
  assert.equal(rr.quarantined['b'] ?? 0, 0, '诚实源 b 零票');
});

test('ΤΕΛ-5 D-G25③c: 3 诚实 + 1 毒（k=4 组）与 4 诚实 + 1 毒（k=5 组）回归锚 —— 既有可用域不回退', () => {
  const fp = 'tel5d25:fp4';
  const rr4 = aggregateSkillShares(
    [skillShare(fp, 10), skillShare(fp, 10.05), skillShare(fp, 10.1), skillShare(fp, 99)],
    { sourceIds: ['a', 'b', 'c', 'poison'] },
  );
  assert.ok((rr4.quarantined['poison'] ?? 0) >= 1, 'k=4 毒源计票');
  assert.ok(
    (rr4.quarantined['a'] ?? 0) === 0 && (rr4.quarantined['b'] ?? 0) === 0 && (rr4.quarantined['c'] ?? 0) === 0,
    'k=4 诚实源零票',
  );
  const rr5 = aggregateSkillShares(
    [skillShare(fp, 10), skillShare(fp, 10.05), skillShare(fp, 10.1), skillShare(fp, 10.15), skillShare(fp, 5000)],
    { sourceIds: ['a', 'b', 'c', 'd', 'poison'] },
  );
  assert.ok((rr5.quarantined['poison'] ?? 0) >= 1, 'k=5 毒源计票（pan6975 既有域）');
  for (const h of ['a', 'b', 'c', 'd']) {
    assert.equal(rr5.quarantined[h] ?? 0, 0, `k=5 诚实源 ${h} 零票`);
  }
});

test('ΤΕΛ-5 D-G25③d: robustMergeDigests 同律面 —— 诚实簇 + 毒源：毒票在、诚实零票（aggregate.ts 半边）', () => {
  const K = 'tel5.d25';
  const binsOf = (v: number): number[][] => Array.from({ length: 16 }, () => [v, v]);
  const digestOf = (v: number): EvidenceDigest => ({
    v: 1, mintedAt: 1_000, epsilon: 1,
    keys: [{ key: K, n: 10, bins: binsOf(v) }],
  });
  const rr = robustMergeDigests(
    [digestOf(100), digestOf(100), digestOf(102), digestOf(5100)],
    { sourceIds: ['a', 'b', 'c', 'poison'] },
  );
  assert.ok(rr.merged, '合并产物在场');
  assert.ok((rr.quarantined['poison'] ?? 0) >= 1, `毒源逐格计票（实测 ${String(rr.quarantined['poison'] ?? 0)}）`);
  for (const h of ['a', 'b', 'c']) {
    assert.equal(rr.quarantined[h] ?? 0, 0, `诚实源 ${h} 零票`);
  }
});
