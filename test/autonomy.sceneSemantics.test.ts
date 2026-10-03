// test/autonomy.sceneSemantics.test.ts
// 纪元 Φ（Φ-6 场景语义理解中枢）：执法册 —— 假 client（chat 返回可控 JSON/围栏/垃圾）、
// 假时钟、sharp 现场小图，纯离线零网络。覆盖：未配置降级零网络、缓存命中（同指纹
// 同问二次调用 vlmCalls 恒 1）、容差内指纹变体命中、过期后重拨、question 不同不
// 命中、失败不缓存、LRU 挤出（>16 张不同指纹）、hammingDistanceHex 数值与
// 不等长、affordances 消毒、invalidate、空 Buffer 降级。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resetGlmClient, type GlmClient as GlmClientLike } from '../src/vlm/glmClient.ts'

const { SceneSemanticsCache, hammingDistanceHex } = await import('../src/autonomy/sceneSemantics.ts')
const { default: sharp } = await import('sharp')

// ─── 假件工坊 ───

/** 假 chat 响应 —— 与 GlmClient.chat 契约同构（sceneSemantics 只消费 ok/text/error） */
interface ChatRespLike { ok: boolean; text: string; error?: string; degraded?: boolean; latencyMs: number; model: string }

/** sceneSemantics 实际下发的请求形态（system 模板 / 用户提示词 / 图像序列） */
interface CapturedCall { system: string; prompt: string; images: Array<{ base64: string; mime?: string }> }

/** 注入用假 client —— 只实现 sceneSemantics 消费的 chat，并捕获每次请求 */
function fakeClient(
  respond: (call: CapturedCall) => ChatRespLike | Promise<ChatRespLike>,
): { client: GlmClientLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  const stub = {
    chat: async (req: { system?: unknown; prompt?: unknown; images?: unknown }): Promise<ChatRespLike> => {
      const call: CapturedCall = {
        system: typeof req.system === 'string' ? req.system : '',
        prompt: typeof req.prompt === 'string' ? req.prompt : '',
        images: Array.isArray(req.images) ? (req.images as CapturedCall['images']) : [],
      }
      calls.push(call)
      return respond(call)
    },
  }
  return { client: stub as unknown as GlmClientLike, calls }
}

/** 标准场景回复 JSON（over 可覆盖任意字段） */
function sceneJson(over?: Record<string, unknown>): string {
  return JSON.stringify({
    sceneLabel: '浏览器购物车页',
    appGuess: '浏览器',
    pageState: '就绪',
    affordances: ['点击结算按钮', '移除商品', '继续购物'],
    confidence: 0.82,
    ...over,
  })
}

/** 成功回复速记 */
const okReply = (text: string): ChatRespLike => ({ ok: true, text, latencyMs: 1, model: 'fake' })

/** sharp 现场生成纯色测试 PNG（内容不重要 —— 假 client 不看像素，只走真实编码管线） */
async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer()
}

// 十六进制指纹工坊：fp('7') = '7'+15 个 0；fpAt(i,'f') = 第 i 个 nibble 置 f
const Z16 = '0'.repeat(16)
const fp = (nib: string): string => nib + '0'.repeat(15)
const fpAt = (idx: number, nib: string): string => '0'.repeat(idx) + nib + '0'.repeat(15 - idx)

// ─── Φ-6-1 hammingDistanceHex 纯函数 ───

test('Φ-6-1: hammingDistanceHex —— nibble 异或 popcount；大小写归一；不等长/空串/非十六进制一律 9999', () => {
  assert.equal(hammingDistanceHex(Z16, Z16), 0, '同串距离 0')
  assert.equal(hammingDistanceHex(fp('7'), Z16), 3, '0^7=0b0111 ⇒ 3 位')
  assert.equal(hammingDistanceHex(fp('f'), Z16), 4, '0^f=0b1111 ⇒ 4 位')
  assert.equal(hammingDistanceHex('7', '8'), 4, '0b0111^0b1000=0b1111 ⇒ 4 位')
  assert.equal(hammingDistanceHex('7', '7'), 0)
  assert.equal(hammingDistanceHex('aBcD', 'abcd'), 0, '大小写不敏感')
  assert.equal(hammingDistanceHex('ab', 'abc'), 9999, '长度不等 ⇒ 哨兵 9999')
  assert.equal(hammingDistanceHex('', ''), 9999, '空串不可比 ⇒ 9999')
  assert.equal(hammingDistanceHex('zz', '00'), 9999, '非十六进制字符 ⇒ 9999')
})

// ─── Φ-6-2 未配置降级（零网络） ───

