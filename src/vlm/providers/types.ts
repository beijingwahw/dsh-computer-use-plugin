// src/vlm/providers/types.ts
// 纪元 Ψ（Ψ-1 万脑归一）：全平台视觉模型统一契约 —— 协议类型 + 共享原语。
//
// 本文件是 Ψ 纪元的宪法石碑：所有兄弟适配器（openai / anthropic / gemini …）
// 一字不差地依赖这里的接口与工具函数。因此本模块：
//   1. 零兄弟依赖 —— 不 import 任何兄弟适配器（杜绝环引）；唯一依赖是同为
//      零依赖叶子的 internalUtils（W6R-A4 工具去重：stripFences / scanBalanced /
//      传输小件 / 状态常量收拢为单一实现，叶子链不可能成环）
//   2. 永不抛异常 —— 一切失败以返回值 ok:false / undefined 表达（与 glmClient 同律）
//   3. 密钥卫生 —— 错误串化面绝不泄漏 apiKey 值（sanitizeError 强制剔除）
//   4. 行为基调继承 Ω-1（glmClient）：degraded 降级律 / JSON 剥壳律 /
//      全抖动指数退避（500·2^n 封顶 8s，仅 429/5xx/网络错可重试，超时不重试）
//
// 适配器实现 VisionProvider 接口；registry（Ψ-2+）按 ProviderOptions 装配。

import {
  extractBalancedJson,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_SERVER_ERROR_FLOOR,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  isAbortError,
  safeBodyText,
  sleep,
  timeoutSignal,
} from '../internalUtils';

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
  /**
   * ΝΩ-44（结构化输出约束解码）：请求级 opt-in JSON Schema（JSON Schema 子集，
   * 由调用方自持 —— ProviderOptions 不动，这是请求级开关而非装配期配置）。
   * 字段缺席 ⇒ 三家适配器逐字节走旧路径（openai json_object / anthropic·gemini
   * 提示词约定），零回归铁律；在场时按各方言落地原生约束解码：
   *   - openai：与 jsonMode 同开 ⇒ response_format 升级
   *     {type:'json_schema', json_schema:{name:'dsh_response', strict:true, schema}}；
   *     网关 400 点名 json_schema/response_format ⇒ 依 ΝΩ-18 回退链降级
   *     json_object → prompt-only（每级恰重发一次）
   *   - anthropic：改走 tool_use 强 schema（tools:[{name:'emit', input_schema}] +
   *     tool_choice 强制；输出取 content 里 tool_use 块的 input）；失败 ⇒
   *     提示词后缀模式回退并注记
   *   - gemini：generationConfig.responseSchema + responseMimeType（schema 经
   *     OpenAPI 子集最小转换器收窄，不支持的字段丢弃并注记）；失败 ⇒ 提示词
   *     后缀模式回退并注记
   * 约束解码失败绝不上抛 —— 一律诚实回退提示词模式（运行层零异常铁律）。
   */
  jsonSchema?: Record<string, unknown>;
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

/** chatJson 的回执形状 —— 万脑插头与窄端口（StructuredVisionPort）的公共货币 */
export interface VisionJsonReply<T> {
  ok: boolean;
  /** 成功时的解析值（jsonMode 强制 + 健壮 JSON 提取之后） */
  value?: T;
  /** 失败原因（ok:false 时可有；已经 sanitizeError 密钥卫生处理） */
  error?: string;
  /** 模型回复原文（成败皆在 —— 调用方可落日志/回退解析） */
  raw: string;
  /**
   * R2-1（qwen 坐标域反算层的观测注记，可选）：'qwen-coord-rescaled' = 回执
   * bbox 已从 0-1000 归一化域反算为请求图像素系；'coord-domain-ambiguous' =
   * 回执含 bbox 节点但坐标域不可判定（家族/宽高/签名任一缺席 —— 原样透传
   * 不猜）。缺省缺席：非 qwen 路径与无 bbox 回执零影响，既有消费方不读不坏。
   */
  note?: string;
}

