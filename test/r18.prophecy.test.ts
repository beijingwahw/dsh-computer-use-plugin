// test/r18.prophecy.test.ts
// 工单 ΑΩ-R18 执法册 —— 预言引擎两修：
//   R18-1 量化屏型主键：dhash 低 16 位（dhash 网格下 2 行 = 屏幕下 1/4 条带
//       —— 任务栏时钟/托盘动画抖动正源）掩没归零 ⇒ 同场景抖动变体命中同键
//       铸出非 no-model 预言且经量化比对命中（predictedVia:'quant' 诚实标注；
//       目的地量化入表 ⇒ 结算比对两侧键粒度一致不串味；冷格仍诚实无知）
//   R18-2 量化档位内核键可调（prophecy.quantKeepHex ∈ [8,16]）：16 = 关量化
//       （梯级退回 exact→coarse 两层旧行为）；方言收窄 —— 非 16 hex 字输入零漂移
//   R18-3 有界 keyed pending：双预言并发各得其所（LIFO 配对 —— 结算见证恒属
//       最近动作）；容量溢出最旧作废计入 expired；TTL 60s 作废律不动
//   R18-4 回归：dump/restore 白名单收 'quant'；惊异读面按来源层对键
// 全离线确定性：零网络、零真钟（注入时钟）、零真睡；惊异期望值按 worldModel
// 的 Laplace 平滑数学手算硬编码。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryWorldModel } from '../src/knowledge/worldModel.ts';
import type { WorldModel } from '../src/knowledge/contracts.ts';
import {
  ProphecyEngine,
  mintProphecy,
  quantizedScreenType,
  QUANT_KEEP_HEX,
  PROPHECY_QUANT_KERNEL_KEY,
  prophecyJournalTag,
} from '../src/prophecy/index.ts';
// ΝΩ-11：惊异夹帽三件（常量/夹取/结算定价）自 internal 直取（结算定价不进公开面）
import { settleSurpriseBits, clampSurpriseBits, SURPRISE_MAX_BITS } from '../src/prophecy/internal.ts';
import { kernelRegistry, resetKernelRuntime } from '../src/kernel/registry.ts';

// ─── R18-1 量化主键：抖动变体 ⇒ 非 no-model 预言 + 双侧量化比对命中 ───

