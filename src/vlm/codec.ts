// src/vlm/codec.ts
// 纪元 Ω（Ω-2）：GLM-5.3-Flash 云脑皮层 —— VLM 图像编码 / 任务级配额 / 视觉 Token 估算。
// 纪元 Γ（注视经济）：坐标反算基准（mapEncodedToOriginal / encodeForVlmMeta）+
// 中央凹加权编码（foveatedEncoding：中央原生、外围低清 —— 单位 VLM token 的
// 信息增益最大化；坐标空间不变，外围只是模糊，无需分段坐标映射）。
// 纪元 Γ2（注视经济 · inset 模式）：兑现 Γ 未竟的 token 承诺 —— blur 模式中央
// 更可读但输出尺寸不变 ⇒ estimateVlmTokens 一分不省；inset 模式让主图按
// 1/foveaPeripheryScale 真降采样（输出=缩图尺寸 ⇒ token 按 1/scale² 骨跌），
// 中央凹窗以**原生分辨率**合成回缩图中心（中央原生密度、四周 1/scale 密度）。
// 分段坐标映射（mapInsetToOriginal）保证 grounding/OCR 坐标仍可精确反算；
// 诚实边界：inset 窗外的定位精度随降采样损失（外围 1px 缩图误差 ⇒ ≤scale px
// 源图误差）—— 这正是「中央凹」的生物学语义：注视点外本来就不精确。
//
// W1-9（视觉经济包）：
//   P1 任务驱动注视 —— foveaCenter 可选参数（源图归一化 [0,1]²，缺省 = 几何中心，
//   缺省路径逐字节不变）：blur/inset 两级的注视窗按窗心放置，inset 的原生提取
//   原点随行 insetExtract 供 mapInsetToOriginal 精确反算（正反算闭环）；配套
//   gazeRouter 三路候选纯函数（grounding/diff/cursor 按任务相关度加权取 Top-1，
//   全缺席 ⇒ 几何中心）。
//   C4 预算弹性调度 —— VlmBudget.requote(remainingSteps)：按剩余配额/预估剩余
//   步数算「每步可花额度」，产出建议编码参数分档（quality 80→60、maxDim
//   1568→1024 两级钳制，配额充裕返回原档）；建议性消费 + 连续 N 次一致才切换
//   的防抖。绝不抛、缺省路径零行为变化。
//
// 职责（兄弟模块按精确契约依赖，签名一字不可偏离）：
//   1. encodeForVlm：任意截图 Buffer → VLM 最佳分辨率带宽内的 base64 JPEG
//      （长边默认 1568；可选像素坐标兴趣区先裁剪再编码）
//   2. VlmBudget：任务级视觉预算闸门（默认 200 张 / 512MB），check/commit
//      两段式 —— 超支在下发前被拒绝，而非事后补救
//   3. estimateVlmTokens：分辨率 → 视觉 Token 估算（宽高各封顶 2000 后
//      (w*h)/750 向上取整）—— 上下文窗口的记账尺
//   4. 纪元 Γ：mapEncodedToOriginal 纯函数反算（编码图像素 → 源图像素，
//      round + clamp 图内）；encodeForVlmMeta 元信息通道（源图宽高 / 裁剪窗 /
//      foveated 标志随编码结果一并返回 —— grounding / vlmOcr 坐标反算的基准）
//
// 依赖纪律：sharp 经 src/_legacyDeps.ts 懒加载（复用 textReader.ts 先例，
// 批次 E 模式，不新增 npm 依赖）；sharp 不可用时走降级路径 —— 返回
// {ok:false,error}，**绝不抛错**：云脑缺席不能带崩本地反射层。
import { getSharp, type SharpChainLike, type SharpLike } from '../_legacyDeps';
import { kernelRegistry } from '../kernel/registry';

/** VLM 最佳分辨率带宽：长边超过则等比缩小（细节分辨率与视觉 Token 的平衡点） */
const DEFAULT_MAX_DIMENSION = 1568;
/** JPEG 默认质量（80：UI 文字边缘清晰且体积可控） */
const DEFAULT_QUALITY = 80;
/** 任务级默认配额：200 张 / 512MB（云脑单任务的视觉预算上限） */
const DEFAULT_MAX_IMAGES = 200;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
/** 纪元 Γ：中央凹方窗边长占编码图短边比例缺省（0.5 —— 中央 1/4 面积原生保留） */
const DEFAULT_FOVEA_SIZE = 0.5;
/** 纪元 Γ：外围降采样因子缺省（2 —— 外围先缩 1/2 再放回，低清模糊化） */
const DEFAULT_PERIPHERY_SCALE = 2;
/** 纪元 Γ2：inset 模式的 scale 夹取上界（4 —— 更激进的降采样使凹窗占满缩图、语义退化） */
const INSET_SCALE_MAX = 4;

/** 像素坐标兴趣区：左上角 (x0,y0) 与右下角 (x1,y1)，须满足 x1>x0、y1>y0 且落在图像范围内 */
export interface Bbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** VLM 就绪图像：base64 JPEG + 实际编码后的尺寸与字节量 + 采用的策略标签 */
export interface EncodedImage {
  base64: string;
  mime: string;
  width: number;
  height: number;
  /** JPEG 二进制字节数（base64 编码前）—— VlmBudget 记账即用此值 */
  bytes: number;
  /** 实际采用的编码策略：'as-is' | 'crop' | 'resize-<N>' | 'crop+resize'（纪元 Γ：blur 中央凹生效时追加 '+fovea'；纪元 Γ2：inset 生效时追加 '+inset'） */
  strategy: string;
  /** 纪元 Γ：编码源图（region 裁剪**前**的原图）像素宽 —— 坐标反算的基准；缺席 = 未知 */
  sourceWidth?: number;
  /** 纪元 Γ：编码源图像素高（同上） */
  sourceHeight?: number;
  /** 纪元 Γ：本次是否实际采用中央凹加权（false/缺席 = 均质编码 —— 开关关或诚实降级） */
  foveated?: boolean;
  /** 纪元 Γ：生效的兴趣区整数矩形（原图坐标系）；未裁剪 = null —— 反算的平移基准 */
  cropRect?: { left: number; top: number; width: number; height: number } | null;
  /**
   * 纪元 Γ2：本次中央凹的实际模式 —— 'blur'（Γ 缺省：坐标空间不变，外围模糊）
   * | 'inset'（Γ2：输出=缩图尺寸，中央原生密度嵌入）。仅 foveated:true 时在场；
   * 缺席 = 均质编码或 Γ 老结果（消费端按 blur 语义处理，零破坏）。
   */
  foveaMode?: 'blur' | 'inset';
  /**
   * 纪元 Γ2：凹窗在**缩图坐标系**下的整数矩形（inset 模式独有；缩图 = 最终输出图）。
   * 凹窗占位 = 凹窗尺寸（不缩）—— 窗内像素与原生编码图 1:1 对应（原生密度）。
   */
  insetRect?: { x: number; y: number; w: number; h: number };
  /** 纪元 Γ2：外围降采样因子（inset 实际生效值，已夹 [1,4]；缩图 = 原生编码图/insetScale） */
  insetScale?: number;
  /**
   * 纪元 Γ2：inset 前的原生编码图维度（= 裁剪+resize 后、jpeg 前的编码图尺寸空间）。
   * mapInsetToOriginal 的精确反算基准：凹窗居中提取的原点 = floor((insetNative − 窗边长)/2)
   * 不可从缩图维度 + 名义 scale 无损重建（rounding 残差），故随行记录。
   * W1-9（任务驱动注视）：居中提取律仅对几何中心缺省成立 —— 注视窗偏置时提取
   * 原点随 foveaCenter 漂移，改由 insetExtract 随行承载（见下）。
   */
  insetNative?: { width: number; height: number };
  /**
   * W1-9（P1 任务驱动注视）：凹窗在**原生编码图**上的提取原点（inset 模式随行）。
   * 缺省几何中心时 = 居中提取律 floor((insetNative − 窗边长)/2)（与老语义恒等）；
   * foveaCenter 偏置时按注视点 clamp 进画布。mapInsetToOriginal 的首选反算基准
   * （缺席/脏值 ⇒ 诚实回退居中提取律推导，老元信息零回归）。
   */
  insetExtract?: { x: number; y: number };
  /**
   * W1-9（P1 任务驱动注视）：本次生效的注视中心（**源图归一化系 [0,1]²**，
   * 裁剪前总画布）。仅调用方显式提供 foveaCenter 且中央凹实际生效时在场；
   * 缺席 = 几何中心（Γ/Γ2 老语义，可观测面零噪音）。
   */
  foveaCenter?: { x: number; y: number };
}

/**
 * 纪元 Γ（Γ-1）：编码结果的元信息视图 —— sourceWidth/Height/foveated/cropRect
 * 由 encodeForVlmMeta 保证在场（核心编码路径恒计算，这里类型收窄为必填）。
 * grounding / vlmOcr 的坐标反算以本视图为基准：编码图坐标 → 源图坐标。
 */
export interface EncodedImageMeta extends EncodedImage {
  /** 编码源图（region 裁剪前）像素宽 */
  sourceWidth: number;
  /** 编码源图（region 裁剪前）像素高 */
  sourceHeight: number;
  /** 本次是否实际采用中央凹加权编码 */
  foveated: boolean;
  /** 生效的兴趣区整数矩形（原图坐标系）；未裁剪 = null */
  cropRect: { left: number; top: number; width: number; height: number } | null;
}

