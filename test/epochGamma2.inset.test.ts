// test/epochGamma2.inset.test.ts
// 纪元 Γ2（注视经济 · inset 模式）执法册 —— Γ 的 token 承诺在此兑现。
//   Γ2-1 尺寸/token：1600x800（maxDimension=1600，as-is 空间）scale=2 ⇒
//      输出 800x400、estimateVlmTokens 恰按 1/4（ceil 残差 ≤1 token）；
//      insetRect/insetScale/insetNative 数学逐字段精确（居中提取律 + 居中占位律）。
//   Γ2-2 坐标双区往返：mapInsetToOriginal 分段反算 —— 凹窗内点 1:1 原生（往返
//      0px）、窗外点按缩图实际比值（往返 ≤1px）；非整除维度（1499x701）同样
//      ≤1px；脏元信息诚实回退 Γ 等比语义；消费端出口联动（grounding/vlmOcr
//      假 client + 注册表开 inset —— 词/元素坐标回源图系精确）。
//   Γ2-3 降级链：结构性不可用（foveaSize=1.0：凹窗放不进缩图）⇒ 一级降级 blur
//      （foveated 仍真、尺寸不变）；composite 残废 ⇒ inset 失败→blur 失败→均质
//      （foveated:false 诚实注记）；sharp 缺席 ⇒ ok:false 绝不抛。
//   Γ2-4 Γ 回归：blur 显式 = blur 缺省逐字节同源（strategy '+fovea'、尺寸不变）；
//      开关关 ⇒ mode 惰性（无 inset 字段）；注册表 codec.foveaMode 0/1 数值语义
//      翻转缺省、显式入参恒压过注册表。
// 铁律：全离线确定性 —— sharp 现铸真图 + 假 client 桩 + 注册表 finally 复位，
// 零网络零 fixture 文件。epochGamma.fovea.test.ts 随回归清单另行保绿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSharp, type SharpLike } from '../src/_legacyDeps.ts';
import type { GlmClient, GlmVisionRequest } from '../src/vlm/glmClient.ts';
import { kernelRegistry } from '../src/kernel/registry.ts';

// 契约模块经动态 import 加载（Ω-2 铁律：不在测试顶层静态绑定被测模块）
const {
  encodeForVlm, encodeForVlmMeta, estimateVlmTokens,
  mapEncodedToOriginal, mapInsetToOriginal,
  _overrideSharpResolver_forTest,
} = await import('../src/vlm/codec.ts');
const { groundElements } = await import('../src/vlm/grounding.ts');
const { readTextViaVlm } = await import('../src/vlm/vlmOcr.ts');

// ─── 测试脚手架（与 epochGamma.fovea.test.ts 同构） ───

let sharpCache: SharpLike | null = null;
async function requireSharp(): Promise<SharpLike> {
  if (!sharpCache) sharpCache = await getSharp();
  return sharpCache;
}

/** 懒检查 sharp 是否可用，不可用时 test 直接 SKIP（仓库先例：vlm.codec.test.ts） */
async function withSharp<T>(t: any, fn: (s: SharpLike) => Promise<T>): Promise<T | undefined> {
  let s: SharpLike;
  try {
    s = await requireSharp();
  } catch (e: any) {
    t.skip(`sharp not installed — ${e?.message?.slice(0, 240) ?? ''}`);
    return undefined;
  }
  return fn(s);
}

/**
 * 合成「棋盘 + 中央目标块」PNG（Γ2 的注视经济试金石）：外围高频棋盘
 * （inset 缩图下有损 —— 外围保真损失的信号源）+ 中央实心目标块（平滑内容，
 * 凹窗原生保真的取样点 —— JPEG 块级确定性）。
 */
