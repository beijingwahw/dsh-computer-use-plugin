// src/vlm/providers/types.ts
// 纪元 Ψ（Ψ-1 万脑归一）：全平台视觉模型统一契约 —— 协议类型 + 共享原语。
//
// 本文件是 Ψ 纪元的宪法石碑：所有兄弟适配器（openai / anthropic / gemini …）
// 一字不差地依赖这里的接口与工具函数。因此本模块：
//   1. 零依赖 —— 不 import 任何兄弟模块（叶子模块，杜绝环引）
//   2. 永不抛异常 —— 一切失败以返回值 ok:false / undefined 表达（与 glmClient 同律）
//   3. 密钥卫生 —— 错误串化面绝不泄漏 apiKey 值（sanitizeError 强制剔除）
//   4. 行为基调继承 Ω-1（glmClient）：degraded 降级律 / JSON 剥壳律 /
//      全抖动指数退避（500·2^n 封顶 8s，仅 429/5xx/网络错可重试，超时不重试）
//
// 适配器实现 VisionProvider 接口；registry（Ψ-2+）按 ProviderOptions 装配。

// ─── 协议与请求/结果类型 ───

/** 供应商线协议族 —— 决定请求体/鉴权/响应字段的方言 */
export type ProviderProtocol = 'openai' | 'anthropic' | 'gemini';

/**
 * W2-8（C2 成本级联路由）：供应方成本档标注 —— 'cheap' = 池内最便宜档
 * （级联便宜臂候选脑），'primary' = 主力档（缺省）。三用途正交律：本字段只被
 * 级联路由（providers/cascade）消费，failover（池序切换）与 ensemble（合议庭）
 * 语义完全不受影响；未标注/脏值一律视为 'primary'（零行为变化律）。
 */
export type ProviderTier = 'primary' | 'cheap';

/** 视觉输入：裸 base64（不带 data: 前缀）+ 可选 mime（默认 image/jpeg） */
export interface VisionImage {
  /** 图像裸 base64（无 data: 前缀、无换行） */
  base64: string;
  /** MIME 类型 —— 缺省 'image/jpeg'（拼进 data URL：`data:{mime};base64,{base64}`） */
  mime?: string;
}

/** 一次视觉对话请求（images/prompt 外全部可选，缺省值见字段注释） */
export interface VisionChatRequest {
  /** 截图序列（至少一帧才有视觉语义；空数组 = 纯文本对话，协议上合法） */
  images: VisionImage[];
  /** 系统提示词 —— 缺省不发送 system 消息 */
  system?: string;
  /** 用户指令（与截图一起进最后一条 user 消息） */
  prompt: string;
  /** 最大生成 token 数 —— 默认 2048 */
  maxTokens?: number;
  /** 采样温度 —— 默认 0.1（桌面自动化要确定性，不要发散） */
  temperature?: number;
  /** true 时请求结构化输出（openai: response_format；anthropic/gemini 由提示词约定） */
  jsonMode?: boolean;
  /** 单次 fetch 尝试的超时（毫秒）—— 默认 30000 */
  timeoutMs?: number;
  /** 重试次数上限 —— 默认 2（仅 429/5xx/网络错，全抖动 500·2^n 封顶 8s；超时不重试） */
  maxRetries?: number;
}

/** chat 调用结果 —— ok:false 时 text 恒为 ''（绝不部分成功） */
export interface VisionChatResult {
  ok: boolean;
  /** 模型回复正文（方言提取后的纯文本） */
  text: string;
  /** jsonMode 下成功提取的 JSON 值（提取失败则缺省 —— 判结构化成败请用 chatJson） */
  json?: unknown;
  /** token 用量（服务端未上报则缺省） */
  usage?: { promptTokens?: number; completionTokens?: number };
  /** 整次调用（含全部重试）的墙钟延迟 */
  latencyMs: number;
  /** 实际使用的模型名（配置解析后） */
  model: string;
  /** 供应方标识（VisionProvider.id —— 仲裁/遥测按此归因） */
  providerId: string;
  /** 失败原因（ok:false 时必有；已经 sanitizeError 密钥卫生处理） */
  error?: string;
  /** 降级标记 —— true = 供应方未配置（调用方应走本地认知降级路径，而非崩溃） */
  degraded?: boolean;
}

