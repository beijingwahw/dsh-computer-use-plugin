// src/telemetry.ts
// 第七轮创新之一：零依赖指标引擎（可观测性支柱）。
// 世界级系统的共识：没有度量就没有优化 —— 你无法改进你看不见的东西。
// 三层指标，全部本地实时、零外部依赖：
//   1. 工具层：per-tool 调用数 / 成败 / 疑似无效(noop) / 延迟分位数（环形缓冲精确 P50/P95/P99）
//   2. 命中层：UI 记忆命中、技能命中、失败记忆命中（记忆系统的投资回报率）
//   3. 汇总层：全局成功率、noop 率、最慢工具 —— 一眼定位系统瓶颈
// 接线：guards 的 post-execute 观察位纯旁路记录；暴露 get_metrics 工具给模型自省
// （模型能看到「我最近 20% 的点击疑似无效」并主动换策略 —— 自观测的 Agent）。
const LATENCY_RING = 512; // 每工具延迟样本环形缓冲；世界级标准：精确分位而非桶近似
// ─── G-2/G-6（第七维·过程感知）：CUSUM 变点 + Hurst 指数 ───
/** 失败指示环容量（64 次最近结局 —— CUSUM/Hurst 的观测窗） */
const OUTCOME_RING = 64;
/**
 * G-2 CUSUM（Page 1954 序贯变点检验）：检测失败率的**最近突变**（regime shift），
 * 与终身平均速率互补 ——「这工具最近开始失灵了」与「这工具从来不好」是两种
 * 完全不同的诊断（前者提示环境变了，后者提示路线错了）。
 * 单边（失败率上升）标准形式：Sₜ = max(0, Sₜ₋₁ + xₜ − (p₀ + k))，Sₜ ≥ h ⇒ 告警。
 * 纯函数导出：统计原子的测试面。
 */
export function cusumAlarm(failures, // 1=失败 0=成功 的指示流（时间序）
p0, // 基线失败率（原假设）
k = 0.1, // 容忍带（slack）：小于此的漂移不告警（防噪声）
h = 2.5) {
    let s = 0;
    for (let i = 0; i < failures.length; i++) {
        s = Math.max(0, s + failures[i] - (p0 + k));
        if (s >= h)
            return { sum: s, alarmIndex: i };
    }
    return { sum: s, alarmIndex: null };
}
/**
 * G-6 Hurst 指数（R/S 重标度极差法）：结局流的长程依赖度量。
 *   H > 0.5 持续性（regime 聚集 —— 失败扎堆一段一段地来：一次失败后，短期内
 *   下一次更可能失败）；H ≈ 0.5 独立（无记忆）；H < 0.5 反持续（均值回复）。
 * 消费价值：H > 0.6 时「失败后立即重试」是最差策略（聚集性），应直接换模态。
 * 与 F-4 的分工：LZ76 熵率管「周期性」（卡死签名），Hurst 管「聚集性」——
 * R/S 对周期序列给 H→0（经典结论），两把尺子量两种病，互不越界。
 * 多尺度 log(R/S)–log(n) 的 OLS 斜率；n<16 或尺度不足 ⇒ null（统计诚实下限）。
 * 纯函数导出：统计原子的测试面。
 */
