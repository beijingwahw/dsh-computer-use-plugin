// src/textReader.ts
// 第四轮创新之二：文字感知层（本地 OCR）。
// 纯视觉架构的最后一道认知缺口：模型「看得见」却难以百分百确认文字内容。
// OCR 补上语义闭环的三块拼图：
//   1. find_text：文字 → 精确坐标（带文字标签的元素不再靠坐标估算）
//   2. read_text：区域文字读取（用文本替代截图，Token 数量级下降）
//   3. semanticConfirm：动作后自动核对「预期文字是否出现」
//
// 双路径（本轮接线）：D-5 服务端 L2 OCR（RapidOCR，getUiTree）优先；
// tesseract.js（懒动态导入）保留为 legacy 路径。enableOcr 语义不变。
// 纪元 Ω（云脑皮层接线）：semanticConfirm 增第三路径 —— 本地双路径皆败且
// vlmAssistOcr 开启且 GLM 可用时，readTextViaVlm 云脑兜底读屏（config 经
// setSemanticVlmOptions 模块级注入 —— 本文件无 Config 通道，最小侵入方案）。
import { fuzzyIncludes } from './fuzzy';
import {
  getSharp, getTesseract, type TesseractWorkerLike,
} from './_legacyDeps';
import * as backend from './physicalBackend';
import type { GlmClient } from './vlm/glmClient';
import { kernelRegistry } from './kernel/registry';

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
  if (workerPromise && workerLang === lang) return workerPromise;
  workerLang = lang;
  const prev = workerPromise;
  // 同步占位：并发首次调用共享同一个创建中的 worker（否则会各建一个，泄漏其一）
  const creating = getTesseract().then(tess => tess.createWorker(lang));
  workerPromise = creating;
  creating.catch(() => {
    if (workerPromise === creating) workerPromise = null; // 失败后允许重试（网络恢复时）
  });
  // 语言切换：新 worker 接班后终止旧 worker（否则旧实例存活到 disposeOcr）
  if (prev) { try { (await prev).terminate(); } catch { /* already dead */ } }
  return creating;
}

/** 生命周期清理：插件卸载时终止 OCR worker（DSH 注册即效果模型的良好公民） */
export async function disposeOcr(): Promise<void> {
  if (workerPromise) {
    try { (await workerPromise).terminate(); } catch { /* already dead */ }
    workerPromise = null;
  }
}

const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

// ─── D-5 服务端 L2 OCR 路径 ───

/**
 * 服务端 L2 OCR 可用性探测缓存。失败只做**限时负缓存**（60s）—— 引擎可能
 * 随部署修复/依赖安装恢复，一次失败锁死整个会话会把语义验证层饿死。
 */
const OCR_RETRY_MS = 60_000;
let serverOcrFailedAt = 0;

async function readScreenTextServer(region?: { x: number; y: number; width: number; height: number }): Promise<OcrResult | null> {
  if (Date.now() - serverOcrFailedAt < OCR_RETRY_MS) return null;
  let tree;
  try {
    tree = await backend.getUiTree({ source: 'ocr', region, funnelCeiling: 'L2' });
  } catch {
    serverOcrFailedAt = Date.now();
    return null;
  }
  if (tree.funnel_depth === 'empty' && tree.fault) {
    // L2 引擎缺席/出错 —— 限时负缓存后降级（不锁死）
    serverOcrFailedAt = Date.now();
    return null;
  }
  serverOcrFailedAt = 0;
  const words: OcrWord[] = tree.elements
    .filter(el => el.source === 'L2-ocr')
    .map(el => ({
      text: el.name,
      // 服务端已按 score≥0.5 过滤；这里给固定置信度（词级分数未跨线传）
      confidence: 90,
      bbox_normalized: {
        x0: el.rect.x, y0: el.rect.y,
        x1: el.rect.x + el.rect.width, y1: el.rect.y + el.rect.height,
      },
      center_normalized: {
        x: el.rect.x + el.rect.width / 2,
        y: el.rect.y + el.rect.height / 2,
      },
    }));
  return { text: words.map(w => w.text).join(' '), words };
}

/**
 * 双路径区域读取：服务端 L2 优先 → legacy tesseract（buffer+sharp）→ 抛错。
 * region 缺省 = 全屏。
 */