/** 字节规整：非有限/负值按 0 记（防御外部记账脏数据，绝不抛错） */
function cleanBytes(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

// ─── 纪元 Γ：sharp 解析器注入缝（生产恒 _legacyDeps.getSharp） ───

/**
 * sharp 解析器：生产路径恒为 _legacyDeps.getSharp（懒加载 + 错误记忆）。
 * 独立成模块级可变量仅为测试注入口服务 —— 见 _overrideSharpResolver_forTest。
 */
let resolveSharp: () => Promise<SharpLike> = getSharp;

/**
 * 测试注入口：覆写 sharp 解析器（null = 复位回生产解析器）。
 * 用途：模拟 sharp 缺席（注入抛错器）或残废链（composite 抛错）—— 验证
 * 中央凹编码的诚实降级路径（foveated:false / ok:false，绝不抛）。
 * 生产代码零调用；命名对齐 _legacyDeps 的 _forTest 约定。
 */
export function _overrideSharpResolver_forTest(resolver: (() => Promise<SharpLike>) | null): void {
  resolveSharp = resolver ?? getSharp;
}

/**
 * 纪元 Γ（Γ-2）：中央凹加权 —— 编码管线（flatten→crop→resize 之后、jpeg 之前）
 * 在**编码图尺寸空间**上合成单图：中央方窗（边长 foveaSize×min(w,h)，居中）
 * 原生无损保留；外围（整图）按 1/peripheryScale 缩小再放大回原尺寸（低清
 * 模糊化）作底，composite 把中央窗盖回。坐标空间不变 —— 模型看到的仍是
 * w×h 整幅图，外围只是模糊，无需分段坐标映射。
 * W1-9（任务驱动注视）：可选 center（编码画布像素系窗心）把方窗从几何中心
 * 移到注视点 —— 缺席 = 几何中心，缺省路径逐字节不变；center={w/2,h/2} 与
 * 居中公式在 IEEE 半精度整除下恒等（floor(w/2−edge/2) === floor((w−edge)/2)）。
 *
 * 纯 try/catch 包裹：任何一步失败（composite 异常 / sharp 链残缺）返回 null，
 * 调用方诚实降级回均质编码（foveated:false）—— 中央凹是增益不是依赖。
 */
async function applyFoveation(
  sharp: SharpLike,
  pipe: SharpChainLike,
  w: number,
  h: number,
  foveaSize: number,
  peripheryScale: number,
  /** W1-9：注视窗心（编码画布像素系）；缺席 = 几何中心（缺省路径逐字节不变） */
  center?: { x: number; y: number },
): Promise<SharpChainLike | null> {
  try {
    const minEdge = Math.min(w, h);
    // 方窗边长：比例×短边，夹 [1, minEdge]（窗口既不退化也不越界）
    const edge = Math.min(Math.max(1, Math.round(foveaSize * minEdge)), minEdge);
    // W1-9：窗放置 —— center 在场以注视点为窗心，clamp 进画布（注视不得越出
    // 视网膜）；缺席走居中公式（老行为一字不变）
    const left = center
      ? Math.min(Math.max(0, Math.floor(center.x - edge / 2)), w - edge)
      : Math.floor((w - edge) / 2);
    const top = center
      ? Math.min(Math.max(0, Math.floor(center.y - edge / 2)), h - edge)
      : Math.floor((h - edge) / 2);
    // 外围底图：缩到 1/scale 落 PNG 中转，再以**独立管线**放大回原尺寸 ——
    // sharp 的 resize 二次调用会覆盖而非级联，两段必须各自成链
    // （缩放比恰为整数时棋盘式高频内容糊向均值 —— 低清化的确定性来源）。
    // scale≤1 视为无缩放（底图原样，中央窗仍原生盖回）。
    const scale = Math.max(1, peripheryScale);
    let base: SharpChainLike;
    if (scale > 1) {
      const dw = Math.max(1, Math.round(w / scale));
      const dh = Math.max(1, Math.round(h / scale));
      const downPng = await pipe.clone()
        .resize({ width: dw, height: dh, fit: 'fill' })
        .png()
        .toBuffer();
      base = sharp(downPng).resize({ width: w, height: h, fit: 'fill' });
    } else {
      base = pipe.clone();
    }
    // 中央原生窗：clone 抽取 → 无损 PNG 中转 → composite 盖回原位
    const centerPng = await pipe.clone()
      .extract({ left, top, width: edge, height: edge })
      .png()
      .toBuffer();
    return base.composite([{ input: centerPng, left, top }]);
  } catch {
    return null; // 诚实降级：中央凹失败不毒化编码主路径
  }
}

/**
 * 纪元 Γ2（inset 模式）：真正的注视经济 —— 编码管线（resize 之后、jpeg 之前）
 * 在**编码图尺寸空间**（w×h = 原生编码图，crop+resize 之后的语义画布）上构造：
 *   1. 主图（外围）按 1/scale 降采样为缩图（w/scale × h/scale）—— 输出尺寸即缩图
 *      尺寸 ⇒ estimateVlmTokens 按 1/scale² 骨跌（Γ blur 模式一分不省的兑现）；
 *   2. 凹窗 = foveaSize×min(w,h)、居中，从原生编码图**无损 PNG** 抽取（原生分辨率），
 *      composite 到缩图中心对应位置 —— 凹窗在缩图上的占位 = 凹窗尺寸（不缩），
 *      故合成图中央是原生密度、四周是 1/scale 密度（放大镜式嵌窗）。
 *
 * 契约（mapInsetToOriginal 的反算基准，两侧共用同一推导）：
 *   · 原生编码图 E（w×h）；缩图 T（downW×downH = round(w/scale)×round(h/scale)）
 *   · 凹窗边长 edge = clamp(round(foveaSize×min(w,h)), 1, min(w,h))
 *   · E 上提取原点 fx = floor((w−edge)/2)、fy = floor((h−edge)/2)（居中提取律）
 *   · T 上占位原点 ix = floor((downW−edge)/2)、iy = floor((downH−edge)/2)（居中占位律）
 *   · 映射：T 窗内像素 (x,y) ⇔ E 像素 (fx+x−ix, fy+y−iy)（1:1 原生密度）；
 *     T 窗外像素 (x,y) ⇔ E 像素 (x·w/downW, y·h/downH)（缩图实际比值，非名义 scale）
 *   注意：fx ≠ ix×scale（仅 scale=1 时重合）—— 居中提取律与居中占位律各自独立取整，
 *   窗内容相对外围是 scale 倍放大（放大镜语义），边界处映射天然分段不连续 —— 这
 *   正是「中央凹」的代价，由 mapInsetToOriginal 分段处理、绝不假装连续。
 * W1-9（任务驱动注视）：可选 center（编码画布像素系窗心）同时驱动两侧原点 ——
 *   提取律 fx = clamp(floor(center.x−edge/2), 0, w−edge)（原生画布窗心 = 注视点）；
 *   占位律 ix = clamp(floor(center.x·downW/w−edge/2), 0, downW−edge)（缩图窗心 =
 *   注视点的缩图投影 —— 放大镜罩住注视目标的屏幕位置，不与背景投影重叠）。
 *   两律各自独立取整 + 独立 clamp（画布尺寸不同，注视点靠边时 clamp 量不同 ——
 *   fx 不可由 ix 重建，故随行 insetExtract 供反算）。缺席 = 几何中心：两律退回
 *   居中公式且 IEEE 恒等，缺省路径逐字节不变；center={w/2,h/2} 同律。
 *
 * 结构性不可用（edge > downW 或 edge > downH：凹窗放不进缩图，如 foveaSize×scale>1）
 * ⇒ 返回 null 走一级降级（blur 模式：全尺寸画布中央原生、外围模糊 —— 窗永远放得下）。
 * 纯 try/catch：任何一步失败（extract/resize/composite 异常）返回 null，逐级降级
 * 注记由调用方（encodeForVlm）记入 foveaMode/strategy —— 诚实可观测，绝不抛。
 */
async function applyInsetFoveation(
  pipe: SharpChainLike,
  w: number,
  h: number,
  foveaSize: number,
  peripheryScale: number,
  /** W1-9：注视窗心（编码画布像素系）；缺席 = 几何中心（缺省路径逐字节不变） */
  center?: { x: number; y: number },
): Promise<{
  pipe: SharpChainLike;
  insetRect: { x: number; y: number; w: number; h: number };
  insetScale: number;
  insetNative: { width: number; height: number };
  /** W1-9：凹窗在原生编码图上的提取原点（mapInsetToOriginal 的精确反算基准） */
  insetExtract: { x: number; y: number };
} | null> {
  try {
    // scale 夹 [1,4]：注册表区间可达 8（index.ts 铸入 max:8），>4 的激进值使凹窗
    // 占满缩图（foveaSize·scale>1 必触发结构性降级），夹取保住 inset 语义
    const scale = Math.min(INSET_SCALE_MAX, Math.max(1, peripheryScale));
    if (!(scale > 1)) return null; // scale≤1 无降采样 ⇒ inset 无增益，交回 blur 语义
    const minEdge = Math.min(w, h);
    const edge = Math.min(Math.max(1, Math.round(foveaSize * minEdge)), minEdge);
    const downW = Math.max(1, Math.round(w / scale));
    const downH = Math.max(1, Math.round(h / scale));
    if (edge > downW || edge > downH) {
      // 凹窗放不进缩图（居中占位将出负坐标）—— 结构性降级信号，不是异常
      return null;
    }
    // W1-9：注视窗放置 —— 提取律在原生画布以注视点为窗心（fx = cx−edge/2，
    // clamp 进原生画布）；占位律在缩图以注视点的**缩图投影**为窗心
    // （ix = cx·downW/w − edge/2，clamp 进缩图）—— 放大镜罩在「注视目标在
    // 缩图上的位置」，注视内容不被平移出其屏幕位置、也不与背景投影重叠
    // （双重视觉）。缺席走居中公式（老行为一字不变；cx=w/2 时两律与居中式
    // IEEE 恒等 —— 缺省路径逐字节不变的数学根据）。投影用实际比值 downW/w
    // （非名义 scale —— 与窗外反算同源，取整残差被吸收）。
    const fx = center
      ? Math.min(Math.max(0, Math.floor(center.x - edge / 2)), w - edge)
      : Math.floor((w - edge) / 2);
    const fy = center
      ? Math.min(Math.max(0, Math.floor(center.y - edge / 2)), h - edge)
      : Math.floor((h - edge) / 2);
    const ix = center
      ? Math.min(Math.max(0, Math.floor((center.x * downW) / w - edge / 2)), downW - edge)
      : Math.floor((downW - edge) / 2);
    const iy = center
      ? Math.min(Math.max(0, Math.floor((center.y * downH) / h - edge / 2)), downH - edge)
      : Math.floor((downH - edge) / 2);
    // 中央原生窗：clone 抽取 → 无损 PNG 中转（resize 前的原生密度，不经重采样）
    const centerPng = await pipe.clone()
      .extract({ left: fx, top: fy, width: edge, height: edge })
      .png()
      .toBuffer();
    // 外围缩图：单次 resize 到缩图尺寸（与 blur 不同，无需二次放大 —— 输出就是缩图）
    const base = pipe.clone().resize({ width: downW, height: downH, fit: 'fill' });
    return {
      pipe: base.composite([{ input: centerPng, left: ix, top: iy }]),
      insetRect: { x: ix, y: iy, w: edge, h: edge },
      insetScale: scale,
      insetNative: { width: w, height: h },
      insetExtract: { x: fx, y: fy },
    };
  } catch {
    return null; // 诚实降级：inset 失败先回 blur、再回均质（调用方逐级注记）
  }
}

/**
 * 把截图编码为 VLM 就绪的 base64 JPEG。
 * 管线（顺序固定）：可选像素坐标裁剪（先）→ 长边超限时等比缩小（后）→
 * 可选中央凹加权（纪元 Γ：仅 foveated 编码时）→ JPEG(quality)。strategy
 * 记录实际采用的策略；width/height 为**编码输出**的实际尺寸（裁剪/缩放之后），
 * bytes 为 JPEG 二进制字节数。返回值另附纪元 Γ 元信息（sourceWidth/Height、
 * cropRect、foveated —— 可选字段，老调用方零破坏；类型化保证走 encodeForVlmMeta）。
 *
 * 失败路径一律返回 {ok:false,error}，绝不抛错：空 Buffer、非法 opts
 * （maxDimension<1 / quality 越界 / foveaSize 不在 (0,1] / foveaPeripheryScale
 * ≤1）、非法 region（x1<=x0 / 负坐标 / 越界）、sharp 不可用（降级路径）、
 * 缓冲区不可解码。
 */
export async function encodeForVlm(
  buffer: Buffer,
  opts?: {
    /** 长边上限，默认 1568：超过则等比缩小（VLM 最佳分辨率带宽） */
    maxDimension?: number;
    /** JPEG 质量 1-100，默认 80 */
    quality?: number;
    /** 可选像素坐标兴趣区：先裁剪再编码 */
    region?: Bbox;
    /** 纪元 Γ：中央凹加权编码开关（缺省 false = 均质编码，旧行为） */
    foveated?: boolean;
    /** 纪元 Γ：中央方窗边长占编码图短边比例 (0,1]，缺省 0.5 */
    foveaSize?: number;
    /** 纪元 Γ：外围降采样因子（>1：先按此倍数缩小再放大回原位），缺省 2 */
    foveaPeripheryScale?: number;
    /**
     * 纪元 Γ2：中央凹模式 —— 'blur'（缺省：全尺寸画布，外围模糊，坐标空间不变，
     * Γ 行为零变化）| 'inset'（输出=缩图尺寸，token 按 1/scale² 骨跌，中央原生密度
     * 嵌窗）。缺省读内核注册表 codec.foveaMode（0/1 数值语义，>0.5 即 inset，
     * 与 codec.foveated 同款；未注册 ⇒ 0 = blur）。
     */
    foveaMode?: 'blur' | 'inset';
    /**
     * W1-9（P1 任务驱动注视）：注视中心 —— **源图归一化系 [0,1]²**（裁剪前总画布，
     * 与 gazeRouter 输出同方言，直接对接）。缺席 = 几何中心（Γ/Γ2 缺省路径逐字节
     * 不变）。越界分量 clamp 回 [0,1]（注视不得越出视网膜 —— 防御路由器脏输入）；
     * 非有限分量/非对象拒绝（与 foveaSize 同律，仅 foveated 时校验）。
     */
    foveaCenter?: { x: number; y: number };
  },
): Promise<{ ok: boolean; value?: EncodedImage; error?: string }> {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return { ok: false, error: 'encodeForVlm: empty buffer (nothing to encode)' };
    }
    const rawDim = opts?.maxDimension;
    if (rawDim !== undefined && (!Number.isFinite(rawDim) || rawDim < 1)) {
      return { ok: false, error: `encodeForVlm: invalid maxDimension=${String(rawDim)} (need finite >= 1)` };
    }
    const rawQuality = opts?.quality;
    if (rawQuality !== undefined && (!Number.isFinite(rawQuality) || rawQuality < 1 || rawQuality > 100)) {
      return { ok: false, error: `encodeForVlm: invalid quality=${String(rawQuality)} (need 1-100)` };
    }
    // 纪元 Γ：中央凹参数解析 —— 显式入参恒压过注册表（与 maxDim/quality 同律）；
    // codec.foveated 以 0/1 数值入册语义预留（注册表无数值型布尔，>0.5 即真），
    // 未注册 ⇒ getOrDefault 回声缺省（false/0.5/2），六个调用方缺省路径逐字节不变。
    // 纪元 Γ2：codec.foveaMode 同款 0/1 数值语义（0=blur 1=inset）；显式入参为
    // 字符串枚举（!== 'inset' 一律按 blur —— 含脏值防御，不抛）。
    const foveated = opts?.foveated !== undefined
      ? opts.foveated === true
      : kernelRegistry.getOrDefault('codec.foveated', 0) > 0.5;
    const insetMode = opts?.foveaMode !== undefined
      ? opts.foveaMode === 'inset'
      : kernelRegistry.getOrDefault('codec.foveaMode', 0) > 0.5;
    const foveaSize = opts?.foveaSize ?? kernelRegistry.getOrDefault('codec.foveaSize', DEFAULT_FOVEA_SIZE);
    const peripheryScale = opts?.foveaPeripheryScale
      ?? kernelRegistry.getOrDefault('codec.foveaPeripheryScale', DEFAULT_PERIPHERY_SCALE);
    if (foveated && (!Number.isFinite(foveaSize) || foveaSize <= 0 || foveaSize > 1)) {
      return { ok: false, error: `encodeForVlm: invalid foveaSize=${String(foveaSize)} (need (0,1])` };
    }
    if (foveated && (!Number.isFinite(peripheryScale) || peripheryScale <= 1)) {
      return { ok: false, error: `encodeForVlm: invalid foveaPeripheryScale=${String(peripheryScale)} (need > 1)` };
    }
    // W1-9（任务驱动注视）：注视中心体检 —— 仅 foveated 时校验（与 foveaSize 同律，
    // 开关关时脏值惰性、缺省路径零行为变化）。非对象/非有限分量拒绝；越界分量
    // clamp 回 [0,1]（点语义：注视可以贴边但不许离开视网膜 —— 与区间参数的拒绝律不同）。
    let foveaCenterClean: { x: number; y: number } | undefined;
    if (foveated && opts?.foveaCenter !== undefined) {
      const fc = opts.foveaCenter;
      if (fc === null || typeof fc !== 'object'
        || typeof (fc as { x?: unknown }).x !== 'number' || !Number.isFinite((fc as { x: number }).x)
        || typeof (fc as { y?: unknown }).y !== 'number' || !Number.isFinite((fc as { y: number }).y)) {
        return { ok: false, error: `encodeForVlm: invalid foveaCenter=${JSON.stringify(fc) ?? String(fc)} (need finite {x,y} in [0,1])` };
      }
      foveaCenterClean = {
        x: Math.min(1, Math.max(0, (fc as { x: number }).x)),
        y: Math.min(1, Math.max(0, (fc as { y: number }).y)),
      };
    }
    // 纪元 Ξ（Ξ-D 生产接线）：缺省单点读内核注册表 —— codec.maxDim（缺省
    // 1568，区间 512..4096）/ codec.quality（缺省 80，区间 50..95）。显式
    // 入参恒压过注册表；未注册 ⇒ getOrDefault 回声常量，六个调用方的缺省
    // 路径逐字节不变（本 ?? 缺省缝是唯一的缺省求值点）。
    const maxDimension = Math.round(rawDim ?? kernelRegistry.getOrDefault('codec.maxDim', DEFAULT_MAX_DIMENSION));
    const quality = Math.round(rawQuality ?? kernelRegistry.getOrDefault('codec.quality', DEFAULT_QUALITY));

    // sharp 懒加载：缺席 = 云脑编码降级路径，诚实报错而不抛出
    let sharp: SharpLike;
    try {
      sharp = await resolveSharp();
    } catch (e: any) {
      return { ok: false, error: `sharp unavailable for VLM encoding: ${e?.message ?? String(e)}` };
    }

    let W = 0;
    let H = 0;
    try {
      const meta = await sharp(buffer).metadata();
      W = meta.width ?? 0;
      H = meta.height ?? 0;
    } catch (e: any) {
      return { ok: false, error: `cannot decode image: ${e?.message ?? String(e)}` };
    }
    if (W < 1 || H < 1) {
      return { ok: false, error: `image has no usable dimensions (${W}x${H})` };
    }

    // 兴趣区校验 + 取整（浮点像素坐标 → sharp extract 需要的整数矩形）
    let crop: { left: number; top: number; width: number; height: number } | null = null;
    const region = opts?.region;
    if (region) {
      const { x0, y0, x1, y1 } = region;
      if (![x0, y0, x1, y1].every(Number.isFinite)) {
        return { ok: false, error: 'invalid region: coordinates must be finite numbers' };
      }
      if (x1 <= x0 || y1 <= y0) {
        return { ok: false, error: `invalid region: need x1>x0 and y1>y0 (got (${x0},${y0})..(${x1},${y1}))` };
      }
      if (x0 < 0 || y0 < 0) {
        return { ok: false, error: `invalid region: negative origin (${x0},${y0})` };
      }
      if (x1 > W || y1 > H) {
        return { ok: false, error: `invalid region: exceeds image bounds ${W}x${H} (x1=${x1}, y1=${y1})` };
      }
      crop = {
        left: Math.round(x0),
        top: Math.round(y0),
        width: Math.max(1, Math.round(x1) - Math.round(x0)),
        height: Math.max(1, Math.round(y1) - Math.round(y0)),
      };
    }

    // 管线：flatten（JPEG 无 alpha：透明像素压白底，防黑底黑字对 VLM 不可读）
    // → crop → resize → [纪元 Γ] 中央凹加权 → jpeg。flatten 未纳入批次 E 的
    // SharpChainLike 结构类型，运行时防御性探测（缺席则跳过，sharp 自会把
    // alpha 压到默认底色）。
    const srcW = crop ? crop.width : W;
    const srcH = crop ? crop.height : H;
    let pipe: SharpChainLike = sharp(buffer);
    const flatten = (pipe as any).flatten;
    if (typeof flatten === 'function') {
      pipe = flatten.call(pipe, { background: '#ffffff' });
    }
    if (crop) pipe = pipe.extract(crop);
    let resized = false;
    let tw = srcW;
    let th = srcH;
    const longEdge = Math.max(srcW, srcH);
    if (longEdge > maxDimension) {
      resized = true;
      // 长边钉在 maxDimension，短边等比四舍五入；fit:'fill' 保证输出尺寸精确可断言
      tw = srcW >= srcH
        ? maxDimension
        : Math.max(1, Math.round((srcW * maxDimension) / longEdge));
      th = srcH > srcW
        ? maxDimension
        : Math.max(1, Math.round((srcH * maxDimension) / longEdge));
      pipe = pipe.resize({ width: tw, height: th, fit: 'fill' });
    }

    // W1-9（任务驱动注视）：源图归一化注视中心 → 编码画布像素窗心。crop+resize
    // 复合一次映射：先平移进裁剪窗（crop 外的注视点 clamp 到窗边 —— 注视被裁剪
    // 窗截断是诚实行为），再乘画布尺寸。缺席 = undefined ⇒ 两级中央凹走几何中心
    // —— 缺省路径逐字节不变（本映射缝是唯一的注视求值点）。
    let gazeCanvas: { x: number; y: number } | undefined;
    if (foveaCenterClean) {
      const cu = crop
        ? Math.min(1, Math.max(0, (foveaCenterClean.x * W - crop.left) / crop.width))
        : foveaCenterClean.x;
      const cv = crop
        ? Math.min(1, Math.max(0, (foveaCenterClean.y * H - crop.top) / crop.height))
        : foveaCenterClean.y;
      gazeCanvas = { x: cu * tw, y: cv * th };
    }

    // 纪元 Γ/Γ2：中央凹加权 —— 在编码图尺寸空间（tw×th）上合成。模式分岔：
    //   · blur（Γ 缺省）：坐标空间不变，外围模糊 —— 行为与 Γ 逐字节同源；
    //   · inset（Γ2）：输出=缩图尺寸（token 1/scale² 骨跌），中央原生密度嵌窗。
    // W1-9：gazeCanvas 随行注入（undefined = 几何中心，老行为）。
    // 降级链（逐级诚实注记，绝不带崩编码主路径）：
    //   inset 失败/结构性不可用（composite/resize/extract 异常，或凹窗放不进缩图）
    //   ⇒ 一级降级 blur（foveated:true + foveaMode:'blur' + '+fovea'）
    //   ⇒ blur 也失败 ⇒ 均质管线（foveated:false，无后缀 —— Γ 老语义）。
    let foveaApplied = false;
    let appliedMode: 'blur' | 'inset' | null = null;
    let insetRect: { x: number; y: number; w: number; h: number } | undefined;
    let insetScale: number | undefined;
    let insetNative: { width: number; height: number } | undefined;
    let insetExtract: { x: number; y: number } | undefined;
    if (foveated) {
      if (insetMode) {
        const inset = await applyInsetFoveation(pipe, tw, th, foveaSize, peripheryScale, gazeCanvas);
        if (inset) {
          pipe = inset.pipe;
          insetRect = inset.insetRect;
          insetScale = inset.insetScale;
          insetNative = inset.insetNative;
          insetExtract = inset.insetExtract;
          foveaApplied = true;
          appliedMode = 'inset';
        } else {
          // 一级降级：inset 不可用 ⇒ blur（Γ 管线：全尺寸画布，窗永远放得下）
          const foveaPipe = await applyFoveation(sharp, pipe, tw, th, foveaSize, peripheryScale, gazeCanvas);
          if (foveaPipe) {
            pipe = foveaPipe;
            foveaApplied = true;
            appliedMode = 'blur';
          }
        }
      } else {
        const foveaPipe = await applyFoveation(sharp, pipe, tw, th, foveaSize, peripheryScale, gazeCanvas);
        if (foveaPipe) {
          pipe = foveaPipe;
          foveaApplied = true;
          appliedMode = 'blur';
        }
      }
    }

    // toBuffer 的结构类型首选 Promise<Buffer> 重载，这里经 unknown 中转断言
    // resolveWithObject 形态（真实 sharp 返回 {data, info}）
    const out = (await pipe
      .jpeg({ quality })
      .toBuffer({ resolveWithObject: true })) as unknown as {
      data: Uint8Array | Buffer;
      info: { width?: number; height?: number };
    };
    const data = Buffer.from(out.data);
    const outW = out.info?.width ?? srcW;
    const outH = out.info?.height ?? srcH;

    const strategy = (crop
      ? (resized ? 'crop+resize' : 'crop')
      : (resized ? `resize-${maxDimension}` : 'as-is'))
      + (foveaApplied ? (appliedMode === 'inset' ? '+inset' : '+fovea') : '');

    return {
      ok: true,
      value: {
        base64: data.toString('base64'),
        mime: 'image/jpeg',
        width: outW,
        height: outH,
        bytes: data.length,
        strategy,
        // 纪元 Γ 元信息（可选字段：老调用方零破坏；encodeForVlmMeta 类型收窄为必填）
        sourceWidth: W,
        sourceHeight: H,
        foveated: foveaApplied,
        cropRect: crop,
        // 纪元 Γ2：中央凹模式注记（仅 foveated:true 时在场；blur 一级降级也诚实
        // 标 'blur' —— 观察者可由 strategy 无 '+inset' + foveaMode:'blur' 识别降级）
        foveaMode: foveaApplied ? (appliedMode ?? 'blur') : undefined,
        // 纪元 Γ2：inset 反算基准（缩图系凹窗矩形 + 实际 scale + 原生编码图维度）
        insetRect,
        insetScale,
        insetNative,
        // W1-9：原生编码图上的凹窗提取原点（inset 随行；缺省=居中提取律恒等值）
        // + 生效注视中心回声（仅显式提供且中央凹生效时在场 —— 可观测面）
        insetExtract,
        foveaCenter: foveaApplied && foveaCenterClean ? foveaCenterClean : undefined,
      },
    };
  } catch (e: any) {
    return { ok: false, error: `encodeForVlm failed: ${e?.message ?? String(e)}` };
  }
}