test('Φ-6-2: 未配置且未注入 client ⇒ 零网络降级（reading:null + degraded:true + error），零拨号零缓存', async () => {
  const keys = ['GLM_API_KEY', 'ZHIPUAI_API_KEY', 'ZAI_API_KEY'] as const
  const saved = keys.map(k => [k, process.env[k]] as const)
  try {
    for (const k of keys) delete process.env[k]
    resetGlmClient() // 清掉可能的已配置单例，保证 isGlmConfigured 走环境变量重探测
    const sem = new SceneSemanticsCache()
    const r = await sem.read(await makePng(80, 60), Z16)
    assert.equal(r.reading, null)
    assert.equal(r.degraded, true)
    assert.equal(r.cached, false)
    assert.ok(r.error, 'error 必有失败原因')
    assert.deepEqual(sem.stats(), { entries: 0, hits: 0, misses: 0, vlmCalls: 0 }, '零网络零缓存动作')
  } finally {
    for (const [k, v] of saved) { if (v !== undefined) process.env[k] = v }
    resetGlmClient()
  }
})

// ─── Φ-6-3 读屏成功 + 缓存命中 ───

test('Φ-6-3: 读屏成功 —— 五字段消毒透出 + 中文 system 模板；同指纹同问二次调用零 VLM（vlmCalls 恒 1）', async () => {
  let t = 1000
  const { client, calls } = fakeClient(() => okReply(sceneJson()))
  const sem = new SceneSemanticsCache({ client, now: () => t })
  const png = await makePng(120, 90)

  const r1 = await sem.read(png, Z16)
  assert.equal(r1.degraded, false)
  assert.equal(r1.cached, false)
  assert.ok(r1.reading)
  assert.equal(r1.reading!.sceneLabel, '浏览器购物车页')
  assert.equal(r1.reading!.appGuess, '浏览器')
  assert.equal(r1.reading!.pageState, '就绪')
  assert.deepEqual(r1.reading!.affordances, ['点击结算按钮', '移除商品', '继续购物'])
  assert.equal(r1.reading!.confidence, 0.82)
  assert.equal(r1.reading!.takenAt, 1000, 'takenAt 取注入时钟')
  assert.equal(r1.reading!.dhash, Z16)

  // 请求形态：单图（真实编码管线的 base64）+ 中文 system 模板含五字段铁律
  assert.equal(calls.length, 1)
  assert.equal(calls[0].images.length, 1)
  assert.ok(calls[0].images[0].base64.length > 100, '真实编码后的 base64 应非空')
  for (const field of ['sceneLabel', 'appGuess', 'pageState', 'affordances', 'confidence']) {
    assert.ok(calls[0].system.includes(field), `system 模板应含 ${field}`)
  }
  assert.ok(calls[0].system.includes('不臆造'), '克制不臆造铁律应在 system 模板中')

  // 同指纹同问二次调用：缓存命中直接回读（takenAt 不刷新 —— 回读的是原条目）
  t = 1500
  const r2 = await sem.read(png, Z16)
  assert.equal(r2.cached, true)
  assert.equal(r2.degraded, false)
  assert.deepEqual(r2.reading, r1.reading)
  assert.deepEqual(sem.stats(), { entries: 1, hits: 1, misses: 1, vlmCalls: 1 })
})

// ─── Φ-6-4 容差边界 ───

test('Φ-6-4: 容差边界 —— 距离 3 命中（零 VLM）、距离 4 未命中重拨（新条目记新指纹）', async () => {
  const { client, calls } = fakeClient(() => okReply(sceneJson()))
  const sem = new SceneSemanticsCache({ client, now: () => 2000 })
  const png = await makePng(60, 40)

  await sem.read(png, Z16)
  const near = await sem.read(png, fp('7')) // 距离 3 ≤ 默认容差
  assert.equal(near.cached, true)
  assert.equal(near.degraded, false)
  assert.equal(calls.length, 1, '容差内变体零重拨')

  const far = await sem.read(png, fp('f')) // 距离 4 > 默认容差
  assert.equal(far.cached, false)
  assert.equal(far.degraded, false)
  assert.equal(far.reading!.dhash, fp('f'), '新条目记调用方的指纹')
  assert.equal(calls.length, 2)
})

// ─── Φ-6-5 过期重拨 ───

test('Φ-6-5: 过期律 —— ttl 内命中；at+ttl 即失效重拨；旧条目懒清缓存不留尸', async () => {
  let t = 5000
  const { client, calls } = fakeClient(() => okReply(sceneJson()))
  const sem = new SceneSemanticsCache({ client, ttlMs: 30000, now: () => t })
  const png = await makePng(60, 40)

  await sem.read(png, Z16) // at = 5000
  t = 5000 + 29999
  assert.equal((await sem.read(png, Z16)).cached, true, 'ttl 内仍命中')

  t = 5000 + 30000
  const stale = await sem.read(png, Z16)
  assert.equal(stale.cached, false, 'at+ttl 即过期（命中不续期）')
  assert.equal(stale.degraded, false)
  assert.equal(calls.length, 2, '过期后重拨')
  assert.deepEqual(sem.stats(), { entries: 1, hits: 1, misses: 2, vlmCalls: 2 }, '旧条目懒清、新条目入账')
})

