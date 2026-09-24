// src/intent.ts
// C-1 意图感知验证引擎之魂：极简「物理规则引擎」。
// 让 Agent 拥有物理常识 —— 不读文字也能判断操作成败：
//   复选框点击 ⇒ 对勾出现 = 点击邻域对比度（细节丰富度）上升
//   菜单展开 ⇒ 点击点下方冒出新亮区
//   滚动 ⇒ 内容平移 = 行亮度序列错位匹配
//   输入聚焦 ⇒ 光标邻域微变而大邻域静止
// 每条规则 ≤30 行纯视觉启发式；规则表数据驱动注册，config 可裁剪（禁止硬编码红线）。
// 这是从「被动检测变化」到「主动验证意图」的升维：验证器带着预期找证据。
//
// 测量层双路径（本轮接线）：D-5 帧环 id（frame_stats/frame_rowmeans，服务端
// PIL 统计）优先；sharp buffer 路径保留给 legacy/开发仓。区域坐标统一归一化。
import { getSharp } from './_legacyDeps';
import * as backend from './physicalBackend';

/** 平移检测的缩放网格边长（8×8=64 行亮度签名）—— 与 dHash 网格维度同源 */
const SHIFT_GRID = 64;

export type ExpectationKind =
  | 'text_appear' | 'text_vanish'                    // 语义通道（复用现有 semanticConfirm）
  | 'toggle_on'  | 'toggle_off'                      // 物理：点击邻域对比度增/减（对勾出现/消失）
  | 'menu_expand' | 'menu_collapse'                  // 物理：点击点下方亮区面积增/减
  | 'scroll_content_up' | 'scroll_content_down'      // 物理：内容整体平移方向
  | 'input_focus'                                    // 物理：光标邻域微变
  | 'page_navigate'                                  // 委托现有 L0/L1 全屏判定
  | 'any_change';                                    // 缺省 = 现有行为，零回归

export interface IntentExpectation {
  kind: ExpectationKind;
  /** text_appear/vanish 专用：预期出现/消失的文字 */
  text?: string;
}

export interface PhysicsContext {
  beforeBuf: Buffer;
  afterBuf: Buffer;
  /** D-5 帧环 id（服务端统计路径）；缺席时回退 buffer+sharp 路径 */
  beforeFrameId?: number | null;
  afterFrameId?: number | null;
  /** 归一化动作点（无焦点时部分规则返回 not-applicable） */
  focus: { x: number; y: number } | null;
  regionRadius: number;
}

export interface PhysicsVerdict {
  satisfied: boolean;
  /** 人类可读证据链（锚点展示 + 遥测归因） */
  evidence: string;
  /** 规则不适用（如 toggle 规则但无焦点点）⇒ 调用方回退 L0/L1 */
  notApplicable?: boolean;
}

/** 物理规则接口：新规则只需实现 check 并注册进 RULES，不修改任何既有代码 */
export interface PhysicsRule {
  kind: ExpectationKind;
  check(ctx: PhysicsContext): Promise<PhysicsVerdict>;
}

// ─── 视觉度量原语（规则共用；双路径：服务端帧统计优先） ───

interface NormRegion { x: number; y: number; width: number; height: number }

/** 以归一化点为中心的归一化矩形（越界夹取） */
function focusRegionNorm(x: number, y: number, radius: number): NormRegion {
  const rx = Math.max(0.01, radius);
  const ry = Math.max(0.01, radius);
  return {
    x: Math.max(0, x - rx), y: Math.max(0, y - ry),
    width: Math.min(1, rx * 2), height: Math.min(1, ry * 2),
  };
}

