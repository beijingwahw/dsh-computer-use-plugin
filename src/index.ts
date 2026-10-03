// src/index.ts
// 融合重构版入口：八纪元精华的最终汇聚点。
// DSH 规范合规：Config schema / inject 依赖声明 / ctx.effect 返回清理函数 / 可选服务优雅降级。
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from './config';
import { system } from './system';
import { contextManager } from './contextManager';
import { uiMemory } from './uiMemory';
import { probeMemory } from './probeMemory';
import { journal } from './journal';
import { skillLibrary } from './skillLibrary';
import { failureMemory } from './failureMemory';
import { telemetry } from './telemetry';
import { loadCheckpoint, saveCheckpoint } from './checkpoint';
import { disposeOcr, setSemanticVlmOptions } from './textReader';
// 纪元 Λ（Λ-4）：桶再分发面（vlm/index）—— configureVlm/isGlmConfigured 之外
// 新增连接存档 / 本地自动接管 / 向导服务与单例铸造面。目录导入 './vlm' 在
// Node strip 模式（测试装载器）是 ERR_UNSUPPORTED_DIR_IMPORT —— 显式指到
// 桶文件，宿主 bundler 与测试装载器双方言兼容（兄弟模块 './vlm/glmClient' 同律）。
import {
  configureVlm, isGlmConfigured,
  resetGlmClient, getGlmClient,
  ConnectionStore, adoptLocalVision, startOnboarding,
  type VisionConnection, type AdoptedLocal, type OnboardingHandle,
} from './vlm/index';
import {
  registerProductionKernels,
  kernelRegistry,
  evidenceLedger,
  KernelStore,
  KernelCalibrator,
  EvolutionConductor,
} from './kernel/index';
import { stopBackend } from './physicalBackend';
import { setImageDeliveryStore } from './imageDelivery';
import { swarm } from './swarm';
import { coordinator } from './subAgent';
import { shaper } from './environmentShaper';
import { quantum, UiExtractorWhitebox } from './quantumSense';
// 纪元 Λ（Λ-4）：工具桶改为 apply() 内动态装载 —— 桶的静态图含
// swarmDispatch.ts 的「接口按值导入」地雷（SubAgentSpec，宿主 bundler 擦除型
// import 正常、Node strip 型装载器链接即炸），静态引入会阻断本文件在测试
// 装载器下的可导入性（lightUpVision 的可测导出依赖它）。动态 import 不改
// 宿主语义，只把挂载点移进 apply() 的异步体（apply 本就 async）。
// 单文件工具（askScreen —— 测试装载器已验证干净）保持静态引入。
import { createAskScreenTool } from './tools/askScreen';
import { registerAllGuards, updatePopupState, onLlmPreRequest } from './guards/index';
import { resetPopupBelief, resetPopupSprt } from './popupDetector';
import { resetElementTracker } from './elementTracker';
import { oscillationTracker } from './oscillationTracker';
import { focusTracker } from './focusTracker';
import { resetDiffPersistence } from './visualDiff';
import { onToolPost } from './guards/hooks';
import { runOrchestrator, ACTOR_SYSTEM_PROMPT, createActor } from './orchestrator';
// ChatFn 是纯类型 —— Node strip 型装载器下按值导入会链接炸（swarmDispatch
// 同类地雷），拆为 import type（类型擦除后零运行时差）。
import type { ChatFn as PlannerChatFn } from './orchestrator';
import { GOAL_MAX_CHARS, SUCCESS_CRITERIA_MAX_CHARS } from './orchestration/contracts';
import {
  emitCognitionPlanReady, mintIntentPlanReady, COGNITION_PLAN_READY_EVENT,
} from './cognitionEvents';
import { wireDoctorVerdictChannel } from './doctorChannel';

export { Config } from './config';

// ─── 提示词三正交段（能力 / 流程 / 异常处理），各自独立演化，互不污染 ───

const VISION_GROUNDING_PROMPT = `
# 纯视觉 Agent 行为准则 (Vision-Only Grounding)

你拥有强大的多模态视觉能力。你不再依赖系统底层的 UI 树，而是完全通过"看"屏幕截图来理解世界。

## 视觉定位规范 (Visual Grounding)
当你需要与屏幕上的元素交互时，你必须：
1. **仔细观察**：在脑海中扫描截图，定位目标元素（如按钮、输入框、链接）。
2. **估算坐标**：估算该元素中心点的归一化坐标 (X, Y)，范围严格在 0.0 到 1.0 之间。
   - (0.0, 0.0) 代表屏幕左上角。
   - (1.0, 1.0) 代表屏幕右下角。
3. **精准输出**：在调用 \`click_mouse\` 工具时，直接传入你估算的归一化坐标。

## 思考格式 (Thought Process)
在采取行动前，你必须在思考中明确描述你看到的内容（坐标估算出声思考，给自己纠错的机会）：
"I can see a 'Submit' button located at the bottom right of the form. Its approximate center normalized coordinates are X=0.85, Y=0.90."
`;

const REACT_WORKFLOW_PROMPT = `
## 核心工作流 (ReAct Loop)
1. **OBSERVE**: 每次行动前，**必须**先调用 \`take_screenshot\` 查看当前屏幕状态。
2. **THINK**: 结合视觉定位规范，分析截图内容，明确当前 UI 状态。
3. **ACT**: 调用工具执行操作。坐标必须使用 0.0 到 1.0 的归一化数值。
4. **VERIFY**: 执行操作后，**必须**再次调用 \`take_screenshot\` 验证操作是否成功。

## 严格约束
- 永远不要在没有截图的情况下盲目操作。
- 每次只执行一个原子操作，等待系统反馈后再进行下一步。
- 如果连续两次操作失败，请停止并报告，不要陷入死循环。
`;

