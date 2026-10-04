// src/kernel/calibrator.ts
// 纪元 Θ（Θ-2 在线校准器）：内核参数的证据驱动换血 —— 挂在 Θ-1 的
// (KernelRegistry, EvidenceLedger) 与本模块的 KernelLineage 三器官上，
// 每 tick 用最新证据水位把参数推动**一小步**（可回滚、可审计、可复现）。
//
// 与 src/calibration.ts（O 纪元标定原子）的血统关系：那是**离线原子** —— 给定
// 完整标签序列一次性产出标定值；本模块是在线版 —— 证据滑窗 + 证据门 + 步长上限 +
// 回归守卫，把同型寻优切成可回滚的小步。「样本 <8 不标定」的诚实下限律在此延续
// （optimalThreshold 样本不足 / 无判定结构 ⇒ null ⇒ 参数不动，字面量继续服役）。
//
// 兄弟契约：registry / ledger 的签名照 src/kernel/registry.ts（Θ-1）逐字引用
// （import type —— 类型即契约，运行时零耦合）。纯离线、零网络、零 IO、
// 全确定性（now 可注入）、绝不抛。
//
// ΑΩ-R39（真标签换血）：阈学习输入从「stats 汇总 + reconstructLabels 伪造标签」
// 换为 ledger.entries 的逐记录 (margin, success) 真标签（真判别学习）；重建先验
// 降级为回退路径（仅记录缺 success 的历史档/防御恢复残缺时启用），所用标签源在
// CalibrationReport.labelSource 如实申报（诚实口径：真标签与代用统计量不混报）。
//
// ΝΩ-6（P1×2 进化内核统计治理升级）：
//   · 回归守卫贝叶斯化：频率派容忍带（successRate < 上代 fitness − rollbackDrop）
//     退役 —— n=20 时二项 1σ≈0.10，噪声波动即可越过 0.05 容忍带 ⇒ 参数代际振荡
//     回滚、血统账被噪声填满。改判 Beta-Bernoulli 后验：P(rate_true < 上代
//     fitness | 当前窗证据) ≥ rollbackPosteriorMass（缺省 0.9）才回滚。闭式
//     正则化不完全 Beta（Lentz 连分式），无随机采样，全确定性；证据不足
//     （n < minPostEvidence）维持旧行为（不判回归，保守兜底）。
//   · 安全参数分池：safetyCritical 键（生产册标记，缺省集 =
//     SAFETY_CRITICAL_KERNEL_KEYS）tick 跳过自动校准、立 skipped-safety-critical
//     报告 —— 换值唯一合法通道 = gym 实验室进化 → 显式 promoteFrom。
//
// K-4（ΝΩ-6 顺修，registry.evidence 双账漂移的处置）：普查结论 —— evidence 字段
// 无任何判决消费方（写径 memoryOps.addEvidence / store 回放增量补；读径仅 store
// 持久化对账与 drift() 报表）。故降级为 report-only 注记：本校准器的一切证据
// 判决（① 证据门 / ⑤ 回归守卫）唯一证据源 = ledger 滑窗的 stats().n /
// successRate，永不读 registry.evidence（测试锁定：虚增 evidence 计数不改变
// tick 判决）。「与 ledger 同源」的替代方案被否决：evidence 是累计计数而滑窗是
// 200-FIFO，强行同源须把注册表耦合进账本回放 —— 为无消费方的字段付耦合税，不值。
//
// ΝΩ-33（GP-UCB 阈学习器）：optimalThreshold 的网格学习在「排序 margins 相邻
// 中点网格上取最大经验正确率」—— n=30 小样本时经验正确率的 argmax 是在二项
// 噪声上取峰（无过拟合控制；平票取中位数只在完全平票时生效）。新 learner
// 'gp-ucb' 把 (margin → 成功率) 建为一维 GP（逐记录 (margin, 0/1) 为噪声观测），
// 候选阈按 GP-UCB 采集 + safe-BO 安全约束选取（见 optimalThresholdGpUcb 的
// 立法注释）。缺省 thresholdLearner='grid'：零回归铁律 —— 缺省行为与 ΝΩ-33
// 之前逐字节一致；gym 实验室 / 显式注入 'gp-ucb' 才走新路径（一切既有护栏 ——
// 诚实下限 / 证据门 / 步长 / ΝΩ-6 Beta 回归守卫 / safetyCritical 分池 —— 在
// 两 learner 之上同一执法）。晋升路径：gym 消融（optimalThreshold 与
// optimalThresholdGpUcb 是两个可同窗并调的纯函数，落值 drift 即对照面）证明
// gp-ucb 收敛质量后，翻缺省为 'gp-ucb'（一处字面量 + 本注释更新）。
import { SAFETY_CRITICAL_KERNEL_KEYS } from './productionSpecs.js';
/**
 * 缺省护栏：满月证据 30、单步 10% 区间、回归判定后验质量 ≥ 0.9（ΝΩ-6
 * Beta-Bernoulli；rollbackDrop 保留兼容锚、不再参与判决）、回归判定至少 20 条证据。
 */
