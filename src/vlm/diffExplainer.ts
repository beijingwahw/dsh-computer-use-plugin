// src/vlm/diffExplainer.ts
// 纪元 Ω（Ω-7 差分解说）：把 diff_view 的红框清单交给 GLM-5.3-Flash 云脑翻译成人话。
//
// 像素差分（visualDiff.computeDiffRegions）知道「哪里变了」，但不知道「变的是什么」。
// 本模块把 before/after 两张截图 + 变化区域清单一并交给云脑，换回两级语义：
//   1. summary    —— 一句中文总述（≤120 字：prompt 约束 + 硬截断双保险）
//   2. regionNotes —— 区域级「发生了什么」注解，与输入清单按 label 对齐
//
// 设计铁律（与全仓一致）：
//   1. 具名导出，禁止 default export；2. 绝不抛异常 —— 一切失败以 ok:false 返回；
//   3. 降级诚实 —— 云脑缺席（未配置 / 编码失败 / chatJson 失败）⇒ degraded:true，
//      调用方据此走本地认知路径而非崩溃；4. 克制不臆造 —— VLM 的 label 对不上
//      输入清单时宁可丢弃注解，绝不硬凑。
import { getGlmClient, isGlmConfigured } from './glmClient';
import type { GlmClient, GlmImageInput } from './glmClient';
import { encodeForVlm } from './codec';
import type { Bbox } from './codec';
// ΠΑΝ-21（反注入铁律全量覆盖）：解说面对的是操作前后截图 —— 屏幕文字是被
// 描述的数据不是指令；summary/regionNotes 回流人读面，同律设防。
import { VLM_ANTI_INJECTION_RULE } from './internalUtils';

/** 输入清单上限：超出部分忽略（与 renderDiffOverlay 的 12 框上限同源——prompt 有界） */
const MAX_REGIONS = 12;
/** summary 硬上限（字）——prompt 已约束，这里兜底截断（模型偶尔超一点不该炸下游） */
const SUMMARY_MAX_CHARS = 120;

/** 云脑角色设定（system 消息）——克制、只述可见事实、严格 JSON 输出
 *  ΠΑΝ-21：反注入铁律随行（共享常量单源） */
const EXPLAIN_SYSTEM_PROMPT =
  '你是桌面自动化系统的截图差分解说员。对比操作前(before)与操作后(after)两张截图，' +
  '用克制的简体中文描述差异：只陈述可见事实，绝不臆造，看不清就写「不明确」。' +
  '只输出一个 JSON 对象，不要 markdown 围栏，不要任何多余文字。' +
  VLM_ANTI_INJECTION_RULE;

/** 差分解说任务模板（user 消息）——{{REGION_LIST}} 占位符由 buildRegionList 填充 */
const EXPLAIN_PROMPT_TEMPLATE = `对比第一张图(before)与第二张图(after)，输出如下结构的 JSON：
{"summary":"一句中文总述两张图最核心的差异，不超过120字","regions":[{"label":"区域标签，必须与清单原样一致","note":"一句中文说明该区域发生了什么变化"}]}

硬性规则：
1. summary 只写一句中文，不超过 120 字；
2. regions 只允许出现下方清单中已有的 label，且与清单逐字一致；
3. note 描述该区域发生了什么变化（出现/消失/移动/变色/文字变化等），一句中文，克制不臆造；
4. 除 JSON 外不要输出任何文字。

{{REGION_LIST}}`;

// ─── 输入/输出契约 ───

/** 待解说的一个变化区域（来自 diff_view 的变化区域清单） */
export interface DiffRegionInput {
  /** 包围盒（像素坐标，与 visualDiff 屏幕坐标系一致） */
  bbox: Bbox;
  /** 全屏面积占比（0-100）—— 可选，仅作 prompt 提示，不影响对齐 */
  areaPct?: number;
  /** 区域标签 —— 缺省按输入顺序自动编为 Δ1、Δ2… */
  label?: string;
}

/** explainDiff 结果：ok:false 时 summary/regionNotes 为空壳且 error 必有 */
export interface DiffExplanation {
  /** true = 云脑成功给出可用解释（summary 必非空） */
  ok: boolean;
  /** 一句中文总述（≤120 字；ok:false 时为 ''） */
  summary: string;
  /** 区域注解 —— 只含成功对齐的区域，顺序与输入 regions 一致（见 explainDiff 的对齐策略） */
  regionNotes: Array<{ label: string; note: string }>;
  /** true = 云脑路径未走通（未配置 / 编码失败 / chatJson 失败）—— 调用方应走本地降级路径 */
  degraded: boolean;
  /** 失败原因（ok:false 时必有；ok:true 时缺省） */
  error?: string;
  /** 整次调用墙钟延迟（毫秒，含图像编码） */
  latencyMs: number;
}

// ─── 内部工具 ───

/** 错误信息归并（code + message），供 error 字符串 —— 与 glmClient.errText 同款 */
function errText(e: unknown): string {
  const anyE = e as { code?: string; message?: string } | null;
  return `${anyE?.code ?? ''} ${anyE?.message ?? String(e)}`.trim();
}

