// test/vlm.grounding.test.ts
// 纪元 Ω（Ω-4 视觉接地）：grounding 器官的执法册 —— VLM 元素接地的规整层。
// 铁律：**零联网** —— 云脑全程用假 client 注入（configured:true + chatJson 桩）；
// 编码路径走 sharp 生成的真 PNG Buffer 过 codec 真实管线（不 mock 几何上游）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { GlmClient, GlmVisionRequest } from '../src/vlm/glmClient.ts';
import type { Bbox, EncodedImage } from '../src/vlm/codec.ts';

// ─── 测试脚手架 ───

/** 假 client：记录收到的请求，回放预设 chatJson 结果（零网络） */
function fakeClient(
  reply: () => { ok: boolean; value?: unknown; error?: string; raw: string },
  configured = true,
): { client: GlmClient; requests: GlmVisionRequest[] } {
  const requests: GlmVisionRequest[] = [];
  const client = {
    configured,
    chatJson: async (req: GlmVisionRequest) => {
      requests.push(req);
      return reply();
    },
  } as unknown as GlmClient;
  return { client, requests };
}

/** sharp 生成小 PNG（真图 Buffer —— codec 真实编码管线的最低门票） */
async function smallPng(width = 64, height = 48): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  return sharp({ create: { width, height, channels: 3, background: '#303030' } }).png().toBuffer();
}

/** 构造 GroundedElement 的最小便捷工厂（纯函数测试用） */
function elem(bbox: Bbox, id = 'e1', confidence = 0.9) {
  return {
    id, label: 'x', role: 'button', bbox, confidence, source: 'vlm' as const,
    center: { x: (bbox.x0 + bbox.x1) / 2, y: (bbox.y0 + bbox.y1) / 2 },
  };
}

// ─── Ω-4a 未配置降级（零网络哨兵） ───

test('Ω-4a: GLM 未配置（且未注入 client）⇒ 零网络立即降级，elements 恒空', async () => {
  const { isGlmConfigured } = await import('../src/vlm/glmClient.ts');
  // 前置断言：测试环境必须无 GLM 配置 —— 失败即中止，绝不带着 Key 拨号
  assert.equal(isGlmConfigured(), false, '测试环境须无 GLM 配置（零联网前提）');
  const { groundElements } = await import('../src/vlm/grounding.ts');
  const buf = await smallPng();
  const r = await groundElements(buf); // 无 client 注入
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true, '降级标记');
  assert.deepEqual(r.elements, [], '宁可空不可错');
  assert.ok(r.error && r.error.length > 0, '降级原因在场');
  assert.equal(r.strategy, 'unconfigured');
  assert.ok(r.latencyMs >= 0);
});

// ─── Ω-4b 正常解析：VLM 方言 → 仓库标准方言 ───

