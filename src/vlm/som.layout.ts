// src/vlm/som.layout.ts
// W6-2（doctor smell.over-engineering 清偿）：自 som.ts 低风险分区提取
// （>500 行拆分信号）—— W1-7 三件纯函数装备整体搬迁：稀疏名额分配、
// 抗遮挡标签路由、跨帧稳定染色。零外部运行时依赖，行为零变化；som.ts 以再导出
// 保持导入面不变（vlm.som 测试与 grounding 消费方零改动）。
import type { SomMarker, SomMarkerScore } from './som';
import { classifyWordShape } from '../wordShape';
import { cosine, embed } from '../semanticHash';

// ─── W1-7: 稀疏名额分配（纯函数，测试面）─────────────────────────

/** 稀疏选择结果（markers 保持原数组相对序 —— 跨帧视觉次序稳定） */
export interface SparseSomSelection {
  /** 入选的 marker 子集（渲染序 = 原序） */
  markers: SomMarker[];
  /** true = 证据缺席/预算非法，诚实回退全量（不假装知道优先级） */
  fallback: boolean;
  /** 入选 marker 的权重（与 markers 对齐；fallback 时省略） */
  weights?: number[];
}

/** W1-7: clamp 到 [0,1]；非有限数按 0（无证据不加分） */
function clamp01(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * W1-7: 稀疏标记名额分配（纯函数，绝不抛）。
 * 权重 = 交互置信 × 任务语义相关度；**证据通道在场才参与乘法**：
 *   - 某通道只要有一个 marker 提供了有限值即「在场」，缺席元素该通道记 0
 *     （名额稀缺时，无证据者输给有证据者，但预算有余仍可入选）；
 *   - 两通道皆缺席（scores 缺省/全空/非数组）⇒ 无从判别优先级 —— 诚实回退全量。
 * 预算非法（NaN/负数/∞）同样回退全量（配置错误不毒化渲染）。
 * 平手按原始下标升序（确定性）；budget ≥ 全量时直接全量（不排序）。
 */
export function selectSparseMarkers(
  markers: SomMarker[],
  scores: SomMarkerScore[] | undefined,
  budget: number,
): SparseSomSelection {
  const all = Array.isArray(markers) ? markers : [];
  if (!Number.isFinite(budget) || budget < 0) return { markers: all, fallback: true };
  const k = Math.min(all.length, Math.floor(budget));
  if (k >= all.length) return { markers: all, fallback: false };

  const sc: SomMarkerScore[] = Array.isArray(scores) ? scores : [];
  const hasConf = sc.some(s => s && Number.isFinite(s.confidence));
  const hasRel = sc.some(s => s && Number.isFinite(s.relevance));
  if (!hasConf && !hasRel) return { markers: all, fallback: true };

  const weightOf = (i: number): number => {
    const s = i < sc.length ? sc[i] : undefined;
    const c = hasConf ? clamp01(s?.confidence) : 1; // 通道缺席 = 中性 1（不扭曲另一通道）
    const r = hasRel ? clamp01(s?.relevance) : 1;
    return c * r;
  };
  const ranked = all
    .map((_, i) => ({ i, w: weightOf(i) }))
    .sort((a, b) => b.w - a.w || a.i - b.i); // 权重降序，平手原始下标升序
  const keep = new Set(ranked.slice(0, k).map(e => e.i));
  const picked: SomMarker[] = [];
  const weights: number[] = [];
  for (let i = 0; i < all.length; i++) {
    if (keep.has(i)) { picked.push(all[i]); weights.push(weightOf(i)); }
  }
  return { markers: picked, fallback: false, weights };
}

// ─── W1-7: 抗遮挡标签路由（纯函数，测试面）───────────────────────

/** 标签避让方向（试探序即平手序：上 → 下 → 左 → 右） */
export type SomLabelDirection = 'up' | 'down' | 'left' | 'right';

/** 整数像素矩形（x1>x0、y1>y0） */
export interface SomRect { x0: number; y0: number; x1: number; y1: number }

/** 标签路由决策：芯片矩形 + 引线（direction null = 四向全不可行，回落传统位） */
export interface SomLabelRoute {
  direction: SomLabelDirection | null;
  rect: SomRect;
  /** 连接标签芯片与元素框的引线端点；direction null 时缺席 */
  leader: { x1: number; y1: number; x2: number; y2: number } | null;
}

/** 标签芯片与元素框的间隙（像素）—— 芯片永不压自己的框 */
export const SOM_LABEL_GAP = 4;
/** 标签芯片高度（与传统路径的 20px 一致） */
export const SOM_LABEL_HEIGHT = 20;
/** 四向试探序 = 平手裁决序（W1-7 规格固定：上/下/左/右） */
const SOM_LABEL_DIRS: readonly SomLabelDirection[] = ['up', 'down', 'left', 'right'];

/** 芯片几何：up/down 与框左对齐，left/right 与框顶对齐（全部水平文本，不旋转） */
function labelChipRect(dir: SomLabelDirection, box: SomRect, labelW: number, labelH: number): SomRect {
  switch (dir) {
    case 'up':
      return { x0: box.x0, y0: box.y0 - SOM_LABEL_GAP - labelH, x1: box.x0 + labelW, y1: box.y0 - SOM_LABEL_GAP };
    case 'down':
      return { x0: box.x0, y0: box.y1 + SOM_LABEL_GAP, x1: box.x0 + labelW, y1: box.y1 + SOM_LABEL_GAP + labelH };
    case 'left':
      return { x0: box.x0 - SOM_LABEL_GAP - labelW, y0: box.y0, x1: box.x0 - SOM_LABEL_GAP, y1: box.y0 + labelH };
    case 'right':
      return { x0: box.x1 + SOM_LABEL_GAP, y0: box.y0, x1: box.x1 + SOM_LABEL_GAP + labelW, y1: box.y0 + labelH };
  }
}

/** 矩形相交面积（不相交 = 0；NaN 输入自然产生 0/NaN，不抛） */
function interArea(a: SomRect, b: SomRect): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 芯片完整落在画幅内（出画幅 = 不可读，等同冲突处理） */
function chipInCanvas(r: SomRect, W: number, H: number): boolean {
  return r.x0 >= 0 && r.y0 >= 0 && r.x1 <= W && r.y1 <= H;
}

/** 引线端点：芯片中点 → 夹到框范围内的锚点（确定性整数几何） */
function leaderFor(
  dir: SomLabelDirection,
  chip: SomRect,
  box: SomRect,
): { x1: number; y1: number; x2: number; y2: number } {
  const cx = Math.round((chip.x0 + chip.x1) / 2);
  const cy = Math.round((chip.y0 + chip.y1) / 2);
  const lx = Math.min(box.x1, Math.max(box.x0, cx)); // 芯片比框宽时锚点夹回框内
  const ly = Math.min(box.y1, Math.max(box.y0, cy));
  switch (dir) {
    case 'up': return { x1: lx, y1: chip.y1, x2: lx, y2: box.y0 };
    case 'down': return { x1: lx, y1: box.y1, x2: lx, y2: chip.y0 };
    case 'left': return { x1: chip.x1, y1: ly, x2: box.x0, y2: ly };
    case 'right': return { x1: box.x1, y1: ly, x2: chip.x0, y2: ly };
  }
}

/**
 * W1-7: 抗遮挡标签路由（纯函数，绝不抛）。
 * 律 1（first-fit）：按 上/下/左/右 序取首个「整芯片在画幅内 且 不与任何
 *   已占矩形（已标 bbox / 已放标签芯片）相交」的方向。
 * 律 2（最小重叠）：四向全冲突时取与已占矩形重叠面积最小的方向；平手按
 *   方向序（严格 < 保首个）；出画幅方向永不胜出（等同无穷重叠）。
 * 律 3（兜底）：连最小重叠候选都没有（如框占满画幅）⇒ direction null，
 *   rect 给传统位几何（框顶上方、顶越界回落框内），调用方原样回落旧行为。
 */
export function routeLabelPlacement(
  box: SomRect,
  labelW: number,
  labelH: number,
  W: number,
  H: number,
  occupied: ReadonlyArray<SomRect>,
): SomLabelRoute {
  const lw = Number.isFinite(labelW) && labelW > 0 ? Math.round(labelW) : 20;
  const lh = Number.isFinite(labelH) && labelH > 0 ? Math.round(labelH) : SOM_LABEL_HEIGHT;
  if (![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)) {
    return { direction: null, rect: { ...box }, leader: null }; // 防御：垃圾输入不抛
  }
  // W7:画幅脏值（Symbol/NaN/非正数）⇒ 无形墙（画幅未知时不设边界,诚实降级不抛）
  const cw = typeof W === 'number' && Number.isFinite(W) && W > 0 ? W : Number.POSITIVE_INFINITY;
  const ch = typeof H === 'number' && Number.isFinite(H) && H > 0 ? H : Number.POSITIVE_INFINITY;
  const occ = Array.isArray(occupied) ? occupied : [];

  // 律 1：方向序 first-fit
  for (const d of SOM_LABEL_DIRS) {
    const rect = labelChipRect(d, box, lw, lh);
    if (chipInCanvas(rect, cw, ch) && occ.every(o => interArea(rect, o) === 0)) {
      return { direction: d, rect, leader: leaderFor(d, rect, box) };
    }
  }
  // 律 2：四向全冲突 → 最小重叠面积（平手按方向序）
  let bestDir: SomLabelDirection | null = null;
  let bestRect: SomRect | null = null;
  let bestArea = Infinity;
  for (const d of SOM_LABEL_DIRS) {
    const rect = labelChipRect(d, box, lw, lh);
    if (!chipInCanvas(rect, cw, ch)) continue;
    let area = 0;
    for (const o of occ) area += interArea(rect, o);
    if (area < bestArea) { bestDir = d; bestRect = rect; bestArea = area; }
  }
  if (bestDir !== null && bestRect !== null) {
    return { direction: bestDir, rect: bestRect, leader: leaderFor(bestDir, bestRect, box) };
  }
  // 律 3：传统位几何（与旧路径 labelY 规则逐字节一致：顶越界回落框内上沿）
  const legacyRect: SomRect = {
    x0: box.x0,
    y0: box.y0 >= lh ? box.y0 - lh : box.y0,
    x1: box.x0 + lw,
    y1: (box.y0 >= lh ? box.y0 - lh : box.y0) + lh,
  };
  return { direction: null, rect: legacyRect, leader: null };
}

// ─── W1-7: 跨帧稳定染色（纯函数，测试面）─────────────────────────

/** 调色板规模（规格：8 或 16 —— 取 16 以降低相邻同色概率） */
const SOM_PALETTE_SIZE = 16;

/** HSV → #RRGGBB（h 单位度；纯整数/浮点确定运算，无随机） */
function hsvToHex(hDeg: number, s: number, v: number): string {
  const c = v * s;
  const hp = (((hDeg % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const rgb = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = v - c;
  const hex = (t: number) => Math.round((t + m) * 255).toString(16).padStart(2, '0').toUpperCase();
  return `#${hex(rgb[0])}${hex(rgb[1])}${hex(rgb[2])}`;
}

/** W1-7: 稳定染色调色板 —— 16 色 HSV 均匀分布（hue 步进 360/16、s=0.85、v=1） */
export const SOM_COLOR_PALETTE: readonly string[] = Object.freeze(
  Array.from({ length: SOM_PALETTE_SIZE }, (_, i) => hsvToHex((i * 360) / SOM_PALETTE_SIZE, 0.85, 1)),
);

/** W1-7: 32 位 FNV-1a（与 semanticHash 同族；其未导出，本地五行复刻） */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** W1-7: 稳定染色 —— key 短哈希取调色板（同 key 恒同色，跨帧稳定，零随机） */
export function stableColor(key: string): string {
  return SOM_COLOR_PALETTE[fnv1a(key) % SOM_PALETTE_SIZE];
}

/**
 * W1-7: wordShape 染色键（纯函数）—— 形状分类 + 归一化文本。
 * 用 marker 自身 bbox 按画幅归一化后过 classifyWordShape（wordShape.ts 的
 * 同一把尺子），键 = `${shape}|${小写去空文本}`：同文本同形状 ⇒ 同键 ⇒ 同色，
 * 与帧序、marker id、坐标微移无关（跨帧稳定的全部来源）。
 */
export function somColorKey(marker: SomMarker, width: number, height: number): string {
  const W = Number.isFinite(width) && width > 0 ? width : 1;
  const H = Number.isFinite(height) && height > 0 ? height : 1;
  const fin = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
  const text = typeof marker?.text === 'string' ? marker.text : '';
  const b = marker?.bbox;
  // 结构兼容 OcrWord（textReader 的接口含 center_normalized —— 一并构造）
  const word = {
    text,
    confidence: 0,
    confidenceAssumed: true,
    bbox_normalized: {
      x0: fin(b?.x0, 0) / W, y0: fin(b?.y0, 0) / H,
      x1: fin(b?.x1, 0) / W, y1: fin(b?.y1, 0) / H,
    },
    center_normalized: {
      x: (fin(b?.x0, 0) + fin(b?.x1, 0)) / (2 * W),
      y: (fin(b?.y0, 0) + fin(b?.y1, 0)) / (2 * H),
    },
  };
  let shape = 'ambiguous';
  try { shape = classifyWordShape(word); } catch { /* 防御：wordShape 异常不毒化染色 */ }
  return `${shape}|${text.trim().toLowerCase()}`;
}

/**
 * W1-7: 任务语义相关度（纯函数，0..1）—— semanticHash 余弦。
 * 集成接线一行：scores[i].relevance = taskRelevance(marker.text, 任务指令)。
 * 空文本/任何异常诚实回 0（无证据不是坏证据）。
 */
export function taskRelevance(label: string, task: string): number {
  try {
    if (!label || !task) return 0;
    return cosine(embed(label), embed(task));
  } catch {
    return 0;
  }
}
