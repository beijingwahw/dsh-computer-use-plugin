// src/sandbox/engine.ts
// D-5 沙箱执行引擎 —— 契约实现。
// 灵魂三条反射的代码化：
//   THE HOST IS SACRED    → replayOnHost 四重门禁（令牌/医生/可靠度/指纹），缺证即拒
//   DRILL, THEN DELIVER   → 排练簿记全量入链，对话流只见紧凑数字（报告落盘走句柄）
//   TRUST IS A FINGERPRINT→ 放行仅当宿主最新观察指纹与排练入口同屏；无证据 = 拒绝
// 本纪元诚实声明：虚拟屏模拟器是架构留白（蓝图 #5 裁决划出契约）——
// 像素/语义验证层缺席 ⇒ 排练 verdict 恒 'degraded' ⇒ 双闸门恒 freeze/discard ⇒
// 记忆库等待模拟器纪元。引擎绝不伪造 passed（"完美的评分若来自未执行的验证层，
// 那是谎言，不是健康"）。门禁/账本/记忆/召回/事件全部真实可用。
// 异常诚实分层契约（D-6 轮立法）：
//   第一条（加载层）configure 校验失败 throw —— 拒绝带病上线，与宿主同生命周期哲学；
//   第二条（运行层）一切运行时方法永不抛错，Result/verdict 降级 —— 数据流不可击穿。
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeScore } from '../doctorEvents.js';
import { emitHostReplayEnd, emitMemoryConsolidated, emitRehearsalBegin, emitRehearsalEnd, } from './events.js';
import { MuscleMemoryStore } from './memory.js';
import { sandboxLog } from './log.js';
import { createDefaultIdGenerator, muscleReliability, resolveConsolidation, } from './types.js';
/** Laplace 中性先验 = (0+1)/(0+2) —— 数学中性值，非部署调优魔法数字 */
const DEFAULT_MIN_RELIABILITY = 0.5;
/** 场景同屏门限（对齐 skillLibrary.match 场景加成门限 0.9 —— 算法结构常量） */
const DEFAULT_SCENE_SIMILARITY = 0.9;
/** 重放令牌 TTL（对齐宿主 approval 的 120s 方言） */
const REPLAY_TOKEN_TTL_MS = 120000;
/** 64 位指纹相似度（perceptualHash.similarity/hammingDistance 同构式本地复刻：
 *  D-5 只需纯字符串距离，不拖入 sharp 图像二进制运行时依赖） */
