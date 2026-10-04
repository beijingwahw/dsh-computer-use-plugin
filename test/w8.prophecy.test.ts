// test/w8.prophecy.test.ts
// D-G2（W8 第 2 批）执法册 —— 预言引擎细化三面：
//   G2-1 屏型身份粗层桥：dhash 抖动变体经粗格（前 8 hex 字）免于 no-model
//       （predictedVia='coarse' 诚实标注）；非 hex/短屏型零漂移；粗格无证据
//       ⇒ 仍诚实 no-model（绝不把粗层缺席伪装成预测）
//   G2-2 粗层双写回灌：结算 observe 双写（精细格 + 粗格；to 侧保持精细身份
//       —— 结算比对 fine↔fine 方言不串）；learn=false 零写入
//   G2-3 惊异喂 EvolutionEngine 通道：失手记录（含惊异 bits）经结构性端口
//       ingest 喂养 —— 真 EvolutionEngine 结构性满足（实接执法）；水位线
//       零重喂、环形驱逐补偿、水合即消化、端口故障吞掉绝不炸
//   G2-4 置信校准面：对账历史 vs 自报置信并排（avgPredictedProb/hitRate/Brier
//       手算硬编码）；no-model 不掺水、缺概率诚实缺席（null 不假充）
//   G2-5 失败复盘注记：最常失手格的「反复押 vs 实际到」对照 —— 押注方向错
//       与众数押中仍失手（分布散裂）两型分诊；无失手 ⇒ 空册
// 全离线确定性：零网络、零真钟（注入时钟）、零真睡。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryWorldModel } from '../src/knowledge/worldModel.ts';
import {
  ProphecyEngine,
  mintProphecy,
  settleProphecy,
  prophecyJournalTag,
  coarseScreenType,
  COARSE_PREFIX_HEX,
  surpriseRunRecord,
  prophecyCalibration,
  prophecyPostmortem,
  prophecyPostmortemLines,
  type ProphecyRecord,
  type SurpriseFeedTarget,
} from '../src/prophecy/index.ts';
import { EvolutionEngine } from '../src/autonomy/evolutionEngine.ts';

/** 16 hex 字 dhash 方言工厂（闭环屏型身份 —— 粗层桥的目标方言） */
const fp = (s: string): string => s.padEnd(16, '0').slice(0, 16);

// ─── G2-1 屏型身份粗层桥 ───

