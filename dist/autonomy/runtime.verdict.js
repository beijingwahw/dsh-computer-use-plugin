// src/autonomy/runtime.verdict.ts
// W8-B2（doctor smell.over-engineering 清偿 · D-F2 千行文件群）：自 runtime.ts
// 低风险分区提取 —— W1-1 执行层纯函数工具区（汉明距离 / A4 不确定性感知落点 /
// 网格重试步进 / A2 ROI 三区判决合成 / ROI 内 OCR 词对照）。零异常、零副作用
//（可离线单测的确定性事实源）；逐字节搬迁；runtime.ts 以再导出保持导入面不变
//（judgeRoiOcr 原为模块私有 —— 仅供 runtime 家族兄弟文件复用，不进公共面）。
import { hammingDistance } from '../perceptualHash.js';
import { W1_EXEC_TUNING } from './runtime.tuning.js';
import { foldText } from './runtime.utils.js';
/** 数字卫兵：非有限数 ⇒ null（W1 各判决的统一前置） */
export const finiteOrNull = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
/**
 * W1-1（A2/A5）：两枚指纹（服务端 hex / 本地位串混布）的汉明距离。
 * 任一无效（缺席/空串）、长度不可比或解析异常 ⇒ null（诚实缺席，绝不猜距离）。
 */
export function w1HashDistance(a, b) {
    const sa = typeof a === 'string' && a.trim() !== '' ? a : null;
    const sb = typeof b === 'string' && b.trim() !== '' ? b : null;
    if (sa === null || sb === null)
        return null;
    try {
        // ΝΩ-24 跟修：本判决面用"保长严格归一器"——合法 hex（任意长度，测试夹具的
        // 短哈希同权）按 hex.length*4 保长归位；非法字符 ⇒ null 诚实缺席（绝不学
        // normalizeHash 收敛全零哨兵——两枚零串距离 0 会把"无效证据"伪装成"相同"）；
        // 归一后长度不齐 ⇒ null（不可比）。
        const norm = (s) => {
            if (/^[01]+$/.test(s))
                return s;
            if (!/^[0-9a-fA-F]+$/.test(s))
                return null;
            return BigInt(`0x${s}`).toString(2).padStart(s.length * 4, '0');
        };
        const ba = norm(sa);
        const bb = norm(sb);
        if (ba === null || bb === null)
            return null;
        if (ba.length === 0 || ba.length !== bb.length)
            return null;
        return hammingDistance(ba, bb);
    }
    catch {
        return null;
    }
}
/**
 * W1-1（A4）：bbox 不确定性感知落点（纯函数、绝不抛异常）。
 *   · 大框（长边 ≥ largeBboxPx）：以框内词级元素（快照 localElements 的文字
 *     重心）按置信度加权质心替代几何中心 —— 避开图标区/边框/大容器的死中心；
 *     与目标自身近同尺寸（面积 > wordMaxAreaRatio×目标）或中心不在内缩 10%
 *     安全带内的元素不入词集；
 *   · 小框（短边 < smallBboxPx）：落点向几何中心收缩 smallShrinkRatio
 *     （20%）—— 抗小框坐标抖动溢出；
 *   · 无合法框 ⇒ 中心直通；中心缺席 ⇒ 框中点；落点最终夹回框内（防御脏 center）。
 */
export function pickClickPoint(target, elements, t = W1_EXEC_TUNING) {
    const b = target && typeof target === 'object' ? target.bbox : undefined;
    const x0 = finiteOrNull(b?.x0);
    const y0 = finiteOrNull(b?.y0);
    const x1 = finiteOrNull(b?.x1);
    const y1 = finiteOrNull(b?.y1);
    const cx = finiteOrNull(target?.center?.x);
    const cy = finiteOrNull(target?.center?.y);
    if (x0 === null || y0 === null || x1 === null || y1 === null) {
        // 无合法框 ⇒ 中心直通（质心/收缩均无从谈起）；中心也脏 ⇒ (0,0) 兜底
        return { x: cx ?? 0, y: cy ?? 0, via: 'center', words: 0 };
    }
    const bx0 = Math.min(x0, x1), bx1 = Math.max(x0, x1);
    const by0 = Math.min(y0, y1), by1 = Math.max(y0, y1);
    const bw = bx1 - bx0, bh = by1 - by0;
    const midX = (bx0 + bx1) / 2, midY = (by0 + by1) / 2;
    let px = cx !== null ? cx : midX;
    let py = cy !== null ? cy : midY;
    let via = 'center';
    let words = 0;
    // 大框 ⇒ 文字重心：框内词级元素的置信度加权重心
    if (Math.max(bw, bh) >= t.largeBboxPx) {
        const areaT = Math.max(bw * bh, 1e-9);
        const marginX = bw * 0.1, marginY = bh * 0.1; // 内缩 10% 安全带（避边框伪词）
        let sw = 0, sx = 0, sy = 0;
        for (const el of Array.isArray(elements) ? elements : []) {
            if (!el || typeof el !== 'object')
                continue;
            if (typeof el.label !== 'string' || el.label.trim() === '')
                continue;
            const ex0 = finiteOrNull(el.bbox?.x0);
            const ey0 = finiteOrNull(el.bbox?.y0);
            const ex1 = finiteOrNull(el.bbox?.x1);
            const ey1 = finiteOrNull(el.bbox?.y1);
            if (ex0 === null || ey0 === null || ex1 === null || ey1 === null)
                continue;
            const ew = Math.abs(ex1 - ex0), eh = Math.abs(ey1 - ey0);
            if (ew * eh > t.wordMaxAreaRatio * areaT)
                continue; // 近自尺寸（含目标镜像）不入词集
            const ecx = (Math.min(ex0, ex1) + Math.max(ex0, ex1)) / 2;
            const ecy = (Math.min(ey0, ey1) + Math.max(ey0, ey1)) / 2;
            if (ecx < bx0 + marginX || ecx > bx1 - marginX || ecy < by0 + marginY || ecy > by1 - marginY)
                continue;
            const conf = finiteOrNull(el.confidence);
            const weight = Math.max(conf !== null ? conf : 0, 0.05);
            sw += weight;
            sx += ecx * weight;
            sy += ecy * weight;
            words++;
        }
        if (sw > 0) {
            px = sx / sw;
            py = sy / sw;
            via = 'word-centroid';
        }
    }
    // 小框 ⇒ 落点向几何中心收缩（坐标各向同性收缩 —— 中心点恒等，仅偏移点被拉回）
    const shortSide = Math.min(bw, bh);
    if (shortSide > 0 && shortSide < t.smallBboxPx) {
        px = px + (midX - px) * t.smallShrinkRatio;
        py = py + (midY - py) * t.smallShrinkRatio;
        if (via === 'center')
            via = 'shrunk';
    }
    // 夹回框内（质心/收缩数学上已在内 —— 浮点误差与脏 center 的最后一道闸）
    px = Math.min(bx1, Math.max(bx0, px));
    py = Math.min(by1, Math.max(by0, py));
    return { x: px, y: py, via, words };
}
/**
 * W1-1（A4）：3×3 去中心网格步进序 —— 4 邻（上下左右）先、4 角后（贴近原意图
 * 的位置先试），确定性次序，共 8 邻位（中心位是已失败的首发点，不重复）。
 */
