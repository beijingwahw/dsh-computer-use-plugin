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
 * W6-5：一维相位相关核（行/列共用 —— 纯数学，与轴无关）。原 estimateRowShift
 * 主体原样上提：搜索 [-r, r] 最小错位误差 → 尺度归一残差 → 三点抛物线亚单位
 * 细化（顶点位移 s* + (E(s*-1)-E(s*+1)) / (2(E(s*-1)-2E(s*)+E(s*+1)))）。
 * 逐字节不变量的结构保证：estimateRowShift 委托本核，同一输入同一输出。
 */
function phaseCorrelate1D(a, b, searchRange) {
    const n = Math.min(a.length, b.length);
    if (n < 4)
        return { shift: 0, residual: 1, bestInteger: 0 };
    let bestS = 0, bestE = Infinity;
    for (let s = -searchRange; s <= searchRange; s++) {
        const e = misalignError(a, b, s);
        if (e < bestE) {
            bestE = e;
            bestS = s;
        }
    }
    // 尺度归一：亮度均值的平均量级（避免残差依赖画面明暗）
    const scale = (avg(a) + avg(b)) / 2 || 1;
    const residual = Math.min(1, bestE / scale);
    // 三点抛物线亚单位细化（顶点位移）
    const eM = misalignError(a, b, bestS - 1);
    const eP = misalignError(a, b, bestS + 1);
    const denom = eM - 2 * bestE + eP;
    const frac = Math.abs(denom) < 1e-9 ? 0 : Math.max(-0.5, Math.min(0.5, (eM - eP) / (2 * denom)));
    const shift = bestS + (Number.isFinite(frac) ? frac : 0);
    return { shift: Math.round(shift * 100) / 100, residual: Math.round(residual * 1000) / 1000, bestInteger: bestS };
}
/**
 * 估计前后帧行亮度序列的竖直位移（亚行精度）。
 * rowsA = before，rowsB = after；searchRange 行内搜索。
 */
export function estimateRowShift(rowsA, rowsB, searchRange = 16) {
    return phaseCorrelate1D(rowsA, rowsB, searchRange);
}
/**
 * W6-5：估计前后帧列亮度序列的水平位移（亚列精度，estimateRowShift 的横向同构）。
 * colsA = before，colsB = after；searchRange 列内搜索。
 * shift > 0 = after 内容相对 before 右移（纵向约定「>0 = 下移」的水平对偶）。
 */
export function estimateColShift(colsA, colsB, searchRange = 16) {
    return phaseCorrelate1D(colsA, colsB, searchRange);
}
export function judgeScroll(est, direction, 
/** W6-5：水平方向的列亮度证据（可选注入 —— 缺席 ⇒ 水平判决保持旧行为） */
colEst) {
    const vertical = direction === 'up' || direction === 'down';
    if (!vertical) {
        // W6-5：列亮度证据在场 ⇒ 水平方向一致性可判（纵向同律的对偶执法）。
        // 约定：scroll right（向右滚动）⇒ 内容整体左移 ⇒ after 相对 before shift < 0。
        // 防御：脏证据（NaN/Infinity）视同缺席 —— 回落旧行为，绝不抛。
        if (colEst && typeof colEst === 'object'
            && Number.isFinite(colEst.shift) && Number.isFinite(colEst.residual)) {
            const expectedSign = direction === 'right' ? -1 : 1;
            const moved = Math.abs(colEst.shift) >= 1 && colEst.residual < 0.5;
            return {
                effective: moved,
                directionConsistent: moved ? Math.sign(colEst.bestInteger) === expectedSign : null,
                atBoundary: colEst.residual < 0.35 && Math.abs(colEst.shift) < 0.5,
            };
        }
        // 列证据缺席（旧行为，逐字节不变）：只有「动没动」事实，方向一致性诚实缺席
        return {
            effective: Math.abs(est.shift) >= 1 && est.residual < 0.5,
            directionConsistent: null,
            atBoundary: est.residual < 0.35 && Math.abs(est.shift) < 0.5,
        };
    }
    // 纵向（旧行为，逐字节不变；colEst 不参与 —— 纵向判决只认行证据）
    // 约定：scroll down（滚轮向下）⇒ 内容整体上移 ⇒ after 相对 before shift < 0
    const expectedSign = direction === 'down' ? -1 : 1;
    const moved = Math.abs(est.shift) >= 1 && est.residual < 0.5;
    return {
        effective: moved,
        directionConsistent: moved ? Math.sign(est.bestInteger) === expectedSign : null,
        atBoundary: est.residual < 0.35 && Math.abs(est.shift) < 0.5,
    };
}
/**
 * W1-1（A5 稳态门控）：内容是否仍在平移 —— 稳态判定的运动维度一步判决。
 * 与 judgeScroll 的 effective 同尺（|shift| ≥ 1 行且平移假设成立），但方向无关：
 * 稳态只问「还在动吗」，不问往哪动。脏输入（NaN/Infinity）一律 false。
 * W6-5：轴无关纯判（只读 shift/residual 数值）—— 行移/列移（ColShiftEstimate）
 * 估计皆可入参（横向平移的稳态判定同律消费，无需另造平行函数）。
 */
export function stillTranslating(est) {
    if (!est || typeof est !== 'object')
        return false;
    return (typeof est.shift === 'number' && Number.isFinite(est.shift) &&
        Math.abs(est.shift) >= 1 &&
        typeof est.residual === 'number' && Number.isFinite(est.residual) &&
        est.residual < 0.5);
}
function avg(xs) {
    return xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
}
