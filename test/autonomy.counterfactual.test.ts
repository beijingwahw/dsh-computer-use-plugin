// test/autonomy.counterfactual.test.ts
// 纪元 Φ（Φ-9 · 反事实规划器）：执法册 —— 全离线字面量验证，零网络零 IO。
// 覆盖：效用手算对照（三围逐项 + 缺省权重择优）、重复折价（progress ×0.6 /
// tried click 信息 0.1）、总效用并列（差 <0.01）取信息增益高者、风险惩罚翻盘
// （destructive 让位 benign）、空输入 null、actionSignature 归一与截 60 稳定、
// 信息增益先验表（scroll 0.8 / inspect 0.7 / ask_vlm 0.6 / click 陌生度 / 零族）、
// 目标关键词重合率数值（部分重合 / 短语分解 / 停用词 / declare 回退 expectedEffect）、
// 权重缺省与逐项覆盖、纪元 Δ 权重卫兵（负权重逐项夹 [0,1]、全零回退缺省、
// 超 1 压回 1——三种脏值各有择优翻盘对照）、predictedEffects 从快照推导、
// 脏输入防御与纯度（绝不抛）。
// ΝΩ-10（决策面五合一）追加：infoGain 新鲜度两臂（从未点过 +0.15 / 点过且
// no_effect −0.1 / 点过有进展不修正 / 缺席走旧值）、expectedInformationGain
// 第三参直测、效用权重内核三键（policy.progressWeight/infoWeight/riskWeight
// 入册零漂移 + set 翻盘 + 显式 weights 最高优先 + 越界夹回，对照 Θ-4 先例风格）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreOptions,
  rankTopK,
  expectedInformationGain,
  actionSignature,
  transitionConfidenceFactor,
  wireCounterfactualWorldModel,
  counterfactualWorldModelWired,
  type ClickFreshness,
  type CounterfactualPlan,
  type ScoringContext,
  type WorldModelReadPort,
} from '../src/autonomy/counterfactual.ts';
import { quantizedScreenTypeOf, transitionActionKeyOf } from '../src/autonomy/counterfactualUtil.ts';
import { quantizedScreenType, prophecyActionKey, PROPHECY_QUANT_KERNEL_KEY } from '../src/prophecy/index.ts';
import type { AutonomyActionKind, PolicyAction } from '../src/autonomy/policyEngine.ts';
import type { SnapshotElement, WorldSnapshot } from '../src/autonomy/worldSnapshot.ts';
import { kernelRegistry, resetKernelRuntime } from '../src/kernel/registry.ts';
import { registerProductionKernels } from '../src/kernel/index.ts';

// ─── 假件与工厂（全部字面量，无任何真实感知/网络） ───

// 浮点断言：容差式比较（重合率含 1/3 等非二进制小数，拒绝逐位巧合）
const close = (actual: number, expected: number, tol = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tol, `期望 ${actual} ≈ ${expected}（容差 ${tol}）`)

/** 快照元素工厂 —— 缺省可点按钮、固定框与置信 */
function elem(label: string): SnapshotElement {
  return {
    label,
    role: 'button',
    bbox: { x0: 0, y0: 0, x1: 100, y1: 40 },
    center: { x: 50, y: 20 },
    confidence: 0.9,
    source: 'vlm',
    interactive: true,
  }
}

/** 快照工厂 —— 除覆盖项外全部安静缺省（无弹窗 / 无聚焦 / 无降级） */
function snap(o: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    takenAt: 1,
    width: o.width ?? 1920,
    height: o.height ?? 1080,
    dhash: o.dhash ?? null,
    elements: o.elements ?? [],
    textDigest: o.textDigest ?? '',
    popups: o.popups ?? [],
    focusedRegion: o.focusedRegion ?? null,
    sceneLabel: o.sceneLabel ?? 'desktop',
    degraded: o.degraded ?? [],
  }
}

/** 点击目标工厂（bbox + 几何中心 + 标签） */
function tgt(label: string): NonNullable<PolicyAction['target']> {
  const bbox = { x0: 10, y0: 20, x1: 110, y1: 60 }
  return { bbox, center: { x: (bbox.x0 + bbox.x1) / 2, y: (bbox.y0 + bbox.y1) / 2 }, label }
}

/** 动作工厂 —— rationale/expectedEffect 恒非空，riskTier 缺省 benign */
function act(kind: AutonomyActionKind, o: Partial<PolicyAction> = {}): PolicyAction {
  return {
    kind,
    ...(o.target !== undefined ? { target: o.target } : {}),
    ...(o.payload !== undefined ? { payload: o.payload } : {}),
    rationale: o.rationale ?? '测试动作',
    expectedEffect: o.expectedEffect ?? '世界状态改变',
    utility: o.utility ?? 0.5,
    riskTier: o.riskTier ?? 'benign',
  }
}

/** 评分上下文工厂 —— goalKeywords/snapshot 缺省为空，tried/weights/noEffect 按需注入 */
function ctx(o: {
  goalKeywords?: string[]
  snapshot?: WorldSnapshot
  triedActionKeys?: string[]
  noEffectActionKeys?: string[]
  weights?: ScoringContext['weights']
  worldModel?: WorldModelReadPort
} = {}): ScoringContext {
  return {
    goalKeywords: o.goalKeywords ?? [],
    snapshot: o.snapshot ?? snap(),
    ...(o.triedActionKeys !== undefined ? { triedActionKeys: o.triedActionKeys } : {}),
    ...(o.noEffectActionKeys !== undefined ? { noEffectActionKeys: o.noEffectActionKeys } : {}),
    ...(o.weights !== undefined ? { weights: o.weights } : {}),
    ...(o.worldModel !== undefined ? { worldModel: o.worldModel } : {}),
  }
}

// ─── ΝΩ-46（model-based 反事实）：世界模型只读面工坊 ───

/** 16 hex 闭环 dhash（量化屏型方言的合格公民 —— 低位 4 字恰是量化掩没带） */
const WM_DHASH = '1234567890abcdef';

/** 按表答话的只读端口桩：表键 `${fromType}|${actionKey}` → top.prob；缺席 ⇒ top:null */
function portOf(table: Record<string, number>): WorldModelReadPort {
  return {
    predict: (fromType, actionKey) => {
      const prob = table[`${fromType}|${actionKey}`];
      return prob === undefined ? { top: null } : { top: { typeId: 'screen-dest', prob } };
    },
  };
}

/** ΝΩ-46 带断言消息的浮点对照（close 的第三参是容差 —— 消息版另铸，不混用） */
const closeMsg = (actual: number, expected: number, msg: string): void =>
  assert.ok(Math.abs(actual - expected) <= 1e-9, `${msg}（期望 ${actual} ≈ ${expected}）`)

