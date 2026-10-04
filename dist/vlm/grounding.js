// src/vlm/grounding.ts
// W6-2 结构性保留（doctor smell.over-engineering 登记）：视觉接地引擎 —— 坐标几何/校准/预算门控/验证共守同一接地不变量（roundtrip 精度契约），分区将增加跨文件耦合面。
// 纪元 Ω（Ω-4 视觉接地）：GLM-5.3-Flash 云脑皮层的元素接地器官 —— 截图进、
// 可点击元素（像素坐标 + 语义标签）出，本地启发元素源之外的云脑直读路径。
// 本模块是云输出的**规整与执法层**：VLM 回话是方言（bbox 可能是 4 元数组、
// id 五花八门、confidence 可能越界、label 可能缺席），全部归一为仓库标准：
//   1. bbox 数组/对象双形态 → {x0,y0,x1,y1} 像素对象，clampBbox 夹回图内
//   2. id 归一为 'e1'.. 序号（下游「点 3 号」指令的稳定语义）
//   3. confidence 夹 [0,1]；label/role 兜底字符串
//   4. nmsElements 去冗余（仓库 NMS 约定：面积降序贪心 + IoU≥0.6）
// 失败语义与 textReader 同宗：**宁可空不可错** —— 任何一步失败返回
// ok:false + elements:[]，绝不抛异常；GLM 未配置时零网络立即降级。
// W1-8（P3 置信度门控级联注视）：grounding 出口新增 verifyGate 复核闸 ——
// 低置信 / 小目标 / 拥挤邻域三条件（满足其一）触发选择性 Zoom 复核：bbox 外扩
// 50% 裁 ROI + 2x 上采样，重跑 grounding + vlmOcr 交叉验证；两次 grounding
// 中心偏差 >8px 且 OCR 文字一致 ⇒ 取复核值，文字冲突 ⇒ 保守取原值并降置信。
// 预算封顶（每任务 8 次）防雪崩；复核 VLM 端口缺席/失败一律放行原值，绝不抛、
// 绝不阻塞（闸门评估本身零网络、零 sharp —— 未接线时行为逐字节不变）。
// W6R-A4（预算作用域化）：任务级预算账本按 verifyTaskId 键控（Map + LRU 封顶
// 64 槽防泄漏）—— 并发任务互不吃预算；缺省不传 taskId 时共用模块缺省账本，
// 与历史模块级计数行为逐字节一致（既有调用方与测试零改动）。
// W8-A6（VLM 架构债 · 依赖倒置最小形态）：本模块的云端依赖面自 GlmClient
// 具体类降为 StructuredVisionPort 窄端口（configured + chatJson）—— 多供应商
// （备选池/合议庭/复核第二意见脑）可直入，GlmClient 结构天然满足（传入处
// 零改动）；不改变任何运行时行为（现网仍传 GlmClient 实例）。
import { getGlmClient, isGlmConfigured } from './glmClient.js';
import { encodeForVlmMeta, mapBboxEncodedToOriginal, mapInsetToOriginal } from './codec.js';
import { buildGroundingSystemPrompt, buildGroundingUserPrompt } from './som.js';
import { kernelRegistry } from '../kernel/registry.js';
import { getSharp } from '../_legacyDeps.js';
/** NMS 去冗余阈值（仓库约定：IoU≥0.6 视为同一元素的重复检出） */
const NMS_IOU = 0.6;
/** VLM 未给 confidence 时的中性记账值 */
const DEFAULT_CONFIDENCE = 0.5;
/** label 兜底与截断上限（对齐仓库 name 截断的防注入纪律） */
const LABEL_FALLBACK = '未知元素';
const LABEL_MAX = 80;
const ROLE_FALLBACK = 'unknown';
const ROLE_MAX = 24;
// ─── W1-8（P3 置信度门控级联注视）：复核闸模块常量 ───
/** W1-8：复核闸缺省开关（true = 开；调用方 opts.verifyGate=false 显式关闭）。
 *  触发条件本身很窄（低置信/小目标/拥挤邻域），缺省开启；闸门评估零网络零
 *  sharp，未接线复核端口时不产生任何副作用。 */
