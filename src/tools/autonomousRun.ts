// src/tools/autonomousRun.ts
// W6-2 结构性保留（doctor smell.over-engineering 登记）：autonomous_run 单工具面 —— 参数 schema/发射/遥测记录/结果铸造同链路内聚，拆分收益低于工具面碎片化代价。
// 纪元 Φ（自主智能环工具面）：autonomous_run 元工具 —— 让「自主识别 → 自主判断
// → 自主执行」成为一次调用的产品能力。铸 GoalSpec → buildAutonomyStack 组装
// 十器官栈 → runAutonomousLoop 跑环 → auditTrajectory 自审 → EvolutionEngine
// 进化（模块级单例，跑一次聪明一次）→ toolResult 工厂锚点汇报。
// 宪法升级（审批/否决）⇒ ACTION_REQUIRED 请人类裁决；未达成 ⇒ FAILED；
// 绝不抛异常；deps 注入口（RuntimeDeps）供全离线测试。
//
// 纪元 Ξ（Ξ-B 生产自监督对账）：runPilotLoop 的 execute 包装器长出观察式旁路 ——
// 快路径内核判决（verifyAfter 即时 dhash）用「慢而准」的 settle-verify 真值对账，
// 证据落 kernel/registry 的 evidenceLedger：① 免费证据恒开（判据匹配点击的
// outcome ⇒ policy.matchConfident 记账，零额外成本）；② 慢真值对账门控
// （config.kernelEvolutionEnabled === true 时对 click/type 旁路跑 waitForStableHash
// + reportEffect 得真值，与 instant 对账 ⇒ world.hammingTolerance 记账）。
// 旁路绝不影响主流程：异常全吞、关闸零等待（默认路径与现状逐字节等同）。
//
// 纪元 Σ（Σ-3 断点续跑）接线：每次运行经 PilotStore 铸档（begin 铸 token →
// onStep 链式叠加步级落账 → 终局 finish 定档）；终局非 achieved ⇒ 锚点附
// resume_token，autonomy_resume(token) 可凭档复活铸态续跑（判据回放，不重核
// 已 met 判据）。缺省（autonomyTracePath 空）为纯内存档 —— 行为不变，仅失去
// 跨进程续跑。跑环主体抽成 runPilotLoop 供 autonomy_resume 复用（同一套栈组装
// /进化/锚点契约）。
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from '../config';
import { toolOk, toolErr, toolActionRequired } from '../toolResult';
import {
  buildAutonomyStack, createExecute, runAutonomousLoop, auditTrajectory, EvolutionEngine,
  GoalStateMachine, PilotStore, activeSteerSession,
  type GoalSpec, type PolicyAction, type RuntimeDeps, type ExecOutcome, type StepRecord,
  type AutonomyDeps,
} from '../autonomy/index';
// W5-5（缝3）：换支重放偏置的步进面类型（在役 steer 会话 → runAutonomousLoop 的
// 注入面；steerTools → branchCards 均下游，与本文件零回路）。
import type { SteerBiasStepper } from './steerTools';
import { waitForStableHash, reportEffect } from '../actionVerifier';
import { evidenceLedger, kernelRegistry, type KernelOutcome } from '../kernel/registry';
import { resetVerifyGateBudget } from '../vlm/grounding';
// W3-4（takeGranted 续跑接线）：只读消费 approvalQueue（takeGranted/pendingSummary）
// 与 journal 步账；对账纯函数从 orchestrator 复用（单一事实源，不复制逻辑）。
import { approvalQueue, type QueuedApprovalEntry } from '../approval';
import { journal } from '../journal';
import { reconcileResumeWindow, type ResumeReconciliation } from '../orchestrator';

/** 目标与判据的字符预算（Token 纪律：goal 是状态锚点，不是需求文档） */
const GOAL_MAX_CHARS = 500;
const CRITERION_MAX_CHARS = 200;
const CRITERIA_MAX_COUNT = 8;

/** 模块级进化引擎单例：跨轮持续进化（同进程内跑一次聪明一次） */
const evolution = new EvolutionEngine();

/**
 * ΤΕΛ-10（D-G31 三单例归零缝）：EXP4 进化单例的卸载归零面 —— 组合根
 * UNLOAD_CHECKLIST 'autonomousRun.evolution.reset' 键的消费物料（T1-6 移交
 * 方案 (b)：单例模块私有，唯一暴露面就是本函数）。EvolutionEngine.reset
 * 即其类立法的「清账重置：history 归零、权重/教训/蒸馏回到出厂（单例跨场
 * 复用时的换场闸）」—— 会话边界（热重载）执法：上一会话的运行史不跨会话
 * 混账。纯内存清账零持久化面；绝不抛（reset 本体无抛路径）。
 */
export function resetAutonomousRunEvolution(): void {
  evolution.reset();
}

/**
 * autonomous_run 可注入依赖（透传 RuntimeDeps —— 假截屏序列/假 OCR/假云脑/
 * 假时钟由此进，测试全离线；缺省走真实管线）
 *
 * 纪元 Ξ（Ξ-B 生产自监督对账）新增两个可选注入口（均为观察式旁路，绝不影响主流程）：
 *  · kernelEvidence —— 证据账本测试缝：缺省直连 evidenceLedger 单例；
 *  · settleOracle —— 慢真值测试缝：缺省 waitForStableHash + reportEffect 真实现。
 */
