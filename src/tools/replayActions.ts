// src/tools/replayActions.ts
// 突破三的工具面：行动重放。日志中的动作序列 = 可执行的宏。
// confirm:true 显式确认（防误触发真实桌面操作）；步数上限由配置约束；
// click_element 依赖运行时元素缓存，重放时显式跳过并说明原因。
// B-4：返回值统一走 toolResult 工厂（反幻觉锚点全覆盖）。
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
      from_step: { type: 'number', description: '0-based start index in the journal. Default 0.' },
      to_step: { type: 'number', description: '0-based end index (inclusive). Default: latest.' },
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
          'Replay awaiting explicit confirmation.',
          'replay-needs-confirm',
          { current_state: 'Replay is a real-world side-effect operation.' },
          'Set confirm=true to execute the replay, or inspect the plan first via the dry-run report.',
        );
      }

      const all = journal.list();
      // J 纪元修正：to_step 补下界钳制 —— 旧实现只有上界 min(len-1)，
      // to_step=-5 时 slice(0, -4) 静默选中「除最后 4 条外的全部」并重放，
      // 与钳制 from 的初衷自相矛盾。
      const from = Math.max(0, args.from_step ?? 0);
      const to = Math.max(from, Math.min(all.length - 1, args.to_step ?? all.length - 1));
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
      let halted: { index: number; tool: string } | null = null;
      const gated = config.verifyActions && !config.dryRun;
      for (let i = 0; i < steps.length; i++) {
        const entry = steps[i];
        // Y-6 场景门控：动作步前取指纹（观察型步骤无副作用，免门控开销）
        const isActionStep = ['click_mouse', 'type_text', 'scroll_page', 'press_hotkey', 'drag_mouse'].includes(entry.tool);
        const before = gated && isActionStep
          ? await backend.captureProcessed({ metaOnly: true, wantHashes: true })
          : null;
        const line = await replayOne(entry);
        log.push(`#${entry.ts} ${entry.tool}: ${line}`);
        await sleep(150); // 步间微歇，给 UI 响应时间
        if (before?.dhash) {
          const after = await backend.captureProcessed({ metaOnly: true, wantHashes: true });
          if (isDeadStep(before.dhash, after.dhash ?? null)) {
            halted = { index: i, tool: entry.tool };
            log.push(`  [GATE] step ${i} produced NO screen change — replay halted (the UI has diverged from the recorded scene)`);
            break;
          }
        }
      }

      if (halted) {
        return JSON.stringify({
          status: 'PARTIAL_FAILURE',
          state_anchor: {
            replayed_steps: halted.index,
            total_steps: steps.length,
            diverged_at_step: halted.index,
            diverged_tool: halted.tool,
            gate: 'per-step scene hash (dHash dead-step detection)',
          },
          execution_log: log.join('\n'),
          next_step: 'REPLAY HALTED: a step produced zero screen change — the current UI no longer matches the scene ' +
            'where this macro was recorded. take_screenshot, re-record the affected steps (save_skill), and replay the rest.',
        }, null, 2);
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
      case 'click_mouse': {
        // 尺寸只取一次：两次独立异步读在分辨率切换间隙会用不同比例映射 x/y
        const s = await system.getScreenSize();
        await system.clickMouse(a.x * s.width, a.y * s.height, a.button ?? 'left');
        return 'clicked';
      }
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
      case 'switch_window':
        await system.switchWindowByTitle(String(a.titleKeyword ?? ''));
        return 'window switched';
      case 'click_element':
        return 'SKIPPED (element-ID tools depend on runtime cache; replay with click_mouse coordinates instead)';
      case 'dismiss_popup':
        // 纯模型侧恢复指令（无机械动作）—— 宏里是无害占位，不作为失败计
        return 'OK (model-side recovery instruction; nothing to execute)';
      default:
        return `SKIPPED (unsupported for replay: ${entry.tool})`;
    }
  } catch (e: any) {
    return `FAILED: ${e.message}`;
  }
}
