// src/vlm/vlmOcr.ts
// 纪元 Ω（Ω-5 · GLM-5.3-Flash 云脑皮层）：云端 VLM 文字感知（read_text / find_text 的云脑路径）。
// textReader.ts（本地 OCR：服务端 RapidOCR 优先 → legacy tesseract 降级）的云侧姊妹：
// encodeForVlm 编码（region 像素裁剪/压缩）→ buildOcrPrompt 铁律提示词（findQuery 聚焦）
// → GlmClient.chatJson 结构化对话 → 逐词校验（trim / 夹取 / 4 元数组转对象 / 几何中心 / 阅读序）。
// 铁律：具名导出、零新增依赖、绝不抛异常 —— 一切失败以 { ok:false, degraded:true } 表达，
// 调用方降级回本地 OCR 路径（云脑缺席不致命，宁可空不可错）。
import {
  getGlmClient, isGlmConfigured,
  type GlmClient, type GlmImageInput,
} from './glmClient';
import { encodeForVlm, type Bbox } from './codec';
import { buildOcrPrompt } from './som';

/** 云脑识别词 —— 本地 OcrWord 的像素方言（bbox/center 为模型所见图像的像素坐标，非归一化） */
export interface VlmWord {
  /** 屏幕原文（去首尾空白；保持原语言不翻译不改写 —— som 提示词约定） */
  text: string;
  /** 置信度 —— 模型 0..1 输出经夹取（越界夹边界、缺失/NaN 压 0，永不 NaN） */
  confidence: number;
  /** 像素边框（输入图像空间 = region 裁剪/编码后的图；som 铁律：图外坐标非法） */
  bbox: Bbox;
  /** 几何中心（bbox 对角线中点，点击定位目标） */
  center: { x: number; y: number };
}

/** 云端 VLM OCR 结果 —— ok:false 时 text 恒 ''、words 恒 []（宁可空不可错） */
export interface VlmOcrResult {
  ok: boolean;
  /** 全部词按阅读序（y 再 x）以空格连接 */
  text: string;
  words: VlmWord[];
  /** true = 云脑缺席/失败 —— 调用方应降级本地 OCR 路径 */
  degraded: boolean;
  /** 失败原因（ok:false 时必有） */
  error?: string;
  /** 整次调用墙钟延迟（毫秒） */
  latencyMs: number;
}

/** find_text 命中项 —— 带中心像素坐标供点击定位 */
export interface VlmTextMatch {
  text: string;
  center: { x: number; y: number };
  confidence: number;
}

/** find_text 结果 —— 识别成功但词不匹配不是失败（无命中 ok:true + matches:[]） */
export interface VlmFindResult {
  ok: boolean;
  matches: VlmTextMatch[];
  /** true = 云脑缺席/失败（与 VlmOcrResult.degraded 同语义） */
  degraded: boolean;
  error?: string;
}

/** 大小写/空白不敏感归一 —— 与 textReader.ts 的 normalize 同律（toLowerCase + 空白折叠） */
const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** 宽松转数 —— 数字字符串也收（模型方言防御）；非法/NaN 返回 null */
function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * bbox 解析 —— 兼容模型方言：[x0,y0,x1,y1] 4 元数组（som 提示词约定）与
 * {x0,y0,x1,y1} 对象（更宽松模型自作主张时）；端点倒序自动摆正（不丢词）。
 * 非法输入返回 null（调用方弃词 —— 坐标残缺的词不可点击，但不能毒化整批）。
 */
function parseBbox(raw: unknown): Bbox | null {
  let q: [unknown, unknown, unknown, unknown] | null = null;
  if (Array.isArray(raw) && raw.length === 4) {
    q = [raw[0], raw[1], raw[2], raw[3]];
  } else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (o.x0 !== undefined && o.y0 !== undefined && o.x1 !== undefined && o.y1 !== undefined) {
      q = [o.x0, o.y0, o.x1, o.y1];
    }
  }
  if (!q) return null;
  const n = q.map(toFiniteNumber);
  if (n.some(v => v === null)) return null;
  let [x0, y0, x1, y1] = n as [number, number, number, number];
  if (x1 < x0) [x0, x1] = [x1, x0]; // 端点倒序摆正
  if (y1 < y0) [y0, y1] = [y1, y0];
  return { x0, y0, x1, y1 };
}

/**
 * 逐词校验 —— text 去首尾空白（空词丢弃）、confidence 夹 [0,1]、bbox 4 元数组转对象、
 * center=几何中心；输出按 center.y 再 center.x 排阅读序（sort 稳定：同键保持模型原序）。
 */
