// test/epochEpsilon.prophecy.test.ts
// 纪元 Ε（预言引擎）执法册 —— 自主环的动作前预言 + 动作后对账（可审计 Dyna 旁路）。
// 全离线确定性：零网络、零真钟（全部注入时钟）、零真睡；一切期望值按
// worldModel 的 Laplace 平滑数学手算硬编码。执法编号：
//   Ε-1 铸预言与结算数学：注入假 worldModel（转移表可编程）⇒ predictedType/概率
//       正确；hit/miss/no-model 三态判定正确；miss 的惊异差值为正（错比对更响）
//   Ε-2 闭环接线：假栈跑 2 步（第一步命中第二步失手）⇒ 账本两条、journal 注记
//       在场、PilotResult 既有字段与开关关闭时 deepEqual（预言不可见性执法 ——
//       除注记外零影响）；栈层 enableProphecy 缺省铸进 / false 字段缺席
//   Ε-3 错题本：多次失手后 prophecyStats 的 TopK 失手 (屏型,动作) 正确、命中率
//       正确（no-model 不掺水）；dump/restore 往返 + 坏行半水合
//   Ε-4 诚实律：worldModel 无该转移 ⇒ no-model 绝不伪造；执行后屏型取不到 ⇒
//       挂起作废计数（60s TTL），不产伪结算、不产伪注记
//   Ε-5 永不抛：假 worldModel throw ⇒ 环照常完成、账本零污染（无伪造预言字段）；
//       端口全抛 ⇒ PilotResult 与关闭时逐字段全等；环形 500 封顶（逐出最旧）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runAutonomousLoop,
  type AutonomyDeps,
  type PilotResult,
  type StepRecord,
} from '../src/autonomy/autoPilot.ts';
import { GoalStateMachine } from '../src/autonomy/goalState.ts';
import type { PolicyDecision } from '../src/autonomy/policyEngine.ts';
import { buildAutonomyStack } from '../src/autonomy/index.ts';
import type { Config } from '../src/config.ts';
import type { WorldSnapshot } from '../src/autonomy/worldSnapshot.ts';
import { InMemoryWorldModel } from '../src/knowledge/worldModel.ts';
import type {
  KnowledgeError, Result, SurpriseReport, TransitionPrediction, WorldModel,
} from '../src/knowledge/contracts.ts';
import {
  ProphecyEngine,
  mintProphecy,
  settleProphecy,
  prophecyActionKey,
  prophecyJournalTag,
  type ProphecyLedgerSnapshot,
  type ProphecyPort,
  type ProphecyRecord,
} from '../src/prophecy/index.ts';

// ─── 假件工坊（全部字面量，零真感知/零网络/零真钟） ───

type Act = StepRecord['action'];

/** 快照工厂 —— dhash 即屏型指纹（闭环语境的屏幕身份）；宽高 1920×1080 定死（动作键量化锚） */
function snap(dhash: string | null): WorldSnapshot {
  return {
    takenAt: 1, width: 1920, height: 1080, dhash,
    elements: [], textDigest: '', popups: [], focusedRegion: null,
    sceneLabel: '', degraded: [],
  };
}

/** 点击动作字面量（center (35,35) ÷ 1920×1080 ⇒ 归一化 0.018 ⇒ 量化格 00 ⇒ 'click@00'） */
function clickAction(label: string): Act {
  return {
    kind: 'click',
    target: { bbox: { x0: 10, y0: 20, x1: 60, y1: 50 }, center: { x: 35, y: 35 }, label },
    rationale: `点击「${label}」`,
    expectedEffect: '目标界面出现',
    utility: 0.8,
    riskTier: 'benign',
  };
}

/** 升级动作字面量（闭环 ⑤：记 no_effect 步后 escalated 终局，不执行不铸预言） */
const ESCALATE_ACTION: Act = {
  kind: 'escalate',
  rationale: '目标元素在屏幕上不存在',
  expectedEffect: '移交上级决策',
  utility: 0.1,
  riskTier: 'benign',
};

/** 单决定字面量 */
function dec(action: Act): PolicyDecision {
  return { action, uncertain: false, degraded: false };
}

/** 全量默认 autonomy 配置（纪元 Ε 键齐备，可局部覆盖） */
function makeConfig(over: Partial<Config> = {}): Config {
  return {
    autonomyEnabled: true,
    autonomyMaxSteps: 24,
    autonomyTimeBudgetSec: 300,
    autonomyAllowTiers: 'benign',
    autonomyVlmWhenUncertain: true,
    autonomyForbiddenKeywords: '',
    enableProphecy: true,
    ...over,
  } as Config;
}

