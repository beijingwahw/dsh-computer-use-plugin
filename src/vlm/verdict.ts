// src/vlm/verdict.ts
// 纪元 Ω（Ω-6 · GLM-5.3-Flash 云脑皮层）：L3.5 云端语义判决 —— 动作前后双图的效果裁决。
// 验证栈定位（四层之上的半层）：L1 像素 dHash 只答「变没变」，L2 视觉差分只答「哪里变」，
// L3 本地 OCR 只认「看得见的字」，L4 预期锚定管意图对齐；本模块把 before/after 两图 +
// 预期一并交给云脑（两图同裁编码、按序下发、som 判决铁律提示词），换回
// confirmed / refuted / uncertain 三值判决 —— 语义级「变的对不对」只有云脑能答。
// fuseWithPixelEvidence 再把云判决与 L1/L2 像素证据做纯函数双脑融合（一致加成 /
// 分歧降级），供仲裁层消费。铁律：具名导出、零新增依赖、绝不抛异常 —— 一切失败以
// { ok:false, degraded:true, error } 表达，云脑缺席不致命，调用方降级回本地栈。
import {
  getGlmClient, isGlmConfigured,
  type GlmClient, type GlmImageInput,
} from './glmClient';
import { encodeForVlm, type Bbox } from './codec';
import { buildVerdictPrompt } from './som';
import { kernelRegistry } from '../kernel/registry';

/** 三值判决：confirmed 预期已达成 / refuted 预期未达成 / uncertain 云脑不敢断言 */
export type VlmVerdictLevel = 'confirmed' | 'refuted' | 'uncertain';

/** 云端语义判决结果 —— ok:false 时 verdict 恒 'uncertain'、scale 恒 'none'、explanation 恒 ''、confidence 恒 0（宁可空不可错） */
export interface VlmEffectVerdict {
  /** true = 云脑成功给出结构化判决（载荷不可用时枚举安全归位，见 judgeEffect） */
  ok: boolean;
  /** 三值判决（ok:false 时无语义，恒 'uncertain'） */
  verdict: VlmVerdictLevel;
  /** 变化范围：page 页面级 / element 元素级 / none 无变化（模型自报，非法归 'none'） */
  scale: 'page' | 'element' | 'none';
  /** 一句中文说明（模型自报；缺失兜底空串，绝不 undefined） */
  explanation: string;
  /** 置信度 0..1（模型自报经夹取；ok:false 时恒 0） */
  confidence: number;
  /** true = 云脑路径未走通（未配置 / 编码失败 / chatJson 失败或抛错）—— 调用方降级本地栈 */
  degraded: boolean;
  /** 失败原因（ok:false 时必有） */
  error?: string;
  /** 整次调用墙钟延迟（毫秒，含两图编码） */
  latencyMs: number;
}

/** 双图顺序说明 —— 拼在 buildVerdictPrompt 之前：images 数组本身无语义，顺序必须显式钉死 */
const VERDICT_IMAGE_ORDER_NOTE = '第一张图是动作前(before)，第二张图是动作后(after)，请严格按此顺序对比。';

/** 合法判决枚举（模型方言一律不收 —— 判决永不出错值） */
const VERDICT_LEVELS: ReadonlySet<string> = new Set(['confirmed', 'refuted', 'uncertain']);
/** 合法变化范围枚举 */
const VERDICT_SCALES: ReadonlySet<string> = new Set(['page', 'element', 'none']);

/**
 * 模型载荷规整 —— 判决永不出错值（宁可 uncertain 不可乱判）：
 * - verdict 非法（拼错 / 大小写漂移 / 非字符串 / 缺席）⇒ 'uncertain'
 * - scale 非法 ⇒ 'none'（与 uncertain 判决语义自洽：不知何变之有）
 * - confidence 宽松转数（'0.75' 数字串方言也收）后夹 [0,1]，非法/NaN 压 0
 * - explanation 非字符串经 String() 兜底（null/undefined → ''），永不 undefined
 * 载荷整体是垃圾（字符串/null/数组）时全字段走兜底 —— 规整永不失败、绝不抛。
 */
function normalizeVerdictPayload(value: unknown): {
  verdict: VlmVerdictLevel;
  scale: 'page' | 'element' | 'none';
  explanation: string;
  confidence: number;
} {
  const v = (value && typeof value === 'object' ? value : {}) as {
    verdict?: unknown;
    scale?: unknown;
    explanation?: unknown;
    confidence?: unknown;
  };
  const verdict = typeof v.verdict === 'string' && VERDICT_LEVELS.has(v.verdict)
    ? (v.verdict as VlmVerdictLevel)
    : 'uncertain';
  const scale = typeof v.scale === 'string' && VERDICT_SCALES.has(v.scale)
    ? (v.scale as 'page' | 'element' | 'none')
    : 'none';
  const explanation = typeof v.explanation === 'string' ? v.explanation : String(v.explanation ?? '');
  const c = typeof v.confidence === 'number' ? v.confidence : Number(v.confidence);
  return {
    verdict,
    scale,
    explanation,
    confidence: Number.isFinite(c) ? Math.min(Math.max(c, 0), 1) : 0,
  };
}

