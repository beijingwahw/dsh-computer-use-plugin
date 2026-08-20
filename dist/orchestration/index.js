import { defineTool } from '@deepseek-ai/dsh-tools';
import { PipelineOrchestratorImpl } from './pipeline.js';
import { COGNITION_PLAN_READY_EVENT, onDoctorVerdict } from '../sandbox/events.js';
import { GOAL_MAX_CHARS, SUCCESS_CRITERIA_MAX_CHARS } from './contracts.js';
export { PipelineOrchestratorImpl } from './pipeline.js';
export { DefaultVisionStation, DefaultDecisionStation, DefaultExecutionStation } from './stations.js';
export { createStructuredFromUiExtractor, createTraditionalFromOcr } from './visionAdapters.js';
export { GOAL_MAX_CHARS, SUCCESS_CRITERIA_MAX_CHARS } from './contracts.js';
export const name = 'orchestration-plugin';
// 可选依赖 '?' 语法：缺席不阻断加载，对应能力诚实降级
export const inject = ['tools', 'dsh.sandbox?', 'dsh.cognition?', 'dsh.quality-doctor?'];
// D-6 中枢人格（四工位行为准则内嵌于工具描述 —— DSH 模式：工具即角色的躯壳）
const PIPELINE_DOCTRINE = 'You are the Multi-Agent Orchestration Hub — the central nervous system of this digital organism. ' +
    'ATTENTION ISOLATION: each station sees only its envelope (vision never sees intent; execution never sees rationale). ' +
    'CONTRACT-DRIVEN: stations exchange only strongly-typed structures, never prose. ' +
    'HONEST FAILURE: any station failure is captured structurally and routed — cancelled never retries; ' +
    'timeout kills one attempt, not the pipeline. ' +
    'TOKEN DISCIPLINE: reports are compact numbers + a reportPath handle; the conversation sees results, never noise.';
/** D-6 配置缺省（cordis.yml 覆盖；魔法数字不落代码常量的例外 —— 本表即缺省契约）。
 *  consumePlanReady 缺省 false —— P1-3 仲裁立法：plan-ready 通道归 D-7 主消费，
 *  D-6 显式 opt-in 才夺回（同通道双流水线执行 = 物理级事故）。 */
