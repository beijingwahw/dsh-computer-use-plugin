// src/observabilityTools.ts
// 第七轮创新的工具面：把「系统的自我认知」暴露给模型与用户。
//   get_metrics     —— 运行指标 + 模型自省洞见（noop 率高的工具直接点名）
//   verify_journal  —— 哈希链审计：证明行动日志未被篡改（或定位第一个断点）
//   self_diagnose   —— 子系统活体检查（preflight）：截图管线/感知管线/记忆体/审计链
//   save_checkpoint —— 手动快照全部认知态（里程碑保护；卸载时另有自动档）
// 设计原则：观测是旁路义务 —— 任何检查失败都返回结构化报告，绝不抛异常中断任务。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { telemetry } from '../telemetry.js';
import { journal } from '../journal.js';
import { uiMemory } from '../uiMemory.js';
import { skillLibrary } from '../skillLibrary.js';
import { failureMemory } from '../failureMemory.js';
import { saveCheckpoint } from '../checkpoint.js';
import { system } from '../system.js';
import { dhash } from '../perceptualHash.js';
import { diagnose } from '../diagnosis.js';
import { fitReactPhases } from '../phaseHmm.js';
import { reactTraceProperties } from '../ltlf.js';
import { Telemetry } from '../telemetry.js';
export function createGetMetricsTool() {
    return defineTool({
        name: 'get_metrics',
        description: 'Returns runtime telemetry: per-tool success/no-op rates, latency percentiles (P50/P95/P99), ' +
            'and memory hit rates, plus actionable insights about your own recent performance. ' +
            'Call this when you suspect you are repeating ineffective actions.',
        parameters: {},
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute() {
            const insights = telemetry.insights();
            // F-2 极值延迟洞见：ξ ≥ 0.25 的重尾点名（P99 看不见的黑天鹅，p999 外推给数字）
            // I-2 法医升级：拟合优度不合格时如实降级 —— 不可信的估计宁可不出手
            const tail = telemetry.tailReport();
            if (tail && tail.xi >= 0.25 && tail.fit === 'ok') {
                insights.push(`HEAVY LATENCY TAIL (ξ=${tail.xi}): occasional extreme stalls are structural, not bad luck — ` +
                    `p99.9 extrapolates to ~${tail.p999}ms. Prefer fewer, larger actions over rapid retries in this regime.`);
            }
            if (tail && tail.fit === 'poor') {
                insights.push(`TAIL ESTIMATE UNRELIABLE (Anderson-Darling A²=${tail.adStat} > 3): the latency tail does not ` +
                    'follow a GPD shape — treat any p99.9 extrapolation skeptically until more samples arrive.');
            }
            // F-4 行为复杂度洞见：动作流近周期（屏幕可能不变而动作在转 —— 行为侧卡死签名）。
            // 判据双臂：归一化熵率 ≤0.3（渐近域）或 短语数 ≤6 且样本 ≥20（短序列的
            // 倍增签名 —— 归一化在小 n 时通胀，短语绝对数不受此影响）
            const behav = journal.actionComplexity();
            const nearPeriodic = (behav.normalized !== null && behav.normalized <= 0.3 && behav.length >= 24) ||
                (behav.phrases <= 6 && behav.length >= 20);
            if (nearPeriodic) {
                insights.push(`LOW BEHAVIORAL COMPLEXITY (${behav.phrases} phrases / ${behav.length} actions, ` +
                    `entropy-rate ${behav.normalized}): your action stream is near-periodic — you are probably spinning. ` +
                    'Break the cycle: what_if for counterfactual routes, match_skill for a verified path, or ask the user.');
            }
            // G-2 变点洞见：某工具近期失败率突变（环境变了 vs 路线从来就错 —— 两种诊断）
            const regimeShifts = telemetry.regimeShifts();
            for (const rs of regimeShifts) {
                insights.push(`REGIME SHIFT: ${rs.tool} failure rate has JUMPED recently (CUSUM ${rs.cusum} ≥ 2.5 vs ` +
                    `baseline ${Math.round(rs.baselineFailureRate * 100)}%) — the environment changed under you. ` +
                    'Re-observe with take_screenshot; what worked before may need a new route now.');
            }
            // G-6 行为长程依赖：Hurst > 0.6 ⇒ 失败扎堆（持续性强）—— 失败后立即重试是最差策略
            const H = telemetry.hurst();
            if (H !== null && H > 0.6) {
                insights.push(`STREAKY OUTCOMES (Hurst H=${H}): failures cluster in time — after a failure the next attempt ` +
                    'is MORE likely to fail too. Do not blind-retry: switch modality (press_hotkey), zoom_inspect, or recall_ui immediately.');
            }
            // H-4 联合诊断皮层：多引擎信号会诊（症候群 > 孤立异常 —— 规则可审计）
            const highNoopTools = telemetry.snapshot().tools
                .filter(t => t.noop_rate !== null && t.noop_rate >= 40 && t.calls >= 5)
                .map(t => t.tool);
            const dx = diagnose({
                regimeShiftTools: regimeShifts.map(r => r.tool),
                hurst: H,
                behavior: behav,
                heavyLatencyTail: !!(tail && tail.xi >= 0.25),
                highNoopTools,
            });
            if (dx) {
                insights.push(`DIAGNOSIS [${dx.syndrome}]: ${dx.diagnosis} → ${dx.prescription}`);
            }
            // H-3 Thompson 模态仲裁：后验抽样推荐（探索与利用按证据强度成比例）
            const modality = telemetry.suggestModality();
            // I-3 HMM 相态透视：Viterbi 解码当前行为相态（隐态：progress/retry/explore/stuck）
            const phase = fitReactPhases(journal.list(true).map(e => e.tool));
            if (phase && (phase.current === 'stuck' || phase.occupancy.stuck >= 0.4)) {
                insights.push(`PHASE PORTRAIT (HMM): currently ${phase.current.toUpperCase()} ` +
                    `(stuck occupancy ${(phase.occupancy.stuck * 100).toFixed(0)}%, longest run ${phase.longestStuckRun}) — ` +
                    'the hidden mode behind your action stream is grinding. Change the unit of work: bigger steps, different modality.');
            }
            // I-5 置换检验：两模态显著差的证书（精确枚举 —— 无渐近假设的小样本正道）
            const toolList = telemetry.snapshot().tools.filter(t => t.calls >= 8);
            for (let i = 0; i < toolList.length; i++) {
                for (let j = i + 1; j < toolList.length; j++) {
                    const a = toolList[i], b = toolList[j];
                    const stat = Telemetry.permutationTest2Prop(Math.round(((a.success_rate ?? 0) / 100) * a.calls), a.calls, Math.round(((b.success_rate ?? 0) / 100) * b.calls), b.calls);
                    if (stat && stat.pValue < 0.05) {
                        const better = (a.success_rate ?? 0) >= (b.success_rate ?? 0) ? a.tool : b.tool;
                        const worse = better === a.tool ? b.tool : a.tool;
                        insights.push(`CERTIFIED SIGNIFICANCE (${stat.mode}, p=${stat.pValue.toFixed(3)}): ` +
                            `${better} is reliably more effective than ${worse} — prefer ${better} when both apply.`);
                    }
                }
            }
            // I-6 一阶随机占优：延迟的全序裁决（每个分位都不晚才算快 —— 交叉分布不裁）
            const domPairs = telemetry.latencyDominancePairs();
            for (const d of domPairs.slice(0, 3)) {
                insights.push(`LATENCY DOMINANCE: ${d.faster} stochastically dominates ${d.slower} ` +
                    '(faster at every percentile — no trade-off).');
            }
            return JSON.stringify({
                status: 'SUCCESS',
                metrics: telemetry.snapshot(),
                ...(tail ? { latency_tail: tail } : {}),
                behavioral_complexity: behav,
                ...(regimeShifts.length > 0 ? { regime_shifts: regimeShifts } : {}),
                ...(H !== null ? { outcome_hurst: H } : {}),
                ...(dx ? { diagnosis: dx } : {}),
                ...(modality ? { modality_arbitration: modality } : {}),
                ...(phase ? { react_phase: { current: phase.current, occupancy: phase.occupancy, longest_stuck_run: phase.longestStuckRun } } : {}),
                ...(domPairs.length > 0 ? { latency_dominance: domPairs } : {}),
                insights: insights.length > 0
                    ? insights
                    : ['No anomalies detected. Keep using verify-effective strategies.'],
            }, null, 2);
        },
    });
}
export function createVerifyJournalTool() {
    return defineTool({
        name: 'verify_journal',
        description: 'Audits the action journal hash chain (SHA-256, tamper-evident). ' +
            'OK = the recorded history is provably intact. A broken index means the log was modified ' +
            'after the fact — treat everything after that point as untrusted.',
        parameters: {
            tail: { type: 'number', required: false, description: 'Also show the last N entries (default 5).' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            const v = journal.verify();
            const n = Math.min(Math.max(args.tail ?? 5, 0), 20);
            const tail = journal.list().slice(-n).map((e, i) => `${i + 1}. ${e.tool} ${e.status}${e.effect_detected === false ? ' (no effect)' : ''} ${e.hash?.slice(0, 12) ?? ''}`);
            return JSON.stringify({
                status: v.ok ? 'SUCCESS' : 'FAILED',
                state_anchor: {
                    chain_integrity: v.ok ? 'INTACT' : 'BROKEN',
                    entries: v.length,
                    first_broken_at_index: v.brokenAt,
                },
                recent_entries: tail,
                next_step: v.ok
                    ? undefined
                    : `The journal chain breaks at entry #${v.brokenAt}. Entries after it are not trustworthy; ` +
                        'investigate what modified the log before replaying anything from it.',
            }, null, 2);
        },
    });
}
export function createSelfDiagnoseTool(config) {
    return defineTool({
        name: 'self_diagnose',
        description: 'Runs live health checks on all subsystems: screen capture pipeline, perceptual hashing, ' +
            'memory stores (UI/skills/failures), journal audit chain, and telemetry. ' +
            'Call this at session start, or whenever tool results seem inconsistent with reality.',
        parameters: {},
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute() {
            const checks = [];
            // 1. 截图管线（一切视觉能力的地基）
            try {
                const buf = await system.captureScreen();
                checks.push({ subsystem: 'screen-capture', status: buf.length > 0 ? 'GREEN' : 'RED', detail: `${buf.length} bytes` });
                // 2. 感知管线：对真实截图像指纹（端到端活体检测，非单测）
                const hash = await dhash(buf);
                checks.push({
                    subsystem: 'perceptual-hash',
                    status: /^[01]{64}$/.test(hash) ? 'GREEN' : 'RED',
                    detail: `fingerprint ${hash.slice(0, 12)}…`,
                });
            }
            catch (e) {
                checks.push({ subsystem: 'screen-capture', status: 'RED', detail: e.message });
                checks.push({ subsystem: 'perceptual-hash', status: 'RED', detail: 'skipped (capture failed)' });
            }
            // 3. 记忆体
            checks.push({ subsystem: 'ui-memory', status: uiMemory.size > 0 ? 'GREEN' : 'AMBER', detail: `${uiMemory.size} landmark(s)` });
            checks.push({ subsystem: 'skill-library', status: skillLibrary.list().length > 0 ? 'GREEN' : 'AMBER', detail: `${skillLibrary.list().length} skill(s)` });
            checks.push({ subsystem: 'failure-memory', status: failureMemory.size > 0 ? 'GREEN' : 'AMBER', detail: `${failureMemory.size} record(s)` });
            // 4. 审计链
            const v = journal.verify();
            checks.push({
                subsystem: 'journal-chain',
                status: v.ok ? 'GREEN' : 'RED',
                detail: v.ok ? `${v.length} entries intact` : `BROKEN at #${v.brokenAt}`,
            });
            // 5. 全局运行指标
            const snap = telemetry.snapshot();
            checks.push({
                subsystem: 'telemetry',
                status: 'GREEN',
                detail: `${snap.global.calls} calls, success ${snap.global.success_rate ?? '-'}%, noop ${snap.global.noop_rate ?? '-'}%`,
            });
            // 6. 干跑模式警示（动作全部只记录不执行 —— 非常容易忘记）
            if (config.dryRun) {
                checks.push({ subsystem: 'dry-run-mode', status: 'AMBER', detail: 'ACTIONS ARE NOT EXECUTED (dryRun=true)' });
            }
            // 7. I-1 LTLf 形式性质：ReAct 教义的可机检判决（违例逐位定位）
            const traceProps = reactTraceProperties(journal.list(true).map(e => ({ tool: e.tool, observed: e.observe !== undefined, effect: e.effect_detected })));
            const propViolations = traceProps.filter(p => p.violations.length > 0);
            if (propViolations.length > 0) {
                checks.push({
                    subsystem: 'react-temporal-properties',
                    status: 'AMBER',
                    detail: propViolations.map(p => `${p.id} ×${p.violations.length} @${p.violations.slice(0, 3).join(',')}`).join('; '),
                });
            }
            else if (traceProps.length > 0) {
                checks.push({ subsystem: 'react-temporal-properties', status: 'GREEN', detail: 'all LTLf properties hold' });
            }
            const red = checks.filter(c => c.status === 'RED').length;
            const amber = checks.filter(c => c.status === 'AMBER').length;
            return JSON.stringify({
                status: red > 0 ? 'FAILED' : 'SUCCESS',
                state_anchor: {
                    overall: red > 0 ? 'RED' : amber > 0 ? 'AMBER' : 'GREEN',
                    red, amber, green: checks.length - red - amber,
                },
                checks,
                next_step: red > 0
                    ? 'Critical subsystem(s) down. Do NOT attempt UI automation until the RED items are fixed ' +
                        '(check display/access permissions first — headless environments cannot capture screens).'
                    : amber > 0 && config.dryRun
                        ? 'Healthy but in dry-run mode: actions will be logged, not executed.'
                        : 'All critical subsystems healthy. Proceed with the task.',
            }, null, 2);
        },
    });
}
export function createSaveCheckpointTool(config) {
    return defineTool({
        name: 'save_checkpoint',
        description: 'Snapshots the entire cognitive state (UI memory, skills, failure memory, journal chain, metrics) ' +
            'to the configured checkpoint file (atomic write). Call it after completing valuable milestones ' +
            'so a crash can never erase them. Requires checkpointPath in config.',
        parameters: {},
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute() {
            const r = saveCheckpoint(config.checkpointPath);
            return r.ok
                ? `[System]: Checkpoint saved atomically (${r.steps} journal entries chained). ` +
                    'Crash-safe from this point on.'
                : `[Error]: Checkpoint not saved — ${r.error}`;
        },
    });
}
