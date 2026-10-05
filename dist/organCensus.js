// src/organCensus.ts
// U 纪元（U-4 自省层）：器官册 —— 33 件数学器官的运行时 census。
//
// 立法：每件器官登记（名 / 层 / 数学根基 / 自检 λ）。quality_checkup 的
// 自省段逐件点名自检 —— 器官不健康（自检 false）即 AMBER。genesis 的
// "premature-impl" 规则至此有了对称面：impl 后的 **operational census**。
//
// 纪元 Δ（infra 簇）双修：
//   1. 自检去装饰化 —— 确有环境依赖的器官挂真探针（只读探测，绝不铸造
//      网络请求/子进程）；纯数学器官如实标注 `static: true`：λ 演算纯函数
//      没有可探测的环境面，自检恒真是诚实而非装饰。
//   2. hedge-actor 描述纠偏 —— 乘性权重已在 V 纪元审判日被推翻，现实是
//      通道成功率 EMA 仲裁（见 orchestrator.ts 的 channelEma/EMA_ALPHA）。
import { createRequire } from 'node:module';
// ─── Δ 纪元：真自检探针 ───
//
// 感知/模糊器官的 legacy 路径依赖 devDeps 原生包（sharp / tesseract.js，
// 生产安装会被剥离）。探针用 createRequire 的同步 CJS 加载做真探测：
// 包缺席或原生绑定损坏同样抛错（resolve 只证包在场，不证可加载）。
// 与 _legacyDeps.getSharp/getTesseract 共享同一 CJS 模块缓存 —— 探针
// 先行加载即预热二者的后续动态 import，两次询问不会给出相左的事实。
const nodeRequire = createRequire(import.meta.url);
/** sharp 可用性 —— pHash/ringHash/dHash 像素解码的地基（legacy 路径） */
function probeSharp() {
    try {
        const mod = nodeRequire('sharp');
        const fn = typeof mod === 'function' ? mod : mod?.default;
        return typeof fn === 'function';
    }
    catch {
        return false;
    }
}
/** tesseract.js 可用性 —— legacy OCR 地基（fuzzy-substring 的 ⌈m/6⌉ 容差吃 OCR 文本） */
function probeTesseract() {
    try {
        const mod = nodeRequire('tesseract.js');
        const fn = (typeof mod === 'object' && mod !== null && 'default' in mod ? mod.default : mod);
        return typeof fn?.createWorker === 'function';
    }
    catch {
        return false;
    }
}
/** 器官册（O/P/Q/R/S/T/U 七纪元铸）—— 新器官入册一行；纯数学器官标 static，环境依赖器官挂真探针 */
export const ORGAN_CENSUS = [
    { id: 'mmr-proof', layer: '证明', math: 'Merkle Mountain Range（叶数 2^k 分解 + 峰袋）', selfCheck: () => true, static: true },
    { id: 'phash-dct', layer: '感知', math: 'DCT-II 低频谱（Zauner 2010；DC 排除亮度不变）', selfCheck: probeSharp },
    { id: 'ringhash-rot', layer: '感知', math: '质心环带分布（旋转不变第三指）', selfCheck: probeSharp },
    { id: 'sprt-popup', layer: '决策', math: 'Wald 序贯检验（Wald–Wolfowitz 最优停止）', selfCheck: () => true, static: true },
    { id: 'dirichlet-entropy', layer: '知识', math: 'Dirichlet(1) 平滑预测熵 + 集中度', selfCheck: () => true, static: true },
    { id: 'skill-phylogeny', layer: '记忆', math: '演化谱系（parents/generation/灭绝剪枝）', selfCheck: () => true, static: true },
    { id: 'effect-size', layer: '证据', math: "Cohen's h + Mann–Whitney U（并列校正）", selfCheck: () => true, static: true },
    { id: 'thompson-crystals', layer: '探索', math: 'Beta(s+1,f+1) 后验抽样排序', selfCheck: () => true, static: true },
    { id: 'focus-velocity', layer: '运动', math: '一阶差分速度外推（钳半屏）', selfCheck: () => true, static: true },
    { id: 'fuzzy-substring', layer: '模糊', math: '子串编辑距离 DP（⌈m/6⌉ OCR 容差）', selfCheck: probeTesseract },
    { id: 'bm25-retrieval', layer: '检索', math: 'BM25（k1=1.2/b=0.75，语料级 IDF）', selfCheck: () => true, static: true },
    { id: 'beta-breaker', layer: '熔断', math: 'Beta-Bernoulli 上尾 ≥0.95（I_x Lentz）', selfCheck: () => true, static: true },
    { id: 'cp-anchor-v4', layer: '快照', math: 'journal/sandbox 双 MMR 锚 + 恢复验证', selfCheck: () => true, static: true },
    { id: 'stable-element-ids', layer: '视觉', math: 'IoU 贪心跟踪（0.4 阈值，≤5 帧续号）', selfCheck: () => true, static: true },
    { id: 'rrf-recall', layer: '召回', math: '倒数排名融合 Σ1/(60+rank)', selfCheck: () => true, static: true },
    { id: 'reservoir-quantiles', layer: '过程', math: 'Vitter 蓄水库草图 + 序统计', selfCheck: () => true, static: true },
    // Δ 纪元纠偏：乘性权重（w←w·exp(−η·loss)）在 V 纪元审判日被推翻（劣质通道
    // 周期性复辟 110/151）；现实是通道成功率 EMA 仲裁（orchestrator.ts 实现）
    { id: 'hedge-actor', layer: '决策', math: '通道成功率 EMA 仲裁（α=0.15，Laplace 初值 0.5；只更新被选通道，argmax 平权 ⇒ agents 优先）', selfCheck: () => true, static: true },
    { id: 'beta-trust-landmark', layer: '记忆', math: '(s+1)/(s+2) 后验信任', selfCheck: () => true, static: true },
    { id: 'ltlf-enforcer', layer: '规约', math: '挖掘性质在线执法（mine→enforce）', selfCheck: () => true, static: true },
    { id: 'dejavu-dual-fp', layer: '认知', math: 'dHash×pHash 双指共识（≥0.85）', selfCheck: probeSharp },
    { id: 'quantized-signature', layer: '行为', math: '0.01 网格量化签名（≈20px@1080p）', selfCheck: () => true, static: true },
    { id: 'verdict-coalescing', layer: '通道', math: '同链去重（保最新）', selfCheck: () => true, static: true },
    { id: 'full-jitter-backoff', layer: '服务', math: 'uniform(0, base·2^n) 全抖动', selfCheck: () => true, static: true },
    { id: 'counterfactual-h', layer: '证据', math: "反事实 Cohen's h + Laplace 路线率", selfCheck: () => true, static: true },
    { id: 'nms-elements', layer: '视觉', math: '非极大值抑制（IoU≥0.6 面积降序贪心）', selfCheck: () => true, static: true },
    { id: 'guard-chain-proof', layer: '证明', math: '守卫裁决 GUARD_BLOCKED 入链', selfCheck: () => true, static: true },
    { id: 'gpd-pwm', layer: '统计', math: 'PWM 主估计 + 矩法交叉证人（一致性裁决）', selfCheck: () => true, static: true },
    { id: 'cusum-twosided', layer: '统计', math: '双边 CUSUM + 环前终身基线', selfCheck: () => true, static: true },
    { id: 'w1-info-view', layer: '空间', math: '熵加权 W₁（w1Info/infoRatio 双视图）', selfCheck: () => true, static: true },
    { id: 'teleport-field', layer: '空间', math: '相干位移场（≥2 特征同矢量共移）', selfCheck: () => true, static: true },
    { id: 'ltlf-miner', layer: '规约', math: '三族挖掘（支持度≥3 零反例立法）', selfCheck: () => true, static: true },
    { id: 'calibration-loops', layer: '标定', math: 'A² MC 自举 / Kalman QR / Schmitt / NCD-Youden', selfCheck: () => true, static: true },
    { id: 'bcr-gate', layer: '免疫', math: 'Bug 类注册表 BC-1..4 机械检测闸', selfCheck: () => true, static: true },
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
/** ΠΑΝ-124：模块装载基线（冻结 —— 册面的「出厂形状」） */
const CENSUS_BASELINE = Object.freeze(ORGAN_CENSUS.map(o => ({ id: o.id, layer: o.layer, static: o.static === true })));
function censusShape(specs) {
    const m = new Map();
    for (const o of specs)
        m.set(o.id, { id: o.id, layer: o.layer, static: o.static === true });
    return m;
}
/**
 * ΠΑΝ-124：器官册漂移比对（纯函数，确定性 —— 测试与跨版本对比的执法原子）。
 * prev/cur 任一侧缺席的 id 记 added/removed；layer 变化记 layer-changed；
 * static 标记翻转记 probe-flip（纯数学器官 ↔ 环境探针器官是健康语义的变化）。
 */
export function diffOrganCensus(prev, cur) {
    const p = censusShape(prev), c = censusShape(cur);
    const events = [];
    for (const [id, cs] of c) {
        const ps = p.get(id);
        if (!ps) {
            events.push({ kind: 'organ-added', id, detail: `organ "${id}" (layer ${cs.layer}) not in baseline census` });
        }
        else {
            if (ps.layer !== cs.layer) {
                events.push({ kind: 'layer-changed', id, detail: `organ "${id}" layer ${ps.layer} -> ${cs.layer}` });
            }
            if (ps.static !== cs.static) {
                events.push({
                    kind: 'probe-flip', id,
                    detail: `organ "${id}" probe form ${ps.static ? 'static (pure math)' : 'environment probe'} -> ` +
                        `${cs.static ? 'static (pure math)' : 'environment probe'}`,
                });
            }
        }
    }
    for (const [id] of p) {
        if (!c.has(id)) {
            events.push({ kind: 'organ-removed', id, detail: `organ "${id}" present in baseline census but absent now` });
        }
    }
    // 确定性输出序：kind 字典序 + id 字典序（无 Map 迭代序依赖）
    events.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return events;
}
/**
 * ΠΑΝ-124：当前册 vs 模块装载基线的漂移事件（ organside 变化即事件）。
 * 干净进程恒 []（执法测试锁定）；非空 ⇒ 册面被运行时改动 —— 上报给
 * quality_checkup 消费方作 AMBER 级注记（接线面：观测 API 在场，消费方
 * 按需点名 —— 与 organCensus() 同步契约）。
 */
export function organCensusDrift() {
    return diffOrganCensus(CENSUS_BASELINE, ORGAN_CENSUS.map(o => ({
        id: o.id, layer: o.layer, static: o.static === true,
    })));
}
