// test/r21.qwenCoordDomain.test.ts
// R2-1：qwen3-vl 系 0-1000 归一化坐标域反算层契约测试。
// 铁律：绝不真实联网 —— 一切 fetch 经 fetchImpl 注入假实现。
// 金样来源 R1-9 实弹（qwen3-vl-plus · 640×400 合成按钮 · 真值 rect(240,160)-
// (400,220) center(320,190)）：裸回执 bbox [372,394,625,548]（0-1000 域 + 文本
// 谎称像素）——插件原样消费（clampBbox 后）中心误差 273px/IoU=0；经反算层
// ×(640/1000, 400/1000) ⇒ [238.08,157.6,400,219.2] ⇒ 中心误差 1.9px/IoU≈0.94。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import type { GlmVisionRequest } from '../src/vlm/glmClient.ts';
import { clampBbox } from '../src/vlm/bbox.ts';

const glm = await import('../src/vlm/glmClient.ts');

// ─── 环境隔离：抹掉全部平台 envKeys（与 vlm.glmClient.test.ts 同律） ───
const ENV_KEYS = [
  'GLM_API_KEY', 'ZHIPUAI_API_KEY', 'ZAI_API_KEY', 'GLM_BASE_URL', 'GLM_VLM_MODEL',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'DASHSCOPE_API_KEY', 'ALIYUN_API_KEY', 'MOONSHOT_API_KEY', 'ARK_API_KEY',
  'VOLCENGINE_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY', 'SILICONFLOW_API_KEY',
  'OPENROUTER_API_KEY',
] as const;
const savedEnv = new Map<string, string | undefined>();
for (const k of ENV_KEYS) {
  savedEnv.set(k, process.env[k]);
  delete process.env[k];
}
after(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  glm.resetGlmClient();
});

// ─── 测试素材工厂 ───

/** 合成 PNG 头（魔数 + IHDR 宽高）—— 反算层的尺寸解析只读前 24 字节 */
function pngB64(width: number, height: number): string {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); // PNG 魔数
  b.writeUInt32BE(13, 8);      // IHDR 段长
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b.toString('base64');
}

/** 合成 JPEG 头（SOI + SOF0 段载宽高）—— codec 生产路径恒出 JPEG */
function jpegB64(width: number, height: number): string {
  const b = Buffer.alloc(32);
  b[0] = 0xff; b[1] = 0xd8;                 // SOI
  b[2] = 0xff; b[3] = 0xc0;                 // SOF0 marker
  b.writeUInt16BE(17, 4);                    // 段长
  b[8] = 0x08;                               // 精度
  b.writeUInt16BE(height, 7);
  b.writeUInt16BE(width, 9);
  return b.toString('base64');
}

/** 非图脏 base64（解码为可打印 ASCII，无 PNG/JPEG 魔数） */
const GARBAGE_B64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVoxMjM0NTY3OA==';

