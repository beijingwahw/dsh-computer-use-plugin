// src/visualDiff.ts
// W6-2 结构性保留（doctor smell.over-engineering 登记）：E 系视觉差分 —— dHash/pHash/区域网格/振荡检测围绕同一差分代数（sim/distance 单位约定），拆分将复制指纹方言。
// 第四轮创新之一：视觉差分引擎（what-changed-where）。
// 模型自己对比两张整屏截图既费 Token 又容易看漏；本引擎在像素层直接算出
// 「哪些区域变了」：降采样 → 逐像素差 → 分块聚合 → 连通域合并 → 变化区域清单。
// 输出归一化坐标的变化框，可叠加红框渲染成差分图 —— 模型一眼看到变化在哪。
// 批次 E 迁移：sharp 懒动态导入（_legacyDeps.getSharp）。
// W3-3 增量编码增补：内核注册表（模块开关）、运动估计器（滚动判定，只读导入）、
// codec 的补丁几何（三系坐标换算的收口面 —— 单一权威源）。
import { getSharp } from './_legacyDeps.js';
import { kernelRegistry } from './kernel/registry.js';
import { estimateRowShift } from './motionEstimator.js';
import { normalizedToPatchRect } from './vlm/codec.js';
const DIFF_WIDTH = 480; // 差分分辨率：够定位，无需高清
const PIXEL_THRESHOLD = 70; // RGB 三通道差之和超此值算变化（容忍 JPEG 噪声）
export async function computeDiffRegions(beforeBuf, afterBuf, tileCols = 16) {
    const sharp = await getSharp();
    const afterMeta = await sharp(afterBuf).metadata();
    const W = DIFF_WIDTH;
    const H = Math.max(1, Math.round(W * (afterMeta.height / afterMeta.width)));
    // ensureAlpha：像素差循环按 4 通道步长索引（i=(y*W+x)*4）—— RGB 输入
    //（JPEG/无 alpha 的 PNG）的 raw 缓冲只有 3 通道，通道会整体错位静默毒化判决
    const [a, b] = await Promise.all([
        sharp(beforeBuf).resize(W, H, { fit: 'fill' }).ensureAlpha().raw().toBuffer(),
        sharp(afterBuf).resize(W, H, { fit: 'fill' }).ensureAlpha().raw().toBuffer(),
    ]);
    const rows = Math.max(6, Math.round(tileCols * H / W));
    const { regions, changedFraction } = diffRegionsFromRaw(a, b, W, H, tileCols, rows);
    return {
        regions,
        changed_fraction_pct: Math.round(changedFraction * 1000) / 10,
        identical: changedFraction < 0.001,
    };
}
/**
 * 像素差核心（自 raw RGBA 缓冲）：分块变化图 → 连通域合并 → 区域清单。
 * W3-3 从 computeDiffRegions 逐字节抽出（行为零变化）—— 屏幕状态账本与
 * computeDiffRegions 共用同一判决核心，免二次解码。
 */
