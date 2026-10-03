// test/w1visualecon.test.ts
// W1-9（视觉经济包）执法册 —— P1 任务驱动注视 + C4 预算弹性调度。
//   P1-a foveaCenter 缺省兼容：缺省（缺席）与显式几何中心 (0.5,0.5) 在 blur/inset
//      两模式逐字节同源（缺省路径零行为变化的强形式）；开关关 ⇒ 参数惰性；
//      非法 foveaCenter 拒绝（与 foveaSize 同律）。
//   P1-b 注视窗正反算闭环：inset + 自定义注视心的 insetRect/insetExtract 数学
//      逐字段精确（手算常量）；窗内 1:1 原生反算精确、窗外按缩图实际比值；
//      crop+resize+inset+注视心的全复合往返（≤2px —— 两级缩放取整上界）；
//      mapInsetToOriginal 消费 insetExtract、脏值诚实回退居中提取律。
//   P1-c gazeRouter 三路加权：先验排序 grounding>diff>cursor、taskRelevance
//      加权翻转、同分先验裁决、非法候选跳过、全缺席几何中心回退、纯函数性。
//   C4-a requote 分档边界：配额充裕原档 / economy（quality→60）/ deep（maxDim→1024）
//      的含等号边界；commit 历史均值反馈；只降不升钳制；脏 remainingSteps 防御；
//      requote 对用量账面只读。
//   C4-b 防抖：连续 N（缺省 3）次建议一致才切换、异见清零、reset 归档、
//      debounceN:1 立即切换。
//   锚点缓存：record/get/clear 往返 + 垃圾拒收 + suggestFoveaCenter 三路组合
//      与 gazeRouter 判决一致；端到端接线（锚点 → 路由 → foveaCenter → 编码
//      注视窗落在锚点处）。
// 铁律：全离线确定性 —— sharp 现铸真图，零网络零 fixture 文件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSharp, type SharpLike } from '../src/_legacyDeps.ts';

// 契约模块经动态 import 加载（Ω-2 铁律：不在测试顶层静态绑定被测模块）
const {
  encodeForVlm, encodeForVlmMeta, estimateVlmTokens,
  mapInsetToOriginal, gazeRouter, VlmBudget,
  _overrideSharpResolver_forTest,
} = await import('../src/vlm/codec.ts');
const { contextManager } = await import('../src/contextManager.ts');

// ─── 测试脚手架（与 epochGamma.fovea.test.ts 同构） ───

let sharpCache: SharpLike | null = null;
async function requireSharp(): Promise<SharpLike> {
  if (!sharpCache) sharpCache = await getSharp();
  return sharpCache;
}

/** 懒检查 sharp 是否可用，不可用时 test 直接 SKIP（仓库先例） */
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

