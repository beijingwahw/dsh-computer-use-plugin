// test/vlm.arbitration.test.ts
// 纪元 Ω（Ω-9 仲裁器官）：执法册 —— IoU 测度 / 融合凸组合三案例 / winner 四分支 /
// Levenshtein / 文本仲裁三分支 / 退化边界与纯度执法。纯离线，零网络零 sharp。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 浮点断言：容差式比较（融合置信含 0.15 等非二进制小数，拒绝逐位巧合）
const close = (actual: number, expected: number, tol = 1e-9, msg?: string) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ? msg + '：' : ''}期望 ${actual} ≈ ${expected}（容差 ${tol}）`)

// GroundedElement 形状便捷构造（兄弟模块契约：id/label/role/bbox/center/confidence/source）
const ve = (id: string, label: string, box: [number, number, number, number], confidence: number) => ({
  id,
  label,
  role: 'button' as const,
  bbox: { x0: box[0], y0: box[1], x1: box[2], y1: box[3] },
  center: { x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2 },
  confidence,
  source: 'vlm' as const,
})
// LocalElement 便捷构造
const le = (label: string, box: [number, number, number, number], confidence: number) => ({
  label,
  bbox: { x0: box[0], y0: box[1], x1: box[2], y1: box[3] },
  confidence,
})

// ─── Ω-9-1 IoU：二维 Jaccard 测度全谱 ───

test('Ω-9-1: iou —— 相交/包含/相离/恒等/贴边/退化零面积', async () => {
  const { iou } = await import('../src/vlm/arbitration.ts')
  const A = { x0: 0, y0: 0, x1: 10, y1: 10 }
  close(iou(A, { x0: 5, y0: 5, x1: 15, y1: 15 }), 25 / 175, 1e-12) // 相交：交 25 / 并 175
  close(iou({ x0: 2, y0: 2, x1: 4, y1: 4 }, { x0: 0, y0: 0, x1: 8, y1: 8 }), 4 / 64, 1e-12) // 包含：小/大
  assert.equal(iou(A, { x0: 20, y0: 20, x1: 30, y1: 30 }), 0, '相离 ⇒ 0')
  assert.equal(iou(A, { x0: 10, y0: 0, x1: 20, y1: 10 }), 0, '贴边 = 零交 = 相离')
  assert.equal(iou(A, { x0: 0, y0: 0, x1: 10, y1: 10 }), 1, '恒等 ⇒ 1')
  assert.equal(iou({ x0: 5, y0: 5, x1: 5, y1: 5 }, { x0: 5, y0: 5, x1: 5, y1: 5 }), 1, '退化点重合 ⇒ 1（0/0 约定）')
  assert.equal(iou({ x0: 5, y0: 5, x1: 5, y1: 5 }, { x0: 6, y0: 6, x1: 6, y1: 6 }), 0, '退化点异位 ⇒ 0')
})

// ─── Ω-9-2 融合案例一：恒等框 ⇒ 等权凸组合 + 双源一致加成 ───

test('Ω-9-2: 融合一 —— 恒等框：等权凸组合还原原框，conf=(cv+cl)/2+0.15', async () => {
  const { arbitrateElements } = await import('../src/vlm/arbitration.ts')
  const r = arbitrateElements([ve('v1', '登录', [0, 0, 100, 50], 0.8)], [le('登录', [0, 0, 100, 50], 0.8)])
  assert.equal(r.elements.length, 1, '一对一 ⇒ 恰一元素')
  const e = r.elements[0]
  assert.deepEqual(e.bbox, { x0: 0, y0: 0, x1: 100, y1: 50 }, '0.5/0.5 等权 × 恒等框 ⇒ 原框')
  assert.deepEqual(e.center, { x: 50, y: 25 }, '融合中心 = 融合框中点')
  assert.equal(e.source, 'fusion')
  assert.equal(e.agreesWith, 'both')
  assert.equal(e.label, '登录')
  close(e.confidence, 0.95, 1e-9) // (0.8+0.8)/2 + 0.15
  assert.equal(r.winner, 'fusion', '1 融合对 ≥ 0.3×0 单源线')
  assert.ok(r.rationale.length > 0, '裁决理由非空')
})

// ─── Ω-9-3 融合案例二：非对称置信 ⇒ 加权凸组合 + label 归高置信侧 ───

test('Ω-9-3: 融合二 —— cv=0.25/cl=0.75：bbox 逐坐标按 cv:cl 加权，label 归 local', async () => {
  const { arbitrateElements } = await import('../src/vlm/arbitration.ts')
  const v = ve('v1', 'Sign in', [0, 0, 100, 100], 0.25)
  const l = le('登录', [4, 0, 104, 100], 0.75) // IoU = 9600/10400 ≈ 0.923 ≥ 0.5
  const r = arbitrateElements([v], [l])
  const e = r.elements[0]
  // 凸组合（全二进制小数，逐位精确）：x0 = 0×0.25 + 4×0.75 = 3；x1 = 100×0.25 + 104×0.75 = 103
  assert.deepEqual(e.bbox, { x0: 3, y0: 0, x1: 103, y1: 100 }, '加权凸组合')
  assert.deepEqual(e.center, { x: 53, y: 50 }, '中心 = 融合框中点')
  assert.equal(e.label, '登录', 'label 取置信高者（local 0.75 > vlm 0.25）')
  assert.equal(e.source, 'fusion')
  close(e.confidence, 0.65, 1e-9) // (0.25+0.75)/2 + 0.15
  // 平票律的镜像：cv=cl ⇒ label 归 VLM（语义更强）
  const t = arbitrateElements([ve('v', 'Cloud', [0, 0, 10, 10], 0.5)], [le('本地', [0, 0, 10, 10], 0.5)])
  assert.equal(t.elements[0].label, 'Cloud', '置信平票 ⇒ label 归 VLM')
})

// ─── Ω-9-4 融合案例三：置信封顶 + iouThreshold 选项 + 贪心一对一 ───

test('Ω-9-4: 融合三 —— min(1,·) 封顶、阈值选项、IoU 降序贪心一对一', async () => {
  const { arbitrateElements } = await import('../src/vlm/arbitration.ts')
  // 封顶：cv=cl=0.9、bonus=0.5 ⇒ 0.9+0.5=1.4 ⇒ 恰为 1（绝不过界）
  const cap = arbitrateElements([ve('v', 'x', [0, 0, 10, 10], 0.9)], [le('x', [0, 0, 10, 10], 0.9)], { agreementBonus: 0.5 })
  assert.equal(cap.elements[0].confidence, 1, '融合置信封顶于 1')
  // 阈值选项：IoU = 50/150 = 1/3 < 默认 0.5 不融；降到 0.3 ⇒ 融
  const v = ve('v', 'a', [0, 0, 10, 10], 0.9)
  const l = le('b', [5, 0, 15, 10], 0.9)
  assert.equal(arbitrateElements([v], [l]).elements.filter((x) => x.source === 'fusion').length, 0, '默认 0.5 线下不融')
  assert.equal(arbitrateElements([v], [l], { iouThreshold: 0.3 }).elements[0].source, 'fusion', '0.3 线下融合')
  // 贪心一对一：local (0,0,10,10) 同时与 best(IoU=1)、next(IoU=0.6) 达线 ⇒ 只配最优
  const g = arbitrateElements([ve('b', 'best', [0, 0, 10, 10], 0.9), ve('n', 'next', [0, 0, 10, 6], 0.9)], [le('L', [0, 0, 10, 10], 0.9)])
  const fused = g.elements.filter((x) => x.source === 'fusion')
  assert.equal(fused.length, 1, 'local 只被消费一次（一对一）')
  assert.equal(fused[0].label, 'best', 'IoU=1 者胜出配对')
  assert.equal(g.elements.filter((x) => x.source === 'vlm').length, 1, '次优 vlm 沦为单源')
})

// ─── Ω-9-5 winner 四分支 ───

test('Ω-9-5: winner —— fusion 线 / vlm 多 / local 多 / 平票归 VLM', async () => {
  const { arbitrateElements } = await import('../src/vlm/arbitration.ts')
  // 分支① fusion：1 对融合 ≥ max(1,1) 单源的 30% 线（1×10 ≥ 1×3）
  const mix = arbitrateElements(
    [ve('v1', 'a', [0, 0, 10, 10], 0.9), ve('v2', 'b', [100, 100, 110, 110], 0.5)],
    [le('a', [0, 0, 10, 10], 0.9), le('c', [200, 200, 210, 210], 0.5)],
  )
  assert.equal(mix.winner, 'fusion', '1 融合对 ≥ 30%×1')
  assert.deepEqual(mix.elements.map((x) => x.source), ['fusion', 'vlm', 'local'], 'vlm 序在前、本地单源殿后')
  // 分支② vlm：无融合，2 > 1
  assert.equal(
    arbitrateElements(
      [ve('v1', 'a', [0, 0, 10, 10], 0.9), ve('v2', 'b', [100, 100, 110, 110], 0.9)],
      [le('c', [200, 200, 210, 210], 0.9)],
    ).winner,
    'vlm',
    'vlm 元素多 ⇒ vlm 胜',
  )
  // 分支③ local：无融合，1 < 2
  assert.equal(
    arbitrateElements(
      [ve('v1', 'a', [0, 0, 10, 10], 0.9)],
      [le('c', [200, 200, 210, 210], 0.9), le('d', [300, 300, 310, 310], 0.9)],
    ).winner,
    'local',
    'local 元素多 ⇒ local 胜',
  )
  // 分支④ 平票：1 vlm vs 1 local 相离 ⇒ VLM 语义更强
  assert.equal(
    arbitrateElements([ve('v1', 'a', [0, 0, 10, 10], 0.9)], [le('c', [200, 200, 210, 210], 0.9)]).winner,
    'vlm',
    '平票归 VLM',
  )
  // 平票 + 融合未达线：5v5 其中 1 对融合 ⇒ 1×10 < 4×3 ⇒ 仍按平票归 VLM
  const vs = Array.from({ length: 5 }, (_, i) => ve(`v${i}`, `a${i}`, [i * 60, 0, i * 60 + 10, 10], 0.9))
  const ls = [
    le('a0', [0, 0, 10, 10], 0.9), // 与 vs[0] 恒等 ⇒ 唯一融合对
    ...Array.from({ length: 4 }, (_, i) => le(`c${i}`, [500 + i * 60, 0, 510 + i * 60, 10], 0.9)),
  ]
  assert.equal(arbitrateElements(vs, ls).winner, 'vlm', '1 融合对 < 4×30% 线 ⇒ 5=5 平票归 VLM')
})

// ─── Ω-9-6 归一化 Levenshtein ───

test('Ω-9-6: normalizedLevenshtein —— 恒等/经典对/前缀/全异/空串族', async () => {
  const { normalizedLevenshtein } = await import('../src/vlm/arbitration.ts')
  assert.equal(normalizedLevenshtein('password', 'password'), 1, '恒等 ⇒ 1')
  close(normalizedLevenshtein('kitten', 'sitting'), 4 / 7, 1e-12) // 经典距离 3 / max 7
  close(normalizedLevenshtein('abc', 'abcd'), 3 / 4, 1e-12) // 前缀：距离 1 / max 4
  assert.equal(normalizedLevenshtein('abc', 'xyz'), 0, '等长全异 ⇒ 0')
  assert.equal(normalizedLevenshtein('', ''), 1, '双空恒等 ⇒ 1')
  assert.equal(normalizedLevenshtein('', 'abc'), 0, '单侧空 ⇒ 0')
})

// ─── Ω-9-7 文本仲裁三分支 ───

test('Ω-9-7: arbitrateText —— 相似融合/分歧归 VLM/单侧空取非空/双空恒等', async () => {
  const { arbitrateText } = await import('../src/vlm/arbitration.ts')
  // ① 相似：'Continue' vs 'ContinuE' 距离 1 / max 8 = 0.875 ≥ 0.8 ⇒ fusion，取 vlm 文本
  const a = arbitrateText('Continue', 'ContinuE')
  assert.equal(a.source, 'fusion')
  assert.equal(a.text, 'Continue', '融合取 vlm 文本')
  close(a.similarity, 0.875, 1e-12)
  // 阈值升至 0.9 ⇒ 0.875 落回单源分支
  assert.equal(arbitrateText('Continue', 'ContinuE', { similarityThreshold: 0.9 }).source, 'vlm', '阈值选项改判')
  // ② 分歧且双非空：无共享字符 ⇒ 距离 = max ⇒ 相似度 0 < 0.8 ⇒ 归 VLM（置信语义强）
  const b = arbitrateText('Settings', '设置面板')
  assert.equal(b.source, 'vlm')
  assert.equal(b.text, 'Settings')
  close(b.similarity, 0, 1e-12)
  // ③ 任一为空 ⇒ 非空者胜、similarity 恒 0
  assert.deepEqual(arbitrateText('', '本地全文'), { text: '本地全文', source: 'local', similarity: 0 }, 'vlm 空 ⇒ local 直通')
  assert.deepEqual(arbitrateText('云端全文', ''), { text: '云端全文', source: 'vlm', similarity: 0 }, 'local 空 ⇒ vlm 直通')
  // 边界：双空恒等（相似度 1）⇒ 融合空串，不抛错
  assert.deepEqual(arbitrateText('', ''), { text: '', source: 'fusion', similarity: 1 }, '双空 ⇒ fusion 空串')
})

// ─── Ω-9-8 退化边界 + 模块纯度执法 ───

test('Ω-9-8: 边界与纯度 —— 双空输入不抛错、单侧空直通、零运行时依赖', async () => {
  const { arbitrateElements } = await import('../src/vlm/arbitration.ts')
  // 双空：平票律缺省 vlm、空元素表、理由仍可审计
  const none = arbitrateElements([], [])
  assert.equal(none.winner, 'vlm', '双空平票 ⇒ 缺省 vlm')
  assert.deepEqual(none.elements, [])
  assert.ok(typeof none.rationale === 'string' && none.rationale.length > 0)
  // 单侧空：全量直通，胜者即供给侧
  const onlyLocal = arbitrateElements([], [le('a', [0, 0, 5, 5], 0.7)])
  assert.equal(onlyLocal.winner, 'local')
  assert.equal(onlyLocal.elements[0].source, 'local')
  assert.deepEqual(onlyLocal.elements[0].center, { x: 2.5, y: 2.5 }, '本地元素中心由 bbox 中点补全')
  const onlyVlm = arbitrateElements([ve('v', 'a', [0, 0, 5, 5], 0.7)], [])
  assert.equal(onlyVlm.winner, 'vlm')
  assert.equal(onlyVlm.elements[0].source, 'vlm')
  assert.deepEqual(onlyVlm.elements[0].center, { x: 2.5, y: 2.5 }, 'vlm 元素保留自带中心')
  assert.equal(onlyVlm.elements[0].agreesWith, 'vlm', '单源元素仅自证')
  // 纯度执法：兄弟模块仅 type import；无运行时 import / 无 default export / 零网络零图像依赖
  const src = readFileSync(new URL('../src/vlm/arbitration.ts', import.meta.url), 'utf8')
  assert.ok(src.includes("import type { Bbox } from './codec'"), 'Bbox 仅 type import')
  assert.ok(src.includes("import type { GroundedElement } from './grounding'"), 'GroundedElement 仅 type import')
  // Θ-4 内核接线修正：唯一获准的运行时 import = 内核注册表同步只读（getOrDefault
  // 未注册 ⇒ 回声字面量缺省，裁决纯度语义不变）；除此之外仍零运行时 import。
  const runtimeImports = [...src.matchAll(/^import\s+(?!type\b)[^\n]*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1])
  assert.deepEqual(runtimeImports, ['../kernel/registry'], '唯一运行时 import = kernel/registry（Θ-4 读点接线）')
  assert.ok(!/\brequire\s*\(/.test(src), '零 require')
  assert.ok(!/export\s+default/.test(src), '禁止 default export')
  assert.ok(!/\bfrom\s+['"]sharp['"]|node:(http|https|net|tls|dgram)|\bfetch\s*\(/.test(src), '零图像/网络依赖')
})

// ─── ΝΩ-47 loglinear 融合模式：连折置信膨胀修正（opt-in，缺省 classic 旧行为） ───

test('ΝΩ-47a: loglinear 单对融合 —— conf = min(1,(cv+cl)/2 + bonus/√2)；classic 缺省/显式与旧行为逐字节一致', async () => {
  const { arbitrateElements } = await import('../src/vlm/arbitration.ts')
  const mk = () => [ve('v1', '登录', [0, 0, 100, 50], 0.8), le('登录', [0, 0, 100, 50], 0.8)] as const
  // classic 缺省（旧行为，Ω-9-2 已钉死 0.95）与显式 classic 逐字节一致
  close(arbitrateElements([mk()[0]], [mk()[1]]).elements[0].confidence, 0.95, 1e-12)
  close(
    arbitrateElements([mk()[0]], [mk()[1]], { fuseMode: 'classic' }).elements[0].confidence,
    0.95,
    1e-12,
    '显式 classic = 缺省',
  )
  // loglinear（foldedFamilies 缺省 2 = 单对双源）：0.8 + 0.15/√2
  const ll = arbitrateElements([mk()[0]], [mk()[1]], { fuseMode: 'loglinear' })
  close(ll.elements[0].confidence, 0.8 + 0.15 / Math.sqrt(2), 1e-12, '加成按 1/√2 衰减')
  // 模式只动置信：bbox / label / source / winner 与 classic 全同
  const clas = arbitrateElements([mk()[0]], [mk()[1]])
  const a = ll.elements[0]
  const b = clas.elements[0]
  assert.deepEqual(a.bbox, b.bbox, '凸组合框不动')
  assert.equal(a.label, b.label)
  assert.equal(a.source, b.source)
  assert.equal(ll.winner, clas.winner, 'winner 判决不动')
})

test('ΝΩ-47b: foldedFamilies 衰减因子 + agreementBonus 组合 + 脏值安静归缺省', async () => {
  const { arbitrateElements } = await import('../src/vlm/arbitration.ts')
  const one = (conf: number) => [ve('v', '确定', [0, 0, 10, 10], conf), le('确定', [0, 0, 10, 10], conf)] as const
  // 5 家连折的末折：0.8 + 0.15/√5
  close(
    arbitrateElements([one(0.8)[0]], [one(0.8)[1]], { fuseMode: 'loglinear', foldedFamilies: 5 }).elements[0].confidence,
    0.8 + 0.15 / Math.sqrt(5),
    1e-12,
    '加成按 1/√families 衰减',
  )
  // agreementBonus 选项与衰减因子正交组合：bonus 0.5、家数 4 ⇒ 0.6 + 0.25
  close(
    arbitrateElements([one(0.6)[0]], [one(0.6)[1]], {
      fuseMode: 'loglinear', foldedFamilies: 4, agreementBonus: 0.5,
    }).elements[0].confidence,
    0.6 + 0.5 / 2,
    1e-12,
  )
  // 脏 foldedFamilies（0 / -3 / NaN）⇒ 归 2（单对缺省）
  for (const bad of [0, -3, Number.NaN]) {
    close(
      arbitrateElements([one(0.8)[0]], [one(0.8)[1]], {
        fuseMode: 'loglinear', foldedFamilies: bad,
      }).elements[0].confidence,
      0.8 + 0.15 / Math.sqrt(2),
      1e-12,
      `脏值 ${bad} 安静归 2`,
    )
  }
  // 非整数向下取整：2.9 ⇒ 2
  close(
    arbitrateElements([one(0.8)[0]], [one(0.8)[1]], {
      fuseMode: 'loglinear', foldedFamilies: 2.9,
    }).elements[0].confidence,
    0.8 + 0.15 / Math.sqrt(2),
    1e-12,
  )
  // 非法 fuseMode 字面量安静归 classic（不抛铁律）
  close(
    arbitrateElements([one(0.8)[0]], [one(0.8)[1]], { fuseMode: 'banana' as never }).elements[0].confidence,
    0.95,
    1e-12,
    '脏模式归 classic',
  )
  // 封顶仍执法：高基线 + 大 bonus ⇒ 恰 1 绝不过界
  assert.equal(
    arbitrateElements([one(1)[0]], [one(1)[1]], { fuseMode: 'loglinear', agreementBonus: 0.9 }).elements[0].confidence,
    1,
    'loglinear 封顶于 1',
  )
})
