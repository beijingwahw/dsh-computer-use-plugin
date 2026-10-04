// src/tools/replayActions.ts
// 突破三的工具面：行动重放。日志中的动作序列 = 可执行的宏。
// confirm:true 显式确认（防误触发真实桌面操作）；步数上限由配置约束；
// click_element 依赖运行时元素缓存，重放时显式跳过并说明原因。
// B-4：返回值统一走 toolResult 工厂（反幻觉锚点全覆盖）。
// D-G5（W8 第 2 批）：回放完成时把轨迹摘要（步指纹序列 + 三态结局 + 整体
// 成败）铸入 notary 锚 —— DEBTS「replayOne 重放层不采集公证证据」清偿；
// 公证缺席 ⇒ 降级标注（notarization.status='degraded' + reason），不阻断回放。
// ΝΩ-5（审批悬账结算）：危险重放步的 approval.beginAttempt 预留此前派发后
// 无人结算（循环内无 consume/attemptFailed）⇒ 令牌永久 in-flight（同令牌
// 重放被在途互斥结构性拒绝）。修法：replayOneTraced 的返回结构携带预留标记
// （reservedApprovalToken），replay_actions / run_skill 的步循环在步终按世界
// 判决结算（settleReservedApproval：死步/失败 ⇒ attemptFailed 续期，成功 ⇒
// consume 验收式）；旧字符串方言面（replayOne 包装）就地结算。
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from '../config';
import { system } from '../system';
import { journal } from '../journal';
import * as backend from '../physicalBackend';
import { normalizeHash, hammingDistance } from '../perceptualHash';

// ─── Y-6 重放场景门控（Epoch Y：宏从「盲目复读」升维为「带门控的执行」）───
//
// 数学：每步前后取全屏 dhash，汉明距离 ≤ deadStepDistance ⇒ 该步是「死步」
// （重放的点击落在已变化的 UI 上，什么都没发生）。策略：死步即停（fail-fast）
// —— 宏的后续步骤建立在死步的前提之上，继续只会制造连锁错误。与幂等重试
// 的区别：这里重放的是「历史」，历史的前提已崩塌时诚实中止并报告分叉点。

export const DEAD_STEP_DISTANCE = 1;

/** 死步判决（纯函数 —— 测试的确定性事实源） */
export function isDeadStep(hashBefore: string | null, hashAfter: string | null, deadDistance: number = DEAD_STEP_DISTANCE): boolean {
  if (!hashBefore || !hashAfter) return false; // 证据缺席：不判死（放行）
  return hammingDistance(normalizeHash(hashBefore), normalizeHash(hashAfter)) <= deadDistance;
}

/**
 * 回放步结局三态（纯函数 —— D-G5 见证口径）：true=已执行 / false=失败
 * （安全闸门拦截、派发异常 —— FAILED 前缀）/ null=跳过（SKIPPED 或模型侧
 * 恢复指令 —— 未执行且非失败）。诚实三态，绝不把跳过伪装成执行或失败。
 */
export function replayStepExecuted(line: unknown): ReplayStepOutcome {
  try {
    if (typeof line !== 'string') return null;
    if (line.startsWith('FAILED:') || line.includes(SAFETY_GATE_BLOCK)) return false;
    if (line.startsWith('SKIPPED') || line.startsWith('OK (model-side')) return null;
    return true;
  } catch {
    return null; // 判读绝不抛
  }
}
import type { JournalEntry } from '../journal';
import { sleep } from '../actionVerifier';
import { toolOk, toolErr, toolActionRequired } from '../toolResult';
import { assertActionAllowed, SAFETY_GATE_BLOCK, type ActionGateConfig } from './actionGate';
import { approval } from '../approval';
import {
  anchorReplayTrajectory,
  replayStepFingerprint,
  type ReplayStepOutcome,
  type ReplayStepWitness,
  type ReplayTrajectoryWitness,
} from '../notary/index';