async function targetScreenPng(
  s: SharpLike, w: number, h: number,
  targetW = Math.floor(w / 8), targetH = Math.floor(h / 8),
): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  const cell = 16; // 棋盘格 16px（inset 后 ~6-7px —— 高频应力）
  const tx0 = Math.floor((w - targetW) / 2), tx1 = tx0 + targetW;
  const ty0 = Math.floor((h - targetH) / 2), ty1 = ty0 + targetH;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inTarget = x >= tx0 && x < tx1 && y >= ty0 && y < ty1;
      const v = inTarget ? 40 : (((x / cell | 0) + (y / cell | 0)) % 2 === 0 ? 210 : 120);
      const i = (y * w + x) * 3;
      raw[i] = v; raw[i + 1] = v; raw[i + 2] = v;
    }
  }
  return s(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/** grounding/vlmOcr 假 client：回放预设 chatJson 结果，可选捕获请求（零网络） */
function fakeClient(
  reply: () => { ok: boolean; value?: unknown; error?: string; raw: string },
  capture?: (req: GlmVisionRequest) => void,
): GlmClient {
  return {
    configured: true,
    chatJson: async (req: GlmVisionRequest) => {
      if (capture) capture(req);
      return reply();
    },
  } as unknown as GlmClient;
}

/**
 * Γ2-3 残废 sharp：链上一切方法透传真 sharp，唯 composite 抛错（Γ-3 同款，
 * 递归包裹 clone/resize 衍生链）—— inset 与 blur 的 composite 一并命中，
 * 验证两级降级都失败 ⇒ 均质回退的诚实路径。
 */
function crippleCompositeSharp(real: SharpLike): SharpLike {
  const wrapChain = (chain: object): any => new Proxy(chain, {
    get(target, prop) {
      if (prop === 'composite') {
        return () => { throw new Error('composite broken (Γ2-3 stub)'); };
      }
      const v = Reflect.get(target, prop);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        const out = (v as (...a: unknown[]) => unknown).apply(target, args);
        if (out !== null && typeof out === 'object' && typeof (out as any).then !== 'function') {
          return wrapChain(out);
        }
        return out;
      };
    },
  });
  return ((input?: Buffer | string | Uint8Array, options?: { [k: string]: any }) =>
    wrapChain((real as any)(input, options))) as unknown as SharpLike;
}

// ─── Γ2-1 尺寸 / Token / insetRect 数学 ───

test('Γ2-1: scale=2 ⇒ 输出 800x400、token 恰按 1/4、insetRect 数学逐字段精确', async (t) => {
  await withSharp(t, async (s) => {
    const png = await targetScreenPng(s, 1600, 800);
    const hom = await encodeForVlmMeta(png, { maxDimension: 1600 });
    const ins = await encodeForVlmMeta(png, {
      maxDimension: 1600, foveated: true, foveaMode: 'inset', foveaPeripheryScale: 2,
    });
    assert.equal(hom.ok && ins.ok, true, '双路径编码前置成功');
    const h = hom.value!, v = ins.value!;
    // 均质基准：1600 == maxDimension ⇒ 不缩（超过才缩）
    assert.equal(h.width, 1600);
    assert.equal(h.height, 800);
    assert.equal(h.strategy, 'as-is');
    // inset：输出 = 缩图尺寸（token 骨跌的物理来源），策略 +inset
    assert.equal(v.width, 800, '宽 = 1600/2');
    assert.equal(v.height, 400, '高 = 800/2');
    assert.equal(v.strategy, 'as-is+inset', '策略追加 +inset 后缀（可观测）');
    assert.equal(v.foveated, true);
    assert.equal(v.foveaMode, 'inset');
    // insetRect 数学（缩图坐标系）：edge=round(0.5×800)=400；
    // 居中提取律 fx=floor((1600−400)/2)=600、fy=floor((800−400)/2)=200；
    // 居中占位律 ix=floor((800−400)/2)=200、iy=floor((400−400)/2)=0
    assert.deepEqual(v.insetRect, { x: 200, y: 0, w: 400, h: 400 });
    assert.equal(v.insetScale, 2);
    assert.deepEqual(v.insetNative, { width: 1600, height: 800 });
    // 源图元信息随行（反算总画布）
    assert.equal(v.sourceWidth, 1600);
    assert.equal(v.sourceHeight, 800);
    assert.equal(v.cropRect, null);
    // Token 估算：像素面积恰 1/4（ceil 各自取整残差 ≤1 token）
    const tHom = estimateVlmTokens(h.width, h.height);   // ceil(1280000/750) = 1707
    const tIns = estimateVlmTokens(v.width, v.height);   // ceil(320000/750)  = 427
    assert.equal(tHom, 1707);
    assert.equal(tIns, 427);
    assert.ok(tIns * 4 <= tHom + 3, `token 恰按 1/4（±ceil）：${tIns}×4 vs ${tHom}`);
    const savings = 1 - tIns / tHom;
    assert.ok(savings > 0.74 && savings < 0.76, `节省率 ≈75%（实测 ${(savings * 100).toFixed(2)}%）`);
    // 输出仍是合法 JPEG
    const bin = Buffer.from(v.base64, 'base64');
    assert.equal(bin.length, v.bytes);
    assert.equal(bin[0], 0xff);
    assert.equal(bin[1], 0xd8);
  });
});

