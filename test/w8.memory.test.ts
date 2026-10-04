// test/w8.memory.test.ts
// W8-B5 执法册 —— 两条升级的验收：
//   任务一 failureMemory：容量可配置 + 注入时钟 + 显著性感知淘汰
//     （新近性 / 去重命中数 / 根因拥挤罚 + 独苗保护硬配额；纯 FIFO 是全库
//      同根因时的退化特例）。记录五元组结构零改动（checkpoint 兼容铁律）。
//   任务二 selfmodel：24bit 两段式场景桶（16bit 粗段 = 旧桶逐位同律、前缀保持；
//     8bit 细段行密度位图）+ 旧 16bit 桶键的诚实迁移（细→粗聚合进单轴格，
//     绝不伪造细段；冷启动 null 语义零变化）。
// 全程离线、注入时钟、确定性（零网络零真钟零真睡）；期望值全部手算硬编码。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  failureMemory,
  configureFailureMemory,
} from '../src/failureMemory.ts';
import { SelfModel, selfModel, resetSelfModel, sceneBucketFromFingerprint } from '../src/selfmodel/index.ts';
import { saveCheckpoint, loadCheckpoint } from '../src/checkpoint.ts';
import { uiMemory } from '../src/uiMemory.ts';
import { skillLibrary } from '../src/skillLibrary.ts';
import { telemetry } from '../src/telemetry.ts';
import { journal } from '../src/journal.ts';

let dir: string;
const dirs: string[] = [];
beforeEach(() => {
  uiMemory.reset();
  failureMemory.reset();
  skillLibrary.reset();
  telemetry.reset();
  journal.reset();
  resetSelfModel();
  dir = mkdtempSync(join(tmpdir(), 'w8-memory-'));
  dirs.push(dir); // 每用例一个目录 —— 退出时逐个回收（只留最后一个 = 泄漏）
});

// ═══ 任务一：failureMemory 显著性淘汰 ═══

test('M-1: 缺省容量 30 保持 —— 31 条挤 1 条；非法容量配置被忽略；收缩即刻执法', () => {
  // 首用例跑在纯净单例上（测试册内序即执行序）：未 configure ⇒ 容量缺省 30。
  // 31 条互异（query/approach 各异 ⇒ 不触近重复去重）；真实钟下同批 at 近同、
  // 全库同 unknown 桶（无 rootCause 字段）⇒ 并列按 id 升序 ⇒ 最旧者走（FIFO 退化特例）。
  for (let i = 0; i < 31; i++) failureMemory.record(`q${i}`, `a${i}`, 'no change');
  assert.equal(failureMemory.size, 30, '缺省库容 30（历史语义钉死）');
  assert.ok(!failureMemory.dump().records.some(r => r.query === 'q0'), '并列 ⇒ id 最小（最旧）者被逐');
  assert.ok(failureMemory.dump().records.some(r => r.query === 'q30'), '新记录在场');
  failureMemory.reset();

  // 非法容量：0 / 2.5 / NaN / 非数 ⇒ 逐键忽略（容量保持 30 不变）
  configureFailureMemory({ capacity: 0 });
  configureFailureMemory({ capacity: 2.5 });
  configureFailureMemory({ capacity: Number.NaN });
  configureFailureMemory({ capacity: 'x' as never });
  for (let i = 0; i < 31; i++) failureMemory.record(`r${i}`, `b${i}`, 'no change');
  assert.equal(failureMemory.size, 30, '非法容量全部被忽略 ⇒ 仍 30');
  failureMemory.reset();

  // 合法容量 5 + 注入时钟：7 条 ⇒ 5 条
  const T = 1_700_000_000_000;
  configureFailureMemory({ capacity: 5, now: () => T });
  for (let i = 0; i < 7; i++) failureMemory.record(`s${i}`, `c${i}`, 'no change', undefined, 'stall');
  assert.equal(failureMemory.size, 5, '容量 5 执法');
  // 收缩即刻执法：5 → 2 ⇒ 立即按显著性淘汰到 2（全同根因同刻 ⇒ 并列按 id 升序；
  // 注：reset 不清 nextId（checkpoint 铁律：id 全进程单调）⇒ 以 query 断言而非裸 id）
  configureFailureMemory({ capacity: 2 });
  assert.equal(failureMemory.size, 2, 'configure 收缩库容即刻淘汰');
  const keptQueries = failureMemory.dump().records.map(r => r.query);
  assert.deepEqual(keptQueries, ['s5', 's6'], '同根因同刻并列 ⇒ 最旧两条让位（FIFO 退化特例）');
});