test('R18-1: 量化主键 —— 同场景低 16 位抖动命中同键铸预言（via quant）且比对命中；冷格仍诚实无知', () => {
  // 量化方言单测：恰 16 hex 字的 dhash 掩低 16 位（长度保持）；其余零漂移
  assert.equal(QUANT_KEEP_HEX, 12, '量化档位缺省出册常数在册（上 48 位 = dhash 上 6 行）');
  assert.equal(quantizedScreenType('aaaabbbbcccc00f1'), 'aaaabbbbcccc0000', '低 16 位掩没归零');
  assert.equal(quantizedScreenType('aaaabbbbcccc0000'), 'aaaabbbbcccc0000', '低位本已归零 ⇒ 幂等（逐字节不变）');
  assert.equal(quantizedScreenType('aaaabbbbcccc00f1').length, 16, '掩没不是截断 —— 键长保持方言');
  assert.equal(quantizedScreenType('screen-12'), 'screen-12', '非 hex 聚类 id 不经量化桥');
  assert.equal(quantizedScreenType('AAA'), 'AAA', '短测试方言原样 —— 既有册零漂移的根基');
  assert.equal(quantizedScreenType('123456789'), '123456789', '非 16 字 hex 不经量化桥');
  assert.equal(quantizedScreenType('0101'.repeat(16)), '0101'.repeat(16), '64 位二进制串不经量化桥');

  // 正例：首遇无知直通（三写回灌）⇒ 同场景抖动变体（原始/量化/粗格三键全查无）
  // 经量化格铸出预言，且目的地侧抖动仍命中（双侧同一把量化尺）
  const wm = new InMemoryWorldModel();
  const eng = new ProphecyEngine({ worldModel: wm, now: () => 1_000 });
  const v1 = 'aaaabbbbcccc0000';      // 量化格 'aaaabbbbcccc0000'
  const v1Jit = 'aaaabbbbcccc00f1';   // 低 16 位抖动变体（量化同格、原始/粗格查无）
  const dest = 'dddd111122220000';
  const destJit = 'dddd11112222003c'; // 目的地侧低 16 位抖动（量化同格）

  eng.mint(v1, 'click@00');
  assert.equal(eng.settle(dest, true)!.outcome, 'no-model', '首遇无任何证据 ⇒ 诚实无知');
  eng.mint(v1Jit, 'click@00');
  const st1 = eng.stats();
  assert.equal(st1.pending, 1, '铸而未验挂起');
  const rec = eng.settle(destJit, true)!;
  assert.notEqual(rec.outcome, 'no-model', '量化格让抖动变体免于无知（R18 主诉）');
  assert.equal(rec.predictedVia, 'quant', '预言来源层 = 量化格（诚实标注）');
  assert.equal(rec.predictedType, 'dddd111122220000', '表内目的地是量化身份（to 侧经量化入表）');
  assert.equal(rec.outcome, 'hit', '双侧量化比对 —— 目的地抖动仍命中（键粒度两侧一致）');
  assert.equal(rec.screenType, v1Jit, '记录保持原始精细见证（错题本/统计语义不动）');
  assert.equal(rec.actualType, destJit, '实际到达保持原始精细见证');
  // 惊异读面按来源层对键：surprise(量化格, k, 量化目的地) —— 表内 {dest:1} 总 1
  // ⇒ Laplace −log2((1+0.5)/(1+0.5·2)) = 0.415 bits
  assert.ok(Math.abs((rec.surpriseBits ?? -1) - 0.415) < 1e-9, `quant hit bits=${rec.surpriseBits}`);
  assert.equal(eng.stats().coarseAssisted, 0, '量化层 ≠ 粗层 —— 粗层账不掺水分');
  assert.equal(eng.stats().hits, 1);
  assert.equal(eng.stats().noModel, 1, '无知仍是无知 —— 量化层不追溯改判');
  assert.match(prophecyJournalTag({ ...rec, outcome: 'miss', surpriseBits: 2.5 }), /，惊异 2\.5 bits，via 量化层）$/, '注记如实标注量化层');

  // 判别力：不同量化格（上 48 位不同）⇒ 仍诚实无知（量化不吞判别力）
  eng.mint('9999888877770000', 'click@00');
  assert.equal(eng.settle('1234123412340000', true)!.outcome, 'no-model', '冷格不因量化层的存在而伪装');

  // 纯函数面：mintProphecy 梯级 —— 原始键有证据 ⇒ 'exact'（字节级复现通道照旧）
  const exactRec = mintProphecy(wm, v1, 'click@00', 5);
  assert.equal(exactRec.predictedVia, 'exact');
  assert.equal(exactRec.predictedType, 'dddd111122220000');
  assert.equal(exactRec.outcome, 'pending');
});

// ─── R18-2 量化档位内核键可调 ───

