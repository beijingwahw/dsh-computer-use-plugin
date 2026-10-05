// src/vlm/glmClient.ts
// W6-2 结构性保留（doctor smell.over-engineering 登记）：GLM 主脑客户端 —— 直连路径 + providers 委托 + 故障切换池 + 级联咨询围绕单一 GlmClient 单例态（计费/回退/委托同账本），核心类约半文件，其余分区均不足独立成篇。
// 纪元 Ω（Ω-1 云脑皮层）：智谱 GLM-5.3-Flash 视觉大模型客户端。
// 纯视觉架构的「云脑」外接：本地反射弧（OCR/模糊/探针）处理毫秒级确定性，
// GLM 视觉模型补上开放语义（整屏理解 / 复杂推理 / 未见过的界面形态）。
//
// 纪元 Ψ（万脑归一 · 兼容壳）：本 class 升格为多协议统一层的兼容壳 ——
// platform='glm'（缺省）时原代码路径逐字节不动（错误前缀 'glm ...' /
// meter kind 'glm.chat' / GLM 环境变量语义全部保持）；platform 指向他平台
// （或 baseUrl 识别命中他平台预设）时，内部经 providers 三厂适配器
// （openai/anthropic/gemini 方言）委托实现 chat/chatJson，结果映射回
// GlmChatResult 形状（附 providerId 归因，error 用适配器串）。
// 全平台视觉模型由此点亮整套系统（ask_screen / grounding / semanticConfirm
// 兜底 / autonomy —— 消费面零改动）。
//
// 纪元 P2a（VLM 栈加固 · P2a-1 单例-池贯通）：chat/chatJson 在自身重试全败后、
// 返回 ok:false 之前咨询注入的故障切换池（attachFailoverPool —— 宿主 configureVlm
// 铸池后接线）。备脑救回 ⇒ 整流结果附 providerId 归因 + note:'failover'；池缺席
// （缺省，大多数既有测试形态）/ 空池 / 池全败 ⇒ 失败路径与返回值逐字节不变
// （零回归红律）。注入采用结构化契约而非直接 import providers/failover —— 杜绝环引。
//
// 设计铁律（与全仓一致）：
//   1. 永不抛异常 —— 一切失败以返回值 ok:false 表达（运行层零异常上抛）
//   2. 零新增依赖 —— Node 18+ 内置 fetch + AbortSignal.timeout；测试经
//      fetchImpl 注入假 fetch（绝不真实联网）
//   3. 降级诚实 —— 未配置 apiKey 时返回 degraded:true（调用方降级为
//      本地认知路径，而非崩溃）
//   4. 可观测 —— 每次调用（含重试后的最终结果）经 meter 回调上报
//   5. 缺省即兼容 —— 无新配置/新环境时行为与 Ω 纪元逐字节等同（缺省=GLM 路径）
//
// 协议：智谱开放平台 OpenAI 兼容 —— POST {baseUrl}/chat/completions，
// Bearer 鉴权，多模态 user content = [text part, image_url parts...]。

import { createAnthropicProvider } from './providers/anthropic';
import { createGeminiProvider } from './providers/gemini';
import { createOpenAiProvider } from './providers/openai';
// R3-2：铸造点共享件 —— 模型硬顶包装（glm-4v-flash 家族 max_tokens ≤1024）
import { wrapModelTokenCap } from './providers/cast';
import { detectPresetFromBaseUrl, detectPresetFromEnv, getPreset } from './providers/registry';
import { clampMaxTokensForModel, fetchWithRetry, sanitizeError } from './providers/types';
import type { ProviderMeterRecord, VisionChatRequest, VisionProvider } from './providers/types';
// W6R-A4（工具去重）：传输小件 / JSON 剥壳律 / 可重试状态常量收拢 internalUtils
// 单一实现 —— 本模块不再自持拷贝。ΑΩ-R15（重试律单一立法）：传输重试循环
// 整体退役 —— 原生 GLM 路径全权委托 providers/types.fetchWithRetry（与三厂
// 适配器同源同律），jitter 退避 / 超时信号 / 中止判定等重试小件不再被本模块
// 引用，仅剩 JSON 剥壳律（extractGlmJson 的底座）。
import { extractBalancedJson, HTTP_STATUS_TOO_MANY_REQUESTS } from './internalUtils';

/** 视觉输入：裸 base64（不带 data: 前缀）+ 可选 mime（默认 image/jpeg） */
export interface GlmImageInput {
  base64: string;
  /** MIME 类型 —— 拼进 data URL：`data:{mime};base64,{base64}` */
  mime?: string;
}

/** 一次视觉对话请求（参数全部可选除 images/prompt，缺省值见字段注释） */
export interface GlmVisionRequest {
  /** 截图序列（至少一帧才有视觉语义；空数组 = 纯文本对话，协议上合法） */
  images: GlmImageInput[];
  /** 系统提示词 —— 缺省不发送 system 消息 */
  system?: string;
  /** 用户指令（与截图一起进 user 消息） */
  prompt: string;
  /** 最大生成 token 数 —— 默认 2048 */
  maxTokens?: number;
  /** 采样温度 —— 默认 0.1（桌面自动化要确定性，不要发散） */
  temperature?: number;
  /** true 时请求 response_format:{type:'json_object'}（结构化输出模式） */
  jsonMode?: boolean;
  /** 单次 fetch 尝试的超时（毫秒）—— 默认 30000，AbortSignal.timeout 实现 */
  timeoutMs?: number;
  /** 重试次数上限 —— 默认 2；仅对 429/5xx/网络错误重试，全抖动指数退避
   *  （基 500ms、每尝试翻倍、上限 8s）。超时（AbortError）不重试 ——
   *  超时属于调用方主动止损，静默重试只会放大尾延迟。 */
  maxRetries?: number;
}

/** chat 调用结果 —— ok:false 时 text 恒为 ''（绝不部分成功） */
export interface GlmChatResult {
  ok: boolean;
  /** 模型回复正文（choices[0].message.content） */
  text: string;
  /** jsonMode 下成功提取的 JSON 值（提取失败则缺省 —— 判失败请用 chatJson） */
  json?: unknown;
  /** token 用量（服务端未上报则缺省） */
  usage?: { promptTokens?: number; completionTokens?: number };
  /** 整次调用（含全部重试）的墙钟延迟 */
  latencyMs: number;
  /** 实际使用的模型名（配置解析后） */
  model: string;
  /** 供应方标识 —— 委托路径（非 glm 平台）附带适配器归因；glm 路径恒缺省 */
  providerId?: string;
  /** 失败原因（ok:false 时必有） */
  error?: string;
  /** 降级标记 —— true = 未配置 apiKey（调用方应走本地认知降级路径） */
  degraded?: boolean;
  /** 切换备注（P2a-1）—— 'failover' = 本结果来自故障切换池的备脑（providerId
   *  标注来源脑）；主脑直连路径恒缺省（不接线池时返回值逐字段不变）。
   *  ΝΩ-18：'rate-limited' 族 = 服务端 429 终败经限流闸回填后的等待提示
   * （如 'rate-limited by server (429); retry after 60000ms'）。 */
  note?: string;
}

