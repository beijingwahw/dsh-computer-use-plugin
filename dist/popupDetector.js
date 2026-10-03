// src/popupDetector.ts
// 弹窗双模检测：几何启发式 + 语义证据（B-8）。
// 几何：模态弹窗通常在屏幕中央形成一块「更亮、更均匀（低方差）」的面板 —— 对无文字
//       或非拉丁文字的弹窗依然有效，但有误报（任何亮色居中布局都会命中）。
// 语义：弹窗文案有极强的词族特征（cookie/accept/订阅/update…）。OCR 中央区域，
//       命中词表任一词即确认。与几何互补：横幅类弹窗（顶部条）几何必漏、语义能抓。
// 融合判据：geometric OR semantic —— 弹窗检测的使命是宁可误报拦截，不可漏报放行
// （popupGuard 拦截后模型只需多看一眼截图，代价有界；漏报则盲操作直接失败）。
//
// 测量双路径（本轮接线）：D-5 帧环统计（frame_stats）优先；sharp buffer 保留。
import { getSharp } from './_legacyDeps.js';
import { readTextAny } from './textReader.js';
import * as backend from './physicalBackend.js';
import { kernelRegistry } from './kernel/registry.js';
function avg(nums) {
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}
/** 中央区域裁剪框（几何与语义共用同一「弹窗栖息地」假设） */
function centerRegionNorm(fraction = 0.4) {
    const inset = (1 - fraction) / 2;
    return { x: inset, y: inset, width: fraction, height: fraction };
}
function centerRegion(w, h, fraction = 0.4) {
    const r = centerRegionNorm(fraction);
    return {
        left: Math.round(r.x * w),
        top: Math.round(r.y * h),
        width: Math.round(r.width * w),
        height: Math.round(r.height * h),
    };
}
/**
 * 几何启发式（双路径）：
 *   frameId → 服务端帧环统计（中心 40% vs 全图）
 *   buffer + sharp → 本地统计（legacy/开发路径）
 * 失败返回 false —— 检测失败不应阻断截图主流程：宁可漏报，不可误杀。
 * 纪元 Ξ（Ξ-D 生产接线）：几何比双份读内核注册表 —— popup.geoLow（中心
 * 标准差比上限，缺省 0.55）/ popup.geoHigh（中心亮度比下限，缺省 1.15），
 * 服务端与 legacy 两条路径同键同步。未注册 ⇒ getOrDefault 回声字面量，
 * 几何判决逐字节不变；每次检测单次读取。
 */