// ─── Γ2-2 坐标双区往返 ───

test('Γ2-2: 双区往返 —— 凹窗内点 1:1 原生（0px）、窗外点缩图比值（≤1px）', async (t) => {
  await withSharp(t, async (s) => {
    const png = await targetScreenPng(s, 1600, 800);
    const enc = await encodeForVlmMeta(png, {
      maxDimension: 1600, foveated: true, foveaMode: 'inset', foveaPeripheryScale: 2,
    });
    assert.equal(enc.ok, true);
    const m = enc.value!;
    const fx = 600, fy = 200, ix = 200, iy = 0; // Γ2-1 已证的构造律常量
    // 凹窗内：源图点 (sx,sy) ∈ [600,1000)x[200,600) ⇔ 缩图 (ix+(sx−fx), iy+(sy−fy))
    for (const [sx, sy] of [[600, 200], [799, 399], [999, 599], [800, 400], [750, 350]] as const) {
      const back = mapInsetToOriginal(ix + (sx - fx), iy + (sy - fy), m);
      assert.ok(Math.abs(back.x - sx) <= 1 && Math.abs(back.y - sy) <= 1,
        `窗内往返 (${sx},${sy})→(${ix + sx - fx},${iy + sy - fy})→(${back.x},${back.y}) 超 1px`);
    }
    // 凹窗外：缩图 = 1600x800 → 800x400 恰 2x，往返 round 残差 ≤1px
    for (const [sx, sy] of [[0, 0], [10, 10], [100, 700], [1550, 700], [1590, 790], [101, 701], [1599, 799]] as const) {
      const cx = Math.round((sx * 800) / 1600);
      const cy = Math.round((sy * 400) / 800);
      const back = mapInsetToOriginal(cx, cy, m);
      assert.ok(Math.abs(back.x - sx) <= 1 && Math.abs(back.y - sy) <= 1,
        `窗外往返 (${sx},${sy})→(${cx},${cy})→(${back.x},${back.y}) 超 1px`);
    }
    // 图外/脏坐标防御：越界 clamp 回图内、非有限分量按 0 记（绝不抛）
    const edge = mapInsetToOriginal(-999, 99999, m);
    assert.equal(edge.x, 0);
    assert.equal(edge.y, 800);
    const nan = mapInsetToOriginal(NaN, -Infinity, m);
    assert.deepEqual(nan, { x: 0, y: 0 });
  });
});

