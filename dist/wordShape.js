/** OCR 词元几何先验（探针缺席时的降级判据，也用于排序探针目标）：
    宽行/多行 ⇒ 正文（聊天消息/文档段落）；紧凑短标签 ⇒ 控件候选。 */
export function classifyWordShape(w) {
    const width = w.bbox_normalized.x1 - w.bbox_normalized.x0;
    const height = w.bbox_normalized.y1 - w.bbox_normalized.y0;
    // 整行宽（聊天气泡/正文行）或多行高（段落块）⇒ 正文
    if (width >= 0.45 || height >= 0.055)
        return 'content-like';
    // 紧凑短标签：按钮/链接的典型形状
    if (width <= 0.16 && height <= 0.03)
        return 'control-like';
    return 'ambiguous';
}
