// test/vlm.grounding.test.ts
// 纪元 Ω（Ω-4 视觉接地）：grounding 器官的执法册 —— VLM 元素接地的规整层。
// 铁律：**零联网** —— 云脑全程用假 client 注入（configured:true + chatJson 桩）；
// 编码路径走 sharp 生成的真 PNG Buffer 过 codec 真实管线（不 mock 几何上游）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { GlmClient, GlmVisionRequest } from '../src/vlm/glmClient.ts';
import type { Bbox, EncodedImage } from '../src/vlm/codec.ts';
import { kernelRegistry } from '../src/kernel/registry.ts';

/** ΝΩ-48：同屏语义缓存内核键测试自管注册（生产由宿主 src/index.ts 铸入 —— W2-0 同款先例） */
function registerSemanticCacheKernel(): void {
  kernelRegistry.register({
    key: 'grounding.semanticCache', organ: 'perception',
    defaultValue: 1, min: 0, max: 1, note: 'ΝΩ-48 测试注册（生产缺省未注册 = 关）',
  });
}

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

// ─── ΝΩ-17 maxTokens 自适应 + 截断修复解析 ───

test('ΝΩ-17a: maxTokens 自适应 —— 密集大图按源图面积抬升上限，小图保持 2048 基线', async () => {
  const { groundElements } = await import('../src/vlm/grounding.ts');
  // 小图（64×48 = 3072px²）：ceil(3072/4096)=1 < 2048 ⇒ 基线（历史行为零回归）
  const small = await smallPng(64, 48);
  const s = fakeClient(() => ({ ok: true, value: { elements: [] }, raw: '' }));
  const rs = await groundElements(small, { client: s.client, verifyGate: false });
  assert.equal(rs.ok, true);
  assert.equal(s.requests[0]!.maxTokens, 2048, '小图 = 基线 2048（零回归锚点）');
  // 大图（4096×2304 = 9437184px²）：ceil(9437184/4096) = 2304 > 2048 ⇒ 抬升
  const big = await smallPng(4096, 2304);
  const b = fakeClient(() => ({ ok: true, value: { elements: [] }, raw: '' }));
  const rb = await groundElements(big, { client: b.client, verifyGate: false });
  assert.equal(rb.ok, true);
  assert.equal(b.requests[0]!.maxTokens, 2304, '源图面积超过基线配额 ⇒ 上限随面积抬升');
});

test('ΝΩ-17b: 截断修复解析 —— chatJson 失败但 raw 载完整前缀元素 ⇒ 部分元素 + truncated-partial 注记', async () => {
  const { groundElements } = await import('../src/vlm/grounding.ts');
  const buf = await smallPng(64, 48);
  // wrapper 方言：第三个元素在 label 中途被 maxTokens 截断（JSON 不平衡）
  const truncated = '{"elements":['
    + '{"id":"a","label":"按钮A","role":"button","bbox":[2,2,30,20],"confidence":0.9},'
    + '{"id":"b","label":"按钮B","role":"button","bbox":[34,2,62,20],"confidence":0.9},'
    + '{"id":"c","label":"截';
  const { client } = fakeClient(() => ({
    ok: false,
    error: 'glm json extraction failed: no balanced JSON object/array in reply (170 chars)',
    raw: truncated,
  }));
  const r = await groundElements(buf, { client, verifyGate: false });
  assert.equal(r.ok, true, '修复解析救回部分元素（部分结果优于零结果）');
  assert.equal(r.elements.length, 2, '两个完整前缀元素幸存');
  assert.deepEqual([...r.elements.map(e => e.label)].sort(), ['按钮A', '按钮B']);
  assert.deepEqual(r.elements.map(e => e.id), ['e1', 'e2'], 'id 照常归一重排');
  assert.equal(r.note, 'truncated-partial', '注记如实');
  // 裸数组方言（som 提示词勒令的形态）同样救回
  const bare = fakeClient(() => ({
    ok: false,
    error: 'glm json extraction failed: no balanced JSON object/array in reply (60 chars)',
    raw: '[{"label":"裸","role":"icon","bbox":[2,30,20,44],"confidence":0.8},{"label":"截',
  }));
  const r2 = await groundElements(buf, { client: bare.client, verifyGate: false });
  assert.equal(r2.ok, true);
  assert.equal(r2.elements.length, 1);
  assert.equal(r2.elements[0]!.label, '裸');
  assert.equal(r2.note, 'truncated-partial');
  // 零完整元素（截在第一个元素中途）⇒ 空修复不采信，维持失败语义
  const none = fakeClient(() => ({
    ok: false,
    error: 'glm json extraction failed: no balanced JSON object/array in reply (30 chars)',
    raw: '{"elements":[{"label":"截',
  }));
  const r3 = await groundElements(buf, { client: none.client, verifyGate: false });
  assert.equal(r3.ok, false, '零完整元素 ⇒ 修复不成立');
  assert.deepEqual(r3.elements, []);
  assert.equal(r3.note, undefined, '失败路径无注记');
});