test('Γ2-2: 非整除维度（1499x701）双区往返仍 ≤1px + insetRect 数学', async (t) => {
  await withSharp(t, async (s) => {
    const png = await targetScreenPng(s, 1499, 701);
    const enc = await encodeForVlmMeta(png, {
      maxDimension: 2000, foveated: true, foveaMode: 'inset', foveaPeripheryScale: 2,
    });
    assert.equal(enc.ok, true);
    const m = enc.value!;
    assert.equal(m.width, 750);  // round(1499/2) = 750（.5 进位）
    assert.equal(m.height, 351); // round(701/2) = 351
    // edge=round(0.5×701)=351；fx=floor((1499−351)/2)=574、fy=floor((701−351)/2)=175；
    // ix=floor((750−351)/2)=199、iy=0
    assert.deepEqual(m.insetRect, { x: 199, y: 0, w: 351, h: 351 });
    assert.deepEqual(m.insetNative, { width: 1499, height: 701 });
    // 窗内：1:1 原生 —— 往返精确
    for (const [sx, sy] of [[574, 175], [674, 225], [924, 525]] as const) {
      const back = mapInsetToOriginal(199 + (sx - 574), 0 + (sy - 175), m);
      assert.ok(Math.abs(back.x - sx) <= 1 && Math.abs(back.y - sy) <= 1,
        `窗内往返 (${sx},${sy})→(${back.x},${back.y}) 超 1px`);
    }
    // 窗外：缩图实际比值 1499/750、701/351（非名义 2 的取整残差被实际比值吸收）。
    // 取样点必须落在缩图 insetRect [199,550)x[0,351) 之外 —— 放大镜语义下，
    // 缩图窗内像素展示的是**原生中央内容**（非该位置的外围降采样），窗外才是
    // 外围区（sx<398 或 sx>1099 才投得进窗外 —— 中央带被凹窗遮蔽是特性不是缺陷）
    for (const [sx, sy] of [[10, 10], [300, 350], [1498, 700]] as const) {
      const cx = Math.round((sx * 750) / 1499);
      const cy = Math.round((sy * 351) / 701);
      const back = mapInsetToOriginal(cx, cy, m);
      assert.ok(Math.abs(back.x - sx) <= 1 && Math.abs(back.y - sy) <= 1,
        `窗外往返 (${sx},${sy})→(${cx},${cy})→(${back.x},${back.y}) 超 1px`);
    }
    // 放大镜语义执法：缩图窗内像素恒按原生 1:1 反算（即使该缩图坐标的「外围
    // 投影」另有所指 —— (350,175) 外围投影是 (700,350)，但窗内展示的是原生
    // (725,350)，映射忠于**所见图**而非假设的外围层）
    const mag = mapInsetToOriginal(350, 175, m);
    assert.deepEqual(mag, { x: 725, y: 350 }, '窗内像素按原生内容反算（放大镜语义）');
  });
});

test('Γ2-2: 脏 inset 元信息 ⇒ 诚实回退 Γ 等比语义（不抛、不猜）', () => {
  // 基准 meta（inset 字段全在场）—— 构造脏变体逐项剥夺
  const base = {
    base64: '', mime: 'image/jpeg', width: 800, height: 400, bytes: 1, strategy: 'as-is+inset',
    sourceWidth: 1600, sourceHeight: 800, foveated: true,
    cropRect: null, foveaMode: 'inset' as const,
    insetRect: { x: 200, y: 0, w: 400, h: 400 }, insetScale: 2,
    insetNative: { width: 1600, height: 800 },
  };
  const expected = mapEncodedToOriginal(300, 150, 800, 400, 1600, 800); // Γ 等比：600,300
  assert.deepEqual(expected, { x: 600, y: 300 });
  // 剥夺 insetRect / insetScale / insetNative 各一路 ⇒ 同一回退值
  for (const patch of [
    { insetRect: undefined },
    { insetScale: undefined },
    { insetScale: NaN },
    { insetNative: undefined },
    { insetNative: { width: 0, height: 0 } },
    { insetRect: { x: -5, y: 0, w: 400, h: 400 } },  // 负原点 ⇒ 体检不过 ⇒ 回退
    { insetRect: { x: 700, y: 0, w: 400, h: 400 } },  // 越出缩图 ⇒ 体检不过 ⇒ 回退
    { width: 0 },                                      // 缩图维度崩 ⇒ 回退（等比也防御为 {0,0}）
  ] as const) {
    const meta = { ...base, ...patch } as typeof base;
    const back = mapInsetToOriginal(300, 150, meta);
    if (patch.width === 0) {
      assert.deepEqual(back, { x: 0, y: 0 }, '维度全崩 ⇒ {0,0}（不猜）');
    } else {
      assert.deepEqual(back, expected, `脏变体 ${JSON.stringify(patch)} 应回退 Γ 等比语义`);
    }
  }
});