/**
 * 可编程假世界模型（Ε-1/Ε-3 的转移表面）：predict 按 `${from}|${key}` 查表 ——
 * 值为 null/缺席 ⇒ 诚实的无知；surprise 恒报 3.2 bits；observe 计数不响。
 */
class ScriptedModel implements WorldModel {
  private readonly table: Record<string, string | null>;
  constructor(table: Record<string, string | null>) {
    this.table = table;
  }
  typeOf(): string | null { return null; }
  observe(): Result<void, KnowledgeError> { return { ok: true, value: undefined }; }
  predict(fromTypeId: string, actionKey: string): Result<TransitionPrediction | null, KnowledgeError> {
    const t = this.table[`${fromTypeId}|${actionKey}`];
    if (t === undefined || t === null) return { ok: true, value: null };
    return {
      ok: true,
      value: {
        nextTypes: [{ typeId: t, prob: 0.9 }],
        successProb: 1, evidence: 4, entropyBits: 0.1, posteriorConcentration: 0.9,
      },
    };
  }
  surprise(): Result<SurpriseReport, KnowledgeError> {
    return { ok: true, value: { bits: 3.2, novel: true, evidence: 4 } };
  }
}

/** 全面爆炸的假世界模型（Ε-5）：四个面全 throw —— 引擎必须全吸收 */
const BOOM_MODEL: WorldModel = {
  typeOf: (): string | null => { throw new Error('boom-typeOf'); },
  observe: (): Result<void, KnowledgeError> => { throw new Error('boom-observe'); },
  predict: (): Result<TransitionPrediction | null, KnowledgeError> => { throw new Error('boom-predict'); },
  surprise: (): Result<SurpriseReport, KnowledgeError> => { throw new Error('boom-surprise'); },
};

// ─── Ε-1 铸预言与结算数学 ───

