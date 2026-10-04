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
import { DOCTOR_RULES, EMPTY_CATCH_FIX, EXEMPTABLE_RULE_ID, lines, OVER_ENGINEERING_EXEMPTIONS } from './doctorRules.js';
export * from './doctorTypes.js';
export { DOCTOR_RULES, EXEMPTABLE_RULE_ID, OVER_ENGINEERING_EXEMPTIONS } from './doctorRules.js';
// ─── 引擎内部工件 ───
const ALL_LAWS = [
    'io-serialization', 'token-discipline', 'architecture-void',
    'config-driven', 'zero-intrusion', 'honest-degradation',
];
const SEVERITY_PENALTY = { critical: 25, major: 10, minor: 4, info: 1 };
const SEVERITY_RANK = { critical: 0, major: 1, minor: 2, info: 3 };
// ─── W7-1 官方豁免执法（中央注册表的守门与降级） ───
/** 注册表的权威锚点：豁免条目指认的是本仓库源码树（与配置的 sourceRoot 解耦 ——
 *  测试夹具根不误伤；条目文件被拆走/改名而注册表未同步 ⇒ 此处如实暴露）。 */
const DOCTOR_SOURCE_ANCHOR = resolve(dirname(fileURLToPath(import.meta.url)), './');
/**
 * W7-1 防滥用执法：豁免注册表三要素齐全（file/reason/epoch 非空）、不重复登记、
 * 条目文件在权威源码树真实存在。任何违规 throw（configure 内调用 —— doctor
 * 启动即响亮失败，绝不带病出诊）。豁免只作用于 EXEMPTABLE_RULE_ID（info 级
 * smell 规则）—— critical/major 类规则不在豁免语法域内，由测试锁定。
 */
export function assertExemptionRegistryValid(entries, anchorDir = DOCTOR_SOURCE_ANCHOR) {
    const seen = new Set();
    for (const e of entries) {
        if (!e || typeof e.file !== 'string' || e.file.trim() === '') {
            throw new Error(`[QualityDoctor] W7-1 exemption entry missing file: ${JSON.stringify(e)}`);
        }
        if (typeof e.reason !== 'string' || e.reason.trim() === '') {
            throw new Error(`[QualityDoctor] W7-1 exemption for "${e.file}" missing reason — silent exemptions are forbidden`);
        }
        if (typeof e.epoch !== 'string' || e.epoch.trim() === '') {
            throw new Error(`[QualityDoctor] W7-1 exemption for "${e.file}" missing epoch — registration must be auditable`);
        }
        if (seen.has(e.file)) {
            throw new Error(`[QualityDoctor] W7-1 duplicate exemption entry for "${e.file}"`);
        }
        seen.add(e.file);
        if (!existsSync(join(anchorDir, e.file))) {
            throw new Error(`[QualityDoctor] W7-1 exemption for non-existent file: "${e.file}" — registry is stale (file split/renamed without amending the registry)`);
        }
    }
}
/**
 * W7-1 中央豁免降级：命中注册表的 over-engineering finding ⇒ registered-retention
 * （仍留在 findings 列表可见，evidence 前缀标注登记纪元与理由；不扣分、不进手术提案）。
 * 豁免是引擎层政策 —— 规则扫描保持纯函数；未登记文件照判（对不上号保留原判）。
 * 返回命中数（供 exemptions 统计行观测）。
 */
