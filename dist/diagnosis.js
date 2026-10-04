// src/diagnosis.ts
// W6-2 结构性保留（doctor smell.over-engineering 登记）：H 纪元会诊皮层 —— 贝叶斯 CPT 标定/规则表/遥测观测/R1 根因链四节共享同一症候群词表与首中即断序，规则表与证据词表必须同框审计。
// H 纪元（创世纪·场的统一）：联合诊断皮层 —— 统计引擎之上的症候群规则表。
//
// 孤立信号只能报告「某指标异常」；症候群（信号组合）才能诊断「得了什么病」。
// E/F/G 三纪元装了七个观测引擎（noop 率/熵率/CUSUM/Hurst/GPD 尾/复杂度/……），
// 本模块是它们的会诊台：确定性规则表（非概率图模型 —— 规则可审计、可回放），
// 按诊断价值排序，首中即断。
//
// 诚实边界：规则阈值是各引擎洞见阈值的复用（不引入新旋钮）；规则间的互斥性
// 由优先序保证（先具体后一般）。贝叶斯网络/因果图是留白 —— 当前无训练数据。
//
// W1-6 注记：本文件末节新增「R1 鉴别试验根因归因链」—— 会诊台诊断系统级
// 症候群，R1 节诊断单次失败的病因；两者共享「首中即断 + 证据可回放」哲学。
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
// W6-2（doctor smell.magic-number 清偿）：行为近周期判据的样本数下界（数值逐位不变）。
// 熵率臂：归一化熵率 ≤0.3 且样本 ≥24（渐近域）；短语臂：短语数 ≤6 且样本 ≥20
// （短序列的倍增签名 —— 归一化在小 n 时通胀，短语绝对数不受此影响）。
// 导出供 observabilityTools 洞见判据复用（「与 get_metrics 同律 —— 一处立法」）。
export const LOOP_ENTROPY_MIN_ACTIONS = 24;
export const LOOP_PHRASE_MIN_ACTIONS = 20;
const isLoop = (b) => !!b && ((b.normalized !== null && b.normalized <= 0.3 && b.length >= LOOP_ENTROPY_MIN_ACTIONS) ||
    (b.phrases <= 6 && b.length >= LOOP_PHRASE_MIN_ACTIONS));
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
        // W6-2：复用上方 isLoop 同律谓词（与 get_metrics 洞见判据一处立法）
        loop: isLoop(deps.behavior),
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
            const w = n / (n + 4); // 收缩权重与 calibrateCptFromRules 同律（样本少 ⇒ 专家律主导）
            return Math.round((w * fitted + (1 - w) * expert) * 1000) / 1000;
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
import { similarity } from './perceptualHash.js'; // W1-6：dhash 回退通道的比较器（轻量纯模块）
/** W1-6：运行时枚举面（防御解析/序列化往返的合法值域） */
export const ROOT_CAUSE_IDS = [
    'over-strict-verification', 'blind-spot-text', 'stall', 'unknown',
];
/**
 * W1-6：防御解析 —— 任意值 → 合法根因（旧记录无字段/垃圾值 ⇒ unknown）。
 * 失败记忆恢复（checkpoint 反序列化）与一切外部输入经此收口。
 */