test('Ε-1: 铸预言与结算数学 —— 三态判定正确、miss 惊异为正、no-model 绝不伪造、动作键方言在册', () => {
  // 真实模型的转移表编程（世界模型既有 API —— observe 三笔）：
  //   s-a --act--> s-b ×2（成）、s-c ×1（败）⇒ predict 首名 s-b @ 2/3
  const wm = new InMemoryWorldModel();
  assert.ok(wm.observe('s-a', 'act', 's-b', true).ok);
  assert.ok(wm.observe('s-a', 'act', 's-b', true).ok);
  assert.ok(wm.observe('s-a', 'act', 's-c', false).ok);

  // 铸造：predictedType/概率正确（2/3 → worldModel 千分位舍入 0.667）；铸而未验 = pending
  const rec = mintProphecy(wm, 's-a', 'act', 1_000);
  assert.equal(rec.screenType, 's-a');
  assert.equal(rec.actionKey, 'act');
  assert.equal(rec.predictedType, 's-b');
  assert.ok(Math.abs((rec.predictedProb ?? 0) - 0.667) < 1e-9, `p=${rec.predictedProb}`);
  assert.equal(rec.outcome, 'pending', '有预言的铸造暂态 = pending（终值只由结算落锤）');
  assert.equal(rec.ts, 1_000);

  // 命中：predictedType === actualType ⇒ hit；惊异 = −log2((2+0.5)/(3+0.5·3)) = 0.848 bits
  const hit = settleProphecy(rec, 's-b', wm);
  assert.equal(hit.outcome, 'hit');
  assert.equal(hit.actualType, 's-b');
  assert.ok(Math.abs((hit.surpriseBits ?? -1) - 0.848) < 1e-9, `hit bits=${hit.surpriseBits}`);

  // 失手：有预言而不符 ⇒ miss + 惊异差值为正；−log2((1+0.5)/4.5) = 1.585 bits（错比对更响）
  const miss = settleProphecy(rec, 's-c', wm);
  assert.equal(miss.outcome, 'miss');
  assert.equal(miss.actualType, 's-c');
  assert.ok((miss.surpriseBits ?? -1) > 0, 'miss 惊异差值为正');
  assert.ok(Math.abs((miss.surpriseBits ?? -1) - 1.585) < 1e-9, `miss bits=${miss.surpriseBits}`);
  assert.ok((miss.surpriseBits ?? 0) > (hit.surpriseBits ?? 0), '失手比命中更响（考试的信号方向）');
  // 从未见过的目的地（count=0）⇒ 更响：−log2(0.5/4.5) = 3.17 bits
  const novelMiss = settleProphecy(rec, 's-zzz', wm);
  assert.equal(novelMiss.outcome, 'miss');
  assert.ok(Math.abs((novelMiss.surpriseBits ?? -1) - 3.17) < 1e-9, `novel bits=${novelMiss.surpriseBits}`);

  // 无历史 ⇒ no-model 绝不伪造（predictedType 缺席）；结算直通（无知就是无知）
  const cold = mintProphecy(wm, 'cold-screen', 'act', 1_000);
  assert.equal(cold.outcome, 'no-model');
  assert.equal(cold.predictedType, undefined);
  assert.equal(cold.predictedProb, undefined);
  const coldSettled = settleProphecy(cold, 's-b', wm);
  assert.equal(coldSettled.outcome, 'no-model', '直通：no-model 不因结算改判');
  assert.equal(coldSettled.actualType, 's-b', '见证如实记录（只作记录不作判定）');
  assert.equal(coldSettled.surpriseBits, undefined, '无预言则无惊异可计');

  // 模型缺席（null）⇒ 同律 no-model；模型 Result 失败面 ⇒ 同律（坏结果 = 无知识）
  assert.equal(mintProphecy(null, 's-a', 'act').outcome, 'no-model');
  assert.equal(mintProphecy(undefined, 's-a', 'act').outcome, 'no-model');

  // 回退定价（无模型面）：miss 惊异 = −log2(1−p) 恒正（越自信错得越响）
  const fbMiss = settleProphecy(rec, 's-c');
  assert.equal(fbMiss.outcome, 'miss');
  assert.ok((fbMiss.surpriseBits ?? -1) > 0, `fallback miss bits=${fbMiss.surpriseBits}`);
  const fbHit = settleProphecy(rec, 's-b');
  assert.equal(fbHit.outcome, 'hit');
  assert.ok((fbHit.surpriseBits ?? -1) >= 0, 'fallback hit bits ≥ 0');

  // 结算不可变：返回新记录，铸造原件分毫不动（审计链的单一真相）
  assert.equal(rec.outcome, 'pending');
  assert.equal(rec.actualType, undefined);
  assert.equal(rec.surpriseBits, undefined);

  // 见证缺席（空串/null）⇒ 原样直通不结算（挂起律归引擎收口，纯函数绝不伪造）
  assert.deepEqual(settleProphecy(rec, ''), rec);
  assert.equal(settleProphecy(rec, '').actualType, undefined);

  // 动作键方言（闭环坐标 → 世界模型转移键）：像素折算归一化后 4×4 量化
  assert.equal(prophecyActionKey(clickAction('按钮'), 1920, 1080), 'click@00', 'center(35,35)/1920×1080 ⇒ 00 格');
  assert.equal(prophecyActionKey({ kind: 'scroll' }, 1920, 1080), 'scroll', '无落点 ⇒ kind 本身');
  assert.equal(prophecyActionKey({ kind: 'hotkey' }, 0, 0), 'hotkey', '坏几何 ⇒ 退化为 kind');
  assert.equal(prophecyActionKey({ kind: 'click', target: { center: { x: 1900, y: 1060 } } }, 1920, 1080), 'click@33', '右下角 ⇒ 33 格');
  assert.equal(prophecyActionKey(null, 1920, 1080), 'unknown', '垃圾动作 ⇒ unknown（绝不抛）');

  // 注记方言（一行）：三态各自成词、指纹截断（Token 纪律）
  assert.match(prophecyJournalTag(hit), /^prophecy:hit（s-a\|act → s-b，p=0\.667）/);
  assert.match(prophecyJournalTag(miss), /^prophecy:miss（s-a\|act → s-c，惊异 1\.585 bits）$/);
  assert.match(prophecyJournalTag(coldSettled), /^prophecy:no-model（cold-screen\|act → s-b，模型无知直通）$/);
  const longFp = 'x'.repeat(64);
  assert.match(prophecyJournalTag({ ...cold, screenType: longFp }), /xxxxxxxxxxxxxxxx…\|act/, '长指纹截 16 字符');
});

// ─── Ε-2 闭环接线（预言不可见性执法） ───

