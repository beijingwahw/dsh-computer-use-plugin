// src/knowledge/pipeline.ts
// D-7 隐知识增强流水线编排器 —— PipelineOrchestrator 桩实现（契约见 contracts.ts §13）。
// 四大主权（全部收口于本文件）：
//   1. 信封铸造权：五工位信封的唯一构造者（注意力隔离的物理执法点 —— 工位只见信封内物）
//   2. 防卡顿守卫：KnowledgeBase.query 与 VisionStation.perceive 并行触发；
//      检索越 knowledgeTimeout（默认 50ms）⇒ 直接降级无隐知识模式，绝不阻塞流水线
//   3. 失败路由：cancelled / timed-out 不入重试（给已终止的尝试重规划是无意义烧钱）；
//      其余失败按 retryPolicy 指数退避重试（capped at maxBackoffMs）
//   4. 闭环进化：验收后打包 ExecutionOutcome → KnowledgeBase.learnFromOutcome（旁路义务：
//      学习失败只告警，绝不击穿流水线）
// 《异常诚实分层契约》D-7 修正案：configure = 运行层可重配方法 —— Result 降级，严禁
//   throw（验收修复项 #2）；wire = 加载层（throw 合法，由 apply 收口）；run = 永不抛错。
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { distillInjection } from './knowledgeBase.js';
import { emitKnowledgeAttempt, emitKnowledgeLearned, emitKnowledgeRunEnd, } from './events.js';
import { sandboxLog } from '../sandbox/log.js';
/** 工位 Token 预算缺省（P1-2 config-driven：本表仅为 PipelineConfig.stationTokenBudgets
 *  缺席时的回退缺省 —— 预算治理主权在配置域，configure 校验后不再有第二个常量源） */
const DEFAULT_STATION_TOKEN_BUDGETS = { vision: 0, decision: 2000, execution: 0 };
/** 防爆环上限（结构保险丝：任何纪元的最大决策轮数） */
const MAX_ROUNDS = 1000;
/** D-7 链段入账（P1-5 可观测性对齐：复用 sandboxLog append-only 哈希链，
 *  kind 前缀 'knowledge-'）。旁路义务：落盘失败由 SandboxLog 内部吞错，
 *  绝不阻断流水线；同步段原子（chainTip 读写无竞态）。 */
