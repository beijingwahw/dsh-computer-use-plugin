// src/vlm/grounding.ts
// W6-2 结构性保留（doctor smell.over-engineering 登记）：视觉接地引擎 —— 坐标几何/校准/预算门控/验证共守同一接地不变量（roundtrip 精度契约），分区将增加跨文件耦合面。
// 纪元 Ω（Ω-4 视觉接地）：GLM-5.3-Flash 云脑皮层的元素接地器官 —— 截图进、
// 可点击元素（像素坐标 + 语义标签）出，本地启发元素源之外的云脑直读路径。
// 本模块是云输出的**规整与执法层**：VLM 回话是方言（bbox 可能是 4 元数组、
// id 五花八门、confidence 可能越界、label 可能缺席），全部归一为仓库标准：
//   1. bbox 数组/对象双形态 → {x0,y0,x1,y1} 像素对象，clampBbox 夹回图内
//   2. id 归一为 'e1'.. 序号（下游「点 3 号」指令的稳定语义）
//   3. confidence 夹 [0,1]；label/role 兜底字符串
//   4. nmsElements 去冗余（仓库 NMS 约定：面积降序贪心 + IoU≥0.6；ΝΩ-17 增
//      containment 第二判据：容器-内嵌对保内层抑容器）
// 失败语义与 textReader 同宗：**宁可空不可错** —— 任何一步失败返回
// ok:false + elements:[]，绝不抛异常；GLM 未配置时零网络立即降级。
// W1-8（P3 置信度门控级联注视）：grounding 出口新增 verifyGate 复核闸 ——
// 低置信 / 小目标 / 拥挤邻域三条件（满足其一）触发选择性 Zoom 复核：bbox 外扩
// 50% 裁 ROI + 2x 上采样，重跑 grounding + vlmOcr 交叉验证；两次 grounding
// 中心偏差 > 归一阈值（ΝΩ-17：720p 基准 8px × 短边/720 夹 [1,3]）且 OCR 文字
// 一致 ⇒ 取复核值，文字冲突 ⇒ 保守取原值并降置信。
// 预算封顶（每任务 8 次）防雪崩；复核 VLM 端口缺席/失败一律放行原值，绝不抛、
// 绝不阻塞（闸门评估本身零网络、零 sharp —— 未接线时行为逐字节不变）。
// W6R-A4（预算作用域化）：任务级预算账本按 verifyTaskId 键控（Map + LRU 封顶
// 64 槽防泄漏）—— 并发任务互不吃预算；缺省不传 taskId 时共用模块缺省账本，
// 与历史模块级计数行为逐字节一致（既有调用方与测试零改动）。
// W8-A6（VLM 架构债 · 依赖倒置最小形态）：本模块的云端依赖面自 GlmClient
// 具体类降为 StructuredVisionPort 窄端口（configured + chatJson）—— 多供应商
// （备选池/合议庭/复核第二意见脑）可直入，GlmClient 结构天然满足（传入处
// 零改动）；不改变任何运行时行为（现网仍传 GlmClient 实例）。
// ΝΩ-48（注视经济进 grounding + 同屏语义缓存）：① foveaCenter 可选参数
// （源图归一化 [0,1]²，在场即显式开中央凹并透传编码器 —— 缺席逐字节旧路径）；
// ② 同屏 grounding 结果会话缓存（dhash 键 + LRU(64) + TTL 30s，内核键
// grounding.semanticCache 铸入开启、缺省关——零回归）：同 dhash（汉明 0）+
// 同 question（+同脑/同坐标系）⇒ 直接回缓存，命中注记 'grounding-cache-hit'
// —— 复核闸与主调用的同屏重复上传在会话内归零。
import { getGlmClient, isGlmConfigured } from './glmClient';
import type { StructuredVisionPort } from './providers/types';
import { encodeForVlmMeta, mapBboxEncodedToOriginal, mapInsetToOriginal, type Bbox } from './codec';
import { buildGroundingSystemPrompt, buildGroundingUserPrompt } from './som';
import { kernelRegistry } from '../kernel/registry';
import { getSharp, type SharpLike } from '../_legacyDeps';
// ΝΩ-48（同屏语义缓存）：dhash 复用仓库既有感知哈希（src/perceptualHash.ts，
// 零新增依赖）—— 与 actionVerifier 的「同屏判决」同一把尺。
import { dhash } from '../perceptualHash';

export interface GroundedElement {
  /** 仓库归一序号 id（'e1'..'eN'）—— 跨模块引用的稳定锚点 */
  id: string;
  /** 元素可见文字/语义标签（VLM 方言兜底 + 超长截断） */
  label: string;
  /** 元素角色（button/textbox/link/icon...；缺席兜底 'unknown'） */
  role: string;
  /** 像素包围盒（已 clamp 回图内，x1>x0、y1>y0 有保证） */
  bbox: Bbox;
  /** 包围盒几何中心（像素，不取整 —— 取整权留给点击层） */
  center: { x: number; y: number };
  /** 置信度，已夹 [0,1]（VLM 未给则记中性 0.5，不褒不贬） */
  confidence: number;
  /** 元素来源指纹：本模块恒为 'vlm' */
  source: 'vlm';
}

export interface GroundingResult {
  ok: boolean;
  /** 失败时恒为 []（宁可空不可错） */
  elements: GroundedElement[];
  /** true 仅出现在「GLM 未配置」的零网络降级路径 */
  degraded: boolean;
  error?: string;
  latencyMs: number;
  /** 管线标签：成功为 'vlm:<编码策略>'；降级 'unconfigured'；失败 'vlm-grounding' */
  strategy: string;
  /**
   * 纪元 Γ（Γ-1）：元素坐标空间标注 —— 'original'（源图/调用方声明屏幕系：
   * 显式 width×height 直通，或编码坐标已反算回源图系）| 'encoded'（编码图系：
   * 反算基准缺席时的诚实降级）。成功路径必有；失败路径省略（elements 恒空，
   * 坐标空间无意义）。
   */
  coordinateSpace?: 'original' | 'encoded';
  /**
   * W1-8（P3 置信度门控级联注视）：复核闸报告 —— 闸门开启（缺省）且本次为
   * 主定位（非 Zoom 复核递归层）时在场；opts.verifyGate=false 显式关闭时缺席。
   * events 为空 = 无元素触发复核条件（零额外网络/零裁剪）。复核端口未接线时
   * 触发事件以 outcome:'port-absent' 放行原值（诚实降级，不静默吞）。
   */
  verifyGate?: VerifyGateReport;
  /**
   * ΝΩ-17：管线注记 —— 'truncated-partial' = 云回复在 maxTokens 处被截断、JSON
   * 不平衡，经修复解析（截到最后一个完整元素 + 补闭合二次 parse）取回**部分**
   * 元素集。部分结果优于零结果：元素照常走校验/NMS/复核闸收口。未截断时缺席。
   */
  note?: string;
}

/** W1-8：复核闸触发原因（满足其一即触发；多条件可并存） */
export type VerifyGateReason = 'confidence' | 'short-edge' | 'density';