const VERIFY_GATE_DEFAULT_ON = true;
/** W1-8：触发阈值 —— confidence 严格小于此值触发复核（模型自报不确定） */
const VERIFY_CONFIDENCE_MIN = 0.6;
/** W1-8：触发阈值 —— bbox 短边（输出坐标系）严格小于此像素数触发（小目标） */
const VERIFY_MIN_SHORT_EDGE = 24;
/** W1-8：触发阈值 —— bbox 邻域（外扩 ROI 内）pre-NMS 候选框数严格大于此值触发（拥挤误检区） */
const VERIFY_NMS_DENSITY_MAX = 5;
/** W1-8：采信阈值 —— 原/复核两轮 grounding 中心偏差严格大于此像素数，且 OCR 文字一致 ⇒ 取复核值 */
const VERIFY_CENTER_DEVIATION_PX = 8;
/** W1-8：ROI 外扩比例 —— bbox 每边向外扩「该维尺寸×此值/2」（ROI 总尺寸 = bbox×1.5） */
const VERIFY_ROI_EXPAND = 0.5;
/** W1-8：ROI 上采样倍数（小目标在编码管线里吃不满分辨率带宽 —— 放大再问一次） */
const VERIFY_UPSAMPLE = 2;
/** W1-8：每任务复核次数上限（防雪崩；新任务 resetVerifyGateBudget() 清零） */
const VERIFY_BUDGET_MAX = 8;
/** W1-8：文字冲突时的置信度折减系数（保守取原值但降置信） */
const VERIFY_CONFLICT_FACTOR = 0.5;
// ─── 纯函数几何工具（供本模块与下游复用；零副作用、零异常） ───
/** 数字卫兵：非有限数字一律按 0 记（坐标字段缺席时不炸管线） */
const finiteOr0 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/**
 * 纯函数：把 bbox 夹回 [0,width]×[0,height] 图内，并保证 x1>x0、y1>y0。
 * 倒置坐标（VLM 偶发 x0>x1）先交换；压扁/贴边的零面积盒扩为 1px；
 * 最终 floor(x0)/ceil(x1) 整数化 —— 整数盒**包含**原浮点盒且不出图。
 */
export function clampBbox(bbox, width, height) {
    const w = Number.isFinite(width) && width >= 1 ? Math.floor(width) : 1;
    const h = Number.isFinite(height) && height >= 1 ? Math.floor(height) : 1;
    const src = (bbox && typeof bbox === 'object' ? bbox : {});
    let x0 = Math.min(Math.max(finiteOr0(src.x0), 0), w);
    let y0 = Math.min(Math.max(finiteOr0(src.y0), 0), h);
    let x1 = Math.min(Math.max(finiteOr0(src.x1), 0), w);
    let y1 = Math.min(Math.max(finiteOr0(src.y1), 0), h);
    if (x1 < x0) {
        const t = x0;
        x0 = x1;
        x1 = t;
    } // 倒置交换
    if (y1 < y0) {
        const t = y0;
        y0 = y1;
        y1 = t;
    }
    let rx0 = Math.floor(x0), ry0 = Math.floor(y0);
    let rx1 = Math.ceil(x1), ry1 = Math.ceil(y1);
    if (rx1 <= rx0) {
        rx0 = Math.min(rx0, w - 1);
        rx1 = rx0 + 1;
    } // 零面积 → 1px
    if (ry1 <= ry0) {
        ry0 = Math.min(ry0, h - 1);
        ry1 = ry0 + 1;
    }
    return { x0: rx0, y0: ry0, x1: rx1, y1: ry1 };
}
/** 纯函数：两 bbox 的交并比 IoU = |a∩b| / |a∪b|；不相交或退化返回 0 */
export function iouBbox(a, b) {
    if (!a || !b)
        return 0;
    const iw = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const ih = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (iw <= 0 || ih <= 0)
        return 0;
    const inter = iw * ih;
    const areaA = Math.max(0, a.x1 - a.x0) * Math.max(0, a.y1 - a.y0);
    const areaB = Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
    const union = areaA + areaB - inter;
    return union > 0 ? inter / union : 0;
}
/**
 * 纯函数：NMS 去冗余（仓库 NMS 约定：**面积降序贪心** + IoU≥iouThreshold
 * 去重，平手取先出现者 —— 与 elementTracker 同形态的确定性）。
 * 泛型约束仅需 bbox —— 接地管线中 center 尚未计算的中间形态（Omit<..., 'center'>）
 * 亦可直入；面积非正的退化元素直接滤除（无面积的盒没有几何身份，不参选）。
 */
