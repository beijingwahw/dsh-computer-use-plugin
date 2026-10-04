// test/w7fuzz.test.ts
// W7-5 确定性模糊测试：种子化属性攻击六纪元器官的核心不变量。
//
// 设计律（世界级标准）：
//   * 确定性 —— 自建 seeded RNG（mulberry32 同族实现，测试自持零依赖），
//     每个属性跑固定 seed 集 × 批量样本；失败样本的 seed/序号打进断言消息，
//     任何失败都可离线重放（「seed 报告」）。
//   * 发现即修或登记 —— 本文件无源码修复权；真缺陷如实 fail + 报告登记
//     （模块/不变量/最小重放输入），绝不为了绿而缩小攻击面。
//   * 攻击面 —— 六类属性：
//       ① 坐标：codec inset 反算往返误差界（合成契约 + 真编码端到端两路）、
//          som/patch 三系换算往返；
//       ② 守恒：VlmBudget 记账/回收、requote 记账一致性、步数拍卖配额和、
//          审批令牌桶不超发、estimateVlmTokens 单调；
//       ③ 确定性：EXP4 同 seed 采样序列、derivePcgScene 字节级一致、
//          gym 任务/课程采样与帧合成确定、oscillation 判决确定；
//       ④ 状态机：goalState 七相模型对照、barrier 序号单调+两阶段不可回退、
//          escrow 铸造→在途→结算/补偿无死态；
//       ⑤ 隔离（安全关键）：AGENT_NOTE/AUDIT_PRE marker 任意注入序列下
//          绝不进 ACTION_TOOLS 重放面；journal 哈希链任意 append/崩溃/篡改
//          序列下 verify 定位准确；
//       ⑥ 鲁棒性：纯函数入口喂垃圾（NaN/±∞/负长/空数组/超长串/循环引用）
//          绝不抛。硬断言只覆盖**文档声明「绝不抛」**的入口；无声明域的
//          入口（如 markerCentroid 明文「输入合法性归调用方」）走 probe 面：
//          照常攻击、异常登记进 PROBE_FINDINGS（测试末尾汇总打印 + 报告），
//          不缩小攻击面也不冒充缺陷。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_TOOLS, journal, lempelZivComplexity, normalizedActionComplexity,
} from '../src/journal.ts';
import {
  encodeForVlmMeta, estimateVlmTokens, mapEncodedToOriginal, mapInsetToOriginal,
  gazeRouter, cleanPatchRect, patchRectToNormalized, normalizedToPatchRect,
  patchRectToEncoded, encodedPatchRectToSource, patchAnchorText, VlmBudget,
  type EncodedImageMeta, type PatchRect,
} from '../src/vlm/codec.ts';
import {
  selectSparseMarkers, routeLabelPlacement, stableColor, somColorKey, taskRelevance,
} from '../src/vlm/som.layout.ts';
import { buildGroundingUserPrompt, markerCentroid } from '../src/vlm/som.ts';
import { lengthBucket, sanitizeActionShape, TokenBucket } from '../src/approval.ts';
import { allocateQuotas, marginalProgressScore } from '../src/subAgent.ts';
import { GoalStateMachine, type GoalSpec, type GoalPhase } from '../src/autonomy/goalState.ts';
import { createBarrierCore, parseBarrierStep } from '../src/crossMachine.ts';
import {
  reversalEscrow, builtinCompensationSemantics, compensationPathOf,
} from '../src/reversalEscrow.ts';
import {
  derivePcgScene, generateTasks, sampleCurriculumWorld, PcgWorld,
} from '../src/autonomy/gym.ts';
import { EvolutionEngine } from '../src/autonomy/evolutionEngine.ts';
import {
  contextFeatureVector, shouldDistillSkill, failureSignature, applyRun, armDistribution,
} from '../src/autonomy/evolutionPrimitives.ts';
import { oscillationTracker } from '../src/oscillationTracker.ts';
import { getSharp } from '../src/_legacyDeps.ts';

// ─── 确定性 fuzz 骨架（seeded RNG + 属性执行器） ───────────────────────

/** 固定 seed 集：全部属性共用（可重放报告的锚点） */
const SEEDS = [1, 7, 42, 1337, 0xc0ffee, 987_654_321, 271_828_182, 2_026_100_3] as const;

/** 测试自持 mulberry32（与 src 实现语义同源但零依赖 —— 测试独立性铁律） */
function testRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly r: () => number;
  readonly seed: number;
  constructor(seed: number) { this.seed = seed >>> 0; this.r = testRng(seed); }
  next(): number { return this.r(); }
  int(min: number, max: number): number { return min + Math.floor(this.r() * (max - min + 1)); }
  float(min: number, max: number): number { return min + this.r() * (max - min); }
  bool(p = 0.5): boolean { return this.r() < p; }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.r() * arr.length)]!; }
}

type PropFn = (rng: Rng, i: number) => void | Promise<void>;

/**
 * 属性执行器：固定 seed 集 × 每种子若干样本；断言失败消息前置 [seed=… sample=…]
 * —— 失败样本可重放。sample 计数跨 seed 累计（总量恒 ≥ total）。
 */
function prop(name: string, total: number, fn: PropFn): void {
  test(`fuzz: ${name}（${SEEDS.length} seed × 样本 ≥${total}）`, async () => {
    const perSeed = Math.ceil(total / SEEDS.length);
    let n = 0;
    for (const seed of SEEDS) {
      const rng = new Rng(seed);
      for (let i = 0; i < perSeed; i++, n++) {
        try {
          await fn(rng, n);
        } catch (e) {
          const err = e as Error;
          err.message = `[seed=${seed} sample#${i} replay=new Rng(${seed})] ${err.message}`;
          throw err;
        }
      }
    }
    assert.ok(n >= total, `样本量不足: ${n} < ${total}`);
  });
}

// ─── 垃圾值生成器（鲁棒性攻击的弹药库） ─────────────────────────────

const GARBAGE_NUMBERS: unknown[] = [
  0, -0, 1, -1, 0.5, NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
  1e308, -1e308, 2 ** 53, -(2 ** 53), 1e-308, 2000, -2000, 750,
];

function garbageScalar(rng: Rng): unknown {
  return rng.pick([
    ...GARBAGE_NUMBERS,
    '', 'x', 'barrier:foo#3', 'A'.repeat(4096), null, undefined, true, false,
    {}, [], () => 1, Symbol('s'), 123n,
  ]);
}

function garbageDeep(rng: Rng, depth = 0): unknown {
  const roll = rng.int(0, 7);
  if (depth > 2 || roll <= 2) return garbageScalar(rng);
  if (roll === 3) return [garbageDeep(rng, depth + 1), garbageDeep(rng, depth + 1)];
  if (roll === 4) return { x: garbageDeep(rng, depth + 1), y: garbageDeep(rng, depth + 1) };
  if (roll === 5) return { width: garbageDeep(rng, depth + 1), height: garbageDeep(rng, depth + 1) };
  if (roll === 6) {
    const o: Record<string, unknown> = {};
    for (const k of ['x0', 'y0', 'x1', 'y1', 'w', 'h', 'left', 'top', 'bytes', 'confidence', 'relevance']) {
      if (rng.bool(0.4)) o[k] = garbageDeep(rng, depth + 1);
    }
    return o;
  }
  // 循环引用（JSON.stringify 抛出的经典向量）
  const cyc: Record<string, unknown> = { self: null };
  cyc.self = cyc;
  return cyc;
}

/** 测试侧安全字符串化：绝不因 Symbol/循环引用在**生成器里**先炸（被测面才该被攻击） */
function safeStr(v: unknown): string {
  try {
    if (typeof v === 'symbol') return v.toString();
    return String(v);
  } catch {
    return '<unstringable>';
  }
}

/** JSON 安全垃圾（journal 哈希链等以 JSON 为规范形的入口专用——BigInt/Symbol/
 * 循环引用是序列化器域外向量，不是这些入口的攻击面） */
function jsonSafeGarbage(rng: Rng): unknown {
  return rng.pick([
    0, -1, 0.5, NaN, Number.POSITIVE_INFINITY, 750, 1e308,
    '', 'x', 'AGENT_NOTE', 'A'.repeat(500), null, true, false, {}, { a: 1 }, [1, 'b'],
  ]);
}

/** 绝不抛断言：fn 的任何抛出都是失败（文档声明「绝不抛」的入口专用） */
function mustNotThrow(label: string, f: () => unknown): void {
  try {
    f();
  } catch (e) {
    assert.fail(`${label} 对垃圾输入抛出: ${(e as Error).message}`);
  }
}

/** 无声明域的探测面：照常攻击，异常登记（不冒充缺陷、不缩小攻击面） */
const PROBE_FINDINGS: Array<{ fn: string; input: string; err: string }> = [];
function probe(label: string, input: string, f: () => unknown): void {
  try {
    f();
  } catch (e) {
    PROBE_FINDINGS.push({ fn: label, input, err: (e as Error).message.slice(0, 140) });
  }
}

// ═══════════════════════════════════════════════════════════════════
// ① 坐标不变量
// ═══════════════════════════════════════════════════════════════════

