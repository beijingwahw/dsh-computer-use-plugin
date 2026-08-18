// src/visualDiff.ts
// 第四轮创新之一：视觉差分引擎（what-changed-where）。
// 模型自己对比两张整屏截图既费 Token 又容易看漏；本引擎在像素层直接算出
// 「哪些区域变了」：降采样 → 逐像素差 → 分块聚合 → 连通域合并 → 变化区域清单。
// 输出归一化坐标的变化框，可叠加红框渲染成差分图 —— 模型一眼看到变化在哪。
import sharp from 'sharp';
const DIFF_WIDTH = 480; // 差分分辨率：够定位，无需高清
const PIXEL_THRESHOLD = 70; // RGB 三通道差之和超此值算变化（容忍 JPEG 噪声）
export async function computeDiffRegions(beforeBuf, afterBuf, tileCols = 16) {
    const afterMeta = await sharp(afterBuf).metadata();
    const W = DIFF_WIDTH;
    const H = Math.max(1, Math.round(W * (afterMeta.height / afterMeta.width)));
    const [a, b] = await Promise.all([
        sharp(beforeBuf).resize(W, H, { fit: 'fill' }).raw().toBuffer(),
        sharp(afterBuf).resize(W, H, { fit: 'fill' }).raw().toBuffer(),
    ]);
    // 分块变化图：像素级变化累积到块级，天然过滤零星噪点
    const rows = Math.max(6, Math.round(tileCols * H / W));
    const tileW = Math.max(1, Math.floor(W / tileCols));
    const tileH = Math.max(1, Math.floor(H / rows));
    const changedTiles = new Uint8Array(tileCols * rows);
    let totalChanged = 0;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
            if (d > PIXEL_THRESHOLD) {
                totalChanged++;
                const ty = Math.min(rows - 1, Math.floor(y / tileH));
                const tx = Math.min(tileCols - 1, Math.floor(x / tileW));
                changedTiles[ty * tileCols + tx] = 1;
            }
        }
    }
    const changedFraction = totalChanged / (W * H);
    // 连通域合并（4 邻域）：相邻变化块聚成区域
    const visited = new Uint8Array(tileCols * rows);
    const regions = [];
    for (let t = 0; t < tileCols * rows; t++) {
        if (!changedTiles[t] || visited[t])
            continue;
        const queue = [t];
        visited[t] = 1;
        let minX = tileCols, minY = rows, maxX = 0, maxY = 0, tiles = 0;
        while (queue.length) {
            const cur = queue.pop();
            const cx = cur % tileCols, cy = Math.floor(cur / tileCols);
            tiles++;
            minX = Math.min(minX, cx);
            maxX = Math.max(maxX, cx);
            minY = Math.min(minY, cy);
            maxY = Math.max(maxY, cy);
            const nb = [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]];
            for (const [nx, ny] of nb) {
                if (nx < 0 || ny < 0 || nx >= tileCols || ny >= rows)
                    continue;
                const ni = ny * tileCols + nx;
                if (changedTiles[ni] && !visited[ni]) {
                    visited[ni] = 1;
                    queue.push(ni);
                }
            }
        }
        regions.push({
            index: 0,
            bbox_normalized: { x0: minX / tileCols, y0: minY / rows, x1: (maxX + 1) / tileCols, y1: (maxY + 1) / rows },
            center: { x: (minX + maxX + 1) / 2 / tileCols, y: (minY + maxY + 1) / 2 / rows },
            tiles_changed: tiles,
        });
    }
    regions.sort((r1, r2) => r2.tiles_changed - r1.tiles_changed);
    regions.forEach((r, i) => { r.index = i + 1; });
    return {
        regions,
        changed_fraction_pct: Math.round(changedFraction * 1000) / 10,
        identical: changedFraction < 0.001,
    };
}
/** 把变化区域以红色虚线框 + Δ编号 渲染到 after 图上（差分可视化） */
export async function renderDiffOverlay(afterBuf, regions) {
    const meta = await sharp(afterBuf).metadata();
    const W = meta.width, H = meta.height;
    const boxes = regions.slice(0, 12).map(r => {
        const x = Math.round(r.bbox_normalized.x0 * W), y = Math.round(r.bbox_normalized.y0 * H);
        const w = Math.max(8, Math.round((r.bbox_normalized.x1 - r.bbox_normalized.x0) * W));
        const h = Math.max(8, Math.round((r.bbox_normalized.y1 - r.bbox_normalized.y0) * H));
        const label = `Δ${r.index}`;
        const labelW = label.length * 9 + 8;
        return (`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#FF3B30" stroke-width="3" stroke-dasharray="8,4" />` +
            `<rect x="${x}" y="${Math.max(0, y - 20)}" width="${labelW}" height="20" fill="#FF3B30" />` +
            `<text x="${x + 4}" y="${Math.max(14, y - 5)}" font-family="monospace" font-size="14" font-weight="bold" fill="#fff">${label}</text>`);
    }).join('');
    const svg = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${boxes}</svg>`);
    return sharp(afterBuf).composite([{ input: svg, top: 0, left: 0 }]).png().toBuffer();
}
