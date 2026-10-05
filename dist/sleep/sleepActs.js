// src/sleep/sleepActs.ts
// W6-1（doctor 债清偿·smell.over-engineering）：从 sleep/index.ts 提取的六幕执法区 ——
// 纯工具（errText/safeNow/numOr0）、水位线（computeWatermark/readTail/appendLine）、
// ①回放②蒸馏③免疫⑤审计幕与晨报幕的用量/待批清单净化。
// 逐字节搬运（零逻辑变更；仅供本包内消费的函数加 export 供编排器与校准幕复用，
// 包外公共面不变）。index.ts 保留编排（runSleepCycle）。
// ΝΩ-34（梦回放移序立法）：①回放幕回归轻本体（journal 冲账，梦迁出）；梦旁挂
// （dreamSidecar）改由 deferredDreamSidecar 在 audit 之后 report 之前的迟到梦幕
// 演出 —— 账面归属不变（梦 counts/detail 仍并回第①幕条目）。
import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
/** 异常归因为安全字符串（绝不二次抛出） */
export function errText(err) {
    if (err instanceof Error)
        return err.message;
    try {
        const text = String(err);
        return text === '' ? '未知异常' : text;
    }
    catch {
        return '未知异常';
    }
}
/** 时钟安全读数：注入时钟抛错/回垃圾 ⇒ 0（绝不因计时面炸睡眠） */
export function safeNow(clock) {
    try {
        const t = clock();
        return typeof t === 'number' && Number.isFinite(t) ? t : 0;
    }
    catch {
        return 0;
    }
}
/** 非负有限数净化（垃圾计数不进晨报） */
export function numOr0(x) {
    return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}
// ─── 水位线 ───
/**
 * journal 状态指纹：`${全量条数}:${尾条哈希前 16}`。
 * 条数与尾哈希双敏感 —— 任何 append（含 MARKER）都前移指纹；journal 缺席/
 * list 抛错 ⇒ null（无法指纹 = 无法去重，每睡皆实睡 —— 诚实方向）。
 */
export function computeWatermark(journal) {
    if (!journal || typeof journal.list !== 'function')
        return null;
    try {
        const entries = journal.list(false);
        if (!Array.isArray(entries))
            return null;
        if (entries.length === 0)
            return '0:empty';
        const last = entries[entries.length - 1];
        const tip = typeof last?.hash === 'string' && last.hash
            ? last.hash.slice(0, 16)
            : typeof last?.ts === 'number' && Number.isFinite(last.ts)
                ? `t${last.ts}`
                : 'no-tip';
        return `${entries.length}:${tip}`;
    }
    catch {
        return null;
    }
}
/**
 * 读 trace 尾行恢复持久化水位线（跨进程幂等）。
 * 断尾行容忍（pilotStore replay 同律）：自尾向首找最后一条可解析且携带
 * watermark 的行；半行/垃圾行跳过不炸；文件不存在（ENOENT）= 首睡。
 * W5-2：同一行若携带 dream.watermark（梦回放独立水位线）则一并恢复 ——
 * 主水位线与梦水位线同行同律（跨进程防重复回放）。
 */