/** 指定格子的点击动作（中心点按 1920×1080 折算 ⇒ qx/qy 直接给定） */
function clickAtCell(cell: string, label: string): PolicyAction {
  const qx = Number.parseInt(cell[0], 10);
  const qy = Number.parseInt(cell[1], 10);
  const x = 1920 * (qx + 0.5) / 4;
  const y = 1080 * (qy + 0.5) / 4;
  return act('click', { target: { bbox: { x0: x - 10, y0: y - 10, x1: x + 10, y1: y + 10 }, center: { x, y }, label } });
}

/** ΝΩ-46 测试共用屏：16 hex dhash、1920×1080 几何（与闭环方言一致） */
function wmSnap(elements: SnapshotElement[] = []): WorldSnapshot {
  return snap({ dhash: WM_DHASH, width: 1920, height: 1080, elements });
}

// ─── Φ-9-1 效用手算对照 ───

test('Φ-9-1: 效用手算对照 —— 三围逐项核对与缺省权重（0.5/0.3/0.2）下的择优', () => {
  const s = snap({ elements: [elem('登录')] })
  const clickLogin = act('click', { target: tgt('登录') })
  const scrollDown = act('scroll', { payload: { direction: 'down' } })
  // 手算（缺省权重）：
  //   click「登录」：目标词 {打开,登录,页面} ∩ 标签词 {登录} = 1/3 ⇒ progress ≈ 0.3333；
  //     label 已见账本 ⇒ info 0.3；benign ⇒ risk 0.05；
  //     U = 0.5×(1/3) + 0.3×0.3 − 0.2×0.05 = 1/6 + 0.09 − 0.01 ≈ 0.2467
  //   scroll：0.25 / 0.8 / 0.05 ⇒ U = 0.125 + 0.24 − 0.01 = 0.355 ⇒ 胜出
  const plan = scoreOptions([clickLogin, scrollDown], ctx({ goalKeywords: ['打开', '登录', '页面'], snapshot: s }))
  assert.ok(plan)
  assert.equal(plan.chosen.action.kind, 'scroll', 'U 0.355 > 0.2467 ⇒ scroll 胜')
  close(plan.chosen.progressProbability, 0.25)
  assert.equal(plan.chosen.informationGain, 0.8)
  assert.equal(plan.chosen.risk, 0.05)
  assert.equal(plan.rejected.length, 1)
  const rej = plan.rejected[0]
  assert.equal(rej.option.action.kind, 'click')
  close(rej.option.progressProbability, 1 / 3)
  assert.equal(rej.option.informationGain, 0.3)
  assert.equal(rej.option.risk, 0.05)
  assert.ok(rej.why.includes('低于'), `落选理由应为效用更低：${rej.why}`)
})

// ─── Φ-9-2 重复折价 ───

test('Φ-9-2: 重复折价 —— tried 动作 progress ×0.6；tried click 信息 0.1；tried scroll 信息不折', () => {
  const s = snap({ elements: [elem('登录')] })
  const kw = ['打开', '登录', '页面']
  const clickLogin = act('click', { target: tgt('登录') })
  // tried click：progress = (1/3)×0.6 = 0.2；信息按已试执法 ⇒ 0.1
  const plan = scoreOptions([clickLogin], ctx({ goalKeywords: kw, snapshot: s, triedActionKeys: ['click:登录'] }))
  assert.ok(plan)
  close(plan.chosen.progressProbability, 0.2)
  assert.equal(plan.chosen.informationGain, 0.1)
  assert.equal(plan.chosen.risk, 0.05, '折价不动风险分')
  // tried scroll：progress 0.25×0.6 = 0.15；信息先验 0.8 不因 tried 折（计分律仅对 click 信息执法）
  const plan2 = scoreOptions([act('scroll')], ctx({ triedActionKeys: ['scroll:'] }))
  assert.ok(plan2)
  close(plan2.chosen.progressProbability, 0.15)
  assert.equal(plan2.chosen.informationGain, 0.8)
})

// ─── Φ-9-3 并列取信息增益 ───

test('Φ-9-3: 总效用并列（差 <0.01）取信息增益高者', () => {
  const s = snap({ elements: [elem('打开设置面板确认')] })
  const kw = ['打开', '设置', '面板', '确认']
  const a = act('click', { target: tgt('打开设置面板确认') }) // progress 4/4=1.0；label 在账本 ⇒ info 0.3
  const b = act('click', { target: tgt('打开设置面板') }) // progress 3/4=0.75；label 陌生 ⇒ info 0.4
  // 权重 {progress:0.2, info:0.5, risk:0.1}：
  //   U_a = 0.2 + 0.15 − 0.005 = 0.345；U_b = 0.15 + 0.20 − 0.005 = 0.345（并列）
  const plan = scoreOptions([a, b], ctx({ goalKeywords: kw, snapshot: s, weights: { progress: 0.2, info: 0.5, risk: 0.1 } }))
  assert.ok(plan)
  assert.equal(plan.chosen.action.target?.label, '打开设置面板', '并列 ⇒ 信息增益 0.4 > 0.3 者胜')
  close(plan.chosen.informationGain, 0.4)
  close(plan.chosen.progressProbability, 0.75)
  assert.equal(plan.rejected.length, 1)
  assert.equal(plan.rejected[0].option.action.target?.label, '打开设置面板确认')
  assert.ok(plan.rejected[0].why.includes('信息增益'), `落选理由应点明信息增益：${plan.rejected[0].why}`)
})

// ─── Φ-9-4 风险惩罚翻盘 ───

test('Φ-9-4: 风险惩罚翻盘 —— destructive 高进展让位 benign 同进展', () => {
  const s = snap({ elements: [elem('打开并删除文件'), elem('打开文件')] })
  const kw = ['打开', '文件']
  const danger = act('click', { target: tgt('打开并删除文件'), riskTier: 'destructive' })
  const safe = act('click', { target: tgt('打开文件') })
  // danger：progress 2/2=1.0、info 0.3、risk 1.0 ⇒ U = 0.5 + 0.09 − 0.2 = 0.39
  // safe：progress 1.0、info 0.3、risk 0.05 ⇒ U = 0.5 + 0.09 − 0.01 = 0.58 ⇒ 胜
  const plan = scoreOptions([danger, safe], ctx({ goalKeywords: kw, snapshot: s }))
  assert.ok(plan)
  assert.equal(plan.chosen.action.target?.label, '打开文件')
  assert.equal(plan.chosen.risk, 0.05)
  assert.equal(plan.rejected.length, 1)
  assert.equal(plan.rejected[0].option.risk, 1, 'destructive ⇒ 风险分 1')
  assert.equal(plan.rejected[0].option.progressProbability, 1)
  // 唯一选项时 destructive 仍会被选（无竞争者不弃权，风险交给执行层闸门）
  const solo = scoreOptions([danger], ctx({ goalKeywords: kw, snapshot: s }))
  assert.ok(solo)
  assert.equal(solo.chosen.action.target?.label, '打开并删除文件')
  assert.equal(solo.rejected.length, 0)
})