export type AutonomousRunDeps = RuntimeDeps & {
  /**
   * Ξ-B 证据账本注入口（测试缝）：缺省直连 kernel/registry 的 evidenceLedger 单例。
   * 恶意桩（record 抛错/返回垃圾）被整体吞掉 —— 对账是旁路观察者，绝不拖垮跑环。
   * 注意：缺省单例是模块级全局 —— 测试隔离须自行 evidenceLedger.reset()。
   */
  kernelEvidence?: { record(outcome: KernelOutcome): void };
  /**
   * Ξ-B 慢真值神谕注入口（测试缝）：给定动作前指纹，自行完成「settle 等待稳定帧 +
   * reportEffect 前后对比」，返回真值判决。签名只收 beforeHash —— 稳定帧的截取
   * （即「慢」的来源）是神谕的内部职权，调用方不插手。返回 null = 真值不可判
   * （指纹退化等），调用方诚实跳过对账（宁缺毋错）。缺省真实现见 makeSettleOracle。
   */
  settleOracle?: (beforeHash: string) => Promise<{ detected: boolean; distance: number } | null>;
  /**
   * W3-4（takeGranted 续跑）：已批队列条目的执行通道。在场时 runPilotLoop 重入
   * 先调 approvalQueue.takeGranted() 消费至多一条已批条目，连同对账结果交给本
   * 通道执行（返回一句审计注记）。缺席 ⇒ 只读 pendingSummary 审计提示 ——
   * **不破坏性消费**：跑环自身的动作由 policy 引擎决策，无法担保已批动作的
   * 精确形状被派发；takeGranted 是落盘先行 + 铸令牌的消费面，消费而不执行
   * 等于白烧用户的同意（宁可条目留队等 orchestrator 的续跑消费，不可烧令）。
   * 生产接线（集成线）：组合根注入「证据链坐标 → 以 executionToken 派发点击」
   * 的适配器（V 纪元验收式 consume 在工具层照常执法）。防御式：通道异常 ⇒
   * 审计注记，绝不炸环。
   */
  resumeGranted?: (granted: {
    entry: QueuedApprovalEntry;
    executionToken: string;
    reconciliation: ResumeReconciliation;
  }) => Promise<string>;
  /**
   * W5-5（缝2）：岔路账端口的显式注入位（测试缝/生产注入面）。buildAutonomyStack
   * 对 deps.branchLedger 的既有契约是「调用方显式注入优先，只填缺席位」，但该字段
   * 此前在 runPilotLoop 血脉上断头（stack 不透传）—— 本脊梁现将其随栈透传给
   * runAutonomousLoop，契约闭合。缺席 ⇒ buildAutonomyStack 的单例适配照旧
   * （缺省路径零变化 —— 零回归红律）。
   */
  branchLedger?: AutonomyDeps['branchLedger'];
};

// ─── 纪元 Ξ（Ξ-B）：生产自监督对账的常量与纯工具 ───

/** settle 轮询间隔（ms）—— 与 settleAndVerify 的自适应等待同律（150ms 轮询） */
const SETTLE_POLL_MS = 150;
/** settle 预算缺省（ms）—— config.actionSettleMs 缺席/非法时的回退（与 config 缺省同值） */
const DEFAULT_SETTLE_MS = 400;
/** noop 相似度阈缺省 —— config.noopSimilarityThreshold 缺席/非法时的回退（与 config 缺省同值） */
const DEFAULT_NOOP_THRESHOLD = 0.97;
/** world.hammingTolerance 未注册时的容差回声（与 worldSnapshot.DEFAULT_HAMMING_TOLERANCE 同值） */
const DEFAULT_WORLD_TOLERANCE = 3;

/**
 * Ξ-B 门控读取（容忍式）：config.kernelEvolutionEnabled === true 才开慢真值对账。
 * 该字段由基建侧并行在加 —— 此处以结构化窄读消费：字段缺席/非 true/读取异常
 * 一律 falsy 关闸（缺省路径与现状逐字节等同：零额外等待、零额外截屏）。
 */
function kernelEvolutionEnabled(config: Config): boolean {
  try {
    return (config as Partial<Record<'kernelEvolutionEnabled', unknown>> | null | undefined)
      ?.kernelEvolutionEnabled === true;
  } catch {
    return false;
  }
}

/**
 * Ξ-B 缺省慢真值神谕（真实现）：waitForStableHash(150, settleMs×4) 等稳定帧 →
 * reportEffect(beforeHash, stableHash, noopThreshold) 出真值判决。
 * reportEffect 的 effect_detected === null（指纹退化：absent/zero/length）⇒ 返回
 * null（诚实缺席 —— 退化指纹的比对是边界假信号，绝不拿来对账定罪）。
 */
function makeSettleOracle(
  settleMs: number,
  noopThreshold: number,
): NonNullable<AutonomousRunDeps['settleOracle']> {
  return async (beforeHash: string): Promise<{ detected: boolean; distance: number } | null> => {
    const stable = await waitForStableHash(SETTLE_POLL_MS, settleMs * 4);
    const report = reportEffect(beforeHash, stable.hash, noopThreshold);
    if (report.effect_detected !== true && report.effect_detected !== false) return null;
    return { detected: report.effect_detected, distance: report.distance };
  };
}