/** 区域统计（双路径）：frameId → 服务端 frame_stats；否则 buffer+sharp */
async function regionStats(
  ctx: PhysicsContext,
  which: 'before' | 'after',
  region: NormRegion,
): Promise<{ mean: number; stdev: number }> {
  const fid = which === 'before' ? ctx.beforeFrameId : ctx.afterFrameId;
  if (fid != null) {
    const s = await backend.frameStats(fid, [region]);
    const st = s[0];
    if (!st || st.mean == null || st.stdev == null) {
      throw new Error(`frame_stats returned no data for frame ${fid}`);
    }
    return { mean: st.mean, stdev: st.stdev };
  }
  const sharp = await getSharp();
  const buf = which === 'before' ? ctx.beforeBuf : ctx.afterBuf;
  const meta = await sharp(buf).metadata();
  const W = meta.width!, H = meta.height!;
  const px = {
    left: Math.max(0, Math.min(W - 1, Math.round(region.x * W))),
    top: Math.max(0, Math.min(H - 1, Math.round(region.y * H))),
    width: Math.max(1, Math.round(region.width * W)),
    height: Math.max(1, Math.round(region.height * H)),
  };
  const stats = await sharp(buf).extract(px).stats() as { channels: Array<{ mean: number; stdev: number }> };
  const mean = stats.channels.reduce((n: number, c: { mean: number }) => n + c.mean, 0) / stats.channels.length;
  const stdev = stats.channels.reduce((n: number, c: { stdev: number }) => n + c.stdev, 0) / stats.channels.length;
  return { mean, stdev };
}

/** 行亮度序列（双路径）：frameId → 服务端 frame_rowmeans；否则 buffer+sharp */
async function rowMeans(
  ctx: PhysicsContext,
  which: 'before' | 'after',
  grid: number,
): Promise<number[]> {
  const fid = which === 'before' ? ctx.beforeFrameId : ctx.afterFrameId;
  if (fid != null) {
    return backend.frameRowmeans(fid, grid);
  }
  const sharp = await getSharp();
  const buf = which === 'before' ? ctx.beforeBuf : ctx.afterBuf;
  const res = await sharp(buf)
    .grayscale().resize(grid, grid, { fit: 'fill' }).raw()
    .toBuffer({ resolveWithObject: true });
  const { data, info } = res as any;
  const rows: number[] = [];
  for (let y = 0; y < info.height; y++) {
    let s = 0;
    for (let x = 0; x < info.width; x++) s += data[y * info.width + x];
    rows.push(s / info.width);
  }
  return rows;
}

// ─── 物理规则实现（每条编码一个物理直觉） ───

/** 对勾/选中标记是高对比度细节：邻域标准差上升 ⇒ 细节增多 */
const toggleOn: PhysicsRule = {
  kind: 'toggle_on',
  async check(ctx) {
    if (!ctx.focus) return { satisfied: false, evidence: 'no focus point', notApplicable: true };
    const r = focusRegionNorm(ctx.focus.x, ctx.focus.y, ctx.regionRadius);
    const [before, after] = await Promise.all([
      regionStats(ctx, 'before', r), regionStats(ctx, 'after', r),
    ]);
    const detailGain = after.stdev - before.stdev;
    return {
      satisfied: detailGain > 2,
      evidence: `local detail ${before.stdev.toFixed(1)}→${after.stdev.toFixed(1)} ` +
        `(${detailGain > 2 ? 'check-mark-like detail appeared' : 'below threshold'})`,
    };
  },
};

const toggleOff: PhysicsRule = {
  kind: 'toggle_off',
  async check(ctx) {
    if (!ctx.focus) return { satisfied: false, evidence: 'no focus point', notApplicable: true };
    const r = focusRegionNorm(ctx.focus.x, ctx.focus.y, ctx.regionRadius);
    const [before, after] = await Promise.all([
      regionStats(ctx, 'before', r), regionStats(ctx, 'after', r),
    ]);
    const detailLoss = before.stdev - after.stdev;
    return {
      satisfied: detailLoss > 2,
      evidence: `local detail ${before.stdev.toFixed(1)}→${after.stdev.toFixed(1)} ` +
        `(${detailLoss > 2 ? 'detail vanished as expected' : 'insufficient detail loss'})`,
    };
  },
};