function diffRegionsFromRaw(a, b, W, H, tileCols, rows) {
    // 分块变化图：像素级变化累积到块级，天然过滤零星噪点
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
    return { regions, changedFraction };
}
/** 把变化区域以红色虚线框 + Δ编号 渲染到 after 图上（差分可视化） */
export async function renderDiffOverlay(afterBuf, regions) {
    const sharp = await getSharp();
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
// ─── G-1 差分持续性（第七维·过程感知）：0 维持久同调的工程最小形态 ───
//
// 理论根基（Edelsbrunner–Harer 持久同调）：把连续 diff 视为对「变化特征」的
// 反复观测流 —— 特征的「寿命」（在多少个连续 diff 中重现）即 0 维持续性：
//   长寿命特征 = 稳定的结构变化（内容真的变了 —— 菜单展开了、面板出现了）
//   短寿命特征 = 瞬态噪声（光标闪烁、视频帧、动画残影 —— 一次闪现即消亡）
// 拓扑数据处理（TDA）的核心洞见在此最小化：不看单帧快照，看特征的生存时间。
//
// 实现：区域中心量化到 12×12 网格（抖动容忍键）；最近 6 次 diff 的键集合成
// 观测史；特征在最近 3 次观测中出现 ≥2 次 ⇒ persistent（寿命门槛 ≥2）。
// 诚实边界：网格量化键无方向性（相邻格不合并 —— 漂移的持续变化会被误判
// transient）；域敏感的 Vietoris–Rips 复形是留白。
const PERSIST_RING = 6; // 观测史容量（最近 6 次 diff）
const PERSIST_WINDOW = 3; // 寿命判定窗口（最近 3 次观测）
const PERSIST_MIN_LIFE = 2; // 寿命门槛：窗口内出现 ≥2 次 ⇒ 持续
const KEY_GRID = 12; // 中心量化网格（12×12 —— 抖动容忍 vs 定位分辨的平衡）
/** I-4 迁徙半径（归一化坐标）：≤0.10 的位移视为同一特征的移动（约 1.2 格） */
const MIGRATE_RADIUS = 0.10;
/** O 纪元（#24）瞬移链接：无距离证据时的更硬形状判据 —— 质量窗收紧 + 长宽比容差 */
const TELEPORT_MASS_LO = 2 / 3, TELEPORT_MASS_HI = 1.5;
const TELEPORT_ASPECT_TOL = 0.35;
/** O 纪元（#24）相干位移容差（归一化坐标）：两对位移矢量同轴判定 */
const COHERENT_TOL = 0.05;
/** 区域 → 量化键（中心坐标的网格量化 —— ±1/24 内的抖动同键） */
export function regionKey(r) {
    return `${Math.round(r.center.x * KEY_GRID)},${Math.round(r.center.y * KEY_GRID)}`;
}
// ─── H-6 双格点量化（创世纪）：偿还 G-1 的漂移债务 ───
//
// G-1 诚实边界原文：「网格量化键无方向性 —— 漂移的持续变化会被误判 transient」。
// 偿还方案（重叠格点经典技巧）：每个区域铸**两把键**——主格点（12×12 网格）+
// 副格点（同网格平移半格 1/24）。任何点距其中至少一个格点系的_cell 内边界
// 足够远：主格点跨界的漂移，副格点必在界内（反之亦然）—— 两条 1/24 容差的
// 量化证据链，任何一条存活 ⇒ 持续性存活。数学上这是双射覆盖（double
// covering）：两套平移格点的交集界宽 ≥ 半格，联合量化误差上界从 1/24 的
// 「运气题」变为 1/24 的「保证题」。
/** 半格偏移（副格点系的平移量） */
const HALF_CELL = 1 / (KEY_GRID * 2);
/** 区域 → 双格点键集（主格点 + 平移半格的副格点）。导出：测试与 H-6 执法面 */
export function regionKeys(r) {
    const primary = regionKey(r);
    const secondary = `s${Math.round((r.center.x - HALF_CELL) * KEY_GRID)},${Math.round((r.center.y - HALF_CELL) * KEY_GRID)}`;
    return [primary, secondary];
}
/**
 * 持续性分类（纯函数 —— 可注入任意观测史，测试的确定性事实源）：
 * 区域的**任一**格点键在观测史最近 PERSIST_WINDOW 次中出现 ≥PERSIST_MIN_LIFE 次
 * ⇒ persistent（H-6 双格点：主键跨界漂移由副键兜底 —— 联合证据链）。
 *
 * I-4 迁徙链接（默认模式，history 未注入时）：键断链（漂移超半格）的区域，
 * 若与窗口内**已被判 persistent** 的历史特征构成传输匹配 —— 距离 ≤0.10 且
 * 质量比 ∈[0.5,2] —— 则视为**同一持续特征的迁徙**（同一条菜单滑了半屏，
 * 不是旧特征死了新特征生了）。闭合 G-1/H-6 的债务链：亚半格漂移由双格点
 * 兜底，超半格漂移由传输兜底 —— 持续性对任意速度的连续漂移全程存活。
 * 注入 history 的纯键模式保持不变（epochG/H 测试的既有语义零回归）。
 */
export function classifyPersistence(regions, history) {
    const verdict = new Map();
    if (history) {
        // 纯键模式（注入观测史 —— 测试与确定性判据的固定面）
        const window = history.slice(-PERSIST_WINDOW);
        for (const r of regions) {
            const keys = regionKeys(r);
            const life = window.reduce((n, set) => n + (keys.some(k => set.has(k)) ? 1 : 0), 0);
            verdict.set(r.index, life >= PERSIST_MIN_LIFE ? 'persistent' : 'transient');
        }
        return verdict;
    }
    // 默认模式：内部富观测史（键 + 持续特征快照）—— 键判据 + I-4 迁徙/瞬移链接
    const window = richRing.slice(-PERSIST_WINDOW);
    for (const r of regions) {
        const keys = regionKeys(r);
        const life = window.reduce((n, obs) => n + (keys.some(k => obs.keys.has(k)) ? 1 : 0), 0);
        if (life >= PERSIST_MIN_LIFE) {
            verdict.set(r.index, 'persistent');
            continue;
        }
        // I-4 迁徙链接：与窗口内 persistent 特征的传输匹配（距离 + 质量比守恒）
        const migrated = window.some(obs => obs.persistent.some(p => Math.hypot(p.center.x - r.center.x, p.center.y - r.center.y) <= MIGRATE_RADIUS &&
            (() => { const ratio = r.tiles_changed / p.mass; return ratio >= 0.5 && ratio <= 2; })()));
        if (migrated) {
            verdict.set(r.index, 'persistent');
            continue;
        }
        // O 纪元（#24）瞬移链接（相干位移场版）：极端 UI 变化（窗口移动/布局重排）
        // 位移远超半径，迁徙链断裂 ⇒ 同一批特征被误判 transient。单帧上「远处同形
        // 新盒」与「特征瞬移」不可区分（I-4 反例立法）—— 判别子是**相干场**：
        // 真实重排必携带 ≥2 个特征以一致位移矢量共移（刚体平移）；凑齐相干对 ⇒
        // 这批区域判 persistent，单个候选维持 transient（证据不足，诚实）。
        // 形状判据（无距离证据时更硬）：质量窗 [2/3,1.5] + 长宽比相对差 ≤0.35。
        if (coherentTeleport(r, window, regions)) {
            verdict.set(r.index, 'persistent');
            continue;
        }
        verdict.set(r.index, 'transient');
    }
    return verdict;
}
/** 区域 × persistent 快照的形状守恒判据（#24：无距离证据 ⇒ 形状更硬） */
function shapeConserved(r, p) {
    const ratio = r.tiles_changed / p.mass;
    if (ratio < TELEPORT_MASS_LO || ratio > TELEPORT_MASS_HI)
        return false;
    if (typeof p.aspect !== 'number' || !Number.isFinite(p.aspect) || p.aspect <= 0)
        return false;
    const aspect = (r.bbox_normalized.x1 - r.bbox_normalized.x0) /
        Math.max(1e-6, r.bbox_normalized.y1 - r.bbox_normalized.y0);
    return Math.abs(aspect - p.aspect) / Math.max(aspect, p.aspect) <= TELEPORT_ASPECT_TOL;
}
/** O 纪元（#24）：相干瞬移判定 —— 本区域与另一区域相对窗口内 persistent
 *  特征的位移矢量一致（刚体平移证据）⇒ 瞬移场成立。纯函数、确定性。 */
function coherentTeleport(r, window, allRegions) {
    for (const obs of window) {
        for (const p of obs.persistent) {
            if (!shapeConserved(r, p))
                continue;
            const dx = r.center.x - p.center.x, dy = r.center.y - p.center.y;
            if (Math.hypot(dx, dy) <= MIGRATE_RADIUS)
                continue; // 已由迁徙链管辖
            // 找共移证人：另一区域 q，其相对某个 persistent 特征的位移与 (dx,dy) 一致
            for (const q of allRegions) {
                if (q.index === r.index)
                    continue;
                for (const obs2 of window) {
                    for (const p2 of obs2.persistent) {
                        if (!shapeConserved(q, p2))
                            continue;
                        const ddx = q.center.x - p2.center.x, ddy = q.center.y - p2.center.y;
                        if (Math.hypot(ddx, ddy) <= MIGRATE_RADIUS)
                            continue;
                        if (Math.abs(ddx - dx) <= COHERENT_TOL && Math.abs(ddy - dy) <= COHERENT_TOL) {
                            return true; // 两个形状守恒特征同矢量共移 —— 刚体重排证据
                        }
                    }
                }
            }
        }
    }
    return false;
}
/** 内部富观测史（与键环同容量同窗口 —— 双轨合一的存储面） */
const richRing = [];
/**
 * 观测登记：先判后记（本次不自证持续）。verdict 可选注入（diff_view 已算过）；
 * 缺席时内部判定。登记键集合 + persistent 特征快照（供下一轮迁徙链接）。
 */
export function noteDiffObserved(regions, verdict) {
    const v = verdict ?? classifyPersistence(regions);
    const keys = new Set();
    for (const r of regions)
        for (const k of regionKeys(r))
            keys.add(k);
    const persistent = regions
        .filter(r => v.get(r.index) === 'persistent')
        .map(r => ({
        center: { x: r.center.x, y: r.center.y },
        mass: r.tiles_changed,
        aspect: (r.bbox_normalized.x1 - r.bbox_normalized.x0) /
            Math.max(1e-6, r.bbox_normalized.y1 - r.bbox_normalized.y0),
    }));
    richRing.push({ keys, persistent });
    while (richRing.length > PERSIST_RING)
        richRing.shift();
}
/** 生命周期归零（插件卸载 / 测试隔离） */
export function resetDiffPersistence() {
    richRing.length = 0;
}
/**
 * H-1 最优传输空间位移：W₁(δ_a, μ) = Σ wᵢ·d(a, cᵢ)，wᵢ = tiles_changedᵢ/Σ
 * （质量 = 区域面积代理）。Dirac↔离散分布的 W₁ 有闭式解 —— 无需求解传输
 * 线性规划（一维情形的最优传输退化为加权平均距离）。
 *
 * 认知价值：dHash 只答「有没有变」，W₁ 答「**变化发生在你动作的地方吗**」——
 * 「点了这里侧栏在那边展开」是正确的因果（副作用），而「点了这里、别处闪了
 * 一下」可能只是巧合。空间因果与像素变化正交，是验证栈的第五个维度。
 * 纯函数导出：数学原子的测试面。
 */
export function spatialDisplacement(action, regions) {
    if (regions.length === 0) {
        return { w1: 0, w1Info: 0, infoRatio: 1, nearestIndex: null, nearestDistance: 0 };
    }
    const totalMass = regions.reduce((n, r) => n + r.tiles_changed, 0);
    if (totalMass <= 0) {
        return { w1: 0, w1Info: 0, infoRatio: 1, nearestIndex: null, nearestDistance: 0 };
    }
    const LAMBDA = 0.5; // 信息温度：熵视图的话语权（0 = 纯质量，1 = 纯自信息）
    const logn = Math.log(regions.length);
    const dists = new Map();
    let w1 = 0;
    let w1InfoNum = 0, infoWeightSum = 0;
    let nearestIndex = null;
    let nearestDistance = Infinity;
    for (const r of regions) {
        const d = Math.hypot(action.x - r.center.x, action.y - r.center.y);
        dists.set(r.index, d);
        const w = r.tiles_changed / totalMass;
        w1 += w * d;
        // 信息熵加权（#25）：自信息 −ln pᵢ 按区域数归一后经 λ 注入质量权
        if (logn > 0) {
            const p = r.tiles_changed / totalMass;
            const iw = r.tiles_changed * (1 - LAMBDA + LAMBDA * (-Math.log(p)) / logn);
            w1InfoNum += iw * d;
            infoWeightSum += iw;
        }
        else {
            w1InfoNum += w * d * totalMass; // 单区域：熵退化为质量
            infoWeightSum += totalMass;
        }
        if (d < nearestDistance) {
            nearestDistance = d;
            nearestIndex = r.index;
        }
    }
    const w1Info = w1InfoNum / infoWeightSum;
    return {
        w1: Math.round(w1 * 1000) / 1000,
        w1Info: Math.round(w1Info * 1000) / 1000,
        infoRatio: Math.round((w1Info / Math.max(w1, 1e-6)) * 1000) / 1000,
        nearestIndex,
        nearestDistance: Math.round(nearestDistance * 1000) / 1000,
    };
}
/** W3-3：缺省调参（创新提案的建议值） */
export const DEFAULT_LEDGER_TUNING = {
    patchDirtyPct: 5,
    cumulativeDirtyPct: 30,
    surpriseBitsThreshold: 24,
    ttlMs: 120_000,
    expandPx: 8,
    mergeGapPx: 24,
    minEdgePx: 32,
    maxPatches: 6,
    scrollMinChangedPct: 15,
    scrollMinDyPx: 4,
    scrollResidualMax: 0.25,
    scrollMaxDyFrac: 0.9,
};
/** W3-3：调参防御规整（脏值回声缺省 —— 绝不抛） */
function cleanTuning(raw) {
    const t = { ...DEFAULT_LEDGER_TUNING, ...(raw ?? {}) };
    const pos = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
    return {
        patchDirtyPct: pos(t.patchDirtyPct, 5),
        cumulativeDirtyPct: pos(t.cumulativeDirtyPct, 30),
        surpriseBitsThreshold: pos(t.surpriseBitsThreshold, 24),
        ttlMs: pos(t.ttlMs, 120_000),
        expandPx: pos(t.expandPx, 8),
        mergeGapPx: pos(t.mergeGapPx, 24),
        minEdgePx: pos(t.minEdgePx, 32),
        maxPatches: Math.max(1, Math.floor(pos(t.maxPatches, 6))),
        scrollMinChangedPct: pos(t.scrollMinChangedPct, 15),
        scrollMinDyPx: pos(t.scrollMinDyPx, 4),
        scrollResidualMax: Math.min(0.5, pos(t.scrollResidualMax, 0.25)),
        scrollMaxDyFrac: Math.min(1, pos(t.scrollMaxDyFrac, 0.9)),
    };
}
/**
 * W3-3：增量编码模块开关（缺省关闭）。注册表键 visualDiff.incremental
 * （0/1 数值语义，与 codec.foveated 同律 —— 未注册 ⇒ getOrDefault 回声 0，
 * 缺省路径零行为变化；index.ts 的铸入由集成接线）。
 */
export function incrementalEncodingEnabled() {
    return kernelRegistry.getOrDefault('visualDiff.incremental', 0) > 0.5;
}
/**
 * W3-3 纯函数：变化区域清单 → 补丁矩形清单（源图像素系）。
 * 合并与外扩策略：
 *   1. 按面积取 Top maxPatches（面积降序已是 computeDiffRegions 的输出序）；
 *   2. bbox_normalized → 源图像素（codec.normalizedToPatchRect —— 三系换算
 *      的单一权威源），四周外扩 expandPx（差分 480px 降采样的定位残差垫）；
 *   3. 最小边垫到 minEdgePx（居中外扩 —— 亚块噪声不产碎补丁）；
 *   4. 迭代合并：间隙 ≤ mergeGapPx（两轴同时）的矩形并成一块，至不动点
 *      （邻接变化一次投递 —— 补丁数的上下文经济）；
 *   5. clamp 进画布、按 (y,x) 阅读序输出。
 * 纯函数、零副作用、脏输入（空清单/脏维度）返回 []。
 */
export function regionsToPatchRects(regions, srcW, srcH, tuning) {
    const W = Math.floor(srcW), H = Math.floor(srcH);
    if (!Array.isArray(regions) || regions.length === 0 || !(W >= 1) || !(H >= 1))
        return [];
    const t = cleanTuning(tuning);
    const rects = [];
    for (const r of regions.slice(0, t.maxPatches)) {
        const n = r?.bbox_normalized;
        if (!n || typeof n !== 'object')
            continue;
        // 归一化 → 源图像素（往返恒等面），再外扩 + 最小边垫
        let { x, y, w, h } = normalizedToPatchRect({ x0: n.x0, y0: n.y0, x1: n.x1, y1: n.y1 }, W, H);
        x -= t.expandPx;
        y -= t.expandPx;
        w += 2 * t.expandPx;
        h += 2 * t.expandPx;
        if (w < t.minEdgePx) {
            const d = t.minEdgePx - w;
            x -= Math.floor(d / 2);
            w += d;
        }
        if (h < t.minEdgePx) {
            const d = t.minEdgePx - h;
            y -= Math.floor(d / 2);
            h += d;
        }
        // clamp 进画布（收口而非拒绝 —— 边缘补丁合法）
        x = Math.max(0, Math.min(x, W - 1));
        y = Math.max(0, Math.min(y, H - 1));
        w = Math.max(1, Math.min(w, W - x));
        h = Math.max(1, Math.min(h, H - y));
        rects.push({ x, y, w, h });
    }
    // 迭代合并至不动点：两轴间隙都 ≤ mergeGapPx ⇒ 并块
    const gap = t.mergeGapPx;
    let merged = true;
    while (merged && rects.length > 1) {
        merged = false;
        outer: for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) {
                const a = rects[i], b = rects[j];
                const gapX = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w));
                const gapY = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h));
                if (gapX <= gap && gapY <= gap) {
                    const x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
                    rects[i] = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: x1 - Math.min(a.x, b.x), h: y1 - Math.min(a.y, b.y) };
                    rects.splice(j, 1);
                    merged = true;
                    break outer;
                }
            }
        }
    }
    rects.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    return rects;
}
/**
 * W3-3：默认分析管线（sharp）—— 与 computeDiffRegions 同一判决核心
 * （diffRegionsFromRaw 共用）+ 行亮度序列喂 motionEstimator.estimateRowShift
 * （只读导入 —— 滚动判定的物理事实源）。before === after（冷启动探测）时
 * 恒返回 identical。
 * W7-0（W6-5 接线收尾）：同一对 raw 缓冲顺带铸 colLuminance（列亮度序列进
 * 分析面 —— 增量账本水平滚动分诊的横向证据；零额外解码，判决逻辑零变化）。
 * 导出面：测试与自定义端口的对照实现基准。
 */
