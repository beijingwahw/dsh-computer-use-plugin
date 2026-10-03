// test/vlm.codec.test.ts
// 纪元 Ω（Ω-2）：VLM 编解码器单元测试 —— sharp 现场合成本真图驱动全部契约。
// 覆盖：原样编码 / 长边 1568 缩放 / region 裁剪（含组合）/ 非法输入拒绝 /
// VlmBudget 配额（张数+字节、默认值、reset）/ estimateVlmTokens 公式与单调性。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSharp, type SharpLike } from '../src/_legacyDeps.ts';

// 契约模块经动态 import 加载（Ω-2 铁律：不在测试顶层静态绑定被测模块）
const { encodeForVlm, VlmBudget, estimateVlmTokens } = await import('../src/vlm/codec.ts');

let sharp: SharpLike | null = null;
async function requireSharp(): Promise<SharpLike> {
  if (!sharp) sharp = await getSharp();
  return sharp;
}

/** 懒检查 sharp 是否可用，不可用时 test 直接 SKIP（仓库先例：perceptualHash.test.ts） */
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

test('encodeForVlm: 小图原样编码（不缩放，as-is）', async (t) => {
  await withSharp(t, async (s) => {
    const r = await encodeForVlm(await solidPng(s, 64, 48));
    assert.equal(r.ok, true);
    assert.ok(r.value, 'value must be present on ok');
    const v = r.value!;
    assert.equal(v.strategy, 'as-is');
    assert.equal(v.width, 64);
    assert.equal(v.height, 48);
    assert.equal(v.mime, 'image/jpeg');
    assert.ok(v.bytes > 0);
    const bin = Buffer.from(v.base64, 'base64');
    assert.equal(bin.length, v.bytes);          // bytes = JPEG 二进制字节数
    assert.equal(bin[0], 0xff);                 // JPEG SOI 魔数
    assert.equal(bin[1], 0xd8);
  });
});

test('encodeForVlm: 大图等比缩到长边 1568（默认与自定义 maxDimension）', async (t) => {
  await withSharp(t, async (s) => {
    // 3200x1600 → 1568x784（比例 2:1 精确整除）
    const big = await encodeForVlm(await solidPng(s, 3200, 1600));
    assert.equal(big.ok, true);
    assert.equal(big.value!.strategy, 'resize-1568');
    assert.equal(big.value!.width, 1568);
    assert.equal(big.value!.height, 784);

    // 自定义 maxDimension：400x200 → 长边 200 → 200x100
    const small = await encodeForVlm(await solidPng(s, 400, 200), { maxDimension: 200 });
    assert.equal(small.ok, true);
    assert.equal(small.value!.strategy, 'resize-200');
    assert.equal(small.value!.width, 200);
    assert.equal(small.value!.height, 100);

    // 长边恰等于 maxDimension：不缩放（「超过」才缩）
    const exact = await encodeForVlm(await solidPng(s, 100, 50), { maxDimension: 100 });
    assert.equal(exact.ok, true);
    assert.equal(exact.value!.strategy, 'as-is');
    assert.equal(exact.value!.width, 100);
  });
});

test('encodeForVlm: region 裁剪（兴趣区，像素坐标）', async (t) => {
  await withSharp(t, async (s) => {
    const r = await encodeForVlm(await solidPng(s, 400, 300), {
      region: { x0: 50, y0: 40, x1: 250, y1: 190 },
    });
    assert.equal(r.ok, true);
    assert.equal(r.value!.strategy, 'crop');
    assert.equal(r.value!.width, 200);
    assert.equal(r.value!.height, 150);
  });
});

test('encodeForVlm: region + 缩放组合（crop+resize）', async (t) => {
  await withSharp(t, async (s) => {
    const r = await encodeForVlm(await solidPng(s, 400, 300), {
      region: { x0: 0, y0: 0, x1: 300, y1: 300 }, // 正方形裁剪
      maxDimension: 100,
    });
    assert.equal(r.ok, true);
    assert.equal(r.value!.strategy, 'crop+resize');
    assert.equal(r.value!.width, 100);
    assert.equal(r.value!.height, 100);
  });
});

test('encodeForVlm: 空 Buffer 与非法 opts 拒绝（不依赖 sharp）', async () => {
  const empty = await encodeForVlm(Buffer.alloc(0));
  assert.equal(empty.ok, false);
  assert.ok(typeof empty.error === 'string' && empty.error.length > 0);

  const badQualityLow = await encodeForVlm(Buffer.alloc(4), { quality: 0 });
  assert.equal(badQualityLow.ok, false);
  const badQualityHigh = await encodeForVlm(Buffer.alloc(4), { quality: 101 });
  assert.equal(badQualityHigh.ok, false);
  const badDim = await encodeForVlm(Buffer.alloc(4), { maxDimension: 0 });
  assert.equal(badDim.ok, false);
});

