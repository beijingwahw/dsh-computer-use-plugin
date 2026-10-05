// src/subAgent.arbitration.ts
// W9-3（D-F4 拆分·仲裁分区）：自 subAgent.ts 低风险提取 —— 裁决策略模式
// （Arbitration 契约 + ConfidenceWeightedArbitrator 缺省策略）+ W2-4 G4 实证
// 仲裁（验证使命铸造/锚定匹配/EvidenceBackedArbitrator）。逐字节搬运（零逻辑
// 变更）；subAgent.ts 原位再导出 —— 导入面不变（消费方零改动）。
import { embed, cosine } from './semanticHash.js';
// W2-4 G4：争点主题提取复用项目正典分词器（纯函数，零新依赖）
import { tokenize } from './uiMemory.js';
// ─── ΠΑΝ-120：共识阈值的经验基线定标（C1-3 M-7 清偿） ───
//
// 病灶：0.5 是无定标字面量 —— 同语言无关对（零假设）与同事实改写对（备择）
// 在本引擎 embed 空间的余弦分布从未量过，「同事实域天然越阈」是未经验证的
// 断言。实测（2026-10-04，semanticHash 双语桥 + tokenizeText 单源）：
//   零假设（同语言无关对，中英各半）：0.000 ~ 0.246，q90 ≈ 0.11
//   备择（同事实改写对，中英各半）：0.304 ~ 0.667，q10 ≈ 0.42
// 旧阈 0.5 把将近半数真共识对（0.304/0.467/0.491）误判 conflict；零假设侧
// 反而全部远离 0.5 —— 旧阈既漏真也放不了多少假，纯靠运气。
//
// 定标律：阈值 = (q90(零假设) + q10(备择)) / 2 —— ROC 操作点的分位数形式
// （零假设上尾与备择下尾的中点），夹 [0.2, 0.5]；语料退化（空/两分布倒挂）
// ⇒ 回退 0.5（旧值，保守侧）。语料是模块内静态双语 fixture（确定性），阈值
// 在首次调用时实测导出并记忆化 —— embed 微秒级，冷启动一次，之后零开销。
// 诚实边界：语料只覆盖「无关对 vs 改写对」两端；同域不同对象（两份不同的
// 定价调研）可能落进 (0.25, 0.45) 的灰区 —— 共识判定带此不确定性，语料
// 扩充是后续窗口的活（改语料即改阈值，无需改公式）。
/** ΠΑΝ-120：定标语料 —— 零假设对（同语言、不同事实域的典型代理报告） */
const CALIBRATION_NULL_PAIRS = [
    ['打开浏览器导航到新闻网站浏览头条', '在 Excel 中筛选数据并保存报表'],
    ['检查系统托盘的更新通知', '整理桌面文件并重命名为日期格式'],
    ['在聊天窗口输入用户名和密码', '调整显示器亮度和对比度'],
    ['下载附件并保存到下载文件夹', '关闭所有后台运行的程序'],
    ['搜索最近的意大利餐厅', '配置防火墙规则阻止端口访问'],
    ['open the browser and read the news headlines', 'filter data in a spreadsheet and save the report'],
    ['check the system tray for update notifications', 'rename desktop files with date prefixes'],
    ['enter username and password in the chat window', 'adjust display brightness and contrast'],
    ['download the attachment to the downloads folder', 'terminate all background processes'],
    ['search for nearby italian restaurants', 'configure firewall rules to block ports'],
];
/** ΠΑΝ-120：定标语料 —— 备择对（同一事实的两种转述 = 真共识的形态） */
const CALIBRATION_POSITIVE_PAIRS = [
    ['竞品 A 定价 10 美元每月，功能包含数据筛选', '竞品 A 定价 10 美元每月，支持筛选和导出数据'],
    ['该按钮点击后弹出了确认对话框', '点击按钮后出现了一个确认弹窗'],
    ['页面加载完成，标题栏显示登录成功', '登录成功后页面完成加载，标题栏已更新'],
    ['表格导出为 CSV 文件已完成', '导出表格到 CSV 的任务已结束'],
    ['the pricing table shows ten dollars per month', 'pricing is 10 USD per month in the table'],
    ['a confirmation dialog appeared after the click', 'clicking produced a confirmation popup'],
    ['the page finished loading and shows logged in', 'login succeeded and the page load completed'],
    ['exporting the table to CSV finished', 'the CSV export task for the table is done'],
];
/** ΠΑΝ-120：线性插值分位数（空数组 ⇒ NaN —— 调用方守卫） */
function quantile(sorted, q) {
    if (sorted.length === 0)
        return Number.NaN;
    const idx = q * (sorted.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi)
        return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
/** ΠΑΝ-120：导出定标语料（只读）—— 执法测试直接复算分布与阈值 */
export const ARBITRATION_CALIBRATION = {
    nullPairs: CALIBRATION_NULL_PAIRS,
    positivePairs: CALIBRATION_POSITIVE_PAIRS,
};
/** ΠΑΝ-120：旧阈字面量（退化回退值 —— 保守侧的缺省） */
const CONSENSUS_THRESHOLD_FALLBACK = 0.5;
let calibratedThresholdMemo = null;
/**
 * ΠΑΝ-120：共识阈值的经验导出（纯函数 + 模块级记忆化，确定性）。
 * 阈值 = (q90(零假设) + q10(备择)) / 2，夹 [0.2, 0.5]；分布倒挂/空语料 ⇒
 * 回退 0.5。同语料同 embed ⇒ 恒同输出（FNV 确定性，无随机无时钟）。
 */
export function calibratedConsensusThreshold() {
    if (calibratedThresholdMemo !== null)
        return calibratedThresholdMemo;
    const nulls = CALIBRATION_NULL_PAIRS.map(([a, b]) => cosine(embed(a), embed(b))).sort((x, y) => x - y);
    const positives = CALIBRATION_POSITIVE_PAIRS.map(([a, b]) => cosine(embed(a), embed(b))).sort((x, y) => x - y);
    const q90null = quantile(nulls, 0.9), q10pos = quantile(positives, 0.1);
    let t = CONSENSUS_THRESHOLD_FALLBACK;
    if (Number.isFinite(q90null) && Number.isFinite(q10pos) && q10pos > q90null) {
        t = Math.max(0.2, Math.min(0.5, (q90null + q10pos) / 2));
    }
    calibratedThresholdMemo = Math.round(t * 1000) / 1000;
    return calibratedThresholdMemo;
}
/**
 * 缺省策略：置信度 × 同侪一致性加权。
 * ΠΑΝ-120：consensus 阈值不再是无定标的 0.5 字面量 —— 由静态双语定标语料
 * 实测导出（calibratedConsensusThreshold：q90(零假设)/q10(备择) 的 ROC 中点，
 * 实测 ≈0.26）。跨语种真共识（中文报告 vs 英文报告，双语桥未覆盖词表外）
 * 余弦仍近 0 ⇒ conflict —— 已知诚实边界，语料扩容是后续窗口决策。
 * 冲突评分的平票裁决：score 全等 ⇒ 按输入序（先报告者优先 —— V8 sort 稳定
 * + 显式 taskId 字典序兜底），确定性立法。
 */
export class ConfidenceWeightedArbitrator {
    name = 'confidence-weighted';
    async arbitrate(reports) {
        if (reports.length === 0) {
            return { verdict: 'best_single', crossValidation: [], rationale: 'no reports submitted' };
        }
        if (reports.length === 1) {
            return {
                verdict: 'best_single', winner: reports[0].taskId, crossValidation: [],
                rationale: `single reporter (${reports[0].taskId}, confidence ${reports[0].confidence})`,
            };
        }
        // 两两交叉验证：findings 语义余弦（零依赖子词哈希，微秒级）
        const crossValidation = [];
        for (let i = 0; i < reports.length; i++) {
            for (let j = i + 1; j < reports.length; j++) {
                const agreement = Math.round(cosine(embed(reports[i].findings), embed(reports[j].findings)) * 1000) / 1000;
                crossValidation.push({ pair: [reports[i].taskId, reports[j].taskId], agreement });
            }
        }
        const minAgreement = Math.min(...crossValidation.map(c => c.agreement));
        // ΠΑΝ-120：阈值经语料定标（旧 0.5 把实测 0.30~0.49 的真共识对误判冲突）
        const threshold = calibratedConsensusThreshold();
        if (minAgreement >= threshold) {
            return {
                verdict: 'consensus', crossValidation,
                rationale: `all pairwise semantic agreements >= ${threshold} calibrated ` +
                    `(min ${minAgreement}; threshold = ROC midpoint of bilingual calibration corpus)`,
            };
        }
        // 冲突：综合分 = 置信 0.6 + 与他者的平均一致性 0.4 —— 高置信但众叛亲离者不胜出
        // ΠΑΝ-120：score 平票 ⇒ taskId 字典序显式兜底（不再依赖排序稳定性隐式成立）
        const scored = reports
            .map(r => {
            const pairs = crossValidation.filter(c => c.pair.includes(r.taskId));
            const meanPeer = pairs.length
                ? pairs.reduce((n, p) => n + p.agreement, 0) / pairs.length : 0.5;
            return { r, score: r.confidence * 0.6 + meanPeer * 0.4 };
        })
            .sort((a, b) => b.score - a.score ||
            (a.r.taskId < b.r.taskId ? -1 : a.r.taskId > b.r.taskId ? 1 : 0));
        const best = scored[0];
        return {
            verdict: 'conflict', winner: best.r.taskId, crossValidation,
            rationale: `findings diverge (min agreement ${minAgreement}); winner by confidence×peer-agreement: ` +
                `${best.r.taskId} (score ${best.score.toFixed(2)})`,
        };
    }
}
/**
 * W2-4 G4：锚定匹配的最低采信分。ΠΑΝ-120：语义面 = max(余弦, 遏制) ——
 * 长度归一化后 0.5 对「标签语义半数以上在声明中在场」采信，泛标签
 * （'button' 类，实测遏制 0.25）仍被拒 —— 阈值语义与 consensus 定标
 * 阈值分域（锚定是不对称覆盖度量，不随语料定标漂移）。
 */
const EVIDENCE_MATCH_MIN = 0.5;
/** W2-4 G4：区域 bbox 的 IoU（elementTracker.iou 风格，归一化坐标域；纯函数） */
export function anchorIoU(a, b) {
    const x0 = Math.max(a.x0, b.x0), y0 = Math.max(a.y0, b.y0);
    const x1 = Math.min(a.x1, b.x1), y1 = Math.min(a.y1, b.y1);
    const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
    const areaA = Math.max(0, a.x1 - a.x0) * Math.max(0, a.y1 - a.y0);
    const areaB = Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
    const union = areaA + areaB - inter;
    return union > 0 ? inter / union : 0;
}
/**
 * ΠΑΝ-120：不对称遏制度量 containment(short, long) = 共享桶质量 / short 的
 * 全质量 —— 「短向量的语义内容被长向量覆盖的比例」。近重复检测的经典容器
 * 度量（containment / Jaccard 的不对称版），对长度失衡鲁棒：短标签的全部
 * n-gram 都出现在长文本里 ⇒ ≈1，而对称余弦被 ‖short‖/‖long‖ 结构性压低
 * （实测 'pricing-table' vs 长声明：余弦 0.338 / 遏制 1.000）。
 * 纯函数、零新依赖（与 cosine 同一双指针合并）。
 */
function containment(short, longV) {
    if (short.dims.length === 0 || longV.dims.length === 0 || short.norm === 0)
        return 0;
    let dot = 0;
    let i = 0, j = 0;
    while (i < short.dims.length && j < longV.dims.length) {
        const [ba, wa] = short.dims[i];
        const [bb, wb] = longV.dims[j];
        if (ba === bb) {
            dot += wa * wb;
            i++;
            j++;
        }
        else if (ba < bb)
            i++;
        else
            j++;
    }
    let shortMass = 0;
    for (const [, w] of short.dims)
        shortMass += w * w;
    return shortMass > 0 ? Math.min(1, dot / shortMass) : 0;
}
/**
 * W2-4 G4：语义锚定匹配（缺省 matchClaim，semanticHash 风格 —— 零依赖离线）。
 * ΠΑΝ-120（长度归一化修复）：声明文本（长）与证据区域标签（短）的**对称
 * 余弦**受长度失衡强压低 —— 证据臂在真实几何下常年 <0.5 而「诚实降级」，
 * 硬证据压倒置信分的执法面从未真正触发（C1-3 M-7 的第二半）。修复：每区域
 * 取 max(余弦, 遏制度量) —— 标签语义在声明中的覆盖度直接入分；再取最强
 * 区域。无区域 ⇒ null（证据不适用）。诚实边界：单词泛标签（'button'）的
 * n-gram 可能巧合命中长文本（实测 0.25 —— 低于采信阈，但非零），锚定分
 * 的消费方（EVIDENCE_MATCH_MIN 0.5）保持对泛标签的抵抗力。
 */
export function semanticAnchorMatch(claim, evidence) {
    if (!evidence || !Array.isArray(evidence.regions) || evidence.regions.length === 0)
        return null;
    const v = embed(claim.text);
    let best = 0;
    for (const r of evidence.regions) {
        const labelVec = embed(typeof r?.label === 'string' ? r.label : '');
        // ΠΑΝ-120：对称余弦 OR 不对称遏制（长度归一化）—— 长度失衡不再压低锚定
        const s = Math.max(cosine(v, labelVec), containment(labelVec, v));
        if (s > best)
            best = s;
    }
    return Math.round(best * 1000) / 1000;
}
/**
 * W2-4 G4：几何锚定匹配（visualDiff/elementTracker 风格）：声明自带期望 bbox 时
 * 与证据区域做 IoU 锚定（elementTracker 的贪心匹配同款判据），取最强区域；
 * 声明无几何锚 ⇒ null（诚实：证据不适用，不猜）。
 */
export function geometricAnchorMatch(claim, evidence) {
    if (!claim.bbox || !evidence || !Array.isArray(evidence.regions) || evidence.regions.length === 0)
        return null;
    let best = 0;
    for (const r of evidence.regions) {
        if (!r?.bbox)
            continue;
        const s = anchorIoU(claim.bbox, r.bbox);
        if (s > best)
            best = s;
    }
    return Math.round(best * 1000) / 1000;
}
/** W2-4 G4：基础分复刻（ConfidenceWeightedArbitrator 的冲突公式 —— 置信 0.6 + 同侪 0.4） */
function baseScore(r, base) {
    const pairs = base.crossValidation.filter(c => c.pair.includes(r.taskId));
    const meanPeer = pairs.length
        ? pairs.reduce((n, p) => n + p.agreement, 0) / pairs.length : 0.5;
    return r.confidence * 0.6 + meanPeer * 0.4;
}
/** W2-4 G4：共享词提取（纯函数，正典分词器；len≥2 过滤 CJK 单字噪声） */
function sharedTokens(a, b) {
    const setB = new Set(tokenize(b));
    const seen = new Set();
    const out = [];
    for (const t of tokenize(a)) {
        if (t.length >= 2 && setB.has(t) && !seen.has(t)) {
            seen.add(t);
            out.push(t);
        }
    }
    return out;
}
/**
 * W2-4 G4：冲突使命铸造（纯函数、确定性）：争点主题 = 前二候选（按基础分）
 * findings 的共享词（≤6 个）；无共享词 ⇒ 分高者 findings 摘要。同输入恒同输出。
 */
export function mintVerifierMission(reports, base) {
    const ranked = [...reports].sort((a, b) => baseScore(b, base) - baseScore(a, base) || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
    const top2 = ranked.slice(0, 2);
    const shared = sharedTokens(top2[0]?.findings ?? '', top2[1]?.findings ?? '');
    const subject = shared.length > 0
        ? shared.slice(0, 6).join(' ')
        : (top2[0]?.findings ?? '').slice(0, 60);
    return {
        subject,
        objective: `在当前屏寻找「${subject}」的证据并引用区域（每个区域给 label + 归一化 bbox），` +
            `以裁决候选分歧 [${ranked.map(r => r.taskId).join(' vs ')}]`,
        candidates: ranked.map(r => r.taskId),
    };
}
/**
 * W2-4 G4：实证仲裁策略（实现 ArbitrationStrategy，可热插拔）。
 * 行为阶梯（全部确定性、防御式绝不抛）：
 *   ① 端口缺席 / 基础裁决非 conflict ⇒ 逐字节返回 ConfidenceWeightedArbitrator 结果。
 *   ② 有端口无证据（runVerifier 缺席/返回空/抛异常）⇒ 判决与胜者保持缺省行为，
 *      归因注明诚实降级。
 *   ③ 有证据：各候选锚定匹配 ≥0.5 者进入硬证据域 —— 证据分压倒置信分定胜者
 *      （平分按基础分、再平按 taskId 字典序 —— 全序确定）；verdict='adjudicated'
 *      并附证据归因。无候选达阈 ⇒ 同 ② 降级。
 */
export class EvidenceBackedArbitrator {
    name = 'evidence-backed';
    base = new ConfidenceWeightedArbitrator();
    port;
    constructor(port) {
        this.port = port; // 显式赋值：strip-only 模式不支持 constructor 参数属性
    }
    async arbitrate(reports) {
        const base = await this.base.arbitrate(reports);
        // 诚实降级 ①：端口缺席或非冲突 —— 与缺省策略逐字节同行为（零影响）
        if (!this.port || typeof this.port.runVerifier !== 'function' || base.verdict !== 'conflict') {
            return base;
        }
        const mission = mintVerifierMission(reports, base);
        let evidence = null;
        try {
            const filed = this.port.runVerifier(mission);
            evidence = filed && typeof filed === 'object' ? filed : null;
        }
        catch {
            evidence = null; // 防御式绝不抛：端口炸了按证据缺席处理
        }
        const noEvidence = !evidence || !Array.isArray(evidence.regions) || evidence.regions.length === 0;
        if (noEvidence) {
            return { ...base, rationale: base.rationale +
                    ' | evidence-backed: no verifier evidence filed — confidence-weighted fallback (honest degradation)' };
        }
        const matchFn = typeof this.port.matchClaim === 'function' ? this.port.matchClaim : semanticAnchorMatch;
        const perCandidate = reports.map(r => {
            let m = null;
            try {
                m = matchFn({ taskId: r.taskId, text: r.findings }, evidence);
            }
            catch {
                m = null; // 单候选比对失败不拖垮整场裁决
            }
            return {
                taskId: r.taskId,
                match: m === null || !Number.isFinite(m) ? null : Math.max(0, Math.min(1, m)),
            };
        });
        const supported = perCandidate
            .filter(s => s.match !== null && s.match >= EVIDENCE_MATCH_MIN)
            .sort((a, b) => (b.match - a.match) ||
            baseScore(reports.find(r => r.taskId === b.taskId), base) -
                baseScore(reports.find(r => r.taskId === a.taskId), base) ||
            (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
        if (supported.length === 0) {
            return { ...base, rationale: base.rationale +
                    ` | evidence-backed: no candidate anchored to verifier evidence (all matches < ${EVIDENCE_MATCH_MIN}) — confidence-weighted fallback` };
        }
        const winner = supported[0];
        const ev = evidence;
        return {
            verdict: 'adjudicated',
            winner: winner.taskId,
            crossValidation: base.crossValidation,
            rationale: `hard evidence overrides confidence: verifier "${ev.taskId}" cited ` +
                `${ev.regions.length} region(s) [${ev.regions.map(r => r?.label ?? '?').slice(0, 4).join(', ')}]; ` +
                `best anchored candidate ${winner.taskId} (match ${winner.match.toFixed(2)}) beats ` +
                `confidence ranking winner ${base.winner ?? 'n/a'}`,
            evidence: {
                verifier: ev.taskId,
                mission: mission.objective,
                perCandidate,
                regions: ev.regions.map(r => ({
                    label: typeof r?.label === 'string' ? r.label : '',
                    bbox: { x0: r.bbox.x0, y0: r.bbox.y0, x1: r.bbox.x1, y1: r.bbox.y1 },
                })),
            },
        };
    }
}
