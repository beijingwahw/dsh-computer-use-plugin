// test/autonomy.worldSnapshot.test.ts
// 纪元 Φ（Φ-2 自主识别中枢）：执法册 —— 双源融合数值（借 vlm/arbitration 真实现造已知输入）/
// interactive 三态 / 零源降级清单 / snapshotChanged 五案（null/同指/距 3/距 4/数量突变）/
// findInSnapshot 双向子串+排序+limit / 边界与纯度。纯离线，零网络零 sharp。
// ΝΩ-14 追册：role 回填防御（arbitrationRoleAt 次序错乱执法）/ notes 注记面 /
// 感知变化门控（createPerceive 屏未变 ⇒ groundVlm 零拨 + 'vlm-reused-unchanged'）。
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

// ─── ΝΩ-14-a role 回填防御（次序错乱仲裁输出的执法） ───

test('ΝΩ-14-a: arbitrationRoleAt —— 契约位照旧回填；错配位（vlm 区混入 local 源）防御回退 unknown；脏输入不抛', async () => {
  const { arbitrationRoleAt } = await import('../src/autonomy/worldSnapshot.ts')
  const vlm = [ge('e1', '登录', 'button', [0, 0, 50, 20], 0.9), ge('e2', '设置', 'link', [0, 30, 50, 50], 0.8)]
  // 契约位：前 vlmList.length 位 source ∈ {vlm, fusion} ⇒ 照旧按位置回填 vlm 角色
  assert.equal(arbitrationRoleAt(vlm, 0, 'vlm'), 'button')
  assert.equal(arbitrationRoleAt(vlm, 1, 'fusion'), 'link')
  // 错配位（次序错乱的仲裁输出）：vlm 序位置冒出 local 源 ⇒ 不按位置错配回填
  assert.equal(arbitrationRoleAt(vlm, 0, 'local'), 'unknown', '位置 0 属 vlm 序但 source=local ⇒ unknown')
  assert.equal(arbitrationRoleAt(vlm, 1, 'local'), 'unknown', '位置 1 属 vlm 序但 source=local ⇒ unknown')
  // 殿后区（i ≥ vlm 序长）：契约位（local）与错配位（vlm/fusion 源越界压尾）同律 unknown
  assert.equal(arbitrationRoleAt(vlm, 2, 'local'), 'unknown')
  assert.equal(arbitrationRoleAt(vlm, 2, 'vlm'), 'unknown')
  // 越界 / 非整数 / 脏 vlm 表：全部安全收敛，绝不抛
  assert.equal(arbitrationRoleAt(vlm, -1, 'vlm'), 'unknown')
  assert.equal(arbitrationRoleAt(vlm, 99, 'fusion'), 'unknown')
  assert.equal(arbitrationRoleAt(vlm, 1.5, 'fusion'), 'unknown')
  assert.equal(arbitrationRoleAt([], 0, 'vlm'), 'unknown')
  assert.doesNotThrow(() => arbitrationRoleAt(null as unknown as Parameters<typeof arbitrationRoleAt>[0], 0, 'vlm'))
  assert.equal(arbitrationRoleAt(null as unknown as Parameters<typeof arbitrationRoleAt>[0], 0, 'vlm'), 'unknown')
  // 角色卫兵仍由 roleOr 执法：空串/非串角色 ⇒ unknown
  assert.equal(arbitrationRoleAt([ge('e9', '无角', '', [0, 0, 1, 1], 0.5)], 0, 'vlm'), 'unknown')
  assert.equal(
    arbitrationRoleAt([{ ...ge('e8', 'x', 'button', [0, 0, 1, 1], 0.5), role: 42 as unknown as string }], 0, 'vlm'),
    'unknown',
    '非串角色 ⇒ unknown',
  )
})

// ─── ΝΩ-14-b notes 注记面 ───