export function readTail(filePath) {
    if (!filePath)
        return { watermark: null, dreamWatermark: null, needsNewline: false };
    let text;
    try {
        text = readFileSync(filePath, 'utf8');
    }
    catch {
        return { watermark: null, dreamWatermark: null, needsNewline: false }; // 读故障（含 ENOENT）⇒ 无持久化水位线
    }
    const needsNewline = !text.endsWith('\n');
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line)
            continue;
        try {
            const obj = JSON.parse(line);
            if (obj && typeof obj.watermark === 'string' && obj.watermark) {
                const dw = obj.dream && typeof obj.dream === 'object' && typeof obj.dream.watermark === 'string'
                    ? obj.dream.watermark
                    : null;
                return { watermark: obj.watermark, dreamWatermark: dw, needsNewline };
            }
        }
        catch {
            continue; // 断尾/垃圾行：继续向首找
        }
    }
    return { watermark: null, dreamWatermark: null, needsNewline };
}
/** JSONL 追加（目录一次保证 + 断尾治疗；失败上抛由幕的 catch 收敛为 error） */
export function appendLine(filePath, line, healNewline) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, (healNewline ? '\n' : '') + line + '\n', 'utf8');
}
// ─── 六幕执法（每幕独立 try/catch —— 单幕故障不毒化他幕） ───
/**
 * W5-2（M4 梦回放旁挂 → ΝΩ-34 移序）：梦面 —— 失败轨迹源 → dreamTrajectories
 * 净化 → runDreamReplay 编排（PER 排序 / 同构世界 / 冻结输入重放 / 分歧点双写 /
 * 反事实教训）。旁路律：梦 dep 缺席 ⇒ 零行为变化（不装载梦模块）；任何故障
 * ⇒ 注记吸收（绝不炸睡眠）。同步性不变量的 W5-2 修正案：梦是第一个异步消化面
 * （sharp 合成帧）—— 仅当梦 dep 在场才发生真实挂起，且逐梦实读睡眠预算
 * （overBudget 条间执法，宁短勿挂）；全部既有 deps 路径仍为纯同步（零漂移）。
 * ΝΩ-34：演出位从第①幕复合幕迁至 audit 之后 report 之前的迟到梦幕（本函数
 * 幕位无关 —— 由 deferredDreamSidecar 包装执法）。梦摘要经 out 旁车带给晨报
 * 顶层（approvalQueue 同律）。
 */
async function dreamSidecar(deps, cfg, out) {
    const dream = deps.dream;
    if (!dream || typeof dream.failures !== 'function')
        return; // dep 缺席 ⇒ 零行为变化
    const mod = await import('./dreamReplay.js'); // 懒装载：梦机房只在梦在场时进厂
    let trajectories;
    try {
        trajectories = mod.dreamTrajectories(dream.failures());
    }
    catch (e) {
        out.dream = {
            watermark: '', attempted: 0, replayed: 0, successes: 0, divergences: 0, lessons: [], lessonMeta: [], entries: [],
            budget: { maxDreams: 0, maxStepsPerDream: 0, truncated: false, reason: 'none' },
            kernelEvidence: [],
            note: `失败轨迹源故障（旁路吸收）：${errText(e)}`,
        };
        return;
    }
    const handle = await mod.runDreamReplay({
        trajectories,
        spectrum: dream.spectrum,
        now: cfg.now,
        overBudget: cfg.overBudget,
        evolution: dream.evolution,
        budget: dream.budget,
        priorWatermark: cfg.priorDreamWatermark,
    });
    out.dream = handle.report;
}
/**
 * ΝΩ-34（梦回放移序立法）：迟到梦幕 —— audit 之后 report 之前演出（编排器
 * 调用；不是第七幕，六幕形状/幕序/超时执法逐字节保持）。立法理由：梦回放是
 * 六幕里最贵的消化面（AutonomyGym + 合成帧），2s 预算下若寄居第①幕先行吃满，
 * 维护四幕（蒸馏/免疫/校准/审计）恒 timeout 饿死 —— 移序后维护四幕先吃预算，
 * 梦在剩余预算内工作（R40 自适应选梦照常条间执法）。账面归属不变：梦
 * counts/detail 并回第①幕条目（dreams/dreamAttempted/… 既有晨报消费面零漂移）；
 * 梦摘要照常经旁车带晨报顶层。绝不抛（旁挂故障只注记）；timeout 条目的 counts
 * 立法为恒空 —— 预算饿死的回放幕条目不并梦账（梦战况由晨报顶层 sidecars.dream
 * 汇报，两个诚实面分离）。
 */