function popupGeoRatios() {
    return {
        geoLow: kernelRegistry.getOrDefault('popup.geoLow', 0.55),
        geoHigh: kernelRegistry.getOrDefault('popup.geoHigh', 1.15),
    };
}
export async function detectPopupHeuristic(frameId, buffer) {
    try {
        if (frameId != null) {
            const [global, center] = await Promise.all([
                backend.frameStats(frameId, []),
                backend.frameStats(frameId, [centerRegionNorm()]),
            ]);
            const g = global[0], c = center[0];
            if (!g || !c || g.mean == null || c.mean == null)
                return false;
            const gStd = g.stdev ?? 0, cStd = c.stdev ?? 0;
            const { geoLow, geoHigh } = popupGeoRatios();
            return cStd < gStd * geoLow && c.mean > g.mean * geoHigh;
        }
        if (!buffer || buffer.length === 0)
            return false;
        const sharp = await getSharp();
        const meta = await sharp(buffer).metadata();
        const w = meta.width;
        const h = meta.height;
        const region = centerRegion(w, h);
        const [globalStats, centerStats] = await Promise.all([
            sharp(buffer).stats(),
            sharp(buffer).extract(region).stats(),
        ]);
        const gStd = avg(globalStats.channels.map((c) => c.stdev));
        const cStd = avg(centerStats.channels.map((c) => c.stdev));
        const gMean = avg(globalStats.channels.map((c) => c.mean));
        const cMean = avg(centerStats.channels.map((c) => c.mean));
        const { geoLow, geoHigh } = popupGeoRatios();
        return cStd < gStd * geoLow && cMean > gMean * geoHigh;
    }
    catch {
        return false;
    }
}
// ─── F-3 贝叶斯弹窗信念（第六维·压缩认知）：Schmitt 迟滞滤波 ───
//
// 问题：旧判定是逐帧布尔（geometric OR semantic）—— 弹窗边缘的传感器抖动
// （隔帧误检/漏检一帧）直接传导给 popupGuard，守卫在拦截/放行间震荡。
//
// 数学：对数几率（log-odds）贝叶斯更新 + 施密特触发器双阈值迟滞：
//   belief ⇄ logit；单帧证据 = 似然比的 nats（geometric +4.0 / semantic +5.0 /
//   双清洁 −1.5 —— 单帧强证据仍立即触发 ON（与旧行为一致），但单帧清洁
//   不再立即放行：须累积至 OFF 线）。先验 0.05（世界大多数时刻没有弹窗）。
//   迟滞带 [0.35, 0.6]：进入需 ≥0.6，退出需 ≤0.35 —— 一帧噪声不再翻转状态。
// 诚实边界：证据强度是算法形状字面量（「几何启发式比 OCR 词证弱」的先验序），
// epochF.test 守护三态行为：单帧触发 / 迟滞保持 / 双清洁退出。
const POPUP_PRIOR = 0.05;
const LOGIT = (p) => Math.log(p / (1 - p));
const SIGMOID = (x) => 1 / (1 + Math.exp(-x));
const EVIDENCE_GEO = 4.0; // 几何证据强度（nats）—— 单帧几何 ⇒ 后验 ≈0.98（立即 ON）
const EVIDENCE_SEM = 5.0; // 语义证据更强（词表命中是确定性更强的信号）
const EVIDENCE_CLEAN = -1.5; // 清洁帧证据 —— 单帧清洁把 ON 态拉入迟滞带但不放行
const ON_THRESHOLD = 0.6;
const OFF_THRESHOLD = 0.35;
/**
 * 施密特全套内核读点（Ξ-D 生产接线）+ 结构序守护。
 *
 * 键域（未注册 ⇒ getOrDefault 回声字面量，行为逐字节不变）：
 *   · popup.priorWeight（先验，缺省 0.05）—— 构造/reset 时读；
 *   · popup.evidenceGeo / popup.evidenceSem / popup.evidenceClean（证据强度
 *     nats，缺省 4.0 / 5.0 / −1.5）—— 每次 update 读；
 *   · popup.onThreshold / popup.offThreshold（迟滞双阈，缺省 0.6 / 0.35）
 *     —— 每次 update 读。
 *
 * 结构序守护（越序值就地兜序，绝不产生病态滤波器）：
 *   · 迟滞带必须非负宽：off ≤ on —— specs 层 off 区间 (0.1..0.5) 与 on 区间
 *     (0.55..0.9) 本不交叠，消费处再 Math.min(off, on) 兜底（未来 specs 被
 *     改到交叠也不许 off 压过 on —— 施密特退化为逐帧抖动是结构崩坏，非旋钮）；
 *   · 证据强度先验序：sem ≥ geo（词表命中强于几何启发式是模块立法）——
 *     specs 层 geo 上限 6 = sem 下限 6，消费处再 Math.max(sem, geo) 兜底。
 */