/** 空白折叠：连续空白压成单空格并去首尾（summary/note 的统一规整） */
const collapseWs = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** 按码点硬截断（中文友好，不切代理对） */
const clip = (s: string, n: number): string => Array.from(s).slice(0, n).join('');

/** 规整后的内部区域表示（label 必非空；bbox 必为有限整数） */
interface PreparedRegion {
  label: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  areaPct?: number;
}

/**
 * 输入清单消毒：bbox 取整、非有限坐标整条丢弃；label 缺省自动编号 ΔN；
 * areaPct 非有限则省略；最多保留 MAX_REGIONS 条（prompt 有界）。
 */
function prepareRegions(regions: DiffRegionInput[]): PreparedRegion[] {
  const out: PreparedRegion[] = [];
  for (const r of (Array.isArray(regions) ? regions : []).slice(0, MAX_REGIONS)) {
    const b = r?.bbox;
    if (!b) continue;
    const coords = [b.x0, b.y0, b.x1, b.y1].map(v => Math.round(Number(v)));
    if (coords.some(v => !Number.isFinite(v))) continue;
    const label = typeof r.label === 'string' && r.label.trim() ? r.label.trim() : `Δ${out.length + 1}`;
    const area = Number(r.areaPct);
    out.push({
      label,
      bbox: { x0: coords[0]!, y0: coords[1]!, x1: coords[2]!, y1: coords[3]! },
      ...(Number.isFinite(area) ? { areaPct: Math.round(area * 10) / 10 } : {}),
    });
  }
  return out;
}

/** prompt 的区域清单段：空清单 → 总述指令（空 regions 语义的落点）；非空 → 逐条列出 */
function buildRegionList(prepared: PreparedRegion[]): string {
  if (prepared.length === 0) {
    return '本次没有预标记的变化区域 —— 请总述两张截图的整体差异，regions 返回空数组 []。';
  }
  const lines = prepared.map(r => {
    const bbox = `[${r.bbox.x0},${r.bbox.y0},${r.bbox.x1},${r.bbox.y1}]`;
    const area = r.areaPct !== undefined ? ` 面积占比=${r.areaPct}%` : '';
    return `- label=${r.label} bbox=${bbox}${area}`;
  });
  return `需要解说的变化区域（bbox 为像素坐标 [x0,y0,x1,y1]）：\n${lines.join('\n')}`;
}

/** VLM 返回的区域注解（extractPayload 规整后的形状） */
interface VlmRegionNote { label: string; note: string }

/**
 * chatJson value 的形状校验与字符串兜底：
 * - summary 缺席/空白 → null（bad-payload）；非字符串（数字等）→ String() 兜底
 * - regions 非数组按 [] 处理；逐条做 label/note 的 String() 兜底，
 *   label 或 note 规整后为空的条目整条丢弃
 * - summary 折叠空白并按 120 字硬截断（prompt 约束之外的第二道闸）
 */
function extractPayload(value: unknown): { summary: string; regions: VlmRegionNote[] } | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as { summary?: unknown; regions?: unknown };
  const rawSummary = typeof v.summary === 'string' ? v.summary : String(v.summary ?? '');
  const summary = collapseWs(rawSummary);
  if (!summary) return null;
  const regions: VlmRegionNote[] = Array.isArray(v.regions)
    ? v.regions.flatMap((r: unknown) => {
        const o = (r ?? {}) as { label?: unknown; note?: unknown };
        const label = collapseWs(typeof o.label === 'string' ? o.label : String(o.label ?? ''));
        const note = collapseWs(typeof o.note === 'string' ? o.note : String(o.note ?? ''));
        return label && note ? [{ label, note }] : [];
      })
    : [];
  return { summary: clip(summary, SUMMARY_MAX_CHARS), regions };
}

/**
 * 区域注解对齐策略（乱序/多余 label 的判决）：
 *   1. 第一优先：label 精确匹配 —— VLM 返回顺序无关（天然容忍乱序），
 *      输出按输入清单顺序重排；重复 label 以首次出现为准
 *   2. 兜底：所有 label 都对不上时，仅当返回条数与输入条数相等才按序对齐
 *      （唯一可辩护的位置推断）；数量不等则全部丢弃
 *   3. 宁缺毋滥：对不上号的输入区域直接省略（不出现在 regionNotes），
 *      VLM 多返回/臆造的 label 一律丢弃 —— 绝不给输入清单之外的区域编注解
 */
function alignRegionNotes(
  input: PreparedRegion[],
  returned: VlmRegionNote[],
): Array<{ label: string; note: string }> {
  if (returned.length === 0) return [];
  const byLabel = new Map<string, string>();
  for (const r of returned) if (!byLabel.has(r.label)) byLabel.set(r.label, r.note);
  const matched = input.map(r => byLabel.get(r.label));
  if (matched.every(n => n === undefined)) {
    // 标签全军覆没：数量一致才敢按序对齐，否则宁缺毋滥
    if (returned.length === input.length) {
      return input.map((r, i) => ({ label: r.label, note: returned[i]!.note }));
    }
    return [];
  }
  return input.flatMap((r, i) => {
    const note = matched[i];
    return note === undefined ? [] : [{ label: r.label, note }];
  });
}

