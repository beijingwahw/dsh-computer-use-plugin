// src/knowledge/index.ts
// D-7 隐知识增强中枢 —— DSH 插件入口（第七器官降生）。
// 物理法则合规：
//   一切皆插件     → 标准 apply(ctx, config)，name/inject 导出
//   依赖驱动加载   → inject: tools（必需）+ dsh.cognition? / dsh.host-executor? / dsh.vision.station?
//                    （可选，缺席时对应工位诚实降级 —— 桩纪元常态）
//   可逆注册与隔离 → 一切监听与内存资源随 ctx.effect 登记清理（Cordis 注册即效果模型）
//   事件总线通信   → 与 D-1/D-4 零直接调用：plan-ready 消费 + doctor/verdict 回执桥，
//                    双方言单适配器（D-4 事件方言 → D-7 内部方言）单点收口于本文件
//   可观测性对齐   → knowledge/* 三事件 Skinny 载荷 + reportPath 句柄（Token 纪律）
// 零侵入红线：不修改任何既有文件 —— 与 D-5（sandbox）/ D-6（orchestration）并存为第七器官。
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { InMemoryKnowledgeBase, CONTENT_MAX_CHARS } from './knowledgeBase';
import { KnowledgePipelineOrchestrator } from './pipeline';
import { StubVisionStation, ReflexiveDecisionStation, StubExecutionStation } from './stations';
import { DoctorVerdictBridge, toD7Intent } from './adapters';
import { COGNITION_PLAN_READY_EVENT, onDoctorVerdict } from '../sandbox/events';
import type { IntentPayload, PipelineConfig } from './contracts';
import {
  D7PhysicalHostPort,
  type D7PhysicalHostPortOpts,
} from '../physicalExecution';

export { InMemoryKnowledgeBase, distillInjection, CONTENT_MAX_CHARS } from './knowledgeBase';
export { KnowledgePipelineOrchestrator } from './pipeline';
export {
  StubVisionStation, StubDecisionStation, StubExecutionStation,
  ReflexiveDecisionStation, createCapabilitySceneSource,
} from './stations';
export { DoctorVerdictBridge, toD7Intent, translateVerdict } from './adapters';
export type {
  AttentionEnvelope, D7StationKind, KnowledgeBase, KnowledgeEntry, KnowledgeInjection, KnowledgeQuery,
  KnowledgeResult, KnowledgeCategory, KnowledgeError, IntentPayload, NeedGrounding,
  PerceptionRequest, DoctorVerdictPayload, ExecutionResult, ExecutionOutcome,
  OutcomeSettlement, DecisionContext, FailureFeedback, PipelineReport, PipelineConfig,
  ConfigError, PipelineOrchestrator, Result,
} from './contracts';

export const name = 'knowledge-plugin';

// 可选依赖 '?' 语法：缺席不阻断加载，对应能力诚实降级（桩纪元常态）
export const inject = ['tools', 'dsh.cognition?', 'dsh.host-executor?', 'dsh.vision.station?'];

// D-7 中枢人格（桩纪元行为准则内嵌于工具描述 —— DSH 模式：工具即角色的躯壳）
const KNOWLEDGE_DOCTRINE =
  'You are the Tacit-Knowledge Hub — the evolving memory of this digital organism. ' +
  'KNOWLEDGE-FIRST: consult the knowledge base before every decision, but never let retrieval stall ' +
  'the pipeline (>50ms degrades to no-knowledge mode — honesty over latency). ' +
  'CONTRACT-DRIVEN: only strongly-typed structures cross station boundaries, never prose. ' +
  'HONEST FAILURE: every method returns Result and degrades gracefully — nothing ever throws. ' +
  'CLOSED-LOOP EVOLUTION: every executed outcome feeds back as auto-learned knowledge.';

/** 网格缺省（独立常量：PipelineConfig.regionGrid 是可选字段，避免 undefined 域泄漏） */
const DEFAULT_REGION_GRID = { cols: 2, rows: 2 } as const;

