// test/w3incremental.test.ts
// W3-3（P2+C3 脏矩形增量编码 · 视频 P 帧式感知）执法册。
//   W3-1 三系坐标：源图/编码/归一化往返 —— 归一化路径恒等（0px）、编码路径
//      逐边 ≤1px（两段 round 残差上界）；脏输入防御（绝不抛）；锚点文本三系并列。
//   W3-2 补丁几何：regionsToPatchRects 合并/外扩/最小边/钳位/上限纯函数。
//   W3-3 账本分诊（sharp 合成真图）：冷启动关键帧 / 微变产补丁（覆盖律）/
//      大变产关键帧 / 滚动产向量+条带（dyPx 与条带位置）/ 累计超阈重置 /
//      无变化静默。
//   W3-4 端口注入（离线确定性）：分析端口抛错降级整帧（绝不抛）/ TTL 到期 /
//      surpriseBits≥24 / forceKeyframe 逃生口 / 哈希快路径 / 分辨率突变。
//   W3-5 投递协议（假附件服务）：主帧+补丁小图+锚点文本 / 滚动条带投递 /
//      forceFullFrame 逃生口 / 补丁编码失败回退整帧 / 端口缺席返回 null。
//   W3-6 缺省兼容：开关默认关闭；开与关两个状态下 computeDiffRegions /
//      encodeForVlm 输出逐字节一致（增量是纯增量 —— 现有路径零触碰）。
// 铁律：全离线确定性 —— sharp 现铸真图 + 假附件桩 + 注册表 finally 复位，
// 零网络零 fixture 文件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSharp, type SharpLike } from '../src/_legacyDeps.ts';
import { kernelRegistry, resetKernelRuntime } from '../src/kernel/registry.ts';
import type { LedgerVerdict, LedgerAnalysis, DiffRegion } from '../src/visualDiff.ts';

// 契约模块经动态 import 加载（Ω-2 铁律：不在测试顶层静态绑定被测模块）
const {
  patchRectToNormalized, normalizedToPatchRect,
  patchRectToEncoded, encodedPatchRectToSource,
  patchAnchorText, encodePatchForVlm, encodeForVlm,
  cleanPatchRect,
  _overrideSharpResolver_forTest,
} = await import('../src/vlm/codec.ts');
const {
  ScreenStateLedger, regionsToPatchRects, incrementalEncodingEnabled,
  computeDiffRegions,
} = await import('../src/visualDiff.ts');
const {
  setImageDeliveryStore, deliverIncremental, saveScreenshotAttachment,
  imageDeliveryAvailable,
} = await import('../src/imageDelivery.ts');

// ─── 测试脚手架（与 epochGamma2.inset.test.ts 同构） ───

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

/**
 * 合成帧：灰底 + 叠加实心块（raw 像素直铸 —— 无需解码中间态）。
 * blocks 的 v 与 baseV 的三通道差 > PIXEL_THRESHOLD(70) 即为可检变化。
 */
