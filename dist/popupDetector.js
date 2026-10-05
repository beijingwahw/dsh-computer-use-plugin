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
// ΝΩ-32：语义 OCR 通道改吃调用方传入的帧（有 buffer ⇒ 零服务端自截）——
// 服务端 L2 自截路径退役为「无帧调用方」专属；几何通道不动（本就用帧）。
import { getSharp } from './_legacyDeps.js';
import { readTextAny } from './textReader.js';
import * as backend from './physicalBackend.js';
import { kernelRegistry } from './kernel/registry.js';
function avg(nums) {
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}
/** 中央区域裁剪框（几何与语义共用同一「弹窗栖息地」假设） */
const POPUP_SEMANTIC_CROP_MIN_EDGE_PX = 32; // 语义通道中央裁剪的最小边长（OCR 可用分辨率下限）
function centerRegionNorm(fraction = 0.4) {
    const inset = (1 - fraction) / 2;
    return { x: inset, y: inset, width: fraction, height: fraction };
}
/**
 * ΤΕΛ-5 D-G22：弹窗栖息地中央带（归一域 {x,y,width,height}）—— 几何/语义检测
 * 通道与 autonomy 策略面的「弹窗确认点击限定」共用同一「弹窗通常居于屏中央」
 * 假设（单源方言：变更此函数须两侧同步语义）。归一域乘屏宽高即像素域。
 */