export function createReplayActionsTool(config: Config) {
  return defineTool({
    name: 'replay_actions',
    description:
      'Replays recorded actions from the journal (a macro). Use this to repeat a previously ' +
      'successful action sequence, e.g., re-opening the same workflow. Requires confirm=true.',
    parameters: {
      confirm: { type: 'boolean', required: true, description: 'Must be explicitly true to execute.' },
      // ΝΩ-31（索引语义立法）：索引域 = **全局行动日志**（journal 的 ACTION_TOOLS
      // 过滤视图 —— 只数动作条目，marker/观察行不计），跨任务累计、非任务内编号；
      // 与 save_skill 的 from_step/to_step、what_if 决策点同一索引空间
      // （journal.findDecisionPoints 头注在案的统一律，不搞两套坐标）。任务内偏移
      // 可由本工具 ACTION_REQUIRED 回执的 state_anchor.current_task_start_index 换算。
      from_step: {
        type: 'number',
        description: '0-based start index in the GLOBAL action journal (action entries only, across ALL tasks ' +
          'this session — NOT task-local; same index space as save_skill/what_if). Default 0. ' +
          'The ACTION_REQUIRED receipt reports journal_actions and current_task_start_index to convert: ' +
          'global = current_task_start_index + task-local offset.',
      },
      to_step: {
        type: 'number',
        description: '0-based end index (inclusive) in the same GLOBAL action-journal space as from_step. ' +
          'Default: latest.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      if (!config.enableJournal) {
        return toolErr(
          'Replay unavailable.',
          'Journal is disabled (enableJournal=false). Nothing to replay.',
          'Enable the journal in config to record and replay actions.',
        );
      }
      if (args.confirm !== true) {
        // ΝΩ-31（假 affordance 修）：旧文案指引「inspect the plan first via the
        // dry-run report」—— 该报告不存在，是幽灵出口。改为真实可用的排练路径：
        // save_skill 把区间固化成技能 → run_skill 的沙箱虚拟排练闸（低可靠性
        // 技能先过 sandbox rehearsal 才许宿主派发）。锚点同时给出索引换算物料
        //（全局行动流长度 + 当前任务起点 —— 模型据此计算任务内偏移）。
        const taskStart = journal.list().length - journal.sinceTaskStart().length;
        return toolActionRequired(
          'Replay awaiting explicit confirmation.',
          'replay-needs-confirm',
          {
            current_state: 'Replay is a real-world side-effect operation.',
            journal_actions: journal.list().length,
            current_task_start_index: taskStart,
            index_space: 'global action journal (all tasks this session); task-local = index - current_task_start_index',
          },
          'Set confirm=true to execute the replay directly. To rehearse safely first: save_skill the range ' +
          '(same from_step/to_step index space) into a skill, then run_skill it — low-reliability skills must ' +
          'pass the sandbox rehearsal gate before host dispatch.',
        );
      }

      const all = journal.list();
      // J 纪元修正：to_step 补下界钳制 —— 旧实现只有上界 min(len-1)，
      // to_step=-5 时 slice(0, -4) 静默选中「除最后 4 条外的全部」并重放，
      // 与钳制 from 的初衷自相矛盾。NaN 防御：Math.max(0, NaN)=NaN，slice 视
      // NaN 为 0 —— 非有限数一律按缺省记，绝不让坏下标静默扩大重放范围。
      const fromStep = typeof args.from_step === 'number' && Number.isFinite(args.from_step)
        ? args.from_step
        : 0;
      const toStep = typeof args.to_step === 'number' && Number.isFinite(args.to_step)
        ? args.to_step
        : all.length - 1;
      const from = Math.max(0, fromStep);
      const to = Math.max(from, Math.min(all.length - 1, toStep));
      const steps = all.slice(from, to + 1);

      if (steps.length === 0) {
        return toolOk(
          `No replayable actions in range [${from}, ${to}].`,
          { range: { from, to }, journal_length: all.length },
          'Adjust from_step/to_step, or perform the actions manually — the journal may be empty or the range is out of bounds.',
        );
      }
      if (steps.length > config.replayMaxSteps) {
        return toolErr(
          'Replay rejected.',
          `${steps.length} steps exceed replayMaxSteps (${config.replayMaxSteps}).`,
          'Narrow the from_step/to_step range and retry in batches.',
        );
      }

      const log: string[] = [];
      // D-G5（重放公证）：轨迹见证采集 —— 步指纹序列 + 三态结局，回放完成时铸锚
      const witnessSteps: ReplayStepWitness[] = [];
      let halted: { index: number; tool: string } | null = null;
      let haltGate: 'dead-step' | 'safety-gate' | 'step-failure' = 'dead-step';
      const gated = config.verifyActions && !config.dryRun;
      for (let i = 0; i < steps.length; i++) {
        const entry = steps[i];
        // Y-6 场景门控：动作步前取指纹（观察型步骤无副作用，免门控开销）
        const isActionStep = ['click_mouse', 'type_text', 'scroll_page', 'press_hotkey', 'drag_mouse'].includes(entry.tool);
        const before = gated && isActionStep
          ? await backend.captureProcessed({ metaOnly: true, wantHashes: true })
          : null;
        // ΝΩ-5：replayOneTraced 携带预留标记（reservedApprovalToken）—— 步终
        // 按世界判决结算（见下方三处 settleReservedApproval）。
        const outcome = await replayOneTraced(entry, config);
        const line = outcome.line;
        log.push(`#${entry.ts} ${entry.tool}: ${line}`);
        witnessSteps.push({
          index: i,
          tool: entry.tool,
          fingerprint: replayStepFingerprint(entry),
          executed: replayStepExecuted(line),
        });
        await sleep(150); // 步间微歇，给 UI 响应时间
        // Δ 纪元（审计#1）：安全闸门拦截 ⇒ fail-fast 中止 —— 宏的后续步骤建立在
        // 被拦截的不可逆步骤之上，继续只会制造半途而废的世界状态（与 Y-6 死步
        // 即停同律：诚实中止并报告分叉点）。
        if (line.includes(SAFETY_GATE_BLOCK)) {
          // ΝΩ-5：拦截步无预留（拦截在预留之前）—— 结算幂等防御
          settleReservedApproval(outcome.reservedApprovalToken, true, 'safety-gate');
          halted = { index: i, tool: entry.tool };
          haltGate = 'safety-gate';
          log.push(`  [GATE] step ${i} 重放被安全闸门拦截 — replay halted (dangerous/gated step was NOT executed)`);
          break;
        }
        // 派发失败即停：FAILED 步 = 物理动作根本没执行（system 层异常）—— 比
        // 死步（执行了但无效）更强的事实，后续步骤的前提同样已崩塌，继续只会
        // 制造连锁错误（与 Y-6 死步即停 / Δ 纪元闸门即停同律）
        if (line.startsWith('FAILED:')) {
          // ΝΩ-5：失败步的预留按 attemptFailed 结算（异常续期语义 —— 令牌
          // 保留、预留释放，绝不悬账为永久 in-flight）
          settleReservedApproval(outcome.reservedApprovalToken, true, 'step-failure');
          halted = { index: i, tool: entry.tool };
          haltGate = 'step-failure';
          log.push(`  [GATE] step ${i} dispatch FAILED — replay halted (the step did NOT execute)`);
          break;
        }
        let deadStep = false;
        if (before?.dhash) {
          const after = await backend.captureProcessed({ metaOnly: true, wantHashes: true });
          deadStep = isDeadStep(before.dhash, after.dhash ?? null);
        }
        // ΝΩ-5（审批悬账结算）：危险重放步的 beginAttempt 预留在步终按世界判决
        // 结算 —— 死步（执行了但世界未动）/ 失败 ⇒ attemptFailed 续期（同一
        // 授权内重试不再打扰用户）；成功 ⇒ consume 验收式（世界已承接不可逆
        // 效果，用户的同意兑现）。重放层无 clickMouse 的取证链 ⇒ 步循环就是
        // 验收面。
        settleReservedApproval(
          outcome.reservedApprovalToken, deadStep, deadStep ? 'dead-step' : 'replay-step-verified');
        if (deadStep) {
          halted = { index: i, tool: entry.tool };
          haltGate = 'dead-step';
          log.push(`  [GATE] step ${i} produced NO screen change — replay halted (the UI has diverged from the recorded scene)`);
          break;
        }
      }

      // D-G5（重放公证接线）：回放完成（走完或 halt 诚实中止 —— 中止也是结局，
      // 照铸不讳）⇒ 把回放轨迹摘要（步指纹序列 + 三态结局 + 整体成败）铸入
      // notary 锚，走既有 anchorOnce 通道（endpoint 空 = 本地时间锚零网络，
      // 既有纪律保持；见证入锚的哈希域与时间戳摘要域 —— 防篡改同律）。
      // 公证缺席（宿主未装配 notary）或铸锚失败 ⇒ 诚实降级标注 —— 公证是旁路
      // 仪式，绝不阻断回放、绝不伪造 anchored。
      const replayNotarization = await anchorReplayTrajectory({
        kind: 'replay-trajectory',
        version: 1,
        source: 'replay_actions',
        replayedSteps: witnessSteps.filter(s => s.executed === true).length,
        totalSteps: steps.length,
        success: halted === null,
        halt: halted === null ? null : { gate: haltGate, index: halted.index, tool: halted.tool },
        steps: witnessSteps,
      });

      if (halted) {
        return JSON.stringify({
          status: 'PARTIAL_FAILURE',
          state_anchor: {
            replayed_steps: halted.index,
            total_steps: steps.length,
            diverged_at_step: halted.index,
            diverged_tool: halted.tool,
            gate: haltGate === 'safety-gate'
              ? 'pre-dispatch safety gate (approval/risk) — 重放被安全闸门拦截'
              : haltGate === 'step-failure'
                ? 'step dispatch failure (system-layer exception) — 该步未执行即失败'
                : 'per-step scene hash (dHash dead-step detection)',
            notarization: replayNotarization,
          },
          execution_log: log.join('\n'),
          next_step: haltGate === 'safety-gate'
            ? 'REPLAY HALTED: a step was BLOCKED by the safety gate (irreversible target without a valid approval ' +
              'token, or gated input) and was NOT executed. Re-run that step live via click_mouse/type_text with ' +
              'proper user consent (request_approval → grant_approval), then continue the remaining steps manually.'
            : haltGate === 'step-failure'
              ? 'REPLAY HALTED: a step FAILED to dispatch (system-layer exception — the action did NOT execute; ' +
                'see execution_log for the error). take_screenshot to inspect the current state, re-run the failed ' +
                'step live, then continue the remaining steps.'
              : 'REPLAY HALTED: a step produced zero screen change — the current UI no longer matches the scene ' +
                'where this macro was recorded. take_screenshot, re-record the affected steps (save_skill), and replay the rest.',
        }, null, 2);
      }
      return toolOk(
        `Replayed ${steps.length} action(s).`,
        { replayed_steps: steps.length, detail: log, notarization: replayNotarization },
        "Call 'take_screenshot' to verify the final state matches the expected outcome.",
      );
    },
  });
}

