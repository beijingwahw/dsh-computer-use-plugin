export * from './sleepTypes.js';
// W8（D-B4 梦回放失败源接线）：组合根供源工装的桶再导出（dreamFeed 零运行期
// 依赖 —— type-only 相对导入，装载器零耦合；导入面收口在桶，宿主单点可达）
export { createDreamDeps } from './dreamFeed.js';
import { actAudit, actDistill, actImmune, actReplay, appendLine, computeWatermark, deferredDreamSidecar, errText, readTail, safeNow, sanitizeQueueSummary, snapshotUsage, } from './sleepActs.js';
import { actCalibrate } from './calibrationAct.js';
/** 缺省睡眠预算：2s（与 src/index.ts 卸载路径的保险丝同值 —— 宁短勿挂） */
export const DEFAULT_SLEEP_BUDGET_MS = 2000;
// ─── ΠΑΝ-113（单幕预算上限）：防一幕吃光全部预算 ───
//
// 病灶：旧执法只在**幕间**检查 overBudget —— 单幕一旦跑长（重 journal 的
// findDecisionPoints、大库归纳、consolidate），一幕可以把 2s 全预算吃光，
// 后续五幕全部 'timeout' 饿死（六幕剧变独幕剧）。修法：
//   · 单幕上限 = min(总预算, max(200ms, 总预算×35%))（SLEEP_ACT_MAX_SHARE
//     —— 最重的幕也最多吃约三分之一，五幕的最低生存空间立法保住）；
//   · 同步幕无法中途打断（诚实边界，绝不假装能打断）：执法面为事后记账 ——
//     elapsedMs/overActCap 进幕报告，超限幕的 detail 注记病灶（可见性），
//     且后续幕照常吃 overBudget 的既有总闸；
//   · 唯一的真异步消化面（迟到梦幕）按同一 actCap **硬闸**：条间实读超限
//     即收兵（runDreamReplay 的 overBudget 条间执法面），remainingMs 读数
//     取「总预算剩余」与「单幕上限剩余」的紧者 —— R40 自适应选梦自然感知。
/** ΠΑΝ-113：单幕预算占比上限（0.35 = 一幕最多吃总预算的 35%） */
export const SLEEP_ACT_MAX_SHARE = 0.35;
/** ΠΑΝ-113：单幕上限地板（超小预算下的最低工作空间，ms） */
export const SLEEP_ACT_CAP_FLOOR_MS = 200;
/**
 * 六幕名（固定演出次序：回放→蒸馏→免疫→校准→审计→晨报）。
 * ΝΩ-34（梦回放移序立法）：梦回放不寄居第①幕 —— 在 audit 之后 report 之前
 * 迟到演出（维护四幕 distill/immune/calibrate/audit 先吃预算：2s 预算下最贵
 * 的梦若先行吃满，校准/审计恒 timeout 饿死）。梦不占幕名：六幕形状、幕序与
 * 逐幕超时执法逐字节保持；梦的 counts/detail 账面仍归属第①幕条目（既有晨报
 * 消费面零漂移）。
 */
const SIX_ACTS = ['replay', 'distill', 'immune', 'calibrate', 'audit', 'report'];
/** 模块级内存水位线（路径空 = 唯一水位线；路径非空时与 trace 尾行互补） */
let inMemoryWatermark = null;
/** W5-2：梦回放独立水位线（内存面 —— 失败集身份指纹；trace 尾行互补跨进程） */
let inMemoryDreamWatermark = null;
/** 测试缝：清零内存水位线（模拟新进程 —— 只清水位线账，不动磁盘 trace） */
export function resetSleepCycle() {
    inMemoryWatermark = null;
    inMemoryDreamWatermark = null;
}
// ─── 主编排：runSleepCycle（永不抛铁律） ───
/**
 * 认知睡眠周期（纪元 Υ）：六幕离线整合 + 幂等水位线 + 晨报落盘。
 *
 * 返回 SleepReport，绝不 reject、绝不 throw —— 任何内部故障（含本编排器自身
 * 的意外 bug）都收敛为诚实报告条目。deps/config 全部可选：空 deps 睡出一份
 * 全 skipped 的晨报（睡眠本身永远完成，哪怕无事可做）。
 */