/** meter 上报记录 —— 云脑用量遥测（Ω 纪元观测面） */
export interface GlmMeterRecord {
  ts: number;
  /** 记录种类 —— glm 路径恒为 'glm.chat'；委托路径为 `${platform}.chat` */
  kind: string;
  model: string;
  latencyMs: number;
  ok: boolean;
  promptTokens?: number;
  completionTokens?: number;
  error?: string;
}

/** 客户端构造选项 —— 一切可注入（测试的假 fetch / 宿主的 meter 都从这里进） */
export interface GlmClientOptions {
  /** API Key —— 优先于环境变量；env 次序 GLM_API_KEY > ZHIPUAI_API_KEY > ZAI_API_KEY
   *  （glm 路径）；委托路径回退该平台预设的 envKeys 序列 */
  apiKey?: string;
  /** OpenAI 兼容基址 —— 默认 https://open.bigmodel.cn/api/paas/v4（env GLM_BASE_URL；
   *  委托路径缺省取平台预设基址。识别命中他平台预设时自动切换平台） */
  baseUrl?: string;
  /** 模型名 —— 默认 'glm-5.3-flash'（env GLM_VLM_MODEL；委托路径缺省取平台预设模型） */
  model?: string;
  /** 平台 id —— 显式指定供应方（glm/openai/anthropic/gemini/qwen/moonshot/doubao/
   *  xai/siliconflow/openrouter/ollama/lmstudio/vllm；未知名按 OpenAI 兼容 custom 接入）。
   *  优先于 baseUrl 识别；'glm' 或缺省 = 原生 GLM 路径（行为逐字节等同 Ω 纪元） */
  platform?: string;
  /** fetch 实现 —— 缺省用全局 fetch；测试注入假实现，绝不真实联网 */
  fetchImpl?: typeof fetch;
  /** 用量/延迟遥测回调 —— 每次 chat 调用（含降级失败）恰好上报一条 */
  meter?: (rec: GlmMeterRecord) => void;
}

const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_MODEL = 'glm-5.3-flash';
const METER_KIND = 'glm.chat';

/** 环境变量 apiKey 解析 —— GLM_API_KEY > ZHIPUAI_API_KEY > ZAI_API_KEY（三方历史命名兼容） */
function envApiKey(): string {
  return (process.env.GLM_API_KEY || process.env.ZHIPUAI_API_KEY || process.env.ZAI_API_KEY || '').trim();
}

// W6R-A4（工具去重）：jitterDelayMs / timeoutSignal / isAbortError / stripFences /
// scanBalanced / safeBodyText / sleep / 可重试状态常量的原本地拷贝已删除 ——
// 单一实现见 internalUtils（传输小件与剥壳律）与 providers/types.jitterDelayMs
// （防御版导出）。ΑΩ-R15 起重试循环本身也退役（fetchWithRetry 全权接管），
// 上述传输小件不再被本模块直接引用。全抖动退避语义不变：
// attempt 从 0 起 delay ∈ [0, min(500·2^attempt, 8000))。

/** 错误信息提取（网络异常的 code/message 归并，供 error 字符串） */
function errText(e: unknown): string {
  const anyE = e as { code?: string; message?: string; cause?: { code?: string } } | null;
  const code = anyE?.cause?.code ?? anyE?.code ?? '';
  return `${code} ${anyE?.message ?? String(e)}`.trim();
}

/** 健壮 JSON 提取：剥 ```json 围栏 → 取首个平衡 {...}/[...] → parse。
 *  成功返回解析值（可为 null/false 等合法 JSON 值）；失败/脏值返回 undefined。
 *  W6R-A4：薄委托 internalUtils.extractBalancedJson（与 providers/
 *  extractProviderJson 同源同律 —— 脏值安静返回 undefined 的不抛铁律统一）。 */
export function extractGlmJson(text: string): unknown | undefined {
  return extractBalancedJson(text);
}

/** 响应 content 提取 —— choices[0].message.content；数组方言（parts）防御兼容 */
function extractContent(payload: unknown): string | null {
  const c = (payload as { choices?: { message?: { content?: unknown } }[] } | null)
    ?.choices?.[0]?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map(p => (typeof p === 'string' ? p : (p as { text?: string } | null)?.text ?? '')).join('');
  }
  return null;
}

/** usage 映射 —— prompt_tokens/completion_tokens → promptTokens/completionTokens；
 *  至少一个为有限数才产出对象（服务端缺省 usage 时不下发空壳）。 */
function mapUsage(u: unknown): { promptTokens?: number; completionTokens?: number } | undefined {
  const o = u as { prompt_tokens?: unknown; completion_tokens?: unknown } | null;
  const pt = Number(o?.prompt_tokens);
  const ct = Number(o?.completion_tokens);
  const has = (n: number) => Number.isFinite(n) && n >= 0;
  if (!o || (!has(pt) && !has(ct))) return undefined;
  return {
    ...(has(pt) ? { promptTokens: pt } : {}),
    ...(has(ct) ? { completionTokens: ct } : {}),
  };
}

// ─── 纪元 Ψ：委托路径（非 glm 平台经 providers 三厂适配器铸造） ───

/** 平台 id 归一：trim + 小写；非字符串/脏值安静归 '' */
function normalizePlatform(v: unknown): string {
  try {
    return typeof v === 'string' ? v.trim().toLowerCase() : '';
  } catch {
    return '';
  }
}

/** 按预设 envKeys 序列取首个非空环境变量（委托路径的 apiKey env 回退） */
function platformEnvApiKey(keys: readonly string[]): string {
  for (const name of keys) {
    try {
      const v = process.env[name];
      if (typeof v === 'string' && v.trim() !== '') return v.trim();
    } catch { /* env 访问故障 —— 视为该变量未设置 */ }
  }
  return '';
}

// ─── R2-1：qwen3-vl 系 0-1000 归一化坐标域反算层 ───
//
// 实战背景（R1-9 实弹）：Qwen3-VL 系（含 qwen2/2.5-vl 家族）**原生输出 0-1000
// 归一化整数坐标，且会在文本里谎称「图片像素」**——插件 grounding/OCR 器按
// 提示词声明的像素系原样消费（vlm:as-is），640×400 合成按钮上实测中心偏差
// 273px/IoU=0（比 glm 免费档 102.6px 还差）。修正法（R1-9 裸探针验证）：
// 按请求图实际宽高把 bbox ×(W/1000, H/1000) 反算回像素系 —— 同一张样张
// 反算后中心误差 1.9px/IoU 0.94（生产级）。本层在 qwen 委托脑的 chatJson
// 出口执行该反算；glm 原生路径与其余平台不经本包装（真像素，零影响）。
//
// 灰度安全律：模型家族（qwen[23]-vl 文档化 0-1000 域）、请求图宽高（PNG
// IHDR/JPEG SOF 解析）、节点签名（4 坐标全为 [0,1000] 整数）三者齐备才反算；
// 任一缺席且回执确含 bbox 节点 ⇒ note 'coord-domain-ambiguous' 原样透传
// （诚实标注，绝不猜域）。反算生效 ⇒ note 'qwen-coord-rescaled'（可观测）。