/** 假 fetch：回放一条 openai 方言 chat 成功回执（content 可控） */
function fakeChat(content: string): { fetchImpl: typeof fetch; calls: Array<{ url: string; body: any }> } {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 300, completion_tokens: 60 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function visionReq(b64: string, mime = 'image/png'): GlmVisionRequest {
  return { images: [{ base64: b64, mime }], prompt: '列出元素', timeoutMs: 500 };
}

/** 欧氏中心误差（bbox → center vs 真值） */
function centerErr(bbox: { x0: number; y0: number; x1: number; y1: number }, tx: number, ty: number): number {
  return Math.hypot((bbox.x0 + bbox.x1) / 2 - tx, (bbox.y0 + bbox.y1) / 2 - ty);
}

/** IoU（两盒均为 {x0,y0,x1,y1}） */
function iou(a: { x0: number; y0: number; x1: number; y1: number }, b: typeof a): number {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  const union = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
  return union > 0 ? inter / union : 0;
}

const TRUTH = { x0: 240, y0: 160, x1: 400, y1: 220 };          // 合成按钮真值（R1-9）
const RAW_BBOX = [372, 394, 625, 548];                          // qwen3-vl-plus 裸回执（0-1000 域）
const EXPECT_RESCALED = [372 * 0.64, 394 * 0.4, 625 * 0.64, 548 * 0.4]; // ×(W/1000,H/1000)

// ─── 金样：R1-9 实弹数字（273px → 1.9px） ───

test('R2-1 金样: qwen3-vl-plus + PNG 640×400 + 0-1000 bbox ⇒ 反算 1.9px/IoU≥0.93；原样消费基线 273px', async () => {
  const content = JSON.stringify({ elements: [{ id: 'e1', label: '提交订单', role: 'button', bbox: [...RAW_BBOX], confidence: 0.9 }] });
  const { fetchImpl, calls } = fakeChat(content);
  const client = new glm.GlmClient({ platform: 'qwen', model: 'qwen3-vl-plus', apiKey: 'sk-test-qwen', fetchImpl });
  const r = await client.chatJson<{ elements: Array<{ bbox: number[] }> }>(visionReq(pngB64(640, 400)));

  assert.equal(r.ok, true);
  assert.equal(calls[0]!.url.includes('dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'), true, 'qwen 预设基址');
  const bbox = r.value!.elements[0]!.bbox;
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(bbox[i]! - EXPECT_RESCALED[i]!) < 1e-9, `反算坐标[${i}] ${bbox[i]} ≈ ${EXPECT_RESCALED[i]}`);
  }
  // 中心误差/IoU（与 R1-9 裸探针数字同源：1.9px / IoU 0.94）
  const rescaled = { x0: bbox[0]!, y0: bbox[1]!, x1: bbox[2]!, y1: bbox[3]! };
  const errWith = centerErr(rescaled, 320, 190);
  assert.ok(errWith < 2.0, `反算后中心误差 ${errWith.toFixed(2)}px < 2px（R1-9 实测 1.9px）`);
  assert.ok(iou(rescaled, TRUTH) > 0.93, `IoU ${iou(rescaled, TRUTH).toFixed(3)} > 0.93`);
  // 原样消费基线（反算层缺席，插件 clamp 后）：R1-9 实测 273px
  const asIs = clampBbox({ x0: RAW_BBOX[0], y0: RAW_BBOX[1], x1: RAW_BBOX[2], y1: RAW_BBOX[3] }, 640, 400);
  const errWithout = centerErr(asIs, 320, 190);
  assert.ok(errWithout > 250, `原样消费基线 ${errWithout.toFixed(1)}px ≈ 273px（金样对照）`);
  assert.equal((r as { note?: string }).note, 'qwen-coord-rescaled', '反算生效注记');
});

test('R2-1: JPEG 尺寸解析（codec 生产形态）⇒ 反算同样生效', async () => {
  const { fetchImpl } = fakeChat(JSON.stringify([{ label: '提交订单', role: 'button', bbox: [...RAW_BBOX] }]));
  const client = new glm.GlmClient({ platform: 'qwen', model: 'qwen3-vl-plus', apiKey: 'sk-test-qwen', fetchImpl });
  const r = await client.chatJson<Array<{ bbox: number[] }>>(visionReq(jpegB64(640, 400), 'image/jpeg'));
  assert.equal(r.ok, true);
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(r.value![0]!.bbox[i]! - EXPECT_RESCALED[i]!) < 1e-9);
  }
  assert.equal((r as { note?: string }).note, 'qwen-coord-rescaled');
});

test('R2-1: 对象形态 bbox {x0,y0,x1,y1} 同样反算（器官双方言）', async () => {
  const { fetchImpl } = fakeChat(JSON.stringify({ words: [{ text: '提交订单', bbox: { x0: 372, y0: 394, x1: 625, y1: 548 } }] }));
  const client = new glm.GlmClient({ platform: 'qwen', model: 'qwen3-vl-flash', apiKey: 'sk-test-qwen', fetchImpl });
  const r = await client.chatJson<{ words: Array<{ bbox: { x0: number; y0: number; x1: number; y1: number } }> }>(visionReq(pngB64(640, 400)));
  assert.equal(r.ok, true);
  const w = r.value!.words[0]!.bbox;
  assert.ok(Math.abs(w.x0 - 238.08) < 1e-9 && Math.abs(w.y1 - 219.2) < 1e-9);
  assert.equal((r as { note?: string }).note, 'qwen-coord-rescaled');
});

