// test/pan121.visualDiffRegistration.test.ts
// ΠΑΝ-121 执法册：visualDiff 滚动失效缓解 —— 全局位移估计前置（复用
// motionEstimator 相位相关）+ 配准后差分 + 动画场景 diff-unreliable 诚实标注。
//   ① 位移原子：estimateGlobalDisplacement 三闸（相干/增益/幅度）——真平移
//      接住、均匀画面拒配、半屏反色拒配（增益门）；
//   ② computeDiffRegions：滚动帧先配准再差分 —— 条带 + 残余（不再是整屏
//      平移噪声的「变化区域清单」）；
//   ③ 动画/散点刷新：大面积碎片化帧差 ⇒ reliability='diff-unreliable'；
//   ④ 账本软配准分支：严格滚动窗（残差 <0.25 / 纵向 / ≥15%）接不住的真
//      平移帧（残差 0.25..0.5 带 / 水平滚动）判 scroll（向量+条带+残余补丁），
//      不再退化为全屏关键帧；registration 缺席 ⇒ 旧分诊逐字节保持。
// 铁律：sharp 现铸真图（懒 SKIP）+ 注入端口离线确定性，零网络零 fixture。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSharp, type SharpLike } from '../src/_legacyDeps.ts';
import {
  estimateGlobalDisplacement,
  computeDiffRegions,
  ScreenStateLedger,
  type LedgerAnalysis, type DiffRegistration, type DiffRegion,
} from '../src/visualDiff.ts';

// ─── ① 位移原子（纯函数，亮度序列直喂） ───

/** 纵向纹理（行亮度）—— 行移估计的理想输入 */
const vAt = (y: number): number => 30 + ((y * 7) % 200);

test('ΠΑΝ-121: estimateGlobalDisplacement —— 真平移接住（纵向 12 行）', () => {
  const lumA = Array.from({ length: 360 }, (_, y) => vAt(y));
  const lumB = Array.from({ length: 360 }, (_, y) => (y < 12 ? 250 : vAt(y - 12)));
  const cols = new Array<number>(480).fill(100);   // 列亮度均匀（水平无证据）
  const d = estimateGlobalDisplacement(lumA, lumB, cols, cols);
  assert.ok(d, '相干平移应被检出');
  assert.equal(d!.dyRows, 12, `纵向位移 12 行（实测 ${d!.dyRows}）`);
  assert.equal(d!.axis, 'vertical');
  assert.ok(d!.rowResidual < 0.2, `完美平移的残差低（实测 ${d!.rowResidual}）`);
});

test('ΠΑΝ-121: 幅度门 —— 均匀画面（沿轴无差异）不配准', () => {
  const flat = new Array<number>(360).fill(100);
  const d = estimateGlobalDisplacement(flat, flat, flat, flat);
  assert.equal(d, null, '两帧相同 ⇒ 零位移残差 < 幅度门 ⇒ 拒配准（防任意位移伪成立）');
  // 微噪声均匀画面：零位移残差仍低于幅度门下限 ⇒ 拒
  const noisy = Array.from({ length: 360 }, (_, y) => 100 + (y % 2));
  assert.equal(estimateGlobalDisplacement(flat, noisy, flat, flat), null);
});

test('ΠΑΝ-121: 增益门 —— 半屏反色（碰巧一段对得上）不配准', () => {
  // w3-3 大变 fixture 的形状：均匀 100 → 上半 255。±60 搜索窗内最优位移
  // （窗缘）只把残差从 ~0.61 降到 ~0.49 —— 增益 < 40% ⇒ 拒（不伪报滚动）
  const lumA = new Array<number>(360).fill(100);
  const lumB = Array.from({ length: 360 }, (_, y) => (y < 180 ? 255 : 100));
  const cols = new Array<number>(480).fill(100);
  assert.equal(estimateGlobalDisplacement(lumA, lumB, cols, cols), null,
    '整块变化不是平移 —— 增益门拒绝伪配准');
});