/** 单条日志/技能步骤 → 系统层调用。依赖运行时缓存的工具（click_element）显式跳过。
 *  Δ 纪元（审计#1）：重放不再豁免工具层闸门 —— click_mouse/type_text 步前置
 *  assertActionAllowed（与 clickMouse/typeText 工具同一事实源）：危险词命中且
 *  步骤无有效审批令牌、或凭据/超长输入 ⇒ 该步返回结构化失败（FAILED 形态，
 *  不派发物理动作）；replay_actions 循环据此 fail-fast 中止，run_skill 据此
 *  计失败步。config 由调用方透传（缺省 = 与 Config 缺省同值的保守闸门）。 */

/** ΝΩ-5：重放步结果结构 —— line = 既有方言字符串（FAILED/SKIPPED/动作回执）；
 *  reservedApprovalToken = 本步经 approval.beginAttempt 预留、待步终按世界
 *  判决结算的令牌。重放层无 clickMouse 的验收取证链 ⇒ 结算权在步循环
 *  （settleReservedApproval）：死步/失败 ⇒ attemptFailed 续期，成功 ⇒
 *  consume 验收式 —— 预留绝不悬账为永久 in-flight（旧缺陷：beginAttempt
 *  后派发即返回，循环内无结算 ⇒ 令牌永久在途，同令牌重放结构性死锁）。 */