async function framePng(
  s: SharpLike, w: number, h: number, baseV: number,
  blocks: Array<{ x: number; y: number; w: number; h: number; v: number }>,
): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  raw.fill(baseV, 0, w * h * 3);
  for (const b of blocks) {
    for (let y = b.y; y < Math.min(h, b.y + b.h); y++) {
      for (let x = b.x; x < Math.min(w, b.x + b.w); x++) {
        const i = (y * w + x) * 3;
        raw[i] = b.v; raw[i + 1] = b.v; raw[i + 2] = b.v;
      }
    }
  }
  return s(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/** 合成滚动帧：逐行亮度纹理 v(y)（水平均匀 —— 行移估计的理想输入） */
async function rowTexturePng(
  s: SharpLike, w: number, h: number,
  vAt: (y: number) => number,
): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const v = vAt(y);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      raw[i] = v; raw[i + 1] = v; raw[i + 2] = v;
    }
  }
  return s(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

// ─── W3-1 三系坐标往返（纯函数） ───

test('W3-1: 源图→归一化→源图 恒等往返（含边缘矩形）', () => {
  const W = 1920, H = 1080;
  const rects = [
    { x: 0, y: 0, w: 1920, h: 1080 },
    { x: 0, y: 0, w: 1, h: 1 },
    { x: 1919, y: 1079, w: 1, h: 1 },
    { x: 320, y: 108, w: 256, h: 96 },
    { x: 960, y: 540, w: 960, h: 540 },
    { x: 1, y: 1077, w: 1918, h: 3 },
  ];
  for (const r of rects) {
    const n = patchRectToNormalized(r, W, H);
    const back = normalizedToPatchRect(n, W, H);
    assert.deepEqual(back, r, `round-trip must be identity for ${JSON.stringify(r)} (got ${JSON.stringify(back)})`);
    assert.ok(n.x0 >= 0 && n.x1 <= 1 && n.y0 >= 0 && n.y1 <= 1, 'normalized in [0,1]');
    assert.ok(n.x1 > n.x0 && n.y1 > n.y0, 'normalized half-open ordering');
  }
});

test('W3-1: 源图→编码→源图 逐边 ≤1px；同尺寸编码恒等', () => {
  const W = 1920, H = 1080;
  const cases: Array<{ eW: number; eH: number }> = [
    { eW: 1920, eH: 1080 },  // k=1：恒等
    { eW: 1568, eH: 882 },   // VLM 带宽缩放（非整比）
    { eW: 1024, eH: 576 },
    { eW: 640, eH: 360 },    // 深度缩放
  ];
  const rects = [
    { x: 0, y: 0, w: 1920, h: 1080 },
    { x: 7, y: 13, w: 101, h: 57 },
    { x: 1811, y: 1022, w: 109, h: 58 },
    { x: 555, y: 333, w: 1111, h: 222 },
  ];
  for (const { eW, eH } of cases) {
    for (const r of rects) {
      const e = patchRectToEncoded(r, W, H, eW, eH);
      assert.ok(e.w >= 1 && e.h >= 1, 'encoded rect never degenerates');
      const back = encodedPatchRectToSource(e, eW, eH, W, H);
      if (eW === W && eH === H) {
        assert.deepEqual(back, r, 'k=1 round-trip must be identity');
      } else {
        assert.ok(Math.abs(back.x - r.x) <= 1, `x edge ≤1px (got ${back.x} vs ${r.x})`);
        assert.ok(Math.abs(back.y - r.y) <= 1, `y edge ≤1px`);
        assert.ok(Math.abs((back.x + back.w) - (r.x + r.w)) <= 1, `x1 edge ≤1px`);
        assert.ok(Math.abs((back.y + back.h) - (r.y + r.h)) <= 1, `y1 edge ≤1px`);
      }
    }
  }
});

test('W3-1: 脏输入防御 —— 三系换算绝不抛、脏值诚实回退', () => {
  // 脏矩形 → 归一化回退全图
  const n1 = patchRectToNormalized({ x: NaN, y: -5, w: 0, h: Infinity }, 800, 600);
  assert.deepEqual(n1, { x0: 0, y0: 0, x1: 1, y1: 1 });
  // 脏维度 → 各面不抛
  assert.doesNotThrow(() => patchRectToNormalized({ x: 1, y: 1, w: 2, h: 2 }, NaN, 600));
  assert.doesNotThrow(() => normalizedToPatchRect({ x0: NaN, y0: 0, x1: 1, y1: 1 }, 800, 600));
  assert.doesNotThrow(() => patchRectToEncoded({ x: 1, y: 1, w: 2, h: 2 }, 800, 600, 0, NaN));
  assert.doesNotThrow(() => encodedPatchRectToSource({ x: 1, y: 1, w: 2, h: 2 }, 0, 0, 800, 600));
  // cleanPatchRect：越界收口（不拒绝）；退化拒绝
  assert.deepEqual(cleanPatchRect({ x: -10, y: -10, w: 100, h: 100 }, 800, 600), { x: 0, y: 0, w: 90, h: 90 });
  assert.deepEqual(cleanPatchRect({ x: 790, y: 590, w: 500, h: 500 }, 800, 600), { x: 790, y: 590, w: 10, h: 10 });
  assert.equal(cleanPatchRect({ x: 0, y: 0, w: 0, h: 5 }, 800, 600), null);
  assert.equal(cleanPatchRect(null, 800, 600), null);
  // 锚点文本：脏输入回退全图锚点
  const t1 = patchAnchorText({ x: NaN, y: 0, w: 0, h: 0 }, { width: 800, height: 600 }, { width: 400, height: 300 });
  assert.ok(t1.includes('full-frame'), `dirty anchor falls back to full-frame note (${t1})`);
});

test('W3-1: 锚点文本三系并列 —— 数值手算可复现', () => {
  const t = patchAnchorText(
    { x: 320, y: 108, w: 256, h: 96 },
    { width: 1920, height: 1080 },
    { width: 960, height: 540 },
  );
  assert.ok(t.includes('patch@(320,108,256,96)'), 'source-px anchor present');
  assert.ok(t.includes('source-px (320,108) 256x96'), 'source system present');
  // 编码系：x=round(320*960/1920)=160, w=round(576*0.5)-160=128
  assert.ok(t.includes('keyframe-encoded-px (160,54) 128x48'), `encoded system present (${t})`);
  // 归一化系：0.1667, 0.100 — 0.300, 0.189
  assert.ok(t.includes('normalized (0.167,0.100)-(0.300,0.189)'), `normalized system present (${t})`);
});

// ─── W3-2 补丁几何纯函数 ───

test('W3-2: regionsToPatchRects —— 邻近合并、远离独立、最小边、钳位', () => {
  const mk = (x0: number, y0: number, x1: number, y1: number, tiles: number): DiffRegion => ({
    index: 0,
    bbox_normalized: { x0, y0, x1, y1 },
    center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
    tiles_changed: tiles,
  });
  // 两块间隙 20px（≤24 ⇒ 合并）；第三块远离 400px（独立）
  const regions = [
    mk(100 / 800, 100 / 600, 200 / 800, 160 / 600, 10),
    mk(220 / 800, 100 / 600, 300 / 800, 160 / 600, 8),
    mk(700 / 800, 500 / 600, 780 / 800, 560 / 600, 4),
  ];
  const rects = regionsToPatchRects(regions, 800, 600);
  assert.equal(rects.length, 2, `nearby merge, far stays separate (got ${JSON.stringify(rects)})`);
  const merged = rects.find(r => r.x <= 100 && r.w >= 200)!;
  assert.ok(merged.x + merged.w >= 300, 'merged rect covers both');
  const far = rects.find(r => r !== merged)!;
  assert.ok(far.x >= 700 - 24 - 8, 'far rect around its own bbox');
  // 阅读序：y 升序
  assert.ok(rects[0]!.y <= rects[1]!.y, 'reading order (y asc)');
  // 最小边：单 1×1 归一化小块也垫到 ≥ minEdge（缺省 32）
  const [tiny] = regionsToPatchRects([mk(0.5, 0.5, 0.51, 0.51, 1)], 800, 600);
  assert.ok(tiny!.w >= 32 && tiny!.h >= 32, `minEdge enforced (got ${tiny!.w}x${tiny!.h})`);
  // 边缘钳位：贴边小块不出画布
  const [edge] = regionsToPatchRects([mk(0, 0, 0.01, 0.01, 1)], 800, 600);
  assert.ok(edge!.x === 0 && edge!.y === 0 && edge!.x + edge!.w <= 800 && edge!.y + edge!.h <= 600, 'clamped into canvas');
  // maxPatches 上限
  const many = Array.from({ length: 12 }, (_, i) => mk(i / 13 + 0.01, 0.1, i / 13 + 0.02, 0.2, 5 - (i % 5)));
  const capped = regionsToPatchRects(many, 800, 600, { mergeGapPx: 0 });
  assert.ok(capped.length <= 6, `maxPatches respected (got ${capped.length})`);
  // 脏输入：空清单/脏维度 ⇒ []
  assert.deepEqual(regionsToPatchRects([], 800, 600), []);
  assert.deepEqual(regionsToPatchRects(regions, 0, 600), []);
});

// ─── W3-3 账本分诊（sharp 合成真图） ───

test('W3-3: 冷启动首帧关键帧；微变产补丁（覆盖律）；无变化静默', async (t) => {
  await withSharp(t, async (s) => {
    const ledger = new ScreenStateLedger();
    const base = await framePng(s, 800, 600, 100, []);
    const v1 = await ledger.ingest(base);
    assert.equal(v1.kind, 'keyframe', 'cold start is keyframe');
    assert.equal(v1.generation, 1);
    assert.equal(v1.cumulativeDirtyPct, 0, 'fresh ledger has zero cumulative dirty');
    assert.deepEqual(v1.patches, []);

    // 微变：60x40 块（0.5% 屏）⇒ 补丁，且补丁覆盖变化块（含外扩余量）
    const mutated = await framePng(s, 800, 600, 100, [{ x: 300, y: 200, w: 60, h: 40, v: 255 }]);
    const v2 = await ledger.ingest(mutated);
    assert.equal(v2.kind, 'patch', `small change yields patch (got ${v2.kind}: ${v2.reason})`);
    assert.ok(v2.patches.length >= 1, 'at least one patch rect');
    const cover = v2.patches.find(p => p.x <= 300 && p.y <= 200 && p.x + p.w >= 360 && p.y + p.h >= 240);
    assert.ok(cover, `some patch covers the mutated block (got ${JSON.stringify(v2.patches)})`);
    assert.ok(v2.changedPct > 0 && v2.changedPct < 5, `changedPct in (0,5) (got ${v2.changedPct})`);
    assert.ok(v2.cumulativeDirtyPct > 0 && v2.cumulativeDirtyPct <= 30, 'cumulative tracked');
    assert.equal(v2.generation, 1, 'generation unchanged (no reset)');

    // 无变化 ⇒ 静默
    const v3 = await ledger.ingest(await framePng(s, 800, 600, 100, [{ x: 300, y: 200, w: 60, h: 40, v: 255 }]));
    assert.equal(v3.kind, 'silent', `identical frame is silent (got ${v3.kind})`);
    assert.deepEqual(v3.patches, []);
  });
});

test('W3-3: 大变产关键帧并重置账本（generation +1、累计归零）', async (t) => {
  await withSharp(t, async (s) => {
    const ledger = new ScreenStateLedger();
    const base = await framePng(s, 800, 600, 100, []);
    await ledger.ingest(base);
    // 先垫一个补丁（累计 >0），再用大变验证重置
    const small = await ledger.ingest(await framePng(s, 800, 600, 100, [{ x: 300, y: 200, w: 60, h: 40, v: 255 }]));
    assert.equal(small.kind, 'patch');
    assert.ok(small.cumulativeDirtyPct > 0);

    // 大变：上半屏反色（50% ≫ 5%）⇒ 关键帧
    const big = await framePng(s, 800, 600, 100, [{ x: 0, y: 0, w: 800, h: 300, v: 255 }]);
    const v = await ledger.ingest(big);
    assert.equal(v.kind, 'keyframe', `big change yields keyframe (got ${v.kind}: ${v.reason})`);
    assert.equal(v.generation, 2, 'generation incremented');
    assert.equal(v.cumulativeDirtyPct, 0, 'cumulative reset on keyframe');
    assert.ok(v.changedPct >= 5 || v.reason.includes('single-frame'), 'big-change reasoning');
  });
});

test('W3-3: 滚动产向量 + 新入内容条带（下移 ⇒ 顶部条带）', async (t) => {
  await withSharp(t, async (s) => {
    const W = 800, H = 1000;
    const vAt = (y: number) => 30 + ((y * 7) % 200);
    const before = await rowTexturePng(s, W, H, vAt);
    const ledger = new ScreenStateLedger();
    await ledger.ingest(before);

    // 内容下移 40px：after[y] = before[y-40]；顶部 40 行为新内容（亮条）
    const after = await rowTexturePng(s, W, H, (y) => (y < 40 ? 250 : vAt(y - 40)));
    const v = await ledger.ingest(after);
    assert.equal(v.kind, 'scroll', `scroll detected (got ${v.kind}: ${v.reason})`);
    assert.ok(v.scroll, 'scroll report present');
    assert.ok(Math.abs(v.scroll!.dyPx - 40) <= 4, `dyPx ≈ 40 source px (got ${v.scroll!.dyPx})`);
    assert.ok(v.scroll!.dyPx > 0, 'content moved down');
    assert.ok(v.scroll!.residual < 0.5, 'translation hypothesis holds');
    assert.equal(v.patches.length, 1, 'band = single strip');
    const band = v.patches[0]!;
    assert.equal(band.x, 0);
    assert.equal(band.y, 0, 'new content entered at TOP (dy>0)');
    assert.equal(band.w, W);
    assert.equal(band.h, Math.abs(v.scroll!.dyPx), 'band height = |dy|');

    // 上移 40px ⇒ 底部条带
    const up = await rowTexturePng(s, W, H, (y) => (y >= H - 40 ? 250 : vAt(y + 40)));
    const v2 = await ledger.ingest(up);
    assert.equal(v2.kind, 'scroll', `reverse scroll detected (got ${v2.kind}: ${v2.reason})`);
    assert.ok(v2.scroll! && v2.scroll!.dyPx < 0, 'content moved up');
    const band2 = v2.patches[0]!;
    assert.equal(band2.y + band2.h, H, 'new content entered at BOTTOM (dy<0)');
  });
});

test('W3-3: 累计脏面积超 30% ⇒ 关键帧重置（P 帧漂移天花板）', async (t) => {
  await withSharp(t, async (s) => {
    const W = 800, H = 600;
    const ledger = new ScreenStateLedger();
    await ledger.ingest(await framePng(s, W, H, 100, []));
    // 3.75% 屏的块逐帧点亮在不同象限 —— 单帧 <5% 产补丁，累计超 30% 重置
    const cells: Array<{ x: number; y: number }> = [];
    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 4; gx++) cells.push({ x: gx * 200 + 20, y: gy * 200 + 20 });
    }
    let sawCumulativeReset = false;
    const kinds: string[] = [];
    for (let i = 0; i < cells.length; i++) {
      const blocks = cells.slice(0, i + 1).map(c => ({ ...c, w: 160, h: 90, v: 255 }));
      const v = await ledger.ingest(await framePng(s, W, H, 100, blocks));
      kinds.push(v.kind);
      if (v.kind === 'keyframe' && /cumulative/.test(v.reason)) {
        sawCumulativeReset = true;
        assert.ok(v.cumulativeDirtyPct === 0, 'reset zeroes cumulative');
        break;
      }
    }
    assert.ok(sawCumulativeReset, `cumulative reset fired within ${cells.length} blocks (kinds: ${kinds.join(',')})`);
    assert.ok(kinds.slice(0, Math.max(1, kinds.indexOf('keyframe'))).every(k => k === 'patch'),
      'frames before the reset were all patches');
  });
});