const POPUP_HANDLING_PROMPT = `
## 异常状态处理：弹窗与遮挡 (Popups & Overlays)
在每次 \`take_screenshot\` 后，你必须首先检查是否存在以下情况：
1. **模态对话框 (Modal/Dialog)**：如登录框、确认提示、Cookie 同意。
2. **意外遮挡**：目标元素被其他浮层挡住。

**处理原则**：
- 如果检测到弹窗，**必须优先处理弹窗**（如点击关闭按钮、接受 Cookie 或输入验证码），然后再继续原任务。
- 如果弹窗是意料之外的广告或无关提示，尝试寻找关闭按钮（如 'X', 'Close', 'Cancel'）将其关闭，或调用 \`dismiss_popup\` 强制重新分析。
- 处理完弹窗后，必须再次 \`take_screenshot\` 确认主界面已恢复。
`;

// 纪元 Ω（云脑皮层）：ask_screen 工具使用准则 —— 仅在 VLM 可用时注入
//（声明一个不可用的工具只会误导模型去调用它然后吃闭门羹）。
const VLM_ASK_SCREEN_PROMPT = `
## 云脑视觉问答 (ask_screen)
当需要对屏幕做**开放语义理解**而本地工具不足时（整页状态 / 陌生界面用途 / 图文混排 / 控件之间的关系），调用 \`ask_screen\`：
1. 传入一个自然语言问题（如"当前哪个输入框获得焦点？"、"这是登录页吗？有无已填字段？"）。
2. 返回的 state_anchor.answer 是云端视觉模型**基于当前真实截图**的作答（附 latency_ms / model）。
3. \`ask_screen\` 只读不改变世界；答案描述的是截屏瞬间，动手前仍按视觉定位规范自行取坐标。
4. 精确文字定位仍用 \`find_text\`，纯文字读取仍用 \`read_text\` —— 云脑问答是补充，不是替代。
5. 尚未连接任何视觉模型时，可调用 \`vlm_wizard\` 为用户打开本机连接向导页（选平台/贴密钥，保存即热生效）。
6. 需要更换主力视觉脑时，用 \`switch_vision_model\` 运行时切换（平台/密钥/模型一次到位，无需重载）。
`;

// 纪元 Φ（自主智能环）：autonomous_run 使用准则 —— 仅在 autonomyEnabled 时注入
//（声明一个未启用的能力只会误导模型去调用它然后吃闭门羹）。
const AUTONOMY_RUN_PROMPT = `
## 自主智能环 (autonomous_run)
当任务可以交给系统**自主闭环**完成时（目标明确 + 判据可核对），调用 \`autonomous_run\`：
1. 传入 goal（自然语言目标）与 success_criteria（成功判据；最佳实践：任务完成时**会原样出现在屏幕上**的短语，
   系统用 OCR 全文做大小写/空白不敏感的子串匹配核对 —— 缺省把 goal 原文当唯一字面判据）。
2. 环内自主完成：感知（截屏/OCR/云脑接地）→ 判断（策略引擎选动作）→ 宪法（风险闸门）→ 执行（真实键鼠）→
   验证（dhash 变化检测）→ 进化（教训与技能蒸馏）。返回 phase / steps / criteria / verdict / lessons。
3. **宪法可能升级 ACTION_REQUIRED**（审批类动作如发送/保存，或否决类如卡死循环）—— 此时请人类裁决：
   向用户说明情况并等待确认，绝不代人类批准不可逆操作。
4. 未达成（FAILED 锚点）时先读 lessons 与 next_run_advice，再决定重跑（收紧判据）还是自己接管剩余步骤。
`;

export const name = 'dsh-computer-use-plugin';

// 必需依赖：工具注册服务。可选服务（systemPrompt / llm / agents）在使用点用 ctx.get() 查询
export const inject = ['tools'];

/** 可选服务查询：systemPrompt 存在则注入提示词，不存在则优雅降级（行为准则已内置于工具描述与锚点） */
function tryInjectPrompt(ctx: Context, config: Config): void {
  const sp = ctx.get('systemPrompt') as
    | { section: (o: { name: string; order: number; text: string }) => unknown }
    | undefined;
  if (!sp) {
    console.log('[Vision Plugin] systemPrompt 服务不可用，行为准则将依赖工具描述与状态锚点。');
    return;
  }
  // 系统段落序约定：-100 harness identity / -99 harness source / 0 persona；插件行为准则置于 persona 之后
  sp.section({ name: 'vision-grounding-rules', order: 10, text: VISION_GROUNDING_PROMPT });
  sp.section({ name: 'react-workflow-rules', order: 11, text: REACT_WORKFLOW_PROMPT });
  sp.section({ name: 'popup-handling-rules', order: 12, text: POPUP_HANDLING_PROMPT });
  // 纪元 Ω：ask_screen 使用准则仅在 VLM 可用时注入（config.vlmApiKey 已铸单例或环境变量已配置）
  if (config.vlmApiKey || isGlmConfigured()) {
    sp.section({ name: 'vlm-ask-screen-rules', order: 13, text: VLM_ASK_SCREEN_PROMPT });
  }
  // 纪元 Φ：autonomous_run 使用准则仅在自主环开启时注入（order 14 —— 紧随 vlm 段之后）
  if (config.autonomyEnabled) {
    sp.section({ name: 'autonomy-run-rules', order: 14, text: AUTONOMY_RUN_PROMPT });
  }
}

// ─── 纪元 Λ（Λ-4 开箱即亮）：解析五级链 —— 显式 config > 连接存档 > env 自动识别 > 本地自动接管 > 向导弹出 ───