export const DEFAULT_GUARDRAILS = {
    minEvidence: 30,
    maxStepPct: 0.1,
    rollbackDrop: 0.05,
    minPostEvidence: 20,
    rollbackPosteriorMass: 0.9,
};
/** 千分位净化：reason 里的数字统一 3 位小数（确定性字符串）。 */
const fmt = (x) => String(Math.round(x * 1000) / 1000);
/** 护栏数值消毒：非有限 / 越界 ⇒ 回落缺省值（绝不抛）。 */
function numOr(x, dflt, min, max) {
    return typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max ? x : dflt;
}
// ─── ΝΩ-6：Beta-Bernoulli 数学件（kernel 侧纯函数区）───
// 单源自 src/guards/circuitBreakerGuard.ts:74-128 逐字节搬移（lgamma / 连分式 /
// 正则化不完全 Beta）—— guards 那份不动（守卫层零改动），kernel 侧独立成区：
// 校准器与熔断守卫共用同一数学但互不 import（运行时零耦合的模块律优先；两份
// 的数值一致性由测试锁定）。全纯函数、零依赖、全确定性、绝不抛。
/** ln Γ(x)（Lanczos 近似 g=7 —— |ε| < 1e-13；Math.lgamma 尚未进 ES） */
// exempt(ΝΩ-41 BC-5)：与 guards/circuitBreakerGuard.ts 同体有意双份（ΝΩ-6 立法：两器官互不 import 的运行时零耦合律，数值一致性由测试锁定）—— 知情申报
function lgamma(x) {
    const g = [
        0.99999999999980993, 676.5203681218851, -1259.1392167224028,
        771.32342877765313, -176.61502916214059, 12.507343278686905,
        -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
    ];
    if (x < 0.5) {
        return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
    }
    x -= 1;
    let a = g[0];
    const t = x + 7.5;
    for (let i = 1; i < 9; i++)
        a += g[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
/** 正则化不完全 Beta 函数 I_x(a,b)（Lentz 连分式；a,b > 0，x ∈ [0,1]） */
// exempt(ΝΩ-41 BC-5)：与 guards/circuitBreakerGuard.ts 同体有意双份（ΝΩ-6 立法：两器官互不 import 的运行时零耦合律，数值一致性由测试锁定）—— 知情申报
function regularizedBeta(x, a, b) {
    if (x <= 0)
        return 0;
    if (x >= 1)
        return 1;
    const lbeta = lgamma(a + b) - lgamma(a) - lgamma(b)
        + a * Math.log(x) + b * Math.log(1 - x);
    const bt = Math.exp(lbeta);
    if (x < (a + 1) / (a + b + 2)) {
        return bt * betacf(x, a, b) / a;
    }
    return 1 - bt * betacf(1 - x, b, a) / b;
}
/** 连分式（NR 6.4：迭代至 |Δ| < 3e-12，上限 200 轮） */
/** W6-1（风格债）：连分式迭代上限 —— 原裸字面量 200 提取为具名常量，数值逐位不变 */
const BETACF_MAX_ITERATIONS = 200;
// exempt(ΝΩ-41 BC-5)：与 guards/circuitBreakerGuard.ts 同体有意双份（ΝΩ-6 立法：两器官互不 import 的运行时零耦合律，数值一致性由测试锁定）—— 知情申报
function betacf(x, a, b) {
    const FPMIN = 1e-300;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - (qab * x) / qap;
    if (Math.abs(d) < FPMIN)
        d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= BETACF_MAX_ITERATIONS; m++) {
        const m2 = 2 * m;
        let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < FPMIN)
            d = FPMIN;
        c = 1 + aa / c;
        if (Math.abs(c) < FPMIN)
            c = FPMIN;
        d = 1 / d;
        h *= d * c;
        aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < FPMIN)
            d = FPMIN;
        c = 1 + aa / c;
        if (Math.abs(c) < FPMIN)
            c = FPMIN;
        d = 1 / d;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1) < 3e-12)
            break;
    }
    return h;
}
/**
 * ΝΩ-6 回归后验质量（纯函数，绝不抛）：当前窗 successes 胜 / n−successes 败、
 * 均匀先验 Beta(1,1)（与 guards 熔断臂 posteriorTripProbability 同一先验惯例）⇒
 * rate_true ~ Beta(k+1, n−k+1)；返回 P(rate_true < threshold) =
 * I_threshold(k+1, n−k+1) —— 闭式正则化不完全 Beta，无随机采样，全确定性
 * （整数 a,b 时与二项恒等式 I_t(a,b) = P(Y ≥ a), Y ~ Bin(a+b−1, t) 精确等价，
 * 测试用它做独立第二推导径交叉验证）。垃圾静默：n ≤ 0 ⇒ 0（无证据零质量）；
 * successes 非有限 / 越界夹取进 [0, n]；threshold 非有限按 0（质量 0），
 * 越界 [0,1] 由 regularizedBeta 收口（≤0 ⇒ 0，≥1 ⇒ 1）。输出四舍五入到 1e-4
 * （确定性比较与确定性 reason 字符串 —— guards 同律）。
 */
export function regressionPosteriorMass(successes, n, threshold) {
    const nn = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    if (nn === 0)
        return 0;
    const kkRaw = Number.isFinite(successes) ? Math.round(successes) : 0;
    const kk = Math.min(nn, Math.max(0, kkRaw));
    const t = Number.isFinite(threshold) ? threshold : 0;
    return Math.round(regularizedBeta(t, kk + 1, nn - kk + 1) * 10000) / 10000;
}
/** 正数消毒：非有限 / ≤0 ⇒ 回落缺省（绝不抛）。 */
function posOr(x, dflt) {
    return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : dflt;
}
/**
 * Cholesky 分解 A+diagAdd·I = L·Lᵀ（flat 行主序下三角；n>0）。非正定（对角
 * ≤1e-300）⇒ null —— 理论上 noiseVar>0 保证正定，此为数值护栏（绝不抛）。
 */
