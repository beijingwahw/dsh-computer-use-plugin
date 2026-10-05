// src/contextManager.records.ts
// W6-2（doctor smell.over-engineering 清偿）：自 contextManager.ts 低风险分区提取
// （>500 行拆分信号）—— 记录类型（TaskAnchor / ScreenshotRecord / SubconsciousTrace）
// 与纯几何/体积小函数整体搬迁。行为零变化；contextManager.ts 以再导出保持导入面不变。
// W8-A5（DEBTS D-C3 增量编码消费方）：新增 IncrementalDelta 记录字段 + 规整纯函数 +
// 驱逐摘要纯函数 —— 摘要铸造消费 codec 的锚点文本产物（patchAnchorText，三系坐标
// 并列的投递协议文本面）。依赖面从「零外部依赖」扩为仅 vlm/codec 纯函数（单向
// context → vlm，与 contextManager.ts 的 gazeRouter 导入同律；codec 不反向依赖本
// 模块，无环）。
import { cleanPatchRect, patchAnchorText } from './vlm/codec.js';
/** W1-9：clamp 进 [0,1]（归一化坐标的防御收口；非有限按 0 记） */
export function clampUnit(v) {
    if (!Number.isFinite(v))
        return 0;
    return Math.min(1, Math.max(0, v));
}
// W6-2（doctor smell.magic-number 清偿）：E-4 惊异加成的页面级跳变下界（dHash 位数）。
// 24/64 位 ≈ 全屏 37.5% 位翻转 —— 元素级反馈撑不满此距离，不误伤。数值逐位不变。
export const SURPRISE_BIT_FLOOR = 24;
/** base64 字符数 → 近似 KB（data URL 前缀开销可忽略，预算用途足够精确） */
export function approxKb(b64) {
    return b64.length / 1024;
}
// ─── ΠΑΝ-31（钉扎引擎数值修复）：显著度合成公式与钉扎/解钉阈值的法定面 ───
//
// 背景（批判 C1-1 M2 实证的数值缺陷）：
//   ① 旧实现 relevance 只在 record.textSummary 在场时计算，而 textSummary 仅在
//     驱逐时铸造 —— 在窗图片（钉扎候选池的全部成员）relevance 恒 0.5 ⇒ 基线
//     显著度上限 0.8×0.5×1.0 = 0.4 < 0.8 钉扎线：任务目标**永不可能被钉扎**
//     （C-4 头注的「核心目标钉扎永生」名存实亡）。修法见 contextManager.
//     assessSalience 的锚点/任务语义回退通道。
//   ② 旧实现惊异加成是常数 +0.45（不随时间衰减）⇒ 完全时间衰减后
//     0.16+0.45 = 0.61 > 0.5 解钉线：惊异帧一旦钉住**永不释放**（钉扎名额
//     pinBudget=1 被首个惊异帧锁死）。修法：惊异加成乘同一新近度包络 ——
//     「世界刚剧变」的注意力价值随剧变远去而衰减，钉扎/解钉阈值间的施密特
//     滞回带对两类候选都真正可达。
//
// 本节是公式的唯一事实源（纯函数 + 法定常量）：数值契约由执法测试直接锚定，
// contextManager.ts 只负责采集输入（typeWeight/relevance/recency/surpriseBits）。
/** C-4 钉扎线：显著度 ≥ 此值且名额未满 ⇒ 钉扎（高显著度豁免驱逐） */
export const SALIENCE_PIN_THRESHOLD = 0.8;
/** C-4 解钉线：已钉扎记录显著度 < 此值 ⇒ 解钉（焦点随任务漂移）；恒 < 钉扎线 —— 施密特滞回 */
export const SALIENCE_UNPIN_THRESHOLD = 0.5;
/** E-4 惊异加成幅度：满新近度时恰把基线抬过钉扎线（0.4+0.45=0.85 ≥ 0.8） */
export const SURPRISE_SALIENCE_BONUS = 0.45;
/** 新近度半衰期（分钟）：「刚看过」的记忆天然更鲜活 */
export const SALIENCE_RECENCY_HALF_LIFE_MIN = 5;
/** ΠΑΝ-31 锚文本语义门：锚文本与当前任务描述的余弦低于此值 ⇒ 视为旧任务遗物，锚点通道让路 */
export const SALIENCE_ANCHOR_TEXT_GATE = 0.2;
/**
 * ΠΑΝ-31 纯函数：显著度合成 —— 类型加权 × 任务相关 × 新近度包络
 * （0.4 底 + 0.6 衰减项），惊异帧（≥SURPRISE_BIT_FLOOR 位）叠加随同一
 * 新近度包络衰减的加成（封顶 1）。三位小数确定性输出。
 * 数值契约（执法测试锚定）：
 *   · 满新近度 + 满相关 ⇒ 0.8 恰过钉扎线（任务目标可钉 —— 旧实现恒 0.4 不可钉）；
 *   · 零新近度 + 满相关 ⇒ 0.32 落入解钉线之下（滞回带可穿越）；
 *   · 满新近度 + 惊异 ⇒ 0.85 过钉扎线；零新近度 + 惊异 ⇒ 0.16 解钉
 *     （旧实现 0.61 > 0.5 永不解钉）。
 */
