// src/autonomy/worldSnapshot.ts
// 纪元 Φ（Φ-2 自主识别中枢）：世界快照器官 —— 把多源感知融合为一张确定性的世界快照。
//
// 存在理由：自主智能环每一步决策都面对同一道题 ——「屏幕上现在有什么」。云端
// 接地（GroundedElement）、本地感知（LocalElement）、OCR 全文、弹窗注记、焦点
// 区是五种方言各异的证据；没有一张统一总账，决策层就要在方言之间反复对表。
// 本器官就是那张对表后的总账（WorldSnapshot）：
//   · 元素层：双源 ⇒ 复用 vlm/arbitration 的数学仲裁（IoU 贪心一对一配对、
//     置信度加权凸组合融合框、双源一致加成），本器官只做形态转写 —— center
//     一律由最终 bbox 中点重算（取整权留给点击层）、role 按仲裁输出次序回填
//     vlm 角色（本地信道无角色语义，缺省 'unknown'）、interactive 按 role 三
//     态化（fusion 元素亦按其 vlm 角色）；单源直映；零源诚实记降级 'elements'。
//   · 文本层：ocrText 截 2000 记 textDigest —— 上下文带宽的记账礼仪。
//   · 变化层：snapshotChanged 以十六进制 dhash 汉明距离 + 元素数量突变双闸判
//     「世界是否动了」—— 感知预算的节流阀。
//   · 检索层：findInSnapshot（双向子串 + 置信降序）/ interactiveElements ——
//     决策层问「东西在哪、哪里能点」的两个直达查询口。
// 纪律：纯函数、零网络、零图像依赖（快照不持有像素 —— image 入参只表存在，
// 不入账）、确定性可回放、对一切脏输入绝不抛异常。

import type { Bbox } from '../vlm/codec'
import type { GroundedElement } from '../vlm/grounding'
import type { LocalElement } from '../vlm/arbitration'
import { arbitrateElements } from '../vlm/arbitration'
import { kernelRegistry } from '../kernel/registry'

/** textDigest 截断上限：OCR 全文入快照的带宽上限（防上下文爆炸） */
const TEXT_DIGEST_MAX = 2000
/** snapshotChanged 缺省汉明容差：dhash 距离 ≤ 3 视为像素未动 */
const DEFAULT_HAMMING_TOLERANCE = 3
/** findInSnapshot 缺省返回上限 */
const DEFAULT_FIND_LIMIT = 5

/** 已知可交互角色集：命中 ⇒ interactive=true（VLM 角色语义的可点清单） */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'input',
  'select',
  'menu',
  'tab',
])

/** 半字节 popcount 表（0..15 的置位数）：hammingHex 的查表核 */
const NIBBLE_POPCOUNT: readonly number[] = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4]

/** 快照元素：仲裁后的世界成员 —— 标签/角色/框/中心/置信/来源 + 可交互三态。 */
export interface SnapshotElement {
  /** 元素可见文字/语义标签（融合时取置信高者、平票归 VLM —— 仲裁律①） */
  label: string
  /** 元素角色：vlm 优先；本地信道无角色语义，缺省 'unknown' */
  role: string
  /** 像素包围盒（融合元素为置信度加权凸组合框 —— 永落两框凸包内） */
  bbox: Bbox
  /** 包围盒几何中心（由最终 bbox 中点重算 —— 点击层的落点基准） */
  center: { x: number; y: number }
  /** 置信度 ∈ [0,1]（融合元素含双源一致加成，封顶于 1） */
  confidence: number
  /** 证据来源：'vlm'=云脑单源、'local'=本地单源、'fusion'=双源一致 */
  source: 'vlm' | 'local' | 'fusion'
  /** 可交互三态：已知可点 ⇒ true；已知纯文本 ⇒ false；证据不足 ⇒ null */
  interactive: boolean | null
}

/** 世界快照：一次感知合成后的总账 —— 环的全部成员 + 文本/弹窗/焦点/场景注记 + 降级清单。 */
export interface WorldSnapshot {
  /** 快照拍下时刻（inputs.now 或合成时刻的 Date.now()，毫秒纪元） */
  takenAt: number
  /** 世界宽度（像素） */
  width: number
  /** 世界高度（像素） */
  height: number
  /** 感知指纹（十六进制 dhash）；null = 本次未取得（degraded 记 'dhash'） */
  dhash: string | null
  /** 仲裁后的世界成员表（vlm 序在前、本地单源殿后 —— 仲裁契约次序） */
  elements: SnapshotElement[]
  /** OCR 文本摘要（ocrText 截 2000）；缺席时为 ''（degraded 记 'ocr'） */
  textDigest: string
  /** 弹窗注记（popupNotes 去空串） */
  popups: string[]
  /** 焦点区（透传 focusRegion；缺席 null） */
  focusedRegion: Bbox | null
  /** 场景标签（透传 sceneLabel；缺省 ''） */
  sceneLabel: string
  /** 降级清单：'elements' | 'ocr' | 'dhash' —— 本次合成缺席的证据源 */
  degraded: string[]
}