function choleskyWithDiagonal(a, diagAdd, n) {
    const L = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            let sum = a[i * n + j] + (i === j ? diagAdd : 0);
            for (let k = 0; k < j; k++)
                sum -= L[i * n + k] * L[j * n + k];
            if (i === j) {
                if (!(sum > 1e-300))
                    return null;
                L[i * n + i] = Math.sqrt(sum);
            }
            else {
                L[i * n + j] = sum / L[j * n + j];
            }
        }
    }
    return L;
}
/** 已有 L 的 SPD 解：返回 (L·Lᵀ)⁻¹·b（前代 + 回代，绝不抛）。 */
function solveFromCholesky(L, b) {
    const n = b.length;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let s = b[i];
        for (let k = 0; k < i; k++)
            s -= L[i * n + k] * y[k];
        y[i] = s / L[i * n + i];
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
        let s = y[i];
        for (let k = i + 1; k < n; k++)
            s -= L[k * n + i] * x[k];
        x[i] = s / L[i * n + i];
    }
    return x;
}
/** Cholesky 抖动阶梯（相对 priorVar；首试零抖动 —— noiseVar>0 时理应一次成功） */
const GP_JITTER_LADDER = [1e-10, 1e-8, 1e-6];
/**
 * 一维高斯过程拟合（纯函数，绝不抛）：核 k(x,x') = priorVar·exp(−(x−x')²/2ℓ²)、
 * 常量均值 meanValue、高斯噪声 noiseVar；闭式后验 μ*(x) = m + k_xᵀ(K+s²I)⁻¹(y−m)、
 * σ*²(x) = priorVar − k_xᵀ(K+s²I)⁻¹k_x（教科书式，Rasmussen & Williams 式 2.22–
 * 2.26 的噪声版；测试用伴随矩阵独立求逆做第二推导径对照）。μ 的权重向量在拟合时
 * 一次解出；σ 逐查询点三角回代。垃圾静默：xs/ys 按短者截齐、非有限项剔队、空集
 * ⇒ null；超参数非有限 / 非正 ⇒ 缺省（ℓ 缺省 1、方差缺省 0.25、均值缺省取 ys 均值）。
 * Cholesky 失败（非正定且抖动三档救不回）⇒ null（上层诚实下限，绝不抛）。
 */
export function gpRbf1d(xs, ys, hyper) {
    const X = [];
    const Y = [];
    const n0 = Math.min(xs?.length ?? 0, ys?.length ?? 0);
    for (let i = 0; i < n0; i++) {
        const x = xs[i];
        const y = ys[i];
        if (Number.isFinite(x) && Number.isFinite(y)) {
            X.push(x);
            Y.push(y);
        }
    }
    const n = X.length;
    if (n === 0)
        return null;
    const lengthScale = posOr(hyper?.lengthScale, 1);
    const priorVar = posOr(hyper?.priorVar, 0.25);
    const noiseVar = posOr(hyper?.noiseVar, 0.25);
    const meanRaw = typeof hyper?.meanValue === 'number' && Number.isFinite(hyper.meanValue)
        ? hyper.meanValue
        : Y.reduce((s, v) => s + v, 0) / n;
    const meanValue = Number.isFinite(meanRaw) ? meanRaw : 0;
    const K = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            const d = X[i] - X[j];
            K[i * n + j] = priorVar * Math.exp(-(d * d) / (2 * lengthScale * lengthScale));
        }
    }
    let L = null;
    for (let attempt = 0; attempt <= GP_JITTER_LADDER.length && L === null; attempt++) {
        const jitter = attempt === 0 ? 0 : GP_JITTER_LADDER[attempt - 1] * priorVar;
        L = choleskyWithDiagonal(K, noiseVar + jitter, n);
    }
    if (L === null)
        return null;
    const centered = new Float64Array(n);
    for (let i = 0; i < n; i++)
        centered[i] = Y[i] - meanValue;
    const weights = solveFromCholesky(L, centered); // (K+s²I)⁻¹(y−m)，μ 的一次性权重
    const rbf = (x, xi) => {
        const d = x - xi;
        return priorVar * Math.exp(-(d * d) / (2 * lengthScale * lengthScale));
    };
    const mu = (x) => {
        if (!Number.isFinite(x))
            return meanValue;
        let s = 0;
        for (let i = 0; i < n; i++)
            s += rbf(x, X[i]) * weights[i];
        return meanValue + s;
    };
    const sigma = (x) => {
        if (!Number.isFinite(x))
            return Math.sqrt(priorVar);
        const k = new Float64Array(n);
        for (let i = 0; i < n; i++)
            k[i] = rbf(x, X[i]);
        const v = solveFromCholesky(L, k);
        let q = 0;
        for (let i = 0; i < n; i++)
            q += k[i] * v[i];
        const post = priorVar - q;
        return Math.sqrt(post > 0 ? post : 0); // 数值护栏：负方差（浮点残差）截 0
    };
    return { mu, sigma, trainedPoints: n };
}
/** 训练点抽稀上限（矩阵规模决策见 optimalThresholdGpUcb 注释） */
const GP_TRAINING_POINT_CAP = 64;
/** UCB 探索系数 κ（工单 ΝΩ-33：1.0 常量冻结） */
const GP_UCB_KAPPA = 1.0;
/** 安全下界倍率（工单 ΝΩ-33：μ−2σ） */
const GP_SAFE_SIGMA_MULTIPLIER = 2;
/** 安全约束容忍 ε（工单 ΝΩ-33：0.02） */
const GP_SAFE_EPSILON = 0.02;
/** 采集/安全比较的浮点容差（与 grid 学习器的并列判定同容差量级） */
const GP_TIE_EPSILON = 1e-12;
/**
 * ΝΩ-33 GP-UCB 阈学习（纯函数，绝不抛）：把「margin → 成功率」建为一维 GP ——
 * 逐记录 (margin, 0/1) 为率的 Bernoulli 噪声观测（ΑΩ-R39 的真标签 / 重建先验
 * 标签皆可入，口径由调用方申报）；RBF 核 ℓ = margin 跨度/4（常量冻结）、先验
 * 方差 = 噪声方差 = 0.25（Bernoulli 方差上界 p(1−p) ≤ 0.25 —— 上界论证：保守
 * 侧偏置 ⇒ 收缩更强、后验 σ 更大，两效应都利好小样本抗过拟合）、常量均值 =
 * 全局成功率。候选网格与 grid 学习器同构（排序 margins 相邻中点 + 两端）。
 *
 * 判决三件套：
 *   ① A(t) = (1/n)Σᵢ [1{mᵢ≥t}·μ(mᵢ) + 1{mᵢ<t}·(1−μ(mᵢ))] —— 候选阈 t 的
 *      **GP 平滑正确率**（预测语义与 grid 完全同构：m ≥ t ⇒ 预测 success；唯一
 *      差别是把硬 0/1 标签换成 GP 后验软标签 μ(mᵢ)—— 孤立噪声点的贡献被核平滑
 *      收缩，这正是「σ 项在数据稀疏区天然抑制过拟合」的机理：噪声峰候选的
 *      A 不再虚高）；
 *   ② 采集（GP-UCB）：score(t) = A(t) + κ·σ(t)，κ=1.0 —— σ(t) 为候选点的逐点
 *      后验标准差（探索项：等 A 平台上偏好最远离数据的中点 ⇒ 宽分离带的中心，
 *      max-margin 味道）；
 *   ③ 安全约束（safe-BO）：A(t) − 2σ̄ ≥ baseline − ε（ε=0.02）才准入候选 ——
 *      baseline = A(现值)（同窗同尺度：现值阈自己的 GP 平滑正确率；「现值−ε」
 *      的诚实读法 —— 与候选同一把尺子量出来的现值水平减容忍）。σ̄ = √(Σσᵢ²)/n
 *      是 A 的聚合不确定度（n 点后验均值之均值，独立近似）—— 用它而非逐点 σ(t)
 *      做 2σ 罚是与 A 同尺度的诚实选择（逐点 σ ≈ 0.5 ⇒ 2σ 罚 ≈ 1 会否决一切，
 *      安全门变橡皮图章的反面：永久否决门）。不满足 ⇒ 全候选出局 ⇒ null
 *      （本代不换，保守保持）。
 *
 * 矩阵规模决策（工单问：n≤200 直接解，200×200 求逆成本可控？）：账本滑窗上限
 * 200（LEDGER_WINDOW）⇒ Cholesky O(n³/3) ≈ 2.7M 次乘加（亚毫秒）本可控；但逐
 * 候选 σ(t) 需 O(n²) 三角回代 × ≤201 候选 ⇒ 单参数单 tick ≈8M，55 键全量 tick
 * ≈0.44G 次乘加 —— 落在数十至数百毫秒的灰色地带。故取诱导点式抽稀：训练点
 * >64 时按 margin 排序等距抽到 ≤64（64³/3 ≈ 0.09M + 候选评估 ≈ 0.8M/参数，
 * 全量 tick <5ms）。精度论证：ℓ = 跨度/4 而 64 锚点 ⇒ 每长度尺度 ≥16 锚点
 * （RBF 有效带宽内的 Nyström 级覆盖），抽稀损失远小于 0/1 标签自身的
 * Bernoulli 噪声（0.25 主导）。用确定性等距抽稀而非随机 Nyström 采样 ——
 * 全确定性铁律（无随机）。
 *
 * 诚实下限（与 grid 学习器同律，全部保持）：净化后样本 <8 ⇒ null；全同 label
 * （无判定结构）⇒ null；现值非有限 ⇒ null；GP 拟合失败（Cholesky 救不回）⇒
 * null；无候选过安全门 ⇒ null（保守保持）。垃圾静默：非有限 margin / 非布尔
 * label 剔队、两数组按短者截齐 —— 绝不抛。
 */