test('Γ2-2c: 消费端出口联动 —— 注册表开 inset，grounding/vlmOcr 坐标分段反算回源图系', async (t) => {
  await withSharp(t, async (s) => {
    // 1200x600 < codec.maxDim 缺省 1568 ⇒ 消费端编码 as-is（无 resize），几何可手算：
    // 编码原生空间 1200x600 → inset scale2 缩图 600x300；edge=round(0.5×600)=300；
    // fx=floor((1200−300)/2)=450、fy=floor((600−300)/2)=150；ix=floor((600−300)/2)=150、iy=0
    const png = await targetScreenPng(s, 1200, 600);
    // 注册表路线：codec.foveated=1 + codec.foveaMode=1 ⇒ 消费端缺省编码即 inset
    kernelRegistry.register({ key: 'codec.foveated', organ: 'perception', defaultValue: 1, min: 0, max: 1 });
    kernelRegistry.register({ key: 'codec.foveaMode', organ: 'perception', defaultValue: 1, min: 0, max: 1, note: '纪元 Γ2 测试铸入（生产缺省未注册 = blur）' });
    try {
      const reqs: GlmVisionRequest[] = [];
      // vlmOcr：假 client 在缩图系（600x300）作答 —— 窗内词 1:1 原生精确、窗外词 2x。
      // 阅读序排序后 Corner(y=35) 先于 Center(y=130) —— 断言按排序后顺序
      const words = [
        { text: 'Center', confidence: 0.9, bbox: [200, 100, 260, 160] }, // 窗内（缩图系）
        { text: 'Corner', confidence: 0.8, bbox: [10, 10, 110, 60] },    // 窗外（缩图系）
      ];
      const r = await readTextViaVlm(png, {
        client: fakeClient(() => ({ ok: true, value: { words }, raw: '...' }), req => { reqs.push(req); }),
      });
      assert.equal(r.ok, true);
      assert.equal(r.coordinateSpace, 'original', '词坐标已分段反算回源图系');
      // 窗外（阅读序第一）：恰 2x 等比 ⇒ 源图 [20,20,220,120]
      assert.deepEqual(r.words[0]!.bbox, { x0: 20, y0: 20, x1: 220, y1: 120 });
      assert.deepEqual(r.words[0]!.center, { x: 120, y: 70 });
      // 窗内：缩图 [200,100,260,160] ⇔ 原生 (450,150) 提取窗 1:1 ⇒ 源图 [500,250,560,310]
      assert.deepEqual(r.words[1]!.bbox, { x0: 500, y0: 250, x1: 560, y1: 310 });
      assert.deepEqual(r.words[1]!.center, { x: 530, y: 280 });
      // 模型收到的图确为 600x300 缩图（inset 端到端生效）
      const img = reqs[0]!.images![0]!;
      const meta = await s(Buffer.from(img.base64!, 'base64')).metadata();
      assert.equal(meta.width, 600);
      assert.equal(meta.height, 300);
      // grounding：同一几何 —— 窗内元素 bbox/中心回源图系
      const g = await groundElements(png, {
        client: fakeClient(() => ({
          ok: true,
          value: { elements: [{ id: 'a', label: '靶心', role: 'button', bbox: [200, 100, 260, 160], confidence: 0.9 }] },
          raw: '...',
        })),
      });
      assert.equal(g.ok, true);
      assert.equal(g.strategy, 'vlm:as-is+inset', '策略标签随行');
      assert.equal(g.coordinateSpace, 'original');
      assert.deepEqual(g.elements[0]!.bbox, { x0: 500, y0: 250, x1: 560, y1: 310 });
      assert.deepEqual(g.elements[0]!.center, { x: 530, y: 280 });
    } finally {
      kernelRegistry.reset(); // 测试隔离：注册表复位（生产缺省 = 未注册 = blur）
    }
  });
});