test('Ε-2: 闭环接线 —— 第一步命中第二步失手 ⇒ 账本两条、journal 注记在场；PilotResult 既有字段与开关关闭 deepEqual', async () => {
  // 栈层：enableProphecy 缺省 true（Schema 默认语义）⇒ 引擎铸进栈；false ⇒ 字段缺席
  const stackOn = buildAutonomyStack(makeConfig(), {});
  assert.ok(stackOn.prophecy, '缺省 true ⇒ 预言引擎铸进栈');
  assert.equal(typeof stackOn.prophecy!.mint, 'function', '栈内消费面 = mint');
  assert.equal(typeof stackOn.prophecy!.settle, 'function', '栈内消费面 = settle');
  const stackOff = buildAutonomyStack(makeConfig({ enableProphecy: false }), {});
  assert.equal(stackOff.prophecy, undefined, '开关关闭 ⇒ prophecy 字段缺席（闭环逐字节旧路径）');

  // 环层：动作键 'click@00'（center 35,35 ÷ 1920×1080）；屏型序列 AAA → BBB → CCC
  const KEY = 'click@00';
  const wm = new InMemoryWorldModel();
  assert.ok(wm.observe('AAA', KEY, 'BBB', true).ok); // 第一步将命中（预言 BBB，实际 BBB）
  assert.ok(wm.observe('BBB', KEY, 'ZZZ', true).ok); // 第二步将失手（预言 ZZZ，实际 CCC）

  const run = async (withProphecy: boolean): Promise<{ res: PilotResult; engine: ProphecyEngine }> => {
    const goal = new GoalStateMachine({ goal: '整理窗口', successCriteria: ['窗口已整理'] });
    const decisions = [dec(clickAction('按钮一')), dec(clickAction('按钮二')), dec(ESCALATE_ACTION)];
    let decideCalls = 0;
    let percepts = 0;
    const engine = new ProphecyEngine({ worldModel: wm, now: () => 5_000 });
    const deps: AutonomyDeps = {
      perceive: async () => {
        percepts++;
        return snap(['AAA', 'BBB', 'CCC'][Math.min(percepts - 1, 2)]);
      },
      policy: { decide: async () => decisions[Math.min(decideCalls++, 2)] },
      execute: async () => ({ outcome: 'progress' }),
      goal,
      sleep: async () => { throw new Error('本用例不得睡眠'); },
      now: () => 5_000,
    };
    if (withProphecy) deps.prophecy = engine;
    return { res: await runAutonomousLoop(deps), engine };
  };

  const off = await run(false); // 先跑关闭面（世界模型零污染 —— 关闭面绝不触碰 wm）
  const on = await run(true);

  // 终局逐字段一致：预言不可见性（除注记外零影响）
  assert.equal(on.res.phase, off.res.phase);
  assert.equal(on.res.steps, off.res.steps);
  assert.equal(on.res.durationMs, off.res.durationMs);
  assert.equal(on.res.summary, off.res.summary, '纯审计旁路不改写终局总结');
  assert.equal(on.res.escalated, off.res.escalated);
  assert.equal(on.res.escalateReason, off.res.escalateReason);
  // 轨迹逐字段一致（投影掉 note —— 注记是唯一允许的留痕差量）
  const project = (r: StepRecord): unknown => ({
    i: r.stepIndex, action: r.action, outcome: r.outcome,
    d: r.snapshotDhash, at: r.at, tier: r.effectiveRiskTier,
  });
  assert.deepEqual(on.res.trajectory.map(project), off.res.trajectory.map(project));
  assert.equal(on.res.trajectory.length, 3, '两执行步 + 一升级步');

  // 账本两条：先中后失（数学手算 —— 见 Ε-1 同源 Laplace 口径）
  const recs = on.engine.records();
  assert.equal(recs.length, 2, '账本两条');
  assert.equal(recs[0].screenType, 'AAA');
  assert.equal(recs[0].actionKey, KEY);
  assert.equal(recs[0].predictedType, 'BBB');
  assert.equal(recs[0].actualType, 'BBB');
  assert.equal(recs[0].outcome, 'hit');
  assert.ok(Math.abs((recs[0].surpriseBits ?? -1) - 0.415) < 1e-9, `hit bits=${recs[0].surpriseBits}`); // −log2(1.5/2)
  assert.equal(recs[1].screenType, 'BBB');
  assert.equal(recs[1].predictedType, 'ZZZ');
  assert.equal(recs[1].actualType, 'CCC');
  assert.equal(recs[1].outcome, 'miss');
  assert.ok(Math.abs((recs[1].surpriseBits ?? -1) - 2) < 1e-9, `miss bits=${recs[1].surpriseBits}`); // −log2(0.5/2)

  // journal 注记在场（一行，回写预言归属步）：第一步 hit、第二步 miss；关闭面零注记
  assert.match(String(on.res.trajectory[0].note), /^prophecy:hit（AAA\|click@00 → BBB，p=1）$/);
  assert.match(String(on.res.trajectory[1].note), /^prophecy:miss（BBB\|click@00 → CCC，惊异 2 bits）$/);
  assert.equal(on.res.trajectory[2].note, undefined, '升级步不铸预言（⑤ 先于 ⑥′）');
  assert.equal(off.res.trajectory[0].note, undefined, '关闭面零注记');
  assert.equal(off.res.trajectory[1].note, undefined);

  // Dyna 回灌：两次结算把真实转移喂回世界模型（失手让模型走出无知）
  const after = wm.predict('BBB', KEY);
  assert.ok(after.ok && after.value !== null, '失手转移已被回灌学习');
  const ccc = after.value!.nextTypes.find(t => t.typeId === 'CCC');
  assert.ok(ccc, '真实去向 CCC 已入分布');
  assert.ok(Math.abs(ccc.prob - 0.5) < 1e-9, 'ZZZ/CCC 各 1 笔 ⇒ 各 0.5');
  assert.equal(after.value!.evidence, 2, '总证据 2 笔（预编 1 + 回灌 1）');

  // 统计面：2 中 1 失 0 无知
  const st = on.engine.stats();
  assert.equal(st.settled, 2);
  assert.equal(st.hits, 1);
  assert.equal(st.misses, 1);
  assert.equal(st.hitRate, 0.5);
  assert.deepEqual(st.topMisses, [{ screenType: 'BBB', actionKey: KEY, count: 1 }]);
});