/** W1-8：单元素复核事件 —— 触发原因 / 中心偏差 / 结论（可观测的最小载体） */
export interface VerifyGateEvent {
  /** 触发复核的元素 id（'e1'..'eN'） */
  id: string;
  /** 触发原因（可多存）：confidence<0.6 | 短边<归一阈值（ΝΩ-17：720p 基准 24px×短边/720）| 邻域候选>5 */
  reasons: VerifyGateReason[];
  /** 结论：adopted=采信复核值 | agree=两轮定位一致(≤归一阈值,720p 基准 8px)保留原值 | conflict=文字冲突保守降置信
   *  | port-absent=复核端口缺席放行 | budget-exhausted=预算封顶放行(degraded)
   *  | crop-unavailable=ROI 裁剪不可用放行 | reground-failed=复核 grounding 失败放行
   *  | no-match=复核层找不到同元素放行 | ocr-unavailable=复核 OCR 失败放行
   *  | text-unverifiable=label 无文字身份无法交叉验证 | gate-error=闸内异常兜底放行 */
  outcome:
    | 'adopted' | 'agree' | 'conflict'
    | 'port-absent' | 'budget-exhausted'
    | 'crop-unavailable' | 'reground-failed' | 'no-match'
    | 'ocr-unavailable' | 'text-unverifiable' | 'gate-error';
  /** 原/复核两轮 grounding 中心的欧氏偏差（像素，buffer 系；复核执行到匹配步后在场） */
  deviationPx?: number;
  /** 结论附注（冲突证据文本 / 失败原因 / 采信说明） */
  detail?: string;
}

/** W1-8：复核闸报告（GroundingResult.verifyGate 的载体） */
export interface VerifyGateReport {
  /** 任务级已消耗复核次数（本调用结束后）—— W6R-A4：账本按 verifyTaskId
   *  作用域化（缺省共用模块缺省账本；并发任务互不侵占） */
  budgetUsed: number;
  /** 任务级复核预算上限（模块常量 VERIFY_BUDGET_MAX；resetVerifyGateBudget(taskId?) 开新任务） */
  budgetMax: number;
  /** true = 有触发但被预算封顶放行原值（degraded 记账 —— 防雪崩） */
  budgetExhausted?: boolean;
  /** 逐元素复核事件（空数组 = 无人触发） */
  events: VerifyGateEvent[];
}

/** NMS 去冗余阈值（仓库约定：IoU≥0.6 视为同一元素的重复检出） */
const NMS_IOU = 0.6;
/**
 * ΝΩ-17：NMS containment 判据阈值 —— 包含度 = 交集面积/较小框面积（1.0 = 小框
 * 整体落在大框内）。IoU 对「容器-内嵌按钮」形态失明：完全内嵌时 IoU=面积比，
 * 0.4-0.6 带双双保留 ⇒ 下游「点 3 号」指代歧义。包含度≥0.8 且内层中心在外层
 * 内 ⇒ 内嵌语义成立；0.6-0.8 是并排控件的正常交叠带（半重叠按钮组），不吃。
 */
const NMS_CONTAINMENT_MIN = 0.8;
/**
 * ΝΩ-17：containment 面积比卫兵 —— 内层面积须 < 容器面积×0.8 才算「容器-内嵌」。
 * 论证：真容器语义（面板/分组框 ⊃ 按钮/输入框）中内层控件只占容器区域的一小
 * 部分；内层覆盖容器 >80% 面积时两者是**同一控件的近重复检出**，属 IoU 辖区
 * （缺省阈值下 IoU≥0.55 的此类对已被吸收）——调用方显式放宽 IoU 阈值（如
 * 0.99「只去全同」）时，containment 不越权代为去重（阈值放宽则双保留的既有
 * 语义保持）。
 */
const NMS_CONTAINMENT_AREA_RATIO = 0.8;
/** VLM 未给 confidence 时的中性记账值 */
const DEFAULT_CONFIDENCE = 0.5;
/** label 兜底与截断上限（对齐仓库 name 截断的防注入纪律） */
const LABEL_FALLBACK = '未知元素';
const LABEL_MAX = 80;
const ROLE_FALLBACK = 'unknown';
const ROLE_MAX = 24;
/**
 * ΝΩ-17：maxTokens 基线 —— 小图沿用历史 2048（零回归锚点；下方自适应只在
 * 源图面积超过基线配额时抬升，绝不下调）。
 */
const GROUNDING_MAX_TOKENS_BASE = 2048;
/**
 * ΝΩ-17：maxTokens 自适应上界 —— 源图每 4096px² 配 1 token 的防线：8K 屏
 * （7680×4320≈33.2Mpx²）约 8100，再大也不放宽（成本/时延上限；真密集屏的
 * 元素 JSON 远用不到 8K token，这是防御性天花板而非目标值）。
 */
const GROUNDING_MAX_TOKENS_CAP = 8192;

// ─── W1-8（P3 置信度门控级联注视）：复核闸模块常量 ───

/** W1-8：复核闸缺省开关（true = 开；调用方 opts.verifyGate=false 显式关闭）。
 *  触发条件本身很窄（低置信/小目标/拥挤邻域），缺省开启；闸门评估零网络零
 *  sharp，未接线复核端口时不产生任何副作用。 */
const VERIFY_GATE_DEFAULT_ON = true;
/** W1-8：触发阈值 —— confidence 严格小于此值触发复核（模型自报不确定） */
const VERIFY_CONFIDENCE_MIN = 0.6;
/**
 * ΝΩ-17（分辨率归一）：触发阈值 —— bbox 短边严格小于「此值×缩放」触发（小目标）。
 * 基准 24px 定义在 720p（短边 720）上；运行时按 短边/720 线性缩放并夹 [1,3]：
 * 4K（短边 2160）阈值×3=72px、1080p ×1.5=36px —— 同一物理尺寸的按钮跨分辨率
 * 严格度等效（固定 24px 会让 4K 屏整屏误触发、720p 早触发，两类屏不可比）。
 */
const VERIFY_MIN_SHORT_EDGE_BASE = 24;
/** W1-8：触发阈值 —— bbox 邻域（外扩 ROI 内）pre-NMS 候选框数严格大于此值触发（拥挤误检区） */
const VERIFY_NMS_DENSITY_MAX = 5;
/**
 * ΝΩ-17（分辨率归一）：采信阈值 —— 原/复核两轮 grounding 中心偏差（**源图
 * 像素系**）严格大于「此值×缩放」且 OCR 文字一致 ⇒ 取复核值。基准 8px@720p，
 * 按源图短边/720 夹 [1,3] 缩放：4K 上 1px ≈ 720p 的 1/3 物理尺寸，固定 8px 会让
 * 4K 复核把噪声级偏差也当改判证据（几乎必 adopted），等效严格度需 24px。
 */
const VERIFY_CENTER_DEVIATION_BASE_PX = 8;
/**
 * ΝΩ-17：分辨率归一基准短边与缩放夹区间。下限 1 —— 低于 720p 的图保持基准
 * 严格度（复核是放大重看，小图目标更糊，收紧阈值只会让全屏触发；亦保持既有
 * 小图调用方行为零回归）；上限 3 —— 4K 恰 3×，8K 以上不再放宽（巨图上阈值
 * 过宽会漏掉真小目标的复核机会）。
 */
const VERIFY_REF_SHORT_EDGE = 720;
const VERIFY_SCALE_MIN = 1;
const VERIFY_SCALE_MAX = 3;
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

/**
 * ΝΩ-17 纯函数：分辨率归一尺度 —— 短边/VERIFY_REF_SHORT_EDGE(720) 夹
 * [VERIFY_SCALE_MIN, VERIFY_SCALE_MAX]。病值（宽高缺席/非有限/小于 1）回落
 * 1（= 720p 基准，与历史固定像素阈值行为一致）。零异常。
 */
function verifyScale(w: unknown, h: unknown): number {
  const nw = typeof w === 'number' && Number.isFinite(w) ? w : 0;
  const nh = typeof h === 'number' && Number.isFinite(h) ? h : 0;
  const short = Math.min(nw, nh);
  if (short < 1) return 1;
  return Math.min(VERIFY_SCALE_MAX, Math.max(VERIFY_SCALE_MIN, short / VERIFY_REF_SHORT_EDGE));
}

