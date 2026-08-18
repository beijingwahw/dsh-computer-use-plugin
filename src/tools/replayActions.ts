// src/tools/replayActions.ts
// 突破三的工具面：行动重放。日志中的动作序列 = 可执行的宏。
// confirm:true 显式确认（防误触发真实桌面操作）；步数上限由配置约束；
// click_element 依赖运行时元素缓存，重放时显式跳过并说明原因。
// B-4：返回值统一走 toolResult 工厂（反幻觉锚点全覆盖）。
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from '../config';
import { system } from '../system';
import { journal } from '../journal';
import type { JournalEntry } from '../journal';
import { sleep } from '../actionVerifier';
import { toolOk, toolErr, toolActionRequired } from '../toolResult';

export function createReplayActionsTool(config: Config) {
  return defineTool({
    name: 'replay_actions',
    description:
      'Replays recorded actions from the journal (a macro). Use this to repeat a previously ' +
      'successful action sequence, e.g., re-opening the same workflow. Requires confirm=true.',
    parameters: {
      confirm: { type: 'boolean', required: true, description: 'Must be explicitly true to execute.' },
      from_step: { type: 'number', required: false, description: '0-based start index in the journal. Default 0.' },
      to_step: { type: 'number', required: false, description: '0-based end index (inclusive). Default: latest.' },
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
        return toolActionRequired(
          'replay-needs-confirm',
          { current_state: 'Replay is a real-world side-effect operation.' },
          'Set confirm=true to execute the replay, or inspect the plan first via the dry-run report.',
        );
      }

      const all = journal.list();
      const from = Math.max(0, args.from_step ?? 0);
      const to = Math.min(all.length - 1, args.to_step ?? all.length - 1);
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
      for (const entry of steps) {
        const line = await replayOne(entry);
        log.push(`#${entry.ts} ${entry.tool}: ${line}`);
        await sleep(150); // 步间微歇，给 UI 响应时间
      }

      return toolOk(
        `Replayed ${steps.length} action(s).`,
        { replayed_steps: steps.length, detail: log },
        "Call 'take_screenshot' to verify the final state matches the expected outcome.",
      );
    },
  });
}

/** 单条日志/技能步骤 → 系统层调用。依赖运行时缓存的工具（click_element）显式跳过。 */
export async function replayOne(entry: { tool: string; args?: Record<string, any> }): Promise<string> {
  const a = entry.args ?? {};
  try {
    switch (entry.tool) {
      case 'click_mouse':
        await system.clickMouse(a.x * (await system.getScreenSize()).width, a.y * (await system.getScreenSize()).height, a.button ?? 'left');
        return 'clicked';
      case 'type_text':
        await system.typeText(a.text ?? '', a.clearFirst ?? false);
        return 'typed';
      case 'scroll_page':
        await system.scroll(a.direction ?? 'down', a.amount ?? 5);
        return 'scrolled';
      case 'press_hotkey':
        await system.pressHotkey(a.keys ?? []);
        return 'hotkey pressed';
      case 'drag_mouse': {
        const s = await system.getScreenSize();
        await system.dragMouse(
          { x: a.startX * s.width, y: a.startY * s.height },
          { x: a.endX * s.width, y: a.endY * s.height },
        );
        return 'dragged';
      }
      case 'switch_tab':
        await system.pressHotkey(a.direction === 'previous' ? ['ctrl', 'shift', 'tab'] : ['ctrl', 'tab']);
        return 'tab switched';
      case 'click_element':
        return 'SKIPPED (element-ID tools depend on runtime cache; replay with click_mouse coordinates instead)';
      default:
        return `SKIPPED (unsupported for replay: ${entry.tool})`;
    }
  } catch (e: any) {
    return `FAILED: ${e.message}`;
  }
}