function sanitizeWords(rawWords: unknown[]): VlmWord[] {
  const words: VlmWord[] = [];
  for (const item of rawWords) {
    if (!item || typeof item !== 'object') continue; // null/原始值方言 → 弃
    const w = item as { text?: unknown; confidence?: unknown; bbox?: unknown };
    if (typeof w.text !== 'string') continue;        // text 非字符串 → 弃
    const text = w.text.trim();
    if (!text) continue;                             // 纯空白词无语义
    const bbox = parseBbox(w.bbox);
    if (!bbox) continue;                             // 坐标残缺 → 弃（不毒化整批）
    const c = toFiniteNumber(w.confidence);
    words.push({
      text,
      confidence: c === null ? 0 : Math.min(Math.max(c, 0), 1),
      bbox,
      center: { x: (bbox.x0 + bbox.x1) / 2, y: (bbox.y0 + bbox.y1) / 2 },
    });
  }
  words.sort((a, b) => (a.center.y - b.center.y) || (a.center.x - b.center.x));
  return words;
}

/** 内部共用选项 —— findQuery 仅 findTextViaVlm 下发（提示词聚焦查询词） */
interface VlmOcrOptions {
  region?: Bbox;
  lang?: string;
  findQuery?: string;
  client?: GlmClient;
}

/**
 * 共用主流程：配置探测 → encodeForVlm（region 裁剪）→ buildOcrPrompt → chatJson
 * → 逐词校验。任何一步失败降级返回（{ ok:false, degraded:true }），绝不抛。
 * 未配置且未注入 client 时零网络（不建 client、不编码、不发请求）。
 */
async function runVlmOcr(buffer: Buffer, opts: VlmOcrOptions): Promise<VlmOcrResult> {
  const startedAt = Date.now();
  const degrade = (error: string): VlmOcrResult => ({
    ok: false, text: '', words: [], degraded: true, error, latencyMs: Date.now() - startedAt,
  });
  try {
    // 1) 云脑可用性：注入 client 优先（测试/宿主直连），否则全局配置探测 —— 未配置零网络降级
    let client = opts.client;
    if (!client) {
      if (!isGlmConfigured()) {
        return degrade('vlm ocr unavailable: glm api key not configured and no client injected');
      }
      client = getGlmClient();
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return degrade('vlm ocr unavailable: empty image buffer');
    }

    // 2) 编码（region 像素裁剪/压缩在此发生；词坐标 = 编码后图像的像素空间）
    const enc = await encodeForVlm(buffer, { region: opts.region });
    if (!enc.ok || !enc.value) {
      return degrade(`vlm ocr encode failed: ${enc.error ?? 'unknown codec error'}`);
    }
    const image: GlmImageInput = { base64: enc.value.base64, mime: enc.value.mime };

    // 3) 铁律提示词（findQuery 有值时聚焦查询词）→ 结构化对话（chatJson 内部强制 jsonMode）
    const prompt = buildOcrPrompt({ lang: opts.lang, findQuery: opts.findQuery });
    const resp = await client.chatJson<{ words?: unknown }>({ images: [image], prompt });
    if (!resp.ok) return degrade(`vlm ocr chat failed: ${resp.error ?? 'unknown glm error'}`);

    // 4) 解析 { words:[...] }（裸数组方言也收）→ 逐词校验 → 阅读序空格连接
    const payload: unknown = resp.value;
    const rawWords: unknown[] = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { words?: unknown } | null)?.words)
        ? (payload as { words: unknown[] }).words
        : [];
    const words = sanitizeWords(rawWords);
    return {
      ok: true, text: words.map(w => w.text).join(' '), words,
      degraded: false, latencyMs: Date.now() - startedAt,
    };
  } catch (e) {
    // 理论不可达（各步自兜底）—— 最后防线：异常转降级返回，绝不越狱上抛
    const msg = e instanceof Error ? e.message : String(e);
    return degrade(`vlm ocr crashed: ${msg.slice(0, 240)}`);
  }
}

/**
 * 云端 VLM 区域读字：buffer + 可选 region 像素裁剪 → 词级像素坐标结果。
 * 未配置且未注入 client 时零网络降级（degraded:true，调用方走本地 OCR）。
 */
export async function readTextViaVlm(
  buffer: Buffer,
  opts?: { region?: Bbox; lang?: string; client?: GlmClient },
): Promise<VlmOcrResult> {
  return runVlmOcr(buffer, {
    region: opts?.region,
    lang: opts?.lang,
    client: opts?.client,
  });
}

/**
 * 云端 VLM 找字：readTextViaVlm（提示词聚焦 query）之上做大小写不敏感 +
 * 去空白差异的子串匹配，命中词返回中心像素坐标。无命中 ok:true + matches:[]；
 * 空白查询不匹配一切（防误命中）；云脑失败才 degraded。
 */
export async function findTextViaVlm(
  buffer: Buffer,
  query: string,
  opts?: { lang?: string; client?: GlmClient },
): Promise<VlmFindResult> {
  const needle = normalize(typeof query === 'string' ? query : '');
  if (!needle) return { ok: true, matches: [], degraded: false };
  const ocr = await runVlmOcr(buffer, { lang: opts?.lang, client: opts?.client, findQuery: query });
  if (!ocr.ok) return { ok: false, matches: [], degraded: true, error: ocr.error };
  const matches: VlmTextMatch[] = ocr.words
    .filter(w => normalize(w.text).includes(needle))
    .map(w => ({ text: w.text, center: w.center, confidence: w.confidence }));
  return { ok: true, matches, degraded: false };
}
