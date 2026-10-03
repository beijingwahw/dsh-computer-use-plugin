// test/epochTheta.wiring.test.ts
// 纪元 Θ（Θ-4 生产接线）执法册：
//   Θ-4① 未注册时读点行为逐字节等同现状（arbitrateElements 缺省参路径 /
//        snapshotChanged 缺省容差 3 / policyEngine decide 用 0.55 —— 三个新断言；
//        其余读点的缺省值由既有回归册锁定：vlm.arbitration（Ω-9-2 的 +0.15、
//        Ω-9-7 的 0.8）、autonomy.worldSnapshot（Φ-2-4 距 3 ≤ 容差 3）、
//        autonomy.policyEngine（Φ-3 系 0.55/并列门）、autonomy.uncertainty（α=4/β=1
//        决策表 18 格）、vlm.grounding（NMS 0.6）—— 引述回归不重写）；
//   Θ-4② registerProductionKernels 幂等（两次入册 list 长度不变）且全值 = 缺省
//        （drift() 为空）；
//   Θ-4③ 注册后 set('world.hammingTolerance', 5) ⇒ snapshotChanged 判决随容差翻转
//        （距离 4 的两指纹：缺省 3 判变、5 判不变）且越界 set 夹回 [1,8]；
//   Θ-4④ 仪表盘 'kernel' 分区：空册诚实「暂无内核登记」；入册 + 漂移后渲染
//        key / 现值 vs 缺省 / drift% / 80 列纪律；
//   Θ-4⑤ 全程 try/finally resetKernelRuntime 防污染（生产单例不带走测试残迹）。
// 全离线、零网络、零截屏、确定性。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { arbitrateElements, arbitrateText } from '../src/vlm/arbitration.ts';
import type { GroundedElement } from '../src/vlm/grounding.ts';
import type { LocalElement } from '../src/vlm/arbitration.ts';
import type { Bbox } from '../src/vlm/codec.ts';
import { snapshotChanged, type WorldSnapshot } from '../src/autonomy/worldSnapshot.ts';
import { PolicyEngine } from '../src/autonomy/policyEngine.ts';
import type { SnapshotElement } from '../src/autonomy/worldSnapshot.ts';
import type { GoalSpec, GoalProgress } from '../src/autonomy/goalState.ts';
import { kernelRegistry, resetKernelRuntime } from '../src/kernel/registry.ts';
import { registerProductionKernels } from '../src/kernel/index.ts';
import { createMetricsDashboardTool } from '../src/tools/metricsDashboard.ts';

// ─── 假件工厂（与 autonomy.policyEngine.test.ts 同款形状，零联网） ───

const box = (x0: number, y0: number, x1: number, y1: number): Bbox => ({ x0, y0, x1, y1 });

function ve(label: string, bbox: Bbox, confidence: number): GroundedElement {
  return {
    id: 'e1',
    label,
    role: 'button',
    bbox,
    center: { x: (bbox.x0 + bbox.x1) / 2, y: (bbox.y0 + bbox.y1) / 2 },
    confidence,
    source: 'vlm',
  };
}

function le(label: string, bbox: Bbox, confidence: number): LocalElement {
  return { label, bbox, confidence };
}

/** 极简快照：除 dhash 与元素表外全部安静缺省（snapshotChanged 只消费这两项） */
function snapOf(dhash: string | null, elements: SnapshotElement[] = []): WorldSnapshot {
  return {
    takenAt: 1,
    width: 1920,
    height: 1080,
    dhash,
    elements,
    textDigest: '',
    popups: [],
    focusedRegion: null,
    sceneLabel: 'desktop',
    degraded: [],
  };
}

const el = (label: string): SnapshotElement => ({
  label,
  role: 'button',
  bbox: box(0, 0, 10, 10),
  center: { x: 5, y: 5 },
  confidence: 0.9,
  source: 'vlm',
  interactive: true,
});

