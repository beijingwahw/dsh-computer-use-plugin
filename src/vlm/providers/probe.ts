// src/vlm/providers/probe.ts
// 纪元 Ψ（Ψ-7 万脑归一）：探针与模型发现 —— 各平台体检（能不能通/有哪些视觉模型可用）。

import type { ProviderProtocol, VisionProvider } from './types';
import { fetchWithRetry, sanitizeError } from './types';
import { getSharp } from '../../_legacyDeps';
import { createAnthropicProvider } from './anthropic';
import { createGeminiProvider } from './gemini';
import { createOpenAiProvider } from './openai';

// ─── 探针结果契约 ───

/** 单个供应方的体检报告 */
export interface ProviderProbe {
  /** 供应方标识（透传 VisionProvider.id） */
  id: string;
  /** 是否探通：chat 成功且回复非空 */
  ok: boolean;
  /** 探测全程墙钟延迟（毫秒；未配置时为 0 —— 零网络零耗时） */
  latencyMs: number;
  /** 一句中文：通了/未配置/超时/HTTP 状态/错误摘要 —— 绝不泄漏 apiKey 值 */
  detail: string;
  /** 探测响应是否像视觉模型（回复非空且无 'image not supported' 类字样） */
  visionGuessed: boolean;
}

/** 探针超时缺省 —— 比正式调用（30s）更急：一次不通就快速让位 */
const PROBE_TIMEOUT_MS = 15_000;
/** 探针的回复预算 —— 只需要一句「ok」，8 token 足矣 */
const PROBE_MAX_TOKENS = 8;
/** 「模型不支持图像」类文案的嗅探模式 —— 命中即判 visionGuessed:false */
const UNSUPPORTED_HINT_RE = /unsupport|not support|image/i;
/** 模型发现超时缺省 */
const DISCOVER_TIMEOUT_MS = 10_000;

// ─── 密钥卫生（detail/error 面的本地兜底；供应方已 sanitize 过，此处纵深防御） ───

/**
 * 错误摘要整形：空白折叠 + Bearer/前缀形密钥打码 + 截 120 字。
 * 任何一步故障都保持上一轮结果 —— 绝不抛异常。
 */