export function parseRootCause(v) {
    return typeof v === 'string' && ROOT_CAUSE_IDS.includes(v)
        ? v
        : 'unknown';
}
// ── W1-6：判据常量（不引入新旋钮 —— 值即边界，与模块头同立场）──
/** ① 「屏变了」的像素门槛（%）：≥0.5% 是结构性变化，<0.5% 多为闪烁/残影 */
const RC_CHANGED_STRONG_PCT = 0.5;
/** ① 强证据置信：动作生效 × 报失败 ⇒ 校验过严（像素级全屏证据） */
const RC_SCORE_OVERSTRICT_STRONG = 0.9;
/** ① 弱证据置信：微弱重绘（光标闪烁级）—— 只给倾向，不定案 */
const RC_SCORE_OVERSTRICT_WEAK = 0.55;
/** ② I-beam（OS 亲判正文）⇒ 盲点文本的置信（与 fuseVerdict ibeam 0.92 同律） */
const RC_SCORE_BLINDSPOT_IBEAM = 0.92;
/** ② UIA 结构层判 text ⇒ 盲点文本（0.93 判决降一档 —— 非 I-beam 直证） */
const RC_SCORE_BLINDSPOT_UIA_TEXT = 0.88;
/** ② hand（可点热区在场却无效）⇒ 盲点文本的弱置信（语义错配，非正文直证） */
const RC_SCORE_BLINDSPOT_HAND = 0.65;
/** ③ 连续帧冻结 ⇒ stall 的置信（行为证据：世界停摆的观察直证） */
const RC_SCORE_STALL = 0.85;
/** ③ 的 dhash 回退相似阈：≥0.9 视为「屏没变」（与场景匹配惯例 0.9 同律） */
const RC_DHASH_UNCHANGED_SIM = 0.9;
/** 各根因的细化假设（处方方向 —— 候选表的消费面） */
const RC_HYPOTHESIS = {
    'over-strict-verification': 'The action DID change the world while verification reported failure. Re-observe (take_screenshot/diff_view) and re-verify before retrying; do NOT blindly re-execute the same action.',
    'blind-spot-text': 'The clicked point is not a working entry (text or mismatched hotzone). Switch modality: keyboard via press_hotkey (tab/enter), or re-locate the real control with find_text + zoom_inspect.',
    'stall': 'Consecutive frames are frozen — the world is not repainting. Wait/settle longer before the next action; avoid rapid retries that amplify tail latency.',
    'unknown': 'No root cause isolated by the available probes. Gather more evidence (take_screenshot, probe_interactivity, zoom_inspect) before retrying; treat this failure as unexplained.',
};
/**
 * W1-6 鉴别主入口（纯函数、确定性）：观察值集合 → 排序根因候选列表 + 证据链。
 *
 * 与 diagnose 同律的诚实边界：没有任何决定性证据 ⇒ 唯一候选是 unknown（诚实
 * 的兜底，不是「轻度倾向」）；被排除的分支记入 trail（鉴别过程可回放）。
 * 三类根因与三类探针一一对应（①→over-strict，②→blind-spot，③→stall）。
 */