/** 宽松宿主面 —— lightUpVision 的 ctx 只需「能注册工具、能查 systemPrompt」两个
 * 可选面（生产传入真 Context；测试注入假件 —— ctxLike 宽松类型即为此） */
type CtxLike = {
  tools?: { register?: (tool: unknown) => unknown } | undefined;
  get?: (name: string) => unknown;
};

/** lightUpVision 依赖注入缝 —— 测试全离线注入；缺省走真实实现（真存档/真探测/真向导/真壳层开页） */
export interface LightUpDeps {
  /** 连接存档仓（缺省 new ConnectionStore() —— ~/.dsh/vlm-connection.json） */
  store?: { load(): VisionConnection | null; save(conn: VisionConnection): { ok: boolean; error?: string } };
  /** 本地视觉服务探测（缺省 adoptLocalVision() —— 真 fetch，1500ms 超时） */
  adopt?: () => Promise<AdoptedLocal | null>;
  /** 向导服务供给（缺省 startOnboarding —— 只绑回环；端口段被占时 reject） */
  server?: (opts: {
    port?: number;
    deps?: { onConnect?: (conn: VisionConnection) => Promise<void> };
  }) => Promise<OnboardingHandle>;
  /** 打开向导页的壳层（缺省 system.openUrl —— dryRun 守卫天然继承） */
  opener?: (url: string) => Promise<unknown>;
  /** 日志面（缺省 console.log） */
  log?: (msg: string) => void;
}

/**
 * 应用一条视觉连接到云脑单例 —— resetGlmClient 后按连接物料重铸（platform/
 * apiKey/baseUrl/model 全透传；本地免密平台只带 baseUrl/model）。
 * 绝不抛异常（铸造失败 = 连接物料坏，由调用方日志诚实报告）。
 */
function applyConnection(conn: VisionConnection, log: (m: string) => void): void {
  try {
    resetGlmClient();
    getGlmClient({
      platform: conn.platform,
      ...(conn.apiKey ? { apiKey: conn.apiKey } : {}),
      ...(conn.baseUrl ? { baseUrl: conn.baseUrl } : {}),
      ...(conn.model ? { model: conn.model } : {}),
    });
    log(`[Vision Plugin] 视觉连接已生效：<${conn.platform}>${conn.model ? ` 模型 ${conn.model}` : ''}（来源 ${conn.via}）。`);
  } catch (e: any) {
    log(`[Vision Plugin] 视觉连接应用失败（<${conn.platform}>）：${String(e?.message ?? e).slice(0, 120)}`);
  }
}

/**
 * 迟到注册（Λ-4）：向导连接在 apply() 之后落地时，把「配置时因无模型而缺席」的
 * VLM 表面补挂上（L371 元工具注册先例）：ask_screen 工具 + vlm 提示词段。
 * 全部 try/catch 吞 —— 迟到注册是尽力义务；宿主面缺席（如已 dispose）则诚实
 * log 一句「连接已保存，重载插件后生效」，绝不炸向导的 onConnect 回调。
 */
async function registerLateVlmSurfaces(ctxLike: CtxLike, config: Config, log: (m: string) => void): Promise<void> {
  let registered = false;
  // 缺席 ≠ 失败：可选链短路不抛错 —— 只有 register 真被调用过才算挂载成功
  const registerFn = ctxLike.tools?.register;
  if (typeof registerFn === 'function') {
    try {
      registerFn(createAskScreenTool(config));
      registered = true;
    } catch { /* 工具面故障 ⇒ 交由下方诚实 log */ }
  }
  try {
    const sp = ctxLike.get?.('systemPrompt') as
      | { section: (o: { name: string; order: number; text: string }) => unknown }
      | undefined;
    sp?.section?.({ name: 'vlm-ask-screen-rules', order: 13, text: VLM_ASK_SCREEN_PROMPT });
  } catch { /* 提示词段是旁路义务 */ }
  if (!registered) {
    log('[Vision Plugin] 连接已保存，重载插件后生效（宿主工具面此刻缺席）。');
  }
}

/**
 * 开箱即亮解析链（Λ-4）—— 只在「无任何云脑配置」（apply 的五级门前四级全空）时被
 * fire-and-forget 调用，按序点亮第一盏能亮的灯：
 *   ① ConnectionStore.load() 命中 ⇒ applyConnection（上一会话的选择，启动即续连）；
 *   ② vlmAutoAdoptLocal ⇒ adoptLocalVision()（Ollama/LM Studio/vLLM 环回轻叩）命中
 *      ⇒ 存档 save({via:'auto-adopt'}) + applyConnection —— 开箱即亮本地脑；
 *   ③ 仍无且 vlmOnboardingEnabled ⇒ startOnboarding（onConnect 热应用 + 迟到注册）
 *      + system.openUrl 弹向导页 —— 让用户两分钟内接上一颗脑。
 * 不抛铁律：每一级的任何故障（存档坏/探测超时/端口全占/开浏览器失败）都被吞或
 * 落到下一级 —— 装载绝不因「点亮仪式」失败而炸（apply 侧另有 .catch 兜底）。
 */
