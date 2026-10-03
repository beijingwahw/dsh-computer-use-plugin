// test/autonomy.uncertainty.test.ts
// 纪元 Φ（Φ-7 认识论中枢）：uncertainty 全离线验证 —— 纯函数零 IO 零网络，所有期望值硬编码。
// 覆盖：香农熵数值与边界（0 / 0.5 / 1 / 夹取 / NaN）；加权几何平均（等权＝AM-GM 对照、
// 加权偏移方向、空列表、全零权重、(0.001,1] 夹取、权重缺位补零）；Beta 校准数值、
// 非法 αβ 直通与 raw 夹取；adviseAction 决策表全格（3 代价档 × 高/中/低置信 × 云脑
// 在/缺席共 18 格，纪元 Δ 按 α=4/β=1 重算——eff 值域 [0.2,0.8]，逐格手算注释）；
// 旧 α=1.3 下数学不可达阈值支的复活对照；eff 恰达 0.5 的 proceed 阈包含边界；
// 预算 <10 的 abort 降级、恰 10 不降级、proceed 豁免、ask_human 不受影响、缺省 100；
// reasons 非空且每条含中文；entropy/confidence 与纯函数复算严格一致；非法输入永不抛异常。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { adviseAction, calibratedProbability, combineConfidences, shannonEntropy } from '../src/autonomy/uncertainty.ts';