export function hurstExponent(x) {
    const n = x.length;
    if (n < 16)
        return null;
    // 倍增尺度：w = 8, 16, 32, … ≤ n（每尺度计算窗口平均 R/S）
    const scales = [];
    for (let w = 8; w <= n; w *= 2)
        scales.push(w);
    const points = [];
    for (const w of scales) {
        const m = Math.floor(n / w);
        if (m < 1)
            break;
        let rsAcc = 0, cnt = 0;
        for (let i = 0; i < m; i++) {
            const seg = x.slice(i * w, (i + 1) * w);
            const mu = seg.reduce((a, b) => a + b, 0) / w;
            let cum = 0, min = Infinity, max = -Infinity;
            for (const v of seg) {
                cum += v - mu;
                if (cum < min)
                    min = cum;
                if (cum > max)
                    max = cum;
            }
            const R = max - min;
            const S = Math.sqrt(seg.reduce((a, v) => a + (v - mu) ** 2, 0) / w);
            if (S > 1e-12 && R > 0) {
                rsAcc += R / S;
                cnt++;
            }
        }
        if (cnt > 0)
            points.push([Math.log(w), Math.log(rsAcc / cnt)]);
    }
    if (points.length < 2)
        return null;
    // OLS 斜率 = H
    const mx = points.reduce((a, p) => a + p[0], 0) / points.length;
    const my = points.reduce((a, p) => a + p[1], 0) / points.length;
    let num = 0, den = 0;
    for (const [px, py] of points) {
        num += (px - mx) * (py - my);
        den += (px - mx) ** 2;
    }
    if (den < 1e-12)
        return null;
    const H = num / den;
    return Number.isFinite(H) ? Math.round(H * 1000) / 1000 : null;
}
/** 环形缓冲分位数：线性插入 O(1)，快照时一次性排序（读取频率远低于写入） */
function percentile(sorted, p) {
    if (sorted.length === 0)
        return 0;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
}
/** 最小尾样本数（矩估计的诚实下限：不足则拒绝拟合而非伪装） */
const GPD_MIN_TAIL = 20;
/**
 * 广义帕累托尾拟合（Peaks-over-Threshold + 方法矩）：超阈值渐进服从 GPD
 * （Pickands–Balkema–de Haan 定理）—— 分布无关的极值数学。矩方程闭式解：
 * 超额均值 e = σ/(1−ξ)、方差 v = σ²/((1−ξ)²(1−2ξ))（ξ<½）⇒
 * ξ = (k−1)/(2k−1)，k = v/e²。诚实边界：ξ ≥ ½（无穷方差域）时矩法失效 ⇒
 * 返回 null（拒绝拟合优于谎言拟合 —— 与 makeScore 域外拒绝同律）。
 * 纯函数导出：统计原子的测试面（与 betaReliability 同律）。
 */
