// src/calibration.ts
// O 纪元（#13）：标定回路 —— 「形状字面量」的换血制度。
//
// 立法：算法形状（阈值/常数/表格）在无数据时以字面量服役（各纪元报告已声明）；
// 本模块给每个字面量配**标定原子**：给定真实观测序列 ⇒ 产出标定值 + 拟合质量。
// 数据到位 = 换值一行；数据缺席 = 字面量继续服役（诚实边界不动）。
// 四个原子：
//   gpdAdCriticalTable    —— Anderson-Darling A² 临界值表（Monte-Carlo 自举：
//                            已知 GPD 采样 → PWM 拟合 → A² 统计量经验分位）
//   calibrateKalmanQR     —— Kalman Q/R 方差比（一步预测误差的网格 MLE）
//   calibrateSchmittEvidence —— 施密特证据强度（带标签帧序列上的分离度最优）
//   calibrateNcdThreshold —— NCD 召回阈（带标签 (查询, 死路) 对上的 Youden J 最优点）
// 全部纯函数、可播种、确定性 —— 标定结果可复现可审计。
import { Telemetry, fitGpdPwm } from './telemetry.js';
// ─── A² 临界值表：Monte-Carlo 自举（Choulakian & Stephens 2001 的工程等价物）───
/**
 * GPD Anderson-Darling A² 经验临界值：nSims 次已知 GPD(ξ, σ=1) 采样
 * （每条 nSample 个超额）→ PWM 拟合 → 拟合分布下的 A² 统计量 → 经验分位。
 * 与论文表的对偶：论文给名义值，本表给**本估计器本样本量**下的自举值 ——
 * 拟合不确定度已内含（检验的是我们实际用的那个估计器，不是教科书神器）。
 */
export function gpdAdCriticalTable(opts = {}) {
    const xi = opts.xi ?? 0.2;
    const nSample = opts.nSample ?? 200;
    const nSims = opts.nSims ?? 800;
    const rnd = Telemetry.seededUniform(opts.seed ?? 20260920);
    const stats = [];
    for (let s = 0; s < nSims; s++) {
        // 逆 CDF 采样 GPD(ξ, 1)
        const xs = [];
        for (let i = 0; i < nSample; i++) {
            const u = rnd();
            xs.push((Math.pow(1 - u, -xi) - 1) / xi);
        }
        stats.push(gpdAdStatistic(xs));
    }
    stats.sort((a, b) => a - b);
    const q = (alpha) => Math.round(stats[Math.floor(alpha * nSims)] * 1000) / 1000;
    return { alpha10: q(0.90), alpha05: q(0.95), alpha01: q(0.99), nSims, nSample };
}
/** 单样本 A² 统计量（对 PWM 拟合分布）：z = F_θ̂(x) 升序下的 Choulakian 形态。
 *  P 纪元修正（第九只 bug）：本函数旧版 gpdCdf 用了**反号 ξ 约定**
 *  （1−ξx/σ 的有界形）—— 与采样器和 PWM 的 wiki 约定（1+ξx/σ 重尾形）相反，
 *  MC 临界表在错误 CDF 下计算（分位 78-160 vs 文献 ~0.5-2.7）。O-#13 测试
 *  只断言确定性与单调性，抓不住约定错配 —— 修后并入已知参数恢复执法。
 *  PWM 直接 import telemetry.fitGpdPwm（双实现漂移虫型一并根除）。 */
function gpdAdStatistic(xs) {
    const sorted = [...xs].sort((a, b) => a - b);
    const fit = fitGpdPwm(sorted);
    if (!fit)
        return 0;
    // 公式体唯一事实源 = Telemetry.andersonDarlingGpd（双实现漂移虫型根除）
    return Telemetry.andersonDarlingGpd(sorted, fit.xi, fit.sigma);
}
/**
 * Kalman Q/R 标定：给定真实 (预测漂移, 观测漂移) 对序列，在对数网格上
 * 搜 Q/R 比值最小化一步预测 MSE（各向同性标量滤波的稳态增益 K =
 * λ/(λ+1)，λ = (Q + sqrt(Q² + 4QR))/(2R) 稳态解 —— 网格扫描免闭式）。
 * 返回标定 (Q, R) 与最优比 —— 与 swarm 的 KF_Q=1/KF_R=1 形状对照。
 */
