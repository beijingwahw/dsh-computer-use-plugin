// src/vlm/som.ts
// 纪元 Ω（Ω-3 · GLM-5.3-Flash 云脑皮层）：SoM 云端视觉锚定层。
// 本仓 SoM 传统（网格/准星/编号框，见 visualOverlay.ts）在云脑上的投影：
// renderSomOverlay 给截图钉编号锚点，四个提示词构造器把「像素绝对坐标、
// 图外非法、不臆造」三条铁律写进 GLM-5.3-Flash 的输入，歼灭坐标幻觉。
// 与本地路径的分野：VLM 不需要网格尺（gridDensity 默认 0），编号框只做锚点。
// 铁律：具名导出、零新增依赖（sharp 经 _legacyDeps 懒加载）、绝不抛异常。
import type { Bbox } from './codec';
import { getSharp } from '../_legacyDeps';

/** 云脑锚点：编号 + 像素边框 + 中心点（点击定位由兄弟模块消费） */
export interface SomMarker {
  /** 元素编号（渲染为左上角标签，回传 JSON 用同一 id 对齐） */
  id: number;
  /** 像素绝对坐标边框（x1>x0、y1>y0） */
  bbox: Bbox;
  /** 锚点中心（markerCentroid 的产物；渲染只读 bbox，center 供下游点击） */
  center: { x: number; y: number };
}

/** 渲染选项 */
export interface SomOverlayOptions {
  /** 需要描框编号的锚点；空数组/缺省 = 原样返回（strategy 'plain'） */
  markers?: SomMarker[];
  /** 每轴网格分割数；默认 0 不加网格（VLM 不需要，与本地路径不同） */
  gridDensity?: number;
  /** 编号框描边宽度（像素）；默认 3 */
  strokeWidth?: number;
  /** 描边与标签底色；默认 '#00FF66'（仓库传统绿） */
  color?: string;
}

/** 渲染结果：ok=false 时 error 给出中文原因，绝不抛异常 */
export interface SomOverlayResult {
  ok: boolean;
  buffer?: Buffer;
  width?: number;
  height?: number;
  error?: string;
}

/** XML 文本转义：外部数据含 < & " 等字符会破坏 SVG 结构（同 visualOverlay） */
function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, ch =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch] ?? ch);
}

/**
 * PNG 头嗅探尺寸（不依赖 sharp）：签名 8 字节后第一个块必为 IHDR，
 * 宽在 offset 16、高在 offset 20（大端）。非 PNG / 残缺头返回 null。
 * 用途：plain 路径（无 marker 原样返回）也要给下游提示词提供宽高。
 */
function sniffPngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * SoM 叠加渲染：在每个 marker 的 bbox 上画描边矩形 + 左上角编号标签
 * （可选网格，默认不画），sharp composite 一次合成。
 * - markers 为空/缺省：原样返回（strategy 'plain'），尺寸由 PNG 头嗅探（非 PNG 则省略）
 * - sharp 不可用 / 任何失败：返回 ok:false + error，绝不抛异常
 * - 非法 marker（NaN / 非正尺寸 / 越界到不可见）：跳过该锚点，不毒化整图
 */
export async function renderSomOverlay(
  buffer: Buffer,
  opts?: SomOverlayOptions,
): Promise<SomOverlayResult> {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return { ok: false, error: 'renderSomOverlay: 输入必须是非空 Buffer' };
    }
    const markers = Array.isArray(opts?.markers) ? opts.markers : [];
    if (markers.length === 0) {
      // plain：无锚点即无叠加 —— 原样透传，尺寸尽力嗅探
      const size = sniffPngSize(buffer);
      return size
        ? { ok: true, buffer, width: size.width, height: size.height }
        : { ok: true, buffer };
    }

    const sharp = await getSharp();
    const meta = await sharp(buffer).metadata();
    const W = meta.width;
    const H = meta.height;
    if (!W || !H) {
      return { ok: false, error: 'renderSomOverlay: 无法读取图像尺寸（非图像输入？）' };
    }

    const color = escapeXml(typeof opts?.color === 'string' && opts.color ? opts.color : '#00FF66');
    const swRaw = opts?.strokeWidth;
    const strokeWidth = Number.isFinite(swRaw) && (swRaw as number) > 0 ? (swRaw as number) : 3;

    let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;

    // 可选网格：沿用本地路径的半透明蓝（密度>1 才画；VLM 默认不需要）
    const densityRaw = opts?.gridDensity ?? 0;
    const divisions = Number.isFinite(densityRaw) ? Math.min(64, Math.floor(densityRaw)) : 0;
    if (divisions > 1) {
      for (let i = 1; i < divisions; i++) {
        const gx = Math.round((W / divisions) * i);
        const gy = Math.round((H / divisions) * i);
        svg += `<line x1="${gx}" y1="0" x2="${gx}" y2="${H}" stroke="rgba(0,120,255,0.30)" stroke-width="1" />`;
        svg += `<line x1="0" y1="${gy}" x2="${W}" y2="${gy}" stroke="rgba(0,120,255,0.30)" stroke-width="1" />`;
      }
    }

    for (const m of markers) {
      if (!m || !m.bbox) continue;
      const { x0, y0, x1, y1 } = m.bbox;
      // 防御：NaN / 非正尺寸直接跳过（同 visualOverlay 的 J 纪元防御律）
      if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
      if (!(x1 > x0) || !(y1 > y0)) continue;
      // 与画幅零交集的锚点整只跳过（docstring「越界到不可见：跳过」的执法）——
      // 先夹取会把幻觉坐标钉成边缘 1×1 框 + 编号标签，制造"自信地错位"的假锚点
      if (x1 <= 0 || y1 <= 0 || x0 >= W || y0 >= H) continue;
      const bx0 = Math.max(0, Math.min(W - 1, Math.round(x0)));
      const by0 = Math.max(0, Math.min(H - 1, Math.round(y0)));
      const bx1 = Math.max(0, Math.min(W, Math.round(x1)));
      const by1 = Math.max(0, Math.min(H, Math.round(y1)));
      if (bx1 - bx0 < 1 || by1 - by0 < 1) continue;

      svg += `<rect x="${bx0}" y="${by0}" width="${bx1 - bx0}" height="${by1 - by0}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" />`;

      // 编号标签：框顶上方，顶部越界时回落到框内上沿（宽度按文本长度自适应）
      const text = escapeXml(String(m.id));
      const labelW = text.length * 10 + 10;
      const labelY = by0 >= 20 ? by0 - 20 : by0;
      svg += `<rect x="${bx0}" y="${labelY}" width="${labelW}" height="20" fill="${color}" />`;
      svg += `<text x="${bx0 + 5}" y="${labelY + 15}" fill="white" font-size="14" font-family="Arial">${text}</text>`;
    }

    svg += `</svg>`;

    const out = await sharp(buffer)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .png()
      .toBuffer();
    return { ok: true, buffer: out, width: W, height: H };
  } catch (e) {
    // sharp 未安装 / 原生绑定损坏 / 解码失败 —— 优雅降级，绝不抛出
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `renderSomOverlay: 叠加渲染失败 — ${msg.slice(0, 240)}` };
  }
}