test('Ω-4b: 正常解析 —— bbox 4 元数组转对象、id 归一 e1..、confidence 夹 [0,1]、越界 clamp', async () => {
  const { groundElements } = await import('../src/vlm/grounding.ts');
  const { encodeForVlm } = await import('../src/vlm/codec.ts');
  const buf = await smallPng();
  // 先问 codec 要真实编码尺寸（不假设其缩放策略）
  const enc = await encodeForVlm(buf);
  assert.equal(enc.ok, true, '编码前置成功');
  const E = enc.value as EncodedImage;
  const W = E.width, H = E.height;
  assert.ok(W >= 40 && H >= 30, `编码尺寸足够（${W}x${H}）`);

  const { client, requests } = fakeClient(() => ({
    ok: true,
    value: {
      elements: [
        { id: 'A', label: '设置', role: 'button', bbox: [8, 10, 40, 30], confidence: 0.9 },
        { id: 'B', label: '', role: '', bbox: { x0: -5, y0: 100, x1: 70, y1: 140 }, confidence: 1.7 }, // 全方位方言：空 label/role、对象 bbox 出图、confidence 越界
      ],
    },
    raw: '{"elements":[...]}',
  }));
  const r = await groundElements(buf, { client, question: '找到设置入口' });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, false);
  assert.ok(r.strategy.startsWith('vlm:'), `strategy=${r.strategy}`);

  // id 归一为 e1.. 序号（校验序）；NMS 输出按面积降序 —— 按 id 取元素，不赌顺序
  assert.deepEqual([...r.elements.map(e => e.id)].sort(), ['e1', 'e2']);
  const byId = new Map(r.elements.map(e => [e.id, e]));
  const e1 = byId.get('e1')!, e2 = byId.get('e2')!;

  // 元素 1：图内数组 bbox 原样转对象 + 中心点
  assert.deepEqual(e1.bbox, { x0: 8, y0: 10, x1: 40, y1: 30 });
  assert.deepEqual(e1.center, { x: 24, y: 20 });
  assert.equal(e1.label, '设置');
  assert.equal(e1.role, 'button');
  assert.equal(e1.confidence, 0.9);
  assert.equal(e1.source, 'vlm');

  // 元素 2：出图 bbox 夹回图内（x∈[0,W]、y∈[0,H]，宽高 ≥1px）+ 兜底字符串 + confidence 夹 1
  assert.ok(e2.bbox.x0 >= 0 && e2.bbox.x1 <= W, `x 夹回（${JSON.stringify(e2.bbox)} vs W=${W}）`);
  assert.ok(e2.bbox.y0 >= 0 && e2.bbox.y1 <= H, `y 夹回（${JSON.stringify(e2.bbox)} vs H=${H}）`);
  assert.ok(e2.bbox.x1 > e2.bbox.x0 && e2.bbox.y1 > e2.bbox.y0, '退化盒被撑为 ≥1px');
  assert.ok(Math.abs(e2.center.x - (e2.bbox.x0 + e2.bbox.x1) / 2) < 1e-9);
  assert.ok(Math.abs(e2.center.y - (e2.bbox.y0 + e2.bbox.y1) / 2) < 1e-9);
  assert.equal(e2.label, '未知元素', '空 label 兜底');
  assert.equal(e2.role, 'unknown', '空 role 兜底');
  assert.equal(e2.confidence, 1, 'confidence 1.7 夹为 1');

  // 请求接线：真图过编码、jsonMode、som 提示词双段在场
  assert.equal(requests.length, 1);
  const req = requests[0]!;
  assert.ok(typeof req.images[0]!.base64 === 'string' && req.images[0]!.base64.length > 0);
  assert.equal(req.images[0]!.mime, E.mime);
  assert.equal(req.jsonMode, true);
  assert.ok(typeof req.system === 'string' && req.system.length > 0);
  assert.ok(typeof req.prompt === 'string' && req.prompt.length > 0);
});