export function composeSalience(inp) {
    const round3 = (v) => Math.round(v * 1000) / 1000;
    const envelope = 0.4 + 0.6 * Math.min(1, Math.max(0, inp.recency));
    const base = round3(inp.typeWeight * Math.min(1, Math.max(0, inp.relevance)) * envelope);
    if ((inp.surpriseBits ?? 0) >= SURPRISE_BIT_FLOOR) {
        return round3(Math.min(1, base + SURPRISE_SALIENCE_BONUS * Math.min(1, Math.max(0, inp.recency))));
    }
    return base;
}
/** W8-A5：维度体检（≥1 有限数取整；脏值 0 —— 后续判据按不可用处理，不猜） */
function w8Dim(n) {
    return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0;
}
/** W8-A5：补丁清单防御上限（账本侧 maxPatches=6 的两倍垫 —— 显式投喂的脏洪峰不撑爆摘要文本） */
const W8_MAX_PATCHES = 12;
/**
 * W8-A5 纯函数：增量判决体检 + 规整（LedgerVerdict 形状的宽入口 → 规范形）。
 * 防御律（与 recordTaskAnchor 同族，绝不抛）：
 *   · 非对象 / kind 不在四词表 ⇒ null 诚实拒绝；
 *   · changedPct 非有限 ⇒ 0；夹 [0,100]；
 *   · patches 逐块过 codec.cleanPatchRect（退化拒绝、越界收口；维度缺席时
 *     以 1<<30 为画布 —— 收口语义退化为纯几何规整），上限 W8_MAX_PATCHES；
 *   · scroll.dyPx 非有限 ⇒ 整个 scroll 缺席（滚动语义不可半信半疑）；
 *   · sourceWidth/Height 各自独立体检（单边脏 ⇒ 双边缺席 —— 换算基准不成对不如没有）；
 *   · generation 非有限 ⇒ 0。
 */
export function cleanIncrementalDelta(raw) {
    if (raw === null || typeof raw !== 'object')
        return null;
    const d = raw;
    const KINDS = new Set(['keyframe', 'patch', 'scroll', 'silent']);
    if (typeof d.kind !== 'string' || !KINDS.has(d.kind))
        return null;
    const changedPct = typeof d.changedPct === 'number' && Number.isFinite(d.changedPct)
        ? Math.min(100, Math.max(0, d.changedPct)) : 0;
    const gen = typeof d.generation === 'number' && Number.isFinite(d.generation) && d.generation >= 0
        ? Math.floor(d.generation) : 0;
    const sw = w8Dim(d.sourceWidth);
    const sh = w8Dim(d.sourceHeight);
    const patches = [];
    if (Array.isArray(d.patches)) {
        // 补丁收口画布：成对干净维度用真画布（越界收口语义完整）；缺席用开放画布
        //（只做几何规整 —— 归一化换算在摘要侧按维度缺席诚实降级）
        const canvasOk = sw >= 1 && sh >= 1;
        for (const p of d.patches.slice(0, W8_MAX_PATCHES)) {
            const c = cleanIncrementalPatch(p, canvasOk ? sw : 1 << 30, canvasOk ? sh : 1 << 30);
            if (c)
                patches.push(c);
        }
    }
    const sc = d.scroll;
    const dyPx = sc !== null && typeof sc === 'object'
        && typeof sc.dyPx === 'number' && Number.isFinite(sc.dyPx)
        ? Math.round(sc.dyPx) : undefined;
    return {
        kind: d.kind,
        changedPct,
        patches,
        ...(dyPx !== undefined ? { scrollDyPx: dyPx } : {}),
        generation: gen,
        ...(sw >= 1 && sh >= 1 ? { sourceWidth: sw, sourceHeight: sh } : {}),
    };
}
/** W8-A5 纯函数：单块补丁规整（codec.cleanPatchRect 的薄封装 —— 退化/非对象拒绝，其余收口） */
function cleanIncrementalPatch(p, canvasW, canvasH) {
    if (p === null || typeof p !== 'object')
        return null;
    const r = p;
    const fin = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
    return cleanPatchRect({ x: fin(r.x), y: fin(r.y), w: fin(r.w), h: fin(r.h) }, canvasW, canvasH);
}
/**
 * W8-A5：驱逐摘要字符预算缺省（480 —— 一条 codec 三系锚点 ≈190 字符，预算
 * 必须容得下单锚点；双锚点起诚实截断。墓志铭从段的量级：≈480 字符 ≈120 文本
 * token，对价是整图 ≈数千视觉 token 的变化几何存活）。
 */