/** 合成「棋盘 + 目标块」PNG：外围高频棋盘（降采样后糊成中灰 —— 模糊信号源）+ 可控目标块 */
async function gazeScreenPng(
  s: SharpLike, w: number, h: number,
  blockW = Math.floor(w / 8), blockH = Math.floor(h / 8),
  bx0 = Math.floor(w / 4), by0 = Math.floor(h / 4),
): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  const bx1 = bx0 + blockW, by1 = by0 + blockH;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inBlock = x >= bx0 && x < bx1 && y >= by0 && y < by1;
      const v = inBlock ? 40 : (((x >> 1) + (y >> 1)) % 2 === 0 ? 210 : 40);
      const i = (y * w + x) * 3;
      raw[i] = v; raw[i + 1] = v; raw[i + 2] = v;
    }
  }
  return s(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/** 合成 2x2 棋盘 PNG（blur 试金石：高频棋盘降采样后糊向中灰） */
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

/** JPEG → 原始 RGB（取样比对用） */
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

// ─── P1-a：foveaCenter 缺省兼容 ───

test('P1-a: 缺省(缺席)与显式几何中心逐字节同源 —— blur 与 inset 双模式', async (t) => {
  await withSharp(t, async (s) => {
    const png = await gazeScreenPng(s, 1600, 800);
    // blur 模式：缺席 vs {0.5,0.5} —— base64 逐字节相同
    const bDef = await encodeForVlmMeta(png, { maxDimension: 1600, foveated: true });
    const bHalf = await encodeForVlmMeta(png, { maxDimension: 1600, foveated: true, foveaCenter: { x: 0.5, y: 0.5 } });
    assert.equal(bDef.ok && bHalf.ok, true);
    assert.equal(bHalf.value!.base64, bDef.value!.base64, 'blur: 显式几何中心 = 缺省（逐字节）');
    assert.equal(bDef.value!.foveaCenter, undefined, 'blur 缺省：注视中心回声缺席');
    assert.deepEqual(bHalf.value!.foveaCenter, { x: 0.5, y: 0.5 }, 'blur 显式：回声原样');
    // inset 模式：同律 + insetRect/insetExtract 与 Γ2-1 已知常量一致（居中律恒等）
    const iDef = await encodeForVlmMeta(png, {
      maxDimension: 1600, foveated: true, foveaMode: 'inset', foveaPeripheryScale: 2,
    });
    const iHalf = await encodeForVlmMeta(png, {
      maxDimension: 1600, foveated: true, foveaMode: 'inset', foveaPeripheryScale: 2,
      foveaCenter: { x: 0.5, y: 0.5 },
    });
    assert.equal(iDef.ok && iHalf.ok, true);
    assert.equal(iHalf.value!.base64, iDef.value!.base64, 'inset: 显式几何中心 = 缺省（逐字节）');
    assert.deepEqual(iDef.value!.insetRect, { x: 200, y: 0, w: 400, h: 400 }, 'inset 缺省：Γ2-1 居中占位律常量');
    assert.deepEqual(iDef.value!.insetExtract, { x: 600, y: 200 }, 'inset 缺省：提取原点 = 居中提取律恒等值');
    assert.deepEqual(iHalf.value!.insetExtract, { x: 600, y: 200 }, 'inset 显式几何中心：同值');
  });
});

test('P1-a: 开关关 ⇒ foveaCenter 惰性（逐字节均质路径，回声缺席）', async (t) => {
  await withSharp(t, async (s) => {
    const png = await gazeScreenPng(s, 120, 80);
    const hom = await encodeForVlm(png);
    const off = await encodeForVlm(png, { foveated: false, foveaCenter: { x: 0.2, y: 0.8 } });
    assert.equal(hom.ok && off.ok, true);
    assert.equal(off.value!.base64, hom.value!.base64, '开关关 + 注视心 = 逐字节均质路径');
    assert.equal(off.value!.foveated, false);
    assert.equal(off.value!.foveaCenter, undefined, '未生效的注视心不得谎报在场');
    // 开关关时脏 foveaCenter 不触发校验（缺省路径零行为变化 —— foveaSize 同律）
    const offDirty = await encodeForVlm(png, { foveated: false, foveaCenter: { x: Number.NaN, y: 0 } });
    assert.equal(offDirty.ok, true);
  });
});

test('P1-a: 非法 foveaCenter 拒绝（仅 foveated 时校验）—— 非有限/缺分量/非对象', async (t) => {
  await withSharp(t, async (s) => {
    const png = await gazeScreenPng(s, 64, 48);
    for (const bad of [
      { x: Number.NaN, y: 0.5 },
      { x: 0.5, y: Number.POSITIVE_INFINITY },
      { x: 0.5 },            // 缺 y 分量
      null,                  // 非对象
    ] as const) {
      const r = await encodeForVlm(png, { foveated: true, foveaCenter: bad as { x: number; y: number } });
      assert.equal(r.ok, false, `非法 foveaCenter ${JSON.stringify(bad) ?? String(bad)} 应拒绝`);
      assert.match(r.error ?? '', /foveaCenter/);
    }
    // 越界分量不拒绝而 clamp（点语义：注视可贴边，不离视网膜）
    const clamped = await encodeForVlmMeta(png, {
      foveated: true, foveaMode: 'inset', foveaCenter: { x: 1.2, y: -0.3 },
    });
    assert.equal(clamped.ok, true);
    assert.deepEqual(clamped.value!.foveaCenter, { x: 1, y: 0 }, '越界注视心 clamp 回 [0,1]');
  });
});

// ─── P1-b：注视窗放置与正反算闭环 ───

test('P1-b: inset 注视心 (0.25,0.5) —— insetRect/insetExtract 数学逐字段精确 + 窗内窗外往返', async (t) => {
  await withSharp(t, async (s) => {
    const png = await gazeScreenPng(s, 1600, 800);
    const enc = await encodeForVlmMeta(png, {
      maxDimension: 1600, foveated: true, foveaMode: 'inset', foveaPeripheryScale: 2,
      foveaCenter: { x: 0.25, y: 0.5 },
    });
    assert.equal(enc.ok, true);
    const m = enc.value!;
    // 手算常量：edge=round(0.5×800)=400；fx=floor(0.25×1600−200)=200、fy=floor(0.5×800−200)=200；
    // ix=floor(0.25×800−200)=0（clamp 前 floor(200−200)=0）、iy=floor(0.5×400−200)=0
    assert.deepEqual(m.insetRect, { x: 0, y: 0, w: 400, h: 400 }, '注视窗贴缩图左上（占位律随注视心）');
    assert.deepEqual(m.insetExtract, { x: 200, y: 200 }, '原生提取原点随注视心（提取律）');
    assert.deepEqual(m.insetNative, { width: 1600, height: 800 });
    assert.deepEqual(m.foveaCenter, { x: 0.25, y: 0.5 });
    assert.equal(m.width, 800);
    assert.equal(m.height, 400);
    // 窗内（源图 [200,600)×[200,600) ⇔ 缩图 (sx−200, sy−200)）：1:1 原生 —— 往返精确 0px
    for (const [sx, sy] of [[200, 200], [300, 300], [450, 250], [599, 599]] as const) {
      const back = mapInsetToOriginal(sx - 200, sy - 200, m);
      assert.deepEqual(back, { x: sx, y: sy }, `窗内往返 (${sx},${sy}) 应精确 0px（得 ${back.x},${back.y}）`);
    }
    // 窗外（缩图投影落在 [0,400)² 之外 —— 放大镜占位区）：2x 等比精确
    for (const [sx, sy] of [[1200, 600], [1000, 700], [1599, 799]] as const) {
      const cx = Math.round((sx * 800) / 1600);
      const cy = Math.round((sy * 400) / 800);
      const back = mapInsetToOriginal(cx, cy, m);
      assert.ok(Math.abs(back.x - sx) <= 1 && Math.abs(back.y - sy) <= 1,
        `窗外往返 (${sx},${sy})→(${cx},${cy})→(${back.x},${back.y}) 超 1px`);
    }
  });
});

test('P1-b: 注视窗贴边 clamp —— (0,0) 与 (1,1) 注视心的提取原点夹在画布内且往返闭环', async (t) => {
  await withSharp(t, async (s) => {
    const png = await gazeScreenPng(s, 1600, 800);
    const common = {
      maxDimension: 1600, foveated: true, foveaMode: 'inset', foveaPeripheryScale: 2,
    } as const;
    const tl = await encodeForVlmMeta(png, { ...common, foveaCenter: { x: 0, y: 0 } });
    assert.equal(tl.ok, true);
    assert.deepEqual(tl.value!.insetExtract, { x: 0, y: 0 }, '(0,0)：提取原点夹到左上');
    assert.deepEqual(tl.value!.insetRect, { x: 0, y: 0, w: 400, h: 400 });
    let back = mapInsetToOriginal(100, 100, tl.value!); // 窗内 (100,100) ⇔ 源 (100,100)
    assert.deepEqual(back, { x: 100, y: 100 });
    const br = await encodeForVlmMeta(png, { ...common, foveaCenter: { x: 1, y: 1 } });
    assert.equal(br.ok, true);
    // (1,1)：fx=floor(1600−200)=1400 夹到 w−edge=1200；fy 夹到 400；ix 夹到 400；iy 夹到 0
    assert.deepEqual(br.value!.insetExtract, { x: 1200, y: 400 }, '(1,1)：提取原点夹到右下');
    assert.deepEqual(br.value!.insetRect, { x: 400, y: 0, w: 400, h: 400 });
    back = mapInsetToOriginal(400 + (1400 - 1200), 0 + (600 - 400), br.value!);
    assert.deepEqual(back, { x: 1400, y: 600 }, '贴右下窗内点往返精确');
  });
});

test('P1-b: 全复合 —— crop+resize+inset+注视心：窗内 1:1 原生精确 / 全链往返 ≤2px', async (t) => {
  await withSharp(t, async (s) => {
    // 3200x1600 源，region (400,200)-(2800,1400)=2400x1200 → resize 1568x784 →
    // inset scale2 缩图 784x392；注视心 (0.5,0.4)（源图归一）→ 裁剪窗归一
    // cu=0.5、cv=(0.4×1600−200)/1200=11/30
    const png = await gazeScreenPng(s, 3200, 1600);
    const enc = await encodeForVlmMeta(png, {
      region: { x0: 400, y0: 200, x1: 2800, y1: 1400 },
      maxDimension: 1568, foveated: true, foveaMode: 'inset', foveaPeripheryScale: 2,
      foveaCenter: { x: 0.5, y: 0.4 },
    });
    assert.equal(enc.ok, true);
    const m = enc.value!;
    assert.equal(m.width, 784);
    assert.equal(m.height, 392);
    assert.deepEqual(m.cropRect, { left: 400, top: 200, width: 2400, height: 1200 });
    assert.deepEqual(m.insetNative, { width: 1568, height: 784 });
    // 手算：edge=round(0.5×784)=392；fx=floor(0.5×1568−196)=588；fy=floor(11/30×784−196)=91；
    // ix=floor(0.5×784−196)=196；iy=floor(11/30×392−196)=−53 ⇒ clamp 0
    assert.deepEqual(m.insetRect, { x: 196, y: 0, w: 392, h: 392 });
    assert.deepEqual(m.insetExtract, { x: 588, y: 91 });
    // E→源图 的精确前向（与 mapInsetToOriginal 同构造律、独立实现）：
    // midW/midH = 裁剪窗，E→crop 等比 round，再 +cropRect 偏移，clamp 图内
    const crop = m.cropRect!;
    const fwd = (ex: number, ey: number): { x: number; y: number } => ({
      x: Math.min(3200, Math.max(0, Math.round((ex * crop.width) / m.insetNative!.width) + crop.left)),
      y: Math.min(1600, Math.max(0, Math.round((ey * crop.height) / m.insetNative!.height) + crop.top)),
    });
    const fx = m.insetExtract!.x, fy = m.insetExtract!.y;
    const rx = m.insetRect!.x, ry = m.insetRect!.y;
    // 窗内 E 网格点 → 缩图 (rx+ex−fx, ry+ey−fy) → 反算 === 前向（1:1 原生段精确）
    for (const ex of [588, 700, 850, 979]) {
      for (const ey of [91, 200, 350, 482]) {
        const back = mapInsetToOriginal(rx + (ex - fx), ry + (ey - fy), m);
        const expect = fwd(ex, ey);
        assert.deepEqual(back, expect, `窗内 E(${ex},${ey}) 反算应精确等于前向`);
      }
    }
    // 全链往返（源图点 → 裁剪窗 → E(round) → 若落窗内 → 缩图 → 反算回源图）：
    // 两级缩放取整 ⇒ ≤2px（2400→1568 非 2 整除，round 残差经 1.53 倍放大）
    const scaleE = m.insetNative!.width / crop.width; // 1568/2400
    for (const [lx, ly] of [[1000, 500], [1250, 300], [900, 700], [1490, 200]] as const) {
      const ex = Math.round(lx * scaleE);
      const ey = Math.round((ly * m.insetNative!.height) / crop.height);
      if (ex < fx || ex >= fx + m.insetRect!.w || ey < fy || ey >= fy + m.insetRect!.h) continue; // 仅窗内样本
      const back = mapInsetToOriginal(rx + (ex - fx), ry + (ey - fy), m);
      assert.ok(
        Math.abs(back.x - (lx + crop.left)) <= 2 && Math.abs(back.y - (ly + crop.top)) <= 2,
        `全链往返 源(${lx + crop.left},${ly + crop.top})→E(${ex},${ey})→(${back.x},${back.y}) 超 2px`,
      );
    }
    // 窗外缩图点：按缩图实际比值反算（ratio 精确 2.0 —— E=2×px 后等比 round）
    for (const [px, py] of [[10, 10], [700, 300], [780, 390]] as const) {
      const back = mapInsetToOriginal(px, py, m);
      const expect = fwd(px * 2, py * 2);
      assert.deepEqual(back, expect, `窗外缩图 (${px},${py}) 应按实际比值反算`);
    }
  });
});

test('P1-b: blur 注视窗随注视心 —— 注视点锐利、旧几何中心变模糊（棋盘取样）', async (t) => {
  await withSharp(t, async (s) => {
    const png = await checkerPng(s, 120, 80);
    const hom = await encodeForVlm(png);
    // 注视心 (0.25,0.5) ⇒ 窗心 (30,40)、edge=40 ⇒ 窗 [10,50)×[20,60)
    const fov = await encodeForVlmMeta(png, {
      foveated: true, foveaPeripheryScale: 4, foveaCenter: { x: 0.25, y: 0.5 },
    });
    assert.equal(hom.ok && fov.ok, true);
    assert.equal(fov.value!.strategy, 'as-is+fovea');
    const homImg = await decodeRgb(s, Buffer.from(hom.value!.base64, 'base64'));
    const fovImg = await decodeRgb(s, Buffer.from(fov.value!.base64, 'base64'));
    // 注视点 (30,40)：窗内原生 ⇒ 与均质几乎全同（JPEG 块级容差）
    const g1 = pixelAt(homImg, 30, 40), g2 = pixelAt(fovImg, 30, 40);
    for (let ch = 0; ch < 3; ch++) {
      assert.ok(Math.abs(g1[ch]! - g2[ch]!) <= 12, `注视点 (30,40) 通道${ch}: 均质${g1[ch]} vs 凹化${g2[ch]}`);
    }
    // 旧几何中心 (60,40) 与角落：现均在窗外 ⇒ 棋盘糊向中灰，大幅变化
    for (const [px, py] of [[60, 40], [6, 6], [113, 73]] as const) {
      const a = pixelAt(homImg, px, py), b = pixelAt(fovImg, px, py);
      const delta = Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!), Math.abs(a[2]! - b[2]!));
      assert.ok(delta >= 60, `窗外 (${px},${py}) 应显著模糊：均质${a} vs 凹化${b}（Δ=${delta}）`);
    }
  });
});

