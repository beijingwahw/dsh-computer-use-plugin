// src/vlm/grounding.ts
// 纪元 Ω（Ω-4 视觉接地）：GLM-5.3-Flash 云脑皮层的元素接地器官 —— 截图进、
// 可点击元素（像素坐标 + 语义标签）出，本地启发元素源之外的云脑直读路径。
// 本模块是云输出的**规整与执法层**：VLM 回话是方言（bbox 可能是 4 元数组、
// id 五花八门、confidence 可能越界、label 可能缺席），全部归一为仓库标准：
//   1. bbox 数组/对象双形态 → {x0,y0,x1,y1} 像素对象，clampBbox 夹回图内
//   2. id 归一为 'e1'.. 序号（下游「点 3 号」指令的稳定语义）
//   3. confidence 夹 [0,1]；label/role 兜底字符串
//   4. nmsElements 去冗余（仓库 NMS 约定：面积降序贪心 + IoU≥0.6）
// 失败语义与 textReader 同宗：**宁可空不可错** —— 任何一步失败返回
// ok:false + elements:[]，绝不抛异常；GLM 未配置时零网络立即降级。
import { getGlmClient, isGlmConfigured, type GlmClient } from './glmClient';
import { encodeForVlm, type Bbox } from './codec';
import { buildGroundingSystemPrompt, buildGroundingUserPrompt } from './som';
import { kernelRegistry } from '../kernel/registry';

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
}

/** NMS 去冗余阈值（仓库约定：IoU≥0.6 视为同一元素的重复检出） */
const NMS_IOU = 0.6;
/** VLM 未给 confidence 时的中性记账值 */
const DEFAULT_CONFIDENCE = 0.5;
/** label 兜底与截断上限（对齐仓库 name 截断的防注入纪律） */
const LABEL_FALLBACK = '未知元素';
const LABEL_MAX = 80;
const ROLE_FALLBACK = 'unknown';
const ROLE_MAX = 24;

// ─── 纯函数几何工具（供本模块与下游复用；零副作用、零异常） ───

/** 数字卫兵：非有限数字一律按 0 记（坐标字段缺席时不炸管线） */
const finiteOr0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * 纯函数：把 bbox 夹回 [0,width]×[0,height] 图内，并保证 x1>x0、y1>y0。
 * 倒置坐标（VLM 偶发 x0>x1）先交换；压扁/贴边的零面积盒扩为 1px；
 * 最终 floor(x0)/ceil(x1) 整数化 —— 整数盒**包含**原浮点盒且不出图。
 */
export function clampBbox(bbox: Bbox, width: number, height: number): Bbox {
  const w = Number.isFinite(width) && width >= 1 ? Math.floor(width) : 1;
  const h = Number.isFinite(height) && height >= 1 ? Math.floor(height) : 1;
  const src = (bbox && typeof bbox === 'object' ? bbox : {}) as Partial<Bbox>;
  let x0 = Math.min(Math.max(finiteOr0(src.x0), 0), w);
  let y0 = Math.min(Math.max(finiteOr0(src.y0), 0), h);
  let x1 = Math.min(Math.max(finiteOr0(src.x1), 0), w);
  let y1 = Math.min(Math.max(finiteOr0(src.y1), 0), h);
  if (x1 < x0) { const t = x0; x0 = x1; x1 = t; } // 倒置交换
  if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
  let rx0 = Math.floor(x0), ry0 = Math.floor(y0);
  let rx1 = Math.ceil(x1), ry1 = Math.ceil(y1);
  if (rx1 <= rx0) { rx0 = Math.min(rx0, w - 1); rx1 = rx0 + 1; } // 零面积 → 1px
  if (ry1 <= ry0) { ry0 = Math.min(ry0, h - 1); ry1 = ry0 + 1; }
  return { x0: rx0, y0: ry0, x1: rx1, y1: ry1 };
}

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
 * 纯函数：NMS 去冗余（仓库 NMS 约定：**面积降序贪心** + IoU≥iouThreshold
 * 去重，平手取先出现者 —— 与 elementTracker 同形态的确定性）。
 * 泛型约束仅需 bbox —— 接地管线中 center 尚未计算的中间形态（Omit<..., 'center'>）
 * 亦可直入；面积非正的退化元素直接滤除（无面积的盒没有几何身份，不参选）。
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
    if (kept.every(k => iouBbox(k.el.bbox, cand.el.bbox) < threshold)) kept.push(cand);
  }
  return kept.map(r => r.el);
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
 * 不拨号不编码）→ encodeForVlm 编码 → som 接地提示词组装 → client.chatJson
 * → 逐元素校验（id 归一 'e1'..、bbox 双形态转对象、clampBbox、confidence
 * 夹 [0,1]、label/role 兜底；非法元素被过滤）→ nmsElements 去冗余 →
 * 计算中心点。任何一步失败返回 ok:false + error，elements 恒为 []。
 */
