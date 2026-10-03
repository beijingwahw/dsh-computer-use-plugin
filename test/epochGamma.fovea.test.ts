// test/epochGamma.fovea.test.ts
// 纪元 Γ（注视经济）：坐标反算 + 中央凹加权编码的执法册。
//   Γ-1 反算纯函数：mapEncodedToOriginal / mapBboxEncodedToOriginal ——
//      往返执法（原→编码→原，误差 ≤1px）、clamp 图内、除零与脏维度防御；
//      真编码管线联动（3200x1600 → 1568x784；region+resize 的 cropRect 契约）。
//   Γ-2 中央凹开关：合成 2x2 棋盘小图（sharp 现铸，参照 vlm.codec.test.ts）——
//      foveated 编码尺寸 = 均质路径；外围像素确实模糊而中央保持（取样比对）；
//      开关关 = 逐字节均质路径；非法 fovea 参数拒绝。
//   Γ-3 诚实降级：sharp 缺席（codec 解析器注入 stub）⇒ 不抛、不谎称 foveated；
//      composite 残废（真 sharp 链上唯 composite 抛错）⇒ 均质回退 foveated:false；
//      grounding / vlmOcr 假 client 注入 —— coordinateSpace 标注执法
//      （'original'：反算成立或声明系直通；失败路径诚实缺席）。
// 铁律：全离线确定性 —— sharp 现铸真图 + 假 client 桩，零网络零 fixture 文件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSharp, type SharpLike } from '../src/_legacyDeps.ts';
import type { GlmClient, GlmVisionRequest } from '../src/vlm/glmClient.ts';
import type { Bbox } from '../src/vlm/codec.ts';

// 契约模块经动态 import 加载（Ω-2 铁律：不在测试顶层静态绑定被测模块；
// 三模块 import 全部离线安全 —— sharp 仍是调用点懒加载）
const {
  encodeForVlm, encodeForVlmMeta, estimateVlmTokens,
  mapEncodedToOriginal, mapBboxEncodedToOriginal,
  _overrideSharpResolver_forTest,
} = await import('../src/vlm/codec.ts');
const { groundElements } = await import('../src/vlm/grounding.ts');
const { readTextViaVlm, findTextViaVlm } = await import('../src/vlm/vlmOcr.ts');

// ─── 测试脚手架 ───

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