test('G2-1: 粗层桥 —— dhash 抖动变体经粗格得预言（via coarse 诚实标注）；粗格无证据 ⇒ 仍 no-model；非 hex/短屏型零漂移', () => {
  // 粗化方言单测：hex 长指纹截前 8；其余原样（旧方言不经桥）
  assert.equal(COARSE_PREFIX_HEX, 8, '粗层前缀长度出册常数在册');
  assert.equal(coarseScreenType(fp('aaaabbbb')), 'aaaabbbb', '16 hex dhash ⇒ 前 8 hex 字（上 32 位梯度）');
  assert.equal(coarseScreenType('123456789'), '12345678', '9 hex 字也截 8');
  assert.equal(coarseScreenType('12345678'), '12345678', '恰 8 字 ⇒ 原样（不空转）');
  assert.equal(coarseScreenType('screen-12'), 'screen-12', '非 hex 聚类 id ⇒ 原样（世界模型聚类方言不经 dhash 桥）');
  assert.equal(coarseScreenType(''), '', '空屏型原样');
  assert.equal(coarseScreenType('AAA'), 'AAA', '短测试方言原样 —— 既有册零漂移的根基');

  // 正例：第一次走 fine 键（无知直通、双写回灌）；第二次同屏像素抖动变体
  // （fine 键不同、粗格相同）⇒ 粗层回退得预言且命中
  const wm = new InMemoryWorldModel();
  const eng = new ProphecyEngine({ worldModel: wm, now: () => 1_000 });
  const v1 = fp('aaaabbbb11111111'); // 粗格 'aaaabbbb'
  const v2 = fp('aaaabbbb22222222'); // 同粗格的抖动变体（低位不同）
  const dest = fp('ddddeeee00000000');

  eng.mint(v1, 'click@00');
  assert.equal(eng.settle(dest, true)!.outcome, 'no-model', '首遇无任何证据 ⇒ 诚实无知');
  // 双写回灌后：fine 格与粗格都有 (→dest) 证据（G2-2 细测，此处依赖其成立）
  eng.mint(v2, 'click@00'); // fine 键查无 ⇒ 粗层回退命中
  const rec = eng.settle(dest, true)!;
  assert.equal(rec.predictedVia, 'coarse', '抖动变体的预言来源层 = 粗格（诚实标注）');
  assert.equal(rec.predictedType, dest, '粗格预言的目的地是精细身份（to 侧不粗化）');
  assert.equal(rec.outcome, 'hit', '粗层预言与真实到达比对 fine↔fine ⇒ 命中');
  assert.equal(eng.stats().coarseAssisted, 1, '粗层助攻计数如实 +1');
  assert.equal(eng.stats().noModel, 1, '无知仍是无知 —— 粗层不追溯改判');

  // 反例：粗格也无证据 ⇒ 仍诚实 no-model（绝不伪装）
  const cold = new ProphecyEngine({ worldModel: new InMemoryWorldModel(), now: () => 1 });
  cold.mint(fp('zzzzzzzz99999999'), 'k');
  const coldRec = cold.settle('anywhere', true)!;
  assert.equal(coldRec.outcome, 'no-model');
  assert.equal(coldRec.predictedType, undefined);
  assert.equal(coldRec.predictedVia, undefined, '无预言 ⇒ 无来源层（不伪造）');

  // 精确层预言照旧且显式标注 exact（新记录带层信息；行为与旧册逐字节兼容）
  const exactRec = mintProphecy(wm, v1, 'click@00', 5);
  assert.equal(exactRec.predictedVia, 'exact');

  // 注记方言：粗层预言在 journal 注记上带「via 粗层」；精确层注记逐字节旧格式
  assert.match(prophecyJournalTag({ ...rec, outcome: 'miss', surpriseBits: 2.5 }), /，惊异 2\.5 bits，via 粗层）$/);
  assert.match(prophecyJournalTag({ ...rec, predictedVia: 'exact', outcome: 'miss', surpriseBits: 2.5 }), /，惊异 2\.5 bits）$/);
});

// ─── G2-2 粗层双写回灌 ───

test('G2-2: 双写回灌 —— 结算写精细格 + 粗格（to 侧保持精细）；learn=false 零写入；非 hex 屏型无双写（零漂移）', () => {
  const wm = new InMemoryWorldModel();
  const from = fp('aaaabbbb11111111');
  const to = fp('ddddeeee00000000');
  const eng = new ProphecyEngine({ worldModel: wm, now: () => 1 });
  eng.mint(from, 'scroll');
  eng.settle(to, true);
  const coarse = coarseScreenType(from);
  assert.notEqual(coarse, from, 'hex 长指纹确有粗格（前置）');
  // 精细格在册
  const fineP = wm.predict(from, 'scroll');
  assert.ok(fineP.ok && fineP.value !== null && fineP.value.nextTypes[0].typeId === to, '精细格回灌在册');
  // 粗格在册且 to 侧是精细身份（方言不串）
  const coarseP = wm.predict(coarse, 'scroll');
  assert.ok(coarseP.ok && coarseP.value !== null, '粗格双写在册（回退铸造的证据源）');
  assert.equal(coarseP.value!.nextTypes[0].typeId, to, '粗格目的地保持精细身份 —— 结算比对 fine↔fine');

  // learn=false ⇒ 纯只读审计：零写入
  const wm2 = new InMemoryWorldModel();
  const ro = new ProphecyEngine({ worldModel: wm2, now: () => 1, learn: false });
  ro.mint(fp('aaaabbbb11111111'), 'scroll');
  ro.settle(fp('ddddeeee00000000'), true);
  assert.equal(wm2.stats().observations, 0, 'learn=false ⇒ 双写整体关闭（只读审计面不变）');

  // 非 hex 屏型：无双写（粗化原样 ⇒ 第二笔 observe 同键 —— 只有一次语义入账）
  const wm3 = new InMemoryWorldModel();
  const eng3 = new ProphecyEngine({ worldModel: wm3, now: () => 1 });
  eng3.mint('AAA', 'k');
  eng3.settle('BBB', true);
  assert.equal(wm3.stats().observations, 1, '短屏型无双写 —— 旧方言观察计数不翻倍（零漂移执法）');
});