// ─── W1-9（P1 任务驱动注视）：三路候选注视路由纯函数 ───

/** W1-9：注视候选路 —— grounding（上一轮目标 bbox）/ diff（最大连通域质心）/ cursor（光标） */
export type GazeRoute = 'grounding' | 'diff' | 'cursor';

/**
 * W1-9：注视候选。center 为**源图归一化系 [0,1]²**（与 encodeForVlm 的
 * foveaCenter 同方言 —— 路由输出可直接喂编码入参，零换算）；taskRelevance
 * 为任务相关度 [0,1]（缺省 1 = 「与该路允许的一样相关」，调用方下调以反映
 * 任务语境，如 grounding 目标刚被验证完成 ⇒ 相关度衰减）。
 */
export interface GazeCandidate {
  route: GazeRoute;
  center: { x: number; y: number };
  taskRelevance?: number;
}

/** W1-9：路由判决 —— Top-1 注视中心 + 全候选拆票（可观测面） */
export interface GazeDecision {
  /** 注视中心（源图归一化 [0,1]²；全缺席 = 几何中心 {0.5,0.5}）—— foveaCenter 直供 */
  center: { x: number; y: number };
  /** 胜出路（'center' = 全候选缺席/全脏的几何中心回退） */
  route: GazeRoute | 'center';
  /** 胜出分数 = 路由先验 × 任务相关度（回退时 0） */
  score: number;
  /** true = 无任何合格候选，走了几何中心回退 */
  fellBack: boolean;
  /** 按分数降序的候选拆票（防御规整后的 center 与分数 —— 审计/测试面） */
  ranked: Array<{ route: GazeRoute; score: number; center: { x: number; y: number } }>;
}