test('M-2: 同根因保留配额（独苗保护）—— 最旧的异见根因不让位同根因大军', () => {
  const T = 1_700_000_000_000;
  const HL = 24 * 3_600_000; // 新近性半衰期（24h，模块常量同值 —— 手算基准）
  configureFailureMemory({ capacity: 4, now: () => T });
  // b1（blind-spot-text 独苗）最旧：@T；四条 stall 大军全新：@T+10HL
  failureMemory.record('qb', 'ab', 'missed', undefined, 'blind-spot-text');
  const t2 = T + 10 * HL;
  configureFailureMemory({ now: () => t2 });
  failureMemory.record('q1', 'a1', 'stalled', undefined, 'stall');
  failureMemory.record('q2', 'a2', 'stalled', undefined, 'stall');
  failureMemory.record('q3', 'a3', 'stalled', undefined, 'stall');
  failureMemory.record('q4', 'a4', 'stalled', undefined, 'stall'); // 容量 4 ⇒ 挤 1
  let recs = failureMemory.dump().records;
  assert.equal(failureMemory.size, 4);
  assert.ok(recs.some(r => r.query === 'qb'), '独苗根因免逐（虽最旧、新近性≈2⁻¹⁰）—— 多样性硬下限');
  assert.ok(!recs.some(r => r.query === 'q1'), 'stall 大军（桶 4 条 ⇒ 拥挤罚 1.5）内最旧者让位');
  assert.ok(recs.some(r => r.query === 'q4'), '最新 stall 在场');

  // 无 ≥2 的桶时独苗保护不适用（全独苗 ⇒ 纯显著性序）：三条异根因 + 挤入
  // 第四条 ⇒ 逐出最旧（新近性最低；拥挤罚全 0）
  configureFailureMemory({ capacity: 3, now: () => T });
  failureMemory.record('o1', 'x1', 's', undefined, 'stall');       // @T 最旧
  configureFailureMemory({ now: () => T + 10 * HL });
  failureMemory.record('o2', 'x2', 's', undefined, 'blind-spot-text');
  failureMemory.record('o3', 'x3', 's', undefined, 'over-strict-verification');
  failureMemory.record('o4', 'x4', 's', undefined, 'unknown'); // 挤 1（三根因互异 ⇒ 全独苗）
  recs = failureMemory.dump().records;
  assert.ok(!recs.some(r => r.query === 'o1'), '全独苗 ⇒ 无拥挤罚 ⇒ 纯新近性序：最旧者走');
  assert.ok(recs.some(r => r.query === 'o2') && recs.some(r => r.query === 'o3') && recs.some(r => r.query === 'o4'));
});

