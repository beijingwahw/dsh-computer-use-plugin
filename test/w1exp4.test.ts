// test/w1exp4.test.ts
// W1-5 执法册：EXP4 上下文老虎机进化引擎——采样合法性（分布和为 1）/ 重要性加权
// 数值正确性（手算小例逐项对照）/ 重放确定性（铁律：重放贪心不采样、同 seed 同
// 历史逐字节一致）/ 旧用例兼容（θ=0 退化为旧固定规则行为）/ 权重有界性（θ 范数
// 裁剪与 ε 分母下限）。全离线、全确定性（种子钉死）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EvolutionEngine,
  contextFeatureVector,
  EXP4_HYPERPARAMS,
  FEATURE_LAYOUT,
  type BanditContext,
  type RunRecord,
} from '../src/autonomy/evolutionEngine.ts';

// ── 工具：运行记录工厂（只覆写关心的字段）与近似断言 ──

const R = (o: Partial<RunRecord> = {}): RunRecord => ({
  goal: '演示目标', success: true, steps: 3, durationMs: 1_000, strategies: ['click'], ...o,
});

const ARMS = ['scroll', 'inspect', 'ask_vlm', 'recall_skill', 'click'] as const;

/** 浮点近似相等（手算对照专用——同一算式的求值序差异被 1e-9 吸收） */
const near = (a: number, b: number, eps = 1e-9): void => {
  assert.ok(
    Math.abs(a - b) <= eps,
    `近似相等失败：${a} vs ${b}（容差 ${eps}）`,
  );
};

/** 分布合法性：恰五键、各值 ∈ (0,1]、和为 1（浮点尾差 ≤ 1e-12） */
const assertLegalDist = (p: Record<string, number>): void => {
  assert.deepEqual(Object.keys(p).sort(), [...ARMS].sort(), '键集恒为五内建策略臂');
  for (const v of Object.values(p)) {
    assert.ok(Number.isFinite(v) && v > 0 && v <= 1, `分布项须为有限正数 ≤1（实测 ${v}）`);
  }
  near(Object.values(p).reduce((a, b) => a + b, 0), 1, 1e-12);
};

// ─── 验收一：采样合法性 ───

test('W1-5: 采样合法性——θ=0 退化为旧权重比例分布；和为 1；样本臂合法且概率自洽', () => {
  // 空历史：θ 全零 + 旧权重全 1 ⇒ 严格均匀（softmax(ln 1) 全 0 logit）
  const fresh = new EvolutionEngine({ seed: 101 });
  const p0 = fresh.armProbabilities({ scene: 'login', worldKind: 'web' });
  assertLegalDist(p0);
  for (const k of ARMS) near(p0[k], 0.2, 1e-12);
  // 旧律非均匀权重 ⇒ θ=0 分布 ∝ 旧权重表（向后兼容锚点：softmax over ln w）
  const e = new EvolutionEngine({ seed: 101 });
  e.ingest(R({ strategies: ['inspect', 'click'] }));                                    // inspect +0.1
  e.ingest(R({ success: false, strategies: ['scroll', 'click'], failureRootCause: 'popup' })); // click/scroll −0.15、inspect +0.05
  const w = e.heuristics();
  const p = e.armProbabilities();
  assertLegalDist(p);
  // 逐臂对照 softmax(ln w)：P(a) = w(a) / Σw —— 比例关系逐项验证
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  for (const k of ARMS) near(p[k], w[k] / sum, 1e-12);
  // 采样自洽：样本臂 ∈ 五内建、prob 恰为该臂分布项、annotation 可回灌
  for (let i = 0; i < 50; i++) {
    const s = e.selectAction({ scene: 'mail', budget: 12 });
    assert.ok((ARMS as readonly string[]).includes(s.arm), `采样臂须合法（实测 ${s.arm}）`);
    near(s.prob, p[s.arm], 1e-12);
    assert.deepEqual(Object.keys(s.probabilities).sort(), [...ARMS].sort());
    assert.equal(s.annotation.arm, s.arm);
    assert.equal(s.annotation.prob, s.prob);
  }
  // θ≠0 后分布仍合法（上下文学习移位不破归一）
  e.ingest(R({ steps: 2, strategies: ['scroll'], bandit: { arm: 'scroll', prob: 0.4, context: { scene: 'mail', budget: 12 } } }));
  assertLegalDist(e.armProbabilities({ scene: 'mail', budget: 12 }));
  assertLegalDist(e.armProbabilities()); // 异上下文同律合法
});

