// test/w5ledger.bench.ts  ——  W5-6 效能基准包 · P2/C3 增量编码 token 当量缩减
//
// 被测声明（W3-3，visualDiff ScreenStateLedger P2+C3 脏矩形增量编码）：
// 视频 P 帧式感知 —— 微变产补丁 / 大变产关键帧 / 滚动产向量+条带 / 无变化
// 静默，相对逐帧全量投递省视觉 token。GENESIS 未给数值声明（行文为机制
// 声明），本基准锚定任务书档位下限：token 当量缩减 > 30%，并如实呈报实测。
//
// 口径（声明值 vs 实测值，逐项入 console 表）：
//   · 帧序列：K=20 帧确定性混合负载（sharp 现铸真图，零网络零 fixture）——
//     4 关键帧（冷启动 / 累计脏 30% 漂移天花板重置 / 世界切换×2）+ 12 微变
//     补丁 + 2 滚动 + 2 静默（补丁矩形经外扩余量记账，累计脏涨得比裸块快 ——
//     第 8 帧触顶重置是账本设计内的安全天花板，如实入账）；
//   · token 当量（estimateVlmTokens 口径，(w*h)/750 向上取整）：
//     全帧基线臂 = 每帧按整屏投递 estimateVlmTokens(W,H)；
//     增量臂 = keyframe 整屏 + patch 按补丁矩形 Σ estimateVlmTokens(w,h)
//     + scroll 按条带矩形同式 + silent 计 0；
//     两臂同一坐标系（源图原生像素）—— 坐标系归一，无偏置；
//   · 缩减率 = 1 − 增量臂 token / 基线臂 token；声明值 >30%（保守下限），
//     实测值由本基准输出（微变为主的混合负载下预期 >70%）。
//
// 确定性：像素数据由确定脚本直铸（灰底 + 实心块 / 逐行亮度纹理），sharp
// 编解码与分析管线在同机同版本下逐字节可复现；帧内容零随机。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSharp, type SharpLike } from '../src/_legacyDeps.ts';
import { ScreenStateLedger, type LedgerVerdict } from '../src/visualDiff.ts';
import { estimateVlmTokens } from '../src/vlm/codec.ts';

// ─── 脚手架（与 w3incremental.test.ts 同构） ───

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

/** 合成帧：灰底 + 叠加实心块（三通道差 >70 即可检变化） */
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

