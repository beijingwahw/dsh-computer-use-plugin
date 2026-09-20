// test/epochI.test.ts
// I 纪元（第八维·判决与隐态）回归测试 —— 六个引擎各一节：
//   I-1 LTLf 时序逻辑：ReAct 教义的可机检判决（有限迹形式语义）
//   I-2 Anderson-Darling GPD 拟合优度：对估计器自身的法医鉴定
//   I-3 Baum-Welch HMM 相态透视：隐态解码 + EM 收敛性证据
//   I-4 OT 迁徙式持久性：超半格漂移的传输链接（闭合 G-1/H-6 债务链）
//   I-5 精确置换检验：两模态显著差的证书（全枚举精确 p 值）
//   I-6 一阶随机占优：延迟的全序裁决（交叉分布不裁）
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ltlG, ltlF, ltlX, ltlU, boundedResponse, violationsOf, reactTraceProperties } from '../src/ltlf.ts';
import { fitReactPhases } from '../src/phaseHmm.ts';
import { Telemetry, telemetry } from '../src/telemetry.ts';
import {
  classifyPersistence, noteDiffObserved, resetDiffPersistence, type DiffRegion,
} from '../src/visualDiff.ts';

// ─── I-1：LTLf 时序逻辑 ───

test('I-1 算子语义：G/F/X/U 在有限迹上的精确语义（含末位与空迹的诚实处理）', () => {
  const p = (i: number) => i % 2 === 0; // 位 0,2,4... 为真
  assert.equal(ltlG(p, 4), false); // 位 1 假
  assert.equal(ltlG(() => true, 4), true);
  assert.equal(ltlG(() => true, 0), true, '空迹空真');
  assert.equal(ltlF(p, 4), true);
  assert.equal(ltlF(() => false, 4), false);
  assert.equal(ltlF(() => false, 0), false, '空迹无见证');
  // X：末位无下一（强 next 诚实为假）
  assert.equal(ltlX(() => true, 3, 2), false);
  assert.equal(ltlX(() => true, 3, 1), true);
  // U：q 终现且前段全 p；q 不现 ⇒ 假
  const q = (i: number) => i === 3;
  assert.equal(ltlU(() => true, q, 4), true);
  assert.equal(ltlU((i: number) => i < 2, q, 4), false, 'p 在位 2 断裂 ⇒ until 失败');
  assert.equal(ltlU(() => true, () => false, 4), false);
  // 有界响应：每个 q 位后 k 步内必有 p
  const rp = (i: number) => i === 2 || i === 7;
  const rq = (i: number) => i === 0 || i === 5;
  assert.equal(boundedResponse(rp, rq, 8, 3), true);
  assert.equal(boundedResponse((i: number) => i === 7, rq, 8, 3), false, '位 0 的响应超窗');
  assert.deepEqual(violationsOf((i: number) => i !== 1 && i !== 3, 5), [1, 3]);
});

test('I-1 ReAct 性质库：盲启动/观察饥饿/无效连击的逐位违例与全绿判定', () => {
  // 健康迹：首动作有观察、每 ≤3 动作有一次观察、无 4 连无效
  const healthy = [
    { tool: 'click_mouse', observed: true, effect: true },
    { tool: 'type_text', observed: true, effect: true },
    { tool: 'scroll_page', observed: true, effect: false },
    { tool: 'click_mouse', observed: true, effect: true },
  ];
  for (const p of reactTraceProperties(healthy)) {
    assert.equal(p.violations.length, 0, `健康迹 ${p.id} 应无违例`);
  }
  // 病迹：首动作盲发 + 4 连无观察 + 4 连无效
  const sick = [
    { tool: 'click_mouse', effect: false },
    { tool: 'click_mouse', effect: false },
    { tool: 'click_mouse', effect: false },
    { tool: 'click_mouse', effect: false },
  ];
  const props = reactTraceProperties(sick);
  assert.equal(props.find(p => p.id === 'blind-start')!.violations.length, 1);
  assert.equal(props.find(p => p.id === 'observe-starvation')!.violations.length, 1);
  assert.equal(props.find(p => p.id === 'unverified-streak')!.violations.length, 1);
});

// ─── I-2：Anderson-Darling GPD 拟合优度 ───

/** 确定性 GPD 超额样本（逆 CDF 网格） */
function gpdExcess(xi: number, sigma: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => {
    const u = (i + 0.5) / n;
    return xi === 0 ? -sigma * Math.log(u) : (sigma / xi) * (Math.pow(1 - u, -xi) - 1);
  }).sort((a, b) => a - b);
}