function logKnowledge(kind, data) {
    void sandboxLog.append(kind, data);
}
/** NeedGrounding 判别（D-7 方言：reason/focus 双字段在场即判 —— 无 kind 判别式） */
function isNeedGrounding(output) {
    return typeof output.reason === 'string' &&
        typeof output.focus === 'string' &&
        !('kind' in output);
}
/** 场景紧凑摘要（隐知识检索的 sceneDescription 铸造源 —— Token 纪律） */
function summarizeScene(scene) {
    return scene
        .map(p => `${p.region.id}:${p.funnelDepth}${p.elements.length ? `(${p.elements.slice(0, 3).map(e => e.name).join(',')})` : ''}`)
        .join('; ')
        .slice(0, 200);
}
export class KnowledgePipelineOrchestrator {
    cfg = null;
    deps = null;
    reportDir = '';
    reportCounter = 0; // 报告文件名防碰撞序号（同 intent 同毫秒不互相覆盖）
    /**
     * 运行层可重配方法（D-7 修正案 / 验收修复项 #2）：Result 降级，严禁 throw。
     * 校验域外拒绝（对齐 makeScore 哲学），首个错误即返回 —— field 精确定位。
     */
    configure(config) {
        if (!config || typeof config !== 'object') {
            return { ok: false, error: { field: 'config', reason: 'config must be an object' } };
        }
        const t = config.timeout;
        if (!t || !Number.isFinite(t.overall) || t.overall <= 0) {
            return { ok: false, error: { field: 'timeout.overall', reason: `must be a positive finite number, got ${t?.overall}` } };
        }
        if (!Number.isFinite(t.perStep) || t.perStep <= 0) {
            return { ok: false, error: { field: 'timeout.perStep', reason: `must be a positive finite number, got ${t?.perStep}` } };
        }
        if (!Number.isFinite(t.perPerception) || t.perPerception <= 0) {
            return { ok: false, error: { field: 'timeout.perPerception', reason: `must be a positive finite number, got ${t?.perPerception}` } };
        }
        const rp = config.retryPolicy;
        if (!rp || !Number.isInteger(rp.maxRetries) || rp.maxRetries < 0) {
            return { ok: false, error: { field: 'retryPolicy.maxRetries', reason: `must be a non-negative integer, got ${rp?.maxRetries}` } };
        }
        if (!Number.isFinite(rp.backoffMs) || rp.backoffMs < 0) {
            return { ok: false, error: { field: 'retryPolicy.backoffMs', reason: `must be a non-negative finite number, got ${rp?.backoffMs}` } };
        }
        if (!Number.isFinite(rp.maxBackoffMs) || rp.maxBackoffMs < rp.backoffMs) {
            return { ok: false, error: { field: 'retryPolicy.maxBackoffMs', reason: `must be >= backoffMs (${rp?.backoffMs}), got ${rp?.maxBackoffMs}` } };
        }
        if (!Number.isFinite(config.knowledgeTimeout) || config.knowledgeTimeout <= 0) {
            return { ok: false, error: { field: 'knowledgeTimeout', reason: `must be a positive finite number (anti-stall guard), got ${config.knowledgeTimeout}` } };
        }
        if (!Number.isInteger(config.knowledgeMaxResults) || config.knowledgeMaxResults < 1) {
            return { ok: false, error: { field: 'knowledgeMaxResults', reason: `must be an integer >= 1, got ${config.knowledgeMaxResults}` } };
        }
        if (!Number.isInteger(config.knowledgeMaxChars) || config.knowledgeMaxChars < 1 || config.knowledgeMaxChars > 300) {
            return { ok: false, error: { field: 'knowledgeMaxChars', reason: `must be an integer in [1,300] (injection summary budget), got ${config.knowledgeMaxChars}` } };
        }
        const g = config.regionGrid;
        if (g && (!Number.isInteger(g.cols) || g.cols < 1 || !Number.isInteger(g.rows) || g.rows < 1)) {
            return { ok: false, error: { field: 'regionGrid', reason: `cols/rows must be integers >= 1, got ${JSON.stringify(g)}` } };
        }
        // P1-2 工位 Token 预算域执法：非负整数；execution 恒 0（零模型肌肉的类型层
        // 延伸 —— 域外拒绝，绝不 clamp 掩埋）
        const tb = config.stationTokenBudgets ?? DEFAULT_STATION_TOKEN_BUDGETS;
        if (!Number.isInteger(tb.vision) || tb.vision < 0 ||
            !Number.isInteger(tb.decision) || tb.decision < 0 ||
            !Number.isInteger(tb.execution) || tb.execution < 0) {
            return { ok: false, error: { field: 'stationTokenBudgets', reason: `vision/decision/execution must be non-negative integers, got ${JSON.stringify(tb)}` } };
        }
        if (tb.execution !== 0) {
            return { ok: false, error: { field: 'stationTokenBudgets.execution', reason: `execution is zero-model muscle and must stay 0, got ${tb.execution}` } };
        }
        this.cfg = { ...config, regionGrid: g ?? { cols: 2, rows: 2 }, stationTokenBudgets: tb };
        return { ok: true, value: undefined };
    }
    /** 工位注入（加载层方言：throw 合法 —— 站点缺席即拒绝出生，由 apply 收口） */
    wire(deps, opts) {
        if (!this.cfg)
            throw new Error('[KnowledgePipeline] configure() must precede wire()');
        if (!deps.vision || !deps.decision || !deps.execution || !deps.knowledge || !deps.verdictBridge) {
            throw new Error('[KnowledgePipeline] all stations plus knowledge base and verdict bridge are required');
        }
        this.deps = deps;
        this.reportDir = opts?.reportDir ?? '';
    }
    /** 运行层入口（契约：永不抛错）。意外 = 结构化 failed 报告，交 D-4 裁决 */
    async run(intent) {
        const startedAt = Date.now();
        if (!this.cfg || !this.deps) {
            return this.finalReport(intent, 'failed', 'orchestrator not configured/wired', [], null, startedAt);
        }
        const cfg = this.cfg;
        const deps = this.deps;
        const outcomes = [];
        let knowledgeUsed = null;
        try {
            let verdict = null;
            let terminalReason = '';
            let retryCount = 0;
            let seq = 0;
            let feedback;
            let lastSceneSummary = ''; // 并行语义：检索的 sceneDescription 只能用上一轮场景
            for (let round = 0; round < MAX_ROUNDS; round++) {
                // overall 时钟：预算耗尽 ⇒ verdict='timeout'（部分轨迹保留）
                if (Date.now() - startedAt > cfg.timeout.overall) {
                    verdict = 'timeout';
                    terminalReason = `overall budget ${cfg.timeout.overall}ms exhausted`;
                    break;
                }
                // ── 并行双触发：感知 + 隐知识检索（数据流三段论 #2 —— 防卡顿铁律）──
                const visionEnv = {
                    station: 'vision',
                    payload: {
                        grid: cfg.regionGrid ?? { cols: 2, rows: 2 },
                        forceL3: false, // 桩纪元：L3 花钱权未开（NeedGrounding 批准回路是留白）
                        snapshotId: undefined,
                    },
                    tokenBudget: cfg.stationTokenBudgets.vision,
                };
                const [scene, injection] = await Promise.all([
                    this.withTimeout(deps.vision.perceive(visionEnv), cfg.timeout.perPerception, []),
                    this.queryKnowledgeGuarded(intent, lastSceneSummary),
                ]);
                knowledgeUsed = injection ?? knowledgeUsed;
                lastSceneSummary = summarizeScene(scene);
                // ── 决策（信封铸造权：intent + scene + 隐知识注入 ≤300 字符，无截图字节）──
                const decisionCtx = {
                    intent,
                    scene,
                    knowledgeContext: injection ?? undefined,
                    previousResults: intent.previousResults,
                };
                const decisionEnv = {
                    station: 'decision',
                    payload: decisionCtx,
                    tokenBudget: cfg.stationTokenBudgets.decision,
                };
                const output = await this.withTimeout(deps.decision.decide(decisionEnv, feedback), cfg.timeout.perStep, { reason: `decision step timeout after ${cfg.timeout.perStep}ms`, focus: 'full-scene' });
                // NeedGrounding 路由：桩纪元无 L3 兜底通道 ⇒ 诚实终局（grounding 批准回路是留白）
                if (isNeedGrounding(output)) {
                    verdict = 'failed';
                    terminalReason = `need-grounding: ${output.reason} (focus: ${output.focus})`;
                    break;
                }
                // ── 执行（信封铸造权：零模型肌肉，tokenBudget 恒 0）──
                const action = output;
                seq += 1;
                const execEnv = {
                    station: 'execution',
                    payload: action,
                    tokenBudget: cfg.stationTokenBudgets.execution,
                };
                const result = await this.withTimeout(deps.execution.execute(execEnv), cfg.timeout.perStep, {
                    action,
                    status: 'failure',
                    durationMs: cfg.timeout.perStep,
                    failure: { kind: 'timeout', detail: `execution step timeout after ${cfg.timeout.perStep}ms` },
                });
                // ── 闭环进化（数据流三段论 #4 + P0-4 验收门）：打包 outcome → 结算 → 学习 ──
                // 学习的前置条件 = 结算：D-4 回执在场 ⇒ 即时结算（verdict 路径）；
                // 回执缺席 ⇒ 挂账 pending，run-end 冲账兜底 —— 未结算的 outcome 绝不进学习。
                const outcome = {
                    intent,
                    action,
                    result,
                    retryCount,
                    totalDurationMs: Date.now() - startedAt,
                };
                outcomes.push(outcome);
                const settlement = deps.verdictBridge.trySettle(seq, outcome);
                if (settlement) {
                    this.learnSettled(settlement);
                }
                else {
                    deps.verdictBridge.defer(seq, outcome); // 验收门等待室
                }
                logKnowledge('knowledge-attempt', {
                    intentId: intent.id, seq, actionKind: action.kind, status: result.status,
                    failureKind: result.failure?.kind ?? null, retryCount,
                });
                this.safeEmit('attempt', {
                    intentId: intent.id, seq, actionKind: action.kind, status: result.status,
                    failureKind: result.failure?.kind ?? null,
                });
                // ── 失败路由：cancelled / timed-out 直达终局，绝不入重试循环 ──
                if (result.status !== 'failure') {
                    verdict = result.status === 'success' ? 'completed' : 'degraded';
                    terminalReason = result.status === 'success'
                        ? 'goal achieved (hard evidence: execution success)'
                        : 'completed with degraded verification (effect unverified)';
                    break;
                }
                const kind = result.failure?.kind ?? 'host-error';
                if (kind === 'cancelled' || kind === 'timed-out') {
                    verdict = 'aborted';
                    terminalReason = `external termination (${kind}): ${result.failure?.detail ?? 'unknown'}`;
                    break;
                }
                if (retryCount >= cfg.retryPolicy.maxRetries) {
                    verdict = 'failed';
                    terminalReason = `retries exhausted (${retryCount}): ${kind} at seq ${seq} — ${result.failure?.detail ?? 'unknown'}`;
                    break;
                }
                retryCount += 1;
                feedback = { reason: result.failure?.detail ?? 'unknown failure', retryCount };
                // 退避受 overall 预算约束（风险加固）：睡眠绝不超过剩余预算 ——
                // 轮首时钟只查一次，裸睡 maxBackoffMs 会让 run 超冲 overall 达一个退避周期
                const remaining = cfg.timeout.overall - (Date.now() - startedAt);
                await this.sleep(Math.max(0, Math.min(cfg.retryPolicy.backoffMs * 2 ** (retryCount - 1), cfg.retryPolicy.maxBackoffMs, remaining)));
            }
            verdict ??= 'failed';
            terminalReason ||= `no progress possible after ${outcomes.length} outcome(s)`;
            this.settlePending(intent.id); // P0-4 终局冲账：本 intent 的挂账在此结算学习
            return this.finalReport(intent, verdict, terminalReason, outcomes, knowledgeUsed, startedAt);
        }
        catch (e) {
            // 运行层兜底：任何意外 ⇒ 结构化 failed（契约 —— 永不抛错）
            const msg = e instanceof Error ? e.message : String(e);
            logKnowledge('knowledge-internal-fault', { intentId: intent.id, detail: msg.slice(0, 200) });
            this.settlePending(intent.id); // 冲账例外无豁免：已发生的 outcome 照常结算（内部故障 ≠ 证据销毁）
            return this.finalReport(intent, 'failed', `internal pipeline fault: ${msg}`, outcomes, knowledgeUsed, startedAt);
        }
    }
    /** 生命周期归零（Result 降级 —— 账本审计语义） */
    dispose() {
        try {
            const r = this.deps?.knowledge.dispose();
            this.deps = null;
            this.cfg = null;
            this.reportDir = '';
            if (r && !r.ok)
                return { ok: false, error: r.error };
            return { ok: true, value: undefined };
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { ok: false, error: new Error(`dispose fault: ${msg}`) };
        }
    }
    // ─── 私有主权域 ───
    /**
     * P0-4 终局冲账（run 双出口共用）：本 intent 的 pending 结算 → 逐笔学习。
     * 迟到回执在场 ⇒ settledBy='verdict'（证据后到不是沉默）；缺席 ⇒ 'run-end'
     * （诚实降级：学习不因 D-4 沉默而缺席，结算单如实标注证据缺席）。
     * 作用域限定（风险加固）：只冲本 intent 挂账 —— 并发 run 时绝不越权结算
     * 他人的等待室（验收门语义不被他人的终局时钟劫持）。
     * 幂等：冲账即清空等待室（settleAll 契约）—— 双出口至多各冲一次。
     */
    settlePending(intentId) {
        if (!this.deps)
            return;
        for (const settlement of this.deps.verdictBridge.settleAll(intentId)) {
            this.learnSettled(settlement);
        }
    }
    /**
     * 隐知识检索守卫（防卡顿铁律的执法点）：与感知并行触发；越 knowledgeTimeout 或
     * 检索失败/违约 ⇒ 返回 null（无隐知识模式降级）—— 隐知识缺席是旁路，绝不阻塞流水线。
     */
    async queryKnowledgeGuarded(intent, sceneSummary) {
        if (!this.cfg || !this.deps)
            return null;
        const cfg = this.cfg;
        const query = {
            sceneDescription: sceneSummary,
            intentDescription: intent.description,
            maxResults: cfg.knowledgeMaxResults,
        };
        let timer;
        const startedAt = Date.now();
        try {
            const timeoutP = new Promise(resolve => {
                timer = setTimeout(() => resolve(null), cfg.knowledgeTimeout);
            });
            // 契约上 query 是同步 Result —— 经 microtask 脱离关键路径（未来异步实现零改造接入）
            const queryP = Promise.resolve().then(() => this.deps.knowledge.query(query));
            const winner = await Promise.race([queryP, timeoutP]);
            if (winner === null) {
                // 检索历史入链（P1-5）：超时降级也是可审计的历史（旁路义务，不占检索预算）
                logKnowledge('knowledge-retrieval', { intentId: intent.id, outcome: 'timeout', budgetMs: cfg.knowledgeTimeout });
                return null; // 超时降级：无隐知识模式（防卡顿铁律）
            }
            if (!winner.ok) {
                logKnowledge('knowledge-retrieval', { intentId: intent.id, outcome: 'error', field: winner.error.field });
                return null; // 检索失败降级：旁路义务，不击穿流水线
            }
            // 事后守卫：同步阻塞型实现无法被 race 抢占（事件循环被占）—— 墙钟越限同样降级
            if (Date.now() - startedAt > cfg.knowledgeTimeout) {
                logKnowledge('knowledge-retrieval', { intentId: intent.id, outcome: 'overtime', elapsedMs: Date.now() - startedAt });
                return null;
            }
            logKnowledge('knowledge-retrieval', {
                intentId: intent.id, outcome: 'hit', entries: winner.value.entries.length,
                latencyMs: winner.value.latencyMs,
            });
            return distillInjection(winner.value, cfg.knowledgeMaxChars);
        }
        catch {
            return null; // 违约抛错降级：同上
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    /** 步超时包裹：越限 ⇒ fallback（杀一刀，不杀流水线）；违约抛错 ⇒ fallback（纵深防御） */
    async withTimeout(p, timeoutMs, fallback) {
        let timer;
        try {
            return await Promise.race([
                p,
                new Promise(resolve => {
                    timer = setTimeout(() => resolve(fallback), timeoutMs);
                }),
            ]);
        }
        catch {
            return fallback;
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    /** 闭环进化旁路（P0-4 验收门执法点）：只消费已结算的 outcome ——
     *  learnFromOutcome 失败/违约只静默（学习绝不能杀死执行报告）。
     *  学习历史入链（P1-5）：每笔 auto-learn 都是防篡改账本上的一行。 */
    learnSettled(settlement) {
        try {
            const r = this.deps?.knowledge.learnFromOutcome(settlement.outcome);
            if (r && !r.ok) {
                console.warn(`[KnowledgePipeline] learnFromOutcome degraded: ${r.error.field}: ${r.error.reason}`);
                return;
            }
            logKnowledge('knowledge-learned', {
                intentId: settlement.outcome.intent.id,
                subject: settlement.subject,
                settledBy: settlement.settledBy,
                actionKind: settlement.outcome.action.kind,
                status: settlement.outcome.result.status,
            });
            this.safeEmit('learned', {
                intentId: settlement.outcome.intent.id,
                category: settlement.outcome.result.status === 'failure' ? 'error-pattern' : 'workflow',
                retryCount: settlement.outcome.retryCount,
                settledBy: settlement.settledBy,
                learnedAt: Date.now(),
            });
        }
        catch {
            // 违约抛错：旁路义务，静默降级
        }
    }
    /** 事件发射守卫（发射失败是旁路义务 —— 绝不阻断主流程） */
    safeEmit(kind, payload) {
        if (!this.deps?.emit)
            return;
        if (kind === 'attempt')
            emitKnowledgeAttempt(this.deps.emit, payload);
        else
            emitKnowledgeLearned(this.deps.emit, payload);
    }
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    finalReport(intent, verdict, terminalReason, outcomes, knowledgeUsed, startedAt) {
        const report = {
            intentId: intent.id,
            verdict,
            outcomes,
            knowledgeUsed,
            terminalReason: terminalReason.slice(0, 120), // Token 纪律：对话流只进这一行
            reportPath: this.persistReport(intent.id, verdict, { outcomes, startedAt, knowledgeUsed }),
            chainTip: sandboxLog.tip, // P1-5：报告锚定链尖端（D-6 同方言，D-4 审计定位）
        };
        logKnowledge('knowledge-run-end', {
            intentId: report.intentId,
            verdict: report.verdict,
            outcomes: report.outcomes.length,
            knowledgeUsed: report.knowledgeUsed !== null,
            reportPath: report.reportPath,
        });
        if (this.deps?.emit) {
            emitKnowledgeRunEnd(this.deps.emit, {
                intentId: report.intentId,
                verdict: report.verdict,
                outcomes: report.outcomes.length,
                knowledgeUsed: report.knowledgeUsed !== null,
                reportPath: report.reportPath,
                endedAt: Date.now(),
            });
        }
        return report;
    }
    /** 结构化落盘（Token 纪律：对话流只回句柄；失败降级 'in-memory' 并 warn）。
     *  文件名带进程内序号（风险加固）：同 intent 同毫秒的并发报告不互相覆盖。 */
    persistReport(intentId, verdict, extra) {
        if (!this.reportDir)
            return 'in-memory';
        try {
            mkdirSync(this.reportDir, { recursive: true });
            this.reportCounter += 1;
            const full = join(this.reportDir, `knowledge-${intentId}-${Date.now()}-${this.reportCounter}.json`);
            writeFileSync(full, JSON.stringify({ intentId, verdict, ...extra }, null, 2), 'utf8');
            return full;
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[KnowledgePipeline] report persist failed: ${msg}`);
            return 'in-memory';
        }
    }
}