/**
 * 按 encodeForVlm/applyInsetFoveation 的构造律（契约注释的逐式镜像）合成
 * inset 编码元信息。返回 null = 该组合结构性降级（凹窗放不进缩图 ⇒ blur
 * 路径，无 inset 契约可检）。
 */
function buildInsetCase(rng: Rng): {
  meta: EncodedImageMeta;
  crop: { left: number; top: number; width: number; height: number } | null;
  tw: number; th: number; downW: number; downH: number; edge: number; scale: number;
  fx: number; fy: number; ix: number; iy: number;
} | null {
  const srcW = rng.int(80, 1600);
  const srcH = rng.int(80, 1600);
  let crop: { left: number; top: number; width: number; height: number } | null = null;
  if (rng.bool(0.4)) {
    const left = rng.int(0, Math.max(0, srcW - 20));
    const top = rng.int(0, Math.max(0, srcH - 20));
    crop = { left, top, width: rng.int(20, srcW - left), height: rng.int(20, srcH - top) };
  }
  const srcCw = crop ? crop.width : srcW;
  const srcCh = crop ? crop.height : srcH;
  const maxDim = rng.pick([512, 768, 1024, 1280, 1568, 2048]);
  let tw = srcCw;
  let th = srcCh;
  const longEdge = Math.max(srcCw, srcCh);
  if (longEdge > maxDim) {
    tw = srcCw >= srcCh ? maxDim : Math.max(1, Math.round((srcCw * maxDim) / longEdge));
    th = srcCh > srcCw ? maxDim : Math.max(1, Math.round((srcCh * maxDim) / longEdge));
  }
  const foveaSize = rng.float(0.05, 1);
  const rawScale = rng.pick([1.2, 1.5, 2, 2.5, 3, 4, 6, 8]);
  const scale = Math.min(4, Math.max(1, rawScale)); // INSET_SCALE_MAX=4 夹取
  if (!(scale > 1)) return null;
  const minEdge = Math.min(tw, th);
  const edge = Math.min(Math.max(1, Math.round(foveaSize * minEdge)), minEdge);
  const downW = Math.max(1, Math.round(tw / scale));
  const downH = Math.max(1, Math.round(th / scale));
  if (edge > downW || edge > downH) return null; // 结构性降级 → blur
  // W1-9 注视中心：源图归一化 → 裁剪窗 clamp → 编码画布像素
  let gx: number | undefined;
  let gy: number | undefined;
  if (rng.bool(0.6)) {
    const cx = rng.float(0, 1);
    const cy = rng.float(0, 1);
    const cu = crop ? Math.min(1, Math.max(0, (cx * srcW - crop.left) / crop.width)) : cx;
    const cv = crop ? Math.min(1, Math.max(0, (cy * srcH - crop.top) / crop.height)) : cy;
    gx = cu * tw;
    gy = cv * th;
  }
  const fx = gx !== undefined
    ? Math.min(Math.max(0, Math.floor(gx - edge / 2)), tw - edge)
    : Math.floor((tw - edge) / 2);
  const fy = gy !== undefined
    ? Math.min(Math.max(0, Math.floor(gy - edge / 2)), th - edge)
    : Math.floor((th - edge) / 2);
  const ix = gx !== undefined
    ? Math.min(Math.max(0, Math.floor((gx * downW) / tw - edge / 2)), downW - edge)
    : Math.floor((downW - edge) / 2);
  const iy = gy !== undefined
    ? Math.min(Math.max(0, Math.floor((gy * downH) / th - edge / 2)), downH - edge)
    : Math.floor((downH - edge) / 2);
  const meta: EncodedImageMeta = {
    base64: '', mime: 'image/jpeg',
    width: downW, height: downH, bytes: 1, strategy: '+inset',
    sourceWidth: srcW, sourceHeight: srcH,
    foveated: true, cropRect: crop, foveaMode: 'inset',
    insetRect: { x: ix, y: iy, w: edge, h: edge },
    insetScale: scale,
    insetNative: { width: tw, height: th },
    insetExtract: { x: fx, y: fy },
    foveaCenter: gx !== undefined ? { x: 0.5, y: 0.5 } : undefined,
  };
  return { meta, crop, tw, th, downW, downH, edge, scale, fx, fy, ix, iy };
}

prop('坐标①-A mapInsetToOriginal 合成契约往返：窗内 0.5r+0.5、窗外 0.5·crop/down+0.5（分支一致时）', 400, (rng) => {
  const c = buildInsetCase(rng);
  if (!c) return;
  const { meta, crop, tw, th, downW, downH, edge, scale, fx, fy, ix, iy } = c;
  const cropW = crop ? crop.width : meta.sourceWidth;
  const cropH = crop ? crop.height : meta.sourceHeight;
  const offX = crop ? crop.left : 0;
  const offY = crop ? crop.top : 0;
  // 正算：随机源像素（裁剪窗内）→ 期望编码像素（构造律的分段正映射）
  const sx = offX + rng.float(0, Math.max(0, cropW - 1));
  const sy = offY + rng.float(0, Math.max(0, cropH - 1));
  const ex = (sx - offX) * (tw / cropW);
  const ey = (sy - offY) * (th / cropH);
  const inWindow = ex >= fx && ex < fx + edge && ey >= fy && ey < fy + edge;
  const tx = inWindow ? ix + (ex - fx) : ex * (downW / tw);
  const ty = inWindow ? iy + (ey - fy) : ey * (downH / th);
  const txI = Math.min(downW - 1, Math.max(0, Math.round(tx)));
  const tyI = Math.min(downH - 1, Math.max(0, Math.round(ty)));
  const p = mapInsetToOriginal(txI, tyI, meta);
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `反算产出非有限坐标 ${JSON.stringify(p)}`);
  assert.ok(p.x >= 0 && p.x <= meta.sourceWidth && p.y >= 0 && p.y <= meta.sourceHeight,
    `反算越出源图画布 p=${JSON.stringify(p)} src=${meta.sourceWidth}x${meta.sourceHeight}`);
  // 反算分支由**整数像素**对窗矩形判定；正算分类由**连续点**对原生窗判定。
  // 两判不一致 ⇒ 或被放大窗遮挡（模型判窗外但像素落窗内——该源点在合成图中
  // 根本不可见），或窗沿 ±0.5px 取整翻转（分段不连续的天然代价，codec.ts
  // 契约注文明示）——两者都无往返语义，只验有限 + 图内，不强设误差界。
  const pxInRect = txI >= ix && txI < ix + edge && tyI >= iy && tyI < iy + edge;
  if (pxInRect !== inWindow) return;
  const errX = Math.abs(p.x - sx);
  const errY = Math.abs(p.y - sy);
  // r = 裁剪窗→原生画布的中间降采样比（无降采样时 =1）
  const rX = cropW / tw;
  const rY = cropH / th;
  if (inWindow) {
    // 窗内 1:1 原生密度：正算 ±0.5 原生 px ⇒ ±(0.5r+0.5) 源 px；r=1 时 ≤1px
    assert.ok(errX <= 0.5 * rX + 0.5 + 1e-9 && errY <= 0.5 * rY + 0.5 + 1e-9,
      `窗内往返超诚实界 err=(${errX},${errY}) bound=(${0.5 * rX + 0.5},${0.5 * rY + 0.5}) scale=${scale} edge=${edge} src=(${sx.toFixed(1)},${sy.toFixed(1)}) enc=(${txI},${tyI}) meta=${JSON.stringify({ tw, th, downW, downH, fx, fy, ix, iy, crop })}`);
    if (rX === 1 && rY === 1) {
      assert.ok(errX <= 2 && errY <= 2, `r=1 窗内往返超任务书 2px 界 err=(${errX},${errY})`);
    }
  } else {
    // 窗外等比：正算 ±0.5 缩图 px ⇒ ±(0.5·crop/down+0.5) 源 px；
    // r=1 时该界 ≤ 0.5·实际scale+0.5，落在文档声明 scale+1 界内
    const boundX = 0.5 * (cropW / downW) + 0.5 + 1e-9;
    const boundY = 0.5 * (cropH / downH) + 0.5 + 1e-9;
    assert.ok(errX <= boundX && errY <= boundY,
      `窗外往返超诚实界 err=(${errX},${errY}) bound=(${boundX},${boundY}) scale=${scale}`);
    if (rX === 1 && rY === 1) {
      assert.ok(errX <= scale + 1 && errY <= scale + 1, `r=1 窗外往返超文档 scale+1 界 err=(${errX},${errY}) scale=${scale}`);
    }
  }
});