// ─── Φ-9-5 空输入防御 ───

test('Φ-9-5: 空输入防御 —— 空候选 / 非数组 / 全脏条目 ⇒ null，绝不抛', () => {
  const c = ctx({ goalKeywords: ['登录'] })
  assert.equal(scoreOptions([], c), null)
  assert.equal(scoreOptions(null as unknown as PolicyAction[], c), null)
  assert.equal(scoreOptions([null, undefined] as unknown as PolicyAction[], c), null, '脏条目被滤除后为空 ⇒ null')
})

// ─── Φ-9-6 actionSignature 稳定 ───

test('Φ-9-6: actionSignature —— 归一、大小写折叠、截 60、无目标记空标签', () => {
  assert.equal(actionSignature(act('click', { target: tgt('  设置  面板 ') })), 'click:设置 面板')
  assert.equal(
    actionSignature(act('click', { target: tgt('OK Button') })),
    actionSignature(act('click', { target: tgt('ok button') })),
    '大小写与空白归一 ⇒ 同签名',
  )
  assert.equal(actionSignature(act('scroll', { payload: { direction: 'down' } })), 'scroll:')
  const sig = actionSignature(act('click', { target: tgt('x'.repeat(80)) }))
  assert.equal(sig.length, 60, '超长签名截 60 字符')
  assert.ok(sig.startsWith('click:x'))
  assert.notEqual(
    actionSignature(act('click', { target: tgt('登录') })),
    actionSignature(act('click', { target: tgt('登出') })),
    '不同标签不同签名',
  )
  assert.equal(actionSignature(null as unknown as PolicyAction), '', '脏动作 ⇒ 空串不抛')
})

// ─── Φ-9-7 信息增益先验表 ───

test('Φ-9-7: 信息增益先验表 —— expectedInformationGain 纯函数直测', () => {
  const s = snap({ elements: [elem('登录')] })
  assert.equal(expectedInformationGain(act('scroll'), s), 0.8, 'scroll ⇒ 新视野 0.8')
  assert.equal(expectedInformationGain(act('inspect'), s), 0.7, 'inspect ⇒ 细察 0.7')
  assert.equal(expectedInformationGain(act('ask_vlm'), s), 0.6, 'ask_vlm ⇒ 云脑补盲 0.6')
  assert.equal(expectedInformationGain(act('click', { target: tgt('登录') }), s), 0.3, 'label 已见快照账本 ⇒ 0.3')
  assert.equal(expectedInformationGain(act('click', { target: tgt('神秘入口') }), s), 0.4, '陌生 label ⇒ +0.1')
  assert.equal(expectedInformationGain(act('click'), s), 0.3, '无标签目标无陌生度可谈 ⇒ 基线 0.3')
  assert.equal(expectedInformationGain(act('declare'), s), 0)
  assert.equal(expectedInformationGain(act('escalate'), s), 0)
  assert.equal(expectedInformationGain(act('wait'), s), 0)
  assert.equal(expectedInformationGain(act('recall_skill'), s), 0.2, '未列举种类 ⇒ 中性先验 0.2')
  assert.equal(expectedInformationGain(act('hotkey'), s), 0.2)
  assert.equal(expectedInformationGain(null as unknown as PolicyAction, s), 0, '脏动作 ⇒ 0 不抛')
  assert.equal(
    expectedInformationGain(act('click', { target: tgt('神秘入口') }), null as unknown as WorldSnapshot),
    0.4,
    '脏快照按空账本记 ⇒ 全陌生',
  )
  assert.equal(expectedInformationGain(act('scroll'), s), 0.8, '重复调用同值（纯函数）')
})

// ─── Φ-9-8 进展先验与重合率数值 ───

test('Φ-9-8a: 各种类进展先验数值', () => {
  const kw = ['打开', '登录', '页面']
  const s = snap({ elements: [elem('登录')] })
  const p = (a: PolicyAction): number => {
    const plan = scoreOptions([a], ctx({ goalKeywords: kw, snapshot: s }))
    assert.ok(plan)
    return plan.chosen.progressProbability
  }
  // scroll/inspect 探索性固定先验 0.25
  close(p(act('scroll')), 0.25)
  close(p(act('inspect')), 0.25)
  assert.equal(p(act('ask_vlm')), 0.35)
  assert.equal(p(act('escalate')), 0.1)
  assert.equal(p(act('recall_skill')), 0.5, 'recall_skill 固定先验 0.5（不看重合度）')
  assert.equal(p(act('wait')), 0.2, '未列举种类保守先验 0.2')
  assert.equal(p(act('type')), 0.2)
})

test('Φ-9-8b: click/declare 的关键词重合率数值', () => {
  const kw = ['打开', '登录', '页面']
  const s = snap({ elements: [elem('登录')] })
  const p = (a: PolicyAction, goalKeywords: string[]): number => {
    const plan = scoreOptions([a], ctx({ goalKeywords, snapshot: s }))
    assert.ok(plan)
    return plan.chosen.progressProbability
  }
  // click 部分重合：{打开,登录,页面} ∩ {登录} = 1/3
  close(p(act('click', { target: tgt('登录') }), kw), 1 / 3)
  // click 零重合
  close(p(act('click', { target: tgt('购物车结算') }), kw), 0)
  // 关键词短语分解：「打开登录页」⇒ {打开,开登,登录,录页}，与标签 {登录} 交 1/4
  close(p(act('click', { target: tgt('登录') }), ['打开登录页']), 0.25)
  // 全停用词关键词 ⇒ 目标词为空 ⇒ 0
  close(p(act('click', { target: tgt('登录') }), ['的', 'the']), 0)
  // declare 无 target ⇒ 回退 expectedEffect 文本：「页面出现登录入口」∩ {打开,登录,页面} = 2/3
  close(p(act('declare', { expectedEffect: '页面出现登录入口' }), kw), 2 / 3)
  // click 有 target 但空标签 ⇒ 同样回退 expectedEffect
  close(p(act('click', { target: tgt(''), expectedEffect: '页面出现登录入口' }), kw), 2 / 3)
})

// ─── Φ-9-9 权重缺省与逐项覆盖 ───