/** 合成纯色 PNG（真图走 sharp 解码主路径，无外部 fixture 文件） */
async function solidPng(
  s: SharpLike, w: number, h: number, rgb: [number, number, number] = [200, 40, 40],
): Promise<Buffer> {
  const row = Buffer.concat(Array.from({ length: w }, () => Buffer.from(rgb)));
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return s(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/**
 * 合成 2x2 棋盘 PNG（Γ-2 的注视经济试金石：高频棋盘 —— 外围降采样后糊成中灰，
 * 中央原生保留黑白跳变；模糊前后像素差 ≈128，取样比对信号最强）。
 */
async function checkerPng(s: SharpLike, w: number, h: number): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = ((x >> 1) + (y >> 1)) % 2 === 0 ? 0 : 255;
      const i = (y * w + x) * 3;
      raw[i] = v; raw[i + 1] = v; raw[i + 2] = v;
    }
  }
  return s(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/** JPEG → 原始 RGB（取样比对用；通道数断言 3 —— flatten 后 JPEG 无 alpha） */
async function decodeRgb(s: SharpLike, jpegBuf: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const out = (await s(jpegBuf).raw().toBuffer({ resolveWithObject: true })) as unknown as {
    data: Uint8Array | Buffer;
    info: { width: number; height: number; channels: number };
  };
  assert.equal(out.info.channels, 3, '解码后应为 3 通道 RGB');
  return { data: Buffer.from(out.data), width: out.info.width, height: out.info.height };
}

/** 取样像素的逐通道 RGB */
function pixelAt(img: { data: Buffer; width: number }, x: number, y: number): [number, number, number] {
  const i = (y * img.width + x) * 3;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
}

/** grounding 假 client：记录请求，回放预设 chatJson 结果（零网络） */
function fakeGroundClient(
  reply: () => { ok: boolean; value?: unknown; error?: string; raw: string },
): { client: GlmClient; requests: GlmVisionRequest[] } {
  const requests: GlmVisionRequest[] = [];
  const client = {
    configured: true,
    chatJson: async (req: GlmVisionRequest) => {
      requests.push(req);
      return reply();
    },
  } as unknown as GlmClient;
  return { client, requests };
}

/** vlmOcr 假 client：只实现 chatJson，捕获请求（零网络） */
function fakeOcrClient(
  reply: () => { ok: boolean; value?: unknown; error?: string; raw: string },
): { client: GlmClient; calls: Array<{ images: Array<{ base64: string; mime?: string }> }> } {
  const calls: Array<{ images: Array<{ base64: string; mime?: string }> }> = [];
  const client = {
    chatJson: async (req: { images?: unknown }) => {
      calls.push({ images: Array.isArray(req.images) ? (req.images as Array<{ base64: string; mime?: string }>) : [] });
      return reply();
    },
  } as unknown as GlmClient;
  return { client, calls };
}

/**
 * Γ-3 残废 sharp：链上一切方法透传真 sharp，唯 composite 抛错 —— 验证
 * 中央凹失败 ⇒ 均质回退（foveated:false）的诚实降级路径。递归包裹保证
 * clone/resize 衍生链同样残废（仅 composite 一处命中）。
 */
function crippleCompositeSharp(real: SharpLike): SharpLike {
  const wrapChain = (chain: object): any => new Proxy(chain, {
    get(target, prop) {
      if (prop === 'composite') {
        return () => { throw new Error('composite broken (Γ-3 stub)'); };
      }
      const v = Reflect.get(target, prop);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        const out = (v as (...a: unknown[]) => unknown).apply(target, args);
        if (out !== null && typeof out === 'object' && typeof (out as any).then !== 'function') {
          return wrapChain(out); // 链式方法返回新链 ⇒ 递归包裹；Promise 原样放行
        }
        return out;
      };
    },
  });
  return ((input?: Buffer | string | Uint8Array, options?: { [k: string]: any }) =>
    wrapChain((real as any)(input, options))) as unknown as SharpLike;
}

// ─── Γ-1 坐标反算纯函数 ───

test('Γ-1: mapEncodedToOriginal —— 恒等/等比/逐轴缩放/round 取整/clamp 图内', () => {
  // 恒等（无缩放编码：as-is 路径）
  assert.deepEqual(mapEncodedToOriginal(5, 7, 100, 50, 100, 50), { x: 5, y: 7 });
  // 等比 2:1 整除：1568x784 ← 3200x1600 的图心恰为源图图心
  assert.deepEqual(mapEncodedToOriginal(784, 392, 1568, 784, 3200, 1600), { x: 1600, y: 800 });
  // 2x 逐轴反算
  assert.deepEqual(mapEncodedToOriginal(3, 7, 10, 10, 20, 20), { x: 6, y: 14 });
  // 非整除比例逐轴独立（x、y 各按实际维度比值）
  assert.deepEqual(mapEncodedToOriginal(100, 50, 300, 99, 1000, 200), { x: 333, y: 101 });
  // round（.5 以上进位）
  assert.deepEqual(mapEncodedToOriginal(2.6, 2.4, 10, 10, 10, 10), { x: 3, y: 2 });
  // clamp 图内：越界坐标夹回 [0,origW]x[0,origH]（右/下缘=尺寸合法 —— bbox 约定）
  assert.deepEqual(mapEncodedToOriginal(-50, 99999, 100, 100, 200, 200), { x: 0, y: 200 });
  assert.deepEqual(mapEncodedToOriginal(150, 50, 100, 100, 200, 200), { x: 200, y: 100 });
});

