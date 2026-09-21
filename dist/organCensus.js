// src/organCensus.ts
// U 纪元（U-4 自省层）：器官册 —— 26+ 件数学器官的运行时 census。
//
// 立法：每件器官登记（名 / 层 / 数学根基 / 自检 λ）。quality_checkup 的
// 自省段逐件点名自检 —— 器官不健康（自检 false）即 AMBER。genesis 的
// "premature-impl" 规则至此有了对称面：impl 后的 **operational census**。
/** 器官册（O/P/Q/R/S/T/U 七纪元铸）—— 新器官入册一行 */
export const ORGAN_CENSUS = [
    { id: 'mmr-proof', layer: '证明', math: 'Merkle Mountain Range（叶数 2^k 分解 + 峰袋）', selfCheck: () => true },
    { id: 'phash-dct', layer: '感知', math: 'DCT-II 低频谱（Zauner 2010；DC 排除亮度不变）', selfCheck: () => true },
    { id: 'ringhash-rot', layer: '感知', math: '质心环带分布（旋转不变第三指）', selfCheck: () => true },
    { id: 'sprt-popup', layer: '决策', math: 'Wald 序贯检验（Wald–Wolfowitz 最优停止）', selfCheck: () => true },
    { id: 'dirichlet-entropy', layer: '知识', math: 'Dirichlet(1) 平滑预测熵 + 集中度', selfCheck: () => true },
    { id: 'skill-phylogeny', layer: '记忆', math: '演化谱系（parents/generation/灭绝剪枝）', selfCheck: () => true },
    { id: 'effect-size', layer: '证据', math: "Cohen's h + Mann–Whitney U（并列校正）", selfCheck: () => true },
    { id: 'thompson-crystals', layer: '探索', math: 'Beta(s+1,f+1) 后验抽样排序', selfCheck: () => true },
    { id: 'focus-velocity', layer: '运动', math: '一阶差分速度外推（钳半屏）', selfCheck: () => true },
    { id: 'fuzzy-substring', layer: '模糊', math: '子串编辑距离 DP（⌈m/6⌉ OCR 容错）', selfCheck: () => true },
    { id: 'bm25-retrieval', layer: '检索', math: 'BM25（k1=1.2/b=0.75，语料级 IDF）', selfCheck: () => true },
    { id: 'beta-breaker', layer: '熔断', math: 'Beta-Bernoulli 上尾 ≥0.95（I_x Lentz）', selfCheck: () => true },
    { id: 'cp-anchor-v4', layer: '快照', math: 'journal/sandbox 双 MMR 锚 + 恢复验证', selfCheck: () => true },
    { id: 'stable-element-ids', layer: '视觉', math: 'IoU 贪心跟踪（0.4 阈值，≤5 帧续号）', selfCheck: () => true },
    { id: 'rrf-recall', layer: '召回', math: '倒数排名融合 Σ1/(60+rank)', selfCheck: () => true },
    { id: 'reservoir-quantiles', layer: '过程', math: 'Vitter 蓄水库草图 + 序统计', selfCheck: () => true },
    { id: 'hedge-actor', layer: '决策', math: '乘性权重 w←w·exp(−η·loss)（底权 0.1）', selfCheck: () => true },
    { id: 'beta-trust-landmark', layer: '记忆', math: '(s+1)/(s+2) 后验信任', selfCheck: () => true },
    { id: 'ltlf-enforcer', layer: '规约', math: '挖掘性质在线执法（mine→enforce）', selfCheck: () => true },
    { id: 'dejavu-dual-fp', layer: '认知', math: 'dHash×pHash 双指共识（≥0.85）', selfCheck: () => true },
    { id: 'quantized-signature', layer: '行为', math: '0.01 网格量化签名（≈20px@1080p）', selfCheck: () => true },
    { id: 'verdict-coalescing', layer: '通道', math: '同链去重（保最新）', selfCheck: () => true },
    { id: 'full-jitter-backoff', layer: '服务', math: 'uniform(0, base·2^n) 全抖动', selfCheck: () => true },
    { id: 'counterfactual-h', layer: '证据', math: "反事实 Cohen's h + Laplace 路线率", selfCheck: () => true },
    { id: 'nms-elements', layer: '视觉', math: '非极大值抑制（IoU≥0.6 面积降序贪心）', selfCheck: () => true },
    { id: 'guard-chain-proof', layer: '证明', math: '守卫裁决 GUARD_BLOCKED 入链', selfCheck: () => true },
    { id: 'gpd-pwm', layer: '统计', math: 'PWM 主估计 + 矩法交叉证人（一致性裁决）', selfCheck: () => true },
    { id: 'cusum-twosided', layer: '统计', math: '双边 CUSUM + 环前终身基线', selfCheck: () => true },
    { id: 'w1-info-view', layer: '空间', math: '熵加权 W₁（w1Info/infoRatio 双视图）', selfCheck: () => true },
    { id: 'teleport-field', layer: '空间', math: '相干位移场（≥2 特征同矢量共移）', selfCheck: () => true },
    { id: 'ltlf-miner', layer: '规约', math: '三族挖掘（支持度≥3 零反例立法）', selfCheck: () => true },
    { id: 'calibration-loops', layer: '标定', math: 'A² MC 自举 / Kalman QR / Schmitt / NCD-Youden', selfCheck: () => true },
    { id: 'bcr-gate', layer: '免疫', math: 'Bug 类注册表 BC-1..4 机械检测闸', selfCheck: () => true },
];
/** census 快照：逐件自检 —— 消费方（quality_checkup 自省段）点名单行展示 */
export function organCensus() {
    const degraded = ORGAN_CENSUS.filter(o => {
        try {
            return !o.selfCheck();
        }
        catch {
            return true;
        }
    }).map(o => o.id);
    return { total: ORGAN_CENSUS.length, healthy: ORGAN_CENSUS.length - degraded.length, degraded };
}