/**
 * 云端语义判决：动作前后双图 + 预期 → confirmed/refuted/uncertain 三值效果裁决。
 * 永不抛异常 —— 一切失败以 { ok:false, degraded:true, error } 返回。
 *
 * 流程（顺序固定）：
 *   1) 云脑可用性：注入 client 优先（测试/宿主直连），否则全局配置探测 ——
 *      未配置且未注入 ⇒ 零网络降级（不建 client、不编码、不发请求）；
 *   2) 两图经 encodeForVlm 同裁编码（region 同裁：焦点邻域等场景只把该窗口
 *      交给云脑，两张图裁同一块 —— 坐标系对齐是对比的前提）；
 *   3) 双图按序下发（第一张动作前、第二张动作后 —— 顺序倒置会把因果倒置），
 *      提示词 = 顺序说明 + buildVerdictPrompt（som 判决铁律）；
 *   4) chatJson 结构化对话 → 载荷规整（见 normalizeVerdictPayload）。
 *
 * degraded 语义：true = 云脑路径未走通（未配置 / 空 buffer / 编码失败 /
 * chatJson 失败或抛错）；ok:true 恒 degraded:false。调用方以 degraded 决定
 * 是否降级本地验证栈（云脑缺席不致命，本地反射层照常运转）。
 *
 * @param before      动作前截图（任意常见格式 Buffer）
 * @param after       动作后截图
 * @param expectation 预期描述（自然语言，如「点击后下拉菜单展开」）
 * @param opts        region 可选像素兴趣区（两图同裁）；client 可注入（测试绝不联网）
 */
export async function judgeEffect(
  before: Buffer,
  after: Buffer,
  expectation: string,
  opts?: {
    /** 可选：只关心该区域（如焦点邻域）—— 两图裁同一块再编码 */
    region?: Bbox;
    /** 可选：注入 GlmClient（测试注假 client / 宿主直连；缺省走全局单例） */
    client?: GlmClient;
  },
): Promise<VlmEffectVerdict> {
  const startedAt = Date.now();
  const fail = (error: string): VlmEffectVerdict => ({
    ok: false, verdict: 'uncertain', scale: 'none', explanation: '',
    confidence: 0, degraded: true, error, latencyMs: Date.now() - startedAt,
  });
  try {
    // 1) 云脑可用性：注入 client 优先（测试/宿主直连），否则全局配置探测 —— 未配置零网络降级
    let client = opts?.client;
    if (!client) {
      if (!isGlmConfigured()) {
        return fail('vlm verdict unavailable: glm api key not configured and no client injected');
      }
      client = getGlmClient();
    }
    if (!Buffer.isBuffer(before) || before.length === 0) {
      return fail('vlm verdict unavailable: empty before buffer');
    }
    if (!Buffer.isBuffer(after) || after.length === 0) {
      return fail('vlm verdict unavailable: empty after buffer');
    }

    // 2) 两图同裁编码（region 同裁；失败即云脑路径未走通 → 诚实 degraded）
    const [beforeEnc, afterEnc] = await Promise.all([
      encodeForVlm(before, { region: opts?.region }),
      encodeForVlm(after, { region: opts?.region }),
    ]);
    if (!beforeEnc.ok || !beforeEnc.value) {
      return fail(`vlm verdict encode before failed: ${beforeEnc.error ?? 'unknown codec error'}`);
    }
    if (!afterEnc.ok || !afterEnc.value) {
      return fail(`vlm verdict encode after failed: ${afterEnc.error ?? 'unknown codec error'}`);
    }

    // 3) 双图按序下发（前图在前、后图在后）+ 顺序说明钉死 + som 判决铁律提示词
    const expectText = typeof expectation === 'string' ? expectation : String(expectation ?? '');
    const images: GlmImageInput[] = [
      { base64: beforeEnc.value.base64, mime: beforeEnc.value.mime },
      { base64: afterEnc.value.base64, mime: afterEnc.value.mime },
    ];
    const resp = await client.chatJson<unknown>({
      images,
      prompt: `${VERDICT_IMAGE_ORDER_NOTE}${buildVerdictPrompt(expectText)}`,
    });
    if (!resp.ok) {
      return fail(`vlm verdict chat failed: ${resp.error ?? 'unknown glm error'}`);
    }

    // 4) 载荷规整：非法枚举归 uncertain / none、confidence 夹 [0,1]、explanation 兜底空串
    //    （规整永不失败 —— 载荷不可用不是调用失败，ok 仍 true，判决安全归位）
    const p = normalizeVerdictPayload(resp.value);
    return {
      ok: true,
      verdict: p.verdict,
      scale: p.scale,
      explanation: p.explanation,
      confidence: p.confidence,
      degraded: false,
      latencyMs: Date.now() - startedAt,
    };
  } catch (e) {
    // 理论不可达（各步自兜底）—— 最后防线：注入 client 违约抛错等一切意外
    // 收敛为降级返回，绝不越狱上抛
    const msg = e instanceof Error ? e.message : String(e);
    return fail(`vlm verdict crashed: ${msg.slice(0, 240)}`);
  }
}