export async function defaultAnalyze(before, after) {
    const sharp = await getSharp();
    const afterMeta = await sharp(after).metadata();
    const W = DIFF_WIDTH;
    const H = Math.max(1, Math.round(W * (afterMeta.height / afterMeta.width)));
    const [a, b] = await Promise.all([
        sharp(before).resize(W, H, { fit: 'fill' }).ensureAlpha().raw().toBuffer(),
        sharp(after).resize(W, H, { fit: 'fill' }).ensureAlpha().raw().toBuffer(),
    ]);
    const tileCols = 16;
    const rows = Math.max(6, Math.round(tileCols * H / W));
    const { regions, changedFraction } = diffRegionsFromRaw(a, b, W, H, tileCols, rows);
    // 行亮度序列（行平均亮度 —— 行移估计的输入方言）
    const lumA = rowLuminance(a, W, H), lumB = rowLuminance(b, W, H);
    // 行移搜索窗自适应：max(16, H/6) —— 480px 差分行下 16:9 屏一行差分行 ≈ 4
    // 源行，固定 ±16 窗只覆盖 ~64 源行（半屏滚轮一格都不够）；H/6 ≈ 45 行
    // （1080p 下 ~180 源行）覆盖常见滚动距离，残差闸门防宽窗伪匹配。
    const searchRange = Math.max(16, Math.round(H / 6));
    const rowShift = before.equals(after) ? { shift: 0, residual: 1, bestInteger: 0 } : estimateRowShift(lumA, lumB, searchRange);
    return {
        width: afterMeta.width ?? 0,
        height: afterMeta.height ?? 0,
        regions,
        changedPct: Math.round(changedFraction * 1000) / 10,
        identical: changedFraction < 0.001,
        rowShift,
        diffRows: H,
        // W7-0：列亮度（W7 列，差分分辨率 —— 与行亮度同一缓冲同一尺度）
        colLuminance: { before: columnLuminance(a, W, H), after: columnLuminance(b, W, H), cols: W },
    };
}
/** W3-3：raw RGBA 缓冲 → 行平均亮度序列（行移估计的输入） */
function rowLuminance(buf, W, H) {
    const out = new Array(H);
    for (let y = 0; y < H; y++) {
        let sum = 0;
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            sum += (buf[i] + buf[i + 1] + buf[i + 2]) / 3;
        }
        out[y] = sum / W;
    }
    return out;
}
/** W7-0：raw RGBA 缓冲 → 列平均亮度序列（rowLuminance 的横向对偶 —— 供
 *  estimateColShift 的输入方言；同缓冲单遍 O(W×H)，零额外解码） */