// ─── Ε-2b ΝΩ-11：no-impact 闸（零视觉影响动作不铸） ───

test('ΝΩ-11: no-impact 不铸 / 有影响照铸 —— inspect/declare 不 mint 不回灌自环；click 照旧铸与结算', async () => {
  const wm = new InMemoryWorldModel();
  // 预编一条真实转移：AAA --inspect--> AAA 不可存在（闸的意义）；AAA --click@00--> BBB 在册
  assert.ok(wm.observe('AAA', 'click@00', 'BBB', true).ok);
  const engine = new ProphecyEngine({ worldModel: wm, now: () => 5_000 });

  /** 观察性动作（W1-3 classifyExpectedVisualEffect ⇒ 'no-impact'） */
  const inspectAction: Act = {
    kind: 'inspect',
    rationale: '看清现场',
    expectedEffect: '只看不改世界',
    utility: 0.5,
    riskTier: 'benign',
  };
  const declareAction: Act = {
    kind: 'declare',
    payload: { criterion: '窗口已整理' },
    rationale: '宣称判据达成',
    expectedEffect: '判据置 met',
    utility: 0.5,
    riskTier: 'benign',
  };

  // 剧本：inspect → click → declare → escalate；屏型序列 AAA → AAA → BBB → BBB
  //（inspect 执行后屏不变 —— 自环见证，正是旧路径会回灌的污染源）
  const decisions = [
    dec(inspectAction),
    dec(clickAction('按钮一')),
    dec(declareAction),
    dec(ESCALATE_ACTION),
  ];
  let decideCalls = 0;
  let percepts = 0;
  const goal = new GoalStateMachine({ goal: '整理窗口', successCriteria: ['窗口已整理'] });
  const deps: AutonomyDeps = {
    perceive: async () => {
      percepts++;
      return snap(['AAA', 'AAA', 'BBB', 'BBB'][Math.min(percepts - 1, 3)]);
    },
    policy: { decide: async () => decisions[Math.min(decideCalls++, 3)] },
    execute: async () => ({ outcome: 'progress' }),
    goal,
    sleep: async () => {},
    now: () => 5_000,
    prophecy: engine,
  };
  const res = await runAutonomousLoop(deps);
  assert.equal(res.steps, 4, '三执行步 + 一升级步');

  // no-impact 不铸：inspect/declare 步零 prophecy 注记；账本只有 click 的一条
  assert.ok(!String(res.trajectory[0].note ?? '').includes('prophecy:'), 'inspect（无影响）不铸 ⇒ 零注记');
  assert.ok(!String(res.trajectory[2].note ?? '').includes('prophecy:'), 'declare（无影响）不铸 ⇒ 零注记');
  const recs = engine.records();
  assert.equal(recs.length, 1, '只有 click（may-change）铸了一条');
  assert.equal(recs[0].actionKey, 'click@00', '铸造归属 click 步');
  assert.equal(recs[0].screenType, 'AAA', 'click 在第二帧（AAA）上铸');
  assert.equal(recs[0].actualType, 'BBB', '第三次感知（BBB）结算 click 的预言');
  assert.match(String(res.trajectory[1].note ?? ''), /prophecy:(hit|miss|no-model)/, '有影响照铸 ⇒ click 步注记在场');

  // 不回灌自环：inspect 的 (AAA→AAA) 平凡转移绝不入表（predict 首名不被「什么都不
  // 发生」污染 —— 闸的立意）；click 的真实转移照旧 Dyna 回灌
  const inspectCell = wm.predict('AAA', 'inspect');
  assert.ok(inspectCell.ok && inspectCell.value === null, 'inspect 自环转移零证据（no-impact 闸前会被回灌）');
  const clickCell = wm.predict('AAA', 'click@00');
  assert.ok(clickCell.ok && clickCell.value !== null, 'click 真实转移照旧回灌学习');
});