test('P1-b: mapInsetToOriginal 消费 insetExtract；脏值诚实回退居中提取律', () => {
  // 手构 meta（inset 字段全在场）—— 注视窗提取原点 (588,91)（偏置窗）
  const base = {
    base64: '', mime: 'image/jpeg', width: 800, height: 400, bytes: 1, strategy: 'as-is+inset',
    sourceWidth: 1600, sourceHeight: 800, foveated: true,
    cropRect: null, foveaMode: 'inset' as const,
    insetRect: { x: 200, y: 0, w: 400, h: 400 }, insetScale: 2,
    insetNative: { width: 1600, height: 800 },
    insetExtract: { x: 588, y: 91 },
  };
  // 缩图 (250,100) ∈ 窗 ⇒ E=(588+50, 91+100)=(638,191) ⇒ 源（无裁剪恒等）=(638,191)
  assert.deepEqual(mapInsetToOriginal(250, 100, base), { x: 638, y: 191 }, '随行 insetExtract 被消费');
  // 剥夺 insetExtract ⇒ 居中提取律 fx=floor((1600−400)/2)=600、fy=floor((800−400)/2)=200
  // ⇒ E=(650,300) —— x/y 双轴都回居中律（与偏置窗 (588,91) 双双不同，消费证据更强）
  const { insetExtract: _omit, ...noExtract } = base;
  assert.deepEqual(mapInsetToOriginal(250, 100, noExtract), { x: 650, y: 300 }, '缺席 ⇒ 居中律回退（Γ2 老元信息零回归）');
  // 脏值（负原点/越出原生画布/非有限）⇒ 同一回退
  for (const dirty of [
    { x: -5, y: 91 },
    { x: 1300, y: 91 },        // 1300+400 > 1600
    { x: Number.NaN, y: 91 },
    { x: 588, y: Number.POSITIVE_INFINITY },
  ] as const) {
    const meta = { ...base, insetExtract: dirty };
    assert.deepEqual(mapInsetToOriginal(250, 100, meta), { x: 650, y: 300 },
      `脏 insetExtract ${JSON.stringify(dirty)} 应回退居中律`);
  }
});