export async function readTextAny(
  region: { x: number; y: number; width: number; height: number } | undefined,
  lang = 'eng',
): Promise<OcrResult> {
  // 1) 服务端 L2
  const server = await readScreenTextServer(region);
  if (server) return server;
  // 2) legacy：tesseract.js + sharp（开发仓 / DSH_FORCE_LEGACY_SYSTEM）
  // Δ-5 探针前置：tesseract/sharp 是 devDeps（生产必挂）—— 先探可用性再截屏，
  // 免为注定失败的识别付出 captureCleanPng 整帧往返（服务端 OCR 负缓存只盖
  // 服务端路径，legacy 路径旧实现每次失败都先截屏再在 getTesseract 抛错）。
  // 探针错误有模块级记忆缓存（_legacyDeps 的 _tesseractError/_sharpError）——
  // 首败之后后续调用零成本直落（legacy 侧的负缓存语义）。
  await getTesseract();
  await getSharp();
  const buf = await backend.captureCleanPng(region);
  return readText(buf, lang);
}

/** legacy 路径：tesseract.js 识别既有 buffer（开发/测试路径，需 sharp+tesseract） */
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
    // 纪元 Θ（Θ-4 生产接线）：词置信截断线读内核注册表（ocr.wordConfidenceFloor，
    // 区间 [30,90]）—— 未注册 ⇒ getOrDefault 回声 60，过滤行为逐字节不变。
    .filter(w => (w.confidence ?? 0) > kernelRegistry.getOrDefault('ocr.wordConfidenceFloor', 60) && w.text?.trim())
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

// ─── 纪元 Ω：semanticConfirm 的 VLM 兜底（第三路径） ───

/**
 * semanticConfirm 的 VLM 兜底配置（模块级注入面）。
 * textReader 无 Config 通道（历史接线：语言由工具层逐参传入，配置不进本模块）——
 * 故经模块级 setter 注入：最小侵入方案（零签名变更、零调用方感知），
 * 宿主 apply() 接线一次（setSemanticVlmOptions），测试经 client 注入假云脑。
 */
export interface SemanticVlmOptions {
  /** 本地双路径（服务端 L2 + legacy tesseract）皆败后是否允许 VLM 兜底读屏（config.vlmAssistOcr） */
  assistOcr: boolean;
  /** VLM client 注入（缺省走 getGlmClient() 全局单例 —— 已由 configureVlm 按 config 铸造；测试注入假 client 绝不联网） */
  client?: GlmClient;
}

let semanticVlmOpts: SemanticVlmOptions | null = null;

/**
 * VLM 兜底配置注入（宿主 apply 接线；传 null 归零）。
 * 不注入 / assistOcr=false ⇒ semanticConfirm 行为与本纪元之前逐字节一致（无 Key 用户零变化）。
 */
export function setSemanticVlmOptions(opts: SemanticVlmOptions | null): void {
  semanticVlmOpts = opts && typeof opts === 'object'
    ? { assistOcr: opts.assistOcr === true, ...(opts.client ? { client: opts.client } : {}) }
    : null;
}

/**
 * 第三路径取字：本地双路径皆败后由云脑读邻域。
 * 邻域坐标是归一化百分比，readTextViaVlm 吃像素 —— 用 fullBuf 尺寸换算
 * （fullBuf 缺席则跳过：D-5 路径下可为 null，无像素即无换算）。
 * 对结果文本的模糊匹配由调用方（semanticConfirm）按 fuzzyIncludes 同律执行。
 * 任何不可用/失败返回 null（降级律：绝不抛、未配置零网络 —— 不改变无 Key 用户的行为）。
 */
async function vlmFallbackText(
  fullBuf: Buffer | null,
  region: { x: number; y: number; width: number; height: number },
  lang: string,
): Promise<string | null> {
  if (!semanticVlmOpts?.assistOcr) return null;      // 开关关闭：维持旧世界
  if (!fullBuf || fullBuf.length === 0) return null;  // 像素换算无从谈起
  try {
    const { isGlmConfigured } = await import('./vlm/glmClient');
    if (!semanticVlmOpts.client && !isGlmConfigured()) return null; // 无 Key：零网络零行为变化
    const { readTextViaVlm } = await import('./vlm/vlmOcr');
    const sharp = await getSharp();
    const meta = await sharp(fullBuf).metadata();
    const W = meta.width, H = meta.height;
    if (!W || !H || W < 1 || H < 1) return null;
    // 归一化 → 像素 bbox：左上 floor、右下 ceil（整数盒包含原浮点盒），夹回图内
    const px = {
      x0: Math.max(0, Math.floor(region.x * W)),
      y0: Math.max(0, Math.floor(region.y * H)),
      x1: Math.min(W, Math.ceil((region.x + region.width) * W)),
      y1: Math.min(H, Math.ceil((region.y + region.height) * H)),
    };
    if (px.x1 <= px.x0 || px.y1 <= px.y0) return null;
    const r = await readTextViaVlm(fullBuf, { region: px, lang, client: semanticVlmOpts.client });
    return r.ok ? r.text : null;
  } catch {
    return null; // 兜底自身失败 = 不可用：绝不抛、不毒化调用方（降级律最后一行）
  }
}

