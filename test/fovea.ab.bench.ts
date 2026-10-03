// test/fovea.ab.bench.ts
// INNOVATION Γ 节 token 目标的诚实审计（纪元 Γ2 · inset 模式兑现）。
//
// 背景：Γ 落地的 blur 模式（中央原生、外围模糊）提升了中央可读性，但输出尺寸
// 不变 ⇒ estimateVlmTokens 一分不省 —— INNOVATION.md Γ 节「token −40% 且精度
// 不掉」的目标在 Γ 纪元并未兑现（Γ 收官注记自认「待 bench 纪元兑现」）。
// Γ2 的 inset 模式（主图 1/scale 真降采样 + 中央原生密度凹窗嵌回）使输出 =
// 缩图尺寸 ⇒ token 按 1/scale² 骨跌。本基准用同批合成屏对三编码做 A/B：
//   A 均质（缺省）  B blur（Γ）  C inset（Γ2，scale=2）
//
// 度量（全部离线确定性，sharp 现铸 5 张 1920x1080 合成屏 —— 外围 16px 高频
// 棋盘 + 中央实心目标块）：
//   1. token/字节：estimateVlmTokens 与 JPEG 字节的实测对比 —— B 的 token
//      与 A 全等（诚实零）是本基准的第一判据；
//   2. 凹窗保真：C 的窗内像素 vs 原生编码（A）对应像素 1:1 逐点差 ≤ JPEG 级容差；
//   3. 外围损失：C 的窗外像素 vs 原生编码（A）2x 对应点逐点差 —— **不粉饰的
//      代价栏**：外围 1/scale 密度对高频内容的真实信息损失（这正是「中央凹」
//      的生物学语义：注视点外本来就不精确）。
//
// 诚实边界：
//   · token/字节/像素保真是**代理指标** —— 零网络铁律下无真 VLM 往返，
//     「精度不掉」的最终裁决（IoU/识别率 A/B）需在线基准，此处不越权宣称；
//   · 合成屏 ≠ 真实 UI：16px 棋盘是外围损失的高频应力上界（真实 UI 外围多为
//     平缓色块，损失显著更小）；中央实心块是凹窗保真的平滑下界；
//   · 外围差值混合了降采样信息损失与 JPEG 先后次序差，是**上界代理**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSharp, type SharpLike } from '../src/_legacyDeps.ts';

// 契约模块经动态 import 加载（Ω-2 铁律：不在测试顶层静态绑定被测模块）
const { encodeForVlmMeta, estimateVlmTokens } = await import('../src/vlm/codec.ts');

// ─── 脚手架（仓库 bench/test 同源先例） ───

let sharpCache: SharpLike | null = null;
async function requireSharp(): Promise<SharpLike> {
  if (!sharpCache) sharpCache = await getSharp();
  return sharpCache;
}

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

/** 屏幕批：5 张 1920x1080 —— 外围 16px 棋盘（双灰度逐屏位移）+ 中央 240x160 实心目标块 */
const SCREEN_W = 1920, SCREEN_H = 1080, SCREENS = 5;
const TARGET_W = 240, TARGET_H = 160;

async function synthScreen(s: SharpLike, idx: number): Promise<Buffer> {
  const g1 = 90 + idx * 18;              // 棋盘灰 A（逐屏位移 —— 批内多样性）
  const g2 = 210 - idx * 12;             // 棋盘灰 B
  const tv = 30 + idx * 25;              // 目标块灰（实心平滑 —— 凹窗保真取样点）
  const raw = Buffer.alloc(SCREEN_W * SCREEN_H * 3);
  const tx0 = (SCREEN_W - TARGET_W) >> 1, tx1 = tx0 + TARGET_W;
  const ty0 = (SCREEN_H - TARGET_H) >> 1, ty1 = ty0 + TARGET_H;
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const inTarget = x >= tx0 && x < tx1 && y >= ty0 && y < ty1;
      const v = inTarget ? tv : ((((x + idx * 8) / 16 | 0) + ((y + idx * 8) / 16 | 0)) % 2 === 0 ? g1 : g2);
      const i = (y * SCREEN_W + x) * 3;
      raw[i] = v; raw[i + 1] = v; raw[i + 2] = v;
    }
  }
  return s(raw, { raw: { width: SCREEN_W, height: SCREEN_H, channels: 3 } }).png().toBuffer();
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

/** 取样像素的逐通道最大绝对差（0=全同；255=极反） */
function maxChannelDiff(
  a: { data: Buffer; width: number }, ax: number, ay: number,
  b: { data: Buffer; width: number }, bx: number, by: number,
): number {
  const ia = (ay * a.width + ax) * 3;
  const ib = (by * b.width + bx) * 3;
  return Math.max(
    Math.abs(a.data[ia]! - b.data[ib]!),
    Math.abs(a.data[ia + 1]! - b.data[ib + 1]!),
    Math.abs(a.data[ia + 2]! - b.data[ib + 2]!),
  );
}

