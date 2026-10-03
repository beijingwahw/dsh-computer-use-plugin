// src/vlm/autoAdopt.ts
// 纪元 Λ（Λ-1 开箱即亮）：本地自动接管 —— 零配置点亮一颗本地视觉脑。
//
// 为什么存在：用户刚装好插件、一个 key 都没配时，向导冷启动是一片黑。但本机
// 可能正跑着 Ollama / LM Studio / vLLM（127.0.0.1 免密直连）。本模块按固定
// 顺序轻叩三家的 /models 门（GET，无鉴权头，1.5s 止损），谁能交出非空模型表，
// 就从中挑一颗视觉倾向的模型（vl / vision / llava / minicpm / moondream /
// gemma-vision / qwen-vl 命名家族），铸成 AdoptedLocal 交给 connection.ts 落档
//（via:'auto-adopt'）—— 开箱即亮，配了云 key 后随时可换。
//
// 设计要点：
//   - 顺序探测不并行 —— 本地串行足够快（三端口全超时也只 ~4.5s）且日志有序
//     （用户能看到「试 Ollama → 试 LM Studio → …」的接管轨迹）
//   - 数据单一来源 —— 本地三家候选投影自 providers/registry 的 PLATFORM_PRESETS
//     （换基址只改 registry 一处，与 probe.ts 同律）
//   - 绝不抛异常 —— 任何故障（fetch 抛错 / 非 2xx / 坏 JSON / 空表）都归约为
//     「下一个候选」，全败 ⇒ null
import { fetchWithRetry } from './providers/types';
import { PLATFORM_PRESETS } from './providers/registry';
import type { PlatformPreset } from './providers/registry';

/** 一次成功接管的全套物料 + 归因线索 */
export interface AdoptedLocal {
  /** 命中的平台 id（registry 本地预设：'ollama' / 'lmstudio' / 'vllm'） */
  platform: string;
  /** 命中候选的服务基址（LOCAL_CANDIDATES 原文） */
  baseUrl: string;
  /** 挑中的视觉模型（pickVisionModel 的产物） */
  model: string;
  /** 服务端交出的完整模型表（原始顺序 —— 供向导展示可选项） */
  models: string[];
  /** 该候选探测全程墙钟延迟（毫秒） */
  latencyMs: number;
}

/** 本地三家的探测顺序 —— Ollama（最普及）→ LM Studio → vLLM；
 * platform/baseUrl 投影自 registry.PLATFORM_PRESETS（单一数据源，删桩不重复） */
export const LOCAL_CANDIDATES: ReadonlyArray<{ platform: string; baseUrl: string }> = (
  ['ollama', 'lmstudio', 'vllm'] as const
)
  .map(id => PLATFORM_PRESETS.find(p => p.id === id))
  .filter((p): p is PlatformPreset => p !== undefined)
  .map(p => ({ platform: p.id, baseUrl: p.baseUrl }));

/** 单候选探测超时缺省 —— 本地回环要么秒应要么没人听，1.5s 足够止损 */
const DEFAULT_ADOPT_TIMEOUT_MS = 1500;

/** 视觉倾向命名家族 —— 命中即优先接管（大小写不敏感） */
const VISION_MODEL_RE = /(vl|vision|llava|minicpm|moondream|gemma.*vision|qwen.*vl)/i;

// ─── pickVisionModel：纯函数挑模 ───

/**
 * 从模型表挑一颗视觉脑 —— 纯函数（零 I/O / 零副作用），永不抛：
 *   - 空表 / 全垃圾（非字符串、纯空白条目）⇒ null
 *   - 命中视觉倾向命名（VISION_MODEL_RE）⇒ 按表序取首个命中
 *   - 无命中 ⇒ 排序后取首个（确定性 —— 服务端顺序不稳时结果仍可复现）
 */
export function pickVisionModel(models: string[]): string | null {
  try {
    if (!Array.isArray(models)) return null;
    const clean: string[] = [];
    for (const m of models) {
      if (typeof m !== 'string') continue; // 垃圾条目跳过
      const id = m.trim();
      if (id === '') continue;
      clean.push(id);
    }
    if (clean.length === 0) return null;
    for (const id of clean) {
      if (VISION_MODEL_RE.test(id)) return id; // 视觉倾向：表序首个命中
    }
    return [...clean].sort()[0] ?? null; // 兜底：排序后首个（确定性）
  } catch {
    return null;
  }
}

