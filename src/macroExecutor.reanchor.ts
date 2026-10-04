// src/macroExecutor.reanchor.ts
// W6-2（doctor smell.over-engineering 清偿）：自 macroExecutor.ts 低风险分区提取
// （>500 行拆分信号）—— W4-1 重锚定非盲重放（元素标签 + IoU 双通道证据源）
// 整体搬迁。纯逻辑零外部依赖，行为零变化；macroExecutor.ts 以再导出保持导入面
// 不变（w4macro 测试与 runtime/skillTools 宿主零改动）。

// ─── W4-1：重锚定（元素标签 + IoU 双通道的证据源） ───

/** W4-1：锚点元素（当前帧证据 —— 归一化坐标域，与沙箱 VirtualWidget 同系） */
export interface MacroAnchorElement {
  label: string;
  /** 归一化 bbox ∈ [0,1] */
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** W4-1：重锚定请求（原坐标 + 可选标签提示 —— 技能步的 target_description
 *  或宏参数 target） */
export interface ReanchorRequest {
  x: number;
  y: number;
  label?: string;
}

/** W4-1：重锚定命中（新坐标 + 通道归因） */
export interface ReanchorHit {
  x: number;
  y: number;
  label: string;
  via: 'label' | 'iou' | 'contain';
}

/** W4-1：重锚定端口（注入缝 —— 生产由宿主接当前帧元素；测试传纯函数） */
export type ReanchorPort = (
  req: ReanchorRequest,
  anchors: ReadonlyArray<MacroAnchorElement>,
) => ReanchorHit | null;

/** W4-1：IoU 匹配门（elementTracker IOU_MATCH 同律 —— 控件半重叠仍可认） */
export const REANCHOR_IOU_GATE = 0.4;
/** W4-1：IoU 通道代理窗边长域（随候选元素短边自适应，夹 [窗下限, 窗上限]） */
export const REANCHOR_WINDOW_MIN = 0.04;
export const REANCHOR_WINDOW_MAX = 0.2;

const foldLabel = (s: unknown): string =>
  typeof s === 'string' ? s.toLowerCase().replace(/\s+/g, ' ').trim() : '';

/** W4-1：bbox 的 IoU（elementTracker.iou 同构 —— 纯归一化域） */
function iouNorm(
  a: { x0: number; y0: number; x1: number; y1: number },
  b: { x0: number; y0: number; x1: number; y1: number },
): number {
  const ix0 = Math.max(a.x0, b.x0), iy0 = Math.max(a.y0, b.y0);
  const ix1 = Math.min(a.x1, b.x1), iy1 = Math.min(a.y1, b.y1);
  const inter = Math.max(0, ix1 - ix0) * Math.max(0, iy1 - iy0);
  if (inter <= 0) return 0;
  const areaA = (a.x1 - a.x0) * (a.y1 - a.y0);
  const areaB = (b.x1 - b.x0) * (b.y1 - b.y0);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * W4-1：缺省重锚定端口（纯函数、确定性、绝不抛）—— 三通道按序裁决：
 *   ① label：请求携带标签且与锚点元素标签折叠相等 ⇒ 该元素当前中心
 *     （标签是跨帧最稳的同一性证据 —— 控件挪了位，字没变）；
 *   ② iou：原坐标扩展为 REANCHOR_WINDOW 代理窗，与各元素 bbox 算 IoU，
 *     最大且 ≥ REANCHOR_IOU_GATE（elementTracker 阈值同律）⇒ 该元素中心
 *     （小控件对窗 IoU 高、大容器天然低 —— 点按钮不被吸进背景面板）；
 *   ③ contain：原坐标仍落在某元素 bbox 内 ⇒ 取**面积最小**的包含元素
 *     （最具体控件 —— 大目标的点语义退化通道）；
 *   三通道皆空 ⇒ null（重锚定失败 —— 调用方降级跳过，绝不盲点）。
 */
export function defaultReanchor(
  req: ReanchorRequest,
  anchors: ReadonlyArray<MacroAnchorElement>,
): ReanchorHit | null {
  if (!Array.isArray(anchors) || anchors.length === 0) return null;
  if (typeof req.x !== 'number' || !Number.isFinite(req.x)) return null;
  if (typeof req.y !== 'number' || !Number.isFinite(req.y)) return null;
  const valid = anchors.filter(a =>
    a && typeof a.label === 'string' &&
    [a.bbox?.x0, a.bbox?.y0, a.bbox?.x1, a.bbox?.y1].every(v => typeof v === 'number' && Number.isFinite(v)));
  if (valid.length === 0) return null;
  const center = (b: { x0: number; y0: number; x1: number; y1: number }) =>
    ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });

  // ① 标签通道（精确折叠相等）
  const want = foldLabel(req.label);
  if (want !== '') {
    const byLabel = valid.find(a => foldLabel(a.label) === want);
    if (byLabel) {
      const c = center(byLabel.bbox);
      return { x: c.x, y: c.y, label: byLabel.label, via: 'label' };
    }
  }

  // ② IoU 通道（点窗 vs 元素框 —— 最大者过门）。窗边长随候选元素自适应
  //（元素短边，夹 [REANCHOR_WINDOW_MIN, REANCHOR_WINDOW_MAX]）：以点为中心、
  // 与元素同尺度的代理框 ⇒ IoU 度量「点离该元素多近」（点居中 ⇒ ~side²/面积；
  // 偏出 ⇒ 骤降）。大容器天然低分（窗被上限压制）—— 点按钮不被吸进背景面板。
  let bestIou = 0;
  let bestIouEl: MacroAnchorElement | undefined;
  for (const a of valid) {
    const b = a.bbox;
    const side = Math.min(REANCHOR_WINDOW_MAX, Math.max(REANCHOR_WINDOW_MIN, Math.min(b.x1 - b.x0, b.y1 - b.y0)));
    const win = {
      x0: req.x - side / 2, y0: req.y - side / 2,
      x1: req.x + side / 2, y1: req.y + side / 2,
    };
    const v = iouNorm(win, b);
    if (v > bestIou) { bestIou = v; bestIouEl = a; }
  }
  if (bestIouEl && bestIou >= REANCHOR_IOU_GATE) {
    const c = center(bestIouEl.bbox);
    return { x: c.x, y: c.y, label: bestIouEl.label, via: 'iou' };
  }

  // ③ 包含通道（点在框内 —— 最小面积 = 最具体控件）
  let bestArea = Infinity;
  let bestContain: MacroAnchorElement | undefined;
  for (const a of valid) {
    const b = a.bbox;
    if (req.x >= b.x0 && req.x <= b.x1 && req.y >= b.y0 && req.y <= b.y1) {
      const area = (b.x1 - b.x0) * (b.y1 - b.y0);
      if (area < bestArea) { bestArea = area; bestContain = a; }
    }
  }
  if (bestContain) {
    const c = center(bestContain.bbox);
    return { x: c.x, y: c.y, label: bestContain.label, via: 'contain' };
  }
  return null;
}