// ─── ΝΩ-17 复核阈值分辨率归一 ───

test('ΝΩ-17c: 4K/720p 等效阈值 —— 短边触发随 短边/720 缩放（无端口 ⇒ port-absent 可观测）', async () => {
  const { groundElements, resetVerifyGateBudget } = await import('../src/vlm/grounding.ts');
  resetVerifyGateBudget();
  const buf = await smallPng(200, 150); // 真图小票；坐标系由显式声明 width/height 决定
  const single = (bbox: [number, number, number, number]) => ({
    ok: true, raw: '',
    value: { elements: [{ id: 'x', label: '目标', role: 'button', bbox, confidence: 0.9 }] },
  });
  const shortEdgeReasons = async (
    w: number, h: number, bbox: [number, number, number, number],
  ): Promise<string[]> => {
    const { client } = fakeClient(() => single(bbox));
    const r = await groundElements(buf, { client, width: w, height: h });
    assert.equal(r.ok, true);
    const ev = r.verifyGate?.events ?? [];
    return ev.length > 0 ? [...ev[0]!.reasons] : [];
  };
  // 720p（scale=1，阈值 24）：短边 20 触发 / 短边 30 不触发
  assert.deepEqual(await shortEdgeReasons(1280, 720, [100, 340, 1280, 360]), ['short-edge'], '720p 短边 20<24 触发');
  assert.deepEqual(await shortEdgeReasons(1280, 720, [100, 340, 1280, 370]), [], '720p 短边 30≥24 不触发');
  // 4K（scale=2160/720=3，阈值 72）：同一物理元素 60px（=720p 20px×3）等效触发 /
  // 90px（=720p 30px×3）等效不触发 —— 跨分辨率严格度等价
  assert.deepEqual(await shortEdgeReasons(3840, 2160, [300, 1020, 3840, 1080]), ['short-edge'], '4K 短边 60<72 等效触发');
  assert.deepEqual(await shortEdgeReasons(3840, 2160, [300, 1000, 3840, 1090]), [], '4K 短边 90≥72 等效不触发');
});

// ─── ΝΩ-17 NMS containment 去重 ───

test('ΝΩ-17d: nmsElements containment —— 容器-内嵌按钮（IoU 0.4-0.6 带）保内层抑容器', async () => {
  const { nmsElements } = await import('../src/vlm/grounding.ts');
  // 容器 [0,0,100,50] ⊃ 按钮 [10,10,90,40]：IoU=2400/5000=0.48（旧：双双保留）
  const panel = elem({ x0: 0, y0: 0, x1: 100, y1: 50 }, 'panel');
  const btn = elem({ x0: 10, y0: 10, x1: 90, y1: 40 }, 'btn');
  assert.deepEqual(
    nmsElements([panel, btn]).map(e => e.id),
    ['btn'],
    '内层按钮幸存、容器被抑（点击层拿到可点锚，不再指代歧义）',
  );
  // 一容器多内嵌：容器让位，全部内嵌按钮保留
  const panel2 = elem({ x0: 0, y0: 0, x1: 200, y1: 100 }, 'panel2');
  const b1 = elem({ x0: 10, y0: 10, x1: 90, y1: 40 }, 'b1');
  const b2 = elem({ x0: 110, y0: 10, x1: 190, y1: 40 }, 'b2');
  assert.deepEqual(
    [...nmsElements([panel2, b1, b2]).map(e => e.id)].sort(),
    ['b1', 'b2'],
    '容器抑制、双按钮全保',
  );
  // 嵌套容器链（面板>内衬>按钮）：级联让位，只留最内层
  // （IoU(mid,outer)=21600/45000=0.48、IoU(core,mid)=10800/21600=0.5 —— 均在
  //  0.4-0.6 带，只有 containment 判据能收敛）
  const outer = elem({ x0: 0, y0: 0, x1: 300, y1: 150 }, 'outer');
  const mid = elem({ x0: 20, y0: 20, x1: 260, y1: 110 }, 'mid');
  const core = elem({ x0: 50, y0: 40, x1: 230, y1: 100 }, 'core');
  assert.deepEqual(
    nmsElements([outer, mid, core]).map(e => e.id),
    ['core'],
    '面板>内衬>按钮链只留按钮',
  );
  // 中心不在容器内（贴角探出的并排交叠）⇒ 非 contain，双双保留（IoU<0.6 原语义）
  const corner = elem({ x0: 80, y0: 30, x1: 160, y1: 80 }, 'corner');
  assert.equal(nmsElements([panel, corner]).length, 2, '中心包含不成立 ⇒ 双保留');
  // IoU≥0.6 既有语义优先：近重复对不被 containment 翻案（幸存大者不变）
  const big = elem({ x0: 0, y0: 0, x1: 100, y1: 100 }, 'big');
  const dup = elem({ x0: 1, y0: 1, x1: 99, y1: 99 }, 'dup');
  assert.deepEqual(nmsElements([big, dup]).map(e => e.id), ['big'], 'IoU 带内行为不变');
});