test('Φ-9-9: 权重缺省与逐项覆盖 —— 覆盖后择优翻盘', () => {
  const s = snap({ elements: [elem('打开设置面板确认')] })
  const kw = ['打开', '设置', '面板', '确认']
  const a = act('click', { target: tgt('打开设置面板确认') }) // 1.0 / 0.3 / 0.05
  const b = act('scroll') // 0.25 / 0.8 / 0.05
  // 缺省 0.5/0.3/0.2：U_a = 0.5 + 0.09 − 0.01 = 0.58；U_b = 0.125 + 0.24 − 0.01 = 0.355 ⇒ click 胜
  const d = scoreOptions([a, b], ctx({ goalKeywords: kw, snapshot: s }))
  assert.ok(d)
  assert.equal(d.chosen.action.kind, 'click')
  // 全覆盖 {0.1,0.8,0.2}：U_a = 0.1 + 0.24 − 0.01 = 0.33；U_b = 0.025 + 0.64 − 0.01 = 0.655 ⇒ scroll 胜
  const f = scoreOptions([a, b], ctx({ goalKeywords: kw, snapshot: s, weights: { progress: 0.1, info: 0.8, risk: 0.2 } }))
  assert.ok(f)
  assert.equal(f.chosen.action.kind, 'scroll')
  // 部分覆盖 {info:0.8}（progress/risk 用缺省 0.5/0.2）：U_a = 0.5 + 0.24 − 0.01 = 0.73；U_b = 0.125 + 0.64 − 0.01 = 0.755 ⇒ scroll 胜
  const g = scoreOptions([a, b], ctx({ goalKeywords: kw, snapshot: s, weights: { info: 0.8 } }))
  assert.ok(g)
  assert.equal(g.chosen.action.kind, 'scroll')
  // 非法权重（NaN）按缺省记 ⇒ 与缺省同判
  const h = scoreOptions([a, b], ctx({ goalKeywords: kw, snapshot: s, weights: { progress: Number.NaN } }))
  assert.ok(h)
  assert.equal(h.chosen.action.kind, 'click')
})

// ─── Φ-9-9b 权重卫兵（纪元 Δ：负权重夹 [0,1]、全零回退缺省） ───

test('Φ-9-9b: 负权重逐项夹 [0,1] —— 全负夹全零回退缺省 {0.5,0.3,0.2}（择优与缺省同判）', () => {
  const s = snap({ elements: [elem('打开设置面板确认')] })
  const kw = ['打开', '设置', '面板', '确认']
  const a = act('click', { target: tgt('打开设置面板确认') }) // 1.0 / 0.3 / 0.05
  const b = act('scroll') // 0.25 / 0.8 / 0.05
  // 缺省权重：U_a = 0.58 > U_b = 0.355 ⇒ click（Φ-9-9 已证的基准）
  // 若负权重直通：U_a = −0.5−0.24+0.01 = −0.73 < U_b = −0.355 ⇒ scroll（择优翻盘 = 缺陷）
  const neg = scoreOptions([a, b], ctx({ goalKeywords: kw, snapshot: s, weights: { progress: -1, info: -1, risk: -1 } }))
  assert.ok(neg)
  assert.equal(neg.chosen.action.kind, 'click', '全负 ⇒ 全零 ⇒ 回退缺省 ⇒ 与缺省同判')
  // 字面全零同律回退
  const zero = scoreOptions([a, b], ctx({ goalKeywords: kw, snapshot: s, weights: { progress: 0, info: 0, risk: 0 } }))
  assert.ok(zero)
  assert.equal(zero.chosen.action.kind, 'click', '字面全零 ⇒ 缺省回退（全零效用恒 0 会把择优退化成输入序）')
})

test('Φ-9-9b: 单项负权重夹到 0 —— progress=-1 按 0 计，不再反转「推进目标」的符号', () => {
  // 甲系 10 个单字关键词：label「甲 乙 丙 丁」命中 4/10 = 0.4；「戊 己 庚」命中 3/10 = 0.3
  const kw = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸']
  const s = snap({ elements: [elem('戊 己 庚')] }) // 戊己庚 在账本 ⇒ info 0.3；甲乙丙丁 陌生 ⇒ info 0.4
  const p4 = act('click', { target: tgt('甲 乙 丙 丁') }) // 0.4 / 0.4 / 0.05
  const p3 = act('click', { target: tgt('戊 己 庚') }) // 0.3 / 0.3 / 0.05
  // 夹后 {0, 0.3, 0.2}：U(p4) = 0.12 − 0.01 = 0.11 > U(p3) = 0.09 − 0.01 = 0.08 ⇒ p4 胜
  //（若 -1 直通：U(p4) = −0.29 < U(p3) = −0.22 ⇒ 择优翻盘 —— 断言夹取在执法）
  const r = scoreOptions([p4, p3], ctx({ goalKeywords: kw, snapshot: s, weights: { progress: -1, info: 0.3 } }))
  assert.ok(r)
  assert.equal(r.chosen.action.target?.label, '甲 乙 丙 丁', 'progress 夹 0 后按信息增益裁决，负号不得反转')
})

test('Φ-9-9b: 超 1 权重压回 1 —— progress=7 按 1 计，效用不因放大而翻盘', () => {
  const kw = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸']
  const s = snap({ elements: [elem('戊 己 庚')] })
  const p4 = act('click', { target: tgt('甲 乙 丙 丁') }) // 0.4 / 0.4 / 0.05
  const scroll = act('scroll') // 0.25 / 0.8 / 0.05
  // 夹后 {1, 0.8, 0.2}：U(p4) = 0.4+0.32−0.01 = 0.71 < U(scroll) = 0.25+0.64−0.01 = 0.88 ⇒ scroll 胜
  //（若 7 直通：U(p4) = 2.8+0.31 = 3.11 > U(scroll) = 1.75+0.63 = 2.38 ⇒ 翻盘 —— 断言压回在执法）
  const r = scoreOptions([p4, scroll], ctx({ goalKeywords: kw, snapshot: s, weights: { progress: 7, info: 0.8, risk: 0.2 } }))
  assert.ok(r)
  assert.equal(r.chosen.action.kind, 'scroll', 'progress 压回 1 后信息增益主导')
})

// ─── Φ-9-10 predictedEffects 从快照推导 ───