// ─── W3-4 端口注入（离线确定性 —— 无 sharp 依赖） ───

/** 离线分析桩：预设维度 + 变化占比（区域清单按占比现铸） */
function stubAnalysis(width: number, height: number, changedPct: number): LedgerAnalysis {
  const frac = Math.min(1, changedPct / 100);
  const side = Math.sqrt(frac);
  return {
    width, height,
    regions: changedPct <= 0 ? [] : [{
      index: 1,
      bbox_normalized: { x0: 0.1, y0: 0.1, x1: 0.1 + side, y1: 0.1 + side },
      center: { x: 0.1 + side / 2, y: 0.1 + side / 2 },
      tiles_changed: 5,
    }],
    changedPct, identical: changedPct < 0.1,
    rowShift: null, diffRows: 0,
  };
}

test('W3-4: 分析端口抛错 ⇒ 降级整帧关键帧，绝不抛', async () => {
  const ledger = new ScreenStateLedger({ analyze: async () => { throw new Error('analyze port broken (W3-4 stub)'); } });
  const buf = Buffer.from([1, 2, 3]);
  let v: LedgerVerdict | null = null;
  await assert.doesNotReject(async () => { v = await ledger.ingest(buf); });
  assert.equal(v!.kind, 'keyframe', 'degraded to full frame');
  assert.ok(v!.degraded && v!.degraded.includes('analyze port failed'), `honest degraded note (${v!.degraded})`);
  // 坏帧（非 Buffer/空）也不抛
  await assert.doesNotReject(async () => {
    const e = await ledger.ingest(Buffer.alloc(0));
    assert.equal(e.kind, 'keyframe');
    assert.ok(e.degraded, 'empty frame flagged');
  });
});