export async function deferredDreamSidecar(deps, cfg, out, replayAct) {
    try {
        await dreamSidecar(deps, cfg, out);
    }
    catch (e) {
        if (replayAct && replayAct.status !== 'timeout') {
            const note = `梦回放旁挂故障（旁路吸收）：${errText(e)}`;
            replayAct.detail = replayAct.detail ? `${replayAct.detail}；${note}` : note;
        }
        return;
    }
    const d = out.dream;
    if (!d || !replayAct || replayAct.status === 'timeout')
        return;
    mergeDreamCounts(d, replayAct.counts);
    // ΠΑΝ-113：晨报文案与教训证据强度对齐 —— 「heuristic」标注进账面，消费方
    // （模型读晨报）不再把同构世界教训当硬规则
    const head = `梦回放：${d.replayed}/${d.attempted} 条重放（分歧 ${d.divergences}、成功 ${d.successes}、反事实教训 ${d.lessons.length} 条（heuristic —— 提示性参考，非硬规则））`;
    const tail = [];
    if (d.note)
        tail.push(d.note);
    if (!d.note && d.budget.truncated)
        tail.push(`预算截断（${d.budget.reason}）`);
    const note = tail.length > 0 ? `${head} —— ${tail.join('；')}` : head;
    replayAct.detail = replayAct.detail ? `${replayAct.detail}；${note}` : note;
}
/**
 * ① 回放幕（ΝΩ-34 后回归轻本体）：journal 冲账/结算 —— 哈希链 verify（B-1）+
 * 决策点分析（C-3）+ 可选验收冲账（D-7）。梦回放已迁至迟到梦幕
 * （deferredDreamSidecar，audit 之后 —— 见 index.ts 编排），账面仍并回本幕。
 */
export function actReplay(deps) {
    const j = deps.journal;
    if (!j || typeof j.list !== 'function' || typeof j.verify !== 'function') {
        // journal 缺席：回放幕本体 skipped —— 梦回放不依赖 journal（失败记忆是独立
        // 源），迟到梦幕照常演出（梦旁挂的诚实独立面）
        return { name: 'replay', status: 'skipped', counts: {}, detail: 'journal 缺席 —— 回放幕本体跳过' };
    }
    const counts = {};
    const notes = [];
    const chain = j.verify(); // B-1 现成面：存活窗口哈希链结算
    counts.entries = numOr0(chain?.length);
    counts.chainOk = chain?.ok === true ? 1 : 0;
    if (chain && chain.ok !== true)
        notes.push(`链断于第 ${String(chain.brokenAt)} 条`);
    if (typeof j.findDecisionPoints === 'function') { // C-3 现成面：反事实决策点回看
        const dps = j.findDecisionPoints();
        counts.decisionPoints = Array.isArray(dps) ? dps.length : 0;
    }
    const bridge = deps.verdictBridge;
    if (bridge && typeof bridge.settleAll === 'function') { // 可选：D-7 等待室终局冲账
        const settled = bridge.settleAll();
        counts.settled = Array.isArray(settled) ? settled.length : 0;
    }
    return { name: 'replay', status: 'ok', counts, detail: notes.join('；') || undefined };
}
/** W5-2：梦摘要 → 回放幕 counts 的投影（复合幕的量化面） */
function mergeDreamCounts(d, counts) {
    counts.dreams = d.replayed;
    counts.dreamAttempted = d.attempted;
    counts.dreamSuccesses = d.successes;
    counts.dreamDivergences = d.divergences;
    counts.dreamLessons = d.lessons.length;
}
/** ② 蒸馏幕：技能归纳（induceFromJournal 优先；缺席回退 mineMotifs 动机挖掘）
 * + W3-2 反统一模板蒸馏旁挂（distillTemplates 可选面 —— 纯增量，缺席零行为变化） */