test('M-3: 显著性淘汰确定性（注入时钟）—— 新近性 / 去重命中数 / 并列 FIFO 退化 / 复跑一致', () => {
  const T = 1_700_000_000_000;
  const HL = 24 * 3_600_000;

  // (a) 同桶内新近性决胜：同根因、同命中，最旧者（新近性 2⁻¹⁰ ≈ 0.001）先走
  configureFailureMemory({ capacity: 3, now: () => T });
  failureMemory.record('q1', 'a1', 's', undefined, 'stall'); // @T 最旧
  const t2 = T + 10 * HL;
  configureFailureMemory({ now: () => t2 });
  failureMemory.record('q2', 'a2', 's', undefined, 'stall');
  failureMemory.record('q3', 'a3', 's', undefined, 'stall');
  failureMemory.record('q4', 'a4', 's', undefined, 'stall'); // 挤 1
  assert.ok(!failureMemory.dump().records.some(r => r.query === 'q1'), '同桶 ⇒ 新近性最低者走（旧 FIFO 语义的推广）');
  assert.equal(failureMemory.size, 3);
  failureMemory.reset();

  // (b) 去重命中数决胜：同桶同刻 ⇒ 拥挤罚同配（不扰桶内序），有近重复命中者
  //     （重复度 +1/3）幸存、无命中者先走（无命中并列 ⇒ id 小者走）
  configureFailureMemory({ capacity: 3, now: () => T });
  failureMemory.record('qa', 'aa', 's1', undefined, 'stall');   // id 1 —— 稍后吃一次去重命中
  failureMemory.record('qb', 'ab', 's2', undefined, 'stall');   // id 2 —— 零命中
  failureMemory.record('qa', 'aa', 's1-again', undefined, 'stall'); // 近重复（5 分钟窗口内）⇒ 命中 +1，不入新条
  assert.equal(failureMemory.size, 2, '近重复去重：不新增条目');
  failureMemory.record('qc', 'ac', 's3', undefined, 'stall');   // id 3 ⇒ 满 3
  failureMemory.record('qd', 'ad', 's4', undefined, 'stall');   // id 4 ⇒ 挤 1
  const kept = failureMemory.dump().records.map(r => r.query).sort();
  assert.deepEqual(kept, ['qa', 'qc', 'qd'], 'qa（命中 1 ⇒ 重复度 1/3 加权）幸存；qb/c 并列 ⇒ id 小者 qb 走');
  failureMemory.reset();

  // (c) 全并列（同根因/同刻/零命中）⇒ id 升序 = FIFO 退化特例（旧策略是新策略的退化形）
  configureFailureMemory({ capacity: 3, now: () => T });
  for (let i = 0; i < 5; i++) failureMemory.record(`f${i}`, `g${i}`, 's', undefined, 'stall');
  assert.deepEqual(
    failureMemory.dump().records.map(r => r.query),
    ['f2', 'f3', 'f4'],
    '全并列 ⇒ 先入先出（逐出序 f0→f1）',
  );
  failureMemory.reset();

  // (d) 复跑确定性：同一剧本跑两遍 ⇒ 账本一致（淘汰决策零掷硬币）。reset 不清
  //     nextId（id 全进程单调 —— checkpoint 铁律）⇒ 比较剥去 id 的记录面
  const script = (): Array<Omit<ReturnType<typeof failureMemory.dump>['records'][number], 'id'>> => {
    failureMemory.reset();
    configureFailureMemory({ capacity: 4, now: () => T });
    failureMemory.record('dq', 'da', 's', undefined, 'stall');
    failureMemory.record('dq', 'da', 's2', undefined, 'blind-spot-text'); // 去重命中 + 病因刷新
    configureFailureMemory({ now: () => T + 10 * HL });
    for (let i = 0; i < 5; i++) failureMemory.record(`eq${i}`, `ea${i}`, 's', undefined, 'stall');
    return failureMemory.dump().records.map(({ id: _id, ...rest }) => rest);
  };
  assert.deepEqual(script(), script(), '复跑逐字段一致（注入钟下确定性）');
});

