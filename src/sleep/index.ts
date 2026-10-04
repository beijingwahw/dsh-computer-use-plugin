// src/sleep/index.ts
// 纪元 Υ（认知睡眠周期）：会话终了的离线整合编排器 —— 六幕剧 + 幂等水位线。
//
// 六幕（每一幕都消费现成器官，绝不造新轮子）：
//   ① 回放幕 replay    —— journal 冲账/结算：哈希链 verify（B-1 存活窗校验）+
//                         决策点分析（C-3 findDecisionPoints 反事实回看）；可选
//                         verdictBridge.settleAll（D-7 验收等待室的终局冲账）。
//                         W5-2（M4）升级为「回放 + 梦回放」复合幕：高优先失败
//                         轨迹（PER：惊异×代价×新近衰减）在 PCG 同构世界冻结
//                         输入重放，当前策略重决策与历史逐步 diff，分歧点之后
//                         双写（实验室 kernel 账本 + 进化引擎 EXP4 ingest 带
//                         bandit 标注）；重放成功而历史失败 ⇒ 反事实教训入晨报。
//                         梦有独立水位线（失败集身份指纹 —— 防重复回放）；梦
//                         dep 缺席 ⇒ 复合幕退化为既有回放幕（零漂移）。
//   ② 蒸馏幕 distill   —— skillLibrary 归纳：induceFromJournal 在场则归纳任务
//                         切片，否则 mineMotifs（F-1 文法动机挖掘）。W3-2（M2）
//                         旁挂反统一模板蒸馏：distillTemplates 可选面在场则
//                         把同骨架技能对 DTW 对齐反统一为带洞模板（纯增量）。
//   ③ 免疫幕 immune    —— knowledgeBase.consolidate()（海马体→皮层睡眠整合）。
//   ④ 校准幕 calibrate —— 内核校准 tick：conductor.maybeTick 优先（节流口径，
//                         与生产用户消息钩子同一执法面 —— enabled=false 恒空是
//                         诚实空转，睡眠不偷开进化总开关），否则 calibrator.tick。
//                         纪元 Ζ 旁挂「标定建议书」：把 calibration.ts 的标定原子
//                         接上睡眠时才有的离线数据（journal 坐标漂移对、telemetry
//                         延迟尾统计）—— 只建议不落值（立法：「睡眠出建议、白天
//                         做决定」，值仍归 kernelRegistry/消费方所有）；样本不足
//                         ⇒ 建议书诚实缺席（缺席注记在案，绝不伪造标定）。
//                         W3-2 第二批接线②旁挂「记忆操作收敛」：memoryOpsConverger
//                         可选面（W2-6 convergeMemoryOps 的注入缝）调用并并入晨报
//                         ——「睡眠出收敛、白天做决定」的落值版；缺席零行为变化。
//   ⑤ 审计幕 audit     —— selfAudit.auditTrajectory 纯函数面：journal 动作流
//                         投影为 StepRecord 后回看（震荡/浪费/黑箱判决摘要）。
//   ⑥ 晨报幕 report    —— SleepReport 铸造：config.sleepTracePath 非空时 JSONL
//                         追加落盘（行级 append，pilotStore 同律：断尾行容忍）。
//                         W2-1（H4）：经注入的 approvalQueue 面附待批清单 ——
//                         离线暂存队列的人回来接口（批注式批量裁决的消费面）。
//
// 设计律（项目宪章的睡眠版）：
//   · 永不抛异常 —— 睡眠是旁路仪式：任何一幕的任何故障（依赖抛错/落盘失败/
//     时钟畸形）都收敛为报告里的 status:'error'/'skipped'/'timeout' 条目，
//     绝不炸宿主、绝不阻塞卸载；
//   · 全依赖注入 —— journal/skillLibrary/knowledgeBase/conductor/calibrator/
//     verdictBridge/selfAudit/meter 全部经 SleepDeps 注入，缺哪个就诚实跳过
//     （status:'skipped'）；本模块零单例持有、零网络、零真钟（now 可注入）、
//     相对导入全部 type-only（装载器零耦合）—— 唯一豁免见下方纪元 Ζ 注记：
//   · 幂等水位线 —— 「已消化到哪」以 journal 状态指纹（条数:尾哈希）记账：
//     同一状态睡两次，第二次六幕全 noop（零依赖调用、零落盘 ——「零新增」取
//     严格义）；水位线随 sleepTracePath 持久化（trace 尾行携带 watermark），
//     路径空 = 仅内存水位线（跨进程幂等失效 —— 诚实降级）；
//   · 宁短勿挂 —— 逐幕预算检查（budgetMs，缺省 2000ms）：预算耗尽后未演的
//     幕标 'timeout'，半程晨报照铸（卸载路径绝不为一夜好觉等一秒）。
//
// 落盘律（pilotStore 同款）：JSONL 追加式；读方容忍断尾行（截断的半行跳过，
//   不炸）；写方在追加前探测尾换行 —— 断尾后追加先补 '\n' 治疗，新行不被
//   断尾毒化成「半行+整行」的不可解析串。
//
// 同步性不变量：六幕与落盘全部为同步消化（deps 皆为同步面、appendFileSync
//   落盘）—— runSleepCycle 虽为 async 签名，触发即完成主体（供卸载路径在
//   一切 reset 之前安全快照；接线注释见 src/index.ts 纪元 Υ 段）。
// W6-1（doctor 债清偿·smell.over-engineering）：依赖注入契约类型区搬至 ./sleepTypes
//（原位 `export *` 再导出 —— 导入面不变）；六幕执法区（①②③⑤幕 + 水位线 + 晨报
// 幕净化）搬至 ./sleepActs；校准幕（纪元 Ζ 标定建议书 + 记忆操作收敛旁挂）搬至
// ./calibrationAct —— 全部逐字节搬运，本文件保留主编排 runSleepCycle。
import type { DreamReplayReport } from './dreamReplay';
export * from './sleepTypes';
// W8（D-B4 梦回放失败源接线）：组合根供源工装的桶再导出（dreamFeed 零运行期
// 依赖 —— type-only 相对导入，装载器零耦合；导入面收口在桶，宿主单点可达）
export { createDreamDeps, type DreamFeedFaces } from './dreamFeed';
import {
  actAudit, actDistill, actImmune, actReplay, appendLine, computeWatermark,
  errText, readTail, safeNow, sanitizeQueueSummary, snapshotUsage,
} from './sleepActs';
import { actCalibrate } from './calibrationAct';
import type {
  MorningApprovalQueueSummary, SleepActReport, SleepConfig, SleepDeps,
  SleepMemoryOpsSummary, SleepReport,
} from './sleepTypes';