export function fitGpdTail(samples) {
    if (samples.length < GPD_MIN_TAIL * 2)
        return null; // 90 分位阈值至少要 20 个超额
    //（J 纪元注记：40 样本入口门槛是**必要非充分** —— 实际约需 200+ 池化样本
    //  才可能凑出 20 个尾超额；早期返回 null 是诚实降级，不是拟合失败）
    const sorted = [...samples].sort((a, b) => a - b);
    const n = sorted.length;
    const u = sorted[Math.floor(n * 0.9)];
    const excess = sorted.filter(s => s > u).map(s => s - u);
    const m = excess.length;
    if (m < GPD_MIN_TAIL)
        return null;
    const e = excess.reduce((s, x) => s + x, 0) / m;
    const v = excess.reduce((s, x) => s + (x - e) ** 2, 0) / m;
    if (e <= 0)
        return null;
    const k = v / (e * e);
    // k=1 ⇔ ξ=0（指数尾）；k>1 ⇔ ξ>0（重尾）；k∈(0.5,1) ⇔ ξ<0（有界尾）
    const denom = 2 * k - 1;
    if (Math.abs(denom) < 1e-9 || k <= 0.5)
        return null; // ξ→±∞ / 病态：拒绝
    const xi = (k - 1) / denom;
    if (xi >= 0.5 || xi <= -1)
        return null; // 矩法有效域外（无穷方差 / 退化）
    const sigma = e * (1 - xi);
    // 0.999 分位外推：P(X>x) = p_t·(1+y/σ)^{-1/ξ} 反解（p_t = 尾占比）
    const pTail = m / n;
    const q = 0.001 / pTail; // 目标超越概率在尾分布内的分位
    if (q <= 0 || q >= 1)
        return null;
    const p999 = u + (sigma / xi) * (Math.pow(q, -xi) - 1);
    if (!Number.isFinite(p999))
        return null;
    return {
        xi: Math.round(xi * 1000) / 1000,
        sigma: Math.round(sigma * 10) / 10,
        threshold: u,
        tailCount: m,
        p999: Math.round(p999),
    };
}
export class Telemetry {
    // I 纪元注记：静态纯函数（法医/证书/裁决原子）经类暴露 —— 与实例状态无耦合，
    // 调用方（observabilityTools）可独立引用；实例语义全部保持非静态。
    tools = new Map();
    counters = new Map();
    startedAt = Date.now();
    enabled = true;
    configure(enabled) {
        this.enabled = enabled;
    }
    slot(tool) {
        let s = this.tools.get(tool);
        if (!s) {
            s = { calls: 0, successes: 0, failures: 0, noops: 0, totalMs: 0, latencies: [], outcomeRing: [] };
            this.tools.set(tool, s);
        }
        return s;
    }
    /**
     * 工具调用观测（guards post-execute 挂载点调用）。
     * status 语义与 journal/熔断共享同一字符串契约：SUCCESS / FAILED / UNKNOWN。
     */
    observe(tool, status, ms, noop = false) {
        if (!this.enabled)
            return;
        const s = this.slot(tool);
        s.calls++;
        s.totalMs += ms;
        if (status === 'SUCCESS')
            s.successes++;
        else if (status === 'FAILED')
            s.failures++;
        // noop 语义自我一致：只统计「报成功但无效果」—— 失败已单独计数，避免双重惩罚
        if (noop && status === 'SUCCESS')
            s.noops++;
        s.latencies.push(Math.round(ms));
        if (s.latencies.length > LATENCY_RING)
            s.latencies.shift();
        // G-2：失败指示入环（UNKNOWN 不入 —— 观测流只收确定结局，防稀释变点信号）
        if (status === 'SUCCESS' || status === 'FAILED') {
            s.outcomeRing.push(status === 'FAILED' ? 1 : 0);
            if (s.outcomeRing.length > OUTCOME_RING)
                s.outcomeRing.shift();
        }
    }
    /**
     * G-2 变点扫描：逐工具 CUSUM。p₀ = **历史半窗基线**（结局环前半的失败率 ——
     * 不含近期，防基线被突变自身污染），k=0.1 容忍带，h=2.5 决策阈，全环扫描。
     * 返回近期失败率突变（regime shift）的工具清单 —— 消费方：get_metrics 洞见。
     * 诚实下限：结局环 <8 个样本不判；全程皆败不判（那是终身问题，不是变点 ——
     * CUSUM 的职责是「变了」，不是「一直坏」）。
     */
    regimeShifts() {
        const out = [];
        for (const [name, s] of this.tools) {
            const ring = s.outcomeRing;
            if (ring.length < 8)
                continue;
            // 历史半窗基线：环前半（最旧的观测）—— 突变前世界的诚实锚点
            const half = Math.max(1, Math.floor(ring.length / 2));
            const p0 = ring.slice(0, half).reduce((a, b) => a + b, 0) / half;
            const { sum, alarmIndex } = cusumAlarm(ring, p0);
            if (alarmIndex !== null) {
                out.push({ tool: name, cusum: Math.round(sum * 100) / 100, baselineFailureRate: Math.round(p0 * 1000) / 1000 });
            }
        }
        return out;
    }
    /**
     * G-6 全局结局流 Hurst 指数：跨工具合并的成败指示流（时间序近似 —— 各工具环
     * 按工具内时序拼接，聚集性检测对拼接次序不敏感）。样本 <16 ⇒ null。
     */
    hurst() {
        const pooled = [];
        for (const s of this.tools.values())
            pooled.push(...s.outcomeRing);
        return hurstExponent(pooled);
    }
    // ─── H-3 Thompson 采样模态仲裁（创世纪）：后验抽样代替贪心 ───
    /**
     * Beta(α,β) 一次抽样（Marsaglia–Tsang 2000 压缩正态法 + α<1 的 Boost 提升）。
     * 随机源注入（uniform ∈ [0,1)）—— 测试可播种，生产用 Math.random。
     * 永不抛错：退化输入（α 或 β ≤0）返回均值 0.5（诚实降级）。
     */
    sampleBeta(alpha, beta, uniform) {
        if (!(alpha > 0) || !(beta > 0))
            return 0.5;
        const gamma = (shape) => {
            // Marsaglia–Tsang：shape ≥ 1 走压缩法；<1 用 Boost(u^{1/shape}) 提升后折返
            const boost = shape < 1 ? Math.pow(Math.max(1e-12, uniform()), 1 / shape) : 1;
            const a = shape < 1 ? shape + 1 : shape;
            const d = a - 1 / 3;
            const c = 1 / Math.sqrt(9 * d);
            for (;;) {
                // Box–Muller 正态（u>1e-12 防 log(0)）
                const u1 = Math.max(1e-12, uniform());
                const u2 = Math.max(1e-12, uniform());
                const n = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
                const v = 1 + c * n;
                if (v <= 0)
                    continue;
                const vv = v * v * v;
                const u3 = Math.max(1e-12, uniform());
                if (Math.log(u3) < 0.5 * n * n + d * (1 - vv + Math.log(vv)))
                    return d * vv * boost;
            }
        };
        const x = gamma(alpha);
        const y = gamma(beta);
        const sum = x + y;
        return sum > 0 ? x / sum : 0.5;
    }
    /**
     * H-3 模态仲裁：对每个工具的 Beta(s+1, f+1) 后验做 Thompson 抽样，返回本轮
     * 的推荐模态（采样值最高者）。哲学：贪心（选后验均值最高）会锁死探索 ——
     * 「从未试过的模态」永远没有证据；Thompson 采样以与后验置信度成比例的概率
     * 探索次优选项 —— 失败扎堆时自然多样化（与 G-6 Hurst 洞见联动）。
     * 候选门槛：calls ≥ minCalls（3 —— 至少被用过才有后验可说）。
     */
    suggestModality(minCalls = 3, uniform = Math.random) {
        const candidates = [];
        for (const [name, st] of this.tools) {
            if (st.calls < minCalls)
                continue;
            candidates.push({ tool: name, s: st.successes, f: st.failures });
        }
        if (candidates.length === 0)
            return null;
        let best = null;
        for (const c of candidates) {
            const sampled = this.sampleBeta(c.s + 1, c.f + 1, uniform);
            const posteriorMean = (c.s + 1) / (c.s + c.f + 2);
            if (!best || sampled > best.sampled) {
                best = { tool: c.tool, sampled: Math.round(sampled * 1000) / 1000, posteriorMean: Math.round(posteriorMean * 1000) / 1000 };
            }
        }
        return best ? { ...best, candidates: candidates.length } : null;
    }
    // ─── I-2 Anderson-Darling GPD 拟合优度：对估计器自身的法医鉴定 ───
    /**
     * GPD 的 Anderson-Darling A² 统计量（Choulakian & Stephens 2001 的工程形态）：
     * 尾部拟合的拟合优度 —— E/F 轮给了点估计（F-2 矩法），本节给点估计的**可信度**。
     * A² = −n − (1/n)Σ(2i−1)[ln z(i) + ln(1−z(n+1−i))]，z = GPD CDF 在超额上的值。
     * 完美拟合 ⇒ z ~ 均匀 ⇒ A² 小；污染/误设 ⇒ A² 大。阈值 3.0（估算参数下 1% 水平
     * 的量级，算法形状字面量）⇒ fit:'poor'。纯函数导出：法医原子的测试面。
     */
    static andersonDarlingGpd(excessSorted, xi, sigma) {
        const n = excessSorted.length;
        if (n < 5 || sigma <= 0)
            return Infinity; // 样本不足/病态 ⇒ 拒绝（A²=∞ 即最差）
        // CDF 与 fitGpdTail 的矩法同一参数化：F(y) = 1 − (1+ξy/σ)^(−1/ξ)
        //（ξ>0 无界重尾 —— 与 gpdExcess 采样器（epochF/H 测试）逐字节一致）
        const cdf = (y) => {
            if (Math.abs(xi) < 1e-9)
                return 1 - Math.exp(-y / sigma);
            const t = Math.max(1e-12, 1 + (xi * y) / sigma);
            return 1 - Math.pow(t, -1 / xi);
        };
        let s = 0;
        for (let i = 1; i <= n; i++) {
            const zi = Math.min(1 - 1e-12, Math.max(1e-12, cdf(excessSorted[i - 1])));
            const zn = Math.min(1 - 1e-12, Math.max(1e-12, cdf(excessSorted[n - i])));
            s += (2 * i - 1) * (Math.log(zi) + Math.log(1 - zn));
        }
        const a2 = -n - s / n;
        return Number.isFinite(a2) ? Math.round(a2 * 100) / 100 : Infinity;
    }
    /**
     * F-2 tailReport 的 I-2 升级：附 A² 拟合优度与 fit 判定 —— 估计器的自我怀疑。
     * fit:'poor' 时 ξ/p999 不可信（洞见层如实警告）。
     */
    tailReport() {
        if (!this.enabled)
            return null;
        // 全环池化（环形缓冲 512 上限即预算 —— 不做二次切片截尾）
        const pooled = [];
        for (const s of this.tools.values())
            pooled.push(...s.latencies);
        const fit = fitGpdTail(pooled);
        if (!fit)
            return null;
        // A² 在超额上计算（阈值 u 以上、升序）
        const sorted = [...pooled].sort((a, b) => a - b);
        const u = fit.threshold;
        const excess = sorted.filter(s => s > u).map(s => s - u);
        const adStat = Telemetry.andersonDarlingGpd(excess, fit.xi, fit.sigma);
        return { ...fit, adStat, fit: adStat > 3.0 ? 'poor' : 'ok' };
    }
    // ─── I-5 精确置换检验：两模态成功差的显著性证书 ───
    /**
     * 两比例差的置换检验（Fisher 精确思想的现代化身）：H0 = 两工具成败同分布。
     * 组合数 ≤ 枚举上限 ⇒ **全枚举精确 p 值**（小样本的正道 —— 无渐近假设）；
     * 否则播种 Monte Carlo（uniform 注入 ⇒ 确定性）。统计量 = 比例差；
     * 双侧 p = P(|置换差| ≥ |观测差|)（+1 校正）。纯静态：统计原子的测试面。
     */
    static permutationTest2Prop(sA, nA, sB, nB, enumLimit = 20000, mcPerms = 4000, uniform = Math.random) {
        if (nA < 2 || nB < 2)
            return null;
        const observedDiff = sA / nA - sB / nB;
        const n = nA + nB, successes = sA + sB;
        // 组合数 C(n, nA) 上界估计（对数域防溢出）
        const logC = (() => {
            let acc = 0;
            for (let i = 0; i < nA; i++)
                acc += Math.log(n - i) - Math.log(i + 1);
            return acc;
        })();
        if (Math.exp(logC) <= enumLimit) {
            // 全枚举：从 n 个位置选 nA 个作 A 组 —— 组合字典序迭代（确定性）
            const idx = Array.from({ length: nA }, (_, i) => i);
            let count = 0, total = 0;
            for (;;) {
                total++;
                let sumA = 0;
                // 前 successes 个位置视为成功标记（WLOG —— 可交换性）
                for (const p of idx)
                    if (p < successes)
                        sumA++;
                const d = sumA / nA - (successes - sumA) / nB;
                if (Math.abs(d) >= Math.abs(observedDiff) - 1e-12)
                    count++;
                // 字典序下一组合
                let i = nA - 1;
                while (i >= 0 && idx[i] === n - nA + i)
                    i--;
                if (i < 0)
                    break;
                idx[i]++;
                for (let j = i + 1; j < nA; j++)
                    idx[j] = idx[j - 1] + 1;
            }
            return { pValue: count / total, mode: 'exact', observedDiff: Math.round(observedDiff * 1000) / 1000 };
        }
        // Monte Carlo（播种确定性）
        let count = 0;
        const pool = Array.from({ length: n }, (_, i) => (i < successes ? 1 : 0));
        for (let t = 0; t < mcPerms; t++) {
            // Fisher-Yates 洗牌（注入随机源）
            for (let i = n - 1; i > 0; i--) {
                const j = Math.floor(uniform() * (i + 1));
                [pool[i], pool[j]] = [pool[j], pool[i]];
            }
            const sumA = pool.slice(0, nA).reduce((a, b) => a + b, 0);
            const d = sumA / nA - (successes - sumA) / nB;
            if (Math.abs(d) >= Math.abs(observedDiff) - 1e-12)
                count++;
        }
        return { pValue: Math.round(((count + 1) / (mcPerms + 1)) * 10000) / 10000, mode: 'monte-carlo', observedDiff: Math.round(observedDiff * 1000) / 1000 };
    }
    // ─── I-6 一阶随机占优：延迟的裁决 ───
    /**
     * 一阶随机占优（FSD，延迟语义 —— 越小越好）：A 占优 B ⇔ ∀x: F_A(x) ≥ F_B(x)
     * 且至少一处严格大 —— A 在每个阈值下都积累了更多概率质量（每个分位都不晚于 B）。
     * 决策论的全序裁决：无需聚合即可言「快」。交叉分布 ⇒ 'none'（任何单一
     * 「更快」断言都是谎言）。静态纯函数：裁决原子的测试面。
     */
    static firstOrderStochasticDominance(samplesA, samplesB) {
        if (samplesA.length === 0 || samplesB.length === 0)
            return 'none';
        const pts = [...new Set([...samplesA, ...samplesB])].sort((x, y) => x - y);
        const cdf = (s, x) => s.filter(v => v <= x).length / s.length;
        let aDominates = true, bDominates = true, strictSomewhere = false;
        for (const x of pts) {
            const fa = cdf(samplesA, x), fb = cdf(samplesB, x);
            // 越小越好：A 占优 ⇔ A 的 CDF 处处不低于 B（A 在低值区质量更重）
            if (fa < fb - 1e-12)
                aDominates = false;
            if (fb < fa - 1e-12)
                bDominates = false;
            if (Math.abs(fa - fb) > 1e-12)
                strictSomewhere = true;
            if (!aDominates && !bDominates)
                return 'none';
        }
        if (strictSomewhere && aDominates)
            return 'A';
        if (strictSomewhere && bDominates)
            return 'B';
        return 'none'; // 完全相同分布：无占优（无谎言的平局）
    }
    /** I-6 消费面：逐工具延迟对的占优扫描（≥8 样本才参战 —— 小样本 CDF 无分辨力） */
    latencyDominancePairs(minSamples = 8) {
        const cands = [];
        for (const [name, s] of this.tools) {
            if (s.latencies.length >= minSamples)
                cands.push({ tool: name, lat: s.latencies });
        }
        const out = [];
        for (let i = 0; i < cands.length; i++) {
            for (let j = i + 1; j < cands.length; j++) {
                const dom = Telemetry.firstOrderStochasticDominance(cands[i].lat, cands[j].lat);
                if (dom === 'A')
                    out.push({ faster: cands[i].tool, slower: cands[j].tool });
                else if (dom === 'B')
                    out.push({ faster: cands[j].tool, slower: cands[i].tool });
            }
        }
        return out;
    }
    /** 命中率计数（记忆系统投资回报）：hit=true 命中 / false 未命中 */
    note(counter, hit) {
        if (!this.enabled)
            return;
        let c = this.counters.get(counter);
        if (!c) {
            c = { hits: 0, misses: 0 };
            this.counters.set(counter, c);
        }
        hit ? c.hits++ : c.misses++;
    }
    /** 结构化快照：机器可读（checkpoint / 上报） */
    snapshot() {
        const tools = [...this.tools.entries()].map(([name, s]) => {
            const sorted = [...s.latencies].sort((a, b) => a - b);
            return {
                tool: name,
                calls: s.calls,
                success_rate: s.calls ? Math.round((s.successes / s.calls) * 1000) / 10 : null,
                noop_rate: s.calls ? Math.round((s.noops / s.calls) * 1000) / 10 : null,
                avg_ms: s.calls ? Math.round(s.totalMs / s.calls) : null,
                p50_ms: percentile(sorted, 50),
                p95_ms: percentile(sorted, 95),
                p99_ms: percentile(sorted, 99),
            };
        }).sort((a, b) => b.calls - a.calls);
        const counters = [...this.counters.entries()].map(([name, c]) => {
            const total = c.hits + c.misses;
            return { counter: name, hits: c.hits, misses: c.misses, hit_rate: total ? Math.round((c.hits / total) * 1000) / 10 : null };
        });
        const calls = [...this.tools.values()].reduce((n, s) => n + s.calls, 0);
        const successes = [...this.tools.values()].reduce((n, s) => n + s.successes, 0);
        const failures = [...this.tools.values()].reduce((n, s) => n + s.failures, 0);
        const noops = [...this.tools.values()].reduce((n, s) => n + s.noops, 0);
        return {
            uptime_sec: Math.round((Date.now() - this.startedAt) / 1000),
            global: {
                calls, successes, failures, noops,
                success_rate: calls ? Math.round((successes / calls) * 1000) / 10 : null,
                noop_rate: calls ? Math.round((noops / calls) * 1000) / 10 : null,
            },
            tools,
            counters,
        };
    }
    /** 人类可读渲染（get_metrics 工具输出） */
    render() {
        const snap = this.snapshot();
        const lines = [
            `[Metrics] uptime=${snap.uptime_sec}s | global: ${snap.global.calls} calls, ` +
                `success=${snap.global.success_rate ?? '-'}%, noop=${snap.global.noop_rate ?? '-'}%`,
            'tool                 calls  success  noop   p50ms  p95ms',
            '----                 -----  -------  ----   -----  -----',
        ];
        for (const t of snap.tools) {
            lines.push(`${t.tool.slice(0, 24).padEnd(24)} ${String(t.calls).padStart(5)}  ` +
                `${String(t.success_rate ?? '-').padStart(7)}  ${String(t.noop_rate ?? '-').padStart(4)}  ` +
                `${String(t.p50_ms).padStart(5)}  ${String(t.p95_ms).padStart(5)}`);
        }
        for (const c of snap.counters) {
            lines.push(`counter ${c.counter}: ${c.hits}/${c.hits + c.misses} hit (${c.hit_rate ?? '-'}%)`);
        }
        return lines.join('\n');
    }
    /** 模型自省指引：最值得警惕的信号直接给结论，不给原始数据让模型自己算 */
    insights() {
        const out = [];
        for (const [name, s] of this.tools) {
            if (s.calls >= 5) {
                const noopRate = s.noops / s.calls;
                if (noopRate >= 0.4) {
                    out.push(`HIGH NO-OP: ${Math.round(noopRate * 100)}% of ${name} calls changed nothing on screen — ` +
                        'coordinates are likely wrong. Use zoom_inspect or recall_ui before the next attempt.');
                }
                const failRate = s.failures / s.calls;
                if (failRate >= 0.5) {
                    out.push(`LOW SUCCESS: ${name} succeeds only ${100 - Math.round(failRate * 100)}% of the time — ` +
                        'switch modality (keyboard via press_hotkey) or consult match_skill for a verified route.');
                }
            }
        }
        return out;
    }
    /**
     * F-2 极值延迟尾报告：全工具延迟池的 GPD 尾拟合（POT）。
     * 消费方：get_metrics 的延迟洞见 —— ξ ≥ 0.25 时点名「黑天鹅常态」
     * （P99 看不见的尾部风险，p999 外推给数字）。样本不足 ⇒ null（诚实缺席）。
     */
    // F-2 旧 tailReport 已被 I-2 升级版（含 adStat/fit 法医字段）取代 —— 单一定义点
    /** dump/restore：checkpoint 崩溃恢复用（保留计数，延迟样本不必跨会话携带） */
    dump() {
        const tools = [...this.tools.entries()].map(([name, s]) => ({
            tool: name, calls: s.calls, successes: s.successes, failures: s.failures,
            noops: s.noops, totalMs: s.totalMs,
        }));
        const counters = [...this.counters.entries()].map(([name, c]) => ({ counter: name, ...c }));
        return { tools, counters };
    }
    restore(data) {
        if (!data)
            return;
        for (const t of data.tools ?? []) {
            const s = this.slot(t.tool);
            Object.assign(s, {
                calls: t.calls ?? 0, successes: t.successes ?? 0, failures: t.failures ?? 0,
                noops: t.noops ?? 0, totalMs: t.totalMs ?? 0,
            });
        }
        for (const c of data.counters ?? []) {
            this.counters.set(c.counter, { hits: c.hits ?? 0, misses: c.misses ?? 0 });
        }
    }
    reset() {
        this.tools.clear();
        this.counters.clear();
        this.startedAt = Date.now();
    }
}
export const telemetry = new Telemetry();