test('R18-2: 档位经内核键可调 —— 缺省 12；16 = 关量化（旧行为）；8 = 掩低 32 位；未注册零行为变化', () => {
  assert.equal(kernelRegistry.getOrDefault(PROPHECY_QUANT_KERNEL_KEY, QUANT_KEEP_HEX), QUANT_KEEP_HEX,
    '未注册 ⇒ 回声常量缺省（零行为变化的生产缺省面）');
  kernelRegistry.register({
    key: PROPHECY_QUANT_KERNEL_KEY, organ: 'prophecy',
    defaultValue: 12, min: 8, max: 16,
    note: 'ΑΩ-R18：量化屏型主键保留位数（hex 字）；16 = 关量化回到原始 dhash 主键',
  });
  try {
    assert.equal(quantizedScreenType('aaaabbbbcccc00f1'), 'aaaabbbbcccc0000', '注册缺省 12 与常量档逐字节一致');
    assert.ok(kernelRegistry.set(PROPHECY_QUANT_KERNEL_KEY, 16).ok);
    assert.equal(quantizedScreenType('aaaabbbbcccc00f1'), 'aaaabbbbcccc00f1', '档位 16 = 不量化（逃生门）');
    assert.ok(kernelRegistry.set(PROPHECY_QUANT_KERNEL_KEY, 8).ok);
    assert.equal(quantizedScreenType('aaaabbbbcccc00f1'), 'aaaabbbb00000000', '档位 8 = 掩低 32 位（与粗层同粒、键形不同）');
    // 越界夹取：注册区间 [8,16] 外的值被 registry 夹回
    assert.ok(kernelRegistry.set(PROPHECY_QUANT_KERNEL_KEY, 99).ok);
    assert.equal(quantizedScreenType('aaaabbbbcccc00f1'), 'aaaabbbbcccc00f1', '越 16 夹回 16 = 关量化');

    // 行为面：档位 16（关量化）下梯级退回 exact→coarse 两层旧行为 —— 抖动变体
    // 只能靠 D-G2 粗层得预言（quant 层缺席，绝不伪造）
    kernelRegistry.set(PROPHECY_QUANT_KERNEL_KEY, 16);
    const wm = new InMemoryWorldModel();
    const eng = new ProphecyEngine({ worldModel: wm, now: () => 1 });
    eng.mint('aaaabbbbcccc0000', 'k');
    eng.settle('dddd111122220000', true); // 三写在 {原始, 粗格}（量化键 = 原始键，去重）
    eng.mint('aaaabbbbcccc00f1', 'k');    // 抖动变体：原始键查无、量化（=原始）查无
    const rec = eng.settle('dddd111122220000', true)!;
    assert.equal(rec.predictedVia, 'coarse', '关量化 ⇒ 抖动变体落 D-G2 粗层（旧两层的梯级还原）');
    assert.equal(rec.outcome, 'hit');
  } finally {
    resetKernelRuntime(); // 测试隔离（本用例的注册不留痕）
  }
  assert.equal(quantizedScreenType('aaaabbbbcccc00f1'), 'aaaabbbbcccc0000', 'reset 后回到常量缺省档');
});

// ─── R18-3 有界 keyed pending：并发双预言各得其所 ───

test('R18-3: keyed pending —— 双预言并发各得其所（LIFO 配对）；容量溢出最旧作废计入 expired；TTL 作废律不动', () => {
  // 并发双铸：旧单槽会静默覆盖第一条 —— keyed pending 各占一槽、结算各得其所
  const eng = new ProphecyEngine({ worldModel: null, now: () => 5_000 });
  eng.mint('s1', 'k1');
  eng.mint('s2', 'k2');
  assert.equal(eng.stats().pending, 2, '双预言共存（单槽时代此处只剩 1 —— 覆盖丢件）');
  const second = eng.settle('B', true);
  assert.ok(second !== null, '最近铸造可得结算');
  assert.equal(second.actionKey, 'k2', 'LIFO 配对：结算见证恒属最近执行的动作');
  const first = eng.settle('A', true);
  assert.ok(first !== null, '早铸预言不被后来者顶掉 —— 各得其所（旧单槽此处 null）');
  assert.equal(first.actionKey, 'k1');
  assert.equal(first.screenType, 's1');
  assert.equal(eng.stats().pending, 0);
  assert.equal(eng.records().length, 2, '双预言双双入账');
  assert.equal(eng.settle('C', true), null, '无待结算 ⇒ null');

  // 容量律：pendingSlots=2 ⇒ 第三铸最旧作废（expired 有痕）且不可再结算
  let clock = 1_000;
  const cap = new ProphecyEngine({ worldModel: null, now: () => clock, pendingSlots: 2 });
  cap.mint('a', 'k1');
  cap.mint('b', 'k2');
  cap.mint('c', 'k3'); // 容量 2 ⇒ 最旧 a 作废
  assert.equal(cap.stats().pending, 2);
  assert.equal(cap.stats().expired, 1, '容量溢出最旧作废计入作废计数');
  assert.equal(cap.settle('X', true)!.actionKey, 'k3', 'LIFO：先结最近');
  assert.equal(cap.settle('Y', true)!.actionKey, 'k2');
  assert.equal(cap.settle('Z', true), null, 'a 已作废 ⇒ 绝不伪造第三结算');

  // TTL 律：挂起 60s 取不到真实屏型 ⇒ 作废（不因 keyed 化而松动）
  cap.mint('d', 'k4');
  cap.mint('e', 'k5');
  clock += 61_000; // 越过 60s TTL
  cap.mint('f', 'k6'); // d/e 超时作废
  const st = cap.stats();
  assert.equal(st.expired, 3, 'TTL 作废 ×2 叠加容量作废 ×1');
  assert.equal(st.pending, 1, '作废不牵连后来者');
  assert.equal(cap.settle(null), null, '见证缺席 ⇒ 挂起（绝不伪造）');

  // 坏参数收口：pendingSlots 夹 [1,64]
  const weird = new ProphecyEngine({ worldModel: null, now: () => 1, pendingSlots: -3 });
  weird.mint('x', 'k');
  weird.mint('y', 'k');
  assert.equal(weird.settle('z', true)!.screenType, 'y', '负槽数夹到 1 —— 单槽退化（最近者胜）');
});