/** 菜单/下拉展开 = 点击点下方冒出新内容区：下方带亮度或细节显著变化 */
const menuExpand: PhysicsRule = {
  kind: 'menu_expand',
  async check(ctx) {
    if (!ctx.focus) return { satisfied: false, evidence: 'no focus point', notApplicable: true };
    // 点击点下方带（跨 ~2×radius 的深度）
    const left = Math.max(0, ctx.focus.x - ctx.regionRadius);
    const top = Math.min(1 - 0.01, ctx.focus.y + ctx.regionRadius * 0.3);
    const region: NormRegion = {
      x: left, y: top,
      width: Math.min(1 - left, ctx.regionRadius * 2),
      height: Math.min(1 - top, ctx.regionRadius * 2),
    };
    const [before, after] = await Promise.all([
      regionStats(ctx, 'before', region), regionStats(ctx, 'after', region),
    ]);
    const changed = Math.abs(after.mean - before.mean) > 3 || Math.abs(after.stdev - before.stdev) > 4;
    return {
      satisfied: changed,
      evidence: `below-click zone ${changed ? 'changed' : 'static'} ` +
        `(brightness ${before.mean.toFixed(0)}→${after.mean.toFixed(0)}, detail ${before.stdev.toFixed(1)}→${after.stdev.toFixed(1)})`,
    };
  },
};

const menuCollapse: PhysicsRule = {
  kind: 'menu_collapse',
  async check(ctx) {
    const verdict = await menuExpand.check(ctx);
    // 无焦点等 not-applicable 情形原样传递 —— 反转会把「无法判定」错成「已折叠」
    if (verdict.notApplicable) return verdict;
    return {
      satisfied: !verdict.satisfied,
      evidence: `menu area ${verdict.satisfied ? 'still changing (not collapsed)' : 'settled (collapsed)'}: ${verdict.evidence}`,
    };
  },
};

/**
 * 内容平移检测：把前后两帧各缩为 64 行亮度序列，找最优垂直错位量。
 * 正 shift = after 内容相对 before 下移；负 = 上移。这是滚动/拖拽的纯视觉签名。
 */
async function detectShift(ctx: PhysicsContext): Promise<number> {
  const A = await rowMeans(ctx, 'before', SHIFT_GRID);
  const B = await rowMeans(ctx, 'after', SHIFT_GRID);
  let bestShift = 0, bestErr = Infinity;
  for (let s = -8; s <= 8; s++) {
    let err = 0, n = 0;
    for (let y = 0; y < SHIFT_GRID; y++) {
      const y2 = y + s;
      if (y2 < 0 || y2 >= SHIFT_GRID) continue;
      err += Math.abs(A[y] - B[y2]);
      n++;
    }
    if (n > 0 && err / n < bestErr) { bestErr = err / n; bestShift = s; }
  }
  return bestShift;
}

/** 内容上移 = 用户向下滚动看到新内容（after 行序列相对 before 上移） */
const scrollContentUp: PhysicsRule = {
  kind: 'scroll_content_up',
  async check(ctx) {
    const s = await detectShift(ctx);
    return {
      satisfied: s <= -2,
      evidence: `content shifted ${s <= -2 ? 'upward' : s >= 2 ? 'downward (opposite of expectation)' : 'negligibly'} (row offset ${s})`,
    };
  },
};

const scrollContentDown: PhysicsRule = {
  kind: 'scroll_content_down',
  async check(ctx) {
    const s = await detectShift(ctx);
    return {
      satisfied: s >= 2,
      evidence: `content shifted ${s >= 2 ? 'downward' : s <= -2 ? 'upward (opposite of expectation)' : 'negligibly'} (row offset ${s})`,
    };
  },
};