// ─── 验收二：重要性加权数值正确性（手算小例） ───

test('W1-5: 手算小例——r = 成功 − λ·steps/budget、G = r/P(a)、θ 位移与更新后分布逐项对照', () => {
  // 场景：空历史，标注 (arm='inspect', P=0.25)，成功 4 步 / 预算 10
  const e = new EvolutionEngine({ seed: 202 });
  e.ingest(R({
    goal: '手算例', success: true, steps: 4, strategies: ['click'],
    bandit: { arm: 'inspect', prob: 0.25, context: { scene: 'login', worldKind: 'web', budget: 10 } },
  }));
  const led = e.exportAuditLedger();
  assert.equal(led.length, 1, '恰一条 bandit 轮进账本');
  const ent = led[0]!;
  assert.equal(ent.arm, 'inspect', '记录臂合法 ⇒ 原样采用');
  assert.equal(ent.prob, 0.25, '记录概率合法 ⇒ 原样采用（在线真值优先）');
  // r = 1 − 0.2×(4/10) = 0.92
  near(ent.reward, 1 - EXP4_HYPERPARAMS.stepCost * (4 / 10));
  // G = r / max(P, ε) = 0.92 / 0.25 = 3.68
  near(ent.importance, ent.reward / 0.25);
  // x：三块 one-hot 各恰一个 1 + 偏置 1 + ratio 0.5（budget 在场但 stepsRemaining 缺省 ⇒ 中性）
  assert.equal(ent.x.length, FEATURE_LAYOUT.dim, '特征维度恒 34');
  assert.equal(ent.x.filter(v => v === 1).length, 4, 'scene/cluster/world/bias 四个 1');
  assert.equal(ent.x[FEATURE_LAYOUT.ratioIndex], 0.5);
  near(ent.x.reduce((a, b) => a + b, 0), 4.5, 1e-12);
  // θ[inspect] = η·(G·x − reg·0) = 0.05×3.68×x ⇒ θᵀx = η·G·‖x‖² = 0.05×3.68×4.25
  const expectedDot = EXP4_HYPERPARAMS.eta * ent.importance * 4.25;
  // 更新后分布（θ=0 ⇒ 其余臂 logit = ln w_rule；本例旧律：click 1.1、其余 1.0）
  const w = e.heuristics();
  const logits: Record<string, number> = {
    scroll: Math.log(w.scroll!),
    inspect: expectedDot + Math.log(w.inspect!),
    ask_vlm: Math.log(w.ask_vlm!),
    recall_skill: Math.log(w.recall_skill!),
    click: Math.log(w.click!),
  };
  const Z = Object.values(logits).reduce((a, l) => a + Math.exp(l), 0);
  const p = e.armProbabilities({ scene: 'login', worldKind: 'web', budget: 10 });
  for (const k of ARMS) near(p[k], Math.exp(logits[k]!) / Z);
  // 学习方向正确：被奖励的 inspect 概率最高 ⇒ 贪心臂翻转
  assert.equal(e.greedyArm({ scene: 'login', worldKind: 'web', budget: 10 }), 'inspect');
  // 失败半例：r = 0 − λ·steps/budget < 0 ⇒ G < 0（负重要性 = 降权证据）
  const f = new EvolutionEngine({ seed: 202 });
  f.ingest(R({ success: false, steps: 2, strategies: ['click'], bandit: { arm: 'click', prob: 0.5, context: { budget: 10 } } }));
  const fe = f.exportAuditLedger()[0]!;
  near(fe.reward, -EXP4_HYPERPARAMS.stepCost * (2 / 10));
  near(fe.importance, fe.reward / 0.5);
  assert.ok(fe.importance < 0, '失败 ⇒ 负重要性权重');
});