// ─── G2-3 惊异喂养通道 ───

/** 喂养捕获桩（结构性端口最小实现） */
class FeedSink implements SurpriseFeedTarget {
  public readonly runs: unknown[] = [];
  public throwNext = false;
  ingest(run: unknown): void {
    if (this.throwNext) { this.throwNext = false; throw new Error('ingest boom'); }
    this.runs.push(run);
  }
}

test('G2-3: 惊异喂养 —— 只喂失手（含 bits 注记）、水位线零重喂、端口故障吞掉；真 EvolutionEngine 结构性满足（实接执法）', () => {
  // 纯函数面：hit/no-model ⇒ 诚实 null；miss ⇒ RunRecord 方言
  const missRun = surpriseRunRecord({
    screenType: fp('aaaabbbb11111111'), actionKey: 'click@00', outcome: 'miss',
    predictedType: 'X', actualType: 'Y', surpriseBits: 3.17, ts: 1,
  })!;
  assert.equal(missRun.success, false);
  assert.equal(missRun.steps, 1);
  assert.equal(missRun.durationMs, 0);
  assert.deepEqual(missRun.strategies, ['click@00']);
  assert.match(missRun.goal, /^prophecy:miss /);
  assert.match(missRun.failureRootCause ?? '', /惊异 3\.17 bits/);
  assert.equal(surpriseRunRecord({ screenType: 's', actionKey: 'k', outcome: 'hit', ts: 1 }), null, '命中不是教训');
  assert.equal(surpriseRunRecord({ screenType: 's', actionKey: 'k', outcome: 'no-model', ts: 1 }), null, '无知没有 bits');
  assert.equal(surpriseRunRecord(null), null, '垃圾记录 ⇒ null（绝不抛）');

  // 引擎拉取面：miss 喂 1、hit/no-model 跳过；水位线零重喂；新 miss 增量喂
  const sink = new FeedSink();
  const eng = new ProphecyEngine({ worldModel: null, now: () => 1 });
  const miss = { screenType: 's1', actionKey: 'k1', outcome: 'miss' } as const;
  void miss; // 记录经真结算入账（surpriseBits 走无模型回退定价 −log2(1−p)，p 缺 ⇒ 0.5 ⇒ 1 bit）
  eng.mint('s1', 'k1'); // 无模型 ⇒ no-model 铸造
  eng.settle('r1', false); // no-model 直通（不喂）
  eng.mint('s2', 'k2');
  eng.settle('r2', true); // 仍 no-model（无模型）
  assert.equal(eng.feedSurprise(sink), 0, '无失手 ⇒ 零喂养');
  assert.equal(eng.feedSurprise(sink), 0, '水位线已抵账尾 ⇒ 再拉零重喂');

  // 用可编程模型制造 miss（有预言而不符）
  const scripted = {
    predict: () => ({ ok: true, value: { nextTypes: [{ typeId: 'WRONG', prob: 0.9 }], successProb: 1, evidence: 4, entropyBits: 0.1, posteriorConcentration: 0.9 } }),
    observe: () => ({ ok: true, value: undefined }),
    surprise: () => ({ ok: true, value: { bits: 3.2, novel: true, evidence: 4 } }),
    typeOf: () => null,
  };
  const eng2 = new ProphecyEngine({ worldModel: scripted as never, now: () => 1, learn: false });
  eng2.mint('sX', 'kX');
  eng2.settle('rX', true); // 预言 WRONG、实际 rX ⇒ miss（3.2 bits）
  assert.equal(eng2.feedSurprise(sink), 1, '一次失手 ⇒ 喂一条');
  assert.equal(sink.runs.length, 1);
  assert.match(String((sink.runs[0] as { failureRootCause: string }).failureRootCause), /惊异 3\.2 bits/);
  assert.equal(eng2.feedSurprise(sink), 0, '水位线 ⇒ 零重喂');

  // 端口故障：ingest 抛错 ⇒ 吞掉计丢，绝不炸（后续记录照喂）
  eng2.mint('sX', 'kX');
  eng2.settle('rX', true); // 第二次失手
  sink.throwNext = true;
  assert.equal(eng2.feedSurprise(sink), 0, '抛错条计丢不计喂');
  eng2.mint('sX', 'kX');
  eng2.settle('rX', true); // 第三次失手
  assert.equal(eng2.feedSurprise(sink), 1, '后续记录照喂（故障不毒化通道）');
  assert.equal(eng2.feedSurprise(null), 0, '坏目标 ⇒ 0（绝不抛）');

  // 自动喂养面：构造期注入 surpriseFeed ⇒ 结算即喂（无需拉取）
  const auto = new FeedSink();
  const eng3 = new ProphecyEngine({ worldModel: scripted as never, now: () => 1, learn: false, surpriseFeed: auto });
  eng3.mint('sX', 'kX');
  eng3.settle('rX', true);
  assert.equal(auto.runs.length, 1, '结算入账即自动喂养（通道推面）');

  // 实接执法：真 EvolutionEngine（autonomy 产权域只读消费）—— 结构性满足证明
  const evo = new EvolutionEngine();
  const before = evo.history.length;
  const eng4 = new ProphecyEngine({ worldModel: scripted as never, now: () => 1, learn: false });
  eng4.mint('sX', 'kX');
  eng4.settle('rX', true);
  eng4.mint('sX', 'kX');
  eng4.settle('rX', true);
  assert.equal(eng4.feedSurprise(evo), 2, '真 EvolutionEngine.ingest 直收（结构子集满足）');
  assert.equal(evo.history.length, before + 2, '进化史册新增两条失手运行');
  assert.ok(evo.history.every(r => r.success === false), '喂养记录 success=false（教训语义）');
  assert.equal(typeof evo.heuristics().click, 'number', '进化读数照常（喂养零扰动）');

  // 水合即消化：dump/restore 后水位线直抵账尾（保守不重喂 —— 跨进程喂养账不复存在）
  const twin = new ProphecyEngine({ worldModel: null, now: () => 1 });
  twin.restore(eng4.dump());
  assert.equal(twin.feedSurprise(new FeedSink()), 0, '水合 ⇒ 已在册记录视为已消化（不重喂双计）');

  // 环形驱逐补偿：容量 3、失手 5 条（2 条被逐出）⇒ 只喂幸存 3 条、水位线不越界不重喂
  const ring = new ProphecyEngine({ worldModel: scripted as never, now: () => 1, learn: false, capacity: 3 });
  for (let i = 0; i < 5; i++) {
    ring.mint('sX', `k${i}`);
    ring.settle('rX', true);
  }
  const ringSink = new FeedSink();
  assert.equal(ring.feedSurprise(ringSink), 3, '驱逐后只喂幸存记录（水位线与驱逐同步）');
  assert.equal(ring.feedSurprise(ringSink), 0, '再拉零重喂');
});