function fpSimilarity(a, b) {
    if (a.length !== b.length)
        return 0;
    let dist = 0;
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i])
            dist++;
    return 1 - dist / 64;
}
/** 验证层典范序（铸造点排序依据：验证栈自底向上，序即语义） */
const LAYER_ORDER = ['L1-pixel', 'L2-diff', 'L3-semantic', 'L4-expectation'];
export class SandboxEngineImpl {
    cfg = {};
    idGen = createDefaultIdGenerator();
    memory = new MuscleMemoryStore();
    /** 宿主观察缓存（TRUST IS A FINGERPRINT 的镜像源头；嗅探缺席 = null = 保守拒绝） */
    hostFingerprint = null;
    hostFingerprintAt = 0;
    /** D-4 判决缓存（subject=chainId → 最新回执；重放时刻的复核源） */
    verdictCache = new Map();
    replayTokens = new Map();
    ctx;
    // 显式字段赋值（非参数属性）：Node strip-only 运行时契约 —— 现世源码同方言
    constructor(ctx) {
        this.ctx = ctx;
    }
    /** 加载层方法（《异常诚实分层契约》第一条）：校验失败 throw —— 拒绝带病上线 */
    configure(config) {
        const errors = [];
        const rel = config.hostReplayMinReliability;
        if (rel !== undefined && (!Number.isFinite(rel) || rel < 0 || rel > 1)) {
            errors.push(`hostReplayMinReliability must be in [0,1], got ${rel}`);
        }
        const sim = config.entrySceneMinSimilarity;
        if (sim !== undefined && (!Number.isFinite(sim) || sim < 0 || sim > 1)) {
            errors.push(`entrySceneMinSimilarity must be in [0,1], got ${sim}`);
        }
        if (errors.length > 0) {
            throw new Error(`[SandboxEngine] invalid configuration:\n  - ${errors.join('\n  - ')}`);
        }
        this.cfg = { ...config };
        this.idGen = config.idGenerator ?? createDefaultIdGenerator();
        this.memory.configure(config.memoryPath ?? '');
        this.memory.load();
    }
    /** 宿主观察登记（index.ts 的 onHostToolPost 嗅探后喂数据；实现类公开面） */
    noteHostObservation(fingerprint) {
        if (fingerprint === null) {
            this.hostFingerprint = null;
            return;
        }
        if (/^[01]{64}$/.test(fingerprint)) {
            this.hostFingerprint = fingerprint;
            this.hostFingerprintAt = Date.now();
        }
    }
    /** D-4 判决登记（onDoctorVerdict 接线后喂数据；双闸门与重放复核的缓存源） */
    noteDoctorVerdict(p) {
        this.verdictCache.set(p.subject, p);
    }
    /** D-1 计划接收（onCognitionPlanReady 接线后的排练触发点） */
    async receivePlan(chain) {
        return this.rehearse({ ...chain, origin: 'cognition' });
    }
    async createSnapshot() {
        const snap = {
            id: this.idGen.next('snap'),
            createdAt: Date.now(),
            screenDhash: this.hostFingerprint ?? '',
            focus: undefined,
            cursor: undefined,
            chainTip: sandboxLog.tip,
            whiteboxAvailable: false, // 白盒源（D-3）接入是模拟器纪元主权；诚实 false
        };
        await sandboxLog.append('snapshot-created', {
            snapshotId: snap.id,
            mirrorSource: this.hostFingerprint ? 'host-observation' : 'absent-degraded',
        });
        return { ok: true, value: snap };
    }
    async rehearse(chain, opts) {
        const startedAt = Date.now();
        if (!chain || !Array.isArray(chain.actions) || chain.actions.length === 0) {
            return this.finishRehearsal(chain?.id ?? 'chain-invalid', opts?.snapshotId ?? 'snap-none', {
                verdict: 'failed', steps: [], failedAtIndex: null, layers: [],
                totalLatencyMs: 0, budgetMs: chain?.budgetMs, startedAt,
                note: 'invalid chain: actions must be a non-empty array',
            });
        }
        const snapResult = await this.createSnapshot();
        const snapshotId = opts?.snapshotId ?? (snapResult.ok ? snapResult.value.id : 'snap-none');
        await sandboxLog.append('rehearsal-begin', {
            chainId: chain.id, snapshotId, actions: chain.actions.length,
        });
        if (this.ctx)
            emitRehearsalBegin(this.ctx, { chainId: chain.id, snapshotId, startedAt });
        const book = { cursor: { x: 0.5, y: 0.5 }, typedChars: 0 };
        const steps = [];
        const activeLayers = new Set();
        const t0 = Date.now();
        let failedAtIndex = null;
        let aborted = false;
        try {
            for (let i = 0; i < chain.actions.length; i++) {
                const action = chain.actions[i];
                const stepStart = Date.now();
                // 预算感知：步边界检查时钟（优雅中止而非失控）
                if (chain.budgetMs !== undefined && Date.now() - t0 > chain.budgetMs) {
                    aborted = true;
                    failedAtIndex = i;
                    await sandboxLog.append('rehearsal-step', {
                        chainId: chain.id, index: i, budgetExceeded: true, elapsedMs: Date.now() - t0,
                    });
                    break;
                }
                this.applyBookkeeping(book, action);
                const latencyMs = Date.now() - stepStart;
                // 验证层缺席的诚实降级：无模拟器 ⇒ L1/L2 不可判；L3 无 OCR 源；L4 无像素可对照
                steps.push({
                    index: i,
                    action,
                    effectDetected: null,
                    expectationMet: null,
                    latencyMs,
                    note: action.expect
                        ? 'expect declared but verification layers unavailable (simulator epoch pending)'
                        : 'verification layers unavailable (simulator epoch pending)',
                });
                await sandboxLog.append('rehearsal-step', {
                    chainId: chain.id, index: i, kind: action.kind, latencyMs, effectDetected: null,
                    virtualFocus: book.focus ? `${book.focus.x},${book.focus.y}` : null,
                });
            }
        }
        catch (e) {
            // 异常诚实：内部异常 ⇒ degraded（不吞不抛）
            return this.finishRehearsal(chain.id, snapshotId, {
                verdict: 'degraded', steps, failedAtIndex, layers: [...activeLayers],
                totalLatencyMs: Date.now() - t0, budgetMs: chain.budgetMs, startedAt,
                note: `internal error during rehearsal: ${e?.message ?? 'unknown'}`,
            });
        }
        const totalLatencyMs = Date.now() - t0;
        const verdict = aborted
            ? 'aborted'
            : steps.some(s => s.effectDetected === false)
                ? 'failed'
                : activeLayers.size === 0
                    ? 'degraded' // 零生效验证层 ⇒ 诚实 degraded（本纪元常态）
                    : 'passed'; // 模拟器纪元：有效果证据且无反证时到达
        return this.finishRehearsal(chain.id, snapshotId, {
            verdict, steps, failedAtIndex, layers: [...activeLayers],
            totalLatencyMs, budgetMs: chain.budgetMs, startedAt,
            note: aborted ? `budget exceeded at step ${failedAtIndex}` : undefined,
        });
    }
    /** 簿记转移：焦点/光标/输入记账（沙箱世界模型的最小诚实形态） */
    applyBookkeeping(book, action) {
        const num = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
        switch (action.kind) {
            case 'click_mouse': {
                const x = num(action.args?.x) ?? book.cursor.x;
                const y = num(action.args?.y) ?? book.cursor.y;
                book.cursor = { x, y };
                book.focus = {
                    x, y,
                    sensitive: typeof action.args?.target_description === 'string' &&
                        /password|密码|验证码|otp|2fa|token|api[_ -]?key/i.test(action.args.target_description),
                    capturedAt: Date.now(),
                };
                break;
            }
            case 'drag_mouse': {
                const ex = num(action.args?.endX);
                const ey = num(action.args?.endY);
                if (ex !== null && ey !== null)
                    book.cursor = { x: ex, y: ey };
                break;
            }
            case 'type_text': {
                const text = typeof action.args?.text === 'string' ? action.args.text : '';
                book.typedChars += text.length;
                break;
            }
            default:
                break; // scroll/hotkey/switch/dismiss/noop：无焦点/光标转移
        }
    }
    /** 排练收尾：评分铸造（零证据零分）+ 落盘 + 入链 + 事件。永不抛错 */
    async finishRehearsal(chainId, snapshotId, r) {
        // 铸造点：去重 + 典范序（集合语义，Array 载体 —— 三渡 JSON 边界）
        const present = new Set(r.layers);
        const layers = LAYER_ORDER.filter(l => present.has(l));
        // 评分铁律：未执行的验证层不得计入评分 —— 零生效层 = 零分（没有证据就没有分数）
        const rawScore = layers.length === 0
            ? 0
            : Math.round((layers.length / LAYER_ORDER.length) * 100);
        const score = makeScore(rawScore) ?? 0;
        const createdAt = Date.now();
        const report = {
            chainId, snapshotId, verdict: r.verdict, score: rawScore,
            steps: r.steps, failedAtIndex: r.failedAtIndex,
            verificationLayers: layers, totalLatencyMs: r.totalLatencyMs,
            budgetMs: r.budgetMs, note: r.note, createdAt,
        };
        const reportPath = this.persistReport(`rehearsal-${chainId}-${createdAt}.json`, report);
        const outcome = {
            chainId, snapshotId, verdict: r.verdict, steps: r.steps,
            failedAtIndex: r.failedAtIndex, score, verificationLayers: layers,
            totalLatencyMs: r.totalLatencyMs, budgetMs: r.budgetMs,
            chainTip: sandboxLog.tip, reportPath, createdAt,
        };
        await sandboxLog.append('rehearsal-end', {
            chainId, verdict: r.verdict, score: rawScore,
            totalLatencyMs: r.totalLatencyMs, steps: r.steps.length, reportPath,
        });
        if (this.ctx) {
            emitRehearsalEnd(this.ctx, {
                chainId, snapshotId, verdict: r.verdict, score,
                chainTip: outcome.chainTip, reportPath, endedAt: createdAt,
            });
        }
        return outcome;
    }
    /** 结构化落盘（Token 纪律：对话流只回句柄；失败降级 'in-memory' 并 warn） */
    persistReport(fileName, report) {
        if (!this.cfg.reportDir)
            return 'in-memory';
        try {
            mkdirSync(this.cfg.reportDir, { recursive: true });
            const full = join(this.cfg.reportDir, fileName);
            writeFileSync(full, JSON.stringify(report, null, 2), 'utf8');
            return full;
        }
        catch (e) {
            console.warn(`[SandboxEngine] report persist failed: ${e.message}`);
            return 'in-memory';
        }
    }
    consolidate(outcome, doctorVerdict) {
        const doctor = doctorVerdict ?? 'needs_review'; // 缺省保守：无医生回执即待审
        const decision = resolveConsolidation(outcome.verdict, doctor);
        void sandboxLog.append('consolidation', {
            chainId: outcome.chainId, decision, doctorVerdict: doctor, rehearsal: outcome.verdict,
        });
        if (decision !== 'consolidate') {
            // discard：判决入链为失败养分；freeze：登记待审（裁决权属造物主，绝不自动固化）
            return { ok: true, value: null };
        }
        const trigger = `chain ${outcome.chainId} (${outcome.steps.length} steps, verdict=${outcome.verdict})`;
        const entry = this.memory.consolidate(this.idGen, trigger, outcome.chainId, outcome.steps.map(s => s.action), undefined);
        const reliability = muscleReliability(entry);
        void sandboxLog.append('consolidation', { entryId: entry.id, reliability, reinforced: entry.rehearsalPassCount });
        if (this.ctx) {
            emitMemoryConsolidated(this.ctx, {
                entryId: entry.id, trigger: entry.trigger,
                reliability, rehearsalPassCount: entry.rehearsalPassCount,
            });
        }
        return { ok: true, value: entry };
    }
    recallMuscleMemory(query) {
        const hits = this.memory.recall({
            text: query,
            currentSceneFingerprint: this.hostFingerprint ?? undefined,
        });
        void sandboxLog.append('recall', { query: query.slice(0, 120), hits: hits.length });
        return { ok: true, value: hits.map(h => h.entry) };
    }
    /**
     * 阶段零：铸造重放令牌（B-3 两阶段审批的入口；实现类公开面）。
     * validate 不消费（门禁检查可重复）；consume 用后即焚（replayOnHost 内部）。
     */
    requestReplayToken(entryId) {
        const token = 'SBX-' + Math.random().toString(36).slice(2, 10).toUpperCase();
        this.replayTokens.set(token, {
            token, entryId, expiresAt: Date.now() + REPLAY_TOKEN_TTL_MS,
        });
        return token;
    }
    async replayOnHost(entryId, opts) {
        const createdAt = Date.now();
        const gate = (reason) => ({
            muscleMemoryId: entryId, verdict: 'failed', journalRefs: [], divergences: [],
            reliabilityAfter: 0, reportPath: this.persistReport(`replay-${entryId}-${createdAt}.json`, { gate: 'rejected', reason, createdAt }),
            createdAt,
        });
        // 门禁一：条目在场（THE HOST IS SACRED —— 未知记忆绝不放行）
        const entry = this.memory.get(entryId);
        if (!entry) {
            await sandboxLog.append('host-replay-gate', { entryId, gate: 'entry-missing' });
            return gate('entry not found');
        }
        // 门禁二：两阶段令牌（validate 语义：不消费可重查；过期/错绑即拒）
        const token = this.replayTokens.get(opts.confirmToken);
        if (!token || token.entryId !== entryId || Date.now() > token.expiresAt) {
            await sandboxLog.append('host-replay-gate', { entryId, gate: 'token-invalid' });
            return gate('invalid or expired confirm token');
        }
        // 门禁三：重放时刻医生复核（固化时的 approved 前提之上，最新否决即刻拦截）
        const latest = this.verdictCache.get(entry.chainId);
        if (latest && latest.verdict === 'rejected') {
            await sandboxLog.append('host-replay-gate', { entryId, gate: 'doctor-rejected' });
            return gate(`doctor rejected chain ${entry.chainId}: ${latest.rationale ?? 'no rationale'}`);
        }
        // 门禁四A：置信度达标（可靠度 = 宿主重放导出值；阈值缺省 = Laplace 中性先验）
        const minRel = this.cfg.hostReplayMinReliability ?? DEFAULT_MIN_RELIABILITY;
        const rel = muscleReliability(entry);
        if (rel < minRel) {
            await sandboxLog.append('host-replay-gate', { entryId, gate: 'reliability', rel, minRel });
            return gate(`reliability ${rel.toFixed(3)} below threshold ${minRel}`);
        }
        // 门禁四B：TRUST IS A FINGERPRINT —— 宿主最新观察与排练入口同屏方可放行
        const minSim = this.cfg.entrySceneMinSimilarity ?? DEFAULT_SCENE_SIMILARITY;
        if (!entry.entrySceneFingerprint || !this.hostFingerprint ||
            fpSimilarity(entry.entrySceneFingerprint, this.hostFingerprint) < minSim) {
            await sandboxLog.append('host-replay-gate', {
                entryId, gate: 'fingerprint-mismatch',
                entryHasFp: !!entry.entrySceneFingerprint, hostObserved: !!this.hostFingerprint,
            });
            return gate('host state does not match rehearsal entry scene (stale rehearsal is a lie)');
        }
        // 全门禁通过：消费令牌（用后即焚 —— 授权与执行解耦窗口关闭）
        this.replayTokens.delete(opts.confirmToken);
        // 宿主执行器未接线（开发者预览）⇒ 诚实 failed（对齐现世 orchestrator Actor 未接线先例：
        // 诚实失败优于虚假成功）。未来纪元：此处经宿主管线逐动作执行并收集 journalRefs。
        const outcome = {
            muscleMemoryId: entryId,
            verdict: 'failed',
            journalRefs: [],
            divergences: [{
                    stepIndex: -1,
                    kind: 'effect-missing',
                    sandboxSaid: `authorized (${entry.steps.length} steps, reliability ${rel.toFixed(3)})`,
                    hostDid: 'no host executor wired (developer preview)',
                }],
            reliabilityAfter: muscleReliability(entry),
            reportPath: this.persistReport(`replay-${entryId}-${createdAt}.json`, {
                gate: 'passed', executor: 'not-wired', entryId, createdAt,
            }),
            createdAt,
        };
        await sandboxLog.append('host-replay-end', {
            entryId, verdict: outcome.verdict, divergences: outcome.divergences.length,
        });
        if (this.ctx) {
            emitHostReplayEnd(this.ctx, {
                muscleMemoryId: entryId, verdict: outcome.verdict,
                divergenceCount: outcome.divergences.length,
                reportPath: outcome.reportPath, endedAt: createdAt,
            });
        }
        return outcome;
    }
    verifyLog() {
        return { ok: true, value: sandboxLog.verify() };
    }
    reset() {
        // 持久化资产已在 ctx.effect 清理函数先行落盘（对齐主插件卸载时序）
        this.memory.reset();
        this.replayTokens.clear();
        this.verdictCache.clear();
        this.hostFingerprint = null;
        this.hostFingerprintAt = 0;
        sandboxLog.reset();
    }
}