export function optimalThresholdGpUcb(margins, labels, currentValue) {
    // 数据净化：与 optimalThreshold 同律的独立副本（零回归铁律 —— grid 路径
    // 逐字节不动，两份净化的一致性由测试锁定；不共用 helper 是刻意的）
    const pairs = [];
    const n0 = Math.min(margins?.length ?? 0, labels?.length ?? 0);
    for (let i = 0; i < n0; i++) {
        const m = margins[i];
        const y = labels[i];
        if (Number.isFinite(m) && typeof y === 'boolean')
            pairs.push({ m, y });
    }
    if (pairs.length < 8)
        return null; // 诚实下限：样本不足不标定
    const nPos = pairs.filter(p => p.y).length;
    if (nPos === 0 || nPos === pairs.length)
        return null; // 全同 label：无判定结构
    if (!Number.isFinite(currentValue))
        return null; // 现值非法：诚实下限
    // 训练点抽稀（>64 ⇒ 按 margin 稳定排序后等距取，确定性）
    let work = pairs;
    if (pairs.length > GP_TRAINING_POINT_CAP) {
        const stride = Math.ceil(pairs.length / GP_TRAINING_POINT_CAP);
        work = pairs
            .map((p, i) => ({ p, i }))
            .sort((a, b) => a.p.m - b.p.m || a.i - b.i)
            .filter((_, idx) => idx % stride === 0)
            .map(e => e.p);
    }
    const n = work.length;
    const rate = work.filter(p => p.y).length / n;
    // GP 拟合：ℓ = 跨度/4（跨度 0 的退化全同 margin ⇒ ℓ=1 兜底，后验退化但无害）
    const xs = work.map(p => p.m);
    const ys = work.map(p => (p.y ? 1 : 0));
    let lo = Infinity;
    let hi = -Infinity;
    for (const m of xs) {
        if (m < lo)
            lo = m;
        if (m > hi)
            hi = m;
    }
    const span = hi - lo;
    const gp = gpRbf1d(xs, ys, {
        lengthScale: span > 0 ? span / 4 : 1,
        priorVar: 0.25,
        noiseVar: 0.25,
        meanValue: rate,
    });
    if (!gp)
        return null; // 拟合失败（数值护栏）：诚实下限
    // 训练点上的后验（μᵢ / σᵢ）⇒ A(t) 的软标签与聚合 σ̄
    const muArr = new Array(n);
    const sigmaArr = new Array(n);
    let sigmaSqSum = 0;
    for (let i = 0; i < n; i++) {
        muArr[i] = gp.mu(xs[i]);
        sigmaArr[i] = gp.sigma(xs[i]);
        sigmaSqSum += sigmaArr[i] * sigmaArr[i];
    }
    const aggregateSigma = Math.sqrt(sigmaSqSum) / n;
    /** A(t)：候选阈 t 的 GP 平滑正确率（预测 m≥t ⇒ success，对软标签 μ 计分）。 */
    const accuracyAt = (t) => {
        let s = 0;
        for (let i = 0; i < n; i++)
            s += xs[i] >= t ? muArr[i] : 1 - muArr[i];
        return s / n;
    };
    const baseline = accuracyAt(currentValue); // 同窗同尺度的「现值水平」
    const safeFloor = baseline - GP_SAFE_EPSILON;
    // 候选网格（与 grid 学习器同构：排序相邻中点 + 两端）
    const sorted = xs.slice().sort((a, b) => a - b);
    const cands = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        const mid = (sorted[i - 1] + sorted[i]) / 2;
        if (mid > cands[cands.length - 1])
            cands.push(mid);
    }
    if (sorted[sorted.length - 1] > cands[cands.length - 1])
        cands.push(sorted[sorted.length - 1]);
    // 安全门先滤（safe-BO：采集只在安全集上取 argmax），GP-UCB 后选，平票中位数
    let bestScore = -Infinity;
    let tied = [];
    let bestAcc = Number.NaN;
    for (const t of cands) {
        const acc = accuracyAt(t);
        if (acc - GP_SAFE_SIGMA_MULTIPLIER * aggregateSigma < safeFloor - GP_TIE_EPSILON) {
            continue; // 安全约束拒绝：候选的 GP 下界劣于现值−ε
        }
        const score = acc + GP_UCB_KAPPA * gp.sigma(t);
        if (score > bestScore + GP_TIE_EPSILON) {
            bestScore = score;
            bestAcc = acc;
            tied = [t];
        }
        else if (score >= bestScore - GP_TIE_EPSILON) {
            tied.push(t);
        }
    }
    if (tied.length === 0)
        return null; // 无候选过安全门：本代不换（保守保持）
    tied.sort((a, b) => a - b);
    const mid = (tied.length - 1) / 2;
    const threshold = (tied[Math.floor(mid)] + tied[Math.ceil(mid)]) / 2; // 平票 ⇒ 中位数
    return {
        threshold,
        lowerBound: bestAcc - GP_SAFE_SIGMA_MULTIPLIER * aggregateSigma,
        baseline,
        aggregateSigma,
    };
}
/** ΝΩ-6 安全分池键集消毒：undefined ⇒ 生产缺省池；数组 / 集合取非空字符串项；垃圾回落缺省池（fail-safe）。 */
function sanitizeSafetyKeys(src) {
    if (src === undefined)
        return SAFETY_CRITICAL_KERNEL_KEYS;
    const items = Array.isArray(src) ? src : src instanceof Set ? [...src] : null;
    if (items === null)
        return SAFETY_CRITICAL_KERNEL_KEYS;
    const out = new Set();
    for (const k of items)
        if (typeof k === 'string' && k !== '')
            out.add(k);
    return out;
}
/**
 * 最优阈（纯函数，绝不抛）：在「排序 margins 的相邻中点 + 两端」候选网格上找
 * **预测正确率**最大的阈值。预测语义：margin ≥ 阈 ⇒ 预测 success（与真实 label 对账）。
 *   - 平票（多候选同达最大正确率）⇒ 取这些候选的**中位数**（偶数个取中间两数均值）
 *     —— 保守居中，不偏向任何端（参数方向不定时不押注）；
 *   - 诚实下限（致敬 calibration.ts 的 <8 律）：净化后样本 <8 ⇒ null；
 *   - 全同 label（无可学的判定结构）⇒ null；
 *   - 垃圾静默：非有限 margin / 非布尔 label 的配对剔队；两数组按短者截齐。
 */