/** 决策上下文：单判据「打开设置面板并确认保存」（中文 2-gram 词面可控） */
function ctxWith(label: string): Parameters<PolicyEngine['decide']>[0] {
  const criterion = '打开设置面板并确认保存';
  const spec: GoalSpec = { goal: '完成设置操作', successCriteria: [criterion] };
  const goal: GoalProgress = {
    phase: 'acting',
    stepIndex: 1,
    criteriaStatus: [{ criterion, status: 'unverified' }],
    startedAt: 1,
    lastUpdateAt: 2,
    blockers: [],
  };
  return { snapshot: snapOf(null, [el(label)]), spec, goal, history: [] };
}

// ─── Θ-4①：未注册 ⇒ 行为逐字节等同现状 ───

test('Θ-4①: 未注册时读点缺省 = 现行字面量 —— 仲裁缺省参 / snapshotChanged 容差 3 / policyEngine 0.55 门槛', async () => {
  resetKernelRuntime(); // 前置隔离：本测试的全部分支都消费「未注册」语义
  try {
    assert.equal(kernelRegistry.list().length, 0, '前置：生产注册表未入册');

    // (a) arbitrateElements 缺省参路径：IoU 0.44 < 0.5 不得配对（若缺省被改小即融合）
    const noFuse = arbitrateElements(
      [ve('设置', box(0, 0, 100, 100), 0.7)],
      [le('设置', box(0, 0, 100, 44), 0.5)],
    );
    assert.equal(noFuse.elements.filter(e => e.source === 'fusion').length, 0, 'IoU 0.44 < 缺省 0.5 ⇒ 不融合');
    assert.equal(noFuse.winner, 'vlm', '1v1 无融合平票 ⇒ vlm');

    // (b) IoU 0.64 ≥ 0.5 ⇒ 融合，且加成 = 缺省 0.15（conf = (0.7+0.5)/2 + 0.15 = 0.75）
    const fused = arbitrateElements(
      [ve('设置', box(0, 0, 100, 100), 0.7)],
      [le('设置', box(0, 0, 80, 80), 0.5)],
    );
    assert.equal(fused.elements[0].source, 'fusion', 'IoU 0.64 ≥ 缺省 0.5 ⇒ 融合');
    assert.ok(
      Math.abs(fused.elements[0].confidence - 0.75) < 1e-9,
      `融合置信含缺省加成 0.15（实测 ${fused.elements[0].confidence}）`,
    );

    // (c) snapshotChanged 缺省容差 3：距 4 判变、距 3 判未变（恰落阈值线为未变）
    //     指纹距离按 nibble XOR popcount：'00'⊕'0f' = 4、'00'⊕'07' = 3
    assert.equal(snapshotChanged(snapOf('00'), snapOf('0f')), true, '距 4 > 缺省容差 3 ⇒ 判变');
    assert.equal(snapshotChanged(snapOf('00'), snapOf('07')), false, '距 3 ≤ 缺省容差 3 ⇒ 判未变');

    // (d) policyEngine decide 用 0.55：标签被判据完全覆盖（得分 1.0）⇒ 不确定消除；
    //     覆盖率 3/13 ≈ 0.23 < 0.55 ⇒ uncertain。useVlmWhenUncertain=false ⇒ 零云脑路径。
    const engine = new PolicyEngine({ useVlmWhenUncertain: false });
    const confident = await engine.decide(ctxWith('设置面板'));
    assert.equal(confident.action.kind, 'click', '得分 1.0 ⇒ 判据匹配点击');
    assert.equal(confident.uncertain, false, '得分 1.0 ≥ 0.55 ⇒ 确定判决');
    const shaky = await engine.decide(ctxWith('设置面板天气音乐电影新闻图片'));
    assert.equal(shaky.action.kind, 'click', '低分仍有唯一候选 ⇒ 仍点击（确定性最佳）');
    assert.equal(shaky.uncertain, true, '得分 3/13 ≈ 0.23 < 0.55 ⇒ uncertain 标记');

    // (e) arbitrateText 缺省 0.8（引述 Ω-9-7 的既有覆盖，此处只验一处边界形态）
    const txt = arbitrateText('设置面版', '设置面板'); // 距 1 / 长 4 ⇒ 相似度 0.75 < 0.8
    assert.equal(txt.source, 'vlm', '相似度 0.75 < 缺省 0.8 ⇒ 分歧归 vlm');
  } finally {
    resetKernelRuntime();
  }
});