interface Variant { name: string; dims: string; tokens: number; totalBytes: number }

// ─── Part 1：token / 字节 A/B（INNOVATION Γ 目标的兑现审计） ───

test('Part 1 token/字节审计：均质 vs blur vs inset —— blur 的 token 节省是诚实零，inset ~75%', async (t) => {
  await withSharp(t, async (s) => {
    const screens: Buffer[] = [];
    for (let i = 0; i < SCREENS; i++) screens.push(await synthScreen(s, i));

    const variants: Array<{ name: string; opts: Record<string, unknown> }> = [
      { name: 'A 均质（缺省）', opts: {} },
      { name: 'B blur（Γ）', opts: { foveated: true, foveaMode: 'blur' } },
      { name: 'C inset（Γ2, scale=2）', opts: { foveated: true, foveaMode: 'inset', foveaPeripheryScale: 2 } },
    ];
    const results: Variant[] = [];
    for (const v of variants) {
      let totalBytes = 0;
      let tokens = 0;
      let dims = '';
      for (const png of screens) {
        const enc = await encodeForVlmMeta(png, v.opts);
        assert.equal(enc.ok, true, `${v.name} 编码必须成功`);
        const img = enc.value!;
        assert.equal(img.foveated, v.opts.foveated === true, `${v.name} foveated 注记`);
        totalBytes += img.bytes;
        tokens = estimateVlmTokens(img.width, img.height);
        dims = `${img.width}x${img.height}`;
      }
      results.push({ name: v.name, dims, tokens, totalBytes });
    }
    const [hom, blur, inset] = results;

    // ── 判据 1：尺寸与 token 数学（每屏同尺寸 ⇒ 单屏即全批） ──
    assert.equal(hom.dims, '1568x882', '均质：1920x1080 → 长边 1568 等比');
    assert.equal(blur.dims, hom.dims, 'blur：尺寸不变（Γ 语义 —— 坐标空间不动）');
    assert.equal(inset.dims, '784x441', 'inset：缩图尺寸 = 原生编码/2');
    assert.equal(hom.tokens, 1844, 'ceil(1568×882/750)');
    assert.equal(inset.tokens, 461, 'ceil(784×441/750)');
    assert.equal(blur.tokens, hom.tokens, '★ 诚实审计：blur 的 token 节省 = 0（Γ 目标未兑现的定量证据）');
    const tokenSavings = 1 - inset.tokens / hom.tokens;
    assert.ok(tokenSavings > 0.74 && tokenSavings < 0.76,
      `inset token 节省应 ≈75%（1/scale²；实测 ${(tokenSavings * 100).toFixed(2)}%）`);

    // ── 判据 2：字节实测（诚实数字，不粉饰 —— inset 因原生密度凹窗，字节节省
    //    小于 token 节省：密度不均的代价如实呈报） ──
    assert.ok(inset.totalBytes < hom.totalBytes, 'inset 总字节应低于均质（画布缩 4 倍 > 凹窗密度补贴）');

    // ── 报告（数字如实，一行一判据） ──
    console.log([
      '── INNOVATION Γ 节 token 目标的诚实审计（纪元 Γ2 兑现；5 张 1920x1080 合成屏）──',
      `编码尺寸      A ${hom.dims} | B ${blur.dims} | C ${inset.dims}`,
      `视觉 token/屏 A ${hom.tokens} | B ${blur.tokens} | C ${inset.tokens}`
        + `  ⇒ B 节省 0.00%（诚实零）| C 节省 ${(tokenSavings * 100).toFixed(2)}%（1/2² 骨跌）`,
      `JPEG 字节总计 A ${(hom.totalBytes / 1024).toFixed(1)}KB | B ${(blur.totalBytes / 1024).toFixed(1)}KB`
        + ` | C ${(inset.totalBytes / 1024).toFixed(1)}KB`
        + `  ⇒ B ${((1 - blur.totalBytes / hom.totalBytes) * 100).toFixed(1)}% | C ${((1 - inset.totalBytes / hom.totalBytes) * 100).toFixed(1)}%`,
      `INNOVATION Γ「token −40%」判据：blur ✗（0%）；inset ✔（${(tokenSavings * 100).toFixed(1)}% ≥ 40%）`,
    ].join('\n'));
  });
});

// ─── Part 2：像素保真 A/B（凹窗原生保真 vs 外围降采样损失 —— 代价不粉饰） ───