/** meter 上报记录 —— 万脑用量遥测（Ψ 纪元观测面，各适配器统一上报形态） */
export interface ProviderMeterRecord {
  /** 上报时间戳（Date.now()） */
  ts: number;
  /** 记录种类 —— 由适配器自定（如 'provider.chat'），registry 聚合时按 kind 分流 */
  kind: string;
  /** 供应方标识 */
  providerId: string;
  /** 模型名 */
  model: string;
  /** 整次调用延迟（含重试） */
  latencyMs: number;
  /** 成败 */
  ok: boolean;
  promptTokens?: number;
  completionTokens?: number;
  /** 失败原因（ok:false 时可有；密钥卫生已保证） */
  error?: string;
}

/** 视觉供应方统一接口 —— 一切兄弟适配器实现此契约（Ψ 的万脑插头） */
export interface VisionProvider {
  /** 供应方标识（小写短名，如 'glm'/'qwen'/'openai' —— 归因与遥测主键） */
  readonly id: string;
  /** 线协议方言 —— 决定 chat 内部的请求翻译 */
  readonly protocol: ProviderProtocol;
  /** 实际使用的模型名 */
  readonly model: string;
  /** 是否已配置（缺 apiKey 等 ⇒ false，chat 走 degraded 降级臂） */
  readonly configured: boolean;
  /**
   * W2-8（C2 成本级联路由）：成本档自报（模型自报成本的标注面）——
   * 'cheap' = 便宜档候选；缺省/脏值 = 'primary'。可选字段：既有适配器
   * 零改动即满足（undefined ⇒ 主力档，零行为变化律）。仅级联路由消费。
   */
  readonly tier?: ProviderTier;
  /** 视觉对话 —— 永不抛错（失败以 ok:false 表达） */
  chat(req: VisionChatRequest): Promise<VisionChatResult>;
  /**
   * 结构化对话 —— 强制 jsonMode + 健壮 JSON 提取（extractProviderJson 同律）。
   * 成功：{ ok:true, value, raw }；失败：{ ok:false, error, raw } —— raw 恒为
   * 模型回复原文（成功也是），调用方可落日志/回退解析。
   */
  chatJson<T>(req: VisionChatRequest): Promise<{ ok: boolean; value?: T; error?: string; raw: string }>;
}

/** 供应方装配选项 —— 一切可注入（测试的假 fetch / 宿主的 meter 都从这里进） */
export interface ProviderOptions {
  /** 供应方标识（缺省由具体适配器自命名，如 'glm'） */
  id?: string;
  /** API Key —— 各适配器自定环境变量回退次序；为空 ⇒ configured:false 走降级臂 */
  apiKey?: string;
  /** 服务基址 —— 缺省为各协议官方云端；指向本机（isLocalBaseUrl）即为私脑部署 */
  baseUrl?: string;
  /** 模型名 —— 缺省为各适配器的缺省模型 */
  model?: string;
  /** fetch 实现 —— 缺省用全局 fetch；测试注入假实现，绝不真实联网 */
  fetchImpl?: typeof fetch;
  /** 用量/延迟遥测回调 —— 每次 chat 调用（含降级失败）恰好上报一条 */
  meter?: (rec: ProviderMeterRecord) => void;
  /** 追加请求头（同名覆盖缺省头；值不参与错误面 —— 密钥卫生律） */
  extraHeaders?: Record<string, string>;
}

// ─── JSON 剥壳律（与 glmClient.extractGlmJson 同律，独立自实现保持叶子性） ───

/** 剥 Markdown 围栏 —— ```json\n{...}\n``` → {...（仅当整体被围栏包裹时） */
function stripFences(s: string): string {
  const m = /^```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```$/.exec(s.trim());
  return m ? m[1].trim() : s.trim();
}

/** 从文本中取首个平衡的 {...} / [...] 片段 —— 字符串感知（跳过引号内的括号
 *  与转义），返回切出的原文片段；无平衡片段返回 null。 */