test('M-4: checkpoint 旧档往返兼容 —— 30 条旧档（无 rootCause 字段）载入新策略不丢不炸；五元组结构零泄漏', () => {
  const T = 1_700_000_000_000;
  configureFailureMemory({ capacity: 30, now: () => T });
  // 铸旧档形态：30 条互异（部分带 sceneHash），一半无 rootCause 字段（W1-6 之前的档）
  for (let i = 0; i < 30; i++) {
    failureMemory.record(
      `old-q${i}`, `old-a${i}`, 'no change',
      i % 2 === 0 ? `${i}${'0'.repeat(15)}` : undefined,
      i % 3 === 0 ? 'stall' : undefined,
    );
    configureFailureMemory({ now: () => T + i }); // at 递增（注入钟步进）
  }
  const dumped = failureMemory.dump();
  assert.equal(dumped.records.length, 30);
  // 五元组结构铁律：行键 ⊆ {id,query,approach,symptom,sceneHash,rootCause,at} —— 无 hits 等新字段泄漏
  for (const r of dumped.records) {
    const keys = Object.keys(r).sort();
    for (const k of keys) {
      assert.ok(
        ['approach', 'at', 'id', 'query', 'rootCause', 'sceneHash', 'symptom'].includes(k),
        `记录结构越界字段：${k}（checkpoint 兼容铁律）`,
      );
    }
  }

  // 序列化往返（JSON 与 checkpoint 面同律）⇒ 30 条全员无损复活。
  // 注：JSON 序列化会剥掉 sceneHash:undefined 的属性在位性（旧档本就无此键）⇒
  // 以扁平化后的期望为准 —— 恢复→再 dump 与落盘形态逐字段等价
  const flat = JSON.parse(JSON.stringify(dumped)) as typeof dumped;
  failureMemory.reset();
  assert.equal(failureMemory.size, 0);
  failureMemory.restore(flat);
  assert.equal(failureMemory.size, 30, '旧档 30 条载入新策略：不丢');
  const revived = failureMemory.dump().records;
  assert.deepEqual(revived, flat.records, '逐字段无损（含 rootCause/sceneHash 缺席语义）');
  assert.equal(failureMemory.matchByRootCause('stall', 30).length, 10, '按病因检索照常（10 条 stall；缺省 k=5 会截断 ⇒ 显式给 k）');
  assert.equal(failureMemory.matchByRootCause('unknown', 30).length, 20, '无字段 ⇒ unknown 桶（旧档语义）');

  // 恢复后新策略继续执法：新 blind-spot-text 记录（独苗保护 + 拥挤罚 0）⇒ 逐出的
  // 是 unknown 大军（20 条 ⇒ 拥挤罚 9.5，远深于 stall 桶的 4.5）内新近性最低者
  // —— 桶内最旧 old-q1（i=1，at=T），而非盲目 FIFO 全局最旧 old-q0（它是 stall
  // 桶成员，分数更高）或新记录本尊
  configureFailureMemory({ now: () => T + 100_000 });
  failureMemory.record('fresh-q', 'fresh-a', 'no change', undefined, 'blind-spot-text');
  assert.equal(failureMemory.size, 30, '容量执法照常');
  const after = failureMemory.dump().records;
  assert.ok(!after.some(r => r.query === 'old-q1'), 'unknown 桶（拥挤罚最重）内 at 最小者让位');
  assert.ok(after.some(r => r.query === 'old-q0'), 'stall 桶成员（拥挤罚较浅）不被 unknown 挤压连坐');
  assert.ok(after.some(r => r.query === 'old-q3'), 'stall 桶成员照常在库');
  assert.ok(after.some(r => r.query === 'fresh-q'), '新记录在场（独苗保护）');
  // 去重命中数不落盘：恢复后的淘汰只信落盘字段（本用例无命中 —— 结构面已证零泄漏）
});

// ═══ 任务二：selfmodel 24bit 两段式场景桶 ═══

/** 铸 64 位 row-major dhash 位串：谓词 (row, col) → 0/1 */
function bits(pred: (row: number, col: number) => 0 | 1): string {
  let s = '';
  for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) s += pred(row, col);
  return s;
}

