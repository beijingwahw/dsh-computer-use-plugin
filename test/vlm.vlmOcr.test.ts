// test/vlm.vlmOcr.test.ts
// 纪元 Ω（Ω-5 · 云脑 OCR）：vlmOcr 全本地验证 —— 假 client / 假 fetch 注入，绝不联网。
// 覆盖：未配置降级（零网络）、words 解析与坐标换算（bbox 4 元数组→对象→中心）、
// region 像素裁剪透传、阅读序排序稳定性、findText 大小写/空白容忍匹配、
// 逐词校验丢弃律、chatJson 失败降级、真 GlmClient（假 fetch）端到端。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GlmClient, resetGlmClient,
  type GlmClient as GlmClientLike,
} from '../src/vlm/glmClient.ts';

const { readTextViaVlm, findTextViaVlm } = await import('../src/vlm/vlmOcr.ts');
const { default: sharp } = await import('sharp');

// ─── 假件工坊 ───

/** 假 chatJson 响应 —— 与 GlmClient.chatJson 契约同构（value = extractGlmJson 之后的解析值） */
interface ChatJsonResp { ok: boolean; value?: unknown; error?: string; raw: string }

/** vlmOcr 实际下发的请求形态（vlmOcr 只依赖这两个字段） */
interface CapturedCall { prompt: string; images: Array<{ base64: string; mime?: string }> }

/** 注入用假 client —— 只实现 vlmOcr 消费的 chatJson，并捕获每次请求 */
function fakeClient(
  respond: (call: CapturedCall) => ChatJsonResp | Promise<ChatJsonResp>,
): { client: GlmClientLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const stub = {
    chatJson: async (req: { prompt?: unknown; images?: unknown }): Promise<ChatJsonResp> => {
      const call: CapturedCall = {
        prompt: typeof req.prompt === 'string' ? req.prompt : '',
        images: Array.isArray(req.images) ? (req.images as CapturedCall['images']) : [],
      };
      calls.push(call);
      return respond(call);
    },
  };
  return { client: stub as unknown as GlmClientLike, calls };
}

/** words JSON 包装：chatJson 成功时的 value 形态 */
function wordsValue(words: unknown[]): { words: unknown[] } {
  return { words };
}

/** 假 fetch —— 返回 OpenAI 兼容 chat completion（content 可控）；绝不联网 */
function fakeFetchWithContent(content: string): typeof fetch {
  return (async () => new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )) as unknown as typeof fetch;
}

/** sharp 现场生成纯色测试 PNG（内容不重要 —— 假 client 不看像素，只走真实编码管线） */
async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer();
}

// ─── Ω-5a 未配置降级（零网络） ───

test('Ω-5a: 未配置且未注入 client ⇒ 零网络降级（ok:false + degraded:true，空词表 + error）', async () => {
  const keys = ['GLM_API_KEY', 'ZHIPUAI_API_KEY', 'ZAI_API_KEY'] as const;
  const saved = keys.map(k => [k, process.env[k]] as const);
  try {
    for (const k of keys) delete process.env[k];
    resetGlmClient(); // 清掉可能的已配置单例，保证 isGlmConfigured 走环境变量重探测
    const buf = await makePng(80, 60);

    const r = await readTextViaVlm(buf);
    assert.equal(r.ok, false);
    assert.equal(r.degraded, true);
    assert.equal(r.text, '');
    assert.deepEqual(r.words, []);
    assert.ok(r.error, 'error 必有失败原因');
    assert.ok(Number.isFinite(r.latencyMs) && r.latencyMs >= 0);

    const f = await findTextViaVlm(buf, 'anything');
    assert.equal(f.ok, false);
    assert.equal(f.degraded, true);
    assert.deepEqual(f.matches, []);
    assert.ok(f.error);
  } finally {
    for (const [k, v] of saved) { if (v !== undefined) process.env[k] = v; }
    resetGlmClient();
  }
});

// ─── Ω-5b words 解析与坐标换算 ───

test('Ω-5b: words 解析与坐标换算 —— bbox 4 元数组→对象、center=几何中心、confidence 夹 [0,1]、text 去空白', async () => {
  const { client, calls } = fakeClient(() => ({
    ok: true, raw: '',
    value: wordsValue([
      { text: '  Hello ', confidence: 1.7, bbox: [10, 20, 110, 60] },   // 带空白词 + 越界置信度
      { text: 'World', confidence: '0.9', bbox: { x0: 200, y0: 220, x1: 280, y1: 260 } }, // 对象方言 + 数字串置信度
    ]),
  }));
  const r = await readTextViaVlm(await makePng(400, 300), { client });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, false);
  assert.equal(r.error, undefined);
  assert.equal(r.latencyMs >= 0, true);
  assert.equal(r.text, 'Hello World');
  assert.equal(r.words.length, 2);
  const [hello, world] = r.words;
  assert.equal(hello.text, 'Hello');                       // 去首尾空白
  assert.equal(hello.confidence, 1);                       // 1.7 夹到上界 1
  assert.deepEqual(hello.bbox, { x0: 10, y0: 20, x1: 110, y1: 60 }); // 数组→对象
  assert.deepEqual(hello.center, { x: 60, y: 40 });        // 几何中心
  assert.equal(world.text, 'World');
  assert.equal(world.confidence, 0.9);                     // 数字串方言也收
  assert.deepEqual(world.bbox, { x0: 200, y0: 220, x1: 280, y1: 260 }); // 对象形态直收
  assert.deepEqual(world.center, { x: 240, y: 240 });
  // 请求形态：单图（真编码管线的 base64）+ som 的 OCR 铁律提示词透传
  assert.equal(calls.length, 1);
  assert.equal(calls[0].images.length, 1);
  assert.ok(calls[0].images[0].base64.length > 100, '真实编码后的 base64 应非空');
  assert.ok(calls[0].prompt.includes('words'), 'buildOcrPrompt 提示词应透传到 chatJson');
});