function scanBalanced(s: string): string | null {
  const start = s.search(/[{[]/);
  if (start < 0) return null;
  const open = s[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 健壮 JSON 提取（JSON 剥壳律）：剥 ```json 围栏 → 取首个平衡 {...}/[...] → parse。
 * 成功返回解析值（可为 null/false 等合法 JSON 值）；失败返回 undefined。
 * 永不抛异常 —— 入参为 null/undefined 等脏值同样安静返回 undefined。
 */
export function extractProviderJson(text: string): unknown | undefined {
  try {
    const candidate = scanBalanced(stripFences(text));
    if (candidate === null) return undefined;
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

// ─── 图像 data URL ───

/**
 * 拼 data URL：`data:${mime};base64,${base64}`（mime 缺省/空串回退 'image/jpeg'）。
 * 纯字符串拼接，绝不抛异常。
 */
export function buildDataUrl(img: VisionImage): string {
  const rawMime = img?.mime;
  const mime = typeof rawMime === 'string' && rawMime !== '' ? rawMime : 'image/jpeg';
  return `data:${mime};base64,${img?.base64 ?? ''}`;
}

// ─── 密钥卫生律：错误串化 ───

/** 密钥占位符 —— 一切被识别的凭据片段统一替换为此串 */
const REDACTED = '[REDACTED]';

/** 敏感模式与替换式（密钥卫生律的执行面，依次全量应用）：
 *  1. Bearer 令牌值；2. 常见前缀形密钥（sk-/gsk_/AIza…）；3. 键值对形
 *  （api_key=… / "apiKey":"…" / ?key=… / Authorization: …）。宁可错杀一百
 *  （误伤普通词），不可放过一个密钥 —— 错误面丢了细节无损，泄了密钥致命。 */
const SECRET_PATTERNS: readonly { re: RegExp; repl: string }[] = [
  { re: /(bearer\s+)[^\s"',;]+/gi, repl: `$1${REDACTED}` },
  { re: /\b(?:sk|gsk|xai|rk|r8|hf)[_-][a-z0-9][a-z0-9_-]{7,}/gi, repl: REDACTED },
  { re: /\baiza[a-z0-9_-]{10,}\b/gi, repl: REDACTED },
  {
    re: /(^|[^a-z0-9_-])((?:api[-_]?key|access[-_]?token|auth[-_]?token|authorization|secret|password|token|key)["']?[ \t]*[:=][ \t]*)(?:"[^"]*"|'[^']*'|[^\s,;&>]+)/gi,
    repl: `$1$2${REDACTED}`,
  },
];

/** 对已串化的错误文本做密钥剔除 —— 任一模式故障不影响其余（不抛铁律） */
function redactSecrets(s: string): string {
  let out = s;
  for (const { re, repl } of SECRET_PATTERNS) {
    try {
      out = out.replace(re, repl);
    } catch { /* 理论不可达 —— 保持上一轮结果 */ }
  }
  return out;
}

/** 错误串化（不安全面）：null/undefined → ''；Error → `code message`（cause.code
 *  归并，glmClient.errText 同律）；无 message 的裸对象 → JSON 序列化兜底；
 *  一切兜底皆 try/catch —— 绝不抛。 */
function stringifyError(err: unknown): string {
  try {
    if (err === null || err === undefined) return '';
    if (typeof err === 'string') return err;
    if (typeof err !== 'object') {
      try { return String(err); } catch { return ''; } // symbol 等原始值
    }
    const e = err as { message?: unknown; code?: unknown; cause?: { code?: unknown } | null };
    let msg = typeof e.message === 'string' ? e.message : '';
    if (msg === '') {
      // 无 message 的裸对象（如 { apiKey }）：JSON 序列化兜底（环引用/BigInt 吞掉）
      try {
        const j = JSON.stringify(err);
        if (typeof j === 'string' && j !== '' && j !== '{}') msg = j;
      } catch { /* 留给 toString 兜底 */ }
    }
    if (msg === '') {
      try {
        const s = String(err);
        if (s !== '' && s !== '[object Object]') msg = s;
      } catch { return ''; }
    }
    const codeOf = (v: unknown): string =>
      (typeof v === 'string' || typeof v === 'number') && String(v) !== '' ? String(v) : '';
    const code = codeOf(e.cause?.code) || codeOf(e.code);
    return `${code} ${msg}`.trim();
  } catch {
    return '';
  }
}

/**
 * 错误安全串化（密钥卫生律 + 截断律）：
 *  - 输出恒为 `${providerId} ...` 前缀形态；无可用信息时 `${providerId} unknown error`
 *  - 正文（前缀之外）截 300 字、空白折叠为单空格
 *  - 绝不包含 apiKey 值：Bearer/前缀形/键值对形凭据一律替换 [REDACTED]
 *  - 绝不抛异常 —— err 为任何脏值（含抛错 toString 的对象）都安静产出字符串
 */
export function sanitizeError(err: unknown, providerId: string): string {
  let pid = 'provider';
  try {
    const s = String(providerId ?? '').trim();
    if (s !== '') pid = s;
  } catch { /* 保持 'provider' */ }
  let body: string;
  try {
    body = redactSecrets(stringifyError(err)).replace(/\s+/g, ' ').trim().slice(0, 300);
  } catch {
    body = '';
  }
  return body === '' ? `${pid} unknown error` : `${pid} ${body}`;
}

// ─── 基址判别 ───

/** 本机回环主机集合（小写、去 IPv6 方括号后比对） */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * 判基址是否指向本机：host 为 127.0.0.1 / localhost / ::1 ⇒ true。
 * URL 解析失败（脏值/相对串）⇒ 安静返回 false（不抛）；'localhost.evil.com'
 * 等后缀仿冒不匹配（整 host 精确比对）。
 */
export function isLocalBaseUrl(url: string): boolean {
  try {
    const u = new URL(String(url ?? ''));
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return LOCAL_HOSTS.has(host);
  } catch {
    return false;
  }
}

// ─── 退避与重试 ───

/**
 * 全抖动指数退避延迟 —— uniform(0, min(capMs, baseMs·2^attempt))，默认 500/8000。
 * 入参脏值（负/非有限）安静钳到安全域；上限恒不为负 —— 返回值总在 [0, ceiling)。
 */
export function jitterDelayMs(attempt: number, baseMs = 500, capMs = 8000): number {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 500;
  const cap = Number.isFinite(capMs) && capMs > 0 ? capMs : 8000;
  const a = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  let ceiling: number;
  try {
    ceiling = Math.min(cap, base * 2 ** a);
  } catch {
    ceiling = 0;
  }
  if (!Number.isFinite(ceiling) || ceiling <= 0) return 0;
  return Math.floor(Math.random() * ceiling);
}

/** sleep Promise —— 退避专用 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 构造超时信号 —— AbortSignal.timeout 主路径 + 旧运行时 AbortController 兜底
 *  （与 glmClient 同款：timer unref 不阻进程退出） */
function timeoutSignal(timeoutMs: number): AbortSignal {
  try {
    return AbortSignal.timeout(timeoutMs);
  } catch {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    t.unref?.();
    return ctrl.signal;
  }
}

/** 判超时/中止异常 —— AbortSignal.timeout 抛 TimeoutError，手动 abort 抛 AbortError */
function isAbortError(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/** 安全读响应正文 —— body 读失败（连接已断）返回空串，绝不抛 */
async function safeBodyText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}

/**
 * 带重试的 fetch（全适配器共享的传输底座 —— 重试律的唯一定义点）：
 *  - 仅 429/5xx/网络异常可重试；AbortError/TimeoutError（超时止损）不重试
 *  - 每次重试前回调 onRetry(attempt, reason)（attempt 为刚失败尝试的 0 起序号，
 *    与 jitterDelayMs 同参；回调自身抛错被吞 —— 不抛铁律）
 *  - 每次尝试注入独立的超时 AbortSignal（覆盖 init.signal；timeoutMs 归此函数管）
 *  - 重试间隔 = jitterDelayMs(attempt)（全抖动 500·2^n 封顶 8s）
 *  - 成功（2xx）⇒ { ok:true, status, body, attempts }
 *  - HTTP 终败 ⇒ { ok:false, status, body, error:'http <s> after <n> attempts', attempts }
 *  - 传输终败 ⇒ { ok:false, error:'fetch failed after <n> attempts: ...', attempts }
 *  - 超时/中止 ⇒ { ok:false, error:'request aborted after <timeoutMs>ms', attempts }
 *  attempts 恒为实际发出的 fetch 次数（1 = 未重试）；绝不抛异常。
 */
export async function fetchWithRetry(opts: {
  doFetch: typeof fetch;
  url: string;
  init: RequestInit;
  maxRetries: number;
  timeoutMs: number;
  onRetry?: (attempt: number, reason: string) => void;
}): Promise<{ ok: boolean; status?: number; body?: string; error?: string; attempts: number }> {
  try {
    const doFetch = typeof opts?.doFetch === 'function' ? opts.doFetch : undefined;
    if (!doFetch) {
      return { ok: false, error: 'fetch is not available (Node >= 18 required)', attempts: 0 };
    }
    let url: string;
    try {
      url = typeof opts.url === 'string' ? opts.url : String(opts.url ?? '');
    } catch {
      url = '';
    }
    let init: RequestInit;
    try {
      init = { ...(opts.init ?? {}) };
    } catch {
      init = {};
    }
    const rawRetries = Number(opts.maxRetries);
    const maxRetries = Number.isFinite(rawRetries) ? Math.max(0, Math.floor(rawRetries)) : 0;
    const rawTimeout = Number(opts.timeoutMs);
    const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 30_000;
    const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : undefined;

    let attempt = 0; // 已失败尝试的 0 起序号（jitter 与 onRetry 共用）
    for (;;) {
      let resp: Response | undefined;
      try {
        resp = await doFetch(url, { ...init, signal: timeoutSignal(timeoutMs) });
      } catch (e) {
        // 超时：调用方主动止损 —— 不重试，立即诚实归因
        if (isAbortError(e)) {
          return { ok: false, error: `request aborted after ${timeoutMs}ms`, attempts: attempt + 1 };
        }
        // 网络错误（连接拒绝 / DNS / 断流）：可重试
        if (attempt < maxRetries) {
          safeNotify(onRetry, attempt, `network: ${stringifyError(e).slice(0, 120)}`);
          await sleep(jitterDelayMs(attempt));
          attempt++;
          continue;
        }
        return {
          ok: false,
          error: `fetch failed after ${attempt + 1} attempts: ${stringifyError(e).slice(0, 300)}`,
          attempts: attempt + 1,
        };
      }

      if (resp && resp.ok) {
        return { ok: true, status: resp.status, body: await safeBodyText(resp), attempts: attempt + 1 };
      }

      // 非 2xx：429/5xx 可重试，其余 4xx 立即失败（请求本身有病，重试无义）
      const status = typeof resp?.status === 'number' ? resp.status : 0;
      const retryable = status === 429 || status >= 500;
      if (retryable && attempt < maxRetries) {
        await safeBodyText(resp); // 排干 body 再退避（连接复用礼貌）
        safeNotify(onRetry, attempt, `http ${status}`);
        await sleep(jitterDelayMs(attempt));
        attempt++;
        continue;
      }
      const n = attempt + 1;
      return {
        ok: false,
        status,
        body: await safeBodyText(resp),
        error: `http ${status} after ${n} attempt${n > 1 ? 's' : ''}`,
        attempts: n,
      };
    }
  } catch (e) {
    // 不抛铁律的最终兜底（理论不可达 —— init 展开等同步面故障）
    return { ok: false, error: `fetchWithRetry internal error: ${stringifyError(e).slice(0, 200)}`, attempts: 1 };
  }
}

/** onRetry 安全回调 —— 回调自身抛错不得影响主路径 */
function safeNotify(
  onRetry: ((attempt: number, reason: string) => void) | undefined,
  attempt: number,
  reason: string,
): void {
  if (!onRetry) return;
  try {
    onRetry(attempt, reason);
  } catch { /* 遥测故障静默 —— 主流程已定 */ }
}