// ─── Γ2-3 降级链（逐级诚实注记） ───

test('Γ2-3: 结构性不可用（foveaSize=1.0 ⇒ 凹窗放不进缩图）⇒ 一级降级 blur，foveated 仍真', async (t) => {
  await withSharp(t, async (s) => {
    const png = await targetScreenPng(s, 1600, 800);
    // foveaSize=1.0：edge=800 > downH=400 —— 居中占位将出负坐标 ⇒ inset 拒做
    const r = await encodeForVlmMeta(png, {
      maxDimension: 1600, foveated: true, foveaMode: 'inset',
      foveaSize: 1.0, foveaPeripheryScale: 2,
    });
    assert.equal(r.ok, true, '降级不毒化编码主路径');
    const v = r.value!;
    assert.equal(v.foveated, true, '一级降级 blur 生效 ⇒ foveated 仍真');
    assert.equal(v.foveaMode, 'blur', '模式诚实注记 blur（非 inset）');
    assert.equal(v.strategy, 'as-is+fovea', '策略走 Γ blur 后缀（无 +inset）');
    assert.equal(v.width, 1600, 'blur 语义：尺寸不变（Γ 坐标空间不变）');
    assert.equal(v.height, 800);
    assert.equal(v.insetRect, undefined, 'inset 元信息不得谎报在场');
    assert.equal(v.insetScale, undefined);
    assert.equal(v.insetNative, undefined);
  });
});

test('Γ2-3: composite 残废 ⇒ inset 失败→blur 失败→均质回退（foveated:false 诚实注记）', async (t) => {
  await withSharp(t, async (s) => {
    _overrideSharpResolver_forTest(() => Promise.resolve(crippleCompositeSharp(s)));
    try {
      const r = await encodeForVlmMeta(await targetScreenPng(s, 1600, 800), {
        maxDimension: 1600, foveated: true, foveaMode: 'inset', foveaPeripheryScale: 2,
      });
      assert.equal(r.ok, true, '两级降级都失败仍不毒化编码主路径');
      const v = r.value!;
      assert.equal(v.foveated, false, '诚实降级标 foveated:false');
      assert.equal(v.foveaMode, undefined, '无模式注记（未发生任何中央凹）');
      assert.equal(v.strategy, 'as-is', '无任何中央凹后缀');
      assert.equal(v.width, 1600, '均质路径：as-is 全尺寸');
      assert.equal(v.height, 800);
      const bin = Buffer.from(v.base64, 'base64');
      assert.equal(bin[0], 0xff, '真图仍在（JPEG SOI）');
      assert.ok(bin.length > 0);
    } finally {
      _overrideSharpResolver_forTest(null); // 复位生产解析器（测试隔离）
    }
  });
});

test('Γ2-3: sharp 缺席（解析器注入 stub）⇒ ok:false 绝不抛、不谎称 inset', async () => {
  _overrideSharpResolver_forTest(async () => {
    throw new Error('sharp unavailable (Γ2-3 simulated absence)');
  });
  try {
    const r = await encodeForVlmMeta(Buffer.from('non-empty placeholder', 'utf8'), {
      foveated: true, foveaMode: 'inset',
    });
    assert.equal(r.ok, false, 'sharp 缺席 = 编码不可得（诚实失败，绝不抛）');
    assert.match(r.error ?? '', /sharp unavailable/);
    assert.notEqual(r.value?.foveaMode ?? undefined, 'inset', '缺席时不得谎称 inset 生效');
    // 均质请求同律（旧行为不变：缺席与模式无关）
    const r2 = await encodeForVlmMeta(Buffer.from('non-empty placeholder', 'utf8'));
    assert.equal(r2.ok, false);
    assert.match(r2.error ?? '', /sharp unavailable/);
  } finally {
    _overrideSharpResolver_forTest(null);
  }
});

