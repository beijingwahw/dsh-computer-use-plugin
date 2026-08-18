// src/qualityDoctor.ts
// D-4 质量医生：数字生命体的免疫系统。不是外部 Lint —— 是常驻的白细胞，
// 以创世铁律为抗体库，审查代码基因与因果链合法性。
// 三重身份：基因审查官（静态源码）、因果链法官（运行证据）、进化记忆载体（跨会话）。
// 医生对医生的最后一条铁律：完美的评分若来自未执行的规则，那是谎言，不是健康。
// 抛错分层契约：configure 校验失败 throw（开发时错误要响亮）；
// diagnose/heal 永不抛错（运行时取证要坚韧 —— 失败 = warnings + 优雅降级）。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { journal } from './journal.js';
import { DOCTOR_RULES, EMPTY_CATCH_FIX, lines } from './doctorRules.js';
export * from './doctorTypes.js';
export { DOCTOR_RULES } from './doctorRules.js';
// ─── 引擎内部工件 ───
const ALL_LAWS = [
    'io-serialization', 'token-discipline', 'architecture-void',
    'config-driven', 'zero-intrusion', 'honest-degradation',
];
const SEVERITY_PENALTY = { critical: 25, major: 10, minor: 4, info: 1 };
const SEVERITY_RANK = { critical: 0, major: 1, minor: 2, info: 3 };
// ─── 医生实现 ───
function atomicWrite(filePath, data) {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, data, 'utf8');
    renameSync(tmp, filePath);
}
function emptyReport(warnings) {
    return {
        timestamp: Date.now(), incremental: false, score: 100, genesisVerdict: 'intact',
        findings: [], byCategory: { genesis: 0, smell: 0, security: 0, chain: 0 },
        effectiveWeights: {}, trend: null, warnings, scannedFiles: 0, chainAudited: false,
    };
}
class Doctor {
    cfg = null;
    mem = { lessons: [], lastReport: null, totalDiagnoses: 0, totalFixesApplied: 0 };
    reportFile = null;
    pluginConfig = null;
    /** D-4 咬合点：进程内插件配置绑定（工具工厂调用；CLI 场景可为 null —— 当前规则均为阈值无关设计） */
    bindPluginConfig(config) { this.pluginConfig = config; }
    activeRules() {
        if (!this.cfg)
            return [];
        let rs = DOCTOR_RULES;
        if (this.cfg.rules && this.cfg.rules.length > 0) {
            const want = new Set(this.cfg.rules);
            rs = rs.filter(r => want.has(r.id));
        }
        if (this.cfg.tags && this.cfg.tags.length > 0) {
            const tags = new Set(this.cfg.tags);
            rs = rs.filter(r => (r.tags ?? []).some(t => tags.has(t)));
        }
        return rs;
    }
    async configure(config) {
        const errors = [];
        if (!existsSync(config.sourceRoot) || !statSync(config.sourceRoot).isDirectory()) {
            errors.push(`sourceRoot does not exist or is not a directory: ${config.sourceRoot}`);
        }
        if (!config.memoryPath)
            errors.push('memoryPath is required');
        if (config.rules) {
            const known = new Set(DOCTOR_RULES.map(r => r.id));
            for (const id of config.rules)
                if (!known.has(id))
                    errors.push(`unknown rule id: ${id}`);
        }
        if (errors.length === 0 && this.previewActive(config).length === 0) {
            errors.push('rules+tags filter combination leaves zero active rules — refusing a blind doctor');
        }
        if (errors.length > 0)
            throw new Error(`[QualityDoctor] invalid configuration:\n  - ${errors.join('\n  - ')}`);
        this.cfg = { ...config };
        this.reportFile = join(dirname(resolve(config.memoryPath)), 'doctor-report.json');
        // 进化记忆是开发者资产：存在则载入；损坏则警告并从新开始（不阻断 —— 取证要坚韧）
        if (existsSync(config.memoryPath)) {
            try {
                const parsed = JSON.parse(readFileSync(config.memoryPath, 'utf8'));
                this.mem = {
                    lessons: Array.isArray(parsed.lessons) ? parsed.lessons : [],
                    lastReport: parsed.lastReport ?? null,
                    totalDiagnoses: parsed.totalDiagnoses ?? 0,
                    totalFixesApplied: parsed.totalFixesApplied ?? 0,
                };
            }
            catch (e) {
                console.warn(`[QualityDoctor] memory file unreadable (${e.message}); starting fresh`);
                this.mem = { lessons: [], lastReport: null, totalDiagnoses: 0, totalFixesApplied: 0 };
            }
        }
    }
    previewActive(config) {
        const saved = this.cfg;
        this.cfg = config;
        const rs = this.activeRules();
        this.cfg = saved;
        return rs;
    }
    walkSource() {
        const root = resolve(this.cfg.sourceRoot);
        const out = [];
        const walk = (dir) => {
            for (const name of readdirSync(dir)) {
                const full = join(dir, name);
                const st = statSync(full);
                if (st.isDirectory())
                    walk(full);
                else if (name.endsWith('.ts')) {
                    const rel = relative(root, full).split(sep).join('/');
                    try {
                        out.push({ path: rel, content: readFileSync(full, 'utf8') });
                    }
                    catch (e) {
                        out.push({ path: rel, content: '' });
                    }
                }
            }
        };
        walk(root);
        return out;
    }
    loadSnapshot() {
        const cpPath = this.pluginConfig?.checkpointPath;
        if (!cpPath || !existsSync(cpPath))
            return null;
        try {
            const cp = JSON.parse(readFileSync(cpPath, 'utf8'));
            return cp && cp.version === 3 ? cp : null;
        }
        catch {
            return null;
        }
    }
    async diagnose(scope) {
        if (!this.cfg || !this.reportFile)
            return emptyReport(['doctor not configured — call configure() first (inert by design)']);
        const warnings = [];
        try {
            const incremental = Array.isArray(scope?.files) && scope.files.length > 0;
            let sources;
            if (incremental) {
                sources = [];
                const root = resolve(this.cfg.sourceRoot);
                for (const rel of scope.files) {
                    if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
                        warnings.push(`scope file rejected (must be sourceRoot-relative): ${rel}`);
                        continue;
                    }
                    const full = resolve(root, rel);
                    if (!full.startsWith(root) || !existsSync(full)) {
                        warnings.push(`scope file missing or out of root: ${rel}`);
                        continue;
                    }
                    try {
                        sources.push({ path: rel.split(sep).join('/'), content: readFileSync(full, 'utf8') });
                    }
                    catch (e) {
                        warnings.push(`unreadable: ${rel} (${e.message})`);
                    }
                }
            }
            else {
                sources = this.walkSource();
            }
            const includeChain = scope?.includeChainAudit !== false;
            const verify = journal.verify();
            if (includeChain && !verify.ok) {
                warnings.push(`journal chain broken at index ${verify.brokenAt} — chain-audit findings may be unreliable`);
            }
            const snapshot = this.loadSnapshot();
            const ctx = {
                sources,
                chain: { entries: includeChain ? journal.list(false) : [], chainIntact: verify.ok },
                snapshot,
                // CLI 模式下为 null：当前全部规则均为阈值无关设计，类型保持接口契约
                config: (this.pluginConfig ?? {}),
                warn: (m) => warnings.push(m),
            };
            const findings = [];
            const ruleById = new Map(DOCTOR_RULES.map(r => [r.id, r]));
            const effWeights = {};
            for (const rule of this.activeRules()) {
                if (rule.category === 'chain' && !includeChain)
                    continue;
                try {
                    const found = await rule.scan(ctx);
                    findings.push(...found);
                    if (found.length > 0)
                        effWeights[rule.id] = this.effectiveWeight(rule.id);
                }
                catch (e) {
                    warnings.push(`rule ${rule.id} crashed and was skipped (${e.message}) — contract violation, report as bug`);
                }
            }
            const byCategory = { genesis: 0, smell: 0, security: 0, chain: 0 };
            let penalty = 0;
            for (const f of findings) {
                const cat = ruleById.get(f.ruleId)?.category ?? 'smell';
                byCategory[cat]++;
                penalty += SEVERITY_PENALTY[f.severity] * (effWeights[f.ruleId] ?? 1);
            }
            const score = Math.max(0, Math.min(100, Math.round((100 - penalty) * 10) / 10));
            const genesisViolated = findings.some(f => {
                const r = ruleById.get(f.ruleId);
                return r?.category === 'genesis' && (f.severity === 'critical' || f.severity === 'major');
            });
            findings.sort((a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) ||
                ((effWeights[b.ruleId] ?? 1) - (effWeights[a.ruleId] ?? 1)));
            const hitRules = [...new Set(findings.map(f => f.ruleId))];
            let trend = null;
            if (!incremental && this.mem.lastReport) {
                const prev = new Set(this.mem.lastReport.hitRules);
                const now = new Set(hitRules);
                trend = {
                    scoreDelta: Math.round((score - this.mem.lastReport.score) * 10) / 10,
                    newRulesHit: hitRules.filter(r => !prev.has(r)),
                    removedRulesHit: [...prev].filter(r => !now.has(r)),
                };
            }
            const report = {
                timestamp: Date.now(), incremental, score,
                genesisVerdict: genesisViolated ? 'violated' : 'intact',
                findings, byCategory, effectiveWeights: effWeights, trend, warnings,
                scannedFiles: sources.length, chainAudited: includeChain,
            };
            // 报告落盘（Token 纪律：对话流只进摘要，全量证据在磁盘）
            try {
                atomicWrite(this.reportFile, JSON.stringify(report, null, 2));
            }
            catch (e) {
                warnings.push(`report persist failed: ${e.message}`);
            }
            // 基线纪律：仅全量诊断更新 lastReport —— 增量是验证工具，不是新基线
            this.mem.totalDiagnoses++;
            if (!incremental) {
                this.mem.lastReport = { score, hitRules, findingsCount: findings.length, scannedFiles: sources.length };
            }
            this.persistMemory(warnings);
            if (this.cfg.strict && genesisViolated) {
                console.error('[QualityDoctor] GENESIS VIOLATED — iron laws broken (strict mode): fix before anything else.');
            }
            return report;
        }
        catch (e) {
            // 永不抛错契约：现场级故障 = 空报告 + warning
            warnings.push(`diagnosis aborted: ${e.message}`);
            return emptyReport(warnings);
        }
    }
    async heal(report, opts) {
        const result = { applied: [], proposed: [], rejected: [] };
        if (!this.cfg)
            return result;
        const maxRisk = opts?.maxRisk ?? 'none';
        const authorized = opts?.authorized === true;
        const dryRun = opts?.dryRun !== false;
        if (maxRisk === 'none')
            return result; // 诊断即终点
        const proposals = [];
        for (const f of report.findings) {
            if (f.location.file === 'journal')
                continue; // 链上发现的解药是行为修正，不是文本补丁
            const src = f.location.snippet;
            if (f.riskLevel === 'mechanical') {
                // 机械修复：空 catch 补注释（唯一确定安全的文本手术）
                const commented = /catch/.test(src)
                    ? src.replace(/\{\s*\}\s*$/, `{ /* ${EMPTY_CATCH_FIX} */ }`)
                    : src;
                proposals.push({
                    findingId: f.id, riskLevel: 'mechanical',
                    patch: { file: f.location.file, before: src, after: commented, lineRange: { start: f.location.line, end: f.location.line } },
                });
            }
            else {
                // 结构性手术：永远只是注释化提案（人类/造物主裁决后手动落地）
                proposals.push({
                    findingId: f.id, riskLevel: 'structural',
                    patch: {
                        file: f.location.file, before: src,
                        after: `// DOCTOR(proposal, do not auto-apply): ${f.recommendation}\n${src}`,
                        lineRange: { start: f.location.line, end: f.location.line },
                    },
                });
            }
        }
        for (const p of proposals) {
            // 手术锁（genesis.zero-intrusion-guard 的金丝雀锚点）：structural 恒不写盘
            if (p.riskLevel !== 'mechanical') {
                result.proposed.push(p);
                continue;
            }
            if (!authorized || dryRun) {
                result.proposed.push(p);
                continue;
            }
            // 真实写盘路径：lineRange 过期保护 —— before 在范围内恰有一次匹配
            try {
                const full = resolve(this.cfg.sourceRoot, p.patch.file);
                const ls = lines(readFileSync(full, 'utf8'));
                const { start, end } = p.patch.lineRange;
                const hits = [];
                for (let i = Math.max(0, start - 1); i < Math.min(ls.length, end); i++) {
                    if (ls[i] === p.patch.before)
                        hits.push(i);
                }
                if (hits.length !== 1) {
                    result.rejected.push({
                        findingId: p.findingId,
                        reason: hits.length === 0
                            ? 'patch expired: target line no longer matches (file changed after diagnosis)'
                            : `ambiguous: ${hits.length} matches inside lineRange`,
                    });
                    continue;
                }
                ls[hits[0]] = p.patch.after;
                atomicWrite(full, ls.join('\n'));
                result.applied.push(p);
            }
            catch (e) {
                result.rejected.push({ findingId: p.findingId, reason: `apply failed: ${e.message}` });
            }
        }
        if (result.applied.length > 0) {
            this.mem.totalFixesApplied += result.applied.length; // 仅真实写盘计数 —— 量化指标不许掺水
            this.persistMemory([]);
        }
        return result;
    }
    recordLesson(ruleId, note) {
        const known = DOCTOR_RULES.some(r => r.id === ruleId);
        if (!known) {
            console.warn(`[QualityDoctor] recordLesson: unknown ruleId "${ruleId}" ignored`);
            return;
        }
        const existing = this.mem.lessons.find(l => l.ruleId === ruleId);
        const now = Date.now();
        if (existing) {
            existing.occurrences++;
            existing.lastSeen = now;
            existing.note = note;
        }
        else {
            this.mem.lessons.push({ ruleId, firstSeen: now, occurrences: 1, lastSeen: now, note });
        }
        this.persistMemory([]);
    }
    effectiveWeight(ruleId) {
        const rule = DOCTOR_RULES.find(r => r.id === ruleId);
        if (!rule)
            return 1;
        const occ = this.mem.lessons.find(l => l.ruleId === ruleId)?.occurrences ?? 0;
        // baseWeight × (1 + 0.2×occurrences)，封顶 3x（occ ≥ 10 触顶）—— 规则对象永不被修改
        return Math.round(rule.baseWeight * Math.min(3, 1 + 0.2 * occ) * 1000) / 1000;
    }
    auditSelf() {
        const configErrors = [];
        let active = [];
        if (!this.cfg) {
            configErrors.push('not configured');
        }
        else {
            active = this.activeRules();
            if (active.length === 0)
                configErrors.push('zero active rules under current filters');
        }
        const basis = active.length > 0 ? active : DOCTOR_RULES; // 未配置时报告注册表纸面覆盖（configValid=false 已如实标注）
        const covered = new Set();
        for (const r of basis)
            for (const l of r.laws)
                covered.add(l);
        return {
            coveredLaws: ALL_LAWS.filter(l => covered.has(l)),
            missingLaws: ALL_LAWS.filter(l => !covered.has(l)),
            ruleCount: DOCTOR_RULES.length,
            configValid: configErrors.length === 0,
            configErrors,
        };
    }
    memory() {
        // 深拷贝快照：TS 的 readonly 是浅冻结 —— 真正的保护来自拷贝语义
        return JSON.parse(JSON.stringify(this.mem));
    }
    reportPath() { return this.reportFile; }
    persistMemory(warnings) {
        if (!this.cfg)
            return;
        try {
            atomicWrite(this.cfg.memoryPath, JSON.stringify(this.mem, null, 2));
        }
        catch (e) {
            warnings.push(`memory persist failed: ${e.message}`);
        }
    }
    resetMemory() {
        this.mem = { lessons: [], lastReport: null, totalDiagnoses: 0, totalFixesApplied: 0 };
    }
    resetConfig() {
        this.cfg = null;
        this.reportFile = null;
    }
}
// 单例是正确的：一具躯体一套免疫系统；规则注册表是模块级静态资产
export const doctor = new Doctor();
/** 绑定插件的进坞入口（工具工厂调用 —— bindPluginConfig 的具名再导出无必要，直接用 doctor） */
export function bindPluginConfig(config) {
    doctor.bindPluginConfig(config);
}
/** 惰性装配（共享出诊前置）：进程内首次出诊/回执时按插件配置 configure（幂等 —— 已装配直通）。
 *  qualityCheckup 工具与 doctorChannel 判决回执通道共用 —— 单点装配，杜绝双处漂移。
 *  返回 null = 就绪；非 null = 装配失败原因（异常诚实：永不 throw）。 */