/** 锚点里的执行附注上限（每步一句，累计截 8 条 —— 记事本不是转录本） */
const NOTES_MAX = 8;

// ─── 纪元 Σ（Σ-3）：断点续跑记账的模块级仓 ───

/** 缺省档案库：纯内存（autonomyTracePath 空 ⇒ 行为不变，token 生命周期 = 进程） */
const memoryPilotStore = new PilotStore();

/** 落盘档案库缓存：路径 → PilotStore（同路径同实例 —— 构造即重放 JSONL 铸态） */
const tracePathStores = new Map<string, PilotStore>();

/**
 * 按配置取档案库（autonomous_run 与 autonomy_resume 的同一血脉）：
 * · autonomyTracePath 空/缺席 ⇒ 模块级内存档（缺省行为不变）；
 * · 非空 ⇒ 该路径的懒铸单例（首取构造即重放既有 JSONL —— 跨进程续跑由此起死回生）。
 * execute 内每次调用都经此函数读 config —— configure 换路径零额外接线。
 */
export function pilotStoreFor(config: Config): PilotStore {
  const p =
    config && typeof config.autonomyTracePath === 'string' ? config.autonomyTracePath.trim() : '';
  if (p === '') return memoryPilotStore;
  let store = tracePathStores.get(p);
  if (!store) {
    store = new PilotStore(p);
    tracePathStores.set(p, store);
  }
  return store;
}

// ─── 纪元 Σ（Σ-3）：跑环主体（autonomous_run / autonomy_resume 共用） ───

/** runPilotLoop 的全部输入（工具名用于结果文案；store+token 为断点续跑血脉） */
export interface PilotLoopOptions {
  /** 结果文案里的工具名（'autonomous_run' | 'autonomy_resume'） */
  toolName: string;
  config: Config;
  deps: AutonomousRunDeps;
  /** 本轮 GoalSpec（resume 时为重铸版） */
  spec: GoalSpec;
  /** 已铸目标机（resume 时判据已回放） */
  goalMachine: GoalStateMachine;
  /** 断点续跑档案库（与 token 成对 —— 步级落账 + 终局定档） */
  store: PilotStore;
  /** 本轮档案令牌（resume 续用原 token —— 同一档案累计轨迹） */
  token: string;
}

/**
 * 跑环主体 + 自审 + 进化 + 锚点汇报（autonomous_run 与 autonomy_resume 共用脊梁）：
 * 组装链与原实现同源（buildAutonomyStack → createExecute → runAutonomousLoop →
 * auditTrajectory → EvolutionEngine.ingest），Σ-3 增两处：
 *  · onStep 链式叠加（既有 stack.onStep 在场则先记账后转调，绝不顶掉）——
 *    每步 store.recordStep（轨迹摘要 + goal.progress.criteriaStatus 深拷贝）；
 *  · 终局 store.finish（含终局判据账全量 —— 续跑回放的权威源）。
 * 锚点：终局非 achieved ⇒ 附 resume_token（next_step 提示 autonomy_resume 续跑）。
 *
 * 纪元 Ξ（Ξ-B）：execute 包装器叠加生产自监督对账旁路（详见包装器处 JSDoc）——
 * 免费证据恒开 + 门控慢真值对账；观察式旁路绝不影响 outcome / 轨迹 / 锚点契约。
 */
