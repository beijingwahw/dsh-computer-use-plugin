// src/tools/skillTools.ts
// 第五轮创新的工具面：技能的写 / 查 / 用三件套。
//   save_skill  — 手动把日志片段固化为技能（自动归纳之外的补充入口）
//   match_skill — 新任务先查库：可靠度加权匹配，命中即省去全程探索
//   run_skill   — 一键执行技能；成败回写可靠度（越用越准的闭环）
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from '../config';
import { skillLibrary, SkillStep } from '../skillLibrary';
import { journal } from '../journal';
import { replayOne } from './replayActions';
import { sleep } from '../actionVerifier';
import { contextManager } from '../contextManager';

export function createSaveSkillTool() {
  return defineTool({
    name: 'save_skill',
    description:
      'Saves a recent successful action sequence (from the journal) as a reusable named skill. ' +
      'Call this after completing a workflow that may be needed again later.',
    parameters: {
      description: {
        type: 'string', required: true,
        description: 'What task does this skill accomplish? Used for matching future requests (e.g., "打开 GitHub 并搜索仓库").',
      },
      from_step: { type: 'number', required: false, description: '0-based start index in the journal. Default: start of the current task.' },
      to_step: { type: 'number', required: false, description: '0-based end index (inclusive). Default: latest.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const from = args.from_step ?? 0;
      const all = journal.list();
      const to = Math.min(all.length - 1, args.to_step ?? all.length - 1);
      const steps: SkillStep[] = all.slice(from, to + 1)
        .filter(e => e.tool !== 'click_element')
        .map(e => ({ tool: e.tool, args: e.args ?? {} }));

      if (steps.length === 0) {
        return `[Error]: No replayable actions in range [${from}, ${to}].`;
      }

      const skill = skillLibrary.induce(args.description, steps, contextManager.lastImageRecord()?.hash);
      if (!skill) {
        return `[Error]: Skill library is disabled (enableSkillLibrary=false).`;
      }
      const dup = skill.successCount > 1 ? ' (existing skill reinforced)' : '';
      return `[System]: Skill #${skill.id} "${skill.name}" saved with ${skill.steps.length} step(s)${dup}. ` +
        `Reliability ${skill.successCount}/${skill.attemptCount}. Reuse via match_skill + run_skill.`;
    },
  });
}

export function createMatchSkillTool() {
  return defineTool({
    name: 'match_skill',
    description:
      'Searches the skill library for previously learned workflows matching a task description. ' +
      'Call this BEFORE planning a complex task — a verified skill skips the whole explore-act-verify loop.',
    parameters: {
      query: {
        type: 'string', required: true,
        description: 'The task you are about to perform, in natural language.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const currentScene = contextManager.lastImageRecord()?.hash;
      const hits = skillLibrary.match(args.query, currentScene, 3);
      if (hits.length === 0) {
        return `[System]: No matching skills. Proceed with the normal explore-act-verify loop; ` +
          `consider save_skill afterwards if this workflow is worth remembering.`;
      }
      const lines = hits.map(s => {
        const reliability = Math.round((s.successCount / s.attemptCount) * 100);
        const preview = s.steps.slice(0, 5).map((st, i) =>
          `    ${i + 1}. ${st.tool} ${JSON.stringify(st.args).slice(0, 80)}`).join('\n');
        const more = s.steps.length > 5 ? `\n    ... (+${s.steps.length - 5} more)` : '';
        return `- #${s.id} "${s.name}" reliability=${reliability}% score=${s.score}\n` +
          `  does: ${s.description}\n${preview}${more}`;
      });
      return `[System]: ${hits.length} matching skill(s):\n${lines.join('\n')}\n` +
        `[Next Step]: If a skill fits, call run_skill with confirm=true (verify with take_screenshot afterwards). ` +
        `Otherwise execute manually — skills are priors, not guarantees (UIs change).`;
    },
  });
}

export function createRunSkillTool(config: Config) {
  return defineTool({
    name: 'run_skill',
    description:
      'Executes a saved skill step-by-step. Skills encode previously verified action sequences. ' +
      'The outcome updates the skill reliability automatically. Requires confirm=true.',
    parameters: {
      id: { type: 'number', required: true, description: 'Skill ID from match_skill.' },
      confirm: { type: 'boolean', required: true, description: 'Must be explicitly true to execute.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const skill = skillLibrary.get(args.id);
      if (!skill) return `[Error]: Skill #${args.id} not found. Call match_skill to list available skills.`;

      if (args.confirm !== true) {
        return JSON.stringify({
          status: 'ACTION_REQUIRED',
          state_anchor: {
            skill: `#${skill.id} "${skill.name}"`,
            steps: skill.steps.length,
            does: skill.description,
          },
          next_step: 'Review the skill steps via match_skill, then call run_skill with confirm=true to execute.',
        }, null, 2);
      }
      if (skill.steps.length > config.replayMaxSteps) {
        return `[Error]: Skill has ${skill.steps.length} steps, exceeding replayMaxSteps (${config.replayMaxSteps}).`;
      }

      const log: string[] = [];
      let failed = 0;
      for (const step of skill.steps) {
        const line = await replayOne(step);
        if (line.startsWith('FAILED') || line.startsWith('SKIPPED')) failed++;
        log.push(`  ${step.tool}: ${line}`);
        await sleep(150);
      }

      const success = failed === 0;
      skillLibrary.recordOutcome(skill.id, success);

      return JSON.stringify({
        status: success ? 'SUCCESS' : 'PARTIAL_FAILURE',
        state_anchor: {
          skill: `#${skill.id} "${skill.name}"`,
          steps_total: skill.steps.length,
          steps_failed: failed,
          reliability_now: `${skill.successCount}/${skill.attemptCount}`,
        },
        execution_log: log.join('\n'),
        next_step: success
          ? "MANDATORY: Call 'take_screenshot' to verify the final state matches the skill's intent."
          : `${failed} step(s) failed — the UI may have changed since this skill was learned. ` +
            'Verify with take_screenshot, fix manually, and save_skill to update the library.',
      }, null, 2);
    },
  });
}