/** 近似相等断言（默认容差 1e-12 —— 浮点期望值统一走这里） */
function approx(actual: number, expected: number, eps = 1e-12, msg = ''): void {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${msg} 期望 ≈${expected}（±${eps}），实际 ${actual}`,
  );
}

// ─── shannonEntropy：二元香农熵 ───

test('shannonEntropy：端点全知为 0，正中半信为 1 比特', () => {
  assert.equal(shannonEntropy(0), 0);
  assert.equal(shannonEntropy(1), 0);
  assert.equal(shannonEntropy(0.5), 1);
});

test('shannonEntropy：中段数值精确（p=0.25 ⇒ 0.811278…）且对称 H(p)=H(1-p)', () => {
  approx(shannonEntropy(0.25), 0.8112781244591328);
  approx(shannonEntropy(0.1), 0.4689955935892812);
  approx(shannonEntropy(0.2), shannonEntropy(0.8), 1e-12, 'H(p)=H(1-p)');
  approx(shannonEntropy(0.01), shannonEntropy(0.99), 1e-12, 'H(p)=H(1-p)');
  assert.ok(shannonEntropy(0.999) > 0 && shannonEntropy(0.999) < 0.02);
});

test('shannonEntropy：非法输入夹取后再算（出界归 0，NaN 视作无信息）', () => {
  assert.equal(shannonEntropy(-3), 0);
  assert.equal(shannonEntropy(1.5), 0);
  assert.equal(shannonEntropy(Number.NaN), 0);
  assert.equal(shannonEntropy(Number.POSITIVE_INFINITY), 0);
  // 夹取等价：-0.2 按 0 算、1.2 按 1 算
  assert.equal(shannonEntropy(-0.2), shannonEntropy(0));
  assert.equal(shannonEntropy(1.2), shannonEntropy(1));
});

// ─── combineConfidences：加权几何平均 ───

test('combineConfidences：等权几何平均，全等列表与算术平均重合（AM-GM 取等）', () => {
  approx(combineConfidences([0.8, 0.8, 0.8, 0.8]), 0.8);
  // 各项不等时 GM < AM（连乘惩罚低置信项）
  approx(combineConfidences([0.5, 0.9]), Math.sqrt(0.45));
  assert.ok(combineConfidences([0.5, 0.9]) < 0.7, '几何平均必须严格小于算术平均 0.7');
});

test('combineConfidences：省略权重 = 等权 [1,1,…]', () => {
  assert.equal(combineConfidences([0.5, 0.9]), combineConfidences([0.5, 0.9], [1, 1]));
  assert.equal(combineConfidences([0.3, 0.7, 0.9]), combineConfidences([0.3, 0.7, 0.9], [1, 1, 1]));
});

test('combineConfidences：加权偏移方向——权重压向低置信则结果下沉，压向高置信则上浮', () => {
  const eq = combineConfidences([0.9, 0.5], [1, 1]); // ≈ 0.6708
  const heavyLow = combineConfidences([0.9, 0.5], [1, 3]); // ≈ 0.5791
  const heavyHigh = combineConfidences([0.9, 0.5], [3, 1]); // ≈ 0.7753
  approx(eq, Math.sqrt(0.45));
  approx(heavyLow, 0.1125 ** 0.25);
  assert.ok(heavyLow < eq, '权重压向 0.5 应拉低整体');
  assert.ok(heavyHigh > eq, '权重压向 0.9 应抬高整体');
});

test('combineConfidences：零权重项剔除——缺位权重与负权重都按 0 计', () => {
  approx(combineConfidences([0.9, 0.5], [0, 1]), 0.5);
  approx(combineConfidences([0.9, 0.5], [1]), 0.9, 1e-12, 'weights 比 list 短：缺位项权重 0');
  approx(combineConfidences([0.9, 0.5], [-5, 1]), 0.5, 1e-12, '负权重按 0 计');
});

test('combineConfidences：空列表 / 全零权重 ⇒ 0（无证据即无置信）', () => {
  assert.equal(combineConfidences([]), 0);
  assert.equal(combineConfidences([], [1, 2]), 0);
  assert.equal(combineConfidences([0.9, 0.5, 0.7], [0, 0, 0]), 0);
  assert.equal(combineConfidences([0.9], [0]), 0);
});

test('combineConfidences：置信夹取到 (0.001,1]——0 与 NaN 抬到 0.001，超界压到 1', () => {
  approx(combineConfidences([0, 1]), Math.sqrt(0.001)); // 0.0316…：不因 log(0) 塌成 0
  assert.ok(combineConfidences([0, 1]) > 0);
  approx(combineConfidences([0.0001]), 0.001);
  approx(combineConfidences([Number.NaN, 1]), Math.sqrt(0.001), 1e-12, 'NaN 抬到下限 0.001');
  approx(combineConfidences([2, 2]), 1);
  approx(combineConfidences([5, 0.5]), Math.sqrt(0.5), 1e-12, '5 压到 1 后与 0.5 几何平均');
});

// ─── calibratedProbability：Beta 式校准 ───

test('calibratedProbability：核心数值 (raw·α+(1-raw)·β)/(α+β)', () => {
  approx(calibratedProbability(0.8, { alpha: 1.3, beta: 1 }), 1.24 / 2.3);
  approx(calibratedProbability(1, { alpha: 1.3, beta: 1 }), 1.3 / 2.3);
  approx(calibratedProbability(0, { alpha: 1.3, beta: 1 }), 1 / 2.3);
  approx(calibratedProbability(0.5, { alpha: 1.3, beta: 1 }), 0.5);
  approx(calibratedProbability(0.7, { alpha: 1, beta: 1 }), 0.5, 1e-12, 'α=β 对称先验抹平自报');
  approx(calibratedProbability(1, { alpha: 2, beta: 1 }), 2 / 3);
  approx(calibratedProbability(0, { alpha: 2, beta: 1 }), 1 / 3);
});

test('calibratedProbability：α>β 时随 raw 单调升，值域夹在 (β/(α+β), α/(α+β)) 内', () => {
  const cal1 = calibratedProbability(1, { alpha: 1.3, beta: 1 });
  const calMid = calibratedProbability(0.8, { alpha: 1.3, beta: 1 });
  const calHalf = calibratedProbability(0.5, { alpha: 1.3, beta: 1 });
  const cal0 = calibratedProbability(0, { alpha: 1.3, beta: 1 });
  assert.ok(cal1 > calMid && calMid > calHalf && calHalf > cal0, '随 raw 严格单调升');
  assert.ok(cal0 > 1 / 2.3 - 1e-12 && cal1 < 1.3 / 2.3 + 1e-12);
});

test('calibratedProbability：α 或 β 任一 ≤0（含非数）⇒ raw 原样直通', () => {
  assert.equal(calibratedProbability(0.8, { alpha: 0, beta: 5 }), 0.8);
  assert.equal(calibratedProbability(0.42, { alpha: -1, beta: 2 }), 0.42);
  assert.equal(calibratedProbability(0.9, { alpha: 1, beta: 0 }), 0.9);
  assert.equal(calibratedProbability(0.3, { alpha: 2, beta: -2 }), 0.3);
  assert.equal(calibratedProbability(0.77, { alpha: Number.NaN, beta: 1 }), 0.77);
  assert.ok(Number.isNaN(calibratedProbability(Number.NaN, { alpha: 0, beta: 1 })), '直通连 NaN 也原样');
});

test('calibratedProbability：校准有效时 raw 先夹取 [0,1]（NaN 按 0）', () => {
  approx(calibratedProbability(1.5, { alpha: 1, beta: 1 }), 0.5);
  approx(calibratedProbability(-2, { alpha: 1.3, beta: 1 }), 1 / 2.3);
  approx(calibratedProbability(Number.NaN, { alpha: 1.3, beta: 1 }), 1 / 2.3);
});

// ─── adviseAction：决策表全格（3 代价档 × 高/中/低置信 × 云脑在/缺席） ───
// 纪元 Δ 校准律修正：α=4/β=1 ⇒ eff = (3·raw+1)/5 = 0.5+0.6×(raw−0.5)，值域 [0.2,0.8]。
// 取样 raw：0.99 ⇒ eff 3.97/5 = 0.794（高），0.45 ⇒ eff 2.35/5 = 0.470（中），
// 0.05 ⇒ eff 1.15/5 = 0.230（低）。阈值：high{0.85,0.6} medium{0.7,0.45} low{0.5,0.3}。

interface GridRow {
  cost: 'low' | 'medium' | 'high';
  raw: number;
  withVlm: 'proceed' | 'ask_vlm' | 'ask_human' | 'abort';
  withoutVlm: 'proceed' | 'ask_vlm' | 'ask_human' | 'abort';
  /** 云脑缺席时是否走"冒险放行"分支（eff 达云脑阈但缺席且代价可控） */
  riskyWithoutVlm: boolean;
}

const GRID: GridRow[] = [
  // low 档 {proceed≥0.5, vlm≥0.3}
  { cost: 'low', raw: 0.99, withVlm: 'proceed', withoutVlm: 'proceed', riskyWithoutVlm: false }, // eff 0.794 ≥ 0.5 ⇒ 直放
  { cost: 'low', raw: 0.45, withVlm: 'ask_vlm', withoutVlm: 'proceed', riskyWithoutVlm: true },  // eff 0.470 ∈ [0.3,0.5) ⇒ 云脑带/冒险放行
  { cost: 'low', raw: 0.05, withVlm: 'ask_vlm', withoutVlm: 'ask_human', riskyWithoutVlm: false }, // eff 0.230 < 0.3 ⇒ 低置信支：有云脑兜底，无云脑问人（旧 α=1.3 下 eff 下限 0.4348 恒 > 0.3，此支不可达）
  // medium 档 {proceed≥0.7, vlm≥0.45}
  { cost: 'medium', raw: 0.99, withVlm: 'proceed', withoutVlm: 'proceed', riskyWithoutVlm: false }, // eff 0.794 ≥ 0.7 ⇒ 直放（proceed 阈需 raw ≥ 5/6 ≈ 0.833，旧 α=1.3 下 eff 上限 0.5652 此支不可达）
  { cost: 'medium', raw: 0.45, withVlm: 'ask_vlm', withoutVlm: 'proceed', riskyWithoutVlm: true }, // eff 0.470 ∈ [0.45,0.7) 恰过云脑阈
  { cost: 'medium', raw: 0.05, withVlm: 'ask_vlm', withoutVlm: 'ask_human', riskyWithoutVlm: false }, // eff 0.230 < 0.45 ⇒ 低置信支
  // high 档 {proceed≥0.85, vlm≥0.6}：proceed 阈 0.85 > eff 上限 0.8 ⇒ 刻意不可达（高危无免检直通道）
  { cost: 'high', raw: 0.99, withVlm: 'ask_vlm', withoutVlm: 'ask_human', riskyWithoutVlm: false }, // eff 0.794 ∈ [0.6,0.85) ⇒ 云脑复核带；缺席则高危问人（旧 α=1.3 下 eff 上限 0.5652 < 0.6，恒落低置信支恒问人）
  { cost: 'high', raw: 0.45, withVlm: 'ask_human', withoutVlm: 'ask_human', riskyWithoutVlm: false }, // eff 0.470 < 0.6 ⇒ 低置信支高危问人
  { cost: 'high', raw: 0.05, withVlm: 'ask_human', withoutVlm: 'ask_human', riskyWithoutVlm: false }, // eff 0.230 < 0.6 ⇒ 同上
];

test('adviseAction：决策表 18 格全枚举（预算充足缺省 100）', () => {
  for (const row of GRID) {
    const inVlm = adviseAction({ confidence: row.raw, costOfError: row.cost, vlmAvailable: true });
    const outVlm = adviseAction({ confidence: row.raw, costOfError: row.cost, vlmAvailable: false });
    assert.equal(inVlm.advise, row.withVlm, `cost=${row.cost} raw=${row.raw} 云脑在场`);
    assert.equal(outVlm.advise, row.withoutVlm, `cost=${row.cost} raw=${row.raw} 云脑缺席`);
  }
});

test('adviseAction：冒险放行格 reasons 必含指定句，真 proceed 格必不含', () => {
  for (const row of GRID) {
    const r = adviseAction({ confidence: row.raw, costOfError: row.cost, vlmAvailable: false });
    const hasRisky = r.reasons.includes('云脑缺席且代价可控，冒险放行');
    assert.equal(hasRisky, row.riskyWithoutVlm, `cost=${row.cost} raw=${row.raw}`);
  }
  // 云脑在场时永远不会出现"冒险放行"句
  for (const row of GRID) {
    const r = adviseAction({ confidence: row.raw, costOfError: row.cost, vlmAvailable: true });
    assert.ok(!r.reasons.includes('云脑缺席且代价可控，冒险放行'));
  }
});

test('adviseAction：proceed 阈为包含边界——eff 恰 0.5（raw=0.5, low 档）⇒ proceed', () => {
  approx(calibratedProbability(0.5, { alpha: 4, beta: 1 }), 0.5, 0, '前置：raw=0.5 是校准不动点，eff 恰为 0.5');
  for (const vlmAvailable of [true, false]) {
    const r = adviseAction({ confidence: 0.5, costOfError: 'low', vlmAvailable });
    assert.equal(r.advise, 'proceed', `vlmAvailable=${vlmAvailable}：eff=0.5 ≥ proceed 阈 0.5`);
    assert.ok(r.reasons.some((s) => s.includes('直接放行')));
  }
  // 同一 eff 在 medium 档（proceed 阈 0.7）不够放行但达云脑阈 0.45
  const m = adviseAction({ confidence: 0.5, costOfError: 'medium', vlmAvailable: true });
  assert.equal(m.advise, 'ask_vlm');
});

test('adviseAction：纪元 Δ 校准修律——旧 α=1.3 下数学不可达的阈值支全部复活', () => {
  // high 档云脑阈 0.6（需 raw ≥ 2/3，取样 0.7 ⇒ eff 0.62）：有云脑 ⇒ 复核而非问人
  //（旧 α=1.3 下 eff 上限 0.5652 < 0.6，high 档恒落低置信支恒问人）
  assert.equal(adviseAction({ confidence: 0.7, costOfError: 'high', vlmAvailable: true }).advise, 'ask_vlm');
  assert.equal(adviseAction({ confidence: 0.7, costOfError: 'high', vlmAvailable: false }).advise, 'ask_human');
  // medium 档 proceed 阈 0.7（需 raw ≥ 5/6，取样 0.9 ⇒ eff 0.74）⇒ 直放（旧不可达）
  assert.equal(adviseAction({ confidence: 0.9, costOfError: 'medium', vlmAvailable: false }).advise, 'proceed');
  // low 档低置信支 eff < 0.3（需 raw < 1/6，取样 0.16 ⇒ eff 0.296）：无云脑 ⇒ 问人
  //（旧 α=1.3 下 eff 下限 0.4348 > 0.3，此支不可达 ⇒ 无云脑时 low/medium 恒冒险放行）
  assert.equal(adviseAction({ confidence: 0.16, costOfError: 'low', vlmAvailable: false }).advise, 'ask_human');
  assert.equal(adviseAction({ confidence: 0.16, costOfError: 'low', vlmAvailable: true }).advise, 'ask_vlm');
  // high.proceed 0.85 > 值域上限 0.8：raw 满格 1.0 ⇒ eff 恰 0.8，仍不免检（云脑阈支接管）
  assert.equal(adviseAction({ confidence: 1, costOfError: 'high', vlmAvailable: true }).advise, 'ask_vlm');
  assert.equal(adviseAction({ confidence: 1, costOfError: 'high', vlmAvailable: false }).advise, 'ask_human');
});

// ─── adviseAction：预算红线 ───

test('adviseAction：原判 ask_vlm 且预算 <10 ⇒ abort，reasons 含"预算不足以承担云脑咨询"', () => {
  for (const budget of [9.999, 9, 5, 0, -5]) {
    // 取样 raw 0.45 ⇒ eff 0.470 ∈ [0.45,0.7)：medium 云脑阈支原判 ask_vlm（预算红线的被测对象）
    const r = adviseAction({ confidence: 0.45, costOfError: 'medium', vlmAvailable: true, budgetRemainingPct: budget });
    assert.equal(r.advise, 'abort', `budget=${budget}`);
    assert.ok(r.reasons.includes('预算不足以承担云脑咨询'), `budget=${budget}`);
  }
});

test('adviseAction：预算恰 10 是红线之下不含——不降级，照旧 ask_vlm', () => {
  const r = adviseAction({ confidence: 0.45, costOfError: 'medium', vlmAvailable: true, budgetRemainingPct: 10 });
  assert.equal(r.advise, 'ask_vlm');
  assert.ok(!r.reasons.includes('预算不足以承担云脑咨询'));
});

test('adviseAction：proceed 豁免——预算 <10 照旧放行（不烧预算的动作）', () => {
  for (const budget of [9, 1, 0]) {
    const r = adviseAction({ confidence: 0.99, costOfError: 'low', vlmAvailable: true, budgetRemainingPct: budget });
    assert.equal(r.advise, 'proceed', `budget=${budget}`);
    assert.ok(r.reasons.some((s) => s.includes('不烧预算')), `budget=${budget}：豁免要留审计句`);
  }
});

test('adviseAction：ask_human 不烧云脑预算——预算 <10 维持问人', () => {
  const r = adviseAction({ confidence: 0.05, costOfError: 'high', vlmAvailable: true, budgetRemainingPct: 0 });
  assert.equal(r.advise, 'ask_human');
  assert.ok(!r.reasons.includes('预算不足以承担云脑咨询'));
});

test('adviseAction：budgetRemainingPct 缺省 100；非数按最坏 0 计（ask_vlm ⇒ abort）', () => {
  const dflt = adviseAction({ confidence: 0.45, costOfError: 'medium', vlmAvailable: true });
  assert.equal(dflt.advise, 'ask_vlm', '缺省预算充足，云脑咨询照常');
  const nan = adviseAction({
    confidence: 0.45,
    costOfError: 'medium',
    vlmAvailable: true,
    budgetRemainingPct: Number.NaN,
  });
  assert.equal(nan.advise, 'abort', 'NaN 预算按 0 计');
});

// ─── adviseAction：报告一致性与 reasons 契约 ───

test('adviseAction：confidence=有效置信、entropy=shannonEntropy(有效置信)——与纯函数复算严格一致', () => {
  const samples: Array<{ raw: number; cost: 'low' | 'medium' | 'high'; vlm: boolean }> = [
    { raw: 0.99, cost: 'low', vlm: true },
    { raw: 0.99, cost: 'low', vlm: false },
    { raw: 0.45, cost: 'medium', vlm: true },
    { raw: 0.45, cost: 'medium', vlm: false },
    { raw: 0.05, cost: 'high', vlm: true },
    { raw: 0.05, cost: 'high', vlm: false },
    { raw: 0.5, cost: 'low', vlm: true },
  ];
  for (const s of samples) {
    const r = adviseAction({ confidence: s.raw, costOfError: s.cost, vlmAvailable: s.vlm });
    const eff = calibratedProbability(s.raw, { alpha: 4, beta: 1 });
    assert.equal(r.confidence, eff, `raw=${s.raw}：报告置信必须是校准后的有效置信`);
    assert.equal(r.entropy, shannonEntropy(eff), `raw=${s.raw}：熵必须由有效置信算出`);
    assert.ok(r.entropy >= 0 && r.entropy <= 1, '熵值域 [0,1] 比特');
    assert.ok(r.confidence > 0 && r.confidence < 1);
  }
  // raw=0.5 ⇒ eff 恰 0.5 ⇒ 熵恰 1 比特（最懵点）
  assert.equal(adviseAction({ confidence: 0.5, costOfError: 'low', vlmAvailable: false }).entropy, 1);
});

test('adviseAction：决策表 18 格 reasons 全部非空且每条为含中文的非空字符串', () => {
  for (const row of GRID) {
    for (const vlmAvailable of [true, false]) {
      const r = adviseAction({ confidence: row.raw, costOfError: row.cost, vlmAvailable });
      assert.ok(Array.isArray(r.reasons) && r.reasons.length >= 1, `cost=${row.cost} raw=${row.raw} vlm=${vlmAvailable}`);
      for (const s of r.reasons) {
        assert.equal(typeof s, 'string');
        assert.ok(s.length > 0);
        assert.ok(/[\u4e00-\u9fff]/.test(s), `理由须为中文：${s}`);
      }
    }
  }
});

// ─── adviseAction：鲁棒性（绝不抛异常） ───

test('adviseAction：非法输入收敛不炸——NaN 置信按 0、非法代价档按 high 保守处理', () => {
  // NaN 置信 ⇒ eff=(3×0+1)/5=0.2；NaN 预算按 0 ⇒ 原判 ask_vlm 降级 abort
  const hostile = adviseAction({
    confidence: Number.NaN,
    costOfError: 'medium',
    vlmAvailable: true,
    budgetRemainingPct: Number.NaN,
  });
  assert.equal(hostile.advise, 'abort');
  assert.ok(hostile.reasons.length >= 1);
  // 非法代价档按 high 处理：eff 0.794 ∈ [0.6,0.85) ⇒ 云脑阈支（有云脑 ⇒ 复核，不问人）
  const junkCost = adviseAction({ confidence: 0.99, costOfError: 'extreme' as never, vlmAvailable: true });
  assert.equal(junkCost.advise, 'ask_vlm');
  assert.ok(junkCost.reasons.some((s) => s.includes('错误代价 high')), '理由须注明按 high 保守处理');
  // vlmAvailable 非 true 一律视作缺席：0.45/medium/缺席 ⇒ 冒险放行
  const junkVlm = adviseAction({
    confidence: 0.45,
    costOfError: 'medium',
    vlmAvailable: 'yes' as unknown as boolean,
  });
  assert.equal(junkVlm.advise, 'proceed');
  assert.ok(junkVlm.reasons.includes('云脑缺席且代价可控，冒险放行'));
});