// ─── 响应解析 ───

/** 列表 URL：尾斜杠归一后拼 /models（'http://127.0.0.1:11434/v1' → '…/v1/models'） */
function modelsUrl(baseUrl: string): string {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  return `${base}/models`;
}

/**
 * 解析 openai 方言模型表：`data[].id` 收敛为字符串数组（非字符串 / 空白 id 的
 * 脏条目静默跳过 —— probe.extractModels 同律）。容器字段非数组 ⇒ null（诚实
 * 失败，视为该候选不可用）；空数组如实返回（由调用方判空表）。
 */
function extractModelIds(body: unknown): string[] | null {
  const data = (body as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data)) return null;
  const ids: string[] = [];
  for (const m of data) {
    const id = (m as { id?: unknown } | null | undefined)?.id;
    if (typeof id !== 'string' || id.trim() === '') continue;
    ids.push(id.trim());
  }
  return ids;
}

/** 单候选一次探测 —— 任何故障归约 null（下一候选的信号），绝不抛 */
async function tryAdoptOne(cand: { platform: string; baseUrl: string }, doFetch: typeof fetch, timeoutMs: number): Promise<AdoptedLocal | null> {
  const startedAt = Date.now();
  try {
    // 无鉴权头：本地三家免密直连（空头徒扰 Ollama 们）；GET 一次、不重试
    const fr = await fetchWithRetry({
      doFetch,
      url: modelsUrl(cand.baseUrl),
      init: { method: 'GET', headers: { Accept: 'application/json' } },
      maxRetries: 0,
      timeoutMs,
    });
    if (!fr.ok) return null; // 非 2xx / 超时 / 传输失败 ⇒ 下一候选

    let body: unknown;
    try {
      body = JSON.parse(fr.body ?? '');
    } catch {
      return null; // 坏 JSON ⇒ 下一候选
    }
    const models = extractModelIds(body);
    if (models === null || models.length === 0) return null; // 缺容器 / 空表 ⇒ 下一候选

    const model = pickVisionModel(models);
    if (model === null) return null; // 全垃圾表（理论不可达 —— 已滤空）
    return {
      platform: cand.platform,
      baseUrl: cand.baseUrl,
      model,
      models,
      latencyMs: Date.now() - startedAt,
    };
  } catch {
    return null; // 不抛铁律兜底（fetchWithRetry 自身不抛 —— 理论不可达）
  }
}

/**
 * 本地视觉脑自动接管 —— 按候选顺序探测（串行，不并行），永不抛异常：
 *   - 每候选 GET `{base}/models`（无鉴权头；超时缺省 1500ms）
 *   - 2xx 且解析出 `data[].id` 非空列表 ⇒ pickVisionModel 挑模 ⇒ 返回首个
 *     命中候选的 AdoptedLocal（platform/baseUrl/models/latencyMs 全套）
 *   - 任何异常 / 非 2xx / 坏 JSON / 空表 ⇒ 静默转下一候选
 *   - 全败 / fetch 不可用 ⇒ null（向导冷启动照旧 —— 自动接管只加分不添堵）
 *
 * @param opts.fetchImpl  fetch 注入 —— 测试全离线；缺省用全局 fetch
 * @param opts.timeoutMs  单候选探测超时（缺省 1500）
 * @param opts.candidates 候选覆盖（缺省 LOCAL_CANDIDATES：ollama → lmstudio → vllm）
 */
export async function adoptLocalVision(opts?: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  candidates?: ReadonlyArray<{ platform: string; baseUrl: string }>;
}): Promise<AdoptedLocal | null> {
  try {
    const injected = typeof opts?.fetchImpl === 'function' ? opts.fetchImpl : undefined;
    const doFetch = injected ?? (typeof fetch === 'function' ? fetch : undefined);
    if (typeof doFetch !== 'function') return null; // 运行时无 fetch（Node < 18）⇒ 诚实弃权

    const rawTimeout = Number(opts?.timeoutMs);
    const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout
      : DEFAULT_ADOPT_TIMEOUT_MS;
    const candidates = opts?.candidates ?? LOCAL_CANDIDATES;
    if (!Array.isArray(candidates)) return null;

    for (const cand of candidates) {
      const adopted = await tryAdoptOne(cand, doFetch, timeoutMs);
      if (adopted !== null) return adopted; // 首个命中即接管
    }
    return null;
  } catch {
    return null; // 不抛铁律的最终兜底
  }
}
