// src/tools/qualityCheckup.ts
// D-4 质量医生的唯一出诊台。人格内嵌于工具描述（DSH 模式：工具即角色的躯壳）。
// 生命周期：惰性 configure（首次调用时用插件配置装配）—— 对 index.ts 零侵入。
// Token 纪律：对话流只进摘要；全量证据落盘 doctor-report.json。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { doctor, DOCTOR_RULES, ensureDoctorConfigured } from '../qualityDoctor.js';
import { telemetry } from '../telemetry.js';
export function createQualityCheckupTool(config) {
    return defineTool({
        name: 'quality_checkup',
        description: 'You are the Quality Doctor — the immune system of this digital organism. ' +
            'GENESIS FIRST: a cute feature that breaks an iron law is a tumor, not a gift. ' +
            'EVIDENCE OR SILENCE: every finding cites file:line and the exact snippet. ' +
            'PRESCRIBE, DON\'T OPERATE: you diagnose always; mechanical fixes only under explicit authorization. ' +
            'Actions: diagnose (audit code genes + causal chain), heal (apply mechanical fixes — requires ' +
            'explicit authorize=true, max_risk="mechanical", dry_run=false), lessons (evolution memory), ' +
            'self_audit (rule coverage of the six genesis laws).',
        parameters: {
            action: {
                type: 'string', required: true,
                description: 'diagnose | heal | lessons | self_audit',
            },
            files: {
                type: 'string', required: false,
                description: '[diagnose] Comma-separated sourceRoot-relative files for incremental audit (omit = full scan).',
            },
            include_chain_audit: {
                type: 'boolean', required: false,
                description: '[diagnose] Include causal-chain legality audit (default true).',
            },
            authorize: {
                type: 'boolean', required: false,
                description: '[heal] Explicit authorization for mechanical fixes. Default false.',
            },
            max_risk: {
                type: 'string', required: false,
                description: '[heal] "none" (default) or "mechanical". Structural fixes are proposals only, forever.',
            },
            dry_run: {
                type: 'boolean', required: false,
                description: '[heal] Preview patches without writing (default true).',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            const t0 = Date.now();
            const cfgErr = await ensureDoctorConfigured(config);
            if (cfgErr) {
                telemetry.observe('quality_checkup', 'FAILED', Date.now() - t0);
                return JSON.stringify({ status: 'FAILED', reason: cfgErr });
            }
            if (args.action === 'diagnose') {
                const files = args.files?.split(',').map((s) => s.trim()).filter(Boolean);
                const report = await doctor.diagnose(files && files.length > 0
                    ? { files, includeChainAudit: args.include_chain_audit !== false }
                    : { includeChainAudit: args.include_chain_audit !== false });
                telemetry.observe('quality_checkup', report.findings.some(f => f.severity === 'critical') ? 'UNKNOWN' : 'SUCCESS', Date.now() - t0);
                const sev = (s) => report.findings.filter(f => f.severity === s).length;
                // Token 纪律：Top-3 一行式发现；全量证据在磁盘报告
                const top3 = report.findings.slice(0, 3)
                    .map(f => `${f.severity} ${f.ruleId} ${f.location.file}:${f.location.line} — ${f.evidence}`)
                    .join('\n  ');
                return JSON.stringify({
                    status: 'SUCCESS',
                    score: report.score,
                    genesis_verdict: report.genesisVerdict,
                    findings_total: report.findings.length,
                    severity: { critical: sev('critical'), major: sev('major'), minor: sev('minor'), info: sev('info') },
                    by_category: report.byCategory,
                    incremental: report.incremental,
                    trend: report.trend,
                    warnings: report.warnings,
                    top_findings: report.findings.length > 0 ? `\n  ${top3}` : ' (clean)',
                    full_report: doctor.reportPath(),
                }, null, 2);
            }
            if (args.action === 'heal') {
                const report = await doctor.diagnose();
                const result = await doctor.heal(report, {
                    maxRisk: args.max_risk === 'mechanical' ? 'mechanical' : 'none',
                    authorized: args.authorize === true,
                    dryRun: args.dry_run !== false,
                });
                telemetry.observe('quality_checkup', 'SUCCESS', Date.now() - t0);
                return JSON.stringify({
                    status: 'SUCCESS',
                    applied: result.applied.length,
                    proposed_only: result.proposed.length,
                    rejected: result.rejected,
                    note: result.proposed.length > 0
                        ? 'Proposals are NOT applied. Structural surgery stays human-authorized.'
                        : undefined,
                    full_report: doctor.reportPath(),
                }, null, 2);
            }
            if (args.action === 'lessons') {
                telemetry.observe('quality_checkup', 'SUCCESS', Date.now() - t0);
                const m = doctor.memory();
                return JSON.stringify({
                    status: 'SUCCESS',
                    total_diagnoses: m.totalDiagnoses,
                    total_fixes_applied: m.totalFixesApplied,
                    last_baseline: m.lastReport,
                    lessons: m.lessons.map(l => `${l.ruleId} ×${l.occurrences} (first ${new Date(l.firstSeen).toISOString().slice(0, 10)}): ${l.note}`),
                }, null, 2);
            }
            if (args.action === 'self_audit') {
                telemetry.observe('quality_checkup', 'SUCCESS', Date.now() - t0);
                const audit = doctor.auditSelf();
                return JSON.stringify({
                    status: 'SUCCESS',
                    covered_laws: audit.coveredLaws,
                    missing_laws: audit.missingLaws,
                    rule_count: audit.ruleCount,
                    config_valid: audit.configValid,
                    config_errors: audit.configErrors,
                    registry: DOCTOR_RULES.map(r => `${r.id} [${r.severity}/${r.category}]`),
                }, null, 2);
            }
            telemetry.observe('quality_checkup', 'FAILED', Date.now() - t0);
            return JSON.stringify({
                status: 'FAILED',
                reason: `unknown action "${args.action}" — use diagnose | heal | lessons | self_audit`,
            });
        },
    });
}