test('Ω-4b2: 显式 width/height 优先于编码尺寸（屏坐标语义不被缩放劫持）', async () => {
  const { groundElements } = await import('../src/vlm/grounding.ts');
  const buf = await smallPng(64, 48); // 编码尺寸 64x48
  const { client } = fakeClient(() => ({
    ok: true,
    value: { elements: [{ id: 'x', label: '按钮', role: 'button', bbox: [70, 60, 90, 80], confidence: 0.8 }] },
    raw: '...',
  }));
  // 声明屏幕语义 100x100：若误用编码尺寸 64x48，该 bbox 会被拦腰夹断
  const r = await groundElements(buf, { client, width: 100, height: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.elements.length, 1);
  assert.deepEqual(r.elements[0]!.bbox, { x0: 70, y0: 60, x1: 90, y1: 80 }, '以显式尺寸为坐标系');
});

// ─── Ω-4c 非法元素被过滤（宁可少报，不可错报） ───

test('Ω-4c: 非法元素被过滤 —— 非对象 / bbox 缺席 / 短数组 / 非数字分量全剔除', async () => {
  const { groundElements } = await import('../src/vlm/grounding.ts');
  const buf = await smallPng();
  const { client } = fakeClient(() => ({
    ok: true,
    value: {
      elements: [
        null,                       // 非对象
        42,                         // 数字
        '垃圾',                      // 字符串
        { label: '无 bbox' },        // bbox 缺席
        { bbox: 'nope' },            // bbox 非法形态
        { bbox: [1, 2, 3] },         // 短数组
        { bbox: [1, 'a', 3, 4] },    // 非数字分量
        { bbox: { x0: 1, y0: 2 } },  // 对象缺字段
        { bbox: [10, 10, 30, 30], label: '合法', role: 'button', confidence: 0.7 }, // 唯一幸存者
      ],
    },
    raw: '...',
  }));
  const r = await groundElements(buf, { client });
  assert.equal(r.ok, true);
  assert.equal(r.elements.length, 1, '八个里活一个');
  assert.equal(r.elements[0]!.id, 'e1', '幸存者重排为 e1（序号连续于幸存集）');
  assert.equal(r.elements[0]!.label, '合法');
});

// ─── Ω-4d 管线内 NMS：同一控件的多重检出合并 ───

test('Ω-4d: 高重叠双检出合并为一（IoU≥0.6 去冗余），id 保幸存序', async () => {
  const { groundElements } = await import('../src/vlm/grounding.ts');
  const buf = await smallPng();
  const { client } = fakeClient(() => ({
    ok: true,
    value: {
      elements: [
        { id: 'a', label: '大控件', role: 'panel', bbox: [0, 0, 60, 40], confidence: 0.9 },
        { id: 'b', label: '大控件·重复检出', role: 'panel', bbox: [2, 2, 58, 38], confidence: 0.85 }, // IoU≈0.81
        { id: 'c', label: '远处小图', role: 'icon', bbox: [50, 0, 64, 48], confidence: 0.6 },          // IoU≈0.15 独立保留
      ],
    },
    raw: '...',
  }));
  const r = await groundElements(buf, { client });
  assert.equal(r.ok, true);
  assert.deepEqual(r.elements.map(e => e.id), ['e1', 'e3'], 'e2 作为冗余被 NMS 吸收');
  assert.deepEqual(r.elements.map(e => e.label), ['大控件', '远处小图'], '面积降序输出');
});

// ─── Ω-4e 云脑失败路径 ───

test('Ω-4e: chatJson 失败 ⇒ ok:false + error 透传，elements 恒空', async () => {
  const { groundElements } = await import('../src/vlm/grounding.ts');
  const buf = await smallPng();
  const { client } = fakeClient(() => ({ ok: false, error: 'quota exceeded', raw: '' }));
  const r = await groundElements(buf, { client });
  assert.equal(r.ok, false);
  assert.equal(r.degraded, false, '云脑失败不是配置降级');
  assert.deepEqual(r.elements, []);
  assert.ok(r.error?.includes('quota exceeded'), `error=${r.error}`);
});

test('Ω-4e2: chatJson 成功但缺 elements 数组 ⇒ ok:false（空指针方言不容忍）', async () => {
  const { groundElements } = await import('../src/vlm/grounding.ts');
  const buf = await smallPng();
  const { client } = fakeClient(() => ({ ok: true, value: { foo: 1 }, raw: '{"foo":1}' }));
  const r = await groundElements(buf, { client });
  assert.equal(r.ok, false);
  assert.deepEqual(r.elements, []);
  assert.ok(r.error && r.error.includes('elements'), `error=${r.error}`);
});

test('Ω-4e3: 空 buffer / 编码失败 ⇒ ok:false（真 sharp 拒绝非图字节）', async () => {
  const { groundElements } = await import('../src/vlm/grounding.ts');
  const { client } = fakeClient(() => ({ ok: true, value: { elements: [] }, raw: '...' }));
  // 空 buffer：编码前哨兵
  const r1 = await groundElements(Buffer.alloc(0), { client });
  assert.equal(r1.ok, false);
  assert.deepEqual(r1.elements, []);
  // 非图字节：codec 真管线拒绝（sharp 解码失败 → ok:false 上浮）
  const r2 = await groundElements(Buffer.from('definitely not a png'), { client });
  assert.equal(r2.ok, false);
  assert.deepEqual(r2.elements, []);
  assert.ok(r2.error && r2.error.length > 0);
});

// ─── Ω-4f clampBbox 纯函数数值 ───

test('Ω-4f: clampBbox —— 越界夹回、倒置交换、零面积撑 1px、退化尺寸卫兵', async () => {
  const { clampBbox } = await import('../src/vlm/grounding.ts');
  // 越界夹回图内
  assert.deepEqual(clampBbox({ x0: -10, y0: 5, x1: 100, y1: 50 }, 80, 60), { x0: 0, y0: 5, x1: 80, y1: 50 });
  // 倒置坐标交换（VLM 偶发 x0>x1）
  assert.deepEqual(clampBbox({ x0: 50, y0: 40, x1: 10, y1: 20 }, 80, 60), { x0: 10, y0: 20, x1: 50, y1: 40 });
  // 零面积盒撑为 1x1
  assert.deepEqual(clampBbox({ x0: 30, y0: 30, x1: 30, y1: 30 }, 64, 48), { x0: 30, y0: 30, x1: 31, y1: 31 });
  // 全出图的零面积盒：贴边角撑 1px 且不出图
  assert.deepEqual(clampBbox({ x0: 90, y0: 90, x1: 90, y1: 90 }, 64, 48), { x0: 63, y0: 47, x1: 64, y1: 48 });
  // 浮点盒整数化：floor(x0)/ceil(x1) 包含原盒
  assert.deepEqual(clampBbox({ x0: 10.2, y0: 20.7, x1: 30.8, y1: 40.1 }, 64, 48), { x0: 10, y0: 20, x1: 31, y1: 41 });
  // 退化画布尺寸（0/NaN）按 1x1 卫兵处理，不炸不抛
  assert.deepEqual(clampBbox({ x0: 5, y0: 5, x1: 9, y1: 9 }, 0, Number.NaN), { x0: 0, y0: 0, x1: 1, y1: 1 });
  // 非法坐标分量按 0 记（缺席字段不抛 TypeError）
  assert.deepEqual(clampBbox({ x0: undefined as unknown as number, y0: 1, x1: 5, y1: 5 }, 64, 48), { x0: 0, y0: 1, x1: 5, y1: 5 });
});

// ─── Ω-4g iouBbox 纯函数数值 ───

test('Ω-4g: iouBbox —— 全同=1、相离=0、半重叠=1/3、贴边=0、退化盒=0', async () => {
  const { iouBbox } = await import('../src/vlm/grounding.ts');
  const a: Bbox = { x0: 0, y0: 0, x1: 10, y1: 10 };
  assert.equal(iouBbox(a, { x0: 0, y0: 0, x1: 10, y1: 10 }), 1, '全同');
  assert.equal(iouBbox(a, { x0: 20, y0: 20, x1: 30, y1: 30 }), 0, '相离');
  assert.equal(iouBbox(a, { x0: 10, y0: 0, x1: 20, y1: 10 }), 0, '贴边不算相交');
  const v = iouBbox(a, { x0: 5, y0: 0, x1: 15, y1: 10 }); // 交 50 / 并 150
  assert.ok(Math.abs(v - 1 / 3) < 1e-9, `半重叠 1/3（实得 ${v}）`);
  assert.equal(iouBbox(a, { x0: 5, y0: 0, x1: 5, y1: 10 }), 0, '零宽盒无几何身份');
  assert.equal(iouBbox(a, { x0: 12, y0: 0, x1: 8, y1: 10 }), 0, '倒置盒按退化处理');
});

// ─── Ω-4h nmsElements 纯函数数值 ───

test('Ω-4h: nmsElements —— 面积降序贪心、默认 0.6 阈值、平手取先出现者', async () => {
  const { nmsElements } = await import('../src/vlm/grounding.ts');
  const big = elem({ x0: 0, y0: 0, x1: 100, y1: 100 }, 'big');      // 10000
  const dup = elem({ x0: 1, y0: 1, x1: 99, y1: 99 }, 'dup');        // 9604，IoU≈0.96
  const far = elem({ x0: 200, y0: 200, x1: 250, y1: 250 }, 'far');  // 2500，独立
  // 乱序输入：输出面积降序，冗余被吸收
  const out = nmsElements([far, dup, big]);
  assert.deepEqual(out.map(e => e.id), ['big', 'far'], '面积降序 + IoU≥0.6 去冗余');
  // 自定义阈值：0.99 时高重叠也各自保留
  assert.equal(nmsElements([big, dup], 0.99).length, 2, '阈值放宽则双保留');
  // 边界精确性：IoU 恰等于阈值 ⇒ 去冗余（仓库 ≥ 约定）
  const k: Bbox = { x0: 2.5, y0: 0, x1: 12.5, y1: 10 }; // 与 [0,0,10,10] 的 IoU = (10-2.5)/(10+2.5) = 0.6
  assert.equal(nmsElements([elem({ x0: 0, y0: 0, x1: 10, y1: 10 }), elem(k)]).length, 1, 'IoU=0.6 恰好命中去冗余');
  // 平手取先出现者：两等面积全同盒 → 输入序在前者胜
  const t1 = elem({ x0: 0, y0: 0, x1: 10, y1: 10 }, 'first');
  const t2 = elem({ x0: 0, y0: 0, x1: 10, y1: 10 }, 'second');
  assert.equal(nmsElements([t1, t2])[0]!.id, 'first');
  assert.equal(nmsElements([t2, t1])[0]!.id, 'second');
  // 退化与空集
  assert.deepEqual(nmsElements([]), []);
  assert.deepEqual(nmsElements([elem({ x0: 5, y0: 5, x1: 5, y1: 5 })]), [], '零面积元素无几何身份，被滤除');
});