/** R2-1: qwen[23]-vl 系模型名判定 —— 文档化 0-1000 归一化坐标输出家族 */
const R21_QWEN_VL_MODEL = /qwen[23](?:\.\d+)?-vl/i;

/** R2-1 遍历深度上限（elements→[{bbox:[…]}] 仅 3 层；防深巢/环兜底） */
const R21_MAX_DEPTH = 8;

/** R2-1: 请求首图像素宽高解析（PNG IHDR / JPEG SOF 段扫描）—— 失败 null，绝不抛 */
function r21ImageDims(imgs: readonly unknown[] | undefined): { width: number; height: number } | null {
  try {
    const b64 = (imgs as ReadonlyArray<{ base64?: unknown }> | undefined)?.[0]?.base64;
    if (typeof b64 !== 'string' || b64.length < 32) return null;
    // 只解码头部（base64 前 88000 字符 = 二进制 66000 字节，4 对齐）：PNG IHDR
    // 固定在偏移 16；JPEG SOF 位于量化/哈夫曼表之后，屏幕截图量级恒在前 64KB
    const b = Buffer.from(b64.slice(0, 88_000), 'base64');
    if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      const w = b.readUInt32BE(16);
      const h = b.readUInt32BE(20);
      return w >= 1 && h >= 1 ? { width: w, height: h } : null;
    }
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m === 0x01 || m === 0xd8 || (m >= 0xd0 && m <= 0xd9)) { i += 2; continue; }
        const seg = b.readUInt16BE(i + 2);
        // SOF0..SOF15 除 JPG 系（C4/C8/CC）外皆载宽高（baseline/progressive 全覆盖）
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          const h = b.readUInt16BE(i + 5);
          const w = b.readUInt16BE(i + 7);
          return w >= 1 && h >= 1 ? { width: w, height: h } : null;
        }
        if (seg < 2) return null; // 段长非法 —— 头部脏，诚实放弃
        i += 2 + seg;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** R2-1: bbox 四元组提取 —— [x0,y0,x1,y1] 数组或 {x0,y0,x1,y1} 对象（器官双方言） */
function r21Quad(v: unknown): [number, number, number, number] | null {
  if (Array.isArray(v)) {
    if (v.length !== 4 || !v.every(n => typeof n === 'number' && Number.isFinite(n))) return null;
    return [v[0], v[1], v[2], v[3]];
  }
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const ns = [o.x0, o.y0, o.x1, o.y1];
    if (!ns.every(n => typeof n === 'number' && Number.isFinite(n))) return null;
    return ns as [number, number, number, number];
  }
  return null;
}

/** R2-1: 0-1000 整数域签名 —— qwen3-vl 系回执坐标的判别特征（R1-9 实测形态） */
function r21ThousandDomain(q: readonly number[]): boolean {
  return q.every(n => Number.isInteger(n) && n >= 0 && n <= 1000);
}

/** R2-1: 就地反算写回（数组/对象双形态）；dry=true 只探测不改（灰度安全） */
function r21Apply(target: unknown, q: readonly number[], sx: number, sy: number, dry: boolean): void {
  if (dry) return;
  const v = [q[0] * sx, q[1] * sy, q[2] * sx, q[3] * sy];
  if (Array.isArray(target)) {
    for (let i = 0; i < 4; i++) target[i] = v[i];
  } else {
    const o = target as Record<string, unknown>;
    o.x0 = v[0]; o.y0 = v[1]; o.x1 = v[2]; o.y1 = v[3];
  }
}

/**
 * R2-1: 深度受限遍历 —— 对每个 bbox 节点（'bbox' 键下的四元组，或直接携带
 * x0/y0/x1/y1 的对象，与 grounding/OCR 提示词方言对齐）做域判定与反算。
 * acc：touched=发现过 bbox 节点；rescaled=反算节点数；offDomain=签名不过数。
 */
function r21Walk(node: unknown, sx: number, sy: number, dry: boolean, depth: number,
  acc: { touched: boolean; rescaled: number; offDomain: number }): void {
  if (depth > R21_MAX_DEPTH || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) r21Walk(child, sx, sy, dry, depth + 1, acc);
    return;
  }
  const o = node as Record<string, unknown>;
  const holder = o.bbox !== undefined ? o.bbox : (o.x0 !== undefined ? o : undefined);
  const q = holder !== undefined ? r21Quad(holder) : null;
  if (q !== null) {
    acc.touched = true;
    if (r21ThousandDomain(q)) {
      r21Apply(holder, q, sx, sy, dry);
      if (!dry) acc.rescaled++;
    } else {
      acc.offDomain++;
    }
  }
  for (const child of Object.values(o)) r21Walk(child, sx, sy, dry, depth + 1, acc);
}

/**
 * R2-1: qwen 委托脑坐标域包装 —— 只包 chatJson（chat 纯文本路径无坐标可修）。
 * 三门齐开（家族 + 宽高 + 逐节点 0-1000 签名）⇒ 反算为请求图像素系；任一
 * 缺席且回执含 bbox ⇒ 'coord-domain-ambiguous' 原样透传（不猜）。绝不抛、
 * 绝不改 ok/error/raw；ok:false 回执零接触。
 */
function wrapQwenCoordDomain(inner: VisionProvider): VisionProvider {
  return {
    ...inner,
    async chatJson<T>(req: VisionChatRequest) {
      const res = await inner.chatJson<T>(req);
      if (!res.ok || res.value === null || typeof res.value !== 'object') return res;
      try {
        const dims = r21ImageDims(req.images);
        const dry = !(dims !== null && R21_QWEN_VL_MODEL.test(inner.model));
        const acc = { touched: false, rescaled: 0, offDomain: 0 };
        r21Walk(res.value, dims ? dims.width / 1000 : 0, dims ? dims.height / 1000 : 0, dry, 0, acc);
        if (acc.rescaled > 0) return { ...res, note: 'qwen-coord-rescaled' };
        if (acc.touched) return { ...res, note: 'coord-domain-ambiguous' };
        return res;
      } catch {
        return res; // 反算面自身故障 ⇒ 原样透传（不抛铁律；宁可不修，不可修错）
      }
    },
  };
}

/**
 * 铸造委托适配器 —— 按平台预设的线协议分派三厂之一（providers 单一来源）：
 *  - apiKey：options 显式 > 平台预设 envKeys 序列（GLM 环境变量不外溢到他平台）；
 *  - baseUrl/model：options 显式 > 平台预设缺省（传 default* 形态，保住适配器
 *    自身的平台 env 回退链，如 ANTHROPIC_BASE_URL/ANTHROPIC_MODEL）；
 *  - meter：ProviderMeterRecord 映射回 GlmMeterRecord（kind 透传 —— 他平台即
 *    `${platform}.chat`；适配器已保证恰好一条/调用与回调故障静默）；
 *  - 未知名平台（registry 查无）按 OpenAI 兼容 custom 端点接入（providerId 用
 *    该名，协议取 openai 方言）—— 与 registry 的 custom 合成预设同律。
 */
function castDelegate(platform: string, options: GlmClientOptions): VisionProvider {
  const preset = getPreset(platform);
  const id = preset?.id ?? platform;
  const apiKey = (options.apiKey ?? '').trim() || (preset ? platformEnvApiKey(preset.envKeys) : '');
  const baseUrlOpt = (options.baseUrl ?? '').trim().replace(/\/+$/, '');
  const modelOpt = (options.model ?? '').trim();
  const config = {
    id,
    apiKey,
    ...(baseUrlOpt !== '' ? { baseUrl: baseUrlOpt } : {}),
    ...(modelOpt !== '' ? { model: modelOpt } : {}),
    ...(preset ? { defaultBaseUrl: preset.baseUrl, defaultModel: preset.defaultModel } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.meter
      ? {
          meter: (rec: ProviderMeterRecord): void => {
            try {
              options.meter!({
                ts: rec.ts,
                kind: rec.kind,
                model: rec.model,
                latencyMs: rec.latencyMs,
                ok: rec.ok,
                ...(rec.promptTokens !== undefined ? { promptTokens: rec.promptTokens } : {}),
                ...(rec.completionTokens !== undefined ? { completionTokens: rec.completionTokens } : {}),
                ...(rec.error !== undefined ? { error: rec.error } : {}),
              });
            } catch { /* 遥测故障静默 —— 主结果已定 */ }
          },
        }
      : {}),
  };
  switch (preset?.protocol) {
    case 'anthropic':
      // R3-2：主脑委托路径同过模型硬顶包装（glm-4v-flash 直配主脑不再 400）
      return wrapModelTokenCap(createAnthropicProvider(config));
    case 'gemini':
      return wrapModelTokenCap(createGeminiProvider(config));
    case 'openai':
    default: {
      const provider = createOpenAiProvider(config);
      // R2-1: qwen 预设（DashScope）挂 0-1000 归一化坐标域反算层 —— qwen3-vl
      // 系回执 bbox 按请求图实际宽高反算为像素系（grounding 实战精度的破局
      // 点，见本文件 R2-1 节注释）；其余 openai 方言平台与 glm 原生路径零影响
      // R3-2：包装序 —— 硬顶钳制（请求前置）在外，坐标反算（回执后置）在内，
      // 两面互不接触（一个改 maxTokens，一个改 bbox）
      return wrapModelTokenCap(preset?.id === 'qwen' ? wrapQwenCoordDomain(provider) : provider);
    }
  }
}

/**
 * VisionChatResult → GlmChatResult 映射 —— 委托路径的结果整流：
 * providerId 附带归因；usage/json/error/degraded 条件展开（缺场不产空壳）。
 */
function toGlmResult(res: {
  ok: boolean; text: string; latencyMs: number; model: string; providerId: string;
  json?: unknown; usage?: { promptTokens?: number; completionTokens?: number };
  error?: string; degraded?: boolean;
}): GlmChatResult {
  const out: GlmChatResult = {
    ok: res.ok,
    text: res.text,
    latencyMs: res.latencyMs,
    model: res.model,
    providerId: res.providerId,
    ...(res.json !== undefined ? { json: res.json } : {}),
    ...(res.usage !== undefined ? { usage: res.usage } : {}),
    ...(res.error !== undefined ? { error: res.error } : {}),
    ...(res.degraded !== undefined ? { degraded: res.degraded } : {}),
  };
  return out;
}

// ─── 纪元 P2a-1（单例-池贯通）：故障切换池注入面 ───

/**
 * 故障切换池的最小结构契约（P2a-1）—— 注入而非 import providers/failover：
 * glmClient 已是 providers 三厂适配器的下游（构造期 castDelegate），直接回引
 * failover 会把 providers 子图织回本模块（环引风险 + 依赖方向反转）；本接口
 * 只声明咨询面需要的两件东西，providers/failover 的 ProviderPool 天然结构满足
 * （size = 池内脑数；chat = 按池序尝试首个健康脑 —— 未配置跳过、熔断 open 跳行）。
 */
export interface GlmFailoverPool {
  /** 池内脑数（0 = 空池 —— 咨询直接跳过，等价无池） */
  readonly size: number;
  /** 按池序尝试首个健康脑 —— 返回 VisionChatResult 形状（providerId 归因） */
  chat(req: GlmVisionRequest): Promise<{
    ok: boolean; text: string; latencyMs: number; model: string; providerId: string;
    json?: unknown; usage?: { promptTokens?: number; completionTokens?: number };
    error?: string; degraded?: boolean;
  }>;
}

/** 模块级故障切换池 —— 宿主铸池后注入（vlm/index 的 configureVlm 接线）；
 *  null = 未接线（缺省 —— 单例失败路径与既往逐字节一致，零回归红律） */
let failoverPool: GlmFailoverPool | null = null;

/**
 * 注入/摘除故障切换池（P2a-1）—— 传 null 摘除；垃圾输入（非对象/无 chat 函数）
 * 安静归 null（不抛铁律）。重复调用以最后一次为准（幂等）。
 */
export function attachFailoverPool(pool: GlmFailoverPool | null): void {
  failoverPool = pool && typeof pool === 'object' && typeof pool.chat === 'function' ? pool : null;
}

// ─── W2-8（C2 成本级联路由）：级联咨询面 ───

/**
 * W2-8：成本级联路由的结构化咨询契约 —— 注入而非 import providers/cascade
 * （与 GlmFailoverPool 同律：本模块是 providers 适配器的下游，回引 cascade 会
 * 反转依赖方向）。providers/cascade 的 VlmCascade.runJson 天然结构满足本面
 * （宿主接线：`attachCascadeFace({ consultJson: (req) => cascade.runJson(req) })`）。
 *
 * 咨询律（chatJson 入口最先咨询）：
 *  - 返回 null = 级联弃权（高危直行主力 / 池无便宜档 / 无分诊因子 / 无校验
 *    谓词 / 内部故障）⇒ 本类原路径照走，行为与未接线逐字节一致；
 *  - 返回非 null = 级联已承接（便宜档过检直采，或升级主力重做 —— 含诚实
 *    失败）⇒ 本类直接整流该结果，不再走自身请求路径；
 *  - 咨询面自身抛错 ⇒ 视为弃权（不抛铁律），主路径照走。
 */
export interface GlmCascadeFace {
  /** 结构化咨询：承接 ⇒ {ok, value?, error?, raw}；弃权 ⇒ null */
  consultJson(req: GlmVisionRequest): Promise<{
    ok: boolean;
    value?: unknown;
    error?: string;
    raw: string;
  } | null>;
}

/** 模块级级联咨询面 —— 宿主接线注入（缺省 null = 未接线，零行为变化律） */
let cascadeFace: GlmCascadeFace | null = null;

/**
 * W2-8：注入/摘除级联咨询面 —— 传 null 摘除；垃圾输入（非对象/无 consultJson
 * 函数）安静归 null（不抛铁律）。重复调用以最后一次为准（幂等）。
 */
export function attachCascadeFace(face: GlmCascadeFace | null): void {
  cascadeFace =
    face && typeof face === 'object' && typeof (face as { consultJson?: unknown }).consultJson === 'function'
      ? face
      : null;
}

// ─── ΝΩ-18（限流器接线）：VlmRateLimiter 前置闸 ───

/**
 * ΝΩ-18：限流器的最小结构契约 —— 注入而非 import metering.VlmRateLimiter
 *（与 GlmFailoverPool/GlmCascadeFace 同律：结构满足即可，杜绝模块耦合）。
 * metering.VlmRateLimiter 天然满足（tryAcquire 双桶滑动窗 + ΝΩ-18 的
 * recordServer429 服务端 429 回填面，后者可选 —— 缺席时回填跳过）。
 */
export interface GlmRateLimitGate {
  /** 尝试获取配额：获批入账放行；被拒不占配额并给出 retryAfterMs */
  tryAcquire(now?: number): { allowed: boolean; retryAfterMs: number };
  /** 服务端 429 回填（可选面）：把一次服务端限流终败记作本地已用配额，返回等待提示 ms */
  recordServer429?(now?: number): number;
}

/** 模块级限流闸 —— 宿主接线注入（vlm/index 的 configureVlm 或直接 attachVlmRateLimiter）；
 *  null = 未接线（缺省 —— chat/chatJson 行为与既往逐字节一致，零回归红律） */
let vlmRateGate: GlmRateLimitGate | null = null;

/**
 * ΝΩ-18：注入/摘除限流闸 —— 传 null 摘除；垃圾输入（非对象/无 tryAcquire 函数）
 * 安静归 null（不抛铁律）。重复调用以最后一次为准（幂等）。接线后 chat/chatJson
 * 前置 tryAcquire：被拒 ⇒ ok:false 归因 rate-limited（不重试、不咨询级联/池、
 * 零网络）；服务端 429 终败经 recordServer429 回填本地桶并把 retryAfterMs 提示
 * 写进错误 note。
 */
export function attachVlmRateLimiter(gate: GlmRateLimitGate | null): void {
  vlmRateGate =
    gate && typeof gate === 'object' && typeof (gate as { tryAcquire?: unknown }).tryAcquire === 'function'
      ? gate
      : null;
}

/**
 * ΝΩ-18：限流前置探测 —— 被拒 ⇒ 返回等待毫秒数（≥0）；放行/未接线 ⇒ null。
 * 敌意闸上抛 ⇒ 视为未接线放行（fail-open：限流是护栏不是命门，闸自身故障
 * 不得阻断主路径 —— 与未接线的缺省行为同形）；绝不抛。
 */