function schmittKernelReads() {
    const evidenceGeo = kernelRegistry.getOrDefault('popup.evidenceGeo', EVIDENCE_GEO);
    return {
        evidenceGeo,
        evidenceSem: Math.max(evidenceGeo, kernelRegistry.getOrDefault('popup.evidenceSem', EVIDENCE_SEM)),
        evidenceClean: kernelRegistry.getOrDefault('popup.evidenceClean', EVIDENCE_CLEAN),
        onThreshold: kernelRegistry.getOrDefault('popup.onThreshold', ON_THRESHOLD),
        offThreshold: Math.min(kernelRegistry.getOrDefault('popup.offThreshold', OFF_THRESHOLD), kernelRegistry.getOrDefault('popup.onThreshold', ON_THRESHOLD)),
    };
}
/** 施密特弹窗滤波器（纯类 —— 可注入任意帧序列，测试的确定性事实源） */
export class SchmittPopupFilter {
    logOdds = LOGIT(kernelRegistry.getOrDefault('popup.priorWeight', POPUP_PRIOR));
    active = false;
    /** 单帧更新：返回滤波后的信念与迟滞态 */
    update(ev) {
        // Ξ-D：证据强度与迟滞双阈每次 update 读内核表（set 即时生效；序守护见上注）
        const { evidenceGeo, evidenceSem, evidenceClean, onThreshold, offThreshold } = schmittKernelReads();
        const strength = ev.semantic ? evidenceSem : ev.geometric ? evidenceGeo : evidenceClean;
        this.logOdds += strength;
        const belief = SIGMOID(this.logOdds);
        // 施密特触发：进入需越 ON 线，退出需跌破 OFF 线 —— 迟滞带内保持原态
        if (!this.active && belief >= onThreshold)
            this.active = true;
        else if (this.active && belief <= offThreshold)
            this.active = false;
        return { belief: Math.round(belief * 1000) / 1000, active: this.active };
    }
    reset() {
        this.logOdds = LOGIT(kernelRegistry.getOrDefault('popup.priorWeight', POPUP_PRIOR));
        this.active = false;
    }
}
/** 模块级滤波器单例（take_screenshot 每帧喂数；插件卸载经 resetPopupBelief 归零） */
const popupFilter = new SchmittPopupFilter();
export function resetPopupBelief() {
    popupFilter.reset();
}
/**
 * 语义证据：OCR 中央带，词表命中任一即确认。
 * 双路径：服务端 L2 OCR（readTextAny 截屏+识别一体）→ legacy buffer+sharp。
 * 失败（OCR 不可用/超时/无语言包）静默返回空 —— 几何证据独立生效，行为零回归。
 */