export function differentialDiagnose(obs) {
    const trail = [];
    const degradedNotes = [...(obs.degradedNotes ?? [])];
    const supports = {};
    const addSupport = (id, score, step) => {
        const prev = supports[id];
        if (!prev || score > prev.score) {
            supports[id] = { score: Math.min(0.95, score), chain: [...(prev?.chain ?? []), step] };
        }
        else {
            prev.chain.push(step); // 同病因的次级证据入链（排序取主证分）
        }
    };
    // ── ① 前后帧 visualDiff：屏变没变（over-strict 的判别通道）──
    const diff = obs.diff ?? null;
    if (diff) {
        const pct = Number.isFinite(diff.changed_fraction_pct) ? diff.changed_fraction_pct : 0;
        if (!diff.identical && pct >= RC_CHANGED_STRONG_PCT) {
            const step = {
                probe: 'visual-diff',
                symptom: 'screen changed after the failed action',
                differential: 'the action had a real world-effect — the failure verdict is stricter than reality',
                observation: `changed_fraction_pct=${pct}`,
            };
            trail.push(step);
            addSupport('over-strict-verification', RC_SCORE_OVERSTRICT_STRONG, step);
        }
        else if (!diff.identical) {
            const step = {
                probe: 'visual-diff',
                symptom: 'screen barely changed after the failed action',
                differential: 'tiny repaint is cursor-blink-grade — weak support for over-strict verification, not decisive',
                observation: `changed_fraction_pct=${pct}`,
            };
            trail.push(step);
            addSupport('over-strict-verification', RC_SCORE_OVERSTRICT_WEAK, step);
        }
        else {
            trail.push({
                probe: 'visual-diff',
                symptom: 'screen unchanged after the failed action',
                differential: 'no world-effect — over-strict verification excluded',
                observation: 'identical=true',
            });
        }
    }
    else if (typeof obs.dhashSimilarity === 'number' && Number.isFinite(obs.dhashSimilarity)) {
        // 像素通道缺席时的 dhash 粗判（降级引擎，置信降档 —— 如实标注观察源）
        const s = Math.round(obs.dhashSimilarity * 1000) / 1000;
        if (s < RC_DHASH_UNCHANGED_SIM) {
            const step = {
                probe: 'visual-diff',
                symptom: 'frame fingerprints differ after the failed action',
                differential: 'coarse dhash channel suggests a world-effect — weak support for over-strict verification',
                observation: `dhash_similarity=${s}`,
            };
            trail.push(step);
            addSupport('over-strict-verification', RC_SCORE_OVERSTRICT_WEAK, step);
        }
        else {
            trail.push({
                probe: 'visual-diff',
                symptom: 'frame fingerprints match after the failed action',
                differential: 'no world-effect at fingerprint resolution — over-strict verification excluded',
                observation: `dhash_similarity=${s}`,
            });
        }
    }
    // ── ② 悬停光标探针：该点是什么（blind-spot 的判别通道）──
    const cursor = obs.hoverCursorKind ?? null;
    const verdict = obs.hoverVerdict ?? null;
    if (cursor || verdict) {
        if (cursor === 'ibeam') {
            const step = {
                probe: 'hover-cursor',
                symptom: 'cursor over the failed target is an I-beam',
                differential: 'the OS treats this point as selectable text, not a clickable entry — clicking cannot work here',
                observation: `cursor=ibeam${verdict ? ` verdict=${verdict}` : ''}`,
            };
            trail.push(step);
            addSupport('blind-spot-text', RC_SCORE_BLINDSPOT_IBEAM, step);
        }
        else if (cursor === 'hand') {
            const step = {
                probe: 'hover-cursor',
                symptom: 'cursor over the failed target is a hand (clickable hotzone) yet nothing changed',
                differential: 'a hotzone exists but the click produced no effect — interaction semantics mismatch (needs keyboard or a different gesture/target)',
                observation: `cursor=hand${verdict ? ` verdict=${verdict}` : ''}`,
            };
            trail.push(step);
            addSupport('blind-spot-text', RC_SCORE_BLINDSPOT_HAND, step);
        }
        else if (verdict === 'text') {
            const step = {
                probe: 'hover-cursor',
                symptom: 'structure layer registers the failed target as static text',
                differential: 'UIA point-query classifies this point as content, not a control — the click target is a blind spot',
                observation: `verdict=text${cursor ? ` cursor=${cursor}` : ''}`,
            };
            trail.push(step);
            addSupport('blind-spot-text', RC_SCORE_BLINDSPOT_UIA_TEXT, step);
        }
        else {
            trail.push({
                probe: 'hover-cursor',
                symptom: `cursor channel abstains over the failed target (${cursor ?? 'n/a'})`,
                differential: 'non-decisive cursor shape — blind-spot hypothesis stays open, freeze probe decides next',
                observation: `cursor=${cursor ?? 'n/a'} verdict=${verdict ?? 'n/a'}`,
            });
        }
    }
    // ── ③ 连续帧冻结：世界还在重绘吗（stall 的判别通道）──
    const afterDhash = obs.afterFrame?.dhash ?? null;
    const followups = obs.followupDhashes ?? [];
    if (afterDhash !== null && followups.length > 0) {
        const usable = followups.filter((d) => typeof d === 'string' && d.length > 0);
        if (usable.length === 0) {
            degradedNotes.push('freeze probe ran but every followup frame lacked a fingerprint'); // W1-6：采帧在场、指纹缺席 = 降级
        }
        else if (usable.every(d => d === afterDhash)) {
            const step = {
                probe: 'frame-freeze',
                symptom: `all consecutive frame fingerprints are identical (${usable.length + 1} frames)`,
                differential: 'the world is not repainting at all — environment stall, not a targeting error',
                observation: `frozen_frames=${usable.length + 1}`,
            };
            trail.push(step);
            addSupport('stall', RC_SCORE_STALL, step);
        }
        else {
            trail.push({
                probe: 'frame-freeze',
                symptom: 'a followup frame differs from the post-failure frame',
                differential: 'the world is still repainting — stall excluded',
                observation: `followups=${followups.length} frozen=false`,
            });
        }
    }
    // ── ④ 兜底与结算 ──
    const ORDER = ['over-strict-verification', 'blind-spot-text', 'stall'];
    const candidates = ORDER
        .filter(id => supports[id])
        .map(id => ({
        rootCause: id,
        score: Math.round(supports[id].score * 1000) / 1000,
        hypothesis: RC_HYPOTHESIS[id],
        chain: supports[id].chain,
    }))
        .sort((a, b) => b.score - a.score);
    if (candidates.length === 0) {
        const step = {
            probe: 'fallback',
            symptom: 'no discriminating probe evidence in this failure',
            differential: 'differential exhausted without a decisive witness — honest unknown, not a fabricated cause',
            observation: `probes_consulted=${trail.length}${degradedNotes.length > 0 ? ` degraded=${degradedNotes.length}` : ''}`,
        };
        trail.push(step);
        candidates.push({ rootCause: 'unknown', score: 0, hypothesis: RC_HYPOTHESIS.unknown, chain: [step] });
    }
    return {
        tool: obs.tool ?? '',
        rootCause: candidates[0].rootCause,
        candidates,
        trail,
        degraded: degradedNotes.length > 0,
        degradedNotes,
    };
}
const RC_DEFAULT_PORT_TIMEOUT_MS = 1500;
const RC_DEFAULT_FREEZE_SAMPLES = 2;
const RC_DEFAULT_FREEZE_GAP_MS = 300;
const RC_MAX_FREEZE_SAMPLES = 3;
/** 整个鉴别序列的墙钟预算 ms：超支 ⇒ 跳过余下探针（旁路纪律） */
const RC_BUDGET_MS = 3000;
const rcSleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));
/**
 * W1-6 鉴别探针序列编排（医学鉴别诊断式瀑布，防御式、绝不抛）：
 *
 *   ① 取前后帧 → 像素 diff（屏显著变了 ⇒ over-strict 成立，首中即断）
 *   ② 屏没变/像素通道缺席 → 悬停探针读目标点光标（ibeam/hand/text ⇒ blind-spot，首中即断）
 *   ③ 仍无决定性证据 → 连续帧冻结探针（dhash 全同 ⇒ stall）
 *   ④ 兜底 unknown
 *
 * 每个端口调用独立 try/catch + 墙钟超时 + 总预算；缺席/超时/抛错一律记
 * degradedNotes 并继续 —— 归因失败的成本上限是「一次无结论」，不是异常。
 * ports 本身缺席（未注入且生产端口不可用）⇒ 直接降级 unknown 报告。
 */