test('W1-5: 奖励折价的防御——steps 超预算夹取 1、坏预算回落默认、非有限步按 0 计', () => {
  const mk = (steps: number, budget?: number): number => {
    const e = new EvolutionEngine();
    e.ingest(R({ success: false, steps, strategies: [], bandit: { arm: 'click', prob: 1, context: budget !== undefined ? { budget } : {} } }));
    return e.exportAuditLedger()[0]!.reward;
  };
  // steps=50 > budget=10 ⇒ cost 夹 1 ⇒ r = −λ
  near(mk(50, 10), -EXP4_HYPERPARAMS.stepCost);
  // 预算缺省 ⇒ distillMaxSteps×2 = 24：3 步 ⇒ r = −0.2×0.125
  near(mk(3), -EXP4_HYPERPARAMS.stepCost * (3 / 24));
  // 非有限步（防御访问器按 0 计）⇒ r = 0 − 0
  const bad = new EvolutionEngine();
  bad.ingest(R({ success: false, steps: Number.NaN, strategies: [], bandit: { arm: 'click', prob: 1 } }));
  near(bad.exportAuditLedger()[0]!.reward, 0);
  // 非法预算（0 / 负 / NaN）⇒ 回落默认 24，绝不除零
  near(mk(3, 0), -EXP4_HYPERPARAMS.stepCost * (3 / 24));
  near(mk(3, -5), -EXP4_HYPERPARAMS.stepCost * (3 / 24));
  near(mk(3, Number.NaN), -EXP4_HYPERPARAMS.stepCost * (3 / 24));
});

// ─── 验收三：重放确定性与铁律（重放贪心不采样） ───

