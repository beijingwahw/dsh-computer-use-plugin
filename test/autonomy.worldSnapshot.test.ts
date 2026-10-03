// test/autonomy.worldSnapshot.test.ts
// 纪元 Φ（Φ-2 自主识别中枢）：执法册 —— 双源融合数值（借 vlm/arbitration 真实现造已知输入）/
// interactive 三态 / 零源降级清单 / snapshotChanged 五案（null/同指/距 3/距 4/数量突变）/
// findInSnapshot 双向子串+排序+limit / 边界与纯度。纯离线，零网络零 sharp。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 浮点断言：容差式比较（融合置信含 0.15 等非二进制小数，拒绝逐位巧合）
const close = (actual: number, expected: number, tol = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tol, `期望 ${actual} ≈ ${expected}（容差 ${tol}）`)

// GroundedElement 便捷构造（兄弟契约：id/label/role/bbox/center/confidence/source）
const ge = (id: string, label: string, role: string, box: [number, number, number, number], confidence: number) => ({
  id,
  label,
  role,
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

// 汉明距离已知量的十六进制指纹对（nibble popcount：0^7=0b0111 ⇒ 3 位、0^f=0b1111 ⇒ 4 位）
const H0 = '0000000000000000'
const H3 = '7000000000000000'
const H4 = 'f000000000000000'

// ─── Φ-2-1 双源融合数值：对称恒等框 + 非对称加权凸组合 ───

test('Φ-2-1: 双源融合 —— 恒等框等权凸组合、conf=(cv+cl)/2+0.15、role 回填 vlm', async () => {
  const { composeSnapshot } = await import('../src/autonomy/worldSnapshot.ts')
  const sym = composeSnapshot({
    width: 1920,
    height: 1080,
    ocrText: '登录',
    dhash: 'ab',
    now: 1234,
    sceneLabel: 'desktop',
    vlmElements: [ge('e1', '登录', 'button', [0, 0, 100, 50], 0.8)],
    localElements: [le('登录', [0, 0, 100, 50], 0.8)],
  })
  assert.equal(sym.elements.length, 1, '一对一 ⇒ 恰一元素')
  const e = sym.elements[0]
  assert.equal(e.source, 'fusion')
  assert.deepEqual(e.bbox, { x0: 0, y0: 0, x1: 100, y1: 50 }, '0.5/0.5 等权 × 恒等框 ⇒ 原框')
  assert.deepEqual(e.center, { x: 50, y: 25 }, 'center 由融合框中点重算')
  assert.equal(e.label, '登录')
  assert.equal(e.role, 'button', '角色回填 vlm（本地信道无角色语义）')
  assert.equal(e.interactive, true, 'button ∈ 可交互集')
  close(e.confidence, 0.95, 1e-9) // (0.8+0.8)/2 + 0.15
  assert.deepEqual(sym.degraded, [], '三证齐备 ⇒ 零降级')
  assert.equal(sym.takenAt, 1234, 'now 注入确定性')
  assert.equal(sym.sceneLabel, 'desktop')

  // 非对称置信：bbox 逐坐标按 cv:cl 加权、label 归高置信侧、role 仍归 vlm
  const asym = composeSnapshot({
    width: 800,
    height: 600,
    ocrText: '',
    dhash: '01',
    now: 2,
    vlmElements: [ge('e1', 'Sign in', 'textbox', [0, 0, 100, 100], 0.25)],
    localElements: [le('登录', [4, 0, 104, 100], 0.75)], // IoU ≈ 0.923 ≥ 0.5
  })
  const f = asym.elements[0]
  assert.deepEqual(f.bbox, { x0: 3, y0: 0, x1: 103, y1: 100 }, '加权凸组合（0.25:0.75）')
  assert.deepEqual(f.center, { x: 53, y: 50 }, '中心 = 融合框中点')
  assert.equal(f.label, '登录', 'label 取置信高者（local 0.75 > vlm 0.25）')
  assert.equal(f.role, 'textbox', 'role 永远 vlm 优先 —— 与 label 来源解耦')
  assert.equal(f.interactive, null, 'textbox ∉ 可交互集且非 text ⇒ 证据不足')
  close(f.confidence, 0.65, 1e-9) // (0.25+0.75)/2 + 0.15
})

// ─── Φ-2-2 多元素双源：次序对齐回填 + interactive 三态 + center 重算 ───

test('Φ-2-2: 多元素双源 —— vlm 序在前本地殿后、三态逐位执法、center 不吃直通值', async () => {
  const { composeSnapshot } = await import('../src/autonomy/worldSnapshot.ts')
  // 故意给 vlm 元素塞错误 center：快照必须以 bbox 中点重算，不信任直通值
  const vlmA = { id: 'e1', label: 'a', role: 'link', bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, center: { x: -9, y: -9 }, confidence: 0.9, source: 'vlm' as const }
  const vlmB = { id: 'e2', label: 'b', role: 'text', bbox: { x0: 100, y0: 100, x1: 110, y1: 110 }, center: { x: 999, y: 999 }, confidence: 0.5, source: 'vlm' as const }
  const snap = composeSnapshot({
    width: 800,
    height: 600,
    ocrText: '',
    dhash: '02',
    now: 3,
    vlmElements: [vlmA, vlmB],
    localElements: [le('a', [0, 0, 10, 10], 0.9), le('c', [200, 200, 210, 210], 0.5)],
  })
  assert.deepEqual(snap.elements.map((x) => x.source), ['fusion', 'vlm', 'local'], 'vlm 序（融合混排）在前、本地单源殿后')
  assert.deepEqual(snap.elements.map((x) => x.role), ['link', 'text', 'unknown'], 'vlm 序位回填角色、本地缺省 unknown')
  assert.deepEqual(snap.elements.map((x) => x.interactive), [true, false, null], '可交互三态：link ⇒ true、text ⇒ false、unknown ⇒ null')
  assert.deepEqual(snap.elements[1].center, { x: 105, y: 105 }, 'vlm 单源 center 亦由 bbox 中点重算（不吃 999）')
  assert.equal(snap.elements[0].label, 'a', '融合 label 平票归 VLM')
  assert.equal(snap.elements[0].confidence, 1, '融合置信 (0.9+0.9)/2+0.15=1.05 封顶于 1')
})

// ─── Φ-2-3 单源直映 ───

test('Φ-2-3: 单源直映 —— vlm 单源保角色、local 单源记 unknown/null', async () => {
  const { composeSnapshot } = await import('../src/autonomy/worldSnapshot.ts')
  const skewed = { id: 'e1', label: '登录', role: 'button', bbox: { x0: 10, y0: 20, x1: 110, y1: 70 }, center: { x: 999, y: 888 }, confidence: 0.8, source: 'vlm' as const }
  const solo = composeSnapshot({
    width: 640,
    height: 480,
    ocrText: '全文',
    dhash: 'ab12',
    now: 99,
    sceneLabel: 'browser',
    focusRegion: { x0: 1, y0: 2, x1: 3, y1: 4 },
    vlmElements: [skewed],
  })
  assert.equal(solo.elements.length, 1)
  const e = solo.elements[0]
  assert.equal(e.source, 'vlm')
  assert.equal(e.role, 'button')
  assert.equal(e.interactive, true)
  assert.deepEqual(e.center, { x: 60, y: 45 }, 'center 由 bbox 中点重算（不吃 999/888）')
  assert.deepEqual(solo.focusedRegion, { x0: 1, y0: 2, x1: 3, y1: 4 }, '焦点区透传')
  assert.deepEqual(solo.degraded, [], '单源在场 ⇒ 无 elements 降级')

  const soloLocal = composeSnapshot({
    width: 100,
    height: 100,
    ocrText: 'x',
    dhash: 'cd',
    now: 5,
    localElements: [le('确定', [0, 0, 40, 20], 0.6)],
  })
  const l = soloLocal.elements[0]
  assert.equal(l.source, 'local')
  assert.equal(l.label, '确定')
  assert.equal(l.role, 'unknown', '本地信道无角色语义')
  assert.equal(l.interactive, null, 'unknown ⇒ 证据不足')
  assert.deepEqual(l.center, { x: 20, y: 10 })
  assert.equal(l.confidence, 0.6)
})

// ─── Φ-2-4 零源降级清单 + 杂字段执法 ───

test('Φ-2-4: 零源降级清单 —— elements/ocr/dhash 三记 + 截断/去空串/缺省', async () => {
  const { composeSnapshot } = await import('../src/autonomy/worldSnapshot.ts')
  const bare = composeSnapshot({ width: 800, height: 600, popupNotes: ['', '更新可用', ''], now: 1 })
  assert.deepEqual(bare.elements, [], '零源 ⇒ 空元素表')
  assert.deepEqual(bare.degraded, ['elements', 'ocr', 'dhash'], '三证缺席 ⇒ 降级清单按序记账')
  assert.equal(bare.dhash, null)
  assert.equal(bare.textDigest, '')
  assert.deepEqual(bare.popups, ['更新可用'], '弹窗注记去空串')
  assert.equal(bare.sceneLabel, '', '场景标签缺省空串')
  assert.equal(bare.focusedRegion, null)
  assert.equal(bare.takenAt, 1, 'now 注入确定性')

  // 半降级：元素零源但 ocr/dhash 在场 ⇒ 只记 'elements'
  const half = composeSnapshot({ width: 1, height: 1, ocrText: 't', dhash: 'ff' })
  assert.deepEqual(half.degraded, ['elements'])
  assert.ok(Number.isFinite(half.takenAt), 'now 缺省 Date.now()')

  // textDigest 截 2000：恰 2000 不动、超长截断且保前缀
  const el = [ge('e1', 'x', 'icon', [0, 0, 5, 5], 0.5)]
  assert.equal(composeSnapshot({ width: 1, height: 1, ocrText: 'a'.repeat(2500), dhash: '00', vlmElements: el }).textDigest.length, 2000, '2500 截为 2000')
  assert.equal(composeSnapshot({ width: 1, height: 1, ocrText: 'b'.repeat(2000), dhash: '00', vlmElements: el }).textDigest.length, 2000, '恰 2000 不动')
  const digest = composeSnapshot({ width: 1, height: 1, ocrText: '前缀'.repeat(1200), dhash: '00', vlmElements: el }).textDigest
  assert.ok(digest.startsWith('前缀'), '截断保前缀')
})

// ─── Φ-2-5 snapshotChanged 五案 ───

test('Φ-2-5: snapshotChanged —— null/同指/距 3/距 4/容差选项/数量突变/指纹缺席', async () => {
  const { composeSnapshot, snapshotChanged } = await import('../src/autonomy/worldSnapshot.ts')
  const make = (dhash: string | null, count: number) =>
    composeSnapshot({
      width: 100,
      height: 100,
      dhash,
      ocrText: 't',
      now: 42,
      vlmElements: Array.from({ length: count }, (_, i) => ge(`e${i + 1}`, `元素${i}`, 'text', [i * 20, 0, i * 20 + 10, 10], 0.9)),
    })
  assert.equal(snapshotChanged(null, make(H0, 3)), true, '首见世界（prev=null）⇒ 必变')
  assert.equal(snapshotChanged(make(H0, 3), make(H0, 3)), false, '同指纹同元素数 ⇒ 未变')
  assert.equal(snapshotChanged(make(H0, 3), make(H3, 3)), false, '距 3 ≤ 默认容差 3 ⇒ 未变')
  assert.equal(snapshotChanged(make(H0, 3), make(H4, 3)), true, '距 4 > 容差 3 ⇒ 变')
  assert.equal(snapshotChanged(make(H0, 3), make(H4, 3), 4), false, '容差放宽至 4 ⇒ 未变')
  assert.equal(snapshotChanged(make(H0, 3), make(H3, 3), 2), true, '容差收紧至 2 ⇒ 距 3 判变')
  assert.equal(snapshotChanged(make(H0, 7), make(H0, 10)), false, '数量差恰落 30% 线（3/10）⇒ 排他边界未变')
  assert.equal(snapshotChanged(make(H0, 7), make(H0, 11)), true, '同指纹但元素 7→11（>30%）⇒ 结构性变化')
  assert.equal(snapshotChanged(make(null, 3), make(H0, 3)), true, 'prev 指纹缺席 ⇒ 宽松判变')
  assert.equal(snapshotChanged(make(H0, 0), make(H0, 1)), true, '0→1 个元素（max 分母免除零除）⇒ 变')
})

// ─── Φ-2-6 findInSnapshot：双向子串 + 折叠 + 排序 + limit ───

test('Φ-2-6: findInSnapshot —— 双向子串、大小写/空白折叠、置信降序、limit', async () => {
  const { composeSnapshot, findInSnapshot } = await import('../src/autonomy/worldSnapshot.ts')
  const snap = composeSnapshot({
    width: 800,
    height: 600,
    ocrText: '',
    dhash: '00',
    now: 1,
    vlmElements: [
      ge('e1', 'Settings', 'link', [0, 0, 100, 20], 0.9),
      ge('e2', 'Advanced Settings', 'menu', [0, 30, 100, 50], 0.7),
      ge('e3', 'Search settings pane', 'text', [0, 60, 100, 80], 0.5),
      ge('e4', '设置', 'button', [0, 90, 100, 110], 0.99),
      ge('e5', 'Terms  of   Service', 'link', [0, 120, 100, 140], 0.8),
      ge('e6', '', 'icon', [0, 150, 100, 170], 1.0),
      ge('e7', 'settings one', 'text', [0, 180, 100, 200], 0.4),
      ge('e8', 'settings two', 'text', [0, 210, 100, 230], 0.3),
      ge('e9', 'settings three', 'text', [0, 240, 100, 260], 0.2),
    ],
  })
  // 正向子串 + 排序：6 个含 'settings' 的标签按置信降序、默认 limit 5 截断
  const hits = findInSnapshot(snap, 'settings')
  assert.deepEqual(
    hits.map((x) => x.label),
    ['Settings', 'Advanced Settings', 'Search settings pane', 'settings one', 'settings two'],
    '默认 limit 5 截断且置信降序',
  )
  assert.ok(!hits.some((x) => x.label === 'settings three'), '第 6 命中被默认上限截去')
  assert.ok(!hits.some((x) => x.label === ''), '空标签不入检索')
  assert.ok(!hits.some((x) => x.label === '设置'), '无子串关系的中文标签不入')
  // 反向子串：query 含 label（物名不全）
  assert.deepEqual(findInSnapshot(snap, 'open my settings page').map((x) => x.label), ['Settings'], 'label 含于 query ⇒ 命中')
  assert.deepEqual(findInSnapshot(snap, '打开 Advanced Settings 面板').map((x) => x.label), ['Settings', 'Advanced Settings'], '双向皆中按置信排序')
  // 大小写 + 空白折叠
  assert.deepEqual(findInSnapshot(snap, '  terms   OF service ').map((x) => x.label), ['Terms  of   Service'], '折叠后子串命中')
  // limit 选项
  assert.equal(findInSnapshot(snap, 'settings', { limit: 2 }).length, 2)
  assert.deepEqual(findInSnapshot(snap, 'settings', { limit: 1 }).map((x) => x.label), ['Settings'], 'limit 取置信最高者')
  assert.deepEqual(findInSnapshot(snap, 'settings', { limit: 0 }), [], 'limit 0 ⇒ 空结果')
  // 无命中 / 空 query
  assert.deepEqual(findInSnapshot(snap, '不存在的控件'), [])
  assert.deepEqual(findInSnapshot(snap, '   '), [], '空白 query 折叠为空 ⇒ 不做全集匹配')
})

// ─── Φ-2-7 interactiveElements：三态过滤 ───

test('Φ-2-7: interactiveElements —— 三态过滤只留已知可交互', async () => {
  const { composeSnapshot, interactiveElements } = await import('../src/autonomy/worldSnapshot.ts')
  const snap = composeSnapshot({
    width: 100,
    height: 100,
    ocrText: 'x',
    dhash: 'ff',
    now: 7,
    vlmElements: [
      ge('e1', '保存', 'button', [0, 0, 10, 10], 0.9),
      ge('e2', '标题', 'text', [0, 20, 10, 30], 0.8),
      ge('e3', '图标', 'icon', [0, 40, 10, 50], 0.7),
      ge('e4', '更多', 'menu', [0, 60, 10, 70], 0.6),
      ge('e5', '输入', 'input', [0, 80, 10, 90], 0.5),
    ],
    localElements: [le('本地框', [200, 200, 210, 210], 0.4)],
  })
  const inter = interactiveElements(snap)
  assert.deepEqual(inter.map((x) => x.label), ['保存', '更多', '输入'], 'button/menu/input 入选；text(false)/icon(null)/本地(null) 出局')
  assert.ok(inter.every((x) => x.interactive === true))
  assert.equal(snap.elements.length, 6, '本地单源殿后（与远框不相融）')
  assert.equal(snap.elements[5].interactive, null)
})

// ─── Φ-2-8 边界与纯度执法 ───

test('Φ-2-8: 边界与纯度 —— 脏输入不抛异常、空检索安全、模块纯度', async () => {
  const mod = await import('../src/autonomy/worldSnapshot.ts')
  type Inputs = Parameters<typeof mod.composeSnapshot>[0]
  type Snap = Parameters<typeof mod.findInSnapshot>[0]
  const empty = mod.composeSnapshot({} as Inputs)
  assert.equal(empty.width, 0, '脏 width 按 0 记')
  assert.equal(empty.height, 0)
  assert.deepEqual(empty.degraded, ['elements', 'ocr', 'dhash'])
  assert.ok(Number.isFinite(empty.takenAt))
  assert.doesNotThrow(() => mod.composeSnapshot(undefined as unknown as Inputs), '全脏输入不抛')
  assert.deepEqual(mod.findInSnapshot(null as unknown as Snap, 'x'), [], '空快照检索安全')
  assert.deepEqual(mod.interactiveElements(null as unknown as Snap), [])
  assert.equal(mod.snapshotChanged(null, null as unknown as Parameters<typeof mod.snapshotChanged>[1]), true)
  // 纯度执法：arbitrateElements 为契约指定的唯一运行时依赖；其余皆 type import
  const src = readFileSync(new URL('../src/autonomy/worldSnapshot.ts', import.meta.url), 'utf8')
  assert.ok(src.includes("import type { Bbox } from '../vlm/codec'"), 'Bbox 仅 type import')
  assert.ok(src.includes("import type { GroundedElement } from '../vlm/grounding'"), 'GroundedElement 仅 type import')
  assert.ok(src.includes("import type { LocalElement } from '../vlm/arbitration'"), 'LocalElement 仅 type import')
  assert.ok(src.includes("import { arbitrateElements } from '../vlm/arbitration'"), 'arbitrateElements 运行时直用（契约指定）')
  assert.ok(!/\brequire\s*\(/.test(src), '零 require')
  assert.ok(!/export\s+default/.test(src), '禁止 default export')
  assert.ok(!/\bfrom\s+['"]sharp['"]|node:(http|https|net|tls|dgram)|\bfetch\s*\(/.test(src), '零图像/网络依赖')
})