/**
 * W1-9 路由先验（客观证据强度，与任务语境无关）：grounding 0.9（上一轮目标
 * 是任务相关度的最强证据 —— 模型刚在那里定位过）> diff 0.6（最大连通域质心：
 * 动作副作用所在，任务推进的间接证据）> cursor 0.3（光标位置是弱意图信号）。
 */
const GAZE_ROUTE_PRIOR: Record<GazeRoute, number> = { grounding: 0.9, diff: 0.6, cursor: 0.3 };

/**
 * W1-9（P1 任务驱动注视）：三路候选按任务相关度加权，取 Top-1 为注视中心。
 *
 * 评分律：score = 路由先验 × clamp01(taskRelevance ?? 1)，千分位圆整（防浮点
 * 噪声制造伪并列）。并列裁决：先验高者胜（grounding > diff > cursor），仍平
 * 取输入序 —— 全程确定性。
 *
 * 防御（绝不抛）：非数组入参 / 非对象候选 / 未知 route / 非有限 center 分量
 * ⇒ 该候选**跳过**（不猜、不给默认位置）；越界 center 分量 clamp 回 [0,1]；
 * taskRelevance 非有限按缺省 1 记。全部候选被跳过 ⇒ 几何中心回退
 * （route='center'、fellBack:true）—— 注视经济缺席时编码自然回退 Γ 几何中心
 * 语义，零行为耦合。纯函数、零副作用。
 */
export function gazeRouter(candidates: unknown): GazeDecision {
  const geo = { x: 0.5, y: 0.5 };
  const fallback: GazeDecision = { center: geo, route: 'center', score: 0, fellBack: true, ranked: [] };
  if (!Array.isArray(candidates)) return fallback;
  const seen: Array<{
    route: GazeRoute; score: number; center: { x: number; y: number }; order: number; prior: number;
  }> = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c === null || typeof c !== 'object') continue;
    const route = (c as GazeCandidate).route;
    const prior = GAZE_ROUTE_PRIOR[route as GazeRoute];
    if (typeof prior !== 'number') continue; // 未知路：跳过（不猜）
    const ctr = (c as { center?: unknown }).center;
    if (ctr === null || typeof ctr !== 'object') continue;
    const cx = (ctr as { x?: unknown }).x;
    const cy = (ctr as { y?: unknown }).y;
    if (typeof cx !== 'number' || !Number.isFinite(cx) || typeof cy !== 'number' || !Number.isFinite(cy)) continue;
    const relRaw = (c as { taskRelevance?: unknown }).taskRelevance;
    const rel = typeof relRaw === 'number' && Number.isFinite(relRaw)
      ? Math.min(1, Math.max(0, relRaw))
      : 1;
    seen.push({
      route,
      score: Math.round(prior * rel * 1000) / 1000,
      center: { x: Math.min(1, Math.max(0, cx)), y: Math.min(1, Math.max(0, cy)) },
      order: i,
      prior,
    });
  }
  if (seen.length === 0) return fallback;
  seen.sort((a, b) => b.score - a.score || b.prior - a.prior || a.order - b.order);
  const top = seen[0]!;
  return {
    center: { ...top.center },
    route: top.route,
    score: top.score,
    fellBack: false,
    ranked: seen.map(s => ({ route: s.route, score: s.score, center: { ...s.center } })),
  };
}