/** 测试钩子：预置服务端 OCR 负缓存时刻（测试环境避免触发 D-5 微服务启动；命名对齐 _legacyDeps 的 _forTest 约定） */
export function _setServerOcrFailedAt_forTest(ts: number): void {
  serverOcrFailedAt = typeof ts === 'number' && Number.isFinite(ts) ? ts : 0;
}

/**
 * 语义核对：在动作点邻域内 OCR，检查预期文字是否出现。
 * 大小写/空白不敏感的包含匹配。任何失败返回 null（调用方降级为 ocr-unavailable）。
 * fullBuf 在 D-5 路径下可为 null（服务端 OCR 直接读屏，无需本地解码）。
 * 取字三路径（纪元 Ω）：服务端 L2 → legacy tesseract → VLM 云脑兜底
 * （第三路径仅在 vlmAssistOcr 开启且 GLM 可用时激活；前两路径皆败且第三路径
 * 不可用 ⇒ return null，与既往行为一致 —— 降级律：绝不抛）。
 */
export async function semanticConfirm(
  fullBuf: Buffer | null,
  cxPct: number,
  cyPct: number,
  radiusPct: number,
  expected: string,
  lang = 'eng',
): Promise<SemanticConfirm | null> {
  try {
    const left = Math.max(0, cxPct - radiusPct);
    const top = Math.max(0, cyPct - radiusPct);
    const width = Math.min(1 - left, radiusPct * 2);
    const height = Math.min(1 - top, radiusPct * 2);
    if (width < 0.005 || height < 0.005) return null;

    const region = { x: left, y: top, width, height };
    let text: string | null = null;
    const server = await readScreenTextServer(region);
    if (server) {
      text = server.text;
    } else if (fullBuf && fullBuf.length > 0) {
      // legacy 放大路径：区域裁剪 + resize 1200（小字命中率关键）。
      // 纪元 Ω：本路径失败不再直接落入总 catch —— 记 null 交第三路径裁决
      //（VLM 兜底不可用时与旧行为一致：return null）。
      try {
        const sharp = await getSharp();
        const meta = await sharp(fullBuf).metadata();
        const W = meta.width!, H = meta.height!;
        // 左上/宽高都夹回帧内：边缘区域的取整和 (left+width)*W 的舍入可能把
        // extract 盒推出帧外 1px —— sharp 对越界盒直接抛错，整条 legacy 路径
        // 因此白白降级（vlmFallbackText 的 floor/ceil 夹取同律）
        const pxLeft = Math.min(W - 1, Math.round(left * W));
        const pxTop = Math.min(H - 1, Math.round(top * H));
        const pxW = Math.max(1, Math.min(W - pxLeft, Math.round(width * W)));
        const pxH = Math.max(1, Math.min(H - pxTop, Math.round(height * H)));
        const crop = await sharp(fullBuf)
          .extract({ left: pxLeft, top: pxTop, width: pxW, height: pxH })
          .resize(1200)
          .toBuffer();
        text = (await readText(crop, lang)).text;
      } catch {
        text = null; // legacy 亦败 —— 落第三路径（不可用则 return null，同旧律）
      }
    }
    if (!text) {
      // 纪元 Ω 第三路径：本地双路径皆败（报错或空读皆算败 —— 空读对「预期文字
      // 在场与否」不构成证据，小字号漏读常态）+ vlmAssistOcr 开启 + 云脑可用
      // ⇒ VLM 兜底读屏；兜底不可用 ⇒ null（诚实缺席，同旧律）
      text = await vlmFallbackText(fullBuf, region, lang);
      if (!text) return null;
    }

    const hay = normalize(text);
    const needle = normalize(expected);
    // R 纪元（R-1 模糊层）：OCR 容错判决 —— 逐字节 includes 在真机 OCR 上必然
    // 漏判（l→1 / O→0 / 吞空格）；编辑距离 ≤ ⌈m/6⌉ 的近似命中取代之。
    return {
      confirmed: hay.includes(needle) || fuzzyIncludes(needle, hay),
      snippet: text.replace(/\s+/g, ' ').trim().slice(0, 120),
    };
  } catch {
    return null;
  }
}