test('Ω-5b: region 像素裁剪透传 —— 模型收到的图即 region 子图（宽高 = x1-x0 / y1-y0）', async () => {
  const { client, calls } = fakeClient(() => ({ ok: true, raw: '', value: wordsValue([]) }));
  await readTextViaVlm(await makePng(400, 300), {
    region: { x0: 10, y0: 20, x1: 110, y1: 170 },
    client,
  });
  assert.equal(calls.length, 1);
  const meta = await sharp(Buffer.from(calls[0].images[0].base64, 'base64')).metadata();
  assert.equal(meta.width, 100);
  assert.equal(meta.height, 150);
});

// ─── Ω-5c 阅读序排序稳定性 ───

test('Ω-5c: 排序稳定性 —— 按 center.y 再 center.x；同键词保持模型原序', async () => {
  const { client } = fakeClient(() => ({
    ok: true, raw: '',
    value: wordsValue([
      { text: 'b', confidence: 0.9, bbox: [300, 100, 320, 120] }, // 行1 右（模型先给）
      { text: 'a', confidence: 0.9, bbox: [100, 100, 120, 120] }, // 行1 左（应排到 b 前）
      { text: 'tie-z', confidence: 0.9, bbox: [50, 200, 70, 220] }, // 行2 与 tie-y 同键
      { text: 'tie-y', confidence: 0.9, bbox: [50, 200, 70, 220] }, // 同键 —— 稳定保持原序
      { text: 'top', confidence: 0.9, bbox: [0, 0, 40, 20] },    // 行0
    ]),
  }));
  const r = await readTextViaVlm(await makePng(400, 300), { client });
  assert.deepEqual(
    r.words.map(w => w.text),
    ['top', 'a', 'b', 'tie-z', 'tie-y'],
  );
  assert.equal(r.text, 'top a b tie-z tie-y'); // text 与 words 同序空格连接
});

// ─── Ω-5d findText 匹配律 ───

test('Ω-5d: findText 匹配律 —— 大小写不敏感 + 空白差异容忍；命中返回中心；无命中 ok:true 空数组', async () => {
  const { client, calls } = fakeClient(() => ({
    ok: true, raw: '',
    value: wordsValue([
      { text: 'Save Changes', confidence: 0.95, bbox: [10, 10, 130, 40] },
      { text: 'CANCEL', confidence: 0.9, bbox: [150, 10, 220, 40] },
      { text: 'Discard  Changes', confidence: 0.85, bbox: [10, 60, 160, 90] }, // 图中双空格
      { text: 'OK', confidence: 0.99, bbox: [10, 110, 40, 140] },
    ]),
  }));
  const buf = await makePng(300, 200);

  // 大小写不敏感 + 查询词自身带空白
  const byCase = await findTextViaVlm(buf, '  cancel  ', { client });
  assert.equal(byCase.ok, true);
  assert.equal(byCase.degraded, false);
  assert.deepEqual(byCase.matches, [{ text: 'CANCEL', center: { x: 185, y: 25 }, confidence: 0.9 }]);

  // 空白差异容忍：单空格查询命中图中双空格词；命中文本保留原文
  const spaced = await findTextViaVlm(buf, 'discard changes', { client });
  assert.equal(spaced.matches.length, 1);
  assert.equal(spaced.matches[0].text, 'Discard  Changes');
  assert.deepEqual(spaced.matches[0].center, { x: 85, y: 75 });

  // 子串跨多词命中，按阅读序返回
  const multi = await findTextViaVlm(buf, 'changes', { client });
  assert.deepEqual(multi.matches.map(m => m.text), ['Save Changes', 'Discard  Changes']);
  assert.deepEqual(multi.matches[0].center, { x: 70, y: 25 });

  // 无命中：识别成功但词不匹配不是失败
  const none = await findTextViaVlm(buf, 'NoSuchWord', { client });
  assert.equal(none.ok, true);
  assert.equal(none.degraded, false);
  assert.deepEqual(none.matches, []);

  // 空白查询不匹配一切（防误命中），且不发请求
  const before = calls.length;
  const blank = await findTextViaVlm(buf, '   ', { client });
  assert.equal(blank.ok, true);
  assert.deepEqual(blank.matches, []);
  assert.equal(calls.length, before, '空白查询应短路，不触云脑');

  // findQuery 聚焦透传：带查询词的提示词 ≠ 无查询词的提示词（som 契约）
  await readTextViaVlm(buf, { client });
  assert.equal(calls.length, before + 1);
  assert.notEqual(calls[0].prompt, calls[calls.length - 1].prompt);
});