// ─── Φ-6-6 question 律 ───

test('Φ-6-6: question 律 —— 同问命中、异问不命中、问↔不问互不命中；question 透传到 prompt', async () => {
  const { client, calls } = fakeClient(() => okReply(sceneJson()))
  const sem = new SceneSemanticsCache({ client, now: () => 3000 })
  const png = await makePng(60, 40)

  const r1 = await sem.read(png, Z16, '购物车里有几件商品？')
  assert.equal(r1.cached, false)
  assert.ok(calls[0].prompt.includes('购物车里有几件商品？'), 'question 应透传到用户提示词')

  const r2 = await sem.read(png, Z16, '购物车里有几件商品？')
  assert.equal(r2.cached, true)
  assert.equal(calls.length, 1, '同屏同问 ⇒ 零重拨')

  const r3 = await sem.read(png, Z16, '总价是多少？')
  assert.equal(r3.cached, false, '异问不命中')
  assert.equal(calls.length, 2)
  assert.ok(calls[1].prompt.includes('总价是多少？'))

  const r4 = await sem.read(png, Z16) // 无问 vs 有问 —— 不命中
  assert.equal(r4.cached, false)
  assert.equal(calls.length, 3)

  const r5 = await sem.read(png, Z16) // 无问同屏 —— 命中无问条目（组合键互不挤占）
  assert.equal(r5.cached, true)
  assert.equal(calls.length, 3)
  assert.equal(sem.stats().entries, 3, '同屏三问各自成条')
})

// ─── Φ-6-7 失败不缓存 ───

test('Φ-6-7: VLM 失败不缓存 —— 失败不占缓存条目，成功后正常入账生效', async () => {
  let fail = true
  const { client, calls } = fakeClient(() =>
    fail
      ? { ok: false, text: '', error: 'mock glm outage', latencyMs: 1, model: 'fake' }
      : okReply(sceneJson()))
  const sem = new SceneSemanticsCache({ client, now: () => 1 })
  const png = await makePng(60, 40)

  const r1 = await sem.read(png, Z16)
  assert.equal(r1.degraded, true)
  assert.equal(r1.reading, null)
  assert.equal(r1.cached, false)
  assert.match(r1.error ?? '', /mock glm outage/)
  assert.deepEqual(sem.stats(), { entries: 0, hits: 0, misses: 1, vlmCalls: 1 }, '失败不缓存但拨号记账')

  fail = false
  const r2 = await sem.read(png, Z16) // 失败未被缓存 ⇒ 重拨
  assert.equal(r2.cached, false)
  assert.equal(r2.degraded, false)
  assert.ok(r2.reading)

  const r3 = await sem.read(png, Z16) // 成功条目缓存生效
  assert.equal(r3.cached, true)
  assert.equal(calls.length, 2)
})

// ─── Φ-6-8 围栏与垃圾回复 ───

test('Φ-6-8: 围栏 JSON 剥壳成功；垃圾回复（无 JSON）降级且不缓存', async () => {
  const png = await makePng(60, 40)

  const fenced = fakeClient(() => okReply('```json\n' + sceneJson() + '\n```'))
  const semA = new SceneSemanticsCache({ client: fenced.client, now: () => 1 })
  const ra = await semA.read(png, Z16)
  assert.equal(ra.degraded, false)
  assert.equal(ra.reading!.sceneLabel, '浏览器购物车页')

  const junk = fakeClient(() => okReply('抱歉，我无法识别这张截图。'))
  const semB = new SceneSemanticsCache({ client: junk.client, now: () => 1 })
  const rb = await semB.read(png, Z16)
  assert.equal(rb.degraded, true)
  assert.equal(rb.reading, null)
  assert.equal(rb.cached, false)
  assert.match(rb.error ?? '', /json/i)
  assert.equal(semB.stats().entries, 0, '垃圾回复不入缓存')
})

// ─── Φ-6-9 消毒律 ───