test('M-5: 新粒度区分度 —— 旧 16bit 同桶（粗段全 ffff）的三个指纹现被细段分桶；独立记账；微抖吸收', () => {
  // 三个指纹的粗段（4×4 块均值位图）完全相同（每块恰 2 个 1 ⇒ 全 ffff）——
  // 在旧 16bit 方言下三者同桶（混桶）；细段（8 行行密度 ≥4 记 1）将其分开。
  const fpTop = bits((r) => (r % 2 === 0 ? 1 : 0));          // 偶数行全 1：细段位 0,2,4,6 = 0x55
  const fpBot = bits((r) => (r % 2 === 1 ? 1 : 0));          // 奇数行全 1：细段位 1,3,5,7 = 0xaa
  const fpChecker = bits((r, c) => ((r + c) % 2 === 0 ? 1 : 0)); // 棋盘：每行恰 4 个 1 ⇒ 细段 0xff
  const bTop = sceneBucketFromFingerprint(fpTop)!;
  const bBot = sceneBucketFromFingerprint(fpBot)!;
  const bChecker = sceneBucketFromFingerprint(fpChecker)!;
  assert.equal(bTop, 'ffff55', '偶行全 1 ⇒ 粗段 ffff + 细段 0x55');
  assert.equal(bBot, 'ffffaa', '奇行全 1 ⇒ 粗段 ffff + 细段 0xaa');
  assert.equal(bChecker, 'ffffff', '棋盘 ⇒ 粗段 ffff + 细段 0xff（每行 4/8 ≥ 阈值 4）');
  // 前缀保持性质：新桶串前 4 位 = 旧 16bit 桶（三者在旧方言同为 'ffff' —— 混桶证据）
  assert.deepEqual([bTop, bBot, bChecker].map(b => b.slice(0, 4)), ['ffff', 'ffff', 'ffff']);
  assert.notEqual(bTop, bBot);
  assert.notEqual(bTop, bChecker);
  assert.notEqual(bBot, bChecker, '旧混桶场景现在三桶分立 —— 精化达成');
  // 微抖吸收：偶行指纹在奇行翻 1 位 ⇒ 所在块 3/4 ≥ 2（粗段不变）、所在行 1/8 < 4（细段不变）
  const flipped = fpTop.slice(0, 8) + '1' + fpTop.slice(9); // (row 1, col 0) 0→1
  assert.equal(sceneBucketFromFingerprint(flipped), 'ffff55', '块多数 + 行多数双阈值吸收单 bit 微抖');

  // 独立记账：同 actionKind 三桶各 8 成 ⇒ 三格独立（互不合并、不流窜单轴）
  const sm = new SelfModel();
  sm.configure({ minEvidence: 8, halfLifeH: 168, now: () => 1_000 });
  for (const b of [bTop, bBot, bChecker]) {
    for (let i = 0; i < 8; i++) sm.recordOutcome({ actionKind: 'click_mouse', sceneBucket: b }, true, 1_000);
  }
  assert.equal(sm.stats().cells, 3, '三桶三格（旧方言会并成一格 —— 区分度在册）');
  for (const b of [bTop, bBot, bChecker]) {
    const c = sm.competence({ actionKind: 'click_mouse', sceneBucket: b })!;
    assert.ok(c && Math.abs(c.n - 8) < 1e-9 && Math.abs(c.mean - 0.9) < 1e-9, `格 ${b} 独立记账 n=8、Beta(9,1) 均值 0.9`);
  }
  // adviseConfidence 用指纹原文分格（量化在实现内）：三指纹各命中各格
  const advTop = sm.adviseConfidence({ kind: 'click_mouse' }, fpTop);
  assert.ok(advTop && advTop.n === 8 && Math.abs(advTop.confidence - 0.9) < 1e-9, '指纹→细桶→独立格');
});

