// src/wordShape.ts
// OCR 词元几何先验（Z-1 铸造，Z-2 迁出为纯模块）：
//   宽行/多行 ⇒ 正文（聊天消息/文档段落）；紧凑短标签 ⇒ 控件候选。
//
// 迁出动机（Z-2）：反射弧场景源（knowledge/stations.ts L2 OCR 路径）需要
// 同一判据过滤正文词，但工位桩红线是「零二进制依赖」—— interactivityProbe.ts
// 顶部即 import physicalBackend，直接引入会污染桩纪元纯度。判据是无依赖
// 纯函数，独立成模块后两个世界共享同一把尺子（单一事实源），不复制实现。
import type { OcrWord } from './textReader';

export type WordShape = 'control-like' | 'content-like' | 'ambiguous';

/** OCR 词元几何先验（探针缺席时的降级判据，也用于排序探针目标）：
    宽行/多行 ⇒ 正文（聊天消息/文档段落）；紧凑短标签 ⇒ 控件候选。 */
export function classifyWordShape(w: OcrWord): WordShape {
  const width = w.bbox_normalized.x1 - w.bbox_normalized.x0;
  const height = w.bbox_normalized.y1 - w.bbox_normalized.y0;
  // 整行宽（聊天气泡/正文行）或多行高（段落块）⇒ 正文
  if (width >= 0.45 || height >= 0.055) return 'content-like';
  // 紧凑短标签：按钮/链接的典型形状
  if (width <= 0.16 && height <= 0.03) return 'control-like';
  return 'ambiguous';
}