/**
 * 双脑融合（纯函数）：云端语义判决 × 像素差分证据 → 最终判决。
 *
 * 像素证据的置信换算（方向对齐 —— similarityPct 是相似度，语义与 detected 相反）：
 *   detected=true  ⇒ pixelConf = (100 - similarityPct)/100（越不相似越确信「变了」）
 *   detected=false ⇒ pixelConf = similarityPct/100（越相似越确信「没变」）
 *   similarityPct 夹 [0,100]；非有限值按像素布尔自证取满置信（detected ? sim=0 : sim=100）
 *
 * 融合规则全集（分歧永远降级 uncertain，绝不硬判）：
 *   ① vlm.ok=false           ⇒ 原样返回（云脑缺席 —— 像素证据无从对齐语义，不越权代判）
 *   ② refuted × 未检出变化    ⇒ refuted，confidence = (vlm + pixel)/2（双脑同判「无效果」取均值）
 *   ③ confirmed × 未检出变化  ⇒ uncertain（分歧降级），confidence = min(vlm, 0.6)（保守化）
 *   ④ confirmed × 检出变化    ⇒ confirmed，confidence = min(1, 均值 + 0.1)（双脑一致加成）
 *   ⑤ 其余（refuted × 检出变化 / vlm 本就 uncertain 等）⇒ uncertain，
 *      confidence = min(vlm, 0.6)（保守化）
 *
 * 纯函数：绝不改入参（返回新对象，vlm.ok=false 时原引用直返）；除 verdict/confidence
 * 外的字段（ok/scale/explanation/degraded/error/latencyMs）原样透传。绝不抛异常。
 *
 * @param vlm   judgeEffect 的云判决（ok:false 时像素证据被忽略）
 * @param pixel L1/L2 像素层证据：detected 是否检测到变化 + 前后相似度百分比
 */
export function fuseWithPixelEvidence(
  vlm: VlmEffectVerdict,
  pixel: { detected: boolean; similarityPct: number },
): VlmEffectVerdict {
  try {
    // ① 云脑缺席/失败 —— 原样返回（保持对象同一性，调用方可 === 判同）
    if (!vlm || vlm.ok !== true) return vlm;

    // 像素证据消毒：布尔严格取 true；相似度夹 [0,100]，非有限按方向自证满置信
    const detected = pixel?.detected === true;
    const simRaw = Number(pixel?.similarityPct);
    const sim = Number.isFinite(simRaw)
      ? Math.min(100, Math.max(0, simRaw))
      : (detected ? 0 : 100);
    const pixelConf = detected ? (100 - sim) / 100 : sim / 100;

    // 云判决置信消毒（防御外部脏数据）：夹 [0,1]，非法压 0 —— 融合永不产出 NaN
    const c = vlm.confidence;
    const vlmConf = Number.isFinite(c) ? Math.min(Math.max(c, 0), 1) : 0;
    const mean = (vlmConf + pixelConf) / 2;

    let verdict: VlmVerdictLevel;
    let confidence: number;
    // 纪元 Ξ（Ξ-D 生产接线）：融合判据读内核注册表 —— verdict.fuseBonus（双脑
    // 一致加成，缺省 0.1）/ verdict.conservativeCap（分歧降级置信帽，缺省 0.6）。
    // 未注册 ⇒ getOrDefault 回声字面量，融合输出逐字节不变；每次融合单次读取。
    const fuseBonus = kernelRegistry.getOrDefault('verdict.fuseBonus', 0.1);
    const conservativeCap = kernelRegistry.getOrDefault('verdict.conservativeCap', 0.6);
    if (vlm.verdict === 'confirmed' && detected) {
      // ④ 双脑一致判「有效果」—— 均值 + 0.1 加成，封顶 1
      verdict = 'confirmed';
      confidence = Math.min(1, mean + fuseBonus);
    } else if (vlm.verdict === 'refuted' && !detected) {
      // ② 双脑一致判「无效果」—— 取均值
      verdict = 'refuted';
      confidence = mean;
    } else {
      // ③⑤ 分歧（confirmed×未检出 / refuted×检出）或云脑本就 uncertain —— 一律 uncertain 保守化
      verdict = 'uncertain';
      confidence = Math.min(vlmConf, conservativeCap);
    }
    return { ...vlm, verdict, confidence };
  } catch {
    return vlm; // 理论不可达 —— 防御兜底：任何意外原样返回，绝不抛
  }
}