test('I-2 AD：真 GPD 样本 A² 低；污染样本 A² 高；小样本诚实拒绝', () => {
  // 真 GPD(0.3, 10)：z≈均匀网格 ⇒ A² 小
  const good = Telemetry.andersonDarlingGpd(gpdExcess(0.3, 10, 40), 0.3, 10);
  // 污染：双峰混合（一半近零超额 + 一半巨大超额 —— 非 GPD 形状）
  const contaminated = [
    ...Array.from({ length: 20 }, (_, i) => 0.5 + i * 0.1),
    ...Array.from({ length: 20 }, (_, i) => 100 + i * 50),
  ].sort((a, b) => a - b);
  const bad = Telemetry.andersonDarlingGpd(contaminated, 0.3, 10);
  assert.ok(good < 3, `真样本 A²=${good} 应 <3（拟合可信）`);
  assert.ok(bad > good, `污染样本 A²=${bad} 应高于真样本 ${good}`);
  // 小样本/病态 ⇒ Infinity（拒绝鉴定而非谎言鉴定）
  assert.equal(Telemetry.andersonDarlingGpd([1, 2], 0.3, 10), Infinity);
  assert.equal(Telemetry.andersonDarlingGpd(gpdExcess(0.3, 10, 40), 0.3, 0), Infinity);
});

test('I-2 tailReport 携带法医字段：GPD 形状池 fit:ok；adStat 在场', () => {
  telemetry.reset();
  telemetry.configure(true);
  const spikes = gpdExcess(0.4, 200, 36);
  for (let i = 0; i < 360; i++) {
    telemetry.observe('take_screenshot', 'SUCCESS',
      i % 10 === 0 ? 460 + spikes[i / 10] : 40 + (i % 7) * 10);
  }
  const tail = telemetry.tailReport();
  assert.ok(tail, 'GPD 形状池应可拟合');
  assert.equal(typeof tail!.adStat, 'number');
  assert.equal(tail!.fit, 'ok', `真 GPD 池应判 ok（A²=${tail!.adStat}）`);
});

// ─── I-3：Baum-Welch HMM 相态透视 ───

test('I-3 EM 收敛性：对数似然单调不减（Baum-Welch 定理的运行时证据）', () => {
  const tools = ['click_mouse', 'click_mouse', 'type_text', 'click_mouse',
    'press_hotkey', 'click_mouse', 'scroll_page', 'type_text',
    'click_mouse', 'scroll_page', 'press_hotkey', 'type_text'];
  const r = fitReactPhases(tools);
  assert.ok(r, '12 步迹应可拟合');
  const lls = r!.logLikelihoods;
  for (let i = 1; i < lls.length; i++) {
    assert.ok(lls[i] >= lls[i - 1] - 1e-6, `LL 第 ${i} 轮 ${lls[i]} < 前轮 ${lls[i - 1]} —— EM 单调性被破`);
  }
});

test('I-3 相态解码：卡死迹（同工具连环失败模式）与多样成功迹的占位分明', () => {
  // 卡死迹：同一工具 30 连击（重试 grinding 的经典签名）
  const stuckTools = new Array(30).fill('click_mouse');
  const stuck = fitReactPhases(stuckTools);
  // 多样迹：工具轮换
  const varied = ['click_mouse', 'type_text', 'scroll_page', 'press_hotkey'].flatMap(t => [t, t, t]);
  const healthy = fitReactPhases(varied);
  assert.ok(stuck && healthy);
  // 卡死迹的自转移极强态（stuck 标签）占位应显著高于多样迹的同标签
  assert.ok(stuck!.occupancy.stuck > healthy!.occupancy.stuck,
    `卡死迹 stuck=${stuck!.occupancy.stuck} 应 > 多样迹 ${healthy!.occupancy.stuck}`);
  assert.ok(stuck!.longestStuckRun >= 10, `同工具 30 连击的最长卡死段 ${stuck!.longestStuckRun} 应 ≥10`);
  // 短迹诚实缺席
  assert.equal(fitReactPhases(['click_mouse']), null);
});

// ─── I-4：OT 迁徙式持久性 ───

function mkRegion(index: number, x: number, y: number, mass = 10): DiffRegion {
  return {
    index,
    bbox_normalized: { x0: x - 0.05, y0: y - 0.05, x1: x + 0.05, y1: y + 0.05 },
    center: { x, y },
    tiles_changed: mass,
  };
}

