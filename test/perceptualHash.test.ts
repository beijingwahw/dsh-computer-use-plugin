// test/perceptualHash.test.ts
// 感知哈希单元测试：用 sharp 合成确定性图像（无外部 fixture 文件）。
// 批次 E 迁移：sharp 不再作为 dependencies 安装。本测试文件使用懒加载获取 sharp，
// 未安装 sharp 时在首个 case 里给出清晰的跳过原因。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSharp, type SharpLike } from '../src/_legacyDeps.ts';
import { dhash, hammingDistance, similarity } from '../src/perceptualHash.ts';

let sharp: SharpLike | null = null;
async function requireSharp(): Promise<SharpLike> {
  if (!sharp) sharp = await getSharp();
  return sharp;
}

/** 合成 64x64 灰度图：左半 value、右半 value+delta（亮度阶梯） */
async function ladder(value: number, delta: number): Promise<Buffer> {
  const s = await requireSharp();
  const w = 64, h = 64;
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.min(255, Math.max(0, x < w / 2 ? value : value + delta));
      const i = (y * w + x) * 3;
      buf[i] = buf[i + 1] = buf[i + 2] = v;
    }
  }
  return s(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/** 懒检查 sharp 是否可用，不可用时 test 直接 SKIP */
async function withSharp<T>(t: any, fn: (s: SharpLike) => Promise<T>): Promise<T | undefined> {
  let s: SharpLike;
  try {
    s = await requireSharp();
  } catch (e: any) {
    // 批次 E 迁移：sharp 默认不装 —— 老 D-1 层用例标记 SKIP，
    // 迁移指引通过 skip 原因附带，而非让 test 变红。
    t.skip(`[batch-E] sharp not installed — ${e?.message?.slice(0, 240) ?? ''}`);
    return undefined;
  }
  return fn(s);
}

test('dhash: deterministic for identical input', async (t) => {
  await withSharp(t, async () => {
    const img = await ladder(100, 50);
    const h1 = await dhash(img);
    const h2 = await dhash(img);
    assert.equal(h1, h2);
    assert.match(h1, /^[01]{64}$/); // 9x8 网格 → 每行 8 bit × 8 行
  });
});

test('dhash: same flat image → all-zero hash; distance to ladder is large', async (t) => {
  await withSharp(t, async () => {
    const flat = await dhash(await ladder(128, 0));   // 无横向梯度
    const step = await dhash(await ladder(128, 120)); // 强横向梯度
    assert.equal(flat, '0'.repeat(64));
    // resize 平均后跨界列梯度平滑：~4/8 位每行翻转，32/64 已是「截然不同」
    assert.ok(hammingDistance(flat, step) >= 24, `expected large distance, got ${hammingDistance(flat, step)}`);
  });
});

test('hammingDistance & similarity: identity and length mismatch', () => {
  assert.equal(hammingDistance('0000', '0000'), 0);
  assert.equal(hammingDistance('0000', '1111'), 4);
  assert.equal(hammingDistance('01', '101'), 3); // 长度不齐 → 最大距离
  // similarity 按 64 位 dHash 语义设计（分母固定 64），测试也用 64 位串
  const a = '0'.repeat(64);
  const b = '1'.repeat(64);
  assert.equal(similarity(a, a), 1);
  assert.equal(similarity(a, b), 0);
  assert.equal(similarity('0'.repeat(63) + '1', a), 63 / 64);
});