// ─── R18-4 回归：dump/restore 白名单收 'quant'；永不抛面在两修后不动 ───

test('R18-4: 回归 —— 快照白名单收 quant、域外值弃置；垃圾输入面永不抛', () => {
  // R18-1 场景的账本快照往返：quant 来源层如实复活
  const wm = new InMemoryWorldModel();
  const eng = new ProphecyEngine({ worldModel: wm, now: () => 1_000 });
  eng.mint('aaaabbbbcccc0000', 'click@00');
  eng.settle('dddd111122220000', true);
  eng.mint('aaaabbbbcccc00f1', 'click@00');
  eng.settle('dddd11112222003c', true);
  const snap = eng.dump();
  assert.equal(snap.records[snap.records.length - 1].predictedVia, 'quant');

  const twin = new ProphecyEngine({ worldModel: null, now: () => 1_000 });
  twin.restore(snap);
  assert.deepEqual(twin.dump(), snap, '快照往返逐字段等（quant 白名单）');
  twin.restore({
    version: 1, expired: 0,
    records: [
      { screenType: 's', actionKey: 'k', outcome: 'miss', ts: 1, predictedVia: 'quant' },
      { screenType: 's', actionKey: 'k2', outcome: 'miss', ts: 2, predictedVia: 'galactic' },
    ],
  } as never);
  const restored = twin.records();
  assert.equal(restored[restored.length - 2].predictedVia, 'quant', 'quant 入白名单');
  assert.equal(restored[restored.length - 1].predictedVia, undefined, '域外来源层弃置（防御式水合）');

  // 垃圾输入永不抛（两修后的运行层铁律复证）
  const junk = new ProphecyEngine({ worldModel: null, now: () => 1 });
  junk.mint(null, '');
  junk.mint('', 'k');
  junk.mint('ok', '');
  assert.equal(junk.stats().pending, 0, '盲屏/空键不铸');
  assert.equal(junk.settle(undefined), null);
  junk.restore(null);
  junk.restore('garbage');
  assert.equal(junk.dump().records.length, 0);
});

// ─── ΝΩ-11：惊异夹帽 [0,12] bits（错题本排序不被单条伪影拉爆） ───