test('M-6: 迁移兼容 —— 旧 16bit 桶键细→粗聚合进单轴格（不伪造细段、不丢证据）；新粒度键原样往返；垃圾桶键不迁移动', () => {
  const T0 = 1_700_000_500_000;
  const HL = 3_600_000; // halfLifeH=1 的一个半衰期（ms）

  // (a) 同刻聚合：axis 4/2 + 旧桶格 8/0 @同 lastTs ⇒ 并集 12/2（零折算，直接求和）
  const sm = new SelfModel();
  sm.configure({ now: () => T0, halfLifeH: 1, minEvidence: 2 });
  sm.restore({
    version: 1, settledAt: T0,
    cells: [
      { key: 'click_mouse', s: 4, f: 2, lastTs: T0 },
      { key: 'click_mouse|f3a0', s: 8, f: 0, lastTs: T0 }, // 旧 16bit 粗桶键
    ],
  });
  assert.deepEqual(
    sm.dump().cells,
    [{ key: 'click_mouse', s: 12, f: 2, lastTs: T0 }],
    '旧桶格聚合进单轴格（计数求和、lastTs 取 max）；无 f3a0 伪造新粒度格',
  );
  const c = sm.competence({ actionKind: 'click_mouse' })!;
  assert.ok(Math.abs(c.n - 14) < 1e-9 && Math.abs(c.mean - 13 / 16) < 1e-9, 'Beta(13,3) 均值 13/16（证据保全，非冷启动丢证）');
  assert.equal(sm.competence({ actionKind: 'click_mouse', sceneBucket: 'f3a0c9' }), null, '新粒度格上无账（诚实冷启动）');

  // (b) 异刻聚合：旧桶格更老（T0−2HL）⇒ 并集前先按懒衰减折算到基准（×2⁻²）
  const sm2 = new SelfModel();
  sm2.configure({ now: () => T0, halfLifeH: 1, minEvidence: 2 });
  sm2.restore({
    version: 1, settledAt: T0,
    cells: [
      { key: 'a', s: 4, f: 0, lastTs: T0 },
      { key: 'a|ffff', s: 8, f: 0, lastTs: T0 - 2 * HL },
    ],
  });
  const c2 = sm2.competence({ actionKind: 'a' })!;
  assert.ok(Math.abs(c2.n - 6) < 1e-9, `s = 4 + 8×2⁻² = 6（实测 ${c2.n}）—— 不同时点证据先折算再相加`);
  assert.ok(Math.abs(c2.mean - 7 / 8) < 1e-9, 'Beta(7,1) 均值 7/8');

  // (c) 两个旧桶格、无单轴行 ⇒ 聚合产单轴格（建格语义）
  const sm3 = new SelfModel();
  sm3.configure({ now: () => T0, halfLifeH: 1, minEvidence: 2 });
  sm3.restore({
    version: 1, settledAt: T0,
    cells: [
      { key: 'm|f3a0', s: 8, f: 0, lastTs: T0 },
      { key: 'm|0f1c', s: 8, f: 0, lastTs: T0 },
    ],
  });
  assert.deepEqual(sm3.dump().cells, [{ key: 'm', s: 16, f: 0, lastTs: T0 }], '两旧桶 → 单轴并集格');

  // (d) 新粒度键与其余键原样入账（往返逐字段等价不破）；垃圾桶键不迁移动（死格无害）
  const snap = {
    version: 1 as const, settledAt: T0,
    cells: [
      { key: 'x|f3a0c9', s: 3, f: 1, lastTs: T0 },
      { key: 'x', s: 1, f: 1, lastTs: T0 },
      { key: 'x|zzzz', s: 2, f: 2, lastTs: T0 }, // 非十六进制桶 ⇒ 旧语义原样保留（不迁移不删）
    ],
  };
  const sm4 = new SelfModel();
  sm4.configure({ now: () => T0, halfLifeH: 1, minEvidence: 2 });
  sm4.restore(snap);
  assert.equal(sm4.stats().cells, 3, '三行全入账（新桶键/单轴键/死格键）');
  const cx = sm4.competence({ actionKind: 'x', sceneBucket: 'f3a0c9' })!;
  assert.ok(cx && Math.abs(cx.mean - 4 / 6) < 1e-9, '新粒度键格照常可读（Beta(4,2)）');
  assert.deepEqual(sm4.dump().cells, snap.cells, '非迁移行 ⇒ dump/restore 逐字段等价');

  // (e) 永不抛：垃圾快照全吸收
  assert.doesNotThrow(() => sm4.restore(null));
  assert.doesNotThrow(() => sm4.restore({ cells: 42 }));
  assert.doesNotThrow(() => sm4.restore({ cells: [{ key: 'a|f3a0' }] })); // 缺数行 ⇒ 弃（半水合）
  assert.equal(sm4.stats().cells, 0, '坏行弃置 ⇒ 空账（半水合诚实）');
});

test('M-7: adviseConfidence 冷启动 null 语义不变；旧 4 位粗桶串作指纹 ⇒ 诚实降级单轴（非 null 建议伪造）', () => {
  const T = 1_700_000_600_000;
  const sm = new SelfModel();
  sm.configure({ minEvidence: 8, halfLifeH: 168, now: () => T });
  // 新粒度指纹冷启动：7 成 < 8 ⇒ null（绝不 0.5 假数据）
  const fpTop = bits((r) => (r % 2 === 0 ? 1 : 0)); // 'ffff55'
  for (let i = 0; i < 7; i++) sm.recordOutcome({ actionKind: 'click_mouse', sceneBucket: 'ffff55' }, true, T);
  assert.equal(sm.adviseConfidence({ kind: 'click_mouse' }, fpTop), null, 'n=7 < minEvidence=8 ⇒ 诚实 null');
  sm.recordOutcome({ actionKind: 'click_mouse', sceneBucket: 'ffff55' }, true, T);
  const adv = sm.adviseConfidence({ kind: 'click_mouse' }, fpTop);
  assert.ok(adv && adv.n === 8 && Math.abs(adv.confidence - 0.9) < 1e-9 && adv.source === 'self-model', 'n=8 ⇒ Beta(9,1) 均值 0.9');

  // 旧 4 位粗桶串不可再铸细段（sceneBucketFromFingerprint ⇒ null）⇒ 降级单轴查询：
  // 单轴有账 ⇒ 给单轴建议（诚实降级路径），绝不因方言收窄而伪造 null/伪桶
  for (let i = 0; i < 8; i++) sm.recordOutcome({ actionKind: 'press_hotkey' }, true, T);
  assert.equal(sceneBucketFromFingerprint('f3a0'), null, '旧粗桶串 ⇒ null（细段不可恢复，不伪造）');
  const degraded = sm.adviseConfidence({ kind: 'press_hotkey' }, 'f3a0');
  assert.ok(degraded && degraded.n === 8 && degraded.source === 'self-model', '坏/旧指纹 ⇒ 单轴格建议（降级不弃读）');
  // 全新动作（无任何账）⇒ null —— 冷启动语义与 Ι 纪元逐字节同律
  assert.equal(sm.adviseConfidence({ kind: 'never_done' }, fpTop), null);
});

