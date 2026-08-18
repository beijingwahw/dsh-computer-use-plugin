// src/journal.ts
// 突破三：行动日志（JSONL）+ 观察者挂载 + 重放支持。
// 每个工具调用的 args 与结果被忠实记录 —— 可审计、可回放、可转化为固定宏。
// 挂载点选在 post-execute 观察位：对管线零侵入，且能拿到最终状态字符串。
import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config';
import { onToolPost } from './guards/hooks';

/** 可重放的动作类工具（take_screenshot 等观察类工具不进日志） */
export const ACTION_TOOLS = [
  'click_mouse', 'type_text', 'scroll_page', 'press_hotkey',
  'drag_mouse', 'click_element', 'switch_tab', 'switch_window', 'dismiss_popup',
];

export interface JournalEntry {
  ts: number;
  tool: string;
  args: Record<string, any>;
  status: string;
  effect_detected?: boolean;
}

function parseStatus(result: unknown): { status: string; effect_detected?: boolean } {
  if (typeof result === 'string') {
    try {
      const obj = JSON.parse(result);
      if (obj?.status) return { status: obj.status, effect_detected: obj.effect?.detected };
    } catch { /* 非锚点格式，走前缀协议 */ }
    if (result.includes('[System]')) return { status: 'SUCCESS' };
    if (result.includes('[Error]')) return { status: 'FAILED' };
  }
  return { status: 'UNKNOWN' };
}

class ActionJournal {
  private entries: JournalEntry[] = [];
  private enabled = true;
  private filePath = '';
  private capacity = 1000;
  private taskStartIndex = 0; // 最近一次复杂任务的日志起点（技能归纳的切片边界）

  configure(enabled: boolean, filePath: string, capacity: number) {
    this.enabled = enabled;
    this.filePath = filePath;
    this.capacity = capacity;
  }

  reset() {
    this.entries = [];
  }

  async append(entry: JournalEntry): Promise<void> {
    if (!this.enabled || !ACTION_TOOLS.includes(entry.tool)) return;
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();

    if (this.filePath) {
      try {
        // 目录不存在则创建；追加失败不阻断主流程（日志是旁路义务）
        await mkdir(path.dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
      } catch (e: any) {
        console.warn(`[Journal] write failed: ${e.message}`);
      }
    }
  }

  list(actionOnly = true): JournalEntry[] {
    return actionOnly ? this.entries.filter(e => ACTION_TOOLS.includes(e.tool)) : [...this.entries];
  }

  /** 任务起点打标：start_complex_task 执行前调用 */
  markTaskStart(): void {
    this.taskStartIndex = this.entries.length;
  }

  /** 本次任务以来的动作（技能归纳的原料） */
  sinceTaskStart(): JournalEntry[] {
    return this.entries.slice(this.taskStartIndex).filter(e => ACTION_TOOLS.includes(e.tool));
  }
}

export const journal = new ActionJournal();

/** 以观察者身份挂进工具管线：记录一切动作类调用 */
export function registerJournalGuard(ctx: Context, config: Config): void {
  journal.configure(config.enableJournal, config.journalPath, 1000);
  onToolPost(ctx, async (call, result, next) => {
    const { status, effect_detected } = parseStatus(result);
    await journal.append({ ts: Date.now(), tool: call.name, args: call.args, status, effect_detected });
    return next(result); // 纯观察，原样透传
  });
}