// ─── Ε-3 错题本 ───

test('Ε-3: 错题本 —— 多次失手后 TopK 失手 (屏型,动作) 正确、命中率正确（no-model 不掺水）；dump/restore 往返', () => {
  const engine = new ProphecyEngine({
    worldModel: new ScriptedModel({
      's1|k1': 'wrong-1', // 恒错（预言 wrong-1，实际永不是）
      's2|k2': 'wrong-2',
      's3|k3': 'right',   // 恒中
      // s4|k4 缺席 ⇒ no-model
    }),
    now: () => 100,
    learn: false, // 纯只读审计面（可编程假模型的确定性）
  });

  // 7 次结算：s1|k1 失手×3、s2|k2 失手×1、s3|k3 命中×1、s4|k4 无知×2
  for (let i = 0; i < 3; i++) {
    engine.mint('s1', 'k1');
    assert.ok(engine.settle('real-1', true));
  }
  engine.mint('s2', 'k2');
  assert.ok(engine.settle('real-2', true));
  engine.mint('s3', 'k3');
  assert.ok(engine.settle('right', true));
  engine.mint('s4', 'k4');
  assert.ok(engine.settle('r-a', true));
  engine.mint('s4', 'k4');
  assert.ok(engine.settle('r-b', true));

  const st = engine.stats();
  assert.equal(st.settled, 7);
  assert.equal(st.hits, 1);
  assert.equal(st.misses, 4);
  assert.equal(st.noModel, 2);
  // 命中率只以有预言的结算为分母：1/(1+4) = 0.2 —— no-model 是无知不是错误
  assert.equal(st.hitRate, 0.2);
  assert.equal(st.missRate, 0.8);
  assert.equal(st.avgMissSurpriseBits, 3.2);
  // 错题本 TopK：失手计数降序（并列按 (屏型,动作) 字典序 —— 确定序绝不掷硬币）
  assert.deepEqual(st.topMisses, [
    { screenType: 's1', actionKey: 'k1', count: 3 },
    { screenType: 's2', actionKey: 'k2', count: 1 },
  ]);

  // dump/restore 往返：账本与作废计数逐字段复活（无世界模型也能读统计）
  const snapshot: ProphecyLedgerSnapshot = engine.dump();
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.records.length, 7);
  const twin = new ProphecyEngine({ worldModel: null, now: () => 100 });
  twin.restore(snapshot);
  assert.deepEqual(twin.dump(), snapshot, '快照往返逐字段等');
  assert.deepEqual(twin.stats(), st, '复活后统计面等');

  // 坏行半水合：坏行弃置、好行入账（绝不因一行脏数据丢整本账）
  const twin2 = new ProphecyEngine({ now: () => 100 });
  twin2.restore({
    version: 1,
    expired: 3,
    records: [
      { screenType: '', actionKey: 'k', outcome: 'hit', ts: 1 },            // 空屏型 ⇒ 弃
      { screenType: 's', actionKey: 'k', outcome: 'pending', ts: 1 },       // pending 不入账 ⇒ 弃
      { screenType: 's', actionKey: 'k', outcome: 'weird', ts: 1 },         // 非法终态 ⇒ 弃
      { screenType: 's', actionKey: 'k', outcome: 'hit', ts: 'x' },         // 坏 ts ⇒ 弃
      { screenType: 'good', actionKey: 'k2', outcome: 'miss', ts: 5, surpriseBits: -1, predictedProb: 2 }, // 越界值收口
      null,                                                                   // 垃圾行 ⇒ 弃
    ],
  });
  const st2 = twin2.stats();
  assert.equal(st2.settled, 1, '只入账唯一好行');
  assert.equal(st2.misses, 1);
  assert.equal(st2.expired, 3, '作废计数如实水合');
  assert.ok((twin2.records()[0].surpriseBits ?? 0) >= 0, '负惊异被拒');
  assert.ok((twin2.records()[0].predictedProb ?? 0) <= 1, '越界概率被夹 [0,1]');
  twin2.restore(null);
  twin2.restore('garbage');
  assert.equal(twin2.stats().settled, 1, '整体非法快照 ⇒ 原账本不动');
});

