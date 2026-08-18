// src/tools/cognitions.ts
// 认知升维的工具面：反事实推理（C-3）+ 群体智慧查询（C-5）。
//   what_if      — 侦探式回溯：失败决策点 × 历史异action证据，输出「如果...那么...」报告
//   swarm_report — 经验晶体/漂移预测对模型可见（自观测的 Agent 看得见群体记忆）
import { defineTool } from '@deepseek-ai/dsh-tools';
import { journal } from '../journal.js';
import { swarm } from '../swarm.js';
import { contextManager } from '../contextManager.js';
/** C-3：反事实推理 —— 从因果时间轴定位决策点，汇集证据化替代路径 */
export function createWhatIfTool() {
    return defineTool({
        name: 'what_if',
        description: 'Counterfactual reasoning over the causal timeline: locates failed decision points and surfaces ' +
            'historically evidenced ALTERNATIVE actions at the same scene ("what if I had clicked X instead?"). ' +
            'Use this when stuck in a loop or after repeated failures — do not brute-force retry.',
        parameters: {
            failed_only: {
                type: 'boolean', required: false,
                description: 'Only examine FAILED / no-effect entries. Default true.',
            },
            since_step: {
                type: 'number', required: false,
                description: 'Only examine journal entries from this index onwards. Default: all.',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            const points = journal.findDecisionPoints({
                failedOnly: args.failed_only ?? true,
                sinceIndex: args.since_step,
            });
            if (points.length === 0) {
                return JSON.stringify({
                    status: 'SUCCESS',
                    state_anchor: { decision_points: 0 },
                    next_step: 'No failed decision points in the current journal window. ' +
                        'If you feel stuck, the issue may be in planning rather than execution — re-examine the task decomposition.',
                }, null, 2);
            }
            // 报告预算：最多 5 个决策点（防长报告反噬 Token）
            const lines = points.slice(-5).reverse().map(p => {
                const thought = p.thought ? `"${p.thought}"` : '(no declared reasoning — declare reasoning in future actions)';
                const alts = p.alternatives.length > 0
                    ? p.alternatives.map(a => `    * ${a.action} → ${a.historicalOutcome} [${a.evidence}]`).join('\n')
                    : '    (no same-scene alternatives recorded — this scene was only ever approached this way)';
                return `Decision #${p.index}: ${p.entry.tool} ${JSON.stringify(p.entry.args).slice(0, 80)} → ${p.entry.status}` +
                    (p.entry.effect_detected === false ? ' (no visual effect)' : '') +
                    `\n  thought: ${thought}\n  alternatives:\n${alts}`;
            });
            return JSON.stringify({
                status: 'SUCCESS',
                state_anchor: {
                    decision_points: points.length,
                    causal_note: 'Each entry records observe→thought→action→result; alternatives come from the same-scene history.',
                },
                analysis: lines.join('\n\n'),
                next_step: 'Weigh the alternatives above. To "rewind", call replay_actions from before the failing step ' +
                    'and substitute a different action; otherwise pick the historically successful route and continue manually.',
            }, null, 2);
        },
    });
}
/** C-5：群体智慧报告 —— 经验晶体 + UI 漂移预测对模型可见 */
export function createSwarmReportTool() {
    return defineTool({
        name: 'swarm_report',
        description: 'Reports collective experience: locally crystallized (scene,tool) success statistics and learned UI drift. ' +
            'Use before acting in a familiar-looking scene — the crowd may already know which route works. ' +
            'Also returns a drift-corrected coordinate suggestion for the current scene.',
        parameters: {},
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute() {
            const report = swarm.report();
            const sceneHash = contextManager.lastImageRecord()?.hash;
            const drift = sceneHash ? swarm.predictDrift(sceneHash) : null;
            const topRoutes = report.topRoutes.length > 0
                ? report.topRoutes.map(r => `  ${r.key}: success ${(r.successRate * 100).toFixed(0)}% over ${r.attempts} attempts`).join('\n')
                : '  (no crystallized experience yet)';
            return JSON.stringify({
                status: 'SUCCESS',
                state_anchor: {
                    crystals: report.crystals,
                    drift_models: report.driftModels,
                    swarm_endpoint: report.endpoint,
                    last_sync: report.lastSyncAt ? new Date(report.lastSyncAt).toISOString() : 'never',
                },
                top_routes: topRoutes,
                current_scene_drift: drift
                    ? `learned drift (dx,dy)=(${drift.dx.toFixed(3)},${drift.dy.toFixed(3)}) confidence=${drift.confidence} — ` +
                        'if a remembered coordinate misses, try shifting by this vector before re-locating'
                    : 'no drift learned for this scene yet',
                next_step: report.crystals === 0
                    ? 'No collective experience yet. Successful routes crystallize automatically as you work (and into checkpoints).'
                    : 'Prefer high-success routes in this scene; apply the drift correction when reusing stale coordinates.',
            }, null, 2);
        },
    });
}