// ─── 纪元 Γ（Γ-1）：坐标反算纯函数 + 元信息通道 ───

/**
 * 纯函数：编码图像素坐标 → 源图像素坐标（等比缩放反算）。
 * 逐轴独立反算（x 按 origW/encW、y 按 origH/encH —— 编码缩放的短边取整使
 * 两轴比例可有亚像素差，逐轴比值是精确的一般化）；Math.round 取整后 clamp
 * 进 [0,origW]×[0,origH] 图内（右/下缘坐标=尺寸合法 —— bbox x1=width 约定）。
 * 除零与脏维度防御：任一维度非有限或 <1 ⇒ 返回 {x:0,y:0}（不猜、不抛）；
 * 坐标分量非有限按 0 记。零副作用，绝不抛异常。
 */
export function mapEncodedToOriginal(
  x: number,
  y: number,
  encW: number,
  encH: number,
  origW: number,
  origH: number,
): { x: number; y: number } {
  const dim = (n: unknown): number =>
    (typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0);
  const ew = dim(encW), eh = dim(encH), ow = dim(origW), oh = dim(origH);
  if (ew < 1 || eh < 1 || ow < 1 || oh < 1) return { x: 0, y: 0 };
  const px = typeof x === 'number' && Number.isFinite(x) ? x : 0;
  const py = typeof y === 'number' && Number.isFinite(y) ? y : 0;
  return {
    x: Math.min(ow, Math.max(0, Math.round(px * (ow / ew)))),
    y: Math.min(oh, Math.max(0, Math.round(py * (oh / eh)))),
  };
}

/**
 * 纯函数：bbox 四角整体反算（mapEncodedToOriginal 的盒子形态 —— 两对角
 * 独立映射，单调缩放下 x0≤x1 / y0≤y1 保持）。注意本函数**不含** clamp 回图
 * 与取整兜底（调用方按目标空间用 clampBbox 收口）；也不含 region 平移 ——
 * 裁剪偏移由调用方按 cropRect 组合。
 */
export function mapBboxEncodedToOriginal(
  bbox: Bbox,
  encW: number,
  encH: number,
  origW: number,
  origH: number,
): Bbox {
  const p0 = mapEncodedToOriginal(bbox?.x0, bbox?.y0, encW, encH, origW, origH);
  const p1 = mapEncodedToOriginal(bbox?.x1, bbox?.y1, encW, encH, origW, origH);
  return { x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y };
}

/**
 * 纪元 Γ2 纯函数：inset 编码图像素坐标 → 源图像素坐标（分段反算）。
 * inset 合成图是双密度拼图 —— 中央凹窗原生密度、外围 1/scale 密度 —— 单一
 * 等比公式必然在窗界失真，必须分段：
 *
 * 推导（与 applyInsetFoveation 共用同一构造律）：
 *   设原生编码图 E = insetNative（w×h）、缩图 T = 本编码结果（meta.width×height）、
 *   凹窗矩形 R = insetRect（缩图坐标系）：
 *   · 点 (x,y) ∈ R（半开区间 [R.x, R.x+R.w) × [R.y, R.y+R.h)）：
 *     窗内像素与 E 上凹窗 1:1（原生密度，占位不缩）。E 上凹窗原点按**居中提取律**
 *     fx = floor((w − R.w)/2)、fy = floor((h − R.h)/2)（W1-9：随行 insetExtract
 *     在场时以之为准 —— 注视窗偏置时提取原点随 foveaCenter 漂移，居中律仅为
 *     缺席/脏值的零回归回退），故
 *       E = ( fx + (x − R.x),  fy + (y − R.y) )
 *     —— 注意 fx ≠ R.x×insetScale：居中提取律与居中占位律各自独立取整，
 *     仅 scale=1 时重合；故 meta 随行 insetNative 使本式精确无假设。
 *   · 点 (x,y) ∉ R（外围）：缩图 = E 经 resize(round(w/scale)×round(h/scale))
 *     而来，逐轴用**实际比值** w/meta.width（≈scale 但取整有残差）：
 *       E = ( x · w/meta.width,  y · h/meta.height )
 *   E → 源图沿用 Γ 等比语义（mapEncodedToOriginal）+ cropRect 平移 + clamp 图内
 *   （与 vlmOcr 的两段复合同律），往返 ≤1px（整数格点上逐段恒等或等比精确）。
 *
 * 防御：inset 元信息缺席/脏值（理论不可达：inset 模式恒随行；降级路径 foveaMode
 * 不是 'inset'）⇒ 诚实回退 Γ 等比语义（缩图整体 → 源图），精度降级不抛错；
 * 坐标分量非有限按 0 记；除零由维度下界检查拦截。零副作用，绝不抛异常。
 */
export function mapInsetToOriginal(
  x: number,
  y: number,
  meta: EncodedImageMeta,
): { x: number; y: number } {
  const fin = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
  const dim = (n: unknown): number =>
    (typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0);
  const tw = dim(meta?.width);
  const th = dim(meta?.height);
  const ow = dim(meta?.sourceWidth);
  const oh = dim(meta?.sourceHeight);
  const nw = dim(meta?.insetNative?.width);
  const nh = dim(meta?.insetNative?.height);
  const r = meta?.insetRect;
  // 凹窗矩形体检在**原始值**上做（负原点/分数/越界即脏 —— dim() 的下界清洗会把
  // -5 洗成 0 反而放行，故先检后洗）
  const rectRawOk = r !== null && typeof r === 'object'
    && Number.isFinite(r.x) && r.x >= 0
    && Number.isFinite(r.y) && r.y >= 0
    && Number.isFinite(r.w) && r.w >= 1
    && Number.isFinite(r.h) && r.h >= 1
    && r.x + r.w <= tw && r.y + r.h <= th;
  const rx = fin(r?.x), ry = fin(r?.y), rw = dim(r?.w), rh = dim(r?.h);
  const px = fin(x), py = fin(y);
  const crop = meta?.cropRect ?? null;
  // E → 源图的两段复合（Γ 语义）：先等比到裁剪窗/源图，再 +cropRect 偏移，clamp 图内
  const toSource = (ex: number, ey: number): { x: number; y: number } => {
    const midW = crop ? dim(crop.width) : ow;
    const midH = crop ? dim(crop.height) : oh;
    const p = mapEncodedToOriginal(ex, ey, nw, nh, midW, midH);
    const offX = crop ? fin(crop.left) : 0;
    const offY = crop ? fin(crop.top) : 0;
    return {
      x: Math.min(Math.max(0, ow), Math.max(0, p.x + offX)),
      y: Math.min(Math.max(0, oh), Math.max(0, p.y + offY)),
    };
  };
  // inset 基准体检：缩图/原生/源图维度可用 + 凹窗矩形在缩图内 + scale ≥1 有限。
  // 任一不过 ⇒ 诚实回退 Γ 等比（meta.width×height → 源图）—— 精度降级、语义不破。
  const scaleOk = typeof meta?.insetScale === 'number'
    && Number.isFinite(meta.insetScale) && meta.insetScale >= 1;
  if (!(tw >= 1 && th >= 1 && nw >= 1 && nh >= 1 && ow >= 1 && oh >= 1) || !rectRawOk || !scaleOk) {
    const midW = crop ? dim(crop.width) : ow;
    const midH = crop ? dim(crop.height) : oh;
    const p = mapEncodedToOriginal(px, py, tw, th, midW, midH);
    const offX = crop ? fin(crop.left) : 0;
    const offY = crop ? fin(crop.top) : 0;
    return {
      x: Math.min(Math.max(0, ow), Math.max(0, p.x + offX)),
      y: Math.min(Math.max(0, oh), Math.max(0, p.y + offY)),
    };
  }
  // W1-9（任务驱动注视）：凹窗提取原点 —— 首选随行 insetExtract（注视窗偏置时的
  // 精确反算基准）；缺席/脏值（负原点/越出原生画布/非有限）⇒ 诚实回退居中提取律
  // 推导（Γ2 老元信息与缺省几何中心的零回归路径）。体检在原始值上做（与
  // rectRawOk 同律：先检后洗，防 dim() 下界清洗放行负值）。
  const extract = meta?.insetExtract;
  const extractOk = extract !== null && typeof extract === 'object'
    && Number.isFinite((extract as { x?: unknown }).x) && (extract as { x: number }).x >= 0
    && Number.isFinite((extract as { y?: unknown }).y) && (extract as { y: number }).y >= 0
    && (extract as { x: number }).x + rw <= nw && (extract as { y: number }).y + rh <= nh;
  // 分段反算：窗内 1:1 原生（W1-9：提取原点 insetExtract 优先，缺省=居中提取律）；
  // 窗外等比（缩图实际比值，非名义 scale）
  if (px >= rx && px < rx + rw && py >= ry && py < ry + rh) {
    const fx = extractOk ? Math.floor((extract as { x: number }).x) : Math.floor((nw - rw) / 2);
    const fy = extractOk ? Math.floor((extract as { y: number }).y) : Math.floor((nh - rh) / 2);
    return toSource(fx + (px - rx), fy + (py - ry));
  }
  return toSource(px * (nw / tw), py * (nh / th));
}

/**
 * 纪元 Γ（Γ-1）：encodeForVlm 的元信息通道 —— 同一编码管线，返回值收窄为
 * EncodedImageMeta（sourceWidth/Height、cropRect、foveated 必填在场）。
 * 坐标反算的消费端（grounding / vlmOcr）以本函数为唯一编码入口：编码后
 * 坐标系（value.width×height）与源图坐标系（sourceWidth×sourceHeight）的
 * 换算基准一次拿全。失败语义与 encodeForVlm 完全一致（ok:false + error，
 * 绝不抛）。
 */