// ─── ΝΩ-48（注视经济进 grounding + 同屏语义缓存） ───

/** LCG 噪声 PNG（高频细节 —— 注视位置在中央凹编码字节上可观测；w2wire W2-D① 同手法） */
async function noisePng(width: number, height: number): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  const raw = Buffer.alloc(width * height * 3);
  let seed = 0x2f6e2b1;
  for (let i = 0; i < raw.length; i += 3) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    raw[i] = seed & 0xff; raw[i + 1] = (seed >>> 8) & 0xff; raw[i + 2] = (seed >>> 16) & 0xff;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** 左右半分色 PNG（dhash 非全零 —— 同屏缓存的异屏试金石：与纯色图指纹必然不同） */
async function splitPng(width = 320, height = 240): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = x < width / 2 ? 60 : 200;
      const i = (y * width + x) * 3;
      raw[i] = v; raw[i + 1] = v; raw[i + 2] = v;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

test('ΝΩ-48a: foveaCenter 透传 —— 在场即开中央凹（策略 +fovea、字节与 codec 参考路径逐字节一致、注视中心真实生效）', async () => {
  const { groundElements } = await import('../src/vlm/grounding.ts');
  const { encodeForVlmMeta } = await import('../src/vlm/codec.ts');
  const buf = await noisePng(400, 300);
  const gaze = { x: 0.2, y: 0.8 };
  const { client, requests } = fakeClient(() => ({
    ok: true,
    value: { elements: [{ id: 'x', label: '按钮', role: 'button', bbox: [10, 10, 90, 60], confidence: 0.9 }] },
    raw: '...',
  }));
  const r = await groundElements(buf, { client, foveaCenter: gaze, verifyGate: false });
  assert.equal(r.ok, true);
  assert.equal(r.strategy, 'vlm:as-is+fovea', '中央凹经 grounding 接线生效');
  // 透传不走私：模型收到的编码字节 = codec 参考路径（foveated:true + 同注视中心）
  const ref = await encodeForVlmMeta(buf, { foveated: true, foveaCenter: gaze });
  assert.equal(ref.ok, true);
  assert.equal(ref.value!.foveated, true, '参考路径中央凹生效');
  assert.deepEqual(ref.value!.foveaCenter, gaze, '编码 meta 回声生效注视中心');
  assert.equal(requests[0]!.images[0]!.base64, ref.value!.base64, 'grounding 下发的图与参考路径逐字节一致');
  // 注视中心真实生效（非静默忽略）：偏置注视 ≠ 几何中心注视的编码字节
  const center = await encodeForVlmMeta(buf, { foveated: true, foveaCenter: { x: 0.5, y: 0.5 } });
  assert.notEqual(requests[0]!.images[0]!.base64, center.value!.base64, '高频图上注视位置必须改写出图');
  // blur 模式坐标空间不变（as-is 编码恒等反算）：bbox 原样、源图系标注
  assert.equal(r.coordinateSpace, 'original');
  assert.deepEqual(r.elements[0]!.bbox, { x0: 10, y0: 10, x1: 90, y1: 60 }, 'blur 中央凹不动几何');
  assert.deepEqual(r.elements[0]!.center, { x: 50, y: 35 });
});