test('Φ-9-10: predictedEffects —— 从快照推导的预期效果清单', () => {
  const withPopup = snap({ elements: [elem('允许')], popups: ['权限确认'] })
  const plan = scoreOptions([act('click', { target: tgt('允许') })], ctx({ snapshot: withPopup }))
  assert.ok(plan)
  const fx = plan.chosen.predictedEffects
  assert.ok(fx.length >= 2, '点击在弹窗世界 ⇒ 至少两条效果（激活 + 弹窗消失）')
  assert.ok(fx.some(f => f.includes('激活元素「允许」')), JSON.stringify(fx))
  assert.ok(fx.some(f => f.includes('弹窗') && f.includes('权限确认')), '弹窗在场 ⇒ 效果清单提及弹窗消失')
  // scroll 方向词入账
  const up = scoreOptions([act('scroll', { payload: { direction: 'up' } })], ctx())
  assert.ok(up)
  assert.ok(up.chosen.predictedEffects.some(f => f.includes('上')), '向上滚动 ⇒ 效果含「上」')
  const down = scoreOptions([act('scroll')], ctx())
  assert.ok(down)
  assert.ok(down.chosen.predictedEffects.some(f => f.includes('下')), '缺省方向 ⇒ 效果含「下」')
  // inspect 聚焦区坐标入账
  const insp = scoreOptions(
    [act('inspect')],
    ctx({ snapshot: snap({ focusedRegion: { x0: 10, y0: 20, x1: 30, y1: 40 } }) }),
  )
  assert.ok(insp)
  assert.ok(insp.chosen.predictedEffects.some(f => f.includes('放大细察') && f.includes('10,20')))
  // 无标签点击仍有非空清单
  const bare = scoreOptions([act('click')], ctx())
  assert.ok(bare)
  assert.ok(bare.chosen.predictedEffects.length >= 1)
  assert.ok(bare.chosen.predictedEffects.every(f => typeof f === 'string' && f.length > 0))
  // 陌生点击目标 ⇒ 清单记「未见于快照账本」
  const stranger = scoreOptions([act('click', { target: tgt('神秘入口') })], ctx({ snapshot: snap({ elements: [elem('登录')] }) }))
  assert.ok(stranger)
  assert.ok(stranger.chosen.predictedEffects.some(f => f.includes('未见于当前快照账本')))
})

// ─── Φ-9-11 脏输入防御与纯度 ───

test('Φ-9-11: 脏输入防御与纯度 —— 绝不抛异常、不改输入、同入同出', () => {
  const s = snap({ elements: [elem('登录')] })
  const c = ctx({ goalKeywords: ['登录'], snapshot: s })
  const a = act('click', { target: tgt('登录') })
  const b = act('scroll')
  const before = JSON.stringify({ a, b, c })
  let plan1: CounterfactualPlan | null = null
  let plan2: CounterfactualPlan | null = null
  assert.doesNotThrow(() => { plan1 = scoreOptions([a, b], c) })
  assert.doesNotThrow(() => { plan2 = scoreOptions([a, b], c) })
  assert.ok(plan1)
  assert.ok(plan2)
  assert.deepEqual(plan1, plan2, '同输入同输出（确定性可回放）')
  assert.equal(JSON.stringify({ a, b, c }), before, '输入对象未被改动')
  // 脏 ctx：整体缺席仍可评分（空快照兜底 ⇒ label 视为陌生 +0.1；零关键词 ⇒ progress 0）
  const out: { plan: CounterfactualPlan | null } = { plan: null }
  assert.doesNotThrow(() => { out.plan = scoreOptions([a], null as unknown as ScoringContext) })
  assert.ok(out.plan)
  assert.equal(out.plan.chosen.informationGain, 0.4, '空快照账本 ⇒ click label 全陌生')
  assert.equal(out.plan.chosen.progressProbability, 0)
  assert.ok(out.plan.chosen.predictedEffects.length >= 1)
  // rejected 理由恒为非空中文一句
  const multi = scoreOptions([a, b, act('ask_vlm')], c)
  assert.ok(multi)
  assert.equal(multi.rejected.length, 2)
  for (const r of multi.rejected) {
    assert.equal(typeof r.why, 'string')
    assert.ok(r.why.length > 0 && /[\u4e00-\u9fff]/.test(r.why), `落选理由应含中文：${r.why}`)
  }
})

// ─── ΝΩ-10：infoGain 新鲜度两臂 + 效用权重内核三键 ───

test('ΝΩ-10: infoGain 新鲜度两臂 —— noEffectActionKeys 在场时 从未点过 +0.15 / 点过且 no_effect −0.1；缺席走旧值', () => {
  const s = snap({ elements: [elem('登录'), elem('设置')] })
  const clickLogin = act('click', { target: tgt('登录') })
  const clickSetting = act('click', { target: tgt('设置') })
  // 臂一：从未点过（tried 空集 + noEffect 空集在场）⇒ 已见账本 0.3 + 0.15 = 0.45
  const fresh = scoreOptions([clickLogin], ctx({ snapshot: s, noEffectActionKeys: [] }))
  assert.ok(fresh)
  close(fresh.chosen.informationGain, 0.45) // 从未点过的已见标签 ⇒ 0.3+0.15
  // 从未点过的陌生标签 ⇒ 0.4 + 0.15 = 0.55
  const stranger = scoreOptions(
    [act('click', { target: tgt('神秘入口') })],
    ctx({ snapshot: s, noEffectActionKeys: [] }),
  )
  assert.ok(stranger)
  close(stranger.chosen.informationGain, 0.55)
  // 臂二：点过且结局 no_effect ⇒ 0.3 − 0.1 = 0.2（progress 侧 ×0.6 折价另记账：0.2×… 不影响本断言）
  const stale = scoreOptions(
    [clickLogin],
    ctx({ snapshot: s, triedActionKeys: ['click:登录'], noEffectActionKeys: ['click:登录'] }),
  )
  assert.ok(stale)
  close(stale.chosen.informationGain, 0.2) // 点过且 no_effect ⇒ 0.3−0.1
  // 点过但结局非 no_effect ⇒ 基线不修正（信息侧不与 progress 重复折价）
  const triedOk = scoreOptions(
    [clickSetting],
    ctx({ snapshot: s, triedActionKeys: ['click:设置'], noEffectActionKeys: ['click:登录'] }),
  )
  assert.ok(triedOk)
  close(triedOk.chosen.informationGain, 0.3) // 点过且有进展 ⇒ 基线 0.3
  // 缺席走旧值：noEffectActionKeys 未给 ⇒ tried click 恒 0.1（Φ-9-2 旧律逐字节保留）
  const legacy = scoreOptions(
    [clickLogin],
    ctx({ snapshot: s, triedActionKeys: ['click:登录'] }),
  )
  assert.ok(legacy)
  assert.equal(legacy.chosen.informationGain, 0.1)
  // 未给 noEffectActionKeys 的未点过 click ⇒ 旧值 0.3（零漂移）
  const legacyFresh = scoreOptions([clickLogin], ctx({ snapshot: s }))
  assert.ok(legacyFresh)
  close(legacyFresh.chosen.informationGain, 0.3)
})

