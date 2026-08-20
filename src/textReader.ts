// src/textReader.ts
// 第四轮创新之二：文字感知层（本地 OCR）。
// 纯视觉架构的最后一道认知缺口：模型「看得见」却难以百分百确认文字内容。
// OCR 补上语义闭环的三块拼图：
//   1. find_text：文字 → 精确坐标（带文字标签的元素不再靠坐标估算）
//   2. read_text：区域文字读取（用文本替代截图，Token 数量级下降）
//   3. semanticConfirm：动作后自动核对「预期文字是否出现」
// 依赖 tesseract.js（语言数据首次使用时按需下载，故 enableOcr 默认关闭）。
//
// 批次 E 迁移：sharp / tesseract.js 不再作为 dependencies 强绑定，此处改为懒动态导入。
// 推荐替代：D-5 微服务 adapter.getUiTree({ funnelCeiling: 'L2' })。
import {
  getSharp, getTesseract, type TesseractWorkerLike,
} from './_legacyDeps';

export interface OcrWord {
  text: string;
  confidence: number;
  bbox_normalized: { x0: number; y0: number; x1: number; y1: number };
  center_normalized: { x: number; y: number };
}

export interface OcrResult {
  text: string;
  words: OcrWord[];
}

let workerPromise: Promise<TesseractWorkerLike> | null = null;
let workerLang = '';

async function getWorker(lang: string): Promise<TesseractWorkerLike> {
  if (!workerPromise || workerLang !== lang) {
    workerLang = lang;
    const tess = await getTesseract();
    workerPromise = tess.createWorker(lang).catch(e => {
      workerPromise = null; // 失败后允许重试（网络恢复时）
      throw e;
    });
  }
  return workerPromise;
}

/** 生命周期清理：插件卸载时终止 OCR worker（DSH 注册即效果模型的良好公民） */
export async function disposeOcr(): Promise<void> {
  if (workerPromise) {
    try { (await workerPromise).terminate(); } catch { /* already dead */ }
    workerPromise = null;
  }
}

const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

export async function readText(buffer: Buffer, lang = 'eng'): Promise<OcrResult> {
  const worker = await getWorker(lang);
  const { data } = await worker.recognize(buffer);
  const sharp = await getSharp();
  const meta = await sharp(buffer).metadata();
  const W = meta.width!, H = meta.height!;

  // tesseract v5 的词级输出结构随版本有差异，防御性兼容 words / lines.words
  const anyData = data as any;
  const rawWords: any[] = anyData.words
    ?? anyData.lines?.flatMap((l: any) => l.words ?? []) ?? [];

  const words: OcrWord[] = rawWords
    .filter(w => (w.confidence ?? 0) > 60 && w.text?.trim())
    .map(w => {
      const b = w.bbox;
      return {
        text: w.text.trim(),
        confidence: w.confidence,
        bbox_normalized: { x0: b.x0 / W, y0: b.y0 / H, x1: b.x1 / W, y1: b.y1 / H },
        center_normalized: { x: (b.x0 + b.x1) / 2 / W, y: (b.y0 + b.y1) / 2 / H },
      };
    });

  return { text: data.text ?? '', words };
}

export interface SemanticConfirm {
  confirmed: boolean;
  snippet: string; // 区域文字摘录（截断），供锚点展示
}

/**
 * 语义核对：在动作点邻域内 OCR，检查预期文字是否出现。
 * 大小写/空白不敏感的包含匹配。任何失败返回 null（调用方降级为 ocr-unavailable）。
 */
export async function semanticConfirm(
  fullBuf: Buffer,
  cxPct: number,
  cyPct: number,
  radiusPct: number,
  expected: string,
  lang = 'eng',
): Promise<SemanticConfirm | null> {
  try {
    const sharp = await getSharp();
    const meta = await sharp(fullBuf).metadata();
    const W = meta.width!, H = meta.height!;
    const left = Math.max(0, Math.round((cxPct - radiusPct) * W));
    const top = Math.max(0, Math.round((cyPct - radiusPct) * H));
    const width = Math.min(W - left, Math.round(radiusPct * 2 * W));
    const height = Math.min(H - top, Math.round(radiusPct * 2 * H));
    if (width < 8 || height < 8) return null;

    // 放大到 1200 宽再识别：小区域文字的准确率关键
    const crop = await sharp(fullBuf)
      .extract({ left, top, width, height })
      .resize(1200)
      .toBuffer();

    const { text } = await readText(crop, lang);
    const hay = normalize(text);
    const needle = normalize(expected);
    return {
      confirmed: hay.includes(needle),
      snippet: text.replace(/\s+/g, ' ').trim().slice(0, 120),
    };
  } catch {
    return null;
  }
}