test('P1-b: 缺省路径反算回归 —— 无 foveaCenter 的 inset 编码，Γ2 已知样点原值', async (t) => {
  await withSharp(t, async (s) => {
    const png = await gazeScreenPng(s, 1600, 800);
    const enc = await encodeForVlmMeta(png, {
      maxDimension: 1600, foveated: true, foveaMode: 'inset', foveaPeripheryScale: 2,
    });
    assert.equal(enc.ok, true);
    const m = enc.value!;
    // Γ2-2 样点：窗内 (800,400) ⇔ 缩图 (400,200) 往返精确；窗外 (10,10) ⇔ (5,5)
    assert.deepEqual(mapInsetToOriginal(400, 200, m), { x: 800, y: 400 });
    assert.deepEqual(mapInsetToOriginal(5, 5, m), { x: 10, y: 10 });
  });
});

test('P1-b: sharp 缺席 ⇒ ok:false 诚实报错绝不抛（注视心在场同律）', async () => {
  _overrideSharpResolver_forTest(async () => {
    throw new Error('sharp unavailable (W1-9 simulated absence)');
  });
  try {
    const r = await encodeForVlmMeta(Buffer.from('placeholder', 'utf8'), {
      foveated: true, foveaMode: 'inset', foveaCenter: { x: 0.3, y: 0.7 },
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /sharp unavailable/);
    assert.equal(r.value?.foveaCenter, undefined, '缺席时不得谎报注视心');
  } finally {
    _overrideSharpResolver_forTest(null);
  }
});

// ─── P1-c：gazeRouter 三路加权 ───

test('P1-c: 三路缺省先验排序 grounding(0.9) > diff(0.6) > cursor(0.3)；乱序输入确定性', () => {
  const d = gazeRouter([
    { route: 'cursor', center: { x: 0.8, y: 0.8 } },
    { route: 'diff', center: { x: 0.6, y: 0.6 } },
    { route: 'grounding', center: { x: 0.2, y: 0.2 } },
  ]);
  assert.equal(d.route, 'grounding');
  assert.equal(d.score, 0.9);
  assert.deepEqual(d.center, { x: 0.2, y: 0.2 });
  assert.equal(d.fellBack, false);
  assert.deepEqual(d.ranked.map(r => r.route), ['grounding', 'diff', 'cursor'], '拆票按分数降序');
  // 纯函数性：同输入两次调用判决一致
  assert.deepEqual(gazeRouter([
    { route: 'cursor', center: { x: 0.8, y: 0.8 } },
    { route: 'diff', center: { x: 0.6, y: 0.6 } },
    { route: 'grounding', center: { x: 0.2, y: 0.2 } },
  ]), d);
});

test('P1-c: taskRelevance 加权翻转 —— 弱锚点让位强相关候选', () => {
  // grounding rel=0.2 ⇒ 0.18 < cursor 0.3 < diff rel=0.4 ⇒ 0.24 —— cursor 胜
  const d = gazeRouter([
    { route: 'grounding', center: { x: 0.2, y: 0.2 }, taskRelevance: 0.2 },
    { route: 'diff', center: { x: 0.6, y: 0.6 }, taskRelevance: 0.4 },
    { route: 'cursor', center: { x: 0.8, y: 0.8 } },
  ]);
  assert.equal(d.route, 'cursor', '任务相关度压过路由先验');
  assert.equal(d.score, 0.3);
  assert.deepEqual(d.ranked.map(r => r.route), ['cursor', 'diff', 'grounding']);
  // 越界相关度 clamp：1.5 ⇒ 1（不放大）
  const c = gazeRouter([{ route: 'cursor', center: { x: 0.5, y: 0.5 }, taskRelevance: 1.5 }]);
  assert.equal(c.score, 0.3);
});

test('P1-c: 同分裁决 —— 先验高者胜（grounding rel 2/3 = diff rel 1 = 0.6）', () => {
  const d = gazeRouter([
    { route: 'diff', center: { x: 0.6, y: 0.6 } },
    { route: 'grounding', center: { x: 0.2, y: 0.2 }, taskRelevance: 2 / 3 },
  ]);
  assert.equal(d.route, 'grounding', '0.9×(2/3)=0.6 与 0.6×1=0.6 平 —— 先验裁决');
  assert.equal(d.score, 0.6);
});

test('P1-c: 非法候选跳过（未知路/脏心/非对象）；全缺席 ⇒ 几何中心回退', () => {
  const d = gazeRouter([
    { route: 'gps' as any, center: { x: 0.1, y: 0.1 } },      // 未知路
    { route: 'diff', center: { x: Number.NaN, y: 0.5 } },      // 脏心
    { route: 'diff' },                                          // 缺心
    null,                                                       // 非对象
    5 as any,
    { route: 'grounding', center: { x: 0.1, y: 0.1 }, taskRelevance: Number.NaN }, // rel 脏 ⇒ 缺省 1
  ]);
  assert.equal(d.route, 'grounding', '唯一合格候选胜出（rel 脏按缺省 1 记）');
  assert.equal(d.score, 0.9);
  // 全脏 / 空数组 / 非数组 ⇒ 几何中心
  for (const junk of [[], [{ route: 'x' as any, center: { x: 0, y: 0 } }], null, undefined, 'x' as any]) {
    const f = gazeRouter(junk);
    assert.deepEqual(f.center, { x: 0.5, y: 0.5 }, `全缺席 ${JSON.stringify(junk ?? null)} ⇒ 几何中心`);
    assert.equal(f.route, 'center');
    assert.equal(f.fellBack, true);
    assert.equal(f.score, 0);
    assert.deepEqual(f.ranked, []);
  }
  // 越界心 clamp 回 [0,1]
  const c = gazeRouter([{ route: 'cursor', center: { x: 1.4, y: -0.2 } }]);
  assert.deepEqual(c.center, { x: 1, y: 0 });
});

// ─── C4-a：requote 分档边界 ───

test('C4-a: 配额充裕 ⇒ 原档（quality/maxDimension 原值 + token 反馈尺）', () => {
  const b = new VlmBudget(); // 缺省 200 张 / 512MB
  const r = b.requote(50, { debounceN: 1 });
  assert.equal(r.tier, 'original');
  assert.equal(r.rawTier, 'original');
  assert.equal(r.quality, 80);
  assert.equal(r.maxDimension, 1568);
  assert.equal(r.estTokensPerImage, estimateVlmTokens(1568, Math.round(1568 * 9 / 16)));
  assert.equal(r.estTokensPerImage, 1844); // ceil(1568×882/750)
  assert.equal(r.perStepBytes, (512 * 1024 * 1024) / 50);
  assert.equal(r.perStepImages, 200 / 50);
  assert.equal(r.switched, false);
  assert.match(r.reason, /配额充裕/);
});

test('C4-a: 分档边界（含等号）—— commit 历史均值反馈下的 original/economy/deep', () => {
  const b = new VlmBudget({ maxImagesPerTask: 1000, maxBytesPerTask: 2_000_000 });
  for (let i = 0; i < 10; i++) b.commit({ bytes: 100_000 }); // avgBytes=100k，余 1MB
  // 边界含等号：steps=10 ⇒ perStep=100000 = estO(原档) ⇒ original
  const o = b.requote(10, { debounceN: 1 });
  assert.equal(o.tier, 'original');
  assert.equal(o.rawTier, 'original');
  // steps=12 ⇒ perStep≈83333 < 100000 而 ≥ estE(100000×0.7=70000) ⇒ economy（q60/d 不变）
  const e = b.requote(12, { debounceN: 1 });
  assert.equal(e.rawTier, 'economy');
  assert.equal(e.tier, 'economy');
  assert.equal(e.quality, 60);
  assert.equal(e.maxDimension, 1568);
  assert.equal(e.estTokensPerImage, 1844, 'economy 只省字节不省 token');
  assert.equal(e.switched, true, 'debounceN=1 ⇒ 立即切换');
  // steps=15 ⇒ perStep≈66667 < 70000 ⇒ deep（q60 + d1024；token 反馈 787）
  const d = b.requote(15, { debounceN: 1 });
  assert.equal(d.rawTier, 'deep');
  assert.equal(d.tier, 'deep');
  assert.equal(d.quality, 60);
  assert.equal(d.maxDimension, 1024);
  assert.equal(d.estTokensPerImage, 787); // ceil(1024×576/750)
  assert.match(d.reason, /字节告急/);
  // steps=40 ⇒ perStep=25000 < estDeep(≈29854) ⇒ deep + 见底注记
  const x = b.requote(40, { debounceN: 1 });
  assert.equal(x.tier, 'deep');
  assert.match(x.reason, /撑不满/);
  // 张数配额不足以覆盖步数 ⇒ 只入 reason（分档不增张数）
  const b2 = new VlmBudget({ maxImagesPerTask: 5, maxBytesPerTask: 2_000_000 });
  const n = b2.requote(10, { debounceN: 1, bytesPerImage: 100_000 });
  assert.equal(n.tier, 'original', '字节充裕仍原档');
  assert.match(n.reason, /张数配额 5 张不足以覆盖 10 步/);
});

test('C4-a: 两级钳制只降不升 —— 调用方低档不被建议拉回；显式 bytesPerImage 反馈', () => {
  const b = new VlmBudget({ maxBytesPerTask: 1_000_000 });
  // 现档 q50/d800：economy=min(50,60)=50、deep=min(800,1024)=800 —— 全程不升档
  const r = b.requote(20, { debounceN: 1, bytesPerImage: 100_000, current: { quality: 50, maxDimension: 800 } });
  assert.equal(r.tier, 'deep');
  assert.equal(r.quality, 50, 'quality 不升回 60');
  assert.equal(r.maxDimension, 800, 'maxDim 不升回 1024');
  // 原档回声 = 调用方现档（充裕时）
  const rich = new VlmBudget();
  const r2 = rich.requote(100, { debounceN: 1, current: { quality: 95, maxDimension: 2000 } });
  assert.equal(r2.tier, 'original');
  assert.equal(r2.quality, 95);
  assert.equal(r2.maxDimension, 2000);
  // 自定义高档基线下的 economy/deep 钳制（95→60、2000→1024）
  const tight = new VlmBudget({ maxBytesPerTask: 600_000 });
  const r3 = tight.requote(20, { debounceN: 1, bytesPerImage: 100_000, current: { quality: 95, maxDimension: 2000 } });
  // estO=100000×1×1；perStep=30000 < estE(100000×0.475=47500) ⇒ deep
  assert.equal(r3.tier, 'deep');
  assert.equal(r3.quality, 60);
  assert.equal(r3.maxDimension, 1024);
});

test('C4-a: 脏 remainingSteps / 脏 opts 防御 —— 绝不抛、回声缺省、用量只读', () => {
  const b = new VlmBudget({ maxImagesPerTask: 10, maxBytesPerTask: 1_000_000 });
  b.commit({ bytes: 12345 });
  const before = b.summary();
  for (const junk of [Number.NaN, -5, 0, Number.POSITIVE_INFINITY]) {
    const r = b.requote(junk as number);
    assert.equal(r.tier, 'original', `remainingSteps=${String(junk)} ⇒ 维持生效档`);
    assert.equal(r.rawTier, 'original');
    assert.equal(r.perStepBytes, Number.POSITIVE_INFINITY, '步数不可用 ⇒ 无界额度');
    assert.match(r.reason, /不可用/);
  }
  // 脏 opts：current 脏值回声 codec 缺省（80/1568）；debounceN 脏回声 3
  const r = b.requote(50, { current: { quality: Number.NaN, maxDimension: -3 }, debounceN: -2 });
  assert.equal(r.quality, 80);
  assert.equal(r.maxDimension, 1568);
  const b2 = new VlmBudget({ maxBytesPerTask: 2_000_000 });
  for (let i = 0; i < 10; i++) b2.commit({ bytes: 100_000 });
  const r2a = b2.requote(12); // raw=economy，防抖 N=3（-2 ⇒ 缺省）
  assert.equal(r2a.tier, 'original');
  assert.equal(r2a.consecutiveAgree, 1);
  const r2b = b2.requote(12);
  assert.equal(r2b.tier, 'original');
  assert.equal(r2b.consecutiveAgree, 2, 'debounceN 脏值回声 3 —— 第 2 次仍未切换');
  // requote 对用量账面只读（防抖状态除外）
  assert.deepEqual(b.summary(), before);
  assert.equal(b.check({ bytes: 1 }).usedBytes, before.usedBytes);
});

// ─── C4-b：防抖行为 ───

test('C4-b: 连续 N(缺省 3)次建议一致才切换；异见清零在途；reset 归档', () => {
  const b = new VlmBudget({ maxImagesPerTask: 1000, maxBytesPerTask: 2_000_000 });
  for (let i = 0; i < 10; i++) b.commit({ bytes: 100_000 });
  // 第 1、2 次：raw=economy 但生效档仍 original（防抖在途）
  const r1 = b.requote(12);
  assert.equal(r1.rawTier, 'economy');
  assert.equal(r1.tier, 'original');
  assert.equal(r1.switched, false);
  assert.equal(r1.consecutiveAgree, 1);
  assert.match(r1.reason, /防抖在途（连续一致 1\/3/);
  const r2 = b.requote(12);
  assert.equal(r2.tier, 'original');
  assert.equal(r2.consecutiveAgree, 2);
  // 第 3 次：连续一致达 3 ⇒ 切换事件沿
  const r3 = b.requote(12);
  assert.equal(r3.tier, 'economy');
  assert.equal(r3.switched, true);
  assert.equal(r3.consecutiveAgree, 0, '切换后清零');
  assert.ok(!r3.reason.includes('防抖在途'), '切换帧不再挂防抖注记');
  // raw 回到生效档 ⇒ 无在途切换
  const r4 = b.requote(12);
  assert.equal(r4.tier, 'economy');
  assert.equal(r4.switched, false);
  assert.equal(r4.consecutiveAgree, 0);
  // 异见清零：deep 一次（在途 1）→ economy 一次（清零）→ deep×3 ⇒ 第 3 次切换
  b.requote(40); // raw=deep，在途 1
  const mid = b.requote(12); // raw=economy == 生效档 ⇒ 清零 deep 在途
  assert.equal(mid.consecutiveAgree, 0);
  const d1 = b.requote(40);
  assert.equal(d1.consecutiveAgree, 1);
  const d2 = b.requote(40);
  assert.equal(d2.consecutiveAgree, 2);
  assert.equal(d2.tier, 'economy', '第 2 次 deep 仍未切换');
  const d3 = b.requote(40);
  assert.equal(d3.tier, 'deep');
  assert.equal(d3.switched, true);
  // reset：生效档归 original，防抖清零。注：reset 也清记账历史 ⇒ 单帧字节估计回
  // 经验缺省 300KB ⇒ 原始建议更紧（deep）—— 反馈面诚实重置的旁证
  b.reset();
  const after = b.requote(12);
  assert.equal(after.tier, 'original', 'reset 后生效档回 original（新任务不继承旧紧张）');
  assert.equal(after.rawTier, 'deep');
  assert.equal(after.consecutiveAgree, 1);
});

// ─── 锚点缓存与注入面（contextManager） ───

test('锚点: record/get 往返 + 防御规整（倒置交换/压扁扩 1px/垃圾拒收）', () => {
  contextManager.clearTaskAnchor();
  const ok = contextManager.recordTaskAnchor({
    bbox: { x0: 100, y0: 200, x1: 300, y1: 260 },
    viewport: { width: 1920, height: 1080 },
    screenshotId: 42,
  });
  assert.equal(ok, true);
  const a = contextManager.getTaskAnchor()!;
  assert.deepEqual(a.bbox, { x0: 100, y0: 200, x1: 300, y1: 260 });
  assert.deepEqual(a.center, { x: 200, y: 230 });
  assert.ok(Math.abs(a.normalized!.x - 200 / 1920) < 1e-9);
  assert.ok(Math.abs(a.normalized!.y - 230 / 1080) < 1e-9);
  assert.equal(a.route, 'grounding');
  assert.equal(a.screenshotId, 42);
  assert.ok(Number.isFinite(a.capturedAt));
  // 倒置交换
  assert.equal(contextManager.recordTaskAnchor({ bbox: { x0: 300, y0: 260, x1: 100, y1: 200 } }), true);
  assert.deepEqual(contextManager.getTaskAnchor()!.bbox, { x0: 100, y0: 200, x1: 300, y1: 260 });
  // 压扁盒扩 1px
  assert.equal(contextManager.recordTaskAnchor({ bbox: { x0: 5, y0: 5, x1: 5, y1: 9 } }), true);
  assert.deepEqual(contextManager.getTaskAnchor()!.bbox, { x0: 5, y0: 5, x1: 6, y1: 9 });
  // 垃圾拒收（不抛、不改既有锚点）
  const keep = contextManager.getTaskAnchor();
  assert.equal(contextManager.recordTaskAnchor(null as any), false);
  assert.equal(contextManager.recordTaskAnchor({} as any), false);
  assert.equal(contextManager.recordTaskAnchor({ bbox: { x0: Number.NaN, y0: 0, x1: 1, y1: 1 } }), false);
  assert.deepEqual(contextManager.getTaskAnchor(), keep, '拒收不动既有锚点');
  // 脏 viewport ⇒ normalized 诚实缺席；脏 taskRelevance ⇒ 缺省缺席；越界 ⇒ clamp
  assert.equal(contextManager.recordTaskAnchor({
    bbox: { x0: 0, y0: 0, x1: 100, y1: 100 },
    viewport: { width: 0, height: 100 },
    taskRelevance: 1.5,
  }), true);
  const a2 = contextManager.getTaskAnchor()!;
  assert.equal(a2.normalized, undefined);
  assert.equal(a2.taskRelevance, 1);
});

test('锚点: suggestFoveaCenter 三路组合与 gazeRouter 判决一致；全缺席回退', () => {
  contextManager.clearTaskAnchor();
  // 无锚点无附加 ⇒ 几何中心
  let d = contextManager.suggestFoveaCenter();
  assert.deepEqual(d.center, { x: 0.5, y: 0.5 });
  assert.equal(d.fellBack, true);
  // 锚点（grounding 路，默认相关度）压过 diff 质心
  contextManager.recordTaskAnchor({
    bbox: { x0: 100, y0: 200, x1: 300, y1: 260 },
    viewport: { width: 1920, height: 1080 },
  });
  d = contextManager.suggestFoveaCenter({ diffCentroid: { x: 0.9, y: 0.9 } });
  assert.equal(d.route, 'grounding');
  assert.ok(Math.abs(d.center.x - 200 / 1920) < 1e-9);
  // 锚点相关度衰减 ⇒ diff 胜
  contextManager.recordTaskAnchor({
    bbox: { x0: 100, y0: 200, x1: 300, y1: 260 },
    viewport: { width: 1920, height: 1080 },
    taskRelevance: 0.3,
  });
  d = contextManager.suggestFoveaCenter({ diffCentroid: { x: 0.9, y: 0.9 } });
  assert.equal(d.route, 'diff', '0.9×0.3=0.27 < 0.6 ⇒ 差分质心胜');
  // 光标（像素方言 + viewport 归一）；无 viewport ⇒ 该路诚实跳过
  contextManager.recordTaskAnchor({
    bbox: { x0: 100, y0: 200, x1: 300, y1: 260 },
    viewport: { width: 1920, height: 1080 },
  });
  d = contextManager.suggestFoveaCenter({ cursor: { x: 960, y: 540 }, viewport: { width: 1920, height: 1080 } });
  assert.equal(d.route, 'grounding', 'grounding 0.9 > cursor 0.3');
  assert.deepEqual(d.ranked.map(r => r.route), ['grounding', 'cursor']);
  d = contextManager.suggestFoveaCenter({ cursor: { x: 960, y: 540 } }); // 缺 viewport
  assert.deepEqual(d.ranked.map(r => r.route), ['grounding'], '无法归一的光标路被跳过');
  // 锚点无 viewport（不可归一）⇒ 少一路；无其他候选 ⇒ 几何中心
  contextManager.recordTaskAnchor({ bbox: { x0: 0, y0: 0, x1: 100, y1: 100 } });
  d = contextManager.suggestFoveaCenter();
  assert.equal(d.fellBack, true);
  // 锚点带 diff 路注记 ⇒ 按差分路入路由（自定义串按 grounding 语义收敛）
  contextManager.recordTaskAnchor({
    bbox: { x0: 0, y0: 0, x1: 960, y1: 540 },
    viewport: { width: 1920, height: 1080 },
    route: 'diff',
  });
  d = contextManager.suggestFoveaCenter();
  assert.equal(d.route, 'diff');
  // 清锚点 ⇒ 回退
  contextManager.clearTaskAnchor();
  d = contextManager.suggestFoveaCenter({ diffCentroid: { x: 0.2, y: 0.3 } });
  assert.equal(d.route, 'diff');
  assert.equal(contextManager.suggestFoveaCenter().fellBack, true);
});

test('锚点: reset() 清空锚点（新任务不继承旧注视）', () => {
  contextManager.clearTaskAnchor();
  contextManager.recordTaskAnchor({ bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, viewport: { width: 100, height: 100 } });
  assert.ok(contextManager.getTaskAnchor() !== null);
  contextManager.reset();
  assert.equal(contextManager.getTaskAnchor(), null);
  assert.equal(contextManager.suggestFoveaCenter().fellBack, true);
});

test('端到端: 锚点 → suggestFoveaCenter → encodeForVlm.foveaCenter → 注视窗落在锚点处', async (t) => {
  await withSharp(t, async (s) => {
    contextManager.clearTaskAnchor();
    // 目标块画在 (300,300)-(500,500)（1600×800 画布）⇒ 锚点中心 (400,400)
    const png = await gazeScreenPng(s, 1600, 800, 200, 200, 300, 300);
    const recorded = contextManager.recordTaskAnchor({
      bbox: { x0: 300, y0: 300, x1: 500, y1: 500 },
      viewport: { width: 1600, height: 800 },
    });
    assert.equal(recorded, true);
    const decision = contextManager.suggestFoveaCenter();
    assert.equal(decision.route, 'grounding');
    assert.ok(Math.abs(decision.center.x - 0.25) < 1e-9);
    assert.ok(Math.abs(decision.center.y - 0.5) < 1e-9);
    // 注视心直供编码（同方言零换算）⇒ P1-b 已证的 (0.25,0.5) 数学：
    // insetRect {0,0,400,400}、insetExtract {200,200} —— 注视窗罩住目标块
    const enc = await encodeForVlmMeta(png, {
      maxDimension: 1600, foveated: true, foveaMode: 'inset', foveaPeripheryScale: 2,
      foveaCenter: decision.center,
    });
    assert.equal(enc.ok, true);
    const m = enc.value!;
    assert.deepEqual(m.foveaCenter, { x: 0.25, y: 0.5 });
    assert.deepEqual(m.insetExtract, { x: 200, y: 200 }, '原生提取窗 [200,600)² 罩住目标块 (300,300)-(500,500)');
    assert.deepEqual(m.insetRect, { x: 0, y: 0, w: 400, h: 400 });
    // 目标块中心 (400,400) 源图系 ⇔ 缩图 (200,200)，反算精确回锚点中心
    assert.deepEqual(mapInsetToOriginal(200, 200, m), { x: 400, y: 400 });
    contextManager.clearTaskAnchor();
  });
});