test('ΝΩ-10: expectedInformationGain 第三参 —— freshness 缺席旧值逐字节不变；在场两臂；非 click 种类不受影响', () => {
  const s = snap({ elements: [elem('登录')] })
  const clickLogin = act('click', { target: tgt('登录') })
  const clickStranger = act('click', { target: tgt('神秘入口') })
  // 缺席 ⇒ 旧值（Φ-9-7 已覆盖的基线在此复证：不抛、不漂）
  assert.equal(expectedInformationGain(clickLogin, s), 0.3)
  assert.equal(expectedInformationGain(clickStranger, s), 0.4)
  assert.equal(expectedInformationGain(clickLogin, s, undefined), 0.3, '显式 undefined = 缺席')
  // 在场两臂
  const neverClicked: ClickFreshness = { triedClickKeys: new Set<string>(), noEffectClickKeys: new Set<string>() }
  close(expectedInformationGain(clickLogin, s, neverClicked), 0.45)
  close(expectedInformationGain(clickStranger, s, neverClicked), 0.55)
  const clickedNoEffect: ClickFreshness = {
    triedClickKeys: new Set([actionSignature(clickLogin)]),
    noEffectClickKeys: new Set([actionSignature(clickLogin)]),
  }
  close(expectedInformationGain(clickLogin, s, clickedNoEffect), 0.2)
  close(expectedInformationGain(clickStranger, s, clickedNoEffect), 0.55) // no_effect 只折自己，不殃及他人
  const clickedProgressed: ClickFreshness = {
    triedClickKeys: new Set([actionSignature(clickLogin)]),
    noEffectClickKeys: new Set<string>(),
  }
  close(expectedInformationGain(clickLogin, s, clickedProgressed), 0.3)
  // 非 click 种类不吃新鲜度
  assert.equal(expectedInformationGain(act('scroll'), s, neverClicked), 0.8)
  assert.equal(expectedInformationGain(act('hotkey'), s, clickedNoEffect), 0.2)
  // 脏 freshness（null）按缺席记 —— 绝不抛
  assert.equal(expectedInformationGain(clickLogin, s, null as unknown as ClickFreshness), 0.3)
})

test('ΝΩ-10: 效用权重内核三键 —— 入册缺省=现行字面量零漂移；set 覆写择优翻盘；ctx.weights 显式入参仍最高优先；越界夹回', () => {
  resetKernelRuntime()
  try {
    const s = snap({ elements: [elem('打开设置面板确认')] })
    const kw = ['打开', '设置', '面板', '确认']
    const a = act('click', { target: tgt('打开设置面板确认') }) // 1.0 / 0.3 / 0.05
    const b = act('scroll') // 0.25 / 0.8 / 0.05
    // 未注册 ⇒ getOrDefault 回声字面量 ⇒ 与 Φ-9-9 缺省基准同判（click 胜）
    const base = scoreOptions([a, b], ctx({ goalKeywords: kw, snapshot: s }))
    assert.ok(base)
    assert.equal(base.chosen.action.kind, 'click', '未注册 ⇒ 缺省 0.5/0.3/0.2 ⇒ click（零漂移）')

    // 入册（与 policy.tieGap 同律；缺省 = DEFAULT_WEIGHTS 现行字面量）
    registerProductionKernels()
    assert.equal(kernelRegistry.getOrDefault('policy.progressWeight', -1), 0.5)
    assert.equal(kernelRegistry.getOrDefault('policy.infoWeight', -1), 0.3)
    assert.equal(kernelRegistry.getOrDefault('policy.riskWeight', -1), 0.2)
    const unchanged = scoreOptions([a, b], ctx({ goalKeywords: kw, snapshot: s }))
    assert.ok(unchanged)
    assert.equal(unchanged.chosen.action.kind, 'click', '入册即缺省 ⇒ 判决仍与未注册逐字节同判')

    // set 覆写 ⇒ 择优翻盘：progress 0.1 / info 0.8 ⇒ U_a 0.33 < U_b 0.655 ⇒ scroll
    assert.equal(kernelRegistry.set('policy.progressWeight', 0.1).ok, true)
    assert.equal(kernelRegistry.set('policy.infoWeight', 0.8).ok, true)
    const flipped = scoreOptions([a, b], ctx({ goalKeywords: kw, snapshot: s }))
    assert.ok(flipped)
    assert.equal(flipped.chosen.action.kind, 'scroll', '内核键压低进展权重后择优随内核翻转')

    // 调用方显式 weights 压过内核键（缺省缝不越权覆盖显式入参）
    const explicit = scoreOptions(
      [a, b],
      ctx({ goalKeywords: kw, snapshot: s, weights: { progress: 0.9, info: 0.1, risk: 0.2 } }),
    )
    assert.ok(explicit)
    assert.equal(explicit.chosen.action.kind, 'click', 'ctx.weights 显式入参最高优先')

    // 越界夹回 [0,1]（set 是夹取不是失败）
    assert.deepEqual(kernelRegistry.set('policy.infoWeight', 9), { ok: true, reason: 'clamped', clampedTo: 1 })
  } finally {
    resetKernelRuntime()
  }
})

// ─── ΝΩ-46（model-based 反事实）：转移置信因子 + 只读端口 + 键方言对齐 ───

test('ΝΩ-46: 转移置信因子 —— 高置信×1.0 加权、低置信×0.5 衰减、无证据×1.0 中性；缺席逐字节旧值', () => {
  wireCounterfactualWorldModel(null) // 本测全走 ctx 显式注入（模块默认隔离前置）
  const kw = ['甲乙', '丙丁'] // 2-gram 关键词（分词方言：中文连续段按 2-gram 切分）
  const s = wmSnap([elem('甲乙丙丁')])
  const key = (cell: string): string => `${quantizedScreenTypeOf(WM_DHASH)}|click@${cell}`
  // 缺席（基准）：progress = 先验 1.0；U = 0.5 + 0.09 − 0.01 = 0.58（Φ-9-9 同律手算）
  const absent = scoreOptions([clickAtCell('22', '甲乙丙丁')], ctx({ goalKeywords: kw, snapshot: s }))
  assert.ok(absent)
  close(absent.chosen.progressProbability, 1)
  const absentRank = rankTopK([clickAtCell('22', '甲乙丙丁')], ctx({ goalKeywords: kw, snapshot: s }), 1)
  assert.ok(absentRank)
  closeMsg(absentRank[0].utility, 0.58, '端口缺席 ⇒ 效用逐字节旧值')
  // 端口在场、三臂：命中高置信（prob 1 ⇒ ×1.0）/ 低置信（prob 0 ⇒ ×0.5）/ 无证据（⇒ ×1.0 中性）
  const port = portOf({ [key('22')]: 0, [key('33')]: 1, [key('00')]: 0.5 })
  const at = (cell: string): number => {
    const plan = scoreOptions([clickAtCell(cell, '甲乙丙丁')], ctx({ goalKeywords: kw, snapshot: s, worldModel: port }))
    assert.ok(plan)
    return plan.chosen.progressProbability
  }
  closeMsg(at('33'), 1, 'prob=1 ⇒ ×(0.5+0.5) = ×1.0（纯加权不放大）')
  closeMsg(at('22'), 0.5, 'prob=0 ⇒ ×(0.5+0) = ×0.5（衰减）')
  closeMsg(at('00'), 0.75, 'prob=0.5 ⇒ ×0.75')
  closeMsg(at('11'), 1, '无证据（no-model）⇒ ×1.0 中性（模型无知不惩罚新探索）')
  // 空表端口（在场但全无证据）⇒ 效用与缺席逐字节相同
  const emptyPortRank = rankTopK(
    [clickAtCell('22', '甲乙丙丁')], ctx({ goalKeywords: kw, snapshot: s, worldModel: portOf({}) }), 1,
  )
  assert.ok(emptyPortRank)
  closeMsg(emptyPortRank[0].utility, 0.58, '端口在场而无证据 ⇒ 与缺席逐字节同值')
})