export async function runPilotLoop(opts: PilotLoopOptions): Promise<string> {
  const { toolName, config, deps, spec, goalMachine, store, token } = opts;

  // W3-0（W2-0 集成接线 · B 面补全）：每次跑环 = 独立任务边界 —— Zoom 复核
  // 预算清零。W1-8 已知取舍的补全：此前预算只挂用户回合边界与卸载清零，单一
  // 回合内多次 autonomous_run 会共享同一份 8 次复核预算（先到的 run 吃光额度，
  // 后到的 run 复核闸全数 budget-exhausted）。挂点在本脊梁（runPilotLoop）⇒
  // autonomy_resume 同律受益（续跑亦视为新任务）。旁路义务：异常吞。
  // W6R-B2（预算作用域化）：清零带任务作用域键 —— 键 = 本轮档案 token
  //（'AUTO-'+8hex，跑环出生时铸成、全局唯一；resume 续用原 token ⇒ 续跑先清
  // 同键账本再累计，恰为「续跑亦新任务」）。作用域化后并发跑环互不侵占：
  // 甲跑环的边界清零只动甲的账本，不再抹掉乙在飞跑环的复核额度。消费面同键：
  // groundElements opts.verifyTaskId 传 `pilot:<token>` 即与本边界闭环。
  try { resetVerifyGateBudget(`pilot:${token}`); } catch { /* 预算复位是旁路义务 */ }

  // W8-C1（pilot 键消费面终态接线 · 收口件）：跑环主权键注入 —— deps.verifyTaskId
  // 就地铸 `pilot:<token>`，环内 perceive 的缺省云脑接地面（makeDefaultGroundVlm
  // 经 createPerceive 透传，见 runtime.perceive.ts）自此把复核预算记到本任务键
  // 账本：与上方边界 resetVerifyGateBudget(`pilot:${token}`) use/reset 同键闭环
  //（起点清的账本 = 环内消费的账本 —— 缺此注入则环内消费落共用缺省账本，任务
  // 清零形同虚设）。跑环主权：本键恒由脊梁铸造（外部若注入他键会让 reset/use
  // 分家 —— 清 A 账本、消费 B 账本，预算反而永不清零；测试注入同形键
  // `pilot:<token>`（w3wire W3-B②② 先例）与本注入等价无冲突）。防御式：就地
  // 赋值不涉外部 IO，绝不抛；只辖制缺省接地面，注入 groundVlm 的调用方自带
  // 预算主权（runtime.deps.ts 同律，本键不越权）。
  deps.verifyTaskId = `pilot:${token}`;

  // 组装闭环栈：perceive/policy/constitution 由 buildAutonomyStack 铸造
  //（deps.lastSnapshotRef 就地补挂 —— 同一 deps 对象随后铸 execute，感知/执行共享 before 帧）
  const stack = buildAutonomyStack(config, deps);
  const rawExecute = createExecute({ ...deps, spec });
  const executionNotes: string[] = [];

  // ── W3-4（takeGranted 续跑接线）：重入消费 —— W2-1 H4 遗留的执行侧闭环 ──
  //
  // 双通道法则（防御式绝不抛，全部旁路义务）：
  //   · 执行通道在场（deps.resumeGranted）⇒ takeGranted 消费一条已批条目：
  //     先以 entry.stepCursor 对账 journal 步账（orchestrator 的同一纯函数 ——
  //     reconcileResumeWindow：无 cursor/无账/cursor 越界 ⇒ 保守全量重规划，
  //     其余 ⇒ 只重演 cursor 之后的步骤），对账结果随条目交执行通道；
  //   · 执行通道缺席 ⇒ 只读 pendingSummary 审计提示（grantedAwaitingResume
  //     计数 > 0 才注记）—— 不消费：跑环无法担保已批动作形状被精确派发，
  //     消费而不执行 = 白烧用户同意（保守方向：条目留队等 orchestrator 消费）。
  try {
    if (typeof deps.resumeGranted === 'function') {
      const granted = approvalQueue.takeGranted();
      if (granted) {
        let ledger = 0;
        try { ledger = journal.list(false).length; } catch { ledger = 0; }
        const rec = reconcileResumeWindow(granted.entry?.stepCursor, ledger);
        let note = '';
        try {
          note = await deps.resumeGranted({
            entry: granted.entry,
            executionToken: granted.executionToken,
            reconciliation: rec,
          });
        } catch (e: unknown) {
          note = `resume executor fault: ${e instanceof Error ? e.message : String(e)}`;
        }
        const mode = rec.mode === 'replay-window'
          ? `replay-window(cursor=${rec.cursor}, window=${rec.windowSize})`
          : `full-replan(${rec.reason})`;
        executionNotes.push(
          `[Resume] 已批队列条目 ${granted.entry?.id ?? 'unknown'} 续跑消费（对账：${mode}；令牌已铸造）：` +
          `${typeof note === 'string' ? note.slice(0, 300) : ''}`.slice(0, 500),
        );
      }
    } else {
      const summary = approvalQueue.pendingSummary();
      if (summary.grantedAwaitingResume > 0) {
        executionNotes.push(
          `[Resume] ${summary.grantedAwaitingResume} 条已批队列条目待续跑 —— 经 start_complex_task（orchestrator 续跑消费）执行，` +
          `或为 autonomous_run 注入 AutonomousRunDeps.resumeGranted 执行通道。`.slice(0, 500),
        );
      }
    }
  } catch {
    /* 续跑是旁路：任何故障零注记零影响（绝不炸环） */
  }

  // ── W5-5（缝1）：steer B 应答回灌 —— 在役 steer 会话的修订判据重放进本轮目标机 ──
  //
  // 闭环语义：上一环 steer-drift 升级出题、用户应答 B（amendCriterion 已写回旧
  // 目标机）后，模型按 steer_answer 返回的重启指引（restart 字段：修订后锚点
  // 摘要 + resume 语义）重入本脊梁 —— 此处把会话账里未消费的修订判据（经会话
  // 状态传递，见 SteerAmendmentHandoff）replay 进**本轮**目标机。同 goal 匹配
  // 防御：跨目标的陈旧修订绝不回灌。旁路义务：无在役会话 / 会话无账 / 一切
  // 故障 ⇒ 零回灌零注记（与接线前逐字节一致 —— 三缝 opt-in 红律）。
  try {
    const w5Session = activeSteerSession();
    if (w5Session !== null && typeof w5Session.drainAmendments === 'function') {
      const handoffs = w5Session.drainAmendments() ?? [];
      let w5Applied = 0;
      for (const h of handoffs) {
        const am = h !== null && typeof h === 'object' ? h.amendment : undefined;
        if (am === null || am === undefined || typeof am !== 'object') continue;
        if (typeof am.criterion_index !== 'number' || typeof am.to !== 'string') continue;
        if (typeof h.goalText !== 'string' || h.goalText !== spec.goal) {
          continue; // 跨 goal 防御：陈旧修订只属于出题时的那个目标
        }
        try {
          if (goalMachine.amendCriterion(am.criterion_index, am.to) === true) w5Applied++;
        } catch {
          /* amendCriterion 防御式绝不抛 —— 双保险 */
        }
      }
      if (handoffs.length > 0) {
        executionNotes.push(
          (`[Steer] B 应答回灌：修订判据 ${w5Applied}/${handoffs.length} 条已重放进本轮目标机` +
            '（修正即新主张，状态重置未核；同 goal 匹配后回灌）').slice(0, 500),
        );
      }
    }
  } catch {
    /* 回灌是旁路：任何故障零影响（绝不炸环） */
  }

  // ── 纪元 Ξ（Ξ-B）：生产自监督对账 —— 快路径判决 vs 慢而准 settle-verify 真值 ──
  //
  // 观察式旁路铁律（本段全部代码一字不违）：
  //   · 绝不影响主流程：对账结果只进证据账本，绝不改写 outcome / note / 轨迹 /
  //     锚点；一切异常（含恶意注入桩抛错）整体吞掉；
  //   · 免费证据恒开（零额外等待、零额外截屏 —— 纯内存记账）；
  //   · 慢真值对账门控（config.kernelEvolutionEnabled === true）：关闸时零额外
  //     等待、零额外截屏、连微任务都不添 —— 默认路径与现状逐字节等同。
  const evidenceSink = deps.kernelEvidence ?? {
    record: (o: KernelOutcome): void => {
      evidenceLedger.record(o);
    },
  };
  const recordEvidence = (o: KernelOutcome): void => {
    try {
      evidenceSink.record(o);
    } catch {
      /* 恶意桩抛错也绝不拖垮跑环 —— 旁观者纪律 */
    }
  };
  const nowMs = (): number => {
    try {
      return typeof deps.now === 'function' ? deps.now() : Date.now();
    } catch {
      return Date.now();
    }
  };
  const evolutionOn = kernelEvolutionEnabled(config);
  const settleMs =
    typeof config?.actionSettleMs === 'number' && Number.isFinite(config.actionSettleMs) && config.actionSettleMs > 0
      ? config.actionSettleMs
      : DEFAULT_SETTLE_MS;
  const noopThreshold =
    typeof config?.noopSimilarityThreshold === 'number' && Number.isFinite(config.noopSimilarityThreshold)
      ? config.noopSimilarityThreshold
      : DEFAULT_NOOP_THRESHOLD;
  const settleOracle = deps.settleOracle ?? makeSettleOracle(settleMs, noopThreshold);

  /**
   * 免费证据（恒开）：判据匹配点击（click 且 payload.matchScore 有限 —— 决策最佳
   * 得分在场，即 policy.matchConfident 内核所闸的那一族决策；弹窗确认点击不带
   * 得分，不入此账）且决策所依据的 before 快照未记降级（感知降级下的点击不作为
   * 置信匹配证据）⇒ 按 outcome 记账：progress ⇒ success:true，其余（no_effect /
   * error / regress）⇒ success:false；margin = 决策最佳得分。
   * 注：闭环契约只把 PolicyAction 递到 execute 面（decision.degraded 不随行），
   * 故「非 degraded」以可观察代理落地：matchScore 在场 + before 快照 degraded 为空。
   * ΠΑΝ-52（去删失 · 双向证据）：本函数**不得**按当前阈值过滤样本 —— 未过
   * 置信门但仍被执行的判据点击（云脑仲裁改选 / 无云脑确定性回退两径都落
   * matchScore）是「降阈」决策的唯一实证来源，其 (margin=真实得分, success)
   * 必须与过门样本同册入账（执法测试锁定：低于阈值的 margin 行在场）。阈学习
   * 自此在当前值两侧都有数据 —— 单向棘轮（只升不降）的证据结构缺陷消除。
   */
  const recordFreeEvidence = (
    action: PolicyAction,
    outcome: ExecOutcome,
    beforeDegraded: string[] | null,
  ): void => {
    const a = (action ?? {}) as Partial<PolicyAction>;
    if (a.kind !== 'click') return;
    const payload = a.payload && typeof a.payload === 'object' ? (a.payload as Record<string, unknown>) : {};
    const score = payload.matchScore;
    if (typeof score !== 'number' || !Number.isFinite(score)) return;
    if (beforeDegraded !== null && beforeDegraded.length > 0) return;
    recordEvidence({
      key: 'policy.matchConfident',
      success: outcome.outcome === 'progress',
      margin: score,
      ts: nowMs(),
    });
  };

  /**
   * 慢真值对账（门控）：对 click/type 类动作，outcome 判定后旁路跑 settle 神谕
   * （缺省 waitForStableHash(150, settleMs×4) + reportEffect(before, stable, 阈)）
   * 得真值 detected；instant = outcome==='progress'；agree = instant === truth ⇒
   * 记 world.hammingTolerance：success=agree。
   * ΠΑΝ-52（margin 去内生）：margin 改记**外部可观测的原始 dhash 距离**
   * （truth.distance —— 参数扰动方向上的外部观测量：「新容差下仍判稳定的样本
   * 裕量分布」即距离分布，候选容差 t 把 distance ≤ t 判稳定）。旧口径
   * margin = distance − 当前内核容差 是对合映射 x → q − x：margin 分布随当前值
   * x 平移、校准器学得的阈 t* ≈ q − x、落回新值 x' = t* ⇒ 迭代导数 −1，参数
   * 代际振荡（C1-9 H4 —— Beta 后验压噪声振荡，压不住这种结构性翻转）。改记
   * 原始距离后 margin 分布与 x 无关 ⇒ 学得阈直接是外部判别分位 q，单调收敛。
   * before 串复用 deps.lastSnapshotRef 既有机制（感知写 / 本包装器动作前读）。
   * 神谕返回 null（指纹退化）⇒ 诚实跳过（宁缺毋错）。
   */
  const reconcileSlowTruth = async (
    action: PolicyAction,
    outcome: ExecOutcome,
    beforeHash: string | null,
  ): Promise<void> => {
    const a = (action ?? {}) as Partial<PolicyAction>;
    if (a.kind !== 'click' && a.kind !== 'type') return;
    if (typeof beforeHash !== 'string' || beforeHash === '') return;
    const truth = await settleOracle(beforeHash);
    if (!truth || typeof truth.detected !== 'boolean' || !Number.isFinite(truth.distance)) return;
    const instant = outcome.outcome === 'progress';
    const tolerance = kernelRegistry.getOrDefault('world.hammingTolerance', DEFAULT_WORLD_TOLERANCE);
    recordEvidence({
      key: 'world.hammingTolerance',
      success: instant === truth.detected,
      // ΠΑΝ-52：margin = 原始 dhash 距离（外部观测量 —— 见 reconcileSlowTruth
      // 注释的对合振荡论证）。tolerance 变量仅作即时判决对照，不入 margin。
      margin: truth.distance,
      ts: nowMs(),
    });
    void tolerance; //（保留读点 —— 判决口径的取证面；margin 域已与其解耦）
  };

  /** 对账旁路总入口：同步段（免费证据）恒开；门控关 ⇒ 返回 null（调用方零 await） */
  const selfSupervise = (
    action: PolicyAction,
    outcome: ExecOutcome,
    beforeDegraded: string[] | null,
    beforeHash: string | null,
  ): Promise<void> | null => {
    try {
      recordFreeEvidence(action, outcome, beforeDegraded);
      if (!evolutionOn) return null; // 关闸 ⇒ 零额外等待（性能铁律）
      return reconcileSlowTruth(action, outcome, beforeHash).catch(() => undefined);
    } catch {
      return null; // 旁路异常全吞 —— 绝不影响主流程
    }
  };

  const execute = async (action: PolicyAction): Promise<ExecOutcome> => {
    // Ξ-B before 串：动作前从共享快照槽只读取证（verifyAfter 不回写槽 ⇒ 执行归来
    // 槽内仍是 before 帧；前置读取纯为语义明确，零副作用）
    const beforeSnap = (() => {
      try {
        return deps.lastSnapshotRef?.current ?? null;
      } catch {
        return null;
      }
    })();
    const beforeDegraded = beforeSnap && Array.isArray(beforeSnap.degraded) ? beforeSnap.degraded : null;
    const rawBeforeHash = beforeSnap?.dhash;
    const beforeHash = typeof rawBeforeHash === 'string' && rawBeforeHash !== '' ? rawBeforeHash : null;

    const outcome = await rawExecute(action);
    if (outcome && typeof outcome.note === 'string' && outcome.note !== '') {
      executionNotes.push(outcome.note);
    }
    // Ξ-B 自监督对账（观察式旁路 —— outcome 原样归还，对账只落证据账本）
    const pending = selfSupervise(action, outcome, beforeDegraded, beforeHash);
    if (pending) await pending;
    return outcome;
  };

  // Σ-3 步级记账：叠加在既有 onStep 链之上（先落账再转调，旁观者异常吞掉）
  const prevOnStep = stack.onStep;
  const onStep = (step: StepRecord): void => {
    store.recordStep(
      token,
      {
        stepIndex: step.stepIndex,
        action: {
          kind: typeof step.action?.kind === 'string' ? step.action.kind : 'unknown',
          ...(step.action?.target && typeof step.action.target.label === 'string'
            ? { target: { label: step.action.target.label } }
            : {}),
        },
        outcome: step.outcome,
        at: step.at,
      },
      goalMachine.progress.criteriaStatus.map(c => ({ criterion: c.criterion, status: c.status })),
    );
    if (prevOnStep) {
      try {
        prevOnStep(step);
      } catch {
        /* 叠加链上的旁观者异常吞掉 —— 记账不为旁路观察者停摆 */
      }
    }
  };

  // ── W5-5（缝3）：steer(k) 换支偏置消费 —— 在役会话的换支重放移交闭环脊梁 ──
  //
  // 用户经 steer_answer 应答支号（"2"/"B2"）后，会话武装了换支重放
  // （applyBranchChoice 的 bias 载荷 + BranchReplayController 预算执法面）；
  // 此处一次性取走（takeBranchBias），注入 runAutonomousLoop 的 steerBias 端口 ——
  // ③¼ 岔路账评分上下文经 withSteerBias 铸入 preferredActionKeys（改选偏置只改
  // 选择不改预测），每步决策既定即扣重放预算，超支诚实终止（偏置摘除原路继续）。
  // 旁路义务：无在役会话 / 无在役重放 / 一切故障 ⇒ 零注入零注记（逐字节旧路径）。
  let w5Replay: SteerBiasStepper | null = null;
  try {
    const w5Session = activeSteerSession();
    if (w5Session !== null && typeof w5Session.takeBranchBias === 'function') {
      const stepper = w5Session.takeBranchBias();
      if (stepper !== null && typeof stepper.step === 'function') w5Replay = stepper;
    }
  } catch {
    /* 换支是增益不是依赖 —— 故障零影响（绝不炸环） */
  }

  const result = await runAutonomousLoop({
    ...stack,
    execute,
    goal: goalMachine,
    onStep,
    // W5-5（缝2）：岔路账端口的显式注入透传（buildAutonomyStack 的「显式注入
    // 优先」契约闭合 —— 缺席时 stack 内的单例适配照旧，缺省路径零变化）。
    ...(deps.branchLedger ? { branchLedger: deps.branchLedger } : {}),
    // W5-5（缝2）：岔路账支点锚 journal 面 —— 铸卡锚来自真实步账（journal 条数 +
    // 链尖），applyBranchChoice 的 verifyAnchor 由此可对卡锚强校验（锚真实可校验）。
    // journal 故障 ⇒ null（锚缺席诚实降级 —— autoPilot 侧消费点防御收敛）。
    branchAnchor: (): { journalLength: number; chainTip: string } | null => {
      try {
        return { journalLength: journal.list(false).length, chainTip: journal.tip };
      } catch {
        return null;
      }
    },
    // W5-5（缝3）：换支重放偏置步进面（在役重放在场才落键 —— 缺席 ⇒ 逐字节旧路径）
    ...(w5Replay !== null ? { steerBias: w5Replay } : {}),
  });

  // W5-5（缝3）收尾记账：achieved ⇒ 重放收尾 complete；预算读数进执行注记
  //（exhausted 是终局事实 —— 超支后 complete 不改判，如实申报）。
  if (w5Replay !== null) {
    try {
      const achieved = result.phase === 'achieved';
      if (achieved) w5Replay.complete();
      const st = w5Replay.state();
      executionNotes.push(
        (`[Steer] 换支重放：${st.status}（预算 ${st.stepsUsed}/${st.budgetSteps} 步已用` +
          `${achieved ? '，已随达成收尾' : ''}）`).slice(0, 500),
      );
    } catch {
      /* 记账是旁路：故障绝不炸环 */
    }
  }

  // Σ-3 终局定档：phase/summary/status + 终局判据账全量（回放的权威源）
  store.finish(
    token,
    result.phase,
    result.summary,
    typeof deps.now === 'function' ? deps.now() : undefined,
    goalMachine.progress.criteriaStatus,
  );

  // 自审 + 进化：轨迹回看 → RunRecord 入库（模块级单例）→ 即时进化读数
  const audit = auditTrajectory(result.trajectory);
  const progress = goalMachine.progress;
  const criteriaMet = progress.criteriaStatus.filter(c => c.status === 'met').length;
  const criteriaTotal = progress.criteriaStatus.length;
  evolution.ingest({
    goal: spec.goal,
    success: result.phase === 'achieved',
    steps: result.steps,
    durationMs: result.durationMs,
    strategies: result.trajectory.map(rec => rec.action?.kind ?? 'unknown'),
    ...(result.phase !== 'achieved'
      ? { failureRootCause: result.escalateReason ?? result.phase }
      : {}),
    criteriaMet,
    ...(criteriaTotal > 0 ? { criteriaTotal } : {}),
  });
  const evolveReport = evolution.report();

  // 锚点：终局相 + 步账 + 判据账 + 审计裁决 + 进化读数（四件套齐整）；
  // Σ-3：终局非 achieved ⇒ 附 resume_token（凭档续跑的令牌）
  const anchor: Record<string, unknown> = {
    phase: result.phase,
    steps: result.steps,
    duration_ms: result.durationMs,
    criteria: { met: criteriaMet, total: criteriaTotal },
    verdict: audit.verdict,
    score: audit.score,
    summary: result.summary,
    escalated: result.escalated,
    lessons: evolveReport.lessons,
    next_run_advice: evolveReport.nextRunAdvice,
    ...(result.escalateReason !== undefined ? { escalate_reason: result.escalateReason } : {}),
    ...(result.phase !== 'achieved' ? { resume_token: token } : {}),
    ...(evolveReport.distilledSkill !== undefined
      ? { distilled_skill: evolveReport.distilledSkill }
      : {}),
    ...(executionNotes.length > 0
      ? { execution_notes: executionNotes.slice(0, NOTES_MAX) }
      : {}),
  };

  if (result.escalated && (result.escalateReason === 'approval-required' || result.escalateReason === 'constitution-veto')) {
    return toolActionRequired(
      `${toolName} escalated to human adjudication.`,
      result.escalateReason,
      anchor,
      'The autonomy constitution demands a human decision: review the summary and escalate_reason. ' +
      'For approval-required, confirm the risky action with the user, then re-invoke autonomous_run ' +
      '(or execute the single step yourself with click_mouse + request_approval). ' +
      'For constitution-veto, redesign the approach — the vetoed action is not unlockable by approval. ' +
      `After the human call, autonomy_resume('${token}') continues THIS run from the saved criteria state.`,
    );
  }
  if (result.phase === 'achieved') {
    return toolOk(
      `${toolName}: goal achieved in ${result.steps} step(s), audit ${audit.verdict} (${audit.score}/100).`,
      anchor,
      `Goal reported achieved with ${criteriaMet}/${criteriaTotal} criteria met by OCR evidence — verify with take_screenshot. ` +
        (evolveReport.nextRunAdvice.length > 0
          ? `Next-run advice: ${evolveReport.nextRunAdvice[0]}`
          : 'No further advice.'),
    );
  }
  return toolErr(
    `${toolName} ended in phase '${result.phase}' (not achieved).`,
    // B-4 工厂的 toolErr 只透传 error 字符串（锚点对象不落 FAILED 结果）——
    // 续跑令牌以「resume_token: <token>」形式内嵌 error 文本，与
    // ACTION_REQUIRED 锚点的 resume_token 字段同源同值（可续跑性两态覆盖）。
    `${result.summary}（resume_token: ${token}）`,
    'Read lessons and next_run_advice in the anchor, re-ground with take_screenshot, then either ' +
      're-invoke autonomous_run with sharper success_criteria or drive the remaining steps yourself. ' +
      `You can also resume THIS exact run later with autonomy_resume('${token}') — saved criteria are replayed, met ones are not re-verified. ` +
      (evolveReport.nextRunAdvice.length > 0 ? `Advice: ${evolveReport.nextRunAdvice.join(' ')}` : ''),
  );
}