function columnLuminance(buf, W, H) {
    const out = new Array(W);
    for (let x = 0; x < W; x++)
        out[x] = 0;
    for (let y = 0; y < H; y++) {
        const rowBase = y * W * 4;
        for (let x = 0; x < W; x++) {
            const i = rowBase + x * 4;
            out[x] += (buf[i] + buf[i + 1] + buf[i + 2]) / 3;
        }
    }
    for (let x = 0; x < W; x++)
        out[x] /= H;
    return out;
}
/**
 * W3-3：屏幕状态账本 —— 跨帧增量编码的状态机。
 * 生命周期由调用方（集成接线）持有：实例化即启用（模块开关由调用方在更外层
 * 检查 incrementalEncodingEnabled —— 账本本身是被动的确定性机器）。
 * 一切方法绝不抛：分析/哈希/墙钟端口抛错 ⇒ 诚实降级为整帧关键帧。
 */
export class ScreenStateLedger {
    ports;
    tuning;
    prev = null;
    prevW = 0;
    prevH = 0;
    prevHash = null;
    /** 累计脏面积掩码（关键帧时刻的归一化分块网格 —— 记账的最小单元） */
    mask = new Uint8Array(0);
    maskCols = 0;
    maskRows = 0;
    maskMarked = 0;
    generation = 0;
    keyframeAt = -Infinity;
    constructor(ports = {}, tuning = {}) {
        this.ports = ports && typeof ports === 'object' ? ports : {};
        this.tuning = cleanTuning(tuning);
    }
    /** 账本归零（会话边界 / 显式重置 —— prev/mask/代数全清） */
    reset() {
        this.prev = null;
        this.prevW = 0;
        this.prevH = 0;
        this.prevHash = null;
        this.mask = new Uint8Array(0);
        this.maskCols = 0;
        this.maskRows = 0;
        this.maskMarked = 0;
        this.generation = 0;
        this.keyframeAt = -Infinity;
    }
    /** 可观测面：账本状态快照（投递协议与测试的诊断口） */
    stats() {
        let age = null;
        if (this.prev) {
            try {
                age = Math.max(0, (this.ports.now?.() ?? Date.now()) - this.keyframeAt);
            }
            catch {
                age = null;
            }
        }
        return {
            generation: this.generation,
            hasPrev: this.prev !== null,
            prevDims: this.prev ? { width: this.prevW, height: this.prevH } : null,
            cumulativeDirtyPct: this.maskPct(),
            keyframeAgeMs: age,
        };
    }
    /**
     * 帧入账：diff → 分诊判决（keyframe/patch/scroll/silent）。
     * 分诊序（先重置信号、后经济信号 —— 惊异与 TTL 是硬约束）：
     *   冷启动/分辨率突变/forceKeyframe/surpriseBits≥阈/TTL 到期/分析端口抛错
     *     ⇒ keyframe（重置账本）；
     *   同哈希快路径（哈希端口在场且与上一帧同纹）⇒ silent；
     *   行移判定成立（大面积 + 平移假设可信 + 行移在 [minDy, maxDyFrac] 窗内）
     *     ⇒ scroll（向量 + 新入内容条带；条带入账累计掩码）；
     *   单帧脏面积 ≥ patchDirtyPct ⇒ keyframe（大变不补丁）；
     *   无变化 ⇒ silent；
     *   其余 ⇒ patch（合并外扩后的脏矩形；入账累计掩码，累计超阈 ⇒ keyframe）。
     * opts.surpriseBits：世界快照的惊异信号（只读消费 —— 语义跳变压过像素证据）。
     */
    async ingest(frame, opts) {
        const now = this.safeNow();
        // 缓冲体检：非缓冲/空 ⇒ 诚实关键帧（无像素可记账，账本不动）
        if (!Buffer.isBuffer(frame) || frame.length === 0) {
            return this.verdict('keyframe', [], null, 0, 'empty frame buffer — ledger untouched, deliver full frame', 'invalid frame buffer');
        }
        const surprise = typeof opts?.surpriseBits === 'number' && Number.isFinite(opts.surpriseBits)
            ? opts.surpriseBits : 0;
        // 冷启动：首帧即关键帧（自分析探测维度 —— before=after 恒 identical）
        if (!this.prev) {
            const probe = await this.safeAnalyze(frame, frame);
            if (!probe.ok) {
                return this.verdict('keyframe', [], null, 0, `cold-start probe failed (${probe.error}) — deliver full frame`, 'analyze port failed at cold start');
            }
            return this.adoptKeyframe(frame, probe.analysis, now, 'ledger cold start: first frame is the keyframe');
        }
        // 重置信号 ①：显式逃生口（模型请求整帧 / 补丁模式显式关闭）
        if (opts?.forceKeyframe === true) {
            const probe = await this.safeAnalyze(frame, frame);
            if (probe.ok) {
                return this.adoptKeyframe(frame, probe.analysis, now, 'forceKeyframe requested (escape hatch to full frame)');
            }
            return this.adoptKeyframeDimsFree(frame, now, 'forceKeyframe requested (escape hatch; dims unknown — probe failed)', 'cold probe failed at forceKeyframe');
        }
        // 重置信号 ②：惊异（世界快照的语义跳变 —— 压过一切像素证据）
        if (surprise >= this.tuning.surpriseBitsThreshold) {
            const probe = await this.safeAnalyze(frame, frame);
            if (probe.ok) {
                return this.adoptKeyframe(frame, probe.analysis, now, `surpriseBits ${surprise} >= ${this.tuning.surpriseBitsThreshold} (world snapshot surprise)`);
            }
            return this.adoptKeyframeDimsFree(frame, now, `surpriseBits ${surprise} reset (probe failed)`, 'cold probe failed at surprise reset');
        }
        // 重置信号 ③：TTL 到期（关键帧的最大年龄 —— P 帧链漂移的时间天花板）
        if (now - this.keyframeAt >= this.tuning.ttlMs) {
            const probe = await this.safeAnalyze(frame, frame);
            if (probe.ok) {
                return this.adoptKeyframe(frame, probe.analysis, now, `ledger TTL expired (${Math.round(now - this.keyframeAt)}ms >= ${this.tuning.ttlMs}ms)`);
            }
            return this.adoptKeyframeDimsFree(frame, now, 'ledger TTL expired (probe failed)', 'cold probe failed at TTL reset');
        }
        // 快路径：哈希端口在场且与上一帧同纹 ⇒ 静默（免差分；TTL/惊异已在前面的
        // 重置信号里检查过，此处静默是安全的）
        const hash = this.safeHash(frame);
        if (hash !== null && hash === this.prevHash) {
            return this.verdict('silent', [], null, 0, 'same frame hash as last ingested — nothing to deliver', null);
        }
        // 全量分析（diff + 行移）
        const analyzed = await this.safeAnalyze(this.prev, frame);
        if (!analyzed.ok) {
            // 端口缺席/抛错 ⇒ 降级整帧关键帧（增量是增益不是依赖 —— 绝不带崩主路径）
            const probe = await this.safeAnalyze(frame, frame);
            if (probe.ok) {
                return this.adoptKeyframe(frame, probe.analysis, now, `analyze port failed (${analyzed.error}) — degraded to full frame`, 'analyze port failed');
            }
            return this.adoptKeyframeDimsFree(frame, now, `analyze port failed (${analyzed.error}) — degraded to full frame`, 'analyze port failed (dims unknown)');
        }
        const a = analyzed.analysis;
        const srcW = Math.floor(a.width), srcH = Math.floor(a.height);
        if (!(srcW >= 1) || !(srcH >= 1)) {
            return this.adoptKeyframeDimsFree(frame, now, 'analysis returned no usable dimensions — degraded to full frame', 'analysis dims missing');
        }
        // 重置信号 ④：分辨率突变（跨屏切换/窗口 resize —— 坐标系整体失效）
        if (srcW !== this.prevW || srcH !== this.prevH) {
            return this.adoptKeyframe(frame, a, now, `resolution changed ${this.prevW}x${this.prevH} -> ${srcW}x${srcH}`);
        }
        // 滚动分诊：大面积 + 平移假设可信 + 行移在有效窗内
        const rs = a.rowShift;
        if (rs && typeof rs.shift === 'number' && Number.isFinite(rs.shift) &&
            typeof rs.residual === 'number' && Number.isFinite(rs.residual) &&
            a.changedPct >= this.tuning.scrollMinChangedPct &&
            Math.abs(rs.shift) >= 1 && rs.residual < this.tuning.scrollResidualMax && a.diffRows >= 4) {
            const dyPx = Math.round((rs.shift * srcH) / a.diffRows);
            const absDy = Math.abs(dyPx);
            if (absDy >= this.tuning.scrollMinDyPx && absDy <= this.tuning.scrollMaxDyFrac * srcH) {
                // 新入内容条带：内容下移（dy>0）⇒ 新内容从顶部进入；上移 ⇒ 底部进入
                const band = dyPx > 0
                    ? { x: 0, y: 0, w: srcW, h: absDy }
                    : { x: 0, y: srcH - absDy, w: srcW, h: absDy };
                this.markRects([band]);
                if (this.maskPct() > this.tuning.cumulativeDirtyPct) {
                    return this.adoptKeyframe(frame, a, now, `scroll of ${dyPx}px pushed cumulative dirty ${this.maskPct().toFixed(1)}% > ${this.tuning.cumulativeDirtyPct}% — keyframe reset`);
                }
                this.advancePrev(frame, hash, srcW, srcH);
                return this.verdict('scroll', [band], { dyPx, shiftRows: rs.shift, residual: rs.residual }, a.changedPct, `content scrolled ${dyPx > 0 ? 'down' : 'up'} by ${absDy}px (residual ${rs.residual}); band = newly revealed strip at ${dyPx > 0 ? 'top' : 'bottom'}`, null);
            }
        }
        // 大变分诊：单帧脏面积 ≥ patchDirtyPct ⇒ 关键帧（补丁的经济性下限）
        if (a.changedPct >= this.tuning.patchDirtyPct) {
            return this.adoptKeyframe(frame, a, now, `single-frame dirty area ${a.changedPct}% >= ${this.tuning.patchDirtyPct}% — too big to patch`);
        }
        // 静默分诊：逐像素无变化
        if (a.identical || a.regions.length === 0 || a.changedPct < 0.1) {
            return this.verdict('silent', [], null, a.changedPct, 'frame visually identical to last ingested — nothing to deliver', null);
        }
        // 补丁分诊：脏矩形合并外扩 → 入账累计掩码 → 超阈重置
        const rects = regionsToPatchRects(a.regions, srcW, srcH, this.tuning);
        if (rects.length === 0) {
            return this.verdict('silent', [], null, a.changedPct, 'no usable patch rects from diff regions — nothing to deliver', null);
        }
        const coverage = rects.reduce((s, r) => s + r.w * r.h, 0) / (srcW * srcH);
        if (coverage > 0.5) {
            return this.adoptKeyframe(frame, a, now, `merged patch coverage ${(coverage * 100).toFixed(1)}% exceeds sanity bound — keyframe reset`);
        }
        this.markRects(rects);
        if (this.maskPct() > this.tuning.cumulativeDirtyPct) {
            return this.adoptKeyframe(frame, a, now, `cumulative dirty ${this.maskPct().toFixed(1)}% > ${this.tuning.cumulativeDirtyPct}% — keyframe reset (P-frame drift ceiling)`);
        }
        this.advancePrev(frame, hash, srcW, srcH);
        const list = rects.map(r => `(${r.x},${r.y},${r.w}x${r.h})`).join(' ');
        return this.verdict('patch', rects, null, a.changedPct, `dirty area ${a.changedPct}% < ${this.tuning.patchDirtyPct}% — deliver ${rects.length} patch(es): ${list}`, null);
    }
    // ── 内部：判决铸造与账本操作 ──
    verdict(kind, patches, scroll, changedPct, reason, degraded) {
        return {
            kind,
            patches,
            scroll,
            changedPct: typeof changedPct === 'number' && Number.isFinite(changedPct) ? changedPct : 0,
            cumulativeDirtyPct: this.maskPct(),
            generation: this.generation,
            reason,
            degraded,
        };
    }
    /** 关键帧收养：prev ← frame、掩码重建、代数 +1、TTL 时钟重置 */
    adoptKeyframe(frame, a, now, reason, degraded = null) {
        const srcW = Math.floor(a.width), srcH = Math.floor(a.height);
        if (!(srcW >= 1) || !(srcH >= 1)) {
            return this.adoptKeyframeDimsFree(frame, now, `${reason} (dims dirty)`, degraded ?? 'analysis dims missing at keyframe adoption');
        }
        this.prev = frame;
        this.prevW = srcW;
        this.prevH = srcH;
        this.prevHash = this.safeHash(frame);
        this.maskCols = 32;
        this.maskRows = Math.max(8, Math.round((32 * srcH) / srcW));
        this.mask = new Uint8Array(this.maskCols * this.maskRows);
        this.maskMarked = 0;
        this.generation += 1;
        this.keyframeAt = now;
        return this.verdict('keyframe', [], null, 0, `${reason} — deliver full keyframe (generation ${this.generation})`, degraded);
    }
    /** 关键帧收养（维度未知 —— 分析端口双重失败时的兜底路径：掩码退化为全清洁的 1×1 网格） */
    adoptKeyframeDimsFree(frame, now, reason, degraded) {
        this.prev = frame;
        this.prevW = 0;
        this.prevH = 0;
        this.prevHash = this.safeHash(frame);
        this.maskCols = 1;
        this.maskRows = 1;
        this.mask = new Uint8Array(1);
        this.maskMarked = 0;
        this.generation += 1;
        this.keyframeAt = now;
        return this.verdict('keyframe', [], null, 0, `${reason} — deliver full keyframe (generation ${this.generation})`, degraded);
    }
    /** 非关键帧前进：prev ← frame（哈希可能缺席 —— 快路径降级为全量差分） */
    advancePrev(frame, hash, srcW, srcH) {
        this.prev = frame;
        this.prevHash = hash ?? this.safeHash(frame);
        this.prevW = srcW;
        this.prevH = srcH;
    }
    /** 累计掩码标记（源图像素矩形 → 归一化分块网格的覆盖块全置位） */
    markRects(rects) {
        if (this.maskCols < 1 || this.maskRows < 1 || !(this.prevW >= 1) || !(this.prevH >= 1))
            return;
        for (const r of rects) {
            const cx0 = Math.max(0, Math.min(this.maskCols - 1, Math.floor((r.x / this.prevW) * this.maskCols)));
            const cy0 = Math.max(0, Math.min(this.maskRows - 1, Math.floor((r.y / this.prevH) * this.maskRows)));
            const cx1 = Math.max(0, Math.min(this.maskCols, Math.ceil(((r.x + r.w) / this.prevW) * this.maskCols)));
            const cy1 = Math.max(0, Math.min(this.maskRows, Math.ceil(((r.y + r.h) / this.prevH) * this.maskRows)));
            for (let cy = cy0; cy < cy1; cy++) {
                for (let cx = cx0; cx < cx1; cx++) {
                    const i = cy * this.maskCols + cx;
                    if (!this.mask[i]) {
                        this.mask[i] = 1;
                        this.maskMarked += 1;
                    }
                }
            }
        }
    }
    /** 累计脏面积占比（掩码分块计数 / 总块数 ×100） */
    maskPct() {
        const total = this.maskCols * this.maskRows;
        return total > 0 ? Math.round((this.maskMarked / total) * 1000) / 10 : 0;
    }
    /** 墙钟安全读（端口抛错 ⇒ Date.now 兜底 —— 绝不因端口带崩入账） */
    safeNow() {
        try {
            const v = this.ports.now?.();
            return typeof v === 'number' && Number.isFinite(v) ? v : Date.now();
        }
        catch {
            return Date.now();
        }
    }
    /** 哈希端口安全读（缺席/抛错/非串 ⇒ null —— 快路径诚实关闭） */
    safeHash(buf) {
        try {
            const v = this.ports.hashFrame?.(buf);
            return typeof v === 'string' ? v : null;
        }
        catch {
            return null;
        }
    }
    /** 分析端口安全执行（缺省内置 sharp 管线；抛错/脏返回 ⇒ {ok:false,error}） */
    async safeAnalyze(before, after) {
        try {
            const analyze = this.ports.analyze ?? defaultAnalyze;
            const r = await analyze(before, after);
            if (!r || typeof r !== 'object' || !(r.width >= 1) || !(r.height >= 1)) {
                return { ok: false, error: 'analysis returned no usable result' };
            }
            return { ok: true, analysis: r };
        }
        catch (e) {
            return { ok: false, error: e?.message ? String(e.message) : String(e) };
        }
    }
}