// ─── Ε-4 诚实律 ───

test('Ε-4: 诚实律 —— 无转移 ⇒ no-model 绝不伪造；执行后屏型取不到 ⇒ 挂起 60s 作废计数，不产伪结算', async () => {
  // 引擎面：挂起 60s 作废律（注入时钟推进越限）
  let clock = 1_000;
  const engine = new ProphecyEngine({ worldModel: new InMemoryWorldModel(), now: () => clock });
  engine.mint('AAA', 'k'); // 世界模型无该转移 ⇒ no-model 铸造（诚实无知）
  assert.equal(engine.stats().pending, 1);
  assert.equal(engine.settle(null), null, '见证缺席 ⇒ 挂起（null 结算不落锤）');
  assert.equal(engine.settle(undefined), null);
  assert.equal(engine.stats().settled, 0, '零伪结算');
  clock += 61_000; // 越过 60s TTL
  engine.mint('BBB', 'k'); // 新铸造触发旧挂起的诚实作废
  const st = engine.stats();
  assert.equal(st.expired, 1, '挂起 60s 后诚实作废计数');
  assert.equal(st.pending, 1, '新预言在场（作废不牵连后来者）');
  assert.equal(st.settled, 0, '账本零记录 —— 绝不伪造 actualType');
  assert.deepEqual(engine.records(), []);

  // 环面：执行后屏型取不到（感知失明 dhash:null）⇒ 预言挂起不结算、不产伪注记
  const blindEngine = new ProphecyEngine({ worldModel: new InMemoryWorldModel(), now: () => 9 });
  const goal = new GoalStateMachine({ goal: '阅读屏幕', successCriteria: ['读完'] });
  const decisions = [dec(clickAction('按钮一')), dec(clickAction('按钮二')), dec(ESCALATE_ACTION)];
  let decideCalls = 0;
  let percepts = 0;
  const deps: AutonomyDeps = {
    perceive: async () => {
      percepts++;
      return percepts === 1 ? snap('AAA') : snap(null); // 首帧有指纹（铸造合法），此后失明
    },
    policy: { decide: async () => decisions[Math.min(decideCalls++, 2)] },
    execute: async () => ({ outcome: 'progress' }),
    goal,
    sleep: async () => {},
    now: () => 9,
    prophecy: blindEngine,
  };
  const res = await runAutonomousLoop(deps);
  assert.equal(res.steps, 3, '环照常完成（click、click、escalate）');
  const bst = blindEngine.stats();
  assert.equal(bst.settled, 0, '失明 ⇒ 零结算');
  assert.equal(bst.pending, 1, '预言挂起（等待作废律收口）');
  assert.equal(bst.expired, 0);
  assert.equal(res.trajectory[0].note, undefined, '不产伪注记（结算未发生）');
  assert.equal(res.trajectory[1].note, undefined, '第二 click 在盲屏上不铸预言（lastDhash=null）');

  // 世界模型无该转移 ⇒ no-model 直通（绝不把无知伪装成预测）—— 环面复证
  const coldEngine = new ProphecyEngine({ worldModel: new InMemoryWorldModel(), now: () => 9 });
  coldEngine.mint('never-seen', 'never-done');
  const settled = coldEngine.settle('wherever', true);
  assert.ok(settled);
  assert.equal(settled.outcome, 'no-model');
  assert.equal(settled.predictedType, undefined);
  assert.equal(settled.actualType, 'wherever', '见证如实、判定诚实');
});

// ─── Ε-5 永不抛 ───