test('encodeForVlm: 非法 region 与不可解码缓冲拒绝', async (t) => {
  await withSharp(t, async (s) => {
    const png = await solidPng(s, 100, 100);
    // x1 <= x0（退化区域）
    const degenerate = await encodeForVlm(png, { region: { x0: 80, y0: 10, x1: 20, y1: 60 } });
    assert.equal(degenerate.ok, false);
    // y1 <= y0
    const flatY = await encodeForVlm(png, { region: { x0: 0, y0: 50, x1: 50, y1: 50 } });
    assert.equal(flatY.ok, false);
    // 负原点
    const negative = await encodeForVlm(png, { region: { x0: -5, y0: 0, x1: 50, y1: 50 } });
    assert.equal(negative.ok, false);
    // 越界（x1 超出图像宽度）
    const overflow = await encodeForVlm(png, { region: { x0: 0, y0: 0, x1: 150, y1: 50 } });
    assert.equal(overflow.ok, false);
    // 非图像字节流：解码失败 → ok:false（绝不抛错）
    const garbage = await encodeForVlm(Buffer.from('definitely not an image', 'utf8'));
    assert.equal(garbage.ok, false);
  });
});

test('VlmBudget: 张数配额拒绝 + commit 累计 + summary/reset', () => {
  const b = new VlmBudget({ maxImagesPerTask: 2, maxBytesPerTask: 1000 });
  let c = b.check({ bytes: 400 });
  assert.equal(c.allowed, true);
  assert.equal(c.usedImages, 0);
  assert.equal(c.usedBytes, 0);

  b.commit({ bytes: 400 });
  c = b.check({ bytes: 400 });
  assert.equal(c.allowed, true); // 1+1<=2 张、400+400<=1000 字节
  assert.equal(c.usedImages, 1);
  assert.equal(c.usedBytes, 400);

  b.commit({ bytes: 400 });
  const s1 = b.summary();
  assert.equal(s1.usedImages, 2);
  assert.equal(s1.usedBytes, 800);
  assert.equal(s1.maxImages, 2);
  assert.equal(s1.maxBytes, 1000);

  c = b.check({ bytes: 1 }); // 第三张：张数超限（2/2）
  assert.equal(c.allowed, false);
  assert.ok(c.reason && c.reason.length > 0);
  assert.equal(c.usedImages, 2); // check 不改变用量
  assert.equal(b.summary().usedImages, 2);

  b.reset();
  const s2 = b.summary();
  assert.equal(s2.usedImages, 0);
  assert.equal(s2.usedBytes, 0);
  assert.equal(b.check({ bytes: 1000 }).allowed, true); // 复位后重新放行
});

test('VlmBudget: 字节配额独立拒绝 + 默认配额 200 张 / 512MB', () => {
  const b = new VlmBudget({ maxImagesPerTask: 10, maxBytesPerTask: 500 });
  assert.equal(b.check({ bytes: 600 }).allowed, false); // 单张即超字节预算
  assert.equal(b.check({ bytes: 300 }).allowed, true);
  b.commit({ bytes: 300 });
  const c = b.check({ bytes: 300 }); // 300+300 > 500
  assert.equal(c.allowed, false);
  assert.match(c.reason ?? '', /byte/);
  assert.equal(c.usedBytes, 300);

  const d = new VlmBudget();
  const sd = d.summary();
  assert.equal(sd.maxImages, 200);
  assert.equal(sd.maxBytes, 512 * 1024 * 1024);
  assert.equal(sd.usedImages, 0);
  assert.equal(sd.usedBytes, 0);
});

test('estimateVlmTokens: 公式精确 + 宽高各封顶 2000', () => {
  assert.equal(estimateVlmTokens(1000, 750), 1000);                    // 整除
  assert.equal(estimateVlmTokens(1000, 751), 1002);                    // 1001.33 → 向上取整
  assert.equal(estimateVlmTokens(1568, 784), Math.ceil((1568 * 784) / 750));
  assert.equal(estimateVlmTokens(4000, 3000), Math.ceil((2000 * 2000) / 750)); // 封顶
  assert.equal(estimateVlmTokens(4000, 3000), estimateVlmTokens(2000, 2000));
  assert.equal(estimateVlmTokens(0, 500), 0);
  assert.equal(estimateVlmTokens(100, 0), 0);
});

test('estimateVlmTokens: 单调性（宽/高递增不减少）', () => {
  let prev = -1;
  for (let w = 0; w <= 4100; w += 137) {
    const v = estimateVlmTokens(w, 777);
    assert.ok(v >= prev, `width=${w}: ${v} < ${prev}`);
    prev = v;
  }
  prev = -1;
  for (let h = 0; h <= 4100; h += 173) {
    const v = estimateVlmTokens(777, h);
    assert.ok(v >= prev, `height=${h}: ${v} < ${prev}`);
    prev = v;
  }
  // 封顶后保持平稳（2000 之后恒定）
  assert.equal(estimateVlmTokens(2000, 2000), estimateVlmTokens(9000, 9000));
});

test('encodeForVlm × VlmBudget: 端到端接线', async (t) => {
  await withSharp(t, async (s) => {
    const r = await encodeForVlm(await solidPng(s, 100, 100));
    assert.equal(r.ok, true);
    const budget = new VlmBudget({ maxImagesPerTask: 1, maxBytesPerTask: r.value!.bytes });
    assert.equal(budget.check({ bytes: r.value!.bytes }).allowed, true);
    budget.commit({ bytes: r.value!.bytes });
    const denied = budget.check({ bytes: r.value!.bytes });
    assert.equal(denied.allowed, false); // 第二张：张数与字节双双超限
    assert.match(denied.reason ?? '', /image/);
    assert.match(denied.reason ?? '', /byte/);
    const sum = budget.summary();
    assert.equal(sum.usedImages, 1);
    assert.equal(sum.usedBytes, r.value!.bytes);
  });
});
