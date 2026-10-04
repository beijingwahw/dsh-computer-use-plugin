// src/contextManager.records.ts
// W6-2（doctor smell.over-engineering 清偿）：自 contextManager.ts 低风险分区提取
// （>500 行拆分信号）—— 记录类型（TaskAnchor / ScreenshotRecord / SubconsciousTrace）
// 与纯几何/体积小函数整体搬迁。行为零变化；contextManager.ts 以再导出保持导入面不变。
// W8-A5（DEBTS D-C3 增量编码消费方）：新增 IncrementalDelta 记录字段 + 规整纯函数 +
// 驱逐摘要纯函数 —— 摘要铸造消费 codec 的锚点文本产物（patchAnchorText，三系坐标
// 并列的投递协议文本面）。依赖面从「零外部依赖」扩为仅 vlm/codec 纯函数（单向
// context → vlm，与 contextManager.ts 的 gazeRouter 导入同律；codec 不反向依赖本
// 模块，无环）。
import { cleanPatchRect, patchAnchorText } from './vlm/codec';

/**
 * W1-9（P1 任务驱动注视）：任务锚点 —— 上一轮任务目标的屏幕位置记忆。
 * 供下次编码消费：normalized 是 encodeForVlm.foveaCenter 的直接方言
 * （源图归一化 [0,1]²）；bbox/center 保留像素系原值供点击层复核。
 */
export interface TaskAnchor {
  /** 源图像素系 bbox（记录时防御规整：倒置交换、压扁扩 1px、整数化） */
  bbox: { x0: number; y0: number; x1: number; y1: number };
  /** bbox 几何中心（源图像素，不取整 —— 取整权留给点击层） */
  center: { x: number; y: number };
  /** 源图归一化中心 [0,1]²（记录时给了 viewport 才在场；缺席 = 无法归一） */
  normalized?: { x: number; y: number };
  /** 锚点来源路（'grounding' | 'diff' | 'cursor'；自定义串原样保留 —— 路由器按已知路过滤） */
  route: string;
  /** 任务相关度 [0,1]（缺省 1 —— 路由先验即分数；目标已完成可下调） */
  taskRelevance?: number;
  capturedAt: number;
  /** 锚点指向的截图 id（可选 —— 与窗口内记录解耦） */
  screenshotId?: number;
}