export async function runSleepCycle(deps = {}, config = {}) {
    const now = typeof config.now === 'function' ? config.now : () => Date.now();
    const rawBudget = config.budgetMs;
    const budgetMs = typeof rawBudget === 'number' && Number.isFinite(rawBudget) && rawBudget >= 0
        ? rawBudget : DEFAULT_SLEEP_BUDGET_MS;
    const log = typeof deps.log === 'function' ? deps.log : ((m) => { console.log(m); });
    const startedAt = safeNow(now);
    // ΠΑΝ-29（睡眠/dispose 竞速）：卸载中止信号 —— 组合根的同步 disposer 在
    // runSleepCycle 首个 await 挂起后继续跑完全部 reset；微任务恢复时本编排器
    // 读到的 deps 已是被清空的空账。信号已中止 ⇒ 后续幕不再消费依赖、梦幕跳过、
    // 晨报不携带水位线、内存水位线不前滚（本睡未完成，不得记账为已消化）。
    const disposeSignal = config.disposeSignal;
    const abortSignalled = () => disposeSignal?.aborted === true;
    let interrupted = false; // 任一幕被 dispose 信号掐断即置位（水位线执法的旗）
    try {
        const tracePath = typeof config.sleepTracePath === 'string' ? config.sleepTracePath : '';
        const tail = readTail(tracePath);
        const persisted = inMemoryWatermark ?? tail.watermark; // 内存优先，trace 尾行补跨进程
        const current = computeWatermark(deps.journal);
        // 幂等水位线：同一状态二睡 ⇒ 六幕全 noop（零依赖调用、零落盘 —— 零新增严格义）
        if (current !== null && current === persisted) {
            log('[Sleep] 水位线未前移 —— 本轮睡眠零新增（六幕 noop）。');
            return {
                startedAt,
                durationMs: Math.max(0, safeNow(now) - startedAt),
                watermark: current,
                timeout: false,
                acts: SIX_ACTS.map(name => ({ name, status: 'noop', counts: {} })),
            };
        }
        const acts = [];
        // W3-2 第二批接线②的旁车：校准幕收敛摘要带给晨报顶层（approvalQueue 同律）；
        // W5-2 的旁车：梦回放摘要（ΝΩ-34 后由迟到梦幕产出）同律带给晨报顶层
        const sidecars = {};
        const overBudget = () => safeNow(now) - startedAt > budgetMs;
        // ΑΩ-R40：剩余预算读数面（毫秒）—— 经 overBudget 闭包属性随既有 cfg 通道流转
        // 到梦机房（sleepActs 零改线），供条间预算感知选梦（短梦优先/诚实收场）；
        // 不携带该属性的旧直投调用方，梦侧自动回落既有布尔执法（零漂移）
        overBudget.remainingMs =
            () => budgetMs - (safeNow(now) - startedAt);
        // ΠΑΝ-113：单幕预算上限（一幕最多吃约总预算的 35% + 200ms 地板；
        // 同步幕事后注记、梦幕硬闸 —— 立法见文件头 SLEEP_ACT_MAX_SHARE 段）
        const actCapMs = Math.min(budgetMs, Math.max(SLEEP_ACT_CAP_FLOOR_MS, Math.floor(budgetMs * SLEEP_ACT_MAX_SHARE)));
        // W5-2：幕体可为异步（梦回放的 sharp 面）—— 逐幕顺序 await（幕序不变、
        // 半程检查不变）；全同步 deps 下 await 只是微任务直落，「触发即完成主体」
        // 的同步性不变量对既有路径逐字节保持（梦是唯一申报的异步消化面）。
        // ΠΑΝ-29：dispose 信号中止与预算耗尽同律掐幕（宁短勿挂的卸载版）；唯一
        // 豁免 = 晨报幕（evenIfAborted —— 中断也要落半程晨报，只是不记 ok、不带
        // 水位线）。被信号掐断的幕零依赖调用（消费已复位的空账 = 把「已复位」误当
        // 「无事可做」—— 空蒸馏/空免疫都是伪消化）。
        const step = async (name, fn, evenIfAborted = false) => {
            // ΠΑΝ-29：dispose 信号闸可被 evenIfAborted 豁免（晨报幕 —— 中断也要落
            // 半程晨报）；预算闸对一切幕保持零漂移执法（既有「预算耗尽 ⇒ 逐幕
            // timeout 含晨报」的测试锁定语义不动）。
            if (!evenIfAborted && abortSignalled()) {
                interrupted = true; // ΠΑΝ-29：中断旗 —— 水位线与晨报执法面
                acts.push({
                    name, status: 'timeout', counts: {},
                    detail: '睡眠被卸载信号打断（宁短勿挂；本幕未消费任何依赖，水位线不前滚）',
                });
                return;
            }
            if (overBudget()) { // 宁短勿挂：预算耗尽的幕不再演，标记后继续铸半程报告
                acts.push({ name, status: 'timeout', counts: {}, detail: `睡眠预算 ${budgetMs}ms 耗尽 —— 半程报告（宁短勿挂）` });
                return;
            }
            try {
                // ΠΑΝ-113：单幕计时（事后记账面 —— 同步幕无法中途打断，超限可见）
                const actT0 = safeNow(now);
                const rep = await fn();
                const elapsedMs = Math.max(0, safeNow(now) - actT0);
                const overCap = elapsedMs > actCapMs;
                if (overCap) {
                    const note = `单幕预算超限（${elapsedMs}ms > 上限 ${actCapMs}ms）—— 本幕挤占了后续幕的预算（ΠΑΝ-113 注记）`;
                    rep.detail = rep.detail ? `${rep.detail}；${note}` : note;
                }
                acts.push({ ...rep, elapsedMs, ...(overCap ? { overActCap: true } : {}) });
            }
            catch (e) {
                acts.push({ name, status: 'error', counts: {}, detail: errText(e) });
            }
        };
        // W5-2：梦回放独立水位线（内存优先，trace 尾行补跨进程）—— 防重复回放的锚
        //（ΝΩ-34：锚 = 失败集身份×策略指纹 —— 策略显著进化允许重梦，同策略仍去重）
        const priorDreamWatermark = inMemoryDreamWatermark ?? tail.dreamWatermark;
        await step('replay', () => actReplay(deps));
        await step('distill', () => actDistill(deps));
        await step('immune', () => actImmune(deps));
        await step('calibrate', () => actCalibrate(deps, sidecars));
        await step('audit', () => actAudit(deps));
        // ΝΩ-34（梦回放移序立法）：迟到梦幕 —— audit 之后 report 之前演出。维护四幕
        // 先吃预算（校准/审计不再被最贵的梦饿死）；梦在剩余预算内工作（R40 自适应
        // 选梦的条间执法照常）。不占幕名/不进 step 的超时执法（梦自身按条诚实饿死，
        // 绝不炸睡眠）；counts/detail 并回第①幕条目 —— 既有晨报消费面零漂移。
        // ΠΑΝ-29：卸载信号已中止 ⇒ 梦幕一并跳过（梦是异步消化面 + 双写进化账，
        // dispose 后重放只会在已复位的世界上产出伪教训）—— 诚实注记并回回放幕。
        if (abortSignalled()) {
            const replayAct = acts.find(a => a.name === 'replay');
            if (replayAct && replayAct.status !== 'timeout') {
                const note = '梦回放随卸载信号一并打断';
                replayAct.detail = replayAct.detail ? `${replayAct.detail}；${note}` : note;
            }
        }
        else {
            // ΠΑΝ-113：迟到梦幕的单幕硬闸 —— 梦是唯一真异步消化面，按 actCap 条间
            // 实读收兵（总闸 overBudget OR 单幕闸超时）；remainingMs 读数取
            // 「总预算剩余」与「单幕上限剩余」的紧者（R40 自适应选梦自然感知双闸）。
            const dreamT0 = safeNow(now);
            const dreamRemaining = () => Math.max(0, Math.min(budgetMs - (safeNow(now) - startedAt), actCapMs - (safeNow(now) - dreamT0)));
            const dreamOver = Object.assign(() => overBudget() || (safeNow(now) - dreamT0) > actCapMs, { remainingMs: dreamRemaining });
            await deferredDreamSidecar(deps, { now, overBudget: dreamOver, priorDreamWatermark }, sidecars, acts.find(a => a.name === 'replay'));
        }
        // ⑥ 晨报幕：用量快照 + W2-1 待批清单 + JSONL 落盘 + 水位线前滚。
        // ΠΑΝ-29：evenIfAborted —— 中断的睡眠也要铸半程晨报（诚实标注被打断，
        // 绝不记 ok），但**不消费任何依赖**（meter/队列此刻读的是已复位状态，
        // 读出来的是垃圾不是台账）、**不携带水位线**（readTail 跳过无水印行 ⇒
        // 下次同状态实睡 —— 宁可重复归纳，不可漏睡）。
        let usage;
        let approvalQueueSummary;
        await step('report', () => {
            const wasInterrupted = abortSignalled();
            if (wasInterrupted) {
                interrupted = true;
                const note = '睡眠被卸载信号打断 —— 半程晨报（未完成消化；水位线未前滚）';
                if (!tracePath)
                    return { name: 'report', status: 'timeout', counts: {}, detail: note };
                // 中断行：watermark 刻意缺席（JSON.stringify 丢弃 undefined —— readTail
                // 视其为「无持久化水位线的行」继续向首找上一条诚实行，本行不毒化幂等账）
                const partial = { name: 'report', status: 'timeout', counts: {}, detail: note };
                const line = JSON.stringify({
                    type: 'sleep',
                    startedAt,
                    watermark: undefined,
                    interrupted: true,
                    timeout: true,
                    acts: [...acts, partial],
                });
                try {
                    appendLine(tracePath, line, tail.needsNewline);
                }
                catch (e) {
                    return { name: 'report', status: 'error', counts: {}, detail: `中断晨报落盘失败：${errText(e)}` };
                }
                return partial;
            }
            usage = snapshotUsage(deps.meter);
            const counts = {};
            const notes = [];
            // W2-1（H4）：待批队列清单 —— 晨报的核心新增消费面。旁路律：dep 缺席 ⇒
            // 清单缺席（诚实，不伪造空清单）；摘要故障 ⇒ 注记吸收，绝不炸晨报落盘。
            const q = deps.approvalQueue;
            if (q && typeof q.pendingSummary === 'function') {
                try {
                    const summary = sanitizeQueueSummary(q.pendingSummary());
                    if (summary !== undefined) {
                        approvalQueueSummary = summary;
                        counts.queuePending = summary.pending;
                        counts.queueExpired = summary.expired;
                        counts.queueGrantedAwaiting = summary.grantedAwaitingResume;
                        notes.push(`待批队列：${summary.pending} 项待批（另 ${summary.expired} 项已过期须重走完整审批）、` +
                            `${summary.grantedAwaitingResume} 项已批待续跑 —— 批注式批量裁决见 adjudicate_approval_queue`);
                    }
                }
                catch (e) {
                    notes.push(`待批队列摘要故障（旁路吸收）：${errText(e)}`);
                }
            }
            if (!tracePath) {
                return {
                    name: 'report', status: 'ok', counts,
                    detail: ['sleepTracePath 空 —— 仅内存水位线', ...notes].join('；') || undefined,
                };
            }
            // 行内六幕齐全：晨报幕以乐观条目入行（appendFileSync 失败 ⇒ 行未写成，
            // 返回报告由 step 的 catch 纠正为 error；半写断行由读方容忍）
            const optimistic = {
                name: 'report', status: 'ok',
                counts: { ...counts, appended: 1 },
                ...(notes.length > 0 ? { detail: notes.join('；') } : {}),
            };
            const line = JSON.stringify({
                type: 'sleep',
                startedAt,
                watermark: current,
                timeout: acts.some(a => a.status === 'timeout'),
                acts: [...acts, optimistic],
                ...(usage ? { usage } : {}),
                ...(approvalQueueSummary !== undefined ? { approvalQueue: approvalQueueSummary } : {}),
                // W3-2 第二批接线②：收敛摘要随晨报行落盘（重放的钥匙 seed 在场）
                ...(sidecars.memoryOps !== undefined ? { memoryOps: sidecars.memoryOps } : {}),
                // W5-2：梦回放摘要随晨报行落盘（dream.watermark 是跨进程梦水位线的锚）
                ...(sidecars.dream !== undefined ? { dream: sidecars.dream } : {}),
            });
            try {
                appendLine(tracePath, line, tail.needsNewline);
            }
            catch (e) {
                throw new Error(`晨报落盘失败：${errText(e)}`);
            }
            return optimistic;
        }, true /* ΠΑΝ-29：中断也落半程晨报（预算耗尽路径的既有语义不变） */);
        // 水位线前滚（内存面无条件；磁盘面已随行 —— append 失败时下次进程重睡，
        // 宁可重复归纳（签名去重只强化可靠度）不可漏睡）
        // ΠΑΝ-29 修正案：被 dispose 信号打断的睡眠**不前滚** —— 幕②起零消化，
        // 记账即漏睡（下次同状态 noop ⇒ 蒸馏/免疫永久丢失）。保持既有值不动
        //（不回滚 —— 上一条诚实水位线仍有效），磁盘面已由中断行刻意不带水印
        // 双保险。
        if (!interrupted)
            inMemoryWatermark = current;
        // W5-2：梦回放独立水位线前滚（只在梦摘要真实在场时 —— noop/缺席/故障不动账；
        // 磁盘面随晨报行 —— 下次进程经 readTail 恢复；ΝΩ-34 后锚含策略指纹：同一
        // 失败集×同一策略不再重复回放，策略显著进化则允许重梦）。ΠΑΝ-29：中断睡
        // 的梦幕被跳过 ⇒ sidecars.dream 恒缺席 ⇒ 此处自然不动账（无需另闸）。
        if (sidecars.dream !== undefined && sidecars.dream.watermark) {
            inMemoryDreamWatermark = sidecars.dream.watermark;
        }
        const durationMs = Math.max(0, safeNow(now) - startedAt);
        const timedOut = acts.some(a => a.status === 'timeout');
        log(`[Sleep] 晨报（${durationMs}ms）：${acts.map(a => `${a.name}=${a.status}`).join(' ')}`);
        return {
            startedAt, durationMs,
            watermark: interrupted ? null : current, // ΠΑΝ-29：中断睡不申报指纹（未完成 ≠ 已消化）
            timeout: timedOut, acts,
            ...(usage ? { usage } : {}),
            ...(approvalQueueSummary !== undefined ? { approvalQueue: approvalQueueSummary } : {}),
            ...(sidecars.memoryOps !== undefined ? { memoryOps: sidecars.memoryOps } : {}),
            ...(sidecars.dream !== undefined ? { dream: sidecars.dream } : {}),
        };
    }
    catch (e) {
        // 永不抛铁律的最后一道闸：编排器自身的意外故障也收敛为诚实报告
        log(`[Sleep] 睡眠周期意外故障（已吞，绝不炸宿主）：${errText(e)}`);
        return {
            startedAt,
            durationMs: Math.max(0, safeNow(now) - startedAt),
            watermark: null,
            timeout: false,
            acts: [{ name: 'sleep', status: 'error', counts: {}, detail: errText(e) }],
        };
    }
}
