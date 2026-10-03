import { getSharp } from '../_legacyDeps.js';
// W1-7 只读依赖：wordShape（纯模块，type-only 依赖 textReader 无运行时污染）、
// semanticHash（零模型零网络的 subword 余弦）。注意：绝不 import
// interactivityProbe（其顶部即拉 physicalBackend，会污染云端纯度）—— 交互
// 置信由调用方以数值传入 scores。
import { classifyWordShape } from '../wordShape.js';
import { cosine, embed } from '../semanticHash.js';
/** XML 文本转义：外部数据含 < & " 等字符会破坏 SVG 结构（同 visualOverlay） */
function escapeXml(s) {
    return s.replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch] ?? ch);
}
/**
 * PNG 头嗅探尺寸（不依赖 sharp）：签名 8 字节后第一个块必为 IHDR，
 * 宽在 offset 16、高在 offset 20（大端）。非 PNG / 残缺头返回 null。
 * 用途：plain 路径（无 marker 原样返回）也要给下游提示词提供宽高。
 */
function sniffPngSize(buffer) {
    if (buffer.length < 24)
        return null;
    if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47)
        return null;
    if (buffer.toString('ascii', 12, 16) !== 'IHDR')
        return null;
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
        return null;
    return { width, height };
}
/** W1-7: clamp 到 [0,1]；非有限数按 0（无证据不加分） */
function clamp01(v) {
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
export function selectSparseMarkers(markers, scores, budget) {
    const all = Array.isArray(markers) ? markers : [];
    if (!Number.isFinite(budget) || budget < 0)
        return { markers: all, fallback: true };
    const k = Math.min(all.length, Math.floor(budget));
    if (k >= all.length)
        return { markers: all, fallback: false };
    const sc = Array.isArray(scores) ? scores : [];
    const hasConf = sc.some(s => s && Number.isFinite(s.confidence));
    const hasRel = sc.some(s => s && Number.isFinite(s.relevance));
    if (!hasConf && !hasRel)
        return { markers: all, fallback: true };
    const weightOf = (i) => {
        const s = i < sc.length ? sc[i] : undefined;
        const c = hasConf ? clamp01(s?.confidence) : 1; // 通道缺席 = 中性 1（不扭曲另一通道）
        const r = hasRel ? clamp01(s?.relevance) : 1;
        return c * r;
    };
    const ranked = all
        .map((_, i) => ({ i, w: weightOf(i) }))
        .sort((a, b) => b.w - a.w || a.i - b.i); // 权重降序，平手原始下标升序
    const keep = new Set(ranked.slice(0, k).map(e => e.i));
    const picked = [];
    const weights = [];
    for (let i = 0; i < all.length; i++) {
        if (keep.has(i)) {
            picked.push(all[i]);
            weights.push(weightOf(i));
        }
    }
    return { markers: picked, fallback: false, weights };
}
/** 标签芯片与元素框的间隙（像素）—— 芯片永不压自己的框 */
const SOM_LABEL_GAP = 4;
/** 标签芯片高度（与传统路径的 20px 一致） */
const SOM_LABEL_HEIGHT = 20;
/** 四向试探序 = 平手裁决序（W1-7 规格固定：上/下/左/右） */
const SOM_LABEL_DIRS = ['up', 'down', 'left', 'right'];
/** 芯片几何：up/down 与框左对齐，left/right 与框顶对齐（全部水平文本，不旋转） */
function labelChipRect(dir, box, labelW, labelH) {
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
function interArea(a, b) {
    const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    return w > 0 && h > 0 ? w * h : 0;
}
/** 芯片完整落在画幅内（出画幅 = 不可读，等同冲突处理） */
function chipInCanvas(r, W, H) {
    return r.x0 >= 0 && r.y0 >= 0 && r.x1 <= W && r.y1 <= H;
}
/** 引线端点：芯片中点 → 夹到框范围内的锚点（确定性整数几何） */
function leaderFor(dir, chip, box) {
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
export function routeLabelPlacement(box, labelW, labelH, W, H, occupied) {
    const lw = Number.isFinite(labelW) && labelW > 0 ? Math.round(labelW) : 20;
    const lh = Number.isFinite(labelH) && labelH > 0 ? Math.round(labelH) : SOM_LABEL_HEIGHT;
    if (![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)) {
        return { direction: null, rect: { ...box }, leader: null }; // 防御：垃圾输入不抛
    }
    const occ = Array.isArray(occupied) ? occupied : [];
    // 律 1：方向序 first-fit
    for (const d of SOM_LABEL_DIRS) {
        const rect = labelChipRect(d, box, lw, lh);
        if (chipInCanvas(rect, W, H) && occ.every(o => interArea(rect, o) === 0)) {
            return { direction: d, rect, leader: leaderFor(d, rect, box) };
        }
    }
    // 律 2：四向全冲突 → 最小重叠面积（平手按方向序）
    let bestDir = null;
    let bestRect = null;
    let bestArea = Infinity;
    for (const d of SOM_LABEL_DIRS) {
        const rect = labelChipRect(d, box, lw, lh);
        if (!chipInCanvas(rect, W, H))
            continue;
        let area = 0;
        for (const o of occ)
            area += interArea(rect, o);
        if (area < bestArea) {
            bestDir = d;
            bestRect = rect;
            bestArea = area;
        }
    }
    if (bestDir !== null && bestRect !== null) {
        return { direction: bestDir, rect: bestRect, leader: leaderFor(bestDir, bestRect, box) };
    }
    // 律 3：传统位几何（与旧路径 labelY 规则逐字节一致：顶越界回落框内上沿）
    const legacyRect = {
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
function hsvToHex(hDeg, s, v) {
    const c = v * s;
    const hp = (((hDeg % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const rgb = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
        : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
    const m = v - c;
    const hex = (t) => Math.round((t + m) * 255).toString(16).padStart(2, '0').toUpperCase();
    return `#${hex(rgb[0])}${hex(rgb[1])}${hex(rgb[2])}`;
}
/** W1-7: 稳定染色调色板 —— 16 色 HSV 均匀分布（hue 步进 360/16、s=0.85、v=1） */
export const SOM_COLOR_PALETTE = Object.freeze(Array.from({ length: SOM_PALETTE_SIZE }, (_, i) => hsvToHex((i * 360) / SOM_PALETTE_SIZE, 0.85, 1)));
/** W1-7: 32 位 FNV-1a（与 semanticHash 同族；其未导出，本地五行复刻） */
function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
/** W1-7: 稳定染色 —— key 短哈希取调色板（同 key 恒同色，跨帧稳定，零随机） */
export function stableColor(key) {
    return SOM_COLOR_PALETTE[fnv1a(key) % SOM_PALETTE_SIZE];
}
/**
 * W1-7: wordShape 染色键（纯函数）—— 形状分类 + 归一化文本。
 * 用 marker 自身 bbox 按画幅归一化后过 classifyWordShape（wordShape.ts 的
 * 同一把尺子），键 = `${shape}|${小写去空文本}`：同文本同形状 ⇒ 同键 ⇒ 同色，
 * 与帧序、marker id、坐标微移无关（跨帧稳定的全部来源）。
 */
export function somColorKey(marker, width, height) {
    const W = Number.isFinite(width) && width > 0 ? width : 1;
    const H = Number.isFinite(height) && height > 0 ? height : 1;
    const fin = (v, fb) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
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
    try {
        shape = classifyWordShape(word);
    }
    catch { /* 防御：wordShape 异常不毒化染色 */ }
    return `${shape}|${text.trim().toLowerCase()}`;
}
/**
 * W1-7: 任务语义相关度（纯函数，0..1）—— semanticHash 余弦。
 * 集成接线一行：scores[i].relevance = taskRelevance(marker.text, 任务指令)。
 * 空文本/任何异常诚实回 0（无证据不是坏证据）。
 */
export function taskRelevance(label, task) {
    try {
        if (!label || !task)
            return 0;
        return cosine(embed(label), embed(task));
    }
    catch {
        return 0;
    }
}
/**
 * W5-4: scores 组装（纯函数，绝不抛）—— 生产调用面的 W1-7 集成接线成形：
 *   scores[i] = { confidence: seed.probeConfidence（有限才在场）,
 *                relevance: taskRelevance(seed.text, task)（文本与任务都在场才在场） }
 * 证据通道缺席时**省略键**（而非填 0）—— 保住 selectSparseMarkers 的通道
 * 在场语义（两通道皆缺席 ⇒ 诚实回退全量，见其 fallback 臂）：taskRelevance
 * 对空输入回 0，但「0 分」与「无证据」在名额分配里是两种决策（前者参与
 * Top-K 竞争，后者触发全量回退），组装层不得混淆。非数组入参回 []（防御）。
 */
export function assembleSomScores(seeds, task) {
    if (!Array.isArray(seeds))
        return [];
    const taskText = typeof task === 'string' ? task : '';
    return seeds.map(s => {
        const rec = (s ?? {});
        const conf = rec.probeConfidence;
        const text = typeof rec.text === 'string' && rec.text.trim() !== '' ? rec.text : '';
        return {
            ...(typeof conf === 'number' && Number.isFinite(conf) ? { confidence: conf } : {}),
            ...(text !== '' && taskText !== '' ? { relevance: taskRelevance(text, taskText) } : {}),
        };
    });
}
/**
 * SoM 叠加渲染：在每个 marker 的 bbox 上画描边矩形 + 左上角编号标签
 * （可选网格，默认不画），sharp composite 一次合成。
 * - markers 为空/缺省：原样返回（strategy 'plain'），尺寸由 PNG 头嗅探（非 PNG 则省略）
 * - sharp 不可用 / 任何失败：返回 ok:false + error，绝不抛异常
 * - 非法 marker（NaN / 非正尺寸 / 越界到不可见）：跳过该锚点，不毒化整图
 * W1-7 三个 opt-in 扩展（默认全关，与旧行为逐字节兼容）：
 * - sparseBudget + scores：名额按「交互置信 × 语义相关度」加权 Top-K；
 *   证据缺席时诚实回退全量（结果面 sparseFallback=true 可观测）
 * - routeLabels：标签四向避让 + 引线（决策记录在结果面 labelDirections）
 * - stableColors：wordShape 短哈希染色（逐元素色记录在结果面 colors）
 * 确定性：同输入同输出逐字节一致（整数几何、固定序、零随机零时钟）。
 */
export async function renderSomOverlay(buffer, opts) {
    try {
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
            return { ok: false, error: 'renderSomOverlay: 输入必须是非空 Buffer' };
        }
        const markers = Array.isArray(opts?.markers) ? opts.markers : [];
        // W1-7: 稀疏名额分配（opt-in；证据缺席/预算非法 → 诚实回退全量）
        let renderMarkers = markers;
        let sparseFallback;
        const budgetRaw = opts?.sparseBudget;
        if (markers.length > 0 && Number.isFinite(budgetRaw) && budgetRaw >= 0) {
            const sel = selectSparseMarkers(markers, opts?.scores, Math.floor(budgetRaw));
            renderMarkers = sel.markers;
            sparseFallback = sel.fallback;
        }
        if (renderMarkers.length === 0) {
            // plain：无锚点即无叠加 —— 原样透传，尺寸尽力嗅探
            // （含「请求了 markers 但预算为 0」的显式清空：selected=[] 如实上报）
            const size = sniffPngSize(buffer);
            const extra = markers.length > 0
                ? { selected: [], ...(sparseFallback !== undefined ? { sparseFallback } : {}) }
                : {};
            return size
                ? { ok: true, buffer, width: size.width, height: size.height, ...extra }
                : { ok: true, buffer, ...extra };
        }
        const sharp = await getSharp();
        const meta = await sharp(buffer).metadata();
        const W = meta.width;
        const H = meta.height;
        if (!W || !H) {
            return { ok: false, error: 'renderSomOverlay: 无法读取图像尺寸（非图像输入？）' };
        }
        const color = escapeXml(typeof opts?.color === 'string' && opts.color ? opts.color : '#00FF66');
        const swRaw = opts?.strokeWidth;
        const strokeWidth = Number.isFinite(swRaw) && swRaw > 0 ? swRaw : 3;
        let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
        // 可选网格：沿用本地路径的半透明蓝（密度>1 才画；VLM 默认不需要）
        const densityRaw = opts?.gridDensity ?? 0;
        const divisions = Number.isFinite(densityRaw) ? Math.min(64, Math.floor(densityRaw)) : 0;
        if (divisions > 1) {
            for (let i = 1; i < divisions; i++) {
                const gx = Math.round((W / divisions) * i);
                const gy = Math.round((H / divisions) * i);
                svg += `<line x1="${gx}" y1="0" x2="${gx}" y2="${H}" stroke="rgba(0,120,255,0.30)" stroke-width="1" />`;
                svg += `<line x1="0" y1="${gy}" x2="${W}" y2="${gy}" stroke="rgba(0,120,255,0.30)" stroke-width="1" />`;
            }
        }
        // W1-7: 新能力开关与可观测面（默认全关 —— 旧路径逐字节不变）
        const routeLabels = opts?.routeLabels === true;
        const stableColorsOn = opts?.stableColors === true;
        const occupied = []; // 已占矩形：已标 bbox + 已放标签芯片（渲染序累积）
        const selected = [];
        const labelDirections = [];
        const colors = [];
        for (const m of renderMarkers) {
            if (!m || !m.bbox)
                continue;
            const { x0, y0, x1, y1 } = m.bbox;
            // 防御：NaN / 非正尺寸直接跳过（同 visualOverlay 的 J 纪元防御律）
            if (![x0, y0, x1, y1].every(Number.isFinite))
                continue;
            if (!(x1 > x0) || !(y1 > y0))
                continue;
            // 与画幅零交集的锚点整只跳过（docstring「越界到不可见：跳过」的执法）——
            // 先夹取会把幻觉坐标钉成边缘 1×1 框 + 编号标签，制造"自信地错位"的假锚点
            if (x1 <= 0 || y1 <= 0 || x0 >= W || y0 >= H)
                continue;
            const bx0 = Math.max(0, Math.min(W - 1, Math.round(x0)));
            const by0 = Math.max(0, Math.min(H - 1, Math.round(y0)));
            const bx1 = Math.max(0, Math.min(W, Math.round(x1)));
            const by1 = Math.max(0, Math.min(H, Math.round(y1)));
            if (bx1 - bx0 < 1 || by1 - by0 < 1)
                continue;
            // W1-7: 边框色 —— stableColors 开启时按 wordShape 键取稳定调色板色
            // （调色板色字面量安全无需转义；自定义色沿用顶部已转义的 color）
            const stroke = stableColorsOn ? stableColor(somColorKey(m, W, H)) : color;
            svg += `<rect x="${bx0}" y="${by0}" width="${bx1 - bx0}" height="${by1 - by0}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" />`;
            // 编号标签（宽度按文本长度自适应）
            const text = escapeXml(String(m.id));
            const labelW = text.length * 10 + 10;
            if (routeLabels) {
                // W1-7: 抗遮挡路由 —— 四向避让 + 引线；decision null 回落传统位
                const boxRect = { x0: bx0, y0: by0, x1: bx1, y1: by1 };
                const route = routeLabelPlacement(boxRect, labelW, SOM_LABEL_HEIGHT, W, H, occupied);
                if (route.leader) {
                    svg += `<line x1="${route.leader.x1}" y1="${route.leader.y1}" x2="${route.leader.x2}" y2="${route.leader.y2}" stroke="${stroke}" stroke-width="1" />`;
                }
                svg += `<rect x="${route.rect.x0}" y="${route.rect.y0}" width="${route.rect.x1 - route.rect.x0}" height="${route.rect.y1 - route.rect.y0}" fill="${stroke}" />`;
                svg += `<text x="${route.rect.x0 + 5}" y="${route.rect.y0 + 15}" fill="white" font-size="14" font-family="Arial">${text}</text>`;
                labelDirections.push({ id: m.id, direction: route.direction ?? 'legacy' });
                // 本元素的框与芯片从此占用（后续标签避让的事实源；自身芯片因间隙不与之相交）
                occupied.push(boxRect, route.rect);
            }
            else {
                // 传统路径：框顶上方，顶部越界时回落到框内上沿（逐字节旧几何）
                const labelY = by0 >= 20 ? by0 - 20 : by0;
                svg += `<rect x="${bx0}" y="${labelY}" width="${labelW}" height="20" fill="${color}" />`;
                svg += `<text x="${bx0 + 5}" y="${labelY + 15}" fill="white" font-size="14" font-family="Arial">${text}</text>`;
            }
            selected.push(m.id);
            if (stableColorsOn)
                colors.push({ id: m.id, color: stroke });
        }
        svg += `</svg>`;
        const out = await sharp(buffer)
            .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
            .png()
            .toBuffer();
        const result = { ok: true, buffer: out, width: W, height: H, selected };
        if (sparseFallback !== undefined)
            result.sparseFallback = sparseFallback;
        if (routeLabels)
            result.labelDirections = labelDirections;
        if (stableColorsOn)
            result.colors = colors;
        return result;
    }
    catch (e) {
        // sharp 未安装 / 原生绑定损坏 / 解码失败 —— 优雅降级，绝不抛出
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: `renderSomOverlay: 叠加渲染失败 — ${msg.slice(0, 240)}` };
    }
}
/** 纯函数：bbox 中心点（点击定位的目标像素；不做夹取，输入合法性归调用方） */
export function markerCentroid(bbox) {
    return { x: (bbox.x0 + bbox.x1) / 2, y: (bbox.y0 + bbox.y1) / 2 };
}
/**
 * 纯函数：grounding 系统提示词。要求 GLM-5.3-Flash 只输出严格 JSON 数组，
 * 每元素 {id,label,role,bbox:[x0,y0,x1,y1],confidence:0..1}；bbox 为输入图上的
 * 像素绝对坐标且必须完整落在图内；role 枚举固定；不臆造看不见的元素。
 */
export function buildGroundingSystemPrompt() {
    return '你是屏幕元素定位器。只输出严格 JSON 数组，禁止代码块围栏或任何多余文字。'
        + '每个元素：{"id":编号,"label":"元素可见文字或名称","role":"button/link/input/select/text/icon/menu/other 之一",'
        + '"bbox":[x0,y0,x1,y1],"confidence":0到1的小数}。'
        + 'bbox 为输入图像上的像素绝对坐标，必须基于图像实际像素判断，且完整落在图内'
        + '（0≤x0<x1≤图宽，0≤y0<y1≤图高），图外坐标非法。'
        + '只标注图中真实可见的元素，不要臆造看不见的元素。';
}
/**
 * 纯函数：grounding 用户提示词。描述图像尺寸与任务（列出所有可交互元素与
 * 关键文字块）；question 提供时聚焦到与问题相关的元素。
 */
export function buildGroundingUserPrompt(opts) {
    const base = `图像尺寸：${opts.width}×${opts.height} 像素，坐标原点在左上角，图外坐标非法。`
        + '任务：列出图中所有可交互元素与关键文字块，严格按系统提示词的 JSON 数组格式输出；若无任何元素输出 []。';
    const focus = opts.question ? `聚焦问题：${opts.question}——只输出与该问题相关的元素。` : '';
    return base + focus;
}
/**
 * 纯函数：前后图核对提示词。对比动作前后两图，只输出严格 JSON：
 * {verdict:'confirmed'|'refuted'|'uncertain', scale:'page'|'element'|'none',
 *  explanation（一句中文）, confidence:0..1}；判断必须基于两图实际像素差异。
 */
export function buildVerdictPrompt(expectation) {
    return `对比前图与后图，判断预期是否达成：${expectation}。`
        + '只输出严格 JSON：{"verdict":"confirmed/refuted/uncertain 之一","scale":"page/element/none 之一",'
        + '"explanation":"一句中文说明","confidence":0到1的小数}。'
        + 'verdict 表示预期是否出现；scale 表示变化范围（page 页面级、element 元素级、none 无变化）。'
        + '判断必须基于两图实际像素差异，不要臆造图上看不到的现象。';
}
/**
 * 纯函数：OCR 提示词。只输出严格 JSON {words:[{text,bbox:[x0,y0,x1,y1],confidence:0..1}]}；
 * text 保持屏幕原文语言不翻译不改写；bbox 为输入图像上的像素绝对坐标且完整落在图内。
 * lang 指定优先识别语言；findQuery 指定优先查找的文字。
 */
export function buildOcrPrompt(opts) {
    const base = '识别图中所有可见文字。只输出严格 JSON：{"words":[{"text":"原文",'
        + '"bbox":[x0,y0,x1,y1],"confidence":0到1的小数}]}。'
        + 'text 保持屏幕原文语言，不翻译、不改写、不合并相邻词；'
        + 'bbox 为输入图像上的像素绝对坐标，必须基于图像实际像素判断且完整落在图内，图外坐标非法。';
    const lang = opts.lang ? `优先按 ${opts.lang} 语言识别。` : '';
    const find = opts.findQuery ? `优先列出与「${opts.findQuery}」相关的文字。` : '';
    return base + lang + find;
}
