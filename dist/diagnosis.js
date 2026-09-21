// src/diagnosis.ts
// H 纪元（创世纪·场的统一）：联合诊断皮层 —— 统计引擎之上的症候群规则表。
//
// 孤立信号只能报告「某指标异常」；症候群（信号组合）才能诊断「得了什么病」。
// E/F/G 三纪元装了七个观测引擎（noop 率/熵率/CUSUM/Hurst/GPD 尾/复杂度/……），
// 本模块是它们的会诊台：确定性规则表（非概率图模型 —— 规则可审计、可回放），
// 按诊断价值排序，首中即断。
//
// 诚实边界：规则阈值是各引擎洞见阈值的复用（不引入新旋钮）；规则间的互斥性
// 由优先序保证（先具体后一般）。贝叶斯网络/因果图是留白 —— 当前无训练数据。
/**
 * 专家 CPT：P(signal=on | syndrome)。行 = 症候群，列 = [shifted, hurstHigh,
 * loop, heavyTail, highNoop]。0.5 = 该症候群对此信号无主张（中性似然）。
 */
const BN_CPT = {
    'shift-and-cluster': [0.90, 0.85, 0.20, 0.30, 0.30],
    'regime-shift': [0.85, 0.30, 0.20, 0.25, 0.35],
    'deterministic-loop': [0.15, 0.35, 0.90, 0.10, 0.45],
    'failure-clustering': [0.20, 0.90, 0.30, 0.25, 0.30],
    'blind-clicking': [0.10, 0.20, 0.25, 0.10, 0.92],
    'stall-regime': [0.20, 0.25, 0.10, 0.90, 0.25],
};
const BN_SIGNAL_KEYS = ['shifted', 'hurstHigh', 'loop', 'heavyTail', 'highNoop'];
/**
 * 贝叶斯会诊（纯函数、确定性）：六症候群后验。
 * 输入信号全缺席 / 全 false ⇒ null（健康是诚实的缺席，不硬造分布）。
 * 消费方：get_metrics 在规则诊断之外附加 belief 块 —— 「首中即断」给处方，
 * 信念表给**证据组合的全景**（包括未被规则命中的竞争假设）。
 */
/**
 * M 纪元（留白兑现）：CPT 标定 —— 数据从哪来？**从审计过的确定性规则表蒸馏**。
 * 32 个信号组合全枚举 × 规则表 oracle（首中即断）⇒ 共现计数 + Beta(1,1) 平滑
 * + 向专家律收缩（4 伪计数托底）⇒ 拟合 CPT；agreement = 拟合后验 MAP 与规则
 * 判决的吻合率。数据血缘成文：oracle 可审计（diagnose 规则序）、蒸馏无参
 * （计数+平滑）—— 真实运行数据的接入点 = 替换 oracle 为遥测流，接口不变。
 */
export function calibrateCptFromRules() {
    const keys = Object.keys(BN_CPT);
    const counts = {};
    const fired = {};
    for (const s of keys) {
        counts[s] = [0, 0, 0, 0, 0];
        fired[s] = 0;
    }
    let enumerated = 0, ruleFired = 0, agree = 0;
    for (let mask = 0; mask < 32; mask++) {
        enumerated++;
        const sig = {
            regimeShiftTools: mask & 1 ? ['x'] : [],
            hurst: mask & 2 ? 0.8 : 0.3,
            behavior: { normalized: mask & 4 ? 0.1 : 0.6, phrases: mask & 4 ? 4 : 10, length: 30 },
            heavyLatencyTail: !!(mask & 8),
            highNoopTools: mask & 16 ? ['y'] : [],
        };
        const dx = diagnose(sig);
        if (!dx)
            continue;
        ruleFired++;
        fired[dx.syndrome] += 1;
        BN_SIGNAL_KEYS.forEach((k, i) => {
            if (mask & (1 << i))
                counts[dx.syndrome][i] += 1;
            void k;
        });
        const belief = bayesianBelief({
            shifted: !!(mask & 1), hurstHigh: !!(mask & 2), loop: !!(mask & 4),
            heavyTail: !!(mask & 8), highNoop: !!(mask & 16),
        });
        if (belief && belief[0].posterior > 0.5 && belief[0].syndrome === dx.syndrome)
            agree++;
    }
    const cpt = {};
    for (const s of keys) {
        const n = fired[s];
        cpt[s] = counts[s].map((c, i) => {
            const expert = BN_CPT[s][i];
            if (n === 0)
                return expert; // 规则未触达 ⇒ 专家律兜底（血缘标注）
            const fitted = (c + 1) / (n + 2); // Beta(1,1) 后验均值
            const w = n / (n + 4); // 收缩权重：证据多则数据主导
            return Math.round((w * fitted + (1 - w) * expert) * 1000) / 1000;
        });
    }
    return { cpt, agreement: ruleFired > 0 ? agree / ruleFired : 0, enumerated, ruleFired };
}
export function bayesianBelief(signals) {
    const observed = BN_SIGNAL_KEYS.filter(k => signals[k] !== null);
    if (observed.length === 0)
        return null;
    if (observed.every(k => signals[k] === false))
        return null;
    const logLike = [];
    for (const s of Object.keys(BN_CPT)) {
        let ll = Math.log(1 / 6); // 均匀先验
        BN_SIGNAL_KEYS.forEach((k, i) => {
            const v = signals[k];
            if (v === null)
                return; // 缺席不参与似然（missing-at-random 的最小假设）
            const pOn = BN_CPT[s][i];
            ll += Math.log(v ? pOn : 1 - pOn);
        });
        logLike.push({ s, ll });
    }
    // log-sum-exp 归一（数值稳定；六假设直接枚举 —— 无需近似）
    const m = Math.max(...logLike.map(x => x.ll));
    const ws = logLike.map(x => Math.exp(x.ll - m));
    const z = ws.reduce((a, b) => a + b, 0);
    return logLike
        .map((x, i) => ({ syndrome: x.s, posterior: Math.round((ws[i] / z) * 1000) / 1000 }))
        .sort((a, b) => b.posterior - a.posterior);
}
const isLoop = (b) => !!b && ((b.normalized !== null && b.normalized <= 0.3 && b.length >= 24) ||
    (b.phrases <= 6 && b.length >= 20));