export function createAutonomousRunTool(config: Config, deps: AutonomousRunDeps = {}) {
  return defineTool({
    name: 'autonomous_run',
    description:
      'Runs the AUTONOMOUS LOOP for a goal: perceive (screenshot + OCR + optional VLM grounding) -> ' +
      'judge (policy engine picks the next action) -> constitution (risk gate) -> execute (real mouse/keyboard) ' +
      '-> verify (dhash change detection) -> evolve (lessons + distilled skills). ' +
      'One call drives the whole loop up to the step/time budget, then reports phase, audit verdict and lessons. ' +
      'success_criteria default strategy: the goal text itself becomes ONE literal criterion verified by ' +
      'case/whitespace-insensitive substring matching against full-screen OCR text — so pass criteria that ' +
      'literally appear on screen when done (e.g. "任务完成"). ' +
      'The constitution may escalate to ACTION_REQUIRED (approval / veto) — a human makes the final call. ' +
      'Any non-achieved ending mints a resume_token in the anchor: autonomy_resume(token) replays saved ' +
      'criteria and continues this exact run.',
    parameters: {
      goal: {
        type: 'string',
        required: true,
        description: 'Natural-language goal, e.g. "打开系统设置并进入蓝牙页".',
      },
      success_criteria: {
        type: 'array',
        description:
          'Verifiable success criteria (strings). Best practice: phrases that will LITERALLY appear on screen ' +
          '(OCR substring match, case/whitespace-insensitive), e.g. ["蓝牙", "已连接"]. ' +
          'Default: [goal] as a single literal criterion.',
      },
      max_steps: {
        type: 'number',
        description: `Step cap for this run (default ${24}; constitution hard-stops at autonomyMaxSteps anyway).`,
      },
      time_budget_sec: {
        type: 'number',
        description: 'Wall-clock budget in seconds (default autonomyTimeBudgetSec = 300).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        // 门卫：开关关 ⇒ 诚实拒绝（buildAllTools 挂载门之外的纵深防御）
        if (!config.autonomyEnabled) {
          return toolErr(
            'autonomous_run unavailable.',
            'Autonomy is disabled (set autonomyEnabled: true in config to mount this tool).',
            'Enable autonomyEnabled in cordis.yml, or drive the loop yourself with take_screenshot + click_mouse.',
          );
        }
        const goal = typeof args.goal === 'string' ? args.goal.trim().slice(0, GOAL_MAX_CHARS) : '';
        if (!goal) {
          return toolErr(
            'autonomous_run validation failed.',
            'Empty goal argument.',
            'State the goal concretely, e.g. "打开系统设置并进入蓝牙页", plus success_criteria that will appear on screen.',
          );
        }
        const userCriteria = Array.isArray(args.success_criteria)
          ? (args.success_criteria as unknown[])
              .filter((c): c is string => typeof c === 'string' && c.trim() !== '')
              .map(c => c.trim().slice(0, CRITERION_MAX_CHARS))
              .slice(0, CRITERIA_MAX_COUNT)
          : [];
        // 判据缺省律：goal 原文作唯一字面判据（OCR 折叠子串匹配核对 —— 见工具描述）
        const successCriteria = userCriteria.length > 0 ? userCriteria : [goal];
        const maxSteps =
          typeof args.max_steps === 'number' && Number.isFinite(args.max_steps) && args.max_steps >= 1
            ? Math.floor(args.max_steps)
            : config.autonomyMaxSteps;
        const timeBudgetSec =
          typeof args.time_budget_sec === 'number' && Number.isFinite(args.time_budget_sec) && args.time_budget_sec >= 1
            ? args.time_budget_sec
            : config.autonomyTimeBudgetSec;
        const spec: GoalSpec = { goal, successCriteria, maxSteps, timeBudgetSec };

        // Σ-3 铸档：token 出生即入账（tracePath 空 ⇒ 内存档，行为不变）
        const store = pilotStoreFor(config);
        const token = store.begin(spec, typeof deps.now === 'function' ? deps.now() : undefined);
        const goalMachine = new GoalStateMachine(spec, deps.now);

        return await runPilotLoop({ toolName: 'autonomous_run', config, deps, spec, goalMachine, store, token });
      } catch (error: any) {
        return toolErr(
          'autonomous_run failed.',
          error?.message ?? 'unknown error',
          'The autonomy loop crashed unexpectedly — check the capture/OCR/execution pipeline with take_screenshot, then retry.',
        );
      }
    },
  });
}