/** 缺省睡眠预算：2s（与 src/index.ts 卸载路径的保险丝同值 —— 宁短勿挂） */
export const DEFAULT_SLEEP_BUDGET_MS = 2000;

/** 六幕名（固定演出次序：回放→蒸馏→免疫→校准→审计→晨报） */
const SIX_ACTS = ['replay', 'distill', 'immune', 'calibrate', 'audit', 'report'] as const;

/** 模块级内存水位线（路径空 = 唯一水位线；路径非空时与 trace 尾行互补） */
let inMemoryWatermark: string | null = null;

/** W5-2：梦回放独立水位线（内存面 —— 失败集身份指纹；trace 尾行互补跨进程） */
let inMemoryDreamWatermark: string | null = null;

/** 测试缝：清零内存水位线（模拟新进程 —— 只清水位线账，不动磁盘 trace） */
export function resetSleepCycle(): void {
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
export async function runSleepCycle(deps: SleepDeps = {}, config: SleepConfig = {}): Promise<SleepReport> {
  const now = typeof config.now === 'function' ? config.now : () => Date.now();
  const rawBudget = config.budgetMs;
  const budgetMs = typeof rawBudget === 'number' && Number.isFinite(rawBudget) && rawBudget >= 0
    ? rawBudget : DEFAULT_SLEEP_BUDGET_MS;
  const log = typeof deps.log === 'function' ? deps.log : ((m: string) => { console.log(m); });
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
        acts: SIX_ACTS.map(name => ({ name, status: 'noop' as const, counts: {} })),
      };
    }

    const acts: SleepActReport[] = [];
    // W3-2 第二批接线②的旁车：校准幕收敛摘要带给晨报顶层（approvalQueue 同律）；
    // W5-2 的旁车：梦回放摘要（第①幕复合幕产出）同律带给晨报顶层
    const sidecars: { memoryOps?: SleepMemoryOpsSummary; dream?: DreamReplayReport } = {};
    const overBudget = (): boolean => safeNow(now) - startedAt > budgetMs;
    // W5-2：幕体可为异步（梦回放的 sharp 面）—— 逐幕顺序 await（幕序不变、
    // 半程检查不变）；全同步 deps 下 await 只是微任务直落，「触发即完成主体」
    // 的同步性不变量对既有路径逐字节保持（梦是唯一申报的异步消化面）。
    const step = async (name: string, fn: () => SleepActReport | Promise<SleepActReport>): Promise<void> => {
      if (overBudget()) { // 宁短勿挂：预算耗尽的幕不再演，标记后继续铸半程报告
        acts.push({ name, status: 'timeout', counts: {}, detail: `睡眠预算 ${budgetMs}ms 耗尽 —— 半程报告（宁短勿挂）` });
        return;
      }
      try {
        acts.push(await fn());
      } catch (e) {
        acts.push({ name, status: 'error', counts: {}, detail: errText(e) });
      }
    };

    // W5-2：梦回放独立水位线（内存优先，trace 尾行补跨进程）—— 防重复回放的锚
    const priorDreamWatermark = inMemoryDreamWatermark ?? tail.dreamWatermark;
    await step('replay', () => actReplay(deps, { now, overBudget, priorDreamWatermark }, sidecars));
    await step('distill', () => actDistill(deps));
    await step('immune', () => actImmune(deps));
    await step('calibrate', () => actCalibrate(deps, sidecars));
    await step('audit', () => actAudit(deps));

    // ⑥ 晨报幕：用量快照 + W2-1 待批清单 + JSONL 落盘 + 水位线前滚
    let usage: Record<string, number> | undefined;
    let approvalQueueSummary: MorningApprovalQueueSummary | undefined;
    await step('report', () => {
      usage = snapshotUsage(deps.meter);
      const counts: Record<string, number> = {};
      const notes: string[] = [];
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
        } catch (e) {
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
      const optimistic: SleepActReport = {
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
      } catch (e) {
        throw new Error(`晨报落盘失败：${errText(e)}`);
      }
      return optimistic;
    });

    // 水位线前滚（内存面无条件；磁盘面已随行 —— append 失败时下次进程重睡，
    // 宁可重复归纳（签名去重只强化可靠度）不可漏睡）
    inMemoryWatermark = current;
    // W5-2：梦回放独立水位线前滚（只在梦摘要真实在场时 —— noop/缺席/故障不动账；
    // 磁盘面随晨报行 —— 下次进程经 readTail 恢复，同一失败集不再重复回放）
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
  } catch (e) {
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
