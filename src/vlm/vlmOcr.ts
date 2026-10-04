// src/vlm/vlmOcr.ts
// 纪元 Ω（Ω-5 · GLM-5.3-Flash 云脑皮层）：云端 VLM 文字感知（read_text / find_text 的云脑路径）。
// textReader.ts（本地 OCR：服务端 RapidOCR 优先 → legacy tesseract 降级）的云侧姊妹：
// encodeForVlmMeta 编码（region 像素裁剪/压缩，源图宽高随行）→ buildOcrPrompt 铁律提示词
// （findQuery 聚焦）→ GlmClient.chatJson 结构化对话 → 逐词校验（trim / 夹取 / 4 元数组转
// 对象 / 几何中心 / 阅读序）→ 纪元 Γ 坐标反算（词坐标：编码图系 → 源图系，裁剪窗先缩放
// 后平移）→ coordinateSpace 诚实标注 → ΝΩ-17 行聚类阅读序（中位字高 y 容差聚行、
// 行内 x 排序 —— 多栏/表格跨列穿插修复）。
// 铁律：具名导出、零新增依赖、绝不抛异常 —— 一切失败以 { ok:false, degraded:true } 表达，
// 调用方降级回本地 OCR 路径（云脑缺席不致命，宁可空不可错）。
// W8-A6（VLM 架构债 · 依赖倒置最小形态）：云端依赖面自 GlmClient 具体类降为
// StructuredVisionPort 窄端口（configured + chatJson）—— 多供应商（备选池/
// 合议庭脑）可直入；GlmClient 结构天然满足（传入处零改动），运行时行为不变。
// ΝΩ-48（注视经济进 OCR）：foveaCenter 可选参数（源图归一化 [0,1]²，在场即
// 显式开中央凹编码并透传 codec —— 缺席逐字节旧路径）；坐标反算链自动消化
// blur（几何不变）/ inset（分段反算）两模式，词坐标恒回源图系。
import {
  getGlmClient, isGlmConfigured,
  type GlmImageInput,
} from './glmClient';
import type { StructuredVisionPort } from './providers/types';
import { encodeForVlmMeta, mapEncodedToOriginal, mapInsetToOriginal, type Bbox } from './codec';
import { clampBbox } from './grounding';
import { buildOcrPrompt } from './som';

/** 云脑识别词 —— 本地 OcrWord 的像素方言（bbox/center 像素坐标；空间见 VlmOcrResult.coordinateSpace） */
export interface VlmWord {
  /** 屏幕原文（去首尾空白；保持原语言不翻译不改写 —— som 提示词约定） */
  text: string;
  /** 置信度 —— 模型 0..1 输出经夹取（越界夹边界、缺失/NaN 压 0，永不 NaN） */
  confidence: number;
  /** 像素边框（纪元 Γ 起恒为源图坐标系 —— region 裁剪与编码缩放已反算；反算基准缺席时为编码图系） */
  bbox: Bbox;
  /** 几何中心（bbox 对角线中点，点击定位目标） */
  center: { x: number; y: number };
}

/** 云端 VLM OCR 结果 —— ok:false 时 text 恒 ''、words 恒 []（宁可空不可错） */
export interface VlmOcrResult {
  ok: boolean;
  /** 全部词按行聚类阅读序（ΝΩ-17：y 容差聚行、行内 x 升序、行间按 y）以空格连接 */
  text: string;
  words: VlmWord[];
  /** true = 云脑缺席/失败 —— 调用方应降级本地 OCR 路径 */
  degraded: boolean;
  /** 失败原因（ok:false 时必有） */
  error?: string;
  /** 整次调用墙钟延迟（毫秒） */
  latencyMs: number;
  /**
   * 纪元 Γ（Γ-1）：词坐标空间标注 —— 'original'（源图系：region 偏移与编码
   * 缩放均已反算）| 'encoded'（编码图系：反算基准缺席时的诚实降级）。
   * 成功路径必有；失败路径省略（words 恒空）。
   */
  coordinateSpace?: 'original' | 'encoded';
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
  /** 纪元 Γ：命中中心坐标空间（同 VlmOcrResult.coordinateSpace） */
  coordinateSpace?: 'original' | 'encoded';
}

/** 大小写/空白不敏感归一 —— 与 textReader.ts 的 normalize 同律（toLowerCase + 空白折叠） */
const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * ΝΩ-17：行聚类 y 容差系数（× 中位字高）。0.6 论证：行内中心漂移（上下标/
 * 降部/轻微倾斜/词级 bbox 高低不齐）通常 < 0.5 字高；相邻行中心距 ≥ 1.0 字高
 * （正文行距 1.2-1.5em，紧凑表格行也 > 1.0）。容差取整字高会把 1.0-1.1 倍
 * 行距的表格行并作一行（跨行穿插反而更糟）；0.6 居中 —— 容纳行内漂移且不
 * 吞相邻行。中位数而非均值：标题大字/脚注小字的离群高度不劫持容差。
 */
const OCR_LINE_TOL_FACTOR = 0.6;

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