export function nmsElements(elements, iouThreshold) {
    // 纪元 Θ（Θ-4 生产接线）：缺省 NMS 阈值读内核注册表（grounding.nmsIou，
    // 区间 [0.4,0.8]）—— 未注册 ⇒ getOrDefault 回声 NMS_IOU(0.6)，行为逐字节
    // 不变；显式入参仍最高优先（缺省参表达式逐调用求值，同步纯读无害）。
    const threshold = iouThreshold ?? kernelRegistry.getOrDefault('grounding.nmsIou', NMS_IOU);
    if (!Array.isArray(elements))
        return [];
    const ranked = elements
        .map((el, i) => ({
        el, i,
        area: Math.max(0, el.bbox.x1 - el.bbox.x0) * Math.max(0, el.bbox.y1 - el.bbox.y0),
    }))
        .filter(r => Number.isFinite(r.area) && r.area > 0)
        .sort((p, q) => q.area - p.area || p.i - q.i);
    const kept = [];
    for (const cand of ranked) {
        if (kept.every(k => iouBbox(k.el.bbox, cand.el.bbox) < threshold))
            kept.push(cand);
    }
    return kept.map(r => r.el);
}
/**
 * W6R-A4：任务预算账本表（taskId → 账本）。LRU 语义：命中即重插刷新位置
 * （插入序 = 最近使用序），容量封顶 VERIFY_BUDGET_LEDGER_CAP —— 超限时逐出
 * 最久未用的账本（防 Map 无界泄漏；被逐出的任务若复活则从 0 重新起账，
 * 宁可多给复核机会，不可内存漏账）。
 */
const taskBudgetLedgers = new Map();
/** W6R-A4：账本表容量封顶 —— 防御式上限（真实并发任务数远低于此；溢出即 LRU 逐出） */
const VERIFY_BUDGET_LEDGER_CAP = 64;
/** W6R-A4：缺省账本 —— 不传 taskId 的既有调用方共用（历史模块级计数的等价物） */
let defaultBudgetLedger = { used: 0 };
/**
 * W6R-A4：取（或建）任务的预算账本 —— LRU 刷新 + 容量封顶逐出。
 * taskId 脏值（空串/非字符串）安静回落缺省账本（零行为变化律）。
 */
function getVerifyBudgetLedger(taskId) {
    if (typeof taskId !== 'string' || taskId === '')
        return defaultBudgetLedger;
    const hit = taskBudgetLedgers.get(taskId);
    if (hit) {
        // LRU 刷新：删了重插，让插入序保持「最近使用在后」
        taskBudgetLedgers.delete(taskId);
        taskBudgetLedgers.set(taskId, hit);
        return hit;
    }
    if (taskBudgetLedgers.size >= VERIFY_BUDGET_LEDGER_CAP) {
        const oldest = taskBudgetLedgers.keys().next().value;
        if (oldest !== undefined)
            taskBudgetLedgers.delete(oldest);
    }
    const fresh = { used: 0 };
    taskBudgetLedgers.set(taskId, fresh);
    return fresh;
}
/**
 * W1-8：复核预算清零 —— 新任务开始时由宿主调用（防上一任务的用量雪崩进下一任务）。
 * W6R-A4 作用域化：带 taskId ⇒ 只清该任务的账本（并发任务互不干扰）；
 * 不带（历史签名）⇒ 清缺省账本 + 全部任务账本（既有调用方语义保持）。
 */
export function resetVerifyGateBudget(taskId) {
    if (typeof taskId === 'string' && taskId !== '') {
        taskBudgetLedgers.delete(taskId); // 下次触达重建为 0
        return;
    }
    defaultBudgetLedger = { used: 0 };
    taskBudgetLedgers.clear();
}
/**
 * W1-8：Zoom 裁剪的 sharp 解析器 —— 生产恒 _legacyDeps.getSharp（懒加载纪律
 * 与 codec.ts 同源）；独立可变量仅为测试注入口服务（模拟 sharp 缺席 ⇒ 复核
 * 裁剪不可用 ⇒ 放行原值，绝不抛）。命名对齐 _legacyDeps 的 _forTest 约定。
 */
let resolveZoomSharp = getSharp;
/** W1-8：测试注入口：覆写 Zoom 裁剪 sharp 解析器（null = 复位生产解析器） */
export function _overrideZoomSharpResolver_forTest(resolver) {
    resolveZoomSharp = resolver ?? getSharp;
}
/** W1-8：文字归一（与 vlmOcr.normalize 同律：小写 + 空白折叠）—— 跨模块文字比对公用尺 */
const normText = (s) => (typeof s === 'string' ? s : '').toLowerCase().replace(/\s+/g, ' ').trim();
/**
 * W1-8 纯函数：bbox 每边向外扩「该维尺寸×expand/2」并 clamp 回画布整化
 * （expand=0.5 ⇒ ROI 总尺寸 = bbox×1.5）。零异常；退化输入经 clampBbox 收口。
 */