test('Φ-6-9: 消毒律 —— affordances 去空串/弃非串/截 8 条；confidence 夹 [0,1]；字符串兜底', async () => {
  const png = await makePng(60, 40)

  // 上界夹取 + affordances 全消毒 + 字符串兜底（appGuess 去空白 / pageState 缺席兜 ''）
  const upper = fakeClient(() => okReply(sceneJson({
    sceneLabel: 123,               // 非字符串 ⇒ 兜 ''
    appGuess: '  浏览器  ',         // 去首尾空白
    pageState: undefined,          // 缺席 ⇒ 兜 ''
    affordances: ['', '   ', 42, null, '点结算', '删商品', '回购物', '继续逛', '用优惠券', '改数量', '收藏店铺', '问客服', '九', '十', '十一'], // 10 个有效 ⇒ 截 8
    confidence: 1.9,               // 夹上界
  })))
  const semA = new SceneSemanticsCache({ client: upper.client, now: () => 1 })
  const ra = await semA.read(png, Z16)
  assert.equal(ra.reading!.sceneLabel, '')
  assert.equal(ra.reading!.appGuess, '浏览器')
  assert.equal(ra.reading!.pageState, '')
  assert.deepEqual(ra.reading!.affordances, ['点结算', '删商品', '回购物', '继续逛', '用优惠券', '改数量', '收藏店铺', '问客服'])
  assert.equal(ra.reading!.confidence, 1)

  // 下界夹取
  const lower = fakeClient(() => okReply(sceneJson({ confidence: -0.5 })))
  const semB = new SceneSemanticsCache({ client: lower.client, now: () => 1 })
  assert.equal((await semB.read(png, fp('1'))).reading!.confidence, 0)

  // 非法 confidence（NaN）压 0；appGuess 缺席兜 '未知'；affordances 非数组兜 []
  const nanish = fakeClient(() => okReply(sceneJson({ appGuess: undefined, affordances: '点这里', confidence: 'abc' })))
  const semC = new SceneSemanticsCache({ client: nanish.client, now: () => 1 })
  const rc = await semC.read(png, fp('2'))
  assert.equal(rc.reading!.appGuess, '未知')
  assert.deepEqual(rc.reading!.affordances, [])
  assert.equal(rc.reading!.confidence, 0, 'NaN 置信度压 0')
})

// ─── Φ-6-10 LRU 挤出 ───

test('Φ-6-10: LRU 挤出 —— 容量 16：第 17 张不同指纹挤走最旧；最近条目仍命中', async () => {
  const { client, calls } = fakeClient(() => okReply(sceneJson()))
  const sem = new SceneSemanticsCache({ client, now: () => 7 })
  const png = await makePng(32, 32)

  // 17 个两两汉明距离 ≥ 4 的指纹：全零基 + 16 个单 nibble 置 f（4 位差异）
  const fps = [Z16, ...Array.from({ length: 16 }, (_, i) => fpAt(i, 'f'))]
  assert.equal(fps.length, 17)
  for (const f of fps) {
    const r = await sem.read(png, f)
    assert.equal(r.cached, false, '不同指纹两两超容差 ⇒ 全未命中')
  }
  assert.deepEqual(sem.stats(), { entries: 16, hits: 0, misses: 17, vlmCalls: 17 }, '第 17 条挤走最旧')

  const evicted = await sem.read(png, fps[0]!) // 最旧（全零基）已被挤出 ⇒ 重拨
  assert.equal(evicted.cached, false)
  assert.equal(calls.length, 18)

  const recent = await sem.read(png, fps[16]!) // 最近条目仍命中
  assert.equal(recent.cached, true)
  assert.equal(calls.length, 18)
  assert.deepEqual(sem.stats(), { entries: 16, hits: 1, misses: 18, vlmCalls: 18 })
})

// ─── Φ-6-11 invalidate 与脏输入 ───

test('Φ-6-11: invalidate 清空条目后同指纹必重拨；空 Buffer 有 client 也降级零拨号；空指纹可读屏但不缓存', async () => {
  const { client, calls } = fakeClient(() => okReply(sceneJson()))
  const sem = new SceneSemanticsCache({ client, now: () => 9 })
  const png = await makePng(40, 30)

  await sem.read(png, Z16)
  assert.equal(sem.stats().entries, 1)
  sem.invalidate()
  assert.equal(sem.stats().entries, 0)
  const r = await sem.read(png, Z16)
  assert.equal(r.cached, false)
  assert.equal(calls.length, 2, '清空后必重拨')

  // 空 Buffer：有 client 也诚实降级（编码前拦截，零拨号）——指纹取距缓存条目 4 的远端，避免误命中
  const empty = await sem.read(Buffer.alloc(0), fp('f'))
  assert.equal(empty.degraded, true)
  assert.equal(empty.reading, null)
  assert.match(empty.error ?? '', /empty image buffer/)

  // 空 dhash：无键可依 —— 仍可读屏，但不查也不写缓存
  const nokey = await sem.read(png, '')
  assert.equal(nokey.degraded, false)
  assert.equal(nokey.cached, false)
  assert.ok(nokey.reading)
  const entriesBefore = sem.stats().entries
  await sem.read(png, '   ') // 纯空白指纹同理
  assert.equal(sem.stats().entries, entriesBefore, '非法指纹不入缓存')
})