test('W3-4: 哈希快路径 —— 同哈希静默；哈希端口缺席走全量差分', async () => {
  // 注入哈希端口：内容寻址指纹
  const hashOf = (b: Buffer) => `${b.length}:${b.toString('hex').slice(0, 16)}`;
  let calls = 0;
  const ledger = new ScreenStateLedger({
    hashFrame: hashOf,
    analyze: async (_b, a) => { calls++; return stubAnalysis(800, 600, 2); },
  });
  const f1 = Buffer.from('frame-aaa');
  const f2 = Buffer.from('frame-bbb');
  await ledger.ingest(f1);
  assert.ok(calls >= 1, 'analyze ran for first frame');
  const before = calls;
  const v = await ledger.ingest(f2);
  assert.equal(v.kind, 'patch', 'different hash falls through to diff');
  assert.equal(calls, before + 1, 'analyze ran again');
  // 同哈希 ⇒ 静默快路径（免差分）
  const vs = await ledger.ingest(f2);
  assert.equal(vs.kind, 'silent', 'same hash short-circuits to silent');
  assert.equal(calls, before + 1, 'analyze skipped on fast path');
});

test('W3-4: TTL 到期 ⇒ 关键帧（墙钟端口注入）', async () => {
  let clock = 1_000_000;
  const ledger = new ScreenStateLedger(
    { now: () => clock, analyze: async (_b, a) => stubAnalysis(800, 600, 2) },
    { ttlMs: 60_000 },
  );
  await ledger.ingest(Buffer.from('k'));
  clock += 30_000;
  const mid = await ledger.ingest(Buffer.from('p1'));
  assert.equal(mid.kind, 'patch', 'within TTL: patch');
  clock += 31_001; // TTL 60s 已过
  const late = await ledger.ingest(Buffer.from('p2'));
  assert.equal(late.kind, 'keyframe', `TTL expiry forces keyframe (got ${late.kind}: ${late.reason})`);
  assert.ok(/TTL/.test(late.reason), 'reason cites TTL');
});