/**
 * 会诊主入口（纯函数）：规则按诊断价值降序，首中即断。
 * 全部信号正常 ⇒ null（健康是诚实的缺席，不是「轻度亚健康」）。
 */
export function diagnose(sig) {
    const shifted = sig.regimeShiftTools ?? [];
    const clustered = typeof sig.hurst === 'number' && sig.hurst > 0.6;
    // 1. shift-and-cluster（最高优先）：环境突变 + 失败聚集 —— 旧经验失效且失败
    //    短期相关：任何「再试一次」都是最差策略
    if (shifted.length > 0 && clustered) {
        return {
            syndrome: 'shift-and-cluster',
            diagnosis: `Environment changed AND failures cluster (${shifted.join(', ')} regressed, Hurst ${sig.hurst}): prior experience is stale and failures are autocorrelated.`,
            prescription: 'STOP retrying entirely. take_screenshot to re-observe the world; treat old landmarks/skills as unverified; if two fresh attempts fail, ask the user.',
            evidence: [`cusum-shift:${shifted.join('|')}`, `hurst:${sig.hurst}`],
        };
    }
    // 2. regime-shift：环境变了 —— 旧经验（记忆/技能/坐标）可能整体失效
    if (shifted.length > 0) {
        return {
            syndrome: 'regime-shift',
            diagnosis: `Recent regime shift in ${shifted.join(', ')}: the environment changed under you (failure rate jumped vs its own baseline).`,
            prescription: 'Re-observe with take_screenshot before trusting any remembered coordinate; re-verify landmarks via recall_ui + from_memory_id pre-check.',
            evidence: [`cusum-shift:${shifted.join('|')}`],
        };
    }
    // 3. deterministic-loop：行为近周期 —— 与屏幕侧循环检测（E-3）互补的行为面
    if (isLoop(sig.behavior)) {
        return {
            syndrome: 'deterministic-loop',
            diagnosis: `Action stream is near-periodic (${sig.behavior.phrases} phrases over ${sig.behavior.length} actions): you are spinning deterministically.`,
            prescription: 'Break the cycle deliberately: what_if for counterfactual routes, match_skill for a verified path, or a completely different modality (keyboard via press_hotkey).',
            evidence: [`behavior:${sig.behavior.phrases}p/${sig.behavior.length}a`],
        };
    }
    // 4. failure-clustering：失败短期相关 —— 重试前先换状态
    if (clustered) {
        return {
            syndrome: 'failure-clustering',
            diagnosis: `Failures cluster in time (Hurst ${sig.hurst}): after a failure the next attempt is more likely to fail too.`,
            prescription: 'Insert an observation between attempts (take_screenshot or diff_view) instead of immediate retries; alternate modalities across attempts.',
            evidence: [`hurst:${sig.hurst}`],
        };
    }
    // 5. blind-clicking：高 noop —— 坐标系统性偏差
    if ((sig.highNoopTools ?? []).length > 0) {
        return {
            syndrome: 'blind-clicking',
            diagnosis: `High no-op rate in ${(sig.highNoopTools ?? []).join(', ')}: actions report success but change nothing — coordinates are systematically off.`,
            prescription: 'Ground before acting: find_text for labeled targets, zoom_inspect for uncertain regions, recall_ui priors with pre-verification.',
            evidence: [`noop:${(sig.highNoopTools ?? []).join('|')}`],
        };
    }
    // 6. stall-regime：延迟重尾 —— 环境卡顿，细碎动作放大尾部
    if (sig.heavyLatencyTail) {
        return {
            syndrome: 'stall-regime',
            diagnosis: 'Latency distribution is heavy-tailed (GPD ξ≥0.25): the environment stalls sporadically — rapid small actions amplify tail cost.',
            prescription: 'Batch interactions (type full text at once, avoid rapid click sequences); lengthen settle expectations rather than assuming hangs.',
            evidence: ['gpd-tail:xi>=0.25'],
        };
    }
    return null;
}
/**
 * 遥测 → 观测向量（标定管线的推导端）：从活体 Telemetry/Journal 提取当前
 * 五信号视图（与 observabilityTools.get_metrics 的洞见判据同律 —— 一处立法）。
 * 任一引擎数据不足 ⇒ 该信号 false（缺席不参与毒化）。
 */