export interface ReplayStepResult {
  line: string;
  reservedApprovalToken?: string;
}

/** ΝΩ-5：预留令牌的步终结算（世界判决 → 账本动作）。纯旁路义务：结算失败
 *  绝不炸重放主流程（运行层铁律）。token 缺席 ⇒ no-op（无预留的步零行为）。 */
export function settleReservedApproval(token: string | undefined, failed: boolean, reason: string): void {
  if (token === undefined) return;
  try {
    if (failed) approval.attemptFailed(token, reason);
    else approval.consume(token);
  } catch { /* 运行层铁律：结算旁路失败不炸重放 */ }
}

/** ΝΩ-5：重放核心（带预留标记）—— replay_actions / run_skill 的步循环走此面，
 *  在步终按世界判决结算预留（见 settleReservedApproval）。 */
export async function replayOneTraced(
  entry: { tool: string; args?: Record<string, any> },
  config?: Partial<ActionGateConfig>,
): Promise<ReplayStepResult> {
  const a = entry.args ?? {};
  // ΝΩ-5：预留簿记前置到 try 外 —— catch 路径标记随身携带（异常 ⇒ 调用方按
  // FAILED 结算 attemptFailed，预留不悬账；与 clickElement/clickMouse 的
  // attemptReserved 前置同律）。
  let reservedApprovalToken: string | undefined;
  const traced = (line: string): ReplayStepResult =>
    reservedApprovalToken === undefined ? { line } : { line, reservedApprovalToken };
  try {
    if (entry.tool === 'click_mouse' || entry.tool === 'type_text') {
      const gate = assertActionAllowed(entry.tool, a, config);
      if (!gate.allowed) {
        return { line: `FAILED: [${SAFETY_GATE_BLOCK}] 重放被安全闸门拦截 (${gate.reason}) — replayed journal/skill steps ` +
          'pass through the SAME approval/risk gates as live tool calls; re-run this step live via the real tool ' +
          'with a valid approval_token (or user-entered credentials for sensitive input).' };
      }
      // 带有效令牌的危险重放步：派发前预留尝试预算（审计#2 同律 —— 重放不经
      // clickMouse 的验收链路，预算即预算）；在途/耗尽 ⇒ 拦截，不派发。
      // ΝΩ-5：预留标记随结果携带 —— 步循环在步终按世界判决结算（本函数
      // 自身不 consume/attemptFailed，结算权在能看到死步/失败事实的调用方）。
      if (entry.tool === 'click_mouse' && gate.dangerous && a.approval_token) {
        if (!approval.beginAttempt(String(a.approval_token))) {
          return { line: `FAILED: [${SAFETY_GATE_BLOCK}] 重放被安全闸门拦截 (attempt-in-flight-or-budget-exhausted) — ` +
            "the approval token's retry budget is exhausted or another attempt is still in flight." };
        }
        reservedApprovalToken = String(a.approval_token);
      }
    }
    switch (entry.tool) {
      case 'click_mouse': {
        // 尺寸只取一次：两次独立异步读在分辨率切换间隙会用不同比例映射 x/y
        const s = await system.getScreenSize();
        await system.clickMouse(a.x * s.width, a.y * s.height, a.button ?? 'left');
        return traced('clicked');
      }
      case 'type_text':
        await system.typeText(a.text ?? '', a.clearFirst ?? false);
        return traced('typed');
      case 'scroll_page':
        await system.scroll(a.direction ?? 'down', a.amount ?? 5);
        return traced('scrolled');
      case 'press_hotkey':
        await system.pressHotkey(a.keys ?? []);
        return traced('hotkey pressed');
      case 'drag_mouse': {
        const s = await system.getScreenSize();
        await system.dragMouse(
          { x: a.startX * s.width, y: a.startY * s.height },
          { x: a.endX * s.width, y: a.endY * s.height },
        );
        return traced('dragged');
      }
      case 'switch_tab':
        await system.pressHotkey(a.direction === 'previous' ? ['ctrl', 'shift', 'tab'] : ['ctrl', 'tab']);
        return traced('tab switched');
      case 'switch_window':
        await system.switchWindowByTitle(String(a.titleKeyword ?? ''));
        return traced('window switched');
      case 'click_element':
        return traced('SKIPPED (element-ID tools depend on runtime cache; replay with click_mouse coordinates instead)');
      case 'dismiss_popup':
        // 纯模型侧恢复指令（无机械动作）—— 宏里是无害占位，不作为失败计
        return traced('OK (model-side recovery instruction; nothing to execute)');
      default:
        return traced(`SKIPPED (unsupported for replay: ${entry.tool})`);
    }
  } catch (e: any) {
    return traced(`FAILED: ${e.message}`);
  }
}

/** 旧字符串方言面（index.ts 宏派发接线 / orchestrator 技能回退 / 既有测试）：
 *  ΝΩ-5 —— 该面没有步终世界判决观测（无死步检测/见证循环），包装层就地结算：
 *  FAILED/闸门拦截 ⇒ attemptFailed 释放预留；成功 ⇒ consume（验收式的保守近
 *  似）。绝不让预留悬账（否则同令牌的下一次调用被在途互斥永久拒绝）。 */
export async function replayOne(
  entry: { tool: string; args?: Record<string, any> },
  config?: Partial<ActionGateConfig>,
): Promise<string> {
  const r = await replayOneTraced(entry, config);
  settleReservedApproval(
    r.reservedApprovalToken,
    r.line.startsWith('FAILED:') || r.line.includes(SAFETY_GATE_BLOCK),
    'replay-step-failed');
  return r.line;
}