/** 感知输入：一次多源证据的打包（除 width/height 外全部可缺席 —— 缺谁记谁降级）。 */
export interface PerceptionInputs {
  /** 截图像素（在场性标记 —— 快照不持有像素，本字段不参与任何合成） */
  image?: Buffer
  width: number
  height: number
  /** 感知指纹（十六进制 dhash）；null/缺席 ⇒ degraded 记 'dhash' */
  dhash?: string | null
  /** 云端接地元素源（GroundedElement） */
  vlmElements?: GroundedElement[]
  /** 本地感知元素源（OCR / UIA） */
  localElements?: LocalElement[]
  /** OCR 全文（缺席 ⇒ degraded 记 'ocr'） */
  ocrText?: string
  /** 弹窗注记（去空串后入 popups） */
  popupNotes?: string[]
  /** 焦点区（透传 focusedRegion） */
  focusRegion?: Bbox | null
  /** 场景标签（缺省 ''） */
  sceneLabel?: string
  /** 快照时刻注入（测试确定性用）；缺省 Date.now() */
  now?: number
}

// ─── 内部纯函数工具（零副作用、零异常） ───

/** 数字卫兵：非有限数字一律按 0 记（脏坐标不出 NaN、不炸管线） */
const finiteOr0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * bbox 几何中心：((x0+x1)/2, (y0+y1)/2)。非有限坐标按 0 记 —— 对倒置/压扁
 * 框亦不抛错（与 vlm/arbitration 的零面积约定同源的宽容律）。
 */
function centerOf(bbox: Bbox): { x: number; y: number } {
  const b = (bbox && typeof bbox === 'object' ? bbox : {}) as Partial<Bbox>
  return { x: (finiteOr0(b.x0) + finiteOr0(b.x1)) / 2, y: (finiteOr0(b.y0) + finiteOr0(b.y1)) / 2 }
}

/**
 * 可交互三态律：role ∈ {button,link,input,select,menu,tab} ⇒ true；
 * role === 'text' ⇒ false；其余（含 'unknown'）⇒ null（证据不足，不猜）。
 */
function interactiveOf(role: string): boolean | null {
  if (INTERACTIVE_ROLES.has(role)) return true
  if (role === 'text') return false
  return null
}

/** 角色卫兵：非字符串/空串 ⇒ 'unknown'（「vlm 优先、缺省 unknown」的执法点） */
function roleOr(role: unknown): string {
  return typeof role === 'string' && role.length > 0 ? role : 'unknown'
}

/**
 * 检索折叠：小写化 + 连续空白折叠为单空格 + 去首尾空白 —— 大小写不敏感、
 * 空白不敏感比较的统一前置（query 与 label 同律折叠后再比）。
 */
function foldText(s: unknown): string {
  return typeof s === 'string' ? s.toLowerCase().replace(/\s+/g, ' ').trim() : ''
}