export async function encodeForVlmMeta(
  buffer: Buffer,
  opts?: {
    maxDimension?: number;
    quality?: number;
    region?: Bbox;
    foveated?: boolean;
    foveaSize?: number;
    foveaPeripheryScale?: number;
    /** 纪元 Γ2：中央凹模式（'blur' 缺省 | 'inset'），透传 encodeForVlm */
    foveaMode?: 'blur' | 'inset';
    /** W1-9：注视中心（源图归一化 [0,1]²），透传 encodeForVlm */
    foveaCenter?: { x: number; y: number };
  },
): Promise<{ ok: boolean; value?: EncodedImageMeta; error?: string }> {
  const r = await encodeForVlm(buffer, opts);
  if (!r.ok || !r.value) return { ok: false, error: r.error };
  const v = r.value;
  // 防御规整：核心路径恒在场；此处兜底使「必填」承诺在任何输入下成立
  const value: EncodedImageMeta = {
    ...v,
    sourceWidth: typeof v.sourceWidth === 'number' && Number.isFinite(v.sourceWidth) && v.sourceWidth >= 1
      ? Math.floor(v.sourceWidth) : v.width,
    sourceHeight: typeof v.sourceHeight === 'number' && Number.isFinite(v.sourceHeight) && v.sourceHeight >= 1
      ? Math.floor(v.sourceHeight) : v.height,
    foveated: v.foveated === true,
    cropRect: v.cropRect ?? null,
  };
  return { ok: true, value };
}

// ─── W3-3（P2+C3 脏矩形增量编码）：补丁三系坐标 + 补丁编码 ───
//
// 视频编码的 P 帧直觉搬进 VLM 上下文：屏幕的小步变化不必重发整帧 —— 关键帧
// 之后只发「脏矩形补丁」（原生分辨率裁出的小图 + 锚点元数据「patch@(x,y,w,h)
// 替换主帧该区」）。本节是坐标几何的收口面：补丁在三个坐标系之间换算 ——
//   · 源图系（PatchRect，整数像素，截屏缓冲的真实分辨率）—— 裁剪与账本的
//     记账基准；
//   · 编码图系（关键帧经 encodeForVlm 缩放后的像素空间）—— 模型实际看到的
//     主帧坐标（锚点文本给模型的落位基准）；
//   · 归一化系（[0,1]²，与 DiffRegion.bbox_normalized 同方言）—— 跨分辨率的
//     通用语。
// 换算律（与 mapEncodedToOriginal/mapInsetToOriginal 同族先例：先检后洗、
// 绝不抛、脏输入诚实降级）：
//   · 源图 → 归一化 → 源图：恒等往返（整数坐标除乘同基数，浮点残差被
//     round 吸收 —— 往返 0px 的数学根据）；
//   · 源图 → 编码 → 源图：逐边 ≤1px（两段 round 的取整残差上界 —— 与
//     mapEncodedToOriginal 的同款诚实边界）。