/**
 * ΝΩ-17 纯函数：行聚类阅读序 —— 逐词 (y,x) 排序在多栏/表格上会跨列穿插：
 * 行内词的 y 只要有几个像素抖动（词级 bbox 高低不齐是常态），右栏低抖词就会
 * 排到左栏高抖词之前/之后，行内 x 序被打乱。修法：按 y 容差（中位字高×
 * OCR_LINE_TOL_FACTOR）贪心聚类成行（行锚 = 行内中心 y 的滚动均值，容纳轻微
 * 倾斜），行内按 x 升序、行间按锚 y 升序 —— 多栏/表格的行结构恢复（每行
 * 左→右跨全栏，行序自上而下）。零异常；≤1 词或中位字高病值（≤0）时原序保底。
 */
function readingOrderWords(words: VlmWord[]): VlmWord[] {
  if (words.length <= 1) return [...words];
  const heights = words
    .map(w => Math.max(0, w.bbox.y1 - w.bbox.y0))
    .sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] ?? 0;
  if (!(medianH > 0)) return [...words];
  const tol = medianH * OCR_LINE_TOL_FACTOR;
  // 依 y 升序扫入（sanitizeWords 已给 (y,x) 稳定序，此处再排一次防御上游重排）
  const byY = [...words].sort((a, b) => (a.center.y - b.center.y) || (a.center.x - b.center.x));
  const lines: Array<{ sumY: number; items: VlmWord[] }> = [];
  for (const w of byY) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(w.center.y - last.sumY / last.items.length) <= tol) {
      last.sumY += w.center.y;
      last.items.push(w);
    } else {
      lines.push({ sumY: w.center.y, items: [w] });
    }
  }
  // 行间按锚 y（构造序天然升序，滚动锚微扰时防御性再排）；行内按 x（同键稳定）
  lines.sort((a, b) => a.sumY / a.items.length - b.sumY / b.items.length);
  const out: VlmWord[] = [];
  for (const ln of lines) {
    ln.items.sort((a, b) => (a.center.x - b.center.x) || (a.center.y - b.center.y));
    out.push(...ln.items);
  }
  return out;
}

/** 内部共用选项 —— findQuery 仅 findTextViaVlm 下发（提示词聚焦查询词）。
 *  W8-A6：client 为 StructuredVisionPort 窄端口（原 GlmClient 具体类）。
 *  ΝΩ-48（注视经济进 OCR）：foveaCenter —— 源图归一化系 [0,1]² 注视中心
 *  （与 encodeForVlm.foveaCenter / gazeRouter 输出同方言），在场即显式开
 *  中央凹编码（与 grounding 同律；缺席逐字节旧路径）。 */
interface VlmOcrOptions {
  region?: Bbox;
  lang?: string;
  findQuery?: string;
  client?: StructuredVisionPort;
  foveaCenter?: { x: number; y: number };
}