export async function lightUpVision(ctxLike: CtxLike, config: Config, deps: LightUpDeps = {}): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const store = deps.store ?? new ConnectionStore();

  // ① 连接存档命中 ⇒ 直接续连（不探测不弹窗 —— 用户的选择优先于一切猜测）
  try {
    const conn = store.load();
    if (conn) {
      applyConnection(conn, log);
      return;
    }
  } catch { /* 存档面故障 ⇒ 视为无档，走下一级 */ }

  // ② 本地自动接管（!== false：schema 缺省 true；手写局部配置缺字段时同取缺省语义）
  if (config.vlmAutoAdoptLocal !== false) {
    try {
      const adopt = deps.adopt ?? (() => adoptLocalVision());
      const adopted = await adopt();
      if (adopted) {
        const conn: VisionConnection = {
          platform: adopted.platform,
          baseUrl: adopted.baseUrl,
          model: adopted.model,
          updatedAt: Date.now(),
          via: 'auto-adopt',
        };
        try {
          const saved = store.save(conn);
          if (!saved.ok) log(`[Vision Plugin] 本地接管存档失败（${saved.error ?? '原因未知'}）—— 本次会话仍将使用该连接。`);
        } catch (e: any) {
          log(`[Vision Plugin] 本地接管存档失败（${String(e?.message ?? e).slice(0, 120)}）—— 本次会话仍将使用该连接。`);
        }
        applyConnection(conn, log);
        log(`[Vision Plugin] 已自动接管本地视觉服务 <${adopted.platform}>（模型 ${adopted.model}，${adopted.latencyMs}ms 探测）—— 开箱即亮。`);
        return;
      }
    } catch { /* 探测故障（含注入件抛错）⇒ 走向导级 */ }
  }

  // ③ 连接向导（!== false：schema 缺省 true）：起回环服务 + 弹默认浏览器
  if (config.vlmOnboardingEnabled !== false) {
    try {
      const server = deps.server ?? ((opts: Parameters<NonNullable<LightUpDeps['server']>>[0]) => startOnboarding(opts));
      const handle = await server({
        port: config.vlmOnboardingPort,
        deps: {
          onConnect: async (conn: VisionConnection) => {
            applyConnection(conn, log);
            await registerLateVlmSurfaces(ctxLike, config, log);
          },
        },
      });
      // 弹窗尽力（openUrl 的 dryRun 守卫天然继承；失败只影响「自动弹」，向导地址已 log）
      try {
        const opener = deps.opener ?? ((url: string) => system.openUrl(url));
        await opener(handle.url);
      } catch { /* 弹窗失败不炸装载 */ }
      log(`[Vision Plugin] 未检测到任何视觉模型 —— 连接向导已启动：${handle.url}（若浏览器未弹出请手动访问）。`);
    } catch { /* 向导启动失败（端口段全占等）⇒ 装载照常，绝不炸 */ }
  }
}

/**
 * 可选服务查询：llm 存在且方法签名匹配时构造 ChatFn，否则返回 undefined（Planner 响亮降级）。
 * 双纪元适配：
 *   rc.6 表面 ctx.llm.stream(GenerateOptions) —— 流式，text-delta 聚合；
 *   旧表面 llm.chat(messages) —— 直接文本返回。
 * cordis 4：未 inject 的服务经 reflect.get 可选读取（缺席返回 undefined 不抛错）。
 */
function resolvePlannerChat(ctx: Context): PlannerChatFn | undefined {
  let llm: any;
  try {
    llm = (ctx as any).reflect?.get?.('llm') ?? ctx.get?.('llm');
  } catch { llm = undefined; }
  if (!llm) return undefined;

  if (typeof llm.stream === 'function') {
    // rc.6：流式 API。Planner 只需任意能用的模型 —— 目录全路由按序试，
    // 某路由空输出/报错则换下一个（真机战果：deepseek-v4-flash 恒空文本，
    // 单路由无重试 = Planner 永久瘫痪）。
    type LlmRoute = { provider: string; model: string };
    let cachedRoutes: LlmRoute[] | null = null;
    const listRoutes = async (): Promise<LlmRoute[]> => {
      if (cachedRoutes) return cachedRoutes;
      const routes: LlmRoute[] = [];
      try {
        const providers = (llm.listProviders?.() ?? []) as any[];
        for (const p of providers) {
          const pid = p?.id ?? p?.provider ?? (typeof p === 'string' ? p : null);
          if (!pid) continue;
          const models = (await llm.listModels?.(pid)) ?? [];
          for (const m of models) {
            const mid = m?.id ?? (typeof m === 'string' ? m : null);
            if (mid) routes.push({ provider: pid, model: mid });
          }
        }
      } catch { /* 目录不可用：routes 保持已收集部分 */ }
      cachedRoutes = routes;
      return routes;
    };
    return async (systemPrompt, user) => {
      const routes = await listRoutes();
      if (routes.length === 0) {
        throw new Error('[Planner] no llm provider/model resolvable from ctx.llm directory');
      }
      const errors: string[] = [];
      for (const route of routes) {
        try {
          let text = '';
          let reasoningTail = '';
          for await (const chunk of llm.stream({
            provider: route.provider,
            model: route.model,
            system: systemPrompt,
            messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
            // 推理模型默认把预算烧在思考上（真机战果：raw len=0）。effort='off'
            // 对支持它的模型关停思考；maxTokens 不设 —— 人为小预算会把输出全
            // 部烧在思考段（真机战果 #2：2048 全被 reasoning 吃掉，text 空）。
            reasoningEffort: 'off' as never,
          })) {
            if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
            if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
              reasoningTail = (reasoningTail + chunk.text).slice(-4000);
            }
          }
          // 兜底：个别 thinkingFormat 网关把最终内容留在 reasoning 流 —— text 空
          // 而思考尾部含 JSON 数组时取之（诚实回退，非模拟成功）
          const finalText = text.trim() ? text : (reasoningTail.includes('[') ? reasoningTail : '');
          if (finalText.trim()) return finalText;
          errors.push(`${route.model}: empty text`);
        } catch (e: any) {
          errors.push(`${route.model}: ${String(e?.message ?? e).slice(0, 80)}`);
        }
      }
      throw new Error(`[Planner] all ${routes.length} route(s) failed: ${errors.join('; ')}`);
    };
  }

  if (typeof llm.chat === 'function') {
    return async (systemPrompt, user) => {
      const res = await llm.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: user },
      ]);
      return typeof res === 'string' ? res : res?.content ?? JSON.stringify(res);
    };
  }
  return undefined;
}