test('I-4 迁徙链接：超半格大滑（双键全断）由传输匹配兜底；质量突变不算迁徙', () => {
  resetDiffPersistence();
  // 第一幕：0.50 特征出现 4 次 ⇒ persistent（键判据：第 2 次起键命 ≥2），快照入环
  for (let i = 0; i < 4; i++) {
    const settled = classifyPersistence([mkRegion(1, 0.50, 0.50)]);
    if (i >= 2) assert.equal(settled.get(1), 'persistent', `原位第 ${i + 1} 次重现 ⇒ persistent（键命 ≥2）`);
    noteDiffObserved([mkRegion(1, 0.50, 0.50)], settled);
  }
  // 第二幕：x 轴滑 0.09（> 半格 0.083 —— 主副双键全断，G-1/H-6 时代必断链）
  // 与环内 persistent 快照 (0.50,0.50) 的距离 = 0.09 ≤ MIGRATE_RADIUS 0.10 ⇒ 迁徙存活
  const slid = classifyPersistence([mkRegion(1, 0.59, 0.50)]);
  const keysBefore = ['6', 's6']; // 0.50 的双键 —— 0.59 的键为 '7'/'s6.58→7' 全异
  void keysBefore;
  assert.equal(slid.get(1), 'persistent', '双键全断的 0.09 滑移由传输匹配兜底（I-4 债务闭合）');
  noteDiffObserved([mkRegion(1, 0.59, 0.50)], slid);
  // 反例 1：同距离处质量突变（10 → 100，比值 10 > 2）不算同一特征（爆发不是移动）
  // 位置取 0.59/0.50（与正例同距 —— 键域与迁移域全同，唯一差是质量比）
  const burst = classifyPersistence([mkRegion(2, 0.59, 0.50, 100)]);
  assert.equal(burst.get(2), 'transient', '质量比 10 越界 ⇒ 爆发不是迁徙（同距同键位只有质量不同）');
  // 反例 2：远处全新特征（无键命、无迁移锚）
  const fresh = classifyPersistence([mkRegion(3, 0.80, 0.80)]);
  assert.equal(fresh.get(3), 'transient', '远处新特征既无键命也无传输匹配 ⇒ 瞬态');
  resetDiffPersistence();
});

// ─── I-5：精确置换检验 ───

test('I-5 置换检验：显著差（9/9 vs 0/6）⇒ 精确 p ≤ 0.01；无差 ⇒ p 大', () => {
  const sig = Telemetry.permutationTest2Prop(9, 9, 0, 6)!;
  assert.equal(sig.mode, 'exact', 'C(15,9)=5005 ≤ 枚举上限');
  assert.ok(sig.pValue <= 0.01, `9/9 vs 0/6 的精确 p=${sig.pValue} 应 ≤0.01`);
  const nullCase = Telemetry.permutationTest2Prop(5, 10, 5, 10)!;
  assert.ok(nullCase.pValue >= 0.9, `5/10 vs 5/10 的 p=${nullCase.pValue} 应 ≥0.9`);
  // 对称性守恒：交换 A/B ⇒ 同 p（可交换性的自检）
  const flipped = Telemetry.permutationTest2Prop(0, 6, 9, 9)!;
  assert.equal(flipped.pValue, sig.pValue, '置换检验对组序不变（可交换性）');
  // 小样本诚实缺席
  assert.equal(Telemetry.permutationTest2Prop(1, 1, 0, 1), null);
});

// ─── I-6：一阶随机占优 ───

test('I-6 FSD：全分位不晚 ⇒ 占优；交叉分布 ⇒ none（不许谎言聚合）', () => {
  // A 每个值都不晚于 B
  assert.equal(Telemetry.firstOrderStochasticDominance([10, 20, 30], [20, 30, 40]), 'A');
  assert.equal(Telemetry.firstOrderStochasticDominance([20, 30, 40], [10, 20, 30]), 'B');
  // 交叉：A 最低值更小但最高值更大 ⇒ 任何「更快」断言都是谎言
  assert.equal(Telemetry.firstOrderStochasticDominance([10, 50], [20, 30]), 'none');
  // 完全相同 ⇒ 平局不裁
  assert.equal(Telemetry.firstOrderStochasticDominance([10, 20], [10, 20]), 'none');
  assert.equal(Telemetry.firstOrderStochasticDominance([], [1, 2]), 'none');
});

test('I-6 消费面：延迟占优对扫描（≥8 样本参战）', () => {
  telemetry.reset();
  telemetry.configure(true);
  for (let i = 0; i < 12; i++) {
    telemetry.observe('find_text', 'SUCCESS', 30 + i);
    telemetry.observe('drag_mouse', 'SUCCESS', 200 + i * 10);
  }
  const pairs = telemetry.latencyDominancePairs();
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].faster, 'find_text');
  assert.equal(pairs[0].slower, 'drag_mouse');
});