/** W1-9：clamp 进 [0,1]（归一化坐标的防御收口；非有限按 0 记） */
export function clampUnit(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

// W6-2（doctor smell.magic-number 清偿）：E-4 惊异加成的页面级跳变下界（dHash 位数）。
// 24/64 位 ≈ 全屏 37.5% 位翻转 —— 元素级反馈撑不满此距离，不误伤。数值逐位不变。
export const SURPRISE_BIT_FLOOR = 24;

export interface ScreenshotRecord {
  id: number;
  timestamp: number;
  base64: string; // 仅最新几张保留图片数据；置空即「已降级」（空字符串天然 falsy）
  hash?: string; // 整屏 dHash 指纹（元数据，不占图片位）：变化门控与场景匹配的事实源
  textSummary?: string; // 旧截图降级后的文本描述（B-6 起含 OCR 遗像）
  // ── C-4 认知焦点引擎 ──
  /** 显著度 0~1：类型加权 × 任务相关 × 时间衰减。驱逐顺序的事实源 */
  salience?: number;
  /** 高显著度豁免驱逐（登录态/任务目标锚点等）。名额受 pinBudget 硬顶 */
  pinned?: boolean;
  /**
   * E-4 预测误差（第五维·信息热力学）：本帧与前一帧的指纹汉明距离 ——
   * 预测残差的离散度量。≥24/64 位（≈37.5% 位翻转 = 页面级跳变）的帧
   * 在显著度评估中获得加成：「世界刚剧变的那一帧」值得注意力优先驻留。
   * 首帧/无指纹 ⇒ 缺席（无前馈即无残差 —— 诚实缺席，不伪造基线）。
   */
  surpriseBits?: number;
  /**
   * S-6/Q-2：本帧 pHash 频谱指纹（截图入窗时一次铸就，与帧同生命周期）。
   * Δ-3 修正注记：潜意识条目的 scenePhash 从这里取 —— 旧实现驱逐时误用
   * lastPhash（驱逐时刻**新入帧**的 pHash），「死者」的遗像里存的是
   * 「目击者」的指纹：既视感的第二指从根上指错了帧（victim 与新帧的
   * pHash 几乎必然不同 ⇒ 双指共识几乎必然否决 ⇒ S-6 复核通道形同虚设）。
   */
  phash?: string;
  /**
   * W8-A5（DEBTS D-C3 增量编码消费方）：本帧入窗时的增量编码判决（相对其
   * 前一帧的变化描述 —— 视觉状态账本 ScreenStateLedger 的产物或调用方显式
   * 投喂）。仅在消费开关开启（contextManager.configureIncremental）且判决
   * 干净（无降级注记）时在场；驱逐时据此铸造「遗像增补段」（几何变化随
   * 文本存活 —— 图片走了，变化留下）。缺席 = 开关关/无投喂/诚实降级，
   * 行为与 W8-A5 之前逐字节一致。
   */
  incrementalDelta?: IncrementalDelta;
}

/** C-4 潜意识元组：被驱逐记录的有损压缩残响。纯文本 + 硬容量，Token 消耗恒定 */
export interface SubconsciousTrace {
  /** 驱逐时的整屏 dHash —— 既视感（déjà-vu）匹配键 */
  sceneHash: string;
  /** ≤legacySummaryMaxChars 的遗像文本（B-6 OCR 已产出，零额外成本） */
  gist: string;
  createdAt: number;
  /** S 纪元（S-6）：pHash 第二指纹（缺席 = sharp 不可用时的单指回忆） */
  scenePhash?: string;
}

/** base64 字符数 → 近似 KB（data URL 前缀开销可忽略，预算用途足够精确） */
export function approxKb(b64: string): number {
  return b64.length / 1024;
}

// ─── W8-A5（DEBTS D-C3 增量编码消费方）：帧间增量判决的记录面与消费面 ───
//
// 背景：src/vlm/codec.ts 的 W3-3 节（补丁三系坐标 + encodePatchForVlm +
// patchAnchorText）与 visualDiff 的 ScreenStateLedger 已构成增量编码的完整
// 生产面，autonomy/runtime 也把 {verdict, delivery} 写进观察槽 —— 但观察槽
// 无人读（DEBTS D-C3「已造未通电」）。本节是其消费方：驱逐摘要改用增量编码
// 产物 —— 连续相似截图被预算驱逐时，帧间变化几何（补丁锚点/滚动向量/静默
// 判决）以有界文本随墓志铭存活。省 token（驱逐本来就在省，摘要让被省掉的
// 视觉 token 不再是纯损失）+ 保信息（「图片走了，变化留下」）。
//
// 依赖纪律：摘要铸造直接消费 codec.patchAnchorText（三系坐标并列的锚点文本
// —— 投递协议的既有产物，不另造方言）；维度缺席时诚实降级为纯源图像素列举
// （不伪造归一化坐标）。全部纯函数、绝不抛。

/** W8-A5：帧间增量判决类型（与 visualDiff.IncrementalKind 同词表 —— 值域字符串，避免 records → visualDiff 的类型耦合） */
export type IncrementalDeltaKind = 'keyframe' | 'patch' | 'scroll' | 'silent';

/** W8-A5：随 ScreenshotRecord 入窗的增量判决（防御规整后的规范形） */
export interface IncrementalDelta {
  kind: IncrementalDeltaKind;
  /** 本帧 vs 前一帧的全屏变化占比（0..100，clamp 后有限） */
  changedPct: number;
  /** patch：脏矩形清单（源图像素系，cleanPatchRect 收口后的规范形）；其余 kind 恒 [] */
  patches: Array<{ x: number; y: number; w: number; h: number }>;
  /** scroll：行移向量（源图像素；>0 = 内容下移）；其余 kind 缺席 */
  scrollDyPx?: number;
  /** 账本代数（关键帧重置计数 —— 溯源的锚点代际号） */
  generation: number;
  /** 源图像素维度（锚点归一化换算与 token 估算的基准；缺席 = 调用方未提供，诚实降级） */
  sourceWidth?: number;
  sourceHeight?: number;
}

/** W8-A5：维度体检（≥1 有限数取整；脏值 0 —— 后续判据按不可用处理，不猜） */
function w8Dim(n: unknown): number {
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
export function cleanIncrementalDelta(raw: unknown): IncrementalDelta | null {
  if (raw === null || typeof raw !== 'object') return null;
  const d = raw as {
    kind?: unknown; changedPct?: unknown; patches?: unknown;
    scroll?: unknown; generation?: unknown;
    sourceWidth?: unknown; sourceHeight?: unknown;
  };
  const KINDS = new Set<IncrementalDeltaKind>(['keyframe', 'patch', 'scroll', 'silent']);
  if (typeof d.kind !== 'string' || !KINDS.has(d.kind as IncrementalDeltaKind)) return null;
  const changedPct = typeof d.changedPct === 'number' && Number.isFinite(d.changedPct)
    ? Math.min(100, Math.max(0, d.changedPct)) : 0;
  const gen = typeof d.generation === 'number' && Number.isFinite(d.generation) && d.generation >= 0
    ? Math.floor(d.generation) : 0;
  const sw = w8Dim(d.sourceWidth);
  const sh = w8Dim(d.sourceHeight);
  const patches: Array<{ x: number; y: number; w: number; h: number }> = [];
  if (Array.isArray(d.patches)) {
    // 补丁收口画布：成对干净维度用真画布（越界收口语义完整）；缺席用开放画布
    //（只做几何规整 —— 归一化换算在摘要侧按维度缺席诚实降级）
    const canvasOk = sw >= 1 && sh >= 1;
    for (const p of d.patches.slice(0, W8_MAX_PATCHES)) {
      const c = cleanIncrementalPatch(p, canvasOk ? sw : 1 << 30, canvasOk ? sh : 1 << 30);
      if (c) patches.push(c);
    }
  }
  const sc = d.scroll as { dyPx?: unknown } | null | undefined;
  const dyPx = sc !== null && typeof sc === 'object'
    && typeof sc.dyPx === 'number' && Number.isFinite(sc.dyPx)
    ? Math.round(sc.dyPx) : undefined;
  return {
    kind: d.kind as IncrementalDeltaKind,
    changedPct,
    patches,
    ...(dyPx !== undefined ? { scrollDyPx: dyPx } : {}),
    generation: gen,
    ...(sw >= 1 && sh >= 1 ? { sourceWidth: sw, sourceHeight: sh } : {}),
  };
}

/** W8-A5 纯函数：单块补丁规整（codec.cleanPatchRect 的薄封装 —— 退化/非对象拒绝，其余收口） */
function cleanIncrementalPatch(
  p: unknown,
  canvasW: number,
  canvasH: number,
): { x: number; y: number; w: number; h: number } | null {
  if (p === null || typeof p !== 'object') return null;
  const r = p as { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
  const fin = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
  return cleanPatchRect(
    { x: fin(r.x), y: fin(r.y), w: fin(r.w), h: fin(r.h) },
    canvasW, canvasH,
  );
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
export function incrementalEvictionSummary(
  delta: IncrementalDelta | null | undefined,
  maxChars?: number,
): string {
  if (!delta || typeof delta !== 'object') return '';
  const cap = typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars >= MIN_INCREMENTAL_SUMMARY_CHARS
    ? Math.floor(maxChars) : DEFAULT_INCREMENTAL_SUMMARY_CHARS;
  const pct = (v: number): string => (Math.round(v * 10) / 10).toFixed(1);
  const dimsOk = typeof delta.sourceWidth === 'number' && delta.sourceWidth >= 1
    && typeof delta.sourceHeight === 'number' && delta.sourceHeight >= 1;
  // 锚点铸造：维度成对在场 ⇒ codec.patchAnchorText（三系并列的投递协议产物，
  // 编码系按「关键帧未缩放」的诚实假设取源图系 —— 与 codec 文档同律）；
  // 缺席 ⇒ 源图像素列举（换算基准缺席，不猜归一化）
  const anchor = (r: { x: number; y: number; w: number; h: number }): string => dimsOk
    ? patchAnchorText(r, { width: delta.sourceWidth!, height: delta.sourceHeight! }, { width: delta.sourceWidth!, height: delta.sourceHeight! })
    : `(${r.x},${r.y}) ${r.w}x${r.h} source-px`;
  let text: string;
  switch (delta.kind) {
    case 'silent':
      text = `Incremental delta: this frame was visually identical to the immediately preceding frame (pixel-diff ledger verdict: silent, changed ${pct(delta.changedPct)}%). Its pixels duplicated a frame already covered in this timeline.`;
      break;
    case 'patch': {
      if (delta.patches.length === 0) {
        text = `Incremental delta: no measurable change vs the immediately preceding frame (patch verdict with empty rect list, changed ${pct(delta.changedPct)}%).`;
      } else {
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
      } else {
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