// ─── Ω-5e 逐词校验丢弃律 ───

test('Ω-5e: 逐词校验 —— 空白词/非字符串 text/残缺 bbox 丢弃，NaN 置信度压 0，端点倒序摆正', async () => {
  const { client } = fakeClient(() => ({
    ok: true, raw: '',
    value: wordsValue([
      { text: '   ', confidence: 0.9, bbox: [0, 0, 10, 10] },        // 纯空白 → 弃
      { text: 42, confidence: 0.9, bbox: [0, 0, 10, 10] },           // text 非字符串 → 弃
      { text: 'no-bbox', confidence: 0.9 },                          // bbox 缺席 → 弃
      { text: 'bad-bbox', confidence: 0.9, bbox: [1, 2, 'x', 4] },   // bbox 含非数 → 弃
      null, 'junk',                                                  // 非对象元素 → 弃
      { text: 'nan-conf', confidence: 'abc', bbox: [0, 0, 10, 10] }, // NaN 置信度 → 压 0 保留
      { text: 'swapped', confidence: 0.5, bbox: [120, 30, 100, 50] }, // 端点倒序 → 摆正保留
    ]),
  }));
  const r = await readTextViaVlm(await makePng(200, 100), { client });
  assert.equal(r.ok, true);
  assert.deepEqual(r.words.map(w => w.text), ['nan-conf', 'swapped']);
  assert.equal(r.words[0].confidence, 0);
  assert.deepEqual(r.words[1].bbox, { x0: 100, y0: 30, x1: 120, y1: 50 });
  assert.equal(r.text, 'nan-conf swapped');
});

test('Ω-5e: 空 words / 裸数组方言 / 意外负载 —— ok:true 宁可空不可错', async () => {
  const buf = await makePng(60, 40);
  const empty = fakeClient(() => ({ ok: true, raw: '', value: { words: [] } }));
  const r0 = await readTextViaVlm(buf, { client: empty.client });
  assert.equal(r0.ok, true);
  assert.equal(r0.degraded, false);
  assert.deepEqual(r0.words, []);
  assert.equal(r0.text, '');

  const bare = fakeClient(() => ({
    ok: true, raw: '',
    value: [{ text: 'Bare', confidence: 0.7, bbox: [1, 1, 21, 11] }], // 裸数组方言
  }));
  const r1 = await readTextViaVlm(buf, { client: bare.client });
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.words.map(w => w.text), ['Bare']);

  const junk = fakeClient(() => ({ ok: true, raw: '', value: { unexpected: true } }));
  const r2 = await readTextViaVlm(buf, { client: junk.client });
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.words, []);
});

// ─── Ω-5f chatJson 失败降级 ───

test('Ω-5f: chatJson 失败 ⇒ 降级（error 透传），findText 同步降级', async () => {
  const { client } = fakeClient(() => ({ ok: false, error: 'mock glm outage', raw: 'no-json' }));
  const buf = await makePng(100, 80);
  const r = await readTextViaVlm(buf, { client });
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.equal(r.text, '');
  assert.deepEqual(r.words, []);
  assert.match(r.error ?? '', /mock glm outage/);

  const f = await findTextViaVlm(buf, 'target', { client });
  assert.equal(f.ok, false);
  assert.equal(f.degraded, true);
  assert.deepEqual(f.matches, []);
  assert.match(f.error ?? '', /mock glm outage/);
});

test('Ω-5f: 真 GlmClient（假 fetch）端到端 —— 围栏 JSON 解析成功；无 JSON 回复降级', async () => {
  // 成功臂：模型回复带 ```json 围栏（chatJson 的 extractGlmJson 负责剥壳）
  const okClient = new GlmClient({
    apiKey: 'test-key',
    fetchImpl: fakeFetchWithContent('```json\n{"words":[{"text":"Real","confidence":0.8,"bbox":[5,5,55,25]}]}\n```'),
  });
  const r = await readTextViaVlm(await makePng(120, 60), { client: okClient });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, false);
  assert.equal(r.text, 'Real');
  assert.deepEqual(r.words[0].center, { x: 30, y: 15 });

  // 失败臂：回复不含任何 JSON —— chatJson 提取失败 → vlmOcr 降级
  const badClient = new GlmClient({
    apiKey: 'test-key',
    fetchImpl: fakeFetchWithContent('抱歉，我无法识别这张图片。'),
  });
  const f = await readTextViaVlm(await makePng(120, 60), { client: badClient });
  assert.equal(f.ok, false);
  assert.equal(f.degraded, true);
  assert.match(f.error ?? '', /vlm ocr chat failed/);
});