export const DEFAULT_INCREMENTAL_SUMMARY_CHARS = 480;
/**
 * W8-C1（doctor smell.magic-number 清偿）：增补段字符预算的下限阈值（20 ——
 * 法定具名常量，数值不变：太小的截断预算会让锚点文本被裁成不可读的碎片，
 * 宁可回声缺省 480 也不收）。configureIncremental / incrementalEvictionSummary
 * 两处的 `>= 20` 同一真相源。
 */
export const MIN_INCREMENTAL_SUMMARY_CHARS = 20;
/**
 * W8-A5 纯函数：驱逐摘要增补段 —— 增量编码产物的文本消费面。
 * 输入规范形 delta，输出直接拼在墓志铭（+ 遗像）之后的单段文本：
 *   · silent：本帧与前一帧视觉恒同（静默判决）—— 被驱逐的像素是其前帧的
 *     重复，模型对「这帧是什么」零信息损失；
 *   · patch：本帧相对前帧仅 K 块小区域变化 —— 逐块给出 codec.patchAnchorText
 *     锚点（三系坐标并列；维度缺席时诚实降级为源图像素列举，不伪造归一化）；
 *     未列出区域自前帧以来未变；
 *   · scroll：内容相对前帧平移 dyPx 像素（+ 新入内容条带几何）；
 *   · keyframe：全场景变化（关键帧）—— 没有紧凑差分可携带，诚实申报后
 *     降级回纯墓志铭语义（首帧无前帧 / 帧突变同走此路）。
 * maxChars 截断（缺省 DEFAULT_INCREMENTAL_SUMMARY_CHARS=480）；脏 delta（null）⇒ 空串（调用方拼接收敛为现状）。
 * 零副作用、绝不抛。
 */
export function incrementalEvictionSummary(delta, maxChars) {
    if (!delta || typeof delta !== 'object')
        return '';
    const cap = typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars >= MIN_INCREMENTAL_SUMMARY_CHARS
        ? Math.floor(maxChars) : DEFAULT_INCREMENTAL_SUMMARY_CHARS;
    const pct = (v) => (Math.round(v * 10) / 10).toFixed(1);
    const dimsOk = typeof delta.sourceWidth === 'number' && delta.sourceWidth >= 1
        && typeof delta.sourceHeight === 'number' && delta.sourceHeight >= 1;
    // 锚点铸造：维度成对在场 ⇒ codec.patchAnchorText（三系并列的投递协议产物，
    // 编码系按「关键帧未缩放」的诚实假设取源图系 —— 与 codec 文档同律）；
    // 缺席 ⇒ 源图像素列举（换算基准缺席，不猜归一化）
    const anchor = (r) => dimsOk
        ? patchAnchorText(r, { width: delta.sourceWidth, height: delta.sourceHeight }, { width: delta.sourceWidth, height: delta.sourceHeight })
        : `(${r.x},${r.y}) ${r.w}x${r.h} source-px`;
    let text;
    switch (delta.kind) {
        case 'silent':
            text = `Incremental delta: this frame was visually identical to the immediately preceding frame (pixel-diff ledger verdict: silent, changed ${pct(delta.changedPct)}%). Its pixels duplicated a frame already covered in this timeline.`;
            break;
        case 'patch': {
            if (delta.patches.length === 0) {
                text = `Incremental delta: no measurable change vs the immediately preceding frame (patch verdict with empty rect list, changed ${pct(delta.changedPct)}%).`;
            }
            else {
                const anchors = delta.patches.map(anchor).join('; ');
                text = `Incremental delta: vs its immediate predecessor only ${delta.patches.length} region(s) changed — ${anchors}. All regions not listed were unchanged.`;
            }
            break;
        }
        case 'scroll': {
            const dy = typeof delta.scrollDyPx === 'number' && Number.isFinite(delta.scrollDyPx)
                ? delta.scrollDyPx : null;
            if (dy === null) {
                text = `Incremental delta: content scrolled vs its immediate predecessor (vector unavailable — honest omission).`;
            }
            else {
                const band = delta.patches[0];
                text = `Incremental delta: content scrolled ${dy > 0 ? 'DOWN' : 'UP'} by ${Math.abs(dy)}px vs its immediate predecessor (source rows)`
                    + (band ? `; newly revealed strip: ${anchor(band)}` : '') + '.';
            }
            break;
        }
        default: // keyframe：无紧凑差分 —— 诚实申报（首帧/帧突变的降级终点）
            text = `Incremental delta: full-scene change (keyframe, generation ${delta.generation}, changed ${pct(delta.changedPct)}%) — no compact delta to carry.`;
            break;
    }
    return ' ' + text.slice(0, cap);
}