test('M-8: 真实 checkpoint 通路 —— 新档往返无损；手改旧 16bit 桶键档 ⇒ load 时聚合迁移执法（其余段不连坐）', async () => {
  const T0 = 1_700_000_700_000;
  selfModel.configure({ now: () => T0, halfLifeH: 1, minEvidence: 2 });
  for (let i = 0; i < 6; i++) selfModel.recordOutcome({ actionKind: 'click_mouse', sceneBucket: 'ffff55' }, true, T0);
  failureMemory.configure({ capacity: 30, now: () => T0 });
  for (let i = 0; i < 30; i++) failureMemory.record(`k${i}`, `v${i}`, 'no change', undefined, i % 2 === 0 ? 'stall' : undefined);
  await journal.append({ ts: T0, tool: 'click_mouse', args: { x: 0.5 }, status: 'SUCCESS' });

  // (a) 新档（24bit 桶键 + 30 条失败记忆）⇒ save → 清零 → load ⇒ 逐字段复活
  const file = join(dir, 'cp.json');
  assert.equal(saveCheckpoint(file).ok, true);
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(onDisk.selfModel.cells.some((c: { key: string }) => c.key === 'click_mouse|ffff55'), '落盘键 = 新粒度方言');
  resetSelfModel();
  failureMemory.reset();
  const loaded = loadCheckpoint(file);
  assert.equal(loaded.restored, true, loaded.report.join('; '));
  assert.ok(loaded.report.includes('selfModel: OK'), loaded.report.join('; '));
  assert.equal(failureMemory.size, 30, '失败记忆 30 条照常复活');
  assert.ok(Math.abs(selfModel.competence({ actionKind: 'click_mouse', sceneBucket: 'ffff55' })!.n - 6) < 1e-9, 'selfModel 新粒度格复活');

  // (b) 铸旧档：手改 selfModel 段为 16bit 旧桶键（v4 原地扩展、版本不动 ⇒ 真旧档同形）
  //     ⇒ load 触发细→粗聚合；failureMemory 段 30 条不连坐
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.selfModel = {
    version: 1, settledAt: T0,
    cells: [
      { key: 'legacy_tool', s: 2, f: 2, lastTs: T0 },
      { key: 'legacy_tool|abcd', s: 4, f: 0, lastTs: T0 }, // 旧 16bit 粗桶键
      { key: 'keep|f3a0c9', s: 1, f: 1, lastTs: T0 },      // 新粒度键（未来档混合形态）
    ],
  };
  const legacyFile = join(dir, 'cp-legacy.json');
  writeFileSync(legacyFile, JSON.stringify(raw));
  resetSelfModel();
  failureMemory.reset();
  const legacy = loadCheckpoint(legacyFile);
  assert.equal(legacy.restored, true, legacy.report.join('; '));
  assert.ok(legacy.report.includes('selfModel: OK'), '段结构合法 ⇒ 迁移水合不是 SKIPPED');
  const cells = selfModel.dump().cells;
  assert.deepEqual(
    cells.find((c) => c.key === 'legacy_tool'),
    { key: 'legacy_tool', s: 6, f: 2, lastTs: T0 },
    '旧桶键聚合进单轴（2/2 + 4/0 = 6/2）；新粒度键 keep|f3a0c9 原样保留',
  );
  assert.ok(cells.some((c) => c.key === 'keep|f3a0c9'));
  assert.equal(cells.length, 2, '三行旧档收成两行（聚合一行 + 原样一行）');
  assert.equal(failureMemory.size, 30, '迁移不连坐：失败记忆段照常水合');
});

// 清理全部临时目录（测试自洁 —— 世界级标准：测试不留垃圾）
process.on('exit', () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });
