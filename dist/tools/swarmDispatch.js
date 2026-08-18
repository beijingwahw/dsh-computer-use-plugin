// src/tools/swarmDispatch.ts
// D-1 工具面：swarm_dispatch —— 模型即 Planner，工具即团队组建器。
// 意识轮转协议：spawn 返回首个轮到者 → 模型以该角色用常规工具执行使命 →
// report 提交并自动轮转（提示语显式要求「遗忘前一角色，只留其报告」）→
// 全员报告后 arbitrate 交叉裁决。物理 IO 由 system.serialize 保证互斥。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { coordinator } from '../subAgent.js';
export function createSwarmDispatchTool(config) {
    return defineTool({
        name: 'swarm_dispatch',
        description: 'Multi-agent team coordinator (one physical body, many minds). Use for parallelizable complex tasks ' +
            'such as "research these 3 competitors and write a comparison". Protocol: ' +
            '(1) spawn role-based sub-agents; (2) the tool names the ACTIVE agent — pursue ITS objective with the normal tools; ' +
            '(3) swarm_dispatch(action="status") to check roster/budgets anytime; ' +
            '(4) swarm_dispatch(action="report") to file the active agent\'s findings (auto-rotates to the next persona); ' +
            '(5) when all have reported, swarm_dispatch(action="arbitrate") cross-validates and issues the final verdict.',
        parameters: {
            action: {
                type: 'string', required: true,
                description: "One of: 'spawn' | 'status' | 'report' | 'arbitrate'",
            },
            specs: {
                type: 'string', required: false,
                description: 'spawn only: JSON array of mission briefs, e.g. ' +
                    '[{"id":"scout-a","role":"Competitor A analyst","objective":"Open A\'s pricing page and extract plan prices; deliverable: price list","maxSteps":15}]. ' +
                    'objective MUST be self-contained (readable without the main conversation).',
            },
            findings: {
                type: 'string', required: false,
                description: 'report only: the active agent\'s conclusions (facts found, deliverables, blockers).',
            },
            confidence: {
                type: 'number', required: false,
                description: 'report only: self-assessed confidence 0.0-1.0 (weights the final arbitration).',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            switch (args.action) {
                case 'spawn': return handleSpawn(args.specs);
                case 'status': return handleStatus();
                case 'report': return handleReport(args.findings, args.confidence);
                case 'arbitrate': return await handleArbitrate();
                default:
                    return `[Error]: Unknown action "${args.action}". Use spawn | status | report | arbitrate.`;
            }
        },
    });
}
function handleSpawn(rawSpecs) {
    let specs;
    try {
        const parsed = JSON.parse(rawSpecs ?? '[]');
        if (!Array.isArray(parsed))
            throw new Error('not an array');
        specs = parsed;
    }
    catch (e) {
        return `[Error]: specs must be a JSON array of mission briefs (${e.message}).`;
    }
    if (specs.length === 0)
        return '[Error]: specs is empty — nothing to spawn.';
    const accepted = coordinator.spawn(specs);
    if (accepted.length === 0) {
        return `[Error]: No agent spawned — team is full (${coordinator.roster().length} active) or all ids duplicate.`;
    }
    const rejected = specs.length - accepted.length;
    const lines = accepted.map(a => `  - ${a.spec.id} [${a.spec.role}] mission: ${a.spec.objective} (budget ${a.spec.maxSteps} steps)`);
    const cur = coordinator.current();
    return `[System]: Team assembled — ${accepted.length} agent(s) accepted` +
        (rejected > 0 ? `, ${rejected} rejected (capacity/duplicate)` : '') + '.\n' +
        lines.join('\n') + '\n' +
        `Active agent: ${cur?.spec.id} [${cur?.spec.role}]. ` +
        `NOW pursue ITS objective as this persona, using the normal tools. ` +
        `Forget the main task's framing while in persona; check status anytime; report when its mission is done.`;
}
function handleStatus() {
    const roster = coordinator.roster();
    if (roster.length === 0)
        return '[System]: No team. Call swarm_dispatch(action="spawn", specs=[...]) first.';
    const lines = roster.map(a => {
        const budget = `${a.stepsUsed}/${a.spec.maxSteps}`;
        const over = a.stepsUsed >= a.spec.maxSteps ? ' [OVER BUDGET — wrap up and report now]' : '';
        const rep = a.report ? ` report: "${a.report.findings.slice(0, 80)}${a.report.findings.length > 80 ? '…' : ''}" (conf ${a.report.confidence})` : '';
        return `  - ${a.spec.id} [${a.spec.role}] ${a.status} steps ${budget}${over}${rep}`;
    });
    const cur = coordinator.current();
    if (!cur) {
        return `[System]: All agents reported.\n${lines.join('\n')}\n` +
            `Next: swarm_dispatch(action="arbitrate") for the cross-validated final verdict.`;
    }
    return `[System]: Roster (${roster.length} agents).\n${lines.join('\n')}\n` +
        `Active agent: ${cur.spec.id} [${cur.spec.role}] — mission: ${cur.spec.objective} ` +
        `(steps ${cur.stepsUsed}/${cur.spec.maxSteps}).`;
}
function handleReport(findings, confidence) {
    const text = (findings ?? '').trim();
    if (!text)
        return '[Error]: report requires findings (the active agent\'s conclusions).';
    const cur = coordinator.current();
    if (!cur)
        return '[System]: No pending agent. If all reported, call swarm_dispatch(action="arbitrate").';
    const conf = typeof confidence === 'number' ? confidence : 0.7;
    const next = coordinator.report(cur.spec.id, text, conf);
    if (next) {
        return `[System]: ${cur.spec.id} report filed (confidence ${conf}).\n` +
            `PERSONA SWITCH → ${next.spec.id} [${next.spec.role}]. Mission: ${next.spec.objective}\n` +
            `Work ONLY on this new mission. The previous persona's raw reasoning is void — only its filed report survives.`;
    }
    return `[System]: ${cur.spec.id} report filed (confidence ${conf}). All agents reported — ` +
        `call swarm_dispatch(action="arbitrate") for the final verdict.`;
}
async function handleArbitrate() {
    const arb = await coordinator.arbitrate();
    if (!arb) {
        const pending = coordinator.roster().filter(a => a.status === 'pending' || a.status === 'working');
        return `[Error]: Not all agents have reported (pending: ${pending.map(a => a.spec.id).join(', ') || 'none'}).`;
    }
    const cross = arb.crossValidation.length
        ? '\nCross-validation: ' + arb.crossValidation
            .map(c => `${c.pair[0]}×${c.pair[1]}=${c.agreement}`).join(', ')
        : '';
    return `[System]: Verdict: ${arb.verdict}` +
        (arb.winner ? ` (winner: ${arb.winner})` : '') +
        `.\nRationale: ${arb.rationale}${cross}\n` +
        `Synthesize the final answer from the reports (weighted by the verdict), then disband the team by moving on with the main task.`;
}