test('Part 2 保真审计：inset 凹窗 ≤ JPEG 级容差；外围对高频内容有实测定量损失', async (t) => {
  await withSharp(t, async (s) => {
    // 构造律自检（与 codec 同律）：E=1568x882、scale=2 ⇒ 缩图 784x441、edge=441；
    // fx=floor((1568−441)/2)=563、fy=floor((882−441)/2)=220；ix=floor((784−441)/2)=171、iy=0
    const EDGE = 441, FX = 563, FY = 220, IX = 171, IY = 0;
    let winMeanMax = 0, winMaxMax = 0;    // 凹窗保真（5 屏最差）
    let perMeanMax = 0, perMaxMax = 0;    // 外围损失（5 屏最差）
    for (let i = 0; i < SCREENS; i++) {
      const png = await synthScreen(s, i);
      const hom = await encodeForVlmMeta(png);
      const ins = await encodeForVlmMeta(png, { foveated: true, foveaMode: 'inset', foveaPeripheryScale: 2 });
      assert.equal(hom.ok && ins.ok, true);
      const m = ins.value!;
      assert.deepEqual(m.insetRect, { x: IX, y: IY, w: EDGE, h: EDGE }, 'insetRect 构造律自检');
      assert.deepEqual(m.insetNative, { width: 1568, height: 882 }, 'insetNative 构造律自检');
      const homImg = await decodeRgb(s, Buffer.from(hom.value!.base64, 'base64'));
      const insImg = await decodeRgb(s, Buffer.from(m.base64, 'base64'));
      assert.equal(homImg.width, 1568);   // A 即原生编码基准（同一管线、同一质量）
      assert.equal(insImg.width, 784);

      // 凹窗保真：中央目标块（平滑实心）—— 缩图 (IX+dx, IY+dy) vs 原生 (FX+dx, FY+dy)
      // 目标块投到原生窗内 [123,319)x[156,286)（两端距窗界 ≥122px —— JPEG 块不跨界）
      let sum = 0, n = 0, mx = 0;
      for (let dx = 8; dx < 300; dx += 5) {
        for (let dy = 8; dy < 120; dy += 5) {
          const d = maxChannelDiff(insImg, IX + dx, IY + dy, homImg, FX + dx, FY + dy);
          sum += d; n++; if (d > mx) mx = d;
        }
      }
      const winMean = sum / n;
      winMeanMax = Math.max(winMeanMax, winMean);
      winMaxMax = Math.max(winMaxMax, mx);

      // 外围损失：缩图窗外 (px,py) vs 原生 2x 对应点（1568/784 与 882/441 恰为精确 2）
      // —— 16px 棋盘在原生域 ~13px 格：2x2 块多落单格内（差≈0），跨格取样付全差
      sum = 0; n = 0; mx = 0;
      for (let px = 8; px < 776; px += 5) {
        if (px >= IX - 4 && px < IX + EDGE + 4) continue; // 避开凹窗及边界过渡带
        for (let py = 8; py < 434; py += 5) {
          const d = maxChannelDiff(insImg, px, py, homImg, px * 2, py * 2);
          sum += d; n++; if (d > mx) mx = d;
        }
      }
      const perMean = sum / n;
      perMeanMax = Math.max(perMeanMax, perMean);
      perMaxMax = Math.max(perMaxMax, mx);
    }

    // ── 判据：凹窗保真 ≤ JPEG 级容差（两次独立 q80 编码的块级纹波量级） ──
    assert.ok(winMeanMax <= 6, `凹窗平均逐通道差 ≤6（实测最差 ${winMeanMax.toFixed(2)}）`);
    assert.ok(winMaxMax <= 30, `凹窗单点极值 ≤30（实测最差 ${winMaxMax}）`);
    // ── 判据：外围损失为正且显著大于凹窗差（损失确实落在外围 —— 中央凹语义成立） ──
    assert.ok(perMeanMax > winMeanMax + 3,
      `外围平均差必须显著大于凹窗（外围 ${perMeanMax.toFixed(2)} vs 凹窗 ${winMeanMax.toFixed(2)}）`);
    assert.ok(perMeanMax < 100, `外围平均差 sanity 上界（实测 ${perMeanMax.toFixed(2)}）`);

    console.log([
      '── 像素保真 A/B（5 屏最差值；基准 = 均质编码 1568x882 原生 JPEG）──',
      `凹窗保真（inset 窗内 vs 原生 1:1）：平均 ${winMeanMax.toFixed(2)} / 极值 ${winMaxMax} —— ≤ JPEG 级容差 ✔`,
      `外围损失（inset 窗外 vs 原生 2x 点）：平均 ${perMeanMax.toFixed(2)} / 极值 ${perMaxMax}`,
      `  —— 高频棋盘上外围 1/2 密度的真实信息损失（真实 UI 外围多为平缓色块，损失更小）；`,
      `     这正是「中央凹」的代价栏：token −75% 的对价，如实呈报不粉饰。`,
    ].join('\n'));
  });
});