// ─── G2-4 置信校准面 ───

test('G2-4: 置信校准 —— avgPredictedProb/hitRate/Brier 手算硬编码；缺概率 ⇒ null 诚实缺席；no-model 不掺水；空账 ⇒ aggregate=null', () => {
  const rec = (over: Partial<ProphecyRecord>): ProphecyRecord => ({
    screenType: 's1', actionKey: 'k1', outcome: 'hit', ts: 1, ...over,
  });
  // 格 (s1,k1)：p=0.8 miss、p=0.6 hit、一条缺概率 miss
  //   prophecies=3, hits=1, hitRate=1/3, avgPredictedProb=(0.8+0.6)/2=0.7
  //   Brier=((0.8−0)²+(0.6−1)²)/2=(0.64+0.16)/2=0.4
  const c = prophecyCalibration([
    rec({ predictedProb: 0.8, outcome: 'miss' }),
    rec({ predictedProb: 0.6, outcome: 'hit' }),
    rec({ outcome: 'miss' }), // 缺概率 ⇒ 入分母计数、不入概率面
    rec({ screenType: 's2', actionKey: 'k2', outcome: 'no-model' }), // 无知不校准
  ]);
  assert.equal(c.cells.length, 1, 'no-model 不成格（无知无置信可校）');
  const cell = c.cells[0];
  assert.equal(cell.screenType, 's1');
  assert.equal(cell.prophecies, 3);
  assert.equal(cell.hits, 1);
  assert.equal(cell.hitRate, Math.round((1 / 3) * 1e6) / 1e6);
  assert.equal(cell.avgPredictedProb, 0.7);
  assert.equal(cell.brier, 0.4);
  assert.ok(c.aggregate, '全局校准在场');
  assert.equal(c.aggregate!.prophecies, 3);
  assert.equal(c.aggregate!.hitRate, Math.round((1 / 3) * 1e6) / 1e6);
  assert.equal(c.aggregate!.avgPredictedProb, 0.7);
  assert.equal(c.aggregate!.brier, 0.4);

  // 缺概率全体 ⇒ 概率面诚实 null（绝不按 0.5 假充）
  const noProb = prophecyCalibration([rec({ outcome: 'miss' }), rec({ outcome: 'hit' })]);
  assert.equal(noProb.cells[0].avgPredictedProb, null);
  assert.equal(noProb.cells[0].brier, null);
  assert.equal(noProb.cells[0].hitRate, 0.5, '命中率只依赖对账（无概率也可算）');

  // 反例：空账 / 全 no-model ⇒ aggregate=null（绝不伪造空校准）；垃圾不抛
  assert.equal(prophecyCalibration([]).aggregate, null);
  assert.equal(prophecyCalibration([rec({ outcome: 'no-model' })]).aggregate, null);
  assert.deepEqual(prophecyCalibration([null as unknown as ProphecyRecord, 'garbage' as unknown as ProphecyRecord]), { cells: [], aggregate: null });
});