// ─── 主入口 ───

/**
 * 差分区域语义解读：before/after 两图 + 变化区域清单 → 云脑中文解说。
 * 永不抛异常 —— 一切失败以 ok:false 返回（含注入 client 自身抛错的情形）。
 *
 * 【空 regions 语义】regions 为空时**仍发起一次** VLM 调用：让模型总述两张图的
 * 整体差异（prompt 明示 regions 返回 []），成功时 ok:true、regionNotes 恒为 []。
 *
 * 【degraded 语义】true = 云脑路径未走通（未注入 client 且环境未配置 apiKey /
 * 图像编码失败 / chatJson 调用失败或抛错）；ok:false 且 degraded:false = 调用
 * 成功但返回载荷不可用（summary 缺失，bad-payload）。调用方以 degraded 决定
 * 是否走本地认知降级路径。
 *
 * 【编码】两张图经 codec.encodeForVlm（缺省参数：长边 1568 / 质量 80）编码为
 * base64 JPEG 后随 prompt 下发；region 裁剪不在此层（VLM 需要整屏上下文）。
 *
 * @param before  操作前截图（任意常见格式 Buffer，PNG/JPEG 均可）
 * @param after   操作后截图
 * @param regions diff_view 的变化区域清单（可为空；超过 12 条截断，见 MAX_REGIONS）
 * @param opts    可注入 GlmClient（测试注入假 fetch 的 client，绝不真实联网）
 */
export async function explainDiff(
  before: Buffer,
  after: Buffer,
  regions: DiffRegionInput[],
  opts?: { client?: GlmClient },
): Promise<DiffExplanation> {
  const startedAt = performance.now();
  const finish = (r: Omit<DiffExplanation, 'latencyMs'>): DiffExplanation => ({
    ...r,
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
  });

  try {
    // 1) 云脑缺席短路：未注入 client 且环境未配置 → 诚实降级（不编码、不调用）
    let client = opts?.client;
    if (!client) {
      if (!isGlmConfigured()) {
        return finish({
          ok: false, summary: '', regionNotes: [], degraded: true,
          error: 'glm api key not configured — pass opts.client or set GLM_API_KEY / ZHIPUAI_API_KEY / ZAI_API_KEY',
        });
      }
      client = getGlmClient();
    }

    // 2) 编码两图（codec 缺省参数；失败即云脑路径未走通 → degraded）
    const [beforeEnc, afterEnc] = await Promise.all([
      encodeForVlm(before),
      encodeForVlm(after),
    ]);
    if (!beforeEnc.ok || !beforeEnc.value) {
      return finish({
        ok: false, summary: '', regionNotes: [], degraded: true,
        error: `encode before failed: ${beforeEnc.error ?? 'unknown'}`,
      });
    }
    if (!afterEnc.ok || !afterEnc.value) {
      return finish({
        ok: false, summary: '', regionNotes: [], degraded: true,
        error: `encode after failed: ${afterEnc.error ?? 'unknown'}`,
      });
    }

    // 3) prompt + 云脑结构化对话
    const prepared = prepareRegions(regions);
    const prompt = EXPLAIN_PROMPT_TEMPLATE.replace('{{REGION_LIST}}', () => buildRegionList(prepared));
    const images: GlmImageInput[] = [
      { base64: beforeEnc.value.base64, mime: beforeEnc.value.mime },
      { base64: afterEnc.value.base64, mime: afterEnc.value.mime },
    ];
    let res: { ok: boolean; value?: unknown; error?: string };
    try {
      res = await client.chatJson<{ summary: string; regions: VlmRegionNote[] }>({
        images, system: EXPLAIN_SYSTEM_PROMPT, prompt,
      });
    } catch (e) {
      // 注入 client 违约抛错 —— 不抛铁律的最后一块拼图
      return finish({
        ok: false, summary: '', regionNotes: [], degraded: true,
        error: `glm chatJson threw: ${errText(e)}`,
      });
    }
    if (!res.ok) {
      return finish({
        ok: false, summary: '', regionNotes: [], degraded: true,
        error: `glm chatJson failed: ${res.error ?? 'unknown'}`,
      });
    }

    // 4) 载荷校验（summary 必非空）+ 区域对齐（见 alignRegionNotes 策略）
    const payload = extractPayload(res.value);
    if (!payload) {
      return finish({
        ok: false, summary: '', regionNotes: [], degraded: false,
        error: 'bad payload: summary missing or empty after extraction',
      });
    }
    return finish({
      ok: true,
      summary: payload.summary,
      regionNotes: alignRegionNotes(prepared, payload.regions),
      degraded: false,
    });
  } catch (e) {
    // 兜底保险丝：任何未预见异常都收敛为返回值（绝不抛）
    return finish({
      ok: false, summary: '', regionNotes: [], degraded: true,
      error: `explainDiff internal failure: ${errText(e)}`,
    });
  }
}