function expandRoiBox(bbox, expand, width, height) {
    const mx = (bbox.x1 - bbox.x0) * expand / 2;
    const my = (bbox.y1 - bbox.y0) * expand / 2;
    return clampBbox({ x0: bbox.x0 - mx, y0: bbox.y0 - my, x1: bbox.x1 + mx, y1: bbox.y1 + my }, width, height);
}
/**
 * W1-8 纯函数：局部 NMS 密度 —— pre-NMS 候选池中，中心落在 target 外扩 ROI
 * 内的候选框数（含 target 自身：幸存者本身即候选之一）。拥挤邻域 = NMS 刚
 * 清理过一片重叠检出 = 定位歧义高危区，值得二次注视。
 */
function neighborhoodDensity(target, pool, width, height) {
    if (!Array.isArray(pool))
        return 0;
    const roi = expandRoiBox(target, VERIFY_ROI_EXPAND, width, height);
    let n = 0;
    for (const cand of pool) {
        const b = cand?.bbox;
        if (!b)
            continue;
        const cx = (b.x0 + b.x1) / 2;
        const cy = (b.y0 + b.y1) / 2;
        if (cx >= roi.x0 && cx <= roi.x1 && cy >= roi.y0 && cy <= roi.y1)
            n += 1;
    }
    return n;
}
/**
 * W1-8 纯函数：OCR 文字一致性 —— 归一 label 与复核 OCR 文本互为包含即一致
 * （整句包含 或 任一词与 label 互相包含 —— 多词 label 的宽容收口）。
 */
function ocrTextConsistent(ocr, label) {
    const nl = normText(label);
    if (!nl)
        return false;
    if (normText(ocr.text).includes(nl))
        return true;
    return (ocr.words ?? []).some(w => {
        const nw = normText(w?.text);
        return nw !== '' && (nl.includes(nw) || nw.includes(nl));
    });
}
/**
 * W1-8：ROI 裁剪 + 上采样（sharp extract→resize→PNG，一次性链）。
 * 任何失败返回 null（sharp 缺席/越界/链异常 ⇒ 调用方放行原值 —— 降级安全，
 * 绝不抛）。不复用 codec.encodeForVlm 的 region 裁剪：其只缩不放（长边超限
 * 才 resize），无法兑现 2x 上采样；此处直连同一 sharp 懒加载源，零新增依赖。
 */
async function cropUpscaleRoi(buffer, roi, factor) {
    try {
        if (!Buffer.isBuffer(buffer) || buffer.length === 0)
            return null;
        if (!(factor >= 1))
            return null; // 病值防御：非有限/小于 1 的倍数无放大语义
        const sharp = await resolveZoomSharp();
        const left = Math.max(0, Math.floor(roi.x0));
        const top = Math.max(0, Math.floor(roi.y0));
        const width = Math.max(1, Math.ceil(roi.x1) - left);
        const height = Math.max(1, Math.ceil(roi.y1) - top);
        return await sharp(buffer)
            .extract({ left, top, width, height })
            .resize({ width: Math.round(width * factor), height: Math.round(height * factor), fit: 'fill' })
            .png()
            .toBuffer();
    }
    catch {
        return null; // 诚实降级：裁剪失败不毒化主结果
    }
}
/**
 * W1-8：复核闸主体 —— 逐元素评触发 →（触发者）裁 ROI 放大重跑 grounding +
 * vlmOcr 交叉验证 → 按偏差/文字一致性裁决。设计铁律：
 *   · 绝不抛：每元素体 try/catch 兜底，异常 ⇒ gate-error 放行原值；
 *   · 预算封顶：任务级 VERIFY_BUDGET_MAX 与调用级 callBudget 双闸，超限
 *     放行原值并记 budgetExhausted（degraded 记账 —— 防雪崩）。任务级账本
 *     按 ctx.ledger 作用域化（W6R-A4：verifyTaskId 键控 —— 并发任务互不
 *     侵占；缺省共用模块缺省账本，历史行为不变）；
 *   · 降级安全：端口缺席/裁剪不可用/复核 grounding 或 OCR 失败 ⇒ 一律放行
 *     原值（预算只在真实下发复核 grounding 时消耗）；
 *   · 保守裁决：文字冲突 ⇒ 原值保留 + 置信折半 + 冲突证据入事件；偏差 ≤8px
 *     且文字一致 ⇒ 两轮一致，保留原值（agree）；偏差 >8px 且文字一致 ⇒ 采信
 *     复核值（adopted，confidence 取两轮最大 —— 交叉验证抬升可信度）。
 * 元素 id/label/role 恒不改动（下游「点 3 号」引用锚点稳定）。
 */