async function detectPopupSemantic(frameId, buffer, keywords, ocrLang) {
    if (keywords.length === 0)
        return [];
    try {
        let text = null;
        try {
            const r = await readTextAny(centerRegionNorm(0.6), ocrLang);
            text = r.text;
        }
        catch {
            text = null;
        }
        if (text == null && buffer && buffer.length > 0) {
            const sharp = await getSharp();
            const meta = await sharp(buffer).metadata();
            const w = meta.width, h = meta.height;
            if (w < 32 || h < 32)
                return [];
            const crop = await sharp(buffer)
                .extract(centerRegion(w, h, 0.6))
                .resize(1200)
                .toBuffer();
            const { readText } = await import('./textReader.js');
            text = (await readText(crop, ocrLang)).text;
        }
        if (text == null)
            return [];
        void frameId; // frameId 语义通道由服务端截屏覆盖（readTextAny 服务端自截）
        const hay = text.toLowerCase();
        const matched = [];
        for (const kw of keywords) {
            if (hay.includes(kw))
                matched.push(kw);
            if (matched.length >= 3)
                break; // 证据上限：锚点不因词表膨胀
        }
        return matched;
    }
    catch {
        return [];
    }
}
/** 双模融合检测 + F-3 贝叶斯迟滞滤波：take_screenshot 的唯一传感入口 */
export async function detectPopup(buffer, opts = {}, frameId = null) {
    const geometric = await detectPopupHeuristic(frameId, buffer);
    const keywords = (opts.popupKeywords ?? '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
    const matchedKeywords = opts.enableOcr && keywords.length > 0
        ? await detectPopupSemantic(frameId, buffer, keywords, opts.ocrLang || 'eng')
        : [];
    // F-3：帧证据喂入施密特滤波 —— 单帧强证据立即 ON（旧行为），单帧噪声不再翻转
    const { belief, active } = popupFilter.update({
        geometric,
        semantic: matchedKeywords.length > 0,
    });
    // Q 纪元（Q-3）：同一帧证据并行喂 SPRT（旁路 —— 信息论最优停止的第二意见）
    popupSprt.update({ geometric, semantic: matchedKeywords.length > 0 });
    return {
        popup: active,
        geometric,
        semantic: matchedKeywords.length > 0,
        matchedKeywords,
        belief,
    };
}
/** SPRT 弹窗判决器（纯类 —— 可注入任意帧序列，测试的确定性事实源） */
export class SprtPopupFilter {
    llr = 0;
    frames = 0;
    decided = null;
    // P 纪元注记：构造器参数属性（public readonly x = v）是 transform 语法 ——
    // Node strip-only 拒载（J 纪元"类型即值地雷"同族）；改显式字段 + 赋值。
    alpha;
    beta;
    constructor(alpha = 0.05, beta = 0.05) {
        this.alpha = alpha;
        this.beta = beta;
    }
    get acceptBound() {
        return Math.log((1 - this.beta) / this.alpha);
    }
    /** Wald 下界 B = ln(β/(1−α))：仅在 α=β 时与 −A 重合（旧实现 −A 在非对称
     *  (α, β) 下把 H₀ 停止线收窄 —— 判 clean 需要更多帧） */
    get rejectBound() {
        return Math.log(this.beta / (1 - this.alpha));
    }
    /** 单帧更新：返回判决（终判后恒返回原判 —— SPRT 停止语义） */
    update(ev) {
        if (this.decided)
            return this.state();
        // 帧似然比：语义 > 几何（证据强度序与 F-3 同律）；双缺席 = 清洁证据
        if (ev.semantic)
            this.llr += Math.log(0.90 / 0.02);
        else if (ev.geometric)
            this.llr += Math.log(0.70 / 0.20);
        else
            this.llr += Math.log(0.08 / 0.85);
        this.frames += 1;
        if (this.llr >= this.acceptBound)
            this.decided = 'popup';
        else if (this.llr <= this.rejectBound)
            this.decided = 'clean';
        return this.state();
    }
    state() {
        return {
            decision: this.decided,
            logLikelihoodRatio: Math.round(this.llr * 1000) / 1000,
            frames: this.frames,
            bounds: {
                accept: Math.round(this.acceptBound * 1000) / 1000,
                reject: Math.round(this.rejectBound * 1000) / 1000,
            },
        };
    }
    reset() {
        this.llr = 0;
        this.frames = 0;
        this.decided = null;
    }
}
/** 模块级 SPRT 单例（与 Schmitt 单例同喂数同生命周期） */
const popupSprt = new SprtPopupFilter();
export function resetPopupSprt() {
    popupSprt.reset();
}
/** SPRT 当前判决（终判锁定；null = 继续观察） */
export function getPopupSprt() {
    return popupSprt.state();
}
// ─── W2-2（S3）：派发前接地新鲜度探针（grounding freshness probe） ───
//
// 问题：危险点击（审批域）的坐标来自**接地时刻**的截图 —— 从截图到派发之间
// 隔着审批人机往返（分钟级），屏幕可能已发生相变（弹窗关闭/页面跳转/对话框
// 弹出）。对不可逆动作派发一组对着旧世界定位的坐标，是 stale-grounding 事故
// 的标准形态。
//
// 探针形态：派发前（approval.beginAttempt 之前）抓一帧低分辨率快图（经注入
// 端口 —— 生产默认端口 = D-5 metaOnly 服务端往返 + contextManager 的最近
// 截图指纹；测试注入假端口），与接地时截图的感知哈希（dHash）比对：
//   similarity ≥ 阈值 ⇒ fresh（放行派发）；
//   similarity < 阈值 ⇒ drifted（阻断本次派发 —— 返回「需重新截图定位」的
//     结构化结果供上层重感知；令牌未被烧：阻断在 beginAttempt/预留之前）；
//   端口缺席 / 取帧失败 / 指纹缺席 ⇒ degraded（放行 + 注记 —— fail-open）。
//
// fail-open 论证（与 S4 WAL 的 fail-closed 刻意不对称）：
//   · 本探针是**叠加防御**（defense in depth）—— 危险点击已过审批域令牌核验、
//     Ρ 纪元双钥公证（落点 OCR 实读 + 白盒控件名）、Β 纪元反驳法院，事后还有
//     V 纪元验收式消费兜底。叠加层失败时阻断全部危险点击，等于把增强层的
//     故障下沉为整个危险动作面的可用性故障 —— 风险收益倒挂。
//   · S4 审计则相反：审计是**不可抵赖性的地基**，没有审计行的动作从制度上
//     不该存在 —— 那是契约违反，必须 fail-closed。
//   · 降级不静默：degraded 判决随工具结果 state_anchor 透明化（模型/用户/
//     遥测可见），观测义务与可用性并存。
//   · 端口缺席是默认态（组合根接线前 / 离线测试），缺省放行保证既有行为
//     零回归（与 notaryEvidence「通道在场才收紧」同律）。
import { normalizeHash, similarity } from './perceptualHash.js';
let freshnessPort = null;
/** 安装/卸载新鲜度探针端口（null 卸载 ⇒ 探针缺席降级）。 */
export function setFreshnessPort(port) {
    freshnessPort = port;
}
/** 探针端口是否在场（测试与可观测性） */
export function freshnessPortInstalled() {
    return freshnessPort !== null;
}
/**
 * 漂移阈值：算法形状字面量。dHash 64 位下 0.85 ≈ 容忍 ~9.6 位翻转 ——
 * 光标移动/闪烁/滚动条微动的常见噪声（≤3-4 位）充分放行，而菜单开合/对话框
 * 弹出/页面跳变（通常 >15 位）稳定拦截；与 from_memory_id 预验的 0.85 同律
 * （同一「外观还像吗」问题的同一容差带）。
 */
export const GROUNDING_FRESHNESS_THRESHOLD = 0.85;
/** W2-2（S3）：派发前接地新鲜度探针（单发、绝不抛 —— 任何失败 ⇒ degraded）。 */
export async function probeGroundingFreshness(threshold = GROUNDING_FRESHNESS_THRESHOLD) {
    const tp = Math.round(threshold * 1000) / 10;
    try {
        if (!freshnessPort)
            return { verdict: 'degraded', threshold_pct: tp, note: 'probe-port-absent' };
        const grounding = freshnessPort.groundingHash();
        if (!grounding) {
            return { verdict: 'degraded', threshold_pct: tp, note: 'grounding-fingerprint-absent' };
        }
        const current = await freshnessPort.captureCurrentHash();
        if (!current) {
            return { verdict: 'degraded', threshold_pct: tp, note: 'current-capture-unavailable' };
        }
        const sim = similarity(normalizeHash(grounding), normalizeHash(current));
        const pct = Math.round(sim * 1000) / 10;
        return sim >= threshold
            ? { verdict: 'fresh', similarity_pct: pct, threshold_pct: tp }
            : { verdict: 'drifted', similarity_pct: pct, threshold_pct: tp };
    }
    catch (e) {
        // 旁路宪法：探针自身故障 = 通道缺席（fail-open + 观测），绝不炸派发主流程
        return { verdict: 'degraded', threshold_pct: tp, note: `probe-error:${String(e?.message ?? e).slice(0, 80)}` };
    }
}
/** 测试隔离缝：卸载探针端口（恢复缺省降级面） */
export function resetFreshnessProbe() {
    freshnessPort = null;
}
/**
 * 生产默认端口工厂（组合根接线用 —— `setFreshnessPort(defaultFreshnessPort())`）：
 *   groundingHash = contextManager 最近截图指纹（take_screenshot 落锚的 dHash，
 *                   即模型定位坐标时所依据的那一帧）；
 *   captureCurrentHash = physicalBackend metaOnly 采集（服务端一次低清往返，
 *                   零叠加层、零孵化 —— 与 D-5 在场判定同律：后端缺席 ⇒ 抛出
 *                   ⇒ 被探针捕获为 degraded，绝不触发服务孵化）。
 * 惰性动态导入：模块加载图零变化（popupDetector 的既有消费方不背新边）。
 */
export function defaultFreshnessPort() {
    // 惰性解析 contextManager 单例：端口创建时启动解析（promise 缓存后零开销），
    // 解析完成前的 groundingHash 调用诚实缺席（null ⇒ degraded，不阻塞派发）
    let cmRef = null;
    void import('./contextManager.js')
        .then(m => { cmRef = m.contextManager; })
        .catch(() => { });
    return {
        groundingHash() {
            try {
                return cmRef?.lastImageRecord()?.hash ?? null;
            }
            catch {
                return null;
            }
        },
        async captureCurrentHash() {
            const backend = await import('./physicalBackend.js');
            const cap = await backend.captureProcessed({ metaOnly: true });
            return cap.dhash ?? null;
        },
    };
}