test('Γ-1: mapEncodedToOriginal —— 除零与脏维度防御（任一维度非有限/<1 ⇒ {0,0}，绝不抛）', () => {
  assert.deepEqual(mapEncodedToOriginal(5, 5, 0, 100, 200, 200), { x: 0, y: 0 }, 'encW=0 除零');
  assert.deepEqual(mapEncodedToOriginal(5, 5, 100, 0, 200, 200), { x: 0, y: 0 }, 'encH=0 除零');
  assert.deepEqual(mapEncodedToOriginal(5, 5, 100, 100, 0, 200), { x: 0, y: 0 }, 'origW=0 无图内可夹');
  assert.deepEqual(mapEncodedToOriginal(5, 5, 100, 100, 200, 0), { x: 0, y: 0 }, 'origH=0 无图内可夹');
  assert.deepEqual(mapEncodedToOriginal(5, 5, NaN, Infinity, 200, -3), { x: 0, y: 0 }, '非有限维度');
  assert.deepEqual(mapEncodedToOriginal(5, 5, 0.5, 100, 200, 200), { x: 0, y: 0 }, '分数维度按不可用记');
  // 坐标分量非有限按 0 记（不猜、不抛）
  assert.deepEqual(mapEncodedToOriginal(NaN, -Infinity, 100, 100, 200, 200), { x: 0, y: 0 });
});

test('Γ-1: mapBboxEncodedToOriginal —— 四角独立反算的盒子形态 + 残缺入参防御', () => {
  assert.deepEqual(
    mapBboxEncodedToOriginal({ x0: 744, y0: 362, x1: 824, y1: 422 }, 1568, 784, 3200, 1600),
    { x0: 1518, y0: 739, x1: 1682, y1: 861 },
  );
  // 残缺盒（字段缺席按 0 记）+ 脏维度 ⇒ 全零盒，不抛
  assert.deepEqual(
    mapBboxEncodedToOriginal({} as Bbox, 100, 100, 200, 200),
    { x0: 0, y0: 0, x1: 0, y1: 0 },
  );
  assert.deepEqual(
    mapBboxEncodedToOriginal({ x0: 1, y0: 1, x1: 2, y1: 2 }, 0, 0, 200, 200),
    { x0: 0, y0: 0, x1: 0, y1: 0 },
  );
});

test('Γ-1: 真编码管线往返执法 —— 3200x1600 → 1568x784，原→编码→原误差 ≤1px（sharp 现铸）', async (t) => {
  await withSharp(t, async (s) => {
    const enc = await encodeForVlmMeta(await solidPng(s, 3200, 1600));
    assert.equal(enc.ok, true, '编码前置成功');
    const v = enc.value!;
    assert.equal(v.width, 1568);
    assert.equal(v.height, 784);
    // 元信息契约：源图宽高随行、无裁剪、均质（缺省开关关）
    assert.equal(v.sourceWidth, 3200);
    assert.equal(v.sourceHeight, 1600);
    assert.equal(v.cropRect, null);
    assert.equal(v.foveated, false);
    // 往返执法：网格取样，前向（镜像 codec 的 round 公式）+ 反算回源图系
    for (const ox of [0, 1, 640, 1234, 1600, 2401, 3199, 3200]) {
      for (const oy of [0, 1, 77, 800, 1235, 1599, 1600]) {
        const ex = Math.round((ox * v.width) / 3200);
        const ey = Math.round((oy * v.height) / 1600);
        const back = mapEncodedToOriginal(ex, ey, v.width, v.height, 3200, 1600);
        assert.ok(Math.abs(back.x - ox) <= 1, `x 往返 ${ox}→${ex}→${back.x} 超 1px`);
        assert.ok(Math.abs(back.y - oy) <= 1, `y 往返 ${oy}→${ey}→${back.y} 超 1px`);
      }
    }
  });
});