test('W1-5: 重放铁律——未记录臂由贪心 argmax 推导、非法 arm/prob 防御回退、ε 分母下限', () => {
  // 未记录臂：θ=0 + 旧权重全 1 ⇒ 平票按固定序 scroll 胜出，P = 0.2
  const g = new EvolutionEngine({ seed: 303 });
  g.ingest(R({ success: true, steps: 2, strategies: [], bandit: { context: { scene: 's' } } }));
  const ent = g.exportAuditLedger()[0]!;
  assert.equal(ent.arm, 'scroll', '缺省臂 = 贪心 argmax（平票固定序第一）');
  near(ent.prob, 0.2, 1e-12);
  near(ent.importance, ent.reward / 0.2);
  // 非法臂名（不在五内建）⇒ 同律贪心回退，绝不抛
  const bad1 = new EvolutionEngine();
  bad1.ingest(R({ strategies: [], bandit: { arm: 'type_text', prob: 0.9 } }));
  assert.equal(bad1.exportAuditLedger()[0]!.arm, 'scroll');
  // 非法概率（0 / 负 / NaN / >1）⇒ 当期分布回填（本例 0.2）
  for (const bad of [0, -0.5, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
    const e = new EvolutionEngine();
    e.ingest(R({ strategies: [], bandit: { arm: 'inspect', prob: bad } }));
    near(e.exportAuditLedger()[0]!.prob, 0.2, 1e-12);
  }
  // ε 分母下限：记录概率 1e-9（合法区间 (0,1]）⇒ G = r/0.01 而非 r/1e-9（防爆炸）
  const tiny = new EvolutionEngine();
  tiny.ingest(R({ success: true, steps: 0, strategies: [], bandit: { arm: 'click', prob: 1e-9 } }));
  const te = tiny.exportAuditLedger()[0]!;
  near(te.reward, 1);
  near(te.importance, 1 / EXP4_HYPERPARAMS.probFloor);
  assert.ok(Math.abs(te.importance) <= 1 / EXP4_HYPERPARAMS.probFloor + 1e-9, '|G| ≤ 1/ε 恒成立');
});

test('W1-5: 重放确定性——同 seed 同历史逐字节一致；采样流不扰重放；异 seed 异流', () => {
  const hist: RunRecord[] = [
    R({ goal: 'a', success: true, steps: 4, strategies: ['click'], bandit: { arm: 'click', prob: 0.3, context: { scene: 'login', budget: 8 } } }),
    R({ goal: 'b', success: false, steps: 6, strategies: ['click', 'scroll'], failureRootCause: 'popup', bandit: { context: { scene: 'login', failureCluster: 'fail|popup|click', budget: 8 } } }),
    R({ goal: 'c', success: true, steps: 2, strategies: ['scroll'], bandit: { arm: 'scroll', prob: 0.44, context: { scene: 'files', worldKind: 'desktop', stepsRemaining: 5, budget: 10 } } }),
    R({ goal: 'd', success: false, steps: 9, strategies: ['ask_vlm'], failureRootCause: 'ocr', bandit: { arm: 'ask_vlm', prob: 0.25, context: { scene: 'files', failureCluster: 'fail|ocr|ask_vlm', stepsRemaining: 1, budget: 10 } } }),
  ];
  const mk = (seed: number): EvolutionEngine => {
    const e = new EvolutionEngine({ seed });
    for (const r of hist) e.ingest(r);
    return e;
  };
  const a = mk(404);
  const b = mk(404);
  // 逐字节一致：JSON 序列化等价（浮点亦逐位相同——同一确定性算术）
  assert.equal(JSON.stringify(a.exportAuditLedger()), JSON.stringify(b.exportAuditLedger()));
  assert.equal(JSON.stringify(a.armProbabilities({ scene: 'login', budget: 8 })), JSON.stringify(b.armProbabilities({ scene: 'login', budget: 8 })));
  assert.deepEqual(a.thetaNorms(), b.thetaNorms());
  assert.deepEqual(a.heuristics(), b.heuristics());
  // 构造播种与逐条 ingest 同律（历史是唯一事实源，入场方式不影响重放）
  const seeded = new EvolutionEngine({ seed: 404, history: hist });
  assert.equal(JSON.stringify(seeded.exportAuditLedger()), JSON.stringify(a.exportAuditLedger()));
  assert.equal(JSON.stringify(seeded.armProbabilities({ scene: 'login', budget: 8 })), JSON.stringify(a.armProbabilities({ scene: 'login', budget: 8 })));
  // 纯读数幂等：反复调用逐字相等（零缓存错位）
  assert.deepEqual(a.exportAuditLedger(), a.exportAuditLedger());
  assert.deepEqual(a.armProbabilities(), a.armProbabilities());
  // 采样流不扰重放：两次读数之间穿插任意次 selectAction，θ 读数不变
  const before = JSON.stringify(a.exportAuditLedger()) + JSON.stringify(a.thetaNorms());
  for (let i = 0; i < 25; i++) a.selectAction({ scene: 'login', budget: 8 });
  assert.equal(JSON.stringify(a.exportAuditLedger()) + JSON.stringify(a.thetaNorms()), before,
    '随机数只在采样流消费——重放读数与调用次数无关（铁律的随机隔离）');
  // 同 seed 同上下文序列 ⇒ 同采样序列（逐字节）
  const drawSeq = (seed: number): string[] => {
    const e = mk(seed);
    const ctxs: Array<BanditContext | undefined> = [
      { scene: 'login', budget: 8 }, { scene: 'files', worldKind: 'desktop' }, undefined,
    ];
    const out: string[] = [];
    for (let i = 0; i < 60; i++) out.push(`${e.selectAction(ctxs[i % 3]!).arm}:${e.selectAction(ctxs[i % 3]!).prob}`);
    return out;
  };
  assert.deepEqual(drawSeq(404), drawSeq(404), '同 seed 同调用序 ⇒ 同采样序列');
  assert.notDeepEqual(drawSeq(404), drawSeq(405), '异 seed ⇒ 异流（均匀 5 臂下 60 连同的概率 ≈ 5^-60）');
});

// ─── 验收四：旧用例兼容（θ=0 ⇒ 旧固定规则行为；双轨互不扰动） ───

test('W1-5: 旧律兼容——θ=0 时 heuristics 逐字节保持旧权重律；bandit 轨不扰动旧表；贪心臂与旧建议同裁', () => {
  // 经典旧律例（与 autonomy.evolutionEngine.test.ts 同构）：成功去重 +0.1 / 末两罚 −0.15 / popup 恢复 +0.05
  const mkRuns = (): RunRecord[] => [
    R({ strategies: ['click', 'scroll', 'click'] }),
    R({ success: false, strategies: ['scroll', 'click', 'click'], failureRootCause: 'popup overlay' }),
  ];
  const plain = new EvolutionEngine();
  for (const r of mkRuns()) plain.ingest(r);
  assert.deepEqual(plain.heuristics(), { scroll: 1.1, inspect: 1.05, ask_vlm: 1, recall_skill: 1, click: 0.8 },
    '旧权重律原样：成功 +0.1、末两 click 各 −0.15、popup ⇒ inspect +0.05');
  // 无 bandit 标注 ⇒ θ 恒零、账本恒空（第一轨道用户零感知）
  assert.deepEqual(plain.thetaNorms(), { scroll: 0, inspect: 0, ask_vlm: 0, recall_skill: 0, click: 0 });
  assert.equal(plain.exportAuditLedger().length, 0);
  // 同一批 run 加上 bandit 标注 ⇒ 旧表逐字节不变（双轨正交：θ 学习不动旧律）
  const tagged = new EvolutionEngine({ seed: 505 });
  mkRuns().forEach((r, i) =>
    tagged.ingest({ ...r, bandit: { arm: ARMS[i % 5]!, prob: 0.3, context: { scene: 'x', budget: 10 } } }),
  );
  assert.deepEqual(tagged.heuristics(), plain.heuristics(), 'bandit 轨学习不扰动旧权重表（逐键相等）');
  assert.ok(tagged.thetaNorms().inspect > 0 || Object.values(tagged.thetaNorms()).some(v => v > 0), 'θ 轨确实在学');
  // θ=0 退化裁决：贪心臂 = 旧建议分支一（最高权重先行，平票固定序）同一裁决
  assert.equal(plain.greedyArm(), 'scroll', '贪心 argmax(ln w) = 最高旧权重 scroll(1.1)');
  assert.ok(plain.report().nextRunAdvice[0]!.includes('scroll'), '旧建议同裁');
  // 上下文变化不改变 θ=0 退化行为（θ=0 ⇒ 分布与上下文无关，只随旧权重走）
  assert.deepEqual(plain.armProbabilities({ scene: 'whatever', worldKind: 'x', stepsRemaining: 0 }), plain.armProbabilities());
});

// ─── 验收五：权重有界性 ───

test('W1-5: 权重有界性——对抗历史下 θ 范数恒 ≤ thetaMax、|G| ≤ 1/ε、分布恒合法', () => {
  // 40 轮全成功 + 记录概率压在 ε 下限 ⇒ 每轮 G = 0.9/0.01 = 90（最大爆炸压力）
  const e = new EvolutionEngine({ seed: 606 });
  for (let i = 0; i < 40; i++) {
    e.ingest(R({
      goal: `对抗${i}`, success: true, steps: 1, strategies: ['click'],
      bandit: { arm: ARMS[i % 5]!, prob: 0.01, context: { scene: 'hostile', budget: 2 } },
    }));
  }
  const norms = e.thetaNorms();
  for (const [k, v] of Object.entries(norms)) {
    assert.ok(Number.isFinite(v), `θ 范数须有限（${k} = ${v}）`);
    assert.ok(v <= EXP4_HYPERPARAMS.thetaMax + 1e-9, `θ 范数 ≤ ${EXP4_HYPERPARAMS.thetaMax}（${k} = ${v}）`);
  }
  assert.ok(Object.values(norms).some(v => v >= EXP4_HYPERPARAMS.thetaMax - 1e-6), '对抗压力下确有臂触顶（裁剪真实生效）');
  const led = e.exportAuditLedger();
  assert.equal(led.length, 40);
  for (const ent of led) {
    assert.ok(Math.abs(ent.importance) <= 1 / EXP4_HYPERPARAMS.probFloor + 1e-9, '|G| ≤ 1/ε');
    assert.ok(ent.x.every(v => Number.isFinite(v)), '特征向量恒有限');
  }
  // 高压学习后分布仍合法、可序列化（无 NaN/Infinity）
  assertLegalDist(e.armProbabilities({ scene: 'hostile', budget: 2 }));
  assert.ok(!JSON.stringify(e.armProbabilities({ scene: 'hostile', budget: 2 })).includes('null'), '无 NaN/Inf 混入');
  // η 上夹取：注入疯狂学习率 ⇒ 构造处夹回 etaMax，范数保险丝仍在
  const crazy = new EvolutionEngine({ seed: 606, eta: 1e6 });
  for (let i = 0; i < 10; i++) {
    crazy.ingest(R({ success: true, steps: 1, strategies: [], bandit: { arm: 'click', prob: 0.01, context: { budget: 2 } } }));
  }
  assert.ok(crazy.thetaNorms().click <= EXP4_HYPERPARAMS.thetaMax + 1e-9, 'η 夹取 + 范数裁剪双保险');
  // 极端负重要性（反复失败压同一臂）同律有界
  const neg = new EvolutionEngine({ seed: 606 });
  for (let i = 0; i < 30; i++) {
    neg.ingest(R({ success: false, steps: 2, strategies: [], bandit: { arm: 'scroll', prob: 0.01, context: { budget: 2 } } }));
  }
  for (const v of Object.values(neg.thetaNorms())) assert.ok(v <= EXP4_HYPERPARAMS.thetaMax + 1e-9);
  assertLegalDist(neg.armProbabilities());
});

// ─── 防御与记账补充 ───

test('W1-5: 防御与记账——坏 bandit 标注绝不抛、环形账本同律、η=0 关学习、闭环回灌一致', () => {
  // 坏标注全谱：绝不抛、诚实降级
  const e = new EvolutionEngine({ seed: 707 });
  assert.doesNotThrow(() => {
    e.ingest(R({ strategies: [], bandit: 'x' as never }));                     // 非对象 ⇒ 该轮不进 θ 轨
    e.ingest(R({ strategies: [], bandit: { arm: 42 as never, prob: 'high' as never, context: 'y' as never } })); // 字段全坏 ⇒ 中性上下文 + 贪心臂
    e.ingest(R({ strategies: [], bandit: null as never }));                    // null ⇒ 不进 θ 轨
    e.armProbabilities({ scene: 42 as unknown as string, budget: 'x' as unknown as number, stepsRemaining: Number.NaN });
    e.greedyArm(undefined);
    e.thetaNorms();
  });
  assert.equal(e.exportAuditLedger().length, 1, '仅字段全坏的对象标注进账本（中性降级）');
  const ent = e.exportAuditLedger()[0]!;
  assert.ok((ARMS as readonly string[]).includes(ent.arm));
  assert.ok(ent.x.every(v => Number.isFinite(v)));
  // 敌意上下文（scene 数字 / 预算字符串）⇒ 特征防御回落，绝不产出 NaN
  const hostile = contextFeatureVector({ scene: 7 as unknown as string, worldKind: [] as unknown as string });
  assert.ok(hostile.every(v => Number.isFinite(v) && v >= 0 && v <= 1));
  assert.equal(hostile.filter(v => v === 1).length, 4, '非串标签按空串自成一类：三块 one-hot + 偏置');
  // 环形账本同律：205 条 bandit 轮 ⇒ 账本恰 200（与 history 同窗口）
  const ring = new EvolutionEngine({ seed: 707 });
  for (let i = 0; i < 205; i++) {
    ring.ingest(R({ goal: `r${i}`, success: true, steps: 1, strategies: [], bandit: { arm: 'click', prob: 0.5, context: { budget: 4 } } }));
  }
  const rl = ring.exportAuditLedger();
  assert.equal(rl.length, 200);
  assert.equal(rl[0]!.step, 1, 'step 序号随当前窗口重排（1 起）');
  assert.equal(rl[199]!.step, 200);
  // η=0 ⇒ 关学习只记账（审计在场、θ 恒零）
  const off = new EvolutionEngine({ seed: 707, eta: 0 });
  off.ingest(R({ strategies: [], bandit: { arm: 'click', prob: 0.5, context: { budget: 4 } } }));
  assert.equal(off.exportAuditLedger().length, 1, 'η=0 仍记账');
  assert.deepEqual(off.thetaNorms(), { scroll: 0, inspect: 0, ask_vlm: 0, recall_skill: 0, click: 0 }, 'η=0 ⇒ 零学习');
  // 闭环契约：selectAction → ingest(annotation) ⇒ 账本逐轮还原在线选择
  const loop = new EvolutionEngine({ seed: 808 });
  const picks: Array<{ arm: string; prob: number }> = [];
  for (let i = 0; i < 12; i++) {
    const s = loop.selectAction({ scene: 'loop', worldKind: 'web', budget: 10 });
    picks.push({ arm: s.arm, prob: s.prob });
    loop.ingest(R({ goal: `L${i}`, success: i % 3 !== 0, steps: 3, strategies: [s.arm], bandit: s.annotation }));
  }
  const ll = loop.exportAuditLedger();
  assert.equal(ll.length, 12);
  picks.forEach((pk, i) => {
    assert.equal(ll[i]!.arm, pk.arm, `第 ${i} 轮账本臂 = 在线采样臂`);
    near(ll[i]!.prob, pk.prob, 0);
    assert.deepEqual(ll[i]!.x, contextFeatureVector({ scene: 'loop', worldKind: 'web', budget: 10 }), 'annotation.context 原样进特征');
  });
  // 在线探索有反馈：12 轮后 θ 已非零（闭环真的在学）
  assert.ok(Object.values(loop.thetaNorms()).some(v => v > 0));
});