test('Ε-5: 永不抛 —— 假 worldModel 全抛 ⇒ 环照常完成、账本零污染（无伪造预言字段）；端口全抛 ⇒ 逐字段全等；环形 500 封顶', async () => {
  // 引擎面：四面全抛的模型 ⇒ 铸造按无知识处理、结算直通、统计/快照照常
  let clock = 1;
  const engine = new ProphecyEngine({ worldModel: BOOM_MODEL, now: () => clock });
  engine.mint('AAA', 'k'); // predict 抛 ⇒ 吞 ⇒ no-model（诚实：坏模型 = 无知识）
  const rec = engine.settle('BBB', true); // surprise/observe 抛 ⇒ 吞 ⇒ 直通结算
  assert.ok(rec !== null);
  assert.equal(rec.outcome, 'no-model');
  assert.equal(rec.predictedType, undefined, '零污染：绝不伪造预言身份');
  assert.equal(rec.predictedProb, undefined, '零污染：绝不伪造概率');
  assert.equal(rec.surpriseBits, undefined, '零污染：绝不伪造惊异');
  assert.equal(rec.actualType, 'BBB');
  const st = engine.stats();
  assert.equal(st.settled, 1);
  assert.equal(st.noModel, 1);
  assert.equal(engine.dump().records.length, 1);
  clock += 61_000; // 后续挂起作废亦不抛
  engine.mint('CCC', 'k');
  assert.equal(engine.stats().expired, 0, '已结算清空 ⇒ 无挂起可作废');

  // 环面 A：坏模型引擎在场 ⇒ 环照常完成、结果与关闭面一致（投影注记）、账本诚实
  const runLoop = async (port: ProphecyPort | ProphecyEngine | undefined): Promise<PilotResult> => {
    const goal = new GoalStateMachine({ goal: '稳健运行', successCriteria: ['完成'] });
    const decisions = [dec(clickAction('按钮')), dec(ESCALATE_ACTION)];
    let decideCalls = 0;
    let percepts = 0;
    const deps: AutonomyDeps = {
      perceive: async () => {
        percepts++;
        return snap(percepts === 1 ? 'AAA' : 'BBB');
      },
      policy: { decide: async () => decisions[Math.min(decideCalls++, 1)] },
      execute: async () => ({ outcome: 'progress' }),
      goal,
      sleep: async () => {},
      now: () => 42,
    };
    if (port !== undefined) deps.prophecy = port as ProphecyPort;
    return runAutonomousLoop(deps);
  };
  const boomEngine = new ProphecyEngine({ worldModel: BOOM_MODEL, now: () => 42 });
  const withBoomModel = await runLoop(boomEngine);
  const baseline = await runLoop(undefined);
  assert.equal(withBoomModel.steps, baseline.steps, '坏模型 ⇒ 环照常完成');
  assert.equal(withBoomModel.summary, baseline.summary);
  const project = (r: StepRecord): unknown => ({
    i: r.stepIndex, action: r.action, outcome: r.outcome,
    d: r.snapshotDhash, at: r.at, tier: r.effectiveRiskTier,
  });
  assert.deepEqual(withBoomModel.trajectory.map(project), baseline.trajectory.map(project));
  assert.match(String(withBoomModel.trajectory[0].note), /prophecy:no-model/, '坏模型注记诚实标注无知');
  assert.equal(boomEngine.records().length, 1);
  assert.equal(boomEngine.records()[0].outcome, 'no-model', '账本零污染');

  // 环面 B：端口自身全抛（mint/settle 都 throw）⇒ PilotResult 与关闭面逐字段全等
  // ΠΑΝ-54：ProphecyPort.mint 自此返回预言号（number | null）—— 桩的 throw 路径
  // 返回面改写为 null 形态（抛出先于 return，运行时行为不变）。
  const brokenPort: ProphecyPort = {
    mint: (): null => { throw new Error('mint boom'); },
    settle: (): ProphecyRecord | null => { throw new Error('settle boom'); },
  };
  const withBrokenPort = await runLoop(brokenPort);
  assert.deepEqual(withBrokenPort, baseline, '端口全抛 ⇒ 逐字节旧路径（连注记都零差量）');

  // 环形 500 封顶：620 次铸造结算 ⇒ 只留最新 500 条（逐出最旧）
  let t = 0;
  const ringEngine = new ProphecyEngine({ worldModel: new InMemoryWorldModel(), now: () => t });
  for (let i = 0; i < 620; i++) {
    t += 1;
    ringEngine.mint(`s-${i % 7}`, `k-${i}`);
    ringEngine.settle(`a-${i}`, true);
  }
  const ring = ringEngine.records();
  assert.equal(ring.length, 500, '环形 500 封顶');
  assert.equal(ring[0].actionKey, 'k-120', '最旧 120 条被逐出（第 121 条成为新队首）');
  assert.equal(ring[499].actionKey, 'k-619', '队尾 = 最新一条');
  assert.equal(ringEngine.stats().settled, 500);
  assert.equal(ringEngine.stats().noModel, 500, '每键唯一 ⇒ 全程诚实无知（学习也查不到旧键）');
});
