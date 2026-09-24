// src/motionEstimator.ts
// Y-3 运动估计器：滚动闭环的数学躯体。
//
// 理论：内容竖直平移在「行亮度序列」上是纯相位移动 —— 前后两帧的 64 维
// 行亮度向量 A/B 的错位误差最小化 = 一维相位相关（离散搜索 [-r, r]）。
// 亚行精度：对最优位移 s* 及其邻点 (s*-1, s*+1) 的误差做三点抛物线拟合，
// 峰值位移取抛物线顶点 s* + (E(s*-1) - E(s*+1)) / (2(E(s*-1) - 2E(s*) + E(s*+1)))
// —— 经典亚像素配准（Tian & Huhns 1986 的离散化形）。
//
// 语义约定（与 intent.ts 的 detectShift 同律）：shift > 0 = after 内容相对
// before 下移（= 用户向上滚动看到新内容从底部进来……与 scroll up/down 的
// 映射由调用方按平台习惯解释）；这里只产出物理事实。
/** 一维行亮度错位误差（归一化平均绝对差） */
function misalignError(a, b, s) {
    let err = 0, n = 0;
    for (let y = 0; y < a.length; y++) {
        const y2 = y + s;
        if (y2 < 0 || y2 >= b.length)
            continue;
        err += Math.abs(a[y] - b[y2]);
        n++;
    }
    return n > 0 ? err / n : Infinity;
}
/**
 * 估计前后帧行亮度序列的竖直位移（亚行精度）。
 * rowsA = before，rowsB = after；searchRange 行内搜索。
 */
export function estimateRowShift(rowsA, rowsB, searchRange = 16) {
    const n = Math.min(rowsA.length, rowsB.length);
    if (n < 4)
        return { shift: 0, residual: 1, bestInteger: 0 };
    let bestS = 0, bestE = Infinity, secondE = Infinity;
    for (let s = -searchRange; s <= searchRange; s++) {
        const e = misalignError(rowsA, rowsB, s);
        if (e < bestE) {
            secondE = bestE;
            bestE = e;
            bestS = s;
        }
        else if (e < secondE) {
            secondE = e;
        }
    }
    // 尺度归一：行亮度均值的平均量级（避免残差依赖画面明暗）
    const scale = (avg(rowsA) + avg(rowsB)) / 2 || 1;
    const residual = Math.min(1, bestE / scale);
    // 三点抛物线亚行细化（顶点位移）
    const eM = misalignError(rowsA, rowsB, bestS - 1);
    const eP = misalignError(rowsA, rowsB, bestS + 1);
    const denom = eM - 2 * bestE + eP;
    const frac = Math.abs(denom) < 1e-9 ? 0 : Math.max(-0.5, Math.min(0.5, (eM - eP) / (2 * denom)));
    const shift = bestS + (Number.isFinite(frac) ? frac : 0);
    return { shift: Math.round(shift * 100) / 100, residual: Math.round(residual * 1000) / 1000, bestInteger: bestS };
}
export function judgeScroll(est, direction) {
    const vertical = direction === 'up' || direction === 'down';
    if (!vertical) {
        // 水平滚动暂无列亮度序列 —— 只有「动没动」事实，方向一致性诚实缺席
        return {
            effective: Math.abs(est.shift) >= 1 && est.residual < 0.5,
            directionConsistent: null,
            atBoundary: est.residual < 0.35 && Math.abs(est.shift) < 0.5,
        };
    }
    // 约定：scroll down（滚轮向下）⇒ 内容整体上移 ⇒ after 相对 before shift < 0
    const expectedSign = direction === 'down' ? -1 : 1;
    const moved = Math.abs(est.shift) >= 1 && est.residual < 0.5;
    return {
        effective: moved,
        directionConsistent: moved ? Math.sign(est.bestInteger) === expectedSign : null,
        atBoundary: est.residual < 0.35 && Math.abs(est.shift) < 0.5,
    };
}
function avg(xs) {
    return xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
}
