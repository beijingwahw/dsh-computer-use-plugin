// test/epochG.test.ts
// G 纪元（第七维·过程感知与收缩估计）回归测试 —— 六个引擎各一节，防其借尸还魂：
//   G-1 差分持续性（0 维持久同调 TDA-lite）：结构变化 vs 瞬态噪声的寿命判据
//   G-2 CUSUM 序贯变点：失败率突变（regime shift）检测
//   G-3 模糊量化文法归纳：坐标抖动容忍的动机挖掘
//   G-4 经验贝叶斯收缩（James-Stein）：稀疏成功率的防过信回撤
//   G-5 Pareto 非支配标注：多目标（相关×可靠×新近）透明
//   G-6 Hurst 指数 R/S：成败聚集性（长程依赖）检测
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPersistence, noteDiffObserved, resetDiffPersistence, regionKey, type DiffRegion,
} from '../src/visualDiff.ts';
import { cusumAlarm, hurstExponent, telemetry } from '../src/telemetry.ts';
import { skillLibrary } from '../src/skillLibrary.ts';
import { journal } from '../src/journal.ts';
import { swarm, shrinkRate } from '../src/swarm.ts';

// ─── G-1：差分持续性（TDA-lite）───

function mkRegion(index: number, x: number, y: number): DiffRegion {
  return {
    index,
    bbox_normalized: { x0: x - 0.05, y0: y - 0.05, x1: x + 0.05, y1: y + 0.05 },
    center: { x, y },
    tiles_changed: 10,
  };
}

test('G-1 量化键：±1/24 抖动同键（漂移容忍），跨网格异键（定位保留）', () => {
  assert.equal(regionKey(mkRegion(1, 0.500, 0.500)), regionKey(mkRegion(2, 0.515, 0.492)));
  assert.notEqual(regionKey(mkRegion(1, 0.500, 0.500)), regionKey(mkRegion(2, 0.700, 0.500)));
});

test('G-1 寿命判据：最近 3 次观测重现 ≥2 次 ⇒ persistent；一次闪现 ⇒ transient', () => {
  // 观测史：位置 A 出现过两次，位置 B 只出现过一次
  const history = [
    new Set(['6,6']),        // t-3: A
    new Set(['6,6', '10,2']), // t-2: A + B
    new Set([]),              // t-1: 无变化 diff
  ];
  const verdict = classifyPersistence([mkRegion(1, 0.5, 0.5), mkRegion(2, 0.85, 0.15)], history);
  assert.equal(verdict.get(1), 'persistent', 'A（6,6）窗口内 2 次 ⇒ 结构变化');
  assert.equal(verdict.get(2), 'transient', 'B（10,2）窗口内 1 次 ⇒ 瞬态噪声');
});

test('G-1 先判后记：noteDiffObserved 之后本次键入史（下一次才参与寿命）', () => {
  resetDiffPersistence();
  const regions = [mkRegion(1, 0.3, 0.3)];
  // 首次：空史 ⇒ transient
  assert.equal(classifyPersistence(regions).get(1), 'transient');
  noteDiffObserved(regions);
  // 第二次：史中 1 次（上次）+ 本次不计 ⇒ 仍 1 次 ⇒ transient（不自证持续）
  assert.equal(classifyPersistence(regions).get(1), 'transient');
  noteDiffObserved(regions);
  // 第三次：最近 3 次观测史含 2 次 ⇒ persistent
  assert.equal(classifyPersistence(regions).get(1), 'persistent');
  resetDiffPersistence();
});

// ─── G-2：CUSUM 序贯变点 ───