// ─── Θ-4②：registerProductionKernels 幂等 + 全值 = 缺省 ───

test('Θ-4②: registerProductionKernels 幂等（两次入册长度不变）且全值 = 缺省（drift 为空）', () => {
  resetKernelRuntime();
  try {
    registerProductionKernels();
    const once = kernelRegistry.list();
    assert.ok(once.length >= 18, `入册键数 ≥ 18（实测 ${once.length}）`);

    // Θ-4 接线清单的 18 键全在册（读点 → 键的完整映射）
    const expected = [
      'world.hammingTolerance',
      'arbitration.iouThreshold',
      'arbitration.agreementBonus',
      'arbitration.textSimilarity',
      'policy.matchConfident',
      'policy.tieGap',
      'uncertainty.alpha',
      'uncertainty.beta',
      'uncertainty.highProceed',
      'uncertainty.highVlm',
      'uncertainty.mediumProceed',
      'uncertainty.mediumVlm',
      'uncertainty.lowProceed',
      'uncertainty.lowVlm',
      'ocr.wordConfidenceFloor',
      'grounding.nmsIou',
      'skill.sceneGate',
      'skill.sceneBonus',
    ];
    for (const key of expected) {
      assert.ok(kernelRegistry.has(key), `接线键在册：${key}`);
      assert.ok(typeof kernelRegistry.get(key) === 'number', `${key} 现值为数值`);
    }

    // 幂等：重入册长度不变（register 重复键保持现值、零重复行）
    registerProductionKernels();
    assert.equal(kernelRegistry.list().length, once.length, '两次入册 list 长度不变（幂等）');

    // 全值 = 缺省：drift() 只列偏离者 ⇒ 空表即零漂移铁证
    assert.deepEqual(kernelRegistry.drift(), [], '入册值全为缺省 ⇒ drift 报表为空');
    for (const p of kernelRegistry.list()) {
      assert.equal(p.value, p.defaultValue, `${p.key} 现值 = 缺省（零行为变化的锚）`);
    }

    // 缺省锚点抽查（与各读点现行字面量一致）
    assert.equal(kernelRegistry.getOrDefault('arbitration.iouThreshold', -1), 0.5);
    assert.equal(kernelRegistry.getOrDefault('policy.matchConfident', -1), 0.55);
    assert.equal(kernelRegistry.getOrDefault('ocr.wordConfidenceFloor', -1), 60);
    assert.equal(kernelRegistry.getOrDefault('grounding.nmsIou', -1), 0.6);
  } finally {
    resetKernelRuntime();
  }
});

// ─── Θ-4③：set 改值 ⇒ 读点判决随之翻转；越界夹回区间 ───

test('Θ-4③: set(world.hammingTolerance, 5) ⇒ 距离 4 的判决翻转（3 判变 / 5 判不变）且越界夹回 [1,8]', () => {
  resetKernelRuntime();
  try {
    // 未入册 ⇒ set 拒绝（注册是进化通道的门，不是行为开关）
    assert.equal(kernelRegistry.set('world.hammingTolerance', 5).ok, false, '未注册键 set 恒失败');

    registerProductionKernels();
    const near = [snapOf('00'), snapOf('0f')]; // 汉明距离恰为 4 的两指纹
    assert.equal(snapshotChanged(near[0], near[1]), true, '缺省容差 3：距 4 > 3 ⇒ 判变');

    // 注册后 set 生效 ⇒ snapshotChanged 的缺省缝读到新容差，判决翻转
    const r = kernelRegistry.set('world.hammingTolerance', 5);
    assert.equal(r.ok, true, '已注册键 set 成功');
    assert.equal(snapshotChanged(near[0], near[1]), false, '容差 5：距 4 ≤ 5 ⇒ 判未变（判决随内核翻转）');

    // 显式入参仍最高优先（缺省缝只是兜底，不越权覆盖调用方）
    assert.equal(snapshotChanged(near[0], near[1], 0), true, '显式容差 0 ⇒ 判变（入参压过注册表）');

    // 越界夹取：set 是夹取不是失败（区间 [1,8]）
    const hi = kernelRegistry.set('world.hammingTolerance', 99);
    assert.deepEqual(hi, { ok: true, reason: 'clamped', clampedTo: 8 }, 'set 99 ⇒ 夹到 8');
    assert.equal(kernelRegistry.get('world.hammingTolerance'), 8);
    const lo = kernelRegistry.set('world.hammingTolerance', -5);
    assert.deepEqual(lo, { ok: true, reason: 'clamped', clampedTo: 1 }, 'set -5 ⇒ 夹到 1');
    assert.equal(kernelRegistry.get('world.hammingTolerance'), 1);
  } finally {
    resetKernelRuntime();
  }
});