test('ΝΩ-14-b: notes 注记 —— 去空串/弃非串透传、缺省 []、不污染 degraded（复用是节流不是降级）', async () => {
  const { composeSnapshot } = await import('../src/autonomy/worldSnapshot.ts')
  const withNotes = composeSnapshot({
    width: 1,
    height: 1,
    dhash: 'ab',
    ocrText: 'x',
    vlmElements: [ge('e1', 'x', 'icon', [0, 0, 5, 5], 0.5)],
    notes: ['vlm-reused-unchanged', '', 42 as unknown as string],
    now: 1,
  })
  assert.deepEqual(withNotes.notes, ['vlm-reused-unchanged'], '注记去空串/弃非串')
  assert.deepEqual(withNotes.degraded, [], '申报不占 degraded —— 证据缺席语义零污染')
  assert.deepEqual(composeSnapshot({ width: 1, height: 1, dhash: 'ab', ocrText: 'x', now: 2 }).notes, [], '缺省空注记')
  assert.deepEqual(composeSnapshot({ width: 1, height: 1, dhash: 'ab', ocrText: 'x', notes: [] as string[], now: 3 }).notes, [], '空数组注记 ⇒ []')
  assert.deepEqual(composeSnapshot({ width: 1, height: 1, dhash: 'ab', ocrText: 'x', notes: ['  '] as string[], now: 4 }).notes, ['  '], '与 popups 同律：只去空串、不去空白（机器生成 token，不做 trim 猜测）')
})

// ─── ΝΩ-14-c/d/e/f 感知变化门控（createPerceive：屏未变 ⇒ groundVlm 零拨） ───

/** GLM 环境隔离（与 sceneSemantics.test Φ-6-2 同律）：清键 + 清单例 ⇒ 场景语义读屏零网络降级 */
async function withOfflineGlm<T>(fn: () => Promise<T>): Promise<T> {
  const { resetGlmClient } = await import('../src/vlm/glmClient.ts')
  const keys = ['GLM_API_KEY', 'ZHIPUAI_API_KEY', 'ZAI_API_KEY'] as const
  const saved = keys.map(k => [k, process.env[k]] as const)
  try {
    for (const k of keys) delete process.env[k]
    resetGlmClient()
    return await fn()
  } finally {
    for (const [k, v] of saved) { if (v !== undefined) process.env[k] = v }
    resetGlmClient()
  }
}

test('ΝΩ-14-c: 屏未变 ⇒ 第二帧 groundVlm 零拨 + vlm-reused-unchanged 注记；OCR 照跑、元素账一致', async () => {
  await withOfflineGlm(async () => {
    const { createPerceive } = await import('../src/autonomy/runtime.perceive.ts')
    const ground = [ge('g1', '登录', 'button', [0, 0, 100, 40], 0.9), ge('g2', '帮助', 'link', [0, 60, 100, 90], 0.7)]
    let groundCalls = 0
    let ocrCalls = 0
    let t = 1000
    const perceive = createPerceive({
      capture: async () => Buffer.from('frame-static'),
      imageSize: async () => ({ width: 800, height: 600 }),
      dhashOf: async () => 'ab'.repeat(16),
      readWords: async () => { ocrCalls++; return [le('登录', [0, 0, 100, 40], 0.8)] },
      groundVlm: async () => { groundCalls++; return ground.map(g => ({ ...g })) },
      now: () => t,
    })
    const snap1 = await perceive()
    assert.equal(groundCalls, 1, '首轮 prev 不可得 ⇒ 照旧全价接地')
    assert.deepEqual(snap1.notes, [], '首轮无复用 ⇒ 无注记')
    t = 2500
    const snap2 = await perceive()
    assert.equal(groundCalls, 1, '屏未变（同指纹同元素数）⇒ 复用上帧 vlm 元素，groundVlm 零拨')
    assert.equal(ocrCalls, 2, 'OCR 便宜本地 ⇒ 每帧照跑')
    assert.deepEqual(snap2.notes, ['vlm-reused-unchanged'], '门控决策诚实申报')
    assert.deepEqual(snap2.elements, snap1.elements, '复用帧元素账与上帧一致')
    assert.deepEqual(snap2.degraded, snap1.degraded, '降级清单不因复用而变')
    // 第三帧连写：门控状态跨帧持续（上帧仍是复用帧的 before）
    const snap3 = await perceive()
    assert.equal(groundCalls, 1, '连续静屏 ⇒ 持续零拨')
    assert.ok(snap3.notes?.includes('vlm-reused-unchanged'))
  })
})