export async function runDifferentialProbes(ports, context) {
    // W1-6：绝对不抛保证 —— 序列本体的一切意外（含注入件的恶意属性读取）在此
    // 收口为「一次无结论 + 降级记注」，调用方（守卫）永远拿到合法报告。
    try {
        return await runDifferentialProbesSequence(ports, context);
    }
    catch {
        return differentialDiagnose({
            tool: context?.tool ?? '',
            degradedNotes: ['orchestrator defensive fallback (unexpected throw)'],
        });
    }
}
async function runDifferentialProbesSequence(ports, context) {
    const tool = context?.tool ?? '';
    const notes = [];
    const t0 = Date.now();
    const portTimeout = Math.max(100, ports?.portTimeoutMs ?? RC_DEFAULT_PORT_TIMEOUT_MS);
    const budgetLeft = () => Date.now() - t0 < RC_BUDGET_MS;
    /** 单端口防御执行：缺席 ⇒ null；抛错 ⇒ null + 记注；超时 ⇒ null（race 兜底）。
     *  超时定时器在 race 结算后清掉 —— 快端口的定时器不悬挂进程事件循环。 */
    async function safe(label, fn) {
        if (typeof fn !== 'function')
            return null;
        let timer;
        try {
            const out = await Promise.race([
                fn(),
                new Promise(resolve => { timer = setTimeout(() => resolve(null), portTimeout); }),
            ]);
            if (out === null || out === undefined)
                notes.push(`${label}: returned no observation`);
            return out ?? null;
        }
        catch {
            notes.push(`${label}: threw`);
            return null;
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
    }
    if (!ports || typeof ports !== 'object') {
        return differentialDiagnose({ tool, degradedNotes: ['no probe ports injected (attribution skipped)'] });
    }
    // ── ① 前后帧 + 像素差分 ──
    let before = null;
    let after = null;
    let diff = null;
    const hasFramePort = typeof ports.getBeforeFrame === 'function' || typeof ports.captureFrame === 'function';
    if (hasFramePort && budgetLeft()) {
        const pair = await Promise.all([
            safe('getBeforeFrame', typeof ports.getBeforeFrame === 'function' ? () => ports.getBeforeFrame() : undefined),
            safe('captureFrame', typeof ports.captureFrame === 'function' ? () => ports.captureFrame() : undefined),
        ]);
        before = pair[0];
        after = pair[1];
        if (before && after) {
            if (before.buffer && after.buffer && typeof ports.diffFrames === 'function') {
                diff = await safe('diffFrames', () => ports.diffFrames(before, after));
            }
            else if (before.dhash && after.dhash) {
                // 像素通道缺席（参考帧降级为指纹 / 差分引擎未注入）⇒ dhash 粗判兜底
                notes.push(!before.buffer || !after.buffer
                    ? 'diffFrames: frames lack pixel data (dhash fallback)'
                    : 'diffFrames: not injected (dhash fallback)');
            }
        }
    }
    const obs = {
        tool,
        point: context?.point ?? null,
        beforeFrame: before,
        afterFrame: after,
        diff,
        dhashSimilarity: diff == null && before?.dhash && after?.dhash
            ? Math.round(similarity(before.dhash, after.dhash) * 1000) / 1000
            : null,
    };
    // 屏是否「显著变了」：① 的首中即断闸（屏显著变了 ⇒ ②③ 无从谈起）
    const screenChangedDecisively = !!diff && !diff.identical && diff.changed_fraction_pct >= RC_CHANGED_STRONG_PCT;
    // W1-6：屏是否「有任何重绘证据」（像素微变 / dhash 指纹分歧）—— ③ 冻结探针的
    // 前提闸：世界刚重绘过，「冻结」叙事自相矛盾（弱 ① 证据在场即跳过 ③，
    // ② 悬停不受此闸 —— 微变化可能是失败点击的悬停副作用，仍需鉴别盲点）。
    const screenRepainted = (!!diff && !diff.identical) ||
        (diff == null && obs.dhashSimilarity != null && obs.dhashSimilarity < RC_DHASH_UNCHANGED_SIM);
    // ── ② 悬停光标探针（屏没变 / 像素通道缺席时执行）──
    const point = context?.point ?? null;
    if (!screenChangedDecisively && point && budgetLeft() && typeof ports.probePoint === 'function') {
        const probe = await safe('probePoint', () => ports.probePoint(point));
        if (probe) {
            obs.hoverCursorKind = probe.cursorKind && probe.cursorKind !== 'n/a' ? probe.cursorKind : null;
            obs.hoverVerdict = probe.verdict ?? null;
        }
    }
    // ② 是否给出了决定性盲点证据（ibeam/hand/text —— 与纯函数判据同律）
    const blindSpotDecisive = obs.hoverCursorKind === 'ibeam' || obs.hoverCursorKind === 'hand' || obs.hoverVerdict === 'text';
    // ── ③ 连续帧冻结探针（② 缺席/弃权时执行）──
    const freezeSamples = Math.min(RC_MAX_FREEZE_SAMPLES, Math.max(1, Math.round(ports.freezeSamples ?? RC_DEFAULT_FREEZE_SAMPLES)));
    if (!screenChangedDecisively && !blindSpotDecisive && !screenRepainted && budgetLeft() && typeof ports.captureFrame === 'function') {
        const gap = Math.max(0, ports.freezeSampleGapMs ?? RC_DEFAULT_FREEZE_GAP_MS);
        const followups = [];
        for (let i = 0; i < freezeSamples; i++) {
            if (!budgetLeft()) {
                notes.push('budget exhausted during freeze probe');
                break;
            }
            if (gap > 0)
                await rcSleep(gap);
            const f = await safe('captureFrame', () => ports.captureFrame());
            followups.push(f?.dhash ?? null);
        }
        if (followups.length > 0)
            obs.followupDhashes = followups;
    }
    if (!budgetLeft())
        notes.push('budget exhausted');
    obs.degradedNotes = notes;
    return differentialDiagnose(obs);
}
/** W2-5：运行时枚举面（防御解析/序列化往返的合法值域 —— 与 ROOT_CAUSE_IDS 同律） */
export const RECOVERY_ACTION_IDS = [
    'zoom-refine', 'switch-modality', 're-observe',
    'ground-target', 'wait-settle', 'stop-ask-user',
];
/**
 * W2-5：防御解析 —— 任意值 → 合法动作（垃圾值 ⇒ null，不冒充知识）。
 * 疗效表持久化恢复与一切外部输入经此收口（与 parseRootCause 同律，但
 * 动作无「unknown 兜底」——错名即弃置，不入账）。
 */
export function parseRecoveryAction(v) {
    return typeof v === 'string' && RECOVERY_ACTION_IDS.includes(v)
        ? v
        : null;
}
/**
 * W2-5：冷启动梯子（固定缺省序）——「1 败教放大、2 败教换模态」。
 * circuitBreakerGuard 历史递进提示的名词化：疗效表对该 (症候×根因) 语境
 * 样本量不足（n < 5）时的缺省排序，行为等价于既有递进提示（零回归承诺）。
 */
export const RECOVERY_COLD_LADDER = ['zoom-refine', 'switch-modality'];
/**
 * W2-5：各根因的处方先验序（RC_HYPOTHESIS 的名词化）—— 疗效表动态排序的
 * 确定性平手序（tie-break）。值即边界：over-strict 先重观察（世界其实变了）、
 * blind-spot 先换模态（此路本不通）、stall 先等稳定（世界没在重绘）。
 */
export const ROOT_CAUSE_LADDER = {
    'over-strict-verification': ['re-observe', 'zoom-refine', 'switch-modality', 'ground-target', 'wait-settle', 'stop-ask-user'],
    'blind-spot-text': ['switch-modality', 'ground-target', 'zoom-refine', 're-observe', 'wait-settle', 'stop-ask-user'],
    'stall': ['wait-settle', 're-observe', 'switch-modality', 'zoom-refine', 'ground-target', 'stop-ask-user'],
    'unknown': ['zoom-refine', 'switch-modality', 're-observe', 'ground-target', 'wait-settle', 'stop-ask-user'],
};
/** W2-5：根因 → 处方先验序（防御：非法根因 ⇒ unknown 梯子 —— parseRootCause 律） */
export function recoveryLadderFor(rootCause) {
    return ROOT_CAUSE_LADDER[parseRootCause(rootCause)];
}