export async function apply(ctx: Context, config: Config) {
  // 图像投递通道（rc.6 事件面）：附件服务在场则截图直达模型；缺席诚实降级为文本锚点。
  // cordis 4：未声明 inject 的服务属性直接访问会抛错 —— reflect.get 是无 inject 的可选读取面。
  let attachmentsSvc: unknown = null;
  try {
    attachmentsSvc = (ctx as any).reflect?.get?.('attachments') ?? null;
  } catch { attachmentsSvc = null; }
  setImageDeliveryStore(attachmentsSvc);
  if (!attachmentsSvc) {
    console.log('[Vision Plugin] attachments 服务不可用 —— 截图将只以文本锚点呈现（视觉通道降级）。');
  }

  console.log('[Vision Plugin] Initializing Pure Vision Computer Use...');

  // Y6：用户回合边界。旧实现的 markTaskStart 只在 start_complex_task 里调用，
  // 普通会话的 sinceTaskStart() 从会话起点切片 —— save_skill 把整个会话的
  // 历史动作（真机战果：95 步）全部录进一个本应两三步的技能，run_skill
  // 重放注定跑偏且后置条件必然稀释。订阅 session/event，用户每发一条
  // 消息即重置任务边界 —— 技能归纳的切片与"最近动作"语义对齐。
  // 纪元 Ξ（Ξ-A 进化存档与编排）：store / conductor 的闭包持有 —— 本钩子（节流
  // tick）与卸载清理（存档落盘）都需触达；实例在下方 registerProductionKernels()
  // 之后铸造，铸成前钩子即便先触发也只见 null（诚实空转，绝不炸）。
  let kernelStore: InstanceType<typeof KernelStore> | null = null;
  let conductor: InstanceType<typeof EvolutionConductor> | null = null;
  let turnBoundaryDisposer: (() => void) | null = null;
  try {
    const off = (ctx as any).on('session/event', (_session: unknown, ev: any) => {
      try {
        if (ev?.type !== 'user/message') return;
        const text = (ev.data?.content ?? []).map((p: any) => p?.text ?? '').join('');
        journal.markTaskStart(String(text).slice(0, 200) || 'user turn');
        // 纪元 Ξ（Ξ-A）：用户消息钩子内嵌编排器节流 tick —— conductor.enabled
        // false（缺省）⇒ maybeTick 恒空；节流窗内恒空；tick 有产出才落存档。
        // 异常全吞：进化是旁路义务，任何故障绝不炸用户消息钩子。
        try {
          if (conductor) {
            const calibrations = conductor.maybeTick();
            if (calibrations.length) kernelStore?.save(kernelRegistry, evidenceLedger);
          }
        } catch { /* 进化 tick 是旁路义务：静默 */ }
      } catch { /* 边界打标是旁路义务：事件形状异常不毒化主流程 */ }
    });
    if (typeof off === 'function') turnBoundaryDisposer = off;
  } catch {
    console.log('[Vision Plugin] session/event 面不可用 —— 技能切片退回 start_complex_task 边界。');
  }

  // 1. 配置注入系统层与上下文层（一切魔法数字由 cordis.yml 决定）
  system.configure(config);
  // 纪元 Ω（云脑皮层）：单例铸造（config 优先于 env；全空不动单例走 env 路径）
  // + semanticConfirm 第三路径开关接线（本地双路径皆败后的 VLM 兜底读屏）。
  configureVlm(config);
  setSemanticVlmOptions({ assistOcr: config.vlmAssistOcr });
  // 纪元 Λ（Λ-4 开箱即亮）：显式 config > 连接存档 > env 自动识别 > 本地自动接管 > 向导弹出。
  // 前四级全空（无 config 无 env 无已铸单例）才启动解析链；fire-and-forget ——
  // 绝不阻塞装载（swarm.fireUpload 先例）：本地探测 1.5s 止损与向导端口绑定都
  // 不该让用户的插件装载多等一拍，链内任何故障也被吞（不抛铁律 + .catch 双保险）。
  if (!config.vlmApiKey && !config.vlmProvider && !isGlmConfigured()) {
    void lightUpVision(ctx, config).catch(() => {});
  }
  // 纪元 Θ（Θ-4 生产接线）：十颗生产内核读点的入册（幂等、值全默认 ⇒ 零行为
  // 变化 —— 注册只是立册可行区间与器官归属，为 set/promoteFrom 开合法通道；
  // 不新增 config 字段，生产进化未接线，无开关）。
  registerProductionKernels();
  // 纪元 Ξ（Ξ-A 进化存档与进化编排）：生产入册后立即铸造 ——
  //   · 存档复载：kernelStatePath 有档 ⇒ 值（registry.set 夹取）+ 证据计数
  //     （addEvidence 增量补）回放进生产注册表（只认已注册 key，残迹静默）；
  //   · 编排器：kernelEvolutionEnabled 是生产进化总开关的运行时面（缺省 false
  //     ⇒ maybeTick 恒空 = 只记账不进化）。
  // 缺省行为零变化：kernelStatePath 空 ⇒ 纯内存存档（save no-op、load 恒 null）、
  // 开关关 ⇒ tick 恒空 —— 上一纪元的入册零行为承诺一字不破。
  kernelStore = new KernelStore(config.kernelStatePath || undefined);
  kernelStore.applyTo(kernelRegistry, evidenceLedger);
  conductor = new EvolutionConductor({
    registry: kernelRegistry,
    ledger: evidenceLedger,
    calibrator: new KernelCalibrator({ registry: kernelRegistry, ledger: evidenceLedger }),
  });
  conductor.enabled = config.kernelEvolutionEnabled;
  // B-6/B-7 创世纪参数随行：体积硬预算 + 遗像摘要开关（OCR 关时遗像自动退化为墓志铭）
  contextManager.configure(
    config.maxImageCount,
    config.maxContextImageKb,
    config.enableLegacySummary,
    config.legacySummaryMaxChars,
    config.enableOcr,
  );
  // C-4 认知焦点引擎：显著度驱逐 + 钉扎预算 + 潜意识池（cordis.yml 决定，非代码常量）
  contextManager.configureFocus(
    config.salienceFocus,
    config.pinBudget,
    config.subconsciousCapacity,
    config.subconsciousMatchDistance,
  );
  // C-5 群体智能：本地经验晶体恒开；endpoint 配置时启动联邦定时同步（非阻塞旁路）
  swarm.configure(config.swarmEndpoint, config.swarmSyncIntervalMs, config.crystalCapacity);
  swarm.start();
  // D-2 环境重塑：能力探测（永不抛错 —— 空能力集 = 诚实世界）+ 窗口委托注入。
  // switch_window 的债务清偿在此闭环：探测出 raise_window 能力才注入委托，否则保留降级路径。
  if (config.enableEnvironmentShaper) {
    shaper.configure(config.shaperAllowSystemWide, config.dryRun);
    await shaper.initialize();
    if (shaper.capabilities().has('raise_window')) {
      system.setWindowDelegate(async keyword => {
        const r = await shaper.apply({ kind: 'raise_window', titleHint: keyword });
        if (!r.ok) throw new Error(r.reason ?? 'raise_window failed');
        // Y6：命中标题随行 —— focus_handoff 取证在委托路径同样在场
        return { matched: r.matchedTitle ?? null };
      });
    }
  }
  // D-3 量子感知：验证连续失败 ⇒ 叠加态（白盒标注烧入截图，回归纯视觉闭环）。
  // 白盒源仅在元素 ID 模式可用（UiExtractor 基础设施复用）；无源时失败计数诚实累积但模式不动。
  if (config.enableQuantumSense) {
    quantum.configure(config.degradeAfterFailures, config.quantumRestoreOnSuccess, config.quantumMaxNodes);
    if (config.enableElementIdMode) quantum.setProvider(new UiExtractorWhitebox());
  }
  uiMemory.configure(config.uiMemoryCapacity);
  probeMemory.configure(config.probeMemoryCapacity); // Z-1d 判决记忆容量
  telemetry.configure(config.enableTelemetry);
  // 技能库：配置后从磁盘载入 —— 上一个会话学会的技能在本会话直接可用
  skillLibrary.configure(config.enableSkillLibrary, config.skillLibraryPath);
  skillLibrary.load();
  // 认知快照恢复（第七轮）：UI 记忆/技能/失败记忆/日志链/指标 —— 崩溃后原地满血。
  // 防御性恢复：逐子系统独立还原，单点损坏不拖垮整档。
  if (config.checkpointPath) {
    const cp = loadCheckpoint(config.checkpointPath);
    if (cp.restored) {
      console.log(`[Checkpoint] Restored: ${cp.report.join('; ')}`);
    } else {
      console.log(`[Checkpoint] Fresh start (${cp.report[0]}).`);
    }
  }

  // 2. 注入 System Prompt（可选服务，优雅降级）
  tryInjectPrompt(ctx, config);

  // 3. 工厂模式挂载工具（含条件启用的混合模式工具）
  // 桶经动态 import 装载（见文件头 Λ-4 注释）：apply 本就 async，多一拍微任务
  // 无语义差；宿主 bundler 视为普通分割点。
  const { buildAllTools } = await import('./tools/index');
  const tools = buildAllTools(config);
  tools.forEach(tool => ctx.tools.register(tool));
  console.log(`[Vision Plugin] Loaded ${tools.length} tools.`);

  // 4. 元工具：start_complex_task —— 一次调用展开为整个 Planner-Actor 子会话
  ctx.tools.register(defineTool({
    name: 'start_complex_task',
    description:
      'Use this tool ONLY when the user gives a complex, multi-step request that requires planning. ' +
      'It will break the task down and execute it step-by-step.',
    parameters: {
      userRequest: {
        type: 'string',
        required: true,
        description: 'The complex user request.',
      },
      time_budget_sec: {
        type: 'number',
        description: 'Optional wall-clock budget in seconds. On expiry the orchestrator returns partial results with a [TIMEOUT] marker.',
      },
    },
    output: {
      schema: { type: 'string' },
      // 显式标注：defineTool 嵌套于 ctx.tools.register(...) 时 TS 上下文类型断链（推断限制，非契约缺口）
      render: (_args: any, value: any) => [{ type: 'text', text: value }],
    },
    async execute(args: any) {
      // Planner：llm 服务可用则真实拆解，否则 orchestrator 空计划守卫会响亮报告
      const chat = resolvePlannerChat(ctx);

      // Actor：K 纪元已兑现（createActor 双通道）—— ① DSH agents 子 Agent 循环
      // （在场时）② 技能重放回退；双缺席才诚实 [FAILED]（地层教训：simulated
      // success 是债 —— fail-fast 协议立即中止并如实上报）。
      // K 纪元（留白兑现）：Actor 双通道接线 —— ① DSH agents 服务（在场时）
      // ② 技能重放回退（可靠匹配的子任务直接重放）；双缺席才诚实 [FAILED]。
      const actorFn = createActor({
        getAgentsRun: () => {
          const agents = (ctx as any).get?.('agents') as
            { run?: (subtask: string, systemPrompt: string) => Promise<string> } | undefined;
          return typeof agents?.run === 'function' ? agents.run.bind(agents) : null;
        },
        matchSkill: q => config.enableSkillLibrary
          ? skillLibrary.match(q).map(m => ({
              id: m.id,
              // Laplace 可靠度（与肌肉记忆同律）：未经真实验证的 0/0 = 0.5 不入场
              reliability: (m.successCount + 1) / (m.attemptCount + 2),
              // Y6：匹配分随行 —— Actor 侧据此拦截"可靠但无关"的技能顶替子任务
              score: m.score,
              steps: m.steps.map(s => ({ tool: s.tool, args: s.args as Record<string, unknown> })),
            }))
          : [],
        // Δ 纪元（审计#1）：重放步透传插件配置 —— 技能回退与 live 工具同闸门
        replayStep: (tool, args) => import('./tools/replayActions').then(m => m.replayOne({ tool, args: args as Record<string, any> }, config)),
        recordOutcome: (id, success) => skillLibrary.recordOutcome(id, success),
      });

      // 技能归纳准备：任务起点打标 + 入口场景指纹（成功轨迹的切片边界）
      journal.markTaskStart(args.userRequest);
      const entryScene = contextManager.lastImageRecord()?.hash;

      const report = await runOrchestrator(
        args.userRequest, actorFn, chat,
        args.time_budget_sec ? args.time_budget_sec * 1000 : undefined,
      );

      // 自动归纳（第五轮）：任务无失败标记且确有可重放轨迹 ⇒ 固化为技能。
      // 同一步骤序列重复出现时只强化既有技能的可靠度，不堆卡片。
      if (
        config.autoInduceSkills && config.enableSkillLibrary &&
        report && !report.includes('[FAILED]') && !report.includes('[TIMEOUT]') &&
        !report.startsWith('[Planner]')
      ) {
        const skill = skillLibrary.induceFromJournal(args.userRequest, entryScene);
        if (skill) {
          console.log(`[Skill] Induced #${skill.id} "${skill.name}" (${skill.steps.length} steps) from a successful task.`);
        }
      }

      // Δ 纪元（审计#4）：计划式 fail-fast 与自主闭环双轨互通——
      // 计划失败且自主环开启时，报告尾部给出转轨建议（不自动执行，裁决权在模型）。
      if (
        config.autonomyEnabled && report &&
        (report.includes('[FAILED]') || report.includes('[TIMEOUT]') || report.startsWith('[Planner]'))
      ) {
        return report + '\n[Autonomy] 计划式执行未竟。可调用 autonomous_run(goal) 让自主智能环接手（识别→判断→执行闭环，宪法守护，危险动作将升级 ACTION_REQUIRED）。';
      }

      return report;
    },
  }));

  // 4.5 元工具：delegate_to_pipeline —— D-1 → 流水线的交班面（P0-3 发射端补全）。
  //     此前 cognition/plan-ready 只有消费侧（D-5/D-6/D-7 三处接线）而发射端缺席 ——
  //     事件面是死通道。本工具是 D-1 主权的唯一交班出口：意图铸造 → 事件总线广播，
  //     D-7 隐知识流水线主消费（P1-3 仲裁），D-5 只认 chain 臂（意图臂静默让渡）。
  ctx.tools.register(defineTool({
    name: 'delegate_to_pipeline',
    description:
      'DELEGATION — hand a goal to the autonomous execution pipeline instead of driving each step yourself. ' +
      'The intent is minted and announced on the event bus (cognition/plan-ready); the D-7 knowledge-enhanced ' +
      'pipeline is the primary consumer (P1-3 arbitration). Fire-and-forget: pipeline results arrive via ' +
      'knowledge/run-end events and a reportPath handle — NOT in this tool\'s return value. ' +
      'Use start_complex_task only when you must steer every subtask yourself.',
    parameters: {
      goal: {
        type: 'string', required: true,
        description: `Abstract goal (<=${GOAL_MAX_CHARS} chars, e.g. "sign in to the portal").`,
      },
      success_criteria: {
        type: 'string',
        description: `Verifiable completion criteria (<=${SUCCESS_CRITERIA_MAX_CHARS} chars).`,
      },
      budget_ms: {
        type: 'number',
        description: 'Optional wall-clock budget for the whole pipeline run.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: any, value: any) => [{ type: 'text', text: value }],
    },
    async execute(args: any) {
      const goal = String(args.goal ?? '').slice(0, GOAL_MAX_CHARS);
      if (!goal) return JSON.stringify({ status: 'FAILED', reason: 'goal is required' });
      const intent = mintIntentPlanReady({
        id: `intent-d1-${Date.now().toString(36)}`,
        goal,
        successCriteria: args.success_criteria ? String(args.success_criteria) : undefined,
        budgetMs: typeof args.budget_ms === 'number' ? args.budget_ms : undefined,
      });
      // 发射守卫：事件面故障是旁路义务（emitCognitionPlanReady 内部吞错）
      emitCognitionPlanReady(ctx, intent);
      // 紧凑交班回执（Token 纪律）：只回定位锚，执行证据走 reportPath
      return JSON.stringify({
        status: 'DELEGATED',
        intent_id: intent.id,
        channel: COGNITION_PLAN_READY_EVENT,
        primary_consumer: 'dsh.knowledge-pipeline (D-7)',
        note: 'fire-and-forget — watch knowledge/run-end events for the verdict',
      });
    },
  }));

  // 5. 挂载守卫（边界 / 熔断 / 审计 / 弹窗联动）
  registerAllGuards(ctx, config);
  console.log('[Vision Plugin] Security Guards activated.');

  // 5.2 D-4 判决回执通道（P0-4 发射端补全）：rehearsal-end → 自主诊断 → doctor/verdict。
  //     此前 doctor/verdict 三方消费侧（D-5 固化闸门 / D-6 判决索引 / D-7 验收结算门）
  //     全部接线而发射端缺席 —— 判决回执是死通道，D-5 固化只能永远冻结。
  wireDoctorVerdictChannel(ctx, config);

  // 5.5 D-1 子代理步数记账：复用 journal 同款 onToolPost 观察位 —— 对管线零新增侵入。
  //     无活跃代理时 chargeStep 直通返回（与 B/C 世代行为逐字节一致）。
  if (config.enableSubAgents) {
    coordinator.configure(config.maxSubAgents, config.agentRoundSteps);
    onToolPost(ctx, async (call, result, next) => {
      coordinator.chargeStep(call.name);
      return next(result);
    });
  }

  // 6. 上下文注入接线（原版游离的「最后一块拼图」，至此闭环）：
  //    无论截了多少图，每次请求发给模型的永远是滑动窗口内的图片 + 旧图文字占位符
  onLlmPreRequest(ctx, (payload) => {
    const managed = contextManager.getContextForModel();
    const images = managed.filter(block => block.type === 'image');
    if (images.length === 0 || !Array.isArray(payload.messages)) return;
    // 注入为末位消息；具体挂载位（system/user/tool-result）以目标 DSH 版本的消息 schema 为准
    payload.messages.push({ role: 'user', content: managed });
  });

  // 7. 生命周期清理（DSH 规范：ctx.effect 必须返回清理函数）
  ctx.effect(() => {
    console.log('[Vision Plugin] Unloaded, cleaning up system resources...');
    return () => {
      // D-2 复原尽力而为（cleanup 不能 await）：restoreAll 异步启动；若与落盘竞速未及完成，
      // 残余义务随 checkpoint 交棒下次加载（restoreUndoLog 只认领未复原条目）——失败安全而非假装完成。
      // clearUndoLog 不得在此同步执行：restoreAll 的弹栈循环每次迭代都读 this.undoLog[i]，
      // 中途抽走数组会让后续迭代拿到 undefined 直接崩掉复原（见下方 !shaperRestoring 分支）。
      let shaperRestoring = false;
      if (config.enableEnvironmentShaper && config.shaperAutoRestore && shaper.undoDepth() > 0) {
        shaperRestoring = true;
        shaper.restoreAll().then(results => {
          const failed = results.filter(r => !r.ok).length;
          console.log(`[Shaper] Restored ${results.length - failed}/${results.length} change(s) on unload` +
            (failed ? ` (${failed} duties survive in the undo log)` : ''));
          shaper.clearUndoLog();
        }).catch(e => console.warn(`[Shaper] restoreAll failed on unload: ${e.message}`));
      }
      // 认知快照先行（第七轮）：在任何内存清空前落盘 —— 崩溃恢复的最后防线
      if (config.checkpointPath) {
        const r = saveCheckpoint(config.checkpointPath);
        console.log(r.ok
          ? `[Checkpoint] Saved atomically (${r.steps} chained entries).`
          : `[Checkpoint] Save failed: ${r.error}`);
      }
      // 纪元 Ξ（Ξ-A）：进化存档落盘 —— checkpoint 之后、一切 reset 之前（值/
      // 证据/代际在内存清空前交棒下次加载；空路径 ⇒ save no-op；异常吞：
      // 卸载路径不因存档失败而中断后续清理）。
      try { kernelStore?.save(kernelRegistry, evidenceLedger); } catch { /* 进化存档是旁路义务 */ }
      // C-5 群体智能：卸载前最后一次结晶 + 尽力上报（fire-and-forget，不阻塞卸载）
      swarm.syncNow();
      swarm.reset();
      telemetry.reset();         // 指标与生命周期同归
      contextManager.reset();      // 清空截图滑动窗口
      uiMemory.reset();            // 清空场景记忆（可选保留跨会话记忆：删除此行）
      probeMemory.reset();          // Z-1d 同律：清空判决记忆
      journal.reset();             // 清空行动日志
      try { turnBoundaryDisposer?.(); } catch { /* already disposed */ }
      updatePopupState(false);     // 复位弹窗传感状态
      resetPopupBelief();          // F-3 复位贝叶斯弹窗信念（迟滞滤波器归零）
      resetPopupSprt();            // Δ 审计#6：SPRT 终判不可逆——会话边界必须归零，否则判决跨会话永存
      oscillationTracker.reset();  // Δ 审计#6：环检测缓冲归零（同 W-1 单例隔离律）
      resetElementTracker();       // Δ 审计#6：跨帧元素 ID 跟踪归零
      focusTracker.clear();        // Δ 审计#6：焦点登记清空（30s 过期之外的显式归零）
      resetDiffPersistence();      // G-1 复位差分持续性观测史（TDA 环归零）
      skillLibrary.save();         // 技能落盘后仅清内存 —— 技能的寿命长于会话
      skillLibrary.reset();
      failureMemory.reset();       // 失败记忆与技能库对称：已随 checkpoint 持久化
      coordinator.reset();         // D-1 团队解散（报告已随 checkpoint 持久化）
      system.setWindowDelegate(null); // D-2 委托解除（下次加载按新探测重建）
      if (!shaperRestoring) shaper.clearUndoLog(); // D-2 弃责记账（restoreAll 在场时由其落定后自行清）
      quantum.reset();             // D-3 感知相位归零（快照已随 checkpoint 交棒）
      void disposeOcr();           // 终止 OCR worker（语言数据有磁盘缓存，重载后即用）
      void stopBackend();          // D-5 物理微服务优雅关停（SIGTERM→SIGKILL；被收养的外部实例不受影响）
    };
  });

  console.log('[Vision Plugin] Initialization complete! Ready for action.');
}