async function runVerifyGate(ctx) {
    const report = { budgetUsed: ctx.ledger.used, budgetMax: VERIFY_BUDGET_MAX, events: [] };
    let callUsed = 0;
    // buffer 系 ⇄ 输出系换算（源图宽高恒 ≥1 —— encodeForVlmMeta 契约；病值兜底 1:1）
    const sx = ctx.srcW >= 1 ? ctx.outW / ctx.srcW : 1;
    const sy = ctx.srcH >= 1 ? ctx.outH / ctx.srcH : 1;
    const BW = Math.max(1, Math.floor(ctx.srcW));
    const BH = Math.max(1, Math.floor(ctx.srcH));
    for (let i = 0; i < ctx.elements.length; i++) {
        const el = ctx.elements[i];
        // ── 触发条件（满足其一；阈值全部模块常量）──
        const reasons = [];
        if (el.confidence < VERIFY_CONFIDENCE_MIN)
            reasons.push('confidence');
        const shortEdge = Math.min(el.bbox.x1 - el.bbox.x0, el.bbox.y1 - el.bbox.y0);
        if (shortEdge < VERIFY_MIN_SHORT_EDGE)
            reasons.push('short-edge');
        const density = neighborhoodDensity(ctx.promptBoxes[i] ?? el.bbox, ctx.candidatePool, ctx.promptW, ctx.promptH);
        if (density > VERIFY_NMS_DENSITY_MAX)
            reasons.push('density');
        if (reasons.length === 0)
            continue;
        // 事件预挂 'gate-error' 兜底结论（下方每个分支都会覆写 —— 若未来新增路径
        // 漏写结论，事件以 gate-error 诚实暴露而非 undefined 裸奔）
        const ev = { id: el.id, reasons, outcome: 'gate-error' };
        report.events.push(ev);
        // ── 降级安全第一闸：复核端口缺席/未配置 ⇒ 放行原值（零网络零裁剪）──
        if (!ctx.verifyClient || ctx.verifyClient.configured === false) {
            ev.outcome = 'port-absent';
            continue;
        }
        // ── 预算封顶：任务级/调用级双闸 ⇒ 放行原值 + degraded 记账（防雪崩）──
        if (ctx.ledger.used >= VERIFY_BUDGET_MAX || callUsed >= ctx.callBudget) {
            ev.outcome = 'budget-exhausted';
            report.budgetExhausted = true;
            continue;
        }
        try {
            // ── ROI：输出系 bbox → buffer 系，外扩 50%，clamp 回源图 ──
            const roi = expandRoiBox({ x0: el.bbox.x0 / sx, y0: el.bbox.y0 / sy, x1: el.bbox.x1 / sx, y1: el.bbox.y1 / sy }, VERIFY_ROI_EXPAND, BW, BH);
            const roiBuf = await cropUpscaleRoi(ctx.buffer, roi, VERIFY_UPSAMPLE);
            if (!roiBuf) {
                ev.outcome = 'crop-unavailable';
                continue;
            }
            // 预算在此记账：真实下发复核 grounding 的时刻（裁剪失败不计 —— 未耗云脑）
            ctx.ledger.used += 1;
            callUsed += 1;
            report.budgetUsed = ctx.ledger.used;
            // ── 重跑 grounding（复核端口；verifyGate:false 斩断自递归）──
            const re = await groundElements(roiBuf, {
                client: ctx.verifyClient,
                question: ctx.question,
                verifyGate: false,
                _zoomDepth: ctx.depth + 1,
            });
            if (!re.ok || re.elements.length === 0) {
                ev.outcome = 'reground-failed';
                if (re.error)
                    ev.detail = re.error.slice(0, 120);
                continue;
            }
            // ── 匹配：复核元素（ROI 系）→ buffer 系，标签相等优先、次 IoU、再取近 ──
            const elBuf = { x0: el.bbox.x0 / sx, y0: el.bbox.y0 / sy, x1: el.bbox.x1 / sx, y1: el.bbox.y1 / sy };
            const elC = { x: (elBuf.x0 + elBuf.x1) / 2, y: (elBuf.y0 + elBuf.y1) / 2 };
            let best = null;
            for (const cand of re.elements) {
                const box = {
                    x0: roi.x0 + cand.bbox.x0 / VERIFY_UPSAMPLE,
                    y0: roi.y0 + cand.bbox.y0 / VERIFY_UPSAMPLE,
                    x1: roi.x0 + cand.bbox.x1 / VERIFY_UPSAMPLE,
                    y1: roi.y0 + cand.bbox.y1 / VERIFY_UPSAMPLE,
                };
                const iou = iouBbox(box, elBuf);
                const labelHit = normText(cand.label) === normText(el.label) && normText(el.label) !== '';
                if (!labelHit && iou <= 0)
                    continue; // 既不同名也不重叠 ⇒ 不是同一元素
                const c = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
                const dev = Math.hypot(c.x - elC.x, c.y - elC.y);
                const score = (labelHit ? 10 : 0) + iou - dev / 1e6; // 标签 > IoU > 近者，平手取先
                if (!best || score > best.score)
                    best = { score, dev, cand, box };
            }
            if (!best) {
                ev.outcome = 'no-match';
                continue;
            }
            ev.deviationPx = Math.round(best.dev * 100) / 100;
            // ── vlmOcr 交叉验证（复核端口；只读复用，懒加载避免静态环引）──
            const { readTextViaVlm } = await import('./vlmOcr.js');
            const ocr = await readTextViaVlm(roiBuf, { client: ctx.verifyClient });
            if (!ocr.ok) {
                ev.outcome = 'ocr-unavailable';
                if (ocr.error)
                    ev.detail = ocr.error.slice(0, 120);
                continue;
            }
            // ── 文字裁决：label 无文字身份（兜底串）⇒ 无法交叉验证，诚实放行 ──
            const nl = normText(el.label);
            if (!nl || nl === normText(LABEL_FALLBACK)) {
                ev.outcome = 'text-unverifiable';
                continue;
            }
            if (!ocrTextConsistent(ocr, el.label)) {
                // 文字冲突 ⇒ 保守取原值并降置信、记冲突证据（W1-8 规格第 2 条保守臂）
                el.confidence = Math.max(0, el.confidence * VERIFY_CONFLICT_FACTOR);
                ev.outcome = 'conflict';
                ev.detail = `label「${el.label}」不见于复核 OCR 文本——保守取原值并降置信`;
                continue;
            }
            if (best.dev > VERIFY_CENTER_DEVIATION_PX) {
                // 偏差 >8px 且文字一致 ⇒ 取复核值（几何回输出系 + clamp 收口整化）
                const nb = clampBbox({ x0: best.box.x0 * sx, y0: best.box.y0 * sy, x1: best.box.x1 * sx, y1: best.box.y1 * sy }, ctx.outW, ctx.outH);
                el.bbox = nb;
                el.center = { x: (nb.x0 + nb.x1) / 2, y: (nb.y0 + nb.y1) / 2 };
                el.confidence = Math.min(1, Math.max(el.confidence, best.cand.confidence));
                ev.outcome = 'adopted';
                continue;
            }
            // 文字一致且偏差 ≤8px ⇒ 两轮定位一致，保留原值
            ev.outcome = 'agree';
        }
        catch (err) {
            // 绝不抛铁律的闸内兜底：未知异常 ⇒ 放行原值 + 事件记账
            ev.outcome = 'gate-error';
            ev.detail = (err instanceof Error ? err.message : String(err)).slice(0, 120);
        }
    }
    return report;
}
/** bbox 双形态解析：[x0,y0,x1,y1] 数组或 {x0,y0,x1,y1} 对象；非法返回 null */
function parseBbox(raw) {
    let ns;
    if (Array.isArray(raw)) {
        if (raw.length < 4)
            return null;
        ns = [raw[0], raw[1], raw[2], raw[3]];
    }
    else if (raw !== null && typeof raw === 'object') {
        const o = raw;
        ns = [o.x0, o.y0, o.x1, o.y1];
    }
    else {
        return null;
    }
    if (!ns.every(n => typeof n === 'number' && Number.isFinite(n)))
        return null;
    return { x0: ns[0], y0: ns[1], x1: ns[2], y1: ns[3] };
}
/** 字符串兜底：非字符串/空白 → fallback；超长截断（防注入纪律） */
function strOr(raw, fallback, max) {
    if (typeof raw !== 'string')
        return fallback;
    const s = raw.trim();
    return s.length === 0 ? fallback : s.slice(0, max);
}
/** confidence 兜底：非数字 → 中性 0.5；数字夹 [0,1]（越界值不外溢） */
function confOr(raw) {
    if (typeof raw !== 'number' || !Number.isFinite(raw))
        return DEFAULT_CONFIDENCE;
    return Math.min(1, Math.max(0, raw));
}
/** 尺寸裁决：调用方显式像素尺寸优先（屏坐标语义），缺省回编码结果 */
function pickDim(preferred, fallback) {
    if (typeof preferred === 'number' && Number.isFinite(preferred) && preferred >= 1)
        return preferred;
    return typeof fallback === 'number' && Number.isFinite(fallback) && fallback >= 1 ? fallback : 0;
}
/**
 * 视觉接地主入口：截图 Buffer → 云脑 → 规整化可点击元素集。
 *
 * 管线：isGlmConfigured 哨兵（未配置且未注入 client ⇒ 零网络立即降级，
 * 不拨号不编码）→ encodeForVlmMeta 编码（纪元 Γ：源图宽高随行）→ som 接地
 * 提示词组装 → client.chatJson → 逐元素校验（id 归一 'e1'..、bbox 双形态转
 * 对象、clampBbox、confidence 夹 [0,1]、label/role 兜底；非法元素被过滤）→
 * nmsElements 去冗余 → 坐标反算（纪元 Γ-1：未声明尺寸时编码系 → 源图系）
 * → 计算中心点。任何一步失败返回 ok:false + error，elements 恒为 []。
 */