export function gridRetryOffsets() {
    return [
        { dx: 0, dy: -1 }, { dx: -1, dy: 0 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 },
        { dx: -1, dy: -1 }, { dx: 1, dy: -1 }, { dx: 1, dy: 1 }, { dx: -1, dy: 1 },
    ];
}
/**
 * W1-1（A2）：三区判决合成（纯函数 —— 判决矩阵的确定性事实源）。
 *   · ROI 证据链缺席 ⇒ 降级全屏判决（degraded 记 'roi'，行为与接线前一致）；
 *   · ROI 三证（区域指纹/预期区域交叠/ROI 内 OCR 词）任一判变 ⇒ progress；
 *   · 三证皆无而全屏变 ⇒ no_effect + noise=true（噪声判决）；
 *   · 三证皆无且全屏未变（或全屏证据也缺席）⇒ 平凡 no_effect。
 */
export function combineRoiVerdict(v) {
    if (!v.roiCapability) {
        return {
            outcome: v.fullscreenChanged === true ? 'progress' : 'no_effect',
            noise: false,
            degraded: ['roi'],
        };
    }
    if (v.roiChanged === true || v.expectedHit === true || v.roiOcrChanged === true) {
        return { outcome: 'progress', noise: false, degraded: [] };
    }
    if (v.fullscreenChanged === true) {
        return { outcome: 'no_effect', noise: true, degraded: [] };
    }
    return { outcome: 'no_effect', noise: false, degraded: [] };
}
/**
 * W1-1（A2③）：ROI 内 OCR 词级标签集的前后对照（纯函数）。
 * before 侧用快照元素（词级 bbox 的 localElements）、after 侧用验证帧 OCR 词，
 * 双方中心点归一化后落 ROI 框内才入集。任一侧无词 ⇒ null（OCR 失败/空 ROI
 * 都不构成判变证据 —— 宁缺毋错）。
 */
export function judgeRoiOcr(before, afterWords, roi, afterDims) {
    if (!before)
        return null;
    const rx0 = roi.x - roi.r, rx1 = roi.x + roi.r;
    const ry0 = roi.y - roi.r, ry1 = roi.y + roi.r;
    const inRoi = (nx, ny) => nx > rx0 && nx < rx1 && ny > ry0 && ny < ry1;
    const beforeLabels = new Set();
    const bw = before.width > 0 ? before.width : 1;
    const bh = before.height > 0 ? before.height : 1;
    for (const el of Array.isArray(before.elements) ? before.elements : []) {
        if (!el || typeof el.label !== 'string' || el.label.trim() === '')
            continue;
        const nx = finiteOrNull(el.center?.x);
        const ny = finiteOrNull(el.center?.y);
        if (nx === null || ny === null)
            continue;
        if (inRoi(nx / bw, ny / bh))
            beforeLabels.add(foldText(el.label));
    }
    const afterLabels = new Set();
    const aw = afterDims.width > 0 ? afterDims.width : 1;
    const ah = afterDims.height > 0 ? afterDims.height : 1;
    for (const w of Array.isArray(afterWords) ? afterWords : []) {
        if (!w || typeof w.label !== 'string' || w.label.trim() === '')
            continue;
        const wx0 = finiteOrNull(w.bbox?.x0);
        const wy0 = finiteOrNull(w.bbox?.y0);
        const wx1 = finiteOrNull(w.bbox?.x1);
        const wy1 = finiteOrNull(w.bbox?.y1);
        if (wx0 === null || wy0 === null || wx1 === null || wy1 === null)
            continue;
        if (inRoi(((wx0 + wx1) / 2) / aw, ((wy0 + wy1) / 2) / ah))
            afterLabels.add(foldText(w.label));
    }
    if (beforeLabels.size === 0 || afterLabels.size === 0)
        return null;
    if (beforeLabels.size !== afterLabels.size)
        return true;
    for (const l of beforeLabels)
        if (!afterLabels.has(l))
            return true;
    return false;
}