export function observeSignalsForCalibration(deps) {
    return {
        shifted: deps.regimeShifts.length > 0,
        hurstHigh: typeof deps.hurst === 'number' && deps.hurst > 0.6,
        loop: !!(deps.behavior &&
            ((deps.behavior.normalized !== null && deps.behavior.normalized <= 0.3 && deps.behavior.length >= 24) ||
                (deps.behavior.phrases <= 6 && deps.behavior.length >= 20))),
        heavyTail: deps.heavyLatencyTail === true,
        highNoop: deps.highNoopTools.length > 0,
    };
}
/**
 * CPT 遥测标定（M 纪元接口的换血版）：观测流（真实日志的信号组合 + 频次）
 * × 规则表 oracle 标签 ⇒ 共现计数 + Beta(1,1) 平滑 + 专家律收缩（与
 * calibrateCptFromRules 同律；差别仅在数据源 —— 枚举 32 均匀组合 vs 真实
 * 分布加权）。agreement = 加权吻合率。样本不足的症候群行由专家律托底
 * （血缘标注在同行的 cpt 值中不可分 —— 由 n 字段如实申报）。
 */
export function calibrateCptFromTelemetry(observations) {
    const keys = Object.keys(BN_CPT);
    const counts = {};
    const fired = {};
    for (const s of keys) {
        counts[s] = [0, 0, 0, 0, 0];
        fired[s] = 0;
    }
    let sampled = 0, agree = 0;
    const distinct = new Set();
    for (const obs of observations) {
        const w = Math.max(1, Math.floor(obs.weight ?? 1));
        distinct.add([obs.shifted, obs.hurstHigh, obs.loop, obs.heavyTail, obs.highNoop].map(b => b ? 1 : 0).join(''));
        const sig = {
            regimeShiftTools: obs.shifted ? ['x'] : [],
            hurst: obs.hurstHigh ? 0.8 : 0.3,
            behavior: { normalized: obs.loop ? 0.1 : 0.6, phrases: obs.loop ? 4 : 10, length: 30 },
            heavyLatencyTail: obs.heavyTail,
            highNoopTools: obs.highNoop ? ['y'] : [],
        };
        const dx = diagnose(sig);
        sampled += w;
        if (!dx)
            continue; // 健康组合：无症候群可归 —— 不参与计数（同 M 律）
        fired[dx.syndrome] += w;
        const bits = [obs.shifted, obs.hurstHigh, obs.loop, obs.heavyTail, obs.highNoop];
        bits.forEach((b, i) => { if (b)
            counts[dx.syndrome][i] += w; });
        const belief = bayesianBelief({
            shifted: obs.shifted, hurstHigh: obs.hurstHigh, loop: obs.loop,
            heavyTail: obs.heavyTail, highNoop: obs.highNoop,
        });
        if (belief && belief[0].posterior > 0.5 && belief[0].syndrome === dx.syndrome)
            agree += w;
    }
    const cpt = {};
    for (const s of keys) {
        const n = fired[s];
        cpt[s] = counts[s].map((c, i) => {
            const expert = BN_CPT[s][i];
            if (n === 0)
                return expert;
            const fitted = (c + 1) / (n + 2);
            return Math.round((0.8 * fitted + 0.2 * expert) * 1000) / 1000;
        });
    }
    return {
        cpt,
        agreement: sampled > 0 ? Math.round((agree / sampled) * 1000) / 1000 : 0,
        sampled,
        distinct: distinct.size,
        syndromeSamples: fired,
    };
}