export function calibrateKalmanQR(pairsRaw) {
    // P 纪元修正（第十只 bug 之 a）：非有限样本先滤（NaN 毒化曾产出 mse=0 的
    // 谎言标定）；诚实下限按**净化后**样本计。
    const pairs = pairsRaw.filter(p => Number.isFinite(p.predicted) && Number.isFinite(p.observed));
    if (pairs.length < 8)
        return null; // 诚实下限：样本不足不标定
    let best = null;
    const grid = [0.03, 0.1, 0.3, 1, 3, 10, 30]; // 对数网格（Q/R 候选比值）
    for (const ratio of grid) {
        // 稳态 Kalman：P 递推至收敛 → K（DARE 闭式解的数值形态，P-6 执法）
        let p = 1;
        for (let i = 0; i < 200; i++)
            p = (p + ratio) * 1 / (1 + (p + ratio)); // R=1 归一：Q=ratio
        const k = p;
        // P 纪元修正（第十只 bug 之 b）：predicted 不再是装饰字段 —— 互补滤波
        // 一步预测 ŷ_t = k·观测_{t-1} + (1−k)·模型预测_t（模型先验与观测后验
        // 的稳态融合；MSE 对 ŷ 计 —— 标定的正是「该增益下模型+观测联合预测」
        // 的误差，与 swarm Kalman 的消费语义对齐）。
        let mse = 0;
        for (let t = 1; t < pairs.length; t++) {
            const yhat = k * pairs[t - 1].observed + (1 - k) * pairs[t].predicted;
            mse += (pairs[t].observed - yhat) ** 2;
        }
        mse /= Math.max(1, pairs.length - 1);
        if (Number.isFinite(mse) && (!best || mse < best.mse)) {
            best = { q: Math.round(ratio * 1000) / 1000, r: 1, ratio, mse: Math.round(mse * 1e6) / 1e6 };
        }
    }
    return best ? { ...best, n: pairs.length } : null;
}
/**
 * 施密特证据强度标定：在 (EVIDENCE_SEM, EVIDENCE_GEO) 小网格上找使
 * 「真弹窗帧的稳态信念 − 非弹窗帧的稳态信念」最大化（分离度）的组合。
 * 返回标定强度对 —— 与 popupDetector 的字面量（+ln3 / +ln2 级）对照。
 */
export function calibrateSchmittEvidence(frames) {
    if (frames.length < 8)
        return null;
    const pos = frames.filter(f => f.isPopup);
    const neg = frames.filter(f => !f.isPopup);
    if (pos.length < 2 || neg.length < 2)
        return null; // 双侧都要有 —— 单侧无从标分离度
    const sigmoid = (x) => 1 / (1 + Math.exp(-x));
    let best = null;
    for (const sem of [0.5, 1, Math.log(3), 2, 3]) {
        for (const geo of [0.25, 0.5, Math.log(2), 1, 1.5]) {
            const steady = (f) => {
                let lo = 0; // 先验 log-odds 0（中性 —— 与 POPUP_PRIOR 形状解耦）
                for (let i = 0; i < 12; i++)
                    lo += f.semantic ? sem : f.geometric ? geo : -0.5;
                return sigmoid(lo / 12 + lo * 0); // 稳态近似：平均证据率下的 log-odds
            };
            const posMean = pos.reduce((s, f) => s + steady(f), 0) / pos.length;
            const negMean = neg.reduce((s, f) => s + steady(f), 0) / neg.length;
            const sep = posMean - negMean;
            if (!best || sep > best.sep)
                best = { sem: Math.round(sem * 1000) / 1000, geo: Math.round(geo * 1000) / 1000, sep };
        }
    }
    if (!best)
        return null;
    return {
        evidenceSem: best.sem,
        evidenceGeo: best.geo,
        evidenceClean: -0.5,
        separation: Math.round(best.sep * 1000) / 1000,
        n: frames.length,
    };
}
/**
 * NCD 召回阈标定：带标签 (相似度, 是否相关) 对上扫描阈值，取 Youden J
 * （TPR − FPR）最大点 —— 与 failureMemory 的 score > 0.2 字面量对照。
 */
export function calibrateNcdThreshold(pairsRaw) {
    // P 纪元修正：非有限相似度先滤（NaN 毒化曾静默产出 j<0 的垃圾标定）
    const pairs = pairsRaw.filter(p => Number.isFinite(p.similarity));
    if (pairs.length < 8)
        return null;
    const pos = pairs.filter(p => p.relevant);
    const neg = pairs.filter(p => !p.relevant);
    if (pos.length < 2 || neg.length < 2)
        return null;
    const candidates = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6];
    let best = null;
    for (const t of candidates) {
        const tp = pos.filter(p => p.similarity >= t).length;
        const fp = neg.filter(p => p.similarity >= t).length;
        const tpr = tp / pos.length, fpr = fp / neg.length;
        const j = tpr - fpr;
        if (!best || j > best.j)
            best = { t, tpr: Math.round(tpr * 1000) / 1000, fpr: Math.round(fpr * 1000) / 1000, j: Math.round(j * 1000) / 1000 };
    }
    return best ? { threshold: best.t, tpr: best.tpr, fpr: best.fpr, j: best.j, n: pairs.length } : null;
}