/** knowledge_query 工具面内容预览预算（Token 纪律 —— 对话流只见截断预览，全量走知识库） */
const QUERY_PREVIEW_MAX_CHARS = 80;

/** D-7 配置缺省（cordis.yml 覆盖；防卡顿铁律的结构缺省：knowledgeTimeout=50ms）。
 *  stationTokenBudgets（P1-2 config-driven）：预算治理入配置域。
 *  consumePlanReady（P1-3 仲裁对称立法）：缺省 true —— D-7 是 plan-ready 通道的
 *  主消费端；置 false 让渡（如意图路由协议改由 D-6 消费的部署拓扑）。 */
const DEFAULT_CONFIG: PipelineConfig & { consumePlanReady: boolean } = {
  regionGrid: DEFAULT_REGION_GRID,
  timeout: { overall: 120_000, perStep: 30_000, perPerception: 10_000 },
  retryPolicy: { maxRetries: 3, backoffMs: 500, maxBackoffMs: 5_000 },
  knowledgeTimeout: 50,
  knowledgeMaxResults: 5,
  knowledgeMaxChars: 300,
  stationTokenBudgets: { vision: 0, decision: 2000, execution: 0 },
  consumePlanReady: true,
};

export async function apply(ctx: Context, config?: Partial<PipelineConfig> & { consumePlanReady?: boolean }): Promise<void> {
  console.log('[Knowledge] Initializing Tacit-Knowledge Enhanced Hub (D-7)...');

  const knowledge = new InMemoryKnowledgeBase();
  const orchestrator = new KnowledgePipelineOrchestrator();

  // 配置深合并（嵌套组 partial 覆盖）—— 加载门在 apply 收口：configure Result !ok ⇒ throw
  const merged: PipelineConfig & { consumePlanReady: boolean } = {
    ...DEFAULT_CONFIG,
    ...config,
    timeout: { ...DEFAULT_CONFIG.timeout, ...(config?.timeout ?? {}) },
    retryPolicy: { ...DEFAULT_CONFIG.retryPolicy, ...(config?.retryPolicy ?? {}) },
    stationTokenBudgets: { ...DEFAULT_CONFIG.stationTokenBudgets!, ...(config?.stationTokenBudgets ?? {}) },
    regionGrid: config?.regionGrid ?? DEFAULT_REGION_GRID,
    consumePlanReady: config?.consumePlanReady ?? DEFAULT_CONFIG.consumePlanReady,
  };
  const cfgResult = orchestrator.configure(merged);
  if (!cfgResult.ok) {
    throw new Error(`[Knowledge] invalid configuration — ${cfgResult.error.field}: ${cfgResult.error.reason}`);
  }

  // ── 可选服务探测（探测侧收窄：方法在场才构成合法端口 —— 诚实降级）──
  const cognitionService = (ctx as any).get?.('dsh.cognition') as
    | { chat?: (prompt: string) => Promise<string> }
    | undefined;
  const chat = cognitionService?.chat ?? null;

  const rawHost = (ctx as any).get?.('dsh.host-executor') as
    | { execute?: (action: any) => Promise<any> }
    | undefined;
  // 批次 D：默认实现切换 —— 外部 dsh.host-executor 缺席时，
  // 启用 D7PhysicalHostPort（D-5 微服务默认执行路径），彻底抛弃 nut-js。
  // 启动哲学：懒启动（第一次 execute() 才 spawn Python，构造器不阻塞）。
  let d7MicroserviceHost: D7PhysicalHostPort | null = null;
  let host: { execute: (action: any) => Promise<any> } | null = null;
  if (rawHost?.execute) {
    host = rawHost as { execute: NonNullable<typeof rawHost.execute> };
  } else {
    const msOpts = (config as any)?.physicalService as Partial<D7PhysicalHostPortOpts> | undefined;
    d7MicroserviceHost = new D7PhysicalHostPort(msOpts);
    host = d7MicroserviceHost;
    console.log('[Knowledge] D-5 physical microservice host armed (lazy start on first execute) — ' +
      'goodbye nut-js.');
  }

  const rawVision = (ctx as any).get?.('dsh.vision.station') as
    | { perceive?: (req: any) => Promise<any[]> }
    | undefined;
  let sceneSource: { perceive: (req: any) => Promise<any[]> } | null = rawVision?.perceive
    ? (rawVision as { perceive: NonNullable<typeof rawVision.perceive> })
    : null;
  // P1-4 能力回退：外部视觉服务缺席 ⇒ 插件自身能力顶上（L1 无障碍树 > L2 OCR，
  // 经 createCapabilitySceneSource 适配为 SceneSourcePort）。system（nut-js 原生）
  // 动态引入：沙箱/无屏环境 import 失败 ⇒ 回退源缺席（fault 补丁诚实降级）。
  if (!sceneSource) {
    try {
      const { createCapabilitySceneSource } = await import('./stations');
      const { system } = await import('../system');
      sceneSource = await createCapabilitySceneSource({
        screenSize: () => system.getScreenSize(),
        capture: () => system.captureScreen(),
      });
      console.log('[Knowledge] capability scene source wired (L1 a11y > L2 OCR — fallback layer).');
    } catch {
      console.log('[Knowledge] capability scene source unavailable (native deps absent).');
    }
  }
  // 感知回退链末节：D-5 微服务躯体的感知面（getUiTree 反双盲漏斗）。
  // capability 源也缺席（无 a11y / 无 OCR 的 headless 环境）⇒ 同一物理躯体顶上 ——
  // 感知与执行第一次跑在同一 Python 进程上（双端口躯体，零二次 spawn）。
  if (!sceneSource && d7MicroserviceHost) {
    sceneSource = d7MicroserviceHost;
    console.log('[Knowledge] D-5 microservice scene source wired (dual-port body: perceive + execute).');
  }

  // ── 工位接线（index.ts 是唯一接线点）──
  const vision = new StubVisionStation({ source: sceneSource });
  // 决策纪元切换：反射决策工位 —— chat 在场走 LLM（大脑），缺席走脊髓反射弧 +
  // 免疫抑制（error-pattern 高置信 ⇒ 手在陷阱前停住）。桩纪元的「无 LLM 即恒
  // NeedGrounding」终结：无大模型也有真实、确定、可审计的决策智能。
  const decision = new ReflexiveDecisionStation({ chat });
  const execution = new StubExecutionStation({ host });

  // ── D-4 判决回执桥（P0-4）：事件方言缓存 → 验收结算门（subject = `${intentId}:${seq}`）──
  // 翻译（D-4 事件方言 → D-7 内部方言）单点收口于 adapters.translateVerdict ——
  // 本文件只做接线，绝不二次立法（双方言单适配器铁律）。
  const verdictBridge = new DoctorVerdictBridge();
  onDoctorVerdict(ctx, p => verdictBridge.ingest(p));

  orchestrator.wire(
    {
      vision, decision, execution, knowledge, verdictBridge,
      emit: (ev, payload) => { try { (ctx as any).emit(ev, payload); } catch { /* 发射失败是旁路义务 */ } },
    },
    { reportDir: (config as any)?.reportDir ?? '' },
  );

  // ── 事件总线接线（与 D-1 的唯一咬合通道：意图投喂 → 流水线主循环入口）──
  // P1-3 仲裁对称立法：D-7 缺省主消费（consumePlanReady=true）；置 false 让渡
  // （意图路由协议改由 D-6 消费的部署拓扑 —— 双端各有一个开关，永不双流水线抢跑）。
  if (merged.consumePlanReady) {
    (ctx as any).on(COGNITION_PLAN_READY_EVENT, async (payload: any) => {
      const intent = normalizeIntent(payload);
      if (!intent) {
        console.warn('[Knowledge] plan-ready payload unrecognizable — ignored (honest degradation).');
        return;
      }
      const report = await orchestrator.run(intent);
      // 紧凑数字战报（Token 纪律）：全量证据在 reportPath
      console.log(`[Knowledge] Pipeline ${report.intentId}: verdict=${report.verdict} ` +
        `outcomes=${report.outcomes.length} knowledgeUsed=${report.knowledgeUsed !== null} ` +
        `report=${report.reportPath}`);
    });
  } else {
    console.log('[Knowledge] plan-ready channel conceded (consumePlanReady=false — ' +
      'ensure exactly one pipeline consumes the channel).');
  }

  // ── 工具面（对话流只见紧凑数字 + reportPath 句柄）──

  ctx.tools.register(defineTool({
    name: 'knowledge_query',
    description: KNOWLEDGE_DOCTRINE + ' Query the tacit-knowledge base before deciding. ' +
      `Returns compact entries (id, category, confidence, content<=${QUERY_PREVIEW_MAX_CHARS} chars) — never full dumps.`,
    parameters: {
      scene_description: { type: 'string', required: true, description: 'Current scene summary (what is on screen).' },
      intent_description: { type: 'string', required: true, description: 'What the organism is trying to do.' },
      max_results: { type: 'number', required: false, description: 'Max entries to return (default 5).' },
      min_confidence: { type: 'number', required: false, description: 'Min confidence filter, 0-1.' },
    },
    output: { schema: { type: 'string' }, render: (_a: any, v: any) => [{ type: 'text', text: v }] },
    async execute(args: any) {
      const r = knowledge.query({
        sceneDescription: String(args.scene_description ?? ''),
        intentDescription: String(args.intent_description ?? ''),
        maxResults: typeof args.max_results === 'number' ? args.max_results : undefined,
        minConfidence: typeof args.min_confidence === 'number' ? args.min_confidence : undefined,
      });
      if (!r.ok) return JSON.stringify({ status: 'FAILED', field: r.error.field, reason: r.error.reason });
      return JSON.stringify({
        status: 'SUCCESS',
        entries: r.value.entries.map(e => ({
          id: e.id, category: e.category, confidence: e.confidence,
          content: e.content.slice(0, QUERY_PREVIEW_MAX_CHARS),
        })),
        latency_ms: r.value.latencyMs,
        strategy: r.value.strategy,
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'knowledge_insert',
    description: 'Insert a manual tacit-knowledge entry (category taxonomy: ui-pattern | shortcut | ' +
      `system-quirk | business-rule | error-pattern | workflow | preference; confidence 0-1; content<=${CONTENT_MAX_CHARS} chars).`,
    parameters: {
      category: { type: 'string', required: true, description: 'Knowledge category (see taxonomy).' },
      content: { type: 'string', required: true, description: `Knowledge content, <=${CONTENT_MAX_CHARS} chars.` },
      scenario: { type: 'string', required: true, description: 'Scenario where this knowledge applies.' },
      confidence: { type: 'number', required: true, description: 'Confidence in [0,1] — out-of-domain is rejected, never clamped.' },
      intent_ref: { type: 'string', required: false, description: 'Optional originating intent id.' },
    },
    output: { schema: { type: 'string' }, render: (_a: any, v: any) => [{ type: 'text', text: v }] },
    async execute(args: any) {
      const r = knowledge.insert({
        category: args.category,
        content: String(args.content ?? ''),
        scenario: String(args.scenario ?? ''),
        confidence: Number(args.confidence),
        source: 'manual',
        intentRef: args.intent_ref ? String(args.intent_ref) : undefined,
      });
      if (!r.ok) return JSON.stringify({ status: 'FAILED', field: r.error.field, reason: r.error.reason });
      return JSON.stringify({ status: 'SUCCESS', entry_id: r.value });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'run_knowledge_pipeline',
    description: KNOWLEDGE_DOCTRINE + ' Run the knowledge-enhanced pipeline (parallel perception + knowledge ' +
      'retrieval → decision → execution → outcome learning). Returns compact numbers only; full evidence at reportPath.',
    parameters: {
      description: { type: 'string', required: true, description: 'Intent description (what to achieve).' },
    },
    output: { schema: { type: 'string' }, render: (_a: any, v: any) => [{ type: 'text', text: v }] },
    async execute(args: any) {
      const description = String(args.description ?? '').slice(0, 160);
      if (!description) return JSON.stringify({ status: 'FAILED', reason: 'description is required' });
      const intent: IntentPayload = { id: `intent-kb-${Date.now().toString(36)}`, description };
      const report = await orchestrator.run(intent);
      return JSON.stringify({
        status: report.verdict === 'completed' ? 'SUCCESS' : 'FAILED',
        verdict: report.verdict,
        intent_id: report.intentId,
        outcomes: report.outcomes.length,
        knowledge_used: report.knowledgeUsed !== null,
        terminal_reason: report.terminalReason,
        report: report.reportPath,
      });
    },
  }));

  console.log('[Knowledge] 3 knowledge tools registered (knowledge_query / knowledge_insert / run_knowledge_pipeline).');
  console.log(chat
    ? '[Knowledge] D-1 cognition chat channel detected — decision station armed.'
    : '[Knowledge] D-1 cognition chat channel absent — decisions degrade to need-grounding (honest).');
  if (rawHost?.execute) {
    console.log('[Knowledge] External host-executor detected — execution station armed (delegating).');
  } else if (d7MicroserviceHost) {
    console.log('[Knowledge] D-5 microservice host armed (lazy start) — goodbye nut-js.');
  } else {
    console.log('[Knowledge] Host executor absent — executions degrade to host-error (honest).');
  }

  // ── 可逆注册：一切资源登记清理（Cordis 注册即效果模型）──
  ctx.effect(() => {
    console.log('[Knowledge] Unloading, rolling back resources...');
    return async () => {
      // 批次 D：D-5 微服务关停（SIGTERM → 3s → SIGKILL，原子性：即使后续代码报错也保证执行）
      if (d7MicroserviceHost) {
        try {
          await d7MicroserviceHost.dispose();
          console.log('[Knowledge] D-5 physical microservice shut down cleanly.');
        } catch (e: any) {
          console.warn(`[Knowledge] D-5 microservice dispose degraded: ${e?.message ?? String(e)}`);
        }
      }
      const r = orchestrator.dispose(); // 知识库归零 + 编排器状态回滚
      if (!r.ok) console.warn(`[Knowledge] dispose degraded: ${r.error.message}`);
      verdictBridge.reset(); // 判决桥归零：回执缓存 + 挂账等待室零残留
      console.log('[Knowledge] Unloaded. Zero residue.');
    };
  });

  console.log('[Knowledge] Initialization complete! The evolving memory stands ready.');
}

// ─── 载荷归一化：cognition/plan-ready 的宽容解码（D-7 | D-6 | ActionChain 三方言皆可）───

function normalizeIntent(payload: any): IntentPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  // D-7 方言：已是 IntentPayload
  if (typeof payload.id === 'string' && typeof payload.description === 'string' && payload.description) {
    return {
      id: payload.id,
      description: payload.description.slice(0, 160),
      previousResults: Array.isArray(payload.previousResults) ? payload.previousResults : undefined,
    };
  }
  // D-6 方言：goal → description 经 adapters.toD7Intent 单点翻译（P0-2 —— 翻译点唯一）
  if (typeof payload.id === 'string' && typeof payload.goal === 'string' && payload.goal) {
    return toD7Intent({
      id: payload.id,
      goal: payload.goal,
      successCriteria: typeof payload.successCriteria === 'string' ? payload.successCriteria : undefined,
      budgetMs: typeof payload.budgetMs === 'number' ? payload.budgetMs : undefined,
      source: payload.source === 'user' ? 'user' : 'cognition',
      planVersion: typeof payload.planVersion === 'string' ? payload.planVersion : undefined,
    });
  }
  // 既有方言：D-1 的 CognitionPlanReadyPayload.chain（ActionChain）
  if (payload.chain && Array.isArray(payload.chain.actions) && payload.chain.actions.length > 0) {
    const chain = payload.chain;
    const description = `execute ${chain.actions.length}-step action chain (${chain.actions.map((a: any) => a.kind).slice(0, 5).join('→')}${chain.actions.length > 5 ? '…' : ''})`;
    return { id: `intent-from-${chain.id}`, description: description.slice(0, 160) };
  }
  return null;
}
