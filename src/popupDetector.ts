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

/** 双模融合检测：take_screenshot 的唯一传感入口 */
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

  return {
    popup: geometric || matchedKeywords.length > 0,
    geometric,
    semantic: matchedKeywords.length > 0,
    matchedKeywords,
  };
}