// ─── G2-5 失败复盘注记 ───

test('G2-5: 失败复盘 —— 最常失手格的「反复押 vs 实际到」对照；方向错与众数押中仍失手（分布散裂）两型分诊；无失手 ⇒ 空册', () => {
  const miss = (s: string, k: string, predicted: string, actual: string, bits: number): ProphecyRecord => ({
    screenType: s, actionKey: k, outcome: 'miss', predictedType: predicted, actualType: actual, surpriseBits: bits, ts: 1,
  });
  // 格 (s1,k1)：失手 ×3 —— 反复押 X、实际到 Y（bits 1/2/3 ⇒ 均 2）
  // 格 (s2,k2)：失手 ×1 —— 众数押中 A 但仍失手（分布散裂）
  // 格 (s3,k3)：失手 ×1 —— 押注众数破平 {A:1,B:1} ⇒ 字典序最小 A
  const recs = [
    miss('s1', 'k1', 'X', 'Y', 1),
    miss('s1', 'k1', 'X', 'Y', 2),
    miss('s1', 'k1', 'X', 'Y', 3),
    miss('s2', 'k2', 'A', 'A', 4),
    miss('s3', 'k3', 'B', 'A', 5), // 押注侧 {B:1} —— 单值；破平场景用第四格
    miss('s4', 'k4', 'B', 'Z', 5),
    miss('s4', 'k4', 'A', 'Z', 5), // 押注 {A:1,B:1} ⇒ 众数破平取 A
    { screenType: 's1', actionKey: 'k1', outcome: 'hit', ts: 1 } as ProphecyRecord, // 命中不入复盘
  ];
  const pm = prophecyPostmortem(recs);
  assert.equal(pm.length, 4, '失手格全列（topK 缺省 5 ≥ 4）');
  assert.equal(pm[0].screenType, 's1', '失手计数降序 —— s1（3 次）居首');
  assert.equal(pm[0].misses, 3);
  assert.equal(pm[0].avgSurpriseBits, 2);
  assert.equal(pm[0].predictedModal, 'X');
  assert.equal(pm[0].actualModal, 'Y');
  const s2 = pm.find(c => c.screenType === 's2')!;
  assert.equal(s2.predictedModal, 'A');
  assert.equal(s2.actualModal, 'A'); // 众数押中仍失手
  const s4 = pm.find(c => c.screenType === 's4')!;
  assert.equal(s4.predictedModal, 'A', '众数破平取字典序最小（确定序）');

  // 注记方言：一行一格；两型分诊
  const lines = prophecyPostmortemLines(recs);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^prophecy:复盘 #1 s1\|k1 —— 失手 3 次（均惊异 2 bits，反复押 X，实际到 Y：押注方向错（模型期望 ≠ 世界去向））$/);
  const s2Line = lines.find(l => l.includes('s2|k2'))!;
  assert.match(s2Line, /众数押中仍失手 —— 分布散裂/);
  // 无失手 ⇒ 空册（绝不造复盘）；垃圾不抛
  assert.deepEqual(prophecyPostmortem([{ screenType: 's', actionKey: 'k', outcome: 'hit', ts: 1 }]), []);
  assert.deepEqual(prophecyPostmortem([null as unknown as ProphecyRecord]), []);
  assert.deepEqual(prophecyPostmortemLines([]), []);
  // 缺 bits ⇒ avgSurpriseBits=null（诚实缺席，注记不带 bits 段）
  const noBits = prophecyPostmortem([{ screenType: 's', actionKey: 'k', outcome: 'miss', predictedType: 'P', actualType: 'Q', ts: 1 }]);
  assert.equal(noBits[0].avgSurpriseBits, null);
  assert.match(prophecyPostmortemLines([{ screenType: 's', actionKey: 'k', outcome: 'miss', predictedType: 'P', actualType: 'Q', ts: 1 }])[0], /失手 1 次（反复押/);
});