export function popupHabitatNorm(fraction = 0.4) {
    return centerRegionNorm(fraction);
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
//
// ΠΑΝ-122（五键窗口参数 vs 真机弹窗时序的适配复查 —— 参数依据成文）：
// 本滤波器的喂食节奏 = take_screenshot 的模型节奏（秒级，非视频帧率）；
// 真机弹窗的时序形态与五键缺省值的推导对照如下（全部可由 LOGIT/SIGMOID
// 闭式复算，pan122 测试锁定数值）：
//   · 单帧几何 +4.0 nats：先验 logit(0.05)=−2.944 → 1.056 ⇒ belief≈0.743
//     ≥ ON 0.6 —— 弹窗出现后的**下一次截图**即拦截（零漏帧窗口，与旧
//     OR 行为逐字节对齐 —— 「宁可误报拦截」使命的执法面）；
//   · 单帧语义 +5.0 nats：belief≈0.786 ≥ ON —— 词表命中（cookie/accept）
//     同帧立即拦截；
//   · ON 态单帧清洁 −1.5 nats：0.743 → 0.390 落入迟滞带 [0.35,0.6] 保持
//     ON —— 弹窗真关后的第一帧漏检（OCR 抖动/关键词漏读）不放行；
//   · 双清洁帧：0.390 → 0.125 ≤ OFF 0.35 —— 连续两帧无证据才放行。真机
//     适配论证：模型节奏下两帧 ≈ 两个动作步（秒级）；弹窗「已关」的确认
//     成本 = 1 个额外动作步的守卫开销 —— 有界且方向正确（漏拦盲操作直接
//     失败的代价 ≫ 多拦一步）；
//   · 迟滞结构不变量（对数域）：单帧触发态 log-odds ≈ +1.06，OFF 线
//     logit(0.35) ≈ −0.62，距离 1.68 nats > 单帧清洁幅度 1.5 nats ——
//     单帧清洁只能把信念送进迟滞带（≈0.39，∈(0.35,0.6)），数学上不可能
//     从触发态直通放行（结构保证，非调参运气）。
// 已知边界（如实）：① 转瞬弹窗（toast 存活 < 1 个截图间隔）对任何帧采样
// 检测器都不可见 —— 非本滤波器参数可解；② 弹窗关闭后立刻重弹（cookie 横幅
// 复现）走 OFF→ON 的单帧强证据路径，无死区；③ SPRT 旁路（Q-3）双帧即锁
// clean 的锁死面是其停止语义（判过即停），消费面以 Schmitt 为准（SPRT
// 判决无生产消费方 —— 在案事实，非本工单范围）。
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
const DEFAULT_FILTER_KEY = 'default';
const MAX_TRACKED_FILTER_SESSIONS = 32;
const POPUP_FILTER_STALE_MS = 10 * 60 * 1000;
const popupFilters = new Map();
function filterCellFor(key, now) {
    // 惰性清过期（popupGuard.writeCell 同律;只清带会话键,default 免清）
    for (const [k, cell] of popupFilters) {
        if (k !== DEFAULT_FILTER_KEY && now - cell.updatedAt > POPUP_FILTER_STALE_MS)
            popupFilters.delete(k);
    }
    // LRU：新会话键入场且已满 ⇒ 按插入序逐出最旧会话（default 免逐）
    if (key !== DEFAULT_FILTER_KEY && !popupFilters.has(key)) {
        let sessions = 0;
        for (const k of popupFilters.keys())
            if (k !== DEFAULT_FILTER_KEY)
                sessions++;
        if (sessions >= MAX_TRACKED_FILTER_SESSIONS) {
            for (const k of popupFilters.keys()) {
                if (k === DEFAULT_FILTER_KEY)
                    continue;
                popupFilters.delete(k);
                break;
            }
        }
    }
    let cell = popupFilters.get(key);
    if (!cell) {
        cell = { filter: new SchmittPopupFilter(), updatedAt: now };
        popupFilters.set(key, cell);
    }
    return cell;
}
function popupFilterSessionKey(sessionId) {
    return typeof sessionId === 'string' && sessionId !== '' ? sessionId : DEFAULT_FILTER_KEY;
}
/** 喂帧：按会话分滤波器消费证据;带会话键镜像喂 default 一帧（全局最新视图） */
function feedPopupFilter(ev, sessionId) {
    const key = popupFilterSessionKey(sessionId);
    const cell = filterCellFor(key, Date.now());
    const r = cell.filter.update(ev);
    cell.updatedAt = Date.now();
    if (key !== DEFAULT_FILTER_KEY) {
        const d = filterCellFor(DEFAULT_FILTER_KEY, Date.now());
        d.filter.update(ev); // 镜像写：default 键与 popupGuard 的镜像规则同律
        d.updatedAt = Date.now();
    }
    return r;
}
export function resetPopupBelief() {
    popupFilters.clear();
}
/**
 * 语义证据：OCR 中央带，词表命中任一即确认。
 * ΝΩ-32 通道复用：调用方帧（buffer）在场 ⇒ **零自截** —— 直接对传入帧的中央带
 * 取 OCR（take_screenshot 已把 cap.buffer 传入：同一屏同一时刻的第二次服务端
 * 自截是纯浪费）。buffer 路径失败（tesseract 缺席/图过小）⇒ 语义证据诚实缺席
 * （[]），绝不为此回退服务端自截 —— 几何通道独立生效，行为不因证据缺席而退化。
 * buffer 缺席（无帧调用方）⇒ 服务端 L2 路径（readTextAny 服务端自截）—— 旧
 * 行为零回归。诚实边界：服务端 L2 OCR 无「带 buffer 的 region API」（getUiTree
 * 只收 region 自截）—— 待服务端补 API 后 buffer 通道可吃到服务端引擎。
 * 失败（OCR 不可用/超时/无语言包）静默返回空 —— 行为零回归。
 */
async function detectPopupSemantic(frameId, buffer, keywords, ocrLang) {
    if (keywords.length === 0)
        return [];
    try {
        let text = null;
        const hasBuffer = !!buffer && buffer.length > 0;
        if (hasBuffer) {
            // ΝΩ-32：帧通道（零自截）—— 调用方帧的中央带裁剪 + 本地 OCR
            try {
                const sharp = await getSharp();
                const meta = await sharp(buffer).metadata();
                const w = meta.width, h = meta.height;
                if (w >= POPUP_SEMANTIC_CROP_MIN_EDGE_PX && h >= POPUP_SEMANTIC_CROP_MIN_EDGE_PX) { // ΝΩ 收官：小于 32px 的帧语义 OCR 无意义（分辨率下限，非阈值旋钮）
                    const crop = await sharp(buffer)
                        .extract(centerRegion(w, h, 0.6))
                        .resize(1200)
                        .toBuffer();
                    const { readText } = await import('./textReader.js');
                    text = (await readText(crop, ocrLang)).text;
                }
            }
            catch {
                text = null;
            }
            if (text == null) {
                void frameId; // frameId 语义通道不消费（服务端自截路径已退役为无帧专属）
                return []; // 零自截律：有帧不回退服务端截屏 —— 语义证据诚实缺席
            }
        }
        else {
            // 无帧调用方：服务端 L2（readTextAny 服务端自截）—— 旧路径逐字节保持
            try {
                const r = await readTextAny(centerRegionNorm(0.6), ocrLang);
                text = r.text;
            }
            catch {
                text = null;
            }
            if (text == null)
                return [];
        }
        void frameId; // frameId 语义通道不消费（几何通道独用）
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
/** 双模融合检测 + F-3 贝叶斯迟滞滤波：take_screenshot 的唯一传感入口
 * （sessionId 可选 —— 滤波器按会话分键,缺席回落 'default';R1-8 会话隔离补全） */
export async function detectPopup(buffer, opts = {}, frameId = null, sessionId) {
    const geometric = await detectPopupHeuristic(frameId, buffer);
    const keywords = (opts.popupKeywords ?? '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
    const matchedKeywords = opts.enableOcr && keywords.length > 0
        ? await detectPopupSemantic(frameId, buffer, keywords, opts.ocrLang || 'eng')
        : [];
    // F-3：帧证据喂入施密特滤波 —— 单帧强证据立即 ON（旧行为），单帧噪声不再翻转
    // （R1-8：按会话分滤波器消费 —— 会话 A 的误报不再污染会话 B 的迟滞态）
    const { belief, active } = feedPopupFilter({
        geometric,
        semantic: matchedKeywords.length > 0,
    }, sessionId);
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
// W6-2（doctor smell.over-engineering 清偿）：W2-2（S3）接地新鲜度探针已分区提取至
// popupDetector.freshness.ts（行为零变化）；导入面不变 —— export * 再分发，既有消费方零改动。
export * from './popupDetector.freshness.js';