test('G-2 cusumAlarm：稳定流零告警；连续失败 ⇒ 变点告警且位置正确', () => {
  // 稳定流：全成功
  const calm = cusumAlarm(new Array(30).fill(0), 0.1);
  assert.equal(calm.alarmIndex, null);
  // 突变流：20 成功 + 5 连续失败（p0=0.1, k=0.1 ⇒ 每次失败 +0.8）⇒ 第 4 次失败跨 2.5
  const stream = [...new Array(20).fill(0), 1, 1, 1, 1, 1];
  const alarm = cusumAlarm(stream, 0.1);
  assert.ok(alarm.alarmIndex !== null, '连续失败应触发变点');
  assert.ok(alarm.alarmIndex! >= 20 && alarm.alarmIndex! <= 23, `告警应在突变后 3-4 步内，实际 ${alarm.alarmIndex}`);
  // 容忍带：散发的偶发失败（间隔 ≥2 成功）不告警（k=0.1 防噪）
  const noisy = [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0];
  assert.equal(cusumAlarm(noisy, 0.1).alarmIndex, null, '散发失败不越决策阈');
});

test('G-2 telemetry.regimeShifts：失败率突变的工具被点名，健康工具安静', () => {
  telemetry.reset();
  telemetry.configure(true);
  for (let i = 0; i < 30; i++) telemetry.observe('find_text', 'SUCCESS', 50);
  // click_mouse：12 成功（历史半窗基线 0）+ 8 连败 ⇒ 突变告警
  for (let i = 0; i < 12; i++) telemetry.observe('click_mouse', 'SUCCESS', 80);
  for (let i = 0; i < 8; i++) telemetry.observe('click_mouse', 'FAILED', 80);
  const shifts = telemetry.regimeShifts();
  assert.equal(shifts.length, 1, '只有 click_mouse 突变');
  assert.equal(shifts[0].tool, 'click_mouse');
  assert.equal(shifts[0].baselineFailureRate, 0, '历史半窗基线应为 0（突变前全成功）');
  assert.ok(shifts[0].cusum >= 2.5);
});

// ─── G-3：模糊量化文法归纳 ───

test('G-3 坐标抖动容忍：x=0.50 与 x=0.52 的同工作流仍被认出同一动机', async () => {
  journal.reset();
  skillLibrary.reset();
  skillLibrary.configure(true, '', 50);
  // 两轮「同一工作流」：坐标微差 0.02（同一按钮，稍微偏一点）—— 精确签名必漏
  const rounds = [
    [{ tool: 'click_mouse', args: { x: 0.50, y: 0.30 } }, { tool: 'type_text', args: { text: 'hi' } }],
    [{ tool: 'click_mouse', args: { x: 0.52, y: 0.31 } }, { tool: 'type_text', args: { text: 'hi' } }],
  ];
  for (const round of rounds) {
    for (const s of round) await journal.append({ ts: Date.now(), tool: s.tool, args: s.args, status: 'SUCCESS' });
  }
  const motifs = skillLibrary.mineMotifs();
  assert.ok(motifs.length >= 1, '量化等价类应让抖动工作流仍成动机');
  assert.equal(motifs[0].usage, 2);
  assert.deepEqual(motifs[0].steps.map(s => s.tool), ['click_mouse', 'type_text']);
});

// ─── G-4：经验贝叶斯收缩（James-Stein）───

test('G-4 shrinkRate：稀疏证据向基率回撤；充分证据收缩几近无感', () => {
  // 2 次尝试 100% 成功，全局基率 0.5：权重 2/5 ⇒ 0.4×1 + 0.6×0.5 = 0.7（非 1.0 的过信）
  assert.equal(shrinkRate(2, 2, 0.5), 0.7);
  // 20 次尝试 100%：权重 20/23 ≈ 0.87 ⇒ 0.935（证据充分，回撤小）
  assert.ok(Math.abs(shrinkRate(20, 20, 0.5) - 0.935) < 0.001, `实际 ${shrinkRate(20, 20, 0.5)}`);
  // 零尝试 ⇒ 基率直通（诚实缺席）
  assert.equal(shrinkRate(0, 0, 0.42), 0.42);
});