export function optimalThreshold(margins, labels) {
    const pairs = [];
    const n = Math.min(margins?.length ?? 0, labels?.length ?? 0);
    for (let i = 0; i < n; i++) {
        const m = margins[i];
        const y = labels[i];
        if (Number.isFinite(m) && typeof y === 'boolean')
            pairs.push({ m, y });
    }
    if (pairs.length < 8)
        return null; // 诚实下限：样本不足不标定
    const nPos = pairs.filter(p => p.y).length;
    if (nPos === 0 || nPos === pairs.length)
        return null; // 全同 label：无判定结构
    // 候选网格：排序 margins 的相邻中点 + 两端（等值相邻 ⇒ 中点重合，跳过）
    const sorted = pairs.map(p => p.m).sort((a, b) => a - b);
    const cands = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        const mid = (sorted[i - 1] + sorted[i]) / 2;
        if (mid > cands[cands.length - 1])
            cands.push(mid);
    }
    if (sorted[sorted.length - 1] > cands[cands.length - 1])
        cands.push(sorted[sorted.length - 1]);
    const EPS = 1e-12; // 正确率并列判定的浮点容差（整数对账本可精确并列，此为护栏）
    let bestAcc = -1;
    let tied = [];
    for (const t of cands) {
        let correct = 0;
        for (const p of pairs)
            if ((p.m >= t) === p.y)
                correct++;
        const acc = correct / pairs.length;
        if (acc > bestAcc + EPS) {
            bestAcc = acc;
            tied = [t];
        }
        else if (acc >= bestAcc - EPS) {
            tied.push(t);
        }
    }
    tied.sort((a, b) => a - b);
    const mid = (tied.length - 1) / 2;
    return (tied[Math.floor(mid)] + tied[Math.ceil(mid)]) / 2; // 平票 ⇒ 候选中位数
}
/**
 * tick 内的标签重建（内部确定性先验）。ΑΩ-R39 起降级为**回退路径**：真逐样本
 * 标签已由 ledger.entries 直接供给（见 labeledPairs），本先验仅在记录缺 success
 * （历史档只有 stats 汇总 / 防御恢复残缺）时启用 —— 按「margin 单调有益」先验
 * 伪造标签：margin 降序，前 round(successRate × 有效样本) 个记 success。零随机；
 * 重建标签与 margin 排序完全一致 ⇒ optimalThreshold 求得的恰是历史 margin 分布的
 * successRate 分位点（语义：把参数设到「历史上恰好有 successRate 成功率」的
 * margin 水位 —— 分位标定，是申报的代用统计量而非真判别学习，故报告须标
 * labelSource='reconstructed'）。successRate=0 或 1 ⇒ 全同标签 ⇒
 * optimalThreshold 回 null（完美/全败参数皆无判定结构可学 —— 诚实不动）。
 */