test('Γ-1: region+resize 元信息契约 —— cropRect 随行，缩放+平移复合反算精确', async (t) => {
  await withSharp(t, async (s) => {
    // 4000x2000 源图，兴趣区 (500,400)-(3500,1900) = 3000x1500 裁剪窗 → 缩到 1568x784
    const enc = await encodeForVlmMeta(await solidPng(s, 4000, 2000), {
      region: { x0: 500, y0: 400, x1: 3500, y1: 1900 },
    });
    assert.equal(enc.ok, true);
    const v = enc.value!;
    assert.equal(v.strategy, 'crop+resize');
    assert.equal(v.width, 1568);
    assert.equal(v.height, 784);
    assert.equal(v.sourceWidth, 4000, '源图宽 = 裁剪前原图（反算的总画布）');
    assert.equal(v.sourceHeight, 2000);
    assert.deepEqual(v.cropRect, { left: 500, top: 400, width: 3000, height: 1500 });
    // 复合反算：编码图心 (784,392) → 裁剪窗 (1500,750) → +偏移 → 源图 (2000,1150)
    const mid = mapEncodedToOriginal(784, 392, v.width, v.height, v.cropRect!.width, v.cropRect!.height);
    assert.deepEqual(mid, { x: 1500, y: 750 });
    assert.deepEqual(
      { x: mid.x + v.cropRect!.left, y: mid.y + v.cropRect!.top },
      { x: 2000, y: 1150 },
    );
  });
});

// ─── Γ-2 中央凹开关 ───

test('Γ-2: foveated 编码 —— 尺寸与均质路径一致、策略/标志/Token 估算联动', async (t) => {
  await withSharp(t, async (s) => {
    const png = await checkerPng(s, 120, 80);
    const hom = await encodeForVlmMeta(png);
    const fov = await encodeForVlmMeta(png, { foveated: true });
    assert.equal(hom.ok && fov.ok, true, '双路径编码前置成功');
    const h = hom.value!, f = fov.value!;
    // 尺寸一致（坐标空间不变 —— 中央凹只是模糊，不动几何）
    assert.equal(f.width, h.width, '宽 = 均质路径');
    assert.equal(f.height, h.height, '高 = 均质路径');
    assert.equal(f.sourceWidth, 120);
    assert.equal(f.sourceHeight, 80);
    // 策略与元信息标志
    assert.equal(h.strategy, 'as-is');
    assert.equal(f.strategy, 'as-is+fovea', '策略追加 +fovea 后缀（可观测）');
    assert.equal(h.foveated, false, '均质路径诚实标 false');
    assert.equal(f.foveated, true, '中央凹生效标 true');
    // Token 估算联动：分辨率未变 ⇒ 估算不变（foveated 标志供上游观测）
    assert.equal(estimateVlmTokens(f.width, f.height), estimateVlmTokens(h.width, h.height));
    // 输出仍是合法 JPEG
    const bin = Buffer.from(f.base64, 'base64');
    assert.equal(bin.length, f.bytes);
    assert.equal(bin[0], 0xff);
    assert.equal(bin[1], 0xd8);
  });
});