export async function ensureDoctorConfigured(config) {
    if (doctor.reportPath() !== null)
        return null;
    const memoryPath = isAbsolute(config.doctorMemoryPath)
        ? config.doctorMemoryPath
        : join(process.cwd(), config.doctorMemoryPath);
    const rules = config.doctorRules
        .split(',').map(s => s.trim()).filter(Boolean);
    try {
        await doctor.configure({
            // sourceRoot = src/（本文件居 src/ —— './' 即插件源码树）
            sourceRoot: resolve(dirname(fileURLToPath(import.meta.url)), './'),
            memoryPath,
            strict: config.doctorStrict,
            rules: rules.length > 0 ? rules : undefined,
        });
        // 进程内绑定插件配置（链审计规则消费 checkpointPath 等）
        doctor.bindPluginConfig(config);
        return null;
    }
    catch (e) {
        return e.message;
    }
}
// ─── CLI 通道（蓝图 §2 副通道：npm run doctor；pre-commit / CI 消费） ───
export async function runDoctorCli(argv = []) {
    const strict = argv.includes('--strict');
    try {
        await doctor.configure({
            sourceRoot: resolve(process.cwd(), 'src'),
            memoryPath: resolve(process.cwd(), 'doctor-memory.json'),
            strict,
        });
    }
    catch (e) {
        console.error(e.message);
        return 2;
    }
    const report = await doctor.diagnose();
    console.log(`[Doctor] score=${report.score} genesis=${report.genesisVerdict} ` +
        `findings=${report.findings.length} files=${report.scannedFiles} ` +
        `(critical/major/minor/info = ${['critical', 'major', 'minor', 'info']
            .map(s => report.findings.filter(f => f.severity === s).length).join('/')})`);
    for (const f of report.findings.slice(0, 10)) {
        console.log(`  ${f.severity.padEnd(8)} ${f.ruleId} ${f.location.file}:${f.location.line}`);
    }
    if (report.warnings.length)
        console.log(`[Doctor] warnings: ${report.warnings.join('; ')}`);
    console.log(`[Doctor] full report: ${doctor.reportPath()}`);
    return strict && report.genesisVerdict === 'violated' ? 1 : 0;
}
