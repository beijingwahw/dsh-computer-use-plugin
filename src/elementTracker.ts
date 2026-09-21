// src/elementTracker.ts
// R 纪元（R-5 视觉层）：跨帧稳定元素 ID —— IoU 贪心跟踪器官。
//
// 问题：叠加图元素标签每帧重铸（帧 1 的 "3" 与帧 2 的 "3" 未必是同一控件）
// ⇒ 模型的「点 3 号」指令跨帧漂移，click_element 的 ID 语义每帧作废。
// 数学：交并比 IoU(a,b) = |a∩b|/|a∪b|；贪心二部图匹配（对偶按 IoU 降序
// 择配，阈值 0.4 —— 控件半重叠仍可跟，全移位不误认）配连续性代价 O(n²)，
// n = 屏上元素数（<50），微秒级。匈牙利指派是全局最优但 O(n³) —— 贪心在
// 此域（控件稀疏、IoU 邻域少冲突）与全局解几乎重合，工程可审计优先。
// 标签稳定性 = 帧间连续性的直接兑现：同一物理控件跨帧保号；消失 5 帧后
// 号码退役（防号码无限膨胀 + 复活误连）。
// 纯模块（跨调用记忆 —— 与 focusTracker 同生命周期形态）；reset 归零。

export interface TrackedRect { x: number; y: number; width: number; height: number }

interface Track { label: number; rect: TrackedRect; missed: number }

const IOU_MATCH = 0.4;
const MAX_MISSED = 5;

let tracks: Track[] = [];
let nextLabel = 1;

function iou(a: TrackedRect, b: TrackedRect): number {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (inter <= 0) return 0;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * 跟踪一帧：输入本帧元素矩形（任意顺序），输出**稳定标签**（同一物理
 * 控件跨帧保号）。纯确定性（贪心序：IoU 降序，平手取先出现者）。
 */
export function trackElements(rects: readonly TrackedRect[]): number[] {
  const valid = rects.filter(r =>
    [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0);
  // 候配偶：(trackIdx, rectIdx, iou) —— 阈值以上按 IoU 降序贪心
  const pairs: Array<{ t: number; r: number; v: number }> = [];
  for (let t = 0; t < tracks.length; t++) {
    for (let r = 0; r < valid.length; r++) {
      const v = iou(tracks[t].rect, valid[r]);
      if (v >= IOU_MATCH) pairs.push({ t, r, v });
    }
  }
  pairs.sort((a, b) => b.v - a.v || a.t - b.t || a.r - b.r);
  const trackTaken = new Set<number>(), rectTaken = new Set<number>();
  const assign = new Map<number, number>(); // rectIdx → trackIdx
  for (const p of pairs) {
    if (trackTaken.has(p.t) || rectTaken.has(p.r)) continue;
    trackTaken.add(p.t); rectTaken.add(p.r);
    assign.set(p.r, p.t);
  }
  // 更新：命中轨更新矩形 + missed=0；未命中轨 missed++（≤MAX_MISSED 保留）
  const out: number[] = [];
  const newTracks: Track[] = [];
  for (let r = 0; r < valid.length; r++) {
    const t = assign.get(r);
    if (t !== undefined) {
      tracks[t].rect = valid[r];
      tracks[t].missed = 0;
      newTracks.push(tracks[t]);
      out.push(tracks[t].label);
    } else {
      const tr: Track = { label: nextLabel++, rect: valid[r], missed: 0 };
      newTracks.push(tr);
      out.push(tr.label);
    }
  }
  // 消失轨保留窗口（短暂遮挡/滚动后回归可续号）
  for (let t = 0; t < tracks.length; t++) {
    if (trackTaken.has(t)) continue;
    tracks[t].missed += 1;
    if (tracks[t].missed <= MAX_MISSED) newTracks.push(tracks[t]);
  }
  tracks = newTracks;
  return out;
}

/** 生命周期归零（插件卸载 / 测试隔离） */
export function resetElementTracker(): void {
  tracks = [];
  nextLabel = 1;
}