/**
 * ΝΩ-17 纯函数：maxTokens 自适应 —— max(2048, ceil(源图面积/4096)) 夹
 * [2048, 8192]。以**源图**宽高（编码 meta 随行的 sourceWidth/Height）为尺而非
 * 编码后尺寸：编码长边恒钳 ≤1568（codec DEFAULT_MAX_DIMENSION），按编码后
 * 面积计算永不抬升；而回复 token 量与可见元素密度成正比，密度由源图分辨率
 * 决定（真 4K 截图的元素数 ≫ 其 1568 缩图在低分辨率源上的同屏元素数）。
 * 病值（宽高缺席）回落基线 2048。
 */
function adaptiveMaxTokens(srcW: unknown, srcH: unknown): number {
  const w = typeof srcW === 'number' && Number.isFinite(srcW) && srcW >= 1 ? srcW : 0;
  const h = typeof srcH === 'number' && Number.isFinite(srcH) && srcH >= 1 ? srcH : 0;
  if (w < 1 || h < 1) return GROUNDING_MAX_TOKENS_BASE;
  const byArea = Math.ceil((w * h) / 4096);
  return Math.min(GROUNDING_MAX_TOKENS_CAP, Math.max(GROUNDING_MAX_TOKENS_BASE, byArea));
}

// ΠΑΝ-127（D-F5 清偿）：clampBbox（含私有卫兵 finiteOr0）已下沉零出边叶
// vlm/bbox.ts —— 卫星 vlmOcr.ts 曾回借本桶此函数，与本桶动态回引 vlmOcr 的
// readTextViaVlm 复核构成感知主环 value 二环；此处再导出保导入面兼容
//（Ω-4f 数值断言照旧），本桶内部消费改 import 叶。行为零变化。
export { clampBbox } from './bbox';
import { clampBbox } from './bbox';