/** 输入聚焦：光标出现/边框高亮 = 极小邻域微变但大邻域静止 */
const inputFocus: PhysicsRule = {
  kind: 'input_focus',
  async check(ctx) {
    if (!ctx.focus) return { satisfied: false, evidence: 'no focus point', notApplicable: true };
    const rSmall = focusRegionNorm(ctx.focus.x, ctx.focus.y, Math.max(0.005, ctx.regionRadius * 0.4));
    const rLarge = focusRegionNorm(ctx.focus.x, ctx.focus.y, ctx.regionRadius * 2.5);
    const [sBefore, sAfter, lBefore, lAfter] = await Promise.all([
      regionStats(ctx, 'before', rSmall), regionStats(ctx, 'after', rSmall),
      regionStats(ctx, 'before', rLarge), regionStats(ctx, 'after', rLarge),
    ]);
    const localChanged = Math.abs(sAfter.stdev - sBefore.stdev) > 1 || Math.abs(sAfter.mean - sBefore.mean) > 2;
    const largeStatic = Math.abs(lAfter.mean - lBefore.mean) < 6;
    return {
      satisfied: localChanged && largeStatic,
      evidence: `cursor zone ${localChanged ? 'micro-changed' : 'static'} while surroundings ${largeStatic ? 'static' : 'changed'} — ` +
        `${localChanged && largeStatic ? 'consistent with caret/focus appearance' : 'not a focus-like change'}`,
    };
  },
};

/** 规则注册表：数据驱动的单一事实源 */
const RULES: Record<string, PhysicsRule> = {
  toggle_on: toggleOn,
  toggle_off: toggleOff,
  menu_expand: menuExpand,
  menu_collapse: menuCollapse,
  scroll_content_up: scrollContentUp,
  scroll_content_down: scrollContentDown,
  input_focus: inputFocus,
};

/** 语义/委托类 kind：物理引擎不裁决，由既有通道处理 */
const NON_PHYSICS_KINDS = new Set(['text_appear', 'text_vanish', 'page_navigate', 'any_change']);

/**
 * 按配置取用启用的规则。
 * @param enabledKinds 逗号分隔的启用清单；空串 = 全部启用；未注册的 kind 静默忽略
 */
export function getEnabledPhysicsRules(enabledKinds: string): Map<ExpectationKind, PhysicsRule> {
  const out = new Map<ExpectationKind, PhysicsRule>();
  const allow = enabledKinds.split(',').map(s => s.trim()).filter(Boolean);
  for (const [kind, rule] of Object.entries(RULES)) {
    if (allow.length === 0 || allow.includes(kind)) out.set(kind as ExpectationKind, rule);
  }
  return out;
}

/** 解析工具参数中的期望声明（JSON 字符串或简写 kind 字符串）。
 *  J 纪元修正：JSON 分支与简写分支**同一 kind 词表校验** —— 旧实现 JSON 分支
 *  任意字符串直接 as 断言（两分支强度不对称），模型拼错 kind 会得到
 *  "貌似合法实为弃权" 的意图裁决；现在未知 kind ⇒ null（诚实缺席），
 *  下游零回归（无期望 = 不启用意图验证通道）。 */
export function parseExpectation(raw: string | undefined): IntentExpectation | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const isKnownKind = (k: unknown): k is ExpectationKind =>
    typeof k === 'string' && (k in RULES || NON_PHYSICS_KINDS.has(k as ExpectationKind));
  try {
    const obj = JSON.parse(s);
    if (obj && isKnownKind(obj.kind)) {
      // 无 text 时省键而非置 undefined —— 结构稳定，deepEqual/canonical 双友好
      return {
        kind: obj.kind,
        ...(typeof obj.text === 'string' ? { text: obj.text } : {}),
      };
    }
  } catch { /* 非 JSON：尝试整串作为 kind 简写 */ }
  if (isKnownKind(s)) {
    return { kind: s };
  }
  return null;
}