test('Γ-2: 外围确实模糊而中央保持 —— 棋盘取样比对（foveaSize 0.5 ⇒ 中央 [40,80)x[20,60)）', async (t) => {
  await withSharp(t, async (s) => {
    const png = await checkerPng(s, 120, 80);
    const hom = await encodeForVlm(png);
    // 外围降采样因子 4：2x2 棋盘格的 4x4 像素块（黑白格各二）缩成单像素 ⇒
    // 均值中灰 —— 模糊幅度确定性（≈127 vs 0/255），不赌重采样核的纹波
    const fov = await encodeForVlmMeta(png, { foveated: true, foveaPeripheryScale: 4 });
    assert.equal(hom.ok && fov.ok, true);
    assert.equal(fov.value!.foveated, true);
    const homImg = await decodeRgb(s, Buffer.from(hom.value!.base64, 'base64'));
    const fovImg = await decodeRgb(s, Buffer.from(fov.value!.base64, 'base64'));
    assert.equal(homImg.width, 120);
    assert.equal(homImg.height, 80);
    // 中央取样（60,40）：距凹窗边界 ≥20px（8x8 luma / 16x16 chroma 块全在窗内）
    //   —— 中央原生 ⇒ 两路径逐通道几乎全同（JPEG 块级确定性，留少量容差）
    const c1 = pixelAt(homImg, 60, 40), c2 = pixelAt(fovImg, 60, 40);
    for (let ch = 0; ch < 3; ch++) {
      assert.ok(Math.abs(c1[ch]! - c2[ch]!) <= 12, `中央 (60,40) 通道${ch}: 均质${c1[ch]} vs 凹化${c2[ch]}`);
    }
    // 外围取样（角落，远离凹窗）：棋盘 0/255 → 降采样糊成中灰 ⇒ 大幅变化
    for (const [px, py] of [[6, 6], [113, 73]] as const) {
      const a = pixelAt(homImg, px, py), b = pixelAt(fovImg, px, py);
      const delta = Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!), Math.abs(a[2]! - b[2]!));
      assert.ok(delta >= 60, `外围 (${px},${py}) 应显著模糊：均质${a} vs 凹化${b}（Δ=${delta}）`);
    }
  });
});

test('Γ-2: 开关关 = 逐字节均质路径（缺省与显式 false 双确认）', async (t) => {
  await withSharp(t, async (s) => {
    const png = await checkerPng(s, 120, 80);
    const a = await encodeForVlmMeta(png);                               // 缺省 foveated:false
    const b = await encodeForVlmMeta(png, { foveated: false });          // 显式关
    assert.equal(a.ok && b.ok, true);
    assert.equal(b.value!.base64, a.value!.base64, '逐字节 = 均质路径');
    assert.equal(b.value!.strategy, a.value!.strategy);
    assert.equal(b.value!.foveated, false);
    assert.equal(b.value!.bytes, a.value!.bytes);
  });
});

test('Γ-2: 非法 fovea 参数拒绝 —— foveaSize 出 (0,1] / foveaPeripheryScale ≤1', async (t) => {
  await withSharp(t, async (s) => {
    const png = await solidPng(s, 64, 48);
    const badSizeZero = await encodeForVlm(png, { foveated: true, foveaSize: 0 });
    assert.equal(badSizeZero.ok, false);
    assert.match(badSizeZero.error ?? '', /foveaSize/);
    const badSizeHigh = await encodeForVlm(png, { foveated: true, foveaSize: 1.5 });
    assert.equal(badSizeHigh.ok, false);
    const badScale = await encodeForVlm(png, { foveated: true, foveaPeripheryScale: 1 });
    assert.equal(badScale.ok, false);
    assert.match(badScale.error ?? '', /foveaPeripheryScale/);
    // 开关关时脏数值不触发校验（缺省路径零行为变化）
    const off = await encodeForVlm(png, { foveated: false, foveaSize: 0 });
    assert.equal(off.ok, true);
  });
});

// ─── Γ-3 诚实降级 ───

test('Γ-3: sharp 缺席（解析器注入 stub）⇒ 不抛、ok:false 诚实报错、不谎称 foveated', async () => {
  // codec 的 sharp 解析器注入缝：生产恒 _legacyDeps.getSharp，此处模拟缺席
  _overrideSharpResolver_forTest(async () => {
    throw new Error('sharp unavailable (Γ-3 simulated absence)');
  });
  try {
    const r = await encodeForVlmMeta(Buffer.from('non-empty placeholder', 'utf8'), { foveated: true });
    assert.equal(r.ok, false, 'sharp 缺席 = 编码不可得（诚实失败，绝不抛）');
    assert.match(r.error ?? '', /sharp unavailable/);
    assert.notEqual(r.value?.foveated ?? false, true, '缺席时不得谎称中央凹生效');
    // 均质请求同律（旧行为不变：缺席与开关无关）
    const r2 = await encodeForVlmMeta(Buffer.from('non-empty placeholder', 'utf8'));
    assert.equal(r2.ok, false);
    assert.match(r2.error ?? '', /sharp unavailable/);
  } finally {
    _overrideSharpResolver_forTest(null); // 复位生产解析器（测试隔离）
  }
});