test('ΝΩ-11: 惊异上界 12 —— 回退定价 p→1 的 miss ~29.9 bits 离群钉帽；读面同律；真实读数零影响', () => {
  // 夹帽出册常数与夹取函数三档：负/NaN 归 0、帽内直通、越帽钉 12
  assert.equal(SURPRISE_MAX_BITS, 12, '信息论上界出册在册（论证见 internal.ts 常量注：环形账本 500 条 ⇒ 任一格可分辨后继 ≤500 ⇒ 均匀最坏 log₂500≈8.97 bits，12 = 宽松上界）');
  assert.equal(clampSurpriseBits(-5), 0, '负读数归 0（防御下界）');
  assert.equal(clampSurpriseBits(0), 0);
  assert.equal(clampSurpriseBits(3.2), 3.2, '帽内直通（真实读数零影响）');
  assert.equal(clampSurpriseBits(12), 12, '帽沿含端点');
  assert.equal(clampSurpriseBits(29.897), 12, '越帽钉 12');
  assert.equal(clampSurpriseBits(Number.NaN), 0, 'NaN 防御归 0');

  // 回退定价（无模型面）：p=1 的 miss 原生 −log₂(1−1e-9)≈29.897 bits —— ε 地板
  // 伪影不是真实判别信息 ⇒ 钉帽 12（旧路径此处 ~29.9，错题本平均惊异与排序被单条拉爆）
  const rec = (p?: number): { screenType: string; actionKey: string; outcome: 'pending'; ts: number; predictedType: string; predictedProb?: number } => ({
    screenType: 's', actionKey: 'k', outcome: 'pending', ts: 1, predictedType: 'X',
    ...(p !== undefined ? { predictedProb: p } : {}),
  });
  assert.equal(settleSurpriseBits(rec(1), 'Y', 'miss', undefined), 12, 'p→1 的 miss 夹帽 12');
  assert.ok(Math.abs(-Math.log2(1e-9)) > 12, '前置：原生定价 ~29.9 bits 确实越帽（夹帽的判别面）');

  // 真实量级零影响（手算，六位小数取整口径）：p=2/3 miss ⇒ −log₂(1/3)=1.584963；
  // p=0.5 ⇒ 1；hit p=2/3 ⇒ −log₂(2/3)=0.584963
  assert.ok(Math.abs((settleSurpriseBits(rec(2 / 3), 'Y', 'miss', undefined) ?? -1) - 1.584963) < 1e-9);
  assert.ok(Math.abs((settleSurpriseBits(rec(0.5), 'Y', 'miss', undefined) ?? -1) - 1) < 1e-9);
  assert.ok(Math.abs((settleSurpriseBits(rec(2 / 3), 'X', 'hit', undefined) ?? -1) - 0.584963) < 1e-9);
  // 无概率读数 ⇒ 中性 0.5 定价，同样在帽内
  assert.ok(Math.abs((settleSurpriseBits(rec(), 'Y', 'miss', undefined) ?? -1) - 1) < 1e-9);

  // 读面（世界模型 surprise）同律夹帽：模型报 50 bits（病态读数）⇒ 12；报 3.2 ⇒ 原样
  const loud: WorldModel = {
    typeOf: () => null,
    observe: () => ({ ok: true as const, value: undefined }),
    predict: () => ({ ok: true as const, value: null }),
    surprise: (from: string) => ({ ok: true as const, value: { bits: from === 'loud' ? 50 : 3.2, novel: true, evidence: 1 } }),
  };
  assert.equal(settleSurpriseBits({ ...rec(0.9), screenType: 'loud' }, 'Y', 'miss', loud), 12, '读面 50 bits 同律钉帽');
  assert.ok(Math.abs((settleSurpriseBits({ ...rec(0.9), screenType: 'calm' }, 'Y', 'miss', loud) ?? -1) - 3.2) < 1e-9, '读面 3.2 bits 直通');

  // 引擎面：整条 miss 的 surpriseBits ≤ 12 恒成立（错题本/平均惊异的消费面口径）
  const eng = new ProphecyEngine({ worldModel: null, now: () => 1, learn: false });
  eng.mint('aaaabbbbcccc0000', 'click@00'); // 无模型 ⇒ no-model 铸造（无预言无惊异）
  eng.settle('dddd111122220000', true);
  assert.ok(eng.records().every(r => (r.surpriseBits ?? 0) <= SURPRISE_MAX_BITS), '账内惊异恒 ≤ 12');
});
