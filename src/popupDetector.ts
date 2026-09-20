// src/popupDetector.ts
// 弹窗双模检测：几何启发式 + 语义证据（B-8）。
// 几何：模态弹窗通常在屏幕中央形成一块「更亮、更均匀（低方差）」的面板 —— 对无文字
//       或非拉丁文字的弹窗依然有效，但有误报（任何亮色居中布局都会命中）。
// 语义：弹窗文案有极强的词族特征（cookie/accept/订阅/update…）。OCR 中央区域，
//       命中词表任一词即确认。与几何互补：横幅类弹窗（顶部条）几何必漏、语义能抓。
// 融合判据：geometric OR semantic —— 弹窗检测的使命是宁可误报拦截，不可漏报放行
// （popupGuard 拦截后模型只需多看一眼截图，代价有界；漏报则盲操作直接失败）。
// 批次 E 迁移：sharp 懒动态导入（_legacyDeps.getSharp）。
import { getSharp } from './_legacyDeps';
import { readText } from './textReader';

function avg(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** 中央区域裁剪框（几何与语义共用同一「弹窗栖息地」假设） */
function centerRegion(w: number, h: number, fraction = 0.4) {
  const inset = (1 - fraction) / 2;
  return {
    left: Math.round(w * inset),
    top: Math.round(h * inset),
    width: Math.round(w * fraction),
    height: Math.round(h * fraction),
  };
}

export async function detectPopupHeuristic(imageBuffer: Buffer): Promise<boolean> {
  try {
    const sharp = await getSharp();
    const meta = await sharp(imageBuffer).metadata();
    const w = meta.width!;
    const h = meta.height!;

    // 中央 40% 区域 vs 全图：亮度对比 + 方差对比
    const region = centerRegion(w, h);

    const [globalStats, centerStats] = await Promise.all([
      sharp(imageBuffer).stats(),
      sharp(imageBuffer).extract(region).stats(),
    ]) as [{ channels: Array<{ stdev: number; mean: number }> }, { channels: Array<{ stdev: number; mean: number }> }];

    const gStd = avg(globalStats.channels.map((c: { stdev: number }) => c.stdev));
    const cStd = avg(centerStats.channels.map((c: { stdev: number }) => c.stdev));
    const gMean = avg(globalStats.channels.map((c: { mean: number }) => c.mean));
    const cMean = avg(centerStats.channels.map((c: { mean: number }) => c.mean));

    // 中央更均匀（方差显著低于全局）且更亮（弹窗多为高亮底色）-> 判定为弹窗
    return cStd < gStd * 0.55 && cMean > gMean * 1.15;
  } catch {
    // 检测失败不应阻断截图主流程：宁可漏报，不可误杀
    return false;
  }
}

export interface PopupDetection {
  popup: boolean;
  geometric: boolean;
  semantic: boolean;
  matchedKeywords: string[]; // 语义命中的词（锚点展示用，截断至 3 个）
  /** F-3 贝叶斯信念后验 0~1（迟滞滤波后的连续量 —— 证据强度的透明面） */
  belief?: number;
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
const LOGIT = (p: number): number => Math.log(p / (1 - p));
const SIGMOID = (x: number): number => 1 / (1 + Math.exp(-x));
const EVIDENCE_GEO = 4.0;   // 几何证据强度（nats）—— 单帧几何 ⇒ 后验 ≈0.98（立即 ON）
const EVIDENCE_SEM = 5.0;   // 语义证据更强（词表命中是确定性更强的信号）
const EVIDENCE_CLEAN = -1.5; // 清洁帧证据 —— 单帧清洁把 ON 态拉入迟滞带但不放行
const ON_THRESHOLD = 0.6;
const OFF_THRESHOLD = 0.35;

export interface PopupEvidenceFrame {
  geometric: boolean;
  semantic: boolean;
}

/** 施密特弹窗滤波器（纯类 —— 可注入任意帧序列，测试的确定性事实源） */
export class SchmittPopupFilter {
  private logOdds = LOGIT(POPUP_PRIOR);
  private active = false;

  /** 单帧更新：返回滤波后的信念与迟滞态 */
  update(ev: PopupEvidenceFrame): { belief: number; active: boolean } {
    const strength = ev.semantic ? EVIDENCE_SEM : ev.geometric ? EVIDENCE_GEO : EVIDENCE_CLEAN;
    this.logOdds += strength;
    const belief = SIGMOID(this.logOdds);
    // 施密特触发：进入需越 ON 线，退出需跌破 OFF 线 —— 迟滞带内保持原态
    if (!this.active && belief >= ON_THRESHOLD) this.active = true;
    else if (this.active && belief <= OFF_THRESHOLD) this.active = false;
    return { belief: Math.round(belief * 1000) / 1000, active: this.active };
  }

  reset(): void {
    this.logOdds = LOGIT(POPUP_PRIOR);
    this.active = false;
  }
}

/** 模块级滤波器单例（take_screenshot 每帧喂数；插件卸载经 resetPopupBelief 归零） */
const popupFilter = new SchmittPopupFilter();

export function resetPopupBelief(): void {
  popupFilter.reset();
}

export interface PopupDetectOptions {
  /** OCR 总开关（与 textReader 同源配置）：关闭时语义通道整体跳过，零额外开销 */
  enableOcr?: boolean;
  /** 语义词表（逗号分隔，来自 cordis.yml popupKeywords） */
  popupKeywords?: string;
  ocrLang?: string;
}

/**
 * 语义证据：OCR 中央带，词表命中任一即确认。
 * 失败（OCR 不可用/超时/无语言包）静默返回空 —— 几何证据独立生效，行为零回归。
 */
async function detectPopupSemantic(
  imageBuffer: Buffer,
  keywords: string[],
  ocrLang: string,
): Promise<string[]> {
  if (keywords.length === 0) return [];
  try {
    const sharp = await getSharp();
    const meta = await sharp(imageBuffer).metadata();
    const w = meta.width!, h = meta.height!;
    if (w < 32 || h < 32) return [];

    // 放大到 1200 宽再识别：小字命中率的关键（与 textReader.semanticConfirm 同律）
    const crop = await sharp(imageBuffer)
      .extract(centerRegion(w, h, 0.6))
      .resize(1200)
      .toBuffer();

    const { text } = await readText(crop, ocrLang);
    const hay = text.toLowerCase();
    const matched: string[] = [];
    for (const kw of keywords) {
      if (hay.includes(kw)) matched.push(kw);
      if (matched.length >= 3) break; // 证据上限：锚点不因词表膨胀
    }
    return matched;
  } catch {
    return [];
  }
}

/** 双模融合检测 + F-3 贝叶斯迟滞滤波：take_screenshot 的唯一传感入口 */
export async function detectPopup(
  imageBuffer: Buffer,
  opts: PopupDetectOptions = {},
): Promise<PopupDetection> {
  const geometric = await detectPopupHeuristic(imageBuffer);

  const keywords = (opts.popupKeywords ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  const matchedKeywords = opts.enableOcr && keywords.length > 0
    ? await detectPopupSemantic(imageBuffer, keywords, opts.ocrLang || 'eng')
    : [];

  // F-3：帧证据喂入施密特滤波 —— 单帧强证据立即 ON（旧行为），单帧噪声不再翻转
  const { belief, active } = popupFilter.update({
    geometric,
    semantic: matchedKeywords.length > 0,
  });

  return {
    popup: active,
    geometric,
    semantic: matchedKeywords.length > 0,
    matchedKeywords,
    belief,
  };
}