const DEFAULT_CONFIG = {
    maxDecisionRetries: 3,
    regionGrid: { cols: 2, rows: 2 },
    stationTokenBudgets: { vision: 2000, decision: 8000, execution: 0 },
    rehearseBeforeExecute: true,
    attemptTimeoutMs: 30000,
    perceptionDeadlineMs: 10000,
    consumePlanReady: false,
};
// ─── 内部状态（模块级：工具闭包与事件处理器共享；reset 归零）───
// 有界化（风险加固）：长会话下 run/判决持续到达，无界 Map = 缓慢泄漏 ——
// FIFO 上限淘汰最旧记录（工具面的历史查询语义本就是"近期可查"）。
const MAX_LIVE_REPORTS = 200;
const MAX_VERDICT_INDEX = 500;
const inflightReports = new Map();
const attemptVerdicts = new Map(); // key: `${intentRef}:${seq}`
/** 有界 Map 写入：重写刷新插入序，超限 FIFO 淘汰最旧键（Map 迭代序 = 插入序） */
function boundedSet(map, key, value, cap) {
    map.delete(key);
    map.set(key, value);
    while (map.size > cap) {
        const oldest = map.keys().next().value;
        if (oldest === undefined)
            break;
        map.delete(oldest);
    }
}
/** budgetMs 域判别：正有限数才合法（负数瞬死 / NaN 永不超时都毒化 intent 层时钟） */
function isPositiveFinite(n) {
    return typeof n === 'number' && Number.isFinite(n) && n > 0;
}
export async function apply(ctx, config) {
    console.log('[Orchestration] Initializing Multi-Agent Orchestration Hub (D-6)...');
    const orchestrator = new PipelineOrchestratorImpl();
    // 《异常诚实分层契约》D-7 修正案对齐（P0-1）：configure Result 降级（运行层，永不 throw）；
    // 加载门收口于本 apply —— Result !ok ⇒ throw 拒绝带病上线
    const merged = { ...DEFAULT_CONFIG, ...config };
    const cfgResult = orchestrator.configure(merged);
    if (!cfgResult.ok) {
        throw new Error(`[Orchestration] invalid configuration — ${cfgResult.error.field}: ${cfgResult.error.reason}`);
    }
    // ── 可选服务探测（dsh.sandbox：D-5 引擎实例 —— 执行工位预演通道）──
    // 探测侧收窄：只有 rehearse 方法在场的对象才构成合法 SandboxStationView（诚实降级）
    const rawSandbox = ctx.get?.('dsh.sandbox');
    const sandboxService = rawSandbox?.rehearse
        ? rawSandbox
        : null;
    // ── 工位接线（默认骨架；适配器注入真机源 —— index.ts 是唯一接线点）──
    const { DefaultVisionStation, DefaultDecisionStation, DefaultExecutionStation } = await import('./stations.js');
    // L1/L2/L3 供给三级制（P1-4 适配器落地）：外部 D-3 服务优先 → 插件自身能力
    // 回退（uiExtractor L1 / textReader OCR L2，经 visionAdapters 适配）→ 双缺席诚实降级。
    // system（nut-js 原生）动态引入：沙箱/无屏环境 import 失败 ⇒ 回退源缺席，零污染。
    let structuredSource = ctx.get?.('dsh.vision.structured') ?? null;
    let traditionalSource = ctx.get?.('dsh.vision.traditional') ?? null;
    const semanticSource = ctx.get?.('dsh.vision.semantic') ?? null;
    if (!structuredSource || !traditionalSource) {
        try {
            const { createStructuredFromUiExtractor, createTraditionalFromOcr } = await import('./visionAdapters.js');
            const { system } = await import('../system.js');
            if (!structuredSource) {
                structuredSource = createStructuredFromUiExtractor({
                    screenSize: () => system.getScreenSize(),
                });
            }
            if (!traditionalSource) {
                traditionalSource = createTraditionalFromOcr({
                    capture: () => system.captureScreen(),
                    screenSize: () => system.getScreenSize(),
                });
            }
            console.log('[Orchestration] internal vision adapters wired (L1 a11y / L2 OCR — fallback layer).');
        }
        catch {
            // 原生依赖缺席（沙箱/无屏）：回退源缺席 —— 三级漏斗诚实降级（既有行为）
            console.log('[Orchestration] internal vision adapters unavailable (native deps absent) — honest degradation.');
        }
    }
    const vision = new DefaultVisionStation({
        structured: structuredSource,
        traditional: traditionalSource,
        semantic: semanticSource,
    });
    // 决策工位：ChatFn 经 ctx.get('dsh.cognition') 注入（planner 方言）；
    // 缺席 ⇒ chat:null ⇒ decide 恒回 NeedGrounding（P0-5：消灭运行层 throw 闭包 ——
    // 通道缺席是可降级状态，不是异常；伪造一个必炸的 chat 是异常不诚实）
    const cognitionService = ctx.get?.('dsh.cognition');
    const decision = new DefaultDecisionStation({
        chat: cognitionService?.chat ?? null,
    });
    // 宿主执行通道：宿主动作工具面经 ctx.get('dsh.host-executor') 注入；缺席 = 开发者预览
    const hostExecutor = ctx.get?.('dsh.host-executor') ?? null;
    const execution = new DefaultExecutionStation({
        sandbox: sandboxService ?? null,
        host: hostExecutor,
        rehearseBeforeExecute: merged.rehearseBeforeExecute,
    });
    orchestrator.wire({ vision, decision, execution, emit: (ev, p) => { try {
            ctx.emit(ev, p);
        }
        catch { /* 发射失败是旁路义务 */ } } }, { reportDir: config?.reportDir ?? '' });
    // ── 事件总线接线（与 D-1/D-4 的唯一咬合通道）──
    // D-1 意图投喂：cognition/plan-ready 到达即启动流水线（中枢主循环入口）
    // P1-3 消费门控：consumePlanReady=false（缺省）让渡 D-7 主消费 —— 同通道双流水线
    // 执行 = 物理级事故；true = 显式夺回（仅 D-7 缺席部署时合法）。
    // 载荷宽容解码：ActionChain（既有方言）或 IntentPayload（D-6 方言）皆可入环。
    if (merged.consumePlanReady) {
        // P1-3 仲裁执法：夺回即响亮警告 —— 同通道双消费 = 同意图双流水线并发执行
        // （双份烧钱、报告互覆）。唯一合法拓扑：D-7 缺席或 consumePlanReady=false。
        console.warn('[Orchestration] WARNING: consuming plan-ready channel (consumePlanReady=true). ' +
            'Dual-pipeline execution will occur if D-7 also consumes — ensure D-7 is absent ' +
            'or its consumePlanReady=false before proceeding.');
        ctx.on(COGNITION_PLAN_READY_EVENT, async (payload) => {
            const intent = normalizeIntent(payload);
            if (!intent) {
                console.warn('[Orchestration] plan-ready payload unrecognizable — ignored (honest degradation).');
                return;
            }
            const report = await orchestrator.run(intent);
            boundedSet(inflightReports, intent.id, report, MAX_LIVE_REPORTS);
            console.log(`[Orchestration] Pipeline ${intent.id}: verdict=${report.verdict} ` +
                `attempts=${report.attempts.length} tokens(v/d/e)=${report.tokenUsage.vision}/${report.tokenUsage.decision}/${report.tokenUsage.execution} ` +
                `report=${report.reportPath}`);
        });
    }
    else {
        console.log('[Orchestration] plan-ready channel conceded to D-7 (P1-3 arbitration default; ' +
            'set consumePlanReady=true to reclaim — only legal when D-7 is absent).');
    }
    // D-4 判决回执：补写对应 attempt 的 doctorVerdict（异步验收闭环 —— AttemptRecord 全粒度）
    onDoctorVerdict(ctx, (payload) => {
        boundedSet(attemptVerdicts, payload.subject, payload, MAX_VERDICT_INDEX);
        // subject 约定：pipeline attempt 的 subject = `${intentRef}:${seq}`（D-4 发射侧约定）
        // 补写：run 结束后落盘的报告不含异步迟到的判决 —— 内存索引供 Trajectory 查询
    });
    // 宿主管线观察透传（与 D-5 共享同一嗅探源 —— 不重复监听，D-5 已挂 onHostToolPost）
    // D-6 无需指纹：门禁主权在 D-5。此处空置为注释说明（零重复监听原则）。
    // ── 工具面（对话流只见紧凑数字 + reportPath 句柄）──
    ctx.tools.register(defineTool({
        name: 'run_pipeline',
        description: PIPELINE_DOCTRINE + ' Run the four-station pipeline (vision→decision→execution→verification) '
            + 'for a goal. Returns compact numbers only (verdict, attempts, token usage); full evidence goes to reportPath.',
        parameters: {
            goal: { type: 'string', required: true, description: `Abstract goal (<=${GOAL_MAX_CHARS} chars, e.g. "sign in to the portal").` },
            success_criteria: { type: 'string', required: false, description: `Verifiable completion criteria (<=${SUCCESS_CRITERIA_MAX_CHARS} chars).` },
            budget_ms: { type: 'number', required: false, description: 'Optional wall-clock budget for the whole pipeline.' },
        },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        async execute(args) {
            try {
                const intent = {
                    id: `intent-tool-${Date.now().toString(36)}`,
                    goal: String(args.goal ?? '').slice(0, GOAL_MAX_CHARS),
                    successCriteria: args.success_criteria ? String(args.success_criteria).slice(0, SUCCESS_CRITERIA_MAX_CHARS) : undefined,
                    budgetMs: isPositiveFinite(args.budget_ms) ? args.budget_ms : undefined,
                    source: 'user',
                };
                if (!intent.goal)
                    return JSON.stringify({ status: 'FAILED', reason: 'goal is required' });
                const report = await orchestrator.run(intent);
                boundedSet(inflightReports, intent.id, report, MAX_LIVE_REPORTS);
                // 紧凑数字战报（Token 纪律）：全量证据在 reportPath
                return JSON.stringify({
                    status: report.verdict === 'completed' ? 'SUCCESS' : 'FAILED',
                    verdict: report.verdict,
                    intent_id: report.intentRef,
                    attempts: report.attempts.length,
                    terminal_reason: report.terminalReason,
                    token_usage: report.tokenUsage,
                    chain_tip: report.chainTip,
                    report: report.reportPath,
                });
            }
            catch (e) {
                return JSON.stringify({ status: 'FAILED', reason: `malformed input: ${e.message}` });
            }
        },
    }));
    ctx.tools.register(defineTool({
        name: 'query_attempt_verdict',
        description: 'Query the D-4 doctor verdict for a pipeline attempt (subject convention: "<intent_id>:<seq>"). '
            + 'Asynchronous verdicts may arrive after the pipeline report is persisted — this reads the live index.',
        parameters: {
            subject: { type: 'string', required: true, description: 'Attempt subject, e.g. "intent-tool-xxx:1".' },
        },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        async execute(args) {
            const subject = String(args.subject ?? '');
            const v = attemptVerdicts.get(subject);
            if (!v)
                return JSON.stringify({ status: 'NOT_FOUND', subject });
            return JSON.stringify({
                status: 'FOUND',
                verdict: v.verdict,
                score: v.score,
                chain_tip: v.chainTip,
                rationale: v.rationale ?? null,
            });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'get_pipeline_report',
        description: 'Fetch a persisted pipeline report by intent id (compact summary; full evidence at reportPath).',
        parameters: {
            intent_id: { type: 'string', required: true, description: 'Intent id from run_pipeline output.' },
        },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        async execute(args) {
            const report = inflightReports.get(String(args.intent_id ?? ''));
            if (!report)
                return JSON.stringify({ status: 'NOT_FOUND', intent_id: args.intent_id });
            return JSON.stringify({
                status: 'FOUND',
                verdict: report.verdict,
                attempts: report.attempts.map(a => ({
                    seq: a.seq, attempt: a.attempt, kind: a.action.kind,
                    effect: a.result.effectDetected, failure: a.result.failure?.kind ?? null,
                    doctor: a.doctorVerdict?.verdict ?? null,
                })),
                token_usage: report.tokenUsage,
                report: report.reportPath,
            });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'verify_pipeline_log',
        description: 'Verify the append-only hash chain of the pipeline session log (tamper-evidence audit).',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        async execute() {
            const r = orchestrator.verifyLog();
            if (!r.ok)
                return JSON.stringify({ status: 'FAILED', reason: r.error.reason });
            return JSON.stringify({
                status: 'SUCCESS',
                chain_intact: r.value.ok,
                entries: r.value.length,
                broken_at: r.value.brokenAt,
            });
        },
    }));
    console.log('[Orchestration] 4 pipeline tools registered (run_pipeline / query_attempt_verdict / get_pipeline_report / verify_pipeline_log).');
    console.log(sandboxService
        ? '[Orchestration] D-5 sandbox service detected — rehearsals before execution enabled.'
        : '[Orchestration] D-5 sandbox service absent — execution without rehearsal (honest degradation).');
    console.log(cognitionService?.chat
        ? '[Orchestration] D-1 cognition chat channel detected — decision station armed.'
        : '[Orchestration] D-1 cognition chat channel absent — decisions degrade to need-grounding (honest).');
    // ── 可逆注册：一切资源登记清理（Cordis 注册即效果模型）──
    ctx.effect(() => {
        console.log('[Orchestration] Unloading, rolling back resources...');
        return () => {
            orchestrator.reset(); // 内存态归零：账本窗口/自定义分区计数
            inflightReports.clear();
            attemptVerdicts.clear();
            console.log('[Orchestration] Unloaded. Zero residue.');
        };
    });
    console.log('[Orchestration] Initialization complete! The pipeline stands ready.');
}
// ─── 载荷归一化：cognition/plan-ready 的宽容解码（ActionChain | IntentPayload 皆可）───
function normalizeIntent(payload) {
    if (!payload || typeof payload !== 'object')
        return null;
    // D-6 方言：已是 IntentPayload（goal 非空才入环 —— 空 goal 意图是死意图）
    if (typeof payload.id === 'string' && typeof payload.goal === 'string' && payload.goal) {
        return {
            id: payload.id,
            goal: String(payload.goal).slice(0, GOAL_MAX_CHARS),
            successCriteria: payload.successCriteria ? String(payload.successCriteria).slice(0, SUCCESS_CRITERIA_MAX_CHARS) : undefined,
            budgetMs: isPositiveFinite(payload.budgetMs) ? payload.budgetMs : undefined,
            source: payload.source === 'cognition' ? 'cognition' : 'user',
            planVersion: payload.planVersion,
        };
    }
    // 既有方言：D-1 的 CognitionPlanReadyPayload.chain（ActionChain）
    if (payload.chain && Array.isArray(payload.chain.actions) && payload.chain.actions.length > 0) {
        const chain = payload.chain;
        const goal = `execute ${chain.actions.length}-step action chain (${chain.actions.map((a) => a.kind).slice(0, 5).join('→')}${chain.actions.length > 5 ? '…' : ''})`;
        return {
            id: `intent-from-${chain.id}`,
            goal: goal.slice(0, GOAL_MAX_CHARS),
            successCriteria: undefined,
            budgetMs: isPositiveFinite(chain.budgetMs) ? chain.budgetMs : undefined,
            source: 'cognition',
            planVersion: payload.planVersion,
        };
    }
    return null;
}