/** 指纹卫兵：非字符串/空串按 null 记（无效指纹 = 无指纹） */
function validDhash(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/**
 * 十六进制 dhash 汉明距离：逐字符 nibble XOR 后查表累加置位数。
 * 返回 null 表示「不可比」（长度不一或非十六进制字符）—— 调用方按宽松律处理。
 */
function hammingHex(a: string, b: string): number | null {
  if (a.length !== b.length) return null
  let dist = 0
  for (let i = 0; i < a.length; i++) {
    const x = Number.parseInt(a[i], 16)
    const y = Number.parseInt(b[i], 16)
    if (Number.isNaN(x) || Number.isNaN(y)) return null
    dist += NIBBLE_POPCOUNT[x ^ y]
  }
  return dist
}

/**
 * 元素形态转写：仲裁/单源元素 → 快照元素。role 由调用方裁决（vlm 优先律），
 * center 一律由 bbox 中点重算（不信任直通值），label/confidence 做脏值卫兵。
 */
function toElement(
  base: { label?: unknown; bbox?: Bbox; confidence?: unknown },
  source: SnapshotElement['source'],
  role: string,
): SnapshotElement {
  const bbox: Bbox =
    base.bbox && typeof base.bbox === 'object' ? base.bbox : { x0: 0, y0: 0, x1: 0, y1: 0 }
  return {
    label: typeof base.label === 'string' ? base.label : '',
    role,
    bbox,
    center: centerOf(bbox),
    confidence: finiteOr0(base.confidence),
    source,
    interactive: interactiveOf(role),
  }
}

// ─── 导出器官 ───

/**
 * 感知合成主入口：多源证据 → 一张世界快照（纯函数、绝不抛异常）。
 *
 * 元素裁决律：
 *   · 双源（vlmElements 与 localElements 皆非空）⇒ arbitrateElements 数学仲裁
 *     （数值细节全由兄弟器官裁决，本器官只做形态转写）。仲裁输出次序为契约
 *     行为 —— vlm 序（融合与 VLM 单源混排）在前、本地单源殿后 —— 故结果前
 *     vlmList.length 个恰与 vlm 序一一对应，据此回填 vlm 角色；本地单源元素
 *     无角色语义，记 'unknown'；interactive 按 role 三态化（fusion 亦同律）。
 *   · 单源 ⇒ 直映（source 记该侧；role 仍 vlm 优先/缺省 'unknown'）。
 *   · 零源 ⇒ elements:[] 且 degraded 记 'elements'（无证据不伪造）。
 *
 * 其余记账：ocrText 缺席 ⇒ degraded 记 'ocr'（在场则截 2000 为 textDigest）；
 * dhash 无效（缺席/空串）⇒ 透传 null 并记 'dhash'；popups 为 popupNotes 去空串；
 * sceneLabel 缺省 ''；focusedRegion 透传（缺席 null）；takenAt 取 now（缺省
 * Date.now()）；image 缺席不管 —— 快照不持有像素。脏输入（非数组/非字符串/
 * NaN）一律卫兵式收敛，绝不抛错。
 */
export function composeSnapshot(inputs: PerceptionInputs): WorldSnapshot {
  const degraded: string[] = []
  const vlmList: GroundedElement[] = Array.isArray(inputs?.vlmElements) ? inputs.vlmElements : []
  const localList: LocalElement[] = Array.isArray(inputs?.localElements) ? inputs.localElements : []

  let elements: SnapshotElement[]
  if (vlmList.length > 0 && localList.length > 0) {
    // 双源 ⇒ 仲裁融合。次序对齐：结果前 vlmList.length 位 ↔ vlm 序（角色回填锚点）
    // 纪元 Θ（Θ-4 生产接线）：仲裁参数显式传内核注册表现值 —— 未注册时
    // getOrDefault 回声 0.5 / 0.15（与 arbitrateElements 自身缺省同律），零行为变化。
    const verdict = arbitrateElements(vlmList, localList, {
      iouThreshold: kernelRegistry.getOrDefault('arbitration.iouThreshold', 0.5),
      agreementBonus: kernelRegistry.getOrDefault('arbitration.agreementBonus', 0.15),
    })
    const out = Array.isArray(verdict?.elements) ? verdict.elements : []
    elements = out.map((e, i) => {
      const source: SnapshotElement['source'] =
        e.source === 'local' || e.source === 'fusion' ? e.source : 'vlm'
      const role = i < vlmList.length ? roleOr(vlmList[i]?.role) : 'unknown'
      return toElement(e, source, role)
    })
  } else if (vlmList.length > 0) {
    elements = vlmList.map((v) => toElement(v, 'vlm', roleOr(v?.role)))
  } else if (localList.length > 0) {
    elements = localList.map((l) => toElement(l, 'local', 'unknown'))
  } else {
    elements = []
    degraded.push('elements')
  }

  // OCR：缺席记降级；在场截 2000（上下文带宽礼仪）
  const ocrRaw = inputs?.ocrText
  if (typeof ocrRaw !== 'string') degraded.push('ocr')
  const textDigest = typeof ocrRaw === 'string' ? ocrRaw.slice(0, TEXT_DIGEST_MAX) : ''

  // dhash：透传；无效指纹按 null 记并降级
  const dhash = validDhash(inputs?.dhash)
  if (dhash === null) degraded.push('dhash')

  // 弹窗注记：去空串（空注记不是证据，是噪声）
  const popups = (Array.isArray(inputs?.popupNotes) ? inputs.popupNotes : []).filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  )

  const now =
    typeof inputs?.now === 'number' && Number.isFinite(inputs.now) ? inputs.now : Date.now()
  return {
    takenAt: now,
    width: finiteOr0(inputs?.width),
    height: finiteOr0(inputs?.height),
    dhash,
    elements,
    textDigest,
    popups,
    focusedRegion: inputs?.focusRegion ?? null,
    sceneLabel: typeof inputs?.sceneLabel === 'string' ? inputs.sceneLabel : '',
    degraded,
  }
}