/**
 * 共用主流程：配置探测 → encodeForVlmMeta（region 裁剪/压缩 + 源图宽高随行）
 * → buildOcrPrompt → chatJson → 逐词校验 → 纪元 Γ 坐标反算（编码系 → 源图系）。
 * 任何一步失败降级返回（{ ok:false, degraded:true }），绝不抛。
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

    // 2) 编码（region 像素裁剪/压缩在此发生；纪元 Γ 元信息通道 —— 模型在
    //    编码图上作答，sourceWidth/Height + cropRect 是反算回源图系的基准）。
    //    ΝΩ-48（注视经济）：foveaCenter 在场即显式开中央凹并透传注视中心
    //    （blur/inset 由注册表 foveaMode 管辖；缺席不传 foveated/foveaCenter —
    //    缺省路径逐字节不变）。坐标反算链自动消化两模式：blur 几何不变；inset
    //    走 mapInsetToOriginal 分段反算（下方既有分支，insetExtract 随行注视
    //    偏置精确反算）—— 词坐标恒回源图系，注视不劫持坐标系。
    const enc = await encodeForVlmMeta(buffer, {
      region: opts.region,
      ...(opts.foveaCenter !== undefined
        ? { foveated: true, foveaCenter: opts.foveaCenter }
        : {}),
    });
    if (!enc.ok || !enc.value) {
      return degrade(`vlm ocr encode failed: ${enc.error ?? 'unknown codec error'}`);
    }
    const encoded = enc.value;
    const image: GlmImageInput = { base64: encoded.base64, mime: encoded.mime };

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
    let words = sanitizeWords(rawWords);

    // 5) 纪元 Γ（Γ-1）坐标反算：词 bbox 编码图系 → 源图系。两段复合：
    //    编码图 →（等比缩放）→ 裁剪窗/原图 →（+cropRect.left/top 平移）→ 源图，
    //    clampBbox 以源图为画布收口整化（floor/ceil/1px/夹回 —— 与 grounding
    //    同一几何方言）。反算基准缺席（理论不可达：codec 恒供源图宽高）⇒
    //    诚实保持编码图系并在 coordinateSpace 标 'encoded'。
    const srcW = encoded.sourceWidth;
    const srcH = encoded.sourceHeight;
    const crop = encoded.cropRect ?? null;
    const canMap = Number.isFinite(srcW) && srcW >= 1 && Number.isFinite(srcH) && srcH >= 1
      && encoded.width >= 1 && encoded.height >= 1;
    if (canMap) {
      // 纪元 Γ2：inset 编码走分段反算（凹窗内原生 1:1、窗外缩图实际比值；cropRect
      // 平移与 clamp 已在 mapInsetToOriginal 内复合 —— 与下方等比路径同一输出契约）。
      // 其余（均质/blur）走 Γ 等比两段复合，既有路径零变化。
      if (encoded.foveaMode === 'inset') {
        words = words.map(w => {
          const p0 = mapInsetToOriginal(w.bbox.x0, w.bbox.y0, encoded);
          const p1 = mapInsetToOriginal(w.bbox.x1, w.bbox.y1, encoded);
          const bbox = clampBbox({ x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y }, srcW, srcH);
          return { ...w, bbox, center: { x: (bbox.x0 + bbox.x1) / 2, y: (bbox.y0 + bbox.y1) / 2 } };
        });
      } else {
        const midW = crop ? crop.width : encoded.width;
        const midH = crop ? crop.height : encoded.height;
        const offX = crop ? crop.left : 0;
        const offY = crop ? crop.top : 0;
        words = words.map(w => {
          const p0 = mapEncodedToOriginal(w.bbox.x0, w.bbox.y0, encoded.width, encoded.height, midW, midH);
          const p1 = mapEncodedToOriginal(w.bbox.x1, w.bbox.y1, encoded.width, encoded.height, midW, midH);
          const bbox = clampBbox(
            { x0: p0.x + offX, y0: p0.y + offY, x1: p1.x + offX, y1: p1.y + offY },
            srcW, srcH,
          );
          return { ...w, bbox, center: { x: (bbox.x0 + bbox.x1) / 2, y: (bbox.y0 + bbox.y1) / 2 } };
        });
      }
    }
    // ΝΩ-17：行聚类阅读序 —— 在**源图系**最终坐标上聚类（inset 分段缩放/裁剪
    // 平移后的几何才是屏幕真实行结构；canMap 缺席时编码系同理），多栏/表格的
    // 跨列穿插在此恢复
    words = readingOrderWords(words);
    return {
      ok: true, text: words.map(w => w.text).join(' '), words,
      degraded: false, latencyMs: Date.now() - startedAt,
      coordinateSpace: canMap ? 'original' : 'encoded',
    };
  } catch (e) {
    // 理论不可达（各步自兜底）—— 最后防线：异常转降级返回，绝不越狱上抛
    const msg = e instanceof Error ? e.message : String(e);
    return degrade(`vlm ocr crashed: ${msg.slice(0, 240)}`);
  }
}

/**
 * 云端 VLM 区域读字：buffer + 可选 region 像素裁剪 → 词级像素坐标结果
 * （纪元 Γ 起 bbox/center 恒为**源图坐标系** —— region 偏移与编码缩放已在
 * 管线内反算；coordinateSpace 诚实标注）。未配置且未注入 client 时零网络
 * 降级（degraded:true，调用方走本地 OCR）。
 */
export async function readTextViaVlm(
  buffer: Buffer,
  opts?: {
    region?: Bbox;
    lang?: string;
    client?: StructuredVisionPort;
    /** ΝΩ-48（注视经济）：注视中心（源图归一化 [0,1]²）—— 在场即中央凹编码 */
    foveaCenter?: { x: number; y: number };
  },
): Promise<VlmOcrResult> {
  return runVlmOcr(buffer, {
    region: opts?.region,
    lang: opts?.lang,
    client: opts?.client,
    foveaCenter: opts?.foveaCenter,
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
  opts?: {
    lang?: string;
    client?: StructuredVisionPort;
    /** ΝΩ-48（注视经济）：注视中心（源图归一化 [0,1]²）—— 在场即中央凹编码 */
    foveaCenter?: { x: number; y: number };
  },
): Promise<VlmFindResult> {
  const needle = normalize(typeof query === 'string' ? query : '');
  if (!needle) return { ok: true, matches: [], degraded: false };
  const ocr = await runVlmOcr(buffer, {
    lang: opts?.lang,
    client: opts?.client,
    findQuery: query,
    foveaCenter: opts?.foveaCenter,
  });
  if (!ocr.ok) return { ok: false, matches: [], degraded: true, error: ocr.error };
  const matches: VlmTextMatch[] = ocr.words
    .filter(w => normalize(w.text).includes(needle))
    .map(w => ({ text: w.text, center: w.center, confidence: w.confidence }));
  // 命中中心与 ocr.words 同空间 —— 纪元 Γ 标注随行透传（'original' 时调用方
  // 可直接以源图宽高换算归一化点击坐标）
  return { ok: true, matches, degraded: false, coordinateSpace: ocr.coordinateSpace };
}