function applyOverEngineeringExemptions(findings) {
    const registry = new Map(OVER_ENGINEERING_EXEMPTIONS.map(e => [e.file, e]));
    let applied = 0;
    for (const f of findings) {
        if (f.ruleId !== EXEMPTABLE_RULE_ID)
            continue;
        const entry = registry.get(f.location.file);
        if (!entry)
            continue;
        f.exempted = { reason: entry.reason, epoch: entry.epoch };
        f.evidence = `[registered-retention:${entry.epoch}] ${f.evidence} — retention: ${entry.reason}`;
        f.recommendation = 'Officially retained via the central exemption registry (doctorRules.ts) — any split proposal must amend the registry entry first.';
        applied++;
    }
    return applied;
}
// ─── 医生实现 ───
function atomicWrite(filePath, data) {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, data, 'utf8');
    renameSync(tmp, filePath);
}
/** 缓存容量上限（插入序 FIFO 驱逐 —— 容量护栏，非 LRU：可预测、零簿记） */
const SOURCE_CACHE_MAX = 4096;
const sourceContentCache = new Map();
const sourceCacheStats = { hits: 0, misses: 0, evictions: 0 };
/** 带缓存的源码读取：键未变 ⇒ 零重读（读故障上抛由调用方 catch —— 不缓存失败） */
function readSourceCached(full, st) {
    const hit = sourceContentCache.get(full);
    if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        sourceCacheStats.hits++;
        return hit.content;
    }
    sourceCacheStats.misses++;
    const content = readFileSync(full, 'utf8');
    if (sourceContentCache.size >= SOURCE_CACHE_MAX) {
        const oldest = sourceContentCache.keys().next().value;
        if (oldest !== undefined) {
            sourceContentCache.delete(oldest);
            sourceCacheStats.evictions++;
        }
    }
    sourceContentCache.set(full, { mtimeMs: st.mtimeMs, size: st.size, content });
    return content;
}
/** ΝΩ-22（测试/观测面）：源码缓存簿记 —— misses = 实际 readFileSync 次数 */
export function doctorSourceCacheStats() {
    return { entries: sourceContentCache.size, ...sourceCacheStats };
}
/** ΝΩ-22（测试面）：缓存整体失效 */
export function resetDoctorSourceCache() {
    sourceContentCache.clear();
    sourceCacheStats.hits = 0;
    sourceCacheStats.misses = 0;
    sourceCacheStats.evictions = 0;
}
function emptyReport(warnings) {
    return {
        timestamp: Date.now(), incremental: false, score: 100, genesisVerdict: 'intact',
        findings: [], byCategory: { genesis: 0, smell: 0, security: 0, chain: 0 },
        effectiveWeights: {}, trend: null, warnings, scannedFiles: 0, chainAudited: false,
        exemptions: { registered: OVER_ENGINEERING_EXEMPTIONS.length, applied: 0 },
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
        // W7-1 fail-fast：中央豁免注册表带病（缺要素/重复/幽灵文件）⇒ 装配即 throw，
        // doctor 启动即报错 —— 豁免机制自身先受审，绝不静默放行。
        try {
            assertExemptionRegistryValid(OVER_ENGINEERING_EXEMPTIONS);
        }
        catch (e) {
            errors.push(e.message);
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
                    // ΝΩ-22：mtime 缓存读取 —— 未变文件零重读；读故障上抛由 catch 吞为
                    // 空内容（旧行为），且不缓存失败（下次出诊重试真实读取）
                    try {
                        out.push({ path: rel, content: readSourceCached(full, st) });
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
            // W7-1：规则扫描后、计分前 —— 中央豁免降级（registered-retention；
            // 未登记文件照判，对不上号保留原判）
            const exemptionsApplied = applyOverEngineeringExemptions(findings);
            const byCategory = { genesis: 0, smell: 0, security: 0, chain: 0 };
            let penalty = 0;
            for (const f of findings) {
                const cat = ruleById.get(f.ruleId)?.category ?? 'smell';
                byCategory[cat]++;
                // W7-1：registered-retention 可见但不扣分（byCategory 仍计数 —— 报告诚实
                // 呈现 finding 总貌，扣分豁免由 exemptions 统计行单独说明）。
                if (f.exempted)
                    continue;
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
                exemptions: { registered: OVER_ENGINEERING_EXEMPTIONS.length, applied: exemptionsApplied },
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
            if (f.exempted)
                continue; // W7-1：registered-retention 是官方保留 —— 不产手术提案（拆分提案须先修注册表）
            const src = f.location.snippet;
            if (f.riskLevel === 'mechanical') {
                // 机械修复：空 catch 补注释（唯一确定安全的文本手术）。
                // J 纪元修正：多行空 catch 的 snippet 是 open 行（`} catch (e) {`）——
                // 旧 replace 锚定 `{...}$` 永不命中，after===before 却照样走写盘路径并
                // 计入 totalFixesApplied（无效手术被统计为成功）。现在分两形态：
                //   单行 `catch {}` ⇒ 填充 `{ /* FIXME */ }`（原逻辑，括号配平不变）；
                //   多行 open 行   ⇒ 行尾追加注释（不添括号 —— 原块的闭合 `}` 仍在，
                //                      添括号会造成语法错误）。
                let commented = src;
                if (/catch/.test(src)) {
                    commented = /\{\s*\}\s*$/.test(src)
                        ? src.replace(/\{\s*\}\s*$/, `{ /* ${EMPTY_CATCH_FIX} */ }`)
                        : src.replace(/\{\s*$/, `{ /* ${EMPTY_CATCH_FIX} */`);
                }
                if (commented === src)
                    continue; // 无补丁可做 ⇒ 不产 proposal（诚实）
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
            // 真实写盘路径：lineRange 过期保护 —— before 在范围内恰有一次匹配。
            // snippet 是 trim 过的（doctorRules 存储时截断），而源码行带缩进 ——
            // 匹配与替换都必须保留行的原始缩进，否则缩进过的行永远 0 命中
            try {
                const full = resolve(this.cfg.sourceRoot, p.patch.file);
                const ls = lines(readFileSync(full, 'utf8'));
                const { start, end } = p.patch.lineRange;
                const hits = [];
                for (let i = Math.max(0, start - 1); i < Math.min(ls.length, end); i++) {
                    if (ls[i].trim() === p.patch.before.trim())
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
                const target = ls[hits[0]];
                const indent = target.slice(0, target.length - target.trimStart().length);
                ls[hits[0]] = indent + p.patch.after.trim();
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
/** W7-1：CLI 摘要铸造（纯函数 —— 供 runDoctorCli 与回归测试共用，统计行可断言） */
export function formatDoctorSummary(report) {
    const sev = ['critical', 'major', 'minor', 'info']
        .map(s => report.findings.filter(f => f.severity === s).length).join('/');
    const head = `[Doctor] score=${report.score} genesis=${report.genesisVerdict} ` +
        `findings=${report.findings.length} files=${report.scannedFiles} (critical/major/minor/info = ${sev})`;
    const ex = report.exemptions;
    if (!ex)
        return head; // 老报告形状：无豁免统计，不伪造
    return `${head}\n[Doctor] exemptions: ${ex.applied}/${ex.registered} over-engineering structural retentions ` +
        `(registered-retention: visible, unpenalized; genesis/security/chain rules are never exempted)`;
}
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
    console.log(formatDoctorSummary(report));
    for (const f of report.findings.slice(0, 10)) {
        console.log(`  ${f.severity.padEnd(8)} ${f.ruleId} ${f.location.file}:${f.location.line}`);
    }
    if (report.warnings.length)
        console.log(`[Doctor] warnings: ${report.warnings.join('; ')}`);
    console.log(`[Doctor] full report: ${doctor.reportPath()}`);
    return strict && report.genesisVerdict === 'violated' ? 1 : 0;
}