/** W3-3：源图像素系整数矩形 —— 补丁/条带的几何载体（左上原点，半开区间约定） */
export interface PatchRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** W3-3：归一化补丁框（[0,1]²，x1>x0 半开约定 —— bbox_normalized 同方言） */
export interface PatchNorm {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** W3-3：维度体检（≥1 的有限数取整；脏值 0 —— 后续判据按不可用处理，不猜） */
function w3Dim(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0;
}

/** W3-3：坐标分量体检（非有限按 0 记 —— 与 mapEncodedToOriginal 同律） */
function w3Fin(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/**
 * W3-3 纯函数：补丁矩形体检 + 收口进源图画布（先检后洗：非有限分量/退化尺寸
 * ⇒ null 诚实拒绝；越界收口 = **边缘保全律**——左/上原点 clamp ≥0 时右/下边
 * 原位保留（w = clamp(round(x+w)) − x'），只裁掉画布外部分、绝不平移扩边
 * （补丁是从当前帧裁出的真像素，覆盖域保真比贪几像素更重要）。收口后
 * w/h <1 ⇒ null。绝不抛。
 */
export function cleanPatchRect(
  rect: unknown,
  srcW: number,
  srcH: number,
): PatchRect | null {
  const r = rect as PatchRect | null | undefined;
  if (r === null || typeof r !== 'object') return null;
  const rx = w3Fin(r.x), ry = w3Fin(r.y), rw = w3Fin(r.w), rh = w3Fin(r.h);
  const W = w3Dim(srcW), H = w3Dim(srcH);
  if (W < 1 || H < 1) return null;
  if (!(rw >= 1) || !(rh >= 1)) return null;
  const x = Math.min(Math.max(0, Math.round(rx)), W - 1);
  const y = Math.min(Math.max(0, Math.round(ry)), H - 1);
  const x1 = Math.min(Math.max(x + 1, Math.round(rx + rw)), W);
  const y1 = Math.min(Math.max(y + 1, Math.round(ry + rh)), H);
  const w = x1 - x, h = y1 - y;
  if (w < 1 || h < 1) return null;
  return { x, y, w, h };
}

/**
 * W3-3 纯函数：源图像素矩形 → 归一化框（x0=x/W … x1=(x+w)/W）。
 * 脏矩形/脏维度 ⇒ 全图回退 {0,0,1,1}（不猜、不抛）。恒等往返的铸造面。
 */
export function patchRectToNormalized(rect: PatchRect, srcW: number, srcH: number): PatchNorm {
  const p = cleanPatchRect(rect, srcW, srcH);
  const W = w3Dim(srcW), H = w3Dim(srcH);
  if (!p || W < 1 || H < 1) return { x0: 0, y0: 0, x1: 1, y1: 1 };
  return { x0: p.x / W, y0: p.y / H, x1: (p.x + p.w) / W, y1: (p.y + p.h) / H };
}

/**
 * W3-3 纯函数：归一化框 → 源图像素矩形（逐边独立 round：x=round(x0·W)、
 * w=round(x1·W)−round(x0·W) —— 两边独立取整保证 w ≥1 只需 x1>x0 的浮点
 * 间距 ≥ 1px；脏值回退全图）。与 patchRectToNormalized 构成恒等往返。
 */
export function normalizedToPatchRect(norm: PatchNorm, srcW: number, srcH: number): PatchRect {
  const W = w3Dim(srcW), H = w3Dim(srcH);
  const n = norm ?? ({} as PatchNorm);
  const x0 = w3Fin(n.x0), y0 = w3Fin(n.y0), x1 = w3Fin(n.x1), y1 = w3Fin(n.y1);
  if (W < 1 || H < 1) return { x: 0, y: 0, w: 1, h: 1 };
  const px = Math.min(Math.max(0, Math.round(x0 * W)), W - 1);
  const py = Math.min(Math.max(0, Math.round(y0 * H)), H - 1);
  const px1 = Math.min(Math.max(px + 1, Math.round(x1 * W)), W);
  const py1 = Math.min(Math.max(py + 1, Math.round(y1 * H)), H);
  return { x: px, y: py, w: px1 - px, h: py1 - py };
}

/**
 * W3-3 纯函数：源图像素矩形 → 编码图像素矩形（关键帧编码空间 —— 锚点文本的
 * 落位基准）。逐边独立 round（xe=round(x·encW/W)，we=round((x+w)·encW/W)−xe），
 * 保证 we ≥1（补丁在编码图上不消失）。脏维度 ⇒ 回退原矩形（换算缺席 =
 * 两系重合的诚实假设，不猜）。往返 encodedPatchRectToSource 逐边 ≤1px。
 */
export function patchRectToEncoded(
  rect: PatchRect,
  srcW: number,
  srcH: number,
  encW: number,
  encH: number,
): PatchRect {
  const p = cleanPatchRect(rect, srcW, srcH);
  const W = w3Dim(srcW), H = w3Dim(srcH), EW = w3Dim(encW), EH = w3Dim(encH);
  if (!p || W < 1 || H < 1 || EW < 1 || EH < 1) {
    return p ?? cleanPatchRect(rect, 1 << 30, 1 << 30) ?? { x: 0, y: 0, w: 1, h: 1 };
  }
  const ex = Math.min(Math.max(0, Math.round((p.x * EW) / W)), EW - 1);
  const ey = Math.min(Math.max(0, Math.round((p.y * EH) / H)), EH - 1);
  const ex1 = Math.min(Math.max(ex + 1, Math.round(((p.x + p.w) * EW) / W)), EW);
  const ey1 = Math.min(Math.max(ey + 1, Math.round(((p.y + p.h) * EH) / H)), EH);
  return { x: ex, y: ey, w: ex1 - ex, h: ey1 - ey };
}

/**
 * W3-3 纯函数：编码图像素矩形 → 源图像素矩形（patchRectToEncoded 的逆）。
 * 逐边独立 round ⇒ 往返逐边 ≤1px（两段取整残差上界，与 mapEncodedToOriginal
 * 的诚实边界同族）。脏维度回退原矩形。
 */
export function encodedPatchRectToSource(
  rect: PatchRect,
  encW: number,
  encH: number,
  srcW: number,
  srcH: number,
): PatchRect {
  const EW = w3Dim(encW), EH = w3Dim(encH), W = w3Dim(srcW), H = w3Dim(srcH);
  const r = cleanPatchRect(rect, EW || 1 << 30, EH || 1 << 30);
  if (EW < 1 || EH < 1 || W < 1 || H < 1 || !r) {
    return cleanPatchRect(rect, W || 1 << 30, H || 1 << 30) ?? { x: 0, y: 0, w: 1, h: 1 };
  }
  const sx = Math.min(Math.max(0, Math.round((r.x * W) / EW)), W - 1);
  const sy = Math.min(Math.max(0, Math.round((r.y * H) / EH)), H - 1);
  const sx1 = Math.min(Math.max(sx + 1, Math.round(((r.x + r.w) * W) / EW)), W);
  const sy1 = Math.min(Math.max(sy + 1, Math.round(((r.y + r.h) * H) / EH)), H);
  return { x: sx, y: sy, w: sx1 - sx, h: sy1 - sy };
}

/**
 * W3-3 纯函数：补丁锚点文本 —— VLM 的替换语义说明（投递协议的文本面）。
 * 三系坐标并列给出：模型按自己的坐标系（归一化 / 关键帧编码像素）择一落位，
 * 源图像素系供工程侧审计。脏输入回退全图锚点（不猜、不抛）。
 */
export function patchAnchorText(
  rect: PatchRect,
  src: { width: number; height: number },
  enc: { width: number; height: number },
): string {
  const p = cleanPatchRect(rect, src?.width, src?.height);
  const W = w3Dim(src?.width), H = w3Dim(src?.height);
  if (!p || W < 1 || H < 1) {
    return 'patch@(full-frame) replaces the entire keyframe';
  }
  const EW = w3Dim(enc?.width), EH = w3Dim(enc?.height);
  const e = EW >= 1 && EH >= 1
    ? patchRectToEncoded(p, W, H, EW, EH)
    : { x: p.x, y: p.y, w: p.w, h: p.h };
  const n = patchRectToNormalized(p, W, H);
  const f3 = (v: number) => (Math.round(v * 1000) / 1000).toFixed(3);
  return `patch@(${p.x},${p.y},${p.w},${p.h}) replaces that region of the keyframe` +
    ` | source-px (${p.x},${p.y}) ${p.w}x${p.h}` +
    ` | keyframe-encoded-px (${e.x},${e.y}) ${e.w}x${e.h}` +
    ` | normalized (${f3(n.x0)},${f3(n.y0)})-(${f3(n.x1)},${f3(n.y1)})`;
}

/** W3-3：补丁编码结果 —— EncodedImageMeta（cropRect=原生裁剪窗的权威记录）+ 补丁几何 + 锚点文本 */
export interface PatchEncoded extends EncodedImageMeta {
  /** 生效的补丁矩形（源图像素系整数 —— 收口进画布后的实际值） */
  patch: PatchRect;
  /** 补丁归一化框（[0,1]²，源图系归一） */
  patchNormalized: PatchNorm;
  /** 锚点文本（三系并列 —— 投递协议直接消费） */
  anchorText: string;
}

/**
 * W3-3：把当前帧的脏矩形裁出为 VLM 就绪补丁 —— 原生分辨率 extract（无损
 * 精度起点）→ encodeForVlm（长边超限时才缩放；补丁通常远小于带宽 ⇒ 原生
 * 分辨率直达）。cropRect 随行（原生裁剪窗的权威记录 —— 坐标反算的平移基准）。
 *
 * 锚点基准：opts.keyframeEncoded 给主帧（关键帧）的编码后维度 —— 锚点文本的
 * 编码系换算用它（模型手里的主帧坐标系）；缺席 = 假设关键帧未缩放（编码系与
 * 源图系重合的诚实假设）。
 *
 * 失败路径一律 {ok:false,error}，绝不抛：空缓冲、矩形脏值（退化/越界收口后
 * <1px）、sharp 不可用、缓冲不可解码。
 */
export async function encodePatchForVlm(
  frame: Buffer,
  rect: PatchRect,
  opts?: {
    quality?: number;
    maxDimension?: number;
    /** 关键帧编码后维度（锚点文本的编码系基准；缺席 = 源图系即编码系） */
    keyframeEncoded?: { width: number; height: number };
  },
): Promise<{ ok: boolean; value?: PatchEncoded; error?: string }> {
  try {
    if (!Buffer.isBuffer(frame) || frame.length === 0) {
      return { ok: false, error: 'encodePatchForVlm: empty frame buffer' };
    }
    // 维度探测：补丁收口需要画布尺寸（越界收口而非拒绝 —— 防御式裁剪）
    let sharp: SharpLike;
    try {
      sharp = await resolveSharp();
    } catch (e: any) {
      return { ok: false, error: `sharp unavailable for patch encoding: ${e?.message ?? String(e)}` };
    }
    let W = 0, H = 0;
    try {
      const meta = await sharp(frame).metadata();
      W = meta.width ?? 0;
      H = meta.height ?? 0;
    } catch (e: any) {
      return { ok: false, error: `cannot decode frame for patch: ${e?.message ?? String(e)}` };
    }
    const p = cleanPatchRect(rect, W, H);
    if (!p) {
      return { ok: false, error: `encodePatchForVlm: invalid patch rect ${JSON.stringify(rect) ?? String(rect)} in ${W}x${H}` };
    }
    const enc = await encodeForVlmMeta(frame, {
      region: { x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h },
      quality: opts?.quality,
      maxDimension: opts?.maxDimension,
    });
    if (!enc.ok || !enc.value) return { ok: false, error: enc.error };
    const ke = opts?.keyframeEncoded;
    const keW = w3Dim(ke?.width), keH = w3Dim(ke?.height);
    const value: PatchEncoded = {
      ...enc.value,
      patch: p,
      patchNormalized: patchRectToNormalized(p, W, H),
      anchorText: keW >= 1 && keH >= 1
        ? patchAnchorText(p, { width: W, height: H }, { width: keW, height: keH })
        : patchAnchorText(p, { width: W, height: H }, { width: W, height: H }),
    };
    return { ok: true, value };
  } catch (e: any) {
    return { ok: false, error: `encodePatchForVlm failed: ${e?.message ?? String(e)}` };
  }
}

// ─── W1-9（C4 预算弹性调度）：requote 建议档 + 防抖 ───

/** W1-9：requote 建议档位 —— original（原档）| economy（quality 钳 60）| deep（再钳 maxDim 1024） */
export type VlmTier = 'original' | 'economy' | 'deep';

/** W1-9：requote 判决 —— 建议编码参数分档 + 每步可花额度 + 防抖状态（全部建议性，调用方可选消费） */
export interface VlmRequote {
  /** 防抖后**生效**档（本次调用方应采用的档） */
  tier: VlmTier;
  /** 生效档的 JPEG 质量（只降不升：原档=调用方现档；economy/deep=min(现档,60)） */
  quality: number;
  /** 生效档的长边上限（deep=min(现档,1024)；其余=调用方现档） */
  maxDimension: number;
  /** 生效档单帧预估视觉 token（estimateVlmTokens @ 16:9 长边钉 maxDim —— 记账反馈尺） */
  estTokensPerImage: number;
  /** 每步可花字节额度 = 剩余字节配额 / max(1, floor(remainingSteps))（步数不可用 ⇒ Infinity） */
  perStepBytes: number;
  /** 每步可花张数额度 = 剩余张数配额 / max(1, floor(remainingSteps))（同上） */
  perStepImages: number;
  /** 本次**原始**建议档（防抖前 —— 与 tier 的差值即防抖在途证据） */
  rawTier: VlmTier;
  /** 当前待切换档的连续一致计数（0 = 无在途切换） */
  consecutiveAgree: number;
  /** true 仅在本次调用完成档位切换的那一帧（切换事件沿） */
  switched: boolean;
  /** 人类可读判决依据（分档 + 防抖注记） */
  reason: string;
}

/** W1-9：无记账历史时的单帧字节估计（1568 带宽 JPEG q80 典型值 ~300KB —— 经验常数，仅建议档的粗估尺） */
const REQUOTE_DEFAULT_BYTES = 300 * 1024;
/** W1-9：quality 每降 20 点的字节收益锚（80→60 ≈ ×0.7 —— JPEG 质量步进的线性化锚点） */
const REQUOTE_QUALITY_STEP = 0.3;
/** W1-9：防抖默认窗宽（连续 3 次建议一致才切换 —— 单次尖峰不改档） */
const REQUOTE_DEBOUNCE_N = 3;
/** W1-9：economy 档质量钳（80→60 的第一级） */
const ECONOMY_QUALITY = 60;
/** W1-9：deep 档长边钳（1568→1024 的第二级） */
const DEEP_MAX_DIM = 1024;
/** W1-9：token 估算的帧型假设（16:9 长边钉 maxDim —— 桌面截图主导形态） */
const REQUOTE_ASPECT_H = 9 / 16;

/**
 * W1-9：quality 步进的字节率线性化 —— 锚定「降 20 点 ⇒ ×0.7」，按 Δq 比例外推，
 * 夹 [0.3,1]（升档不涨字节估计：factor=1；线性外推只用于降档侧）。经验模型，
 * 服务分档判决的粗估（建议性参数，非账面数值）。
 */
function qualityByteFactor(fromQ: number, toQ: number): number {
  if (!(fromQ > 0) || toQ >= fromQ) return 1;
  return Math.min(1, Math.max(0.3, 1 - (REQUOTE_QUALITY_STEP * (fromQ - toQ)) / 20));
}

/**
 * 任务级视觉配额闸门：check（只读试探）→ commit（真正记账）两段式。
 * check 返回当前用量快照（usedImages/usedBytes 为**本次之前**的累计），
 * 超限时 allowed:false 且 reason 说明原因（张数与字节可能同时超限，reason
 * 以 '; ' 连接）。所有方法对脏输入（NaN/负数/缺字段）安全，绝不抛错。
 * W1-9（C4 预算弹性调度）：增 requote(remainingSteps) —— 按剩余配额/预估
 * 剩余步数算「每步可花额度」，产出建议编码参数分档（quality 80→60、
 * maxDim 1568→1024 两级钳制；配额充裕返回原档）。建议性：不改 check/commit
 * 的强制语义，调用方按需消费；防抖状态（连续 N 次一致才切换）是 requote
 * 自身的唯一可变状态 —— 用量账面 zero 触碰。
 */
export class VlmBudget {
  private readonly maxImages: number;
  private readonly maxBytes: number;
  private usedImages = 0;
  private usedBytes = 0;
  // ── W1-9（C4）：分档防抖状态（requote 专属；check/commit/summary 不读不写） ──
  /** 当前生效档（新任务恒从 original 起步 —— 不因上次任务的紧张自动降档） */
  private activeTier: VlmTier = 'original';
  /** 待切换档（null = 无在途切换） */
  private pendingTier: VlmTier | null = null;
  /** 待切换档的连续一致计数 */
  private consecutiveAgree = 0;

  constructor(opts?: { maxImagesPerTask?: number; maxBytesPerTask?: number }) {
    const rawImages = opts?.maxImagesPerTask;
    const rawBytes = opts?.maxBytesPerTask;
    this.maxImages = typeof rawImages === 'number' && Number.isFinite(rawImages)
      ? Math.max(0, Math.floor(rawImages))
      : DEFAULT_MAX_IMAGES;
    this.maxBytes = typeof rawBytes === 'number' && Number.isFinite(rawBytes)
      ? Math.max(0, Math.floor(rawBytes))
      : DEFAULT_MAX_BYTES;
  }

  /** 只读试探：这张图还允不允许下发？不改变任何用量状态 */
  check(encoded: { bytes: number }): {
    allowed: boolean;
    reason?: string;
    usedImages: number;
    usedBytes: number;
  } {
    const bytes = cleanBytes(encoded?.bytes);
    const reasons: string[] = [];
    if (this.usedImages + 1 > this.maxImages) {
      reasons.push(`image quota exceeded: ${this.usedImages}+1 > ${this.maxImages} (maxImagesPerTask)`);
    }
    if (this.usedBytes + bytes > this.maxBytes) {
      reasons.push(`byte quota exceeded: ${this.usedBytes}+${bytes} > ${this.maxBytes} (maxBytesPerTask)`);
    }
    return {
      allowed: reasons.length === 0,
      reason: reasons.length > 0 ? reasons.join('; ') : undefined,
      usedImages: this.usedImages,
      usedBytes: this.usedBytes,
    };
  }

  /** 真正记账：张数 +1、字节累计（先 check 后 commit 是调用方的纪律） */
  commit(encoded: { bytes: number }): void {
    this.usedImages += 1;
    this.usedBytes += cleanBytes(encoded?.bytes);
  }

  /** 清零用量（新任务开始时复用同一闸门实例）—— W1-9：弹性档与防抖一并归零 */
  reset(): void {
    this.usedImages = 0;
    this.usedBytes = 0;
    this.activeTier = 'original';
    this.pendingTier = null;
    this.consecutiveAgree = 0;
  }

  /** 用量与上限快照 */
  summary(): { usedImages: number; usedBytes: number; maxImages: number; maxBytes: number } {
    return {
      usedImages: this.usedImages,
      usedBytes: this.usedBytes,
      maxImages: this.maxImages,
      maxBytes: this.maxBytes,
    };
  }

  /**
   * W1-9（C4 预算弹性调度）：按剩余配额 / 预估剩余步数算「每步可花额度」，
   * 产出建议编码参数分档。**建议性方法**：返回值是参数建议，check/commit 的
   * 强制闸门语义零变化（调用方可选消费 —— 见返回值 quality/maxDimension）。
   *
   * 判决律（字节驱动）：
   *   perStepBytes = (maxBytes − usedBytes) / max(1, floor(remainingSteps))
   *   单帧字节估计 = 记账反馈 × quality 字节率因子 × (maxDim 比)²
   *   · perStepBytes ≥ est(原档)          ⇒ raw='original'（配额充裕返回原档）
   *   · perStepBytes ≥ est(经济档 q60)     ⇒ raw='economy'（第一级钳制：quality→60）
   *   · 否则                                ⇒ raw='deep'（第二级钳制：maxDim→1024）
   * 两级钳制**只降不升**：economy=min(现档q,60)、deep=min(现档d,1024) —— 调用
   * 方已在低档时不被建议拉回高档。张数配额分档无法增补（省字节不省张数），
   * 不足只入 reason 提示。
   *
   * 记账反馈（单帧字节估计的来源，优先级降序）：显式 opts.bytesPerImage >
   * 本闸门 commit 历史（usedBytes/usedImages 的均值 —— 既有记账的免费复用）>
   * 经验缺省 300KB。token 反馈走 estimateVlmTokens（16:9 长边钉 maxDim）。
   *
   * 防抖：raw 档 ≠ 生效档时累计连续一致计数，连续 N 次（缺省 3，opts.debounceN
   * 可调，1 = 无防抖）才切换生效 —— 单次尖峰（如一次超大截图）不改档；raw 档
   * 回到生效档即清零在途切换。对称双向（降档与升档同律 —— 配额只减不增时升档
   * 自然罕见，reset() 显式归零）。
   *
   * 防御（绝不抛）：remainingSteps 非有限/<1 ⇒ 视为步数不可用：维持生效档 +
   * perStep*=Infinity + reason 注记；opts 各字段脏值回声缺省。除防抖计数外
   * 零状态写入（用量账面只读）。
   */
  requote(remainingSteps: number, opts?: {
    /** 调用方当前编码档（缺省 = codec 缺省 q80/d1568 —— 建议以此为基线只降不升） */
    current?: { quality?: number; maxDimension?: number };
    /** 防抖窗宽 N（缺省 3；1 = 立即切换） */
    debounceN?: number;
    /** 显式单帧字节反馈（缺省走本闸门 commit 历史均值，再缺省经验值 300KB） */
    bytesPerImage?: number;
  }): VlmRequote {
    // 基线档体检：脏值回声 codec 缺省（q80/d1568）
    const rawQ = opts?.current?.quality;
    const curQ = typeof rawQ === 'number' && Number.isFinite(rawQ) && rawQ >= 1 && rawQ <= 100
      ? Math.round(rawQ)
      : DEFAULT_QUALITY;
    const rawD = opts?.current?.maxDimension;
    const curD = typeof rawD === 'number' && Number.isFinite(rawD) && rawD >= 1
      ? Math.round(rawD)
      : DEFAULT_MAX_DIMENSION;
    const rawN = opts?.debounceN;
    const debounceN = typeof rawN === 'number' && Number.isFinite(rawN) && rawN >= 1
      ? Math.floor(rawN)
      : REQUOTE_DEBOUNCE_N;

    // 两级钳制档（只降不升）
    const ecoQ = Math.min(curQ, ECONOMY_QUALITY);
    const deepQ = ecoQ;
    const deepD = Math.min(curD, DEEP_MAX_DIM);

    // 单帧字节估计的记账反馈：显式入参 > commit 历史均值 > 经验缺省
    const rawBpi = opts?.bytesPerImage;
    const perImageBytes = typeof rawBpi === 'number' && Number.isFinite(rawBpi) && rawBpi > 0
      ? rawBpi
      : (this.usedImages > 0 && this.usedBytes > 0
        ? this.usedBytes / this.usedImages
        : REQUOTE_DEFAULT_BYTES);
    const estBytes = (q: number, d: number): number =>
      perImageBytes * qualityByteFactor(curQ, q) * (d / curD) * (d / curD);
    const estO = estBytes(curQ, curD);
    const estE = estBytes(ecoQ, curD);
    const estDeep = estBytes(deepQ, deepD);

    const bytesRemaining = Math.max(0, this.maxBytes - this.usedBytes);
    const imagesRemaining = Math.max(0, this.maxImages - this.usedImages);

    // 每步可花额度（步数不可用 ⇒ 无界 —— 维持原档，不猜视界）
    const stepsOk = typeof remainingSteps === 'number' && Number.isFinite(remainingSteps) && remainingSteps >= 1;
    const steps = stepsOk ? Math.max(1, Math.floor(remainingSteps)) : 1;
    const perStepBytes = stepsOk ? bytesRemaining / steps : Infinity;
    const perStepImages = stepsOk ? imagesRemaining / steps : Infinity;

    // 分档判决（字节驱动；边界含等号：恰好够 = 原档/经济档成立）
    let rawTier: VlmTier;
    let reason: string;
    if (!stepsOk) {
      rawTier = 'original';
      reason = `W1-9 requote: remainingSteps 不可用(${String(remainingSteps)})—— 维持生效档`;
    } else if (perStepBytes >= estO) {
      rawTier = 'original';
      reason = `W1-9 requote: 配额充裕 —— 每步可花 ${Math.round(perStepBytes)}B ≥ 原档单帧估计 ${Math.round(estO)}B`;
    } else if (perStepBytes >= estE) {
      rawTier = 'economy';
      reason = `W1-9 requote: 字节吃紧 —— 每步可花 ${Math.round(perStepBytes)}B < 原档 ${Math.round(estO)}B 而 ≥ 经济档 ${Math.round(estE)}B ⇒ quality→${ecoQ}`;
    } else {
      rawTier = 'deep';
      reason = `W1-9 requote: 字节告急 —— 每步可花 ${Math.round(perStepBytes)}B < 经济档 ${Math.round(estE)}B ⇒ quality→${deepQ} + maxDim→${deepD}`
        + (perStepBytes < estDeep ? '（deep 档也撑不满，步数内将见底）' : '');
    }
    if (stepsOk && imagesRemaining < steps) {
      reason += `；张数配额 ${imagesRemaining} 张不足以覆盖 ${steps} 步（分档只省字节不增张数）`;
    }

    // 防抖：连续 N 次建议一致才切换（单次尖峰不改档）；raw 回到生效档 ⇒ 清零在途
    let switched = false;
    if (rawTier === this.activeTier) {
      this.pendingTier = null;
      this.consecutiveAgree = 0;
    } else {
      if (this.pendingTier === rawTier) {
        this.consecutiveAgree += 1;
      } else {
        this.pendingTier = rawTier;
        this.consecutiveAgree = 1;
      }
      if (this.consecutiveAgree >= debounceN) {
        this.activeTier = rawTier;
        this.pendingTier = null;
        this.consecutiveAgree = 0;
        switched = true;
      }
    }
    const inFlight = this.activeTier !== rawTier && !switched;
    if (inFlight) {
      reason += `；防抖在途（连续一致 ${this.consecutiveAgree}/${debounceN}，生效档仍 ${this.activeTier}）`;
    }

    // 生效档参数 + token 反馈（16:9 长边钉 maxDim —— estimateVlmTokens 现尺）
    const tier = this.activeTier;
    const tierQ = tier === 'original' ? curQ : ecoQ;
    const tierD = tier === 'deep' ? deepD : curD;
    return {
      tier,
      quality: tierQ,
      maxDimension: tierD,
      estTokensPerImage: estimateVlmTokens(tierD, Math.max(1, Math.round(tierD * REQUOTE_ASPECT_H))),
      perStepBytes,
      perStepImages,
      rawTier,
      consecutiveAgree: this.consecutiveAgree,
      switched,
      reason,
    };
  }
}

/**
 * 视觉 Token 估算：宽、高各先封顶 2000（超出 2000 的分辨率对估算无增益 ——
 * 上游已按 maxDimension 缩放进带宽），再 (w*h)/750 向上取整。
 * 非有限/负值按 0 记；对宽、高各自单调不减。
 */
export function estimateVlmTokens(width: number, height: number): number {
  const clamp = (n: number): number =>
    typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(2000, n) : 0;
  const w = clamp(width);
  const h = clamp(height);
  return Math.ceil((w * h) / 750);
}