export function actDistill(deps) {
    const lib = deps.skillLibrary;
    if (!lib) {
        return { name: 'distill', status: 'skipped', counts: {}, detail: 'skillLibrary 缺席 —— 蒸馏幕跳过' };
    }
    let report;
    if (typeof lib.induceFromJournal === 'function') {
        // 描述源：最近任务语境（journal.currentTask）；缺席/抛错退缺省描述
        let task = 'sleep:distill';
        try {
            const t = deps.journal?.currentTask?.();
            if (typeof t === 'string' && t.trim())
                task = t.slice(0, 120);
        }
        catch { /* 任务语境是旁路 —— 缺席退缺省 */ }
        const skill = lib.induceFromJournal(task);
        report = {
            name: 'distill', status: 'ok',
            counts: { skills: skill ? 1 : 0 },
            detail: skill ? `归纳技能（${task.slice(0, 40)}）` : '任务切片无可归纳轨迹 —— 零归纳',
        };
    }
    else if (typeof lib.mineMotifs === 'function') {
        const motifs = lib.mineMotifs();
        const arr = Array.isArray(motifs) ? motifs : [];
        report = { name: 'distill', status: 'ok', counts: { motifs: arr.length } };
    }
    else {
        return {
            name: 'distill', status: 'skipped', counts: {},
            detail: 'skillLibrary 无归纳面（induceFromJournal/mineMotifs 皆缺席）',
        };
    }
    // W3-2（M2）：反统一模板蒸馏旁挂 —— 主归纳先行（新技能当夜即入配对池），
    // 旁挂失败只注记不回滚主归纳产出（蒸馏是旁路仪式，绝不为一夜好觉失眠）。
    if (typeof lib.distillTemplates === 'function') {
        try {
            const res = lib.distillTemplates();
            const arr = Array.isArray(res) ? res : Array.isArray(res?.created)
                ? res.created : [];
            report = { ...report, counts: { ...report.counts, templates: arr.length } };
        }
        catch (e) {
            const note = `模板蒸馏故障（旁路吸收）：${errText(e)}`;
            report = {
                ...report,
                detail: report.detail ? `${report.detail}；${note}` : note,
            };
        }
    }
    return report;
}
/** ③ 免疫幕：知识库睡眠整合（海马体→皮层） */
export function actImmune(deps) {
    const kb = deps.knowledgeBase;
    if (!kb || typeof kb.consolidate !== 'function') {
        return { name: 'immune', status: 'skipped', counts: {}, detail: 'knowledgeBase 缺席 —— 免疫幕跳过' };
    }
    const r = kb.consolidate();
    if (!r || r.ok !== true) {
        const reason = r?.error && typeof r.error.reason === 'string' ? r.error.reason : '未知原因';
        return { name: 'immune', status: 'error', counts: {}, detail: `consolidate 拒绝：${reason}` };
    }
    const v = r.value;
    return {
        name: 'immune', status: 'ok',
        counts: {
            episodes: numOr0(v?.episodes),
            clusters: numOr0(v?.clusters),
            consolidated: numOr0(v?.consolidated),
            decayed: numOr0(v?.episodedDecayed),
        },
    };
}
/**
 * 结局分类投影（journal 方言 → StepOutcome 方言）：
 * FAILED ⇒ error；SUCCESS 且 effect_detected===false ⇒ no_effect；SUCCESS ⇒ progress；
 * 其余（UNKNOWN 等无证据结局）保守记 no_effect —— 睡眠审计不把未知诬告成 error。
 */
function outcomeOf(entry) {
    if (entry.status === 'FAILED')
        return 'error';
    if (entry.status === 'SUCCESS')
        return entry.effect_detected === false ? 'no_effect' : 'progress';
    return 'no_effect';
}
/**
 * journal 动作流 → 审计轨迹投影（Φ-10 纯函数面的喂食面）。
 * 诚实缺席原则：thought 缺席记空串（OPQ-1 黑箱判据如常生效 —— 不伪造思考）；
 * 日志无风险分层证据 ⇒ riskTier 按良性（睡眠审计不诬告鲁莽）；observe 场景
 * 锚点兼任 snapshotDhash（ABA 往返探测的代理信号 —— 同场景复现即环）。
 * journal 缺席/list 抛错 ⇒ 空轨迹（auditTrajectory 空轨迹免检语义接管）。
 */