export async function groundElements(buffer, opts) {
    const t0 = Date.now();
    const fail = (error, strategy, degraded = false) => ({ ok: false, elements: [], degraded, error, latencyMs: Date.now() - t0, strategy });
    try {
        // 0) 配置哨兵：未配置且未注入测试 client ⇒ 零网络降级（不拨号、不编码）
        let client;
        if (opts?.client) {
            client = opts.client;
        }
        else {
            if (!isGlmConfigured())
                return fail('GLM 未配置（缺 API Key）—— 零网络降级', 'unconfigured', true);
            client = getGlmClient();
        }
        if (client.configured === false) {
            return fail('GLM client 未配置 —— 零网络降级', 'unconfigured', true);
        }
        // 1) 编码（sharp 压缩/缩放 —— 云脑往返的带宽礼仪；纪元 Γ 走元信息通道：
        //    源图宽高随编码结果返回，坐标反算自此有基准）
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
            return fail('空截图 buffer', 'vlm-grounding');
        }
        const enc = await encodeForVlmMeta(buffer);
        if (!enc.ok || !enc.value)
            return fail(enc.error ?? '截图编码失败', 'vlm-grounding');
        const encoded = enc.value;
        const strategy = `vlm:${encoded.strategy}`;
        // 2) 尺寸裁决：显式像素尺寸优先，缺省取编码结果
        const width = pickDim(opts?.width, encoded.width);
        const height = pickDim(opts?.height, encoded.height);
        if (width < 1 || height < 1)
            return fail('图像尺寸不可得', strategy);
        // 纪元 Γ（Γ-1 坐标反算）：提示词坐标系 = width×height（上方裁决，旧行为）。
        //   · 双维显式声明 ⇒ 调用方屏幕语义，模型已按声明系作答 → 原样输出；
        //   · 未声明 ⇒ 提示词用编码尺寸（模型在编码图上作答），但输出端经
        //     mapBboxEncodedToOriginal 反算回源图系 —— 编码缩小不再劫持坐标系。
        //     3)~5) 全程在提示词系内进行，反算只在 6) 出口处发生一次。
        const hasW = typeof opts?.width === 'number' && Number.isFinite(opts.width) && opts.width >= 1;
        const hasH = typeof opts?.height === 'number' && Number.isFinite(opts.height) && opts.height >= 1;
        const declared = hasW && hasH;
        const srcW = encoded.sourceWidth;
        const srcH = encoded.sourceHeight;
        const backmap = !declared
            && Number.isFinite(srcW) && srcW >= 1
            && Number.isFinite(srcH) && srcH >= 1
            && encoded.width >= 1 && encoded.height >= 1;
        // 3) som 接地提示词组装（坐标语义 = width×height 像素系）
        const req = {
            images: [{ base64: encoded.base64, mime: encoded.mime }],
            system: buildGroundingSystemPrompt(),
            prompt: buildGroundingUserPrompt({ width, height, question: opts?.question }),
            jsonMode: true,
            temperature: 0.1, // 接地要坐标精度，不要发散
            maxTokens: 2048,
        };
        // 4) 云脑往返
        const res = await client.chatJson(req);
        if (!res.ok)
            return fail(res.error ?? 'GLM 接地调用失败', strategy);
        // 双方言收窄：som 提示词勒令裸 JSON 数组、ensemble 供词强写 {elements:[...]}——
        // 云输出按这两种形态都收（漏一种 = 该方言下的接地恒失败）
        const rawEls = Array.isArray(res.value)
            ? res.value
            : res.value?.elements;
        if (!Array.isArray(rawEls))
            return fail('GLM 输出缺 elements 数组', strategy);
        // 5) 逐元素校验规整（非法元素被过滤 —— 宁可少报，不可错报）
        const validated = [];
        for (const raw of rawEls) {
            if (raw === null || typeof raw !== 'object')
                continue;
            const o = raw;
            const bbox = parseBbox(o.bbox);
            if (!bbox)
                continue;
            validated.push({
                id: `e${validated.length + 1}`, // id 归一为 e1.. 序号
                label: strOr(o.label ?? o.name, LABEL_FALLBACK, LABEL_MAX),
                role: strOr(o.role ?? o.type, ROLE_FALLBACK, ROLE_MAX),
                bbox: clampBbox(bbox, width, height),
                confidence: confOr(o.confidence),
                source: 'vlm',
            });
        }
        // 6) NMS 去冗余（同一控件的多重检出合并，提示词系内进行 —— 旧几何行为）
        //    → 纪元 Γ 出口反算（backmap 时编码系 → 源图系，clampBbox 收口整化；
        //    纪元 Γ2：inset 编码走分段反算 mapInsetToOriginal —— 凹窗内原生密度 1:1、
        //    窗外按缩图实际比值，元信息脏值时函数内部诚实回退 Γ 等比语义）
        //    → 计算中心点
        //    W1-8：幸存者反算前的提示词系 bbox 随行保留（复核闸的密度统计系）
        const insetActive = encoded.foveaMode === 'inset';
        const kept = nmsElements(validated);
        const promptBoxes = kept.map(el => el.bbox);
        const elements = kept.map(el => {
            let bbox;
            if (insetActive && backmap) {
                const p0 = mapInsetToOriginal(el.bbox.x0, el.bbox.y0, encoded);
                const p1 = mapInsetToOriginal(el.bbox.x1, el.bbox.y1, encoded);
                bbox = clampBbox({ x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y }, srcW, srcH);
            }
            else if (backmap) {
                bbox = clampBbox(mapBboxEncodedToOriginal(el.bbox, encoded.width, encoded.height, srcW, srcH), srcW, srcH);
            }
            else {
                bbox = el.bbox;
            }
            return {
                ...el,
                bbox,
                center: { x: (bbox.x0 + bbox.x1) / 2, y: (bbox.y0 + bbox.y1) / 2 },
            };
        });
        // ── W1-8（P3 置信度门控级联注视）：grounding 出口的复核闸 ──
        // 主定位层（非 Zoom 递归层）且未显式关闭时逐元素评触发；闸门评估零网络
        // 零 sharp，端口未接线时除报告字段外行为逐字节不变（零回归）。
        let verifyGate;
        const gateWanted = (opts?.verifyGate ?? VERIFY_GATE_DEFAULT_ON) === true
            && !(typeof opts?._zoomDepth === 'number' && opts._zoomDepth >= 1);
        if (gateWanted) {
            const rawCallBudget = opts?.verifyBudget;
            verifyGate = await runVerifyGate({
                buffer,
                elements,
                promptBoxes,
                candidatePool: validated,
                promptW: width,
                promptH: height,
                outW: backmap ? srcW : width,
                outH: backmap ? srcH : height,
                srcW,
                srcH,
                verifyClient: opts?.verifyClient,
                ledger: getVerifyBudgetLedger(opts?.verifyTaskId),
                callBudget: typeof rawCallBudget === 'number' && Number.isFinite(rawCallBudget) && rawCallBudget >= 0
                    ? Math.floor(rawCallBudget)
                    : Number.POSITIVE_INFINITY,
                question: opts?.question,
                depth: typeof opts?._zoomDepth === 'number' ? opts._zoomDepth : 0,
            });
        }
        return {
            ok: true,
            elements,
            degraded: false,
            latencyMs: Date.now() - t0,
            strategy,
            // 纪元 Γ：声明系直通或反算成立 ⇒ 'original'；反算基准缺席 ⇒ 诚实 'encoded'
            coordinateSpace: declared || backmap ? 'original' : 'encoded',
            // W1-8：复核闸报告（闸开时恒在场；events 空 = 无人触发）
            ...(verifyGate ? { verifyGate } : {}),
        };
    }
    catch (err) {
        // 绝不抛异常：未知异常（含注入物炸裂）也收敛为失败结果
        return fail(err instanceof Error ? err.message : '接地管线未知异常', 'vlm-grounding');
    }
}