export async function groundElements(buffer: Buffer, opts?: {
  width?: number; height?: number;   // 屏幕/图像像素尺寸（缺省从编码结果取）
  question?: string;                 // 聚焦问题（如"找到设置入口"）
  client?: GlmClient;                // 测试注入；缺省 getGlmClient()
}): Promise<GroundingResult> {
  const t0 = Date.now();
  const fail = (error: string, strategy: string, degraded = false): GroundingResult =>
    ({ ok: false, elements: [], degraded, error, latencyMs: Date.now() - t0, strategy });
  try {
    // 0) 配置哨兵：未配置且未注入测试 client ⇒ 零网络降级（不拨号、不编码）
    let client: GlmClient;
    if (opts?.client) {
      client = opts.client;
    } else {
      if (!isGlmConfigured()) return fail('GLM 未配置（缺 API Key）—— 零网络降级', 'unconfigured', true);
      client = getGlmClient();
    }
    if (client.configured === false) {
      return fail('GLM client 未配置 —— 零网络降级', 'unconfigured', true);
    }

    // 1) 编码（sharp 压缩/缩放 —— 云脑往返的带宽礼仪）
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return fail('空截图 buffer', 'vlm-grounding');
    }
    const enc = await encodeForVlm(buffer);
    if (!enc.ok || !enc.value) return fail(enc.error ?? '截图编码失败', 'vlm-grounding');
    const encoded = enc.value;
    const strategy = `vlm:${encoded.strategy}`;

    // 2) 尺寸裁决：显式像素尺寸优先，缺省取编码结果
    const width = pickDim(opts?.width, encoded.width);
    const height = pickDim(opts?.height, encoded.height);
    if (width < 1 || height < 1) return fail('图像尺寸不可得', strategy);

    // 3) som 接地提示词组装（坐标语义 = width×height 像素系）
    const req = {
      images: [{ base64: encoded.base64, mime: encoded.mime }],
      system: buildGroundingSystemPrompt(),
      prompt: buildGroundingUserPrompt({ width, height, question: opts?.question }),
      jsonMode: true,
      temperature: 0.1,   // 接地要坐标精度，不要发散
      maxTokens: 2048,
    };

    // 4) 云脑往返
    const res = await client.chatJson<{ elements?: unknown }>(req);
    if (!res.ok) return fail(res.error ?? 'GLM 接地调用失败', strategy);
    // 双方言收窄：som 提示词勒令裸 JSON 数组、ensemble 供词强写 {elements:[...]}——
    // 云输出按这两种形态都收（漏一种 = 该方言下的接地恒失败）
    const rawEls = Array.isArray(res.value)
      ? res.value
      : (res.value as RawElement | undefined)?.elements;
    if (!Array.isArray(rawEls)) return fail('GLM 输出缺 elements 数组', strategy);

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

    // 6) NMS 去冗余（同一控件的多重检出合并）→ 计算中心点
    const elements: GroundedElement[] = nmsElements(validated).map(el => ({
      ...el,
      center: { x: (el.bbox.x0 + el.bbox.x1) / 2, y: (el.bbox.y0 + el.bbox.y1) / 2 },
    }));
    return { ok: true, elements, degraded: false, latencyMs: Date.now() - t0, strategy };
  } catch (err) {
    // 绝不抛异常：未知异常（含注入物炸裂）也收敛为失败结果
    return fail(err instanceof Error ? err.message : '接地管线未知异常', 'vlm-grounding');
  }
}