test('ΝΩ-46: 高置信加权改变排序 —— 低先验×高置信胜过高先验×低置信（效用翻盘）', () => {
  wireCounterfactualWorldModel(null)
  // 分词方言：kw 2-gram；「甲乙丙丁戊己」∩ 3/4 = 0.75（高先验）、「甲乙丙丁」∩ 2/4 = 0.5（低先验）
  const kw = ['甲乙', '丙丁', '戊己', '庚辛']
  const s = wmSnap([elem('甲乙丙丁戊己'), elem('甲乙丙丁')])
  const key = (cell: string): string => `${quantizedScreenTypeOf(WM_DHASH)}|click@${cell}`
  const fav = clickAtCell('22', '甲乙丙丁戊己') // 先验 3/4 = 0.75；格 22 低置信（prob 0）
  const underdog = clickAtCell('33', '甲乙丙丁') // 先验 2/4 = 0.5；格 33 高置信（prob 1）
  // 缺席：U_fav = 0.375+0.09−0.01 = 0.455 > U_underdog = 0.25+0.09−0.01 = 0.33 ⇒ fav 胜
  const base = scoreOptions([fav, underdog], ctx({ goalKeywords: kw, snapshot: s }))
  assert.ok(base)
  assert.equal(base.chosen.action.target?.label, '甲乙丙丁戊己', '端口缺席 ⇒ 高先验者胜（旧律）')
  // 端口在场：U_fav = 0.375×0.5+0.08 = 0.2675 < U_underdog = 0.33（差 0.0625 > 并列阈）⇒ 翻盘
  const port = portOf({ [key('22')]: 0, [key('33')]: 1 })
  const flipped = scoreOptions([fav, underdog], ctx({ goalKeywords: kw, snapshot: s, worldModel: port }))
  assert.ok(flipped)
  assert.equal(flipped.chosen.action.target?.label, '甲乙丙丁', '历史证据置信进评分 ⇒ 排序翻转')
  closeMsg(flipped.chosen.progressProbability, 0.5, '胜者 progress = 先验 0.5 × 1.0（高置信不放大只保先验）')
  closeMsg(flipped.rejected[0].option.progressProbability, 0.375, '落选者 progress = 先验 0.75 × 0.5（低置信衰减）')
})

test('ΝΩ-46: 辖制面 —— 非 click 种类 / 盲屏（无 dhash）/ 无落点 click 一律中性；脏端口绝不抛', () => {
  wireCounterfactualWorldModel(null)
  const kw = ['甲乙', '丙丁']
  const key = (cell: string): string => `${quantizedScreenTypeOf(WM_DHASH)}|click@${cell}`
  // 全零置信端口：若辖制越界会立刻改变读数 —— 逐项断言不动
  const zeroPort = portOf({ [key('22')]: 0, scroll: 0, click: 0 })
  // 非 click：scroll 先验 0.25 不受模型影响
  const scroll = scoreOptions([act('scroll')], ctx({ snapshot: wmSnap(), worldModel: zeroPort }))
  assert.ok(scroll)
  closeMsg(scroll.chosen.progressProbability, 0.25, 'scroll 不受转移置信辖制')
  // 盲屏（dhash 缺席）⇒ 无屏型身份不可对键 ⇒ 中性
  const blind = scoreOptions(
    [clickAtCell('22', '甲乙丙丁')], ctx({ goalKeywords: kw, snapshot: snap(), worldModel: zeroPort }),
  )
  assert.ok(blind)
  closeMsg(blind.chosen.progressProbability, 1, '盲屏 ⇒ ×1.0 中性')
  // 无落点 click（无 target ⇒ 动作键无格）⇒ 中性
  const noTarget = scoreOptions(
    [act('click', { expectedEffect: '甲乙丙丁' })], ctx({ goalKeywords: kw, snapshot: wmSnap(), worldModel: zeroPort }),
  )
  assert.ok(noTarget)
  closeMsg(noTarget.chosen.progressProbability, 1, '无落点 ⇒ 无格不可对键 ⇒ 中性')
  // 脏端口（抛异常 / 坏形状 / 无概率读数）⇒ 中性且绝不抛
  const bombs: WorldModelReadPort[] = [
    { predict: () => { throw new Error('boom') } },
    { predict: () => null as unknown as ReturnType<WorldModelReadPort['predict']> },
    { predict: () => ({ top: null }) },
    { predict: () => ({ top: { typeId: 'x' } as unknown as { typeId: string; prob: number } }) },
    { predict: () => ({ top: { typeId: 'x', prob: Number.NaN } }) },
  ]
  for (const bomb of bombs) {
    // 对象包裹赋值（Φ-9-11 同法）：闭包内赋值不被 TS 收窄为 null
    const out: { plan: CounterfactualPlan | null } = { plan: null }
    assert.doesNotThrow(() => {
      out.plan = scoreOptions(
        [clickAtCell('22', '甲乙丙丁')], ctx({ goalKeywords: kw, snapshot: wmSnap(), worldModel: bomb }),
      )
    }, '脏端口绝不炸评分')
    assert.ok(out.plan)
    closeMsg(out.plan.chosen.progressProbability, 1, '端口故障 = 无知识 ⇒ 中性')
  }
})