function rateGateDenyMs(): number | null {
  const gate = vlmRateGate;
  if (gate === null) return null;
  try {
    const r = gate.tryAcquire();
    if (r !== null && typeof r === 'object' && (r as { allowed?: unknown }).allowed === false) {
      const ms = Number((r as { retryAfterMs?: unknown }).retryAfterMs);
      return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms) : 0;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * ΝΩ-18：服务端 429 回填 —— 把终败的 429 记作本地已用配额（本地桶收紧，下一次
 * tryAcquire 被拒并给出诚实 retryAfterMs，而非再烧一次真实 429 往返），返回
 * 回填后的等待提示 ms（未接线/闸无回填面/故障 ⇒ 0）。绝不抛。
 */
function backfillServer429(): number {
  const gate = vlmRateGate;
  if (gate === null || typeof gate.recordServer429 !== 'function') return 0;
  try {
    const ms = Number(gate.recordServer429());
    return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms) : 0;
  } catch {
    return 0;
  }
}

/** ΝΩ-18：限流拒绝的错误串（glm 路径与委托路径共用 `${platformId}` 前缀形态） */
function rateLimitError(platformId: string, retryAfterMs: number): string {
  return `${platformId} rate limited (retry after ${retryAfterMs}ms)`;
}

/**
 * W2-8：咨询级联面 —— chatJson 的最前置闸。承接 ⇒ 整流为 chatJson 形状返回；
 * 弃权/面故障 ⇒ null（主路径照走）。绝不抛。
 */
async function consultCascadeFace<T>(req: GlmVisionRequest): Promise<{
  ok: boolean;
  value?: T;
  error?: string;
  raw: string;
} | null> {
  const face = cascadeFace;
  if (face === null) return null;
  try {
    const r = await face.consultJson(req);
    if (r === null || r === undefined) return null; // 弃权
    if (typeof r !== 'object') return null; // 敌意返回 —— 视为弃权
    const ok = (r as { ok?: unknown }).ok === true;
    if (ok && r.value === undefined) {
      // ok:true 却无值（敌意/违约面）—— 从 raw 自行剥壳补齐；剥不出 ⇒ 弃权
      const salvaged = extractGlmJson(typeof r.raw === 'string' ? r.raw : '');
      if (salvaged === undefined) return null;
      return { ok: true, value: salvaged as T, raw: typeof r.raw === 'string' ? r.raw : '' };
    }
    return {
      ok,
      ...(ok && r.value !== undefined ? { value: r.value as T } : {}),
      ...(!ok && typeof r.error === 'string' && r.error !== '' ? { error: r.error } : {}),
      raw: typeof r.raw === 'string' ? r.raw : '',
    };
  } catch {
    return null; // 咨询面故障 ⇒ 弃权（不抛铁律）
  }
}

/**
 * 咨询故障切换池（P2a-1）—— 单例自身重试全败后的备脑切换面：
 *  - 池缺席 / 空池（size ≤ 0）/ size 读取抛错 ⇒ null（调用方走原失败路径，逐字节不变）；
 *  - 池按序全败（ok:false）或违约上抛 ⇒ null（保留主脑失败现场 —— 不用池的失败覆盖归因）；
 *  - 池救回（ok:true）⇒ 整流回 GlmChatResult 形状：providerId 标注备脑来源、
 *    note:'failover'、latencyMs/model 取备脑自报值；计量由池内适配器自报
 *    （铸造路径即 vlmMeterTap —— 主脑失败一条 + 备脑成功一条，各记各的诚实账，
 *    本函数不重复上报）。
 */
async function consultFailoverPool(req: GlmVisionRequest): Promise<GlmChatResult | null> {
  const pool = failoverPool;
  if (!pool) return null;
  let size = 0;
  try {
    size = Number(pool.size);
  } catch {
    return null; // 敌意 getter —— 视为不可咨询
  }
  if (!Number.isFinite(size) || size <= 0) return null;
  try {
    const res = await pool.chat(req);
    if (!res || (res as { ok?: unknown }).ok !== true) return null; // 池全败 ⇒ 原失败路径
    const r = res as Partial<GlmChatResult>;
    const out = toGlmResult({
      ok: true,
      text: typeof r.text === 'string' ? r.text : '',
      latencyMs: Number.isFinite(r.latencyMs) ? (r.latencyMs as number) : 0,
      model: typeof r.model === 'string' && r.model !== '' ? r.model : 'failover',
      providerId: typeof r.providerId === 'string' && r.providerId !== '' ? r.providerId : 'failover',
      ...(r.json !== undefined ? { json: r.json } : {}),
      ...(r.usage !== undefined ? { usage: r.usage } : {}),
    });
    out.note = 'failover';
    return out;
  } catch {
    return null; // 池违约上抛 —— 收敛为原失败路径（不抛铁律）
  }
}

/**
 * GLM 视觉对话客户端 —— 无状态、线程安全（每次 chat 独立请求）。
 * 构造期快照配置（options > 环境变量），之后环境变量变更不回读 ——
 * 想重读环境请 reset 单例后重建（测试依赖此确定性）。
 *
 * 纪元 Ψ 兼容壳：平台解析「options.platform 显式 > baseUrl 识别命中非 glm
 * 预设 > 缺省 'glm'」。'glm' ⇒ 原生路径（Ω 纪元行为逐字节等同）；他平台 ⇒
 * 内部经 providers 适配器委托实现（chat/chatJson），结果整流回本类契约形状。
 */
export class GlmClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly meter: ((rec: GlmMeterRecord) => void) | undefined;
  /** 生效平台 id（'glm' 或委托平台；探测/报告面消费） */
  private readonly platformId: string;
  /** 委托适配器 —— 非 glm 平台时非空；glm 路径恒 null */
  private readonly delegate: VisionProvider | null;

  constructor(options: GlmClientOptions = {}) {
    // 平台解析（纪元 Ψ）：显式 platform > baseUrl 识别命中非 glm > 缺省 'glm'
    let platform = normalizePlatform(options.platform);
    if (platform === '') {
      const hinted = detectPresetFromBaseUrl((options.baseUrl ?? '').trim());
      if (hinted !== null && hinted.id !== 'glm') platform = hinted.id;
    }
    this.platformId = platform === '' ? 'glm' : platform;

    if (this.platformId !== 'glm') {
      // 委托路径：配置经平台预设解析（apiKey 的 env 回退用平台自己的 envKeys）
      this.delegate = castDelegate(this.platformId, options);
      this.apiKey = '';
      this.baseUrl = '';
      this.model = '';
    } else {
      // 原生 GLM 路径 —— 配置解析优先级：构造 options > 环境变量 > 内置缺省
      this.delegate = null;
      this.apiKey = (options.apiKey ?? envApiKey()).trim();
      this.baseUrl = (options.baseUrl ?? process.env.GLM_BASE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
      this.model = (options.model ?? process.env.GLM_VLM_MODEL ?? DEFAULT_MODEL).trim();
    }
    this.fetchImpl = options.fetchImpl;
    this.meter = options.meter;
  }

  /** apiKey 是否已配置（未配置 ⇒ chat 走 degraded 降级臂；本地平台由适配器判定） */
  get configured(): boolean {
    return this.delegate !== null ? this.delegate.configured === true : this.apiKey.length > 0;
  }

  /** 生效平台 id —— 'glm' 或委托平台（vlm_platforms 报告面消费） */
  get platform(): string {
    return this.platformId;
  }

  /** meter 上报 —— 回调自身抛错不得影响主路径（不抛铁律的最后一块拼图） */
  private report(res: GlmChatResult): void {
    if (!this.meter) return;
    try {
      this.meter({
        ts: Date.now(),
        kind: METER_KIND,
        model: res.model,
        latencyMs: res.latencyMs,
        ok: res.ok,
        ...(res.usage?.promptTokens !== undefined ? { promptTokens: res.usage.promptTokens } : {}),
        ...(res.usage?.completionTokens !== undefined ? { completionTokens: res.usage.completionTokens } : {}),
        ...(res.error !== undefined ? { error: res.error } : {}),
      });
    } catch { /* 遥测故障静默 —— 主结果已定 */ }
  }

  /**
   * 视觉对话 —— 永不抛错。
   *
   * - 未配置 apiKey ⇒ { ok:false, degraded:true }（调用方降级为本地认知）
   * - 429/5xx/网络错误 ⇒ 全抖动指数退避重试（默认 2 次）；超时不重试
   * - 成功 ⇒ text + usage + latencyMs；jsonMode 下附 json（提取失败仅缺省字段）
   * - 每次调用（无论成败）恰好上报一条 meter 记录
   * - ΝΩ-18（限流器接线）：接线限流闸时前置 tryAcquire —— 被拒 ⇒ ok:false
   *   归因 rate-limited（不重试、不咨询故障切换池、零网络；meter 仍恰一条）；
   *   服务端 429 终败经 recordServer429 回填本地桶，retryAfterMs 提示进 note。
   */
  async chat(req: GlmVisionRequest): Promise<GlmChatResult> {
    // ΝΩ-18：限流前置闸 —— 覆盖原生与委托两路（置于委托分派之前）；被拒不重试
    //（配额等待不是传输抖动，退避重试只会加剧超支）、不咨询池（池内备脑同享
    // 全局预算，救回即绕闸）。chatJson 的结构化路径经 chatCore 复用本闸语义
    //（chatJson 自身在入口设闸，避免一次调用双扣配额）。
    const denyMs = rateGateDenyMs();
    if (denyMs !== null) {
      const res: GlmChatResult = {
        ok: false, text: '', latencyMs: 0,
        model: this.model !== '' ? this.model : (this.delegate !== null ? this.delegate.model : this.model),
        error: rateLimitError(this.platformId, denyMs),
        note: 'rate-limited',
      };
      this.report(res);
      return res;
    }
    return this.chatCore(req);
  }

  /** chat 的执行核（ΝΩ-18 拆分）：限流闸之后的一切原路径 —— 行为逐字节保持 */
  private async chatCore(req: GlmVisionRequest): Promise<GlmChatResult> {
    // 委托路径（纪元 Ψ）：全权交平台适配器（重试律/降级律/meter/密键卫生皆其自管），
    // 壳层只整流结果形状；适配器违约上抛在此收敛（不抛铁律的最后一块拼图）。
    // P2a-1：委托路径自身重试全败后同样咨询池 —— 池救回 ⇒ 备脑结果；池缺席/全败
    // ⇒ 原失败结果逐字段不变（零回归红律）。
    if (this.delegate !== null) {
      let res: GlmChatResult;
      try {
        res = toGlmResult(await this.delegate.chat(req));
      } catch (e) {
        res = {
          ok: false, text: '', latencyMs: 0,
          model: this.delegate.model, providerId: this.delegate.id,
          error: sanitizeError(e, this.delegate.id),
        };
      }
      if (res.ok) return res;
      return (await consultFailoverPool(req)) ?? res;
    }

    const startedAt = Date.now();
    // R3-2：glm-4v-flash 家族硬顶钳制（缺省 2048 → 1024；其余模型恒等）——
    // R1-5 实测免费档 max_tokens >1024 即 HTTP 400 code 1210 拒单，原生路径
    // （platform 缺省 glm + GLM_VLM_MODEL=glm-4v-flash 直配主脑）自此有防线。
    const maxTokens = clampMaxTokensForModel(this.model, req.maxTokens ?? 2048);
    const temperature = req.temperature ?? 0.1;
    const timeoutMs = req.timeoutMs ?? 30_000;
    const maxRetries = req.maxRetries ?? 2;

    // 结束包装：补 latencyMs/model + meter 上报（含 degraded/失败臂）
    const finish = (r: Omit<GlmChatResult, 'latencyMs' | 'model'>): GlmChatResult => {
      const res: GlmChatResult = { ...r, latencyMs: Date.now() - startedAt, model: this.model };
      this.report(res);
      return res;
    };

    // 失败收尾（P2a-1）：先按原路径产出失败结果（meter 照报 —— 主脑失败是真实事件，
    // 不因备脑救回而抹账），再咨询故障切换池；救回 ⇒ 整流备脑成功结果（note
    // 'failover'），池缺席/空池/全败 ⇒ 原失败结果逐字段不变（零回归红律）。
    const fail = async (r: Omit<GlmChatResult, 'latencyMs' | 'model'>): Promise<GlmChatResult> => {
      const res = finish(r);
      return (await consultFailoverPool(req)) ?? res;
    };

    if (!this.configured) {
      return fail({
        ok: false, text: '', degraded: true,
        error: 'glm api key not configured (set GLM_API_KEY / ZHIPUAI_API_KEY / ZAI_API_KEY or pass options.apiKey)',
      });
    }
    const doFetch = this.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!doFetch) {
      return fail({ ok: false, text: '', error: 'fetch is not available (Node >= 18 required)' }); // doctor-exempt: 文案字符串，非阈值比较（W6-2）
    }

    // OpenAI 兼容多模态消息：system（可选）在前，user = 文本 + 图片序列
    const messages: unknown[] = [];
    if (req.system !== undefined && req.system !== '') messages.push({ role: 'system', content: req.system });
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: req.prompt },
        ...req.images.map(img => ({
          type: 'image_url',
          image_url: { url: `data:${img.mime ?? 'image/jpeg'};base64,${img.base64}` },
        })),
      ],
    });
    const payload: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: maxTokens,
      temperature,
      ...(req.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    };

    const url = `${this.baseUrl}/chat/completions`;
    // ΑΩ-R15（重试律单一立法）：手写重试循环退役 —— 传输层（仅 429/5xx/网络错
    // 可重试、超时不重试、全抖动指数退避 jitterDelayMs、每次尝试独立超时
    // AbortSignal）全权委托 providers/types.fetchWithRetry 唯一定义点（与三厂
    // 适配器同源同律，杜绝双实现漂移）。本层只保留 GLM 专有面：请求头/负载
    // 构造、choices/usage/json 响应剥壳、错误串的 glm 前缀 + apiKey 回显剔除、
    // meter 记账（每调用恰一条，经 finish/fail 收口不变）。
    const fr = await fetchWithRetry({
      doFetch,
      url,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      },
      maxRetries,
      timeoutMs,
    });

    if (!fr.ok) {
      if (fr.failureKind === 'http') {
        // HTTP 终败：错误体片段（空白折叠 + 截 300 字）+ 密钥卫生律（错误体可能
        // 回显 apiKey，一律替换后才能进入 error/meter）—— 与原手写环逐字节同律
        // （attempts 即原 attempt+1；>1 才缀尝试次数）
        const raw = (fr.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
        const snippet = this.apiKey ? raw.split(this.apiKey).join('[REDACTED]') : raw;
        // ΝΩ-18（429 回填）：服务端限流终败是「本方已超速」的实证 —— 经限流闸
        // recordServer429 记作本地已用配额（下一次 tryAcquire 被拒并给出诚实
        // retryAfterMs，不再白烧 429 往返），等待提示写进错误 note（未接线闸 ⇒ 0，
        // 不附 note，错误串与既往逐字节一致）。
        const hint429 = fr.status === HTTP_STATUS_TOO_MANY_REQUESTS ? backfillServer429() : 0;
        return fail({
          ok: false, text: '',
          error: `glm chat/completions HTTP ${fr.status}${fr.attempts > 1 ? ` after ${fr.attempts} attempts` : ''}: ${snippet}`,
          ...(hint429 > 0 ? { note: `rate-limited by server (429); retry after ${hint429}ms` } : {}),
        });
      }
      // 传输终败（网络错重试耗尽）/ 超时：内核归因串（'fetch failed after N
      // attempts: …' / 'request aborted after Xms'）拼 glm 前缀即原路径形状
      return fail({ ok: false, text: '', error: `glm ${fr.error ?? 'unknown transport failure'}` });
    }

    let body: unknown;
    try {
      body = JSON.parse(fr.body ?? '');
    } catch (e) {
      return fail({ ok: false, text: '', error: `glm response JSON parse failed: ${errText(e)}` });
    }
    const content = extractContent(body);
    if (content === null) {
      return fail({ ok: false, text: '', error: 'glm response missing choices[0].message.content' });
    }
    const usage = mapUsage((body as { usage?: unknown }).usage);
    const r: Omit<GlmChatResult, 'latencyMs' | 'model'> = { ok: true, text: content };
    if (usage) r.usage = usage;
    if (req.jsonMode) {
      const j = extractGlmJson(content);
      if (j !== undefined) r.json = j;
    }
    return finish(r);
  }

  /**
   * 结构化对话 —— 强制 jsonMode，对回复做健壮 JSON 提取
   * （剥 ```json 围栏 → 首个平衡 {...}/[...] → parse）。
   * 成功：{ ok:true, value, raw }；失败：{ ok:false, error, raw } —— raw 恒为
   * 模型回复原文（成功也是），调用方可落日志/回退解析。
   */
  async chatJson<T>(req: GlmVisionRequest): Promise<{ ok: boolean; value?: T; error?: string; raw: string }> {
    // ΝΩ-18（限流器接线）：结构化路径的限流前置闸 —— 置于级联咨询之前（级联
    // 便宜臂同享全局预算，闸拒绝时连便宜脑也不该拨）与委托分派之前。被拒 ⇒
    // ok:false 归因 rate-limited（不重试零网络）；放行后原生路径走 chatCore
    //（不再过 chat() 的闸 —— 一次调用恰扣一次配额，绝不双扣）。
    const denyMs = rateGateDenyMs();
    if (denyMs !== null) {
      return { ok: false, error: rateLimitError(this.platformId, denyMs), raw: '' };
    }

    // W2-8（C2 成本级联路由）：结构化路径最先咨询级联面 —— 承接 ⇒ 直接整流返回
    // （便宜档过检直采 / 升级主力重做）；弃权/未接线/面故障 ⇒ null ⇒ 主路径照走
    // （缺省未接线时本段恒不改变任何返回值 —— 零行为变化律）。
    const cascaded = await consultCascadeFace<T>(req);
    if (cascaded !== null) return cascaded;

    // 委托路径（纪元 Ψ）：适配器自带的 jsonMode 强制 + 剥壳提取（error 用适配器串）。
    // P2a-1：委托 jsonMode 全败 ⇒ 咨询池（与 chat 同咨询律）；救回且可剥壳 ⇒ 备脑值，
    // 池缺席/全败/剥壳失败 ⇒ 原失败结果逐字段不变（零回归红律）。
    if (this.delegate !== null) {
      let res: { ok: boolean; value?: T; error?: string; raw: string };
      try {
        res = await this.delegate.chatJson<T>(req);
      } catch (e) {
        res = { ok: false, error: sanitizeError(e, this.delegate.id), raw: '' };
      }
      if (res.ok) return res;
      const saved = await consultFailoverPool({ ...req, jsonMode: true });
      if (saved) {
        const value = extractGlmJson(saved.text);
        if (value !== undefined) return { ok: true, value: value as T, raw: saved.text };
      }
      return res;
    }
    const res = await this.chatCore({ ...req, jsonMode: true });
    if (!res.ok) {
      return { ok: false, error: res.error, raw: res.text };
    }
    const value = extractGlmJson(res.text);
    if (value === undefined) {
      return {
        ok: false,
        error: `glm json extraction failed: no balanced JSON object/array in reply (${res.text.length} chars)`,
        raw: res.text,
      };
    }
    return { ok: true, value: value as T, raw: res.text };
  }
}