test('ΝΩ-48a2: foveaCenter 缺席 ⇒ 逐字节旧路径（策略无 +fovea、字节与均质编码一致）', async () => {
  const { groundElements } = await import('../src/vlm/grounding.ts');
  const { encodeForVlmMeta } = await import('../src/vlm/codec.ts');
  const buf = await noisePng(400, 300);
  const { client, requests } = fakeClient(() => ({
    ok: true,
    value: { elements: [{ id: 'x', label: '按钮', role: 'button', bbox: [10, 10, 90, 60], confidence: 0.9 }] },
    raw: '...',
  }));
  const r = await groundElements(buf, { client, verifyGate: false });
  assert.equal(r.ok, true);
  assert.equal(r.strategy, 'vlm:as-is', '无注视中心 ⇒ 无中央凹后缀（零回归锚点）');
  const ref = await encodeForVlmMeta(buf);
  assert.equal(ref.value!.foveated, false);
  assert.equal(requests[0]!.images[0]!.base64, ref.value!.base64, '编码字节与均质路径逐字节一致');
});

test('ΝΩ-48a3: 脏 foveaCenter（非有限分量）⇒ codec 诚实拒绝上浮，绝不抛', async () => {
  const { groundElements } = await import('../src/vlm/grounding.ts');
  const buf = await smallPng(64, 48);
  const { client } = fakeClient(() => ({ ok: true, value: { elements: [] }, raw: '...' }));
  const r = await groundElements(buf, {
    client,
    verifyGate: false,
    foveaCenter: { x: Number.NaN, y: 0.5 },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.elements, []);
  assert.match(r.error ?? '', /foveaCenter/, '拒绝原因透传（codec 是唯一裁决点）');
});

test('ΝΩ-48b: 同屏同问同脑 ⇒ 缓存命中（零网络零编码、注记 grounding-cache-hit、快照隔离）', async () => {
  const { groundElements, _resetGroundingCache_forTest } = await import('../src/vlm/grounding.ts');
  registerSemanticCacheKernel();
  _resetGroundingCache_forTest();
  try {
    const buf = await smallPng(320, 240);
    const reply = () => ({
      ok: true,
      value: { elements: [{ id: 'x', label: '确定', role: 'button', bbox: [20, 20, 120, 80], confidence: 0.9 }] },
      raw: '...',
    });
    const one = fakeClient(reply);
    const q = { client: one.client, question: '找到确定按钮', verifyGate: false } as const;
    const r1 = await groundElements(buf, q);
    assert.equal(r1.ok, true);
    assert.equal(r1.note, undefined, '首跳（miss）无命中注记');
    assert.equal(one.requests.length, 1);
    // 同屏（dhash 汉明 0）+ 同 question + 同脑 ⇒ 直接回缓存
    const r2 = await groundElements(buf, q);
    assert.equal(r2.ok, true);
    assert.equal(r2.note, 'grounding-cache-hit', '命中注记如实');
    assert.deepEqual(r2.elements, r1.elements, '结果语义等价回放');
    assert.equal(one.requests.length, 1, '命中 ⇒ 零额外网络/零编码');
    // 快照隔离：调用方改动不回写缓存（第三次调用仍拿干净快照）
    r2.elements[0]!.label = '污染';
    const r3 = await groundElements(buf, q);
    assert.equal(r3.note, 'grounding-cache-hit');
    assert.equal(r3.elements[0]!.label, '确定', '缓存槽不受调用方改动污染');
  } finally {
    kernelRegistry.reset(); // 测试隔离：注册表复位（生产缺省 = 未注册 = 关）
    _resetGroundingCache_forTest();
  }
});

test('ΝΩ-48b0: 缓存缺省关（内核键未注册）⇒ 同屏同问双调照常走全管线（零回归锚点）', async () => {
  const { groundElements, _resetGroundingCache_forTest } = await import('../src/vlm/grounding.ts');
  _resetGroundingCache_forTest();
  const buf = await smallPng(320, 240);
  const reply = () => ({
    ok: true,
    value: { elements: [{ id: 'x', label: '确定', role: 'button', bbox: [20, 20, 120, 80], confidence: 0.9 }] },
    raw: '...',
  });
  const one = fakeClient(reply);
  const q = { client: one.client, question: '缺省关', verifyGate: false } as const;
  await groundElements(buf, q);
  const r2 = await groundElements(buf, q);
  assert.equal(r2.note, undefined, '未注册 ⇒ 缓存整体旁路（W5-4⑧ 幂等契约零回归）');
  assert.equal(one.requests.length, 2, '双调照常两次真实进 VLM');
});

test('ΝΩ-48b2: 异 question / 异屏（dhash 不同）/ 异脑（client 不同）/ 异注视 ⇒ 未命中走全管线', async () => {
  const { groundElements, _resetGroundingCache_forTest } = await import('../src/vlm/grounding.ts');
  registerSemanticCacheKernel();
  _resetGroundingCache_forTest();
  try {
    const reply = () => ({
      ok: true,
      value: { elements: [{ id: 'x', label: '确定', role: 'button', bbox: [20, 20, 120, 80], confidence: 0.9 }] },
      raw: '...',
    });
    // ① 异 question：同屏同脑不同问 ⇒ miss
    const solid = await smallPng(320, 240);
    const a = fakeClient(reply);
    await groundElements(solid, { client: a.client, question: 'Q1', verifyGate: false });
    const a2 = await groundElements(solid, { client: a.client, question: 'Q2', verifyGate: false });
    assert.equal(a2.note, undefined, '不同问 ⇒ 全管线');
    assert.equal(a.requests.length, 2);
    // ② 异屏：不同 dhash（分色图 vs 纯色图）⇒ miss
    const split = await splitPng(320, 240);
    const a3 = await groundElements(split, { client: a.client, question: 'Q1', verifyGate: false });
    assert.equal(a3.note, undefined, '屏指纹不同 ⇒ 全管线');
    assert.equal(a.requests.length, 3);
    // ③ 异脑：同屏同问不同 client ⇒ miss（缓存不跨脑回放）
    const b = fakeClient(reply);
    const b1 = await groundElements(solid, { client: b.client, question: 'Q1', verifyGate: false });
    assert.equal(b1.note, undefined);
    assert.equal(b.requests.length, 1, '新脑自起炉灶（不被旧脑缓存劫持）');
    // ④ 异注视：同屏同问同脑不同 foveaCenter ⇒ miss（编码语义随注视变）
    const c1 = await groundElements(solid, {
      client: b.client, question: 'Q1', verifyGate: false, foveaCenter: { x: 0.2, y: 0.3 },
    });
    assert.equal(c1.strategy, 'vlm:as-is+fovea');
    const c2 = await groundElements(solid, {
      client: b.client, question: 'Q1', verifyGate: false, foveaCenter: { x: 0.8, y: 0.7 },
    });
    assert.equal(c2.note, undefined, '注视中心是键分量 ⇒ 换注视即回源');
    assert.equal(b.requests.length, 3);
  } finally {
    kernelRegistry.reset(); // 测试隔离：注册表复位（生产缺省 = 未注册 = 关）
    _resetGroundingCache_forTest();
  }
});

test('ΝΩ-48b3: TTL 30s —— 窗口内命中、越过窗口诚实回源（墙钟注入）', async () => {
  const {
    groundElements,
    _resetGroundingCache_forTest,
    _overrideGroundingClock_forTest,
  } = await import('../src/vlm/grounding.ts');
  registerSemanticCacheKernel();
  const buf = await smallPng(320, 240);
  const reply = () => ({
    ok: true,
    value: { elements: [{ id: 'x', label: '确定', role: 'button', bbox: [20, 20, 120, 80], confidence: 0.9 }] },
    raw: '...',
  });
  let now = 1_000_000;
  _overrideGroundingClock_forTest(() => now);
  try {
    _resetGroundingCache_forTest();
    const one = fakeClient(reply);
    const q = { client: one.client, question: 'TTL', verifyGate: false } as const;
    await groundElements(buf, q); // miss（写缓存 @now）
    now += 29_999; // 29.999s：仍在 30s 窗口内
    const hit = await groundElements(buf, q);
    assert.equal(hit.note, 'grounding-cache-hit', '窗口内命中');
    assert.equal(one.requests.length, 1);
    now += 2; // 累计 30.001s：越过 TTL
    const expired = await groundElements(buf, q);
    assert.equal(expired.note, undefined, '过期 ⇒ 诚实回源');
    assert.equal(one.requests.length, 2, '全管线重跑');
  } finally {
    _overrideGroundingClock_forTest(null); // 复位生产墙钟
    kernelRegistry.reset(); // 测试隔离：注册表复位（生产缺省 = 未注册 = 关）
    _resetGroundingCache_forTest();
  }
});