test('ΠΑΝ-121: 横向平移接住（列亮度证据）', () => {
  const rows = new Array<number>(360).fill(100);
  const colA = Array.from({ length: 480 }, (_, x) => 40 + ((x * 11) % 180));
  const colB = Array.from({ length: 480 }, (_, x) => (x < 15 ? 220 : colA[x - 15]!));
  const d = estimateGlobalDisplacement(rows, rows, colA, colB);
  assert.ok(d, '横向相干平移应被检出');
  assert.equal(d!.dxCols, 15, `横向位移 15 列（实测 ${d!.dxCols}）`);
  assert.equal(d!.axis, 'horizontal');
});

// ─── ② computeDiffRegions 配准前置（sharp 真图） ───

async function requireSharp(): Promise<SharpLike> { return getSharp(); }
async function withSharp<T>(t: any, fn: (s: SharpLike) => Promise<T>): Promise<T | undefined> {
  let s: SharpLike;
  try { s = await requireSharp(); } catch (e: any) {
    t.skip(`sharp not installed — ${e?.message?.slice(0, 200) ?? ''}`);
    return undefined;
  }
  return fn(s);
}

/** 行纹理 PNG（水平均匀 —— 纵向滚动判定的理想输入；与 w3incremental 同构） */
async function rowTexturePng(
  s: SharpLike, w: number, h: number, vAtY: (y: number) => number,
): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const v = vAtY(y);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      raw[i] = v; raw[i + 1] = v; raw[i + 2] = v;
    }
  }
  return s(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/** 散点块 PNG（动画/散点刷新形态：多个中块分散、无单块 ≥25% 画幅） */
async function scatteredPng(
  s: SharpLike, w: number, h: number, base: number,
  blocks: Array<{ x: number; y: number; w: number; h: number; v: number }>,
): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  raw.fill(base, 0, w * h * 3);
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

test('ΠΑΝ-121: 滚动帧先配准再差分 —— 条带 + 残余，不再是整屏「变化」', async (t) => {
  await withSharp(t, async (s) => {
    const W = 800, H = 600;
    const before = await rowTexturePng(s, W, H, vAt);
    const after = await rowTexturePng(s, W, H, (y) => (y < 40 ? 250 : vAt(y - 40)));
    const r = await computeDiffRegions(before, after);
    assert.ok(r, '差分结果在场');
    // 未配准的原始占比：大面积（滚动路径全动）—— 诚实读数保留
    assert.ok(r!.changed_fraction_pct >= 50, `原始变化占比大面积（实测 ${r!.changed_fraction_pct}%）`);
    // 配准报告：位移 ≈ 24 差分行（40 源行 × 360/600），条带在顶部，残余小
    const reg = r!.registration;
    assert.ok(reg, 'registration 在场（相干平移检出）');
    assert.ok(Math.abs(reg!.displacement.dyRows - 24) <= 2,
      `纵向位移 ≈24 差分行（实测 ${reg!.displacement.dyRows}）`);
    assert.ok(reg!.stripNorm && reg!.stripNorm.y0 === 0 && reg!.stripNorm.y1! <= 0.12,
      `新入内容条带在顶部（实测 ${JSON.stringify(reg!.stripNorm)}）`);
    assert.ok(reg!.registeredChangedPct < 10,
      `配准后残余小（实测 ${reg!.registeredChangedPct}% —— 平移解释了绝大多数「变化」）`);
    // 区域清单 = 条带（+ 少量残余），不是整屏噪声
    assert.ok(r!.regions.length <= 4, `区域数收敛（实测 ${r!.regions.length}）`);
    assert.ok(r!.regions.some(x => x.bbox_normalized.y0 === 0),
      '条带区域在区域清单首位（模型可见「哪里新入了内容」）');
    assert.notEqual(r!.reliability, 'diff-unreliable', '配准解释 ⇒ 可靠');
  });
});

test('ΠΑΝ-121: 动画/散点刷新 —— 大面积碎片化帧差诚实标注 diff-unreliable', async (t) => {
  await withSharp(t, async (s) => {
    const W = 800, H = 800;   // 方形画布：差分网格 16×16，块宽 50px 源像素
    const before = await scatteredPng(s, W, H, 100, []);
    // 6 个分散中块（各 190×320 ≈ 9.5% 画幅，总 ≈57%；行/列间隙 ≥80px
    // （≥1 个差分块）互不连通，无单块 ≥25%，无平移结构 —— 动画/散点刷新形态）
    const blocks = [0, 1, 2, 3, 4, 5].map(i => ({
      x: (i % 3) * 270 + 10, y: Math.floor(i / 3) * 430 + 10, w: 190, h: 320, v: 240,
    }));
    const after = await scatteredPng(s, W, H, 100, blocks);
    const r = await computeDiffRegions(before, after);
    assert.ok(r);
    assert.ok(r!.changed_fraction_pct >= 50, `大面积帧差（实测 ${r!.changed_fraction_pct}%）`);
    assert.ok(r!.regions.length >= 5, `碎片化（实测 ${r!.regions.length} 个区域）`);
    assert.equal(r!.reliability, 'diff-unreliable', '动画形态 ⇒ 诚实标注不可靠');
    assert.ok(r!.reliabilityNote && /animation|video/.test(r!.reliabilityNote!),
      '归因注记在场（消费方可转述）');
    // 对照：单一大块（结构变化形态）不标不可靠
    const structural = await computeDiffRegions(
      before, await scatteredPng(s, W, H, 100, [{ x: 0, y: 0, w: 700, h: 700, v: 240 }]));
    assert.notEqual(structural!.reliability, 'diff-unreliable', '连贯大变是结构变化，不误标');
  });
});

// ─── ④ 账本软配准分支（注入端口 —— 离线确定性） ───

/** 软配准 fixture：残差 0.3（严格滚动窗 0.25 之外、相干门 0.5 之内） */
function softScrollAnalysis(over: Partial<LedgerAnalysis> = {}): LedgerAnalysis {
  const residualRegion: DiffRegion = {
    index: 1,
    bbox_normalized: { x0: 0.4, y0: 0.5, x1: 0.5, y1: 0.6 },
    center: { x: 0.45, y: 0.55 },
    tiles_changed: 4,
  };
  const registration: DiffRegistration = {
    displacement: { dyRows: 18, dxCols: 0, rowResidual: 0.3, colResidual: 1, axis: 'vertical' },
    registeredChangedPct: 2,
    stripNorm: { x0: 0, y0: 0, x1: 1, y1: 0.05 },
  };
  return {
    width: 800, height: 600,
    regions: [residualRegion],
    changedPct: 40,
    identical: false,
    rowShift: { shift: 18, residual: 0.3, bestInteger: 18 },
    diffRows: 360,
    registration,
    ...over,
  };
}

test('ΠΑΝ-121: 账本软配准 —— 残差 0.25..0.5 带的真平移帧判 scroll（旧路径退化关键帧）', async () => {
  const ledger = new ScreenStateLedger({ analyze: async () => softScrollAnalysis() });
  await ledger.ingest(Buffer.from('keyframe-seed'));
  const v = await ledger.ingest(Buffer.from('soft-scroll-frame'));
  assert.equal(v.kind, 'scroll', `软配准分支接住（实测 ${v.kind}: ${v.reason}）`);
  assert.ok(/soft-registered/.test(v.reason), '归因披露软配准');
  const band = v.patches[0]!;
  assert.equal(band.x, 0);
  assert.equal(band.y, 0, '纵向下移 ⇒ 顶部条带');
  assert.equal(band.h, 30, '条带高 = |dyPx| = 18×600/360');
  assert.equal(v.scroll!.dyPx, 30);
  assert.ok(Math.abs(v.scroll!.residual - 0.3) < 1e-9, '残差如实入报告');
  // 残余区域以补丁随行（不丢证据）
  assert.equal(v.patches.length, 2, '条带 + 1 个残余补丁');
});

test('ΠΑΝ-121: 账本软配准 —— 水平滚动（严格滚动窗只认纵向）判 scroll + 左条带', async () => {
  const horizontal = softScrollAnalysis({
    rowShift: { shift: 0.2, residual: 0.9, bestInteger: 0 },
    registration: {
      displacement: { dyRows: 0, dxCols: 15, rowResidual: 0.9, colResidual: 0.2, axis: 'horizontal' },
      registeredChangedPct: 1,
      stripNorm: { x0: 0, y0: 0, x1: 0.04, y1: 1 },
    },
    regions: [],
  });
  const ledger = new ScreenStateLedger({ analyze: async () => horizontal });
  await ledger.ingest(Buffer.from('seed'));
  const v = await ledger.ingest(Buffer.from('h-scroll'));
  assert.equal(v.kind, 'scroll', `水平滚动接住（实测 ${v.kind}: ${v.reason}）`);
  assert.equal(v.scroll!.dxPx, 25, 'dxPx = 15×600/360（行列同尺换算）');
  assert.equal(v.scroll!.dyPx, 0, '水平滚动 dy=0（语义诚实）');
  const band = v.patches[0]!;
  assert.equal(band.x, 0);
  assert.equal(band.w, 25, '内容右移 ⇒ 左侧条带');
});

test('ΠΑΝ-121: 账本兼容 —— registration 缺席 ⇒ 旧分诊逐字节保持（关键帧/大变）', async () => {
  const noReg = softScrollAnalysis({ registration: undefined });
  const ledger = new ScreenStateLedger({ analyze: async () => noReg });
  await ledger.ingest(Buffer.from('seed'));
  const v = await ledger.ingest(Buffer.from('big-dirty'));
  assert.equal(v.kind, 'keyframe', `无配准报告 ⇒ 旧大变分诊（实测 ${v.kind}）`);
  assert.ok(/too big to patch/.test(v.reason));
  assert.notEqual(v.reliability, 'diff-unreliable', '单区域不触发弥散标注');
});

test('ΠΑΝ-121: 账本软配准 —— 配准后残余过大（≥patchDirtyPct）⇒ 不硬套滚动', async () => {
  const bigResidual = softScrollAnalysis({
    registration: {
      ...softScrollAnalysis().registration!,
      registeredChangedPct: 20,   // 平移解释不掉 20% ⇒ 不是滚动，走旧分诊
    },
  });
  const ledger = new ScreenStateLedger({ analyze: async () => bigResidual });
  await ledger.ingest(Buffer.from('seed'));
  const v = await ledger.ingest(Buffer.from('mixed'));
  assert.equal(v.kind, 'keyframe', '滚动+大改 ⇒ 关键帧（软分支不越权）');
  assert.ok(/too big to patch/.test(v.reason));
});

test('ΠΑΝ-121: 账本 diff-unreliable —— 弥散大变的注记（关键帧动作照旧）', async () => {
  const diffuse: LedgerAnalysis = {
    width: 800, height: 600,
    changedPct: 80,
    identical: false,
    rowShift: { shift: 0, residual: 1, bestInteger: 0 },
    diffRows: 360,
    registration: null,
    regions: [1, 2, 3, 4, 5, 6].map(i => ({
      index: i,
      bbox_normalized: { x0: (i % 3) * 0.33, y0: Math.floor(i / 3) * 0.5, x1: (i % 3) * 0.33 + 0.1, y1: Math.floor(i / 3) * 0.5 + 0.1 },
      center: { x: (i % 3) * 0.33 + 0.05, y: Math.floor(i / 3) * 0.5 + 0.05 },
      tiles_changed: 3,
    })),
  };
  const ledger = new ScreenStateLedger({ analyze: async () => diffuse });
  await ledger.ingest(Buffer.from('seed'));
  const v = await ledger.ingest(Buffer.from('animation'));
  assert.equal(v.kind, 'keyframe', '动作面不变：全帧重置仍正确');
  assert.equal(v.reliability, 'diff-unreliable', '注记面：区域证据不可靠如实申报');
  assert.ok(/diff-unreliable/.test(v.reason), 'reason 携带注记（可观测）');
});