test('W3-4: surpriseBits ≥ 24 ⇒ 关键帧（世界快照惊异信号，只读消费）', async () => {
  const ledger = new ScreenStateLedger({ analyze: async (_b, a) => stubAnalysis(800, 600, 2) });
  await ledger.ingest(Buffer.from('k'));
  const calm = await ledger.ingest(Buffer.from('p'), { surpriseBits: 10 });
  assert.equal(calm.kind, 'patch', 'low surprise does not reset');
  const jump = await ledger.ingest(Buffer.from('p2'), { surpriseBits: 24 });
  assert.equal(jump.kind, 'keyframe', `surprise >= 24 resets (got ${jump.kind}: ${jump.reason})`);
  assert.ok(/surpriseBits/.test(jump.reason), 'reason cites surpriseBits');
});

test('W3-4: forceKeyframe 逃生口（模型请求整帧/补丁模式显式关闭）', async () => {
  const ledger = new ScreenStateLedger({ analyze: async (_b, a) => stubAnalysis(800, 600, 2) });
  await ledger.ingest(Buffer.from('k'));
  const forced = await ledger.ingest(Buffer.from('p'), { forceKeyframe: true });
  assert.equal(forced.kind, 'keyframe', 'forceKeyframe bypasses patch economics');
  assert.ok(/forceKeyframe/.test(forced.reason), 'reason cites escape hatch');
});

test('W3-4: 分辨率突变 ⇒ 关键帧（坐标系整体失效）', async () => {
  const ledger = new ScreenStateLedger({ analyze: async (_b, a) => stubAnalysis(a[0] === 87 ? 800 : 1024, 600, 2) });
  await ledger.ingest(Buffer.from([87, 1]));
  const v = await ledger.ingest(Buffer.from([88, 1]));
  assert.equal(v.kind, 'keyframe', 'resolution change resets');
  assert.ok(/resolution/.test(v.reason), 'reason cites resolution');
});

// ─── W3-5 投递协议（假附件服务） ───

interface SavedRef { attachmentId: string; mediaType: string; bytes: number; name?: string }

