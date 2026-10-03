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
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreOptions,
  expectedInformationGain,
  actionSignature,
  type CounterfactualPlan,
  type ScoringContext,
} from '../src/autonomy/counterfactual.ts';
import type { AutonomyActionKind, PolicyAction } from '../src/autonomy/policyEngine.ts';
import type { SnapshotElement, WorldSnapshot } from '../src/autonomy/worldSnapshot.ts';

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

/** 评分上下文工厂 —— goalKeywords/snapshot 缺省为空，tried/weights 按需注入 */
function ctx(o: {
  goalKeywords?: string[]
  snapshot?: WorldSnapshot
  triedActionKeys?: string[]
  weights?: ScoringContext['weights']
} = {}): ScoringContext {
  return {
    goalKeywords: o.goalKeywords ?? [],
    snapshot: o.snapshot ?? snap(),
    ...(o.triedActionKeys !== undefined ? { triedActionKeys: o.triedActionKeys } : {}),
    ...(o.weights !== undefined ? { weights: o.weights } : {}),
  }
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