test('ΝΩ-14-d: 屏变（dhash 距离 4 > 容差 3）⇒ 照旧重拨 groundVlm、新元素入账、无复用注记', async () => {
  await withOfflineGlm(async () => {
    const { createPerceive } = await import('../src/autonomy/runtime.perceive.ts')
    let flip = 0
    let groundCalls = 0
    const frames = [
      [ge('g1', '登录', 'button', [0, 0, 100, 40], 0.9)],
      [ge('g9', '购物车', 'button', [10, 10, 120, 60], 0.85)],
    ]
    const perceive = createPerceive({
      capture: async () => Buffer.from('frame-move'),
      imageSize: async () => ({ width: 800, height: 600 }),
      dhashOf: async () => (flip++ === 0 ? '0'.repeat(16) : 'f' + '0'.repeat(15)), // 汉明距离 4
      readWords: async () => [],
      groundVlm: async () => { groundCalls++; return frames[Math.min(groundCalls - 1, frames.length - 1)].map(g => ({ ...g })) },
      now: () => 1000,
    })
    await perceive()
    const snap2 = await perceive()
    assert.equal(groundCalls, 2, '屏变 ⇒ 照旧全价重拨')
    assert.deepEqual(snap2.notes, [], '无复用 ⇒ 无注记')
    assert.deepEqual(snap2.elements.map(e => e.label), ['购物车'], '新帧元素来自新接地（非上帧复用）')
  })
})

test('ΝΩ-14-e: 上帧 groundVlm 空 ⇒ 无产物可复用，屏未变也照旧全价重拨（不给降级帧续命）', async () => {
  await withOfflineGlm(async () => {
    const { createPerceive } = await import('../src/autonomy/runtime.perceive.ts')
    let groundCalls = 0
    const perceive = createPerceive({
      capture: async () => Buffer.from('frame-empty'),
      imageSize: async () => ({ width: 800, height: 600 }),
      dhashOf: async () => 'cd'.repeat(16),
      readWords: async () => [],
      groundVlm: async () => { groundCalls++; return groundCalls === 1 ? [] : [ge('g1', '登录', 'button', [0, 0, 100, 40], 0.9)] },
      now: () => 1000,
    })
    const snap1 = await perceive()
    assert.ok(snap1.degraded.includes('elements'), '首帧零元素 ⇒ 诚实记降级')
    const snap2 = await perceive()
    assert.equal(groundCalls, 2, '上帧 VLM 空 ⇒ 门控缺席，屏未变也重拨')
    assert.deepEqual(snap2.notes, [], '无复用注记')
    assert.equal(snap2.elements.length, 1, '次帧恢复全价感知')
  })
})

test('ΝΩ-14-f: 同指纹但 OCR 元素数突变（>30%）⇒ 结构闸开 ⇒ 重拨（双闸后闸执法）', async () => {
  await withOfflineGlm(async () => {
    const { createPerceive } = await import('../src/autonomy/runtime.perceive.ts')
    let frame = 0
    let groundCalls = 0
    const ground = [ge('g1', '登录', 'button', [0, 0, 100, 40], 0.9), ge('g2', '帮助', 'link', [0, 60, 100, 90], 0.7)]
    const perceive = createPerceive({
      capture: async () => Buffer.from('frame-burst'),
      imageSize: async () => ({ width: 800, height: 600 }),
      dhashOf: async () => 'ef'.repeat(16), // 指纹恒定 ⇒ 像素闸关
      readWords: async () => {
        if (frame++ === 0) return [le('登录', [0, 0, 100, 40], 0.8)] // 2 元素（1 融合 + 1 vlm 单源）
        return [
          le('登录', [0, 0, 100, 40], 0.8), // 与 g1 融合
          ...Array.from({ length: 9 }, (_, i) => le(`项${i}`, [200, i * 20, 260, i * 20 + 15], 0.8)), // 9 个远端本地单源
        ] // 2 + 9 = 11 元素：|11-2|×10=90 > 3×11=33 ⇒ 结构性变化
      },
      groundVlm: async () => { groundCalls++; return ground.map(g => ({ ...g })) },
      now: () => 1000,
    })
    const snap1 = await perceive()
    assert.equal(snap1.elements.length, 2, '首帧：1 融合 + 1 vlm 单源')
    const snap2 = await perceive()
    assert.equal(groundCalls, 2, '指纹未变但元素数突变 ⇒ 门开重拨')
    assert.deepEqual(snap2.notes, [], '无复用注记')
    assert.equal(snap2.elements.length, 11, '新帧全元素入账（2 vlm 序 + 9 本地殿后）')
  })
})