// ─── Θ-4④：仪表盘 kernel 分区 ───

/** 视觉宽度镜像（80 列断言的事实源 —— 与 metricsDashboard.visualWidth 同律） */
function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

test('Θ-4④: 仪表盘 kernel 分区 —— 空册诚实「暂无内核登记」；入册+漂移后渲染 key/drift%/80 列', async () => {
  resetKernelRuntime();
  const tool = createMetricsDashboardTool();
  const run = async (args: unknown): Promise<any> =>
    JSON.parse(String(await (tool as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute(args, undefined)));
  try {
    // 空册：分区头 + 诚实一行（SUCCESS 不误报）
    const empty = await run({ section: 'kernel' });
    assert.equal(empty.status, 'SUCCESS');
    assert.equal(empty.state_anchor.section, 'kernel');
    assert.deepEqual(empty.state_anchor.sections, ['kernel']);
    const dashE = String(empty.state_anchor.dashboard);
    assert.ok(dashE.includes('内核区'), 'kernel 单区渲染内核区分区头');
    assert.ok(dashE.includes('暂无内核登记'), '空册诚实申报（不伪装有数）');

    // 入册 + 漂移：key / 器官 / 现值 vs 缺省 / drift% 皆在场
    registerProductionKernels();
    kernelRegistry.set('world.hammingTolerance', 5); // |5-3|/7 = 28.571% → 28.6%
    const out = await run({ section: 'kernel' });
    assert.equal(out.status, 'SUCCESS');
    const dash = String(out.state_anchor.dashboard);
    assert.ok(dash.includes('world.hammingTolerance'), '参数键在场');
    assert.ok(dash.includes('perception'), '器官归属在场');
    assert.ok(dash.includes('28.6%'), '漂移百分比在场（|5−3|/区间宽 7 = 28.6%）');
    assert.match(dash, /漂移%/, '表头中文标签在场');
    for (const line of dash.split('\n')) {
      assert.ok(visualWidth(line) <= 80, `行宽 ${visualWidth(line)} > 80：${line}`);
    }

    // all 模式：第五分区随全盘渲染（分区头在场；sections 枚举见 epochSigma Σ-7①）
    const all = await run({});
    assert.ok(String(all.state_anchor.dashboard).includes('内核区'), 'all 模式内核区随盘渲染');
  } finally {
    resetKernelRuntime();
  }
});

// ─── Θ-4⑤：隔离执法 —— 生产单例不带走测试残迹 ───

test('Θ-4⑤: try/finally resetKernelRuntime —— 测试毕生产单例归零（无键、无漂移、无证据）', () => {
  resetKernelRuntime();
  try {
    registerProductionKernels();
    kernelRegistry.set('policy.matchConfident', 0.7);
    assert.ok(kernelRegistry.list().length > 0, '前置：册上确有测试残迹');
  } finally {
    resetKernelRuntime();
  }
  assert.equal(kernelRegistry.list().length, 0, 'finally 后生产注册表清零');
  assert.deepEqual(kernelRegistry.drift(), [], '漂移报表为空');
  // 归零后读点回声字面量（= 未注册的缺省行为，与 Θ-4① 同律闭环）
  assert.equal(kernelRegistry.getOrDefault('policy.matchConfident', 0.55), 0.55);
});