// 真编码端到端（sharp 在场时）：构造律与实际 meta 一致 + 窗内往返 ≤2px
prop('坐标①-B encodeForVlmMeta 真编码 inset 契约 + 窗内往返 ≤2px（sharp 端到端）', 40, async (rng, i) => {
  const s = await (async () => {
    try { return await getSharp(); } catch { return null; }
  })();
  if (!s) {
    if (i === 0) console.log('  [w7fuzz] sharp 不可用 — 真编码端到端路跳过（合成契约路已覆盖）');
    return;
  }
  const W = rng.int(200, 700);
  const H = rng.int(200, 700);
  const raw = Buffer.alloc(W * H * 3);
  for (let k = 0; k < raw.length; k++) raw[k] = (k * 31) & 0xff;
  const png = await s(raw, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  let region: { x0: number; y0: number; x1: number; y1: number } | undefined;
  if (rng.bool(0.4)) {
    const x0 = rng.int(0, W - 40);
    const y0 = rng.int(0, H - 40);
    region = { x0, y0, x1: rng.int(x0 + 20, W), y1: rng.int(y0 + 20, H) };
  }
  const enc = await encodeForVlmMeta(png, {
    maxDimension: rng.pick([512, 768, 1024]),
    quality: 80,
    foveated: true,
    foveaMode: 'inset',
    foveaSize: rng.float(0.1, 0.9),
    foveaPeripheryScale: rng.pick([2, 3, 4]),
    ...(rng.bool(0.6) ? { foveaCenter: { x: rng.float(0, 1), y: rng.float(0, 1) } } : {}),
    ...(region ? { region } : {}),
  });
  assert.equal(enc.ok, true, `真编码失败: ${enc.error}`);
  if (!enc.ok || !enc.value) return;
  const v = enc.value;
  if (v.foveaMode !== 'inset' || !v.insetRect || !v.insetNative || !v.insetScale || !v.insetExtract) {
    return; // 结构性降级（blur/均质）路径无 inset 契约
  }
  // 契约自检：输出维度 = round(native/scale)，随行元信息齐全且不越界
  assert.equal(v.width, Math.max(1, Math.round(v.insetNative.width / v.insetScale)), '缩图宽 ≠ round(native/scale) —— 构造律破坏');
  assert.equal(v.height, Math.max(1, Math.round(v.insetNative.height / v.insetScale)), '缩图高 ≠ round(native/scale) —— 构造律破坏');
  assert.ok(v.insetRect.x + v.insetRect.w <= v.width && v.insetRect.y + v.insetRect.h <= v.height,
    'insetRect 越出缩图');
  assert.ok(v.insetExtract.x + v.insetRect.w <= v.insetNative.width
    && v.insetExtract.y + v.insetRect.h <= v.insetNative.height, 'insetExtract 越出原生画布');
  // 窗内往返：随机缩图像素（窗内）→ 反算源图，与构造律正算的期望源点比对 ≤2px
  const crop = v.cropRect;
  const midW = crop ? crop.width : v.sourceWidth;
  const midH = crop ? crop.height : v.sourceHeight;
  const offX = crop ? crop.left : 0;
  const offY = crop ? crop.top : 0;
  for (let k = 0; k < 5; k++) {
    const txI = v.insetRect.x + rng.int(0, v.insetRect.w - 1);
    const tyI = v.insetRect.y + rng.int(0, v.insetRect.h - 1);
    const p = mapInsetToOriginal(txI, tyI, v);
    const exX = v.insetExtract.x + (txI - v.insetRect.x);
    const exY = v.insetExtract.y + (tyI - v.insetRect.y);
    const expX = Math.min(v.sourceWidth, Math.max(0, Math.round(exX * (midW / v.insetNative.width)) + offX));
    const expY = Math.min(v.sourceHeight, Math.max(0, Math.round(exY * (midH / v.insetNative.height)) + offY));
    assert.ok(Math.abs(p.x - expX) <= 2 && Math.abs(p.y - expY) <= 2,
      `真编码窗内往返超界 got=(${p.x},${p.y}) want=(${expX},${expY})`);
  }
});

prop('坐标①-C mapEncodedToOriginal 等比反算：往返 ≤0.5·(enc/orig)+0.5（逐轴）+ clamp 图内 + 脏维度回 {0,0}', 300, (rng) => {
  const encW = rng.int(1, 2000);
  const encH = rng.int(1, 2000);
  const origW = rng.int(1, 3000);
  const origH = rng.int(1, 3000);
  const px = rng.int(0, encW - 1);
  const py = rng.int(0, encH - 1);
  const p = mapEncodedToOriginal(px, py, encW, encH, origW, origH);
  assert.ok(p.x >= 0 && p.x <= origW && p.y >= 0 && p.y <= origH, '反算越界');
  const back = mapEncodedToOriginal(p.x, p.y, origW, origH, encW, encH);
  // 诚实界（两段 round 的数学上界，逐轴独立）：正向取整 ±0.5 orig px 经逆向
  // 比例放大 ±0.5·(enc/orig) + 逆向自身取整 ±0.5。维度相等时往返恒等（0px）。
  const bX = 0.5 * (encW / origW) + 0.5 + 1e-9;
  const bY = 0.5 * (encH / origH) + 0.5 + 1e-9;
  assert.ok(Math.abs(back.x - px) <= bX && Math.abs(back.y - py) <= bY,
    `等比往返超诚实界 got=(${back.x},${back.y}) want=(${px},${py}) bound=(${bX},${bY}) dims=${encW}x${encH}->${origW}x${origH}`);
  if (encW === origW && encH === origH) {
    assert.equal(back.x, px);
    assert.equal(back.y, py);
  }
  const dirty = mapEncodedToOriginal(NaN, Infinity, 0, -5, NaN, 'x' as unknown as number);
  assert.deepEqual(dirty, { x: 0, y: 0 }, '脏维度未回 {0,0}');
});

// 【已修复·W7 集成】原登记真缺陷 D1:W3-3 文档声明「源图→编码→源图:逐边 ≤1px」
// 不成立(编码系 1px 量化残差映射回源图系被缩放比放大,纵横比失配/强降采样时远超
// 1px;最小重放 seed=1#6 Δx=3)。处置:codec.ts 文档界改正为 0.5·(源边/编码边)+0.5,
// 本 oracle 按诚实界执法(x/y 单边界、w/h 双边和界)——守护回归而非删除断言。
prop('坐标①-D som/patch 三系换算：归一化恒等往返 + 编码系往返逐边误差界', 300, (rng) => {
  const srcW = rng.int(1, 3000);
  const srcH = rng.int(1, 3000);
  const encW = rng.int(1, 3000);
  const encH = rng.int(1, 3000);
  const x = rng.int(0, srcW - 1);
  const y = rng.int(0, srcH - 1);
  const w = rng.int(1, srcW - x);
  const h = rng.int(1, srcH - y);
  const rect: PatchRect = { x, y, w, h };
  // 源 → 归一化 → 源：恒等往返（docstring 声明 0px）
  const norm = patchRectToNormalized(rect, srcW, srcH);
  const back = normalizedToPatchRect(norm, srcW, srcH);
  assert.deepEqual(back, rect, `归一化往返非恒等 got=${JSON.stringify(back)} want=${JSON.stringify(rect)}`);
  // 源 → 编码 → 源：构造性诚实界 max(1,⌈源边/编码边⌉)+1（含窄补丁塌缩效应;W7 审计改正后的文档契约）
  const enc = patchRectToEncoded(rect, srcW, srcH, encW, encH);
  assert.ok(enc.w >= 1 && enc.h >= 1, '补丁在编码系消失（w/h ≥1 破坏）');
  const rt = encodedPatchRectToSource(enc, encW, encH, srcW, srcH);
  const bx = Math.max(1, Math.ceil(srcW / encW)) + 1; // x 轴单边界
  const by = Math.max(1, Math.ceil(srcH / encH)) + 1; // y 轴单边界
  assert.ok(Math.abs(rt.x - rect.x) <= bx + 1e-9, `编码系往返 x 超诚实界 Δ=${Math.abs(rt.x - rect.x)} 界=${bx} rect=${JSON.stringify(rect)} dims=${srcW}x${srcH}<->${encW}x${encH}`);
  assert.ok(Math.abs(rt.y - rect.y) <= by + 1e-9, `编码系往返 y 超诚实界 Δ=${Math.abs(rt.y - rect.y)} 界=${by}`);
  assert.ok(Math.abs(rt.w - rect.w) <= 2 * bx + 1e-9, `编码系往返 w 超双边和界 Δ=${Math.abs(rt.w - rect.w)} 界=${2 * bx} rect=${JSON.stringify(rect)} enc=${JSON.stringify(enc)} dims=${srcW}x${srcH}<->${encW}x${encH}`);
  assert.ok(Math.abs(rt.h - rect.h) <= 2 * by + 1e-9, `编码系往返 h 超双边和界 Δ=${Math.abs(rt.h - rect.h)} 界=${2 * by}`);
  const anchor = patchAnchorText(garbageDeep(rng) as PatchRect, { width: srcW, height: srcH }, { width: encW, height: encH });
  assert.equal(typeof anchor, 'string');
});

// ═══════════════════════════════════════════════════════════════════
// ② 守恒不变量
// ═══════════════════════════════════════════════════════════════════

prop('守恒②-A VlmBudget check/commit：纪律消费下账面永不越限，越限必给 reason', 250, (rng) => {
  const maxImages = rng.int(0, 12);
  const maxBytes = rng.int(0, 500_000);
  const budget = new VlmBudget({ maxImagesPerTask: maxImages, maxBytesPerTask: maxBytes });
  for (let step = 0; step < 40; step++) {
    const bytes = rng.pick([0, 1, rng.int(1, 120_000), rng.int(1, 120_000), NaN, -5, Number.POSITIVE_INFINITY]);
    const chk = budget.check({ bytes });
    const s = budget.summary();
    assert.ok(s.usedImages <= maxImages, `张数账越限 ${s.usedImages}>${maxImages}`);
    assert.ok(s.usedBytes <= maxBytes, `字节账越限 ${s.usedBytes}>${maxBytes}`);
    if (!chk.allowed) {
      assert.ok(typeof chk.reason === 'string' && chk.reason.includes('quota exceeded'),
        `拒绝无理由: ${JSON.stringify(chk)}`);
      continue; // 纪律：不允许就不 commit
    }
    budget.commit({ bytes });
    const s2 = budget.summary();
    assert.ok(s2.usedImages <= maxImages && s2.usedBytes <= maxBytes,
      `commit 后越限 images=${s2.usedImages}/${maxImages} bytes=${s2.usedBytes}/${maxBytes} step=${step}`);
  }
  budget.reset();
  const s3 = budget.summary();
  assert.equal(s3.usedImages, 0);
  assert.equal(s3.usedBytes, 0);
});

prop('守恒②-B requote 记账一致性：estTokensPerImage ≡ estimateVlmTokens(生效档)；档位只降不升', 250, (rng) => {
  const budget = new VlmBudget({
    maxImagesPerTask: rng.int(0, 50),
    maxBytesPerTask: rng.int(1000, 50_000_000),
  });
  for (let k = 0; k < rng.int(1, 8); k++) {
    budget.commit({ bytes: rng.pick([rng.int(1, 400_000), NaN, -1, Number.POSITIVE_INFINITY]) });
  }
  const steps = rng.pick([NaN, 0, -3, 0.5, 1, 2.9, 7, 100, Number.POSITIVE_INFINITY]);
  const rawQ = rng.pick([60, 75, 80, 95, 100, NaN, 0, 200]);
  const rawD = rng.pick([512, 1024, 1568, 4096, NaN, 0, 1e9]);
  const r = budget.requote(steps, {
    current: { quality: rawQ, maxDimension: rawD },
    debounceN: rng.pick([1, 2, 3, 7, NaN, 0]),
    bytesPerImage: rng.pick([1000, 300_000, NaN, -1, Number.POSITIVE_INFINITY]),
  });
  // 记账一致性（任务面）：token 反馈尺与 estimateVlmTokens 逐字节一致
  const expectTokens = estimateVlmTokens(r.maxDimension, Math.max(1, Math.round(r.maxDimension * (9 / 16))));
  assert.equal(r.estTokensPerImage, expectTokens,
    `estTokensPerImage=${r.estTokensPerImage} ≠ estimateVlmTokens=${expectTokens} @dim=${r.maxDimension}`);
  // 基线档镜像（requote 的同款体检律）：合法回声 round，非法回缺省
  const curQ = typeof rawQ === 'number' && Number.isFinite(rawQ) && rawQ >= 1 && rawQ <= 100 ? Math.round(rawQ) : 80;
  const curD = typeof rawD === 'number' && Number.isFinite(rawD) && rawD >= 1 ? Math.round(rawD) : 1568;
  assert.ok(r.quality <= curQ, `质量只降不升破坏: ${r.quality} > ${curQ}`);
  assert.ok(r.maxDimension <= curD, `长边只降不升破坏: ${r.maxDimension} > ${curD}`);
  assert.ok(['original', 'economy', 'deep'].includes(r.tier), `非法档位 ${r.tier}`);
  assert.ok(['original', 'economy', 'deep'].includes(r.rawTier), `非法原始档 ${r.rawTier}`);
  assert.ok(Number.isFinite(r.perStepBytes) || r.perStepBytes === Number.POSITIVE_INFINITY, 'perStepBytes 非数');
  assert.ok(Number.isFinite(r.perStepImages) || r.perStepImages === Number.POSITIVE_INFINITY, 'perStepImages 非数');
  if (!(typeof steps === 'number' && Number.isFinite(steps) && steps >= 1)) {
    assert.equal(r.tier, 'original', '步数不可用必须维持生效档');
    assert.equal(r.perStepBytes, Number.POSITIVE_INFINITY, '步数不可用必须无界额度');
  }
});

prop('守恒②-C allocateQuotas 最大余数法：配额和 ≡ 池发放额（整数执法）+ 饿死防护 + 确定性', 300, (rng) => {
  const n = rng.int(0, 12);
  const bids = Array.from({ length: n }, () => rng.pick([0, 0.001, rng.float(0, 1), 1, NaN, -0.5, Number.POSITIVE_INFINITY]));
  const total = rng.pick([0, 1, rng.int(0, 60), 10 ** 9, NaN, -4, 3.7, Number.POSITIVE_INFINITY]);
  const out = allocateQuotas(bids, total);
  assert.equal(out.length, n, '配额长度 ≠ 代理数');
  const T = typeof total === 'number' && Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const sum = out.reduce((s, q) => s + q, 0);
  // n=0（无竞拍者）：无处可发 ⇒ 和恒 0（池发放额守恒只在 n≥1 时定义）
  assert.equal(sum, n === 0 ? 0 : T, `配额和 ${sum} ≠ 池发放额 ${n === 0 ? 0 : T} bids=${safeStr(bids)}`);
  assert.ok(out.every(q => Number.isInteger(q) && q >= 0), `配额非正整数 ${JSON.stringify(out)}`);
  if (T >= n && n > 0) {
    assert.ok(out.every(q => q >= 1), `饿死防护破坏（T=${T} ≥ n=${n} 但有 0 配额）${JSON.stringify(out)}`);
  }
  assert.deepEqual(allocateQuotas(bids, total), out, '分配不确定（同输入异输出）');
});

prop('守恒②-D TokenBucket 容量不超发：任意时间线（含非单调时钟）上的发放 ≤ 初装 + 整周期回填', 250, (rng) => {
  const capacity = rng.int(1, 5);
  const interval = rng.pick([10, 50, 1000]);
  const t0 = 100_000;
  let t = t0;
  let maxT = t0; // 回填只随前进时间累积——记账基准取时间线已见最大值
  let grants = 0;
  const bucket = new TokenBucket(capacity, interval, undefined, () => t);
  const initial = bucket.available();
  assert.ok(initial <= capacity, `初装 ${initial} > 容量 ${capacity}`);
  for (let k = 0; k < 60; k++) {
    t += rng.pick([-20, 0, 1, interval - 1, interval, interval + 1, rng.int(0, interval * 3)]);
    maxT = Math.max(maxT, t);
    const r = bucket.tryTake();
    if (r.ok) grants++;
    else assert.ok(r.retryInMs > 0, `冷静期非正 ${r.retryInMs}`);
    const av = bucket.available();
    assert.ok(av >= 0 && av <= capacity, `余量越界 ${av} ∉ [0,${capacity}]`);
    const accrued = Math.max(0, Math.floor((maxT - t0) / interval));
    assert.ok(grants <= initial + accrued,
      `超发 grants=${grants} > 初装${initial}+回填${accrued} (cap=${capacity} R=${interval} t=${t} maxT=${maxT})`);
  }
});

prop('守恒②-E estimateVlmTokens 单调不减 + 封顶律', 220, (rng) => {
  const w = rng.int(1, 4000);
  const h = rng.int(1, 4000);
  const base = estimateVlmTokens(w, h);
  assert.ok(base >= 0 && Number.isInteger(base));
  assert.ok(estimateVlmTokens(w + 1, h) >= base, `宽单调破坏 w=${w} h=${h}`);
  assert.ok(estimateVlmTokens(w, h + 1) >= base, `高单调破坏 w=${w} h=${h}`);
  assert.equal(estimateVlmTokens(10 ** 9, 10 ** 9), Math.ceil((2000 * 2000) / 750), '封顶律破坏');
  assert.equal(estimateVlmTokens(NaN, -5), 0, '脏输入应记 0');
});

// ═══════════════════════════════════════════════════════════════════
// ③ 确定性不变量
// ═══════════════════════════════════════════════════════════════════

prop('确定③-A EXP4 同 seed + 同 history 采样序列逐字节一致 + 分布归一', 8, (rng, i) => {
  const seed = rng.int(0, 2 ** 31 - 1);
  const histRng = new Rng(seed ^ 0x5bf03635);
  const history = Array.from({ length: histRng.int(0, 12) }, () => ({
    goal: 'fuzz-goal',
    success: histRng.bool(),
    steps: histRng.int(1, 30),
    durationMs: histRng.int(1, 120_000),
    strategies: [histRng.pick(['scroll', 'inspect', 'ask_vlm', 'recall_skill', 'click'])],
    action: histRng.pick(['scroll', 'inspect', 'ask_vlm', 'recall_skill', 'click']),
    scene: `scene-${histRng.int(0, 5)}`,
    budget: 24,
  }));
  const a = new EvolutionEngine({ seed, history });
  const b = new EvolutionEngine({ seed, history }); // 同 seed 同 history：另一实例
  for (let k = 0; k < 50; k++) {
    const ctx = { scene: `s${(k + i) % 6}`, cluster: `c${k % 3}`, worldKind: 'wizard', stepsRemaining: 24 - k, budget: 24 };
    const sa = a.selectAction(ctx);
    const sb = b.selectAction(ctx);
    assert.equal(sa.arm, sb.arm, `采样序列漂移 step=${k}`);
    assert.equal(sa.prob, sb.prob, `采样概率漂移 step=${k}`);
    assert.deepEqual(sa.probabilities, sb.probabilities, `分布漂移 step=${k}`);
    const sum = Object.values(sa.probabilities).reduce((s, p) => s + p, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `分布未归一 sum=${sum}`);
    assert.ok(Object.values(sa.probabilities).every(p => p >= 0 && p <= 1), '概率出 [0,1]');
    assert.deepEqual(a.armProbabilities(ctx), a.armProbabilities(ctx), 'armProbabilities 非确定');
    const run = {
      goal: 'fuzz-goal', success: rng.bool(), steps: rng.int(1, 20),
      durationMs: rng.int(1, 60_000), strategies: [sa.arm], budget: 24, bandit: sa.annotation,
    };
    a.ingest(run);
    b.ingest(run); // 双引擎同步喂史，下一轮仍须一致
  }
});

prop('确定③-B derivePcgScene 同 seed 字节级一致（JSON 规范形）+ 结构不变量', 200, (rng) => {
  const seed = rng.int(0, 2 ** 31 - 1);
  const opts = rng.bool(0.7)
    ? { difficulty: rng.int(1, 3), beta: rng.float(0.1, 3) }
    : { difficulty: rng.pick([0, 4, NaN]), weights: { 'screen:sidebar': rng.float(0, 2) }, beta: rng.pick([NaN, -1, 5]) };
  const a = derivePcgScene(seed, opts);
  const b = derivePcgScene(seed, opts);
  assert.equal(JSON.stringify(b), JSON.stringify(a), 'PCG 推导非字节级一致');
  assert.equal(a.fingerprint, b.fingerprint);
  assert.ok(a.stages.length >= 3, `幕数 ${a.stages.length} < 3`);
  if (a.overlay) {
    assert.ok(a.overlay.atStage >= 1 && a.overlay.atStage <= a.stages.length - 2,
      `遮幕位 ${a.overlay.atStage} 压首末幕（幕数 ${a.stages.length}）`);
  }
});

prop('确定③-C gym 任务/课程采样确定性（generateTasks / sampleCurriculumWorld）', 200, (rng) => {
  const seed = rng.int(0, 2 ** 31 - 1);
  const count = rng.int(1, 8);
  assert.deepEqual(generateTasks(seed, count), generateTasks(seed, count), 'generateTasks 非确定');
  const opts = { difficulty: rng.pick([1, 2, 3]), budget: rng.int(4, 20) };
  const a = sampleCurriculumWorld(seed, opts as never);
  const b = sampleCurriculumWorld(seed, opts as never);
  assert.equal(a.task.kind, b.task.kind, '课程世界采样漂移');
  assert.equal(JSON.stringify(b), JSON.stringify(a), '课程采样非确定');
  mustNotThrow('generateTasks 垃圾', () => generateTasks(NaN, -3));
});

test('fuzz: 确定③-D PcgWorld 帧合成确定（同 seed ⇒ 同 derivation/状态键/控件表/帧字节；sharp 端到端）', async () => {
  let sharp: Awaited<ReturnType<typeof getSharp>> | null = null;
  try { sharp = await getSharp(); } catch { sharp = null; }
  const seeds = [3, 17, 257, 1024, 31337, 888, 4242, 99991, 55, 77, 12345, 2026];
  for (const seed of seeds) {
    const w1 = new PcgWorld(seed, { difficulty: (seed % 3) + 1 });
    const w2 = new PcgWorld(seed, { difficulty: (seed % 3) + 1 });
    assert.equal(JSON.stringify(w2.derivation), JSON.stringify(w1.derivation), `seed=${seed} 推导漂移`);
    assert.equal(w2.stateKey(), w1.stateKey(), `seed=${seed} 状态键漂移`);
    assert.deepEqual(w2.controls(), w1.controls(), `seed=${seed} 控件表漂移`);
    if (!sharp) continue;
    const f1 = await w1.capture();
    const f2 = await w2.capture();
    assert.ok(f1.equals(f2), `seed=${seed} 合成帧字节不一致`);
  }
  if (!sharp) console.log('  [w7fuzz] sharp 不可用 — 帧字节比对跳过（推导/键/控件路已覆盖）');
});

prop('确定③-E oscillationTracker 判决确定：同指纹序列 ⇒ 同告警序列；3 完整周期必告警', 200, (rng) => {
  const len = rng.int(1, 16);
  const seq = Array.from({ length: len }, () => Array.from({ length: 64 }, () => (rng.bool() ? '0' : '1')).join(''));
  const run = (): Array<string | null> => {
    oscillationTracker.reset();
    return seq.map(h => oscillationTracker.observe(h));
  };
  assert.deepEqual(run(), run(), '振荡判决非确定');
  const p = rng.int(1, 4);
  const pattern = Array.from({ length: p }, () => Array.from({ length: 64 }, () => (rng.bool() ? '0' : '1')).join(''));
  const cyc = [...pattern, ...pattern, ...pattern];
  oscillationTracker.reset();
  let alarm: string | null = null;
  for (const h of cyc) alarm = oscillationTracker.observe(h);
  assert.ok(alarm !== null, `p=${p} 三完整周期未告警`);
  oscillationTracker.reset();
});

// ═══════════════════════════════════════════════════════════════════
// ④ 状态机不变量
// ═══════════════════════════════════════════════════════════════════

const ALL_PHASES: ReadonlySet<string> = new Set(['planning', 'acting', 'verifying', 'blocked', 'achieved', 'failed', 'aborted']);

prop('状态机④-A goalState 七相：模型对照（六条有序判定律的独立重实现）+ 垃圾 spec 降级', 250, (rng) => {
  const nCrit = rng.int(0, 4);
  const spec: GoalSpec = {
    goal: rng.bool(0.8) ? `目标-${rng.int(0, 999)}` : (rng.bool() ? '' : ('G'.repeat(2500))),
    successCriteria: rng.bool(0.8)
      ? Array.from({ length: nCrit }, () => `判据${rng.int(0, 9)}`)
      : (rng.bool() ? [] : ('junk' as unknown as string[])),
    maxSteps: rng.pick([1, 3, 10, 24, NaN, 0, -5, 2.9]),
    timeBudgetSec: rng.pick([1, 5, 300, NaN, 0]),
    ...(rng.bool(0.3) ? { failureCriteria: ['别点错'] } : {}),
  };
  let clock = 10_000;
  const machine = new GoalStateMachine(spec, () => clock);
  for (let step = 0; step < 30; step++) {
    clock += rng.pick([0, 0, 100, 4_000]);
    const before = machine.progress;
    switch (rng.int(0, 8)) {
      case 0: machine.begin(); break;
      case 1: machine.tick(); break;
      case 2: machine.recordCriterion(rng.int(-2, nCrit + 2), rng.pick(['met', 'violated', 'junk' as never])); break;
      case 3: machine.recordAll(rng.pick(['met', 'violated', 'junk' as never])); break;
      case 4: machine.addBlocker(rng.pick(['', '   ', '缺权限'])); break;
      case 5: machine.clearBlockers(); break;
      case 6: machine.amendCriterion(rng.int(-1, nCrit), rng.pick(['', '新判据文'])); break;
      case 7: machine.recordDrift(rng.pick([null, 0.2, 0.9, NaN, 5, -3])); break;
      default: break;
    }
    const prog = machine.progress;
    const ev = machine.evaluate();
    assert.ok(ALL_PHASES.has(ev.phase), `非法相 ${ev.phase}`);
    assert.equal(prog.phase, ev.phase, 'progress.phase 与 evaluate().phase 分歧（陈旧相）');
    assert.ok(ev.phase !== 'verifying', '本状态机自行产生了 verifying 相（保留相被越权铸造）');
    // 模型对照：从 progress 快照独立重推六条有序规则
    const st = prog.criteriaStatus;
    const violated = st.some(c => c.status === 'violated');
    const allMet = st.length > 0 && st.every(c => c.status === 'met');
    const begun = prog.startedAt > 0;
    const spec2 = machine.spec;
    // elapsedMs 铁律：未 begin 恒为 0（时间预算只在生命周期内计时）
    const elapsed = begun ? Math.max(0, clock - prog.startedAt) : 0;
    const maxSteps = spec2.maxSteps ?? 24; // spec getter 恒落maxSteps；?? 仅为类型收窄（同值缺省）
    const oracle: GoalPhase = violated ? 'failed'
      : allMet ? 'achieved'
        : begun && prog.blockers.length > 0 ? 'blocked'
          : prog.stepIndex >= maxSteps ? 'aborted'
            : elapsed > spec2.timeBudgetSec! * 1000 ? 'aborted'
              : begun ? 'acting' : 'planning';
    assert.equal(ev.phase, oracle,
      `判定律分歧 machine=${ev.phase} oracle=${oracle} state=${JSON.stringify(prog)} spec=${JSON.stringify(spec2)}`);
    if (before.criteriaStatus.length > 0) {
      assert.equal(prog.criteriaStatus.length, before.criteriaStatus.length, '判据条数被非法操作改变');
    }
  }
  mustNotThrow('toAnchor', () => machine.toAnchor());
  const anchor = machine.toAnchor();
  assert.ok(anchor.phase && typeof anchor.step_index === 'number' && typeof anchor.elapsed_ms === 'number');
});

prop('状态机④-B barrier 序号单调 + 两阶段不可回退 + 名册/确认代数', 250, (rng) => {
  let clock = 1000;
  const core = createBarrierCore({ now: () => clock, ttlMs: 10_000, maxLive: 4, maxTombstones: 8 });
  const names = ['b1', 'b2', 'b3'];
  const peers = ['p1', 'p2', 'p3', 'p4'];
  const lastSeq = new Map<string, number>();
  const committedSeen = new Set<string>();
  const retiredSeen = new Set<string>();
  const arrivedByGen = new Map<string, Set<string>>();
  const ackedByGen = new Map<string, Set<string>>();
  for (let step = 0; step < 60; step++) {
    clock += rng.pick([0, 0, 100, 20_000]); // 偶发 TTL 清扫
    const name = rng.pick(names);
    const peer = rng.pick(peers);
    let view;
    const op = rng.int(0, 9);
    if (op <= 5) {
      view = core.apply({ op: 'allocate', name, peer, n: rng.pick([1, 2, 3, 64, 0, -1]) });
      if (view.ok) {
        const vseq = view.seq ?? -1; // ok 视图恒带 seq；?? 仅类型收窄
        const gen = `${name}#${vseq}`;
        const key = `${name}:${vseq}`;
        const prev = lastSeq.get(name);
        assert.ok(prev === undefined || vseq >= prev, `序号回退 ${name}: ${vseq} < ${prev}`);
        if (prev === undefined || vseq > prev) lastSeq.set(name, vseq);
        if (!arrivedByGen.has(gen)) arrivedByGen.set(gen, new Set());
        arrivedByGen.get(gen)!.add(peer);
        if (view.phase === 'committed') committedSeen.add(key);
        assert.ok(view.phase === 'collecting' || view.phase === 'committed', `非法相 ${view.phase}`);
      }
    } else if (op <= 7) {
      const seqGuess = (lastSeq.get(name) ?? 1) + rng.pick([-1, 0, 1]);
      view = core.apply({ op: 'commit', name, peer, seq: seqGuess });
      if (view.ok) {
        const vseq = view.seq ?? -1;
        const key = `${name}:${vseq}`;
        const gen = `${name}#${vseq}`;
        if (view.phase === 'committed') committedSeen.add(key);
        if (!ackedByGen.has(gen)) ackedByGen.set(gen, new Set());
        ackedByGen.get(gen)!.add(peer);
        if (view.retired === true) {
          assert.ok(!retiredSeen.has(key), `retired 重复发射 ${key}（两阶段可回退!）`);
          retiredSeen.add(key);
        }
      } else {
        assert.ok(typeof view.reason === 'string', 'bad view 无 reason');
      }
    } else {
      view = core.apply(rng.bool() ? { op: 'status', name, peer } : (garbageDeep(rng) as never));
      if (view.ok && view.phase === 'committed') committedSeen.add(`${name}:${view.seq ?? -1}`);
    }
    if (view.ok && view.phase === 'collecting') {
      const key = `${name}:${view.seq ?? -1}`;
      assert.ok(!committedSeen.has(key), `两阶段回退: ${key} committed→collecting`);
    }
    for (const [gen, acks] of ackedByGen) {
      const arr = arrivedByGen.get(gen);
      assert.ok(arr !== undefined, `ack 先于抵达 ${gen}`);
      if (arr) for (const p of acks) assert.ok(arr.has(p), `ack 的 ${p} 不在名册 ${gen}`);
    }
  }
});

// ─── escrow 状态机 fuzz（注入时钟 + 剧本化端口，全程离线确定） ──

let escrowClock = 0;
const escrowExec: Array<{ label: string }> = [];

beforeEach(() => {
  reversalEscrow.reset();
  escrowClock = 10_000;
  escrowExec.length = 0;
  reversalEscrow.arm({
    now: () => escrowClock,
    ttlMs: 5_000,
    executorPort: {
      execute: async (step: { label: string }) => {
        escrowExec.push({ label: step.label });
        return { ok: true };
      },
    },
    hashPort: { capture: async () => '0'.repeat(64) },
    clipboardPort: { backup: async () => 'h', restore: async () => true },
    focusPort: { current: async () => 'W' },
  });
});

const VALID_OUTCOMES = new Set([
  'verified', 'aborted-pre-dispatch', 'compensated-verified', 'compensated-unverified',
  'compensation-failed', 'degraded-record-only', 'recovered-human-attention',
]);

prop('状态机④-C escrow 铸造→在途→结算/补偿：无死态、恰一次结算、账册合法', 150, async (rng) => {
  const semanticsPool = builtinCompensationSemantics();
  const semantics = rng.bool(0.85) ? rng.pick(semanticsPool) : String(garbageScalar(rng));
  const token = `fz-${rng.seed}-${rng.int(0, 1e9)}`;
  const mint = await reversalEscrow.mintPlan({ semantics, description: 'fuzz', approvalToken: token });
  if (!mint.ok) {
    assert.ok(['no-strategy', 'manual-only', 'persist-failed', 'internal'].includes(mint.reason),
      `非法铸造失败成因 ${mint.reason}`);
    assert.equal(reversalEscrow.dumpInFlight().length, 0, '失败铸造留下在途死态');
    return;
  }
  const planId = mint.plan.planId;
  assert.ok(reversalEscrow.dumpInFlight().some(p => p.planId === planId), '铸造成功但预案不在途（死态）');
  const path = rng.int(0, 3);
  if (path === 0) await reversalEscrow.settleVerified(token);
  else if (path === 1) await reversalEscrow.settleFailed(token);
  else if (path === 2) await reversalEscrow.interrupt('fuzz');
  else escrowClock += 10_000; // TTL 到期（settlement 永不到达）
  await reversalEscrow.sweep();
  await reversalEscrow.idle();
  const recs = reversalEscrow.dumpLedger().filter(r => r.planId === planId);
  assert.equal(recs.length, 1, `结算记录数 ${recs.length} ≠ 1（重复结算或漏结算）planId=${planId} path=${path}`);
  assert.ok(VALID_OUTCOMES.has(recs[0]!.outcome), `非法 outcome ${recs[0]!.outcome}`);
  assert.equal(reversalEscrow.dumpInFlight().some(p => p.planId === planId), false, '结算后仍在途（死态）');
  if (recs[0]!.outcome === 'compensation-failed') {
    assert.ok(recs[0]!.escalation, 'compensation-failed 无升级报告（静默破坏）');
  }
  // 幂等：同令牌再结算不追加记录
  await reversalEscrow.settleVerified(token);
  await reversalEscrow.idle();
  assert.equal(reversalEscrow.dumpLedger().filter(r => r.planId === planId).length, 1, '二次结算追加了记录');
  // 未知令牌结算 = no-op
  const before = reversalEscrow.dumpLedger().length;
  await reversalEscrow.settleVerified('never-minted-token');
  await reversalEscrow.idle();
  assert.equal(reversalEscrow.dumpLedger().length, before, '未知令牌结算非 no-op');
});

prop('状态机④-D escrow 同令牌重铸：旧预案 superseded 流产、新预案在途', 60, async (rng) => {
  const semantics = rng.pick(builtinCompensationSemantics());
  const token = `fz-sup-${rng.seed}-${rng.int(0, 1e9)}`;
  const m1 = await reversalEscrow.mintPlan({ semantics, approvalToken: token });
  if (!m1.ok) return;
  const m2 = await reversalEscrow.mintPlan({ semantics, approvalToken: token });
  assert.equal(m2.ok, true);
  await reversalEscrow.idle();
  const ledger = reversalEscrow.dumpLedger();
  const old1 = ledger.filter(r => r.planId === m1.plan.planId);
  assert.equal(old1.length, 1, '旧预案未入账');
  assert.equal(old1[0]!.outcome, 'aborted-pre-dispatch', `旧预案 outcome=${old1[0]!.outcome} ≠ superseded 流产`);
  assert.ok(reversalEscrow.dumpInFlight().some(p => p.planId === m2.plan!.planId), '新预案不在途');
  assert.ok(!reversalEscrow.dumpInFlight().some(p => p.planId === m1.plan.planId), '旧预案仍在途');
});

// ═══════════════════════════════════════════════════════════════════
// ⑤ 隔离不变量（安全关键）
// ═══════════════════════════════════════════════════════════════════

const MARKER_KINDS = ['AGENT_BEGIN', 'AGENT_END', 'ENV_SHAPED', 'SENSE_SHIFT', 'GUARD_BLOCKED', 'AUDIT_PRE', 'AGENT_NOTE'] as const;
const JUNK_TOOLS = ['take_screenshot', 'get_metrics', '', 'read_file', 'save_skill', 'AGENT_NOTE ', 'audit_pre'];

prop('隔离⑤-A AGENT_NOTE/AUDIT_PRE 任意注入序列下绝不进 ACTION_TOOLS 重放面', 250, async (rng) => {
  journal.reset();
  journal.configure(true, '', rng.int(3, 60)); // 内存态（无盘路径），随机容量含驱逐路径
  // 确定性打底：每样本先注入两类安全关键 marker，保证攻击面生效
  await journal.appendMarker({
    kind: 'AGENT_NOTE', agentId: 'a0', event: rng.pick(['claim', 'post'] as const),
    subject: 's0', body: 'payload',
  } as never);
  await journal.appendMarker({ kind: 'AUDIT_PRE', tool: rng.pick([...ACTION_TOOLS, 'junk']), args: { x: 1 } } as never);
  for (let step = 0; step < 30; step++) {
    const roll = rng.int(0, 5);
    if (roll === 0) {
      await journal.appendMarker({
        kind: 'AGENT_NOTE', agentId: `a${rng.int(0, 3)}`,
        event: rng.pick(['claim', 'post'] as const),
        subject: `s${rng.int(0, 9)}`, body: 'b',
      } as never);
    } else if (roll === 1) {
      // marker args 走 JSON 规范形（哈希链的 canonical 序列化）——BigInt/Symbol/
      // 循环引用是序列化器域外向量，不是隔离属性的攻击面（隔离攻击面 = marker 类注入）
      await journal.appendMarker({
        kind: 'AUDIT_PRE', tool: rng.pick([...ACTION_TOOLS, 'junk']),
        args: { x: jsonSafeGarbage(rng) },
      } as never);
    } else if (roll === 2) {
      const r = journal.appendPreDispatch(rng.pick([...ACTION_TOOLS, 'junk-tool']), { a: 1 });
      assert.ok(r.ok === true || r.ok === false, 'appendPreDispatch 返回畸形');
    } else {
      await journal.append({
        ts: Date.now(),
        tool: rng.bool(0.5) ? rng.pick(ACTION_TOOLS) : rng.pick(JUNK_TOOLS),
        args: { i: step },
        status: rng.pick(['SUCCESS', 'FAILED']),
      });
    }
  }
  // 重放面：list(true) / sinceTaskStart 只含 ACTION_TOOLS，绝不含任何 marker 类
  const replay = journal.list(true);
  for (const e of replay) {
    assert.ok(ACTION_TOOLS.includes(e.tool), `重放面混入非动作工具 "${e.tool}"`);
    assert.ok(!(MARKER_KINDS as readonly string[]).includes(e.tool), `重放面混入 marker "${e.tool}"`);
    assert.notEqual(e.status, 'MARKER', `重放面混入 MARKER 行 "${e.tool}"`);
  }
  for (const e of journal.sinceTaskStart()) {
    assert.ok(ACTION_TOOLS.includes(e.tool), `任务切片混入 "${e.tool}"`);
  }
  // marker 行入了链（防篡改）但被隔离在重放面外
  const all = journal.list(false);
  const markers = all.filter(e => (MARKER_KINDS as readonly string[]).includes(e.tool));
  assert.ok(markers.length > 0, 'marker 注入未入链（攻击面未生效）');
  for (const m of markers) assert.equal(m.status, 'MARKER', `marker status=${m.status}`);
  assert.ok(MARKER_KINDS.every(k => !ACTION_TOOLS.includes(k)), 'ACTION_TOOLS 混入 marker 类（静态隔离律破坏）');
  const v = journal.verify();
  assert.equal(v.ok, true, `marker 混注后断链 brokenAt=${v.brokenAt}`);
});

prop('隔离⑤-B journal 哈希链：任意 append/驱逐/崩溃(restore)序列 verify 恒过；单点篡改定位准确', 250, (rng) => {
  journal.reset();
  journal.configure(true, '', rng.int(2, 40));
  for (let step = 0; step < rng.int(4, 30); step++) {
    if (rng.bool(0.25)) {
      void journal.appendMarker({ kind: rng.pick(MARKER_KINDS), ...(rng.bool() ? { taskId: 't' } : { action: 'a' }) } as never);
    } else if (rng.bool(0.2)) {
      void journal.appendPreDispatch(rng.pick(ACTION_TOOLS));
    } else {
      void journal.append({
        ts: step, tool: rng.pick([...ACTION_TOOLS, 'junk']), args: { step },
        status: 'SUCCESS', ...(rng.bool(0.3) ? { observe: `o${step}` } : {}),
      });
    }
  }
  let v = journal.verify();
  assert.equal(v.ok, true, `append 序列后误报断链 brokenAt=${v.brokenAt}`);
  // 崩溃恢复剧本：快照 → 继续追加 → restore 快照 → verify 仍过且续链可用
  const snapshot = JSON.parse(JSON.stringify(journal.list(false))) as Array<Record<string, unknown>>;
  const tip = journal.tip;
  const base = journal.base;
  const lenA = snapshot.length;
  for (let k = 0; k < 3; k++) {
    void journal.append({ ts: 9_000 + k, tool: 'click_mouse', args: { k }, status: 'SUCCESS' });
  }
  journal.restoreChain(snapshot as never, tip, base);
  v = journal.verify();
  assert.equal(v.ok, true, 'restore 后误报断链');
  assert.equal(journal.list(false).length, lenA, 'restore 长度漂移');
  void journal.append({ ts: 9_999, tool: 'type_text', args: {}, status: 'SUCCESS' });
  v = journal.verify();
  assert.equal(v.ok, true, 'restore 续链后断链');
  // 单点篡改：改随机存活条目的载荷（哈希不动）⇒ verify 定位到第一个失配下标
  const entries = journal.list(false);
  if (entries.length > 0) {
    const idx = rng.int(0, entries.length - 1);
    const victim = entries[idx] as { status?: string };
    const orig = victim.status;
    victim.status = orig === 'TAMPERED' ? 'SUCCESS' : 'TAMPERED';
    v = journal.verify();
    assert.equal(v.ok, false, `篡改未检出 idx=${idx}`);
    assert.equal(v.brokenAt, idx, `断点定位失准 brokenAt=${v.brokenAt} want=${idx}（len=${entries.length}）`);
    victim.status = orig;
    v = journal.verify();
    assert.equal(v.ok, true, '还原后仍报断链');
  }
});

// ═══════════════════════════════════════════════════════════════════
// ⑥ 鲁棒性不变量：纯函数入口喂垃圾绝不抛（按模块分组批量攻击）
//    硬断言面 = 文档声明「绝不抛」的入口；probe 面 = 无声明域（登记不冒充）
// ═══════════════════════════════════════════════════════════════════

// 【登记·真缺陷 D2】VlmBudget.requote 违反其文档声明「防御（绝不抛）：remainingSteps
// 非有限 ⇒ 视为步数不可用 + reason 注记」：remainingSteps 为「含 Symbol 的数组/对象」
// 时 reason 构造中的 String(remainingSteps) 抛 TypeError（String 对含 Symbol 的
// 数组走 ToString(Symbol)）。最小重放（seed=7 sample#18）：
//   new VlmBudget().requote([Symbol('x')], {}) → TypeError: Cannot convert a
//   Symbol value to a string。本属性保持 fail（不删断言）。
prop('鲁棒⑥-A codec 组：坐标/补丁/路由/预算入口垃圾不抛（声明面）', 220, (rng) => {
  const g = () => garbageDeep(rng);
  for (let k = 0; k < 10; k++) {
    mustNotThrow('mapEncodedToOriginal', () => mapEncodedToOriginal(g() as number, g() as number, g() as number, g() as number, g() as number, g() as number));
    mustNotThrow('mapInsetToOriginal', () => mapInsetToOriginal(g() as number, g() as number, g() as EncodedImageMeta));
    mustNotThrow('gazeRouter', () => gazeRouter(g()));
    mustNotThrow('gazeRouter 候选数组', () => gazeRouter([g(), g(), g()]));
    mustNotThrow('estimateVlmTokens', () => estimateVlmTokens(g() as number, g() as number));
    mustNotThrow('cleanPatchRect', () => cleanPatchRect(g(), g() as number, g() as number));
    mustNotThrow('patchRectToNormalized', () => patchRectToNormalized(g() as PatchRect, g() as number, g() as number));
    mustNotThrow('normalizedToPatchRect', () => normalizedToPatchRect(g() as never, g() as number, g() as number));
    mustNotThrow('patchRectToEncoded', () => patchRectToEncoded(g() as PatchRect, g() as number, g() as number, g() as number, g() as number));
    mustNotThrow('encodedPatchRectToSource', () => encodedPatchRectToSource(g() as PatchRect, g() as number, g() as number, g() as number, g() as number));
    mustNotThrow('patchAnchorText', () => patchAnchorText(g() as PatchRect, g() as never, g() as never));
    mustNotThrow('VlmBudget.check', () => new VlmBudget({ maxImagesPerTask: g() as number, maxBytesPerTask: g() as number }).check({ bytes: g() as number }));
    mustNotThrow('VlmBudget.commit', () => { const b = new VlmBudget(); b.commit({ bytes: g() as number }); });
    mustNotThrow('VlmBudget.requote', () => new VlmBudget().requote(g() as number, { current: { quality: g() as number, maxDimension: g() as number }, debounceN: g() as number, bytesPerImage: g() as number }));
  }
});

// 【登记·真缺陷 D4】routeLabelPlacement 违反其文档声明「纯函数，绝不抛」：防御
// 体检只覆盖 box 四坐标与 labelW/labelH，画幅维度 W/H 与 occupied 元素坐标
// 未检——chipInCanvas 的 `rect.x1 <= W` / interArea 的算术遇 Symbol 直接抛
// TypeError。最小重放（seed=12648430 sample#14）：
//   routeLabelPlacement({x0:10,y0:10,x1:50,y1:40}, 30, 12, Symbol('W'), 100, [])
//   → TypeError: Cannot convert a Symbol value to a number
//   （occupied=[{x0:Symbol('s'),y0:0,x1:5,y1:5}] 同律亦抛）。本属性保持 fail。
prop('鲁棒⑥-B som 组：名额分配/标签路由/染色入口垃圾不抛（声明面）+ 无声明域探测面', 210, (rng) => {
  const mkMarker = () => ({
    text: safeStr(garbageScalar(rng)),
    bbox: {
      x0: garbageScalar(rng) as number, y0: garbageScalar(rng) as number,
      x1: garbageScalar(rng) as number, y1: garbageScalar(rng) as number,
    },
  });
  for (let k = 0; k < 10; k++) {
    const markers = Array.from({ length: rng.int(0, 5) }, mkMarker) as never[];
    const scores = Array.from({ length: rng.int(0, 5) }, () => ({
      confidence: garbageScalar(rng) as number, relevance: garbageScalar(rng) as number,
    }));
    mustNotThrow('selectSparseMarkers', () => selectSparseMarkers(markers, scores, garbageScalar(rng) as number));
    mustNotThrow('routeLabelPlacement', () => routeLabelPlacement(
      {
        x0: garbageScalar(rng) as number, y0: garbageScalar(rng) as number,
        x1: garbageScalar(rng) as number, y1: garbageScalar(rng) as number,
      },
      garbageScalar(rng) as number, garbageScalar(rng) as number,
      garbageScalar(rng) as number, garbageScalar(rng) as number,
      Array.from({ length: rng.int(0, 3) }, () => ({ x0: NaN, y0: 1, x1: -3, y1: 1e9 }))));
    mustNotThrow('stableColor', () => stableColor(safeStr(garbageScalar(rng))));
    mustNotThrow('somColorKey', () => somColorKey(mkMarker() as never, garbageScalar(rng) as number, garbageScalar(rng) as number));
    mustNotThrow('taskRelevance', () => taskRelevance(safeStr(garbageScalar(rng)), safeStr(garbageScalar(rng))));
    // 探测面（无「绝不抛」声明的入口——照常攻击、异常登记不冒充缺陷）：
    // · buildGroundingUserPrompt：模板插值遇 Symbol 宽高会抛（文档只说纯函数）
    // · markerCentroid：文档明示「输入合法性归调用方」
    probe('buildGroundingUserPrompt', 'width/height/question=垃圾', () => buildGroundingUserPrompt({
      width: garbageScalar(rng) as number, height: garbageScalar(rng) as number,
      question: garbageScalar(rng) as string,
    }));
    const bb = mkMarker().bbox;
    probe('markerCentroid', safeStr(bb), () => markerCentroid(bb as never));
  }
});

prop('鲁棒⑥-C approval/auction 组：脱敏/拍卖入口垃圾不抛 + 令牌桶探测面（无声明域）', 210, (rng) => {
  for (let k = 0; k < 10; k++) {
    mustNotThrow('lengthBucket', () => lengthBucket(garbageScalar(rng) as number));
    mustNotThrow('sanitizeActionShape', () => sanitizeActionShape({
      tool: safeStr(garbageScalar(rng)),
      x: garbageScalar(rng) as number, y: garbageScalar(rng) as number,
      target_description: safeStr(garbageScalar(rng)),
      text: 'A'.repeat(rng.int(0, 600)),
      text_length_bucket: garbageScalar(rng) as string,
    }));
    mustNotThrow('allocateQuotas', () => allocateQuotas(
      Array.from({ length: rng.int(0, 4) }, () => garbageScalar(rng) as number),
      garbageScalar(rng) as number));
    mustNotThrow('marginalProgressScore', () => marginalProgressScore(
      { successes: garbageScalar(rng) as number, attempts: garbageScalar(rng) as number },
      garbageScalar(rng) as number, garbageScalar(rng) as number));
    // 探测面（无「绝不抛」声明的入口——异常登记不冒充缺陷）：
    // · TokenBucket 构造参数是配置而非不可信输入（BigInt 混算在声明域外）
    // · sanitizeActionShape(null)：raw 形状整体为 null（文档未覆盖整体 null 域）
    probe('TokenBucket 构造+take', 'capacity/interval/initialTokens/now=垃圾', () => {
      const b = new TokenBucket(
        garbageScalar(rng) as number, garbageScalar(rng) as number,
        garbageScalar(rng) as number, () => garbageScalar(rng) as number);
      b.tryTake();
      b.available();
    });
    probe('sanitizeActionShape(null)', 'null', () => sanitizeActionShape(null as never));
  }
});

// 【登记·真缺陷 D3】derivePcgScene 违反其文档声明「绝不抛异常：内部异常 ⇒ 最小兜底
// 推导」：seed 为 Symbol 时主路径 Number(seed) 抛 TypeError 被 catch，但兜底函数
// pcgFallbackDerivation(seed) 内**重做** Number(seed) 二次抛出且无人接——防御链在
// 兜底处断裂。最小重放（seed=1 sample#0）：
//   derivePcgScene(Symbol('x'), {}) → TypeError: Cannot convert a Symbol value
//   to a number。本属性保持 fail（不删断言）。
prop('鲁棒⑥-D journal/evolution/gym/crossMachine/escrow 组：声明面垃圾不抛 + 探测面登记', 220, (rng) => {
  const g = () => garbageDeep(rng);
  for (let k = 0; k < 10; k++) {
    mustNotThrow('contextFeatureVector', () => contextFeatureVector(g() as never));
    mustNotThrow('shouldDistillSkill', () => shouldDistillSkill(g() as never, garbageScalar(rng) as number));
    mustNotThrow('failureSignature', () => failureSignature(g() as never));
    mustNotThrow('parseBarrierStep', () => parseBarrierStep(g()));
    mustNotThrow('compensationPathOf', () => compensationPathOf(g()));
    mustNotThrow('derivePcgScene 垃圾 seed/opts', () => derivePcgScene(garbageScalar(rng) as number, g() as never));
    mustNotThrow('derivePcgScene 垃圾 noise', () => derivePcgScene(1, { noise: g() as never }));
    mustNotThrow('GoalStateMachine 垃圾 spec+时钟', () => {
      const m = new GoalStateMachine(g() as never, g() as never);
      m.evaluate();
      m.tick();
      m.toAnchor();
    });
    mustNotThrow('oscillationTracker.observe 垃圾指纹', () => { oscillationTracker.observe(safeStr(garbageScalar(rng))); oscillationTracker.reset(); });
    mustNotThrow('EvolutionEngine 垃圾构造+采样', () => {
      const e = new EvolutionEngine({ seed: garbageScalar(rng) as number, history: g() as never, eta: garbageScalar(rng) as number });
      e.selectAction(g() as never);
      e.greedyArm(g() as never);
      e.ingest(g() as never);
    });
    mustNotThrow('applyRun 垃圾 run', () => applyRun({ click: 1 }, g() as never));
    // 探测面：无「绝不抛」声明的入口（登记不冒充缺陷）
    probe('lempelZivComplexity', 'null/垃圾序列', () => lempelZivComplexity(g() as never));
    probe('normalizedActionComplexity', 'null/垃圾序列', () => normalizedActionComplexity(g() as never));
    probe('armDistribution', '垃圾 theta/权重/特征', () => armDistribution(g() as never, g() as never, g() as never));
    probe('applyRun(null weights)', 'weights=null, run={success:true,strategies:[click]}', () => applyRun(null as never, { success: true, strategies: ['click'] } as never));
  }
  // barrier 核心：纯垃圾请求流绝不抛（声明面）且永远给结构化视图
  const core = createBarrierCore({ now: () => 1 });
  for (let k = 0; k < 30; k++) {
    mustNotThrow('barrier.apply 垃圾', () => {
      const v = core.apply(g() as never);
      assert.ok(v === null || typeof v === 'object', 'barrier 视图畸形');
    });
  }
});

test('fuzz: ⑥ 探测面登记汇总（无断言 —— 登记项进报告，集成者处置）', () => {
  if (PROBE_FINDINGS.length === 0) {
    console.log('  [w7fuzz] 探测面（无声明域入口）0 异常');
    return;
  }
  const byFn = new Map<string, number>();
  for (const f of PROBE_FINDINGS) byFn.set(f.fn, (byFn.get(f.fn) ?? 0) + 1);
  console.log(`  [w7fuzz] 探测面登记 ${PROBE_FINDINGS.length} 例（非声明域，详见 W7-5 报告）:`);
  for (const [fn, n] of byFn) {
    const sample = PROBE_FINDINGS.find(f => f.fn === fn)!;
    console.log(`    - ${fn} ×${n}（例: input=${sample.input.slice(0, 60)} → ${sample.err}）`);
  }
});