function redactDetail(text: string): string {
  let s = '';
  try {
    s = String(text ?? '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
  try {
    s = s.replace(/(bearer\s+)[^\s"',;]+/gi, '$1[REDACTED]');
  } catch { /* 保持上一轮 */ }
  try {
    s = s.replace(/\b(?:sk|gsk|xai|rk|r8|hf)[_-][a-z0-9][a-z0-9_-]{7,}/gi, '[REDACTED]');
  } catch { /* 保持上一轮 */ }
  return s.slice(0, 120);
}

/**
 * 失败归因 —— 把供应方的 error 串翻成一句中文：
 * 超时（fetchWithRetry 的 'aborted after' 族）/ HTTP 状态（'http 401'/'HTTP 401' 族）/
 * 其余错误摘要。入参为空串 ⇒ 「供应方未给出原因」。
 */
function classifyFailure(errText: string, timeoutMs: number): string {
  const e = redactDetail(errText);
  if (e === '') return '失败：供应方未给出原因';
  if (/aborted after|timeouterror|etimedout/i.test(e)) return `超时（> ${timeoutMs}ms）：${e}`;
  const m = /\bhttps?\s+(\d{3})\b/i.exec(e);
  if (m) return `失败（HTTP ${m[1]}）：${e}`;
  return `失败：${e}`;
}

// ─── 1x1 白图（sharp 现场生成 JPEG，模块级缓存） ───

let whitePixelPromise: Promise<string> | null = null;

/** sharp 现场铸造 1x1 白色 JPEG 的 base64（裸 base64，无 data: 前缀） */
async function buildWhitePixelJpeg(): Promise<string> {
  // sharp 纪律（纪元 Δ-5）：废弃原生依赖统一经 src/_legacyDeps.ts 懒加载
  //（模块缓存 + 迁移错误消息 + DSH_FORCE_LEGACY_DEPS 回退开关）——
  // 不再直连 import('sharp') 绕过纪律面。
  const sharpFn = await getSharp();
  const buf = await sharpFn({
    create: { width: 1, height: 1, channels: 3, background: '#ffffff' },
  } as any).jpeg().toBuffer();
  return Buffer.from(buf as Uint8Array).toString('base64');
}

/** 取 1x1 白图 base64 —— 并发探测共享同一份缓存；失败不缓存（下次可重试） */
function whitePixelJpeg(): Promise<string> {
  if (whitePixelPromise === null) {
    whitePixelPromise = buildWhitePixelJpeg().catch(err => {
      whitePixelPromise = null;
      throw err;
    });
  }
  return whitePixelPromise;
}

// ─── probeProvider：单脑体检 ───

/**
 * 探测一个视觉供应方 —— 永不抛异常。
 *
 * - provider 未 configured（缺 apiKey 等）⇒
 *   `{ ok:false, latencyMs:0, detail:'未配置密钥', visionGuessed:false }` —— 零网络
 * - 已配置 ⇒ 发一张 1x1 白图（sharp 现场生成 JPEG）+ prompt「回复 ok」
 *   （maxTokens 8 / maxRetries 0 —— 探针不重试，一次不通就快速让位），latency 记测
 * - ok 判定：chat 结果 ok 且 text 非空
 * - visionGuessed 判定：结果 text 不含 /unsupport|not support|image/i
 *   （回复像「This model does not support image input」的纯文本脑 ⇒ false）
 * - detail 一句中文（通了/未配置/超时/HTTP 状态/错误摘要），经密钥卫生兜底 —— 绝不泄 key
 *
 * @param provider 任意兄弟适配器铸造出的 VisionProvider（或测试桩）
 * @param opts.timeoutMs 探测超时 —— 缺省 15000（探针比正式调用更急）
 */
export async function probeProvider(provider: VisionProvider, opts?: {
  timeoutMs?: number;
}): Promise<ProviderProbe> {
  const timeoutMs = opts?.timeoutMs ?? PROBE_TIMEOUT_MS;

  let pid = 'provider';
  try {
    pid = String((provider as { id?: unknown } | null | undefined)?.id ?? 'provider') || 'provider';
  } catch { /* 保持 'provider' */ }

  if (provider === null || provider === undefined || typeof provider.chat !== 'function') {
    return { id: pid, ok: false, latencyMs: 0, detail: 'provider 对象不合法（缺少 chat 方法）', visionGuessed: false };
  }

  let configured = false;
  try {
    configured = provider.configured === true;
  } catch { /* 脏值视为未配置 */ }
  if (!configured) {
    return { id: pid, ok: false, latencyMs: 0, detail: '未配置密钥', visionGuessed: false };
  }

  const startedAt = Date.now();
  try {
    const base64 = await whitePixelJpeg();
    const res = await provider.chat({
      images: [{ base64, mime: 'image/jpeg' }],
      prompt: '回复 ok',
      maxTokens: PROBE_MAX_TOKENS,
      timeoutMs,
      maxRetries: 0,
    });
    const latencyMs = Date.now() - startedAt;
    const text = typeof res?.text === 'string' ? res.text : '';

    if (res?.ok === true && text.trim() !== '') {
      return {
        id: pid,
        ok: true,
        latencyMs,
        detail: `通了：${latencyMs}ms 回复「${redactDetail(text).slice(0, 40)}」`,
        visionGuessed: !UNSUPPORTED_HINT_RE.test(text),
      };
    }
    if (res?.ok === true) {
      return { id: pid, ok: false, latencyMs, detail: '通了但回复为空（无法判定视觉性）', visionGuessed: false };
    }
    if (res?.degraded === true) {
      // configured 快照与 chat 实况竞态（理论边界）—— 仍按未配置归因
      return { id: pid, ok: false, latencyMs, detail: '未配置密钥', visionGuessed: false };
    }
    const errText = typeof res?.error === 'string' ? res.error : '';
    return { id: pid, ok: false, latencyMs, detail: classifyFailure(errText, timeoutMs), visionGuessed: false };
  } catch (e) {
    // 不抛铁律兜底：sharp 故障 / provider.chat 抛错都在此收敛为 ok:false
    return {
      id: pid,
      ok: false,
      latencyMs: Date.now() - startedAt,
      detail: `探测异常：${redactDetail(sanitizeError(e, pid))}`,
      visionGuessed: false,
    };
  }
}

// ─── discoverModels：模型发现（三协议尽力而为） ───

/** 发现到的模型条目 */
export interface DiscoveredModel {
  /** 模型标识（gemini 形态已剥 'models/' 前缀） */
  id: string;
  /** 归属方（openai 方言的 owned_by；方言未提供则缺省） */
  ownedBy?: string;
}

/** 模型发现选项 */
export interface DiscoverModelsOptions {
  /** 服务基址（尾斜杠自动归一；anthropic/gemini 已带版本段时不重复追加） */
  baseUrl: string;
  /** API Key —— 为空时不下发任何鉴权头（本地 Ollama/vLLM/LM Studio 免 Bearer） */
  apiKey?: string;
  /** 线协议 —— 未指明时按 openai → anthropic → gemini 顺序尽力尝试 */
  protocol?: ProviderProtocol;
  /** fetch 实现 —— 缺省用全局 fetch；测试注入假实现，绝不真实联网 */
  fetchImpl?: typeof fetch;
  /** 超时（毫秒）—— 缺省 10000 */
  timeoutMs?: number;
}

/**
 * 列模型接口的鉴权头（按方言）：
 * openai ⇒ `Authorization: Bearer`；anthropic ⇒ `x-api-key` + `anthropic-version:
 * 2023-06-01`；gemini ⇒ `x-goog-api-key`。apiKey 为空 ⇒ 无鉴权头
 * （本地无 key 的 baseUrl 免 Bearer —— 空头徒扰 Ollama 们）。
 */
function authHeaders(protocol: ProviderProtocol, apiKey: string): Record<string, string> {
  if (apiKey === '') return {};
  if (protocol === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  }
  if (protocol === 'gemini') {
    return { 'x-goog-api-key': apiKey };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

/**
 * 列模型 URL（按方言，尾斜杠已归一的 base）：
 * openai ⇒ `{base}/models`；anthropic ⇒ `{base}/v1/models`（base 已以 /v1 结尾则
 * 不重复追加）；gemini ⇒ `{base}/v1beta/models`（同理免 /v1beta 重复）。
 */
function modelListUrl(protocol: ProviderProtocol, base: string): string {
  if (protocol === 'anthropic') {
    return /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  }
  if (protocol === 'gemini') {
    return /\/v1beta$/.test(base) ? `${base}/models` : `${base}/v1beta/models`;
  }
  return `${base}/models`;
}

/**
 * 响应解析（按方言）：
 * openai/anthropic ⇒ `data[].id`（openai 另取 `owned_by` → ownedBy）；
 * gemini ⇒ `models[].name` 剥 'models/' 前缀。
 * 容器字段非数组 ⇒ null（诚实失败）；无 id/name 的脏条目静默跳过。
 */
function extractModels(protocol: ProviderProtocol, body: unknown): DiscoveredModel[] | null {
  if (protocol === 'gemini') {
    const arr = (body as { models?: unknown } | null)?.models;
    if (!Array.isArray(arr)) return null;
    const out: DiscoveredModel[] = [];
    for (const m of arr) {
      const name = (m as { name?: unknown } | null)?.name;
      if (typeof name !== 'string' || name === '') continue;
      const id = name.replace(/^models\//, '');
      if (id === '') continue;
      out.push({ id });
    }
    return out;
  }
  const arr = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(arr)) return null;
  const out: DiscoveredModel[] = [];
  for (const m of arr) {
    const id = (m as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || id === '') continue;
    const owned = (m as { owned_by?: unknown } | null)?.owned_by;
    out.push(typeof owned === 'string' && owned !== '' ? { id, ownedBy: owned } : { id });
  }
  return out;
}

/** 单协议形态的一次列模型尝试 —— 任何故障都归约为 { ok:false, error }，绝不抛 */
async function listModelsOnce(args: {
  base: string;
  apiKey: string;
  protocol: ProviderProtocol;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
}): Promise<{ ok: true; models: DiscoveredModel[] } | { ok: false; error: string }> {
  const { base, apiKey, protocol, fetchImpl, timeoutMs } = args;
  const tag = `${protocol} 模型列表`;
  try {
    const doFetch = typeof fetchImpl === 'function' ? fetchImpl
      : typeof fetch === 'function' ? fetch
      : undefined;
    if (!doFetch) return { ok: false, error: `${tag}：fetch 不可用（Node >= 18）` }; // doctor-exempt: 文案字符串，非阈值比较（W6-2）

    const headers: Record<string, string> = { Accept: 'application/json', ...authHeaders(protocol, apiKey) };
    const fr = await fetchWithRetry({
      doFetch,
      url: modelListUrl(protocol, base),
      init: { method: 'GET', headers },
      maxRetries: 0, // 发现是尽力而为 —— 不退避重试
      timeoutMs,
    });
    if (!fr.ok) {
      const st = typeof fr.status === 'number' ? ` HTTP ${fr.status}` : '';
      return { ok: false, error: redactDetail(`${tag}请求失败${st}：${fr.error ?? ''}`) };
    }
    let body: unknown;
    try {
      body = JSON.parse(fr.body ?? '');
    } catch {
      return { ok: false, error: `${tag}响应不是合法 JSON` };
    }
    const models = extractModels(protocol, body);
    if (models === null) {
      const field = protocol === 'gemini' ? 'models' : 'data';
      return { ok: false, error: `${tag}响应缺少 ${field} 数组` };
    }
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: redactDetail(sanitizeError(e, 'discover')) };
  }
}

/**
 * 模型发现 —— 对一个服务基址列出可用模型，三协议尽力而为，永不抛异常。
 *
 * 方言形状（JSDoc 契约）：
 *  - openai     ⇒ GET `{base}/models`（`Authorization: Bearer`；取 `data[].id` 与
 *    `data[].owned_by`）
 *  - anthropic  ⇒ GET `{base}/v1/models`（`x-api-key` + `anthropic-version:
 *    2023-06-01`；取 `data[].id`）
 *  - gemini     ⇒ GET `{base}/v1beta/models`（`x-goog-api-key`；取
 *    `models[].name` 并剥 'models/' 前缀）
 *  - 协议未指明 ⇒ 先试 openai 形态，不通再依次试 anthropic / gemini 形态
 *    （首个成功者胜出 —— 兼容网关常混杂多方言）
 *  - 失败 / 非 2xx / 解析异常 ⇒ `{ ok:false, models:[] }`（error 为中文摘要，
 *    经密钥卫生 —— 绝不泄 key）
 *  - 本地无 key 的 baseUrl 免 Bearer/鉴权头（Ollama/vLLM/LM Studio 直连）
 *
 * @returns ok:true 时 models 按服务端顺序（可为空数组 —— 服务端合法返回空表）
 */
export async function discoverModels(opts: DiscoverModelsOptions): Promise<{
  ok: boolean;
  models: DiscoveredModel[];
  error?: string;
}> {
  try {
    const base = String(opts?.baseUrl ?? '').trim().replace(/\/+$/, '');
    if (base === '') return { ok: false, models: [], error: 'baseUrl 为空，无从发现模型' };
    const apiKey = String(opts?.apiKey ?? '').trim();
    const timeoutMs = opts?.timeoutMs ?? DISCOVER_TIMEOUT_MS;
    const fetchImpl = typeof opts?.fetchImpl === 'function' ? opts.fetchImpl : undefined;
    const attempts: ProviderProtocol[] = opts?.protocol
      ? [opts.protocol]
      : ['openai', 'anthropic', 'gemini'];

    let lastError = '';
    for (const protocol of attempts) {
      const r = await listModelsOnce({ base, apiKey, protocol, fetchImpl, timeoutMs });
      if (r.ok) return { ok: true, models: r.models };
      lastError = r.error;
    }
    return { ok: false, models: [], error: lastError !== '' ? lastError : '模型发现失败（原因未知）' };
  } catch (e) {
    // 不抛铁律兜底（理论不可达）
    return { ok: false, models: [], error: redactDetail(sanitizeError(e, 'discover')) };
  }
}

// W6-2（doctor smell.over-engineering 清偿）：平台预设视图已分区提取至 probe.presets.ts
// （行为零变化）；导入面不变 —— 再分发。
import { PLATFORM_PRESETS, firstEnv, castPlatformProvider } from './probe.presets';
export { PLATFORM_PRESETS } from './probe.presets';
import type { PlatformPreset } from './probe.presets';
export type { PlatformPreset } from './probe.presets';



// ─── probeAllPlatforms：万脑总体检 ───

/**
 * 单平台探测任务（纪元 Δ-2 空模型发现路径的执行体）—— 永不抛：
 *  - model 非空（预设/环境给了缺省模型）⇒ 直接铸 provider 探测（原行为）；
 *  - model 为空（LM Studio/vLLM 形态，defaultModel:''）⇒ 先 discoverModels
 *    （协议已知 —— 单方言一次尝试）取服务端首个模型再探；发现失败或空表 ⇒
 *    如实报「无可用模型」（附失败摘要），绝不拿编造模型名撞出假 404。
 */
async function probeOnePreset(args: {
  preset: PlatformPreset;
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
}): Promise<ProviderProbe & { label: string; baseUrl: string }> {
  const { preset, apiKey, baseUrl, model, fetchImpl } = args;
  const startedAt = Date.now();
  try {
    let effModel = model;
    if (effModel === '') {
      const disc = await discoverModels({
        baseUrl,
        ...(apiKey !== '' ? { apiKey } : {}),
        protocol: preset.protocol,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      if (!disc.ok || disc.models.length === 0) {
        const why = disc.ok
          ? '服务端模型列表为空'
          : `模型发现失败（${redactDetail(disc.error ?? '原因未知')}）`;
        return {
          id: preset.id,
          ok: false,
          latencyMs: Date.now() - startedAt,
          detail: `无可用模型：${why}`,
          visionGuessed: false,
          label: preset.label,
          baseUrl,
        };
      }
      effModel = disc.models[0]!.id;
    }
    const provider = castPlatformProvider({ preset, apiKey, baseUrl, model: effModel, fetchImpl });
    return { ...(await probeProvider(provider)), label: preset.label, baseUrl };
  } catch (e) {
    // 不抛铁律兜底（discoverModels/probeProvider 自身皆不抛 —— 理论不可达）
    return {
      id: preset.id,
      ok: false,
      latencyMs: Date.now() - startedAt,
      detail: `探测异常：${redactDetail(sanitizeError(e, preset.id))}`,
      visionGuessed: false,
      label: preset.label,
      baseUrl,
    };
  }
}

/**
 * 遍历 PLATFORM_PRESETS 做全平台体检 —— 并行 Promise.all，永不抛异常。
 *
 * - 云端平台：env 放了 key（envKeys 首个非空者）才探，否则跳过（零网络零噪音）
 * - 本地平台（Ollama/LM Studio/vLLM，localAuthOptional）：无 key 也探
 *   （127.0.0.1 直连免鉴权）；includeLocal=false（缺省 true）时全部跳过
 * - 基址/模型可被 envBase/envModel 环境变量覆盖
 * - 空缺省模型平台（Δ-2）：先模型发现（GET {base}/models 等，按预设协议）取
 *   首个模型再探；发现失败 ⇒ detail 如实报「无可用模型」，不发假模型探测请求
 * - 返回数组只含被探测的平台，每条附 label 与实际 baseUrl；
 *   单平台失败不影响其余（probeOnePreset 自身收敛，Promise.all 不炸）
 *
 * @param opts.fetchImpl 注入 fetch —— 测试全离线；缺省走各 provider 的全局 fetch
 * @param opts.includeLocal 是否探本地三平台 —— 缺省 true
 */
export async function probeAllPlatforms(opts?: {
  fetchImpl?: typeof fetch;
  includeLocal?: boolean;
}): Promise<Array<ProviderProbe & { label: string; baseUrl: string }>> {
  const includeLocal = opts?.includeLocal ?? true;
  const fetchImpl = opts?.fetchImpl;
  try {
    const tasks: Array<Promise<ProviderProbe & { label: string; baseUrl: string }>> = [];
    for (const preset of PLATFORM_PRESETS) {
      const isLocal = preset.localAuthOptional === true;
      if (isLocal && !includeLocal) continue;
      const apiKey = firstEnv(preset.envKeys ?? []);
      if (!isLocal && apiKey === '') continue;
      const baseUrl = (firstEnv(preset.envBase ? [preset.envBase] : []) || preset.baseUrl).trim() || preset.baseUrl;
      const model = firstEnv(preset.envModel ? [preset.envModel] : []) || preset.model || '';
      tasks.push(probeOnePreset({ preset, apiKey, baseUrl, model, fetchImpl }));
    }
    return await Promise.all(tasks);
  } catch {
    // 不抛铁律兜底（理论不可达 —— preset 表静态合法）
    return [];
  }
}