// ─── 回归补证：既有三律在细化后不动 ───

test('G2-6: 回归 —— 结算数学/挂起律与旧册同律（细化面零侵入）', () => {
  const wm = new InMemoryWorldModel();
  assert.ok(wm.observe('s-a', 'act', 's-b', true).ok);
  assert.ok(wm.observe('s-a', 'act', 's-b', true).ok);
  assert.ok(wm.observe('s-a', 'act', 's-c', false).ok);
  const r = mintProphecy(wm, 's-a', 'act', 1_000);
  assert.equal(r.predictedType, 's-b');
  assert.ok(Math.abs((r.predictedProb ?? 0) - 0.667) < 1e-9, '概率面不动');
  const hit = settleProphecy(r, 's-b', wm);
  assert.equal(hit.outcome, 'hit');
  assert.ok(Math.abs((hit.surpriseBits ?? -1) - 0.848) < 1e-9, 'Laplace 惊异口径不动');
  // restore 白名单：predictedVia 域外值弃置、合法值保留
  const eng = new ProphecyEngine({ worldModel: null, now: () => 1 });
  eng.restore({
    version: 1, expired: 0,
    records: [
      { screenType: 's', actionKey: 'k', outcome: 'miss', ts: 1, predictedVia: 'coarse' },
      { screenType: 's', actionKey: 'k2', outcome: 'miss', ts: 2, predictedVia: 'galactic' },
    ],
  } as never);
  const restored = eng.records();
  assert.equal(restored.length, 2);
  assert.equal(restored[0].predictedVia, 'coarse');
  assert.equal(restored[1].predictedVia, undefined, '域外来源层弃置（防御式水合）');
});