/** 合成滚动帧：逐行亮度纹理 v(y)（行移估计的理想输入） */
async function rowTexturePng(
  s: SharpLike, w: number, h: number, vAt: (y: number) => number,
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

/** 一个判决的增量 token 当量（源图原生坐标系：keyframe 整屏 / 其余按矩形） */
function incrementalTokens(v: LedgerVerdict, fullFrame: number): number {
  if (v.kind === 'keyframe') return fullFrame;
  if (v.kind === 'silent') return 0;
  return v.patches.reduce((sum, p) => sum + estimateVlmTokens(p.w, p.h), 0);
}

// ─── P2/C3 基准 ───

test('W5-6/P2C3: 增量编码 —— K 帧混合负载的补丁/关键帧比与 token 当量缩减（声明 >30%）', async (t) => {
  await withSharp(t, async (s) => {
    const W = 800, H = 600;
    const FULL = estimateVlmTokens(W, H); // 整屏单帧 token（两臂同尺）

    // ── 确定性帧序列（K=20）：微变 13 / 关键帧 3 / 滚动 2 / 静默 2 ──
    const microA = [ // 阶段 A：块世界微变 ×10（单块 64×40 ≈ 0.53% 屏）
      { x: 60, y: 60 }, { x: 200, y: 120 }, { x: 420, y: 80 }, { x: 600, y: 200 },
      { x: 120, y: 300 }, { x: 340, y: 260 }, { x: 520, y: 380 }, { x: 680, y: 440 },
      { x: 240, y: 480 }, { x: 60, y: 500 },
    ];
    const microC = [ // 阶段 C：关键帧重置后微变 ×3
      { x: 400, y: 300 }, { x: 200, y: 420 }, { x: 620, y: 120 },
    ];
    const BLOCK = (p: { x: number; y: number }) => ({ ...p, w: 64, h: 40, v: 255 });
    const vAt = (y: number): number => 30 + ((y * 7) % 200); // 滚动世界纹理

    const ledger = new ScreenStateLedger(); // 生产缺省端口（真 sharp 分析）
    const verdicts: LedgerVerdict[] = [];
    const ingest = async (buf: Buffer): Promise<void> => { verdicts.push(await ledger.ingest(buf)); };
    const patchVerdicts: LedgerVerdict[] = []; // 分诊后回填

    // 1 冷启动关键帧（块世界基线）
    await ingest(await framePng(s, W, H, 100, []));
    // 2-13 微变补丁 ×12（第 8 帧触累计脏 30% 天花板 ⇒ 关键帧重置，设计内）
    for (const p of microA) await ingest(await framePng(s, W, H, 100, [BLOCK(p)]));
    // 14 静默（同帧复投）
    const lastA = await framePng(s, W, H, 100, [BLOCK(microA[9]!)]);
    await ingest(lastA);
    // 15 世界切换关键帧（块世界 → 纹理世界）
    const texBase = await rowTexturePng(s, W, H, vAt);
    await ingest(texBase);
    // 16 滚动：内容下移 40px ⇒ 顶部条带
    await ingest(await rowTexturePng(s, W, H, (y) => (y < 40 ? 250 : vAt(y - 40))));
    // 17 滚动：内容上移回基线 ⇒ 底部条带
    await ingest(texBase);
    // 18 静默
    await ingest(texBase);
    // 19 世界切换关键帧（纹理 → 块世界）
    await ingest(await framePng(s, W, H, 100, []));
    // 20 微变补丁（重置后继续）
    await ingest(await framePng(s, W, H, 100, [BLOCK(microC[0]!)]));

    // ── 计量 ──
    const K = verdicts.length;
    const byKind = (k: LedgerVerdict['kind']): LedgerVerdict[] => verdicts.filter(v => v.kind === k);
    const keyframes = byKind('keyframe');
    patchVerdicts.push(...byKind('patch'));
    const patches = patchVerdicts; // 补丁判决清单（覆盖律断言用）
    const scrolls = byKind('scroll');
    const silents = byKind('silent');
    const baselineTokens = K * FULL;
    const incrementalTotal = verdicts.reduce((sum, v) => sum + incrementalTokens(v, FULL), 0);
    const reduction = 1 - incrementalTotal / baselineTokens;

    console.log([
      `── W5-6/P2C3 增量编码 token 当量（K=${K} 帧混合负载，${W}x${H} 源图原生坐标）──`,
      `分诊: keyframe=${keyframes.length} patch=${patches.length} scroll=${scrolls.length} silent=${silents.length}（patch:keyframe = ${patches.length}:${keyframes.length}）`,
      `全帧基线臂: ${K} × ${FULL} = ${baselineTokens} tok`,
      `增量臂:     keyframe ${keyframes.length}×${FULL} + patch/条带 ${incrementalTotal - keyframes.length * FULL} + silent 0 = ${incrementalTotal} tok`,
      `缩减率 = 1 − ${incrementalTotal}/${baselineTokens} = ${(reduction * 100).toFixed(1)}%（声明 >30% —— GENESIS 无数值声明，锚定任务书下限）`,
    ].join('\n'));

    // ── 断言（声明值 vs 实测值） ──
    assert.equal(K, 18, 'K 帧剧本逐帧对账');
    assert.equal(keyframes.length, 4, '关键帧恰 4（冷启动 + 累计脏天花板 + 世界切换×2）');
    assert.equal(scrolls.length, 2, '滚动判决恰 2（下移/上移）');
    assert.equal(silents.length, 2, '静默判决恰 2');
    assert.equal(patches.length, 10, '微变产补丁（1 帧被累计脏天花板改判关键帧）');
    assert.ok(keyframes.some(kf => /cumulative/.test(kf.reason)), '漂移天花板如实触发并入账');
    assert.ok(patches.length > keyframes.length * 2, 'P 帧经济学：补丁多于关键帧');
    assert.ok(reduction > 0.30, `token 当量缩减应 >30%（实测 ${(reduction * 100).toFixed(1)}%）`);

    // 质量守护（不倒贴）：每个补丁判决至少覆盖一个剧本突变块（覆盖律）
    const allBlocks = [...microA, microC[0]!].map(BLOCK);
    for (let i = 0; i < patchVerdicts.length; i++) {
      const covered = patchVerdicts[i]!.patches.some(p => allBlocks.some(b =>
        p.x <= b.x && p.y <= b.y && p.x + p.w >= b.x + b.w && p.y + p.h >= b.y + b.h));
      assert.ok(covered, `补丁判决 #${i} 应覆盖某剧本突变块（实际 ${JSON.stringify(patchVerdicts[i]!.patches)}）`);
    }
    // 滚动条带 = 全宽 × |dy|（向量 + 条带口径）
    for (const sc of scrolls) {
      assert.ok(sc.scroll, '滚动判决携带向量');
      assert.equal(sc.patches.length, 1, '条带单矩形');
      assert.equal(sc.patches[0]!.w, W, '条带全宽');
      assert.equal(sc.patches[0]!.h, Math.abs(sc.scroll!.dyPx), '条带高 = |dy|');
    }
    // 静默零成本 + 关键帧重置累计脏
    for (const si of silents) assert.equal(incrementalTokens(si, FULL), 0, '静默零 token');
    for (const kf of keyframes) assert.equal(kf.cumulativeDirtyPct, 0, '关键帧重置累计脏');
  });
});