test('G-4 counterfactual 携带 shrunkRate：2/2 晶体的收缩率 < 原始率', async () => {
  swarm.reset();
  swarm.configure('', 300_000, 500);
  journal.reset();
  const scene = '#1 dHash=feedface popup=false';
  journal.noteObservation(scene);
  // 双工具对比：click 2/2（稀疏全胜）+ hotkey 20 次里 10 胜（充分证据）
  for (let i = 0; i < 2; i++) await journal.append({ ts: i, tool: 'click_mouse', args: {}, status: 'SUCCESS', effect_detected: true, observe: scene });
  for (let i = 0; i < 20; i++) {
    await journal.append({
      ts: 10 + i, tool: 'press_hotkey', args: {},
      status: i < 10 ? 'SUCCESS' : 'FAILED',
      effect_detected: i < 10 ? true : undefined, observe: scene,
    });
  }
  const cf = swarm.counterfactual('feedface' + '0'.repeat(56));
  const click = cf.find(e => e.tool === 'click_mouse')!;
  const hotkey = cf.find(e => e.tool === 'press_hotkey')!;
  assert.ok(click.shrunkRate < click.successRate, '稀疏 2/2 必须回撤');
  assert.ok(Math.abs(hotkey.shrunkRate - 0.5) < 0.05, `20 样本收缩应近原始 0.5，实际 ${hotkey.shrunkRate}`);
});

// ─── G-5：Pareto 非支配标注 ───

test('G-5 非支配标注：互补强项的候选都最优；内部轴不外泄', () => {
  skillLibrary.reset();
  skillLibrary.configure(true, '', 50);
  // A：语义相关、经验丰富（9/9）的老技能；B：词面精确、零经验的新技能 ——
  // A 只在可靠轴占优、B 只在文本轴占优 ⇒ 互不支配 ⇒ 双 Pareto
  const a = skillLibrary.induce('打开设置面板 首选项 preferences pane', [
    { tool: 'click_mouse', args: { x: 0.9, y: 0.05 } },
  ])!;
  for (let i = 0; i < 8; i++) skillLibrary.recordOutcome(a.id, true); // 9/9
  const b = skillLibrary.induce('open settings', [
    { tool: 'press_hotkey', args: { keys: ['cmd', ','] } },
  ])!;
  const hits = skillLibrary.match('open settings', undefined, 5);
  assert.ok(hits.length >= 2);
  const hitA = hits.find(h => h.id === a.id)!;
  const hitB = hits.find(h => h.id === b.id)!;
  assert.equal((hitA as any).pareto_optimal, true, 'A（可靠王）应非支配');
  assert.equal((hitB as any).pareto_optimal, true, 'B（文本准且新）应非支配');
  // 内部轴已剥离（_axes 不外泄）
  assert.equal((hits[0] as any)._axes, undefined);
});

// ─── G-6：Hurst 指数 R/S ───

test('G-6 Hurst：regime 聚集流（两段式）⇒ H>0.6；交替流（均值回复）⇒ H<0.5；短流 ⇒ null', () => {
  // 聚集签名：20 连成功 + 20 连失败（regime 一段一段 —— R/S 领地的真信号）
  const clustered = [...new Array(20).fill(0), ...new Array(20).fill(1)];
  const H1 = hurstExponent(clustered);
  assert.ok(H1 !== null && H1 > 0.6, `两段式聚集流 H=${H1} 应 >0.6`);
  // 反持续性：0101 交替（R/S≡1 ⇒ H≈0 —— 周期/交替的经典读数）
  const anti: number[] = [];
  for (let i = 0; i < 64; i++) anti.push(i % 2);
  const H2 = hurstExponent(anti);
  assert.ok(H2 !== null && H2 < 0.5, `交替流 H=${H2} 应 <0.5（均值回复）`);
  // 诚实下限
  assert.equal(hurstExponent([0, 1, 0, 1]), null);
});

test('G-6 telemetry.hurst：结局流可观测（消费通道集成）', () => {
  telemetry.reset();
  telemetry.configure(true);
  // 40 条块状结局（两段式：20 成功 + 20 失败 —— 强聚集）
  for (let i = 0; i < 40; i++) telemetry.observe('type_text', i < 20 ? 'SUCCESS' : 'FAILED', 30);
  const H = telemetry.hurst();
  assert.ok(H !== null, '40 结局应可估 Hurst');
  assert.ok(H! > 0.6, `两段式聚集流 H=${H} 应 >0.6`);
});
