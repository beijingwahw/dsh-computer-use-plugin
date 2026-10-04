export * from './sleepTypes.js';
// W8（D-B4 梦回放失败源接线）：组合根供源工装的桶再导出（dreamFeed 零运行期
// 依赖 —— type-only 相对导入，装载器零耦合；导入面收口在桶，宿主单点可达）
export { createDreamDeps } from './dreamFeed.js';
import { actAudit, actDistill, actImmune, actReplay, appendLine, computeWatermark, deferredDreamSidecar, errText, readTail, safeNow, sanitizeQueueSummary, snapshotUsage, } from './sleepActs.js';
import { actCalibrate } from './calibrationAct.js';
/** 缺省睡眠预算：2s（与 src/index.ts 卸载路径的保险丝同值 —— 宁短勿挂） */
export const DEFAULT_SLEEP_BUDGET_MS = 2000;
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
        // W5-2：幕体可为异步（梦回放的 sharp 面）—— 逐幕顺序 await（幕序不变、
        // 半程检查不变）；全同步 deps 下 await 只是微任务直落，「触发即完成主体」
        // 的同步性不变量对既有路径逐字节保持（梦是唯一申报的异步消化面）。
        const step = async (name, fn) => {
            if (overBudget()) { // 宁短勿挂：预算耗尽的幕不再演，标记后继续铸半程报告
                acts.push({ name, status: 'timeout', counts: {}, detail: `睡眠预算 ${budgetMs}ms 耗尽 —— 半程报告（宁短勿挂）` });
                return;
            }
            try {
                acts.push(await fn());
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
        await deferredDreamSidecar(deps, { now, overBudget, priorDreamWatermark }, sidecars, acts.find(a => a.name === 'replay'));
        // ⑥ 晨报幕：用量快照 + W2-1 待批清单 + JSONL 落盘 + 水位线前滚
        let usage;
        let approvalQueueSummary;
        await step('report', () => {
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
        });
        // 水位线前滚（内存面无条件；磁盘面已随行 —— append 失败时下次进程重睡，
        // 宁可重复归纳（签名去重只强化可靠度）不可漏睡）
        inMemoryWatermark = current;
        // W5-2：梦回放独立水位线前滚（只在梦摘要真实在场时 —— noop/缺席/故障不动账；
        // 磁盘面随晨报行 —— 下次进程经 readTail 恢复；ΝΩ-34 后锚含策略指纹：同一
        // 失败集×同一策略不再重复回放，策略显著进化则允许重梦）
        if (sidecars.dream !== undefined && sidecars.dream.watermark) {
            inMemoryDreamWatermark = sidecars.dream.watermark;
        }
        const durationMs = Math.max(0, safeNow(now) - startedAt);
        const timedOut = acts.some(a => a.status === 'timeout');
        log(`[Sleep] 晨报（${durationMs}ms）：${acts.map(a => `${a.name}=${a.status}`).join(' ')}`);
        return {
            startedAt, durationMs, watermark: current, timeout: timedOut, acts,
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