// ─── 零影响律：glm 与他平台不经反算 ───

test('R2-1 零影响: glm 原生路径（真像素）值原样、无注记', async () => {
  const { fetchImpl } = fakeChat(JSON.stringify({ elements: [{ bbox: [372, 394, 625, 548] }] }));
  const client = new glm.GlmClient({ apiKey: 'sk-test-glm', fetchImpl }); // 缺省 glm 路径
  const r = await client.chatJson<{ elements: Array<{ bbox: number[] }> }>(visionReq(pngB64(640, 400)));
  assert.equal(r.ok, true);
  assert.deepEqual(r.value!.elements[0]!.bbox, [372, 394, 625, 548], 'glm 真像素原样消费');
  assert.equal((r as { note?: string }).note, undefined);
});

test('R2-1 零影响: 他 openai 方言平台（openai 预设）不经反算层', async () => {
  const { fetchImpl } = fakeChat(JSON.stringify({ elements: [{ bbox: [372, 394, 625, 548] }] }));
  const client = new glm.GlmClient({ platform: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test-oai', fetchImpl });
  const r = await client.chatJson<{ elements: Array<{ bbox: number[] }> }>(visionReq(pngB64(640, 400)));
  assert.equal(r.ok, true);
  assert.deepEqual(r.value!.elements[0]!.bbox, [372, 394, 625, 548]);
  assert.equal((r as { note?: string }).note, undefined);
});

// ─── 灰度安全：无法判定域 ⇒ coord-domain-ambiguous 不猜 ───

test('R2-1 灰度: qwen 平台但非 qwen[23]-vl 家族（qwen-vl-max 老系）⇒ 原样 + ambiguous', async () => {
  const { fetchImpl } = fakeChat(JSON.stringify({ elements: [{ bbox: [372, 394, 625, 548] }] }));
  const client = new glm.GlmClient({ platform: 'qwen', model: 'qwen-vl-max', apiKey: 'sk-test-qwen', fetchImpl });
  const r = await client.chatJson<{ elements: Array<{ bbox: number[] }> }>(visionReq(pngB64(640, 400)));
  assert.equal(r.ok, true);
  assert.deepEqual(r.value!.elements[0]!.bbox, [372, 394, 625, 548], '不猜：值不动');
  assert.equal((r as { note?: string }).note, 'coord-domain-ambiguous');
});

test('R2-1 灰度: 请求图宽高不可解析（脏 base64）⇒ 原样 + ambiguous', async () => {
  const { fetchImpl } = fakeChat(JSON.stringify({ elements: [{ bbox: [372, 394, 625, 548] }] }));
  const client = new glm.GlmClient({ platform: 'qwen', model: 'qwen3-vl-plus', apiKey: 'sk-test-qwen', fetchImpl });
  const r = await client.chatJson<{ elements: Array<{ bbox: number[] }> }>(visionReq(GARBAGE_B64));
  assert.equal(r.ok, true);
  assert.deepEqual(r.value!.elements[0]!.bbox, [372, 394, 625, 548]);
  assert.equal((r as { note?: string }).note, 'coord-domain-ambiguous');
});

test('R2-1 灰度: 节点签名不过（>1000 / 非整数）⇒ 该节点原样 + ambiguous', async () => {
  const offPixel = JSON.stringify({ elements: [{ bbox: [1536, 100, 2000, 400] }, { bbox: [372.5, 394, 625, 548] }] });
  const { fetchImpl } = fakeChat(offPixel);
  const client = new glm.GlmClient({ platform: 'qwen', model: 'qwen3-vl-plus', apiKey: 'sk-test-qwen', fetchImpl });
  const r = await client.chatJson<{ elements: Array<{ bbox: number[] }> }>(visionReq(pngB64(1920, 1080)));
  assert.equal(r.ok, true);
  assert.deepEqual(r.value!.elements[0]!.bbox, [1536, 100, 2000, 400], '>1000 整数 = 像素域特征，不动');
  assert.deepEqual(r.value!.elements[1]!.bbox, [372.5, 394, 625, 548], '非整数不猜');
  assert.equal((r as { note?: string }).note, 'coord-domain-ambiguous');
});

test('R2-1 灰度: 回执无 bbox 节点 ⇒ 无注记、零干扰', async () => {
  const { fetchImpl } = fakeChat(JSON.stringify({ verdict: 'confirmed', scale: 'element', confidence: 1 }));
  const client = new glm.GlmClient({ platform: 'qwen', model: 'qwen3-vl-plus', apiKey: 'sk-test-qwen', fetchImpl });
  const r = await client.chatJson<{ verdict: string }>(visionReq(pngB64(640, 400)));
  assert.equal(r.ok, true);
  assert.equal(r.value!.verdict, 'confirmed');
  assert.equal((r as { note?: string }).note, undefined);
});

// ─── 边界形态 ───

test('R2-1 边界: 1000×1000 恒等反算（值不变但注记生效）', async () => {
  const { fetchImpl } = fakeChat(JSON.stringify({ elements: [{ bbox: [372, 394, 625, 548] }] }));
  const client = new glm.GlmClient({ platform: 'qwen', model: 'qwen3-vl-plus', apiKey: 'sk-test-qwen', fetchImpl });
  const r = await client.chatJson<{ elements: Array<{ bbox: number[] }> }>(visionReq(pngB64(1000, 1000)));
  assert.equal(r.ok, true);
  assert.deepEqual(r.value!.elements[0]!.bbox, [372, 394, 625, 548], '×1.0 恒等');
  assert.equal((r as { note?: string }).note, 'qwen-coord-rescaled');
});

test('R2-1 边界: ok:false 回执零接触（error/raw 原样，无注记）', async () => {
  const calls: unknown[] = [];
  const fetchImpl = (async () => {
    calls.push(1);
    return new Response('{"error":{"message":"boom"}}', { status: 500, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const client = new glm.GlmClient({ platform: 'qwen', model: 'qwen3-vl-plus', apiKey: 'sk-test-qwen', fetchImpl });
  const r = await client.chatJson(visionReq(pngB64(640, 400)));
  assert.equal(r.ok, false);
  assert.match(r.error!, /qwen/);
  assert.equal((r as { note?: string }).note, undefined);
});

test('R2-1 边界: chat 纯文本路径不经反算层（无坐标可修）', async () => {
  const { fetchImpl } = fakeChat('图中有一个蓝色按钮（坐标在 JSON 模式下才给）');
  const client = new glm.GlmClient({ platform: 'qwen', model: 'qwen3-vl-plus', apiKey: 'sk-test-qwen', fetchImpl });
  const r = await client.chat(visionReq(pngB64(640, 400)));
  assert.equal(r.ok, true);
  assert.match(r.text, /蓝色按钮/);
  assert.equal(r.providerId, 'qwen');
});

test('R2-1 边界: 多元素混合（部分过签名部分不过）⇒ 过者反算、不过者原样 + rescaled 注记', async () => {
  const mixed = JSON.stringify({ elements: [
    { bbox: [...RAW_BBOX] },
    { bbox: [240, 160, 400, 220] },   // 同样过 0-1000 签名（qwen[23]-vl 家族恒 0-1000 域，一并反算）
    { bbox: [1200, 300, 1600, 500] }, // 像素域签名 ⇒ 不动
  ] });
  const { fetchImpl } = fakeChat(mixed);
  const client = new glm.GlmClient({ platform: 'qwen', model: 'qwen3-vl-plus', apiKey: 'sk-test-qwen', fetchImpl });
  const r = await client.chatJson<{ elements: Array<{ bbox: number[] }> }>(visionReq(pngB64(640, 400)));
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.value!.elements[0]!.bbox[0]! - 238.08) < 1e-9);
  assert.ok(Math.abs(r.value!.elements[1]!.bbox[0]! - 240 * 0.64) < 1e-9, '家族域内第二元素同样反算');
  assert.deepEqual(r.value!.elements[2]!.bbox, [1200, 300, 1600, 500], '像素域节点原样');
  assert.equal((r as { note?: string }).note, 'qwen-coord-rescaled');
});