function fakeStore(): { saveImage: (i: { data: Uint8Array; mediaType: string; name?: string }) => Promise<SavedRef>; saved: SavedRef[] } {
  let seq = 0;
  const saved: SavedRef[] = [];
  return {
    saved,
    async saveImage(input) {
      const ref: SavedRef = {
        attachmentId: `att-${++seq}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        name: input.name,
      };
      saved.push(ref);
      return ref;
    },
  };
}

/** 构造最小合法 PNG（1x1）作投递/编码的帧物料 */
async function tinyPng(s: SharpLike): Promise<Buffer> {
  return s(Buffer.from([255, 0, 0]), { raw: { width: 1, height: 1, channels: 3 } }).png().toBuffer();
}

test('W3-5: 端口缺席（附件服务未注入）⇒ deliverIncremental 返回 null', async () => {
  const before = imageDeliveryAvailable();
  assert.equal(before, false, 'store not injected in this process by default');
  const v: LedgerVerdict = {
    kind: 'patch', patches: [{ x: 0, y: 0, w: 1, h: 1 }], scroll: null,
    changedPct: 1, cumulativeDirtyPct: 1, generation: 1, reason: 'test', degraded: null,
  };
  const out = await deliverIncremental(v, Buffer.from('x'));
  assert.equal(out, null, 'absent store degrades to null (caller falls back to legacy full-frame path)');
});

test('W3-5: 补丁投递 —— 主帧已投、补丁小图 + 锚点文本 + 替换语义总述', async (t) => {
  await withSharp(t, async (s) => {
    const store = fakeStore();
    setImageDeliveryStore(store);
    try {
      const W = 400, H = 300;
      const frame = await framePng(s, W, H, 100, [{ x: 100, y: 80, w: 60, h: 40, v: 255 }]);
      const verdict: LedgerVerdict = {
        kind: 'patch',
        patches: [{ x: 96, y: 72, w: 72, h: 56 }],
        scroll: null, changedPct: 2, cumulativeDirtyPct: 3.4, generation: 2, reason: 'test', degraded: null,
      };
      const out = await deliverIncremental(verdict, frame, {
        patchEncode: { keyframeEncoded: { width: 200, height: 150 } },
      });
      assert.ok(out, 'delivery produced');
      assert.equal(out!.mode, 'patch');
      assert.equal(out!.keyframeAttachment, null, 'no keyframe attachment in patch mode');
      assert.equal(out!.patchParts.length, 1, 'one patch part');
      const part = out!.patchParts[0]!;
      assert.ok(part.attachment.attachmentId.startsWith('att-'), 'attachment saved');
      assert.equal(part.attachment.mediaType, 'image/jpeg', 'patch delivered as JPEG');
      assert.ok(part.anchorText.includes('patch@(96,72,72,56)'), 'anchor cites source rect');
      // 编码系锚点：x=round(96*200/400)=48
      assert.ok(part.anchorText.includes('keyframe-encoded-px (48,36) 36x28'), `encoded anchor (${part.anchorText})`);
      assert.ok(out!.narration.includes('PATCHES of the SAME screen'), 'replacement semantics narrated');
      assert.ok(out!.narration.includes('UNCHANGED since the keyframe'), 'unchanged-region claim narrated');
      assert.ok(out!.narration.includes('full-frame'), 'escape hatch documented to the model');
      assert.equal(out!.degraded, null);
      assert.equal(store.saved.length, 1, 'exactly one attachment saved');
    } finally {
      setImageDeliveryStore(null);
    }
  });
});

test('W3-5: 关键帧/滚动/静默投递 + forceFullFrame 逃生口', async (t) => {
  await withSharp(t, async (s) => {
    const store = fakeStore();
    setImageDeliveryStore(store);
    try {
      const W = 400, H = 300;
      const frame = await framePng(s, W, H, 100, []);
      // keyframe：整帧附件 + 新基准叙述
      const kf = await deliverIncremental({
        kind: 'keyframe', patches: [], scroll: null, changedPct: 0,
        cumulativeDirtyPct: 0, generation: 3, reason: 'test', degraded: null,
      }, frame);
      assert.equal(kf!.mode, 'keyframe');
      assert.ok(kf!.keyframeAttachment, 'full-frame attachment saved');
      assert.equal(kf!.patchParts.length, 0);
      assert.ok(kf!.narration.includes('generation 3'), 'generation narrated');
      assert.ok(kf!.narration.includes('FULL-SCREEN BASELINE'), 'baseline semantics narrated');

      // scroll：条带附件 + 向量叙述
      const scrollFrame = await rowTexturePng(s, W, H, (y) => (y < 20 ? 250 : 100 + (y % 60)));
      const sc = await deliverIncremental({
        kind: 'scroll', patches: [{ x: 0, y: 0, w: W, h: 20 }],
        scroll: { dyPx: 20, shiftRows: 13.3, residual: 0.05 },
        changedPct: 30, cumulativeDirtyPct: 6.7, generation: 3, reason: 'test', degraded: null,
      }, scrollFrame);
      assert.equal(sc!.mode, 'scroll');
      assert.ok(sc!.scrollAttachment, 'strip attachment saved');
      assert.ok(sc!.narration.includes('DOWN by 20px'), 'vector narrated');
      assert.ok(sc!.narration.includes('rows 0..20'), 'strip placement narrated');

      // silent：零附件
      const si = await deliverIncremental({
        kind: 'silent', patches: [], scroll: null, changedPct: 0,
        cumulativeDirtyPct: 6.7, generation: 3, reason: 'test', degraded: null,
      }, frame);
      assert.equal(si!.mode, 'silent');
      assert.equal(si!.keyframeAttachment, null);
      assert.equal(si!.patchParts.length, 0);

      // forceFullFrame：patch 判决被逃生口改写为整帧
      const ff = await deliverIncremental({
        kind: 'patch', patches: [{ x: 10, y: 10, w: 30, h: 30 }],
        scroll: null, changedPct: 2, cumulativeDirtyPct: 1, generation: 3, reason: 'test', degraded: null,
      }, frame, { forceFullFrame: true });
      assert.equal(ff!.mode, 'keyframe', 'escape hatch overrides patch mode');
      assert.ok(ff!.keyframeAttachment, 'full frame delivered');
      assert.ok(ff!.degraded && /bypassed/.test(ff!.degraded), 'bypass noted honestly');
    } finally {
      setImageDeliveryStore(null);
    }
  });
});

test('W3-5: 补丁编码失败（sharp 端口残废）⇒ 回退整帧投递，绝不抛', async (t) => {
  await withSharp(t, async () => {
    const store = fakeStore();
    setImageDeliveryStore(store);
    _overrideSharpResolver_forTest(() => Promise.reject(new Error('sharp unavailable (W3-5 stub)')));
    try {
      const verdict: LedgerVerdict = {
        kind: 'patch', patches: [{ x: 0, y: 0, w: 10, h: 10 }], scroll: null,
        changedPct: 1, cumulativeDirtyPct: 1, generation: 1, reason: 'test', degraded: null,
      };
      const box: { out: Awaited<ReturnType<typeof deliverIncremental>> } = { out: null };
      await assert.doesNotReject(async () => { box.out = await deliverIncremental(verdict, Buffer.from('png-bytes')); });
      assert.ok(box.out, 'delivery degraded, not aborted');
      assert.equal(box.out.mode, 'keyframe', 'fell back to full frame');
      assert.ok(box.out.degraded && /encoding failed/.test(box.out.degraded), `honest degraded note (${box.out.degraded})`);
      // 脏判决 ⇒ null（不猜）
      assert.equal(await deliverIncremental(null as unknown as LedgerVerdict, Buffer.from('x')), null);
      assert.equal(await deliverIncremental({ kind: 'weird' } as unknown as LedgerVerdict, Buffer.from('x')), null);
    } finally {
      _overrideSharpResolver_forTest(null);
      setImageDeliveryStore(null);
    }
  });
});

test('W3-5: encodePatchForVlm —— 原生裁出、cropRect 权威、脏矩形拒绝', async (t) => {
  await withSharp(t, async (s) => {
    const W = 600, H = 400;
    const frame = await framePng(s, W, H, 100, [{ x: 200, y: 120, w: 120, h: 80, v: 255 }]);
    const r = await encodePatchForVlm(frame, { x: 200, y: 120, w: 120, h: 80 }, {
      keyframeEncoded: { width: 300, height: 200 },
    });
    assert.ok(r.ok && r.value, `patch encoded (${r.error})`);
    // 原生裁出：cropRect 与补丁矩形逐字段一致（补丁小于带宽 ⇒ 不缩放）
    assert.deepEqual(r.value!.cropRect, { left: 200, top: 120, width: 120, height: 80 });
    assert.deepEqual(r.value!.patch, { x: 200, y: 120, w: 120, h: 80 });
    assert.equal(r.value!.width, 120, 'native-resolution patch (no resize below bandwidth)');
    assert.equal(r.value!.height, 80);
    assert.equal(r.value!.sourceWidth, W);
    // 归一化锚点：200/600, 120/400
    const n = r.value!.patchNormalized;
    assert.ok(Math.abs(n.x0 - 200 / 600) < 1e-9 && Math.abs(n.y0 - 120 / 400) < 1e-9);
    assert.ok(r.value!.anchorText.includes('keyframe-encoded-px (100,60) 60x40'), `anchor in keyframe-encoded system (${r.value!.anchorText})`);
    // 越界收口：超界矩形被夹进画布而非拒绝
    const c = await encodePatchForVlm(frame, { x: -50, y: -50, w: 300, h: 200 });
    assert.ok(c.ok && c.value);
    assert.deepEqual(c.value!.cropRect, { left: 0, top: 0, width: 250, height: 150 });
    // 退化矩形拒绝
    const bad = await encodePatchForVlm(frame, { x: 0, y: 0, w: 0, h: 5 });
    assert.equal(bad.ok, false);
    // 空缓冲拒绝
    const eb = await encodePatchForVlm(Buffer.alloc(0), { x: 0, y: 0, w: 10, h: 10 });
    assert.equal(eb.ok, false);
    // sharp 残废 ⇒ ok:false 绝不抛
    _overrideSharpResolver_forTest(() => Promise.reject(new Error('no sharp (W3-5 stub)')));
    try {
      const ns = await encodePatchForVlm(frame, { x: 0, y: 0, w: 10, h: 10 });
      assert.equal(ns.ok, false);
      assert.ok(/sharp unavailable/.test(ns.error!), 'honest error');
    } finally {
      _overrideSharpResolver_forTest(null);
    }
  });
});

// ─── W3-6 缺省兼容：开关默认关闭；开与关状态下现有路径逐字节一致 ───

test('W3-6: 增量开关默认关闭；翻转开关不触碰现有 diff/编码路径（逐字节一致）', async (t) => {
  // 未注册 ⇒ 缺省关
  assert.equal(incrementalEncodingEnabled(), false, 'incremental encoding defaults to OFF');
  await withSharp(t, async (s) => {
    const W = 800, H = 600;
    const a = await framePng(s, W, H, 100, [{ x: 100, y: 100, w: 200, h: 150, v: 230 }]);
    const b = await framePng(s, W, H, 100, [{ x: 100, y: 100, w: 200, h: 150, v: 30 }]);
    // 关（缺省）状态下的基线输出
    const diffOff = await computeDiffRegions(a, b);
    const encOff = await encodeForVlm(a, { maxDimension: 400, quality: 70 });
    assert.ok(encOff.ok);
    try {
      kernelRegistry.register({ key: 'visualDiff.incremental', organ: 'perception', defaultValue: 0, min: 0, max: 1, note: 'W3-3：增量编码模块开关（0/1；测试内注册，生产由 index.ts 铸入）' });
      assert.equal(incrementalEncodingEnabled(), false, 'registered at 0 still OFF');
      // 开
      await kernelRegistry.set('visualDiff.incremental', 1);
      assert.equal(incrementalEncodingEnabled(), true, 'set to 1 turns ON');
      // 开状态下：现有 computeDiffRegions / encodeForVlm 输出与关闭态逐字节一致
      const diffOn = await computeDiffRegions(a, b);
      assert.deepEqual(diffOn, diffOff, 'computeDiffRegions byte-identical with switch ON');
      const encOn = await encodeForVlm(a, { maxDimension: 400, quality: 70 });
      assert.ok(encOn.ok);
      assert.equal(encOn.value!.base64, encOff.value!.base64, 'encodeForVlm base64 byte-identical with switch ON');
      assert.equal(encOn.value!.strategy, encOff.value!.strategy);
    } finally {
      resetKernelRuntime(); // 注册表归零（测试隔离）
    }
    assert.equal(incrementalEncodingEnabled(), false, 'back to OFF after reset');
    // 复跑一次确认复位后仍一致
    const diffAfter = await computeDiffRegions(a, b);
    assert.deepEqual(diffAfter, diffOff);
  });
});

test('W3-6: saveScreenshotAttachment 缺席时返回 null（旧行为不变）', async () => {
  // 本进程未注入 store（其他测试 finally 已复位）—— 与现状语义一致
  assert.equal(await saveScreenshotAttachment(Buffer.from('x'), 't.jpg'), null);
});

// ─── ΝΩ-24：computeDiffRegions 维度守卫 + 账本重置路径维度缓存 ───

test('ΝΩ-24: 维度守卫原子 usableImageDims —— 非法维度一律 null（有限正数双轴）', async () => {
  const { usableImageDims } = await import('../src/visualDiff.ts');
  // 合法域
  assert.deepEqual(usableImageDims({ width: 480, height: 270 }), { width: 480, height: 270 });
  assert.deepEqual(usableImageDims({ width: 100.5, height: 50 }), { width: 100.5, height: 50 });
  // 非法域：缺席 / 非数 / 非有限 / 非正 —— 旧实现 height!/width! 全部直喂 NaN
  assert.equal(usableImageDims({}), null, '双轴缺席 ⇒ null');
  assert.equal(usableImageDims({ width: 480 }), null, 'height 缺席 ⇒ null');
  assert.equal(usableImageDims({ width: 480, height: undefined }), null);
  assert.equal(usableImageDims({ width: NaN, height: 270 }), null, 'NaN ⇒ null');
  assert.equal(usableImageDims({ width: Infinity, height: 270 }), null, '∞ ⇒ null');
  assert.equal(usableImageDims({ width: 0, height: 270 }), null, '零宽 ⇒ null');
  assert.equal(usableImageDims({ width: 480, height: -3 }), null, '负高 ⇒ null');
  assert.equal(usableImageDims(null), null, 'meta 本身缺席 ⇒ null（防御面）');
});

test('ΝΩ-24: 重置路径维度缓存命中 —— force/surprise/TTL 免自 diff，冷启动仍探测', async () => {
  let analyzeCalls = 0;
  let clock = 1_000;
  const ledger = new ScreenStateLedger({
    analyze: async () => { analyzeCalls++; return stubAnalysis(800, 600, 0); },
    now: () => clock,
  });
  const buf = Buffer.from([7, 7, 7]);
  const v1 = await ledger.ingest(buf); // 冷启动：缓存缺席 ⇒ 自 diff 恰一次
  assert.equal(v1.kind, 'keyframe');
  assert.equal(analyzeCalls, 1, '冷启动探测（维度缓存的铸入点）');
  assert.deepEqual(ledger.stats().prevDims, { width: 800, height: 600 });
  // 重置信号 ①：forceKeyframe —— 缓存命中 ⇒ 零分析调用，判决同旧路径
  const v2 = await ledger.ingest(buf, { forceKeyframe: true });
  assert.equal(analyzeCalls, 1, '维度缓存命中：重置免自 diff');
  assert.equal(v2.kind, 'keyframe');
  assert.equal(v2.generation, 2);
  assert.match(v2.reason, /forceKeyframe/, '判决理由与旧路径同文');
  // 重置信号 ②：surpriseBits —— 同律命中
  const v3 = await ledger.ingest(buf, { surpriseBits: 30 });
  assert.equal(analyzeCalls, 1);
  assert.equal(v3.kind, 'keyframe');
  assert.match(v3.reason, /surpriseBits/);
  // 重置信号 ③：TTL 到期 —— 同律命中
  clock += 200_000;
  const v4 = await ledger.ingest(buf);
  assert.equal(analyzeCalls, 1);
  assert.equal(v4.kind, 'keyframe');
  assert.match(v4.reason, /TTL/);
  // reset 归零缓存 ⇒ 下一次冷启动回到自 diff
  ledger.reset();
  await ledger.ingest(buf);
  assert.equal(analyzeCalls, 2, 'reset 出册：缓存缺席才回落自 diff');
});

test('ΝΩ-24: 缓存缺席（DimsFree 收养后）才回落自 diff —— 探测成功回填缓存', async () => {
  let portUp = true;
  let calls = 0;
  const ledger = new ScreenStateLedger({
    analyze: async () => {
      calls++;
      if (!portUp) throw new Error('port down');
      return stubAnalysis(800, 600, 0);
    },
    now: () => 5_000,
  });
  await ledger.ingest(Buffer.from([1])); // 冷启动成功：缓存建立
  assert.equal(calls, 1);
  portUp = false;
  const degraded = await ledger.ingest(Buffer.from([2])); // 主路径双败 ⇒ DimsFree（prevW=0 出册）
  assert.equal(degraded.kind, 'keyframe');
  assert.ok(degraded.degraded, '双重失败诚实申报');
  assert.deepEqual(ledger.stats().prevDims, { width: 0, height: 0 }, 'DimsFree：维度未知即缓存出册');
  const before = calls;
  const v = await ledger.ingest(Buffer.from([3]), { forceKeyframe: true }); // 缓存缺席 ⇒ 自 diff（仍败）
  assert.equal(calls, before + 1, '缓存缺席：回落自 diff 恰一次');
  assert.ok(v.degraded, '探测仍败 ⇒ DimsFree 兜底');
  portUp = true;
  const v2 = await ledger.ingest(Buffer.from([4]), { forceKeyframe: true }); // 探测成功 ⇒ 正常收养
  assert.equal(calls, before + 2);
  assert.equal(v2.kind, 'keyframe');
  assert.equal(v2.degraded, null);
  assert.deepEqual(ledger.stats().prevDims, { width: 800, height: 600 }, '探测维度回填缓存');
});