test('Γ-3: composite 残废（真 sharp 链上唯 composite 抛错）⇒ 均质回退 foveated:false', async (t) => {
  await withSharp(t, async (s) => {
    _overrideSharpResolver_forTest(() => Promise.resolve(crippleCompositeSharp(s)));
    try {
      const r = await encodeForVlmMeta(await checkerPng(s, 120, 80), { foveated: true });
      assert.equal(r.ok, true, '中央凹失败不毒化编码主路径');
      assert.equal(r.value!.foveated, false, '诚实降级标 foveated:false');
      assert.equal(r.value!.strategy, 'as-is', '无 +fovea 后缀');
      assert.equal(r.value!.width, 120);
      assert.equal(r.value!.height, 80);
      const bin = Buffer.from(r.value!.base64, 'base64');
      assert.equal(bin[0], 0xff, '真图仍在（JPEG SOI）');
      assert.ok(bin.length > 0);
    } finally {
      _overrideSharpResolver_forTest(null);
    }
  });
});

// ─── Γ-3c grounding / vlmOcr 的 coordinateSpace 标注（假 client，零网络） ───

test('Γ-3c: grounding 大图未声明尺寸 ⇒ bbox 反算回源图系（coordinateSpace=original）', async (t) => {
  await withSharp(t, async (s) => {
    // 3200x1600 源图必被编码缩到 1568x784：模型编码系作答，输出须回源图系
    const png = await solidPng(s, 3200, 1600);
    const { client, requests } = fakeGroundClient(() => ({
      ok: true,
      value: {
        elements: [
          { id: 'a', label: '靶心', role: 'button', bbox: [744, 362, 824, 422], confidence: 0.9 },
        ],
      },
      raw: '...',
    }));
    const r = await groundElements(png, { client });
    assert.equal(r.ok, true);
    assert.equal(r.coordinateSpace, 'original', '反算成立 ⇒ 源图系标注');
    assert.equal(r.elements.length, 1);
    const el = r.elements[0]!;
    // 四角反算：744×3200/1568=1518.37→1518、824→1682、362×1600/784=738.78→739、422→861
    assert.deepEqual(el.bbox, { x0: 1518, y0: 739, x1: 1682, y1: 861 });
    // 图心 (784,392) 编码系 ⇔ (1600,800) 源图系（等比 2.0408 精确互映）
    assert.deepEqual(el.center, { x: 1600, y: 800 });
    // 提示词坐标系仍是编码尺寸（模型在所见图上作答 —— 反算只发生在出口）
    assert.ok(requests[0]!.prompt.includes('1568'), 'som 提示词按编码宽 1568 声明');
    assert.ok(requests[0]!.prompt.includes('784'), 'som 提示词按编码高 784 声明');
  });
});

