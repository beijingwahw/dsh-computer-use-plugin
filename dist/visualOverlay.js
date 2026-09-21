// src/visualOverlay.ts
// SoM (Set-of-Mark) 视觉辅助层。用 sharp 在向量域组装 SVG、光栅域只合成一次。
// 融合补全原版两大缺失：readme 承诺的 10x10 网格与绿色十字准星（原代码注释「此处省略」）；
// 修复地层 bug：<text> 空标签导致编号不可见。
// 批次 E 迁移：sharp 懒动态导入（_legacyDeps.getSharp）。
import { getSharp } from './_legacyDeps.js';
/** XML 文本转义：label 来自外部 UI 数据，含 < & 等字符会破坏 SVG 结构 */
function escapeXml(s) {
    return s.replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch] ?? ch);
}
export async function addVisualOverlay(imageBuffer, options = {}) {
    const sharp = await getSharp();
    const metadata = await sharp(imageBuffer).metadata();
    const width = metadata.width;
    const height = metadata.height;
    let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
    // 1. SoM 网格：给模型的「坐标尺」。半透明蓝线在任何底色上可见且不喧宾夺主
    const divisions = options.gridDivisions ?? 0;
    if (divisions > 1) {
        for (let i = 1; i < divisions; i++) {
            const gx = Math.round((width / divisions) * i);
            const gy = Math.round((height / divisions) * i);
            svg += `<line x1="${gx}" y1="0" x2="${gx}" y2="${height}" stroke="rgba(0,120,255,0.30)" stroke-width="1" />`;
            svg += `<line x1="0" y1="${gy}" x2="${width}" y2="${gy}" stroke="rgba(0,120,255,0.30)" stroke-width="1" />`;
        }
    }
    // 2. 绿色十字准星：模型的「本体感觉」—— 让它知道鼠标当前在哪
    if (options.crosshair) {
        // P 纪元修正（第十四只 bug）：全局虚拟屏坐标（多显示器可为负/越本屏）与
        // 截图本地缓冲是两个坐标域；旧实现夹取 ⇒ 鼠标在副屏时准星钉死在本屏边缘
        // —— 一个自信的错位 grounding 信号。诚实缺席律：域外（±2px 容差）不画
        // —— 「不知道在哪」远好于「 confidently 错在哪」。
        const rx = Math.round(options.crosshair.x);
        const ry = Math.round(options.crosshair.y);
        const inBounds = rx >= -2 && ry >= -2 && rx <= width + 2 && ry <= height + 2;
        if (inBounds) {
            const cx = Math.max(0, Math.min(width, rx));
            const cy = Math.max(0, Math.min(height, ry));
            svg += `<line x1="${cx}" y1="0" x2="${cx}" y2="${height}" stroke="rgba(0,204,102,0.55)" stroke-width="1" />`;
            svg += `<line x1="0" y1="${cy}" x2="${width}" y2="${cy}" stroke="rgba(0,204,102,0.55)" stroke-width="1" />`;
            svg += `<circle cx="${cx}" cy="${cy}" r="6" fill="none" stroke="#00CC66" stroke-width="2" />`;
        }
    }
    // 3. 元素边框 + 编号标签：半透明填充不遮挡内容，纯色描边保证可见（标注与原画面共存）
    for (const el of options.elements ?? []) {
        const { x, y, width: w, height: h } = el.rect;
        // J 纪元防御：外部 UI 数据可能携带 NaN/负宽高 —— 直接内插会产生非法 SVG
        // （sharp 合成行为未定义）。与准星同律夹取；NaN/非正尺寸 ⇒ 跳过该元素
        // （诚实缺席优于毒化整张叠加图）。
        if (![x, y, w, h].every(Number.isFinite))
            continue;
        if (w <= 0 || h <= 0)
            continue;
        const ex = Math.max(0, Math.min(width - 1, x));
        const ey = Math.max(0, Math.min(height - 1, y));
        const ew = Math.max(1, Math.min(width - ex, w));
        const eh = Math.max(1, Math.min(height - ey, h));
        svg += `<rect x="${ex}" y="${ey}" width="${ew}" height="${eh}" fill="rgba(0,120,255,0.1)" stroke="#0078FF" stroke-width="2" />`;
        // 标签宽度按文本长度自适应（1 位到 2 位编号的边界都算到了）
        const text = escapeXml(String(el.label));
        const labelW = text.length * 10 + 10;
        const labelY = Math.max(0, ey - 20); // 顶部越界时回落到框内上沿
        svg += `<rect x="${ex}" y="${labelY}" width="${labelW}" height="20" fill="#0078FF" />`;
        // 修复原地层 bug：<text> 内容为空导致编号丢失
        svg += `<text x="${ex + 5}" y="${labelY + 15}" fill="white" font-size="14" font-family="Arial">${text}</text>`;
    }
    svg += `</svg>`;
    return await sharp(imageBuffer)
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
        .png()
        .toBuffer();
}