// ─── Γ2-4 Γ 回归：blur 显式 = blur 缺省；开关关 = mode 惰性；注册表 0/1 语义 ───

test('Γ2-4: blur 显式 = blur 缺省逐字节同源（Γ 行为零变化）；开关关 ⇒ mode 惰性', async (t) => {
  await withSharp(t, async (s) => {
    const png = await targetScreenPng(s, 1600, 800);
    const a = await encodeForVlmMeta(png, { maxDimension: 1600, foveated: true });                    // 缺省 mode = blur
    const b = await encodeForVlmMeta(png, { maxDimension: 1600, foveated: true, foveaMode: 'blur' }); // 显式 blur
    assert.equal(a.ok && b.ok, true);
    assert.equal(b.value!.base64, a.value!.base64, 'blur 显式 = blur 缺省（逐字节）');
    assert.equal(b.value!.strategy, 'as-is+fovea');
    assert.equal(b.value!.foveaMode, 'blur');
    assert.equal(b.value!.width, 1600, 'blur：尺寸不变（Γ 语义）');
    assert.equal(b.value!.height, 800);
    assert.equal(b.value!.insetRect, undefined);
    // 开关关：mode 惰性（无中央凹、无 inset 字段 —— Γ「开关关零行为变化」同律）
    const off = await encodeForVlmMeta(png, { maxDimension: 1600, foveated: false, foveaMode: 'inset' });
    assert.equal(off.ok, true);
    assert.equal(off.value!.foveated, false);
    assert.equal(off.value!.foveaMode, undefined);
    assert.equal(off.value!.strategy, 'as-is');
    assert.equal(off.value!.width, 1600);
    assert.equal(off.value!.insetRect, undefined);
    // 非法 fovea 参数拒绝与模式无关（Γ 校验对两模式同律）
    const bad = await encodeForVlm(png, { foveated: true, foveaMode: 'inset', foveaSize: 0 });
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? '', /foveaSize/);
  });
});

test('Γ2-4: 注册表 codec.foveaMode 0/1 数值语义翻转缺省；显式入参恒压过注册表', async (t) => {
  await withSharp(t, async (s) => {
    const png = await targetScreenPng(s, 1600, 800);
    const common = { maxDimension: 1600, foveated: true } as const;
    try {
      // 未注册 ⇒ 缺省 blur（上面已证逐字节；此处只验 registry=1 的翻转）
      kernelRegistry.register({ key: 'codec.foveaMode', organ: 'perception', defaultValue: 1, min: 0, max: 1 });
      const on = await encodeForVlmMeta(png, common);
      assert.equal(on.ok, true);
      assert.equal(on.value!.foveaMode, 'inset', '注册表 1 ⇒ 缺省 inset（>0.5 即真，与 codec.foveated 同款）');
      assert.equal(on.value!.strategy, 'as-is+inset');
      assert.equal(on.value!.width, 800);
      // 显式 'blur' 压过注册表 1（显式入参最高优先）
      const explicitBlur = await encodeForVlmMeta(png, { ...common, foveaMode: 'blur' });
      assert.equal(explicitBlur.value!.foveaMode, 'blur');
      assert.equal(explicitBlur.value!.strategy, 'as-is+fovea');
      assert.equal(explicitBlur.value!.width, 1600);
      // 注册表拨回 0 ⇒ 缺省回 blur
      kernelRegistry.set('codec.foveaMode', 0);
      const off = await encodeForVlmMeta(png, common);
      assert.equal(off.value!.foveaMode, 'blur');
      assert.equal(off.value!.strategy, 'as-is+fovea');
    } finally {
      kernelRegistry.reset(); // 测试隔离
    }
  });
});