test('Γ-3c: grounding 小图恒等反算与显式声明直通 —— 双路径均标 original', async (t) => {
  await withSharp(t, async (s) => {
    const png = await solidPng(s, 64, 48); // as-is：反算恒等
    const mk = () => fakeGroundClient(() => ({
      ok: true,
      value: { elements: [{ id: 'x', label: '按钮', role: 'button', bbox: [8, 10, 40, 30], confidence: 0.9 }] },
      raw: '...',
    }));
    // 未声明：恒等反算回源图系（值不变，标注升级）
    const r1 = await groundElements(png, { client: mk().client });
    assert.equal(r1.ok, true);
    assert.equal(r1.coordinateSpace, 'original');
    assert.deepEqual(r1.elements[0]!.bbox, { x0: 8, y0: 10, x1: 40, y1: 30 });
    // 显式声明 100x100 屏幕语义：模型按声明系作答 ⇒ 直通不反算
    const r2 = await groundElements(png, {
      client: fakeGroundClient(() => ({
        ok: true,
        value: { elements: [{ id: 'x', label: '按钮', role: 'button', bbox: [70, 60, 90, 80], confidence: 0.8 }] },
        raw: '...',
      })).client,
      width: 100, height: 100,
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.coordinateSpace, 'original', '声明系 = 调用方屏幕语义');
    assert.deepEqual(r2.elements[0]!.bbox, { x0: 70, y0: 60, x1: 90, y1: 80 }, '声明系直通');
  });
});

test('Γ-3c: vlmOcr region 词坐标 —— 缩放+平移复合反算回源图系（coordinateSpace=original）', async (t) => {
  await withSharp(t, async (s) => {
    const png = await solidPng(s, 400, 300);
    const { client, calls } = fakeOcrClient(() => ({
      ok: true, raw: '',
      value: { words: [{ text: 'Region', confidence: 0.9, bbox: [10, 10, 110, 140] }] },
    }));
    // 兴趣区 (100,50)-(300,200) = 200x150 裁剪窗（无缩放：200 < 1568）
    const r = await readTextViaVlm(png, { region: { x0: 100, y0: 50, x1: 300, y1: 200 }, client });
    assert.equal(r.ok, true);
    assert.equal(r.coordinateSpace, 'original', '词坐标已回源图系');
    assert.deepEqual(r.words[0]!.bbox, { x0: 110, y0: 60, x1: 210, y1: 190 }, '恒等缩放 + (100,50) 平移');
    assert.deepEqual(r.words[0]!.center, { x: 160, y: 125 });
    // 模型收到的图仍是 200x150 裁剪窗（编码空间未变 —— 反算只在输出端）
    assert.equal(calls.length, 1);
    const meta = await s(Buffer.from(calls[0]!.images[0]!.base64, 'base64')).metadata();
    assert.equal(meta.width, 200);
    assert.equal(meta.height, 150);
    // findText 命中中心同空间随行透传 —— 注意 findTextViaVlm 不收 region
    // （全图编码 ⇒ 假 client 词 bbox [10,10,110,140] 即全图系原值，无平移）
    const f = await findTextViaVlm(png, 'region', { client });
    assert.equal(f.ok, true);
    assert.equal(f.coordinateSpace, 'original');
    assert.deepEqual(f.matches[0]!.center, { x: 60, y: 75 }, '全图系（无 region ⇒ 无平移）');
  });
});

test('Γ-3c: vlmOcr 无 region 恒等反算 + 失败路径 coordinateSpace 诚实缺席', async (t) => {
  await withSharp(t, async (s) => {
    const png = await solidPng(s, 300, 200);
    // 无 region：恒等反算（值不变），标注 original
    const ok = fakeOcrClient(() => ({
      ok: true, raw: '',
      value: { words: [{ text: 'Plain', confidence: 0.8, bbox: [10, 20, 110, 60] }] },
    }));
    const r = await readTextViaVlm(png, { client: ok.client });
    assert.equal(r.ok, true);
    assert.equal(r.coordinateSpace, 'original');
    assert.deepEqual(r.words[0]!.bbox, { x0: 10, y0: 20, x1: 110, y1: 60 });
    // 云脑失败：words 恒空 ⇒ 坐标空间无意义，字段诚实缺席（不谎报 original）
    const bad = fakeOcrClient(() => ({ ok: false, error: 'mock outage', raw: '' }));
    const r2 = await readTextViaVlm(png, { client: bad.client });
    assert.equal(r2.ok, false);
    assert.equal(r2.coordinateSpace, undefined, '失败路径不带坐标空间标注');
    const f2 = await findTextViaVlm(png, 'x', { client: bad.client });
    assert.equal(f2.ok, false);
    assert.equal(f2.coordinateSpace, undefined);
  });
});