function projectJournalToSteps(journal) {
    if (!journal || typeof journal.list !== 'function')
        return [];
    let entries;
    try {
        const list = journal.list(true); // 只取动作条 —— MARKER 不参与行为审计
        entries = Array.isArray(list) ? list : [];
    }
    catch {
        return [];
    }
    return entries.map((raw, i) => {
        const entry = (raw ?? {});
        const args = entry.args && typeof entry.args === 'object'
            ? entry.args : {};
        const label = typeof args.target_description === 'string' ? args.target_description : undefined;
        // 结构子集铸造：审计只读 kind/target.label/rationale/riskTier 四面（as 收窄）
        const action = {
            kind: (typeof entry.tool === 'string' ? entry.tool : 'unknown'),
            ...(label !== undefined ? { target: { label } } : {}),
            rationale: typeof entry.thought === 'string' ? entry.thought : '',
            expectedEffect: '',
            utility: 0,
            riskTier: 'benign',
        };
        return {
            stepIndex: i,
            action,
            outcome: outcomeOf(entry),
            snapshotDhash: typeof entry.observe === 'string' && entry.observe ? entry.observe : null,
            at: typeof entry.ts === 'number' && Number.isFinite(entry.ts) ? entry.ts : 0,
        };
    });
}
/** ⑤ 审计幕：轨迹回看（selfAudit 纯函数面）—— verdict 摘要进晨报 */
export function actAudit(deps) {
    const audit = deps.selfAudit;
    if (typeof audit !== 'function') {
        return { name: 'audit', status: 'skipped', counts: {}, detail: 'selfAudit 缺席 —— 审计幕跳过' };
    }
    const steps = projectJournalToSteps(deps.journal);
    const r = audit(steps);
    const findings = Array.isArray(r?.findings) ? r.findings : [];
    const counts = {
        steps: steps.length,
        findings: findings.length,
        critical: findings.filter(f => f?.severity === 'critical').length,
        warn: findings.filter(f => f?.severity === 'warn').length,
    };
    const verdict = r && typeof r.verdict === 'string' ? r.verdict : 'unknown';
    const score = r && typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : 0;
    return { name: 'audit', status: 'ok', counts, detail: `verdict=${verdict} score=${score}` };
}
/** 可用量台账快照（meter 缺席/故障 ⇒ undefined —— 台账是旁路中的旁路） */
export function snapshotUsage(meter) {
    if (!meter || typeof meter.summary !== 'function')
        return undefined;
    try {
        const s = meter.summary();
        if (!s)
            return undefined;
        return {
            calls: numOr0(s.calls),
            failures: numOr0(s.failures),
            promptTokens: numOr0(s.promptTokens),
            completionTokens: numOr0(s.completionTokens),
        };
    }
    catch {
        return undefined;
    }
}
/**
 * W2-1（H4）：待批队列摘要净化（防御式 —— 说谎的 dep 不毒化晨报）：
 * 数值走 numOr0、清单条目只保结构合法者（id/description 必须是字符串），
 * 可选证据字段逐个类型校验。dep 故障面（抛错/回垃圾）在调用方收敛为缺席。
 */
export function sanitizeQueueSummary(raw) {
    if (!raw || typeof raw !== 'object')
        return undefined;
    const r = raw;
    const rawItems = Array.isArray(r.items) ? r.items : [];
    const items = [];
    for (const ri of rawItems) {
        if (!ri || typeof ri !== 'object')
            continue;
        const it = ri;
        const id = typeof it.id === 'string' && it.id ? it.id : undefined;
        const description = typeof it.description === 'string' && it.description ? it.description.slice(0, 200) : undefined;
        if (id === undefined || description === undefined)
            continue;
        items.push({
            id,
            description,
            enqueuedAt: numOr0(it.enqueuedAt),
            expiresAt: numOr0(it.expiresAt),
            ttlExpired: it.ttlExpired === true,
            ...(typeof it.riskTier === 'string' && it.riskTier ? { riskTier: it.riskTier.slice(0, 32) } : {}),
            ...(typeof it.actionTool === 'string' && it.actionTool ? { actionTool: it.actionTool.slice(0, 64) } : {}),
            ...(typeof it.screenshotRef === 'string' && it.screenshotRef ? { screenshotRef: it.screenshotRef.slice(0, 200) } : {}),
            ...(typeof it.sceneFingerprint === 'string' && it.sceneFingerprint ? { sceneFingerprint: it.sceneFingerprint.slice(0, 100) } : {}),
        });
    }
    return {
        pending: numOr0(r.pending),
        expired: numOr0(r.expired),
        grantedAwaitingResume: numOr0(r.grantedAwaitingResume),
        deniedAwaitingPrune: numOr0(r.deniedAwaitingPrune),
        items,
    };
}