/** 视觉供应方统一接口 —— 一切兄弟适配器实现此契约（Ψ 的万脑插头） */
export interface VisionProvider {
  /** 供应方标识（小写短名，如 'glm'/'qwen'/'openai' —— 归因与遥测主键） */
  readonly id: string;
  /** 线协议方言 —— 决定 chat 内部的请求翻译 */
  readonly protocol: ProviderProtocol;
  /** 实际使用的模型名 */
  readonly model: string;
  /**
   * W8-A6（DEBTS D-G3）：服务端点只读暴露 —— 同平台不同端点的判别面。
   * 「两颗脑都说 openai 方言」不等于同源：自建网关 / 备选池 / 合议庭里
   * 同平台不同 baseUrl 的脑必须可区分（反驳法院剔同源脑时就靠本字段）。
   * 值为装配期定格的服务基址（绝对 URL，尾斜杠归一），与实际拨号端点一致。
   * 可选字段：尚未回填端点的适配器合法缺席（undefined ⇒ 不臆造端点），消费面
   * 回退 registry 预设缺省端点（registry.effectiveBaseUrl）。
   * 打码纪律：展示面（日志/UI/遥测）绝不直出本值 —— 必须经 maskBaseUrl
   * （host 保留、路径/查询/凭据段打码），参照 sanitizeError 的错误面纪律。
   */
  readonly baseUrl?: string;
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
  chatJson<T>(req: VisionChatRequest): Promise<VisionJsonReply<T>>;
}

/**
 * W8-A6（VLM 架构债 · 依赖倒置最小形态）：结构化视觉对话的窄端口 ——
 * grounding / vlmOcr / verdict 三器官的云端依赖面。
 *
 * 此前三处点名 GlmClient 具体类，多供应商（备选池 failover / 合议庭 ensemble /
 * 复核第二意见脑）必须经 glmClient 委托壳间接达成；现降为依赖本端口 ——
 * 任何结构满足者皆可直入：
 *   · GlmClient 天然满足（结构化兼容即可，不强行 implements —— 传入处零改动）；
 *   · VisionProvider（三厂适配器 / ensemble / failover 铸件）天然满足
 *     （多供应商直用面：备选脑不再需要包一层委托壳）；
 *   · 测试假端口只需 configured + chatJson 两件。
 * 端口面刻意收窄：只声明三器官真实消费的最小面（configured 配置哨兵 +
 * chatJson 结构化对话）；chat / 计量 / 重试等实现细节一律不进端口 ——
 * 依赖面越小，换脑越自由。请求形状 = VisionChatRequest（与 GlmVisionRequest
 * 结构同一，glmClient 侧零适配）。不改变任何运行时行为（现网仍传 GlmClient
 * 实例）。
 */