test('ΝΩ-46: 键方言与 prophecy 单源对齐 —— 同屏同键（量化屏型 × 4×4 动作格，含档位旋钮同格）', () => {
  try {
    // 屏型量化：两侧逐字节同律（hex 方言量化、非 hex 原样、空串/短串不炸）
    for (const fp of [WM_DHASH, 'ffffffffffffffff', 'AAA', '', '1234567890abcde', 'feedface00112233']) {
      assert.equal(quantizedScreenTypeOf(fp), quantizedScreenType(fp), `屏型方言对齐：${fp}`)
    }
    assert.equal(quantizedScreenTypeOf(WM_DHASH), '1234567890ab0000', '缺省档位 12 ⇒ 低位 4 字掩没')
    // 动作键：两侧逐字节同律（格点 / 无落点 / 坏几何 / 垃圾动作）
    const c = clickAtCell('00', '甲')
    for (const [w, h] of [[1920, 1080], [3840, 2160], [0, 0]] as const) {
      assert.equal(transitionActionKeyOf(c, w, h), prophecyActionKey(c, w, h), `动作键方言对齐：${w}×${h}`)
    }
    assert.equal(transitionActionKeyOf(null, 1920, 1080), prophecyActionKey(null, 1920, 1080), '垃圾动作同回退')
    // 端到端：scoreAll 实际发出的 predict 键 === prophecy 方言铸出的（fromType|actionKey）
    const seen: string[] = []
    const spy: WorldModelReadPort = { predict: (f, k) => { seen.push(`${f}|${k}`); return { top: null } } }
    scoreOptions([clickAtCell('00', '甲乙丙丁')], ctx({ snapshot: wmSnap(), worldModel: spy }))
    assert.deepEqual(
      seen,
      [`${quantizedScreenType(WM_DHASH)}|${prophecyActionKey(clickAtCell('00', '甲乙丙丁'), 1920, 1080)}`],
      '同屏同键：评分读键 === prophecy 写键方言（click@00）',
    )
    // 档位旋钮同格：内核键拧到 10 ⇒ 两侧同变（键域不漂 —— 同一内核键的单源对齐）
    kernelRegistry.register({
      key: PROPHECY_QUANT_KERNEL_KEY, organ: 'arbitration', defaultValue: 10, min: 8, max: 16,
      note: 'ΝΩ-46 测试：量化档位同格断言',
    })
    assert.equal(quantizedScreenTypeOf(WM_DHASH), '1234567890000000', '档位 10 ⇒ 上 10 字保留')
    assert.equal(quantizedScreenTypeOf(WM_DHASH), quantizedScreenType(WM_DHASH), '档位拧动后两侧仍同格')
    seen.length = 0
    scoreOptions([clickAtCell('00', '甲乙丙丁')], ctx({ snapshot: wmSnap(), worldModel: spy }))
    assert.ok(seen[0].startsWith('1234567890000000|'), '评分读键随档位同变（与 prophecy 同键）')
  } finally {
    resetKernelRuntime()
  }
})

test('ΝΩ-46: 模块默认接线 —— wire 注入对缺席字段兜底；显式 ctx.worldModel 压过默认；wire(null) 复位旧路', () => {
  try {
    const kw = ['甲乙', '丙丁']
    const s = wmSnap([elem('甲乙丙丁')])
    const key22 = `${quantizedScreenTypeOf(WM_DHASH)}|click@22`
    // 前置：未接线 ⇒ 旧值（progress 1.0）
    assert.equal(counterfactualWorldModelWired(), false, '前置未接线')
    const base = scoreOptions([clickAtCell('22', '甲乙丙丁')], ctx({ goalKeywords: kw, snapshot: s }))
    assert.ok(base)
    close(base.chosen.progressProbability, 1)
    // 模块默认：低置信注入 ⇒ 不带 ctx.worldModel 的调用也吃到因子
    wireCounterfactualWorldModel(portOf({ [key22]: 0 }))
    assert.equal(counterfactualWorldModelWired(), true, '接线后在册')
    const viaDefault = scoreOptions([clickAtCell('22', '甲乙丙丁')], ctx({ goalKeywords: kw, snapshot: s }))
    assert.ok(viaDefault)
    closeMsg(viaDefault.chosen.progressProbability, 0.5, '模块默认对缺席字段兜底（决策面调用点由此吃到模型）')
    // 显式注入压过默认：ctx.worldModel = 高置信 ⇒ ×1.0
    const explicit = scoreOptions(
      [clickAtCell('22', '甲乙丙丁')],
      ctx({ goalKeywords: kw, snapshot: s, worldModel: portOf({ [key22]: 1 }) }),
    )
    assert.ok(explicit)
    closeMsg(explicit.chosen.progressProbability, 1, '显式 ctx.worldModel 最高优先')
    // 复位 ⇒ 逐字节旧路
    wireCounterfactualWorldModel(null)
    assert.equal(counterfactualWorldModelWired(), false, '复位后不在册')
    const reset = scoreOptions([clickAtCell('22', '甲乙丙丁')], ctx({ goalKeywords: kw, snapshot: s }))
    assert.ok(reset)
    closeMsg(reset.chosen.progressProbability, 1, 'wire(null) ⇒ 逐字节旧路')
    // 脏端口按清除记（防御式）
    wireCounterfactualWorldModel({} as WorldModelReadPort)
    assert.equal(counterfactualWorldModelWired(), false, '无 predict 面的脏端口按清除记')
  } finally {
    wireCounterfactualWorldModel(null)
  }
})

test('ΝΩ-46: transitionConfidenceFactor 直测 —— 端口/快照/动作三缺席臂与因子数值', () => {
  const key22 = `${quantizedScreenTypeOf(WM_DHASH)}|click@22`
  const s = wmSnap()
  assert.equal(transitionConfidenceFactor(null, s, clickAtCell('22', '甲')), 1, '端口缺席 ⇒ 1')
  assert.equal(transitionConfidenceFactor(portOf({ [key22]: 0 }), null, clickAtCell('22', '甲')), 1, '快照缺席（盲屏）⇒ 1')
  assert.equal(transitionConfidenceFactor(portOf({ scroll: 0 }), s, act('scroll')), 1, '非 click ⇒ 1')
  assert.equal(transitionConfidenceFactor(portOf({ [key22]: 1 }), s, clickAtCell('22', '甲')), 1, 'prob=1 ⇒ 0.5+0.5')
  closeMsg(transitionConfidenceFactor(portOf({ [key22]: 0.5 }), s, clickAtCell('22', '甲')), 0.75, 'prob=0.5 ⇒ 0.75')
  closeMsg(transitionConfidenceFactor(portOf({ [key22]: 0 }), s, clickAtCell('22', '甲')), 0.5, 'prob=0 ⇒ 0.5')
  closeMsg(transitionConfidenceFactor(portOf({ [key22]: 2 }), s, clickAtCell('22', '甲')), 1, '越界 prob 夹回 ⇒ 1')
  closeMsg(transitionConfidenceFactor(portOf({ [key22]: -3 }), s, clickAtCell('22', '甲')), 0.5, '负 prob 夹回 ⇒ 0.5')
  assert.equal(transitionConfidenceFactor(portOf({ [key22]: 0 }), s, null as unknown as PolicyAction), 1, '脏动作 ⇒ 1 不抛')
})