// ─── 模块级单例 ───

let singleton: GlmClient | null = null;

/** options 是否携带平台线索（apiKey/baseUrl/model/platform 任一非空）——
 *  无线索时才启用 env 平台自动识别（缺省解析增强的触发条件） */
function hasPlatformHint(o: GlmClientOptions): boolean {
  return [o.platform, o.apiKey, o.baseUrl, o.model].some(
    v => typeof v === 'string' && v.trim() !== '',
  );
}

/**
 * 缺省铸造（纪元 Ψ 增强）：options 全空（无平台线索）时 ——
 *   1. GLM envs（GLM/ZHIPUAI/ZAI 任一）在场 ⇒ 现状 glm 路径（构造器自读，逐字节等同）；
 *   2. 否则 detectPresetFromEnv() 命中他平台 ⇒ 以该平台铸造（apiKey 经其 envKeys
 *      解析、baseUrl/model 取预设缺省；GLM_BASE_URL/GLM_VLM_MODEL 语义保持 glm 专属）；
 *   3. 都无 ⇒ 现状（glm 缺省 ⇒ 未配置降级臂）。
 * options 携带任一平台线索 ⇒ 直接 new GlmClient(options)（构造器平台解析自管）。
 * fetchImpl/meter 等注入面在任何分支都原样透传。
 */