function reconstructLabels(margins, successRate) {
    const order = margins.map((m, i) => ({ m, i })).sort((a, b) => b.m - a.m); // 降序
    const k = Math.max(0, Math.min(margins.length, Math.round(successRate * margins.length)));
    const labels = new Array(margins.length).fill(false);
    for (let r = 0; r < k; r++)
        labels[order[r].i] = true;
    return labels;
}
/**
 * 在线校准器：对 registry.list() 的每个参数按六律进化（⓪ 安全分池 + 见 tick 的 JSDoc）。
 * 绝不抛；一切外部故障（ledger/registry 抛异常、返回垃圾）按参数隔离、静默降级。
 */
export class KernelCalibrator {
    registry;
    ledger;
    lineage;
    guardrails;
    /** ΝΩ-6 安全分池：此集内的键 tick 跳过自动校准（缺省 = 生产 safetyCritical 键集） */
    safetyCriticalKeys;
    /** ΝΩ-33 阈学习器（缺省 'grid' —— 零回归；'gp-ucb' 见 optimalThresholdGpUcb） */
    thresholdLearner;
    now;
    _history = [];
    constructor(opts) {
        this.registry = opts?.registry ?? null;
        this.ledger = opts?.ledger ?? null;
        this.lineage = opts?.lineage ?? null;
        const o = opts?.guardrails ?? {};
        this.guardrails = {
            minEvidence: numOr(o.minEvidence, DEFAULT_GUARDRAILS.minEvidence, 0, Infinity),
            maxStepPct: numOr(o.maxStepPct, DEFAULT_GUARDRAILS.maxStepPct, 0, 1),
            rollbackDrop: numOr(o.rollbackDrop, DEFAULT_GUARDRAILS.rollbackDrop, 0, 1), // ΝΩ-6：兼容锚，判决已由后验接管
            minPostEvidence: numOr(o.minPostEvidence, DEFAULT_GUARDRAILS.minPostEvidence, 0, Infinity),
            rollbackPosteriorMass: numOr(o.rollbackPosteriorMass, DEFAULT_GUARDRAILS.rollbackPosteriorMass, 0, 1),
        };
        this.safetyCriticalKeys = sanitizeSafetyKeys(opts?.safetyCriticalKeys);
        // ΝΩ-33：仅显式 'gp-ucb' 字面量走新路径，其余一切（含垃圾注入）回落 'grid'
        //（fail-safe 旧行为侧，与 safetyKeys 的消毒同律）
        this.thresholdLearner = opts?.thresholdLearner === 'gp-ucb' ? 'gp-ucb' : 'grid';
        this.now = typeof opts?.now === 'function' ? opts.now : () => Date.now();
    }
    /**
     * 一个校准 tick（全确定性，绝不抛）。对 registry.list() 每参数依次执法六律：
     *
     *  ⓪ 安全分池（ΝΩ-6）：safetyCritical 键（缺省集 = 生产册 SAFETY_CRITICAL_
     *     KERNEL_KEYS）跳过自动校准 —— 本 tick 只立 skipped-safety-critical 报告
     *     （from == to 零副作用、不入血统），不查账不学阈不回滚。换值唯一合法
     *     通道 = gym 实验室进化 → 显式 promoteFrom（注释立法 ΝΩ-6）。
     *
     *  ① 证据门：ledger.stats(key).n < minEvidence ⇒ 跳过（证据不满不动参数）。
     *
     *  ⑤ 回归守卫（**先于变异** —— 若先变异再回滚，promote 会污染血统使回滚目标
     *     错位；回归期的参数本 tick 只回滚、不进化，防「先变异再回滚」的血统空转）：
     *     血统 ≥2 代 且 stats.n ≥ minPostEvidence 且 **Beta-Bernoulli 后验
     *     P(rate_true < 上代 fitness | 当前窗证据) ≥ rollbackPosteriorMass**
     *     （ΝΩ-6：上代 = 血统倒数第二代的 fitness；k 胜 n−k 败 + 均匀先验 ⇒
     *     Beta(k+1, n−k+1) 的闭式下尾质量，无采样）⇒ 回滚到血统倒数第二代值；
     *     证据不足（n < minPostEvidence）维持旧行为：不判回归（保守兜底）；
     *     已回滚到位（目标 == 现值）⇒ 静默空转（不刷屏报告、不再变异）。
     *     回滚 Report 的 reason 注明 regression-rollback + 后验质量。
     *
     *  ② 候选阈（ΑΩ-R39 真标签优先）：stats.margins 非空 ⇒ 优先取 ledger.entries
     *     的逐记录 (margin, success) 真标签直入阈学习（真判别学习）；
     *     记录缺 success / ledger 无逐记录口径（历史档 / 防御恢复残缺）⇒ 回退
     *     reconstructLabels 重建先验（分位标定）；所用标签源在报告 labelSource
     *     如实申报（'records' | 'reconstructed'）。阈为 null（样本不足 / 全同标签 /
     *     全同 margin / ΝΩ-33 gp-ucb 安全约束拒绝）或不在 [min, max] 内 ⇒
     *     本 tick 不动（诚实下限，不硬拉）。阈学习器 = thresholdLearner（缺省
     *     grid 旧行为；'gp-ucb' = GP-UCB + safe 约束，见 optimalThresholdGpUcb）。
     *
     *  ③ 步长上限：|候选 − 现值| > maxStepPct × (max − min) ⇒ 沿方向截到上限。
     *     截点介于现值与候选之间 ⇒ 天然在界内（再夹一次 [min,max] 纯为数值护栏）；
     *     截后原地（目标 == 现值）⇒ 无换血。
     *
     *  ④ 换血：变更前 lineage.record 现代快照（fitness = 当前 successRate —— 只记
     *     观测事实，不引入探索奖励 / 随机）；registry.set 成功 ⇒ lineage.promote
     *     （fitness = 变更时 successRate）+ CalibrationReport 入史并随 tick 返回；
     *     set 被拒 ⇒ 静默放弃（血统快照无害留存，不立报告、不 promote）。
     *     report.generation = promote 后的血统世代（无 lineage ⇒ registry 现行世代）。
     *
     * 返回本 tick 的全部报告（同时累积进 history()）。
     */
    tick() {
        const reports = [];
        let params;
        try {
            if (!this.registry || !this.ledger)
                return reports; // 器官缺位：诚实空转
            params = this.registry.list() ?? [];
        }
        catch {
            return reports; // registry 故障：静默降级
        }
        for (const p of params) {
            if (!p || typeof p.key !== 'string' || !Number.isFinite(p.value))
                continue; // 垃圾条目跳过
            try {
                const r = this.calibrateOne(p);
                if (r)
                    reports.push(r);
            }
            catch {
                /* 单参数故障隔离：绝不抛 */
            }
        }
        return reports;
    }
    /** 单参数执法（⓪→①→⑤→②→③→④，见 tick JSDoc 的次序论证）。 */
    calibrateOne(p) {
        const registry = this.registry;
        const ledger = this.ledger;
        if (!registry || !ledger)
            return null;
        // ⓪ 安全分池（ΝΩ-6）：safetyCritical 键不参与自动校准 —— 其安全语义的结构
        // 前提（如 uncertainty.highProceed 0.85 > 校准值域上限 0.8 的「高危无免检
        // 直通道」）可能被在线阈学习静默放宽。只立如实标注的报告（from == to 零
        // 副作用），不查账、不学阈、不回滚、不入血统。
        if (this.safetyCriticalKeys.has(p.key)) {
            const skipped = {
                key: p.key,
                from: p.value,
                to: p.value,
                reason: 'skipped-safety-critical: ΝΩ-6 safety pool — auto-calibration fenced, value moves only via explicit gym promoteFrom',
                generation: p.generation,
            };
            this._history.push(skipped);
            return skipped;
        }
        const g = this.guardrails;
        let stats;
        try {
            stats = ledger.stats(p.key);
        }
        catch {
            return null; // ledger 故障：本参数静默跳过
        }
        if (!stats || !Number.isFinite(stats.n) || stats.n < g.minEvidence)
            return null; // ① 证据门
        const rate = Number.isFinite(stats.successRate) ? stats.successRate : 0;
        // ⑤ 回归守卫（先于变异 —— 见 tick JSDoc）
        const rg = this.regressionGate(p, rate, stats.n);
        if (rg.regressed)
            return rg.report;
        // ② 候选阈（ΑΩ-R39 真标签优先：records 直学，缺 success 才回退重建先验；
        //    ΝΩ-33 学习器分流：grid（缺省，旧行为）| gp-ucb（GP-UCB + safe 约束，
        //    安全门拒绝 ⇒ null 本代不换 —— 保守保持；一切下游护栏两路同一执法））
        const margins = Array.isArray(stats.margins)
            ? stats.margins.filter((m) => Number.isFinite(m))
            : [];
        if (margins.length === 0)
            return null;
        const labeled = this.labeledPairs(p.key);
        const labelSource = labeled ? 'records' : 'reconstructed';
        const learnerMargins = labeled ? labeled.margins : margins;
        const learnerLabels = labeled ? labeled.labels : reconstructLabels(margins, rate);
        let threshold = null;
        let gpAudit = '';
        if (this.thresholdLearner === 'gp-ucb') {
            const gp = optimalThresholdGpUcb(learnerMargins, learnerLabels, p.value);
            if (gp) {
                threshold = gp.threshold;
                gpAudit = ` lb=${fmt(gp.lowerBound)} base=${fmt(gp.baseline)}`;
            }
        }
        else {
            threshold = optimalThreshold(learnerMargins, learnerLabels);
        }
        if (threshold === null)
            return null; // 诚实下限：无可学的判定结构 / 安全约束拒绝（保守保持）
        if (threshold < p.min || threshold > p.max)
            return null; // 越界候选：不动（不硬拉）
        // ③ 步长上限（沿方向截断）
        const limit = Math.max(0, g.maxStepPct * (p.max - p.min));
        let target = threshold;
        let stepCapped = false;
        if (Math.abs(threshold - p.value) > limit) {
            target = p.value + (threshold > p.value ? limit : -limit);
            stepCapped = true;
        }
        target = Math.min(p.max, Math.max(p.min, target)); // 数值护栏（截点本应在界内）
        if (target === p.value)
            return null; // 截后原地：无换血
        // ④ 换血：现代快照 → set → 新世代
        if (this.lineage) {
            this.lineage.record({
                key: p.key,
                generation: p.generation,
                value: p.value,
                fitness: rate,
                createdAt: this.now(),
            });
        }
        let res;
        try {
            res = registry.set(p.key, target);
        }
        catch {
            return null; // set 故障：静默放弃
        }
        if (!res || res.ok !== true)
            return null; // registry 拒绝：静默放弃
        const applied = typeof res.clampedTo === 'number' && Number.isFinite(res.clampedTo)
            ? res.clampedTo
            : target;
        let generation = p.generation;
        if (this.lineage) {
            generation = this.lineage.promote(p.key, applied, rate, this.now()).generation;
        }
        const report = {
            key: p.key,
            from: p.value,
            to: applied,
            reason: `optimal-threshold${this.thresholdLearner === 'gp-ucb' ? '[gp-ucb]' : ''} t=${fmt(threshold)} n=${fmt(stats.n)} labels=${labelSource}${gpAudit}${stepCapped ? ' step-capped' : ''}`,
            labelSource,
            generation,
        };
        this._history.push(report);
        return report;
    }
    /**
     * ΑΩ-R39 真标签抽取（records 路径）：从 ledger.entries(key) 取逐记录
     * (margin, success) 对 —— EvidenceLedger 每条记录本就存成败与裕量，真逐样本
     * 标签现成在手，重建先验根本不必用。返回 null（调用方回退 reconstructLabels
     * 重建先验并标 labelSource='reconstructed'）当且仅当：
     *   - 注入的 ledger 无 entries 方法 / 返回非数组（历史档：只有 stats 汇总的旧账）；
     *   - entries 抛异常（防御恢复残缺 —— 静默回退，绝不抛）；
     *   - 任一记录残缺（非对象 / 带 margin 而缺布尔 success）：真标签不完整 ⇒ 整键
     *     回退，不把真标签与伪造标签混同一窗；
     *   - 无任何带有限 margin 的记录（与 stats 口径无法对账的退化账）。
     * 无 margin 的记录不进阈学习（与 stats().margins 同口径）；ts 不参与学习。
     */
    labeledPairs(key) {
        try {
            const ledger = this.ledger;
            if (!ledger || typeof ledger.entries !== 'function')
                return null;
            const list = ledger.entries(key);
            if (!Array.isArray(list))
                return null;
            const margins = [];
            const labels = [];
            for (const e of list) {
                if (!e || typeof e !== 'object')
                    return null; // 残缺记录：整键回退
                const m = e.margin;
                if (typeof m !== 'number' || !Number.isFinite(m))
                    continue; // 无 margin 记录：不进阈学习（与 stats 同口径）
                if (typeof e.success !== 'boolean')
                    return null; // 缺 success：真标签不完整 ⇒ 回退
                margins.push(m);
                labels.push(e.success);
            }
            return margins.length > 0 ? { margins, labels } : null;
        }
        catch {
            return null; // ledger 故障：静默回退（绝不抛）
        }
    }
    /**
     * ⑤ 回归守卫（判定 + 执行，见 tick JSDoc）：上代 = 血统倒数第二代。
     * regressed=true 表示本 tick 该参数已按回归处置（回滚报告或已回滚到位的静默）——
     * 调用方须短路变异路径。回滚目标 = 上代值；无二代血统不在此径（走 defaultValue
     * 是 rollback() 公开方法的职责）。
     *
     * ΝΩ-6 判决：频率派容忍带（rate < 上代 fitness − rollbackDrop）退役 —— n=20 时
     * 二项 1σ≈0.10，噪声波动即可越过 0.05 容忍带（中段 p 处同质两窗的假回滚率可达
     * ~25%），参数代际振荡回滚、血统账被噪声填满。改判 Beta-Bernoulli 后验：
     * 当前窗 k 胜 n−k 败 + 均匀先验 ⇒ rate_true ~ Beta(k+1, n−k+1)，其闭式下尾质量
     * P(rate_true < 上代 fitness) ≥ rollbackPosteriorMass（缺省 0.9）才回滚 —— 噪声
     * 与真退化不可分时（后验不足）不回滚，证据不足（n < minPostEvidence）维持旧行为。
     */
    regressionGate(p, rate, n) {
        const g = this.guardrails;
        const none = { regressed: false, report: null };
        if (!this.lineage || !this.registry)
            return none;
        if (!(n >= g.minPostEvidence))
            return none; // 保守兜底（ΝΩ-6）：证据不足维持现行为——不判回归
        const gens = this.lineage.generations(p.key);
        if (gens.length < 2)
            return none; // 无上代可比
        const prev = gens[gens.length - 2];
        if (!Number.isFinite(prev.fitness))
            return none;
        // 后验判决：rate*n 即窗内成功数（stats.successRate = succ/n 的精确还原；
        // 浮点残差由 round 吸收，越界由 clamp 收口）
        const k = Math.min(n, Math.max(0, Math.round(rate * n)));
        const mass = regressionPosteriorMass(k, n, prev.fitness);
        if (!(mass >= g.rollbackPosteriorMass))
            return none; // 后验不足：噪声与真退化不可分 ⇒ 不回滚
        // 回归成立：本 tick 只回滚（或已回滚到位则静默），不再变异
        const target = Number.isFinite(prev.value) ? prev.value : p.defaultValue;
        if (target === p.value)
            return { regressed: true, report: null };
        let res;
        try {
            res = this.registry.set(p.key, target);
        }
        catch {
            return { regressed: true, report: null };
        }
        if (!res || res.ok !== true)
            return { regressed: true, report: null };
        const applied = typeof res.clampedTo === 'number' && Number.isFinite(res.clampedTo)
            ? res.clampedTo
            : target;
        const report = {
            key: p.key,
            from: p.value,
            to: applied,
            reason: `regression-rollback: posterior P(rate<prevGenFitness)=${fmt(mass)} >= ${fmt(g.rollbackPosteriorMass)} @n=${fmt(n)} k=${fmt(k)} prevFitness=${fmt(prev.fitness)}`,
            generation: prev.generation,
        };
        this._history.push(report);
        return { regressed: true, report };
    }
    /**
     * 手动回滚：回到血统倒数第二代值；**无二代血统 ⇒ 回 defaultValue**（出厂锚点）。
     * 已在目标位 / key 未注册 / set 被拒 ⇒ false（零副作用）。不立历史报告
     * （history 只记 tick 的执法痕迹）、不动血统（血统是审计事实，不因回滚重写）。
     */
    rollback(key) {
        try {
            if (!this.registry || typeof key !== 'string' || key === '')
                return false;
            const params = this.registry.list() ?? [];
            const p = params.find(x => x && x.key === key);
            if (!p || !Number.isFinite(p.value))
                return false;
            const gens = this.lineage ? this.lineage.generations(key) : [];
            const prev = gens.length >= 2 ? gens[gens.length - 2] : undefined;
            const target = prev !== undefined && Number.isFinite(prev.value) ? prev.value : p.defaultValue;
            if (!Number.isFinite(target) || target === p.value)
                return false;
            const res = this.registry.set(key, target);
            return !!res && res.ok === true;
        }
        catch {
            return false; // 绝不抛
        }
    }
    /** 校准史（tick 累积的报告）：防御副本 —— 改返回值不穿透内部账目。 */
    history() {
        return this._history.slice();
    }
    /** 清空校准史（只清本类账目；registry / ledger / lineage 是注入器官，不处置）。 */
    reset() {
        this._history.length = 0;
    }
}
