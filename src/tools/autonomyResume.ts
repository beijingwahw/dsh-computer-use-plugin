// src/tools/autonomyResume.ts
// 纪元 Σ（Σ-3 断点续跑）：autonomy_resume 元工具 —— 自主任务中断后凭 token
// 恢复续跑。血脉：autonomous_run 每次运行经 PilotStore 铸档（begin → 步级
// recordStep → 终局 finish），终局非 achieved 的锚点携带 resume_token；
// 本工具 load 该档案 → 以 record.goal 重铸 GoalSpec + 判据回放（已 met/violated
// 的判据逐条 recordCriterion 重放，GoalStateMachine 无 restore —— 回放即 restore）
// → runPilotLoop（与 autonomous_run 同一套栈组装/进化/锚点契约）。
// 门控：autonomyEnabled（与 autonomous_run 同门）；deps 注入口（RuntimeDeps）
// 供全离线测试；绝不抛异常。
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from '../config';
import { toolErr } from '../toolResult';
import { GoalStateMachine, type GoalSpec, type RuntimeDeps } from '../autonomy/index';
import { runPilotLoop, pilotStoreFor, type AutonomousRunDeps } from './autonomousRun';

/**
 * autonomy_resume 可注入依赖（透传 RuntimeDeps —— 假截屏序列/假 OCR/假云脑/
 * 假时钟由此进，测试全离线；缺省走真实管线）
 */
export type AutonomyResumeDeps = RuntimeDeps;

/**
 * 判据回放（GoalStateMachine 无 restore —— 逐条 recordCriterion 即 restore）：
 * 已 met/violated 的判据按 criterion 文本在新生机上对位重放（文本对位失败时落回
 * 原始序号 —— 覆盖「档案判据与 spec 等长同序」的常态）；unverified 不回放
 * （新机生而 unverified）。回放异常整段吞掉（绝不炸续跑）。
 */
function replayCriteria(
  machine: GoalStateMachine,
  criteriaStatus: ReadonlyArray<{ criterion: string; status: string }> | undefined,
): void {
  try {
    if (!Array.isArray(criteriaStatus) || criteriaStatus.length === 0) return;
    let live: Array<{ criterion: string }> = [];
    try {
      live = machine.progress.criteriaStatus;
    } catch {
      return;
    }
    criteriaStatus.forEach((cs, i) => {
      if (cs === null || typeof cs !== 'object') return;
      if (typeof cs.criterion !== 'string') return;
      if (cs.status !== 'met' && cs.status !== 'violated') return;
      let idx = live.findIndex(c => c.criterion === cs.criterion);
      if (idx < 0 && Number.isInteger(i) && i >= 0 && i < live.length) idx = i;
      if (idx >= 0) machine.recordCriterion(idx, cs.status);
    });
  } catch {
    /* 回放异常吞掉 —— 新机保持全 unverified，靠本轮证据重新核判（诚实降级） */
  }
}

/** 档案 goal 快照 → 重铸 GoalSpec（防御式：垃圾字段逐项剔除，预算字段原样复活） */
function reforgeSpec(goal: {
  goal: string;
  successCriteria: string[];
  failureCriteria?: string[];
  maxSteps?: number;
  timeBudgetSec?: number;
}): GoalSpec {
  const spec: GoalSpec = {
    goal: typeof goal.goal === 'string' ? goal.goal : '',
    successCriteria: Array.isArray(goal.successCriteria)
      ? goal.successCriteria.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
      : [],
  };
  const failure = Array.isArray(goal.failureCriteria)
    ? goal.failureCriteria.filter((f): f is string => typeof f === 'string' && f.trim() !== '')
    : [];
  if (failure.length > 0) spec.failureCriteria = failure;
  if (typeof goal.maxSteps === 'number' && Number.isFinite(goal.maxSteps)) {
    spec.maxSteps = goal.maxSteps;
  }
  if (typeof goal.timeBudgetSec === 'number' && Number.isFinite(goal.timeBudgetSec)) {
    spec.timeBudgetSec = goal.timeBudgetSec;
  }
  return spec;
}

export function createAutonomyResumeTool(config: Config, deps: AutonomyResumeDeps = {}) {
  return defineTool({
    name: 'autonomy_resume',
    description:
      'Resumes an INTERRUPTED autonomous run from its resume_token: reloads the pilot record ' +
      '(goal spec + criteria ledger + trajectory so far), forges a fresh GoalStateMachine with the ' +
      'already-met/violated criteria REPLAYED (met ones are never re-verified), then drives the same ' +
      'autonomous loop (perceive -> judge -> constitution -> execute -> verify -> evolve) under the ' +
      'SAME token — steps and trajectory keep accumulating in the record. ' +
      'Fresh budgets are granted per resume (maxSteps counts steps of THIS continuation, wall-clock restarts). ' +
      'The token comes from the resume_token anchor field of any non-achieved autonomous_run ending ' +
      '(aborted / failed / blocked / escalated). Done runs are rejected honestly.',
    parameters: {
      token: {
        type: 'string',
        required: true,
        description:
          'Resume token from a previous autonomous_run anchor (resume_token field), e.g. "AUTO-1a2b3c4d".',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        // 门卫：与 autonomous_run 同门（buildAllTools 挂载门之外的纵深防御）
        if (!config.autonomyEnabled) {
          return toolErr(
            'autonomy_resume unavailable.',
            'Autonomy is disabled (set autonomyEnabled: true in config to mount this tool).',
            'Enable autonomyEnabled in cordis.yml, or drive the loop yourself with take_screenshot + click_mouse.',
          );
        }
        const token = typeof args.token === 'string' ? args.token.trim() : '';
        if (!token) {
          return toolErr(
            'autonomy_resume validation failed.',
            'Empty token argument.',
            'Pass the resume_token from a previous autonomous_run anchor (present on any non-achieved ending).',
          );
        }

        // 载档：与 autonomous_run 同一血脉（tracePath 空 ⇒ 内存档；非空 ⇒ 落盘重放）
        const store = pilotStoreFor(config);
        const record = store.load(token);
        if (!record) {
          return toolErr(
            'autonomy_resume failed.',
            `No pilot run found for token '${token}'.`,
            'Run autonomous_run first (any non-achieved ending mints resume_token in its anchor). ' +
              'If the run started in ANOTHER process, set autonomyTracePath in config so records persist to disk.',
          );
        }
        if (record.status === 'done') {
          return toolErr(
            'autonomy_resume failed.',
            `Pilot run '${token}' is already done (phase '${record.phase}') — nothing to resume.`,
            'Start a fresh autonomous_run with a sharpened goal/success_criteria instead of resuming a finished one.',
          );
        }

        // 重铸：spec 复活 + 判据回放（时间预算开新窗 —— 续跑不继承旧钟）
        const spec = reforgeSpec(record.goal);
        const goalMachine = new GoalStateMachine(spec, deps.now);
        replayCriteria(goalMachine, record.criteriaStatus);

        // 续用原 token（JSDoc 已明示）：同档累计轨迹与步账 —— 中断前后同一条血脉
        return await runPilotLoop({
          toolName: 'autonomy_resume',
          config,
          deps,
          spec,
          goalMachine,
          store,
          token,
        });
      } catch (error: any) {
        return toolErr(
          'autonomy_resume failed.',
          error?.message ?? 'unknown error',
          'The resume crashed unexpectedly — check the capture/OCR/execution pipeline with take_screenshot, ' +
            'then retry autonomy_resume with the same token (the record is untouched on crash).',
        );
      }
    },
  });
}