/** 纯函数：两 bbox 的交并比 IoU = |a∩b| / |a∪b|；不相交或退化返回 0 */
export function iouBbox(a: Bbox, b: Bbox): number {
  if (!a || !b) return 0;
  const iw = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const ih = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  const areaA = Math.max(0, a.x1 - a.x0) * Math.max(0, a.y1 - a.y0);
  const areaB = Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * ΝΩ-17 纯函数：host 是否按 containment 判据「包含」inner —— inner 几何中心
 * 落在 host 内 且 包含度（交集/较小框面积）≥ NMS_CONTAINMENT_MIN。中心包含
 * 排除「贴角探出」的并排交叠（面积交够了但中心在外 = 各占一半，非内嵌）。
 * 零异常；退化盒（非正面积）恒 false。
 */
function bboxContains(host: Bbox, inner: Bbox): boolean {
  if (!host || !inner) return false;
  const iw = Math.min(host.x1, inner.x1) - Math.max(host.x0, inner.x0);
  const ih = Math.min(host.y1, inner.y1) - Math.max(host.y0, inner.y0);
  if (iw <= 0 || ih <= 0) return false;
  const areaHost = Math.max(0, host.x1 - host.x0) * Math.max(0, host.y1 - host.y0);
  const areaInner = Math.max(0, inner.x1 - inner.x0) * Math.max(0, inner.y1 - inner.y0);
  const smaller = Math.min(areaHost, areaInner);
  if (smaller <= 0) return false;
  const cx = (inner.x0 + inner.x1) / 2;
  const cy = (inner.y0 + inner.y1) / 2;
  return (iw * ih) / smaller >= NMS_CONTAINMENT_MIN
    && cx >= host.x0 && cx <= host.x1 && cy >= host.y0 && cy <= host.y1;
}

/**
 * 纯函数：NMS 去冗余（仓库 NMS 约定：**面积降序贪心** + IoU≥iouThreshold
 * 去重，平手取先出现者 —— 与 elementTracker 同形态的确定性）。
 * 泛型约束仅需 bbox —— 接地管线中 center 尚未计算的中间形态（Omit<..., 'center'>）
 * 亦可直入；面积非正的退化元素直接滤除（无面积的盒没有几何身份，不参选）。
 * ΝΩ-17 第二判据（containment）：候选被某幸存者包含（内层中心在外层内 +
 * 包含度≥0.8 + 内层面积<容器×0.8 —— 近重复对是 IoU 辖区，不掺和）且未被 IoU
 * 抑制 ⇒ **内层替换容器**（保内层小元素、抑容器）。
 * 论证：下游消费「点 3 号」的序数指代 —— 可点击目标应是最小可交互元素；容器
 * （面板/分组框）的中心常落在空白区（内嵌按钮偏置一角时尤甚），保容器等于给
 * 点击层一个点不准的锚。替换后其余仍包含候选的中间层容器（面板>内衬>按钮链）
 * 一并让位；被替换容器此前 IoU 抑制掉的近重复不复活（宁少报不重复报）。
 * 副作用：输出不再严格面积降序（内层元素占据容器的序位）—— 消费方按 id/label
 * 引用，不赌顺序（与既有测试同律）。
 */
export function nmsElements<T extends { bbox: Bbox }>(elements: T[], iouThreshold?: number): T[] {
  // 纪元 Θ（Θ-4 生产接线）：缺省 NMS 阈值读内核注册表（grounding.nmsIou，
  // 区间 [0.4,0.8]）—— 未注册 ⇒ getOrDefault 回声 NMS_IOU(0.6)，行为逐字节
  // 不变；显式入参仍最高优先（缺省参表达式逐调用求值，同步纯读无害）。
  const threshold = iouThreshold ?? kernelRegistry.getOrDefault('grounding.nmsIou', NMS_IOU);
  if (!Array.isArray(elements)) return [];
  const ranked = elements
    .map((el, i) => ({
      el, i,
      area: Math.max(0, el.bbox.x1 - el.bbox.x0) * Math.max(0, el.bbox.y1 - el.bbox.y0),
    }))
    .filter(r => Number.isFinite(r.area) && r.area > 0)
    .sort((p, q) => q.area - p.area || p.i - q.i);
  const kept: typeof ranked = [];
  for (const cand of ranked) {
    // 既有 IoU 语义优先：候选与任一幸存者 IoU≥阈值 ⇒ 抑候选、幸存者留（历史
    // 行为逐字节不变 —— 近重复对永不被 containment 翻案）
    if (!kept.every(k => iouBbox(k.el.bbox, cand.el.bbox) < threshold)) continue;
    // ΝΩ-17 containment：候选被某幸存者包含（几何包含 + 面积比卫兵：内层显著
    // 小于容器，近重复对不掺和）⇒ 内层替换容器。面积降序保证容器先于内层到场
    // （kept 中恒有更大者），替换不破坏贪心确定性
    let hostIdx = -1;
    for (let i = 0; i < kept.length; i++) {
      if (bboxContains(kept[i]!.el.bbox, cand.el.bbox)
        && cand.area < kept[i]!.area * NMS_CONTAINMENT_AREA_RATIO) { hostIdx = i; break; }
    }
    if (hostIdx >= 0) {
      kept[hostIdx] = cand;
      // 级联让位：其余仍包含候选（同卫兵）的中间层容器一并去除（嵌套链只留最内层）
      for (let j = kept.length - 1; j >= 0; j--) {
        if (j !== hostIdx
          && bboxContains(kept[j]!.el.bbox, cand.el.bbox)
          && cand.area < kept[j]!.area * NMS_CONTAINMENT_AREA_RATIO) kept.splice(j, 1);
      }
      continue;
    }
    kept.push(cand);
  }
  return kept.map(r => r.el);
}

// ─── W1-8（P3 置信度门控级联注视）：Zoom 复核闸 —— 预算 / 裁剪 / 交叉验证 ───

/**
 * W6R-A4（预算作用域化）：任务级复核预算账本 —— 单任务跨 groundElements
 * 调用累计的计数载体。此前为模块级单一可变计数（并发任务互相吃预算的串账
 * 面）；现按 taskId 键控持有：同一 taskId 的调用链共享同一账本（单任务防
 * 雪崩语义不变），不同 taskId 互不可见（并发隔离）。缺省（不传 taskId）
 * 共用模块级缺省账本 —— 与历史行为逐字节一致（既有调用方/测试零改动）。
 */
interface VerifyBudgetLedger {
  /** 本任务已消耗的复核次数（真实下发复核 grounding 时 +1） */
  used: number;
}

/**
 * W6R-A4：任务预算账本表（taskId → 账本）。LRU 语义：命中即重插刷新位置
 * （插入序 = 最近使用序），容量封顶 VERIFY_BUDGET_LEDGER_CAP —— 超限时逐出
 * 最久未用的账本（防 Map 无界泄漏；被逐出的任务若复活则从 0 重新起账，
 * 宁可多给复核机会，不可内存漏账）。
 */
const taskBudgetLedgers = new Map<string, VerifyBudgetLedger>();

/** W6R-A4：账本表容量封顶 —— 防御式上限（真实并发任务数远低于此；溢出即 LRU 逐出） */
const VERIFY_BUDGET_LEDGER_CAP = 64;

/** W6R-A4：缺省账本 —— 不传 taskId 的既有调用方共用（历史模块级计数的等价物） */
let defaultBudgetLedger: VerifyBudgetLedger = { used: 0 };

/**
 * W6R-A4：取（或建）任务的预算账本 —— LRU 刷新 + 容量封顶逐出。
 * taskId 脏值（空串/非字符串）安静回落缺省账本（零行为变化律）。
 */
function getVerifyBudgetLedger(taskId: string | undefined): VerifyBudgetLedger {
  if (typeof taskId !== 'string' || taskId === '') return defaultBudgetLedger;
  const hit = taskBudgetLedgers.get(taskId);
  if (hit) {
    // LRU 刷新：删了重插，让插入序保持「最近使用在后」
    taskBudgetLedgers.delete(taskId);
    taskBudgetLedgers.set(taskId, hit);
    return hit;
  }
  if (taskBudgetLedgers.size >= VERIFY_BUDGET_LEDGER_CAP) {
    const oldest = taskBudgetLedgers.keys().next().value;
    if (oldest !== undefined) taskBudgetLedgers.delete(oldest);
  }
  const fresh: VerifyBudgetLedger = { used: 0 };
  taskBudgetLedgers.set(taskId, fresh);
  return fresh;
}

/**
 * W1-8：复核预算清零 —— 新任务开始时由宿主调用（防上一任务的用量雪崩进下一任务）。
 * W6R-A4 作用域化：带 taskId ⇒ 只清该任务的账本（并发任务互不干扰）；
 * 不带（历史签名）⇒ 清缺省账本 + 全部任务账本（既有调用方语义保持）。
 */
export function resetVerifyGateBudget(taskId?: string): void {
  if (typeof taskId === 'string' && taskId !== '') {
    taskBudgetLedgers.delete(taskId); // 下次触达重建为 0
    return;
  }
  defaultBudgetLedger = { used: 0 };
  taskBudgetLedgers.clear();
}

// ─── ΝΩ-48（同屏语义缓存）：dhash 键 + LRU(64) 的 grounding 会话缓存 ───
//
// 动机：复核闸与主调用的同屏重复上传 —— 同一张屏（dhash 汉明 0）被反反复复
// 编码、拨号（verifyGate 的 Zoom 复核递归层、宿主 perceive 环的相邻步）。对
// **同屏 + 同 question + 同脑 + 同坐标系**的调用，grounding 输出是纯函数 ⇒
// 会话内短窗（TTL 30s）直接回放缓照：零编码、零拨号。
//
// 开关（缺省关 —— 零回归铁律）：内核注册表键 grounding.semanticCache
// （0/1 数值语义，>0.5 即开；未注册 ⇒ getOrDefault 回声 0 = 关，连 dhash 都
// 不算，逐字节旧路径）。先例：codec.foveated / grounding.verifyZoom —— 宿主
// 以 src/index.ts 按配置铸入开启。缺省关的根据：既有契约「同输入双调必须两次
// 真实进 VLM」（W5-4⑧ 确定性幂等探针 —— 叠加+编码全链确定性的活体证据）与
// 语义回放互斥，开关权交宿主而非静默改写调用面语义。
//
// 键律（每一分量都是输出语义的输入，缺一即不可回放）：
//   · dhash（汉明 0 = 同屏）：perceptualHash.dhash，sharp 缺席/解码失败 ⇒
//     null ⇒ 缓存静默失能（绝不抛、不阻塞 —— 中央凹是增益不是依赖的同律）；
//   · client 身份（WeakMap 发号）：缓存跨脑共享会回放**别的脑**的答案 ——
//     多供应商端口（W8-A6）下不同脑对同屏可给不同结果；
//   · question / 显式 width×height / foveaCenter / verifyGate 开关：聚焦词、
//     坐标系（声明系直通 vs 编码系反算）、注视编码、闸报告形态皆随它们变。
//   · verifyTaskId/verifyBudget **不入键**：它们只调制预算记账，而记账型结果
//     本就不入缓存（下方豁免律）。
//
// 豁免律（回放的账实一致）：复核事件型结果（verifyGate.events 非空 = 本次
// 调用真实下发了 Zoom 复核、消耗了任务预算、可能就地改写了元素）**不入缓存**
// —— 回放既不重扣预算也不重跑复核 = 账实不符；且预算跨调用累计的历史语义
// （W3-B②/W8-B2 家族契约）必须逐字节保持。闸零触发（events:[]）或显式关闭
// （报告缺席）的结果无会话状态，可安全回放。
//
// 「显式 force 绕过」：groundElements 无 force 形入参（工单的预留面），宿主
// 需强制回源时关内核键 / 传不同 question / 等 TTL 过期即可 —— 不为此铸新参数。

/** ΝΩ-48：同屏缓存 TTL —— 语义等价窗口（会话级短窗，非持久层） */
const GROUNDING_CACHE_TTL_MS = 30_000;
/** ΝΩ-48：LRU 容量封顶（防 Map 无界泄漏；溢出逐出最久未用槽） */
const GROUNDING_CACHE_CAP = 64;
/** ΝΩ-48：缓存命中注记（GroundingResult.note 的保留值） */
const GROUNDING_CACHE_HIT_NOTE = 'grounding-cache-hit';

/** ΝΩ-48：缓存槽 —— 成功结果的深拷贝快照 + 写入时刻（调用方改动不回写缓存） */
interface GroundingCacheEntry {
  snapshot: GroundingResult;
  at: number;
}

const groundingCache = new Map<string, GroundingCacheEntry>();

/** ΝΩ-48：墙钟缝（生产恒 Date.now —— TTL 判定的唯一时源；测试注入见 _override） */
let groundingClock: () => number = Date.now;

/** ΝΩ-48：client 身份证 —— WeakMap 发号（对象身份 ⇒ 稳定短号；脑亡即号亡，无泄漏） */
const groundingCacheClientIds = new WeakMap<object, number>();
let groundingCacheClientSeq = 0;

function groundingCacheClientId(client: object): number {
  let id = groundingCacheClientIds.get(client);
  if (id === undefined) {
    groundingCacheClientSeq += 1;
    id = groundingCacheClientSeq;
    groundingCacheClientIds.set(client, id);
  }
  return id;
}

/** ΝΩ-48：dhash 安全包装 —— 任何失败（sharp 缺席/非图字节/解码异常）返回 null */
async function dhashSafe(buffer: Buffer): Promise<string | null> {
  try {
    const h = await dhash(buffer);
    return typeof h === 'string' && h.length > 0 ? h : null;
  } catch {
    return null;
  }
}

/**
 * ΝΩ-48：铸缓存键 —— dhash + client 身份 + question + 声明尺寸 + foveaCenter +
 * verifyGate 开关（分量语义见节首注释）。返回 null = 缓存本次失能（dhash 不可得）。
 * 零异常；foveaCenter 脏值只入键不校验（编码层是唯一裁决点，脏值路径本就失败不回填）。
 */
async function buildGroundingCacheKey(
  buffer: Buffer,
  client: StructuredVisionPort,
  opts: {
    question?: string;
    width?: number;
    height?: number;
    foveaCenter?: { x: number; y: number };
    verifyGate?: boolean;
  } | undefined,
): Promise<string | null> {
  const hash = await dhashSafe(buffer);
  if (hash === null) return null;
  const dim = (v: unknown): string =>
    typeof v === 'number' && Number.isFinite(v) && v >= 1 ? String(Math.floor(v)) : '';
  const fc = opts?.foveaCenter;
  const fcPart = fc === undefined
    ? ''
    : typeof fc.x === 'number' && Number.isFinite(fc.x) && typeof fc.y === 'number' && Number.isFinite(fc.y)
      ? `${fc.x.toFixed(4)},${fc.y.toFixed(4)}`
      : 'dirty';
  return [
    `h=${hash}`,
    `c=${groundingCacheClientId(client)}`,
    `q=${opts?.question ?? ''}`,
    `w=${dim(opts?.width)}`,
    `hh=${dim(opts?.height)}`,
    `f=${fcPart}`,
    `g=${(opts?.verifyGate ?? VERIFY_GATE_DEFAULT_ON) === true ? '1' : '0'}`,
  ].join('|');
}

/**
 * ΝΩ-48：查缓存 —— TTL 内命中 ⇒ LRU 刷新 + 快照深拷贝回放；过期 ⇒ 诚实逐出回源。
 * 深拷贝（JSON 往返）：结果形状纯数据（无函数/Date），调用方对 elements 的改动
 * 不回写缓存（快照隔离）。零异常。
 */
function lookupGroundingCache(key: string): GroundingResult | null {
  const hit = groundingCache.get(key);
  if (!hit) return null;
  if (groundingClock() - hit.at > GROUNDING_CACHE_TTL_MS) {
    groundingCache.delete(key);
    return null;
  }
  groundingCache.delete(key);
  groundingCache.set(key, hit); // LRU 刷新：插入序 = 最近使用序
  try {
    return JSON.parse(JSON.stringify(hit.snapshot)) as GroundingResult;
  } catch {
    return null; // 理论不可达（纯数据快照）—— 防御性放行回源
  }
}

/**
 * ΝΩ-48：回填缓存 —— 仅成功结果；豁免律（节首注释）：复核事件型结果不入缓存
 * （回放 ≠ 重扣预算 = 账实不符）。容量封顶 LRU 逐出最久未用槽。零异常。
 */
function storeGroundingCache(key: string, result: GroundingResult): void {
  try {
    if (result.verifyGate && result.verifyGate.events.length > 0) return;
    if (groundingCache.size >= GROUNDING_CACHE_CAP) {
      const oldest = groundingCache.keys().next().value;
      if (oldest !== undefined) groundingCache.delete(oldest);
    }
    groundingCache.set(key, {
      snapshot: JSON.parse(JSON.stringify(result)) as GroundingResult,
      at: groundingClock(),
    });
  } catch {
    /* 理论不可达 —— 快照失败安静放弃缓存（增益不是依赖） */
  }
}

/** ΝΩ-48：测试注入口 —— 缓存清零（测试隔离） */
export function _resetGroundingCache_forTest(): void {
  groundingCache.clear();
}

/** ΝΩ-48：测试注入口 —— 覆写墙钟（TTL 判定；null = 复位 Date.now） */
export function _overrideGroundingClock_forTest(clock: (() => number) | null): void {
  groundingClock = clock ?? Date.now;
}

/**
 * W1-8：Zoom 裁剪的 sharp 解析器 —— 生产恒 _legacyDeps.getSharp（懒加载纪律
 * 与 codec.ts 同源）；独立可变量仅为测试注入口服务（模拟 sharp 缺席 ⇒ 复核
 * 裁剪不可用 ⇒ 放行原值，绝不抛）。命名对齐 _legacyDeps 的 _forTest 约定。
 */
let resolveZoomSharp: () => Promise<SharpLike> = getSharp;

/** W1-8：测试注入口：覆写 Zoom 裁剪 sharp 解析器（null = 复位生产解析器） */
export function _overrideZoomSharpResolver_forTest(resolver: (() => Promise<SharpLike>) | null): void {
  resolveZoomSharp = resolver ?? getSharp;
}

/** W1-8：文字归一（与 vlmOcr.normalize 同律：小写 + 空白折叠）—— 跨模块文字比对公用尺 */
const normText = (s: unknown): string =>
  (typeof s === 'string' ? s : '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * W1-8 纯函数：bbox 每边向外扩「该维尺寸×expand/2」并 clamp 回画布整化
 * （expand=0.5 ⇒ ROI 总尺寸 = bbox×1.5）。零异常；退化输入经 clampBbox 收口。
 */
function expandRoiBox(bbox: Bbox, expand: number, width: number, height: number): Bbox {
  const mx = (bbox.x1 - bbox.x0) * expand / 2;
  const my = (bbox.y1 - bbox.y0) * expand / 2;
  return clampBbox(
    { x0: bbox.x0 - mx, y0: bbox.y0 - my, x1: bbox.x1 + mx, y1: bbox.y1 + my },
    width, height,
  );
}

/**
 * W1-8 纯函数：局部 NMS 密度 —— pre-NMS 候选池中，中心落在 target 外扩 ROI
 * 内的候选框数（含 target 自身：幸存者本身即候选之一）。拥挤邻域 = NMS 刚
 * 清理过一片重叠检出 = 定位歧义高危区，值得二次注视。
 */
function neighborhoodDensity(
  target: Bbox,
  pool: Array<{ bbox: Bbox }>,
  width: number,
  height: number,
): number {
  if (!Array.isArray(pool)) return 0;
  const roi = expandRoiBox(target, VERIFY_ROI_EXPAND, width, height);
  let n = 0;
  for (const cand of pool) {
    const b = cand?.bbox;
    if (!b) continue;
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    if (cx >= roi.x0 && cx <= roi.x1 && cy >= roi.y0 && cy <= roi.y1) n += 1;
  }
  return n;
}

/**
 * W1-8 纯函数：OCR 文字一致性 —— 归一 label 与复核 OCR 文本互为包含即一致
 * （整句包含 或 任一词与 label 互相包含 —— 多词 label 的宽容收口）。
 */
function ocrTextConsistent(
  ocr: { text: string; words: Array<{ text: string }> },
  label: string,
): boolean {
  const nl = normText(label);
  if (!nl) return false;
  if (normText(ocr.text).includes(nl)) return true;
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
async function cropUpscaleRoi(buffer: Buffer, roi: Bbox, factor: number): Promise<Buffer | null> {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
    if (!(factor >= 1)) return null; // 病值防御：非有限/小于 1 的倍数无放大语义
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
  } catch {
    return null; // 诚实降级：裁剪失败不毒化主结果
  }
}

/** W1-8：runVerifyGate 的上下文（groundElements 出口一次性打包，纯数据传递） */
interface VerifyGateContext {
  /** 源截图 buffer（ROI 裁剪的原料） */
  buffer: Buffer;
  /** 最终元素集（adopted/conflict 路径就地改写 bbox/center/confidence） */
  elements: GroundedElement[];
  /** 与 elements 对齐的提示词系 bbox（NMS 幸存者的反算前形态 —— 密度统计系） */
  promptBoxes: Bbox[];
  /** pre-NMS 候选池（提示词系 —— 密度统计的原始素材） */
  candidatePool: Array<{ bbox: Bbox }>;
  /** 提示词坐标系尺寸（模型作答的画布） */
  promptW: number;
  promptH: number;
  /** 输出坐标系尺寸（backmap ⇒ 源图系；否则声明/编码系） */
  outW: number;
  outH: number;
  /** 源图（buffer 像素）尺寸 —— ROI 裁剪与偏差度量的公共坐标系 */
  srcW: number;
  srcH: number;
  /** W1-8：复核用 VLM 端口（显式接线才复核；缺席 ⇒ 触发事件 port-absent 放行）。
   *  W8-A6：类型自 GlmClient 降为 StructuredVisionPort —— 第二意见脑可直入 */
  verifyClient: StructuredVisionPort | undefined;
  /** W6R-A4：任务级预算账本（按 opts.verifyTaskId 键控；缺省共用模块缺省账本）——
   *  并发任务各持各账，互不侵占；单任务内跨调用累计 + VERIFY_BUDGET_MAX 封顶不变 */
  ledger: VerifyBudgetLedger;
  /** 本调用复核次数上限（opts.verifyBudget；Infinity = 仅任务级封顶） */
  callBudget: number;
  /** 聚焦问题（复核 grounding 透传 —— 注视同一目标） */
  question?: string;
  /** 复核递归深度（防闸内自递归；主定位恒 0） */
  depth: number;
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
 *   · 保守裁决：文字冲突 ⇒ 原值保留 + 置信折半 + 冲突证据入事件；偏差 ≤归一
 *     阈值（ΝΩ-17：720p 基准 8px × 源图短边/720）且文字一致 ⇒ 两轮一致，保留
 *     原值（agree）；偏差 >归一阈值 且文字一致 ⇒ 采信复核值（adopted，
 *     confidence 取两轮最大 —— 交叉验证抬升可信度）。
 * 元素 id/label/role 恒不改动（下游「点 3 号」引用锚点稳定）。
 */
async function runVerifyGate(ctx: VerifyGateContext): Promise<VerifyGateReport> {
  const report: VerifyGateReport = { budgetUsed: ctx.ledger.used, budgetMax: VERIFY_BUDGET_MAX, events: [] };
  let callUsed = 0;
  // buffer 系 ⇄ 输出系换算（源图宽高恒 ≥1 —— encodeForVlmMeta 契约；病值兜底 1:1）
  const sx = ctx.srcW >= 1 ? ctx.outW / ctx.srcW : 1;
  const sy = ctx.srcH >= 1 ? ctx.outH / ctx.srcH : 1;
  const BW = Math.max(1, Math.floor(ctx.srcW));
  const BH = Math.max(1, Math.floor(ctx.srcH));
  // ΝΩ-17（分辨率归一）：阈值按坐标系短边缩放 —— short-edge 触发判据在输出系
  // （el.bbox 所在系），中心偏差采信判据在源图 buffer 系（best.dev 的度量系）
  const minShortEdgeTrigger = VERIFY_MIN_SHORT_EDGE_BASE * verifyScale(ctx.outW, ctx.outH);
  const deviationAdoptPx = VERIFY_CENTER_DEVIATION_BASE_PX * verifyScale(BW, BH);

  for (let i = 0; i < ctx.elements.length; i++) {
    const el = ctx.elements[i]!;
    // ── 触发条件（满足其一；阈值全部模块常量）──
    const reasons: VerifyGateReason[] = [];
    if (el.confidence < VERIFY_CONFIDENCE_MIN) reasons.push('confidence');
    const shortEdge = Math.min(el.bbox.x1 - el.bbox.x0, el.bbox.y1 - el.bbox.y0);
    // ΝΩ-17：短边阈值随输出系短边缩放（720p 基准 24px；4K ×3 —— 跨分辨率等效）
    if (shortEdge < minShortEdgeTrigger) reasons.push('short-edge');
    const density = neighborhoodDensity(
      ctx.promptBoxes[i] ?? el.bbox, ctx.candidatePool, ctx.promptW, ctx.promptH,
    );
    if (density > VERIFY_NMS_DENSITY_MAX) reasons.push('density');
    if (reasons.length === 0) continue;

    // 事件预挂 'gate-error' 兜底结论（下方每个分支都会覆写 —— 若未来新增路径
    // 漏写结论，事件以 gate-error 诚实暴露而非 undefined 裸奔）
    const ev: VerifyGateEvent = { id: el.id, reasons, outcome: 'gate-error' };
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
      const roi = expandRoiBox(
        { x0: el.bbox.x0 / sx, y0: el.bbox.y0 / sy, x1: el.bbox.x1 / sx, y1: el.bbox.y1 / sy },
        VERIFY_ROI_EXPAND, BW, BH,
      );
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
        if (re.error) ev.detail = re.error.slice(0, 120);
        continue;
      }

      // ── 匹配：复核元素（ROI 系）→ buffer 系，标签相等优先、次 IoU、再取近 ──
      const elBuf: Bbox = { x0: el.bbox.x0 / sx, y0: el.bbox.y0 / sy, x1: el.bbox.x1 / sx, y1: el.bbox.y1 / sy };
      const elC = { x: (elBuf.x0 + elBuf.x1) / 2, y: (elBuf.y0 + elBuf.y1) / 2 };
      let best: { score: number; dev: number; cand: GroundedElement; box: Bbox } | null = null;
      for (const cand of re.elements) {
        const box: Bbox = {
          x0: roi.x0 + cand.bbox.x0 / VERIFY_UPSAMPLE,
          y0: roi.y0 + cand.bbox.y0 / VERIFY_UPSAMPLE,
          x1: roi.x0 + cand.bbox.x1 / VERIFY_UPSAMPLE,
          y1: roi.y0 + cand.bbox.y1 / VERIFY_UPSAMPLE,
        };
        const iou = iouBbox(box, elBuf);
        const labelHit = normText(cand.label) === normText(el.label) && normText(el.label) !== '';
        if (!labelHit && iou <= 0) continue; // 既不同名也不重叠 ⇒ 不是同一元素
        const c = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
        const dev = Math.hypot(c.x - elC.x, c.y - elC.y);
        const score = (labelHit ? 10 : 0) + iou - dev / 1e6; // 标签 > IoU > 近者，平手取先
        if (!best || score > best.score) best = { score, dev, cand, box };
      }
      if (!best) {
        ev.outcome = 'no-match';
        continue;
      }
      ev.deviationPx = Math.round(best.dev * 100) / 100;

      // ── vlmOcr 交叉验证（复核端口；只读复用，懒加载避免静态环引）──
      const { readTextViaVlm } = await import('./vlmOcr');
      const ocr = await readTextViaVlm(roiBuf, { client: ctx.verifyClient });
      if (!ocr.ok) {
        ev.outcome = 'ocr-unavailable';
        if (ocr.error) ev.detail = ocr.error.slice(0, 120);
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
      if (best.dev > deviationAdoptPx) {
        // ΝΩ-17：偏差 > 归一阈值（720p 基准 8px × 源图短边/720）且文字一致
        // ⇒ 取复核值（几何回输出系 + clamp 收口整化）
        const nb = clampBbox(
          { x0: best.box.x0 * sx, y0: best.box.y0 * sy, x1: best.box.x1 * sx, y1: best.box.y1 * sy },
          ctx.outW, ctx.outH,
        );
        el.bbox = nb;
        el.center = { x: (nb.x0 + nb.x1) / 2, y: (nb.y0 + nb.y1) / 2 };
        el.confidence = Math.min(1, Math.max(el.confidence, best.cand.confidence));
        ev.outcome = 'adopted';
        continue;
      }
      // 文字一致且偏差 ≤8px ⇒ 两轮定位一致，保留原值
      ev.outcome = 'agree';
    } catch (err) {
      // 绝不抛铁律的闸内兜底：未知异常 ⇒ 放行原值 + 事件记账
      ev.outcome = 'gate-error';
      ev.detail = (err instanceof Error ? err.message : String(err)).slice(0, 120);
    }
  }
  return report;
}

// ─── VLM 原始方言的解析与归一 ───

/** VLM 单元素的原始方言（云输出不可信，字段一律按 unknown 收） */
type RawElement = Record<string, unknown>;

/** bbox 双形态解析：[x0,y0,x1,y1] 数组或 {x0,y0,x1,y1} 对象；非法返回 null */
function parseBbox(raw: unknown): Bbox | null {
  let ns: unknown[];
  if (Array.isArray(raw)) {
    if (raw.length < 4) return null;
    ns = [raw[0], raw[1], raw[2], raw[3]];
  } else if (raw !== null && typeof raw === 'object') {
    const o = raw as RawElement;
    ns = [o.x0, o.y0, o.x1, o.y1];
  } else {
    return null;
  }
  if (!ns.every(n => typeof n === 'number' && Number.isFinite(n))) return null;
  return { x0: ns[0] as number, y0: ns[1] as number, x1: ns[2] as number, y1: ns[3] as number };
}

/**
 * ΝΩ-17 纯函数：截断修复解析 —— 云回复被 maxTokens 拦腰截断时 JSON 不平衡，
 * chatJson 的平衡提取失败，但其 raw 仍载有完整的前缀元素。策略：字符串/转义
 * 感知地扫描 elements 数组体，截到最后一个**完整闭合**的元素末位，补 ']'（
 * wrapper 方言 {"elements":[...]} 需再补 '}'）二次 parse，取部分元素集。两种
 * 方言都收（定位数组起点优先找 "elements" 键后的 '['，退化找首个 '['）；开
 * 头 ``` 围栏剥除（截断时闭围栏大概率缺席）。label 内含 ']'/'}' 由字符串态
 * 卫兵消化。零完整元素 / 两种闭合都 parse 失败 ⇒ null（调用方维持原失败语义）。
 * 零异常、零副作用；只读 raw。
 */
function repairTruncatedElements(raw: unknown): unknown[] | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const text = raw.replace(/^\s*```[A-Za-z0-9_-]*[ \t]*\r?\n?/, ''); // 开围栏剥除
  let arrStart = -1;
  const keyIdx = text.indexOf('"elements"');
  if (keyIdx >= 0) {
    const open = text.indexOf('[', keyIdx + 10);
    if (open >= 0) arrStart = open;
  }
  if (arrStart < 0) arrStart = text.indexOf('[');
  if (arrStart < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let lastEnd = -1; // 最后一个完整闭合元素（相对数组内部 depth 归零）的末位
  for (let i = arrStart + 1; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) lastEnd = i + 1;
      else if (depth < 0) break; // 意外越过数组尾（截断点后噪声）—— 停扫
    }
  }
  if (lastEnd < 0) return null;
  const slice = text.slice(0, lastEnd);
  for (const closer of [']', ']}']) {
    try {
      const parsed: unknown = JSON.parse(slice + closer);
      const arr = Array.isArray(parsed)
        ? parsed
        : (parsed as RawElement | null)?.elements;
      if (Array.isArray(arr)) return arr;
    } catch { /* 试下一闭合形态 */ }
  }
  return null;
}

/** 字符串兜底：非字符串/空白 → fallback；超长截断（防注入纪律） */
function strOr(raw: unknown, fallback: string, max: number): string {
  if (typeof raw !== 'string') return fallback;
  const s = raw.trim();
  return s.length === 0 ? fallback : s.slice(0, max);
}

/** confidence 兜底：非数字 → 中性 0.5；数字夹 [0,1]（越界值不外溢） */
function confOr(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_CONFIDENCE;
  return Math.min(1, Math.max(0, raw));
}

/** 尺寸裁决：调用方显式像素尺寸优先（屏坐标语义），缺省回编码结果 */
function pickDim(preferred: unknown, fallback: number): number {
  if (typeof preferred === 'number' && Number.isFinite(preferred) && preferred >= 1) return preferred;
  return typeof fallback === 'number' && Number.isFinite(fallback) && fallback >= 1 ? fallback : 0;
}

/**
 * 视觉接地主入口：截图 Buffer → 云脑 → 规整化可点击元素集。
 *
 * 管线：isGlmConfigured 哨兵（未配置且未注入 client ⇒ 零网络立即降级，
 * 不拨号不编码）→（ΝΩ-48：同屏语义缓存命中 ⇒ 直接回放 + note
 * 'grounding-cache-hit'，零编码零拨号）→ encodeForVlmMeta 编码（纪元 Γ：
 * 源图宽高随行；ΝΩ-48：foveaCenter 在场即中央凹注视编码）→ som 接地
 * 提示词组装 → client.chatJson →（ΝΩ-17：截断时修复解析取部分元素 + note
 * 'truncated-partial'）→ 逐元素校验（id 归一 'e1'..、bbox 双形态转
 * 对象、clampBbox、confidence 夹 [0,1]、label/role 兜底；非法元素被过滤）→
 * nmsElements 去冗余 → 坐标反算（纪元 Γ-1：未声明尺寸时编码系 → 源图系）
 * → 计算中心点。任何一步失败返回 ok:false + error，elements 恒为 []。
 */
export async function groundElements(buffer: Buffer, opts?: {
  width?: number; height?: number;   // 屏幕/图像像素尺寸（缺省从编码结果取）
  question?: string;                 // 聚焦问题（如"找到设置入口"）
  /** 云脑端口 —— W8-A6：自 GlmClient 降为 StructuredVisionPort（GlmClient 结构
   *  天然满足，传入处零改动；备选池/合议庭脑亦可直入）；缺省 getGlmClient() */
  client?: StructuredVisionPort;
  /** W1-8：复核闸开关（false = 显式关闭；缺省开 —— 触发条件本身很窄） */
  verifyGate?: boolean;
  /** W1-8：复核用 VLM 端口（Zoom 复核的 grounding+OCR 都走此端口；缺省无 ⇒
   *  触发后以 port-absent 放行原值 —— 显式接线的降级安全设计，主 client 不被
   *  复核流量打扰；宿主可传同一 client 或独立第二意见脑）。W8-A6：同为端口面 */
  verifyClient?: StructuredVisionPort;
  /** W1-8：本调用复核次数上限（与任务级预算取更严者；缺省仅任务级封顶） */
  verifyBudget?: number;
  /** W6R-A4：任务级预算作用域键 —— 同键调用链共享一份复核预算（单任务 8 次
   *  防雪崩），异键并发任务互不侵占（修复模块级全局预算的串账面）。缺省
   *  （不传/空串）共用模块缺省账本，行为与历史逐字节一致。账本表 LRU 封顶
   *  64 槽防泄漏；新任务以 resetVerifyGateBudget(taskId) 定点清零 */
  verifyTaskId?: string;
  /**
   * ΝΩ-48（注视经济进 grounding）：注视中心 —— **源图归一化系 [0,1]²**（与
   * encodeForVlm.foveaCenter / gazeRouter 输出同方言，直供）。**在场即显式开
   * 中央凹编码**（foveated:true 压过注册表 —— 注视点与中央凹是同一决策的两面，
   * 只有注视点而无中央凹没有语义）；模式（blur/inset）与窗参数仍由注册表缺省
   * 管辖。越界分量由 codec clamp 回 [0,1]，非有限分量 codec 诚实拒绝（ok:false
   * 上浮）。缺席时不向编码器传 foveated/foveaCenter —— 注册表管辖，缺省路径
   * 逐字节不变（铁律锚点）。
   * 坐标反算链自动消化两种模式：blur（几何不变，坐标空间不动）/ inset
   * （mapInsetToOriginal 分段反算 —— 凹窗内 1:1 原生、窗外按缩图实际比值，
   * insetExtract 随行注视偏置精确反算）。调用方（orchestration/autonomy）后
   * 续接线，本次只铸能力面；API 向后兼容（可选参数）。
   */
  foveaCenter?: { x: number; y: number };
  /** @internal W1-8：复核递归深度（闸内重入标记，外部勿用） */
  _zoomDepth?: number;
}): Promise<GroundingResult> {
  const t0 = Date.now();
  const fail = (error: string, strategy: string, degraded = false): GroundingResult =>
    ({ ok: false, elements: [], degraded, error, latencyMs: Date.now() - t0, strategy });
  try {
    // 0) 配置哨兵：未配置且未注入测试 client ⇒ 零网络降级（不拨号、不编码）
    let client: StructuredVisionPort;
    if (opts?.client) {
      client = opts.client;
    } else {
      if (!isGlmConfigured()) return fail('GLM 未配置（缺 API Key）—— 零网络降级', 'unconfigured', true);
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

    // ── ΝΩ-48（同屏语义缓存）：命中 ⇒ 整管线短路（零编码零拨号）──
    // 开关读内核注册表 grounding.semanticCache（缺省 0=关 —— 未注册零行为
    // 变化、连 dhash 都不算；键律与豁免律见缓存节注释）。dhash + question +
    // 坐标系参数 + client 身份为键；命中回放缓照并注记 'grounding-cache-hit'。
    // dhash 不可得（sharp 缺席/非图）⇒ null ⇒ 缓存静默失能，绝不抛。
    const cacheWanted = kernelRegistry.getOrDefault('grounding.semanticCache', 0) > 0.5;
    const cacheKey = cacheWanted ? await buildGroundingCacheKey(buffer, client, opts) : null;
    if (cacheKey !== null) {
      const cached = lookupGroundingCache(cacheKey);
      if (cached) {
        return { ...cached, note: GROUNDING_CACHE_HIT_NOTE, latencyMs: Date.now() - t0 };
      }
    }

    // ΝΩ-48（注视经济）：foveaCenter 在场即显式开中央凹并透传注视中心（blur/
    // inset 由注册表 foveaMode 管辖）；缺席不传 —— 缺省路径逐字节不变。
    const enc = await encodeForVlmMeta(buffer, opts?.foveaCenter !== undefined
      ? { foveated: true, foveaCenter: opts.foveaCenter }
      : undefined);
    if (!enc.ok || !enc.value) return fail(enc.error ?? '截图编码失败', 'vlm-grounding');
    const encoded = enc.value;
    const strategy = `vlm:${encoded.strategy}`;

    // 2) 尺寸裁决：显式像素尺寸优先，缺省取编码结果
    const width = pickDim(opts?.width, encoded.width);
    const height = pickDim(opts?.height, encoded.height);
    if (width < 1 || height < 1) return fail('图像尺寸不可得', strategy);

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
    //    ΝΩ-17：maxTokens 按源图面积自适应（编码 meta 的 sourceWidth/Height）——
    //    固定 2048 在密集屏（百级元素 × 每元素 ~40-60 token）必截断，截断即
    //    JSON 不平衡即整次接地归零；自适应只抬不降（小图恒 2048，零回归）
    const req = {
      images: [{ base64: encoded.base64, mime: encoded.mime }],
      system: buildGroundingSystemPrompt(),
      prompt: buildGroundingUserPrompt({ width, height, question: opts?.question }),
      jsonMode: true,
      temperature: 0.1,   // 接地要坐标精度，不要发散
      maxTokens: adaptiveMaxTokens(srcW, srcH),
    };

    // 4) 云脑往返
    const res = await client.chatJson<{ elements?: unknown }>(req);
    // 双方言收窄：som 提示词勒令裸 JSON 数组、ensemble 供词强写 {elements:[...]}——
    // 云输出按这两种形态都收（漏一种 = 该方言下的接地恒失败）
    let rawEls: unknown[] | null = null;
    let truncatedPartial = false;
    if (res.ok) {
      const v: unknown = res.value;
      const els = Array.isArray(v) ? v : (v as RawElement | undefined)?.elements;
      rawEls = Array.isArray(els) ? els : null;
    } else {
      // ΝΩ-17 截断修复解析：chatJson 失败（截断 ⇒ JSON 不平衡；端口契约
      // VisionJsonReply 不透出 finishReason，不平衡即唯一可观测截断信号）但
      // raw 载有完整前缀元素时，补闭合二次 parse 取部分元素集 —— 部分结果优于
      // 零结果（下游 NMS/复核闸天然消化部分集）；零完整元素不采信空修复
      const repaired = repairTruncatedElements(res.raw);
      if (repaired !== null && repaired.length > 0) {
        rawEls = repaired;
        truncatedPartial = true;
      }
    }
    if (rawEls === null) {
      return fail(
        res.ok ? 'GLM 输出缺 elements 数组' : (res.error ?? 'GLM 接地调用失败'),
        strategy,
      );
    }

    // 5) 逐元素校验规整（非法元素被过滤 —— 宁可少报，不可错报）
    const validated: Array<Omit<GroundedElement, 'center'>> = [];
    for (const raw of rawEls) {
      if (raw === null || typeof raw !== 'object') continue;
      const o = raw as RawElement;
      const bbox = parseBbox(o.bbox);
      if (!bbox) continue;
      validated.push({
        id: `e${validated.length + 1}`,   // id 归一为 e1.. 序号
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
    const promptBoxes: Bbox[] = kept.map(el => el.bbox);
    const elements: GroundedElement[] = kept.map(el => {
      let bbox: Bbox;
      if (insetActive && backmap) {
        const p0 = mapInsetToOriginal(el.bbox.x0, el.bbox.y0, encoded);
        const p1 = mapInsetToOriginal(el.bbox.x1, el.bbox.y1, encoded);
        bbox = clampBbox({ x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y }, srcW, srcH);
      } else if (backmap) {
        bbox = clampBbox(
          mapBboxEncodedToOriginal(el.bbox, encoded.width, encoded.height, srcW, srcH),
          srcW, srcH,
        );
      } else {
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
    let verifyGate: VerifyGateReport | undefined;
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
    const result: GroundingResult = {
      ok: true,
      elements,
      degraded: false,
      latencyMs: Date.now() - t0,
      strategy,
      // 纪元 Γ：声明系直通或反算成立 ⇒ 'original'；反算基准缺席 ⇒ 诚实 'encoded'
      coordinateSpace: declared || backmap ? 'original' : 'encoded',
      // W1-8：复核闸报告（闸开时恒在场；events 空 = 无人触发）
      ...(verifyGate ? { verifyGate } : {}),
      // ΝΩ-17：截断修复解析救回部分元素时的如实注记（部分结果的可观测性）
      ...(truncatedPartial ? { note: 'truncated-partial' } : {}),
    };
    // ΝΩ-48：成功结果回填会话缓存（复核事件型豁免 —— 见 storeGroundingCache）
    if (cacheKey !== null) storeGroundingCache(cacheKey, result);
    return result;
  } catch (err) {
    // 绝不抛异常：未知异常（含注入物炸裂）也收敛为失败结果
    return fail(err instanceof Error ? err.message : '接地管线未知异常', 'vlm-grounding');
  }
}