export interface StructuredVisionPort {
  /** 配置哨兵 —— false 时调用方走零网络降级臂（grounding 配置哨兵消费） */
  readonly configured: boolean;
  /** 结构化视觉对话 —— 永不抛（失败以 ok:false 表达）；回执形状与万脑插头同一 */
  chatJson<T>(req: VisionChatRequest): Promise<VisionJsonReply<T>>;
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

// ─── JSON 剥壳律（W6R-A4：单一实现收拢于 internalUtils.extractBalancedJson，
//     本导出名保留为消费面兼容的薄委托 —— 与 glmClient.extractGlmJson 同源同律） ───

/**
 * 健壮 JSON 提取（JSON 剥壳律）：剥 ```json 围栏 → 取首个平衡 {...}/[...] → parse。
 * 成功返回解析值（可为 null/false 等合法 JSON 值）；失败返回 undefined。
 * 永不抛异常 —— 入参为 null/undefined 等脏值同样安静返回 undefined。
 */
export { HTTP_STATUS_BAD_REQUEST };

export function extractProviderJson(text: string): unknown | undefined {
  return extractBalancedJson(text);
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

/**
 * W8-A6（D-G3 baseUrl 暴露的打码纪律）：端点脱敏 —— 展示面（日志/UI/遥测）
 * 输出 provider.baseUrl 前必须经过本函数（参照 sanitizeError/maskKey 的纪律：
 * 值可以丢细节，不可以泄凭据）。规则：
 *  - host（含端口、IPv6 方括号形态）保留 —— 归因与排障需要「哪台端点」
 *    （同平台不同端点的判别面恰好只剩 host 也够用）；
 *  - 路径 / 查询串 / userinfo 一律打码为 `/***` —— 路径可能嵌端点 ID/租户段
 *    （如方舟 ep-2024xxxx），查询可能带 ?key= 密钥（Gemini 方言），userinfo
 *    本身就是凭据。协议与 host 之外的任何原文绝不外泄；
 *  - 脏值（空串/非 URL/非字符串/解析故障）⇒ 安静返回 '(unknown endpoint)'
 *    （不抛、不回显原文 —— 宁可丢展示，不可泄端点细节）。
 * 绝不抛异常；输出恒可安全落日志。
 */
export function maskBaseUrl(raw: unknown): string {
  try {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (s === '') return '(unknown endpoint)';
    const u = new URL(s);
    // u.host 已归一小写、含端口与 IPv6 方括号、且天然不含 userinfo 凭据
    if (u.host === '') return '(unknown endpoint)';
    return `${u.protocol}//${u.host}/***`;
  } catch {
    return '(unknown endpoint)';
  }
}


// ─── R3-2（max_tokens 钳制泛化）：模型名键控的生成硬顶知识 ───
//
// 病灶（R1-5 实测 / R2-1 §6 登记）：glm-4v-flash 免费档对 max_tokens 有 1024
// 硬顶（超出 ⇒ HTTP 400 code 1210 直接拒单），而全链缺省生成预算是 2048
//（openai/anthropic/gemini 三适配器与 glmClient 原生路径同调）——grounding
// adaptiveMaxTokens 只抬不降（小图恒 2048）、OCR/verdict 走缺省。R1-5 时代的
// 钳制是冒烟脚本的运行时注入（StructuredVisionPort 的 client 包装），从未
// 落进 src —— failover 备脑一经点亮（R3-2 per-brain 注入 glm-4v-flash）就会
// 立刻踩中 400：failover 在线但拨号必败，等于单脑裸奔。本表把「模型家族 →
// 生成硬顶」落为单一来源，供池/合议庭铸造点（cast.ts）与 glmClient 双路
//（castDelegate 委托 + 原生路径）统一消费；非命中家族恒 null（零钳制，
// 行为逐字节不变 —— qwen3-vl-plus 实测 4096 无碍，R2-1 §4 D）。

/** R3-2: glm-4v-flash 家族（前缀命中 —— 容忍日期后缀变体如 glm-4v-flash-250414） */
const R32_GLM_FLASH_MODEL = /^glm-4v-flash/i;

/** R3-2: glm-4v-flash 免费档的 max_tokens 硬顶（R1-5 实测 400 code 1210 的界）
 *  （模块内常量 —— tokenCapForModel 单点消费，不外泄导出面） */
const R32_GLM_FLASH_TOKEN_CAP = 1024;

/**
 * R3-2: 模型名 → max_tokens 硬顶（null = 无已知硬顶，调用方零钳制）。
 * 纯查表零 I/O、绝不抛；脏模型名（非字符串/空串）⇒ null（无证据不钳制）。
 */
export function tokenCapForModel(model: unknown): number | null {
  try {
    return typeof model === 'string' && R32_GLM_FLASH_MODEL.test(model.trim())
      ? R32_GLM_FLASH_TOKEN_CAP
      : null;
  } catch {
    return null;
  }
}

/**
 * R3-2: 按模型硬顶钳制 max_tokens —— 无硬顶/已在界内/脏值 ⇒ 原值直传
 *（恒等，零行为变化）；超顶 ⇒ 取硬顶。绝不抛。消费点约定在「缺省已解析
 * 之后」调用（req.maxTokens ?? 2048 先行落定），保证 undefined 请求也被
 * 拉进界内（2048 > 1024 ⇒ 钳为 1024 —— 免费档免费的前提）。
 */
export function clampMaxTokensForModel(model: unknown, maxTokens: number): number {
  try {
    const cap = tokenCapForModel(model);
    if (cap === null) return maxTokens;
    return typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > cap
      ? cap
      : maxTokens;
  } catch {
    return maxTokens;
  }
}

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

// W6-2（doctor smell.magic-number 清偿）：可重试 HTTP 状态域常量与传输小件
// （sleep/timeoutSignal/isAbortError/safeBodyText）已收拢 internalUtils 单一
// 实现（W6R-A4 去重）—— 本文件顶部 import，此处不再各持拷贝。

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

/**
 * ΑΩ-R15（重试律单一立法）：fetchWithRetry 终败的机器可读分类 —— 消费方
 * （原生 glmClient 路径等）按类映射自家错误串，替代对错误文案的正则嗅探
 * （文案会演化，分类不会）。'network' 覆盖一切传输面终败：网络异常耗尽、
 * doFetch 不可用与理论不可达的内核内错。成功（ok:true）时缺省。
 */
export type FetchFailureKind = 'http' | 'network' | 'aborted';

/**
 * 带重试的 fetch（全适配器共享的传输底座 —— 重试律的唯一定义点）：
 *  - 仅 429/5xx/网络异常可重试；AbortError/TimeoutError（超时止损）不重试
 *  - 每次重试前回调 onRetry(attempt, reason)（attempt 为刚失败尝试的 0 起序号，
 *    与 jitterDelayMs 同参；回调自身抛错被吞 —— 不抛铁律）
 *  - 每次尝试注入独立的超时 AbortSignal（覆盖 init.signal；timeoutMs 归此函数管）
 *  - 重试间隔 = jitterDelayMs(attempt)（全抖动 500·2^n 封顶 8s）
 *  - 成功（2xx）⇒ { ok:true, status, body, attempts }
 *  - HTTP 终败 ⇒ { ok:false, status, body, error:'http <s> after <n> attempts', attempts, failureKind:'http' }
 *  - 传输终败 ⇒ { ok:false, error:'fetch failed after <n> attempts: ...', attempts, failureKind:'network' }
 *  - 超时/中止 ⇒ { ok:false, error:'request aborted after <timeoutMs>ms', attempts, failureKind:'aborted' }
 *  attempts 恒为实际发出的 fetch 次数（1 = 未重试）；绝不抛异常。
 */
export async function fetchWithRetry(opts: {
  doFetch: typeof fetch;
  url: string;
  init: RequestInit;
  maxRetries: number;
  timeoutMs: number;
  onRetry?: (attempt: number, reason: string) => void;
}): Promise<{ ok: boolean; status?: number; body?: string; error?: string; attempts: number; failureKind?: FetchFailureKind }> {
  try {
    const doFetch = typeof opts?.doFetch === 'function' ? opts.doFetch : undefined;
    if (!doFetch) {
      return { ok: false, error: 'fetch is not available (Node >= 18 required)', attempts: 0, failureKind: 'network' }; // doctor-exempt: 文案字符串，非阈值比较（W6-2）
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
          return { ok: false, error: `request aborted after ${timeoutMs}ms`, attempts: attempt + 1, failureKind: 'aborted' };
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
          failureKind: 'network',
        };
      }

      if (resp && resp.ok) {
        return { ok: true, status: resp.status, body: await safeBodyText(resp), attempts: attempt + 1 };
      }

      // 非 2xx：429/5xx 可重试，其余 4xx 立即失败（请求本身有病，重试无义）
      const status = typeof resp?.status === 'number' ? resp.status : 0;
      const retryable = status === HTTP_STATUS_TOO_MANY_REQUESTS || status >= HTTP_STATUS_SERVER_ERROR_FLOOR;
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
        failureKind: 'http',
      };
    }
  } catch (e) {
    // 不抛铁律的最终兜底（理论不可达 —— init 展开等同步面故障）
    return {
      ok: false,
      error: `fetchWithRetry internal error: ${stringifyError(e).slice(0, 200)}`,
      attempts: 1,
      failureKind: 'network',
    };
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