/** 纯函数：bbox 中心点（点击定位的目标像素；不做夹取，输入合法性归调用方） */
export function markerCentroid(bbox: Bbox): { x: number; y: number } {
  return { x: (bbox.x0 + bbox.x1) / 2, y: (bbox.y0 + bbox.y1) / 2 };
}

/**
 * 纯函数：grounding 系统提示词。要求 GLM-5.3-Flash 只输出严格 JSON 数组，
 * 每元素 {id,label,role,bbox:[x0,y0,x1,y1],confidence:0..1}；bbox 为输入图上的
 * 像素绝对坐标且必须完整落在图内；role 枚举固定；不臆造看不见的元素。
 */
export function buildGroundingSystemPrompt(): string {
  return '你是屏幕元素定位器。只输出严格 JSON 数组，禁止代码块围栏或任何多余文字。'
    + '每个元素：{"id":编号,"label":"元素可见文字或名称","role":"button/link/input/select/text/icon/menu/other 之一",'
    + '"bbox":[x0,y0,x1,y1],"confidence":0到1的小数}。'
    + 'bbox 为输入图像上的像素绝对坐标，必须基于图像实际像素判断，且完整落在图内'
    + '（0≤x0<x1≤图宽，0≤y0<y1≤图高），图外坐标非法。'
    + '只标注图中真实可见的元素，不要臆造看不见的元素。';
}

/**
 * 纯函数：grounding 用户提示词。描述图像尺寸与任务（列出所有可交互元素与
 * 关键文字块）；question 提供时聚焦到与问题相关的元素。
 */
export function buildGroundingUserPrompt(opts: { width: number; height: number; question?: string }): string {
  const base = `图像尺寸：${opts.width}×${opts.height} 像素，坐标原点在左上角，图外坐标非法。`
    + '任务：列出图中所有可交互元素与关键文字块，严格按系统提示词的 JSON 数组格式输出；若无任何元素输出 []。';
  const focus = opts.question ? `聚焦问题：${opts.question}——只输出与该问题相关的元素。` : '';
  return base + focus;
}

/**
 * 纯函数：前后图核对提示词。对比动作前后两图，只输出严格 JSON：
 * {verdict:'confirmed'|'refuted'|'uncertain', scale:'page'|'element'|'none',
 *  explanation（一句中文）, confidence:0..1}；判断必须基于两图实际像素差异。
 */
export function buildVerdictPrompt(expectation: string): string {
  return `对比前图与后图，判断预期是否达成：${expectation}。`
    + '只输出严格 JSON：{"verdict":"confirmed/refuted/uncertain 之一","scale":"page/element/none 之一",'
    + '"explanation":"一句中文说明","confidence":0到1的小数}。'
    + 'verdict 表示预期是否出现；scale 表示变化范围（page 页面级、element 元素级、none 无变化）。'
    + '判断必须基于两图实际像素差异，不要臆造图上看不到的现象。';
}

/**
 * 纯函数：OCR 提示词。只输出严格 JSON {words:[{text,bbox:[x0,y0,x1,y1],confidence:0..1}]}；
 * text 保持屏幕原文语言不翻译不改写；bbox 为输入图像上的像素绝对坐标且完整落在图内。
 * lang 指定优先识别语言；findQuery 指定优先查找的文字。
 */
export function buildOcrPrompt(opts: { lang?: string; findQuery?: string }): string {
  const base = '识别图中所有可见文字。只输出严格 JSON：{"words":[{"text":"原文",'
    + '"bbox":[x0,y0,x1,y1],"confidence":0到1的小数}]}。'
    + 'text 保持屏幕原文语言，不翻译、不改写、不合并相邻词；'
    + 'bbox 为输入图像上的像素绝对坐标，必须基于图像实际像素判断且完整落在图内，图外坐标非法。';
  const lang = opts.lang ? `优先按 ${opts.lang} 语言识别。` : '';
  const find = opts.findQuery ? `优先列出与「${opts.findQuery}」相关的文字。` : '';
  return base + lang + find;
}