/**
 * 世界是否动了：prev/curr 两张快照的变化判决（纯函数、绝不抛异常）。
 * 判决级联（自上而下短路）：
 *   ① prev=null ⇒ true（首见世界必为「变」—— 没有旧世界可比）；
 *   ② 任一侧 dhash 缺席（null/空）⇒ true —— 指纹缺席时宽松判变：宁可重看，
 *      不可漏看；
 *   ③ 指纹不可比（长度不一/非十六进制字符）⇒ true（与②同源的宽松律）；
 *   ④ 十六进制 dhash 汉明距离 > hammingTolerance（缺省 3，负数/非有限数按
 *      缺省记）⇒ true —— 像素级运动超容差；
 *   ⑤ 指纹判同（距离 ≤ 容差）但 elements 数量突变 >30% ⇒ true —— 结构性
 *      变化。整数安全式 |Δn|×10 > 3×max(n_prev, n_curr)，分母取双侧最大：
 *      对称、且对 0→N 零除免疫（恰落 30% 线为排他边界，不算变）；
 *   ⑥ 否则 false。
 */
export function snapshotChanged(
  prev: WorldSnapshot | null,
  curr: WorldSnapshot,
  hammingTolerance?: number,
): boolean {
  if (prev === null || prev === undefined) return true
  // 纪元 Θ（Θ-4 生产接线）：缺省容差读内核注册表（world.hammingTolerance，
  // 区间 [1,8]）—— 未注册 ⇒ getOrDefault 回声 DEFAULT_HAMMING_TOLERANCE(3)，
  // 行为逐字节不变；显式入参仍最高优先。runtime 调用处不传参 ⇒ 经此缺省缝
  // 读注册表（接线二选一：本缺省接法 + runtime 不动）。
  const tolerance =
    typeof hammingTolerance === 'number' && Number.isFinite(hammingTolerance) && hammingTolerance >= 0
      ? hammingTolerance
      : kernelRegistry.getOrDefault('world.hammingTolerance', DEFAULT_HAMMING_TOLERANCE)
  const prevHash = validDhash(prev.dhash)
  const currHash = validDhash(curr?.dhash)
  if (prevHash === null || currHash === null) return true
  const distance = hammingHex(prevHash, currHash)
  if (distance === null) return true
  if (distance > tolerance) return true
  const prevCount = Array.isArray(prev.elements) ? prev.elements.length : 0
  const currCount = Array.isArray(curr?.elements) ? curr.elements.length : 0
  if (Math.abs(currCount - prevCount) * 10 > 3 * Math.max(prevCount, currCount)) return true
  return false
}

/**
 * 在快照中找东西：大小写不敏感 + 空白折叠后的**双向子串**匹配 —— query 含于
 * label（全名指物）或 label 含于 query（物名不全，如「打开设置面板」命中
 * 「设置」）。命中按 confidence 降序（同分保持快照原序 —— 稳定排序），截
 * opts.limit（缺省 5；负数/非有限数按缺省记）。不按 role 筛选 —— 角色过滤
 * 交给调用方与 interactiveElements 组合使用。空 query / 空标签不入检索：
 * 检索要具体的证据，不做全集匹配。纯函数（sort 作用于过滤副本）、绝不抛异常。
 */
export function findInSnapshot(
  snap: WorldSnapshot,
  query: string,
  opts?: { limit?: number },
): SnapshotElement[] {
  const pool: SnapshotElement[] = snap && Array.isArray(snap.elements) ? snap.elements : []
  const q = foldText(query)
  if (q.length === 0) return []
  const limit =
    typeof opts?.limit === 'number' && Number.isFinite(opts.limit) && opts.limit >= 0
      ? Math.floor(opts.limit)
      : DEFAULT_FIND_LIMIT
  return pool
    .filter((el) => {
      const label = foldText(el?.label)
      if (label.length === 0) return false // 无标签元素不可名状，不入检索
      return label.includes(q) || q.includes(label)
    })
    .sort((a, b) => finiteOr0(b?.confidence) - finiteOr0(a?.confidence))
    .slice(0, limit)
}

/**
 * 快照中已知可交互的元素（interactive === true 的三态过滤）：已知纯文本
 * （false）与证据不足（null）皆不入选 —— 点击层只消费「确定能点」的清单。
 * 次序保持快照原序；纯函数、绝不抛异常。
 */
export function interactiveElements(snap: WorldSnapshot): SnapshotElement[] {
  const pool: SnapshotElement[] = snap && Array.isArray(snap.elements) ? snap.elements : []
  return pool.filter((el) => el?.interactive === true)
}