function mintSingleton(options?: GlmClientOptions): GlmClient {
  const o = options ?? {};
  if (hasPlatformHint(o)) return new GlmClient(o);
  if (envApiKey() !== '') return new GlmClient(o); // GLM envs 在场 ⇒ 现状 glm 路径
  const hit = detectPresetFromEnv();
  if (hit !== null && hit.id !== 'glm') {
    return new GlmClient({ ...o, platform: hit.id }); // apiKey 由委托路径按平台 envKeys 自解析
  }
  return new GlmClient(o);
}

/** 获取模块级单例 —— options 仅首次（或 resetGlmClient 后）生效。
 *  测试之间请先 resetGlmClient() 再带新 options 取用。 */
export function getGlmClient(options?: GlmClientOptions): GlmClient {
  if (!singleton) singleton = mintSingleton(options);
  return singleton;
}

/**
 * 探测云脑可用性 —— 不落地单例（避免先探测后带 options 取用时被空单例占位）。
 *
 * 纪元 Ψ 语义升格：本哨兵原意为「GLM 可用」，现为「任一云脑可用」——
 * tools/index.ts 的 ask_screen 挂载门与 src/index.ts 的提示词注入门以此判定，
 * 全平台视觉模型都应点亮整套系统。判定序（短路）：
 *   1. GLM envs（GLM/ZHIPUAI/ZAI 任一非空）⇒ true；
 *   2. 已铸造单例且其 configured ⇒ true；
 *   3. 否则 detectPresetFromEnv() 命中任一平台（含 glm）⇒ true；
 *   4. 都无 ⇒ false（与 getGlmClient 缺省解析保持一致 —— 探测真则缺省铸造可用）。
 */
export function isGlmConfigured(): boolean {
  if (envApiKey() !== '') return true;
  if (singleton && singleton.configured) return true;
  return detectPresetFromEnv() !== null;
}

/**
 * 只读窥探当前生效平台 —— 与 getGlmClient 缺省解析同律推演，绝不铸造单例
 * （探测只读律；vlm_platforms 报告面消费）。
 * 返回 { platform, configured, minted }：minted = 是否已有单例落地。
 */
export function peekGlmPlatform(): { platform: string; configured: boolean; minted: boolean } {
  if (singleton) {
    return { platform: singleton.platform, configured: singleton.configured, minted: true };
  }
  if (envApiKey() !== '') return { platform: 'glm', configured: true, minted: false };
  const hit = detectPresetFromEnv();
  if (hit !== null) return { platform: hit.id, configured: true, minted: false };
  return { platform: 'glm', configured: false, minted: false };
}

/** 重置单例 —— 下次 getGlmClient 用新 options / 重读环境变量。 */
export function resetGlmClient(): void {
  singleton = null;
}
